import { Type, type Static } from '@sinclair/typebox';
import { cadFeatureActive } from './features/cadFeatureActivity';
import { Value } from '@sinclair/typebox/value';
import type { CadSketchFeature } from './cadDocument';
import { CadIdentifierSchema, CadLabelSchema, CadNumberSchema, CadSketchPlaneSchema } from './cadPrimitives';
import { cadPathClosureTolerance, type ResolvedCadPathSegment } from './cadAnalyticSegments';
import { CadError } from './cadError';
import { isCadImportData } from './cadImportData';
import { evaluateCadScalar } from './cadExpression';
import { cadAnalyticPathMetrics, cadProfileToEntities, resolveCadSketchContours } from './cadSketchGeometry';
import { parseCadSketchGraph, type CadSketchGraphEntity } from './cadSketchGraph';
import { compileCadSketchGraph } from './cadSketchGraphGeometry';
import { createArcSegment, createCircleSegment, createLineSegment } from '@/domain/path-intel/segments';
import type { PathSegment, Point2 } from '@/domain/path-intel/types';
import { deepFreezeCadData } from './cadDeepFreeze';
import { CAD_PRECISION } from '@/domain/precision/cadPrecision';
import { cadSketchProfileViews } from './sketch-generators/cadSketchProfileViews';

export const CadSketchProfileCopyRequestSchema = Type.Object({
  sourceSketchId: CadIdentifierSchema, profileId: CadIdentifierSchema, newSketchId: CadIdentifierSchema,
  name: CadLabelSchema, idPrefix: Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' })
}, { additionalProperties: false });
type Immutable<T> = { readonly [K in keyof T]: Immutable<T[K]> };
export type CadSketchProfileCopyRequest = Immutable<Static<typeof CadSketchProfileCopyRequestSchema>>;
export interface CadSketchProfileCopyPreparation {
  readonly sketch: CadSketchFeature;
  readonly sourceSegments: readonly ResolvedCadPathSegment[];
  readonly resultEntityIds: readonly string[];
}

const invalid = (message: string): never => { throw new CadError('invalid-sketch-profile-copy', message); };
const precision = (): never => { throw new CadError('sketch-profile-copy-precision', 'The copy cannot keep this shape exact at these coordinates. Place it nearer the origin.'); };
const position = (point: Point2): readonly [number, number] => [point.x, point.y];
function pathSegment(segment: PathSegment): ResolvedCadPathSegment {
  return segment.kind === 'line' ? { kind: 'line', start: position(segment.start), end: position(segment.end) }
    : { kind: 'arc', center: position(segment.center), radius: segment.radius,
      startAngle: segment.kind === 'circle' ? 0 : segment.startAngleRadians * 180 / Math.PI,
      sweep: segment.kind === 'circle' ? 360 : segment.sweepRadians * 180 / Math.PI };
}
function checkSupport(source: PathSegment, result: PathSegment): void {
  if (source.kind !== result.kind) return precision();
  const operands = [source.start, source.end, result.start, result.end];
  if (source.kind !== 'line') operands.push(source.center);
  const tolerance = cadPathClosureTolerance(operands);
  if (Math.hypot(source.start.x - result.start.x, source.start.y - result.start.y) > tolerance
    || Math.hypot(source.end.x - result.end.x, source.end.y - result.end.y) > tolerance) return precision();
  if (source.kind === 'line' && result.kind === 'line') {
    const a = { x: source.end.x - source.start.x, y: source.end.y - source.start.y };
    const b = { x: result.end.x - result.start.x, y: result.end.y - result.start.y };
    const q = Math.abs((a.x / source.length) * (b.y / result.length) - (a.y / source.length) * (b.x / result.length));
    if (q > CAD_PRECISION.angularAccuracyRad || q * Math.max(source.length, result.length) > tolerance || a.x * b.x + a.y * b.y <= 0) return precision();
  } else if (source.kind !== 'line' && result.kind !== 'line') {
    if (source.center.x !== result.center.x || source.center.y !== result.center.y || Math.abs(source.radius - result.radius) > tolerance) return precision();
    if (source.kind === 'arc' && result.kind === 'arc') {
      const error = Math.abs(source.sweepRadians - result.sweepRadians), side = Math.sign(Math.abs(source.sweepRadians) - Math.PI);
      const cross = (edge: typeof source) => (edge.start.x - edge.center.x) * (edge.end.y - edge.center.y) - (edge.start.y - edge.center.y) * (edge.end.x - edge.center.x);
      // Exact authored half-turns have no strict minor/major side. No near-π classification.
      if (error > CAD_PRECISION.angularAccuracyRad || error * source.radius > tolerance || Math.sign(source.sweepRadians) !== Math.sign(result.sweepRadians)
        || side !== 0 && (side !== Math.sign(Math.abs(result.sweepRadians) - Math.PI) || cross(source) !== 0 && Math.sign(cross(source)) !== Math.sign(cross(result)))
        || [result.start, result.end].some(point => Math.abs(Math.hypot(point.x - source.center.x, point.y - source.center.y) - source.radius) > tolerance)) return precision();
    }
  }
}

/** One evaluated outline in a new graph sketch, retaining only its placement dependency. */
export function prepareCadSketchProfileCopy({ sketch, parameters, ...request }: CadSketchProfileCopyRequest & {
  readonly sketch: CadSketchFeature; readonly parameters: Readonly<Record<string, number>>;
}): CadSketchProfileCopyPreparation {
  if (!isCadImportData(request) || !Value.Check(CadSketchProfileCopyRequestSchema, request))
    return invalid('Copy requires a source profile, a new sketch identity and name, and an identifier prefix of at most 64 characters.');
  if (sketch.kind !== 'sketch' || sketch.id !== request.sourceSketchId || !cadFeatureActive(sketch, { parameters }) || request.newSketchId === sketch.id)
    return invalid('Choose an active source sketch and a distinct new sketch identity.');
  // A generated outline is copied as the shape its generator makes, as a legacy profile is.
  const profiles = cadSketchProfileViews(sketch).filter(profile => profile.id === request.profileId), profile = profiles[0];
  if (profiles.length !== 1 || !profile) return invalid('The selected source profile no longer exists uniquely. Select it again.');
  const offset = evaluateCadScalar(sketch.offset, parameters);
  if (!isCadImportData(sketch.plane) || !Value.Check(CadSketchPlaneSchema, sketch.plane) || !Value.Check(CadNumberSchema, offset))
    return invalid('The copied sketch needs a supported plane and finite numeric offset.');
  // Validate only this outline. A legacy hole is copied as an outline, with no
  // implicit child holes, source material nesting or unrelated graph geometry.
  const isolated: CadSketchFeature = { id: sketch.id, name: sketch.name, kind: 'sketch', suppressed: false, plane: sketch.plane, offset: sketch.offset,
    profiles: [{ id: profile.id, name: profile.name, construction: false, geometry: profile.geometry }] };
  const resolved = resolveCadSketchContours(isolated, parameters)[0]?.geometry;
  if (!resolved) return invalid('Copy needs one closed analytic profile.');
  const sourceEdges = cadProfileToEntities(resolved).map((entity, index): PathSegment => {
    const common = { id: `${request.idPrefix}_e${index}`, source: { sourceEntityIndex: index, sourceEntityType: entity.type, layer: null, exact: true } };
    if (entity.type === 'line') return createLineSegment({ ...common, start: entity.start, end: entity.end });
    if (entity.type === 'circle') return createCircleSegment({ ...common, center: entity.center, radius: entity.radius });
    if (entity.type !== 'arc' || !entity.start || !entity.end || entity.sweepRadians === undefined) return invalid('Copy needs exact line, arc or circle supports.');
    // Slot caps are authored half-turns; generic path/plugin supports keep their exact branch.
    const sweep = resolved.kind === 'slot' ? Math.PI : entity.sweepRadians;
    return createArcSegment({ ...common, center: entity.center, radius: entity.radius, start: entity.start, end: entity.end, sweepRadians: sweep, clockwise: sweep < 0 });
  });
  const points: { id: string; position: readonly [number, number] }[] = [], entities: CadSketchGraphEntity[] = [];
  const addPoint = (id: string, point: Point2) => { points.push({ id, position: position(point) }); return id; };
  const { idPrefix } = request;
  if (sourceEdges.length === 1 && sourceEdges[0].kind === 'circle') {
    // The display resolver may omit a very short slot span. A detached copy
    // must not turn a genuinely noncircular authored slot into a circle.
    if (resolved.kind === 'slot' && resolved.length !== resolved.width) return precision();
    const edge = sourceEdges[0];
    entities.push({ id: edge.id, kind: 'circle', construction: profile.construction, radius: edge.radius, centerPointId: addPoint(`${idPrefix}_c0`, edge.center) });
  } else {
    sourceEdges.forEach((edge, index) => {
      if (edge.kind === 'circle') return invalid('A complete circle must be the only boundary support.');
      const next = sourceEdges[(index + 1) % sourceEdges.length];
      if (Math.hypot(edge.end.x - next.start.x, edge.end.y - next.start.y) > cadPathClosureTolerance([edge.end, next.start])) return precision();
      addPoint(`${idPrefix}_p${index}`, edge.start);
    });
    sourceEdges.forEach((edge, index) => {
      if (edge.kind === 'circle') return invalid('A complete circle must be the only boundary support.');
      const common = { id: edge.id, construction: profile.construction, startPointId: `${idPrefix}_p${index}`, endPointId: `${idPrefix}_p${(index + 1) % sourceEdges.length}` };
      entities.push(edge.kind === 'line' ? { ...common, kind: 'line' }
        : { ...common, kind: 'arc', centerPointId: addPoint(`${idPrefix}_c${index}`, edge.center), direction: edge.clockwise ? 'cw' : 'ccw' });
    });
  }
  const graph = parseCadSketchGraph({ points, entities, relations: [] }), compiled = compileCadSketchGraph(graph, {});
  if (compiled.cycles.length !== 1 || compiled.cycles[0].sourceRefs.length !== entities.length
    || compiled.openEntityIds.length || compiled.branchedEntityIds.length || compiled.arrangementEntityIds.length) return invalid('Copy needs one simple closed analytic cycle.');
  const byId = new Map(compiled.segments.map(segment => [segment.id, segment]));
  for (const edge of sourceEdges) { const copy = byId.get(edge.id); if (!copy) return precision(); checkSupport(edge, copy); }
  const sourceSegments = sourceEdges.map(pathSegment), before = cadAnalyticPathMetrics({ kind: 'path', segments: sourceSegments });
  const after = cadAnalyticPathMetrics({ kind: 'path', segments: compiled.cycles[0].path });
  const tolerance = cadPathClosureTolerance(sourceEdges.flatMap(edge => [edge.start, edge.end]));
  if (Math.abs(Math.abs(before.signedArea) - Math.abs(after.signedArea)) > Math.max(1, before.length) * tolerance
    || Math.abs(before.length - after.length) > sourceEdges.length * tolerance
    || [before.bounds.minX - after.bounds.minX, before.bounds.minY - after.bounds.minY,
      before.bounds.maxX - after.bounds.maxX, before.bounds.maxY - after.bounds.maxY].some(delta => Math.abs(delta) > tolerance)) return precision();
  const result: CadSketchProfileCopyPreparation = { sketch: { id: request.newSketchId, kind: 'sketch', name: request.name, suppressed: false,
    plane: structuredClone(sketch.plane), offset, profiles: [], graph }, sourceSegments, resultEntityIds: entities.map(entity => entity.id) };
  deepFreezeCadData(result); return result;
}
