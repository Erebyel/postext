'use client';

/**
 * Bringing a cover back from InDesign, in the Cover panel: the IDML the
 * designer exported, edited there, chosen with the pictures it links
 * (an IDML holds none). The design and the texts take what changed, the
 * pictures added there go into the cover's gallery, and a summary says
 * what came in and what did not; one click undoes it all.
 */

import { useRef, useState } from 'react';
import { FileDown, Undo2 } from 'lucide-react';
import type { ProductionSheet } from 'postext';
import { Button, announce } from '../ui/index.js';
import { fill } from '../print/fillTokens.js';
import type { BookProduction, CoverTextZone } from './bookProduction.js';
import { importCoverIdml, type CoverIdmlReport } from './coverIdmlImport.js';
import type { CoverGallery } from './coverGallery.js';
import { coverLayerNamesOf } from './coverIdml.js';
import type { Labels } from './productionUi.js';

const ZONE_LABEL: Record<CoverTextZone, keyof Labels> = {
  front: 'productionZoneFront',
  spine: 'productionZoneSpine',
  back: 'productionZoneBack',
  flapFront: 'productionZoneFlapFront',
  flapBack: 'productionZoneFlapBack',
};

export function CoverIdmlImportButton({ sheet, record, gallery, labels, onRecord, onGallery }: {
  sheet: ProductionSheet;
  record: BookProduction;
  gallery: CoverGallery;
  labels: Labels;
  onRecord: (next: BookProduction) => void;
  onGallery: (next: CoverGallery) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [done, setDone] = useState<{ report: CoverIdmlReport; before: BookProduction; galleryBefore: CoverGallery } | null>(null);

  const read = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    const idml = files.find((f) => /\.idml$/i.test(f.name));
    if (!idml) {
      announce(labels.coverIdmlNoFile);
      return;
    }
    const links = new Map<string, Uint8Array>();
    for (const f of files) if (f !== idml) links.set(f.name, new Uint8Array(await f.arrayBuffer()));
    try {
      const back = importCoverIdml(new Uint8Array(await idml.arrayBuffer()), {
        sheet,
        design: record.design,
        texts: record.texts,
        layerNames: coverLayerNamesOf(labels),
        links,
      });
      setDone({ report: back.report, before: record, galleryBefore: gallery });
      onRecord({ ...record, design: back.design, texts: back.texts });
      if (back.pictures.length > 0) onGallery({ ...gallery, pictures: [...gallery.pictures, ...back.pictures] });
      announce(fill(labels.coverIdmlDone, { updated: String(back.report.updated.length), added: String(back.report.added.length) }));
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
        <input ref={ref} type="file" multiple accept=".idml,image/png,image/jpeg,image/svg+xml,.svg" className="hidden" aria-hidden="true" tabIndex={-1} onChange={(e) => void read(e)} />
      </div>
      <p className="m-0 text-xs text-(--slate)">{labels.coverIdmlHint}</p>
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
