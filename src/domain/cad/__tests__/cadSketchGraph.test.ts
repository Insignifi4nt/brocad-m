import { describe, expect, it } from 'vitest';
import { cadSketchGraphWithSolvedValues, cadSketchSolvedSlots, cadSketchSolvedValues, checkCadSketchGraph, parseCadSketchGraph } from '../cadSketchGraph';

const source = () => ({
  points: [{ id: 'a', position: ['origin', 0] }, { id: 'b', position: [10, 0] }],
  entities: [{ id: 'line', kind: 'line', startPointId: 'a', endPointId: 'b', construction: false }],
  relations: [{ id: 'horizontal', kind: 'horizontal', pointIds: ['a', 'b'] }]
});

describe('owned sketch graph source', () => {
  it('detaches and freezes exact source scalars while allowing an unsolved relation candidate', () => {
    const raw = source(); raw.points[1].position[1] = 3;
    const graph = parseCadSketchGraph(raw);
    raw.points[0].position[0] = 99;
    expect(graph.points[0].position).toEqual(['origin', 0]);
    expect(Object.isFrozen(graph)).toBe(true); expect(Object.isFrozen(graph.points[0].position)).toBe(true);
    expect(Object.isFrozen(graph.relations[0])).toBe(true);
    expect(checkCadSketchGraph(graph, { origin: 0 })).toMatchObject([
      { source: { kind: 'relation', id: 'horizontal' }, code: 'relation-residual', residualMm: 3 }
    ]);
    expect(graph.points[1].position).toEqual([10, 3]);
  });

  it('rejects duplicate identities, dangling references and nonportable data before reading accessors', () => {
    const duplicate = source(); duplicate.entities[0].id = 'a';
    expect(() => parseCadSketchGraph(duplicate)).toThrow('Duplicate');
    const dangling = source(); dangling.entities[0].endPointId = 'missing';
    expect(() => parseCadSketchGraph(dangling)).toThrow('missing');
    const relation = source(); relation.relations[0].pointIds[1] = 'line';
    expect(() => parseCadSketchGraph(relation)).toThrow('point');
    let reads = 0;
    expect(() => parseCadSketchGraph({ ...source(), get points() { reads++; return []; } })).toThrow();
    expect(reads).toBe(0);
    expect(() => parseCadSketchGraph({ ...source(), surprise: true })).toThrow();
  });

  it('refuses an edge or relation that names one point twice', () => {
    const points = [...source().points, { id: 'c', position: [0, 10] }];
    const repeats = [
      { points, entities: [{ id: 'line', kind: 'line', startPointId: 'a', endPointId: 'a', construction: false }], relations: [] },
      { points, entities: [{ id: 'arc', kind: 'arc', centerPointId: 'a', startPointId: 'a', endPointId: 'b', direction: 'ccw', construction: false }], relations: [] },
      { ...source(), relations: [{ id: 'join', kind: 'coincident', pointIds: ['b', 'b'] }] }
    ];
    for (const graph of repeats) expect(() => parseCadSketchGraph(graph)).toThrowError(expect.objectContaining({ code: 'invalid-sketch-reference' }));
    expect(parseCadSketchGraph({ points, entities: [{ id: 'arc', kind: 'arc', centerPointId: 'a', startPointId: 'b', endPointId: 'c', direction: 'ccw', construction: false }], relations: [] }).entities).toHaveLength(1);
  });

  it('returns an accepted graph as it is and parses copies, proxies and frozen lookalikes in full', () => {
    const graph = parseCadSketchGraph(source());
    expect(parseCadSketchGraph(graph)).toBe(graph);
    // A proxy cannot be detached, so it never passes for the graph it wraps.
    expect(() => parseCadSketchGraph(new Proxy(graph, {}))).toThrow();
    for (const copy of [structuredClone(graph), { ...graph }]) {
      const parsed = parseCadSketchGraph(copy);
      expect(parsed).not.toBe(graph); expect(parsed).toEqual(graph);
    }
    const lookalike = Object.freeze({ ...graph, relations: Object.freeze([...graph.relations, graph.relations[0]]) });
    expect(() => parseCadSketchGraph(lookalike)).toThrowError(expect.objectContaining({ code: 'duplicate-sketch-id' }));
    // A proxy that swaps checked data for a Map before the clone leaves a copy that is checked again.
    const raw = source(), entity = raw.entities[0];
    raw.entities[0] = new Proxy(entity, { get(target, key, receiver) {
      (raw.points[1] as { position: unknown }).position = new Map(); raw.entities[0] = entity; return Reflect.get(target, key, receiver);
    } });
    expect(() => parseCadSketchGraph(raw)).toThrowError(expect.objectContaining({ code: 'invalid-sketch-graph' }));
    // Numeric values only need their range: coincident points parse, an out-of-range one does not.
    const coincident = source(); coincident.points[1].position = [0, 0];
    expect(() => parseCadSketchGraph(coincident)).not.toThrow();
    const far = source(); far.points[1].position = [2e9, 0];
    expect(() => parseCadSketchGraph(far)).toThrow();
  });
  it('replaces only solved slots, in point then circle order, and accepts the result without parsing it', () => {
    const graph = parseCadSketchGraph({ points: [{ id: 'c', position: [5, 'y'] }, { id: 'a', position: ['origin', 0] }, { id: 'b', position: [10, 0] }],
      entities: [{ id: 'line', kind: 'line', startPointId: 'a', endPointId: 'b', construction: false },
        { id: 'fixed', kind: 'circle', centerPointId: 'c', radius: 'r', construction: true }, { id: 'circle', kind: 'circle', centerPointId: 'c', radius: 2, construction: false }],
      relations: [] });
    expect(cadSketchSolvedSlots(graph)).toEqual([{ kind: 'point', index: 0, axis: 0 }, { kind: 'point', index: 1, axis: 1 },
      { kind: 'point', index: 2, axis: 0 }, { kind: 'point', index: 2, axis: 1 }, { kind: 'radius', index: 2 }]);
    expect(cadSketchSolvedValues(graph)).toEqual([5, 0, 10, 0, 2]);
    const solved = cadSketchGraphWithSolvedValues(graph, [5, 0, 12, 3, 4]);
    expect(solved.points.map(point => point.position)).toEqual([[5, 'y'], ['origin', 0], [12, 3]]);
    expect(solved.entities[2]).toMatchObject({ radius: 4 });
    expect(solved.points[0]).toBe(graph.points[0]); expect(solved.entities[1]).toBe(graph.entities[1]); expect(solved.relations).toBe(graph.relations);
    expect(Object.isFrozen(solved) && Object.isFrozen(solved.points[2]) && Object.isFrozen(solved.points[2].position)).toBe(true);
    expect(parseCadSketchGraph(solved)).toBe(solved);
    for (const values of [[5, 0, 12, 3], [5, 0, 12, 3, Number.NaN], [5, 0, 12, 3, 1e10], [5, 0, 12, 3, '4']])
      expect(() => cadSketchGraphWithSolvedValues(graph, values)).toThrowError(expect.objectContaining({ code: 'invalid-sketch-solution' }));
  });
  it('checks all point relation drivers without modifying expressions or accepting physical gaps', () => {
    const graph = parseCadSketchGraph({
      points: [{ id: 'a', position: [2, 3] }, { id: 'b', position: [2, 8] }, { id: 'c', position: [2, 8] }], entities: [],
      relations: [
        { id: 'x', kind: 'fixed-axis', pointId: 'a', axis: 'x', value: 'origin' },
        { id: 'fixed', kind: 'fixed-point', pointId: 'a', position: [2, 'height'] },
        { id: 'vertical', kind: 'vertical', pointIds: ['a', 'b'] },
        { id: 'distance', kind: 'distance', pointIds: ['a', 'b'], value: 'span' },
        { id: 'join', kind: 'coincident', pointIds: ['b', 'c'] }
      ]
    });
    expect(checkCadSketchGraph(graph, { origin: 2, height: 3, span: 5 })).toEqual([]);
    const issues = checkCadSketchGraph(graph, { origin: 2.000001, height: 4, span: -1 });
    expect(issues.map(issue => issue.source.id)).toEqual(['x', 'fixed', 'distance']);
    expect(issues[2].code).toBe('invalid-distance');
    expect(graph.relations[0]).toMatchObject({ value: 'origin' });
    expect(checkCadSketchGraph(graph, {}).some(issue => issue.code === 'invalid-expression')).toBe(true);
  });

  it('separates arc structural residuals and invalid primitive dimensions from graph reference validity', () => {
    const graph = parseCadSketchGraph({
      points: [{ id: 'center', position: [0, 0] }, { id: 'start', position: [5, 0] }, { id: 'end', position: [0, 6] }],
      entities: [
        { id: 'arc', kind: 'arc', centerPointId: 'center', startPointId: 'start', endPointId: 'end', direction: 'ccw', construction: false },
        { id: 'circle', kind: 'circle', centerPointId: 'center', radius: 'radius', construction: true }
      ], relations: []
    });
    expect(checkCadSketchGraph(graph, { radius: -2 })).toMatchObject([
      { source: { kind: 'entity', id: 'arc' }, code: 'arc-radius-mismatch', residualMm: 1 },
      { source: { kind: 'entity', id: 'circle' }, code: 'invalid-radius' }
    ]);
    expect(graph.points[2].position).toEqual([0, 6]);
  });
});
