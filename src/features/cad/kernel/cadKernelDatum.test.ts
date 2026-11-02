// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import initOpenCascade from 'replicad-opencascadejs';
import { getOC, measureVolume, setOC, Shape, Sketch, type Shape3D } from 'replicad';
import type { CadDatumPlaneFeature, CadDocument, CadFeature, CadPlane, CadProfile, CadSketchFeature } from '../../../domain/cad/cadDocument';
import { parseCadDocument } from '../../../domain/cad/cadSchema';
import { buildCadKernelModel } from './cadKernelModel';
import { loadCadSolidImport } from './cadKernelImport';
import { sectionCadKernelShape } from './cadKernelSection';
import * as kernelPlanes from './cadKernelPlane';
import { CadKernelPlane } from './cadKernelPlane';

beforeAll(async () => {
  const wasmBinary = await readFile(new URL('../../../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  setOC(await initOpenCascade({ wasmBinary, print: () => undefined, printErr: () => undefined }));
}, 60_000);
const base = (id: string) => ({ id, name: id, suppressed: false });
const rotation = [23, -37, 61] as const;
const origin = [37, -24, 11] as const;
const outline: CadProfile = { kind: 'rectangle', x: -2, y: 3, width: 20, height: 12, cornerRadius: 2 };
const datum = (plane: CadPlane = 'XY', angles: readonly [number, number, number] = rotation, translation: readonly [number, number, number] = origin): CadDatumPlaneFeature =>
  ({ ...base('datum'), kind: 'datum-plane', definition: { kind: 'world', basePlane: plane, origin: translation, rotation: angles } });
function sketch(plane: CadSketchFeature['plane'], geometry: CadProfile = outline, holed = false): CadSketchFeature {
  return { ...base('sketch'), kind: 'sketch', plane, offset: 7, profiles: [{ id: 'boundary', name: 'Boundary', construction: false, geometry },
    ...(holed ? [{ id: 'hole', name: 'Hole', construction: false, geometry: { kind: 'circle' as const, x: 8, y: 9, radius: 3 } },
      { id: 'island', name: 'Island', construction: false, geometry: { kind: 'circle' as const, x: 8, y: 9, radius: 1 } }] : [])] };
}
const onDatum = { kind: 'datum-plane', featureId: 'datum' } as const;
function document(features: readonly CadFeature[], parameters: Readonly<Record<string, number>> = {}): CadDocument {
  return { format: 'wireedm-cad', schemaVersion: 1, id: 'datum_test', name: 'Datum test', units: 'mm', parameters, features };
}
const pad = (distance = 6, symmetric = false): Extract<CadFeature, { kind: 'extrude' }> =>
  ({ ...base('solid'), kind: 'extrude', sketchId: 'sketch', distance, symmetric, operation: 'new', targetId: null });
function nativeStats(shape: Shape3D) {
  const analyzer = new (getOC()).BRepCheck_Analyzer(shape.wrapped, true, false, false);
  const solids = shape.solids; const faces = shape.faces; const edges = shape.edges;
  try { return { valid: analyzer.IsValid(), solids: solids.length, faces: faces.length, edges: edges.length, volume: measureVolume(shape) }; }
  finally { analyzer.delete(); [...solids, ...faces, ...edges].forEach(item => item.delete()); }
}
async function compare(plane: CadPlane, operation: Extract<CadFeature, { kind: 'extrude' | 'revolve' }>, geometry = outline,
  angles: readonly [number, number, number] = rotation, holed = false) {
  const direct = buildCadKernelModel(parseCadDocument(document([datum(plane, angles), sketch(onDatum, geometry, holed), operation])));
  const baseline = buildCadKernelModel(parseCadDocument(document([sketch(plane, geometry, holed), operation,
    { ...base('baseline'), kind: 'transform', sourceId: 'solid', translation: origin, rotation: angles }])));
  let directShape: Shape3D | undefined; let baselineShape: Shape3D | undefined; let common: Shape3D | undefined;
  try {
    expect(direct.result.diagnostics).toEqual([]); expect(baseline.result.diagnostics).toEqual([]);
    expect(direct.result.meshes.map(mesh => mesh.featureId)).toEqual(['solid']);
    const a = direct.result.meshes[0], b = baseline.result.meshes[0];
    expect(a.volume).toBeCloseTo(b.volume, 8);
    for (const side of ['min', 'max'] as const) for (let axis = 0; axis < 3; axis++) expect(a.bounds[side][axis]).toBeCloseTo(b.bounds[side][axis], 8);
    directShape = loadCadSolidImport({ format: 'step', encoding: 'utf8', fileName: 'datum.step', data: await direct.export('step').text() }).shape;
    baselineShape = loadCadSolidImport({ format: 'step', encoding: 'utf8', fileName: 'baseline.step', data: await baseline.export('step').text() }).shape;
    const directStats = nativeStats(directShape), baselineStats = nativeStats(baselineShape);
    expect(directStats).toMatchObject({ valid: true, solids: holed ? 2 : 1 });
    expect({ faces: directStats.faces, edges: directStats.edges, solids: directStats.solids }).toEqual({ faces: baselineStats.faces, edges: baselineStats.edges, solids: baselineStats.solids });
    common = directShape.intersect(baselineShape); expect(measureVolume(common)).toBeCloseTo(directStats.volume, 6);
    if (operation.kind === 'extrude') {
      let local = directShape.clone().translate(-origin[0], -origin[1], -origin[2]);
      for (const axis of [2, 1, 0]) if (angles[axis]) local = local.rotate(-angles[axis], [0, 0, 0], axis === 0 ? [1, 0, 0] : axis === 1 ? [0, 1, 0] : [0, 0, 1]);
      try {
        const offset = 7 + (operation.symmetric ? 0 : Number(operation.distance) / 2);
        const section = sectionCadKernelShape(local, { bodyId: 'local', plane, offset });
        expect(section.contourCount).toBe(holed ? 3 : 1);
        expect(section.entities.filter(entity => entity.type === 'arc')).toHaveLength(4);
        expect(section.entities.filter(entity => entity.type === 'circle')).toHaveLength(holed ? 2 : 0);
      } finally { local.delete(); }
    }
  } finally { common?.delete(); directShape?.delete(); baselineShape?.delete(); direct.dispose(); baseline.dispose(); }
}

describe('exact world datum Pad and Revolve', () => {
  it.each(['XY', 'XZ', 'YZ'] satisfies CadPlane[])('matches an independent transformed %s negative symmetric Pad', async plane => {
    await compare(plane, pad(-6, true));
  });
  it.each([-6, 6])('preserves XZ negative-Y normal and signed Pad distance %s', async distance => {
    await compare('XZ', pad(distance));
  });
  it('retains holes and material islands on an exactly cardinal rotated frame', async () => {
    await compare('XZ', pad(6, true), outline, [90, 0, -90], true);
  });
  it.each(['XY', 'XZ', 'YZ'] satisfies CadPlane[])('uses both local revolve axes through the placed %s origin', async plane => {
    for (const axis of ['x', 'y'] as const) {
      const geometry: CadProfile = axis === 'x' ? { kind: 'rectangle', x: 0, y: 5, width: 7, height: 3, cornerRadius: 0 }
        : { kind: 'rectangle', x: 5, y: 0, width: 3, height: 7, cornerRadius: 0 };
      await compare(plane, { ...base('solid'), kind: 'revolve', sketchId: 'sketch', axis, angle: axis === 'x' ? 135 : 360, operation: 'new', targetId: null }, geometry);
    }
  });
  it.each(['join', 'cut'] as const)('reuses ordinary %s commit semantics without consuming the datum or source sketch', operation => {
    const stockSketch: CadSketchFeature = { ...sketch('XY', { kind: 'rectangle', x: -10, y: -10, width: 20, height: 20, cornerRadius: 0 }), id: 'stock_sketch', offset: 0 };
    const circle: CadSketchFeature = { ...sketch(onDatum, { kind: 'circle', x: 0, y: 0, radius: 2 }), offset: 0 };
    const model = buildCadKernelModel(parseCadDocument(document([stockSketch, { ...pad(20), id: 'stock', sketchId: 'stock_sketch' },
      datum('XY', [90, 0, 0], [0, 0, 10]), circle, { ...pad(30, true), operation, targetId: 'stock' },
      { ...pad(2), id: 'second' }])));
    try {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes.map(mesh => mesh.featureId)).toEqual(['solid', 'second']);
      expect(model.result.meshes[0].volume).toBeCloseTo(8000 + (operation === 'join' ? 40 : -80) * Math.PI, 6);
      expect(model.result.meshes[1].volume).toBeCloseTo(8 * Math.PI, 6);
    } finally { model.dispose(); }
  });
  it('re-evaluates expression-backed frames and distances for each fresh build without rewriting local geometry', () => {
    const plane: CadDatumPlaneFeature = { ...datum(), definition: { kind: 'world', basePlane: 'XZ', origin: ['tx', -24, 11], rotation: ['tilt', -37, 61] } };
    const features = [plane, { ...sketch(onDatum), offset: 'station' }, { ...pad(6, true), distance: 'height' }];
    const original = JSON.stringify(features); const buildIds = new Set<string>(); const bounds: number[] = [];
    for (const [tx, tilt, height] of [[37, 23, 6], [50, -31, 9]]) {
      const model = buildCadKernelModel(parseCadDocument(document(features, { tx, tilt, height, station: 7 })));
      try {
        expect(model.result.diagnostics).toEqual([]); buildIds.add(model.result.buildId); bounds.push(model.result.meshes[0].bounds.min[0]);
        expect(model.result.meshes[0].volume).toBeCloseTo((240 - (4 - Math.PI) * 4) * height, 6);
      } finally { model.dispose(); }
    }
    expect(buildIds.size).toBe(2); expect(bounds[0]).not.toBeCloseTo(bounds[1], 1); expect(JSON.stringify(features)).toBe(original);
  });
  it('treats datums as reference-only and reports invalid/missing prefix frames without corrupting a solid', () => {
    const referenceOnly = buildCadKernelModel(document([datum()]));
    try { expect(referenceOnly.result.meshes).toEqual([]); expect(referenceOnly.result.diagnostics).toEqual([]); expect(() => referenceOnly.export('step')).toThrow('Create a valid solid'); }
    finally { referenceOnly.dispose(); }
    const stockSketch: CadSketchFeature = { ...sketch('XY'), id: 'stock_sketch' };
    const invalid: CadDatumPlaneFeature = { ...datum(), definition: { ...datum().definition, rotation: ['missing', 0, 0] } };
    for (const bad of [invalid, { ...datum(), suppressed: true }]) {
      // Direct native entry checks the prefix too, even if a caller skipped the domain parser.
      const model = buildCadKernelModel(document([stockSketch, { ...pad(), id: 'stock', sketchId: 'stock_sketch' }, bad, sketch(onDatum), pad()]));
      try {
        expect(model.result.meshes.map(mesh => mesh.featureId)).toEqual(['stock']);
        expect(model.result.diagnostics[0].featureId).toBe(bad.suppressed ? 'solid' : 'datum'); expect(() => model.export('step')).toThrow('Fix the feature diagnostics');
      } finally { model.dispose(); }
    }
  });
  it('rejects unsupported datum precision before native construction and preserves legacy principal acceptance', () => {
    const stockSketch: CadSketchFeature = { ...sketch('XY'), id: 'stock_sketch' };
    const deleted = vi.spyOn(CadKernelPlane.prototype, 'delete');
    const model = buildCadKernelModel(document([stockSketch, { ...pad(), id: 'stock', sketchId: 'stock_sketch' }, datum('XZ', rotation, [1e8, -1e8, 1e8]), sketch(onDatum), pad()]));
    try {
      expect(model.result.meshes.map(mesh => mesh.featureId)).toEqual(['stock']); expect(model.result.diagnostics[0].featureId).toBe('solid');
      expect(model.result.diagnostics[0].message).toMatch(/precision|origin/i); expect(deleted).toHaveBeenCalledTimes(1);
    } finally { model.dispose(); deleted.mockRestore(); }
    const far: CadSketchFeature = { ...sketch('XZ', { kind: 'rectangle', x: 1e8, y: 1e8, width: 20, height: 12, cornerRadius: 0 }) };
    const legacy = buildCadKernelModel(parseCadDocument(document([far, pad(6, true)])));
    try { expect(legacy.result.diagnostics).toEqual([]); expect(legacy.result.meshes[0].volume).toBeCloseTo(1440, 5); }
    finally { legacy.dispose(); }
  });
  it('releases the native plane and sketches on a failed datum Pad while preserving the preceding solid', () => {
    const stockSketch: CadSketchFeature = { ...sketch('XY'), id: 'stock_sketch' };
    const documentInput = parseCadDocument(document([stockSketch, { ...pad(), id: 'stock', sketchId: 'stock_sketch' }, datum(), sketch(onDatum, outline, true), pad()]));
    const oc = getOC(), original = oc.BRepPrimAPI_MakePrism.prototype.Shape;
    const deleted = vi.spyOn(CadKernelPlane.prototype, 'delete'); const deletedSketches = vi.spyOn(Sketch.prototype, 'delete');
    const readNull = Object.getOwnPropertyDescriptor(Shape.prototype, 'isNull')?.get;
    if (!readNull) throw new Error('Expected native shape status getter');
    let transient: Shape3D | undefined;
    let calls = 0;
    const produced = vi.spyOn(Shape.prototype, 'isNull', 'get').mockImplementation(function(this: Shape3D) {
      if (calls === 2 && !transient) transient = this;
      return readNull.call(this);
    });
    const extrude = vi.spyOn(oc.BRepPrimAPI_MakePrism.prototype, 'Shape').mockImplementation(function(this: InstanceType<typeof oc.BRepPrimAPI_MakePrism>) {
      if (++calls === 3) throw new Error('Forced datum primitive failure'); return original.call(this);
    });
    const model = buildCadKernelModel(documentInput);
    try {
      expect(model.result.meshes.map(mesh => mesh.featureId)).toEqual(['stock']); expect(model.result.diagnostics[0]).toEqual({ code: 'kernel-operation-failed', featureId: 'solid', message: expect.stringMatching(/^The extrusion could not be built from its sketch./),
        details: { operation: 'extrude', input: { field: 'sketchId', id: 'sketch' }, kernelMessage: 'Forced datum primitive failure' } });
      expect(deleted).toHaveBeenCalledTimes(2); expect(deletedSketches).toHaveBeenCalled(); expect(() => model.export('step')).toThrow('Fix the feature diagnostics');
      expect(calls).toBe(3); const staged = transient; if (!staged) throw new Error('Missing staged region'); expect(() => staged.wrapped).toThrow();
    } finally { model.dispose(); extrude.mockRestore(); produced.mockRestore(); deleted.mockRestore(); deletedSketches.mockRestore(); }
  });
  it('releases an allocated native plane when reading its world origin fails', () => {
    const createPlane = kernelPlanes.createCadKernelPlane;
    const deleted = vi.spyOn(CadKernelPlane.prototype, 'delete'); let failedPlane: CadKernelPlane | undefined;
    const originReads: { mockRestore(): void }[] = [];
    const factory = vi.spyOn(kernelPlanes, 'createCadKernelPlane').mockImplementation((frame, station) => {
      const plane = createPlane(frame, station); failedPlane = plane;
      originReads.push(vi.spyOn(plane.origin, 'toTuple').mockImplementation(() => { throw new Error('Forced native origin failure'); }));
      return plane;
    });
    const model = buildCadKernelModel(parseCadDocument(document([datum(), sketch(onDatum), pad()])));
    try {
      expect(model.result.diagnostics[0]).toMatchObject({ featureId: 'solid', message: expect.stringMatching(/^The extrusion could not be built/), details: { kernelMessage: 'Forced native origin failure' } });
      expect(model.result.meshes).toEqual([]); expect(deleted).toHaveBeenCalledTimes(1);
      const released = failedPlane; if (!released) throw new Error('Native plane was not allocated');
      expect(() => released.origin.wrapped).toThrow();
    } finally { model.dispose(); factory.mockRestore(); originReads.forEach(spy => spy.mockRestore()); deleted.mockRestore(); }
  });
});
