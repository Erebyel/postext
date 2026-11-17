/**
 * A production sheet as a page Postext composes: the page is the sheet's
 * trim with its bleed and its fold marks, and a page template has a frame
 * for each zone (inside its safe area) that the cover's Markdown fills by
 * slot, the spine's turned to read along it, and the ISBN barcode drawn
 * in the back cover's corner by the spine.
 */

import { DEFAULT_SPINE_TEXT } from '../defaults/output/production.js';
import type { PageTemplate } from '../composed/types/templates.js';
import type { FrameConfig } from '../composed/types/frames.js';
import type { DesignBoxElement, DesignElement, DesignImageElement } from '../types/designElements.js';
import type { ColorValue, Dimension, PageConfig } from '../types/page.js';
import type { CmykPercent } from '../types/output/print.js';
import { contourPolygon } from '../contour/index.js';
import type { Resource } from '../types/resources/resources.js';
import type { ProductionVersion } from '../types/output/production.js';
import { isbnBarcodeSvg } from './barcodeSvg.js';
import type { CoverZoneName, ProductionSheet, SheetLine, SheetRect, SheetZone } from './geometry.js';

const mm = (value: number): Dimension => ({ value: Math.round(value * 1000) / 1000, unit: 'mm' });

/** The zones a cover's Markdown fills; joints and the endpaper's hinge
 *  take nothing. */
const SLOT_ZONES: ReadonlySet<CoverZoneName> = new Set(['flapBack', 'back', 'spine', 'front', 'flapFront', 'pastedown', 'flyleaf']);

export const BARCODE_RESOURCE_ID = 'isbn-barcode';
/** The file id of the barcode's PDF companion (`barcodePdf`). */
export const BARCODE_PDF_FILE_ID = `${BARCODE_RESOURCE_ID}.pdf`;

/** The look of a sheet, shared by every version: a ground for the whole
 *  sheet, a picture over it and a ground for each zone. Grounds and pictures that reach an edge of the sheet run into
 *  its bleed (a case's turn-in). */
export interface CoverDesign {
  background?: ColorValue;
  /** A bitmap or SVG resource of the book, filling the whole sheet or
   *  only the front cover, cropped to cover it about `focus`. */
  image?: { resourceId: string; area?: 'sheet' | 'front'; focus?: { x: number; y: number } };
  /** A ground per zone, over the sheet's and its picture. Endpapers take
   *  their `pastedown` and `flyleaf`. */
  zones?: Partial<Record<CoverZoneName, ColorValue>>;
  /** The movable elements, back to front, over the grounds and under the
   *  text. */
  elements?: CoverElement[];
  /** Effects: elements over the text, back to front — a translucent box
   *  (`opacity`), a picture with transparency of its own. */
  effects?: CoverElement[];
  /** Logos (the publisher's, the collection's, a seal), over the effects,
   *  each with the clear space it keeps round it. */
  logos?: CoverLogo[];
  /** Finishes: each a spot-colour plate that overprints everything, the
   *  shape of a box of its own or of one of the design's elements. */
  finishes?: CoverFinish[];
}

/** A logo of the cover: a picture placed as an element, and the clear
 *  space (mm) nothing else should enter round it. */
export interface CoverLogo extends CoverElement {
  kind: 'image';
  clearance: number;
}

/** The finishes a cover's plates stand for. */
export type CoverFinishKind = 'varnish' | 'lamination' | 'foilGold' | 'foilSilver' | 'emboss' | 'deboss';

/** A finish of the cover: what it is, the ink its plate is named after (as
 *  the printer knows it), and what it covers — a box of its own, placed
 *  like an element, or the shape of an element, effect or logo of the
 *  design (a picture's contour when its resource has one). */
export interface CoverFinish {
  id: string;
  kind: CoverFinishKind;
  ink: string;
  shape: { box: Pick<CoverElement, 'zone' | 'x' | 'y' | 'width' | 'height'> } | { element: string };
}

/** Each finish's default plate name, the CMYK a composite viewer shows its
 *  ink as, and its colour on screen (where it is drawn translucent). */
export const COVER_FINISH_INKS: Readonly<Record<CoverFinishKind, { ink: string; cmyk: CmykPercent; screen: string }>> = {
  varnish: { ink: 'Varnish', cmyk: { c: 0, m: 0, y: 0, k: 15 }, screen: '#7fb2e5' },
  lamination: { ink: 'Lamination', cmyk: { c: 0, m: 0, y: 0, k: 10 }, screen: '#9ad1c7' },
  foilGold: { ink: 'Gold foil', cmyk: { c: 0, m: 20, y: 60, k: 20 }, screen: '#c9a227' },
  foilSilver: { ink: 'Silver foil', cmyk: { c: 0, m: 0, y: 0, k: 30 }, screen: '#b5b8bd' },
  emboss: { ink: 'Emboss', cmyk: { c: 0, m: 0, y: 0, k: 20 }, screen: '#e07a5f' },
  deboss: { ink: 'Deboss', cmyk: { c: 0, m: 0, y: 0, k: 25 }, screen: '#8d6cab' },
};

/** A movable element of a cover's design: one of the book's pictures, or
 *  a box of colour. Placed by the zone it stands in, so it moves with that
 *  zone when the spine grows or the binding changes. */
export interface CoverElement {
  id: string;
  kind: 'image' | 'box';
  /** An image's picture: a bitmap or SVG resource of the book. */
  resourceId?: string;
  /** A box's colour. */
  color?: ColorValue;
  zone: CoverZoneName;
  /** Its box, mm from the zone's top-left corner; it may run out of the
   *  zone, onto the sheet's other zones or into the bleed. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** A box's opacity, 0 … 1 (default 1). A picture keeps its own
   *  transparency. */
  opacity?: number;
}

/** The zone an element is placed by on a sheet that lacks its own: a flap
 *  or a joint stands next to its board. */
const ZONE_STAND_IN: Partial<Record<CoverZoneName, CoverZoneName>> = {
  flapFront: 'front',
  flapBack: 'back',
  jointFront: 'front',
  jointBack: 'back',
};

/** Where an element stands on the sheet (mm from the sheet's corner, bleed
 *  included), or undefined when the sheet has neither its zone nor the one
 *  that stands in for it. */
export function coverElementRect(sheet: ProductionSheet, el: CoverElement): SheetRect | undefined {
  const zone = sheet.zones.find((z) => z.name === el.zone)
    ?? sheet.zones.find((z) => z.name === ZONE_STAND_IN[el.zone]);
  if (!zone) return undefined;
  return { x: zone.rect.x + el.x, y: zone.rect.y + el.y, width: el.width, height: el.height };
}

/** The element at `rect` (sheet mm) placed by the zone its centre falls in
 *  (the nearest zone when it is off them all). */
export function placeCoverElement(sheet: ProductionSheet, el: CoverElement, rect: SheetRect): CoverElement {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const distance = (r: SheetRect) => Math.hypot(Math.max(r.x - cx, 0, cx - r.x - r.width), Math.max(r.y - cy, 0, cy - r.y - r.height));
  const zone = sheet.zones.reduce((best, z) => (distance(z.rect) < distance(best.rect) ? z : best), sheet.zones[0]!);
  const round = (v: number) => Math.round(v * 100) / 100;
  return { ...el, zone: zone.name, x: round(rect.x - zone.rect.x), y: round(rect.y - zone.rect.y), width: round(rect.width), height: round(rect.height) };
}

export interface CoverPageOptions {
  /** Id of the page template. Default `'cover'`. */
  templateId?: string;
  /** How the spine is lettered (see `DEFAULT_SPINE_TEXT`). */
  spineText?: ProductionVersion['spineText'];
  /** The ISBN as written: its barcode goes in the back cover. */
  isbn?: string;
  isbnAddOn?: string;
  /** Barcode size against nominal (0.8 … 2). Default 1. */
  barcodeMagnification?: number;
  design?: CoverDesign;
  /** Where each zone's text sits in it, top to bottom. Default `'top'`;
   *  the spine's text is always centred across it. */
  verticalAlign?: Partial<Record<CoverZoneName, 'top' | 'middle' | 'bottom'>>;
  /** The barcode names a PDF companion ({@link BARCODE_PDF_FILE_ID}),
   *  whose bytes the host gives: for an output that places a PDF better
   *  than an SVG (IDML). */
  barcodePdf?: boolean;
  /** How finishes are drawn: `'screen'` (the default) in their colour on
   *  screen, translucent, to see what they cover; `'press'` as solid
   *  spot-colour plates that overprint, for the PDF and InDesign. */
  finishes?: 'screen' | 'press';
  /** The book's resources, for the contour and proportions of a picture a
   *  finish takes its shape from. */
  resources?: readonly Resource[];
}

/** A zone's rectangle run out into the bleed at the sheet's edges. */
function toBleed(r: SheetRect, sheet: ProductionSheet): SheetRect {
  const eps = 0.01;
  const t = sheet.trim;
  const x0 = r.x <= t.x + eps ? 0 : r.x;
  const y0 = r.y <= t.y + eps ? 0 : r.y;
  const x1 = r.x + r.width >= t.x + t.width - eps ? sheet.width : r.x + r.width;
  const y1 = r.y + r.height >= t.y + t.height - eps ? sheet.height : r.y + r.height;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Placed on the sheet: the bleed box's corner is the sheet's. */
const onSheet = (r: SheetRect) => ({
  anchor: { to: 'bleed' as const, edge: 'top-left' as const },
  offset: { x: mm(r.x), y: mm(r.y) },
  size: { width: mm(r.width), height: mm(r.height) },
});

/** The decoration a design draws under the frames: the sheet's ground, its
 *  picture, each zone's ground, then the movable elements. */
function designElements(sheet: ProductionSheet, design: CoverDesign | undefined): DesignElement[] {
  if (!design) return [];
  const out: DesignElement[] = [];
  const whole = { x: 0, y: 0, width: sheet.width, height: sheet.height };
  if (design.background) {
    out.push({ kind: 'box', id: 'cover-ground', placement: onSheet(whole), style: { backgroundColor: design.background } } as DesignBoxElement);
  }
  if (design.image?.resourceId) {
    const front = sheet.zones.find((z) => z.name === 'front');
    const area = design.image.area === 'front' && front ? toBleed(front.rect, sheet) : whole;
    out.push({
      kind: 'image',
      id: 'cover-image',
      resourceId: design.image.resourceId,
      decorative: true,
      fit: 'cover',
      ...(design.image.focus ? { focus: design.image.focus } : {}),
      placement: onSheet(area),
    });
  }
  for (const zone of sheet.zones) {
    const color = design.zones?.[zone.name];
    if (!color) continue;
    out.push({ kind: 'box', id: `cover-zone-${zone.name}`, placement: onSheet(toBleed(zone.rect, sheet)), style: { backgroundColor: color } } as DesignBoxElement);
  }
  for (const el of design.elements ?? []) out.push(...elementDrawing(sheet, el, 'cover-el', false));
  return out;
}

/** A colour at an opacity: `#rrggbb` with its alpha. */
function withOpacity(color: ColorValue, opacity: number | undefined): ColorValue {
  if (opacity === undefined || opacity >= 1) return color;
  const a = Math.round(Math.max(0, Math.min(1, opacity)) * 255).toString(16).padStart(2, '0');
  return { ...color, hex: color.hex.slice(0, 7) + a };
}

/** An element as the decoration draws it: a picture fitted in its box, or
 *  a box of its colour; `over` the text frames or under them. */
function elementDrawing(sheet: ProductionSheet, el: CoverElement, prefix: string, over: boolean): DesignElement[] {
  const rect = coverElementRect(sheet, el);
  if (!rect || rect.width <= 0 || rect.height <= 0) return [];
  const id = `${prefix}-${el.id}`;
  const above = over ? { over: true } : {};
  if (el.kind === 'image' && el.resourceId) {
    return [{ kind: 'image', id, resourceId: el.resourceId, decorative: true, fit: 'contain', placement: onSheet(rect), ...above }];
  }
  if (el.kind === 'box' && el.color) {
    return [{ kind: 'box', id, placement: onSheet(rect), style: { backgroundColor: withOpacity(el.color, el.opacity) }, ...above } as DesignBoxElement];
  }
  return [];
}

/** Where a picture fitted (`contain`) in a box is drawn, by its aspect. */
function containedRect(rect: SheetRect, aspect: number): SheetRect {
  if (!(aspect > 0)) return rect;
  if (rect.width / rect.height > aspect) {
    const width = rect.height * aspect;
    return { x: rect.x + (rect.width - width) / 2, y: rect.y, width, height: rect.height };
  }
  const height = rect.width / aspect;
  return { x: rect.x, y: rect.y + (rect.height - height) / 2, width: rect.width, height };
}

/** A picture's outline in fractions of it: its contour's polygon, or the
 *  rows of its traced alpha channel (left edges down, right edges up). */
function pictureOutline(resource: Resource | undefined): { x: number; y: number }[] | undefined {
  const polygon = contourPolygon(resource?.contour);
  if (polygon) return polygon;
  const traced = resource?.contour?.traced;
  if (!traced || traced.rows <= 0) return undefined;
  const left: { x: number; y: number }[] = [];
  const right: { x: number; y: number }[] = [];
  for (let r = 0; r < traced.rows; r++) {
    const lo = traced.spans[2 * r]!;
    const hi = traced.spans[2 * r + 1]!;
    if (lo < 0 || hi < 0) continue;
    const y0 = r / traced.rows;
    const y1 = (r + 1) / traced.rows;
    left.push({ x: lo, y: y0 }, { x: lo, y: y1 });
    right.push({ x: hi, y: y0 }, { x: hi, y: y1 });
  }
  return left.length >= 2 ? [...left, ...right.reverse()] : undefined;
}

/** The colour of a finish: translucent on screen, or its ink's plate,
 *  solid and overprinting, for the press. */
function finishColor(finish: CoverFinish, mode: 'screen' | 'press'): ColorValue {
  const ink = COVER_FINISH_INKS[finish.kind];
  if (mode === 'screen') return { hex: `${ink.screen}73`, model: 'hex' };
  return { hex: ink.screen, model: 'spot', spot: { name: finish.ink || ink.ink, cmyk: ink.cmyk, tint: 100, overprint: true } };
}

/** The decoration over the text: the effects, the logos, then (after the
 *  barcode, which the caller adds) the finishes. */
function overElements(sheet: ProductionSheet, design: CoverDesign | undefined): DesignElement[] {
  const out: DesignElement[] = [];
  for (const el of design?.effects ?? []) out.push(...elementDrawing(sheet, el, 'cover-fx', true));
  for (const logo of design?.logos ?? []) out.push(...elementDrawing(sheet, logo, 'cover-logo', true));
  return out;
}

function finishElements(sheet: ProductionSheet, design: CoverDesign | undefined, mode: 'screen' | 'press', resources: readonly Resource[]): DesignElement[] {
  const out: DesignElement[] = [];
  const all = [...(design?.elements ?? []), ...(design?.effects ?? []), ...(design?.logos ?? [])];
  for (const finish of design?.finishes ?? []) {
    const fill = finishColor(finish, mode);
    const id = `cover-finish-${finish.id}`;
    if ('box' in finish.shape) {
      const rect = coverElementRect(sheet, { id: finish.id, kind: 'box', ...finish.shape.box });
      if (rect && rect.width > 0 && rect.height > 0) out.push({ kind: 'box', id, over: true, placement: onSheet(rect), style: { backgroundColor: fill } } as DesignBoxElement);
      continue;
    }
    const target = all.find((e) => e.id === (finish.shape as { element: string }).element);
    const rect = target ? coverElementRect(sheet, target) : undefined;
    if (!target || !rect || rect.width <= 0 || rect.height <= 0) continue;
    const resource = target.kind === 'image' ? resources.find((r) => r.id === target.resourceId) : undefined;
    const outline = pictureOutline(resource);
    if (!outline) {
      out.push({ kind: 'box', id, over: true, placement: onSheet(rect), style: { backgroundColor: fill } } as DesignBoxElement);
      continue;
    }
    // The contour, over the picture as it is drawn (fitted in its box).
    const size = resource?.bitmap ?? resource?.svg;
    const drawn = containedRect(rect, size?.width && size?.height ? size.width / size.height : 0);
    const d = outline.map((p, i) => `${i === 0 ? 'M' : 'L'} ${Math.round(p.x * 10000) / 10000} ${Math.round(p.y * 10000) / 10000}`).join(' ') + ' Z';
    out.push({ kind: 'path', id, over: true, d, viewBox: [1, 1], preserveAspectRatio: 'none', fill, placement: onSheet(drawn) });
  }
  return out;
}

export interface CoverPage {
  /** The page: the sheet's trim, no margins, its bleed and fold marks. */
  page: PageConfig;
  template: PageTemplate;
  /** The barcode's resource, when there is an ISBN that reads. */
  resources: Resource[];
  /** The bytes of those resources by `fileId`. */
  files: Record<string, Uint8Array>;
  /** The frames the Markdown can fill, by slot name. */
  slots: CoverZoneName[];
}

function frameFor(
  zone: SheetZone,
  sheet: ProductionSheet,
  spineText: Required<NonNullable<ProductionVersion['spineText']>>,
  vertical?: 'top' | 'middle' | 'bottom',
): FrameConfig | undefined {
  const s = zone.safe;
  const at = (x: number, y: number) => ({ anchor: { to: 'container' as const, edge: 'top-left' as const }, offset: { x: mm(x - sheet.trim.x), y: mm(y - sheet.trim.y) } });
  if (zone.name !== 'spine') {
    return {
      name: zone.name,
      width: mm(s.width),
      height: mm(s.height),
      placement: at(s.x, s.y),
      optional: true,
      ...(vertical && vertical !== 'top' ? { verticalAlign: vertical } : {}),
    };
  }
  if (zone.rect.width < spineText.minSpine) return undefined;
  // Laid out along the spine, then turned about its centre to read up
  // (−90°) or down (90°) it.
  const length = s.height;
  const across = s.width;
  const cx = s.x + s.width / 2;
  const cy = s.y + s.height / 2;
  return {
    name: 'spine',
    width: mm(length),
    height: mm(across),
    rotate: spineText.direction === 'bottomToTop' ? -90 : 90,
    verticalAlign: 'middle',
    placement: at(cx - length / 2, cy - across / 2),
    optional: true,
  };
}

/** The page and the template that compose a production sheet (see
 *  `versionSheets`). Spread `page` into the cover's config with the
 *  book's typography, add `template` to its `pageTemplates`, the
 *  resources to its content and the files to the PDF's `resourceBytes`;
 *  then write the cover as `::::page{template="cover"}` with a
 *  `:::frame{slot="…"}` for each zone (see `coverMarkdown`). */
export function coverPage(sheet: ProductionSheet, options: CoverPageOptions = {}): CoverPage {
  const spineText = { ...DEFAULT_SPINE_TEXT, ...options.spineText };
  const frames: FrameConfig[] = [];
  for (const zone of sheet.zones) {
    if (!SLOT_ZONES.has(zone.name)) continue;
    const frame = frameFor(zone, sheet, spineText, options.verticalAlign?.[zone.name]);
    if (frame) frames.push(frame);
  }
  // Fold marks inside the trim only: a case's turn-in folds are its trim.
  const folds = sheet.lines
    .map((l) => l.x - sheet.trim.x)
    .filter((x) => x > 0.01 && x < sheet.trim.width - 0.01)
    .map(mm);
  const page: PageConfig = {
    sizePreset: 'custom',
    width: mm(sheet.trim.width),
    height: mm(sheet.trim.height),
    margins: { top: mm(0), bottom: mm(0), left: mm(0), right: mm(0) },
    // A screen picture has no bleed and no marks.
    cutLines: sheet.kind === 'promo'
      ? { enabled: false }
      : { enabled: true, bleed: mm(sheet.bleed), ...(folds.length ? { foldMarks: folds } : {}) },
  };
  const template: PageTemplate = {
    id: options.templateId ?? 'cover',
    area: 'trim',
    frames,
    header: false,
    footer: false,
  };
  const elements: DesignElement[] = [...designElements(sheet, options.design), ...overElements(sheet, options.design)];
  const resources: Resource[] = [];
  const files: Record<string, Uint8Array> = {};
  const back = sheet.zones.find((z) => z.name === 'back');
  const barcode = options.isbn && back
    ? isbnBarcodeSvg(options.isbn, { addOn: options.isbnAddOn, magnification: options.barcodeMagnification })
    : undefined;
  if (barcode && back) {
    const fileId = `${BARCODE_RESOURCE_ID}.svg`;
    const px = (v: number) => (v / 25.4) * 96;
    resources.push({
      id: BARCODE_RESOURCE_ID,
      typeId: 'figure',
      kind: 'svg',
      altText: `ISBN ${options.isbn}`,
      createdAt: 0,
      updatedAt: 0,
      svg: { fileId, width: px(barcode.width), height: px(barcode.height), ...(options.barcodePdf ? { pdfFileId: BARCODE_PDF_FILE_ID } : {}) },
    } as Resource);
    files[fileId] = new TextEncoder().encode(barcode.svg);
    // In the back cover's corner by the spine and the foot (Spanish ISBN
    // agency, BISG), inside its safe area.
    const s = back.safe;
    // Over the text, the effects and the logos: nothing hides it.
    const element: DesignImageElement = {
      kind: 'image',
      id: BARCODE_RESOURCE_ID,
      resourceId: BARCODE_RESOURCE_ID,
      over: true,
      placement: {
        anchor: { to: 'page', edge: 'top-left' },
        offset: { x: mm(s.x + s.width - barcode.width - sheet.trim.x), y: mm(s.y + s.height - barcode.height - sheet.trim.y) },
        size: { width: mm(barcode.width), height: mm(barcode.height) },
      },
    };
    elements.push(element);
  }
  elements.push(...finishElements(sheet, options.design, options.finishes ?? 'screen', options.resources ?? []));
  if (elements.length > 0) template.decoration = { elements };
  return { page, template, resources, files, slots: frames.map((f) => f.name as CoverZoneName) };
}

/** The Markdown of a cover: the page fence with a frame for each slot that
 *  has text, in the order of `slots`. */
export function coverMarkdown(templateId: string, content: Partial<Record<CoverZoneName, string>>, slots: readonly CoverZoneName[]): string {
  const parts = [`::::page{template="${templateId}"}`];
  for (const slot of slots) {
    const text = content[slot]?.trim();
    if (text) parts.push(`:::frame{slot="${slot}"}`, text, ':::');
  }
  parts.push('::::');
  return parts.join('\n\n');
}

/** A guide across a sheet for whoever finishes it by hand: a fold, score,
 *  joint or glue line, the edge of a zone, or the edge of a zone's safe
 *  area. `at` is mm from the left (vertical) or top (horizontal) edge of
 *  the trim, as the cover page stands. */
export interface SheetGuide {
  orientation: 'vertical' | 'horizontal';
  at: number;
  kind: SheetLine['kind'] | 'zone' | 'safe';
}

/** The guides of a sheet, each place once (a line before the zone edge it
 *  falls on, a zone edge before a safe edge), none on the trim's edges. */
export function sheetGuides(sheet: ProductionSheet): SheetGuide[] {
  const eps = 0.01;
  const t = sheet.trim;
  const out: SheetGuide[] = [];
  const add = (orientation: SheetGuide['orientation'], sheetAt: number, kind: SheetGuide['kind']) => {
    const at = sheetAt - (orientation === 'vertical' ? t.x : t.y);
    const edge = orientation === 'vertical' ? t.width : t.height;
    if (at <= eps || at >= edge - eps) return;
    if (out.some((g) => g.orientation === orientation && Math.abs(g.at - at) < eps)) return;
    out.push({ orientation, at: Math.round(at * 1000) / 1000, kind });
  };
  for (const l of sheet.lines) add('vertical', l.x, l.kind);
  for (const z of sheet.zones) {
    add('vertical', z.rect.x, 'zone');
    add('vertical', z.rect.x + z.rect.width, 'zone');
  }
  for (const z of sheet.zones) {
    add('vertical', z.safe.x, 'safe');
    add('vertical', z.safe.x + z.safe.width, 'safe');
    add('horizontal', z.safe.y, 'safe');
    add('horizontal', z.safe.y + z.safe.height, 'safe');
  }
  return out;
}
