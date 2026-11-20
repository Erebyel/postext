'use client';

/**
 * The cover designer: the cover of the book's active version on a canvas
 * of its own, over the whole Sandbox. It opens on the preview — the sheet
 * as it will print, its guides and what to check before it goes to the
 * printer — and from there to editing, and back. Editing works in fixed
 * layers, bottom to top (./coverLayers.ts): the background, the movable
 * elements, the editable texts, the effects, the logos and the finishes.
 * Each layer can be hidden while working; one is open at a time (the
 * background with the cover's look, an item layer to edit). The canvas
 * picks and moves the items of every shown layer: picking one opens its
 * layer. It is opened from the Cover panel and from the
 * book's preview (./coverDesignerStore.ts). It has its own undo, and
 * copies, cuts, pastes and duplicates items (./coverEditing.ts), by the
 * usual keys while no text box has the focus.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { ArrowDown, ArrowUp, ChevronRight, Copy, Eye, EyeOff, Image as ImageIcon, PenTool, Plus, Redo2, Sparkles, Square, Stamp, Trash2, Type, Undo2, X } from 'lucide-react';
import { BASIC_SHAPES, COVER_FINISH_INKS, resolveBodyTextConfig, resolveColorValue, type BasicShape, type CoverFinishKind, type CoverZoneName, type Resource } from 'postext';
import { useSandboxLabels, useSandboxSelector } from '../context/SandboxContext.js';
import { Button, IconButton, NumberField, SegmentedControl, Select, Switch, cn, usePortalContainer } from '../ui/index.js';
import { POPUP_Z_INDEX } from '../ui/layout/surface.js';
import { fill } from '../print/fillTokens.js';
import { bookTrimMm, coverDocumentInput, pickSheet, type BookProduction, type CoverDesignSettings } from './bookProduction.js';
import { typesOwnUndo } from '../history/historyKeys.js';
import { PASTE_OFFSET_MM, copiedCoverItem, copyCoverItem, createCoverHistory, duplicateCoverItem, setCopiedCoverItem, type CoverItem } from './coverEditing.js';
import {
  newBasicShape,
  newShape,
  COVER_LAYERS,
  FINISH_KINDS,
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
import { DesignSection, RoleFields, bookFamilies } from './CoverDesignSections.js';
import { COVER_FIELDS, TEXT_BOX_ROLES, coverFields, fieldsIn, newTextBox, textBoxAsElement, textBoxesOf, textBoxFromElement, type CoverField, type CoverTextBox, type CoverTexts, type TextBoxRole } from './coverTexts.js';
import { CoverChecksList } from './CoverChecksList.js';
import { coverChecks, overflowZones, type CoverCheck } from './coverChecks.js';
import { CoverEffectsFields } from './CoverEffectsFields.js';
import { outlineAsPath } from './pathEditing.js';
import { galleryPictureOf, galleryPicturesFrom, galleryResource, galleryResourceId, type CoverGallery, type GalleryPicture, type GalleryTrace } from './coverGallery.js';
import { maskedPicture } from './coverMasks.js';
import { pictureSize } from './coverImages.js';
import { PICTURE_ACCEPT, readPictureFile } from './printFiles.js';
import { announce } from '../ui/announcer.js';
import { closeCoverDesigner, useCoverDesignerOpen } from './coverDesignerStore.js';
import { DEFAULT_LOGO_CLEARANCE, logoResourceId, type LogoRecord } from './logoLibrary.js';
import { useCoverGallery, useCoverWorkspace, useLogos, useMirror } from './useProduction.js';
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
const isItemLayer = (l: CoverLayer): l is ItemLayer => l === 'elements' || l === 'texts' || l === 'effects' || l === 'logos' || l === 'finishes';

export function CoverDesignerHost() {
  return useCoverDesignerOpen() ? <CoverDesigner /> : null;
}

function CoverDesigner() {
  const labels = useSandboxLabels();
  const config = useSandboxSelector((s) => s.config);
  const bookResources = useSandboxSelector((s) => s.resources);
  const container = usePortalContainer();
  const { record, update: saveRecord, version, sheets } = useCoverWorkspace();
  const library = useLogos();
  const [gallery, saveGallery] = useCoverGallery();
  // The designer's undo: the design and the gallery as they were before
  // each change (./coverEditing.ts).
  const [history] = useState(() => createCoverHistory<{ design: CoverDesignSettings | undefined; gallery: typeof gallery }>());
  const [, setHistoryTick] = useState(0);
  /** `key`: what a change edits, to join the quick changes of one thing
   *  into a step; a command (add, delete, paste) has none. */
  const remember = (key?: string) => {
    history.remember({ design: record?.design, gallery }, key);
    setHistoryTick((t) => t + 1);
  };
  const update = (next: BookProduction, key?: string) => {
    if (next.design !== record?.design) remember(key);
    saveRecord(next);
  };
  const updateGallery = (next: typeof gallery, key?: string) => {
    remember(key);
    saveGallery(next);
  };
  const travel = (dir: 'undo' | 'redo') => {
    if (!record) return;
    const now = { design: record.design, gallery };
    const to = dir === 'undo' ? history.undo(now) : history.redo(now);
    setHistoryTick((t) => t + 1);
    if (!to) return;
    const next = { ...record };
    if (to.design) next.design = to.design;
    else delete next.design;
    saveRecord(next);
    if (to.gallery !== gallery) saveGallery(to.gallery);
  };
  const [mode, setMode] = useState<'preview' | 'edit'>('preview');
  const [hidden, setHidden] = useState<ReadonlySet<CoverLayer>>(new Set());
  const [active, setActive] = useState<ItemLayer>('elements');
  const [open, setOpen] = useState<CoverLayer>('elements');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Editing the selected shape's points instead of its box; picking
  // another item leaves it.
  const [points, setPoints] = useState(false);
  const selected = selectedId;
  const setSelected = (id: string | null) => {
    if (id !== selectedId) setPoints(false);
    setSelectedId(id);
  };

  const design = useMemo(() => record?.design ?? {}, [record]);
  const bookTextHex = useMemo(() => {
    const color = resolveBodyTextConfig(config.bodyText, config.locale).color;
    return resolveColorValue(color, config.colorPalette, { hex: '#000000', model: 'hex' }).hex.slice(0, 7).toLowerCase();
  }, [config]);
  const elements = useMemo(() => design.elements ?? [], [design]);
  const effects = useMemo(() => design.effects ?? [], [design]);
  const logos = useMemo(() => design.logos ?? [], [design]);
  const finishes = useMemo(() => design.finishes ?? [], [design]);
  const sheet = useMemo(() => (sheets ? pickSheet(sheets, 'cover', bookTrimMm(config)) : null), [sheets, config]);
  // The general texts, and the boxes that show them (the default ones
  // until the design keeps its own).
  const fields = useMemo(() => coverFields(record?.texts ?? {}), [record]);
  const textBoxes = useMemo(() => (sheet ? textBoxesOf(sheet, design, fields, version?.spineText) : []), [sheet, design, fields, version?.spineText]);
  const families = useMemo(() => bookFamilies(config), [config]);
  const mirror = useMirror(design, bookResources, sheets?.measures.designMargin, gallery);
  const input = useMemo(
    () => (sheet && version && record
      ? coverDocumentInput(sheet, version, record.texts, config, design, bookResources, { workIsbnLabel: labels.productionWorkIsbnCaption, hidden, logos: library, gallery, ...(mirror ? { mirror } : {}) })
      : null),
    [sheet, version, record, config, design, bookResources, hidden, library, gallery, mirror, labels.productionWorkIsbnCaption],
  );
  // The cover's own pictures (its gallery), apart from the book's figures;
  // a design made before the gallery may still place the book's.
  const pictures = useMemo(() => gallery.pictures.map(galleryResource), [gallery]);
  const allResources = useMemo(() => [...bookResources, ...pictures], [bookResources, pictures]);
  const backgroundChoices = useMemo(
    () => [...pictures, ...bookResources.filter((r) => isPicture(r) && r.id === design.image?.resourceId)],
    [pictures, bookResources, design.image?.resourceId],
  );
  const [overflow, setOverflow] = useState<string[]>([]);
  const checks = useMemo(() => (sheet ? coverChecks(sheet, design, {
    pictures: new Set([...allResources.map((r) => r.id), ...library.map((l) => logoResourceId(l.id))]),
    ...(version?.isbn ? { isbn: version.isbn } : {}),
    ...(version?.isbnAddOn ? { isbnAddOn: version.isbnAddOn } : {}),
    ...(config.print?.standard ? { standard: config.print.standard } : {}),
    mirror: !!input?.cover.designed,
    overflow,
  }) : []), [sheet, design, allResources, library, version, config.print?.standard, input, overflow]);

  const setDesign = (key: ItemLayer, next: unknown[], step?: string) => {
    if (!record) return;
    const d = { ...design, [key]: next } as CoverDesignSettings;
    // No boxes of its own would bring the default ones back: kept empty.
    if (next.length === 0 && key !== 'texts') delete d[key];
    update({ ...record, design: d }, step);
  };
  const finishLabel = (kind: CoverFinishKind) => String(labels[FINISH_LABEL[kind]]);
  /** The mask a picture element is masked with, from its gallery picture. */
  const maskOf = (el: CoverElementSetting) => {
    const m = galleryPictureOf(gallery, el.resourceId)?.masked;
    return m ? { mask: m.mask, invert: !!m.invert } : undefined;
  };
  /** A picture element masked (or unmasked): the masked picture made from
   *  its own, into the gallery; the one it had before dropped when nothing
   *  else places it. */
  const setMask = async (el: CoverElementSetting, maskId: string | undefined, invert: boolean) => {
    const current = galleryPictureOf(gallery, el.resourceId);
    const source = gallery.pictures.find((p) => p.id === (current?.masked?.source ?? current?.id));
    if (!current || !source) return;
    let pictures = gallery.pictures;
    let resourceId = galleryResourceId(source.id);
    if (maskId) {
      const mask = gallery.pictures.find((p) => p.id === maskId);
      if (!mask) return;
      try {
        const made = await maskedPicture(source, mask, invert);
        pictures = [...pictures, made];
        resourceId = galleryResourceId(made.id);
      } catch {
        return;
      }
    }
    const usedElsewhere = [design.image?.resourceId, ...[...elements, ...effects, ...logos].filter((e) => e.id !== el.id).map((e) => e.resourceId)].includes(el.resourceId);
    if (current.masked && !usedElsewhere) pictures = pictures.filter((p) => p.id !== current.id);
    updateGallery({ ...gallery, pictures }, `mask:${el.id}`);
    changeItem({ ...el, resourceId }, `mask:${el.id}`);
  };
  const settled = (el: CoverElementSetting): CoverElementSetting => {
    const r = sheet ? elementRect(sheet, el) : undefined;
    return sheet && r ? elementAt(sheet, el, r) : el;
  };

  // What the canvas moves: the active layer's items, a finish by its own
  // box (one shaped by an element follows that element).
  // What the canvas picks and moves: every shown layer's items, bottom to
  // top (a finish by its own box; one shaped by an element follows that
  // element). Picking one makes its layer the one edited.
  const { canvasItems, layerOfId } = useMemo(() => {
    const layerOf = new Map<string, ItemLayer>();
    const items: CoverElementSetting[] = [];
    const take = (layer: ItemLayer, list: readonly CoverElementSetting[]) => {
      if (hidden.has(layer)) return;
      for (const el of list) {
        layerOf.set(el.id, layer);
        items.push(el);
      }
    };
    take('elements', elements);
    take('texts', textBoxes.map(textBoxAsElement));
    take('effects', effects);
    take('logos', logos);
    take('finishes', finishes.flatMap((f) => finishAsElement(f, COVER_FINISH_INKS[f.kind].screen) ?? []));
    return { canvasItems: items, layerOfId: (id: string) => layerOf.get(id) };
  }, [hidden, elements, textBoxes, effects, logos, finishes]);
  /** A layer's items, back to front. */
  const listOf = (layer: ItemLayer): CoverItem[] => (layer === 'elements' ? elements : layer === 'texts' ? textBoxes : layer === 'effects' ? effects : layer === 'logos' ? logos : finishes);
  const changeBox = (box: CoverTextBox, step = `item:${box.id}`) => setDesign('texts', textBoxes.map((b) => (b.id === box.id ? box : b)), step);
  const pick = (id: string | null) => {
    const layer = id ? layerOfId(id) : undefined;
    if (layer) {
      setActive(layer);
      setOpen(layer);
    }
    setSelected(id);
  };

  const changeItem = (el: CoverElementSetting, step = `item:${el.id}`) => {
    const layer = layerOfId(el.id) ?? active;
    if (layer === 'elements') setDesign('elements', elements.map((e) => (e.id === el.id ? el : e)), step);
    else if (layer === 'texts') setDesign('texts', textBoxes.map((b) => (b.id === el.id ? textBoxFromElement(b, el) : b)), step);
    else if (layer === 'effects') setDesign('effects', effects.map((e) => (e.id === el.id ? el : e)), step);
    else if (layer === 'logos') setDesign('logos', logos.map((e) => (e.id === el.id ? { ...e, ...el, kind: 'image' as const } : e)), step);
    else setDesign('finishes', finishes.map((f) => (f.id === el.id ? finishFromElement(f, el) : f)), step);
  };
  const deleteItem = (id: string) => {
    const layer = layerOfId(id) ?? active;
    setDesign(layer, listOf(layer).filter((e) => e.id !== id));
    if (selected === id) setSelected(null);
  };
  /** An item as its layer keeps it (a finish, not its box). */
  const itemOf = (id: string): { layer: ItemLayer; item: CoverItem } | undefined => {
    const layer = layerOfId(id);
    if (!layer) return undefined;
    const item = listOf(layer).find((x) => x.id === id);
    return item ? { layer, item } : undefined;
  };
  /** A copy of an item into its layer, picked: moved a little, or put on
   *  `rect` (dragged there with Alt). */
  const duplicate = (id: string, rect?: { x: number; y: number; width: number; height: number }) => {
    const found = itemOf(id);
    if (!found || !sheet) return;
    add(found.layer, duplicateCoverItem(sheet, found.layer, found.item, rect ? { rect } : { offset: PASTE_OFFSET_MM }));
  };
  const paste = () => {
    const copied = copiedCoverItem();
    if (!copied || !sheet) return false;
    // Its pictures, when it was copied from another book's cover.
    const missing = copied.pictures.filter((p) => !gallery.pictures.some((g) => g.id === p.id));
    const item = duplicateCoverItem(sheet, copied.layer, copied.item, { offset: PASTE_OFFSET_MM });
    if (missing.length > 0) updateGallery({ ...gallery, pictures: [...gallery.pictures, ...missing] }, `paste:${item.id}`);
    setCopiedCoverItem({ ...copied, item });
    add(copied.layer, item, `paste:${item.id}`);
    return true;
  };
  // The keys, over the whole designer while no text box has the focus:
  // they are the designer's, not the Sandbox's history (window, capture).
  const keys = useRef<(ev: KeyboardEvent) => boolean>(() => false);
  keys.current = (ev) => {
    const key = ev.key.toLowerCase();
    if (key === 'z') { travel(ev.shiftKey ? 'redo' : 'undo'); return true; }
    if (key === 'y' && !ev.shiftKey) { travel('redo'); return true; }
    if (key === 'v' && !ev.shiftKey) return mode === 'edit' && paste();
    const found = selected && mode === 'edit' ? itemOf(selected) : undefined;
    if (!found || ev.shiftKey) return false;
    if (key === 'c' || key === 'x') {
      copyCoverItem(found.layer, found.item, gallery);
      if (key === 'x') deleteItem(found.item.id);
      return true;
    }
    if (key === 'd') { duplicate(found.item.id); return true; }
    return false;
  };
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (!(ev.metaKey || ev.ctrlKey) || ev.altKey || ev.defaultPrevented) return;
      if (typesOwnUndo(ev.target) || typesOwnUndo(document.activeElement)) return;
      if (keys.current(ev)) ev.preventDefault();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  const add = (layer: ItemLayer, item: { id: string } | undefined, step?: string) => {
    if (!item) return;
    setDesign(layer, [...listOf(layer), item], step);
    setActive(layer);
    setOpen(layer);
    setSelected(item.id);
    setMode('edit');
  };
  const toggle = (layer: CoverLayer) => {
    const next = new Set(hidden);
    if (next.has(layer)) next.delete(layer);
    else next.add(layer);
    setHidden(next);
  };
  // One layer open at a time, the rest a line each: an item layer opens
  // to be edited, the background to show its controls.
  const openLayer = (layer: CoverLayer) => {
    setOpen(layer);
    if (isItemLayer(layer) && layer !== active) {
      setActive(layer);
      setSelected(null);
      setMode('edit');
    }
  };
  const zoneName = (z: CoverZoneName) => (ZONE_LABEL[z] ? String(labels[ZONE_LABEL[z]!]) : z);
  const logoName = (l: CoverLogoSetting) => library.find((x) => l.logoId === x.id)?.name ?? l.resourceId ?? labels.coverItemLogo;
  const pictureName = (id: string | undefined) => galleryPictureOf(gallery, id)?.name ?? id ?? labels.coverElementPicture;
  const itemName = (layer: ItemLayer, item: CoverElementSetting | CoverFinishSetting): string => {
    if (item.name) return item.name;
    if (layer === 'finishes') return finishLabel((item as CoverFinishSetting).kind);
    if (layer === 'logos') return logoName(item as CoverLogoSetting);
    const el = item as CoverElementSetting;
    return el.kind === 'image' ? pictureName(el.resourceId) : el.kind === 'shape' ? labels.coverElementShape : labels.coverElementBox;
  };
  /** A box by its name, else the general texts it shows, else its first
   *  words. */
  const boxName = (b: CoverTextBox): string =>
    b.name || fieldsIn(b.text).map((f) => fieldLabel(labels, f)).join(' · ') || b.text.replace(/[#*_{}]/g, '').trim().slice(0, 30) || labels.coverTextBox;
  const checkName = (c: CoverCheck): string => {
    if (c.zone) return zoneName(c.zone as CoverZoneName);
    const layer = c.layer;
    const item = layer === 'finishes' ? finishes.find((f) => f.id === c.id) : [...elements, ...effects, ...logos].find((e) => e.id === c.id);
    return layer && item ? itemName(layer, item) : (c.id ?? '');
  };
  const shapeTargets = [...elements, ...effects, ...logos].map((e) => ({
    value: e.id,
    label: e.name ? e.name : e.kind === 'image' ? (logos.some((l) => l.id === e.id) ? logoName(e as CoverLogoSetting) : pictureName(e.resourceId)) : e.kind === 'shape' ? labels.coverElementShape : labels.coverElementBox,
  }));

  const selectedEl = canvasItems.find((e) => e.id === selected);
  const selectedFinish = active === 'finishes' ? finishes.find((f) => f.id === selected) : undefined;
  const activeList: CoverItem[] = listOf(active);
  const selectedBox = active === 'texts' ? textBoxes.find((b) => b.id === selected) : undefined;

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
              <IconButton label={labels.coverUndo} icon={<Undo2 size={15} aria-hidden="true" />} disabled={!history.canUndo} onClick={() => travel('undo')} />
              <IconButton label={labels.coverRedo} icon={<Redo2 size={15} aria-hidden="true" />} disabled={!history.canRedo} onClick={() => travel('redo')} />
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
                  const expanded = layer === open;
                  const hint = LAYER_HINT[layer];
                  const list: CoverItem[] = isItemLayer(layer) ? listOf(layer) : [];
                  return (
                    <section key={layer} className={cn('flex flex-col gap-2 rounded-md border', expanded ? 'p-2' : 'px-2 py-1', editing ? 'border-(--brand)' : 'border-(--rule)')}>
                      <div className="flex items-center justify-between gap-1">
                        <button
                          type="button"
                          aria-expanded={expanded}
                          onClick={() => openLayer(layer)}
                          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded border-0 bg-transparent px-0 py-0.5 text-start text-(--foreground) hover:text-(--brand)"
                        >
                          <ChevronRight size={13} aria-hidden="true" className="shrink-0 text-(--slate) rtl:-scale-x-100" style={{ transform: expanded ? 'rotate(90deg)' : undefined, transition: 'transform 200ms ease' }} />
                          <span className={cn('truncate font-medium', hidden.has(layer) && 'text-(--slate) line-through')}>{name}</span>
                          {list.length > 0 && <span className="text-(--slate) tabular-nums">{list.length}</span>}
                        </button>
                        <IconButton
                          label={fill(hidden.has(layer) ? labels.coverLayerShow : labels.coverLayerHide, { layer: name })}
                          icon={hidden.has(layer) ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
                          onClick={() => toggle(layer)}
                        />
                      </div>
                      {expanded && hint && <p className="m-0 text-(--slate)">{String(labels[hint])}</p>}
                      {expanded && layer === 'background' && record && (
                        <DesignSection
                          design={design}
                          resources={backgroundChoices}
                          bookTextHex={bookTextHex}
                          labels={labels}
                          onChange={(d) => update({ ...record, design: d })}
                          onUpload={async (file) => {
                            const { pictures: added, postscript } = await galleryPicturesFrom([file], pictureSize, readPictureFile);
                            if (!added[0]) {
                              announce(postscript.length ? fill(labels.productionPicturePostscript, { name: file.name }) : labels.productionPictureUnreadable);
                              return undefined;
                            }
                            updateGallery({ ...gallery, pictures: [...gallery.pictures, ...added] });
                            return galleryResourceId(added[0].id);
                          }}
                        />
                      )}

                      {expanded && layer === 'elements' && (
                        <>
                          <PictureAdder pictures={pictures} gallery={gallery} labels={labels} onPick={(p) => add('elements', newElement(sheet, 'image', p))} />
                          <GalleryUpload gallery={gallery} labels={labels} onAdded={(next, first) => { updateGallery(next); add('elements', newElement(sheet, 'image', galleryResource(first))); }} />
                          <Button variant="outline" size="sm" onClick={() => add('elements', newElement(sheet, 'box'))}>{labels.coverAddBox}</Button>
                          <ShapeAdder labels={labels} onPick={(k) => add('elements', newBasicShape(sheet, k, '#808080'))} />
                        </>
                      )}
                      {expanded && layer === 'texts' && (
                        <TextAdder labels={labels} onPick={(field) => add('texts', newTextBox(sheet, field, field ? '' : labels.coverTextBoxNewWords))} />
                      )}
                      {expanded && layer === 'effects' && (
                        <>
                          <PictureAdder pictures={pictures} gallery={gallery} labels={labels} onPick={(p) => add('effects', newElement(sheet, 'image', p))} />
                          <TraceAdder traces={gallery.traces} label={labels.coverAddTracedVeil} onPick={(t) => add('effects', newShape(sheet, t, '#000000', 0.4))} />
                          <ShapeAdder labels={labels} onPick={(k) => { const shape = newBasicShape(sheet, k, '#000000'); add('effects', shape ? { ...shape, ...(shape.color ? { opacity: 0.4 } : {}) } : undefined); }} />
                          <Button variant="outline" size="sm" onClick={() => { const box = newElement(sheet, 'box', undefined, '#000000'); add('effects', box ? ({ ...box, opacity: 0.4 } as CoverElementSetting) : undefined); }}>
                            {labels.coverAddVeil}
                          </Button>
                        </>
                      )}
                      {expanded && layer === 'logos' && (
                        <LogoAdder
                          library={library}
                          pictures={pictures}
                          labels={labels}
                          onLibrary={(l) => add('logos', newLogo(sheet, { logoId: l.id }, l.width / l.height, l.clearance))}
                          onBook={(p) => add('logos', newLogo(sheet, { resourceId: p.id }, pictureAspect(p), DEFAULT_LOGO_CLEARANCE))}
                        />
                      )}
                      {expanded && layer === 'finishes' && (
                        <Select
                          size="sm"
                          value=""
                          onValueChange={(kind) => { if (kind) add('finishes', newFinish(sheet, kind as CoverFinishKind, finishLabel(kind as CoverFinishKind))); }}
                          options={[{ value: '', label: labels.coverAddFinish }, ...FINISH_KINDS.map((k) => ({ value: k, label: finishLabel(k) }))]}
                          ariaLabel={labels.coverAddFinish}
                        />
                      )}
                      {expanded && layer === 'finishes' && (
                        <TraceAdder traces={gallery.traces} label={labels.coverAddTracedFinish} onPick={(t) => add('finishes', newFinish(sheet, 'varnish', finishLabel('varnish'), t))} />
                      )}

                      {expanded && isItemLayer(layer) && list.length > 0 && (
                        <ul className="m-0 flex list-none flex-col gap-1 p-0">
                          {[...list].reverse().map((item) => (
                            <li key={item.id} className="flex items-center gap-1">
                              <button
                                type="button"
                                aria-pressed={item.id === selected && layer === active}
                                onClick={() => { setActive(layer); setSelected(item.id); setMode('edit'); }}
                                className={cn('flex w-full items-center gap-2 rounded px-2 py-1 text-start hover:bg-(--surface)', item.id === selected && layer === active && 'bg-(--surface) font-medium text-(--brand)')}
                              >
                                {layer === 'texts'
                                  ? <Type size={12} aria-hidden="true" />
                                  : layer === 'finishes'
                                  ? <Sparkles size={12} aria-hidden="true" />
                                  : layer === 'logos'
                                    ? <Stamp size={12} aria-hidden="true" />
                                    : (item as CoverElementSetting).kind === 'image'
                                      ? <ImageIcon size={12} aria-hidden="true" />
                                      : (item as CoverElementSetting).kind === 'shape'
                                        ? <PenTool size={12} aria-hidden="true" />
                                      : <Square size={12} aria-hidden="true" fill={(item as CoverElementSetting).color} />}
                                <span className={cn('truncate', layer === 'texts' && (item as CoverTextBox).hidden && 'text-(--slate) line-through')}>{layer === 'texts' ? boxName(item as CoverTextBox) : itemName(layer, item as CoverElementSetting | CoverFinishSetting)}</span>
                              </button>
                              {layer === 'texts' && (
                                <IconButton
                                  label={fill((item as CoverTextBox).hidden ? labels.coverTextBoxShow : labels.coverTextBoxHide, { name: boxName(item as CoverTextBox) })}
                                  icon={(item as CoverTextBox).hidden ? <EyeOff size={13} aria-hidden="true" /> : <Eye size={13} aria-hidden="true" />}
                                  onClick={() => { const b = item as CoverTextBox; const next = { ...b }; if (b.hidden) delete next.hidden; else next.hidden = true; changeBox(next, undefined); }}
                                />
                              )}
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
                  clearance={(id) => logos.find((l) => l.id === id)?.clearance ?? 0}
                  selected={selected}
                  points={points}
                  onSelect={pick}
                  onChange={changeItem}
                  onDuplicate={(el, rect) => duplicate(el.id, rect)}
                  onDelete={deleteItem}
                  onLaid={(doc) => setOverflow(overflowZones(doc))}
                  label={labels.coverDesignerTitle}
                  failedLabel={labels.productionPreviewFailed}
                />
              </main>

              <aside className={cn(SIDE, 'w-72 border-s')}>
                {mode === 'preview' ? (
                  <>
                    <h3 className="m-0 text-xs font-semibold uppercase tracking-wide text-(--slate)">{labels.coverChecks}</h3>
                    <CoverChecksList
                      checks={checks}
                      labels={labels}
                      nameOf={checkName}
                      onPick={(c) => {
                        if (!c.layer || !c.id) return;
                        setActive(c.layer);
                        setOpen(c.layer);
                        setSelected(c.id);
                        setMode('edit');
                      }}
                    />
                    <p className="m-0 text-(--slate)">{labels.coverGuidesLegend}</p>
                    {input.cover.designed && <p className="m-0 text-(--slate)">{labels.coverGuideMirror}</p>}
                    {input.cover.mirrorSkipped && <p className="m-0">{fill(labels.coverMirrorSkipped, { pictures: input.cover.mirrorSkipped.map(pictureName).join(', ') })}</p>}
                    {input.cover.clipSkipped && <p className="m-0">{fill(labels.coverClipSkipped, { pictures: input.cover.clipSkipped.map(pictureName).join(', ') })}</p>}
                    <Button variant="primary" size="sm" onClick={() => setMode('edit')}>{labels.coverDesignerEdit}</Button>
                  </>
                ) : selectedBox ? (
                  <TextBoxProperties
                    key={selectedBox.id}
                    box={selectedBox}
                    zone={zoneName(selectedBox.zone)}
                    fields={fields}
                    families={families}
                    labels={labels}
                    canForward={textBoxes[textBoxes.length - 1]?.id !== selectedBox.id}
                    canBackward={textBoxes[0]?.id !== selectedBox.id}
                    onChange={(b) => changeBox(b)}
                    onRestack={(step) => setDesign('texts', restack(textBoxes, selectedBox.id, step))}
                    onDelete={() => deleteItem(selectedBox.id)}
                    onDuplicate={() => duplicate(selectedBox.id)}
                  />
                ) : selectedFinish ? (
                  <FinishProperties
                    finish={selectedFinish}
                    targets={shapeTargets}
                    traces={gallery.traces}
                    onTrace={(t) => { const shaped = newFinish(sheet, selectedFinish.kind, selectedFinish.ink, t); if (shaped) setDesign('finishes', finishes.map((x) => (x.id === selectedFinish.id ? { ...x, shape: 'box' in x.shape ? { outline: t.outline, box: x.shape.box } : shaped.shape } : x))); }}
                    labels={labels}
                    finishLabel={finishLabel}
                    onChange={(f) => setDesign('finishes', finishes.map((x) => (x.id === f.id ? f : x)))}
                    onBox={() => { const box = newFinish(sheet, selectedFinish.kind, selectedFinish.ink); if (box) setDesign('finishes', finishes.map((x) => (x.id === selectedFinish.id ? { ...x, shape: box.shape } : x))); }}
                    canForward={finishes[finishes.length - 1]?.id !== selectedFinish.id}
                    canBackward={finishes[0]?.id !== selectedFinish.id}
                    onRestack={(step) => setDesign('finishes', restack(finishes, selectedFinish.id, step))}
                    onDelete={() => deleteItem(selectedFinish.id)}
                    onDuplicate={() => duplicate(selectedFinish.id)}
                    {...(selectedEl ? { zone: zoneName(selectedEl.zone) } : {})}
                  />
                ) : selectedEl ? (
                  <ElementProperties
                    // As it stands on this sheet (scaled when the format
                    // changed since it was placed): what is edited is that.
                    el={settled(selectedEl)}
                    layer={active}
                    zone={zoneName(selectedEl.zone)}
                    aspect={selectedEl.kind === 'image' ? aspectOf(selectedEl, allResources, library) : undefined}
                    clearance={active === 'logos' ? logos.find((l) => l.id === selectedEl.id)?.clearance : undefined}
                    traces={gallery.traces}
                    masks={gallery.pictures.filter((p) => p.role === 'mask')}
                    mask={maskOf(selectedEl)}
                    onMask={galleryPictureOf(gallery, selectedEl.resourceId) ? (m, invert) => void setMask(settled(selectedEl), m, invert) : undefined}
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
                    onDuplicate={() => duplicate(selectedEl.id)}
                    points={points}
                    onPoints={(on) => {
                      // A traced outline becomes nodes the first time its points are edited.
                      if (on && selectedEl.kind === 'shape' && !selectedEl.path && selectedEl.outline) {
                        const next = { ...selectedEl, path: outlineAsPath(selectedEl.outline) };
                        delete next.outline;
                        changeItem(next);
                      }
                      setPoints(on);
                    }}
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

/** A picture of the cover's gallery to add. */
function PictureAdder({ pictures, gallery, labels, onPick }: { pictures: readonly Resource[]; gallery: CoverGallery; labels: Labels; onPick: (p: Resource) => void }) {
  if (pictures.length === 0) return <p className="m-0 text-(--slate)">{labels.coverNoPictures}</p>;
  return (
    <Select
      size="sm"
      value=""
      onValueChange={(id) => { const picture = pictures.find((p) => p.id === id); if (picture) onPick(picture); }}
      options={[{ value: '', label: labels.coverAddPicture }, ...pictures.map((p) => ({ value: p.id, label: galleryPictureOf(gallery, p.id)?.name ?? p.id }))]}
      ariaLabel={labels.coverAddPicture}
    />
  );
}

/** Pictures uploaded into the cover's gallery from the designer; the
 *  first goes on the cover. */
function GalleryUpload({ gallery, labels, onAdded }: { gallery: CoverGallery; labels: Labels; onAdded: (next: CoverGallery, first: CoverGallery['pictures'][number]) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button variant="outline" size="sm" icon={<Plus size={13} />} onClick={() => ref.current?.click()}>{labels.coverUploadPicture}</Button>
      <input
        ref={ref}
        type="file"
        multiple
        accept={PICTURE_ACCEPT}
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          void galleryPicturesFrom(files, pictureSize, readPictureFile).then(({ pictures, unreadable, postscript }) => {
            if (postscript.length > 0) announce(fill(labels.productionPicturePostscript, { name: postscript.join(', ') }));
            if (unreadable > 0) announce(labels.productionPictureUnreadable);
            if (pictures[0]) onAdded({ ...gallery, pictures: [...gallery.pictures, ...pictures] }, pictures[0]);
          });
        }}
      />
    </>
  );
}

const SHAPE_LABEL: Record<BasicShape, keyof Labels> = {
  rectangle: 'coverShapeRectangle',
  ellipse: 'coverShapeEllipse',
  polygon: 'coverShapePolygon',
  star: 'coverShapeStar',
  line: 'coverShapeLine',
};

/** A basic shape to add, its points then editable. */
function ShapeAdder({ labels, onPick }: { labels: Labels; onPick: (k: BasicShape) => void }) {
  return (
    <Select
      size="sm"
      value=""
      onValueChange={(k) => { if (k) onPick(k as BasicShape); }}
      options={[{ value: '', label: labels.coverAddShape }, ...BASIC_SHAPES.map((k) => ({ value: k, label: String(labels[SHAPE_LABEL[k]]) }))]}
      ariaLabel={labels.coverAddShape}
    />
  );
}

/** A traced outline of the gallery to lay (as a veil, a finish). */
function TraceAdder({ traces, label, onPick }: { traces: readonly GalleryTrace[]; label: string; onPick: (t: GalleryTrace) => void }) {
  if (traces.length === 0) return null;
  return (
    <Select
      size="sm"
      value=""
      onValueChange={(id) => { const t = traces.find((x) => x.id === id); if (t) onPick(t); }}
      options={[{ value: '', label }, ...traces.map((t) => ({ value: t.id, label: t.name }))]}
      ariaLabel={label}
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

const FIELD_LABEL: Record<CoverField, keyof Labels> = {
  title: 'coverFieldTitle',
  subtitle: 'coverFieldSubtitle',
  author: 'coverFieldAuthor',
  back: 'productionZoneBack',
  spine: 'productionZoneSpine',
  flapFront: 'productionZoneFlapFront',
  flapBack: 'productionZoneFlapBack',
  front: 'productionZoneFront',
};
const fieldLabel = (labels: Labels, f: CoverField): string => String(labels[FIELD_LABEL[f]]);

/** A box's Markdown as the field shows it, its fields by their names
 *  (`{{Título}}`), and back. */
function fieldsShown(text: string, labels: Labels): string {
  return text.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (m, key: string) => (key in FIELD_LABEL ? `{{${fieldLabel(labels, key as CoverField)}}}` : m));
}
function fieldsStored(text: string, labels: Labels): string {
  const byName = new Map((Object.keys(FIELD_LABEL) as CoverField[]).map((f) => [fieldLabel(labels, f).toLocaleLowerCase(), f] as const));
  return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (m, name: string) => {
    const f = byName.get(name.toLocaleLowerCase()) ?? (name in FIELD_LABEL ? name : undefined);
    return f ? `{{${f}}}` : m;
  });
}

/** A new text box: of one of the general texts, or of words of its own. */
function TextAdder({ labels, onPick }: { labels: Labels; onPick: (field: (typeof COVER_FIELDS)[number] | undefined) => void }) {
  const OWN = '__own__';
  return (
    <Select
      size="sm"
      value=""
      onValueChange={(v) => { if (v) onPick(v === OWN ? undefined : (v as (typeof COVER_FIELDS)[number])); }}
      options={[{ value: '', label: labels.coverAddText }, ...COVER_FIELDS.map((f) => ({ value: f, label: fieldLabel(labels, f) })), { value: OWN, label: labels.coverAddTextOwn }]}
      ariaLabel={labels.coverAddText}
    />
  );
}

const ROLE_LABEL: Record<TextBoxRole, keyof Labels> = { h1: 'coverTextRoleH1', h2: 'coverTextRoleH2', h3: 'coverTextRoleH3', text: 'coverTextRoleText' };

/** A text box: its words (Markdown, the general texts by their names),
 *  whether it shows, how it sits and turns, and the type of each of its
 *  roles. */
function TextBoxProperties({ box, zone, fields, families, labels, canForward, canBackward, onChange, onRestack, onDelete, onDuplicate }: {
  box: CoverTextBox;
  zone: string;
  fields: CoverTexts;
  families: string[];
  labels: Labels;
  canForward: boolean;
  canBackward: boolean;
  onChange: (box: CoverTextBox) => void;
  onRestack: (step: 1 | -1) => void;
  onDelete: () => void;
  onDuplicate: () => void;
}) {
  const [role, setRole] = useState<TextBoxRole>(() => (/^#\s/.test(box.text.trim()) ? 'h1' : 'text'));
  const [draft, setDraft] = useState(() => fieldsShown(box.text, labels));
  const set = (patch: Partial<CoverTextBox>, drop: (keyof CoverTextBox)[] = []) => {
    const next = { ...box, ...patch };
    for (const k of drop) delete next[k];
    onChange(next);
  };
  const empty = COVER_FIELDS.filter((f) => fieldsIn(box.text).includes(f) && !fields[f]?.trim());
  return (
    <>
      <h3 className="m-0 text-xs font-semibold uppercase tracking-wide text-(--slate)">{labels.coverTextBox}</h3>
      <NameField value={box.name} label={labels.productionGalleryName} onChange={(name) => (name ? set({ name }) : set({}, ['name']))} />
      <p className="m-0 text-(--slate)">{fill(labels.coverElementZone, { zone })}</p>
      <label className="flex flex-col gap-1">
        {labels.coverTextBoxText}
        <textarea
          value={draft}
          rows={5}
          onChange={(e) => { setDraft(e.target.value); set({ text: fieldsStored(e.target.value, labels) }); }}
          className="rounded border border-(--pt-control-border) bg-(--background) px-2 py-1 font-mono text-xs text-(--foreground)"
        />
      </label>
      <Select
        size="sm"
        value=""
        onValueChange={(f) => {
          if (!f) return;
          const shown = `${draft.trim() ? `${draft.trimEnd()}\n\n` : ''}{{${fieldLabel(labels, f as CoverField)}}}`;
          setDraft(shown);
          set({ text: fieldsStored(shown, labels) });
        }}
        options={[{ value: '', label: labels.coverTextBoxInsert }, ...COVER_FIELDS.map((f) => ({ value: f, label: fieldLabel(labels, f) }))]}
        ariaLabel={labels.coverTextBoxInsert}
      />
      <p className="m-0 text-(--slate)">{labels.coverTextBoxHint}</p>
      {empty.length > 0 && <p className="m-0">{fill(labels.coverTextBoxEmptyFields, { fields: empty.map((f) => fieldLabel(labels, f)).join(', ') })}</p>}
      <label className="flex items-center justify-between gap-2">
        <span>{labels.coverTextBoxHidden}</span>
        <Switch checked={!!box.hidden} onCheckedChange={(on) => (on ? set({ hidden: true }) : set({}, ['hidden']))} ariaLabel={labels.coverTextBoxHidden} />
      </label>
      <div className="flex flex-col gap-1">
        {labels.productionStyleVertical}
        <SegmentedControl
          size="sm"
          value={box.vertical ?? 'top'}
          onValueChange={(v) => (v === 'top' ? set({}, ['vertical']) : set({ vertical: v }))}
          options={[
            { value: 'top', label: labels.productionVerticalTop },
            { value: 'middle', label: labels.productionVerticalMiddle },
            { value: 'bottom', label: labels.productionVerticalBottom },
          ]}
          ariaLabel={labels.productionStyleVertical}
        />
      </div>
      <div className="flex flex-col gap-1">
        {labels.coverTextBoxTurn}
        <SegmentedControl
          size="sm"
          value={box.rotate === -90 ? 'up' : box.rotate === 90 ? 'down' : 'none'}
          onValueChange={(v) => (v === 'none' ? set({}, ['rotate']) : set({ rotate: v === 'up' ? -90 : 90 }))}
          options={[
            { value: 'none', label: labels.coverTextBoxTurnNone },
            { value: 'up', label: labels.coverTextBoxTurnUp },
            { value: 'down', label: labels.coverTextBoxTurnDown },
          ]}
          ariaLabel={labels.coverTextBoxTurn}
        />
      </div>
      <div className="flex flex-col gap-1">
        {labels.coverTextBoxStyleOf}
        <SegmentedControl
          size="sm"
          value={role}
          onValueChange={setRole}
          options={TEXT_BOX_ROLES.map((r) => ({ value: r, label: String(labels[ROLE_LABEL[r]]) }))}
          ariaLabel={labels.coverTextBoxStyleOf}
        />
      </div>
      <RoleFields
        key={role}
        legend={String(labels[ROLE_LABEL[role]])}
        style={box.styles?.[role] ?? {}}
        families={families}
        labels={labels}
        more
        onChange={(st) => {
          const styles = { ...box.styles };
          if (Object.keys(st).length) styles[role] = st;
          else delete styles[role];
          if (Object.keys(styles).length) set({ styles });
          else set({}, ['styles']);
        }}
      />
      <div className="flex items-center gap-1">
        <IconButton label={labels.coverElementForward} icon={<ArrowUp size={14} aria-hidden="true" />} disabled={!canForward} onClick={() => onRestack(1)} />
        <IconButton label={labels.coverElementBackward} icon={<ArrowDown size={14} aria-hidden="true" />} disabled={!canBackward} onClick={() => onRestack(-1)} />
        <IconButton label={labels.coverElementDuplicate} icon={<Copy size={14} aria-hidden="true" />} onClick={onDuplicate} />
        <IconButton label={labels.coverElementDelete} icon={<Trash2 size={14} aria-hidden="true" />} onClick={onDelete} />
      </div>
    </>
  );
}

/** An item's own name, kept when the field is left (empty: none). */
function NameField({ value, label, onChange }: { value: string | undefined; label: string; onChange: (name: string) => void }) {
  return (
    <label className="flex flex-col gap-1">
      {label}
      <input
        type="text"
        defaultValue={value ?? ''}
        onBlur={(e) => { const name = e.target.value.trim(); if (name !== (value ?? '')) onChange(name); }}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        className="rounded border border-(--pt-control-border) bg-(--background) px-2 py-1 text-xs text-(--foreground)"
      />
    </label>
  );
}

/** The value of an outline the design keeps whose trace was deleted since. */
const KEPT = '__kept__';

/** The selected item's place, size and colour (an effect's opacity, a
 *  logo's clear space), and its order. A picture's height follows its
 *  width (its proportions). */
function ElementProperties({ el, layer, zone, aspect, clearance, traces, masks, mask, onMask, points, onPoints, canForward, canBackward, labels, onChange, onClearance, onSize, onRestack, onDelete, onDuplicate }: {
  /** The gallery's masks, the one the picture is masked with, and how to
   *  mask it (none for a picture that is not the gallery's). */
  masks: readonly GalleryPicture[];
  mask: { mask: string; invert: boolean } | undefined;
  onMask: ((mask: string | undefined, invert: boolean) => void) | undefined;
  points: boolean;
  onPoints: (on: boolean) => void;
  el: CoverElementSetting;
  traces: readonly GalleryTrace[];
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
  onDuplicate: () => void;
}) {
  const row = (label: string, value: number, set: (v: number) => void, min?: number, max?: number, step = 0.5) => (
    <label className="flex items-center justify-between gap-2">
      <span>{label}</span>
      <NumberField value={round1(value)} onValueChange={set} step={step} widthCh={6} ariaLabel={label} {...(min !== undefined ? { min } : {})} {...(max !== undefined ? { max } : {})} />
    </label>
  );
  const title = layer === 'logos' ? labels.coverItemLogo : layer === 'effects' ? labels.coverItemEffect : el.kind === 'image' ? labels.coverElementPicture : el.kind === 'shape' ? labels.coverElementShape : labels.coverElementBox;
  return (
    <>
      <h3 className="m-0 text-xs font-semibold uppercase tracking-wide text-(--slate)">{title}</h3>
      <NameField key={el.id} value={el.name} label={labels.productionGalleryName} onChange={(name) => { const next = { ...el }; if (name) next.name = name; else delete next.name; onChange(next); }} />
      <p className="m-0 text-(--slate)">{fill(labels.coverElementZone, { zone })}</p>
      {row(labels.coverElementX, el.x, (x) => onChange({ ...el, x }))}
      {row(labels.coverElementY, el.y, (y) => onChange({ ...el, y }))}
      {row(labels.coverElementWidth, el.width, (w) => onSize(w, aspect ? w / aspect : el.height), 2)}
      {row(labels.coverElementHeight, el.height, (h) => onSize(aspect ? h * aspect : el.width, h), 2)}
      {el.kind !== 'image' && (
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
      {layer === 'effects' && el.kind !== 'image' && row(labels.coverElementOpacity, (el.opacity ?? 1) * 100, (v) => {
        const o = Math.max(0, Math.min(100, v)) / 100;
        const next = { ...el };
        if (o >= 1) delete next.opacity;
        else next.opacity = o;
        onChange(next);
      }, 0, 100, 5)}
      {layer === 'elements' && (
        <label className="flex items-center justify-between gap-2">
          <span>{labels.coverElementMirror}</span>
          <Switch
            checked={el.bleed !== 'own'}
            onCheckedChange={(on) => {
              const next = { ...el };
              if (on) delete next.bleed;
              else next.bleed = 'own';
              onChange(next);
            }}
            ariaLabel={labels.coverElementMirror}
          />
        </label>
      )}
      {layer === 'elements' && <p className="m-0 text-(--slate)">{el.bleed === 'own' ? labels.coverElementMirrorOff : labels.coverElementMirrorOn}</p>}
      {(layer === 'elements' || layer === 'effects') && el.kind === 'image' && onMask && (masks.length > 0 || mask) && (
        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1">
            {labels.coverElementMask}
            <Select
              size="sm"
              value={mask?.mask ?? ''}
              onValueChange={(id) => onMask(id || undefined, mask?.invert ?? false)}
              options={[{ value: '', label: labels.coverElementMaskNone }, ...masks.map((m) => ({ value: m.id, label: m.name }))]}
              ariaLabel={labels.coverElementMask}
            />
          </label>
          {mask && (
            <label className="flex items-center justify-between gap-2">
              <span>{labels.coverElementMaskInvert}</span>
              <Switch checked={mask.invert} onCheckedChange={(on) => onMask(mask.mask, on)} ariaLabel={labels.coverElementMaskInvert} />
            </label>
          )}
        </div>
      )}
      {(layer === 'elements' || layer === 'effects') && el.kind === 'image' && (traces.length > 0 || el.clip) && (
        <label className="flex flex-col gap-1">
          {labels.coverElementClip}
          <Select
            size="sm"
            value={el.clip ? (traces.find((t) => JSON.stringify(t.outline) === JSON.stringify(el.clip))?.id ?? KEPT) : ''}
            onValueChange={(id) => {
              const next = { ...el };
              const t = traces.find((x) => x.id === id);
              if (t) next.clip = t.outline;
              else if (id === '') delete next.clip;
              onChange(next);
            }}
            options={[
              { value: '', label: labels.coverElementClipNone },
              ...(el.clip && !traces.some((t) => JSON.stringify(t.outline) === JSON.stringify(el.clip)) ? [{ value: KEPT, label: labels.coverFinishShapeOutline }] : []),
              ...traces.map((t) => ({ value: t.id, label: t.name })),
            ]}
            ariaLabel={labels.coverElementClip}
          />
        </label>
      )}
      {el.kind === 'shape' && (
        <div className="flex flex-col gap-1">
          <Button variant={points ? 'primary' : 'outline'} size="sm" icon={<PenTool size={13} />} onClick={() => onPoints(!points)}>
            {points ? labels.coverPointsDone : labels.coverPointsEdit}
          </Button>
          {points && <p className="m-0 text-(--slate)">{labels.coverPointsHint}</p>}
        </div>
      )}
      {(layer === 'elements' || layer === 'effects') && el.kind !== 'image' && <CoverEffectsFields el={el} labels={labels} onChange={onChange} />}
      {layer === 'logos' && clearance !== undefined && row(labels.coverLogoClearance, clearance, (v) => onClearance(Math.max(0, v)), 0)}
      <div className="flex items-center gap-1">
        <IconButton label={labels.coverElementForward} icon={<ArrowUp size={14} aria-hidden="true" />} disabled={!canForward} onClick={() => onRestack(1)} />
        <IconButton label={labels.coverElementBackward} icon={<ArrowDown size={14} aria-hidden="true" />} disabled={!canBackward} onClick={() => onRestack(-1)} />
        <IconButton label={labels.coverElementDuplicate} icon={<Copy size={14} aria-hidden="true" />} onClick={onDuplicate} />
        <IconButton label={labels.coverElementDelete} icon={<Trash2 size={14} aria-hidden="true" />} onClick={onDelete} />
      </div>
    </>
  );
}

/** A finish's kind, the ink its plate is named after, and its shape: a box
 *  of its own (moved on the canvas) or an element's. */
function FinishProperties({ finish, targets, traces, zone, labels, finishLabel, onChange, onBox, onTrace, canForward, canBackward, onRestack, onDelete, onDuplicate }: {
  finish: CoverFinishSetting;
  targets: { value: string; label: string }[];
  traces: readonly GalleryTrace[];
  onTrace: (t: GalleryTrace) => void;
  zone?: string;
  labels: Labels;
  finishLabel: (k: CoverFinishKind) => string;
  onChange: (f: CoverFinishSetting) => void;
  onBox: () => void;
  canForward: boolean;
  canBackward: boolean;
  onRestack: (step: 1 | -1) => void;
  onDelete: () => void;
  onDuplicate: () => void;
}) {
  const ofElement = 'element' in finish.shape;
  const ofOutline = 'outline' in finish.shape;
  // The saved outline the finish lies on (by its points: the design keeps
  // a copy of them, not the trace).
  const laidOn = ofOutline ? traces.find((t) => JSON.stringify(t.outline) === JSON.stringify((finish.shape as { outline: unknown }).outline)) : undefined;
  return (
    <>
      <h3 className="m-0 text-xs font-semibold uppercase tracking-wide text-(--slate)">{labels.coverItemFinish}</h3>
      <NameField key={finish.id} value={finish.name} label={labels.productionGalleryName} onChange={(name) => { const next = { ...finish }; if (name) next.name = name; else delete next.name; onChange(next); }} />
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
        <Select
          size="sm"
          value={ofElement ? 'element' : ofOutline ? 'outline' : 'box'}
          onValueChange={(v) => {
            if (v === 'box') onBox();
            else if (v === 'outline') { if (traces[0]) onTrace(traces[0]); }
            else if (targets[0]) onChange({ ...finish, shape: { element: targets[0].value } });
          }}
          options={[
            { value: 'box', label: labels.coverFinishShapeBox },
            ...(targets.length > 0 ? [{ value: 'element', label: labels.coverFinishShapeElement }] : []),
            ...(traces.length > 0 ? [{ value: 'outline', label: labels.coverFinishShapeOutline }] : []),
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
      {ofOutline && (
        <Select
          size="sm"
          value={laidOn?.id ?? ''}
          onValueChange={(id) => { const t = traces.find((x) => x.id === id); if (t) onTrace(t); }}
          options={[...(laidOn ? [] : [{ value: '', label: labels.coverFinishShapeOutline }]), ...traces.map((t) => ({ value: t.id, label: t.name }))]}
          ariaLabel={labels.coverFinishShapeOutline}
        />
      )}
      <p className="m-0 text-(--slate)">{labels.coverFinishPlateHint}</p>
      <div className="flex items-center gap-1">
        <IconButton label={labels.coverElementForward} icon={<ArrowUp size={14} aria-hidden="true" />} disabled={!canForward} onClick={() => onRestack(1)} />
        <IconButton label={labels.coverElementBackward} icon={<ArrowDown size={14} aria-hidden="true" />} disabled={!canBackward} onClick={() => onRestack(-1)} />
        <IconButton label={labels.coverElementDuplicate} icon={<Copy size={14} aria-hidden="true" />} onClick={onDuplicate} />
        <IconButton label={labels.coverElementDelete} icon={<Trash2 size={14} aria-hidden="true" />} onClick={onDelete} />
      </div>
    </>
  );
}
