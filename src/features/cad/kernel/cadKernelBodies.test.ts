// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import initOpenCascade from 'replicad-opencascadejs';
import { cast, Compound, getOC, makeBox, setOC, type Shape3D } from 'replicad';
import type { CadDocument, CadFeature, CadMesh } from '../../../domain/cad/cadDocument';
import { createCadDocument, parseCadDocument } from '../../../domain/cad/cadSchema';
import { cadBodyLineage, cadBodyParts, resolveCadBodyRef, type CadBodyIssue, type CadBodyKey, type CadBodyRefResolution, type CadBodyState } from '../../../domain/cad/cadBodies';
import { createCadKernelFaceSources } from './cadKernelBodyPieces';
import { cadKernelBuilders } from './cadKernelBuilders';
import { buildCadKernelModel, type CadKernelModel } from './cadKernelModel';
import { isCadKernelReply } from './cadKernelProtocol';
import { cadKernelDisposeShape, cadKernelSolids } from './cadKernelShapes';
import { cadKernelParityModels } from './__tests__/cadKernelParity';
import { cadBodyKeyVariants } from '../../../domain/cad/__tests__/cadBodyKeyVariants';

beforeAll(async () => {
  const wasmBinary = await readFile(new URL('../../../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  setOC(await initOpenCascade({ wasmBinary, print: () => undefined, printErr: () => undefined }));
}, 60_000);

type Geometry = Extract<CadFeature, { kind: 'sketch' }>['profiles'][number]['geometry'];
const base = (id: string, suppressed = false) => ({ id, name: id, suppressed });
const rect = (x: number, y: number, width: number, height: number): Geometry => ({ kind: 'rectangle', x, y, width, height, cornerRadius: 0 });
const sketch = (id: string, geometry: Geometry): CadFeature => ({ ...base(id), kind: 'sketch', plane: 'XY', offset: 0, profiles: [{ id: `${id}_profile`, name: 'Profile', construction: false, geometry }] });
const sketches = (id: string, geometries: readonly Geometry[], offset = 0): CadFeature => ({ ...base(id), kind: 'sketch', plane: 'XY', offset,
  profiles: geometries.map((geometry, index) => ({ id: `${id}_profile${index}`, name: `Profile ${index}`, construction: false, geometry })) });
const pad = (id: string, sketchId: string, distance: number, operation: 'new' | 'join' | 'cut' = 'new', targetId: string | null = null): CadFeature =>
  ({ ...base(id), kind: 'extrude', sketchId, distance, symmetric: false, operation, targetId });
const box = [sketch('box_sketch', rect(0, 0, 40, 20)), pad('box', 'box_sketch', 10)];
const peg = [sketch('peg_sketch', rect(30, 5, 20, 10)), pad('peg', 'peg_sketch', 15)];
const slot = (id: string, x: number, targetId: string) => [sketch(`${id}_sketch`, rect(x, -5, 2, 30)), pad(id, `${id}_sketch`, 10, 'cut', targetId)];
const pocket = (id: string, x: number, y: number, targetId: string): CadFeature[] => [sketch(`${id}_sketch`, { kind: 'circle', x, y, radius: 1 }),
  { ...base(id), kind: 'pocket', sketchId: `${id}_sketch`, targetId, extent: { kind: 'through-all', direction: 'both' } }];
/** A rod cleaved through its axis: neither half keeps a face of the rod, so the kernel might list them in another order. */
const rod = (id = 'rod') => [sketch(`${id}_sketch`, { kind: 'circle', x: 0, y: 0, radius: 10 }), pad(id, `${id}_sketch`, 20), sketch('cleave_sketch', rect(-1, -15, 2, 30)), pad('cleave', 'cleave_sketch', 20, 'cut', id)];
const row = (sourceId: string, count: number, spacing: number): CadFeature => ({ ...base('row'), kind: 'linear-pattern', sourceId, count, spacing: [spacing, 0, 0] });
/** A pattern of one copy of `sourceId`'s solids, `spacing` away. */
const twice = (id: string, sourceId: string, spacing: readonly [number, number, number]): CadFeature => ({ ...base(id), kind: 'linear-pattern', sourceId, count: 2, spacing });
const document = (features: readonly CadFeature[]): CadDocument => parseCadDocument({ ...createCadDocument('Bodies'), features });

function built<T>(features: readonly CadFeature[], read: (model: CadKernelModel, parsed: CadDocument) => T): T {
  const parsed = document(features), model = buildCadKernelModel(parsed);
  try { expect(model.result.diagnostics).toEqual([]); return read(model, parsed); } finally { model.dispose(); }
}
const identity = (body: CadBodyState) => ({ key: body.key, kind: body.kind, createdBy: body.createdBy, modifiedBy: body.modifiedBy, consumedBy: body.consumedBy });
/** How `key` resolves against a build's bodies. */
const resolve = (model: CadKernelModel, key: string) => resolveCadBodyRef({ kind: 'body', key: key as CadBodyKey },
  { get: wanted => model.result.bodies?.find(body => body.key === wanted), bodies: () => model.result.bodies ?? [], consumed: () => [] });

/** Each solid's span along X, by the solid numbers `faceSolids` uses. */
function solidSpans(mesh: CadMesh): Map<number, [number, number]> {
  const spans = new Map<number, [number, number]>();
  mesh.faceGroups.forEach((group, index) => {
    const solid = mesh.faceSolids?.[index] ?? 0;
    for (let at = group.start; at < group.start + group.count; at++) {
      const x = mesh.positions[mesh.indices[at] * 3], span = spans.get(solid);
      if (span) { span[0] = Math.min(span[0], x); span[1] = Math.max(span[1], x); } else spans.set(solid, [x, x]);
    }
  });
  return spans;
}
/** The piece key of the solid of the first body that lies around `x`. */
function pieceAt(model: CadKernelModel, x: number): string | undefined {
  const mesh = model.result.meshes[0], body = model.result.bodies?.[0];
  for (const [solid, [min, max]] of solidSpans(mesh)) if (min < x && x < max) return body?.pieces?.[solid];
  return undefined;
}

/**
 * Builds with the solids of each Boolean result of two or more listed in the order `order` gives for it, as another kernel version might
 * list them: keys must name the same solids in every order, or be reported ambiguous. `order` is asked for each such result in turn, with
 * its number in the build and its solid count, so that each operation's order can change on its own.
 */
function reorderingSolids<T>(order: (result: number, solids: number) => readonly number[], build: () => T): T {
  const { fuse, cut, common } = cadKernelBuilders;
  let results = 0;
  const reordered = (make: (left: Shape3D, right: Shape3D) => Shape3D) => (left: Shape3D, right: Shape3D): Shape3D => {
    const result = make(left, right), solids = cadKernelSolids(result);
    try {
      if (solids.length < 2) return result;
      const oc = getOC(), compound = new oc.TopoDS_Compound(), builder = new oc.TopoDS_Builder();
      try { builder.MakeCompound(compound); for (const at of order(results++, solids.length)) builder.Add(compound, solids[at].wrapped); } finally { builder.delete(); }
      cadKernelDisposeShape(result);
      return new Compound(compound);
    } finally { for (const solid of solids) cadKernelDisposeShape(solid); }
  };
  Object.assign(cadKernelBuilders, { fuse: reordered(fuse), cut: reordered(cut), common: reordered(common) });
  try { return build(); } finally { Object.assign(cadKernelBuilders, { fuse, cut, common }); }
}
const inOrder = (solids: number) => Array.from({ length: solids }, (_, at) => at), reversed = (solids: number) => inOrder(solids).reverse();
/** Builds with every Boolean result of two or more solids listing them in reverse. */
const reversingSolids = <T>(build: () => T): T => reorderingSolids((_, solids) => reversed(solids), build);
/** How many Boolean results of two or more solids building `features` makes, whose orders `reorderingSolids` can change. */
function multiSolidResults(features: readonly CadFeature[]): number {
  let count = 0;
  reorderingSolids((result, solids) => { count = result + 1; return inOrder(solids); }, () => built(features, () => undefined));
  return count;
}

/** Each solid's extent along X, Y and Z and its surface area, by the solid numbers `faceSolids` uses: what tells solids apart across builds. */
function solidShapes(mesh: CadMesh): Map<number, number[]> {
  const shapes = new Map<number, number[]>();
  mesh.faceGroups.forEach((group, index) => {
    const solid = mesh.faceSolids?.[index] ?? 0;
    let shape = shapes.get(solid);
    if (!shape) shapes.set(solid, shape = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity, 0]);
    for (let at = group.start; at + 2 < group.start + group.count; at += 3) {
      const [a, b, c] = [0, 1, 2].map(corner => [0, 1, 2].map(axis => mesh.positions[mesh.indices[at + corner] * 3 + axis]));
      for (const point of [a, b, c]) for (let axis = 0; axis < 3; axis++) { shape[axis * 2] = Math.min(shape[axis * 2], point[axis]); shape[axis * 2 + 1] = Math.max(shape[axis * 2 + 1], point[axis]); }
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      shape[6] += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
    }
  });
  return shapes;
}
const sameShape = (a: readonly number[], b: readonly number[]) => a.every((value, index) => Math.abs(value - b[index]) <= (index === 6 ? 5e-3 * Math.abs(value) : 1e-3));

/** What a build says about its bodies, kept after its model is disposed. */
interface Bodies { readonly bodies: readonly CadBodyState[]; readonly issues: readonly CadBodyIssue[]; readonly shapes: ReadonlyMap<string, ReadonlyMap<number, readonly number[]>> }
const bodiesOf = (model: CadKernelModel): Bodies => ({ bodies: structuredClone(model.result.bodies ?? []), issues: structuredClone(model.result.bodyIssues ?? []),
  shapes: new Map(model.result.meshes.map(mesh => [mesh.bodyKey ?? '', solidShapes(mesh)])) });
const resolveIn = (built: Bodies, key: string) => resolveCadBodyRef({ kind: 'body', key: key as CadBodyKey },
  { get: wanted => built.bodies.find(body => body.key === wanted), bodies: () => built.bodies, consumed: () => [] });
/** The shapes of the solids a resolution may stand for: a part's, each candidate's, or every solid of a whole body. */
function shapesFor(built: Bodies, resolution: CadBodyRefResolution): (readonly number[])[] {
  if (resolution.status === 'missing') return [];
  const solids = built.shapes.get(resolution.body.key)!, pieces = resolution.body.pieces;
  const parts = resolution.status === 'ambiguous' ? resolution.candidates : resolution.part;
  if (!pieces || parts === undefined) return [...solids.values()];
  return (typeof parts === 'string' ? [parts] : parts).map(part => solids.get(pieces.indexOf(part))!);
}
function sameShapes(a: readonly (readonly number[])[], b: readonly (readonly number[])[]): boolean {
  const left = [...b];
  return a.length === b.length && a.every(shape => { const at = left.findIndex(other => sameShape(shape, other)); return at >= 0 && left.splice(at, 1).length > 0; });
}
/** Every key a body lists: its own, its pieces', its groups' and the keys its orders number. */
const listedKeys = (body: CadBodyState): string[] =>
  [body.key, ...body.pieces ?? [], ...body.ambiguous?.flat() ?? [], ...body.orders?.flatMap(order => order.keys) ?? []];

/** Builds `features` once for every combination of solid orders its Boolean results of two or more solids can list, each on its own. */
function inEveryOrder(features: readonly CadFeature[]): Bodies[] {
  const counts: number[] = [];
  reorderingSolids((result, solids) => { counts[result] = solids; return inOrder(solids); }, () => built(features, () => undefined));
  const permutations = (list: readonly number[]): number[][] =>
    list.length ? list.flatMap((first, at) => permutations(list.filter((_, other) => other !== at)).map(rest => [first, ...rest])) : [[]];
  const combinations = counts.reduce<number[][][]>((all, solids) => all.flatMap(combination => permutations(inOrder(solids)).map(order => [...combination, order])), [[]]);
  return combinations.map(combination => reorderingSolids(result => combination[result], () => built(features, bodiesOf)));
}

/**
 * Checks every part key the builds of `inEveryOrder` list, or formed from one by changing the indices of its split steps, against what
 * the builds show: missing when no build has it as a piece, resolved when every build has it as the same solid, and otherwise ambiguous
 * among exactly the solids it is a piece as in some build, or among more only when they share a provenance group with one of them.
 */
function exactInEveryOrder(results: readonly Bodies[], label: string): void {
  const wholes = new Set<string>(results.flatMap(result => result.bodies.map(body => body.key)));
  const distinct = (shapes: readonly (readonly number[])[]) => shapes.filter((shape, at) => shapes.findIndex(other => sameShape(shape, other)) === at);
  const within = (shapes: readonly (readonly number[])[], among: readonly (readonly number[])[]) => shapes.every(shape => among.some(other => sameShape(shape, other)));
  for (const key of cadBodyKeyVariants(results.flatMap(result => result.bodies.flatMap(listedKeys)))) {
    if (wholes.has(key)) continue;
    const named = results.map(result => {
      for (const body of result.bodies) { const at = body.pieces?.indexOf(key as CadBodyKey) ?? -1; if (at >= 0) return result.shapes.get(body.key)!.get(at)!; }
      return undefined;
    });
    const truth = distinct(named.filter(shape => shape !== undefined));
    results.forEach((result, at) => {
      const resolution = resolveIn(result, key), where = `${label}, order ${at}: ${key}`;
      if (!truth.length) return expect(resolution.status, `${where} is a piece in no order`).toBe('missing');
      if (truth.length === 1 && named.every(shape => shape !== undefined)) return expect(resolution, `${where} is the same piece in every order`).toMatchObject({ status: 'resolved', part: key });
      expect(resolution.status, `${where} names other solids in other orders`).toBe('ambiguous');
      if (resolution.status !== 'ambiguous') return;
      const found = distinct(shapesFor(result, resolution)), grouped = resolution.body.ambiguous?.flat().filter(part => resolution.body.pieces?.includes(part)) ?? [];
      expect(within(truth, found), `${where} leaves out a solid it names in some order`).toBe(true);
      const extra = found.filter(shape => !truth.some(other => sameShape(shape, other)));
      expect(within(extra, shapesFor(result, { status: 'ambiguous', body: resolution.body, candidates: grouped })), `${where} adds a solid it names in no order`).toBe(true);
    });
  }
}

/**
 * Checks that two builds of one history, whose Booleans listed solids in different orders, agree: the same bodies, solid counts and issues,
 * and every key either build lists, or formed from one by changing the indices of its split steps, resolving the same way in both: a
 * certain key naming the same solid, an ambiguous key standing for the same solids and a missing key missing in both.
 * Returns whether the order changed the solid of some ambiguous key, as it should somewhere for the check to mean anything.
 */
function agreeInEitherOrder(normal: Bodies, reordered: Bodies, label: string): boolean {
  const counts = (built: Bodies) => built.bodies.map(body => [body.key, built.shapes.get(body.key)?.size]);
  expect(counts(reordered), label).toEqual(counts(normal));
  const issues = (built: Bodies) => built.issues.map(issue => `${issue.code} ${issue.featureId} ${issue.body} ${issue.pieces.length}`).sort();
  expect(issues(reordered), label).toEqual(issues(normal));
  let renumbered = false;
  const listed = [normal, reordered].flatMap(built => built.bodies.flatMap(listedKeys));
  for (const key of cadBodyKeyVariants(listed)) {
    const [a, b] = [resolveIn(normal, key), resolveIn(reordered, key)];
    expect(a.status, `${label}: ${key} resolves as ${a.status} in one solid order and ${b.status} in the other`).toBe(b.status);
    if (a.status === 'missing' || b.status === 'missing') continue;
    expect(sameShapes(shapesFor(normal, a), shapesFor(reordered, b)), `${label}: ${key} stands for other solids in the other solid order`).toBe(true);
    if (a.status === 'ambiguous' && a.body.pieces?.includes(key as CadBodyKey) && b.body.pieces?.includes(key as CadBodyKey))
      renumbered ||= !sameShape(shapesFor(normal, { status: 'resolved', body: a.body, part: key as CadBodyKey })[0], shapesFor(reordered, { status: 'resolved', body: b.body, part: key as CadBodyKey })[0]);
  }
  return renumbered;
}

describe('kernel body identity', () => {
  it.each<[string, CadFeature[]]>([
    ['fillet', [{ ...base('round'), kind: 'fillet', targetId: 'box', radius: 1 }]],
    ['chamfer', [{ ...base('bevel'), kind: 'chamfer', targetId: 'box', radius: 1 }]],
    ['shell', [{ ...base('hollow'), kind: 'shell', targetId: 'box', thickness: 1, opening: { kind: 'faces', expectedCount: 1, predicates: [{ kind: 'plane', normal: [0, 0, 1], offset: 10 }] } }]],
    ['transform', [{ ...base('move'), kind: 'transform', sourceId: 'box', translation: [5, 0, 0], rotation: [0, 0, 30] }]],
    ['pocket', [sketch('hole_sketch', { kind: 'circle', x: 10, y: 10, radius: 3 }), { ...base('hole'), kind: 'pocket', sketchId: 'hole_sketch', targetId: 'box', extent: { kind: 'through-all', direction: 'both' } }]],
    ['cut', [sketch('notch_sketch', rect(10, 5, 4, 4)), pad('notch', 'notch_sketch', 10, 'cut', 'box')]],
    ['join', [sketch('lug_sketch', rect(35, 5, 10, 10)), pad('lug', 'lug_sketch', 5, 'join', 'box')]]
  ])('keeps the body key through %s', (_, modifiers) => built([...box, ...modifiers], model => {
    const modifier = modifiers.at(-1)!;
    expect(model.result.meshes.map(mesh => [mesh.featureId, mesh.bodyKey])).toEqual([[modifier.id, 'box']]);
    expect(model.result.bodies?.map(identity)).toEqual([{ key: 'box', kind: 'solid', createdBy: 'box', modifiedBy: [modifier.id], consumedBy: undefined }]);
    expect(model.result.bodies?.[0].pieces).toBeUndefined();
  }));

  it('answers adjacency and tangent chain requests for a body by its current feature, as every other topology request does', () =>
    built([...box, { ...base('round'), kind: 'fillet', targetId: 'box', radius: 1 } as CadFeature], model => {
      // The body's key is still box, but its current feature is the fillet: requests name that feature, which leads to the body.
      expect(model.result.bodies?.map(body => [body.key, model.result.meshes[0].featureId])).toEqual([['box', 'round']]);
      const buildId = model.result.buildId, adjacency = model.topologyAdjacency({ bodyId: 'round', expectedBuildId: buildId });
      expect(adjacency).toMatchObject({ bodyId: 'round', buildId });
      expect(adjacency.edges.length).toBeGreaterThan(12);
      const chain = model.topologyTangentChain({ bodyId: 'round', expectedBuildId: buildId, edgeKey: adjacency.edges[0] });
      expect(chain).toMatchObject({ bodyId: 'round', edgeKey: adjacency.edges[0] });
      expect(chain.edges).toContain(adjacency.edges[0]);
      // The pad is no longer a current body state, so naming it is refused, as inspection and pick resolution refuse it.
      expect(() => model.topologyAdjacency({ bodyId: 'box', expectedBuildId: buildId })).toThrow('unavailable');
      expect(() => model.topologyTangentChain({ bodyId: 'box', expectedBuildId: buildId, edgeKey: adjacency.edges[0] })).toThrow('unavailable');
    }));

  it('keeps the target key of a boolean and drops its consumed tool', () => built([...box, ...peg, { ...base('merge'), kind: 'boolean', targetId: 'box', toolId: 'peg', operation: 'union' }], model => {
    expect(model.result.meshes.map(mesh => [mesh.featureId, mesh.bodyKey])).toEqual([['merge', 'box']]);
    expect(model.result.bodies?.[0]).toMatchObject({ key: 'box', modifiedBy: ['merge'] });
  }));

  it('keys separate pattern copies by the copy whose faces they keep, and mirror images', () => {
    built([...box, row('box', 3, 50), { ...base('flip'), kind: 'mirror', sourceId: 'row', plane: 'YZ' }], model => {
      expect(model.result.meshes.map(mesh => [mesh.featureId, mesh.bodyKey])).toEqual([['row', 'box'], ['flip', 'flip/mirror']]);
      expect([pieceAt(model, 20), pieceAt(model, 70), pieceAt(model, 120)]).toEqual(['box/inst(0,0)', 'box/inst(1,0)', 'box/inst(2,0)']);
      expect(model.result.bodies?.[1].pieces).toBeUndefined();
      expect(model.result.bodyIssues).toEqual([]);
    });
    // Overlapping copies fuse into one solid: the body stays whole.
    built([...box, row('box', 3, 30)], model => {
      expect(model.result.meshes[0].solidCount).toBe(1);
      expect(model.result.bodies?.[0].pieces).toBeUndefined();
    });
  });

  it('builds the bodies the domain lineage predicts for every parity part', () => {
    for (const { id, document: parsed } of cadKernelParityModels()) {
      const model = buildCadKernelModel(parsed);
      try {
        expect(model.result.diagnostics, id).toEqual([]);
        expect(model.result.bodies?.map(identity), id).toEqual(cadBodyLineage(parsed.features, parsed).bodies().map(identity));
        expect(model.result.meshes.map(mesh => mesh.bodyKey), id).toEqual(model.result.bodies?.map(body => body.key));
        expect(isCadKernelReply({ id: 1, kind: 'built', result: structuredClone(model.result) }), id).toBe(true);
      } finally { model.dispose(); }
    }
  }, 120_000);

  it('rejects build replies whose body states do not describe their meshes', () => built([...box, ...peg], model => {
    const result = structuredClone(model.result);
    expect(isCadKernelReply({ id: 1, kind: 'built', result })).toBe(true);
    expect(isCadKernelReply({ id: 1, kind: 'built', result: { ...result, bodies: [...result.bodies!].reverse() } })).toBe(false);
    expect(isCadKernelReply({ id: 1, kind: 'built', result: { ...result, bodies: result.bodies!.slice(1) } })).toBe(false);
    expect(isCadKernelReply({ id: 1, kind: 'built', result: { ...result, meshes: result.meshes.map(mesh => ({ ...mesh, bodyKey: 'bad key' })) } })).toBe(false);
    expect(isCadKernelReply({ id: 1, kind: 'built', result: { ...result, bodyIssues: [{ code: 'other' }] } })).toBe(false);
  }));

  it('rejects a body whose pieces do not key its solids one for one', () => built([...box, ...slot('slot', 18, 'box')], model => {
    const result = structuredClone(model.result), [body] = result.bodies!;
    expect(isCadKernelReply({ id: 1, kind: 'built', result })).toBe(true);
    expect(isCadKernelReply({ id: 1, kind: 'built', result: { ...result, bodies: [{ ...body, pieces: body.pieces!.slice(1) }] } })).toBe(false);
    // Every solid needs a key of its own.
    expect(isCadKernelReply({ id: 1, kind: 'built', result: { ...result, bodies: [{ ...body, pieces: body.pieces!.map(() => body.pieces![0]) }] } })).toBe(false);
  }));
});

describe('kernel split pieces', () => {
  it('numbers the pieces of a split by the faces they keep, the same on every build and wherever the cut falls', () => {
    // The box lists its face at x = 40 before its face at x = 0, so the right piece is split(0) although it is the kernel's second
    // solid, whatever the sizes or centroids of the pieces.
    for (const x of [18, 8, 30]) {
      for (let run = 0; run < 2; run++) built([...box, ...slot('slot', x, 'box')], model => {
        expect(model.result.meshes[0].solidCount).toBe(2);
        expect(model.result.bodies?.[0]).toMatchObject({ key: 'box', modifiedBy: ['slot'] });
        expect(model.result.bodies?.[0].ambiguous).toBeUndefined();
        expect([pieceAt(model, x + 5), pieceAt(model, x / 2)]).toEqual(['box/split(0)', 'box/split(1)']);
        expect(model.result.bodies?.[0].pieces).toEqual(['box/split(1)', 'box/split(0)']);
        expect(model.result.bodyIssues).toEqual([]);
      });
    }
  });

  it('carries pieces through a move, splits a piece under its own key and gives a joined island a fresh key', () => {
    built([...box, ...slot('slot', 18, 'box'), { ...base('move'), kind: 'transform', sourceId: 'slot', translation: [100, 0, 0], rotation: [0, 0, 0] }], model => {
      expect([pieceAt(model, 125), pieceAt(model, 105)]).toEqual(['box/split(0)', 'box/split(1)']);
    });
    built([...box, ...slot('slot', 18, 'box'), ...slot('again', 30, 'slot')], model => {
      expect([pieceAt(model, 35), pieceAt(model, 25), pieceAt(model, 9)]).toEqual(['box/split(0)/split(0)', 'box/split(0)/split(1)', 'box/split(1)']);
    });
    built([...box, ...slot('slot', 18, 'box'), sketch('lug_sketch', rect(60, 0, 5, 5)), pad('lug', 'lug_sketch', 5, 'join', 'slot')], model => {
      expect([pieceAt(model, 30), pieceAt(model, 9), pieceAt(model, 62)]).toEqual(['box/split(0)', 'box/split(1)', 'lug/split(0)']);
      expect(model.result.bodyIssues).toEqual([]);
    });
  });

  it('reports pieces that keep no face of the body before as ambiguous', () => {
    built(rod(), model => {
      // Which half is which is the kernel's order, which the body keeps as an order of the two halves.
      expect(model.result.bodies?.[0]).toMatchObject({ key: 'rod', pieces: ['rod/split(0)', 'rod/split(1)'], orders: [{ keys: ['rod/split(0)', 'rod/split(1)'] }] });
      expect(model.result.bodies?.[0].ambiguous).toBeUndefined();
      expect(model.result.bodyIssues).toEqual([expect.objectContaining({ code: 'ambiguous-body-parts', featureId: 'cleave', body: 'rod', pieces: ['rod/split(0)', 'rod/split(1)'] })]);
    });
  });
});

describe('kernel body parts are inherited only when continuity is certain', () => {
  it('bounds the reply of a large valid pattern, keeps every key in its pieces and extends the issue that reported the ambiguity', () => {
    const creator = '3f2a9c1e-5b7d-4e8a-9c0f-1a2b3c4d5e6f', copy = (i: number) => [0, 1].map(k => `${creator}/split(${k})/inst(${i},0)`);
    built([...rod(creator), row('cleave', 100, 25)], model => {
      const body = model.result.bodies![0], expected = Array.from({ length: 100 }, (_, i) => copy(i));
      expect(model.result.meshes[0].solidCount).toBe(200);
      expect(new Set(body.pieces)).toEqual(new Set(expected.flat()));
      // Which half is which is the kernel's order, kept once for the halves: each copy's halves trade keys with each other, never another copy's.
      expect([body.ambiguous, body.orders]).toEqual([undefined, [{ keys: [0, 1].map(k => `${creator}/split(${k})`) }]]);
      expect(model.result.bodyIssues!.map(issue => [issue.code, issue.featureId, issue.pieces.length])).toEqual([['ambiguous-body-parts', 'cleave', 202]]);
      expect(model.result.bodyIssues![0].message).toBe(`202 pieces of body ${creator} can't be told apart after cleave, so references to them are ambiguous.`);
      expect(isCadKernelReply({ id: 1, kind: 'built', result: structuredClone(model.result) })).toBe(true);
    });
  }, 120_000);

  it('resolves an ambiguous key of a pattern copy only among that copy\'s pieces', () => built([...rod(), row('cleave', 2, 30)], model => {
    const copy = (i: number) => [0, 1].map(k => `rod/split(${k})/inst(${i},0)`);
    for (const i of [0, 1]) for (const key of copy(i)) {
      const found = resolve(model, key);
      expect(found.status, key).toBe('ambiguous');
      if (found.status === 'ambiguous') expect([...found.candidates].sort(), key).toEqual(copy(i));
    }
    // Once the pattern copied the halves, their old keys name no piece in any order.
    expect(resolve(model, 'rod/split(0)')).toEqual({ status: 'missing' });
    expect(model.result.bodyIssues).toEqual([expect.objectContaining({ code: 'ambiguous-body-parts', featureId: 'cleave', pieces: ['rod/split(0)', 'rod/split(1)', ...copy(0), ...copy(1)] })]);
  }));


  it('gives an island a fresh key and reports the pieces a bridge merges as lost', () => {
    // The bridge joins both pieces of the split box into one solid and adds an island at x = 60–65. Neither result solid continues one
    // piece, so neither inherits a piece's key, whichever is left over.
    built([...box, ...slot('slot', 18, 'box'), sketches('bridge_sketch', [rect(10, 5, 20, 10), rect(60, 0, 5, 5)]), pad('bridge', 'bridge_sketch', 10, 'join', 'slot')], model => {
      expect(model.result.meshes[0].solidCount).toBe(2);
      expect([pieceAt(model, 62), pieceAt(model, 30)]).toEqual(['bridge/split(0)', 'bridge/split(1)']);
      expect(model.result.bodies?.[0].ambiguous).toBeUndefined();
      expect(model.result.bodyIssues).toEqual([expect.objectContaining({ code: 'lost-body-parts', featureId: 'bridge', body: 'box', pieces: ['box/split(1)', 'box/split(0)'] })]);
      expect([resolve(model, 'box/split(0)'), resolve(model, 'box/split(1)')]).toEqual([{ status: 'missing' }, { status: 'missing' }]);
    });
  });

  it('carries ambiguity through a later modification of an ambiguous piece', () => {
    built([...rod(), ...pocket('hole', 5, 0, 'cleave')], model => {
      const body = model.result.bodies![0];
      expect(body).toMatchObject({ key: 'rod', modifiedBy: ['cleave', 'hole'], pieces: ['rod/split(0)', 'rod/split(1)'], orders: [{ keys: ['rod/split(0)', 'rod/split(1)'] }] });
      expect(model.result.bodyIssues!.map(issue => [issue.code, issue.featureId])).toEqual([['ambiguous-body-parts', 'cleave']]);
      expect(resolve(model, 'rod/split(0)')).toMatchObject({ status: 'ambiguous', candidates: ['rod/split(0)', 'rod/split(1)'] });
    });
  });

  it('never reports an ambiguous piece lost while the solid left could be it', () => {
    // Which half the cut removed depends on the order the kernel listed the halves in, so neither key is lost: each names the half left in
    // some order.
    built([...rod(), sketch('erase_sketch', rect(-20, -20, 20, 40)), pad('erase', 'erase_sketch', 30, 'cut', 'cleave')], model => {
      const body = model.result.bodies![0];
      expect(body.pieces).toHaveLength(1);
      expect([body.ambiguous, body.orders]).toEqual([undefined, [{ keys: ['rod/split(0)', 'rod/split(1)'] }]]);
      expect(model.result.bodyIssues!.map(issue => issue.code)).toEqual(['ambiguous-body-parts']);
      for (const key of ['rod/split(0)', 'rod/split(1)']) expect(resolve(model, key), key).toMatchObject({ status: 'ambiguous', candidates: body.pieces });
    });
  });

  it('treats a solid that keeps no face of the body as a possible piece of any, never as proof that another piece continues alone', () => {
    // An end slab and an interior core of the first box are kept; the second box is removed. The core keeps no face of the box.
    const tools = [sketches('slab_sketch', [rect(-1, -1, 6, 22)], -1), pad('slab', 'slab_sketch', 12), sketches('core_sketch', [rect(10, 5, 5, 10)], 2), pad('core', 'core_sketch', 6),
      { ...base('tools'), kind: 'boolean', targetId: 'slab', toolId: 'core', operation: 'union' } as CadFeature];
    const keep = (targetId: string): CadFeature => ({ ...base('keep'), kind: 'boolean', targetId, toolId: 'tools', operation: 'intersect' });
    built([...box, row('box', 2, 50), ...tools, keep('row')], model => {
      expect(model.result.meshes[0].solidCount).toBe(2);
      expect([pieceAt(model, 2), pieceAt(model, 12)]).toEqual(['box/inst(0,0)', 'keep/split(0)']);
      // The first box may have split into the core, and the core may be what is left of the second: none of the three is certain.
      expect(model.result.bodies?.[0].ambiguous).toEqual([['keep/split(0)', 'box/inst(0,0)', 'box/inst(1,0)']]);
      expect(model.result.bodyIssues).toEqual([expect.objectContaining({ code: 'ambiguous-body-parts', featureId: 'keep', pieces: ['keep/split(0)', 'box/inst(0,0)', 'box/inst(1,0)'] })]);
      for (const key of ['box/inst(0,0)', 'box/inst(1,0)', 'keep/split(0)']) expect(resolve(model, key), key).toMatchObject({ status: 'ambiguous', candidates: ['box/inst(0,0)', 'keep/split(0)'] });
    });
    // The same cut of a whole body of two solids splits it, though it leaves as many solids as the body had.
    built([sketches('multi_sketch', [rect(0, 0, 40, 20), rect(50, 0, 40, 20)]), pad('multi', 'multi_sketch', 10), ...tools, keep('multi')], model => {
      expect([pieceAt(model, 2), pieceAt(model, 12)]).toEqual(['multi/split(0)', 'multi/split(1)']);
      expect(model.result.bodies?.[0].ambiguous).toBeUndefined();
    });
  });

  it('keys a mirror image\'s pieces the same whatever order the kernel listed its source\'s solids in, or reports them ambiguous', () => {
    const flip: CadFeature = { ...base('flip'), kind: 'mirror', sourceId: 'cleave', plane: 'XZ' };
    const again = [sketch('again_sketch', rect(3, -15, 2, 30)), pad('again', 'again_sketch', 20, 'cut', 'flip')];
    for (const features of [[...rod(), flip, ...again], [...rod(), row('cleave', 2, 30), { ...flip, sourceId: 'row' }, ...again]]) {
      const label = features.map(feature => feature.id).join(' '), normal = built(features, bodiesOf), reordered = reversingSolids(() => built(features, bodiesOf));
      expect(agreeInEitherOrder(normal, reordered, label), `${label}: the order changes some ambiguous key`).toBe(true);
      // Which half of the rod comes first depends on the kernel's order, so the pieces keeping faces of the halves are an order of the image,
      // each ambiguous. The piece cut off at x = 5–10 keeps no face of the mirror image, so it comes last in either order.
      const image = normal.bodies.find(body => body.key === 'flip/mirror')!, solids = normal.shapes.get('flip/mirror')!, pieces = image.pieces!;
      const last = pieces.find((_, solid) => Math.abs(solids.get(solid)![0] - 5) < 0.5), halves = pieces.filter(piece => piece !== last).sort();
      expect(last, label).toBe(`flip/mirror/split(${pieces.length - 1})`);
      expect([image.ambiguous, image.orders?.map(order => [...order.keys].sort())], label).toEqual([undefined, [halves]]);
      expect(normal.issues.filter(issue => issue.body === 'flip/mirror').map(issue => [issue.code, issue.featureId, [...issue.pieces].sort()]), label).toEqual([['ambiguous-body-parts', 'again', halves]]);
    }
  });


  it('never traces a face two solids of a source share, which goes to whichever the kernel lists first', () => {
    const oc = getOC(), builder = new oc.BRepAlgoAPI_BuilderAlgo(), args = new oc.NCollection_List_TopoDS_Shape();
    const left = makeBox([0, 0, 0], [10, 10, 10]), right = makeBox([10, 0, 0], [20, 10, 10]), slab = makeBox([8, -1, -1], [12, 11, 11]);
    args.Append(left.wrapped); args.Append(right.wrapped); builder.SetArguments(args); builder.Build();
    const raw = builder.Shape(), joined = cast(raw) as Shape3D;
    raw.delete(); builder.delete(); args.delete();
    // The boxes share their face at x = 10, and each piece of the slab across it keeps that face and no other.
    const result = cadKernelBuilders.common(joined, slab), faces = createCadKernelFaceSources();
    try {
      faces.add(joined);
      const traced = faces.trace(result);
      expect(traced).toEqual([[], []]);
      for (const rows of [traced, [...traced].reverse()]) {
        const facts = { solids: 2, removesMaterial: true, sources: [{ kind: 'target' as const }], provenance: () => rows };
        expect(cadBodyParts({ featureId: 'keep', previous: { key: 'imported' as CadBodyKey }, beforeSolids: 2, facts }))
          .toMatchObject({ pieces: ['imported/split(0)', 'imported/split(1)'], orders: [{ keys: ['imported/split(0)', 'imported/split(1)'] }] });
      }
      // Nor does a face two sources share prove either.
      const twice = createCadKernelFaceSources();
      try { twice.add(left); twice.add(left); expect(twice.trace(left)).toEqual([[]]); } finally { twice.dispose(); }
    } finally { faces.dispose(); for (const shape of [left, right, joined, slab, result]) cadKernelDisposeShape(shape); }
  });

  it('keeps an ambiguous key a later cut splits while another member\'s solid could be the one it named', () => {
    // Filleting every edge leaves the two halves keeping no face, so the kernel\'s order numbers them; the last cut splits the right half.
    const features = [...box, ...slot('split', 18, 'box'), { ...base('round'), kind: 'fillet', targetId: 'split', radius: 1 } as CadFeature, ...slot('more', 30, 'round')];
    const normal = built(features, bodiesOf), reordered = reversingSolids(() => built(features, bodiesOf));
    agreeInEitherOrder(normal, reordered, 'split round more');
    // The order decides which key the cut splits, so no key is a piece in both orders.
    const splitFrom = (result: Bodies) => result.bodies[0].pieces!.find(piece => piece.startsWith('round/split(') && piece.indexOf('/', 6) > 0)?.slice(0, 14);
    expect(new Set([splitFrom(normal), splitFrom(reordered)])).toEqual(new Set(['round/split(0)', 'round/split(1)']));
    for (const result of [normal, reordered]) {
      const pieces = [...result.bodies[0].pieces!].sort();
      for (const key of ['round/split(0)', 'round/split(1)', 'round/split(0)/split(0)', 'round/split(1)/split(1)']) {
        const resolution = resolveIn(result, key);
        expect(resolution.status === 'ambiguous' && [...resolution.candidates].sort(), key).toEqual(pieces);
      }
    }
  });

  it('resolves a key another order would have given only among what its own operations made, whichever order each operation lists', () => {
    // As above, then a pattern copies the three pieces 100 along X, a join bridges the originals into one solid, and a second pattern copies
    // everything 50 along Y. Both patterns give inst(1,0) steps, so the bridge's copy has the steps a split half's first copy would have had.
    const features = [...box, ...slot('split', 18, 'box'), { ...base('round'), kind: 'fillet', targetId: 'split', radius: 1 } as CadFeature, ...slot('more', 30, 'round'),
      twice('across', 'more', [100, 0, 0]), sketch('bridge_sketch', rect(5, 5, 30, 10)), pad('bridge', 'bridge_sketch', 10, 'join', 'across'), twice('down', 'bridge', [0, 50, 0])];
    const results = multiSolidResults(features), normal = built(features, bodiesOf);
    expect(results).toBeGreaterThanOrEqual(3);
    const keyings = new Set<string>(), all = 2 ** results - 1, alone = Array.from({ length: results }, (_, result) => 1 << result);
    // Each result's solids reversed alone, every result's but one, and all of them.
    for (const reversals of [0, ...alone, ...alone.map(result => all ^ result), all]) {
      const label = `results reversed ${reversals.toString(2).padStart(results, '0')}`;
      const reordered = reversals ? reorderingSolids((result, solids) => reversals & 1 << result ? reversed(solids) : inOrder(solids), () => built(features, bodiesOf)) : normal;
      if (reversals) agreeInEitherOrder(normal, reordered, label);
      keyings.add([...reordered.bodies[0].pieces!].sort().join(' '));
      // Either half's first copy is one of the three pieces of the first pattern's copy, 100 to 140 along X, never the bridge's copy.
      for (const key of ['round/split(0)/inst(1,0)', 'round/split(1)/inst(1,0)']) {
        const boxes = shapesFor(reordered, resolveIn(reordered, key)).map(shape => shape.slice(0, 4).map(value => Math.round(value) + 0).join(' '));
        expect(boxes.sort(), `${label}: ${key}`).toEqual(['100 118 0 20', '120 130 0 20', '132 140 0 20']);
      }
    }
    // The orders key the pieces differently, which is what the twins stand in for.
    expect(keyings.size).toBeGreaterThan(1);
  }, 120_000);

  it('resolves every key the same way in every combination of solid orders when a later cut splits a piece the faces ordered', () => {
    // As above, then a cut at x = 24 splits the first of the halves the faces ordered. No order numbers those halves the other way round, so
    // none gives the second half's key the pieces the first half split into.
    const features = [...box, ...slot('split', 18, 'box'), { ...base('round'), kind: 'fillet', targetId: 'split', radius: 1 } as CadFeature, ...slot('more', 30, 'round'),
      ...slot('again', 24, 'more')];
    const results = multiSolidResults(features), normal = built(features, bodiesOf);
    expect(results).toBe(3);
    for (let reversals = 1; reversals < 2 ** results; reversals++) {
      const reordered = reorderingSolids((result, solids) => reversals & 1 << result ? reversed(solids) : inOrder(solids), () => built(features, bodiesOf));
      agreeInEitherOrder(normal, reordered, `results reversed ${reversals.toString(2).padStart(results, '0')}`);
      for (const key of ['round/split(0)/split(1)/split(0)', 'round/split(1)/split(1)/split(0)']) expect(resolveIn(reordered, key).status, key).toBe('missing');
    }
  }, 120_000);

  it('substitutes a split\'s index only as some order of whole source solids gives it, keeping each solid\'s pieces in their order', () => {
    // A box at x = 0–40 joined to a detached island at x = 50–60 is one body of two solids. A slot at x = 18 splits the box in two, whose
    // order its faces settle, while the island may come before, between or after them. A slot at x = 8 splits the box's piece at x = 0–18,
    // which no order numbers first, so box/split(0)/split(0) is a piece in none of the 288 combinations and must be missing.
    const results = inEveryOrder([...box, sketch('island_sketch', rect(50, 0, 10, 20)), pad('island', 'island_sketch', 10, 'join', 'box'),
      ...slot('split', 18, 'island'), ...slot('again', 8, 'split')]);
    expect(results).toHaveLength(288);
    for (const result of results) expect(resolveIn(result, 'box/split(0)/split(0)')).toEqual({ status: 'missing' });
    exactInEveryOrder(results, 'island');
  }, 240_000);

  it('substitutes a mirror image\'s split index only as some order of its source\'s solids gives it', () => {
    // The box split at x = 18 and mirrored across XZ is a body of two solids in either order. Slots at x = 30 and x = 24 split the image's
    // piece at x = 20–40 and then its piece at x = 20–30, which no order numbers first.
    const across = (id: string, x: number, targetId: string) => [sketch(`${id}_sketch`, rect(x, -25, 2, 30)), pad(id, `${id}_sketch`, 10, 'cut', targetId)];
    const results = inEveryOrder([...box, ...slot('split', 18, 'box'), { ...base('flip'), kind: 'mirror', sourceId: 'split', plane: 'XZ' } as CadFeature,
      ...across('more', 30, 'flip'), ...across('again', 24, 'more')]);
    expect(results).toHaveLength(288);
    for (const result of results) for (const key of ['flip/mirror/split(0)/split(0)', 'flip/mirror/split(0)/split(1)'])
      expect(resolveIn(result, key), key).toEqual({ status: 'missing' });
    exactInEveryOrder(results, 'mirror');
  }, 240_000);

  it.each<[string, (prefix: readonly CadFeature[]) => CadFeature[]]>([
    ['a pattern of the pieces and a cut across its copy', prefix => [...prefix, twice('across', 'more', [100, 0, 0]), ...slot('again', 124, 'across')]],
    ['two more patterns after that', prefix => [...prefix, twice('across', 'more', [100, 0, 0]), ...slot('again', 124, 'across'), twice('down', 'again', [0, 50, 0]),
      twice('up', 'down', [0, 150, 0])]],
    ['a mirror image, a cut across it and a pattern', prefix => [...prefix, { ...base('flip'), kind: 'mirror', sourceId: 'more', plane: 'XZ' } as CadFeature,
      ...slot('again', 24, 'flip'), twice('across', 'again', [100, 0, 0])]]
  ])('resolves every key the same way whichever result lists its solids in reverse, after %s', (_, more) => {
    const prefix = [...box, ...slot('split', 18, 'box'), { ...base('round'), kind: 'fillet', targetId: 'split', radius: 1 } as CadFeature, ...slot('more', 30, 'round')];
    const features = more(prefix), results = multiSolidResults(features), normal = built(features, bodiesOf);
    const all = 2 ** results - 1;
    // Each result's solids reversed alone, and all of them.
    for (const reversals of [...Array.from({ length: results }, (_, result) => 1 << result), all]) {
      const reordered = reorderingSolids((result, solids) => reversals & 1 << result ? reversed(solids) : inOrder(solids), () => built(features, bodiesOf));
      agreeInEitherOrder(normal, reordered, `results reversed ${reversals.toString(2).padStart(results, '0')}`);
    }
  }, 120_000);

  it('reports a pattern copy a later cut removes as lost, so references to it resolve as missing', () => {
    built([...box, row('box', 2, 50), sketch('trim_sketch', rect(45, -5, 50, 30)), pad('trim', 'trim_sketch', 30, 'cut', 'row')], model => {
      expect(model.result.meshes[0].solidCount).toBe(1);
      expect(model.result.bodies?.[0]).toMatchObject({ key: 'box', pieces: ['box/inst(0,0)'] });
      expect(model.result.bodyIssues).toEqual([expect.objectContaining({ code: 'lost-body-parts', featureId: 'trim', pieces: ['box/inst(1,0)'] })]);
      expect(resolve(model, 'box/inst(1,0)')).toEqual({ status: 'missing' });
      expect(resolve(model, 'box/inst(0,0)')).toMatchObject({ status: 'resolved', part: 'box/inst(0,0)' });
    });
  });

  it('finds a split and a loss in one cut that leaves as many solids as before', () => {
    built([...box, row('box', 2, 50), sketches('trim_sketch', [rect(18, -5, 2, 30), rect(45, -5, 50, 30)]), pad('trim', 'trim_sketch', 30, 'cut', 'row')], model => {
      expect(model.result.meshes[0].solidCount).toBe(2);
      expect([pieceAt(model, 30), pieceAt(model, 9)]).toEqual(['box/inst(0,0)/split(0)', 'box/inst(0,0)/split(1)']);
      expect(model.result.bodyIssues).toEqual([expect.objectContaining({ code: 'lost-body-parts', featureId: 'trim', pieces: ['box/inst(1,0)'] })]);
      expect(resolve(model, 'box/inst(1,0)')).toEqual({ status: 'missing' });
    });
  });
});

describe('kernel body parts over random histories', () => {
  type Box = readonly [number, number, number, number];
  /** A step of a history: its features, the key of the body it leaves, when it makes a body, and a pattern's spacing. */
  interface Step { readonly id: string; readonly features: readonly CadFeature[]; readonly body?: string; readonly spacing?: readonly [number, number] }
  interface Snapshot { readonly key: string; readonly pieces?: readonly string[]; readonly ambiguous: readonly string[]; readonly boxes: ReadonlyMap<string, Box>; readonly bounds: Box }

  function random(seed: number) {
    return () => { seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }
  /** Each Boolean result's solids in an order of its own drawn by `rand`, so that one operation's order changes and another's need not. */
  const shuffled = (rand: () => number) => (_: number, solids: number) => {
    const order = inOrder(solids);
    for (let at = solids - 1; at > 0; at--) { const other = Math.floor(rand() * (at + 1)); [order[at], order[other]] = [order[other], order[at]]; }
    return order;
  };
  /** Each solid's box in X and Y, by the solid numbers `faceSolids` uses. */
  function solidBoxes(mesh: CadMesh): Map<number, Box> {
    const boxes = new Map<number, [number, number, number, number]>();
    mesh.faceGroups.forEach((group, index) => {
      const solid = mesh.faceSolids?.[index] ?? 0;
      for (let at = group.start; at < group.start + group.count; at++) {
        const x = mesh.positions[mesh.indices[at] * 3], y = mesh.positions[mesh.indices[at] * 3 + 1], known = boxes.get(solid);
        if (known) { known[0] = Math.min(known[0], x); known[1] = Math.max(known[1], x); known[2] = Math.min(known[2], y); known[3] = Math.max(known[3], y); }
        else boxes.set(solid, [x, x, y, y]);
      }
    });
    return boxes;
  }
  const meets = (a: Box, b: Box) => a[0] <= b[1] + 1e-6 && b[0] <= a[1] + 1e-6 && a[2] <= b[3] + 1e-6 && b[2] <= a[3] + 1e-6;
  const shifted = (box: Box, dx: number, dy: number): Box => [box[0] + dx, box[1] + dx, box[2] + dy, box[3] + dy];

  /** The body every history starts from, keyed `box`: a box, or a disc, whose split pieces keep no face of it. */
  const disc = [sketch('box_sketch', { kind: 'circle', x: 20, y: 10, radius: 12 }), pad('box', 'box_sketch', 10)];

  /** A random pattern, split, cut, join, pocket, mirror or intersection of the body feature `target`, aimed inside the body before or at an ambiguous piece. */
  function nextStep(rand: () => number, id: string, target: string, before: Snapshot, patterns: number): Step {
    const unsure = before.pieces?.filter(key => before.ambiguous.includes(key)) ?? [];
    const kinds = ['split', 'cut', 'join', 'pocket', 'mirror', 'intersect', ...patterns < 2 ? ['pattern'] as const : [], ...unsure.length ? ['split-piece'] as const : []] as const;
    const kind = kinds[Math.floor(rand() * kinds.length)], at = (low: number, high: number) => Math.round((low + rand() * (high - low)) * 2) / 2;
    const bounds = before.bounds, x = () => at(bounds[0] - 2, bounds[1] + 2), y = () => at(bounds[2] - 2, bounds[3] + 2), size = (low: number, high: number) => at(low, high);
    // Now and then a cut takes one piece away whole, or a join bridges two pieces, as random blocks seldom do.
    const boxes = before.pieces ? [...before.boxes.values()] : [], piece = () => boxes[Math.floor(rand() * boxes.length)];
    const around = (box: Box, margin: number) => {
      const left = Math.floor(box[0] * 2) / 2 - margin, bottom = Math.floor(box[2] * 2) / 2 - margin;
      return rect(left, bottom, Math.ceil(box[1] * 2) / 2 + margin - left, Math.ceil(box[3] * 2) / 2 + margin - bottom);
    };
    const aimed = boxes.length > 1 && rand() < 0.5, centre = (box: Box): Box => [(box[0] + box[1]) / 2, (box[0] + box[1]) / 2, (box[2] + box[3]) / 2, (box[2] + box[3]) / 2];
    switch (kind) {
      case 'pattern': {
        const spacing = ([[50, 0], [0, 30], [25, 0], [0, 12]] as const)[Math.floor(rand() * 4)];
        return { id, spacing: [spacing[0], spacing[1]], features: [{ ...base(id), kind: 'linear-pattern', sourceId: target, count: 2, spacing: [spacing[0], spacing[1], 0] }] };
      }
      case 'split': {
        // One to three parallel slots across the body, so that a piece between two slots keeps no face of the body before.
        const across = rand() < 0.5, width = size(1, 3), count = 1 + Math.floor(rand() * 3), slots: Geometry[] = [];
        for (let k = 0, from = across ? x() : y(); k < count; k++, from += width + size(3, 12))
          slots.push(across ? rect(from, bounds[2] - 10, width, bounds[3] - bounds[2] + 20) : rect(bounds[0] - 10, from, bounds[1] - bounds[0] + 20, width));
        return { id, features: [sketches(`${id}_sketch`, slots), pad(id, `${id}_sketch`, 30, 'cut', target)] };
      }
      case 'split-piece': {
        // One slot through the middle of an ambiguous piece, which splits it while the rest of its group stays, whichever key it has.
        const box = before.boxes.get(unsure[Math.floor(rand() * unsure.length)])!, width = size(1, 2), middle = Math.round(box[0] + box[1]) / 2, bottom = Math.floor(box[2]) - 1;
        return { id, features: [sketch(`${id}_sketch`, rect(middle - width / 2, bottom, width, Math.ceil(box[3]) + 1 - bottom)), pad(id, `${id}_sketch`, 30, 'cut', target)] };
      }
      case 'cut': return { id, features: [sketch(`${id}_sketch`, aimed ? around(piece(), 0.5) : rect(x(), y(), size(5, 40), size(5, 40))), pad(id, `${id}_sketch`, 30, 'cut', target)] };
      case 'join': {
        const bridge = (a: Box, b: Box): Box => [Math.min(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[3], b[3])];
        const profiles = aimed ? [around(bridge(centre(piece()), centre(piece())), 1)] : Array.from({ length: 1 + Math.floor(rand() * 2) }, () => rect(x(), y(), size(3, 30), size(3, 30)));
        return { id, features: [sketches(`${id}_sketch`, profiles), pad(id, `${id}_sketch`, rand() < 0.5 ? 5 : 10, 'join', target)] };
      }
      case 'pocket': return { id, features: pocket(id, x(), y(), target) };
      // A mirror image is a body of its own, which the rest of the history follows.
      case 'mirror': return { id, body: `${id}/mirror`, features: [{ ...base(id), kind: 'mirror', sourceId: target, plane: rand() < 0.5 ? 'YZ' : 'XZ' }] };
      case 'intersect': {
        // One or two blocks of another body, through the body's height or wholly inside it, so that a block kept may keep no face of the body.
        const inside = rand() < 0.5, tool = `${id}_tool`, profiles = Array.from({ length: 1 + Math.floor(rand() * 2) }, () => rect(x(), y(), size(3, 30), size(3, 30)));
        return { id, features: [sketches(`${tool}_sketch`, profiles, inside ? 2 : -1), pad(tool, `${tool}_sketch`, inside ? 6 : 12),
          { ...base(id), kind: 'boolean', targetId: target, toolId: tool, operation: 'intersect' }] };
      }
    }
  }

  function snapshot(model: CadKernelModel, key: string): Snapshot {
    const body = model.result.bodies!.find(each => each.key === key)!, mesh = model.result.meshes.find(each => each.bodyKey === key)!, boxes = new Map<string, Box>(), solids = solidBoxes(mesh);
    const all = [...solids.values()], bounds: Box = [Math.min(...all.map(box => box[0])), Math.max(...all.map(box => box[1])), Math.min(...all.map(box => box[2])), Math.max(...all.map(box => box[3]))];
    if (body.pieces) for (const [solid, box] of solids) boxes.set(body.pieces[solid], box);
    else boxes.set(body.key, bounds);
    return { key, pieces: body.pieces, ambiguous: body.ambiguous?.flat() ?? [], boxes, bounds };
  }

  /** Checks one step's body against the one before: unique keys, certain or reported lineage, inherited ambiguity, and reported losses resolving as missing. */
  function check(model: CadKernelModel, step: Step, before: Snapshot, lost: Set<string>, seen: Set<string>, label: string): Snapshot {
    const after = snapshot(model, step.body ?? before.key), issues = model.result.bodyIssues ?? [], keys = model.result.bodies!.map(each => each.key);
    expect(new Set(keys).size, label).toBe(keys.length);
    expect(isCadKernelReply({ id: 1, kind: 'built', result: structuredClone(model.result) }), label).toBe(true);
    for (const key of lost) expect(resolve(model, key), `${label}: lost ${key}`).toEqual({ status: 'missing' });
    if (step.body) {
      // A mirror image starts whole, whatever parts its source had.
      expect([after.pieces, after.ambiguous], label).toEqual([undefined, []]);
      seen.add('mirror');
      return after;
    }
    const reported = (code: string) => new Set<string>(issues.filter(issue => issue.code === code && issue.body === after.key).flatMap(issue => issue.pieces));
    const ambiguousReported = reported('ambiguous-body-parts'), lostNow: readonly string[] = issues.filter(issue => issue.code === 'lost-body-parts' && issue.featureId === step.id).flatMap(issue => issue.pieces);
    for (const key of lostNow) lost.add(key);
    if (lostNow.length) seen.add('lost');
    if (issues.some(issue => issue.code === 'ambiguous-body-parts' && issue.featureId === step.id)) seen.add('ambiguous');
    if (after.ambiguous.some(key => !after.pieces?.includes(key as CadBodyKey))) seen.add('unidentified');
    if (step.features.at(-1)?.kind === 'boolean') seen.add('intersect');
    if (before.pieces) expect(after.pieces, label).toBeDefined();
    const pieces: readonly string[] = after.pieces ?? [], uncertain = new Set<string>(after.ambiguous);
    expect(new Set([...pieces, after.key]).size, `${label}: repeated key`).toBe(pieces.length + 1);
    for (const key of after.ambiguous) expect(ambiguousReported.has(key), `${label}: ${key} is ambiguous but not reported`).toBe(true);
    const previous = before.pieces ?? [before.key];
    for (const key of pieces) {
      expect(lost.has(key), `${label}: lost ${key} came back`).toBe(false);
      if (key.startsWith(`${step.id}/`)) { expect(key, label).toMatch(new RegExp(`^${step.id}/split\\(\\d+\\)$`)); seen.add('fresh'); continue; }
      const parent = previous.filter(earlier => key === earlier || key.startsWith(`${earlier}/`)).sort((a, b) => b.length - a.length)[0];
      expect(parent, `${label}: ${key} descends from no key before`).toBeDefined();
      const rest = key === parent ? [] : key.slice(parent.length + 1).split('/'), copy = /^inst\((\d+),0\)$/.exec(rest[0] ?? '');
      expect(rest.length <= (copy ? 2 : 1) && rest.slice(copy ? 1 : 0).every(segment => /^split\(\d+\)$/.test(segment)), `${label}: ${key} after ${parent}`).toBe(true);
      if (rest.length) seen.add(copy ? 'copy' : 'split');
      // Ambiguity carries to the pieces that keep or extend an ambiguous key.
      if (before.ambiguous.includes(parent)) { expect(uncertain.has(key), `${label}: ${key} descends from ambiguous ${parent}`).toBe(true); seen.add('inherited'); }
      if (uncertain.has(key)) continue;
      const i = copy ? Number(copy[1]) : 0, [dx, dy] = step.spacing ?? [0, 0];
      expect(meets(after.boxes.get(key)!, shifted(before.boxes.get(parent)!, i * dx, i * dy)), `${label}: ${key} lies away from ${parent}`).toBe(true);
    }
    // No piece before disappears silently: each is continued, reported lost or left unidentified.
    for (const earlier of before.pieces ?? []) {
      const kept = pieces.some(key => key === earlier || key.startsWith(`${earlier}/`));
      expect(kept || lostNow.includes(earlier) || uncertain.has(earlier), `${label}: ${earlier} vanished unreported`).toBe(true);
    }
    return after;
  }

  it('never repeats a key, inherits only certain lineage, keys solids the same in either solid order and reports every loss', () => {
    let steps = 0;
    const seen = new Set<string>();
    for (let seed = 1; seed <= 16; seed++) {
      const rand = random(seed), features: CadFeature[] = [...seed % 2 ? box : disc], lost = new Set<string>();
      let before = built(features, model => snapshot(model, 'box')), target = 'box', patterns = 0, last: CadFeature[] = features;
      for (let n = 0, tries = 0; n < 5 && tries < 12; tries++) {
        const step = nextStep(rand, `s${n}`, target, before, patterns), candidate = [...features, ...step.features];
        let parsed: CadDocument;
        // Overlapping profiles are refused before the kernel; such a step is drawn again.
        try { parsed = document(candidate); } catch { continue; }
        const model = buildCadKernelModel(parsed), label = `seed ${seed}, step ${n}: ${JSON.stringify(step.features.at(-1))}`;
        let normal: Bodies;
        try {
          // A step the kernel refuses, or that removes the whole body, is drawn again.
          if (model.result.diagnostics.length || !model.result.meshes.some(mesh => mesh.bodyKey === (step.body ?? before.key))) continue;
          before = check(model, step, before, lost, seen, label);
          normal = bodiesOf(model);
        } finally { model.dispose(); }
        // The same history built twice more, each Boolean listing its solids in an order of its own, keys the same solids or reports them ambiguous.
        for (const draw of [1, 2]) {
          const reordered = reorderingSolids(shuffled(random(seed * 4096 + n * 4 + draw)), () => built(candidate, bodiesOf));
          if (agreeInEitherOrder(normal, reordered, `${label}, order ${draw}`)) seen.add('reordered');
        }
        features.push(...step.features); target = step.id; last = candidate; n++; steps++;
        if (step.spacing) patterns++;
      }
      // A rebuild derives the same bodies and issues.
      const first = built(last, model => structuredClone([model.result.bodies, model.result.bodyIssues]));
      expect(built(last, model => structuredClone([model.result.bodies, model.result.bodyIssues])), `seed ${seed}`).toEqual(first);
    }
    // The histories reach every case the rule distinguishes.
    expect(steps).toBeGreaterThanOrEqual(40);
    expect([...seen].sort()).toEqual(['ambiguous', 'copy', 'fresh', 'inherited', 'intersect', 'lost', 'mirror', 'reordered', 'split', 'unidentified']);
  }, 480_000);
});
