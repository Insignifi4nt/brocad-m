// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import initOpenCascade from 'replicad-opencascadejs';
import { isShape3D, measureVolume, setOC, type Shape3D } from 'replicad';
import type { CadDocument, CadFeature, CadProfile, CadSketchFeature } from '../../../domain/cad/cadDocument';
import { parseCadDocument } from '../../../domain/cad/cadSchema';
import { buildCadKernelModel } from './cadKernelModel';
import { prepareCadSolidImport } from './cadKernelImport';
import { cadKernelBuilders } from './cadKernelBuilders';
import { watchCadKernelBuilders } from './__tests__/cadKernelBuilderWatch';

beforeAll(async () => {
  const wasmBinary = await readFile(new URL('../../../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  setOC(await initOpenCascade({ wasmBinary, print: () => undefined, printErr: () => undefined }));
}, 60_000);
type Family = 'loft' | 'sweep' | 'boolean';
type Placement = 'valid' | 'disjoint' | 'tangent' | 'erase';
const families = ['loft', 'sweep', 'boolean'] as const;
const base = (id: string) => ({ id, name: id, suppressed: false });
function sketch(id: string, geometry: CadProfile, offset = 0, plane: CadSketchFeature['plane'] = 'XY'): CadSketchFeature {
  return { ...base(id), kind: 'sketch', plane, offset, profiles: [{ id: id + '_contour', name: id, construction: false, geometry }] };
}
function fixture(family: Family, placement: Placement) {
  const radius = placement === 'erase' ? 50 : 3, position = placement === 'disjoint' ? 50 : placement === 'tangent' ? 13 : 0;
  const features: CadFeature[] = [sketch('stock_profile', { kind: 'rectangle', x: -10, y: -10, width: 20, height: 20, cornerRadius: 0 }),
    { ...base('stock'), kind: 'extrude', sketchId: 'stock_profile', distance: 10, symmetric: false, operation: 'new', targetId: null },
    { ...base('other'), kind: 'extrude', sketchId: 'stock_profile', distance: -5, symmetric: false, operation: 'new', targetId: null }];
  const circle: CadProfile = { kind: 'circle', x: position, y: 0, radius };
  let toolVolume: number;
  if (family === 'loft') {
    features.push(sketch('lower', circle), sketch('upper', circle, 10),
      { ...base('cut'), kind: 'loft', sketchIds: ['lower', 'upper'], ruled: false, operation: 'cut', targetId: 'stock' });
    toolVolume = Math.PI * radius ** 2 * 10;
  } else if (family === 'sweep') {
    const start = placement === 'erase' ? -20 : 0, end = placement === 'erase' ? 20 : 5;
    features.push(sketch('section', { kind: 'circle', x: position, y: 5, radius }, start, 'YZ'),
      { ...base('rail'), kind: 'curve', plane: 'XY', offset: 5, segments: [{ kind: 'line', start: [start, position], end: [end, position] }] },
      { ...base('cut'), kind: 'sweep', sketchId: 'section', curveId: 'rail', operation: 'cut', targetId: 'stock' });
    toolVolume = Math.PI * radius ** 2 * (end - start);
  } else {
    features.push(sketch('tool_profile', circle),
      { ...base('tool'), kind: 'extrude', sketchId: 'tool_profile', distance: 10, symmetric: false, operation: 'new', targetId: null },
      { ...base('cut'), kind: 'boolean', operation: 'cut', targetId: 'stock', toolId: 'tool' });
    toolVolume = Math.PI * radius ** 2 * 10;
  }
  const document: CadDocument = { format: 'wireedm-cad', schemaVersion: 1, id: 'cut_family_test', name: 'Cut family test', units: 'mm', parameters: {}, features };
  return { document, toolVolume, prefix: family === 'boolean' ? ['stock', 'other', 'tool'] : ['stock', 'other'] };
}

describe('confirmed material removal across existing Cut families', () => {
  it.each(families.flatMap(family => (['disjoint', 'tangent'] as const).map(placement => ({ family, placement }))))('rejects a $placement $family Cut and retains all preceding bodies', ({ family, placement }) => {
    const input = fixture(family, placement), original = JSON.stringify(input.document);
    const model = buildCadKernelModel(parseCadDocument(input.document));
    try {
      expect(model.result.diagnostics[0]).toMatchObject({ featureId: 'cut', code: 'cut-no-material' }); expect(model.result.diagnostics[0].message).toContain('target');
      expect(model.result.diagnostics[1]).toMatchObject({ featureId: 'cut', code: 'rebuild-stopped' });
      expect(model.result.meshes.map(mesh => mesh.featureId)).toEqual(input.prefix);
      expect(model.result.meshes[0].volume).toBeCloseTo(4000, 7); expect(model.result.meshes[1].volume).toBeCloseTo(2000, 7);
      if (family === 'boolean') expect(model.result.meshes[2].volume).toBeCloseTo(input.toolVolume, 7);
      expect(() => model.export('step')).toThrow('Fix the feature diagnostics');
      expect(model.inspectTopology({ bodyId: 'stock', expectedBuildId: model.result.buildId, selection: { kind: 'page', topology: 'edge', offset: 0, limit: 12 } }).total).toBe(12);
      expect(JSON.stringify(input.document)).toBe(original);
    } finally { model.dispose(); }
  });
  it.each(families)('accepts an analytic %s removal, preserves unrelated material and consumes only its operands', async family => {
    const input = fixture(family, 'valid'), original = JSON.stringify(input.document);
    const model = buildCadKernelModel(parseCadDocument(input.document));
    try {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes.map(mesh => mesh.featureId)).toEqual(['other', 'cut']);
      expect(model.result.meshes[0].volume).toBeCloseTo(2000, 7); expect(model.result.meshes[1].volume).toBeCloseTo(4000 - input.toolVolume, 7);
      expect(model.section({ bodyId: 'cut', plane: family === 'sweep' ? 'YZ' : 'XY', offset: family === 'sweep' ? 2.5 : 5 }).contourCount).toBe(2);
      expect(() => model.section({ bodyId: 'stock', plane: 'XY', offset: 5 })).toThrow('unavailable');
      if (family === 'boolean') expect(() => model.section({ bodyId: 'tool', plane: 'XY', offset: 5 })).toThrow('unavailable');
      const imported = prepareCadSolidImport({ format: 'step', fileName: 'cut-family.step', encoding: 'utf8', data: await model.export('step').text() });
      expect(imported.solidCount).toBe(2); expect(imported.volume).toBeCloseTo(6000 - input.toolVolume, 7);
      expect(JSON.stringify(input.document)).toBe(original);
    } finally { model.dispose(); }
  });
  it.each(families)('rejects entire %s erasure without consuming its target or accepted tool', family => {
    const input = fixture(family, 'erase'); let result: Shape3D | undefined;
    const nativeCut = cadKernelBuilders.cut, watch = watchCadKernelBuilders();
    const capture = vi.spyOn(cadKernelBuilders, 'cut').mockImplementation((target, other) => {
      if (!isShape3D(other)) throw new Error('Expected cutting solid'); result = nativeCut(target, other); return result;
    });
    try {
      const model = buildCadKernelModel(parseCadDocument(input.document));
      try {
        expect(model.result.diagnostics[0]).toMatchObject({ featureId: 'cut', code: 'cut-erased' });
        expect(model.result.meshes.map(mesh => mesh.featureId)).toEqual(input.prefix); expect(model.result.meshes[0].volume).toBeCloseTo(4000, 7);
        if (!result) throw new Error('Expected native result'); const rejected = result; expect(() => rejected.wrapped).toThrow();
        if (family === 'boolean') expect(model.result.meshes[2].volume).toBeCloseTo(input.toolVolume, 6);
        expect(watch.builders.map(item => item.kind)).toContain('cut'); expect(watch.outstanding()).toBe(0);
      } finally { model.dispose(); }
    } finally { capture.mockRestore(); watch.restore(); }
  });
  it.each(families.flatMap(family => (['intersect', 'cut'] as const).map(phase => ({ family, phase }))))('keeps native ownership after interrupted $family $phase', ({ family, phase }) => {
    const input = fixture(family, 'valid'); let target: Shape3D | undefined, tool: Shape3D | undefined, common: Shape3D | undefined;
    const { common: nativeCommon, cut: nativeCut } = cadKernelBuilders;
    // The interrupted builder fails inside its adapter, after it has run, so the adapter's cleanup is under test.
    const watch = watchCadKernelBuilders({ kinds: [phase === 'intersect' ? 'common' : 'cut'], call: 1, error: new Error(`Interrupted ${family} ${phase}`) });
    const commonSpy = phase === 'cut' ? vi.spyOn(cadKernelBuilders, 'common').mockImplementation((left, right) => { common = nativeCommon(left, right); return common; }) : null;
    const fail = vi.spyOn(cadKernelBuilders, phase === 'intersect' ? 'common' : 'cut').mockImplementation((left, other) => {
      if (!isShape3D(other)) throw new Error('Expected cutting solid'); target = left; tool = other; return (phase === 'intersect' ? nativeCommon : nativeCut)(left, other);
    });
    try {
      const model = buildCadKernelModel(parseCadDocument(input.document));
      try {
        expect(model.result.diagnostics[0]).toMatchObject({ featureId: 'cut', code: 'kernel-operation-failed', details: { operation: 'cut', kernelMessage: `Interrupted ${family} ${phase}` } });
        expect(model.result.meshes.map(mesh => mesh.featureId)).toEqual(input.prefix);
        if (!target || !tool) throw new Error('Expected native operands'); expect(measureVolume(target)).toBeCloseTo(4000, 7);
        const retainedTool = tool;
        if (family === 'boolean') expect(measureVolume(retainedTool)).toBeCloseTo(input.toolVolume, 7);
        else expect(() => retainedTool.wrapped).toThrow();
        if (phase === 'cut') { if (!common) throw new Error('Expected owned Common'); const released = common; expect(() => released.wrapped).toThrow(); }
        expect(watch.failed).toHaveLength(1); expect(watch.outstanding()).toBe(0);
      } finally { model.dispose(); }
    } finally { fail.mockRestore(); commonSpy?.mockRestore(); watch.restore(); }
  });
});
