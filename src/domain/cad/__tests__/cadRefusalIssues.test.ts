import { describe, expect, it, vi } from 'vitest';
import type { CadFeature, CadSketchFeature } from '../cadDocument';
import { cadSketchToCam } from '../cadCam';
import { CadError } from '../cadError';
import { createCadIssueList } from '../cadIssues';
import { cadRefusalIssue } from '../cadRefusalIssues';
import { cadRefusalAt, cadRefusalMark, cadRefusalSubject } from '../cadRefusalSubjects';
import { evaluateCadScalar } from '../cadExpression';
import { createCadDocument, parseCadDocument } from '../cadSchema';
import { cadFeatureDefinition } from '../features/cadFeatureRegistry';
import { CadSketchGeneratorRemovalError } from '../sketch-generators/cadSketchGenerators';

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
    const section = cadRefusalAt(new CadError('empty-section', 'The plane misses the body.'), { kind: 'cam-operation', operation: 'section', sourceId: 'body' });
    expect(cadRefusalIssue(section)).toMatchObject({ namespace: 'cam', code: 'empty-section', subject: { operation: 'section', sourceId: 'body' } });
    // A CAM step reports the codes it can raise, and only those.
    expect(cadRefusalIssue(cadRefusalAt(new CadError('invalid-reference', 'No.'), { kind: 'cam-operation', operation: 'section', sourceId: 'body' }))).toBeNull();
    expect(cadRefusalIssue(cadRefusalAt(new CadError('missing-sketch', 'No.'), { kind: 'cam-operation', operation: 'section', sourceId: 'body' }))).toBeNull();
    expect(cadRefusalIssue(cadRefusalAt(new CadError('missing-body', 'No.'), { kind: 'cam-operation', operation: 'send-sketch', sourceId: 'sketch1' }))).toBeNull();
  });

  it('gives an export step\'s refusal as an export issue about the export and its source, never a CAM step\'s', () => {
    const subject = { kind: 'export-operation', format: 'dxf-section', sourceId: 'body' } as const;
    // A code a feature can be refused with and one only a section raises are both the export's, with their own codes.
    for (const error of [CadError.received('kernel-operation-failed', 'The section could not be cut.', { kernelMessage: 'BRepAlgoAPI_Section failed' }),
      new CadError('empty-section', 'The plane misses the body.'), new CadError('dxf-geometry', 'DXF coordinates must be finite.')]) {
      expect(cadRefusalIssue(cadRefusalAt(error, subject))).toEqual({ key: 'refusal', namespace: 'export', code: error.code, severity: 'error', state: 'failed',
        subject, message: error.message, causes: [], repairs: [], details: {} });
    }
    // The export reports the codes it can raise, and only those.
    expect(cadRefusalIssue(cadRefusalAt(new CadError('missing-sketch', 'No.'), subject))).toBeNull();
    expect(cadRefusalIssue(cadRefusalAt(new CadError('invalid-reference', 'No.'), subject))).toBeNull();
    // Its other failures are no problem of the export or its source.
    for (const failure of [CadError.received('kernel-unavailable', 'The CAD kernel could not be loaded.', { kernelMessage: 'CompileError' }),
      new DOMException('The operation was aborted.', 'AbortError'), new Error('CAD model has been disposed.')]) {
      expect(cadRefusalIssue(cadRefusalAt(failure, subject)), String(failure)).toBeNull();
    }
    // A Section for CAM recorded before the export is replaced by it, and the export's record by a later Section for CAM or the document.
    const cut = cadRefusalAt(new CadError('empty-section', 'The plane misses the body.'), { kind: 'cam-operation', operation: 'section', sourceId: 'body' });
    cadRefusalAt(cut, subject);
    expect(cadRefusalSubject(cut)).toEqual(subject);
    cadRefusalAt(cut, { kind: 'cam-operation', operation: 'section', sourceId: 'body' });
    expect(cadRefusalSubject(cut)).toEqual({ kind: 'cam-operation', operation: 'section', sourceId: 'body' });
    cadRefusalAt(cut, subject);
    cadRefusalAt(cut, { kind: 'document' });
    expect(cadRefusalSubject(cut)).toEqual({ kind: 'document' });
    // An export of another body, or a document check inside the export, keeps what it encloses and no more.
    cadRefusalAt(cut, subject);
    cadRefusalAt(cut, { ...subject, sourceId: 'other' });
    expect(cadRefusalSubject(cut)).toEqual({ ...subject, sourceId: 'other' });
    const slot = { kind: 'reference-slot', featureId: 'body', field: 'sketchId', inputId: 'sketch1' } as const, since = cadRefusalMark();
    const missing = cadRefusalAt(new CadError('missing-body', 'Body box is unavailable.'), slot);
    cadRefusalAt(missing, subject, since);
    expect(cadRefusalSubject(missing)).toEqual(slot);
  });

  it('gives a sketch or reference curve DXF export\'s refusal as an export issue about that export and its source, with codes its own format raises', () => {
    const sketch = { kind: 'export-operation', format: 'dxf-sketch', sourceId: 'sketch1' } as const, curve = { kind: 'export-operation', format: 'dxf-curve', sourceId: 'rail' } as const;
    for (const [subject, error] of [[sketch, new CadError('empty-sketch', 'Sketch needs at least one non-construction contour for DXF export.')],
      [sketch, new CadError('unknown-parameter', 'Unknown parameter "r".')], [sketch, new CadError('dxf-geometry', 'DXF coordinates must be finite.')],
      [curve, new CadError('suppressed-curve', 'Unsuppress the Curve before exporting its geometry.')], [curve, new CadError('dxf-arc-precision', 'DXF bulges cannot retain the complete Curve.')]] as const) {
      expect(cadRefusalIssue(cadRefusalAt(error, subject))).toEqual({ key: 'refusal', namespace: 'export', code: error.code, severity: 'error', state: 'failed',
        subject, message: error.message, causes: [], repairs: [], details: {} });
    }
    // No format takes another's codes: a curve is written as one polyline, never by the writer of sketches and sections.
    for (const [subject, code] of [[sketch, 'empty-section'], [sketch, 'missing-curve'], [sketch, 'dxf-arc-precision'], [curve, 'missing-sketch'], [curve, 'dxf-geometry'],
      [{ kind: 'export-operation', format: 'dxf-section', sourceId: 'body' }, 'missing-curve']] as const) {
      expect(cadRefusalIssue(cadRefusalAt(new CadError(code, 'No.'), subject)), `${subject.format} ${code}`).toBeNull();
    }
    // A sketch export's record is replaced by a curve export's, and by an export of another sketch.
    const refused = cadRefusalAt(new CadError('unknown-parameter', 'Unknown parameter "r".'), sketch);
    cadRefusalAt(refused, curve);
    expect(cadRefusalSubject(refused)).toEqual(curve);
    cadRefusalAt(refused, { ...sketch, sourceId: 'other' });
    expect(cadRefusalSubject(refused)).toEqual({ ...sketch, sourceId: 'other' });
  });

  it('names the nearest step of one propagation, which a refusal raised again starts over', () => {
    const slot = (featureId: string, inputId: string) => ({ kind: 'reference-slot', featureId, field: 'sketchId', inputId }) as const;
    // The reviewer's probe: an independent check rethrows a cached refusal while checking a different feature.
    const error = new CadError('invalid-reference', 'Missing');
    cadRefusalAt(error, slot('first', 's1'));
    cadRefusalAt(error, { kind: 'feature', featureId: 'first' });
    expect(cadRefusalIssue(error)?.subject).toMatchObject({ kind: 'reference-slot', featureId: 'first' });
    cadRefusalAt(error, slot('second', 's2'));
    cadRefusalAt(error, { kind: 'feature', featureId: 'second' });
    expect(cadRefusalIssue(error)?.subject).toMatchObject({ kind: 'reference-slot', featureId: 'second', inputId: 's2' });
    // The real check: the slot it was reading, kept by the feature and the document around it; a refusal raised again elsewhere in the
    // same feature after the check started is that feature's, not the slot of its first use.
    const missing = refusal([extrude('body')]);
    expect(cadRefusalIssue(missing)?.subject).toEqual(slot('body', 'sketch1'));
    let since = cadRefusalMark();
    cadRefusalAt(missing, { kind: 'feature', featureId: 'body' }, since);
    expect(cadRefusalIssue(missing)?.subject).toEqual({ kind: 'feature', featureId: 'body' });
    since = cadRefusalMark();
    cadRefusalAt(missing, slot('body', 'sketch1'));
    cadRefusalAt(missing, { kind: 'feature', featureId: 'body' }, since);
    cadRefusalAt(missing, { kind: 'document' }, since);
    expect(cadRefusalIssue(missing)?.subject).toEqual(slot('body', 'sketch1'));
    // A CAM step keeps the feature its document check names, and a later operation that is no CAM step keeps no CAM step.
    since = cadRefusalMark();
    cadRefusalAt(missing, slot('body', 'sketch1'));
    cadRefusalAt(missing, { kind: 'cam-operation', operation: 'send-sketch', sourceId: 'sketch1' }, since);
    expect(cadRefusalIssue(missing)?.subject).toEqual(slot('body', 'sketch1'));
    const empty = cadRefusalAt(new CadError('empty-section', 'The plane misses the body.'), { kind: 'cam-operation', operation: 'section', sourceId: 'body' });
    cadRefusalAt(empty, { kind: 'cam-operation', operation: 'send-sketch', sourceId: 'sketch1' });
    expect(cadRefusalSubject(empty)).toEqual({ kind: 'cam-operation', operation: 'send-sketch', sourceId: 'sketch1' });
    cadRefusalAt(empty, { kind: 'cam-operation', operation: 'section', sourceId: 'body' });
    cadRefusalAt(empty, { kind: 'document' }, cadRefusalMark());
    expect(cadRefusalSubject(empty)).toEqual({ kind: 'document' });
    // A reader that marks its operation's start reads no step recorded before it.
    const read = cadRefusalAt(new CadError('kernel-operation-failed', 'The body could not be built.'), { kind: 'cam-operation', operation: 'section', sourceId: 'body' });
    since = cadRefusalMark();
    expect(cadRefusalIssue(read)).toMatchObject({ namespace: 'cam' });
    expect(cadRefusalIssue(read, 'refusal', since)).toMatchObject({ namespace: 'feature', subject: { kind: 'document' } });
    cadRefusalAt(read, { kind: 'feature', featureId: 'body' });
    expect(cadRefusalIssue(read, 'refusal', since)?.subject).toEqual({ kind: 'feature', featureId: 'body' });
  });

  it('names the feature whose check raises a refusal again, not the input slot of its first use', () => {
    const cached = refusal([extrude('body')]);
    expect(cadRefusalIssue(cached)?.subject).toEqual({ kind: 'reference-slot', featureId: 'body', field: 'sketchId', inputId: 'sketch1' });
    const check = vi.spyOn(cadFeatureDefinition('extrude'), 'check').mockImplementation(() => { throw cached; });
    try { expect(refusal([sketch, extrude('body')])).toBe(cached); } finally { check.mockRestore(); }
    expect(cadRefusalIssue(cached)?.subject).toEqual({ kind: 'feature', featureId: 'body' });
  });

  it('gives a Section for CAM of an unavailable body, or with an offset its parameters cannot evaluate, as the step\'s issue with its own code', () => {
    const offset = (() => { try { evaluateCadScalar('depth / 2', {}); } catch (error) { return error; } throw new Error('The offset evaluated.'); })();
    const zero = (() => { try { evaluateCadScalar('depth / gap', { depth: 4, gap: 0 }); } catch (error) { return error; } throw new Error('The offset evaluated.'); })();
    const body = new CadError('missing-body', 'Body box is unavailable or has already been consumed. Choose a current body from the feature tree.');
    for (const error of [offset, zero, body]) {
      const { code, message } = error as CadError;
      expect(cadRefusalIssue(cadRefusalAt(error, { kind: 'cam-operation', operation: 'section', sourceId: 'box' }))).toEqual({ key: 'refusal', namespace: 'cam', code,
        severity: 'error', state: 'failed', subject: { kind: 'cam-operation', operation: 'section', sourceId: 'box' }, message, causes: [], repairs: [], details: {} });
    }
    expect([offset, zero].map(error => (error as CadError).code)).toEqual(['unknown-parameter', 'division-by-zero']);
  });

  it('gives no issue for a CAM step\'s failures that are no problem of the step or its source', () => {
    const subject = { kind: 'cam-operation', operation: 'section', sourceId: 'box' } as const;
    const failures: unknown[] = [
      CadError.received('kernel-unavailable', 'The CAD kernel could not be loaded. Reload the page; if this repeats, use a browser that runs WebAssembly.', { kernelMessage: 'CompileError' }),
      new CadError('unsupported-operation', 'Unsupported CAD worker operation.'),
      new DOMException('The operation was aborted.', 'AbortError'),
      new Error('CAD model has been disposed.')
    ];
    for (const failure of failures) expect(cadRefusalIssue(cadRefusalAt(failure, subject)), String(failure)).toBeNull();
    // A malformed request is refused before the step names its source, and read on its own it is no feature's refusal either.
    expect(cadRefusalIssue(new CadError('invalid-section', 'Choose a body, plane and offset.'))).toBeNull();
  });

  it('leaves to their own producers refusals that are no problem of a feature or a CAM step', () => {
    expect(cadRefusalIssue(new Error('Not a refusal.'))).toBeNull();
    // Input that is no part at all is refused before any feature is.
    let malformed: unknown;
    try { parseCadDocument({ ...createCadDocument('Part', 'cad_test'), features: 'none' }); } catch (error) { malformed = error; }
    expect([(malformed as CadError).code, cadRefusalIssue(malformed)]).toEqual(['invalid-document', null]);
    expect(cadRefusalIssue(new CadError('stale-repair', 'Read the issues again.'))).toBeNull();
    expect(cadRefusalIssue(new CadError('sketch-conflicting', 'Sketch constraints conflict.'))).toBeNull();
    // A generator edit that would remove relations no one confirmed is a pending confirmation, answered through the paged removal flow.
    const removal = new CadSketchGeneratorRemovalError([{ relationId: 'tie', name: 'Coincident "tie"', generator: 'Rectangle "g1"', reason: 'Its point is regenerated.', confirmed: false }]);
    expect([removal.code, cadRefusalIssue(removal)]).toEqual(['unconfirmed-sketch-generator-removals', null]);
    // A section refused outside a CAM or export step is not a feature refusal either.
    expect(cadRefusalIssue(new CadError('empty-section', 'The plane misses the body.'))).toBeNull();
  });

  it('makes frozen issues a checked list accepts', () => {
    const issue = cadRefusalIssue(refusal([extrude('body')]))!;
    expect(Object.isFrozen(issue) && Object.isFrozen(issue.subject)).toBe(true);
    expect(createCadIssueList([issue])).toEqual([issue]);
  });
});
