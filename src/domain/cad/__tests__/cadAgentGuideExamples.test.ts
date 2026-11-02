import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CadSketchFeature } from '../cadDocument';
import { applyCadEdits, type CadEdit } from '../cadOperations';
import { createCadDocument, parseCadDocument } from '../cadSchema';
import { storedCadDocument } from '../cadStoredDocument';
import { refuseNewCadSketchProfiles } from '../sketch-generators/cadSketchProfileViews';

// Agents copy the public guide's edit batches as written, so they must apply to a fresh draft as written.
const guide = readFileSync(new URL('../../../../docs/site/agents.md', import.meta.url), 'utf8');
/** The first JSON block after `lead` in the guide. */
const example = (lead: string): CadEdit[] => {
  const start = guide.indexOf(lead);
  if (start < 0) throw new Error(`The guide no longer says: ${lead}`);
  const block = /```json\n([\s\S]*?)\n```/.exec(guide.slice(start));
  if (!block) throw new Error(`No JSON example follows: ${lead}`);
  return JSON.parse(block[1]) as CadEdit[];
};
const apply = (document: ReturnType<typeof parseCadDocument>, edits: readonly CadEdit[]) => { refuseNewCadSketchProfiles(document, edits); return applyCadEdits(document, edits); };

describe('the agent guide examples', () => {
  it('build the plate from generators, then resize it through a parameter and the bore through its input', () => {
    const blank = parseCadDocument({ ...createCadDocument('Part', 'part'), schemaVersion: 2 });
    const plate = apply(blank, example('After creating a document, `cad_edit_document` accepts this example `edits` array'));
    const edited = apply(plate, example('For the plate example above, send this `edits` array'));
    const sketch = storedCadDocument(edited).features[0] as CadSketchFeature;
    expect(edited.parameters).toMatchObject({ width: 72, thickness: 10 });
    expect(sketch.profiles).toEqual([]);
    expect(sketch.graph?.relations).toMatchObject([
      { id: 'plate', kind: 'generator', geometry: { kind: 'rectangle', width: 'width' } },
      { id: 'hole', kind: 'generator', geometry: { kind: 'circle', x: 'width / 2', y: 18, radius: 6 } }]);
  });
});
