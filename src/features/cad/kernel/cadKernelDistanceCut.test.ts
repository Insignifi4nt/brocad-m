// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import initOpenCascade from 'replicad-opencascadejs';
import { isShape3D, measureVolume, setOC, type Shape3D } from 'replicad';
import type { CadDocument, CadFeature, CadProfile, CadSketchFeature } from '../../../domain/cad/cadDocument';
import { parseCadDocument } from '../../../domain/cad/cadSchema';
import { buildCadKernelModel } from './cadKernelModel';
import { prepareCadSolidImport } from './cadKernelImport';
import { createCadKernelRuntime } from './cadKernelRuntime';
import { cadKernelBuilders } from './cadKernelBuilders';
import { watchCadKernelBuilders } from './__tests__/cadKernelBuilderWatch';

beforeAll(async () => {
  const wasmBinary = await readFile(new URL('../../../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  setOC(await initOpenCascade({ wasmBinary, print: () => undefined, printErr: () => undefined }));
}, 60_000);
const base = (id: string) => ({ id, name: id, suppressed: false });
const circle = (radius = 3, x = 0): CadProfile => ({ kind: 'circle', x, y: 0, radius });
function sketch(id: string, geometry: CadProfile, offset = 0, plane: CadSketchFeature['plane'] = 'XY'): CadSketchFeature {
  return { ...base(id), kind: 'sketch', plane, offset, profiles: [{ id: id + '_contour', name: id, construction: false, geometry }] };
}
function stock(size = 20, height = 10, plane: CadSketchFeature['plane'] = 'XY'): readonly CadFeature[] {
  return [sketch('stock_profile', { kind: 'rectangle', x: -size / 2, y: -size / 2, width: size, height: size, cornerRadius: 0 }, 0, plane),
    { ...base('stock'), kind: 'extrude', sketchId: 'stock_profile', distance: height, symmetric: false, operation: 'new', targetId: null }];
}
const cut = (distance = 10): Extract<CadFeature, { kind: 'extrude' }> => ({ ...base('cut'), kind: 'extrude', sketchId: 'tool', distance, symmetric: false, operation: 'cut', targetId: 'stock' });
const revolve = (angle = 360): Extract<CadFeature, { kind: 'revolve' }> => ({ ...base('cut'), kind: 'revolve', sketchId: 'tool', angle, axis: 'y', operation: 'cut', targetId: 'stock' });
function document(features: readonly CadFeature[]): CadDocument {
  return { format: 'wireedm-cad', schemaVersion: 1, id: 'distance_cut_test', name: 'Distance cut test', units: 'mm', parameters: {}, features };
}

describe('confirmed material removal by sketch-based Distance Cut', () => {
  it.each([
    ['disjoint extrusion', circle(3, 50), 0, cut()],
    ['outward extrusion from the top face', circle(), 10, cut(5)],
    ['outward extrusion from the bottom face', circle(), 0, cut(-5)],
    ['laterally tangent extrusion', circle(3, 13), 0, cut()],
    ['disjoint revolution', { kind: 'rectangle', x: 50, y: -5, width: 1, height: 10, cornerRadius: 0 }, 0, revolve()],
    ['outward half revolution', { kind: 'rectangle', x: 1, y: -5, width: 1, height: 10, cornerRadius: 0 }, 0, revolve(180)],
    ['tangent revolution', { kind: 'rectangle', x: 1, y: 10, width: 1, height: 1, cornerRadius: 0 }, 0, revolve()],
  ] satisfies readonly (readonly [string, CadProfile, number, CadFeature])[])('diagnoses %s and retains the preceding target', async (_label, geometry, offset, feature) => {
    const input = document([...stock(), sketch('tool', geometry, offset), feature]); const original = JSON.stringify(input);
    const model = buildCadKernelModel(parseCadDocument(input));
    try {
      expect(model.result.diagnostics[0]).toMatchObject({ featureId: 'cut', code: 'cut-no-material' });
      expect(model.result.diagnostics[0].message).toMatch(/sketch|profile/); expect(model.result.diagnostics[0].message).toContain('direction');
      expect(model.result.diagnostics[1]).toMatchObject({ featureId: 'cut', code: 'rebuild-stopped' });
      expect(model.result.meshes.map(mesh => mesh.featureId)).toEqual(['stock']); expect(model.result.meshes[0].volume).toBeCloseTo(4000, 7);
      expect(() => model.export('step')).toThrow('Fix the feature diagnostics'); expect(() => model.section({ bodyId: 'stock', plane: 'XY', offset: 5 })).toThrow('Fix the model diagnostics');
      expect(model.inspectTopology({ bodyId: 'stock', expectedBuildId: model.result.buildId, selection: { kind: 'page', topology: 'face', offset: 0, limit: 12 } }).total).toBe(6);
      expect(JSON.stringify(input)).toBe(original);
    } finally { model.dispose(); }
  });
  it('accepts a small blind removal with an independently specified cylindrical volume and exact section', async () => {
    const radius = .002, depth = .005;
    const model = buildCadKernelModel(parseCadDocument(document([...stock(), sketch('tool', circle(radius)), cut(depth)])));
    try {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].featureId).toBe('cut');
      expect(model.result.meshes[0].volume).toBeCloseTo(4000 - Math.PI * radius ** 2 * depth, 9);
      const section = model.section({ bodyId: 'cut', plane: 'XY', offset: depth / 2 }); expect(section.contourCount).toBe(2);
      expect(section.entities.some(entity => (entity.type === 'arc' || entity.type === 'circle') && Math.abs(entity.radius - radius) < 1e-10)).toBe(true);
      expect(model.section({ bodyId: 'cut', plane: 'XY', offset: depth * 2 }).contourCount).toBe(1);
      const exported = prepareCadSolidImport({ format: 'step', fileName: 'blind.step', encoding: 'utf8', data: await model.export('step').text() });
      expect(exported.solidCount).toBe(1); expect(exported.volume).toBeCloseTo(4000 - Math.PI * radius ** 2 * depth, 9);
    } finally { model.dispose(); }
  });
  it('confirms a tiny bore in a huge target without depending on whole-target volume subtraction', () => {
    const model = buildCadKernelModel(parseCadDocument(document([...stock(1e6, 1e6), sketch('tool', circle(.001)), cut(1)])));
    try {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].featureId).toBe('cut');
      const section = model.section({ bodyId: 'cut', plane: 'XY', offset: .5 }); expect(section.contourCount).toBe(2);
      expect(section.entities.some(entity => (entity.type === 'arc' || entity.type === 'circle') && Math.abs(entity.radius - .001) < 1e-10)).toBe(true);
      expect(model.section({ bodyId: 'cut', plane: 'XY', offset: 2 }).contourCount).toBe(1);
    } finally { model.dispose(); }
  });
  it('confirms the intersected half of a revolved annulus using its analytic removed volume', () => {
    const geometry: CadProfile = { kind: 'rectangle', x: 1, y: -5, width: 1, height: 10, cornerRadius: 0 };
    const model = buildCadKernelModel(parseCadDocument(document([...stock(), sketch('tool', geometry), revolve()])));
    try {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].featureId).toBe('cut');
      expect(model.result.meshes[0].volume).toBeCloseTo(4000 - Math.PI * (2 ** 2 - 1 ** 2) * 10 / 2, 7);
    } finally { model.dispose(); }
  });
  it.each(['XY', 'XZ', 'YZ'] as const)('preserves signed and symmetric Distance Cut placement on %s', plane => {
    for (const [distance, symmetric, inside, outside] of [[2, false, 6, 2], [-2, false, 4, 8], [4, true, 6, 8]] as const) {
      const model = buildCadKernelModel(parseCadDocument(document([...stock(20, 10, plane), sketch('tool', circle(1), 5, plane), { ...cut(distance), symmetric }])));
      try {
        expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo(4000 - Math.PI * Math.abs(distance), 7);
        expect(model.section({ bodyId: 'cut', plane, offset: inside }).contourCount).toBe(2);
        expect(model.section({ bodyId: 'cut', plane, offset: outside }).contourCount).toBe(1);
      } finally { model.dispose(); }
    }
  });
  it('retains confirmed material removal on a translated and rotated datum frame', () => {
    const datum: CadFeature = { ...base('datum'), kind: 'datum-plane', definition: { kind: 'world', basePlane: 'XY', origin: [37, -24, 11], rotation: [23, -37, 61] } };
    const plane = { kind: 'datum-plane', featureId: 'datum' } as const;
    const model = buildCadKernelModel(parseCadDocument(document([datum, ...stock(20, 10, plane), sketch('tool', circle(2), 5, plane), cut(-2)])));
    try {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo(4000 - Math.PI * 4 * 2, 7);
    } finally { model.dispose(); }
  });
  it('diagnoses complete erasure and releases the rejected native result while preserving the target', () => {
    let result: Shape3D | undefined;
    const nativeCut = cadKernelBuilders.cut, watch = watchCadKernelBuilders();
    const capture = vi.spyOn(cadKernelBuilders, 'cut').mockImplementation((target, other) => {
      if (!isShape3D(other)) throw new Error('Expected a cutting solid');
      result = nativeCut(target, other); return result;
    });
    try {
      const model = buildCadKernelModel(parseCadDocument(document([...stock(), sketch('tool', circle(50)), cut(20)])));
      try {
        expect(model.result.diagnostics[0]).toMatchObject({ featureId: 'cut', code: 'cut-erased' });
        expect(model.result.meshes[0].featureId).toBe('stock'); expect(model.result.meshes[0].volume).toBeCloseTo(4000, 7);
        if (!result) throw new Error('Expected the completed native result'); const rejected = result; expect(() => rejected.wrapped).toThrow();
        expect(watch.builders.map(item => item.kind)).toContain('cut'); expect(watch.outstanding()).toBe(0);
      } finally { model.dispose(); }
    } finally { capture.mockRestore(); watch.restore(); }
  });
  it('does not hide an unresolved cutting annulus behind a broad cutting component', () => {
    const tool = sketch('tool', circle());
    const mixed = { ...tool, profiles: [...tool.profiles,
      { id: 'inner', name: 'Ring bore', construction: false, geometry: circle(3 - 5e-7) },
      { id: 'broad', name: 'Broad cutter', construction: false, geometry: circle(2, 6) }] };
    const model = buildCadKernelModel(parseCadDocument(document([...stock(), mixed, cut()])));
    try {
      expect(model.result.diagnostics[0]).toMatchObject({ featureId: 'cut', code: 'unsupported-cut-removal' });
      expect(model.result.diagnostics[0].message).toContain('component'); expect(model.result.meshes[0].featureId).toBe('stock');
      expect(model.result.meshes[0].volume).toBeCloseTo(4000, 7);
    } finally { model.dispose(); }
  });
  it('does not hide a thin intersected target component behind a broad confirmed removal', () => {
    const thinProfile = sketch('thin_profile', circle(3, 30), 20);
    const thin: CadFeature = { ...base('thin'), kind: 'extrude', sketchId: thinProfile.id, distance: 5e-6, symmetric: false, operation: 'new', targetId: null };
    const union: CadFeature = { ...base('compound'), kind: 'boolean', operation: 'union', targetId: 'stock', toolId: thin.id };
    const tool = sketch('tool', circle(), 20 + 4.25e-6);
    const two = { ...tool, profiles: [...tool.profiles, { id: 'second', name: 'Thin component cutter', construction: false, geometry: circle(3, 30) }] };
    const model = buildCadKernelModel(parseCadDocument(document([...stock(20, 30), thinProfile, thin, union, two, { ...cut(1), targetId: 'compound' }])));
    try {
      expect(model.result.diagnostics[0]).toMatchObject({ featureId: 'cut', code: 'unsupported-cut-removal' });
      expect(model.result.diagnostics[0].message).toContain('intersected target component'); expect(model.result.meshes[0].featureId).toBe('compound');
    } finally { model.dispose(); }
  });
  it('refuses an unresolved far-coordinate target component before native intersection can omit it', () => {
    const thinProfile = sketch('thin_profile', circle(), 20);
    const thin: CadFeature = { ...base('thin'), kind: 'extrude', sketchId: thinProfile.id, distance: 6e-7, symmetric: false, operation: 'new', targetId: null };
    const union: CadFeature = { ...base('compound'), kind: 'boolean', operation: 'union', targetId: 'stock', toolId: thin.id };
    const moved: CadFeature = { ...base('moved'), kind: 'transform', sourceId: 'compound', translation: [1e8, 0, 0], rotation: [0, 0, 0] };
    const common = vi.spyOn(cadKernelBuilders, 'common'), subtract = vi.spyOn(cadKernelBuilders, 'cut');
    try {
      const model = buildCadKernelModel(parseCadDocument(document([...stock(), thinProfile, thin, union, moved, sketch('tool', circle(3, 1e8)), { ...cut(30), targetId: 'moved' }])));
      try {
        expect(model.result.diagnostics[0]).toMatchObject({ featureId: 'cut', code: 'unsupported-cut-target' });
        expect(model.result.meshes[0].featureId).toBe('moved'); expect(() => model.export('step')).toThrow('Fix the feature diagnostics');
        expect(common).not.toHaveBeenCalled(); expect(subtract).not.toHaveBeenCalled();
      } finally { model.dispose(); }
    } finally { common.mockRestore(); subtract.mockRestore(); }
  });
  it.each(['intersect', 'cut'] as const)('releases cutting temporaries if native %s throws and keeps the borrowed target usable', phase => {
    let target: Shape3D | undefined, tool: Shape3D | undefined, common: Shape3D | undefined;
    const { common: nativeCommon, cut: nativeCut } = cadKernelBuilders;
    const watch = watchCadKernelBuilders({ kinds: [phase === 'intersect' ? 'common' : 'cut'], call: 1, error: new Error(`Interrupted Cut ${phase}`) });
    const commonSpy = phase === 'cut' ? vi.spyOn(cadKernelBuilders, 'common').mockImplementation((left, right) => {
      common = nativeCommon(left, right); return common;
    }) : null;
    const failure = vi.spyOn(cadKernelBuilders, phase === 'intersect' ? 'common' : 'cut').mockImplementation((left, other) => {
      if (!isShape3D(other)) throw new Error('Expected a cutting solid');
      target = left; tool = other; return (phase === 'intersect' ? nativeCommon : nativeCut)(left, other);
    });
    try {
      const model = buildCadKernelModel(parseCadDocument(document([...stock(), sketch('tool', circle()), cut()])));
      try {
        expect(model.result.diagnostics[0]).toMatchObject({ featureId: 'cut', code: 'kernel-operation-failed', details: { operation: 'cut', input: { field: 'targetId', id: 'stock' }, kernelMessage: `Interrupted Cut ${phase}` } }); expect(model.result.meshes[0].featureId).toBe('stock');
        if (!target || !tool) throw new Error('Expected native cutting operands');
        expect(measureVolume(target)).toBeCloseTo(4000, 7); const releasedTool = tool; expect(() => releasedTool.wrapped).toThrow();
        if (phase === 'cut') { if (!common) throw new Error('Expected owned intersection'); const releasedCommon = common; expect(() => releasedCommon.wrapped).toThrow(); }
        expect(watch.failed).toHaveLength(1); expect(watch.outstanding()).toBe(0);
      } finally { model.dispose(); }
    } finally { failure.mockRestore(); commonSpy?.mockRestore(); watch.restore(); }
  });
  it('keeps the accepted native cache and inspection ownership when an isolated no-material candidate rejects', async () => {
    const acceptedDocument = parseCadDocument(document(stock())), candidateDocument = parseCadDocument(document([...stock(), sketch('tool', circle(3, 50)), cut()]));
    const accepted = createCadKernelRuntime(async () => undefined), candidate = createCadKernelRuntime(async () => undefined);
    const original = JSON.stringify(acceptedDocument), candidateBytes = JSON.stringify(candidateDocument);
    try {
      const first = await accepted.evaluate({ id: 1, kind: 'build', document: acceptedDocument });
      if (first.kind !== 'built') throw new Error('Expected accepted stock');
      const inspection = { bodyId: 'stock', expectedBuildId: first.result.buildId, selection: { kind: 'page', topology: 'edge', offset: 0, limit: 12 } };
      const rejected = await candidate.evaluate({ id: 2, kind: 'build', document: candidateDocument });
      if (rejected.kind !== 'built') throw new Error('Expected retained candidate prefix');
      expect(rejected.result.diagnostics[0]).toMatchObject({ featureId: 'cut', code: 'cut-no-material' }); expect(rejected.result.meshes[0].featureId).toBe('stock');
      expect(await candidate.evaluate({ id: 3, kind: 'inspect-topology', document: candidateDocument, inspection })).toMatchObject({ kind: 'error', code: 'STALE_BUILD' });
      expect(await accepted.evaluate({ id: 4, kind: 'inspect-topology', document: candidateDocument, inspection })).toMatchObject({ kind: 'error', code: 'STALE_BUILD' });
      candidate.dispose();
      expect(await accepted.evaluate({ id: 5, kind: 'inspect-topology', document: acceptedDocument, inspection })).toMatchObject({ kind: 'topology-inspected', result: { total: 12 } });
      const retained = await accepted.evaluate({ id: 6, kind: 'build', document: acceptedDocument });
      if (retained.kind !== 'built') throw new Error('Expected retained exact stock'); expect(retained.result).toBe(first.result);
      const exported = await accepted.evaluate({ id: 7, kind: 'export', document: acceptedDocument, format: 'step' });
      if (exported.kind !== 'exported') throw new Error('Expected accepted STEP');
      expect(prepareCadSolidImport({ format: 'step', fileName: 'accepted.step', encoding: 'utf8', data: await exported.blob.text() }).volume).toBeCloseTo(4000, 7);
      expect(JSON.stringify(acceptedDocument)).toBe(original); expect(JSON.stringify(candidateDocument)).toBe(candidateBytes);
    } finally { candidate.dispose(); accepted.dispose(); }
  });
});
