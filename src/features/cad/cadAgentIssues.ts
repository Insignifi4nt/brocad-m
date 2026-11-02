import { cadIssueDigest, type CadIssue } from '@/domain/cad/cadIssues';
import { boundedTextBytes, jsonByteLength, summarizeMessage } from '@/features/webmcp/diagnosticSummaries';

/** The most issues a reply lists in full. */
export const CAD_AGENT_ISSUE_COUNT = 10;
/** The bytes the listed issues may take, and the bytes the blocked-feature summaries may take, whatever the ids and messages hold. */
export const CAD_AGENT_ISSUE_BYTES = 4096;
export const CAD_AGENT_BLOCKED_BYTES = 2048;
/**
 * The bytes the kernel's own words may take wherever a reply gives them, serialized: the budget a message has, so one failure with its
 * message and kernel words fits a reply's diagnostics or issues alone.
 */
export const CAD_AGENT_KERNEL_BYTES = 1024;

/** The kernel's words `text` as a reply gives them: within `CAD_AGENT_KERNEL_BYTES`, ending in an ellipsis when cut. */
export function cadAgentKernelMessage(text: string): string {
  return boundedTextBytes(text, CAD_AGENT_KERNEL_BYTES);
}

/**
 * One issue as a reply gives it: what it is about, its message (summarized as diagnostics are), the issues it names as causes, its typed
 * details and the repairs the workbench offers. The kernel's own words are `details.kernelMessage`, bounded (`cadAgentKernelMessage`):
 * `kernelMessage` when given, as a refusal gives them, or else the issue's own. With `diagnostic`, the position of the diagnostic the issue
 * came from in the same reply, the issue leaves its kernel words to that diagnostic and names its position instead, so a reply does not
 * give them twice.
 */
export function cadAgentIssue(issue: CadIssue, kernelMessage?: string, diagnostic?: number) {
  const details: Record<string, unknown> = { ...issue.details };
  const words = kernelMessage ?? (typeof details.kernelMessage === 'string' ? details.kernelMessage : undefined);
  delete details.kernelMessage;
  if (diagnostic === undefined && words) details.kernelMessage = cadAgentKernelMessage(words);
  return { key: issue.key, namespace: issue.namespace, code: issue.code, severity: issue.severity, state: issue.state, subject: issue.subject,
    ...summarizeMessage(issue.message), causes: issue.causes, details, ...(diagnostic === undefined ? {} : { diagnostic }),
    repairs: issue.repairs.map(repair => ({ id: repair.id, kind: repair.kind, label: repair.label })) };
}
export type CadAgentIssue = ReturnType<typeof cadAgentIssue>;

/**
 * The issues of list `issues` as a reply carries them, bounded whatever the part holds (`cadIssueDigest`):
 * - `items`: the issues in list order, failures first, but those causal blocking adds, at most `CAD_AGENT_ISSUE_COUNT` and
 *   `CAD_AGENT_ISSUE_BYTES`; `omitted` counts the rest. Each listed failure gives the kernel's words, bounded, unless `listedDiagnostics`
 *   maps its key to the position of its diagnostic in the same reply, which gives them (`cadAgentIssue`).
 * - `blocked`: under each listed root cause, how many features it keeps from evaluating and the first of them; `omittedBlocked` counts the
 *   blocked features no summary names.
 * - `unresolved`: only when some issue names causes that resolve to nothing, which only a malformed list has.
 * The causes of a listed issue are listed issues, or issues counted in `omitted` when the list was cut.
 */
export function cadAgentIssueDigest(issues: readonly CadIssue[], listedDiagnostics: ReadonlyMap<string, number> = new Map()) {
  const digest = cadIssueDigest(issues);
  const items = digest.issues.slice(0, CAD_AGENT_ISSUE_COUNT).map(issue => cadAgentIssue(issue, undefined, listedDiagnostics.get(issue.key)));
  while (items.length && jsonByteLength(items) > CAD_AGENT_ISSUE_BYTES) items.pop();
  const listed = new Set(items.map(item => item.key));
  const blocked = digest.blocked.filter(summary => listed.has(summary.cause));
  while (blocked.length && jsonByteLength(blocked) > CAD_AGENT_BLOCKED_BYTES) blocked.pop();
  const named = new Set(blocked.flatMap(summary => summary.featureIds));
  const blockedCount = new Set(issues.flatMap(issue => issue.code === 'input-blocked' ? [issue.subject.featureId] : [])).size;
  return { items, omitted: digest.issues.length - items.length, blocked, omittedBlocked: blockedCount - named.size,
    ...(digest.unresolved.count ? { unresolved: { count: digest.unresolved.count, keys: digest.unresolved.issues.map(issue => issue.key) } } : {}) };
}
