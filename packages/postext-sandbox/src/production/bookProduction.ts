/**
 * The production of a book in the Sandbox: its versions (a paperback, a
 * hardcover…), each with its binding and ISBN, over the one text block the
 * book lays out, and the texts of its cover, shared by every version. Pure
 * functions: the Cover panel stores the record (./productionStore.ts) and
 * draws what these work out.
 */

import {
  coverMarkdown,
  coverPage,
  resolveFolioConfig,
  resolvePageConfig,
  versionSheets,
  type BindingProfile,
  type CoverPage,
  type ColorValue,
  type CoverDesign,
  type CoverZoneName,
  type Dimension,
  type PageRun,
  type PostextConfig,
  type ProductionSheet,
  type ProductionVersion,
  type Resource,
  type TrimMm,
  type VersionSheets,
} from 'postext';

/** The zones whose text the panel edits. */
export const COVER_TEXT_ZONES = ['front', 'spine', 'back', 'flapFront', 'flapBack'] as const;
export type CoverTextZone = (typeof COVER_TEXT_ZONES)[number];

/** The zones a design grounds in the panel: the flaps share one. */
export const DESIGN_ZONES = ['front', 'spine', 'back', 'flaps'] as const;
export type DesignZone = (typeof DESIGN_ZONES)[number];

/** The cover's look, shared by every version, colours as `#rrggbb`. */
export interface CoverDesignSettings {
  background?: string;
  image?: { resourceId: string; area?: 'sheet' | 'front' };
  zones?: Partial<Record<DesignZone, string>>;
  textColor?: string;
}

/** A book's production, kept per project. */
export interface BookProduction {
  projectId: string;
  versions: ProductionVersion[];
  activeVersionId?: string;
  /** The cover's text by zone, Markdown; the same for every version. */
  texts: Partial<Record<CoverTextZone, string>>;
  design?: CoverDesignSettings;
  updatedAt: number;
}

/** Key of the book being edited when it is not a stored project yet. */
export const WORKING_BOOK = '__working__';

export function emptyProduction(projectId: string): BookProduction {
  return { projectId, versions: [], texts: {}, updatedAt: Date.now() };
}

export function generateVersionId(): string {
  return `ver-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** A new version on a built-in binding: a paperback (perfect bound) or a
 *  hardcover (flat spine). */
export function newVersion(kind: 'paperback' | 'hardcover', name: string): ProductionVersion {
  return kind === 'paperback'
    ? { id: generateVersionId(), name, binding: 'perfect' }
    : { id: generateVersionId(), name, binding: 'case-flat', caseMaterial: 'printed' };
}

const text = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');

/** The cover texts the book's own metadata gives (the first chapter's
 *  front matter): the title, subtitle and author on the front cover, the
 *  author and title on the spine. Empty without a title. */
export function metadataTexts(metadata: Record<string, unknown>): Partial<Record<CoverTextZone, string>> {
  const title = text(metadata.title);
  if (!title) return {};
  const subtitle = text(metadata.subtitle);
  const author = text(metadata.author);
  return {
    front: [`# ${title}`, subtitle, author].filter(Boolean).join('\n\n'),
    spine: [author, title].filter(Boolean).join(' · '),
  };
}

/** The ISBN the book's metadata names (`isbn:` in the front matter). */
export function metadataIsbn(metadata: Record<string, unknown>): string | undefined {
  return text(metadata.isbn) || undefined;
}

/** A length in millimetres; px at `dpi`. Relative units have no physical
 *  size and read as 0. */
export function dimensionMm(d: Dimension, dpi: number): number {
  switch (d.unit) {
    case 'mm': return d.value;
    case 'cm': return d.value * 10;
    case 'in': return d.value * 25.4;
    case 'pt': return (d.value * 25.4) / 72;
    case 'px': return (d.value / dpi) * 25.4;
    default: return 0;
  }
}

/** The book's trim, mm. */
export function bookTrimMm(config: PostextConfig): TrimMm {
  const page = resolvePageConfig(config.page, config.locale);
  return { width: dimensionMm(page.width, page.dpi), height: dimensionMm(page.height, page.dpi) };
}

/** The book's pages on its own paper (`config.folio.paper`), as one run.
 *  Pages set on another stock with `:::paper` are not told apart here: the
 *  plan knows page counts, not papers. */
export function bookRuns(pages: number, config: PostextConfig): PageRun[] {
  const paper = resolveFolioConfig(config.folio, resolvePageConfig(config.page).sizePreset).paper;
  return pages > 0 ? [{ pages, grammage: paper.grammage, bulk: paper.bulk }] : [];
}

/** The book's page count from its plan: the end of the last chapter laid
 *  out. */
export function planPageCount(bookPages: Record<string, { pageIndex: number; pageCount: number }>): number {
  let end = 0;
  for (const c of Object.values(bookPages)) end = Math.max(end, c.pageIndex + c.pageCount);
  return end;
}

/** Which sheet of a version is shown or exported. */
export type SheetChoice = 'cover' | 'jacket' | 'endpaperFront' | 'endpaperBack';

/** The sheets a version has, in the order the panel offers them. */
export function sheetChoices(sheets: VersionSheets): SheetChoice[] {
  return [
    'cover',
    ...(sheets.jacket ? ['jacket' as const] : []),
    ...(sheets.endpapers ? ['endpaperFront' as const, 'endpaperBack' as const] : []),
  ];
}

export function pickSheet(sheets: VersionSheets, choice: SheetChoice): ProductionSheet {
  switch (choice) {
    case 'jacket': return sheets.jacket ?? sheets.cover;
    case 'endpaperFront': return sheets.endpapers?.front ?? sheets.cover;
    case 'endpaperBack': return sheets.endpapers?.back ?? sheets.cover;
    default: return sheets.cover;
  }
}

/** The sheets of a version of this book, or the warnings that stop them. */
export function sheetsOf(
  version: ProductionVersion,
  config: PostextConfig,
  pages: number,
  library: readonly BindingProfile[],
): ReturnType<typeof versionSheets> {
  const rtl = resolvePageConfig(config.page, config.locale).binding === 'right';
  return versionSheets(version, bookTrimMm(config), bookRuns(pages, config), { library, rtl });
}

/** What to lay out for a sheet: the book's design with the sheet's page
 *  and template, and the cover's Markdown. Endpapers take no text yet. */
const ink = (hex: string): ColorValue => ({ hex, model: 'hex' });

/** The core's design for a sheet from the panel's settings. */
export function coverDesignOf(settings: CoverDesignSettings | undefined): CoverDesign | undefined {
  if (!settings) return undefined;
  const zones: CoverDesign['zones'] = {};
  const z = settings.zones ?? {};
  if (z.front) zones.front = ink(z.front);
  if (z.spine) zones.spine = ink(z.spine);
  if (z.back) zones.back = ink(z.back);
  if (z.flaps) {
    zones.flapFront = ink(z.flaps);
    zones.flapBack = ink(z.flaps);
  }
  const design: CoverDesign = {
    ...(settings.background ? { background: ink(settings.background) } : {}),
    ...(settings.image?.resourceId ? { image: { resourceId: settings.image.resourceId, area: settings.image.area ?? 'sheet' } } : {}),
    ...(Object.keys(zones).length > 0 ? { zones } : {}),
  };
  return Object.keys(design).length > 0 ? design : undefined;
}

export function coverDocumentInput(
  sheet: ProductionSheet,
  version: ProductionVersion,
  texts: BookProduction['texts'],
  config: PostextConfig,
  settings?: CoverDesignSettings,
  bookResources: readonly Resource[] = [],
): { cover: CoverPage; config: PostextConfig; markdown: string; resources: Resource[] } {
  const isCover = sheet.kind !== 'endpaper';
  const design = isCover ? coverDesignOf(settings) : undefined;
  const cover = coverPage(sheet, {
    templateId: 'production-sheet',
    ...(isCover && version.isbn ? { isbn: version.isbn } : {}),
    ...(version.isbnAddOn ? { isbnAddOn: version.isbnAddOn } : {}),
    ...(version.spineText ? { spineText: version.spineText } : {}),
    ...(design ? { design } : {}),
  });
  const picture = design?.image ? bookResources.find((r) => r.id === design.image!.resourceId) : undefined;
  const textColor = isCover && settings?.textColor ? ink(settings.textColor) : undefined;
  const content: Partial<Record<CoverZoneName, string>> = isCover ? texts : {};
  // The cover's headings take the book's type, not its chapter openers:
  // no designs, numbers or page breaks, and no heading styles.
  const rest: PostextConfig = { ...config };
  delete rest.headingStyles;
  const headings = config.headings?.levels
    ? {
        ...config.headings,
        levels: config.headings.levels.map((l) => ({
          ...l,
          ...(textColor ? { color: textColor } : {}),
          numberingTemplate: '',
          breakBefore: { enabled: false },
          ...(l.advancedDesign ? { advancedDesign: { ...l.advancedDesign, enabled: false } } : {}),
        })),
      }
    : config.headings;
  return {
    cover,
    resources: [...cover.resources, ...(picture ? [picture] : [])],
    config: {
      ...rest,
      ...(headings ? { headings: textColor ? { ...headings, color: textColor } : headings } : textColor ? { headings: { color: textColor } } : {}),
      ...(textColor ? { bodyText: { ...config.bodyText, color: textColor } } : {}),
      page: { ...config.page, ...cover.page, ...(config.page?.dpi ? { dpi: config.page.dpi } : {}) },
      header: { elements: [] },
      footer: { elements: [] },
      pageTemplates: [cover.template],
    },
    markdown: coverMarkdown(cover.template.id, content, cover.slots),
  };
}

/** A file name for a sheet: the book's title, the version and the sheet. */
export function sheetFileName(title: string, version: string, sheet: SheetChoice): string {
  const base = `${title}-${version}-${sheet}`.trim().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '');
  return `${base || 'cover'}.pdf`;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A stored production record as it reads, or null: versions without an id
 *  or a binding are left out, texts that are not strings dropped. */
export function readBookProduction(raw: unknown): BookProduction | null {
  if (!isRecord(raw) || typeof raw.projectId !== 'string') return null;
  const versions = (Array.isArray(raw.versions) ? raw.versions : []).filter(
    (v): v is ProductionVersion => isRecord(v) && typeof v.id === 'string' && typeof v.name === 'string'
      && (typeof v.binding === 'string' || isRecord(v.binding)),
  );
  const texts: BookProduction['texts'] = {};
  if (isRecord(raw.texts)) {
    for (const zone of COVER_TEXT_ZONES) {
      const t = raw.texts[zone];
      if (typeof t === 'string') texts[zone] = t;
    }
  }
  const design = readDesign(raw.design);
  const active = typeof raw.activeVersionId === 'string' && versions.some((v) => v.id === raw.activeVersionId)
    ? raw.activeVersionId
    : undefined;
  return {
    projectId: raw.projectId,
    versions,
    ...(active ? { activeVersionId: active } : {}),
    texts,
    ...(design ? { design } : {}),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
  };
}

const HEX = /^#[0-9a-f]{6}$/i;

function readDesign(raw: unknown): CoverDesignSettings | undefined {
  if (!isRecord(raw)) return undefined;
  const out: CoverDesignSettings = {};
  if (typeof raw.background === 'string' && HEX.test(raw.background)) out.background = raw.background;
  if (typeof raw.textColor === 'string' && HEX.test(raw.textColor)) out.textColor = raw.textColor;
  if (isRecord(raw.image) && typeof raw.image.resourceId === 'string') {
    out.image = { resourceId: raw.image.resourceId, ...(raw.image.area === 'front' ? { area: 'front' as const } : {}) };
  }
  if (isRecord(raw.zones)) {
    const zones: NonNullable<CoverDesignSettings['zones']> = {};
    for (const z of DESIGN_ZONES) {
      const c = raw.zones[z];
      if (typeof c === 'string' && HEX.test(c)) zones[z] = c;
    }
    if (Object.keys(zones).length > 0) out.zones = zones;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
