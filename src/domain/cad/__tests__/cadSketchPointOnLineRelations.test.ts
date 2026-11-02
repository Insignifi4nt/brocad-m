import { describe, expect, it } from 'vitest';
import { checkCadSketchGraph, parseCadSketchGraph } from '../cadSketchGraph';
import { resolveCadSketchPointOnLineOperands } from '../cadSketchPointOnLineRelations';
import { resolveCadSketchPointIdentities } from '../cadSketchGraphJoints';
import { cadSketchRelationEntityIds, cadSketchRelationPointIds, mapCadSketchRelationScalars } from '../cadSketchGraphReferences';
import { deleteCadSketchElements } from '../cadSketchGraphEdits';
import { splitCadSketchEntity } from '../cadSketchSplit';
import { applyCadEdits } from '../cadOperations';
import { circleRow, circleRowPart, rowSketch } from './cadSketchLinearPatternFixtures';
import { pointOnLineRelation, pointOnLinePart, pointOnLineSketch } from './cadSketchPointOnLineFixtures';

describe('infinite supporting-line incidence source', () => {
  it('rejects missing/kind-mismatched operands and direct/transitive endpoint aliases without inferring coordinate identity', () => {
    const source = pointOnLineSketch(pointOnLinePart()).graph, raw = { ...source, relations: [pointOnLineRelation] };
    for (const relation of [{ ...pointOnLineRelation, value: 1 }, { ...pointOnLineRelation, lineId: 'bore' },
      { ...pointOnLineRelation, pointId: 'missing' }, { ...pointOnLineRelation, pointId: 'a' }])
      expect(() => parseCadSketchGraph({ ...raw, relations: [relation] })).toThrow();
    for (const endpoint of ['a', 'b']) expect(() => parseCadSketchGraph({ ...raw, points: [...raw.points, { id: 'alias', position: [99, 99] }],
      relations: [...raw.relations, { id: 'one', kind: 'coincident', pointIds: ['p', 'alias'] }, { id: 'two', kind: 'coincident', pointIds: ['alias', endpoint] }] })).toThrow();
    expect(() => parseCadSketchGraph({ ...raw, relations: [...raw.relations, { id: 'collapse', kind: 'coincident', pointIds: ['a', 'b'] }] })).toThrow();
    const coincidentPosition = parseCadSketchGraph({ ...raw, points: raw.points.map(point => point.id === 'p' ? { ...point, position: [0, 0] } : point) });
    expect(resolveCadSketchPointOnLineOperands(coincidentPosition, pointOnLineRelation).point.id).toBe('p');
    expect(resolveCadSketchPointIdentities(coincidentPosition)('p')).toBe('p');
    expect(parseCadSketchGraph(raw).points).toEqual(source.points);
  });
  it('checks normalized physical distance to the infinite support, reversed endpoints and degenerate numeric guides', () => {
    const source = pointOnLineSketch(pointOnLinePart()).graph;
    const graph = parseCadSketchGraph({ ...source, points: source.points.map(point => point.id === 'p' ? { ...point, position: [80, 40] } : point), relations: [pointOnLineRelation] });
    expect(checkCadSketchGraph(graph, { height: 20 })).toEqual([]);
    const reversed = parseCadSketchGraph({ ...graph, entities: graph.entities.map(entity => entity.kind === 'line' ? { ...entity, startPointId: 'b', endPointId: 'a' } : entity) });
    expect(checkCadSketchGraph(reversed, { height: 20 })).toEqual([]);
    const invalid = parseCadSketchGraph({ ...graph, points: graph.points.map(point => point.id === 'p' ? { ...point, position: [80, 41] } : point) });
    expect(checkCadSketchGraph(invalid, { height: 20 })).toContainEqual(expect.objectContaining({ source: { kind: 'relation', id: 'on-guide' }, code: 'relation-residual' }));
    const collapsed = parseCadSketchGraph({ ...graph, points: graph.points.map(point => point.id === 'b' ? { ...point, position: ['0.000', '0'] } : point) });
    expect(checkCadSketchGraph(collapsed, { height: 20 })).toContainEqual(expect.objectContaining({ source: { kind: 'relation', id: 'on-guide' }, code: 'relation-residual' }));
    expect(cadSketchRelationEntityIds(pointOnLineRelation)).toEqual(['guide']);
    expect(cadSketchRelationPointIds(graph, pointOnLineRelation)).toEqual(['p', 'a', 'b']);
    expect(mapCadSketchRelationScalars(pointOnLineRelation, () => { throw new Error('No scalar'); })).toBe(pointOnLineRelation);
  });
  it('protects guide dependencies and pattern member ownership through the shared visitors', () => {
    const source = pointOnLineSketch(pointOnLinePart()), sketch = { ...source, graph: parseCadSketchGraph({ ...source.graph, relations: [pointOnLineRelation] }) };
    expect(() => deleteCadSketchElements({ sketch, pointIds: [], entityIds: ['guide'], relationIds: [], cascade: false })).toThrow();
    expect(deleteCadSketchElements({ sketch, pointIds: [], entityIds: ['guide'], relationIds: [], cascade: true }).graph?.relations).toEqual([]);
    // The point is held to the guide's whole support, which both pieces share, so it stays with the piece keeping the guide's id.
    const solved = parseCadSketchGraph({ ...sketch.graph, points: sketch.graph.points.map(point => point.id === 'p' ? { ...point, position: [10, 5] } : point) });
    expect(splitCadSketchEntity({ graph: solved, parameters: { height: 20 }, split: { kind: 'line', entityId: 'guide', parameter: .5,
      splitPointId: 'cut', newEntityId: 'after', supportRelationId: 'support' } }).graph.relations)
      .toEqual([pointOnLineRelation, { id: 'support', kind: 'parallel', lineIds: ['guide', 'after'] }]);
    const row = rowSketch(applyCadEdits(circleRowPart(), [{ kind: 'set-sketch-relation', sketchId: 'sketch', relation: circleRow }]));
    expect(() => parseCadSketchGraph({ ...row.graph, points: [...row.graph.points, { id: 'a', position: [0, 0] }, { id: 'b', position: [10, 0] }],
      entities: [...row.graph.entities, { id: 'guide', kind: 'line', construction: true, startPointId: 'a', endPointId: 'b' }],
      relations: [...row.graph.relations, { ...pointOnLineRelation, pointId: 'holes_i1_p0' }] })).toThrow(/pattern/i);
  });
});
