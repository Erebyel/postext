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
import type { DesignImageElement } from '../types/designElements.js';
import type { Dimension, PageConfig } from '../types/page.js';
import type { Resource } from '../types/resources/resources.js';
import type { ProductionVersion } from '../types/output/production.js';
import { isbnBarcodeSvg } from './barcodeSvg.js';
import type { CoverZoneName, ProductionSheet, SheetZone } from './geometry.js';

const mm = (value: number): Dimension => ({ value: Math.round(value * 1000) / 1000, unit: 'mm' });

/** The zones a cover's Markdown fills; joints and the endpaper's hinge
 *  take nothing. */
const SLOT_ZONES: ReadonlySet<CoverZoneName> = new Set(['flapBack', 'back', 'spine', 'front', 'flapFront', 'pastedown', 'flyleaf']);

export const BARCODE_RESOURCE_ID = 'isbn-barcode';

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

function frameFor(zone: SheetZone, sheet: ProductionSheet, spineText: Required<NonNullable<ProductionVersion['spineText']>>): FrameConfig | undefined {
  const s = zone.safe;
  const at = (x: number, y: number) => ({ anchor: { to: 'container' as const, edge: 'top-left' as const }, offset: { x: mm(x - sheet.trim.x), y: mm(y - sheet.trim.y) } });
  if (zone.name !== 'spine') {
    return { name: zone.name, width: mm(s.width), height: mm(s.height), placement: at(s.x, s.y), optional: true };
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
    const frame = frameFor(zone, sheet, spineText);
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
    cutLines: { enabled: true, bleed: mm(sheet.bleed), ...(folds.length ? { foldMarks: folds } : {}) },
  };
  const template: PageTemplate = {
    id: options.templateId ?? 'cover',
    area: 'trim',
    frames,
    header: false,
    footer: false,
  };
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
      svg: { fileId, width: px(barcode.width), height: px(barcode.height) },
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
    template.decoration = { elements: [element] };
  }
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
