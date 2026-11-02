import { describe, expect, it } from 'vitest';
import type { CadDocument, CadSketchFeature } from '../cadDocument';
import { applyCadEdits, type CadEdit } from '../cadOperations';
import { createCadPathProfile } from '../cadPathConstruction';
import { createCadDocument, parseCadDocument } from '../cadSchema';
import type { CadSketchGenerator } from '../cadSketchGraph';
import { storedCadDocument } from '../cadStoredDocument';
import { cadSketchGeneratorPrefixFor } from '../sketch-generators/cadSketchGeneratorEdits';
import { cadSketchProfileEdits, cadSketchProfileViews, cadSketchShapeEdits, prepareCadSketchShapeDeletion, refuseNewCadSketchProfiles, withCadSketchProfile } from '../sketch-generators/cadSketchProfileViews';
import { expandCadSketchGenerators } from '../sketch-generators/cadSketchGenerators';
import { CAD_STAR_PLUGIN, createCadPluginProfile } from '../plugins/cadPlugins';

const plate: CadSketchGenerator = { id: 'plate', kind: 'generator', idPrefix: 'plate', construction: false,
  geometry: { kind: 'polygon', points: [[0, 0], [20, 0], [20, 10], [0, 10]] } };
const bore: CadSketchGenerator = { id: 'bore', kind: 'generator', idPrefix: 'bore', name: 'Bore', construction: false,
  geometry: { kind: 'circle', x: 'boreX', y: 5, radius: 2 } };
const documentWith = (sketch: Partial<CadSketchFeature>): CadDocument => parseCadDocument({ ...createCadDocument('Part', 'part'), schemaVersion: 2, parameters: { boreX: 10 },
  features: [{ id: 'sketch', kind: 'sketch', name: 'Sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [], ...sketch }] });
const generated = () => documentWith({ graph: { points: [], entities: [], relations: [plate, bore] } });
const sketchOf = (document: CadDocument) => document.features[0] as CadSketchFeature;
const refusal = (run: () => unknown) => { try { run(); } catch (error) { return error as { code?: string; message: string }; } throw new Error('The edit was accepted.'); };

describe('generators seen as the profiles they replace', () => {
  it('show each generator of a profile shape after the saved profiles, named as people named it, one view per record', () => {
    const document = documentWith({ profiles: [{ id: 'old', name: 'Old', construction: false, geometry: { kind: 'circle', x: 40, y: 0, radius: 3 } }],
      graph: { points: [], entities: [], relations: [plate, bore, { id: 'hex', kind: 'generator', idPrefix: 'hex', construction: true,
        geometry: { kind: 'regular-polygon', x: 60, y: 0, radius: 5, sides: 6, directionId: '@h' } }] } });
    const views = cadSketchProfileViews(sketchOf(document));
    // A regular polygon was never a profile, so it has no view.
    expect(views.map(view => [view.id, view.name])).toEqual([['old', 'Old'], ['plate', 'Polygon'], ['bore', 'Bore']]);
    expect(views[2]).toEqual({ id: 'bore', name: 'Bore', construction: false, geometry: bore.geometry });
    expect(cadSketchProfileViews(sketchOf(document))).toBe(views);
    expect(cadSketchProfileViews(sketchOf(applyCadEdits(document, [{ kind: 'rename-document', name: 'Renamed' }])))[1]).toBe(views[1]);
  });

  it('write a view back to its generator record, storing a name only when it is not the one shown', () => {
    const sketch = sketchOf(generated()), [shown] = cadSketchProfileViews(sketch).filter(view => view.id === 'plate');
    const unchanged = withCadSketchProfile(sketch, { ...shown, construction: true });
    expect(unchanged.graph?.relations[0]).toEqual({ ...plate, construction: true });
    const renamed = withCadSketchProfile(sketch, { ...shown, name: 'Plate' });
    expect(renamed.graph?.relations[0]).toEqual({ ...plate, name: 'Plate' });
    const deletion = prepareCadSketchShapeDeletion(sketch, 'bore'), without = sketchOf(applyCadEdits(generated(), [deletion.edit]));
    expect(deletion.removed).toEqual([]);
    expect(without.graph?.relations.map(relation => relation.id)).toEqual(['plate']);
    expect(without.graph?.points.some(point => point.id.startsWith('bore_'))).toBe(false);
  });

  it('move a handle and translate shapes through their records, regenerating the members as one edit', () => {
    const document = generated();
    const moved = applyCadEdits(document, [{ kind: 'move-sketch-handle', sketchId: 'sketch', profileId: 'plate', handle: { kind: 'vertex', index: 1 }, translation: [5, -2] }]);
    expect(storedCadDocument(moved).features[0]).toMatchObject({ graph: { relations: [{ id: 'plate', geometry: { points: [[0, 0], [25, -2], [20, 10], [0, 10]] } }, bore] } });
    expect(sketchOf(moved).graph?.points.find(point => point.id === 'plate_v1')?.position).toEqual([25, -2]);
    const translated = applyCadEdits(document, [{ kind: 'translate-sketch-profiles', sketchId: 'sketch', profileIds: ['plate'], translation: [1, 1] }]);
    expect(sketchOf(translated).graph?.relations[0]).toMatchObject({ geometry: { points: [[1, 1], [21, 1], [21, 11], [1, 11]] } });
    // A batch may set a generator's inputs and then move it: each edit regenerates the members the next one reads.
    const resized = applyCadEdits(document, [{ kind: 'set-sketch-generator', sketchId: 'sketch', generator: { ...plate, geometry: { kind: 'polygon', points: [[0, 0], [30, 0], [30, 10], [0, 10]] } } },
      { kind: 'translate-sketch-profiles', sketchId: 'sketch', profileIds: ['plate'], translation: [1, 1] }]);
    expect(sketchOf(resized).graph?.points.find(point => point.id === 'plate_v1')?.position).toEqual([31, 1]);
    // A position that follows a parameter cannot be dragged, as with a profile.
    expect(refusal(() => applyCadEdits(document, [{ kind: 'translate-sketch-profiles', sketchId: 'sketch', profileIds: ['bore'], translation: [1, 0] }])))
      .toMatchObject({ code: 'driven-sketch-position' });
  });

  it('confirm with the last parameter the relations a view that only reads changed parameters removes', () => {
    const rounded: CadSketchGenerator = { id: 'rect', kind: 'generator', idPrefix: 'rect', construction: false,
      geometry: { kind: 'rectangle', x: 0, y: 0, width: 20, height: 10, cornerRadius: 'r' } };
    const document = parseCadDocument({ ...createCadDocument('Part', 'part'), schemaVersion: 2, parameters: { r: 0 }, features: [{ id: 'sketch', kind: 'sketch', name: 'Sketch',
      suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: { points: [{ id: 'u', position: [0, 0] }], entities: [],
        relations: [rounded, { id: 'tie', kind: 'coincident', pointIds: ['u', 'rect_p0'] }] } }] });
    const sketch = sketchOf(document), [view] = cadSketchProfileViews(sketch);
    // Rounding the corners takes the sharp corner the tie is on; the view itself is unchanged, so the parameter carries the confirmation.
    const edits = cadSketchProfileEdits(sketch, view, { r: 2 }, ['tie']);
    expect(edits).toEqual([{ kind: 'set-parameter', name: 'r', value: 2, removedRelationIds: ['tie'] }]);
    expect(sketchOf(applyCadEdits(document, edits)).graph?.relations.filter(relation => !relation.id.startsWith('rect_')).map(relation => relation.id)).toEqual(['rect']);
  });

  it('refuse profile dimensions on a generator, naming it', () => {
    expect(refusal(() => applyCadEdits(generated(), [{ kind: 'add-sketch-dimension', sketchId: 'sketch', profileId: 'bore', constraint: { id: 'd', kind: 'dimension', quantity: 'diameter' } }])))
      .toMatchObject({ code: 'generator-sketch-dimension', message: expect.stringContaining('Circle "bore"') });
  });

  it('name why a generator with no profile view is not moved, gripped or dimensioned as a profile, and delete it with its members', () => {
    const hex: CadSketchGenerator = { id: 'hex', kind: 'generator', idPrefix: 'hex', construction: false, geometry: { kind: 'regular-polygon', x: 60, y: 0, radius: 5, sides: 6, directionId: '@h' } };
    const star: CadSketchGenerator = { id: 'star', kind: 'generator', idPrefix: 'star', construction: false, geometry: createCadPluginProfile(CAD_STAR_PLUGIN) };
    const document = documentWith({ graph: { points: [], entities: [], relations: [plate, hex, star] } });
    expect(refusal(() => applyCadEdits(document, [{ kind: 'translate-sketch-profiles', sketchId: 'sketch', profileIds: ['plate', 'hex'], translation: [1, 0] }]))).toEqual(
      expect.objectContaining({ code: 'unsupported-sketch-translation', message: 'Regular polygon "hex" is placed by its centre. Set its Center X and Y inputs to move it.' }));
    expect(refusal(() => applyCadEdits(document, [{ kind: 'translate-sketch-profiles', sketchId: 'sketch', profileIds: ['star'], translation: [1, 0] }]))).toEqual(
      expect.objectContaining({ code: 'unsupported-sketch-translation', message: 'Move a generated plugin contour through its placement configuration.' }));
    expect(refusal(() => applyCadEdits(document, [{ kind: 'move-sketch-handle', sketchId: 'sketch', profileId: 'hex', handle: { kind: 'vertex', index: 0 }, translation: [1, 0] }]))).toEqual(
      expect.objectContaining({ code: 'unsupported-sketch-handle', message: 'Regular polygon "hex" has no grips. Change its inputs with set-sketch-generator.' }));
    expect(refusal(() => applyCadEdits(document, [{ kind: 'add-sketch-dimension', sketchId: 'sketch', profileId: 'hex', constraint: { id: 'd', kind: 'dimension', quantity: 'diameter' } }])))
      .toMatchObject({ code: 'generator-sketch-dimension', message: expect.stringContaining('Regular polygon "hex"') });
    // A profile source names a saved profile only; a generated shape's loop is a graph cycle.
    expect(refusal(() => applyCadEdits(document, [{ kind: 'offset-sketch-loop', sketchId: 'sketch', source: { kind: 'profile', profileId: 'star' }, distance: 1, idPrefix: 'copy' }])))
      .toMatchObject({ code: 'unsupported-sketch-offset', message: 'Star profile "star" is sketch geometry, not a saved profile. Offset its loop with a graph-cycle source, the sourceRefs of its contour in the region reference.' });
    const without = sketchOf(applyCadEdits(document, [prepareCadSketchShapeDeletion(sketchOf(document), 'hex').edit]));
    expect(without.graph?.relations.map(relation => relation.id)).toEqual(['plate', 'star']);
    expect(without.graph?.points.some(point => point.id.startsWith('hex_'))).toBe(false); expect(without.graph?.entities.some(entity => entity.id.startsWith('hex_'))).toBe(false);
  });
});

describe('deleting a shape', () => {
  it('takes the user relations on its members and names the shapes made from them, which go only once listed', () => {
    const hex: CadSketchGenerator = { id: 'hex', kind: 'generator', idPrefix: 'hex', name: 'Hex', construction: false, geometry: { kind: 'regular-polygon', x: 0, y: 0, radius: 10, sides: 6, directionId: '@h' } };
    const off: CadSketchGenerator = { id: 'off', kind: 'generator', idPrefix: 'off', construction: false,
      geometry: { kind: 'offset', chain: [0, 1, 2, 3, 4, 5].map(index => ({ entityId: `hex_e${index}`, reversed: false })), distance: 2 } };
    const document = documentWith({ graph: { points: [{ id: 'free', position: [10, 0] }], entities: [], relations: [hex, { id: 'tie', kind: 'coincident', pointIds: ['free', 'hex_v0'] }, off] } });
    const { edit, removed } = prepareCadSketchShapeDeletion(sketchOf(document), 'hex');
    // The polygon's own members and relations, and the offset's, go with their generators unnamed; the user relation on a corner is
    // listed unasked, and only the offset is named.
    expect(edit).toEqual({ kind: 'delete-sketch-elements', sketchId: 'sketch', pointIds: [], entityIds: [], relationIds: ['hex', 'tie'], cascade: false });
    expect(removed).toEqual([{ sketchId: 'sketch', relationId: 'off', name: 'Offset "off"', generator: 'Hex', reason: 'It is generated from geometry this deletes.' }]);
    expect(refusal(() => applyCadEdits(document, [edit]))).toMatchObject({ code: 'dependent-sketch-element' });
    if (edit.kind !== 'delete-sketch-elements') throw new Error('A generator deletes through its sketch graph.');
    const deleted = sketchOf(applyCadEdits(document, [{ ...edit, relationIds: [...edit.relationIds, 'off'] }]));
    expect(deleted.graph).toEqual({ points: [{ id: 'free', position: [10, 0] }], entities: [], relations: [] });
    // The offset alone has nothing on it, so it names nothing.
    expect(prepareCadSketchShapeDeletion(sketchOf(document), 'off').removed).toEqual([]);
  });
});

describe('legacy profiles', () => {
  const legacy = () => documentWith({ profiles: [{ id: 'old', name: 'Old', construction: false, geometry: { kind: 'circle', x: 0, y: 0, radius: 3 } }] });
  it('stay editable and removable, but a batch cannot give a sketch a new one', () => {
    const document = legacy(), sketch = sketchOf(document), [old] = sketch.profiles;
    const resized: CadEdit = { kind: 'update-feature', feature: { ...sketch, profiles: [{ ...old, geometry: { ...old.geometry, radius: 4 } as typeof old.geometry }] } };
    expect(() => refuseNewCadSketchProfiles(document, [resized])).not.toThrow();
    expect(() => refuseNewCadSketchProfiles(document, [{ kind: 'update-feature', feature: { ...sketch, profiles: [] } }])).not.toThrow();
    const added: CadEdit = { kind: 'update-feature', feature: { ...sketch, profiles: [old, { id: 'new', name: 'New', construction: false, geometry: { kind: 'circle', x: 9, y: 0, radius: 1 } }] } };
    expect(refusal(() => refuseNewCadSketchProfiles(document, [added]))).toMatchObject({ code: 'legacy-sketch-profile', message: expect.stringContaining('"new"') });
    const fresh: CadEdit = { kind: 'add-feature', feature: { ...sketch, id: 'other', profiles: [old] } };
    expect(refusal(() => refuseNewCadSketchProfiles(document, [fresh]))).toMatchObject({ code: 'legacy-sketch-profile' });
    // Removed and put back in one batch is still new.
    expect(refusal(() => refuseNewCadSketchProfiles(document, [{ kind: 'update-feature', feature: { ...sketch, profiles: [] } }, resized]))).toMatchObject({ code: 'legacy-sketch-profile' });
  });

  it('confirm with their parameter the relations it removes from a generator beside them, and apply the form in the same batch', () => {
    const plugin = createCadPluginProfile(CAD_STAR_PLUGIN);
    const hexagon: CadSketchGenerator = { id: 'hex', kind: 'generator', idPrefix: 'hex', construction: false,
      geometry: { kind: 'regular-polygon', x: 100, y: 0, radius: 10, sides: 'n', directionId: '@h' } };
    const corner = expandCadSketchGenerators({ points: [], entities: [], relations: [hexagon] }, { n: 6 }).points.find(point => point.id === 'hex_v5')!.position;
    const document = parseCadDocument({ ...createCadDocument('Part', 'part'), schemaVersion: 2, parameters: { n: 6 }, features: [{ id: 'sketch', kind: 'sketch', name: 'Sketch',
      suppressed: false, plane: 'XY', offset: 0, profiles: [{ id: 'star', name: 'Star', construction: false, geometry: { ...plugin, inputs: { ...plugin.inputs, lobes: 'n' } } }],
      graph: { points: [{ id: 'u', position: corner }], entities: [], relations: [hexagon, { id: 'tie', kind: 'coincident', pointIds: ['u', 'hex_v5'] }] } }] });
    const sketch = sketchOf(document), [star] = cadSketchProfileViews(sketch);
    // The star's form changes the shared count to 5 and renames the star, which takes the hexagon's sixth corner, and the tie on it.
    const edits = (removed?: readonly string[]) => cadSketchProfileEdits(sketch, { ...star, name: 'Five' }, { n: 5 }, removed);
    expect(refusal(() => applyCadEdits(document, edits()))).toMatchObject({ code: 'unconfirmed-sketch-generator-removals', relationIds: ['tie'] });
    const applied = applyCadEdits(document, edits(['tie']));
    expect(applied.parameters.n).toBe(5);
    expect(sketchOf(applied).profiles.map(profile => profile.name)).toEqual(['Five']);
    expect(sketchOf(applied).graph?.relations.filter(relation => !relation.id.startsWith('hex_')).map(relation => relation.id)).toEqual(['hex']);
    expect(sketchOf(applied).graph?.entities).toHaveLength(5);
  });
});

describe('generator prefixes', () => {
  it('come from a base, cleaned, numbered while their namespace is taken', () => {
    const sketch = sketchOf(documentWith({ profiles: [{ id: 'gear_old', name: 'Gear', construction: false, geometry: { kind: 'circle', x: 100, y: 0, radius: 3 } }],
      graph: { points: [], entities: [], relations: [plate] } }));
    expect(cadSketchGeneratorPrefixFor(sketch, 'gear')).toBe('gear-2');
    expect(cadSketchGeneratorPrefixFor(sketch, 'plate')).toBe('plate-2');
    expect(cadSketchGeneratorPrefixFor(sketch, '_9f3c.a b')).toBe('9f3c-a-b');
    expect(cadSketchGeneratorPrefixFor(sketch, '___')).toBe('g');
    expect(cadSketchGeneratorPrefixFor(sketch, 'x'.repeat(60))).toHaveLength(40);
  });
});

describe('shapes added by drawing', () => {
  it('become generators of their profile shape, a closed path its own lines and arcs, and never a saved profile', () => {
    const document = documentWith({ graph: { points: [], entities: [], relations: [plate] } }), sketch = sketchOf(document);
    const slot = cadSketchShapeEdits(sketch, { kind: 'slot', x: 40, y: 0, length: 20, width: 6, angle: 0 }, { id: 'slot_one', construction: false });
    expect(slot).toEqual([{ kind: 'set-sketch-generator', sketchId: 'sketch', generator: { id: 'slot_one', kind: 'generator', idPrefix: 'slot-one', name: 'Slot 2',
      construction: false, geometry: { kind: 'slot', x: 40, y: 0, length: 20, width: 6, angle: 0 } } }]);
    const slotted = applyCadEdits(document, slot);
    expect(sketchOf(slotted).profiles).toEqual([]);
    expect(cadSketchProfileViews(sketchOf(slotted)).map(view => view.name)).toEqual(['Polygon', 'Slot 2']);
    const path = createCadPathProfile([40, 20], [{ kind: 'line', end: [60, 20] }, { kind: 'arc', end: [60, 30], through: [65, 25] }, { kind: 'line', end: [40, 30] }]);
    const drawn = applyCadEdits(document, cadSketchShapeEdits(sketch, path, { id: 'outline', construction: true }));
    const graph = sketchOf(drawn).graph!;
    expect(graph.relations.map(relation => relation.id)).toEqual(['plate']);
    expect(graph.entities.filter(entity => entity.id.startsWith('outline_')).map(entity => [entity.kind, entity.construction])).toEqual([
      ['line', true], ['arc', true], ['line', true], ['line', true]]);
    expect(sketchOf(drawn).profiles).toEqual([]);
  });
});
