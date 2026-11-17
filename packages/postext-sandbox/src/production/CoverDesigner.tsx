'use client';

/**
 * The cover designer: the cover of the book's active version on a canvas
 * of its own, over the whole Sandbox. It opens on the preview — the sheet
 * as it will print, its guides and what to check before it goes to the
 * printer — and from there to editing, and back. Editing works in fixed
 * layers, bottom to top (./coverLayers.ts): the background, the movable
 * elements, the editable texts, the effects, the logos and the finishes.
 * Each layer can be hidden while working, and the canvas moves the items
 * of the one being edited. It is opened from the Cover panel and from the
 * book's preview (./coverDesignerStore.ts).
 */

import { useMemo, useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { ArrowDown, ArrowUp, Eye, EyeOff, Image as ImageIcon, Pencil, Sparkles, Square, Stamp, Trash2, X } from 'lucide-react';
import { COVER_FINISH_INKS, type CoverFinishKind, type CoverZoneName, type Resource } from 'postext';
import { useSandboxLabels, useSandboxSelector } from '../context/SandboxContext.js';
import { Button, IconButton, NumberField, SegmentedControl, Select, cn, usePortalContainer } from '../ui/index.js';
import { POPUP_Z_INDEX } from '../ui/layout/surface.js';
import { fill } from '../print/fillTokens.js';
import { bookTrimMm, coverDocumentInput, pickSheet, type CoverDesignSettings } from './bookProduction.js';
import {
  COVER_LAYERS,
  FINISH_KINDS,
  coverElementIssues,
  elementAt,
  elementRect,
  finishAsElement,
  finishFromElement,
  newElement,
  newFinish,
  newLogo,
  pictureAspect,
  restack,
  type CoverElementSetting,
  type CoverFinishSetting,
  type CoverLayer,
  type CoverLogoSetting,
  type ItemLayer,
} from './coverLayers.js';
import { CoverCanvas } from './CoverCanvas.js';
import { closeCoverDesigner, useCoverDesignerOpen } from './coverDesignerStore.js';
import { DEFAULT_LOGO_CLEARANCE, logoResourceId, type LogoRecord } from './logoLibrary.js';
import { useCoverWorkspace, useLogos } from './useProduction.js';
import type { Labels } from './productionUi.js';

const LAYER_LABEL: Record<CoverLayer, keyof Labels> = {
  background: 'coverLayerBackground',
  elements: 'coverLayerElements',
  texts: 'coverLayerTexts',
  effects: 'coverLayerEffects',
  logos: 'coverLayerLogos',
  finishes: 'coverLayerFinishes',
};

const LAYER_HINT: Partial<Record<CoverLayer, keyof Labels>> = {
  background: 'coverLayerBackgroundHint',
  texts: 'coverLayerTextsHint',
  effects: 'coverLayerEffectsHint',
  logos: 'coverLayerLogosHint',
  finishes: 'coverLayerFinishesHint',
};

export const FINISH_LABEL: Record<CoverFinishKind, keyof Labels> = {
  varnish: 'coverFinishVarnish',
  lamination: 'coverFinishLamination',
  foilGold: 'coverFinishFoilGold',
  foilSilver: 'coverFinishFoilSilver',
  emboss: 'coverFinishEmboss',
  deboss: 'coverFinishDeboss',
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
const isItemLayer = (l: CoverLayer): l is ItemLayer => l === 'elements' || l === 'effects' || l === 'logos' || l === 'finishes';

export function CoverDesignerHost() {
  return useCoverDesignerOpen() ? <CoverDesigner /> : null;
}

function CoverDesigner() {
  const labels = useSandboxLabels();
  const config = useSandboxSelector((s) => s.config);
  const bookResources = useSandboxSelector((s) => s.resources);
  const container = usePortalContainer();
  const { record, update, version, sheets } = useCoverWorkspace();
  const library = useLogos();
  const [mode, setMode] = useState<'preview' | 'edit'>('preview');
  const [hidden, setHidden] = useState<ReadonlySet<CoverLayer>>(new Set());
  const [active, setActive] = useState<ItemLayer>('elements');
  const [selected, setSelected] = useState<string | null>(null);

  const design = useMemo(() => record?.design ?? {}, [record]);
  const elements = useMemo(() => design.elements ?? [], [design]);
  const effects = useMemo(() => design.effects ?? [], [design]);
  const logos = useMemo(() => design.logos ?? [], [design]);
  const finishes = useMemo(() => design.finishes ?? [], [design]);
  const sheet = useMemo(() => (sheets ? pickSheet(sheets, 'cover', bookTrimMm(config)) : null), [sheets, config]);
  const input = useMemo(
    () => (sheet && version && record
      ? coverDocumentInput(sheet, version, record.texts, config, design, bookResources, { hidden, logos: library })
      : null),
    [sheet, version, record, config, design, bookResources, hidden, library],
  );
  const pictures = useMemo(() => bookResources.filter(isPicture), [bookResources]);
  const issues = useMemo(() => (sheet ? coverElementIssues(sheet, [...elements, ...effects], bookResources) : []), [sheet, elements, effects, bookResources]);

  const setDesign = (key: 'elements' | 'effects' | 'logos' | 'finishes', next: unknown[]) => {
    if (!record) return;
    const d = { ...design, [key]: next } as CoverDesignSettings;
    if (next.length === 0) delete d[key];
    update({ ...record, design: d });
  };
  const finishLabel = (kind: CoverFinishKind) => String(labels[FINISH_LABEL[kind]]);

  // What the canvas moves: the active layer's items, a finish by its own
  // box (one shaped by an element follows that element).
  const canvasItems = useMemo((): CoverElementSetting[] => {
    if (hidden.has(active)) return [];
    if (active === 'elements') return elements;
    if (active === 'effects') return effects;
    if (active === 'logos') return logos;
    return finishes.flatMap((f) => finishAsElement(f, COVER_FINISH_INKS[f.kind].screen) ?? []);
  }, [active, hidden, elements, effects, logos, finishes]);

  const changeItem = (el: CoverElementSetting) => {
    if (active === 'elements') setDesign('elements', elements.map((e) => (e.id === el.id ? el : e)));
    else if (active === 'effects') setDesign('effects', effects.map((e) => (e.id === el.id ? el : e)));
    else if (active === 'logos') setDesign('logos', logos.map((e) => (e.id === el.id ? { ...e, ...el, kind: 'image' as const } : e)));
    else setDesign('finishes', finishes.map((f) => (f.id === el.id ? finishFromElement(f, el) : f)));
  };
  const deleteItem = (id: string) => {
    setDesign(active, (active === 'elements' ? elements : active === 'effects' ? effects : active === 'logos' ? logos : finishes).filter((e) => e.id !== id));
    if (selected === id) setSelected(null);
  };
  const add = (layer: ItemLayer, item: { id: string } | undefined) => {
    if (!item) return;
    const list = layer === 'elements' ? elements : layer === 'effects' ? effects : layer === 'logos' ? logos : finishes;
    setDesign(layer, [...list, item]);
    setActive(layer);
    setSelected(item.id);
    setMode('edit');
  };
  const toggle = (layer: CoverLayer) => {
    const next = new Set(hidden);
    if (next.has(layer)) next.delete(layer);
    else next.add(layer);
    setHidden(next);
  };
  const activate = (layer: ItemLayer) => {
    setActive(layer);
    setSelected(null);
    setMode('edit');
  };
  const zoneName = (z: CoverZoneName) => (ZONE_LABEL[z] ? String(labels[ZONE_LABEL[z]!]) : z);
  const logoName = (l: CoverLogoSetting) => library.find((x) => l.logoId === x.id)?.name ?? l.resourceId ?? labels.coverItemLogo;
  const itemName = (layer: ItemLayer, item: CoverElementSetting | CoverFinishSetting): string => {
    if (layer === 'finishes') return finishLabel((item as CoverFinishSetting).kind);
    if (layer === 'logos') return logoName(item as CoverLogoSetting);
    const el = item as CoverElementSetting;
    return el.kind === 'image' ? (el.resourceId ?? labels.coverElementPicture) : labels.coverElementBox;
  };
  const shapeTargets = [...elements, ...effects, ...logos].map((e) => ({
    value: e.id,
    label: e.kind === 'image' ? (logos.some((l) => l.id === e.id) ? logoName(e as CoverLogoSetting) : (e.resourceId ?? labels.coverElementPicture)) : labels.coverElementBox,
  }));

  const selectedEl = canvasItems.find((e) => e.id === selected);
  const selectedFinish = active === 'finishes' ? finishes.find((f) => f.id === selected) : undefined;
  const activeList: (CoverElementSetting | CoverFinishSetting)[] = active === 'elements' ? elements : active === 'effects' ? effects : active === 'logos' ? logos : finishes;

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
                  const editing = isItemLayer(layer) && layer === active && mode === 'edit';
                  const hint = LAYER_HINT[layer];
                  const list = layer === 'elements' ? elements : layer === 'effects' ? effects : layer === 'logos' ? logos : layer === 'finishes' ? finishes : [];
                  return (
                    <section key={layer} className={cn('flex flex-col gap-2 rounded-md border p-2', editing ? 'border-(--brand)' : 'border-(--rule)')}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{name}</span>
                        <span className="flex items-center gap-1">
                          {isItemLayer(layer) && !editing && (
                            <IconButton label={fill(labels.coverLayerEdit, { layer: name })} icon={<Pencil size={13} aria-hidden="true" />} onClick={() => activate(layer)} />
                          )}
                          <IconButton
                            label={fill(hidden.has(layer) ? labels.coverLayerShow : labels.coverLayerHide, { layer: name })}
                            icon={hidden.has(layer) ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
                            onClick={() => toggle(layer)}
                          />
                        </span>
                      </div>
                      {hint && <p className="m-0 text-(--slate)">{String(labels[hint])}</p>}

                      {layer === 'elements' && (
                        <>
                          <PictureAdder pictures={pictures} labels={labels} onPick={(p) => add('elements', newElement(sheet, 'image', p))} />
                          <Button variant="outline" size="sm" onClick={() => add('elements', newElement(sheet, 'box'))}>{labels.coverAddBox}</Button>
                        </>
                      )}
                      {layer === 'effects' && (
                        <>
                          <PictureAdder pictures={pictures} labels={labels} onPick={(p) => add('effects', newElement(sheet, 'image', p))} />
                          <Button variant="outline" size="sm" onClick={() => { const box = newElement(sheet, 'box', undefined, '#000000'); add('effects', box ? ({ ...box, opacity: 0.4 } as CoverElementSetting) : undefined); }}>
                            {labels.coverAddVeil}
                          </Button>
                        </>
                      )}
                      {layer === 'logos' && (
                        <LogoAdder
                          library={library}
                          pictures={pictures}
                          labels={labels}
                          onLibrary={(l) => add('logos', newLogo(sheet, { logoId: l.id }, l.width / l.height, l.clearance))}
                          onBook={(p) => add('logos', newLogo(sheet, { resourceId: p.id }, pictureAspect(p), DEFAULT_LOGO_CLEARANCE))}
                        />
                      )}
                      {layer === 'finishes' && (
                        <Select
                          size="sm"
                          value=""
                          onValueChange={(kind) => { if (kind) add('finishes', newFinish(sheet, kind as CoverFinishKind, finishLabel(kind as CoverFinishKind))); }}
                          options={[{ value: '', label: labels.coverAddFinish }, ...FINISH_KINDS.map((k) => ({ value: k, label: finishLabel(k) }))]}
                          ariaLabel={labels.coverAddFinish}
                        />
                      )}

                      {isItemLayer(layer) && list.length > 0 && (
                        <ul className="m-0 flex list-none flex-col gap-1 p-0">
                          {[...list].reverse().map((item) => (
                            <li key={item.id}>
                              <button
                                type="button"
                                aria-pressed={item.id === selected && layer === active}
                                onClick={() => { setActive(layer); setSelected(item.id); setMode('edit'); }}
                                className={cn('flex w-full items-center gap-2 rounded px-2 py-1 text-start hover:bg-(--surface)', item.id === selected && layer === active && 'bg-(--surface) font-medium text-(--brand)')}
                              >
                                {layer === 'finishes'
                                  ? <Sparkles size={12} aria-hidden="true" />
                                  : layer === 'logos'
                                    ? <Stamp size={12} aria-hidden="true" />
                                    : (item as CoverElementSetting).kind === 'image'
                                      ? <ImageIcon size={12} aria-hidden="true" />
                                      : <Square size={12} aria-hidden="true" fill={(item as CoverElementSetting).color} />}
                                <span className="truncate">{itemName(layer, item)}</span>
                              </button>
                            </li>
                          ))}
                        </ul>
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
                  elements={canvasItems}
                  clearance={active === 'logos' ? (id) => logos.find((l) => l.id === id)?.clearance ?? 0 : undefined}
                  selected={selected}
                  onSelect={setSelected}
                  onChange={changeItem}
                  onDelete={deleteItem}
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
                ) : selectedFinish ? (
                  <FinishProperties
                    finish={selectedFinish}
                    targets={shapeTargets}
                    labels={labels}
                    finishLabel={finishLabel}
                    onChange={(f) => setDesign('finishes', finishes.map((x) => (x.id === f.id ? f : x)))}
                    onBox={() => { const box = newFinish(sheet, selectedFinish.kind, selectedFinish.ink); if (box) setDesign('finishes', finishes.map((x) => (x.id === selectedFinish.id ? { ...x, shape: box.shape } : x))); }}
                    canForward={finishes[finishes.length - 1]?.id !== selectedFinish.id}
                    canBackward={finishes[0]?.id !== selectedFinish.id}
                    onRestack={(step) => setDesign('finishes', restack(finishes, selectedFinish.id, step))}
                    onDelete={() => deleteItem(selectedFinish.id)}
                    {...(selectedEl ? { zone: zoneName(selectedEl.zone) } : {})}
                  />
                ) : selectedEl ? (
                  <ElementProperties
                    el={selectedEl}
                    layer={active}
                    zone={zoneName(selectedEl.zone)}
                    aspect={selectedEl.kind === 'image' ? aspectOf(selectedEl, bookResources, library) : undefined}
                    clearance={active === 'logos' ? logos.find((l) => l.id === selectedEl.id)?.clearance : undefined}
                    canForward={activeList[activeList.length - 1]?.id !== selectedEl.id}
                    canBackward={activeList[0]?.id !== selectedEl.id}
                    labels={labels}
                    onChange={changeItem}
                    onClearance={(clearance) => setDesign('logos', logos.map((l) => (l.id === selectedEl.id ? { ...l, clearance } : l)))}
                    onSize={(width, height) => {
                      const r = elementRect(sheet, selectedEl);
                      if (r) changeItem(elementAt(sheet, selectedEl, { ...r, width, height }));
                    }}
                    onRestack={(step) => setDesign(active, restack(activeList, selectedEl.id, step))}
                    onDelete={() => deleteItem(selectedEl.id)}
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

/** A picture's proportions: a library logo's, or a book picture's. */
function aspectOf(el: CoverElementSetting, resources: readonly Resource[], library: readonly LogoRecord[]): number {
  const logo = library.find((l) => logoResourceId(l.id) === el.resourceId);
  if (logo && logo.width > 0 && logo.height > 0) return logo.width / logo.height;
  return pictureAspect(resources.find((r) => r.id === el.resourceId));
}

function PictureAdder({ pictures, labels, onPick }: { pictures: readonly Resource[]; labels: Labels; onPick: (p: Resource) => void }) {
  if (pictures.length === 0) return <p className="m-0 text-(--slate)">{labels.coverNoPictures}</p>;
  return (
    <Select
      size="sm"
      value=""
      onValueChange={(id) => { const picture = pictures.find((p) => p.id === id); if (picture) onPick(picture); }}
      options={[{ value: '', label: labels.coverAddPicture }, ...pictures.map((p) => ({ value: p.id, label: p.id }))]}
      ariaLabel={labels.coverAddPicture}
    />
  );
}

function LogoAdder({ library, pictures, labels, onLibrary, onBook }: {
  library: readonly LogoRecord[];
  pictures: readonly Resource[];
  labels: Labels;
  onLibrary: (l: LogoRecord) => void;
  onBook: (p: Resource) => void;
}) {
  return (
    <>
      {library.length > 0 ? (
        <Select
          size="sm"
          value=""
          onValueChange={(id) => { const l = library.find((x) => x.id === id); if (l) onLibrary(l); }}
          options={[{ value: '', label: labels.coverAddLogo }, ...library.map((l) => ({ value: l.id, label: l.name }))]}
          ariaLabel={labels.coverAddLogo}
        />
      ) : (
        <p className="m-0 text-(--slate)">{labels.coverNoLogos}</p>
      )}
      {pictures.length > 0 && (
        <Select
          size="sm"
          value=""
          onValueChange={(id) => { const p = pictures.find((x) => x.id === id); if (p) onBook(p); }}
          options={[{ value: '', label: labels.coverAddLogoFromBook }, ...pictures.map((p) => ({ value: p.id, label: p.id }))]}
          ariaLabel={labels.coverAddLogoFromBook}
        />
      )}
    </>
  );
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** The selected item's place, size and colour (an effect's opacity, a
 *  logo's clear space), and its order. A picture's height follows its
 *  width (its proportions). */
function ElementProperties({ el, layer, zone, aspect, clearance, canForward, canBackward, labels, onChange, onClearance, onSize, onRestack, onDelete }: {
  el: CoverElementSetting;
  layer: ItemLayer;
  zone: string;
  aspect: number | undefined;
  clearance: number | undefined;
  canForward: boolean;
  canBackward: boolean;
  labels: Labels;
  onChange: (el: CoverElementSetting) => void;
  onClearance: (mm: number) => void;
  onSize: (width: number, height: number) => void;
  onRestack: (step: 1 | -1) => void;
  onDelete: () => void;
}) {
  const row = (label: string, value: number, set: (v: number) => void, min?: number, max?: number, step = 0.5) => (
    <label className="flex items-center justify-between gap-2">
      <span>{label}</span>
      <NumberField value={round1(value)} onValueChange={set} step={step} widthCh={6} ariaLabel={label} {...(min !== undefined ? { min } : {})} {...(max !== undefined ? { max } : {})} />
    </label>
  );
  const title = layer === 'logos' ? labels.coverItemLogo : layer === 'effects' ? labels.coverItemEffect : el.kind === 'image' ? labels.coverElementPicture : labels.coverElementBox;
  return (
    <>
      <h3 className="m-0 text-xs font-semibold uppercase tracking-wide text-(--slate)">{title}</h3>
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
      {layer === 'effects' && el.kind === 'box' && row(labels.coverElementOpacity, (el.opacity ?? 1) * 100, (v) => {
        const o = Math.max(0, Math.min(100, v)) / 100;
        const next = { ...el };
        if (o >= 1) delete next.opacity;
        else next.opacity = o;
        onChange(next);
      }, 0, 100, 5)}
      {layer === 'logos' && clearance !== undefined && row(labels.coverLogoClearance, clearance, (v) => onClearance(Math.max(0, v)), 0)}
      <div className="flex items-center gap-1">
        <IconButton label={labels.coverElementForward} icon={<ArrowUp size={14} aria-hidden="true" />} disabled={!canForward} onClick={() => onRestack(1)} />
        <IconButton label={labels.coverElementBackward} icon={<ArrowDown size={14} aria-hidden="true" />} disabled={!canBackward} onClick={() => onRestack(-1)} />
        <IconButton label={labels.coverElementDelete} icon={<Trash2 size={14} aria-hidden="true" />} onClick={onDelete} />
      </div>
    </>
  );
}

/** A finish's kind, the ink its plate is named after, and its shape: a box
 *  of its own (moved on the canvas) or an element's. */
function FinishProperties({ finish, targets, zone, labels, finishLabel, onChange, onBox, canForward, canBackward, onRestack, onDelete }: {
  finish: CoverFinishSetting;
  targets: { value: string; label: string }[];
  zone?: string;
  labels: Labels;
  finishLabel: (k: CoverFinishKind) => string;
  onChange: (f: CoverFinishSetting) => void;
  onBox: () => void;
  canForward: boolean;
  canBackward: boolean;
  onRestack: (step: 1 | -1) => void;
  onDelete: () => void;
}) {
  const ofElement = 'element' in finish.shape;
  return (
    <>
      <h3 className="m-0 text-xs font-semibold uppercase tracking-wide text-(--slate)">{labels.coverItemFinish}</h3>
      <label className="flex flex-col gap-1">
        {labels.coverFinishKind}
        <Select
          size="sm"
          value={finish.kind}
          onValueChange={(kind) => onChange({ ...finish, kind: kind as CoverFinishKind })}
          options={FINISH_KINDS.map((k) => ({ value: k, label: finishLabel(k) }))}
          ariaLabel={labels.coverFinishKind}
        />
      </label>
      <label className="flex flex-col gap-1">
        {labels.coverFinishInk}
        <input
          type="text"
          value={finish.ink}
          onChange={(e) => onChange({ ...finish, ink: e.target.value })}
          className="rounded border border-(--pt-control-border) bg-(--background) px-2 py-1 text-xs text-(--foreground)"
        />
      </label>
      <div className="flex flex-col gap-1">
        {labels.coverFinishShape}
        <SegmentedControl
          size="sm"
          value={ofElement ? 'element' : 'box'}
          onValueChange={(v) => {
            if (v === 'box') onBox();
            else if (targets[0]) onChange({ ...finish, shape: { element: targets[0].value } });
          }}
          options={[
            { value: 'box', label: labels.coverFinishShapeBox },
            { value: 'element', label: labels.coverFinishShapeElement, disabled: targets.length === 0 },
          ]}
          ariaLabel={labels.coverFinishShape}
        />
      </div>
      {ofElement ? (
        <Select
          size="sm"
          value={(finish.shape as { element: string }).element}
          onValueChange={(id) => onChange({ ...finish, shape: { element: id } })}
          options={targets}
          ariaLabel={labels.coverFinishShapeElement}
        />
      ) : zone ? (
        <p className="m-0 text-(--slate)">{fill(labels.coverElementZone, { zone })}</p>
      ) : null}
      <p className="m-0 text-(--slate)">{labels.coverFinishPlateHint}</p>
      <div className="flex items-center gap-1">
        <IconButton label={labels.coverElementForward} icon={<ArrowUp size={14} aria-hidden="true" />} disabled={!canForward} onClick={() => onRestack(1)} />
        <IconButton label={labels.coverElementBackward} icon={<ArrowDown size={14} aria-hidden="true" />} disabled={!canBackward} onClick={() => onRestack(-1)} />
        <IconButton label={labels.coverElementDelete} icon={<Trash2 size={14} aria-hidden="true" />} onClick={onDelete} />
      </div>
    </>
  );
}
