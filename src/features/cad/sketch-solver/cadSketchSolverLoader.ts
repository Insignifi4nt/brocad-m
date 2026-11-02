import { CAD_SKETCH_SOLVER_NOT_LOADED, CadSketchSolverFailure } from './cadSketchSolverFailure';
import type { CadSketchSolverClient } from './cadSketchSolverTypes';

/**
 * The sketch solver, loaded once when a request first needs it. A load that fails, as when the app was updated and its old module is gone
 * or the network dropped, fails any sketch alike, so it is the solver failing rather than judging the sketch: a `CadSketchSolverFailure`
 * whose message names that cause and the next step, with the browser's own words as its kernel message. A failed load is not kept, so the
 * next request loads the solver again.
 */
export interface CadSketchSolverLoader {
  /** The loaded solver, which the inspection of a sketch waits for. */
  load(): Promise<CadSketchSolverClient>;
  /**
   * A solver that starts the load now and waits for it when it first solves, so a load that fails refuses the sketch being solved, which
   * edit preparation names.
   */
  solver(): Pick<CadSketchSolverClient, 'solve'>;
  /** Disposes the solver once it is loaded, and keeps none. */
  dispose(): void;
}

export function createCadSketchSolverLoader(load: () => Promise<CadSketchSolverClient>): CadSketchSolverLoader {
  let loaded: Promise<CadSketchSolverClient> | null = null;
  const get = () => {
    if (loaded) return loaded;
    // A load that throws rather than rejects fails the same way.
    const pending = new Promise<CadSketchSolverClient>(resolve => resolve(load())).catch((error: unknown) => { throw new CadSketchSolverFailure(CAD_SKETCH_SOLVER_NOT_LOADED, error); });
    loaded = pending;
    void pending.catch(() => { if (loaded === pending) loaded = null; });
    return pending;
  };
  return {
    load: get,
    solver() {
      const loading = get();
      return { solve: async (input, signal) => (await loading).solve(input, signal) };
    },
    dispose() { void loaded?.then(client => client.dispose(), () => undefined); loaded = null; }
  };
}
