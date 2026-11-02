import { describe, expect, it } from 'vitest';
import type { CadDocument, CadSketchFeature } from '../cadDocument';
import { applyCadEdits, type CadEdit } from '../cadOperations';
import { createCadDocument, parseCadDocument } from '../cadSchema';
import type { CadSketchGenerator, CadSketchGraph } from '../cadSketchGraph';
import { storedCadDocument, storedCadDocumentText } from '../cadStoredDocument';
import { cadSketchOwnedGeometryLockReason } from '../cadSketchOwnedGeometry';
import { expandCadSketchGenerators } from '../sketch-generators/cadSketchGenerators';
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

  it('take relations on a listed polygon\'s vertices after an inserted one through the remap, and keep them through an edit of one vertex', () => {
    const outline = (points: readonly (readonly [number, number])[]): CadSketchGenerator => ({ id: 'plate', kind: 'generator', idPrefix: 'p', construction: false, geometry: { kind: 'polygon', points } });
    const square: readonly (readonly [number, number])[] = [[0, 0], [20, 0], [20, 10], [0, 10]];
    const document = documentWith({ points: [{ id: 'u', position: [40, 40] }], entities: [], relations: [outline(square),
      { id: 'd1', kind: 'distance', pointIds: ['u', 'p_v1'], value: Math.hypot(20, 40) }, { id: 'd3', kind: 'distance', pointIds: ['u', 'p_v3'], value: 50 }] });
    // Moving a vertex keeps every key and the relations on them.
    const moved = edit(document, { kind: 'set-sketch-generator', sketchId: 'sketch', generator: outline([[0, 0], [20, 0], [20, 12], [0, 10]]) });
    expect(graphOf(moved).relations.map(relation => relation.id)).toEqual(['plate', 'd1', 'd3']);
    // A vertex inserted after v1 puts v2 and v3 on other corners: v3 would silently become the old v2, so its relation refuses.
    const notched = outline([[0, 0], [20, 0], [25, 5], [20, 10], [0, 10]]);
    expect(refusal(() => edit(document, { kind: 'set-sketch-generator', sketchId: 'sketch', generator: notched }))).toMatchObject({ code: 'owned-sketch-generator',
      message: expect.stringMatching(/Polygon "plate" no longer generates geometry that Distance "d3" uses/) });
    const onFirst = edit(document, { kind: 'remove-sketch-relation', sketchId: 'sketch', relationId: 'd3' });
    const inserted = edit(onFirst, { kind: 'set-sketch-generator', sketchId: 'sketch', generator: notched });
    expect(graphOf(inserted).relations.map(relation => relation.id)).toEqual(['plate', 'd1']);
    expect(position(inserted, 'p_v4')).toEqual([0, 10]);
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
    expect(refusal(() => edit(document, { kind: 'set-parameter', name: 'n', value: 4 }))).toMatchObject({ code: 'owned-sketch-generator',
      message: expect.stringMatching(/Regular polygon "poly" no longer generates geometry that .* "c4" uses/) });
  });
});
