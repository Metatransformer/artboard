#!/usr/bin/env node
/**
 * Build the shareable single-file demo.
 *
 * The Artifact host owns <head>, so we cannot ship our own <meta charset>, and a
 * late charset declaration is unreliable. Instead we emit a pure-ASCII file:
 * every non-ASCII character becomes a \uXXXX escape (JS) or a codepoint escape
 * (CSS). The page then renders identically regardless of the Content-Type
 * charset the host sends.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(resolve(root, 'apps/studio/dist-demo/index.html'), 'utf8');

const grabAll = (re) => {
  const m = [...src.matchAll(re)].map((x) => x[1]);
  if (!m.length) throw new Error(`build-demo: nothing matched ${re}`);
  return m;
};

// Fonts used to come from the Google Fonts CDN. They are bundled now, and the
// single-file build inlines them as data URIs inside the stylesheet — so there
// is nothing to link, and nothing to preconnect to. Assert that, rather than
// silently shipping a page with no type if the CSS ever stops inlining.
if (/https:\/\/fonts\.(googleapis|gstatic)\.com/.test(src)) {
  throw new Error('build-demo: the demo still references the Google Fonts CDN; fonts must be bundled and inlined');
}
const styles = grabAll(/<style[^>]*>([\s\S]*?)<\/style>/g);
const scripts = grabAll(/<script type="module"[^>]*>([\s\S]*?)<\/script>/g);

const NON_ASCII = /[^\x00-\x7F]/g;
const hex = (c, pad) => c.charCodeAt(0).toString(16).padStart(pad, '0');
const escapeJs = (s) => s.replace(NON_ASCII, (c) => '\\u' + hex(c, 4));
const escapeCss = (s) => s.replace(NON_ASCII, (c) => '\\' + hex(c, 6));

const css =
  escapeCss(styles.join('\n')) +
  `
html,body{height:100%;margin:0;background:#0f1117}
#root{height:100dvh;min-height:520px}
.app{height:100%}
`;

const page = [
  '<title>Artboard Studio</title>',
  '<style>\n' + css + '\n</style>',
  '<div id="root"></div>',
  ...scripts.map((s) => '<script type="module">\n' + escapeJs(s) + '\n</script>'),
].join('\n');

const stray = [...page].filter((c) => c.charCodeAt(0) > 127).length;
if (stray) throw new Error(`build-demo: ${stray} non-ASCII characters survived escaping`);

const faces = (css.match(/@font-face/g) ?? []).length;
const inlined = (css.match(/data:font\/woff2/g) ?? []).length;
if (faces === 0 || inlined < faces) {
  throw new Error(`build-demo: ${inlined} of ${faces} @font-face rules are inlined; the demo would render with system fonts`);
}

const out = resolve(root, 'apps/studio/dist-demo/artboard-demo.html');
writeFileSync(out, page, 'ascii');
console.log(`build-demo: wrote ${out} (${(page.length / 1024).toFixed(0)} kB, pure ASCII, ${inlined} fonts inlined)`);
