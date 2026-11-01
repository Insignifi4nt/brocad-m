import { describe, expect, it, vi } from 'vitest';
import type { CadBuildResult } from '@/domain/cad/cadDocument';
import type { CadTopologyDescriptor, CadTopologyInspectRequest, CadTopologyInspectResult, CadTopologyResolvePicksResult } from '@/domain/cad/cadTopology';
import type { CadTopologyAdjacency, CadTopologyTangentChain } from '@/domain/cad/cadTopologyAdjacency';
import { CadSession } from './cadSession';
import { createCadTopologyActions } from './cadTopologyActions';

const result: CadTopologyInspectResult = { bodyId: 'pad', buildId: 'build-1', descriptors: [], total: 0, nextOffset: null };
const request: CadTopologyInspectRequest = { bodyId: 'pad', expectedBuildId: 'build-1', selection: { kind: 'page', topology: 'face', offset: 0, limit: 10 } };
const face: CadTopologyDescriptor = { key: 'f1', kind: 'face', surfaceType: 'plane', area: 200, normal: [0, 0, 1], offset: 5,
  centroid: [10, 5, 5], bounds: { min: [0, 0, 5], max: [20, 10, 5] } };
// One straight edge bounding one face: the smallest adjacency the validator accepts.
const adjacency: CadTopologyAdjacency = { bodyId: 'pad', buildId: 'build-1', edges: ['e1'], edgeFaces: [0, -1], edgeSmooth: [false], faces: ['f1'], faceLoops: [[[0]]] };
const chain: CadTopologyTangentChain = { bodyId: 'pad', buildId: 'build-1', edgeKey: 'e1', edges: ['e0', 'e1'], closed: false, native: true };
function deferred<T>() {
  let finish: (value: T) => void = () => { throw new Error('Not initialized'); };
  const promise = new Promise<T>(resolve => { finish = resolve; });
  return { promise, finish };
}
function fixture() {
  const session = new CadSession(); const version = session.getSnapshot().version;
  const kernel = { inspectTopology: vi.fn(async () => result), resolveTopologyPicks: vi.fn(async (): Promise<CadTopologyResolvePicksResult> => ({ bodyId: 'pad', buildId: 'build-1', purpose: 'shell',
    opening: { kind: 'faces', expectedCount: 1, predicates: [{ kind: 'plane', normal: [0, 0, 1], offset: 5 }] } })),
    topologyAdjacency: vi.fn(async (): Promise<CadTopologyAdjacency> => adjacency), topologyTangentChain: vi.fn(async (): Promise<CadTopologyTangentChain> => chain) };
  const build: { result: CadBuildResult | null; version: string | null; state: 'ready' | 'building' | 'error' | 'idle' } = {
    result: { buildId: 'build-1', meshes: [{ featureId: 'pad', name: 'Pad', positions: [], normals: [], indices: [], edges: [], faceGroups: [], edgeGroups: [], volume: 1000,
      bounds: { min: [0, 0, 0], max: [20, 10, 5] } }], diagnostics: [], durationMs: 1 }, version, state: 'ready'
  };
  const getKernel = vi.fn(async () => kernel);
  const actions = createCadTopologyActions({
    assertReadable: (expected, scope) => { session.assertVersion(expected); session.assertWorkflowClosed(scope); },
    getDocument: () => session.getSnapshot().document, getBuild: () => build, getKernel
  });
  return { actions, session, version, kernel, build, getKernel };
}

describe('CAD topology application guards', () => {
  it('rejects structurally invalid exact descriptors and nonplanar opening replies before exposing a selection', async () => {
    const h = fixture();
    for (const descriptor of [{ ...face, normal: [0, 0, 2] }, { ...face, area: -1 }, { ...face, bounds: { min: [20, 0, 0], max: [0, 10, 5] } }]) {
      h.kernel.inspectTopology.mockResolvedValue({ ...result, descriptors: [descriptor as CadTopologyDescriptor], total: 1 });
      await expect(h.actions.inspect(request, h.version)).rejects.toMatchObject({ code: 'INVALID_TOPOLOGY_RESULT' });
    }
    h.kernel.resolveTopologyPicks.mockResolvedValue({ bodyId: 'pad', buildId: 'build-1', purpose: 'shell', opening: {
      kind: 'faces', expectedCount: 1, predicates: [{ kind: 'surface-type', value: 'cylinder' }]
    } });
    await expect(h.actions.resolve({ bodyId: 'pad', expectedBuildId: 'build-1', purpose: 'shell', picks: [{ kind: 'face', key: 'f1' }] }, h.version)).rejects.toMatchObject({ code: 'INVALID_TOPOLOGY_RESULT' });
    let reads = 0;
    h.kernel.inspectTopology.mockResolvedValue({ ...result, get descriptors() { reads++; return []; } });
    await expect(h.actions.inspect(request, h.version)).rejects.toMatchObject({ code: 'INVALID_TOPOLOGY_RESULT' });
    expect(reads).toBe(0);
  });
  it('pins exact body/build and returns draft provenance without editing history', async () => {
    const h = fixture(); const before = h.session.getSnapshot();
    expect(await h.actions.inspect(request, h.version)).toEqual({ ...result, documentId: before.document.id, version: h.version });
    expect(h.kernel.inspectTopology).toHaveBeenCalledWith(before.document, request, undefined);
    expect(h.session.getSnapshot()).toBe(before);
    await expect(h.actions.inspect({ ...request, bodyId: 'missing' }, h.version)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(h.actions.inspect({ ...request, expectedBuildId: 'old-build' }, h.version)).rejects.toMatchObject({ code: 'STALE_BUILD' });
    h.build.state = 'building';
    await expect(h.actions.inspect(request, h.version)).rejects.toMatchObject({ code: 'BUILD_REQUIRED' });
    expect(h.kernel.inspectTopology).toHaveBeenCalledTimes(1);
  });
  it('rejects late inspection when the document or displayed build changes', async () => {
    for (const change of ['document', 'build'] as const) {
      const h = fixture(); const pending = deferred<CadTopologyInspectResult>();
      h.kernel.inspectTopology.mockReturnValue(pending.promise);
      const operation = h.actions.inspect(request, h.version);
      await vi.waitFor(() => expect(h.kernel.inspectTopology).toHaveBeenCalledTimes(1));
      if (change === 'document') h.session.edit([{ kind: 'rename-document', name: 'Changed while inspecting' }]);
      else if (h.build.result) h.build.result = { ...h.build.result, buildId: 'rebuilt-same-document' };
      pending.finish(result);
      await expect(operation).rejects.toMatchObject({ code: change === 'document' ? 'STALE_STATE' : 'STALE_BUILD' });
    }
  });
  it('allows local read-only conversion during its editor while tools and section dialogs remain guarded', async () => {
    const h = fixture(); h.session.setWorkflowOpen(true, 'editor');
    const resolve = { bodyId: 'pad', expectedBuildId: 'build-1', purpose: 'shell' as const, picks: [{ kind: 'face' as const, key: 'f1' }] };
    await expect(h.actions.resolve(resolve, h.version)).rejects.toMatchObject({ code: 'WORKFLOW_OPEN' });
    expect(await h.actions.resolve(resolve, h.version, undefined, 'editor')).toMatchObject({ purpose: 'shell', opening: { expectedCount: 1 } });
    h.session.setWorkflowOpen(true, 'section');
    await expect(h.actions.resolve(resolve, h.version, undefined, 'editor')).rejects.toMatchObject({ code: 'WORKFLOW_OPEN' });
    expect(h.kernel.resolveTopologyPicks).toHaveBeenCalledTimes(1);
  });
  it('cancels before dispatch and refuses results after a workflow opens', async () => {
    const h = fixture(); const cancellation = new AbortController(); cancellation.abort();
    await expect(h.actions.inspect(request, h.version, cancellation.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.getKernel).not.toHaveBeenCalled();
    const pending = deferred<CadTopologyInspectResult>(); h.kernel.inspectTopology.mockReturnValue(pending.promise);
    const operation = h.actions.inspect(request, h.version);
    await vi.waitFor(() => expect(h.kernel.inspectTopology).toHaveBeenCalledTimes(1));
    h.session.setWorkflowOpen(true, 'section'); pending.finish(result);
    await expect(operation).rejects.toMatchObject({ code: 'WORKFLOW_OPEN' });
  });
  it('freezes requested picks before asynchronous loading and rejects a mismatched response', async () => {
    const h = fixture();
    h.kernel.inspectTopology.mockResolvedValue({ ...result, descriptors: [face], total: 1 });
    const mutable = { bodyId: 'pad', expectedBuildId: 'build-1', selection: { kind: 'picks' as const, picks: [{ kind: 'face' as const, key: 'f1' }] } };
    const operation = h.actions.inspect(mutable, h.version); mutable.selection.picks[0].key = 'f2';
    await operation;
    expect(h.kernel.inspectTopology).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ selection: { kind: 'picks', picks: [{ kind: 'face', key: 'f1' }] } }), undefined);
    h.kernel.inspectTopology.mockResolvedValue({ ...result, bodyId: 'another-body' });
    await expect(h.actions.inspect(request, h.version)).rejects.toMatchObject({ code: 'STALE_BUILD' });
  });
  it('rejects wrong topology keys, incomplete pages, pagination loops and mismatched operation purpose', async () => {
    const h = fixture();
    h.kernel.inspectTopology.mockResolvedValue({ ...result, descriptors: [face], total: 12, nextOffset: 0 });
    await expect(h.actions.inspect(request, h.version)).rejects.toMatchObject({ code: 'INVALID_TOPOLOGY_RESULT' });
    h.kernel.inspectTopology.mockResolvedValue({ ...result, descriptors: [face], total: 2, nextOffset: null });
    await expect(h.actions.inspect(request, h.version)).rejects.toMatchObject({ code: 'INVALID_TOPOLOGY_RESULT' });
    h.kernel.inspectTopology.mockResolvedValue({ ...result, descriptors: [face], total: 1 });
    await expect(h.actions.inspect({ ...request, selection: { kind: 'picks', picks: [{ kind: 'face', key: 'different-face' }] } }, h.version)).rejects.toMatchObject({ code: 'INVALID_TOPOLOGY_RESULT' });
    await expect(h.actions.resolve({ bodyId: 'pad', expectedBuildId: 'build-1', purpose: 'fillet', picks: [{ kind: 'edge', key: 'e1' }] }, h.version)).rejects.toMatchObject({ code: 'INVALID_TOPOLOGY_RESULT' });
    h.kernel.inspectTopology.mockResolvedValue(result);
    await expect(h.actions.inspect({ ...request, selection: { kind: 'page', topology: 'face', offset: 100, limit: 10 } }, h.version)).rejects.toMatchObject({ code: 'INVALID_TOPOLOGY_RESULT' });
    expect(await h.actions.inspect({ ...request, selection: { kind: 'page', topology: 'face', offset: result.total, limit: 10 } }, h.version)).toMatchObject({ descriptors: [], nextOffset: null });
  });
  it('reads adjacency for the displayed build only, and refuses one that belongs to another body or build or is malformed', async () => {
    const h = fixture(), wanted = { bodyId: 'pad', expectedBuildId: 'build-1' };
    expect(await h.actions.adjacency(wanted, h.version)).toEqual(adjacency);
    await expect(h.actions.adjacency({ ...wanted, expectedBuildId: 'build-0' }, h.version)).rejects.toMatchObject({ code: 'STALE_BUILD' });
    h.kernel.topologyAdjacency.mockResolvedValueOnce({ ...adjacency, buildId: 'build-2' });
    await expect(h.actions.adjacency(wanted, h.version)).rejects.toMatchObject({ code: 'STALE_BUILD' });
    h.kernel.topologyAdjacency.mockResolvedValueOnce({ ...adjacency, edgeFaces: [3, -1] });
    await expect(h.actions.adjacency(wanted, h.version)).rejects.toMatchObject({ code: 'INVALID_TOPOLOGY_RESULT' });
  });
  it('reads a native tangent chain for the displayed build only, and refuses one for another edge, body or build or that is malformed', async () => {
    const h = fixture(), wanted = { bodyId: 'pad', expectedBuildId: 'build-1', edgeKey: 'e1' };
    expect(await h.actions.tangentChain(wanted, h.version)).toEqual(chain);
    expect(h.kernel.topologyTangentChain).toHaveBeenCalledWith(expect.anything(), wanted, undefined);
    await expect(h.actions.tangentChain({ ...wanted, expectedBuildId: 'build-0' }, h.version)).rejects.toMatchObject({ code: 'STALE_BUILD' });
    h.kernel.topologyTangentChain.mockResolvedValueOnce({ ...chain, buildId: 'build-2' });
    await expect(h.actions.tangentChain(wanted, h.version)).rejects.toMatchObject({ code: 'STALE_BUILD' });
    h.kernel.topologyTangentChain.mockResolvedValueOnce({ ...chain, edgeKey: 'e0' });
    await expect(h.actions.tangentChain(wanted, h.version)).rejects.toMatchObject({ code: 'INVALID_TOPOLOGY_RESULT' });
    h.kernel.topologyTangentChain.mockResolvedValueOnce({ ...chain, native: false });
    await expect(h.actions.tangentChain(wanted, h.version)).rejects.toMatchObject({ code: 'INVALID_TOPOLOGY_RESULT' });
    await expect(h.actions.tangentChain({ ...wanted, edgeKey: '' }, h.version)).rejects.toMatchObject({ code: 'invalid-topology-request' });
  });
});
