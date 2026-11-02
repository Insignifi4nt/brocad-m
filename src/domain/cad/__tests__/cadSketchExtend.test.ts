import { describe, expect, it } from 'vitest';
import { parseCadSketchGraph } from '../cadSketchGraph';
import { compileCadSketchGraph } from '../cadSketchGraphGeometry';
import { CadSketchExtendDependencyError, prepareCadSketchExtend, extendCadSketchEntity } from '../cadSketchTrimExtend';
import { cadAnalyticSegments } from '../cadAnalyticSegments';
import { signedAreaOfPath } from '@/domain/path-intel/segments';
import { createCadDocument, parseCadDocument } from '../cadSchema';
import { createCadSketchCornerTreatment } from '../cadSketchCornerTreatment';
import type { CadSketchGraph, CadSketchGraphRelation } from '../cadSketchGraph';

function source() {
  return parseCadSketchGraph({ points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [10, 0] },
    { id: 'c', position: [20, -5] }, { id: 'd', position: [20, 5] }, { id: 'e', position: [30, -5] }, { id: 'f', position: [30, 5] }], entities: [
    { id: 'edge', kind: 'line', startPointId: 'a', endPointId: 'b', construction: false },
    { id: 'near', kind: 'line', startPointId: 'c', endPointId: 'd', construction: true },
    { id: 'far', kind: 'line', startPointId: 'e', endPointId: 'f', construction: true }], relations: [] });
}

/** Extends drop the detached old end when nothing else uses it. */
const without = (points: readonly CadSketchGraph['points'][number][], ...ids: string[]) => points.filter(point => !ids.includes(point.id));

describe('exact line Extend', () => {
  it('transfers vertical endpoint intent while retaining Parallel/Perpendicular and an adjacent old-corner horizontal pair exactly', () => {
    const graph = parseCadSketchGraph({ points: [{ id: 'a', position: [' 0 ', '0'] }, { id: 'b', position: [0, 5] },
      { id: 'c', position: [' targetX ', ' height '] }, { id: 'd', position: [10, 10] }, { id: 'e', position: [10, 0] }, { id: 'f', position: [5, 5] }],
      entities: [{ id: 'edge', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' },
        { id: 'boundary', kind: 'line', construction: true, startPointId: 'c', endPointId: 'd' },
        { id: 'reference', kind: 'line', construction: true, startPointId: 'e', endPointId: 'd' },
        { id: 'adjacent', kind: 'line', construction: false, startPointId: 'b', endPointId: 'f' }], relations: [
        { id: 'vertical', kind: 'vertical', pointIds: ['b', 'a'] },
        { id: 'parallel', kind: 'parallel', lineIds: ['reference', 'edge'] },
        { id: 'perpendicular', kind: 'perpendicular', lineIds: ['edge', 'boundary'] },
        { id: 'old-corner', kind: 'horizontal', pointIds: ['f', 'b'] }] });
    const parameters = { targetX: 0, height: 10 }, before = JSON.stringify(graph);
    const preview = prepareCadSketchExtend({ graph, parameters, entityId: 'edge', end: 'end' });
    expect(preview.target.boundary.endpointPointId).toBe('c');
    const result = extendCadSketchEntity({ graph, parameters, extend: { ...preview.target, endPointId: 'c' } });
    expect(result.graph.relations).toEqual([{ id: 'vertical', kind: 'vertical', pointIds: ['c', 'a'] }, ...graph.relations.slice(1)]);
    expect(result.graph.points).toEqual(graph.points);
    expect(result.graph.entities).toEqual([{ ...graph.entities[0], endPointId: 'c' }, ...graph.entities.slice(1)]);
    expect(JSON.stringify(graph)).toBe(before);
  });

  it('keeps explicit point and attachment ownership blocked, and carries a ray, a shared-line level pair and a far corner along', () => {
    const original = source(), graph = parseCadSketchGraph({ ...original, points: [...original.points, { id: 'alias', position: [10, 0] }] });
    const owners: readonly CadSketchGraphRelation[] = [
      { id: 'fixed-axis', kind: 'fixed-axis', pointId: 'b', axis: 'y', value: ' 0 ' },
      { id: 'fixed-point', kind: 'fixed-point', pointId: 'b', position: [' 10 ', '0'] },
      { id: 'attachment', kind: 'coincident', pointIds: ['b', 'alias'] }
    ];
    for (const owner of owners) expect(() => prepareCadSketchExtend({ graph: parseCadSketchGraph({ ...graph, relations: [owner] }), parameters: {}, entityId: 'edge', end: 'end' }))
      .toThrowError(expect.objectContaining({ code: 'dependent-sketch-extend', relationIds: [owner.id] }));
    const extended = (driven: CadSketchGraph, entityId = 'edge') => {
      const { target } = prepareCadSketchExtend({ graph: driven, parameters: {}, entityId, end: 'end' });
      return extendCadSketchEntity({ graph: driven, parameters: {}, extend: { ...target, endPointId: 'm' } }).graph;
    };
    // A ray toward the old end points the same way from the new one, so it follows the end along the line.
    const angle = { id: 'angle', kind: 'line-angle', rays: [{ lineId: 'edge', towardPointId: 'b' }, { lineId: 'near', towardPointId: 'd' }], sense: 'ccw', value: ' 90 ' } as const;
    expect(extended(parseCadSketchGraph({ ...graph, relations: [angle] })).relations).toEqual([{ ...angle, rays: [{ lineId: 'edge', towardPointId: 'm' }, angle.rays[1]] }]);
    // Another line shares the level pair, so the pair is not this line's own direction: it stays on the points that line keeps.
    const duplicate = parseCadSketchGraph({ ...graph, entities: [...graph.entities,
      { id: 'other-line', kind: 'line', construction: true, startPointId: 'b', endPointId: 'a' }],
      relations: [{ id: 'direction', kind: 'horizontal', pointIds: ['a', 'b'] }] });
    expect(extended(duplicate).relations).toEqual(duplicate.relations);
    // A fillet at the line's other end stays where it is.
    let id = 0;
    const corner = createCadSketchCornerTreatment({ graph: parseCadSketchGraph({ points: [{ id: 'v', position: [0, 0] }, { id: 'a', position: [20, 0] },
      { id: 'b', position: [0, 20] }, { id: 's', position: [30, -5] }, { id: 't', position: [30, 5] }], entities: [
      { id: 'edge', kind: 'line', construction: false, startPointId: 'v', endPointId: 'a' },
      { id: 'other', kind: 'line', construction: false, startPointId: 'v', endPointId: 'b' },
      { id: 'stop', kind: 'line', construction: true, startPointId: 's', endPointId: 't' }], relations: [] }), parameters: {}, pointId: 'v',
      treatment: { kind: 'fillet', radius: 2 }, createId: () => `corner_${++id}` });
    expect(extended(corner.graph).relations).toEqual(corner.graph.relations);
  });

  it('rejects an out-of-range generated endpoint from a legal boundary instead of offering a malformed edit', () => {
    const document = parseCadDocument({ ...createCadDocument('Range', 'range'), schemaVersion: 2, features: [{
      id: 'sketch', name: 'Sketch', kind: 'sketch', plane: 'XY', offset: 0, suppressed: false, profiles: [], graph: {
        points: [{ id: 'a', position: [999999990, 0] }, { id: 'b', position: [999999995, 0] }, { id: 'o', position: [999999999, 0] }],
        entities: [{ id: 'line', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' },
          { id: 'circle', kind: 'circle', construction: true, centerPointId: 'o', radius: 20 }], relations: []
      }
    }] });
    const sketch = document.features[0]; if (sketch.kind !== 'sketch' || !sketch.graph) throw new Error('Expected accepted graph.');
    const graph = sketch.graph, before = JSON.stringify(document);
    expect(() => prepareCadSketchExtend({ graph, parameters: {}, entityId: 'line', end: 'end' }))
      .toThrowError(expect.objectContaining({ code: 'sketch-extend-precision' }));
    expect(JSON.stringify(document)).toBe(before);
  });

  it('keeps a nearer legal circle hit available when the farther unused root is beyond the coordinate range', () => {
    const graph = parseCadSketchGraph({ points: [{ id: 'a', position: [999999970, 0] }, { id: 'b', position: [999999975, 0] },
      { id: 'o', position: [999999999, 0] }], entities: [
      { id: 'line', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' },
      { id: 'circle', kind: 'circle', construction: true, centerPointId: 'o', radius: 20 }], relations: [] });
    const preview = prepareCadSketchExtend({ graph, parameters: {}, entityId: 'line', end: 'end' });
    expect(preview.point).toEqual([999999979, 0]);
    expect(extendCadSketchEntity({ graph, parameters: {}, extend: { ...preview.target, endPointId: 'm' } }).graph.points.at(-1)?.position)
      .toEqual([999999979, 0]);
  });

  it('extends only the selected end to its nearest finite boundary, keeping source and cutter data but not the detached end', () => {
    const graph = source(), before = JSON.stringify(graph);
    const preview = prepareCadSketchExtend({ graph, parameters: {}, entityId: 'edge', end: 'end' });
    expect(preview.target).toEqual({ kind: 'line', entityId: 'edge', end: 'end',
      boundary: { entityId: 'near', index: 0, parameter: 2, position: [20, 0] } });
    expect(preview.added).toMatchObject({ kind: 'line', start: { x: 10, y: 0 }, end: { x: 20, y: 0 } });
    expect(preview.extended).toMatchObject({ kind: 'line', start: { x: 0, y: 0 }, end: { x: 20, y: 0 } });
    expect(preview.point).toEqual([20, 0]); expect(preview.boundary.id).toBe('near');
    const result = extendCadSketchEntity({ graph, parameters: {}, extend: { ...preview.target, endPointId: 'm' } });
    expect(result).toMatchObject({ retainedEntityId: 'edge', endPointId: 'm' });
    expect(result.graph.points).toEqual([...without(graph.points, 'b'), { id: 'm', position: [20, 0] }]);
    expect(result.graph.entities).toEqual([{ ...graph.entities[0], endPointId: 'm' }, ...graph.entities.slice(1)]);
    expect(result.graph.relations).toEqual([]);
    expect(compileCadSketchGraph(result.graph, {}).segments.find(segment => segment.id === 'edge')?.length).toBe(20);
    expect(JSON.stringify(graph)).toBe(before); expect(Object.isFrozen(preview.added.start)).toBe(true);
    expect(Object.isFrozen(result.graph.points.at(-1)?.position)).toBe(true);
  });

  it('selects the same physical nearest boundary after reversing source endpoints and reordering arrays', () => {
    const original = source(), graph = parseCadSketchGraph({ ...original, points: [...original.points].reverse(), entities: original.entities.map(entity =>
      entity.id === 'edge' && entity.kind === 'line' ? { ...entity, startPointId: 'b', endPointId: 'a' } : entity).reverse() });
    const preview = prepareCadSketchExtend({ graph, parameters: {}, entityId: 'edge', end: 'start' });
    expect(preview.target).toMatchObject({ end: 'start', boundary: { entityId: 'near', parameter: -1, position: [20, 0] } });
    expect(preview.added).toMatchObject({ start: { x: 20, y: 0 }, end: { x: 10, y: 0 } });
    const result = extendCadSketchEntity({ graph, parameters: {}, extend: { ...preview.target, endPointId: 'm' } });
    expect(result.graph.entities.find(entity => entity.id === 'edge')).toMatchObject({ startPointId: 'm', endPointId: 'a' });
    expect(without(result.graph.points, 'm')).toEqual(without(graph.points, 'b'));
  });

  it('uses actual circle/major-arc/minor-arc membership rather than the whole complementary support', () => {
    const graph = parseCadSketchGraph({ points: [{ id: 'a', position: [-20, 0] }, { id: 'b', position: [-15, 0] },
      { id: 'o', position: [' 0 ', '0'] }, { id: 'c', position: [10, 0] }, { id: 'd', position: [0, 10] }], entities: [
      { id: 'edge', kind: 'line', startPointId: 'a', endPointId: 'b', construction: true },
      { id: 'curve', kind: 'circle', centerPointId: 'o', radius: ' 10 ', construction: false }], relations: [] });
    const circle = prepareCadSketchExtend({ graph, parameters: {}, entityId: 'edge', end: 'end' });
    expect(circle.point).toEqual([-10, 0]); expect(circle.target.boundary.endpointPointId).toBeUndefined();
    for (const direction of ['ccw', 'cw'] as const) {
      const arc = parseCadSketchGraph({ ...graph, entities: [graph.entities[0], { id: 'curve', kind: 'arc', centerPointId: 'o', startPointId: 'c', endPointId: 'd', direction, construction: false }] });
      const preview = prepareCadSketchExtend({ graph: arc, parameters: {}, entityId: 'edge', end: 'end' });
      expect(preview.point).toEqual(direction === 'ccw' ? [10, 0] : [-10, 0]);
      expect(preview.target.boundary.endpointPointId).toBe(direction === 'ccw' ? 'c' : undefined);
      const result = extendCadSketchEntity({ graph: arc, parameters: {}, extend: { ...preview.target, endPointId: direction === 'ccw' ? 'c' : 'm' } });
      expect(result.graph.entities[1]).toEqual(arc.entities[1]); expect(without(result.graph.points, 'm')).toEqual(without(arc.points, 'b'));
    }
    expect(() => prepareCadSketchExtend({ graph, parameters: {}, entityId: 'curve', end: 'end' }))
      .toThrowError(expect.objectContaining({ code: 'invalid-sketch-extend-target' }));
  });

  it('reuses an explicit endpoint identity to close a real 100-square-millimetre contour', () => {
    const graph = parseCadSketchGraph({ points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [5, 0] },
      { id: 'c', position: [' width ', ' 0 '] }, { id: 'd', position: [10, 10] }, { id: 'e', position: [0, 10] },
      { id: 'unjoined', position: [10, 0] }], entities: [
      { id: 'bottom', kind: 'line', startPointId: 'a', endPointId: 'b', construction: false },
      { id: 'right', kind: 'line', startPointId: 'c', endPointId: 'd', construction: false },
      { id: 'top', kind: 'line', startPointId: 'd', endPointId: 'e', construction: false },
      { id: 'left', kind: 'line', startPointId: 'e', endPointId: 'a', construction: false }], relations: [] });
    const parameters = { width: 10 }, preview = prepareCadSketchExtend({ graph, parameters, entityId: 'bottom', end: 'end' });
    expect(preview.target.boundary.endpointPointId).toBe('c');
    const result = extendCadSketchEntity({ graph, parameters, extend: { ...preview.target, endPointId: 'c' } });
    const compiled = compileCadSketchGraph(result.graph, parameters);
    expect(compiled.cycles).toHaveLength(1); expect(compiled.arrangementEntityIds).toEqual([]);
    const path = cadAnalyticSegments(compiled.cycles[0].path);
    expect(Math.abs(signedAreaOfPath(path.refs, path.byId))).toBe(100);
    expect(result.graph.points).toEqual(without(graph.points, 'b')); expect(result.graph.relations).toEqual([]);
    expect(() => extendCadSketchEntity({ graph, parameters, extend: { ...preview.target, endPointId: 'unjoined' } }))
      .toThrowError(expect.objectContaining({ code: 'invalid-sketch-extend-point' }));
  });

  it('allows a large finite source parameter without a world-coordinate parameter cap', () => {
    const original = source(), graph = parseCadSketchGraph({ ...original,
      points: original.points.map(point => point.id === 'b' ? { ...point, position: [1e-6, 0] }
        : point.id === 'c' || point.id === 'd' ? { ...point, position: [2000, point.position[1]] } : point), entities: original.entities.filter(entity => entity.id !== 'far') });
    const preview = prepareCadSketchExtend({ graph, parameters: {}, entityId: 'edge', end: 'end' });
    expect(preview.target.boundary.parameter).toBeCloseTo(2e9, 3); expect(preview.point).toEqual([2000, 0]);
    const result = extendCadSketchEntity({ graph, parameters: {}, extend: { ...preview.target, endPointId: 'm' } });
    expect(compileCadSketchGraph(result.graph, {}).segments.find(segment => segment.id === 'edge')?.length).toBe(2000);
  });

  it('blocks actual whole-line and detached-end drivers while preserving unrelated exact strings', () => {
    const original = source(), graph = parseCadSketchGraph({ ...original, relations: [
      { id: 'span', kind: 'distance', pointIds: ['a', 'b'], value: ' length ' }, { id: 'horizontal', kind: 'horizontal', pointIds: ['a', 'b'] }] });
    try { prepareCadSketchExtend({ graph, parameters: { length: 10 }, entityId: 'edge', end: 'end' }); throw new Error('Expected blocker.'); }
    catch (error) {
      expect(error).toBeInstanceOf(CadSketchExtendDependencyError);
      if (!(error instanceof CadSketchExtendDependencyError)) throw error;
      expect(error.relationIds).toEqual(['span']); expect(error.pointIds).toEqual(['b']);
      expect(Object.isFrozen(error.relationIds)).toBe(true); expect(error.message).not.toContain('span');
    }
    const fixed = parseCadSketchGraph({ ...original, points: original.points.map(point => point.id === 'b' ? { ...point, position: [' length ', 0] } : point) });
    expect(() => prepareCadSketchExtend({ graph: fixed, parameters: { length: 10 }, entityId: 'edge', end: 'end' }))
      .toThrowError(expect.objectContaining({ code: 'dependent-sketch-extend', pointIds: ['b'], relationIds: [] }));
    const owned = parseCadSketchGraph({ ...original, relations: [{ id: 'equal', kind: 'equal-length', lineIds: ['edge', 'near'] }] });
    expect(() => prepareCadSketchExtend({ graph: owned, parameters: {}, entityId: 'edge', end: 'end' }))
      .toThrowError(expect.objectContaining({ code: 'dependent-sketch-extend', relationIds: ['equal'] }));
    const unrelated = parseCadSketchGraph({ ...original, points: original.points.map(point => point.id === 'a' ? { ...point, position: [' origin ', 0] } : point) });
    const preview = prepareCadSketchExtend({ graph: unrelated, parameters: { origin: 0 }, entityId: 'edge', end: 'end' });
    expect(extendCadSketchEntity({ graph: unrelated, parameters: { origin: 0 }, extend: { ...preview.target, endPointId: 'm' } }).graph.points.filter(point => point.id !== 'm')).toEqual(without(unrelated.points, 'b'));
  });

  it('rejects stale, forged and colliding requests rather than retargeting changed boundaries', () => {
    const graph = source(), before = JSON.stringify(graph), preview = prepareCadSketchExtend({ graph, parameters: {}, entityId: 'edge', end: 'end' });
    const request = { ...preview.target, endPointId: 'm' };
    const moved = parseCadSketchGraph({ ...graph, points: graph.points.map(point => point.id === 'c' || point.id === 'd' ? { ...point, position: [21, point.position[1]] } : point) });
    expect(() => extendCadSketchEntity({ graph: moved, parameters: {}, extend: request })).toThrowError(expect.objectContaining({ code: 'stale-sketch-extend' }));
    expect(() => extendCadSketchEntity({ graph, parameters: {}, extend: { ...request, boundary: { ...request.boundary, parameter: 3 } } }))
      .toThrowError(expect.objectContaining({ code: 'stale-sketch-extend' }));
    expect(() => extendCadSketchEntity({ graph, parameters: {}, extend: { ...request, endPointId: 'a' } }))
      .toThrowError(expect.objectContaining({ code: 'duplicate-sketch-id' }));
    expect(() => extendCadSketchEntity({ graph, parameters: {}, extend: { ...request, boundary: { ...request.boundary, parameter: Infinity } } }))
      .toThrowError(expect.objectContaining({ code: 'invalid-sketch-extend' }));
    expect(() => extendCadSketchEntity({ graph, parameters: {}, extend: { ...request, endPointId: ' invalid ' } })).toThrow();
    expect(JSON.stringify(graph)).toBe(before);
  });

  it('rejects no-hit, tangent, overlap, undeclared ties and negligible extensions without changing geometry', () => {
    const graph = source(), before = JSON.stringify(graph);
    expect(() => prepareCadSketchExtend({ graph, parameters: {}, entityId: 'edge', end: 'start' }))
      .toThrowError(expect.objectContaining({ code: 'missing-sketch-extend-boundary' }));
    const short = parseCadSketchGraph({ ...graph, points: graph.points.map(point => point.id === 'c' ? { ...point, position: [20, 1] } : point),
      entities: graph.entities.filter(entity => entity.id !== 'far') });
    expect(() => prepareCadSketchExtend({ graph: short, parameters: {}, entityId: 'edge', end: 'end' }))
      .toThrowError(expect.objectContaining({ code: 'missing-sketch-extend-boundary' }));
    const overlap = parseCadSketchGraph({ ...graph, points: graph.points.map(point => point.id === 'c' ? { ...point, position: [20, 0] }
      : point.id === 'd' ? { ...point, position: [30, 0] } : point), entities: graph.entities.filter(entity => entity.id !== 'far') });
    expect(() => prepareCadSketchExtend({ graph: overlap, parameters: {}, entityId: 'edge', end: 'end' }))
      .toThrowError(expect.objectContaining({ code: 'ambiguous-sketch-extend' }));
    const tangent = parseCadSketchGraph({ ...graph, points: [...graph.points, { id: 'o', position: [20, -5] }],
      entities: [graph.entities[0], { id: 'circle', kind: 'circle', centerPointId: 'o', radius: 5, construction: true }] });
    expect(() => prepareCadSketchExtend({ graph: tangent, parameters: {}, entityId: 'edge', end: 'end' }))
      .toThrowError(expect.objectContaining({ code: 'ambiguous-sketch-extend' }));
    const tied = parseCadSketchGraph({ ...graph, points: graph.points.map(point => point.id === 'c' || point.id === 'e' ? { ...point, position: [20, 0] }
      : point.id === 'f' ? { ...point, position: [20, -5] } : point) });
    expect(() => prepareCadSketchExtend({ graph: tied, parameters: {}, entityId: 'edge', end: 'end' }))
      .toThrowError(expect.objectContaining({ code: 'ambiguous-sketch-extend' }));
    const declared = parseCadSketchGraph({ ...tied, relations: [{ id: 'joint', kind: 'coincident', pointIds: ['c', 'e'] }] });
    expect(prepareCadSketchExtend({ graph: declared, parameters: {}, entityId: 'edge', end: 'end' }).target.boundary.endpointPointId).toBe('e');
    const near = parseCadSketchGraph({ ...graph, points: graph.points.map(point => point.id === 'c' || point.id === 'd' ? { ...point, position: [10 + 1e-8, point.position[1]] } : point) });
    expect(() => prepareCadSketchExtend({ graph: near, parameters: {}, entityId: 'edge', end: 'end' }))
      .toThrowError(expect.objectContaining({ code: 'sketch-extend-precision' }));
    expect(JSON.stringify(graph)).toBe(before);
  });
});
