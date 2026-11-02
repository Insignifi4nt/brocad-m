import nativeWasmUrl from '../../../../packages/sketch-solver/wasm/sketch_solver.wasm?url';
import { createCadSketchNativeRuntime } from './cadSketchNativeRuntime';
import { createCadSketchNativeModuleLoader } from './native/cadSketchNativeModule';
import { loadCadSketchNativeSolver } from './native/cadSketchNativeSolver';
import type { CadSketchSolveInput } from './cadSketchSolverTypes';
import { cadSketchSolverWireResult, isCadSketchSolverEnvelope, type CadSketchSolverWireReply } from './cadSketchSolverProtocol';
import { CadSketchSolverFailure } from './cadSketchSolverFailure';

// Compiled once; a failed instance is replaced by a fresh instantiation of the same module, and a
// failed download is fetched again by the runtime's next load attempt.
const nativeModule = createCadSketchNativeModuleLoader(nativeWasmUrl);
const runtime = createCadSketchNativeRuntime({ loadNative: async () => loadCadSketchNativeSolver(await nativeModule()) });
let queue = Promise.resolve();
self.addEventListener('message', (event: MessageEvent<unknown>) => {
  const value = event.data;
  if (!isCadSketchSolverEnvelope(value)) return;
  queue = queue.then(async () => {
    let reply: CadSketchSolverWireReply;
    try {
      // The runtime owns input parsing; an invalid graph returns its invalid-input rejection.
      if (value.kind !== 'solve' || !('input' in value)) throw new Error('Invalid sketch solver request.');
      reply = { id: value.id, kind: 'result', result: cadSketchSolverWireResult(await runtime.solve(value.input as CadSketchSolveInput)) };
    } catch (error) {
      // The native solver's failure goes by name, with its own words; the client words it.
      reply = error instanceof CadSketchSolverFailure && error.native ? { id: value.id, kind: 'error', failure: error.native, message: (error.kernelMessage ?? '').slice(0, 8192) }
        : { id: value.id, kind: 'error', message: error instanceof Error ? error.message.slice(0, 8192) : 'Sketch solving failed.' };
    }
    try { self.postMessage(reply); }
    catch { self.postMessage({ id: value.id, kind: 'error', message: 'The sketch solver reply could not be sent.' } satisfies CadSketchSolverWireReply); }
  }).catch(() => undefined); // One failed reply must never wedge later requests.
});
