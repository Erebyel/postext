/**
 * The layers of the cover designer, bottom to top, and its movable
 * elements. The layers are fixed: each holds its own kind of element and
 * keeps its place in the stack, so a cover is built the same way every
 * time. The grounds (the sheet's colour, its picture, the zones') are the
 * background; the movable elements stand over them, anywhere on the sheet,
 * placed by the zone they stand in; the texts go in their zones' frames
 * above; over the text, the effects (translucent boxes, pictures with
 * transparency of their own), the logos with their clear space, and the
 * finishes, each a spot-colour plate the shape of a box or of an element.
 * Pure functions: the designer (./CoverDesigner.tsx) draws what they work
 * out.
 */

import { coverElementRect, placeCoverElement, type CoverElement, type CoverFinishKind, type CoverOutline, type CoverZoneName, type ProductionSheet, type Resource, type SheetRect } from 'postext';
import type { CoverDesignSettings } from './bookProduction.js';

export const COVER_LAYERS = ['background', 'elements', 'texts', 'effects', 'logos', 'finishes'] as const;
export type CoverLayer = (typeof COVER_LAYERS)[number];

/** The layers whose items are placed on the sheet (the canvas edits the
 *  active one's). */
export type ItemLayer = 'elements' | 'effects' | 'logos' | 'finishes';
export const ITEM_LAYERS: readonly ItemLayer[] = ['elements', 'effects', 'logos', 'finishes'];

/** A movable element as the book stores it: a picture of the book, or a
 *  box of colour (`#rrggbb`), its box mm from its zone's top-left corner. */
export interface CoverElementSetting {
  id: string;
  /** The name the designer lists it by, the user's own (default: what it
   *  is, a picture's name). */
  name?: string;
  /** A picture, a box of colour, or a shape of colour (an outline traced
   *  from a picture, laid in its box). */
  kind: 'image' | 'box' | 'shape';
  /** A shape's outline, in fractions of its box. */
  outline?: CoverOutline;
  /** An effect's picture cut to an outline (a trace of the gallery),
   *  filling its box. */
  clip?: CoverOutline;
  resourceId?: string;
  color?: string;
  zone: CoverZoneName;
  x: number;
  y: number;
  width: number;
  height: number;
  /** A box's opacity, 0 … 1 (an effect's); absent: opaque. */
  opacity?: number;
  /** A movable element painted as it is past the design margin, over the
   *  mirror, instead of folded out with the background. */
  bleed?: 'own';
}

/** A logo on the cover: a picture of the logo library (`logoId`) or of
 *  the book (`resourceId`), and the clear space round it, mm. */
export interface CoverLogoSetting extends CoverElementSetting {
  kind: 'image';
  logoId?: string;
  clearance: number;
}

export const FINISH_KINDS: readonly CoverFinishKind[] = ['varnish', 'lamination', 'foilGold', 'foilSilver', 'emboss', 'deboss'];

/** A finish as the book stores it: its kind, the ink its plate is named
 *  after, and what it covers — a box of its own, placed like an element,
 *  or the shape of an element, effect or logo of the design. */
export interface CoverFinishSetting {
  id: string;
  /** The name the designer lists it by (default: its kind). */
  name?: string;
  kind: CoverFinishKind;
  ink: string;
  shape:
    | { box: FinishBox }
    | { element: string }
    | { outline: CoverOutline; box: FinishBox };
}

type FinishBox = { zone: CoverZoneName; x: number; y: number; width: number; height: number };

/** A stored outline that reads: polygons of three points or more, each
 *  point within its box. */
export function readOutline(raw: unknown): CoverOutline | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: CoverOutline = [];
  for (const poly of raw) {
    if (!Array.isArray(poly)) continue;
    const pts = poly.filter((p): p is { x: number; y: number } => isRecord(p) && finite(p.x) && finite(p.y) && p.x >= -0.01 && p.x <= 1.01 && p.y >= -0.01 && p.y <= 1.01);
    if (pts.length >= 3) out.push(pts.map((p) => ({ x: p.x, y: p.y })));
  }
  return out.length > 0 ? out : undefined;
}

const ZONE_NAMES: ReadonlySet<string> = new Set(['flapBack', 'back', 'jointBack', 'spine', 'jointFront', 'front', 'flapFront', 'pastedown', 'flyleaf', 'hinge']);
const HEX = /^#[0-9a-f]{6}$/i;
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const named = (v: unknown): { name?: string } => (typeof v === 'string' && v.trim() ? { name: v.trim() } : {});

/** The stored elements that read: an id, a kind, a zone, a box with a
 *  size; a picture's resource, a box's colour. */
export function readCoverElements(raw: unknown): CoverElementSetting[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((e): CoverElementSetting[] => {
    if (!isRecord(e) || typeof e.id !== 'string' || (e.kind !== 'image' && e.kind !== 'box' && e.kind !== 'shape')) return [];
    if (typeof e.zone !== 'string' || !ZONE_NAMES.has(e.zone)) return [];
    if (!finite(e.x) || !finite(e.y) || !finite(e.width) || !finite(e.height) || e.width <= 0 || e.height <= 0) return [];
    if (e.kind === 'image' && typeof e.resourceId !== 'string') return [];
    if (e.kind !== 'image' && (typeof e.color !== 'string' || !HEX.test(e.color))) return [];
    const outline = e.kind === 'shape' ? readOutline(e.outline) : undefined;
    const clip = e.kind === 'image' ? readOutline(e.clip) : undefined;
    if (e.kind === 'shape' && !outline) return [];
    return [{
      id: e.id,
      kind: e.kind,
      ...(e.kind === 'image' ? { resourceId: e.resourceId as string } : { color: e.color as string }),
      ...(outline ? { outline } : {}),
      ...(clip ? { clip } : {}),
      ...named(e.name),
      zone: e.zone as CoverZoneName,
      x: e.x,
      y: e.y,
      width: e.width,
      height: e.height,
      ...(finite(e.opacity) && e.opacity >= 0 && e.opacity < 1 ? { opacity: e.opacity } : {}),
      ...(e.bleed === 'own' ? { bleed: 'own' as const } : {}),
    }];
  });
}

/** The stored logos that read: pictures (of the library or the book) with
 *  a clear space of 0 mm or more. */
export function readCoverLogos(raw: unknown): CoverLogoSetting[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((l): CoverLogoSetting[] => {
    if (!isRecord(l)) return [];
    const logoId = typeof l.logoId === 'string' ? l.logoId : undefined;
    const [el] = readCoverElements([{ ...l, kind: 'image', resourceId: typeof l.resourceId === 'string' ? l.resourceId : logoId ? `logo:${logoId}` : undefined }]);
    if (!el) return [];
    const clearance = finite(l.clearance) && l.clearance >= 0 ? l.clearance : 0;
    return [{ ...el, kind: 'image', ...(logoId ? { logoId } : {}), clearance }];
  });
}

/** The stored finishes that read: a kind, an ink, and a box or an
 *  element to take their shape from. */
export function readCoverFinishes(raw: unknown): CoverFinishSetting[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((f): CoverFinishSetting[] => {
    if (!isRecord(f) || typeof f.id !== 'string' || !FINISH_KINDS.includes(f.kind as CoverFinishKind)) return [];
    const ink = typeof f.ink === 'string' ? f.ink : '';
    const shape = isRecord(f.shape) ? f.shape : {};
    if (typeof shape.element === 'string') return [{ id: f.id, ...named(f.name), kind: f.kind as CoverFinishKind, ink, shape: { element: shape.element } }];
    const [box] = readCoverElements([{ id: f.id, kind: 'box', color: '#000000', ...(isRecord(shape.box) ? shape.box : {}) }]);
    if (!box) return [];
    const at = { zone: box.zone, x: box.x, y: box.y, width: box.width, height: box.height };
    const outline = readOutline(shape.outline);
    return [{ id: f.id, ...named(f.name), kind: f.kind as CoverFinishKind, ink, shape: outline ? { outline, box: at } : { box: at } }];
  });
}

/** A finish with a box of its own (bare or holding an outline) as an
 *  element the canvas can move, in its colour on screen; undefined for one
 *  shaped by an element. */
export function finishAsElement(finish: CoverFinishSetting, screen: string): CoverElementSetting | undefined {
  if (!('box' in finish.shape)) return undefined;
  return { id: finish.id, kind: 'box', color: screen, ...finish.shape.box };
}

/** The finish moved to where its element now stands. */
export function finishFromElement(finish: CoverFinishSetting, el: CoverElementSetting): CoverFinishSetting {
  const box = { zone: el.zone, x: el.x, y: el.y, width: el.width, height: el.height };
  return { ...finish, shape: 'outline' in finish.shape ? { outline: finish.shape.outline, box } : { box } };
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
  if (hidden.has('effects')) delete out.effects;
  if (hidden.has('logos')) delete out.logos;
  if (hidden.has('finishes')) delete out.finishes;
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

/** A new logo near the foot of the front cover, a quarter of it wide at
 *  its own proportions: a picture of the logo library or of the book. */
export function newLogo(
  sheet: ProductionSheet,
  source: { logoId: string } | { resourceId: string },
  aspect: number,
  clearance: number,
): CoverLogoSetting | undefined {
  const front = sheet.zones.find((z) => z.name === 'front');
  if (!front) return undefined;
  const round = (v: number) => Math.round(v * 100) / 100;
  const width = front.rect.width * 0.25;
  const height = width / (aspect > 0 ? aspect : 1);
  return {
    id: newElementId(),
    kind: 'image',
    ...('logoId' in source ? { logoId: source.logoId, resourceId: `logo:${source.logoId}` } : { resourceId: source.resourceId }),
    zone: 'front',
    x: round((front.rect.width - width) / 2),
    y: round(front.safe.y + front.safe.height - front.rect.y - height),
    width: round(width),
    height: round(height),
    clearance,
  };
}

/** A new finish in the middle of the front cover: a box of its own, or
 *  an outline at its own proportions. */
export function newFinish(sheet: ProductionSheet, kind: CoverFinishKind, ink: string, trace?: { outline: CoverOutline; aspect: number }): CoverFinishSetting | undefined {
  const box = trace ? newShape(sheet, trace, '#000000') : newElement(sheet, 'box');
  if (!box) return undefined;
  const at = { zone: box.zone, x: box.x, y: box.y, width: box.width, height: box.height };
  return { id: box.id, kind, ink, shape: trace ? { outline: trace.outline, box: at } : { box: at } };
}

/** A new shape of colour in the middle of the front cover, half of it
 *  wide, an outline at its own proportions. */
export function newShape(sheet: ProductionSheet, trace: { outline: CoverOutline; aspect: number }, color: string, opacity?: number): CoverElementSetting | undefined {
  const front = sheet.zones.find((z) => z.name === 'front');
  if (!front) return undefined;
  const round = (v: number) => Math.round(v * 100) / 100;
  const width = front.rect.width * 0.5;
  const height = width / (trace.aspect > 0 ? trace.aspect : 1);
  return {
    id: newElementId(),
    kind: 'shape',
    color,
    outline: trace.outline,
    zone: 'front',
    x: round((front.rect.width - width) / 2),
    y: round((front.rect.height - height) / 2),
    width: round(width),
    height: round(height),
    ...(opacity !== undefined && opacity < 1 ? { opacity } : {}),
  };
}

/** `id` moved one step up (toward the front) or down the stack. */
export function restack<T extends { id: string }>(elements: readonly T[], id: string, step: 1 | -1): T[] {
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
