import type { CadBodyIssue } from './cadBodies';
import type { CadBuildResult, CadDiagnostic, CadDocument, CadFeature, CadKernelOperation } from './cadDocument';
import { cadReceivedDiagnostic, isCadRefusalFacts, type CadRefusalCode, type CadRefusalFactCode, type CadRefusalFacts } from './cadIssueCodes';
import { cadBlockedFeatures, createCadIssue, createCadIssueList, type CadBodyIssueOf, type CadFeatureIssueOf, type CadIssue, type CadIssueRepair, type CadKernelFailure,
  type CadKernelIssueOf } from './cadIssues';

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
const SELECTION_CODES: ReadonlySet<string> = new Set<CadRefusalCode>(['selection-empty', 'selection-count-mismatch', 'unsupported-selection', 'selection-tangent-chain']);

/**
 * The issues of build `build` of `document` at version `version`, the one adapter for what the kernel reports:
 * - each feature failure, with the step and input the kernel names, the facts its code carries, and the repairs the workbench already has
 *   for it: editing the feature, or choosing a Fillet's, Chamfer's or Shell's edges or opening again;
 * - the stop it causes, as an issue the failure causes;
 * - every later active feature that reads a failed feature's result through its input slots (F1), a body slot naming the feature whose
 *   result the body is (F0), as blocked, linked to the issue of every failed or blocked input it reads. A feature that failed on its own
 *   and reads such an input is reported once, as its own failure, which lists those inputs' issues as causes too;
 * - every body issue the rebuild recorded (F0), with its body key and cause.
 * Repairs are prepared against `version`. With `checked`, as in development and tests, a malformed list throws (`createCadIssueList`).
 * Nothing here runs while a feature is hovered, dragged or previewed: the controller makes issues once per published build.
 */
export function cadBuildIssues(document: Pick<CadDocument, 'features' | 'parameters'>, build: Pick<CadBuildResult, 'diagnostics' | 'bodyIssues'>, version: string,
  checked: boolean): CadBuildIssues {
  const featureOf = (id: string | undefined) => id === undefined ? undefined : document.features.find(feature => feature.id === id);
  // A code no registry lists becomes kernel-unrecognised, keeping the code it gave, as where a build reply is received.
  const diagnostics = build.diagnostics.map(cadReceivedDiagnostic);
  const key = (diagnostic: CadDiagnostic, index: number) => `kernel:${index}:${diagnostic.code}`;
  // Every feature's own failure, the first it reports, and what its failed or blocked inputs are, before any issue is made, so each
  // cause resolves to an issue of the list whichever order failures and blocks come in.
  const failureOf = new Map<string, string>();
  diagnostics.forEach((diagnostic, index) => {
    if (diagnostic.code !== 'rebuild-stopped' && diagnostic.featureId !== undefined && !failureOf.has(diagnostic.featureId)) failureOf.set(diagnostic.featureId, key(diagnostic, index));
  });
  const blocked = cadBlockedFeatures(document, [...failureOf.keys()]), inputsOf = new Map(blocked.map(entry => [entry.featureId, entry.inputs]));
  const issueOf = (featureId: string) => failureOf.get(featureId) ?? `feature:blocked:${featureId}`;
  const causesOf = (featureId: string | undefined) => featureId === undefined ? [] : (inputsOf.get(featureId) ?? []).map(issueOf);

  const items: CadIssue[] = [], byFeature = new Map<string, CadIssue>();
  const show = (featureId: string | undefined, issue: CadIssue) => { if (featureId !== undefined && !byFeature.has(featureId)) byFeature.set(featureId, issue); };
  diagnostics.forEach((diagnostic, index) => {
    if (diagnostic.code === 'rebuild-stopped') return;
    const issue = kernelFailure(diagnostic, key(diagnostic, index), featureOf(diagnostic.featureId), causesOf(diagnostic.featureId), version);
    items.push(issue); show(diagnostic.featureId, issue);
  });
  diagnostics.forEach((diagnostic, index) => {
    if (diagnostic.code !== 'rebuild-stopped') return;
    const cause = diagnostic.featureId === undefined ? undefined : failureOf.get(diagnostic.featureId);
    // The reply guard admits a stop only after a failure of its feature.
    if (cause === undefined) throw new Error(`The rebuild stop at ${diagnostic.featureId ?? 'the document'} follows no failure.`);
    const issue: CadKernelIssueOf = createCadIssue({ key: key(diagnostic, index), namespace: 'kernel', code: 'rebuild-stopped', severity: 'info', state: 'blocked',
      subject: { kind: 'feature', featureId: diagnostic.featureId! }, message: diagnostic.message, causes: [cause], repairs: [], details: {} });
    items.push(issue); show(diagnostic.featureId, issue);
  });
  for (const { featureId, inputs } of blocked) {
    if (failureOf.has(featureId)) continue;
    const issue: CadFeatureIssueOf = createCadIssue({ key: issueOf(featureId), namespace: 'feature', code: 'input-blocked', severity: 'warning', state: 'blocked',
      subject: { kind: 'feature', featureId }, message: CAD_INPUT_BLOCKED, causes: inputs.map(issueOf), repairs: [], details: { inputs } });
    items.push(issue); show(featureId, issue);
  }
  (build.bodyIssues ?? []).forEach((issue, index) => items.push(cadBodyIssue(issue, index)));
  return Object.freeze({ items: createCadIssueList(items, checked), byFeature });
}

function kernelFailure(diagnostic: CadDiagnostic, key: string, feature: CadFeature | undefined, causes: readonly string[], version: string): CadKernelIssueOf {
  const input = diagnostic.details?.input ?? null;
  const subject = diagnostic.featureId === undefined ? { kind: 'document' } as const
    : input ? { kind: 'reference-slot', featureId: diagnostic.featureId, field: input.field, inputId: input.id } as const : { kind: 'feature', featureId: diagnostic.featureId } as const;
  const failure: CadKernelFailure = { operation: diagnostic.details?.operation ?? cadKernelOperationOf(feature), input, kernelMessage: diagnostic.details?.kernelMessage ?? null };
  // The caller recognised the code (`cadReceivedDiagnostic`) and keeps stops apart.
  const code = diagnostic.code as Exclude<CadRefusalCode, 'rebuild-stopped'> | 'kernel-unrecognised';
  const common = { key, namespace: 'kernel', severity: 'error', state: 'failed', subject, message: diagnostic.message, causes,
    repairs: feature ? featureRepairs(feature, code, version) : [] } as const;
  /** The facts code `fact` carries, which the reply guard checked; a failure that gives none is a programming error. */
  const factsOf = <C extends CadRefusalFactCode>(fact: C): CadRefusalFacts[C] => {
    if (!isCadRefusalFacts(fact, diagnostic.facts)) throw new Error(`The ${fact} failure of ${diagnostic.featureId ?? 'the document'} gives no facts.`);
    return diagnostic.facts as CadRefusalFacts[C];
  };
  switch (code) {
    case 'selection-count-mismatch': return createCadIssue({ ...common, code, details: { ...failure, ...factsOf(code) } });
    case 'selection-empty': return createCadIssue({ ...common, code, details: { ...failure, ...factsOf(code) } });
    case 'kernel-unrecognised': return createCadIssue({ ...common, code, details: { ...failure, ...factsOf(code) } });
    default: return createCadIssue({ ...common, code, details: failure });
  }
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

/** The kernel step a feature's rebuild starts with, and the step a failure without kernel details names: the feature's own operation. */
export function cadKernelOperationOf(feature: CadFeature | undefined): CadKernelOperation {
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
  const common = { key: `body:${index}:${issue.code}`, namespace: 'body', severity: 'warning', state: 'failed', subject: { kind: 'body', key: issue.body, featureId: issue.featureId },
    message: issue.message, causes: [], repairs: [] } as const;
  switch (issue.code) {
    case 'untracked-body-parts': return createCadIssue({ ...common, code: issue.code, details: { reason: issue.reason! } });
    case 'more-body-issues': return createCadIssue({ ...common, code: issue.code, details: { omittedCount: issue.omitted! } });
    default: return createCadIssue({ ...common, code: issue.code, details: { pieces: issue.pieces } });
  }
}
