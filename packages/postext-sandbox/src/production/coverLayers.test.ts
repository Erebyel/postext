import { describe, expect, it } from 'vitest';
import { resolveBindingMeasures, softcoverSheet, type Resource } from 'postext';
import {
  coverElementIssues,
  designShowing,
  elementAt,
  elementRect,
  elementUnder,
  newElement,
  readCoverElements,
  restack,
  type CoverElementSetting,
} from './coverLayers.js';
import { coverDocumentInput } from './bookProduction.js';

const trim = { width: 150, height: 230 };
const sheet = softcoverSheet(trim, 20, resolveBindingMeasures({ id: 'x', name: 'X', style: 'perfect' }, trim), false);
const box = (id: string, over: Partial<CoverElementSetting> = {}): CoverElementSetting => ({ id, kind: 'box', color: '#ff0000', zone: 'front', x: 10, y: 10, width: 20, height: 20, ...over });
const picture = { id: 'pic', kind: 'bitmap', typeId: 'figure', createdAt: 0, updatedAt: 0, bitmap: { fileId: 'f', width: 400, height: 200 } } as unknown as Resource;

describe('cover layers', () => {
  it('reads only the elements that hold together', () => {
    expect(readCoverElements([box('a'), { ...box('b'), zone: 'nowhere' }, { ...box('c'), width: 0 }, { ...box('d'), color: 'red' }, { id: 'e', kind: 'image', zone: 'front', x: 0, y: 0, width: 1, height: 1 }])).toEqual([box('a')]);
  });

  it('starts a picture in the middle of the front cover at its proportions', () => {
    const el = newElement(sheet, 'image', picture)!;
    expect(el.width / el.height).toBeCloseTo(2, 2);
    const front = sheet.zones.find((z) => z.name === 'front')!.rect;
    const r = elementRect(sheet, el)!;
    expect(r.x + r.width / 2).toBeCloseTo(front.x + front.width / 2, 1);
  });

  it('moves an element onto the back cover and keeps it there by that zone', () => {
    const back = sheet.zones.find((z) => z.name === 'back')!.rect;
    const moved = elementAt(sheet, box('a'), { x: back.x + 3, y: back.y + 4, width: 20, height: 20 });
    expect(moved).toMatchObject({ zone: 'back', x: 3, y: 4, color: '#ff0000' });
  });

  it('picks the front-most element under the pointer, and restacks', () => {
    const r = elementRect(sheet, box('a'))!;
    expect(elementUnder(sheet, [box('a'), box('b')], r.x + 1, r.y + 1)?.id).toBe('b');
    expect(restack([box('a'), box('b')], 'a', 1).map((e) => e.id)).toEqual(['b', 'a']);
    expect(restack([box('a'), box('b')], 'b', 1).map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('flags an element off the sheet and a picture the book has lost', () => {
    const issues = coverElementIssues(sheet, [box('a', { x: 5000 }), { ...box('b'), kind: 'image', resourceId: 'gone' }], []);
    expect(issues).toEqual([{ id: 'a', kind: 'offSheet' }, { id: 'b', kind: 'missingPicture' }]);
  });

  it('leaves a hidden layer out of the sheet', () => {
    const design = { background: '#000000', elements: [box('a')] };
    expect(designShowing(design, new Set(['background']))).toEqual({ elements: [box('a')] });
    const config = { page: { width: { value: 150, unit: 'mm' }, height: { value: 230, unit: 'mm' } } } as never;
    const version = { id: 'v', name: 'V', binding: 'perfect' } as never;
    const shown = coverDocumentInput(sheet, version, { front: '# Title' }, config, design);
    const hidden = coverDocumentInput(sheet, version, { front: '# Title' }, config, design, [], { hidden: new Set(['elements', 'texts']) });
    expect(shown.cover.template.decoration!.elements.map((e) => e.id)).toContain('cover-el-a');
    expect(hidden.cover.template.decoration!.elements.map((e) => e.id)).not.toContain('cover-el-a');
    expect(shown.markdown).toContain('Title');
    expect(hidden.markdown).not.toContain('Title');
  });
});
