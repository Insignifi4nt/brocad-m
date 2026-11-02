// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import initOpenCascade from 'replicad-opencascadejs';
import { measureVolume, setOC, type Shape3D } from 'replicad';
import type { CadDocument, CadFeature } from '../../../domain/cad/cadDocument';
import { parseCadDocument } from '../../../domain/cad/cadSchema';
import { cadKernelBuilders } from './cadKernelBuilders';
import { watchCadKernelBuilders } from './__tests__/cadKernelBuilderWatch';
import { buildCadKernelModel, type CadKernelModel } from './cadKernelModel';

beforeAll(async () => {
  const wasmBinary = await readFile(new URL('../../../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  setOC(await initOpenCascade({ wasmBinary, print: () => undefined, printErr: () => undefined }));
}, 60_000);
const base = (id: string) => ({ id, name: id, suppressed: false });
const seed: readonly CadFeature[] = [
  { ...base('profile'), kind: 'sketch', plane: 'XY', offset: 0, profiles: [{ id: 'circle', name: 'Circle', construction: false,
    geometry: { kind: 'circle', x: 10, y: 0, radius: 1 } }] },
  { ...base('seed'), kind: 'extrude', sketchId: 'profile', distance: 2, symmetric: false, operation: 'new', targetId: null },
];
type Circular = Extract<CadFeature, { kind: 'circular-pattern' }>;
const circular = (overrides: Partial<Circular> = {}): Circular => ({ ...base('pattern'), kind: 'circular-pattern', sourceId: 'seed', count: 4,
  axis: 'z', center: [0, 0, 0], angle: 360, ...overrides });
const document = (features: readonly CadFeature[], parameters: Readonly<Record<string, number>> = {}): CadDocument => ({
  format: 'wireedm-cad', schemaVersion: 1, id: 'pattern_test', name: 'Pattern test', units: 'mm', parameters, features,
});
function built(features: readonly CadFeature[], check: (model: CadKernelModel) => void, parameters: Readonly<Record<string, number>> = {}) {
  const model = buildCadKernelModel(document(features, parameters));
  try { check(model); } finally { model.dispose(); model.dispose(); }
}
function closeVector(actual: readonly number[], expected: readonly number[]) { expected.forEach((value, index) => expect(actual[index]).toBeCloseTo(value, 6)); }

describe('exact native circular solid patterns', () => {
  it.each([360, -360])('creates four distinct full-turn placements without duplicating the closing seed, extent=%s', extent => {
    built([...seed, circular({ angle: extent })], model => {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes).toHaveLength(1);
      const mesh = model.result.meshes[0]; expect(mesh.featureId).toBe('pattern'); expect(mesh.volume).toBeCloseTo(8 * Math.PI, 6);
      closeVector(mesh.bounds.min, [-11, -11, 0]); closeVector(mesh.bounds.max, [11, 11, 2]);
      const section = model.section({ bodyId: 'pattern', plane: 'XY', offset: 1 });
      expect(section.contourCount).toBe(4); expect(section.entities.every(entity => entity.type === 'circle')).toBe(true);
      expect(() => model.section({ bodyId: 'seed', plane: 'XY', offset: 1 })).toThrow('unavailable');
    });
  });
  it.each([180, -180])('includes both endpoints and uses the signed total partial extent, extent=%s', extent => {
    built([...seed, circular({ count: 3, angle: extent })], model => {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo(6 * Math.PI, 6);
      const section = model.section({ bodyId: 'pattern', plane: 'XY', offset: 1 }); expect(section.contourCount).toBe(3);
      const centers = section.entities.flatMap(entity => entity.type === 'circle' ? [entity.center] : []);
      for (const [x, y] of [[10, 0], [0, Math.sign(extent) * 10], [-10, 0]]) {
        expect(centers.some(center => Math.hypot(center.x - x, center.y - y) < 1e-7)).toBe(true);
      }
    });
  });
  it.each([
    { axis: 'z' as const, rotation: [0, 0, 0] as const, min: [89, 189, 300], max: [111, 211, 302] },
    { axis: 'x' as const, rotation: [0, 90, 0] as const, min: [100, 189, 289], max: [102, 211, 311] },
    { axis: 'y' as const, rotation: [90, 0, 0] as const, min: [89, 198, 289], max: [111, 200, 311] },
  ])('rotates independently about the $axis world axis through a nonzero center', ({ axis, rotation, min, max }) => {
    built([...seed, { ...base('placed'), kind: 'transform', sourceId: 'seed', translation: [100, 200, 300], rotation },
      circular({ sourceId: 'placed', axis, center: [100, 200, 300] })], model => {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo(8 * Math.PI, 6);
      closeVector(model.result.meshes[0].bounds.min, min); closeVector(model.result.meshes[0].bounds.max, max);
    });
  });
  it('rebuilds center and extent expressions and distinguishes near-full from exact full turns', () => {
    const features = [...seed, circular({ count: 3, center: ['centerX', 0, 0], angle: 'extent' })];
    built(features, model => { expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo(6 * Math.PI, 6); }, { centerX: 0, extent: 360 });
    built(features, model => {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeGreaterThan(4 * Math.PI);
      expect(model.result.meshes[0].volume).toBeLessThan(4.01 * Math.PI);
    }, { centerX: 0, extent: 359.9999 });
    built(features, model => { expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo(2 * Math.PI, 6); }, { centerX: 10, extent: 360 });
  });
  it('unites overlapping copies instead of summing or emitting overlapping solids', () => {
    const overlapping = document([
      { ...base('profile'), kind: 'sketch', plane: 'XY', offset: 0, profiles: [{ id: 'rectangle', name: 'Rectangle', construction: false,
        geometry: { kind: 'rectangle', x: 0, y: 0, width: 2, height: 2, cornerRadius: 0 } }] }, seed[1], circular({ count: 2, angle: 90, center: [.5, .5, 0] }),
    ]);
    const model = buildCadKernelModel(parseCadDocument(overlapping));
    try { expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo(12, 6); }
    finally { model.dispose(); }
  });
  it('retains the preceding seed and refuses partial exports for invalid count, extent or center', () => {
    for (const feature of [circular({ count: 1 }), circular({ count: 101 }), circular({ count: 2.5 }),
      ...[0, 1e-7, -1e-7, 360.000001, -360.000001, NaN].map(angle => circular({ angle })), circular({ center: [1e9 + 1, 0, 0] })]) {
      built([...seed, feature], model => {
        expect(model.result.diagnostics[0].featureId).toBe('pattern'); expect(model.result.meshes[0].featureId).toBe('seed');
        expect(model.result.meshes[0].volume).toBeCloseTo(2 * Math.PI, 6); expect(() => model.export('step')).toThrow('Fix the feature diagnostics');
      });
    }
  });
  it('bounds combined linear/circular expansion before generating another set of native instances', () => {
    built([...seed, { ...base('linear'), kind: 'linear-pattern', sourceId: 'seed', count: 11, spacing: [0, 0, 5] }, circular({ sourceId: 'linear', count: 100 })], model => {
      expect(model.result.diagnostics[0]).toMatchObject({ featureId: 'pattern', code: 'instance-limit' });
      expect(model.result.meshes[0].featureId).toBe('linear'); expect(model.result.meshes[0].volume).toBeCloseTo(22 * Math.PI, 6);
    });
  });
  it('constructs and releases a maximum-count disjoint pattern and exports every exact solid', async () => {
    const original = seed[0]; if (original.kind !== 'sketch') throw new Error('Expected seed sketch');
    const narrowSeed: readonly CadFeature[] = [{ ...original, profiles: [{ id: 'circle', name: 'Circle', construction: false,
      geometry: { kind: 'circle', x: 10, y: 0, radius: .05 } }] }, seed[1]];
    const model = buildCadKernelModel(parseCadDocument(document([...narrowSeed, circular({ count: 100 })])));
    try {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo(100 * Math.PI * .05 ** 2 * 2, 6);
      expect(model.section({ bodyId: 'pattern', plane: 'XY', offset: 1 }).contourCount).toBe(100);
      expect((await model.export('step').text()).match(/MANIFOLD_SOLID_BREP/g)).toHaveLength(100);
    } finally { model.dispose(); }
    built([...seed, circular()], next => { expect(next.result.diagnostics).toEqual([]); expect(next.result.meshes[0].volume).toBeCloseTo(8 * Math.PI, 6); });
  }, 30_000);
  it('releases native copies and intermediate unions if a later union fails while retaining the original seed', () => {
    const original = cadKernelBuilders.fuse; const produced: Shape3D[] = []; const copies: Shape3D[] = [];
    let originalSeed: Shape3D | undefined;
    // The third union's native builder fails inside its adapter.
    const watch = watchCadKernelBuilders({ kinds: ['fuse'], call: 3, error: new Error('Interrupted native union') });
    const fuse = vi.spyOn(cadKernelBuilders, 'fuse').mockImplementation((left, other) => {
      copies.push(other);
      originalSeed ??= left;
      const result = original(left, other); produced.push(result); return result;
    });
    try {
      built([...seed, circular()], model => {
        expect(model.result.diagnostics[0]).toMatchObject({ featureId: 'pattern', code: 'kernel-operation-failed', details: { operation: 'pattern', input: { field: 'sourceId', id: 'seed' }, kernelMessage: 'Interrupted native union' } });
        expect(model.result.meshes[0].featureId).toBe('seed');
        expect(model.result.meshes[0].volume).toBeCloseTo(2 * Math.PI, 6);
        if (!originalSeed) throw new Error('Expected retained native seed');
        expect(originalSeed.wrapped.IsNull()).toBe(false); expect(measureVolume(originalSeed)).toBeCloseTo(2 * Math.PI, 6);
        for (const shape of [...produced, ...copies]) expect(() => shape.wrapped).toThrow();
        expect(() => model.export('step')).toThrow('Fix the feature diagnostics');
        expect(watch.failed).toHaveLength(1); expect(watch.builders.filter(item => item.kind === 'fuse')).toHaveLength(3); expect(watch.outstanding()).toBe(0);
      });
    } finally { fuse.mockRestore(); watch.restore(); }
    built([...seed, circular()], model => { expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo(8 * Math.PI, 6); });
  });
});
