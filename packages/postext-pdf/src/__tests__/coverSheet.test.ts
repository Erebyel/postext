import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PDFArray, PDFDocument, PDFName, PDFNumber, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { buildDocument, coverMarkdown, coverPage, versionSheets } from 'postext';
import type { PostextConfig, ProductionVersion, VersionSheets } from 'postext';
import { renderToPdf } from '../pdf-backend/index.js';
import { parseFontString } from '../fontString.js';

const fontBytes = fs.readFileSync(new URL('../../../../apps/web/public/fonts/Lora-Regular.ttf', import.meta.url));
const fontProvider = async () => new Uint8Array(fontBytes);
const face = fontkit.create(fontBytes);

class StubCtx {
  font = '';
  measureText(s: string): { width: number } {
    const sizePx = parseFontString(this.font)?.sizePx ?? 16;
    return { width: (face.layout(s).advanceWidth / face.unitsPerEm) * sizePx };
  }
}
(globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas = class {
  getContext(): StubCtx {
    return new StubCtx();
  }
};

const MM = 72 / 25.4;
const trim = { width: 150, height: 230 };
// 250 pages of 90 g offset: 256 after rounding to signatures of 16.
const runs = [{ pages: 250, grammage: 90, bulk: 1.25 }];

const text = {
  back: 'Una novela sobre una imprenta que calcula sus propios lomos.',
  spine: 'Autora · El título del libro',
  front: '# El título del libro\n\nAutora',
  flapBack: 'Autora nació en Madrid.',
  flapFront: 'Otros títulos de la colección.',
};

function sheetsOf(version: ProductionVersion): VersionSheets {
  const v = versionSheets(version, trim, runs);
  if (!('cover' in v)) throw new Error('no profile');
  return v;
}

async function render(version: ProductionVersion, which: 'cover' | 'jacket' = 'cover') {
  const v = sheetsOf(version);
  const sheet = which === 'jacket' ? v.jacket! : v.cover;
  const cover = coverPage(sheet, { isbn: version.isbn, spineText: version.spineText });
  const config: PostextConfig = {
    page: { ...cover.page, dpi: 150 },
    header: { elements: [] },
    footer: { elements: [] },
    pageTemplates: [cover.template],
  };
  const doc = buildDocument({ markdown: coverMarkdown('cover', text, cover.slots), resources: cover.resources }, config);
  const bytes = await renderToPdf(doc, { fontProvider, resourceBytes: (id: string) => cover.files[id] });
  if (process.env.COVER_SAMPLE_DIR) {
    fs.writeFileSync(path.join(process.env.COVER_SAMPLE_DIR, `${version.id}-${which}.pdf`), bytes);
  }
  const pdf = await PDFDocument.load(bytes);
  const page = pdf.getPage(0);
  const contents = page.node.Contents();
  const streams = contents instanceof PDFArray ? contents.asArray().map((r) => pdf.context.lookup(r)) : [contents];
  const content = streams
    .map((s) => (s instanceof PDFRawStream ? Buffer.from(decodePDFRawStream(s).decode()).toString('latin1') : ''))
    .join('\n');
  const box = (name: string): number[] => page.node.lookup(PDFName.of(name), PDFArray).asArray().map((n) => (n as PDFNumber).asNumber());
  return { pdf, doc, content, box, sheet, cover, v };
}

/** Every `x1 y1 m x2 y2 l S` line of a content stream, in points. */
function strokedLines(content: string): Array<{ x1: number; y1: number; x2: number; y2: number }> {
  const num = '(-?[\\d.]+)';
  const re = new RegExp(`${num} ${num} m\\s+${num} ${num} l\\s+S`, 'g');
  return [...content.matchAll(re)].map((m) => ({ x1: +m[1]!, y1: +m[2]!, x2: +m[3]!, y2: +m[4]! }));
}

describe('cover sheets as PDF', () => {
  it('makes a paperback with flaps one page, trimmed to the flat cover', async () => {
    const { pdf, box, sheet, doc } = await render({ id: 'rustica', name: 'Rústica', binding: 'perfect', flaps: true, isbn: '978-0-306-40615-7' });
    expect(pdf.getPageCount()).toBe(1);
    const [x0, , x1] = box('TrimBox');
    expect((x1! - x0!) / MM).toBeCloseTo(sheet.trim.width, 1);
    const [bx0, , bx1] = box('BleedBox');
    expect((bx1! - bx0!) / MM).toBeCloseTo(sheet.width, 1);
    expect(doc.contentWarnings?.filter((w) => w.kind === 'frameOverflow' || w.kind === 'frameOutsideArea') ?? []).toEqual([]);
  });

  it('marks each fold and score above and below the sheet', async () => {
    const { content, sheet, box } = await render({ id: 'rustica', name: 'Rústica', binding: 'perfect', flaps: true });
    const [trimLeft] = box('TrimBox');
    const vertical = strokedLines(content).filter((l) => Math.abs(l.x1 - l.x2) < 0.01);
    // Four of the eight crop marks are vertical; then two per fold.
    expect(vertical.length).toBe(4 + 2 * sheet.lines.length);
    for (const line of sheet.lines) {
      const x = trimLeft! + (line.x - sheet.trim.x) * MM;
      expect(vertical.filter((l) => Math.abs(l.x1 - x) < 0.05).length).toBe(2);
    }
  });

  it('draws the barcode and letters the spine', async () => {
    const { content, cover } = await render({ id: 'rustica', name: 'Rústica', binding: 'perfect', isbn: '978-0-306-40615-7' });
    expect(cover.resources.map((r) => r.id)).toEqual(['isbn-barcode']);
    expect(cover.slots).toContain('spine');
    // The spine frame is turned a quarter: a matrix (0 ±1 ∓1 0 …), its
    // zeros as cos 90° comes out (6e-17).
    const quarter = [...content.matchAll(/(\S+) (-?1) (-?1) (\S+) \S+ \S+ cm/g)]
      .filter((m) => Math.abs(+m[1]!) < 1e-9 && Math.abs(+m[4]!) < 1e-9 && +m[2]! === -+m[3]!);
    expect(quarter.length).toBe(1);
  });

  it('makes a case and its jacket from the same block', async () => {
    const version: ProductionVersion = { id: 'carton', name: 'Cartoné', binding: 'case-flat', flaps: true, isbn: '978-0-306-40615-7' };
    const caseSheet = await render(version);
    const jacket = await render(version, 'jacket');
    const [c0, , c1] = caseSheet.box('TrimBox');
    const [j0, , j1] = jacket.box('TrimBox');
    expect(caseSheet.sheet.kind).toBe('case');
    expect(jacket.sheet.kind).toBe('jacket');
    // The jacket has flaps the case has not: it is wider.
    expect(j1! - j0!).toBeGreaterThan(c1! - c0!);
    // The case's bleed is its turn-in.
    const [b0] = caseSheet.box('BleedBox');
    expect((c0! - b0!) / MM).toBeCloseTo(caseSheet.v.measures.turnIn, 1);
  });
});
