import { CadError } from '@/domain/cad/cadError';
import { MAX_CAD_KERNEL_MESSAGE, cadBoundedText } from '@/domain/cad/cadIssueCodes';

/** The solver's module could not be loaded, as when the app was updated and the old module is gone, or the network dropped. */
export const CAD_SKETCH_SOLVER_NOT_LOADED = 'The sketch solver could not be loaded; the app may have been updated, or the network dropped. Reload the page.';
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
/** No native solver instance could be loaded within the solve. */
export const CAD_SKETCH_NATIVE_LOAD_FAILED = 'The sketch solver could not be loaded. Edit the sketch again to retry, or reload the page.';
/** The native module speaks another protocol, or lacks the solver's exports or imports. */
export const CAD_SKETCH_NATIVE_INCOMPATIBLE = 'The sketch solver does not match this version of the app. Reload the page.';
/** The native instance trapped or returned an invalid result, also on a fresh instance when a used one failed first. */
export const CAD_SKETCH_NATIVE_FAILED = 'The sketch solver failed on this sketch and was stopped. Edit the sketch again to restart it; if this repeats, reload the page.';

/** How the native solver failed, which its worker names in a reply so the client words it. */
export type CadSketchNativeFailure = 'load-failed' | 'incompatible' | 'failed';
const NATIVE_FAILURES: Readonly<Record<CadSketchNativeFailure, string>> = Object.freeze({
  'load-failed': CAD_SKETCH_NATIVE_LOAD_FAILED, incompatible: CAD_SKETCH_NATIVE_INCOMPATIBLE, failed: CAD_SKETCH_NATIVE_FAILED
});
export const isCadSketchNativeFailure = (value: unknown): value is CadSketchNativeFailure => typeof value === 'string' && Object.hasOwn(NATIVE_FAILURES, value);

/**
 * A failure of the solver rather than its judgement of the sketch, which fails any sketch alike: `sketch-failed`, as a solver that cannot
 * load already gives, with a message naming the cause and the next step and the browser's or the worker's own words, bounded, as its
 * kernel message. Edit preparation reports it as a refused edit of the sketch being solved, with the cause `solver-unavailable`; inspection
 * reports it as an unavailable analysis with that cause; and a drawing's inferred relations are never dropped for it. It is the one way the
 * solver says it failed: its loader, its worker client and the native runtime all throw it, and a solve result is always a judgement.
 */
export class CadSketchSolverFailure extends CadError<'sketch-failed'> {
  /** How the native solver failed, when the failure was the native solver's rather than its loader's or its worker's. */
  readonly native?: CadSketchNativeFailure;
  constructor(message: string, cause?: unknown) {
    super('sketch-failed', message);
    this.name = 'CadSketchSolverFailure';
    // A DOMException, which a refused worker or hand-over raises, need not be an Error of this realm.
    const words = typeof cause === 'object' && cause !== null ? (cause as { readonly message?: unknown }).message : cause;
    if (typeof words === 'string' && words) (this as { kernelMessage?: string }).kernelMessage = cadBoundedText(words, MAX_CAD_KERNEL_MESSAGE);
  }
}

/** The native solver's failure of this kind, worded by the workbench, with the trap's, the browser's or the module's words as its kernel message. */
export function cadSketchNativeFailure(native: CadSketchNativeFailure, cause?: unknown): CadSketchSolverFailure {
  const failure = new CadSketchSolverFailure(NATIVE_FAILURES[native], cause);
  (failure as { native?: CadSketchNativeFailure }).native = native;
  return failure;
}
