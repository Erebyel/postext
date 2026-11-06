'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Trash2, Upload, X } from 'lucide-react';
import {
  BUILT_IN_BINDING_PROFILES,
  exportProductionProfiles,
  importProductionProfiles,
  parseIsbn,
  registerResourceImage,
  renderPageToCanvas,
  resolveFolioConfig,
  resolvePageConfig,
  resolveBodyTextConfig,
  resolveHeadingsConfig,
  resolvePrintConfig,
  type BindingProfile,
  type PostextConfig,
  type ProductionVersion,
  type ProductionWarning,
  type Resource,
  type VDTDocument,
  type VersionSheets,
} from 'postext';
import { createPdfWorker } from 'postext-pdf/worker';
import { useBookPlan, useSandboxLabels, useSandboxSelector } from '../context/SandboxContext.js';
import { Button, ConfirmPopover, IconButton, PanelBody, PanelHeader, SegmentedControl, Select, Switch, announce, cn, type SelectOption } from '../ui/index.js';
import { bookMetadata } from '../book/compose.js';
import { ensureConfigFontsLoaded } from '../controls/fonts/fontLoader.js';
import { ensureResourceImages } from '../controls/media/resourceImages.js';
import { buildPdfResourceBytes } from '../viewport/pdf/pdfResourceBytes.js';
import { downloadBytes } from '../storage/persistence.js';
import { fill } from '../print/fillTokens.js';
import { loadPrintProfile, outputProfileBaseUrl } from '../print/printSetup.js';
import { createPdfFontProvider } from '../viewport/pdf/pdfFontProvider.js';
import { useLayoutWorker } from '../worker/useLayoutWorker.js';
import {
  COVER_TEXT_ZONES,
  DESIGN_ZONES,
  WORKING_BOOK,
  coverDocumentInput,
  emptyProduction,
  metadataIsbn,
  metadataTexts,
  newVersion,
  pickSheet,
  planPageCount,
  sheetChoices,
  sheetFileName,
  sheetsOf,
  type BookProduction,
  type CoverDesignSettings,
  type CoverTextZone,
  type DesignZone,
  type RoleStyle,
  type TextRole,
  type ZoneStyle,
  type SheetChoice,
} from './bookProduction.js';
import {
  deleteProfile,
  getBookProduction,
  listProfiles,
  onProductionChange,
  putBookProduction,
  putProfiles,
  type StoredProfile,
} from './productionStore.js';

type Labels = ReturnType<typeof useSandboxLabels>;

const BUILT_IN_LABEL: Record<string, keyof Labels> = {
  perfect: 'productionProfilePerfect',
  'sewn-softcover': 'productionProfileSewn',
  'case-flat': 'productionProfileCaseFlat',
  'case-round': 'productionProfileCaseRound',
};

const ZONE_LABEL: Record<CoverTextZone, keyof Labels> = {
  front: 'productionZoneFront',
  spine: 'productionZoneSpine',
  back: 'productionZoneBack',
  flapFront: 'productionZoneFlapFront',
  flapBack: 'productionZoneFlapBack',
};

const MEASURE_LABEL = {
  trimWidth: 'productionMeasureTrimWidth',
  trimHeight: 'productionMeasureTrimHeight',
  spine: 'productionMeasureSpine',
} as const satisfies Record<string, keyof Labels>;

const INPUT = 'rounded border border-(--pt-control-border) bg-(--background) px-2 py-1 text-xs text-(--foreground)';
const HEADING = 'm-0 text-[0.72rem] font-semibold tracking-[0.12em] text-(--slate) pt-caps';

const mm1 = (n: number) => (Math.round(n * 10) / 10).toLocaleString();

/** The book's production record, kept current and saved on change. */
function useBookProduction(projectId: string): [BookProduction | null, (next: BookProduction) => void] {
  const [record, setRecord] = useState<BookProduction | null>(null);
  useEffect(() => {
    let alive = true;
    setRecord(null);
    getBookProduction(projectId).then(
      (r) => { if (alive) setRecord(r ?? emptyProduction(projectId)); },
      () => { if (alive) setRecord(emptyProduction(projectId)); },
    );
    return () => { alive = false; };
  }, [projectId]);
  // Texts are saved a moment after typing stops; the rest at once.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const update = useCallback((next: BookProduction) => {
    setRecord(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void putBookProduction(next).catch(() => undefined); }, 400);
  }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return [record, update];
}

function useProfiles(): StoredProfile[] {
  const [list, setList] = useState<StoredProfile[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => { listProfiles().then((l) => { if (alive) setList(l); }, () => undefined); };
    load();
    const off = onProductionChange(load);
    return () => { alive = false; off(); };
  }, []);
  return list;
}

function warningText(w: ProductionWarning, labels: Labels): string {
  switch (w.kind) {
    case 'signatureBlanks': return fill(labels.productionWarningBlanks, { count: String(w.blanks) });
    case 'profileOutOfRange': return fill(labels.productionWarningOutOfRange, {
      measure: String(labels[MEASURE_LABEL[w.measure]]), value: mm1(w.value), limit: mm1(w.limit),
    });
    case 'spineTooThinForText': return fill(labels.productionWarningThinSpine, { spine: mm1(w.spine), min: mm1(w.minSpine) });
    case 'spineOverridden': return fill(labels.productionWarningOverride, { used: mm1(w.used), calculated: mm1(w.calculated) });
    case 'bindingProfileMissing': return fill(labels.productionWarningProfileMissing, { name: w.profile });
    case 'isbnInvalid': return labels.productionIsbnInvalid;
  }
}

/** Decode the sheet's own pictures (the barcode) for the canvas. */
async function registerCoverImages(files: Record<string, Uint8Array>): Promise<void> {
  await Promise.all(Object.entries(files).map(async ([fileId, bytes]) => {
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new TextDecoder().decode(bytes))}`;
    await img.decode().catch(() => undefined);
    registerResourceImage(fileId, img, { vector: true, singleInk: false });
  }));
}

/**
 * The Cover panel: the versions the book is made in (a paperback, a
 * hardcover…), each with its binding and ISBN; the spine worked out from
 * the book's pages and paper; the cover's texts; a preview of each sheet
 * (cover or case, jacket, endpapers) and its print-ready PDF; and the
 * user's library of paper and binding profiles, shared as files.
 */
export function ProductionPanel() {
  const labels = useSandboxLabels();
  const config = useSandboxSelector((s) => s.config);
  const activeProjectId = useSandboxSelector((s) => s.activeProjectId);
  const projects = useSandboxSelector((s) => s.projects);
  const plan = useBookPlan();
  const chapters = useSandboxSelector((s) => s.chapters);
  const bookResources = useSandboxSelector((s) => s.resources);
  // The book the cover belongs to: its title, subtitle, author and ISBN
  // come from the first chapter's front matter.
  const metadata = useMemo(() => bookMetadata(chapters) as Record<string, unknown>, [chapters]);
  const fromBook = useMemo(() => metadataTexts(metadata), [metadata]);
  const projectId = activeProjectId ?? WORKING_BOOK;
  const [record, update] = useBookProduction(projectId);
  const stored = useProfiles();
  const importRef = useRef<HTMLInputElement>(null);

  const bindings = useMemo(() => stored.flatMap((p) => (p.kind === 'binding' ? [p.profile] : [])), [stored]);
  const papers = useMemo(() => stored.flatMap((p) => (p.kind === 'paper' ? [p.profile] : [])), [stored]);
  const complete = plan.chapters.length > 0 && plan.chapters.every((c) => plan.bookPages[c.chapterId]);
  const pages = planPageCount(plan.bookPages);

  const versions = record?.versions ?? [];
  const version = versions.find((v) => v.id === record?.activeVersionId) ?? versions[0];
  const sheets = useMemo(
    () => (version && pages > 0 ? sheetsOf(version, config, pages, bindings) : null),
    [version, config, pages, bindings],
  );
  const ready = sheets && isSheets(sheets) ? sheets : null;
  const [choice, setChoice] = useState<SheetChoice>('cover');
  const choices = ready ? sheetChoices(ready) : [];
  const shown: SheetChoice = choices.includes(choice) ? choice : 'cover';

  const setVersion = (next: ProductionVersion) => {
    if (!record) return;
    update({ ...record, versions: record.versions.map((v) => (v.id === next.id ? next : v)) });
  };
  const addVersion = (kind: 'paperback' | 'hardcover') => {
    if (!record) return;
    const v = newVersion(kind, kind === 'paperback' ? labels.productionPaperbackName : labels.productionHardcoverName);
    // The first version starts from what the book says of itself.
    const first = record.versions.length === 0;
    const isbn = first ? metadataIsbn(metadata) : undefined;
    const texts = first && Object.keys(record.texts).length === 0 ? fromBook : record.texts;
    update({ ...record, texts, versions: [...record.versions, isbn ? { ...v, isbn } : v], activeVersionId: v.id });
  };
  const removeVersion = (id: string) => {
    if (!record) return;
    const rest = record.versions.filter((v) => v.id !== id);
    const base: BookProduction = { ...record, versions: rest };
    delete base.activeVersionId;
    update(rest[0] ? { ...base, activeVersionId: rest[0].id } : base);
  };

  const bindingOptions: SelectOption<string>[] = [
    ...BUILT_IN_BINDING_PROFILES.map((p) => ({ value: p.id, label: String(labels[BUILT_IN_LABEL[p.id] ?? 'productionBuiltin']) })),
    ...bindings.map((p) => ({ value: p.id, label: p.printer ? `${p.name} · ${p.printer}` : p.name })),
  ];

  const importFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const read = importProductionProfiles(JSON.parse(await file.text()));
      const count = read.papers.length + read.bindings.length;
      if (count === 0) {
        announce(labels.productionImportFailed);
        return;
      }
      await putProfiles(read.papers, read.bindings);
      announce(fill(labels.productionImported, { count: String(count) }));
    } catch {
      announce(labels.productionImportFailed);
    }
  };
  const exportFile = () => {
    downloadBytes(JSON.stringify(exportProductionProfiles(papers, bindings), null, 2), 'profiles.postext-production.json', 'application/json');
  };

  const metaTitle = typeof metadata.title === 'string' ? metadata.title.trim() : '';
  const title = projects.find((p) => p.id === activeProjectId)?.name ?? (metaTitle || 'book');
  const fillFromBook = () => record && update({ ...record, texts: { ...record.texts, ...fromBook } });
  const hasOwnText = !!(record?.texts.front?.trim() || record?.texts.spine?.trim());

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title={labels.navProduction}
        actions={
          <>
            <IconButton label={labels.productionImport} icon={<Upload size={14} />} onClick={() => importRef.current?.click()} />
            <input ref={importRef} type="file" accept=".json,application/json" className="hidden" aria-hidden="true" tabIndex={-1} onChange={(e) => void importFile(e)} />
          </>
        }
      />
      <PanelBody padded>
        <div className="flex flex-col gap-4" style={{ fontSize: 13, lineHeight: '19px' }}>
          <p className="m-0 text-xs font-semibold" style={{ overflowWrap: 'anywhere' }}>{fill(labels.productionForBook, { name: title })}</p>
          <p className="m-0 text-xs text-(--slate)">{labels.productionIntro}</p>

          <section className="flex flex-col gap-2">
            <h3 className={HEADING}>{labels.productionVersions}</h3>
            {versions.length === 0 && <p className="m-0 text-xs text-(--slate)">{labels.productionNoVersions}</p>}
            {versions.length > 1 && version && (
              <SegmentedControl
                size="sm"
                value={version.id}
                onValueChange={(id) => record && update({ ...record, activeVersionId: id })}
                options={versions.map((v) => ({ value: v.id, label: v.name }))}
                ariaLabel={labels.productionVersions}
              />
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" disabled={!record} onClick={() => addVersion('paperback')}>{labels.productionAddPaperback}</Button>
              <Button variant="outline" size="sm" disabled={!record} onClick={() => addVersion('hardcover')}>{labels.productionAddHardcover}</Button>
            </div>
          </section>

          {version && (
            <VersionForm
              key={version.id}
              version={version}
              labels={labels}
              bindingOptions={bindingOptions}
              library={bindings}
              onChange={setVersion}
              onDelete={() => removeVersion(version.id)}
            />
          )}

          {version && (
            <section className="flex flex-col gap-1 rounded-lg border border-(--rule) p-3">
              <h3 className={HEADING}>{labels.productionSpine}</h3>
              {!complete || !ready ? (
                <p className="m-0 text-xs text-(--slate)">{labels.productionSpinePending}</p>
              ) : (
                <SpineSummary config={config} sheets={ready} labels={labels} />
              )}
              {sheets && sheets.warnings.length > 0 && (
                <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs">
                  {sheets.warnings.map((w, i) => <li key={i} className="text-(--slate)">{warningText(w, labels)}</li>)}
                </ul>
              )}
            </section>
          )}

          {version && record && (
            <section className="flex flex-col gap-2">
              <h3 className={HEADING}>{labels.productionTexts}</h3>
              <p className="m-0 text-xs text-(--slate)">{labels.productionTextsIntro}</p>
              {fromBook.front && (
                hasOwnText ? (
                  <ConfirmPopover message={labels.productionFromBookConfirm} confirmLabel={labels.productionFromBook} onConfirm={fillFromBook}>
                    {({ open }) => <Button variant="outline" size="sm" onClick={open}>{labels.productionFromBook}</Button>}
                  </ConfirmPopover>
                ) : (
                  <Button variant="outline" size="sm" onClick={fillFromBook}>{labels.productionFromBook}</Button>
                )
              )}
              {COVER_TEXT_ZONES.filter((zone) => !zone.startsWith('flap') || versions.some((v) => v.flaps)).map((zone) => (
                <label key={zone} className="flex flex-col gap-1 text-xs">
                  {String(labels[ZONE_LABEL[zone]])}
                  <textarea
                    rows={zone === 'spine' ? 1 : 3}
                    value={record.texts[zone] ?? ''}
                    placeholder={fromBook[zone] ?? ''}
                    onChange={(e) => update({ ...record, texts: { ...record.texts, [zone]: e.target.value } })}
                    className={cn(INPUT, 'font-mono')}
                  />
                </label>
              ))}
            </section>
          )}

          {version && record && (
            <DesignSection
              design={record.design ?? {}}
              resources={bookResources}
              labels={labels}
              onChange={(design) => update({ ...record, design })}
            />
          )}

          {version && record && (
            <ZoneStylesSection
              design={record.design ?? {}}
              config={config}
              hasFlaps={versions.some((v) => v.flaps)}
              labels={labels}
              onChange={(design) => update({ ...record, design })}
            />
          )}

          {version && record && ready && complete && (
            <SheetPreview
              config={config}
              version={version}
              texts={record.texts}
              design={record.design}
              bookResources={bookResources}
              sheets={ready}
              choices={choices}
              shown={shown}
              onChoose={setChoice}
              labels={labels}
              fileTitle={title}
            />
          )}

          <section className="flex flex-col gap-2 rounded-lg border border-(--rule) p-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="m-0 text-xs font-semibold">{labels.productionLibrary}</h3>
              {stored.length > 0 && (
                <IconButton label={labels.productionExportProfiles} icon={<Download size={14} aria-hidden="true" />} onClick={exportFile} />
              )}
            </div>
            <p className="m-0 text-xs text-(--slate)">{labels.productionLibraryIntro}</p>
            {stored.length === 0 && <p className="m-0 text-xs text-(--slate)">{labels.productionLibraryEmpty}</p>}
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs">
              {stored.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate">
                    {p.kind === 'paper' ? `${labels.productionPaperProfile}: ` : `${labels.productionBinding}: `}
                    {p.profile.name}
                    {p.kind === 'paper' && p.profile.grammage ? ` · ${p.profile.grammage} g/m²` : ''}
                  </span>
                  <ConfirmPopover message={`${labels.productionDeleteProfile}: ${p.profile.name}`} confirmLabel={labels.productionDeleteProfile} onConfirm={() => void deleteProfile(p.id)}>
                    {({ open }) => <IconButton label={`${labels.productionDeleteProfile}: ${p.profile.name}`} icon={<Trash2 size={14} aria-hidden="true" />} onClick={open} />}
                  </ConfirmPopover>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </PanelBody>
    </div>
  );
}

function VersionForm({ version, labels, bindingOptions, library, onChange, onDelete }: {
  version: ProductionVersion;
  labels: Labels;
  bindingOptions: SelectOption<string>[];
  library: readonly BindingProfile[];
  onChange: (v: ProductionVersion) => void;
  onDelete: () => void;
}) {
  const bindingId = typeof version.binding === 'string' ? version.binding : version.binding.id;
  const profile = BUILT_IN_BINDING_PROFILES.find((p) => p.id === bindingId) ?? library.find((p) => p.id === bindingId);
  const isCase = profile?.style === 'caseFlat' || profile?.style === 'caseRound';
  const isbnBad = !!version.isbn?.trim() && !parseIsbn(version.isbn).ok;
  const [override, setOverride] = useState(version.spineOverride !== undefined ? String(version.spineOverride) : '');
  const without = <K extends keyof ProductionVersion>(key: K): ProductionVersion => {
    const rest = { ...version };
    delete rest[key];
    return rest;
  };

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-(--rule) p-3">
      <div className="flex items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
          {labels.productionVersionName}
          <input type="text" value={version.name} onChange={(e) => onChange({ ...version, name: e.target.value })} className={INPUT} />
        </label>
        <ConfirmPopover message={fill(labels.productionDeleteVersionConfirm, { name: version.name })} confirmLabel={labels.productionDeleteVersion} onConfirm={onDelete}>
          {({ open }) => <IconButton label={`${labels.productionDeleteVersion}: ${version.name}`} icon={<Trash2 size={14} aria-hidden="true" />} onClick={open} />}
        </ConfirmPopover>
      </div>
      <label className="flex flex-col gap-1 text-xs">
        {labels.productionIsbn}
        <input
          type="text"
          inputMode="numeric"
          value={version.isbn ?? ''}
          placeholder="978-84-…"
          aria-invalid={isbnBad || undefined}
          onChange={(e) => onChange(e.target.value.trim() ? { ...version, isbn: e.target.value } : without('isbn'))}
          className={cn(INPUT, isbnBad && 'border-(--danger,#c0392b)')}
        />
        {isbnBad && <span role="alert" className="text-(--danger,#c0392b)">{labels.productionIsbnInvalid}</span>}
      </label>
      <label className="flex flex-col gap-1 text-xs">
        {labels.productionBinding}
        <Select size="sm" value={bindingId} onValueChange={(id) => onChange({ ...version, binding: id })} options={bindingOptions} ariaLabel={labels.productionBinding} />
      </label>
      <label className="flex items-center justify-between gap-2 text-xs">
        {isCase ? labels.productionJacket : labels.productionFlaps}
        <Switch checked={!!version.flaps} onCheckedChange={(on) => onChange(on ? { ...version, flaps: true } : without('flaps'))} ariaLabel={isCase ? labels.productionJacket : labels.productionFlaps} />
      </label>
      {isCase && (
        <div className="flex flex-col gap-1 text-xs">
          {labels.productionCaseMaterial}
          <SegmentedControl
            size="sm"
            value={version.caseMaterial ?? 'printed'}
            onValueChange={(m) => onChange({ ...version, caseMaterial: m })}
            options={[{ value: 'printed', label: labels.productionCasePrinted }, { value: 'cloth', label: labels.productionCaseCloth }]}
            ariaLabel={labels.productionCaseMaterial}
          />
        </div>
      )}
      <div className="flex flex-col gap-1 text-xs">
        {labels.productionSpineDirection}
        <SegmentedControl
          size="sm"
          value={version.spineText?.direction ?? 'bottomToTop'}
          onValueChange={(d) => onChange({ ...version, spineText: { ...version.spineText, direction: d } })}
          options={[{ value: 'bottomToTop', label: labels.productionSpineUp }, { value: 'topToBottom', label: labels.productionSpineDown }]}
          ariaLabel={labels.productionSpineDirection}
        />
      </div>
      <label className="flex flex-col gap-1 text-xs">
        {labels.productionSpineOverride}
        <input
          type="number"
          min={0}
          step={0.1}
          value={override}
          onChange={(e) => {
            setOverride(e.target.value);
            const n = Number(e.target.value);
            onChange(e.target.value.trim() && Number.isFinite(n) && n > 0 ? { ...version, spineOverride: n } : without('spineOverride'));
          }}
          className={INPUT}
        />
        <span className="text-(--slate)">{labels.productionSpineOverrideHint}</span>
      </label>
    </section>
  );
}

function SpineSummary({ config, sheets, labels }: {
  config: PostextConfig;
  sheets: VersionSheets;
  labels: Labels;
}) {
  const paper = resolveFolioConfig(config.folio, resolvePageConfig(config.page).sizePreset).paper;
  const s = sheets.spine;
  return (
    <>
      <p className="m-0 text-xs">
        {fill(labels.productionSpineSummary, {
          pages: String(s.pages),
          grammage: String(paper.grammage),
          bulk: String(paper.bulk),
          block: mm1(s.block),
          spine: mm1(s.used),
        })}
      </p>
      {s.caseSpine !== undefined && <p className="m-0 text-xs">{fill(labels.productionSpineCase, { spine: mm1(s.caseSpine) })}</p>}
    </>
  );
}

const DESIGN_ZONE_LABEL: Record<DesignZone, keyof Labels> = {
  front: 'productionZoneFront',
  spine: 'productionZoneSpine',
  back: 'productionZoneBack',
  flaps: 'productionDesignFlaps',
};

/** A colour or none: the swatch, and a button that clears it. */
function ColorField({ label, value, clearLabel, onChange }: {
  label: string;
  value: string | undefined;
  clearLabel: string;
  onChange: (hex: string | undefined) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span>{label}</span>
      <span className="flex items-center gap-1">
        <input
          type="color"
          aria-label={label}
          value={value ?? '#ffffff'}
          onChange={(e) => onChange(e.target.value)}
          className={cn('h-6 w-9 cursor-pointer rounded border border-(--pt-control-border) bg-transparent p-0', !value && 'opacity-40')}
        />
        {value && <IconButton label={`${clearLabel}: ${label}`} icon={<X size={12} aria-hidden="true" />} onClick={() => onChange(undefined)} />}
      </span>
    </div>
  );
}

/** The cover's look, shared by every version: a ground for the whole
 *  sheet, one of the book's pictures over it, a ground per zone, and the
 *  colour of the text. */
function DesignSection({ design, resources, labels, onChange }: {
  design: CoverDesignSettings;
  resources: readonly Resource[];
  labels: Labels;
  onChange: (d: CoverDesignSettings) => void;
}) {
  const pictures = resources.filter((r) => r.kind === 'bitmap' || r.kind === 'svg');
  const NONE = '__none__';
  const set = <K extends keyof CoverDesignSettings>(key: K, value: CoverDesignSettings[K] | undefined) => {
    const next = { ...design };
    if (value === undefined) delete next[key];
    else next[key] = value;
    onChange(next);
  };
  const setZone = (zone: DesignZone, hex: string | undefined) => {
    const zones = { ...design.zones };
    if (hex) zones[zone] = hex;
    else delete zones[zone];
    set('zones', Object.keys(zones).length > 0 ? zones : undefined);
  };
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-(--rule) p-3">
      <h3 className={HEADING}>{labels.productionDesign}</h3>
      <p className="m-0 text-xs text-(--slate)">{labels.productionDesignIntro}</p>
      <ColorField label={labels.productionDesignBackground} value={design.background} clearLabel={labels.productionDesignClear} onChange={(v) => set('background', v)} />
      <label className="flex flex-col gap-1 text-xs">
        {labels.productionDesignImage}
        <Select
          size="sm"
          value={design.image?.resourceId ?? NONE}
          onValueChange={(id) => set('image', id === NONE ? undefined : { resourceId: id, ...(design.image?.area ? { area: design.image.area } : {}) })}
          options={[
            { value: NONE, label: labels.productionDesignNoImage },
            ...pictures.map((r) => ({ value: r.id, label: r.caption?.trim() || r.altText?.trim() || r.id })),
          ]}
          ariaLabel={labels.productionDesignImage}
        />
      </label>
      {design.image && (
        <SegmentedControl
          size="sm"
          value={design.image.area ?? 'sheet'}
          onValueChange={(area) => set('image', { resourceId: design.image!.resourceId, ...(area === 'front' ? { area } : {}) })}
          options={[{ value: 'sheet', label: labels.productionDesignImageSheet }, { value: 'front', label: labels.productionDesignImageFront }]}
          ariaLabel={labels.productionDesignImage}
        />
      )}
      <p className="m-0 mt-1 text-xs text-(--slate)">{labels.productionDesignZones}</p>
      {DESIGN_ZONES.map((zone) => (
        <ColorField
          key={zone}
          label={String(labels[DESIGN_ZONE_LABEL[zone]])}
          value={design.zones?.[zone]}
          clearLabel={labels.productionDesignClear}
          onChange={(v) => setZone(zone, v)}
        />
      ))}
      <ColorField label={labels.productionDesignTextColor} value={design.textColor} clearLabel={labels.productionDesignClear} onChange={(v) => set('textColor', v)} />
    </section>
  );
}

/** The type families the book uses: its body, its headings and the fonts
 *  it carries. */
function bookFamilies(config: PostextConfig): string[] {
  const out = new Set<string>();
  out.add(resolveBodyTextConfig(config.bodyText, config.locale).fontFamily);
  const headings = resolveHeadingsConfig(config.headings);
  out.add(headings.fontFamily);
  for (const l of headings.levels) out.add(l.fontFamily);
  for (const f of config.customFonts ?? []) out.add(f.name);
  return [...out].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

function RoleFields({ role, style, families, labels, onChange }: {
  role: TextRole;
  style: RoleStyle;
  families: string[];
  labels: Labels;
  onChange: (s: RoleStyle) => void;
}) {
  const BOOK = '__book__';
  const set = <K extends keyof RoleStyle>(key: K, value: RoleStyle[K] | undefined) => {
    const next = { ...style };
    if (value === undefined) delete next[key];
    else next[key] = value;
    onChange(next);
  };
  const legend = role === 'title' ? labels.productionStyleTitle : labels.productionStyleText;
  return (
    <fieldset className="m-0 flex flex-col gap-2 rounded border border-(--rule) p-2">
      <legend className="px-1 text-xs font-semibold">{legend}</legend>
      <label className="flex flex-col gap-1 text-xs">
        {labels.productionStyleFont}
        <Select
          size="sm"
          value={style.fontFamily ?? BOOK}
          onValueChange={(f) => set('fontFamily', f === BOOK ? undefined : f)}
          options={[{ value: BOOK, label: labels.productionStyleBookFont }, ...families.map((f) => ({ value: f, label: f }))]}
          ariaLabel={`${legend}: ${labels.productionStyleFont}`}
        />
      </label>
      <div className="flex items-center justify-between gap-2 text-xs">
        <label className="flex items-center gap-2">
          {labels.productionStyleSize}
          <input
            type="number"
            min={4}
            max={300}
            step={0.5}
            value={style.fontSize ?? ''}
            placeholder="—"
            onChange={(e) => {
              const n = Number(e.target.value);
              set('fontSize', e.target.value.trim() && Number.isFinite(n) && n > 0 ? n : undefined);
            }}
            className={cn(INPUT, 'w-16')}
          />
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={!!style.bold} onChange={(e) => set('bold', e.target.checked || undefined)} />
          {labels.productionStyleBold}
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={!!style.italic} onChange={(e) => set('italic', e.target.checked || undefined)} />
          {labels.productionStyleItalic}
        </label>
      </div>
      <SegmentedControl
        size="sm"
        value={style.align ?? 'left'}
        onValueChange={(a) => set('align', a === 'left' ? undefined : a)}
        options={[
          { value: 'left', label: labels.productionAlignLeft },
          { value: 'center', label: labels.productionAlignCenter },
          { value: 'right', label: labels.productionAlignRight },
          { value: 'justify', label: labels.productionAlignJustify },
        ]}
        ariaLabel={`${legend}: ${labels.productionStyleAlign}`}
      />
    </fieldset>
  );
}

/** The type of each zone: its title and its text, and where they sit. */
function ZoneStylesSection({ design, config, hasFlaps, labels, onChange }: {
  design: CoverDesignSettings;
  config: PostextConfig;
  hasFlaps: boolean;
  labels: Labels;
  onChange: (d: CoverDesignSettings) => void;
}) {
  const zones = DESIGN_ZONES.filter((z) => z !== 'flaps' || hasFlaps);
  const [zone, setZone] = useState<DesignZone>('front');
  const shown = zones.includes(zone) ? zone : 'front';
  const families = useMemo(() => bookFamilies(config), [config]);
  const current: ZoneStyle = design.zoneStyles?.[shown] ?? {};
  const setStyle = (next: ZoneStyle) => {
    const all = { ...design.zoneStyles };
    if (Object.keys(next).length > 0) all[shown] = next;
    else delete all[shown];
    const d = { ...design };
    if (Object.keys(all).length > 0) d.zoneStyles = all;
    else delete d.zoneStyles;
    onChange(d);
  };
  const setRole = (role: TextRole, s: RoleStyle) => {
    const next = { ...current };
    if (Object.keys(s).length > 0) next[role] = s;
    else delete next[role];
    setStyle(next);
  };
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-(--rule) p-3">
      <h3 className={HEADING}>{labels.productionStyles}</h3>
      <p className="m-0 text-xs text-(--slate)">{labels.productionStylesIntro}</p>
      <SegmentedControl
        size="sm"
        value={shown}
        onValueChange={setZone}
        options={zones.map((z) => ({ value: z, label: String(labels[DESIGN_ZONE_LABEL[z]]) }))}
        ariaLabel={labels.productionStyles}
      />
      <RoleFields role="title" style={current.title ?? {}} families={families} labels={labels} onChange={(s) => setRole('title', s)} />
      <RoleFields role="text" style={current.text ?? {}} families={families} labels={labels} onChange={(s) => setRole('text', s)} />
      {shown !== 'spine' && (
        <div className="flex flex-col gap-1 text-xs">
          {labels.productionStyleVertical}
          <SegmentedControl
            size="sm"
            value={current.vertical ?? 'top'}
            onValueChange={(v) => {
              const next = { ...current };
              if (v === 'top') delete next.vertical;
              else next.vertical = v;
              setStyle(next);
            }}
            options={[
              { value: 'top', label: labels.productionVerticalTop },
              { value: 'middle', label: labels.productionVerticalMiddle },
              { value: 'bottom', label: labels.productionVerticalBottom },
            ]}
            ariaLabel={labels.productionStyleVertical}
          />
        </div>
      )}
    </section>
  );
}

const SHEET_LABEL: Record<SheetChoice, keyof Labels> = {
  cover: 'productionSheetCover',
  jacket: 'productionSheetJacket',
  endpaperFront: 'productionSheetEndpaperFront',
  endpaperBack: 'productionSheetEndpaperBack',
};

function SheetPreview({ config, version, texts, design, bookResources, sheets, choices, shown, onChoose, labels, fileTitle }: {
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
  const sheet = pickSheet(sheets, shown);
  const input = useMemo(
    () => coverDocumentInput(sheet, version, texts, config, design, bookResources),
    [sheet, version, texts, config, design, bookResources],
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

  const exportPdf = async () => {
    if (!built || built.input !== input) return;
    setBusy(true);
    announce(labels.productionExporting);
    try {
      const print = resolvePrintConfig(config.print);
      const outputProfile = print.standard !== 'none'
        ? await loadPrintProfile(print).then((p) => p.bytes, () => undefined)
        : undefined;
      const resourceBytes = await buildPdfResourceBytes(built.input.resources.filter((r) => r.id !== 'isbn-barcode'), config);
      for (const [fileId, bytes] of Object.entries(built.input.cover.files)) resourceBytes.set(fileId, bytes);
      const worker = createPdfWorker();
      try {
        const bytes = await worker.render([built.doc], {
          fontProvider: createPdfFontProvider(),
          resourceBytes,
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
        {(isCaseCover ? labels.productionSheetCase : String(labels[SHEET_LABEL[shown]]))} · {fill(labels.productionSheetSize, { width: mm1(sheet.width), height: mm1(sheet.height) })}
      </p>
      <div ref={wrapRef} className="w-full overflow-hidden rounded border border-(--rule) bg-white">
        {failed ? <p className="m-0 p-2 text-xs text-(--slate)">{labels.productionPreviewFailed}</p> : <canvas ref={canvasRef} className="block" />}
      </div>
      <div className="flex justify-end">
        <Button variant="primary" size="sm" disabled={!built || built.input !== input || busy} onClick={() => void exportPdf()}>
          {busy ? labels.productionExporting : labels.productionExportPdf}
        </Button>
      </div>
    </section>
  );
}

const isCaseCoverOf = (sheets: VersionSheets) => sheets.cover.kind === 'case';

const isSheets = (s: ReturnType<typeof sheetsOf>): s is VersionSheets => 'cover' in s;
