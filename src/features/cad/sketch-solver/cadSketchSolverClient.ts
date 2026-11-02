import type { CadSketchSolverClient } from './cadSketchSolverTypes';
import { isCadSketchSolverEnvelope, parseCadSketchSolveInput, parseCadSketchSolverReply, type CadSketchSolverRequest } from './cadSketchSolverProtocol';
import type { CadSketchSolveResult } from './cadSketchSolverTypes';
import { CAD_SKETCH_SOLVER_ERROR, CAD_SKETCH_SOLVER_NOT_SENT, CAD_SKETCH_SOLVER_NOT_STARTED, CAD_SKETCH_SOLVER_STOPPED, CAD_SKETCH_SOLVER_TIMEOUT, CAD_SKETCH_SOLVER_UNREADABLE,
  CadSketchSolverFailure, cadSketchNativeFailure } from './cadSketchSolverFailure';

export interface CadSketchSolverTransport {
  postMessage(message: CadSketchSolverRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
}
interface Job {
  readonly request: CadSketchSolverRequest;
  resolve(result: CadSketchSolveResult): void;
  reject(error: Error): void;
  cleanup(): void;
  /** The caller already received AbortError; its reply is awaited only to free the worker slot. */
  canceled?: boolean;
}
export const CAD_SKETCH_SOLVE_TIMEOUT_MS = 15_000;
const canceled = () => new DOMException('Sketch solving canceled.', 'AbortError');

/**
 * At most one worker, one in-flight request and four waiting requests; failures are never replayed automatically. A worker that cannot start,
 * refuses a request, fails, replies unreadably, replies with an error or runs past its time limit fails the request as a `CadSketchSolverFailure`
 * and is stopped, so the next request starts a new one; cancellation, disposal and a full queue stay their own errors. A reply naming how the
 * native solver failed fails the request as that `CadSketchSolverFailure`, worded here with the reply's words as its kernel message, and keeps
 * the worker, which already dropped the failed instance and loads a fresh one for the next request.
 */
export function createCadSketchSolverClient(makeWorker: () => CadSketchSolverTransport = () => new Worker(new URL('./cadSketchSolver.worker.ts', import.meta.url), { type: 'module', name: 'wireedm-sketch-solver' })): CadSketchSolverClient {
  let worker: CadSketchSolverTransport | undefined, active: Job | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, disposed = false, id = 0;
  const queue: Job[] = [];
  function terminate() { worker?.terminate(); worker = undefined; }
  function finish(value: CadSketchSolveResult | Error) {
    const job = active;
    if (!job) return;
    clearTimeout(timer); timer = undefined; active = undefined; job.cleanup();
    if (!job.canceled) { if (value instanceof Error) job.reject(value); else job.resolve(value); }
    pump();
  }
  function fail(error: Error) { terminate(); finish(error); }
  function pump() {
    if (disposed || active || !queue.length) return;
    active = queue.shift(); if (!active) return;
    if (!worker) {
      let transport: CadSketchSolverTransport;
      try { transport = makeWorker(); } catch (error) { fail(new CadSketchSolverFailure(CAD_SKETCH_SOLVER_NOT_STARTED, error)); return; }
      worker = transport;
      transport.onmessage = event => {
        if (worker !== transport || !active) return;
        if (isCadSketchSolverEnvelope(event.data) && event.data.id !== active.request.id) return;
        let reply: ReturnType<typeof parseCadSketchSolverReply>;
        try { reply = parseCadSketchSolverReply(event.data, active.request.input); }
        catch (error) { fail(new CadSketchSolverFailure(CAD_SKETCH_SOLVER_UNREADABLE, error)); return; }
        if (reply.id !== active.request.id) return;
        if (reply.kind === 'result') finish(reply.result);
        else if (reply.failure) finish(cadSketchNativeFailure(reply.failure, reply.message));
        else fail(new CadSketchSolverFailure(CAD_SKETCH_SOLVER_ERROR, reply.message));
      };
      // An error event carries the worker's own words; a script that failed to load gives a plain event without them.
      transport.onerror = event => { if (worker === transport) fail(new CadSketchSolverFailure(CAD_SKETCH_SOLVER_STOPPED, (event as Partial<ErrorEvent> | null)?.message)); };
      transport.onmessageerror = () => { if (worker === transport) fail(new CadSketchSolverFailure(CAD_SKETCH_SOLVER_UNREADABLE, 'The reply could not be deserialized.')); };
    }
    timer = setTimeout(() => fail(new CadSketchSolverFailure(CAD_SKETCH_SOLVER_TIMEOUT)), CAD_SKETCH_SOLVE_TIMEOUT_MS);
    try { worker.postMessage(active.request); } catch (error) { fail(new CadSketchSolverFailure(CAD_SKETCH_SOLVER_NOT_SENT, error)); }
  }
  return {
    solve(input, signal) {
      if (disposed) return Promise.reject(new Error('The sketch solver client has been disposed.'));
      if (signal?.aborted) return Promise.reject(canceled());
      if (queue.length >= 4) return Promise.reject(new Error('The sketch solve queue is full.'));
      let captured: ReturnType<typeof parseCadSketchSolveInput>;
      try { captured = parseCadSketchSolveInput(input); } catch (error) { return Promise.reject(error); }
      return new Promise((resolve, reject) => {
        const cancel = () => {
          // Keep the warm worker: the caller settles now and the late reply is discarded.
          // Only a timeout or worker failure terminates the worker.
          if (active === job) { job.canceled = true; job.cleanup(); reject(canceled()); return; }
          const index = queue.indexOf(job);
          if (index >= 0) { queue.splice(index, 1); job.cleanup(); reject(canceled()); }
        };
        const job: Job = { request: { id: ++id, kind: 'solve', input: captured }, resolve, reject, cleanup: () => signal?.removeEventListener('abort', cancel) };
        signal?.addEventListener('abort', cancel, { once: true });
        queue.push(job); pump();
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true; clearTimeout(timer); terminate();
      if (active) { active.cleanup(); active.reject(canceled()); active = undefined; }
      for (const job of queue.splice(0)) { job.cleanup(); job.reject(canceled()); }
    }
  };
}
