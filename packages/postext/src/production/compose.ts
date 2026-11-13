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
}

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
  for (const el of design.elements ?? []) {
    const rect = coverElementRect(sheet, el);
    if (!rect || rect.width <= 0 || rect.height <= 0) continue;
    const id = `cover-el-${el.id}`;
    if (el.kind === 'image' && el.resourceId) {
      out.push({ kind: 'image', id, resourceId: el.resourceId, decorative: true, fit: 'contain', placement: onSheet(rect) });
    } else if (el.kind === 'box' && el.color) {
      out.push({ kind: 'box', id, placement: onSheet(rect), style: { backgroundColor: el.color } } as DesignBoxElement);
    }
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
  const elements: DesignElement[] = designElements(sheet, options.design);
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
    const element: DesignImageElement = {
      kind: 'image',
      id: BARCODE_RESOURCE_ID,
      resourceId: BARCODE_RESOURCE_ID,
      placement: {
        anchor: { to: 'page', edge: 'top-left' },
        offset: { x: mm(s.x + s.width - barcode.width - sheet.trim.x), y: mm(s.y + s.height - barcode.height - sheet.trim.y) },
        size: { width: mm(barcode.width), height: mm(barcode.height) },
      },
    };
    elements.push(element);
  }
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
