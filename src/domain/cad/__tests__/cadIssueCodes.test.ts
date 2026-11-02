import { describe, expect, it } from 'vitest';
import { CadError } from '../cadError';
import { CAD_REFUSAL_CODES, MAX_CAD_DIAGNOSTIC_CODE, MAX_CAD_KERNEL_MESSAGE, cadReceivedDiagnostic, isCadKernelFailureDetails, isCadRefusalCode, isCadRefusalFacts } from '../cadIssueCodes';
import { CAD_FEATURE_SHARED_DIAGNOSTICS, cadFeatureDefinition, cadFeatureKinds } from '../features/cadFeatureRegistry';

describe('CAD issue codes', () => {
  it('list exactly the codes the kinds and the shared steps name, each once', () => {
    // The kinds' lists are typed by the registry, so none names a code it lacks; this holds it to no code they all leave out.
    const named = new Set<string>([...Object.values(CAD_FEATURE_SHARED_DIAGNOSTICS).flat(), ...cadFeatureKinds().flatMap(kind => cadFeatureDefinition(kind).diagnostics)]);
    expect(new Set(CAD_REFUSAL_CODES).size).toBe(CAD_REFUSAL_CODES.length);
    expect([...CAD_REFUSAL_CODES].sort()).toEqual([...named].sort());
    expect([isCadRefusalCode('selection-count-mismatch'), isCadRefusalCode('selection-missing'), isCadRefusalCode(undefined)]).toEqual([true, false, false]);
  });

  it('check the facts each code carries and a kernel failure\'s details', () => {
    expect(isCadRefusalFacts('selection-count-mismatch', { expected: 2, actual: 3 })).toBe(true);
    expect(isCadRefusalFacts('selection-empty', { expected: null })).toBe(true);
    expect(isCadRefusalFacts('selection-empty', { expected: 0 })).toBe(false);
    expect(isCadRefusalFacts('empty-solid', {})).toBe(false);
    expect(isCadKernelFailureDetails({ operation: 'cut', input: { field: 'toolId', id: 'peg' }, kernelMessage: null })).toBe(true);
    expect(isCadKernelFailureDetails({ operation: 'cut', input: { field: '', id: 'peg' }, kernelMessage: null })).toBe(false);
    expect(isCadKernelFailureDetails({ operation: 'cut', input: null })).toBe(false);
    // Kernel text is held to its bound unless the caller admits more, as the worker boundary does before cutting it.
    const long = { operation: 'cut', input: null, kernelMessage: 'x'.repeat(MAX_CAD_KERNEL_MESSAGE + 1) };
    expect([isCadKernelFailureDetails(long), isCadKernelFailureDetails(long, Infinity), isCadKernelFailureDetails({ ...long, kernelMessage: 3 }, Infinity)]).toEqual([false, true, false]);
  });

  it('take in a code no registry lists as kernel-unrecognised, keeping the code it gave, and cut long kernel text with an ellipsis', () => {
    const failure = { code: 'new-dynamic-refusal', featureId: 'p', message: 'Failed.', details: { operation: 'fillet' as const, input: null, kernelMessage: 'x'.repeat(MAX_CAD_KERNEL_MESSAGE + 1) } };
    const received = cadReceivedDiagnostic(failure);
    expect(received).toEqual({ code: 'kernel-unrecognised', featureId: 'p', message: 'Failed.', facts: { refusalCode: 'new-dynamic-refusal' },
      details: { operation: 'fillet', input: null, kernelMessage: `${'x'.repeat(MAX_CAD_KERNEL_MESSAGE - 1)}…` } });
    // Taking it in again changes nothing, and a registered code with text in bounds is the same object.
    expect(cadReceivedDiagnostic(received)).toBe(received);
    const known = { ...failure, code: 'empty-solid', details: { ...failure.details, kernelMessage: 'BRep_API: command not done' } };
    expect(cadReceivedDiagnostic(known)).toBe(known);
    // Facts given under an unregistered code are not taken as its own, and a code longer than any the registry has is cut to the bound.
    expect(cadReceivedDiagnostic({ code: 'c'.repeat(200), message: 'm', facts: { expected: 2 } } as never))
      .toEqual({ code: 'kernel-unrecognised', message: 'm', facts: { refusalCode: `${'c'.repeat(MAX_CAD_DIAGNOSTIC_CODE - 1)}…` } });
    // The code it keeps is one no registry lists, never a code of its own.
    expect(['new-dynamic-refusal', 'empty-solid', 'selection-empty', 'kernel-unrecognised', ''].map(refusalCode => isCadRefusalFacts('kernel-unrecognised', { refusalCode })))
      .toEqual([true, false, false, false, false]);
  });
});

describe('CAD refusals', () => {
  it('are raised with the facts of a code that carries them and with none for any other, which is checked as they are raised', () => {
    expect(new CadError('selection-count-mismatch', 'Matched 3, requires 2.', { expected: 2, actual: 3 }).facts).toEqual({ expected: 2, actual: 3 });
    expect(new CadError('missing-body', 'Gone.').facts).toBeUndefined();
    // @ts-expect-error A count mismatch is raised with its counts, and one raised without them anyway throws.
    expect(() => new CadError('selection-count-mismatch', 'Mismatch')).toThrow('Refusal selection-count-mismatch is raised without its facts.');
    // @ts-expect-error An empty selection is raised with the count it requires.
    expect(() => new CadError('selection-empty', 'None')).toThrow('without its facts');
    // @ts-expect-error A code that carries no facts takes none.
    expect(() => new CadError('missing-body', 'Gone.', { expected: 2 })).toThrow('Refusal missing-body is raised with facts other than those its code carries.');
    expect(() => new CadError('selection-empty', 'None', { expected: 0 })).toThrow('with facts other than');
    // @ts-expect-error A code known only as a string has no constructor call: it is raised through CadError.checked.
    const widened = (code: string) => new CadError(code, 'Failure');
    // @ts-expect-error Nor has a union of codes of which some carry facts.
    const mixed = (code: 'selection-empty' | 'missing-body') => new CadError(code, 'Failure');
    expect([widened, mixed]).toHaveLength(2);
  });

  it('of a code known only at run time are checked the same way', () => {
    expect(CadError.checked('selection-empty', 'None', { expected: null })).toMatchObject({ name: 'CadError', code: 'selection-empty', facts: { expected: null } });
    expect(CadError.checked('missing-body', 'Gone.')).toMatchObject({ code: 'missing-body', message: 'Gone.' });
    expect(CadError.checked('missing-body', 'Gone.')).toBeInstanceOf(CadError);
    expect(() => CadError.checked('selection-empty', 'None')).toThrow('without its facts');
    expect(() => CadError.checked('missing-body', 'Gone.', { expected: 2 })).toThrow('with facts other than');
    // A received refusal keeps the kernel's own text apart, cut to its bound.
    const received = CadError.received('selection-empty', 'None', { facts: { expected: 2 }, kernelMessage: 'x'.repeat(MAX_CAD_KERNEL_MESSAGE + 1) });
    expect([received.facts, received.kernelMessage?.length, received.kernelMessage?.endsWith('…')]).toEqual([{ expected: 2 }, MAX_CAD_KERNEL_MESSAGE, true]);
  });
});
