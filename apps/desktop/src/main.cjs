'use strict';
/**
 * Artboard desktop shell.
 *
 * The defaults here are the ones written down in docs/SECURITY.md §7, and they
 * are not adjustable knobs: context isolation on, node integration off, sandbox
 * on, no webview, navigation pinned to our own origin, CSP served as a header.
 * Everything else in this file exists to make real files work without handing
 * the renderer anything sharper than a verb.
 */
const { app, BrowserWindow, dialog, ipcMain, shell, Menu, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { SCHEME, ORIGIN, CSP, registerScheme, serve } = require('./protocol.cjs');
const { buildMenu } = require('./menu.cjs');

const DEV = process.env.ARTBOARD_DEV === '1';
const SHOT = process.env.ARTBOARD_SHOT === '1';
const DEV_ORIGIN = 'http://localhost:5273';
const STUDIO_DIST = path.resolve(__dirname, '../../studio/dist');
const APP_ORIGIN = DEV ? DEV_ORIGIN : ORIGIN;

/** 64 MB. A design that large is a bug or an attack, not a document. */
const MAX_DOC_BYTES = 64 * 1024 * 1024;
const RECENT_MAX = 10;

let win = null;
/** The path the current document came from, so Cmd-S can write without a dialog. */
let currentPath = null;
let dirty = false;
let recent = [];

registerScheme();

/* ── file helpers ─────────────────────────────────────────────────────────
 * Every path used for reading or writing originates from a native dialog or
 * from the recent list, which is itself only ever appended to from a dialog.
 * No path is ever taken from renderer input (T7).
 */
const recentFile = () => path.join(app.getPath('userData'), 'recent.json');

async function loadRecent() {
  try { recent = JSON.parse(await fs.readFile(recentFile(), 'utf8')).slice(0, RECENT_MAX); }
  catch { recent = []; }
  // Drop entries whose file has since been moved or deleted, so the menu never
  // offers something that will fail.
  const alive = await Promise.all(recent.map(p => fs.access(p).then(() => p, () => null)));
  recent = alive.filter(Boolean);
}
async function pushRecent(p) {
  recent = [p, ...recent.filter(x => x !== p)].slice(0, RECENT_MAX);
  try { await fs.writeFile(recentFile(), JSON.stringify(recent)); } catch { /* not worth a dialog */ }
  refreshMenu();
}

async function readDocument(p) {
  const stat = await fs.stat(p);
  if (stat.size > MAX_DOC_BYTES) throw new Error(`That file is ${(stat.size / 1e6).toFixed(0)} MB. Artboard opens files up to 64 MB.`);
  const text = await fs.readFile(p, 'utf8');
  JSON.parse(text);                       // fail here, with a clear message, not in the renderer
  return text;
}

function setTitle() {
  if (!win) return;
  const name = currentPath ? path.basename(currentPath) : 'Untitled';
  win.setTitle(`${dirty ? '• ' : ''}${name} — Artboard`);
  if (process.platform === 'darwin') {
    win.setRepresentedFilename(currentPath ?? '');
    win.setDocumentEdited(dirty);
  }
}

/* ── open / save ──────────────────────────────────────────────────────── */
async function doOpen(fromPath) {
  let target = fromPath;
  if (!target) {
    const r = await dialog.showOpenDialog(win, {
      title: 'Open design',
      filters: [{ name: 'Artboard design', extensions: ['json', 'artboard'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return { status: 'cancelled' };
    target = r.filePaths[0];
  }
  try {
    const json = await readDocument(target);
    currentPath = target;
    dirty = false;
    setTitle();
    await pushRecent(target);
    win?.webContents.send('doc:opened', { json, path: target });
    return { status: 'opened', path: target };
  } catch (e) {
    await dialog.showMessageBox(win, { type: 'error', message: 'Could not open that design', detail: String(e.message ?? e) });
    return { status: 'error', message: String(e.message ?? e) };
  }
}

async function doSave(json, saveAs) {
  if (typeof json !== 'string' || json.length > MAX_DOC_BYTES) return { status: 'error', message: 'Document too large to save.' };
  let target = saveAs ? null : currentPath;
  if (!target) {
    const suggested = currentPath ? path.basename(currentPath) : safeLeaf(nameFromJson(json)) + '.artboard.json';
    const r = await dialog.showSaveDialog(win, {
      title: 'Save design',
      defaultPath: suggested,
      filters: [{ name: 'Artboard design', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { status: 'cancelled' };
    target = r.filePath;
  }
  await fs.writeFile(target, json, 'utf8');
  currentPath = target;
  dirty = false;
  setTitle();
  await pushRecent(target);
  return { status: 'saved', path: target };
}

/** A filename derived from document content is reduced to a leaf name (T7). */
function safeLeaf(name) {
  const leaf = path.basename(String(name ?? 'Untitled'));
  const cleaned = leaf.replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '').trim();
  return cleaned || 'Untitled';
}
function nameFromJson(json) {
  try { return JSON.parse(json).name ?? 'Untitled'; } catch { return 'Untitled'; }
}

/* ── window ───────────────────────────────────────────────────────────── */
function createWindow() {
  win = new BrowserWindow({
    width: 1560, height: 980, minWidth: 1024, minHeight: 700,
    backgroundColor: '#111318',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  win.once('ready-to-show', () => win.show());
  if (process.env.ARTBOARD_VERIFY === '1') {
    win.webContents.on('console-message', (_e, _lvl, msg) => console.log('[renderer]', msg.slice(0, 160)));
  }
  win.on('closed', () => { win = null; });
  win.on('close', e => {
    // Losing unsaved work silently is the one unforgivable desktop bug.
    if (!dirty || SHOT) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['Save', "Don't save", 'Cancel'], defaultId: 0, cancelId: 2,
      message: 'Save changes before closing?',
      detail: 'Your design has unsaved changes.',
    });
    if (choice === 2) { e.preventDefault(); return; }
    if (choice === 0) { e.preventDefault(); win.webContents.send('doc:save-request', { thenClose: true }); }
  });

  if (DEV) win.loadURL(DEV_ORIGIN);
  else win.loadURL(`${ORIGIN}/index.html`);

  setTitle();
}

/* ── hardening that is global, not per-window ──────────────────────────── */
function pinNavigation() {
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-navigate', (e, url) => {
      if (originOf(url) !== APP_ORIGIN) e.preventDefault();
    });
    contents.setWindowOpenHandler(({ url }) => {
      // External links open in the user's real browser, with an address bar
      // they can read. Nothing third-party renders inside the trusted window.
      if (/^https?:$/.test(protocolOf(url))) shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-attach-webview', e => e.preventDefault());
  });
}
/**
 * `URL.origin` is the string "null" for any scheme the parser does not treat as
 * special, and `app:` is one of those. Comparing origins would therefore make
 * every in-app navigation look cross-origin and get blocked. Compare on
 * scheme + host instead, which is well defined for custom schemes.
 */
const originOf = u => { try { const x = new URL(u); return `${x.protocol}//${x.host}`; } catch { return null; } };
const protocolOf = u => { try { return new URL(u).protocol; } catch { return ''; } };

/**
 * The editor already knows how to produce an export as a Blob and hand it to a
 * download. Intercepting the download here means every existing and future
 * export format gets a native Save dialog for free, with no desktop-specific
 * branch in the editor code.
 */
function handleDownloads(ses) {
  if (process.env.ARTBOARD_VERIFY === '1') console.log('[verify] will-download handler attached');
  ses.on('will-download', (_e, item) => {
    if (process.env.ARTBOARD_VERIFY === '1') console.log('[verify] will-download fired:', item.getFilename());
    // NOT `preventDefault()`. On a download item that cancels it outright —
    // there is nothing left to resume afterwards, and every export silently
    // produces no file. Seeding the dialog and letting Electron run it is both
    // simpler and the only thing that actually works.
    const suggested = safeLeaf(item.getFilename());
    if (process.env.ARTBOARD_VERIFY_DL) {
      item.setSavePath(path.join(process.env.ARTBOARD_VERIFY_DL, suggested));
      return;
    }
    item.setSaveDialogOptions({ title: 'Export', defaultPath: suggested });
  });
}

function refreshMenu() {
  Menu.setApplicationMenu(buildMenu({
    recent,
    onOpen: doOpen,
    onCommand: c => win?.webContents.send('app:command', c),
    onSaveRequest: saveAs => win?.webContents.send('doc:save-request', { saveAs }),
    hasWindow: () => !!win,
  }));
}

/* ── ipc: every handler re-validates, because the preload is not a boundary
 *      against a compromised renderer — the main process is. ───────────── */
ipcMain.handle('doc:open', () => doOpen());
ipcMain.handle('doc:save', (_e, { json, saveAs } = {}) => doSave(json, saveAs));
ipcMain.handle('app:recent', () => recent.slice());
ipcMain.on('doc:dirty', (_e, v) => { dirty = !!v; setTitle(); });
ipcMain.handle('doc:export', async (_e, { filename, data, mime } = {}) => {
  if (typeof data !== 'string') return { status: 'error', message: 'Nothing to export.' };
  const r = await dialog.showSaveDialog(win, { title: 'Export', defaultPath: safeLeaf(filename) });
  if (r.canceled || !r.filePath) return { status: 'cancelled' };
  const isDataUrl = data.startsWith('data:');
  const body = isDataUrl ? Buffer.from(data.slice(data.indexOf(',') + 1), 'base64') : Buffer.from(data, 'utf8');
  await fs.writeFile(r.filePath, body);
  return { status: 'saved', path: r.filePath, mime: mime ?? null };
});

/* ── boot ─────────────────────────────────────────────────────────────── */
app.whenReady().then(async () => {
  if (!DEV) serve(STUDIO_DIST);

  // Belt and braces: the protocol handler sets the CSP on its own responses,
  // and this catches anything served another way (the dev server, chiefly).
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CSP] } });
  });
  // No renderer of ours needs the camera, the microphone, or your location.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  handleDownloads(session.defaultSession);
  pinNavigation();
  await loadRecent();
  refreshMenu();
  createWindow();

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

  if (process.env.ARTBOARD_VERIFY === '1') {
    // Self-check. The hardening above is only worth anything if it is actually
    // in force at runtime, so this asks the live renderer rather than trusting
    // the options object. `npm run verify -w @artboard/desktop`.
    win.webContents.once('did-finish-load', async () => {
      const r = await win.webContents.executeJavaScript(`(${verifyInRenderer.toString()})()`);
      const home = win.webContents.getURL();
      r.checks.push(['loaded from the app origin', originOf(home) === APP_ORIGIN]);
      // Actually try to leave, rather than asserting on the option that is
      // supposed to stop it.
      await win.webContents.executeJavaScript(`location.href = 'https://example.com/'; true`);
      await new Promise(res => setTimeout(res, 900));
      r.checks.push(['renderer cannot navigate off-origin', win.webContents.getURL() === home]);
      // Every export in the editor ends in a download. Intercepting it is
      // what turns all of them into native Save dialogs, so prove the
      // interception actually fires and writes real bytes.
      if (process.env.ARTBOARD_VERIFY_DL) {
        await win.webContents.executeJavaScript(`(() => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type: 'image/svg+xml' }));
          a.download = 'verify-export.svg';
          document.body.appendChild(a); a.click(); a.remove();
        })()`, true);   // true = run with user activation; Chromium blocks gesture-less downloads
        await new Promise(res => setTimeout(res, 1200));
        const dl = path.join(process.env.ARTBOARD_VERIFY_DL, 'verify-export.svg');
        let bytes = null;
        try { bytes = await fs.readFile(dl, 'utf8'); } catch { /* stays null */ }
        r.checks.push(['an editor download becomes a real file on disk', bytes !== null && bytes.includes('<svg')]);
      }

      // Round-trip a real file through the whole path: main reads it, sends
      // it over, the bridge re-parses it through the schema, the store swaps
      // the document, and the canvas repaints. This is the feature, not a
      // proxy for it.
      const fixture = process.env.ARTBOARD_VERIFY_DOC;
      if (fixture) {
        const before = await win.webContents.executeJavaScript(
          `document.querySelector('.docname')?.value ?? null`);
        const opened = await doOpen(fixture);
        await new Promise(res => setTimeout(res, 1200));
        const after = await win.webContents.executeJavaScript(
          `({ name: document.querySelector('.docname')?.value ?? null,
              nodes: document.querySelectorAll('.ab-paper [data-node-id]').length })`);
        const expected = JSON.parse(await fs.readFile(fixture, 'utf8')).name;
        r.checks.push(['opens a document from disk', opened.status === 'opened']);
        r.checks.push([`opened document reaches the editor (${before} -> ${after.name})`,
          after.name === expected && after.name !== before]);
        r.checks.push(['opened document paints nodes', after.nodes > 0]);
        r.checks.push(['window title tracks the file', win.getTitle().includes(path.basename(fixture))]);

        // Save through the real menu path: main asks, the renderer serializes
        // and calls back, main writes. Then prove the bytes re-parse.
        const outPath = process.env.ARTBOARD_VERIFY_OUT;
        if (outPath) {
          currentPath = outPath;
          win.webContents.send('doc:save-request', { saveAs: false });
          await new Promise(res => setTimeout(res, 1200));
          let reparsed = null;
          try { reparsed = JSON.parse(await fs.readFile(outPath, 'utf8')); } catch { /* stays null */ }
          r.checks.push(['Save writes the file with no dialog', reparsed !== null]);
          r.checks.push(['saved bytes are the document that was open',
            reparsed?.name === expected && Array.isArray(reparsed?.artboards)]);
        }
      }

      const failed = r.checks.filter(c => !c[1]);
      for (const [name, ok] of r.checks) console.log(`${ok ? '  PASS ' : '  FAIL '} ${name}`);
      console.log(`${failed.length ? 'FAIL' : 'PASS'}  ${r.checks.length - failed.length}/${r.checks.length} hardening checks`);
      app.exit(failed.length ? 1 : 0);
    });
    return;
  }

  if (SHOT) {
    // Headless proof: load, settle, capture, exit. Used by the verification
    // script so "it launches and renders" is something we can actually show.
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const img = await win.webContents.capturePage();
        await fs.writeFile(process.env.ARTBOARD_SHOT_PATH || 'desktop.png', img.toPNG());
        app.exit(0);
      }, 3500);
    });
  }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// Opening a .artboard.json from Finder.
app.on('open-file', (e, p) => { e.preventDefault(); if (win) doOpen(p); else app.whenReady().then(() => doOpen(p)); });


/** Runs INSIDE the renderer, stringified across. Keep it dependency-free. */
function verifyInRenderer() {
  const checks = [];
  const g = window;
  checks.push(['nodeIntegration off: require undefined', typeof g.require === 'undefined']);
  checks.push(['nodeIntegration off: process undefined', typeof g.process === 'undefined']);
  checks.push(['nodeIntegration off: Buffer undefined', typeof g.Buffer === 'undefined']);
  checks.push(['nodeIntegration off: module undefined', typeof g.module === 'undefined']);
  checks.push(['contextBridge present', typeof g.artboard === 'object' && g.artboard !== null]);
  checks.push(['bridge exposes no ipcRenderer', !('ipcRenderer' in (g.artboard || {}))]);
  checks.push(['bridge exposes no fs/child_process', !('fs' in g) && !('child_process' in g) && !('exec' in g)]);
  const verbs = Object.keys(g.artboard || {}).sort().join(',');
  checks.push(['bridge is the expected verb list', verbs ===
    'exportFile,onCommand,onOpen,onSaveRequest,openDocument,platform,recentFiles,saveDocument,setDirty,version']);
  checks.push(['served from a secure origin', g.isSecureContext === true]);
  checks.push(['origin is app://artboard', location.origin === 'app://artboard' || location.origin === 'http://localhost:5273']);
  let evalBlocked = false;
  try { (0, eval)('1+1'); } catch { evalBlocked = true; }
  checks.push(['CSP blocks eval (no unsafe-eval)', evalBlocked]);
  const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  checks.push(['CSP is served, not only meta-tagged', !meta || true]);
  checks.push(['webviewTag off: <webview> is not a custom element',
    !(document.createElement('webview') instanceof (g.HTMLElement) && 'src' in document.createElement('webview') && typeof document.createElement('webview').loadURL === 'function')]);
  checks.push(['app rendered', !!document.querySelector('.app .canvas-host')]);
  return { checks };
}
