/**
 * The cover of the Cover panel on Folio's 3D book: what of it shows on a
 * book lying open on the desk. Its spine, painted from the composed sheet
 * (the best proof that the spine fits); the colour of its boards, taken
 * from the front cover; and its binding (a hardcover, a paperback glued or
 * sewn) and material (a printed case, cloth), which win over what the
 * book's Folio settings guessed.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { BUILT_IN_BINDING_PROFILES, renderPageToCanvas, type BindingProfile, type FolioBindingConfig, type FolioConfig, type ProductionSheet, type ProductionVersion, type VDTDocument } from 'postext';
import { useSandboxLabels, useSandboxSelector } from '../context/SandboxContext.js';
import { ensureConfigFontsLoaded } from '../controls/fonts/fontLoader.js';
import { ensureResourceImages } from '../controls/media/resourceImages.js';
import { useLayoutWorker } from '../worker/useLayoutWorker.js';
import { bookTrimMm, coverDocumentInput, pickSheet } from './bookProduction.js';
import { registerCoverImages } from './coverImages.js';
import { useCoverGallery, useCoverWorkspace, useLogos, useProfiles } from './useProduction.js';

const MM_PER_IN = 25.4;

/** Folio's binding for a version: its style and, on a case, its
 *  material. */
export function folioBindingOf(version: ProductionVersion, library: readonly BindingProfile[]): Pick<FolioBindingConfig, 'type' | 'coverMaterial'> | undefined {
  const id = typeof version.binding === 'string' ? version.binding : version.binding.id;
  const profile = typeof version.binding === 'string'
    ? BUILT_IN_BINDING_PROFILES.find((p) => p.id === id) ?? library.find((p) => p.id === id)
    : version.binding;
  if (!profile) return undefined;
  if (profile.style === 'caseFlat' || profile.style === 'caseRound') return { type: 'hardcover', coverMaterial: version.caseMaterial === 'cloth' ? 'cloth' : 'paper' };
  return { type: profile.style === 'sewnSoftcover' ? 'sewn' : 'paperback', coverMaterial: 'paper' };
}

/** The book's Folio settings with its cover's binding over them: a book
 *  with a version in the Cover panel is bound as that version is (in a
 *  case or a soft cover, of its material, its boards the front cover's
 *  colour), whatever the presentation guessed before; the desk, the light
 *  and the paper stay the book's. Its spine picture, when the settings
 *  name one, too. */
export function folioWithCover(folio: FolioConfig | undefined, cover: { binding?: Pick<FolioBindingConfig, 'type' | 'coverMaterial'>; color?: string } | null): FolioConfig | undefined {
  if (!cover?.binding) return folio;
  const own = folio?.binding ?? {};
  const binding: FolioBindingConfig = {
    ...own,
    ...cover.binding,
    // The cover is drawn as a case round the pages, not as the book's
    // first and last pages.
    cover: 'case',
    ...(cover.color ? { coverColor: { hex: cover.color, model: 'hex' as const } } : {}),
  };
  return { ...folio, binding };
}

/** A sheet's zone as a rectangle of a painted page, px. */
function zonePx(sheet: ProductionSheet, doc: VDTDocument, name: string, scale: number): { x: number; y: number; w: number; h: number } | undefined {
  const zone = sheet.zones.find((z) => z.name === name);
  if (!zone) return undefined;
  const dpi = doc.config.page.dpi ?? 96;
  // The sheet's corner (the bleed's) on the page, which has room for the
  // cut marks round it.
  const offset = (doc.trimOffset * MM_PER_IN) / dpi - sheet.trim.x;
  const k = (dpi / MM_PER_IN) * scale;
  return { x: (zone.rect.x + offset) * k, y: (zone.rect.y + offset) * k, w: zone.rect.width * k, h: zone.rect.height * k };
}

/** The colour most of a painted region is, `#rrggbb`: its pixels' colours
 *  coarsened, the commonest averaged (text and small pictures do not
 *  sway it). */
export function dominantColour(data: Uint8ClampedArray): string | undefined {
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i < data.length; i += 4 * 7) {
    if (data[i + 3]! < 200) continue;
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bin.n++;
    bin.r += r;
    bin.g += g;
    bin.b += b;
    bins.set(key, bin);
  }
  let best: { n: number; r: number; g: number; b: number } | undefined;
  for (const bin of bins.values()) if (!best || bin.n > best.n) best = bin;
  if (!best) return undefined;
  const hex = (v: number) => Math.round(v / best!.n).toString(16).padStart(2, '0');
  return `#${hex(best.r)}${hex(best.g)}${hex(best.b)}`;
}

export interface FolioCover {
  binding?: Pick<FolioBindingConfig, 'type' | 'coverMaterial'>;
  /** The boards' colour: the front cover's commonest. */
  color?: string;
  /** The spine as painted, head up and the front cover to the right. */
  spine?: HTMLCanvasElement;
}

/** The active version's cover for Folio, painted again (a moment after)
 *  when it changes; null when the book has no version yet. */
export function useFolioCover(): FolioCover | null {
  const labels = useSandboxLabels();
  const config = useSandboxSelector((s) => s.config);
  const bookResources = useSandboxSelector((s) => s.resources);
  const { record, version, sheets } = useCoverWorkspace();
  const library = useLogos();
  const [gallery] = useCoverGallery();
  const stored = useProfiles();
  const bindings = useMemo(() => stored.flatMap((p) => (p.kind === 'binding' ? [p.profile] : [])), [stored]);
  const { build } = useLayoutWorker('preview');
  const [painted, setPainted] = useState<{ color?: string; spine?: HTMLCanvasElement } | null>(null);
  const binding = useMemo(() => (version ? folioBindingOf(version, bindings) : undefined), [version, bindings]);
  const sheet = useMemo(() => (sheets ? pickSheet(sheets, 'cover', bookTrimMm(config)) : null), [sheets, config]);
  const input = useMemo(
    () => (sheet && version && record
      ? coverDocumentInput(sheet, version, record.texts, config, record.design, bookResources, { logos: library, gallery, workIsbnLabel: labels.productionWorkIsbnCaption })
      : null),
    [sheet, version, record, config, bookResources, library, gallery, labels.productionWorkIsbnCaption],
  );
  const seq = useRef(0);
  useEffect(() => {
    if (!input || !sheet) {
      setPainted(null);
      return;
    }
    const n = ++seq.current;
    const t = setTimeout(() => {
      void (async () => {
        try {
          await ensureConfigFontsLoaded(input.config, input.markdown);
          await registerCoverImages(input.cover.files);
          await ensureResourceImages(input.resources.filter((r) => r.id !== 'isbn-barcode'));
          const doc = await build({ markdown: input.markdown, resources: input.resources }, input.config);
          const page = doc.pages[0];
          if (!page || n !== seq.current) return;
          // Painted at about 150 dpi: enough for a spine seen on the desk.
          const scale = Math.min(1, 150 / (doc.config.page.dpi ?? 96));
          const full = document.createElement('canvas');
          renderPageToCanvas(page, doc, full, { scale });
          const ctx = full.getContext('2d', { willReadFrequently: true });
          const spineAt = zonePx(sheet, doc, 'spine', scale);
          const frontAt = zonePx(sheet, doc, 'front', scale);
          let spine: HTMLCanvasElement | undefined;
          if (spineAt && spineAt.w >= 1 && spineAt.h >= 1) {
            spine = document.createElement('canvas');
            spine.width = Math.round(spineAt.w);
            spine.height = Math.round(spineAt.h);
            spine.getContext('2d')!.drawImage(full, spineAt.x, spineAt.y, spineAt.w, spineAt.h, 0, 0, spine.width, spine.height);
          }
          const color = ctx && frontAt ? dominantColour(ctx.getImageData(Math.round(frontAt.x), Math.round(frontAt.y), Math.max(1, Math.round(frontAt.w)), Math.max(1, Math.round(frontAt.h))).data) : undefined;
          if (n === seq.current) setPainted({ ...(color ? { color } : {}), ...(spine ? { spine } : {}) });
        } catch {
          if (n === seq.current) setPainted(null);
        }
      })();
    }, 400);
    return () => clearTimeout(t);
  }, [build, input, sheet]);
  return useMemo(() => (version ? { ...(binding ? { binding } : {}), ...painted } : null), [version, binding, painted]);
}
