import { CadError } from './cadError';
import { evaluateCadScalar } from './cadExpression';
import { cadAnalyticSegments, cadPathClosureTolerance, type ResolvedCadPathSegment } from './cadAnalyticSegments';
import { checkCadSketchGraph, type CadSketchGraph, type CadSketchGraphEntity } from './cadSketchGraph';
import { resolveCadSketchGraphJoints } from './cadSketchGraphJoints';
import { createArcSegment, createCircleSegment, createLineSegment, mergeBounds } from '@/domain/path-intel/segments';
import { classifyPathSegmentIntersection, expandBounds, spatialCellSizeForSegments } from '@/domain/path-intel/intersections';
import { SpatialHash } from '@/domain/path-intel/spatialIndex';
import type { Bounds2, PathSegment, Point2 } from '@/domain/path-intel/types';
import { deepFreezeCadData } from './cadDeepFreeze';

export interface CadSketchGraphSourceRef { readonly entityId: string; readonly reversed: boolean }
export interface CadSketchGraphCycle {
  readonly sourceRefs: readonly CadSketchGraphSourceRef[];
  readonly path: readonly ResolvedCadPathSegment[];
  readonly construction: boolean;
}
export interface CadSketchGraphGeometry {
  readonly segments: readonly PathSegment[];
  readonly cycles: readonly CadSketchGraphCycle[];
  readonly openEntityIds: readonly string[];
  readonly branchedEntityIds: readonly string[];
  /** Intersections/overlaps require arrangement work; these entities never create fake cells. */
  readonly arrangementEntityIds: readonly string[];
}
interface Prepared { readonly entity: CadSketchGraphEntity; readonly segment: PathSegment }
type Edge = Prepared & { readonly entity: Exclude<CadSketchGraphEntity, { kind: 'circle' }> };

function pathSegment(segment: PathSegment, reversed: boolean): ResolvedCadPathSegment {
  if (segment.kind === 'line') {
    const start = reversed ? segment.end : segment.start, end = reversed ? segment.start : segment.end;
    return { kind: 'line', start: [start.x, start.y], end: [end.x, end.y] };
  }
  return { kind: 'arc', center: [segment.center.x, segment.center.y], radius: segment.radius,
    startAngle: segment.kind === 'circle' ? 0 : (segment.startAngleRadians + (reversed ? segment.sweepRadians : 0)) * 180 / Math.PI,
    sweep: segment.kind === 'circle' ? 360 : (reversed ? -segment.sweepRadians : segment.sweepRadians) * 180 / Math.PI };
}
function endpoints(entity: CadSketchGraphEntity): readonly string[] {
  return entity.kind === 'circle' ? [] : [entity.startPointId, entity.endPointId];
}
function extentPoints(segment: PathSegment): Point2[] {
  return [{ x: segment.bounds.minX, y: segment.bounds.minY }, { x: segment.bounds.maxX, y: segment.bounds.maxY }];
}
function checkCycleEncoding(path: readonly ResolvedCadPathSegment[]): void {
  const encoded = cadAnalyticSegments(path).segments;
  for (let index = 0; index < encoded.length; index++) {
    const end = encoded[index].end, start = encoded[(index + 1) % encoded.length].start;
    if (Math.hypot(end.x - start.x, end.y - start.y) > cadPathClosureTolerance([end, start])) {
      throw new CadError('sketch-graph-precision', 'These edges no longer meet exactly at their joints. Move the geometry nearer the origin or redraw the joint.');
    }
  }
}

/**
 * The generators among the prepared edges, for the crossing check. A generator's members draw outlines that its kind checked as a legacy
 * profile is checked, closed and free of self-intersection, so they meet one another only at their own joints: only edges of different
 * generators, or a generator's and a drawn edge, can cross. Each generator is found among the others by the bounds of everything it made,
 * and only the edges of a generator that comes near another generator or a drawn edge are compared one by one. Null without generators.
 */
function generatedUnits(graph: CadSketchGraph, prepared: readonly Prepared[], tolerance: number) {
  const prefixes = new Set<string>();
  for (const relation of graph.relations) if (relation.kind === 'generator') prefixes.add(relation.idPrefix);
  if (!prefixes.size) return null;
  const units = new Map<Prepared, string>(), bounds = new Map<string, Bounds2>(), blocks: { readonly unit?: string; readonly bounds: Bounds2 }[] = [];
  for (const item of prepared) {
    const at = item.entity.id.indexOf('_'), prefix = at > 0 ? item.entity.id.slice(0, at) : undefined;
    if (prefix === undefined || !prefixes.has(prefix)) { blocks.push({ bounds: item.segment.bounds }); continue; }
    units.set(item, prefix);
    const had = bounds.get(prefix);
    bounds.set(prefix, had ? mergeBounds(had, item.segment.bounds) : item.segment.bounds);
  }
  for (const [unit, extent] of bounds) blocks.push({ unit, bounds: extent });
  const spans = blocks.map(block => Math.max(block.bounds.maxX - block.bounds.minX, block.bounds.maxY - block.bounds.minY)).filter(span => span > 0).sort((a, b) => a - b);
  const index = new SpatialHash<(typeof blocks)[number]>({ cellSize: Math.max(tolerance, spans[Math.floor(Math.max(0, spans.length - 1) * 0.1)] ?? 1) });
  const near = new Set<string>();
  for (const block of blocks) {
    for (const other of index.queryBounds(expandBounds(block.bounds, tolerance))) {
      if (block.unit !== undefined) near.add(block.unit);
      if (other.unit !== undefined) near.add(other.unit);
    }
    index.insertBounds(block.bounds, block);
  }
  return { unitOf: (item: Prepared) => units.get(item), compared: (item: Prepared) => { const unit = units.get(item); return unit === undefined || near.has(unit); } };
}

/** Simple declared-joint cycles only. No endpoint healing, coordinate merging or implicit graph edits. */
export function compileCadSketchGraph(graph: CadSketchGraph, parameters: Readonly<Record<string, number>>): CadSketchGraphGeometry {
  const issues = checkCadSketchGraph(graph, parameters);
  if (issues.length) throw new CadError('invalid-sketch-graph-geometry', `${issues[0].source.id}: ${issues[0].message}`);
  const points = new Map(graph.points.map(point => [point.id, { x: evaluateCadScalar(point.position[0], parameters), y: evaluateCadScalar(point.position[1], parameters) }]));
  const joint = resolveCadSketchGraphJoints(graph, points);
  const jointEndpoints = (entity: CadSketchGraphEntity) => endpoints(entity).map(joint);
  const point = (id: string) => {
    const value = points.get(id);
    if (!value) throw new CadError('missing-sketch-point', `Sketch point "${id}" is missing.`);
    return value;
  };
  const prepared: Prepared[] = [...graph.entities].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map((entity, index) => {
    const source = { sourceEntityIndex: index, sourceEntityType: entity.kind, layer: null, exact: true };
    const common = { id: entity.id, source };
    const segment = entity.kind === 'line' ? createLineSegment({ ...common, start: point(entity.startPointId), end: point(entity.endPointId) })
      : entity.kind === 'circle' ? createCircleSegment({ ...common, center: point(entity.centerPointId), radius: evaluateCadScalar(entity.radius, parameters) })
        : createArcSegment({ ...common, center: point(entity.centerPointId), start: point(entity.startPointId), end: point(entity.endPointId), clockwise: entity.direction === 'cw' });
    return { entity, segment };
  });
  const segments = prepared.map(item => item.segment), cycles: CadSketchGraphCycle[] = [], open: string[] = [], branched: string[] = [];
  for (const construction of [false, true]) {
    const adjacency = new Map<string, Edge[]>(), edges: Edge[] = [];
    for (const item of prepared) {
      if (item.entity.construction !== construction) continue;
      if (item.entity.kind === 'circle') {
        cycles.push({ construction, sourceRefs: [{ entityId: item.entity.id, reversed: false }], path: [pathSegment(item.segment, false)] });
        continue;
      }
      const edge: Edge = { entity: item.entity, segment: item.segment }; edges.push(edge);
      const ids = jointEndpoints(edge.entity);
      if (ids[0] === ids[1]) throw new CadError('sketch-graph-precision', 'An edge is too short: both of its ends meet at the same point. Delete or lengthen it.');
      for (const id of ids) {
        const list = adjacency.get(id) ?? []; list.push(edge); adjacency.set(id, list);
      }
    }
    const visited = new Set<string>();
    for (const first of edges) {
      if (visited.has(first.entity.id)) continue;
      const component: Edge[] = [], vertices = new Set<string>(), queue = [first];
      visited.add(first.entity.id);
      for (let cursor = 0; cursor < queue.length; cursor++) {
        const edge = queue[cursor]; component.push(edge);
        for (const id of jointEndpoints(edge.entity)) {
          if (vertices.has(id)) continue;
          vertices.add(id);
          for (const next of adjacency.get(id) ?? []) if (!visited.has(next.entity.id)) { visited.add(next.entity.id); queue.push(next); }
        }
      }
      if ([...vertices].some(id => (adjacency.get(id)?.length ?? 0) > 2)) { branched.push(...component.map(item => item.entity.id)); continue; }
      if ([...vertices].some(id => adjacency.get(id)?.length !== 2)) { open.push(...component.map(item => item.entity.id)); continue; }
      // Original endpoint ordering fixes orientation even when a new alias becomes the class key.
      const start = joint(first.entity.startPointId < first.entity.endPointId ? first.entity.startPointId : first.entity.endPointId);
      let current = start, edge = first;
      const sourceRefs: CadSketchGraphSourceRef[] = [], path: ResolvedCadPathSegment[] = [];
      for (let count = 0; count < component.length; count++) {
        const reversed = joint(edge.entity.startPointId) !== current;
        sourceRefs.push({ entityId: edge.entity.id, reversed }); path.push(pathSegment(edge.segment, reversed));
        current = joint(reversed ? edge.entity.startPointId : edge.entity.endPointId);
        const next = adjacency.get(current)?.find(item => item.entity.id !== edge.entity.id);
        if (!next) throw new CadError('invalid-sketch-cycle', 'The identity-connected cycle is incomplete.');
        edge = next;
      }
      if (current !== start) throw new CadError('invalid-sketch-cycle', 'The identity-connected cycle did not close.');
      cycles.push({ construction, sourceRefs, path });
    }
  }
  const arrangement = new Set<string>();
  const broadTolerance = cadPathClosureTolerance(segments.flatMap(extentPoints));
  const generated = generatedUnits(graph, prepared, broadTolerance), compared = generated ? prepared.filter(item => generated.compared(item)) : prepared;
  const spatial = new SpatialHash<Prepared>({ cellSize: spatialCellSizeForSegments(compared.map(item => item.segment), broadTolerance) });
  for (const item of compared) {
    const unit = generated?.unitOf(item);
    for (const other of spatial.queryBounds(expandBounds(item.segment.bounds, broadTolerance))) {
      if (item.entity.construction !== other.entity.construction) continue;
      if (unit !== undefined && unit === generated?.unitOf(other)) continue;
      const epsilon = cadPathClosureTolerance([...extentPoints(item.segment), ...extentPoints(other.segment)]);
      const intersection = classifyPathSegmentIntersection(item.segment, other.segment, epsilon);
      if (intersection.kind === 'none') continue;
      const shared = endpoints(item.entity).flatMap(id => endpoints(other.entity).filter(otherId => joint(id) === joint(otherId)).map(otherId => [point(id), point(otherId)]));
      if (intersection.kind === 'points' && intersection.points.every(hit => shared.some(pair => pair.every(endpoint => Math.hypot(hit.x - endpoint.x, hit.y - endpoint.y) <= epsilon)))) continue;
      arrangement.add(item.entity.id); arrangement.add(other.entity.id);
    }
    spatial.insertBounds(item.segment.bounds, item);
  }
  const result: CadSketchGraphGeometry = { segments, cycles: cycles.filter(cycle => cycle.sourceRefs.every(ref => !arrangement.has(ref.entityId)))
    .sort((a, b) => a.sourceRefs[0].entityId < b.sourceRefs[0].entityId ? -1 : a.sourceRefs[0].entityId > b.sourceRefs[0].entityId ? 1 : 0),
    openEntityIds: open.sort(), branchedEntityIds: branched.sort(), arrangementEntityIds: [...arrangement].sort() };
  for (const cycle of result.cycles) checkCycleEncoding(cycle.path);
  deepFreezeCadData(result);
  return result;
}
