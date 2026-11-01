import { describe, expect, it, vi } from 'vitest';
import { createCadKernelClient, type CadWorkerTransport } from './cadKernelClient';
import type { CadKernelRequest } from './cadKernelProtocol';
import { createCadDocument } from '../../../domain/cad/cadSchema';
import { isCadKernelReply } from './cadKernelProtocol';
import type { CadTopologyInspectResult } from '../../../domain/cad/cadTopology';

const inspectionResult: CadTopologyInspectResult = { bodyId: 'body', buildId: 'test-build', total: 1, nextOffset: null, descriptors: [{
  kind: 'edge', key: 'edge-key', curveType: 'line', length: 1, start: [0, 0, 0], end: [1, 0, 0], centroid: [.5, 0, 0], bounds: { min: [0, 0, 0], max: [1, 0, 0] }
}] };
const inspectionRequest = { bodyId: 'body', expectedBuildId: 'test-build', selection: { kind: 'page' as const, topology: 'edge' as const, offset: 0, limit: 1 } };

class TestTransport implements CadWorkerTransport {
  onmessage: CadWorkerTransport['onmessage'] = null;
  onerror: CadWorkerTransport['onerror'] = null;
  onmessageerror: CadWorkerTransport['onmessageerror'] = null;
  messages: CadKernelRequest[] = [];
  terminated = false;
  postMessage(message: CadKernelRequest) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  reply(id: number) { this.onmessage?.(new MessageEvent('message', { data: { id, kind: 'built', result: { buildId: 'test-build', meshes: [], diagnostics: [], durationMs: 1 } } })); }
  inspectReply(id: number, result = inspectionResult) { this.onmessage?.(new MessageEvent('message', { data: { id, kind: 'topology-inspected', result } })); }
}

describe('CAD worker lifetime and cancellation', () => {
  it('accepts a large exact source and matching native counts without allocating another encoded original for reply matching', async () => {
    const source = { format: 'step' as const, fileName: 'large.step', encoding: 'utf8' as const, data: 'ISO-10303-21;\r\n' + '孔😀'.repeat(320_000) };
    const sourceBytes = new TextEncoder().encode(source.data).length, transport = new TestTransport(), client = createCadKernelClient(() => transport);
    const encode = vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(() => { throw new Error('Unexpected full encoding copy'); });
    try {
      const imported = client.importSolid(source);
      expect(transport.messages[0]).toMatchObject({ kind: 'import-solid', source });
      transport.onmessage?.(new MessageEvent('message', { data: { id: 1, kind: 'solid-imported', result: {
        format: 'step', fileName: source.fileName, representation: 'exact-brep', volume: 257, solidCount: 257, sourceBytes,
        bounds: { min: [0, 0, 0], max: [769, 1, 1] },
      } } }));
      expect(await imported).toMatchObject({ solidCount: 257, sourceBytes }); expect(transport.terminated).toBe(false);
      const mismatch = client.importSolid(source), rejected = expect(mismatch).rejects.toThrow('does not match');
      transport.onmessage?.(new MessageEvent('message', { data: { id: 2, kind: 'solid-imported', result: {
        format: 'step', fileName: source.fileName, representation: 'exact-brep', volume: 257, solidCount: 257, sourceBytes: sourceBytes - 1,
        bounds: { min: [0, 0, 0], max: [769, 1, 1] },
      } } }));
      await rejected; expect(transport.terminated).toBe(true);
    } finally { encode.mockRestore(); client.dispose(); }
  });
  it('preserves optional native solid counts and face solids, and rejects invalid ones at the worker boundary', async () => {
    const mesh = { featureId: 'body', name: 'Body', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2], edges: [], volume: 1,
      faceGroups: [{ start: 0, count: 3, key: 'face' }], edgeGroups: [], bounds: { min: [0, 0, 0], max: [1, 1, 1] } };
    const reply = (changed: unknown) => ({ id: 1, kind: 'built', result: { buildId: 'counted', meshes: [changed], diagnostics: [], durationMs: 1 } });
    expect(isCadKernelReply(reply(mesh))).toBe(true);
    expect(isCadKernelReply(reply({ ...mesh, solidCount: 2 }))).toBe(true);
    for (const solidCount of [0, -1, 1.5, Infinity, NaN, '2', null, Number.MAX_SAFE_INTEGER + 1]) {
      expect(isCadKernelReply(reply({ ...mesh, solidCount })), String(solidCount)).toBe(false);
    }
    // One solid number for each face group, below the solid count.
    expect(isCadKernelReply(reply({ ...mesh, solidCount: 2, faceSolids: [1] }))).toBe(true);
    for (const faceSolids of [[2], [-1], [0.5], [0, 1], [], ['0'], '0', null]) {
      expect(isCadKernelReply(reply({ ...mesh, solidCount: 2, faceSolids })), JSON.stringify(faceSolids)).toBe(false);
    }
    expect(isCadKernelReply(reply({ ...mesh, faceSolids: [0] }))).toBe(false);
    for (const counted of [mesh, { ...mesh, solidCount: 2 }, { ...mesh, solidCount: 2, faceSolids: [1] }]) {
      const transport = new TestTransport(), client = createCadKernelClient(() => transport), pending = client.build(createCadDocument());
      transport.onmessage?.(new MessageEvent('message', { data: reply(counted) }));
      expect((await pending).meshes[0]).toEqual(counted);
      expect(transport.terminated).toBe(false); client.dispose();
    }
  });
  it('checks preview triangle topology and rejects malformed buffers before rendering', () => {
    const mesh = { featureId: 'body', name: 'Body', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2], edges: [], volume: 1,
      faceGroups: [{ start: 0, count: 3, key: 'face' }], edgeGroups: [],
      bounds: { min: [0, 0, 0], max: [1, 1, 1] } };
    const reply = (changed: unknown) => ({ id: 1, kind: 'built', result: { buildId: 'build', meshes: [changed], diagnostics: [], durationMs: 1 } });
    expect(isCadKernelReply(reply(mesh))).toBe(true);
    for (const indices of [[-1, 1, 2], [.5, 1, 2], [0, 1, 99], [0, 1]]) expect(isCadKernelReply(reply({ ...mesh, indices }))).toBe(false);
    expect(isCadKernelReply(reply({ ...mesh, normals: [0, 0, 1] }))).toBe(false);
    expect(isCadKernelReply(reply({ ...mesh, positions: new Array(9) }))).toBe(false);
    expect(isCadKernelReply(reply({ ...mesh, edges: [0, 0, 0] }))).toBe(false);
    expect(isCadKernelReply(reply({ ...mesh, bounds: { min: [2, 0, 0], max: [1, 1, 1] } }))).toBe(false);
    for (const faceGroups of [[], [{ start: 1, count: 3, key: 'face' }], [{ start: 0, count: 6, key: 'face' }], [{ start: 0, count: 3, key: 'bad key' }]]) {
      expect(isCadKernelReply(reply({ ...mesh, faceGroups }))).toBe(false);
    }
    expect(isCadKernelReply({ id: 1, kind: 'built', result: { meshes: [mesh, mesh], diagnostics: [], durationMs: 1 } })).toBe(false);
  });
  it('terminates the worker on an out-of-range preview triangle instead of publishing corrupt geometry', async () => {
    const transport = new TestTransport(); const client = createCadKernelClient(() => transport);
    const pending = client.build(createCadDocument()); const rejected = expect(pending).rejects.toThrow('Invalid CAD worker response');
    transport.onmessage?.(new MessageEvent('message', { data: { id: 1, kind: 'built', result: { durationMs: 1, diagnostics: [], meshes: [{
      featureId: 'body', name: 'Body', positions: [0, 0, 0], normals: [0, 0, 1], indices: [0, 1, 2], edges: [], volume: 1,
      bounds: { min: [0, 0, 0], max: [1, 1, 1] }
    }] } } }));
    await rejected; expect(transport.terminated).toBe(true); client.dispose();
  });
  it('starts lazily, serializes jobs and terminates on disposal', async () => {
    const transports: TestTransport[] = [];
    const client = createCadKernelClient(() => { const transport = new TestTransport(); transports.push(transport); return transport; });
    expect(transports).toHaveLength(0);
    const first = client.build(createCadDocument());
    const second = client.build(createCadDocument());
    expect(transports).toHaveLength(1);
    expect(transports[0].messages).toHaveLength(1);
    transports[0].reply(1); await first;
    expect(transports[0].messages).toHaveLength(2);
    transports[0].reply(2); await second;
    client.dispose(); expect(transports[0].terminated).toBe(true);
    await expect(client.build(createCadDocument())).rejects.toThrow('disposed');
  });

  it('cancels a running WASM job by termination and rejects stale replies after restart', async () => {
    const transports: TestTransport[] = [];
    const client = createCadKernelClient(() => { const transport = new TestTransport(); transports.push(transport); return transport; });
    const controller = new AbortController();
    const first = client.build(createCadDocument(), controller.signal);
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const second = client.build(createCadDocument());
    controller.abort(); await rejected;
    expect(transports[0].terminated).toBe(true);
    expect(transports).toHaveLength(2);
    transports[0].reply(1);
    transports[1].reply(1);
    transports[1].reply(2);
    await second; client.dispose();
  });

  it('removes a canceled queued job without interrupting the running solid', async () => {
    const transport = new TestTransport();
    const client = createCadKernelClient(() => transport);
    const first = client.build(createCadDocument());
    const controller = new AbortController();
    const second = client.build(createCadDocument(), controller.signal);
    const rejected = expect(second).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await rejected;
    expect(transport.terminated).toBe(false);
    transport.reply(1); await first;
    expect(transport.messages).toHaveLength(1);
    client.dispose();
  });

  it('bounds the queue and recovers after a worker error', async () => {
    const transports: TestTransport[] = [];
    const client = createCadKernelClient(() => { const transport = new TestTransport(); transports.push(transport); return transport; });
    const first = client.build(createCadDocument());
    const rejected = expect(first).rejects.toThrow('worker stopped');
    const queued = Array.from({ length: 4 }, () => client.build(createCadDocument()));
    await expect(client.build(createCadDocument())).rejects.toThrow('queue is full');
    transports[0].onerror?.(new ErrorEvent('error'));
    await rejected;
    for (let id = 2; id <= 5; id++) transports[1].reply(id);
    await Promise.all(queued); client.dispose();
  });

  it('validates and returns analytic section replies through the same worker queue', async () => {
    const transport = new TestTransport();
    const client = createCadKernelClient(() => transport);
    const section = client.section(createCadDocument(), { bodyId: 'body', plane: 'XY', offset: 2.5 });
    expect(transport.messages[0].kind).toBe('section');
    transport.onmessage?.(new MessageEvent('message', { data: { id: 1, kind: 'sectioned', result: {
      bodyId: 'body', plane: 'XY', offset: 2.5, contourCount: 1, entities: [{ type: 'circle', layer: 'CAD_SECTION', center: { x: 0, y: 0 }, radius: 2 }]
    } } }));
    expect((await section).contourCount).toBe(1);
    client.dispose();
  });
  it('preserves coded stale-build diagnostics and rejects mismatched topology body/build replies', async () => {
    const transport = new TestTransport(); const client = createCadKernelClient(() => transport);
    const inspection = client.inspectTopology(createCadDocument(), inspectionRequest);
    const rejected = expect(inspection).rejects.toMatchObject({ code: 'STALE_BUILD' });
    transport.onmessage?.(new MessageEvent('message', { data: { id: 1, kind: 'error', code: 'STALE_BUILD', message: 'Rebuild and select again.' } })); await rejected;
    expect(transport.terminated).toBe(false);
    const mismatch = client.inspectTopology(createCadDocument(), inspectionRequest); const mismatchRejected = expect(mismatch).rejects.toThrow('does not match');
    transport.inspectReply(2, { ...inspectionResult, buildId: 'another-build' }); await mismatchRejected;
    expect(transport.terminated).toBe(true); client.dispose();
  });
  it('returns a native tangent chain only for the edge, body and build asked for', async () => {
    const chain = { bodyId: 'body', buildId: 'test-build', edgeKey: 'edge-key', edges: ['edge-key', 'next-key'], closed: false, native: true };
    const wanted = { bodyId: 'body', expectedBuildId: 'test-build', edgeKey: 'edge-key' };
    const transport = new TestTransport(); const client = createCadKernelClient(() => transport);
    const answered = client.topologyTangentChain(createCadDocument(), wanted);
    expect(transport.messages[0]).toMatchObject({ kind: 'inspect-tangent-chain', chain: wanted });
    transport.onmessage?.(new MessageEvent('message', { data: { id: 1, kind: 'tangent-chain-inspected', result: chain } }));
    expect(await answered).toEqual(chain);
    // The chain of another edge in the same contour is not this edge's answer.
    const other = client.topologyTangentChain(createCadDocument(), wanted), rejected = expect(other).rejects.toThrow('does not match');
    transport.onmessage?.(new MessageEvent('message', { data: { id: 2, kind: 'tangent-chain-inspected', result: { ...chain, edgeKey: 'next-key' } } })); await rejected;
    expect(transport.terminated).toBe(true); client.dispose();
  });
  it('cancels topology resolution by terminating its worker and cannot publish a late selector', async () => {
    const transport = new TestTransport(); const client = createCadKernelClient(() => transport); const controller = new AbortController();
    const pending = client.resolveTopologyPicks(createCadDocument(), { bodyId: 'body', expectedBuildId: 'test-build', purpose: 'fillet', picks: [{ kind: 'edge', key: 'edge-key' }] }, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' }); controller.abort(); await rejected;
    expect(transport.terminated).toBe(true);
    transport.onmessage?.(new MessageEvent('message', { data: { id: 1, kind: 'topology-resolved', result: {
      bodyId: 'body', buildId: 'test-build', purpose: 'fillet', selection: { expectedCount: 1, queries: [{ kind: 'edges', expectedCount: 1, predicates: [{ kind: 'length', value: 1 }] }] }
    } } }));
    client.dispose();
  });
});
