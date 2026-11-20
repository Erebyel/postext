'use client';

/**
 * The Cover panel's cover templates: the book's design saved by parts (a
 * collection's ground and logos, a series' type), laid by parts on
 * another book, shared as a file. A template made in InDesign comes in
 * from the import beside the sheet (./CoverIdmlImportButton.tsx).
 */

import { useRef, useState } from 'react';
import { Download, FileUp, ImageOff, Trash2, Upload } from 'lucide-react';
import type { ProductionSheet } from 'postext';
import { Button, ConfirmPopover, IconButton, announce, cn } from '../ui/index.js';
import { fill } from '../print/fillTokens.js';
import { downloadBytes } from '../storage/persistence.js';
import type { BookProduction } from './bookProduction.js';
import type { CoverGallery } from './coverGallery.js';
import {
  TEMPLATE_PARTS,
  applyTemplate,
  designParts,
  exportTemplates,
  importTemplates,
  templateFromDesign,
  type CoverTemplate,
  type TemplatePart,
} from './coverTemplates.js';
import type { LogoRecord } from './logoLibrary.js';
import { Fold } from './Fold.js';
import { deleteTemplate, listLogos, putLogos, putTemplates } from './productionStore.js';
import { INPUT, type Labels } from './productionUi.js';
import { useCoverTemplates } from './useProduction.js';
import { useObjectUrl } from './coverImages.js';
import { useCoverThumbnail } from './sheetPainter.js';
import { idmlSkipReason, pickedIdml } from './CoverIdmlImportButton.js';
import { importCoverIdml, type CoverIdmlReport } from './coverIdmlImport.js';
import { coverLayerNamesOf } from './coverIdml.js';

export const PART_LABEL: Record<TemplatePart, keyof Labels> = {
  background: 'coverLayerBackground',
  elements: 'coverLayerElements',
  texts: 'coverTemplatePartTexts',
  effects: 'coverLayerEffects',
  logos: 'coverLayerLogos',
  finishes: 'coverLayerFinishes',
};

/** The parts to save or lay, each a button that is on or off. */
export function PartPicker({ offered, chosen, labels, onChange }: {
  offered: readonly TemplatePart[];
  chosen: readonly TemplatePart[];
  labels: Labels;
  onChange: (next: TemplatePart[]) => void;
}) {
  return (
    <div role="group" aria-label={labels.coverTemplateParts} className="flex flex-wrap gap-1">
      {offered.map((p) => {
        const on = chosen.includes(p);
        return (
          <button
            key={p}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? chosen.filter((x) => x !== p) : TEMPLATE_PARTS.filter((x) => x === p || chosen.includes(x)))}
            className={cn(
              'cursor-pointer rounded-full border px-2 py-0.5 text-xs transition-colors',
              on ? 'border-(--brand) bg-(--surface) text-(--foreground)' : 'border-(--rule) bg-transparent text-(--slate) hover:text-(--foreground)',
            )}
          >
            {String(labels[PART_LABEL[p]])}
          </button>
        );
      })}
    </div>
  );
}

/** A template's thumbnail, or a frame of the sheet's proportions. */
function Thumbnail({ bytes }: { bytes: Uint8Array | undefined }) {
  const url = useObjectUrl(bytes ?? EMPTY, 'image/jpeg');
  return (
    <span className="flex h-14 w-24 shrink-0 items-center justify-center overflow-hidden rounded border border-(--rule) bg-(--surface)">
      {bytes && url ? <img src={url} alt="" className="h-full w-full object-contain" /> : <ImageOff size={14} aria-hidden="true" className="text-(--slate)" />}
    </span>
  );
}
const EMPTY = new Uint8Array(0);

function TemplateRow({ template, labels, paint, onApply }: {
  template: CoverTemplate;
  labels: Labels;
  /** Paints a thumbnail on this book's sheet (null with no version). */
  paint: ((t: CoverTemplate) => Promise<void>) | null;
  onApply: (t: CoverTemplate, parts: TemplatePart[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [parts, setParts] = useState<TemplatePart[]>(template.parts);
  return (
    <li className="flex flex-col gap-1.5 border-t border-(--rule) pt-2 text-xs">
      <div className="flex items-start gap-2">
        <Thumbnail bytes={template.thumbnail} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-semibold" style={{ overflowWrap: 'anywhere' }}>{template.name}</span>
          <span className="text-(--slate)">{template.parts.map((p) => String(labels[PART_LABEL[p]])).join(' · ')}</span>
          {!template.thumbnail && paint && (
            <button type="button" onClick={() => void paint(template)} className="w-fit cursor-pointer border-0 bg-transparent p-0 text-start text-(--brand) underline">{labels.coverTemplatePaint}</button>
          )}
        </span>
      </div>
      <div className="flex items-center gap-1">
        <Button variant={open ? 'primary' : 'outline'} size="sm" onClick={() => setOpen(!open)}>{labels.coverTemplateApply}</Button>
        <ConfirmPopover message={fill(labels.productionGalleryDelete, { name: template.name })} confirmLabel={labels.productionLogoDelete} onConfirm={() => void deleteTemplate(template.id)}>
          {({ open: ask }) => <IconButton label={fill(labels.productionGalleryDelete, { name: template.name })} icon={<Trash2 size={14} aria-hidden="true" />} onClick={ask} />}
        </ConfirmPopover>
      </div>
      {open && (
        <div className="flex flex-col gap-1.5 border-s-2 border-(--brand) ps-2">
          <p className="m-0 text-(--slate)">{labels.coverTemplateApplyHint}</p>
          <PartPicker offered={template.parts} chosen={parts} labels={labels} onChange={setParts} />
          <div>
            <Button variant="primary" size="sm" disabled={parts.length === 0} onClick={() => { onApply(template, parts); setOpen(false); }}>
              {labels.coverTemplateApplyParts}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

export function CoverTemplatesSection({ record, sheet, gallery, library, labels, onRecord, onGallery }: {
  record: BookProduction;
  /** The book's cover sheet, an IDML is read onto (null until the book is
   *  laid out whole). */
  sheet: ProductionSheet | null;
  gallery: CoverGallery;
  library: readonly LogoRecord[];
  labels: Labels;
  onRecord: (next: BookProduction) => void;
  onGallery: (next: CoverGallery) => void;
}) {
  const templates = useCoverTemplates();
  const thumbnail = useCoverThumbnail();
  const importRef = useRef<HTMLInputElement>(null);
  const idmlRef = useRef<HTMLInputElement>(null);
  // The template the last IDML made, and what it brought in and left out.
  const [fromIdml, setFromIdml] = useState<{ template: CoverTemplate; report: CoverIdmlReport } | null>(null);
  const offered = designParts(record.design);
  const [name, setName] = useState('');
  const [parts, setParts] = useState<TemplatePart[] | null>(null);
  const chosen = parts ?? offered;

  const save = async () => {
    const n = name.trim();
    if (!n || chosen.length === 0) return;
    const template = templateFromDesign(record.design, chosen, { gallery, logos: library }, n);
    setName('');
    setParts(null);
    // The cover as the template keeps it: its parts on the book's texts.
    const thumb = await thumbnail?.(template.design, record.texts, template.pictures);
    await putTemplates([thumb ? { ...template, thumbnail: thumb } : template]);
    announce(fill(labels.coverTemplateSaved, { name: n }));
  };
  const paint = thumbnail
    ? async (t: CoverTemplate) => {
      const thumb = await thumbnail(t.design, record.texts, t.pictures);
      if (thumb) await putTemplates([{ ...t, thumbnail: thumb }]);
    }
    : null;
  const apply = async (t: CoverTemplate, laid: TemplatePart[]) => {
    const out = applyTemplate(t, laid, record.design, gallery);
    onRecord({ ...record, design: out.design });
    if (out.gallery !== gallery) onGallery(out.gallery);
    const have = new Set((await listLogos().catch(() => [])).map((l) => l.id));
    await putLogos(out.logos.filter((l) => !have.has(l.id)));
    announce(fill(labels.coverTemplateApplied, { name: t.name }));
  };
  const fromInDesign = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    if (!sheet) return;
    const got = await pickedIdml(files);
    if (!got) {
      announce(labels.coverIdmlNoFile);
      return;
    }
    try {
      // Read onto an empty design on this book's sheet: the template is
      // what the IDML has, each item in its layer; the book is not touched.
      const back = importCoverIdml(new Uint8Array(await got.idml.arrayBuffer()), { sheet, design: undefined, texts: {}, layerNames: coverLayerNamesOf(labels), links: got.links, library });
      const name = got.idml.name.replace(/\.idml$/i, '');
      const template = templateFromDesign(back.design, designParts(back.design), { gallery: { projectId: '', pictures: back.pictures, traces: [] }, logos: library }, name);
      if (template.parts.length === 0) {
        announce(labels.coverIdmlFailed);
        return;
      }
      // The cover as InDesign has it, texts and all, on this book's sheet.
      const thumb = await thumbnail?.(template.design, back.texts, template.pictures);
      const saved = thumb ? { ...template, thumbnail: thumb } : template;
      await putTemplates([saved]);
      setFromIdml({ template: saved, report: back.report });
      announce(fill(labels.coverTemplateSaved, { name }));
    } catch {
      announce(labels.coverIdmlFailed);
    }
  };
  const importFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const read = importTemplates(JSON.parse(await file.text()));
      if (!read.ok || read.templates.length === 0) {
        announce(labels.coverTemplatesImportFailed);
        return;
      }
      await putTemplates(read.templates);
      announce(fill(labels.coverTemplatesImported, { count: String(read.templates.length) }));
    } catch {
      announce(labels.coverTemplatesImportFailed);
    }
  };

  return (
    <Fold title={labels.coverTemplates} {...(templates.length ? { note: String(templates.length) } : {})}>
      <p className="m-0 text-xs text-(--slate)">{templates.length === 0 ? labels.coverTemplatesEmpty : labels.coverTemplatesIntro}</p>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {templates.map((t) => <TemplateRow key={t.id} template={t} labels={labels} paint={paint} onApply={(x, p) => void apply(x, p)} />)}
      </ul>

      <div className="flex flex-col gap-1.5 border-t border-(--rule) pt-2 text-xs">
        <h4 className="m-0 font-semibold">{labels.coverIdmlSaveTemplate}</h4>
        <p className="m-0 text-(--slate)">{sheet ? labels.coverTemplateFromIdmlHint : labels.productionSpinePending}</p>
        <div>
          <Button variant="outline" size="sm" icon={<FileUp size={13} />} disabled={!sheet} onClick={() => idmlRef.current?.click()}>{labels.coverTemplateFromIdml}</Button>
          <input ref={idmlRef} type="file" multiple accept=".idml,image/png,image/jpeg,image/svg+xml,.svg" className="hidden" aria-hidden="true" tabIndex={-1} onChange={(e) => void fromInDesign(e)} />
        </div>
        {fromIdml && (
          <div role="status" className="flex flex-col gap-1 border-s-2 border-(--brand) bg-(--surface) px-2 py-1.5">
            <p className="m-0 font-semibold">{fill(labels.coverTemplateSaved, { name: fromIdml.template.name })}</p>
            <p className="m-0">{fromIdml.template.parts.map((p) => String(labels[PART_LABEL[p]])).join(' · ')}</p>
            {fromIdml.report.links.length > 0 && <p className="m-0">{fill(labels.coverIdmlLinks, { files: fromIdml.report.links.join(', ') })}</p>}
            {fromIdml.report.skipped.length > 0 && <p className="m-0">{fill(labels.coverIdmlSkipped, { items: fromIdml.report.skipped.map((x) => `${x.name} (${idmlSkipReason(labels, x.why)})`).join(', ') })}</p>}
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" size="sm" onClick={() => { void apply(fromIdml.template, fromIdml.template.parts); setFromIdml(null); }}>{labels.coverTemplateApplyNow}</Button>
              <Button variant="ghost" size="sm" onClick={() => setFromIdml(null)}>{labels.coverTemplateLater}</Button>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1.5 border-t border-(--rule) pt-2 text-xs">
        <h4 className="m-0 font-semibold">{labels.coverTemplateSave}</h4>
        {offered.length === 0 ? (
          <p className="m-0 text-(--slate)">{labels.coverTemplateNothing}</p>
        ) : (
          <>
            <PartPicker offered={offered} chosen={chosen} labels={labels} onChange={setParts} />
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={name}
                placeholder={labels.coverTemplateName}
                aria-label={labels.coverTemplateName}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void save(); }}
                className={`${INPUT} min-w-0 flex-1`}
              />
              <Button variant="outline" size="sm" disabled={!name.trim() || chosen.length === 0} onClick={() => void save()}>{labels.coverTemplateSaveButton}</Button>
            </div>
          </>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" icon={<Upload size={13} />} onClick={() => importRef.current?.click()}>{labels.coverTemplatesImport}</Button>
        {templates.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            icon={<Download size={13} />}
            onClick={() => downloadBytes(JSON.stringify(exportTemplates(templates)), 'plantillas.postext-cover-templates.json', 'application/json')}
          >
            {labels.coverTemplatesExport}
          </Button>
        )}
      </div>
      <input ref={importRef} type="file" accept=".json,application/json" className="hidden" aria-hidden="true" tabIndex={-1} onChange={(e) => void importFile(e)} />
    </Fold>
  );
}
