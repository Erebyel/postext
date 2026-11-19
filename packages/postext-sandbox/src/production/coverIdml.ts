// A production sheet as an InDesign package, for the printer who adjusts
// the cover by hand: the sheet laid out as the PDF is, its text left to
// InDesign's composer, its folds, scores, joints and safe areas as ruler
// guides on a layer of their own, the barcode as a vector PDF (an SVG
// places only in recent InDesign), and the pictures and fonts beside it.

import type { Labels } from './productionUi.js';
import {
  BARCODE_PDF_FILE_ID,
  BARCODE_RESOURCE_ID,
  MIRROR_RESOURCE_ID,
  buildDocument,
  resolvePrintConfig,
  sheetGuides,
  type PostextConfig,
  type ProductionSheet,
  type Resource,
  type SheetGuide,
  type VDTDocument,
} from 'postext';
import type { IdmlExportLayer, IdmlRulerGuide, IdmlWarning } from 'postext-idml';
import { createPdfWorker } from 'postext-pdf/worker';
import { ensureConfigFontsLoaded } from '../controls/fonts/fontLoader.js';
import { ensureResourceImages } from '../controls/media/resourceImages.js';
import { buildIdmlExport, type IdmlExport } from '../idml/idmlExport.js';
import { idmlFontWithheld, sandboxIdmlFaces } from '../idml/idmlFonts.js';
import { loadPrintProfile, outputProfileBaseUrl } from '../print/printSetup.js';
import { createPdfFontProvider } from '../viewport/pdf/pdfFontProvider.js';
import { buildPdfResourceBytes } from '../viewport/pdf/pdfResourceBytes.js';
import type { coverDocumentInput } from './bookProduction.js';

type CoverInput = ReturnType<typeof coverDocumentInput>;

/** The names of a cover's InDesign layers (the designer's, in the
 *  interface's language). */
export interface CoverLayerNames {
  background: string;
  elements: string;
  mirror: string;
  texts: string;
  effects: string;
  logos: string;
  finishes: string;
}

/** The layers' names as the designer's labels give them: the export
 *  writes them, the import reads items back by them. */
export function coverLayerNamesOf(labels: Pick<Labels, 'coverLayerBackground' | 'coverLayerElements' | 'coverLayerMirror' | 'coverLayerTexts' | 'coverLayerEffects' | 'coverLayerLogos' | 'coverLayerFinishes'>): CoverLayerNames {
  return {
    background: labels.coverLayerBackground,
    elements: labels.coverLayerElements,
    mirror: labels.coverLayerMirror,
    texts: labels.coverLayerTexts,
    effects: labels.coverLayerEffects,
    logos: labels.coverLayerLogos,
    finishes: labels.coverLayerFinishes,
  };
}

/** A cover's InDesign layers, bottom to top, each holding its designer
 *  layer's items by their decoration ids (./compose in `postext`): the
 *  background, the movable elements, the mirror bleed (locked: generated,
 *  for the printer to see, not to move), the text and the barcode, the
 *  effects, the logos and the finishes. */
export function coverIdmlLayers(names: CoverLayerNames): IdmlExportLayer[] {
  const by = (...prefixes: string[]) => (item: { element?: string }) => !!item.element && prefixes.some((p) => item.element === p || item.element!.startsWith(`${p}-`));
  return [
    { name: names.background, color: 'Gray', takes: by('cover-ground', 'cover-image', 'cover-zone') },
    { name: names.elements, color: 'LightBlue', takes: by('cover-el') },
    { name: names.mirror, color: 'Orange', locked: true, takes: by(MIRROR_RESOURCE_ID) },
    { name: names.texts, color: 'Green', default: true, takes: (item) => item.text || by(BARCODE_RESOURCE_ID)(item) },
    { name: names.effects, color: 'Violet', takes: by('cover-fx') },
    { name: names.logos, color: 'Red', takes: by('cover-logo') },
    { name: names.finishes, color: 'Gold', takes: by('cover-finish') },
  ];
}

/** The colour InDesign draws each guide in: the lines the sheet is folded
 *  or scored on in magenta, the safe areas in cyan. */
const GUIDE_COLOR: Record<SheetGuide['kind'], string> = {
  fold: 'Magenta',
  score: 'Magenta',
  joint: 'Magenta',
  glue: 'Magenta',
  zone: 'Magenta',
  safe: 'Cyan',
};

export function coverIdmlGuides(sheet: ProductionSheet): IdmlRulerGuide[] {
  return sheetGuides(sheet).map((g) => ({ page: 0, orientation: g.orientation, at: g.at, color: GUIDE_COLOR[g.kind] }));
}

const mm = (px: number) => ({ value: Math.round(((px * 25.4) / 96) * 1000) / 1000, unit: 'mm' as const });

/** The barcode alone on a page its size, written by the PDF renderer: its
 *  bars and digits as vectors, the digits' face embedded. */
async function barcodePdf(barcode: Resource, svgBytes: Uint8Array, config: PostextConfig): Promise<Uint8Array> {
  const width = mm(barcode.svg?.width ?? 0);
  const height = mm(barcode.svg?.height ?? 0);
  const page: PostextConfig = {
    ...config,
    page: { ...config.page, sizePreset: 'custom', width, height, margins: { top: mm(0), bottom: mm(0), left: mm(0), right: mm(0) }, cutLines: { enabled: false } },
    header: { elements: [] },
    footer: { elements: [] },
    pageTemplates: [{
      id: 'barcode',
      area: 'trim',
      frames: [],
      header: false,
      footer: false,
      decoration: { elements: [{ kind: 'image', id: BARCODE_RESOURCE_ID, resourceId: BARCODE_RESOURCE_ID, placement: { anchor: { to: 'page', edge: 'top-left' }, offset: { x: mm(0), y: mm(0) }, size: { width, height } } }] },
    }],
  };
  // The barcode as an SVG: its PDF is what is being written.
  const svg = { ...barcode, svg: { ...barcode.svg!, pdfFileId: undefined } } as Resource;
  delete svg.svg!.pdfFileId;
  const doc = buildDocument({ markdown: '::::page{template="barcode"}\n\n::::', resources: [svg] }, page);
  // In the inks and the standard of the cover's own PDF.
  const print = resolvePrintConfig(config.print);
  const outputProfile = print.standard !== 'none' ? await loadPrintProfile(print).then((p) => p.bytes, () => undefined) : undefined;
  const worker = createPdfWorker();
  try {
    return await worker.render([doc], {
      fontProvider: createPdfFontProvider(),
      // A copy: the worker takes the bytes it is given.
      resourceBytes: new Map([[barcode.svg!.fileId, svgBytes.slice()]]),
      ...(config.print ? { print: config.print } : {}),
      ...(outputProfile ? { outputProfile } : {}),
      profileBaseUrl: outputProfileBaseUrl(),
    });
  } finally {
    worker.dispose();
  }
}

/** The IDML package of a sheet, `input` built with `barcodePdf`. Laid
 *  out here, not on the layout worker: the worker keys resources without
 *  their files' ids, so it would set the barcode the preview holds, with
 *  no PDF beside it. One sheet is quick to lay out. */
export async function buildCoverIdml({ sheet, input, title, layers, onWarning }: {
  sheet: ProductionSheet;
  input: CoverInput;
  title: string;
  /** The designer's layers' names: a layer each in the package. */
  layers?: CoverLayerNames;
  onWarning?: (w: IdmlWarning) => void;
}): Promise<IdmlExport> {
  const files: Record<string, Uint8Array> = { ...input.cover.files };
  const barcode = input.resources.find((r) => r.id === BARCODE_RESOURCE_ID);
  const svgBytes = barcode?.svg ? files[barcode.svg.fileId] : undefined;
  await ensureConfigFontsLoaded(input.config, input.markdown);
  await ensureResourceImages(input.resources.filter((r) => r.id !== BARCODE_RESOURCE_ID));
  if (barcode && svgBytes) files[BARCODE_PDF_FILE_ID] = await barcodePdf(barcode, svgBytes, input.config);
  const doc: VDTDocument = buildDocument({ markdown: input.markdown, resources: input.resources }, input.config);
  // The pictures of the sheet as the PDF takes them (a print master for an
  // SVG that has one).
  const { bytes } = await buildPdfResourceBytes(input.resources.filter((r) => r.id !== BARCODE_RESOURCE_ID), input.config);
  for (const [id, b] of bytes) if (!(id in files)) files[id] = b;
  const faces = await sandboxIdmlFaces([doc]);
  return buildIdmlExport({
    docs: [doc],
    resources: input.resources.filter((r) => r.id !== BARCODE_RESOURCE_ID),
    config: input.config,
    title,
    // Text the printer may change: InDesign sets it again in its frames.
    choices: { lineBreaks: 'reflow', spreads: 'single', images: 'link', fonts: true },
    faces,
    withheld: idmlFontWithheld,
    files,
    guides: coverIdmlGuides(sheet),
    ...(layers ? { layers: coverIdmlLayers(layers) } : {}),
    // Each item named after its element, so the cover comes back from
    // InDesign onto its design (./coverIdmlImport.ts).
    nameItems: true,
    ...(onWarning ? { onWarning } : {}),
  });
}
