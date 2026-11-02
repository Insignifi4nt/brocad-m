// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import initOpenCascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import type { CadDocument, CadPlane, CadProfile } from '../../../domain/cad/cadDocument';
import { createCadPathProfile, createCadThreePointArc, type CadConstructionPoint } from '../../../domain/cad/cadPathConstruction';
import { createCadDocument, createCadSketchProfile, parseCadDocument } from '../../../domain/cad/cadSchema';
import { measureCadSketch } from '../../../domain/cad/cadMeasurements';
import { cadEntitiesToCam, cadSketchToDxf } from '../../../domain/cad/cadCam';
import { importCadDxfSketch } from '../../../domain/cad/cadDxfImport';
import { cadSketchProfileViews } from '../../../domain/cad/sketch-generators/cadSketchProfileViews';
import { buildCadKernelModel } from './cadKernelModel';
import { closeCadPathDraft, createCadPathDraft, updateCadPathDraft } from '../cadPathDrawing';

beforeAll(async () => {
  const wasmBinary = await readFile(new URL('../../../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  setOC(await initOpenCascade({ wasmBinary, print: () => undefined, printErr: () => undefined }));
}, 60_000);
function documentWithProfile(profile: CadProfile, plane: CadPlane = 'XY'): CadDocument {
  return parseCadDocument({ ...createCadDocument('Constructed profile', 'constructed'), features: [
    { id: 'outline', kind: 'sketch', name: 'Outline', suppressed: false, plane, offset: 0,
      profiles: [createCadSketchProfile({ id: 'boundary', geometry: profile })] },
    { id: 'solid', kind: 'extrude', name: 'Solid', suppressed: false, sketchId: 'outline', distance: 4, symmetric: false, operation: 'new', targetId: null },
  ] });
}
function verifyProfile(profile: CadProfile, expectedArea: number, plane: CadPlane = 'XY', precision = 6) {
  const document = documentWithProfile(profile, plane);
  expect(measureCadSketch(document, 'outline').materialAreaMm2).toBeCloseTo(expectedArea, precision);
  const model = buildCadKernelModel(document);
  try {
    expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes).toHaveLength(1);
    expect(model.result.meshes[0].volume).toBeCloseTo(expectedArea * 4, precision);
    const section = model.section({ bodyId: 'solid', plane, offset: 2 });
    expect(section.contourCount).toBe(1); expect(section.entities.map(entity => entity.type).sort()).toEqual(['arc', 'line']);
    expect(cadEntitiesToCam(section.entities).contours).toHaveLength(1);
  } finally { model.dispose(); }
  return document;
}

describe('constructed analytic paths in the exact native kernel', () => {
  it('carries a mixed drawing draft with a clockwise concave arc into exact BRep material without persisting transient picks', () => {
    let draft = createCadPathDraft();
    for (const point of [[0, 0], [10, 0], [10, 10], [7, 10]] satisfies CadConstructionPoint[]) draft = updateCadPathDraft(draft, { kind: 'point', point });
    draft = updateCadPathDraft(draft, { kind: 'mode', mode: 'arc' });
    draft = updateCadPathDraft(draft, { kind: 'point', point: [3, 10] });
    expect(() => closeCadPathDraft(draft)).toThrow('Finish the arc');
    draft = updateCadPathDraft(draft, { kind: 'point', point: [5, 8] });
    draft = updateCadPathDraft(draft, { kind: 'mode', mode: 'line' });
    draft = updateCadPathDraft(draft, { kind: 'point', point: [0, 10] });
    const profile = closeCadPathDraft(draft); const document = documentWithProfile(profile);
    const model = buildCadKernelModel(document);
    try {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo((100 - 2 * Math.PI) * 4, 6);
      const section = model.section({ bodyId: 'solid', plane: 'XY', offset: 2 });
      expect(section.entities.filter(entity => entity.type === 'line')).toHaveLength(5); expect(section.entities.filter(entity => entity.type === 'arc')).toHaveLength(1);
      expect(cadEntitiesToCam(section.entities).contours).toHaveLength(1);
      const storedArc = profile.segments.find(segment => segment.kind === 'arc');
      expect(storedArc?.sweep).toBeCloseTo(-180, 10); expect(storedArc).not.toHaveProperty('through'); expect(storedArc).not.toHaveProperty('end');
    } finally { model.dispose(); }
  });
  it.each(['XY', 'XZ', 'YZ'] satisfies CadPlane[])('constructs both D-profile windings as exact semicircle and chord in %s', plane => {
    for (const reverse of [false, true]) {
      const start: CadConstructionPoint = [0, reverse ? 5 : -5]; const end: CadConstructionPoint = [0, reverse ? -5 : 5];
      const arc = createCadThreePointArc({ start, end, through: [5, 0] });
      expect(arc.sweep).toBeCloseTo(reverse ? -180 : 180, 10); expect(arc.radius).toBeCloseTo(5, 10);
      const profile = createCadPathProfile(start, [{ kind: 'arc', end, through: [5, 0] }]);
      verifyProfile(profile, 25 * Math.PI / 2, plane);
    }
  });
  it.each([false, true])('preserves a major circular region through native extrusion and DXF roundtrip, clockwise=%s', clockwise => {
    const start: CadConstructionPoint = clockwise ? [0, -5] : [5, 0]; const end: CadConstructionPoint = clockwise ? [5, 0] : [0, -5];
    const arc = createCadThreePointArc({ start, end, through: [-5, 0] });
    expect(arc.sweep).toBeCloseTo(clockwise ? -270 : 270, 10);
    const profile = createCadPathProfile(start, [{ kind: 'arc', end, through: [-5, 0] }]); const area = 25 / 2 * (3 * Math.PI / 2 + 1);
    const original = verifyProfile(profile, area);
    const text = cadSketchToDxf(original, 'outline');
    const imported = importCadDxfSketch({ fileName: 'major-segment.dxf', text, sketchId: 'outline' });
    expect(imported.contourCount).toBe(1); expect(imported.sourceEntityCount).toBe(2);
    const first = original.features[0]; if (first.kind !== 'sketch') throw new Error('Expected sketch');
    const importedProfile = cadSketchProfileViews(imported.sketch)[0]; verifyProfile(importedProfile.geometry, area);
    expect(imported.sketch.source?.text).toBe(text);
  });
  it('selects the picked minor region rather than the complementary major arc', () => {
    const through: CadConstructionPoint = [5 / Math.SQRT2, 5 / Math.SQRT2];
    const arc = createCadThreePointArc({ start: [5, 0], end: [0, 5], through }); expect(arc.sweep).toBeCloseTo(90, 10);
    verifyProfile(createCadPathProfile([5, 0], [{ kind: 'arc', end: [0, 5], through }]), 25 / 2 * (Math.PI / 2 - 1));
  });
  it.each([
    { start: 359, end: 1, sweep: 2 }, { start: 1, end: 359, sweep: -2 },
    { start: 179, end: 181, sweep: -358 }, { start: 181, end: 179, sweep: 358 },
  ])('keeps the picked traversal across angular seams, sweep=$sweep', ({ start, end, sweep }) => {
    const point = (degrees: number): CadConstructionPoint => [5 * Math.cos(degrees * Math.PI / 180), 5 * Math.sin(degrees * Math.PI / 180)];
    const arc = createCadThreePointArc({ start: point(start), end: point(end), through: point(0) });
    expect(arc.sweep).toBeCloseTo(sweep, 8);
    const radians = Math.abs(sweep) * Math.PI / 180; const area = 25 / 2 * (radians - Math.sin(radians));
    verifyProfile(createCadPathProfile(point(start), [{ kind: 'arc', end: point(end), through: point(0) }]), area);
  });
  it('constructs a translated D-profile without global squared-coordinate cancellation or endpoint repair', () => {
    const origin = 1e8;
    const profile = createCadPathProfile([origin, origin - 5], [{ kind: 'arc', end: [origin, origin + 5], through: [origin + 5, origin] }]);
    const document = documentWithProfile(profile); const measured = measureCadSketch(document, 'outline');
    expect(measured.materialAreaMm2).toBeCloseTo(25 * Math.PI / 2, 6);
    const model = buildCadKernelModel(document);
    try { expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo(50 * Math.PI, 5); }
    finally { model.dispose(); }
  });
  it('keeps a valid shallow arc analytic while rejecting the unencodable shallow alternative', () => {
    const arc = createCadThreePointArc({ start: [0, 0], end: [2, 0], through: [1, .01] });
    const sweep = Math.abs(arc.sweep) * Math.PI / 180;
    const area = arc.radius ** 2 / 2 * (sweep - Math.sin(sweep));
    verifyProfile(createCadPathProfile([0, 0], [{ kind: 'arc', end: [2, 0], through: [1, .01] }]), area, 'XY', 8);
    expect(() => createCadPathProfile([0, 0], [{ kind: 'arc', end: [2, 0], through: [1, 1e-6] }])).toThrow();
  });
  it('reports native precision failure for a tiny profile near the coordinate limit and retains the preceding valid body', () => {
    const origin = 999999990;
    const profile = createCadPathProfile([origin, origin], [{ kind: 'arc', end: [origin + 2, origin], through: [origin + 1, origin + 1] }]);
    const document = documentWithProfile(profile);
    const model = buildCadKernelModel(parseCadDocument({ ...document, features: [
      { id: 'seed_sketch', kind: 'sketch', name: 'Seed', suppressed: false, plane: 'XY', offset: 0,
        profiles: [createCadSketchProfile({ id: 'seed_circle', geometry: { kind: 'circle', x: 0, y: 0, radius: 2 } })] },
      { id: 'seed_body', kind: 'extrude', name: 'Seed body', suppressed: false, sketchId: 'seed_sketch', distance: 4, symmetric: false, operation: 'new', targetId: null },
      ...document.features,
    ] }));
    try {
      expect(model.result.diagnostics[0]).toMatchObject({ featureId: 'solid', code: 'invalid-solid' });
      expect(model.result.meshes).toHaveLength(1); expect(model.result.meshes[0].featureId).toBe('seed_body');
      expect(model.result.meshes[0].volume).toBeCloseTo(16 * Math.PI, 6); expect(() => model.export('step')).toThrow('Fix the feature diagnostics');
    }
    finally { model.dispose(); }
  });
});
