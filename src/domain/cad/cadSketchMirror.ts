import { Type, type Static } from '@sinclair/typebox';
import { cadFeatureActive } from './features/cadFeatureActivity';
import { Value } from '@sinclair/typebox/value';
import type { CadSketchFeature } from './cadDocument';
import { CadIdentifierSchema } from './cadPrimitives';
import { CadError } from './cadError';
import { isCadImportData } from './cadImportData';
import { evaluateCadScalar } from './cadExpression';
import { parseCadSketchGraph, type CadSketchGraphEntity, type CadSketchGraphRelation } from './cadSketchGraph';
import { cadSketchEntityPointIds } from './cadSketchGraphReferences';
import { compileCadSketchGraph } from './cadSketchGraphGeometry';
import { appendCadSketchCopiedRelations, appendCadSketchEntities } from './cadSketchGraphEdits';
import { resolveCadSketchPointIdentities } from './cadSketchGraphJoints';
import { cadPathClosureTolerance } from './cadAnalyticSegments';
import { cadProfileToEntities, resolveCadProfile } from './cadSketchGeometry';
import { classifyPathSegmentIntersection } from '@/domain/path-intel/intersections';
import { createArcSegment, createCircleSegment, createLineSegment, cross, dot } from '@/domain/path-intel/segments';
import type { PathSegment, Point2 } from '@/domain/path-intel/types';
import { deepFreezeCadData } from './cadDeepFreeze';
import { CAD_PRECISION } from '@/domain/precision/cadPrecision';
import { CAD_SKETCH_ELEMENT_ID_PATTERN, CadSketchPositions, cadSketchVirtualAxis } from './sketch-relations/cadSketchVirtualElements';

export const CadSketchMirrorRequestSchema = Type.Object({
  entityIds: Type.Array(CadIdentifierSchema, { minItems: 1, maxItems: 64, uniqueItems: true }),
  /** A graph line, or the H or V axis. */
  axisLineId: Type.String({ pattern: CAD_SKETCH_ELEMENT_ID_PATTERN }),
  idPrefix: Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' }),
  /** Also carry the relations internal to the copied set, and those reaching only the mirror line, onto the copy. */
  copyRelations: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
type Immutable<T> = { readonly [K in keyof T]: Immutable<T[K]> };
export type CadSketchMirrorRequest = Immutable<Static<typeof CadSketchMirrorRequestSchema>>;
export interface CadSketchMirrorPreparation {
  readonly sketch: CadSketchFeature;
  readonly sourceEntityIds: readonly string[];
  readonly resultEntityIds: readonly string[];
}

const precision = () => new CadError('sketch-mirror-precision', 'This mirror cannot keep the geometry exact at these coordinates. Mirror it nearer the origin.');
function legacySegments(sketch: CadSketchFeature, parameters: Readonly<Record<string, number>>): PathSegment[] {
  return sketch.profiles.flatMap((profile, profileIndex) => cadProfileToEntities(resolveCadProfile(profile.geometry, parameters)).map((entity, index) => {
    const common = { id: `profile_${profileIndex}_${index}`, source: { sourceEntityIndex: index, sourceEntityType: entity.type, layer: null, exact: true } };
    if (entity.type === 'line') return createLineSegment({ ...common, start: entity.start, end: entity.end });
    if (entity.type === 'circle') return createCircleSegment({ ...common, center: entity.center, radius: entity.radius });
    if (entity.type === 'arc' && entity.start && entity.end && entity.sweepRadians !== undefined)
      return createArcSegment({ ...common, center: entity.center, radius: entity.radius, start: entity.start, end: entity.end,
        clockwise: entity.sweepRadians < 0, sweepRadians: entity.sweepRadians });
    throw new CadError('invalid-sketch-mirror-source', 'Mirror overlap validation requires exact analytic profile supports.');
  }));
}
function checkOverlaps(copies: readonly PathSegment[], originals: readonly PathSegment[]): void {
  const extent = (segment: PathSegment) => [{ x: segment.bounds.minX, y: segment.bounds.minY }, { x: segment.bounds.maxX, y: segment.bounds.maxY }];
  for (const [index, copy] of copies.entries()) for (const other of [...originals, ...copies.slice(0, index)]) {
    const tolerance = cadPathClosureTolerance([...extent(copy), ...extent(other)]);
    if (classifyPathSegmentIntersection(copy, other, tolerance).kind === 'overlap')
      throw new CadError('overlapping-sketch-mirror', 'The mirrored copy overlaps existing or copied geometry. Choose another source or mirror line.');
  }
}

/**
 * Evaluated independent geometry; only declared internal joints are retained, unless `copyRelations` carries every relation internal to
 * the copied set, and those reaching only the mirror line, onto the copy by each kind's rule.
 */
export function prepareCadSketchMirror({ sketch, parameters, ...request }: CadSketchMirrorRequest & {
  readonly sketch: CadSketchFeature; readonly parameters: Readonly<Record<string, number>>;
}): CadSketchMirrorPreparation {
  if (!isCadImportData(request) || !Value.Check(CadSketchMirrorRequestSchema, request))
    throw new CadError('invalid-sketch-mirror', 'Mirror copy needs distinct graph entities, one line and an identifier prefix of at most 64 characters.');
  const copyRelations = request.copyRelations === true;
  if (!cadFeatureActive(sketch, { parameters }) || !sketch.graph) throw new CadError('invalid-sketch-mirror-source', 'Choose an active entity-based sketch.');
  const graph = parseCadSketchGraph(sketch.graph), sourceEntityIds = [...request.entityIds].sort();
  const byId = new Map(graph.entities.map(entity => [entity.id, entity]));
  const selected = sourceEntityIds.map(id => {
    const entity = byId.get(id);
    if (!entity) throw new CadError('missing-sketch-entity', 'One selected mirror source no longer exists.');
    return entity;
  });
  const axis = byId.get(request.axisLineId) ?? cadSketchVirtualAxis(request.axisLineId);
  if (axis?.kind !== 'line' && axis?.kind !== 'axis' || sourceEntityIds.includes(axis.id))
    throw new CadError('invalid-sketch-mirror-axis', 'Choose a graph line outside the copied set, or the H or V axis.');
  const sourceGeometry = compileCadSketchGraph(graph, parameters);
  const positions = new CadSketchPositions(graph.points.map(point => [point.id, { x: evaluateCadScalar(point.position[0], parameters), y: evaluateCadScalar(point.position[1], parameters) }]));
  const position = (id: string, values: ReadonlyMap<string, Point2> = positions): Point2 => {
    const point = values.get(id);
    if (!point) throw new CadError('missing-sketch-point', 'A mirror support point no longer exists.');
    return point;
  };
  const [first, second] = [axis.startPointId, axis.endPointId].sort(), origin = position(first), finish = position(second);
  const dx = finish.x - origin.x, dy = finish.y - origin.y, length = Math.hypot(dx, dy), normal = { x: -dy / length, y: dx / length };
  const reflect = (point: Point2): Point2 => {
    const offset = 2 * ((point.x - origin.x) * normal.x + (point.y - origin.y) * normal.y);
    const result = { x: point.x - offset * normal.x, y: point.y - offset * normal.y };
    if (!Number.isFinite(result.x) || !Number.isFinite(result.y) || Math.abs(result.x) > 1e9 || Math.abs(result.y) > 1e9)
      throw precision();
    return result;
  };
  const pointIds = [...new Set(selected.flatMap(cadSketchEntityPointIds))].sort(), newIds = new Map(pointIds.map((id, i) => [id, `${request.idPrefix}_p${i}`]));
  const mappedId = (id: string): string => {
    const mapped = newIds.get(id);
    if (!mapped) throw new CadError('missing-sketch-point', 'A copied support point no longer exists.');
    return mapped;
  };
  const reflected = new Map(pointIds.map(id => [id, reflect(position(id))]));
  const points = pointIds.map(id => { const point = position(id, reflected); return { id: mappedId(id), position: [point.x, point.y] }; });
  const entities: CadSketchGraphEntity[] = selected.map((entity, index) => {
    const common = { id: `${request.idPrefix}_e${index}`, construction: entity.construction };
    return entity.kind === 'circle' ? { ...common, kind: 'circle', centerPointId: mappedId(entity.centerPointId), radius: evaluateCadScalar(entity.radius, parameters) }
      : entity.kind === 'line' ? { ...common, kind: 'line', startPointId: mappedId(entity.startPointId), endPointId: mappedId(entity.endPointId) }
        : { ...common, kind: 'arc', centerPointId: mappedId(entity.centerPointId), startPointId: mappedId(entity.startPointId), endPointId: mappedId(entity.endPointId),
          direction: entity.direction === 'cw' ? 'ccw' : 'cw' };
  });
  // Source compilation already validated the complete declared components.
  const joint = resolveCadSketchPointIdentities(graph), groups = new Map<string, string[]>();
  for (const id of pointIds) { const key = joint(id), members = groups.get(key) ?? []; members.push(id); groups.set(key, members); }
  const relations: CadSketchGraphRelation[] = [];
  for (const [, members] of [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    for (const id of members.slice(1)) relations.push({ id: `${request.idPrefix}_j${relations.length}`, kind: 'coincident', pointIds: [mappedId(members[0]), mappedId(id)] });
  }
  const addition = parseCadSketchGraph({ points, entities, relations });
  const copiedGeometry = compileCadSketchGraph(addition, {});
  const vector = (from: string, to: string, values = positions) => ({ x: position(to, values).x - position(from, values).x, y: position(to, values).y - position(from, values).y });
  const checkVector = (from: string, to: string) => {
    const old = vector(from, to), next = vector(from, to, reflected), offset = 2 * dot(old, normal);
    const expected = { x: old.x - offset * normal.x, y: old.y - offset * normal.y };
    if (Math.hypot(next.x - expected.x, next.y - expected.y) > cadPathClosureTolerance([old, next, expected])) throw precision();
  };
  const tangent = { x: dx / length, y: dy / length };
  for (const id of pointIds) {
    const old = position(id), next = position(id, reflected), a = { x: old.x - origin.x, y: old.y - origin.y }, b = { x: next.x - origin.x, y: next.y - origin.y };
    const tolerance = cadPathClosureTolerance([a, b]);
    if (Math.abs(dot(a, normal) + dot(b, normal)) > tolerance || Math.abs(dot(a, tangent) - dot(b, tangent)) > tolerance) throw precision();
    checkVector(pointIds[0], id);
  }
  for (const [index, entity] of selected.entries()) {
    const supports = cadSketchEntityPointIds(entity);
    for (const id of supports) checkVector(supports[0], id); // A distant component cannot license local shape distortion.
    const old = sourceGeometry.segments.find(segment => segment.id === entity.id), next = copiedGeometry.segments.find(segment => segment.id === entities[index].id);
    if (!old || !next || old.kind !== next.kind) throw precision();
    if (entity.kind === 'arc' && old.kind === 'arc' && next.kind === 'arc') {
      const a = vector(entity.centerPointId, entity.startPointId), b = vector(entity.centerPointId, entity.endPointId);
      const c = vector(entity.centerPointId, entity.startPointId, reflected), d = vector(entity.centerPointId, entity.endPointId, reflected);
      const sourceSide = Math.sign(Math.abs(old.sweepRadians) - Math.PI);
      const angleError = Math.abs(old.sweepRadians + next.sweepRadians), tolerance = cadPathClosureTolerance([a, b, c, d]);
      if (angleError > CAD_PRECISION.angularAccuracyRad || angleError * old.radius > tolerance || Math.abs(old.radius - next.radius) > tolerance
        || Math.abs(Math.hypot(b.x, b.y) - Math.hypot(d.x, d.y)) > tolerance
        || sourceSide !== 0 && sourceSide !== Math.sign(Math.abs(next.sweepRadians) - Math.PI)
        || cross(a, b) !== 0 && Math.sign(cross(c, d)) !== -Math.sign(cross(a, b))) throw precision();
    }
  }
  checkOverlaps(copiedGeometry.segments, [...sourceGeometry.segments, ...legacySegments(sketch, parameters)]);
  const appended = appendCadSketchEntities({ sketch: structuredClone(sketch), geometry: addition });
  const result = { sketch: copyRelations ? appendCadSketchCopiedRelations(appended, graph, parameters, { kind: 'mirror',
    curves: new Map(selected.map((entity, index) => [entity.id, { entityId: entities[index].id, interval: [0, 1], orientation: 'same' }])), points: newIds,
    ...(axis.kind === 'axis' ? { axis: axis.id } : { invariant: new Set([axis.id, axis.startPointId, axis.endPointId]) }),
    relationId: (_relation, index) => `${request.idPrefix}_r${index}` }, precision) : appended, sourceEntityIds, resultEntityIds: entities.map(entity => entity.id) };
  if (result.sketch.graph) compileCadSketchGraph(result.sketch.graph, parameters);
  deepFreezeCadData(result); return result;
}
