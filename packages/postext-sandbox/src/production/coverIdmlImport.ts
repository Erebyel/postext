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
 */

import type { CoverPath, ProductionSheet, SheetRect } from 'postext';
import { isNoColour, itemGeometry, plainText, readIdml, resolveColour, type IdmlDocument, type IdmlPageItem, type Path } from 'postext-idml';
import { COVER_TEXT_ZONES, type CoverDesignSettings, type CoverTextZone, type DesignZone } from './bookProduction.js';
import { elementAt, FINISH_KINDS, newElementId, type CoverElementSetting, type CoverFinishSetting } from './coverLayers.js';
import { galleryResourceId, newGalleryId, type GalleryPicture } from './coverGallery.js';
import { sniffLogoMime } from './logoLibrary.js';
import type { CoverLayerNames } from './coverIdml.js';

const PT_TO_MM = 25.4 / 72;

export interface CoverIdmlReport {
  /** Items of the design InDesign moved, resized or recoloured. */
  updated: string[];
  /** Items added in InDesign, now in the design. */
  added: string[];
  /** Items of the design the IDML no longer has (left as they were). */
  missing: string[];
  /** The zones whose text changed. */
  texts: CoverTextZone[];
  /** Linked pictures whose file was not given. */
  links: string[];
  /** Items left out, and why. */
  skipped: { name: string; why: 'rotated' | 'group' | 'text' | 'empty' }[];
}

export interface CoverIdmlImport {
  design: CoverDesignSettings;
  texts: Partial<Record<CoverTextZone, string>>;
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

export function importCoverIdml(bytes: Uint8Array, options: {
  sheet: ProductionSheet;
  design: CoverDesignSettings | undefined;
  texts: Partial<Record<CoverTextZone, string>>;
  /** The designer's layers' names, as the export named InDesign's. */
  layerNames: CoverLayerNames;
  /** Linked files given with the IDML, by file name. */
  links?: ReadonlyMap<string, Uint8Array>;
}): CoverIdmlImport {
  const { sheet, layerNames } = options;
  const d = readIdml(bytes);
  const spread = d.spreads[0];
  const design: CoverDesignSettings = structuredClone(options.design ?? {});
  const texts = { ...options.texts };
  const report: CoverIdmlReport = { updated: [], added: [], missing: [], texts: [], links: [], skipped: [] };
  const pictures: GalleryPicture[] = [];
  if (!spread) return { design, texts, pictures, report };

  const layerName = (it: IdmlPageItem) => d.layers.find((l) => l.self === it.layer)?.name;
  const toSheet = (b: { left: number; top: number; right: number; bottom: number }): SheetRect => ({
    x: sheet.trim.x + b.left * PT_TO_MM,
    y: sheet.trim.y + b.top * PT_TO_MM,
    width: (b.right - b.left) * PT_TO_MM,
    height: (b.bottom - b.top) * PT_TO_MM,
  });
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

  for (const it of spread.items) {
    const name = it.name ?? '';
    const g = itemGeometry(d, it);
    if (!g) continue;
    // Text frames: the zones' texts.
    if (it.kind === 'TextFrame') {
      const zone = COVER_TEXT_ZONES.find((z) => z === name);
      const story = it.textFrame ? d.stories.get(it.textFrame.story) : undefined;
      if (!zone || !story) {
        report.skipped.push({ name: name || it.self, why: 'text' });
        continue;
      }
      const paragraphs = story.paragraphs.map((p) => plainText([p]).replace(/\s+/g, ' ').trim()).filter(Boolean);
      const old = texts[zone] ?? '';
      if (paragraphs.join('\n') !== plainOf(old).join('\n')) {
        texts[zone] = textFrom(paragraphs, old);
        report.texts.push(zone);
      }
      continue;
    }
    if (it.kind === 'Group') {
      report.skipped.push({ name: name || it.self, why: 'group' });
      continue;
    }
    if (Math.abs(g.rotation) > 0.5 || g.flipped) {
      report.skipped.push({ name: name || it.self, why: 'rotated' });
      continue;
    }
    const rect = toSheet(g.box);

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

    // An item added in InDesign.
    const layer = layerName(it);
    const target = layer === layerNames.finishes ? 'finishes' : layer === layerNames.effects ? 'effects' : layer === layerNames.logos ? 'logos' : 'elements';
    const label = name || it.self;
    if (it.graphic) {
      const link = it.graphic.link;
      const fileName = link ? decodeURIComponent((link.uri || link.name).split(/[\\/]/).pop() ?? '') : '';
      const bytes = fileName ? options.links?.get(fileName) ?? options.links?.get(link?.name ?? '') : undefined;
      const mime = bytes ? sniffLogoMime(bytes) : undefined;
      if (!bytes || !mime) {
        report.links.push(fileName || label);
        continue;
      }
      const gb = it.graphic.bounds;
      const picture: GalleryPicture = {
        id: newGalleryId('pic'),
        name: fileName.replace(/\.[^.]+$/, ''),
        mime,
        bytes,
        width: Math.max(1, Math.round(gb.right - gb.left)),
        height: Math.max(1, Math.round(gb.bottom - gb.top)),
        updatedAt: Date.now(),
      };
      pictures.push(picture);
      const el = elementAt(sheet, { id: newElementId(), kind: 'image', resourceId: galleryResourceId(picture.id), zone: 'front', x: 0, y: 0, width: 1, height: 1 }, rect);
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

  // What the design had and the IDML no longer does: kept, and said. A
  // finish shaped by an element is drawn with it, not on its own.
  const had: [string, readonly { id: string; name?: string }[] | undefined][] = [
    ['el', options.design?.elements],
    ['fx', options.design?.effects],
    ['logo', options.design?.logos],
    ['finish', options.design?.finishes?.filter((f) => !('element' in f.shape))],
  ];
  for (const [kind, list] of had) for (const x of list ?? []) if (!seen.has(`${kind}:${x.id}`)) report.missing.push(x.name ?? x.id);

  const out: CoverDesignSettings = { ...design };
  for (const key of ['elements', 'effects', 'logos', 'finishes'] as const) {
    if ((lists[key] as unknown[]).length > 0) (out as Record<string, unknown>)[key] = lists[key];
    else delete out[key];
  }
  return { design: out, texts, pictures, report };
}
