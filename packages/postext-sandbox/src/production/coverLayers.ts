/**
 * The layers of the cover designer, bottom to top, and its movable
 * elements. The layers are fixed: each holds its own kind of element and
 * keeps its place in the stack, so a cover is built the same way every
 * time. The grounds (the sheet's colour, its picture, the zones') are the
 * background; the movable elements stand over them, anywhere on the sheet,
 * placed by the zone they stand in; the texts go in their zones' frames
 * above. Effects, logos and finishes come later. Pure functions: the
 * designer (./CoverDesigner.tsx) draws what they work out.
 */

import { coverElementRect, placeCoverElement, type CoverElement, type CoverZoneName, type ProductionSheet, type Resource, type SheetRect } from 'postext';
import type { CoverDesignSettings } from './bookProduction.js';

export const COVER_LAYERS = ['background', 'elements', 'texts', 'effects', 'logos', 'finishes'] as const;
export type CoverLayer = (typeof COVER_LAYERS)[number];

/** The layers the designer edits today. */
export const READY_LAYERS: ReadonlySet<CoverLayer> = new Set(['background', 'elements', 'texts']);

/** A movable element as the book stores it: a picture of the book, or a
 *  box of colour (`#rrggbb`), its box mm from its zone's top-left corner. */
export interface CoverElementSetting {
  id: string;
  kind: 'image' | 'box';
  resourceId?: string;
  color?: string;
  zone: CoverZoneName;
  x: number;
  y: number;
  width: number;
  height: number;
}

const ZONE_NAMES: ReadonlySet<string> = new Set(['flapBack', 'back', 'jointBack', 'spine', 'jointFront', 'front', 'flapFront', 'pastedown', 'flyleaf', 'hinge']);
const HEX = /^#[0-9a-f]{6}$/i;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The stored elements that read: an id, a kind, a zone, a box with a
 *  size; a picture's resource, a box's colour. */
export function readCoverElements(raw: unknown): CoverElementSetting[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((e): CoverElementSetting[] => {
    if (!isRecord(e) || typeof e.id !== 'string' || (e.kind !== 'image' && e.kind !== 'box')) return [];
    if (typeof e.zone !== 'string' || !ZONE_NAMES.has(e.zone)) return [];
    if (!finite(e.x) || !finite(e.y) || !finite(e.width) || !finite(e.height) || e.width <= 0 || e.height <= 0) return [];
    if (e.kind === 'image' && typeof e.resourceId !== 'string') return [];
    if (e.kind === 'box' && (typeof e.color !== 'string' || !HEX.test(e.color))) return [];
    return [{
      id: e.id,
      kind: e.kind,
      ...(e.kind === 'image' ? { resourceId: e.resourceId as string } : { color: e.color as string }),
      zone: e.zone as CoverZoneName,
      x: e.x,
      y: e.y,
      width: e.width,
      height: e.height,
    }];
  });
}

/** The design with the hidden layers' parts left out. */
export function designShowing(design: CoverDesignSettings | undefined, hidden: ReadonlySet<CoverLayer>): CoverDesignSettings | undefined {
  if (!design || hidden.size === 0) return design;
  const out: CoverDesignSettings = { ...design };
  if (hidden.has('background')) {
    delete out.background;
    delete out.image;
    delete out.zones;
  }
  if (hidden.has('elements')) delete out.elements;
  return out;
}

/** Where an element stands on the sheet, mm from its corner. */
export const elementRect = (sheet: ProductionSheet, el: CoverElementSetting): SheetRect | undefined =>
  coverElementRect(sheet, geometryOf(el));

/** The element at `rect` (sheet mm), placed by the zone it now stands in. */
export function elementAt(sheet: ProductionSheet, el: CoverElementSetting, rect: SheetRect): CoverElementSetting {
  const { zone, x, y, width, height } = placeCoverElement(sheet, geometryOf(el), rect);
  return { ...el, zone, x, y, width, height };
}

/** Only the placing of an element, which is all the engine's geometry reads. */
const geometryOf = (el: CoverElementSetting): CoverElement => ({ id: el.id, kind: el.kind, zone: el.zone, x: el.x, y: el.y, width: el.width, height: el.height });

export function newElementId(): string {
  return `el-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** A picture's width over its height, 1 when it does not say. */
export function pictureAspect(resource: Resource | undefined): number {
  const size = resource?.bitmap ?? resource?.svg;
  const w = size?.width ?? 0;
  const h = size?.height ?? 0;
  return w > 0 && h > 0 ? w / h : 1;
}

/** A new element in the middle of the front cover: a picture half the
 *  cover wide, at its own proportions, or a box a third of it. */
export function newElement(sheet: ProductionSheet, kind: 'image' | 'box', resource?: Resource, color = '#808080'): CoverElementSetting | undefined {
  const front = sheet.zones.find((z) => z.name === 'front');
  if (!front) return undefined;
  const width = front.rect.width * (kind === 'image' ? 0.5 : 0.33);
  const height = kind === 'image' ? width / pictureAspect(resource) : width;
  const round = (v: number) => Math.round(v * 100) / 100;
  return {
    id: newElementId(),
    kind,
    ...(kind === 'image' ? { resourceId: resource?.id ?? '' } : { color }),
    zone: 'front',
    x: round((front.rect.width - width) / 2),
    y: round((front.rect.height - height) / 2),
    width: round(width),
    height: round(height),
  };
}

/** `id` moved one step up (toward the front) or down the stack. */
export function restack(elements: readonly CoverElementSetting[], id: string, step: 1 | -1): CoverElementSetting[] {
  const i = elements.findIndex((e) => e.id === id);
  const j = i + step;
  if (i < 0 || j < 0 || j >= elements.length) return [...elements];
  const out = [...elements];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

/** The front-most element under a point (sheet mm), or undefined. */
export function elementUnder(sheet: ProductionSheet, elements: readonly CoverElementSetting[], x: number, y: number): CoverElementSetting | undefined {
  for (let i = elements.length - 1; i >= 0; i--) {
    const r = elementRect(sheet, elements[i]!);
    if (r && x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) return elements[i];
  }
  return undefined;
}

/** What the designer flags on the sheet before it is passed: an element
 *  that the sheet has no room for (off the sheet altogether), or one whose
 *  picture the book no longer has. */
export type CoverElementIssue = { id: string; kind: 'offSheet' | 'missingPicture' };

export function coverElementIssues(sheet: ProductionSheet, elements: readonly CoverElementSetting[], resources: readonly Resource[]): CoverElementIssue[] {
  const out: CoverElementIssue[] = [];
  for (const el of elements) {
    const r = elementRect(sheet, el);
    if (!r || r.x + r.width <= 0 || r.y + r.height <= 0 || r.x >= sheet.width || r.y >= sheet.height) out.push({ id: el.id, kind: 'offSheet' });
    if (el.kind === 'image' && !resources.some((res) => res.id === el.resourceId)) out.push({ id: el.id, kind: 'missingPicture' });
  }
  return out;
}
