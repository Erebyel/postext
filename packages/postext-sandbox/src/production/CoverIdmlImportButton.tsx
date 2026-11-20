'use client';

/**
 * Bringing a cover back from InDesign, in the Cover panel: the IDML the
 * designer exported, edited there, chosen with the pictures it links
 * (an IDML holds none). The design and the texts take what changed, the
 * pictures added there go into the cover's gallery, and a summary says
 * what came in and what did not; one click undoes it all.
 *
 * Or saved as a cover template instead (./coverTemplates.ts): an IDML
 * made in InDesign read item by item onto this book's sheet, each in the
 * layer it belongs to, kept as a template without touching the book.
 */

import { useRef, useState } from 'react';
import { FileDown, LayoutTemplate, Undo2 } from 'lucide-react';
import type { ProductionSheet } from 'postext';
import { Button, announce } from '../ui/index.js';
import { fill } from '../print/fillTokens.js';
import type { BookProduction, CoverTextZone } from './bookProduction.js';
import { importCoverIdml, type CoverIdmlReport } from './coverIdmlImport.js';
import type { CoverGallery } from './coverGallery.js';
import { coverLayerNamesOf } from './coverIdml.js';
import { designParts, templateFromDesign } from './coverTemplates.js';
import type { LogoRecord } from './logoLibrary.js';
import { putTemplates } from './productionStore.js';
import { useCoverThumbnail } from './sheetPainter.js';
import type { Labels } from './productionUi.js';

const ZONE_LABEL: Record<CoverTextZone, keyof Labels> = {
  front: 'productionZoneFront',
  spine: 'productionZoneSpine',
  back: 'productionZoneBack',
  flapFront: 'productionZoneFlapFront',
  flapBack: 'productionZoneFlapBack',
};

export function CoverIdmlImportButton({ sheet, record, gallery, library, labels, onRecord, onGallery }: {
  sheet: ProductionSheet;
  record: BookProduction;
  gallery: CoverGallery;
  /** The logo library, whose logos a picture's file name can be. */
  library: readonly LogoRecord[];
  labels: Labels;
  onRecord: (next: BookProduction) => void;
  onGallery: (next: CoverGallery) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const templateRef = useRef<HTMLInputElement>(null);
  const thumbnail = useCoverThumbnail();
  // What the last IDML saved as a template brought in and left out.
  const [savedReport, setSavedReport] = useState<{ report: CoverIdmlReport; name: string } | null>(null);
  const [done, setDone] = useState<{ report: CoverIdmlReport; before: BookProduction; galleryBefore: CoverGallery } | null>(null);

  /** The IDML chosen and the pictures beside it. */
  const picked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    const idml = files.find((f) => /\.idml$/i.test(f.name));
    if (!idml) {
      announce(labels.coverIdmlNoFile);
      return null;
    }
    const links = new Map<string, Uint8Array>();
    for (const f of files) if (f !== idml) links.set(f.name, new Uint8Array(await f.arrayBuffer()));
    return { idml, links };
  };
  const read = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const got = await picked(e);
    if (!got) return;
    const { idml, links } = got;
    try {
      const back = importCoverIdml(new Uint8Array(await idml.arrayBuffer()), {
        sheet,
        design: record.design,
        texts: record.texts,
        layerNames: coverLayerNamesOf(labels),
        links,
        library,
      });
      setSavedReport(null);
      setDone({ report: back.report, before: record, galleryBefore: gallery });
      onRecord({ ...record, design: back.design, texts: back.texts });
      if (back.pictures.length > 0) onGallery({ ...gallery, pictures: [...gallery.pictures, ...back.pictures] });
      announce(fill(labels.coverIdmlDone, { updated: String(back.report.updated.length), added: String(back.report.added.length) }));
    } catch {
      announce(labels.coverIdmlFailed);
    }
  };
  const saveTemplate = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const got = await picked(e);
    if (!got) return;
    const { idml, links } = got;
    try {
      // Read onto an empty design: the template is what the IDML has.
      const back = importCoverIdml(new Uint8Array(await idml.arrayBuffer()), { sheet, design: undefined, texts: {}, layerNames: coverLayerNamesOf(labels), links, library });
      const name = idml.name.replace(/\.idml$/i, '');
      const template = templateFromDesign(back.design, designParts(back.design), { gallery: { projectId: '', pictures: back.pictures, traces: [] }, logos: library }, name);
      if (template.parts.length === 0) {
        announce(labels.coverIdmlFailed);
        return;
      }
      // The cover as InDesign has it, texts and all, on this book's sheet.
      const thumb = await thumbnail?.(template.design, back.texts, template.pictures);
      await putTemplates([thumb ? { ...template, thumbnail: thumb } : template]);
      setDone(null);
      setSavedReport({ report: back.report, name });
      announce(fill(labels.coverTemplateSaved, { name }));
    } catch {
      announce(labels.coverIdmlFailed);
    }
  };
  const undo = () => {
    if (!done) return;
    onRecord(done.before);
    onGallery(done.galleryBefore);
    setDone(null);
  };

  const r = done?.report;
  const why = (w: CoverIdmlReport['skipped'][number]['why']) => labels[({ rotated: 'coverIdmlRotated', group: 'coverIdmlGroup', text: 'coverIdmlText', empty: 'coverIdmlEmpty', barcode: 'coverIdmlBarcode' } as const)[w]];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" icon={<FileDown size={13} />} onClick={() => ref.current?.click()}>{labels.coverIdmlImport}</Button>
        <Button variant="outline" size="sm" icon={<LayoutTemplate size={13} />} onClick={() => templateRef.current?.click()}>{labels.coverIdmlSaveTemplate}</Button>
        <input ref={ref} type="file" multiple accept=".idml,image/png,image/jpeg,image/svg+xml,.svg" className="hidden" aria-hidden="true" tabIndex={-1} onChange={(e) => void read(e)} />
        <input ref={templateRef} type="file" multiple accept=".idml,image/png,image/jpeg,image/svg+xml,.svg" className="hidden" aria-hidden="true" tabIndex={-1} onChange={(e) => void saveTemplate(e)} />
      </div>
      <p className="m-0 text-xs text-(--slate)">{labels.coverIdmlHint}</p>
      {savedReport && (
        <div role="status" className="flex flex-col gap-1 border-s-2 border-(--brand) bg-(--surface) px-2 py-1.5 text-xs">
          <p className="m-0 font-semibold">{fill(labels.coverTemplateSaved, { name: savedReport.name })}</p>
          {savedReport.report.added.length > 0 && <p className="m-0">{fill(labels.coverIdmlAdded, { items: savedReport.report.added.join(', ') })}</p>}
          {savedReport.report.links.length > 0 && <p className="m-0">{fill(labels.coverIdmlLinks, { files: savedReport.report.links.join(', ') })}</p>}
          {savedReport.report.skipped.length > 0 && <p className="m-0">{fill(labels.coverIdmlSkipped, { items: savedReport.report.skipped.map((x) => `${x.name} (${why(x.why)})`).join(', ') })}</p>}
          <p className="m-0 text-(--slate)">{labels.coverIdmlTemplateHint}</p>
        </div>
      )}
      {r && (
        <div role="status" className="flex flex-col gap-1 border-s-2 border-(--brand) bg-(--surface) px-2 py-1.5 text-xs">
          <p className="m-0 font-semibold">{fill(labels.coverIdmlDone, { updated: String(r.updated.length), added: String(r.added.length) })}</p>
          {r.generic && (
            <p className="m-0">
              {r.generic.from && r.generic.to
                ? fill(labels.coverIdmlFitted, { from: r.generic.from.map((v) => v.toLocaleString()).join(' × '), to: r.generic.to.map((v) => v.toLocaleString()).join(' × ') })
                : labels.coverIdmlGeneric}
            </p>
          )}
          {r.added.length > 0 && <p className="m-0">{fill(labels.coverIdmlAdded, { items: r.added.join(', ') })}</p>}
          {r.texts.length > 0 && <p className="m-0">{fill(labels.coverIdmlTexts, { zones: r.texts.map((z) => String(labels[ZONE_LABEL[z]])).join(', ') })}</p>}
          {r.missing.length > 0 && <p className="m-0">{fill(labels.coverIdmlMissing, { items: r.missing.join(', ') })}</p>}
          {r.links.length > 0 && <p className="m-0">{fill(labels.coverIdmlLinks, { files: r.links.join(', ') })}</p>}
          {r.skipped.length > 0 && <p className="m-0">{fill(labels.coverIdmlSkipped, { items: r.skipped.map((s) => `${s.name} (${why(s.why)})`).join(', ') })}</p>}
          <div>
            <Button variant="ghost" size="sm" icon={<Undo2 size={13} />} onClick={undo}>{labels.coverIdmlUndo}</Button>
          </div>
        </div>
      )}
    </div>
  );
}
