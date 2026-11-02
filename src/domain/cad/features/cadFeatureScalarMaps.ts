import type { CadPoint3 } from '../cadDocument';
import { CAD_SKETCH_GENERATOR_QUANTITIES, cadQuantitiesUnder, mapCadPoint2 } from '../cadProfileScalars';
import { cadSketchGeneratedComponents } from '../sketch-generators/cadSketchGenerators';
import type { CadEdgePredicate, CadEdgeSelection, CadFaceQuery, CadFacePredicate } from '../cadTopology';
import type { CadSketchGraph } from '../cadSketchGraph';
import { mapCadSketchRelationScalars } from '../cadSketchGraphReferences';
import { CAD_SKETCH_RELATION_DEFINITIONS } from '../sketch-relations/cadSketchRelationRegistry';
import type { CadFeatureNestedQuantity, CadFeatureQuantityPath, CadScalarMapper } from './cadFeatureDefinitionTypes';

export { CAD_PATH_SEGMENT_QUANTITIES, CAD_PROFILE_QUANTITIES, cadQuantitiesUnder, mapCadPathSegment, mapCadPathSegments, mapCadPoint2, mapCadProfileScalars } from '../cadProfileScalars';

// Each maps the dimension-bearing scalars of one stored value, naming each by its path below `path`. Ids, source text and pinned
// packages are left exact.

export function mapCadPoint3(point: CadPoint3, path: string, map: CadScalarMapper): CadPoint3 { return [map(point[0], `${path}.0`), map(point[1], `${path}.1`), map(point[2], `${path}.2`)]; }
/**
 * A sketch graph's point positions, circle radii and relation values, under `graph`, a generator's inputs among them. What generators
 * made follows their inputs, so it is left as it is; it comes after everything stored, so stored items have the same paths with or
 * without it.
 */
export function mapCadSketchGraphScalars(graph: CadSketchGraph, path: string, map: CadScalarMapper): CadSketchGraph {
  const generated = cadSketchGeneratedComponents(graph);
  return { ...graph,
    points: graph.points.map((point, index) => generated.pointIds.has(point.id) ? point : { ...point, position: mapCadPoint2(point.position, `${path}.points.${index}.position`, map) }),
    entities: graph.entities.map((entity, index) => entity.kind === 'circle' && !generated.entityIds.has(entity.id) ? { ...entity, radius: map(entity.radius, `${path}.entities.${index}.radius`) } : entity),
    relations: graph.relations.map((relation, index) => generated.relationIds.has(relation.id) ? relation : mapCadSketchRelationScalars(relation, (value, key) => map(value, `${path}.relations.${index}.${key}`)))
  };
}
function mapEdgePredicate(predicate: CadEdgePredicate, path: string, map: CadScalarMapper): CadEdgePredicate {
  switch (predicate.kind) {
    case 'length': return { ...predicate, value: map(predicate.value, `${path}.value`) };
    case 'on-plane': return { ...predicate, offset: map(predicate.offset, `${path}.offset`) };
    case 'line-endpoints': return { ...predicate, start: mapCadPoint3(predicate.start, `${path}.start`, map), end: mapCadPoint3(predicate.end, `${path}.end`, map) };
    case 'arc-points': return { ...predicate, start: mapCadPoint3(predicate.start, `${path}.start`, map), end: mapCadPoint3(predicate.end, `${path}.end`, map), midpoint: mapCadPoint3(predicate.midpoint, `${path}.midpoint`, map) };
    case 'circle': return { ...predicate, center: mapCadPoint3(predicate.center, `${path}.center`, map), radius: map(predicate.radius, `${path}.radius`) };
    case 'parallel': case 'curve-type': return predicate;
    default: { const exhaustive: never = predicate; return exhaustive; }
  }
}
function mapFacePredicate(predicate: CadFacePredicate, path: string, map: CadScalarMapper): CadFacePredicate {
  switch (predicate.kind) {
    case 'plane': return { ...predicate, offset: map(predicate.offset, `${path}.offset`) };
    case 'centroid': return { ...predicate, point: mapCadPoint3(predicate.point, `${path}.point`, map) };
    case 'cylinder': return { ...predicate, origin: mapCadPoint3(predicate.origin, `${path}.origin`, map), radius: map(predicate.radius, `${path}.radius`) };
    case 'area': case 'surface-type': return predicate;
    default: { const exhaustive: never = predicate; return exhaustive; }
  }
}
/** An edge selection's query values. */
export function mapCadEdgeSelectionScalars(selection: CadEdgeSelection, path: string, map: CadScalarMapper): CadEdgeSelection {
  return { ...selection, queries: selection.queries.map((query, index) => ({ ...query,
    predicates: query.predicates.map((predicate, predicateIndex) => mapEdgePredicate(predicate, `${path}.queries.${index}.predicates.${predicateIndex}`, map)) })) };
}
/** A face query's predicate values. */
export function mapCadFaceQueryScalars(query: CadFaceQuery, path: string, map: CadScalarMapper): CadFaceQuery {
  return { ...query, predicates: query.predicates.map((predicate, index) => mapFacePredicate(predicate, `${path}.predicates.${index}`, map)) };
}

const each = (quantity: CadFeatureNestedQuantity, ...paths: readonly string[]) => paths.map(path => ({ path, quantity }));
// What each number of those stored values measures, by its path below the value (see CadFeatureQuantityPath). Each maps the scalars
// above, and also names the plain numbers a value holds: directions, areas, counts, places in a list and dimension placements.

/**
 * A sketch graph's point positions, circle radii and relation values, each relation's as its definition declares, a linear pattern's
 * count and omitted instances, and where each dimension is drawn: offsets, radii and distances, fractions along, and a leader's
 * direction in radians.
 */
export function cadSketchGraphQuantities(): readonly CadFeatureQuantityPath[] {
  return [...each('length', 'points.*.position.*', 'entities.*{circle}.radius'),
    ...Object.values(CAD_SKETCH_RELATION_DEFINITIONS).flatMap(({ kind, scalars }) =>
      scalars ? scalars.keys.map(key => ({ path: `relations.*{${kind}}.${key}`, quantity: scalars.quantity[key] })) : []),
    ...each('count', 'relations.*{linear-pattern}.count'), ...each('index', 'relations.*{linear-pattern}.omittedInstances.*'),
    ...cadQuantitiesUnder('relations.*{generator}.geometry', CAD_SKETCH_GENERATOR_QUANTITIES),
    ...each('length', 'relations.*.annotation{linear}.offset', 'relations.*.annotation{angle}.radius', 'relations.*.annotation{radial}.distance',
      'relations.*.annotation{setbacks}.sides.*.offset'),
    ...each('ratio', 'relations.*.annotation{linear}.along', 'relations.*.annotation{angle}.along', 'relations.*.annotation{setbacks}.sides.*.along'),
    ...each('radians', 'relations.*.annotation{radial}.angle')];
}
/** An edge selection: its queries' predicates, a direction's components, and the edges each query and the selection expect. */
export const CAD_EDGE_SELECTION_QUANTITIES: readonly CadFeatureQuantityPath[] = [
  ...cadQuantitiesUnder('queries.*.predicates.*', [
    ...each('length', '{length}.value', '{on-plane}.offset', '{line-endpoints}.start.*', '{line-endpoints}.end.*', '{circle}.center.*', '{circle}.radius',
      '{arc-points}.start.*', '{arc-points}.end.*', '{arc-points}.midpoint.*'),
    ...each('ratio', '{on-plane}.normal.*', '{parallel}.direction.*', '{circle}.axis.*')]),
  ...each('count', 'queries.*.expectedCount', 'expectedCount')];
/** A face query: its predicates, a direction's components, and the faces it expects. */
export const CAD_FACE_QUERY_QUANTITIES: readonly CadFeatureQuantityPath[] = [
  ...cadQuantitiesUnder('predicates.*', [
    ...each('length', '{plane}.offset', '{centroid}.point.*', '{cylinder}.origin.*', '{cylinder}.radius'), ...each('area', '{area}.value'),
    ...each('ratio', '{plane}.normal.*', '{cylinder}.axis.*')]),
  ...each('count', 'expectedCount')];
