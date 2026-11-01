import type { CadSketchGraph, CadSketchGraphRelation, CadSketchReferenceDimension } from '@/domain/cad/cadSketchGraph';
import { cadSketchReferenceDimensionToDriving, resolveCadSketchReferenceDimension } from '@/domain/cad/cadSketchReferenceDimensions';
import { cadSketchOwnedGeometryLockReason } from '@/domain/cad/cadSketchOwnedGeometry';
import { cadSketchExternalReferenceLockReason } from '@/domain/cad/cadSketchExternalReferences';
import { resolveCadSketchPointIdentities } from '@/domain/cad/cadSketchGraphJoints';
import { withCadSketchCarriedPlacement } from '@/domain/cad/cadSketchPlacedDimensions';
import { cadSketchAxisNormal, isCadSketchVirtualAxisId } from '@/domain/cad/sketch-relations/cadSketchVirtualElements';

type Measurement = CadSketchReferenceDimension['measurement'];
/** Both relations name the same two points, in either order. */
export const cadSketchRelationHasPointPair = (relation: CadSketchGraphRelation, pointIds: readonly [string, string]) => 'pointIds' in relation
  && relation.pointIds.includes(pointIds[0]) && relation.pointIds.includes(pointIds[1]);
// Dimension lookups compare canonical point identities: a coincident alias shares the position, so its dimension already drives this one.
export const cadSketchSameIdentityPair = (identity: (pointId: string) => string, pointIds: readonly [string, string], pair: readonly [string, string]) => {
  const [a, b] = pointIds.map(identity), [c, d] = pair.map(identity);
  return a === c && b === d || a === d && b === c;
};
/** The driving distance, or the horizontal or vertical distance, between two points or their coincident aliases. */
export const cadSketchDistanceForPair = (graph: CadSketchGraph, pointIds: readonly [string, string], axis?: 'x' | 'y') => {
  const identity = resolveCadSketchPointIdentities(graph);
  return graph.relations.find((relation): relation is Extract<CadSketchGraphRelation, { kind: 'distance' | 'axis-distance' }> =>
    (relation.kind === 'distance' && axis === undefined || relation.kind === 'axis-distance' && relation.axis === axis) && cadSketchSameIdentityPair(identity, relation.pointIds, pointIds));
};
/** The driving distance between a point, or one of its coincident aliases, and a line. */
export const cadSketchPointLineDistanceFor = (graph: CadSketchGraph, operands: { readonly pointId: string; readonly lineId: string }) => {
  const identity = resolveCadSketchPointIdentities(graph), point = identity(operands.pointId);
  return graph.relations.find((relation): relation is Extract<CadSketchGraphRelation, { kind: 'point-line-distance' }> =>
    relation.kind === 'point-line-distance' && relation.lineId === operands.lineId && identity(relation.pointId) === point);
};
/**
 * The line a distance from an axis measures: one that its point ends, kept along that axis by Horizontal or Vertical, as the Dimension tool
 * places it for a line. A point that ends no such line is measured itself. `identity` lets one caller resolve the graph's joins once.
 */
export function cadSketchAxisDistanceLine(graph: CadSketchGraph, relation: Extract<CadSketchGraphRelation, { kind: 'fixed-axis' }>, identity?: (pointId: string) => string) {
  try {
    const of = identity ?? resolveCadSketchPointIdentities(graph), own = of(relation.pointId), along = relation.axis === 'y' ? 'horizontal' : 'vertical';
    return graph.entities.find((entity): entity is Extract<CadSketchGraph['entities'][number], { kind: 'line' }> => entity.kind === 'line'
      && (of(entity.startPointId) === own || of(entity.endPointId) === own)
      && graph.relations.some(item => item.kind === along && cadSketchSameIdentityPair(of, item.pointIds, [entity.startPointId, entity.endPointId]))) ?? null;
  } catch { return null; }
}
/** The radius, diameter or fillet that already drives a curve. */
export const cadSketchRadialRelationForEntity = (graph: CadSketchGraph, entityId: string) => graph.relations.find(relation => relation.kind === 'radial-size' && relation.entityId === entityId
  || relation.kind === 'fillet-corner' && relation.arcId === entityId);
/** The dimension that drives exactly this measurement; a fillet's own radius stays with its corner. */
export function cadSketchDrivingDimensionFor(graph: CadSketchGraph, measurement: Measurement) {
  if (measurement.kind === 'point-line-distance') return cadSketchPointLineDistanceFor(graph, measurement);
  if (measurement.kind === 'radial-size') return graph.relations.find((relation): relation is Extract<CadSketchGraphRelation, { kind: 'radial-size' }> =>
    relation.kind === 'radial-size' && relation.entityId === measurement.entityId);
  const line = measurement.kind === 'line-length' ? graph.entities.find(entity => entity.id === measurement.entityId) : null;
  const pair = measurement.kind === 'point-distance' ? measurement.pointIds : line?.kind === 'line' ? [line.startPointId, line.endPointId] as const : null;
  return pair ? cadSketchDistanceForPair(graph, pair) : undefined;
}
const sameMeasurement = (a: Measurement, b: Measurement) => a.kind === 'point-distance' ? b.kind === 'point-distance' && a.pointIds.every(id => b.pointIds.includes(id))
  : a.kind === 'point-line-distance' ? b.kind === 'point-line-distance' && a.pointId === b.pointId && a.lineId === b.lineId
  : (b.kind === 'line-length' || b.kind === 'radial-size') && a.kind === b.kind && a.entityId === b.entityId
    && (a.kind !== 'radial-size' || b.kind === 'radial-size' && a.quantity === b.quantity);
export function cadSketchMatchingReference(graph: CadSketchGraph, measurement: Measurement) {
  return graph.relations.find((r): r is CadSketchReferenceDimension => r.kind === 'reference-dimension' && sameMeasurement(r.measurement, measurement));
}
/** Why a reference dimension cannot become driving, or null when it can. */
export function cadSketchReferenceDrivingLock(graph: CadSketchGraph, relation: CadSketchReferenceDimension): string | null {
  const target = resolveCadSketchReferenceDimension(graph, relation);
  const selections = target.kind === 'distance' ? target.pointIds.map(id => ({kind:'point' as const,id}))
    : target.kind === 'point-line-distance' ? [{kind:'point' as const,id:target.pointId}, {kind:'entity' as const,id:target.lineId}] : [{kind:'entity' as const,id:target.entityId}];
  const owned = selections.map(atom => cadSketchOwnedGeometryLockReason(graph,atom)).find(Boolean); if (owned) return owned;
  if (target.kind === 'point-line-distance') {
    // A distance from an axis is stored as the coordinate it holds, so a hold on that coordinate already drives it.
    const identity = resolveCadSketchPointIdentities(graph), lineId = target.lineId, point = identity(target.pointId);
    const held = isCadSketchVirtualAxisId(lineId) && graph.relations.some(item => item.kind === 'fixed-axis' && item.axis === cadSketchAxisNormal(lineId) && identity(item.pointId) === point);
    if (held || cadSketchPointLineDistanceFor(graph, target)) return 'An existing dimension already drives this distance. Edit that dimension instead.';
  } else if (target.kind === 'distance') {
    const linked = relation.measurement.kind === 'line-length' ? cadSketchExternalReferenceLockReason(graph, {kind:'entity',id:relation.measurement.entityId}) : null;
    if (linked) return linked;
    if (cadSketchDistanceForPair(graph, target.pointIds)) return 'An existing dimension already drives this distance. Edit that dimension instead.';
  } else {
    const linked = cadSketchExternalReferenceLockReason(graph, { kind:'entity', id:target.entityId });
    if (linked) return linked;
    if (cadSketchRadialRelationForEntity(graph, target.entityId)) return 'An existing dimension already drives this curve. Edit that dimension instead.';
    const entity = graph.entities.find(e => e.id === target.entityId);
    if (entity?.kind === 'circle' && typeof entity.radius === 'string') return 'The circle radius is driven by its source expression. Edit that expression instead.';
  }
  return null;
}

/** One dimension command for the canvas menu: the relation to set, or why the command does not apply. */
export type CadSketchDimensionConversion = { readonly relation: CadSketchGraphRelation; readonly reason: null } | { readonly relation: null; readonly reason: string };
const unavailable = (reason: string): CadSketchDimensionConversion => ({ relation: null, reason });
/** Why a distance from the origin or an axis takes no reference form, when placed and once placed. */
export const CAD_SKETCH_NO_REFERENCE_HOLD = 'A distance from the origin or an axis has no reference form yet.';

/** A driving length, distance, point to line distance, radius or diameter becomes a reference that measures the same thing and keeps its identity and placement. */
export function cadSketchDimensionToReference(graph: CadSketchGraph, relation: CadSketchGraphRelation): CadSketchDimensionConversion {
  if (relation.kind === 'reference-dimension') return unavailable('This is already a reference dimension.');
  if (relation.kind === 'fillet-corner' || relation.kind === 'chamfer-corner') return unavailable('A corner treatment owns its fillet or chamfer size. Edit the corner instead.');
  if (relation.kind === 'fixed-axis') return unavailable(CAD_SKETCH_NO_REFERENCE_HOLD);
  if (relation.kind !== 'distance' && relation.kind !== 'point-line-distance' && relation.kind !== 'radial-size') return unavailable('Reference dimensions measure lengths, point distances, point to line distances, radii and diameters.');
  const line = relation.kind === 'distance' && graph.entities.find(entity => entity.kind === 'line' && cadSketchRelationHasPointPair(relation, [entity.startPointId, entity.endPointId]));
  const measurement: Measurement = relation.kind === 'radial-size' ? { kind: 'radial-size', entityId: relation.entityId, quantity: relation.quantity }
    : relation.kind === 'point-line-distance' ? { kind: 'point-line-distance', pointId: relation.pointId, lineId: relation.lineId }
    : line ? { kind: 'line-length', entityId: line.id } : { kind: 'point-distance', pointIds: relation.pointIds };
  if (cadSketchMatchingReference(graph, measurement)) return unavailable('A reference dimension already measures this. Delete this dimension instead.');
  return { relation: withCadSketchCarriedPlacement(graph, relation, { id: relation.id, kind: 'reference-dimension', measurement }), reason: null };
}
/** A reference becomes the driving dimension it measures, at its current value and where it is placed. */
export function cadSketchDimensionToDriving(graph: CadSketchGraph, parameters: Readonly<Record<string, number>>, relation: CadSketchGraphRelation): CadSketchDimensionConversion {
  if (relation.kind !== 'reference-dimension') return unavailable('This dimension already drives the geometry.');
  try {
    const lock = cadSketchReferenceDrivingLock(graph, relation);
    return lock ? unavailable(lock) : { relation: withCadSketchCarriedPlacement(graph, relation, cadSketchReferenceDimensionToDriving(graph, parameters, relation)), reason: null };
  } catch { return unavailable('The measured geometry is no longer available.'); }
}
