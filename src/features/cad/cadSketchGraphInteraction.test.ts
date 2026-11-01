import { circleRow, circleRowPart, rowSketch } from '@/domain/cad/__tests__/cadSketchLinearPatternFixtures';
import { describe, expect, it } from 'vitest';
import { parseCadSketchGraph, type CadSketchGraph } from '@/domain/cad/cadSketchGraph';
import type { CadSketchFeature } from '@/domain/cad/cadDocument';
import { applyCadEdits } from '@/domain/cad/cadOperations';
import { createCadDocument, parseCadDocument } from '@/domain/cad/cadSchema';
import { cadSketchGraphCircleControl, cadSketchGraphCircleRadiusEdit, cadSketchGraphPointTranslation, prepareCadSketchGraphInteraction } from './cadSketchGraphInteraction';
import { prepareCadViewportReferences } from './cadViewportReferences';

const source: CadSketchGraph = parseCadSketchGraph({ points: [
  { id: 'a', position: [0, 0] }, { id: 'b', position: [20, 0] }, { id: 'c', position: [20, 10] }, { id: 'd', position: [0, 10] }
], entities: [
  { id: 'ab', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' },
  { id: 'bc', kind: 'line', construction: false, startPointId: 'b', endPointId: 'c' },
  { id: 'cd', kind: 'line', construction: false, startPointId: 'c', endPointId: 'd' },
  { id: 'da', kind: 'line', construction: false, startPointId: 'd', endPointId: 'a' }
], relations: [] });

function circleSketch(): CadSketchFeature & { readonly graph: CadSketchGraph } {
  return { id: 'sketch', kind: 'sketch', name: 'Bores', plane: 'XY', offset: ' 0 ', suppressed: false,
    source: { format: 'dxf', fileName: 'Bores.dxf', text: '0\r\nSECTION\r\n2\r\nENTITIES\r\n0\r\nENDSEC\r\n0\r\nEOF\r\n' },
    profiles: [{ id: 'reference', name: 'Reference', construction: true, geometry: { kind: 'circle', x: '60', y: '7', radius: '2' } }],
    graph: parseCadSketchGraph({ points: [{ id: 'center', position: [' cx ', '7'] }, { id: 'other-center', position: [30, 7] }],
      entities: [{ id: 'bore', kind: 'circle', construction: false, centerPointId: 'center', radius: 5 },
        { id: 'other', kind: 'circle', construction: true, centerPointId: 'other-center', radius: ' otherRadius ' }],
      relations: [{ id: 'fixed-center', kind: 'fixed-point', pointId: 'center', position: [' cx ', '7'] }] }) };
}

describe('owned graph circle radius control', () => {
  it('keeps a linked numeric circle selectable for constraints while locking only its owned grip and radius', () => {
    const graph = parseCadSketchGraph({ points: [{ id: 'linked-center', position: [4, 6] }, { id: 'free-center', position: [30, 7] }],
      entities: [{ id: 'linked-circle', kind: 'circle', construction: true, centerPointId: 'linked-center', radius: 3 },
        { id: 'free-circle', kind: 'circle', construction: false, centerPointId: 'free-center', radius: 4 }],
      relations: [{ id: 'link', kind: 'external-reference', entityId: 'linked-circle', sourceSketchId: 'layout', source: { kind: 'circle', entityId: 'source-circle', centerPointId: 'source-center' } }] });
    const before = JSON.stringify(graph), prepared = prepareCadSketchGraphInteraction(graph, {});
    expect(prepared.points.map(point => point.freeAxes)).toEqual([[false, false], [true, true]]);
    expect(prepared.pick([7, 6], 0.01, 'edges')).toContainEqual({ kind: 'entity', id: 'linked-circle' });
    expect(cadSketchGraphCircleControl(graph, {}, 'linked-circle').lockedReason).toMatch(/detach/i);
    expect(cadSketchGraphCircleControl(graph, {}, 'free-circle').lockedReason).toBeNull();
    expect(() => cadSketchGraphCircleRadiusEdit({ id: 'target', name: 'Target', kind: 'sketch', suppressed: false, plane: 'XY', offset: 5, profiles: [], graph }, {}, 'linked-circle', 4)).toThrow(/detach/i);
    expect(JSON.stringify(graph)).toBe(before);
  });
  it('resizes only a free numeric circle radius while keeping its fixed center and all other source exact', () => {
    const sketch = circleSketch(), parameters = { cx: 3, otherRadius: 2 }, before = JSON.stringify(sketch);
    const control = cadSketchGraphCircleControl(sketch.graph, parameters, 'bore');
    expect(control).toEqual({ entityId: 'bore', center: [3, 7], radius: 5, lockedReason: null });
    expect(Object.isFrozen(control)).toBe(true); expect(Object.isFrozen(control.center)).toBe(true);
    const edit = cadSketchGraphCircleRadiusEdit(sketch, parameters, 'bore', 8);
    expect(edit.kind).toBe('update-feature');
    if (edit.feature.kind !== 'sketch' || !edit.feature.graph) throw new Error('Expected complete sketch update.');
    expect(edit.feature).toEqual({ ...sketch, graph: { ...sketch.graph, entities: [
      { id: 'bore', kind: 'circle', construction: false, centerPointId: 'center', radius: 8 }, sketch.graph.entities[1]
    ] } });
    expect(edit.feature.graph.points).toBe(sketch.graph.points); expect(edit.feature.graph.relations).toBe(sketch.graph.relations);
    expect(edit.feature.profiles).toBe(sketch.profiles); expect(edit.feature.source).toBe(sketch.source);
    const document = parseCadDocument({ ...createCadDocument(), schemaVersion: 2, parameters, features: [sketch] });
    expect(applyCadEdits(document, [edit]).features[0]).toEqual(edit.feature);
    expect(JSON.stringify(sketch)).toBe(before);
  });

  it('reports expression, radial-dimension and equal-radius ownership and refuses each radius edit without replacing its driver', () => {
    const source = circleSketch(), parameters = { cx: 3, otherRadius: 5, radius: 5 };
    const graphs = [
      parseCadSketchGraph({ ...source.graph, entities: source.graph.entities.map(entity => entity.id === 'bore' && entity.kind === 'circle' ? { ...entity, radius: ' radius ' } : entity) }),
      parseCadSketchGraph({ ...source.graph, entities: source.graph.entities.map(entity => entity.id === 'bore' && entity.kind === 'circle' ? { ...entity, radius: '5' } : entity) }),
      parseCadSketchGraph({ ...source.graph, relations: [...source.graph.relations, { id: 'size', kind: 'radial-size', entityId: 'bore', quantity: 'diameter', value: ' radius * 2 ' }] }),
      parseCadSketchGraph({ ...source.graph, relations: [...source.graph.relations, { id: 'equal', kind: 'equal-radius', curveIds: ['other', 'bore'] }] })
    ];
    for (const graph of graphs) {
      const sketch = { ...source, graph }, before = JSON.stringify(sketch), control = cadSketchGraphCircleControl(graph, parameters, 'bore');
      expect(control).toMatchObject({ entityId: 'bore', center: [3, 7], radius: 5 });
      expect(control.lockedReason).toBeTruthy();
      expect(() => cadSketchGraphCircleRadiusEdit(sketch, parameters, 'bore', 8)).toThrowError(expect.objectContaining({ code: 'locked-sketch-radius' }));
      expect(() => cadSketchGraphCircleRadiusEdit(sketch, parameters, 'bore', 5)).toThrowError(expect.objectContaining({ code: 'locked-sketch-radius' }));
      expect(JSON.stringify(sketch)).toBe(before);
    }
    const unrelated = parseCadSketchGraph({ ...source.graph, entities: source.graph.entities.map(entity => entity.id === 'other' && entity.kind === 'circle' ? { ...entity, radius: 5 } : entity),
      relations: [...source.graph.relations, { id: 'other-size', kind: 'radial-size', entityId: 'other', quantity: 'radius', value: 5 }] });
    expect(cadSketchGraphCircleControl(unrelated, parameters, 'bore').lockedReason).toBeNull();
  });

  it('uses existing radius and center limits without inventing a circle-extent cap or accepting missing targets', () => {
    const sketch = circleSketch(), parameters = { cx: 3, otherRadius: 2 }, before = JSON.stringify(sketch);
    for (const radius of [0, 1e-7, -1, 1e6 + 1, NaN, Infinity])
      expect(() => cadSketchGraphCircleRadiusEdit(sketch, parameters, 'bore', radius)).toThrowError(expect.objectContaining({ code: 'invalid-sketch-graph-geometry' }));
    for (const radius of [2e-7, 5, 1e6]) {
      const edit = cadSketchGraphCircleRadiusEdit(sketch, parameters, 'bore', radius);
      expect(edit.kind).toBe('update-feature');
      expect(() => applyCadEdits(parseCadDocument({ ...createCadDocument(), schemaVersion: 2, parameters, features: [sketch] }), [edit])).not.toThrow();
    }
    const farParameters = { ...parameters, cx: 1e9 }, far = parseCadDocument({ ...createCadDocument(), schemaVersion: 2, parameters: farParameters, features: [sketch] });
    expect(() => applyCadEdits(far, [cadSketchGraphCircleRadiusEdit(sketch, farParameters, 'bore', 1e6)])).not.toThrow();
    expect(() => cadSketchGraphCircleControl(source, {}, 'ab')).toThrowError(expect.objectContaining({ code: 'missing-sketch-circle' }));
    expect(() => cadSketchGraphCircleRadiusEdit(sketch, parameters, 'missing', 8)).toThrowError(expect.objectContaining({ code: 'missing-sketch-circle' }));
    expect(() => cadSketchGraphCircleRadiusEdit({ ...sketch, graph: undefined }, parameters, 'bore', 8)).toThrowError(expect.objectContaining({ code: 'missing-sketch-graph' }));
    expect(JSON.stringify(sketch)).toBe(before);
  });
});

describe('stable sketch point and entity interaction', () => {
  it('prioritizes the point over its closed boundary and retains all overlap candidates independent of source order', () => {
    const prepare = (graph: CadSketchGraph) => prepareCadSketchGraphInteraction(graph, {});
    const normal = prepare(source), reversed = prepare({ ...source, points: [...source.points].reverse(), entities: [...source.entities].reverse() });
    expect(normal.pick([20, 0], .1)).toEqual([{ kind: 'point', id: 'b' }, { kind: 'entity', id: 'ab' }, { kind: 'entity', id: 'bc' }]);
    expect(reversed.pick([20, 0], .1)).toEqual(normal.pick([20, 0], .1));
    expect(normal.pick([20.59, -0.59], .1)).not.toContainEqual({ kind: 'point', id: 'b' });
    expect(normal.pick([10, .59], .1)).toEqual([{ kind: 'entity', id: 'ab' }]);
    expect(normal.pick([10, .61], .1)).toEqual([]);
    expect(normal.pick([10, 5], .1)).toEqual([]);
  });

  it('filters point and edge candidates before ranking without changing default overlap picking', () => {
    const prepared = prepareCadSketchGraphInteraction(source, {});
    expect(prepared.pick([20, 0], .1, 'points')).toEqual([{ kind: 'point', id: 'b' }]);
    expect(prepared.pick([20, 0], .1, 'edges')).toEqual([{ kind: 'entity', id: 'ab' }, { kind: 'entity', id: 'bc' }]);
    expect(prepared.pick([20, 0], .1, 'auto')).toEqual(prepared.pick([20, 0], .1));
    expect(prepared.pick([10, 0], .1, 'points')).toEqual([]);
    expect(prepared.pick([10, 5], .1, 'edges')).toEqual([]);
  });

  it('distinguishes whole-entity containment from stroke crossing without implicitly adding endpoints', () => {
    const prepared = prepareCadSketchGraphInteraction(source, {}), bounds = { minX: -1, minY: -1, maxX: 10, maxY: 1 };
    expect(prepared.pickBox({ bounds, mode: 'window' })).toEqual([{ kind: 'point', id: 'a' }]);
    expect(prepared.pickBox({ bounds, mode: 'crossing' })).toEqual([{ kind: 'point', id: 'a' }, { kind: 'entity', id: 'ab' }, { kind: 'entity', id: 'da' }]);
    expect(prepared.pickBox({ bounds, mode: 'crossing', filter: 'edges' })).toEqual([{ kind: 'entity', id: 'ab' }, { kind: 'entity', id: 'da' }]);
    expect(prepared.pickBox({ bounds, mode: 'crossing', filter: 'points' })).toEqual([{ kind: 'point', id: 'a' }]);
    expect(prepared.pickBox({ bounds: { minX: 5, minY: -1, maxX: 15, maxY: 1 }, mode: 'crossing' })).toEqual([{ kind: 'entity', id: 'ab' }]);
  });

  it('rejects a diagonal AABB-only hit and retains collinear box-boundary contact', () => {
    const graph = parseCadSketchGraph({ points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [10, 10] }],
      entities: [{ id: 'diagonal', kind: 'line', startPointId: 'a', endPointId: 'b', construction: false }], relations: [] });
    expect(prepareCadSketchGraphInteraction(graph, {}).pickBox({ bounds: { minX: 0, minY: 9, maxX: 1, maxY: 10 }, mode: 'crossing' })).toEqual([]);
    const prepared = prepareCadSketchGraphInteraction(source, {}), bounds = { minX: 5, minY: 0, maxX: 15, maxY: 1 };
    expect(prepared.pickBox({ bounds, mode: 'crossing' })).toEqual([{ kind: 'entity', id: 'ab' }]);
    expect(prepared.pickBox({ bounds, mode: 'window' })).toEqual([]);
  });

  it('selects a circle stroke at crossings and tangency without treating its interior or center as an edge', () => {
    const graph = parseCadSketchGraph({ points: [{ id: 'center', position: [0, 0] }], entities: [{ id: 'circle', kind: 'circle', centerPointId: 'center', radius: 10, construction: true }], relations: [] });
    const prepared = prepareCadSketchGraphInteraction(graph, {}), inner = { minX: -1, minY: -1, maxX: 1, maxY: 1 };
    expect(prepared.pickBox({ bounds: inner, mode: 'crossing', filter: 'edges' })).toEqual([]);
    expect(prepared.pickBox({ bounds: inner, mode: 'crossing' })).toEqual([{ kind: 'point', id: 'center' }]);
    expect(prepared.pickBox({ bounds: { minX: -1, minY: 9.9, maxX: 1, maxY: 10.1 }, mode: 'crossing' })).toEqual([{ kind: 'entity', id: 'circle' }]);
    expect(prepared.pickBox({ bounds: { minX: -1, minY: 10, maxX: 1, maxY: 11 }, mode: 'crossing' })).toEqual([{ kind: 'entity', id: 'circle' }]);
    expect(prepared.pickBox({ bounds: { minX: -1, minY: 10.000001, maxX: 1, maxY: 11 }, mode: 'crossing' })).toEqual([]);
    expect(prepared.pickBox({ bounds: { minX: -10, minY: -10, maxX: 10, maxY: 10 }, mode: 'window', filter: 'edges' })).toEqual([{ kind: 'entity', id: 'circle' }]);
  });

  it('uses signed circular sweeps and full analytic extrema instead of endpoint chords or AABB overlap', () => {
    const make = (reverse = false) => parseCadSketchGraph({ points: [{ id: 'center', position: [0, 0] }, { id: 'start', position: [10, 0] }, { id: 'end', position: [0, 10] }], entities: [
      { id: 'major', kind: 'arc', centerPointId: 'center', startPointId: reverse ? 'end' : 'start', endPointId: reverse ? 'start' : 'end', direction: reverse ? 'ccw' : 'cw', construction: false },
      { id: 'minor', kind: 'arc', centerPointId: 'center', startPointId: reverse ? 'end' : 'start', endPointId: reverse ? 'start' : 'end', direction: reverse ? 'cw' : 'ccw', construction: true }
    ], relations: [] });
    for (const graph of [make(), make(true)]) {
      const prepared = prepareCadSketchGraphInteraction(graph, {});
      expect(prepared.pickBox({ bounds: { minX: -10.1, minY: -.1, maxX: -9.9, maxY: .1 }, mode: 'crossing', filter: 'edges' })).toEqual([{ kind: 'entity', id: 'major' }]);
      expect(prepared.pickBox({ bounds: { minX: 6.9, minY: 6.9, maxX: 7.2, maxY: 7.2 }, mode: 'crossing', filter: 'edges' })).toEqual([{ kind: 'entity', id: 'minor' }]);
      expect(prepared.pickBox({ bounds: { minX: 4, minY: 4, maxX: 6, maxY: 6 }, mode: 'crossing', filter: 'edges' })).toEqual([]);
      expect(prepared.pickBox({ bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 }, mode: 'window', filter: 'edges' })).toEqual([{ kind: 'entity', id: 'minor' }]);
      expect(prepared.pickBox({ bounds: { minX: -10, minY: -10, maxX: 10, maxY: 10 }, mode: 'window', filter: 'edges' })).toEqual([{ kind: 'entity', id: 'major' }, { kind: 'entity', id: 'minor' }]);
    }
  });

  it('retains analytic crossing and containment for tiny curves and curves far from the origin', () => {
    for (const parameters of [{ x: 0, y: 0, radius: .00002 }, { x: 1e8, y: -2e8, radius: 10 }]) {
      const graph = parseCadSketchGraph({ points: [{ id: 'center', position: [' x ', ' y '] }, { id: 'start', position: ['x + radius', 'y'] }, { id: 'end', position: ['x', 'y + radius'] }], entities: [
        { id: 'major', kind: 'arc', centerPointId: 'center', startPointId: 'start', endPointId: 'end', direction: 'cw', construction: false },
        { id: 'circle', kind: 'circle', centerPointId: 'center', radius: ' radius ', construction: true }
      ], relations: [] }), before = JSON.stringify(graph), prepared = prepareCadSketchGraphInteraction(graph, parameters), { x, y, radius: r } = parameters;
      expect(prepared.pickBox({ bounds: { minX: x - 1.1 * r, minY: y - .1 * r, maxX: x - .9 * r, maxY: y + .1 * r }, mode: 'crossing', filter: 'edges' })).toEqual([{ kind: 'entity', id: 'circle' }, { kind: 'entity', id: 'major' }]);
      expect(prepared.pickBox({ bounds: { minX: x - r, minY: y - r, maxX: x + r, maxY: y + r }, mode: 'window', filter: 'edges' })).toEqual([{ kind: 'entity', id: 'circle' }, { kind: 'entity', id: 'major' }]);
      expect(JSON.stringify(graph)).toBe(before);
    }
  });

  it('keeps empty-space boxes empty even when distant box extents dwarf the source geometry', () => {
    const graph = parseCadSketchGraph({ points: [{ id: 'center', position: [0, 0] }], entities: [{ id: 'circle', kind: 'circle', centerPointId: 'center', radius: 10, construction: false }], relations: [] });
    const prepared = prepareCadSketchGraphInteraction(graph, {});
    for (const mode of ['window', 'crossing'] as const)
      expect(prepared.pickBox({ bounds: { minX: -1e100, minY: 100, maxX: 1e100, maxY: 101 }, mode })).toEqual([]);
    expect(prepared.pickBox({ bounds: { minX: -1e100, minY: -1, maxX: 1e100, maxY: 1 }, mode: 'crossing', filter: 'edges' })).toEqual([{ kind: 'entity', id: 'circle' }]);
  });

  it('returns stable detached targets independently of graph order and later query mutation', () => {
    const before = JSON.stringify(source), bounds = { minX: -1, minY: -1, maxX: 21, maxY: 11 };
    const normal = prepareCadSketchGraphInteraction(source, {}), reversed = prepareCadSketchGraphInteraction({ ...source, points: [...source.points].reverse(), entities: [...source.entities].reverse() }, {});
    const hits = normal.pickBox({ bounds, mode: 'window' });
    expect(hits).toEqual([{ kind: 'point', id: 'a' }, { kind: 'point', id: 'b' }, { kind: 'point', id: 'c' }, { kind: 'point', id: 'd' },
      { kind: 'entity', id: 'ab' }, { kind: 'entity', id: 'bc' }, { kind: 'entity', id: 'cd' }, { kind: 'entity', id: 'da' }]);
    expect(reversed.pickBox({ bounds, mode: 'window' })).toEqual(hits);
    expect(normal.pickBox({ bounds, mode: 'window' })[0]).not.toBe(hits[0]);
    expect(Reflect.set(hits[0], 'id', 'poisoned')).toBe(false);
    const pointHits = normal.pick([0, 0], .1); Reflect.set(pointHits[0], 'id', 'poisoned');
    expect(normal.pick([0, 0], .1)[0]).toEqual({ kind: 'point', id: 'a' });
    bounds.maxX = 1;
    expect(hits[1]).toEqual({ kind: 'point', id: 'b' });
    expect(normal.pickBox({ bounds, mode: 'window', filter: 'points' })).toEqual([{ kind: 'point', id: 'a' }, { kind: 'point', id: 'd' }]);
    expect(JSON.stringify(source)).toBe(before);
  });

  it('fails safely for nonfinite points/scales and nonfinite, reversed or zero-area box bounds', () => {
    const prepared = prepareCadSketchGraphInteraction(source, {});
    for (const scale of [0, -1, NaN, Infinity, 1e308]) expect(prepared.pick([0, 0], scale)).toEqual([]);
    expect(prepared.pick([NaN, 0], 1)).toEqual([]);
    expect(prepared.pick([0, Infinity], 1)).toEqual([]);
    for (const bounds of [{ minX: NaN, minY: 0, maxX: 1, maxY: 1 }, { minX: 0, minY: 0, maxX: Infinity, maxY: 1 },
      { minX: 1, minY: 0, maxX: 0, maxY: 1 }, { minX: 0, minY: 1, maxX: 1, maxY: 0 },
      { minX: 0, minY: 0, maxX: 0, maxY: 1 }, { minX: 0, minY: 0, maxX: 1, maxY: 0 }])
      for (const mode of ['window', 'crossing'] as const) expect(prepared.pickBox({ bounds, mode })).toEqual([]);
    const empty = prepareCadSketchGraphInteraction(parseCadSketchGraph({ points: [], entities: [], relations: [] }), {});
    expect(empty.pickBox({ bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 }, mode: 'crossing' })).toEqual([]);
  });

  it('hits exact circular and signed major arc supports without their complementary extensions', () => {
    const graph = parseCadSketchGraph({ points: [{ id: 'center', position: [0, 0] }, { id: 'start', position: [10, 0] }, { id: 'end', position: [0, 10] }, { id: 'other', position: [30, 0] }],
      entities: [{ id: 'arc', kind: 'arc', construction: false, centerPointId: 'center', startPointId: 'start', endPointId: 'end', direction: 'cw' },
        { id: 'circle', kind: 'circle', construction: true, centerPointId: 'other', radius: 5 }], relations: [] });
    const prepared = prepareCadSketchGraphInteraction(graph, {});
    expect(prepared.pick([-10.05, 0], .01)).toEqual([{ kind: 'entity', id: 'arc' }]);
    expect(prepared.pick([Math.sqrt(50), Math.sqrt(50)], .01)).toEqual([]);
    expect(prepared.pick([30, 5.05], .01)).toEqual([{ kind: 'entity', id: 'circle' }]);
    expect(prepared.pick([0, 0], .01)[0]).toEqual({ kind: 'point', id: 'center' });
  });

  it('preserves exact per-axis expression and explicit fixed drivers when moving an otherwise free point', () => {
    const graph = parseCadSketchGraph({ points: [{ id: 'mixed', position: [' offset ', 7] }, { id: 'fixed', position: [4, 5] }, { id: 'axis', position: [8, 9] }], entities: [],
      relations: [{ id: 'fix', kind: 'fixed-point', pointId: 'fixed', position: [4, 5] }, { id: 'x', kind: 'fixed-axis', pointId: 'axis', axis: 'x', value: 8 }] });
    const prepared = prepareCadSketchGraphInteraction(graph, { offset: 3 });
    expect(prepared.points.map(point => [point.id, point.freeAxes])).toEqual([['mixed', [false, true]], ['fixed', [false, false]], ['axis', [false, true]]]);
    expect(cadSketchGraphPointTranslation(prepared.points[0], [20, 12])).toEqual([0, 5]);
    expect(cadSketchGraphPointTranslation(prepared.points[1], [20, 12])).toEqual([0, 0]);
    expect(cadSketchGraphPointTranslation(prepared.points[2], [20, 12])).toEqual([0, 3]);
    expect(graph.points[0].position).toEqual([' offset ', 7]);
  });
});


describe('pattern copy interaction ownership', () => {
  it('keeps copies selectable but locks their center and radius grips until detach, while the free seed stays movable', () => {
    const document = applyCadEdits(circleRowPart(true), [{kind:'set-sketch-relation', sketchId:'sketch',relation:circleRow}]);
    const sketch = rowSketch(document), view = prepareCadSketchGraphInteraction(sketch.graph, document.parameters);
    expect(view.points.find(p=>p.id==='center')?.freeAxes).toEqual([true,true]);
    expect(view.points.find(p=>p.id==='holes_i1_p0')?.freeAxes).toEqual([false,false]);
    expect(cadSketchGraphCircleControl(sketch.graph,document.parameters,'holes_i1_e0').lockedReason).toContain('pattern');
    expect(()=>cadSketchGraphCircleRadiusEdit(sketch,document.parameters,'holes_i1_e0',4)).toThrow();
    expect(view.pick([28,10],.1,'edges')).toContainEqual({kind:'entity',id:'holes_i1_e0'});
    const detached=applyCadEdits(document,[{kind:'remove-sketch-relation',sketchId:'sketch',relationId:'row'}]), independent=rowSketch(detached);
    expect(prepareCadSketchGraphInteraction(independent.graph,detached.parameters).points.find(p=>p.id==='holes_i1_p0')?.freeAxes).toEqual([true,true]);
    expect(cadSketchGraphCircleControl(independent.graph,detached.parameters,'holes_i1_e0').lockedReason).toBeNull();
  });
});

describe('prepared sketch work across dimension moves', () => {
  it('keeps the interaction, snaps and viewport references of the sketch a dimension move was placed from, and prepares a geometry change again', () => {
    const document = parseCadDocument({ ...createCadDocument('Moves', 'moves'), schemaVersion: 2, features: [{ id: 'sketch', kind: 'sketch', name: 'Plate', plane: 'XY', offset: 0,
      suppressed: false, profiles: [], graph: { ...source, relations: [{ id: 'width', kind: 'distance', pointIds: ['a', 'b'], value: 20 }] } }] });
    const sketchOf = (part: typeof document) => part.features[0] as CadSketchFeature & { readonly graph: CadSketchGraph };
    const prepared = prepareCadSketchGraphInteraction(sketchOf(document).graph, document.parameters);
    const references = prepareCadViewportReferences(document.features, document.parameters);
    const relation = sketchOf(document).graph.relations[0];
    let placed = document;
    for (const offset of [5, -3]) {
      placed = applyCadEdits(placed, [{ kind: 'set-sketch-relation', sketchId: 'sketch', relation: { ...relation, annotation: { kind: 'linear', offset, along: 0.5 } } as typeof relation }]);
      const moved = prepareCadSketchGraphInteraction(sketchOf(placed).graph, placed.parameters);
      // The moved dimension is drawn from the new graph; points, geometry and snaps are the ones already prepared.
      expect(moved.graph).toBe(sketchOf(placed).graph);
      expect(moved.points).toBe(prepared.points); expect(moved.geometry).toBe(prepared.geometry); expect(moved.snap).toBe(prepared.snap);
      prepareCadViewportReferences(placed.features, placed.parameters).forEach((reference, index) => expect(reference).toBe(references[index]));
    }
    const nudged = applyCadEdits(placed, [{ kind: 'move-sketch-point', sketchId: 'sketch', pointId: 'c', translation: [1, 0] }]);
    const changed = prepareCadSketchGraphInteraction(sketchOf(nudged).graph, nudged.parameters);
    expect(changed.points).not.toBe(prepared.points); expect(changed.points.find(point => point.id === 'c')?.position).toEqual([21, 10]);
    expect(prepareCadViewportReferences(nudged.features, nudged.parameters).some((reference, index) => reference !== references[index])).toBe(true);
  });
});
