// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { cadSketchSolvedValues, checkCadSketchGraph, parseCadSketchGraph } from '../../../domain/cad/cadSketchGraph';
import { createCadSolverDieInput } from '../benchmark/cadSolverWorkloadCases';
import { createCadSketchNativeRuntime, type CadSketchSolveRecord } from './cadSketchNativeRuntime';
import { CAD_SKETCH_NATIVE_FAILED, CAD_SKETCH_NATIVE_INCOMPATIBLE, CAD_SKETCH_NATIVE_LOAD_FAILED, CadSketchSolverFailure } from './cadSketchSolverFailure';
import type { CadSketchSolveInput } from './cadSketchSolverTypes';
import { CadSketchNativeProtocolError, loadCadSketchNativeSolver, type CadSketchNativeSolution, type CadSketchNativeSolver } from './native/cadSketchNativeSolver';
import { createCadSketchNativeModuleLoader } from './native/cadSketchNativeModule';
import type { CadSketchEquationModel } from '@/domain/cad/sketch-solver/cadSketchEquationModel';
import { CAD_SKETCH_EQUATION_CONFLICTING, CAD_SKETCH_EQUATION_REDUNDANT } from './native/cadSketchNativeProtocol';
import { createCadSketchTestSolver, loadCadSketchTestNativeSolver } from './__tests__/cadSketchTestSolver';
import { planeGcsCorpusSolution } from './__tests__/planeGcsCorpus';

// A free line whose length is driven: one relation, three degrees of freedom.
const graph = parseCadSketchGraph({ points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [9, 1] }],
  entities: [{ id: 'line', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' }],
  relations: [{ id: 'length', kind: 'distance', pointIds: ['a', 'b'], value: 10 }] });
const input: CadSketchSolveInput = { graph, parameters: {} };

/** A native solver answering every model with `answer`, and the real solver's values otherwise. */
function fakeNative(answer: (model: CadSketchEquationModel) => Partial<CadSketchNativeSolution>, memoryBytes = 0): CadSketchNativeSolver {
  return { memoryBytes: () => memoryBytes, solve: model => ({ status: 'converged', iterations: 1, residual: 0, values: model.values,
    diagnosis: { kind: 'diagnosed', degreesOfFreedom: 3, labels: model.equations.map(() => 0) }, ...answer(model) }) };
}

/** A runtime on a clock the test moves, whose load retries wait no real time. */
function runtime(native: () => Promise<CadSketchNativeSolver>, extra: Partial<Parameters<typeof createCadSketchNativeRuntime>[0]> = {}) {
  const records: CadSketchSolveRecord[] = [], loadNative = vi.fn(native), waits: number[] = [], clock = { now: 0 };
  const solver = createCadSketchNativeRuntime({ loadNative, onSolve: record => records.push(record), now: () => clock.now,
    wait: async ms => { waits.push(ms); clock.now += ms; }, ...extra });
  return { records, loadNative, waits, clock, solver };
}

describe('native sketch solving', () => {
  it('answers solves and drags', async () => {
    const { solver, records } = runtime(loadCadSketchTestNativeSolver);
    const solved = await solver.solve(input);
    expect(solved).toMatchObject({ kind: 'solved', diagnostics: { status: 'success', degreesOfFreedom: 3, conflictingIds: [], redundantIds: [], issues: [] } });
    expect(records[0]).toMatchObject({ native: 'answer', loadAttempts: 1 });
    expect(records[0]).not.toHaveProperty('drag');
    for (const position of [[12, 2], [13, 3]] as const) {
      const dragged = await solver.solve({ ...input, drag: { pointId: 'b', position } });
      if (dragged.kind !== 'solved') throw new Error(JSON.stringify(dragged));
      expect(dragged.graph.points[1].position).toEqual(position);
      expect(dragged.diagnostics).toMatchObject({ status: 'success', degreesOfFreedom: 3 });
    }
    expect(records.slice(1)).toEqual([0, 1].map(() => expect.objectContaining({ native: 'answer', drag: { outcome: 'reached', targetDistance: 0 } })));
    // Only the first solve loaded an instance.
    expect(records.slice(1).every(record => record.loadAttempts === undefined)).toBe(true);
  });

  it('keeps a reached drag target exactly, however little it moved', async () => {
    const { solver } = runtime(loadCadSketchTestNativeSolver);
    const start = await solver.solve(input);
    if (start.kind !== 'solved') throw new Error(JSON.stringify(start));
    const [x, y] = start.graph.points[1].position as [number, number];
    // A move within the polishing threshold is still the drag's own, and a target a few ulps from a
    // short decimal keeps its digits.
    for (const position of [[x + 3e-11, y], [12.000000000000002, 2]] as const) {
      const dragged = await solver.solve({ graph: start.graph, parameters: {}, drag: { pointId: 'b', position } });
      if (dragged.kind !== 'solved') throw new Error(JSON.stringify(dragged));
      expect(dragged.graph.points[1].position).toEqual(position);
    }
  });

  it('follows a drag trajectory out of reach and back, chained and from the start, as close as the target can be reached', async () => {
    // A two-link arm of 10 mm links from a fixed base reaches 20 mm. Its tip is dragged along y = 1
    // from x = 10 to 21.25, past its reach, then straight back to x = 15.
    const arm = parseCadSketchGraph({ points: [{ id: 'c', position: ['0', '0'] }, { id: 'p', position: [6, 8] }, { id: 'q', position: [16, 8] }],
      entities: [{ id: 'cp', kind: 'line', construction: false, startPointId: 'c', endPointId: 'p' }, { id: 'pq', kind: 'line', construction: false, startPointId: 'p', endPointId: 'q' }],
      relations: [{ id: 'upper', kind: 'distance', pointIds: ['c', 'p'], value: 10 }, { id: 'lower', kind: 'distance', pointIds: ['p', 'q'], value: 10 }] });
    const targets = [...Array.from({ length: 46 }, (_, frame) => [10 + 0.25 * frame, 1] as const), [15, 1] as const];
    for (const chained of [true, false]) {
      const { solver, records } = runtime(loadCadSketchTestNativeSolver);
      let current = arm;
      for (const [frame, position] of targets.entries()) {
        const dragged = await solver.solve({ graph: chained ? current : arm, parameters: {}, drag: { pointId: 'q', position } });
        if (dragged.kind !== 'solved') throw new Error(`frame ${frame}: ${JSON.stringify(dragged)}`);
        const [x, y] = dragged.graph.points[2].position as [number, number], reach = Math.hypot(...position);
        expect(records[frame].drag?.outcome, `frame ${frame}`).toBe(reach < 20 ? 'reached' : 'projected');
        // The nearest the tip can be is the target within reach and 20 mm along its ray beyond it.
        expect(Math.hypot(x - position[0], y - position[1]), `frame ${frame}`).toBeLessThanOrEqual(Math.max(0, reach - 20) + 1e-9);
        expect(records[frame], `frame ${frame}`).toMatchObject({ native: 'answer' });
        expect(dragged.diagnostics.degreesOfFreedom, `frame ${frame}`).toBe(2);
        current = dragged.graph;
      }
      // Released straight, solved again, then edited.
      const native = createCadSketchTestSolver();
      const stretched = await native.solve({ graph: chained ? current : arm, parameters: {}, drag: { pointId: 'q', position: [21.25, 1] } });
      if (stretched.kind !== 'solved') throw new Error(JSON.stringify(stretched));
      expect(await native.solve({ graph: stretched.graph, parameters: {} })).toMatchObject({ kind: 'solved' });
      const longer = { ...stretched.graph, relations: stretched.graph.relations.map(relation => relation.id === 'lower' ? { ...relation, value: 12 } : relation) };
      const edited = await native.solve({ graph: parseCadSketchGraph(longer), parameters: {} });
      if (edited.kind !== 'solved') throw new Error(JSON.stringify(edited));
      expect(checkCadSketchGraph(edited.graph, {})).toEqual([]);
    }
  });

  it('rejects a stalled drag as not moved toward its target', async () => {
    const stalled = { status: 'not-converged' as const, drag: { outcome: 'stalled' as const, targetDistance: 3 } };
    const drag = { ...input, drag: { pointId: 'b', position: [12, 2] as const } };
    const rejected = runtime(async () => fakeNative(() => stalled));
    expect(await rejected.solver.solve(drag)).toMatchObject({ kind: 'rejected', reason: 'failed', message: 'The point could not be moved toward the target from this start.' });
    expect(rejected.records[0]).toMatchObject({ native: 'not-converged', drag: stalled.drag });
    // With nothing free, unmet labels the graph checks accept would otherwise solve: a stalled drag still does not.
    const fixed = parseCadSketchGraph({ ...graph, points: [{ id: 'a', position: ['0', '0'] }, { id: 'b', position: ['6', '8'] }] });
    const unmet = runtime(async () => fakeNative(model => ({ status: 'converged', diagnosis: { kind: 'no-unknowns', labels: model.equations.map(equation => equation.temporary ? 0 : CAD_SKETCH_EQUATION_CONFLICTING) },
      drag: stalled.drag })));
    expect(await unmet.solver.solve({ graph: fixed, parameters: {}, drag: { pointId: 'b', position: [7, 8] } }))
      .toMatchObject({ kind: 'rejected', reason: 'failed', message: 'The point could not be moved toward the target from this start.' });
  });

  it('returns the frame where a drag stalled at feasible values, checked as any solution', async () => {
    // Stopped at (6, 8), 10 mm from a, on the way to (12, 2).
    const stalled = { values: [0, 0, 6, 8], drag: { outcome: 'stalled' as const, targetDistance: Math.hypot(6, 6) } };
    const drag = { ...input, drag: { pointId: 'b', position: [12, 2] as const } };
    const frame = { kind: 'solved', graph: { points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [6, 8] }] }, diagnostics: { status: 'success', degreesOfFreedom: 3, conflictingIds: [], issues: [] } };
    const stopped = runtime(async () => fakeNative(() => stalled));
    expect(await stopped.solver.solve(drag)).toMatchObject(frame);
    expect(stopped.records[0]).toMatchObject({ native: 'stalled', drag: stalled.drag, movedGroups: 1, keptGroups: 0 });
    // A frame that fails the graph checks is rejected.
    const broken = runtime(async () => fakeNative(() => ({ ...stalled, values: [0, 0, 5, 1] })));
    expect(await broken.solver.solve(drag)).toMatchObject({ kind: 'rejected', reason: 'invalid-solution' });
    expect(broken.records[0]).toMatchObject({ native: 'graph-check' });
  });

  it('keeps a four-bar dragged out of reach on its own assembly, in one jump as when chained', async () => {
    // c–b must stay between 6 and 16 mm, so c's circle about a holds two separate arcs: the linkage
    // assembled up, as it starts, and assembled down. The nearest place on the start's assembly is
    // the stretched end, with c, d and b in line; reassembling down would end closer but jump.
    const fourBar = parseCadSketchGraph({ points: [{ id: 'a', position: ['0', '0'] }, { id: 'b', position: ['10', '0'] }, { id: 'c', position: [6, 8] }, { id: 'd', position: [10, 11] }],
      entities: [{ id: 'ac', kind: 'line', construction: false, startPointId: 'a', endPointId: 'c' }, { id: 'cd', kind: 'line', construction: false, startPointId: 'c', endPointId: 'd' },
        { id: 'db', kind: 'line', construction: false, startPointId: 'd', endPointId: 'b' }],
      relations: [{ id: 'ac-length', kind: 'distance', pointIds: ['a', 'c'], value: 10 }, { id: 'cd-length', kind: 'distance', pointIds: ['c', 'd'], value: 5 },
        { id: 'db-length', kind: 'distance', pointIds: ['d', 'b'], value: 11 }] });
    const { solver, records } = runtime(loadCadSketchTestNativeSolver);
    const target = [-20, -18] as const, jump = { graph: fourBar, parameters: {}, drag: { pointId: 'c', position: target } };
    const solved = await solver.solve(jump), again = await solver.solve(jump);
    if (solved.kind !== 'solved') throw new Error(JSON.stringify(solved));
    expect(again).toEqual(solved);
    expect(records[0]).toMatchObject({ native: 'answer', drag: { outcome: 'projected' } });
    const [, , c, d] = solved.graph.points.map(point => point.position as [number, number]);
    [[c, [-2.8, 9.6]], [d, [1.2, 6.6]]].forEach(([actual, expected]) => actual.forEach((value, axis) => expect(value).toBeCloseTo(expected[axis], 9)));
    expect(Math.hypot(c[0] - target[0], c[1] - target[1])).toBeCloseTo(Math.hypot(17.2, 27.6), 9);
    expect(checkCadSketchGraph(solved.graph, {})).toEqual([]);
    let current = fourBar;
    for (let frame = 1; frame <= 10; frame++) {
      const dragged = await solver.solve({ graph: current, parameters: {}, drag: { pointId: 'c', position: [6 + (target[0] - 6) * frame / 10, 8 + (target[1] - 8) * frame / 10] } });
      if (dragged.kind !== 'solved') throw new Error(JSON.stringify(dragged));
      current = dragged.graph;
    }
    current.points[2].position.forEach((value, axis) => expect(value).toBeCloseTo(c[axis], 9));
  });

  it.each([10, 100, 1000])('stops a drag onto a tangency short of its singular point, then solves, drags and edits it (radius %d)', async radius => {
    // p rides a circle about a and the vertical line x = radius. Exactly on their tangency the two
    // relations' gradients align and rank reads redundant; near it rank is too close to call, so
    // the sketch solves with freedom unknown and the drag stops where rank is still clear of it.
    const tangent = (x: number) => parseCadSketchGraph({ points: [{ id: 'a', position: ['0', '0'] }, { id: 'p', position: [radius, 1e-5 * radius] }],
      entities: [{ id: 'ap', kind: 'line', construction: false, startPointId: 'a', endPointId: 'p' }],
      relations: [{ id: 'radius', kind: 'distance', pointIds: ['a', 'p'], value: radius }, { id: 'x', kind: 'fixed-axis', pointId: 'p', axis: 'x', value: x }] });
    const records: CadSketchSolveRecord[] = [], solver = createCadSketchTestSolver({ onSolve: record => records.push(record) });
    const solve = async (input: CadSketchSolveInput) => {
      const result = await solver.solve(input);
      if (result.kind !== 'solved') throw new Error(JSON.stringify(result));
      expect(result.diagnostics.redundantIds).toEqual([]);
      return result.graph;
    };
    const start = await solve({ graph: tangent(radius), parameters: {} });
    let current = start;
    for (const drag of [0, 1]) {
      current = await solve({ graph: current, parameters: {}, drag: { pointId: 'p', position: [radius, 0] } });
      expect(records.at(-1)?.drag?.outcome, `drag ${drag}`).toBe('limited');
      const [x, y] = current.points[1].position.map(Number);
      expect(Math.abs(x - radius)).toBeLessThanOrEqual(1e-12 * radius);
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThanOrEqual(2e-9 * radius);
      // Released, it solves again where it was left.
      expect((await solve({ graph: current, parameters: {} })).points[1].position.map(Number)).toEqual([x, y]);
    }
    const edited = await solve({ graph: parseCadSketchGraph({ ...current, relations: tangent(radius - 1).relations }), parameters: {} });
    expect(Number(edited.points[1].position[1])).toBeCloseTo(Math.sqrt(2 * radius - 1), 9);
    expect(records.every(record => record.native === 'answer')).toBe(true);
  });

  it('rejects a drag diagnosed redundant where it ended, recording that the diagnosis is the drag\'s', async () => {
    const dragged = runtime(async () => fakeNative(model => ({ diagnosis: { kind: 'diagnosed', degreesOfFreedom: 1, labels: model.equations.map(equation => equation.temporary ? 0 : CAD_SKETCH_EQUATION_REDUNDANT) },
      drag: { outcome: 'reached', targetDistance: 0 } })));
    expect(await dragged.solver.solve({ ...input, drag: { pointId: 'b', position: [12, 2] } })).toMatchObject({ kind: 'rejected', reason: 'redundant' });
    expect(dragged.records[0]).toMatchObject({ native: 'drag-diagnosis' });
  });

  it('captures the input before waiting, so the solve sees the caller\'s values at the call', async () => {
    const parameters = { length: 10 }, source = parseCadSketchGraph({ ...graph, relations: [{ id: 'length', kind: 'distance', pointIds: ['a', 'b'], value: ' length ' }] });
    const { solver } = runtime(loadCadSketchTestNativeSolver);
    const pending = solver.solve({ graph: source, parameters });
    parameters.length = 20;
    const result = await pending;
    if (result.kind !== 'solved') throw new Error(result.message);
    const [a, b] = result.graph.points.map(point => point.position as readonly number[]);
    expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeCloseTo(10, 12);
  });

  it('keeps each already accepted group exactly and snaps roundoff to the exact intent', async () => {
    // Solutions saved by PlaneGCS, from the frozen corpus: native moves them by ulps, and an accepted
    // start keeps its exact values.
    const die = createCadSolverDieInput(), first = planeGcsCorpusSolution(die);
    const { solver, records } = runtime(loadCadSketchTestNativeSolver);
    const again = await solver.solve({ graph: first, parameters: die.parameters });
    if (again.kind !== 'solved') throw new Error(again.message);
    const before = cadSketchSolvedValues(first);
    expect(cadSketchSolvedValues(again.graph).every((value, index) => Object.is(value, before[index]))).toBe(true);
    expect(records[0].native).toBe('answer');
    // An edit moves only the group it affects; the other line keeps its exact values.
    const lines = parseCadSketchGraph({ points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [9, 1] }, { id: 'c', position: [0, 5] }, { id: 'd', position: [9, 6] }],
      entities: [{ id: 'ab', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' }, { id: 'cd', kind: 'line', construction: false, startPointId: 'c', endPointId: 'd' }],
      relations: [{ id: 'first', kind: 'distance', pointIds: ['a', 'b'], value: 'first' }, { id: 'second', kind: 'distance', pointIds: ['c', 'd'], value: 'second' }] });
    const accepted = planeGcsCorpusSolution({ graph: lines, parameters: { first: 10, second: 10 } });
    const edited = await solver.solve({ graph: accepted, parameters: { first: 11, second: 10 } });
    if (edited.kind !== 'solved') throw new Error(edited.message);
    const values = cadSketchSolvedValues(edited.graph), start = cadSketchSolvedValues(accepted);
    expect(values.slice(4).every((value, index) => Object.is(value, start[index + 4]))).toBe(true);
    expect(Math.hypot(values[2] - values[0], values[3] - values[1])).toBeCloseTo(11, 12);
    // A value a few ulps from a short decimal lands on it; one that needs every digit keeps them.
    const level = { graph: parseCadSketchGraph({ ...graph, points: [{ id: 'a', position: ['0', '0'] }, graph.points[1]],
      relations: [{ id: 'level', kind: 'horizontal', pointIds: ['a', 'b'] }] }), parameters: {} };
    const solvedAt = async (x: number, y: number) => {
      const result = await runtime(async () => fakeNative(model => ({ values: model.values.map((value, index) => index === 2 ? x : index === 3 ? y : value) }))).solver.solve(level);
      return result.kind === 'solved' ? result.graph.points[1].position : result;
    };
    expect(await solvedAt(9.999999999999998, 1e-47)).toEqual([10, 0]);
    expect(await solvedAt(1 / 3, 0)).toEqual([1 / 3, 0]);
    // A rank too close to call solves with freedom unknown and is never rounded, which could close a
    // near tangency exactly.
    const uncertain = await runtime(async () => fakeNative(model => ({ values: model.values.map((value, index) => index === 2 ? 9.999999999999998 : index === 3 ? 1e-47 : value),
      diagnosis: { kind: 'uncertain', labels: [0] } }))).solver.solve(level);
    expect(uncertain).toMatchObject({ kind: 'solved', diagnostics: { status: 'success', degreesOfFreedom: null } });
    expect(uncertain.kind === 'solved' && uncertain.graph.points[1].position).toEqual([9.999999999999998, 1e-47]);
    // Far from the origin 8 ulps exceed the driver tolerance, and rounding never moves a value that far.
    const farLine = { graph: parseCadSketchGraph({ points: [{ id: 'a', position: ['999999980', '0'] }, { id: 'b', position: [999999989, 1] }],
      entities: [{ id: 'line', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' }],
      relations: [{ id: 'length', kind: 'distance', pointIds: ['a', 'b'], value: 10 }] }), parameters: {} };
    for (const position of [[999999990, 1e-9], [999999990.0000001, 0]] as const) {
      const result = await runtime(async () => fakeNative(model => ({ values: model.values.map((value, index) => index === 2 || index === 3 ? position[index - 2] : value) }))).solver.solve(farLine);
      expect(result.kind === 'solved' && result.graph.points[1].position).toEqual(position);
    }
    // A group that moved only by polishing keeps its start, though a snap would move it further.
    const near = 100000.00000000012, polishing = runtime(async () => fakeNative(model => ({ values: model.values.map((value, index) => index === 2 ? near + 2 ** -36 : index === 3 ? 0 : value) })));
    const untouched = await polishing.solver.solve({ ...level, graph: parseCadSketchGraph({ ...level.graph, points: [level.graph.points[0], { id: 'b', position: [near, 1e-13] }] }) });
    expect(untouched.kind === 'solved' && untouched.graph.points[1].position).toEqual([near, 1e-13]);
  });

  it('keeps small driven values and edits next to large coordinates', async () => {
    const { solver, records } = runtime(loadCadSketchTestNativeSolver);
    const far = (a: readonly (string | number)[], b: readonly (string | number)[], relations: readonly object[]) => parseCadSketchGraph({ points: [{ id: 'a', position: a }, { id: 'b', position: b }],
      entities: [{ id: 'line', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' }], relations });
    const lift = { id: 'lift', kind: 'fixed-axis', pointId: 'a', axis: 'y', value: 0.000001 };
    // The sketch-wide check tolerance would also pass zero here; the driven value is kept exactly.
    const driven = await solver.solve({ graph: far(['999999990', 5], ['999999990', '0'], [lift]), parameters: {} });
    expect(driven.kind === 'solved' && driven.graph.points[0].position).toEqual(['999999990', 0.000001]);
    // A placement and a driver target within 8 ulps of a short decimal keep their exact digits.
    const placed = await solver.solve({ graph: far([999999990.000001, 0], [999999990.000001, 10], [{ id: 'upright', kind: 'vertical', pointIds: ['a', 'b'] }]), parameters: {} });
    expect(placed.kind === 'solved' && placed.graph.points.map(point => point.position[0])).toEqual([999999990.000001, 999999990.000001]);
    const target = await solver.solve({ graph: far([999999990, '0'], [999999990, 10], [{ id: 'place', kind: 'fixed-axis', pointId: 'a', axis: 'x', value: 999999990.000001 }]), parameters: {} });
    expect(target.kind === 'solved' && target.graph.points[0].position[0]).toBe(999999990.000001);
    // With nothing free, a relation the graph checks accept is solved.
    const fixed = await solver.solve({ graph: far(['1000000000', '0'], ['1000000000', '10'], [lift]), parameters: {} });
    expect(fixed).toMatchObject({ kind: 'solved', diagnostics: { status: 'success', degreesOfFreedom: 0, conflictingIds: [], issues: [] } });
    expect(records.at(-1)!.native).toBe('answer');
    // Only relations the checks reject are blamed; an unrelated invalid circle is reported as such.
    const ring = { id: 'ring', kind: 'circle', construction: true, centerPointId: 'b', radius: '0' };
    const invalid = await solver.solve({ graph: parseCadSketchGraph({ ...far(['1000000000', '0'], ['1000000000', '10'], [lift]), entities: [ring] }), parameters: {} });
    expect(invalid).toMatchObject({ kind: 'rejected', reason: 'invalid-solution', diagnostics: { conflictingIds: [] } });
    expect(invalid.diagnostics.issues.map(issue => issue.source.id)).toContain('ring');
    // A driver edit of a few ulps at each end, which the old values would pass, is solved.
    const span = await solver.solve({ graph: far([999999970, '0'], [999999980, '0'], [{ id: 'span', kind: 'axis-distance', pointIds: ['a', 'b'], axis: 'x', value: 10.000000476837158 }]), parameters: {} });
    expect(span.kind === 'solved' && Number(span.graph.points[1].position[0]) - Number(span.graph.points[0].position[0])).toBe(10.000000476837158);
    // An edit the sketch-wide tolerance would hide still moves its group.
    const tall = far(['999999990', '0'], [999999990, 10], [{ id: 'tall', kind: 'axis-distance', pointIds: ['a', 'b'], axis: 'y', value: 'height' }]);
    const before = await solver.solve({ graph: tall, parameters: { height: 10 } });
    if (before.kind !== 'solved') throw new Error(before.message);
    const after = await solver.solve({ graph: before.graph, parameters: { height: 10.000001 } });
    if (after.kind !== 'solved') throw new Error(after.message);
    expect(Math.abs(Number(after.graph.points[1].position[1]) - 10.000001)).toBeLessThan(1e-9);
  });

  it('moves a group with freedom left to the solution nearest its start', async () => {
    const { solver, records } = runtime(loadCadSketchTestNativeSolver);
    // Free c on a line from fixed d made parallel to a fixed reference: the nearest solution projects
    // c onto the line through d, where a Newton step on the normalized sine swings it across.
    for (const degrees of [0, 30, 75]) {
      const [cos, sin] = [Math.cos(degrees * Math.PI / 180), Math.sin(degrees * Math.PI / 180)];
      const sketch = parseCadSketchGraph({ points: [{ id: 'c', position: [35, 15] }, { id: 'd', position: ['0', '20'] },
        { id: 'e', position: ['60', '0'] }, { id: 'f', position: [String(60 + 20 * cos), String(20 * sin)] }],
      entities: [{ id: 'cd', kind: 'line', construction: false, startPointId: 'c', endPointId: 'd' },
        { id: 'reference', kind: 'line', construction: true, startPointId: 'e', endPointId: 'f' }],
      relations: [{ id: 'aligned', kind: 'parallel', lineIds: ['cd', 'reference'] }] });
      const along = 35 * cos - 5 * sin, nearest = [along * cos, 20 + along * sin];
      const result = await solver.solve({ graph: sketch, parameters: {} });
      if (result.kind !== 'solved') throw new Error('A free parallel line solves.');
      expect(records.at(-1)!.native).toBe('answer');
      result.graph.points[0].position.forEach((value, axis) => expect(Math.abs(Number(value) - nearest[axis])).toBeLessThan(1e-9));
      if (degrees === 0) expect(result.graph.points[0].position).toEqual([35, 20]);
    }
  });

  it.each([
    ['too-large', { status: 'too-large' }, 'too-large', 'A connected group of sketch relations is too large to solve. Split it into separate groups or remove relations.'],
    ['unavailable', { diagnosis: { kind: 'unavailable' } }, 'failed', 'The sketch solver could not diagnose these relations.'],
    ['suspected', { status: 'not-converged', diagnosis: { kind: 'suspected', labels: [2] } }, 'failed', 'Sketch relations could not be met together from this start.'],
    ['not-converged', { status: 'not-converged' }, 'failed', 'The sketch solver did not produce a valid solution.'],
    ['unknown-freedom', { diagnosis: { kind: 'diagnosed', degreesOfFreedom: null, labels: [0] } }, 'failed', 'The sketch solver did not produce a valid solution.'],
    ['moved-fixed-value', { values: [1, 0, 9, 1] }, 'invalid-solution', 'The sketch solution changed fixed source geometry.'],
    ['graph-check', { values: [0, 0, 5, 1] }, 'invalid-solution', 'The sketch solution does not satisfy its geometry and relations.']
  ] as const)('rejects %s with native\'s own reason and message', async (reason, answer, rejection, message) => {
    const fixedGraph = parseCadSketchGraph({ ...graph, points: [{ id: 'a', position: ['0', '0'] }, graph.points[1]] });
    const { solver, records } = runtime(async () => fakeNative(() => answer as Partial<CadSketchNativeSolution>));
    const result = await solver.solve({ graph: fixedGraph, parameters: {} });
    expect(result).toMatchObject({ kind: 'rejected', reason: rejection, message });
    expect(result.diagnostics.conflictingIds).toEqual([]);
    expect(records[0]).toMatchObject({ native: reason });
  });

  it.each([
    ['start-diagnosis', { status: 'not-converged', diagnosis: { kind: 'from-start', labels: [2] } },
      { kind: 'rejected', reason: 'conflicting', diagnostics: { status: 'failed', degreesOfFreedom: null, conflictingIds: ['length'] } }, 0],
    ['incomplete', { values: [0, 0, 6, 8], diagnosis: { kind: 'incomplete', labels: [0] } },
      { kind: 'solved', graph: { points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [6, 8] }] }, diagnostics: { status: 'success', degreesOfFreedom: null, conflictingIds: [] } }, 1],
    ['incomplete', { status: 'not-converged', diagnosis: { kind: 'incomplete', labels: [2] } },
      { kind: 'rejected', reason: 'conflicting', diagnostics: { status: 'failed', degreesOfFreedom: null, conflictingIds: ['length'] } }, 0]
  ] as const)('answers %s with blame as its start shows or freedom unknown, recording why', async (reason, answer, own, movedGroups) => {
    const { solver, records } = runtime(async () => fakeNative(() => answer as Partial<CadSketchNativeSolution>));
    expect(await solver.solve(input)).toMatchObject(own);
    // Its solution counts the groups it moved, as any answer does.
    expect(records[0]).toMatchObject({ native: reason, movedGroups, keptGroups: 0 });
  });

  it('rejects an input it refuses to compile as invalid', async () => {
    const circle = (value: number | string) => parseCadSketchGraph({ points: [{ id: 'center', position: [0, 0] }],
      entities: [{ id: 'hole', kind: 'circle', construction: false, centerPointId: 'center', radius: 6 }],
      relations: [{ id: 'size', kind: 'radial-size', entityId: 'hole', quantity: typeof value === 'number' ? 'diameter' : 'radius', value }] });
    // A zero diameter and a negative radius parameter, as the CAD journeys enter to see them refused.
    const inputs: CadSketchSolveInput[] = [{ graph: circle(0), parameters: {} }, { graph: circle(' bend '), parameters: { bend: -1 } }];
    for (const refused of inputs) {
      const { solver, records } = runtime(loadCadSketchTestNativeSolver);
      expect(await solver.solve(refused)).toMatchObject({ kind: 'rejected', reason: 'invalid-input', message: expect.stringContaining('Driving radius'),
        diagnostics: { status: null, degreesOfFreedom: null, conflictingIds: [], issues: [] } });
      expect(records).toEqual([expect.objectContaining({ native: 'compile' })]);
    }
  });

  it('answers definite conflicts', async () => {
    const { solver, records } = runtime(async () => fakeNative(model => ({ status: 'not-converged', diagnosis: { kind: 'diagnosed', degreesOfFreedom: null, labels: model.equations.map(() => 2) } })));
    expect(await solver.solve(input)).toMatchObject({ kind: 'rejected', reason: 'conflicting', diagnostics: { status: 'failed', conflictingIds: ['length'] } });
    expect(records[0]).toMatchObject({ native: 'answer', movedGroups: 0, keptGroups: 0 });
  });
});

describe('native instance loading and failures', () => {
  it('tries a load three times within a solve, waiting 250 ms and then 1 s', async () => {
    let calls = 0;
    const { solver, records, waits, loadNative } = runtime(async () => { if (++calls < 3) throw new TypeError('Failed to fetch'); return fakeNative(() => ({})); });
    expect(await solver.solve(input)).toMatchObject({ kind: 'rejected', reason: 'invalid-solution' });
    expect(waits).toEqual([250, 1000]); expect(loadNative).toHaveBeenCalledTimes(3);
    expect(records[0]).toMatchObject({ native: 'graph-check', loadAttempts: 3 });
  });

  it('fails a solve whose loads all fail as the solver failing, tries once within a second of it, then three times again', async () => {
    let calls = 0;
    const { solver, records, waits, loadNative, clock } = runtime(async () => { if (++calls <= 4) throw new TypeError('Failed to fetch'); return loadCadSketchTestNativeSolver(); });
    const unloaded = { code: 'sketch-failed', native: 'load-failed', message: CAD_SKETCH_NATIVE_LOAD_FAILED, kernelMessage: 'Failed to fetch' };
    const first = await solver.solve(input).then(() => null, (error: unknown) => error);
    expect(first).toBeInstanceOf(CadSketchSolverFailure); expect(first).toMatchObject(unloaded);
    expect(records[0]).toMatchObject({ native: 'load-failed', loadAttempts: 3 }); expect(waits).toEqual([250, 1000]);
    // A drag's next frame within the second tries once, without waiting: the failure is never kept.
    clock.now += 999;
    await expect(solver.solve(input)).rejects.toMatchObject(unloaded);
    expect(records[1]).toMatchObject({ native: 'load-failed', loadAttempts: 1 }); expect(loadNative).toHaveBeenCalledTimes(4); expect(waits).toHaveLength(2);
    // The next frame loads.
    expect(await solver.solve(input)).toMatchObject({ kind: 'solved' });
    expect(records[2]).toMatchObject({ native: 'answer', loadAttempts: 1 }); expect(loadNative).toHaveBeenCalledTimes(5);
  });

  it('fails a module speaking another protocol at once, as the solver failing, and tries it again on the next solve', async () => {
    // Refused at load, as a module without the solver's exports is.
    const withoutExports = runtime(async () => loadCadSketchNativeSolver(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])));
    const incompatible = { code: 'sketch-failed', native: 'incompatible', message: CAD_SKETCH_NATIVE_INCOMPATIBLE };
    await expect(withoutExports.solver.solve(input)).rejects.toMatchObject({ ...incompatible, kernelMessage: expect.stringContaining('unexpected exports') });
    await expect(withoutExports.solver.solve(input)).rejects.toMatchObject(incompatible);
    expect(withoutExports.loadNative).toHaveBeenCalledTimes(2); expect(withoutExports.waits).toEqual([]);
    expect(withoutExports.records).toMatchObject([{ native: 'incompatible', loadAttempts: 1 }, { native: 'incompatible', loadAttempts: 1 }]);
    // Refused on its first reply, as another protocol version is; the instance is dropped, and the next solve loads a fresh one.
    const versioned = runtime(async () => fakeNative(() => { throw new CadSketchNativeProtocolError('Other protocol.'); }));
    await expect(versioned.solver.solve(input)).rejects.toMatchObject({ ...incompatible, kernelMessage: 'Other protocol.' });
    await expect(versioned.solver.solve(input)).rejects.toMatchObject(incompatible);
    expect(versioned.loadNative).toHaveBeenCalledTimes(2);
    expect(versioned.records).toMatchObject([{ native: 'incompatible', nativeReset: 'failure' }, { native: 'incompatible', nativeReset: 'failure' }]);
  });

  it('solves again on a fresh instance when a used one fails, and rejects a failure on a fresh one', async () => {
    // The first instance answers once, then traps; the second answers.
    let instances = 0;
    const trapping = runtime(async () => {
      let solves = 0;
      return ++instances === 1 ? fakeNative(() => { if (solves++) throw new WebAssembly.RuntimeError('unreachable'); return {}; }) : loadCadSketchTestNativeSolver();
    });
    await trapping.solver.solve(input);
    expect(await trapping.solver.solve(input)).toMatchObject({ kind: 'solved', diagnostics: { degreesOfFreedom: 3 } });
    expect(trapping.records[1]).toMatchObject({ native: 'answer', nativeReset: 'failure', loadAttempts: 1 }); expect(trapping.loadNative).toHaveBeenCalledTimes(2);
    // A fresh instance that fails is not tried again within the solve; the next solve loads another.
    instances = 0;
    const fresh = runtime(async () => ++instances === 1 ? fakeNative(() => { throw new WebAssembly.RuntimeError('unreachable'); }) : fakeNative(() => ({})));
    await expect(fresh.solver.solve(input)).rejects.toMatchObject({ code: 'sketch-failed', native: 'failed', message: CAD_SKETCH_NATIVE_FAILED, kernelMessage: 'unreachable' });
    expect(fresh.records[0]).toMatchObject({ native: 'failed', nativeReset: 'failure' }); expect(fresh.loadNative).toHaveBeenCalledTimes(1);
    expect(await fresh.solver.solve(input)).toMatchObject({ kind: 'rejected', reason: 'invalid-solution' });
    expect(fresh.records[1]).toMatchObject({ native: 'graph-check' }); expect(fresh.records[1].nativeReset).toBeUndefined();
    // Failing again on the fresh instance it loaded, a used one's input is rejected.
    const always = runtime(async () => { let solves = 0; return fakeNative(() => { if (solves++ || always.loadNative.mock.calls.length > 1) throw new WebAssembly.RuntimeError('unreachable'); return {}; }); });
    await always.solver.solve(input);
    await expect(always.solver.solve(input)).rejects.toMatchObject({ code: 'sketch-failed', native: 'failed', message: CAD_SKETCH_NATIVE_FAILED });
    expect(always.records[1]).toMatchObject({ native: 'failed', nativeReset: 'failure' }); expect(always.loadNative).toHaveBeenCalledTimes(2);
    // An invalid result from the module fails the same way, with the decoder's words.
    const invalid = runtime(async () => fakeNative(() => { throw new Error('The native sketch solver returned an invalid result.'); }));
    await expect(invalid.solver.solve(input)).rejects.toMatchObject({ native: 'failed', kernelMessage: 'The native sketch solver returned an invalid result.' });
  });

  it('replaces an instance holding too much memory after its solve', async () => {
    const large = runtime(async () => fakeNative(() => ({}), 2 ** 27));
    await large.solver.solve(input); await large.solver.solve(input);
    expect(large.records[0].nativeReset).toBe('memory'); expect(large.loadNative).toHaveBeenCalledTimes(2);
  });

  it('runs overlapping solves one at a time, so the second gets a fresh instance after the first fails', async () => {
    let instances = 0;
    const { solver, records, loadNative } = runtime(async () => (instances += 1) === 1
      ? fakeNative(() => { throw new WebAssembly.RuntimeError('unreachable'); }) : loadCadSketchTestNativeSolver());
    const [first, second] = await Promise.all([solver.solve(input).catch((error: unknown) => error), solver.solve(input)]);
    expect(first).toMatchObject({ code: 'sketch-failed', native: 'failed', message: CAD_SKETCH_NATIVE_FAILED });
    expect(second).toMatchObject({ kind: 'solved', diagnostics: { degreesOfFreedom: 3 } });
    expect(records).toMatchObject([{ native: 'failed', nativeReset: 'failure' }, { native: 'answer' }]);
    expect(loadNative).toHaveBeenCalledTimes(2);
  });

  it('fetches the module again after a failed download, and compiles it once', async () => {
    const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
    const responses = [() => Promise.reject(new TypeError('Failed to fetch')), () => Promise.resolve(new Response('Not found', { status: 404 })),
      () => Promise.resolve(new Response(bytes))];
    const fetchModule = vi.fn(async () => responses[fetchModule.mock.calls.length - 1]()) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
    const load = createCadSketchNativeModuleLoader('solver.wasm', fetchModule);
    await expect(load()).rejects.toThrow('Failed to fetch');
    await expect(load()).rejects.toThrow('could not be downloaded (HTTP 404)');
    const compiled = await load();
    expect(compiled).toBeInstanceOf(WebAssembly.Module);
    expect(await load()).toBe(compiled); expect(fetchModule).toHaveBeenCalledTimes(3);
  });
});

/** A module with the solver's exports: each body is code ending in `end`, and `data` is placed at 1024. */
function nativeModule({ alloc, free, solve, data }: { readonly alloc: number[]; readonly free: number[]; readonly solve: number[]; readonly data?: Float64Array }) {
  const size = (length: number) => { const bytes = []; do { bytes.push(length & 127 | (length > 127 ? 128 : 0)); length >>>= 7; } while (length); return bytes; };
  const name = (text: string) => [text.length, ...new TextEncoder().encode(text)], section = (id: number, bytes: number[]) => [id, ...size(bytes.length), ...bytes];
  const body = (code: number[]) => [...size(code.length + 1), 0, ...code];
  return new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0,
    ...section(1, [3, 96, 1, 127, 1, 127, 96, 2, 127, 127, 0, 96, 2, 127, 127, 1, 127]), ...section(3, [3, 0, 1, 2]), ...section(5, [1, 0, 1]),
    ...section(7, [4, ...name('memory'), 2, 0, ...name('buffer_alloc'), 0, 0, ...name('buffer_free'), 0, 1, ...name('solve'), 0, 2]),
    ...section(10, [3, ...body(alloc), ...body(free), ...body(solve)]),
    ...data ? section(11, [1, 0, 65, 128, 8, 11, ...size(data.byteLength), ...new Uint8Array(data.buffer)]) : []]);
}

describe('native solver instances', () => {
  const unreachable = [0, 11], at8 = [65, 8, 11], at1024 = [65, 128, 8, 11], none = [11];
  // An empty model's reply: length, protocol 7, converged, no iterations or residual, nothing to
  // diagnose, no freedom count, no drag outcome or target distance.
  const reply = new Float64Array([9, 7, 0, 0, 0, 2, NaN, NaN, NaN]);
  const empty: CadSketchEquationModel = { values: [], fixed: [], pointParameters: new Map(), radiusParameters: new Map(), equations: [] };

  it('reads a reply and frees both buffers', async () => {
    const solver = await loadCadSketchNativeSolver(nativeModule({ alloc: at8, free: none, solve: at1024, data: reply }));
    for (let run = 0; run < 2; run++) expect(solver.solve(empty)).toEqual({ status: 'converged', iterations: 0, residual: 0, values: [], diagnosis: { kind: 'no-unknowns', labels: [] } });
  });

  it('refuses a module without the solver\'s exports as another protocol', async () => {
    await expect(loadCadSketchNativeSolver(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))).rejects.toBeInstanceOf(CadSketchNativeProtocolError);
  });

  it('reads a drag outcome only for a model with drag targets', async () => {
    // One free value held at 0 and dragged toward 5: projected, 5 mm short, one degree of freedom.
    const dragged: CadSketchEquationModel = { ...empty, values: [0], fixed: [false],
      equations: [{ kind: 'value', operands: [0], value: 5, tag: 0, sourceId: 'drag', temporary: true }] };
    const drag = (outcome: number, distance: number) => new Float64Array([12, 7, 0, 1, 0, 0, 1, outcome, distance, 0, 0, 0]);
    const solve = (model: CadSketchEquationModel, data: Float64Array) => loadCadSketchNativeSolver(nativeModule({ alloc: at8, free: none, solve: at1024, data })).then(solver => solver.solve(model));
    expect(await solve(dragged, drag(1, 5))).toMatchObject({ values: [0], drag: { outcome: 'projected', targetDistance: 5 } });
    expect(await solve(dragged, drag(3, 5))).toMatchObject({ drag: { outcome: 'limited', targetDistance: 5 } });
    // An uncertain rank keeps its labels and leaves freedom unknown; a count with it is invalid.
    const diagnosed = (status: number, diagnosis: number, freedom = NaN) => new Float64Array([12, 7, status, 1, 0, diagnosis, freedom, 1, 5, 0, 0, 0]);
    expect(await solve(dragged, diagnosed(0, 4))).toMatchObject({ diagnosis: { kind: 'uncertain', labels: [0] } });
    await expect(solve(dragged, diagnosed(0, 4, 1))).rejects.toThrow('invalid result');
    // Blame from the start comes only with a group that did not converge; a group not diagnosed
    // leaves freedom unknown too.
    expect(await solve(dragged, diagnosed(1, 5))).toMatchObject({ status: 'not-converged', diagnosis: { kind: 'from-start', labels: [0] } });
    expect(await solve(dragged, diagnosed(0, 6))).toMatchObject({ status: 'converged', diagnosis: { kind: 'incomplete', labels: [0] } });
    for (const [status, diagnosis, freedom] of [[0, 5, NaN], [0, 6, 1], [0, 7, NaN]])
      await expect(solve(dragged, diagnosed(status, diagnosis, freedom))).rejects.toThrow('invalid result');
    for (const [outcome, distance] of [[NaN, NaN], [4, 5], [1, NaN], [NaN, 5], [0, -1], [0, Infinity]])
      await expect(solve(dragged, drag(outcome, distance))).rejects.toThrow('invalid result');
    const undragged = { ...dragged, equations: [{ ...dragged.equations[0], temporary: false }] };
    await expect(solve(undragged, drag(1, 5))).rejects.toThrow('invalid result');
  });

  it('reads definition codes only when asked, and only the codes the solver can give', async () => {
    // A fixed value, a value held at 5 and one no equation reads, then their definition codes.
    const model: CadSketchEquationModel = { ...empty, values: [1, 0, 7], fixed: [true, false, false],
      equations: [{ kind: 'value', operands: [1], value: 5, tag: 0, sourceId: 'held' }] };
    const answer = (codes: readonly number[], { length = 9 + 3 + 1 + codes.length, version = 7, diagnosis = 0 } = {}) =>
      new Float64Array([length, version, 0, 1, 0, diagnosis, diagnosis === 0 ? 1 : NaN, NaN, NaN, 1, 5, 7, 0, ...codes]);
    const solve = (data: Float64Array, analyseDefinition?: boolean) => loadCadSketchNativeSolver(nativeModule({ alloc: at8, free: none, solve: at1024, data }))
      .then(solver => solver.solve(model, analyseDefinition === undefined ? undefined : { analyseDefinition }));
    expect(await solve(answer([2, 2, 1]), true)).toMatchObject({ values: [1, 5, 7], definition: [2, 2, 1] });
    expect(await solve(answer([2, 1, 1]), true)).toMatchObject({ definition: [2, 1, 1] });
    expect(await solve(answer([2, 0, 1]), true)).toMatchObject({ definition: [2, 0, 1] });
    expect(await solve(answer([0, 0, 0]))).not.toHaveProperty('definition');
    expect(await solve(answer([0, 0, 0]), false)).not.toHaveProperty('definition');
    // Nothing is analysed unless asked; a fixed value is determined, one no equation reads is free;
    // a diagnosis that is unavailable analyses nothing else; codes are whole and count each value.
    for (const codes of [[2, 2, 1], [0, 0, 1]]) await expect(solve(answer(codes))).rejects.toThrow('invalid result');
    for (const codes of [[1, 2, 1], [0, 2, 1], [2, 2, 2], [2, 2, 0], [2, 3, 1], [2, 0.5, 1], [2, NaN, 1], [2, -1, 1], [2, 2], [2, 2, 1, 0]])
      await expect(solve(answer(codes), true)).rejects.toThrow('invalid result');
    await expect(solve(answer([2, 2, 1], { diagnosis: 1 }), true)).rejects.toThrow('invalid result');
    expect(await solve(answer([2, 0, 1], { diagnosis: 1 }), true)).toMatchObject({ diagnosis: { kind: 'unavailable' }, definition: [2, 0, 1] });
    await expect(solve(answer([2, 2, 1], { length: 15 }), true)).rejects.toThrow('invalid result');
    await expect(solve(answer([2, 2, 1], { version: 5 }), true)).rejects.toBeInstanceOf(CadSketchNativeProtocolError);
  });

  it('refuses to ask a drag which values are defined before native code, and keeps the instance', async () => {
    const solver = await loadCadSketchNativeSolver(nativeModule({ alloc: at8, free: none, solve: at1024, data: reply }));
    const dragged: CadSketchEquationModel = { ...empty, values: [0], fixed: [false],
      equations: [{ kind: 'value', operands: [0], value: 5, tag: 0, sourceId: 'drag', temporary: true }] };
    expect(() => solver.solve(dragged, { analyseDefinition: true })).toThrow('A drag cannot ask which parameters are defined.');
    expect(solver.solve(empty, { analyseDefinition: true })).toEqual({ status: 'converged', iterations: 0, residual: 0, values: [],
      diagnosis: { kind: 'no-unknowns', labels: [] }, definition: [] });
  });

  it.each([
    ['allocating', { alloc: unreachable, free: none, solve: at1024, data: reply }],
    ['solving', { alloc: at8, free: unreachable, solve: unreachable }],
    ['freeing', { alloc: at8, free: unreachable, solve: at1024, data: reply }]
  ] as const)('stops after a trap while %s and never runs again', async (_, parts) => {
    const solver = await loadCadSketchNativeSolver(nativeModule(parts));
    expect(() => solver.solve(empty)).toThrow('unreachable');
    expect(() => solver.solve(empty)).toThrow('The native sketch solver instance stopped after a failure.');
  });
});
