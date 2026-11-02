import { CadError } from '@/domain/cad/cadError';
import { MAX_CAD_KERNEL_MESSAGE, cadBoundedText } from '@/domain/cad/cadIssueCodes';

/** The browser refused to create the solver's worker, for example under a content security policy. */
export const CAD_SKETCH_SOLVER_NOT_STARTED = 'The browser could not start the sketch solver. Reload the page; if this repeats, use another browser or turn off extensions that block this site\'s scripts.';
/** The worker refused the request as it was handed over. */
export const CAD_SKETCH_SOLVER_NOT_SENT = 'The sketch could not be handed to the sketch solver, so the solver was stopped. Retry to restart it; if this repeats, reload the page.';
/** The worker raised an error it did not catch, or its script failed to load. */
export const CAD_SKETCH_SOLVER_STOPPED = 'The sketch solver failed with an unexpected error and was stopped. Retry to restart it; if this repeats, reload the page.';
/** The worker's reply could not be deserialized, or does not answer the request. */
export const CAD_SKETCH_SOLVER_UNREADABLE = 'The sketch solver\'s reply could not be read, so the solver was stopped. Retry to restart it; if this repeats, reload the page.';
/** The worker caught an error of its own and replied with its words, which name no cause the workbench knows. */
export const CAD_SKETCH_SOLVER_ERROR = 'The sketch solver failed on this sketch, for a reason it did not name, and was stopped. Retry to restart it; if this repeats, reload the page.';
/** The solve ran past `CAD_SKETCH_SOLVE_TIMEOUT_MS`. */
export const CAD_SKETCH_SOLVER_TIMEOUT = 'Sketch solving exceeded its time limit. Retry with a smaller sketch.';

/**
 * A failure of the solver rather than its judgement of the sketch, which fails any sketch alike: `sketch-failed`, as a solver that cannot
 * load already gives, with a message naming the cause and the next step and the browser's or the worker's own words, bounded, as its
 * kernel message. Edit preparation reports it as a refused edit of the sketch being solved, with the cause `solver-unavailable`.
 */
export class CadSketchSolverFailure extends CadError<'sketch-failed'> {
  constructor(message: string, cause?: unknown) {
    super('sketch-failed', message);
    this.name = 'CadSketchSolverFailure';
    // A DOMException, which a refused worker or hand-over raises, need not be an Error of this realm.
    const words = typeof cause === 'object' && cause !== null ? (cause as { readonly message?: unknown }).message : cause;
    if (typeof words === 'string' && words) (this as { kernelMessage?: string }).kernelMessage = cadBoundedText(words, MAX_CAD_KERNEL_MESSAGE);
  }
}
