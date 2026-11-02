// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import initOpenCascade from 'replicad-opencascadejs';
import { getOC, measureVolume, setOC, type Shape3D } from 'replicad';
import type { CadDatumPlaneFeature, CadDocument, CadFeature, CadPlane, CadProfile, CadSketchFeature } from '../../../domain/cad/cadDocument';
import { cadFramePointToWorld, resolveCadWorldDatum } from '../../../domain/cad/cadDatumPlanes';
import { resolveCadLoftSections } from '../../../domain/cad/cadLoft';
import { parseCadDocument } from '../../../domain/cad/cadSchema';
import { buildCadLoftSolid } from './cadKernelLoft';
import { buildCadKernelModel } from './cadKernelModel';
import { loadCadSolidImport } from './cadKernelImport';

beforeAll(async () => {
  const wasmBinary = await readFile(new URL('../../../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  setOC(await initOpenCascade({ wasmBinary, print: () => undefined, printErr: () => undefined }));
}, 60_000);
const base = (id: string) => ({ id, name: id, suppressed: false });
const rotation = [23, -37, 61] as const;
const origin = [37, -24, 11] as const;
const circle = (radius: number): CadProfile => ({ kind: 'circle', x: 0, y: 0, radius });
const rectangle = (width: number, height: number, x = 0, y = 0): CadProfile => ({ kind: 'rectangle', x: x - width / 2, y: y - height / 2, width, height, cornerRadius: 0 });
const datum = (plane: CadPlane = 'XY'): CadDatumPlaneFeature => ({ ...base('datum'), kind: 'datum-plane', definition: { kind: 'world', basePlane: plane, rotation, origin } });
const onDatum = { kind: 'datum-plane', featureId: 'datum' } as const;
const sketch = (id: string, offset: number, geometry: CadProfile, plane: CadSketchFeature['plane'] = onDatum): CadSketchFeature =>
  ({ ...base(id), kind: 'sketch', plane, offset, profiles: [{ id: `${id}_boundary`, name: id, construction: false, geometry }] });
type Loft = Extract<CadFeature, { kind: 'loft' }>;
const loft = (sketchIds: readonly string[], overrides: Partial<Loft> = {}): Loft =>
  ({ ...base('loft'), kind: 'loft', sketchIds, ruled: false, operation: 'new', targetId: null, ...overrides });
const document = (features: readonly CadFeature[]): CadDocument => ({ format: 'wireedm-cad', schemaVersion: 1, id: 'datum_loft', name: 'Datum loft', units: 'mm', parameters: {}, features });
const stock: readonly CadFeature[] = [sketch('stock_profile', 0, rectangle(20, 20), 'XY'),
  { ...base('stock'), kind: 'extrude', sketchId: 'stock_profile', distance: 20, symmetric: false, operation: 'new', targetId: null }];

async function compare(directFeatures: readonly CadFeature[], baselineFeatures: readonly CadFeature[]) {
  const direct = buildCadKernelModel(parseCadDocument(document(directFeatures)));
  const baseline = buildCadKernelModel(parseCadDocument(document(baselineFeatures)));
  let a: Shape3D | undefined; let b: Shape3D | undefined; let common: Shape3D | undefined;
  try {
    expect(direct.result.diagnostics).toEqual([]); expect(baseline.result.diagnostics).toEqual([]);
    expect(direct.result.meshes).toHaveLength(1);
    const actual = direct.result.meshes[0], expected = baseline.result.meshes[0];
    expect(actual.volume).toBeCloseTo(expected.volume, 6);
    for (const side of ['min', 'max'] as const) for (let axis = 0; axis < 3; axis++) expect(actual.bounds[side][axis]).toBeCloseTo(expected.bounds[side][axis], 6);
    a = loadCadSolidImport({ format: 'step', encoding: 'utf8', fileName: 'datum.step', data: await direct.export('step').text() }).shape;
    b = loadCadSolidImport({ format: 'step', encoding: 'utf8', fileName: 'principal.step', data: await baseline.export('step').text() }).shape;
    common = a.intersect(b);
    expect(measureVolume(a)).toBeCloseTo(actual.volume, 5);
    expect(measureVolume(common)).toBeCloseTo(measureVolume(a), 5);
  } finally { common?.delete(); a?.delete(); b?.delete(); direct.dispose(); baseline.dispose(); }
}
function baseline(sections: readonly CadSketchFeature[], plane: CadPlane, ruled: boolean): readonly CadFeature[] {
  const first = Number(sections[0].offset);
  const local = sections.map(section => ({ ...section, plane: 'XY' as const, offset: Number(section.offset) - first }));
  const basisRotation = plane === 'XY' ? [0, 0, 0] as const : plane === 'XZ' ? [90, 0, 0] as const : [90, 0, 90] as const;
  const stationTranslation = plane === 'XY' ? [0, 0, first] as const : plane === 'XZ' ? [0, -first, 0] as const : [first, 0, 0] as const;
  return [...local, loft(local.map(section => section.id), { ruled }),
    { ...base('basis'), kind: 'transform', sourceId: 'loft', translation: stationTranslation, rotation: basisRotation },
    { ...base('placed'), kind: 'transform', sourceId: 'basis', translation: origin, rotation }];
}

describe('canonical datum loft construction', () => {
  it.each(['XY', 'XZ', 'YZ'] satisfies CadPlane[])('preserves %s basis and descending signed stations after STEP reopen', async plane => {
    const sections = [sketch('a', 27, circle(8)), sketch('b', 7, circle(12))];
    await compare([datum(plane), ...sections, loft(['a', 'b'], { ruled: true })], baseline(sections, plane, true));
  });
  it('fits three smooth sections canonically before placement, avoiding orientation-dependent fitted geometry', async () => {
    // Direct world ThruSections previously changed volume by .127188 mm³ and
    // lost .390964 mm³ of Common despite passing native validity/end bounds.
    const sections = [sketch('a', 0, circle(12)), sketch('b', 10, circle(8)), sketch('c', 20, circle(10))];
    await compare([datum(), ...sections, loft(['a', 'b', 'c'])], baseline(sections, 'XY', false));
  });
  it('preserves separate datum origins as tangential shifts rather than relocating source contours', async () => {
    const first = datum('XZ'); const frame = resolveCadWorldDatum(first, {});
    const shifts = [[0, 0], [3, 2], [5, 4]] as const;
    const sizes = [[10, 8], [12, 6], [8, 10]] as const;
    const features: CadFeature[] = []; const sections: CadSketchFeature[] = []; const localSections: CadSketchFeature[] = [];
    shifts.forEach((shift, index) => {
      const id = `datum_${index}`;
      features.push({ ...first, id, definition: { ...first.definition, origin: cadFramePointToWorld(frame, 0, shift) } });
      const size = sizes[index];
      const section = sketch(`section_${index}`, 7 + index * 10, rectangle(size[0], size[1]), { kind: 'datum-plane', featureId: id });
      features.push(section); sections.push(section);
      localSections.push(sketch(section.id, Number(section.offset), rectangle(size[0], size[1], shift[0], shift[1])));
    });
    const original = JSON.stringify(features);
    await compare([...features, loft(sections.map(section => section.id))], baseline(localSections, 'XZ', false));
    expect(JSON.stringify(features)).toBe(original);
  });
  it('combines an aligned principal section with a datum section without relocating either', async () => {
    const shifted: CadDatumPlaneFeature = { ...datum(), definition: { kind: 'world', basePlane: 'XY', origin: [3, 2, 0], rotation: [0, 0, 0] } };
    const first = sketch('a', 7, circle(12), 'XY'); const last = sketch('b', 27, circle(8));
    await compare([shifted, first, last, loft(['a', 'b'])],
      [first, sketch('b', 27, { kind: 'circle', x: 3, y: 2, radius: 8 }, 'XY'), loft(['a', 'b'])]);
  });
  it.each(['join', 'cut'] as const)('reuses ordinary %s and leaves datum/sketch references available', operation => {
    const plane: CadDatumPlaneFeature = { ...datum(), definition: { kind: 'world', basePlane: 'XY', origin: [0, 0, 10], rotation: [90, 0, 0] } };
    const sections = [sketch('a', -15, circle(2)), sketch('b', 15, circle(2))];
    const model = buildCadKernelModel(parseCadDocument(document([...stock, plane, ...sections, loft(['a', 'b'], { operation, targetId: 'stock' }),
      { ...base('reference_reused'), kind: 'extrude', sketchId: 'a', distance: 1, symmetric: false, operation: 'new', targetId: null }])));
    try {
      expect(model.result.diagnostics).toEqual([]);
      expect(model.result.meshes.map(mesh => mesh.featureId)).toEqual(['loft', 'reference_reused']);
      expect(model.result.meshes[0].volume).toBeCloseTo(operation === 'join' ? 8000 + 40 * Math.PI : 8000 - 80 * Math.PI, 6);
    } finally { model.dispose(); }
  });
  it('rejects local smooth end-plane overshoot before placement and preserves the preceding body', () => {
    const model = buildCadKernelModel(document([...stock, datum(), sketch('a', 0, circle(10)), sketch('b', 1, circle(1)), sketch('c', 20, circle(10)),
      loft(['a', 'b', 'c'], { operation: 'join', targetId: 'stock' })]));
    try {
      expect(model.result.diagnostics[0]).toMatchObject({ featureId: 'loft', code: 'loft-overshoot' });
      expect(model.result.meshes.map(mesh => mesh.featureId)).toEqual(['stock']);
      expect(model.result.meshes[0].volume).toBeCloseTo(8000, 6);
      expect(() => model.export('step')).toThrow('Fix the feature diagnostics');
    } finally { model.dispose(); }
  });
  it.each(['setup', 'shape'] as const)('releases native placement owners after %s failure and supports a fresh construction', phase => {
    const oc = getOC(); const released: object[] = []; const restores: (() => void)[] = [];
    for (const native of [oc.gp_Trsf, oc.gp_Ax3, oc.gp_Pnt, oc.gp_Dir, oc.BRepBuilderAPI_Transform]) {
      const original = native.prototype.delete;
      const spy = vi.spyOn(native.prototype, 'delete').mockImplementation(function(this: { delete(): void }) { released.push(this); original.call(this); });
      restores.push(() => spy.mockRestore());
    }
    let failed: object | undefined;
    const fail = phase === 'setup'
      ? vi.spyOn(oc.gp_Trsf.prototype, 'SetDisplacement').mockImplementation(function(this: InstanceType<typeof oc.gp_Trsf>) { failed = this; throw new Error('Forced loft placement failure'); })
      : vi.spyOn(oc.BRepBuilderAPI_Transform.prototype, 'Shape').mockImplementation(function(this: InstanceType<typeof oc.BRepBuilderAPI_Transform>) { failed = this; throw new Error('Forced loft placement failure'); });
    const sections = [datum(), sketch('a', 0, circle(5)), sketch('b', 20, circle(5))];
    const resolved = resolveCadLoftSections(loft(['a', 'b']), new Map(sections.map(feature => [feature.id, feature])), {});
    try {
      expect(() => buildCadLoftSolid(resolved, false)).toThrow('Forced loft placement failure');
      expect(failed).toBeDefined(); expect(released).toContain(failed);
      // Setup owns both axes, their point/directions and transformation before
      // SetDisplacement; the builder is additionally owned in the Shape phase.
      expect(released.length).toBeGreaterThanOrEqual(phase === 'setup' ? 6 : 7);
    } finally { fail.mockRestore(); restores.reverse().forEach(restore => restore()); }
    const fresh = buildCadLoftSolid(resolved, false);
    try { expect(measureVolume(fresh)).toBeCloseTo(500 * Math.PI, 6); } finally { fresh.delete(); }
  });
  it('retains the original target preview and blocks export after a placement setup failure', () => {
    const oc = getOC();
    const fail = vi.spyOn(oc.gp_Trsf.prototype, 'SetDisplacement').mockImplementation(() => { throw new Error('Forced loft setup failure'); });
    try {
      const model = buildCadKernelModel(document([...stock, datum(), sketch('a', 0, circle(5)), sketch('b', 20, circle(5)),
        loft(['a', 'b'], { operation: 'cut', targetId: 'stock' })]));
      try {
        expect(model.result.diagnostics[0]).toMatchObject({ featureId: 'loft', code: 'kernel-operation-failed', details: { operation: 'loft', input: null, kernelMessage: 'Forced loft setup failure' } });
        expect(model.result.meshes.map(mesh => mesh.featureId)).toEqual(['stock']);
        expect(model.result.meshes[0].volume).toBeCloseTo(8000, 6);
        expect(() => model.section({ bodyId: 'stock', plane: 'XY', offset: 10 })).toThrow('Fix the model diagnostics');
        expect(() => model.export('step')).toThrow('Fix the feature diagnostics');
      } finally { model.dispose(); }
    } finally { fail.mockRestore(); }
  });
});
