'use client';

/**
 * The cover designer: the cover of the book's active version on a canvas
 * of its own, over the whole Sandbox. It opens on the preview — the sheet
 * as it will print, its guides and what to check before it goes to the
 * printer — and from there to editing, and back. Editing works in fixed
 * layers, bottom to top (./coverLayers.ts): the background, the movable
 * elements, the editable texts; effects, logos and finishes come later.
 * Each layer can be hidden while working. It is opened from the Cover
 * panel and from the book's preview (./coverDesignerStore.ts).
 */

import { useMemo, useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { ArrowDown, ArrowUp, Eye, EyeOff, Image as ImageIcon, Square, Trash2, X } from 'lucide-react';
import type { CoverZoneName, Resource } from 'postext';
import { useSandboxLabels, useSandboxSelector } from '../context/SandboxContext.js';
import { Button, IconButton, NumberField, SegmentedControl, Select, cn, usePortalContainer } from '../ui/index.js';
import { POPUP_Z_INDEX } from '../ui/layout/surface.js';
import { fill } from '../print/fillTokens.js';
import { bookTrimMm, coverDocumentInput, pickSheet, type CoverDesignSettings } from './bookProduction.js';
import {
  COVER_LAYERS,
  READY_LAYERS,
  coverElementIssues,
  elementAt,
  elementRect,
  newElement,
  pictureAspect,
  restack,
  type CoverElementSetting,
  type CoverLayer,
} from './coverLayers.js';
import { CoverCanvas } from './CoverCanvas.js';
import { closeCoverDesigner, useCoverDesignerOpen } from './coverDesignerStore.js';
import { useCoverWorkspace } from './useProduction.js';
import type { Labels } from './productionUi.js';

const LAYER_LABEL: Record<CoverLayer, keyof Labels> = {
  background: 'coverLayerBackground',
  elements: 'coverLayerElements',
  texts: 'coverLayerTexts',
  effects: 'coverLayerEffects',
  logos: 'coverLayerLogos',
  finishes: 'coverLayerFinishes',
};

const ZONE_LABEL: Partial<Record<CoverZoneName, keyof Labels>> = {
  front: 'productionZoneFront',
  back: 'productionZoneBack',
  spine: 'productionZoneSpine',
  flapFront: 'productionZoneFlapFront',
  flapBack: 'productionZoneFlapBack',
  jointFront: 'coverZoneJoint',
  jointBack: 'coverZoneJoint',
};

const SIDE = 'flex w-64 shrink-0 flex-col gap-3 overflow-y-auto border-(--rule) p-3 text-xs';
const isPicture = (r: Resource) => r.kind === 'bitmap' || r.kind === 'svg';

export function CoverDesignerHost() {
  return useCoverDesignerOpen() ? <CoverDesigner /> : null;
}

function CoverDesigner() {
  const labels = useSandboxLabels();
  const config = useSandboxSelector((s) => s.config);
  const bookResources = useSandboxSelector((s) => s.resources);
  const container = usePortalContainer();
  const { record, update, version, sheets } = useCoverWorkspace();
  const [mode, setMode] = useState<'preview' | 'edit'>('preview');
  const [hidden, setHidden] = useState<ReadonlySet<CoverLayer>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);

  const design = useMemo(() => record?.design ?? {}, [record]);
  const elements = useMemo(() => design.elements ?? [], [design]);
  const sheet = useMemo(() => (sheets ? pickSheet(sheets, 'cover', bookTrimMm(config)) : null), [sheets, config]);
  const input = useMemo(
    () => (sheet && version && record ? coverDocumentInput(sheet, version, record.texts, config, design, bookResources, { hidden }) : null),
    [sheet, version, record, config, design, bookResources, hidden],
  );
  const pictures = useMemo(() => bookResources.filter(isPicture), [bookResources]);
  const issues = useMemo(() => (sheet ? coverElementIssues(sheet, elements, bookResources) : []), [sheet, elements, bookResources]);

  const setElements = (next: CoverElementSetting[]) => {
    if (!record) return;
    const d: CoverDesignSettings = { ...design, elements: next };
    if (next.length === 0) delete d.elements;
    update({ ...record, design: d });
  };
  const changeElement = (el: CoverElementSetting) => setElements(elements.map((e) => (e.id === el.id ? el : e)));
  const deleteElement = (id: string) => {
    setElements(elements.filter((e) => e.id !== id));
    if (selected === id) setSelected(null);
  };
  const add = (el: CoverElementSetting | undefined) => {
    if (!el) return;
    setElements([...elements, el]);
    setSelected(el.id);
    setMode('edit');
  };
  const toggle = (layer: CoverLayer) => {
    const next = new Set(hidden);
    if (next.has(layer)) next.delete(layer);
    else next.add(layer);
    setHidden(next);
  };
  const zoneName = (z: CoverZoneName) => (ZONE_LABEL[z] ? String(labels[ZONE_LABEL[z]!]) : z);
  const selectedEl = elements.find((e) => e.id === selected);

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) closeCoverDesigner(); }}>
      <Dialog.Portal container={container}>
        <Dialog.Popup
          data-postext-popup=""
          aria-label={labels.coverDesignerTitle}
          className="fixed inset-0 flex flex-col bg-(--background) text-(--foreground)"
          // Under the popovers and menus it opens itself (its selects).
          style={{ zIndex: POPUP_Z_INDEX - 1, fontSize: 13, lineHeight: '19px' }}
        >
          <header className="flex items-center gap-3 border-b border-(--rule) px-3 py-2">
            <Dialog.Title className="m-0 text-sm font-semibold">{labels.coverDesignerTitle}</Dialog.Title>
            {version && <span className="text-xs text-(--slate)">{version.name}</span>}
            <div className="ms-auto flex items-center gap-2">
              <SegmentedControl
                size="sm"
                value={mode}
                onValueChange={setMode}
                options={[{ value: 'preview', label: labels.coverDesignerPreview }, { value: 'edit', label: labels.coverDesignerEdit }]}
                ariaLabel={labels.coverDesignerMode}
              />
              <IconButton label={labels.coverDesignerClose} icon={<X size={16} aria-hidden="true" />} onClick={closeCoverDesigner} />
            </div>
          </header>

          {!sheet || !input ? (
            <p className="m-auto max-w-sm p-4 text-center text-sm text-(--slate)">{labels.coverDesignerNoSheet}</p>
          ) : (
            <div className="flex min-h-0 flex-1">
              <aside className={cn(SIDE, 'border-e')} aria-label={labels.coverDesignerLayers}>
                <h3 className="m-0 text-xs font-semibold uppercase tracking-wide text-(--slate)">{labels.coverDesignerLayers}</h3>
                {[...COVER_LAYERS].reverse().map((layer) => {
                  const name = String(labels[LAYER_LABEL[layer]]);
                  const ready = READY_LAYERS.has(layer);
                  return (
                    <section key={layer} className={cn('flex flex-col gap-2 rounded-md border border-(--rule) p-2', !ready && 'opacity-60')}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{name}</span>
                        {ready ? (
                          <IconButton
                            label={fill(hidden.has(layer) ? labels.coverLayerShow : labels.coverLayerHide, { layer: name })}
                            icon={hidden.has(layer) ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
                            onClick={() => toggle(layer)}
                          />
                        ) : (
                          <span className="text-[11px] text-(--slate)">{labels.coverLayerSoon}</span>
                        )}
                      </div>
                      {layer === 'background' && <p className="m-0 text-(--slate)">{labels.coverLayerBackgroundHint}</p>}
                      {layer === 'texts' && <p className="m-0 text-(--slate)">{labels.coverLayerTextsHint}</p>}
                      {layer === 'elements' && (
                        <>
                          {pictures.length > 0 ? (
                            <Select
                              size="sm"
                              value=""
                              onValueChange={(id) => { const picture = pictures.find((p) => p.id === id); if (picture) add(newElement(sheet, 'image', picture)); }}
                              options={[{ value: '', label: labels.coverAddPicture }, ...pictures.map((p) => ({ value: p.id, label: p.id }))]}
                              ariaLabel={labels.coverAddPicture}
                            />
                          ) : (
                            <p className="m-0 text-(--slate)">{labels.coverNoPictures}</p>
                          )}
                          <Button variant="outline" size="sm" onClick={() => add(newElement(sheet, 'box'))}>{labels.coverAddBox}</Button>
                          {elements.length > 0 && (
                            <ul className="m-0 flex list-none flex-col gap-1 p-0">
                              {[...elements].reverse().map((el) => (
                                <li key={el.id}>
                                  <button
                                    type="button"
                                    aria-pressed={el.id === selected}
                                    onClick={() => { setSelected(el.id); setMode('edit'); }}
                                    className={cn('flex w-full items-center gap-2 rounded px-2 py-1 text-start hover:bg-(--surface)', el.id === selected && 'bg-(--surface) font-medium text-(--brand)')}
                                  >
                                    {el.kind === 'image' ? <ImageIcon size={12} aria-hidden="true" /> : <Square size={12} aria-hidden="true" fill={el.color} />}
                                    <span className="truncate">{el.kind === 'image' ? (el.resourceId ?? labels.coverElementPicture) : labels.coverElementBox}</span>
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                        </>
                      )}
                    </section>
                  );
                })}
              </aside>

              <main className="min-w-0 flex-1 bg-(--surface) p-6">
                <CoverCanvas
                  sheet={sheet}
                  input={input}
                  mode={mode}
                  elements={hidden.has('elements') ? [] : elements}
                  selected={selected}
                  onSelect={setSelected}
                  onChange={changeElement}
                  onDelete={deleteElement}
                  label={labels.coverDesignerTitle}
                  failedLabel={labels.productionPreviewFailed}
                />
              </main>

              <aside className={cn(SIDE, 'border-s')}>
                {mode === 'preview' ? (
                  <>
                    <h3 className="m-0 text-xs font-semibold uppercase tracking-wide text-(--slate)">{labels.coverChecks}</h3>
                    {issues.length === 0 ? (
                      <p className="m-0">{labels.coverChecksOk}</p>
                    ) : (
                      <ul className="m-0 flex flex-col gap-1 ps-4">
                        {issues.map((i) => (
                          <li key={`${i.id}-${i.kind}`}>{i.kind === 'offSheet' ? labels.coverIssueOffSheet : labels.coverIssueMissingPicture}</li>
                        ))}
                      </ul>
                    )}
                    <p className="m-0 text-(--slate)">{labels.coverGuidesLegend}</p>
                    <Button variant="primary" size="sm" onClick={() => setMode('edit')}>{labels.coverDesignerEdit}</Button>
                  </>
                ) : selectedEl ? (
                  <ElementProperties
                    el={selectedEl}
                    zone={zoneName(selectedEl.zone)}
                    aspect={selectedEl.kind === 'image' ? pictureAspect(bookResources.find((r) => r.id === selectedEl.resourceId)) : undefined}
                    canForward={elements[elements.length - 1]?.id !== selectedEl.id}
                    canBackward={elements[0]?.id !== selectedEl.id}
                    labels={labels}
                    onChange={changeElement}
                    onSize={(width, height) => {
                      const r = elementRect(sheet, selectedEl);
                      if (r) changeElement(elementAt(sheet, selectedEl, { ...r, width, height }));
                    }}
                    onRestack={(step) => setElements(restack(elements, selectedEl.id, step))}
                    onDelete={() => deleteElement(selectedEl.id)}
                  />
                ) : (
                  <p className="m-0 text-(--slate)">{labels.coverElementNone}</p>
                )}
                {mode === 'edit' && <p className="m-0 text-(--slate)">{labels.coverDesignerHint}</p>}
              </aside>
            </div>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The selected element's place, size and colour, and its order. A
 *  picture's height follows its width (its proportions). */
function ElementProperties({ el, zone, aspect, canForward, canBackward, labels, onChange, onSize, onRestack, onDelete }: {
  el: CoverElementSetting;
  zone: string;
  aspect: number | undefined;
  canForward: boolean;
  canBackward: boolean;
  labels: Labels;
  onChange: (el: CoverElementSetting) => void;
  onSize: (width: number, height: number) => void;
  onRestack: (step: 1 | -1) => void;
  onDelete: () => void;
}) {
  const round = (v: number) => Math.round(v * 10) / 10;
  const row = (label: string, value: number, set: (v: number) => void, min?: number) => (
    <label className="flex items-center justify-between gap-2">
      <span>{label}</span>
      <NumberField value={round(value)} onValueChange={set} step={0.5} widthCh={6} ariaLabel={label} {...(min !== undefined ? { min } : {})} />
    </label>
  );
  return (
    <>
      <h3 className="m-0 text-xs font-semibold uppercase tracking-wide text-(--slate)">{el.kind === 'image' ? labels.coverElementPicture : labels.coverElementBox}</h3>
      <p className="m-0 text-(--slate)">{fill(labels.coverElementZone, { zone })}</p>
      {row(labels.coverElementX, el.x, (x) => onChange({ ...el, x }))}
      {row(labels.coverElementY, el.y, (y) => onChange({ ...el, y }))}
      {row(labels.coverElementWidth, el.width, (w) => onSize(w, aspect ? w / aspect : el.height), 2)}
      {row(labels.coverElementHeight, el.height, (h) => onSize(aspect ? h * aspect : el.width, h), 2)}
      {el.kind === 'box' && (
        <label className="flex items-center justify-between gap-2">
          <span>{labels.coverElementColor}</span>
          <input
            type="color"
            aria-label={labels.coverElementColor}
            value={el.color ?? '#808080'}
            onChange={(e) => onChange({ ...el, color: e.target.value })}
            className="h-6 w-9 cursor-pointer rounded border border-(--pt-control-border) bg-transparent p-0"
          />
        </label>
      )}
      <div className="flex items-center gap-1">
        <IconButton label={labels.coverElementForward} icon={<ArrowUp size={14} aria-hidden="true" />} disabled={!canForward} onClick={() => onRestack(1)} />
        <IconButton label={labels.coverElementBackward} icon={<ArrowDown size={14} aria-hidden="true" />} disabled={!canBackward} onClick={() => onRestack(-1)} />
        <IconButton label={labels.coverElementDelete} icon={<Trash2 size={14} aria-hidden="true" />} onClick={onDelete} />
      </div>
    </>
  );
}
