import { describe, expect, it } from 'vitest';
import { CadError } from '../../../domain/cad/cadError';
import { MAX_CAD_KERNEL_MESSAGE } from '../../../domain/cad/cadIssueCodes';
import { createCadDocument } from '../../../domain/cad/cadSchema';
import { createCadKernelClient, type CadWorkerTransport } from './cadKernelClient';
import { cadKernelFailure, cadKernelMessage, cadKernelRequestFailure } from './cadKernelFailures';
import { isCadKernelReply, type CadKernelRequest } from './cadKernelProtocol';
import { MAX_CAD_DIAGNOSTIC_MESSAGE } from '../../../domain/cad/cadIssueCodes';

const fillet = { operation: 'fillet' as const, input: { field: 'targetId', id: 'box' } };

describe('kernel failures', () => {
  it('name the step, cause and repair for kernel text, and keep that text only as a detail', () => {
    expect(cadKernelFailure('round', new Error('BRep_API: command not done'), fillet)).toEqual({ code: 'kernel-operation-failed', featureId: 'round',
      message: 'The fillet could not be applied. The radius may be too large for an edge or a face next to it; reduce the radius or choose other edges.',
      details: { operation: 'fillet', input: { field: 'targetId', id: 'box' }, kernelMessage: 'BRep_API: command not done' } });
    // A native exception thrown as a number still names the step.
    expect(cadKernelFailure('round', 8_812_344, { operation: 'check', input: null })).toMatchObject({ message: expect.stringMatching(/^The result is not a valid closed solid\./),
      details: { kernelMessage: 'Native exception 8812344' } });
    // A mirror or a move copies its source exactly, so its failure names the source body as the likely cause.
    for (const operation of ['mirror', 'transform'] as const) {
      expect(cadKernelFailure('copy', new Error('BRepBuilderAPI_Transform: not done'), { operation, input: { field: 'sourceId', id: 'pad' } }).message, operation)
        .toMatch(/ copies its source body exactly, so the source body is likely damaged; rebuild the part, and if this repeats, revise the feature that made the source body\.$/);
    }
  });

  it('keep a refusal\'s code, message and facts, with the step it was taken in', () => {
    expect(cadKernelFailure('round', new CadError('missing-body', 'The fillet target body is unavailable.'), fillet)).toEqual({ code: 'missing-body', featureId: 'round',
      message: 'The fillet target body is unavailable.', details: { operation: 'fillet', input: { field: 'targetId', id: 'box' }, kernelMessage: null } });
    expect(cadKernelFailure('round', new CadError('selection-count-mismatch', 'Matched 3, requires 2.', { expected: 2, actual: 3 }), fillet))
      .toMatchObject({ code: 'selection-count-mismatch', facts: { expected: 2, actual: 3 } });
  });

  it('cut kernel text and messages to their bounds with an ellipsis, so the reply stays valid, and keep no text when the kernel gave none', () => {
    expect(cadKernelMessage(new Error('x'.repeat(MAX_CAD_KERNEL_MESSAGE * 2)))).toBe(`${'x'.repeat(MAX_CAD_KERNEL_MESSAGE - 1)}…`);
    expect(cadKernelMessage(new Error('x'.repeat(MAX_CAD_KERNEL_MESSAGE)))).toBe('x'.repeat(MAX_CAD_KERNEL_MESSAGE));
    // A failure with 2,049 characters of kernel text, and a refusal with a message past its bound, make a reply the boundary admits as it is.
    const failure = cadKernelFailure('round', new Error('x'.repeat(MAX_CAD_KERNEL_MESSAGE + 1)), fillet);
    const refusal = cadKernelFailure('later', new CadError('missing-body', 'm'.repeat(MAX_CAD_DIAGNOSTIC_MESSAGE + 1)), fillet);
    expect([failure.details?.kernelMessage?.length, refusal.message.length, refusal.message.endsWith('…')]).toEqual([MAX_CAD_KERNEL_MESSAGE, MAX_CAD_DIAGNOSTIC_MESSAGE, true]);
    expect(isCadKernelReply({ id: 1, kind: 'built', result: { buildId: 'b', durationMs: 0, meshes: [], diagnostics: [failure, refusal] } })).toBe(true);
    expect(cadKernelRequestFailure('section', new Error('x'.repeat(MAX_CAD_KERNEL_MESSAGE + 1))).kernelMessage).toHaveLength(MAX_CAD_KERNEL_MESSAGE);
    expect(cadKernelMessage(new Error(''))).toBeNull();
    expect(cadKernelMessage({})).toBeNull();
  });

  it('give each worker request its own message for kernel text, and pass refusals through with their facts', () => {
    expect(cadKernelRequestFailure('section', new Error('BRepAlgoAPI_Section failed'))).toEqual({ code: 'kernel-operation-failed',
      message: 'The section could not be cut through this body, for a reason the kernel did not name. Move the section plane slightly or choose another body.', kernelMessage: 'BRepAlgoAPI_Section failed' });
    // A request that fails outside every feature step says the kernel named no reason, and keeps its words apart; reading a file names the file.
    for (const kind of ['build', 'export', 'inspect-topology', 'resolve-topology-picks', 'inspect-adjacency', 'inspect-tangent-chain', 'unlisted']) {
      expect(cadKernelRequestFailure(kind, new Error('Standard_Failure')), kind).toMatchObject({ code: 'kernel-operation-failed', message: expect.stringMatching(/, for a reason (the kernel|it) did not name\. /), kernelMessage: 'Standard_Failure' });
    }
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
    for (const kernelMessage of ['', 3, null]) expect(isCadKernelReply(error({ kernelMessage })), String(kernelMessage)).toBe(false);
    // Longer kernel text is admitted, and cut as the refusal is made below.
    expect(isCadKernelReply(error({ kernelMessage: 'x'.repeat(MAX_CAD_KERNEL_MESSAGE + 1) }))).toBe(true);
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
    const longer = client.build(createCadDocument());
    deliver.call(transport, new MessageEvent('message', { data: { ...error({ kernelMessage: 'x'.repeat(MAX_CAD_KERNEL_MESSAGE + 1) }), id: 2 } }));
    await expect(longer).rejects.toMatchObject({ code: 'kernel-operation-failed', kernelMessage: `${'x'.repeat(MAX_CAD_KERNEL_MESSAGE - 1)}…` });
    client.dispose();
  });
});
