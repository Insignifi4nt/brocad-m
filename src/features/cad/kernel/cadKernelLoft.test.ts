// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import initOpenCascade from 'replicad-opencascadejs';
import { getOC, measureVolume, setOC, Sketch, type Shape3D, type Wire } from 'replicad';
import type { CadDocument, CadFeature, CadPlane, CadProfile, CadSketchFeature } from '../../../domain/cad/cadDocument';
import { resolveCadLoftSections } from '../../../domain/cad/cadLoft';
import { parseCadDocument } from '../../../domain/cad/cadSchema';
import { prepareCadSolidImport } from './cadKernelImport';
import { buildCadLoftSolid } from './cadKernelLoft';
import { cadKernelBuilders } from './cadKernelBuilders';
import { watchCadKernelBuilders } from './__tests__/cadKernelBuilderWatch';
import { buildCadKernelModel, type CadKernelModel } from './cadKernelModel';

beforeAll(async () => {
  const wasmBinary = await readFile(new URL('../../../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  setOC(await initOpenCascade({ wasmBinary, print: () => undefined, printErr: () => undefined }));
}, 60_000);
const base = (id: string) => ({ id, name: id, suppressed: false });
type Loft = Extract<CadFeature, { kind: 'loft' }>;
const circle = (radius: number | string): CadProfile => ({ kind: 'circle', x: 0, y: 0, radius });
const rectangle = (size: number): CadProfile => ({ kind: 'rectangle', x: -size / 2, y: -size / 2, width: size, height: size, cornerRadius: 0 });
const sketch = (id: string, offset: number | string, geometry: CadProfile = circle(5), plane: CadPlane = 'XY'): CadSketchFeature => ({
  ...base(id), kind: 'sketch', plane, offset, profiles: [{ id: `${id}_contour`, name: id, construction: false, geometry }],
});
const loft = (overrides: Partial<Loft> = {}): Loft => ({ ...base('loft'), kind: 'loft', sketchIds: ['lower', 'upper'], ruled: false, operation: 'new', targetId: null, ...overrides });
const document = (features: readonly CadFeature[], parameters: Readonly<Record<string, number>> = {}): CadDocument => ({
  format: 'wireedm-cad', schemaVersion: 1, id: 'loft_test', name: 'Loft test', units: 'mm', features, parameters,
});
function built(features: readonly CadFeature[], check: (model: CadKernelModel) => void, parameters: Readonly<Record<string, number>> = {}) {
  const model = buildCadKernelModel(document(features, parameters));
  try { check(model); } finally { model.dispose(); model.dispose(); }
}
const block: readonly CadFeature[] = [
  sketch('block_profile', -5, { kind: 'rectangle', x: -10, y: -10, width: 20, height: 20, cornerRadius: 0 }),
  { ...base('block'), kind: 'extrude', sketchId: 'block_profile', distance: 10, symmetric: false, operation: 'new', targetId: null },
];

describe('native closed multi-section lofts', () => {
  it('preserves exact analytic sections in the production two-circle transition and bored result', () => {
    const sections = [sketch('lower', 0, circle(12)), sketch('upper', 'rise', circle(8)), loft()];
    built(sections, model => {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo(6080 * Math.PI / 3, 6);
      const section = model.section({ bodyId: 'loft', plane: 'XY', offset: 10 });
      expect(section.contourCount).toBe(1);
      for (const entity of section.entities) {
        if (entity.type !== 'circle' && entity.type !== 'arc') throw new Error('Expected an exact circular section');
        expect(entity.radius).toBeCloseTo(10, 7);
      }
    }, { rise: 20 });
    built([...sections, sketch('bore_profile', 0, circle(3)), { ...base('bored'), kind: 'extrude', sketchId: 'bore_profile', distance: 20, symmetric: false, operation: 'cut', targetId: 'loft' }], model => {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo(6080 * Math.PI / 3 - 180 * Math.PI, 6);
      const section = model.section({ bodyId: 'bored', plane: 'XY', offset: 10 }); expect(section.contourCount).toBe(2);
      expect(section.entities.every(entity => entity.type === 'circle')).toBe(true);
      expect(section.entities.map(entity => entity.type === 'circle' ? entity.radius : 0).sort((a, b) => a - b)).toEqual([3, 10]);
    }, { rise: 20 });
  });
  it.each(['XY', 'XZ', 'YZ'] satisfies CadPlane[])('builds either mode in %s and respects descending section order', plane => {
    for (const ruled of [false, true]) built([sketch('lower', 20, circle(10), plane), sketch('upper', 0, circle(5), plane), loft({ ruled })], model => {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes).toHaveLength(1);
      expect(model.result.meshes[0].volume).toBeCloseTo(3500 * Math.PI / 3, 6);
      const section = model.section({ bodyId: 'loft', plane, offset: 10 });
      expect(section.contourCount).toBe(1); expect(section.entities.every(entity => entity.type === 'arc' || entity.type === 'circle')).toBe(true);
    });
  });
  it('reevaluates radius and plane expressions on every exact construction without mutating source sketches', () => {
    const features = [sketch('lower', 'start', circle('radius')), sketch('upper', 'end', circle('radius')), loft()];
    for (const parameters of [{ start: 0, end: 20, radius: 5 }, { start: 100, end: 130, radius: 2 }]) {
      built(features, model => { expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo(Math.PI * parameters.radius ** 2 * (parameters.end - parameters.start), 6); }, parameters);
    }
    expect(features[0]).toEqual(sketch('lower', 'start', circle('radius')));
  });
  it.each([false, true])('handles rectangular sections without promising analytic CAM curves, ruled=%s', ruled => {
    built([sketch('lower', 0, rectangle(10)), sketch('upper', 20, rectangle(20)), loft({ ruled })], model => {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo(14_000 / 3, 6);
      expect(() => model.section({ bodyId: 'loft', plane: 'XY', offset: 10 })).toThrow('bspline');
    });
  });
  it.each([false, true])('automatically aligns different boundary edge counts without altering their input geometry, ruled=%s', ruled => {
    const features = [sketch('lower', 0), sketch('upper', 20, rectangle(20)), loft({ ruled })]; const original = JSON.stringify(features);
    built(features, model => { expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo(4390.687197274108, 5); });
    expect(JSON.stringify(features)).toBe(original);
  });
  it('aligns opposite polygon winding and reuses exact imported line/arc paths', () => {
    const polygon: CadProfile = { kind: 'polygon', points: [[-5, -5], [-5, 5], [5, 5], [5, -5]] };
    built([sketch('lower', 0, polygon), sketch('upper', 20, rectangle(10)), loft()], model => {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo(2000, 6);
    });
    const path: CadProfile = { kind: 'path', segments: [
      { kind: 'line', start: [-5, -2], end: [5, -2] },
      { kind: 'arc', center: [5, 0], radius: 2, startAngle: -90, sweep: 180 },
      { kind: 'line', start: [5, 2], end: [-5, 2] },
      { kind: 'arc', center: [-5, 0], radius: 2, startAngle: 90, sweep: 180 },
    ] };
    built([sketch('lower', 0, path), sketch('upper', 20, path), loft()], model => {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo((40 + 4 * Math.PI) * 20, 6);
      expect(model.section({ bodyId: 'loft', plane: 'XY', offset: 10 }).entities.map(entity => entity.type).sort()).toEqual(['arc', 'arc', 'line', 'line']);
    });
  });
  it('uses every intermediate section and distinguishes smooth fitted surfaces from ruled intervals', () => {
    const sections = [sketch('lower', 0, circle(10)), sketch('middle', 10), sketch('upper', 20, circle(10))];
    for (const [ruled, expected] of [[true, 3500 * Math.PI / 3], [false, 2800 * Math.PI / 3]] as const) built([...sections, loft({ sketchIds: ['lower', 'middle', 'upper'], ruled })], model => {
      // Native fitted-surface volume integration has a few mm³ millionths of error.
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo(expected, ruled ? 6 : 5);
      if (ruled) expect(model.section({ bodyId: 'loft', plane: 'XY', offset: 10 }).contourCount).toBe(1);
      else expect(() => model.section({ bodyId: 'loft', plane: 'XY', offset: 10 })).toThrow('bspline');
    });
  });
  it('builds all sixteen sections and releases them before another construction', () => {
    const sections = Array.from({ length: 16 }, (_, index) => sketch(`section_${index}`, index * 2, circle(5 + Math.sin(index * .4))));
    for (const ruled of [true, false]) built([...sections, loft({ sketchIds: sections.map(section => section.id), ruled })], model => {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes).toHaveLength(1);
      expect(model.result.meshes[0].volume).toBeGreaterThan(2400); expect(model.result.meshes[0].volume).toBeLessThan(2420);
    });
    built([sketch('lower', 0), sketch('upper', 20), loft()], model => expect(model.result.meshes[0].volume).toBeCloseTo(500 * Math.PI, 6));
  });
  it.each(['join', 'cut'] as const)('reuses the exact %s commit path and preserves the source sections', async operation => {
    const features = [...block, sketch('lower', 0), sketch('upper', 20), loft({ operation, targetId: 'block' })];
    const model = buildCadKernelModel(parseCadDocument(document(features)));
    try {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes).toHaveLength(1); expect(model.result.meshes[0].featureId).toBe('loft');
      const expected = operation === 'join' ? 4000 + 375 * Math.PI : 4000 - 125 * Math.PI;
      expect(model.result.meshes[0].volume).toBeCloseTo(expected, 6);
      const step = await model.export('step').text();
      const imported = prepareCadSolidImport({ format: 'step', encoding: 'utf8', fileName: 'loft.step', data: step });
      expect(imported.solidCount).toBe(1); expect(imported.volume).toBeCloseTo(expected, 6);
      expect(() => model.section({ bodyId: 'block', plane: 'XY', offset: 0 })).toThrow('unavailable');
    } finally { model.dispose(); }
    built([...features, { ...base('reused'), kind: 'extrude', sketchId: 'lower', distance: 1, symmetric: false, operation: 'new', targetId: null }], next => {
      expect(next.result.diagnostics).toEqual([]); expect(next.result.meshes).toHaveLength(2);
    });
  });
  it('rejects holes, separate regions, suppressed sections, mixed planes and unsafe plane ordering without losing a prior body', () => {
    const lower = sketch('lower', 0);
    const invalid: readonly (readonly CadFeature[])[] = [
      [{ ...lower, profiles: [...lower.profiles, { id: 'hole', name: 'Hole', construction: false, geometry: circle(2) }] }, sketch('upper', 20), loft()],
      [{ ...lower, profiles: [...lower.profiles, { id: 'island', name: 'Island', construction: false, geometry: { kind: 'circle', x: 20, y: 0, radius: 1 } }] }, sketch('upper', 20), loft()],
      [{ ...lower, suppressed: true }, sketch('upper', 20), loft()],
      [lower, sketch('upper', 20, circle(5), 'YZ'), loft()],
      [lower, sketch('upper', 0), loft()], [lower, sketch('upper', 1e-8), loft()],
      [lower, sketch('middle', 20), sketch('upper', 10), loft({ sketchIds: ['lower', 'middle', 'upper'] })],
      [lower, sketch('upper', 20), loft({ sketchIds: ['lower', 'lower'] })],
    ];
    for (const tail of invalid) built([...block, ...tail], model => {
      expect(model.result.diagnostics[0].featureId).toBe('loft'); expect(model.result.meshes).toHaveLength(1); expect(model.result.meshes[0].featureId).toBe('block');
      expect(model.result.meshes[0].volume).toBeCloseTo(4000, 6); expect(() => model.export('step')).toThrow('Fix the feature diagnostics');
    });
  });
  it('excludes construction contours explicitly and rejects an empty material section', () => {
    const lower = sketch('lower', 0); const construction = { id: 'reference', name: 'Reference', construction: true, geometry: { kind: 'circle', x: 30, y: 0, radius: 2 } satisfies CadProfile };
    built([{ ...lower, profiles: [...lower.profiles, construction] }, sketch('upper', 20), loft()], model => { expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo(500 * Math.PI, 6); });
    built([{ ...lower, profiles: [construction] }, sketch('upper', 20), loft()], model => { expect(model.result.diagnostics[0].featureId).toBe('loft'); expect(model.result.meshes).toHaveLength(0); });
  });
  it.each(['XY', 'XZ', 'YZ'] satisfies CadPlane[])('rejects native-valid smooth end-plane overshoot in %s while the ordered ruled sections succeed', plane => {
    const sections = [sketch('lower', 0, circle(10), plane), sketch('middle', 1, circle(1), plane), sketch('upper', 20, circle(10), plane)];
    built([...block, ...sections, loft({ sketchIds: ['lower', 'middle', 'upper'], operation: 'join', targetId: 'block' })], model => {
      expect(model.result.diagnostics[0]).toMatchObject({ featureId: 'loft', code: 'loft-overshoot' }); expect(model.result.meshes[0].featureId).toBe('block');
      expect(model.result.meshes[0].volume).toBeCloseTo(4000, 6);
    });
    built([...sections, loft({ sketchIds: ['lower', 'middle', 'upper'], ruled: true })], model => { expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo(740 * Math.PI, 6); });
  });
  it('accepts precision-scale native bounds padding at a large plane offset', () => {
    built([sketch('lower', 1e8), sketch('upper', 1e8 + 20), loft()], model => { expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo(500 * Math.PI, 5); });
  });
  it.each(['AddWire', 'Build'] as const)('releases every allocated source wire and native builder after %s throws', phase => {
    const wires: Wire[] = []; const originalDelete = Sketch.prototype.delete;
    const sketchDelete = vi.spyOn(Sketch.prototype, 'delete').mockImplementation(function(this: Sketch) { wires.push(this.wire); originalDelete.call(this); });
    const native = getOC().BRepOffsetAPI_ThruSections; const builders: InstanceType<typeof native>[] = []; const originalBuilderDelete = native.prototype.delete;
    const builderDelete = vi.spyOn(native.prototype, 'delete').mockImplementation(function(this: InstanceType<typeof native>) { builders.push(this); originalBuilderDelete.call(this); });
    const fail = vi.spyOn(native.prototype, phase).mockImplementation(() => { throw new Error(`Interrupted loft ${phase}`); });
    try {
      const sections = [sketch('lower', 0), sketch('upper', 20)]; const resolved = resolveCadLoftSections(loft(), new Map(sections.map(section => [section.id, section])), {});
      expect(() => buildCadLoftSolid(resolved, false)).toThrow(`Interrupted loft ${phase}`);
      expect(wires).toHaveLength(phase === 'AddWire' ? 1 : 2); expect(builders).toHaveLength(1);
      for (const wire of wires) expect(() => wire.wrapped).toThrow();
      for (const builder of builders) expect(() => builder.IsDone()).toThrow();
    } finally { fail.mockRestore(); builderDelete.mockRestore(); sketchDelete.mockRestore(); }
  });
  it('releases a completed loft if its target Boolean fails and keeps the original native target usable', () => {
    let generated: Shape3D | undefined; let target: Shape3D | undefined;
    const native = cadKernelBuilders.fuse, watch = watchCadKernelBuilders({ kinds: ['fuse'], call: 1, error: new Error('Interrupted loft join') });
    const fail = vi.spyOn(cadKernelBuilders, 'fuse').mockImplementation((left, other) => { target = left; generated = other; return native(left, other); });
    try {
      built([...block, sketch('lower', 0), sketch('upper', 20), loft({ operation: 'join', targetId: 'block' })], model => {
        expect(model.result.diagnostics[0]).toMatchObject({ code: 'kernel-operation-failed', details: { operation: 'join', input: { field: 'targetId', id: 'block' }, kernelMessage: 'Interrupted loft join' } }); expect(model.result.meshes[0].featureId).toBe('block');
        if (!generated || !target) throw new Error('Expected native operands');
        const releasedLoft = generated;
        expect(() => releasedLoft.wrapped).toThrow(); expect(measureVolume(target)).toBeCloseTo(4000, 6);
        expect(watch.failed).toHaveLength(1); expect(watch.outstanding()).toBe(0);
      });
    } finally { fail.mockRestore(); watch.restore(); }
  });
});
