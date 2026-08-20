'use strict';
/**
 * Serving the editor over a custom `app://` scheme instead of `file://`.
 *
 * `file://` pages have an opaque origin, which quietly disables the two
 * controls this shell leans on: a real origin to pin navigation against, and
 * response headers to carry the CSP. A registered standard+secure scheme gives
 * us both, and costs about forty lines.
 */
const { protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const SCHEME = 'app';
const HOST = 'artboard';
const ORIGIN = `${SCHEME}://${HOST}`;

/** No `unsafe-eval`, ever, and no `https:` in `img-src` or `connect-src`. */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.map': 'application/json', '.ico': 'image/x-icon',
};

/** Register before `app.whenReady()`, or the scheme is not treated as standard. */
function registerScheme() {
  protocol.registerSchemesAsPrivileged([{
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  }]);
}

function serve(root) {
  protocol.handle(SCHEME, async request => {
    const url = new URL(request.url);
    if (url.host !== HOST) return new Response('Not found', { status: 404 });

    // Resolve inside `root` and then prove it stayed there. A request path is
    // attacker-influenced in principle, and `..` segments are cheap to send.
    const rel = decodeURIComponent(url.pathname);
    const target = path.resolve(root, '.' + (rel === '/' ? '/index.html' : rel));
    if (target !== root && !target.startsWith(root + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      return new Response('Not found', { status: 404 });
    }

    const res = await net.fetch(pathToFileURL(target).toString());
    const headers = new Headers(res.headers);
    headers.set('Content-Type', TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream');
    headers.set('Content-Security-Policy', CSP);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(res.body, { status: 200, headers });
  });
}

module.exports = { SCHEME, HOST, ORIGIN, CSP, registerScheme, serve };
