import { describe, expect, it, vi } from 'vitest';
import { CAD_KERNEL_NOT_SENT, CAD_KERNEL_NOT_STARTED, CAD_KERNEL_STOPPED, CAD_KERNEL_UNREADABLE, createCadKernelClient, type CadWorkerTransport } from './cadKernelClient';
import { CadError } from '../../../domain/cad/cadError';
import type { CadKernelRequest } from './cadKernelProtocol';
import { createCadDocument } from '../../../domain/cad/cadSchema';
import { isCadKernelReply } from './cadKernelProtocol';
import type { CadTopologyInspectResult } from '../../../domain/cad/cadTopology';
import { MAX_CAD_DIAGNOSTIC_MESSAGE, MAX_CAD_KERNEL_MESSAGE, cadBoundedText } from '../../../domain/cad/cadIssueCodes';
import { cadKernelRequestFailure } from './cadKernelFailures';

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
  it('admits build diagnostics only with well-formed, bounded details and the facts their code carries', () => {
    const reply = (...diagnostics: unknown[]) => ({ id: 1, kind: 'built', result: { buildId: 'diagnosed', meshes: [], diagnostics, durationMs: 1 } });
    const failure = { code: 'kernel-operation-failed', featureId: 'round', message: 'The fillet could not be applied.' };
    const details = { operation: 'fillet', input: { field: 'targetId', id: 'box' }, kernelMessage: 'BRep_API: command not done' };
    const stop = { code: 'rebuild-stopped', featureId: 'round', message: 'Rebuild stopped here.' };
    // A reply without details, as the kernel gave before it named its steps, and one with them.
    expect(isCadKernelReply(reply(failure, stop))).toBe(true);
    expect(isCadKernelReply(reply({ ...failure, details }, stop))).toBe(true);
    expect(isCadKernelReply(reply({ ...failure, details: { ...details, input: null, kernelMessage: null } }))).toBe(true);
    for (const changed of [{ operation: 'nonsense' }, { input: { field: [], id: {} } }, { input: { field: 'targetId' } }, { input: { field: 'targetId', id: 'box', extra: 1 } },
      { input: { field: 'f'.repeat(65), id: 'box' } }, { input: { field: 'targetId', id: 'i'.repeat(97) } }, { kernelMessage: {} }, { kernelMessage: 3 },
      { kernelMessage: '' }, { note: 'free text' }]) {
      expect(isCadKernelReply(reply({ ...failure, details: { ...details, ...changed } })), JSON.stringify(changed).slice(0, 80)).toBe(false);
    }
    expect(isCadKernelReply(reply({ ...failure, details: [] }))).toBe(false);
    // A code that carries facts gives them, in range; no other code gives any.
    const mismatch = { ...failure, code: 'selection-count-mismatch', message: 'Matched 3, requires 2.' };
    expect(isCadKernelReply(reply({ ...mismatch, facts: { expected: 2, actual: 3 } }))).toBe(true);
    expect(isCadKernelReply(reply({ ...mismatch, code: 'selection-empty', facts: { expected: null } }))).toBe(true);
    for (const facts of [undefined, { expected: 2 }, { expected: 2, actual: 2 }, { expected: 2, actual: 0 }, { expected: 0, actual: 1 }, { expected: 2, actual: 1.5 },
      { expected: 2, actual: 3, extra: 1 }, { expected: '2', actual: 3 }, null]) {
      expect(isCadKernelReply(reply({ ...mismatch, facts })), JSON.stringify(facts)).toBe(false);
    }
    expect(isCadKernelReply(reply({ ...failure, facts: { expected: 2, actual: 3 } }))).toBe(false);
    // A stop follows a failure of the feature it stopped at.
    expect(isCadKernelReply(reply(stop))).toBe(false);
    expect(isCadKernelReply(reply({ ...failure, featureId: 'other' }, stop))).toBe(false);
    expect(isCadKernelReply(reply(failure, { ...stop, featureId: undefined }))).toBe(false);
    expect(isCadKernelReply(reply(failure, { ...stop, details }))).toBe(false);
  });
  it('takes in kernel text longer than its bound and a code no registry lists without losing the meshes before them', async () => {
    const mesh = { featureId: 'body', name: 'Body', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2], edges: [], volume: 1,
      faceGroups: [{ start: 0, count: 3, key: 'face' }], edgeGroups: [], bounds: { min: [0, 0, 0], max: [1, 1, 1] } };
    const long = { code: 'kernel-operation-failed', featureId: 'round', message: 'The fillet could not be applied.',
      details: { operation: 'fillet', input: { field: 'targetId', id: 'body' }, kernelMessage: 'x'.repeat(2049) } };
    const unregistered = { code: 'new-dynamic-refusal', featureId: 'later', message: 'The later feature failed.' };
    const reply = { id: 1, kind: 'built', result: { buildId: 'long', meshes: [mesh], diagnostics: [long, unregistered], durationMs: 1 } };
    expect(isCadKernelReply(reply)).toBe(true);
    const transport = new TestTransport(), client = createCadKernelClient(() => transport), pending = client.build(createCadDocument());
    transport.onmessage?.(new MessageEvent('message', { data: reply }));
    const result = await pending;
    expect(result.meshes).toEqual([mesh]);
    expect(result.diagnostics).toEqual([{ ...long, details: { ...long.details, kernelMessage: `${'x'.repeat(2047)}…` } },
      { ...unregistered, code: 'kernel-unrecognised', facts: { refusalCode: 'new-dynamic-refusal' } }]);
    expect(transport.terminated).toBe(false); client.dispose();
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
    const pending = client.build(createCadDocument()); const rejected = expect(pending).rejects.toMatchObject({ code: 'kernel-unavailable', kernelMessage: 'The reply does not follow the kernel protocol.' });
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
    const rejected = expect(first).rejects.toMatchObject({ code: 'kernel-unavailable', message: CAD_KERNEL_STOPPED, kernelMessage: 'Uncaught RangeError: Maximum call stack size exceeded' });
    const queued = Array.from({ length: 4 }, () => client.build(createCadDocument()));
    // A full queue refuses the request without touching the worker, and is no failure of the kernel.
    const full = await client.build(createCadDocument()).catch((error: unknown) => error);
    expect([full instanceof CadError, (full as Error).message]).toEqual([false, 'The CAD queue is full. Wait for the current operations to finish.']);
    transports[0].onerror?.(new ErrorEvent('error', { message: 'Uncaught RangeError: Maximum call stack size exceeded' }));
    await rejected; expect(transports[0].terminated).toBe(true);
    for (let id = 2; id <= 5; id++) transports[1].reply(id);
    await Promise.all(queued); client.dispose();
  });

  it('fails the requests of a worker that cannot start, refuses a request, fails or replies unreadably as an unavailable kernel, and starts a new one for the next', async () => {
    const denial = "Failed to construct 'Worker': Access to the script is denied by the document Content Security Policy.";
    const transports: TestTransport[] = [];
    let startup: Error | undefined = new Error(denial);
    const client = createCadKernelClient(() => {
      if (startup) { const error = startup; startup = undefined; throw error; }
      const transport = new TestTransport(); transports.push(transport); return transport;
    });
    try {
      // The browser refuses the worker: the request fails with the browser's words under the kernel's message, and the next one starts afresh.
      expect(await client.build(createCadDocument()).catch((error: unknown) => error))
        .toMatchObject({ name: 'CadError', code: 'kernel-unavailable', message: CAD_KERNEL_NOT_STARTED, kernelMessage: expect.stringContaining('Content Security Policy') });
      const refused = new TestTransport(); refused.postMessage = () => { throw new DOMException('The object could not be cloned.', 'DataCloneError'); };
      const once = createCadKernelClient(() => refused);
      await expect(once.build(createCadDocument())).rejects.toMatchObject({ code: 'kernel-unavailable', message: CAD_KERNEL_NOT_SENT, kernelMessage: 'The object could not be cloned.' });
      expect(refused.terminated).toBe(true); once.dispose();
      // A worker whose script fails to load gives a plain error event, without words of its own.
      const unloaded = client.build(createCadDocument());
      transports[0].onerror?.(new Event('error') as ErrorEvent);
      const failure = await unloaded.catch((error: unknown) => error);
      expect([failure, (failure as CadError).kernelMessage, transports[0].terminated]).toEqual([expect.objectContaining({ code: 'kernel-unavailable', message: CAD_KERNEL_STOPPED }), undefined, true]);
      // A reply that cannot be deserialized.
      const unread = client.build(createCadDocument());
      transports[1].onmessageerror?.(new MessageEvent('messageerror'));
      await expect(unread).rejects.toMatchObject({ code: 'kernel-unavailable', message: CAD_KERNEL_UNREADABLE, kernelMessage: 'The reply could not be deserialized.' });
      expect(transports[1].terminated).toBe(true);
      const next = client.build(createCadDocument()); transports[2].reply(4); await next;
      // Cancellation and disposal stay apart from kernel failures.
      const controller = new AbortController(), cancelled = client.build(createCadDocument(), controller.signal);
      controller.abort();
      expect(await cancelled.catch((error: unknown) => error)).toMatchObject({ name: 'AbortError' });
      const pending = client.build(createCadDocument()); client.dispose();
      const disposed = await pending.catch((error: unknown) => error);
      expect([disposed instanceof CadError, (disposed as Error).name]).toEqual([false, 'AbortError']);
      expect(await client.build(createCadDocument()).catch((error: unknown) => error instanceof CadError ? 'kernel failure' : (error as Error).message)).toBe('CAD kernel client has been disposed.');
    } finally { client.dispose(); }
  });

  it('retires a worker whose kernel could not load, so a queued request and the next one start another, while any other refusal keeps it', async () => {
    const transports: TestTransport[] = [];
    const client = createCadKernelClient(() => { const transport = new TestTransport(); transports.push(transport); return transport; });
    const unloaded = (id: number) => ({ id, kind: 'error', code: 'kernel-unavailable', kernelMessage: 'WebAssembly.instantiate(): out of memory',
      message: 'The CAD kernel could not be loaded. Reload the page; if this repeats, use a browser that runs WebAssembly.' });
    try {
      const first = client.build(createCadDocument()).catch((error: unknown) => error), queued = client.build(createCadDocument());
      transports[0].onmessage?.(new MessageEvent('message', { data: unloaded(1) }));
      expect(await first).toMatchObject({ name: 'CadError', code: 'kernel-unavailable', kernelMessage: 'WebAssembly.instantiate(): out of memory' });
      // The queued request goes to a new worker, which builds it.
      expect([transports.length, transports[0].terminated, transports[1].messages.map(message => message.id)]).toEqual([2, true, [2]]);
      transports[1].reply(2); await queued;
      // So does the next request after another such failure.
      const again = client.build(createCadDocument()).catch((error: unknown) => error);
      transports[1].onmessage?.(new MessageEvent('message', { data: unloaded(3) }));
      expect(await again).toMatchObject({ code: 'kernel-unavailable' }); expect(transports[1].terminated).toBe(true);
      const next = client.build(createCadDocument()); transports[2].reply(4); await next;
      // A refusal of a worker whose kernel runs leaves it running.
      const refused = client.build(createCadDocument()).catch((error: unknown) => error);
      transports[2].onmessage?.(new MessageEvent('message', { data: { id: 5, kind: 'error', code: 'invalid-parameter-metadata', message: 'Parameter metadata refers to missing parameter "width".' } }));
      expect(await refused).toMatchObject({ code: 'invalid-parameter-metadata' });
      expect([transports.length, transports[2].terminated]).toEqual([3, false]);
    } finally { client.dispose(); }
  });

  it('never takes text a worker did not write as an app refusal for the message: a reply without a code is the request failing, its text apart', async () => {
    const transport = new TestTransport(), client = createCadKernelClient(() => transport);
    const words = 'BRep_API: command not done', long = 'Standard_Failure '.repeat(400).slice(0, MAX_CAD_DIAGNOSTIC_MESSAGE);
    const requests = [
      ['build', () => client.build(createCadDocument())],
      ['export', () => client.export(createCadDocument(), 'step')],
      ['section', () => client.section(createCadDocument(), { bodyId: 'body', plane: 'XY', offset: 2.5 })]
    ] as const;
    // Every shape of error reply the protocol admits: without a code, its text as the message, apart from it, both, or none; with a code.
    const shapes: readonly (readonly [Record<string, unknown>, { readonly code: string; readonly message?: string; readonly kernelMessage?: string }])[] = [
      [{ message: words }, { code: 'kernel-operation-failed', kernelMessage: words }],
      [{ message: words, kernelMessage: 'Standard_ConstructionError' }, { code: 'kernel-operation-failed', kernelMessage: 'Standard_ConstructionError' }],
      [{ message: long }, { code: 'kernel-operation-failed', kernelMessage: cadBoundedText(long, MAX_CAD_KERNEL_MESSAGE) }],
      [{ message: '' }, { code: 'kernel-operation-failed' }],
      [{ code: 'kernel-operation-failed', message: 'The part could not be rebuilt.', kernelMessage: words }, { code: 'kernel-operation-failed', message: 'The part could not be rebuilt.', kernelMessage: words }],
      [{ code: 'invalid-section', message: 'Choose a body to section.' }, { code: 'invalid-section', message: 'Choose a body to section.' }]
    ];
    let id = 0;
    try {
      for (const [kind, send] of requests) for (const [reply, expected] of shapes) {
        const failure = send().catch((error: unknown) => error);
        transport.onmessage?.(new MessageEvent('message', { data: { id: ++id, kind: 'error', ...reply } }));
        const received = await failure as CadError;
        const message = expected.message ?? cadKernelRequestFailure(kind, words).message;
        expect([received instanceof CadError, received.code, received.message, received.kernelMessage], `${kind} ${JSON.stringify(reply).slice(0, 80)}`)
          .toEqual([true, expected.code, message, expected.kernelMessage]);
        // A worker's text reaches the message only as an app refusal it carries under a code.
        if (reply.code === undefined) expect(received.message).not.toBe(reply.message);
      }
      expect(transport.terminated).toBe(false);
    } finally { client.dispose(); }
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
