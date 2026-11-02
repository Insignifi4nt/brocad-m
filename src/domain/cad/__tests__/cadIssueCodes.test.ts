import { describe, expect, it } from 'vitest';
import { CAD_REFUSAL_CODES, isCadKernelFailureDetails, isCadRefusalCode, isCadRefusalFacts } from '../cadIssueCodes';
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
  });
});
