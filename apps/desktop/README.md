# Artboard Desktop

The same editor as the web build, running locally, with real files.

There is no second copy of the editor here. `apps/desktop` is a shell: it serves
`apps/studio/dist` over a private scheme, adds a native menu, native Open/Save,
and native export, and otherwise gets out of the way. Anything that changes the
editor changes the desktop app for free.

## Run it

```sh
npm run build            # build the studio bundle the shell serves
npm start -w @artboard/desktop
```

Against the dev server instead, with hot reload and devtools:

```sh
npm run dev              # terminal 1: vite on :5273
npm run dev -w @artboard/desktop
```

## Prove it is still hardened

```sh
npm run verify -w @artboard/desktop
```

This launches the app and interrogates the **live renderer** — it does not read
the options object back and call that a test. It checks that `require`,
`process`, `Buffer`, and `module` are all absent, that the context bridge
exposes exactly the expected verb list and nothing sharper, that the page is a
secure context on `app://artboard`, that `eval` throws (so the CSP really has
no `unsafe-eval`), and that a renderer-initiated navigation to an external
origin does not move the window. Add a document to also round-trip a real file
through open, repaint, and save:

```sh
ARTBOARD_VERIFY=1 \
ARTBOARD_VERIFY_DOC=tests/golden/business-card-mono.json \
ARTBOARD_VERIFY_OUT=/tmp/out.json \
ARTBOARD_VERIFY_DL=/tmp/dl \
  npx electron apps/desktop
```

## How it is put together

| File | What it owns |
|---|---|
| `src/main.cjs` | Window, hardening, IPC, open/save, downloads, the verify harness |
| `src/protocol.cjs` | The `app://artboard` scheme and the CSP it serves |
| `src/preload.cjs` | The entire trusted surface: a fixed verb list, nothing more |
| `src/menu.cjs` | The native menu; every item is an OS role or one named command |
| `apps/studio/src/lib/desktop.ts` | The editor's half. Inert on the web. |

### Why a custom scheme instead of `file://`

`file://` pages have an opaque origin. That quietly removes both of the controls
this shell depends on: there is no origin to pin navigation against, and no
response headers to carry the CSP. A registered standard, secure scheme gives us
both for about forty lines, and lets the same CSP apply in dev and in production.

### Why exports need no desktop-specific code

Every export in the editor ends in a download. `will-download` seeds the native
Save dialog with the suggested filename, so every existing and future export
format becomes a native save with no branch in the editor.

One trap worth writing down, because it fails silently: calling
`event.preventDefault()` on a download **cancels** it, and there is nothing left
to `resume()` afterwards. The first version of this file did exactly that and
produced no file at all. Seed the dialog; do not intercept.

### What the renderer can and cannot say

The renderer can ask to open *a* document. It can never name a path. Every path
comes from a native dialog or from the recent-files list, which is itself only
ever appended to from a dialog. A filename derived from document content is
reduced to a leaf name before it reaches the filesystem.

## Not done yet

- **Packaging.** No `.dmg`/`.exe`/`.AppImage`, no code signing, no auto-update.
  The shell runs from source today.
- **Fonts.** Tracked separately: the studio still links Google Fonts, which the
  CSP correctly refuses, so type falls back to system defaults until the
  binaries are bundled locally.
