import type { CadPathSegment } from './cadDocument';
import { CadError } from './cadError';
import { evaluateCadAngle, evaluateCadScalar } from './cadExpression';
import type { DxfEntity, DxfPoint } from '@/domain/dxf/types';
import { angleIsOnSweep, createArcSegment, createLineSegment, distance } from '@/domain/path-intel/segments';
import type { PathSegment, Point2 } from '@/domain/path-intel/types';
import { CAD_PRECISION, cadClosureTolerance } from '@/domain/precision/cadPrecision';

export type ResolvedCadPathSegment =
  | { readonly kind: 'line'; readonly start: readonly [number, number]; readonly end: readonly [number, number] }
  | { readonly kind: 'arc'; readonly center: readonly [number, number]; readonly radius: number; readonly startAngle: number; readonly sweep: number };
export type CadOrderedCurveEntity = Extract<DxfEntity, { type: 'line' | 'arc' }>;

export function resolveCadPathSegments(segments: readonly CadPathSegment[], parameters: Readonly<Record<string, number>>): readonly ResolvedCadPathSegment[] {
  const e = (scalar: number | string) => evaluateCadScalar(scalar, parameters);
  return Object.freeze(segments.map((segment): ResolvedCadPathSegment => segment.kind === 'line'
    ? Object.freeze({ kind: segment.kind, start: Object.freeze([e(segment.start[0]), e(segment.start[1])] as const), end: Object.freeze([e(segment.end[0]), e(segment.end[1])] as const) })
    : Object.freeze({ kind: segment.kind, center: Object.freeze([e(segment.center[0]), e(segment.center[1])] as const), radius: e(segment.radius), startAngle: evaluateCadAngle(segment.startAngle, parameters), sweep: e(segment.sweep) })));
}

/** An arc's exact support and ends as its degrees encode them; refuses an arc that `cadAnalyticSegments` cannot prepare. */
function encodedArc(segment: Extract<ResolvedCadPathSegment, { kind: 'arc' }>) {
  if (segment.radius <= CAD_PRECISION.minimumLengthMm || segment.radius > CAD_PRECISION.modelExtentMm || Math.abs(segment.sweep) > 360 || segment.sweep === 0) throw new CadError('invalid-profile', 'Path arcs need a positive radius and a nonzero sweep of at most one turn.');
  const angle = segment.startAngle * Math.PI / 180; const sweep = segment.sweep * Math.PI / 180;
  // The sweep a prepared arc refuses, refused here too for callers that only read the ends.
  if (!(Number.isFinite(sweep) && sweep !== 0 && Math.abs(sweep) <= Math.PI * 2)) throw new RangeError('Explicit arc sweep must be finite, nonzero, at most one turn, and match its direction.');
  const center = { x: segment.center[0], y: segment.center[1] };
  return { center, sweep, start: pointAtAngle(center, segment.radius, segment.startAngle, angle), end: pointAtAngle(center, segment.radius, segment.startAngle + segment.sweep, angle + sweep) };
}

/** Prepare exact primitives in supplied order without closing or orienting a chain. */
export function cadAnalyticSegments(geometry: readonly ResolvedCadPathSegment[]) {
  const segments: PathSegment[] = geometry.map((segment, index) => {
    const source = { sourceEntityIndex: index, sourceEntityType: segment.kind, layer: null, exact: true };
    const id = `boundary_${index}`;
    if (segment.kind === 'line') return createLineSegment({ id, source, start: { x: segment.start[0], y: segment.start[1] }, end: { x: segment.end[0], y: segment.end[1] } });
    const arc = encodedArc(segment);
    return createArcSegment({ id, source, center: arc.center, radius: segment.radius, start: arc.start, end: arc.end, sweepRadians: arc.sweep, clockwise: arc.sweep < 0 });
  });
  const refs = segments.map(segment => ({ segmentId: segment.id, reversed: false }));
  const byId = new Map(segments.map(segment => [segment.id, segment]));
  return { segments, refs, byId };
}

/**
 * Quarter turns are exact in degrees but not after conversion to radians:
 * cos(3π/2) is -1.8e-16, not 0. Equivalent angles such as 270° and 450° would
 * otherwise put the same endpoint on opposite sides of an axis. Other angles
 * keep their established radian evaluation.
 */
function pointAtAngle(center: Point2, radius: number, degrees: number, radians: number): Point2 {
  const turn = ((degrees % 360) + 360) % 360;
  const [cos, sin] = turn === 0 ? [1, 0] : turn === 90 ? [0, 1] : turn === 180 ? [-1, 0] : turn === 270 ? [0, -1]
    : [Math.cos(radians), Math.sin(radians)];
  return { x: center.x + radius * cos, y: center.y + radius * sin };
}

/** The ends of the primitives `cadAnalyticSegments` prepares, in supplied order, without preparing them: it refuses the same segments. */
export function cadAnalyticSegmentEnds(geometry: readonly ResolvedCadPathSegment[]): readonly { readonly start: Point2; readonly end: Point2 }[] {
  return geometry.map(segment => segment.kind === 'line' ? { start: { x: segment.start[0], y: segment.start[1] }, end: { x: segment.end[0], y: segment.end[1] } } : encodedArc(segment));
}

export function cadOrderedCurveEntities(segments: readonly ResolvedCadPathSegment[], layer = 'CAD_CURVE'): readonly CadOrderedCurveEntity[] {
  return Object.freeze(segments.map((segment): CadOrderedCurveEntity => {
    if (segment.kind === 'line') return Object.freeze({ type: 'line', layer, start: Object.freeze({ x: segment.start[0], y: segment.start[1] }), end: Object.freeze({ x: segment.end[0], y: segment.end[1] }) });
    // Retain the explicit support and angles; atan2 of a world-space sampled
    // endpoint can lose angular precision when the radius is small far away.
    const startAngle = segment.startAngle * Math.PI / 180; const sweepRadians = segment.sweep * Math.PI / 180;
    const center = Object.freeze({ x: segment.center[0], y: segment.center[1] });
    const at = (degrees: number, radians: number) => Object.freeze(pointAtAngle(center, segment.radius, degrees, radians));
    return Object.freeze({ type: 'arc', layer, center, radius: segment.radius, startAngle, endAngle: startAngle + sweepRadians,
      sweepRadians, clockwise: sweepRadians < 0, start: at(segment.startAngle, startAngle), end: at(segment.startAngle + segment.sweep, startAngle + sweepRadians) });
  }));
}

/** Endpoint equality allows arithmetic roundoff, never a physical gap repair. */
export function cadPathClosureTolerance(points: readonly DxfPoint[]): number {
  let scale = 1;
  for (const point of points) scale = Math.max(scale, Math.abs(point.x), Math.abs(point.y));
  return cadClosureTolerance(scale);
}

function onSpan(segment: PathSegment, point: Point2, tolerance: number): boolean {
  if (segment.kind === 'circle') return true;
  if (segment.kind === 'arc') return angleIsOnSweep(Math.atan2(point.y - segment.center.y, point.x - segment.center.x), segment.startAngleRadians, segment.sweepRadians, tolerance / segment.radius);
  const dx = segment.end.x - segment.start.x, dy = segment.end.y - segment.start.y, length = Math.hypot(dx, dy);
  const along = ((point.x - segment.start.x) * dx + (point.y - segment.start.y) * dy) / length;
  return along >= -tolerance && along <= length + tolerance;
}

/**
 * Where two line/circular loci touch within `tolerance` of tangency, on both spans.
 * Their gap never exceeds the tolerance there, so a numeric miss, one root or two close
 * crossings are all one unresolvable tangent contact, independent of sketch position.
 */
export function cadPathTangentContact(a: PathSegment, b: PathSegment, tolerance: number): Point2 | null {
  if (a.kind === 'line' && b.kind === 'line') return null;
  const [line, round] = a.kind === 'line' ? [a, b] : b.kind === 'line' ? [b, a] : [null, a];
  if (round.kind === 'line') return null;
  let contact: Point2 | null = null;
  if (line) {
    const dx = line.end.x - line.start.x, dy = line.end.y - line.start.y, length = Math.hypot(dx, dy);
    const offset = ((round.center.x - line.start.x) * dy - (round.center.y - line.start.y) * dx) / length;
    if (Math.abs(Math.abs(offset) - round.radius) <= tolerance && Math.abs(offset) > 0) {
      const scale = round.radius / Math.abs(offset);
      contact = { x: round.center.x - offset * dy / length * scale, y: round.center.y + offset * dx / length * scale };
    }
  } else {
    const other = round === a ? b : a;
    if (other.kind === 'line') return null;
    const gap = distance(round.center, other.center);
    if (gap > 0) for (const reach of [round.radius + other.radius, round.radius - other.radius, other.radius - round.radius]) {
      if (reach <= 0 || Math.abs(gap - Math.abs(reach)) > tolerance) continue;
      const toward = reach === other.radius - round.radius ? -1 : 1;
      contact = { x: round.center.x + toward * round.radius * (other.center.x - round.center.x) / gap, y: round.center.y + toward * round.radius * (other.center.y - round.center.y) / gap };
      break;
    }
  }
  return contact && onSpan(a, contact, tolerance) && onSpan(b, contact, tolerance) ? contact : null;
}
