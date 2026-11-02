// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCadSketchGraph } from '@/domain/cad/cadSketchGraph';
import { createCadSketchSolverClient, type CadSketchSolverTransport } from './cadSketchSolverClient';
import { CAD_SKETCH_NATIVE_FAILED, CadSketchSolverFailure } from './cadSketchSolverFailure';
import type { CadSketchSolverRequest } from './cadSketchSolverProtocol';
import { loadCadSketchNativeSolver } from './native/cadSketchNativeSolver';

// The worker's module, read from its package file, and its real loader, which a test can make return a failing instance first.
vi.mock('./native/cadSketchNativeModule', async () => {
  const { readFileSync } = await import('node:fs');
  return { createCadSketchNativeModuleLoader: () => async () => WebAssembly.compile(readFileSync(new URL('../../../../packages/sketch-solver/wasm/sketch_solver.wasm', import.meta.url))) };
});
vi.mock('./native/cadSketchNativeSolver', async original => {
  const actual = await original<typeof import('./native/cadSketchNativeSolver')>();
  return { ...actual, loadCadSketchNativeSolver: vi.fn(actual.loadCadSketchNativeSolver) };
});

describe('sketch solver worker entry point', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('names how its native solver failed, with the trap\'s words, so the client words it and keeps the worker for the next solve on a fresh instance', async () => {
    let listener: ((event: MessageEvent<unknown>) => void) | undefined;
    const replies: unknown[] = [];
    vi.stubGlobal('self', { addEventListener: (_type: string, handle: typeof listener) => { listener = handle; }, postMessage: (reply: unknown) => { replies.push(reply); transport.onmessage?.(new MessageEvent('message', { data: reply })); } });
    // The first instance traps; the next is the real solver.
    vi.mocked(loadCadSketchNativeSolver).mockResolvedValueOnce({ memoryBytes: () => 0, solve: () => { throw new WebAssembly.RuntimeError('unreachable'); } });
    const transport: CadSketchSolverTransport & { terminated: boolean } = { onmessage: null, onerror: null, onmessageerror: null, terminated: false,
      postMessage: (request: CadSketchSolverRequest) => { listener?.(new MessageEvent('message', { data: request })); }, terminate() { this.terminated = true; } };
    await import('./cadSketchSolver.worker');
    const client = createCadSketchSolverClient(() => transport);
    const graph = parseCadSketchGraph({ points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [10, 0] }], entities: [], relations: [] });
    const failed = await client.solve({ graph, parameters: {} }).then(() => null, (error: unknown) => error);
    expect(replies[0]).toEqual({ id: 1, kind: 'error', failure: 'failed', message: 'unreachable' });
    expect(failed).toBeInstanceOf(CadSketchSolverFailure);
    expect(failed).toMatchObject({ code: 'sketch-failed', native: 'failed', message: CAD_SKETCH_NATIVE_FAILED, kernelMessage: 'unreachable' });
    expect(await client.solve({ graph, parameters: {} })).toMatchObject({ kind: 'solved' });
    expect(transport.terminated).toBe(false); expect(loadCadSketchNativeSolver).toHaveBeenCalledTimes(2);
    client.dispose();
  });
});
