import { cadPathClosureTolerance, type ResolvedCadPathSegment } from './cadAnalyticSegments';
import { CadError } from './cadError';
import { createArcSegment, createCircleSegment, createLineSegment, cross } from '@/domain/path-intel/segments';
import type { ArcPathSegment, LinePathSegment, PathSegment, Point2 } from '@/domain/path-intel/types';
import { CAD_PRECISION, cadRoundoff } from '@/domain/precision/cadPrecision';

// The exact offset of one closed loop of lines and circular arcs, shared by the detached offset copy and the linked offset generator,
// so both make the same geometry and refuse the same loops with the same reasons.

type Edge = LinePathSegment | ArcPathSegment;
const fail = (message: string): never => { throw new CadError('unsupported-sketch-offset', message); };
const position = (point: Point2): readonly [number, number] => [point.x, point.y];
/** A path segment as a resolved profile segment, in degrees. */
export function cadSketchOffsetPathSegment(segment: PathSegment): ResolvedCadPathSegment {
  return segment.kind === 'line' ? { kind: 'line', start: position(segment.start), end: position(segment.end) }
    : { kind: 'arc', center: position(segment.center), radius: segment.radius,
      startAngle: segment.kind === 'circle' ? 0 : segment.startAngleRadians * 180 / Math.PI,
      sweep: segment.kind === 'circle' ? 360 : segment.sweepRadians * 180 / Math.PI };
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

/** A loop offset: edge i runs from vertex i to vertex i + 1, the last back to vertex 0; a lone circle has no vertices. */
export interface CadSketchLoopOffset {
  readonly vertices: readonly Point2[];
  readonly edges: readonly PathSegment[];
}
/**
 * The closed loop `edges` offset by `distance` to the right of the way it runs, which is outward for a counterclockwise loop. Joints
 * between lines meet where their offsets do; a joint with an arc must be smooth. Refuses, with the reason, a loop it cannot offset
 * exactly: a collapsed edge or radius, a reversed edge or a point out of range.
 */
export function offsetCadSketchLoop(sourceEdges: readonly PathSegment[], distance: number): CadSketchLoopOffset {
  if (sourceEdges.length === 1 && sourceEdges[0].kind === 'circle') {
    const circle = sourceEdges[0], radius = targetRadius(circle.radius, distance);
    checkPoint(circle.center);
    return { vertices: [], edges: [createCircleSegment({ id: circle.id, source: circle.source, center: circle.center, radius })] };
  }
  const edges: Edge[] = sourceEdges.map(edge => edge.kind === 'circle' ? fail('A full circle must be a standalone offset source.') : edge);
  const vertices = edges.map((edge, index) => joint(edges[(index + edges.length - 1) % edges.length], edge, distance));
  vertices.forEach(checkPoint);
  const result = edges.map((edge, index): PathSegment => {
    const start = vertices[index], end = vertices[(index + 1) % vertices.length];
    const offset = edge.kind === 'line' ? createLineSegment({ ...edge, start, end })
      : createArcSegment({ ...edge, start, end, radius: targetRadius(edge.radius, (edge.clockwise ? -1 : 1) * distance), sweepRadians: undefined });
    checkOffsetEdge(edge, offset, distance);
    if (edge.kind === 'arc') checkPoint(edge.center);
    return offset;
  });
  return { vertices, edges: result };
}
