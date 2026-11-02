import { describe, expect, it, vi } from 'vitest';
import { CadError } from '../../../domain/cad/cadError';
import { CAD_KERNEL_NOT_LOADED, createCadKernelLoader, loadCadKernelClient } from './cadKernelLoader';

const words = 'Failed to fetch dynamically imported module: https://example.test/assets/cadKernelClient-1a2b3c.js';
const client = () => ({ build: vi.fn(), dispose: vi.fn() });

describe('CAD kernel loading', () => {
  it('refuses as an unavailable kernel, with the browser\'s words apart, a client module that cannot be loaded, however the load fails', async () => {
    const unavailable = { name: 'CadError', code: 'kernel-unavailable', message: CAD_KERNEL_NOT_LOADED, kernelMessage: words };
    expect(await loadCadKernelClient(() => Promise.reject(new TypeError(words))).catch((error: unknown) => error)).toMatchObject(unavailable);
    expect(await loadCadKernelClient(() => { throw new TypeError(words); }).catch((error: unknown) => error)).toMatchObject(unavailable);
    const wordless = await loadCadKernelClient(() => Promise.reject(new Event('error'))).catch((error: unknown) => error);
    expect([wordless instanceof CadError, (wordless as CadError).code, (wordless as CadError).kernelMessage]).toEqual([true, 'kernel-unavailable', undefined]);
  });

  it('keeps no failed load: every request waiting for it fails with it, and the next one loads the client again and shares it', async () => {
    const loaded = client();
    const load = vi.fn<() => Promise<ReturnType<typeof client>>>().mockRejectedValueOnce(new TypeError(words)).mockResolvedValue(loaded);
    const loader = createCadKernelLoader(load);
    // A request queued behind the failing load fails with it rather than starting a second load.
    const [first, queued] = await Promise.all([loader.load(), loader.load()].map(request => request.catch((error: unknown) => error)));
    expect([first, queued]).toEqual([expect.objectContaining({ code: 'kernel-unavailable', kernelMessage: words }), first]);
    expect(load).toHaveBeenCalledOnce();
    expect(await loader.load()).toBe(loaded);
    expect(await loader.load()).toBe(loaded);
    expect(load).toHaveBeenCalledTimes(2);
    loader.dispose(); await Promise.resolve();
    expect(loaded.dispose).toHaveBeenCalledOnce();
  });

  it('disposes a load that failed, or is still running, without an unhandled rejection, and a later load starts afresh', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      let reject: (error: unknown) => void = () => undefined;
      const loaded = client(), load = vi.fn<() => Promise<ReturnType<typeof client>>>()
        .mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; })).mockResolvedValue(loaded);
      const loader = createCadKernelLoader(load);
      const waiting = loader.load().catch((error: unknown) => error);
      loader.dispose();
      reject(new TypeError(words));
      expect(await waiting).toMatchObject({ code: 'kernel-unavailable' });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
      expect(await loader.load()).toBe(loaded);
      loader.dispose(); loader.dispose(); await Promise.resolve();
      expect(loaded.dispose).toHaveBeenCalledOnce();
    } finally { process.off('unhandledRejection', unhandled); }
  });
});
