import { Type, type Static } from '@sinclair/typebox';
import { cadFeatureActive } from './features/cadFeatureActivity';
import { Value } from '@sinclair/typebox/value';
import type { CadSketchFeature } from './cadDocument';
import { CadIdentifierSchema, CadScalarSchema } from './cadPrimitives';
import { cadPathClosureTolerance, type ResolvedCadPathSegment } from './cadAnalyticSegments';
import { CadError } from './cadError';
import { isCadImportData } from './cadImportData';
import { evaluateCadScalar } from './cadExpression';
import { cadProfileToEntities, resolveCadSketchContours } from './cadSketchGeometry';
import { appendCadSketchCopiedRelations, appendCadSketchEntities } from './cadSketchGraphEdits';
import { checkCadSketchGraph, parseCadSketchGraph, type CadSketchGraphEntity } from './cadSketchGraph';
import { compileCadSketchGraph } from './cadSketchGraphGeometry';
import { createArcSegment, createCircleSegment, createLineSegment, cross } from '@/domain/path-intel/segments';
import { signedDxfArcSweepRadians } from '@/domain/dxf/arcSweep';
import type { DxfEntity } from '@/domain/dxf/types';
import type { ArcPathSegment, LinePathSegment, PathSegment, Point2 } from '@/domain/path-intel/types';
import { deepFreezeCadData } from './cadDeepFreeze';
import { CAD_PRECISION, cadRoundoff } from '@/domain/precision/cadPrecision';
import type { CadSketchRelationCopy, CadSketchRemapPiece } from './sketch-relations/cadSketchRelationRemap';

const strict = { additionalProperties: false };
export const CadSketchOffsetSourceSchema = Type.Union([
  Type.Object({ kind: Type.Literal('profile'), profileId: CadIdentifierSchema }, strict),
  Type.Object({ kind: Type.Literal('graph-cycle'), sourceRefs: Type.Array(Type.Object({ entityId: CadIdentifierSchema, reversed: Type.Boolean() }, strict), { minItems: 1 }) }, strict)
]);
export const CadSketchOffsetRequestSchema = Type.Object({ source: CadSketchOffsetSourceSchema, distance: CadScalarSchema,
  idPrefix: Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' }),
  /** Also carry the relations internal to a graph loop that an offset keeps exact onto the copy. */
  copyRelations: Type.Optional(Type.Boolean()) }, strict);
type Immutable<T> = { readonly [K in keyof T]: Immutable<T[K]> };
export type CadSketchOffsetSource = Immutable<Static<typeof CadSketchOffsetSourceSchema>>;
export type CadSketchOffsetRequest = Immutable<Static<typeof CadSketchOffsetRequestSchema>>;
export interface CadSketchOffsetPreparation {
  readonly sketch: CadSketchFeature;
  readonly sourceSegments: readonly ResolvedCadPathSegment[];
  readonly resultSegments: readonly ResolvedCadPathSegment[];
  readonly distanceMm: number;
}

type Edge = LinePathSegment | ArcPathSegment;
const fail = (message: string): never => { throw new CadError('unsupported-sketch-offset', message); };
const position = (point: Point2): readonly [number, number] => [point.x, point.y];
function pathSegment(segment: PathSegment): ResolvedCadPathSegment {
  return segment.kind === 'line' ? { kind: 'line', start: position(segment.start), end: position(segment.end) }
    : { kind: 'arc', center: position(segment.center), radius: segment.radius,
      startAngle: segment.kind === 'circle' ? 0 : segment.startAngleRadians * 180 / Math.PI,
      sweep: segment.kind === 'circle' ? 360 : segment.sweepRadians * 180 / Math.PI };
}
function analyticSegment(entity: DxfEntity, index: number, authoredSweep?: number): PathSegment {
  const common = { id: `offset_${index}`, source: { sourceEntityIndex: index, sourceEntityType: entity.type, layer: null, exact: true } };
  if (entity.type === 'line') return createLineSegment({ ...common, start: entity.start, end: entity.end });
  if (entity.type === 'circle') return createCircleSegment({ ...common, center: entity.center, radius: entity.radius });
  if (entity.type !== 'arc') return fail('Offset requires exact lines, circular arcs or a circle.');
  const sweep = authoredSweep ?? entity.sweepRadians ?? signedDxfArcSweepRadians(entity.startAngle * 180 / Math.PI, entity.endAngle * 180 / Math.PI, entity.clockwise);
  if (sweep === null || sweep === 0) return fail('Offset needs a finite signed circular sweep.');
  const at = (angle: number) => ({ x: entity.center.x + entity.radius * Math.cos(angle), y: entity.center.y + entity.radius * Math.sin(angle) });
  return createArcSegment({ ...common, center: entity.center, radius: entity.radius, start: entity.start ?? at(entity.startAngle),
    end: entity.end ?? at(entity.startAngle + sweep), sweepRadians: sweep, clockwise: sweep < 0 });
}
function supports(edge: Edge): readonly Point2[] { return edge.kind === 'arc' ? [edge.start, edge.end, edge.center] : [edge.start, edge.end]; }
function tangent(edge: Edge, end = false): Point2 {
  if (edge.kind === 'line') return { x: (edge.end.x - edge.start.x) / edge.length, y: (edge.end.y - edge.start.y) / edge.length };
  const point = end ? edge.end : edge.start, x = point.x - edge.center.x, y = point.y - edge.center.y, length = Math.hypot(x, y), sign = edge.clockwise ? -1 : 1;
  return { x: -sign * y / length, y: sign * x / length };
}
function shifted(point: Point2, direction: Point2, distance: number): Point2 {
  return { x: point.x + direction.y * distance, y: point.y - direction.x * distance };
}
function checkPoint(point: Point2): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > 1e9 || Math.abs(point.y) > 1e9)
    fail('The offset cannot be represented within the supported coordinate range.');
}
function targetRadius(radius: number, distance: number): number {
  const result = radius + distance;
  if (result <= CAD_PRECISION.minimumLengthMm || result > CAD_PRECISION.modelExtentMm || !Number.isFinite(result)) return fail('The offset collapses a circular support or exceeds the supported radius.');
  if (result === radius) return fail('The nonzero offset is too small to represent at this radius.');
  return result;
}
function joint(previous: Edge, current: Edge, distance: number): Point2 {
  const a = tangent(previous, true), b = tangent(current), determinant = cross(a, b), dot = a.x * b.x + a.y * b.y;
  const rounding = cadPathClosureTolerance([...supports(previous), ...supports(current)]);
  if (previous.kind !== 'line' || current.kind !== 'line') {
    if (dot <= 0 || Math.abs(determinant) > CAD_PRECISION.angularAccuracyRad || Math.abs(determinant) * Math.max(previous.length, current.length) > rounding)
      return fail('Offset supports smooth circular joints only; sharp line/arc or arc/arc corners need an explicit join policy.');
    return shifted(previous.end, a, distance);
  }
  const first = shifted(previous.end, a, distance), second = shifted(current.start, b, distance);
  if (Math.abs(determinant) <= cadRoundoff(32)) {
    if (dot <= 0) return fail('Offset cannot choose an overlapping or reversing line joint.');
    return first;
  }
  const delta = { x: second.x - first.x, y: second.y - first.y }, along = cross(delta, b) / determinant;
  return { x: first.x + along * a.x, y: first.y + along * a.y };
}
function checkOffsetEdge(source: Edge, result: Edge, distance: number): void {
  const rounding = cadPathClosureTolerance([...supports(source), ...supports(result)]);
  if (result.length <= CAD_PRECISION.minimumLengthMm) return fail('The offset collapses an edge.');
  if (source.kind === 'line' && result.kind === 'line') {
    const a = tangent(source), b = tangent(result), q = Math.abs(cross(a, b));
    if (a.x * b.x + a.y * b.y <= 0 || q > CAD_PRECISION.angularAccuracyRad || q * Math.max(source.length, result.length) > rounding)
      return fail('The offset cannot preserve the line direction and corner branch.');
    for (const point of [result.start, result.end]) {
      const normalDistance = a.y * (point.x - source.start.x) - a.x * (point.y - source.start.y);
      if (Math.abs(normalDistance - distance) > rounding) return fail('The offset line does not preserve the requested support distance.');
    }
    if (distance !== 0 && result.start.x === source.start.x && result.start.y === source.start.y && result.end.x === source.end.x && result.end.y === source.end.y)
      return fail('The nonzero offset is too small to represent on this line.');
  } else if (source.kind === 'arc' && result.kind === 'arc') {
    const radius = targetRadius(source.radius, (source.clockwise ? -1 : 1) * distance), angleError = Math.abs(source.sweepRadians - result.sweepRadians);
    const sourceSide = Math.sign(Math.abs(source.sweepRadians) - Math.PI);
    // An authored half-turn has no strict major/minor side. Its atan2
    // reconstruction still obeys the unchanged angular and physical gates.
    if (sourceSide !== 0 && sourceSide !== Math.sign(Math.abs(result.sweepRadians) - Math.PI)
      || angleError > CAD_PRECISION.angularAccuracyRad || angleError * Math.max(source.radius, radius) > rounding
      || [result.start, result.end].some(point => Math.abs(Math.hypot(point.x - source.center.x, point.y - source.center.y) - radius) > rounding))
      return fail('The offset cannot preserve the circular support, shared joints and signed arc branch.');
  }
}

/**
 * How an offset copies a graph loop: edge i of the copy runs along source ref i, from vertex i to vertex i + 1, so a reversed ref runs
 * the copy against its source curve. Arc centres and a circle's centre have their own copies.
 */
function offsetCopy(entities: readonly CadSketchGraphEntity[], sourceRefs: readonly { readonly entityId: string; readonly reversed: boolean }[], idPrefix: string): Omit<CadSketchRelationCopy, 'relationId'> {
  const byId = new Map(entities.map(entity => [entity.id, entity])), curves = new Map<string, CadSketchRemapPiece>(), points = new Map<string, string>();
  for (const [index, ref] of sourceRefs.entries()) {
    const entity = byId.get(ref.entityId);
    if (!entity) continue;
    curves.set(entity.id, { entityId: `${idPrefix}_e${index}`, interval: [0, 1], orientation: ref.reversed ? 'reversed' : 'same' });
    if (entity.kind === 'circle') { points.set(entity.centerPointId, `${idPrefix}_c${index}`); continue; }
    const [first, last] = ref.reversed ? [entity.endPointId, entity.startPointId] : [entity.startPointId, entity.endPointId];
    points.set(first, `${idPrefix}_p${index}`); points.set(last, `${idPrefix}_p${(index + 1) % sourceRefs.length}`);
    if (entity.kind === 'arc') points.set(entity.centerPointId, `${idPrefix}_c${index}`);
  }
  return { kind: 'offset', curves, points };
}

/**
 * One exact detached copy. Positive distance is outward, independent of source winding. `copyRelations` carries the relations internal
 * to a graph loop onto the copy by each kind's rule: directions, angles and joints, but no length or radius the offset changes.
 */
export function prepareCadSketchOffset({ sketch, parameters, ...request }: CadSketchOffsetRequest & {
  readonly sketch: CadSketchFeature; readonly parameters: Readonly<Record<string, number>>;
}): CadSketchOffsetPreparation {
  if (!isCadImportData(request) || !Value.Check(CadSketchOffsetRequestSchema, request))
    throw new CadError('invalid-sketch-offset', 'Offset requires one exact loop, a distance and an identifier prefix of at most 64 characters.');
  const copyRelations = request.copyRelations === true;
  if (!cadFeatureActive(sketch, { parameters })) return fail('Resume the sketch before offsetting a loop.');
  const { source, idPrefix } = request, distanceMm = evaluateCadScalar(request.distance, parameters);
  if (source.kind === 'profile') {
    const profile = sketch.profiles.find(profile => profile.id === source.profileId);
    if (!profile || profile.construction || profile.geometry.kind === 'plugin') return fail('Choose a nonconstruction standard profile or an exact graph loop.');
  }
  const contours = resolveCadSketchContours(sketch, parameters);
  const contour = contours.find(contour => source.kind === 'profile' ? contour.profile.id === source.profileId && !contour.profile.graphSourceRefs
    : Value.Equal(contour.profile.graphSourceRefs, source.sourceRefs));
  if (!contour) throw new CadError('stale-sketch-offset-source', 'The selected closed loop changed or is not an eligible simple material outline. Select it again.');
  // Capsule caps are authored half-turns, even if subtracting their generated
  // absolute angles would yield π±ulp. Generic path/graph sweeps stay exact.
  const sourceEdges = cadProfileToEntities(contour.geometry).map((entity, index) => analyticSegment(entity, index,
    contour.geometry.kind === 'slot' && entity.type === 'arc' ? Math.PI : undefined)), sourceSegments = sourceEdges.map(pathSegment);
  deepFreezeCadData(sourceSegments);
  if (distanceMm === 0) return Object.freeze({ sketch, sourceSegments, resultSegments: sourceSegments, distanceMm });
  const points: { id: string; position: readonly [number, number] }[] = [], entities: CadSketchGraphEntity[] = [], resultEdges: PathSegment[] = [];
  const point = (id: string, value: Point2) => { checkPoint(value); points.push({ id, position: position(value) }); return id; };
  if (sourceEdges.length === 1 && sourceEdges[0].kind === 'circle') {
    const sourceCircle = sourceEdges[0], radius = targetRadius(sourceCircle.radius, distanceMm), id = `${idPrefix}_e0`;
    entities.push({ id, kind: 'circle', construction: false, centerPointId: point(`${idPrefix}_c0`, sourceCircle.center), radius });
    resultEdges.push(createCircleSegment({ id, source: sourceCircle.source, center: sourceCircle.center, radius }));
  } else {
    const edges: Edge[] = sourceEdges.map(edge => edge.kind === 'circle' ? fail('A full circle must be a standalone offset source.') : edge);
    const vertices = edges.map((edge, index) => joint(edges[(index + edges.length - 1) % edges.length], edge, distanceMm));
    vertices.forEach((vertex, index) => point(`${idPrefix}_p${index}`, vertex));
    edges.forEach((edge, index) => {
      const start = vertices[index], end = vertices[(index + 1) % vertices.length], id = `${idPrefix}_e${index}`;
      const common = { id, construction: false, startPointId: `${idPrefix}_p${index}`, endPointId: `${idPrefix}_p${(index + 1) % vertices.length}` };
      const result = edge.kind === 'line' ? createLineSegment({ ...edge, id, start, end })
        : createArcSegment({ ...edge, id, start, end, radius: targetRadius(edge.radius, (edge.clockwise ? -1 : 1) * distanceMm), sweepRadians: undefined });
      checkOffsetEdge(edge, result, distanceMm); resultEdges.push(result);
      entities.push(edge.kind === 'line' ? { ...common, kind: 'line' }
        : { ...common, kind: 'arc', centerPointId: point(`${idPrefix}_c${index}`, edge.center), direction: edge.clockwise ? 'cw' : 'ccw' });
    });
  }
  const addition = parseCadSketchGraph({ points, entities, relations: [] }), issue = checkCadSketchGraph(addition, {})[0];
  if (issue) return fail(`The offset does not preserve exact graph geometry: ${issue.message}`);
  const isolated = compileCadSketchGraph(addition, {});
  if (isolated.cycles.length !== 1 || isolated.cycles[0].sourceRefs.length !== entities.length || isolated.arrangementEntityIds.length)
    return fail('The offset crosses, touches or overlaps itself; topology-changing offsets are not supported.');
  const result = appendCadSketchEntities({ sketch: structuredClone(sketch), geometry: addition });
  const compiled = result.graph && compileCadSketchGraph(result.graph, parameters), newIds = new Set(entities.map(entity => entity.id));
  if (compiled?.arrangementEntityIds.some(id => newIds.has(id))) return fail('The offset intersects another graph contour.');
  const combined = resolveCadSketchContours(result, parameters), copy = combined.find(contour => contour.profile.id === `${idPrefix}_e0`);
  if (!copy) return fail('The offset did not produce one complete closed material outline.');
  const containingId = distanceMm < 0 ? contour.profile.id : copy.profile.id;
  let contained = distanceMm < 0 ? copy : combined.find(item => item.profile.id === contour.profile.id);
  let nested = false;
  while (contained?.parentId !== null && contained?.parentId !== undefined) {
    if (contained.parentId === containingId) { nested = true; break; }
    contained = combined.find(item => item.profile.id === contained?.parentId);
  }
  if (!nested) return fail('The offset cannot preserve the requested inside/outside branch.');
  const carried = copyRelations && source.kind === 'graph-cycle' && sketch.graph ? appendCadSketchCopiedRelations(result, sketch.graph, parameters,
    { ...offsetCopy(sketch.graph.entities, source.sourceRefs, idPrefix), relationId: (_relation, index) => `${idPrefix}_r${index}` },
    () => new CadError('unsupported-sketch-offset', 'The offset cannot keep a copied relation exact. Offset it without copying relations.')) : result;
  const preparation = { sketch: carried, sourceSegments, resultSegments: resultEdges.map(pathSegment), distanceMm };
  deepFreezeCadData(preparation);
  return preparation;
}
