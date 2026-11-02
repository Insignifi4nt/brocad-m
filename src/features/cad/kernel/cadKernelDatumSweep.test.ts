// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import initOpenCascade from 'replicad-opencascadejs';
import { getOC, measureVolume, setOC, Sketch, type Shape3D, type Wire } from 'replicad';
import type { CadCurveFeature, CadDatumPlaneFeature, CadDocument, CadFeature, CadPlane, CadProfile, CadSketchFeature, CadSweepFeature } from '../../../domain/cad/cadDocument';
import { parseCadDocument } from '../../../domain/cad/cadSchema';
import { loadCadSolidImport } from './cadKernelImport';
import { buildCadKernelModel } from './cadKernelModel';
import { sectionCadKernelShape } from './cadKernelSection';

beforeAll(async () => {
  const wasmBinary = await readFile(new URL('../../../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  setOC(await initOpenCascade({ wasmBinary, print: () => undefined, printErr: () => undefined }));
}, 60_000);
const base = (id: string) => ({ id, name: id, suppressed: false });
const rotation = [23, -37, 61] as const;
const origin = [37, -24, 11] as const;
const datum = (id: string, plane: CadPlane, roll = 0): CadDatumPlaneFeature => ({ ...base(id), kind: 'datum-plane',
  definition: { kind: 'world', basePlane: plane, origin, rotation: [rotation[0] + roll, rotation[1], rotation[2]] } });
const on = (id: string) => ({ kind: 'datum-plane' as const, featureId: id });
const circle: CadProfile = { kind: 'circle', x: 0, y: 0, radius: 1 };
const sketch = (plane: CadSketchFeature['plane'], geometry: CadProfile = circle): CadSketchFeature => ({ ...base('section'), kind: 'sketch', plane, offset: 0,
  profiles: [{ id: 'boundary', name: 'Boundary', construction: false, geometry }] });
const rail = (plane: CadCurveFeature['plane'], segments: CadCurveFeature['segments']): CadCurveFeature => ({ ...base('rail'), kind: 'curve', plane, offset: 0, segments });
const sweep = (overrides: Partial<CadSweepFeature> = {}): CadSweepFeature => ({ ...base('sweep'), kind: 'sweep', sketchId: 'section', curveId: 'rail', operation: 'new', targetId: null, ...overrides });
const document = (features: readonly CadFeature[], parameters: Readonly<Record<string, number>> = {}): CadDocument => ({ format: 'wireedm-cad', schemaVersion: 1, id: 'datum_sweep', name: 'Datum Sweep', units: 'mm', parameters, features });
const quarter: CadCurveFeature['segments'][number] = { kind: 'arc', center: [0, 10], radius: 10, startAngle: -90, sweep: 90 };
const mixed: CadCurveFeature['segments'] = [{ kind: 'line', start: [0, 0], end: [10, 0] },
  { kind: 'arc', center: [10, 10], radius: 10, startAngle: -90, sweep: 90 }, { kind: 'line', start: [20, 10], end: [20, 20] }];
const stock: readonly CadFeature[] = [{ ...sketch('XY', { kind: 'rectangle', x: -10, y: -10, width: 20, height: 20, cornerRadius: 0 }), id: 'stock_profile' },
  { ...base('stock'), kind: 'extrude', sketchId: 'stock_profile', distance: 20, symmetric: false, operation: 'new', targetId: null }];

async function compare(directFeatures: readonly CadFeature[], principalFeatures: readonly CadFeature[], angles: readonly [number, number, number] = rotation,
  translation: readonly [number, number, number] = origin, sectionPlane: CadPlane = 'XY', sectionOffset = 0) {
  const direct = buildCadKernelModel(parseCadDocument(document(directFeatures)));
  const baseline = buildCadKernelModel(parseCadDocument(document([...principalFeatures,
    { ...base('placed'), kind: 'transform', sourceId: 'sweep', rotation: angles, translation }])));
  let a: Shape3D | undefined; let b: Shape3D | undefined; let common: Shape3D | undefined;
  try {
    expect(direct.result.diagnostics).toEqual([]); expect(baseline.result.diagnostics).toEqual([]);
    expect(direct.result.meshes).toHaveLength(1);
    expect(direct.result.meshes[0].volume).toBeCloseTo(baseline.result.meshes[0].volume, 6);
    for (const side of ['min', 'max'] as const) for (let axis = 0; axis < 3; axis++)
      expect(direct.result.meshes[0].bounds[side][axis]).toBeCloseTo(baseline.result.meshes[0].bounds[side][axis], 6);
    a = loadCadSolidImport({ format: 'step', encoding: 'utf8', fileName: 'datum-sweep.step', data: await direct.export('step').text() }).shape;
    b = loadCadSolidImport({ format: 'step', encoding: 'utf8', fileName: 'principal-sweep.step', data: await baseline.export('step').text() }).shape;
    common = a.intersect(b); expect(measureVolume(common)).toBeCloseTo(measureVolume(a), 5);
    let local = a.clone().translate(-translation[0], -translation[1], -translation[2]);
    for (const axis of [2, 1, 0]) if (angles[axis]) local = local.rotate(-angles[axis], [0, 0, 0], axis === 0 ? [1, 0, 0] : axis === 1 ? [0, 1, 0] : [0, 0, 1]);
    try {
      const section = sectionCadKernelShape(local, { bodyId: 'local', plane: sectionPlane, offset: sectionOffset });
      expect(section.contourCount).toBe(1); expect(section.entities.every(entity => ['line', 'arc', 'circle'].includes(entity.type))).toBe(true);
    } finally { local.delete(); }
  } finally { common?.delete(); a?.delete(); b?.delete(); direct.dispose(); baseline.dispose(); }
}
function inputs(plane: CadPlane, segments: CadCurveFeature['segments'], geometry: CadProfile = circle, roll = 0) {
  const sectionPlane = plane === 'YZ' ? 'XZ' : 'YZ';
  return { direct: [datum('rail_plane', plane), datum('section_plane', sectionPlane, roll), sketch(on('section_plane'), geometry), rail(on('rail_plane'), segments), sweep()],
    principal: [sketch(sectionPlane, geometry), rail(plane, segments), sweep()] };
}

describe('exact datum Sweep transport', () => {
  it.each(['XY', 'XZ', 'YZ'] satisfies CadPlane[])('preserves %s basis and antiparallel normals with G1 cap reuse and STEP', async plane => {
    const features = inputs(plane, mixed);
    await compare(features.direct, features.principal, rotation, origin, plane);
  });
  it.each([-90, 270])('preserves signed %s-degree circular support through a tilted frame', async angle => {
    const arc = { ...quarter, center: [0, angle < 0 ? -10 : 10] satisfies [number, number], startAngle: angle < 0 ? 90 : -90, sweep: angle };
    const features = inputs('XY', [arc]); await compare(features.direct, features.principal);
  });
  it('retains arbitrary authored section roll and off-centre material rather than using centreline volume', async () => {
    const geometry: CadProfile = { kind: 'rectangle', x: 1, y: -.5, width: 2, height: 1, cornerRadius: 0 };
    const features = inputs('XY', mixed, geometry, 17); const angle = 17 * Math.PI / 180;
    const rotated: CadProfile = { kind: 'polygon', points: [[1, -.5], [3, -.5], [3, .5], [1, .5]].map(([x, y]) =>
      [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle)]) };
    await compare(features.direct, [sketch('YZ', rotated), rail('XY', mixed), sweep()]);
  });
  it('supports a principal rail with non-cardinal start tangent and a matching datum section', async () => {
    const angle = 37 * Math.PI / 180;
    const plane: CadDatumPlaneFeature = { ...datum('section_plane', 'YZ'), definition: { kind: 'world', basePlane: 'YZ', origin: [0, 0, 0], rotation: [0, 0, 37] } };
    const tiltedQuarter = { ...quarter, center: [-10 * Math.sin(angle), 10 * Math.cos(angle)] satisfies [number, number], startAngle: -53 };
    await compare([plane, sketch(on('section_plane')), rail('XY', [tiltedQuarter]), sweep()],
      [sketch('YZ'), rail('XY', [quarter]), sweep()], [0, 0, 37], [0, 0, 0]);
  });
  it('supports a datum rail with an independently placed principal section', async () => {
    const plane: CadDatumPlaneFeature = { ...datum('rail_plane', 'XY'), definition: { kind: 'world', basePlane: 'XY', origin: [0, 5, 7], rotation: [45, 0, 0] } };
    await compare([plane, sketch('YZ', { kind: 'circle', x: 5, y: 7, radius: 1 }), rail(on('rail_plane'), mixed), sweep()],
      [sketch('YZ'), rail('XY', mixed), sweep()], [45, 0, 0], [0, 5, 7]);
  });
  it.each([-7, 7])('preserves signed rail offset %s and independent section station', async offset => {
    const segments = mixed.map(segment => segment.kind === 'line'
      ? { ...segment, start: [Number(segment.start[0]) + 3, Number(segment.start[1]) + 4] satisfies [number, number], end: [Number(segment.end[0]) + 3, Number(segment.end[1]) + 4] satisfies [number, number] }
      : { ...segment, center: [Number(segment.center[0]) + 3, Number(segment.center[1]) + 4] satisfies [number, number] });
    const geometry: CadProfile = { kind: 'circle', x: 4, y: offset, radius: 1 };
    await compare([datum('rail_plane', 'XY'), datum('section_plane', 'YZ'), { ...sketch(on('section_plane'), geometry), offset: 3 },
      { ...rail(on('rail_plane'), segments), offset }, sweep()],
    [{ ...sketch('YZ', geometry), offset: 3 }, { ...rail('XY', segments), offset }, sweep()], rotation, origin, 'XY', offset);
  });
  it.each(['join', 'cut'] as const)('reuses ordinary %s while keeping both reference frames available', operation => {
    const railPlane: CadDatumPlaneFeature = { ...datum('rail_plane', 'XY'), definition: { kind: 'world', basePlane: 'XY', origin: [-15, 0, 10], rotation: [0, 0, 0] } };
    const sectionPlane: CadDatumPlaneFeature = { ...railPlane, id: 'section_plane', definition: { ...railPlane.definition, basePlane: 'YZ' } };
    const features = [...stock, railPlane, sectionPlane, sketch(on('section_plane'), { kind: 'circle', x: 0, y: 0, radius: 2 }),
      rail(on('rail_plane'), [{ kind: 'line', start: [0, 0], end: [30, 0] }]), sweep({ operation, targetId: 'stock' }), sweep({ id: 'reference_reused' })];
    const model = buildCadKernelModel(parseCadDocument(document(features)));
    try {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes.map(mesh => mesh.featureId)).toEqual(['sweep', 'reference_reused']);
      expect(model.result.meshes[0].volume).toBeCloseTo(operation === 'join' ? 8000 + 40 * Math.PI : 8000 - 80 * Math.PI, 6);
      expect(model.result.meshes[1].volume).toBeCloseTo(120 * Math.PI, 6);
    } finally { model.dispose(); }
  });
  it('releases staged pieces, transported caps and builders after LastShape failure, preserving the target', () => {
    const native = getOC().BRepPrimAPI_MakeRevol; const released: object[] = []; const wires: Wire[] = [];
    const originalDelete = native.prototype.delete; const originalSketchDelete = Sketch.prototype.delete;
    const builderDelete = vi.spyOn(native.prototype, 'delete').mockImplementation(function(this: InstanceType<typeof native>) { released.push(this); originalDelete.call(this); });
    const sketchDelete = vi.spyOn(Sketch.prototype, 'delete').mockImplementation(function(this: Sketch) { wires.push(this.wire); originalSketchDelete.call(this); });
    let failed: object | undefined;
    const fail = vi.spyOn(native.prototype, 'LastShape').mockImplementation(function(this: InstanceType<typeof native>) { failed = this; throw new Error('Forced datum terminal cap failure'); });
    try {
      const features = inputs('XY', mixed); const model = buildCadKernelModel(document([...stock, ...features.direct.slice(0, -1), sweep({ operation: 'cut', targetId: 'stock' })]));
      try {
        expect(model.result.diagnostics[0]).toMatchObject({ featureId: 'sweep', code: 'kernel-operation-failed', details: { operation: 'sweep', kernelMessage: 'Forced datum terminal cap failure' } });
        expect(model.result.meshes.map(mesh => mesh.featureId)).toEqual(['stock']); expect(model.result.meshes[0].volume).toBeCloseTo(8000, 6);
        expect(released).toContain(failed); expect(wires.length).toBeGreaterThanOrEqual(2);
        for (const wire of wires) expect(() => wire.wrapped).toThrow();
        expect(() => model.export('step')).toThrow('Fix the feature diagnostics');
      } finally { model.dispose(); }
    } finally { fail.mockRestore(); sketchDelete.mockRestore(); builderDelete.mockRestore(); }
  });
  it('reevaluates frame expressions and rejects misaligned placement without changing source', () => {
    const features = inputs('XY', mixed); const railPlane = features.direct[0];
    if (railPlane.kind !== 'datum-plane') throw new Error('Expected rail datum');
    const authored: readonly CadFeature[] = [{ ...railPlane, definition: { ...railPlane.definition, rotation: [23, 'tilt', 61] } }, ...features.direct.slice(1)];
    const original = JSON.stringify(authored);
    for (const tilt of [-37, -36, 1e9]) {
      const model = buildCadKernelModel(document([...stock, ...authored], { tilt }));
      try {
        if (tilt === -37) expect(model.result.diagnostics).toEqual([]);
        else { expect(model.result.diagnostics[0].featureId).toBe('sweep'); expect(model.result.meshes.map(mesh => mesh.featureId)).toEqual(['stock']); }
      } finally { model.dispose(); }
    }
    expect(JSON.stringify(authored)).toBe(original);
  });
  it('rejects uncertain world placement before native transport and retains the preceding stock', () => {
    const features = inputs('XY', mixed).direct.map(feature => feature.kind === 'datum-plane'
      ? { ...feature, definition: { ...feature.definition, origin: [1e8, 0, 0] satisfies [number, number, number] } } : feature);
    const model = buildCadKernelModel(document([...stock, ...features]));
    try {
      expect(model.result.diagnostics[0]).toMatchObject({ featureId: 'sweep', code: 'unsupported-sweep-precision' });
      expect(model.result.meshes.map(mesh => mesh.featureId)).toEqual(['stock']); expect(model.result.meshes[0].volume).toBeCloseTo(8000, 6);
    } finally { model.dispose(); }
  });
});
