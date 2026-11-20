/**
 * A cover back from InDesign: the IDML the designer exported (./coverIdml.ts,
 * its items named after the design elements they draw), edited there and
 * read here into the cover's design again.
 *
 * - What the design already had, known by its name, takes its place, size,
 *   colour, border and opacity from InDesign.
 * - What was added in InDesign comes in by its layer: a shape on the
 *   finishes' layer, in a spot ink, is a finish named after that ink; on
 *   the effects' layer, an effect; anywhere else, a movable element. A
 *   picture frame brings its picture into the cover's gallery when its
 *   linked file is given (an IDML holds no pictures: they are linked).
 * - The texts come back when they changed, their Markdown marks kept when
 *   their paragraphs are the same in number.
 * - Whatever cannot be read back (a rotated item, a group, a new text
 *   frame, a picture whose file is missing) stays out and is reported.
 *
 * The page of the IDML is the sheet's trim, so its coordinates are the
 * sheet's less the bleed.
 *
 * An IDML not exported from here (no item named after an element) is read
 * by what its items are and where they stand: its pages, side by side,
 * are the cover's trim, fitted to the sheet's if they differ; a box over
 * the whole sheet is its background colour, a picture over it its
 * background picture, a box over a whole zone that zone's colour; a fill
 * in a spot ink that overprints is a finish; a picture named like a
 * barcode is left to the one the sheet draws; the text frames give each
 * zone its text, top to bottom; groups are read item by item.
 */

import type { CoverPath, ProductionSheet, SheetRect } from 'postext';
import { characterFormat, graphicCrop, isNoColour, itemGeometry, pageBoxInSpread, paragraphFormat, plainText, readIdml, resolveColour, runProps, transformBox, type IdmlDocument, type IdmlPageItem, type IdmlParagraph, type Path } from 'postext-idml';
import type { CoverDesignSettings, DesignZone, RoleStyle } from './bookProduction.js';
import { COVER_FIELDS, coverFields, expandFields, fieldsIn, textBoxesOf, textBoxFromElement, type CoverField, type CoverTextBox, type CoverTexts, type TextBoxRole } from './coverTexts.js';
import { elementAt, FINISH_KINDS, newElementId, type CoverElementSetting, type CoverFinishSetting } from './coverLayers.js';
import { galleryResourceId, newGalleryId, type GalleryPicture } from './coverGallery.js';
import { logoResourceId, sniffLogoMime, type LogoRecord } from './logoLibrary.js';
import type { CoverLayerNames } from './coverIdml.js';

const PT_TO_MM = 25.4 / 72;

export interface CoverIdmlReport {
  /** Items of the design InDesign moved, resized or recoloured. */
  updated: string[];
  /** Items added in InDesign, now in the design. */
  added: string[];
  /** Items of the design the IDML no longer has (left as they were). */
  missing: string[];
  /** The general texts that changed. */
  texts: CoverField[];
  /** The type families the texts are set in. */
  fonts?: string[];
  /** Linked pictures whose file was not given. */
  links: string[];
  /** Items left out, and why. */
  skipped: { name: string; why: 'rotated' | 'group' | 'text' | 'empty' | 'barcode' }[];
  /** An IDML not exported from here: its pages fitted to the sheet's trim,
   *  and their size and the trim's when they differ, mm. */
  generic?: { from?: [number, number]; to?: [number, number] };
}

export interface CoverIdmlImport {
  design: CoverDesignSettings;
  texts: CoverTexts;
  /** Pictures for the cover's gallery, from the linked files given. */
  pictures: GalleryPicture[];
  report: CoverIdmlReport;
}

/** The plain words of a zone's Markdown, to tell whether InDesign changed
 *  them: one line per paragraph, without its marks. */
function plainOf(markdown: string): string[] {
  return markdown
    .split(/\n\s*\n/)
    .map((p) => p.replace(/^#{1,6}\s+/, '').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** The new text of a zone in Markdown: each paragraph with the marks its
 *  old one had (a heading's #, emphasis round the whole paragraph) when
 *  the paragraphs are as many as before, else plain. */
function textFrom(paragraphs: string[], old: string): string {
  const before = old.split(/\n\s*\n/).filter((p) => p.trim());
  if (before.length !== paragraphs.length) return paragraphs.join('\n\n');
  return paragraphs
    .map((p, i) => {
      const was = before[i]!.trim();
      const heading = /^(#{1,6})\s+/.exec(was)?.[1];
      const wrap = /^([*_]{1,3})[^*_].*\1$/.exec(was.replace(/^#{1,6}\s+/, ''))?.[1];
      const body = wrap ? `${wrap}${p}${wrap}` : p;
      return heading ? `${heading} ${body}` : body;
    })
    .join('\n\n');
}

/** A finish's kind by its ink's name, as a printer names it. */
function finishKindOf(ink: string): CoverFinishSetting['kind'] {
  const n = ink.toLowerCase();
  if (/oro|gold|dorad/.test(n)) return 'foilGold';
  if (/plata|silver|platead/.test(n)) return 'foilSilver';
  if (/lamin|plastif/.test(n)) return 'lamination';
  if (/bajorrel|deboss|hund/.test(n)) return 'deboss';
  if (/relieve|emboss|golpe/.test(n)) return 'emboss';
  return FINISH_KINDS[0]!;
}

/** An item's outline as a path in fractions of `box` (page pt), its
 *  handles kept where they are not on their anchors. */
function pathIn(paths: readonly Path[], box: { left: number; top: number; right: number; bottom: number }): CoverPath {
  const w = box.right - box.left || 1;
  const h = box.bottom - box.top || 1;
  const f = (p: { x: number; y: number }) => ({ x: Math.round(((p.x - box.left) / w) * 10000) / 10000, y: Math.round(((p.y - box.top) / h) * 10000) / 10000 });
  const same = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
  return paths.map((p) => ({
    closed: !p.open,
    nodes: p.points.map((pt) => ({
      ...f(pt.anchor),
      ...(same(pt.left, pt.anchor) ? {} : { in: f(pt.left) }),
      ...(same(pt.right, pt.anchor) ? {} : { out: f(pt.right) }),
    })),
  }));
}

/** Whether an outline is its box: four corners on the box's edges, no
 *  curves. */
function isBox(path: CoverPath): boolean {
  if (path.length !== 1 || !path[0]!.closed || path[0]!.nodes.length !== 4) return false;
  return path[0]!.nodes.every((n) => !n.in && !n.out && (n.x < 0.001 || n.x > 0.999) && (n.y < 0.001 || n.y > 0.999));
}

const hexOf = (d: IdmlDocument, ref: string | undefined, tint?: string): { hex: string; spot?: string } | undefined => {
  if (!ref || isNoColour(d, ref)) return undefined;
  const c = resolveColour(d, ref, tint !== undefined && Number.isFinite(Number(tint)) && Number(tint) >= 0 ? Number(tint) : undefined);
  return c ? { hex: c.hex.slice(0, 7).toLowerCase(), ...(c.spot ? { spot: c.spot } : {}) } : undefined;
};

/** A paragraph's type as a text box's role style: its first run's face,
 *  size, leading, colour, tracking and capitals, and its alignment and the
 *  space after it. */
function roleStyleOf(d: IdmlDocument, para: IdmlParagraph): RoleStyle | undefined {
  const run = para.runs[0];
  if (!run) return undefined;
  const props = runProps(d, para, run);
  const c = characterFormat(props);
  const p = paragraphFormat(props);
  const style = (c.fontStyle ?? '').toLowerCase();
  const colour = c.fillColor ? hexOf(d, c.fillColor, c.fillTint !== undefined ? String(c.fillTint) : undefined) : undefined;
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return {
    ...(c.fontFamily ? { fontFamily: c.fontFamily } : {}),
    ...(c.pointSize > 0 ? { fontSize: r1(c.pointSize) } : {}),
    ...(!c.autoLeading && c.leading > 0 ? { lineHeight: r1(c.leading) } : {}),
    ...(/bold|black|heavy|semibold/.test(style) ? { bold: true } : {}),
    ...(/italic|oblique/.test(style) ? { italic: true } : {}),
    align: p.align,
    ...(colour ? { color: colour.hex } : {}),
    ...(c.tracking ? { tracking: Math.round(c.tracking) } : {}),
    ...(c.capitalization === 'AllCaps' ? { caps: 'upper' as const } : c.capitalization === 'SmallCaps' || c.capitalization === 'CapToSmallCap' ? { caps: 'small' as const } : {}),
    ...(p.spaceAfter > 0 ? { spaceAfter: r1(p.spaceAfter) } : {}),
  };
}

/** A paragraph's words for comparing: lower case, letters and figures. */
const wordsOf = (t: string) => t.toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** The Markdown mark of a role. */
const MARK: Record<TextBoxRole, string> = { h1: '# ', h2: '## ', h3: '### ', text: '' };

/** A text frame of another IDML read: its runs of paragraphs set alike,
 *  each with its words and its type. */
interface FrameText {
  box: CoverTextBox;
  zone: string | undefined;
  /** Its runs of paragraphs set alike: their words joined (to compare
   *  with a general text) and each paragraph's. */
  groups: { words: string; paras: string[]; style: RoleStyle | undefined; key: string }[];
}

export function importCoverIdml(bytes: Uint8Array, options: {
  sheet: ProductionSheet;
  design: CoverDesignSettings | undefined;
  texts: CoverTexts;
  /** The designer's layers' names, as the export named InDesign's. */
  layerNames: CoverLayerNames;
  /** Linked files given with the IDML, by file name. */
  links?: ReadonlyMap<string, Uint8Array>;
  /** The logo library: a picture whose file is named as one of its logos
   *  (its name, or the file name the export gives it) is that logo. */
  library?: readonly LogoRecord[];
}): CoverIdmlImport {
  const { sheet, layerNames } = options;
  const d = readIdml(bytes);
  const spread = d.spreads[0];
  const design: CoverDesignSettings = structuredClone(options.design ?? {});
  let texts: CoverTexts = coverFields(options.texts);
  // The boxes a cover of ours exported, by their ids (its frames' names).
  const ourBoxes = textBoxesOf(sheet, options.design, texts);
  let boxes: CoverTextBox[] | undefined;
  const frames: FrameText[] = [];
  const families = new Set<string>();
  const report: CoverIdmlReport = { updated: [], added: [], missing: [], texts: [], links: [], skipped: [] };
  const pictures: GalleryPicture[] = [];
  // A linked file (a page of it) placed several times comes in once.
  const pictureOf = new Map<string, GalleryPicture>();
  if (!spread) return { design, texts, pictures, report };

  const layerName = (it: IdmlPageItem) => d.layers.find((l) => l.self === it.layer)?.name;
  // Every item, a group's read one by one.
  const flat: IdmlPageItem[] = [];
  const walk = (items: readonly IdmlPageItem[]) => {
    for (const it of items) {
      if (it.kind === 'Group') walk(it.children);
      else flat.push(it);
    }
  };
  walk(spread.items);
  const ours = flat.some((it) => /^cover-/.test(it.name ?? ''));

  // Our IDML: its page is the trim. Another: its pages side by side are,
  // fitted to the trim.
  const pages = spread.pages.map(pageBoxInSpread);
  const union = pages.reduce((u, b) => ({ left: Math.min(u.left, b.left), top: Math.min(u.top, b.top), right: Math.max(u.right, b.right), bottom: Math.max(u.bottom, b.bottom) }), pages[0] ?? { left: 0, top: 0, right: 1, bottom: 1 });
  const fromMm: [number, number] = [(union.right - union.left) * PT_TO_MM, (union.bottom - union.top) * PT_TO_MM];
  const sx = ours ? 1 : sheet.trim.width / (fromMm[0] || 1);
  const sy = ours ? 1 : sheet.trim.height / (fromMm[1] || 1);
  if (!ours) {
    const r1 = (v: number) => Math.round(v * 10) / 10;
    report.generic = Math.abs(fromMm[0] - sheet.trim.width) > 1 || Math.abs(fromMm[1] - sheet.trim.height) > 1
      ? { from: [r1(fromMm[0]), r1(fromMm[1])], to: [r1(sheet.trim.width), r1(sheet.trim.height)] }
      : {};
  }
  // Another IDML with a page for each panel of the sheet (flaps, back,
  // spine, front): each page is fitted to its panel, so a spine or a
  // flap of another width keeps the rest in place.
  const PANELS = ['flapBack', 'back', 'spine', 'front', 'flapFront'];
  const panels = sheet.zones.filter((z) => PANELS.includes(z.name)).sort((a, b) => a.rect.x - b.rect.x);
  const byPage = !ours && pages.length > 1 && pages.length === panels.length ? pages.slice().sort((a, b) => a.left - b.left) : undefined;
  const mapX = (x: number): number => {
    if (!byPage) return sheet.trim.x + (x - union.left) * PT_TO_MM * sx;
    // The page the point is on (or the nearest), and its panel.
    let i = byPage.findIndex((pg) => x <= pg.right + 0.01);
    if (i < 0) i = byPage.length - 1;
    const pg = byPage[i]!;
    const z = panels[i]!.rect;
    return z.x + ((x - pg.left) / (pg.right - pg.left || 1)) * z.width;
  };
  if (byPage && report.generic) {
    const widths = byPage.map((pg) => Math.round((pg.right - pg.left) * PT_TO_MM * 10) / 10);
    if (widths.every((w, i) => Math.abs(w - panels[i]!.rect.width) <= 1)) report.generic = {};
  }
  const toSheet = (g: { box: { left: number; top: number; right: number; bottom: number }; spreadBox: { left: number; top: number; right: number; bottom: number } }): SheetRect => {
    if (ours) {
      const b = g.box;
      return { x: sheet.trim.x + b.left * PT_TO_MM, y: sheet.trim.y + b.top * PT_TO_MM, width: (b.right - b.left) * PT_TO_MM, height: (b.bottom - b.top) * PT_TO_MM };
    }
    const b = g.spreadBox;
    const x0 = mapX(b.left);
    return {
      x: x0,
      y: sheet.trim.y + (b.top - union.top) * PT_TO_MM * sy,
      width: mapX(b.right) - x0,
      height: (b.bottom - b.top) * PT_TO_MM * sy,
    };
  };
  const sheetArea = sheet.width * sheet.height;
  const zoneUnder = (r: SheetRect) => {
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    return sheet.zones.find((z) => cx >= z.rect.x && cx <= z.rect.x + z.rect.width && cy >= z.rect.y && cy <= z.rect.y + z.rect.height);
  };
  const stories = new Set<string>();
  const lists = {
    elements: design.elements ?? [],
    effects: design.effects ?? [],
    logos: design.logos ?? [],
    finishes: design.finishes ?? [],
  };
  const seen = new Set<string>();

  /** Colour, border and opacity of a box or shape from its item. */
  const paint = (el: CoverElementSetting, it: IdmlPageItem): CoverElementSetting => {
    const next = { ...el };
    if (el.kind !== 'image') {
      const fill = hexOf(d, it.attrs.FillColor, it.attrs.FillTint);
      if (fill) next.color = fill.hex;
      const stroke = hexOf(d, it.attrs.StrokeColor, it.attrs.StrokeTint);
      const weight = Number(it.attrs.StrokeWeight ?? 0);
      if (stroke && weight > 0) next.stroke = { color: stroke.hex, width: Math.round(weight * PT_TO_MM * 100) / 100 };
      else delete next.stroke;
    }
    const opacity = Math.max(0, Math.min(100, it.opacity)) / 100;
    if (el.kind !== 'image' && opacity < 1) next.opacity = opacity;
    else delete next.opacity;
    return next;
  };

  for (const it of flat) {
    const name = it.name ?? '';
    const g = itemGeometry(d, it);
    // On the pasteboard, off every page: not part of the cover.
    if (!g || (!ours && g.pasteboard)) continue;
    // Text frames of another IDML: each a text box where it stands, its
    // fill a box under it.
    if (it.kind === 'TextFrame' && !ours) {
      const rect = toSheet(g);
      const fill = hexOf(d, it.attrs.FillColor, it.attrs.FillTint);
      if (fill && (rect.width * rect.height) / sheetArea >= 0.9) {
        design.background = fill.hex;
        report.added.push(name || it.self);
      } else if (fill) {
        const placed = elementAt(sheet, { id: newElementId(), kind: 'box', color: fill.hex, zone: 'front', x: 0, y: 0, width: 1, height: 1 }, rect);
        lists.elements.push(placed);
        report.added.push(name || it.self);
      }
      const story = it.textFrame ? d.stories.get(it.textFrame.story) : undefined;
      // A story threaded through several frames is read from its first.
      if (!story || stories.has(it.textFrame!.story)) continue;
      stories.add(it.textFrame!.story);
      const turn = Math.round(g.rotation);
      if (turn !== 0 && Math.abs(turn) !== 90) {
        report.skipped.push({ name: name || it.self, why: 'rotated' });
        continue;
      }
      // Runs of paragraphs set alike, as one block each.
      const groups: FrameText['groups'] = [];
      for (const p of story.paragraphs) {
        const words = plainText([p]).replace(/\s+/g, ' ').trim();
        if (!words) continue;
        const style = roleStyleOf(d, p);
        if (style?.fontFamily) families.add(style.fontFamily);
        const key = JSON.stringify([style?.fontFamily, style?.fontSize, style?.bold, style?.italic, style?.caps]);
        const last = groups[groups.length - 1];
        if (last && last.key === key) {
          last.words = `${last.words} ${words}`;
          last.paras.push(words);
        } else groups.push({ words, paras: [words], style, key });
      }
      if (groups.length === 0) continue;
      const placed = elementAt(sheet, { id: newElementId(), kind: 'box', zone: 'front', x: 0, y: 0, width: 1, height: 1 }, rect);
      frames.push({
        zone: zoneUnder(rect)?.name,
        groups,
        box: {
          id: placed.id.replace(/^el-/, 'text-'),
          text: '',
          zone: placed.zone,
          x: placed.x,
          y: placed.y,
          width: placed.width,
          height: placed.height,
          ...(placed.basis ? { basis: placed.basis } : {}),
          ...(placed.to ? { to: placed.to } : {}),
          ...(turn === -90 || turn === 270 ? { rotate: -90 as const } : turn === 90 || turn === -270 ? { rotate: 90 as const } : {}),
        },
      });
      continue;
    }
    // A text box of ours, by its id: where it now stands, and its words
    // when InDesign changed them.
    if (it.kind === 'TextFrame') {
      const box = ourBoxes.find((b) => b.id === name);
      const story = it.textFrame ? d.stories.get(it.textFrame.story) : undefined;
      if (!box || !story) {
        report.skipped.push({ name: name || it.self, why: 'text' });
        continue;
      }
      boxes ??= ourBoxes.slice();
      const rect = toSheet(g);
      const placed = elementAt(sheet, { id: box.id, kind: 'box', zone: box.zone, x: box.x, y: box.y, width: box.width, height: box.height }, rect);
      const moved = Math.abs(placed.x - box.x) > 0.2 || Math.abs(placed.y - box.y) > 0.2 || Math.abs(placed.width - box.width) > 0.2 || Math.abs(placed.height - box.height) > 0.2;
      let next: CoverTextBox = moved ? textBoxFromElement(box, placed) : box;
      if (moved) report.updated.push(name);
      const paragraphs = story.paragraphs.map((p) => plainText([p]).replace(/\s+/g, ' ').trim()).filter(Boolean);
      const shown = expandFields(box.text, texts);
      if (paragraphs.join('\n') !== plainOf(shown).join('\n')) {
        // Its general texts take the new words when it shows one each, a
        // paragraph each; else the box keeps the new words as its own.
        // The blocks it shows: those whose fields say nothing are not there.
        const blocks = box.text.split(/\n\s*\n/).map((b) => b.trim()).filter((b) => b && expandFields(b, texts));
        const one = blocks.map((b) => /^(?:#{1,6}\s+)?\{\{\s*([a-zA-Z]+)\s*\}\}$/.exec(b)?.[1] as CoverField | undefined);
        if (one.length === paragraphs.length && one.every(Boolean)) {
          for (const [i, f] of one.entries()) {
            if ((texts[f!] ?? '').replace(/\s+/g, ' ').trim() === paragraphs[i]) continue;
            texts = { ...texts, [f!]: textFrom([paragraphs[i]!], texts[f!] ?? '') };
            if (!report.texts.includes(f!)) report.texts.push(f!);
          }
        } else if (one.length === 1 && one[0]) {
          const f = one[0];
          texts = { ...texts, [f]: textFrom(paragraphs, texts[f] ?? '') };
          if (!report.texts.includes(f)) report.texts.push(f);
        } else {
          next = { ...next, text: textFrom(paragraphs, shown) };
          if (!report.updated.includes(name)) report.updated.push(name);
        }
      }
      boxes = boxes.map((b) => (b.id === box.id ? next : b));
      continue;
    }
    if (Math.abs(g.rotation) > 0.5 || g.flipped) {
      report.skipped.push({ name: name || it.self, why: 'rotated' });
      continue;
    }
    const rect = toSheet(g);

    // The ground and the zones' colours.
    if (name === 'cover-ground') {
      const fill = hexOf(d, it.attrs.FillColor, it.attrs.FillTint);
      if (fill && fill.hex !== design.background) {
        design.background = fill.hex;
        report.updated.push(name);
      }
      continue;
    }
    const zoneOf = /^cover-zone-(.+)$/.exec(name)?.[1];
    if (zoneOf) {
      const z = (zoneOf === 'flapFront' || zoneOf === 'flapBack' ? 'flaps' : zoneOf) as DesignZone;
      const fill = hexOf(d, it.attrs.FillColor, it.attrs.FillTint);
      if (fill && fill.hex !== design.zones?.[z]) {
        design.zones = { ...design.zones, [z]: fill.hex };
        report.updated.push(name);
      }
      continue;
    }
    // Generated: drawn again from the design.
    if (name === 'cover-image' || name === 'cover-mirror' || name === 'isbn-barcode' || name.startsWith('cover-clip-') || name.startsWith('cover-art-')) continue;

    // An item the design has.
    const known = /^cover-(el|fx|logo|finish)-(.+)$/.exec(name);
    if (known) {
      const [, kind, id] = known;
      seen.add(`${kind}:${id}`);
      if (kind === 'finish') {
        const f = lists.finishes.find((x) => x.id === id);
        if (!f || 'element' in f.shape) continue;
        const placed = elementAt(sheet, { id: f.id, kind: 'box', ...f.shape.box }, rect);
        const box = { zone: placed.zone, x: placed.x, y: placed.y, width: placed.width, height: placed.height, ...(placed.basis ? { basis: placed.basis } : {}) };
        lists.finishes = lists.finishes.map((x) => (x.id === id ? { ...x, shape: 'outline' in f.shape ? { outline: f.shape.outline, box } : { box } } : x));
        report.updated.push(name);
        continue;
      }
      const key = kind === 'el' ? 'elements' : kind === 'fx' ? 'effects' : 'logos';
      const list = lists[key] as CoverElementSetting[];
      const el = list.find((x) => x.id === id);
      if (!el) continue;
      // A picture is drawn fitted in its box: the frame is its box.
      const next = paint(elementAt(sheet, el, rect), it);
      (lists[key] as CoverElementSetting[]) = list.map((x) => (x.id === id ? { ...x, ...next } : x));
      report.updated.push(name);
      continue;
    }

    // In another IDML: what an item is by what it covers.
    if (!ours) {
      const link = it.graphic?.link;
      const looks = `${name} ${link?.name ?? ''} ${link?.uri ?? ''}`;
      if (it.graphic && /isbn|ean[-_ ]?13|barcode|c[oó]digo/i.test(looks)) {
        report.skipped.push({ name: link?.name || name || it.self, why: 'barcode' });
        continue;
      }
      const path = pathIn(g.outline, g.box);
      const fill = hexOf(d, it.attrs.FillColor, it.attrs.FillTint);
      const covers = (rect.width * rect.height) / sheetArea;
      if (!it.graphic && fill && !fill.spot && isBox(path) && covers >= 0.9) {
        design.background = fill.hex;
        report.added.push(name || it.self);
        continue;
      }
      const zone = zoneUnder(rect);
      if (!it.graphic && fill && !fill.spot && isBox(path) && zone && zone.name !== 'pastedown' && zone.name !== 'flyleaf' && zone.name !== 'hinge') {
        const zr = zone.rect;
        const share = (Math.max(0, Math.min(rect.x + rect.width, zr.x + zr.width) - Math.max(rect.x, zr.x)) * Math.max(0, Math.min(rect.y + rect.height, zr.y + zr.height) - Math.max(rect.y, zr.y))) / (zr.width * zr.height);
        if (share >= 0.95 && rect.width * rect.height <= zr.width * zr.height * 1.5) {
          const key = (zone.name === 'flapFront' || zone.name === 'flapBack' ? 'flaps' : zone.name) as DesignZone;
          design.zones = { ...design.zones, [key]: fill.hex };
          report.added.push(name || it.self);
          continue;
        }
      }
    }

    // An item added in InDesign (or of another IDML).
    const layer = layerName(it);
    const fillInk = hexOf(d, it.attrs.FillColor, it.attrs.FillTint);
    // A spot ink that overprints is a finish wherever it stands.
    const overprintSpot = !!fillInk?.spot && it.attrs.OverprintFill === 'true';
    const target = layer === layerNames.finishes || overprintSpot ? 'finishes' : layer === layerNames.effects ? 'effects' : layer === layerNames.logos ? 'logos' : 'elements';
    const label = name || it.self;
    if (it.graphic) {
      const link = it.graphic.link;
      const fileName = link ? decodeURIComponent((link.uri || link.name).split(/[\\/]/).pop() ?? '') : '';
      // A logo of the library, by its name or its exported file's.
      const base = fileName.replace(/\.[^.]+$/, '').toLowerCase();
      const logo = base ? options.library?.find((l) => l.name.toLowerCase() === base || `logo-${l.id}`.toLowerCase() === base) : undefined;
      if (logo) {
        const placed = elementAt(sheet, { id: newElementId(), kind: 'image', resourceId: logoResourceId(logo.id), zone: 'front', x: 0, y: 0, width: 1, height: 1 }, rect);
        lists.logos = [...lists.logos, { ...placed, kind: 'image', logoId: logo.id, clearance: logo.clearance }];
        report.added.push(logo.name);
        continue;
      }
      // A PDF's (an Illustrator file's) page: given as `name#page`.
      const page = it.graphic.pageNumber && it.graphic.pageNumber > 1 ? it.graphic.pageNumber : undefined;
      const linked = (key: string) => (page ? options.links?.get(`${key}#${page}`) : undefined) ?? options.links?.get(key);
      const bytes = (fileName ? linked(fileName) ?? linked(link?.name ?? '') : undefined) ?? it.graphic.data;
      const mime = bytes ? sniffLogoMime(bytes) : undefined;
      if (!bytes || !mime) {
        report.links.push(fileName || label);
        continue;
      }
      const gb = it.graphic.bounds;
      const stem = fileName.replace(/\.[^.]+$/, '');
      const pictureKey = `${fileName || label}#${page ?? 1}`;
      const picture: GalleryPicture = pictureOf.get(pictureKey) ?? {
        id: newGalleryId('pic'),
        name: page ? `${stem} · ${page}` : stem,
        mime,
        bytes,
        width: Math.max(1, Math.round(gb.right - gb.left)),
        height: Math.max(1, Math.round(gb.bottom - gb.top)),
        updatedAt: Date.now(),
      };
      if (!pictureOf.has(pictureKey)) {
        pictureOf.set(pictureKey, picture);
        pictures.push(picture);
      }
      if (!ours && (rect.width * rect.height) / sheetArea >= 0.9) {
        design.image = { resourceId: galleryResourceId(picture.id), area: 'sheet' };
        report.added.push(picture.name);
        continue;
      }
      // A picture inside its frame stands where it is; one the frame crops
      // (a page with its bleed) fills the frame.
      const crop = !ours ? graphicCrop(it) : undefined;
      const cropped = !!crop && (crop.width < 0.98 || crop.height < 0.98);
      const at = crop && !cropped ? toSheet({ box: g.box, spreadBox: transformBox(crop.picture, g.toSpread) }) : rect;
      const placedPic = elementAt(sheet, { id: newElementId(), kind: 'image', resourceId: galleryResourceId(picture.id), zone: 'front', x: 0, y: 0, width: 1, height: 1 }, at);
      const el: CoverElementSetting = cropped ? { ...placedPic, fit: 'cover' } : placedPic;
      if (target === 'logos') lists.logos = [...lists.logos, { ...el, kind: 'image', clearance: 0 }];
      else (lists[target === 'finishes' ? 'elements' : target] as CoverElementSetting[]).push(el);
      report.added.push(picture.name);
      continue;
    }
    const fill = hexOf(d, it.attrs.FillColor, it.attrs.FillTint);
    const stroke = hexOf(d, it.attrs.StrokeColor, it.attrs.StrokeTint);
    if (!fill && !stroke) {
      report.skipped.push({ name: label, why: 'empty' });
      continue;
    }
    const path = pathIn(g.outline, g.box);
    if (target === 'finishes' && fill) {
      const ink = fill.spot ?? label;
      const placed = elementAt(sheet, { id: newElementId(), kind: 'box', zone: 'front', x: 0, y: 0, width: 1, height: 1 }, rect);
      const box = { zone: placed.zone, x: placed.x, y: placed.y, width: placed.width, height: placed.height, ...(placed.basis ? { basis: placed.basis } : {}) };
      const outline = isBox(path) ? undefined : path.filter((p) => p.closed).map((p) => p.nodes.map((n) => ({ x: n.x, y: n.y })));
      lists.finishes = [...lists.finishes, { id: placed.id, ...(it.name ? { name: it.name } : {}), kind: finishKindOf(ink), ink, shape: outline?.length ? { outline, box } : { box } }];
      report.added.push(label);
      continue;
    }
    const base: CoverElementSetting = isBox(path)
      ? { id: newElementId(), kind: 'box', color: fill?.hex ?? '#ffffff', zone: 'front', x: 0, y: 0, width: 1, height: 1 }
      : { id: newElementId(), kind: 'shape', path, ...(fill ? { color: fill.hex } : {}), zone: 'front', x: 0, y: 0, width: 1, height: 1 };
    const el = paint(elementAt(sheet, { ...base, ...(it.name ? { name: it.name } : {}) }, rect), it);
    (lists[target === 'logos' ? 'elements' : target] as CoverElementSetting[]).push(el);
    report.added.push(label);
  }

  // Another IDML's texts: its frames' words fill the general texts they
  // match, and each frame is a box that shows them.
  if (frames.length > 0) {
    const read = genericTexts(frames, texts);
    for (const f of COVER_FIELDS) {
      if (read.texts[f] !== undefined && read.texts[f] !== texts[f]) report.texts.push(f);
    }
    texts = read.texts;
    boxes = read.boxes;
  }
  if (families.size > 0) report.fonts = [...families];

  // What the design had and the IDML no longer does: kept, and said. A
  // finish shaped by an element is drawn with it, not on its own.
  const had: [string, readonly { id: string; name?: string }[] | undefined][] = [
    ['el', options.design?.elements],
    ['fx', options.design?.effects],
    ['logo', options.design?.logos],
    ['finish', options.design?.finishes?.filter((f) => !('element' in f.shape))],
  ];
  if (ours) for (const [kind, list] of had) for (const x of list ?? []) if (!seen.has(`${kind}:${x.id}`)) report.missing.push(x.name ?? x.id);

  const out: CoverDesignSettings = { ...design };
  if (boxes) out.texts = boxes;
  for (const key of ['elements', 'effects', 'logos', 'finishes'] as const) {
    if ((lists[key] as unknown[]).length > 0) (out as Record<string, unknown>)[key] = lists[key];
    else delete out[key];
  }
  return { design: out, texts, pictures, report };
}


/** The general texts and boxes of another IDML's text frames. Each
 *  frame's runs of paragraphs set alike are its blocks, each in a role of
 *  its own (running text, when the most written is long or the smallest;
 *  the others, title, subtitle and heading by size). A block that says what a general text says shows
 *  it. On the front cover, taking all its frames together, those left are
 *  its title (the largest), its subtitle (the next) and its author (the
 *  smallest short one); on the back cover, the spine and the flaps, the
 *  frame with most left over is that zone's text. */
function genericTexts(frames: readonly FrameText[], before: CoverTexts): { texts: CoverTexts; boxes: CoverTextBox[] } {
  const texts: CoverTexts = { ...before };
  type Group = FrameText['groups'][number];
  const size = (g: Group) => g.style?.fontSize ?? 0;
  const roles = frames.map((fr) => {
    const chars = new Map<string, number>();
    for (const g of fr.groups) chars.set(g.key, (chars.get(g.key) ?? 0) + g.words.length);
    const keys = [...chars.keys()];
    const role = new Map<string, TextBoxRole>();
    if (keys.length === 1) role.set(keys[0]!, 'text');
    else {
      // Running text, when there is some: the most written, if it is long
      // or the smallest; the rest are titles by size.
      const sizeOf = (k: string) => size(fr.groups.find((g) => g.key === k)!);
      const most = keys.reduce((a, b) => ((chars.get(b) ?? 0) > (chars.get(a) ?? 0) ? b : a));
      const body = (chars.get(most) ?? 0) > 120 || keys.every((k) => sizeOf(k) >= sizeOf(most)) ? most : undefined;
      if (body) role.set(body, 'text');
      keys.filter((k) => k !== body).sort((a, b) => sizeOf(b) - sizeOf(a)).forEach((k, i) => role.set(k, (['h1', 'h2', 'h3'] as const)[i] ?? 'text'));
    }
    return role;
  });
  const MATCHED: readonly CoverField[] = ['title', 'subtitle', 'author', 'spine', 'flapFront', 'flapBack', 'back'];
  const match = (words: string): CoverField | undefined => MATCHED.find((f) => texts[f] && wordsOf(texts[f]!) === wordsOf(words));
  // What the book already says.
  const slots: (CoverField | undefined)[][] = frames.map((fr) => fr.groups.map((g) => match(g.words)));
  // The front cover's title, subtitle and author, over all its frames.
  const front = frames.flatMap((fr, i) => (fr.zone === 'front' ? fr.groups.map((g, j) => ({ g, i, j })) : [])).filter(({ i, j }) => !slots[i]![j]);
  const taken = new Set(slots.flat().filter(Boolean));
  const take = (f: CoverField, pick: { g: Group; i: number; j: number } | undefined) => {
    if (!pick || taken.has(f)) return;
    slots[pick.i]![pick.j] = f;
    texts[f] = pick.g.words;
    taken.add(f);
  };
  const left = () => front.filter(({ i, j }) => !slots[i]![j]);
  take('title', left().sort((a, b) => size(b.g) - size(a.g))[0]);
  take('subtitle', left().sort((a, b) => size(b.g) - size(a.g)).find(({ g }) => size(g) > 0 && left().some((o) => size(o.g) < size(g))));
  take('author', left().filter(({ g }) => g.words.length <= 60).sort((a, b) => size(a.g) - size(b.g))[0]);
  // The other zones repeat them: matched again with the words just read.
  for (const [i, fr] of frames.entries()) for (const [j, g] of fr.groups.entries()) slots[i]![j] ??= match(g.words);
  // Each zone's own text: the frame with most left over.
  const zoneFieldOf = (zone: string | undefined): CoverField | undefined =>
    zone === 'back' ? 'back' : zone === 'spine' ? 'spine' : zone === 'flapFront' ? 'flapFront' : zone === 'flapBack' ? 'flapBack' : undefined;
  const leftover = (i: number) => frames[i]!.groups.reduce((n, g, j) => n + (slots[i]![j] ? 0 : g.words.length), 0);
  const owner = new Map<CoverField, number>();
  for (const [i, fr] of frames.entries()) {
    const f = zoneFieldOf(fr.zone);
    if (!f || leftover(i) === 0) continue;
    const had = owner.get(f);
    if (had === undefined || leftover(i) > leftover(had)) owner.set(f, i);
  }
  const boxes: CoverTextBox[] = frames.map((fr, i) => {
    const role = roles[i]!;
    const own = [...owner].find(([, at]) => at === i)?.[0];
    const blocks: string[] = [];
    const words: string[] = [];
    for (const [j, g] of fr.groups.entries()) {
      const mark = MARK[role.get(g.key) ?? 'text'];
      const f = slots[i]![j];
      if (f) blocks.push(`${mark}{{${f}}}`);
      else if (own) {
        // The zone's own text, its blocks marked by their roles.
        if (words.length === 0) blocks.push(`{{${own}}}`);
        for (const p of g.paras) words.push(`${mark}${p}`);
      } else blocks.push(...g.paras.map((p) => `${mark}${p}`));
    }
    if (own) texts[own] = own === 'spine' ? words.map((w) => w.replace(/^#+\s+/, '')).join(' · ') : words.join('\n\n');
    const styles: CoverTextBox['styles'] = {};
    for (const g of fr.groups) {
      const r = role.get(g.key) ?? 'text';
      if (!styles[r] && g.style) styles[r] = g.style;
    }
    return { ...fr.box, text: blocks.join('\n\n'), ...(Object.keys(styles).length ? { styles } : {}) };
  });
  // A front cover's old text gives way to the fields read.
  if (taken.has('title')) delete texts.front;
  return { texts, boxes: boxes.filter((b) => b.text.trim() || fieldsIn(b.text).length > 0) };
}
