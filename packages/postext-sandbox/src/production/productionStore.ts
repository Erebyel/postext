// The Cover panel's storage, in its own IndexedDB database: each book's
// production (versions and cover texts) keyed by project id, the user's
// library of paper and binding profiles, which travel between users as
// `.postext-production.json` files (see `exportProductionProfiles`), and
// the user's logo library (./logoLibrary.ts).

import type { BindingProfile, PaperProfile } from 'postext';
import { readBookProduction, type BookProduction } from './bookProduction.js';
import type { LogoRecord } from './logoLibrary.js';

const DB_NAME = 'postext-production';
const DB_VERSION = 2;
const BOOKS = 'books';
const PROFILES = 'profiles';
const LOGOS = 'logos';

/** A profile of the library as stored. */
export type StoredProfile =
  | { id: string; kind: 'paper'; profile: PaperProfile; updatedAt: number }
  | { id: string; kind: 'binding'; profile: BindingProfile; updatedAt: number };

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB unavailable'));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(BOOKS)) db.createObjectStore(BOOKS, { keyPath: 'projectId' });
      if (!db.objectStoreNames.contains(PROFILES)) db.createObjectStore(PROFILES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(LOGOS)) db.createObjectStore(LOGOS, { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error('Failed to open the production store'));
    };
  });
  return dbPromise;
}

function run<T>(store: string, mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = op(tx.objectStore(store));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error ?? req.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  }));
}

const listeners = new Set<() => void>();
function changed(): void {
  for (const l of listeners) l();
}
/** Called after any write, to books or profiles. */
export function onProductionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function getBookProduction(projectId: string): Promise<BookProduction | null> {
  const raw = await run<unknown>(BOOKS, 'readonly', (s) => s.get(projectId));
  return readBookProduction(raw);
}

export async function putBookProduction(record: BookProduction): Promise<void> {
  await run(BOOKS, 'readwrite', (s) => s.put({ ...record, updatedAt: Date.now() }));
  changed();
}

/** The library, newest first. */
export async function listProfiles(): Promise<StoredProfile[]> {
  const all = await run<StoredProfile[]>(PROFILES, 'readonly', (s) => s.getAll() as IDBRequest<StoredProfile[]>);
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Store profiles; an imported one whose id the library has replaces it. */
export async function putProfiles(papers: readonly PaperProfile[], bindings: readonly BindingProfile[]): Promise<void> {
  const now = Date.now();
  const records: StoredProfile[] = [
    ...papers.map((profile) => ({ id: `paper:${profile.id}`, kind: 'paper' as const, profile, updatedAt: now })),
    ...bindings.map((profile) => ({ id: `binding:${profile.id}`, kind: 'binding' as const, profile, updatedAt: now })),
  ];
  if (records.length === 0) return;
  await run(PROFILES, 'readwrite', (s) => {
    let last: IDBRequest<IDBValidKey> | undefined;
    for (const r of records) last = s.put(r);
    return last!;
  });
  changed();
}

export async function deleteProfile(id: string): Promise<void> {
  await run(PROFILES, 'readwrite', (s) => s.delete(id));
  changed();
}

/** The logo library, by name. */
export async function listLogos(): Promise<LogoRecord[]> {
  const all = await run<LogoRecord[]>(LOGOS, 'readonly', (st) => st.getAll() as IDBRequest<LogoRecord[]>);
  return all.sort((a, b) => a.name.localeCompare(b.name));
}

/** Store logos; one whose id the library has replaces it. */
export async function putLogos(logos: readonly LogoRecord[]): Promise<void> {
  if (logos.length === 0) return;
  await run(LOGOS, 'readwrite', (st) => {
    let last: IDBRequest<IDBValidKey> | undefined;
    for (const l of logos) last = st.put(l);
    return last!;
  });
  changed();
}

export async function deleteLogo(id: string): Promise<void> {
  await run(LOGOS, 'readwrite', (st) => st.delete(id));
  changed();
}
