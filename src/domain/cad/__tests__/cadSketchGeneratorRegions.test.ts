import { describe, expect, it } from 'vitest';
import type { CadProfile, CadSketchFeature } from '../cadDocument';
import { createCadPathProfile } from '../cadPathConstruction';
import { createCadDocument, parseCadDocument } from '../cadSchema';
import { resolveCadProfile, resolveCadSketchContours } from '../cadSketchGeometry';
import type { CadSketchGeneratorGeometry } from '../cadSketchGraph';
import { compileCadSketchGraph } from '../cadSketchGraphGeometry';
import { inspectCadSketchRegions } from '../cadSketchRegionInspection';
import { CAD_GEAR_V3_PLUGIN, CAD_STAR_PLUGIN, createCadPluginProfile, resolveCadPluginProfile } from '../plugins/cadPlugins';

// A region whose boundary is one generator's whole outline reads as the profile that generator replaces did: its kind and its name, as
// people called it. Any other closed loop, drawn or mixed, reads as a path contour.

const part = (sketch: Readonly<Record<string, unknown>>, parameters: Record<string, number> = {}) => parseCadDocument({
  ...createCadDocument('Regions', 'regions'), schemaVersion: 2, parameters,
  features: [{ id: 'sketch', kind: 'sketch', name: 'Sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [], ...sketch }] });
const sketchOf = (document: ReturnType<typeof part>) => document.features[0] as CadSketchFeature;
const generator = (id: string, geometry: unknown, name?: string) => ({ id, kind: 'generator', idPrefix: id, ...name ? { name } : {}, construction: false, geometry });

const PROFILES: readonly { readonly name: string; readonly geometry: CadProfile; readonly kind: CadProfile['kind'] }[] = [
  { name: 'Plate', geometry: { kind: 'rectangle', x: -20, y: -15, width: 'w', height: 30, cornerRadius: 0 }, kind: 'rectangle' },
  { name: 'Rounded plate', geometry: { kind: 'rectangle', x: -20, y: -15, width: 40, height: 30, cornerRadius: 4 }, kind: 'rectangle' },
  { name: 'Bore', geometry: { kind: 'circle', x: 3, y: -2, radius: 9 }, kind: 'circle' },
  { name: 'Keyway', geometry: { kind: 'slot', x: 0, y: 0, length: 50, width: 16, angle: 30 }, kind: 'slot' },
  { name: 'Notch', geometry: { kind: 'polygon', points: [[-20, -20], [20, -20], [20, 20], [0, 8], [-20, 20]] }, kind: 'polygon' },
  { name: 'Cam', geometry: createCadPathProfile([-20, -20], [{ kind: 'line', end: [20, -20] }, { kind: 'arc', end: [20, 20], through: [30, 0] },
    { kind: 'line', end: [-20, 20] }, { kind: 'arc', end: [-20, -20], through: [-12, 0] }]), kind: 'path' },
  { name: 'Gear', geometry: createCadPluginProfile(CAD_GEAR_V3_PLUGIN), kind: 'plugin' },
  { name: 'Star', geometry: createCadPluginProfile(CAD_STAR_PLUGIN), kind: 'plugin' },
];

describe('regions of generated geometry', () => {
  it.each(PROFILES)('read as the $kind profile "$name" they replace, under its name, with the same shape', ({ name, geometry }) => {
    const parameters = { w: 40 }, document = part({ graph: { points: [], entities: [], relations: [generator('shape', geometry, name)] } }, parameters);
    const [contour] = resolveCadSketchContours(sketchOf(document), parameters);
    const legacy = geometry.kind === 'plugin' ? resolveCadPluginProfile(geometry, parameters) : resolveCadProfile(geometry, parameters);
    expect(contour.profile).toMatchObject({ name, generatorId: 'shape', construction: false });
    expect(contour.geometry).toEqual(legacy);
    // Its identity stays the generated edges it is made of, so a selection of it still names them.
    expect(contour.profile.id.startsWith('shape_')).toBe(true);
    expect('graphSourceRefs' in contour.profile && contour.profile.graphSourceRefs?.length).toBeGreaterThan(0);
    const [item] = inspectCadSketchRegions(document, 'sketch').items;
    expect(item).toMatchObject({ name, kind: legacy.kind });
  });

  it('name a regular polygon and an unnamed generator by its id, and keep the kind of the shape drawn', () => {
    const polygon: CadSketchGeneratorGeometry = { kind: 'regular-polygon', x: 0, y: 0, radius: 10, sides: 6, directionId: '@h' };
    const document = part({ graph: { points: [], entities: [], relations: [generator('hex', polygon), generator('bore', { kind: 'circle', x: 0, y: 0, radius: 3 }, 'Bore')] } });
    const contours = resolveCadSketchContours(sketchOf(document), {});
    expect(contours.map(contour => [contour.profile.name, contour.geometry.kind, contour.depth])).toEqual([['Bore', 'circle', 1], ['hex', 'polygon', 0]]);
    expect(inspectCadSketchRegions(document, 'sketch').items).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'hex', kind: 'polygon', depth: 0, defaultMaterial: true }),
      expect.objectContaining({ name: 'Bore', kind: 'circle', defaultMaterial: false })]));
  });

  it('find generated outlines that cross one another or a drawn edge, and leave apart those that stand clear', () => {
    const square = (id: string, x: number) => generator(id, { kind: 'rectangle', x, y: 0, width: 10, height: 10, cornerRadius: 0 });
    const crossing = (relations: unknown[], entities: unknown[] = [], points: unknown[] = []) => compileCadSketchGraph(sketchOf(part({ graph: { points, entities, relations } })).graph!, {});
    // Clear of each other, each outline is its own cycle; overlapping, both go to the arrangement.
    expect(crossing([square('a', 0), square('b', 20)])).toMatchObject({ arrangementEntityIds: [], cycles: [{}, {}] });
    expect(crossing([square('a', 0), square('b', 5)]).arrangementEntityIds).toEqual(['a_e0', 'a_e1', 'a_e2', 'b_e0', 'b_e2', 'b_e3']);
    // A drawn edge across one outline puts it and the outline's edges it crosses there, and leaves the other alone.
    const cut = crossing([square('a', 0), square('b', 20)], [{ id: 'cut', kind: 'line', construction: false, startPointId: 'p', endPointId: 'q' }],
      [{ id: 'p', position: [5, -5] }, { id: 'q', position: [5, 15] }]);
    expect(cut.arrangementEntityIds).toEqual(['a_e0', 'a_e2', 'cut']);
    expect(cut.cycles.map(cycle => cycle.sourceRefs[0].entityId)).toEqual(['b_e0']);
  });

  it('read a drawn loop, and a generator outline that drawn geometry joins, as path contours', () => {
    const points = [{ id: 'a', position: [40, 0] }, { id: 'b', position: [60, 0] }, { id: 'c', position: [50, 10] }];
    const triangle = { points, entities: ['a', 'b', 'c'].map((id, index) => ({ id: `t-${id}`, kind: 'line', construction: false, startPointId: id, endPointId: ['b', 'c', 'a'][index] })) };
    const drawn = part({ graph: { ...triangle, relations: [generator('bore', { kind: 'circle', x: 0, y: 0, radius: 3 }, 'Bore')] } });
    expect(resolveCadSketchContours(sketchOf(drawn), {}).map(contour => [contour.profile.name, contour.geometry.kind])).toEqual([['Bore', 'circle'], ['Contour', 'path']]);
    // A drawn edge closing a loop through a generated corner: the generator's outline is no longer a cycle of its own.
    const joined = part({ graph: { points: [{ id: 'p', position: [10, 0] }, { id: 'q', position: [30, 0] }],
      entities: [{ id: 'spur', kind: 'line', construction: false, startPointId: 'p', endPointId: 'q' }],
      relations: [generator('plate', { kind: 'rectangle', x: 0, y: 0, width: 10, height: 10, cornerRadius: 0 }, 'Plate'),
        { id: 'meet', kind: 'coincident', pointIds: ['p', 'plate_p1'] }] } });
    expect(resolveCadSketchContours(sketchOf(joined), {}).map(contour => contour.profile.name)).not.toContain('Plate');
  });
});
