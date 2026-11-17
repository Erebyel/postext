'use client';

/**
 * The Cover panel's logo library: the publisher's, the collections' and
 * seals, uploaded once and placed on any book's cover from the designer.
 * Each keeps its clear space; the library goes between users as a file.
 */

import { useEffect, useMemo, useRef } from 'react';
import { Download, Trash2, Upload } from 'lucide-react';
import { ConfirmPopover, IconButton, NumberField, Select, announce } from '../ui/index.js';
import { downloadBytes } from '../storage/persistence.js';
import { fill } from '../print/fillTokens.js';
import {
  DEFAULT_LOGO_CLEARANCE,
  LOGO_GROUPS,
  exportLogos,
  importLogos,
  newLogoId,
  sniffLogoMime,
  svgSize,
  type LogoGroup,
  type LogoRecord,
} from './logoLibrary.js';
import { deleteLogo, putLogos } from './productionStore.js';
import { useLogos } from './useProduction.js';
import { INPUT, type Labels } from './productionUi.js';

const GROUP_LABEL: Record<LogoGroup, keyof Labels> = {
  publisher: 'productionLogoGroupPublisher',
  collection: 'productionLogoGroupCollection',
  seal: 'productionLogoGroupSeal',
};

/** A picture's size in px: an SVG's own, a bitmap's decoded. */
async function pictureSize(bytes: Uint8Array, mime: LogoRecord['mime']): Promise<{ width: number; height: number }> {
  if (mime === 'image/svg+xml') return svgSize(new TextDecoder().decode(bytes)) ?? { width: 100, height: 100 };
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}

function Thumb({ logo }: { logo: LogoRecord }) {
  const url = useMemo(() => URL.createObjectURL(new Blob([logo.bytes as BlobPart], { type: logo.mime })), [logo.bytes, logo.mime]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return <img src={url} alt="" className="h-8 w-12 shrink-0 rounded border border-(--rule) bg-white object-contain p-0.5" />;
}

export function LogoLibrary({ labels }: { labels: Labels }) {
  const logos = useLogos();
  const uploadRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);

  const upload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    const added: LogoRecord[] = [];
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const mime = sniffLogoMime(bytes);
      if (!mime) {
        announce(labels.productionLogoUnreadable);
        continue;
      }
      const size = await pictureSize(bytes, mime).catch(() => ({ width: 100, height: 100 }));
      added.push({
        id: newLogoId(),
        name: file.name.replace(/\.[^.]+$/, ''),
        group: 'publisher',
        clearance: DEFAULT_LOGO_CLEARANCE,
        mime,
        bytes,
        ...size,
        updatedAt: Date.now(),
      });
    }
    await putLogos(added);
  };
  const importFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const read = importLogos(JSON.parse(await file.text()));
      if (!read.ok || read.logos.length === 0) {
        announce(labels.productionLogosImportFailed);
        return;
      }
      await putLogos(read.logos);
      announce(fill(labels.productionLogosImported, { count: String(read.logos.length) }));
    } catch {
      announce(labels.productionLogosImportFailed);
    }
  };
  const change = (logo: LogoRecord, patch: Partial<LogoRecord>) => void putLogos([{ ...logo, ...patch, updatedAt: Date.now() }]);

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-(--rule) p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="m-0 text-xs font-semibold">{labels.productionLogos}</h3>
        <span className="flex items-center gap-1">
          <IconButton label={labels.productionLogoUpload} icon={<Upload size={14} aria-hidden="true" />} onClick={() => uploadRef.current?.click()} />
          <IconButton label={labels.productionLogoImport} icon={<Upload size={14} aria-hidden="true" className="rotate-180" />} onClick={() => importRef.current?.click()} />
          {logos.length > 0 && (
            <IconButton
              label={labels.productionLogoExport}
              icon={<Download size={14} aria-hidden="true" />}
              onClick={() => downloadBytes(JSON.stringify(exportLogos(logos)), 'logos.postext-logos.json', 'application/json')}
            />
          )}
        </span>
        <input ref={uploadRef} type="file" multiple accept="image/png,image/jpeg,image/svg+xml,.svg" className="hidden" aria-hidden="true" tabIndex={-1} onChange={(e) => void upload(e)} />
        <input ref={importRef} type="file" accept=".json,application/json" className="hidden" aria-hidden="true" tabIndex={-1} onChange={(e) => void importFile(e)} />
      </div>
      <p className="m-0 text-xs text-(--slate)">{labels.productionLogosIntro}</p>
      {logos.length === 0 && <p className="m-0 text-xs text-(--slate)">{labels.productionLogoEmpty}</p>}
      <ul className="m-0 flex list-none flex-col gap-2 p-0 text-xs">
        {logos.map((logo) => (
          <li key={logo.id} className="flex flex-col gap-1 rounded border border-(--rule) p-2">
            <div className="flex items-center gap-2">
              <Thumb logo={logo} />
              <input
                type="text"
                aria-label={labels.productionVersionName}
                defaultValue={logo.name}
                onBlur={(e) => { if (e.target.value.trim() && e.target.value !== logo.name) change(logo, { name: e.target.value.trim() }); }}
                className={`${INPUT} min-w-0 flex-1`}
              />
              <ConfirmPopover message={`${labels.productionLogoDelete}: ${logo.name}`} confirmLabel={labels.productionLogoDelete} onConfirm={() => void deleteLogo(logo.id)}>
                {({ open }) => <IconButton label={`${labels.productionLogoDelete}: ${logo.name}`} icon={<Trash2 size={14} aria-hidden="true" />} onClick={open} />}
              </ConfirmPopover>
            </div>
            <div className="flex items-center justify-between gap-2">
              <Select
                size="sm"
                value={logo.group}
                onValueChange={(group) => change(logo, { group })}
                options={LOGO_GROUPS.map((g) => ({ value: g, label: String(labels[GROUP_LABEL[g]]) }))}
                ariaLabel={`${logo.name}: ${labels.productionLogoGroupPublisher}`}
              />
              <label className="flex items-center gap-1">
                <span className="text-(--slate)">{labels.coverLogoClearance}</span>
                <NumberField value={logo.clearance} onValueChange={(v) => change(logo, { clearance: Math.max(0, v) })} step={0.5} min={0} widthCh={5} ariaLabel={`${logo.name}: ${labels.coverLogoClearance}`} />
              </label>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
