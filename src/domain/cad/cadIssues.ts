import type { CadBodyKey, CadBodyUntrackedReason } from './cadBodies';
import type { CadDocument, CadKernelFailureDetails } from './cadDocument';
import { CadError } from './cadError';
import { cadFeatureDependencies } from './cadFeatureInputs';
import type { CadCamCodeOf, CadCamOperation, CadRefusalCode, CadRefusalFactCode, CadRefusalFacts, CadSketchGraphCode, CadSketchRefusalCode, CadSketchRelationCode } from './cadIssueCodes';
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
export type { CadCamOperation };

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
/**
 * Details of a code that carries no facts beyond its subject: an empty object. It names no property, so reading one is a compile error,
 * and as a weak type it takes no object that gives one.
 */
export type CadNoIssueDetails = { readonly none?: never };

type SketchItemSubject = SubjectOf<'sketch-relation' | 'sketch-entity' | 'sketch-point'>;
/** Where a sketch item comes from: the analysis of the accepted sketch, the edit just refused, or the last accepted edit's warnings. */
export type CadSketchItemOrigin = 'analysis' | 'edit' | 'warning';
interface CadSketchItemDetails { readonly origin: CadSketchItemOrigin; readonly pointIds: readonly string[]; readonly entityIds: readonly string[] }
export type CadSketchIssueOf =
  /**
   * The refusal of an edit or of the accepted analysis. It lists as its causes the items it names, which the list holds, and counts them
   * and those it leaves out. A solver that failed rather than judged the sketch (`cause: 'solver-unavailable'`) keeps the browser's or its
   * worker's own words, bounded, as `kernelMessage` when it gave any; the message never repeats them.
   */
  | CadIssueOf<'sketch', CadSketchRefusalCode, { readonly cause: CadSketchRefusalCause | null; readonly subjectCount: number; readonly omittedSubjectCount: number;
    readonly kernelMessage?: string }, SubjectOf<'feature'>, 'failed'>
  /** A relation, edge or point the solver or the graph check names. */
  | CadIssueOf<'sketch', CadSketchRelationCode | Exclude<CadSketchGraphCode, 'relation-residual'>, CadSketchItemDetails, SketchItemSubject, 'failed'>
  /** A relation the solved sketch does not meet, by how much in millimetres, or null when the check could not measure it. */
  | CadIssueOf<'sketch', 'relation-residual', CadSketchItemDetails & { readonly residualMm: number | null }, SketchItemSubject, 'failed'>
  /** A curve Symmetric shrank in the last accepted edit, each curve's size before and after in millimetres. */
  | CadIssueOf<'sketch', 'mirror-shrank', { readonly curves: readonly { readonly entityId: string; readonly beforeMm: number; readonly afterMm: number }[] },
    SubjectOf<'sketch-relation'>, 'failed'>;

type FeatureSubject = SubjectOf<'document' | 'feature' | 'reference-slot'>;
/** The refusals that carry facts; whichever namespace reports one carries them, so narrowing by code alone always finds them. */
type RefusalFactCode = Extract<CadRefusalFactCode, CadRefusalCode>;
type FeatureFactIssues = { readonly [C in RefusalFactCode]: CadIssueOf<'feature', C, CadRefusalFacts[C], FeatureSubject, 'failed'> }[RefusalFactCode];
export type CadFeatureIssueOf =
  /** A check refused the feature, or the document, while the document was read. */
  | CadIssueOf<'feature', Exclude<CadRefusalCode, RefusalFactCode | 'rebuild-stopped'>, CadNoIssueDetails, FeatureSubject, 'failed'>
  | FeatureFactIssues
  /** Inputs the feature reads failed or are blocked: the features its input slots name, in history order. */
  | CadIssueOf<'feature', 'input-blocked', { readonly inputs: readonly string[] }, SubjectOf<'feature'>, 'blocked'>;

/** The kernel step that failed, the input it was reading, and the kernel's own text, which is never the message. */
export type CadKernelFailure = CadKernelFailureDetails;
type KernelSubject = SubjectOf<'document' | 'feature' | 'reference-slot'>;
type KernelFactIssues = { readonly [C in CadRefusalFactCode]: CadIssueOf<'kernel', C, CadKernelFailure & CadRefusalFacts[C], KernelSubject, 'failed'> }[CadRefusalFactCode];
export type CadKernelIssueOf =
  | CadIssueOf<'kernel', Exclude<CadRefusalCode, CadRefusalFactCode | 'rebuild-stopped'>, CadKernelFailure, KernelSubject, 'failed'>
  /** Each code that carries facts, with them. `kernel-unrecognised` stands for a code no registry lists, which it keeps (`cadReceivedDiagnostic`). */
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

/** A CAM step refused: its operation and the source it was given, and a code that step can raise (`CAD_CAM_STEP_CODES`). */
export type CadCamIssueOf = { readonly [O in CadCamOperation]: CadIssueOf<'cam', CadCamCodeOf<O>, CadNoIssueDetails,
  { readonly kind: 'cam-operation'; readonly operation: O; readonly sourceId: string }, 'failed'> }[CadCamOperation];

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

/**
 * The causal structure of list `issues`, found without recursion, so a history of any length is safe, in whatever order the list gives
 * it. The first issue of a repeated key stands for it. For each key:
 * - `roots`: the failed issues naming no cause that it leads back to, in list order; itself when it is one;
 * - `unresolved`: the causes it leads to that resolve to no root, those of the list first in list order: keys no issue of the list has,
 *   itself when it names itself or is blocked yet names no cause, and the issues of a cycle it is in or leads to.
 * `cycles` are the groups of two or more issues whose causes lead back to each other, each in list order.
 */
interface CadIssueGraph {
  readonly byKey: ReadonlyMap<string, CadIssue>;
  readonly roots: ReadonlyMap<string, readonly string[]>;
  readonly unresolved: ReadonlyMap<string, readonly string[]>;
  readonly cycles: readonly (readonly string[])[];
}
const NONE: readonly string[] = Object.freeze([]);
function cadIssueGraph(issues: readonly CadIssue[]): CadIssueGraph {
  const byKey = new Map<string, CadIssue>(), position = new Map<string, number>();
  for (const [at, issue] of issues.entries()) if (!byKey.has(issue.key)) { byKey.set(issue.key, issue); position.set(issue.key, at); }
  const roots = new Map<string, readonly string[]>(), unresolved = new Map<string, readonly string[]>(), cycles: (readonly string[])[] = [];
  const ordered = (keys: Iterable<string>): readonly string[] => {
    const listed = [...new Set(keys)];
    return listed.length ? Object.freeze(listed.sort((a, b) => (position.get(a) ?? Infinity) - (position.get(b) ?? Infinity))) : NONE;
  };
  /** The union of `lists` and `extra`, sharing a lone list rather than copying it. */
  const union = (lists: readonly (readonly string[])[], extra: readonly string[]) => {
    const filled = lists.filter(list => list.length);
    return !extra.length && filled.length <= 1 ? filled[0] ?? NONE : ordered([...filled.flat(), ...extra]);
  };
  // Every link out of a component leads to a component settled before it.
  const settle = (members: readonly string[]) => {
    const inside = new Set(members), cyclic = members.length > 1;
    const found: (readonly string[])[] = [], lost: (readonly string[])[] = [], loose: string[] = cyclic ? [...members] : [];
    let causeless = !cyclic;
    for (const key of members) for (const cause of byKey.get(key)!.causes) {
      causeless = false;
      if (cause === key) loose.push(key);
      else if (!byKey.has(cause)) loose.push(cause);
      else if (!inside.has(cause)) { found.push(roots.get(cause)!); lost.push(unresolved.get(cause)!); }
    }
    // A blocked issue naming no cause is blocked by nothing the list says: no root, and itself unresolved.
    if (causeless && byKey.get(members[0])!.state === 'blocked') { causeless = false; loose.push(members[0]); }
    const rooted = causeless ? Object.freeze([members[0]]) : union(found, NONE), open = union(lost, loose);
    for (const key of members) { roots.set(key, rooted); unresolved.set(key, open); }
    if (cyclic) cycles.push(ordered(members));
  };
  // Tarjan's strongly connected components over the links from each issue to its causes, on an explicit stack: a component is complete
  // only once every component it leads to is.
  const order = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], stacked = new Set<string>();
  const enter = (key: string) => { low.set(key, order.size); order.set(key, order.size); stack.push(key); stacked.add(key); };
  for (const start of byKey.keys()) {
    if (order.has(start)) continue;
    enter(start);
    const frames = [{ key: start, next: 0 }];
    while (frames.length) {
      const frame = frames[frames.length - 1], causes = byKey.get(frame.key)!.causes;
      if (frame.next < causes.length) {
        const cause = causes[frame.next++];
        if (cause === frame.key || !byKey.has(cause)) continue;
        if (!order.has(cause)) { enter(cause); frames.push({ key: cause, next: 0 }); }
        else if (stacked.has(cause)) low.set(frame.key, Math.min(low.get(frame.key)!, order.get(cause)!));
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) low.set(parent.key, Math.min(low.get(parent.key)!, low.get(frame.key)!));
      if (low.get(frame.key) !== order.get(frame.key)) continue;
      const members: string[] = [];
      for (let member = ''; member !== frame.key;) { member = stack.pop()!; stacked.delete(member); members.push(member); }
      settle(members);
    }
  }
  cycles.sort((a, b) => position.get(a[0])! - position.get(b[0])!);
  return { byKey, roots, unresolved, cycles };
}

/**
 * What is wrong with list `issues` as one causal graph: a repeated key, a cause naming no issue of the list or the issue itself, a blocked
 * issue with no cause, or a cycle of causes, named by its first issue. Empty when it is well formed.
 */
export function cadIssueListProblems(issues: readonly CadIssue[]): readonly string[] {
  const problems: string[] = [], keys = new Set<string>();
  for (const issue of issues) if (keys.has(issue.key)) problems.push(`Issue key ${issue.key} is repeated.`); else keys.add(issue.key);
  for (const issue of issues) {
    if (issue.state === 'blocked' && !issue.causes.length) problems.push(`Blocked issue ${issue.key} names no cause.`);
    if (new Set(issue.causes).size !== issue.causes.length) problems.push(`Issue ${issue.key} names a cause twice.`);
    for (const cause of issue.causes) if (cause === issue.key || !keys.has(cause)) problems.push(`Issue ${issue.key} names ${cause === issue.key ? 'itself' : `missing issue ${cause}`} as a cause.`);
  }
  for (const [first] of cadIssueGraph(issues).cycles) problems.push(`The causes of issue ${first} lead back to it.`);
  return problems;
}

/**
 * The issues of one list, frozen. With `checked`, which development and tests ask for, a list that is not one causal graph
 * (`cadIssueListProblems`) is a programming error that throws; production leaves it unchecked and the digest names what does not resolve.
 * The caller decides, so this module reads no host flag: the app passes its bundler's development flag.
 */
export function createCadIssueList(issues: readonly CadIssue[], checked: boolean): readonly CadIssue[] {
  if (checked) {
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

/**
 * Where issue `key` of list `issues` leads back to through its causes: `roots`, the issues naming no cause, in list order, or itself when
 * it names none; and `unresolved`, the causes that resolve to no root, which only a malformed list has (`CadIssueGraph`). A key no issue of
 * the list has is itself unresolved.
 */
export function cadIssueRootCauses(issues: readonly CadIssue[], key: string): { readonly roots: readonly CadIssue[]; readonly unresolved: readonly string[] } {
  const graph = cadIssueGraph(issues);
  if (!graph.byKey.has(key)) return Object.freeze({ roots: Object.freeze([]), unresolved: Object.freeze([key]) });
  return Object.freeze({ roots: Object.freeze(graph.roots.get(key)!.map(root => graph.byKey.get(root)!)), unresolved: graph.unresolved.get(key)! });
}

/** A feature that reads inputs which failed or are blocked: the features its input slots name, in history order. */
export interface CadBlockedFeature { readonly featureId: string; readonly inputs: readonly string[] }
const NO_BLOCKED_FEATURES: readonly CadBlockedFeature[] = Object.freeze([]);

/**
 * The active features of `document` that read the result of a feature of `failedIds`, directly or through another feature that does, as
 * their kinds' input slots declare (F1): a sketch, curve or datum plane they place or follow, or a body they change, consume or copy. A
 * body slot names the feature whose result the body is (F0's `at`), so a body a failed feature made or changed is read through the slot
 * that names it, or the slot of a later feature that does. Each lists every such input it reads. A failed feature is listed too when it
 * reads one, and blocks what reads it either way. Other features are left out; their evaluation does not depend on the failures.
 */
export function cadBlockedFeatures(document: Pick<CadDocument, 'features' | 'parameters'>, failedIds: readonly string[]): readonly CadBlockedFeature[] {
  // Nothing failed, so nothing reads a failure: a clean build walks no history.
  if (!failedIds.length) return NO_BLOCKED_FEATURES;
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
/** An issue whose causes resolve to no root, with the first of those causes (`cadIssueRootCauses`). */
export interface CadIssueUnresolvedCauses {
  readonly key: string;
  readonly subject: CadIssueSubject;
  readonly causes: readonly string[];
}
/**
 * A list of issues bounded for a reply, which grows with the failures, not with the features they block:
 * - `issues`: every issue but those causal blocking adds (`input-blocked`), in full and in list order. The causes of each are the root
 *   issues it leads back to, which `issues` lists, so no link names an issue left out.
 * - `blocked`: the features causal blocking reports, under each root cause they lead back to, with a count and the first ids.
 * - `unresolved`: how many issues lead to causes that resolve to no root, and the first of them. Only a malformed list has any, which
 *   development refuses as it is made; the digest names them rather than fail or drop them.
 * - `omittedCount`: how many blocked features neither a summary nor `unresolved` names; a feature with several root causes is named
 *   under each.
 * Each list it names is at most `CAD_ISSUE_DIGEST_NAMED` long.
 */
export interface CadIssueDigest {
  readonly issues: readonly CadIssue[];
  readonly blocked: readonly CadIssueBlockedSummary[];
  readonly unresolved: { readonly count: number; readonly issues: readonly CadIssueUnresolvedCauses[] };
  readonly omittedCount: number;
}

/** The digest of list `issues` (`CadIssueDigest`); the workbench shows the full list. */
export function cadIssueDigest(issues: readonly CadIssue[], named = CAD_ISSUE_DIGEST_NAMED): CadIssueDigest {
  const { roots, unresolved } = cadIssueGraph(issues);
  const kept: CadIssue[] = [], summaries = new Map<string, { count: number; featureIds: string[] }>(), namedIds = new Set<string>();
  const loose: CadIssueUnresolvedCauses[] = [];
  let blockedCount = 0, looseCount = 0;
  for (const issue of issues) {
    const open = unresolved.get(issue.key)!;
    let listed = false;
    if (open.length) {
      looseCount++;
      if (loose.length < named) { loose.push(detached({ key: issue.key, subject: issue.subject, causes: open.slice(0, named) })); listed = true; }
    }
    if (issue.code !== 'input-blocked') {
      const causes = issue.causes.length ? roots.get(issue.key)!.filter(root => root !== issue.key) : [];
      kept.push(causes.length === issue.causes.length && causes.every((cause, index) => cause === issue.causes[index]) ? issue : detached({ ...issue, causes }));
      continue;
    }
    blockedCount++;
    const featureId = issue.subject.featureId;
    if (listed) namedIds.add(featureId);
    for (const root of roots.get(issue.key)!) {
      const summary = summaries.get(root) ?? summaries.set(root, { count: 0, featureIds: [] }).get(root)!;
      summary.count++;
      if (summary.featureIds.length < named) { summary.featureIds.push(featureId); namedIds.add(featureId); }
    }
  }
  const blocked = [...summaries].map(([cause, summary]) => Object.freeze({ cause, count: summary.count, featureIds: Object.freeze(summary.featureIds) }));
  return Object.freeze({ issues: Object.freeze(kept), blocked: Object.freeze(blocked),
    unresolved: Object.freeze({ count: looseCount, issues: Object.freeze(loose) }), omittedCount: blockedCount - namedIds.size });
}
