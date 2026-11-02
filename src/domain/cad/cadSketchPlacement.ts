import { Type, type Static } from '@sinclair/typebox';
import { CadError } from './cadError';
import { CadPoint2Schema, CadScalarSchema } from './cadPrimitives';
import { CadSketchGraphSelectionSchema, cadSketchGraphSelectionSet } from './cadSketchGraphSelection';
import { parseCadSketchGraph, type CadSketchGraph } from './cadSketchGraph';
import { evaluateCadScalar } from './cadExpression';
import { cadSketchEntityPointIds } from './cadSketchGraphReferences';
import { cadSketchExternalReferenceForSelection } from './cadSketchExternalReferences';
import { cadSketchLinearPatternForSelection } from './cadSketchLinearPattern';
import { cadPathClosureTolerance } from './cadAnalyticSegments';
import { signedSweep } from '@/domain/path-intel/segments';
import type { Point2 } from '@/domain/path-intel/types';

export const CadSketchPlacementRequestSchema = Type.Object({
  selections: Type.Array(CadSketchGraphSelectionSchema, { minItems: 1, maxItems: 64, uniqueItems: true }),
  anchor: CadPoint2Schema, target: CadPoint2Schema, angleDegrees: CadScalarSchema
}, { additionalProperties: false });
type Immutable<T> = { readonly [K in keyof T]: Immutable<T[K]> };
export type CadSketchPlacementRequest = Immutable<Static<typeof CadSketchPlacementRequestSchema>>;
export class CadSketchPlacementDependencyError extends CadError<'dependent-sketch-placement'> {
  readonly pointIds: readonly string[]; readonly entityIds: readonly string[]; readonly relationIds: readonly string[];
  constructor(message: string, subjects: { pointIds?: readonly string[]; entityIds?: readonly string[]; relationIds?: readonly string[] }) {
    super('dependent-sketch-placement', message);
    this.pointIds = Object.freeze([...new Set(subjects.pointIds)]); this.entityIds = Object.freeze([...new Set(subjects.entityIds)]);
    this.relationIds = Object.freeze([...new Set(subjects.relationIds)]);
  }
}
/** One-shot rigid intent. Only explicit entity atoms own their incident geometry. */
export function placeCadSketchGraph({ graph, parameters, selections, anchor, target, angleDegrees }: CadSketchPlacementRequest & {
  readonly graph: CadSketchGraph; readonly parameters: Readonly<Record<string, number>>;
}): CadSketchGraph {
  const selected = cadSketchGraphSelectionSet(graph, selections, true);
  if (!selected.length) throw new CadError('invalid-sketch-selection', 'Choose at least one point or edge to place.');
  const origin = anchor.map(value => evaluateCadScalar(value, parameters)), destination = target.map(value => evaluateCadScalar(value, parameters));
  const degrees = evaluateCadScalar(angleDegrees, parameters) % 360;
  if (degrees === 0 && origin.every((value, axis) => value === destination[axis])) return graph;
  const radians = degrees * Math.PI / 180;
  const rotate = (point: Point2): Point2 => {
    // Exact cardinal angles are signed permutations, never a nearby-angle snap.
    switch (degrees) {
      case 0: return point;
      case 90: case -270: return { x: -point.y, y: point.x };
      case 180: case -180: return { x: -point.x, y: -point.y };
      case 270: case -90: return { x: point.y, y: -point.x };
      default: return { x: Math.cos(radians) * point.x - Math.sin(radians) * point.y,
        y: Math.sin(radians) * point.x + Math.cos(radians) * point.y };
    }
  };
  const points = new Set(selected.filter(item => item.kind === 'point').map(item => item.id));
  const entities = new Set(selected.filter(item => item.kind === 'entity').map(item => item.id));
  for (const entity of graph.entities) if (entities.has(entity.id)) for (const id of cadSketchEntityPointIds(entity)) points.add(id);
  for (const relation of graph.relations) if ((relation.kind === 'fillet-corner' || relation.kind === 'chamfer-corner')
    && [...relation.lineIds, relation.kind === 'fillet-corner' ? relation.arcId : relation.chamferId].every(id => entities.has(id))) points.add(relation.pointId);
  for (const selection of [...selected, ...[...points].map(id => ({ kind: 'point', id } as const))]) {
    const external = cadSketchExternalReferenceForSelection(graph, selection), pattern = cadSketchLinearPatternForSelection(graph, selection);
    if (external || pattern) throw new CadSketchPlacementDependencyError('Detach the linked reference or linear pattern before placing its geometry.', {
      pointIds: selection.kind === 'point' ? [selection.id] : [], entityIds: selection.kind === 'entity' ? [selection.id] : [],
      relationIds: external ? [external.id] : pattern ? [pattern.relation.id] : []
    });
  }
  const before = new Map(graph.points.map(point => [point.id, { x: evaluateCadScalar(point.position[0], parameters), y: evaluateCadScalar(point.position[1], parameters) }]));
  const after = new Map(before), changed = new Set<string>();
  const precision = () => new CadError('sketch-placement-precision', 'This shape cannot be placed exactly here. Choose a position nearer the origin.');
  for (const id of points) {
    const point = before.get(id); if (!point) throw new CadError('missing-sketch-point', 'A placement support point no longer exists.');
    const local = { x: point.x - origin[0], y: point.y - origin[1] };
    if (degrees !== 0 && radians === 0 && (local.x !== 0 || local.y !== 0)) throw precision();
    const rotated = rotate(local);
    const next = { x: destination[0] + rotated.x, y: destination[1] + rotated.y };
    for (const [axis, index] of [['x', 0], ['y', 1]] as const) {
      const step = (destination[index] - origin[index]) + (rotated[axis] - local[axis]);
      if (!Number.isFinite(next[axis]) || Math.abs(next[axis]) > 1e9 || step !== 0 && next[axis] === point[axis]) throw precision();
    }
    after.set(id, next);
    if (next.x !== point.x || next.y !== point.y) changed.add(id);
  }
  if (!changed.size) return graph;
  const foreign = graph.entities.filter(entity => !entities.has(entity.id) && cadSketchEntityPointIds(entity).some(id => changed.has(id)));
  if (foreign.length) throw new CadSketchPlacementDependencyError('Include every edge using a changed point in the placement selection.', {
    entityIds: foreign.map(entity => entity.id), pointIds: [...new Set(foreign.flatMap(cadSketchEntityPointIds).filter(id => changed.has(id)))]
  });
  for (const relation of graph.relations) {
    if (relation.kind === 'coincident' && relation.pointIds.some(id => changed.has(id)) && relation.pointIds.some(id => !points.has(id)))
      throw new CadSketchPlacementDependencyError('Include the other coincident point explicitly before placing this joint.', { pointIds: relation.pointIds, relationIds: [relation.id] });
    if ((relation.kind === 'fixed-point' || relation.kind === 'fixed-axis') && changed.has(relation.pointId)) {
      const old = before.get(relation.pointId)!, next = after.get(relation.pointId)!;
      if (relation.kind === 'fixed-point' || old[relation.axis] !== next[relation.axis])
        throw new CadSketchPlacementDependencyError('Release the fixed coordinate before changing it by placement.', { pointIds: [relation.pointId], relationIds: [relation.id] });
    }
  }
  const candidate = parseCadSketchGraph({ ...graph, points: graph.points.map(point => {
    if (!changed.has(point.id)) return point;
    const old = before.get(point.id)!, next = after.get(point.id)!;
    const coordinate = (axis: 0 | 1) => {
      const key = axis === 0 ? 'x' : 'y';
      if (old[key] === next[key]) return point.position[axis];
      if (typeof point.position[axis] === 'string') throw new CadSketchPlacementDependencyError('Release the coordinate expression before changing it by placement.', { pointIds: [point.id] });
      return next[key];
    };
    return { ...point, position: [coordinate(0), coordinate(1)] };
  }) });
  const vector = (positions: ReadonlyMap<string, Point2>, from: string, to: string) => {
    const a = positions.get(from)!, b = positions.get(to)!; return { x: b.x - a.x, y: b.y - a.y };
  };
  const checkVector = (from: string, to: string) => {
    const expected = rotate(vector(before, from, to)), actual = vector(after, from, to);
    if (Math.hypot(expected.x - actual.x, expected.y - actual.y) > cadPathClosureTolerance([expected, actual])) throw precision();
  };
  const ids = [...points].sort();
  for (const id of ids) checkVector(ids[0], id);
  // Each explicit entity also owns a local certificate, independent of distant detail components.
  for (const entity of graph.entities) if (entities.has(entity.id)) {
    const supports = cadSketchEntityPointIds(entity);
    for (const id of supports) checkVector(supports[0], id);
    if (entity.kind === 'arc') {
      const sweep = (positions: ReadonlyMap<string, Point2>) => {
        const start = vector(positions, entity.centerPointId, entity.startPointId), end = vector(positions, entity.centerPointId, entity.endPointId);
        return signedSweep(Math.atan2(start.y, start.x), Math.atan2(end.y, end.x), entity.direction === 'cw');
      };
      const sourceSide = Math.sign(Math.abs(sweep(before)) - Math.PI);
      // An exact semicircle has no major/minor side; atan2 subtraction can move
      // it by an ulp while the unchanged local-vector/structural checks pass.
      if (sourceSide !== 0 && sourceSide !== Math.sign(Math.abs(sweep(after)) - Math.PI)) throw precision();
    }
  }
  return candidate;
}
