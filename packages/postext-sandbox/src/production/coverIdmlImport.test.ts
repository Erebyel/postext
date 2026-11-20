import { describe, expect, it } from 'vitest';
import { basicShape, caseSheet, resolveBindingMeasures, type ProductionSheet } from 'postext';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { coverDocumentInput, newVersion, type CoverDesignSettings } from './bookProduction.js';
import { elementRect } from './coverLayers.js';
import { coverIdmlLayers, type CoverLayerNames } from './coverIdml.js';
import { importCoverIdml } from './coverIdmlImport.js';
import { designParts, templateFromDesign } from './coverTemplates.js';
import type { LogoRecord } from './logoLibrary.js';

class StubCtx {
  font = '';
  measureText(s: string) { return { width: s.length * 7 }; }
}
(globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas = class { getContext() { return new StubCtx(); } };

const names: CoverLayerNames = { background: 'Fondo', elements: 'Elementos', mirror: 'Espejo', texts: 'Textos', effects: 'Efectos', logos: 'Logos', finishes: 'Acabados' };
const trim = { width: 150, height: 230 };
const sheet: ProductionSheet = caseSheet(trim, 26, resolveBindingMeasures({ id: 'c', name: 'C', style: 'caseFlat' }, trim));
const version = { ...newVersion('hardcover', 'Cartoné') };

const design = (dotX: number): CoverDesignSettings => ({
  background: '#123456',
  elements: [
    { id: 'dot', kind: 'box', color: '#ff0000', zone: 'front', x: dotX, y: 20, width: 30, height: 30 },
    { id: 'star', kind: 'shape', color: '#00ff00', path: basicShape('star'), zone: 'back', x: 10, y: 10, width: 40, height: 40 },
  ],
  effects: [{ id: 'veil', kind: 'box', color: '#000000', opacity: 0.4, zone: 'front', x: 0, y: 0, width: 50, height: 20 }],
  finishes: [{ id: 'gloss', kind: 'varnish', ink: 'Barniz UVI', shape: { box: { zone: 'front', x: 20, y: 80, width: 30, height: 20 } } }],
});

/** The cover of `d` and `texts` as the designer sends it to InDesign. */
async function exported(d: CoverDesignSettings, texts: Record<string, string>, logos: LogoRecord[] = []): Promise<Uint8Array> {
  const { buildDocument } = await import('postext');
  const { idmlDocument } = await import('postext-idml');
  const input = coverDocumentInput(sheet, version, texts, { page: { dpi: 72 } }, d, [], { press: true, logos });
  const doc = buildDocument({ markdown: input.markdown, resources: input.resources }, input.config);
  return idmlDocument({ docs: [doc], layers: coverIdmlLayers(names), nameItems: true, resourceBytes: (id) => input.cover.files[id] }).bytes;
}

/** An IDML edited as InDesign would: `edit` on its spread's XML. */
function edited(bytes: Uint8Array, edit: (spread: string) => string): Uint8Array {
  const files = unzipSync(bytes);
  const path = Object.keys(files).find((p) => p.startsWith('Spreads/'))!;
  files[path] = strToU8(edit(strFromU8(files[path]!)));
  return zipSync(files);
}

describe('a cover back from InDesign', () => {
  const texts = { front: '# El título\n\nAutora', spine: 'Autora · Título' };

  it('comes back as it went', async () => {
    const d = design(40);
    const back = importCoverIdml(await exported(d, texts), { sheet, design: d, texts, layerNames: names });
    expect(back.report.added).toEqual([]);
    expect(back.report.missing).toEqual([]);
    expect(back.report.texts).toEqual([]);
    const before = elementRect(sheet, d.elements![0]!)!;
    const after = elementRect(sheet, back.design.elements![0]!)!;
    for (const k of ['x', 'y', 'width', 'height'] as const) expect(after[k]).toBeCloseTo(before[k], 1);
    expect(back.design.elements![1]!.path).toEqual(d.elements![1]!.path);
    expect(back.design.effects![0]!.opacity).toBeCloseTo(0.4);
    expect(back.design.background).toBe('#123456');
  });

  it('takes what InDesign moved, the texts it changed, and what was added there', async () => {
    const moved = await exported(design(70), { ...texts, front: '# Otro título\n\nAutora' });
    // A finish drawn in InDesign: an item with no name of the design's,
    // on the finishes' layer, in the varnish's spot ink.
    const idml = edited(moved, (xml) => xml.replace(/Name="cover-finish-gloss"/, 'Name="Brillo nuevo"'));
    const d = design(40);
    const back = importCoverIdml(idml, { sheet, design: d, texts, layerNames: names });
    const dot = elementRect(sheet, back.design.elements!.find((e) => e.id === 'dot')!)!;
    const want = elementRect(sheet, design(70).elements![0]!)!;
    expect(dot.x).toBeCloseTo(want.x, 1);
    expect(back.report.updated).toContain('cover-el-dot');
    // The text, its heading kept.
    expect(back.texts.front).toBe('# Otro título\n\nAutora');
    expect(back.report.texts).toEqual(['front']);
    // The renamed varnish is new; the old one is missing and kept.
    const added = back.design.finishes!.find((f) => f.name === 'Brillo nuevo')!;
    expect(added).toMatchObject({ kind: 'varnish', ink: 'Barniz UVI' });
    expect(back.report.missing).toEqual(['gloss']);
    expect(back.design.finishes!.some((f) => f.id === 'gloss')).toBe(true);
  });

  it('leaves out a picture whose linked file is not given, and says which', async () => {
    const d = design(40);
    const idml = edited(await exported(d, texts), (xml) => xml.replace('</Spread>',
      '<Rectangle Self="new1" ContentType="GraphicType" ItemTransform="1 0 0 1 0 0"><Properties><PathGeometry><GeometryPathType PathOpen="false"><PathPointArray>'
      + '<PathPointType Anchor="10 -100" LeftDirection="10 -100" RightDirection="10 -100"/><PathPointType Anchor="10 -50" LeftDirection="10 -50" RightDirection="10 -50"/>'
      + '<PathPointType Anchor="60 -50" LeftDirection="60 -50" RightDirection="60 -50"/><PathPointType Anchor="60 -100" LeftDirection="60 -100" RightDirection="60 -100"/>'
      + '</PathPointArray></GeometryPathType></PathGeometry></Properties>'
      + '<Image Self="img1" ItemTransform="1 0 0 1 10 -100"><Properties><GraphicBounds Left="0" Top="0" Right="50" Bottom="50"/></Properties><Link Self="l1" LinkResourceURI="file:///Links/foto.jpg" StoredState="Normal"/></Image></Rectangle></Spread>'));
    const back = importCoverIdml(idml, { sheet, design: d, texts, layerNames: names });
    expect(back.report.links).toEqual(['foto.jpg']);
    expect(back.pictures).toEqual([]);
    // Given the file, it comes in as a picture of the gallery.
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    const withFile = importCoverIdml(idml, { sheet, design: d, texts, layerNames: names, links: new Map([['foto.jpg', jpeg]]) });
    expect(withFile.pictures).toHaveLength(1);
    expect(withFile.design.elements!.some((e) => e.resourceId === `cover:${withFile.pictures[0]!.id}`)).toBe(true);
  });

  it('reads a cover made elsewhere by what its items are and where they stand, fitted to the sheet', async () => {
    const d = design(40);
    // No name of the design's on any item: a cover made in InDesign.
    const foreign = edited(await exported(d, texts), (xml) => xml.replace(/ Name="[^"]*"/g, ''));
    // Onto a thicker book: the spine and the sheet are wider.
    const thick = caseSheet(trim, 40, resolveBindingMeasures({ id: 'c', name: 'C', style: 'caseFlat' }, trim));
    const back = importCoverIdml(foreign, { sheet: thick, design: undefined, texts: {}, layerNames: names });
    expect(back.report.generic!.from![0]).toBeCloseTo(sheet.trim.width, 0);
    expect(back.report.generic!.to![0]).toBeCloseTo(thick.trim.width, 0);
    // The box over the whole sheet is its ground.
    expect(back.design.background).toBe('#123456');
    // The varnish, a spot ink that overprints, is a finish.
    expect(back.design.finishes).toHaveLength(1);
    expect(back.design.finishes![0]).toMatchObject({ kind: 'varnish', ink: 'Barniz UVI' });
    // The red box and the star are elements, the star with its curves.
    const red = back.design.elements!.find((e) => e.color === '#ff0000')!;
    expect(red.kind).toBe('box');
    expect(back.design.elements!.find((e) => e.kind === 'shape')!.path![0]!.nodes).toHaveLength(10);
    // The texts by the zone their frames stand in.
    expect(back.texts.front).toBe('El título\n\nAutora');
    expect(back.texts.spine).toBe('Autora · Título');
    expect(back.report.missing).toEqual([]);
  });

  it('saves a cover made elsewhere as a template: its logos the library’s, its type by zone', async () => {
    const seal: LogoRecord = { id: 'seal', name: 'Sello', group: 'publisher', clearance: 4, mime: 'image/svg+xml', bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'), width: 10, height: 10, updatedAt: 1 };
    const d: CoverDesignSettings = {
      ...design(40),
      zoneStyles: { front: { title: { fontSize: 30 } } },
      logos: [{ id: 'l1', kind: 'image', logoId: 'seal', resourceId: 'logo:seal', zone: 'back', x: 10, y: 10, width: 20, height: 20, clearance: 4 }],
    };
    const foreign = edited(await exported(d, texts, [seal]), (xml) => xml.replace(/ Name="[^"]*"/g, ''));
    const back = importCoverIdml(foreign, { sheet, design: undefined, texts: {}, layerNames: names, library: [seal] });
    // The picture linked as the library's file is that logo, with its clear space.
    expect(back.design.logos).toHaveLength(1);
    expect(back.design.logos![0]).toMatchObject({ logoId: 'seal', clearance: 4 });
    // The type: the front's title at its size, as InDesign sets it.
    expect(back.design.zoneStyles?.front?.title?.fontSize).toBeCloseTo(30, 0);
    expect(back.design.textColor).toBeDefined();
    const template = templateFromDesign(back.design, designParts(back.design), { gallery: { projectId: '', pictures: back.pictures, traces: [] }, logos: [seal] }, 'De InDesign');
    expect(template.parts).toEqual(['background', 'elements', 'texts', 'effects', 'logos', 'finishes']);
    expect(template.logos.map((l) => l.id)).toEqual(['seal']);
  });
});
