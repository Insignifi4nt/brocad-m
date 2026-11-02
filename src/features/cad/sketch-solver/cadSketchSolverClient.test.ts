// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { parseCadSketchGraph } from '../../../domain/cad/cadSketchGraph';
import { CAD_SKETCH_SOLVE_TIMEOUT_MS, createCadSketchSolverClient, type CadSketchSolverTransport } from './cadSketchSolverClient';
import { cadSketchSolverWireResult, type CadSketchSolverRequest } from './cadSketchSolverProtocol';
import type { CadSketchSolveResult } from './cadSketchSolverTypes';
import { CAD_SKETCH_NATIVE_FAILED, CAD_SKETCH_NATIVE_INCOMPATIBLE, CAD_SKETCH_NATIVE_LOAD_FAILED, CAD_SKETCH_SOLVER_ERROR, CAD_SKETCH_SOLVER_NOT_SENT, CAD_SKETCH_SOLVER_NOT_STARTED,
  CAD_SKETCH_SOLVER_STOPPED, CAD_SKETCH_SOLVER_TIMEOUT, CAD_SKETCH_SOLVER_UNREADABLE,
  CadSketchSolverFailure } from './cadSketchSolverFailure';

class Transport implements CadSketchSolverTransport {
  onmessage: CadSketchSolverTransport['onmessage'] = null;
  onerror: CadSketchSolverTransport['onerror'] = null;
  onmessageerror: CadSketchSolverTransport['onmessageerror'] = null;
  messages: CadSketchSolverRequest[] = [];
  terminated = false;
  postMessage(message: CadSketchSolverRequest) { this.messages.push(message); }
  terminate() { this.terminated = true; }
}
const graph = parseCadSketchGraph({ points: [{ id: 'point', position: [0, 0] }], entities: [], relations: [] });
const result: CadSketchSolveResult = { kind: 'solved', graph, diagnostics: { status: 'success', degreesOfFreedom: 2, conflictingIds: [], redundantIds: [], partiallyRedundantIds: [], issues: [] } };
// The worker sends solved values; the client rebuilds the graph from its own request.
const reply = cadSketchSolverWireResult(result);

describe('sketch solver worker lifetime', () => {
  it('starts lazily, cancels an active solve without terminating the warm worker, and drops its stale reply', async () => {
    const transports: Transport[] = [], client = createCadSketchSolverClient(() => { const worker = new Transport(); transports.push(worker); return worker; });
    expect(transports).toHaveLength(0);
    const signal = new AbortController(), canceled = client.solve({ graph, parameters: {} }, signal.signal);
    const rejected = expect(canceled).rejects.toMatchObject({ name: 'AbortError' });
    signal.abort(); await rejected;
    expect(transports).toHaveLength(1); expect(transports[0].terminated).toBe(false);
    const next = client.solve({ graph, parameters: {} });
    // The canceled request still owns the single in-flight slot until its reply arrives.
    expect(transports[0].messages.map(message => message.id)).toEqual([1]);
    transports[0].onmessage?.(new MessageEvent('message', { data: { id: 1, kind: 'result', result: reply } }));
    expect(transports[0].messages.map(message => message.id)).toEqual([1, 2]);
    transports[0].onmessage?.(new MessageEvent('message', { data: { id: 1, kind: 'result', result: reply } }));
    transports[0].onmessage?.(new MessageEvent('message', { data: { id: 2, kind: 'result', result: reply } }));
    expect(await next).toEqual(result); expect(transports).toHaveLength(1); expect(transports[0].terminated).toBe(false);
    client.dispose(); expect(transports[0].terminated).toBe(true);
  });
  it('still terminates a canceled solve that later exceeds its time limit', async () => {
    vi.useFakeTimers();
    const workers: Transport[] = [], client = createCadSketchSolverClient(() => { const worker = new Transport(); workers.push(worker); return worker; });
    try {
      const controller = new AbortController(), pending = client.solve({ graph, parameters: {} }, controller.signal);
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      controller.abort(); await rejected;
      await vi.advanceTimersByTimeAsync(CAD_SKETCH_SOLVE_TIMEOUT_MS);
      expect(workers[0].terminated).toBe(true); expect(vi.getTimerCount()).toBe(0);
    } finally { client.dispose(); vi.useRealTimers(); }
  });
  it('bounds queued work and rejects every outstanding request on disposal', async () => {
    const worker = new Transport(), client = createCadSketchSolverClient(() => worker);
    const pending = Array.from({ length: 5 }, () => client.solve({ graph, parameters: {} }));
    const full = await client.solve({ graph, parameters: {} }).catch((error: unknown) => error);
    expect(full).toBeInstanceOf(Error); expect(full).not.toBeInstanceOf(CadSketchSolverFailure); expect((full as Error).message).toMatch('queue is full');
    expect(worker.messages).toHaveLength(1);
    client.dispose();
    const settled = await Promise.allSettled(pending);
    expect(settled.every(result => result.status === 'rejected' && result.reason instanceof Error && result.reason.name === 'AbortError' && !(result.reason instanceof CadSketchSolverFailure))).toBe(true);
    expect(worker.terminated).toBe(true);
    const disposed = await client.solve({ graph, parameters: {} }).catch((error: unknown) => error);
    expect(disposed).not.toBeInstanceOf(CadSketchSolverFailure); expect((disposed as Error).message).toMatch('disposed');
  });
  it('terminates a timed-out worker and only retries through a new explicit request', async () => {
    vi.useFakeTimers();
    const workers: Transport[] = [], client = createCadSketchSolverClient(() => { const worker = new Transport(); workers.push(worker); return worker; });
    try {
      const pending = client.solve({ graph, parameters: {} }), rejected = expect(pending).rejects.toMatchObject({ code: 'sketch-failed', message: CAD_SKETCH_SOLVER_TIMEOUT });
      await vi.advanceTimersByTimeAsync(CAD_SKETCH_SOLVE_TIMEOUT_MS); await rejected;
      expect(workers).toHaveLength(1); expect(workers[0].terminated).toBe(true);
      const retry = client.solve({ graph, parameters: {} });
      workers[1].onmessage?.(new MessageEvent('message', { data: { id: 2, kind: 'result', result: reply } }));
      expect(await retry).toEqual(result); expect(vi.getTimerCount()).toBe(0);
    } finally { client.dispose(); vi.useRealTimers(); }
  });
  it('rejects values for a changed expression driver at the worker boundary as an unreadable reply and restarts after worker errors', async () => {
    const workers: Transport[] = [], client = createCadSketchSolverClient(() => { const worker = new Transport(); workers.push(worker); return worker; });
    const driven = parseCadSketchGraph({ ...graph, points: [{ id: 'point', position: ['x', 0] }] });
    const pending = client.solve({ graph: driven, parameters: { x: 4 } });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'sketch-failed', message: CAD_SKETCH_SOLVER_UNREADABLE, kernelMessage: expect.stringContaining('does not match') });
    workers[0].onmessage?.(new MessageEvent('message', { data: { id: 1, kind: 'result', result: { ...reply, values: [4, 0] } } }));
    await rejected; expect(workers[0].terminated).toBe(true);
    const retry = client.solve({ graph, parameters: {} }), stopped = expect(retry).rejects.toMatchObject({ code: 'sketch-failed', message: CAD_SKETCH_SOLVER_STOPPED, kernelMessage: 'stopped' });
    workers[1].onerror?.(Object.assign(new Event('error'), { message: 'stopped', filename: '', lineno: 0, colno: 0, error: new Error('stopped') })); await stopped;
    expect(workers).toHaveLength(2); expect(workers[1].terminated).toBe(true);
    client.dispose();
  });
  it('fails the request of a worker that cannot start, refuses the sketch, fails, replies unreadably or replies with an error as a coded solver failure, and starts a new worker for the next', async () => {
    const workers: Transport[] = [];
    let refuseStart = true, refuseHandOver = false;
    const client = createCadSketchSolverClient(() => {
      if (refuseStart) throw new DOMException('Refused to create a worker: blocked by the content security policy.', 'SecurityError');
      const worker = new Transport();
      if (refuseHandOver) worker.postMessage = () => { throw new DOMException('The object could not be cloned.', 'DataCloneError'); };
      workers.push(worker); return worker;
    });
    const failure = (pending: Promise<unknown>) => pending.then(() => { throw new Error('The solve did not fail.'); }, (error: unknown) => error as CadSketchSolverFailure);
    const started = await failure(client.solve({ graph, parameters: {} }));
    expect(started).toBeInstanceOf(CadSketchSolverFailure);
    expect(started).toMatchObject({ code: 'sketch-failed', message: CAD_SKETCH_SOLVER_NOT_STARTED, kernelMessage: 'Refused to create a worker: blocked by the content security policy.' });
    expect(workers).toHaveLength(0);
    refuseStart = false; refuseHandOver = true;
    expect(await failure(client.solve({ graph, parameters: {} }))).toMatchObject({ code: 'sketch-failed', message: CAD_SKETCH_SOLVER_NOT_SENT, kernelMessage: 'The object could not be cloned.' });
    expect(workers).toHaveLength(1); expect(workers[0].terminated).toBe(true);
    refuseHandOver = false;
    // Each failure stops its worker; the next request starts a new one and the late events of the stopped worker are ignored.
    const cases: readonly [string, (worker: Transport) => void, string, unknown][] = [
      ['error event', worker => worker.onerror?.(Object.assign(new Event('error'), { message: 'Uncaught RangeError: out of memory' }) as ErrorEvent), CAD_SKETCH_SOLVER_STOPPED, 'Uncaught RangeError: out of memory'],
      ['script that failed to load', worker => worker.onerror?.(new Event('error') as ErrorEvent), CAD_SKETCH_SOLVER_STOPPED, undefined],
      ['undeserializable reply', worker => worker.onmessageerror?.(new MessageEvent('messageerror')), CAD_SKETCH_SOLVER_UNREADABLE, 'The reply could not be deserialized.'],
      ['reply off the protocol', worker => worker.onmessage?.(new MessageEvent('message', { data: { id: worker.messages[0].id, kind: 'noise' } })), CAD_SKETCH_SOLVER_UNREADABLE, expect.any(String)],
      ['error reply', worker => worker.onmessage?.(new MessageEvent('message', { data: { id: worker.messages[0].id, kind: 'error', message: 'unreachable code' } })), CAD_SKETCH_SOLVER_ERROR, 'unreachable code']
    ];
    for (const [name, act, message, words] of cases) {
      const pending = failure(client.solve({ graph, parameters: {} })), worker = workers.at(-1)!;
      act(worker);
      const error = await pending;
      expect(error, name).toBeInstanceOf(CadSketchSolverFailure);
      expect({ code: error.code, message: error.message }, name).toEqual({ code: 'sketch-failed', message });
      expect(error.kernelMessage, name).toEqual(words);
      expect(worker.terminated, name).toBe(true);
      worker.onmessage?.(new MessageEvent('message', { data: { id: worker.messages[0].id, kind: 'result', result: reply } }));
    }
    expect(workers).toHaveLength(6);
    const next = client.solve({ graph, parameters: {} });
    expect(workers).toHaveLength(7);
    workers[6].onmessage?.(new MessageEvent('message', { data: { id: workers[6].messages[0].id, kind: 'result', result: reply } }));
    expect(await next).toEqual(result); expect(workers[6].terminated).toBe(false);
    client.dispose();
  });
  it('fails a request whose worker names how the native solver failed as that failure, worded here, and keeps the worker for the request waiting', async () => {
    const workers: Transport[] = [], client = createCadSketchSolverClient(() => { const worker = new Transport(); workers.push(worker); return worker; });
    const failure = (pending: Promise<unknown>) => pending.then(() => { throw new Error('The solve did not fail.'); }, (error: unknown) => error as CadSketchSolverFailure);
    for (const [failed, message] of [['load-failed', CAD_SKETCH_NATIVE_LOAD_FAILED], ['incompatible', CAD_SKETCH_NATIVE_INCOMPATIBLE], ['failed', CAD_SKETCH_NATIVE_FAILED]] as const) {
      const pending = failure(client.solve({ graph, parameters: {} })), waiting = client.solve({ graph, parameters: {} }), worker = workers[0];
      const posted = worker.messages.length;
      worker.onmessage?.(new MessageEvent('message', { data: { id: worker.messages.at(-1)!.id, kind: 'error', failure: failed, message: 'unreachable' } }));
      const error = await pending;
      expect(error, failed).toBeInstanceOf(CadSketchSolverFailure);
      expect({ code: error.code, message: error.message, native: error.native, kernelMessage: error.kernelMessage }, failed).toEqual({ code: 'sketch-failed', message, native: failed, kernelMessage: 'unreachable' });
      // The worker dropped its failed instance; the request waiting goes to it.
      expect(worker.terminated, failed).toBe(false); expect(worker.messages, failed).toHaveLength(posted + 1);
      const next = worker.messages.at(-1)!;
      worker.onmessage?.(new MessageEvent('message', { data: { id: next.id, kind: 'result', result: reply } }));
      expect(await waiting).toEqual(result);
    }
    expect(workers).toHaveLength(1);
    // A failure the workbench does not know is an unreadable reply, which stops the worker.
    const pending = failure(client.solve({ graph, parameters: {} }));
    workers[0].onmessage?.(new MessageEvent('message', { data: { id: workers[0].messages.at(-1)!.id, kind: 'error', failure: 'melted', message: 'Reload now!' } }));
    expect(await pending).toMatchObject({ code: 'sketch-failed', message: CAD_SKETCH_SOLVER_UNREADABLE });
    expect(workers[0].terminated).toBe(true);
    client.dispose();
  });
  it('cancels a waiting solve without disturbing the active worker', async () => {
    const worker = new Transport(), client = createCadSketchSolverClient(() => worker);
    const active = client.solve({ graph, parameters: {} });
    const controller = new AbortController(), waiting = client.solve({ graph, parameters: {} }, controller.signal);
    const canceled = expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort(); await canceled;
    expect(worker.terminated).toBe(false); expect(worker.messages).toHaveLength(1);
    worker.onmessage?.(new MessageEvent('message', { data: { id: 1, kind: 'result', result: reply } }));
    expect(await active).toEqual(result); client.dispose();
  });
});
