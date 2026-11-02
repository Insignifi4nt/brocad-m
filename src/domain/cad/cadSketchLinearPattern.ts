import { Value } from '@sinclair/typebox/value';
import type { CadSketchFeature } from './cadDocument';
import { CadError } from './cadError';
import { evaluateCadScalar } from './cadExpression';
import { isAcceptedCadSketchGraph, parseCadSketchGraph, type CadSketchGraph, type CadSketchLinearPattern, type CadSketchGraphIssue } from './cadSketchGraph';
import type { CadSketchGraphSelection } from './cadSketchGraphSelection';
import { cadSketchEntityPointIds, cadSketchRelationEntityIds, cadSketchRelationPointIds } from './cadSketchGraphReferences';
import { cadSketchDriverTolerance } from './cadSketchPrecision';
import { cadSupportedLength } from '../precision/cadPrecision';
import { copiedCadSketchRelations, copyCadSketchRelations, remapCadSketchRelations } from './sketch-relations/cadSketchRelationRemap';

const invalid = (message: string): never => { throw new CadError('invalid-sketch-pattern', message); };
const locked = () => new CadError('owned-sketch-pattern', 'Edit the seed or detach its linear pattern before editing generated geometry.');
export interface CadSketchLinearPatternInstance {
  readonly index: number; readonly pointId: string; readonly entityId: string;
  readonly inRange: boolean; readonly omitted: boolean; readonly active: boolean;
}
export function cadSketchLinearPatternInstances(relation: CadSketchLinearPattern): readonly CadSketchLinearPatternInstance[] {
  return Object.freeze(Array.from({ length: 31 }, (_, ordinal) => {
    const index = ordinal + 1, inRange = index < relation.count, omitted = relation.omittedInstances.includes(index);
    return Object.freeze({ index, pointId: `${relation.idPrefix}_i${index}_p0`, entityId: `${relation.idPrefix}_i${index}_e0`, inRange, omitted, active: inRange && !omitted });
  }));
}
type PatternOwner = { readonly relation: CadSketchLinearPattern; readonly index: number };
type PatternOwners = { readonly entity: ReadonlyMap<string, PatternOwner>; readonly point: ReadonlyMap<string, PatternOwner> };
// An accepted graph cannot change, so its owners are listed once instead of scanned for at each of its points and edges.
// The list keeps what the scan finds first: the first owning pattern in relation order, and within it the seed, then the
// lowest occurrence.
const patternOwners = new WeakMap<CadSketchGraph, PatternOwners>();
function acceptedPatternOwners(graph: CadSketchGraph): PatternOwners {
  const listed = patternOwners.get(graph);
  if (listed) return listed;
  const entity = new Map<string, PatternOwner>(), point = new Map<string, PatternOwner>();
  const own = (owners: Map<string, PatternOwner>, id: string, owner: PatternOwner) => { if (!owners.has(id)) owners.set(id, owner); };
  for (const relation of graph.relations) if (relation.kind === 'linear-pattern') {
    const seed = Object.freeze({ relation, index: 0 });
    own(entity, relation.seed.entityId, seed); own(point, relation.seed.centerPointId, seed);
    for (const member of cadSketchLinearPatternInstances(relation)) if (member.active) {
      const owner = Object.freeze({ relation, index: member.index });
      own(entity, member.entityId, owner); own(point, member.pointId, owner);
    }
  }
  const owners = Object.freeze({ entity, point });
  patternOwners.set(graph, owners);
  return owners;
}
export function cadSketchLinearPatternForSelection(graph: CadSketchGraph, selection: CadSketchGraphSelection): PatternOwner | null {
  if (isAcceptedCadSketchGraph(graph)) {
    const owners = acceptedPatternOwners(graph);
    return (selection.kind === 'entity' ? owners.entity : owners.point).get(selection.id) ?? null;
  }
  for (const relation of graph.relations) if (relation.kind === 'linear-pattern') {
    if (selection.id === (selection.kind === 'entity' ? relation.seed.entityId : relation.seed.centerPointId)) return { relation, index: 0 } as const;
    const member = cadSketchLinearPatternInstances(relation).find(member => member.active && selection.id === (selection.kind === 'entity' ? member.entityId : member.pointId));
    if (member) return { relation, index: member.index } as const;
  }
  return null;
}
export function cadSketchLinearPatternLockReason(graph: CadSketchGraph, selection: CadSketchGraphSelection): string | null {
  const owner = cadSketchLinearPatternForSelection(graph, selection);
  return owner && owner.index > 0 ? locked().message : null;
}
function members(graph: CadSketchGraph, relation: CadSketchLinearPattern) {
  return cadSketchLinearPatternInstances(relation).filter(member => member.active).map(member => ({ ...member,
    point: graph.points.find(point => point.id === member.pointId), entity: graph.entities.find(entity => entity.id === member.entityId) }));
}
/** Structural ownership only; unsolved numeric positions remain ordinary solver variables. */
export function validateCadSketchLinearPattern(graph: CadSketchGraph, relation: CadSketchLinearPattern): void {
  const seed = graph.entities.find(entity => entity.id === relation.seed.entityId);
  if (seed?.kind !== 'circle' || seed.construction || seed.centerPointId !== relation.seed.centerPointId) return invalid('A linear pattern needs its original material circle and center identities.');
  if (graph.relations.some(other => other.kind === 'linear-pattern' && other.id !== relation.id && other.seed.entityId === seed.id)) return invalid('A circle can seed only one linear pattern.');
  const active = members(graph, relation), pointIds = new Set(active.map(member => member.pointId)), entityIds = new Set(active.map(member => member.entityId));
  for (const member of active) if (!member.point || member.point.position.some(value => typeof value !== 'number') || member.entity?.kind !== 'circle'
    || member.entity.centerPointId !== member.pointId || member.entity.construction || typeof member.entity.radius !== 'number')
    return invalid('Pattern occurrences need their complete dedicated numeric circles and centers.');
  for (const entity of graph.entities) if (!entityIds.has(entity.id) && cadSketchEntityPointIds(entity).some(id => pointIds.has(id))) return invalid('Pattern occurrence centers cannot be shared with other entities.');
  for (const other of graph.relations) if (other.id !== relation.id && other.kind !== 'reference-dimension'
    && (cadSketchRelationEntityIds(other).some(id => entityIds.has(id)) || cadSketchRelationPointIds(graph, other).some(id => pointIds.has(id)))) throw locked();
}
function values(graph: CadSketchGraph, parameters: Readonly<Record<string, number>>, relation: CadSketchLinearPattern) {
  const seed = graph.entities.find(entity => entity.id === relation.seed.entityId), center = graph.points.find(point => point.id === relation.seed.centerPointId);
  if (seed?.kind !== 'circle' || !center) return invalid('The pattern seed is unavailable.');
  const spacing = evaluateCadScalar(relation.spacing, parameters), radius = evaluateCadScalar(seed.radius, parameters);
  const origin = center.position.map(value => evaluateCadScalar(value, parameters));
  if (!(spacing > 0) || !Number.isFinite(spacing) || !cadSupportedLength(radius)) return invalid('Pattern spacing and seed radius must be positive supported sizes.');
  const axis = relation.direction.endsWith('x') ? 0 : 1, sign = relation.direction.startsWith('-') ? -1 : 1;
  const positions = cadSketchLinearPatternInstances(relation).filter(member => member.active).map(member => {
    const step = sign * member.index * spacing, position = [origin[0], origin[1]] as [number, number]; position[axis] += step;
    if (!Number.isFinite(step) || position.some(value => !Number.isFinite(value) || Math.abs(value) > 1e9) || position[axis] === origin[axis])
      return invalid('The pattern spacing cannot be represented at these coordinates.');
    return { ...member, position };
  });
  if (new Set(positions.map(member => member.position[axis])).size !== positions.length) return invalid('Pattern occurrences must occupy distinct representable positions.');
  return { origin, radius, positions };
}
export function checkCadSketchLinearPattern(graph: CadSketchGraph, parameters: Readonly<Record<string, number>>, relation: CadSketchLinearPattern): CadSketchGraphIssue[] {
  const source = { kind: 'relation', id: relation.id } as const;
  try {
    const { origin, radius, positions } = values(graph, parameters, relation);
    for (const member of positions) {
      const point = graph.points.find(point => point.id === member.pointId), entity = graph.entities.find(entity => entity.id === member.entityId);
      if (!point || entity?.kind !== 'circle') return invalid('A pattern occurrence is missing.');
      const actual = point.position.map(value => evaluateCadScalar(value, parameters)), actualRadius = evaluateCadScalar(entity.radius, parameters);
      const residualMm = Math.max(Math.abs((actual[0] - origin[0]) - (member.position[0] - origin[0])), Math.abs((actual[1] - origin[1]) - (member.position[1] - origin[1])));
      if (residualMm > cadSketchDriverTolerance([{ x: origin[0], y: origin[1] }, { x: actual[0], y: actual[1] }])
        || Math.abs(actualRadius - radius) > cadSketchDriverTolerance([{ x: radius, y: radius }, { x: actualRadius, y: actualRadius }]))
        return [{ source, code: 'relation-residual', message: 'Pattern occurrences do not match their seed, spacing and direction.', residualMm: Math.max(residualMm, Math.abs(actualRadius - radius)) }];
      for (const other of graph.entities) if (other.kind === 'circle' && other.id !== member.entityId) {
        const center = graph.points.find(point => point.id === other.centerPointId);
        if (center && evaluateCadScalar(center.position[0], parameters) === actual[0] && evaluateCadScalar(center.position[1], parameters) === actual[1]
          && evaluateCadScalar(other.radius, parameters) === actualRadius) return invalid('A pattern occurrence duplicates another circular support.');
      }
    }
    return [];
  } catch (error) { return [{ source, code: 'relation-residual', message: error instanceof Error ? error.message : 'Invalid linear pattern.' }]; }
}
function sameBinding(a: CadSketchLinearPattern, b: CadSketchLinearPattern) { return a.id === b.id && a.idPrefix === b.idPrefix && Value.Equal(a.seed, b.seed); }

/**
 * Explicit owner edit: seed all surviving/new members, never claim IDs by prefix. With `copyRelations`, each occurrence it creates copies
 * the seed's reference dimensions as `<idPrefix>_i<index>_r<n>`, a translation by the shared rule (see `copyCadSketchRelations`). The
 * seed's driving relations are not copied, since the pattern owns its occurrences and drives them through the seed, and neither is a
 * reference reaching other geometry. Occurrences it keeps keep their relations as they are.
 */
export function reconcileCadSketchLinearPattern({ graph, parameters, relation, previous, copyRelations = false }: {
  graph: CadSketchGraph; parameters: Readonly<Record<string, number>>; relation: CadSketchLinearPattern; previous?: CadSketchLinearPattern;
  copyRelations?: boolean;
}): CadSketchGraph {
  const actual = graph.relations.find(other => other.id === relation.id);
  if (previous ? !Value.Equal(actual, previous) : actual !== undefined) return invalid('Reconcile a pattern against its actual predecessor owner.');
  if (previous && !sameBinding(previous, relation)) return invalid('Detach the original pattern before changing its seed or identity prefix.');
  if (previous) validateCadSketchLinearPattern(graph, previous);
  const old = previous ? members(graph, previous) : [], retained = new Set(old.flatMap(member => [member.pointId, member.entityId]));
  const next = values(graph, parameters, relation), active = new Set(next.positions.flatMap(member => [member.pointId, member.entityId]));
  const removed = new Set([...retained].filter(id => !active.has(id)));
  // An omitted occurrence leaves with its centre: every other relation on either blocks the omission (see `remapCadSketchRelations`).
  const leaving = old.filter(member => removed.has(member.entityId));
  const outcomes = leaving.length ? remapCadSketchRelations(graph, { curves: new Map(leaving.map(member => [member.entityId, []])),
    points: new Map(leaving.map(member => [member.pointId, null])) }) : [];
  if (outcomes.some(item => item.kind === 'blocked' && item.relation.id !== previous?.id)) return invalid('Remove dependent relations before omitting a pattern occurrence.');
  // A new owner's own id is taken as well, so neither an occurrence nor a copied relation may reuse it.
  const occupied = new Set([...graph.points, ...graph.entities, ...graph.relations, relation].map(item => item.id));
  for (const id of active) if (occupied.has(id) && !retained.has(id)) return invalid('A pattern occurrence identity already belongs to other geometry.');
  const positions = new Map(next.positions.map(member => [member.pointId, member.position]));
  const points = graph.points.filter(point => !removed.has(point.id)).map(point => positions.has(point.id) ? { ...point, position: positions.get(point.id)! } : point);
  const entities = graph.entities.filter(entity => !removed.has(entity.id)).map(entity => retained.has(entity.id) && entity.kind === 'circle' ? { ...entity, radius: next.radius } : entity);
  const created = next.positions.filter(member => !retained.has(member.entityId));
  for (const member of created) {
    points.push({ id: member.pointId, position: member.position });
    entities.push({ id: member.entityId, kind: 'circle', construction: false, centerPointId: member.pointId, radius: next.radius });
  }
  const copied = copyRelations ? created.flatMap(member => copiedCadSketchRelations(copyCadSketchRelations(graph, { kind: 'pattern',
    curves: new Map([[relation.seed.entityId, { entityId: member.entityId, interval: [0, 1], orientation: 'same' }]]),
    points: new Map([[relation.seed.centerPointId, member.pointId]]),
    relationId: (_source, index) => `${relation.idPrefix}_i${member.index}_r${index}` }))) : [];
  for (const copy of copied) if (occupied.has(copy.id)) return invalid('A copied occurrence relation identity already belongs to other geometry.');
  const relations = previous ? graph.relations.map(other => other.id === previous.id ? relation : other) : [...graph.relations, relation];
  return parseCadSketchGraph({ points, entities, relations: [...relations, ...copied] });
}

/** A complete source snapshot may carry solved members, but cannot edit one member backward into its seed. */
export function prepareCadSketchPatternSnapshot(previous: CadSketchFeature, candidate: CadSketchFeature, parameters: Readonly<Record<string, number>>): CadSketchFeature {
  let graph = candidate.graph;
  for (const owner of previous.graph?.relations ?? []) if (owner.kind === 'linear-pattern') {
    const next = graph?.relations.find(relation => relation.id === owner.id);
    const owned = members(previous.graph!, owner);
    if (!next) {
      if (!graph || !Value.Equal(graph.entities.find(entity => entity.id === owner.seed.entityId), previous.graph!.entities.find(entity => entity.id === owner.seed.entityId))
        || !Value.Equal(graph.points.find(point => point.id === owner.seed.centerPointId), previous.graph!.points.find(point => point.id === owner.seed.centerPointId))
        || owned.some(member => !Value.Equal(member.point, graph!.points.find(point => point.id === member.pointId)) || !Value.Equal(member.entity, graph!.entities.find(entity => entity.id === member.entityId)))) throw locked();
      continue;
    }
    if (next.kind !== 'linear-pattern' || !sameBinding(owner, next)) throw locked();
    const nextIds = new Set(cadSketchLinearPatternInstances(next).filter(member => member.active).flatMap(member => [member.pointId, member.entityId]));
    const oldIds = new Set(owned.flatMap(member => [member.pointId, member.entityId]));
    if (owned.some(member => !nextIds.has(member.entityId) && (graph!.points.some(point => point.id === member.pointId) || graph!.entities.some(entity => entity.id === member.entityId))))
      return invalid('Omission must remove the complete owned circle and its dedicated center.');
    const occupied = new Set([...previous.graph!.points, ...previous.graph!.entities, ...previous.graph!.relations].map(item => item.id));
    if ([...nextIds].some(id => !oldIds.has(id) && occupied.has(id))) return invalid('A regrown occurrence cannot claim existing geometry.');
    const untouched = owned.every(member => Value.Equal(member.point, graph!.points.find(point => point.id === member.pointId)) && Value.Equal(member.entity, graph!.entities.find(entity => entity.id === member.entityId)));
    const seedChanged = !Value.Equal(previous.graph!.points.find(point => point.id === owner.seed.centerPointId), graph!.points.find(point => point.id === owner.seed.centerPointId))
      || !Value.Equal(previous.graph!.entities.find(entity => entity.id === owner.seed.entityId), graph!.entities.find(entity => entity.id === owner.seed.entityId));
    if (untouched && seedChanged && Value.Equal(owner, next)) graph = reconcileCadSketchLinearPattern({ graph: graph!, parameters, relation: next, previous: owner });
    else if ((!untouched && !seedChanged && Value.Equal(owner, next) && !checkCadSketchLinearPattern(previous.graph!, parameters, owner).length)
      || checkCadSketchLinearPattern(graph!, parameters, next).length) throw locked();
  }
  for (const owner of graph?.relations ?? []) if (owner.kind === 'linear-pattern' && !previous.graph?.relations.some(relation => relation.id === owner.id && relation.kind === 'linear-pattern')) {
    const occupied = new Set([...(previous.graph?.points ?? []), ...(previous.graph?.entities ?? []), ...(previous.graph?.relations ?? [])].map(item => item.id));
    if (occupied.has(owner.id) || cadSketchLinearPatternInstances(owner).some(member => member.active && (occupied.has(member.pointId) || occupied.has(member.entityId)))
      || checkCadSketchLinearPattern(graph!, parameters, owner).length) throw locked();
  }
  return { ...candidate, ...(graph ? { graph } : {}) };
}

/** Metadata/topology and explicit seed snapshots use the existing exact-intent preparation boundary. */
export function cadSketchPatternSnapshotNeedsExact(previous: CadSketchFeature, candidate: CadSketchFeature): boolean {
  const owners = previous.graph?.relations.filter(relation => relation.kind === 'linear-pattern') ?? [];
  if (!Value.Equal(owners, candidate.graph?.relations.filter(relation => relation.kind === 'linear-pattern') ?? [])) return true;
  return owners.some(owner => !Value.Equal(previous.graph!.points.find(point => point.id === owner.seed.centerPointId), candidate.graph?.points.find(point => point.id === owner.seed.centerPointId))
    || !Value.Equal(previous.graph!.entities.find(entity => entity.id === owner.seed.entityId), candidate.graph?.entities.find(entity => entity.id === owner.seed.entityId)));
}
