import { describe, expect, it, vi } from 'vitest';
import { checkCadSketchGraph, cadSketchSolvedSlots, parseCadSketchGraph, type CadSketchGenerator, type CadSketchGraph, type CadSketchGraphRelation } from '../cadSketchGraph';
import { cadSketchFixedComponents } from '../cadSketchFixedComponents';
import { cadSketchOwnedGeometryLockReason } from '../cadSketchOwnedGeometry';
import { mapCadSketchGraphScalars } from '../features/cadFeatureScalarMaps';
import * as plugins from '../plugins/cadPlugins';
import { CAD_GEAR_V3_PLUGIN, createCadPluginProfile } from '../plugins/cadPlugins';
import {
  cadSketchGeneratedComponents, cadSketchGeneratorOwner, expandCadSketchGenerators, regenerateCadSketchGenerators, storedCadSketchGraph
} from '../sketch-generators/cadSketchGenerators';
import { compileCadSketchEquations } from '../sketch-solver/compileCadSketchEquations';

const graphOf = (relations: readonly unknown[], points: readonly unknown[] = [], entities: readonly unknown[] = []) => ({ points, entities, relations });
const rectangle = (cornerRadius: number | string = 0, width: number | string = 'w'): CadSketchGenerator => ({ id: 'rect', kind: 'generator', idPrefix: 'g-rect', construction: false,
  geometry: { kind: 'rectangle', x: 0, y: 0, width, height: 10, cornerRadius } });
const polygon = (sides: number | string = 'n', directionId = '@h'): CadSketchGenerator => ({ id: 'poly', kind: 'generator', idPrefix: 'g-poly', construction: false,
  geometry: { kind: 'regular-polygon', x: 0, y: 0, radius: 10, sides, directionId } });
const ids = (graph: CadSketchGraph) => ({ points: graph.points.map(item => item.id), entities: graph.entities.map(item => item.id), relations: graph.relations.map(item => item.id) });
const position = (graph: CadSketchGraph, id: string) => graph.points.find(point => point.id === id)!.position;
const withRelations = (graph: CadSketchGraph, relations: readonly CadSketchGraphRelation[]) => parseCadSketchGraph({ ...graph, relations });

describe('sketch generators', () => {
  it('generate their members from the record alone, with stable ids, fixed in the solve and left out of the stored form', () => {
    const stored = graphOf([rectangle()]), graph = expandCadSketchGenerators(stored, { w: 20 });
    expect(ids(graph)).toEqual({ points: ['g-rect_p0', 'g-rect_p1', 'g-rect_p2', 'g-rect_p3'], entities: ['g-rect_e0', 'g-rect_e1', 'g-rect_e2', 'g-rect_e3'],
      relations: ['rect', 'g-rect_r0', 'g-rect_r1', 'g-rect_r2', 'g-rect_r3'] });
    expect(position(graph, 'g-rect_p2')).toEqual([20, 10]);
    expect(checkCadSketchGraph(graph, { w: 20 })).toEqual([]);
    expect(cadSketchSolvedSlots(graph)).toEqual([]);
    expect(cadSketchFixedComponents(graph).pointIds.has('g-rect_p0')).toBe(true);
    // Members add no equation of their own.
    expect(compileCadSketchEquations({ graph, parameters: { w: 20 } }).equations).toEqual([]);
    expect(storedCadSketchGraph(graph)).toEqual(stored);
    // The same record and inputs give the same frozen members.
    expect(expandCadSketchGenerators(stored, { w: 20 }).entities[0]).toBe(graph.entities[0]);
    expect(expandCadSketchGenerators(graph, { w: 20 })).toBe(graph);
  });

  it('keep each id while the shape keeps its part, and key a part that changes kind anew', () => {
    const narrow = expandCadSketchGenerators(graphOf([rectangle()]), { w: 20 }), wide = regenerateCadSketchGenerators(narrow, { w: 30 });
    expect(ids(wide)).toEqual(ids(narrow));
    expect(position(wide, 'g-rect_p2')).toEqual([30, 10]);
    const rounded = regenerateCadSketchGenerators(withRelations(wide, [rectangle(2), ...wide.relations.slice(1)]), { w: 30 });
    expect(ids(rounded).points).toEqual(['g-rect_t0', 'g-rect_t1', 'g-rect_t2', 'g-rect_t3', 'g-rect_t4', 'g-rect_t5', 'g-rect_t6', 'g-rect_t7', 'g-rect_k0', 'g-rect_k1', 'g-rect_k2', 'g-rect_k3']);
    expect(ids(rounded).entities).toEqual(['g-rect_e0', 'g-rect_a0', 'g-rect_e1', 'g-rect_a1', 'g-rect_e2', 'g-rect_a2', 'g-rect_e3', 'g-rect_a3']);
    expect(checkCadSketchGraph(rounded, { w: 30 })).toEqual([]);
    // A side as short as its two radii leaves, and its arcs meet.
    const pill = expandCadSketchGenerators(graphOf([rectangle(5, 30)]), {});
    expect(ids(pill).entities).toEqual(['g-rect_e0', 'g-rect_a0', 'g-rect_a1', 'g-rect_e2', 'g-rect_a2', 'g-rect_a3']);
    expect(checkCadSketchGraph(pill, {})).toEqual([]);
  });

  it('evaluate a count on every generation, and refuse one out of range naming the generator', () => {
    const five = expandCadSketchGenerators(graphOf([polygon()]), { n: 5 });
    expect(five.entities).toHaveLength(5);
    const seven = regenerateCadSketchGenerators(five, { n: 7 });
    expect(seven.entities).toHaveLength(7);
    expect(regenerateCadSketchGenerators(seven, { n: 5 }).entities.map(entity => entity.id)).toEqual(five.entities.map(entity => entity.id));
    expect(expandCadSketchGenerators(graphOf([polygon(1024)]), {}).entities).toHaveLength(1024);
    for (const sides of [0, 1, 2, 2.5, 1025])
      expect(() => expandCadSketchGenerators(graphOf([polygon(sides)]), {}), String(sides)).toThrow(/Regular polygon "poly" needs a whole number of sides from 3 to 1024/);
    expect(() => regenerateCadSketchGenerators(five, { n: 2 })).toThrow(/Regular polygon "poly"/);
  });

  it('refuse degenerate shapes as the legacy profiles did, naming the generator', () => {
    const slot = { id: 'slot', kind: 'generator', idPrefix: 'g-slot', construction: false, geometry: { kind: 'slot', x: 0, y: 0, length: 10, width: 0, angle: 0 } };
    expect(() => expandCadSketchGenerators(graphOf([slot]), {})).toThrow(/Slot "slot"/);
    // A slot no longer than its width is a circle, as a legacy slot resolved.
    const round = expandCadSketchGenerators(graphOf([{ ...slot, geometry: { ...slot.geometry, width: 10 } }]), {});
    expect(round.entities).toEqual([expect.objectContaining({ id: 'g-slot_c0', kind: 'circle', radius: 5 })]);
    const crossed = { id: 'bow', kind: 'generator', idPrefix: 'g-bow', construction: false, geometry: { kind: 'polygon', points: [[0, 0], [10, 10], [10, 0], [0, 10]] } };
    expect(() => expandCadSketchGenerators(graphOf([crossed]), {})).toThrow(/Polygon "bow"/);
    expect(() => parseCadSketchGraph(graphOf([{ ...crossed, geometry: { kind: 'polygon', points: [[0, 0], [1, 1]] } }]))).toThrow();
  });

  it('keep exact members far from the origin', () => {
    const far = { ...rectangle(0.5, 2), geometry: { ...rectangle(0.5, 2).geometry, x: 900000, y: -900000 } };
    const graph = expandCadSketchGenerators(graphOf([far]), {});
    expect(position(graph, 'g-rect_t0')).toEqual([900000.5, -900000]);
    expect(checkCadSketchGraph(graph, {})).toEqual([]);
  });

  it('follow their direction line, and refuse when it leaves or is one of their own members', () => {
    const angle = Math.PI / 6, line = { points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [Math.cos(angle), Math.sin(angle)] }], entities: [{ id: 'l1', kind: 'line', construction: true, startPointId: 'a', endPointId: 'b' }] };
    const graph = expandCadSketchGenerators(graphOf([polygon(4, 'l1')], line.points, line.entities), {});
    const [x, y] = position(graph, 'g-poly_v0') as [number, number];
    expect(Math.atan2(y, x)).toBeCloseTo(angle, 12);
    expect(graph.relations.filter(relation => relation.kind === 'equal-length')).toHaveLength(3);
    const without = { ...storedCadSketchGraph(graph), points: [], entities: [] };
    expect(() => expandCadSketchGenerators(without, {})).toThrow(/Regular polygon "poly" needs a line/);
    expect(() => expandCadSketchGenerators(graphOf([polygon(4, 'g-poly_e0')]), {})).toThrow(/Regular polygon "poly" cannot generate from its own geometry/);
    // A later generator reads an earlier one's members.
    const chained = expandCadSketchGenerators(graphOf([rectangle(0, 8), { ...polygon(3, 'g-rect_e1'), id: 'tri', idPrefix: 'g-tri' }]), {});
    const [tx, ty] = position(chained, 'g-tri_v0') as [number, number];
    expect(Math.atan2(ty, tx)).toBeCloseTo(Math.PI / 2, 12);
  });

  it('refuse a shared prefix, or a record id among generated members', () => {
    expect(() => expandCadSketchGenerators(graphOf([rectangle(0, 5), { ...polygon(3), idPrefix: 'g-rect' }]), {})).toThrow(/shares its id prefix "g-rect"/);
    expect(() => expandCadSketchGenerators(graphOf([rectangle(0, 5), { ...polygon(3), id: 'g-rect_x' }]), {})).toThrow(/has an id among the generated geometry/);
  });

  it('accept carried members only when they are exactly what the inputs make, naming the generator otherwise', () => {
    const graph = expandCadSketchGenerators(graphOf([rectangle()]), { w: 20 });
    const carried = JSON.parse(JSON.stringify(graph)) as CadSketchGraph;
    expect(ids(expandCadSketchGenerators(carried, { w: 20 }))).toEqual(ids(graph));
    expect(() => expandCadSketchGenerators(carried, { w: 25 })).toThrow(/Rectangle "rect" carries generated geometry that does not match its inputs/);
    const moved = { ...carried, points: carried.points.map(point => point.id === 'g-rect_p1' ? { ...point, position: [21, 0] } : point) };
    expect(() => expandCadSketchGenerators(moved, { w: 20 })).toThrow(/Rectangle "rect" carries generated geometry/);
    const extra = { ...carried, points: [...carried.points, { id: 'g-rect_p9', position: [1, 1] }] };
    expect(() => expandCadSketchGenerators(extra, { w: 20 })).toThrow(/Rectangle "rect" carries generated geometry/);
    // The graph check reports members its inputs no longer make.
    expect(checkCadSketchGraph(graph, { w: 21 })).toEqual([expect.objectContaining({ source: { kind: 'relation', id: 'rect' }, code: 'relation-residual' })]);
  });

  it('take user relations on members through the relation remap: kept members keep them, and one that leaves refuses', () => {
    const user = [{ id: 'u', position: [0, 30] }];
    const relations = [polygon(), { id: 'd0', kind: 'distance', pointIds: ['u', 'g-poly_v0'], value: 3 }, { id: 'd4', kind: 'distance', pointIds: ['u', 'g-poly_v4'], value: 3 }];
    const graph = expandCadSketchGenerators(graphOf(relations, user), { n: 5 });
    const six = regenerateCadSketchGenerators(graph, { n: 6 });
    expect(six.relations.filter(relation => relation.kind === 'distance').map(relation => relation.id)).toEqual(['d0', 'd4']);
    expect(() => regenerateCadSketchGenerators(graph, { n: 4 })).toThrow(/Regular polygon "poly" no longer generates geometry that Distance "d4" uses/);
    // Without the relation on the leaving vertex, the polygon regenerates.
    const kept = withRelations(graph, graph.relations.filter(relation => relation.id !== 'd4'));
    expect(regenerateCadSketchGenerators(kept, { n: 4 }).relations.map(relation => relation.id)).toContain('d0');
  });

  it('generate plugin shapes through the plugin API, once for each set of inputs', () => {
    const resolve = vi.spyOn(plugins, 'resolveCadPluginProfile');
    try {
      const gear = (id: string): CadSketchGenerator => ({ id, kind: 'generator', idPrefix: `g-${id}`, construction: false,
        geometry: { ...createCadPluginProfile(CAD_GEAR_V3_PLUGIN), inputs: { ...createCadPluginProfile(CAD_GEAR_V3_PLUGIN).inputs, teeth: 'teeth' } } as CadSketchGenerator['geometry'] });
      const graph = expandCadSketchGenerators(graphOf([gear('a'), gear('b')]), { teeth: 19 });
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(graph.entities.filter(entity => entity.id.startsWith('g-a_'))).toHaveLength(graph.entities.length / 2);
      expect(checkCadSketchGraph(graph, { teeth: 19 })).toEqual([]);
      regenerateCadSketchGenerators(graph, { teeth: 21 });
      expect(resolve).toHaveBeenCalledTimes(2);
      expect(() => expandCadSketchGenerators(graphOf([gear('a')]), { teeth: 400 })).toThrow(/"a"/);
    } finally { resolve.mockRestore(); }
  });

  it('own their members: an edit of one is refused naming the generator, and other geometry is free', () => {
    const graph = expandCadSketchGenerators(graphOf([rectangle()], [{ id: 'u', position: [1, 2] }]), { w: 20 });
    expect(cadSketchGeneratorOwner(graph, 'g-rect_e2')?.id).toBe('rect');
    expect(cadSketchOwnedGeometryLockReason(graph, { kind: 'entity', id: 'g-rect_e2' })).toMatch(/^Rectangle "rect" generates this geometry/);
    expect(cadSketchOwnedGeometryLockReason(graph, { kind: 'point', id: 'g-rect_p0' })).toMatch(/Rectangle "rect"/);
    expect(cadSketchOwnedGeometryLockReason(graph, { kind: 'point', id: 'u' })).toBeNull();
    expect([...cadSketchGeneratedComponents(graph).relationIds]).toEqual(['g-rect_r0', 'g-rect_r1', 'g-rect_r2', 'g-rect_r3']);
  });

  it('map the generator inputs among the graph scalars, leaving what it made as it is', () => {
    const graph = expandCadSketchGenerators(graphOf([rectangle()]), { w: 20 }), seen: string[] = [];
    const mapped = mapCadSketchGraphScalars(graph, 'graph', (value, path) => { seen.push(path); return value === 'w' ? 'width' : value; });
    expect(seen).toEqual(['graph.relations.0.geometry.x', 'graph.relations.0.geometry.y', 'graph.relations.0.geometry.width', 'graph.relations.0.geometry.height', 'graph.relations.0.geometry.cornerRadius']);
    expect((mapped.relations[0] as CadSketchGenerator).geometry).toMatchObject({ width: 'width' });
    expect(mapped.points).toEqual(graph.points);
  });
});
