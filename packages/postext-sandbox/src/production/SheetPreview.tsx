'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  PROMO_FORMATS,
  renderPageToCanvas,
  resolvePrintConfig,
  type PostextConfig,
  type ProductionVersion,
  type Resource,
  type VDTDocument,
  type VersionSheets,
} from 'postext';
import { createPdfWorker } from 'postext-pdf/worker';
import { Button, Select, announce } from '../ui/index.js';
import { ensureConfigFontsLoaded } from '../controls/fonts/fontLoader.js';
import { ensureResourceImages } from '../controls/media/resourceImages.js';
import { buildPdfResourceBytes } from '../viewport/pdf/pdfResourceBytes.js';
import { downloadBytes } from '../storage/persistence.js';
import { fill } from '../print/fillTokens.js';
import { loadPrintProfile, outputProfileBaseUrl } from '../print/printSetup.js';
import { createPdfFontProvider } from '../viewport/pdf/pdfFontProvider.js';
import { useLayoutWorker } from '../worker/useLayoutWorker.js';
import { promoImage } from './promoImage.js';
import { buildCoverIdml } from './coverIdml.js';
import {
  bookTrimMm,
  isPromo,
  coverDocumentInput,
  pickSheet,
  sheetFileName,
  type BookProduction,
  type CoverDesignSettings,
  type SheetChoice,
} from './bookProduction.js';
import { HEADING, mm1, type Labels } from './productionUi.js';
import { registerCoverImages } from './coverImages.js';
import { useLogos, useMirror } from './useProduction.js';


const SHEET_LABEL: Record<SheetChoice, keyof Labels> = {
  cover: 'productionSheetCover',
  jacket: 'productionSheetJacket',
  endpaperFront: 'productionSheetEndpaperFront',
  endpaperBack: 'productionSheetEndpaperBack',
  epub: 'productionSheetEpub',
  square: 'productionSheetSquare',
  story: 'productionSheetStory',
  landscape: 'productionSheetLandscape',
};


export function SheetPreview({ config, version, texts, design, bookResources, sheets, choices, shown, onChoose, labels, fileTitle }: {
  config: PostextConfig;
  version: ProductionVersion;
  texts: BookProduction['texts'];
  design: CoverDesignSettings | undefined;
  bookResources: readonly Resource[];
  sheets: VersionSheets;
  choices: SheetChoice[];
  shown: SheetChoice;
  onChoose: (c: SheetChoice) => void;
  labels: Labels;
  fileTitle: string;
}) {
  const { build } = useLayoutWorker('preview');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // The layout and what it was laid out from: a sheet chosen since (or
  // texts typed since) is not the one on show until it is built, and the
  // PDF only ever writes the sheet the preview shows.
  const [built, setBuilt] = useState<{ doc: VDTDocument; input: ReturnType<typeof coverDocumentInput>; sheet: SheetChoice } | null>(null);
  const doc = built?.doc ?? null;
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const library = useLogos();
  const mirror = useMirror(design, bookResources, sheets.measures.designMargin);
  const sheet = pickSheet(sheets, shown, bookTrimMm(config));
  // A screen picture carries no finishes: they are plates for the press.
  const input = useMemo(
    () => coverDocumentInput(sheet, version, texts, config, design, bookResources, {
      logos: library,
      ...(mirror ? { mirror } : {}),
      ...(isPromo(shown) ? { hidden: new Set(['finishes'] as const) } : {}),
    }),
    [sheet, version, texts, config, design, bookResources, library, shown, mirror],
  );
  const isCaseCover = sheet.kind === 'case';

  useEffect(() => {
    let alive = true;
    setFailed(false);
    const t = setTimeout(() => {
      void (async () => {
        try {
          await ensureConfigFontsLoaded(input.config, input.markdown);
          await registerCoverImages(input.cover.files);
          await ensureResourceImages(input.resources.filter((r) => r.id !== 'isbn-barcode'));
          const laid = await build({ markdown: input.markdown, resources: input.resources }, input.config);
          if (alive) setBuilt({ doc: laid, input, sheet: shown });
        } catch {
          if (alive) setFailed(true);
        }
      })();
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [build, input, shown]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    const page = doc?.pages[0];
    if (!canvas || !wrap || !doc || !page) return;
    const width = wrap.clientWidth || 280;
    const dpr = window.devicePixelRatio || 1;
    renderPageToCanvas(page, doc, canvas, { scale: (width * dpr) / page.width });
    canvas.style.width = `${width}px`;
    canvas.style.height = `${(width * page.height) / page.width}px`;
  }, [doc]);

  const exportImage = async () => {
    if (!built || built.input !== input || !isPromo(built.sheet)) return;
    setBusy(true);
    try {
      const px = PROMO_FORMATS[built.sheet];
      const bytes = await promoImage(built.doc, px.width, px.height);
      if (!bytes) return;
      const name = sheetFileName(fileTitle, version.name, built.sheet);
      downloadBytes(bytes, name, 'image/jpeg');
      announce(fill(labels.productionExported, { name }));
    } finally {
      setBusy(false);
    }
  };

  const exportPdf = async () => {
    if (!built || built.input !== input) return;
    if (isPromo(built.sheet)) return exportImage();
    setBusy(true);
    announce(labels.productionExporting);
    try {
      const print = resolvePrintConfig(config.print);
      const outputProfile = print.standard !== 'none'
        ? await loadPrintProfile(print).then((p) => p.bytes, () => undefined)
        : undefined;
      // Finishes go to the press as solid plates that overprint: the sheet
      // is laid out again with them so, when it has any.
      const press = design?.finishes?.length
        ? coverDocumentInput(sheet, version, texts, config, design, bookResources, { logos: library, press: true, ...(mirror ? { mirror } : {}) })
        : built.input;
      const pressDoc = press === built.input ? built.doc : await build({ markdown: press.markdown, resources: press.resources }, press.config);
      const own = new Set(Object.keys(press.cover.files));
      const { bytes: resourceBytes, previews: previewBytes } = await buildPdfResourceBytes(press.resources.filter((r) => !own.has(r.svg?.fileId ?? r.bitmap?.fileId ?? '')), config);
      for (const [fileId, bytes] of Object.entries(press.cover.files)) resourceBytes.set(fileId, bytes);
      const worker = createPdfWorker();
      try {
        const bytes = await worker.render([pressDoc], {
          fontProvider: createPdfFontProvider(),
          resourceBytes,
          ...(previewBytes.size > 0 ? { previewBytes } : {}),
          ...(config.print ? { print: config.print } : {}),
          ...(outputProfile ? { outputProfile } : {}),
          profileBaseUrl: outputProfileBaseUrl(),
        });
        const name = sheetFileName(fileTitle, version.name, built.sheet);
        downloadBytes(bytes, name, 'application/pdf');
        announce(fill(labels.productionExported, { name }));
      } finally {
        worker.dispose();
      }
    } finally {
      setBusy(false);
    }
  };

  const exportIdml = async () => {
    if (!built || built.input !== input || isPromo(built.sheet)) return;
    setBusy(true);
    announce(labels.productionExporting);
    try {
      const file = await buildCoverIdml({
        sheet,
        input: coverDocumentInput(sheet, version, texts, config, design, bookResources, { barcodePdf: true, logos: library, press: true, ...(mirror ? { mirror } : {}) }),
        title: sheetFileName(fileTitle, version.name, built.sheet, 'idml').replace(/\.idml$/, ''),
        layers: {
          background: labels.coverLayerBackground,
          elements: labels.coverLayerElements,
          mirror: labels.coverLayerMirror,
          texts: labels.coverLayerTexts,
          effects: labels.coverLayerEffects,
          logos: labels.coverLayerLogos,
          finishes: labels.coverLayerFinishes,
        },
      });
      downloadBytes(file.bytes, file.name, file.mime);
      announce(fill(labels.productionExported, { name: file.name }));
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) console.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-2">
      <h3 className={HEADING}>{labels.productionSheet}</h3>
      {choices.length > 1 && (
        <Select
          size="sm"
          value={shown}
          onValueChange={onChoose}
          options={choices.map((c) => ({
            value: c,
            label: String(labels[c === 'cover' && isCaseCoverOf(sheets) ? 'productionSheetCase' : SHEET_LABEL[c]]),
          }))}
          ariaLabel={labels.productionSheet}
        />
      )}
      <p className="m-0 text-xs text-(--slate)">
        {(isCaseCover ? labels.productionSheetCase : String(labels[SHEET_LABEL[shown]]))} · {isPromo(shown)
          ? fill(labels.productionSheetPixels, { width: String(PROMO_FORMATS[shown].width), height: String(PROMO_FORMATS[shown].height) })
          : fill(labels.productionSheetSize, { width: mm1(sheet.width), height: mm1(sheet.height) })}
      </p>
      <div ref={wrapRef} className="w-full overflow-hidden rounded border border-(--rule) bg-white">
        {failed ? <p className="m-0 p-2 text-xs text-(--slate)">{labels.productionPreviewFailed}</p> : <canvas ref={canvasRef} className="block" />}
      </div>
      <div className="flex justify-end gap-2">
        {!isPromo(shown) && (
          <Button variant="outline" size="sm" disabled={!built || built.input !== input || busy} onClick={() => void exportIdml()}>
            {labels.productionExportIdml}
          </Button>
        )}
        <Button variant="primary" size="sm" disabled={!built || built.input !== input || busy} onClick={() => void exportPdf()}>
          {busy ? labels.productionExporting : isPromo(shown) ? labels.productionExportImage : labels.productionExportPdf}
        </Button>
      </div>
    </section>
  );
}

const isCaseCoverOf = (sheets: VersionSheets) => sheets.cover.kind === 'case';
