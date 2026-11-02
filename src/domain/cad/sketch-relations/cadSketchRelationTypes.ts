import type { CadScalar } from '../cadDocument';
import type { CadSketchGraph, CadSketchGraphEntity, CadSketchGraphIssue, CadSketchGraphPoint, CadSketchGraphRelation } from '../cadSketchGraph';
import type { CadSketchGraphSelection } from '../cadSketchGraphSelection';
import type { CadSketchQuantity } from '../cadSketchQuantity';
import type { CadSketchLoweringContext } from '../sketch-solver/cadSketchLoweringContext';
import type { CadSketchVirtualAxis, CadSketchVirtualPoint } from './cadSketchVirtualElements';
import type { Point2 } from '@/domain/path-intel/types';

export type CadSketchRelationKind = CadSketchGraphRelation['kind'];
// The schema stores several kinds with one shape, whose `kind` is their union, so a kind is narrowed rather than extracted.
type Narrowed<R, K> = R extends { readonly kind: infer Stored } ? K extends Stored ? R & { readonly kind: K } : never : never;
export type CadSketchRelationOf<K extends CadSketchRelationKind> = Narrowed<CadSketchGraphRelation, K>;
/** A relation without its identity: what an offer adds once it is given one. */
// Each stored shape of a kind loses its identity on its own, so a kind with variants keeps each variant's operands.
type WithoutId<R> = R extends unknown ? Omit<R, 'id'> : never;
export type CadSketchRelationIntent<K extends CadSketchRelationKind = CadSketchRelationKind> = K extends CadSketchRelationKind ? WithoutId<CadSketchRelationOf<K>> : never;

/** What an operand is: a point, the origin among them, or an edge, with the H and V axes as `axis`. */
export type CadSketchOperandType = 'point' | 'line' | 'arc' | 'circle' | 'axis';
/**
 * What a slot accepts: one type, or a group of them. A curve is any line, arc, circle or axis and a round an arc or circle. A `line` slot
 * takes the H and V axes too, as infinite lines; an `axis` slot takes only them.
 */
export type CadSketchOperandTrait = CadSketchOperandType | 'curve' | 'round';
/**
 * What a slot may need of its operand beyond its type. The origin and the axes are fixed, so they are not `movable`; an axis is
 * infinite, so it has no `ends`, `length` or `midpoint`.
 */
export type CadSketchOperandCapability = 'movable' | 'ends' | 'length' | 'midpoint';
/** A point or edge an operand names: one of the sketch's own, or the origin or an axis. */
export type CadSketchElement = CadSketchGraphPoint | CadSketchVirtualPoint | CadSketchGraphEntity | CadSketchVirtualAxis;
export type CadSketchEdge = CadSketchGraphEntity | CadSketchVirtualAxis;
/** The error a parse gives for operands that cannot take a relation. */
export interface CadSketchRefusal { readonly code: string; readonly message: string }

export interface CadSketchOperandSlot {
  /** What the operand is to the relation, in sentence case, as people and agents are told. */
  readonly role: string;
  readonly accepts: readonly CadSketchOperandTrait[];
  /** What the operand must also give; an operand without one is refused with the reason that capability gives. */
  readonly needs?: readonly CadSketchOperandCapability[];
  /** A point of the entity in the slot before it, such as the end it joins at. That entity already names it, so it adds no reference of its own. */
  readonly end?: true;
  /** Refuse an operand that is missing or has none of the accepted traits, with this error. Without it, the point references check covers the slot. */
  readonly refusal?: CadSketchRefusal;
}
export interface CadSketchOperandSignature {
  readonly slots: readonly CadSketchOperandSlot[];
  /**
   * Slot groups whose order does not change the relation: reordering one keeps the relation's canonical key. An `end` slot after a
   * grouped slot moves with it.
   */
  readonly unordered?: readonly (readonly number[])[];
  /** Refuse an id repeated among these slots with this error. It is checked before any slot. */
  readonly distinct?: { readonly slots: readonly number[]; readonly refusal: CadSketchRefusal };
  /** How a longer selection expands: one relation for each pick, or one between the first pick and each later one. */
  readonly expand?: 'each' | 'chain-from-first';
}
/** The element each slot names, or undefined where a slot without a refusal names nothing. */
export type CadSketchResolvedOperands = readonly (CadSketchElement | undefined)[];
/** How operand labels name points and edges, such as "Point 3" and "Line 5". */
export interface CadSketchOperandNames { point(id: string): string; entity(id: string): string }
/** Points and edges a relation made and keeps: removing it removes them. Their own points belong to it too. */
export interface CadSketchRelationOwnership { readonly pointIds: readonly string[]; readonly entityIds: readonly string[] }

type Line = Extract<CadSketchGraphEntity, { kind: 'line' }>;
type Round = Extract<CadSketchGraphEntity, { kind: 'arc' | 'circle' }>;
/**
 * What the picks of a relation would do: add these relations, find the graph holding it already, or be refused. An applied plan names
 * the relations that hold it, and says how when that is more than one identical relation, such as a joint or a fix. A refusal keeps
 * the precise message, as domain errors do; the workbench shows it through `readableMessage`.
 */
export type CadSketchRelationPlan =
  | { readonly state: 'available'; readonly relations: readonly CadSketchRelationIntent[] }
  | { readonly state: 'applied'; readonly relationIds: readonly string[]; readonly reason?: string }
  | { readonly state: 'blocked'; readonly reason: string };
/**
 * The Constrain tool's planning of the relations that need no value. The offers share it, so both give one answer for the same picks.
 * Plans read the graph as it is: identical relations, Coincident identities, held coordinates, and what the value-free relations
 * already keep level, upright or in one direction.
 */
export interface CadSketchRelationPlanner {
  readonly graph: CadSketchGraph;
  /** A point by id, the origin included. */
  point(id: string): CadSketchGraphPoint | CadSketchVirtualPoint | undefined;
  /** An edge by id, the H and V axes included. */
  entity(id: string): CadSketchEdge | undefined;
  /** The point's Coincident identity: points that Coincident joins share one. */
  identity(id: string): string;
  /** Two points kept level or upright. */
  align(kind: 'horizontal' | 'vertical', pair: readonly [string, string]): CadSketchRelationPlan;
  /** Two points joined in one place. */
  coincide(pair: readonly [string, string]): CadSketchRelationPlan;
  /** Two arcs or circles that share one centre. */
  concentric(first: Round, second: Round): CadSketchRelationPlan;
  /** An arc or circle centred on a point, the origin included, or on an axis. */
  centre(curve: Round, targetId: string): CadSketchRelationPlan;
  /** Two lines that keep one direction, a right angle, or one line between them. */
  orient(kind: 'parallel' | 'perpendicular' | 'collinear', pair: readonly [string, string]): CadSketchRelationPlan;
  /** A point kept on a line, at its middle, or on an arc or circle. */
  place(relation: CadSketchRelationIntent<'point-on-line' | 'midpoint' | 'point-on-curve'>): CadSketchRelationPlan;
  /**
   * A line and an arc, in either order, joined smoothly at the one pair of their ends that share a place; or an arc or circle and an
   * axis it touches.
   */
  tangent(first: CadSketchEdge, second: CadSketchEdge): CadSketchRelationPlan;
  /** Two lines of one length, or two arcs or circles of one radius. */
  equal(first: CadSketchEdge, second: CadSketchEdge): CadSketchRelationPlan;
  /** Two points, or a circle by its centre, mirrored about a line or an axis. */
  mirror(targets: readonly [CadSketchGraphSelection, CadSketchGraphSelection], line: Line | CadSketchVirtualAxis): CadSketchRelationPlan;
  /** A point held where it is: as one fixed point, or as each numeric coordinate that nothing holds yet. */
  fix(pointId: string): CadSketchRelationPlan;
}
/** One way a selection makes a relation: picks in slot order, planned as the Constrain tool plans them. */
export interface CadSketchRelationOffering {
  readonly signature: CadSketchOperandSignature;
  /** What the picks make, or null when picks in this order are not operands of the kind. A plan may add relations of another kind. */
  readonly plan: (planner: CadSketchRelationPlanner, picks: readonly CadSketchGraphSelection[]) => CadSketchRelationPlan | null;
}

export type CadSketchRelationFamily = 'incidence' | 'orientation' | 'equality' | 'fix' | 'dimension' | 'composite';

/**
 * How an operand follows an edit of the point or curve it names (see `remapCadSketchRelations`). The origin and the axes are never
 * edited, so an operand naming one keeps it whatever its role.
 */
export type CadSketchRemapRole =
  /** A point: follows it while it survives, under its new id, and blocks the edit when it leaves. */
  | 'point'
  /** A curve's whole supporting line or circle: follows the piece that keeps the curve's id, which shares that carrier with the others. */
  | 'carrier'
  /** A curve's finite extent, its ends, length or middle: follows it only while the edit keeps its whole interval. */
  | 'extent'
  /** A curve and the end of it the relation joins at: follows the piece that still has that end where it was. */
  | 'joint'
  /** A line and the end of it a ray points toward: follows the piece's end on that side, moved or not. */
  | 'toward'
  /** The end of the curve in the slot before, settled with that slot. */
  | 'end'
  /** Geometry the relation generates from: an edit that changes it is refused until the relation is detached. */
  | 'source';
/**
 * What a copy keeps of a relation internal to the copied set. `follow` copies it; `axes` only where the copy keeps the H and V
 * directions; `ends` only between the two ends of one copied line; `centres` only between centres of copied arcs and circles;
 * `unjoined` only where the copy does not already join its points; `drop` never.
 */
export type CadSketchCopyRule = 'follow' | 'axes' | 'ends' | 'centres' | 'unjoined' | 'drop';
/** How a kind's relations follow geometry-changing edits and copies, declared once for every operation. */
export interface CadSketchRemapRule<R extends CadSketchGraphRelation = CadSketchGraphRelation> {
  /** Each stored slot's role, in slot order. */
  readonly roles: readonly CadSketchRemapRole[] | ((relation: R) => readonly CadSketchRemapRole[]);
  /** Two points that are the ends of one line, and of no other edge, hold that line's direction: each follows the line's end on its side. */
  readonly direction?: true;
  /** Point and curve slots whose point the kind keeps apart from the curve's own points; an edit that makes it an end is blocked. */
  readonly apart?: readonly (readonly [number, number])[];
  /** The end each `joint` slot without an end slot after it joins at, by slot. */
  readonly ends?: (graph: CadSketchGraph, relation: R) => readonly (string | undefined)[];
  /** An edit that changes geometry the relation owns is confirmed, removing the relation, or refused until the relation is detached. */
  readonly owned?: 'confirm' | 'refuse';
  /** What a mirror copy, an offset copy and a linear pattern's occurrences keep. Occurrences are owned by their pattern, so they keep only reference dimensions. */
  readonly copy: { readonly mirror: CadSketchCopyRule; readonly offset: CadSketchCopyRule; readonly pattern: CadSketchCopyRule };
  /** The relation with its stored side or sense set for a reflection, and for operands now on pieces that run the other way. */
  readonly orient?: (relation: R, change: { readonly reflected: boolean; readonly reversed: readonly boolean[] }) => R;
  /** The relation in its stored form after its operands change, such as a corner's lines in id order. */
  readonly normalize?: (relation: R) => R;
}

/**
 * Everything a relation kind declares once, so consumers read relations through it instead of switching on kinds: the solver compiles
 * its equations through `lower`, and the graph checks accept its geometry through `check`.
 */
export interface CadSketchRelationDefinition<K extends CadSketchRelationKind> {
  readonly kind: K;
  readonly family: CadSketchRelationFamily;
  /** Sentence-case name of the kind. */
  readonly name: string;
  /** The name of one relation, where it depends on its data. */
  readonly nameOf?: (relation: CadSketchRelationOf<K>) => string;
  /** What an inspection says one relation holds, where it depends on its data; otherwise the agent meaning of the kind. */
  readonly meaningOf?: (relation: CadSketchRelationOf<K>) => string;
  /** The stored operands, in `operands` order; a relation whose data has variants gives the slots of its own variant. */
  readonly stored: CadSketchOperandSignature | ((relation: CadSketchRelationOf<K>) => CadSketchOperandSignature);
  readonly operands: (relation: CadSketchRelationOf<K>) => readonly string[];
  /** The relation with `ids` in place of its operands, one for each slot. */
  readonly withOperands: (relation: CadSketchRelationOf<K>, ids: readonly string[]) => CadSketchRelationOf<K>;
  /** Driving values, named by their path in the relation's data, with what each measures. */
  readonly scalars?: {
    readonly keys: readonly string[];
    readonly quantity: { readonly [key: string]: CadSketchQuantity };
    readonly read: (relation: CadSketchRelationOf<K>) => readonly CadScalar[];
    readonly write: (relation: CadSketchRelationOf<K>, values: readonly CadScalar[]) => CadSketchRelationOf<K>;
  };
  readonly owns?: (relation: CadSketchRelationOf<K>) => CadSketchRelationOwnership;
  /** Equal for relations that hold the same thing on the same operands, whatever order an unordered group is stored in; never compares values. */
  readonly key: (relation: CadSketchRelationOf<K>) => string;
  /** The operand labels a description lists, where they are not one for each point and edge slot. */
  readonly mentions?: (relation: CadSketchRelationOf<K>, names: CadSketchOperandNames) => readonly string[];
  /** The operands run from the first to the second, so a description joins them with an arrow. */
  readonly directed?: true;
  /** Checks parsing makes beyond the slot refusals, after them, with the operands they resolved. */
  readonly validate?: (graph: CadSketchGraph, relation: CadSketchRelationOf<K>, operands: CadSketchResolvedOperands) => void;
  /** The points the relation references, where they are not its point slots and the points of its edges. */
  readonly pointIds?: (graph: CadSketchGraph, relation: CadSketchRelationOf<K>) => readonly string[];
  /** Selections that make this relation, tried in order. A relation that needs a value, or one that tools create, has none. */
  readonly offers?: readonly CadSketchRelationOffering[];
  /**
   * The relation's scalar equations, emitted through `context` in the order the solver takes them. A relation that drives nothing
   * emits none. Errors it throws reject the solve with their message.
   */
  readonly lower: (relation: CadSketchRelationOf<K>, context: CadSketchLoweringContext) => void;
  /**
   * Whether the relation yields to the rest of the sketch: it holds whatever others do not already keep of it. Such a relation lowers
   * after every relation that does not yield, in graph order, and each of its equations is a constraint of its own, so the solver sets
   * one of its equations aside for any dependence the relation is part of. One set aside that agrees is solved but not redundant,
   * unless every equation of the relation is, so that it adds nothing and is redundant as a whole; one that disagrees still
   * conflicts. Solving every equation leaves the relation whole, with no branch for a dropped equation to open, and the freedom left
   * counts only what it adds.
   */
  readonly yields?: (relation: CadSketchRelationOf<K>) => boolean;
  /**
   * Whether the numeric geometry meets the relation, in world millimetres and independently of the solver: `points` holds the
   * points whose coordinates are numeric and in range. An error it throws is reported as the relation's invalid expression.
   */
  readonly check: (graph: CadSketchGraph, relation: CadSketchRelationOf<K>, points: ReadonlyMap<string, Point2>,
    parameters: Readonly<Record<string, number>>) => readonly CadSketchGraphIssue[];
  /** How the kind follows trim, extend, split, mirror and the copies, by the role of each operand. */
  readonly remap: CadSketchRemapRule<CadSketchRelationOf<K>>;
  /**
   * Whether agent tools may name the kind, what they are told it does, and what an inspection of one relation says it holds and
   * leaves free.
   */
  readonly agent: { readonly exposed: boolean; readonly summary: string; readonly meaning: string };
}
export type CadSketchRelationDefinitions = { readonly [K in CadSketchRelationKind]: CadSketchRelationDefinition<K> };
