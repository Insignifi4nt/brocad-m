import { cadPathClosureTolerance } from '../cadAnalyticSegments';
import { evaluateCadScalar } from '../cadExpression';
import { cadSketchGraphPlacedFrom, isAcceptedCadSketchGraph, type CadSketchGraph } from '../cadSketchGraph';
import { resolveCadSketchPointIdentities } from '../cadSketchGraphJoints';
import { CAD_PRECISION } from '../../precision/cadPrecision';
import type { Point2 } from '@/domain/path-intel/types';
import { cadChainGraph, cadSelectionChain, type CadChainCurve, type CadChainGraph, type CadChainJoin, type CadChainMode, type CadChainResult } from './cadSelectionChain';

/** A sketch edge in the chain graph: its ends at their point identities, with what the tangency check reads at each end. */
interface SketchCurve extends CadChainCurve {
  readonly construction: boolean;
  /** The line's length, or the arc's radius at that end: the support a turn at that end is measured over. */
  readonly supports: readonly [number, number];
  /** The points that define the curve, which set the coordinate scale for roundoff. */
  readonly points: readonly Point2[];
}

const unit = (x: number, y: number): readonly [number, number] | null => {
  const length = Math.hypot(x, y);
  return length > 0 && Number.isFinite(length) ? [x / length, y / length] : null;
};

function sketchCurves(graph: CadSketchGraph, parameters: Readonly<Record<string, number>>): SketchCurve[] {
  const positions = new Map<string, Point2>(graph.points.map(point => [point.id,
    { x: evaluateCadScalar(point.position[0], parameters), y: evaluateCadScalar(point.position[1], parameters) }]));
  const identity = resolveCadSketchPointIdentities(graph);
  const curves: SketchCurve[] = [];
  for (const entity of graph.entities) {
    if (entity.kind === 'line') {
      const start = positions.get(entity.startPointId), end = positions.get(entity.endPointId);
      if (!start || !end) continue;
      const direction = unit(end.x - start.x, end.y - start.y), length = Math.hypot(end.x - start.x, end.y - start.y);
      curves.push({ id: entity.id, construction: entity.construction, vertices: [identity(entity.startPointId), identity(entity.endPointId)],
        tangents: [direction, direction], supports: [length, length], points: [start, end] });
    } else if (entity.kind === 'arc') {
      const center = positions.get(entity.centerPointId), start = positions.get(entity.startPointId), end = positions.get(entity.endPointId);
      if (!center || !start || !end) continue;
      // Travel from start to end turns about the centre: counter-clockwise turns the radius a quarter left, clockwise a quarter right.
      const sense = entity.direction === 'ccw' ? 1 : -1;
      const tangent = (point: Point2) => unit(-sense * (point.y - center.y), sense * (point.x - center.x));
      curves.push({ id: entity.id, construction: entity.construction, vertices: [identity(entity.startPointId), identity(entity.endPointId)],
        tangents: [tangent(start), tangent(end)], supports: [Math.hypot(start.x - center.x, start.y - center.y), Math.hypot(end.x - center.x, end.y - center.y)],
        points: [center, start, end] });
    } else {
      const center = positions.get(entity.centerPointId);
      if (!center) continue;
      const radius = evaluateCadScalar(entity.radius, parameters);
      // A circle is a loop of its own, through a vertex no other edge names.
      const vertex = `circle:${entity.id}`;
      curves.push({ id: entity.id, construction: entity.construction, vertices: [vertex, vertex], tangents: [[0, 1], [0, 1]], supports: [radius, radius],
        points: [center, { x: center.x + radius, y: center.y }] });
    }
  }
  return curves;
}

/**
 * Whether a join turns by no more than sketch tangency allows: the same rule the tangent joint accepts, `angularAccuracyRad`, widened far
 * from the origin by coordinate roundoff over the shorter support, up to `angularRoundoffCapRad`. A reversal is never smooth.
 */
function smoothJoin({ arriving, leaving, from, fromEnd, to, toEnd }: CadChainJoin<SketchCurve>): boolean {
  const dot = arriving[0] * leaving[0] + arriving[1] * leaving[1], cross = arriving[0] * leaving[1] - arriving[1] * leaving[0];
  if (!(dot > 0)) return false;
  const error = Math.atan2(Math.abs(cross), dot);
  const support = Math.min(from.supports[fromEnd === 'start' ? 0 : 1], to.supports[toEnd === 'start' ? 0 : 1]);
  const roundoff = cadPathClosureTolerance([...from.points, ...to.points]) / support;
  return Number.isFinite(error) && error <= Math.max(CAD_PRECISION.angularAccuracyRad, Math.min(roundoff, CAD_PRECISION.angularRoundoffCapRad));
}

// The chain graph last built for an accepted graph, under these parameters; it is kept for graphs made from it by moving dimensions.
const indexes = new WeakMap<CadSketchGraph, { readonly parameters: Readonly<Record<string, number>>; readonly index: CadChainGraph<SketchCurve> }>();
function chainIndex(graph: CadSketchGraph, parameters: Readonly<Record<string, number>>): CadChainGraph<SketchCurve> {
  const source = cadSketchGraphPlacedFrom(graph), kept = indexes.get(source);
  if (kept?.parameters === parameters) return kept.index;
  const index = cadChainGraph(sketchCurves(graph, parameters));
  if (isAcceptedCadSketchGraph(graph) && Object.isFrozen(parameters)) indexes.set(source, { parameters, index });
  return index;
}

/**
 * The sketch edges chained to `entityId`: through every join for `contour`, or through smooth joins for `tangent`. Ends join where they
 * share a point or a coincident identity. Construction edges join a chain only when the seed is one. The origin and the axes are never
 * edges, so they are never members.
 */
export function cadSketchSelectionChain(graph: CadSketchGraph, parameters: Readonly<Record<string, number>>, entityId: string, mode: CadChainMode): CadChainResult {
  return cadSelectionChain(chainIndex(graph, parameters), entityId, {
    mode, smooth: smoothJoin, eligible: (curve, seed) => curve.construction === seed.construction,
  });
}
