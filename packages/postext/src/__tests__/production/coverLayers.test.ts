import { describe, it, expect } from 'vitest';
class StubCtx {
  font = '';
  measureText(s: string): { width: number } {
    return { width: s.length * 7 };
  }
}
(globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas = class {
  getContext(): StubCtx {
    return new StubCtx();
  }
};
import { buildDocument } from '../../pipeline/build/drivers.js';
import { composedPaintOrder, decorationOver } from '../../composed/paint.js';
import { coverMarkdown, coverPage, resolveBindingMeasures, softcoverSheet, type CoverDesign } from '../../production/index.js';
import type { Resource } from '../../types.js';

const trim = { width: 150, height: 230 };
const m = resolveBindingMeasures({ id: 'x', name: 'X', style: 'perfect' }, trim);
const sheet = softcoverSheet(trim, 20, m, false);
const ink = (hex: string) => ({ hex, model: 'hex' as const });
const logo: Resource = {
  id: 'seal', typeId: 'figure', kind: 'bitmap', createdAt: 0, updatedAt: 0,
  bitmap: { fileId: 'seal.png', format: 'png', width: 200, height: 100 },
  contour: { points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }] },
};
const design: CoverDesign = {
  background: ink('#123456'),
  effects: [{ id: 'veil', kind: 'box', color: ink('#000000'), opacity: 0.5, zone: 'front', x: 0, y: 0, width: 150, height: 40 }],
  logos: [{ id: 'pub', kind: 'image', resourceId: 'seal', zone: 'front', x: 10, y: 200, width: 40, height: 20, clearance: 4 }],
  finishes: [
    { id: 'gloss', kind: 'varnish', ink: 'Barniz UVI', shape: { box: { zone: 'front', x: 20, y: 20, width: 50, height: 30 } } },
    { id: 'gold', kind: 'foilGold', ink: 'Oro', shape: { element: 'pub' } },
  ],
};

function ids(cover: ReturnType<typeof coverPage>): string[] {
  return (cover.template.decoration?.elements ?? []).map((e) => ('id' in e ? e.id : ''));
}

describe('cover layers over the text', () => {
  it('stacks the grounds under the text and the effects, logos, barcode and finishes over it', () => {
    const cover = coverPage(sheet, { design, isbn: '978-0-306-40615-7', resources: [logo] });
    expect(ids(cover)).toEqual(['cover-ground', 'cover-fx-veil', 'cover-logo-pub', 'isbn-barcode', 'cover-finish-gloss', 'cover-finish-gold']);
    const over = (cover.template.decoration!.elements as { id: string; over?: boolean }[]).filter((e) => e.over).map((e) => e.id);
    expect(over).toEqual(['cover-fx-veil', 'cover-logo-pub', 'isbn-barcode', 'cover-finish-gloss', 'cover-finish-gold']);
  });

  it('draws a translucent box at its opacity, and a finish translucent on screen', () => {
    const els = coverPage(sheet, { design, resources: [logo] }).template.decoration!.elements as { id: string; style?: { backgroundColor?: { hex: string } }; fill?: { hex: string } }[];
    expect(els.find((e) => e.id === 'cover-fx-veil')!.style!.backgroundColor!.hex).toBe('#00000080');
    expect(els.find((e) => e.id === 'cover-finish-gloss')!.style!.backgroundColor!.hex).toMatch(/^#[0-9a-f]{6}73$/);
  });

  it('makes each finish a solid, overprinting spot plate for the press, a logo’s in its contour', () => {
    const els = coverPage(sheet, { design, resources: [logo], finishes: 'press' }).template.decoration!.elements as {
      id: string; kind: string; d?: string; style?: { backgroundColor?: { model: string; spot?: { name: string; overprint?: boolean; tint?: number } } }; fill?: { model: string; spot?: { name: string; overprint?: boolean } };
    }[];
    const gloss = els.find((e) => e.id === 'cover-finish-gloss')!;
    expect(gloss.style!.backgroundColor).toMatchObject({ model: 'spot', spot: { name: 'Barniz UVI', overprint: true, tint: 100 } });
    const gold = els.find((e) => e.id === 'cover-finish-gold')!;
    expect(gold.kind).toBe('path');
    expect(gold.d).toBe('M 0 0 L 1 0 L 0.5 1 Z');
    expect(gold.fill).toMatchObject({ model: 'spot', spot: { name: 'Oro', overprint: true } });
  });

  it('paints those blocks after every frame of the page', () => {
    const cover = coverPage(sheet, { design });
    const doc = buildDocument(
      { markdown: coverMarkdown('cover', { front: 'Título' }, cover.slots) },
      { page: { ...cover.page, dpi: 72 }, header: { elements: [] }, footer: { elements: [] }, pageTemplates: [cover.template] },
    );
    const page = doc.pages[0]!;
    const order = composedPaintOrder(page).map((i) => i.kind);
    expect(order[order.length - 1]).toBe('over');
    expect(order.indexOf('decoration')).toBeLessThan(order.indexOf('frame'));
    // The veil, the varnish and the gold (a box: the logo's picture is not
    // in this document, so it has no contour to take).
    const over = decorationOver(page.composed!.decoration)!.blocks.map((b) => b.kind);
    expect(over).toEqual(['box', 'box', 'box']);
  });
});

describe('finish inks', () => {
  it('gives each ink a screen colour of its own, so plates of one kind stay apart', () => {
    const two: CoverDesign = {
      finishes: [
        { id: 'a', kind: 'varnish', ink: 'Barniz brillo', shape: { box: { zone: 'front', x: 0, y: 0, width: 10, height: 10 } } },
        { id: 'b', kind: 'varnish', ink: 'Barniz mate', shape: { box: { zone: 'front', x: 20, y: 0, width: 10, height: 10 } } },
      ],
    };
    const els = coverPage(sheet, { design: two, finishes: 'press' }).template.decoration!.elements as { style: { backgroundColor: { hex: string } } }[];
    const [a, b] = els.map((e) => e.style.backgroundColor.hex);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^#[0-9a-f]{6}$/);
  });
});
