import { cadSketchGraphPlacedFrom, checkCadSketchGraph, isAcceptedCadSketchGraph, type CadSketchGraph } from '@/domain/cad/cadSketchGraph';
import type { CadSketchFeature } from '@/domain/cad/cadDocument';
import type { CadEdit } from '@/domain/cad/cadOperations';
import { CadError } from '@/domain/cad/cadError';
import { evaluateCadScalar } from '@/domain/cad/cadExpression';
import { compileCadSketchGraph } from '@/domain/cad/cadSketchGraphGeometry';
import { cadPathClosureTolerance } from '@/domain/cad/cadAnalyticSegments';
import { createLineSegment } from '@/domain/path-intel/segments';
import { classifyPathSegmentIntersection } from '@/domain/path-intel/intersections';
import type { Bounds2, Point2 } from '@/domain/path-intel/types';
import { CAD_SKETCH_PICK_RADIUS_PX, cadSketchBoundaryDistance } from './cadSketchPicking';
import type { SketchPoint } from './cadSketchInteraction';
import type { CadSketchGraphSelection } from './cadViewportControls';
import { cadSketchPickScopeHasEdges, cadSketchPickScopeHasPoints, type CadSketchGraphPickScope } from './cadSketchGraphSelection';
import type { CadBoxMode } from '@/domain/cad/selection/cadSelectionBox';
import { prepareCadSketchGeometrySnaps } from './cadSketchGeometrySnaps';
import { cadSketchLinearPatternLockReason } from '@/domain/cad/cadSketchLinearPattern';
import { cadSketchExternalReferenceComponents, cadSketchExternalReferenceLockReason } from '@/domain/cad/cadSketchExternalReferences';

export type { CadSketchGraphSelection } from './cadViewportControls';
export type { CadSketchGraphPickFilter } from './cadSketchGraphSelection';
export interface CadSketchGraphBoxQuery {
  readonly bounds: Readonly<Bounds2>;
  /** Window takes what lies wholly inside the box; crossing also takes what the box touches. */
  readonly mode: CadBoxMode;
  readonly filter?: CadSketchGraphPickScope;
}
export interface CadSketchGraphPointControl {
  readonly id: string;
  readonly position: SketchPoint;
  /** User-editable axes after explicit drivers and generated-geometry ownership. Remaining freedom is determined by the solver. */
  readonly freeAxes: readonly [boolean, boolean];
}
export interface CadSketchGraphCircleControl {
  readonly entityId: string;
  readonly center: SketchPoint;
  readonly radius: number;
  readonly lockedReason: string | null;
}

/** Radius ownership is local to this exact circle, independent of whole-sketch freedom. */
export function cadSketchGraphCircleControl(graph: CadSketchGraph, parameters: Readonly<Record<string, number>>, entityId: string): CadSketchGraphCircleControl {
  const circle = graph.entities.find(entity => entity.id === entityId);
  if (circle?.kind !== 'circle') throw new CadError('missing-sketch-circle', 'Choose an existing sketch circle.');
  const center = graph.points.find(point => point.id === circle.centerPointId);
  if (!center) throw new CadError('missing-sketch-point', 'The circle center no longer exists.');
  const lockedReason = cadSketchLinearPatternLockReason(graph, { kind: 'entity', id: entityId }) ?? cadSketchExternalReferenceLockReason(graph, { kind: 'entity', id: entityId }) ?? (typeof circle.radius === 'string' ? 'Radius follows an expression. Edit or release it with fx.'
    : graph.relations.some(relation => relation.kind === 'radial-size' && relation.entityId === entityId) ? 'Radius follows a radial dimension. Edit that dimension instead.'
      : graph.relations.some(relation => relation.kind === 'equal-radius' && relation.curveIds.includes(entityId)) ? 'Radius follows an equal-radius relation. Add or edit a radial dimension to control the shared size.' : null);
  return Object.freeze({ entityId: circle.id, center: Object.freeze([evaluateCadScalar(center.position[0], parameters),
    evaluateCadScalar(center.position[1], parameters)] satisfies [number, number]), radius: evaluateCadScalar(circle.radius, parameters), lockedReason });
}

/** Existing complete-feature intent; shared preparation owns solving and whole-part acceptance. */
export function cadSketchGraphCircleRadiusEdit(sketch: CadSketchFeature, parameters: Readonly<Record<string, number>>, entityId: string,
  radius: number): Extract<CadEdit, { kind: 'update-feature' }> {
  if (!sketch.graph) throw new CadError('missing-sketch-graph', 'Choose an existing entity-based sketch.');
  const control = cadSketchGraphCircleControl(sketch.graph, parameters, entityId);
  if (control.lockedReason) throw new CadError('locked-sketch-radius', control.lockedReason);
  const graph: CadSketchGraph = { ...sketch.graph, entities: sketch.graph.entities.map(entity => entity.id === entityId && entity.kind === 'circle' ? { ...entity, radius } : entity) };
  const issues = checkCadSketchGraph(graph, parameters);
  if (issues.length) throw new CadError('invalid-sketch-graph-geometry', issues[0].message);
  return { kind: 'update-feature', feature: { ...sketch, graph } };
}

function inside(point: Point2, bounds: Readonly<Bounds2>, epsilon = 0): boolean {
  return point.x >= bounds.minX - epsilon && point.x <= bounds.maxX + epsilon
    && point.y >= bounds.minY - epsilon && point.y <= bounds.maxY + epsilon;
}
function boundsCorners(bounds: Readonly<Bounds2>): readonly Point2[] {
  return [{ x: bounds.minX, y: bounds.minY }, { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY }, { x: bounds.minX, y: bounds.maxY }];
}

export type CadSketchGraphInteraction = ReturnType<typeof prepareInteraction>;
// The interaction last prepared for an accepted graph, under these parameters, kept for the graphs made from it by moving dimensions.
const preparedInteractions = new WeakMap<CadSketchGraph, { readonly parameters: Readonly<Record<string, number>>; readonly interaction: CadSketchGraphInteraction }>();

/**
 * The sketch geometry's points, edges, snaps and picks, with `graph` itself. None of them reads where dimensions are drawn, so a graph
 * made by moving dimensions of one already prepared under the same parameters takes that preparation with its own graph.
 */
export function prepareCadSketchGraphInteraction(graph: CadSketchGraph, parameters: Readonly<Record<string, number>>): CadSketchGraphInteraction {
  const source = cadSketchGraphPlacedFrom(graph), kept = preparedInteractions.get(source);
  if (kept?.parameters === parameters) return kept.interaction.graph === graph ? kept.interaction : { ...kept.interaction, graph };
  const interaction = prepareInteraction(graph, parameters);
  if (isAcceptedCadSketchGraph(graph) && Object.isFrozen(parameters)) preparedInteractions.set(source, { parameters, interaction });
  return interaction;
}

/** One immutable preparation supplies exact drawing and point/edge picking, without a profile fallback. */
function prepareInteraction(graph: CadSketchGraph, parameters: Readonly<Record<string, number>>) {
  const geometry = compileCadSketchGraph(graph, parameters);
  const fixed = new Map<string, Set<number>>();
  for (const id of cadSketchExternalReferenceComponents(graph).pointIds) fixed.set(id, new Set([0, 1]));
  for (const relation of graph.relations) if (relation.kind === 'fixed-point' || relation.kind === 'fixed-axis') {
    const axes = fixed.get(relation.pointId) ?? new Set<number>();
    if (relation.kind === 'fixed-point') { axes.add(0); axes.add(1); } else axes.add(relation.axis === 'x' ? 0 : 1);
    fixed.set(relation.pointId, axes);
  }
  const points: readonly CadSketchGraphPointControl[] = Object.freeze(graph.points.map(point => Object.freeze({ id: point.id,
    position: Object.freeze([evaluateCadScalar(point.position[0], parameters), evaluateCadScalar(point.position[1], parameters)] satisfies [number, number]),
    freeAxes: Object.freeze([!cadSketchLinearPatternLockReason(graph, { kind: 'point', id: point.id }) && typeof point.position[0] === 'number' && !fixed.get(point.id)?.has(0), !cadSketchLinearPatternLockReason(graph, { kind: 'point', id: point.id }) && typeof point.position[1] === 'number' && !fixed.get(point.id)?.has(1)] satisfies [boolean, boolean])
  })));
  return { graph, parameters, geometry, points, snap: prepareCadSketchGeometrySnaps({ graph, points, segments: geometry.segments }),
    pick(point: SketchPoint, millimetersPerPixel: number, filter: CadSketchGraphPickScope = 'auto'): readonly CadSketchGraphSelection[] {
      if (!point.every(Number.isFinite) || !Number.isFinite(millimetersPerPixel) || millimetersPerPixel <= 0) return [];
      const tolerance = CAD_SKETCH_PICK_RADIUS_PX * millimetersPerPixel;
      if (!Number.isFinite(tolerance)) return [];
      const hits = [
        ...(!cadSketchPickScopeHasPoints(filter) ? [] : points.map(control => ({ kind: 'point' as const, id: control.id, distance: Math.hypot(point[0] - control.position[0], point[1] - control.position[1]) }))),
        ...(!cadSketchPickScopeHasEdges(filter) ? [] : geometry.segments.map(segment => ({ kind: 'entity' as const, id: segment.id, distance: cadSketchBoundaryDistance({ x: point[0], y: point[1] }, segment) })))
      ].filter(hit => hit.distance <= tolerance);
      hits.sort((a, b) => (a.kind === b.kind ? a.distance - b.distance : a.kind === 'point' ? -1 : 1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return hits.map(({ kind, id }) => ({ kind, id }));
    },
    /** Normalized world-mm box; direction is decided by the caller in screen coordinates. */
    pickBox({ bounds, mode, filter = 'auto' }: CadSketchGraphBoxQuery): readonly CadSketchGraphSelection[] {
      if (![bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite)
        || bounds.minX >= bounds.maxX || bounds.minY >= bounds.maxY) return [];
      const hits: CadSketchGraphSelection[] = [];
      if (cadSketchPickScopeHasPoints(filter)) for (const point of points) if (inside({ x: point.position[0], y: point.position[1] }, bounds)) hits.push({ kind: 'point', id: point.id });
      if (cadSketchPickScopeHasEdges(filter)) {
        for (const segment of geometry.segments) {
          const extent = boundsCorners(segment.bounds), epsilon = cadPathClosureTolerance(extent);
          const contained = extent.every(point => inside(point, bounds, epsilon));
          if (contained) { hits.push({ kind: 'entity', id: segment.id }); continue; }
          if (mode !== 'crossing') continue;
          // Clip the query to the curve's broad bounds before intersection math.
          // Distant box corners must not inflate contact tolerance or overflow edge vectors.
          const clipped = { minX: Math.max(bounds.minX, segment.bounds.minX - epsilon), minY: Math.max(bounds.minY, segment.bounds.minY - epsilon),
            maxX: Math.min(bounds.maxX, segment.bounds.maxX + epsilon), maxY: Math.min(bounds.maxY, segment.bounds.maxY + epsilon) };
          if (clipped.minX > clipped.maxX || clipped.minY > clipped.maxY) continue;
          const corners = boundsCorners(clipped);
          const crosses = inside(segment.start, bounds, epsilon) || corners.some((start, index) => {
            const edge = createLineSegment({ id: `box_${index}`, source: { sourceEntityIndex: index, sourceEntityType: 'line', layer: null, exact: true },
              start, end: corners[(index + 1) % corners.length] });
            return classifyPathSegmentIntersection(segment, edge, epsilon).kind !== 'none';
          });
          if (crosses) hits.push({ kind: 'entity', id: segment.id });
        }
      }
      hits.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'point' ? -1 : 1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return Object.freeze(hits.map(hit => Object.freeze(hit)));
    }
  };
}

export function cadSketchGraphPointTranslation(point: CadSketchGraphPointControl, target: SketchPoint): SketchPoint {
  return [point.freeAxes[0] ? target[0] - point.position[0] : 0, point.freeAxes[1] ? target[1] - point.position[1] : 0];
}
