import { describe, expect, it, vi } from 'vitest';
import { CAD_SKETCH_SOLVER_NOT_LOADED, CadSketchSolverFailure } from './cadSketchSolverFailure';
import { createCadSketchSolverLoader } from './cadSketchSolverLoader';
import type { CadSketchSolverClient } from './cadSketchSolverTypes';

/** What a browser gives when the module of an earlier build is gone after an update, or the network dropped. */
const CHUNK = 'Failed to fetch dynamically imported module: https://example.test/assets/cadSketchSolverClient-1a2b3c.js';
const client = (): CadSketchSolverClient => ({ solve: vi.fn(async () => ({ kind: 'rejected', reason: 'failed', message: 'Judged.' }) as never), dispose: vi.fn() });

describe('sketch solver loading', () => {
  it('gives a solver module that cannot be loaded as the solver failing, with the browser\'s words, and loads it again on the next request', async () => {
    const loaded = client(), load = vi.fn<() => Promise<CadSketchSolverClient>>().mockRejectedValueOnce(new TypeError(CHUNK)).mockResolvedValue(loaded);
    const loader = createCadSketchSolverLoader(load);
    const failed = await loader.load().then(() => null, (error: unknown) => error);
    expect(failed).toBeInstanceOf(CadSketchSolverFailure);
    expect(failed).toMatchObject({ code: 'sketch-failed', message: CAD_SKETCH_SOLVER_NOT_LOADED, kernelMessage: CHUNK });
    // The failed load is not kept: the next request loads the module again, and keeps what it loads.
    await expect(loader.load()).resolves.toBe(loaded);
    await expect(loader.load()).resolves.toBe(loaded);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('refuses through the solver it hands out, which starts the load at once and waits for it when it first solves', async () => {
    const loaded = client(), load = vi.fn<() => Promise<CadSketchSolverClient>>().mockRejectedValueOnce(new TypeError(CHUNK)).mockResolvedValue(loaded);
    const loader = createCadSketchSolverLoader(load);
    const failing = loader.solver();
    expect(load).toHaveBeenCalledTimes(1);
    await expect(failing.solve({ graph: { points: [], entities: [], relations: [] }, parameters: {} })).rejects.toMatchObject({ code: 'sketch-failed',
      message: CAD_SKETCH_SOLVER_NOT_LOADED, kernelMessage: CHUNK });
    // A later request's solver loads it again and solves with it.
    const input = { graph: { points: [], entities: [], relations: [] }, parameters: {} }, signal = new AbortController().signal;
    await expect(loader.solver().solve(input, signal)).resolves.toMatchObject({ kind: 'rejected', message: 'Judged.' });
    expect(loaded.solve).toHaveBeenCalledWith(input, signal);
  });

  it('fails the same way when setting the solver up throws, and disposes only a solver it loaded', async () => {
    const thrown = createCadSketchSolverLoader(() => { throw new Error('Worker is not defined'); });
    await expect(thrown.load()).rejects.toMatchObject({ code: 'sketch-failed', message: CAD_SKETCH_SOLVER_NOT_LOADED, kernelMessage: 'Worker is not defined' });
    thrown.dispose();
    const loaded = client(), loader = createCadSketchSolverLoader(async () => loaded);
    await loader.load(); loader.dispose();
    await Promise.resolve();
    expect(loaded.dispose).toHaveBeenCalledOnce();
  });
});
