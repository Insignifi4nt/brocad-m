import { checkCadSketchGraph, type CadSketchGraph, type CadSketchGraphIssue } from '../../../../domain/cad/cadSketchGraph';
import { CAD_SKETCH_MIRROR_COLLAPSE, cadSketchMirrorCollapses, cadSketchMirrorShrinks } from '../../../../domain/cad/cadSketchSymmetryRelations';
import { cadSketchSolverStageClock, type CadSketchSolverStageObserver } from '../cadSketchSolverStages';
import type { CadSketchSolveDiagnostics, CadSketchSolveInput, CadSketchSolveResult } from '../cadSketchSolverTypes';
import { compileCadSketchEquations, type CadSketchCompiledSketch } from '../../../../domain/cad/sketch-solver/compileCadSketchEquations';
import { applyCadSketchEquationSolution, cadSketchEquationResidual, type CadSketchEquationModel } from '../../../../domain/cad/sketch-solver/cadSketchEquationModel';
import { cadSketchEquationDefinition, cadSketchEquationDiagnostics, type CadSketchNativeOptions } from './cadSketchNativeProtocol';
import type { CadSketchNativeDiagnosis, CadSketchNativeSolution, CadSketchNativeSolver } from './cadSketchNativeSolver';
import { CAD_SKETCH_START_COMBINATIONS, cadSketchComponentsOf, cadSketchFailingComponents, cadSketchStartCombinations, cadSketchStartComponents } from './cadSketchNativeStartSearch';
import { CAD_PRECISION, cadRoundoff } from '../../../../domain/precision/cadPrecision';

/**
 * Why native's answer is less than certain, or what it rejected: an input it refused to compile, a
 * group too large, a diagnosis unavailable, suspected, read from a stalled start or incomplete,
 * freedom unknown, no convergence, a stalled drag, a drag diagnosed where it ended, or a solution
 * that moved fixed values or failed the graph checks.
 */
export type CadSketchNativeReason = 'compile' | 'too-large' | 'unavailable' | 'suspected' | 'start-diagnosis' | 'incomplete'
  | 'unknown-freedom' | 'not-converged' | 'stalled' | 'drag-diagnosis' | 'moved-fixed-value' | 'graph-check';

/**
 * Native's result. Without `reason` it is native at its most certain: a solution, or a definite
 * conflicting or redundant diagnosis of a solve that is not a drag. With one it is a rejection, the
 * conflicts a stalled sketch's start shows, a solution some group of which was not diagnosed, a
 * drag's conflicts or redundancies where it ended, or for a drag that stalled where its relations
 * are met the solved frame where it stopped. Group counts say how many connected groups native
 * moved and how many of those kept their accepted start values, for any solution. `drag` is
 * native's drag outcome whenever the input has a drag target.
 */
export interface CadSketchNativeAttempt {
  readonly result: CadSketchSolveResult;
  readonly reason?: CadSketchNativeReason;
  readonly movedGroups?: number;
  readonly keptGroups?: number;
  readonly drag?: CadSketchNativeSolution['drag'];
}

const noDiagnostics = (status: CadSketchSolveDiagnostics['status']): CadSketchSolveDiagnostics =>
  ({ status, degreesOfFreedom: null, conflictingIds: [], redundantIds: [], partiallyRedundantIds: [], issues: [] });
const failed = (message: string): CadSketchSolveResult => ({ kind: 'rejected', reason: 'failed', message, diagnostics: noDiagnostics('failed') });
const STALLED_DRAG = 'The point could not be moved toward the target from this start.';

/**
 * Solves already parsed input with the native solver. Its answers at their most certain are a
 * converged solution, diagnosed with known freedom or with a rank too close to call and nothing
 * found dependent, that keeps fixed values and passes the graph checks, or definite conflicts and
 * redundancies, rejected in order: conflicting first, then redundant or partially redundant, then a
 * convergence failure. A drag is certain only with a solution whose target was reached, projected or
 * limited. A drag that stalled where its relations are met stopped at feasible values no more
 * singular than its start, but nothing shows it got as close as it could, so that frame, checked as
 * any solution, and a drag's conflicts and redundancies carry a reason; one that stalled elsewhere is
 * not converged. So do conflicts blamed on a stalled sketch's repeated relations, read from its
 * start, and answers where some converged group was not diagnosed, judged as a rank too close to call.
 * Projected means native's first- and second-order necessary conditions for a local minimum of the
 * target distance held up to its resolution. That proves neither a local minimum nor the nearest
 * configuration: another solver can end closer, for example on another assembly of a linkage.
 * A solved result of input that asks for definition says which points and entities native found
 * defined where it ended, before any group kept its start or short decimals were tried, which move
 * no value by more than the driver tolerance; a drag never asks.
 * Errors from `solver` propagate; the caller treats them as a failed native instance.
 * `observe` receives stage timings for benchmarks.
 */
export function attemptCadSketchNativeSolve(input: CadSketchSolveInput, solver: CadSketchNativeSolver, observe?: CadSketchSolverStageObserver): CadSketchNativeAttempt {
  const clock = cadSketchSolverStageClock(observe, 'parseCompile');
  // A solution is checked as a solve's: its caller regenerates generated geometry from the inputs it moved.
  const check: Check = observe ? (graph, parameters) => clock.during('validation', () => checkCadSketchGraph(graph, parameters, 'solve'))
    : (graph, parameters) => checkCadSketchGraph(graph, parameters, 'solve');
  try {
    let model: CadSketchCompiledSketch;
    try { model = compileCadSketchEquations(input); }
    catch (error) { return { reason: 'compile', result: { kind: 'rejected', reason: 'invalid-input', message: error instanceof Error ? error.message : 'Invalid sketch input.', diagnostics: noDiagnostics(null) } }; }
    clock.next('nativeCall');
    const options = { analyseDefinition: input.analyseDefinition === true && !input.drag };
    const solution = solver.solve(model, options);
    clock.next('mapping');
    const first = settle(input, model, solution, check);
    // A solution that keeps a mirror of curves only by shrinking one to a small fraction of its size passes every check, but ranks below
    // one that does not (see `cadSketchMirrorShrinks`): the starts below are tried for a better one. The search keeps, for each group of
    // starts, the first that shrinks nothing there, or else the first that only shrinks, and its answer is kept where no retry does
    // better; failing that, the first such solution tried. A committed edit warns of each shrunk curve whose size the sketch does not set
    // (see `cadSketchShrinkWarnings`). A drag tries no other start, and other sketches never shrink one.
    const shrinks = (attempt: CadSketchNativeAttempt) => attempt.result.kind === 'solved' && cadSketchMirrorShrinks(input.graph, attempt.result.graph, input.parameters).length > 0;
    if (input.drag || first.result.kind === 'solved' && !shrinks(first)) return first;
    let shrunk = first.result.kind === 'solved' ? first : undefined;
    const certain = (attempt: CadSketchNativeAttempt) => {
      if (attempt.result.kind !== 'solved' || attempt.reason) return false;
      if (!shrinks(attempt)) return true;
      shrunk ??= attempt;
      return false;
    };
    // Relations that offer several starts, as mirrors do their other directions and pairings, try others (see `searchStarts`).
    const searched = searchStarts(input, { model, solution, attempt: first }, solver, options, check, clock, certain);
    if (certain(searched.attempt)) return searched.attempt;
    // Where it solved, the search's answer shrinks only what no start of the same group avoids.
    if (searched.attempt.result.kind === 'solved' && !searched.attempt.reason) shrunk = searched.attempt;
    const { model: best, attempt } = searched;
    // A point held on a curve that starts on its center has no radial direction to move along, and an arc centre that starts along the
    // line it is held square to has no side to turn to, so a failed solve tries again from starts one radius out, then from starts
    // turned square. Only an answer at its most certain replaces it.
    for (const values of [...centerStarts(best), ...squareStarts(best)]) {
      const seeded = { ...best, values }, retried = settle(input, seeded, clock.during('nativeCall', () => solver.solve(seeded, options)), check);
      if (certain(retried)) return retried;
    }
    if (shrunk) return shrunk;
    // A relation the lowering found no solve can meet, such as a mirror that held points and directions leave no line, conflicts with
    // what keeps them, where the solve itself named nothing: a solve can still meet such relations by collapsing the curves.
    const { result } = attempt;
    if (best.unmet.length && result.kind === 'rejected' && result.reason !== 'conflicting' && result.reason !== 'redundant') {
      const conflictingIds = input.graph.relations.map(relation => relation.id).filter(id => best.unmet.some(unmet => unmet.relationId === id || unmet.relationIds.includes(id)));
      return answer({ kind: 'rejected', reason: 'conflicting', message: 'Sketch constraints conflict.', diagnostics: { ...noDiagnostics('failed'), conflictingIds } });
    }
    return attempt;
  } finally { clock.stop(); }
}

/** A compiled sketch, native's solution of it and the attempt it settled to. */
interface Tried { readonly model: CadSketchCompiledSketch; readonly solution: CadSketchNativeSolution; readonly attempt: CadSketchNativeAttempt }

/**
 * After a failed solve that is not a drag, the starts its relations offer, searched one connected component at a time (see
 * `cadSketchStartComponents`), in the order of their first relation id; a solve too large for the solver tries none. A component fails
 * hard where a solution leaves it conflicting, redundant or failing the graph checks (see `cadSketchFailingComponents`), and shrinks
 * where it keeps one of its curve Symmetrics only by shrinking a mirrored curve (see `cadSketchMirrorShrinks` and
 * `cadSketchComponentsOf`). Only a component that the failure names either way is searched, through its combinations least moved first,
 * up to `CAD_SKETCH_START_COMBINATIONS`, with every component already searched kept at the combination it settled on and the others at
 * their first. A combination after which the component neither fails hard nor shrinks is kept, and the search moves to the next
 * component. Where none is, the first combination after which it only shrinks is kept instead, its first if it only shrank there: a
 * shrink no start avoids, as one a dimension asks for, never costs a start that met everything else, and the component is not
 * searched again. So disjoint mirrors cost the sum of their starts, not the product: at most one compile and solve for each
 * combination after the first. Where the failure names no component, every component is searched alike but none is kept, and so is a
 * solution that moved fixed values or left the coordinate range, whose graph cannot be checked. The first answer `certain` accepts is
 * returned; otherwise the last kept combination's model and attempt, or the first ones where none was kept.
 */
function searchStarts(input: CadSketchSolveInput, first: Tried, solver: CadSketchNativeSolver, options: CadSketchNativeOptions, check: Check,
  clock: ReturnType<typeof cadSketchSolverStageClock>, certain: (attempt: CadSketchNativeAttempt) => boolean): Pick<Tried, 'model' | 'attempt'> {
  const components = cadSketchStartComponents(first.model);
  if (!components.length || first.solution.status === 'too-large') return first;
  const failing = (tried: Omit<Tried, 'attempt'>) => {
    let graph: CadSketchGraph | undefined;
    try { graph = applyCadSketchEquationSolution(input.graph, tried.model, tried.solution.values); } catch { return undefined; }
    if (!graph) return undefined;
    return { hard: cadSketchFailingComponents(input.graph, tried.model, tried.solution, check(graph, input.parameters), components),
      shrunk: cadSketchComponentsOf(tried.model, components, cadSketchMirrorShrinks(input.graph, graph, input.parameters)) };
  };
  const named = failing(first), every = !named || !named.hard.size && !named.shrunk.size;
  let chosen: Readonly<Record<string, number>> = {}, best: Pick<Tried, 'model' | 'attempt'> = first;
  for (const [at, component] of components.entries()) {
    if (!every && !named.hard.has(at) && !named.shrunk.has(at)) continue;
    // The component as it stands, at its first combination, is its first candidate: kept if it only shrinks there and no later one does better.
    let kept = every || named.hard.has(at) ? undefined : { chosen, best };
    for (const combination of cadSketchStartCombinations(component, CAD_SKETCH_START_COMBINATIONS).slice(1)) {
      const startChoices = { ...chosen, ...combination };
      let model: CadSketchCompiledSketch;
      try { model = clock.during('parseCompile', () => compileCadSketchEquations({ ...input, startChoices })); } catch { continue; }
      // Another relation's start can leave a later one in the component fewer starts to offer; a start it no longer offers is skipped.
      if (Object.entries(combination).some(([relationId, index]) => index > 0 && !model.startChoices.some(choice => choice.relationId === relationId && index < choice.costs.length))) continue;
      const solution = clock.during('nativeCall', () => solver.solve(model, options)), attempt = settle(input, model, solution, check);
      if (certain(attempt)) return { model, attempt };
      if (every) continue;
      const still = failing({ model, solution });
      if (!still || still.hard.has(at)) continue;
      if (!still.shrunk.has(at)) { kept = { chosen: startChoices, best: { model, attempt } }; break; }
      kept ??= { chosen: startChoices, best: { model, attempt } };
    }
    if (kept) ({ chosen, best } = kept);
  }
  return best;
}

function settle(input: CadSketchSolveInput, model: CadSketchEquationModel, solution: CadSketchNativeSolution, check: Check): CadSketchNativeAttempt {
  const judged = judge(input, model, solution, check), withheld = WITHHELD[solution.diagnosis.kind];
  const withheldAttempt: CadSketchNativeAttempt = withheld && !judged.reason ? { ...judged, reason: withheld } : judged;
  const { result } = withheldAttempt, attempt = result.kind === 'solved' && solution.definition
    ? { ...withheldAttempt, result: { ...result, diagnostics: { ...result.diagnostics, definition: cadSketchEquationDefinition(input.graph, model, solution.definition) } } }
    : withheldAttempt;
  return solution.drag ? { ...attempt, drag: solution.drag } : attempt;
}

const DIRECTIONS: readonly (readonly [number, number])[] = [[1, 0], [0, 1], [Math.SQRT1_2, Math.SQRT1_2]];
/**
 * Start values that move each point a relation holds on a full circle, sitting on that circle's center, one radius out, using only
 * that point's own free coordinates. A point that cannot move, such as the origin, moves its center the other way instead, using
 * the center's free coordinates. Each offers along X, along Y and diagonally where its free coordinates allow. Start k gives the
 * i-th such hold its offer k + i, wrapping, so holds with different free axes move together and points on one center start apart.
 * Nothing else moves, and none are offered when no such hold exists.
 */
function centerStarts(model: CadSketchCompiledSketch): readonly (readonly number[])[] {
  const { values, fixed } = model;
  const centered = new Map<number, { readonly reach: number; readonly offers: readonly (readonly number[])[]; readonly moved: readonly [number, number]; readonly sense: 1 | -1 }>();
  const free = (moved: readonly [number, number]) => DIRECTIONS.filter(direction => direction.every((step, axis) => step === 0 || !fixed[moved[axis]]));
  for (const { point, centre: center, size } of model.radialHolds) {
    const own = free(point), moved = own.length ? point : center;
    if (centered.has(moved[0])) continue;
    const reach = size.kind === 'span' ? Math.hypot(values[size.span[2]] - values[size.span[0]], values[size.span[3]] - values[size.span[1]]) : values[size.index];
    if (!(reach > 0) || Math.hypot(values[point[0]] - values[center[0]], values[point[1]] - values[center[1]]) > CAD_PRECISION.solverCollapsedStartRelative * Math.max(1, reach)) continue;
    const offers = own.length ? own : free(center);
    if (offers.length) centered.set(moved[0], { reach, offers, moved, sense: own.length ? 1 : -1 });
  }
  const rounds = Math.max(0, ...[...centered.values()].map(hold => hold.offers.length));
  return Array.from({ length: rounds }, (_, round) => {
    const seeded = [...values];
    [...centered.values()].forEach(({ reach, offers, moved, sense }, index) => offers[(round + index) % offers.length].forEach((step, axis) => { seeded[moved[axis]] += sense * step * reach; }));
    return seeded;
  });
}

/**
 * Start values that turn each arm held square to a support, and starting along it, a quarter turn about its pivot at its own length:
 * to the left of the support, then to the right, where the arm's free coordinates allow. Start k gives the i-th such arm its offer
 * k + i, wrapping. Nothing else moves, and none are offered when no arm starts along its support.
 */
function squareStarts(model: CadSketchCompiledSketch): readonly (readonly number[])[] {
  const { values, fixed } = model, turned: { readonly arm: readonly [number, number]; readonly offers: readonly (readonly number[])[] }[] = [];
  for (const { pivot, arm, toward } of model.squareHolds) {
    const [px, py] = [values[pivot[0]], values[pivot[1]]], [ax, ay] = [values[arm[0]] - px, values[arm[1]] - py], [dx, dy] = [values[toward[0]] - px, values[toward[1]] - py];
    const reach = Math.hypot(ax, ay), length = Math.hypot(dx, dy);
    if (!(reach > 0) || !(length > 0) || Math.abs(ax * dy - ay * dx) > CAD_PRECISION.solverAlongSupportStartRelative * reach * length) continue;
    const offers = ([1, -1] as const).map(side => [px - side * dy / length * reach, py + side * dx / length * reach])
      .filter(start => start.every((value, axis) => value === values[arm[axis]] || !fixed[arm[axis]]));
    if (offers.length) turned.push({ arm, offers });
  }
  const rounds = Math.max(0, ...turned.map(hold => hold.offers.length));
  return Array.from({ length: rounds }, (_, round) => {
    const seeded = [...values];
    turned.forEach(({ arm, offers }, index) => offers[(round + index) % offers.length].forEach((value, axis) => { seeded[arm[axis]] = value; }));
    return seeded;
  });
}

type Check = (graph: CadSketchGraph, parameters: CadSketchSolveInput['parameters']) => readonly CadSketchGraphIssue[];

/** Diagnoses that leave an otherwise certain answer less than certain. */
const WITHHELD: Partial<Record<CadSketchNativeDiagnosis['kind'], CadSketchNativeReason>> = { 'from-start': 'start-diagnosis', incomplete: 'incomplete' };

function judge(input: CadSketchSolveInput, model: CadSketchEquationModel, solution: CadSketchNativeSolution, check: Check): CadSketchNativeAttempt {
  const { diagnosis } = solution, stalled = solution.drag?.outcome === 'stalled';
  if (solution.status === 'too-large') return { reason: 'too-large', result: { kind: 'rejected', reason: 'too-large',
    message: 'A connected group of sketch relations is too large to solve. Split it into separate groups or remove relations.', diagnostics: noDiagnostics(null) } };
  if (diagnosis.kind === 'unavailable') return { reason: 'unavailable', result: failed('The sketch solver could not diagnose these relations.') };
  // A suspected diagnosis is a stall short of a collapsed point, not a proof: it never blames relations.
  if (diagnosis.kind === 'suspected') return { reason: 'suspected', result: failed('Sketch relations could not be met together from this start.') };
  const status = solution.status === 'converged' ? 'success' : 'failed', ids = cadSketchEquationDiagnostics(model, diagnosis.labels);
  // With nothing free, only unmet relations are labelled, each as conflicting, and nothing is free.
  // An uncertain rank, or a group not diagnosed, leaves freedom unknown.
  const uncertain = diagnosis.kind === 'uncertain' || diagnosis.kind === 'incomplete';
  const degreesOfFreedom = diagnosis.kind === 'diagnosed' ? diagnosis.degreesOfFreedom : diagnosis.kind === 'no-unknowns' && !ids.conflictingIds.length ? 0 : null;
  const diagnostics: CadSketchSolveDiagnostics = { ...noDiagnostics(status), degreesOfFreedom, ...ids };
  const unsolved = (reason: CadSketchNativeReason): CadSketchNativeAttempt => ({ reason,
    result: { kind: 'rejected', reason: 'failed', message: stalled ? STALLED_DRAG : 'The sketch solver did not produce a valid solution.', diagnostics } });
  // Native judges each equation at its own scale and the graph checks at the sketch's, which can be
  // looser far from the origin. With nothing free there is nothing to solve, so the checks decide for
  // each relation: one they accept is not blamed, and issues elsewhere are reported as the checks'.
  if (diagnosis.kind === 'no-unknowns' && ids.conflictingIds.length) {
    const flagged = new Set(check(input.graph, input.parameters).filter(issue => issue.source.kind === 'relation').map(issue => issue.source.id));
    const conflictingIds = ids.conflictingIds.filter(id => flagged.has(id));
    if (!conflictingIds.length) return stalled ? unsolved('not-converged') : solvedAttempt(input, model, solution, { ...noDiagnostics('success'), degreesOfFreedom: 0 }, check);
    return answer({ kind: 'rejected', reason: 'conflicting', message: 'Sketch constraints conflict.', diagnostics: { ...diagnostics, conflictingIds } });
  }
  // A drag is diagnosed where it ends, and its target can land it on a singular configuration (a
  // tangency met exactly) whose rank reads redundant or conflicting where the sketch is not, so for a
  // drag such a rejection is less than certain.
  const definite = (result: CadSketchSolveResult): CadSketchNativeAttempt => solution.drag ? { reason: 'drag-diagnosis', result } : answer(result);
  if (ids.conflictingIds.length) return definite({ kind: 'rejected', reason: 'conflicting', message: 'Sketch constraints conflict.', diagnostics });
  if (ids.redundantIds.length || ids.partiallyRedundantIds.length) return definite({ kind: 'rejected', reason: 'redundant', message: 'Sketch constraints are redundant.', diagnostics });
  if (solution.status !== 'converged') return unsolved('not-converged');
  // A converged sketch whose rank was too close to call, as near a tangency, or some group of which
  // was not diagnosed, is solved with its freedom unknown.
  if (degreesOfFreedom === null && !uncertain) return unsolved('unknown-freedom');
  const solved = solvedAttempt(input, model, solution, diagnostics, check, !uncertain);
  return stalled && !solved.reason ? { ...solved, reason: 'stalled' } : solved;
}

function answer(result: CadSketchSolveResult): CadSketchNativeAttempt { return { result, movedGroups: 0, keptGroups: 0 }; }

/** The native solver's absolute tolerance for a driver, in each equation's mm or radians. */
const DRIVER_TOLERANCE = CAD_PRECISION.solverResidualMm;

/**
 * A value that moved by at most the driver tolerance, or about one ulp of its start where that is
 * larger, may have moved only by polishing: sketches saved before 0.0.757, when PlaneGCS could
 * answer, can hold residuals of about 1e-12 mm that native polishes away.
 */
const polished = (start: number, value: number) => Math.abs(value - start) <= Math.max(DRIVER_TOLERANCE, cadRoundoff(2, Math.abs(start)));

/**
 * The solved graph. Native polishing moves values by ulps even where the start already met every
 * check, and solutions saved by an earlier solver move too, so connected groups that moved only by
 * polishing keep their exact start values when the graph checks accept them: an edit then moves
 * only the geometry it affects, and exact comparisons of untouched geometry (linear pattern
 * ownership, placements) still hold. A group was edited, and takes the solved values, when any of
 * its values moved further, or when its start leaves any of its equations further from met than
 * the solution by more than the driver tolerance: far from the origin a driver edit can move each
 * value by only a few ulps, and the checks' sketch-wide tolerance would accept the old values.
 * A drag moves its point's groups on purpose, however little, so they are never kept.
 * Groups are judged on the native values themselves. Roundoff also leaves exact intent a few ulps
 * off (55 as 54.99999999999999), so short decimals within roundoff are tried first, never in a kept
 * group; the graph checks decide, as for any solution. Rounding can close a near tangency exactly,
 * so it is not tried at all when `snap` is off, for a rank too close to call.
 */
function solvedAttempt(input: CadSketchSolveInput, model: CadSketchEquationModel, solution: CadSketchNativeSolution, diagnostics: CadSketchSolveDiagnostics, check: Check, snap = true): CadSketchNativeAttempt {
  if (!applyCadSketchEquationSolution(input.graph, model, solution.values)) return { reason: 'moved-fixed-value',
    result: { kind: 'rejected', reason: 'invalid-solution', message: 'The sketch solution changed fixed source geometry.', diagnostics } };
  const group = parameterGroups(model), moved = new Set<number>(), edited = new Set<number>();
  solution.values.forEach((value, index) => {
    const start = model.values[index];
    if (Object.is(value, start)) return;
    moved.add(group[index]);
    if (!polished(start, value)) edited.add(group[index]);
  });
  for (const equation of model.equations) if (equation.temporary) for (const operand of equation.operands) if (!model.fixed[operand]) edited.add(group[operand]);
  for (const equation of model.equations) {
    const groups = equation.operands.filter(operand => !model.fixed[operand]).map(operand => group[operand]);
    if (groups.every(id => !moved.has(id) || edited.has(id))) continue;
    const start = Math.abs(cadSketchEquationResidual(equation, model.values)), solved = Math.abs(cadSketchEquationResidual(equation, solution.values));
    if (!(start <= solved + DRIVER_TOLERANCE)) for (const id of groups) edited.add(id);
  }
  const keep = new Set([...moved].filter(id => !edited.has(id)));
  const kept = (values: readonly number[]) => values.map((value, index) => keep.has(group[index]) ? model.values[index] : value);
  const snapped = snap ? shortDecimals(model, solution.values, index => keep.has(group[index])) : undefined;
  const candidates = [snapped && keep.size ? kept(snapped) : undefined, snapped, keep.size ? kept(solution.values) : undefined, solution.values];
  let issues: readonly CadSketchGraphIssue[] = [];
  for (const values of candidates) {
    if (!values) continue;
    const graph = applyCadSketchEquationSolution(input.graph, model, values)!;
    issues = check(graph, input.parameters);
    if (!issues.length) return { result: { kind: 'solved', graph, diagnostics }, movedGroups: moved.size, keptGroups: values === solution.values || values === snapped ? 0 : keep.size };
  }
  // A mirror of curves the solver met only by collapsing them is a failure from this start, which another start may not share.
  if (cadSketchMirrorCollapses(input.graph, issues).length) return { reason: 'graph-check', result: { kind: 'rejected', reason: 'failed', message: CAD_SKETCH_MIRROR_COLLAPSE, diagnostics: { ...diagnostics, issues } } };
  return { reason: 'graph-check',
    result: { kind: 'rejected', reason: 'invalid-solution', message: 'The sketch solution does not satisfy its geometry and relations.', diagnostics: { ...diagnostics, issues } } };
}

/**
 * Values the solver moved outside kept groups, moved again to the nearest 12-significant-digit
 * decimal when that is within 8 ulps of the value, and to zero when within 8 ulps of the tightest
 * scale among the equations using it (the largest operand magnitude, at least 1 mm); undefined when
 * nothing changes.
 * Values the solver left alone are the caller's intent, even a few ulps from a short decimal far from
 * the origin, and a snap that leaves any equation further from met is undone with the others of that
 * equation, so an exact driver target stays exact. Values that need more digits keep them. No value
 * moves by more than the driver tolerance, so far from the origin, where 8 ulps are larger,
 * rounding cannot close a near tangency of a diagnosed sketch, whose rank holds over about 1e-7 of
 * its size.
 */
function shortDecimals(model: CadSketchEquationModel, values: readonly number[], kept: (index: number) => boolean): number[] | undefined {
  const scale = values.map(() => Infinity);
  for (const equation of model.equations) {
    const size = equation.operands.reduce((largest, operand) => Math.max(largest, Math.abs(values[operand])), 1);
    for (const operand of equation.operands) scale[operand] = Math.min(scale[operand], size);
  }
  const snapped = values.map((value, index) => {
    if (model.fixed[index] || kept(index) || Object.is(value, model.values[index])) return value;
    const short = Math.abs(value) <= cadRoundoff(8, Number.isFinite(scale[index]) ? scale[index] : 1) ? 0 : Number(value.toPrecision(12));
    return short === value || short !== 0 && Math.abs(short - value) > cadRoundoff(8, Math.abs(value)) || Math.abs(short - value) > DRIVER_TOLERANCE ? value : short;
  });
  // Each pass undoes at least one snap, so this ends.
  for (let worse = true; worse;) {
    worse = false;
    for (const equation of model.equations) {
      if (equation.operands.every(operand => Object.is(snapped[operand], values[operand]))) continue;
      const before = Math.abs(cadSketchEquationResidual(equation, values)), after = Math.abs(cadSketchEquationResidual(equation, snapped));
      if (after <= before || Number.isNaN(after) && Number.isNaN(before)) continue;
      for (const operand of equation.operands) snapped[operand] = values[operand];
      worse = true;
    }
  }
  return snapped.some((value, index) => !Object.is(value, values[index])) ? snapped : undefined;
}

/** Connected group of each parameter through the lasting equations' free operands; fixed values never move. */
function parameterGroups(model: CadSketchEquationModel): number[] {
  const parent = model.values.map((_, index) => index);
  const root = (index: number): number => { while (parent[index] !== index) index = parent[index] = parent[parent[index]]; return index; };
  for (const equation of model.equations) {
    if (equation.temporary) continue;
    const free = equation.operands.filter(operand => !model.fixed[operand]);
    for (const operand of free.slice(1)) parent[root(operand)] = root(free[0]);
  }
  return parent.map((_, index) => root(index));
}
