import { describe, it, expect } from 'vitest';
import { buildDocument } from '../../pipeline/build/drivers.js';
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
import { coverMarkdown, coverPage, resolveBindingMeasures, softcoverSheet } from '../../production/index.js';

describe('a cover with every zone empty', () => {
  it('lays out its page instead of failing on the frames’ box style', () => {
    const m = resolveBindingMeasures({ id: 'x', name: 'X', style: 'perfect' }, { width: 150, height: 230 });
    const cover = coverPage(softcoverSheet({ width: 150, height: 230 }, 20, m, false));
    const doc = buildDocument(
      { markdown: coverMarkdown('cover', {}, cover.slots) },
      { page: { ...cover.page, dpi: 72 }, header: { elements: [] }, footer: { elements: [] }, pageTemplates: [cover.template] },
    );
    expect(doc.pages.length).toBe(1);
  });
});
