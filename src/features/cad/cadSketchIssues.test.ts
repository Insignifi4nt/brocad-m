import { describe, expect, it } from 'vitest';
import { parseCadSketchGraph } from '@/domain/cad/cadSketchGraph';
import { CAD_SKETCH_MIRROR_COLLAPSE } from '@/domain/cad/cadSketchSymmetryRelations';
import { CadSketchPreparationError } from './cadSketchConstraintFeedback';
import { cadIssueListProblems, preparedCadIssueRepair } from '@/domain/cad/cadIssues';
import { cadSketchAnalysisIssues, cadSketchIssues, noCadSketchIssues } from './cadSketchIssues';
import type { CadSketchSolveDiagnostics } from './sketch-solver/cadSketchSolverTypes';
import { CAD_SKETCH_SOLVER_STOPPED } from './sketch-solver/cadSketchSolverFailure';
import { CAD_SKETCH_NATIVE_LOAD_FAILED } from './sketch-solver/cadSketchSolverMessages';

const graph = parseCadSketchGraph({ points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [10, 0] }, { id: 'c', position: [10, 10] }, { id: 'd', position: [5, -5] }, { id: 'e', position: [5, 15] }],
  entities: [{ id: 'ab', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' }, { id: 'bc', kind: 'line', construction: false, startPointId: 'b', endPointId: 'c' },
    { id: 'de', kind: 'line', construction: true, startPointId: 'd', endPointId: 'e' }],
  relations: [{ id: 'flat', kind: 'horizontal', pointIds: ['a', 'b'] }, { id: 'again', kind: 'horizontal', pointIds: ['a', 'b'] }, { id: 'width', kind: 'distance', pointIds: ['a', 'b'], value: 10 },
    { id: 'mirror', kind: 'symmetric', pointIds: ['a', 'b'], lineId: 'de' }] });
const diagnostics = (overrides: Partial<CadSketchSolveDiagnostics>): CadSketchSolveDiagnostics => ({ status: 'success', degreesOfFreedom: 0, conflictingIds: [], redundantIds: [], partiallyRedundantIds: [], issues: [], ...overrides });

describe('sketch issues', () => {
  it('lists the accepted analysis by category, with each relation keyed for its tree row', () => {
    const analysis = cadSketchAnalysisIssues({ kind: 'rejected', reason: 'redundant', diagnostics: diagnostics({ redundantIds: ['again'], partiallyRedundantIds: ['flat'],
      issues: [{ source: { kind: 'relation', id: 'width' }, code: 'relation-residual', message: 'Off by 1.', residualMm: 1 }, { source: { kind: 'entity', id: 'bc' }, code: 'degenerate-entity', message: 'Short.' }] }) });
    const issues = cadSketchIssues({ sketchId: 'sketch', graph, version: 'v1', analysis });
    expect(issues.message).toBe('Sketch constraints are redundant.');
    expect(issues.list.map(issue => [issue.category, issue.state, issue.relationId, issue.origin])).toEqual([
      ['redundant', 'Redundant', 'again', 'analysis'], ['partially-redundant', 'Partly redundant', 'flat', 'analysis'],
      ['not-met', 'Not met', 'width', 'analysis'], ['geometry', 'Geometry issue', null, 'analysis']]);
    expect(issues.byRelation.get('width')?.map(issue => issue.category)).toEqual(['not-met']);
    expect(issues.list[3]).toMatchObject({ label: 'Line 2', pointIds: ['b', 'c'], entityIds: ['bc'], detail: 'The edge endpoints are too close.' });
  });
  it('prefers the refused edit of this sketch to the analysis, and keeps what it left out', () => {
    const analysis = cadSketchAnalysisIssues({ kind: 'rejected', reason: 'redundant', diagnostics: diagnostics({ redundantIds: ['again'] }) });
    const refused = new CadSketchPreparationError({ sketchId: 'sketch', sketchName: 'Plate', graph, rejection: { kind: 'rejected', reason: 'conflicting', message: 'No.',
      diagnostics: diagnostics({ conflictingIds: ['width', 'flat', 'again', 'mirror', 'a', 'b', 'c', 'ab', 'bc', 'de'] }) } }).feedback;
    const issues = cadSketchIssues({ sketchId: 'sketch', graph, version: 'v1', analysis, feedback: refused });
    expect(issues.message).toBe('Plate: Sketch constraints conflict.');
    expect(issues.list.every(issue => issue.origin === 'edit' && issue.category === 'conflicting')).toBe(true);
    expect([issues.list.length, issues.omitted]).toEqual([8, 2]);
    // Another sketch's refusal leaves this sketch's analysis shown.
    expect(cadSketchIssues({ sketchId: 'other', graph, version: 'v1', analysis, feedback: refused }).list.map(issue => issue.origin)).toEqual(['analysis']);
  });
  it('adds the shrink warnings of the last accepted edit on this sketch to the relation that shrank its curves', () => {
    const warning = { code: 'mirror-shrank' as const, relationId: 'mirror', curves: [{ entityId: 'ab', beforeMm: 10, afterMm: 0.01 }], message: 'Symmetric shrank Line 1.', sketchId: 'sketch', sketchName: 'Plate' };
    const issues = cadSketchIssues({ sketchId: 'sketch', graph, version: 'v1', warnings: [warning, { ...warning, sketchId: 'other' }, { ...warning, relationId: 'removed' }] });
    expect(issues.message).toBeNull();
    expect(issues.list).toHaveLength(1);
    expect(issues.list[0]).toMatchObject({ category: 'shrink', state: 'Shrinks', relationId: 'mirror', origin: 'warning', detail: 'Symmetric shrank Line 1.' });
    expect(issues.list[0].entityIds).toEqual(expect.arrayContaining(['ab', 'de']));
    expect(issues.byRelation.get('mirror')).toHaveLength(1);
  });
  it('keeps an analysis that names nothing as no issues, and an equal analysis as the same value', () => {
    expect(cadSketchAnalysisIssues({ kind: 'solved', diagnostics: diagnostics({}) })).toBeNull();
    const first = cadSketchAnalysisIssues({ kind: 'solved', diagnostics: diagnostics({ redundantIds: ['again'] }) });
    expect(cadSketchAnalysisIssues({ kind: 'solved', diagnostics: diagnostics({ redundantIds: ['again'] }) }, first)).toBe(first);
    expect(cadSketchIssues({ sketchId: 'sketch', graph, version: 'v1' })).toMatchObject({ list: [], refusal: null, issues: [] });
    expect(noCadSketchIssues('sketch')).toMatchObject({ list: [], refusal: null, issues: [], message: null });
  });
});

describe('sketch issues in the CAD issue model', () => {
  it('gives each row an issue with its code, severity and subject, and the refusal as their cause', () => {
    const analysis = cadSketchAnalysisIssues({ kind: 'rejected', reason: 'conflicting', diagnostics: diagnostics({ conflictingIds: ['width'], redundantIds: ['again'], partiallyRedundantIds: ['flat'],
      issues: [{ source: { kind: 'relation', id: 'mirror' }, code: 'relation-residual', message: 'Off.' }, { source: { kind: 'entity', id: 'bc' }, code: 'degenerate-entity', message: 'Short.' }] }) });
    const issues = cadSketchIssues({ sketchId: 'sketch', graph, version: 'v1', analysis });
    expect(issues.list.map(row => [row.issue.code, row.issue.severity, row.issue.state, row.issue.subject])).toEqual([
      ['relation-conflicting', 'error', 'failed', { kind: 'sketch-relation', sketchId: 'sketch', relationId: 'width' }],
      ['relation-redundant', 'warning', 'failed', { kind: 'sketch-relation', sketchId: 'sketch', relationId: 'again' }],
      ['relation-partially-redundant', 'warning', 'failed', { kind: 'sketch-relation', sketchId: 'sketch', relationId: 'flat' }],
      ['relation-residual', 'error', 'failed', { kind: 'sketch-relation', sketchId: 'sketch', relationId: 'mirror' }],
      ['degenerate-entity', 'error', 'failed', { kind: 'sketch-entity', sketchId: 'sketch', entityId: 'bc' }]]);
    // A residual the check could not measure keeps its place as null.
    expect(issues.list[3].issue.details).toMatchObject({ origin: 'analysis', residualMm: null });
    expect(issues.list.every(row => row.issue.key === row.key && row.issue.message === row.detail)).toBe(true);
    expect(issues.refusal).toMatchObject({ code: 'sketch-conflicting', severity: 'error', subject: { kind: 'feature', featureId: 'sketch' }, message: 'Sketch constraints conflict.',
      causes: issues.list.map(row => row.key), details: { cause: null, subjectCount: 5, omittedSubjectCount: 0 } });
    expect(issues.issues).toEqual([issues.refusal, ...issues.list.map(row => row.issue)]);
    expect(cadIssueListProblems(issues.issues)).toEqual([]);
  });

  it('keeps a refused edit\'s message and counts, and names a collapse Symmetric refused as the cause', () => {
    const refused = new CadSketchPreparationError({ sketchId: 'sketch', sketchName: 'Plate', graph, rejection: { kind: 'rejected', reason: 'conflicting', message: 'No.',
      diagnostics: diagnostics({ conflictingIds: ['width', 'flat', 'again', 'mirror', 'a', 'b', 'c', 'ab', 'bc', 'de'] }) } }).feedback;
    const issues = cadSketchIssues({ sketchId: 'sketch', graph, version: 'v1', feedback: refused });
    expect(issues.refusal).toMatchObject({ key: 'edit/refusal', message: refused.message, details: { subjectCount: refused.subjectCount, omittedSubjectCount: 2 } });
    expect(issues.refusal?.causes).toHaveLength(8);
    const collapsed = { ...refused, message: `Plate: ${CAD_SKETCH_MIRROR_COLLAPSE}`, reason: 'invalid-input' as const };
    expect(cadSketchIssues({ sketchId: 'sketch', graph, version: 'v1', feedback: collapsed }).refusal).toMatchObject({ code: 'sketch-invalid-input', details: { cause: 'mirror-collapse' } });
  });

  it('names a solver that failed rather than judged the sketch as the cause of its refusal, with its words, from a refused edit or the analysis alike', () => {
    const unjudged = { ...diagnostics({}), status: null, degreesOfFreedom: null };
    const refused = new CadSketchPreparationError({ sketchId: 'sketch', sketchName: 'Plate', graph, unavailable: { kernelMessage: 'Uncaught RangeError: out of memory' },
      rejection: { kind: 'rejected', reason: 'failed', message: CAD_SKETCH_SOLVER_STOPPED, diagnostics: unjudged } }).feedback;
    const edit = cadSketchIssues({ sketchId: 'sketch', graph, version: 'v1', feedback: refused });
    expect(edit.refusal).toMatchObject({ code: 'sketch-failed', message: `Plate: ${CAD_SKETCH_SOLVER_STOPPED}`, causes: [],
      details: { cause: 'solver-unavailable', subjectCount: 0, omittedSubjectCount: 0, kernelMessage: 'Uncaught RangeError: out of memory' } });
    expect(edit.message).toBe(`Plate: ${CAD_SKETCH_SOLVER_STOPPED}`);
    // The analysis of the accepted sketch, which the solver could not give, refuses it the same way.
    const unavailable = cadSketchAnalysisIssues({ kind: 'unavailable', message: CAD_SKETCH_SOLVER_STOPPED, cause: 'solver-unavailable', kernelMessage: 'Uncaught RangeError: out of memory',
      diagnostics: unjudged });
    expect(unavailable).toMatchObject({ kind: 'unavailable', reason: 'failed', cause: 'solver-unavailable', message: CAD_SKETCH_SOLVER_STOPPED });
    const analysed = cadSketchIssues({ sketchId: 'sketch', graph, version: 'v1', analysis: unavailable });
    expect(analysed.refusal).toMatchObject({ key: 'analysis/refusal', code: 'sketch-failed', message: CAD_SKETCH_SOLVER_STOPPED,
      details: { cause: 'solver-unavailable', subjectCount: 0, omittedSubjectCount: 0, kernelMessage: 'Uncaught RangeError: out of memory' } });
    // A solver that could not load says how to recover, and names the same cause without words.
    const unloaded = cadSketchIssues({ sketchId: 'sketch', graph, version: 'v1',
      analysis: cadSketchAnalysisIssues({ kind: 'rejected', reason: 'failed', message: CAD_SKETCH_NATIVE_LOAD_FAILED, diagnostics: unjudged }) });
    expect(unloaded.refusal).toMatchObject({ message: CAD_SKETCH_NATIVE_LOAD_FAILED, details: { cause: 'solver-unavailable' } });
    expect('kernelMessage' in unloaded.refusal!.details).toBe(false);
    // An analysis that is unavailable for another reason, or a solver that failed for a reason of the sketch, names no such cause.
    expect(cadSketchAnalysisIssues({ kind: 'unavailable', message: 'Constraint analysis is unavailable.', diagnostics: unjudged })).toBeNull();
    const judged = cadSketchIssues({ sketchId: 'sketch', graph, version: 'v1', analysis: cadSketchAnalysisIssues({ kind: 'rejected', reason: 'failed', message: 'No.', diagnostics: unjudged }) });
    expect(judged.refusal).toMatchObject({ message: 'The sketch solver could not solve this sketch.', details: { cause: null } });
    expect(cadIssueListProblems(edit.issues)).toEqual([]); expect(cadIssueListProblems(analysed.issues)).toEqual([]);
  });

  it('records the curves a shrink kept, leaving out those the graph no longer has', () => {
    const warning = { code: 'mirror-shrank' as const, relationId: 'mirror', message: 'Symmetric shrank Line 1.', sketchId: 'sketch', sketchName: 'Plate',
      curves: [{ entityId: 'ab', beforeMm: 10, afterMm: 0.01 }, { entityId: 'gone', beforeMm: 4, afterMm: 1 }] };
    const [row] = cadSketchIssues({ sketchId: 'sketch', graph, version: 'v1', warnings: [warning] }).list;
    expect(row.issue).toMatchObject({ code: 'mirror-shrank', severity: 'warning', subject: { kind: 'sketch-relation', relationId: 'mirror' }, repairs: [],
      details: { curves: [{ entityId: 'ab', beforeMm: 10, afterMm: 0.01 }] } });
  });

  it('offers deleting a relation the solver names, as its row does, prepared at the version and refused once stale', () => {
    const patterned = parseCadSketchGraph({ points: [...graph.points, { id: 'center', position: [30, 30] }],
      entities: [...graph.entities, { id: 'seed', kind: 'circle', construction: false, centerPointId: 'center', radius: 3 }], relations: [...graph.relations,
        { id: 'row', kind: 'linear-pattern', seed: { kind: 'circle', entityId: 'seed', centerPointId: 'center' }, idPrefix: 'holes', direction: '+x', count: 1, spacing: 5, omittedInstances: [] }] });
    const analysis = cadSketchAnalysisIssues({ kind: 'rejected', reason: 'conflicting', diagnostics: diagnostics({ conflictingIds: ['width', 'row'], redundantIds: ['again'],
      issues: [{ source: { kind: 'relation', id: 'mirror' }, code: 'relation-residual', message: 'Off.', residualMm: 1 }] }) });
    const issues = cadSketchIssues({ sketchId: 'sketch', graph: patterned, version: 'v7', analysis });
    const repairs = Object.fromEntries(issues.list.map(row => [`${row.category}:${row.relationId}`, row.issue.repairs]));
    expect(repairs['conflicting:width']).toEqual([{ id: 'delete-relation:width', label: 'Delete relation', preparedAt: 'v7', kind: 'edit',
      edits: [{ kind: 'remove-sketch-relation', sketchId: 'sketch', relationId: 'width' }] }]);
    expect(repairs['redundant:again']?.[0]).toMatchObject({ id: 'delete-relation:again', preparedAt: 'v7' });
    // A pattern detaches through its editor, and a relation not met has no single repair.
    expect([repairs['conflicting:row'], repairs['not-met:mirror']]).toEqual([[], []]);
    const [repair] = repairs['conflicting:width']!;
    expect(preparedCadIssueRepair(repair, 'v7')).toBe(repair);
    expect(() => preparedCadIssueRepair(repair, 'v8')).toThrow(expect.objectContaining({ code: 'stale-repair' }));
  });
});
