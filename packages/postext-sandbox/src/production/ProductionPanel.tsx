'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Trash2, Upload } from 'lucide-react';
import {
  BUILT_IN_BINDING_PROFILES,
  exportProductionProfiles,
  importProductionProfiles,
  parseIsbn,
  resolveFolioConfig,
  resolvePageConfig,
  resolveBodyTextConfig,
  resolveColorValue,
  type BindingProfile,
  type PostextConfig,
  type ProductionVersion,
  type ProductionWarning,
  type VersionSheets,
} from 'postext';
import { useBookPlan, useSandboxLabels, useSandboxSelector } from '../context/SandboxContext.js';
import { Button, ConfirmPopover, IconButton, PanelBody, PanelHeader, SegmentedControl, Select, Switch, announce, cn, type SelectOption } from '../ui/index.js';
import { bookMetadata } from '../book/compose.js';
import { downloadBytes } from '../storage/persistence.js';
import { fill } from '../print/fillTokens.js';
import {
  COVER_TEXT_ZONES,
  WORKING_BOOK,
  emptyProduction,
  metadataIsbn,
  metadataTexts,
  newVersion,
  planPageCount,
  sheetChoices,
  sheetsOf,
  type BookProduction,
  type CoverTextZone,
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
import { HEADING, INPUT, mm1, type Labels } from './productionUi.js';
import { DesignSection, ZoneStylesSection } from './CoverDesignSections.js';
import { SheetPreview } from './SheetPreview.js';

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
  const bookTextHex = useMemo(() => {
    const color = resolveBodyTextConfig(config.bodyText, config.locale).color;
    return resolveColorValue(color, config.colorPalette, { hex: '#000000', model: 'hex' }).hex.slice(0, 7).toLowerCase();
  }, [config]);
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
              bookTextHex={bookTextHex}
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

const isSheets = (s: ReturnType<typeof sheetsOf>): s is VersionSheets => 'cover' in s;
