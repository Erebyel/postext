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
import { mirrorBleedSvg } from './mirrorBleed.js';
import { needsArt, pathData, roundedRectPath, shapeArt, shapeArtSvg, type CoverEffects, type CoverPath } from './shapes.js';
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
  /** A box of its own, an element's shape, or a saved outline laid in a
   *  box of its own. */
  shape:
    | { box: Pick<CoverElement, 'zone' | 'x' | 'y' | 'width' | 'height' | 'basis'> }
    | { element: string }
    | { outline: CoverOutline; box: Pick<CoverElement, 'zone' | 'x' | 'y' | 'width' | 'height' | 'basis'> };
}

/** An outline: closed polygons, their points in fractions of the box they
 *  are laid in (0, 0 its top-left corner; 1, 1 its bottom-right). Traced
 *  from a picture, it keeps its shape for a veil or a finish. */
export type CoverOutline = { x: number; y: number }[][];

/** An outline as SVG path data in a 1 × 1 view box. */
export function outlinePathData(outline: CoverOutline): string {
  const r = (n: number) => Math.round(n * 10000) / 10000;
  return outline
    .filter((poly) => poly.length >= 3)
    .map((poly) => poly.map((p, i) => `${i === 0 ? 'M' : 'L'} ${r(p.x)} ${r(p.y)}`).join(' ') + ' Z')
    .join(' ');
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

/** A movable element of a cover's design: a picture, a box of colour, or
 *  a shape of colour (a box with an outline). Placed by the zone it stands
 *  in, so it moves with that zone when the spine grows or the binding
 *  changes. */
export interface CoverElement extends CoverEffects {
  id: string;
  kind: 'image' | 'box' | 'shape';
  /** A shape's outline, in its box (a traced one). */
  outline?: CoverOutline;
  /** A shape drawn by nodes (a basic shape, edited), in its box; over
   *  `outline` when both are there. */
  path?: CoverPath;
  /** An image's picture: a bitmap or SVG resource of the book. */
  resourceId?: string;
  /** A box's colour. */
  color?: ColorValue;
  zone: CoverZoneName;
  /** The size of its zone when it was placed, mm. When the zone is
   *  another size now (the book's format changed, the spine grew), the
   *  element is scaled with it: a box or a shape on each axis, a picture
   *  evenly, about where its centre falls, so it keeps its proportions.
   *  Absent: it stays as placed. */
  basis?: { width: number; height: number };
  /** Its box, mm from the zone's top-left corner; it may run out of the
   *  zone, onto the sheet's other zones or into the bleed. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** A box's opacity, 0 … 1 (default 1). A picture keeps its own
   *  transparency. */
  opacity?: number;
  /** How a picture fills its box: whole inside it (`contain`, the
   *  default), or covering it, cropped (`cover`: a page's advertisement,
   *  which must reach every edge). */
  fit?: 'contain' | 'cover';
  /** A picture cut to an outline (in fractions of its box): an
   *  illustration's own shape, a shine or a texture that shows only within
   *  it. The picture then fills the box (cropped to it) rather than
   *  fitting in it. */
  clip?: CoverOutline;
  /** Past the design margin (a case's turn-in, a board's edge): `mirror`
   *  (the default) folds it out with the background; `own` paints the
   *  element as it is, over the fold, for an element whose picture goes on
   *  past the frame or that the fold would make look odd. */
  bleed?: 'mirror' | 'own';
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
  const b = el.basis;
  if (!b || b.width <= 0 || b.height <= 0 || (Math.abs(b.width - zone.rect.width) < 0.01 && Math.abs(b.height - zone.rect.height) < 0.01)) {
    return { x: zone.rect.x + el.x, y: zone.rect.y + el.y, width: el.width, height: el.height };
  }
  const sx = zone.rect.width / b.width;
  const sy = zone.rect.height / b.height;
  if (el.kind === 'image') {
    // A picture keeps its proportions: scaled evenly, its centre where it was.
    const k = Math.min(sx, sy);
    const cx = (el.x + el.width / 2) * sx;
    const cy = (el.y + el.height / 2) * sy;
    return { x: zone.rect.x + cx - (el.width * k) / 2, y: zone.rect.y + cy - (el.height * k) / 2, width: el.width * k, height: el.height * k };
  }
  return { x: zone.rect.x + el.x * sx, y: zone.rect.y + el.y * sy, width: el.width * sx, height: el.height * sy };
}

/** The element at `rect` (sheet mm) placed by the zone its centre falls in
 *  (the nearest zone when it is off them all). */
export function placeCoverElement(sheet: ProductionSheet, el: CoverElement, rect: SheetRect): CoverElement {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const distance = (r: SheetRect) => Math.hypot(Math.max(r.x - cx, 0, cx - r.x - r.width), Math.max(r.y - cy, 0, cy - r.y - r.height));
  const zone = sheet.zones.reduce((best, z) => (distance(z.rect) < distance(best.rect) ? z : best), sheet.zones[0]!);
  const round = (v: number) => Math.round(v * 100) / 100;
  return {
    ...el,
    zone: zone.name,
    x: round(rect.x - zone.rect.x),
    y: round(rect.y - zone.rect.y),
    width: round(rect.width),
    height: round(rect.height),
    basis: { width: round(zone.rect.width), height: round(zone.rect.height) },
  };
}

export interface CoverPageOptions {
  /** Id of the page template. Default `'cover'`. */
  templateId?: string;
  /** How the spine is lettered (see `DEFAULT_SPINE_TEXT`). */
  spineText?: ProductionVersion['spineText'];
  /** The ISBN as written: its barcode goes in the back cover. */
  isbn?: string;
  isbnAddOn?: string;
  /** Printed as text above the barcode: the whole work's ISBN as the
   *  caller words it (`ISBN obra completa 978-…`), for a volume of a
   *  collection or a work in several volumes. */
  workIsbnCaption?: string;
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
  /** Mirror bleed: the design is drawn this far past the trim, mm, and
   *  beyond it the background and the movable elements are mirrored out to
   *  the sheet's edge (./mirrorBleed.ts). Unset: no mirroring. */
  mirrorMargin?: number;
  /** The pictures the mirror draws, and the effects cut to an outline,
   *  by resource id: a PNG or JPEG as a data URI and its size in px. A
   *  picture missing here is left out of the mirror, and an effect's is
   *  drawn whole. */
  mirrorPictures?: Readonly<Record<string, MirrorPicture>>;
}

/** A picture the mirror bleed draws (see `CoverPageOptions.mirrorPictures`). */
export interface MirrorPicture {
  href: string;
  width: number;
  height: number;
}

export const MIRROR_RESOURCE_ID = 'cover-mirror';

/** The resource id of an effect's picture cut to its outline. */
export const clippedEffectId = (id: string): string => `cover-clip-${id}`;

/** An effect's picture cut to its outline, as an SVG the size of its box
 *  (mm): the picture filling the box, cropped to it, inside a clip path of
 *  the outline. */
export function clippedPictureSvg(rect: SheetRect, outline: CoverOutline, picture: MirrorPicture): string {
  const w = rect.width;
  const h = rect.height;
  const box = { x: 0, y: 0, width: w, height: h };
  const r = coverPictureRect(box, picture.width, picture.height);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${mmN(w)}mm" height="${mmN(h)}mm" viewBox="0 0 ${mmN(w)} ${mmN(h)}">`
    + `<defs><clipPath id="shape" clipPathUnits="userSpaceOnUse"><path transform="matrix(${mmN(w)} 0 0 ${mmN(h)} 0 0)" d="${outlinePathData(outline)}"/></clipPath></defs>`
    + `<g clip-path="url(#shape)"><image href="${picture.href}" x="${mmN(r.x)}" y="${mmN(r.y)}" width="${mmN(r.width)}" height="${mmN(r.height)}"/></g>`
    + '</svg>';
}

const mmN = (v: number): string => String(Math.round(v * 1000) / 1000);

/** A colour as an SVG fill: `#rrggbb` and its opacity. */
function svgFill(color: ColorValue, opacity = 1): string {
  const hex = color.hex;
  const alpha = hex.length === 9 ? parseInt(hex.slice(7, 9), 16) / 255 : 1;
  const a = alpha * opacity;
  return `fill="${hex.slice(0, 7)}"${a < 1 ? ` fill-opacity="${mmN(a)}"` : ''}`;
}

/** Where a picture of `w` × `h` px is drawn to cover `area`, centred on
 *  `focus` (fractions of the picture) as far as the area allows. */
function coverPictureRect(area: SheetRect, w: number, h: number, focus = { x: 0.5, y: 0.5 }): SheetRect {
  const s = Math.max(area.width / w, area.height / h);
  const dw = w * s;
  const dh = h * s;
  const x = Math.min(area.x, Math.max(area.x + area.width - dw, area.x + area.width / 2 - focus.x * dw));
  const y = Math.min(area.y, Math.max(area.y + area.height - dh, area.y + area.height / 2 - focus.y * dh));
  return { x, y, width: dw, height: dh };
}

/** The background and movable elements as SVG in sheet mm, as the
 *  decoration draws them: what the mirror bleed folds out; and the
 *  pictures it has no data for (`missing`). */
function underContentSvg(sheet: ProductionSheet, design: CoverDesign, pictures: Readonly<Record<string, MirrorPicture>>): { content: string; defs: string; missing: string[] } {
  const parts: string[] = [];
  const defs: string[] = [];
  const missing: string[] = [];
  const rect = (r: SheetRect, fill: string) => `<rect x="${mmN(r.x)}" y="${mmN(r.y)}" width="${mmN(r.width)}" height="${mmN(r.height)}" ${fill}/>`;
  const image = (p: MirrorPicture, r: SheetRect) => `<image href="${p.href}" x="${mmN(r.x)}" y="${mmN(r.y)}" width="${mmN(r.width)}" height="${mmN(r.height)}"/>`;
  const whole = { x: 0, y: 0, width: sheet.width, height: sheet.height };
  if (design.background) parts.push(rect(whole, svgFill(design.background)));
  const bg = design.image?.resourceId ? pictures[design.image.resourceId] : undefined;
  if (design.image?.resourceId && !bg) missing.push(design.image.resourceId);
  if (bg && design.image) {
    const front = sheet.zones.find((z) => z.name === 'front');
    const area = design.image.area === 'front' && front ? toBleed(front.rect, sheet) : whole;
    const id = `mc${defs.length}`;
    defs.push(`<clipPath id="${id}" clipPathUnits="userSpaceOnUse">${rect(area, '')}</clipPath>`);
    parts.push(`<g clip-path="url(#${id})">${image(bg, coverPictureRect(area, bg.width, bg.height, design.image.focus))}</g>`);
  }
  for (const zone of sheet.zones) {
    const color = design.zones?.[zone.name];
    if (color) parts.push(rect(toBleed(zone.rect, sheet), svgFill(color)));
  }
  for (const el of design.elements ?? []) {
    if (el.bleed === 'own') continue;
    const r = coverElementRect(sheet, el);
    if (!r || r.width <= 0 || r.height <= 0) continue;
    if (el.kind === 'box' && el.color && !el.radius && !el.stroke && !needsArt(el)) parts.push(rect(r, svgFill(el.color, el.opacity)));
    else if (el.kind !== 'image') {
      const path = elementPath(el, r);
      if (path) {
        const drawn = shapeArt(r, path, el.color, el, el.opacity ?? 1, `m-${el.id}`);
        parts.push(drawn.content);
        defs.push(drawn.defs);
      }
    }
    const p = el.kind === 'image' && el.resourceId ? pictures[el.resourceId] : undefined;
    if (p && el.clip) {
      // Cut to its outline, filling its box.
      const id = `mclip${defs.length}`;
      defs.push(`<clipPath id="${id}" clipPathUnits="userSpaceOnUse"><path transform="matrix(${mmN(r.width)} 0 0 ${mmN(r.height)} ${mmN(r.x)} ${mmN(r.y)})" d="${outlinePathData(el.clip)}"/></clipPath>`);
      parts.push(`<g clip-path="url(#${id})">${image(p, coverPictureRect(r, p.width, p.height))}</g>`);
    } else if (p) parts.push(image(p, containedRect(r, p.width / p.height)));
    else if (el.kind === 'image' && el.resourceId) missing.push(el.resourceId);
  }
  return { content: parts.join(''), defs: defs.join(''), missing };
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
/** An element whose picture is cut to its outline draws the picture of
 *  that cut (`clipped`) instead of its own. */
const withClip = (el: CoverElement, clipped: ReadonlyMap<string, string>): CoverElement => {
  const own = clipped.get(el.id);
  return own ? { ...el, resourceId: own } : el;
};

function designElements(sheet: ProductionSheet, design: CoverDesign | undefined, mirrored = false, art: ReadonlyMap<string, SheetRect> = new Map(), clipped: ReadonlyMap<string, string> = new Map()): DesignElement[] {
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
  // Under a mirror, the elements that keep their own bleed go over it.
  for (const el of design.elements ?? []) if (!mirrored || el.bleed !== 'own') out.push(...elementDrawing(sheet, withClip(el, clipped), 'cover-el', false, art));
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
function elementDrawing(sheet: ProductionSheet, el: CoverElement, prefix: string, over: boolean, art: ReadonlyMap<string, SheetRect> = new Map()): DesignElement[] {
  const rect = coverElementRect(sheet, el);
  if (!rect || rect.width <= 0 || rect.height <= 0) return [];
  const id = `${prefix}-${el.id}`;
  const above = over ? { over: true } : {};
  if (el.kind === 'image' && el.resourceId) {
    return [{ kind: 'image', id, resourceId: el.resourceId, decorative: true, fit: el.fit ?? 'contain', placement: onSheet(rect), ...above }];
  }
  // With a gradient or a shadow: the picture of itself `art` holds.
  const drawn = art.get(el.id);
  if (drawn) return [{ kind: 'image', id, resourceId: coverArtId(el.id), decorative: true, fit: 'contain', placement: onSheet(drawn), ...above }];
  if (el.kind === 'box' && el.color && !el.radius && !el.stroke) {
    return [{ kind: 'box', id, placement: onSheet(rect), style: { backgroundColor: withOpacity(el.color, el.opacity) }, ...above } as DesignBoxElement];
  }
  const path = elementPath(el, rect);
  if (!path) return [];
  const closed = path.some((p) => p.closed);
  const fill = closed && el.color ? withOpacity(el.color, el.opacity) : undefined;
  const stroke = el.stroke && el.stroke.width > 0 ? el.stroke : undefined;
  if (!fill && !stroke) return [];
  return [{
    kind: 'path',
    id,
    d: pathData(path),
    viewBox: [1, 1],
    preserveAspectRatio: 'none',
    ...(fill ? { fill } : {}),
    ...(stroke ? { stroke: withOpacity(stroke.color, el.opacity), width: mm(stroke.width) } : {}),
    placement: onSheet(rect),
    ...above,
  }];
}

/** The resource id of a box's or shape's picture of itself (its gradient,
 *  its shadow). */
export const coverArtId = (id: string): string => `cover-art-${id}`;

/** The shape of a box or a shape element, in fractions of its box `rect`:
 *  its nodes, its traced outline, or its box (corners rounded or not). */
export function elementPath(el: CoverElement, rect: SheetRect): CoverPath | undefined {
  if (el.kind === 'shape') {
    if (el.path?.length) return el.path;
    if (el.outline?.length) return el.outline.map((poly) => ({ closed: true, nodes: poly.map((p) => ({ x: p.x, y: p.y })) }));
    return undefined;
  }
  if (el.kind === 'box') return roundedRectPath(rect.width, rect.height, el.radius ?? 0);
  return undefined;
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
  const name = finish.ink || ink.ink;
  return { hex: inkHex(ink.screen, name), model: 'spot', spot: { name, cmyk: ink.cmyk, tint: 100, overprint: true } };
}

/** A screen colour of its own for each ink: the outputs know a spot ink by
 *  its `#rrggbb`, so two plates of one kind (a gloss and a matt varnish)
 *  must not share one. The blue channel moves a little, by the name. */
function inkHex(screen: string, name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const b = parseInt(screen.slice(5, 7), 16);
  const shifted = (b + (h % 24) - 12 + 256) % 256;
  return `${screen.slice(0, 5)}${shifted.toString(16).padStart(2, '0')}`;
}

/** The decoration over the text: the effects, the logos, then (after the
 *  barcode, which the caller adds) the finishes. An effect cut to an
 *  outline draws the picture `clipped` makes of it instead of its own. */
function overElements(sheet: ProductionSheet, design: CoverDesign | undefined, clipped: ReadonlyMap<string, string> = new Map(), art: ReadonlyMap<string, SheetRect> = new Map()): DesignElement[] {
  const out: DesignElement[] = [];
  for (const el of design?.effects ?? []) {
    const own = clipped.get(el.id);
    out.push(...elementDrawing(sheet, own ? { ...el, resourceId: own } : el, 'cover-fx', true, art));
  }
  for (const logo of design?.logos ?? []) out.push(...elementDrawing(sheet, logo, 'cover-logo', true));
  return out;
}

function finishElements(sheet: ProductionSheet, design: CoverDesign | undefined, mode: 'screen' | 'press', resources: readonly Resource[]): DesignElement[] {
  const out: DesignElement[] = [];
  const all = [...(design?.elements ?? []), ...(design?.effects ?? []), ...(design?.logos ?? [])];
  for (const finish of design?.finishes ?? []) {
    const fill = finishColor(finish, mode);
    const id = `cover-finish-${finish.id}`;
    if ('outline' in finish.shape) {
      const rect = coverElementRect(sheet, { id: finish.id, kind: 'box', ...finish.shape.box });
      const d = outlinePathData(finish.shape.outline);
      if (rect && rect.width > 0 && rect.height > 0 && d) out.push({ kind: 'path', id, over: true, d, viewBox: [1, 1], preserveAspectRatio: 'none', fill, placement: onSheet(rect) });
      continue;
    }
    if ('box' in finish.shape) {
      const rect = coverElementRect(sheet, { id: finish.id, kind: 'box', ...finish.shape.box });
      if (rect && rect.width > 0 && rect.height > 0) out.push({ kind: 'box', id, over: true, placement: onSheet(rect), style: { backgroundColor: fill } } as DesignBoxElement);
      continue;
    }
    const target = all.find((e) => e.id === (finish.shape as { element: string }).element);
    const rect = target ? coverElementRect(sheet, target) : undefined;
    if (!target || !rect || rect.width <= 0 || rect.height <= 0) continue;
    const own = target.kind === 'image' ? target.clip : undefined;
    const path = target.kind !== 'image' ? elementPath(target, rect) : undefined;
    const shaped = own ? outlinePathData(own) : path ? pathData(path) : '';
    if (shaped) {
      out.push({ kind: 'path', id, over: true, d: shaped, viewBox: [1, 1], preserveAspectRatio: 'none', fill, placement: onSheet(rect) });
      continue;
    }
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
  /** With a mirror bleed, the part of the sheet the design is drawn on
   *  (the trim and the design margin past it); the rest is mirrored. */
  designed?: SheetRect;
  /** The pictures that kept the mirror bleed from being made (the mirror
   *  draws only PNG and JPEG pictures it was given): the design then runs
   *  to the sheet's edge as it is. */
  mirrorSkipped?: string[];
  /** The pictures of effects cut to an outline that were drawn whole (the
   *  cut draws only PNG and JPEG pictures it was given). */
  clipSkipped?: string[];
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
  const resources: Resource[] = [];
  const files: Record<string, Uint8Array> = {};
  // Past the design margin, the background and the movable elements
  // folded out to the sheet's edge, over them and under the text.
  const under = options.mirrorMargin !== undefined && sheet.kind !== 'promo' && options.design
    ? underContentSvg(sheet, options.design, options.mirrorPictures ?? {})
    : undefined;
  // A picture the mirror cannot draw (no data, an SVG) would leave a hole
  // its ground fills: then the design goes to the edge as it is.
  const mirror = under?.content && under.missing.length === 0 ? mirrorBleedSvg(sheet, options.mirrorMargin!, under.content, under.defs) : undefined;
  const mirrorSkipped = under && under.missing.length > 0 && mirrorBleedSvg(sheet, options.mirrorMargin!, 'x') ? [...new Set(under.missing)] : undefined;
  // The boxes and shapes with a gradient or a shadow, each drawn as a
  // picture of its own.
  const art = new Map<string, SheetRect>();
  for (const el of [...(options.design?.elements ?? []), ...(options.design?.effects ?? [])]) {
    if (el.kind === 'image' || !needsArt(el)) continue;
    const rect = coverElementRect(sheet, el);
    const path = rect ? elementPath(el, rect) : undefined;
    if (!rect || !path || rect.width <= 0 || rect.height <= 0) continue;
    const drawn = shapeArt(rect, path, el.color, el, el.opacity ?? 1, `a-${el.id}`);
    const id = coverArtId(el.id);
    const fileId = `${id}.svg`;
    const px = (v: number) => (v / 25.4) * 96;
    resources.push({ id, typeId: 'figure', kind: 'svg', createdAt: 0, updatedAt: 0, svg: { fileId, width: px(drawn.bounds.width), height: px(drawn.bounds.height) } } as Resource);
    files[fileId] = new TextEncoder().encode(shapeArtSvg(drawn));
    art.set(el.id, drawn.bounds);
  }
  // The pictures cut to an outline (an element's, an effect's), each as a
  // picture of its own.
  const clipped = new Map<string, string>();
  const clipSkipped: string[] = [];
  for (const el of [...(options.design?.elements ?? []), ...(options.design?.effects ?? [])]) {
    if (el.kind !== 'image' || !el.clip || !el.resourceId) continue;
    const rect = coverElementRect(sheet, el);
    const picture = options.mirrorPictures?.[el.resourceId];
    if (!rect || rect.width <= 0 || rect.height <= 0) continue;
    if (!picture) {
      clipSkipped.push(el.resourceId);
      continue;
    }
    const id = clippedEffectId(el.id);
    const fileId = `${id}.svg`;
    const px = (v: number) => (v / 25.4) * 96;
    resources.push({ id, typeId: 'figure', kind: 'svg', createdAt: 0, updatedAt: 0, svg: { fileId, width: px(rect.width), height: px(rect.height) } } as Resource);
    files[fileId] = new TextEncoder().encode(clippedPictureSvg(rect, el.clip, picture));
    clipped.set(el.id, id);
  }
  const elements: DesignElement[] = designElements(sheet, options.design, !!mirror, art, clipped);
  if (mirror) {
    const fileId = `${MIRROR_RESOURCE_ID}.svg`;
    const px = (v: number) => (v / 25.4) * 96;
    resources.push({
      id: MIRROR_RESOURCE_ID,
      typeId: 'figure',
      kind: 'svg',
      createdAt: 0,
      updatedAt: 0,
      svg: { fileId, width: px(sheet.width), height: px(sheet.height) },
    } as Resource);
    files[fileId] = new TextEncoder().encode(mirror.svg);
    elements.push({ kind: 'image', id: MIRROR_RESOURCE_ID, resourceId: MIRROR_RESOURCE_ID, decorative: true, fit: 'contain', placement: onSheet({ x: 0, y: 0, width: sheet.width, height: sheet.height }) });
  }
  if (mirror) for (const el of options.design?.elements ?? []) if (el.bleed === 'own') elements.push(...elementDrawing(sheet, withClip(el, clipped), 'cover-el', false, art));
  elements.push(...overElements(sheet, options.design, clipped, art));
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
    // The whole work's ISBN, as text over the barcode, as wide as it.
    if (options.workIsbnCaption) {
      const height = 3.5;
      elements.push({
        kind: 'text',
        id: 'isbn-work',
        over: true,
        content: options.workIsbnCaption.replace(/\{/g, '{{').replace(/\}/g, '}}'),
        fontSize: { value: 6.5, unit: 'pt' },
        color: { hex: '#000000', model: 'hex' },
        align: 'center',
        verticalAlign: 'bottom',
        placement: {
          anchor: { to: 'page', edge: 'top-left' },
          offset: { x: mm(s.x + s.width - barcode.width - sheet.trim.x), y: mm(s.y + s.height - barcode.height - height - sheet.trim.y) },
          size: { width: mm(barcode.width), height: mm(height) },
        },
      } as DesignElement);
    }
  }
  elements.push(...finishElements(sheet, options.design, options.finishes ?? 'screen', options.resources ?? []));
  if (elements.length > 0) template.decoration = { elements };
  return {
    page,
    template,
    resources,
    files,
    slots: frames.map((f) => f.name as CoverZoneName),
    ...(mirror ? { designed: mirror.designed } : {}),
    ...(mirrorSkipped ? { mirrorSkipped } : {}),
    ...(clipSkipped.length > 0 ? { clipSkipped: [...new Set(clipSkipped)] } : {}),
  };
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
