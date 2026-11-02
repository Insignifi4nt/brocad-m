import { describe, expect, it, vi } from 'vitest';
import { parseCadSketchGraph } from '@/domain/cad/cadSketchGraph';
import { jsonByteLength } from '@/features/webmcp/diagnosticSummaries';
import { CadSketchPreparationError } from './cadSketchConstraintFeedback';
import { cadSketchIssues } from './cadSketchIssues';
import { cadSiteTools } from './cadSiteTools';
import type { CadController } from './useCadController';
import { CAD_SKETCH_SOLVER_STOPPED, CadSketchSolverFailure } from './sketch-solver/cadSketchSolverFailure';

describe('CAD tool structured sketch rejection', () => {
  it('retains exact machine identities and candidate labels within the tool byte budget', async () => {
    const ids = Array.from({ length: 12 }, (_, index) => `r${index}`.padEnd(96, 'x'));
    const graph = parseCadSketchGraph({ points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [10, 0] }], entities: [],
      relations: ids.map(id => ({ id, kind: 'distance', pointIds: ['a', 'b'], value: 20 })) });
    const rawMessage = `Native ${ids[0]} ${'🧭\n"'.repeat(4000)}`;
    const failure = new CadSketchPreparationError({ sketchId: 'sketch', sketchName: 'Outline', graph, rejection: {
      kind: 'rejected', reason: 'conflicting', message: rawMessage, diagnostics: { status: 'success', degreesOfFreedom: -1,
        conflictingIds: ids, redundantIds: ids, partiallyRedundantIds: ids,
        issues: ids.slice(0, 3).map(id => ({ source: { kind: 'relation', id }, code: 'relation-residual', message: rawMessage, residualMm: 10 })) }
    } });
    const getController = vi.fn<() => CadController>(() => { throw failure; });
    const tool = cadSiteTools(getController).find(tool => tool.name === 'cad_edit_document');
    if (!tool) throw new Error('Missing document edit tool.');
    const reply = await tool.execute({ expectedVersion: 'current', edits: [{ kind: 'rename-document', name: 'Pending' }] });
    expect(reply).toMatchObject({ ok: false, error: { code: 'sketch-conflicting', message: 'Outline: Sketch constraints conflict.', details: {
      feedback: { sketchId: 'sketch', reason: 'conflicting', subjectCount: 39, omittedSubjectCount: 31,
        subjects: [{ source: { kind: 'relation', id: ids[0] }, category: 'conflicting', label: 'Distance relation 1 · Point 1 and Point 2', pointIds: ['a', 'b'] },
          ...ids.slice(1, 8).map(id => expect.objectContaining({ source: { kind: 'relation', id } }))] },
      analysis: { kind: 'rejected', reason: 'conflicting', status: 'success', degreesOfFreedom: -1, messageTruncated: true,
        conflicting: { ids: ids.slice(0, 8), count: 12, omittedCount: 4 },
        redundant: { ids: ids.slice(0, 8), count: 12, omittedCount: 4 },
        partiallyRedundant: { ids: ids.slice(0, 8), count: 12, omittedCount: 4 },
        issueCount: 3, omittedIssueCount: 1, issues: [expect.objectContaining({ messageTruncated: true }), expect.objectContaining({ messageTruncated: true })] }
    } } });
    // The refusal and the subjects it kept, as many as fit the issue bytes; the rest are counted.
    const { issue, issues } = (reply as { error: { details: { issue: { key: string }; issues: { items: { key: string; subject: unknown }[]; omitted: number } } } }).error.details;
    expect(issue).toMatchObject({ key: 'edit/refusal', code: 'sketch-conflicting', subject: { kind: 'feature', featureId: 'sketch' }, details: { subjectCount: 39, omittedSubjectCount: 31 } });
    expect(issues.items[0].key).toBe(issue.key);
    expect(issues.items.slice(1).map(item => item.subject)).toEqual(ids.slice(0, issues.items.length - 1).map(relationId => ({ kind: 'sketch-relation', sketchId: 'sketch', relationId })));
    expect([issues.items.length > 1, issues.items.length + issues.omitted, jsonByteLength(issues.items) <= 4096]).toEqual([true, 9, true]);
    expect(jsonByteLength(reply)).toBeLessThan(24 * 1024);
    expect(failure.diagnostics.conflictingIds).toHaveLength(12);
    expect(failure.diagnostics.issues).toHaveLength(3);
    expect(failure.solverMessage).toBe(rawMessage);
    expect(getController).toHaveBeenCalledOnce();
  });

  it('gives a solver that failed rather than judged the edit as the refusal its sketch header shows, its words bounded once in the issue', async () => {
    const graph = parseCadSketchGraph({ points: [{ id: 'a', position: [0, 0] }], entities: [], relations: [] });
    const solverFailure = new CadSketchSolverFailure(CAD_SKETCH_SOLVER_STOPPED, `Uncaught RangeError: ${'🧭'.repeat(1000)}`);
    const failure = new CadSketchPreparationError({ sketchId: 's', sketchName: 'Outline', graph, unavailable: { kernelMessage: solverFailure.kernelMessage },
      rejection: { kind: 'rejected', reason: 'failed', message: solverFailure.message,
        diagnostics: { status: null, degreesOfFreedom: null, conflictingIds: [], redundantIds: [], partiallyRedundantIds: [], issues: [] } } });
    const header = cadSketchIssues({ sketchId: 's', graph, version: 'current', feedback: failure.feedback });
    const tool = cadSiteTools(() => { throw failure; }).find(tool => tool.name === 'cad_edit_document')!;
    const reply = await tool.execute({ expectedVersion: 'current', edits: [{ kind: 'rename-document', name: 'Pending' }] });
    expect(header.refusal).toMatchObject({ code: 'sketch-failed', message: `Outline: ${CAD_SKETCH_SOLVER_STOPPED}`, details: { cause: 'solver-unavailable', kernelMessage: solverFailure.kernelMessage } });
    expect(reply).toMatchObject({ ok: false, error: { code: 'sketch-failed', message: header.refusal!.message, details: {
      feedback: { sketchId: 's', reason: 'failed', cause: 'solver-unavailable', subjectCount: 0 },
      analysis: { kind: 'rejected', reason: 'failed', message: CAD_SKETCH_SOLVER_STOPPED },
      issue: { key: header.refusal!.key, code: 'sketch-failed', message: header.refusal!.message, details: { cause: 'solver-unavailable', kernelMessage: expect.stringMatching(/^Uncaught RangeError: (🧭)+…$/) } },
      issues: { items: [{ key: header.refusal!.key }], omitted: 0 } } } });
    const details = (reply as { error: { details: { feedback: object; issue: { details: { kernelMessage: string } } } } }).error.details;
    expect(details.feedback).not.toHaveProperty('kernelMessage');
    expect(jsonByteLength(details.issue.details.kernelMessage)).toBeLessThanOrEqual(1024);
  });

  it('gives a refused sketch edit the refusal issue its sketch header shows, with no repair when no accepted sketch can be read', async () => {
    const graph = parseCadSketchGraph({ points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [10, 0] }], entities: [],
      relations: [{ id: 'r', kind: 'distance', pointIds: ['a', 'b'], value: 20 }] });
    const failure = new CadSketchPreparationError({ sketchId: 's', sketchName: 'Outline', graph, rejection: { kind: 'rejected', reason: 'conflicting', message: 'No',
      diagnostics: { status: 'success', degreesOfFreedom: -1, conflictingIds: ['r'], redundantIds: [], partiallyRedundantIds: [], issues: [] } } });
    const header = cadSketchIssues({ sketchId: 's', graph, version: 'current', feedback: failure.feedback });
    const tool = cadSiteTools(() => { throw failure; }).find(tool => tool.name === 'cad_edit_document')!;
    const reply = await tool.execute({ expectedVersion: 'current', edits: [{ kind: 'rename-document', name: 'Pending' }] });
    expect(header.refusal?.causes).toHaveLength(1);
    expect(reply).toMatchObject({ ok: false, error: { details: { issue: { key: header.refusal!.key, code: header.refusal!.code, subject: header.refusal!.subject, causes: header.refusal!.causes },
      issues: { items: [{ key: header.refusal!.key }, { key: header.list[0].key, code: 'relation-conflicting', details: { origin: 'edit' }, repairs: [] }], omitted: 0 } } } });
  });
});
