import type { CadSketchSolverClient } from './cadSketchSolverTypes';
import { isCadSketchSolverEnvelope, parseCadSketchSolveInput, parseCadSketchSolverReply, type CadSketchSolverRequest } from './cadSketchSolverProtocol';
import type { CadSketchSolveResult } from './cadSketchSolverTypes';
import { solveFixedCadSketch } from './cadSketchFixedSolve';

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

/** At most one worker, one in-flight request and four waiting requests; failures are never replayed automatically. */
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
    try {
      if (!worker) {
        const transport = makeWorker(); worker = transport;
        transport.onmessage = event => {
          if (worker !== transport || !active) return;
          if (isCadSketchSolverEnvelope(event.data) && event.data.id !== active.request.id) return;
          try {
            const reply = parseCadSketchSolverReply(event.data, active.request.input);
            if (reply.id !== active.request.id) return;
            if (reply.kind === 'error') fail(new Error(reply.message)); else finish(reply.result);
          } catch (error) { fail(error instanceof Error ? error : new Error('Invalid sketch worker response.')); }
        };
        transport.onerror = () => { if (worker === transport) fail(new Error('The sketch solver worker stopped. Retry to restart it.')); };
        transport.onmessageerror = () => { if (worker === transport) fail(new Error('The sketch solver worker response could not be read.')); };
      }
      timer = setTimeout(() => fail(new Error('Sketch solving exceeded its time limit. Retry with a smaller sketch.')), CAD_SKETCH_SOLVE_TIMEOUT_MS);
      worker.postMessage(active.request);
    } catch (error) { fail(error instanceof Error ? error : new Error('Unable to start the sketch solver worker.')); }
  }
  return {
    solve(input, signal) {
      if (disposed) return Promise.reject(new Error('The sketch solver client has been disposed.'));
      if (signal?.aborted) return Promise.reject(canceled());
      if (queue.length >= 4) return Promise.reject(new Error('The sketch solve queue is full.'));
      let captured: ReturnType<typeof parseCadSketchSolveInput>;
      try { captured = parseCadSketchSolveInput(input); } catch (error) { return Promise.reject(error); }
      // A sketch with nothing free to move is its own solution, and never starts the worker.
      const fixed = solveFixedCadSketch(captured);
      if (fixed) return Promise.resolve(fixed);
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
