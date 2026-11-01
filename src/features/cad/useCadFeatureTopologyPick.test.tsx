import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createCadDocument } from '@/domain/cad/cadSchema';
import type { CadFeatureInputSnapshot } from './cadFeatureInput';
import type { CadFeatureTopologyPickCommand } from './cadFeatureReferencePicking';
import type { CadTopologyResolvePicksResult } from '@/domain/cad/cadTopology';
import { CadTangentContours, type CadTopologyAdjacency, type CadTopologyTangentChain } from '@/domain/cad/cadTopologyAdjacency';
import { CAD_TOPOLOGY_LONE_EDGE_NOTE } from '@/domain/cad/selection/cadTopologySelection';
import { useCadFeatureTopologyPick, type CadFeatureInputPicking } from './useCadFeatureTopologyPick';

let root: Root, host: HTMLDivElement, picker: ReturnType<typeof useCadFeatureTopologyPick>;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: Error) => void;
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; }); return { promise, resolve, reject };
}
const chainOf = (edgeKey: string, edges: readonly string[], native = true): CadTopologyTangentChain => ({ bodyId: 'pad', buildId: 'input-build', edgeKey, edges: [...edges], closed: false, native });
async function mount(more: readonly string[] = []) {
  const document = createCadDocument('Owned input', 'owned-input');
  const source: CadFeatureInputSnapshot = { inputToken: 'input', documentId: document.id, version: 'v1', featureId: 'fillet', bodyId: 'pad', parameterValues: {}, document,
    result: { buildId: 'input-build', diagnostics: [], durationMs: 0, meshes: [{ featureId: 'pad', name: 'Pad', volume: 20,
      positions: [], normals: [], indices: [], edges: [], faceGroups: [{ key: 'top', start: 0, count: 3 }], edgeGroups: ['a', 'b', ...more].map((key, index) => ({ key, start: 2 * index, count: 2 })), bounds: { min: [0, 0, 0], max: [5, 4, 1] } }] } };
  const command: CadFeatureTopologyPickCommand = { kind: 'pick-topology', owner: 'form', expectedVersion: 'v1', label: 'Edges', purpose: 'fillet', request: { featureId: 'fillet', bodyId: 'pad' }, onSelect: vi.fn(), onCancel: vi.fn() };
  const result: CadTopologyResolvePicksResult = { purpose: 'fillet', bodyId: 'pad', buildId: 'input-build', selection: { expectedCount: 1, queries: [{ kind: 'edges', expectedCount: 1, predicates: [{ kind: 'line-endpoints', start: [0, 0, 0], end: [5, 0, 0] }] }] } };
  const resolution = deferred<CadTopologyResolvePicksResult>();
  // Edges a and b run on in one straight line along the top face, and native fillet treats them as one tangent chain.
  const adjacency: CadTopologyAdjacency = { bodyId: 'pad', buildId: 'input-build', edges: ['a', 'b'], edgeFaces: [0, -1, 0, -1], edgeSmooth: [false, false], faces: ['top'], faceLoops: [[[0, 1]]] };
  const operations = { build: vi.fn(async () => source), inspect: vi.fn<CadFeatureInputPicking['inspect']>(), resolve: vi.fn<CadFeatureInputPicking['resolve']>(() => resolution.promise), release: vi.fn(),
    adjacency: vi.fn<NonNullable<CadFeatureInputPicking['adjacency']>>(async () => adjacency),
    tangentChain: vi.fn<NonNullable<CadFeatureInputPicking['tangentChain']>>(async (_token, request) => chainOf(request.edgeKey, ['a', 'b'])) } satisfies CadFeatureInputPicking;
  function Harness({ active, version }: { active: boolean; version: string }) { picker = useCadFeatureTopologyPick(active ? command : null, document, version, operations); return null; }
  const render = async (active = true, version = 'v1') => { await act(async () => root.render(<Harness {...{ active, version }} />)); };
  await render(); return { command, source, result, resolution, operations, render };
}

it('picks only exact input keys, retains installed meshes, and resolves the explicit set once', async () => {
  const h = await mount(), installed = picker.meshes;
  await act(async () => picker.pick({ bodyId: 'pad', pick: { kind: 'edge', key: 'unknown' } }, false));
  expect(picker.selection).toBeNull(); expect(picker.error).toContain('does not belong');
  await act(async () => picker.pick({ bodyId: 'pad', pick: { kind: 'edge', key: 'a' } }, false));
  await act(async () => picker.pick({ bodyId: 'pad', pick: { kind: 'edge', key: 'b' } }, true));
  await act(async () => picker.pick({ bodyId: 'pad', pick: { kind: 'edge', key: 'a' } }, true));
  expect(picker.meshes).toBe(installed); expect(picker.selection?.picks).toEqual([{ kind: 'edge', key: 'b' }]);
  let pending!: Promise<void>;
  await act(async () => { pending = picker.finish(); void picker.finish(); });
  expect(h.operations.resolve).toHaveBeenCalledOnce(); expect(h.command.onSelect).not.toHaveBeenCalled();
  expect(h.operations.resolve).toHaveBeenCalledWith('input', { bodyId: 'pad', expectedBuildId: 'input-build', purpose: 'fillet', picks: [{ kind: 'edge', key: 'b' }] }, 'v1', expect.any(AbortSignal));
  await act(async () => { h.resolution.resolve(h.result); await pending; });
  expect(h.command.onSelect).toHaveBeenCalledExactlyOnceWith(h.result);
});

it('selects native tangent chains and adjacency loops, each read once for the input, adding them with Ctrl', async () => {
  const h = await mount(), keys = () => picker.selection?.picks.map(pick => pick.key).sort();
  await act(async () => picker.chain({ bodyId: 'pad', pick: { kind: 'edge', key: 'a' } }, 'tangent', false, null));
  expect(keys()).toEqual(['a', 'b']); expect(h.operations.adjacency).not.toHaveBeenCalled();
  expect(h.operations.tangentChain).toHaveBeenCalledExactlyOnceWith('input', { bodyId: 'pad', expectedBuildId: 'input-build', edgeKey: 'a' }, 'v1', expect.any(AbortSignal));
  await act(async () => picker.set('pad', [{ kind: 'edge', key: 'b' }]));
  expect(keys()).toEqual(['b']);
  await act(async () => picker.chain({ bodyId: 'pad', pick: { kind: 'edge', key: 'b' } }, 'loop', true, 'top'));
  expect(keys()).toEqual(['a', 'b']);
  expect(h.operations.adjacency).toHaveBeenCalledExactlyOnceWith('input', { bodyId: 'pad', expectedBuildId: 'input-build' }, 'v1', expect.any(AbortSignal));
  await act(async () => picker.chain({ bodyId: 'pad', pick: { kind: 'edge', key: 'a' } }, 'tangent', false, null));
  await act(async () => picker.chain({ bodyId: 'pad', pick: { kind: 'edge', key: 'b' } }, 'loop', false, 'top'));
  expect(h.operations.tangentChain).toHaveBeenCalledOnce(); expect(h.operations.adjacency).toHaveBeenCalledOnce();
  // Where the builders make no contour, the chain is the edge alone and the picker says so until the next pick.
  h.operations.tangentChain.mockResolvedValueOnce(chainOf('b', ['b'], false));
  await act(async () => picker.chain({ bodyId: 'pad', pick: { kind: 'edge', key: 'b' } }, 'tangent', false, null));
  expect(keys()).toEqual(['b']); expect(picker.notice).toBe(CAD_TOPOLOGY_LONE_EDGE_NOTE);
  await act(async () => picker.pick({ bodyId: 'pad', pick: { kind: 'edge', key: 'a' } }, true));
  expect(picker.notice).toBeNull();
  // Both reads go with the input they belong to: shown again, it reads afresh.
  await h.render(false); await h.render(true);
  await act(async () => picker.chain({ bodyId: 'pad', pick: { kind: 'edge', key: 'a' } }, 'tangent', false, null));
  await act(async () => picker.chain({ bodyId: 'pad', pick: { kind: 'edge', key: 'b' } }, 'loop', false, 'top'));
  expect(h.operations.tangentChain).toHaveBeenCalledTimes(3); expect(h.operations.adjacency).toHaveBeenCalledTimes(2);
  // Faces are not what this input asks for, and a stale picker changes nothing.
  await act(async () => picker.chain({ bodyId: 'pad', pick: { kind: 'face', key: 'top' } }, 'tangent', false, null));
  expect(keys()).toEqual(['a', 'b']); expect(picker.error).toContain('Choose edges');
  const previous = picker; await h.render(true, 'v2');
  await act(async () => previous.chain({ bodyId: 'pad', pick: { kind: 'edge', key: 'a' } }, 'loop', false, 'top'));
  expect(picker.selection).toBeNull(); expect(h.operations.adjacency).toHaveBeenCalledTimes(2);
});

it('refuses a chain longer than a selection holds, or too long to add, without keeping it or changing the picks', async () => {
  const more = Array.from({ length: 64 }, (_, index) => `e${index}`), h = await mount(more), keys = () => picker.selection?.picks.length;
  // The contours the picker's chain cache stores, read from the store it shares them in.
  const share = vi.spyOn(CadTangentContours.prototype, 'share'), stored = () => (share.mock.contexts[0] as CadTangentContours | undefined)?.size;
  try {
    // Edge a's chain runs on through the 64 other edges, one more than a selection holds; edge b's chain is two edges.
    h.operations.tangentChain.mockImplementation(async (_token, request) => chainOf(request.edgeKey, request.edgeKey === 'a' ? ['a', ...more] : ['b', 'e63']));
    await act(async () => picker.chain({ bodyId: 'pad', pick: { kind: 'edge', key: 'a' } }, 'tangent', false, null));
    expect(picker.selection).toBeNull(); expect(picker.error).toContain('at most 64'); expect(stored()).toBe(0);
    await act(async () => picker.chain({ bodyId: 'pad', pick: { kind: 'edge', key: 'a' } }, 'tangent', false, null));
    expect(h.operations.tangentChain).toHaveBeenCalledTimes(2);
    // Added to 63 picks, edge b's chain, disjoint from them, would make 65: the picks stay and its contour is not stored. The next chain
    // on b reads again and, replacing the picks, is kept with its contour.
    await act(async () => picker.set('pad', more.slice(0, 63).map(key => ({ kind: 'edge', key }))));
    await act(async () => picker.chain({ bodyId: 'pad', pick: { kind: 'edge', key: 'b' } }, 'tangent', true, null));
    expect(keys()).toBe(63); expect(picker.error).toContain('at most 64'); expect(stored()).toBe(0);
    await act(async () => picker.chain({ bodyId: 'pad', pick: { kind: 'edge', key: 'b' } }, 'tangent', false, null));
    await act(async () => picker.chain({ bodyId: 'pad', pick: { kind: 'edge', key: 'b' } }, 'tangent', false, null));
    expect(keys()).toBe(2); expect(picker.error).toBeNull(); expect(h.operations.tangentChain).toHaveBeenCalledTimes(4); expect(stored()).toBe(1);
    expect(new Set(share.mock.contexts)).toHaveProperty('size', 1);
  } finally { share.mockRestore(); }
});

it('drops a chain answered after a later pick, clear or chain, and its failure too', async () => {
  const h = await mount(), keys = () => picker.selection?.picks.map(pick => pick.key).sort();
  const reads: ReturnType<typeof deferred<CadTopologyAdjacency>>[] = [];
  h.operations.adjacency.mockImplementation(() => { const read = deferred<CadTopologyAdjacency>(); reads.push(read); return read.promise; });
  const adjacency: CadTopologyAdjacency = { bodyId: 'pad', buildId: 'input-build', edges: ['a', 'b'], edgeFaces: [0, -1, 0, -1], edgeSmooth: [false, false], faces: ['top'], faceLoops: [[[0, 1]]] };
  // A chain waits for the adjacency; meanwhile edge b is picked alone. The late chain leaves that pick as it is.
  await act(async () => picker.chain({ bodyId: 'pad', pick: { kind: 'edge', key: 'a' } }, 'loop', false, 'top'));
  await act(async () => picker.pick({ bodyId: 'pad', pick: { kind: 'edge', key: 'b' } }, false));
  await act(async () => reads[0].resolve(adjacency));
  expect(keys()).toEqual(['b']);
  // The read is kept for the input; a chain after a clear applies, and one overtaken by a second chain does not.
  await act(async () => picker.pick(null, false));
  await act(async () => picker.chain({ bodyId: 'pad', pick: { kind: 'edge', key: 'a' } }, 'loop', false, 'top'));
  expect(keys()).toEqual(['a', 'b']); expect(h.operations.adjacency).toHaveBeenCalledOnce();
  await act(async () => { picker.chain({ bodyId: 'pad', pick: { kind: 'edge', key: 'a' } }, 'loop', false, 'top'); picker.pick(null, false); });
  expect(picker.selection).toBeNull();
  // A failed read that a later pick has overtaken shows no error.
  const failing = await mount(), failed = deferred<CadTopologyAdjacency>();
  failing.operations.adjacency.mockImplementation(() => failed.promise.then(() => { throw new Error('The adjacency read failed.'); }));
  await act(async () => picker.chain({ bodyId: 'pad', pick: { kind: 'edge', key: 'a' } }, 'loop', false, 'top'));
  await act(async () => picker.pick({ bodyId: 'pad', pick: { kind: 'edge', key: 'b' } }, false));
  await act(async () => failed.resolve(adjacency));
  expect(picker.error).toBeNull(); expect(keys()).toEqual(['b']);
});

it('drops a chain still being read once the picks are accepted, whether it answers or fails, and after a failed conversion too', async () => {
  let h = await mount();
  const keys = () => picker.selection?.picks.map(pick => pick.key), reads: ReturnType<typeof deferred<CadTopologyTangentChain>>[] = [];
  const pending = () => { const read = deferred<CadTopologyTangentChain>(); reads.push(read); return read.promise; };
  // The chain answers while its picks are being converted, and the conversion then fails: the selection stays what was accepted.
  h.operations.tangentChain.mockImplementation(pending);
  await act(async () => picker.pick({ bodyId: 'pad', pick: { kind: 'edge', key: 'a' } }, false));
  await act(async () => picker.chain({ bodyId: 'pad', pick: { kind: 'edge', key: 'a' } }, 'tangent', false, null));
  let accepted!: Promise<void>; await act(async () => { accepted = picker.finish(); });
  expect(h.operations.resolve).toHaveBeenCalledWith('input', expect.objectContaining({ picks: [{ kind: 'edge', key: 'a' }] }), 'v1', expect.any(AbortSignal));
  await act(async () => reads[0].resolve(chainOf('a', ['a', 'b'])));
  expect(keys()).toEqual(['a']);
  await act(async () => { h.resolution.reject(new Error('The conversion failed.')); await accepted; });
  expect(picker.busy).toBe(false); expect(picker.error).toContain('The conversion failed.'); expect(keys()).toEqual(['a']);
  // A chain that fails while its picks are being converted shows nothing, and the conversion goes on to finish.
  h = await mount(); h.operations.tangentChain.mockImplementation(pending);
  await act(async () => picker.pick({ bodyId: 'pad', pick: { kind: 'edge', key: 'a' } }, false));
  await act(async () => picker.chain({ bodyId: 'pad', pick: { kind: 'edge', key: 'a' } }, 'tangent', false, null));
  await act(async () => { accepted = picker.finish(); });
  await act(async () => reads[1].reject(new Error('The chain read failed.')));
  expect(picker.error).toBeNull(); expect(picker.busy).toBe(true);
  await act(async () => { h.resolution.resolve(h.result); await accepted; });
  expect(h.command.onSelect).toHaveBeenCalledExactlyOnceWith(h.result);
});

it('cancels an in-flight conversion and releases only its input without changing the feature', async () => {
  const h = await mount(); await act(async () => picker.pick({ bodyId: 'pad', pick: { kind: 'edge', key: 'a' } }, false));
  let pending!: Promise<void>; await act(async () => { pending = picker.finish(); });
  const signal = h.operations.resolve.mock.calls[0][3]; await h.render(false);
  expect(signal.aborted).toBe(true); expect(h.operations.release).toHaveBeenCalledExactlyOnceWith('input');
  await act(async () => { h.resolution.resolve(h.result); await pending; });
  expect(h.command.onSelect).not.toHaveBeenCalled(); expect(picker.source).toBeNull(); expect(picker.meshes).toEqual([]);
});

it('immediately hides a stale input and rejects retained point callbacks when its version changes', async () => {
  const h = await mount(), previous = picker;
  await h.render(true, 'v2');
  expect(picker.source).toBeNull(); expect(h.operations.build).toHaveBeenCalledOnce(); expect(h.operations.release).toHaveBeenCalledExactlyOnceWith('input');
  await act(async () => previous.pick({ bodyId: 'pad', pick: { kind: 'edge', key: 'a' } }, false));
  expect(picker.selection).toBeNull(); expect(h.operations.resolve).not.toHaveBeenCalled();
});
