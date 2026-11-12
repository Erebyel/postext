import { describe, expect, it } from 'vitest';
import { resolveBodyTextConfig, stripBodyTextDefaults } from '../../defaults/text/bodyText.js';
import { hyphenBreaking } from '../../pipeline/text/hyphenRules.js';
import { collectConfigWarnings } from '../../checks/configWarnings.js';
import { findHyphenFaults, endsOnHyphen } from '../../checks/hyphenRules.js';
import { computeBreakpointsTs } from '../../knuthPlass/breakpoints.js';
import { buildDocument } from '../../pipeline/index.js';
import type { KPItem, KPOptions } from '../../knuthPlass/types.js';
import type { HyphenationConfig, PostextConfig, VDTDocument, VDTLine } from '../../index.js';

// Hyphen spacing (#1466): a hyphenated line with another hyphen among the
// `spacingLines` lines before it, so hyphens fall into a rhythm (one line
// yes, one line no), as a demerit cost in the line breaker.

// Deterministic text measurement stub (no DOM in the node test env): every
// character, the space included, is 7 px wide.
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

const pt = (value: number) => ({ value, unit: 'pt' as const });
const column = (width: number, hyphenation: HyphenationConfig = {}): PostextConfig => ({
  locale: 'es',
  page: { dpi: 72, width: pt(width), height: pt(20000), margins: { top: pt(0), bottom: pt(0), left: pt(0), right: pt(0) } },
  layout: { layoutType: 'single' },
  bodyText: { firstLineIndent: pt(0), textAlign: 'justify', hyphenation },
});
const MD = [
  'Los pacientes con enfermedades musculoesqueléticas crónicas presentan con frecuencia síntomas psicológicos que condicionan la evolución del cuadro clínico. La valoración inicial debe incluir una anamnesis detallada, una exploración física sistemática y la identificación de los factores sociales que pueden influir en la adherencia al tratamiento farmacológico y rehabilitador.',
  'Diversos estudios han demostrado que la intervención multidisciplinaria, coordinada entre el médico de atención primaria, el fisioterapeuta y el psicólogo, mejora significativamente la calidad de vida y reduce el consumo de analgésicos. Sin embargo, todavía existen importantes diferencias entre los distintos sistemas sanitarios en cuanto a la disponibilidad de estos recursos y a los tiempos de espera.',
  'El abordaje del dolor crónico exige considerar tanto los mecanismos fisiopatológicos subyacentes como las características psicosociales del paciente. La educación terapéutica, el ejercicio supervisado y las técnicas cognitivo-conductuales constituyen los pilares fundamentales del tratamiento, mientras que la farmacoterapia debe individualizarse según la intensidad del dolor y las comorbilidades asociadas.',
  'Entre las complicaciones más frecuentes destacan la desmineralización ósea, la sarcopenia, las alteraciones del sueño y los trastornos depresivos, que a su vez empeoran la percepción del dolor y favorecen la discapacidad. Por ello, la detección precoz de estas alteraciones y su tratamiento específico deberían formar parte de cualquier protocolo asistencial actualizado.',
].join('\n\n');
const WIDTHS = [150, 164, 178, 192, 206, 220, 234, 248];

const lineTexts = (doc: VDTDocument): string[] => doc.blocks.flatMap((b) => b.lines.map((l) => l.text));
const paragraphsOf = (doc: VDTDocument): VDTLine[][] => doc.blocks.filter((b) => b.type === 'paragraph').map((b) => b.lines);
/** Hyphens with another one among the `within` lines before them. */
const close = (doc: VDTDocument, within: number): number => {
  let n = 0;
  for (const lines of paragraphsOf(doc)) {
    let since = Infinity;
    for (const l of lines) {
      if (endsOnHyphen(l)) {
        if (since < within) n++;
        since = 0;
      } else since++;
    }
  }
  return n;
};
/** Hyphens one line apart: yes, no, yes. */
const alternations = (doc: VDTDocument): number =>
  paragraphsOf(doc).reduce((n, ls) => n + ls.filter((l, k) => k > 1 && endsOnHyphen(l) && endsOnHyphen(ls[k - 2]!) && !endsOnHyphen(ls[k - 1]!)).length, 0);
const total = (f: (w: number) => number): number => WIDTHS.reduce((sum, w) => sum + f(w), 0);
const ofKind = (doc: VDTDocument, kind: string) => (doc.contentWarnings ?? []).filter((w) => w.kind === kind);

describe('hyphen spacing settings', () => {
  it('are off by default and hand the line breaker nothing', () => {
    const h = resolveBodyTextConfig().hyphenation;
    expect(h).toMatchObject({ spacing: 'allow', spacingLines: 2, spacingPenalty: 10000 });
    expect(hyphenBreaking(h)).toEqual({});
    expect(hyphenBreaking(resolveBodyTextConfig({ hyphenation: { spacing: 'warn' } }).hyphenation)).toEqual({});
    expect(hyphenBreaking(resolveBodyTextConfig({ hyphenation: { spacing: 'avoid', spacingPenalty: 0 } }).hyphenation)).toEqual({});
    expect(hyphenBreaking(resolveBodyTextConfig({ hyphenation: { spacing: 'avoid', spacingLines: 3.4 } }).hyphenation))
      .toEqual({ hyphenSpacing: { lines: 3, demerits: 10000 } });
  });

  it('are clamped, compared and stripped as hyphenation settings', () => {
    expect(resolveBodyTextConfig({ hyphenation: { spacingLines: 0, spacingPenalty: -5 } }).hyphenation).toMatchObject({ spacingLines: 1, spacingPenalty: 0 });
    expect(resolveBodyTextConfig({ hyphenation: { spacingLines: 40 } }).hyphenation.spacingLines).toBe(10);
    expect(stripBodyTextDefaults({ hyphenation: { spacing: 'allow', spacingLines: 2, spacingPenalty: 10000 } })).toBeUndefined();
    expect(stripBodyTextDefaults({ hyphenation: { spacing: 'avoid' } })).toEqual({ hyphenation: { spacing: 'avoid' } });
  });

  it('read an unknown level as allow, with a warning', () => {
    expect(resolveBodyTextConfig({ hyphenation: { spacing: 'never' as 'avoid' } }).hyphenation.spacing).toBe('allow');
    expect(collectConfigWarnings({ bodyText: { hyphenation: { spacing: 'never' as 'avoid' } } })).toContainEqual({
      kind: 'unknownConfigValue', path: 'bodyText.hyphenation.spacing', value: 'never', used: 'allow',
    });
  });
});

describe('hyphen spacing in the layout', () => {
  it("leaves the lines as they were under 'warn', and reports each run", () => {
    let reported = 0;
    for (const w of WIDTHS) {
      const plain = buildDocument({ markdown: MD }, column(w));
      const warn = buildDocument({ markdown: MD }, column(w, { spacing: 'warn' }));
      expect(lineTexts(warn), `${w}`).toEqual(lineTexts(plain));
      expect(ofKind(plain, 'hyphenSpacing')).toEqual([]);
      const found = ofKind(warn, 'hyphenSpacing');
      expect(found.length, `${w}`).toBe(findHyphenFaults(warn).length);
      // Each run counts its hyphens and spans its lines.
      for (const f of found) {
        const run = f as { hyphens: number; lines: number; max: number; text: string[] };
        expect(run.max).toBe(2);
        expect(run.hyphens).toBeGreaterThan(1);
        expect(run.text.length).toBe(run.lines);
      }
      reported += found.length;
    }
    expect(reported).toBeGreaterThan(0);
  });

  it("breaks the yes-no-yes rhythm under 'avoid' where the word spacing allows", () => {
    const before = total((w) => alternations(buildDocument({ markdown: MD }, column(w))));
    const after = total((w) => alternations(buildDocument({ markdown: MD }, column(w, { spacing: 'avoid' }))));
    expect(before).toBeGreaterThan(0);
    expect(after).toBeLessThan(before);
    const closeBefore = total((w) => close(buildDocument({ markdown: MD }, column(w)), 2));
    const closeAfter = total((w) => close(buildDocument({ markdown: MD }, column(w, { spacing: 'avoid' })), 2));
    expect(closeAfter).toBeLessThan(closeBefore);
  });

  it('sets the paragraphs as before when it costs nothing', () => {
    for (const w of WIDTHS) {
      const plain = lineTexts(buildDocument({ markdown: MD }, column(w)));
      expect(lineTexts(buildDocument({ markdown: MD }, column(w, { spacing: 'avoid', spacingPenalty: 0 }))), `${w}`).toEqual(plain);
    }
  });
});

describe('hyphen spacing in the line breaker', () => {
  // Fourteen words of 30–44 px, each with a hyphen point (5 px) in the
  // middle, and spaces of 10 px (stretch 10, shrink 3), set on 115 px.
  const items: KPItem[] = [];
  for (let w = 0; w < 14; w++) {
    items.push({ type: 'box', width: 15 + (w % 3) * 4, sourceIndex: w });
    items.push({ type: 'penalty', width: 5, penalty: 50, flagged: true, sourceIndex: w });
    items.push({ type: 'box', width: 15 + (w % 2) * 6, sourceIndex: w });
    if (w < 13) items.push({ type: 'glue', width: 10, stretch: 10, shrink: 3, sourceIndex: w });
  }
  items.push({ type: 'glue', width: 0, stretch: 1e6, shrink: 0, sourceIndex: -1 });
  items.push({ type: 'penalty', width: 0, penalty: -10000, flagged: false, sourceIndex: -1 });
  const base: KPOptions = { lineWidth: () => 115, normalSpaceWidth: 10, maxStretchRatio: 2, minShrinkRatio: 0.7 };
  /** The lines' ends: H a hyphen, . a whole word. */
  const ends = (breaks: number[]) => breaks.map((b) => (items[b]!.type === 'penalty' && (items[b] as { flagged: boolean }).flagged ? 'H' : '.')).join('');

  it('costs a hyphen within the window, so a dear enough rule keeps them apart', () => {
    expect(ends(computeBreakpointsTs(items, base))).toBe('H.H.H.');
    // Keeping them apart here takes lines stretched past the limit: only a
    // cost dearer than those does it.
    expect(ends(computeBreakpointsTs(items, { ...base, hyphenSpacing: { lines: 2, demerits: 1e6 } }))).toBe('H.H.H.');
    expect(ends(computeBreakpointsTs(items, { ...base, hyphenSpacing: { lines: 2, demerits: 1e9 } }))).toBe('H..H..');
    expect(ends(computeBreakpointsTs(items, { ...base, hyphenSpacing: { lines: 3, demerits: 1e9 } }))).toBe('H...H.');
    // A window of one line is two hyphens in a row, which this paragraph has not.
    expect(ends(computeBreakpointsTs(items, { ...base, hyphenSpacing: { lines: 1, demerits: 1e9 } }))).toBe('H.H.H.');
  });

  it('changes nothing when it costs nothing', () => {
    expect(computeBreakpointsTs(items, { ...base, hyphenSpacing: { lines: 2, demerits: 0 } })).toEqual(computeBreakpointsTs(items, base));
  });
});
