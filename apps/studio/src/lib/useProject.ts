/**
 * The bridge between the editor's in-memory document and the vault.
 *
 * One rule shapes everything here: a project record is only ever *created* by a
 * deliberate act (Save / Save as / Import). Autosave keeps an existing record
 * up to date and nothing more, so a user who never saves never silently
 * accumulates half-finished designs in their browser storage.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadDocument, type Document } from '@artboard/schema';
import { renderArtboard, serialize } from '@artboard/render-svg';
import { useEditor } from '../state/store';
import { getProject, saveProject, vaultId, type ProjectMeta } from './vault';

/** Where the id of the project being edited is parked so a reload can find it. */
export const LAST_PROJECT_KEY = 'artboard:lastProject';

/** Debounce for autosave. Long enough to not fight a burst of drag edits. */
const AUTOSAVE_MS = 1500;

const reason = (e: unknown): string =>
  e instanceof Error ? (e.name && e.name !== 'Error' ? `${e.name}: ${e.message}` : e.message) : String(e);

/* ── storage of the "currently open" pointer (storage may be unavailable) ── */

export function lastProjectId(): string | null {
  try { return localStorage.getItem(LAST_PROJECT_KEY); } catch { return null; }
}
function rememberProject(id: string): void {
  try { localStorage.setItem(LAST_PROJECT_KEY, id); } catch { /* private mode; the pointer is a convenience */ }
}
export function forgetProject(): void {
  try { localStorage.removeItem(LAST_PROJECT_KEY); } catch { /* nothing to do */ }
}

/**
 * A project's thumbnail is our own serializer's output for artboard 1 - exact,
 * tiny, and free of a rasterizing round trip. A document that will not render
 * still has to be savable, so every failure here degrades to "no preview".
 */
export function thumbnailFor(doc: Document): string {
  try {
    const first = doc.artboards[0];
    if (!first) return '';
    return serialize(renderArtboard(doc, first).scene, 0);
  } catch {
    return '';
  }
}

export interface CurrentProject {
  meta: ProjectMeta | null;
  dirty: boolean;
  saving: boolean;
  lastSavedAt: number | null;
  save(): Promise<void>;
  saveAs(name: string, folderId: string | null): Promise<void>;
  open(id: string): Promise<void>;
  newProject(doc?: unknown): void;
}

export function useCurrentProject(): CurrentProject {
  const { state, dispatch } = useEditor();

  const [meta, setMeta] = useState<ProjectMeta | null>(null);
  const [saving, setSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  /**
   * The exact document object that last hit storage. The store is immutable, so
   * reference inequality *is* "changed since last save" - no hashing, no diffing.
   * `null` means nothing has been saved yet, which counts as dirty.
   */
  const [savedDoc, setSavedDoc] = useState<Document | null>(null);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  // Refs so a save that fires from a timer reads today's doc, not the one that
  // was current when the timer was armed.
  const docRef = useRef(state.doc);
  docRef.current = state.doc;
  const metaRef = useRef<ProjectMeta | null>(meta);
  metaRef.current = meta;
  const savingRef = useRef(false);

  const toast = useCallback(
    (level: 'info' | 'warn' | 'error', message: string) => dispatch({ type: 'toast', toast: { level, message } }),
    [dispatch],
  );

  const dirty = savedDoc !== state.doc;

  /** The single write path. Never rejects: every failure becomes a toast. */
  const write = useCallback(
    async (target: { id: string; name: string; folderId: string | null; createdAt?: number }): Promise<void> => {
      const doc = docRef.current;
      const first = doc.artboards[0];
      const name = target.name.trim() || doc.name.trim() || 'Untitled';

      savingRef.current = true;
      setSaving(true);
      try {
        const saved = await saveProject({
          id: target.id,
          name,
          folderId: target.folderId,
          width: first?.width ?? 0,
          height: first?.height ?? 0,
          thumbnail: thumbnailFor(doc),
          doc,
          ...(target.createdAt === undefined ? {} : { createdAt: target.createdAt }),
        });
        if (!alive.current) return;
        metaRef.current = saved;
        setMeta(saved);
        setSavedDoc(doc);
        setLastSavedAt(saved.updatedAt);
        rememberProject(saved.id);
      } catch (e) {
        if (alive.current) toast('error', `Could not save "${name}". ${reason(e)}`);
      } finally {
        savingRef.current = false;
        if (alive.current) setSaving(false);
      }
    },
    [toast],
  );

  const save = useCallback(async (): Promise<void> => {
    const m = metaRef.current;
    if (m) return write({ id: m.id, name: m.name, folderId: m.folderId, createdAt: m.createdAt });
    return write({ id: vaultId('prj'), name: docRef.current.name, folderId: null });
  }, [write]);

  const saveAs = useCallback(
    async (name: string, folderId: string | null): Promise<void> => write({ id: vaultId('prj'), name, folderId }),
    [write],
  );

  const open = useCallback(
    async (id: string): Promise<void> => {
      try {
        const rec = await getProject(id);
        if (!alive.current) return;
        if (!rec) {
          if (lastProjectId() === id) forgetProject();
          toast('error', 'That design is no longer in this browser’s storage.');
          return;
        }
        const { doc: raw, ...loadedMeta } = rec;
        const { doc, readOnly, diagnostics } = loadDocument(raw);
        dispatch({ type: 'setDoc', doc, readOnly });
        metaRef.current = loadedMeta;
        setMeta(loadedMeta);
        setSavedDoc(doc);
        setLastSavedAt(rec.updatedAt);
        rememberProject(rec.id);

        const bad = diagnostics.filter(d => d.level === 'error');
        if (bad.length > 0) {
          toast('warn', `Opened "${rec.name}" with ${bad.length} problem${bad.length === 1 ? '' : 's'}: ${bad[0]?.message ?? ''}`);
        } else if (readOnly) {
          toast('warn', `Opened "${rec.name}" read-only - it was made in a newer version.`);
        } else {
          toast('info', `Opened "${rec.name}".`);
        }
      } catch (e) {
        if (alive.current) toast('error', `Could not open that design. ${reason(e)}`);
      }
    },
    [dispatch, toast],
  );

  const newProject = useCallback(
    (doc?: unknown): void => {
      let next: Document | null = null;
      if (doc !== undefined) {
        try {
          next = loadDocument(doc).doc;
        } catch (e) {
          toast('error', `Could not start that document. ${reason(e)}`);
          return;
        }
      }
      metaRef.current = null;
      setMeta(null);
      setLastSavedAt(null);
      setSavedDoc(null);            // detached work is unsaved work
      forgetProject();
      if (next) dispatch({ type: 'setDoc', doc: next });
    },
    [dispatch, toast],
  );

  /**
   * Autosave. Only ever updates a record that already exists, never while the
   * document is read-only, and never on top of a save already in flight.
   */
  useEffect(() => {
    if (!meta || state.readOnly || !dirty || saving || savingRef.current) return;
    const t = setTimeout(() => { void save(); }, AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [meta, dirty, saving, state.doc, state.readOnly, save]);

  return useMemo(
    () => ({ meta, dirty, saving, lastSavedAt, save, saveAs, open, newProject }),
    [meta, dirty, saving, lastSavedAt, save, saveAs, open, newProject],
  );
}
