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
