// The pictures a cover sheet carries itself (the barcode, the library's
// logos), decoded for the canvas, which draws pictures it has been given.

import { registerResourceImage, type MirrorPicture, type Resource } from 'postext';
import { getBlob } from '../storage/blobStore.js';
import type { CoverDesignSettings } from './bookProduction.js';
import { sniffLogoMime } from './logoLibrary.js';

/** Decode the sheet's own pictures (the barcode, the library's logos) for
 *  the canvas: an SVG from its text, a PNG or JPEG from its bytes. */
export async function registerCoverImages(files: Record<string, Uint8Array>): Promise<void> {
  await Promise.all(Object.entries(files).map(async ([fileId, bytes]) => {
    const mime = sniffLogoMime(bytes);
    if (!mime) return;
    const img = new Image();
    img.src = mime === 'image/svg+xml'
      ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new TextDecoder().decode(bytes))}`
      : URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
    await img.decode().catch(() => undefined);
    registerResourceImage(fileId, img, { vector: mime === 'image/svg+xml', singleInk: false });
  }));
}

/** The pictures a cover's mirror bleed draws: the background picture and
 *  the movable elements' that are PNG or JPEG bitmaps of the book, as data
 *  URIs (an SVG picture is left out of the mirror). */
export async function loadMirrorPictures(design: CoverDesignSettings | undefined, resources: readonly Resource[]): Promise<Record<string, MirrorPicture>> {
  const ids = new Set([design?.image?.resourceId, ...(design?.elements ?? []).map((e) => e.resourceId)].filter((id): id is string => !!id));
  const out: Record<string, MirrorPicture> = {};
  for (const id of ids) {
    const r = resources.find((x) => x.id === id);
    const bitmap = r?.kind === 'bitmap' ? r.bitmap : undefined;
    if (!bitmap?.fileId || !bitmap.width || !bitmap.height) continue;
    const rec = await getBlob(bitmap.fileId).catch(() => null);
    if (!rec) continue;
    const bytes = new Uint8Array(rec.bytes);
    const mime = sniffLogoMime(bytes);
    if (mime !== 'image/png' && mime !== 'image/jpeg') continue;
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    out[id] = { href: `data:${mime};base64,${btoa(bin)}`, width: bitmap.width, height: bitmap.height };
  }
  return out;
}
