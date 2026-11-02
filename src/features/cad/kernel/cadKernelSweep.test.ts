// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import initOpenCascade from 'replicad-opencascadejs';
import { Face, getOC, measureVolume, setOC, Sketch, type Shape3D, type Wire } from 'replicad';
import type { CadCurveFeature, CadDocument, CadFeature, CadPlane, CadProfile, CadSketchFeature, CadSweepFeature } from '../../../domain/cad/cadDocument';
import { resolveCadSweepInputs } from '../../../domain/cad/cadSweep';
import { parseCadDocument } from '../../../domain/cad/cadSchema';
import { buildCadSweepSolid } from './cadKernelSweep';
import { cadKernelBuilders } from './cadKernelBuilders';
import { watchCadKernelBuilders } from './__tests__/cadKernelBuilderWatch';
import { buildCadKernelModel, type CadKernelModel } from './cadKernelModel';
import { prepareCadSolidImport } from './cadKernelImport';

beforeAll(async () => {
  const wasmBinary = await readFile(new URL('../../../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  setOC(await initOpenCascade({ wasmBinary, print: () => undefined, printErr: () => undefined }));
}, 60_000);
const base = (id: string) => ({ id, name: id, suppressed: false });
const circle = (radius: number | string = 1): CadProfile => ({ kind: 'circle', x: 0, y: 0, radius });
const sketch = (geometry: CadProfile = circle(), plane: CadPlane = 'YZ', offset: number | string = 0): CadSketchFeature => ({
  ...base('section'), kind: 'sketch', plane, offset, profiles: [{ id: 'boundary', name: 'Boundary', construction: false, geometry }],
});
const line: CadCurveFeature['segments'][number] = { kind: 'line', start: [0, 0], end: [20, 0] };
const quarter: CadCurveFeature['segments'][number] = { kind: 'arc', center: [0, 10], radius: 10, startAngle: -90, sweep: 90 };
const mixed: CadCurveFeature['segments'] = [
  { kind: 'line', start: [0, 0], end: [10, 0] },
  { kind: 'arc', center: [10, 10], radius: 10, startAngle: -90, sweep: 90 },
  { kind: 'line', start: [20, 10], end: [20, 20] },
];
const rail = (segments: CadCurveFeature['segments'] = [line], plane: CadPlane = 'XY', offset: number | string = 0): CadCurveFeature => ({ ...base('rail'), kind: 'curve', plane, offset, segments });
const sweep = (overrides: Partial<CadSweepFeature> = {}): CadSweepFeature => ({ ...base('sweep'), kind: 'sweep', sketchId: 'section', curveId: 'rail', operation: 'new', targetId: null, ...overrides });
const document = (features: readonly CadFeature[], parameters: Readonly<Record<string, number>> = {}): CadDocument => ({
  format: 'wireedm-cad', schemaVersion: 1, id: 'sweep_test', name: 'Sweep test', units: 'mm', features, parameters,
});
function built(features: readonly CadFeature[], check: (model: CadKernelModel) => void, parameters: Readonly<Record<string, number>> = {}) {
  const model = buildCadKernelModel(document(features, parameters));
  try { check(model); } finally { model.dispose(); model.dispose(); }
}
function inputs(section = sketch(), curve = rail(), parameters: Readonly<Record<string, number>> = {}) {
  return resolveCadSweepInputs(sweep(), new Map<string, CadFeature>([[section.id, section], [curve.id, curve]]), parameters);
}
const block: readonly CadFeature[] = [
  { ...sketch({ kind: 'rectangle', x: -5, y: -5, width: 10, height: 10, cornerRadius: 0 }), id: 'block_profile' },
  { ...base('block'), kind: 'extrude', sketchId: 'block_profile', distance: 5, symmetric: false, operation: 'new', targetId: null },
];

describe('exact segmented Sweep solids', () => {
  it('extrudes the actual section and exports a closed STEP solid with an analytic end section', async () => {
    const model = buildCadKernelModel(parseCadDocument(document([sketch(), rail(), sweep()])));
    try {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes).toHaveLength(1);
      expect(model.result.meshes[0].volume).toBeCloseTo(20 * Math.PI, 7);
      const section = model.section({ bodyId: 'sweep', plane: 'YZ', offset: 10 });
      expect(section.contourCount).toBe(1);
      expect(section.entities.every(entity => (entity.type === 'circle' || entity.type === 'arc') && Math.abs(entity.radius - 1) < 1e-8)).toBe(true);
      const source = await model.export('step').text();
      const imported = prepareCadSolidImport({ format: 'step', encoding: 'utf8', fileName: 'sweep.step', data: source });
      expect(imported.solidCount).toBe(1); expect(imported.volume).toBeCloseTo(20 * Math.PI, 7);
      expect(model.export('stl').size).toBeGreaterThan(84);
    } finally { model.dispose(); }
  });
  it.each([90, -90, 270, -270])('retains signed %s-degree analytic circular traversal', angle => {
    const curve = rail([{ kind: 'arc', center: [0, angle > 0 ? 10 : -10], radius: 10, startAngle: angle > 0 ? -90 : 90, sweep: angle }]);
    built([sketch(), curve, sweep()], model => {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo(Math.abs(angle) / 180 * 10 * Math.PI ** 2, 7);
      const section = model.section({ bodyId: 'sweep', plane: 'XY', offset: 0 });
      expect(section.contourCount).toBe(1); expect(section.entities.map(entity => entity.type).sort()).toEqual(['arc', 'arc', 'line', 'line']);
    });
  });
  it('fuses G1 line/arc/line primitives and retains exact circles at the transported terminal station', () => {
    built([sketch(), rail(mixed), sweep()], model => {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo(20 * Math.PI + 5 * Math.PI ** 2, 7);
      expect(model.section({ bodyId: 'sweep', plane: 'XZ', offset: -15 }).entities).toMatchObject([{ type: 'circle', radius: 1 }]);
      expect(model.section({ bodyId: 'sweep', plane: 'XY', offset: 0 }).entities.every(entity => entity.type === 'line' || entity.type === 'arc')).toBe(true);
    });
  });
  it.each(['XY', 'XZ', 'YZ'] satisfies CadPlane[])('uses world placement and signed principal-plane basis in %s', plane => {
    const shifted = mixed.map(segment => segment.kind === 'line'
      ? { ...segment, start: [Number(segment.start[0]) + 3, Number(segment.start[1]) + 4] satisfies [number, number], end: [Number(segment.end[0]) + 3, Number(segment.end[1]) + 4] satisfies [number, number] }
      : { ...segment, center: [Number(segment.center[0]) + 3, Number(segment.center[1]) + 4] satisfies [number, number] });
    const section = plane === 'XY' ? sketch({ kind: 'circle', x: 4, y: 7, radius: 1 }, 'YZ', 3)
      : plane === 'XZ' ? sketch({ kind: 'circle', x: -7, y: 4, radius: 1 }, 'YZ', 3)
        : sketch({ kind: 'circle', x: 7, y: 4, radius: 1 }, 'XZ', -3);
    built([section, rail(shifted, plane, 7), sweep()], model => {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo(20 * Math.PI + 5 * Math.PI ** 2, 7);
      expect(model.section({ bodyId: 'sweep', plane, offset: 7 }).contourCount).toBe(1);
    });
  });
  it.each([90, -90])('preserves an authored off-centre rectangle rather than assuming area times centreline length, angle=%s', angle => {
    const section = sketch({ kind: 'rectangle', x: 1, y: -.5, width: 2, height: 1, cornerRadius: 0 });
    const curve = rail([{ kind: 'arc', center: [0, angle > 0 ? 10 : -10], radius: 10, startAngle: angle > 0 ? -90 : 90, sweep: angle }]);
    built([section, curve, sweep()], model => {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo((angle > 0 ? 8 : 12) * Math.PI, 7);
    });
  });
  it('uses the full concave boundary and produces analytic cones when edges require them', () => {
    const section = sketch({ kind: 'polygon', points: [[-1, -1], [1, -1], [1, 1], [0, 1], [0, 0], [-1, 0]] });
    built([section, rail(mixed), sweep()], model => {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo(60 + 59 * Math.PI / 4, 7);
      expect(model.section({ bodyId: 'sweep', plane: 'XY', offset: .25 }).contourCount).toBe(1);
    });
  });
  it('reevaluates section and rail expressions, keeps references reusable, and does not mutate authored source', () => {
    const section = sketch(circle('radius')); const curve = rail([{ kind: 'line', start: [0, 0], end: ['length', 0] }]);
    const original = JSON.stringify([section, curve]);
    for (const parameters of [{ radius: 1, length: 10 }, { radius: 2, length: 30 }]) built([section, curve, sweep(), sweep({ id: 'second' })], model => {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes).toHaveLength(2);
      expect(model.result.meshes[1].volume).toBeCloseTo(Math.PI * parameters.radius ** 2 * parameters.length, 7);
    }, parameters);
    expect(JSON.stringify([section, curve])).toBe(original);
  });
  it.each(['join', 'cut'] as const)('consumes its target only after the exact %s commits', operation => {
    built([...block, sketch(), rail(), sweep({ operation, targetId: 'block' })], model => {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes).toHaveLength(1);
      expect(model.result.meshes[0].volume).toBeCloseTo(operation === 'join' ? 500 + 15 * Math.PI : 500 - 5 * Math.PI, 7);
      expect(() => model.section({ bodyId: 'block', plane: 'YZ', offset: 1 })).toThrow('unavailable');
    });
  });
  it('rejects native-valid folded rails, sharp corners, misplaced and holed sections before native construction and preserves the preceding body', () => {
    const section = sketch();
    const failures: readonly (readonly CadFeature[])[] = [
      [sketch(circle(3)), rail([{ kind: 'arc', center: [0, 2], radius: 2, startAngle: -90, sweep: 90 }]), sweep()],
      [section, rail([{ kind: 'line', start: [0, 0], end: [10, 0] }, { kind: 'line', start: [10, 0], end: [10, 10] }]), sweep()],
      [sketch(circle(), 'YZ', 5), rail(), sweep()],
      [{ ...section, profiles: [...section.profiles, { id: 'hole', name: 'Hole', construction: false, geometry: circle(.5) }] }, rail(), sweep()],
      [section, rail([{ kind: 'arc', center: [0, 10], radius: 10, startAngle: -90, sweep: 359.999 }]), sweep()],
      [{ ...section, suppressed: true }, rail(), sweep()],
    ];
    const oc = getOC(); const native = vi.spyOn(oc.BRepPrimAPI_MakeRevol.prototype, 'LastShape');
    try {
      for (const tail of failures) built([...block, ...tail], model => {
        expect(model.result.diagnostics[0].featureId).toBe('sweep'); expect(model.result.meshes[0].featureId).toBe('block');
        expect(model.result.meshes[0].volume).toBeCloseTo(500, 7); expect(() => model.export('step')).toThrow('Fix the feature diagnostics');
      });
      expect(native).not.toHaveBeenCalled();
    } finally { native.mockRestore(); }
  });
  it('bounds native work before allocations and explicitly rejects unreserved far-origin transport precision', () => {
    for (const curve of [rail(Array.from({ length: 65 }, (_, index) => ({ kind: 'line', start: [index, 0], end: [index + 1, 0] }))),
      rail([{ kind: 'line', start: [1e8, 0], end: [1e8 + 20, 0] }])]) {
      const section = curve.segments.length === 1 ? sketch(circle(), 'YZ', 1e8) : sketch();
      built([...block, section, curve, sweep()], model => {
        expect(model.result.diagnostics[0].code).toBe(curve.segments.length === 1 ? 'unsupported-sweep-precision' : 'sweep-work-limit');
        expect(model.result.meshes[0].featureId).toBe('block');
      });
    }
  });
  it('builds all 64 certified analytic segments and remains usable after disposal', () => {
    const curve = rail(Array.from({ length: 64 }, (_, index) => ({ kind: 'arc', center: [0, 10], radius: 10, startAngle: -90 + index * 90 / 64, sweep: 90 / 64 })));
    built([sketch(), curve, sweep()], model => { expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo(5 * Math.PI ** 2, 6); });
    built([sketch(), rail(), sweep()], model => expect(model.result.meshes[0].volume).toBeCloseTo(20 * Math.PI, 7));
  }, 30_000);
  it.each(['Shape', 'LastShape'] as const)('releases the native primitive, source wire and transported faces when %s throws', phase => {
    const native = getOC().BRepPrimAPI_MakeRevol; const builders: InstanceType<typeof native>[] = [];
    const originalBuilderDelete = native.prototype.delete;
    const builderDelete = vi.spyOn(native.prototype, 'delete').mockImplementation(function(this: InstanceType<typeof native>) { builders.push(this); originalBuilderDelete.call(this); });
    const wires: Wire[] = []; const originalSketchDelete = Sketch.prototype.delete;
    const sketchDelete = vi.spyOn(Sketch.prototype, 'delete').mockImplementation(function(this: Sketch) { wires.push(this.wire); originalSketchDelete.call(this); });
    const faces: Face[] = []; const originalFaceDelete = Face.prototype.delete;
    const faceDelete = vi.spyOn(Face.prototype, 'delete').mockImplementation(function(this: Face) { faces.push(this); originalFaceDelete.call(this); });
    const originalPhase = native.prototype[phase]; let calls = 0;
    const fail = vi.spyOn(native.prototype, phase).mockImplementation(function(this: InstanceType<typeof native>) {
      if (phase === 'Shape' || ++calls === 2) throw new Error(`Interrupted Sweep ${phase}`);
      return originalPhase.call(this);
    });
    try {
      const segments = phase === 'LastShape'
        ? [{ kind: 'arc', center: [0, 10], radius: 10, startAngle: -90, sweep: 45 }, { kind: 'arc', center: [0, 10], radius: 10, startAngle: -45, sweep: 45 }] satisfies CadCurveFeature['segments']
        : [quarter];
      expect(() => buildCadSweepSolid(inputs(sketch(), rail(segments)))).toThrow(`Interrupted Sweep ${phase}`);
      expect(builders).toHaveLength(phase === 'LastShape' ? 2 : 1); expect(wires).toHaveLength(1); expect(faces.length).toBeGreaterThan(0);
      for (const builder of builders) expect(() => builder.IsDone()).toThrow();
      for (const wire of wires) expect(() => wire.wrapped).toThrow();
      for (const face of faces) expect(() => face.wrapped).toThrow();
    } finally { fail.mockRestore(); faceDelete.mockRestore(); sketchDelete.mockRestore(); builderDelete.mockRestore(); }
  });
  it('releases the generated Sweep after target fusion fails while retaining the original native body', () => {
    let generated: Shape3D | undefined; let target: Shape3D | undefined;
    const native = cadKernelBuilders.fuse, watch = watchCadKernelBuilders({ kinds: ['fuse'], call: 1, error: new Error('Interrupted Sweep join') });
    const fail = vi.spyOn(cadKernelBuilders, 'fuse').mockImplementation((left, other) => { target = left; generated = other; return native(left, other); });
    try {
      built([...block, sketch(), rail(), sweep({ operation: 'join', targetId: 'block' })], model => {
        expect(model.result.diagnostics[0]).toMatchObject({ code: 'kernel-operation-failed', details: { operation: 'join', input: { field: 'targetId', id: 'block' }, kernelMessage: 'Interrupted Sweep join' } }); expect(model.result.meshes[0].featureId).toBe('block');
        if (!generated || !target) throw new Error('Expected native operands');
        const released = generated; expect(() => released.wrapped).toThrow(); expect(measureVolume(target)).toBeCloseTo(500, 7);
        expect(watch.failed).toHaveLength(1); expect(watch.outstanding()).toBe(0);
      });
    } finally { fail.mockRestore(); watch.restore(); }
  });
  it('releases both staged primitives if an intermediate G1 fusion is interrupted', () => {
    const staged: Shape3D[] = [];
    const native = cadKernelBuilders.fuse, watch = watchCadKernelBuilders({ kinds: ['fuse'], call: 1, error: new Error('Interrupted staged Sweep fuse') });
    const fail = vi.spyOn(cadKernelBuilders, 'fuse').mockImplementation((left, other) => {
      staged.push(left, other); return native(left, other);
    });
    try {
      built([...block, sketch(), rail(mixed), sweep()], model => {
        expect(model.result.diagnostics[0]).toMatchObject({ code: 'kernel-operation-failed', details: { operation: 'sweep', kernelMessage: 'Interrupted staged Sweep fuse' } }); expect(model.result.meshes[0].featureId).toBe('block');
        expect(staged).toHaveLength(2); for (const shape of staged) expect(() => shape.wrapped).toThrow();
        expect(model.result.meshes[0].volume).toBeCloseTo(500, 7);
        expect(watch.failed).toHaveLength(1); expect(watch.outstanding()).toBe(0);
      });
    } finally { fail.mockRestore(); watch.restore(); }
    built([sketch(), rail(mixed), sweep()], model => expect(model.result.diagnostics).toEqual([]));
  });
  it('rejects native tolerance growth instead of expanding the clearance reservation', () => {
    const tolerance = vi.spyOn(getOC().BRep_Tool, 'Tolerance').mockReturnValue(3e-7);
    try {
      built([...block, sketch(), rail(), sweep()], model => {
        expect(model.result.diagnostics[0]).toMatchObject({ featureId: 'sweep', code: 'unsupported-sweep-precision' });
        expect(model.result.meshes[0].featureId).toBe('block'); expect(model.result.meshes[0].volume).toBeCloseTo(500, 7);
      });
    } finally { tolerance.mockRestore(); }
  });
  it('releases the section face builder and wire when native face preparation fails', () => {
    const native = getOC().BRepBuilderAPI_MakeFace; const builders: InstanceType<typeof native>[] = [];
    const originalDelete = native.prototype.delete;
    const released = vi.spyOn(native.prototype, 'delete').mockImplementation(function(this: InstanceType<typeof native>) { builders.push(this); originalDelete.call(this); });
    const failed = vi.spyOn(native.prototype, 'IsDone').mockReturnValue(false);
    const wires: Wire[] = []; const originalSketchDelete = Sketch.prototype.delete;
    const sketchDelete = vi.spyOn(Sketch.prototype, 'delete').mockImplementation(function(this: Sketch) { wires.push(this.wire); originalSketchDelete.call(this); });
    try {
      expect(() => buildCadSweepSolid(inputs())).toThrow('planar closed face');
      expect(builders).toHaveLength(1); expect(wires).toHaveLength(1);
      for (const builder of builders) expect(() => builder.Face()).toThrow();
      for (const wire of wires) expect(() => wire.wrapped).toThrow();
    } finally { failed.mockRestore(); released.mockRestore(); sketchDelete.mockRestore(); }
  });
});
