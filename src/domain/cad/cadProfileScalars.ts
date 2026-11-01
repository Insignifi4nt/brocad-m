import type { CadPathSegment, CadPoint2, CadProfile, CadScalar } from './cadDocument';
import type { CadSketchGeneratorGeometry } from './cadSketchGraph';
import type { CadFeatureNestedQuantity, CadFeatureQuantityPath, CadScalarMapper } from './features/cadFeatureDefinitionTypes';

// The dimension-bearing scalars of a profile's geometry, named by their path below `path`, and what each measures. A leaf: the sketch
// graph's generators map the same geometry, and the feature scalar maps re-export these.

export function mapCadPoint2(point: CadPoint2, path: string, map: CadScalarMapper): CadPoint2 { return [map(point[0], `${path}.0`), map(point[1], `${path}.1`)]; }
export function mapCadPathSegment(segment: CadPathSegment, path: string, map: CadScalarMapper): CadPathSegment {
  return segment.kind === 'line' ? { ...segment, start: mapCadPoint2(segment.start, `${path}.start`, map), end: mapCadPoint2(segment.end, `${path}.end`, map) }
    : { ...segment, center: mapCadPoint2(segment.center, `${path}.center`, map), radius: map(segment.radius, `${path}.radius`), startAngle: map(segment.startAngle, `${path}.startAngle`), sweep: map(segment.sweep, `${path}.sweep`) };
}
export function mapCadPathSegments(segments: readonly CadPathSegment[], path: string, map: CadScalarMapper): readonly CadPathSegment[] {
  return segments.map((entry, index) => mapCadPathSegment(entry, `${path}.${index}`, map));
}
export function mapCadProfileScalars(profile: CadProfile, path: string, map: CadScalarMapper): CadProfile {
  const scalar = (value: CadScalar, key: string) => map(value, `${path}.${key}`);
  switch (profile.kind) {
    case 'plugin': return { ...profile, inputs: Object.fromEntries(Object.entries(profile.inputs).map(([name, value]) => [name, scalar(value, `inputs.${name}`)])) };
    case 'rectangle': return { ...profile, x: scalar(profile.x, 'x'), y: scalar(profile.y, 'y'), width: scalar(profile.width, 'width'), height: scalar(profile.height, 'height'), cornerRadius: scalar(profile.cornerRadius, 'cornerRadius') };
    case 'circle': return { ...profile, x: scalar(profile.x, 'x'), y: scalar(profile.y, 'y'), radius: scalar(profile.radius, 'radius') };
    case 'slot': return { ...profile, x: scalar(profile.x, 'x'), y: scalar(profile.y, 'y'), length: scalar(profile.length, 'length'), width: scalar(profile.width, 'width'), angle: scalar(profile.angle, 'angle') };
    case 'polygon': return { ...profile, points: profile.points.map((point, index) => mapCadPoint2(point, `${path}.points.${index}`, map)) };
    case 'path': return { ...profile, segments: mapCadPathSegments(profile.segments, `${path}.segments`, map) };
    default: { const exhaustive: never = profile; return exhaustive; }
  }
}
/** `paths` below `prefix`. */
export function cadQuantitiesUnder(prefix: string, paths: readonly CadFeatureQuantityPath[]): readonly CadFeatureQuantityPath[] {
  return paths.map(({ path, quantity }) => ({ path: !path ? prefix : path.startsWith('{') ? prefix + path : `${prefix}.${path}`, quantity }));
}
const each = (quantity: CadFeatureNestedQuantity, ...paths: readonly string[]) => paths.map(path => ({ path, quantity }));
export const CAD_PATH_SEGMENT_QUANTITIES: readonly CadFeatureQuantityPath[] = [
  ...each('length', '{line}.start.*', '{line}.end.*', '{arc}.center.*', '{arc}.radius'), ...each('angle', '{arc}.startAngle', '{arc}.sweep')];
/** A sketch profile's geometry; a plugin's inputs measure what its pinned package declares. */
export const CAD_PROFILE_QUANTITIES: readonly CadFeatureQuantityPath[] = [
  ...each('length', '{rectangle}.x', '{rectangle}.y', '{rectangle}.width', '{rectangle}.height', '{rectangle}.cornerRadius', '{circle}.x', '{circle}.y',
    '{circle}.radius', '{slot}.x', '{slot}.y', '{slot}.length', '{slot}.width', '{polygon}.points.*.*'),
  ...each('angle', '{slot}.angle'), ...cadQuantitiesUnder('{path}.segments.*', CAD_PATH_SEGMENT_QUANTITIES), ...each('plugin', '{plugin}.inputs.*')];
/** A sketch generator's geometry: a profile's, or a regular polygon's centre, radius and number of sides. */
export function mapCadSketchGeneratorGeometryScalars(geometry: CadSketchGeneratorGeometry, path: string, map: CadScalarMapper): CadSketchGeneratorGeometry {
  if (geometry.kind !== 'regular-polygon') return mapCadProfileScalars(geometry as CadProfile, path, map) as CadSketchGeneratorGeometry;
  return { ...geometry, x: map(geometry.x, `${path}.x`), y: map(geometry.y, `${path}.y`), radius: map(geometry.radius, `${path}.radius`), sides: map(geometry.sides, `${path}.sides`) };
}
export const CAD_SKETCH_GENERATOR_QUANTITIES: readonly CadFeatureQuantityPath[] = [...CAD_PROFILE_QUANTITIES,
  ...each('length', '{regular-polygon}.x', '{regular-polygon}.y', '{regular-polygon}.radius'), ...each('count', '{regular-polygon}.sides')];
