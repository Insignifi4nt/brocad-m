import { describe, expect, it } from 'vitest';
import { parseCadSketchGraph } from '@/domain/cad/cadSketchGraph';
import { CadError } from '@/domain/cad/cadError';
import { CadSketchPreparationError, describeCadSketchConstraintSource } from './cadSketchConstraintFeedback';
import { createCadDocument, parseCadDocument } from '@/domain/cad/cadSchema';
import { prepareCadEdits } from './cadEditPreparation';
import { createCadSketchNativeRuntime } from './sketch-solver/cadSketchNativeRuntime';
import { CAD_SKETCH_NATIVE_INCOMPATIBLE, CAD_SKETCH_NATIVE_LOAD_FAILED } from './sketch-solver/cadSketchSolverFailure';
import type { CadSketchSolveResult } from './sketch-solver/cadSketchSolverTypes';
import { CadSketchNativeProtocolError } from './sketch-solver/native/cadSketchNativeSolver';

const proposedId = '730718ab-05fb-45fe-a347-00193af0414b';
const graph = () => parseCadSketchGraph({ points: [{ id: 'a', position: [' 0 ', '0'] }, { id: 'b', position: [10, 0] }],
  entities: [{ id: 'line', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' }],
  relations: [{ id: 'horizontal', kind: 'horizontal', pointIds: ['a', 'b'] }, { id: proposedId, kind: 'distance', pointIds: ['a', 'b'], value: ' 3 * 4 ' }] });

describe('candidate-owned sketch constraint feedback', () => {
  it('keeps a midpoint rejection attached to its exact point and line operands', () => {
    const candidate = parseCadSketchGraph({ points: [{ id: 'start', position: ['0', '0'] }, { id: 'end', position: ['20', '10'] }, { id: 'center', position: [10, 5] }],
      entities: [{ id: 'guide', kind: 'line', startPointId: 'start', endPointId: 'end', construction: true }],
      relations: [{ id: proposedId, kind: 'midpoint', pointId: 'center', lineId: 'guide' }] });
    const error = new CadSketchPreparationError({ sketchId: 'sketch', sketchName: 'Bore', graph: candidate, rejection: {
      kind: 'rejected', reason: 'conflicting', message: 'Incompatible center driver.', diagnostics: {
        status: 'success', degreesOfFreedom: 0, conflictingIds: [proposedId], redundantIds: [], partiallyRedundantIds: [], issues: []
      }
    } });
    expect(error.feedback.subjects).toMatchObject([{ source: { kind: 'relation', id: proposedId }, category: 'conflicting',
      pointIds: ['center', 'start', 'end'], entityIds: ['guide'] }]);
  });
  it('keeps signed axis subjects in their saved from/to order with human direction labels', () => {
    const candidate = parseCadSketchGraph({ points: [{ id: 'from', position: [10, 7] }, { id: 'to', position: [-20, 27] }], entities: [], relations: [
      { id: proposedId, kind: 'axis-distance', pointIds: ['to', 'from'], axis: 'y', value: ' -rise ' },
      { id: 'right', kind: 'axis-distance', pointIds: ['from', 'to'], axis: 'x', value: ' offset ' }
    ] }), before = JSON.stringify(candidate);
    const error = new CadSketchPreparationError({ sketchId: 'sketch', sketchName: 'Bore', graph: candidate, rejection: {
      kind: 'rejected', reason: 'invalid-solution', message: 'Native success did not satisfy signed offset.', diagnostics: {
        status: 'success', degreesOfFreedom: 0, conflictingIds: [], redundantIds: [], partiallyRedundantIds: [],
        issues: [{ source: { kind: 'relation', id: proposedId }, code: 'relation-residual', message: 'Signed offset mismatch.', residualMm: 1 }]
      }
    } });
    expect(error.feedback.subjects).toMatchObject([{ source: { kind: 'relation', id: proposedId }, category: 'issue',
      label: 'Vertical distance relation 1 · Point 2 → Point 1', pointIds: ['to', 'from'], entityIds: [], residualMm: 1 }]);
    expect(describeCadSketchConstraintSource(candidate, { kind: 'relation', id: 'right' })).toMatchObject({
      label: 'Horizontal distance relation 2 · Point 1 → Point 2', pointIds: ['from', 'to'], entityIds: []
    });
    expect(JSON.stringify(candidate)).toBe(before);
  });

  it('names exact line and curve operands for scalar-free equal-size subjects', () => {
    const graph = parseCadSketchGraph({ points: [{ id: 'center', position: [0, 0] }, { id: 'start', position: [10, 0] }, { id: 'end', position: [0, 10] }], entities: [
      { id: 'line-b', kind: 'line', construction: false, startPointId: 'center', endPointId: 'start' },
      { id: 'line-a', kind: 'line', construction: true, startPointId: 'end', endPointId: 'center' },
      { id: 'circle', kind: 'circle', construction: true, centerPointId: 'center', radius: 10 },
      { id: 'arc', kind: 'arc', construction: false, centerPointId: 'center', startPointId: 'start', endPointId: 'end', direction: 'cw' }
    ], relations: [{ id: 'length', kind: 'equal-length', lineIds: ['line-b', 'line-a'] }, { id: 'radius', kind: 'equal-radius', curveIds: ['circle', 'arc'] }] });
    expect(describeCadSketchConstraintSource(graph, { kind: 'relation', id: 'length' })).toMatchObject({
      label: 'Equal length relation 1 · Line 4 and Line 3', pointIds: ['center', 'start', 'end'], entityIds: ['line-b', 'line-a']
    });
    expect(describeCadSketchConstraintSource(graph, { kind: 'relation', id: 'radius' })).toMatchObject({
      label: 'Equal radius relation 2 · Circle 2 and Arc 1', pointIds: ['center', 'start', 'end'], entityIds: ['circle', 'arc']
    });
  });

  it.each(['radius', 'diameter'] as const)('names the displayed %s and exact curve operand for radial rejection inspection', quantity => {
    const candidate = parseCadSketchGraph({ points: [{ id: 'center', position: [0, 0] }],
      entities: [{ id: 'circle', kind: 'circle', construction: true, centerPointId: 'center', radius: 6 }],
      relations: [{ id: proposedId, kind: 'radial-size', entityId: 'circle', quantity, value: ' dimension ' }] });
    expect(describeCadSketchConstraintSource(candidate, { kind: 'relation', id: proposedId })).toMatchObject({
      label: `${quantity === 'radius' ? 'Radius' : 'Diameter'} relation 1 · Circle 1`, pointIds: ['center'], entityIds: ['circle']
    });
  });

  it.each(['parallel', 'perpendicular', 'collinear'] as const)('names %s line operands while retaining shared point and entity inspection identities', kind => {
    const candidate = parseCadSketchGraph({ points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [10, 0] }, { id: 'c', position: [0, 8] }],
      entities: [{ id: 'z-edge', kind: 'line', construction: true, startPointId: 'a', endPointId: 'b' },
        { id: 'a-edge', kind: 'line', construction: false, startPointId: 'a', endPointId: 'c' }],
      relations: [{ id: proposedId, kind, lineIds: ['z-edge', 'a-edge'] }] });
    const subject = describeCadSketchConstraintSource(candidate, { kind: 'relation', id: proposedId });
    expect(subject.label).toBe(`${kind === 'parallel' ? 'Parallel' : kind === 'perpendicular' ? 'Perpendicular' : 'Collinear'} relation 1 · Line 2 and Line 1`);
    expect(subject.pointIds).toEqual(['a', 'b', 'c']); expect(subject.entityIds).toEqual(['z-edge', 'a-edge']);
  });

  it('shows how to recover from a solver that failed rather than judged the edit, and generic wording for a failed judgement', async () => {
    const document = parseCadDocument({ ...createCadDocument('Drawing', 'drawing'), schemaVersion: 2, features: [{ id: 'sketch', name: 'Outline', kind: 'sketch',
      suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: { points: [], entities: [], relations: [] } }] });
    const present = (loadNative: () => Promise<never>) => prepareCadEdits(document, [{ kind: 'append-sketch-entities', sketchId: 'sketch', geometry: graph() }],
      createCadSketchNativeRuntime({ loadNative, wait: async () => undefined })).then(() => { throw new Error('Expected a refusal.'); }, (error: unknown) => error as CadSketchPreparationError);
    const unloaded = await present(async () => { throw new TypeError('Failed to fetch'); });
    expect(unloaded).toBeInstanceOf(CadSketchPreparationError);
    expect(unloaded).toMatchObject({ code: 'sketch-failed', message: `Outline: ${CAD_SKETCH_NATIVE_LOAD_FAILED}`, kernelMessage: 'Failed to fetch',
      feedback: { reason: 'failed', cause: 'solver-unavailable', kernelMessage: 'Failed to fetch' } });
    const incompatible = await present(async () => { throw new CadSketchNativeProtocolError('Protocol 9 is not supported.'); });
    expect(incompatible).toMatchObject({ message: `Outline: ${CAD_SKETCH_NATIVE_INCOMPATIBLE}`, feedback: { cause: 'solver-unavailable', kernelMessage: 'Protocol 9 is not supported.' } });
    // A failed judgement, as a drag that stalled, names no such cause, whatever its words, and keeps the generic wording.
    for (const message of ['Native trap at 0x2a.', CAD_SKETCH_NATIVE_LOAD_FAILED]) {
      const failed = new CadSketchPreparationError({ sketchId: 'sketch', sketchName: 'Outline', graph: graph(),
        rejection: { kind: 'rejected', reason: 'failed', message, diagnostics: unloaded.diagnostics } });
      expect(failed.message).toBe('Outline: The sketch solver could not solve this edit.'); expect(failed.solverMessage).toBe(message);
      expect(failed.feedback.cause).toBeUndefined();
    }
  });

  it('preserves a proposed relation and exact operands while presenting a readable detached rejection', () => {
    const candidate = graph(), before = JSON.stringify(candidate);
    const diagnostics = { status: 'success' as const, degreesOfFreedom: 0, conflictingIds: [proposedId, 'horizontal'], redundantIds: [], partiallyRedundantIds: [], issues: [] };
    const rejection = { kind: 'rejected', reason: 'conflicting', message: `Native conflict ${proposedId}`, diagnostics } satisfies Extract<CadSketchSolveResult, { kind: 'rejected' }>;
    const error = new CadSketchPreparationError({ sketchId: 'sketch', sketchName: 'Outline', graph: candidate, rejection });
    expect(error).toBeInstanceOf(CadError); expect(error.code).toBe('sketch-conflicting');
    expect(error.message).toBe(error.feedback.message); expect(error.message).not.toContain(proposedId);
    expect(error.solverMessage).toBe(rejection.message);
    expect(error.feedback).toMatchObject({ sketchId: 'sketch', reason: 'conflicting', subjectCount: 2, omittedSubjectCount: 0,
      subjects: [{ source: { kind: 'relation', id: proposedId }, category: 'conflicting', label: 'Distance relation 2 · Point 1 and Point 2', pointIds: ['a', 'b'], entityIds: [] },
        { source: { kind: 'relation', id: 'horizontal' }, category: 'conflicting' }] });
    diagnostics.conflictingIds[0] = 'changed-outside';
    expect(error.diagnostics.conflictingIds[0]).toBe(proposedId);
    expect(Reflect.set(error.feedback.subjects[0].pointIds, '0', 'poisoned')).toBe(false);
    expect(JSON.stringify(candidate)).toBe(before);
  });

  it('describes axis, implicit arc and known drag subjects without collapsing failure categories', () => {
    const candidate = parseCadSketchGraph({ points: [{ id: 'center', position: [0, 0] }, { id: 'start', position: [10, 0] }, { id: 'end', position: [0, 10] }],
      entities: [{ id: 'arc', kind: 'arc', construction: false, centerPointId: 'center', startPointId: 'start', endPointId: 'end', direction: 'ccw' }],
      relations: [{ id: 'fixed-y', kind: 'fixed-axis', pointId: 'start', axis: 'y', value: 0 }] });
    // A zero coordinate is the Coincident that keeps the point on an axis, which it names; any other value is a distance from the axis.
    expect(describeCadSketchConstraintSource(candidate, { kind: 'relation', id: 'fixed-y' }).label).toBe('Coincident relation 1 · Point 2 and H axis');
    const placed = { ...candidate, relations: [{ id: 'fixed-x', kind: 'fixed-axis' as const, pointId: 'end', axis: 'x' as const, value: 4 }, { id: 'pin', kind: 'fixed-point' as const, pointId: 'center', position: [0, 0] as const }] };
    expect(['fixed-x', 'pin'].map(id => describeCadSketchConstraintSource(placed, { kind: 'relation', id }).label)).toEqual(['Distance relation 1 · Point 3 and V axis', 'Fixed point relation 2 · Point 1']);
    const error = new CadSketchPreparationError({ sketchId: 'sketch', sketchName: 'Arc', graph: candidate, dragPointId: 'start', rejection: {
      kind: 'rejected', reason: 'invalid-solution', message: 'Native returned a candidate.', diagnostics: { status: 'converged', degreesOfFreedom: 2,
        conflictingIds: ['arc', 'start'], redundantIds: ['fixed-y'], partiallyRedundantIds: ['fixed-y'],
        issues: [{ source: { kind: 'entity', id: 'arc' }, code: 'arc-radius-mismatch', message: 'Unbounded source prose', residualMm: .01 }] }
    } });
    expect(error.feedback.subjects).toEqual([
      expect.objectContaining({ source: { kind: 'entity', id: 'arc' }, label: 'Arc 1 endpoint radii', category: 'conflicting', pointIds: ['center', 'start', 'end'], entityIds: ['arc'] }),
      expect.objectContaining({ source: { kind: 'point', id: 'start' }, label: 'Move Point 2', category: 'conflicting', pointIds: ['start'] }),
      expect.objectContaining({ source: { kind: 'relation', id: 'fixed-y' }, category: 'redundant' }),
      expect.objectContaining({ source: { kind: 'relation', id: 'fixed-y' }, category: 'partially-redundant' }),
      expect.objectContaining({ source: { kind: 'entity', id: 'arc' }, category: 'issue', code: 'arc-radius-mismatch', detail: 'The arc endpoints have different radii.', residualMm: .01 })
    ]);
    expect(describeCadSketchConstraintSource(candidate, { kind: 'point', id: 'start' }).label).toBe('Point 2');
    expect(error.diagnostics.issues[0].message).toBe('Unbounded source prose');
  });
});
