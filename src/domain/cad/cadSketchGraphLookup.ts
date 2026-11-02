import type { CadSketchGraph, CadSketchGraphEntity, CadSketchGraphPoint } from './cadSketchGraph';

// Points and edges by id. The parse and each relation check look operands up by id; a scan for each would make a graph with many
// generated members quadratic to check. A frozen list cannot change, so its index is kept with it; a list that may still change is
// scanned.

const pointIndexes = new WeakMap<readonly CadSketchGraphPoint[], ReadonlyMap<string, CadSketchGraphPoint>>();
const entityIndexes = new WeakMap<readonly CadSketchGraphEntity[], ReadonlyMap<string, CadSketchGraphEntity>>();
function indexed<T extends { readonly id: string }>(indexes: WeakMap<readonly T[], ReadonlyMap<string, T>>, list: readonly T[]): ReadonlyMap<string, T> | undefined {
  if (!Object.isFrozen(list) || list.length < 16) return undefined;
  let index = indexes.get(list);
  if (!index) {
    const map = new Map<string, T>();
    // The first of a repeated id, as a scan finds it.
    for (const item of list) if (!map.has(item.id)) map.set(item.id, item);
    indexes.set(list, index = map);
  }
  return index;
}
export function cadSketchGraphPoint(graph: Pick<CadSketchGraph, 'points'>, id: string): CadSketchGraphPoint | undefined {
  const index = indexed(pointIndexes, graph.points);
  return index ? index.get(id) : graph.points.find(point => point.id === id);
}
export function cadSketchGraphEntity(graph: Pick<CadSketchGraph, 'entities'>, id: string): CadSketchGraphEntity | undefined {
  const index = indexed(entityIndexes, graph.entities);
  return index ? index.get(id) : graph.entities.find(entity => entity.id === id);
}
