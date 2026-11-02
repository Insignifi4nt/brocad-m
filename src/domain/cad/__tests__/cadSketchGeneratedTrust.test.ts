import { describe, expect, it, vi } from 'vitest';
import type { CadDocument, CadSketchFeature } from '../cadDocument';
import { setCadDevelopmentChecks } from '../cadDevelopmentChecks';
import { CadError } from '../cadError';
import { createCadDocument, parseCadDocument } from '../cadSchema';
import { resolveCadSketchRegions, type CadResolvedSketchContour } from '../cadSketchGeometry';
import {
  acceptCadSketchGraphWithMembers, detachCadSketchGraph, trustCadSketchGeneratedItems, type CadSketchGraph, type CadSketchGraphEntity, type CadSketchGraphPoint
} from '../cadSketchGraph';
import { CAD_GEAR_PLUGIN, createCadPluginProfile } from '../plugins/cadPlugins';
import { expandCadSketchGenerators } from '../sketch-generators/cadSketchGenerators';
import * as registry from '../sketch-relations/cadSketchRelationRegistry';

// In production a generator's members, in the lists generation made, are accepted without checking each again; development checks,
// which every other suite runs under, check every item. These tests run both and compare them, and show what the trust is not given to.

/** `run` without development checks, as production runs it. */
function production<T>(run: () => T): T {
  setCadDevelopmentChecks(false);
  try { return run(); } finally { setCadDevelopmentChecks(true); }
}
const outcome = (run: () => string) => { try { return run(); } catch (error) { return error instanceof CadError ? `${error.code}: ${error.message}` : `thrown: ${String(error)}`; } };

const generator = (id: string, geometry: Record<string, unknown>, construction = false) => ({ id, kind: 'generator', idPrefix: id, construction, geometry });
const gearInputs = createCadPluginProfile(CAD_GEAR_PLUGIN).inputs;
const gear = (x: number) => generator('gear', { ...createCadPluginProfile(CAD_GEAR_PLUGIN), inputs: { ...gearInputs, module: 1, teeth: 18, x, y: 0 } });
type Graph = { points: Record<string, unknown>[]; entities: Record<string, unknown>[]; relations: Record<string, unknown>[] };
/** Every kind of generator, apart, beside drawn geometry: a square, a line the hexagon turns with, and a point tied to a generated corner. */
const sketch = (shift = 0): Graph => ({
  points: [{ id: 'a', position: [300 + shift, 0] }, { id: 'b', position: [310 + shift, 0] }, { id: 'c', position: [310 + shift, 10] }, { id: 'd', position: [300 + shift, 10] },
    { id: 'd0', position: [60 + shift, -20] }, { id: 'd1', position: [70 + shift, -15] }, { id: 'tip', position: [30 + shift, 0] }, { id: 'far', position: [30 + shift, -10] }],
  entities: [{ id: 'ab', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' }, { id: 'bc', kind: 'line', construction: false, startPointId: 'b', endPointId: 'c' },
    { id: 'cd', kind: 'line', construction: false, startPointId: 'c', endPointId: 'd' }, { id: 'da', kind: 'line', construction: false, startPointId: 'd', endPointId: 'a' },
    { id: 'dir', kind: 'line', construction: true, startPointId: 'd0', endPointId: 'd1' }, { id: 'stem', kind: 'line', construction: false, startPointId: 'tip', endPointId: 'far' }],
  relations: [
    generator('rect', { kind: 'rectangle', x: shift, y: 0, width: 20, height: 12, cornerRadius: 3 }),
    generator('sharp', { kind: 'rectangle', x: 30 + shift, y: 0, width: 10, height: 10, cornerRadius: 0 }),
    generator('hex', { kind: 'regular-polygon', x: 65 + shift, y: 5, radius: 'side', sides: 6, directionId: 'dir' }),
    generator('slot', { kind: 'slot', x: 100 + shift, y: 5, length: 20, width: 6, angle: 30 }),
    generator('round', { kind: 'circle', x: 130 + shift, y: 5, radius: 4 }, true),
    generator('tri', { kind: 'polygon', points: [[150 + shift, 0], [160 + shift, 0], [155 + shift, 8]], ids: [3, 1, 2] }),
    generator('dee', { kind: 'path', segments: [{ kind: 'line', start: [230 + shift, 0], end: [250 + shift, 0] }, { kind: 'arc', center: [240 + shift, 0], radius: 10, startAngle: 0, sweep: 180 }] }),
    gear(190 + shift),
    { id: 'tie', kind: 'coincident', pointIds: ['sharp_p0', 'tip'] }
  ]
});
const document = (graph: Graph, parameters: Record<string, number> = { side: 5 }) => ({ ...createCadDocument('Trust', 'trust'), schemaVersion: 2, parameters,
  features: [{ id: 'sketch', kind: 'sketch', name: 'Sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph }] });
const sketchOf = (part: CadDocument) => part.features[0] as CadSketchFeature;
/** The accepted graph and regions of `value` as parsed, or its refusal. */
const parsed = (value: unknown) => outcome(() => {
  const part = parseCadDocument(value), feature = sketchOf(part);
  const contour = ({ profile, geometry, depth }: CadResolvedSketchContour) => [profile.id, depth, geometry];
  return JSON.stringify([feature.graph, resolveCadSketchRegions(feature, part.parameters).map(region => [contour(region.boundary), region.voids.map(contour)])]);
});
/** `graph` with `change` made to a copy of it. */
const changed = (change: (graph: Graph) => void, graph = sketch()) => { const copy = structuredClone(graph); change(copy); return copy; };

describe('trusted generated sketch members', () => {
  it('parse each document of generators to the same graph, regions or refusal, trusted in production or checked under development checks', () => {
    const line = (id: string, startPointId: string, endPointId: string) => ({ id, kind: 'line', construction: false, startPointId, endPointId });
    // Each refusal is the last of the sketch's own items in its list, right before the members.
    const documents = [
      document(sketch()),
      document(sketch(5e5)),
      document(changed(graph => graph.entities.push(line('zz', 'a', 'nowhere')))),
      document(changed(graph => graph.entities.push(line('zz', 'a', 'a')))),
      document(changed(graph => graph.points.push({ id: 'a', position: [0, 50] }))),
      document(changed(graph => graph.relations.push({ id: 'zz', kind: 'coincident', pointIds: ['a', 'nowhere'] }))),
      document(changed(graph => graph.relations.push({ id: 'zz', kind: 'coincident', pointIds: ['rect_zz', 'tip'] }))),
      document(changed(graph => graph.relations.push({ id: 'zz', kind: 'coincident', pointIds: ['tip', 'sharp_p1'] }))),
      document(changed(graph => graph.relations.push({ id: 'zz', kind: 'distance', pointIds: ['sharp_p0', 'sharp_p1'], value: 10 }))),
      document(changed(graph => graph.relations.push({ id: 'zz', kind: 'equal-length', lineIds: ['ab', 'sharp_e9'] }))),
      document(changed(graph => graph.relations.push({ id: 'zz', kind: 'equal-length', lineIds: ['ab', 'sharp_e0'] }))),
      document(changed(graph => graph.entities.push(line('zz', 'tip', 'rect_k0')))),
      document(changed(graph => graph.points.push({ id: 'rect_extra', position: [0, 0] }))),
      document(changed(graph => graph.entities.push(line('cross', 'a', 'far')))),
      document(changed(graph => graph.relations.push(generator('over', { kind: 'rectangle', x: 5, y: 5, width: 20, height: 20, cornerRadius: 0 })))),
      document(changed(graph => { (graph.relations[3] as { geometry: Record<string, unknown> }).geometry.length = 0; })),
      document(changed(graph => { (graph.relations[2] as { geometry: Record<string, unknown> }).geometry.sides = 2; })),
      document(sketch(), { side: 0 }),
      document(sketch(), {})
    ];
    const results = (checks: boolean) => {
      setCadDevelopmentChecks(checks);
      try { return documents.map(parsed); } finally { setCadDevelopmentChecks(true); }
    };
    const trusted = results(false), checked = results(true);
    expect(trusted).toEqual(checked);
    // The documents reach every stage: accepted with regions, and refused by acceptance, by generation and by the geometry check.
    expect(trusted[0]).toMatch(/^\[/); expect(trusted[1]).toMatch(/^\[/);
    expect(trusted.filter(result => result.startsWith('['))).toHaveLength(5);
    expect(trusted).toContainEqual(expect.stringMatching(/^invalid-sketch-graph-geometry: /));
    expect(trusted.slice(2, 6).map(result => result.split(':')[0])).toEqual(['missing-sketch-point', 'invalid-sketch-reference', 'duplicate-sketch-id', 'missing-sketch-point']);
    expect(new Set(trusted.map(result => result.split(':')[0])).size).toBeGreaterThan(7);
  });

  it('check a hand-built copy of a generator\'s members in full, and refuse one that changes a member', () => {
    const accepted = production(() => sketchOf(parseCadDocument(document(sketch()))).graph!);
    // Members copied as stored data or an agent would send them: plain objects with the generated ids and shapes.
    const copy = JSON.parse(JSON.stringify(accepted)) as Graph;
    const reparsed = production(() => sketchOf(parseCadDocument(document(copy))).graph!);
    expect(JSON.stringify(reparsed)).toBe(JSON.stringify(accepted));
    // The graph holds the generated members, not the copies.
    const member = (graph: { readonly points: readonly unknown[] }) => graph.points.find(point => (point as CadSketchGraphPoint).id === 'sharp_p1');
    expect(member(reparsed)).toBe(member(accepted)); expect(member(reparsed)).not.toBe(member(copy));
    const moved = changed(graph => { (member(graph) as { position: number[] }).position = [41, 0]; }, copy);
    expect(production(() => parsed(document(moved)))).toMatch(/^stale-sketch-generator: Rectangle "sharp" carries generated geometry that does not match its inputs/);
    const retyped = changed(graph => { (graph.entities.find(entity => entity.id === 'sharp_e0') as { construction: boolean }).construction = true; }, copy);
    expect(production(() => parsed(document(retyped)))).toMatch(/^stale-sketch-generator: Rectangle "sharp"/);
  });

  it('check in full member lists that are not the ones generation made, and an item of the graph\'s own in a generator\'s id namespace', () => {
    const points = trustCadSketchGeneratedItems<CadSketchGraphPoint>([{ id: 'tri_p0', position: [0, 0] }, { id: 'tri_p1', position: [10, 0] }, { id: 'tri_p2', position: [5, 8] }]);
    const edges = (end: string): CadSketchGraphEntity[] => [{ id: 'tri_e0', kind: 'line', construction: false, startPointId: 'tri_p0', endPointId: 'tri_p1' },
      { id: 'tri_e1', kind: 'line', construction: false, startPointId: 'tri_p1', endPointId: 'tri_p2' }, { id: 'tri_e2', kind: 'line', construction: false, startPointId: 'tri_p2', endPointId: end }];
    const entities = trustCadSketchGeneratedItems(edges('tri_p0')), relations = trustCadSketchGeneratedItems([]);
    const own: CadSketchGraph = { points: [{ id: 'a', position: [20, 0] }], entities: [], relations: [] };
    const accept = (graph: CadSketchGraph, members: { points: readonly CadSketchGraphPoint[]; entities: readonly CadSketchGraphEntity[] }) =>
      outcome(() => JSON.stringify(acceptCadSketchGraphWithMembers(graph, [{ idPrefix: 'tri', relations, ...members }])));
    production(() => {
      expect(accept(own, { points, entities })).toMatch(/^\{/);
      // A copy of a generated list, or one that starts with a generated item, is not the list generation made.
      const broken = edges('tri_p9');
      expect(accept(own, { points, entities: broken })).toBe('missing-sketch-point: Sketch graph "tri_e2" references missing point "tri_p9".');
      expect(accept(own, { points, entities: [entities[0], entities[1], broken[2]] })).toBe('missing-sketch-point: Sketch graph "tri_e2" references missing point "tri_p9".');
      expect(accept(own, { points: [...points], entities: [entities[0], entities[1]] })).toMatch(/^\{/);
      // An item of the graph's own with a member's id.
      expect(accept({ ...own, points: [{ id: 'tri_p1', position: [20, 0] }] }, { points, entities })).toBe('duplicate-sketch-id: Duplicate sketch graph identity "tri_p1".');
      // Members generated with another generator's prefix.
      const foreign = trustCadSketchGeneratedItems(edges('tri_p9').map(edge => ({ ...edge, id: `other_${edge.id}` })));
      expect(accept(own, { points, entities: foreign })).toBe('missing-sketch-point: Sketch graph "other_tri_e2" references missing point "tri_p9".');
      // Two generators with one prefix.
      const again = { idPrefix: 'tri', points: trustCadSketchGeneratedItems(points.map(point => ({ ...point }))), entities: trustCadSketchGeneratedItems(edges('tri_p0')), relations };
      expect(outcome(() => JSON.stringify(acceptCadSketchGraphWithMembers(own, [{ idPrefix: 'tri', points, entities, relations }, again]))))
        .toBe('duplicate-sketch-id: Duplicate sketch graph identity "tri_p0".');
    });
    // Trust is only for what generation made: a list trusted with an edge to a missing point is taken as it is in production, and
    // development checks refuse it.
    const trustedBroken = trustCadSketchGeneratedItems(edges('tri_p9'));
    expect(production(() => accept(own, { points, entities: trustedBroken }))).toMatch(/^\{/);
    expect(accept(own, { points, entities: trustedBroken })).toBe('missing-sketch-point: Sketch graph "tri_e2" references missing point "tri_p9".');
  });

  it('keep a graph\'s generated members as the same objects where it holds them in their order, and copy and check everything else', () => {
    const graph = production(() => expandCadSketchGenerators(sketch(), { side: 5 }));
    const generated = (id: string) => /^(rect|sharp|hex|slot|round|tri|dee|gear)_/.test(id);
    // A graph an edit builds from it, with a point added.
    const added = detachCadSketchGraph({ ...graph, points: [...graph.points, { id: 'new', position: [500, 0] }] });
    for (const list of ['points', 'entities', 'relations'] as const) graph[list].forEach((item, at) => {
      expect(added[list][at] === item).toBe(generated(item.id));
      expect(added[list][at]).toEqual(item);
    });
    // An item spliced among a generator's members is checked, and refused here, as it carries a field no point has.
    const at = graph.points.findIndex(point => point.id === 'sharp_p2');
    const spliced = [...graph.points.slice(0, at), { id: 'stray', position: [1, 2], weight: 1 }, ...graph.points.slice(at)];
    expect(outcome(() => JSON.stringify(detachCadSketchGraph({ ...graph, points: spliced })))).toBe('invalid-sketch-graph: Sketch graph must contain complete portable point, entity and relation data.');
    // Members after a gap are copies.
    const gap = detachCadSketchGraph({ ...graph, points: graph.points.filter(point => point.id !== 'sharp_p0') });
    const kept = gap.points.find(point => point.id === 'sharp_p1')!;
    expect(kept).toEqual(graph.points.find(point => point.id === 'sharp_p1')); expect(kept).not.toBe(graph.points.find(point => point.id === 'sharp_p1'));
    expect(gap.points.find(point => point.id === 'rect_k0')).toBe(graph.points.find(point => point.id === 'rect_k0'));
  });

  it('check the relations of the graph\'s own when a document loads in production, and every member\'s too under development checks', () => {
    const checked = (checks: boolean) => {
      const operands = vi.spyOn(registry, 'checkCadSketchRelationOperands');
      setCadDevelopmentChecks(checks);
      try {
        parseCadDocument(document(sketch()));
        return new Set(operands.mock.calls.map(([, relation]) => relation.id));
      } finally { setCadDevelopmentChecks(true); operands.mockRestore(); }
    };
    const trusted = checked(false), all = checked(true);
    expect([...trusted].sort()).toEqual(['dee', 'gear', 'hex', 'rect', 'round', 'sharp', 'slot', 'tie', 'tri']);
    expect([...all].filter(id => id.startsWith('rect_')).length).toBeGreaterThan(4);
  });
});
