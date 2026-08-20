/**
 * The editor's half of the desktop bridge.
 *
 * On the web this module does nothing at all: `window.artboard` is absent, the
 * hook returns immediately, and not a single line below runs. That is the
 * point — the desktop shell adds real files and a native menu to the exact
 * same editor, rather than forking it.
 */
import { useEffect, useRef } from 'react';
import { loadDocument, type Document } from '@artboard/schema';

export type DesktopCommand =
  | 'doc:new' | 'doc:export'
  | 'edit:undo' | 'edit:redo' | 'edit:cut' | 'edit:copy' | 'edit:paste'
  | 'edit:duplicate' | 'edit:delete' | 'edit:selectAll' | 'edit:deselect'
  | 'view:zoomIn' | 'view:zoomOut' | 'view:zoom100' | 'view:fit'
  | 'view:present' | 'view:shortcuts'
  | 'recent:clear' | 'help:licence';

interface DesktopBridge {
  platform: string;
  version: string;
  openDocument(): Promise<{ status: string; path?: string }>;
  saveDocument(json: string, saveAs?: boolean): Promise<{ status: string; path?: string; message?: string }>;
  exportFile(filename: string, data: string, mime: string): Promise<{ status: string; path?: string }>;
  recentFiles(): Promise<string[]>;
  setDirty(dirty: boolean): void;
  onOpen(fn: (p: { json: string; path: string }) => void): () => void;
  onCommand(fn: (c: DesktopCommand) => void): () => void;
  onSaveRequest(fn: (p: { saveAs?: boolean; thenClose?: boolean }) => void): () => void;
}

export const desktop = (): DesktopBridge | null =>
  (globalThis as unknown as { artboard?: DesktopBridge }).artboard ?? null;

/** True when running inside the Electron shell. Safe to call on the web. */
export const isDesktop = (): boolean => desktop() !== null;

export interface DesktopHandlers {
  setDocument(doc: Document, path: string): void;
  serialize(): string;
  command(c: DesktopCommand): void;
  onError(message: string): void;
}

/**
 * Wire the native menu and native file dialogs to the editor.
 *
 * `handlers` is read through a ref-like closure on every event rather than
 * captured once, so the listeners do not need re-registering whenever the
 * document changes — re-subscribing on every keystroke would drop menu events
 * in the gap between unsubscribe and subscribe.
 */
export function useDesktopBridge(handlers: DesktopHandlers, dirty: boolean): void {
  // A real ref, not a fresh object per render: the effect below subscribes
  // once and closes over this box forever, so anything else would freeze the
  // first render's handlers and Save would keep writing the document that was
  // open when the window launched.
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const d = desktop();
    if (!d) return;

    const offOpen = d.onOpen(({ json, path }) => {
      try {
        // Parse through the schema, exactly like the web Open path. A file on
        // disk is not more trustworthy than one from a file input.
        const { doc } = loadDocument(JSON.parse(json));
        ref.current.setDocument(doc, path);
      } catch (e) {
        ref.current.onError(e instanceof Error ? e.message : 'That file is not an Artboard design.');
      }
    });

    const offSave = d.onSaveRequest(async ({ saveAs }) => {
      try {
        const r = await d.saveDocument(ref.current.serialize(), saveAs);
        if (r.status === 'error') ref.current.onError(r.message ?? 'Could not save.');
      } catch (e) {
        ref.current.onError(e instanceof Error ? e.message : 'Could not save.');
      }
    });

    const offCmd = d.onCommand(c => ref.current.command(c));
    return () => { offOpen(); offSave(); offCmd(); };
    // Registered once for the life of the window; `ref.current` keeps the
    // handlers fresh without churning subscriptions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The title bar's dot and the "save before closing?" prompt both key off this.
  useEffect(() => { desktop()?.setDirty(dirty); }, [dirty]);
}
