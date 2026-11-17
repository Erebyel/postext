// The pictures a cover sheet carries itself (the barcode, the library's
// logos), decoded for the canvas, which draws pictures it has been given.

import { registerResourceImage } from 'postext';
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
