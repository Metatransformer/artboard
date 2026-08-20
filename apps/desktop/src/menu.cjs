'use strict';
/**
 * The native menu.
 *
 * Two rules: every entry either maps to an OS role (so the platform handles it
 * correctly and for free) or sends one named command to the renderer. Nothing
 * here reaches into the document itself — the main process does not know what
 * a node is, and should not.
 */
const { app, shell } = require('electron');

const MAC = process.platform === 'darwin';
const MOD = MAC ? 'Cmd' : 'Ctrl';

function buildMenu({ recent, onOpen, onCommand, onSaveRequest }) {
  const cmd = (label, accelerator, command, extra = {}) => ({
    label, accelerator, click: () => onCommand(command), ...extra,
  });

  const recentSubmenu = recent.length
    ? recent.map(p => ({ label: shortPath(p), click: () => onOpen(p) }))
      .concat([{ type: 'separator' }, { label: 'Clear menu', click: () => onCommand('recent:clear') }])
    : [{ label: 'No recent designs', enabled: false }];

  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    ...(MAC ? [{
      label: app.name,
      submenu: [
        { role: 'about' }, { type: 'separator' },
        { role: 'services' }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' }, { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        cmd('New design', `${MOD}+N`, 'doc:new'),
        { label: 'Open…', accelerator: `${MOD}+O`, click: () => onOpen() },
        { label: 'Open Recent', submenu: recentSubmenu },
        { type: 'separator' },
        { label: 'Save', accelerator: `${MOD}+S`, click: () => onSaveRequest(false) },
        { label: 'Save As…', accelerator: `${MOD}+Shift+S`, click: () => onSaveRequest(true) },
        { type: 'separator' },
        cmd('Export…', `${MOD}+Shift+E`, 'doc:export'),
        ...(MAC ? [] : [{ type: 'separator' }, { role: 'quit' }]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        // These go to the renderer rather than using the OS roles: the editor
        // has its own undo stack and its own clipboard payload, and the OS
        // roles would drive the DOM's instead.
        cmd('Undo', `${MOD}+Z`, 'edit:undo'),
        cmd('Redo', MAC ? 'Cmd+Shift+Z' : 'Ctrl+Y', 'edit:redo'),
        { type: 'separator' },
        cmd('Cut', `${MOD}+X`, 'edit:cut'),
        cmd('Copy', `${MOD}+C`, 'edit:copy'),
        cmd('Paste', `${MOD}+V`, 'edit:paste'),
        cmd('Duplicate', `${MOD}+D`, 'edit:duplicate'),
        cmd('Delete', 'Delete', 'edit:delete'),
        { type: 'separator' },
        cmd('Select All', `${MOD}+A`, 'edit:selectAll'),
        cmd('Deselect', 'Escape', 'edit:deselect'),
      ],
    },
    {
      label: 'View',
      submenu: [
        cmd('Zoom In', `${MOD}+Plus`, 'view:zoomIn'),
        cmd('Zoom Out', `${MOD}+-`, 'view:zoomOut'),
        cmd('Zoom to 100%', `${MOD}+0`, 'view:zoom100'),
        cmd('Fit to Window', `${MOD}+1`, 'view:fit'),
        { type: 'separator' },
        cmd('Present', `${MOD}+Shift+P`, 'view:present'),
        cmd('Keyboard Shortcuts', `${MOD}+/`, 'view:shortcuts'),
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(process.env.ARTBOARD_DEV === '1' ? [{ role: 'toggleDevTools' }, { role: 'forceReload' }] : []),
      ],
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(MAC ? [{ type: 'separator' }, { role: 'front' }] : [{ role: 'close' }])] },
    {
      role: 'help',
      submenu: [
        { label: 'Artboard on GitHub', click: () => shell.openExternal('https://github.com/artboard-app/artboard') },
        { label: 'Licence (MIT)', click: () => onCommand('help:licence') },
      ],
    },
  ];

  const { Menu } = require('electron');
  return Menu.buildFromTemplate(template);
}

/** `/Users/me/Designs/poster.json` -> `poster.json — Designs`. */
function shortPath(p) {
  const parts = p.split(require('node:path').sep).filter(Boolean);
  const file = parts.pop();
  const dir = parts.pop();
  return dir ? `${file} — ${dir}` : file;
}

module.exports = { buildMenu };
