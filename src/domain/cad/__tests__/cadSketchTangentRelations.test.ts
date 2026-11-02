import { describe, expect, it } from 'vitest';
import { checkCadSketchGraph, parseCadSketchGraph } from '../cadSketchGraph';
import { cadSketchRelationEntityIds, cadSketchRelationPointIds, mapCadSketchRelationScalars } from '../cadSketchGraphReferences';
import { tangentJoint, tangentPart, tangentSketch } from './cadSketchTangentFixtures';
import { CadSketchTangentOwnershipError, resolveCadSketchTangentJoint } from '../cadSketchTangentRelations';
import { deleteCadSketchElements } from '../cadSketchGraphEdits';
import { splitCadSketchEntity } from '../cadSketchSplit';
import { createCadSketchCornerTreatment } from '../cadSketchCornerTreatment';
import { resolveCadSketchCornerTopology } from '../cadSketchCornerGeometry';
import { applyCadEdits } from '../cadOperations';
import { circleRow, circleRowPart, rowSketch } from './cadSketchLinearPatternFixtures';

describe('declared line–arc tangent joints', () => {
  it('preserves exact tuple ownership and accepts only actual endpoints with a declared common identity', () => {
    const source = tangentSketch(tangentPart()).graph;
    const graph = parseCadSketchGraph({ ...source, relations: [...source.relations, tangentJoint] });
    expect(graph.relations.at(-1)).toEqual(tangentJoint);
    expect(checkCadSketchGraph(graph, { bendRadius: 5 })).toEqual([]);
    expect(cadSketchRelationEntityIds(tangentJoint)).toEqual(['line', 'arc']);
    expect(cadSketchRelationPointIds(graph, tangentJoint)).toEqual(['a', 'j', 'c', 'e']);
    expect(mapCadSketchRelationScalars(tangentJoint, () => { throw new Error('No scalar'); })).toBe(tangentJoint);
    const reversed = { ...tangentJoint, endpoints: [tangentJoint.endpoints[1], tangentJoint.endpoints[0]] };
    expect(parseCadSketchGraph({ ...graph, relations: [...source.relations, reversed] }).relations.at(-1)).toEqual(reversed);
    for (const endpoints of [
      [{ entityId: 'line', pointId: 'a' }, { entityId: 'arc', pointId: 'j' }],
      [{ entityId: 'line', pointId: 'c' }, { entityId: 'arc', pointId: 'j' }],
      [{ entityId: 'line', pointId: 'j' }, { entityId: 'arc', pointId: 'c' }],
      [{ entityId: 'line', pointId: 'j' }, { entityId: 'missing', pointId: 'j' }],
      [{ entityId: 'line', pointId: 'j' }, { entityId: 'line', pointId: 'j' }]
    ]) expect(() => parseCadSketchGraph({ ...source, relations: [{ ...tangentJoint, endpoints }] })).toThrow();
    expect(() => parseCadSketchGraph({ ...source, relations: [{ ...tangentJoint, value: 0 }] })).toThrow();
    const alias = { ...source, points: [...source.points, { id: 'alias', position: ['0', '0'] }], entities: source.entities.map(entity =>
      entity.kind === 'arc' ? { ...entity, startPointId: 'alias' } : entity) };
    const aliased = { ...tangentJoint, endpoints: [tangentJoint.endpoints[0], { entityId: 'arc', pointId: 'alias' }] };
    expect(() => parseCadSketchGraph({ ...alias, relations: [aliased] })).toThrow();
    const joined = parseCadSketchGraph({ ...alias, relations: [{ id: 'join', kind: 'coincident', pointIds: ['alias', 'j'] }, aliased] });
    expect(checkCadSketchGraph(joined, { bendRadius: 5 })).toEqual([]);
    expect(joined.points).toEqual(alias.points);
    expect(() => parseCadSketchGraph({ ...joined, relations: [aliased] })).toThrow();
    expect(() => parseCadSketchGraph({ ...graph, relations: [...graph.relations, { id: 'collapse', kind: 'coincident', pointIds: ['a', 'j'] }] })).toThrow();
    const circle = { id: 'circle', kind: 'circle', construction: true, centerPointId: 'c', radius: 5 };
    expect(() => parseCadSketchGraph({ ...source, entities: [...source.entities, circle], relations: [{ ...tangentJoint,
      endpoints: [tangentJoint.endpoints[0], { entityId: 'circle', pointId: 'c' }] }] })).toThrow();
    expect(() => parseCadSketchGraph({ ...source, relations: [{ ...tangentJoint, endpoints: [tangentJoint.endpoints[1], tangentJoint.endpoints[1]] }] })).toThrow();
  });
  it('checks the outward side for start/end, CW/CCW and major coverage without imposing a minor branch', () => {
    const source = tangentSketch(tangentPart()).graph;
    for (const direction of ['cw', 'ccw'] as const) for (const jointStart of [false, true]) {
      const sign = (direction === 'ccw' ? 1 : -1) * (jointStart ? 1 : -1);
      const graph = parseCadSketchGraph({ ...source, points: [
        { id: 'a', position: [-10 * sign, 0] }, { id: 'j', position: [0, 0] },
        { id: 'c', position: [0, 5] }, { id: 'e', position: [5, 5] }
      ], entities: source.entities.map(entity => entity.kind === 'arc' ? { ...entity, direction,
        startPointId: jointStart ? 'j' : 'e', endPointId: jointStart ? 'e' : 'j' } : entity), relations: [tangentJoint] });
      expect(checkCadSketchGraph(graph, {})).toEqual([]);
      const reversedLine = parseCadSketchGraph({ ...graph, entities: graph.entities.map(entity => entity.kind === 'line'
        ? { ...entity, startPointId: entity.endPointId, endPointId: entity.startPointId } : entity) });
      expect(checkCadSketchGraph(reversedLine, {})).toEqual([]);
      const cusp = parseCadSketchGraph({ ...graph, points: graph.points.map(point => point.id === 'a' ? { ...point, position: [10 * sign, 0] } : point) });
      expect(checkCadSketchGraph(cusp, {})).toContainEqual(expect.objectContaining({ source: { kind: 'relation', id: 'tangent' }, code: 'relation-residual' }));
    }
  });
  it('keeps strict structural radius and complete coincident-class checks separate from driver tolerance', () => {
    const source = tangentSketch(tangentPart()).graph;
    const graph = parseCadSketchGraph({ ...source, relations: [tangentJoint] });
    const radiusMismatch = parseCadSketchGraph({ ...graph, points: graph.points.map(point => point.id === 'e' ? { ...point, position: [5 + 2e-11, 5] } : point) });
    expect(checkCadSketchGraph(radiusMismatch, { bendRadius: 5 })).toContainEqual(expect.objectContaining({ source: { kind: 'entity', id: 'arc' }, code: 'arc-radius-mismatch' }));
    const chain = parseCadSketchGraph({ ...graph, points: [...graph.points, { id: 'alias1', position: [8e-13, 0] }, { id: 'alias2', position: [1.6e-12, 0] }],
      relations: [tangentJoint, { id: 'one', kind: 'coincident', pointIds: ['j', 'alias1'] }, { id: 'two', kind: 'coincident', pointIds: ['alias1', 'alias2'] }] });
    expect(checkCadSketchGraph(chain, { bendRadius: 5 })).toContainEqual(expect.objectContaining({ source: { kind: 'relation', id: 'tangent' }, code: 'relation-residual' }));
  });
  it('checks oblique normalized tangents and enforces angular and physical deflection limits independently', () => {
    const source = tangentSketch(tangentPart()).graph;
    const oblique = parseCadSketchGraph({ ...source, points: [
      { id: 'a', position: [-6, -8] }, { id: 'j', position: [0, 0] },
      { id: 'c', position: [-4, 3] }, { id: 'e', position: [-1, 7] }
    ], relations: [tangentJoint] });
    expect(checkCadSketchGraph(oblique, {})).toEqual([]);
    const lineAt = (x: number, y: number) => parseCadSketchGraph({ ...source, points: source.points.map(point => point.id === 'a' ? { ...point, position: [x, y] } : point), relations: [tangentJoint] });
    expect(checkCadSketchGraph(lineAt(-10, 5e-12), { bendRadius: 5 })).toEqual([]);
    expect(checkCadSketchGraph(lineAt(-10, 2e-11), { bendRadius: 5 })).toContainEqual(expect.objectContaining({ source: { kind: 'relation', id: 'tangent' } }));
    expect(checkCadSketchGraph(lineAt(-1000, 5e-10), { bendRadius: 5 })).toContainEqual(expect.objectContaining({ source: { kind: 'relation', id: 'tangent' } }));
    // Far from the origin the angular allowance grows with roundoff, but supports a few roundoff steps long never pass as tangent.
    const o = 9e8, s = 2 ** -22, tiny = parseCadSketchGraph({ ...source, points: [{ id: 'a', position: [o - s, o + s] }, { id: 'j', position: [o, o] },
      { id: 'c', position: [o, o + s] }, { id: 'e', position: [o + s, o + s] }], relations: [tangentJoint] });
    expect(checkCadSketchGraph(tiny, {})).toContainEqual(expect.objectContaining({ source: { kind: 'relation', id: 'tangent' } }));
  });
  it('protects both entities and every support point in deletion, surgery and generated-pattern ownership', () => {
    const source = tangentSketch(tangentPart()), sketch = { ...source, graph: parseCadSketchGraph({ ...source.graph, relations: [tangentJoint] }) };
    for (const entityId of ['line', 'arc']) expect(() => deleteCadSketchElements({ sketch, pointIds: [], entityIds: [entityId], relationIds: [], cascade: false })).toThrow();
    expect(() => deleteCadSketchElements({ sketch, pointIds: ['c'], entityIds: [], relationIds: [], cascade: false })).toThrow();
    expect(deleteCadSketchElements({ sketch, pointIds: [], entityIds: ['line'], relationIds: [], cascade: true }).graph?.relations).toEqual([]);
    // The joint is at the arc's start, which the piece keeping the arc's id still holds.
    expect(splitCadSketchEntity({ graph: sketch.graph, parameters: { bendRadius: 5 }, split: { kind: 'arc', entityId: 'arc', parameter: .5,
      splitPointId: 'cut', newEntityId: 'after' } }).graph.relations).toEqual([tangentJoint]);
    const row = rowSketch(applyCadEdits(circleRowPart(), [{ kind: 'set-sketch-relation', sketchId: 'sketch', relation: circleRow }]));
    // Even an arc CENTER is an owned support, not just the named contact endpoint.
    expect(() => parseCadSketchGraph({ ...row.graph, points: [...row.graph.points, { id: 'a', position: [15, 0] }, { id: 'j', position: [25, 0] }, { id: 'e', position: [35, 10] }],
      entities: [...row.graph.entities, ...source.graph.entities.map(entity => entity.kind === 'arc' ? { ...entity, centerPointId: 'holes_i1_p0' } : entity)],
      relations: [...row.graph.relations, tangentJoint] })).toThrow(/pattern/i);
  });
  it('rejects only the actual fillet-owned line/arc trim joint with the real owner identity', () => {
    let next = 0;
    const corner = createCadSketchCornerTreatment({ graph: parseCadSketchGraph({ points: [
      { id: 'v', position: [0, 0] }, { id: 'x', position: [20, 0] }, { id: 'y', position: [0, 20] }], entities: [
      { id: 'first', kind: 'line', startPointId: 'v', endPointId: 'x', construction: false },
      { id: 'second', kind: 'line', startPointId: 'v', endPointId: 'y', construction: false }], relations: [] }),
      parameters: {}, pointId: 'v', treatment: { kind: 'fillet', radius: 2 }, createId: () => `corner_${++next}` });
    const owner = corner.graph.relations.find(relation => relation.kind === 'fillet-corner');
    if (!owner || owner.kind !== 'fillet-corner') throw new Error('Missing fillet owner.');
    const topology = resolveCadSketchCornerTopology(corner.graph, owner), joint = topology.trimPointIds[0];
    const tangent = { ...tangentJoint, endpoints: [{ entityId: topology.lines[0].id, pointId: joint }, { entityId: owner.arcId, pointId: joint }] } as const;
    expect(() => parseCadSketchGraph({ ...corner.graph, relations: [...corner.graph.relations, tangent] })).toThrow(CadSketchTangentOwnershipError);
    expect(() => resolveCadSketchTangentJoint(corner.graph, tangent)).toThrowError(expect.objectContaining({ ownerRelationId: owner.id }));
    const released = parseCadSketchGraph({ ...corner.graph, relations: [tangent] });
    expect(checkCadSketchGraph(released, {})).toEqual([]);
  });
});
