import { Value } from '@sinclair/typebox/value';
import { CadError } from '../cadError';
import { evaluateCadScalar } from '../cadExpression';
import {
  acceptCadSketchGraph, detachCadSketchGraph, isAcceptedCadSketchGraph, trustCadSketchGeneratedItems,
  type CadSketchGenerator, type CadSketchGeneratorGeometry, type CadSketchGraph, type CadSketchGraphEntity, type CadSketchGraphIssue,
  type CadSketchGraphPoint, type CadSketchGraphRelation
} from '../cadSketchGraph';
import { cadSketchEntityPointIds } from '../cadSketchGraphReferences';
import type { CadSketchGraphSelection } from '../cadSketchGraphSelection';
import { applyCadSketchRemapOutcomes, remapCadSketchRelations } from '../sketch-relations/cadSketchRelationRemap';
import { cadSketchRelationDefinition } from '../sketch-relations/cadSketchRelationRegistry';
import type { CadSketchRelationOwnership } from '../sketch-relations/cadSketchRelationTypes';
import { CAD_SKETCH_H_AXIS_ID, CAD_SKETCH_V_AXIS_ID } from '../sketch-relations/cadSketchVirtualElements';
import {
  CAD_SKETCH_GENERATOR_KINDS, type CadSketchGeneratedGeometry, type CadSketchGeneratorContext, type CadSketchGeneratorEvaluation,
  type CadSketchGeneratorKind
} from './cadSketchGeneratorKinds';

// A sketch generator is a relation that makes and keeps geometry: a profile's outline, a plugin's shape or a regular polygon. Only its
// record is stored. Parsing a document generates its members from the record and the document's parameters, as real points, edges and
// relations with ids `<idPrefix>_<key>`, and adds them to the accepted graph, so every reader of the graph sees them as geometry. Saving
// writes the record alone. Members are fixed in the solver, and an edit of one is refused, naming its generator, until the generator is
// detached. A change of the generator's inputs or parameters regenerates its members in the same edit, and a member that leaves with
// the user relations on it goes through the relation remap, which keeps, removes or refuses each one.

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

interface GeneratorIndex {
  readonly generators: readonly CadSketchGenerator[];
  readonly byPrefix: ReadonlyMap<string, CadSketchGenerator>;
}
const EMPTY_INDEX: GeneratorIndex = Object.freeze({ generators: Object.freeze([]), byPrefix: new Map() });
const generatorIndexes = new WeakMap<CadSketchGraph, GeneratorIndex>();
/** The graph's generators in relation order, by prefix too; an accepted graph keeps its index. */
function generatorIndex(graph: CadSketchGraph): GeneratorIndex {
  const kept = generatorIndexes.get(graph);
  if (kept) return kept;
  const generators = graph.relations.filter((relation): relation is CadSketchGenerator => relation.kind === 'generator');
  const index = generators.length ? { generators, byPrefix: new Map(generators.map(generator => [generator.idPrefix, generator])) } : EMPTY_INDEX;
  if (isAcceptedCadSketchGraph(graph)) generatorIndexes.set(graph, index);
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

/** The lines generation may read: the sketch's stored lines and those of members generated before, by id. */
class Lines {
  private readonly points = new Map<string, CadSketchGraphPoint>();
  private readonly entities = new Map<string, CadSketchGraphEntity>();
  constructor(private readonly parameters: Readonly<Record<string, number>>) {}
  add(points: readonly CadSketchGraphPoint[], entities: readonly CadSketchGraphEntity[]) {
    for (const point of points) this.points.set(point.id, point);
    for (const entity of entities) if (entity.kind === 'line') this.entities.set(entity.id, entity);
  }
  context(): CadSketchGeneratorContext {
    return { parameters: this.parameters, line: id => {
      if (id === CAD_SKETCH_H_AXIS_ID) return { start: { x: 0, y: 0 }, end: { x: 1, y: 0 } };
      if (id === CAD_SKETCH_V_AXIS_ID) return { start: { x: 0, y: 0 }, end: { x: 0, y: 1 } };
      const line = this.entities.get(id);
      if (line?.kind !== 'line') return undefined;
      const at = (pointId: string) => {
        const point = this.points.get(pointId);
        return point && { x: evaluateCadScalar(point.position[0], this.parameters), y: evaluateCadScalar(point.position[1], this.parameters) };
      };
      const start = at(line.startPointId), end = at(line.endPointId);
      return start && end ? { start, end } : undefined;
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

interface Generation { readonly generator: CadSketchGenerator; readonly members: CadSketchGeneratedGeometry; readonly key: string }
/**
 * Every generator's members in relation order, each reading the stored lines and those generated before it. A generator whose inputs
 * do not evaluate, or whose shape is refused, is refused naming it.
 */
function generateAll(index: GeneratorIndex, stored: Split, parameters: Readonly<Record<string, number>>): readonly Generation[] {
  const lines = new Lines(parameters);
  lines.add(stored.points, stored.entities);
  return index.generators.map(generator => {
    const name = cadSketchGeneratorName(generator);
    let evaluation: CadSketchGeneratorEvaluation, members: CadSketchGeneratedGeometry;
    try {
      evaluation = cadSketchGeneratorKind(generator.geometry).evaluate(generator.geometry, lines.context(), name);
      members = generated(generator, evaluation);
    } catch (error) {
      if (error instanceof CadError && error.message.includes(`"${generator.id}"`)) throw error;
      throw invalid(`${name}: ${error instanceof Error ? error.message : 'its geometry cannot be generated.'}`);
    }
    lines.add(members.points, members.entities);
    return { generator, members, key: `${generator.idPrefix}\u0000${generator.construction}\u0000${evaluation.key}` };
  });
}

// Accepted graphs whose members were generated with these keys, one for each generator in order.
const settledKeys = new WeakMap<CadSketchGraph, string>();
const keysOf = (generations: readonly Generation[]) => generations.map(item => item.key).join('\u0001');
/** The keys the graph's generators evaluate to now, read from its own members, or null when one does not evaluate. */
function currentKeys(graph: CadSketchGraph, index: GeneratorIndex, parameters: Readonly<Record<string, number>>): string | null {
  const lines = new Lines(parameters);
  lines.add(graph.points, graph.entities);
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
function accepted(stored: Split, generations: readonly Generation[], graph: CadSketchGraph, relations = stored.relations): CadSketchGraph {
  const result = acceptCadSketchGraph({ ...graph,
    points: [...stored.points, ...generations.flatMap(item => item.members.points)],
    entities: [...stored.entities, ...generations.flatMap(item => item.members.entities)],
    relations: [...relations, ...generations.flatMap(item => item.members.relations)] });
  settledKeys.set(result, keysOf(generations));
  return result;
}

/** Refuses stored geometry that a generator owns: an edge of the sketch's own ending at a generated point. */
function assertStoredOutsideMembers(stored: Split, index: GeneratorIndex): void {
  for (const entity of stored.entities) for (const pointId of cadSketchEntityPointIds(entity)) {
    const namespace = cadSketchIdNamespace(pointId), generator = namespace === undefined ? undefined : index.byPrefix.get(namespace);
    if (generator) throw invalid(`Sketch edge "${entity.id}" cannot end at "${pointId}", which ${cadSketchGeneratorName(generator)} generates. Connect to it with a coincident relation instead.`);
  }
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
  const settled = settledKeys.get(graph);
  if (settled !== undefined && settled === currentKeys(graph, index, parameters)) return graph;
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
    settledKeys.set(graph, keysOf(generations));
    return graph;
  }
  return accepted(stored, generations, graph);
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
 * the relation remap, as `regenerateCadSketchGenerators` says. A generator stored without members gets them, taking the place of those it
 * had before. The candidate itself when nothing needs generating.
 */
export function settleCadSketchGenerators(candidate: CadSketchGraph, previous: CadSketchGraph | undefined, parameters: Readonly<Record<string, number>>): CadSketchGraph {
  const graph = isAcceptedCadSketchGraph(candidate) ? candidate : detachCadSketchGraph(candidate), index = generatorIndex(graph);
  if (!index.generators.length) return graph === candidate ? candidate : acceptCadSketchGraph(graph);
  const settled = settledKeys.get(graph);
  if (settled !== undefined && settled === currentKeys(graph, index, parameters)) return graph;
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
    if (!generations.every(({ generator, members }) => identical(stored.carried.get(generator.idPrefix)!, members))) return accepted(stored, generations, graph);
    settledKeys.set(graph, keysOf(generations));
    return acceptCadSketchGraph(graph);
  }
  // Members that leave, or whose id now names another kind of edge, end the user relations on them.
  const curves = new Map<string, readonly never[]>(), points = new Map<string, null>(), owners = new Map<string, CadSketchGenerator>();
  for (const { generator, members } of generations) {
    const kept = had.get(generator.idPrefix);
    if (!kept) continue;
    const kinds = new Map(members.entities.map(entity => [entity.id, entity.kind])), keptPoints = new Set(members.points.map(point => point.id));
    for (const entity of kept.entities) if (kinds.get(entity.id) !== entity.kind) { curves.set(entity.id, []); owners.set(entity.id, generator); }
    for (const point of kept.points) if (!keptPoints.has(point.id)) { points.set(point.id, null); owners.set(point.id, generator); }
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
    const blocked = outcomes.find(outcome => outcome.kind === 'blocked');
    if (blocked?.kind === 'blocked') {
      const definition = cadSketchRelationDefinition(blocked.relation), operands = definition.operands(blocked.relation);
      const leaving = [...operands, ...definition.owns?.(blocked.relation, was).entityIds ?? []].find(id => owners.has(id))
        ?? cadSketchRelationPointsOf(was, blocked.relation).find(id => owners.has(id));
      const generator = (leaving === undefined ? undefined : owners.get(leaving)) ?? generations[0].generator;
      throw owned(`${cadSketchGeneratorName(generator)} no longer generates geometry that ${definition.nameOf?.(blocked.relation) ?? definition.name} "${blocked.relation.id}" uses. ${blocked.reason} Remove the relation first, or keep the generator's inputs.`);
    }
    relations = applyCadSketchRemapOutcomes(stored.relations, outcomes);
  }
  const result = accepted(stored, generations, graph, relations);
  regeneratedGraphs.add(result);
  return result;
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
  for (const id of cadSketchGeneratorKind(generator.geometry).operands(generator.geometry))
    if (cadSketchIdNamespace(id) === generator.idPrefix) throw invalid(`${name} cannot generate from its own geometry "${id}".`);
}

/** Whether the graph carries what the generator makes from `parameters`: an issue on the generator when it does not. */
export function checkCadSketchGeneratorMembers(graph: CadSketchGraph, generator: CadSketchGenerator, parameters: Readonly<Record<string, number>>): readonly CadSketchGraphIssue[] {
  const index = generatorIndex(graph), at = index.generators.indexOf(generator);
  const settled = settledKeys.get(graph);
  if (settled !== undefined && settled === currentKeys(graph, index, parameters)) return [];
  const stored = split(graph, index), generations = generateAll({ generators: index.generators.slice(0, at + 1), byPrefix: index.byPrefix }, stored, parameters);
  const carried = stored.carried.get(generator.idPrefix);
  return carried && carriesExactly(carried, generations[at].members) ? []
    : [{ source: { kind: 'relation', id: generator.id }, code: 'relation-residual', message: `${cadSketchGeneratorName(generator)} carries geometry that its inputs no longer generate.` }];
}

/** The generator's members as the relation's ownership: only a graph names them. */
export function cadSketchGeneratorOwnership(generator: CadSketchGenerator, graph?: CadSketchGraph): CadSketchRelationOwnership & { readonly relationIds: readonly string[] } {
  return graph ? cadSketchGeneratorMembers(graph, generator) : NO_MEMBERS;
}
