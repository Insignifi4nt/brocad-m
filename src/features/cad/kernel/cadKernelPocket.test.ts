// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import initOpenCascade from 'replicad-opencascadejs';
import { getOC, measureVolume, setOC, Sketch, type Shape3D, type Wire } from 'replicad';
import type { CadDocument, CadFeature, CadPlane, CadProfile, CadSketchFeature } from '../../../domain/cad/cadDocument';
import { type CadPocketFeature } from '../../../domain/cad/cadPocket';
import { parseCadDocument } from '../../../domain/cad/cadSchema';
import { buildCadKernelModel, type CadKernelModel } from './cadKernelModel';
import { prepareCadSolidImport } from './cadKernelImport';
import { cadKernelBuilders } from './cadKernelBuilders';
import { watchCadKernelBuilders } from './__tests__/cadKernelBuilderWatch';

beforeAll(async () => {
  const wasmBinary = await readFile(new URL('../../../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  setOC(await initOpenCascade({ wasmBinary, print: () => undefined, printErr: () => undefined }));
}, 60_000);
const base = (id: string) => ({ id, name: id, suppressed: false });
const circle = (radius: number | string = 3, x = 0): CadProfile => ({ kind: 'circle', x, y: 0, radius });
function profile(geometry: CadProfile = circle(), offset: number | string = 0, plane: CadPlane = 'XY'): CadSketchFeature {
  return { ...base('profile'), kind: 'sketch', plane, offset, profiles: [{ id: 'boundary', name: 'Boundary', construction: false, geometry }] };
}
function stock(thickness: number | string = 10, plane: CadPlane = 'XY', offset = 0, size = 20): readonly CadFeature[] {
  return [{ ...profile({ kind: 'rectangle', x: -size / 2, y: -size / 2, width: size, height: size, cornerRadius: 0 }, offset, plane), id: 'stock_profile' },
    { ...base('stock'), kind: 'extrude', sketchId: 'stock_profile', distance: thickness, symmetric: false, operation: 'new', targetId: null }];
}
const pocket = (direction: CadPocketFeature['extent']['direction'] = 'both', targetId = 'stock'): CadPocketFeature => ({ ...base('pocket'), kind: 'pocket', sketchId: 'profile', targetId, extent: { kind: 'through-all', direction } });
function document(features: readonly CadFeature[], parameters: Readonly<Record<string, number>> = {}): CadDocument {
  return { format: 'wireedm-cad', schemaVersion: 1, id: 'pocket_test', name: 'Pocket test', units: 'mm', features, parameters };
}
function built(features: readonly CadFeature[], check: (model: CadKernelModel) => void, parameters: Readonly<Record<string, number>> = {}) {
  const model = buildCadKernelModel(document(features, parameters));
  try { check(model); } finally { model.dispose(); model.dispose(); }
}

describe('exact target-derived Through-all Pocket', () => {
  it.each(['XY', 'XZ', 'YZ'] satisfies CadPlane[])('cuts exactly the requested side of the authored %s station', plane => {
    for (const direction of ['positive', 'negative', 'both'] satisfies CadPocketFeature['extent']['direction'][]) {
      const model = buildCadKernelModel(parseCadDocument(document([...stock(10, plane), profile(circle(), 5, plane), pocket(direction)])));
      try {
        expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes).toHaveLength(1);
        expect(model.result.meshes[0].volume).toBeCloseTo(4000 - (direction === 'both' ? 90 : 45) * Math.PI, 6);
        for (const [offset, removed] of [[2, direction !== 'positive'], [8, direction !== 'negative']] as const) {
          expect(model.section({ bodyId: 'pocket', plane, offset }).contourCount).toBe(removed ? 2 : 1);
        }
        expect(() => model.section({ bodyId: 'stock', plane, offset: 2 })).toThrow('unavailable');
      } finally { model.dispose(); }
    }
  });
  it('follows upstream parameter changes while legacy distance cuts retain their specified depth', () => {
    const features = [...stock('thickness'), profile(), pocket()];
    for (const thickness of [10, 20]) built(features, model => {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo((400 - 9 * Math.PI) * thickness, 6);
      expect(model.section({ bodyId: 'pocket', plane: 'XY', offset: thickness - 1 }).contourCount).toBe(2);
    }, { thickness });
    const distance: CadFeature = { ...base('distance_cut'), kind: 'extrude', sketchId: 'profile', distance: 15, symmetric: false, operation: 'cut', targetId: 'stock' };
    built([...stock('thickness'), profile(), distance], model => {
      expect(model.result.diagnostics).toEqual([]); expect(model.section({ bodyId: 'distance_cut', plane: 'XY', offset: 17 }).contourCount).toBe(1);
    }, { thickness: 20 });
  });
  it('uses absolute target stations when Both starts from a remote authored sketch plane', () => {
    built([...stock(), profile(circle(), 1e9), pocket()], model => {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo(4000 - 90 * Math.PI, 6);
      expect(model.section({ bodyId: 'pocket', plane: 'XY', offset: 5 }).contourCount).toBe(2);
    });
  });
  it('derives extent from a transformed target prefix and exact imported STEP originals', async () => {
    const moved: CadFeature = { ...base('moved'), kind: 'transform', sourceId: 'stock', translation: [0, 0, 25], rotation: [0, 0, 0] };
    built([...stock(), moved, profile(circle(), 10), pocket('positive', 'moved')], model => {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo(4000 - 90 * Math.PI, 6);
      expect(model.section({ bodyId: 'pocket', plane: 'XY', offset: 30 }).contourCount).toBe(2);
    });
    const original = buildCadKernelModel(document(stock(10, 'XY', 40))); let source: string;
    try { source = await original.export('step').text(); } finally { original.dispose(); }
    const imported: CadFeature = { ...base('imported'), kind: 'imported', source: { format: 'step', fileName: 'stock.step', encoding: 'utf8', data: source } };
    built([imported, profile(circle(), 0), pocket('both', 'imported')], model => {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo(4000 - 90 * Math.PI, 6);
      expect(model.section({ bodyId: 'pocket', plane: 'XY', offset: 45 }).contourCount).toBe(2);
    });
  });
  it('covers every depth of a disconnected compound and preserves all solids through STEP', async () => {
    const upper = stock(5, 'XY', 20).map(feature => feature.kind === 'sketch' ? { ...feature, id: 'upper_profile' }
      : feature.kind === 'extrude' ? { ...feature, id: 'upper', sketchId: 'upper_profile' } : feature);
    const union: CadFeature = { ...base('compound'), kind: 'boolean', operation: 'union', targetId: 'stock', toolId: 'upper' };
    const model = buildCadKernelModel(parseCadDocument(document([...stock(5), ...upper, union, profile(circle(), 10), pocket('both', 'compound')])));
    try {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo(4000 - 90 * Math.PI, 6);
      for (const offset of [2, 22]) expect(model.section({ bodyId: 'pocket', plane: 'XY', offset }).contourCount).toBe(2);
      const imported = prepareCadSolidImport({ format: 'step', encoding: 'utf8', fileName: 'compound.step', data: await model.export('step').text() });
      expect(imported.solidCount).toBe(2); expect(imported.volume).toBeCloseTo(4000 - 90 * Math.PI, 6);
    } finally { model.dispose(); }
  });
  it('preserves a legitimate split target and all nested void/island boundaries', async () => {
    const split = profile({ kind: 'rectangle', x: -1, y: -20, width: 2, height: 40, cornerRadius: 0 });
    const model = buildCadKernelModel(document([...stock(), split, pocket()]));
    try {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo(3600, 6);
      expect(model.section({ bodyId: 'pocket', plane: 'XY', offset: 5 }).contourCount).toBe(2);
      expect(prepareCadSolidImport({ format: 'step', encoding: 'utf8', fileName: 'split.step', data: await model.export('step').text() }).solidCount).toBe(2);
    } finally { model.dispose(); }
    const nested = profile(circle(4));
    built([...stock(), { ...nested, profiles: [...nested.profiles,
      { id: 'hole', name: 'Hole', construction: false, geometry: circle(3) },
      { id: 'island', name: 'Island', construction: false, geometry: circle(1) },
      { id: 'construction', name: 'Construction', construction: true, geometry: circle(1, 9) }] }, pocket()], next => {
      expect(next.result.diagnostics).toEqual([]); expect(next.result.meshes[0].volume).toBeCloseTo(4000 - 80 * Math.PI, 6);
      expect(next.section({ bodyId: 'pocket', plane: 'XY', offset: 5 }).contourCount).toBe(4);
    });
  });
  it('proves a tiny bore in a huge target using Common material rather than noisy whole-body subtraction', () => {
    built([...stock(1e6, 'XY', 0, 1e6), profile(circle(.001)), pocket()], model => {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes).toHaveLength(1);
      const section = model.section({ bodyId: 'pocket', plane: 'XY', offset: 500000 }); expect(section.contourCount).toBe(2);
      expect(section.entities.some(entity => (entity.type === 'circle' || entity.type === 'arc') && Math.abs(entity.radius - .001) < 1e-9)).toBe(true);
    });
  });
  it('retains unrelated history bodies and reusable source sketches', () => {
    const other: CadFeature = { ...base('other'), kind: 'extrude', sketchId: 'stock_profile', distance: -5, symmetric: false, operation: 'new', targetId: null };
    const reused: CadFeature = { ...base('reused'), kind: 'extrude', sketchId: 'profile', distance: 2, symmetric: false, operation: 'new', targetId: null };
    built([...stock(), other, profile(), pocket(), reused], model => {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes.map(mesh => mesh.featureId)).toEqual(['other', 'pocket', 'reused']);
      expect(model.result.meshes[0].volume).toBeCloseTo(2000, 6); expect(model.result.meshes[2].volume).toBeCloseTo(18 * Math.PI, 6);
    });
  });
  it('diagnoses a native-tolerance-scale removed sliver rather than claiming confirmed material removal', () => {
    const section = profile(circle(3));
    const ring = { ...section, profiles: [...section.profiles, { id: 'hole', name: 'Hole', construction: false, geometry: circle(3 - 5e-7) }] };
    built([...stock(), ring, pocket()], model => {
      expect(model.result.diagnostics[0]).toMatchObject({ featureId: 'pocket', code: 'unsupported-pocket-removal' });
      expect(model.result.meshes[0].featureId).toBe('stock');
    });
  });
  it('does not hide an uncertain Common component behind a well-resolved broad hole', () => {
    const thin: readonly CadFeature[] = [{ ...profile(circle(3, 30), 20), id: 'thin_profile' },
      { ...base('thin'), kind: 'extrude', sketchId: 'thin_profile', distance: 5e-6, symmetric: false, operation: 'new', targetId: null }];
    const union: CadFeature = { ...base('compound'), kind: 'boolean', operation: 'union', targetId: 'stock', toolId: 'thin' };
    const section = profile(circle(), 20 + 4.25e-6);
    const two = { ...section, profiles: [...section.profiles, { id: 'second', name: 'Second', construction: false, geometry: circle(3, 30) }] };
    built([...stock(30), ...thin, union, two, pocket('positive', 'compound')], model => {
      expect(model.result.diagnostics[0]).toMatchObject({ featureId: 'pocket', code: 'unsupported-pocket-removal' });
      expect(model.result.diagnostics[0].message).toContain('component');
      expect(model.result.meshes[0].featureId).toBe('compound');
    });
  });
  it('rejects a far-coordinate unresolved target component before Common can omit it and Cut can leave a spurious residual', () => {
    const thin: readonly CadFeature[] = [{ ...profile(circle(), 20), id: 'thin_profile' },
      { ...base('thin'), kind: 'extrude', sketchId: 'thin_profile', distance: 6e-7, symmetric: false, operation: 'new', targetId: null }];
    const union: CadFeature = { ...base('compound'), kind: 'boolean', operation: 'union', targetId: 'stock', toolId: 'thin' };
    const moved: CadFeature = { ...base('moved'), kind: 'transform', sourceId: 'compound', translation: [1e8, 0, 0], rotation: [0, 0, 0] };
    const common = vi.spyOn(cadKernelBuilders, 'common'); const cut = vi.spyOn(cadKernelBuilders, 'cut');
    try {
      built([...stock(), ...thin, union, moved, profile(circle(3, 1e8)), pocket('both', 'moved')], model => {
        expect(model.result.diagnostics[0]).toMatchObject({ featureId: 'pocket', code: 'unsupported-pocket-target' });
        expect(model.result.meshes[0].featureId).toBe('moved'); expect(() => model.export('step')).toThrow('Fix the feature diagnostics');
      });
      expect(common).not.toHaveBeenCalled(); expect(cut).not.toHaveBeenCalled();
    } finally { common.mockRestore(); cut.mockRestore(); }
  });
  it('keeps no-overlap, tangent and complete-removal failures explicit and preserves the preceding target', () => {
    for (const [geometry, offset, direction, code] of [
      [circle(3, 50), 5, 'both', 'pocket-no-material'], [circle(50), 5, 'both', 'pocket-erased'],
      [circle(), 10, 'positive', 'unsupported-pocket-precision'], [circle(), 0, 'negative', 'unsupported-pocket-precision'],
    ] satisfies readonly (readonly [CadProfile, number, CadPocketFeature['extent']['direction'], string])[]) {
      built([...stock(), profile(geometry, offset), pocket(direction)], model => {
        expect(model.result.diagnostics[0].featureId).toBe('pocket'); expect(model.result.diagnostics[0].code).toBe(code);
        expect(model.result.meshes[0].featureId).toBe('stock'); expect(model.result.meshes[0].volume).toBeCloseTo(4000, 6);
        expect(() => model.export('step')).toThrow('Fix the feature diagnostics');
      });
    }
  });
  it.each(['intersect', 'cut'] as const)('releases completed tools and source wires if %s throws, leaving the target usable', phase => {
    let target: Shape3D | undefined; let tool: Shape3D | undefined;
    const kind = phase === 'intersect' ? 'common' : 'cut', native = cadKernelBuilders[kind];
    const watch = watchCadKernelBuilders({ kinds: [kind], call: 1, error: new Error(`Interrupted Pocket ${phase}`) });
    const fail = vi.spyOn(cadKernelBuilders, kind).mockImplementation((left, other) => { target = left; tool = other; return native(left, other); });
    const wires: Wire[] = []; const originalDelete = Sketch.prototype.delete;
    const released = vi.spyOn(Sketch.prototype, 'delete').mockImplementation(function(this: Sketch) { wires.push(this.wire); originalDelete.call(this); });
    try {
      built([...stock(), profile(), pocket()], model => {
        expect(model.result.diagnostics[0]).toMatchObject({ code: 'kernel-operation-failed', details: { operation: 'pocket', input: { field: 'sketchId', id: 'profile' }, kernelMessage: `Interrupted Pocket ${phase}` } }); expect(model.result.meshes[0].featureId).toBe('stock');
        if (!target || !tool) throw new Error('Expected native Pocket operands');
        expect(measureVolume(target)).toBeCloseTo(4000, 6); const releasedTool = tool; expect(() => releasedTool.wrapped).toThrow();
        for (const wire of wires) expect(() => wire.wrapped).toThrow();
        expect(watch.failed).toHaveLength(1); expect(watch.outstanding()).toBe(0);
      });
    } finally { fail.mockRestore(); released.mockRestore(); watch.restore(); }
  });
  it('reads actual native target tolerance rather than assuming bounding-box padding', () => {
    const oc = getOC(); const actualTolerance = oc.BRep_Tool.Tolerance; let reads = 0; const kinds = new Set<unknown>();
    const tolerance = vi.spyOn(oc.BRep_Tool, 'Tolerance').mockImplementation(item => { reads++; kinds.add(item.ShapeType()); return actualTolerance(item); });
    try {
      built([...stock(), profile(), pocket()], model => expect(model.result.diagnostics).toEqual([])); expect(reads).toBeGreaterThan(100);
      for (const kind of [oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_VERTEX]) expect(kinds.has(kind)).toBe(true);
    }
    finally { tolerance.mockRestore(); }
  });
  it('releases native extrusion builders and every prepared wire when tool construction throws', () => {
    const native = getOC().BRepPrimAPI_MakePrism; const originalShape = native.prototype.Shape; let calls = 0;
    const builders: InstanceType<typeof native>[] = []; const originalDelete = native.prototype.delete;
    const released = vi.spyOn(native.prototype, 'delete').mockImplementation(function(this: InstanceType<typeof native>) { builders.push(this); originalDelete.call(this); });
    const failure = vi.spyOn(native.prototype, 'Shape').mockImplementation(function(this: InstanceType<typeof native>) {
      if (++calls === 2) throw new Error('Interrupted Pocket extrusion'); return originalShape.call(this);
    });
    const wires: Wire[] = []; const originalSketchDelete = Sketch.prototype.delete;
    const sketchDelete = vi.spyOn(Sketch.prototype, 'delete').mockImplementation(function(this: Sketch) { wires.push(this.wire); originalSketchDelete.call(this); });
    try {
      built([...stock(), profile(), pocket()], model => {
        expect(model.result.diagnostics[0]).toMatchObject({ featureId: 'pocket', code: 'kernel-operation-failed', details: { operation: 'pocket', input: { field: 'sketchId', id: 'profile' }, kernelMessage: 'Interrupted Pocket extrusion' } }); expect(model.result.meshes[0].featureId).toBe('stock');
        expect(builders).toHaveLength(2); for (const builder of builders) expect(() => builder.IsDone()).toThrow();
        for (const wire of wires) expect(() => wire.wrapped).toThrow();
      });
    } finally { failure.mockRestore(); released.mockRestore(); sketchDelete.mockRestore(); }
  });
});
