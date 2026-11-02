import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { reconcileCadSketchLinearPattern } from '../cadSketchLinearPattern';
import { prepareCadSketchMirror } from '../cadSketchMirror';
import { prepareCadSketchOffset } from '../cadSketchOffset';
import { prepareCadSketchProfileCopy } from '../cadSketchProfileCopy';
import { splitCadSketchEntity } from '../cadSketchSplit';
import { extendCadSketchEntity, prepareCadSketchExtend, prepareCadSketchTrim, trimCadSketchEntity } from '../cadSketchTrimExtend';
import { REMAP_PARITY_DIFFERENCES } from './cadSketchRelationRemapParityDifferences';

// Replays every trim, extend, split, mirror, offset, profile copy and pattern reconcile call the Vitest suite made before the shared remap
// rule replaced each operation's own relation handling (see scripts/record-sketch-relation-remap-parity.mjs and the manifest beside the
// fixture). Each outcome must be what it was, unless the differences list names the call with what it gives now and why.

interface ParityRecord { readonly operation: string; readonly input: any; readonly outcome: unknown }
const fixture = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/relation-remap-parity.json.gz', import.meta.url))).toString('utf8')) as { readonly records: readonly ParityRecord[] };

function describeError(error: unknown) {
  if (!(error instanceof Error)) return { thrown: String(error) };
  const e = error as Error & { code?: string; relationIds?: readonly string[]; pointIds?: readonly string[] };
  return { code: e.code ?? e.name, message: e.message, ...(e.relationIds ? { relationIds: [...e.relationIds] } : {}), ...(e.pointIds ? { pointIds: [...e.pointIds] } : {}) };
}
const graphOf = (graph: any) => graph ? { relations: graph.relations, points: graph.points.map((point: { id: string }) => point.id) } : null;
const operations: Record<string, (input: any) => unknown> = {
  'trim-prepare': input => ({ target: prepareCadSketchTrim(input).target }),
  'extend-prepare': input => ({ target: prepareCadSketchExtend(input).target }),
  trim: input => graphOf(trimCadSketchEntity(input).graph),
  extend: input => graphOf(extendCadSketchEntity(input).graph),
  split: input => graphOf(splitCadSketchEntity(input).graph),
  'pattern-reconcile': input => graphOf(reconcileCadSketchLinearPattern(input)),
  mirror: input => ({ graph: graphOf(prepareCadSketchMirror(input).sketch.graph) }),
  offset: input => ({ graph: graphOf(prepareCadSketchOffset(input).sketch.graph) }),
  'profile-copy': input => ({ graph: graphOf(prepareCadSketchProfileCopy(input).sketch.graph) })
};
function replay(record: ParityRecord): unknown {
  try { return JSON.parse(JSON.stringify({ ok: operations[record.operation](record.input) })); } catch (error) { return { error: describeError(error) }; }
}
/** A short, stable name for one record: its operation and the hash of its input. */
async function keyOf(record: ParityRecord): Promise<string> {
  const { createHash } = await import('node:crypto');
  return `${record.operation} ${createHash('sha256').update(JSON.stringify(record.input)).digest('hex').slice(0, 12)}`;
}

describe('relation remap parity with the recorded operations', () => {
  it('replays every recorded call with its recorded outcome, apart from the listed differences', async () => {
    expect(fixture.records.length).toBe(797);
    const differing: Record<string, unknown> = {};
    for (const record of fixture.records) {
      const now = replay(record);
      if (JSON.stringify(now) !== JSON.stringify(record.outcome)) differing[await keyOf(record)] = now;
    }
    const listed = Object.fromEntries(Object.entries(REMAP_PARITY_DIFFERENCES).map(([key, difference]) => [key, difference.now]));
    expect(differing).toEqual(listed);
  });
  it('gives each listed difference a reason', () => {
    for (const difference of Object.values(REMAP_PARITY_DIFFERENCES)) expect(difference.reason.length).toBeGreaterThan(20);
  });
});
