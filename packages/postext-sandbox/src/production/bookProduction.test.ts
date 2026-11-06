import { describe, it, expect } from 'vitest';
import type { PostextConfig } from 'postext';
import {
  bookRuns,
  bookTrimMm,
  coverDocumentInput,
  dimensionMm,
  metadataIsbn,
  metadataTexts,
  newVersion,
  pickSheet,
  planPageCount,
  readBookProduction,
  sheetChoices,
  sheetFileName,
  sheetsOf,
} from './bookProduction.js';

const mm = (value: number) => ({ value, unit: 'mm' as const });
const config: PostextConfig = { page: { sizePreset: 'custom', width: mm(150), height: mm(230) }, folio: { paper: { grammage: 80, bulk: 1.5 } } };

describe('book production', () => {
  it('measures the trim in mm whatever the unit', () => {
    expect(bookTrimMm(config)).toEqual({ width: 150, height: 230 });
    expect(dimensionMm({ value: 1, unit: 'in' }, 300)).toBeCloseTo(25.4, 6);
    expect(dimensionMm({ value: 72, unit: 'pt' }, 300)).toBeCloseTo(25.4, 6);
    expect(dimensionMm({ value: 300, unit: 'px' }, 300)).toBeCloseTo(25.4, 6);
  });

  it('counts the pages of the plan and puts them on the book paper', () => {
    expect(planPageCount({ a: { pageIndex: 0, pageCount: 12 }, b: { pageIndex: 12, pageCount: 230 } })).toBe(242);
    expect(bookRuns(242, config)).toEqual([{ pages: 242, grammage: 80, bulk: 1.5 }]);
    expect(bookRuns(0, config)).toEqual([]);
  });

  it('gives a paperback a cover and a hardcover its case, jacket and endpapers', () => {
    const paper = sheetsOf(newVersion('paperback', 'Rústica'), config, 242, []);
    const hard = sheetsOf({ ...newVersion('hardcover', 'Cartoné'), flaps: true }, config, 242, []);
    if (!('cover' in paper) || !('cover' in hard)) throw new Error('no profile');
    expect(sheetChoices(paper)).toEqual(['cover']);
    expect(sheetChoices(hard)).toEqual(['cover', 'jacket', 'endpaperFront', 'endpaperBack']);
    expect(pickSheet(hard, 'jacket').kind).toBe('jacket');
    // 256 pages after rounding to 16: 128 leaves of 120 µm, plus 0.5 mm.
    expect(paper.spine.used).toBeCloseTo(128 * 0.12 + 0.5, 6);
  });

  it('lays a sheet out with the book design and the cover texts', () => {
    const version = { ...newVersion('paperback', 'Rústica'), isbn: '978-0-306-40615-7' };
    const sheets = sheetsOf(version, { ...config, page: { ...config.page, dpi: 150 } }, 242, []);
    if (!('cover' in sheets)) throw new Error('no profile');
    const input = coverDocumentInput(sheets.cover, version, { front: '# Título', back: 'Sinopsis' }, { ...config, page: { ...config.page, dpi: 150 } });
    expect(input.config.page?.width).toEqual(input.cover.page.width);
    expect(input.config.page?.dpi).toBe(150);
    expect(input.config.pageTemplates?.[0]?.id).toBe('production-sheet');
    expect(input.markdown).toContain(':::frame{slot="front"}');
    expect(input.markdown).toContain(':::frame{slot="back"}');
    expect(input.cover.resources.length).toBe(1);
  });

  it('puts no text and no barcode on an endpaper', () => {
    const version = { ...newVersion('hardcover', 'Cartoné'), isbn: '978-0-306-40615-7' };
    const sheets = sheetsOf(version, config, 242, []);
    if (!('cover' in sheets)) throw new Error('no profile');
    const input = coverDocumentInput(pickSheet(sheets, 'endpaperFront'), version, { front: 'X' }, config);
    expect(input.markdown).not.toContain(':::frame');
    expect(input.cover.resources).toEqual([]);
  });

  it('names the file after the book, the version and the sheet', () => {
    expect(sheetFileName('El título', 'Cartoné', 'jacket')).toBe('El-título-Cartoné-jacket.pdf');
  });

  it('reads a stored record, leaving out what does not read', () => {
    expect(readBookProduction(null)).toBeNull();
    const read = readBookProduction({
      projectId: 'p',
      versions: [{ id: 'a', name: 'A', binding: 'perfect' }, { id: 'b' }],
      activeVersionId: 'b',
      texts: { front: 'F', back: 3 },
      updatedAt: 5,
    });
    expect(read).toEqual({ projectId: 'p', versions: [{ id: 'a', name: 'A', binding: 'perfect' }], texts: { front: 'F' }, updatedAt: 5 });
  });

  it('takes the cover and spine texts and the ISBN from the book metadata', () => {
    expect(metadataTexts({ title: 'El oficio', subtitle: 'Una guía', author: 'Reyes' })).toEqual({
      front: '# El oficio\n\nUna guía\n\nReyes',
      spine: 'Reyes · El oficio',
    });
    expect(metadataTexts({ title: 'Solo título' })).toEqual({ front: '# Solo título', spine: 'Solo título' });
    expect(metadataTexts({ author: 'Sin título' })).toEqual({});
    expect(metadataIsbn({ isbn: ' 978-84-00000-00-4 ' })).toBe('978-84-00000-00-4');
    expect(metadataIsbn({})).toBeUndefined();
  });
});
