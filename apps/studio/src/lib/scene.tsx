import React from 'react';
import type { SceneNode } from '@artboard/render-svg';

/** Mount the SAME scene graph the CLI serializes. One renderer, no parity drift. */
export function Scene({ node, keyPath = 'r' }: { node: SceneNode; keyPath?: string }): React.ReactElement {
  const attrs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node.attrs)) {
    if (k === 'style' && typeof v === 'string') { attrs.style = parseStyle(v); continue; }
    attrs[svgAttr(k)] = v;
  }
  if (node.nodeId) attrs['data-node-id'] = node.nodeId;

  if (node.text !== undefined && !node.children) {
    return React.createElement(node.tag, { ...attrs, key: keyPath }, node.text);
  }
  const children = (node.children ?? []).map((c, i) => <Scene key={`${keyPath}.${i}`} node={c} keyPath={`${keyPath}.${i}`} />);
  return React.createElement(node.tag, { ...attrs, key: keyPath }, children.length ? children : undefined);
}

/**
 * The scene graph speaks SVG (`flood-opacity`); React's DOM props speak
 * camelCase (`floodOpacity`) and silently DROP anything hyphenated it does not
 * recognise — which is how an effect can render correctly from the CLI and be
 * invisible in the editor.
 *
 * This is a rule, not a list, deliberately: a hand-maintained allowlist goes
 * stale the moment the renderer emits an attribute nobody remembered to add,
 * and the failure is silent. React's own convention is "camelCase everything
 * except namespaced, data-, and aria- attributes", so that is what we apply.
 */
const NAMESPACED: Record<string, string> = {
  'xml:space': 'xmlSpace', 'xml:lang': 'xmlLang', 'xlink:href': 'xlinkHref', 'xlink:title': 'xlinkTitle',
};
const svgAttr = (k: string): string => {
  if (k.startsWith('data-') || k.startsWith('aria-')) return k;
  if (k.includes(':')) return NAMESPACED[k] ?? k;
  if (!k.includes('-')) return k;
  return k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
};

/** React rejects a style string, so `mix-blend-mode:multiply` becomes an object. */
function parseStyle(s: string): React.CSSProperties {
  const out: Record<string, string> = {};
  for (const decl of s.split(';')) {
    const i = decl.indexOf(':');
    if (i < 1) continue;
    const prop = decl.slice(0, i).trim();
    const val = decl.slice(i + 1).trim();
    if (!prop || !val) continue;
    out[prop.startsWith('--') ? prop : prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = val;
  }
  return out as React.CSSProperties;
}
