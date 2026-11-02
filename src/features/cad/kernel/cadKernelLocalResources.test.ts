import { afterEach, expect, it, vi } from 'vitest';
import { createCadDocument } from '../../../domain/cad/cadSchema';
import { createCadKernelClient, type CadWorkerTransport } from './cadKernelClient';
import { isCadKernelReply, type CadKernelReply, type CadKernelRequest } from './cadKernelProtocol';
import type { CadTopologyInspectResult } from '../../../domain/cad/cadTopology';

class LocalTransport implements CadWorkerTransport {
  onmessage: CadWorkerTransport['onmessage'] = null;
  onerror: CadWorkerTransport['onerror'] = null;
  onmessageerror: CadWorkerTransport['onmessageerror'] = null;
  messages: CadKernelRequest[] = [];
  terminated = false;
  postMessage(message: CadKernelRequest) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  reply(reply: CadKernelReply) { this.onmessage?.(new MessageEvent('message', { data: reply })); }
}

afterEach(() => vi.useRealTimers());

it('lets a long local export finish and still allows immediate cancellation of subsequent work', async () => {
  vi.useFakeTimers();
  const transports: LocalTransport[] = [];
  const client = createCadKernelClient(() => {
    const transport = new LocalTransport(); transports.push(transport); return transport;
  });
  try {
    const document = createCadDocument();
    let state = 'pending';
    const exported = client.export(document, 'step').then(blob => { state = 'finished'; return blob; }, error => {
      state = 'failed'; throw error;
    });
    // Observe rejection immediately so a virtual-time regression cannot leak an unhandled promise.
    const result = exported.then(blob => ({ blob }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(8 * 60_000);
    expect(state).toBe('pending');
    expect(transports[0].terminated).toBe(false);
    const blob = new Blob(['ISO-10303-21;\r\nEND-ISO-10303-21;\r\n']);
    transports[0].reply({ id: 1, kind: 'exported', blob });
    expect(await result).toEqual({ blob });

    const control = new AbortController();
    const next = client.export(document, 'stl', control.signal);
    const cancelled = expect(next).rejects.toMatchObject({ name: 'AbortError' });
    const queued = client.build(document);
    control.abort(); await cancelled;
    expect(transports[0].terminated).toBe(true);
    expect(transports).toHaveLength(2);
    transports[0].reply({ id: 2, kind: 'exported', blob });
    transports[1].reply({ id: 3, kind: 'built', result: { buildId: 'after-cancel', meshes: [], diagnostics: [], durationMs: 1 } });
    expect((await queued).buildId).toBe('after-cancel');
  } finally { client.dispose(); }
});

it('captures queued input independently of caller mutation before sending it to the worker', async () => {
  const transport = new LocalTransport(), client = createCadKernelClient(() => transport);
  try {
    const first = client.build(createCadDocument());
    const document = { ...createCadDocument(), name: 'Queued part', parameters: { depth: 5 } };
    const queued = client.build(document);
    document.name = 'Caller changed it'; document.parameters.depth = 20;
    transport.reply({ id: 1, kind: 'built', result: { buildId: 'first', meshes: [], diagnostics: [], durationMs: 1 } });
    await first;
    const request = transport.messages[1];
    expect(request.kind).toBe('build');
    if (request.kind !== 'build') throw new Error('Expected queued build.');
    expect(request.document.name).toBe('Queued part');
    expect(request.document.parameters).toEqual({ depth: 5 });
    transport.reply({ id: 2, kind: 'built', result: { buildId: 'queued', meshes: [], diagnostics: [], durationMs: 1 } });
    expect((await queued).buildId).toBe('queued');
  } finally { client.dispose(); }
});

it('keeps a healthy exact build usable for inspection and export after a long editing session', async () => {
  const transports: LocalTransport[] = [];
  const client = createCadKernelClient(() => {
    const transport = new LocalTransport(); transports.push(transport); return transport;
  });
  try {
    const document = createCadDocument();
    for (let id = 1; id <= 32; id++) {
      const build = client.build(document);
      transports.at(-1)?.reply({ id, kind: 'built', result: { buildId: 'retained-build', meshes: [], diagnostics: [], durationMs: 1 } });
      expect((await build).buildId).toBe('retained-build');
    }
    expect(transports).toHaveLength(1);
    const result: CadTopologyInspectResult = { bodyId: 'body', buildId: 'retained-build', total: 0, nextOffset: null, descriptors: [] };
    for (let id = 33; id <= 160; id++) {
      const pending = client.inspectTopology(document, { bodyId: 'body', expectedBuildId: 'retained-build', selection: { kind: 'page', topology: 'face', offset: 0, limit: 10 } });
      transports[0].reply({ id, kind: 'topology-inspected', result });
      expect(await pending).toEqual(result);
    }
    const exported = client.export(document, 'step'), blob = new Blob(['Retained exact STEP']);
    transports[0].reply({ id: 161, kind: 'exported', blob });
    expect(await exported).toBe(blob);
    expect(transports[0].terminated).toBe(false);
  } finally { client.dispose(); }
});

it('validates complete preview buffers beyond the former size budget without accepting corrupt tail values', () => {
  const edges = new Array<number>(8_000_004).fill(0);
  const mesh = { featureId: 'body', name: 'Body', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2], edges, faceGroups: [{ start: 0, count: 3, key: 'face' }], edgeGroups: [{ start: 0, count: edges.length / 3, key: 'edge' }],
    volume: 1, bounds: { min: [0, 0, 0], max: [1, 1, 1] } };
  const reply = { id: 1, kind: 'built', result: { buildId: 'large-preview', meshes: [mesh], diagnostics: [], durationMs: 1 } };
  expect(isCadKernelReply(reply)).toBe(true);
  edges[edges.length - 1] = NaN;
  expect(isCadKernelReply(reply)).toBe(false);
});

it('retains a complete multi-body reply above the former body count and rejects corrupt or duplicate tail records', async () => {
  const meshes = Array.from({ length: 257 }, (_, index) => ({ featureId: `body_${index}`, name: `Body ${index}`,
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2], edges: [],
    faceGroups: [{ start: 0, count: 3, key: `face_${index}` }], edgeGroups: [], volume: 1, solidCount: 1,
    bounds: { min: [0, 0, 0] as const, max: [1, 1, 1] as const },
  }));
  const result = { buildId: 'complete-large-model', meshes, diagnostics: [], durationMs: 1 };
  const reply = { id: 1, kind: 'built', result };
  expect(isCadKernelReply(reply)).toBe(true);
  const missingMeshes = meshes.slice(); delete missingMeshes[256];
  expect(isCadKernelReply({ ...reply, result: { ...result, meshes: missingMeshes } })).toBe(false);
  expect(isCadKernelReply({ ...reply, result: { ...result, diagnostics: new Array(1) } })).toBe(false);
  const transport = new LocalTransport(), client = createCadKernelClient(() => transport);
  try {
    const pending = client.build(createCadDocument());
    transport.reply({ id: 1, kind: 'built', result });
    expect((await pending).meshes).toEqual(meshes);
    expect(transport.terminated).toBe(false);
    expect(isCadKernelReply({ ...reply, result: { ...result, meshes: [...meshes.slice(0, -1), { ...meshes.at(-1), volume: NaN }] } })).toBe(false);
    expect(isCadKernelReply({ ...reply, result: { ...result, meshes: [...meshes.slice(0, -1), meshes[0]] } })).toBe(false);
    const invalid = client.build(createCadDocument()), rejected = expect(invalid).rejects.toMatchObject({ code: 'kernel-unavailable', kernelMessage: 'The reply does not follow the kernel protocol.' });
    transport.onmessage?.(new MessageEvent('message', { data: { id: 2, kind: 'built', result: {
      ...result, meshes: [...meshes.slice(0, -1), { ...meshes.at(-1), indices: [0, 1, 999] }],
    } } }));
    await rejected; expect(transport.terminated).toBe(true);
  } finally { client.dispose(); }
});
