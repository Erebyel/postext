import { describe, expect, it } from 'vitest';
import { resolveBindingMeasures, sheetGuides, softcoverSheet } from 'postext';
import { coverIdmlGuides } from './coverIdml.js';

describe('coverIdmlGuides', () => {
  const trim = { width: 150, height: 230 };
  const sheet = softcoverSheet(trim, 20, resolveBindingMeasures({ id: 'x', name: 'X', style: 'perfect' }, trim), true);

  it('gives the sheet’s guides to its one page, folds in magenta and safe areas in cyan', () => {
    const guides = coverIdmlGuides(sheet);
    expect(guides).toHaveLength(sheetGuides(sheet).length);
    expect(guides.every((g) => g.page === 0)).toBe(true);
    const fold = sheetGuides(sheet).findIndex((g) => g.kind === 'fold');
    const safe = sheetGuides(sheet).findIndex((g) => g.kind === 'safe');
    expect(guides[fold]!.color).toBe('Magenta');
    expect(guides[safe]!.color).toBe('Cyan');
  });
});

describe('coverIdmlLayers', () => {
  it('puts each designer layer’s items on an InDesign layer of its own, the mirror locked', async () => {
    class StubCtx {
      font = '';
      measureText(s: string) { return { width: s.length * 7 }; }
    }
    (globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas = class { getContext() { return new StubCtx(); } };
    const { buildDocument, caseSheet, coverMarkdown, coverPage } = await import('postext');
    const { idmlDocument } = await import('postext-idml');
    const { unzipSync, strFromU8 } = await import('fflate');
    const { coverIdmlLayers } = await import('./coverIdml.js');
    const trim = { width: 150, height: 230 };
    const m = resolveBindingMeasures({ id: 'c', name: 'C', style: 'caseFlat' }, trim);
    const ink = (hex: string) => ({ hex, model: 'hex' as const });
    const cover = coverPage(caseSheet(trim, 26, m), {
      mirrorMargin: m.designMargin,
      finishes: 'press',
      design: {
        background: ink('#123456'),
        elements: [{ id: 'dot', kind: 'box', color: ink('#ff0000'), zone: 'front', x: 5, y: 5, width: 10, height: 10 }],
        effects: [{ id: 'veil', kind: 'box', color: ink('#000000'), opacity: 0.4, zone: 'front', x: 0, y: 0, width: 50, height: 20 }],
        finishes: [{ id: 'gloss', kind: 'varnish', ink: 'Barniz UVI', shape: { box: { zone: 'front', x: 20, y: 40, width: 30, height: 20 } } }],
      },
    });
    const doc = buildDocument(
      { markdown: coverMarkdown('cover', { front: 'Título' }, cover.slots), resources: cover.resources },
      { page: { ...cover.page, dpi: 72 }, header: { elements: [] }, footer: { elements: [] }, pageTemplates: [cover.template] },
    );
    const names = { background: 'Fondo', elements: 'Elementos', mirror: 'Espejo', texts: 'Textos', effects: 'Efectos', logos: 'Logos', finishes: 'Acabados' };
    const { bytes } = idmlDocument({ docs: [doc], layers: coverIdmlLayers(names), resourceBytes: (id) => cover.files[id] });
    const files = unzipSync(bytes);
    const map = strFromU8(files['designmap.xml']!);
    const layers = [...map.matchAll(/<Layer Self="([^"]+)" Name="([^"]+)"[^>]*Locked="(true|false)"/g)].map((x) => ({ id: x[1]!, name: x[2]!, locked: x[3] === 'true' }));
    expect(layers.map((l) => l.name)).toEqual(['Fondo', 'Elementos', 'Espejo', 'Textos', 'Efectos', 'Logos', 'Acabados']);
    expect(layers.find((l) => l.name === 'Espejo')!.locked).toBe(true);
    const spread = Object.entries(files).find(([p]) => p.startsWith('Spreads/'))![1];
    const items = [...strFromU8(spread).matchAll(/<(Rectangle|Polygon|TextFrame)\b[^>]*ItemLayer="([^"]+)"/g)].map((x) => layers.find((l) => l.id === x[2])!.name);
    // Under to over: the ground, the element, the mirror, the text, the veil, the varnish.
    expect(new Set(items)).toEqual(new Set(['Fondo', 'Elementos', 'Espejo', 'Textos', 'Efectos', 'Acabados']));
    expect(strFromU8(files['Resources/Graphic.xml']!)).toMatch(/Model="Spot"[^>]*Name="Barniz UVI"/);
  });
});
