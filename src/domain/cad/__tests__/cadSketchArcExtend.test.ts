import { describe, expect, it } from 'vitest';
import { prepareCadSketchExtend, extendCadSketchEntity } from '../cadSketchTrimExtend';
import { compileCadSketchGraph } from '../cadSketchGraphGeometry';
import { prepareCadSketchCells } from '../cadSketchRegionInspection';
import { arcExtendPart } from './cadSketchArcExtendFixtures';
import { parseCadSketchGraph } from '../cadSketchGraph';

describe('exact endpoint-owned arc Extend', () => {
  it('extends the ordinary R10 closure endpoint [-8,6] without discarding its exact source strings or identity', () => {
    const document = arcExtendPart(), sketch = document.features[0];
    if (sketch.kind !== 'sketch' || !sketch.graph) throw new Error('Expected quarter segment.');
    const graph = parseCadSketchGraph({ ...sketch.graph, points: sketch.graph.points.map(point => point.id === 'c'
      ? { ...point, position: [' -8.000 ', ' 6.000 '] } : point) }), before = JSON.stringify(graph);
    const preview = prepareCadSketchExtend({ graph, parameters: document.parameters, entityId: 'arc', end: 'end' });
    expect(preview.target.boundary).toMatchObject({ entityId: 'closure', position: [-8, 6], endpointPointId: 'c' });
    expect(preview.extended).toMatchObject({ kind: 'arc', radius: 10, sweepRadians: Math.atan2(6, -8) });
    const result = extendCadSketchEntity({ graph, parameters: document.parameters, extend: { ...preview.target, endPointId: 'c' } });
    expect(result.graph.entities).toEqual(graph.entities.map(entity => entity.id === 'arc' ? { ...entity, endPointId: 'c' } : entity));
    expect(result.graph.points).toEqual(graph.points); expect(result.graph.relations).toEqual(graph.relations);
    expect(JSON.stringify(graph)).toBe(before);
  });

  it('extends to the actual finite closure endpoint and keeps the old chord as an internal divider of the larger segment', () => {
    const document = arcExtendPart(), sketch = document.features[0];
    if (sketch.kind !== 'sketch' || !sketch.graph) throw new Error('Expected quarter segment.');
    const graph = sketch.graph, before = JSON.stringify(graph);
    const preview = prepareCadSketchExtend({ graph, parameters: document.parameters, entityId: 'arc', end: 'end' });
    expect(preview.target).toMatchObject({ kind: 'arc', entityId: 'arc', end: 'end', boundary: { position: [-6, 8], endpointPointId: 'c' } });
    expect(preview.target.boundary.parameter).toBeCloseTo(Math.atan2(8, -6) / (Math.PI / 2), 14);
    expect(preview.added).toMatchObject({ kind: 'arc', start: { x: 0, y: 10 }, end: { x: -6, y: 8 } });
    expect(preview.extended).toMatchObject({ kind: 'arc', start: { x: 10, y: 0 }, end: { x: -6, y: 8 }, radius: 10 });
    if (preview.extended.kind !== 'arc') throw new Error('Expected analytic arc extension.');
    expect(preview.extended.sweepRadians).toBe(Math.atan2(8, -6));
    const result = extendCadSketchEntity({ graph, parameters: document.parameters, extend: { ...preview.target, endPointId: 'c' } });
    expect(result.graph.entities).toEqual(graph.entities.map(entity => entity.id === 'arc' ? { ...entity, endPointId: 'c' } : entity));
    expect(result.graph.points).toEqual(graph.points); expect(result.graph.relations).toEqual(graph.relations);
    const actual = compileCadSketchGraph(result.graph, document.parameters).segments.find(segment => segment.id === 'arc');
    expect(actual).toMatchObject({ kind: 'arc', radius: 10, sweepRadians: Math.atan2(8, -6) });
    const catalog = prepareCadSketchCells({ ...sketch, graph: result.graph }, document.parameters, 'graph-cells');
    expect(catalog.cells).toHaveLength(2);
    expect(catalog.cells.reduce((area, cell) => area + cell.areaMm2, 0)).toBeCloseTo(50 * (Math.atan2(8, -6) - .8), 11);
    expect(JSON.stringify(graph)).toBe(before); expect(Object.isFrozen(preview.extended.end)).toBe(true);
  });

  it('rejects a distinct near-barrier contact rounded onto a full turn instead of ignoring it as no boundary', () => {
    const document = arcExtendPart(), sketch = document.features[0];
    if (sketch.kind !== 'sketch' || !sketch.graph) throw new Error('Expected arc source.');
    const graph = parseCadSketchGraph({ ...sketch.graph, points: [...sketch.graph.points.map(point => point.id === 'c' ? { ...point, position: [10, -1e-15] } : point),
      { id: 'inside', position: [5, -1e-15] }], entities: [...sketch.graph.entities.filter(entity => entity.id !== 'closure'),
      { id: 'near-barrier', kind: 'line', construction: true, startPointId: 'c', endPointId: 'inside' }] });
    expect(() => prepareCadSketchExtend({ graph, parameters: document.parameters, entityId: 'arc', end: 'end' }))
      .toThrowError(expect.objectContaining({ code: 'sketch-extend-precision' }));
  });

  it('skips a proven zero-travel tangent contact at its actual current endpoint before testing eligible tangency', () => {
    const document = arcExtendPart(true), sketch = document.features[0];
    if (sketch.kind !== 'sketch' || !sketch.graph) throw new Error('Expected numeric-contact source.');
    const graph = parseCadSketchGraph({ ...sketch.graph, points: [...sketch.graph.points, { id: 't', position: [10, 10] }],
      entities: [...sketch.graph.entities, { id: 'origin-tangent', kind: 'line', startPointId: 'b', endPointId: 't', construction: true }] });
    const preview = prepareCadSketchExtend({ graph, parameters: document.parameters, entityId: 'arc', end: 'end' });
    expect(preview.target).toMatchObject({ kind: 'arc', boundary: { entityId: 'cutter', position: [-6, 8] } });
  });

  it('preserves reversed CW traversal and source order when extending the start', () => {
    const document = arcExtendPart(), sketch = document.features[0];
    if (sketch.kind !== 'sketch' || !sketch.graph) throw new Error('Expected arc source.');
    const graph = parseCadSketchGraph({ ...sketch.graph, points: [...sketch.graph.points].reverse(), entities: sketch.graph.entities.map(entity => entity.kind === 'arc'
      ? { ...entity, startPointId: 'b', endPointId: 'a', direction: 'cw', construction: true } : entity).reverse() });
    const before = JSON.stringify(graph), preview = prepareCadSketchExtend({ graph, parameters: document.parameters, entityId: 'arc', end: 'start' });
    expect(preview.target).toMatchObject({ kind: 'arc', end: 'start', boundary: { endpointPointId: 'c', position: [-6, 8] } });
    expect(preview.target.boundary.parameter).toBeLessThan(0);
    expect(preview.added).toMatchObject({ kind: 'arc', clockwise: true, start: { x: -6, y: 8 }, end: { x: 0, y: 10 } });
    expect(preview.extended).toMatchObject({ kind: 'arc', clockwise: true, sweepRadians: -Math.atan2(8, -6) });
    const result = extendCadSketchEntity({ graph, parameters: document.parameters, extend: { ...preview.target, endPointId: 'c' } });
    expect(result.graph.entities).toEqual(graph.entities.map(entity => entity.id === 'arc' ? { ...entity, startPointId: 'c' } : entity));
    expect(result.graph.points).toEqual(graph.points); expect(JSON.stringify(graph)).toBe(before);
    expect(() => extendCadSketchEntity({ graph, parameters: document.parameters, extend: { ...preview.target, kind: 'line', endPointId: 'c' } }))
      .toThrowError(expect.objectContaining({ code: 'invalid-sketch-extend-target' }));
  });

  it('allows intentional minor-to-major growth and a true half-turn, but rejects a lost near-half-turn Cartesian side', () => {
    const document = arcExtendPart(), sketch = document.features[0];
    if (sketch.kind !== 'sketch' || !sketch.graph) throw new Error('Expected arc source.');
    const sourceGraph = sketch.graph;
    const source = (position: readonly [number, number]) => parseCadSketchGraph({ ...sourceGraph,
      points: sourceGraph.points.map(point => point.id === 'c' ? { ...point, position } : point) });
    for (const position of [[-6, -8], [-10, 0]] as const) {
      const graph = source(position), preview = prepareCadSketchExtend({ graph, parameters: document.parameters, entityId: 'arc', end: 'end' });
      if (preview.extended.kind !== 'arc') throw new Error('Expected arc extension.');
      const expected = position[1] === 0 ? Math.PI : 2 * Math.PI + Math.atan2(-8, -6);
      expect(preview.extended.sweepRadians).toBeCloseTo(expected, 14);
      const result = extendCadSketchEntity({ graph, parameters: document.parameters, extend: { ...preview.target, endPointId: 'c' } });
      expect(compileCadSketchGraph(result.graph, document.parameters).segments.find(segment => segment.id === 'arc'))
        .toMatchObject({ kind: 'arc', sweepRadians: preview.extended.sweepRadians, radius: 10 });
    }
    for (const y of [1e-15, -1e-15]) expect(() => prepareCadSketchExtend({ graph: source([-10, y]), parameters: document.parameters, entityId: 'arc', end: 'end' }))
      .toThrowError(expect.objectContaining({ code: 'sketch-extend-precision' }));
  });

  it('uses only a finite cutter arc and still rejects eligible positive-travel tangency or coincident support', () => {
    const document = arcExtendPart(), sketch = document.features[0];
    if (sketch.kind !== 'sketch' || !sketch.graph) throw new Error('Expected arc source.');
    const graph = parseCadSketchGraph({ ...sketch.graph, points: [...sketch.graph.points,
      { id: 'k', position: [-6, 0] }, { id: 'd', position: [-6, -8] }, { id: 'e', position: [-14, 0] }],
      entities: [...sketch.graph.entities.filter(entity => entity.id !== 'closure'),
        { id: 'finite-arc', kind: 'arc', centerPointId: 'k', startPointId: 'd', endPointId: 'e', direction: 'cw', construction: true }] });
    const preview = prepareCadSketchExtend({ graph, parameters: document.parameters, entityId: 'arc', end: 'end' });
    expect(preview.target.boundary).toMatchObject({ entityId: 'finite-arc', position: [-6, -8], endpointPointId: 'd' });
    expect(preview.extended).toMatchObject({ kind: 'arc', sweepRadians: 2 * Math.PI + Math.atan2(-8, -6) });
    const tangent = parseCadSketchGraph({ ...sketch.graph, points: [...sketch.graph.points,
      { id: 't0', position: [-10, -5] }, { id: 't1', position: [-10, 5] }], entities: [...sketch.graph.entities,
        { id: 'tangent', kind: 'line', startPointId: 't0', endPointId: 't1', construction: true }] });
    expect(() => prepareCadSketchExtend({ graph: tangent, parameters: document.parameters, entityId: 'arc', end: 'end' }))
      .toThrowError(expect.objectContaining({ code: 'ambiguous-sketch-extend' }));
    const overlap = parseCadSketchGraph({ ...sketch.graph, entities: [...sketch.graph.entities,
      { id: 'same-support', kind: 'circle', centerPointId: 'o', radius: 10, construction: true }] });
    expect(() => prepareCadSketchExtend({ graph: overlap, parameters: document.parameters, entityId: 'arc', end: 'end' }))
      .toThrowError(expect.objectContaining({ code: 'ambiguous-sketch-extend' }));
    const oldCoverage = parseCadSketchGraph({ ...sketch.graph, points: [...sketch.graph.points.map(point => point.id === 'c' ? { ...point, position: [6, 8] } : point),
      { id: 'inside', position: [3, 4] }], entities: [...sketch.graph.entities.filter(entity => entity.id !== 'closure'),
        { id: 'old-coverage', kind: 'line', startPointId: 'c', endPointId: 'inside', construction: true }] });
    expect(() => prepareCadSketchExtend({ graph: oldCoverage, parameters: document.parameters, entityId: 'arc', end: 'end' }))
      .toThrowError(expect.objectContaining({ code: 'missing-sketch-extend-boundary' }));
  });

  it('retains center/opposite/radius drivers while rejecting detached drivers, stale witnesses and forged endpoint identities atomically', () => {
    const document = arcExtendPart(), sketch = document.features[0];
    if (sketch.kind !== 'sketch' || !sketch.graph) throw new Error('Expected arc source.');
    const graph = parseCadSketchGraph({ ...sketch.graph, relations: [
      { id: 'center-driver', kind: 'fixed-point', pointId: 'o', position: ['0.000', ' 0 '] },
      { id: 'opposite-driver', kind: 'fixed-axis', pointId: 'a', axis: 'x', value: ' 10 ' }] });
    const before = JSON.stringify(graph), preview = prepareCadSketchExtend({ graph, parameters: document.parameters, entityId: 'arc', end: 'end' });
    const request = { ...preview.target, endPointId: 'c' };
    expect(extendCadSketchEntity({ graph, parameters: document.parameters, extend: request }).graph.relations).toEqual(graph.relations);
    expect(() => extendCadSketchEntity({ graph, parameters: document.parameters, extend: { ...request, endPointId: 'fresh' } }))
      .toThrowError(expect.objectContaining({ code: 'invalid-sketch-extend-point' }));
    const owned = parseCadSketchGraph({ ...graph, relations: [...graph.relations,
      { id: 'radius', kind: 'radial-size', entityId: 'arc', quantity: 'radius', value: ' 10 ' }] });
    const ownedPreview = prepareCadSketchExtend({ graph: owned, parameters: document.parameters, entityId: 'arc', end: 'end' });
    expect(extendCadSketchEntity({ graph: owned, parameters: document.parameters, extend: { ...ownedPreview.target, endPointId: 'c' } }).graph.relations)
      .toEqual(owned.relations);
    // The divider keeps the old end b, so its expression stays with it; once nothing else keeps b, the extension would detach it and refuses.
    const driven = parseCadSketchGraph({ ...graph, points: graph.points.map(point => point.id === 'b' ? { ...point, position: ['0.000', 10] } : point) });
    const drivenPreview = prepareCadSketchExtend({ graph: driven, parameters: document.parameters, entityId: 'arc', end: 'end' });
    expect(extendCadSketchEntity({ graph: driven, parameters: document.parameters, extend: { ...drivenPreview.target, endPointId: 'c' } }).graph.points
      .find(point => point.id === 'b')?.position).toEqual(['0.000', 10]);
    const alone = parseCadSketchGraph({ ...driven, entities: driven.entities.filter(entity => entity.id !== 'divider') });
    expect(() => prepareCadSketchExtend({ graph: alone, parameters: document.parameters, entityId: 'arc', end: 'end' }))
      .toThrowError(expect.objectContaining({ code: 'dependent-sketch-extend', pointIds: ['b'] }));
    const changed = parseCadSketchGraph({ ...graph, entities: graph.entities.map(entity => entity.id === 'closure' ? { ...entity, id: 'new-closure' } : entity) });
    expect(() => extendCadSketchEntity({ graph: changed, parameters: document.parameters, extend: request }))
      .toThrowError(expect.objectContaining({ code: 'stale-sketch-extend' }));
    const numeric = arcExtendPart(true).features[0];
    if (numeric.kind !== 'sketch' || !numeric.graph) throw new Error('Expected numeric contact.');
    const numericGraph = numeric.graph, contact = prepareCadSketchExtend({ graph: numericGraph, parameters: document.parameters, entityId: 'arc', end: 'end' });
    for (const endPointId of ['o', 'a']) expect(() => extendCadSketchEntity({ graph: numericGraph, parameters: document.parameters, extend: { ...contact.target, endPointId } }))
      .toThrowError(expect.objectContaining({ code: 'invalid-sketch-extend-point' }));
    expect(() => extendCadSketchEntity({ graph: numericGraph, parameters: document.parameters, extend: { ...contact.target, endPointId: 'arc' } }))
      .toThrowError(expect.objectContaining({ code: 'duplicate-sketch-id' }));
    expect(JSON.stringify(graph)).toBe(before);
  });
});
