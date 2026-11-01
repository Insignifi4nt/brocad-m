import { expect, it, vi } from 'vitest';
import type { CadBuildResult, CadDocument } from '@/domain/cad/cadDocument';
import { createCadDocument, parseCadDocument } from '@/domain/cad/cadSchema';
import { applyCadEdits } from '@/domain/cad/cadOperations';
import { CadError } from '@/domain/cad/cadError';
import { createBrowserCacheAdapter } from '@/domain/storage/browserCacheAdapter';
import type { CadTopologyInspectResult, CadTopologyResolvePicksRequest, CadTopologyResolvePicksResult } from '@/domain/cad/cadTopology';
import { CadSession } from './cadSession';
import { createCadFeatureInputCoordinator } from './cadFeatureInput';

const part = parseCadDocument({ ...createCadDocument('Repick', 'repick'), parameters: { depth: 10 }, features: [
  { kind: 'sketch', id: 'outline', name: 'Outline', suppressed: false, plane: 'XY', offset: 0,
    profiles: [{ id: 'rect', name: 'Rectangle', construction: false, geometry: { kind: 'rectangle', x: 0, y: 0, width: 20, height: 10, cornerRadius: 0 } }] },
  { kind: 'extrude', id: 'pad', name: 'Pad', suppressed: false, sketchId: 'outline', distance: ' depth ', symmetric: false, operation: 'new', targetId: null },
  { kind: 'fillet', id: 'round', name: 'Round', suppressed: false, targetId: 'pad', radius: ' 1.00 ', selection: null },
  { kind: 'transform', id: 'after', name: 'After', suppressed: false, sourceId: 'round', translation: [1, 0, 0], rotation: [0, 0, 0] },
] });
const built = (buildId = 'input-build'): CadBuildResult => ({ buildId, durationMs: 1, diagnostics: [], meshes: [{
  featureId: 'pad', name: 'Pad', positions: [], normals: [], indices: [], edges: [], faceGroups: [], edgeGroups: [], volume: 3000,
  bounds: { min: [0, 0, 0], max: [20, 10, 15] },
}] });
function fixture() {
  const session = new CadSession(part), before = session.getSnapshot();
  let storage = createBrowserCacheAdapter(localStorage, { namespace: 'feature-input' });
  const kernel = { build: vi.fn(async (_document: CadDocument, _signal?: AbortSignal) => built()), dispose: vi.fn(),
    topologyAdjacency: vi.fn(async () => ({ bodyId: 'pad', buildId: 'input-build', edges: [], edgeFaces: [], edgeSmooth: [], faces: [], faceLoops: [] })),
    topologyTangentChain: vi.fn(async () => ({ bodyId: 'pad', buildId: 'input-build', edgeKey: 'e1', edges: ['e1'], closed: false, native: true })),
    inspectTopology: vi.fn(async (): Promise<CadTopologyInspectResult> => ({ bodyId: 'pad', buildId: 'input-build', descriptors: [], total: 0, nextOffset: null })),
    resolveTopologyPicks: vi.fn(async (_document: CadDocument, _request: CadTopologyResolvePicksRequest, _signal?: AbortSignal): Promise<CadTopologyResolvePicksResult> => ({ bodyId: 'pad', buildId: 'input-build', purpose: 'fillet', selection: {
      expectedCount: 1, queries: [{ kind: 'edges', expectedCount: 1, predicates: [{ kind: 'line-endpoints', start: [0, 0, 0], end: [20, 0, 0] }] }],
    } })),
  };
  const createKernel = vi.fn(async () => kernel), prepare = vi.fn(async (document: CadDocument, edits: Parameters<typeof applyCadEdits>[1]) => applyCadEdits(document, edits));
  const input = createCadFeatureInputCoordinator({ createKernel, prepare, assertCurrent(version, scope) {
    session.assertVersion(version); session.assertWorkflowClosed(scope);
    return { document: session.getSnapshot().document, storage };
  } });
  return { input, session, before, kernel, createKernel, prepare, switchStorage() { storage = createBrowserCacheAdapter(localStorage, { namespace: 'other-input' }); } };
}
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('Deferred missing'); };
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}

it('builds only the exact edited input with pending parameters, then inspects and resolves on that same snapshot', async () => {
  const h = fixture();
  const snapshot = await h.input.build({ featureId: 'round', bodyId: 'pad', parameterValues: { depth: 15 } }, h.before.version);
  expect(snapshot).toMatchObject({ inputToken: expect.any(String), documentId: 'repick', version: h.before.version, featureId: 'round', bodyId: 'pad', parameterValues: { depth: 15 } });
  expect(snapshot.document.features).toEqual(part.features.slice(0, 2));
  expect(snapshot.document.parameters).toEqual({ depth: 15 });
  expect(h.kernel.build).toHaveBeenCalledWith(snapshot.document, expect.any(AbortSignal));
  const request = { bodyId: 'pad', expectedBuildId: snapshot.result.buildId, selection: { kind: 'page' as const, topology: 'edge' as const, offset: 0, limit: 10 } };
  await h.input.inspect(request, h.before.version, undefined, undefined, snapshot.inputToken);
  expect(h.kernel.inspectTopology).toHaveBeenCalledWith(snapshot.document, request, h.kernel.build.mock.calls[0][1]);
  // A native tangent chain is read from the same snapshot, on the input's own worker.
  const chain = { bodyId: 'pad', expectedBuildId: snapshot.result.buildId, edgeKey: 'e1' };
  await expect(h.input.tangentChain(chain, h.before.version, undefined, undefined, snapshot.inputToken)).resolves.toMatchObject({ edgeKey: 'e1', edges: ['e1'], native: true });
  expect(h.kernel.topologyTangentChain).toHaveBeenCalledWith(snapshot.document, chain, h.kernel.build.mock.calls[0][1]);
  const resolved = await h.input.resolve({ bodyId: 'pad', expectedBuildId: snapshot.result.buildId, purpose: 'fillet', picks: [{ kind: 'edge', key: 'edge_1' }] }, h.before.version, undefined, undefined, snapshot.inputToken);
  expect(resolved).toMatchObject({ purpose: 'fillet', selection: { expectedCount: 1 } });
  expect(h.session.getSnapshot()).toBe(h.before);
  expect(h.before.document.features[1]).toMatchObject({ distance: ' depth ' });
  expect(h.before.document.features[2]).toMatchObject({ radius: ' 1.00 ' });
  h.input.dispose();
});

it('cancels a deferred input without publishing it, and an old token cannot clear its replacement', async () => {
  const h = fixture(), pending = deferred<CadBuildResult>(), cancellation = new AbortController();
  h.kernel.build.mockReturnValueOnce(pending.promise);
  const obsolete = h.input.build({ featureId: 'round', bodyId: 'pad' }, h.before.version, cancellation.signal);
  await vi.waitFor(() => expect(h.kernel.build).toHaveBeenCalledOnce());
  cancellation.abort();
  const rejected = expect(obsolete).rejects.toMatchObject({ name: 'AbortError' });
  const next = await h.input.build({ featureId: 'round', bodyId: 'pad' }, h.before.version);
  pending.resolve(built('obsolete')); await rejected;
  h.input.clear('obsolete-token');
  await h.input.inspect({ bodyId: 'pad', expectedBuildId: 'input-build', selection: { kind: 'page', topology: 'edge', offset: 0, limit: 10 } }, h.before.version, undefined, undefined, next.inputToken);
  expect(h.kernel.dispose).toHaveBeenCalledOnce();
  h.input.clear(next.inputToken); await Promise.resolve(); expect(h.kernel.dispose).toHaveBeenCalledTimes(2);
});

it('pins body/build/purpose and releases the input when source or storage changes during a read', async () => {
  const h = fixture(), snapshot = await h.input.build({ featureId: 'round', bodyId: 'pad' }, h.before.version);
  const request = { bodyId: 'pad', expectedBuildId: 'input-build', selection: { kind: 'page' as const, topology: 'edge' as const, offset: 0, limit: 10 } };
  await expect(h.input.inspect({ ...request, expectedBuildId: 'accepted-build' }, h.before.version, undefined, undefined, snapshot.inputToken)).rejects.toMatchObject({ code: 'STALE_FEATURE_INPUT' });
  await expect(h.input.resolve({ bodyId: 'pad', expectedBuildId: 'input-build', purpose: 'shell', picks: [{ kind: 'face', key: 'face' }] }, h.before.version, undefined, undefined, snapshot.inputToken)).rejects.toMatchObject({ code: 'INVALID_FEATURE_INPUT' });
  expect(h.kernel.inspectTopology).not.toHaveBeenCalled(); expect(h.kernel.resolveTopologyPicks).not.toHaveBeenCalled();
  const pending = deferred<CadTopologyInspectResult>(); h.kernel.inspectTopology.mockReturnValueOnce(pending.promise);
  const read = h.input.inspect(request, h.before.version, undefined, undefined, snapshot.inputToken);
  const rejected = expect(read).rejects.toMatchObject({ code: 'STALE_FEATURE_INPUT' });
  await vi.waitFor(() => expect(h.kernel.inspectTopology).toHaveBeenCalledOnce());
  h.switchStorage(); pending.resolve({ bodyId: 'pad', buildId: 'input-build', descriptors: [], total: 0, nextOffset: null });
  await rejected; expect(h.kernel.dispose).toHaveBeenCalledOnce();
  const fresh = await h.input.build({ featureId: 'round', bodyId: 'pad' }, h.before.version);
  h.session.edit([{ kind: 'rename-document', name: 'Changed' }], h.before.version);
  await expect(h.input.inspect(request, h.before.version, undefined, undefined, fresh.inputToken)).rejects.toMatchObject({ code: 'STALE_STATE' });
  expect(h.kernel.dispose).toHaveBeenCalledTimes(2);
});

it('permits only the trusted editor workflow scope and no unsupported feature, unavailable input or partial build', async () => {
  const h = fixture(); h.session.setWorkflowOpen(true);
  await expect(h.input.build({ featureId: 'round', bodyId: 'pad' }, h.before.version)).rejects.toMatchObject({ code: 'WORKFLOW_OPEN' });
  const snapshot = await h.input.build({ featureId: 'round', bodyId: 'pad' }, h.before.version, undefined, 'editor');
  const request = { bodyId: 'pad', expectedBuildId: 'input-build', selection: { kind: 'page' as const, topology: 'edge' as const, offset: 0, limit: 10 } };
  await expect(h.input.inspect(request, h.before.version, undefined, undefined, snapshot.inputToken)).rejects.toMatchObject({ code: 'WORKFLOW_OPEN' });
  await h.input.inspect(request, h.before.version, undefined, 'editor', snapshot.inputToken);
  h.session.setWorkflowOpen(true, 'dxf-export');
  await expect(h.input.inspect({ bodyId: 'pad', expectedBuildId: 'input-build', selection: { kind: 'page', topology: 'edge', offset: 0, limit: 10 } }, h.before.version, undefined, 'editor', snapshot.inputToken)).rejects.toMatchObject({ code: 'WORKFLOW_OPEN' });
  h.session.setWorkflowOpen(false, 'dxf-export'); h.session.setWorkflowOpen(false);
  await expect(h.input.build({ featureId: 'pad', bodyId: 'pad' }, h.before.version)).rejects.toMatchObject({ code: 'INVALID_FEATURE_INPUT' });
  await expect(h.input.build({ featureId: 'round', bodyId: 'after' }, h.before.version)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  h.kernel.build.mockResolvedValueOnce({ ...built(), diagnostics: [{ code: 'failed', message: 'Input body failed.' }] });
  await expect(h.input.build({ featureId: 'round', bodyId: 'pad' }, h.before.version)).rejects.toMatchObject({ code: 'FEATURE_INPUT_BUILD_FAILED' });
  expect(h.session.getSnapshot()).toEqual(h.before); expect(h.session.getSnapshot().document).toBe(h.before.document); h.input.dispose();
});

it('keeps the picker usable after an unsupported seed or pre-send cancellation, but invalidates a lost native cache', async () => {
  const h = fixture(), snapshot = await h.input.build({ featureId: 'round', bodyId: 'pad' }, h.before.version);
  const request = { bodyId: 'pad', expectedBuildId: 'input-build', purpose: 'fillet' as const, picks: [{ kind: 'edge' as const, key: 'edge_1' }] };
  h.kernel.resolveTopologyPicks.mockRejectedValueOnce(new CadError('unsupported-selection', 'Select a line or circular edge.'));
  await expect(h.input.resolve(request, h.before.version, undefined, undefined, snapshot.inputToken)).rejects.toMatchObject({ code: 'unsupported-selection' });
  await expect(h.input.resolve(request, h.before.version, undefined, undefined, snapshot.inputToken)).resolves.toMatchObject({ purpose: 'fillet' });
  const cancelled = new AbortController();
  const reading = h.input.resolve(request, h.before.version, cancelled.signal, undefined, snapshot.inputToken);
  cancelled.abort(); await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
  const valid = await h.input.resolve(request, h.before.version, undefined, undefined, snapshot.inputToken);
  const pending = deferred<CadTopologyResolvePicksResult>(), inFlight = new AbortController();
  h.kernel.resolveTopologyPicks.mockReturnValueOnce(pending.promise);
  const receipt = h.input.resolve(request, h.before.version, inFlight.signal, undefined, snapshot.inputToken);
  await vi.waitFor(() => expect(h.kernel.resolveTopologyPicks).toHaveBeenCalledTimes(4));
  inFlight.abort(); expect(h.kernel.resolveTopologyPicks.mock.calls.at(-1)?.[2]?.aborted).toBe(false);
  pending.resolve(valid); await expect(receipt).rejects.toMatchObject({ name: 'AbortError' });
  await h.input.resolve(request, h.before.version, undefined, undefined, snapshot.inputToken);
  expect(h.kernel.dispose).not.toHaveBeenCalled();
  h.kernel.resolveTopologyPicks.mockRejectedValueOnce(new CadError('STALE_BUILD', 'The displayed model is no longer cached.'));
  await expect(h.input.resolve(request, h.before.version, undefined, undefined, snapshot.inputToken)).rejects.toMatchObject({ code: 'STALE_BUILD' });
  await expect(h.input.resolve(request, h.before.version, undefined, undefined, snapshot.inputToken)).rejects.toMatchObject({ code: 'STALE_FEATURE_INPUT' });
  expect(h.kernel.dispose).toHaveBeenCalledOnce();
});
