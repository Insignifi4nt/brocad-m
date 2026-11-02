import { cadIssueDigest, type CadIssue } from '@/domain/cad/cadIssues';
import { jsonByteLength, summarizeMessage } from '@/features/webmcp/diagnosticSummaries';

/** The most issues a reply lists in full. */
export const CAD_AGENT_ISSUE_COUNT = 10;
/** The bytes the listed issues may take, and the bytes the blocked-feature summaries may take, whatever the ids and messages hold. */
export const CAD_AGENT_ISSUE_BYTES = 4096;
export const CAD_AGENT_BLOCKED_BYTES = 2048;

/**
 * One issue as a reply gives it: what it is about, its message (summarized as diagnostics are), the issues it names as causes, its typed
 * details and the repairs the workbench offers. The kernel's own words stay in the diagnostic the issue came from, so they are not repeated.
 */
export function cadAgentIssue(issue: CadIssue) {
  const details: Record<string, unknown> = { ...issue.details };
  delete details.kernelMessage;
  return { key: issue.key, namespace: issue.namespace, code: issue.code, severity: issue.severity, state: issue.state, subject: issue.subject,
    ...summarizeMessage(issue.message), causes: issue.causes, details, repairs: issue.repairs.map(repair => ({ id: repair.id, kind: repair.kind, label: repair.label })) };
}
export type CadAgentIssue = ReturnType<typeof cadAgentIssue>;

/**
 * The issues of list `issues` as a reply carries them, bounded whatever the part holds (`cadIssueDigest`):
 * - `items`: the issues in list order, failures first, but those causal blocking adds, at most `CAD_AGENT_ISSUE_COUNT` and
 *   `CAD_AGENT_ISSUE_BYTES`; `omitted` counts the rest.
 * - `blocked`: under each listed root cause, how many features it keeps from evaluating and the first of them; `omittedBlocked` counts the
 *   blocked features no summary names.
 * - `unresolved`: only when some issue names causes that resolve to nothing, which only a malformed list has.
 * The causes of a listed issue are listed issues, or issues counted in `omitted` when the list was cut.
 */
export function cadAgentIssueDigest(issues: readonly CadIssue[]) {
  const digest = cadIssueDigest(issues);
  const items = digest.issues.slice(0, CAD_AGENT_ISSUE_COUNT).map(cadAgentIssue);
  while (items.length && jsonByteLength(items) > CAD_AGENT_ISSUE_BYTES) items.pop();
  const listed = new Set(items.map(item => item.key));
  const blocked = digest.blocked.filter(summary => listed.has(summary.cause));
  while (blocked.length && jsonByteLength(blocked) > CAD_AGENT_BLOCKED_BYTES) blocked.pop();
  const named = new Set(blocked.flatMap(summary => summary.featureIds));
  const blockedCount = new Set(issues.flatMap(issue => issue.code === 'input-blocked' ? [issue.subject.featureId] : [])).size;
  return { items, omitted: digest.issues.length - items.length, blocked, omittedBlocked: blockedCount - named.size,
    ...(digest.unresolved.count ? { unresolved: { count: digest.unresolved.count, keys: digest.unresolved.issues.map(issue => issue.key) } } : {}) };
}
