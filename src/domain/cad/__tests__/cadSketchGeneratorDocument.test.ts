import { describe, expect, it } from 'vitest';
import type { CadDocument, CadSketchFeature } from '../cadDocument';
import { applyCadEdits, type CadEdit } from '../cadOperations';
import { createCadDocument, parseCadDocument } from '../cadSchema';
import type { CadSketchGenerator, CadSketchGraph } from '../cadSketchGraph';
import { storedCadDocument, storedCadDocumentText } from '../cadStoredDocument';
import { cadSketchOwnedGeometryLockReason } from '../cadSketchOwnedGeometry';
import { expandCadSketchGenerators } from '../sketch-generators/cadSketchGenerators';
import { CAD_GEAR_V3_PLUGIN, createCadPluginProfile } from '../plugins/cadPlugins';
import { cadSketchProfileEdits, cadSketchProfileViews } from '../sketch-generators/cadSketchProfileViews';
import { CadSession } from '../../../features/cad/cadSession';

const rectangle = (width: number | string = 'w'): CadSketchGenerator => ({ id: 'rect', kind: 'generator', idPrefix: 'g-rect', construction: false,
  geometry: { kind: 'rectangle', x: 0, y: 0, width, height: 10, cornerRadius: 0 } });
const polygon = (sides: number | string = 'n'): CadSketchGenerator => ({ id: 'poly', kind: 'generator', idPrefix: 'g-poly', construction: false,
  geometry: { kind: 'regular-polygon', x: 0, y: 0, radius: 10, sides, directionId: '@h' } });
const documentWith = (graph: unknown, parameters: Record<string, number> = { w: 20 }): CadDocument => parseCadDocument({ ...createCadDocument('Part', 'part'), schemaVersion: 2, parameters,
  features: [{ id: 'sketch', kind: 'sketch', name: 'Sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph }] });
const graphOf = (document: CadDocument): CadSketchGraph => (document.features.find(feature => feature.id === 'sketch') as CadSketchFeature).graph!;
const position = (document: CadDocument, id: string) => graphOf(document).points.find(point => point.id === id)?.position;
const edit = (document: CadDocument, ...edits: CadEdit[]) => applyCadEdits(document, edits);
const refusal = (run: () => unknown) => { try { run(); } catch (error) { return error as { code?: string; message: string }; } throw new Error('The edit was accepted.'); };

describe('sketch generators in a document', () => {
  it('save the record alone, regenerate the members on load and compare drafts by the stored form', () => {
    const document = documentWith({ points: [], entities: [], relations: [rectangle()] });
    expect(position(document, 'g-rect_p2')).toEqual([20, 10]);
    const stored = storedCadDocument(document);
    expect((stored.features[0] as CadSketchFeature).graph).toEqual({ points: [], entities: [], relations: [rectangle()] });
    const text = storedCadDocumentText(document);
    const loaded = parseCadDocument(JSON.parse(text));
    expect(storedCadDocumentText(loaded)).toBe(text);
    expect(graphOf(loaded).entities.map(entity => entity.id)).toEqual(['g-rect_e0', 'g-rect_e1', 'g-rect_e2', 'g-rect_e3']);
    // A document that carries exactly the members it generates is accepted and compares equal to the stored form.
    expect(storedCadDocumentText(parseCadDocument(JSON.parse(JSON.stringify(document))))).toBe(text);
  });

  it('refuse a stored document whose carried members differ from what its generator makes, naming the generator', () => {
    const carried = JSON.parse(JSON.stringify(documentWith({ points: [], entities: [], relations: [rectangle()] })));
    carried.features[0].graph.points.find((point: { id: string }) => point.id === 'g-rect_p2').position = [21, 10];
    expect(refusal(() => parseCadDocument(carried))).toMatchObject({ code: 'stale-sketch-generator', message: expect.stringContaining('Rectangle "rect"') });
    // A member removed, or one added in the generator's namespace, is refused the same way.
    const missing = JSON.parse(JSON.stringify(documentWith({ points: [], entities: [], relations: [rectangle()] })));
    missing.features[0].graph.relations = missing.features[0].graph.relations.filter((relation: { id: string }) => relation.id !== 'g-rect_r0');
    expect(refusal(() => parseCadDocument(missing)).code).toBe('stale-sketch-generator');
  });

  it('regenerate the members in the edit that changes a parameter, as one undo step that leaves the stored form unchanged', () => {
    const session = new CadSession(documentWith({ points: [], entities: [], relations: [rectangle()] }));
    const before = session.getSnapshot();
    session.edit([{ kind: 'set-parameter', name: 'w', value: 30 }]);
    expect(position(session.getSnapshot().document, 'g-rect_p2')).toEqual([30, 10]);
    expect((storedCadDocument(session.getSnapshot().document).features[0] as CadSketchFeature).graph)
      .toEqual((storedCadDocument(before.document).features[0] as CadSketchFeature).graph);
    session.undo();
    expect(session.getSnapshot().document).toBe(before.document);
    expect(position(session.getSnapshot().document, 'g-rect_p2')).toEqual([20, 10]);
    session.redo();
    expect(position(session.getSnapshot().document, 'g-rect_p2')).toEqual([30, 10]);
  });

  it('remove the relations on a gear\'s resampled chords only when the tooth change confirms them, in one undo step, as its preview showed', () => {
    const gear = (teeth: number): CadSketchGenerator => ({ id: 'gear', kind: 'generator', idPrefix: 'g', construction: false,
      geometry: { ...createCadPluginProfile(CAD_GEAR_V3_PLUGIN), inputs: { ...createCadPluginProfile(CAD_GEAR_V3_PLUGIN).inputs, teeth } } as CadSketchGenerator['geometry'] });
    // A free point held on the second chord of tooth 2's left flank, and one on its tip arc's centre. Seventeen teeth sample each flank with
    // one chord more, so the chord leaves, and the tip and its centre stay.
    const bare = graphOf(documentWith({ points: [], entities: [], relations: [gear(18)] }));
    const chord = bare.entities.find(entity => /^g_t2_flankL\d+s1$/.test(entity.id))!;
    const at = (id: string) => bare.points.find(point => point.id === id)!.position.map(Number) as [number, number];
    if (chord.kind !== 'line') throw new Error('A flank chord is a line.');
    const [start, end] = [at(chord.startPointId), at(chord.endPointId)];
    const document = documentWith({ points: [{ id: 'w', position: [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2] }, { id: 'u', position: at('g_t2_tipC') }], entities: [],
      relations: [gear(18), { id: 'on-chord', kind: 'point-on-line', pointId: 'w', lineId: chord.id }, { id: 'on-tip', kind: 'coincident', pointIds: ['u', 'g_t2_tipC'] }] });
    const session = new CadSession(document), before = session.getSnapshot();
    const change: CadEdit = { kind: 'set-sketch-generator', sketchId: 'sketch', generator: gear(17) };
    expect(refusal(() => session.edit([change]))).toMatchObject({ code: 'unconfirmed-sketch-generator-removals', relationIds: ['on-chord'],
      message: expect.stringMatching(/^Spur gear "gear" no longer generates geometry that Point on line "on-chord" uses\. .* This removes one relation: on-chord\./) });
    expect(session.getSnapshot()).toBe(before);
    // Confirmed, the edit removes exactly that relation, as the preview of the same edits did, and keeps the one on the tip.
    const confirmed: CadEdit = { ...change, removedRelationIds: ['on-chord'] };
    const preview = applyCadEdits(document, [confirmed]);
    session.edit([confirmed]);
    expect(session.getSnapshot().document).toEqual(preview);
    expect(graphOf(preview).relations.map(relation => relation.id)).toEqual(['gear', 'on-tip']);
    expect(graphOf(preview).entities.some(entity => entity.id.startsWith('g_t17_'))).toBe(false);
    // One undo restores both the eighteen teeth and the relation on the chord.
    session.undo();
    expect(session.getSnapshot().document).toBe(before.document);
    expect(graphOf(session.getSnapshot().document).relations.map(relation => relation.id)).toEqual(['gear', 'on-chord', 'on-tip']);
  });

  it('refuse every edit of a generated member on its own, naming the generator', () => {
    const document = documentWith({ points: [{ id: 'u', position: [50, 50] }, { id: 'v', position: [60, 50] }], entities: [], relations: [rectangle()] });
    const named = expect.stringContaining('Rectangle "rect"');
    expect(cadSketchOwnedGeometryLockReason(graphOf(document), { kind: 'entity', id: 'g-rect_e0' })).toEqual(named);
    for (const change of [
      { kind: 'set-sketch-construction', sketchId: 'sketch', entityIds: ['g-rect_e0'], construction: true },
      { kind: 'delete-sketch-elements', sketchId: 'sketch', pointIds: [], entityIds: ['g-rect_e0'], relationIds: [], cascade: true },
      { kind: 'remove-sketch-relation', sketchId: 'sketch', relationId: 'g-rect_r0' },
      { kind: 'set-sketch-relation', sketchId: 'sketch', relation: { id: 'g-rect_r0', kind: 'vertical', pointIds: ['g-rect_p0', 'g-rect_p1'] } },
      { kind: 'split-sketch-entity', sketchId: 'sketch', split: { kind: 'line', entityId: 'g-rect_e0', parameter: 0.5, splitPointId: 'split', newEntityId: 'piece', supportRelationId: 'keep' } }
    ] as CadEdit[]) expect(refusal(() => edit(document, change)), change.kind).toMatchObject({ code: 'owned-sketch-generator', message: named });
    // A new id in the generator's namespace, and an edge of the sketch's own ending at a generated point, are refused too.
    expect(refusal(() => edit(document, { kind: 'append-sketch-entities', sketchId: 'sketch', geometry: { points: [], relations: [],
      entities: [{ id: 'g-rect_x', kind: 'line', construction: false, startPointId: 'u', endPointId: 'v' }] } }))).toMatchObject({ code: 'owned-sketch-generator',
      message: expect.stringContaining('id namespace "g-rect"') });
    expect(refusal(() => edit(document, { kind: 'append-sketch-entities', sketchId: 'sketch', geometry: { points: [], relations: [],
      entities: [{ id: 'line', kind: 'line', construction: false, startPointId: 'u', endPointId: 'g-rect_p0' }] } }))).toMatchObject({ code: 'invalid-sketch-generator',
      message: expect.stringContaining('coincident relation') });
    // A generator is made and changed by its own operation only.
    expect(refusal(() => edit(document, { kind: 'set-sketch-relation', sketchId: 'sketch', relation: rectangle(25) })).code).toBe('invalid-sketch-generator');
    expect(refusal(() => edit(document, { kind: 'append-sketch-entities', sketchId: 'sketch', geometry: { points: [], entities: [], relations: [polygon(5)] } })).code)
      .toBe('invalid-sketch-generator');
  });

  it('create, change, detach and delete a generator through its operations', () => {
    const empty = documentWith({ points: [], entities: [], relations: [] });
    const created = edit(empty, { kind: 'set-sketch-generator', sketchId: 'sketch', generator: rectangle() });
    expect(position(created, 'g-rect_p2')).toEqual([20, 10]);
    const changed = edit(created, { kind: 'set-sketch-generator', sketchId: 'sketch', generator: rectangle(25) });
    expect(position(changed, 'g-rect_p2')).toEqual([25, 10]);
    expect(refusal(() => edit(changed, { kind: 'set-sketch-generator', sketchId: 'sketch', generator: { ...rectangle(), idPrefix: 'other' } }))).toMatchObject({
      code: 'invalid-sketch-generator', message: expect.stringContaining('keeps its id prefix') });
    // Detached, the members stay as ordinary geometry; their namespace stays taken.
    const detached = edit(changed, { kind: 'detach-sketch-generator', sketchId: 'sketch', generatorId: 'rect' });
    expect(graphOf(detached).relations.some(relation => relation.kind === 'generator')).toBe(false);
    expect(position(detached, 'g-rect_p2')).toEqual([25, 10]);
    expect(cadSketchOwnedGeometryLockReason(graphOf(detached), { kind: 'point', id: 'g-rect_p2' })).toBeNull();
    expect(refusal(() => edit(detached, { kind: 'set-sketch-generator', sketchId: 'sketch', generator: { ...rectangle(), id: 'again' } }))).toMatchObject({
      code: 'invalid-sketch-generator', message: expect.stringContaining('"g-rect_') });
    // Removing or deleting the generator removes its members.
    for (const removal of [{ kind: 'remove-sketch-relation', sketchId: 'sketch', relationId: 'rect' },
      { kind: 'delete-sketch-elements', sketchId: 'sketch', pointIds: [], entityIds: [], relationIds: ['rect'], cascade: false }] as CadEdit[])
      expect(graphOf(edit(changed, removal))).toMatchObject({ points: [], entities: [], relations: [] });
  });

  it('key a listed polygon by entry id, so a vertex inserted mid-list reshapes only the edge it splits, and a reorder or a deletion keeps the other keys', () => {
    type Point = readonly [number, number];
    const outline = (points: readonly Point[], ids?: readonly number[]): CadSketchGenerator => ({ id: 'plate', kind: 'generator', idPrefix: 'p', construction: false,
      geometry: { kind: 'polygon', points, ...ids ? { ids } : {} } });
    const hexagon: readonly Point[] = [[0, 0], [20, 0], [30, 10], [20, 20], [0, 20], [-10, 10]];
    // A free point u at a distance from every vertex, and a free point w<i> on the middle of every edge.
    const middles = hexagon.map((point, i): Point => [(point[0] + hexagon[(i + 1) % 6][0]) / 2, (point[1] + hexagon[(i + 1) % 6][1]) / 2]);
    const ties = hexagon.flatMap((point, i) => [{ id: `to-v${i}`, kind: 'distance', pointIds: ['u', `p_v${i}`], value: Math.hypot(40 - point[0], 40 - point[1]) },
      { id: `on-e${i}`, kind: 'midpoint', pointId: `w${i}`, lineId: `p_e${i}` }]);
    const document = documentWith({ points: [{ id: 'u', position: [40, 40] }, ...middles.map((position, i) => ({ id: `w${i}`, position }))], entities: [],
      relations: [outline(hexagon), ...ties] });
    const userRelations = (next: CadDocument) => graphOf(next).relations.filter(relation => relation.kind !== 'generator');
    const set = (from: CadDocument, generator: CadSketchGenerator) => edit(from, { kind: 'set-sketch-generator', sketchId: 'sketch', generator });
    // A vertex inserted between v2 and v3 splits only e2: its relation alone goes through the remap, and the refusal names it alone.
    const inserted = [...hexagon.slice(0, 3), [28, 18], ...hexagon.slice(3)] as Point[];
    expect(refusal(() => set(document, outline(inserted)))).toMatchObject({ code: 'unconfirmed-sketch-generator-removals', relationIds: ['on-e2'],
      message: expect.stringMatching(/^Polygon "plate" no longer generates geometry that Midpoint "on-e2" uses\./) });
    const released = edit(document, { kind: 'remove-sketch-relation', sketchId: 'sketch', relationId: 'on-e2' });
    const split = set(released, outline(inserted));
    // Confirming the removal makes the same edit in one step.
    expect(edit(document, { kind: 'set-sketch-generator', sketchId: 'sketch', generator: outline(inserted), removedRelationIds: ['on-e2'] })).toEqual(split);
    // The new vertex takes a fresh entry id, stored with the record; every other vertex and edge keeps its key and its relations.
    expect(graphOf(split).relations[0]).toMatchObject({ geometry: { ids: [0, 1, 2, 6, 3, 4, 5] } });
    expect(userRelations(split)).toEqual(userRelations(released));
    expect(position(split, 'p_v6')).toEqual([28, 18]);
    expect(graphOf(split).entities.find(entity => entity.id === 'p_e2')).toMatchObject({ startPointId: 'p_v2', endPointId: 'p_v6' });
    expect(graphOf(split).entities.find(entity => entity.id === 'p_e6')).toMatchObject({ startPointId: 'p_v6', endPointId: 'p_v3' });
    // The stored form keeps the ids, so the document loads with the same keys.
    expect(graphOf(parseCadDocument(JSON.parse(storedCadDocumentText(split))))).toEqual(graphOf(split));
    // The profile editor sees the points alone; a vertex it appends takes the next fresh id from the record it replaces, and splits the
    // closing edge e5, whose relation it confirms it removes.
    const sketch = split.features[0] as CadSketchFeature, view = cadSketchProfileViews(sketch)[0];
    expect(view.geometry).toEqual({ kind: 'polygon', points: inserted });
    const widened = edit(split, ...cadSketchProfileEdits(sketch, { ...view, geometry: { kind: 'polygon', points: [...inserted, [-6, 4]] } }, {}, ['on-e5']));
    expect(graphOf(widened).relations[0]).toMatchObject({ geometry: { ids: [0, 1, 2, 6, 3, 4, 5, 7] } });
    expect(position(widened, 'p_v7')).toEqual([-6, 4]);
    // The same vertices from another start keep their ids, and so their keys.
    const rotated = set(split, outline([...inserted.slice(2), ...inserted.slice(0, 2)]));
    expect(graphOf(rotated).relations[0]).toMatchObject({ geometry: { ids: [2, 6, 3, 4, 5, 0, 1] } });
    expect(userRelations(rotated)).toEqual(userRelations(released));
    // Deleting the new vertex reshapes e2 back to the edge it was, and leaves the other keys alone; the ids are the indices again.
    const restored = set(rotated, outline(hexagon));
    expect(graphOf(restored).relations[0]).toEqual(outline(hexagon));
    expect(graphOf(restored).points.filter(point => point.id.startsWith('p_'))).toEqual(graphOf(document).points.filter(point => point.id.startsWith('p_')));
    // Ids an edit gives are its own, one for each point.
    expect(refusal(() => set(document, outline(hexagon, [0, 1, 2])))).toMatchObject({ code: 'invalid-sketch-generator', message: 'Polygon "plate" needs one entry id for each point.' });
    expect(position(set(released, outline(inserted, [0, 1, 2, 9, 3, 4, 5])), 'p_v9')).toEqual([28, 18]);
  });

  it('key a listed path by entry id, so a segment split in two keeps its joints, and only the piece that starts at the new joint is reshaped', () => {
    type Point = readonly [number, number];
    const line = (start: Point, end: Point) => ({ kind: 'line' as const, start, end });
    const outline = (segments: ReturnType<typeof line>[]): CadSketchGenerator => ({ id: 'route', kind: 'generator', idPrefix: 'r', construction: false, geometry: { kind: 'path', segments } });
    const corners: readonly Point[] = [[0, 0], [20, 0], [20, 10], [0, 10]];
    const square = corners.map((corner, i) => line(corner, corners[(i + 1) % 4]));
    // Each joint at a distance from u, and a free point on each segment's middle.
    const ties = corners.flatMap((_, i) => { const end = corners[(i + 1) % 4]; return [{ id: `to-j${i}`, kind: 'distance', pointIds: ['u', `r_j${i}`], value: Math.hypot(40 - end[0], 40 - end[1]) },
      { id: `on-s${i}`, kind: 'midpoint', pointId: `w${i}`, lineId: `r_s${i}` }]; });
    const middles = square.map(({ start, end }, i) => ({ id: `w${i}`, position: [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2] }));
    const document = documentWith({ points: [{ id: 'u', position: [40, 40] }, ...middles], entities: [], relations: [outline(square), ...ties] });
    // Splitting s1 at (20, 4): the piece ending at the old joint keeps s1 and j1, and the piece before it is new, ending at its own joint.
    const pieces = [square[0], line([20, 0], [20, 4]), line([20, 4], [20, 10]), square[2], square[3]];
    expect(refusal(() => edit(document, { kind: 'set-sketch-generator', sketchId: 'sketch', generator: outline(pieces) }))).toMatchObject({ relationIds: ['on-s1'],
      message: expect.stringMatching(/^Path "route" no longer generates geometry that Midpoint "on-s1" uses\./) });
    const released = edit(document, { kind: 'remove-sketch-relation', sketchId: 'sketch', relationId: 'on-s1' });
    const split = edit(released, { kind: 'set-sketch-generator', sketchId: 'sketch', generator: outline(pieces) });
    expect(graphOf(split).relations[0]).toMatchObject({ geometry: { ids: [0, 4, 1, 2, 3] } });
    expect(graphOf(split).relations.filter(relation => relation.kind !== 'generator')).toEqual(graphOf(released).relations.filter(relation => relation.kind !== 'generator'));
    expect(position(split, 'r_j1')).toEqual([20, 10]);
    expect(position(split, 'r_j4')).toEqual([20, 4]);
    expect(graphOf(split).entities.find(entity => entity.id === 'r_s1')).toMatchObject({ startPointId: 'r_j4', endPointId: 'r_j1' });
  });

  it('delete the user relations on a deleted generator\'s members only with cascade, and keep relations on kept members through regeneration', () => {
    const members = expandCadSketchGenerators({ points: [], entities: [], relations: [polygon()] }, { n: 5 });
    const at = (id: string) => members.points.find(point => point.id === id)!.position;
    const points = [{ id: 'u0', position: at('g-poly_v0') }, { id: 'u4', position: at('g-poly_v4') }];
    const document = documentWith({ points, entities: [],
      relations: [polygon(), { id: 'c0', kind: 'coincident', pointIds: ['u0', 'g-poly_v0'] }, { id: 'c4', kind: 'coincident', pointIds: ['u4', 'g-poly_v4'] }] }, { n: 5 });
    expect(refusal(() => edit(document, { kind: 'delete-sketch-elements', sketchId: 'sketch', pointIds: [], entityIds: [], relationIds: ['poly'], cascade: false })).code)
      .toBe('dependent-sketch-element');
    expect(graphOf(edit(document, { kind: 'delete-sketch-elements', sketchId: 'sketch', pointIds: [], entityIds: [], relationIds: ['poly'], cascade: true })).relations).toEqual([]);
    // Six sides keep v0, which stays on the direction line, and the relation on it; four would lose v4, and its relation refuses, naming both.
    const onFirst = documentWith({ points, entities: [], relations: [polygon(), { id: 'c0', kind: 'coincident', pointIds: ['u0', 'g-poly_v0'] }] }, { n: 5 });
    const six = edit(onFirst, { kind: 'set-parameter', name: 'n', value: 6 });
    expect(graphOf(six).entities).toHaveLength(6);
    expect(graphOf(six).relations.filter(relation => relation.kind === 'coincident').map(relation => relation.id)).toEqual(['c0']);
    expect(refusal(() => edit(document, { kind: 'set-parameter', name: 'n', value: 4 }))).toMatchObject({ code: 'unconfirmed-sketch-generator-removals', relationIds: ['c4'],
      message: expect.stringMatching(/Regular polygon "poly" no longer generates geometry that .* "c4" uses\. .* This removes one relation: c4\. Send exactly these IDs as removedRelationIds/) });
    // A parameter edit confirms the removal as a generator edit does; an id it does not remove is refused, so a stale request fails whole.
    const four = edit(document, { kind: 'set-parameter', name: 'n', value: 4, removedRelationIds: ['c4'] });
    expect(graphOf(four).relations.filter(relation => relation.kind === 'coincident').map(relation => relation.id)).toEqual(['c0']);
    expect(refusal(() => edit(document, { kind: 'set-parameter', name: 'n', value: 4, removedRelationIds: ['c4', 'c0'] }))).toMatchObject({
      code: 'stale-sketch-generator-removals', message: 'This edit no longer removes "c0". Send exactly the IDs it removes as removedRelationIds.' });
  });
});
