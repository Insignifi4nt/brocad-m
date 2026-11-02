import type { CadSketchFeature } from './cadDocument';
import { CadError } from './cadError';
import { checkCadSketchGraph, parseCadSketchGraph, type CadSketchGraph } from './cadSketchGraph';
import { cadSketchEntityPointIds, cadSketchRelationEntityIds, cadSketchRelationPointIds } from './cadSketchGraphReferences';
import { cadSketchLinearPatternForSelection } from './cadSketchLinearPattern';
import { copiedCadSketchRelations, copyCadSketchRelations, type CadSketchRelationCopy } from './sketch-relations/cadSketchRelationRemap';

/** Structural intent only. The shared preparation stage solves before complete-part acceptance. */
export function appendCadSketchEntities({ sketch, geometry }: { sketch: CadSketchFeature; geometry: CadSketchGraph }): CadSketchFeature {
  if (geometry.relations.some(relation => relation.kind === 'linear-pattern')) throw new CadError('invalid-sketch-pattern', 'Create a linear pattern with its set-relation operation.');
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
  const remove = (id: string, selected: Set<string>) => {
    if (!cascade && !selected.has(id)) throw new CadError('dependent-sketch-element', `Sketch element "${id}" depends on selected geometry. Select it explicitly or use cascade deletion.`);
    selected.add(id);
  };
  for (const entity of graph.entities) if (cadSketchEntityPointIds(entity).some(id => points.has(id))) remove(entity.id, entities);
  for (const relation of graph.relations) if (cadSketchRelationPointIds(graph, relation).some(id => points.has(id))
      || cadSketchRelationEntityIds(relation).some(id => entities.has(id))) remove(relation.id, relations);
  return { ...sketch, graph: parseCadSketchGraph({
    points: graph.points.filter(point => !points.has(point.id)),
    entities: graph.entities.filter(entity => !entities.has(entity.id)),
    relations: graph.relations.filter(relation => !relations.has(relation.id))
  }) };
}

export function setCadSketchConstruction({ sketch, entityIds, construction }: {
  sketch: CadSketchFeature; entityIds: readonly string[]; construction: boolean;
}): CadSketchFeature {
  const graph = requireGraph(sketch), selected = selectedIds(graph.entities, entityIds, 'entity');
  return { ...sketch, graph: parseCadSketchGraph({ ...graph,
    entities: graph.entities.map(entity => selected.has(entity.id) ? { ...entity, construction } : entity)
  }) };
}
