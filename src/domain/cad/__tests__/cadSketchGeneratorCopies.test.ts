import { describe, expect, it } from 'vitest';
import type { CadDocument, CadSketchFeature } from '../cadDocument';
import { applyCadEdits, type CadEdit } from '../cadOperations';
import { createCadDocument, parseCadDocument } from '../cadSchema';
import { checkCadSketchGraph, type CadSketchGenerator, type CadSketchGraph } from '../cadSketchGraph';
import { storedCadDocument } from '../cadStoredDocument';
import { expandCadSketchGenerators, regenerateCadSketchGenerators, storedCadSketchGraph } from '../sketch-generators/cadSketchGenerators';

// The circular pattern and the linked offset: generators whose inputs are curves of the sketch, regenerated whenever those move.

const line = (id: string, startPointId: string, endPointId: string, construction = false) => ({ id, kind: 'line', construction, startPointId, endPointId });
const ids = (graph: CadSketchGraph, prefix: string) => ({
  points: graph.points.filter(item => item.id.startsWith(prefix)).map(item => item.id),
  entities: graph.entities.filter(item => item.id.startsWith(prefix)).map(item => item.id),
  relations: graph.relations.filter(item => item.id.startsWith(prefix)).map(item => item.id)
});
const at = (graph: CadSketchGraph, id: string) => graph.points.find(point => point.id === id)!.position as readonly [number, number];
const expectAt = (graph: CadSketchGraph, id: string, x: number, y: number) => {
  const [px, py] = at(graph, id);
  expect(px).toBeCloseTo(x, 9);
  expect(py).toBeCloseTo(y, 9);
};
const refusal = (run: () => unknown) => { try { run(); } catch (error) { return error as { code?: string; message: string; relationIds?: readonly string[] }; } throw new Error('It was accepted.'); };
const documentWith = (graph: unknown, parameters: Record<string, number>): CadDocument => parseCadDocument({ ...createCadDocument('Part', 'part'), schemaVersion: 2, parameters,
  features: [{ id: 'sketch', kind: 'sketch', name: 'Sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph }] });
const graphOf = (document: CadDocument): CadSketchGraph => (document.features.find(feature => feature.id === 'sketch') as CadSketchFeature).graph!;
const edit = (document: CadDocument, ...edits: CadEdit[]) => applyCadEdits(document, edits);

// A line from (x, 0) to (20, 0), held level and measured, and a construction circle about (15, 5).
const seeds = {
  points: [{ id: 'a', position: ['x', 0] }, { id: 'b', position: [20, 0] }, { id: 'k', position: [15, 5] }],
  entities: [line('l1', 'a', 'b'), { id: 'c1', kind: 'circle', construction: true, centerPointId: 'k', radius: 2 }],
  relations: [{ id: 'h', kind: 'horizontal', pointIds: ['a', 'b'] }, { id: 'len', kind: 'reference-dimension', measurement: { kind: 'line-length', entityId: 'l1' } }]
};
const pattern = (count: number | string, angle: number | string = 360, seedIds: readonly string[] = ['l1', 'c1'], centerId = '@origin', idPrefix = 'pat'): CadSketchGenerator => ({
  id: 'pat', kind: 'generator', idPrefix, construction: false, geometry: { kind: 'circular-pattern', seedIds, centerId, count, angle } });
const patterned = (generator: CadSketchGenerator, parameters: Record<string, number> = { x: 10 }, extra: { points?: unknown[]; relations?: unknown[] } = {}) =>
  expandCadSketchGenerators({ points: [...seeds.points, ...extra.points ?? []], entities: seeds.entities, relations: [...seeds.relations, generator, ...extra.relations ?? []] }, parameters);

describe('circular sketch patterns', () => {
  it('copy their seeds about the centre, keyed by occurrence and seed, with the reference dimensions a turn keeps', () => {
    const graph = patterned(pattern(4));
    expect(ids(graph, 'pat_')).toEqual({
      points: ['pat_i1_a', 'pat_i1_b', 'pat_i1_k', 'pat_i2_a', 'pat_i2_b', 'pat_i2_k', 'pat_i3_a', 'pat_i3_b', 'pat_i3_k'],
      entities: ['pat_i1_l1', 'pat_i1_c1', 'pat_i2_l1', 'pat_i2_c1', 'pat_i3_l1', 'pat_i3_c1'],
      relations: ['pat_i1_len', 'pat_i2_len', 'pat_i3_len']
    });
    expectAt(graph, 'pat_i1_a', 0, 10);
    expectAt(graph, 'pat_i2_b', -20, 0);
    expectAt(graph, 'pat_i3_k', 5, -15);
    expect(graph.entities.find(entity => entity.id === 'pat_i1_c1')).toEqual({ id: 'pat_i1_c1', kind: 'circle', construction: true, centerPointId: 'pat_i1_k', radius: 2 });
    expect(graph.entities.find(entity => entity.id === 'pat_i1_l1')).toMatchObject({ construction: false, startPointId: 'pat_i1_a', endPointId: 'pat_i1_b' });
    // A turned line is no longer level: the pattern keeps only what any turn keeps.
    expect(graph.relations.find(relation => relation.id === 'pat_i1_len')).toEqual({ id: 'pat_i1_len', kind: 'reference-dimension', measurement: { kind: 'line-length', entityId: 'pat_i1_l1' } });
    expect(checkCadSketchGraph(graph, { x: 10 })).toEqual([]);
    expect(storedCadSketchGraph(graph).relations).toEqual([...seeds.relations, pattern(4)]);
  });

  it('follow their seeds and evaluate count and angle on every generation', () => {
    const graph = patterned(pattern('n', 'turn'), { x: 10, n: 3, turn: 90 });
    // Three over a quarter turn: the last at its end.
    expectAt(graph, 'pat_i1_a', 10 * Math.SQRT1_2, 10 * Math.SQRT1_2);
    expectAt(graph, 'pat_i2_a', 0, 10);
    const moved = regenerateCadSketchGenerators(graph, { x: 12, n: 3, turn: 90 });
    expectAt(moved, 'pat_i2_a', 0, 12);
    const more = regenerateCadSketchGenerators(graph, { x: 10, n: 5, turn: -360 });
    expect(ids(more, 'pat_').entities).toHaveLength(8);
    expectAt(more, 'pat_i1_a', 10 * Math.cos(-2 * Math.PI / 5), 10 * Math.sin(-2 * Math.PI / 5));
    // About a point of the sketch.
    expectAt(patterned(pattern(2, 180, ['l1'], 'k')), 'pat_i1_a', 20, 10);
  });

  it('bound the count, the angle and the copies, refusing out of range naming the pattern', () => {
    expect(ids(patterned(pattern(1)), 'pat_')).toEqual({ points: [], entities: [], relations: [] });
    for (const count of [0, 2.5, 361]) expect(() => patterned(pattern(count))).toThrow(/Circular pattern "pat" needs a whole number of occurrences from 1 to 360/);
    for (const angle of [0, 400, -361]) expect(() => patterned(pattern(3, angle))).toThrow(/Circular pattern "pat" needs a nonzero angle of at most 360 degrees/);
    const many = Array.from({ length: 12 }, (_, index) => line(`m${index}`, 'a', 'b'));
    expect(() => expandCadSketchGenerators({ points: seeds.points, entities: [...seeds.entities, ...many], relations: [pattern(360, 360, many.map(item => item.id))] }, { x: 10 }))
      .toThrow(/Circular pattern "pat" would copy 4308 curves; a circular pattern copies at most 4096/);
    expect(() => patterned(pattern(2, 360, ['l1'], '@origin', 'p'.repeat(48)))).not.toThrow();
    const long = 'l'.repeat(60);
    expect(() => expandCadSketchGenerators({ points: seeds.points, entities: [line(long, 'a', 'b')], relations: [pattern(2, 360, [long], '@origin', 'p'.repeat(40))] }, { x: 10 }))
      .toThrow(/Circular pattern "pat" cannot name its member "i1_l{60}" within 96 characters/);
  });

  it('refuse a seed that is not a curve of the sketch, or one of its own copies', () => {
    expect(() => patterned(pattern(3, 360, ['gone']))).toThrow(/Circular pattern "pat" needs a curve of the sketch for its seed "gone"/);
    expect(() => patterned(pattern(3, 360, ['pat_i1_l1']))).toThrow(/Circular pattern "pat" cannot generate from its own geometry/);
    expect(() => patterned(pattern(3, 360, ['l1', 'l1']))).toThrow(/Circular pattern "pat" names "l1" twice. A circular pattern copies each seed once/);
  });

  it('copy an earlier generator\'s members, dropping the directions a turn does not keep', () => {
    const rectangle: CadSketchGenerator = { id: 'rect', kind: 'generator', idPrefix: 'r', construction: false, geometry: { kind: 'rectangle', x: 10, y: 0, width: 5, height: 2, cornerRadius: 0 } };
    const graph = expandCadSketchGenerators({ points: [], entities: [], relations: [rectangle, pattern(3, 360, ['r_e0', 'r_e1'])] }, {});
    expect(ids(graph, 'pat_').entities).toEqual(['pat_i1_r_e0', 'pat_i1_r_e1', 'pat_i2_r_e0', 'pat_i2_r_e1']);
    // The two sides share a corner, and so do their copies.
    expect(graph.entities.find(entity => entity.id === 'pat_i1_r_e1')).toMatchObject({ startPointId: 'pat_i1_r_p1' });
    expect(ids(graph, 'pat_').relations).toEqual([]);
    expect(checkCadSketchGraph(graph, {})).toEqual([]);
  });

  it('keep user relations on the occurrences that stay as the count goes down and back up, and remove the rest only when confirmed', () => {
    // A step of 30 degrees whatever the count, so the occurrences that stay keep their places.
    const members = patterned(pattern(4, 90)), stepped = pattern('n', '30 * (n - 1)');
    const user = { points: [{ id: 'u1', position: at(members, 'pat_i1_a') }, { id: 'u3', position: at(members, 'pat_i3_a') }],
      relations: [{ id: 'on1', kind: 'coincident', pointIds: ['u1', 'pat_i1_a'] }, { id: 'on3', kind: 'coincident', pointIds: ['u3', 'pat_i3_a'] }] };
    const document = documentWith({ points: [...seeds.points, ...user.points], entities: seeds.entities, relations: [...seeds.relations, stepped, ...user.relations] }, { x: 10, n: 4 });
    expect(refusal(() => edit(document, { kind: 'set-parameter', name: 'n', value: 3 }))).toMatchObject({ code: 'unconfirmed-sketch-generator-removals', relationIds: ['on3'],
      message: expect.stringMatching(/Circular pattern "pat" no longer generates geometry that .* "on3" uses/) });
    const three = edit(document, { kind: 'set-parameter', name: 'n', value: 3, removedRelationIds: ['on3'] });
    expect(ids(graphOf(three), 'pat_').entities).toEqual(['pat_i1_l1', 'pat_i1_c1', 'pat_i2_l1', 'pat_i2_c1']);
    const back = edit(three, { kind: 'set-parameter', name: 'n', value: 4 });
    expect(ids(graphOf(back), 'pat_')).toEqual(ids(graphOf(document), 'pat_'));
    expect(graphOf(back).points.filter(point => point.id.startsWith('pat_'))).toEqual(graphOf(document).points.filter(point => point.id.startsWith('pat_')));
    // The stored intent: the record and the relation still on occurrence 1.
    expect((storedCadDocument(back).features[0] as CadSketchFeature).graph!.relations).toEqual([...seeds.relations, stepped, user.relations[0]]);
  });

  it('hold their seeds until detached: deleting one is refused', () => {
    const document = documentWith({ ...seeds, relations: [...seeds.relations, pattern(3)] }, { x: 10 });
    expect(refusal(() => edit(document, { kind: 'delete-sketch-elements', sketchId: 'sketch', pointIds: [], entityIds: ['l1'], relationIds: [], cascade: false })).code)
      .toBe('dependent-sketch-element');
  });
});

// A square from (0, 0) to (w, 10), run counterclockwise by l0 to l3, held level and upright, its bottom measured.
const square = {
  points: [{ id: 'p0', position: [0, 0] }, { id: 'p1', position: ['w', 0] }, { id: 'p2', position: ['w', 10] }, { id: 'p3', position: [0, 10] }],
  entities: [line('l0', 'p0', 'p1'), line('l1', 'p1', 'p2'), line('l2', 'p2', 'p3'), line('l3', 'p3', 'p0')],
  relations: [{ id: 'h0', kind: 'horizontal', pointIds: ['p0', 'p1'] }, { id: 'v1', kind: 'vertical', pointIds: ['p1', 'p2'] }, { id: 'h2', kind: 'horizontal', pointIds: ['p2', 'p3'] },
    { id: 'v3', kind: 'vertical', pointIds: ['p3', 'p0'] }, { id: 'bottom', kind: 'distance', pointIds: ['p0', 'p1'], value: 'w' }]
};
const chainOf = (...links: readonly (string | readonly [string, true])[]) => links.map(link => typeof link === 'string' ? { entityId: link, reversed: false } : { entityId: link[0], reversed: true });
const offset = (distance: number | string, chain = chainOf('l0', 'l1', 'l2', 'l3')): CadSketchGenerator => ({ id: 'off', kind: 'generator', idPrefix: 'off', construction: false,
  geometry: { kind: 'offset', chain, distance } });
const offsetOf = (generator: CadSketchGenerator, parameters: Record<string, number> = { w: 10 }, sketch: { points: readonly unknown[]; entities: readonly unknown[]; relations: readonly unknown[] } = square) =>
  expandCadSketchGenerators({ points: sketch.points, entities: sketch.entities, relations: [...sketch.relations, generator] }, parameters);

describe('linked sketch offsets', () => {
  it('offset a closed chain outward, keyed by its links, with the directions an offset keeps', () => {
    const graph = offsetOf(offset(2));
    expect(ids(graph, 'off_')).toEqual({ points: ['off_j_l0', 'off_j_l1', 'off_j_l2', 'off_j_l3'], entities: ['off_e_l0', 'off_e_l1', 'off_e_l2', 'off_e_l3'],
      relations: ['off_r_h0', 'off_r_h2', 'off_r_v1', 'off_r_v3'] });
    expectAt(graph, 'off_j_l3', -2, -2);
    expectAt(graph, 'off_j_l0', 12, -2);
    expectAt(graph, 'off_j_l1', 12, 12);
    expect(graph.entities.find(entity => entity.id === 'off_e_l0')).toMatchObject({ startPointId: 'off_j_l3', endPointId: 'off_j_l0' });
    expect(graph.relations.find(relation => relation.id === 'off_r_h0')).toEqual({ id: 'off_r_h0', kind: 'horizontal', pointIds: ['off_j_l3', 'off_j_l0'] });
    expect(checkCadSketchGraph(graph, { w: 10 })).toEqual([]);
    // Inward, and whichever way the chain runs: positive is outward.
    expectAt(offsetOf(offset(-2)), 'off_j_l3', 2, 2);
    const clockwise = offsetOf(offset(2, chainOf(['l3', true], ['l2', true], ['l1', true], ['l0', true])));
    expectAt(clockwise, 'off_j_l3', -2, 12);
    expectAt(clockwise, 'off_j_l0', -2, -2);
    expect(checkCadSketchGraph(clockwise, { w: 10 })).toEqual([]);
  });

  it('regenerate as the chain moves, and keep their ids wherever the chain starts', () => {
    const graph = offsetOf(offset('gap'), { w: 10, gap: 2 });
    const wider = regenerateCadSketchGenerators(graph, { w: 20, gap: 2 });
    expectAt(wider, 'off_j_l0', 22, -2);
    expect(ids(wider, 'off_')).toEqual(ids(graph, 'off_'));
    expectAt(regenerateCadSketchGenerators(graph, { w: 10, gap: 3 }), 'off_j_l0', 13, -3);
    const rotated = offsetOf(offset(2, chainOf('l2', 'l3', 'l0', 'l1')));
    expect(new Set(ids(rotated, 'off_').points)).toEqual(new Set(ids(graph, 'off_').points));
    expectAt(rotated, 'off_j_l0', 12, -2);
  });

  it('refuse an open, crossing or too small chain with the reason, naming the offset', () => {
    expect(() => offsetOf(offset(2, chainOf('l0', 'l1', 'l2')))).toThrow(/Offset "off" needs a closed chain, but "l2" does not end where "l0" starts/);
    expect(() => offsetOf(offset(2, chainOf('l0', 'l2', 'l1', 'l3')))).toThrow(/Offset "off" needs a closed chain/);
    const bow = { points: [{ id: 'q0', position: [0, 0] }, { id: 'q1', position: [20, 10] }, { id: 'q2', position: [20, 0] }, { id: 'q3', position: [0, 4] }],
      entities: [line('m0', 'q0', 'q1'), line('m1', 'q1', 'q2'), line('m2', 'q2', 'q3'), line('m3', 'q3', 'q0')], relations: [] };
    expect(() => offsetOf(offset(1, chainOf('m0', 'm1', 'm2', 'm3')), {}, bow)).toThrow(/Offset "off" needs a simple closed chain: Path "chain" intersects itself/);
    expect(() => offsetOf(offset(-6))).toThrow(/Offset "off"/);
    expect(() => offsetOf(offset(0))).toThrow(/Offset "off" needs a nonzero distance/);
    expect(() => offsetOf(offset(2, chainOf('l0', 'gone', 'l2', 'l3')))).toThrow(/Offset "off" needs a curve of the sketch for its chain curve "gone"/);
  });

  it('offset a lone circle, and carry the smooth joints of a chain with arcs', () => {
    const ring = { points: [{ id: 'o', position: [5, 5] }], entities: [{ id: 'cc', kind: 'circle', construction: false, centerPointId: 'o', radius: 3 }], relations: [] };
    const circle = offsetOf(offset(2, chainOf('cc')), {}, ring);
    expect(circle.entities.find(entity => entity.id === 'off_e_cc')).toEqual({ id: 'off_e_cc', kind: 'circle', construction: false, centerPointId: 'off_c_cc', radius: 5 });
    expectAt(circle, 'off_c_cc', 5, 5);
    // The reason a detached offset of the circle gives, with its code, named for the generator.
    let collapsed: unknown;
    try { offsetOf(offset(-3, chainOf('cc')), {}, ring); } catch (error) { collapsed = error; }
    expect(collapsed).toMatchObject({ code: 'unsupported-sketch-offset', message: 'Offset "off": The offset collapses a circular support or exceeds the supported radius.' });
    expect(() => offsetOf(offset(1, chainOf('cc', 'l0')), { w: 10 }, { ...square, points: [...square.points, ...ring.points], entities: [...square.entities, ...ring.entities] }))
      .toThrow(/Offset "off" needs a circle alone, or a chain of curves with ends/);
    const slot = {
      points: [{ id: 't0', position: [0, -5] }, { id: 't1', position: [10, -5] }, { id: 't2', position: [10, 5] }, { id: 't3', position: [0, 5] }, { id: 'k0', position: [0, 0] }, { id: 'k1', position: [10, 0] }],
      entities: [line('s0', 't0', 't1'), { id: 'a0', kind: 'arc', construction: false, centerPointId: 'k1', startPointId: 't1', endPointId: 't2', direction: 'ccw' },
        line('s1', 't2', 't3'), { id: 'a1', kind: 'arc', construction: false, centerPointId: 'k0', startPointId: 't3', endPointId: 't0', direction: 'ccw' }],
      relations: [{ id: 'j0', kind: 'tangent-joint', endpoints: [{ entityId: 's0', pointId: 't1' }, { entityId: 'a0', pointId: 't1' }] },
        { id: 'j1', kind: 'tangent-joint', endpoints: [{ entityId: 'a0', pointId: 't2' }, { entityId: 's1', pointId: 't2' }] }]
    };
    const graph = offsetOf(offset(1, chainOf('s0', 'a0', 's1', 'a1')), {}, slot);
    expect(graph.entities.find(entity => entity.id === 'off_e_a0')).toEqual({ id: 'off_e_a0', kind: 'arc', construction: false, centerPointId: 'off_c_a0',
      startPointId: 'off_j_s0', endPointId: 'off_j_a0', direction: 'ccw' });
    expectAt(graph, 'off_j_s0', 10, -6);
    expectAt(graph, 'off_c_a0', 10, 0);
    expect(ids(graph, 'off_').relations).toEqual(['off_r_j0', 'off_r_j1']);
    expect(graph.relations.find(relation => relation.id === 'off_r_j0')).toEqual({ id: 'off_r_j0', kind: 'tangent-joint',
      endpoints: [{ entityId: 'off_e_s0', pointId: 'off_j_s0' }, { entityId: 'off_e_a0', pointId: 'off_j_s0' }] });
    expect(checkCadSketchGraph(graph, {})).toEqual([]);
  });

  it('hold their chain until detached: deleting a link is refused', () => {
    const document = documentWith({ ...square, relations: [...square.relations, offset(2)] }, { w: 10 });
    expect(refusal(() => edit(document, { kind: 'delete-sketch-elements', sketchId: 'sketch', pointIds: [], entityIds: ['l2'], relationIds: [], cascade: false })).code)
      .toBe('dependent-sketch-element');
  });
});
