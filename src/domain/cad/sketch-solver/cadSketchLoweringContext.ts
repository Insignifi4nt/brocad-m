import { CadError } from '../cadError';
import { evaluateCadScalar } from '../cadExpression';
import type { CadSketchGraph, CadSketchGraphEntity, CadSketchGraphRelation } from '../cadSketchGraph';
import type { CadSketchEdge } from '../sketch-relations/cadSketchRelationTypes';
import { CAD_SKETCH_H_AXIS_ID, CAD_SKETCH_ORIGIN_ID, CAD_SKETCH_V_AXIS_ID, cadSketchVirtualAxis, cadSketchVirtualPosition, type CadSketchVirtualAxis }
  from '../sketch-relations/cadSketchVirtualElements';
import { resolveCadSketchPointIdentities } from '../cadSketchGraphJoints';
import { cadSketchLineDirection } from '../cadSketchLineRelations';
import type { Point2 } from '../../path-intel/types';
import { cadSketchRelationDefinition } from '../sketch-relations/cadSketchRelationRegistry';
import { cadSketchRelationPlanner, type CadSketchMirrorTurn } from '../sketch-relations/cadSketchRelationPlanning';
import type { CadSketchEquation, CadSketchEquationKind, CadSketchPointParameters, CadSketchSizeParameters, CadSketchSupportParameters } from './cadSketchEquationModel';

/**
 * A point held at a size from a centre, as a point on an arc's or circle's full circle is: the point's x and y parameters, the centre's,
 * and the size. The origin's are the fixed parameters its values became.
 */
export interface CadSketchRadialHold { readonly point: CadSketchPointParameters; readonly centre: CadSketchPointParameters; readonly size: CadSketchSizeParameters }
/** An arm from a pivot held square to the support from that pivot toward another point: the x and y parameters of the three points. */
export interface CadSketchSquareHold { readonly pivot: CadSketchPointParameters; readonly arm: CadSketchPointParameters; readonly toward: CadSketchPointParameters }

/** The coordinates of a point that stay put whatever is solved, with the values they stay at; a coordinate left out can move. */
export interface CadSketchPointHold { readonly x?: number; readonly y?: number }
/**
 * A relation that offers more than one start to solve from, ordered first to last, with how far each moves the sketch, in square
 * millimetres: a failed solve tries the others (see `attemptCadSketchNativeSolve`).
 */
export interface CadSketchStartChoice { readonly relationId: string; readonly costs: readonly number[] }
/** A relation that no solve can meet, whatever moves, and the other relations that keep what refuses it. */
export interface CadSketchUnmet { readonly relationId: string; readonly relationIds: readonly string[] }

/** What a relation's lowering reads from an operand. */
export type CadSketchLoweringCapability = 'point' | 'edge' | 'support' | 'centre' | 'size' | 'value';

/** An operand the lowering cannot read as a relation asked: no such operand, or one without that capability. */
export class CadSketchLoweringRefusal extends CadError<'unlowerable-sketch-operand'> {
  constructor(readonly operandId: string, readonly capability: CadSketchLoweringCapability) {
    super('unlowerable-sketch-operand', `Sketch operand "${operandId}" has no ${capability} the solver can use.`);
  }
}

/**
 * What a relation's `lower` reads and writes. It hides where each parameter sits: points are asked for by id and edges by what they
 * give (a support with a direction, a centre, a size), and an operand that cannot give it is refused. An edge is passed as the relation
 * resolved it, or looked up by id with `edge`. Driving values are read by their scalar key through the relation's definition,
 * evaluated in the sketch's parameters. Every equation emitted is the current relation's.
 */
export interface CadSketchLoweringContext {
  readonly graph: CadSketchGraph;
  /** Each point's position before the edit, the origin's and the axes' sample ends' included: a branch read from it keeps the geometry it was made on. */
  readonly starts: ReadonlyMap<string, Point2>;
  /** The point's Coincident identity: points that Coincident joins share one. */
  identity(pointId: string): string;
  /** A point's x and y parameters. */
  point(pointId: string): CadSketchPointParameters;
  /** The support from one point toward another. */
  through(fromPointId: string, towardPointId: string): CadSketchSupportParameters;
  /** The span between two points as a size. */
  span(fromPointId: string, toPointId: string): CadSketchSizeParameters;
  /** The edge with this id, for a relation that holds only the id. */
  edge(entityId: string): CadSketchEdge;
  /** The support an edge gives a direction along, from its start toward its end. */
  support(edge: CadSketchEdge): CadSketchSupportParameters;
  /** The point an edge is centred on. */
  centre(edge: CadSketchEdge): string;
  /** An edge's size: the span from its centre to where it starts, or its own parameter. */
  size(edge: CadSketchEdge): CadSketchSizeParameters;
  /** A relation's driving value under its scalar key, such as `value` or `position.0`, evaluated in the sketch's parameters. */
  value(relationId: string, key: string): number;
  /**
   * Refuses with `message` unless both points have start values, and with the line-pair error unless they are apart: equations that
   * read a direction need one to start from.
   */
  direct(fromPointId: string, towardPointId: string, message: string): void;
  /**
   * The side of 0 a point starts on along one axis (0 for X, 1 for Y): 1 at or above it, -1 below. A branch read from the geometry
   * before the edit, so a relation keeps the side it was made on; refuses a point with no start value.
   */
  side(pointId: string, axis: 0 | 1): 1 | -1;
  /** One equation of the current relation. Each is its own constraint, unless emitted inside `together`. */
  emit(kind: CadSketchEquationKind, operands: readonly number[], value?: number): void;
  /** Runs `lower`, whose equations share one tag: one constraint of several equations. */
  together(lower: () => void): void;
  /** Along one axis (0 for X, 1 for Y), the second point's coordinate less the first's is `offset`. */
  offset(axis: 0 | 1, fromPointId: string, toPointId: string, offset?: number): void;
  /** Along one axis, the point's coordinate is `value`. */
  hold(pointId: string, axis: 0 | 1, value: number): void;
  /**
   * Starts the free coordinates of the point, and of every point Coincident joins to it, at `position` instead of where they are, so
   * the solve sets out from where the relation puts them; false when no such coordinate can move. A later start of the same coordinate
   * replaces an earlier one.
   */
  start(pointId: string, position: Point2): boolean;
  /**
   * What holds the point in place across its Coincident identity: coordinates written as expressions or owned by a linked reference,
   * Fix, a fixed X or Y distance, a point on the H or V axis, and the origin and the axes' sample ends.
   */
  held(pointId: string): CadSketchPointHold;
  /** Which of `count` starts a relation sets out from, ordered first to last by that relation: 0 unless a retry asks for another. */
  startChoice(relationId: string, count: number): number;
  /**
   * Records that the current relation offers one start for each movement in `costs`, ordered first to last, of which a failed solve
   * tries others, and returns the one it sets out from (see `startChoice`). One start or none records nothing.
   */
  choose(costs: readonly number[]): number;
  /**
   * Records that no solve can meet the current relation, whatever moves, as what `relationIds` keep refuses it: a solve that fails
   * without naming relations names these instead.
   */
  unmet(relationIds: readonly string[]): void;
  /** How the relations and fixed ends that keep line directions force a mirror line for two lines, as the shared planner reads them. */
  mirrorTurn(firstLineId: string, secondLineId: string, mirrorId: string): CadSketchMirrorTurn | undefined;
  /** The direction, modulo a half turn, that value-free relations and fixed ends keep a line or axis in, as the shared planner reads it. */
  lineAngle(lineId: string): number | undefined;
  /** The point lies on the infinite line through the support. */
  onSupport(pointId: string, support: CadSketchSupportParameters): void;
  /**
   * The point lies on the full circle around the edge's centre at the edge's size. A failed solve retries a point that starts on the
   * centre from off it, moving the point, or the centre where the point cannot move.
   */
  onCircle(pointId: string, edge: CadSketchEdge): void;
  /**
   * A failed solve retries the arm from `pivotId` to `armId`, which an equation keeps square to the support from `pivotId` toward
   * `towardId`, when it starts along that support, from starts turned square to it on either side.
   */
  squareStart(pivotId: string, armId: string, towardId: string): void;
  /** Two sizes are equal. */
  equalSizes(first: CadSketchSizeParameters, second: CadSketchSizeParameters): void;
  /** A size is `value`. */
  sized(size: CadSketchSizeParameters, value: number): void;
  /**
   * An arc's or circle's size is minus a point's coordinate along one axis (0 for X, 1 for Y), the mirror of a size equal to that
   * coordinate, with the same unknowns and dependences. A circle's own radius is held there. For an arc, this relation makes a free radius,
   * starting at the arc's radius, held to the span from its centre to its start and held there, as two constraints: the radius is in both
   * or neither of any dependence, so the later one-row constraint is blamed, as the mirror's single row is. Where nothing in that span or
   * coordinate can move it makes none, so the relation adds no unknown and is one constant, as its mirror is: the span held at minus the
   * coordinate's value.
   */
  negatedSize(edge: CadSketchEdge, pointId: string, axis: 0 | 1): void;
}

// What each kind of edge gives the lowering. Only these tables name edge kinds; a relation's lowering asks for capabilities.
type Entity<K extends CadSketchEdge['kind']> = Extract<CadSketchEdge, { kind: K }>;
type Capability<R> = { readonly [K in CadSketchEdge['kind']]?: (lowering: CadSketchLowering, entity: Entity<K>) => R };
/** A line runs from its start toward its end, and an axis from the origin toward its sample end. */
const SUPPORTS: Capability<readonly [string, string]> = { line: (_, line) => [line.startPointId, line.endPointId], axis: (_, axis) => [axis.startPointId, axis.endPointId] };
const CENTRES: Capability<string> = { arc: (_, arc) => arc.centerPointId, circle: (_, circle) => circle.centerPointId };
/** An arc's radius runs from its centre to its start. */
const RADII: Capability<readonly [string, string]> = { arc: (_, arc) => [arc.centerPointId, arc.startPointId] };
/** An arc's size spans from its centre to its start; a circle holds its radius as a parameter. */
const SIZES: Capability<CadSketchSizeParameters> = {
  arc: (lowering, arc) => lowering.span(arc.centerPointId, arc.startPointId),
  circle: (lowering, circle) => {
    const index = lowering.radiusParameters.get(circle.id);
    if (index === undefined) throw new CadSketchLoweringRefusal(circle.id, 'size');
    return { kind: 'parameter', index };
  }
};
/** Equations an edge keeps by itself: an arc's ends stay one radius from its centre. */
const STRUCTURES: Capability<void> = {
  arc: (lowering, arc) => lowering.equalSizes(lowering.span(arc.centerPointId, arc.startPointId), lowering.span(arc.centerPointId, arc.endPointId))
};
/** The entry of a capability table for the entity's kind; each entry takes only its own kind's entities, which the lookup guarantees. */
const capability = <R>(table: Capability<R>, entity: CadSketchEdge) =>
  table[entity.kind] as ((lowering: CadSketchLowering, entity: CadSketchEdge) => R) | undefined;

// The origin and each axis's sample end are fixed, so they have no parameters of their own: they stand as negative sentinels, the
// origin's x and y at -1 and -2, the H axis's sample end at -3 and -4 and the V axis's at -5 and -6. An equation on them takes a
// simpler form where the table below has one, and otherwise their fixed values become parameters, made once, after every other.
const VIRTUAL_POINTS: ReadonlyMap<string, CadSketchPointParameters> = new Map([['@origin', [-1, -2]], ['@h', [-3, -4]], ['@v', [-5, -6]]]);
const VIRTUAL_VALUES = [0, 0, 1, 0, 0, 1] as const;
const fixedValue = (sentinel: number) => VIRTUAL_VALUES[-sentinel - 1];
type Specialized = readonly [CadSketchEquationKind, readonly number[], number];
/**
 * The axis whose support starts at `at`: the coordinate it holds at 0 for points on it (1 for Y on the H axis, 0 for X on the V axis),
 * and 1 when it runs from the origin or -1 when it runs toward it. Undefined for any other support.
 */
function axisSupport(operands: readonly number[], at: number): { readonly across: 0 | 1; readonly sense: 1 | -1 } | undefined {
  const [ax, ay, bx, by] = operands.slice(at, at + 4), from = ax === -1 && ay === -2, toward = bx === -1 && by === -2;
  const [sx, sy] = from ? [bx, by] : toward ? [ax, ay] : [0, 0];
  const across = sx === -3 && sy === -4 ? 1 : sx === -5 && sy === -6 ? 0 : undefined;
  return across === undefined ? undefined : { across, sense: from ? 1 : -1 };
}
const stored = (operands: readonly number[], from: number, to: number) => operands.slice(from, to).every(operand => operand >= 0);
/**
 * Equations on an axis or the origin in the form they take there. Each keeps what its general form holds: a point on the H axis is a Y
 * of 0, a line parallel to it keeps one Y, a mirror about the V axis is an X sum of 0 with one Y, and a signed distance from an axis is a
 * signed coordinate. Null keeps the general form, with the fixed values as parameters.
 */
const SPECIALIZATIONS: { readonly [K in CadSketchEquationKind]?: (operands: readonly number[], value: number) => Specialized | null } = {
  difference: ([a, b], value) => a < 0 && b >= 0 ? ['value', [b], fixedValue(a) + value] : b < 0 && a >= 0 ? ['value', [a], fixedValue(b) - value] : null,
  'point-on-line': (operands) => {
    const axis = axisSupport(operands, 2);
    return axis && stored(operands, 0, 2) ? ['value', [operands[axis.across]], 0] : null;
  },
  parallel: (operands) => alongAxis(operands, true),
  perpendicular: (operands) => alongAxis(operands, false),
  'symmetric-midpoint': (operands) => {
    const axis = axisSupport(operands, 4);
    return axis && stored(operands, 0, 4) ? ['midpoint', [operands[axis.across], operands[2 + axis.across], axis.across === 0 ? -1 : -2], 0] : null;
  },
  'symmetric-perpendicular': (operands) => {
    const axis = axisSupport(operands, 4), along = axis?.across === 1 ? 0 : 1;
    return axis && stored(operands, 0, 4) ? ['difference', [operands[along], operands[2 + along]], 0] : null;
  },
  // Positive to the left of the support: +Y of the H axis and -X of the V axis, as each runs from the origin.
  'point-line-distance': (operands, value) => {
    const axis = axisSupport(operands, 2);
    return axis && stored(operands, 0, 2) ? ['value', [operands[axis.across]], (axis.across === 1 ? 1 : -1) * axis.sense * value] : null;
  }
};
/** A stored line parallel to an axis keeps the coordinate the axis holds across it, and one square to it the other. */
function alongAxis(operands: readonly number[], parallel: boolean): Specialized | null {
  const first = axisSupport(operands, 0), second = axisSupport(operands, 4);
  const [axis, line] = first && !second && stored(operands, 4, 8) ? [first, 4] : second && !first && stored(operands, 0, 4) ? [second, 0] : [undefined, 0];
  if (!axis) return null;
  const keep = parallel ? axis.across : 1 - axis.across;
  return ['difference', [operands[line + keep], operands[line + 2 + keep]], 0];
}

/**
 * The lowering of one sketch: the context each relation lowers through, and the equations, tags and radial holds it collects. The
 * compiler emits an arc's own equation and a drag's targets through it too, under their own sources.
 */
export class CadSketchLowering implements CadSketchLoweringContext {
  readonly equations: CadSketchEquation[] = [];
  readonly radialHolds: CadSketchRadialHold[] = [];
  readonly squareHolds: CadSketchSquareHold[] = [];
  /** Start values for free point parameters, which the compiler puts in place of the points' own before solving, in order. */
  readonly seeds: { readonly index: number; readonly value: number }[] = [];
  /** The relations that offered more than one start, in the order they were lowered. */
  readonly startChoices: CadSketchStartChoice[] = [];
  /** The relations no solve can meet, in the order they were lowered. */
  readonly unmetRelations: CadSketchUnmet[] = [];
  private members: Map<string, string[]> | undefined;
  private readonly holds = new Map<string, CadSketchPointHold>();
  /** The relations in id order, which holds are read in, so the order the graph stores them never decides one. */
  private byId: readonly CadSketchGraphRelation[] | undefined;
  private tags = 0;
  private sharedTag: number | undefined;
  /** The relation lowering now yields: each equation is a constraint of its own, marked as yielding. */
  private yielding = false;
  private relation: CadSketchGraphRelation | undefined;
  private sourceId = '';
  private entities: Map<string, CadSketchGraphEntity> | undefined;
  private relations: Map<string, CadSketchGraphRelation> | undefined;
  private identities: ((pointId: string) => string) | undefined;
  /**
   * The values made after the point and radius parameters, in the order they were made: the fixed values the origin and the axes
   * became, and the free radius an arc's relation makes.
   */
  readonly made: { readonly value: number; readonly fixed: boolean }[] = [];
  /** The parameter each fixed value of the origin or an axis became, by its sentinel. */
  private readonly sentinels = new Map<number, number>();

  /** How many point and radius parameters there are; made values follow them. */
  private readonly parameterCount: number;

  /**
   * `numericPoints` gives the origin and the axes' sample ends too, as `CadSketchPositions` does. `fixed` says, for each point and
   * radius parameter, whether it is fixed. `chosen` names the start a relation sets out from, by relation id, where a retry asks for
   * one other than its first.
   */
  constructor(readonly graph: CadSketchGraph, private readonly parameters: Readonly<Record<string, number>>,
    private readonly pointParameters: ReadonlyMap<string, number>, readonly radiusParameters: ReadonlyMap<string, number>,
    private readonly numericPoints: ReadonlyMap<string, Point2>, private readonly fixed: readonly boolean[],
    private readonly chosen: Readonly<Record<string, number>> = {}) {
    this.parameterCount = fixed.length;
  }
  get starts(): ReadonlyMap<string, Point2> { return this.numericPoints; }
  identity(pointId: string): string { return (this.identities ??= resolveCadSketchPointIdentities(this.graph))(pointId); }

  /**
   * Lowers one relation through its definition, whole or not at all: a relation whose lowering throws, a refusal or any other error,
   * leaves none of its equations, radial holds or tags behind.
   */
  lower(relation: CadSketchGraphRelation) {
    const definition = cadSketchRelationDefinition(relation);
    this.relation = relation; this.sourceId = relation.id; this.yielding = definition.yields?.(relation as never) === true;
    const equations = this.equations.length, radialHolds = this.radialHolds.length, squareHolds = this.squareHolds.length, seeds = this.seeds.length, tags = this.tags, made = this.made.length;
    const choices = this.startChoices.length, unmet = this.unmetRelations.length;
    try { definition.lower(relation, this); }
    catch (error) {
      this.restore(equations, radialHolds, squareHolds, seeds, tags, made);
      this.startChoices.length = choices; this.unmetRelations.length = unmet;
      throw error;
    }
    finally { this.yielding = false; }
  }
  /**
   * Every relation in graph order, those that yield after all the others (see the definitions' `yields`): each then yields to the
   * relations before it, and those that yield to each other in the order the graph stores them.
   */
  lowerAll(relations: readonly CadSketchGraphRelation[]) {
    const yields = (relation: CadSketchGraphRelation) => cadSketchRelationDefinition(relation).yields?.(relation as never) === true;
    for (const relation of relations) if (!yields(relation)) this.lower(relation);
    for (const relation of relations) if (yields(relation)) this.lower(relation);
  }
  /** The equations an edge keeps by itself, under its own id, whole or not at all. */
  structure(entity: CadSketchGraphEntity) {
    const structure = capability(STRUCTURES, entity);
    if (!structure) return;
    this.relation = undefined; this.sourceId = entity.id;
    const equations = this.equations.length, radialHolds = this.radialHolds.length, squareHolds = this.squareHolds.length, seeds = this.seeds.length, tags = this.tags, made = this.made.length;
    try { structure(this, entity); }
    catch (error) { this.restore(equations, radialHolds, squareHolds, seeds, tags, made); throw error; }
  }
  /** Drops what was emitted since the counts were taken, and gives back the tags it took. */
  private restore(equations: number, radialHolds: number, squareHolds: number, seeds: number, tags: number, made: number) {
    this.equations.length = equations; this.radialHolds.length = radialHolds; this.squareHolds.length = squareHolds; this.seeds.length = seeds; this.tags = tags; this.sharedTag = undefined;
    if (this.made.length === made) return;
    this.made.length = made;
    for (const [sentinel, index] of this.sentinels) if (index >= this.parameterCount + made) this.sentinels.delete(sentinel);
  }
  /** A drag target: a value on one coordinate of the dragged point, solved but left out of diagnosis. */
  target(pointId: string, axis: 0 | 1, value: number) {
    this.relation = undefined; this.sourceId = pointId;
    this.equations.push({ kind: 'value', operands: [this.point(pointId)[axis]], value, sourceId: pointId, tag: this.tags++, temporary: true });
  }

  point(pointId: string): CadSketchPointParameters {
    const x = this.pointParameters.get(pointId);
    if (x === undefined) { const fixed = VIRTUAL_POINTS.get(pointId); if (fixed) return fixed; throw new CadSketchLoweringRefusal(pointId, 'point'); }
    return [x, x + 1];
  }
  through(fromPointId: string, towardPointId: string): CadSketchSupportParameters {
    return [...this.point(fromPointId), ...this.point(towardPointId)];
  }
  span(fromPointId: string, toPointId: string): CadSketchSizeParameters {
    return { kind: 'span', span: this.through(fromPointId, toPointId) };
  }
  edge(entityId: string): CadSketchEdge {
    const axis: CadSketchVirtualAxis | undefined = cadSketchVirtualAxis(entityId);
    if (axis) return axis;
    if (!this.entities) {
      this.entities = new Map();
      for (const entity of this.graph.entities) if (!this.entities.has(entity.id)) this.entities.set(entity.id, entity);
    }
    const entity = this.entities.get(entityId);
    if (!entity) throw new CadSketchLoweringRefusal(entityId, 'edge');
    return entity;
  }
  support(edge: CadSketchEdge): CadSketchSupportParameters {
    const ends = capability(SUPPORTS, edge)?.(this, edge);
    if (!ends) throw new CadSketchLoweringRefusal(edge.id, 'support');
    return this.through(ends[0], ends[1]);
  }
  centre(edge: CadSketchEdge): string {
    const centre = capability(CENTRES, edge)?.(this, edge);
    if (centre === undefined) throw new CadSketchLoweringRefusal(edge.id, 'centre');
    return centre;
  }
  size(edge: CadSketchEdge): CadSketchSizeParameters {
    const size = capability(SIZES, edge);
    if (!size) throw new CadSketchLoweringRefusal(edge.id, 'size');
    return size(this, edge);
  }
  value(relationId: string, key: string): number {
    let relation = this.relation?.id === relationId ? this.relation : undefined;
    if (!relation) {
      this.relations ??= new Map(this.graph.relations.map(item => [item.id, item]));
      relation = this.relations.get(relationId);
    }
    const scalars = relation && cadSketchRelationDefinition(relation).scalars, index = scalars ? scalars.keys.indexOf(key) : -1;
    if (!relation || !scalars || index < 0) throw new CadSketchLoweringRefusal(`${relationId}.${key}`, 'value');
    return evaluateCadScalar(scalars.read(relation as never)[index], this.parameters);
  }
  direct(fromPointId: string, towardPointId: string, message: string) {
    if (!cadSketchLineDirection({ startPointId: fromPointId, endPointId: towardPointId } as Entity<'line'>, this.numericPoints)) throw new Error(message);
  }

  side(pointId: string, axis: 0 | 1): 1 | -1 {
    const start = this.numericPoints.get(pointId);
    if (!start) throw new Error(`Sketch point "${pointId}" has no start value to take its side from.`);
    return (axis ? start.y : start.x) >= 0 ? 1 : -1;
  }

  emit(kind: CadSketchEquationKind, operands: readonly number[], value = 0) {
    if (operands.some(operand => operand < 0)) {
      const specialized = SPECIALIZATIONS[kind]?.(operands, value);
      if (specialized) [kind, operands, value] = specialized;
      operands = operands.map(operand => operand < 0 ? this.sentinelParameter(operand) : operand);
    }
    if (this.yielding) this.equations.push({ kind, operands, value, sourceId: this.sourceId, tag: this.tags++, yields: true });
    else this.equations.push({ kind, operands, value, sourceId: this.sourceId, tag: this.sharedTag ?? this.tags++ });
  }
  /** The parameter a fixed value of the origin or an axis became, made the first time an equation keeps it. */
  private sentinelParameter(sentinel: number): number {
    let index = this.sentinels.get(sentinel);
    if (index === undefined) { index = this.parameterCount + this.made.length; this.made.push({ value: fixedValue(sentinel), fixed: true }); this.sentinels.set(sentinel, index); }
    return index;
  }
  together(lower: () => void) {
    this.sharedTag = this.tags++;
    try { lower(); } finally { this.sharedTag = undefined; }
  }

  offset(axis: 0 | 1, fromPointId: string, toPointId: string, offset = 0) {
    this.emit('difference', [this.point(fromPointId)[axis], this.point(toPointId)[axis]], offset);
  }
  hold(pointId: string, axis: 0 | 1, value: number) {
    this.emit('value', [this.point(pointId)[axis]], value);
  }
  start(pointId: string, position: Point2): boolean {
    let seeded = false;
    for (const member of this.membersOf(pointId)) {
      const x = this.pointParameters.get(member);
      if (x === undefined) continue;
      for (const [index, value] of [[x, position.x], [x + 1, position.y]] as const) if (!this.fixed[index]) { this.seeds.push({ index, value }); seeded = true; }
    }
    return seeded;
  }
  /** The stored points of the point's Coincident identity. */
  private membersOf(pointId: string): readonly string[] {
    if (!this.members) {
      this.members = new Map();
      for (const point of this.graph.points) {
        const root = this.identity(point.id), list = this.members.get(root);
        if (list) list.push(point.id); else this.members.set(root, [point.id]);
      }
    }
    return this.members.get(this.identity(pointId)) ?? [];
  }
  held(pointId: string): CadSketchPointHold {
    const root = this.identity(pointId), known = this.holds.get(root);
    if (known) return known;
    const virtual = cadSketchVirtualPosition(root);
    let x = virtual?.x, y = virtual?.y;
    for (const member of this.membersOf(root)) {
      const index = this.pointParameters.get(member), at = this.numericPoints.get(member);
      if (index === undefined || !at) continue;
      if (this.fixed[index]) x ??= at.x;
      if (this.fixed[index + 1]) y ??= at.y;
    }
    this.byId ??= [...this.graph.relations].sort((first, second) => first.id < second.id ? -1 : first.id > second.id ? 1 : 0);
    for (const relation of this.byId) {
      if (relation.kind === 'point-on-line' && this.identity(relation.pointId) === root) {
        if (relation.lineId === CAD_SKETCH_H_AXIS_ID) y ??= 0;
        else if (relation.lineId === CAD_SKETCH_V_AXIS_ID) x ??= 0;
      }
      if (relation.kind !== 'fixed-point' && relation.kind !== 'fixed-axis' || this.identity(relation.pointId) !== root) continue;
      try {
        if (relation.kind === 'fixed-point') { x ??= this.value(relation.id, 'position.0'); y ??= this.value(relation.id, 'position.1'); }
        else if (relation.axis === 'x') x ??= this.value(relation.id, 'value');
        else y ??= this.value(relation.id, 'value');
      } catch { /* A value that cannot be read holds nothing here; its own relation refuses it. */ }
    }
    const hold: CadSketchPointHold = { ...x === undefined ? {} : { x }, ...y === undefined ? {} : { y } };
    this.holds.set(root, hold);
    return hold;
  }
  startChoice(relationId: string, count: number): number {
    const index = this.chosen[relationId] ?? 0;
    return Number.isInteger(index) && index >= 0 && index < count ? index : 0;
  }
  choose(costs: readonly number[]): number {
    if (costs.length < 2) return 0;
    this.startChoices.push({ relationId: this.sourceId, costs });
    return this.startChoice(this.sourceId, costs.length);
  }
  unmet(relationIds: readonly string[]) {
    this.unmetRelations.push({ relationId: this.sourceId, relationIds });
  }
  mirrorTurn(firstLineId: string, secondLineId: string, mirrorId: string): CadSketchMirrorTurn | undefined {
    return cadSketchRelationPlanner(this.graph).mirrorTurn(firstLineId, secondLineId, mirrorId);
  }
  lineAngle(lineId: string): number | undefined {
    return cadSketchRelationPlanner(this.graph).lineAngle(lineId);
  }
  onSupport(pointId: string, support: CadSketchSupportParameters) {
    this.emit('point-on-line', [...this.point(pointId), ...support]);
  }
  onCircle(pointId: string, edge: CadSketchEdge) {
    const centre = this.centre(edge), size = this.size(edge);
    this.equalSizes(this.span(centre, pointId), size);
    this.radialHolds.push({ point: this.parametersOf(this.point(pointId)), centre: this.parametersOf(this.point(centre)), size });
  }
  squareStart(pivotId: string, armId: string, towardId: string) {
    this.squareHolds.push({ pivot: this.parametersOf(this.point(pivotId)), arm: this.parametersOf(this.point(armId)), toward: this.parametersOf(this.point(towardId)) });
  }
  /** The parameters a point's coordinates are, the origin's as the fixed parameters its values became. */
  private parametersOf([x, y]: CadSketchPointParameters): CadSketchPointParameters {
    return [x < 0 ? this.sentinelParameter(x) : x, y < 0 ? this.sentinelParameter(y) : y];
  }
  /** Two spans give an equal-length equation, a span and a parameter a distance to it, and two parameters a difference. */
  equalSizes(first: CadSketchSizeParameters, second: CadSketchSizeParameters) {
    if (first.kind === 'parameter' && second.kind === 'parameter') this.emit('difference', [first.index, second.index]);
    else if (first.kind === 'span' && second.kind === 'span') this.emit('equal-length', [...first.span, ...second.span]);
    else if (first.kind === 'span' && second.kind === 'parameter') this.emit('distance-to-parameter', [...first.span, second.index]);
    else if (first.kind === 'parameter' && second.kind === 'span') this.emit('distance-to-parameter', [...second.span, first.index]);
  }
  sized(size: CadSketchSizeParameters, value: number) {
    if (size.kind === 'span') this.emit('distance', size.span, value);
    else this.emit('value', [size.index], value);
  }
  negatedSize(edge: CadSketchEdge, pointId: string, axis: 0 | 1) {
    const size = this.size(edge), coordinate = this.point(pointId)[axis], zero = this.point(CAD_SKETCH_ORIGIN_ID)[axis];
    if (size.kind === 'parameter') return this.emit('midpoint', [coordinate, size.index, zero]);
    const at = this.numericPoints.get(pointId), ends = capability(RADII, edge)?.(this, edge);
    const [centre, start] = ends ? ends.map(id => this.numericPoints.get(id)) : [];
    if (!at || !centre || !start) throw new CadSketchLoweringRefusal(edge.id, 'size');
    // A free radius between parameters that cannot move would be held twice, a dependence its mirror does not have.
    if ([...size.span, coordinate].every(index => this.isFixed(index))) return this.sized(size, -(axis ? at.y : at.x));
    const radius = this.parameterCount + this.made.length;
    this.made.push({ value: Math.hypot(start.x - centre.x, start.y - centre.y), fixed: false });
    this.equalSizes(size, { kind: 'parameter', index: radius });
    this.emit('midpoint', [coordinate, radius, zero]);
  }
  /** Whether a parameter cannot move: a fixed point or radius parameter, a value the origin or an axis became, or a made fixed one. */
  private isFixed(index: number): boolean {
    return index < 0 || (index < this.parameterCount ? this.fixed[index] : this.made[index - this.parameterCount]?.fixed) === true;
  }
}
