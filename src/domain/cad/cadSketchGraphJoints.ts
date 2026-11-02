import { CadError } from './cadError';
import { cadPathClosureTolerance } from './cadAnalyticSegments';
import type { CadSketchGraph } from './cadSketchGraph';
import type { Point2 } from '@/domain/path-intel/types';
import { isCadSketchVirtualId } from './sketch-relations/cadSketchVirtualElements';

/** Declared source identities only; numeric intent may still be unsolved. */
export function resolveCadSketchPointIdentities(graph: CadSketchGraph): (pointId: string) => string {
  // The origin and the axes are their own identity: nothing stored joins them, since a point at the origin is stored as its coordinates.
  if (!graph.relations.some(relation => relation.kind === 'coincident')) return id => id;
  const parents = new Map(graph.points.map(point => [point.id, point.id]));
  const parentOf = (id: string): string => {
    const parent = parents.get(id);
    if (parent === undefined) return isCadSketchVirtualId(id) ? id : fail(id);
    return parent;
  };
  const fail = (id: string): never => { throw new CadError('missing-sketch-point', `Sketch point "${id}" is missing.`); };
  const root = (id: string): string => {
    let current = id;
    for (let parent = parentOf(current); parent !== current; parent = parentOf(current)) current = parent;
    while (id !== current) { const previous = parentOf(id); parents.set(id, current); id = previous; }
    return current;
  };
  for (const relation of graph.relations) if (relation.kind === 'coincident') {
    const a = root(relation.pointIds[0]), b = root(relation.pointIds[1]);
    if (a !== b) parents.set(a < b ? b : a, a < b ? a : b);
  }
  return root;
}

/**
 * Transient connectivity of validated source identities; never substitutes a point's coordinates. `identities` is the graph's point
 * identities, when the caller has them already.
 */
export function resolveCadSketchGraphJoints(graph: CadSketchGraph, points: ReadonlyMap<string, Point2>,
  identities?: (pointId: string) => string): (pointId: string) => string {
  const root = identities ?? resolveCadSketchPointIdentities(graph);
  const groups = new Map<string, Point2[]>();
  for (const [id, point] of points) {
    const key = root(id), group = groups.get(key) ?? [];
    group.push(point); groups.set(key, group);
  }
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const point of members) { minX = Math.min(minX, point.x); minY = Math.min(minY, point.y); maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y); }
    if (Math.hypot(maxX - minX, maxY - minY) <= cadPathClosureTolerance(members)) continue;
    for (let left = 0; left < members.length; left++) for (let right = left + 1; right < members.length; right++) {
      const a = members[left], b = members[right];
      if (Math.hypot(a.x - b.x, a.y - b.y) > cadPathClosureTolerance([a, b])) {
        throw new CadError('sketch-graph-precision', 'Points that should meet are too far apart to join. Move them together or remove the coincidence.');
      }
    }
  }
  return root;
}
