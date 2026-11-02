import { describe, expect, it, vi } from 'vitest';
import type { CadBuildResult, CadDocument, CadFeature } from '@/domain/cad/cadDocument';
import type { CadBodyKey } from '@/domain/cad/cadBodies';
import { CAD_INPUT_BLOCKED, cadBuildIssues, NO_CAD_BUILD_ISSUES } from '@/domain/cad/cadBuildIssues';
import { createCadDocument, parseCadDocument } from '@/domain/cad/cadSchema';
import { jsonByteLength } from '@/features/webmcp/diagnosticSummaries';
import { CAD_AGENT_ISSUE_BYTES, CAD_AGENT_ISSUE_COUNT, cadAgentIssueDigest } from './cadAgentIssues';
import { cadSiteTools } from './cadSiteTools';
import { CadSession } from './cadSession';
import type { CadController } from './useCadController';

const sketch: CadFeature = { id: 'sketch', name: 'Outline', kind: 'sketch', suppressed: false, plane: 'XY', offset: 0,
  profiles: [{ id: 'plate', name: 'Plate', construction: false, role: 'outer', geometry: { kind: 'rectangle', x: 0, y: 0, width: 20, height: 10, cornerRadius: 0 } }] };
const pad: CadFeature = { id: 'pad', name: 'Pad', kind: 'extrude', suppressed: false, sketchId: 'sketch', distance: 5, symmetric: false, operation: 'new', targetId: null };
/** A part whose Pad is read, through a chain of moves, by `count` later features. */
function chain(count: number): CadDocument {
  const moves: CadFeature[] = Array.from({ length: count }, (_, index) => ({ id: `move${index}`, name: `Move ${index}`, kind: 'transform', suppressed: false,
    sourceId: index ? `move${index - 1}` : 'pad', translation: [1, 0, 0], rotation: [0, 0, 0] }));
  return parseCadDocument({ ...createCadDocument('Part', 'cad_agent'), features: [sketch, pad, ...moves] });
}
const failed = (featureId: string, message = 'The extrusion failed.') => ({ code: 'kernel-operation-failed', featureId, message,
  details: { operation: 'extrude' as const, input: null, kernelMessage: 'BRep_API: command not done' } });

describe('CAD issues in agent replies', () => {
  it('gives each failure, its stop and every body issue with subject and cause, summarizing the features blocked behind them', () => {
    const document = chain(30);
    const issues = cadBuildIssues(document, { diagnostics: [failed('pad'), { code: 'rebuild-stopped', featureId: 'pad', message: 'Rebuild stopped here.' }],
      bodyIssues: [{ code: 'lost-body-parts', featureId: 'move3', body: 'pad' as CadBodyKey, pieces: ['pad/split(1)' as CadBodyKey], message: '1 piece is gone.' }] }, 'v1', true);
    const digest = cadAgentIssueDigest(issues.items);
    expect(digest.items.map(item => [item.code, item.state, item.subject, item.causes])).toEqual([
      ['kernel-operation-failed', 'failed', { kind: 'feature', featureId: 'pad' }, []],
      ['rebuild-stopped', 'blocked', { kind: 'feature', featureId: 'pad' }, ['kernel:0:kernel-operation-failed']],
      ['lost-body-parts', 'failed', { kind: 'body', key: 'pad', featureId: 'move3' }, []]]);
    // The kernel's own words stay in the diagnostic; the issue keeps the step and input.
    expect(digest.items[0].details).toEqual({ operation: 'extrude', input: null });
    expect(digest.items[0].repairs).toEqual([{ id: 'command:edit-feature:pad', kind: 'command', label: 'Edit feature' }]);
    expect(digest.blocked).toEqual([{ cause: 'kernel:0:kernel-operation-failed', count: 30, featureIds: ['move0', 'move1', 'move2', 'move3', 'move4', 'move5', 'move6', 'move7'] }]);
    expect([digest.omitted, digest.omittedBlocked, 'unresolved' in digest]).toEqual([0, 22, false]);
    expect(issues.items.filter(issue => issue.message === CAD_INPUT_BLOCKED)).toHaveLength(30);
  });

  it('stays within its bounds however many issues and however long their messages', () => {
    const document = chain(400);
    const reply = (count: number) => jsonByteLength(cadAgentIssueDigest(cadBuildIssues(chain(count), { diagnostics: [failed('pad')] }, 'v1', true).items));
    const many = Array.from({ length: 300 }, (_, index) => failed(`move${index}`, `Move ${index} failed: ${'孔'.repeat(2000)}`));
    const digest = cadAgentIssueDigest(cadBuildIssues(document, { diagnostics: many }, 'v1', true).items);
    expect(digest.items.length).toBeLessThanOrEqual(CAD_AGENT_ISSUE_COUNT);
    expect(jsonByteLength(digest.items)).toBeLessThanOrEqual(CAD_AGENT_ISSUE_BYTES);
    expect(digest.items.length + digest.omitted).toBe(300);
    // Blocking 400 features costs what blocking eight does, but for the digits of two counts: the summary names eight.
    expect(reply(400) - reply(8)).toBeLessThanOrEqual(6);
    expect(jsonByteLength(digest)).toBeLessThanOrEqual(CAD_AGENT_ISSUE_BYTES + 2048 + 256);
  });

  it('adds the issues to the context and the build reply, and the refused feature or input slot to a refused edit', async () => {
    const session = new CadSession(parseCadDocument({ ...createCadDocument('Part', 'cad_agent'), features: [sketch, pad] }));
    const version = session.getSnapshot().version, document = session.getSnapshot().document;
    const build: CadBuildResult = { buildId: 'failed', meshes: [], diagnostics: [failed('pad')], durationMs: 1 };
    const issues = cadBuildIssues(document, build, version, true);
    const controller = { session, isOpen: () => true, isBusy: () => false, buildState: 'error', buildVersion: version, build, buildIssues: issues,
      buildIssuesOf: (result: CadBuildResult) => result === build ? issues : NO_CAD_BUILD_ISSUES, inspectBuild: vi.fn(async () => build),
      edit: (edits: Parameters<CadSession['edit']>[0], expected?: string) => session.edit(edits, expected) } as unknown as CadController;
    const tools = cadSiteTools(() => controller), run = (name: string, input: unknown) => tools.find(tool => tool.name === name)!.execute(input);
    const expected = { items: [expect.objectContaining({ code: 'kernel-operation-failed', subject: { kind: 'feature', featureId: 'pad' } })], omitted: 0, blocked: [], omittedBlocked: 0 };
    expect(await run('cad_get_context', {})).toMatchObject({ ok: true, data: { issues: expected } });
    expect(await run('cad_build', { expectedVersion: version })).toMatchObject({ ok: true, data: { issues: expected } });
    const refused = await run('cad_edit_document', { expectedVersion: version, edits: [{ kind: 'add-feature', feature: { ...pad, id: 'boss', name: 'Boss', sketchId: 'missing' } }] });
    expect(refused).toMatchObject({ ok: false, error: { code: 'invalid-reference', details: { issue: { namespace: 'feature', code: 'invalid-reference', state: 'failed',
      subject: { kind: 'reference-slot', featureId: 'boss', field: 'sketchId', inputId: 'missing' } } } } });
    // A refusal that is no problem of a feature keeps the reply it had.
    const stale = await run('cad_edit_document', { expectedVersion: 'earlier', edits: [{ kind: 'set-parameter', name: 'depth', value: 4 }] });
    expect(stale).toMatchObject({ ok: false }); expect((stale as { error: object }).error).not.toHaveProperty('details');
  });
});
