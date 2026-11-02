import type { CadBodyKey, CadBodyUntrackedReason } from './cadBodies';
import type { CadDocument, CadKernelFailureDetails } from './cadDocument';
import { CadError } from './cadError';
import { cadFeatureDependencies } from './cadFeatureInputs';
import type { CadEdit } from './cadOperations';
import { cadFeatureActive } from './features/cadFeatureActivity';

/**
 * One CAD problem, whichever part of the app found it. Every producer maps its own findings into this shape through its adapter, and the
 * sketch header, the feature tree, the model issue list and the agent replies read nothing else.
 *
 * - `namespace` and `code` name the problem. A code keeps the spelling its producer gives it; the namespace says which producer that is.
 * - `severity`: an error stops the model or the edit, a warning leaves a result that may not be what was meant, and info explains.
 * - `state`: `failed` is a problem of the subject itself; `blocked` means an issue it lists in `causes` keeps the subject from evaluating.
 * - `subject` names what the problem is about by id or body key, never by a display name.
 * - `details` are typed by namespace and kind, for consumers that need more than the message.
 * - `repairs` are prepared operations an existing action already performs, each with the document version it was prepared against.
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

/** Why the sketch solver refused an edit or an analysis, as it reports it. */
export type CadSketchRefusalReason = 'conflicting' | 'redundant' | 'failed' | 'invalid-input' | 'too-large' | 'invalid-solution';
/** What a sketch issue lists: an over-defining relation, an unmet one, a geometry problem, or a curve an accepted edit shrank. */
export type CadSketchIssueCategory = 'conflicting' | 'redundant' | 'partially-redundant' | 'not-met' | 'geometry' | 'shrink';
/** The cause a sketch refusal names beyond its reason, when one is known. */
export type CadSketchRefusalCause = 'mirror-collapse' | 'solver-unavailable';
export type CadCamOperation = 'section' | 'send-sketch';

interface CadIssueBase {
  /** Unique within one set of issues; causes link by it. */
  readonly key: string;
  /** The producer's own code, spelled as it gives it; with the namespace, a stable id of the problem. */
  readonly code: string;
  readonly severity: CadIssueSeverity;
  readonly state: CadIssueState;
  readonly subject: CadIssueSubject;
  readonly message: string;
  readonly causes: readonly string[];
  readonly repairs: readonly CadIssueRepair[];
}
export interface CadSketchIssueOf extends CadIssueBase {
  readonly namespace: 'sketch';
  readonly details:
    /** The refusal of an edit or of the accepted analysis, which the items it names list as their cause. */
    | { readonly kind: 'sketch-refusal'; readonly reason: CadSketchRefusalReason; readonly cause: CadSketchRefusalCause | null; readonly subjectCount: number; readonly omittedSubjectCount: number }
    | { readonly kind: 'sketch-item'; readonly category: CadSketchIssueCategory; readonly origin: 'analysis' | 'edit' | 'warning'; readonly graphCode: string | null;
      readonly residualMm: number | null; readonly pointIds: readonly string[]; readonly entityIds: readonly string[] };
}
export interface CadFeatureIssueOf extends CadIssueBase {
  readonly namespace: 'feature';
  readonly details:
    /** A check refused the feature while the document was read. */
    | { readonly kind: 'refusal' }
    /** An input the feature reads failed or is blocked: `by` is the feature its input slot names. */
    | { readonly kind: 'blocked'; readonly by: string };
}
export interface CadKernelIssueOf extends CadIssueBase {
  readonly namespace: 'kernel';
  readonly details:
    /** The kernel step that failed, the input it was reading, and the kernel's own text, which is never the message. */
    | ({ readonly kind: 'kernel-failure' } & CadKernelFailureDetails)
    | { readonly kind: 'rebuild-stopped' };
}
export interface CadBodyIssueOf extends CadIssueBase {
  readonly namespace: 'body';
  readonly details: { readonly kind: 'body'; readonly pieces: readonly CadBodyKey[]; readonly reason: CadBodyUntrackedReason | null };
}
export interface CadCamIssueOf extends CadIssueBase {
  readonly namespace: 'cam';
  readonly details: { readonly kind: 'cam'; readonly operation: CadCamOperation };
}

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

/** Freezes an issue as its adapter built it. */
export function createCadIssue<T extends CadIssue>(issue: T): T {
  return Object.freeze<T>({ ...issue, subject: Object.freeze({ ...issue.subject }), details: Object.freeze({ ...issue.details }),
    causes: Object.freeze([...issue.causes]), repairs: Object.freeze(issue.repairs.map(repair => Object.freeze({ ...repair }))) });
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

/** The issues `key` leads back to through its causes: the failures that cause it, or itself when nothing does. */
export function cadIssueRootCauses(issues: readonly CadIssue[], key: string): readonly CadIssue[] {
  const byKey = new Map(issues.map(issue => [issue.key, issue])), roots: CadIssue[] = [], seen = new Set<string>();
  const visit = (at: string) => {
    if (seen.has(at)) return;
    seen.add(at);
    const issue = byKey.get(at);
    if (!issue) return;
    if (!issue.causes.length) roots.push(issue); else issue.causes.forEach(visit);
  };
  visit(key);
  return roots;
}

/** A feature the failure of another keeps from evaluating: `by` is the failed or blocked feature its input slot names. */
export interface CadBlockedFeature { readonly featureId: string; readonly by: string }

/**
 * The active features after `failedId` in `document` that read its result, directly or through another feature it blocks, as their
 * kinds' input slots declare (F1): a sketch, curve or datum plane they place or follow, or a body they change, consume or copy. A body
 * slot names the feature whose result the body is (F0's `at`), so a body the failed feature made or changed is read through the slot that
 * names it, or the slot of a later feature it blocks. Other features are left out; their evaluation does not depend on the failure.
 */
export function cadBlockedFeatures(document: Pick<CadDocument, 'features' | 'parameters'>, failedId: string): readonly CadBlockedFeature[] {
  const at = document.features.findIndex(feature => feature.id === failedId);
  if (at < 0) return [];
  const blocked = new Set([failedId]), found: CadBlockedFeature[] = [];
  for (const feature of document.features.slice(at + 1)) {
    if (!cadFeatureActive(feature, document)) continue;
    const by = cadFeatureDependencies(feature).find(id => blocked.has(id));
    if (by === undefined) continue;
    blocked.add(feature.id);
    found.push(Object.freeze({ featureId: feature.id, by }));
  }
  return Object.freeze(found);
}
