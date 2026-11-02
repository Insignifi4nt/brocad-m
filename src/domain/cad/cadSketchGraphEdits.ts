import type { CadSketchFeature } from './cadDocument';
import { CadError } from './cadError';
import { checkCadSketchGraph, parseCadSketchGraph, type CadSketchGenerator, type CadSketchGraph } from './cadSketchGraph';
import { cadSketchEntityPointIds, cadSketchRelationEntityIds, cadSketchRelationPointIds } from './cadSketchGraphReferences';
import { cadSketchLinearPatternForSelection } from './cadSketchLinearPattern';
import { cadSketchGeneratorDeletion } from './sketch-generators/cadSketchGeneratorEdits';
import type { CadEdit } from './cadOperations';
import { cadSketchGeneratorName, cadSketchGeneratorOwner, type CadSketchGeneratorRemovedRelation } from './sketch-generators/cadSketchGenerators';
import { copiedCadSketchRelations, copyCadSketchRelations, type CadSketchRelationCopy } from './sketch-relations/cadSketchRelationRemap';

/** Structural intent only. The shared preparation stage solves before complete-part acceptance. */
export function appendCadSketchEntities({ sketch, geometry }: { sketch: CadSketchFeature; geometry: CadSketchGraph }): CadSketchFeature {
  if (geometry.relations.some(relation => relation.kind === 'linear-pattern')) throw new CadError('invalid-sketch-pattern', 'Create a linear pattern with its set-relation operation.');
  if (geometry.relations.some(relation => relation.kind === 'generator')) throw new CadError('invalid-sketch-generator', 'Create a generator with its set-sketch-generator operation.');
  const profileIds = new Set(sketch.profiles.map(profile => profile.id));
  for (const item of [...geometry.points, ...geometry.entities, ...geometry.relations]) {
    if (profileIds.has(item.id)) throw new CadError('duplicate-sketch-id', `Sketch identity "${item.id}" already belongs to a legacy profile.`);
  }
  return { ...sketch, graph: parseCadSketchGraph({
    points: [...sketch.graph?.points ?? [], ...geometry.points],
    entities: [...sketch.graph?.entities ?? [], ...geometry.entities],
    relations: [...sketch.graph?.relations ?? [], ...geometry.relations]
  }) };
}

/**
 * The relations a copy carries onto it by each kind's rule (see `copyCadSketchRelations`), appended to the sketch the copy was added to,
 * `source` being the graph before it. Each must hold on the copy as its source relation holds on the original: one that does not, where
 * its source does, means the copy lost the geometry's exactness, and `precisionError` says so.
 */
export function appendCadSketchCopiedRelations(sketch: CadSketchFeature, source: CadSketchGraph, parameters: Readonly<Record<string, number>>,
  copy: CadSketchRelationCopy, precisionError: () => CadError): CadSketchFeature {
  const outcomes = copyCadSketchRelations(source, copy), relations = copiedCadSketchRelations(outcomes);
  if (!relations.length || !sketch.graph) return sketch;
  const profileIds = new Set(sketch.profiles.map(profile => profile.id));
  for (const relation of relations) if (profileIds.has(relation.id)) throw new CadError('duplicate-sketch-id', `Sketch identity "${relation.id}" already belongs to a legacy profile.`);
  const graph = parseCadSketchGraph({ ...sketch.graph, relations: [...sketch.graph.relations, ...relations] });
  const from = new Map(outcomes.flatMap(item => item.kind === 'replace' ? item.relations.map(relation => [relation.id, item.relation.id] as const) : []));
  const unmet = (issues: ReturnType<typeof checkCadSketchGraph>) => new Set(issues.flatMap(issue => issue.source.kind === 'relation' ? [issue.source.id] : []));
  const lost = [...unmet(checkCadSketchGraph(graph, parameters))].filter(id => from.has(id));
  if (lost.length) {
    const unmetBefore = unmet(checkCadSketchGraph(source, parameters));
    if (lost.some(id => !unmetBefore.has(from.get(id)!))) throw precisionError();
  }
  return { ...sketch, graph };
}

function requireGraph(sketch: CadSketchFeature): CadSketchGraph {
  if (!sketch.graph) throw new CadError('missing-sketch-graph', 'Choose an existing entity-based sketch.');
  return sketch.graph;
}

function selectedIds(items: readonly { readonly id: string }[], requested: readonly string[], kind: 'point' | 'entity' | 'relation'): Set<string> {
  const existing = new Set(items.map(item => item.id));
  for (const id of requested) if (!existing.has(id)) throw new CadError(`missing-sketch-${kind}`, `Sketch ${kind} "${id}" no longer exists.`);
  return new Set(requested);
}

/** Point-only relations survive entity deletion; entity-owned corner relations require explicit removal or cascade. */
export function deleteCadSketchElements({ sketch, pointIds, entityIds, relationIds, cascade }: {
  sketch: CadSketchFeature; pointIds: readonly string[]; entityIds: readonly string[]; relationIds: readonly string[]; cascade: boolean;
}): CadSketchFeature {
  const graph = requireGraph(sketch), points = selectedIds(graph.points, pointIds, 'point');
  const entities = selectedIds(graph.entities, entityIds, 'entity'), relations = selectedIds(graph.relations, relationIds, 'relation');
  if (entityIds.some(id => cadSketchLinearPatternForSelection(graph, { kind: 'entity', id }))
    || pointIds.some(id => cadSketchLinearPatternForSelection(graph, { kind: 'point', id }))
    || graph.relations.some(relation => relation.kind === 'linear-pattern' && relations.has(relation.id)))
    throw new CadError('owned-sketch-pattern', 'Omit the complete occurrence through its pattern, or detach the pattern before deleting its geometry.');
  const remove = (id: string, selected: Set<string>, generator?: CadSketchGenerator) => {
    if (!cascade && !selected.has(id)) throw new CadError('dependent-sketch-element', generator
      ? `${cadSketchGeneratorName(generator)} is generated from the selected geometry. Select it too, detach it first to keep its geometry, or use cascade deletion.`
      : `Sketch element "${id}" depends on selected geometry. Select it explicitly or use cascade deletion.`);
    selected.add(id);
  };
  // A generator goes with its members, and a cascade that removes a generator's input removes the generator: until nothing more goes.
  for (let size = -1; size !== points.size + entities.size + relations.size;) {
    size = points.size + entities.size + relations.size;
    cadSketchGeneratorDeletion(graph, { pointIds: points, entityIds: entities, relationIds: relations });
    for (const entity of graph.entities) if (!entities.has(entity.id) && cadSketchEntityPointIds(entity).some(id => points.has(id))) remove(entity.id, entities);
    for (const relation of graph.relations) if (!relations.has(relation.id) && (cadSketchRelationPointIds(graph, relation).some(id => points.has(id))
        || cadSketchRelationEntityIds(relation).some(id => entities.has(id)))) remove(relation.id, relations, relation.kind === 'generator' ? relation : undefined);
  }
  return { ...sketch, graph: parseCadSketchGraph({
    points: graph.points.filter(point => !points.has(point.id)),
    entities: graph.entities.filter(entity => !entities.has(entity.id)),
    relations: graph.relations.filter(relation => !relations.has(relation.id))
  }) };
}

/**
 * A deletion of `pointIds`, `entityIds` and `relationIds` prepared to ask before it removes another shape. `edit` deletes them with the
 * curves on deleted points, the members of deleted generators and the user relations on any geometry that goes, which mean nothing
 * without it, as one exact set without cascade. `removed` lists each generator made from that geometry, which a cascade would remove
 * with its members: confirming them lists their IDs among the edit's relationIds too, and with none listed the edit applies as it is.
 */
export interface CadSketchDeletion {
  readonly edit: Extract<CadEdit, { readonly kind: 'delete-sketch-elements' }>;
  readonly removed: readonly CadSketchGeneratorRemovedRelation[];
}
export function prepareCadSketchDeletion({ sketch, pointIds, entityIds, relationIds, name }: {
  sketch: CadSketchFeature; pointIds: readonly string[]; entityIds: readonly string[]; relationIds: readonly string[];
  /** What the deletion is named by, such as a shape's name. */
  name: string;
}): CadSketchDeletion {
  const graph = requireGraph(sketch), kept = deleteCadSketchElements({ sketch, pointIds, entityIds, relationIds, cascade: true }).graph!;
  const keptRelations = new Set(kept.relations.map(relation => relation.id)), keptEntities = new Set(kept.entities.map(entity => entity.id));
  // Members leave with their generator, which a deletion that names the generator lists alone.
  const member = (id: string) => { const owner = cadSketchGeneratorOwner(graph, id); return owner !== undefined && !keptRelations.has(owner.id); };
  const asked = new Set(relationIds);
  const going = graph.relations.filter(relation => !keptRelations.has(relation.id) && !asked.has(relation.id) && !member(relation.id));
  const removed = going.flatMap(relation => relation.kind !== 'generator' ? [] : [{ sketchId: sketch.id, relationId: relation.id, generator: name,
    name: cadSketchGeneratorName(relation), reason: 'It is generated from geometry this deletes.' }]);
  const edit = { kind: 'delete-sketch-elements' as const, sketchId: sketch.id, pointIds: [...pointIds],
    entityIds: [...entityIds, ...graph.entities.flatMap(entity => !keptEntities.has(entity.id) && !entityIds.includes(entity.id) && !member(entity.id) ? [entity.id] : [])],
    relationIds: [...relationIds, ...going.flatMap(relation => relation.kind === 'generator' ? [] : [relation.id])], cascade: false };
  // The confirmed set is exact: a deletion it cannot make, such as a linear pattern seeded by a generated circle, refuses here rather than after asking.
  deleteCadSketchElements({ sketch, pointIds: edit.pointIds, entityIds: edit.entityIds, relationIds: [...edit.relationIds, ...removed.map(relation => relation.relationId)], cascade: false });
  return { edit, removed };
}

export function setCadSketchConstruction({ sketch, entityIds, construction }: {
  sketch: CadSketchFeature; entityIds: readonly string[]; construction: boolean;
}): CadSketchFeature {
  const graph = requireGraph(sketch), selected = selectedIds(graph.entities, entityIds, 'entity');
  return { ...sketch, graph: parseCadSketchGraph({ ...graph,
    entities: graph.entities.map(entity => selected.has(entity.id) ? { ...entity, construction } : entity)
  }) };
}
