import { resolveColorValue, resolveDiagramStyleConfig, type PostextConfig, type Resource, type VDTDocument } from 'postext';
import type { EpubCover } from 'postext-epub';
import { ensureResourceImages } from '../controls/media/resourceImages.js';
import { renderCoverImage } from '../covers/useAutoCover.js';
import { productionEpubCover } from '../production/promoImage.js';
import { bookCoverPicture, RENDERED_COVER_WIDTH, usableCover } from './inputs.js';

/** The cover: the one the book's Cover panel designs, when it has a
 *  version there (a cover of its own, which the fixed layout gives a
 *  page); else the book's own picture when it is a bitmap large enough,
 *  else its first page painted at {@link RENDERED_COVER_WIDTH}. Those two
 *  are pictures of the first page (the Sandbox's covers are captures of
 *  it), so the fixed layout keeps them as the cover image without a page
 *  of their own. `productionKey` is the book's key in the Cover panel's
 *  store (its project id). Shared by the EPUB tab and the book compiler. */
export async function epubCoverOf(
  first: VDTDocument,
  snapshot: { config: PostextConfig; resources: Resource[] },
  title: string,
  source: Parameters<typeof bookCoverPicture>[0],
  productionKey?: string,
): Promise<EpubCover | null> {
  const designed = productionKey
    ? await productionEpubCover(productionKey, snapshot.config, snapshot.resources, title).catch(() => null)
    : null;
  if (designed) return designed;
  const picture = await bookCoverPicture(source);
  const own = picture ? await usableCover(picture.bytes, picture.mime, title) : null;
  if (own) return { ...own, showsFirstPage: true };
  const page = first.pages[0];
  if (!page) return null;
  // The page's pictures as the canvas paints them.
  const ds = resolveDiagramStyleConfig(snapshot.config.diagramStyle);
  const ink = ds.singleInk ? resolveColorValue(ds.inkColor, snapshot.config.colorPalette, ds.inkColor).hex : null;
  await ensureResourceImages(snapshot.resources, ink, { inlineFonts: ds.inlineFonts }).catch(() => false);
  if (typeof document !== 'undefined' && document.fonts) await document.fonts.ready;
  const image = await renderCoverImage(page, first, true, { width: RENDERED_COVER_WIDTH, trimmed: true });
  if (!image || image === 'missing') return null;
  return { bytes: new Uint8Array(image.bytes), mediaType: 'image/jpeg', alt: title, showsFirstPage: true };
}
