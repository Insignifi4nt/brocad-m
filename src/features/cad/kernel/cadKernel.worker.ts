import initOpenCascade from 'replicad-opencascadejs';
import wasmUrl from 'replicad-opencascadejs/wasm?url';
import { setOC } from 'replicad';
import { isCadKernelEnvelope } from './cadKernelProtocol';
import { createCadKernelRuntime } from './cadKernelRuntime';

// This entire module is only loaded after the first explicit CAD operation. The runtime keeps an initialization that succeeded, and
// never one that failed.
let queue = Promise.resolve();
const runtime = createCadKernelRuntime(() => initOpenCascade({ locateFile: () => wasmUrl, print: () => undefined, printErr: () => undefined }).then(setOC));
self.addEventListener('message', (event: MessageEvent<unknown>) => {
  const request = event.data;
  if (!isCadKernelEnvelope(request)) return;
  queue = queue.then(async () => {
    self.postMessage(await runtime.evaluate(request));
  });
});
