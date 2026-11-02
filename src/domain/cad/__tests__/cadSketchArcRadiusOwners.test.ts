import { describe, expect, it } from 'vitest';
import { parseCadSketchGraph } from '../cadSketchGraph';
import { prepareCadSketchTrim, trimCadSketchEntity, prepareCadSketchExtend, extendCadSketchEntity } from '../cadSketchTrimExtend';
import { compileCadSketchGraph } from '../cadSketchGraphGeometry';
import { middleArcTrimPart } from './cadSketchMiddleArcTrimFixtures';
import { arcExtendPart } from './cadSketchArcExtendFixtures';
import { createCadSketchCornerTreatment } from '../cadSketchCornerTreatment';

function drivenStartSource() {
  const document = arcExtendPart(), sketch = document.features[0];
  if (sketch.kind !== 'sketch' || !sketch.graph) throw new Error('Expected quarter arc source.');
  return { parameters: { ...document.parameters, stockRadius: 10 }, graph: parseCadSketchGraph({ ...sketch.graph,
    entities: sketch.graph.entities.map(entity => entity.kind === 'arc' ? { ...entity, startPointId: 'b', endPointId: 'a', direction: 'cw' } : entity),
    relations: [{ id: 'radius', kind: 'radial-size', entityId: 'arc', quantity: 'radius', value: ' stockRadius ' }] }) };
}

describe('retained arc radius ownership in exact boundary edits', () => {
  it('keeps the exact diameter driver on the source arc when start-side Trim replaces the native radial spoke', () => {
    const document = middleArcTrimPart(), sketch = document.features[0];
    if (sketch.kind !== 'sketch' || !sketch.graph) throw new Error('Expected D arc source.');
    const parameters = { ...document.parameters, stockRadius: 10 }, graph = parseCadSketchGraph({ ...sketch.graph, relations: [
      { id: 'diameter', kind: 'radial-size', entityId: 'arc', quantity: 'diameter', value: ' 2 * stockRadius ' }] });
    const before = JSON.stringify(graph), preview = prepareCadSketchTrim({ graph, parameters, entityId: 'arc', parameter: .1 });
    if (preview.target.kind !== 'end') throw new Error('Expected start-side end Trim.');
    expect(preview.target).toMatchObject({ end: 'start', boundary: { endpointPointId: 'p' } });
    const result = trimCadSketchEntity({ graph, parameters, trim: { ...preview.target, cutPointId: 'p' } });
    expect(result.graph.entities).toEqual(graph.entities.map(entity => entity.id === 'arc' ? { ...entity, startPointId: 'p' } : entity));
    expect(result.graph.relations).toEqual(graph.relations); expect(result.graph.points).toEqual(graph.points);
    expect(compileCadSketchGraph(result.graph, parameters).segments.find(segment => segment.id === 'arc'))
      .toMatchObject({ kind: 'arc', center: { x: 0, y: 0 }, radius: 10, start: { x: -6, y: -8 } });
    expect(JSON.stringify(graph)).toBe(before); expect(Object.isFrozen(result.graph.relations[0])).toBe(true);
  });

  it('keeps radius and existing equality records in their original order through CW start Extend', () => {
    const source = drivenStartSource(), parameters = source.parameters, graph = parseCadSketchGraph({ ...source.graph,
      points: [...source.graph.points, { id: 'peer-center', position: [30, 0] }],
      entities: [...source.graph.entities, { id: 'peer', kind: 'circle', centerPointId: 'peer-center', radius: 10, construction: true }],
      relations: [{ id: 'equal', kind: 'equal-radius', curveIds: ['arc', 'peer'] }, ...source.graph.relations] });
    const before = JSON.stringify(graph), preview = prepareCadSketchExtend({ graph, parameters, entityId: 'arc', end: 'start' });
    expect(preview.target).toMatchObject({ kind: 'arc', end: 'start', boundary: { endpointPointId: 'c' } });
    const result = extendCadSketchEntity({ graph, parameters, extend: { ...preview.target, endPointId: 'c' } });
    expect(result.graph.entities).toEqual(graph.entities.map(entity => entity.id === 'arc' ? { ...entity, startPointId: 'c' } : entity));
    expect(result.graph.relations).toEqual(graph.relations); expect(result.graph.points).toEqual(graph.points);
    expect(compileCadSketchGraph(result.graph, parameters).segments.find(segment => segment.id === 'arc'))
      .toMatchObject({ kind: 'arc', radius: 10, clockwise: true });
    expect(JSON.stringify(graph)).toBe(before);
  });

  it('keeps middle Trim owners on the retained source ID and appends only the ordinary sibling equality', () => {
    const document = middleArcTrimPart(), sketch = document.features[0];
    if (sketch.kind !== 'sketch' || !sketch.graph) throw new Error('Expected D arc source.');
    const parameters = { ...document.parameters, stockRadius: 10 }, graph = parseCadSketchGraph({ ...sketch.graph,
      points: [...sketch.graph.points, { id: 'peer-center', position: [30, 0] }],
      entities: [...sketch.graph.entities, { id: 'peer', kind: 'circle', centerPointId: 'peer-center', radius: 10, construction: true }], relations: [
        { id: 'equal', kind: 'equal-radius', curveIds: ['peer', 'arc'] },
        { id: 'diameter', kind: 'radial-size', entityId: 'arc', quantity: 'diameter', value: ' 2 * stockRadius ' },
        { id: 'unrelated', kind: 'fixed-axis', pointId: 'guide-p', axis: 'y', value: ' 0 ' }] });
    const before = JSON.stringify(graph), preview = prepareCadSketchTrim({ graph, parameters, entityId: 'arc', parameter: .5 });
    if (preview.target.kind !== 'middle') throw new Error('Expected middle arc Trim.');
    const result = trimCadSketchEntity({ graph, parameters, trim: { ...preview.target,
      cutPointIds: ['p', 'q'], newEntityId: 'after', supportRelationId: 'sibling-radius' } });
    expect(result.graph.relations).toEqual([...graph.relations, { id: 'sibling-radius', kind: 'equal-radius', curveIds: ['arc', 'after'] }]);
    expect(result.graph.entities.filter(entity => entity.kind === 'arc')).toEqual([
      { ...graph.entities[0], endPointId: 'p' }, { ...graph.entities[0], id: 'after', startPointId: 'q' }]);
    expect(result.graph.points).toEqual(graph.points);
    const arcs = compileCadSketchGraph(result.graph, parameters).segments.filter(segment => segment.kind === 'arc');
    expect(arcs).toMatchObject([{ radius: 10, sweepRadians: Math.PI / 2 }, { radius: 10, sweepRadians: Math.PI / 2 }]);
    expect(JSON.stringify(graph)).toBe(before);
  });

  it('keeps drivers and a peer radius on an old end another edge keeps, refuses drivers on one that leaves, and deletes an arc with its owner', () => {
    const source = drivenStartSource(), parameters = source.parameters, graph = source.graph, before = JSON.stringify(graph);
    const explicit = parseCadSketchGraph({ ...graph, relations: [...graph.relations,
      { id: 'endpoint-driver', kind: 'fixed-axis', pointId: 'b', axis: 'x', value: ' 0 ' }] });
    const string = parseCadSketchGraph({ ...graph, points: graph.points.map(point => point.id === 'b' ? { ...point, position: ['0.000', 10] } : point) });
    const peer = parseCadSketchGraph({ ...graph, points: [...graph.points, { id: 'peer-center', position: [0, 20] }, { id: 'peer-end', position: [10, 20] }],
      entities: [...graph.entities, { id: 'peer', kind: 'arc', centerPointId: 'peer-center', startPointId: 'b', endPointId: 'peer-end', direction: 'ccw', construction: true }],
      relations: [...graph.relations, { id: 'peer-radius', kind: 'radial-size', entityId: 'peer', quantity: 'radius', value: ' stockRadius ' }] });
    // The divider keeps the arc's old start, so its driver and the peer arc's radius stay with it, unchanged, as the arc reaches past it.
    for (const kept of [explicit, string, peer]) {
      const { target } = prepareCadSketchExtend({ graph: kept, parameters, entityId: 'arc', end: 'start' });
      const result = extendCadSketchEntity({ graph: kept, parameters, extend: { ...target, endPointId: 'c' } });
      expect(result.graph.relations).toEqual(kept.relations); expect(result.graph.points).toEqual(kept.points);
    }
    // Without the divider the old start leaves with the extension, and the driver placing it would go with it.
    const alone = (driven: typeof graph) => parseCadSketchGraph({ ...driven, entities: driven.entities.filter(entity => entity.id !== 'divider') });
    expect(() => prepareCadSketchExtend({ graph: alone(explicit), parameters, entityId: 'arc', end: 'start' }))
      .toThrowError(expect.objectContaining({ code: 'dependent-sketch-extend', relationIds: ['endpoint-driver'], pointIds: ['b'] }));
    expect(() => prepareCadSketchExtend({ graph: alone(string), parameters, entityId: 'arc', end: 'start' }))
      .toThrowError(expect.objectContaining({ code: 'dependent-sketch-extend', relationIds: [], pointIds: ['b'] }));
    const isolated = parseCadSketchGraph({ ...graph, entities: graph.entities.filter(entity => entity.id === 'arc') });
    expect(prepareCadSketchTrim({ graph: isolated, parameters, entityId: 'arc', parameter: .5 }).target)
      .toEqual({ kind: 'delete', entityId: 'arc', parameter: .5, removedRelationIds: ['radius'] });
    let next = 0;
    const corner = createCadSketchCornerTreatment({ graph: parseCadSketchGraph({ points: [
      { id: 'v', position: [0, 0] }, { id: 'x', position: [20, 0] }, { id: 'y', position: [0, 20] }], entities: [
      { id: 'first', kind: 'line', startPointId: 'v', endPointId: 'x', construction: false },
      { id: 'second', kind: 'line', startPointId: 'v', endPointId: 'y', construction: false }], relations: [] }), parameters: {}, pointId: 'v',
      treatment: { kind: 'fillet', radius: 2 }, createId: () => `corner_${++next}` });
    const arc = corner.graph.entities.find(entity => entity.kind === 'arc');
    if (!arc) throw new Error('Expected owned fillet arc.');
    expect(() => prepareCadSketchExtend({ graph: corner.graph, parameters: {}, entityId: arc.id, end: 'end' }))
      .toThrowError(expect.objectContaining({ code: 'dependent-sketch-extend', relationIds: [corner.relationId] }));
    expect(JSON.stringify(graph)).toBe(before);
  });
});
