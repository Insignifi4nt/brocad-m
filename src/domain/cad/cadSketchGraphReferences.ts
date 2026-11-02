import type { CadScalar } from './cadDocument';
import type { CadSketchGraph, CadSketchGraphEntity, CadSketchGraphRelation } from './cadSketchGraph';
import { CadError } from './cadError';
import { mapCadSketchGeneratorGeometryScalars } from './cadProfileScalars';
import { cadSketchGraphEntity } from './cadSketchGraphLookup';
import { cadSketchRelationDefinition, cadSketchRelationSignature, cadSketchSignatureSlots } from './sketch-relations/cadSketchRelationRegistry';
import { isCadSketchVirtualId } from './sketch-relations/cadSketchVirtualElements';

// The origin and the axes are every sketch's own and never stored, so a relation that names one references only its other operands.
const stored = (ids: readonly string[]) => ids.some(isCadSketchVirtualId) ? ids.filter(id => !isCadSketchVirtualId(id)) : ids;

export function cadSketchEntityPointIds(entity: CadSketchGraphEntity): readonly string[] {
  return entity.kind === 'line' ? [entity.startPointId, entity.endPointId]
    : entity.kind === 'arc' ? [entity.centerPointId, entity.startPointId, entity.endPointId] : [entity.centerPointId];
}
/** The stored edges a relation names, in stored order, then the edges it made and keeps. */
export function cadSketchRelationEntityIds(relation: CadSketchGraphRelation): readonly string[] {
  const definition = cadSketchRelationDefinition(relation), ids = definition.operands(relation), slots = cadSketchSignatureSlots(cadSketchRelationSignature(relation)).entities;
  // Operands that are all edges are the relation's own stored list.
  const named = stored(slots.length === ids.length ? ids : slots.map(index => ids[index])), owned = definition.owns?.(relation).entityIds;
  return owned?.length ? [...named, ...owned] : named;
}
/**
 * The stored points a relation references: its point operands, then the points of every edge it names or keeps, each once. A relation on points
 * alone lists them as they are, so the parse refuses one that names a point twice.
 */
export function cadSketchRelationPointIds(graph: CadSketchGraph, relation: CadSketchGraphRelation): readonly string[] {
  const definition = cadSketchRelationDefinition(relation);
  if (definition.pointIds) return stored(definition.pointIds(graph, relation));
  const ids = definition.operands(relation), slots = cadSketchSignatureSlots(cadSketchRelationSignature(relation)).points, entityIds = cadSketchRelationEntityIds(relation);
  // Operands that are all points are the relation's own stored list.
  if (!entityIds.length) return stored(slots.length === ids.length ? ids : slots.map(index => ids[index]));
  const points = [...stored(slots.map(index => ids[index]))];
  for (const id of entityIds) {
    const entity = cadSketchGraphEntity(graph, id);
    if (!entity) throw new CadError('missing-sketch-entity', `Sketch relation "${relation.id}" references missing entity "${id}".`);
    points.push(...cadSketchEntityPointIds(entity));
  }
  return [...new Set(points)];
}
/**
 * The relation with each driving value mapped, keyed by its path in the relation's data; a relation without one is returned as it is. A
 * generator's inputs are its geometry's, whose keys depend on its shape, so they are mapped by that geometry's paths.
 */
export function mapCadSketchRelationScalars(relation: CadSketchGraphRelation, map: (value: CadScalar, key: string) => CadScalar): CadSketchGraphRelation {
  if (relation.kind === 'generator') return { ...relation, geometry: mapCadSketchGeneratorGeometryScalars(relation.geometry, 'geometry', map) };
  const scalars = cadSketchRelationDefinition(relation).scalars;
  return scalars ? scalars.write(relation, scalars.read(relation).map((value, index) => map(value, scalars.keys[index]))) : relation;
}
