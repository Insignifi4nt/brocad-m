import type { CadBodyIssue } from './cadBodies';
import type { CadBuildResult, CadDiagnostic, CadDocument, CadFeature, CadKernelOperation } from './cadDocument';
import { cadBlockedFeatures, createCadIssue, type CadBodyIssueOf, type CadFeatureIssueOf, type CadIssue, type CadIssueRepair, type CadIssueSubject, type CadKernelIssueOf } from './cadIssues';

/** The problems of one build, as the issue model gives them. */
export interface CadBuildIssues {
  /** Failures first, then the features they keep from evaluating, then body issues, each in history order. */
  readonly items: readonly CadIssue[];
  /** The issue each feature's own row shows: its failure, or the issue that keeps it from evaluating. */
  readonly byFeature: ReadonlyMap<string, CadIssue>;
}
export const NO_CAD_BUILD_ISSUES: CadBuildIssues = Object.freeze({ items: Object.freeze([]), byFeature: new Map() });

/** What a feature reports when an input it reads did not rebuild, through a slot or the body it changes. */
export const CAD_INPUT_BLOCKED = 'Not evaluated, because an input it reads did not rebuild.';
/** Failures of a feature's chosen edges or opening, which choosing them again repairs. */
const SELECTION_CODES: ReadonlySet<string> = new Set(['selection-empty', 'selection-count-mismatch', 'selection-missing', 'unsupported-selection', 'selection-tangent-chain']);

/**
 * The issues of build `build` of `document` at version `version`, the one adapter for what the kernel reports:
 * - each feature failure, with the step and input the kernel names, and the repairs the workbench already has for it: editing the feature,
 *   or choosing a Fillet's, Chamfer's or Shell's edges or opening again;
 * - the stop it causes, as an issue the failure causes;
 * - every later active feature that reads the failed feature's result through its input slots (F1), a body slot naming the feature whose result the body is (F0), as
 *   blocked, linked to the issue of the input it reads;
 * - every body issue the rebuild recorded (F0), with its body key and cause.
 * Repairs are prepared against `version`. Nothing here runs while a feature is hovered, dragged or previewed: the workbench builds issues
 * once per published build.
 */
export function cadBuildIssues(document: Pick<CadDocument, 'features' | 'parameters'>, build: Pick<CadBuildResult, 'diagnostics' | 'bodyIssues'>, version: string): CadBuildIssues {
  const items: CadIssue[] = [], byFeature = new Map<string, CadIssue>(), failureOf = new Map<string, string>();
  const featureOf = (id: string | undefined) => id === undefined ? undefined : document.features.find(feature => feature.id === id);
  build.diagnostics.forEach((diagnostic, index) => {
    if (diagnostic.code === 'rebuild-stopped') return;
    const issue = kernelFailure(diagnostic, index, featureOf(diagnostic.featureId), version);
    items.push(issue);
    if (diagnostic.featureId !== undefined) { failureOf.set(diagnostic.featureId, issue.key); if (!byFeature.has(diagnostic.featureId)) byFeature.set(diagnostic.featureId, issue); }
  });
  build.diagnostics.forEach((diagnostic, index) => {
    if (diagnostic.code !== 'rebuild-stopped') return;
    const cause = diagnostic.featureId === undefined ? undefined : failureOf.get(diagnostic.featureId);
    const issue: CadKernelIssueOf = createCadIssue({ key: `kernel:${index}:${diagnostic.code}`, namespace: 'kernel', code: diagnostic.code, severity: 'info', state: 'blocked',
      subject: diagnostic.featureId === undefined ? { kind: 'document' } : { kind: 'feature', featureId: diagnostic.featureId }, message: diagnostic.message,
      causes: cause ? [cause] : [], repairs: [], details: { kind: 'rebuild-stopped' } });
    items.push(issue);
    if (diagnostic.featureId !== undefined && !byFeature.has(diagnostic.featureId)) byFeature.set(diagnostic.featureId, issue);
  });
  for (const [failedId, failureKey] of failureOf) {
    const keyOf = new Map([[failedId, failureKey]]);
    for (const blocked of cadBlockedFeatures(document, failedId)) {
      if (byFeature.has(blocked.featureId)) continue;
      const issue: CadFeatureIssueOf = createCadIssue({ key: `feature:blocked:${blocked.featureId}`, namespace: 'feature', code: 'input-blocked', severity: 'warning', state: 'blocked',
        subject: { kind: 'feature', featureId: blocked.featureId }, message: CAD_INPUT_BLOCKED, causes: [keyOf.get(blocked.by)!], repairs: [],
        details: { kind: 'blocked', by: blocked.by } });
      keyOf.set(blocked.featureId, issue.key);
      items.push(issue); byFeature.set(blocked.featureId, issue);
    }
  }
  (build.bodyIssues ?? []).forEach((issue, index) => items.push(cadBodyIssue(issue, index)));
  return Object.freeze({ items: Object.freeze(items), byFeature });
}

function kernelFailure(diagnostic: CadDiagnostic, index: number, feature: CadFeature | undefined, version: string): CadKernelIssueOf {
  const input = diagnostic.details?.input ?? null;
  const subject: CadIssueSubject = diagnostic.featureId === undefined ? { kind: 'document' }
    : input ? { kind: 'reference-slot', featureId: diagnostic.featureId, field: input.field, inputId: input.id } : { kind: 'feature', featureId: diagnostic.featureId };
  return createCadIssue({ key: `kernel:${index}:${diagnostic.code}`, namespace: 'kernel', code: diagnostic.code, severity: 'error', state: 'failed', subject,
    message: diagnostic.message, causes: [], repairs: feature ? featureRepairs(feature, diagnostic.code, version) : [],
    details: { kind: 'kernel-failure', operation: diagnostic.details?.operation ?? operationOf(feature), input, kernelMessage: diagnostic.details?.kernelMessage ?? null } });
}

/** Opening the feature's editor, where every input and dimension is changed, and choosing its edges or opening again when those failed. */
function featureRepairs(feature: CadFeature, code: string, version: string): readonly CadIssueRepair[] {
  const repairs: CadIssueRepair[] = [];
  if (SELECTION_CODES.has(code) && (feature.kind === 'fillet' || feature.kind === 'chamfer' || feature.kind === 'shell')) {
    const field = feature.kind === 'shell' ? 'opening' : 'selection';
    repairs.push({ id: `re-pick:${feature.id}:${field}`, label: feature.kind === 'shell' ? 'Choose opening again' : 'Choose edges again', preparedAt: version, kind: 're-pick', featureId: feature.id, field });
  }
  repairs.push({ id: `command:edit-feature:${feature.id}`, label: feature.kind === 'sketch' ? 'Edit sketch' : feature.kind === 'curve' ? 'Edit curve' : 'Edit feature', preparedAt: version,
    kind: 'command', command: 'edit-feature', featureId: feature.id });
  return repairs;
}

/** The step a failure without kernel details was taking: the feature's own operation. */
function operationOf(feature: CadFeature | undefined): CadKernelOperation {
  switch (feature?.kind) {
    case 'imported': return 'import';
    case 'extrude': case 'revolve': case 'loft': case 'sweep': case 'pocket': case 'fillet': case 'chamfer': case 'shell': case 'transform': case 'mirror': return feature.kind;
    case 'boolean': return feature.operation === 'union' ? 'join' : feature.operation === 'cut' ? 'cut' : 'intersect';
    case 'linear-pattern': case 'circular-pattern': return 'pattern';
    default: return 'check';
  }
}

/** The issue of a body fact the rebuild could not settle: a warning, since the body built, about its parts. */
export function cadBodyIssue(issue: CadBodyIssue, index: number): CadBodyIssueOf {
  return createCadIssue({ key: `body:${index}:${issue.code}`, namespace: 'body', code: issue.code, severity: 'warning', state: 'failed',
    subject: { kind: 'body', key: issue.body, featureId: issue.featureId }, message: issue.message, causes: [], repairs: [],
    details: { kind: 'body', pieces: issue.pieces, reason: issue.reason ?? null } });
}
