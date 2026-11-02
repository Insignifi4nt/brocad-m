import { describe, expect, it } from 'vitest';
import { CadError } from '../../../domain/cad/cadError';
import { MAX_CAD_KERNEL_MESSAGE } from '../../../domain/cad/cadIssueCodes';
import { createCadDocument } from '../../../domain/cad/cadSchema';
import { createCadKernelClient, type CadWorkerTransport } from './cadKernelClient';
import { cadKernelFailure, cadKernelMessage, cadKernelRequestFailure } from './cadKernelFailures';
import { isCadKernelReply, type CadKernelRequest } from './cadKernelProtocol';

const fillet = { operation: 'fillet' as const, input: { field: 'targetId', id: 'box' } };

describe('kernel failures', () => {
  it('name the step, cause and repair for kernel text, and keep that text only as a detail', () => {
    expect(cadKernelFailure('round', new Error('BRep_API: command not done'), fillet)).toEqual({ code: 'kernel-operation-failed', featureId: 'round',
      message: 'The fillet could not be applied. The radius may be too large for an edge or a face next to it; reduce the radius or choose other edges.',
      details: { operation: 'fillet', input: { field: 'targetId', id: 'box' }, kernelMessage: 'BRep_API: command not done' } });
    // A native exception thrown as a number still names the step.
    expect(cadKernelFailure('round', 8_812_344, { operation: 'check', input: null })).toMatchObject({ message: expect.stringMatching(/^The result is not a valid closed solid\./),
      details: { kernelMessage: 'Native exception 8812344' } });
  });

  it('keep a refusal\'s code, message and facts, with the step it was taken in', () => {
    expect(cadKernelFailure('round', new CadError('missing-body', 'The fillet target body is unavailable.'), fillet)).toEqual({ code: 'missing-body', featureId: 'round',
      message: 'The fillet target body is unavailable.', details: { operation: 'fillet', input: { field: 'targetId', id: 'box' }, kernelMessage: null } });
    expect(cadKernelFailure('round', new CadError('selection-count-mismatch', 'Matched 3, requires 2.', { expected: 2, actual: 3 }), fillet))
      .toMatchObject({ code: 'selection-count-mismatch', facts: { expected: 2, actual: 3 } });
  });

  it('bound the kernel text, and keep none when the kernel gave none', () => {
    expect(cadKernelMessage(new Error('x'.repeat(MAX_CAD_KERNEL_MESSAGE * 2)))).toHaveLength(MAX_CAD_KERNEL_MESSAGE);
    expect(cadKernelMessage(new Error(''))).toBeNull();
    expect(cadKernelMessage({})).toBeNull();
  });

  it('give each worker request its own message for kernel text, and pass refusals through with their facts', () => {
    expect(cadKernelRequestFailure('section', new Error('BRepAlgoAPI_Section failed'))).toEqual({ code: 'kernel-operation-failed',
      message: 'The section could not be cut through this body. Move the section plane slightly or choose another body.', kernelMessage: 'BRepAlgoAPI_Section failed' });
    expect(cadKernelRequestFailure('import-solid', 3)).toMatchObject({ message: expect.stringMatching(/^The file could not be read as a solid\./), kernelMessage: 'Native exception 3' });
    expect(cadKernelRequestFailure('build', new CadError('STALE_BUILD', 'Rebuild.'))).toEqual({ code: 'STALE_BUILD', message: 'Rebuild.' });
    expect(cadKernelRequestFailure('resolve-topology-picks', new CadError('selection-empty', 'Matched none.', { expected: 2 })))
      .toEqual({ code: 'selection-empty', message: 'Matched none.', facts: { expected: 2 } });
  });
});

describe('the worker boundary', () => {
  it('checks an error reply\'s kernel text and facts, and gives them to the client\'s refusal', async () => {
    const error = (extra: object) => ({ id: 1, kind: 'error', code: 'kernel-operation-failed', message: 'The part could not be rebuilt.', ...extra });
    expect(isCadKernelReply(error({ kernelMessage: 'Standard_Failure' }))).toBe(true);
    for (const kernelMessage of ['', 'x'.repeat(MAX_CAD_KERNEL_MESSAGE + 1), 3]) expect(isCadKernelReply(error({ kernelMessage })), String(kernelMessage).slice(0, 8)).toBe(false);
    expect(isCadKernelReply(error({ code: 'selection-empty', facts: { expected: 2 } }))).toBe(true);
    expect(isCadKernelReply(error({ code: 'selection-empty' }))).toBe(false);
    expect(isCadKernelReply(error({ code: 'selection-empty', facts: { expected: 0 } }))).toBe(false);
    expect(isCadKernelReply(error({ facts: { expected: 2 } }))).toBe(false);
    expect(isCadKernelReply({ id: 1, kind: 'error', message: 'm', facts: { expected: 2 } })).toBe(false);

    let onmessage: CadWorkerTransport['onmessage'] = null;
    const transport: CadWorkerTransport = { get onmessage() { return onmessage; }, set onmessage(value) { onmessage = value; }, onerror: null, onmessageerror: null,
      postMessage(_message: CadKernelRequest) {}, terminate() {} };
    const client = createCadKernelClient(() => transport), built = client.build(createCadDocument());
    const deliver = transport.onmessage as NonNullable<CadWorkerTransport['onmessage']>;
    deliver.call(transport, new MessageEvent('message', { data: error({ code: 'selection-empty', facts: { expected: 2 }, kernelMessage: 'Standard_Failure' }) }));
    await expect(built).rejects.toMatchObject({ code: 'selection-empty', message: 'The part could not be rebuilt.', kernelMessage: 'Standard_Failure', facts: { expected: 2 } });
    client.dispose();
  });
});
