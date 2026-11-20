'use client';

/**
 * The Cover panel's cover templates: the book's design saved by parts (a
 * collection's ground and logos, a series' type), laid by parts on
 * another book, shared as a file. A template made in InDesign comes in
 * from the import beside the sheet (./CoverIdmlImportButton.tsx).
 */

import { useRef, useState } from 'react';
import { Download, Trash2, Upload } from 'lucide-react';
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

function TemplateRow({ template, labels, onApply }: { template: CoverTemplate; labels: Labels; onApply: (t: CoverTemplate, parts: TemplatePart[]) => void }) {
  const [open, setOpen] = useState(false);
  const [parts, setParts] = useState<TemplatePart[]>(template.parts);
  return (
    <li className="flex flex-col gap-1.5 border-t border-(--rule) pt-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-semibold">{template.name}</span>
        <Button variant={open ? 'primary' : 'outline'} size="sm" onClick={() => setOpen(!open)}>{labels.coverTemplateApply}</Button>
        <ConfirmPopover message={fill(labels.productionGalleryDelete, { name: template.name })} confirmLabel={labels.productionLogoDelete} onConfirm={() => void deleteTemplate(template.id)}>
          {({ open: ask }) => <IconButton label={fill(labels.productionGalleryDelete, { name: template.name })} icon={<Trash2 size={14} aria-hidden="true" />} onClick={ask} />}
        </ConfirmPopover>
      </div>
      <p className="m-0 text-(--slate)">{template.parts.map((p) => String(labels[PART_LABEL[p]])).join(' · ')}</p>
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

export function CoverTemplatesSection({ record, gallery, library, labels, onRecord, onGallery }: {
  record: BookProduction;
  gallery: CoverGallery;
  library: readonly LogoRecord[];
  labels: Labels;
  onRecord: (next: BookProduction) => void;
  onGallery: (next: CoverGallery) => void;
}) {
  const templates = useCoverTemplates();
  const importRef = useRef<HTMLInputElement>(null);
  const offered = designParts(record.design);
  const [name, setName] = useState('');
  const [parts, setParts] = useState<TemplatePart[] | null>(null);
  const chosen = parts ?? offered;

  const save = () => {
    const n = name.trim();
    if (!n || chosen.length === 0) return;
    void putTemplates([templateFromDesign(record.design, chosen, { gallery, logos: library }, n)]);
    setName('');
    setParts(null);
    announce(fill(labels.coverTemplateSaved, { name: n }));
  };
  const apply = async (t: CoverTemplate, laid: TemplatePart[]) => {
    const out = applyTemplate(t, laid, record.design, gallery);
    onRecord({ ...record, design: out.design });
    if (out.gallery !== gallery) onGallery(out.gallery);
    const have = new Set((await listLogos().catch(() => [])).map((l) => l.id));
    await putLogos(out.logos.filter((l) => !have.has(l.id)));
    announce(fill(labels.coverTemplateApplied, { name: t.name }));
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
        {templates.map((t) => <TemplateRow key={t.id} template={t} labels={labels} onApply={(x, p) => void apply(x, p)} />)}
      </ul>

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
                onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
                className={`${INPUT} min-w-0 flex-1`}
              />
              <Button variant="outline" size="sm" disabled={!name.trim() || chosen.length === 0} onClick={save}>{labels.coverTemplateSaveButton}</Button>
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
