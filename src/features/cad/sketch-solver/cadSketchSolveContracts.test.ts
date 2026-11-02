// @vitest-environment node
// What a sketch solve promises its callers, answered by the native solver alone.
import { describe, expect, it } from 'vitest';
import { checkCadSketchGraph, parseCadSketchGraph } from '../../../domain/cad/cadSketchGraph';
import { resolveCadSketchRegions } from '@/domain/cad/cadSketchGeometry';
import { measureCadResolvedProfile } from '@/domain/cad/cadMeasurements';
import { createCadBenchmarkRectangleGraph } from '../benchmark/cadBenchmarkCases';
import { cadSketchSolverWireResult, parseCadSketchSolveInput, parseCadSketchSolverReply } from './cadSketchSolverProtocol';
import { circleReferencePart } from '@/domain/cad/__tests__/cadSketchExternalReferenceFixtures';
import { expectNoUnexpectedNativeFailures } from './__tests__/cadSketchNativeFailures';
import { createCadSketchTestSolver, loadCadSketchTestNativeSolver } from './__tests__/cadSketchTestSolver';
import type { CadSketchNativeSolver } from './native/cadSketchNativeSolver';

describe('sketch solving', () => {
  it('preserves scalar-free measurements without native equations or a change in freedom', async () => {
    const graph = parseCadSketchGraph({ points: [{ id: 'a', position: [' 0 ', '0'] }, { id: 'b', position: [20, 0] }, { id: 'center', position: [50, 0] }],
      entities: [{ id: 'line', kind: 'line', construction: true, startPointId: 'a', endPointId: 'b' },
        { id: 'circle', kind: 'circle', construction: false, centerPointId: 'center', radius: ' radius ' }], relations: [] });
    const measured = parseCadSketchGraph({ ...graph, relations: [
      { id: 'length', kind: 'reference-dimension', measurement: { kind: 'line-length', entityId: 'line' } },
      { id: 'pair', kind: 'reference-dimension', measurement: { kind: 'point-distance', pointIds: ['center', 'b'] } },
      { id: 'diameter', kind: 'reference-dimension', measurement: { kind: 'radial-size', entityId: 'circle', quantity: 'diameter' } }
    ] });
    const runtime = createCadSketchTestSolver(), baseline = await runtime.solve({ graph, parameters: { radius: 3 } });
    const result = await runtime.solve({ graph: measured, parameters: { radius: 3 } });
    expect(baseline.kind).toBe('solved'); expect(result.kind).toBe('solved');
    if (baseline.kind !== 'solved' || result.kind !== 'solved') throw new Error('Expected real native solves.');
    expect(result.diagnostics).toEqual(baseline.diagnostics); expect(result.diagnostics.degreesOfFreedom).toBe(4);
    expect(result.graph).toEqual(measured); expect(result.graph.points).toEqual(baseline.graph.points);
  });
  it('solves numeric copies and reports the fixed horizontal line degrees of freedom', async () => {
    const graph = parseCadSketchGraph({
      points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [18, 4] }],
      entities: [{ id: 'line', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' }],
      relations: [
        { id: 'origin', kind: 'fixed-point', pointId: 'a', position: [0, 0] },
        { id: 'horizontal', kind: 'horizontal', pointIds: ['a', 'b'] },
        { id: 'length', kind: 'distance', pointIds: ['a', 'b'], value: 20 }
      ]
    });
    const before = JSON.stringify(graph), runtime = createCadSketchTestSolver();
    const result = await runtime.solve({ graph, parameters: {} });
    expect(result.kind).toBe('solved');
    if (result.kind !== 'solved') throw new Error(result.message);
    expect(result.graph.points[1].position[0]).toBeCloseTo(20, 8);
    expect(result.graph.points[1].position[1]).toBeCloseTo(0, 8);
    expect(result.diagnostics).toMatchObject({ status: 'success', degreesOfFreedom: 0, conflictingIds: [], redundantIds: [], partiallyRedundantIds: [], issues: [] });
    expect(Object.isFrozen(result.graph)).toBe(true);
    expect(JSON.stringify(graph)).toBe(before);
  });
  it('solves the implicit arc radius while preserving clockwise major-arc intent and exact driver strings', async () => {
    const graph = parseCadSketchGraph({ points: [
      { id: 'center', position: ['0', '0'] }, { id: 'start', position: [' r / 2 ', 0] }, { id: 'end', position: [0, 12] }
    ], entities: [{ id: 'arc', kind: 'arc', construction: false, centerPointId: 'center', startPointId: 'start', endPointId: 'end', direction: 'cw' }],
    relations: [
      { id: 'start-axis', kind: 'fixed-axis', pointId: 'start', axis: 'y', value: 0 },
      { id: 'end-axis', kind: 'fixed-axis', pointId: 'end', axis: 'x', value: 0 }
    ] });
    const result = await createCadSketchTestSolver().solve({ graph, parameters: { r: 20 } });
    expect(result.kind).toBe('solved');
    if (result.kind !== 'solved') throw new Error(result.message);
    expect(result.graph.points[1].position).toEqual([' r / 2 ', 0]);
    expect(result.graph.points[2].position[1]).toBeCloseTo(10, 7);
    expect(result.graph.entities[0]).toEqual(graph.entities[0]);
    expect(result.diagnostics.degreesOfFreedom).toBe(0);
  });
  it('captures parameter inputs before asynchronous native initialization', async () => {
    const native = await loadCadSketchTestNativeSolver();
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const runtime = createCadSketchTestSolver({ loadNative: async () => { await gate; return native; } });
    const graph = parseCadSketchGraph({ points: [{ id: 'a', position: ['0', '0'] }, { id: 'b', position: [15, 0] }], entities: [], relations: [
      { id: 'horizontal', kind: 'horizontal', pointIds: ['a', 'b'] }, { id: 'length', kind: 'distance', pointIds: ['a', 'b'], value: 'length' }
    ] });
    const parameters = { length: 20 }, pending = runtime.solve({ graph, parameters });
    parameters.length = 30; release();
    const result = await pending;
    expect(result.kind).toBe('solved');
    if (result.kind !== 'solved') throw new Error(result.message);
    expect(result.graph.points[1].position[0]).toBeCloseTo(20, 8);
    expect(parameters.length).toBe(30);
  });
  it('drags free and dimensioned endpoints with temporary targets without saving those targets', async () => {
    const runtime = createCadSketchTestSolver();
    const graph = parseCadSketchGraph({ points: [{ id: 'a', position: ['0', '0'] }, { id: 'b', position: [10, 5] }], entities: [], relations: [] });
    const free = await runtime.solve({ graph, parameters: {}, drag: { pointId: 'b', position: [35, 12] } });
    expect(free.kind).toBe('solved');
    if (free.kind !== 'solved') throw new Error(free.message);
    expect(free.graph.points[1].position).toEqual([35, 12]);
    expect(free.graph.relations).toEqual([]); expect(free.diagnostics.degreesOfFreedom).toBe(2);
    const dimensioned = parseCadSketchGraph({ ...graph, relations: [{ id: 'length', kind: 'distance', pointIds: ['a', 'b'], value: 20 }] });
    const limited = await runtime.solve({ graph: dimensioned, parameters: {}, drag: { pointId: 'b', position: [35, 12] } });
    expect(limited.kind).toBe('solved');
    if (limited.kind !== 'solved') throw new Error(limited.message);
    expect(Math.hypot(Number(limited.graph.points[1].position[0]), Number(limited.graph.points[1].position[1]))).toBeCloseTo(20, 10);
    expect(limited.graph.relations).toEqual(dimensioned.relations); expect(limited.diagnostics.degreesOfFreedom).toBe(1);
  });
  it('keeps circle radius expressions fixed while allowing its numeric center to move', async () => {
    const graph = parseCadSketchGraph({ points: [{ id: 'center', position: [0, 0] }], entities: [
      { id: 'circle', kind: 'circle', construction: true, centerPointId: 'center', radius: ' diameter / 2 ' }
    ], relations: [] });
    const result = await createCadSketchTestSolver().solve({ graph, parameters: { diameter: 14 }, drag: { pointId: 'center', position: [5, 6] } });
    expect(result.kind).toBe('solved');
    if (result.kind !== 'solved') throw new Error(result.message);
    expect(result.graph.points[0].position).toEqual([5, 6]); expect(result.graph.entities[0]).toEqual(graph.entities[0]);
    expect(result.diagnostics.degreesOfFreedom).toBe(2);
  });
  it('reports redundant and conflicting relation identities without publishing a candidate, then recovers', async () => {
    const graph = parseCadSketchGraph({ points: [{ id: 'a', position: ['0', '0'] }, { id: 'b', position: [18, 4] }], entities: [], relations: [
      { id: 'horizontal', kind: 'horizontal', pointIds: ['a', 'b'] }, { id: 'length', kind: 'distance', pointIds: ['a', 'b'], value: 20 }
    ] });
    const runtime = createCadSketchTestSolver(), before = JSON.stringify(graph);
    const redundant = await runtime.solve({ graph: parseCadSketchGraph({ ...graph, relations: [...graph.relations,
      { id: 'duplicate', kind: 'distance', pointIds: ['a', 'b'], value: 20 }] }), parameters: {} });
    expect(redundant).toMatchObject({ kind: 'rejected', reason: 'redundant', diagnostics: { status: 'success', redundantIds: ['duplicate'] } });
    const conflict = await runtime.solve({ graph: parseCadSketchGraph({ ...graph, relations: [...graph.relations,
      { id: 'contradiction', kind: 'distance', pointIds: ['a', 'b'], value: 30 }] }), parameters: {} });
    expect(conflict).toMatchObject({ kind: 'rejected', reason: 'conflicting', diagnostics: { status: 'failed', conflictingIds: ['length', 'contradiction'] } });
    expect('graph' in conflict).toBe(false); expect(JSON.stringify(graph)).toBe(before);
    for (let index = 0; index < 50; index++) expect((await runtime.solve({ graph, parameters: {} })).kind).toBe('solved');
  });
  it('rejects a native success whose geometry fails independent graph validation', async () => {
    const graph = parseCadSketchGraph({ points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [0, 0] }], entities: [
      { id: 'zero-line', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' }
    ], relations: [] });
    const result = await createCadSketchTestSolver().solve({ graph, parameters: {} });
    expect(result).toMatchObject({ kind: 'rejected', reason: 'invalid-solution', diagnostics: { status: 'success', issues: [{ source: { kind: 'entity', id: 'zero-line' }, code: 'degenerate-entity' }] } });
  });
  it('solves distinct rectangle endpoints through coincident, horizontal and vertical relations', async () => {
    const graph = parseCadSketchGraph({
      points: [[0, 0], [18, 1], [19, 0], [20, 11], [19, 12], [-1, 10], [0, 11], [-1, -1]].map((position, index) => ({ id: `p${index}`, position })),
      entities: [0, 1, 2, 3].map(index => ({ id: `line${index}`, kind: 'line', construction: false, startPointId: `p${index * 2}`, endPointId: `p${index * 2 + 1}` })),
      relations: [
        ...[0, 1, 2, 3].map(index => ({ id: `join${index}`, kind: 'coincident', pointIds: [`p${index * 2 + 1}`, `p${(index * 2 + 2) % 8}`] })),
        ...[0, 1, 2, 3].map(index => ({ id: `axis${index}`, kind: index % 2 ? 'vertical' : 'horizontal', pointIds: [`p${index * 2}`, `p${index * 2 + 1}`] })),
        { id: 'origin', kind: 'fixed-point', pointId: 'p0', position: [0, 0] },
        { id: 'width', kind: 'distance', pointIds: ['p0', 'p1'], value: 20 },
        { id: 'height', kind: 'distance', pointIds: ['p2', 'p3'], value: 10 }
      ]
    });
    const result = await createCadSketchTestSolver().solve({ graph, parameters: {} });
    expect(result.kind).toBe('solved'); if (result.kind !== 'solved') throw new Error(result.message);
    expect(result.diagnostics.degreesOfFreedom).toBe(0);
    expect(result.graph.points.map(point => point.position)).toEqual([[0, 0], [20, 0], [20, 0], [20, 10], [20, 10], [0, 10], [0, 10], [0, 0]]);
    expect(result.graph.points.map(point => point.id)).toEqual(graph.points.map(point => point.id));
    expect(result.graph.relations).toEqual(graph.relations);
    const material = resolveCadSketchRegions({ id: 'sketch', kind: 'sketch', name: 'Joined rectangle', suppressed: false,
      plane: 'XY', offset: 0, profiles: [], graph: result.graph }, {});
    expect(material).toHaveLength(1);
    expect(measureCadResolvedProfile(material[0].boundary.geometry).areaMm2).toBe(200);
  });
  it('solves an oblique endpoint arc directly through its equal-radius structural relation', async () => {
    const graph = parseCadSketchGraph({ points: [
      { id: 'center', position: ['0', '0'] }, { id: 'start', position: ['86.16952767655165', '49.74999999999999'] },
      { id: 'end', position: ['-81.50562840675468', 68.48502650031552] }
    ], entities: [{ id: 'arc', kind: 'arc', construction: false, centerPointId: 'center', startPointId: 'start', endPointId: 'end', direction: 'ccw' }], relations: [] });
    const result = await createCadSketchTestSolver().solve({ graph, parameters: {} });
    expect(result.kind).toBe('solved'); if (result.kind !== 'solved') throw new Error(result.message);
    expect(result.graph.points[2].position[1]).toBeCloseTo(57.07085541692911, 9);
    expect(result.diagnostics.degreesOfFreedom).toBe(0);
  });
  it('solves an oblique arc to strict source closure, and rejects a solver success that misses it', async () => {
    const graph = parseCadSketchGraph({ points: [
      { id: 'center', position: ['0', '0'] }, { id: 'start', position: [String(.25 * Math.cos(Math.PI / 6)), String(.25 * Math.sin(Math.PI / 6))] },
      { id: 'end', position: [String(.25 * Math.cos(145 * Math.PI / 180)), .3 * Math.sin(145 * Math.PI / 180)] }
    ], entities: [{ id: 'arc', kind: 'arc', construction: false, centerPointId: 'center', startPointId: 'start', endPointId: 'end', direction: 'ccw' }], relations: [] });
    const solved = await createCadSketchTestSolver().solve({ graph, parameters: {} });
    expect(solved.kind).toBe('solved'); if (solved.kind !== 'solved') throw new Error(solved.message);
    expect(checkCadSketchGraph(solved.graph, {})).toEqual([]);
    // A solver that reports success where it started, short of closure, as PlaneGCS did here.
    const stuck = async (): Promise<CadSketchNativeSolver> => {
      const native = await loadCadSketchTestNativeSolver();
      return { ...native, solve: model => ({ ...native.solve(model), values: model.values }) };
    };
    const result = await createCadSketchTestSolver({ loadNative: stuck }).solve({ graph, parameters: {} });
    expect(result).toMatchObject({ kind: 'rejected', reason: 'invalid-solution', diagnostics: { status: 'success', issues: [{
      source: { kind: 'entity', id: 'arc' }, code: 'arc-radius-mismatch', residualMm: expect.any(Number)
    }] } });
    expect('graph' in result).toBe(false);
  });

  it('fails a test whose native solve trapped, even where the test expects a rejection', async () => {
    const graph = parseCadSketchGraph({ points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [10, 0] }], entities: [],
      relations: [{ id: 'gap', kind: 'distance', pointIds: ['a', 'b'], value: 10 }] });
    const trapping = async (): Promise<CadSketchNativeSolver> => {
      const native = await loadCadSketchTestNativeSolver();
      return { ...native, solve: () => { throw new WebAssembly.RuntimeError('unreachable'); } };
    };
    await expect(createCadSketchTestSolver({ loadNative: trapping }).solve({ graph, parameters: {} })).rejects.toThrow('could not run');
    // The setup files' check after each test; called here, it also clears what this test met.
    expect(expectNoUnexpectedNativeFailures).toThrow(/met 1 native failure/);
    expect(expectNoUnexpectedNativeFailures).not.toThrow();
    await expect(createCadSketchTestSolver({ loadNative: trapping, allowNativeFailure: true }).solve({ graph, parameters: {} })).rejects.toMatchObject({ code: 'sketch-failed', native: 'failed' });
    expect(expectNoUnexpectedNativeFailures).not.toThrow();
  });
});

describe('independent solver groups', () => {
  type Part = { points: unknown[]; entities: unknown[]; relations: unknown[] };
  const merge = (...parts: Part[]) => parseCadSketchGraph({ points: parts.flatMap(part => part.points), entities: parts.flatMap(part => part.entities), relations: parts.flatMap(part => part.relations) });
  const line: Part = { points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [18, 4] }], entities: [{ id: 'line', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' }],
    relations: [{ id: 'origin', kind: 'fixed-point', pointId: 'a', position: [0, 0] }, { id: 'horizontal', kind: 'horizontal', pointIds: ['a', 'b'] }] };
  const conflict: Part = { points: [{ id: 'c', position: [50, 0] }, { id: 'd', position: [60, 1] }], entities: [{ id: 'cd', kind: 'line', construction: false, startPointId: 'c', endPointId: 'd' }],
    relations: [{ id: 'c-x', kind: 'fixed-axis', pointId: 'c', axis: 'x', value: 50 }, { id: 'c-x-again', kind: 'fixed-axis', pointId: 'c', axis: 'x', value: 51 }] };
  const redundant: Part = { points: [{ id: 'e', position: [80, 0] }], entities: [],
    relations: [{ id: 'e-y', kind: 'fixed-axis', pointId: 'e', axis: 'y', value: 0 }, { id: 'e-y-again', kind: 'fixed-axis', pointId: 'e', axis: 'y', value: 0 }] };
  // Each unfixed parameter is free: f contributes x, y and its radius; g only its numeric y.
  const free: Part = { points: [{ id: 'f', position: [90, 0] }, { id: 'g', position: ['w', 3] }], relations: [], entities: [
    { id: 'circle', kind: 'circle', construction: false, centerPointId: 'f', radius: 4 }, { id: 'fixed-circle', kind: 'circle', construction: false, centerPointId: 'g', radius: 'w' }] };

  it('diagnoses each group as it would be alone and sums freedom unless relations conflict', async () => {
    const runtime = createCadSketchTestSolver(), solve = (...parts: Part[]) => runtime.solve({ graph: merge(...parts), parameters: { w: 2 } });
    expect((await solve(line)).diagnostics.degreesOfFreedom).toBe(1);
    expect(await solve(line, redundant, conflict, free)).toEqual({ kind: 'rejected', reason: 'conflicting', message: 'Sketch constraints conflict.', diagnostics: {
      status: 'failed', degreesOfFreedom: null, conflictingIds: ['c-x', 'c-x-again'], redundantIds: ['e-y-again'], partiallyRedundantIds: [], issues: [] } });
    expect(await solve(line, redundant)).toMatchObject({ kind: 'rejected', reason: 'redundant', diagnostics: { status: 'success', degreesOfFreedom: 2, redundantIds: ['e-y-again'] } });
    const solved = await solve(line, free);
    expect(solved).toMatchObject({ kind: 'solved', diagnostics: { status: 'success', degreesOfFreedom: 5 } });
    if (solved.kind === 'solved') expect(solved.graph.entities.slice(1)).toEqual(merge(free).entities);
  });

  it('diagnoses relations on fully fixed geometry as one sketch-wide system did', async () => {
    // PlaneGCS skipped diagnosis without unknowns, so fixed relations are diagnosed in an auxiliary system.
    const runtime = createCadSketchTestSolver(), fixed = (value: number, ...more: Part[]) => runtime.solve({ parameters: {}, graph: merge(
      { points: [{ id: 'p', position: ['0', '0'] }], entities: [], relations: [{ id: 'p-x', kind: 'fixed-axis', pointId: 'p', axis: 'x', value }] }, ...more) });
    const spare: Part = { points: [{ id: 'q', position: [5, 5] }], entities: [], relations: [] };
    expect(await fixed(0, spare)).toMatchObject({ kind: 'rejected', reason: 'redundant', diagnostics: { redundantIds: ['p-x'], degreesOfFreedom: 2 } });
    expect(await fixed(1, spare)).toMatchObject({ kind: 'rejected', reason: 'conflicting', diagnostics: { conflictingIds: ['p-x'] } });
    expect(await fixed(0, spare, line)).toMatchObject({ kind: 'rejected', reason: 'redundant', diagnostics: { redundantIds: ['p-x'], degreesOfFreedom: 3 } });
  });

  it('reports the same freedom and relation order whichever group hosts fixed relations', async () => {
    const runtime = createCadSketchTestSolver();
    const solve = (value: number, order: string[]) => runtime.solve({ parameters: {}, graph: merge({ entities: [],
      points: order.map(id => ({ id, position: id === 'p' ? ['0', '0'] : id === 'q' ? [5, '5'] : [10, '10'] })),
      relations: [{ id: 'p-x', kind: 'fixed-axis', pointId: 'p', axis: 'x', value }, { id: 'q-x', kind: 'fixed-axis', pointId: 'q', axis: 'x', value: 5 }] }) });
    for (const order of [['p', 'q', 'r'], ['p', 'r', 'q']]) {
      expect(await solve(0, order)).toMatchObject({ reason: 'redundant', diagnostics: { degreesOfFreedom: 1, redundantIds: ['p-x'] } });
      expect(await solve(1, order)).toMatchObject({ reason: 'conflicting', diagnostics: { degreesOfFreedom: null, conflictingIds: ['p-x'] } });
    }
    // Relations authored for b before a stay in that order across separate groups.
    const duplicates = merge({ points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [9, 0] }], entities: [], relations: ['b', 'a'].flatMap(id => [
      { id: `${id}-x`, kind: 'fixed-axis', pointId: id, axis: 'x', value: id === 'a' ? 0 : 9 }, { id: `${id}-again`, kind: 'fixed-axis', pointId: id, axis: 'x', value: id === 'a' ? 0 : 9 }]) });
    expect(await runtime.solve({ graph: duplicates, parameters: {} })).toMatchObject({ reason: 'redundant', diagnostics: { redundantIds: ['b-again', 'a-again'] } });
  });

  it('diagnoses fixed relations independently of a group that fails to converge', async () => {
    // A 3 mm distance between fixed o and a point on y = 5 cannot be met; f.x = 0 stays merely redundant.
    const runtime = createCadSketchTestSolver(), positions: Record<string, unknown[]> = { f: ['0', '0'], o: ['0', '0'], q: [10, '5'], r: [7, '8'] };
    for (const order of [['f', 'o', 'q', 'r'], ['f', 'r', 'o', 'q']]) expect(await runtime.solve({ parameters: {}, graph: merge({ entities: [],
      points: order.map(id => ({ id, position: positions[id] })),
      relations: [{ id: 'f-x', kind: 'fixed-axis', pointId: 'f', axis: 'x', value: 0 }, { id: 'reach', kind: 'distance', pointIds: ['o', 'q'], value: 3 }] }) }))
      .toMatchObject({ reason: 'redundant', diagnostics: { status: 'failed', degreesOfFreedom: 1, conflictingIds: [], redundantIds: ['f-x'] } });
    // Without any unknown in the sketch nothing is diagnosed, as before; the graph check still applies.
    expect(await runtime.solve({ parameters: {}, graph: merge({ points: [{ id: 'f', position: ['0', '0'] }], entities: [],
      relations: [{ id: 'f-x', kind: 'fixed-axis', pointId: 'f', axis: 'x', value: 0 }] }) })).toMatchObject({ kind: 'solved', diagnostics: { degreesOfFreedom: 0 } });
  });
});

describe('solved values across the worker boundary', () => {
  it('rebuilds a multi-group solve whose group order differs from graph order after a structured clone', async () => {
    // Points interleave the rectangles (r0_p0, r1_p0, r2_p0, r0_p1, ...), so each solved group's
    // points are scattered through the graph and no group lists them in graph order.
    const rectangles = createCadBenchmarkRectangleGraph(3), key = (id: string) => id.match(/^r(\d+)_p(\d+)$/)!.slice(1).map(Number);
    const graph = parseCadSketchGraph({ ...rectangles, points: [...rectangles.points].sort((a, b) => key(a.id)[1] - key(b.id)[1] || key(a.id)[0] - key(b.id)[0]) });
    expect(graph.points.slice(0, 3).map(point => point.id)).toEqual(['r0_p0', 'r1_p0', 'r2_p0']);
    const input = { graph, parameters: {} }, result = await createCadSketchTestSolver().solve(input);
    if (result.kind !== 'solved') throw new Error(result.message);
    const reply = parseCadSketchSolverReply(structuredClone({ id: 1, kind: 'result', result: cadSketchSolverWireResult(result) }), parseCadSketchSolveInput(input));
    expect(reply).toEqual({ id: 1, kind: 'result', result });
  });
  it('rejects a solve that moved a fixed reference snapshot before its values are dropped', async () => {
    const document = circleReferencePart(true), target = document.features[1]; if (target.kind !== 'sketch' || !target.graph) throw new Error('Reference target missing.');
    const input = { graph: target.graph, parameters: document.parameters };
    expect(await createCadSketchTestSolver().solve(input)).toMatchObject({ kind: 'solved' });
    // A solver whose fixed values come back moved, as a faulty solver's would.
    const moving = async (): Promise<CadSketchNativeSolver> => {
      const native = await loadCadSketchTestNativeSolver();
      return { ...native, solve: model => {
        const solution = native.solve(model);
        return { ...solution, values: solution.values.map((value, index) => model.fixed[index] ? value + 1 : value) };
      } };
    };
    expect(await createCadSketchTestSolver({ loadNative: moving }).solve(input)).toMatchObject({ kind: 'rejected', reason: 'invalid-solution', message: 'The sketch solution changed fixed source geometry.' });
  });
});
