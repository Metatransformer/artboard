'use strict';
/**
 * The whole trusted surface the renderer gets.
 *
 * This is a fixed verb list, not a primitive. It never exposes a module, a
 * path, `ipcRenderer` itself, or anything that could be used to reach a
 * channel this file does not name. The renderer can ask to open *a* document;
 * it can never say which one — the main process owns every path.
 */
const { contextBridge, ipcRenderer } = require('electron');

/** Main-process pushes. Each returns an unsubscribe so React can clean up. */
const on = (channel, fn) => {
  const wrapped = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.off(channel, wrapped);
};

contextBridge.exposeInMainWorld('artboard', {
  platform: process.platform,
  version: process.versions.electron,

  /* renderer -> main, each argument validated again on the far side */
  openDocument: () => ipcRenderer.invoke('doc:open'),
  saveDocument: (json, saveAs) => ipcRenderer.invoke('doc:save', { json, saveAs: !!saveAs }),
  exportFile: (filename, data, mime) => ipcRenderer.invoke('doc:export', { filename, data, mime }),
  recentFiles: () => ipcRenderer.invoke('app:recent'),
  setDirty: dirty => ipcRenderer.send('doc:dirty', !!dirty),

  /* main -> renderer, driven by the native menu */
  onOpen: fn => on('doc:opened', fn),
  onCommand: fn => on('app:command', fn),
  onSaveRequest: fn => on('doc:save-request', fn),
});
