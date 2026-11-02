// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createCadDocument, parseCadDocument } from '@/domain/cad/cadSchema';
import { parseCadSketchGraph, type CadSketchGraph } from '@/domain/cad/cadSketchGraph';
import { prepareCadSketchExtend, extendCadSketchEntity } from '@/domain/cad/cadSketchTrimExtend';
import { prepareCadEdits } from './cadEditPreparation';
import { arcExtendPart, arcExtendTarget } from '@/domain/cad/__tests__/cadSketchArcExtendFixtures';
import { CadSession } from './cadSession';
import { createCadSketchTestSolver } from './sketch-solver/__tests__/cadSketchTestSolver';

const runtime = createCadSketchTestSolver();

async function prepared(graph: CadSketchGraph, entityId: string, parameters: Readonly<Record<string, number>>, endPointId: string) {
  const document = parseCadDocument({ ...createCadDocument('Line extension', 'line-extension'), schemaVersion: 2, parameters,
    features: [{ id: 'sketch', name: 'Lines', kind: 'sketch', plane: 'XY', offset: 0, suppressed: false, profiles: [], graph }] });
  const before = JSON.stringify(document), preview = prepareCadSketchExtend({ graph, parameters, entityId, end: 'end' });
  const extend = { ...preview.target, endPointId }, expected = extendCadSketchEntity({ graph, parameters, extend });
  const result = await prepareCadEdits(document, [{ kind: 'extend-sketch-entity', sketchId: 'sketch', extend }], runtime);
  const sketch = result.document.features[0];
  if (sketch.kind !== 'sketch') throw new Error('Expected the same sketch.');
  expect(sketch.graph).toEqual(expected.graph); expect(result.document.parameters).toEqual(parameters);
  expect(result.sketchDiagnostics).toMatchObject([{ sketchId: 'sketch', diagnostics: {
    status: 'success', conflictingIds: [], redundantIds: [], partiallyRedundantIds: [], issues: []
  } }]);
  expect(JSON.stringify(document)).toBe(before);
  return result;
}

describe('exact line Extend preparation', () => {
  it('preserves a diameter owner through start-side arc extension while its native radius spoke changes endpoint', async () => {
    const base = arcExtendPart(), source = base.features[0];
    if (source.kind !== 'sketch' || !source.graph) throw new Error('Arc source missing.');
    const document = parseCadDocument({ ...base, parameters: { stockRadius: 10 }, features: [{ ...source, graph: { ...source.graph,
      points: source.graph.points.map(point => point.id === 'a' ? { ...point, position: [10, 0] }
        : point.id === 'b' ? { ...point, position: [' 0 ', 10] } : point.id === 'c' ? { ...point, position: [6, -8] } : point),
      entities: source.graph.entities.map(entity => entity.id === 'closure' && entity.kind === 'line' ? { ...entity, endPointId: 'b' } : entity),
      relations: [{ id: 'diameter', kind: 'radial-size', entityId: 'arc', quantity: 'diameter', value: ' 2 * stockRadius ' }] } }] });
    const owned = document.features[0]; if (owned.kind !== 'sketch' || !owned.graph) throw new Error('Owned arc missing.');
    const original = JSON.stringify(document), preview = prepareCadSketchExtend({ graph: owned.graph, parameters: document.parameters, entityId: 'arc', end: 'start' });
    expect(preview.target.boundary.endpointPointId).toBe('c');
    const extend = { ...preview.target, endPointId: 'c' }, expected = extendCadSketchEntity({ graph: owned.graph, parameters: document.parameters, extend });
    const prepared = await prepareCadEdits(document, [{ kind: 'extend-sketch-entity', sketchId: 'sketch', extend }], runtime);
    expect(prepared.document).toEqual({ ...document, features: [{ ...owned, graph: expected.graph }] });
    expect(expected.graph.points).toEqual(owned.graph.points); expect(expected.graph.relations).toEqual(owned.graph.relations);
    expect(expected.graph.entities).toEqual(owned.graph.entities.map(entity => entity.id === 'arc' ? { ...entity, startPointId: 'c' } : entity));
    expect(prepared.sketchDiagnostics[0].diagnostics).toEqual({ status: 'success', degreesOfFreedom: 3,
      conflictingIds: [], redundantIds: [], partiallyRedundantIds: [], issues: [] });
    expect(JSON.stringify(document)).toBe(original);
  });

  it.each([false, true])('preserves the complete arc Extend candidate with numeric interior contact=%s', async interior => {
    const document = arcExtendPart(interior), source = document.features[0];
    if (source.kind !== 'sketch' || !source.graph) throw new Error('Arc extension source missing.');
    const original = JSON.stringify(document), extend = arcExtendTarget(document);
    expect(extend.kind).toBe('arc'); expect(extend.endPointId).toBe(interior ? 'contact' : 'c');
    const expected = extendCadSketchEntity({ graph: source.graph, parameters: document.parameters, extend });
    const prepared = await prepareCadEdits(document, [{ kind: 'extend-sketch-entity', sketchId: 'sketch', extend }], runtime);
    expect(prepared.document).toEqual({ ...document, features: [{ ...source, graph: expected.graph }] });
    expect(expected.graph.points.slice(0, source.graph.points.length)).toEqual(source.graph.points);
    expect(expected.graph.points.slice(source.graph.points.length)).toEqual(interior ? [{ id: 'contact', position: [-6, 8] }] : []);
    expect(expected.graph.entities).toEqual(source.graph.entities.map(entity => entity.id === 'arc' ? { ...entity, endPointId: extend.endPointId } : entity));
    expect(expected.graph.relations).toEqual(source.graph.relations);
    expect(prepared.sketchDiagnostics[0].diagnostics).toEqual({ status: 'success', degreesOfFreedom: 3,
      conflictingIds: [], redundantIds: [], partiallyRedundantIds: [], issues: [] });
    expect(JSON.stringify(document)).toBe(original);
  });

  it('rejects an arc Extend detaching exact endpoint drivers without committing a preceding parameter intent', async () => {
    const original = arcExtendPart(), sketch = original.features[0];
    if (sketch.kind !== 'sketch' || !sketch.graph) throw new Error('Arc extension source missing.');
    // Without the divider the arc's old end leaves with the extension, and so would the expression placing it.
    const extend = arcExtendTarget(original), document = parseCadDocument({ ...original, features: [{ ...sketch, graph: { ...sketch.graph,
      points: sketch.graph.points.map(point => point.id === 'b' ? { ...point, position: ['0.000', 10] } : point),
      entities: sketch.graph.entities.filter(entity => entity.id !== 'divider') } }] });
    const session = new CadSession(document), before = session.getSnapshot();
    await expect(session.editPrepared(before.version, async accepted => (await prepareCadEdits(accepted, [
      { kind: 'set-parameter', name: 'retained', value: 99 }, { kind: 'extend-sketch-entity', sketchId: 'sketch', extend }
    ], runtime)).document)).rejects.toMatchObject({ code: 'dependent-sketch-extend', relationIds: [], pointIds: ['b'] });
    expect(session.getSnapshot()).toBe(before); expect(session.getSnapshot().document.parameters).toEqual({ retained: 7 });
  });

  it('preserves a numeric intersection endpoint and every untouched source component exactly', async () => {
    const graph = parseCadSketchGraph({ points: [{ id: 'a', position: [' origin ', 0] }, { id: 'b', position: [10, 0] },
      { id: 'c', position: [20, -5] }, { id: 'd', position: [20, 5] }], entities: [
      { id: 'edge', kind: 'line', startPointId: 'a', endPointId: 'b', construction: false },
      { id: 'boundary', kind: 'line', startPointId: 'c', endPointId: 'd', construction: true }], relations: [] });
    const result = await prepared(graph, 'edge', { origin: 0 }, 'm');
    expect(result.sketchDiagnostics[0].diagnostics.degreesOfFreedom).toBe(7);
  });

  it('preserves exact endpoint attachment and accepted drivers while closing the intended contour', async () => {
    const graph = parseCadSketchGraph({ points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [5, 0] },
      { id: 'c', position: [' width ', ' 0 '] }, { id: 'd', position: [10, 10] }, { id: 'e', position: [0, 10] }], entities: [
      { id: 'bottom', kind: 'line', startPointId: 'a', endPointId: 'b', construction: false },
      { id: 'right', kind: 'line', startPointId: 'c', endPointId: 'd', construction: false },
      { id: 'top', kind: 'line', startPointId: 'd', endPointId: 'e', construction: false },
      { id: 'left', kind: 'line', startPointId: 'e', endPointId: 'a', construction: false }], relations: [] });
    const result = await prepared(graph, 'bottom', { width: 10 }, 'c');
    expect(result.sketchDiagnostics[0].diagnostics.degreesOfFreedom).toBe(6);
  });
});
