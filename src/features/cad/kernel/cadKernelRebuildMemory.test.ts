// @vitest-environment node
import { beforeAll, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import initOpenCascade from 'replicad-opencascadejs';
import { getOC, makeCylinder, setOC } from 'replicad';
import { parseCadDocument } from '../../../domain/cad/cadSchema';
import type { CadDocument, CadFeature } from '../../../domain/cad/cadDocument';
import { buildCadKernelModel, type CadKernelModel } from './cadKernelModel';
import { cadKernelDisposeOwned, cadKernelDisposeShape, cadKernelEdges, cadKernelFaces } from './cadKernelShapes';
import { cadKernelParityModels } from './__tests__/cadKernelParity';
import { refuseCadKernelMaker, watchEveryCadKernelNativeObject } from './__tests__/cadKernelNativeObjects';

async function openCascade() {
  const wasmBinary = await readFile(new URL('../../../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  return initOpenCascade({ wasmBinary, print: () => undefined, printErr: () => undefined });
}
beforeAll(async () => { setOC(await openCascade()); }, 60_000);

// Every native object the module hands out is counted: whatever any class constructs, and whatever any instance method,
// static function or property getter of a class, of embind's shared base or of the module itself returns, including
// clones and handle results. Garbage collection does not run before a count.
const watch = watchEveryCadKernelNativeObject;
const parts = new Map(cadKernelParityModels().map(item => [item.id, item.document]));
function part(id: string): CadDocument {
  const document = parts.get(id);
  if (!document) throw new Error(`Expected the ${id} part`);
  return document;
}
function build(document: CadDocument, after?: (model: CadKernelModel) => void) {
  const model = buildCadKernelModel(document);
  try { expect(model.result.diagnostics).toEqual([]); after?.(model); } finally { model.dispose(); }
}

const base = (id: string) => ({ id, name: id, suppressed: false });
const holedBox = parseCadDocument({ format: 'wireedm-cad', schemaVersion: 1, id: 'part', name: 'Part', units: 'mm', parameters: {}, features: [
  { ...base('sketch'), kind: 'sketch', plane: 'XY', offset: 0, profiles: [
    { id: 'outer', name: 'Outer', construction: false, role: 'outer', geometry: { kind: 'rectangle', x: 0, y: 0, width: 20, height: 10, cornerRadius: 0 } },
    { id: 'hole', name: 'Hole', construction: false, role: 'hole', geometry: { kind: 'circle', x: 10, y: 5, radius: 2 } }] },
  { ...base('box'), kind: 'extrude', sketchId: 'sketch', distance: 5, symmetric: false, operation: 'new', targetId: null }] });
// The same box with an angled slot for its hole, so its profile is rotated as well as translated.
const slottedBox = parseCadDocument({ ...holedBox, features: holedBox.features.map(feature => feature.kind !== 'sketch' ? feature : { ...feature, profiles: feature.profiles.map(profile =>
  profile.id !== 'hole' ? profile : { ...profile, geometry: { kind: 'slot', x: 10, y: 5, length: 8, width: 3, angle: 30 } }) }) });
const withFeature = (feature: Record<string, unknown>) => parseCadDocument({ ...holedBox, features: [...holedBox.features, feature as unknown as CadFeature] });
// A closed sector of radius 1,000,000 mm and sweep 0.0000001 degrees, extruded by 1 mm: its arc's three points lie almost
// on one line.
const sectorRadius = 1e6, sectorSweep = 1e-7, sectorEnd = [sectorRadius * Math.cos(sectorSweep * Math.PI / 180), sectorRadius * Math.sin(sectorSweep * Math.PI / 180)];
const thinSector = parseCadDocument({ ...holedBox, features: [
  { ...base('sketch'), kind: 'sketch', plane: 'XY', offset: 0, profiles: [{ id: 'sector', name: 'Sector', construction: false, role: 'outer', geometry: { kind: 'path', segments: [
    { kind: 'line', start: [0, 0], end: [sectorRadius, 0] },
    { kind: 'arc', center: [0, 0], radius: sectorRadius, startAngle: 0, sweep: sectorSweep },
    { kind: 'line', start: sectorEnd, end: [0, 0] }] } }] },
  { ...base('body'), kind: 'extrude', sketchId: 'sketch', distance: 1, symmetric: false, operation: 'new', targetId: null }] });
// The top edge along X, and the two half circles drawCircle gives the hole's top rim.
const lineEdge = { expectedCount: 1, queries: [{ kind: 'edges', expectedCount: 1, predicates: [{ kind: 'line-endpoints', start: [0, 0, 5], end: [20, 0, 5] }] }] };
const rimEdges = { expectedCount: 2, queries: [{ kind: 'edges', expectedCount: 2, predicates: [{ kind: 'circle', center: [10, 5, 5], axis: [0, 0, 1], radius: 2 }] }] };
function inspectAll(model: CadKernelModel) {
  for (const mesh of model.result.meshes) for (const topology of ['edge', 'face'] as const) {
    let offset: number | null = 0, seen = 0;
    while (offset !== null) {
      const page = model.inspectTopology({ bodyId: mesh.featureId, expectedBuildId: model.result.buildId, selection: { kind: 'page', topology, offset, limit: 100 } });
      seen += page.descriptors.length; offset = page.nextOffset;
    }
    expect(seen).toBeGreaterThan(0);
  }
}

/** Forced collection when the runtime allows it; the counts do not depend on it. */
function collector(): (() => void) | undefined {
  try { setFlagsFromString('--expose-gc'); return runInNewContext('gc') as () => void; } catch { return undefined; }
}

it('rebuilds a plate cut by a hole pattern 20 times with no outstanding native object and a flat heap', async () => {
  const gc = collector(), memory = (getOC() as unknown as { wasmMemory: WebAssembly.Memory }).wasmMemory;
  const settle = async () => { gc?.(); await new Promise(resolve => setTimeout(resolve, 0)); gc?.(); };
  const objects = watch(), plate = part('bench-plate-hole-pattern-0');
  try {
    // Warm-up builds grow the heap to the part's working size.
    build(plate); build(plate); await settle();
    const heap = memory.buffer.byteLength;
    expect(objects.outstanding()).toEqual({});
    // Rebuild synchronously, as a queue of edits does, so nothing waits on garbage collection.
    for (let rebuild = 0; rebuild < 20; rebuild++) { build(plate); expect(objects.outstanding(), `rebuild ${rebuild + 1}`).toEqual({}); }
    await settle();
    expect(objects.made()).toBeGreaterThan(22 * 100);
    expect(memory.buffer.byteLength).toBe(heap);
  } finally { objects.restore(); }
}, 120_000);

// Parts whose features reach every other owned path: revolve axes, mirror and transform, loft, sweep,
// Pocket, datum-plane sketches, shell, all-edge fillet and chamfer, and circular patterns.
it.each(['revolve-mirror-transform', 'datum-pad-revolve', 'loft-sweep-pocket', 'shell-fillet', 'box-chamfer-all', 'near-full-turn-pattern'])(
  'builds %s with no outstanding native object', id => {
    const objects = watch();
    try { build(part(id)); expect(objects.made()).toBeGreaterThan(0); expect(objects.outstanding()).toEqual({}); }
    finally { objects.restore(); }
  });
// Each tangent chain comes from a native fillet builder for its edge. The rims make closed contours; the bore's seam makes none and
// falls back to the edge alone. Reading every chain twice also reads them from the build's cache.
function readChains(model: CadKernelModel) {
  const request = { bodyId: 'box', expectedBuildId: model.result.buildId }, adjacency = model.topologyAdjacency(request);
  const chains = [...adjacency.edges, ...adjacency.edges].map(edgeKey => model.topologyTangentChain({ ...request, edgeKey }));
  expect(chains.some(chain => chain.native && chain.closed)).toBe(true); expect(chains.some(chain => !chain.native)).toBe(true);
}

// Slot profiles are rotated and translated. Topology descriptors and sections read curve points, tangents, circles,
// planes, cylinders and face normals; selected-edge fillets and chamfers resolve their edges through the same descriptors.
const queries: readonly { name: string; document: () => CadDocument; after?: (model: CadKernelModel) => void }[] = [
  { name: 'builds a box with an angled slot', document: () => slottedBox },
  { name: 'inspects every edge and face of a holed box', document: () => holedBox, after: inspectAll },
  { name: 'inspects every edge and face of the heavy pattern', document: () => part('pattern-heavy'), after: inspectAll },
  { name: 'reads the adjacency and every edge\'s tangent chain of a holed box', document: () => holedBox, after: readChains },
  { name: 'sections a holed box across XY', document: () => holedBox, after: model => { expect(model.section({ bodyId: 'box', plane: 'XY', offset: 2.5 }).contourCount).toBe(2); } },
  { name: 'sections a holed box across XZ through the hole', document: () => holedBox, after: model => { expect(model.section({ bodyId: 'box', plane: 'XZ', offset: -5 }).contourCount).toBe(2); } },
  { name: 'fillets a selected straight edge', document: () => withFeature({ ...base('round'), kind: 'fillet', targetId: 'box', radius: 0.5, selection: lineEdge }) },
  { name: 'chamfers a selected circular rim', document: () => withFeature({ ...base('bevel'), kind: 'chamfer', targetId: 'box', radius: 0.5, selection: rimEdges }) }
];
it.each(queries)('$name with no outstanding native object', query => {
  const document = query.document(), objects = watch();
  try { build(document, query.after); expect(objects.made()).toBeGreaterThan(0); expect(objects.outstanding()).toEqual({}); }
  finally { objects.restore(); }
});

// Rebuilds of a rejected profile. Whether OpenCascade makes the thin sector's arc depends on what ran before in the
// module: in a fresh module its arc maker refuses the three points and the profile is invalid; after other builds it makes
// the arc and the extrusion is refused as an empty solid. Neither refusal may leave a native object.
function rejectFiveTimes(document: CadDocument, featureId: string, codes: readonly string[]) {
  const objects = watch();
  try {
    for (let rebuild = 0; rebuild < 5; rebuild++) {
      const model = buildCadKernelModel(document);
      try {
        expect(model.result.meshes).toEqual([]);
        const [first, ...rest] = model.result.diagnostics.map(item => [item.code, item.featureId]);
        expect(codes).toContain(first?.[0]);
        expect([first?.[1], ...rest]).toEqual([featureId, ['rebuild-stopped', featureId]]);
      } finally { model.dispose(); }
      expect(objects.outstanding(), `rebuild ${rebuild + 1}`).toEqual({});
    }
    expect(objects.made()).toBeGreaterThan(0);
  } finally { objects.restore(); }
}
it('rejects the thin sector in a fresh module, whose arc maker refuses it, 5 times with no outstanding native object', async () => {
  const shared = getOC();
  setOC(await openCascade());
  try { rejectFiveTimes(thinSector, 'body', ['invalid-profile']); } finally { setOC(shared); }
}, 60_000);
it('rejects the thin sector after other builds 5 times with no outstanding native object', () => {
  build(holedBox);
  rejectFiveTimes(thinSector, 'body', ['invalid-profile', 'empty-solid']);
});
// The same refusal, made certain: the holed box's second half circle or third rectangle side is refused after the curves
// and drawings before it were made, and they are deleted with it.
it.each([['GC_MakeArcOfCircle2d', 2], ['GC_MakeSegment2d', 3]] as const)('rejects the holed box when %s number %s is refused, 5 times with no outstanding native object', (maker, call) => {
  const objects = watch();
  try {
    for (let rebuild = 0; rebuild < 5; rebuild++) {
      const refusal = refuseCadKernelMaker(maker, call);
      try {
        const model = buildCadKernelModel(holedBox);
        try {
          expect(refusal.refused()).toBe(true); expect(model.result.meshes).toEqual([]);
          expect(model.result.diagnostics.map(item => [item.code, item.featureId])).toEqual([['invalid-profile', 'box'], ['rebuild-stopped', 'box']]);
        } finally { model.dispose(); }
      } finally { refusal.restore(); }
      expect(objects.outstanding(), `rebuild ${rebuild + 1}`).toEqual({});
    }
  } finally { objects.restore(); }
});

// Negative control: the watch sees each kind of construction and query result the adapters and descriptors delete.
it('sees each construction and query result that is not deleted', () => {
  const shape = makeCylinder(2, 5), edges = cadKernelEdges(shape), faces = cadKernelFaces(shape);
  try {
    const oc = getOC(), circleEdge = edges.find(edge => edge.geomType === 'CIRCLE'), planeFace = faces.find(face => face.geomType === 'PLANE');
    const cylinderFace = faces.find(face => face.geomType === 'CYLINDRE');
    if (!circleEdge || !planeFace || !cylinderFace) throw new Error('Expected circular edges and planar and cylindrical faces');
    const objects = watch(), leaked: { delete(): void }[] = [];
    try {
      const keep = <T extends { delete(): void }>(value: T): T => { leaked.push(value); return value; };
      const curve = keep(new oc.BRepAdaptor_Curve(circleEdge.wrapped)), circle = keep(curve.Circle());
      keep(circle.Location()); keep(keep(circle.Axis()).Direction());
      const surface = keep(new oc.BRepAdaptor_Surface(planeFace.wrapped, false)); keep(keep(surface.Plane()).Location());
      const round = keep(new oc.BRepAdaptor_Surface(cylinderFace.wrapped, false)), cylinder = keep(round.Cylinder());
      keep(cylinder.Location()); keep(cylinder.Axis());
      keep(new oc.BRepOffsetAPI_ThruSections(true, false, 1e-6));
      const start = keep(new oc.gp_Pnt2d(0, 0)), middle = keep(new oc.gp_Pnt2d(1, 0)), end = keep(new oc.gp_Pnt2d(2, 0));
      // Collinear points: the arc maker is not done.
      expect(keep(new oc.GC_MakeArcOfCircle2d(start, middle, end)).IsDone()).toBe(false);
      const properties = keep(new oc.GProp_GProps()); keep(properties.CentreOfMass());
      keep(new oc.Bnd_Box());
      expect(objects.outstanding()).toEqual({
        BRepAdaptor_Curve: 1, 'GeomAdaptor_TransformedCurve.Circle': 1, 'gp_Circ.Location': 1, 'gp_Circ.Axis': 1, 'gp_Ax1.Direction': 1,
        BRepAdaptor_Surface: 2, 'GeomAdaptor_TransformedSurface.Plane': 1, 'gp_Pln.Location': 1, 'GeomAdaptor_TransformedSurface.Cylinder': 1,
        'gp_Cylinder.Location': 1, 'gp_Cylinder.Axis': 1, BRepOffsetAPI_ThruSections: 1, gp_Pnt2d: 3, GC_MakeArcOfCircle2d: 1,
        GProp_GProps: 1, 'GProp_GProps.CentreOfMass': 1, Bnd_Box: 1
      });
      for (const value of leaked.splice(0).reverse()) value.delete();
      expect(objects.outstanding()).toEqual({});
    } finally { for (const value of leaked) value.delete(); objects.restore(); }
  } finally { [...edges, ...faces].forEach(cadKernelDisposeOwned); cadKernelDisposeShape(shape); }
});

/** The members embind's shared base gives every object, which the generated types leave out. */
interface EmbindHandle { clone(): EmbindHandle; deleteLater(): EmbindHandle; delete(): void; isDeleted(): boolean }
const embind = (value: object) => value as EmbindHandle;

// Negative control: embind's clone, defined once on the shared base of every class, makes a new handle to the same
// object, which stays alive until every handle is deleted.
it('sees a clone that keeps its object alive after the original is deleted', () => {
  const oc = getOC(), shape = makeCylinder(2, 5), objects = watch(), leaked: EmbindHandle[] = [];
  try {
    const point = embind(new oc.gp_Pnt(1, 2, 3)), clone = point.clone();
    leaked.push(clone);
    point.delete();
    expect((clone as unknown as InstanceType<typeof oc.gp_Pnt>).X()).toBe(1);
    // A shape made before the watch, and a clone of its clone.
    const copy = embind(shape.wrapped).clone(); leaked.push(copy, copy.clone());
    expect(objects.outstanding()).toEqual({ 'ClassHandle.clone': 3 });
    for (const value of leaked.splice(0)) value.delete();
    expect(objects.outstanding()).toEqual({});
    // deleteLater returns the object it schedules, which is not a new one. This build exports no way to run the
    // deletions it schedules, so the point stays outstanding.
    const later = embind(new oc.gp_Pnt(4, 5, 6));
    expect(later.deleteLater()).toBe(later);
    expect(objects.outstanding()).toEqual({ gp_Pnt: 1 });
  } finally { for (const value of leaked) if (!value.isDeleted()) value.delete(); objects.restore(); cadKernelDisposeShape(shape); }
});

// A module shaped like OpenCascade's: the shared base defines clone and deleteLater, a base class has no name in the
// module, and the class has a property getter and a static function. Objects the module makes natively, without its
// constructors, are made with `native`.
function shapedModule() {
  class ClassHandle {
    gone = false;
    isDeleted() { return this.gone; }
    delete() { this.gone = true; }
    clone() { return native(); }
    deleteLater() { return this; }
  }
  class Base extends ClassHandle { Twin() { return native(); } }
  class Thing extends Base {
    get Part() { return native(); }
    Copy() { return native(); }
    static Make() { return native(); }
  }
  const native = (): Thing => Object.assign(Object.create(Thing.prototype) as Thing, { gone: false });
  return { Thing, make: native, print: () => undefined };
}

it('watches every function a module shaped like OpenCascade\'s exposes, and restores each one', () => {
  const module = shapedModule(), { Thing } = module, base = Object.getPrototypeOf(Thing.prototype) as object;
  const descriptors = (owner: object) => Object.getOwnPropertyDescriptors(owner);
  const before = [module, Thing, Thing.prototype, base, Object.getPrototypeOf(base) as object].map(descriptors);
  const objects = watchEveryCadKernelNativeObject(module);
  try {
    const thing = new module.Thing();
    const values = [thing.Part, thing.Copy(), module.Thing.Make(), thing.Twin(), thing.clone(), module.make()];
    expect(thing.deleteLater()).toBe(thing);
    module.print();
    expect(objects.outstanding()).toEqual({ Thing: 1, 'Thing.Part': 1, 'Thing.Copy': 1, 'Thing.Make': 1, 'Base.Twin': 1, 'ClassHandle.clone': 1, make: 1 });
    for (const value of [thing, ...values]) value.delete();
    expect(objects.outstanding()).toEqual({});
  } finally { objects.restore(); }
  expect([module, Thing, Thing.prototype, base, Object.getPrototypeOf(base) as object].map(descriptors)).toEqual(before);
});
