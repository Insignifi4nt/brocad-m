import { CadError } from '../../../domain/cad/cadError';

/** The kernel client's module could not be loaded, as when the app was updated and its old module is gone or the network dropped. */
export const CAD_KERNEL_NOT_LOADED = 'The CAD kernel could not be loaded; the app may have been updated, or the network dropped. Reload the page.';

/**
 * A failure of the kernel itself rather than of the request, which fails every request alike: `kernel-unavailable`, with `message` naming
 * the cause and the next step, and the browser's own words, or the check that failed, as its kernel message.
 */
export function cadKernelUnavailable(message: string, cause: unknown): CadError {
  // A DOMException, which a refused worker or hand-over raises, need not be an Error of this realm.
  const words = typeof cause === 'object' && cause !== null ? (cause as { readonly message?: unknown }).message : cause;
  const text = typeof words === 'string' ? words : '';
  return CadError.received('kernel-unavailable', message, text ? { kernelMessage: text } : {});
}

/**
 * The kernel client `load` gives, importing the client's module and creating the client. A load that fails, or throws, fails any request
 * alike, so it is the kernel failing rather than the request: `kernel-unavailable`, named by {@link CAD_KERNEL_NOT_LOADED}, with the
 * browser's own words as its kernel message.
 */
export function loadCadKernelClient<T>(load: () => Promise<T>): Promise<T> {
  return new Promise<T>(resolve => resolve(load())).catch((error: unknown) => { throw cadKernelUnavailable(CAD_KERNEL_NOT_LOADED, error); });
}

/**
 * One kernel client, loaded as {@link loadCadKernelClient} loads it when a request first needs it, and shared by later requests. A load
 * that fails is not kept: every request waiting for it fails with it, and the next request loads the client again.
 */
export interface CadKernelLoader<T> {
  load(): Promise<T>;
  /** Disposes the client once it is loaded, and keeps none; a load that failed has nothing to dispose. */
  dispose(): void;
}

export function createCadKernelLoader<T extends { dispose(): void }>(load: () => Promise<T>): CadKernelLoader<T> {
  let loaded: Promise<T> | null = null;
  return {
    load() {
      if (loaded) return loaded;
      const pending = loadCadKernelClient(load);
      loaded = pending;
      void pending.catch(() => { if (loaded === pending) loaded = null; });
      return pending;
    },
    dispose() { void loaded?.then(client => client.dispose(), () => undefined); loaded = null; }
  };
}
