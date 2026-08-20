import React from 'react';
import type { SceneNode } from '@artboard/render-svg';

/** Mount the SAME scene graph the CLI serializes. One renderer, no parity drift. */
export function Scene({ node, keyPath = 'r' }: { node: SceneNode; keyPath?: string }): React.ReactElement {
  const attrs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node.attrs)) attrs[svgAttr(k)] = v;
  if (node.nodeId) attrs['data-node-id'] = node.nodeId;

  if (node.text !== undefined && !node.children) {
    return React.createElement(node.tag, { ...attrs, key: keyPath }, node.text);
  }
  const children = (node.children ?? []).map((c, i) => <Scene key={`${keyPath}.${i}`} node={c} keyPath={`${keyPath}.${i}`} />);
  return React.createElement(node.tag, { ...attrs, key: keyPath }, children.length ? children : undefined);
}

/** SVG attribute names React expects. Anything hyphenated that React does not map, we pass through. */
const MAP: Record<string, string> = {
  'clip-path': 'clipPath', 'stroke-width': 'strokeWidth', 'stroke-dasharray': 'strokeDasharray',
  'stroke-linecap': 'strokeLinecap', 'font-family': 'fontFamily', 'font-size': 'fontSize',
  'font-weight': 'fontWeight', 'font-style': 'fontStyle', 'letter-spacing': 'letterSpacing',
  'text-anchor': 'textAnchor', 'stop-color': 'stopColor', 'flood-color': 'floodColor',
  'preserveAspectRatio': 'preserveAspectRatio', 'xml:space': 'xmlSpace',
};
const svgAttr = (k: string) => MAP[k] ?? k;
