import { describe, expect, it, vi } from 'vitest';
import type { CadBuildResult, CadDocument, CadFeature } from '@/domain/cad/cadDocument';
import type { CadBodyKey } from '@/domain/cad/cadBodies';
import { CAD_INPUT_BLOCKED, cadBuildIssues, NO_CAD_BUILD_ISSUES } from '@/domain/cad/cadBuildIssues';
import { CadError } from '@/domain/cad/cadError';
import { createCadDocument, parseCadDocument } from '@/domain/cad/cadSchema';
import { jsonByteLength } from '@/features/webmcp/diagnosticSummaries';
import { CAD_AGENT_ISSUE_BYTES, CAD_AGENT_ISSUE_COUNT, CAD_AGENT_KERNEL_BYTES, cadAgentIssueDigest } from './cadAgentIssues';
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
/** The diagnostics and issues of a context or build reply. */
interface AgentProblems {
  diagnostics: { details?: { kernelMessage?: string | null } }[]; omittedDiagnostics: number;
  issues: { items: { code: string; subject: { featureId?: string }; diagnostic?: number; details: { kernelMessage?: string } }[] };
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
    // With no diagnostic listed beside it, the failure gives the kernel's own words with its step and input.
    expect(digest.items[0].details).toEqual({ operation: 'extrude', input: null, kernelMessage: 'BRep_API: command not done' });
    // Only an issue that has kernel words gives them, whatever its place in the list.
    expect(digest.items.map(item => 'kernelMessage' in item.details)).toEqual([true, false, false]);
    // A failure whose diagnostic the same reply lists names it instead of repeating its words.
    const beside = cadAgentIssueDigest(issues.items, new Map([[issues.diagnosticKeys[0], 0]]));
    expect([beside.items[0].details, beside.items[0].diagnostic, 'diagnostic' in beside.items[1]]).toEqual([{ operation: 'extrude', input: null }, 0, false]);
    expect(issues.diagnosticKeys).toEqual(['kernel:0:kernel-operation-failed', 'kernel:1:rebuild-stopped']);
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

  it.each([
    { words: '孔'.repeat(2048), kind: 'CJK' },
    { words: '\u0001"\\\n'.repeat(512), kind: 'escape-heavy ASCII' },
  ])('keeps a bounded account of $kind kernel words for a listed failure in the context and the build reply', async ({ words }) => {
    const session = new CadSession(parseCadDocument({ ...createCadDocument('Part', 'cad_agent'), features: [sketch, pad] }));
    const version = session.getSnapshot().version, document = session.getSnapshot().document;
    const build: CadBuildResult = { buildId: 'failed', meshes: [], durationMs: 1, diagnostics: [{ ...failed('pad'), details: { operation: 'extrude', input: null, kernelMessage: words } }] };
    const issues = cadBuildIssues(document, build, version, true);
    const controller = { session, isOpen: () => true, isBusy: () => false, buildState: 'error', buildVersion: version, build, buildIssues: issues,
      buildIssuesOf: () => issues, inspectBuild: vi.fn(async () => build) } as unknown as CadController;
    const tools = cadSiteTools(() => controller), run = async (name: string, input: unknown) => (await tools.find(tool => tool.name === name)!.execute(input) as { data: AgentProblems }).data;
    for (const reply of [await run('cad_get_context', {}), await run('cad_build', { expectedVersion: version })]) {
      // The diagnostic stays listed, its kernel words cut to their byte budget with an ellipsis; the issue names it rather than repeat them.
      expect([reply.diagnostics.length, reply.omittedDiagnostics, reply.issues.items.length]).toEqual([1, 0, 1]);
      const kept = reply.diagnostics[0].details!.kernelMessage!;
      expect(kept.endsWith('…')).toBe(true); expect(words.startsWith(kept.slice(0, -1))).toBe(true);
      expect(jsonByteLength(kept)).toBeLessThanOrEqual(CAD_AGENT_KERNEL_BYTES); expect(jsonByteLength(kept)).toBeGreaterThan(CAD_AGENT_KERNEL_BYTES - 8);
      expect(reply.issues.items[0]).toMatchObject({ code: 'kernel-operation-failed', diagnostic: 0, details: { operation: 'extrude', input: null } });
      expect(reply.issues.items[0].details).not.toHaveProperty('kernelMessage');
    }
  });

  it('gives the kernel words in the issue of a failure whose diagnostic the reply cannot list', async () => {
    const document = chain(3), long = 'x'.repeat(1000);
    const build: CadBuildResult = { buildId: 'failed', meshes: [], durationMs: 1, diagnostics: ['move0', 'move1', 'move2'].map(featureId =>
      ({ ...failed(featureId, `${featureId} failed: ${long}`), details: { operation: 'transform' as const, input: null, kernelMessage: `${featureId}: ${'孔'.repeat(2048)}` } })) };
    const session = new CadSession(document), version = session.getSnapshot().version, issues = cadBuildIssues(document, build, version, true);
    const controller = { session, isOpen: () => true, isBusy: () => false, buildState: 'error', buildVersion: version, build, buildIssues: issues,
      buildIssuesOf: () => issues, inspectBuild: vi.fn(async () => build) } as unknown as CadController;
    const tool = cadSiteTools(() => controller).find(candidate => candidate.name === 'cad_build')!;
    const reply = (await tool.execute({ expectedVersion: version }) as { data: AgentProblems }).data;
    // One diagnostic fits its 4,096 bytes; the issues list two failures, the second giving its own words.
    expect([reply.diagnostics.length, reply.omittedDiagnostics]).toEqual([1, 2]);
    expect(reply.issues.items.map(item => [item.subject.featureId, item.diagnostic ?? null, item.details.kernelMessage?.slice(0, 7) ?? null])).toEqual([
      ['move0', 0, null], ['move1', null, 'move1: ']]);
    expect(jsonByteLength(reply.issues.items[1].details.kernelMessage)).toBeLessThanOrEqual(CAD_AGENT_KERNEL_BYTES);
    expect(jsonByteLength(reply.diagnostics)).toBeLessThanOrEqual(4096); expect(jsonByteLength(reply.issues.items)).toBeLessThanOrEqual(CAD_AGENT_ISSUE_BYTES);
    // Every listed failure has its kernel words somewhere in the reply.
    for (const item of reply.issues.items) expect(item.diagnostic === undefined ? item.details.kernelMessage : reply.diagnostics[item.diagnostic].details!.kernelMessage).toMatch(/^move\d: 孔+…$/);
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
  it('gives the kernel\'s own words with a refusal that came back from it, in its issue, or in the details when no issue covers it', async () => {
    const session = new CadSession(parseCadDocument({ ...createCadDocument('Part', 'cad_agent'), features: [sketch, pad] }));
    const version = session.getSnapshot().version;
    let refusal = CadError.received('kernel-operation-failed', 'The part could not be rebuilt. Rebuild again; if this repeats, undo the last change.', { kernelMessage: 'Standard_ConstructionError: gp_Dir() - input vector has zero norm' });
    const controller = { session, isOpen: () => true, isBusy: () => false, buildState: 'error', buildVersion: version, build: null, buildIssues: NO_CAD_BUILD_ISSUES,
      buildIssuesOf: () => NO_CAD_BUILD_ISSUES, inspectBuild: vi.fn(async () => { throw refusal; }) } as unknown as CadController;
    const tools = cadSiteTools(() => controller), build = () => tools.find(tool => tool.name === 'cad_build')!.execute({ expectedVersion: version });
    const failed = await build();
    expect(failed).toMatchObject({ ok: false, error: { code: 'kernel-operation-failed', message: 'The part could not be rebuilt. Rebuild again; if this repeats, undo the last change.',
      details: { issue: { code: 'kernel-operation-failed', subject: { kind: 'document' }, details: { kernelMessage: 'Standard_ConstructionError: gp_Dir() - input vector has zero norm' } } } } });
    // The message never repeats the kernel's words.
    expect((failed as { error: { message: string } }).error.message).not.toContain('Standard_ConstructionError');
    refusal = CadError.received('kernel-unavailable', 'The CAD kernel could not be loaded. Reload the page; if this repeats, use a browser that runs WebAssembly.', { kernelMessage: 'WebAssembly.instantiate(): Out of memory' });
    expect(await build()).toMatchObject({ ok: false, error: { code: 'kernel-unavailable', details: { kernelMessage: 'WebAssembly.instantiate(): Out of memory' } } });
    // However long the kernel's words, a refusal gives them within their byte budget, with an ellipsis where they were cut.
    refusal = CadError.received('kernel-operation-failed', 'The part could not be rebuilt. Rebuild again; if this repeats, undo the last change.', { kernelMessage: '孔'.repeat(2048) });
    const long = await build() as { error: { details: { issue: { details: { kernelMessage: string } } } } };
    expect(long.error.details.issue.details.kernelMessage).toMatch(/^孔+…$/); expect(jsonByteLength(long.error.details.issue.details.kernelMessage)).toBeLessThanOrEqual(CAD_AGENT_KERNEL_BYTES);
    refusal = CadError.received('kernel-unavailable', 'The CAD kernel could not be loaded. Reload the page; if this repeats, use a browser that runs WebAssembly.', { kernelMessage: '\u0001'.repeat(2048) });
    const alone = await build() as { error: { details: { kernelMessage: string } } };
    expect(alone.error.details.kernelMessage.endsWith('…')).toBe(true); expect(jsonByteLength(alone.error.details.kernelMessage)).toBeLessThanOrEqual(CAD_AGENT_KERNEL_BYTES);
    // A refusal without kernel words keeps the reply it had.
    refusal = new CadError('step-export', 'The bodies could not be written as a STEP file.');
    const plain = await build();
    expect(plain).toMatchObject({ ok: false, error: { code: 'step-export' } }); expect((plain as { error: object }).error).not.toHaveProperty('details');
  });
});
