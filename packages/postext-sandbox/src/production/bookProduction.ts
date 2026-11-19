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
  promoSheet,
  PROMO_FORMATS,
  resolveFolioConfig,
  resolveHeadingsConfig,
  resolvePageConfig,
  versionSheets,
  type BindingProfile,
  type CoverPage,
  type ColorValue,
  type CoverDesign,
  type CoverZoneName,
  type MirrorPicture,
  type Dimension,
  type PageRun,
  type PromoFormat,
  type ParagraphStyleConfig,
  type PostextConfig,
  type ProductionSheet,
  type ProductionVersion,
  type Resource,
  type TrimMm,
  type VersionSheets,
} from 'postext';
import {
  designShowing,
  readCoverElements,
  readCoverFinishes,
  readCoverLogos,
  type CoverElementSetting,
  type CoverFinishSetting,
  type CoverLayer,
  type CoverLogoSetting,
} from './coverLayers.js';
import { logoFileId, logoResource, logoResourceId, type LogoRecord } from './logoLibrary.js';
import { galleryFileId, galleryResource, galleryResourceId, type CoverGallery } from './coverGallery.js';

/** The zones whose text the panel edits. */
export const COVER_TEXT_ZONES = ['front', 'spine', 'back', 'flapFront', 'flapBack'] as const;
export type CoverTextZone = (typeof COVER_TEXT_ZONES)[number];

/** The zones a design grounds in the panel: the flaps share one. */
export const DESIGN_ZONES = ['front', 'spine', 'back', 'flaps'] as const;
export type DesignZone = (typeof DESIGN_ZONES)[number];

/** The cover's look, shared by every version, colours as `#rrggbb`. */
export interface CoverDesignSettings {
  zoneStyles?: Partial<Record<DesignZone, ZoneStyle>>;
  background?: string;
  image?: { resourceId: string; area?: 'sheet' | 'front' };
  zones?: Partial<Record<DesignZone, string>>;
  textColor?: string;
  /** The movable elements, back to front (./coverLayers.ts). */
  elements?: CoverElementSetting[];
  /** Over the text, back to front: translucent boxes and pictures. */
  effects?: CoverElementSetting[];
  logos?: CoverLogoSetting[];
  finishes?: CoverFinishSetting[];
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
export type SheetChoice = 'cover' | 'jacket' | 'endpaperFront' | 'endpaperBack' | PromoFormat;

/** The screen pictures every version offers after its print sheets. */
export const PROMO_CHOICES = Object.keys(PROMO_FORMATS) as PromoFormat[];

export const isPromo = (choice: SheetChoice): choice is PromoFormat => choice in PROMO_FORMATS;

/** The sheets a version has, in the order the panel offers them. */
export function sheetChoices(sheets: VersionSheets): SheetChoice[] {
  return [
    'cover',
    ...(sheets.jacket ? ['jacket' as const] : []),
    ...(sheets.endpapers ? ['endpaperFront' as const, 'endpaperBack' as const] : []),
    ...PROMO_CHOICES,
  ];
}

/** The sheet of a choice; a screen picture is recomposed from the front
 *  cover at `trim` (the book's trim). */
export function pickSheet(sheets: VersionSheets, choice: SheetChoice, trim?: TrimMm): ProductionSheet {
  if (isPromo(choice)) {
    const front = sheets.cover.zones.find((z) => z.name === 'front')!.rect;
    return promoSheet(trim ?? { width: front.width, height: front.height }, choice, sheets.measures.safeMargin);
  }
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
  const toCore = ({ color, ...e }: CoverElementSetting): NonNullable<CoverDesign['elements']>[number] => ({ ...e, ...(color ? { color: ink(color) } : {}) });
  const elements = (settings.elements ?? []).map(toCore);
  const effects = (settings.effects ?? []).map(toCore);
  const logos = (settings.logos ?? []).map(({ logoId, color: _c, ...l }): NonNullable<CoverDesign['logos']>[number] => ({
    ...l,
    kind: 'image',
    ...(logoId ? { resourceId: logoResourceId(logoId) } : {}),
  }));
  const finishes = settings.finishes ?? [];
  const design: CoverDesign = {
    ...(elements.length > 0 ? { elements } : {}),
    ...(effects.length > 0 ? { effects } : {}),
    ...(logos.length > 0 ? { logos } : {}),
    ...(finishes.length > 0 ? { finishes } : {}),
    ...(settings.background ? { background: ink(settings.background) } : {}),
    ...(settings.image?.resourceId ? { image: { resourceId: settings.image.resourceId, area: settings.image.area ?? 'sheet' } } : {}),
    ...(Object.keys(zones).length > 0 ? { zones } : {}),
  };
  return Object.keys(design).length > 0 ? design : undefined;
}

/** How a role of a zone's text is set; what is left out follows the book
 *  (its level-1 heading for a title, its body for text). */
export interface RoleStyle {
  fontFamily?: string;
  /** Points. */
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  align?: 'left' | 'center' | 'right' | 'justify';
}

/** A zone's type: its title (the lines that start with `#`), its text,
 *  and where they sit in the zone. */
export interface ZoneStyle {
  title?: RoleStyle;
  text?: RoleStyle;
  vertical?: 'top' | 'middle' | 'bottom';
}

export type TextRole = 'title' | 'text';

const designZoneOf = (zone: CoverTextZone): DesignZone => (zone === 'flapFront' || zone === 'flapBack' ? 'flaps' : zone);

/** Id of the paragraph style of a zone's role on the cover. */
export const coverStyleId = (zone: DesignZone, role: TextRole): string => `cover-${zone}-${role}`;

/** A zone's Markdown with each run of blocks in the paragraph style of its
 *  role: a block that starts with `#` is a title (the hashes go), any
 *  other is text. */
export function styledZoneText(text: string, zone: CoverTextZone): string {
  const blocks = text.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const runs: { role: TextRole; blocks: string[] }[] = [];
  for (const block of blocks) {
    const title = /^#{1,6}\s/.test(block);
    const role: TextRole = title ? 'title' : 'text';
    const body = title ? block.replace(/^#{1,6}\s+/, '') : block;
    const last = runs[runs.length - 1];
    if (last && last.role === role) last.blocks.push(body);
    else runs.push({ role, blocks: [body] });
  }
  return runs
    .map((r) => [`:::paragraphs{style="${coverStyleId(designZoneOf(zone), r.role)}"}`, ...r.blocks, ':::'].join('\n\n'))
    .join('\n\n');
}

const pt = (value: number): Dimension => ({ value, unit: 'pt' });

/** The cover's paragraph styles: per zone, a title set as the book's
 *  level-1 heading and text set as its body, each with the zone's own
 *  changes, in the design's text colour when it has one. */
export function coverParagraphStyles(config: PostextConfig, settings: CoverDesignSettings | undefined): ParagraphStyleConfig[] {
  const headings = resolveHeadingsConfig(config.headings);
  const h1 = headings.levels.find((l) => l.level === 1);
  const color = settings?.textColor ? ink(settings.textColor) : undefined;
  const out: ParagraphStyleConfig[] = [];
  for (const zone of DESIGN_ZONES) {
    for (const role of ['title', 'text'] as const) {
      const own = settings?.zoneStyles?.[zone]?.[role] ?? {};
      const base: ParagraphStyleConfig = role === 'title' && h1
        ? {
            id: coverStyleId(zone, role),
            fontFamily: h1.fontFamily,
            fontSize: h1.fontSize,
            lineHeight: h1.lineHeight,
            fontWeight: h1.fontWeight,
            ...(h1.italic ? { italic: true } : {}),
            color: color ?? h1.color,
          }
        : { id: coverStyleId(zone, role), ...(color ? { color } : {}) };
      out.push({
        ...base,
        ...(own.fontFamily ? { fontFamily: own.fontFamily } : {}),
        ...(own.fontSize ? { fontSize: pt(own.fontSize), lineHeight: pt(Math.round(own.fontSize * 1.2 * 10) / 10) } : {}),
        ...(own.bold !== undefined ? { fontWeight: own.bold ? 700 : 400 } : {}),
        ...(own.italic !== undefined ? { italic: own.italic } : {}),
        ...(own.align ? { textAlign: own.align } : {}),
      });
    }
  }
  return out;
}

export function coverDocumentInput(
  sheet: ProductionSheet,
  version: ProductionVersion,
  texts: BookProduction['texts'],
  config: PostextConfig,
  settings?: CoverDesignSettings,
  bookResources: readonly Resource[] = [],
  options: {
    barcodePdf?: boolean;
    hidden?: ReadonlySet<CoverLayer>;
    /** The logo library: the logos the design places from it come along,
     *  their bytes in the cover's files. */
    logos?: readonly LogoRecord[];
    /** Finishes as solid spot-colour plates (the PDF, InDesign) instead of
     *  their translucent screen colour. */
    press?: boolean;
    /** Mirror bleed past this design margin, mm (the version's
     *  `designMargin`), with the pictures it draws (`loadMirrorPictures`). */
    mirror?: { margin: number; pictures: Readonly<Record<string, MirrorPicture>> };
    /** The book's cover gallery: the pictures the design places from it
     *  come along, their bytes in the cover's files. */
    gallery?: CoverGallery;
  } = {},
): { cover: CoverPage; config: PostextConfig; markdown: string; resources: Resource[] } {
  const isCover = sheet.kind !== 'endpaper';
  const hidden = options.hidden ?? new Set<CoverLayer>();
  const design = isCover ? coverDesignOf(designShowing(settings, hidden)) : undefined;
  const styles = settings?.zoneStyles ?? {};
  const vertical = (zone: DesignZone) => styles[zone]?.vertical;
  const verticalAlign = Object.fromEntries(
    (['front', 'back', 'flapFront', 'flapBack'] as const)
      .map((z) => [z, vertical(designZoneOf(z))] as const)
      .filter(([, v]) => v !== undefined),
  );
  const cover = coverPage(sheet, {
    templateId: 'production-sheet',
    ...(isCover && version.isbn ? { isbn: version.isbn } : {}),
    ...(version.isbnAddOn ? { isbnAddOn: version.isbnAddOn } : {}),
    ...(version.spineText ? { spineText: version.spineText } : {}),
    ...(design ? { design } : {}),
    ...(Object.keys(verticalAlign).length > 0 ? { verticalAlign } : {}),
    ...(options.barcodePdf ? { barcodePdf: true } : {}),
    ...(options.press ? { finishes: 'press' as const } : {}),
    ...(options.mirror ? { mirrorMargin: options.mirror.margin, mirrorPictures: options.mirror.pictures } : {}),
    resources: [...bookResources, ...(options.logos ?? []).map(logoResource), ...(options.gallery?.pictures ?? []).map(galleryResource)],
  });
  // The library's logos the design places, as pictures of the cover's own.
  const placed = new Set((design?.logos ?? []).map((l) => l.resourceId));
  const libraryLogos = (options.logos ?? []).filter((l) => placed.has(logoResourceId(l.id)));
  const files = { ...cover.files };
  for (const l of libraryLogos) files[logoFileId(l)] = l.bytes;
  // And the gallery's pictures it places.
  const used = new Set([design?.image?.resourceId, ...[...(design?.elements ?? []), ...(design?.effects ?? []), ...(design?.logos ?? [])].map((e) => e.resourceId)]);
  const galleryPictures = (options.gallery?.pictures ?? []).filter((p) => used.has(galleryResourceId(p.id)));
  for (const p of galleryPictures) files[galleryFileId(p)] = p.bytes;
  const pictures = [
    design?.image?.resourceId,
    ...(design?.elements ?? []).map((e) => e.resourceId),
    ...(design?.effects ?? []).map((e) => e.resourceId),
    ...(design?.logos ?? []).map((e) => e.resourceId),
  ].flatMap((id) => bookResources.filter((r) => r.id === id));
  const textColor = isCover && settings?.textColor ? ink(settings.textColor) : undefined;
  const content: Partial<Record<CoverZoneName, string>> = {};
  if (isCover && !hidden.has('texts')) {
    for (const zone of COVER_TEXT_ZONES) {
      const t = texts[zone]?.trim();
      if (t) content[zone] = styledZoneText(t, zone);
    }
  }
  // The cover sets its own type: the book's heading styles (chapter
  // openers) have nothing to do on it.
  const rest: PostextConfig = { ...config };
  delete rest.headingStyles;
  return {
    cover: { ...cover, files },
    resources: [...cover.resources, ...libraryLogos.map(logoResource), ...galleryPictures.map(galleryResource), ...new Set(pictures)],
    config: {
      ...rest,
      paragraphStyles: [...(config.paragraphStyles ?? []), ...coverParagraphStyles(config, isCover ? settings : undefined)],
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
export function sheetFileName(title: string, version: string, sheet: SheetChoice, ext: string = isPromo(sheet) ? 'jpg' : 'pdf'): string {
  const base = `${title}-${version}-${sheet}`.trim().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '');
  return `${base || 'cover'}.${ext}`;
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
  if (isRecord(raw.zoneStyles)) {
    const styles: NonNullable<CoverDesignSettings['zoneStyles']> = {};
    for (const z of DESIGN_ZONES) {
      const st = readZoneStyle(raw.zoneStyles[z]);
      if (st) styles[z] = st;
    }
    if (Object.keys(styles).length > 0) out.zoneStyles = styles;
  }
  const elements = readCoverElements(raw.elements);
  if (elements.length > 0) out.elements = elements;
  const effects = readCoverElements(raw.effects);
  if (effects.length > 0) out.effects = effects;
  const logos = readCoverLogos(raw.logos);
  if (logos.length > 0) out.logos = logos;
  const finishes = readCoverFinishes(raw.finishes);
  if (finishes.length > 0) out.finishes = finishes;
  return Object.keys(out).length > 0 ? out : undefined;
}

const ALIGNS: ReadonlySet<string> = new Set(['left', 'center', 'right', 'justify']);
const VERTICALS: ReadonlySet<string> = new Set(['top', 'middle', 'bottom']);

function readRole(raw: unknown): RoleStyle | undefined {
  if (!isRecord(raw)) return undefined;
  const out: RoleStyle = {};
  if (typeof raw.fontFamily === 'string' && raw.fontFamily.trim()) out.fontFamily = raw.fontFamily;
  if (typeof raw.fontSize === 'number' && raw.fontSize > 0 && raw.fontSize < 400) out.fontSize = raw.fontSize;
  if (typeof raw.bold === 'boolean') out.bold = raw.bold;
  if (typeof raw.italic === 'boolean') out.italic = raw.italic;
  if (typeof raw.align === 'string' && ALIGNS.has(raw.align)) out.align = raw.align as RoleStyle['align'];
  return Object.keys(out).length > 0 ? out : undefined;
}

function readZoneStyle(raw: unknown): ZoneStyle | undefined {
  if (!isRecord(raw)) return undefined;
  const title = readRole(raw.title);
  const text = readRole(raw.text);
  const out: ZoneStyle = {
    ...(title ? { title } : {}),
    ...(text ? { text } : {}),
    ...(typeof raw.vertical === 'string' && VERTICALS.has(raw.vertical) ? { vertical: raw.vertical as ZoneStyle['vertical'] } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}
