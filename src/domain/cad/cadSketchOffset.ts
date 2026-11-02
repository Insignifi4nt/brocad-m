import { Type, type Static } from '@sinclair/typebox';
import { cadFeatureActive } from './features/cadFeatureActivity';
import { Value } from '@sinclair/typebox/value';
import type { CadSketchFeature } from './cadDocument';
import { CadIdentifierSchema, CadScalarSchema } from './cadPrimitives';
import type { ResolvedCadPathSegment } from './cadAnalyticSegments';
import { CadError } from './cadError';
import { isCadImportData } from './cadImportData';
import { evaluateCadScalar } from './cadExpression';
import { cadProfileToEntities, resolveCadSketchContours } from './cadSketchGeometry';
import { appendCadSketchCopiedRelations, appendCadSketchEntities } from './cadSketchGraphEdits';
import { checkCadSketchGraph, parseCadSketchGraph, type CadSketchGraphEntity } from './cadSketchGraph';
import { compileCadSketchGraph } from './cadSketchGraphGeometry';
import { createArcSegment, createCircleSegment, createLineSegment } from '@/domain/path-intel/segments';
import { cadSketchOffsetPathSegment, offsetCadSketchLoop } from './cadSketchLoopOffset';
import { signedDxfArcSweepRadians } from '@/domain/dxf/arcSweep';
import type { DxfEntity } from '@/domain/dxf/types';
import type { PathSegment, Point2 } from '@/domain/path-intel/types';
import { deepFreezeCadData } from './cadDeepFreeze';
import { cadSketchGeneratorName, cadSketchGenerators } from './sketch-generators/cadSketchGenerators';
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

const fail = (message: string): never => { throw new CadError('unsupported-sketch-offset', message); };
const position = (point: Point2): readonly [number, number] => [point.x, point.y];
const pathSegment = cadSketchOffsetPathSegment;
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
    // A profile source names a saved legacy profile only. A generated shape is sketch geometry, so its loop is offset as a graph cycle.
    const generator = sketch.graph ? cadSketchGenerators(sketch.graph).find(generator => generator.id === source.profileId) : undefined;
    if (generator) return fail(`${cadSketchGeneratorName(generator)} is sketch geometry, not a saved profile. Offset its loop with a graph-cycle source, the sourceRefs of its contour in the region reference.`);
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
  const points: { id: string; position: readonly [number, number] }[] = [], entities: CadSketchGraphEntity[] = [];
  const point = (id: string, value: Point2) => { points.push({ id, position: position(value) }); return id; };
  const offset = offsetCadSketchLoop(sourceEdges, distanceMm), resultEdges = offset.edges;
  if (!offset.vertices.length) {
    const circle = resultEdges[0] as Extract<PathSegment, { kind: 'circle' }>;
    entities.push({ id: `${idPrefix}_e0`, kind: 'circle', construction: false, centerPointId: point(`${idPrefix}_c0`, circle.center), radius: circle.radius });
  } else {
    offset.vertices.forEach((vertex, index) => point(`${idPrefix}_p${index}`, vertex));
    resultEdges.forEach((edge, index) => {
      const id = `${idPrefix}_e${index}`;
      const common = { id, construction: false, startPointId: `${idPrefix}_p${index}`, endPointId: `${idPrefix}_p${(index + 1) % resultEdges.length}` };
      entities.push(edge.kind === 'arc' ? { ...common, kind: 'arc', centerPointId: point(`${idPrefix}_c${index}`, edge.center), direction: edge.clockwise ? 'cw' : 'ccw' }
        : { ...common, kind: 'line' });
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
