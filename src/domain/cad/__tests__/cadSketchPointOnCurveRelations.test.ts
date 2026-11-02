import { describe, expect, it } from 'vitest';
import { checkCadSketchGraph, parseCadSketchGraph, type CadSketchGraph, type CadSketchGraphRelation } from '../cadSketchGraph';
import { cadSketchRelationEntityIds, cadSketchRelationPointIds, mapCadSketchRelationScalars } from '../cadSketchGraphReferences';
import { deleteCadSketchElements } from '../cadSketchGraphEdits';
import { prepareCadSketchTrim, trimCadSketchEntity } from '../cadSketchTrimExtend';
import { splitCadSketchEntity } from '../cadSketchSplit';

const onArc = { id: 'on-arc', kind: 'point-on-curve', pointId: 'p', curveId: 'arc' } as const;
const onRing = { id: 'on-ring', kind: 'point-on-curve', pointId: 'q', curveId: 'ring' } as const;
/** A quarter arc of radius 10 about the origin, a ring about (30, 0) of radius `r` unless given, and a free point beside each. */
function curves(relations: readonly CadSketchGraphRelation[] = [], p: readonly [number, number] = [6, 8], radius: number | string = 'r'): CadSketchGraph {
  return parseCadSketchGraph({ points: [{ id: 'o', position: [0, 0] }, { id: 's', position: [10, 0] }, { id: 'e', position: [0, 10] },
    { id: 'c', position: [30, 0] }, { id: 'p', position: p }, { id: 'q', position: [30, 5] }], entities: [
    { id: 'arc', kind: 'arc', construction: false, centerPointId: 'o', startPointId: 's', endPointId: 'e', direction: 'ccw' },
    { id: 'ring', kind: 'circle', construction: true, centerPointId: 'c', radius },
    { id: 'guide', kind: 'line', construction: true, startPointId: 'o', endPointId: 'c' }], relations });
}

describe('point on an arc or circle', () => {
  it('rejects missing or non-curve operands, the curve center and arc endpoints and their declared aliases', () => {
    expect(curves([onArc, onRing]).relations).toEqual([onArc, onRing]);
    for (const relation of [{ ...onArc, value: 1 }, { ...onArc, pointId: 'missing' }, { ...onArc, curveId: 'missing' }, { ...onArc, curveId: 'guide' },
      { ...onArc, pointId: 'o' }, { ...onArc, pointId: 's' }, { ...onArc, pointId: 'e' }, { ...onRing, pointId: 'c' }])
      expect(() => curves([relation as CadSketchGraphRelation])).toThrow();
    // A declared joint makes the point the arc's end, though a far-off equal coordinate alone does not.
    expect(() => curves([{ id: 'joint', kind: 'coincident', pointIds: ['p', 'e'] }, onArc])).toThrow(/distinct/);
    expect(() => curves([{ id: 'joint', kind: 'coincident', pointIds: ['q', 'c'] }, onRing])).toThrow(/distinct/);
    expect(curves([onArc], [0, 10]).relations).toEqual([onArc]);
  });

  it('measures the radial distance from the full supporting circle, beyond the arc span', () => {
    // (-8, -6) lies on the arc's circle but outside its quarter span.
    expect(checkCadSketchGraph(curves([onArc, onRing], [-8, -6]), { r: 5 })).toEqual([]);
    expect(checkCadSketchGraph(curves([onArc]), { r: 5 })).toEqual([]);
    expect(checkCadSketchGraph(curves([onArc], [6, 9]), { r: 5 })).toEqual([expect.objectContaining({ source: { kind: 'relation', id: 'on-arc' },
      code: 'relation-residual', residualMm: expect.closeTo(Math.hypot(6, 9) - 10, 12) })]);
    expect(checkCadSketchGraph(curves([onRing]), { r: 6 })).toEqual([expect.objectContaining({ source: { kind: 'relation', id: 'on-ring' },
      code: 'relation-residual', residualMm: expect.closeTo(1, 12) })]);
  });

  it('reports its operands through the shared reference visitors, protects the curve on delete and follows its circle through split', () => {
    const graph = curves([onArc, onRing]);
    expect(cadSketchRelationEntityIds(onArc)).toEqual(['arc']);
    expect(cadSketchRelationPointIds(graph, onArc)).toEqual(['p', 'o', 's', 'e']);
    expect(cadSketchRelationPointIds(graph, onRing)).toEqual(['q', 'c']);
    expect(mapCadSketchRelationScalars(onArc, () => { throw new Error('No scalar'); })).toBe(onArc);
    const sketch = { id: 'sketch', kind: 'sketch', name: 'Curves', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph } as const;
    expect(() => deleteCadSketchElements({ sketch, pointIds: [], entityIds: ['ring'], relationIds: [], cascade: false })).toThrow();
    expect(deleteCadSketchElements({ sketch, pointIds: [], entityIds: ['ring'], relationIds: [], cascade: true }).graph?.relations).toEqual([onArc]);
    expect(deleteCadSketchElements({ sketch, pointIds: ['p'], entityIds: [], relationIds: [], cascade: true }).graph?.relations).toEqual([onRing]);
    // Both pieces lie on the one circle the point is held to, so it stays with the piece keeping the arc's id.
    expect(splitCadSketchEntity({ graph, parameters: { r: 5 }, split: { kind: 'arc', entityId: 'arc', parameter: .5,
      splitPointId: 'cut', newEntityId: 'after' } }).graph.relations).toEqual([onArc, onRing]);
  });
});

describe('Trim with points held on curves', () => {
  it('keeps the point on the arc that retains its identity after a middle trim, and on the arc a trimmed circle leaves', () => {
    // Two radial fences cross the quarter arc at 30° and 60°; a chord crosses the ring.
    const at = (degrees: number, radius: number) => [radius * Math.cos(degrees * Math.PI / 180), radius * Math.sin(degrees * Math.PI / 180)];
    const source = curves([onArc, onRing], [-8, -6], 5);
    const graph = parseCadSketchGraph({ ...source, points: [...source.points, { id: 'f0', position: at(30, 5) }, { id: 'f1', position: at(30, 15) },
      { id: 'g0', position: at(60, 5) }, { id: 'g1', position: at(60, 15) }, { id: 'h0', position: [27, -10] }, { id: 'h1', position: [27, 10] }],
    entities: [...source.entities, { id: 'fence', kind: 'line', construction: true, startPointId: 'f0', endPointId: 'f1' },
      { id: 'gate', kind: 'line', construction: true, startPointId: 'g0', endPointId: 'g1' },
      { id: 'chord', kind: 'line', construction: false, startPointId: 'h0', endPointId: 'h1' }] });
    const middle = prepareCadSketchTrim({ graph, parameters: { r: 5 }, entityId: 'arc', parameter: .5 });
    if (middle.target.kind !== 'middle') throw new Error('Expected middle trim.');
    expect(middle.target.removedRelationIds).toBeUndefined();
    const split = trimCadSketchEntity({ graph, parameters: { r: 5 }, trim: { ...middle.target, cutPointIds: ['m0', 'm1'], newEntityId: 'after', supportRelationId: 'support' } }).graph;
    expect(split.relations).toContainEqual(onArc);
    expect(checkCadSketchGraph(split, { r: 5 })).toEqual([]);
    const ring = prepareCadSketchTrim({ graph, parameters: { r: 5 }, entityId: 'ring', parameter: .25 });
    if (ring.target.kind !== 'circle') throw new Error('Expected circle trim.');
    const opened = trimCadSketchEntity({ graph, parameters: { r: 5 }, trim: { ...ring.target, cutPointIds: ['k0', 'k1'] } }).graph;
    expect(opened.entities.find(entity => entity.id === 'ring')?.kind).toBe('arc');
    expect(opened.relations).toContainEqual(onRing);
    expect(checkCadSketchGraph(opened, { r: 5 })).toEqual([]);
  });

  it('removes a point-on relation whose point becomes the trimmed edge end at an existing-endpoint cut', () => {
    // A spur ends on each edge, held there by its own relation; trimming to that end makes the point the edge's endpoint.
    const graph = parseCadSketchGraph({ points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [20, 0] }, { id: 's0', position: [10, -5] },
      { id: 's1', position: [10, 0] }, { id: 'o', position: [40, 0] }, { id: 'n', position: [50, 0] }, { id: 'w', position: [30, 0] },
      { id: 't0', position: [40, 15] }, { id: 't1', position: [40, 10] }], entities: [
      { id: 'edge', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' },
      { id: 'spur', kind: 'line', construction: true, startPointId: 's0', endPointId: 's1' },
      { id: 'bow', kind: 'arc', construction: false, centerPointId: 'o', startPointId: 'n', endPointId: 'w', direction: 'ccw' },
      { id: 'stub', kind: 'line', construction: true, startPointId: 't0', endPointId: 't1' }], relations: [
      { id: 'on-edge', kind: 'point-on-line', pointId: 's1', lineId: 'edge' }, { id: 'on-bow', kind: 'point-on-curve', pointId: 't1', curveId: 'bow' }] });
    const line = prepareCadSketchTrim({ graph, parameters: {}, entityId: 'edge', parameter: .1 });
    if (line.target.kind !== 'end' || !('attachment' in line)) throw new Error('Expected end trim.');
    expect(line.target).toMatchObject({ boundary: { endpointPointId: 's1' }, removedRelationIds: ['on-edge'] });
    expect(line.attachment).toBeNull();
    const trimmedLine = trimCadSketchEntity({ graph, parameters: {}, trim: { ...line.target, cutPointId: 's1' } }).graph;
    expect(trimmedLine.relations).toEqual([graph.relations[1]]);
    expect(checkCadSketchGraph(trimmedLine, {})).toEqual([]);
    const arc = prepareCadSketchTrim({ graph, parameters: {}, entityId: 'bow', parameter: .25 });
    if (arc.target.kind !== 'end') throw new Error('Expected end trim.');
    expect(arc.target).toMatchObject({ boundary: { endpointPointId: 't1' }, removedRelationIds: ['on-bow'] });
    const trimmedArc = trimCadSketchEntity({ graph, parameters: {}, trim: { ...arc.target, cutPointId: 't1' } }).graph;
    expect(trimmedArc.relations).toEqual([graph.relations[0]]);
    expect(checkCadSketchGraph(trimmedArc, {})).toEqual([]);
  });
});
