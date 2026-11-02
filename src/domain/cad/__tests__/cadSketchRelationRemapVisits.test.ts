// The remap module loads first, so it binds to the counted registry: the registry reaches it again through the linear pattern's kind,
// and a module loaded during that cycle would bind to the uncounted original.
import { cadSketchPointIdentities, remapCadSketchRelations } from '../sketch-relations/cadSketchRelationRemap';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCadSketchGraph, type CadSketchGraph, type CadSketchGraphRelation } from '../cadSketchGraph';
import { prepareCadSketchExtend, prepareCadSketchTrim } from '../cadSketchTrimExtend';

// Counts each scan of the graph's point identities and each relation the rule reads by the remap module, trim and extend. Relation
// checks and the sketch compile read every relation anyway, so calls from them are not counted.
const visits = vi.hoisted(() => {
  // The frame below the counting wrapper is its caller's.
  const counted = /[\\/](cadSketchRelationRemap|cadSketchTrimExtend)\.ts/;
  return { identities: 0, definitions: 0, counted: (stack: string | undefined) => counted.test(stack?.split('\n')[2] ?? '') };
});
vi.mock('../cadSketchGraphJoints', async load => {
  const actual = await load<typeof import('../cadSketchGraphJoints')>();
  return { ...actual, resolveCadSketchPointIdentities: (graph: CadSketchGraph) => {
    if (visits.counted(new Error().stack)) visits.identities += 1;
    return actual.resolveCadSketchPointIdentities(graph);
  } };
});
vi.mock('../sketch-relations/cadSketchRelationRegistry', async load => {
  const actual = await load<typeof import('../sketch-relations/cadSketchRelationRegistry')>();
  return { ...actual, cadSketchRelationDefinition: (relation: CadSketchGraphRelation) => {
    if (visits.counted(new Error().stack)) visits.definitions += 1;
    return actual.cadSketchRelationDefinition(relation);
  } };
});
beforeEach(() => { visits.identities = 0; visits.definitions = 0; });

/** A 100 mm edge joined at its start to a side, a point held on it, fences to trim and extend to, and 500 squares far away with 2,000 Horizontal and Vertical relations. */
function largeSketch(): CadSketchGraph {
  const points: { id: string; position: [number, number] }[] = [{ id: 'a', position: [0, 0] }, { id: 'b', position: [100, 0] }, { id: 'a2', position: [0, 0] },
    { id: 'c', position: [0, 20] }, { id: 'p', position: [50, 0] }, { id: 'f0', position: [10, -5] }, { id: 'f1', position: [10, 5] },
    { id: 't0', position: [-10, 40] }, { id: 't1', position: [10, 40] }];
  const entities: object[] = [{ id: 'edge', kind: 'line', startPointId: 'a', endPointId: 'b', construction: false },
    { id: 'side', kind: 'line', startPointId: 'a2', endPointId: 'c', construction: false },
    { id: 'fence', kind: 'line', startPointId: 'f0', endPointId: 'f1', construction: true },
    { id: 'top', kind: 'line', startPointId: 't0', endPointId: 't1', construction: true }];
  const relations: object[] = [{ id: 'join', kind: 'coincident', pointIds: ['a', 'a2'] }, { id: 'on', kind: 'point-on-line', pointId: 'p', lineId: 'edge' }];
  for (let k = 0; k < 500; k += 1) {
    const x = 200 + 20 * (k % 25), y = 20 * Math.floor(k / 25), id = (i: number) => `s${k}_${i}`;
    for (let i = 0; i < 4; i += 1) {
      points.push({ id: id(i), position: [x + (i === 1 || i === 2 ? 10 : 0), y + (i >= 2 ? 10 : 0)] });
      entities.push({ id: `${id(i)}_e`, kind: 'line', startPointId: id(i), endPointId: id((i + 1) % 4), construction: false });
      relations.push({ id: `${id(i)}_r`, kind: i % 2 ? 'vertical' : 'horizontal', pointIds: [id(i), id((i + 1) % 4)] });
    }
  }
  return parseCadSketchGraph({ points, entities, relations } as never);
}

describe('remap visits on a large accepted sketch', () => {
  it('reads the whole graph once, then only the relations each later edit touches', () => {
    const graph = largeSketch(), cut = { curves: new Map([['edge', [{ entityId: 'edge', interval: [0, .3], orientation: 'same', ends: ['a', 'cut'] } as const]]]),
      points: new Map([['b', null]]) };
    visits.identities = 0; visits.definitions = 0;
    expect(graph.relations).toHaveLength(2_002);
    const first = remapCadSketchRelations(graph, cut);
    expect(visits.definitions).toBeGreaterThanOrEqual(2_002);
    // The identities, resolved at most once, are kept with the graph for the next edit and for trim and extend.
    expect(visits.identities).toBeLessThanOrEqual(1);
    cadSketchPointIdentities(graph);
    expect(visits.identities).toBe(1);
    visits.identities = 0; visits.definitions = 0;
    expect(remapCadSketchRelations(graph, cut)).toEqual(first);
    expect(visits.identities).toBe(0);
    // The point held on the edge is the one relation touched; the rule reads it to route and resolve it, and checks the Coincident on
    // the edge's start for a direction it might hold. None of the 2,000 other relations is read.
    expect(first.map(item => item.relation.id)).toEqual(['on']);
    expect(visits.definitions).toBeGreaterThan(0);
    expect(visits.definitions).toBeLessThanOrEqual(8);
  });

  it('keeps trim and extend from scanning point identities again on a graph they have seen', () => {
    const graph = largeSketch();
    visits.identities = 0;
    prepareCadSketchTrim({ graph, parameters: {}, entityId: 'edge', parameter: .95 });
    prepareCadSketchExtend({ graph, parameters: {}, entityId: 'side', end: 'end' });
    expect(visits.identities).toBe(1);
    visits.identities = 0;
    prepareCadSketchTrim({ graph, parameters: {}, entityId: 'edge', parameter: .95 });
    prepareCadSketchExtend({ graph, parameters: {}, entityId: 'side', end: 'end' });
    expect(visits.identities).toBe(0);
    // An unaccepted copy is not kept: each read scans it afresh.
    const copy = structuredClone(graph);
    cadSketchPointIdentities(copy); cadSketchPointIdentities(copy);
    expect(visits.identities).toBe(2);
  });
});
