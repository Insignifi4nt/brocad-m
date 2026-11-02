import type { CadPoint2 } from './cadDocument';
import { CadError } from './cadError';
import { evaluateCadScalar } from './cadExpression';
import { parseCadSketchGraph, type CadSketchGraph } from './cadSketchGraph';
import { cadSketchEntityPointIds } from './cadSketchGraphReferences';
import { cadSketchGraphSelectionSet, type CadSketchGraphSelection } from './cadSketchGraphSelection';
import { cadPathClosureTolerance } from './cadAnalyticSegments';
import { signedSweep } from '@/domain/path-intel/segments';
import type { Point2 } from '@/domain/path-intel/types';
import { cadSketchExternalReferenceLockReason } from './cadSketchExternalReferences';
import { reconcileCadSketchLinearPattern } from './cadSketchLinearPattern';
import { cadSketchOwnedGeometryLockReason } from './cadSketchOwnedGeometry';
import { cadRoundoff } from '@/domain/precision/cadPrecision';

function position(points: ReadonlyMap<string, Point2>, id: string): Point2 {
  const point = points.get(id);
  if (!point) throw new CadError('missing-sketch-point', 'A move support point no longer exists.');
  return point;
}

/** Rigid source intent. Preparation solves a copy and must verify this exact candidate afterward. */
export function translateCadSketchGraph({ graph, selections, translation, parameters }: {
  readonly graph: CadSketchGraph; readonly selections: readonly CadSketchGraphSelection[];
  readonly translation: CadPoint2; readonly parameters: Readonly<Record<string, number>>;
}): CadSketchGraph {
  const selected = cadSketchGraphSelectionSet(graph, selections, true);
  if (!selected.length) throw new CadError('invalid-sketch-selection', 'Choose at least one sketch point or edge to move.');
  const delta = translation.map(value => evaluateCadScalar(value, parameters));
  if (delta.every(value => value === 0)) return graph;
  for (const selection of selected) {
    const reason = cadSketchOwnedGeometryLockReason(graph, selection) ?? cadSketchExternalReferenceLockReason(graph, selection);
    if (reason) throw new CadError('referenced-sketch-geometry', reason);
  }
  const points = new Set(selected.filter(item => item.kind === 'point').map(item => item.id));
  const entities = new Set(selected.filter(item => item.kind === 'entity').map(item => item.id));
  for (const entity of graph.entities) if (entities.has(entity.id)) for (const id of cadSketchEntityPointIds(entity)) points.add(id);
  const covered = new Set(graph.entities.filter(entity => cadSketchEntityPointIds(entity).every(id => points.has(id))).map(entity => entity.id));
  for (const relation of graph.relations) {
    if ((relation.kind === 'fillet-corner' || relation.kind === 'chamfer-corner')
      && [...relation.lineIds, relation.kind === 'fillet-corner' ? relation.arcId : relation.chamferId].every(id => covered.has(id))) points.add(relation.pointId);
  }
  const label = (id: string) => `Point ${graph.points.findIndex(point => point.id === id) + 1}`;
  for (const relation of graph.relations) {
    if ((relation.kind === 'fixed-point' || relation.kind === 'fixed-axis') && points.has(relation.pointId)
      && (relation.kind === 'fixed-point' ? delta.some(value => value !== 0) : delta[relation.axis === 'x' ? 0 : 1] !== 0))
      throw new CadError('driven-sketch-position', `${label(relation.pointId)} has a fixed coordinate. Release its driver before moving that axis.`);
  }
  let translated = parseCadSketchGraph({ ...graph, points: graph.points.map(point => {
    if (!points.has(point.id)) return point;
    const coordinate = (axis: 0 | 1) => {
      const value = point.position[axis], step = delta[axis];
      if (step === 0) return value;
      if (typeof value === 'string') throw new CadError('driven-sketch-position', `${label(point.id)} ${axis === 0 ? 'X' : 'Y'} follows an expression. Release its driver before moving that axis.`);
      const target = value + step;
      if (!Number.isFinite(target) || Math.abs(target) > 1e9 || target === value)
        throw new CadError('sketch-translation-precision', 'This move cannot be made exactly at these coordinates. Try a different distance, or move the geometry nearer the origin first.');
      return target;
    };
    return { ...point, position: [coordinate(0), coordinate(1)] };
  }) });
  for (const relation of graph.relations) if (relation.kind === 'linear-pattern' && points.has(relation.seed.centerPointId))
    translated = reconcileCadSketchLinearPattern({ graph: translated, parameters, relation, previous: relation });
  const resolve = (graph: CadSketchGraph) => new Map(graph.points.map(point => [point.id,
    { x: evaluateCadScalar(point.position[0], parameters), y: evaluateCadScalar(point.position[1], parameters) }]));
  const before = resolve(graph), after = resolve(translated);
  const checkVector = (from: string, to: string) => {
    const a = position(before, from), b = position(before, to), c = position(after, from), d = position(after, to);
    const old = { x: b.x - a.x, y: b.y - a.y }, next = { x: d.x - c.x, y: d.y - c.y };
    if (Math.hypot(next.x - old.x, next.y - old.y) > cadPathClosureTolerance([old, next]))
      throw new CadError('sketch-translation-precision', 'Moving this shape here would distort it slightly. Try a different distance, or move the geometry nearer the origin first.');
  };
  const ids = [...points].sort();
  for (const id of ids) checkVector(ids[0], id);
  // A distant second component must not license distortion of a small selected edge/arc.
  for (const entity of graph.entities) if (covered.has(entity.id)) {
    const supports = cadSketchEntityPointIds(entity);
    for (const id of supports) checkVector(supports[0], id);
    if (entity.kind === 'arc') {
      const branch = (positions: ReadonlyMap<string, Point2>) => {
        const center = position(positions, entity.centerPointId), start = position(positions, entity.startPointId), end = position(positions, entity.endPointId);
        const angle = (point: Point2) => Math.atan2(point.y - center.y, point.x - center.x);
        const excess = Math.abs(signedSweep(angle(start), angle(end), entity.direction === 'cw')) - Math.PI;
        const radius = Math.hypot(start.x - center.x, start.y - center.y);
        const roundoff = cadRoundoff(8, Math.max(1, ...[center, start, end].flatMap(point => [Math.abs(point.x), Math.abs(point.y)])));
        return { sign: Math.sign(excess), settled: Math.abs(excess) * radius > roundoff };
      };
      // A half circle, such as a slot end, sits on the branch boundary, where coordinate roundoff alone may tip it either
      // way. A flip is only a real branch change when either side lies measurably off the half turn.
      const was = branch(before), now = branch(after);
      if (was.sign !== now.sign && (was.settled || now.settled))
        throw new CadError('sketch-translation-precision', 'Moving this arc here would flip it to the other side of its circle. Try a different distance, or move the geometry nearer the origin first.');
    }
  }
  return translated;
}
