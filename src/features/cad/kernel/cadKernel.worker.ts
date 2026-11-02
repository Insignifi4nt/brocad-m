import initOpenCascade from 'replicad-opencascadejs';
import wasmUrl from 'replicad-opencascadejs/wasm?url';
import { setOC } from 'replicad';
import { setCadDevelopmentChecks } from '@/domain/cad/cadDevelopmentChecks';
import { isCadKernelEnvelope } from './cadKernelProtocol';
import { createCadKernelRuntime } from './cadKernelRuntime';

setCadDevelopmentChecks(import.meta.env.DEV);

// This entire module is only loaded after the first explicit CAD operation.
let initialized: Promise<void> | undefined;
function initialize() {
  initialized ??= initOpenCascade({ locateFile: () => wasmUrl, print: () => undefined, printErr: () => undefined }).then(setOC);
  return initialized;
}
let queue = Promise.resolve();
const runtime = createCadKernelRuntime(initialize);
self.addEventListener('message', (event: MessageEvent<unknown>) => {
  const request = event.data;
  if (!isCadKernelEnvelope(request)) return;
  queue = queue.then(async () => {
    self.postMessage(await runtime.evaluate(request));
  });
});
