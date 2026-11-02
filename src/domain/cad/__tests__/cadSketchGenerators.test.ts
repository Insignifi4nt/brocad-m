import { describe, expect, it, vi } from 'vitest';
import { checkCadSketchGraph, cadSketchSolvedSlots, parseCadSketchGraph, type CadSketchGenerator, type CadSketchGraph, type CadSketchGraphRelation } from '../cadSketchGraph';
import { cadSketchFixedComponents } from '../cadSketchFixedComponents';
import { cadSketchOwnedGeometryLockReason } from '../cadSketchOwnedGeometry';
import { mapCadSketchGraphScalars } from '../features/cadFeatureScalarMaps';
import * as plugins from '../plugins/cadPlugins';
import { CAD_GEAR_PLUGIN, CAD_GEAR_V3_PLUGIN, CAD_STAR_PLUGIN, createCadPluginProfile, type CadPluginPackage } from '../plugins/cadPlugins';
import * as analyticSegments from '../cadAnalyticSegments';
import type { CadSketchFeature } from '../cadDocument';
import { resolveCadSketchContours } from '../cadSketchGeometry';
import {
  cadSketchGeneratedComponents, cadSketchGeneratorOwner, expandCadSketchGenerators, regenerateCadSketchGenerators, storedCadSketchGraph
} from '../sketch-generators/cadSketchGenerators';
import { CAD_SKETCH_GENERATOR_KINDS } from '../sketch-generators/cadSketchGeneratorKinds';
import { compileCadSketchEquations } from '../sketch-solver/compileCadSketchEquations';
import { createCadDocument, parseCadDocument } from '../cadSchema';
import { compileCadSketchGeometry } from '../compileCadSketchGeometry';

const graphOf = (relations: readonly unknown[], points: readonly unknown[] = [], entities: readonly unknown[] = []) => ({ points, entities, relations });
const rectangle = (cornerRadius: number | string = 0, width: number | string = 'w'): CadSketchGenerator => ({ id: 'rect', kind: 'generator', idPrefix: 'g-rect', construction: false,
  geometry: { kind: 'rectangle', x: 0, y: 0, width, height: 10, cornerRadius } });
const polygon = (sides: number | string = 'n', directionId = '@h'): CadSketchGenerator => ({ id: 'poly', kind: 'generator', idPrefix: 'g-poly', construction: false,
  geometry: { kind: 'regular-polygon', x: 0, y: 0, radius: 10, sides, directionId } });
const ids = (graph: CadSketchGraph) => ({ points: graph.points.map(item => item.id), entities: graph.entities.map(item => item.id), relations: graph.relations.map(item => item.id) });
const position = (graph: CadSketchGraph, id: string) => graph.points.find(point => point.id === id)!.position;
const withRelations = (graph: CadSketchGraph, relations: readonly CadSketchGraphRelation[]) => parseCadSketchGraph({ ...graph, relations });
const pluginOf = (plugin: CadPluginPackage, inputs: Readonly<Record<string, number | string>>): CadSketchGenerator => ({ id: 'gear', kind: 'generator', idPrefix: 'g',
  construction: false, geometry: { ...createCadPluginProfile(plugin), inputs: { ...createCadPluginProfile(plugin).inputs, ...inputs } } as CadSketchGenerator['geometry'] });
const entityOf = (graph: CadSketchGraph, id: string) => graph.entities.find(entity => entity.id === id);
const userRelations = (graph: CadSketchGraph) => graph.relations.filter(relation => relation.kind !== 'generator');

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
      expect(() => expandCadSketchGenerators(graphOf([polygon(sides)]), {}), String(sides)).toThrow(`Regular polygon "poly" needs a whole number of sides from 3 to 1024, and it has ${sides}.`);
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

  it('key a gear by tooth and part, so the teeth that stay keep their members and the user relations on them as the count changes', () => {
    // A free point and circle tied to tooth 3's tip arc and its ends, the base of its right flank, and the root arc after tooth 5.
    const points = [{ id: 'u', position: [80, 0] }, { id: 'o', position: [0, 80] }];
    const entities = [{ id: 'ring', kind: 'circle', construction: false, centerPointId: 'o', radius: 5 }];
    const ties = [{ id: 'tip-end', kind: 'distance', pointIds: ['u', 'g_t3_tipL'], value: 5 }, { id: 'flank-base', kind: 'distance', pointIds: ['u', 'g_t3_baseR'], value: 5 },
      { id: 'tip-size', kind: 'equal-radius', curveIds: ['ring', 'g_t3_tip'] }, { id: 'on-root', kind: 'point-on-curve', pointId: 'o', curveId: 'g_t5_root' }];
    const last = { id: 'last-tip', kind: 'distance', pointIds: ['u', 'g_t17_tipR'], value: 5 };
    const z18 = expandCadSketchGenerators(graphOf([pluginOf(CAD_GEAR_V3_PLUGIN, { teeth: 'z' }), ...ties, last], points, entities), { z: 18 });
    expect(entityOf(z18, 'g_t3_tip')).toMatchObject({ kind: 'arc', centerPointId: 'g_t3_tipC', startPointId: 'g_t3_tipL', endPointId: 'g_t3_tipR' });
    expect(entityOf(z18, 'g_t5_root')).toMatchObject({ kind: 'arc', startPointId: 'g_t5_rootR', endPointId: 'g_t6_rootL' });
    expect(entityOf(z18, 'g_t17_root')).toMatchObject({ endPointId: 'g_t0_rootL' });
    // Seventeen teeth leave tooth 17, and the relation on it refuses, naming the gear and the relation.
    expect(() => regenerateCadSketchGenerators(z18, { z: 17 })).toThrow(/Spur gear "gear" no longer generates geometry that Distance "last-tip" uses/);
    const kept = withRelations(z18, z18.relations.filter(relation => relation.id !== 'last-tip'));
    const z17 = regenerateCadSketchGenerators(kept, { z: 17 });
    // Tooth 3 is tooth 3 still, its tip the arc between the same ends, and every relation on it stays as it was.
    expect(userRelations(z17)).toEqual(userRelations(kept));
    expect(entityOf(z17, 'g_t3_tip')).toMatchObject({ kind: 'arc', startPointId: 'g_t3_tipL', endPointId: 'g_t3_tipR' });
    expect(entityOf(z17, 'g_t16_root')).toMatchObject({ endPointId: 'g_t0_rootL' });
    expect(z17.entities.some(entity => entity.id.startsWith('g_t17_'))).toBe(false);
    // Back to eighteen, the gear is again exactly what it was, members and ids, with the relations on it.
    const back = regenerateCadSketchGenerators(z17, { z: 18 });
    expect(ids(back)).toEqual(ids(kept));
    expect(back.points).toEqual(kept.points);
    expect(userRelations(back)).toEqual(userRelations(kept));
  });

  it('key a resampled flank\'s chords anew, keeping its ends, the tip and the root, and take relations on old chords through the remap', () => {
    const points = [{ id: 'u', position: [80, 0] }, { id: 'a', position: [0, 80] }, { id: 'b', position: [10, 90] }, { id: 'o', position: [0, -80] }];
    const entities = [{ id: 'free', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' }, { id: 'ring', kind: 'circle', construction: false, centerPointId: 'o', radius: 5 }];
    const gear = pluginOf(CAD_GEAR_V3_PLUGIN, { qualityMode: 1, tolerance: 'tol' });
    const coarse = expandCadSketchGenerators(graphOf([gear], points, entities), { tol: 0.01 });
    const chord = (graph: CadSketchGraph) => graph.entities.find(entity => /^g_t2_flankL\d+s1$/.test(entity.id))!.id;
    const ties = [{ id: 'flank-tip', kind: 'distance', pointIds: ['u', 'g_t2_tipL'], value: 5 }, { id: 'flank-base', kind: 'distance', pointIds: ['u', 'g_t2_baseL'], value: 5 },
      { id: 'tip-size', kind: 'equal-radius', curveIds: ['ring', 'g_t2_tip'] }, { id: 'on-root', kind: 'point-on-curve', pointId: 'o', curveId: 'g_t2_root' }];
    const along = { id: 'along', kind: 'parallel', lineIds: ['free', chord(coarse)] };
    const tied = withRelations(coarse, [...coarse.relations, ...ties, along] as CadSketchGraphRelation[]);
    expect(() => regenerateCadSketchGenerators(tied, { tol: 0.001 })).toThrow(/Spur gear "gear" no longer generates geometry that Parallel "along" uses/);
    const fine = regenerateCadSketchGenerators(withRelations(tied, tied.relations.filter(relation => relation.id !== 'along')), { tol: 0.001 });
    expect(chord(fine)).not.toBe(chord(coarse));
    expect(fine.entities.length).toBeGreaterThan(coarse.entities.length);
    expect(userRelations(fine).map(relation => relation.id)).toEqual(['flank-tip', 'flank-base', 'tip-size', 'on-root']);
    expect(entityOf(fine, 'g_t2_tip')).toMatchObject({ startPointId: 'g_t2_tipL' });
  });

  it('key a recipe by repetition and point, so repetitions that stay keep their members as the count changes', () => {
    const points = [{ id: 'u', position: [80, 0] }];
    const ties = [{ id: 'lobe-2', kind: 'distance', pointIds: ['u', 'g_r2_v1'], value: 5 }, { id: 'lobe-7', kind: 'distance', pointIds: ['u', 'g_r7_v0'], value: 5 }];
    const eight = expandCadSketchGenerators(graphOf([pluginOf(CAD_STAR_PLUGIN, { lobes: 'k' }), ...ties], points), { k: 8 });
    expect(entityOf(eight, 'g_r7_e1')).toMatchObject({ startPointId: 'g_r7_v1', endPointId: 'g_r0_v0' });
    expect(() => regenerateCadSketchGenerators(eight, { k: 7 })).toThrow(/Star profile "gear" no longer generates geometry that Distance "lobe-7" uses/);
    const kept = withRelations(eight, eight.relations.filter(relation => relation.id !== 'lobe-7'));
    const seven = regenerateCadSketchGenerators(kept, { k: 7 });
    expect(userRelations(seven)).toEqual(userRelations(kept));
    expect(entityOf(seven, 'g_r6_e1')).toMatchObject({ startPointId: 'g_r6_v1', endPointId: 'g_r0_v0' });
    expect(ids(regenerateCadSketchGenerators(seven, { k: 8 }))).toEqual(ids(kept));
  });

  it('generate plugin shapes through the plugin API, once for each set of inputs', () => {
    const resolve = vi.spyOn(plugins, 'resolveCadPluginOutline');
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

  it('generate each pinned package\'s own outline, so an updated package with the same inputs is not drawn from the earlier one', () => {
    const turned = (offset: number) => [`innerRadius * cos((index + ${offset}) * 2 * pi / count)`, `innerRadius * sin((index + ${offset}) * 2 * pi / count)`] as const;
    const updated: CadPluginPackage = { ...CAD_STAR_PLUGIN, version: '1.1.0', generator: { kind: 'polygon-recipe', repeat: 'lobes', points: [
      ['outerRadius * cos(index * 2 * pi / count)', 'outerRadius * sin(index * 2 * pi / count)'], [...turned(0.25)]] } };
    const inner = (plugin: CadPluginPackage) => position(expandCadSketchGenerators(graphOf([pluginOf(plugin, {})]), {}), 'g_r0_v1');
    const at = (offset: number) => [20 * Math.cos(offset * Math.PI / 4), 20 * Math.sin(offset * Math.PI / 4)];
    for (const [plugin, offset] of [[CAD_STAR_PLUGIN, 0.5], [updated, 0.25], [CAD_STAR_PLUGIN, 0.5]] as const) {
      inner(plugin).forEach((value, axis) => expect(value).toBeCloseTo(at(offset)[axis], 9));
    }
  });

  it('are evaluated once for each check of a graph, however many generators it holds', () => {
    const hexagons = Array.from({ length: 200 }, (_, at): CadSketchGenerator => ({ id: `h${at}`, kind: 'generator', idPrefix: `g-h${at}`, construction: false,
      geometry: { kind: 'regular-polygon', x: (at % 20) * 30, y: Math.floor(at / 20) * 30, radius: 'r', sides: 6, directionId: '@h' } }));
    const graph = expandCadSketchGenerators(graphOf(hexagons), { r: 10 });
    const evaluate = vi.spyOn(CAD_SKETCH_GENERATOR_KINDS['regular-polygon'], 'evaluate');
    try {
      // The graph its generators settled with those parameters needs no generation at all.
      expect(checkCadSketchGraph(graph, { r: 10 })).toEqual([]);
      expect(evaluate).not.toHaveBeenCalled();
      // Another value regenerates nothing here, and the check reports every polygon its inputs no longer make, still evaluating each once.
      evaluate.mockClear();
      expect(checkCadSketchGraph(graph, { r: 11 })).toHaveLength(200);
      expect(evaluate.mock.calls.length).toBeLessThanOrEqual(400);
      // A copy that is not the settled graph is checked through one generation of all its generators.
      const copy = parseCadSketchGraph(JSON.parse(JSON.stringify(graph)));
      evaluate.mockClear();
      expect(checkCadSketchGraph(copy, { r: 10 })).toEqual([]);
      expect(evaluate.mock.calls.length).toBeLessThanOrEqual(200);
      // A generator that cannot generate is reported on itself and on those after it, which read what it would make, as before.
      evaluate.mockClear();
      const refused = checkCadSketchGraph(graph, { r: -1 });
      expect(refused).toHaveLength(200);
      expect(refused.every(issue => issue.code === 'invalid-expression' && issue.message.includes('"h0"'))).toBe(true);
      expect(evaluate.mock.calls.length).toBeLessThanOrEqual(2);
    } finally { evaluate.mockRestore(); }
  });

  it('are evaluated once each when a document that stores them alone loads, and its outlines read those evaluations', () => {
    const hexagons = Array.from({ length: 200 }, (_, at): CadSketchGenerator => ({ id: `h${at}`, kind: 'generator', idPrefix: `g-h${at}`, construction: false,
      geometry: { kind: 'regular-polygon', x: (at % 20) * 30, y: Math.floor(at / 20) * 30, radius: 'r', sides: 6, directionId: '@h' } }));
    const stored = JSON.stringify({ ...createCadDocument('Hexagons', 'hexagons'), schemaVersion: 2, parameters: { r: 10 }, features: [{ id: 'sketch', kind: 'sketch',
      name: 'Sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: graphOf(hexagons) }] });
    const evaluate = vi.spyOn(CAD_SKETCH_GENERATOR_KINDS['regular-polygon'], 'evaluate');
    try {
      const document = parseCadDocument(JSON.parse(stored)), sketch = document.features[0];
      if (sketch.kind !== 'sketch') throw new Error('Expected the sketch');
      expect(evaluate).toHaveBeenCalledTimes(200);
      evaluate.mockClear();
      // The load checked each hexagon as its own shape, from the evaluation that generated it, and kept that for later readers.
      expect(compileCadSketchGeometry(sketch, document.parameters).profiles.map(profile => profile.generatorId).sort()).toEqual(hexagons.map(hexagon => hexagon.id).sort());
      expect(evaluate).not.toHaveBeenCalled();
    } finally { evaluate.mockRestore(); }
  });

  it('refuse to generate from an evaluation that disagrees with whether its kind draws a checked outline', () => {
    // The crossing check skips comparing an outline kind's members with one another, so a kind that stopped checking its outline is caught.
    const real = CAD_SKETCH_GENERATOR_KINDS.rectangle.evaluate;
    const evaluate = vi.spyOn(CAD_SKETCH_GENERATOR_KINDS.rectangle, 'evaluate').mockImplementation((...args) => ({ ...real(...args), shape: undefined }));
    try { expect(() => expandCadSketchGenerators(graphOf([rectangle(0, 37.25)]), {})).toThrow("A rectangle generator's outline check disagrees with its kind."); }
    finally { evaluate.mockRestore(); }
  });

  it('prepare each outline once, when its kind checks the shape, and the sketch contours read that preparation', () => {
    const gears = Array.from({ length: 3 }, (_, at): CadSketchGenerator => {
      const gear = createCadPluginProfile(CAD_GEAR_PLUGIN);
      return { id: `gear${at}`, kind: 'generator', idPrefix: `g-gear${at}`, construction: false, geometry: { ...gear, inputs: { ...gear.inputs, x: at * 100 } } };
    });
    const document = parseCadDocument({ ...createCadDocument('Gears', 'gears'), schemaVersion: 2, features: [{ id: 'sketch', kind: 'sketch',
      name: 'Sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: graphOf(gears) }] }), sketch = document.features[0] as CadSketchFeature;
    const first = resolveCadSketchContours(sketch, document.parameters), prepare = vi.spyOn(analyticSegments, 'cadAnalyticSegments');
    try {
      const again = resolveCadSketchContours(sketch, document.parameters);
      expect(again.map(contour => contour.profile.generatorId)).toEqual(['gear0', 'gear1', 'gear2']);
      expect(prepare).not.toHaveBeenCalled();
      again.forEach((contour, at) => expect(contour.geometry).toBe(first[at].geometry));
    } finally { prepare.mockRestore(); }
  });

  it('keep the shape each evaluation checked for its outline and its members, after many other shapes were checked', () => {
    const kind = CAD_SKETCH_GENERATOR_KINDS['regular-polygon'], context = { parameters: {}, line: () => ({ start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }), point: () => undefined, curve: () => undefined, relationsAmong: () => [] };
    const hexagon = (x: number) => ({ kind: 'regular-polygon' as const, x, y: 0, radius: 10, sides: 6, directionId: '@h' });
    const evaluation = kind.evaluate(hexagon(0), context, 'Hexagon'), shape = evaluation.shape!();
    for (let at = 1; at <= 300; at++) kind.evaluate(hexagon(at * 30), context, 'Other').shape!();
    expect(evaluation.shape!()).toBe(shape);
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
