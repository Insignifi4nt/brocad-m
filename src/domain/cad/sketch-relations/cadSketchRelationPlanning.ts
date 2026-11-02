import type { CadScalar } from '../cadDocument';
import { evaluateCadScalar } from '../cadExpression';
import { cadSketchFixedComponents } from '../cadSketchFixedComponents';
import { isAcceptedCadSketchGraph, type CadSketchGraph, type CadSketchGraphEntity, type CadSketchGraphPoint, type CadSketchGraphRelation } from '../cadSketchGraph';
import { resolveCadSketchPointIdentities } from '../cadSketchGraphJoints';
import { cadSketchEntityPointIds } from '../cadSketchGraphReferences';
import { resolveCadSketchMidpointOperands } from '../cadSketchMidpointRelations';
import { resolveCadSketchPointOnCurveOperands } from '../cadSketchPointOnCurveRelations';
import { resolveCadSketchPointOnLineOperands } from '../cadSketchPointOnLineRelations';
import { cadSketchDriverTolerance } from '../cadSketchPrecision';
import { cadSketchMirrorPairings, cadSketchMirrorPairs, isCadSketchCurveSymmetry, resolveCadSketchCurveSymmetryOperands, resolveCadSketchSymmetryOperands,
  type CadSketchMirrorPair, type CadSketchMirroredCurve } from '../cadSketchSymmetryRelations';
import { resolveCadSketchTangentJoint } from '../cadSketchTangentRelations';
import { cadSketchCanonicalForm, type CadSketchCanonicalForm } from './cadSketchCanonicalForms';
import { cadSketchCapabilityReason } from './cadSketchOperandSignatures';
import { cadSketchRelationDefinition, cadSketchRelationKindName, cadSketchRelationsLike } from './cadSketchRelationRegistry';
import type { CadSketchEdge, CadSketchRelationIntent, CadSketchRelationPlan, CadSketchRelationPlanner } from './cadSketchRelationTypes';
import { CAD_SKETCH_H_AXIS, CAD_SKETCH_ORIGIN, CAD_SKETCH_ORIGIN_ID, CAD_SKETCH_V_AXIS, CadSketchPositions, cadSketchAxisNormal, cadSketchAxisOfNormal, cadSketchVirtualAxis,
  cadSketchVirtualPoint, cadSketchVirtualPosition, cadSketchVirtualSubject, isCadSketchVirtualAxisId, isCadSketchVirtualId, type CadSketchVirtualAxisId, type CadSketchVirtualId } from './cadSketchVirtualElements';
import type { Point2 } from '@/domain/path-intel/types';
import { CAD_PRECISION } from '@/domain/precision/cadPrecision';

// The Constrain tool's planning of value-free relations, which the relation offers share: the identical-relation lookup, Coincident
// identities, held coordinates, and what the value-free relations already imply. A relation on the origin or an axis that another kind
// keeps is planned as that kind, so the sketch stores one form of it.

type Entity = CadSketchGraphEntity;
type Axis = 'x' | 'y';
const NO_PARAMETERS: Readonly<Record<string, number>> = Object.freeze({});

/**
 * Whether a coordinate is zero whatever the parameters are: 0, or an expression of numbers alone such as `"0"` or `"2 - 2"`.
 * A value that follows a parameter is a dimension that only happens to be zero now, so it never counts.
 */
export function cadSketchZeroScalar(value: CadScalar | undefined): boolean {
  if (value === undefined) return false;
  try { return evaluateCadScalar(value, NO_PARAMETERS) === 0; } catch { return false; }
}

/** What value-free relations keep in a sketch: coordinates at 0, pairs sharing a coordinate and line directions. */
export type CadSketchTrace = {
  readonly zero: (pointId: string, axis: Axis) => boolean;
  /** Kept equal to a linked reference coordinate now at 0, which its source can move, and held at 0 by nothing else. */
  readonly linked: (pointId: string, axis: Axis) => boolean;
  readonly equal: (pair: readonly [string, string], axis: Axis) => boolean;
  readonly direction: (lineId: string) => 'horizontal' | 'vertical' | null;
};
/**
 * How a point already holds the coordinate a plane reference sets to zero. `held` says something holds it there: a relation
 * listed in `ids`, or a coordinate expression that is always zero. `away` says what holds it elsewhere, or `source` that only a
 * linked reference holds it there now, which its source sketch can move. Only fixed coordinates are `removable`: removing a
 * fixed point would release more than this coordinate, and an expression is edited, not removed.
 */
export type CadSketchCoordinateHold = { readonly held: boolean; readonly ids: readonly string[]; readonly removable: boolean; readonly away: 'dimension' | 'fixed' | 'linked' | 'source' | 'expression' | null };

/** The shared planner with the holds and traces the Constrain tool's origin and axis cases read too. */
export interface CadSketchRelationPlanning extends CadSketchRelationPlanner {
  /** The points joined to this one by Coincident, itself included. */
  joint(pointId: string): ReadonlySet<string>;
  /** Whether two stored point ids name the pair's two places, in either order. */
  sameJoints(ids: readonly string[], pair: readonly [string, string]): boolean;
  /** What the value-free relations imply, worked out once for each graph. */
  traced(): CadSketchTrace;
  /** How the point's own relations, expressions and linked references hold this coordinate at 0. */
  holding(pointId: string, axis: Axis): CadSketchCoordinateHold;
  /** As `holding`, counting a coordinate held at 0 only through other relations as held, with no single relation to remove. */
  holdingTraced(pointId: string, axis: Axis): CadSketchCoordinateHold;
  /** How the relations and fixed ends that keep line directions force a mirror line for two lines; see `CadSketchMirrorTurn`. */
  mirrorTurn(firstLineId: string, secondLineId: string, mirrorId: string): CadSketchMirrorTurn | undefined;
  /** The direction, in radians modulo a half turn, that value-free relations and fixed ends keep a line or axis in; undefined where they keep none. */
  lineAngle(lineId: string): number | undefined;
}

/**
 * The direction a mirror line must take for two lines to mirror about it, where the relations and fixed ends that keep line
 * directions force it but keep nothing of the mirror's own: twice that direction is `doubled` modulo a half turn, measured from
 * the X axis, or with `fromFirst` from twice the first line's direction, whichever way that line then lies. Each such direction
 * and the one a quarter turn from it map one line's direction onto the other's.
 */
export interface CadSketchMirrorTurn { readonly doubled: number; readonly fromFirst: boolean }

const isLine = (entity: CadSketchEdge | undefined): entity is Extract<Entity, { kind: 'line' }> => entity?.kind === 'line';
const isCurve = (entity: CadSketchEdge | undefined): entity is Extract<Entity, { kind: 'arc' | 'circle' }> => entity?.kind === 'arc' || entity?.kind === 'circle';
const samePoints = (ids: readonly string[], pair: readonly [string, string]) => ids.length === 2 && ids.includes(pair[0]) && ids.includes(pair[1]);
const sameIds = (relation: CadSketchGraphRelation, pair: readonly [string, string]) => 'lineIds' in relation ? samePoints(relation.lineIds, pair)
  : 'curveIds' in relation ? samePoints(relation.curveIds, pair) : 'pointIds' in relation && samePoints(relation.pointIds, pair);
// A level pair shares Y and an upright pair X.
const keeps = { horizontal: 'y', vertical: 'x' } as const;

const available = (relations: readonly CadSketchRelationIntent[]): CadSketchRelationPlan => ({ state: 'available', relations });
const blocked = (reason: string): CadSketchRelationPlan => ({ state: 'blocked', reason });
/** Applied when relations hold it, with how; refused with that reason when nothing the graph stores does. */
const held = (reason: string, ids?: readonly string[]): CadSketchRelationPlan => ids?.length ? { state: 'applied', relationIds: ids, reason } : blocked(reason);
/** The message of a failed check as the domain gives it, or `fallback` when it carries none. */
const precise = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '').trim() || fallback;
/** Why a coordinate held elsewhere keeps the subject off the origin or an axis, and what to change first. */
function heldAway(subject: string, hold: CadSketchCoordinateHold, axis: Axis, target: string): string {
  return hold.away === 'dimension' ? `${subject} already has a fixed ${axis.toUpperCase()}. Remove that dimension first.`
    : hold.away === 'expression' ? `${subject} has its ${axis.toUpperCase()} set by an expression away from ${target}. Edit that coordinate first.`
    : hold.away === 'linked' ? `${subject} follows a linked reference away from ${target}. Detach it first.`
    : hold.away === 'source' ? `${subject} follows a linked reference that its source sketch can move off ${target}. Detach it first.` : `${subject} is fixed away from ${target}. Remove that relation first.`;
}
/** Applied with the holding relations when removing them releases exactly what this holds; refused with the reason otherwise. */
const alreadyHeld = (reason: string, holds: readonly CadSketchCoordinateHold[]) => held(reason, holds.every(hold => hold.removable) ? [...new Set(holds.flatMap(hold => hold.ids))] : undefined);
const ALL_FIXED = 'Choose a sketch point or edge: the origin and the H and V axes are fixed already.';
/** Whether every operand of the relation is the origin or an axis, which relate nothing that can move. */
const allFixed = (relation: CadSketchRelationIntent) => cadSketchRelationDefinition(relation as CadSketchGraphRelation).operands(relation as CadSketchGraphRelation).every(isCadSketchVirtualId);
const zeroAxis = (pointId: string, axis: Axis): CadSketchRelationIntent => ({ kind: 'fixed-axis', pointId, axis, value: 0 });
/** What a point already on the origin or an axis is told, by the relation that asked. */
function alreadyThere(relation: CadSketchRelationIntent, target: CadSketchVirtualId): string {
  if (relation.kind === 'horizontal') return 'This point is already level with the origin.';
  if (relation.kind === 'vertical') return 'This point is already above or below the origin.';
  return target === CAD_SKETCH_ORIGIN_ID ? 'This point is already at the origin.' : `This point is already on ${cadSketchVirtualSubject(target)}.`;
}

// A sketch graph is never changed in place, so every plan, step and choice over the same graph shares one trace.
const tracedSketches = new WeakMap<CadSketchGraph, CadSketchTrace>();
const planners = new WeakMap<CadSketchGraph, CadSketchRelationPlanning>();

/** The shared planner over one graph, kept with each accepted graph, which cannot change. */
export function cadSketchRelationPlanner(graph: CadSketchGraph): CadSketchRelationPlanning {
  const kept = planners.get(graph);
  if (kept) return kept;
  const points = new Map<string, CadSketchGraphPoint>(graph.points.map(point => [point.id, point]));
  const entities = new Map<string, Entity>(graph.entities.map(entity => [entity.id, entity]));
  const entity = (id: string): CadSketchEdge | undefined => cadSketchVirtualAxis(id) ?? entities.get(id);
  const exists = (match: (relation: CadSketchGraphRelation) => boolean) => graph.relations.some(match);
  const matching = (match: (relation: CadSketchGraphRelation) => boolean) => graph.relations.filter(match).map(relation => relation.id);
  /** The relation, unless an identical one is stored or its check fails. */
  const checked = (relation: CadSketchRelationIntent, check?: () => unknown): CadSketchRelationPlan => {
    if (allFixed(relation)) return blocked(ALL_FIXED);
    const existing = cadSketchRelationsLike(graph, relation);
    if (existing.length) return { state: 'applied', relationIds: existing };
    try { check?.(); } catch (cause) { return blocked(precise(cause, 'These picks cannot take this constraint.')); }
    return available([relation]);
  };
  // A point shares its position with every point joined to it, so a relation on any of them holds it too.
  let identityOf: ((pointId: string) => string) | undefined;
  const identity = (pointId: string) => (identityOf ??= resolveCadSketchPointIdentities(graph))(pointId);
  const sameJoints = (ids: readonly string[], pair: readonly [string, string]) => {
    if (ids.length !== 2) return false;
    const [a, b, p, q] = [ids[0], ids[1], pair[0], pair[1]].map(identity);
    return a === p && b === q || a === q && b === p;
  };
  const joint = (pointId: string) => {
    const root = identity(pointId);
    return new Set(graph.points.filter(point => identity(point.id) === root).map(point => point.id));
  };
  const holding = (pointId: string, axis: Axis): CadSketchCoordinateHold => {
    const index = axis === 'x' ? 0 : 1, joined = joint(pointId), ids: string[] = [];
    let removable = true, expression = false, linked = false;
    // A coordinate written as an expression is fixed by it: always zero holds the point on the reference, anything else elsewhere.
    for (const point of graph.points) {
      const value = joined.has(point.id) ? point.position[index] : undefined;
      if (typeof value !== 'string') continue;
      if (!cadSketchZeroScalar(value)) return { held: false, ids: [], removable: false, away: 'expression' };
      expression = true; removable = false;
    }
    for (const relation of graph.relations) {
      let values: readonly (CadScalar | undefined)[], kind: NonNullable<CadSketchCoordinateHold['away']>;
      if (relation.kind === 'fixed-axis' && relation.axis === axis && joined.has(relation.pointId)) { values = [relation.value]; kind = 'dimension'; }
      else if (relation.kind === 'fixed-point' && joined.has(relation.pointId)) { values = [relation.position[index]]; kind = 'fixed'; }
      else if (relation.kind === 'external-reference') {
        const owner = entities.get(relation.entityId), linked = owner ? cadSketchEntityPointIds(owner).filter(id => joined.has(id)) : [];
        if (!linked.length) continue;
        values = linked.map(id => points.get(id)?.position[index]); kind = 'linked';
      } else continue;
      if (!values.every(cadSketchZeroScalar)) return { held: false, ids: [], removable: false, away: kind };
      // A linked reference at 0 is only a snapshot of its source, which a parameter of that sketch can move.
      if (kind === 'linked') { linked = true; continue; }
      ids.push(relation.id); removable &&= kind === 'dimension';
    }
    if (!expression && !ids.length && linked) return { held: false, ids: [], removable: false, away: 'source' };
    return { held: expression || ids.length > 0, ids, removable, away: null };
  };
  // What value-free relations imply whatever the dimensions are. Coordinates kept equal through Coincident, Horizontal,
  // Vertical, a level or upright line, a point on or at the middle of one, lines collinear with one or a mirror pair share a
  // class, and a class with a coordinate held at 0 holds all of it there. Directions pass through Parallel, Perpendicular and
  // Collinear. Dimensions, angles and other values never count: a later edit could move the geometry off the axis, so a fix
  // they only happen to repeat at the current solution is still added, and preparation rejects it as redundant. A linked
  // reference is a snapshot of its source, so its coordinates at 0 hold nothing and give no line a direction; a coordinate kept
  // equal to one is only marked, so the step can ask for the reference to be detached.
  const traced = (): CadSketchTrace => {
    const cached = tracedSketches.get(graph);
    if (cached) return cached;
    // One union-find over the X and Y of every joint, with the origin's X and Y as the last two nodes.
    const slots = new Map<string, number>(), joints = new Map<string, number>();
    for (const point of graph.points) {
      const root = identity(point.id), slot = joints.get(root) ?? joints.size;
      joints.set(root, slot); slots.set(point.id, slot);
    }
    const parent = Int32Array.from({ length: joints.size * 2 + 2 }, (_, index) => index);
    const find = (node: number) => {
      let root = node;
      while (parent[root] !== root) root = parent[root];
      for (let at = node; parent[at] !== root;) { const up = parent[at]; parent[at] = root; at = up; }
      return root;
    };
    const origin = (axis: Axis) => joints.size * 2 + (axis === 'x' ? 0 : 1);
    const node = (pointId: string, axis: Axis) => {
      if (pointId === CAD_SKETCH_ORIGIN_ID) return origin(axis);
      const slot = slots.get(pointId); return slot === undefined ? -1 : slot * 2 + (axis === 'x' ? 0 : 1);
    };
    const same = (a: number, b: number) => a >= 0 && b >= 0 && find(a) === find(b);
    const zero = (pointId: string, axis: Axis) => same(node(pointId, axis), origin(axis));
    const equal = (pair: readonly [string, string], axis: Axis) => same(node(pair[0], axis), node(pair[1], axis));
    let changed = false;
    const join = (a: number, b: number) => { if (a < 0 || b < 0) return; const [p, q] = [find(a), find(b)]; if (p !== q) { parent[p] = q; changed = true; } };
    const link = (a: string, b: string, axis: Axis) => join(node(a, axis), node(b, axis));
    // The holds `holding` reads, in one pass: a coordinate expression or a fixed coordinate or point at 0.
    const seed = (pointId: string, axis: Axis, value: CadScalar | undefined) => { if (cadSketchZeroScalar(value)) join(node(pointId, axis), origin(axis)); };
    const snapshots: number[] = [];
    for (const point of graph.points) for (const [index, axis] of (['x', 'y'] as const).entries()) if (typeof point.position[index] === 'string') seed(point.id, axis, point.position[index]);
    // The axes are lines through the origin, level and upright, that relations can name: a point on the middle of a level line on
    // the H axis, or a pair mirrored about an axis, is traced as through any other line.
    const lines = graph.entities.filter(isLine), byId = new Map<string, { readonly startPointId: string; readonly endPointId: string }>([...lines.map(line => [line.id, line] as const), ['@h', CAD_SKETCH_H_AXIS], ['@v', CAD_SKETCH_V_AXIS]]);
    const direction = new Map<string, 'horizontal' | 'vertical'>([['@h', 'horizontal'], ['@v', 'vertical']]), neighbours = new Map<string, { readonly lineId: string; readonly turned: boolean }[]>();
    const dependent: Extract<CadSketchGraphRelation, { kind: 'collinear' | 'point-on-line' | 'midpoint' | 'symmetric' }>[] = [];
    // The pairs of each Symmetric: its two points, or its curves' points as the solver pairs them. Lines apart pair by position, so
    // they are read from numeric coordinates only, and give none where an expression sets one.
    let numeric: CadSketchPositions | undefined;
    const mirrored = new Map<string, readonly (readonly [string, string, boolean])[]>();
    const pairsOf = (relation: Extract<CadSketchGraphRelation, { kind: 'symmetric' }>) => {
      if (!isCadSketchCurveSymmetry(relation)) return [[relation.pointIds[0], relation.pointIds[1], false] as const];
      let pairs = mirrored.get(relation.id);
      if (!pairs) {
        try {
          if (!numeric) {
            numeric = new CadSketchPositions();
            for (const point of graph.points) if (typeof point.position[0] === 'number' && typeof point.position[1] === 'number') numeric.set(point.id, { x: point.position[0], y: point.position[1] });
          }
          const { curves, line } = resolveCadSketchCurveSymmetryOperands(graph, relation);
          pairs = cadSketchMirrorPairs(curves, line, identity, numeric).map(pair => [pair.pointIds[0], pair.pointIds[1], pair.self] as const);
        } catch { pairs = []; }
        mirrored.set(relation.id, pairs);
      }
      return pairs;
    };
    for (const relation of graph.relations) {
      if (relation.kind === 'fixed-axis') seed(relation.pointId, relation.axis, relation.value);
      else if (relation.kind === 'fixed-point') { seed(relation.pointId, 'x', relation.position[0]); seed(relation.pointId, 'y', relation.position[1]); }
      else if (relation.kind === 'external-reference') {
        const owner = entities.get(relation.entityId);
        for (const id of owner ? cadSketchEntityPointIds(owner) : []) for (const [index, axis] of (['x', 'y'] as const).entries()) {
          if (cadSketchZeroScalar(points.get(id)?.position[index])) snapshots.push(node(id, axis));
        }
      } else if (relation.kind === 'horizontal' || relation.kind === 'vertical') link(relation.pointIds[0], relation.pointIds[1], keeps[relation.kind]);
      if (relation.kind === 'parallel' || relation.kind === 'perpendicular' || relation.kind === 'collinear') {
        const [a, b] = relation.lineIds, turned = relation.kind === 'perpendicular';
        if (!byId.has(a) || !byId.has(b)) continue;
        neighbours.set(a, [...neighbours.get(a) ?? [], { lineId: b, turned }]); neighbours.set(b, [...neighbours.get(b) ?? [], { lineId: a, turned }]);
      }
      if (relation.kind === 'collinear' || relation.kind === 'point-on-line' || relation.kind === 'midpoint' || relation.kind === 'symmetric') dependent.push(relation);
    }
    // A direction spreads through Parallel, Perpendicular and Collinear at once, so a long chain costs one pass.
    const orient = (start: string, kind: 'horizontal' | 'vertical') => {
      if (direction.has(start)) return;
      direction.set(start, kind); changed = true;
      const queue: [string, 'horizontal' | 'vertical'][] = [[start, kind]];
      for (let index = 0; index < queue.length; index++) {
        const [lineId, known] = queue[index];
        for (const next of neighbours.get(lineId) ?? []) {
          if (direction.has(next.lineId)) continue;
          const along = next.turned ? known === 'horizontal' ? 'vertical' : 'horizontal' : known;
          direction.set(next.lineId, along); queue.push([next.lineId, along]);
        }
      }
    };
    // Directions and shared coordinates feed each other, so repeat until neither grows; a sketch usually settles in two passes.
    do {
      changed = false;
      // A line with both ends at one Y is level, unless its ends also share X and it has no direction at all.
      for (const line of lines) {
        const pair = [line.startPointId, line.endPointId] as const, kind = direction.get(line.id);
        if (!kind && equal(pair, 'y') !== equal(pair, 'x')) orient(line.id, equal(pair, 'y') ? 'horizontal' : 'vertical');
      }
      for (const line of lines) { const kind = direction.get(line.id); if (kind) link(line.startPointId, line.endPointId, keeps[kind]); }
      for (const relation of dependent) {
        if (relation.kind === 'collinear') {
          // Collinear lines share one support, so a level pair keeps one Y and an upright pair one X.
          const [from, to] = relation.lineIds.map(id => byId.get(id)), kind = direction.get(relation.lineIds[0]);
          if (from && to && kind) for (const id of [to.startPointId, to.endPointId]) link(from.startPointId, id, keeps[kind]);
          continue;
        }
        const line = byId.get(relation.lineId), kind = direction.get(relation.lineId);
        if (!line || !kind) continue;
        if (relation.kind !== 'symmetric') { link(line.startPointId, relation.pointId, keeps[kind]); continue; }
        // A mirror keeps the coordinate along it, and keeps the other at 0 on both sides when it lies on that axis. A point that two
        // mirrored curves share lies on the mirror.
        const across = keeps[kind];
        for (const [p, q, self] of pairsOf(relation)) {
          if (self) { link(line.startPointId, p, across); continue; }
          link(p, q, across === 'y' ? 'x' : 'y');
          if (zero(line.startPointId, across) && (zero(p, across) || zero(q, across))) link(p, q, across);
        }
      }
    } while (changed);
    const marked = new Set(snapshots.filter(at => at >= 0).map(find));
    // A point on, or at the middle of, a line whose two ends a linked reference keeps at 0 follows that snapshot too.
    // Each such point waits on its line's end classes and is checked again only when one of them is newly marked, so
    // the order of the relations never matters and each is visited at most twice.
    const waiting = new Map<number, (readonly [number, number, number])[]>();
    for (const relation of dependent) {
      if (relation.kind !== 'point-on-line' && relation.kind !== 'midpoint') continue;
      const line = byId.get(relation.lineId);
      if (line) for (const axis of ['x', 'y'] as const) {
        const nodes = [line.startPointId, line.endPointId, relation.pointId].map(id => node(id, axis));
        if (nodes.some(at => at < 0)) continue;
        const roots = [find(nodes[0]), find(nodes[1]), find(nodes[2])] as const;
        for (const root of new Set([roots[0], roots[1]])) { const list = waiting.get(root); if (list) list.push(roots); else waiting.set(root, [roots]); }
      }
    }
    for (const queue = [...marked]; queue.length;) {
      for (const [start, end, point] of waiting.get(queue.pop()!) ?? []) {
        if (marked.has(point) || !marked.has(start) || !marked.has(end)) continue;
        marked.add(point); queue.push(point);
      }
    }
    const linked = (pointId: string, axis: Axis) => { const at = node(pointId, axis); return at >= 0 && !zero(pointId, axis) && marked.has(find(at)); };
    const result: CadSketchTrace = { zero, linked, equal, direction: lineId => direction.get(lineId) ?? null };
    tracedSketches.set(graph, result);
    return result;
  };
  // A coordinate held at 0 only through other relations counts as held; there is no single relation to offer for removal.
  const holdingTraced = (pointId: string, axis: Axis): CadSketchCoordinateHold => {
    const hold = holding(pointId, axis), { zero, linked } = traced();
    if (hold.held || hold.away && hold.away !== 'source') return hold;
    return zero(pointId, axis) ? { held: true, ids: [], removable: false, away: null } : linked(pointId, axis) ? { held: false, ids: [], removable: false, away: 'source' } : hold;
  };

  // A point placed on the origin or an axis holds the coordinates that target sets to zero, unless something already holds them there.
  // One coordinate held at 0 keeps the point on an axis, so a point held elsewhere is told which: Vertical with the origin is the V axis.
  const holdAt = (pointId: string, axes: readonly Axis[], target: CadSketchVirtualId, subject: string, already: string): CadSketchRelationPlan => {
    const holds = axes.map(axis => holdingTraced(pointId, axis)), away = holds.findIndex(hold => hold.away);
    if (away >= 0) return blocked(heldAway(subject, holds[away], axes[away], cadSketchVirtualSubject(axes.length === 1 ? cadSketchAxisOfNormal(axes[0]) : target)));
    const relations = axes.filter((_, index) => !holds[index].held).map(axis => zeroAxis(pointId, axis));
    return relations.length ? available(relations) : alreadyHeld(already, holds);
  };
  // A line on an axis keeps both endpoints on it. An endpoint already held there counts, and a line already level with the
  // axis, directly or through other relations, needs one endpoint, since a second would repeat the first.
  const lineOnAxis = (lineId: string, pair: readonly [string, string], axis: Axis, target: CadSketchVirtualAxisId): CadSketchRelationPlan => {
    const level = axis === 'y' ? 'horizontal' : 'vertical', across = level === 'horizontal' ? 'vertical' : 'horizontal', name = cadSketchVirtualSubject(target);
    if (exists(relation => relation.kind === across && sameJoints(relation.pointIds, pair))) return blocked(`This line is ${across}, so it cannot lie on ${name}. Remove that relation first.`);
    const kept = traced().direction(lineId);
    if (kept === across) return blocked(`Other relations keep this line ${across}, so it cannot lie on ${name}.`);
    // A level line with one end held keeps the other there too, so that end's own relations are what can be removed.
    // The other end is then held through the line too, even where a linked reference also keeps it at 0 for now.
    const direct = pair.map(pointId => holding(pointId, axis));
    const holds = kept === level && direct.some(hold => hold.held) ? direct.map((hold, index) => hold.away === 'source' ? holdingTraced(pair[index], axis) : hold)
      : pair.map(pointId => holdingTraced(pointId, axis)), away = holds.find(hold => hold.away);
    if (away) return blocked(heldAway('An endpoint of this line', away, axis, name));
    const missing = pair.filter((_, index) => !holds[index].held);
    const needed = kept === level ? missing.length === 2 ? missing.slice(0, 1) : [] : missing;
    return needed.length ? available(needed.map(pointId => zeroAxis(pointId, axis))) : alreadyHeld(`This line is already on ${name}.`, holds);
  };
  /**
   * The plan of a relation on the origin or an axis that another kind keeps, as that kind; undefined for any other relation. `subject`
   * and `already` name a point that stands for an arc or circle.
   */
  const canonical = (relation: CadSketchRelationIntent, subject = 'This point', already?: string): CadSketchRelationPlan | undefined => {
    if (allFixed(relation)) return blocked(ALL_FIXED);
    let form: CadSketchCanonicalForm | null;
    try { form = cadSketchCanonicalForm(graph, relation); } catch (cause) { return blocked(precise(cause, 'These picks cannot take this constraint.')); }
    if (!form) return undefined;
    // A line follows an axis through Horizontal or Vertical, the same relations a level or upright line takes.
    if (form.kind === 'align') {
      const existing = matching(stored => stored.kind === form.align && sameJoints(stored.pointIds, form.pair));
      return existing.length ? { state: 'applied', relationIds: existing, reason: `This line is already ${form.align}.` } : planner.align(form.align, form.pair);
    }
    if (form.lineId && form.pointIds.length === 2) return lineOnAxis(form.lineId, [form.pointIds[0], form.pointIds[1]], form.axes[0], form.target as CadSketchVirtualAxisId);
    return holdAt(form.pointIds[0], form.axes, form.target, subject, already ?? alreadyThere(relation, form.target));
  };

  // Whether a stored Symmetric of two curves about this line holds a point of each, so it already decides how they mirror.
  const curvesMirroring = (first: string, second: string, lineId: string) => graph.relations.some(relation => {
    if (relation.kind !== 'symmetric' || !isCadSketchCurveSymmetry(relation) || relation.lineId !== lineId) return false;
    const [a, b] = relation.curveIds.map(id => new Set(entities.get(id) ? cadSketchEntityPointIds(entities.get(id)!).map(identity) : []));
    const [p, q] = [identity(first), identity(second)];
    return a.has(p) && b.has(q) || a.has(q) && b.has(p);
  });
  // Where a point stays whatever is solved: the origin and the axes' sample ends, or a point whose coordinates are expressions of
  // numbers alone, that a linked reference owns, or that Fix holds at such values. Undefined where a parameter or nothing sets it.
  let owned: ReturnType<typeof cadSketchFixedComponents> | undefined;
  const constant = (value: CadScalar) => { try { return evaluateCadScalar(value, NO_PARAMETERS); } catch { return undefined; } };
  const place = (position: readonly [CadScalar, CadScalar]) => {
    const [x, y] = position.map(constant);
    return x === undefined || y === undefined ? undefined : { x, y };
  };
  const fixedAt = (pointId: string): Point2 | undefined => {
    const virtual = cadSketchVirtualPosition(pointId);
    if (virtual) return virtual;
    const joined = joint(pointId);
    owned ??= cadSketchFixedComponents(graph);
    for (const id of joined) {
      const point = points.get(id);
      if (point && (typeof point.position[0] === 'string' && typeof point.position[1] === 'string' || owned.pointIds.has(id))) return place(point.position);
    }
    const fix = graph.relations.find(relation => relation.kind === 'fixed-point' && joined.has(relation.pointId));
    return fix?.kind === 'fixed-point' ? place(fix.position) : undefined;
  };
  // Each line's direction, in radians modulo a half turn, as value-free relations and fixed ends set it: Parallel, Collinear and
  // Perpendicular join lines into classes a whole number of quarter turns apart, Horizontal, Vertical and the trace's directions join
  // a class to the axes, and a line with fixed ends gives its class an angle.
  let directions: { readonly turns: (lineId: string) => readonly [number, number] | undefined; readonly angle: (lineId: string) => number | undefined } | undefined;
  const lineDirections = () => {
    if (directions) return directions;
    const lines = graph.entities.filter(isLine), ids = [...lines.map(line => line.id), CAD_SKETCH_H_AXIS.id, CAD_SKETCH_V_AXIS.id];
    const index = new Map(ids.map((id, at) => [id, at])), parent = ids.map((_, at) => at), quarter = ids.map(() => 0);
    const find = (node: number): readonly [number, number] => {
      let root = node, turn = 0;
      while (parent[root] !== root) { turn ^= quarter[root]; root = parent[root]; }
      for (let at = node, own = turn; at !== root && parent[at] !== root;) { const up = parent[at], next = own ^ quarter[at]; parent[at] = root; quarter[at] = own; at = up; own = next; }
      return [root, turn];
    };
    const join = (first: string, second: string, turn: number) => {
      const [a, b] = [index.get(first), index.get(second)];
      if (a === undefined || b === undefined) return;
      const [p, pa] = find(a), [q, qb] = find(b);
      if (p !== q) { parent[p] = q; quarter[p] = pa ^ qb ^ turn; }
    };
    const { direction } = traced();
    join(CAD_SKETCH_V_AXIS.id, CAD_SKETCH_H_AXIS.id, 1);
    for (const line of lines) { const kind = direction(line.id); if (kind) join(line.id, CAD_SKETCH_H_AXIS.id, kind === 'horizontal' ? 0 : 1); }
    for (const relation of graph.relations) if (relation.kind === 'parallel' || relation.kind === 'perpendicular' || relation.kind === 'collinear')
      join(relation.lineIds[0], relation.lineIds[1], relation.kind === 'perpendicular' ? 1 : 0);
    const angles = new Map<number, number>(), anchor = (id: string, angle: number) => {
      const [root, turn] = find(index.get(id)!);
      if (!angles.has(root)) angles.set(root, angle - turn * Math.PI / 2);
    };
    anchor(CAD_SKETCH_H_AXIS.id, 0);
    for (const line of lines) {
      const from = fixedAt(line.startPointId), to = fixedAt(line.endPointId);
      if (from && to && (from.x !== to.x || from.y !== to.y)) anchor(line.id, Math.atan2(to.y - from.y, to.x - from.x));
    }
    const turns = (lineId: string) => { const at = index.get(lineId); return at === undefined ? undefined : find(at); };
    directions = { turns, angle: lineId => {
      const found = turns(lineId), base = found && angles.get(found[0]);
      return found && base !== undefined ? base + found[1] * Math.PI / 2 : undefined;
    } };
    return directions;
  };
  /** Whether two angles give one direction, modulo a half turn. */
  const sameDirection = (first: number, second: number) => {
    const apart = ((first - second) % Math.PI + Math.PI) % Math.PI;
    return Math.min(apart, Math.PI - apart) <= CAD_PRECISION.angularAccuracyRad;
  };
  /**
   * Why two lines cannot mirror about this line or axis, as the directions relations or fixed ends keep them: a mirror of one line's
   * direction that misses the other's would collapse both. Directions known against the axes or fixed ends are compared; three lines
   * of one class only by their quarter turns, as a mirror in that class keeps a line's quarter turn. Undefined where nothing refuses.
   */
  const directionConflict = (a: Extract<Entity, { kind: 'line' }>, b: Extract<Entity, { kind: 'line' }>, mirror: CadSketchEdge): string | undefined => {
    const { turns, angle } = lineDirections(), [ta, tb, tm] = [a.id, b.id, mirror.id].map(angle);
    const [ra, rb, rm] = [a.id, b.id, mirror.id].map(turns);
    const misses = ta !== undefined && tb !== undefined && tm !== undefined ? !sameDirection(2 * tm - ta, tb)
      : !!ra && !!rb && !!rm && ra[0] === rb[0] && rb[0] === rm[0] && ra[1] !== rb[1];
    if (!misses) return undefined;
    const on = (line: Extract<Entity, { kind: 'line' }>) => graph.relations.filter(relation => (relation.kind === 'horizontal' || relation.kind === 'vertical')
      && sameJoints(relation.pointIds, [line.startPointId, line.endPointId]) || (relation.kind === 'parallel' || relation.kind === 'perpendicular' || relation.kind === 'collinear') && relation.lineIds.includes(line.id));
    const relations = [...new Set([...on(a), ...on(b)])], names = [...new Set(relations.map(cadSketchRelationKindName))];
    const subject = isCadSketchVirtualAxisId(mirror.id) ? cadSketchVirtualSubject(mirror.id) : 'this line';
    if (!names.length) return `Other relations or fixed points keep these lines in directions that cannot mirror about ${subject}.`;
    const listed = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`, one = relations.length === 1;
    return `The ${listed} ${one ? 'relation keeps' : 'relations keep'} these lines in directions that cannot mirror about ${subject}. Remove ${one ? 'it' : 'one of them'} first.`;
  };
  /**
   * The mirror's forced direction: both lines' directions known, or the two lines in one class a whole number of quarter turns
   * apart. Nothing where the mirror's own direction is known or shared with either line's class, which it then turns with.
   */
  const mirrorTurn = (first: string, second: string, mirrorId: string): CadSketchMirrorTurn | undefined => {
    const { turns, angle } = lineDirections(), [ra, rb, rm] = [first, second, mirrorId].map(turns);
    if (!ra || !rb || !rm || angle(mirrorId) !== undefined || rm[0] === ra[0] || rm[0] === rb[0]) return undefined;
    const [ta, tb] = [angle(first), angle(second)];
    if (ta !== undefined && tb !== undefined) return { doubled: ta + tb, fromFirst: false };
    return ra[0] === rb[0] ? { doubled: (rb[1] - ra[1]) * Math.PI / 2, fromFirst: true } : undefined;
  };
  /**
   * An arc's or circle's radius where it stays whatever is solved: a radius or diameter of numbers alone, a constant expression, a
   * linked circle, or an arc's fixed centre and end.
   */
  const fixedRadius = (curve: CadSketchMirroredCurve): number | undefined => {
    for (const relation of graph.relations) if (relation.kind === 'radial-size' && relation.entityId === curve.id) {
      const value = constant(relation.value);
      if (value !== undefined) return relation.quantity === 'diameter' ? value / 2 : value;
    }
    if (curve.kind === 'circle') return typeof curve.radius === 'string' ? constant(curve.radius) : (owned ??= cadSketchFixedComponents(graph)).circleIds.has(curve.id) ? curve.radius : undefined;
    if (curve.kind !== 'arc') return undefined;
    const centre = fixedAt(curve.centerPointId), end = fixedAt(curve.startPointId) ?? fixedAt(curve.endPointId);
    return centre && end ? Math.hypot(end.x - centre.x, end.y - centre.y) : undefined;
  };
  // Where each point is now, expressions of numbers alone included, for the pairing a new mirror of two lines takes.
  let places: CadSketchPositions | undefined;
  const placed = () => {
    if (places) return places;
    places = new CadSketchPositions();
    for (const point of graph.points) { const at = place(point.position); if (at) places.set(point.id, at); }
    return places;
  };
  type Part = { readonly state: 'free' | 'missing' } | { readonly state: 'held'; readonly ids: readonly string[] } | { readonly state: 'blocked'; readonly reason: string };
  /**
   * Two lines, arcs or circles mirrored as one Symmetric. Relations that keep the whole mirror already are applied: a Symmetric of
   * each pair of their points about this line, a relation keeping a shared point on it, and for circles Equal or radii fixed alike,
   * naming the relations, as removing them releases the mirror. Otherwise the curves'
   * Symmetric is added, which yields to whatever other relations keep of it, Equal and orientations included. It is refused where
   * what they keep cannot mirror: a shared point held off the axis, directions that a mirror would collapse, fixed radii that
   * differ, or point Symmetrics that pair two lines' ends otherwise than where they lie, which decides how a new mirror pairs them.
   */
  const mirrorCurves = (a: CadSketchMirroredCurve, b: CadSketchMirroredCurve, mirror: Extract<Entity, { kind: 'line' }> | CadSketchEdge): CadSketchRelationPlan => {
    const relation: CadSketchRelationIntent = { kind: 'symmetric', curveIds: [a.id, b.id], lineId: mirror.id }, same = cadSketchRelationsLike(graph, relation);
    if (same.length) return { state: 'applied', relationIds: same };
    let pairings: readonly (readonly CadSketchMirrorPair[])[], curves: readonly [CadSketchMirroredCurve, CadSketchMirroredCurve];
    try {
      curves = resolveCadSketchCurveSymmetryOperands(graph, { curveIds: [a.id, b.id], lineId: mirror.id }).curves;
      pairings = cadSketchMirrorPairings(curves, identity);
    } catch (cause) { return blocked(precise(cause, 'These curves cannot mirror each other.')); }
    const line = mirror as Extract<Entity, { kind: 'line' }>, axis = isCadSketchVirtualAxisId(line.id) ? line.id : undefined;
    const ends = new Set(axis ? [] : [line.startPointId, line.endPointId].map(identity));
    const pairPart = ({ pointIds: [p, q], self }: CadSketchMirrorPair): Part => {
      if (self && ends.has(identity(p))) return { state: 'free' };
      if (self && axis) {
        // On an axis, a point keeps the coordinate across it at 0, as Coincident with the axis plans it.
        const across = cadSketchAxisNormal(axis), hold = holdingTraced(p, across);
        if (hold.away) return { state: 'blocked', reason: heldAway('A point these curves share', hold, across, cadSketchVirtualSubject(axis)) };
        return hold.held ? { state: 'held', ids: hold.ids } : { state: 'missing' };
      }
      if (self) {
        const joined = joint(p), ids = matching(stored => (stored.kind === 'point-on-line' || stored.kind === 'midpoint') && stored.lineId === line.id && joined.has(stored.pointId));
        return ids.length ? { state: 'held', ids } : { state: 'missing' };
      }
      const ids = matching(stored => stored.kind === 'symmetric' && !isCadSketchCurveSymmetry(stored) && stored.lineId === line.id && sameJoints(stored.pointIds, [p, q]));
      return ids.length ? { state: 'held', ids } : { state: 'missing' };
    };
    // Two circles keep one radius by Equal, or by radii fixed alike, which no relation to remove holds.
    const equalIds = cadSketchRelationsLike(graph, { kind: 'equal-radius', curveIds: [a.id, b.id] }), [first, second] = a.kind === 'line' ? [] : [fixedRadius(a), fixedRadius(b)];
    const differ = first !== undefined && second !== undefined && Math.abs(first - second) > cadSketchDriverTolerance([{ x: first, y: second }]);
    const radius: Part = equalIds.length ? { state: 'held', ids: equalIds } : first !== undefined && second !== undefined && !differ ? { state: 'held', ids: [] } : { state: 'missing' };
    const parts = pairings.map(pairing => [...pairing.map(pairPart), ...a.kind === 'circle' ? [radius] : []].filter(part => part.state !== 'free'));
    const keeping = parts.filter(list => list.some(part => part.state === 'held'));
    if (keeping.length > 1) return blocked(`Other relations already mirror these ${a.kind}s in two ways. Remove them first.`);
    const list = keeping[0] ?? parts[0], refused = list.find(part => part.state === 'blocked');
    const ids = new Set(list.flatMap(part => part.state === 'held' ? part.ids : []));
    if (list.every(part => part.state === 'held')) return held(`These ${a.kind}s already mirror each other.`, graph.relations.filter(stored => ids.has(stored.id)).map(stored => stored.id));
    if (refused?.state === 'blocked') return blocked(refused.reason);
    if (a.kind === 'line' && b.kind === 'line') {
      const reason = directionConflict(a, b, mirror);
      if (reason) return blocked(reason);
    } else if (differ) return blocked(`These ${a.kind}s have fixed radii that differ, so they cannot mirror each other.`);
    // A new mirror of two lines pairs their ends by where they lie, so point Symmetrics that pair them the other way would conflict.
    if (keeping.length && pairings.length > 1) {
      let lying: readonly CadSketchMirrorPair[] | undefined;
      try { lying = cadSketchMirrorPairs(curves, line, identity, placed()); } catch { lying = undefined; }
      const kept = pairings[parts.indexOf(keeping[0])];
      if (lying && lying[0].pointIds.join(' ') !== kept[0].pointIds.join(' ')) return blocked('Symmetric already pairs these lines’ ends the other way round from where they lie. Remove it first.');
    }
    return available([relation]);
  };

  const planner: CadSketchRelationPlanning = {
    graph, point: id => cadSketchVirtualPoint(id) ?? points.get(id), entity, identity, joint, sameJoints, traced, holding, holdingTraced, mirrorTurn, lineAngle: lineId => lineDirections().angle(lineId),
    // Other relations can already keep a pair level or upright, through a chain of them or both points on one axis.
    align: (kind, pair) => {
      const kept = canonical({ kind, pointIds: pair });
      if (kept) return kept;
      const other = kind === 'horizontal' ? 'vertical' : 'horizontal', { equal } = traced();
      if (identity(pair[0]) === identity(pair[1])) return blocked('These points are already joined.');
      if (exists(relation => relation.kind === other && sameJoints(relation.pointIds, pair))) return blocked(`This is already ${other}.`);
      if (equal(pair, keeps[other])) return blocked(`This is already ${other} through other relations.`);
      const existing = matching(relation => relation.kind === kind && sameJoints(relation.pointIds, pair));
      if (existing.length) return { state: 'applied', relationIds: existing };
      return equal(pair, keeps[kind]) ? blocked(`This is already ${kind} through other relations.`) : checked({ kind, pointIds: pair });
    },
    coincide: pair => canonical({ kind: 'coincident', pointIds: pair }) ?? (identity(pair[0]) === identity(pair[1]) ? held('These points are already joined.', cadSketchRelationsLike(graph, { kind: 'coincident', pointIds: pair }))
      : checked({ kind: 'coincident', pointIds: [pair[0], pair[1]] })),
    // Two curves on one centre point name no relation: a Coincident joining that point to another one does not make them concentric,
    // and removing it would delete an unrelated relation. The whole key is matched, so a centre given twice matches nothing stored.
    concentric: (first, second) => {
      const centers = [first.centerPointId, second.centerPointId] as const;
      return identity(centers[0]) === identity(centers[1]) ? held('These already share a center.', cadSketchRelationsLike(graph, { kind: 'coincident', pointIds: centers }))
        : checked({ kind: 'coincident', pointIds: [centers[0], centers[1]] });
    },
    // An arc or circle centred on a point is Concentric with it, as a centre at the origin holds both its coordinates at 0.
    centre: (curve, targetId) => {
      const name = `this ${curve.kind}`, target = isCadSketchVirtualId(targetId) ? cadSketchVirtualSubject(targetId) : '';
      const relation: CadSketchRelationIntent = isCadSketchVirtualAxisId(targetId) ? { kind: 'point-on-line', pointId: curve.centerPointId, lineId: targetId }
        : { kind: 'coincident', pointIds: [curve.centerPointId, targetId] };
      const kept = canonical(relation, `The center of ${name}`, `This ${curve.kind} is already centered ${targetId === CAD_SKETCH_ORIGIN_ID ? 'at' : 'on'} ${target}.`);
      if (kept) return kept;
      return relation.kind === 'point-on-line' ? planner.place(relation) : planner.coincide([curve.centerPointId, targetId]);
    },
    // Lines that keep another of these relations, or an angle, cannot take this one as well.
    orient: (kind, pair) => {
      const kept = canonical({ kind, lineIds: pair });
      if (kept) return kept;
      const blocker = graph.relations.find(relation => (relation.kind === 'parallel' || relation.kind === 'perpendicular' || relation.kind === 'collinear') && relation.kind !== kind && sameIds(relation, pair)
        || relation.kind === 'line-angle' && samePoints(relation.rays.map(ray => ray.lineId), pair));
      return blocker ? blocked(`These lines already have ${blocker.kind === 'line-angle' ? 'an angle' : `a ${blocker.kind} relation`}. Remove it first.`) : checked({ kind, lineIds: pair });
    },
    place: relation => canonical(relation) ?? checked(relation, () => relation.kind === 'point-on-line' ? resolveCadSketchPointOnLineOperands(graph, relation)
      : relation.kind === 'midpoint' ? resolveCadSketchMidpointOperands(graph, relation) : resolveCadSketchPointOnCurveOperands(graph, relation)),
    tangent: (a, b) => {
      // An arc or circle touches an axis on either side of it; an axis has no ends to join at.
      const axis = a.kind === 'axis' ? a : b.kind === 'axis' ? b : undefined, curve = axis === a ? b : a;
      if (axis) return isCurve(curve) ? checked({ kind: 'tangent', curveIds: [curve.id, axis.id] }) : blocked(cadSketchCapabilityReason(axis, 'ends'));
      if (!(isLine(a) && b.kind === 'arc' || a.kind === 'arc' && isLine(b))) return blocked('Choose a line and an arc.');
      const joints = [a.startPointId, a.endPointId].flatMap(first => [b.startPointId, b.endPointId].filter(second => identity(first) === identity(second))
        .map(second => [{ entityId: a.id, pointId: first }, { entityId: b.id, pointId: second }] as const));
      if (joints.length !== 1) return blocked(joints.length ? 'Choose a line and arc with one shared endpoint.' : 'Join these endpoints with Coincident before adding Tangent.');
      const endpoints = joints[0];
      return checked({ kind: 'tangent-joint', endpoints }, () => resolveCadSketchTangentJoint(graph, { endpoints }));
    },
    // A line has a length and an arc or circle a radius, so Equal relates two of one; curves that mirror are equal already.
    equal: (a, b) => {
      if (a.kind === 'axis' || b.kind === 'axis') return blocked(cadSketchCapabilityReason(a.kind === 'axis' ? a : b, 'length'));
      if (isLine(a) !== isLine(b)) return blocked(`A line has a length and ${(isLine(a) ? b : a).kind === 'arc' ? 'an arc' : 'a circle'} a radius, so Equal cannot relate them.`);
      const relation: CadSketchRelationIntent = isLine(a) ? { kind: 'equal-length', lineIds: [a.id, b.id] } : { kind: 'equal-radius', curveIds: [a.id, b.id] };
      if (!cadSketchRelationsLike(graph, relation).length && exists(stored => stored.kind === 'symmetric' && isCadSketchCurveSymmetry(stored) && samePoints(stored.curveIds, [a.id, b.id])))
        return blocked(`These ${a.kind}s mirror each other, so they are equal already.`);
      return checked(relation);
    },
    // Two points, or a point and a circle by its centre, mirror as points. A point with its own circle is one point given twice: the
    // check refuses it, and no Symmetric of that point with another one is named as holding it. Two lines, arcs or circles mirror as
    // curves; an axis is fixed, so it is only ever the mirror.
    mirror: (targets, line) => {
      const found = targets.map(pick => pick.kind === 'point' ? planner.point(pick.id) : entity(pick.id));
      if (!found[0] || !found[1]) return blocked('These picks are no longer in the sketch.');
      const picked = found as readonly (NonNullable<typeof found[number]>)[];
      const fixed = picked.find(item => 'kind' in item && item.kind === 'axis') as CadSketchEdge | undefined;
      if (fixed) return blocked(cadSketchCapabilityReason(fixed, 'movable'));
      const kinds = picked.map(item => 'kind' in item ? item.kind : 'point');
      if (kinds.includes('point') && kinds.every(kind => kind === 'point' || kind === 'circle')) {
        const [first, second] = targets.map(pick => pick.kind === 'point' ? pick.id : (entity(pick.id) as Extract<Entity, { kind: 'circle' }>).centerPointId);
        const operands = { pointIds: [first, second] as const, lineId: line.id }, relation = { kind: 'symmetric', ...operands } as const;
        const kept = canonical(relation);
        if (kept) return kept;
        if (!cadSketchRelationsLike(graph, relation).length && curvesMirroring(first, second, line.id)) return blocked('These points belong to curves that already mirror each other about this line.');
        return checked(relation, () => resolveCadSketchSymmetryOperands(graph, operands));
      }
      return kinds[0] === kinds[1] && kinds[0] !== 'point' ? mirrorCurves(picked[0] as CadSketchMirroredCurve, picked[1] as CadSketchMirroredCurve, line)
        : blocked('Choose two points, two lines, two arcs or two circles to mirror.');
    },
    fix: pointId => {
      if (isCadSketchVirtualId(pointId)) return blocked(cadSketchCapabilityReason(CAD_SKETCH_ORIGIN, 'movable'));
      const point = points.get(pointId);
      if (!point) return blocked('This point is no longer in the sketch.');
      const joined = joint(point.id);
      const fixed = matching(relation => relation.kind === 'fixed-point' && joined.has(relation.pointId));
      if (fixed.length) return held('This point is already fixed.', fixed);
      const holds = (axis: Axis) => exists(relation => relation.kind === 'fixed-axis' && relation.axis === axis && joined.has(relation.pointId));
      const [x, y] = point.position;
      // Fix holds the point where it is, as one fixed point. A coordinate written as an expression already follows it, and one
      // already held by a coordinate relation keeps it, so only the other numeric coordinate is held, as a distance from its axis.
      if (typeof x === 'number' && typeof y === 'number' && !holds('x') && !holds('y')) return available([{ kind: 'fixed-point', pointId: point.id, position: [x, y] }]);
      const relations = (['x', 'y'] as const).flatMap((axis, index) => {
        const value = point.position[index];
        return typeof value === 'number' && !holds(axis) ? [{ kind: 'fixed-axis' as const, pointId: point.id, axis, value }] : [];
      });
      // A point saved with both coordinates held one by one is fixed already, as a fixed point is.
      const pair = holds('x') && holds('y') ? matching(relation => relation.kind === 'fixed-axis' && joined.has(relation.pointId)) : undefined;
      return relations.length ? available(relations) : held('This point is already fixed or follows expressions.', pair);
    }
  };
  if (isAcceptedCadSketchGraph(graph)) planners.set(graph, Object.freeze(planner));
  return planner;
}

/** Every order of the picks, the picks' own first, as the Constrain tool's choices and the offers try them. */
export function cadSketchPickOrders<T>(items: readonly T[]): readonly (readonly T[])[] {
  return items.length < 2 ? [items] : items.flatMap((item, index) => cadSketchPickOrders([...items.slice(0, index), ...items.slice(index + 1)]).map(rest => [item, ...rest]));
}
