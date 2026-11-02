import type { CadProfile, CadSketchFeature } from './cadDocument';
import { CadError } from './cadError';
import { resolveCadPluginProfile } from './plugins/cadPlugins';
import { evaluateCadAngle, evaluateCadScalar } from './cadExpression';
import type { DxfEntity, DxfPoint } from '@/domain/dxf/types';
import { signedDxfArcSweepRadians } from '@/domain/dxf/arcSweep';
import { angleIsOnSweep, pathBounds, signedAreaOfPath } from '@/domain/path-intel/segments';
import { closedPathContainsPoint } from '@/domain/path-intel/pathContainment';
import { cadAnalyticSegments, cadPathClosureTolerance, resolveCadPathSegments, type ResolvedCadPathSegment } from './cadAnalyticSegments';
import { selectCadSketchRegions, isCadSketchGraphCellSelection, type CadSketchCellReference, type CadSketchRegionSelection } from './cadSketchRegionSelection';
import { prepareCadSketchGraphCells } from './cadSketchGraphCells';
import { compileCadSketchGeometry, type CadCompiledSketchProfile } from './compileCadSketchGeometry';
import { CAD_PRECISION, cadRoundoff, cadSupportedLength } from '@/domain/precision/cadPrecision';
export { cadPathClosureTolerance, type ResolvedCadPathSegment } from './cadAnalyticSegments';

export type ResolvedCadProfile =
  | { kind: 'rectangle'; x: number; y: number; width: number; height: number; cornerRadius: number }
  | { kind: 'circle'; x: number; y: number; radius: number }
  | { kind: 'polygon'; points: readonly (readonly [number, number])[] }
  | { kind: 'path'; segments: readonly ResolvedCadPathSegment[] }
  | { kind: 'slot'; x: number; y: number; length: number; width: number; angle: number };
// Contact and coincidence between boundaries. Size refusals use the minimum length.
const tolerance = CAD_PRECISION.kernelConfusionMm;
const tau = Math.PI * 2;
function polygonDoubleArea(points: readonly (readonly [number, number])[]): number {
  const origin = points[0];
  if (!origin) return 0;
  return points.reduce((area, [x, y], index) => {
    const [nx, ny] = points[(index + 1) % points.length];
    return area + (x - origin[0]) * (ny - origin[1]) - (y - origin[1]) * (nx - origin[0]);
  }, 0);
}

export function resolveCadProfile(profile: CadProfile, parameters: Readonly<Record<string, number>>): ResolvedCadProfile {
  const e = (value: number | string) => evaluateCadScalar(value, parameters);
  switch (profile.kind) {
    case 'plugin': return resolveCadPluginProfile(profile, parameters);
    case 'rectangle': return { kind: profile.kind, x: e(profile.x), y: e(profile.y), width: e(profile.width), height: e(profile.height), cornerRadius: e(profile.cornerRadius) };
    case 'circle': return { kind: profile.kind, x: e(profile.x), y: e(profile.y), radius: e(profile.radius) };
    case 'slot': return { kind: profile.kind, x: e(profile.x), y: e(profile.y), length: e(profile.length), width: e(profile.width), angle: evaluateCadAngle(profile.angle, parameters) };
    case 'polygon': return { kind: profile.kind, points: profile.points.map(([x, y]) => [e(x), e(y)]) };
    case 'path': return { kind: profile.kind, segments: resolveCadPathSegments(profile.segments, parameters) };
    default: { const exhaustive: never = profile; return exhaustive; }
  }
}

function analyticPath(profile: Extract<ResolvedCadProfile, { kind: 'path' }>) {
  return cadAnalyticSegments(profile.segments);
}

type AnalyticPath = ReturnType<typeof analyticPath>;
function analyticPathToEntities(path: AnalyticPath, layer: string): CadAnalyticBoundary[] {
  const reverse = signedAreaOfPath(path.refs, path.byId) < 0;
  const ordered = reverse ? [...path.segments].reverse() : path.segments;
  return ordered.map(segment => {
    if (segment.kind === 'circle') return { type: 'circle', layer, center: segment.center, radius: segment.radius };
    if (segment.kind === 'line') return { type: 'line', layer, start: reverse ? segment.end : segment.start, end: reverse ? segment.start : segment.end };
    if (Math.abs(segment.sweepRadians) === tau) return { type: 'circle', layer, center: segment.center, radius: segment.radius };
    const sweep = reverse ? -segment.sweepRadians : segment.sweepRadians;
    const startAngle = reverse ? segment.startAngleRadians + segment.sweepRadians : segment.startAngleRadians;
    return { type: 'arc', layer, center: segment.center, radius: segment.radius, startAngle, endAngle: startAngle + sweep,
      sweepRadians: sweep, clockwise: sweep < 0, start: reverse ? segment.end : segment.start, end: reverse ? segment.start : segment.end };
  });
}

export function cadAnalyticPathMetrics(profile: Extract<ResolvedCadProfile, { kind: 'path' }>) {
  const path = analyticPath(profile);
  return { signedArea: signedAreaOfPath(path.refs, path.byId), length: path.segments.reduce((total, segment) => total + segment.length, 0), bounds: pathBounds(path.refs, path.byId) };
}

/** Closed, counterclockwise analytic contours. Rectangle x/y is lower-left; slot x/y is its centre. */
export function cadProfileToEntities(profile: ResolvedCadProfile, layer = 'CAD'): DxfEntity[] {
  const entities: DxfEntity[] = [];
  const line = (start: DxfPoint, end: DxfPoint) => {
    if (Math.hypot(start.x - end.x, start.y - end.y) > CAD_PRECISION.minimumLengthMm) entities.push({ type: 'line', layer, start, end });
  };
  const arc = (center: DxfPoint, radius: number, startAngle: number, endAngle: number) => {
    const point = (angle: number) => ({ x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) });
    entities.push({ type: 'arc', layer, center, radius, startAngle, endAngle, clockwise: false, sweepRadians: endAngle - startAngle, start: point(startAngle), end: point(endAngle) });
  };
  switch (profile.kind) {
    case 'path': return analyticPathToEntities(analyticPath(profile), layer);
    case 'circle': return [{ type: 'circle', layer, center: { x: profile.x, y: profile.y }, radius: profile.radius }];
    case 'polygon': {
      const points = profile.points.map(([x, y]) => ({ x, y }));
      const signedArea = polygonDoubleArea(profile.points);
      if (signedArea < 0) points.reverse();
      points.forEach((point, index) => line(point, points[(index + 1) % points.length]));
      break;
    }
    case 'rectangle': {
      const { x, y, width: w, height: h, cornerRadius: r } = profile;
      line({ x: x + r, y }, { x: x + w - r, y });
      if (r > 0) arc({ x: x + w - r, y: y + r }, r, -Math.PI / 2, 0);
      line({ x: x + w, y: y + r }, { x: x + w, y: y + h - r });
      if (r > 0) arc({ x: x + w - r, y: y + h - r }, r, 0, Math.PI / 2);
      line({ x: x + w - r, y: y + h }, { x: x + r, y: y + h });
      if (r > 0) arc({ x: x + r, y: y + h - r }, r, Math.PI / 2, Math.PI);
      line({ x, y: y + h - r }, { x, y: y + r });
      if (r > 0) arc({ x: x + r, y: y + r }, r, Math.PI, Math.PI * 1.5);
      break;
    }
    case 'slot': {
      const angle = profile.angle * Math.PI / 180;
      const half = (profile.length - profile.width) / 2;
      const r = profile.width / 2;
      if (half <= CAD_PRECISION.minimumLengthMm) return [{ type: 'circle', layer, center: { x: profile.x, y: profile.y }, radius: r }];
      const transform = (x: number, y: number) => ({ x: profile.x + x * Math.cos(angle) - y * Math.sin(angle), y: profile.y + x * Math.sin(angle) + y * Math.cos(angle) });
      line(transform(-half, -r), transform(half, -r));
      arc(transform(half, 0), r, angle - Math.PI / 2, angle + Math.PI / 2);
      line(transform(half, r), transform(-half, r));
      arc(transform(-half, 0), r, angle + Math.PI / 2, angle + Math.PI * 1.5);
      break;
    }
    default: { const exhaustive: never = profile; return exhaustive; }
  }
  return entities;
}

export function cadSketchToEntities(sketch: CadSketchFeature, parameters: Readonly<Record<string, number>>): DxfEntity[] {
  const regions = resolveCadSketchRegions(sketch, parameters);
  const contours = new Map(regions.flatMap(region => [region.boundary, ...region.voids]).map(contour => [contour.profile.id, contour]));
  // Keep original contour order for existing exact DXF/CAM handoffs.
  return compileCadSketchGeometry(sketch, parameters).profiles.filter(profile => !profile.construction).flatMap(profile => {
    const contour = contours.get(profile.id);
    if (!contour) throw new CadError('invalid-profile', 'The sketch contour has no resolved material region.');
    return cadProfileToEntities(contour.geometry, contour.depth % 2 === 0 ? 'CAD_OUTER' : 'CAD_HOLE');
  });
}

export interface CadResolvedSketchContour {
  readonly profile: CadCompiledSketchProfile; readonly geometry: ResolvedCadProfile;
  readonly depth: number; readonly parentId: string | null; readonly point: DxfPoint;
  /** Reuses this resolution's prepared analytic path during physical area picking. */
  readonly containsPoint: (point: DxfPoint) => boolean;
}
/** Every even-depth boundary adds material; its immediate children leave voids. */
export interface CadSketchRegion {
  readonly boundary: CadResolvedSketchContour; readonly voids: readonly CadResolvedSketchContour[];
}
export interface CadSketchMaterialBoundary { readonly geometry: ResolvedCadProfile }
export interface CadSketchMaterialRegion {
  readonly boundary: CadSketchMaterialBoundary;
  readonly voids: readonly CadSketchMaterialBoundary[];
}

export type CadAnalyticBoundary = Extract<DxfEntity, { type: 'line' | 'arc' | 'circle' }>;
type Boundary = CadAnalyticBoundary;
function boundary(entities: DxfEntity[]): Boundary[] { return entities.filter((entity): entity is Boundary => entity.type === 'line' || entity.type === 'arc' || entity.type === 'circle'); }
function boundaryArcSweep(entity: Extract<Boundary, { type: 'arc' }>): number {
  return entity.sweepRadians ?? signedDxfArcSweepRadians(entity.startAngle * 180 / Math.PI, entity.endAngle * 180 / Math.PI, entity.clockwise) ?? 0;
}
interface BoundaryBounds { minX: number; minY: number; maxX: number; maxY: number }
function boundaryBounds(entity: Boundary): BoundaryBounds {
  const bounds = entity.type === 'line'
    ? { minX: Math.min(entity.start.x, entity.end.x), minY: Math.min(entity.start.y, entity.end.y), maxX: Math.max(entity.start.x, entity.end.x), maxY: Math.max(entity.start.y, entity.end.y) }
    : entity.type === 'circle'
      ? { minX: entity.center.x - entity.radius, minY: entity.center.y - entity.radius, maxX: entity.center.x + entity.radius, maxY: entity.center.y + entity.radius }
      : { minX: Math.min(entity.start.x, entity.end.x), minY: Math.min(entity.start.y, entity.end.y), maxX: Math.max(entity.start.x, entity.end.x), maxY: Math.max(entity.start.y, entity.end.y) };
  if (entity.type === 'arc') {
    const sweep = boundaryArcSweep(entity);
    const rounding = cadRoundoff(16, Math.max(1, Math.abs(entity.startAngle), Math.abs(sweep)));
    // Exact endpoints and any cardinal extrema on the signed sweep bound the
    // complete arc. Keep the same contact/arithmetic reserve as other edges.
    for (const [angle, x, y] of [[0, entity.center.x + entity.radius, entity.center.y], [Math.PI / 2, entity.center.x, entity.center.y + entity.radius],
      [Math.PI, entity.center.x - entity.radius, entity.center.y], [3 * Math.PI / 2, entity.center.x, entity.center.y - entity.radius]]) {
      if (!angleIsOnSweep(angle, entity.startAngle, sweep, rounding)) continue;
      bounds.minX = Math.min(bounds.minX, x); bounds.maxX = Math.max(bounds.maxX, x);
      bounds.minY = Math.min(bounds.minY, y); bounds.maxY = Math.max(bounds.maxY, y);
    }
  }
  const padding = 2 * tolerance + cadRoundoff(64, Math.max(1, ...Object.values(bounds).map(Math.abs)));
  return { minX: bounds.minX - padding, minY: bounds.minY - padding, maxX: bounds.maxX + padding, maxY: bounds.maxY + padding };
}

function contourBounds(edges: readonly Boundary[]): BoundaryBounds {
  const result = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const edge of edges) {
    const bounds = boundaryBounds(edge);
    result.minX = Math.min(result.minX, bounds.minX); result.minY = Math.min(result.minY, bounds.minY);
    result.maxX = Math.max(result.maxX, bounds.maxX); result.maxY = Math.max(result.maxY, bounds.maxY);
  }
  return result;
}

/** Streaming broadphase pairs, including tolerance contacts; no quadratic pair array. */
export function* cadBoundaryCandidatePairs(boundaries: readonly Boundary[]): Generator<readonly [number, number]> {
  const entries = boundaries.map((entity, index) => ({ index, ...boundaryBounds(entity) })).sort((a, b) => a.minX - b.minX || a.index - b.index);
  let active: typeof entries = [];
  for (const entry of entries) {
    active = active.filter(previous => previous.maxX >= entry.minX);
    for (const previous of active) {
      if (previous.maxY < entry.minY || entry.maxY < previous.minY) continue;
      yield previous.index < entry.index ? [previous.index, entry.index] : [entry.index, previous.index];
    }
    active.push(entry);
  }
}
/** The indexes of the bounds that meet at least one other, as `cadBoundaryCandidatePairs` compares edge bounds. */
function boundsMeetingOthers(bounds: readonly BoundaryBounds[]): ReadonlySet<number> {
  const order = bounds.map((_, index) => index).sort((a, b) => bounds[a].minX - bounds[b].minX || a - b), meeting = new Set<number>();
  let active: number[] = [];
  for (const index of order) {
    const entry = bounds[index];
    active = active.filter(previous => bounds[previous].maxX >= entry.minX);
    for (const previous of active) if (!(bounds[previous].maxY < entry.minY || entry.maxY < bounds[previous].minY)) { meeting.add(previous); meeting.add(index); }
    active.push(index);
  }
  return meeting;
}
function cross(a: DxfPoint, b: DxfPoint) { return a.x * b.y - a.y * b.x; }
function subtract(a: DxfPoint, b: DxfPoint) { return { x: a.x - b.x, y: a.y - b.y }; }
function onCurve(entity: Boundary, point: DxfPoint): boolean {
  if (entity.type === 'line') {
    const direction = subtract(entity.end, entity.start);
    const delta = subtract(point, entity.start);
    const length = Math.hypot(direction.x, direction.y);
    const projection = (delta.x * direction.x + delta.y * direction.y) / length;
    return Math.abs(cross(direction, delta)) / length <= tolerance && projection >= -tolerance && projection <= length + tolerance;
  }
  if (Math.abs(Math.hypot(point.x - entity.center.x, point.y - entity.center.y) - entity.radius) > tolerance) return false;
  if (entity.type === 'circle') return true;
  const angle = Math.atan2(point.y - entity.center.y, point.x - entity.center.x);
  const delta = ((entity.clockwise ? entity.startAngle - angle : angle - entity.startAngle) % tau + tau) % tau;
  const sweep = Math.abs(boundaryArcSweep(entity));
  return delta <= sweep + tolerance / entity.radius || tau - delta <= tolerance / entity.radius;
}
export function cadBoundariesIntersect(first: Boundary, second: Boundary, allowedJoins: readonly DxfPoint[] = []): boolean {
  const intersects = (point: DxfPoint) => onCurve(first, point) && onCurve(second, point)
    && !allowedJoins.some(join => Math.hypot(point.x - join.x, point.y - join.y) <= cadPathClosureTolerance([point, join]));
  if (first.type === 'line' && second.type === 'line') {
    const a = subtract(first.end, first.start); const b = subtract(second.end, second.start);
    const denominator = cross(a, b); const delta = subtract(second.start, first.start);
    if (Math.abs(denominator) < CAD_PRECISION.parallelCrossFloorMm2) return [first.start, first.end, second.start, second.end,
      { x: (first.start.x + first.end.x) / 2, y: (first.start.y + first.end.y) / 2 },
      { x: (second.start.x + second.end.x) / 2, y: (second.start.y + second.end.y) / 2 }].some(intersects);
    const t = cross(delta, b) / denominator;
    const point = { x: first.start.x + t * a.x, y: first.start.y + t * a.y };
    return intersects(point);
  }
  if (first.type === 'line' || second.type === 'line') {
    const line = first.type === 'line' ? first : second;
    const circle = first.type !== 'line' ? first : second;
    if (line.type !== 'line' || circle.type === 'line') return false;
    const vector = subtract(line.end, line.start); const delta = subtract(line.start, circle.center);
    const lengthSquared = vector.x ** 2 + vector.y ** 2;
    const join = allowedJoins.find(point => onCurve(line, point) && onCurve(circle, point));
    if (join) {
      // One root is the already validated join. Deflate the quadratic to avoid
      // sqrt roundoff inventing two crossings beside a tangent shared endpoint.
      const radial = subtract(join, circle.center);
      const other = -2 * (radial.x * vector.x + radial.y * vector.y) / lengthSquared;
      return intersects({ x: join.x + other * vector.x, y: join.y + other * vector.y });
    }
    const projection = -(delta.x * vector.x + delta.y * vector.y) / lengthSquared;
    const closest = { x: line.start.x + projection * vector.x, y: line.start.y + projection * vector.y };
    const distanceSquared = (closest.x - circle.center.x) ** 2 + (closest.y - circle.center.y) ** 2;
    const remainder = circle.radius ** 2 - distanceSquared;
    if (remainder < -tolerance * Math.max(1, circle.radius)) return false;
    const shift = Math.sqrt(Math.max(0, remainder) / lengthSquared);
    return [projection - shift, projection + shift].some(t => intersects({ x: line.start.x + t * vector.x, y: line.start.y + t * vector.y }));
  }
  const delta = subtract(second.center, first.center); const distance = Math.hypot(delta.x, delta.y);
  if (distance <= tolerance && Math.abs(first.radius - second.radius) <= tolerance) {
    if (first.type === 'circle' || second.type === 'circle') return true;
    const midpoint = (edge: Extract<Boundary, { type: 'arc' }>) => {
      const sweep = boundaryArcSweep(edge);
      const angle = edge.startAngle + sweep / 2;
      return { x: edge.center.x + edge.radius * Math.cos(angle), y: edge.center.y + edge.radius * Math.sin(angle) };
    };
    return [first.start, first.end, second.start, second.end, midpoint(first), midpoint(second)].some(intersects);
  }
  if (distance <= tolerance || distance > first.radius + second.radius + tolerance || distance < Math.abs(first.radius - second.radius) - tolerance) return false;
  const along = (first.radius ** 2 - second.radius ** 2 + distance ** 2) / (2 * distance);
  const height = Math.sqrt(Math.max(0, first.radius ** 2 - along ** 2));
  const base = { x: first.center.x + delta.x * along / distance, y: first.center.y + delta.y * along / distance };
  return [-1, 1].some(sign => intersects({ x: base.x - sign * delta.y * height / distance, y: base.y + sign * delta.x * height / distance }));
}

export function cadProfileContainsPoint(profile: ResolvedCadProfile, point: DxfPoint): boolean {
  switch (profile.kind) {
    case 'circle': return Math.hypot(point.x - profile.x, point.y - profile.y) < profile.radius;
    case 'rectangle': {
      const dx = Math.abs(point.x - profile.x - profile.width / 2) - (profile.width / 2 - profile.cornerRadius);
      const dy = Math.abs(point.y - profile.y - profile.height / 2) - (profile.height / 2 - profile.cornerRadius);
      return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) < profile.cornerRadius;
    }
    case 'slot': {
      const angle = profile.angle * Math.PI / 180; const dx = point.x - profile.x; const dy = point.y - profile.y;
      const x = dx * Math.cos(angle) + dy * Math.sin(angle); const y = -dx * Math.sin(angle) + dy * Math.cos(angle);
      return Math.hypot(Math.max(Math.abs(x) - (profile.length - profile.width) / 2, 0), y) < profile.width / 2;
    }
    case 'polygon': {
      let inside = false;
      profile.points.forEach(([x, y], index) => { const [nx, ny] = profile.points[(index + 1) % profile.points.length]; if ((y > point.y) !== (ny > point.y) && point.x < (nx - x) * (point.y - y) / (ny - y) + x) inside = !inside; });
      return inside;
    }
    case 'path': { const path = analyticPath(profile); return closedPathContainsPoint(path.refs, point, path.byId); }
    default: { const exhaustive: never = profile; return exhaustive; }
  }
}

/** A profile's exact curves, its edges and their bounds, as one resolution prepares them. */
interface PreparedOutline { readonly geometry: ResolvedCadProfile; readonly path: AnalyticPath | null; readonly edges: readonly Boundary[]; readonly bounds: BoundaryBounds }
// The preparation of each generator shape that passed the legacy checks, kept with the shape its kind made and checked.
const checkedShapes = new WeakMap<ResolvedCadProfile, PreparedOutline>();

/**
 * The legacy checks of a generator's shape as one profile: sizes, closure, zero area and self-intersection, refused with the reasons a
 * profile gives. The shape's preparation is kept with it, so a sketch contour that is the generator's whole outline reads it again.
 */
export function checkCadSketchGeneratorShape(shape: ResolvedCadProfile, name: string): void {
  let kept: PreparedOutline | undefined;
  const sketch: CadSketchFeature = { id: 'generator', name, kind: 'sketch', suppressed: false, plane: 'XY', offset: 0,
    profiles: [{ id: 'generator', name, construction: false, geometry: shape as CadProfile }] };
  selectCadSketchRegions(contoursOf(sketch, {}, prepared => { kept = prepared; }));
  if (kept) checkedShapes.set(shape, kept);
}

/**
 * Refuses shapes that overlap or touch one another, after the checks `checkCadSketchGeneratorShape` makes of each, with the reasons
 * separate profiles gave. A drawing imported as one generator per contour checks its contours so, since generated curves may cross.
 */
export function checkCadSketchShapesApart(shapes: readonly { readonly name: string; readonly geometry: CadProfile }[]): void {
  contoursOf({ id: 'shapes', name: 'Shapes', kind: 'sketch', suppressed: false, plane: 'XY', offset: 0,
    profiles: shapes.map((shape, index) => ({ id: `shape_${index}`, name: shape.name, construction: false, geometry: shape.geometry })) }, {});
}

/** Infer regions from exact analytic contours, independent of authored orientation or CAM. */
export function resolveCadSketchContours(sketch: CadSketchFeature, parameters: Readonly<Record<string, number>>): readonly CadResolvedSketchContour[] {
  return contoursOf(sketch, parameters);
}

function contoursOf(sketch: CadSketchFeature, parameters: Readonly<Record<string, number>>, keep?: (prepared: PreparedOutline) => void): readonly CadResolvedSketchContour[] {
  const profiles = compileCadSketchGeometry(sketch, parameters).profiles.map(profile => {
    const kept = 'generatorId' in profile && profile.generatorId !== undefined ? checkedShapes.get(profile.geometry as ResolvedCadProfile) : undefined;
    return { profile, kept, geometry: kept?.geometry ?? resolveCadProfile(profile.geometry, parameters) };
  });
  // Preparation belongs to this resolution only: parameter edits always rebuild the exact curves, but containment comparisons reuse them
  // within this call. A generator's whole outline is the shape its kind checked, and reads the preparation that check kept.
  const prepared = profiles.map(({ profile, geometry, kept }) => {
    if (kept) return { profile, ...kept };
    let path: AnalyticPath | null = null;
    let edges: Boundary[] | null = null;
    // A generator's whole outline is the shape its kind already checked as a profile is checked here.
    if ('generatorId' in profile && profile.generatorId !== undefined) {
      if (geometry.kind === 'path') { path = analyticPath(geometry); edges = analyticPathToEntities(path, 'CAD'); }
      edges ??= boundary(cadProfileToEntities(geometry));
      return { profile, geometry, path, edges, bounds: contourBounds(edges) };
    }
    switch (geometry.kind) {
      case 'circle': if (!cadSupportedLength(geometry.radius)) throw new CadError('invalid-profile', `Circle "${profile.name}" needs a positive radius.`); break;
      case 'rectangle': if (!cadSupportedLength(geometry.width) || !cadSupportedLength(geometry.height) || geometry.cornerRadius < 0 || geometry.cornerRadius > Math.min(geometry.width, geometry.height) / 2) throw new CadError('invalid-profile', `Rectangle "${profile.name}" has invalid dimensions or corner radius.`); break;
      case 'slot': if (!cadSupportedLength(geometry.width) || !cadSupportedLength(geometry.length) || geometry.length < geometry.width) throw new CadError('invalid-profile', `Slot "${profile.name}" needs length at least its positive width.`); break;
      case 'polygon': {
        const lines = edges = boundary(cadProfileToEntities(geometry));
        if (lines.length !== geometry.points.length) throw new CadError('invalid-profile', `Polygon "${profile.name}" contains a zero-length edge.`);
        const area = polygonDoubleArea(geometry.points);
        if (Math.abs(area) <= CAD_PRECISION.minimumLengthMm ** 2) throw new CadError('invalid-profile', `Polygon "${profile.name}" has zero area.`);
        for (const [i, j] of cadBoundaryCandidatePairs(lines)) {
          if (j === i + 1 || (i === 0 && j === lines.length - 1)) continue;
          if (cadBoundariesIntersect(lines[i], lines[j])) throw new CadError('self-intersection', `Polygon "${profile.name}" intersects itself.`);
        }
        break;
      }
      case 'path': {
        path = analyticPath(geometry);
        const segments = path.segments;
        if (!segments.length || segments.some(segment => segment.length <= CAD_PRECISION.minimumLengthMm)) throw new CadError('invalid-profile', `Path "${profile.name}" contains a zero-length or unsupported edge.`);
        const endpoints = segments.flatMap(segment => [segment.start, segment.end]);
        const continuity = cadPathClosureTolerance(endpoints);
        segments.forEach((segment, index) => {
          const next = segments[(index + 1) % segments.length];
          if (Math.hypot(segment.end.x - next.start.x, segment.end.y - next.start.y) > continuity) throw new CadError('open-profile', `Path "${profile.name}" must be continuous and closed without repairing gaps.`);
        });
        if (Math.abs(signedAreaOfPath(path.refs, path.byId)) <= CAD_PRECISION.minimumLengthMm ** 2) throw new CadError('invalid-profile', `Path "${profile.name}" has zero area.`);
        edges = analyticPathToEntities(path, 'CAD');
        for (const [i, j] of cadBoundaryCandidatePairs(edges)) {
          const first = edges[i]; const second = edges[j]; const joins: DxfPoint[] = [];
          if (first.type !== 'circle' && second.type !== 'circle') {
            if (j === i + 1) joins.push(first.end);
            if (i === 0 && j === edges.length - 1) joins.push(first.start);
          }
          if (cadBoundariesIntersect(first, second, joins)) throw new CadError('self-intersection', `Path "${profile.name}" intersects itself.`);
        }
        break;
      }
      default: { const exhaustive: never = geometry; throw exhaustive; }
    }
    edges ??= boundary(cadProfileToEntities(geometry));
    const outline: PreparedOutline = { geometry, path, edges, bounds: contourBounds(edges) };
    keep?.(outline);
    return { profile, ...outline };
  });
  const contours = prepared.filter(item => !item.profile.construction);
  // An edge's bounds lie inside its contour's, so only contours whose bounds meet another's have edges in the pairs below, in the same order.
  const meeting = boundsMeetingOthers(contours.map(contour => contour.bounds));
  const indexedEdges = contours.flatMap((contour, index) => meeting.has(index) ? contour.edges.map(edge => ({ edge, contourIndex: index })) : []);
  for (const [i, j] of cadBoundaryCandidatePairs(indexedEdges.map(item => item.edge))) {
    const first = indexedEdges[i]; const second = indexedEdges[j];
    if (first.contourIndex === second.contourIndex) continue;
    if (cadBoundariesIntersect(first.edge, second.edge)) {
      const firstContour = contours[Math.min(first.contourIndex, second.contourIndex)];
      const secondContour = contours[Math.max(first.contourIndex, second.contourIndex)];
      throw new CadError('profile-intersection', `Profiles "${firstContour.profile.name}" and "${secondContour.profile.name}" overlap or touch.`);
    }
  }
  const nested = contours.map(contour => {
    const first = contour.edges[0];
    if (first === undefined) throw new CadError('invalid-profile', 'Profile has no edges.');
    const point = first.type === 'circle' ? { x: first.center.x + first.radius, y: first.center.y } : first.start;
    const containers = contours.filter(other => {
      if (other === contour || point.x < other.bounds.minX || point.x > other.bounds.maxX
        || point.y < other.bounds.minY || point.y > other.bounds.maxY) return false;
      // Bounds only reject impossible candidates; analytic parity still decides
      // every surviving containment, including concave and circular paths.
      return other.path ? closedPathContainsPoint(other.path.refs, point, other.path.byId) : cadProfileContainsPoint(other.geometry, point);
    });
    const expectedRole = containers.length % 2 === 0 ? 'outer' : 'hole';
    // Old saves retain their authored constraint and diagnostics. Missing role is
    // automatic; never add, erase or repair legacy fields while parsing a save.
    if (contour.profile.role !== undefined && contour.profile.role !== expectedRole) throw new CadError('invalid-profile-role', `Legacy profile "${contour.profile.name}" conflicts with its nesting depth ${containers.length}.`);
    return { ...contour, point, containers, depth: containers.length };
  });
  const depths = new Map(nested.map(contour => [contour.profile, contour.depth]));
  const resolved: CadResolvedSketchContour[] = nested.map(contour => {
    const parent = contour.containers.find(container => depths.get(container.profile) === contour.depth - 1);
    return { profile: contour.profile, geometry: contour.geometry, point: contour.point, depth: contour.depth, parentId: parent?.profile.id ?? null,
      containsPoint: (point: DxfPoint) => contour.path ? closedPathContainsPoint(contour.path.refs, point, contour.path.byId) : cadProfileContainsPoint(contour.geometry, point) };
  });
  return resolved;
}

export function resolveCadSketchRegions(sketch: CadSketchFeature, parameters: Readonly<Record<string, number>>, selection?: readonly CadSketchCellReference[]): readonly CadSketchRegion[];
export function resolveCadSketchRegions(sketch: CadSketchFeature, parameters: Readonly<Record<string, number>>, selection?: CadSketchRegionSelection): readonly CadSketchMaterialRegion[];
export function resolveCadSketchRegions(sketch: CadSketchFeature, parameters: Readonly<Record<string, number>>, selection?: CadSketchRegionSelection): readonly CadSketchMaterialRegion[] {
  return isCadSketchGraphCellSelection(selection) ? prepareCadSketchGraphCells(sketch, parameters).resolve(selection)
    : selectCadSketchRegions(resolveCadSketchContours(sketch, parameters), selection);
}

export function validateCadSketchGeometry(sketch: CadSketchFeature, parameters: Readonly<Record<string, number>>): void {
  resolveCadSketchRegions(sketch, parameters);
}
