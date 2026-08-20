/**
 * The project browser: folders on the left, saved designs on the right, and the
 * save controls for the document currently on the canvas along the top.
 *
 * Everything the vault can reject is caught and turned into a toast - a storage
 * failure must never take the editor down with it - and every destructive act
 * asks twice, inline, because window.confirm() is a lie the user cannot style,
 * cannot read on a phone, and cannot back out of with the keyboard.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseDocument } from '@artboard/schema';
import { useEditor } from '../state/store';
import {
  backend, createFolder, deleteFolder, deleteProject, duplicateProject,
  listFolders, listProjects, patchProject, renameFolder, saveProject, vaultId,
  type Folder, type ProjectMeta,
} from '../lib/vault';
import { forgetProject, lastProjectId, thumbnailFor, useCurrentProject } from '../lib/useProject';

type BackendKind = 'indexeddb' | 'localstorage' | 'memory';

const STORAGE_COPY: Record<BackendKind, { text: string; warn: boolean }> = {
  indexeddb: { text: 'Saved in this browser', warn: false },
  localstorage: { text: 'Saved in this browser (limited space)', warn: false },
  memory: { text: 'Not saved - this browser blocks local storage, so export your work before closing.', warn: true },
};

const reason = (e: unknown): string =>
  e instanceof Error ? (e.name && e.name !== 'Error' ? `${e.name}: ${e.message}` : e.message) : String(e);

function relative(ts: number, now: number): string {
  const secs = Math.max(0, Math.round((now - ts) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(ts).toLocaleDateString();
}

/** Folders nest one level, so a label is either "Work" or "Work / Q3". */
function folderLabel(f: Folder, byId: Map<string, Folder>): string {
  const parent = f.parentId === null ? undefined : byId.get(f.parentId);
  return parent ? `${parent.name} / ${f.name}` : f.name;
}

export function ProjectsPanel() {
  const { state, dispatch } = useEditor();
  const project = useCurrentProject();

  const [folders, setFolders] = useState<Folder[]>([]);
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [storage, setStorage] = useState<BackendKind | null>(null);

  /** null = the "All designs" root. */
  const [folderId, setFolderId] = useState<string | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  const [folderDraft, setFolderDraft] = useState('');
  const [confirmFolder, setConfirmFolder] = useState<string | null>(null);

  const [renamingProject, setRenamingProject] = useState<string | null>(null);
  const [projectDraft, setProjectDraft] = useState('');
  const [confirmProject, setConfirmProject] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [saveName, setSaveName] = useState(state.doc.name);
  const [saveFolder, setSaveFolder] = useState<string | null>(null);
  const [resumeId, setResumeId] = useState<string | null>(() => lastProjectId());

  const fileRef = useRef<HTMLInputElement>(null);

  const toast = useCallback(
    (level: 'info' | 'warn' | 'error', message: string) => dispatch({ type: 'toast', toast: { level, message } }),
    [dispatch],
  );
  const reload = useCallback(() => setTick(t => t + 1), []);

  /* ── data ──────────────────────────────────────────────────────────────── */

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [f, p] = await Promise.all([listFolders(), listProjects()]);
        if (cancelled) return;
        setFolders(f);
        setProjects(p);
        setLoadError(null);
      } catch (e) {
        if (!cancelled) setLoadError(reason(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [tick]);

  // Reload after the current document is saved so the grid never lies.
  useEffect(() => { if (project.lastSavedAt !== null) reload(); }, [project.lastSavedAt, reload]);

  useEffect(() => {
    let cancelled = false;
    backend()
      .then(b => { if (!cancelled) setStorage(b.kind); })
      .catch(() => { if (!cancelled) setStorage('memory'); });
    return () => { cancelled = true; };
  }, []);

  // "edited 5 min ago" has to keep being true while the panel sits open.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // The name field follows the document until the design has a record of its own.
  useEffect(() => { if (!project.meta) setSaveName(state.doc.name); }, [state.doc.name, project.meta]);

  const byId = useMemo(() => new Map(folders.map(f => [f.id, f])), [folders]);
  const roots = useMemo(() => folders.filter(f => f.parentId === null || !byId.has(f.parentId)), [folders, byId]);
  const childrenOf = useCallback((id: string) => folders.filter(f => f.parentId === id), [folders]);

  const visible = useMemo(
    () => (folderId === null ? projects : projects.filter(p => p.folderId === folderId)),
    [projects, folderId],
  );
  const resume = useMemo(
    () => (resumeId && resumeId !== project.meta?.id ? projects.find(p => p.id === resumeId) ?? null : null),
    [resumeId, projects, project.meta],
  );

  /* ── actions ───────────────────────────────────────────────────────────── */

  const guard = useCallback(async (label: string, key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
      reload();
    } catch (e) {
      toast('error', `${label} failed. ${reason(e)}`);
    } finally {
      setBusy(null);
    }
  }, [reload, toast]);

  const addFolder = useCallback(() => {
    const name = newFolderName.trim();
    if (!name) return;
    // A new folder lands inside the selected folder, unless that is already a
    // child - folders nest exactly one level deep.
    const selected = folderId === null ? undefined : byId.get(folderId);
    const parentId = selected ? (selected.parentId === null ? selected.id : selected.parentId) : null;
    void guard('Creating the folder', 'new-folder', async () => {
      await createFolder(name, parentId);
      setNewFolderName('');
      setNewFolderOpen(false);
    });
  }, [newFolderName, folderId, byId, guard]);

  const commitFolderRename = useCallback((id: string) => {
    const name = folderDraft.trim();
    setRenamingFolder(null);
    if (!name) return;
    void guard('Renaming the folder', `rename-${id}`, () => renameFolder(id, name));
  }, [folderDraft, guard]);

  const removeFolder = useCallback((f: Folder) => {
    setConfirmFolder(null);
    void guard('Deleting the folder', `del-${f.id}`, async () => {
      await deleteFolder(f.id);
      setFolderId(current => (current === f.id ? f.parentId : current));
    });
  }, [guard]);

  const commitProjectRename = useCallback((p: ProjectMeta) => {
    const name = projectDraft.trim();
    setRenamingProject(null);
    if (!name || name === p.name) return;
    void guard('Renaming the design', `rename-${p.id}`, () => patchProject(p.id, { name }));
  }, [projectDraft, guard]);

  const removeProject = useCallback((p: ProjectMeta) => {
    setConfirmProject(null);
    void guard('Deleting the design', `del-${p.id}`, async () => {
      await deleteProject(p.id);
      if (project.meta?.id === p.id) project.newProject();
      if (lastProjectId() === p.id) { forgetProject(); setResumeId(null); }
      toast('info', `Deleted "${p.name}".`);
    });
  }, [guard, project, toast]);

  const onImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';                     // so the same file can be picked twice
    if (!file) return;
    setBusy('import');
    try {
      const { doc, readOnly, diagnostics } = parseDocument(await file.text());
      const first = doc.artboards[0];
      const name = doc.name.trim() || file.name.replace(/\.artboard\.json$|\.json$/i, '') || 'Imported design';
      await saveProject({
        id: vaultId('prj'),
        name,
        folderId,
        width: first?.width ?? 0,
        height: first?.height ?? 0,
        thumbnail: thumbnailFor(doc),
        doc,
      });
      reload();
      const errs = diagnostics.filter(d => d.level === 'error');
      if (errs.length > 0) toast('warn', `Imported "${name}" with ${errs.length} problem${errs.length === 1 ? '' : 's'}: ${errs[0]?.message ?? ''}`);
      else if (readOnly) toast('warn', `Imported "${name}". It was made in a newer version, so it opens read-only.`);
      else toast('info', `Imported "${name}".`);
    } catch (err) {
      toast('error', `Could not import ${file.name}. ${reason(err)}`);
    } finally {
      setBusy(null);
    }
  }, [folderId, reload, toast]);

  const folderOptions = useMemo(
    () => [...folders].sort((a, b) => folderLabel(a, byId).localeCompare(folderLabel(b, byId))),
    [folders, byId],
  );

  /* ── render ────────────────────────────────────────────────────────────── */

  const saveDisabled = project.saving || state.readOnly;
  const storageNote = storage ? STORAGE_COPY[storage] : null;

  return (
    <section className="pj" aria-label="Projects">
      <header className="pj-top">
        {project.meta ? (
          <div className="pj-saved">
            <div className="pj-saved-name">
              <b title={project.meta.name}>{project.meta.name}</b>
              <small>
                {project.saving
                  ? 'Saving…'
                  : project.lastSavedAt === null
                    ? 'Not saved yet'
                    : `Saved ${relative(project.lastSavedAt, now)}`}
                {project.dirty && !project.saving ? ' · unsaved changes' : ''}
              </small>
            </div>
            <button
              className="btn btn-primary"
              onClick={() => void project.save()}
              disabled={saveDisabled}
              title={state.readOnly ? 'This document is read-only' : 'Save this design now'}
            >
              Save
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => project.newProject()}
              title="Stop editing this saved design. The next save creates a new one."
            >
              Detach
            </button>
          </div>
        ) : (
          <form
            className="pj-savenew"
            onSubmit={e => { e.preventDefault(); void project.saveAs(saveName, saveFolder); }}
          >
            <input
              className="field"
              value={saveName}
              onChange={e => setSaveName(e.target.value)}
              placeholder="Name this design"
              aria-label="Name for the saved design"
            />
            <div className="pj-savenew-row">
              <select
                className="field"
                value={saveFolder ?? ''}
                onChange={e => setSaveFolder(e.target.value === '' ? null : e.target.value)}
                aria-label="Folder to save into"
              >
                <option value="">All designs (no folder)</option>
                {folderOptions.map(f => <option key={f.id} value={f.id}>{folderLabel(f, byId)}</option>)}
              </select>
              <button className="btn btn-primary" type="submit" disabled={saveDisabled}>
                {project.saving ? 'Saving…' : 'Save design'}
              </button>
            </div>
            {state.readOnly && <p className="pj-warn">This document is read-only, so it cannot be saved as a project.</p>}
          </form>
        )}

        <div className="pj-toprow">
          <button className="btn btn-ghost" onClick={() => fileRef.current?.click()} disabled={busy === 'import'}>
            {busy === 'import' ? 'Importing…' : 'Import file'}
          </button>
          <input
            ref={fileRef}
            className="pj-file"
            type="file"
            accept=".json,.artboard.json,application/json"
            onChange={e => void onImport(e)}
            tabIndex={-1}
            aria-hidden="true"
          />
        </div>
      </header>

      <div className="pj-main">
        <nav className="pj-folders" aria-label="Folders">
          <ul className="pj-tree">
            <li>
              <button
                className={`pj-folder ${folderId === null ? 'on' : ''}`}
                onClick={() => setFolderId(null)}
                aria-pressed={folderId === null}
              >
                <span className="pj-folder-name">All designs</span>
                <span className="pj-count">{projects.length}</span>
              </button>
            </li>
            {roots.map(f => (
              <FolderBranch
                key={f.id}
                folder={f}
                depth={0}
                children0={childrenOf(f.id)}
                projects={projects}
                selected={folderId}
                onSelect={setFolderId}
                renaming={renamingFolder}
                draft={folderDraft}
                setDraft={setFolderDraft}
                startRename={id => { setRenamingFolder(id); setFolderDraft(byId.get(id)?.name ?? ''); setConfirmFolder(null); }}
                commitRename={commitFolderRename}
                cancelRename={() => setRenamingFolder(null)}
                confirming={confirmFolder}
                askDelete={id => { setConfirmFolder(id); setRenamingFolder(null); }}
                cancelDelete={() => setConfirmFolder(null)}
                doDelete={removeFolder}
                busy={busy}
              />
            ))}
          </ul>

          {newFolderOpen ? (
            <div className="pj-newfolder">
              <input
                className="field"
                autoFocus
                value={newFolderName}
                onChange={e => setNewFolderName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); addFolder(); }
                  if (e.key === 'Escape') { setNewFolderOpen(false); setNewFolderName(''); }
                }}
                placeholder="Folder name"
                aria-label="New folder name"
              />
              <div className="pj-inline-actions">
                <button className="btn btn-primary" onClick={addFolder} disabled={!newFolderName.trim() || busy === 'new-folder'}>Create</button>
                <button className="btn btn-ghost" onClick={() => { setNewFolderOpen(false); setNewFolderName(''); }}>Cancel</button>
              </div>
            </div>
          ) : (
            <button className="btn btn-ghost pj-addfolder" onClick={() => setNewFolderOpen(true)}>New folder</button>
          )}
        </nav>

        <div className="pj-content">
          {loadError !== null && (
            <p className="pj-warn" role="alert">Could not read saved designs. {loadError}</p>
          )}

          {resume && (
            <div className="pj-resume">
              <span>You were last editing <b>{resume.name}</b>.</span>
              <button className="btn" onClick={() => { void project.open(resume.id); setResumeId(null); }}>Reopen</button>
              <button className="btn btn-ghost" onClick={() => { forgetProject(); setResumeId(null); }} title="Stop offering to reopen this design">Dismiss</button>
            </div>
          )}

          {loading ? (
            <p className="hint">Reading saved designs…</p>
          ) : visible.length === 0 ? (
            <div className="pj-empty">
              {projects.length === 0 ? (
                <>
                  <p><b>No designs saved yet.</b></p>
                  <p>Anything on the canvas stays there until you save it. Name this design above and choose <b>Save design</b>, and it will appear here - and keep itself up to date as you edit.</p>
                  <p>Already have a file? <b>Import file</b> takes a .artboard.json from disk.</p>
                </>
              ) : (
                <>
                  <p><b>This folder is empty.</b></p>
                  <p>Use <b>Move to</b> on any design to file it here, or save the design you are working on straight into this folder.</p>
                </>
              )}
            </div>
          ) : (
            <ul className="pj-grid">
              {visible.map(p => (
                <ProjectCard
                  key={p.id}
                  p={p}
                  now={now}
                  isCurrent={project.meta?.id === p.id}
                  folders={folderOptions}
                  byId={byId}
                  busy={busy}
                  renaming={renamingProject === p.id}
                  draft={projectDraft}
                  setDraft={setProjectDraft}
                  startRename={() => { setRenamingProject(p.id); setProjectDraft(p.name); setConfirmProject(null); }}
                  commitRename={() => commitProjectRename(p)}
                  cancelRename={() => setRenamingProject(null)}
                  confirming={confirmProject === p.id}
                  askDelete={() => { setConfirmProject(p.id); setRenamingProject(null); }}
                  cancelDelete={() => setConfirmProject(null)}
                  doDelete={() => removeProject(p)}
                  onOpen={() => void project.open(p.id)}
                  onDuplicate={() => void guard('Duplicating the design', `dup-${p.id}`, async () => {
                    const copy = await duplicateProject(p.id);
                    if (copy) toast('info', `Created "${copy.name}".`);
                  })}
                  onMove={target => void guard('Moving the design', `move-${p.id}`, () => patchProject(p.id, { folderId: target }))}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      <footer className="pj-foot">
        {storageNote === null ? (
          <span className="pj-storage">Checking where designs are stored…</span>
        ) : (
          <span className={storageNote.warn ? 'pj-storage pj-storage-warn' : 'pj-storage'} role={storageNote.warn ? 'alert' : undefined}>
            {storageNote.text}
          </span>
        )}
      </footer>
    </section>
  );
}

/* ── folder row (one level of nesting) ───────────────────────────────────── */

interface BranchProps {
  folder: Folder;
  depth: number;
  children0: Folder[];
  projects: ProjectMeta[];
  selected: string | null;
  onSelect: (id: string) => void;
  renaming: string | null;
  draft: string;
  setDraft: (v: string) => void;
  startRename: (id: string) => void;
  commitRename: (id: string) => void;
  cancelRename: () => void;
  confirming: string | null;
  askDelete: (id: string) => void;
  cancelDelete: () => void;
  doDelete: (f: Folder) => void;
  busy: string | null;
}

function FolderBranch(props: BranchProps) {
  const { folder, depth, children0, projects, selected, onSelect, renaming, draft, setDraft } = props;
  const count = projects.filter(p => p.folderId === folder.id).length;
  const isRenaming = renaming === folder.id;
  const isConfirming = props.confirming === folder.id;

  return (
    <li>
      {isRenaming ? (
        <div className="pj-newfolder" style={{ paddingLeft: depth * 12 }}>
          <input
            className="field"
            autoFocus
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); props.commitRename(folder.id); }
              if (e.key === 'Escape') props.cancelRename();
            }}
            aria-label={`Rename folder ${folder.name}`}
          />
          <div className="pj-inline-actions">
            <button className="btn btn-primary" onClick={() => props.commitRename(folder.id)}>Rename</button>
            <button className="btn btn-ghost" onClick={props.cancelRename}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="pj-folderrow" style={{ paddingLeft: depth * 12 }}>
          <button
            className={`pj-folder ${selected === folder.id ? 'on' : ''}`}
            onClick={() => onSelect(folder.id)}
            aria-pressed={selected === folder.id}
          >
            <span className="pj-folder-name">{folder.name}</span>
            <span className="pj-count">{count}</span>
          </button>
          <button className="pj-icon" onClick={() => props.startRename(folder.id)} title={`Rename ${folder.name}`} aria-label={`Rename folder ${folder.name}`}>Rename</button>
          <button className="pj-icon" onClick={() => props.askDelete(folder.id)} title={`Delete ${folder.name}`} aria-label={`Delete folder ${folder.name}`}>Delete</button>
        </div>
      )}

      {isConfirming && (
        <div className="pj-confirm" style={{ marginLeft: depth * 12 }}>
          <p>Delete <b>{folder.name}</b>? Nothing inside is lost: the designs and any folder inside it move up one level.</p>
          <div className="pj-inline-actions">
            <button className="btn pj-danger" onClick={() => props.doDelete(folder)} disabled={props.busy === `del-${folder.id}`}>Delete folder</button>
            <button className="btn btn-ghost" onClick={props.cancelDelete} autoFocus>Keep it</button>
          </div>
        </div>
      )}

      {children0.length > 0 && (
        <ul className="pj-tree">
          {children0.map(c => (
            <FolderBranch {...props} key={c.id} folder={c} depth={depth + 1} children0={[]} />
          ))}
        </ul>
      )}
    </li>
  );
}

/* ── project card ────────────────────────────────────────────────────────── */

interface CardProps {
  p: ProjectMeta;
  now: number;
  isCurrent: boolean;
  folders: Folder[];
  byId: Map<string, Folder>;
  busy: string | null;
  renaming: boolean;
  draft: string;
  setDraft: (v: string) => void;
  startRename: () => void;
  commitRename: () => void;
  cancelRename: () => void;
  confirming: boolean;
  askDelete: () => void;
  cancelDelete: () => void;
  doDelete: () => void;
  onOpen: () => void;
  onDuplicate: () => void;
  onMove: (folderId: string | null) => void;
}

function ProjectCard(props: CardProps) {
  const { p, now, isCurrent, folders, byId, renaming, draft, setDraft } = props;
  const ratio = p.width > 0 && p.height > 0 ? p.height / p.width : 1;

  return (
    <li className={`pj-card ${isCurrent ? 'on' : ''}`}>
      <button className="pj-open" onClick={props.onOpen} title={`Open ${p.name}`} aria-label={`Open ${p.name}`}>
        {p.thumbnail
          ? <span className="thumb pj-thumb" style={{ paddingBottom: `${ratio * 100}%` }} dangerouslySetInnerHTML={{ __html: p.thumbnail }} />
          : <span className="thumb pj-thumb pj-nothumb" style={{ paddingBottom: `${ratio * 100}%` }}><em>No preview</em></span>}
      </button>

      {renaming ? (
        <div className="pj-newfolder">
          <input
            className="field"
            autoFocus
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); props.commitRename(); }
              if (e.key === 'Escape') props.cancelRename();
            }}
            aria-label={`Rename ${p.name}`}
          />
          <div className="pj-inline-actions">
            <button className="btn btn-primary" onClick={props.commitRename}>Rename</button>
            <button className="btn btn-ghost" onClick={props.cancelRename}>Cancel</button>
          </div>
        </div>
      ) : (
        <div className="pj-cardmeta">
          <span className="pj-cardname" title={p.name}>{p.name}{isCurrent ? ' (open)' : ''}</span>
          <span className="pj-sub">{Math.round(p.width)} × {Math.round(p.height)} · edited {relative(p.updatedAt, now)}</span>
        </div>
      )}

      <div className="pj-cardactions">
        <button className="pj-icon" onClick={props.onOpen} title={`Open ${p.name}`}>Open</button>
        <button className="pj-icon" onClick={props.startRename} title={`Rename ${p.name}`}>Rename</button>
        <button className="pj-icon" onClick={props.onDuplicate} title={`Duplicate ${p.name}`} disabled={props.busy === `dup-${p.id}`}>Duplicate</button>
        <button className="pj-icon" onClick={props.askDelete} title={`Delete ${p.name}`}>Delete</button>
      </div>

      <select
        className="field pj-move"
        value={p.folderId ?? ''}
        onChange={e => props.onMove(e.target.value === '' ? null : e.target.value)}
        aria-label={`Move ${p.name} to a folder`}
        title={`Move ${p.name} to a folder`}
        disabled={props.busy === `move-${p.id}`}
      >
        <option value="">Move to: no folder</option>
        {folders.map(f => <option key={f.id} value={f.id}>Move to: {folderLabel(f, byId)}</option>)}
      </select>

      {props.confirming && (
        <div className="pj-confirm">
          <p>Delete <b>{p.name}</b>? This removes it from this browser and cannot be undone.</p>
          <div className="pj-inline-actions">
            <button className="btn pj-danger" onClick={props.doDelete} disabled={props.busy === `del-${p.id}`}>Delete design</button>
            <button className="btn btn-ghost" onClick={props.cancelDelete} autoFocus>Keep it</button>
          </div>
        </div>
      )}
    </li>
  );
}
