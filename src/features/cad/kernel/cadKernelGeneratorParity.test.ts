// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import initOpenCascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import type { CadDocument, CadProfile, CadSketchFeature } from '../../../domain/cad/cadDocument';
import { applyCadEdits, type CadEdit } from '../../../domain/cad/cadOperations';
import { createCadPathProfile } from '../../../domain/cad/cadPathConstruction';
import { createCadDocument, parseCadDocument } from '../../../domain/cad/cadSchema';
import { measureCadSketch } from '../../../domain/cad/cadMeasurements';
import type { CadSketchGenerator } from '../../../domain/cad/cadSketchGraph';
import { storedCadDocumentText } from '../../../domain/cad/cadStoredDocument';
import { CAD_GEAR_V2_PLUGIN, CAD_GEAR_V3_PLUGIN, CAD_STAR_PLUGIN, createCadPluginProfile } from '../../../domain/cad/plugins/cadPlugins';
import { buildCadKernelModel } from './cadKernelModel';

beforeAll(async () => {
  const wasmBinary = await readFile(new URL('../../../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  setOC(await initOpenCascade({ wasmBinary, print: () => undefined, printErr: () => undefined }));
}, 60_000);

// Every shape a saved profile could hold builds the same region and solid as the generator that replaces it, and a saved profile
// converted through the edits an agent sends (drop the profile, set a generator with its geometry) builds unchanged.

const bore = { kind: 'circle', x: 0, y: 0, radius: 6 } as const satisfies CadProfile;
const FIXTURES: readonly { readonly name: string; readonly geometry: CadProfile; readonly parameters?: Record<string, number> }[] = [
  { name: 'sharp rectangle', geometry: { kind: 'rectangle', x: -20, y: -15, width: 40, height: 30, cornerRadius: 0 } },
  { name: 'rounded rectangle', geometry: { kind: 'rectangle', x: -20, y: -15, width: 'w', height: 30, cornerRadius: 4 }, parameters: { w: 40 } },
  { name: 'circle', geometry: { kind: 'circle', x: 0, y: 0, radius: 18 } },
  { name: 'slot', geometry: { kind: 'slot', x: 0, y: 0, length: 50, width: 16, angle: 30 } },
  { name: 'concave polygon', geometry: { kind: 'polygon', points: [[-20, -20], [20, -20], [20, 20], [0, 8], [-20, 20]] } },
  { name: 'path with arcs', geometry: createCadPathProfile([-20, -20], [{ kind: 'line', end: [20, -20] }, { kind: 'arc', end: [20, 20], through: [30, 0] },
    { kind: 'line', end: [-20, 20] }, { kind: 'arc', end: [-20, -20], through: [-12, 0] }]) },
  { name: 'gear v2', geometry: { ...createCadPluginProfile(CAD_GEAR_V2_PLUGIN), inputs: { ...createCadPluginProfile(CAD_GEAR_V2_PLUGIN).inputs, teeth: 'z' } }, parameters: { z: 24 } },
  { name: 'gear v3', geometry: createCadPluginProfile(CAD_GEAR_V3_PLUGIN) },
  { name: 'star', geometry: createCadPluginProfile(CAD_STAR_PLUGIN) },
  { name: 'rectangle far from the origin', geometry: { kind: 'rectangle', x: 250_000, y: -180_000, width: 40, height: 30, cornerRadius: 3 } },
];

const sketchDocument = (sketch: Partial<CadSketchFeature>, parameters: Record<string, number> = {}): CadDocument => parseCadDocument({
  ...createCadDocument('Parity', 'parity'), schemaVersion: 2, parameters, features: [
    { id: 'outline', kind: 'sketch', name: 'Outline', suppressed: false, plane: 'XY', offset: 0, profiles: [], ...sketch },
    { id: 'solid', kind: 'extrude', name: 'Solid', suppressed: false, sketchId: 'outline', distance: 10, symmetric: false, operation: 'new', targetId: null },
  ] });
const generator = (id: string, geometry: CadProfile): CadSketchGenerator => ({ id, kind: 'generator', idPrefix: id, construction: false, geometry });
const sketchOf = (document: CadDocument) => document.features.find(feature => feature.id === 'outline') as CadSketchFeature;

/** The edits that turn the saved profile `profileId` into a generator of the same shape, as an agent sends them in one batch. */
function conversion(document: CadDocument, profileId: string): CadEdit[] {
  const sketch = sketchOf(document), profile = sketch.profiles.find(entry => entry.id === profileId)!;
  return [{ kind: 'update-feature', feature: { ...sketch, profiles: sketch.profiles.filter(entry => entry !== profile) } },
    { kind: 'set-sketch-generator', sketchId: sketch.id, generator: { id: profile.id, kind: 'generator', idPrefix: profile.id, name: profile.name, construction: profile.construction, geometry: profile.geometry } }];
}

function built(document: CadDocument) {
  const measured = measureCadSketch(document, 'outline'), model = buildCadKernelModel(document);
  try {
    expect(model.result.diagnostics).toEqual([]);
    expect(model.result.meshes).toHaveLength(1);
    const [mesh] = model.result.meshes, section = model.section({ bodyId: 'solid', plane: 'XY', offset: 5 });
    const types = section.entities.map(entity => entity.type === 'circle' ? 'arc' : entity.type);
    return { area: measured.materialAreaMm2, volume: mesh.volume, solids: mesh.solidCount, bounds: mesh.bounds, contours: section.contourCount,
      lines: types.filter(type => type === 'line').length, arcs: types.filter(type => type === 'arc').length };
  } finally { model.dispose(); }
}

function expectSame(actual: ReturnType<typeof built>, expected: ReturnType<typeof built>) {
  expect(actual.area).toBeCloseTo(expected.area, 7);
  expect(actual.volume).toBeCloseTo(expected.volume, 6);
  expect(actual.solids).toBe(expected.solids);
  expect(actual.contours).toBe(expected.contours);
  for (const axis of [0, 1, 2] as const) {
    expect(actual.bounds.min[axis]).toBeCloseTo(expected.bounds.min[axis], 6);
    expect(actual.bounds.max[axis]).toBeCloseTo(expected.bounds.max[axis], 6);
  }
  return actual;
}

describe('generators against the saved profiles they replace', () => {
  it.each(FIXTURES)('build the $name with the same region and solid, bored or not, and a converted profile builds unchanged', ({ geometry, parameters }) => {
    for (const bored of [false, true]) {
      const legacyProfiles = [{ id: 'shape', name: 'Shape', construction: false, geometry }, ...bored ? [{ id: 'bore', name: 'Bore', construction: false, geometry: bore }] : []];
      const legacy = sketchDocument({ profiles: legacyProfiles }, parameters);
      const generated = sketchDocument({ graph: { points: [], entities: [], relations: [generator('shape', geometry), ...bored ? [generator('bore', bore)] : []] } }, parameters);
      const expected = built(legacy);
      expect(expected.area).toBeGreaterThan(0);
      expectSame(built(generated), expected);
      // The section's edges are the shape's own: the generator does not split or merge an edge the profile had.
      expect(built(generated)).toMatchObject({ lines: expected.lines, arcs: expected.arcs });

      let converted = applyCadEdits(legacy, conversion(legacy, 'shape'));
      if (bored) converted = applyCadEdits(converted, conversion(converted, 'bore'));
      expect(sketchOf(converted).profiles).toEqual([]);
      expectSame(built(converted), expected);
      // The converted document saves its records alone and loads back to the same build.
      const reloaded = parseCadDocument(JSON.parse(storedCadDocumentText(converted)));
      expect(storedCadDocumentText(reloaded)).toBe(storedCadDocumentText(converted));
      expectSame(built(reloaded), expected);
    }
  }, 120_000);

  it('keep a construction profile out of the material, as a construction generator', () => {
    const geometry = FIXTURES[0].geometry;
    const legacy = sketchDocument({ profiles: [{ id: 'shape', name: 'Shape', construction: false, geometry }, { id: 'guide', name: 'Guide', construction: true, geometry: bore }] });
    const generated = sketchDocument({ graph: { points: [], entities: [], relations: [generator('shape', geometry), { ...generator('guide', bore), construction: true }] } });
    expectSame(built(generated), built(legacy));
    expect(built(generated).area).toBeCloseTo(1200, 7);
  }, 60_000);
});
