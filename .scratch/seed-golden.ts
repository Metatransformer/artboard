import { writeFileSync } from 'node:fs';
import { TEMPLATES } from '../packages/templates/src/index';
import { loadDocument } from '../packages/schema/src/index';

let n = 0;
for (const t of TEMPLATES as any[]) {
  const built = t.build();
  const doc = loadDocument({
    version: 1, id: `doc-${t.id}`, name: t.name,
    artboards: [{ id: `ab-${t.id}`, name: t.name, width: built.width, height: built.height,
      background: built.background, nodes: built.nodes }],
    assets: {}, diagnostics: [],
  }).doc;
  writeFileSync(`tests/golden/${t.id}.json`, JSON.stringify(doc, null, 2));
  n++;
}
console.log(`wrote ${n} golden fixtures`);
