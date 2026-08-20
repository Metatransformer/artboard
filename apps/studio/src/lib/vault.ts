/**
 * The vault: local, offline persistence for projects, folders and the brand kit.
 *
 * One interface, three backends chosen at runtime - IndexedDB where it works,
 * localStorage where IndexedDB is blocked (sandboxed iframes), memory as the
 * last resort so the editor never *fails* for want of storage; it just forgets.
 * The Electron shell will register a filesystem backend against this same
 * interface, which is why nothing here assumes a browser beyond the adapters.
 */

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectMeta {
  id: string;
  name: string;
  folderId: string | null;
  width: number;
  height: number;
  /** Inline SVG string, rendered at save time. Cheap, exact, no rasterizing. */
  thumbnail: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectRecord extends ProjectMeta {
  doc: unknown;
}

export interface Palette {
  id: string;
  name: string;
  colors: string[];
  /** Built-in palettes ship with the app and cannot be deleted, only copied. */
  builtIn?: boolean;
}

export interface BrandAsset {
  id: string;
  name: string;
  mime: string;
  width: number;
  height: number;
  /** data: URI. Same rule as document assets - never a filesystem path. */
  data: string;
}

export interface BrandKit {
  palettes: Palette[];
  fonts: string[];
  logos: BrandAsset[];
}

export interface VaultBackend {
  get<T>(store: StoreName, id: string): Promise<T | null>;
  all<T>(store: StoreName): Promise<T[]>;
  put(store: StoreName, id: string, value: unknown): Promise<void>;
  del(store: StoreName, id: string): Promise<void>;
  /** Which backend actually took the write - surfaced in the UI, never guessed. */
  readonly kind: 'indexeddb' | 'localstorage' | 'memory';
}

export type StoreName = 'folders' | 'projects' | 'brand';
const STORES: StoreName[] = ['folders', 'projects', 'brand'];
const DB = 'artboard-vault';
const DB_VERSION = 1;

/* ── backends ───────────────────────────────────────────────────────────── */

function memoryBackend(): VaultBackend {
  const m = new Map<string, Map<string, unknown>>(STORES.map(s => [s, new Map()]));
  return {
    kind: 'memory',
    async get(s, id) { return (m.get(s)!.get(id) ?? null) as any; },
    async all(s) { return [...m.get(s)!.values()] as any; },
    async put(s, id, v) { m.get(s)!.set(id, v); },
    async del(s, id) { m.get(s)!.delete(id); },
  };
}

function localBackend(): VaultBackend {
  const key = (s: StoreName, id: string) => `${DB}:${s}:${id}`;
  return {
    kind: 'localstorage',
    async get(s, id) { const raw = localStorage.getItem(key(s, id)); return raw ? JSON.parse(raw) : null; },
    async all(s) {
      const out: unknown[] = [];
      const prefix = `${DB}:${s}:`;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith(prefix)) { const v = localStorage.getItem(k); if (v) out.push(JSON.parse(v)); }
      }
      return out as any;
    },
    async put(s, id, v) { localStorage.setItem(key(s, id), JSON.stringify(v)); },
    async del(s, id) { localStorage.removeItem(key(s, id)); },
  };
}

function idbBackend(db: IDBDatabase): VaultBackend {
  const tx = <T>(store: StoreName, mode: IDBTransactionMode, fn: (o: IDBObjectStore) => IDBRequest): Promise<T> =>
    new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      req.onsuccess = () => res(req.result as T);
      req.onerror = () => rej(req.error ?? new Error('Vault write failed'));
    });
  return {
    kind: 'indexeddb',
    get: (s, id) => tx(s, 'readonly', o => o.get(id)).then(v => (v ?? null) as any),
    all: s => tx(s, 'readonly', o => o.getAll()) as any,
    put: (s, id, v) => tx(s, 'readwrite', o => o.put({ ...(v as object), id })).then(() => undefined),
    del: (s, id) => tx(s, 'readwrite', o => o.delete(id)).then(() => undefined),
  };
}

let backendPromise: Promise<VaultBackend> | null = null;

export function backend(): Promise<VaultBackend> {
  backendPromise ??= (async () => {
    try {
      if (typeof indexedDB === 'undefined') throw new Error('no indexedDB');
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open(DB, DB_VERSION);
        r.onupgradeneeded = () => {
          for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, { keyPath: 'id' });
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error ?? new Error('indexedDB unavailable'));
        r.onblocked = () => rej(new Error('indexedDB blocked'));
      });
      return idbBackend(db);
    } catch {
      try { localStorage.setItem(`${DB}:probe`, '1'); localStorage.removeItem(`${DB}:probe`); return localBackend(); }
      catch { return memoryBackend(); }
    }
  })();
  return backendPromise;
}

/* ── ids ────────────────────────────────────────────────────────────────── */

let seq = 0;
export const vaultId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/* ── folders ────────────────────────────────────────────────────────────── */

export const listFolders = async (): Promise<Folder[]> =>
  (await (await backend()).all<Folder>('folders')).sort((a, b) => a.name.localeCompare(b.name));

export async function createFolder(name: string, parentId: string | null = null): Promise<Folder> {
  const now = Date.now();
  const f: Folder = { id: vaultId('fld'), name: name.trim() || 'Untitled folder', parentId, createdAt: now, updatedAt: now };
  await (await backend()).put('folders', f.id, f);
  return f;
}

export async function renameFolder(id: string, name: string): Promise<void> {
  const b = await backend();
  const f = await b.get<Folder>('folders', id);
  if (!f) return;
  await b.put('folders', id, { ...f, name: name.trim() || f.name, updatedAt: Date.now() });
}

/** Deleting a folder never deletes work: children and projects move up a level. */
export async function deleteFolder(id: string): Promise<void> {
  const b = await backend();
  const f = await b.get<Folder>('folders', id);
  if (!f) return;
  for (const child of await b.all<Folder>('folders')) {
    if (child.parentId === id) await b.put('folders', child.id, { ...child, parentId: f.parentId });
  }
  for (const p of await b.all<ProjectRecord>('projects')) {
    if (p.folderId === id) await b.put('projects', p.id, { ...p, folderId: f.parentId });
  }
  await b.del('folders', id);
}

/* ── projects ───────────────────────────────────────────────────────────── */

const strip = ({ doc, ...meta }: ProjectRecord): ProjectMeta => meta;

export async function listProjects(folderId?: string | null): Promise<ProjectMeta[]> {
  const all = await (await backend()).all<ProjectRecord>('projects');
  return all
    .filter(p => folderId === undefined || p.folderId === folderId)
    .map(strip)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export const getProject = async (id: string): Promise<ProjectRecord | null> =>
  (await backend()).get<ProjectRecord>('projects', id);

export async function saveProject(rec: Omit<ProjectRecord, 'createdAt' | 'updatedAt'> & Partial<Pick<ProjectRecord, 'createdAt'>>): Promise<ProjectMeta> {
  const b = await backend();
  const prev = await b.get<ProjectRecord>('projects', rec.id);
  const now = Date.now();
  const next: ProjectRecord = { ...rec, createdAt: prev?.createdAt ?? rec.createdAt ?? now, updatedAt: now };
  await b.put('projects', next.id, next);
  return strip(next);
}

export async function patchProject(id: string, patch: Partial<ProjectMeta>): Promise<void> {
  const b = await backend();
  const p = await b.get<ProjectRecord>('projects', id);
  if (!p) return;
  await b.put('projects', id, { ...p, ...patch, id, updatedAt: Date.now() });
}

export const deleteProject = async (id: string): Promise<void> => (await backend()).del('projects', id);

export async function duplicateProject(id: string): Promise<ProjectMeta | null> {
  const p = await getProject(id);
  if (!p) return null;
  return saveProject({ ...p, id: vaultId('prj'), name: `${p.name} copy` });
}

/* ── brand kit ──────────────────────────────────────────────────────────── */

export const BUILTIN_PALETTES: Palette[] = [
  { id: 'bi_studio', name: 'Studio', builtIn: true, colors: ['#0f1117', '#6366f1', '#ec4899', '#f8fafc', '#f59e0b'] },
  { id: 'bi_editorial', name: 'Editorial', builtIn: true, colors: ['#1c1917', '#78716c', '#d6d3d1', '#fafaf9', '#b91c1c'] },
  { id: 'bi_botanical', name: 'Botanical', builtIn: true, colors: ['#14342b', '#3f7d5e', '#a3c9a8', '#f4f1de', '#e07a5f'] },
  { id: 'bi_sunset', name: 'Sunset', builtIn: true, colors: ['#2b1055', '#7597de', '#ff6e7f', '#ffd6a5', '#fffbf0'] },
  { id: 'bi_mono', name: 'Mono', builtIn: true, colors: ['#000000', '#3f3f46', '#a1a1aa', '#e4e4e7', '#ffffff'] },
];

const BRAND_KEY = 'kit';

export async function getBrand(): Promise<BrandKit> {
  const stored = await (await backend()).get<BrandKit & { id: string }>('brand', BRAND_KEY);
  return {
    palettes: stored?.palettes ?? [],
    fonts: stored?.fonts ?? [],
    logos: stored?.logos ?? [],
  };
}

export async function saveBrand(kit: BrandKit): Promise<void> {
  await (await backend()).put('brand', BRAND_KEY, { ...kit, id: BRAND_KEY });
}
