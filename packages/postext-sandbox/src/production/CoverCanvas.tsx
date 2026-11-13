'use client';

/**
 * The cover designer's sheet: the cover laid out as the PDF is, drawn as
 * large as the room allows, with its guides over it — the edge of the
 * bleed or turn-in, the folds, scores and joints, and each zone's safe
 * area. In edit mode the movable elements can be picked, dragged and
 * resized on it: nothing snaps unless Alt is held, and Shift keeps an
 * element's proportions. The sheet is laid out again once a drag ends;
 * while it goes on, the element's box follows the pointer.
 */

import { useEffect, useRef, useState } from 'react';
import { renderPageToCanvas, type ProductionSheet, type SheetRect, type VDTDocument } from 'postext';
import { ensureConfigFontsLoaded } from '../controls/fonts/fontLoader.js';
import { ensureResourceImages } from '../controls/media/resourceImages.js';
import { useLayoutWorker } from '../worker/useLayoutWorker.js';
import { handleAt, handlePoint, RESIZE_HANDLES, type Handle } from '../templates/frameGeometry.js';
import type { coverDocumentInput } from './bookProduction.js';
import { elementAt, elementRect, elementUnder, type CoverElementSetting } from './coverLayers.js';
import { coverSnapLines, dragCoverRect } from './coverDrag.js';
import { registerCoverImages } from './SheetPreview.js';

const MM_PER_IN = 25.4;
/** Handles and the room to grab them, CSS px. */
const HANDLE_PX = 8;
/** How near an edge lines up with Alt held, CSS px. */
const SNAP_PX = 6;

type Drag = { id: string; handle: Handle; start: SheetRect; x0: number; y0: number; moved: boolean };

export function CoverCanvas({ sheet, input, mode, elements, selected, onSelect, onChange, onDelete, label, failedLabel }: {
  sheet: ProductionSheet;
  input: ReturnType<typeof coverDocumentInput>;
  mode: 'preview' | 'edit';
  elements: readonly CoverElementSetting[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onChange: (el: CoverElementSetting) => void;
  onDelete: (id: string) => void;
  label: string;
  failedLabel: string;
}) {
  const { build } = useLayoutWorker('preview');
  const [doc, setDoc] = useState<VDTDocument | null>(null);
  const [failed, setFailed] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [room, setRoom] = useState({ width: 0, height: 0 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [draft, setDraft] = useState<SheetRect | null>(null);

  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      void (async () => {
        try {
          await ensureConfigFontsLoaded(input.config, input.markdown);
          await registerCoverImages(input.cover.files);
          await ensureResourceImages(input.resources.filter((r) => r.id !== 'isbn-barcode'));
          const laid = await build({ markdown: input.markdown, resources: input.resources }, input.config);
          if (alive) {
            setDoc(laid);
            setFailed(false);
          }
        } catch (err) {
          if (alive && !(err instanceof DOMException && err.name === 'AbortError')) setFailed(true);
        }
      })();
    }, 150);
    return () => { alive = false; clearTimeout(t); };
  }, [build, input]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const measure = () => setRoom({ width: wrap.clientWidth, height: wrap.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  const page = doc?.pages[0];
  const dpi = doc?.config.page.dpi ?? 96;
  const pageMm = page ? { width: (page.width * MM_PER_IN) / dpi, height: (page.height * MM_PER_IN) / dpi } : null;
  // The sheet's corner (the bleed's) on the laid-out page, which has room
  // for the cut marks round it.
  const offset = doc ? (doc.trimOffset * MM_PER_IN) / dpi - sheet.trim.x : 0;
  const scale = pageMm && room.width > 0 ? Math.min(room.width / pageMm.width, room.height / pageMm.height) : 0;
  const css = pageMm ? { width: pageMm.width * scale, height: pageMm.height * scale } : { width: 0, height: 0 };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !doc || !page || scale <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    renderPageToCanvas(page, doc, canvas, { scale: (css.width * dpr) / page.width });
    canvas.style.width = `${css.width}px`;
    canvas.style.height = `${css.height}px`;
  }, [doc, page, scale, css.width, css.height]);

  /** A pointer event's place on the sheet, mm. */
  const toSheet = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale - offset, y: (e.clientY - r.top) / scale - offset };
  };
  const selectedEl = elements.find((e) => e.id === selected);
  const selectedRect = selectedEl ? (drag?.id === selectedEl.id && draft ? draft : elementRect(sheet, selectedEl)) : undefined;

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (mode !== 'edit' || e.button !== 0 || scale <= 0) return;
    const p = toSheet(e);
    const tol = HANDLE_PX / scale;
    let target: CoverElementSetting | undefined;
    let handle: Handle | null = null;
    if (selectedEl && selectedRect) {
      handle = handleAt(selectedRect, p.x, p.y, tol);
      if (handle) target = selectedEl;
    }
    if (!target) {
      target = elementUnder(sheet, elements, p.x, p.y);
      handle = target ? 'move' : null;
    }
    onSelect(target?.id ?? null);
    const start = target ? elementRect(sheet, target) : undefined;
    if (!target || !handle || !start) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ id: target.id, handle, start, x0: p.x, y0: p.y, moved: false });
    setDraft(start);
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drag) return;
    const p = toSheet(e);
    const snap = e.altKey ? { ...coverSnapLines(sheet), tol: SNAP_PX / scale } : undefined;
    setDraft(dragCoverRect(drag.start, drag.handle, p.x - drag.x0, p.y - drag.y0, { ...(snap ? { snap } : {}), keepAspect: e.shiftKey }));
    if (!drag.moved) setDrag({ ...drag, moved: true });
  };
  const onPointerUp = () => {
    const el = drag && elements.find((x) => x.id === drag.id);
    if (drag?.moved && el && draft) onChange(elementAt(sheet, el, draft));
    setDrag(null);
    setDraft(null);
  };
  const onKeyDown = (e: React.KeyboardEvent<SVGSVGElement>) => {
    if (mode !== 'edit' || !selectedEl) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      onDelete(selectedEl.id);
      return;
    }
    const step = e.shiftKey ? 10 : 1;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    const r = elementRect(sheet, selectedEl);
    if (!d || !r) return;
    e.preventDefault();
    onChange(elementAt(sheet, selectedEl, { ...r, x: r.x + d[0]!, y: r.y + d[1]! }));
  };

  const px = scale > 0 ? 1 / scale : 0;
  return (
    <div ref={wrapRef} className="relative flex h-full w-full items-center justify-center overflow-hidden">
      {failed && <p className="m-0 p-2 text-xs text-(--slate)">{failedLabel}</p>}
      {!failed && pageMm && (
        <div className="relative shadow-lg" style={{ width: css.width, height: css.height }}>
          <canvas ref={canvasRef} className="block" />
          <svg
            ref={svgRef}
            role="application"
            aria-label={label}
            tabIndex={0}
            className="absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-(--brand)"
            width={css.width}
            height={css.height}
            viewBox={`0 0 ${pageMm.width} ${pageMm.height}`}
            style={{ cursor: mode === 'edit' ? (drag ? 'grabbing' : 'default') : 'auto', touchAction: 'none' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onKeyDown={onKeyDown}
          >
            <g transform={`translate(${offset} ${offset})`} fill="none" strokeWidth={px}>
              <rect x={0} y={0} width={sheet.width} height={sheet.height} stroke="#e00000" strokeDasharray={`${4 * px} ${3 * px}`} />
              {sheet.lines.map((l, i) => (
                <line key={`l${i}`} x1={l.x} x2={l.x} y1={0} y2={sheet.height} stroke="#e4007c" />
              ))}
              {sheet.zones.map((z) => (
                <rect key={z.name} x={z.safe.x} y={z.safe.y} width={z.safe.width} height={z.safe.height} stroke="#00a0e0" strokeDasharray={`${3 * px} ${3 * px}`} />
              ))}
              {mode === 'edit' && elements.map((el) => {
                const r = drag?.id === el.id && draft ? draft : elementRect(sheet, el);
                if (!r) return null;
                const on = el.id === selected;
                return <rect key={el.id} x={r.x} y={r.y} width={r.width} height={r.height} stroke={on ? '#2563eb' : '#64748b'} strokeWidth={on ? 2 * px : px} strokeDasharray={on ? undefined : `${2 * px} ${2 * px}`} />;
              })}
              {mode === 'edit' && selectedRect && RESIZE_HANDLES.map((h) => {
                const p = handlePoint(selectedRect, h);
                const s = HANDLE_PX * px;
                return <rect key={h} x={p.x - s / 2} y={p.y - s / 2} width={s} height={s} fill="#ffffff" stroke="#2563eb" />;
              })}
            </g>
          </svg>
        </div>
      )}
    </div>
  );
}
