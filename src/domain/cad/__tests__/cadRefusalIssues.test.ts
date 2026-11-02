import { describe, expect, it } from 'vitest';
import type { CadFeature, CadSketchFeature } from '../cadDocument';
import { cadSketchToCam } from '../cadCam';
import { CadError } from '../cadError';
import { createCadIssueList } from '../cadIssues';
import { cadRefusalIssue } from '../cadRefusalIssues';
import { cadRefusalAt } from '../cadRefusalSubjects';
import { createCadDocument, parseCadDocument } from '../cadSchema';

const sketch: CadSketchFeature = { id: 'sketch1', name: 'Profile', kind: 'sketch', suppressed: false, plane: 'XY', offset: 0,
  profiles: [{ id: 'disc', name: 'disc', construction: false, role: 'outer', geometry: { kind: 'circle', x: 0, y: 0, radius: 5 } }] };
const extrude = (id: string, extra: Partial<Record<string, unknown>> = {}) => ({ kind: 'extrude', id, name: id, suppressed: false, sketchId: 'sketch1', distance: 5,
  symmetric: false, operation: 'new', targetId: null, ...extra }) as CadFeature;
/** The refusal parsing a part with `features` raises. */
function refusal(features: readonly unknown[], parameters: Readonly<Record<string, number>> = {}): CadError {
  try { parseCadDocument({ ...createCadDocument('Part', 'cad_test'), features, parameters }); }
  catch (error) { if (error instanceof CadError) return error; throw error; }
  throw new Error('The part was accepted.');
}

describe('refusals in the CAD issue model', () => {
  it('names the input slot a reference check was reading, keeping the refusal\'s code and message', () => {
    const missing = refusal([extrude('body')]);
    expect(cadRefusalIssue(missing)).toEqual({ key: 'refusal', namespace: 'feature', code: 'invalid-reference', severity: 'error', state: 'failed',
      subject: { kind: 'reference-slot', featureId: 'body', field: 'sketchId', inputId: 'sketch1' }, message: missing.message, causes: [], repairs: [], details: {} });
    const sketchTarget = refusal([sketch, extrude('body'), extrude('boss', { operation: 'join', targetId: 'sketch1' })]);
    expect(cadRefusalIssue(sketchTarget)).toMatchObject({ code: 'invalid-reference', message: 'A solid operation cannot target a sketch.',
      subject: { kind: 'reference-slot', featureId: 'boss', field: 'targetId', inputId: 'sketch1' } });
  });

  it('names the feature any other check of it refused, and the document when no feature was being checked', () => {
    const unknown = refusal([sketch, extrude('body', { distance: 'depth' })]);
    expect(cadRefusalIssue(unknown)).toMatchObject({ namespace: 'feature', code: unknown.code, message: unknown.message, subject: { kind: 'feature', featureId: 'body' } });
    const duplicate = refusal([sketch, extrude('body'), extrude('body')]);
    expect(cadRefusalIssue(duplicate)).toMatchObject({ code: 'duplicate-id', subject: { kind: 'document' } });
  });

  it('carries the facts of a code that has them', () => {
    expect(cadRefusalIssue(new CadError('selection-count-mismatch', 'Two edges, three matched.', { expected: 2, actual: 3 }), 'pick')).toMatchObject({
      key: 'pick', code: 'selection-count-mismatch', details: { expected: 2, actual: 3 }, subject: { kind: 'document' } });
    expect(cadRefusalIssue(new CadError('selection-empty', 'Nothing matched.', { expected: null }))?.details).toEqual({ expected: null });
  });

  it('gives a CAM step\'s refusal as a CAM issue about the operation and its source', () => {
    const part = parseCadDocument({ ...createCadDocument('Part', 'cad_test'), features: [{ ...sketch, profiles: [] }] });
    let empty: unknown;
    try { cadSketchToCam(part, 'sketch1'); } catch (error) { empty = error; }
    expect(empty).toBeInstanceOf(CadError);
    // Unrecorded, the same code is a document refusal; recorded by the CAM step, a CAM issue.
    expect(cadRefusalIssue(empty)).toMatchObject({ namespace: 'feature', subject: { kind: 'document' } });
    cadRefusalAt(empty, { kind: 'cam-operation', operation: 'send-sketch', sourceId: 'sketch1' });
    expect(cadRefusalIssue(empty)).toEqual({ key: 'refusal', namespace: 'cam', code: (empty as CadError).code, severity: 'error', state: 'failed',
      subject: { kind: 'cam-operation', operation: 'send-sketch', sourceId: 'sketch1' }, message: (empty as CadError).message, causes: [], repairs: [], details: {} });
    // The first step to record a refusal names it.
    cadRefusalAt(empty, { kind: 'cam-operation', operation: 'section', sourceId: 'body' });
    expect(cadRefusalIssue(empty)?.subject).toMatchObject({ operation: 'send-sketch' });
    const section = cadRefusalAt(new CadError('empty-section', 'The plane misses the body.'), { kind: 'cam-operation', operation: 'section', sourceId: 'body' });
    expect(cadRefusalIssue(section)).toMatchObject({ namespace: 'cam', code: 'empty-section', subject: { operation: 'section', sourceId: 'body' } });
    // A CAM step reports only CAM codes.
    expect(cadRefusalIssue(cadRefusalAt(new CadError('invalid-reference', 'No.'), { kind: 'cam-operation', operation: 'section', sourceId: 'body' }))).toBeNull();
  });

  it('leaves to their own producers refusals that are no problem of a feature or a CAM step', () => {
    expect(cadRefusalIssue(new Error('Not a refusal.'))).toBeNull();
    // Input that is no part at all is refused before any feature is.
    let malformed: unknown;
    try { parseCadDocument({ ...createCadDocument('Part', 'cad_test'), features: 'none' }); } catch (error) { malformed = error; }
    expect([(malformed as CadError).code, cadRefusalIssue(malformed)]).toEqual(['invalid-document', null]);
    expect(cadRefusalIssue(new CadError('stale-repair', 'Read the issues again.'))).toBeNull();
    expect(cadRefusalIssue(new CadError('sketch-conflicting', 'Sketch constraints conflict.'))).toBeNull();
    // A section refused outside a CAM step, as a DXF export's is, is not a feature refusal either.
    expect(cadRefusalIssue(new CadError('empty-section', 'The plane misses the body.'))).toBeNull();
  });

  it('makes frozen issues a checked list accepts', () => {
    const issue = cadRefusalIssue(refusal([extrude('body')]))!;
    expect(Object.isFrozen(issue) && Object.isFrozen(issue.subject)).toBe(true);
    expect(createCadIssueList([issue], true)).toEqual([issue]);
  });
});
