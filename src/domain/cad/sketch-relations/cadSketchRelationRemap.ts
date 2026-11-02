import { isAcceptedCadSketchGraph, type CadSketchGraph, type CadSketchGraphRelation } from '../cadSketchGraph';
import { resolveCadSketchPointIdentities } from '../cadSketchGraphJoints';
import { cadSketchCurveTraits, type CadSketchCurveCapabilities, type CadSketchCurveTraits } from './cadSketchCurveCapabilities';
import { cadSketchRelationDefinition, cadSketchRelationSignature } from './cadSketchRelationRegistry';
import type { CadSketchCopyRule, CadSketchRemapRole, CadSketchRemapRule } from './cadSketchRelationTypes';
import { CAD_SKETCH_ORIGIN_ID, isCadSketchVirtualId, type CadSketchVirtualAxisId } from './cadSketchVirtualElements';

// What a geometry-changing edit does to the relations and dimensions on what it changes, by the rule each kind declares (`remap` on its
// definition). Trim, extend, split, pattern omission, mirror, offset and the linear pattern's occurrences describe their edit or copy here
// and read one outcome for each relation, so no operation carries a rule of its own. Each operand follows by its role: a curve's carrier,
// extent, joint or ray end, or a point. Curves are read only through their traits (`cadSketchCurveTraits`), so a new kind of curve (an
// ellipse, a spline) needs only its traits and its pieces' intervals, never a rule per operation. A sketch circular pattern, should one be
// added, must copy through `copyCadSketchRelations` as a rotation, as the linear pattern copies as a translation.

/**
 * One curve of the edited graph that covers a span of an old curve. `interval` is the span of the old curve's parameter it covers, from
 * low to high: [0, 1] is the whole curve, a trimmed end is shorter and an extended one reaches past 0 or 1. A circle's parameter is its
 * phase from +X counterclockwise, so an arc cut from it may span past 1. `orientation` says whether the piece runs the old curve's way
 * or against it. `ends` are the points at the piece's own start and end, where the curve has ends.
 */
export interface CadSketchRemapPiece {
  readonly entityId: string;
  readonly interval: readonly [number, number];
  readonly orientation: 'same' | 'reversed';
  readonly ends?: readonly [string, string];
}
/**
 * An edit as a map from old curves and points to new ones. Each curve it changes has its pieces in the edited graph, none when it leaves;
 * each point it renames has its new id, or null when it leaves. Curves and points it does not name are unchanged. The pieces of one curve
 * stay on its carrier through the edit's own geometry, a support relation or a shared centre, so a relation that holds the carrier on one
 * piece holds it on all of them. `identity` is the graph's point identities, when the caller has them already.
 */
export interface CadSketchRelationEdit {
  readonly curves: ReadonlyMap<string, readonly CadSketchRemapPiece[]>;
  readonly points?: ReadonlyMap<string, string | null>;
  readonly identity?: (pointId: string) => string;
  /** How to read curves of a kind `cadSketchCurveTraits` does not know yet. */
  readonly traits?: CadSketchCurveCapabilities;
}
/**
 * A copy of some of the sketch's geometry, as a map from each copied curve and point to its copy. A mirror reflects, an offset moves each
 * curve along its normal, and a pattern translates its seed to each occurrence it generates. Elements in `invariant`, such as the mirror
 * line and its ends, are their own copies.
 */
export interface CadSketchRelationCopy {
  readonly kind: 'mirror' | 'offset' | 'pattern';
  readonly curves: ReadonlyMap<string, CadSketchRemapPiece>;
  readonly points: ReadonlyMap<string, string>;
  readonly invariant?: ReadonlySet<string>;
  /**
   * The H or V axis a mirror reflects about. Such a copy keeps the origin, both axes and the H and V directions in place, though it lays
   * the other axis on itself the other way round. Any other copy moves away from them.
   */
  readonly axis?: CadSketchVirtualAxisId;
  /** The id of the `index`th relation copied, in graph order. */
  readonly relationId: (relation: CadSketchGraphRelation, index: number) => string;
  /** How to read curves of a kind `cadSketchCurveTraits` does not know yet. */
  readonly traits?: CadSketchCurveCapabilities;
}
/**
 * What an edit does to one relation: keeps it, replaces it with relations of the same kind on new operands, removes it, or blocks the
 * edit, which a trim asks to confirm (removing the relation) and other edits refuse. A block that cannot be confirmed, such as a pattern's
 * seed, refuses every edit. For a copy the original always stays: `replace` gives the relation as the copy carries it and `remove` says why
 * the copy leaves it out.
 */
export type CadSketchRemapOutcome =
  | { readonly kind: 'retain'; readonly relation: CadSketchGraphRelation }
  | { readonly kind: 'replace'; readonly relation: CadSketchGraphRelation; readonly relations: readonly CadSketchGraphRelation[] }
  | { readonly kind: 'remove'; readonly relation: CadSketchGraphRelation; readonly reason: string }
  | { readonly kind: 'blocked'; readonly relation: CadSketchGraphRelation; readonly reason: string; readonly confirmable: boolean };
export type CadSketchBlockedRemap = Extract<CadSketchRemapOutcome, { kind: 'blocked' }>;

const ruleOf = (relation: CadSketchGraphRelation): CadSketchRemapRule => cadSketchRelationDefinition(relation).remap as CadSketchRemapRule;
const rolesOf = (relation: CadSketchGraphRelation, rule: CadSketchRemapRule) => typeof rule.roles === 'function' ? rule.roles(relation) : rule.roles;
const isPoint = (role: CadSketchRemapRole | undefined) => role === 'point' || role === 'end';

interface GraphIndex {
  /** Each curve's traits, by id. */
  readonly curves: ReadonlyMap<string, CadSketchCurveTraits>;
  readonly pointIds: ReadonlySet<string>;
  /** Each point or edge id with the relations that name it as an operand or own it, in graph order. */
  readonly naming: ReadonlyMap<string, readonly number[]>;
  /** Each pair of end points, sorted and joined by a space, with the curves that end there. */
  readonly ended: ReadonlyMap<string, readonly string[]>;
  /** Each centre with the curves drawn about it. */
  readonly centred: ReadonlyMap<string, readonly string[]>;
}
const indexes = new WeakMap<CadSketchGraph, GraphIndex>();
const identities = new WeakMap<CadSketchGraph, (pointId: string) => string>();
/**
 * Which points the graph joins, by Coincident: each point id to the id standing for its joined group. An accepted graph keeps its
 * identities, as it keeps its index, so trim, extend and each remap of it resolve them once.
 */
export function cadSketchPointIdentities(graph: CadSketchGraph): (pointId: string) => string {
  const kept = identities.get(graph);
  if (kept) return kept;
  const identity = resolveCadSketchPointIdentities(graph);
  if (isAcceptedCadSketchGraph(graph)) identities.set(graph, identity);
  return identity;
}
const pairKey = (a: string, b: string) => a < b ? `${a} ${b}` : `${b} ${a}`;
const push = <T>(map: Map<string, T[]>, key: string, value: T) => { const list = map.get(key); if (list) list.push(value); else map.set(key, [value]); };
/**
 * The graph read once for remapping; an accepted graph keeps its index, so each later edit visits only the relations it touches. Curves
 * of a kind only the caller knows are read through its own `traits`, and that index is not kept.
 */
function graphIndex(graph: CadSketchGraph, traits: CadSketchCurveCapabilities = cadSketchCurveTraits): GraphIndex {
  const shared = traits === cadSketchCurveTraits, kept = shared ? indexes.get(graph) : undefined;
  if (kept) return kept;
  const naming = new Map<string, number[]>(), ended = new Map<string, string[]>(), centred = new Map<string, string[]>();
  const curves = new Map<string, CadSketchCurveTraits>();
  const add = (id: string, at: number) => { const list = naming.get(id); if (!list) naming.set(id, [at]); else if (list.at(-1) !== at) list.push(at); };
  graph.relations.forEach((relation, at) => {
    const definition = cadSketchRelationDefinition(relation), owned = definition.owns?.(relation);
    for (const id of definition.operands(relation)) add(id, at);
    for (const id of [...owned?.entityIds ?? [], ...owned?.pointIds ?? []]) add(id, at);
  });
  for (const entity of graph.entities) {
    const curve = traits(entity);
    curves.set(entity.id, curve);
    if (curve.ends) push(ended, pairKey(curve.ends[0], curve.ends[1]), entity.id);
    if (curve.centre !== null) push(centred, curve.centre, entity.id);
  }
  const index = { curves, pointIds: new Set(graph.points.map(point => point.id)), naming, ended, centred };
  if (shared && isAcceptedCadSketchGraph(graph)) indexes.set(graph, index);
  return index;
}
/** The relations that name any of `ids`, and those that hold the direction of a line ending at a point in `ends`, in graph order. */
function touched(graph: CadSketchGraph, index: GraphIndex, ids: Iterable<string>, ends: Iterable<string>): readonly CadSketchGraphRelation[] {
  const found = new Set<number>();
  for (const id of ids) for (const at of index.naming.get(id) ?? []) found.add(at);
  for (const id of ends) for (const at of index.naming.get(id) ?? []) if (ruleOf(graph.relations[at]).direction) found.add(at);
  return [...found].sort((a, b) => a - b).map(at => graph.relations[at]);
}

const whole = (pieces: readonly CadSketchRemapPiece[] | undefined) => pieces !== undefined && pieces.length === 1 && pieces[0].interval[0] === 0 && pieces[0].interval[1] === 1;
/** The piece that keeps a curve's id, else its first: its pieces share its carrier. */
const primary = (id: string, pieces: readonly CadSketchRemapPiece[]) => pieces.find(piece => piece.entityId === id) ?? pieces[0];
/** Which end of the old curve a point is: 0 for its start, 1 for its end, and null for a curve without ends. */
function sideOf(curve: CadSketchCurveTraits | undefined, pointId: string): 0 | 1 | null {
  const ends = curve?.ends;
  return !ends ? null : ends[0] === pointId ? 0 : ends[1] === pointId ? 1 : null;
}
/** The piece that still has the old curve's end on `side`, with that end where it was. */
const holder = (pieces: readonly CadSketchRemapPiece[], side: 0 | 1) => pieces.find(piece => piece.interval[side] === side);
/** The point at the piece's end on the old curve's `side`: a piece running against the old curve has that end at its own start. */
const endOn = (piece: CadSketchRemapPiece, side: 0 | 1) => piece.ends?.[(side === 1) === (piece.orientation === 'same') ? 1 : 0];
/** The piece reaching farthest toward `side`, with the point at its end there, wherever that end now is. */
function reaching(pieces: readonly CadSketchRemapPiece[], side: 0 | 1): { readonly piece: CadSketchRemapPiece; readonly pointId: string } | null {
  if (!pieces.length) return null;
  const piece = pieces.reduce((best, next) => side === 0 ? next.interval[0] < best.interval[0] ? next : best : next.interval[1] > best.interval[1] ? next : best);
  const pointId = endOn(piece, side);
  return pointId === undefined ? null : { piece, pointId };
}

type Failure = { readonly reason: string; readonly confirmable: boolean };
type Resolved = { readonly ids: readonly string[]; readonly reversed: readonly boolean[] } | Failure;
const failed = (value: Resolved): value is Failure => 'reason' in value;
const REASONS = {
  pointLeaves: 'A point it names leaves with the edit.',
  curveLeaves: 'A curve it names leaves with the edit.',
  extent: 'It measures or holds the curve\'s length, ends or middle, which the edit changes.',
  joint: 'The end it joins at moves with the edit.',
  source: 'It generates the edited geometry: detach it before editing that geometry.',
  owned: 'The edit changes the geometry it made and keeps.',
  apart: 'A point it keeps apart from the curve\'s ends becomes one of them.'
} as const;
const block = (reason: string, confirmable = true): Failure => ({ reason, confirmable });
/** Why a copy's kind leaves a relation out by its rule; geometry outside the copy is a separate reason. */
const COPY_DROPS: Readonly<Record<CadSketchRelationCopy['kind'], string>> = {
  mirror: 'A mirrored copy does not keep it.',
  offset: 'An offset copy does not keep it.',
  pattern: 'The pattern owns its occurrences, which keep only reference dimensions: it drives them through the seed instead.'
};

/** The operands an edit gives a relation, by its rule, or why the edit cannot keep it. */
function resolveEdit(graph: CadSketchGraph, index: GraphIndex, edit: CadSketchRelationEdit, relation: CadSketchGraphRelation, identity: () => (id: string) => string): Resolved {
  const definition = cadSketchRelationDefinition(relation), rule = ruleOf(relation), roles = rolesOf(relation, rule);
  const slots = cadSketchRelationSignature(relation).slots, ids = definition.operands(relation), next = [...ids], reversed = ids.map(() => false);
  const points = edit.points ?? new Map<string, string | null>();
  const owned = definition.owns?.(relation);
  if (owned && (owned.entityIds.some(id => edit.curves.has(id) && !whole(edit.curves.get(id))) || owned.pointIds.some(id => points.get(id) === null)))
    return rule.owned === 'refuse' ? block(REASONS.source, false) : block(REASONS.owned);
  // Two points at the ends of one line, and of no other edge, hold that line's direction: each follows the line's end on its side.
  const pair = rule.direction && ids.length === 2 ? index.ended.get(pairKey(ids[0], ids[1])) : undefined;
  if (pair?.length === 1 && index.curves.get(pair[0])?.straight && edit.curves.has(pair[0])) {
    const line = index.curves.get(pair[0]), pieces = edit.curves.get(pair[0])!;
    for (const at of [0, 1]) {
      const side = sideOf(line, ids[at])!, kept = holder(pieces, side), moved = kept ? null : reaching(pieces, side);
      if (!kept && !moved) return block(REASONS.curveLeaves);
      next[at] = kept ? endOn(kept, side) ?? ids[at] : moved!.pointId;
    }
    return { ids: next, reversed };
  }
  const ends = rule.ends?.(graph, relation);
  for (let at = 0; at < slots.length; at += 1) {
    const role = roles[at], id = ids[at];
    if (role === 'end' || isCadSketchVirtualId(id)) continue;
    if (role === 'point') {
      const mapped = points.get(id);
      if (mapped === null) return block(REASONS.pointLeaves);
      if (mapped !== undefined) next[at] = mapped;
      continue;
    }
    const pieces = edit.curves.get(id), endSlot = slots[at + 1]?.end ? at + 1 : null;
    if (!pieces) {
      // An end slot follows its point while its curve is unchanged.
      if (endSlot !== null) {
        const mapped = points.get(ids[endSlot]);
        if (mapped === null) return block(REASONS.pointLeaves);
        if (mapped !== undefined) next[endSlot] = mapped;
      }
      continue;
    }
    if (role === 'source') {
      if (!whole(pieces) || pieces[0].entityId !== id) return block(REASONS.source, false);
      continue;
    }
    if (!pieces.length) return block(REASONS.curveLeaves);
    if (role === 'carrier') {
      const piece = primary(id, pieces);
      next[at] = piece.entityId; reversed[at] = piece.orientation === 'reversed';
      continue;
    }
    if (role === 'extent') {
      if (!whole(pieces)) return block(REASONS.extent);
      next[at] = pieces[0].entityId; reversed[at] = pieces[0].orientation === 'reversed';
      continue;
    }
    // A joint or a ray: the curve with one of its ends, in the next slot or as the kind gives it.
    const endId = endSlot !== null ? ids[endSlot] : ends?.[at], side = endId === undefined ? null : sideOf(index.curves.get(id), endId);
    if (side === null) return block(REASONS.joint);
    const kept = holder(pieces, side);
    if (kept) {
      next[at] = kept.entityId; reversed[at] = kept.orientation === 'reversed';
      if (endSlot !== null) next[endSlot] = endOn(kept, side) ?? endId!;
      continue;
    }
    if (role === 'joint') return block(REASONS.joint);
    const moved = reaching(pieces, side);
    if (!moved) return block(REASONS.curveLeaves);
    next[at] = moved.piece.entityId; reversed[at] = moved.piece.orientation === 'reversed';
    if (endSlot !== null) next[endSlot] = moved.pointId;
  }
  // A point the kind keeps apart from a curve's own points may not become an end of any of its pieces, which share its carrier.
  for (const [pointSlot, curveSlot] of rule.apart ?? []) {
    if (roles[pointSlot] !== 'point' || isPoint(roles[curveSlot])) continue;
    const pieces = edit.curves.get(ids[curveSlot]);
    if (!pieces?.length) continue;
    const resolve = identity(), known = (pointId: string) => index.pointIds.has(pointId) ? resolve(pointId) : pointId, point = known(next[pointSlot]);
    if (pieces.some(piece => piece.ends?.some(end => known(end) === point))) return block(REASONS.apart);
  }
  return { ids: next, reversed };
}

/** The relation with its new operands, its stored side or sense set for them, in its stored form. */
function moved(relation: CadSketchGraphRelation, resolved: Exclude<Resolved, Failure>, reflected: boolean): CadSketchGraphRelation {
  const rule = ruleOf(relation), next = cadSketchRelationDefinition(relation).withOperands(relation, resolved.ids);
  const oriented = rule.orient && (reflected || resolved.reversed.some(Boolean)) ? rule.orient(next, { reflected, reversed: resolved.reversed }) : next;
  return rule.normalize ? rule.normalize(oriented) : oriented;
}
function outcome(relation: CadSketchGraphRelation, resolved: Resolved): CadSketchRemapOutcome {
  if (failed(resolved)) return { kind: 'blocked', relation, reason: resolved.reason, confirmable: resolved.confirmable };
  const ids = cadSketchRelationDefinition(relation).operands(relation);
  if (resolved.ids.every((id, at) => id === ids[at]) && !resolved.reversed.some(Boolean)) return { kind: 'retain', relation };
  const settled = moved(relation, resolved, false);
  return JSON.stringify(settled) === JSON.stringify(relation) ? { kind: 'retain', relation } : { kind: 'replace', relation, relations: [settled] };
}

/**
 * Each relation the edit touches with what the edit does to it, in graph order. Relations it does not touch are kept and not listed. It
 * visits only relations that name an edited curve or point, or that hold the direction of an edited line through its ends.
 */
export function remapCadSketchRelations(graph: CadSketchGraph, edit: CadSketchRelationEdit): readonly CadSketchRemapOutcome[] {
  const index = graphIndex(graph, edit.traits), points = edit.points ?? new Map<string, string | null>();
  const ends = [...edit.curves.keys()].flatMap(id => index.curves.get(id)?.ends ?? []);
  // Resolved at most once per call, and kept with an accepted graph for later calls.
  let identity = edit.identity;
  const identities = () => identity ??= cadSketchPointIdentities(graph);
  return touched(graph, index, [...edit.curves.keys(), ...points.keys()], ends).map(relation => outcome(relation, resolveEdit(graph, index, edit, relation, identities)));
}
/** The outcomes that block the edit, in graph order. */
export const blockedCadSketchRemaps = (outcomes: readonly CadSketchRemapOutcome[]): readonly CadSketchBlockedRemap[] =>
  outcomes.filter((item): item is CadSketchBlockedRemap => item.kind === 'blocked');

/** The operands a copy gives a relation, or why the copy leaves it out. */
function resolveCopy(index: GraphIndex, copy: CadSketchRelationCopy, relation: CadSketchGraphRelation): Exclude<Resolved, Failure> | string {
  const definition = cadSketchRelationDefinition(relation), rule = ruleOf(relation), roles = rolesOf(relation, rule);
  if (definition.owns) return 'It owns geometry, which the copy keeps plain.';
  const copies: CadSketchCopyRule = rule.copy[copy.kind];
  if (copies === 'drop') return COPY_DROPS[copy.kind];
  if (copies === 'axes' && !copy.axis) return 'It holds the H or V direction, which a mirror about this line does not keep.';
  const ids = definition.operands(relation), next = [...ids], reversed = ids.map(() => false), invariant = copy.invariant ?? new Set<string>();
  let kept = false;
  for (const [at, id] of ids.entries()) {
    if (roles[at] === 'end') continue;
    const endSlot = roles[at + 1] === 'end' ? at + 1 : null;
    if (isCadSketchVirtualId(id)) {
      if (!copy.axis) return 'It names the origin or an axis, which this copy does not carry.';
      // The other axis lies on itself the other way round, so a ray along it runs toward its other end and a side on it turns over.
      if (id !== CAD_SKETCH_ORIGIN_ID && id !== copy.axis) {
        reversed[at] = true;
        if (endSlot !== null) next[endSlot] = ids[endSlot] === id ? CAD_SKETCH_ORIGIN_ID : id;
      }
      continue;
    }
    if (roles[at] === 'source') return 'It generates geometry, which a copy does not.';
    if (roles[at] === 'point') {
      const mapped = copy.points.get(id);
      if (mapped !== undefined) { next[at] = mapped; kept = true; } else if (!invariant.has(id)) return 'It names geometry outside the copy.';
      continue;
    }
    const piece = copy.curves.get(id);
    if (piece) {
      next[at] = piece.entityId; reversed[at] = piece.orientation === 'reversed'; kept = true;
      // A joint or ray end follows its curve onto the copy.
      if (endSlot !== null) {
        const end = copy.points.get(ids[endSlot]);
        if (end === undefined) return 'It names geometry outside the copy.';
        next[endSlot] = end;
      }
      continue;
    }
    // A joint needs both its curves copied: the copy's end is not joined to a curve it leaves in place.
    if (!invariant.has(id) || roles[at] === 'joint') return 'It names geometry outside the copy.';
  }
  if (!kept) return 'It names no copied geometry.';
  const pointSlots = roles.flatMap((role, at) => isPoint(role) ? [at] : []);
  if (new Set(pointSlots.map(at => next[at])).size < new Set(pointSlots.map(at => ids[at])).size) return 'The copy joins points it names apart.';
  if (copies === 'unjoined' && ids.every(id => copy.points.has(id))) return 'The copy already joins these points.';
  if (copies === 'ends' && !(ids.length === 2 && (index.ended.get(pairKey(ids[0], ids[1])) ?? []).some(id => index.curves.get(id)?.straight && copy.curves.has(id))))
    return 'An offset keeps a direction only between the two ends of one copied line.';
  if (copies === 'centres' && !ids.every(id => (index.centred.get(id) ?? []).some(curve => copy.curves.has(curve))))
    return 'An offset keeps only centres of copied arcs and circles together; it joins its other points itself.';
  return { ids: next, reversed };
}

/**
 * Each relation that names copied geometry with what the copy does to it, in graph order. A relation internal to the copied set, or
 * reaching only geometry the copy keeps in place, is carried onto the copy, with a mirror's sense or side reversed. One that reaches
 * other geometry, or that the kind's rule leaves out, is not copied, with the reason. A copy is laid out automatically, so it keeps no
 * dimension placement. The original relations always stay.
 */
export function copyCadSketchRelations(graph: CadSketchGraph, copy: CadSketchRelationCopy): readonly CadSketchRemapOutcome[] {
  const index = graphIndex(graph, copy.traits);
  let copied = 0;
  return touched(graph, index, [...copy.curves.keys(), ...copy.points.keys()], []).map((relation): CadSketchRemapOutcome => {
    const resolved = resolveCopy(index, copy, relation);
    if (typeof resolved === 'string') return { kind: 'remove', relation, reason: resolved };
    const { annotation: _placement, ...plain } = moved(relation, resolved, copy.kind === 'mirror') as CadSketchGraphRelation & { readonly annotation?: unknown };
    return { kind: 'replace', relation, relations: [{ ...plain, id: copy.relationId(relation, copied++) } as CadSketchGraphRelation] };
  });
}
/** The relations a copy adds, in graph order. */
export const copiedCadSketchRelations = (outcomes: readonly CadSketchRemapOutcome[]): CadSketchGraphRelation[] =>
  outcomes.flatMap(item => item.kind === 'replace' ? item.relations : []);

/**
 * The relations an edit's outcomes leave: each kept one, each replacement in its place, and none for a removed or blocked one. The caller
 * has confirmed or refused each blocked relation before it applies the edit.
 */
export function applyCadSketchRemapOutcomes(relations: readonly CadSketchGraphRelation[], outcomes: readonly CadSketchRemapOutcome[]): CadSketchGraphRelation[] {
  if (!outcomes.length) return [...relations];
  const byRelation = new Map(outcomes.map(item => [item.relation, item]));
  return relations.flatMap(relation => {
    const item = byRelation.get(relation);
    return !item || item.kind === 'retain' ? [relation] : item.kind === 'replace' ? [...item.relations] : [];
  });
}
