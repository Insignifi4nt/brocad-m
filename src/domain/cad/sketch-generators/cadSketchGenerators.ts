import { Value } from '@sinclair/typebox/value';
import { CadError } from '../cadError';
import { evaluateCadScalar } from '../cadExpression';
import {
  acceptCadSketchGraph, acceptCadSketchGraphWithMembers, detachCadSketchGraph, isAcceptedCadSketchGraph, trustCadSketchGeneratedItems,
  type CadSketchGenerator, type CadSketchGeneratorGeometry, type CadSketchGraph, type CadSketchGraphEntity, type CadSketchGraphIssue,
  type CadSketchGraphPoint, type CadSketchGraphRelation
} from '../cadSketchGraph';
import type { ResolvedCadProfile } from '../cadSketchGeometry';
import { cadSketchEntityPointIds } from '../cadSketchGraphReferences';
import type { CadSketchGraphSelection } from '../cadSketchGraphSelection';
import { applyCadSketchRemapOutcomes, remapCadSketchRelations } from '../sketch-relations/cadSketchRelationRemap';
import { cadSketchRelationDefinition } from '../sketch-relations/cadSketchRelationRegistry';
import type { CadSketchRelationOwnership } from '../sketch-relations/cadSketchRelationTypes';
import { CAD_SKETCH_H_AXIS_ID, CAD_SKETCH_ORIGIN_ID, CAD_SKETCH_V_AXIS_ID, isCadSketchVirtualId } from '../sketch-relations/cadSketchVirtualElements';
import {
  CAD_SKETCH_GENERATOR_KINDS, type CadSketchGeneratedGeometry, type CadSketchGeneratorContext, type CadSketchGeneratorEvaluation,
  type CadSketchGeneratorKind
} from './cadSketchGeneratorKinds';

// A sketch generator is a relation that makes and keeps geometry: a profile's outline, a plugin's shape or a regular polygon. Only its
// record is stored. Parsing a document generates its members from the record and the document's parameters, as real points, edges and
// relations with ids `<idPrefix>_<key>`, and adds them to the accepted graph, so every reader of the graph sees them as geometry. Saving
// writes the record alone. Members are fixed in the solver, and an edit of one is refused, naming its generator, until the generator is
// detached. A change of the generator's inputs or parameters regenerates its members in the same edit, and a member that leaves with
// the user relations on it goes through the relation remap, which keeps, removes or refuses each one. A relation the remap would remove
// with a leaving member stays until the edit confirms its removal, as a trim does, by listing its id in removedRelationIds.

type Kind = CadSketchGeneratorKind<CadSketchGeneratorGeometry>;
export function cadSketchGeneratorKind(geometry: CadSketchGeneratorGeometry): Kind {
  return CAD_SKETCH_GENERATOR_KINDS[geometry.kind] as unknown as Kind;
}
/** How people and agents are told of a generator: its kind and its id, as `Rectangle "g1"`. */
export function cadSketchGeneratorName(generator: CadSketchGenerator): string {
  return `${cadSketchGeneratorKind(generator.geometry).label(generator.geometry)} "${generator.id}"`;
}
/** The namespace of a sketch id: the part before its first underscore, where a generator's members live. */
export function cadSketchIdNamespace(id: string): string | undefined {
  const at = id.indexOf('_');
  return at > 0 ? id.slice(0, at) : undefined;
}
export const cadSketchGeneratedId = (idPrefix: string, key: string) => `${idPrefix}_${key}`;

const invalid = (message: string) => new CadError('invalid-sketch-generator', message);
const stale = (message: string) => new CadError('stale-sketch-generator', message);
const owned = (message: string) => new CadError('owned-sketch-generator', message);

/** A user relation a regeneration removes: the sketch it is in, when settling knows it, its name, and the generator it loses geometry of. */
export interface CadSketchGeneratorRemovedRelation {
  readonly sketchId?: string;
  readonly relationId: string;
  /** As a refusal names it, such as `Coincident "tie"`. */
  readonly name: string;
  readonly generator: string;
  readonly reason: string;
}
/**
 * The relations an edit batch confirms it removes, its removedRelationIds, when members they use leave as a generator regenerates, and
 * every relation settling has removed so far, confirmed or not. Settling with it goes on past a removal no one confirmed, so the refusal
 * that follows lists every relation the batch removes, in every sketch it regenerates. Relation IDs are unique within a sketch, so one
 * confirmed ID confirms that relation in each sketch the batch removes it from, as the refusal listed them.
 */
export interface CadSketchGeneratorRemovals { readonly confirmed: ReadonlySet<string>; readonly removed: CadSketchGeneratorRemovedRelation[] }
type Confirmable = CadSketchGeneratorRemovedRelation & { readonly confirmed: boolean };
export const cadSketchGeneratorRemovals = (confirmed: Iterable<string> = []): CadSketchGeneratorRemovals => ({ confirmed: new Set(confirmed), removed: [] });
/**
 * A regeneration that removes user relations no one confirmed it removes. `relations` are all those the batch removes, confirmed or not,
 * `relationIds` their IDs once each, which confirm them as removedRelationIds, and `pendingRelationIds` those of them the batch did not
 * confirm, so a caller that can list only some at a time lists the rest as each resend confirms more.
 */
export class CadSketchGeneratorRemovalError extends CadError {
  readonly relationIds: readonly string[];
  readonly pendingRelationIds: readonly string[];
  readonly relations: readonly CadSketchGeneratorRemovedRelation[];
  constructor(relations: readonly Confirmable[]) {
    super('unconfirmed-sketch-generator-removals', removalMessage(relations));
    this.relations = Object.freeze(relations.map(({ confirmed: _confirmed, ...relation }) => Object.freeze(relation)));
    this.relationIds = Object.freeze([...new Set(relations.map(relation => relation.relationId))]);
    this.pendingRelationIds = Object.freeze([...new Set(relations.filter(relation => !relation.confirmed).map(relation => relation.relationId))]);
  }
}
/** A refusal's message names up to this many relations; past that, it counts them and names the first few, so it stays short. */
const NAMED_REMOVALS = 8, SAMPLED_REMOVALS = 4;
const some = (items: readonly string[]) => items.length <= NAMED_REMOVALS ? listed(items) : `${items.slice(0, SAMPLED_REMOVALS).join(', ')} and ${items.length - SAMPLED_REMOVALS} more`;
/**
 * Names the relations removed without confirmation, and lists every one the batch removes, by sketch when it removes them from several;
 * past eight, it counts them and names the first few, and says to confirm them all, as each refusal lists those not yet confirmed.
 */
function removalMessage(relations: readonly Confirmable[]): string {
  const sketches = new Set(relations.map(relation => relation.sketchId)), ids = [...new Set(relations.map(relation => relation.relationId))];
  const where = (relation: Confirmable) => sketches.size > 1 && relation.sketchId !== undefined ? ` in sketch "${relation.sketchId}"` : '';
  const unconfirmed = relations.filter(relation => !relation.confirmed), named = unconfirmed.length ? unconfirmed : relations;
  const generators = [...new Set(named.map(relation => `${relation.generator}${where(relation)}`))];
  const users = named.length > NAMED_REMOVALS ? `${named.length} relations` : listed(named.map(relation => `${relation.name}${where(relation)}`));
  const removed = relations.map(relation => `${relation.relationId}${where(relation)}`);
  return `${some(generators)} no longer generate${generators.length === 1 ? 's' : ''} geometry that ${users} ${named.length === 1 ? 'uses' : 'use'}.`
    + `${named.length === 1 ? ` ${named[0].reason}` : ''} This removes ${relations.length === 1 ? 'one relation' : `${relations.length} relations`}: ${removed.length > NAMED_REMOVALS ? some(removed) : removed.join(', ')}.`
    + (ids.length > NAMED_REMOVALS ? ` Send all ${ids.length} IDs as removedRelationIds to confirm; a refusal lists those not yet sent, so resend with them until it applies. Or keep the generator's inputs.`
      : ` Send exactly ${ids.length === relations.length ? 'these IDs' : `the IDs ${ids.join(', ')}`} as removedRelationIds to confirm, or keep the generator's inputs.`);
}
/**
 * Refuses a batch whose regeneration removed relations it did not confirm, listing every relation it removes. With `exact`, also
 * refuses removedRelationIds that settling did not remove, which a request made for other inputs or geometry carries.
 */
export function assertCadSketchGeneratorRemovals(removals: CadSketchGeneratorRemovals, exact = true): void {
  if (removals.removed.some(relation => !removals.confirmed.has(relation.relationId)))
    throw new CadSketchGeneratorRemovalError(removals.removed.map(relation => ({ ...relation, confirmed: removals.confirmed.has(relation.relationId) })));
  if (!exact) return;
  const removed = new Set(removals.removed.map(relation => relation.relationId)), extra = [...removals.confirmed].filter(id => !removed.has(id));
  if (extra.length) throw new CadError('stale-sketch-generator-removals', `This edit no longer removes ${extra.map(id => `"${id}"`).join(', ')}. Send exactly the IDs it removes as removedRelationIds.`);
}
const listed = (items: readonly string[]) => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

interface GeneratorIndex {
  readonly generators: readonly CadSketchGenerator[];
  readonly byPrefix: ReadonlyMap<string, CadSketchGenerator>;
}
const EMPTY_INDEX: GeneratorIndex = Object.freeze({ generators: Object.freeze([]), byPrefix: new Map() });
const generatorIndexes = new WeakMap<readonly CadSketchGraphRelation[], GeneratorIndex>();
/** The graph's generators in relation order, by prefix too; a frozen relation list, as an accepted graph and its acceptance have, keeps its index. */
function generatorIndex(graph: CadSketchGraph): GeneratorIndex {
  const kept = generatorIndexes.get(graph.relations);
  if (kept) return kept;
  const generators = graph.relations.filter((relation): relation is CadSketchGenerator => relation.kind === 'generator');
  const index = generators.length ? { generators, byPrefix: new Map(generators.map(generator => [generator.idPrefix, generator])) } : EMPTY_INDEX;
  if (Object.isFrozen(graph.relations)) generatorIndexes.set(graph.relations, index);
  return index;
}
export function cadSketchGenerators(graph: CadSketchGraph): readonly CadSketchGenerator[] {
  return generatorIndex(graph).generators;
}
/** The generator whose member `id` is: the one whose prefix is the id's namespace. */
export function cadSketchGeneratorOwner(graph: CadSketchGraph, id: string): CadSketchGenerator | undefined {
  const index = generatorIndex(graph);
  if (!index.generators.length) return undefined;
  const namespace = cadSketchIdNamespace(id);
  return namespace === undefined ? undefined : index.byPrefix.get(namespace);
}

// Generated members, most recently used last, by prefix, construction and evaluated inputs: a parse or regeneration with unchanged
// inputs reuses the frozen members instead of generating them again, so a document with many generators loads once.
const MEMO_LIMIT = 1024;
const memo = new Map<string, CadSketchGeneratedGeometry>();
function generated(generator: CadSketchGenerator, evaluation: CadSketchGeneratorEvaluation): CadSketchGeneratedGeometry {
  const key = `${generator.idPrefix}\u0000${generator.construction}\u0000${generator.geometry.kind}\u0000${evaluation.key}`;
  const kept = memo.get(key);
  if (kept) { memo.delete(key); memo.set(key, kept); return kept; }
  const prefix = generator.idPrefix;
  const output = evaluation.build(member => cadSketchGeneratedId(prefix, member), generator.construction);
  const members: CadSketchGeneratedGeometry = Object.freeze({
    points: trustCadSketchGeneratedItems(output.points), entities: trustCadSketchGeneratedItems(output.entities),
    relations: trustCadSketchGeneratedItems(output.relations)
  });
  memo.set(key, members);
  if (memo.size > MEMO_LIMIT) memo.delete(memo.keys().next().value!);
  return members;
}

type Batch = Pick<CadSketchGraph, 'points' | 'entities' | 'relations'>;
/**
 * What generation may read: the sketch's stored geometry and relations and those of members generated before, by id. Each batch is
 * indexed only when a generator first reads it, as most never do, and a context reads only the batches added before it was made.
 */
class Readable {
  private readonly batches: Batch[] = [];
  private indexed = 0;
  private related = 0;
  private readonly points = new Map<string, { readonly point: CadSketchGraphPoint; readonly batch: number }>();
  private readonly entities = new Map<string, { readonly entity: CadSketchGraphEntity; readonly batch: number }>();
  // The relations that name each element, with their batch, for the relations among a set of elements.
  private readonly naming = new Map<string, { readonly relation: CadSketchGraphRelation; readonly operands: readonly string[]; readonly batch: number }[]>();
  constructor(private readonly parameters: Readonly<Record<string, number>>) {}
  add(batch: Batch) { this.batches.push(batch); }
  private index(limit: number) {
    for (; this.indexed < limit; this.indexed++) {
      const batch = this.indexed, { points, entities } = this.batches[batch];
      for (const point of points) this.points.set(point.id, { point, batch });
      for (const entity of entities) this.entities.set(entity.id, { entity, batch });
    }
  }
  private indexRelations(limit: number) {
    for (; this.related < limit; this.related++) for (const relation of this.batches[this.related].relations) {
      const definition = cadSketchRelationDefinition(relation);
      if (relation.kind === 'generator' || definition.owns) continue;
      const operands = definition.operands(relation), item = { relation, operands, batch: this.related };
      for (const id of new Set(operands)) { const list = this.naming.get(id); if (list) list.push(item); else this.naming.set(id, [item]); }
    }
  }
  context(): CadSketchGeneratorContext {
    const limit = this.batches.length, parameters = this.parameters;
    const point = (id: string) => {
      if (id === CAD_SKETCH_ORIGIN_ID) return { x: 0, y: 0 };
      this.index(limit);
      const kept = this.points.get(id);
      return kept && kept.batch < limit ? { x: evaluateCadScalar(kept.point.position[0], parameters), y: evaluateCadScalar(kept.point.position[1], parameters) } : undefined;
    };
    const curve = (id: string) => {
      this.index(limit);
      const kept = this.entities.get(id);
      return kept && kept.batch < limit ? kept.entity : undefined;
    };
    return { parameters, point, curve, line: id => {
      if (id === CAD_SKETCH_H_AXIS_ID) return { start: { x: 0, y: 0 }, end: { x: 1, y: 0 } };
      if (id === CAD_SKETCH_V_AXIS_ID) return { start: { x: 0, y: 0 }, end: { x: 0, y: 1 } };
      const found = curve(id);
      if (found?.kind !== 'line') return undefined;
      const start = point(found.startPointId), end = point(found.endPointId);
      return start && end ? { start, end } : undefined;
    }, relationsAmong: ids => {
      this.indexRelations(limit);
      const found = new Set<CadSketchGraphRelation>();
      for (const id of ids) for (const { relation, operands, batch } of this.naming.get(id) ?? [])
        if (batch < limit && operands.every(operand => ids.has(operand) || isCadSketchVirtualId(operand))) found.add(relation);
      return [...found].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    } };
  }
}

/** A graph split into what is stored and what its generators carried, by generator prefix. */
interface Split {
  readonly points: CadSketchGraphPoint[];
  readonly entities: CadSketchGraphEntity[];
  readonly relations: CadSketchGraphRelation[];
  readonly carried: ReadonlyMap<string, { points: CadSketchGraphPoint[]; entities: CadSketchGraphEntity[]; relations: CadSketchGraphRelation[] }>;
}
function split(graph: CadSketchGraph, index: GeneratorIndex): Split {
  const points: CadSketchGraphPoint[] = [], entities: CadSketchGraphEntity[] = [], relations: CadSketchGraphRelation[] = [];
  const carried = new Map<string, { points: CadSketchGraphPoint[]; entities: CadSketchGraphEntity[]; relations: CadSketchGraphRelation[] }>();
  const bucket = (id: string) => {
    const namespace = cadSketchIdNamespace(id);
    if (namespace === undefined || !index.byPrefix.has(namespace)) return undefined;
    let found = carried.get(namespace);
    if (!found) carried.set(namespace, found = { points: [], entities: [], relations: [] });
    return found;
  };
  for (const point of graph.points) (bucket(point.id)?.points ?? points).push(point);
  for (const entity of graph.entities) (bucket(entity.id)?.entities ?? entities).push(entity);
  for (const relation of graph.relations) (bucket(relation.id)?.relations ?? relations).push(relation);
  return { points, entities, relations, carried };
}

interface Generation { readonly generator: CadSketchGenerator; readonly members: CadSketchGeneratedGeometry; readonly key: string; readonly evaluation: CadSketchGeneratorEvaluation }
/**
 * Every generator's members in relation order, each reading the stored lines and those generated before it, up to the first generator
 * whose inputs do not evaluate or whose shape is refused: its refusal, naming it, ends them.
 */
function generateEach(index: GeneratorIndex, stored: Split, parameters: Parameters): { readonly generations: readonly Generation[]; readonly refusal?: CadError } {
  const lines = new Readable(parameters), generations: Generation[] = [];
  lines.add(stored);
  for (const generator of index.generators) {
    const name = cadSketchGeneratorName(generator);
    let evaluation: CadSketchGeneratorEvaluation, members: CadSketchGeneratedGeometry;
    try {
      evaluation = cadSketchGeneratorKind(generator.geometry).evaluate(generator.geometry, lines.context(), name);
      members = generated(generator, evaluation);
    } catch (error) {
      return { generations, refusal: error instanceof CadError && error.message.includes(`"${generator.id}"`) ? error
        : invalid(`${name}: ${error instanceof Error ? error.message : 'its geometry cannot be generated.'}`) };
    }
    lines.add(members);
    generations.push({ generator, members, key: `${generator.idPrefix}\u0000${generator.construction}\u0000${evaluation.key}`, evaluation });
  }
  return { generations };
}
/** Every generator's members, as `generateEach` makes them; a generator that cannot generate is refused naming it. */
function generateAll(index: GeneratorIndex, stored: Split, parameters: Parameters): readonly Generation[] {
  const { generations, refusal } = generateEach(index, stored, parameters);
  if (refusal) throw refusal;
  return generations;
}

type Parameters = Readonly<Record<string, number>>;
/** Parameters as kept beside a graph: frozen, so the same object holds the same values when it is passed again. */
const keptParameters = (parameters: Parameters): Parameters => Object.isFrozen(parameters) ? parameters : Object.freeze({ ...parameters });
const sameParameters = (kept: Parameters, parameters: Parameters) => kept === parameters || Value.Equal(kept, parameters);
// Accepted graphs whose members were generated with these keys, one for each generator in order, and the parameters they were made from.
const settledGraphs = new WeakMap<CadSketchGraph, { readonly keys: string; readonly parameters: Parameters }>();
const keysOf = (generations: readonly Generation[]) => generations.map(item => item.key).join('\u0001');
function markSettled(graph: CadSketchGraph, generations: readonly Generation[], parameters: Parameters) {
  const kept = keptParameters(parameters);
  settledGraphs.set(graph, { keys: keysOf(generations), parameters: kept });
  evaluatedGraphs.set(graph, { parameters: kept, generations });
}
// The evaluations that generated a settled graph's members, until its outlines take their shapes instead of evaluating each generator again.
const evaluatedGraphs = new WeakMap<CadSketchGraph, { readonly parameters: Parameters; readonly generations: readonly Generation[] }>();
/**
 * Whether the graph's members are what its generators make from `parameters`, as generation left them: at once for the parameters they
 * were made from, since the graph cannot change, and otherwise when each generator still evaluates to the inputs it had.
 */
function isSettled(graph: CadSketchGraph, index: GeneratorIndex, parameters: Parameters): boolean {
  const settled = settledGraphs.get(graph);
  if (!settled) return false;
  if (sameParameters(settled.parameters, parameters)) return true;
  const keys = currentKeys(graph, index, parameters);
  if (keys !== settled.keys) return false;
  settledGraphs.set(graph, { keys, parameters: keptParameters(parameters) });
  return true;
}
/** The keys the graph's generators evaluate to now, read from its own members, or null when one does not evaluate. */
function currentKeys(graph: CadSketchGraph, index: GeneratorIndex, parameters: Readonly<Record<string, number>>): string | null {
  const lines = new Readable(parameters);
  lines.add(graph);
  try {
    return index.generators.map(generator => `${generator.idPrefix}\u0000${generator.construction}\u0000${
      cadSketchGeneratorKind(generator.geometry).evaluate(generator.geometry, lines.context(), cadSketchGeneratorName(generator)).key}`).join('\u0001');
  } catch { return null; }
}

const same = (a: object, b: object) => a === b || Value.Equal(a, b);
/** Whether the carried members are the generated objects themselves, in their order. */
function identical(carried: { readonly points: readonly object[]; readonly entities: readonly object[]; readonly relations: readonly object[] }, members: CadSketchGeneratedGeometry): boolean {
  return (['points', 'entities', 'relations'] as const).every(list => carried[list].length === members[list].length && carried[list].every((item, at) => item === members[list][at]));
}
/** Whether the carried members are exactly the generated ones, by id. */
function carriesExactly(carried: Split['carried'] extends ReadonlyMap<string, infer V> ? V : never, members: CadSketchGeneratedGeometry): boolean {
  const lists = [[carried.points, members.points], [carried.entities, members.entities], [carried.relations, members.relations]] as const;
  for (const [had, made] of lists) {
    if (had.length !== made.length) return false;
    const byId = new Map<string, object>(made.map(item => [item.id, item]));
    for (const item of had) { const expected = byId.get(item.id); if (!expected || !same(item, expected)) return false; }
  }
  return true;
}
function accepted(stored: Split, generations: readonly Generation[], graph: CadSketchGraph, parameters: Parameters, relations = stored.relations): CadSketchGraph {
  // The members are the lists generation made, which acceptance trusts without checking each again.
  const result = acceptCadSketchGraphWithMembers({ ...graph, points: stored.points, entities: stored.entities, relations },
    generations.map(({ generator, members }) => ({ idPrefix: generator.idPrefix, ...members })));
  markSettled(result, generations, parameters);
  return result;
}

/** Refuses stored geometry that a generator owns: an edge of the sketch's own ending at a generated point. */
function assertStoredOutsideMembers(stored: Split, index: GeneratorIndex): void {
  for (const entity of stored.entities) for (const pointId of cadSketchEntityPointIds(entity)) {
    const namespace = cadSketchIdNamespace(pointId), generator = namespace === undefined ? undefined : index.byPrefix.get(namespace);
    if (generator) throw invalid(`Sketch edge "${entity.id}" cannot end at "${pointId}", which ${cadSketchGeneratorName(generator)} generates. Connect to it with a coincident relation instead.`);
  }
  for (const relation of stored.relations) {
    if (!DRIVING_DIMENSION_KINDS.has(relation.kind)) continue;
    const definition = cadSketchRelationDefinition(relation), reason = generatedSizeReason(index, definition.operands(relation));
    if (reason) throw owned(`${definition.nameOf?.(relation) ?? definition.name} "${relation.id}" cannot drive generated geometry alone. ${reason}`);
  }
}

/** The relations that drive a size or a place from their operands' geometry: the driving dimensions. */
const DRIVING_DIMENSION_KINDS: ReadonlySet<CadSketchGraphRelation['kind']> = new Set(['distance', 'axis-distance', 'point-line-distance', 'line-angle', 'radial-size', 'fixed-axis']);
/** Why a driving dimension on `ids` drives nothing: each is a member of a generator in `index`, or the origin or an axis. */
function generatedSizeReason(index: GeneratorIndex, ids: readonly string[]): string | null {
  const owners: CadSketchGenerator[] = [];
  for (const id of ids) {
    if (isCadSketchVirtualId(id)) continue;
    const namespace = cadSketchIdNamespace(id), owner = namespace === undefined ? undefined : index.byPrefix.get(namespace);
    if (!owner) return null;
    if (!owners.includes(owner)) owners.push(owner);
  }
  if (!owners.length) return null;
  const one = owners.length === 1, their = one ? 'its' : 'their';
  return `${listed(owners.map(cadSketchGeneratorName))} ${one ? 'generates' : 'generate'} all of this geometry, so ${their} inputs set this size. Change ${their} inputs, or measure it with a reference dimension.`;
}
/**
 * Why a driving dimension on the geometry `ids` would drive nothing, naming the generators that set it: every one is a generator's member,
 * or the origin or an axis, all of which the solve holds. Null when any is free geometry, which the dimension moves, or none is generated.
 */
export function cadSketchGeneratedSizeReason(graph: CadSketchGraph, ids: readonly string[]): string | null {
  const index = generatorIndex(graph);
  return index.generators.length ? generatedSizeReason(index, ids) : null;
}

/**
 * The sketch graph `value` with its generators' members, as the document parse accepts it. A graph that stores generator records alone
 * gets their members; one that carries members must carry exactly what its generators make now, or it is refused naming the generator.
 * An accepted graph whose members were generated from the same inputs is returned as it is.
 */
export function expandCadSketchGenerators(value: unknown, parameters: Readonly<Record<string, number>>): CadSketchGraph {
  const acceptedValue = typeof value === 'object' && value !== null && isAcceptedCadSketchGraph(value as CadSketchGraph);
  const graph = acceptedValue ? value as CadSketchGraph : detachCadSketchGraph(value);
  const index = generatorIndex(graph);
  if (!index.generators.length) return acceptCadSketchGraph(graph);
  if (isSettled(graph, index, parameters)) return graph;
  for (const generator of index.generators) validateCadSketchGeneratorRecord(graph, generator);
  const stored = split(graph, index);
  assertStoredOutsideMembers(stored, index);
  const generations = generateAll(index, stored, parameters);
  let carriesAll = true;
  for (const { generator, members } of generations) {
    const carried = stored.carried.get(generator.idPrefix);
    if (!carried) { carriesAll = false; continue; }
    if (!carriesExactly(carried, members))
      throw stale(`${cadSketchGeneratorName(generator)} carries generated geometry that does not match its inputs. Store the generator alone, or regenerate it.`);
  }
  if (carriesAll && acceptedValue && graph.relations.length === stored.relations.length + generations.reduce((sum, item) => sum + item.members.relations.length, 0)) {
    // The accepted graph holds exactly what generation makes, in its own order.
    markSettled(graph, generations, parameters);
    return graph;
  }
  return accepted(stored, generations, graph, parameters);
}

/**
 * The accepted graph with each generator's members generated again from its current inputs and `parameters`, as an edit leaves it. A
 * member that keeps its key keeps its id; one that leaves takes the user relations on it through the relation remap: those it would
 * remove are removed, and any it would block refuse the edit, naming the generator and the relation. The graph itself when nothing
 * changes.
 */
export function regenerateCadSketchGenerators(source: CadSketchGraph, parameters: Readonly<Record<string, number>>): CadSketchGraph {
  return settleCadSketchGenerators(source, source, parameters);
}

type Members = Split['carried'] extends ReadonlyMap<string, infer V> ? V : never;
/** Whether two sets of members are the same items, by id. */
function sameMembers(a: Members, b: Members): boolean {
  return carriesExactly(a, b);
}

/**
 * The edited sketch graph `candidate` with each generator's members as its inputs and `parameters` make them now, accepted. `previous`
 * is the sketch's graph before the edit. The candidate's members of a generator must be untouched, which regenerates them from the inputs
 * they had before, or exactly what the generator makes now, as an edit that regenerated them leaves them; a member edited, removed or
 * added directly refuses the edit, naming the generator. Members that leave in a regeneration take the user relations on them through
 * the relation remap, as `regenerateCadSketchGenerators` says. Without `removals`, a relation it removes refuses the edit with a
 * CadSketchGeneratorRemovalError that lists them; with it, each is recorded there, under `sketchId`, and removed, and the caller's
 * `assertCadSketchGeneratorRemovals` refuses those not confirmed once every sketch has settled. A generator stored without members gets
 * them, taking the place of those it had before. The candidate itself when nothing needs generating.
 */
export function settleCadSketchGenerators(candidate: CadSketchGraph, previous: CadSketchGraph | undefined, parameters: Readonly<Record<string, number>>,
  removals?: CadSketchGeneratorRemovals, sketchId?: string): CadSketchGraph {
  candidate = withIdentifiedEntries(candidate, previous);
  const graph = isAcceptedCadSketchGraph(candidate) ? candidate : detachCadSketchGraph(candidate), index = generatorIndex(graph);
  if (!index.generators.length) return graph === candidate ? candidate : acceptCadSketchGraph(graph);
  if (isSettled(graph, index, parameters)) return graph;
  for (const generator of index.generators) validateCadSketchGeneratorRecord(graph, generator);
  const stored = split(graph, index);
  assertStoredOutsideMembers(stored, index);
  const generations = generateAll(index, stored, parameters);
  const before = previous && previous !== candidate ? split(previous, index).carried : stored.carried;
  // What each generator had before this regeneration: its carried members, or those of the graph before the edit when it carries none.
  const had = new Map<string, Members>();
  for (const { generator, members } of generations) {
    const carried = stored.carried.get(generator.idPrefix), earlier = before.get(generator.idPrefix);
    if (carried && !carriesExactly(carried, members) && !(earlier && sameMembers(carried, earlier))) {
      const name = cadSketchGeneratorName(generator);
      const known = new Set([...members.points, ...members.entities, ...members.relations, ...earlier ? [...earlier.points, ...earlier.entities, ...earlier.relations] : []].map(item => item.id));
      const stranger = [...carried.points, ...carried.entities, ...carried.relations].find(item => !known.has(item.id));
      throw owned(stranger ? `Sketch id "${stranger.id}" is in the id namespace "${generator.idPrefix}" of ${name}. Choose an id without the "${generator.idPrefix}_" prefix.`
        : `${name} generates this geometry. Edit the generator's inputs, or detach it, before editing generated geometry.`);
    }
    const kept = carried ?? earlier;
    if (kept) had.set(generator.idPrefix, kept);
  }
  if (generations.every(({ generator, members }) => { const kept = had.get(generator.idPrefix); return kept && kept === stored.carried.get(generator.idPrefix) && carriesExactly(kept, members); })) {
    // Equal copies, as a solver's reply holds, give way to the generated objects themselves, which a later parse need not copy.
    if (!generations.every(({ generator, members }) => identical(stored.carried.get(generator.idPrefix)!, members))) return accepted(stored, generations, graph, parameters);
    markSettled(graph, generations, parameters);
    return acceptCadSketchGraph(graph);
  }
  // Members that leave, whose id now names another kind of edge, or whose edge the kind says now joins other parts of the shape, end the
  // user relations on them.
  const curves = new Map<string, readonly never[]>(), points = new Map<string, null>(), owners = new Map<string, CadSketchGenerator>();
  const records = previous && previous !== candidate ? generatorIndex(previous).byPrefix : undefined;
  for (const { generator, members } of generations) {
    const kept = had.get(generator.idPrefix);
    if (!kept) continue;
    const kinds = new Map(members.entities.map(entity => [entity.id, entity.kind])), keptPoints = new Set(members.points.map(point => point.id));
    const record = records?.get(generator.idPrefix), from = generator.idPrefix.length + 1;
    const moved = record && record !== generator && record.geometry.kind === generator.geometry.kind
      ? cadSketchGeneratorKind(generator.geometry).reshaped?.(record.geometry, generator.geometry) : undefined;
    for (const entity of kept.entities) if (kinds.get(entity.id) !== entity.kind || moved?.(entity.id.slice(from))) { curves.set(entity.id, []); owners.set(entity.id, generator); }
    for (const point of kept.points) if (!keptPoints.has(point.id) || moved?.(point.id.slice(from))) { points.set(point.id, null); owners.set(point.id, generator); }
  }
  let relations = stored.relations;
  if (curves.size || points.size) {
    // The graph as it was, with the members the remap reads its relations' operands from.
    const was: CadSketchGraph = { ...graph,
      points: [...stored.points, ...[...had.values()].flatMap(item => item.points)],
      entities: [...stored.entities, ...[...had.values()].flatMap(item => item.entities)],
      relations: [...stored.relations, ...[...had.values()].flatMap(item => item.relations)] };
    const outcomes = remapCadSketchRelations(was, { curves, points })
      .filter(outcome => outcome.relation.kind !== 'generator' && !cadSketchGeneratorOwner(graph, outcome.relation.id));
    const blocked = outcomes.flatMap(outcome => outcome.kind === 'blocked' ? [outcome] : []);
    // The generator whose leaving member a relation uses, and how the relation is named.
    const ownerOf = (relation: CadSketchGraphRelation) => {
      const definition = cadSketchRelationDefinition(relation);
      const leaving = [...definition.operands(relation), ...definition.owns?.(relation, was).entityIds ?? []].find(id => owners.has(id))
        ?? cadSketchRelationPointsOf(was, relation).find(id => owners.has(id));
      return (leaving === undefined ? undefined : owners.get(leaving)) ?? generations[0].generator;
    };
    const named = (relation: CadSketchGraphRelation) => { const definition = cadSketchRelationDefinition(relation); return `${definition.nameOf?.(relation) ?? definition.name} "${relation.id}"`; };
    const refused = blocked.find(outcome => !outcome.confirmable);
    if (refused) throw owned(`${cadSketchGeneratorName(ownerOf(refused.relation))} no longer generates geometry that ${named(refused.relation)} uses. ${refused.reason} Remove the relation first, or keep the generator's inputs.`);
    const removed = blocked.map(outcome => ({ ...sketchId === undefined ? {} : { sketchId }, relationId: outcome.relation.id, name: named(outcome.relation),
      generator: cadSketchGeneratorName(ownerOf(outcome.relation)), reason: outcome.reason }));
    if (removed.length && !removals) throw new CadSketchGeneratorRemovalError(removed.map(relation => ({ ...relation, confirmed: false })));
    for (const relation of removed) if (!removals!.removed.some(other => other.sketchId === relation.sketchId && other.relationId === relation.relationId)) removals!.removed.push(relation);
    relations = applyCadSketchRemapOutcomes(stored.relations, outcomes);
  }
  const result = accepted(stored, generations, graph, parameters, relations);
  regeneratedGraphs.add(result);
  return result;
}
/**
 * `graph` with each generator record whose kind identifies its entries, a listed polygon or path, given the ids of the entries it kept
 * from its record in `previous`, so its members keep their keys wherever an edit inserts or removes others.
 */
function withIdentifiedEntries(graph: CadSketchGraph, previous: CadSketchGraph | undefined): CadSketchGraph {
  if (!previous || previous === graph) return graph;
  const records = generatorIndex(previous).byPrefix;
  if (!records.size) return graph;
  let changed = false;
  const relations = graph.relations.map(relation => {
    if (relation.kind !== 'generator') return relation;
    const record = records.get(relation.idPrefix), identify = cadSketchGeneratorKind(relation.geometry).identify;
    if (!identify || !record || record === relation || record.geometry.kind !== relation.geometry.kind) return relation;
    const geometry = identify(record.geometry, relation.geometry);
    if (geometry === relation.geometry || JSON.stringify(geometry) === JSON.stringify(relation.geometry)) return relation;
    changed = true;
    return { ...relation, geometry };
  });
  return changed ? { ...graph, relations } : graph;
}
// Settled graphs whose generators made other members than the graph before them carried.
const regeneratedGraphs = new WeakSet<CadSketchGraph>();
/** Whether settling made `graph` by generating other members than its source carried, which a solve must then fit the sketch to. */
export function isRegeneratedCadSketchGraph(graph: CadSketchGraph): boolean {
  return regeneratedGraphs.has(graph);
}
/** The points a relation names through its operands, and through the edges it names. */
function cadSketchRelationPointsOf(graph: CadSketchGraph, relation: CadSketchGraphRelation): readonly string[] {
  const entities = new Map(graph.entities.map(entity => [entity.id, entity]));
  return cadSketchRelationDefinition(relation).operands(relation).flatMap(id => { const entity = entities.get(id); return entity ? cadSketchEntityPointIds(entity) : [id]; });
}

const storedGraphs = new WeakMap<CadSketchGraph, CadSketchGraph>();
/**
 * The graph as it is stored: its generators' records without their members, which the parse generates again. Not accepted, since user
 * relations may name members it leaves out; save, export, history and agent reads use it.
 */
export function storedCadSketchGraph(graph: CadSketchGraph): CadSketchGraph {
  const index = generatorIndex(graph);
  if (!index.generators.length) return graph;
  const kept = storedGraphs.get(graph);
  if (kept) return kept;
  const stored = split(graph, index);
  const result: CadSketchGraph = Object.freeze({ ...graph, points: Object.freeze(stored.points), entities: Object.freeze(stored.entities), relations: Object.freeze(stored.relations) });
  if (isAcceptedCadSketchGraph(graph)) storedGraphs.set(graph, result);
  return result;
}

/**
 * The stored form of the sketch graph `value` when each generator carries exactly the members generation keeps for its inputs, the same
 * objects in the same order, as a settled edit leaves them: the parse then regenerates those objects instead of copying and comparing
 * every member. `value` itself otherwise, which the parse checks in full. Only reads `value`, which the document schema check passed.
 */
export function withoutGeneratedCadSketchMembers(value: unknown, parameters: Readonly<Record<string, number>>): unknown {
  if (typeof value !== 'object' || value === null || isAcceptedCadSketchGraph(value as CadSketchGraph)) return value;
  const graph = value as CadSketchGraph;
  if (!Array.isArray(graph.relations) || !graph.relations.some(relation => relation?.kind === 'generator')) return value;
  try {
    const index = generatorIndex(graph), stored = split(graph, index);
    // Generators stored alone carry nothing to compare or strip.
    if (!stored.carried.size) return value;
    for (const { generator, members } of generateAll(index, stored, parameters)) {
      const carried = stored.carried.get(generator.idPrefix);
      if (carried && !identical(carried, members)) return value;
    }
    return { ...graph, points: stored.points, entities: stored.entities, relations: stored.relations };
  } catch { return value; }
}

const NO_MEMBERS: CadSketchRelationOwnership & { readonly relationIds: readonly string[] } = Object.freeze({ pointIds: Object.freeze([]), entityIds: Object.freeze([]), relationIds: Object.freeze([]) });
/** What one generator made and keeps in the graph: its members' ids. */
export function cadSketchGeneratorMembers(graph: CadSketchGraph, generator: CadSketchGenerator): CadSketchRelationOwnership & { readonly relationIds: readonly string[] } {
  const members = cadSketchGeneratedComponents(graph).byPrefix.get(generator.idPrefix);
  return members ?? NO_MEMBERS;
}

/** Everything the graph's generators made, by kind of item, and by generator prefix. */
export interface CadSketchGeneratedComponents {
  readonly pointIds: ReadonlySet<string>;
  readonly entityIds: ReadonlySet<string>;
  readonly circleIds: ReadonlySet<string>;
  readonly relationIds: ReadonlySet<string>;
  readonly byPrefix: ReadonlyMap<string, CadSketchRelationOwnership & { readonly relationIds: readonly string[] }>;
}
const NO_COMPONENTS: CadSketchGeneratedComponents = Object.freeze({ pointIds: new Set<string>(), entityIds: new Set<string>(), circleIds: new Set<string>(), relationIds: new Set<string>(), byPrefix: new Map() });
const components = new WeakMap<CadSketchGraph, CadSketchGeneratedComponents>();
export function cadSketchGeneratedComponents(graph: CadSketchGraph): CadSketchGeneratedComponents {
  const index = generatorIndex(graph);
  if (!index.generators.length) return NO_COMPONENTS;
  const kept = components.get(graph);
  if (kept) return kept;
  const pointIds = new Set<string>(), entityIds = new Set<string>(), circleIds = new Set<string>(), relationIds = new Set<string>();
  const byPrefix = new Map<string, { pointIds: string[]; entityIds: string[]; relationIds: string[] }>();
  const of = (id: string) => {
    const namespace = cadSketchIdNamespace(id);
    if (namespace === undefined || !index.byPrefix.has(namespace)) return undefined;
    let found = byPrefix.get(namespace);
    if (!found) byPrefix.set(namespace, found = { pointIds: [], entityIds: [], relationIds: [] });
    return found;
  };
  for (const point of graph.points) { const owner = of(point.id); if (owner) { owner.pointIds.push(point.id); pointIds.add(point.id); } }
  for (const entity of graph.entities) {
    const owner = of(entity.id);
    if (!owner) continue;
    owner.entityIds.push(entity.id); entityIds.add(entity.id);
    if (entity.kind === 'circle') circleIds.add(entity.id);
  }
  for (const relation of graph.relations) { const owner = of(relation.id); if (owner) { owner.relationIds.push(relation.id); relationIds.add(relation.id); } }
  const result: CadSketchGeneratedComponents = Object.freeze({ pointIds, entityIds, circleIds, relationIds, byPrefix });
  if (isAcceptedCadSketchGraph(graph)) components.set(graph, result);
  return result;
}

/** Why the selected point or edge cannot be edited on its own: a generator made it. Null for geometry no generator made. */
export function cadSketchGeneratorLockReason(graph: CadSketchGraph, selection: Pick<CadSketchGraphSelection, 'id'>): string | null {
  const generator = cadSketchGeneratorOwner(graph, selection.id);
  return generator ? `${cadSketchGeneratorName(generator)} generates this geometry. Edit the generator's inputs, or detach it, before editing generated geometry.` : null;
}

/**
 * The checks a generator record needs beyond its schema and operand slots: a prefix no other generator uses, an id outside every
 * generator's members, and operands outside its own members, which it would generate from itself.
 */
export function validateCadSketchGeneratorRecord(graph: CadSketchGraph, generator: CadSketchGenerator): void {
  const name = cadSketchGeneratorName(generator), index = generatorIndex(graph);
  let sharing = 0;
  for (const other of index.generators) if (other.idPrefix === generator.idPrefix) sharing += 1;
  if (sharing > 1) throw invalid(`${name} shares its id prefix "${generator.idPrefix}" with another generator.`);
  const namespace = cadSketchIdNamespace(generator.id);
  if (namespace !== undefined && index.byPrefix.has(namespace)) throw invalid(`${name} has an id among the generated geometry of the generator with prefix "${namespace}".`);
  const kind = cadSketchGeneratorKind(generator.geometry), operands = kind.operands(generator.geometry);
  for (const id of operands) if (cadSketchIdNamespace(id) === generator.idPrefix) throw invalid(`${name} cannot generate from its own geometry "${id}".`);
  // Before generation, as members keyed by a repeated operand would repeat.
  const { distinct } = kind.signature(generator.geometry), seen = new Set<string>();
  for (const index of distinct?.slots ?? []) {
    if (seen.has(operands[index])) throw invalid(`${name} names "${operands[index]}" twice. ${distinct!.refusal.message}`);
    seen.add(operands[index]);
  }
}

/**
 * What checking every generator of a graph found for some parameters: the prefixes of those that carry other members than they make, and
 * the first that cannot generate, with its refusal, which leaves it and those after it unchecked.
 */
interface MemberCheck {
  readonly lists: readonly [readonly unknown[], readonly unknown[], readonly unknown[]];
  readonly parameters: Parameters;
  readonly stale: ReadonlySet<string>;
  readonly refusal?: { readonly at: number; readonly error: CadError };
}
const memberChecks = new WeakMap<CadSketchGraph, MemberCheck>();
const NOTHING_STALE: ReadonlySet<string> = new Set();
/**
 * The check of all the graph's generators at once, kept with the graph for those parameters and lists, so a graph check generates each
 * generator once instead of again for every generator after it.
 */
function memberCheck(graph: CadSketchGraph, index: GeneratorIndex, parameters: Parameters): MemberCheck {
  const kept = memberChecks.get(graph);
  if (kept && kept.lists[0] === graph.points && kept.lists[1] === graph.entities && kept.lists[2] === graph.relations && sameParameters(kept.parameters, parameters)) return kept;
  const lists = [graph.points, graph.entities, graph.relations] as const;
  let check: MemberCheck;
  if (isSettled(graph, index, parameters)) check = { lists, parameters: keptParameters(parameters), stale: NOTHING_STALE };
  else {
    const stored = split(graph, index), { generations, refusal } = generateEach(index, stored, parameters), stale = new Set<string>();
    for (const { generator, members } of generations) {
      const carried = stored.carried.get(generator.idPrefix);
      if (!carried || !carriesExactly(carried, members)) stale.add(generator.idPrefix);
    }
    check = { lists, parameters: keptParameters(parameters), stale, ...(refusal ? { refusal: { at: generations.length, error: refusal } } : {}) };
  }
  memberChecks.set(graph, check);
  return check;
}
/** Whether the graph carries what the generator makes from `parameters`: an issue on the generator when it does not. */
export function checkCadSketchGeneratorMembers(graph: CadSketchGraph, generator: CadSketchGenerator, parameters: Parameters): readonly CadSketchGraphIssue[] {
  const index = generatorIndex(graph), check = memberCheck(graph, index, parameters);
  if (check.refusal && index.generators.indexOf(generator) >= check.refusal.at) throw check.refusal.error;
  return check.stale.has(generator.idPrefix)
    ? [{ source: { kind: 'relation', id: generator.id }, code: 'relation-residual', message: `${cadSketchGeneratorName(generator)} carries geometry that its inputs no longer generate.` }] : [];
}

/** A generator's closed outline: the legacy shape its kind checked, and the ids of the edges that draw it. */
export interface CadSketchGeneratorOutline {
  readonly generator: CadSketchGenerator;
  readonly shape: ResolvedCadProfile;
  readonly entityIds: ReadonlySet<string>;
}
const NO_OUTLINES: ReadonlyMap<string, CadSketchGeneratorOutline> = new Map();
const outlines = new WeakMap<CadSketchGraph, { readonly parameters: Parameters; readonly byPrefix: ReadonlyMap<string, CadSketchGeneratorOutline> }>();
/**
 * Each generator's closed outline in the accepted graph, by prefix, from `parameters`: the shape it was checked as, which its edges draw.
 * A generator whose inputs no longer evaluate has none.
 */
export function cadSketchGeneratorOutlines(graph: CadSketchGraph, parameters: Parameters): ReadonlyMap<string, CadSketchGeneratorOutline> {
  const index = generatorIndex(graph);
  if (!index.generators.length) return NO_OUTLINES;
  const kept = outlines.get(graph);
  if (kept && sameParameters(kept.parameters, parameters)) return kept.byPrefix;
  const byPrefix = new Map<string, CadSketchGeneratorOutline>();
  // The generations that made the graph's members from these parameters give the shapes and the edges; a generator they did not make
  // is evaluated here, and its edges read from the graph.
  const evaluated = evaluatedGraphs.get(graph);
  evaluatedGraphs.delete(graph);
  const generations = new Map(evaluated && sameParameters(evaluated.parameters, parameters) ? evaluated.generations.map(item => [item.generator, item] as const) : []);
  let lines: Readable | undefined, members: ReadonlyMap<string, CadSketchRelationOwnership> | undefined;
  const context = () => { if (!lines) { lines = new Readable(parameters); lines.add(graph); } return lines.context(); };
  for (const generator of index.generators) {
    const made = generations.get(generator);
    let shape: ResolvedCadProfile;
    try {
      const outline = (made?.evaluation ?? cadSketchGeneratorKind(generator.geometry).evaluate(generator.geometry, context(), cadSketchGeneratorName(generator))).shape;
      if (!outline) continue;
      shape = outline();
    } catch { continue; }
    const entityIds = made ? made.members.entities.map(entity => entity.id) : (members ??= cadSketchGeneratedComponents(graph).byPrefix).get(generator.idPrefix)?.entityIds ?? [];
    byPrefix.set(generator.idPrefix, { generator, shape, entityIds: new Set(entityIds) });
  }
  if (isAcceptedCadSketchGraph(graph)) outlines.set(graph, { parameters: keptParameters(parameters), byPrefix });
  return byPrefix;
}

/** The generator's members as the relation's ownership: only a graph names them. */
export function cadSketchGeneratorOwnership(generator: CadSketchGenerator, graph?: CadSketchGraph): CadSketchRelationOwnership & { readonly relationIds: readonly string[] } {
  return graph ? cadSketchGeneratorMembers(graph, generator) : NO_MEMBERS;
}
