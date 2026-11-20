'use client';

/**
 * Bringing a cover back from InDesign, in the Cover panel: the IDML the
 * designer exported, edited there, chosen with the pictures it links
 * (an IDML holds none). The design and the texts take what changed, the
 * pictures added there go into the cover's gallery, and a summary says
 * what came in and what did not; one click undoes it all.
 *
 * An IDML to keep as a cover template is read in the templates' section
 * instead (./CoverTemplatesSection.tsx).
 */

import { useRef, useState } from 'react';
import { FileDown, Undo2 } from 'lucide-react';
import type { ProductionSheet } from 'postext';
import { Button, announce } from '../ui/index.js';
import { fill } from '../print/fillTokens.js';
import type { BookProduction } from './bookProduction.js';
import type { CoverField } from './coverTexts.js';
import { PICTURE_ACCEPT, readPictureFile } from './printFiles.js';
import { importCoverIdml, type CoverIdmlReport } from './coverIdmlImport.js';
import type { CoverGallery } from './coverGallery.js';
import { coverLayerNamesOf } from './coverIdml.js';
import type { LogoRecord } from './logoLibrary.js';
import type { Labels } from './productionUi.js';

const FIELD_LABEL: Record<CoverField, keyof Labels> = {
  title: 'coverFieldTitle',
  subtitle: 'coverFieldSubtitle',
  author: 'coverFieldAuthor',
  front: 'productionZoneFront',
  spine: 'productionZoneSpine',
  back: 'productionZoneBack',
  flapFront: 'productionZoneFlapFront',
  flapBack: 'productionZoneFlapBack',
};

/** The general texts an import changed, by their names. */
export const idmlFieldNames = (labels: Labels, fields: readonly CoverField[]): string => fields.map((f) => String(labels[FIELD_LABEL[f]])).join(', ');

/** Why an item stayed out, in the labels' words. */
export const idmlSkipReason = (labels: Labels, why: CoverIdmlReport['skipped'][number]['why']): string =>
  labels[({ rotated: 'coverIdmlRotated', group: 'coverIdmlGroup', text: 'coverIdmlText', empty: 'coverIdmlEmpty', barcode: 'coverIdmlBarcode' } as const)[why]];

/** The IDML among files chosen and the pictures beside it, by name: a
 *  TIFF, an Illustrator file or a PDF made a PNG (./printFiles.ts), each
 *  page of one with several also as `name#page`; the EPS, which cannot be
 *  read, named apart. */
export async function pickedIdml(files: readonly File[]): Promise<{ idml: File; links: Map<string, Uint8Array>; postscript: string[] } | null> {
  const idml = files.find((f) => /\.idml$/i.test(f.name));
  if (!idml) return null;
  const links = new Map<string, Uint8Array>();
  const postscript: string[] = [];
  for (const f of files) {
    if (f === idml) continue;
    const got = await readPictureFile(f);
    if (got === 'postscript') postscript.push(f.name);
    if (!got || got === 'postscript') continue;
    links.set(f.name, got[0]!.bytes);
    for (const p of got) if (p.page) links.set(`${f.name}#${p.page}`, p.bytes);
  }
  return { idml, links, postscript };
}

/** The type families the texts are set in that the book does not have. */
export const missingFonts = (report: CoverIdmlReport, have: readonly string[]): string[] =>
  (report.fonts ?? []).filter((f) => !have.some((h) => h.toLowerCase() === f.toLowerCase()));

export function CoverIdmlImportButton({ sheet, record, gallery, library, families, labels, onRecord, onGallery }: {
  sheet: ProductionSheet;
  /** The type families the book has, to say which the IDML's lack. */
  families: readonly string[];
  record: BookProduction;
  gallery: CoverGallery;
  /** The logo library, whose logos a picture's file name can be. */
  library: readonly LogoRecord[];
  labels: Labels;
  onRecord: (next: BookProduction) => void;
  onGallery: (next: CoverGallery) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [done, setDone] = useState<{ report: CoverIdmlReport; postscript: string[]; before: BookProduction; galleryBefore: CoverGallery } | null>(null);

  const picked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    const got = await pickedIdml(files);
    if (!got) announce(labels.coverIdmlNoFile);
    return got;
  };
  const read = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const got = await picked(e);
    if (!got) return;
    const { idml, links, postscript } = got;
    try {
      const back = importCoverIdml(new Uint8Array(await idml.arrayBuffer()), {
        sheet,
        design: record.design,
        texts: record.texts,
        layerNames: coverLayerNamesOf(labels),
        links,
        library,
      });
      setDone({ report: back.report, postscript, before: record, galleryBefore: gallery });
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
  const fonts = r ? missingFonts(r, families) : [];
  const why = (w: CoverIdmlReport['skipped'][number]['why']) => idmlSkipReason(labels, w);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" icon={<FileDown size={13} />} onClick={() => ref.current?.click()}>{labels.coverIdmlImport}</Button>
        <input ref={ref} type="file" multiple accept={`.idml,${PICTURE_ACCEPT}`} className="hidden" aria-hidden="true" tabIndex={-1} onChange={(e) => void read(e)} />
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
          {r.texts.length > 0 && <p className="m-0">{fill(labels.coverIdmlTexts, { zones: idmlFieldNames(labels, r.texts) })}</p>}
          {r.missing.length > 0 && <p className="m-0">{fill(labels.coverIdmlMissing, { items: r.missing.join(', ') })}</p>}
          {r.links.length > 0 && <p className="m-0">{fill(labels.coverIdmlLinks, { files: [...new Set(r.links)].join(', ') })}</p>}
          {done.postscript.length > 0 && <p className="m-0">{fill(labels.productionPicturePostscript, { name: done.postscript.join(', ') })}</p>}
          {fonts.length > 0 && <p className="m-0">{fill(labels.coverIdmlFonts, { fonts: fonts.join(', ') })}</p>}
          {r.skipped.length > 0 && <p className="m-0">{fill(labels.coverIdmlSkipped, { items: r.skipped.map((s) => `${s.name} (${why(s.why)})`).join(', ') })}</p>}
          <div>
            <Button variant="ghost" size="sm" icon={<Undo2 size={13} />} onClick={undo}>{labels.coverIdmlUndo}</Button>
          </div>
        </div>
      )}
    </div>
  );
}
