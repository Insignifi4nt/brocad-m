import { describe, expect, it } from 'vitest';
import { checkCadSketchGraph, parseCadSketchGraph } from '../cadSketchGraph';
import { compileCadSketchGraph } from '../cadSketchGraphGeometry';
import { CadSketchSplitDependencyError, splitCadSketchEntity } from '../cadSketchSplit';
import { createCadSketchCornerTreatment } from '../cadSketchCornerTreatment';

describe('exact sketch source split', () => {
  it('retains the source-start side and every old driver without welding an existing coincident point', () => {
    const graph = parseCadSketchGraph({ points: [{ id: 'a', position: [' origin ', 5] }, { id: 'b', position: [15, ' 21 '] },
      { id: 'unjoined', position: [6, 9] }], entities: [{ id: 'edge', kind: 'line', startPointId: 'a', endPointId: 'b', construction: true }],
      relations: [{ id: 'span', kind: 'distance', pointIds: ['a', 'b'], value: ' length ' }] });
    const before = JSON.stringify(graph), parameters = { origin: 3, length: 20 };
    const result = splitCadSketchEntity({ graph, parameters, split: { kind: 'line', entityId: 'edge', parameter: 0.25,
      splitPointId: 'joint', newEntityId: 'second', supportRelationId: 'straight' } });
    expect(result).toMatchObject({ retainedEntityId: 'edge', newEntityId: 'second', splitPointId: 'joint' });
    expect(result.graph.points).toEqual([...graph.points, { id: 'joint', position: [6, 9] }]);
    expect(result.graph.entities).toEqual([
      { id: 'edge', kind: 'line', construction: true, startPointId: 'a', endPointId: 'joint' },
      { id: 'second', kind: 'line', construction: true, startPointId: 'joint', endPointId: 'b' }
    ]);
    expect(result.graph.relations).toEqual([...graph.relations, { id: 'straight', kind: 'parallel', lineIds: ['edge', 'second'] }]);
    expect(checkCadSketchGraph(result.graph, parameters)).toEqual([]);
    expect(compileCadSketchGraph(result.graph, parameters).segments.map(segment => segment.length)).toEqual([5, 15]);
    expect(JSON.stringify(graph)).toBe(before);
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.graph.points.at(-1)?.position)).toBe(true);
  });

  it.each(['cw', 'ccw'] as const)('partitions a %s major arc on its exact support without changing its center or source endpoints', direction => {
    const sign = direction === 'cw' ? -1 : 1;
    const graph = parseCadSketchGraph({ points: [{ id: 'o', position: [' cx ', ' cy '] }, { id: 'a', position: [12, 3] },
      { id: 'b', position: [2, 3 - sign * 10] }], entities: [
      { id: 'arc', kind: 'arc', construction: false, centerPointId: 'o', startPointId: 'a', endPointId: 'b', direction },
      { id: 'chord', kind: 'line', construction: false, startPointId: 'b', endPointId: 'a' }], relations: [] });
    const parameters = { cx: 2, cy: 3 }, before = JSON.stringify(graph);
    const result = splitCadSketchEntity({ graph, parameters, split: { kind: 'arc', entityId: 'arc', parameter: 1 / 6,
      splitPointId: 'm', newEntityId: 'second' } });
    expect(result.graph.points.slice(0, 3)).toEqual(graph.points);
    expect(result.graph.points[3].position[0]).toBeCloseTo(2 + Math.sqrt(50), 13);
    expect(result.graph.points[3].position[1]).toBeCloseTo(3 + sign * Math.sqrt(50), 13);
    expect(result.graph.entities).toEqual([
      { ...graph.entities[0], endPointId: 'm' }, { ...graph.entities[0], id: 'second', startPointId: 'm' }, graph.entities[1]
    ]);
    expect(result.graph.relations).toEqual([]);
    const compiled = compileCadSketchGraph(result.graph, parameters), arcs = compiled.segments.filter(segment => segment.kind === 'arc');
    expect(arcs.map(arc => arc.sweepRadians)).toEqual([sign * Math.PI / 4, sign * Math.PI * 5 / 4]);
    expect(arcs.reduce((length, arc) => length + arc.length, 0)).toBeCloseTo(15 * Math.PI, 12);
    expect(compiled.cycles).toHaveLength(1); expect(compiled.arrangementEntityIds).toEqual([]);
    expect(JSON.stringify(graph)).toBe(before);
  });

  it('blocks a whole-edge equal length with exact relation identities, and keeps a radius and a corner on the piece keeping the id', () => {
    const graph = parseCadSketchGraph({ points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [20, 0] }, { id: 'c', position: [0, 20] }],
      entities: [{ id: 'edge', kind: 'line', startPointId: 'a', endPointId: 'b', construction: false },
        { id: 'other', kind: 'line', startPointId: 'a', endPointId: 'c', construction: false }],
      relations: [{ id: 'same-size', kind: 'equal-length', lineIds: ['edge', 'other'] }] });
    const request = { kind: 'line', entityId: 'edge', parameter: 0.5, splitPointId: 'm', newEntityId: 'child', supportRelationId: 'support' } as const;
    const before = JSON.stringify(graph);
    try { splitCadSketchEntity({ graph, parameters: {}, split: request }); throw new Error('Expected dependency rejection.'); }
    catch (error) {
      expect(error).toBeInstanceOf(CadSketchSplitDependencyError);
      if (!(error instanceof CadSketchSplitDependencyError)) throw error;
      expect(error.relationIds).toEqual(['same-size']); expect(Object.isFrozen(error.relationIds)).toBe(true);
      expect(error.message).not.toContain('same-size');
    }
    const arc = parseCadSketchGraph({ points: [{ id: 'o', position: [0, 0] }, { id: 'a', position: [10, 0] }, { id: 'b', position: [0, 10] }],
      entities: [{ id: 'arc', kind: 'arc', construction: false, centerPointId: 'o', startPointId: 'a', endPointId: 'b', direction: 'ccw' }],
      relations: [{ id: 'radius', kind: 'radial-size', entityId: 'arc', quantity: 'radius', value: ' 10 ' }] });
    // Both arcs keep the one circle, and the fillet stays at the start the first piece keeps.
    expect(splitCadSketchEntity({ graph: arc, parameters: {}, split: { kind: 'arc', entityId: 'arc', parameter: 0.5, splitPointId: 'm', newEntityId: 'child' } }).graph.relations)
      .toEqual(arc.relations);
    let id = 0;
    const corner = createCadSketchCornerTreatment({ graph: parseCadSketchGraph({ ...graph, relations: [] }), parameters: {}, pointId: 'a',
      treatment: { kind: 'fillet', radius: 2 }, createId: () => `corner_${++id}` });
    expect(splitCadSketchEntity({ graph: corner.graph, parameters: {}, split: request }).graph.relations)
      .toEqual([...corner.graph.relations, { id: 'support', kind: 'parallel', lineIds: ['edge', 'child'] }]);
    expect(JSON.stringify(graph)).toBe(before);
  });

  it('keeps the retained side independent of source array order and reversed source directions', () => {
    for (const reversed of [false, true]) {
      const graph = parseCadSketchGraph({ points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [20, 0] }], entities: [
        { id: 'edge', kind: 'line', startPointId: reversed ? 'b' : 'a', endPointId: reversed ? 'a' : 'b', construction: false }], relations: [] });
      const result = splitCadSketchEntity({ graph: { ...graph, points: [...graph.points].reverse() }, parameters: {}, split: {
        kind: 'line', entityId: 'edge', parameter: 0.25, splitPointId: 'm', newEntityId: 'aaa', supportRelationId: 'support' } });
      expect(result.graph.entities).toEqual([{ ...graph.entities[0], endPointId: 'm' }, { ...graph.entities[0], id: 'aaa', startPointId: 'm' }]);
      expect(result.graph.points.at(-1)?.position).toEqual([reversed ? 15 : 5, 0]);
    }
  });

  it('rejects endpoint, collapsed, nonfinite, wrong-kind and colliding requests without editing source', () => {
    const graph = parseCadSketchGraph({ points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [10, 0] }], entities: [
      { id: 'edge', kind: 'line', startPointId: 'a', endPointId: 'b', construction: false }], relations: [] });
    const split = { kind: 'line', entityId: 'edge', parameter: 0.5, splitPointId: 'm', newEntityId: 'child', supportRelationId: 'support' } as const;
    const before = JSON.stringify(graph);
    for (const parameter of [0, 1, -1, Infinity, NaN, 1e-10, 1 - 1e-10])
      expect(() => splitCadSketchEntity({ graph, parameters: {}, split: { ...split, parameter } })).toThrow();
    for (const request of [{ ...split, newEntityId: 'a' }, { ...split, supportRelationId: 'm' }, { ...split, splitPointId: 'a' },
      { ...split, newEntityId: ' invalid ' }, { ...split, entityId: 'missing' },
      { kind: 'arc', entityId: 'edge', parameter: 0.5, splitPointId: 'm', newEntityId: 'child' }] as const)
      expect(() => splitCadSketchEntity({ graph, parameters: {}, split: request })).toThrow();
    const far = parseCadSketchGraph({ ...graph, points: [{ id: 'a', position: [9e8, 9e8] }, { id: 'b', position: [9e8 + 1, 9e8 + 3] }] });
    expect(() => splitCadSketchEntity({ graph: far, parameters: {}, split: { ...split, parameter: 0.1 } })).toThrowError(expect.objectContaining({ code: 'sketch-split-precision' }));
    const angle = 61 * Math.PI / 180, rotated = parseCadSketchGraph({ ...graph, points: [{ id: 'a', position: [98765.4321, 98765.4321] },
      { id: 'b', position: [98765.4321 + 20 * Math.cos(angle), 98765.4321 + 20 * Math.sin(angle)] }] });
    expect(() => splitCadSketchEntity({ graph: rotated, parameters: {}, split: { ...split, parameter: .25 } })).toThrowError(expect.objectContaining({ code: 'sketch-split-precision' }));
    const tiny = parseCadSketchGraph({ ...graph, points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [1e-6, 0] }] });
    expect(splitCadSketchEntity({ graph: tiny, parameters: {}, split }).graph.points.at(-1)?.position).toEqual([5e-7, 0]);
    expect(JSON.stringify(graph)).toBe(before);
  });

  it('rejects rounding an intended major child onto a half-turn instead of changing its branch', () => {
    const graph = parseCadSketchGraph({ points: [{ id: 'o', position: [10000, 10000] }, { id: 'a', position: [10010, 10000] },
      { id: 'b', position: [10000, 9990] }], entities: [{ id: 'arc', kind: 'arc', centerPointId: 'o', startPointId: 'a', endPointId: 'b',
        direction: 'ccw', construction: false }], relations: [] });
    expect(() => splitCadSketchEntity({ graph, parameters: {}, split: { kind: 'arc', entityId: 'arc', parameter: (Math.PI + 1e-14) / (1.5 * Math.PI),
      splitPointId: 'm', newEntityId: 'child' } })).toThrowError(expect.objectContaining({ code: 'sketch-split-precision' }));
  });
});
