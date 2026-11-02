import type { CadBodyKey, CadBodyUntrackedReason } from './cadBodies';
import type { CadDocument, CadKernelFailureDetails } from './cadDocument';
import { CadError } from './cadError';
import { cadFeatureDependencies } from './cadFeatureInputs';
import type { CadCamCode, CadRefusalCode, CadRefusalFactCode, CadRefusalFacts, CadSketchGraphCode, CadSketchRefusalCode, CadSketchRelationCode } from './cadIssueCodes';
import type { CadEdit } from './cadOperations';
import { cadFeatureActive } from './features/cadFeatureActivity';

/**
 * One CAD problem, whichever part of the app found it. Every producer maps its own findings into this shape through its adapter, and the
 * sketch header, the feature tree, the model issue list and the agent replies read nothing else.
 *
 * - `namespace` and `code` name the problem. A code keeps the spelling its producer gives it; the namespace says which producer that is.
 *   Each namespace has a closed set of codes (`cadIssueCodes.ts`), and the code fixes the type of `details`, the subjects it can be about
 *   and its state: checking `issue.code` narrows them.
 * - `severity`: an error stops the model or the edit, a warning leaves a result that may not be what was meant, and info explains.
 * - `state`: `failed` is a problem of the subject itself, which may also list in `causes` the issues of inputs it reads that failed too;
 *   `blocked` means the issues it lists in `causes`, at least one, keep the subject from evaluating.
 * - `subject` names what the problem is about by id or body key, never by a display name.
 * - `details` are the facts a consumer needs beyond the message, typed per code. Free text appears only as the kernel's own words.
 * - `repairs` are prepared operations an existing action already performs, each with the document version it was prepared against.
 *
 * An issue is detached from what built it and frozen through, and a list of issues (`createCadIssueList`) has unique keys and causes that
 * name issues of the same list, with no cycle.
 */
export type CadIssue = CadSketchIssueOf | CadFeatureIssueOf | CadKernelIssueOf | CadBodyIssueOf | CadCamIssueOf;
export type CadIssueNamespace = CadIssue['namespace'];
export type CadIssueSeverity = 'error' | 'warning' | 'info';
export type CadIssueState = 'failed' | 'blocked';

export type CadIssueSubject =
  | { readonly kind: 'document' }
  | { readonly kind: 'feature'; readonly featureId: string }
  | { readonly kind: 'sketch-relation'; readonly sketchId: string; readonly relationId: string }
  | { readonly kind: 'sketch-entity'; readonly sketchId: string; readonly entityId: string }
  | { readonly kind: 'sketch-point'; readonly sketchId: string; readonly pointId: string }
  /** An input slot of a feature: the field that names the input, and the id it named. */
  | { readonly kind: 'reference-slot'; readonly featureId: string; readonly field: string; readonly inputId: string }
  | { readonly kind: 'body'; readonly key: CadBodyKey; readonly featureId: string }
  | { readonly kind: 'cam-operation'; readonly operation: CadCamOperation; readonly sourceId: string };
type SubjectOf<K extends CadIssueSubject['kind']> = Extract<CadIssueSubject, { readonly kind: K }>;

/** The cause a sketch refusal names beyond its code, when one is known. */
export type CadSketchRefusalCause = 'mirror-collapse' | 'solver-unavailable';
export type CadCamOperation = 'section' | 'send-sketch';

/** An issue of namespace `N` with code `C`, whose details are `D`, about a subject `S`, in state `T`. */
interface CadIssueOf<N extends string, C extends string, D, S extends CadIssueSubject, T extends CadIssueState> {
  /** Unique within one list of issues; causes link by it. */
  readonly key: string;
  readonly namespace: N;
  /** The producer's own code, spelled as it gives it; with the namespace, a stable id of the problem. */
  readonly code: C;
  readonly severity: CadIssueSeverity;
  readonly state: T;
  readonly subject: S;
  readonly message: string;
  readonly causes: readonly string[];
  readonly repairs: readonly CadIssueRepair[];
  readonly details: D;
}
/** Details of a code that carries no facts beyond its subject. */
export type CadNoIssueDetails = Readonly<Record<string, never>>;

type SketchItemSubject = SubjectOf<'sketch-relation' | 'sketch-entity' | 'sketch-point'>;
/** Where a sketch item comes from: the analysis of the accepted sketch, the edit just refused, or the last accepted edit's warnings. */
export type CadSketchItemOrigin = 'analysis' | 'edit' | 'warning';
interface CadSketchItemDetails { readonly origin: CadSketchItemOrigin; readonly pointIds: readonly string[]; readonly entityIds: readonly string[] }
export type CadSketchIssueOf =
  /** The refusal of an edit or of the accepted analysis, which the items it names list as their cause; it counts the items it names and those it leaves out. */
  | CadIssueOf<'sketch', CadSketchRefusalCode, { readonly cause: CadSketchRefusalCause | null; readonly subjectCount: number; readonly omittedSubjectCount: number },
    SubjectOf<'feature'>, 'failed'>
  | CadIssueOf<'sketch', CadSketchRelationCode | Exclude<CadSketchGraphCode, 'relation-residual'>, CadSketchItemDetails, SketchItemSubject, CadIssueState>
  /** A relation the solved sketch does not meet, by how much in millimetres. */
  | CadIssueOf<'sketch', 'relation-residual', CadSketchItemDetails & { readonly residualMm: number }, SketchItemSubject, CadIssueState>
  /** A curve Symmetric shrank in the last accepted edit, each curve's size before and after in millimetres. */
  | CadIssueOf<'sketch', 'mirror-shrank', { readonly curves: readonly { readonly entityId: string; readonly beforeMm: number; readonly afterMm: number }[] },
    SubjectOf<'sketch-relation'>, 'failed'>;

export type CadFeatureIssueOf =
  /** A check refused the feature, or the document, while the document was read. */
  | CadIssueOf<'feature', Exclude<CadRefusalCode, 'rebuild-stopped'>, CadNoIssueDetails, SubjectOf<'document' | 'feature' | 'reference-slot'>, 'failed'>
  /** Inputs the feature reads failed or are blocked: the features its input slots name, in history order. */
  | CadIssueOf<'feature', 'input-blocked', { readonly inputs: readonly string[] }, SubjectOf<'feature'>, 'blocked'>;

/** The kernel step that failed, the input it was reading, and the kernel's own text, which is never the message. */
export type CadKernelFailure = CadKernelFailureDetails;
type KernelSubject = SubjectOf<'document' | 'feature' | 'reference-slot'>;
type KernelFactIssues = { readonly [C in CadRefusalFactCode]: CadIssueOf<'kernel', C, CadKernelFailure & CadRefusalFacts[C], KernelSubject, 'failed'> }[CadRefusalFactCode];
export type CadKernelIssueOf =
  | CadIssueOf<'kernel', Exclude<CadRefusalCode, CadRefusalFactCode | 'rebuild-stopped'>, CadKernelFailure, KernelSubject, 'failed'>
  | KernelFactIssues
  /** The rebuild stopped at the feature that failed; nothing after it was evaluated. */
  | CadIssueOf<'kernel', 'rebuild-stopped', CadNoIssueDetails, SubjectOf<'document' | 'feature'>, 'blocked'>;

type BodySubject = SubjectOf<'body'>;
export type CadBodyIssueOf =
  /** The parts of the body that can't be told apart, or that no longer exist. */
  | CadIssueOf<'body', 'ambiguous-body-parts' | 'lost-body-parts', { readonly pieces: readonly CadBodyKey[] }, BodySubject, 'failed'>
  /** The lineage stopped tracking the body's parts, and which bound it passed. */
  | CadIssueOf<'body', 'untracked-body-parts', { readonly reason: CadBodyUntrackedReason }, BodySubject, 'failed'>
  /** How many body issues, from the subject's feature on, did not fit in the list. */
  | CadIssueOf<'body', 'more-body-issues', { readonly omittedCount: number }, BodySubject, 'failed'>;

export type CadCamIssueOf = CadIssueOf<'cam', CadCamCode, CadNoIssueDetails, SubjectOf<'cam-operation'>, 'failed'>;

/**
 * An existing action that resolves an issue, prepared against document version `preparedAt`:
 * - `edit` applies document edits, such as removing a relation or converting a dimension to a reference;
 * - `re-pick` opens the feature's editor at the input `field` to choose it again;
 * - `command` runs a workbench command on the feature, such as opening its editor.
 * A repair prepared against another version is refused (`preparedCadIssueRepair`).
 */
export type CadIssueRepair = { readonly id: string; readonly label: string; readonly preparedAt: string } & (
  | { readonly kind: 'edit'; readonly edits: readonly CadEdit[] }
  | { readonly kind: 're-pick'; readonly featureId: string; readonly field: string }
  | { readonly kind: 'command'; readonly command: 'edit-feature'; readonly featureId: string }
);

/** A copy of `value` that shares nothing with it, frozen through: arrays and plain objects are copied, other values kept. */
function detached<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(detached)) as T;
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) copy[key] = detached(item);
  return Object.freeze(copy) as T;
}

/**
 * Detaches and freezes an issue as its adapter built it: its subject, details, causes and repairs, with each repair's edits, are copied
 * through, so a later change to what it was built from changes no issue and no prepared repair.
 */
export function createCadIssue<T extends CadIssue>(issue: T): T {
  return detached(issue);
}

/** Whether issue lists are checked as they are made: in development and tests, where a malformed list is a programming error that throws. */
const CHECKED = import.meta.env?.DEV === true;

/**
 * What is wrong with list `issues` as one causal graph: a repeated key, a cause naming no issue of the list or the issue itself, a blocked
 * issue with no cause, or a cycle of causes. Empty when it is well formed.
 */
export function cadIssueListProblems(issues: readonly CadIssue[]): readonly string[] {
  const problems: string[] = [], byKey = new Map<string, CadIssue>();
  for (const issue of issues) if (byKey.has(issue.key)) problems.push(`Issue key ${issue.key} is repeated.`); else byKey.set(issue.key, issue);
  for (const issue of issues) {
    if (issue.state === 'blocked' && !issue.causes.length) problems.push(`Blocked issue ${issue.key} names no cause.`);
    if (new Set(issue.causes).size !== issue.causes.length) problems.push(`Issue ${issue.key} names a cause twice.`);
    for (const cause of issue.causes) if (cause === issue.key || !byKey.has(cause)) problems.push(`Issue ${issue.key} names ${cause === issue.key ? 'itself' : `missing issue ${cause}`} as a cause.`);
  }
  // Depth-first, each issue once: one reached again while its own causes are still being followed closes a cycle.
  const state = new Map<string, 'open' | 'done'>();
  const visit = (key: string): boolean => {
    const at = state.get(key);
    if (at) return at === 'open';
    state.set(key, 'open');
    const cyclic = (byKey.get(key)?.causes ?? []).some(cause => cause !== key && byKey.has(cause) && visit(cause));
    state.set(key, 'done');
    return cyclic;
  };
  for (const key of byKey.keys()) if (!state.has(key) && visit(key)) problems.push(`The causes of issue ${key} lead back to it.`);
  return problems;
}

/** The issues of one list, frozen; in development and tests a list that is not one causal graph (`cadIssueListProblems`) throws. */
export function createCadIssueList(issues: readonly CadIssue[]): readonly CadIssue[] {
  if (CHECKED) {
    const problems = cadIssueListProblems(issues);
    if (problems.length) throw new Error(`Malformed CAD issue list: ${problems.join(' ')}`);
  }
  return Object.isFrozen(issues) ? issues : Object.freeze([...issues]);
}

/** The repair to apply at document version `version`; one prepared against any other version is refused, since the document it read has changed. */
export function preparedCadIssueRepair(repair: CadIssueRepair, version: string): CadIssueRepair {
  if (repair.preparedAt !== version) throw new CadError('stale-repair', `The repair "${repair.label}" was prepared for an earlier version of the part. Read the issues again and choose a current repair.`);
  return repair;
}

/** The feature an issue is about, directly or through one of its inputs, a body it made or a sketch item. */
export function cadIssueFeatureId(subject: CadIssueSubject): string | null {
  switch (subject.kind) {
    case 'feature': case 'reference-slot': case 'body': return subject.featureId;
    case 'sketch-relation': case 'sketch-entity': case 'sketch-point': return subject.sketchId;
    default: return null;
  }
}

/** The issues of list `issues` that `key` leads back to through its causes, in list order: those that name no cause, or itself when it names none. */
export function cadIssueRootCauses(issues: readonly CadIssue[], key: string): readonly CadIssue[] {
  const byKey = new Map(issues.map(issue => [issue.key, issue])), roots = new Set<string>(), seen = new Set<string>();
  const visit = (at: string) => {
    if (seen.has(at)) return;
    seen.add(at);
    const issue = byKey.get(at);
    if (!issue) return;
    if (!issue.causes.length) roots.add(at); else issue.causes.forEach(visit);
  };
  visit(key);
  return issues.filter(issue => roots.has(issue.key));
}

/** A feature that reads inputs which failed or are blocked: the features its input slots name, in history order. */
export interface CadBlockedFeature { readonly featureId: string; readonly inputs: readonly string[] }

/**
 * The active features of `document` that read the result of a feature of `failedIds`, directly or through another feature that does, as
 * their kinds' input slots declare (F1): a sketch, curve or datum plane they place or follow, or a body they change, consume or copy. A
 * body slot names the feature whose result the body is (F0's `at`), so a body a failed feature made or changed is read through the slot
 * that names it, or the slot of a later feature that does. Each lists every such input it reads. A failed feature is listed too when it
 * reads one, and blocks what reads it either way. Other features are left out; their evaluation does not depend on the failures.
 */
export function cadBlockedFeatures(document: Pick<CadDocument, 'features' | 'parameters'>, failedIds: readonly string[]): readonly CadBlockedFeature[] {
  const failed = new Set(failedIds), order = new Map(document.features.map((feature, index) => [feature.id, index]));
  const reached = new Set<string>(), found: CadBlockedFeature[] = [];
  for (const feature of document.features) {
    if (!cadFeatureActive(feature, document)) continue;
    const inputs = [...new Set(cadFeatureDependencies(feature))].filter(id => reached.has(id)).sort((a, b) => order.get(a)! - order.get(b)!);
    if (inputs.length) found.push(Object.freeze({ featureId: feature.id, inputs: Object.freeze(inputs) }));
    if (inputs.length || failed.has(feature.id)) reached.add(feature.id);
  }
  return Object.freeze(found);
}

/** The most blocked features a digest names for each root cause. */
export const CAD_ISSUE_DIGEST_NAMED = 8;

/** The blocked features a root cause keeps from evaluating, as a digest gives them. */
export interface CadIssueBlockedSummary {
  /** The key of the root issue, which the digest lists in full. */
  readonly cause: string;
  /** How many blocked features lead back to it. */
  readonly count: number;
  /** The first of them, in list order, at most `CAD_ISSUE_DIGEST_NAMED`. */
  readonly featureIds: readonly string[];
}
/**
 * A list of issues bounded for a reply, which grows with the failures, not with the features they block:
 * - `issues`: every issue but those causal blocking adds (`input-blocked`), in full and in list order. The causes of each are the root
 *   issues it leads back to, which `issues` lists, so no link names an issue left out.
 * - `blocked`: the features causal blocking reports, under each root cause they lead back to, with a count and the first ids.
 * - `omittedCount`: how many blocked features no summary names; a feature with several root causes is named under each, and left out only
 *   when none names it.
 */
export interface CadIssueDigest {
  readonly issues: readonly CadIssue[];
  readonly blocked: readonly CadIssueBlockedSummary[];
  readonly omittedCount: number;
}

/** The digest of list `issues` (`CadIssueDigest`); the workbench shows the full list. */
export function cadIssueDigest(issues: readonly CadIssue[], named = CAD_ISSUE_DIGEST_NAMED): CadIssueDigest {
  const byKey = new Map(issues.map(issue => [issue.key, issue])), roots = new Map<string, readonly string[]>();
  const rootsOf = (key: string): readonly string[] => {
    const known = roots.get(key);
    if (known) return known;
    const issue = byKey.get(key);
    // Each issue's roots are memoised. A blocked feature's causes are the issues of inputs before it in history, which the list gives
    // first, so they are settled already when it is reached in list order below.
    const found = !issue ? [] : !issue.causes.length ? [key] : [...new Set(issue.causes.flatMap(cause => roots.get(cause) ?? rootsOf(cause)))];
    roots.set(key, found);
    return found;
  };
  for (const issue of issues) rootsOf(issue.key);
  const kept: CadIssue[] = [], summaries = new Map<string, { count: number; featureIds: string[] }>(), namedIds = new Set<string>();
  let blockedCount = 0;
  for (const issue of issues) {
    if (issue.code !== 'input-blocked') {
      const causes = issue.causes.length ? (roots.get(issue.key) ?? []).filter(root => root !== issue.key) : [];
      kept.push(causes.length === issue.causes.length && causes.every((cause, index) => cause === issue.causes[index]) ? issue : detached({ ...issue, causes }));
      continue;
    }
    blockedCount++;
    const featureId = issue.subject.featureId;
    for (const root of roots.get(issue.key) ?? []) {
      const summary = summaries.get(root) ?? summaries.set(root, { count: 0, featureIds: [] }).get(root)!;
      summary.count++;
      if (summary.featureIds.length < named) { summary.featureIds.push(featureId); namedIds.add(featureId); }
    }
  }
  const blocked = [...summaries].map(([cause, summary]) => Object.freeze({ cause, count: summary.count, featureIds: Object.freeze(summary.featureIds) }));
  return Object.freeze({ issues: Object.freeze(kept), blocked: Object.freeze(blocked), omittedCount: blockedCount - namedIds.size });
}
