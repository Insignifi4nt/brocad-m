import { createCadIssue, createCadIssueList, type CadIssue, type CadIssueRepair, type CadSketchIssueOf, type CadSketchItemOrigin } from '@/domain/cad/cadIssues';
import type { CadSketchRefusalCode } from '@/domain/cad/cadIssueCodes';
import type { CadSketchGraph, CadSketchGraphIssue } from '@/domain/cad/cadSketchGraph';
import { CAD_SKETCH_MIRROR_COLLAPSE } from '@/domain/cad/cadSketchSymmetryRelations';
import type { CadSketchEditWarning } from './cadEditPreparation';
import { cadSketchDiagnosticSubjects, describeCadSketchConstraintSource, type CadSketchConstraintFeedback, type CadSketchConstraintFeedbackSubject } from './cadSketchConstraintFeedback';
import type { CadSketchSolveDiagnostics, CadSketchSolveResult } from './sketch-solver/cadSketchSolverTypes';

/**
 * What is wrong with the sketch being edited, for its header and its relation rows: the sketch producer's adapter into the CAD issue model.
 * It turns the accepted analysis, a refused edit's feedback and the shrink warnings of the last accepted edit into issues (`issues`), and
 * gives each issue it shows a row with the names this graph has for it. The header and the rows read nothing else.
 */
export type CadSketchIssueCategory = 'conflicting' | 'redundant' | 'partially-redundant' | 'not-met' | 'geometry' | 'shrink';
/** A sketch item's issue: a relation, edge or point the solver or the graph check names, or a relation Symmetric shrank its curves to keep. */
export type CadSketchItemIssue = Exclude<CadSketchIssueOf, { readonly subject: { readonly kind: 'feature' } }>;
export type CadSketchRefusalIssue = Extract<CadSketchIssueOf, { readonly subject: { readonly kind: 'feature' } }>;
/** One row of the sketch's issues: its issue, and how this graph names and draws it. */
export interface CadSketchIssue {
  readonly issue: CadSketchItemIssue;
  /** The issue's key, stable within one list, so a row keeps its key while the list is shown. */
  readonly key: string;
  readonly category: CadSketchIssueCategory;
  /** What the issue is about, as the relation, edge or point is named in this graph. */
  readonly label: string;
  /** The issue's state in a few words, as a row badge shows it. */
  readonly state: string;
  /** The issue's message: a sentence that explains it. */
  readonly detail: string;
  /** The source inspecting the issue highlights; a warning names its relation. */
  readonly source: CadSketchGraphIssue['source'];
  /** The relation this issue belongs to, so its tree row shows it. */
  readonly relationId: string | null;
  readonly pointIds: readonly string[];
  readonly entityIds: readonly string[];
  /** The analysis of the accepted sketch, the edit that was just refused, or the last accepted edit's warnings. */
  readonly origin: CadSketchItemOrigin;
  /** The subject a constraint diagnostic came from, for the canvas inspection. */
  readonly subject: CadSketchConstraintFeedbackSubject | null;
}
export interface CadSketchIssues {
  readonly sketchId: string;
  /** The refusal of the edit or of the accepted analysis, when either has one; it names the rows of its origin as its causes. */
  readonly refusal: CadSketchRefusalIssue | null;
  /** The refusal's message, or null. */
  readonly message: string | null;
  readonly list: readonly CadSketchIssue[];
  /** Items a refused edit named beyond the subjects it kept. */
  readonly omitted: number;
  readonly byRelation: ReadonlyMap<string, readonly CadSketchIssue[]>;
  /** The refusal, then each row's issue: one causal list. */
  readonly issues: readonly CadIssue[];
}
/**
 * The accepted analysis of the sketch, kept only while it names something. A solver that failed rather than judged the sketch, or could not
 * load, gives reason `failed` with its own message, which names the cause and the next step, the cause `solver-unavailable` and, when the
 * browser or the worker gave any, their words.
 */
export interface CadSketchAnalysisIssues {
  readonly kind: CadSketchSolveResult['kind'] | 'unavailable' | 'legacy';
  readonly reason: Extract<CadSketchSolveResult, { kind: 'rejected' }>['reason'] | null;
  readonly diagnostics: Pick<CadSketchSolveDiagnostics, 'conflictingIds' | 'redundantIds' | 'partiallyRedundantIds' | 'issues'>;
  readonly cause?: 'solver-unavailable';
  readonly message?: string;
  readonly kernelMessage?: string;
}
/** An analysis as the sketch's status reports it: a solve result, or one the solver could not give, maybe because the solver failed. */
export type CadSketchAnalysisInput = CadSketchSolveResult | { readonly kind: CadSketchAnalysisIssues['kind']; readonly reason?: CadSketchAnalysisIssues['reason']; readonly message?: string;
  readonly cause?: 'solver-unavailable'; readonly kernelMessage?: string; readonly diagnostics: CadSketchSolveDiagnostics };

const STATES: Record<CadSketchIssueCategory, string> = {
  conflicting: 'Conflict', redundant: 'Redundant', 'partially-redundant': 'Partly redundant', 'not-met': 'Not met', geometry: 'Geometry issue', shrink: 'Shrinks'
};
const DETAILS: Record<Exclude<CadSketchIssueCategory, 'not-met' | 'geometry' | 'shrink'>, string> = {
  conflicting: 'This conflicts with other relations.', redundant: 'Other relations already hold this.', 'partially-redundant': 'Other relations already hold part of this.'
};
const RELATION_CODES = { conflicting: 'relation-conflicting', redundant: 'relation-redundant', 'partially-redundant': 'relation-partially-redundant' } as const;
const ANALYSIS_MESSAGES: Record<NonNullable<CadSketchAnalysisIssues['reason']>, string> = {
  conflicting: 'Sketch constraints conflict.', redundant: 'Sketch constraints are redundant.', failed: 'The sketch solver could not solve this sketch.',
  'invalid-input': 'Sketch input is invalid.', 'too-large': 'A connected group of sketch relations is too large to solve.', 'invalid-solution': 'The sketch does not satisfy its geometry and relations.'
};
export const NO_CAD_SKETCH_ISSUES_BY_RELATION: ReadonlyMap<string, readonly CadSketchIssue[]> = new Map();

/** The solver's failure an analysis reports (`CadSketchSolverFailure`, as the cause `solver-unavailable`); null when the solver judged the sketch. */
function solverFailure(analysis: CadSketchAnalysisInput): { readonly message: string; readonly kernelMessage?: string } | null {
  return 'cause' in analysis && analysis.cause === 'solver-unavailable' && analysis.message
    ? { message: analysis.message, ...analysis.kernelMessage ? { kernelMessage: analysis.kernelMessage } : {} } : null;
}

/** The accepted analysis worth keeping: its named identities and issues, or null when it names nothing. Reuses `previous` when equal. */
export function cadSketchAnalysisIssues(analysis: CadSketchAnalysisInput, previous?: CadSketchAnalysisIssues | null): CadSketchAnalysisIssues | null {
  const { conflictingIds, redundantIds, partiallyRedundantIds, issues } = analysis.diagnostics;
  const failure = solverFailure(analysis);
  const reason = failure ? 'failed' : analysis.kind === 'rejected' && 'reason' in analysis ? analysis.reason ?? null : null;
  if (!conflictingIds.length && !redundantIds.length && !partiallyRedundantIds.length && !issues.length && !reason) return null;
  const next: CadSketchAnalysisIssues = Object.freeze({ kind: analysis.kind, reason, diagnostics: Object.freeze({ conflictingIds, redundantIds, partiallyRedundantIds, issues }),
    ...failure ? { cause: 'solver-unavailable' as const, ...failure } : {} });
  return previous && JSON.stringify(previous) === JSON.stringify(next) ? previous : next;
}

/** The subject of a sketch item's issue, by the kind of its source. */
function itemSubject(sketchId: string, source: CadSketchGraphIssue['source']): CadSketchItemIssue['subject'] {
  return source.kind === 'relation' ? { kind: 'sketch-relation', sketchId, relationId: source.id }
    : source.kind === 'entity' ? { kind: 'sketch-entity', sketchId, entityId: source.id } : { kind: 'sketch-point', sketchId, pointId: source.id };
}

/**
 * The repairs an existing action performs for a relation the solver names: deleting it, as its relation row does, ends a conflict it takes
 * part in and drops what other relations already hold. A pattern detaches through its editor instead, so it has none here.
 */
function relationRepairs(graph: CadSketchGraph, sketchId: string, source: CadSketchGraphIssue['source'], version: string): readonly CadIssueRepair[] {
  const relation = source.kind === 'relation' ? graph.relations.find(item => item.id === source.id) : undefined;
  if (!relation || relation.kind === 'linear-pattern') return [];
  return [{ id: `delete-relation:${relation.id}`, label: 'Delete relation', preparedAt: version, kind: 'edit', edits: [{ kind: 'remove-sketch-relation', sketchId, relationId: relation.id }] }];
}

function fromSubject(graph: CadSketchGraph, sketchId: string, subject: CadSketchConstraintFeedbackSubject, origin: 'analysis' | 'edit', index: number, version: string): CadSketchIssue {
  const category: CadSketchIssueCategory = subject.category === 'issue' ? subject.code === 'relation-residual' ? 'not-met' : 'geometry' : subject.category;
  const detail = subject.category === 'issue' ? subject.detail : DETAILS[subject.category];
  const key = `${origin}/${category}/${subject.source.kind}/${subject.source.id}/${index}`;
  const details = { origin, pointIds: subject.pointIds, entityIds: subject.entityIds };
  const common = { key, namespace: 'sketch', state: 'failed', subject: itemSubject(sketchId, subject.source), message: detail, causes: [] } as const;
  const issue: CadSketchItemIssue = createCadIssue(subject.category !== 'issue'
    ? { ...common, code: RELATION_CODES[subject.category], severity: subject.category === 'conflicting' ? 'error' : 'warning', details,
      repairs: relationRepairs(graph, sketchId, subject.source, version) }
    : subject.code === 'relation-residual' ? { ...common, code: 'relation-residual', severity: 'error', details: { ...details, residualMm: subject.residualMm ?? null }, repairs: [] }
      : { ...common, code: subject.code, severity: 'error', details, repairs: [] });
  return Object.freeze({ issue, key, category, label: subject.label, state: STATES[category], detail, source: subject.source,
    relationId: subject.source.kind === 'relation' ? subject.source.id : null, pointIds: subject.pointIds, entityIds: subject.entityIds, origin, subject });
}

/**
 * The issues of sketch `sketchId` with graph `graph` at document version `version`: a refused edit's subjects when `feedback` belongs to
 * it, otherwise the accepted analysis's, under the refusal that names them; then the shrink warnings of the last accepted edit on this
 * sketch. A source the graph no longer has is left out. Messages are those the feedback, the analysis and the warnings give.
 */
export function cadSketchIssues({ sketchId, graph, version, analysis, feedback, warnings }: {
  readonly sketchId: string; readonly graph: CadSketchGraph; readonly version: string; readonly analysis?: CadSketchAnalysisIssues | null;
  readonly feedback?: CadSketchConstraintFeedback | null; readonly warnings?: readonly CadSketchEditWarning[] | null;
}): CadSketchIssues {
  const refused = feedback?.sketchId === sketchId ? feedback : null, origin = refused ? 'edit' : 'analysis';
  const subjects = refused ? refused.subjects : analysis ? cadSketchDiagnosticSubjects(graph, { ...analysis.diagnostics, status: null, degreesOfFreedom: null }) : [];
  const list: CadSketchIssue[] = subjects.map((subject, index) => fromSubject(graph, sketchId, subject, origin, index, version));
  const named = list.map(row => row.key);
  for (const [index, warning] of (warnings ?? []).entries()) {
    if (warning.sketchId !== sketchId || !graph.relations.some(relation => relation.id === warning.relationId)) continue;
    const subject = describeCadSketchConstraintSource(graph, { kind: 'relation', id: warning.relationId });
    const shrunk = warning.curves.filter(curve => graph.entities.some(entity => entity.id === curve.entityId));
    const key = `warning/shrink/${warning.relationId}/${index}`;
    const issue: CadSketchItemIssue = createCadIssue({ key, namespace: 'sketch', code: 'mirror-shrank', severity: 'warning', state: 'failed',
      subject: { kind: 'sketch-relation', sketchId, relationId: warning.relationId }, message: warning.message, causes: [], repairs: [],
      details: { curves: shrunk.map(({ entityId, beforeMm, afterMm }) => ({ entityId, beforeMm, afterMm })) } });
    list.push(Object.freeze({ issue, key, category: 'shrink', label: subject.label, state: STATES.shrink, detail: warning.message, source: subject.source,
      relationId: warning.relationId, pointIds: subject.pointIds, entityIds: [...new Set([...subject.entityIds, ...shrunk.map(curve => curve.entityId)])], origin: 'warning', subject: null }));
  }
  const reason = refused ? refused.reason : analysis?.reason ?? null;
  const message = refused ? refused.message : reason ? analysis?.message ?? ANALYSIS_MESSAGES[reason] : null;
  // A solver that failed names that cause and keeps its words, which the message never repeats.
  const failed = refused ? refused.cause : analysis?.cause, kernelMessage = refused ? refused.kernelMessage : analysis?.kernelMessage;
  const refusal: CadSketchRefusalIssue | null = reason && message !== null ? createCadIssue({ key: `${origin}/refusal`, namespace: 'sketch',
    code: `sketch-${reason}` satisfies CadSketchRefusalCode, severity: 'error', state: 'failed', subject: { kind: 'feature', featureId: sketchId }, message, causes: named, repairs: [],
    details: { cause: failed ?? (message.includes(CAD_SKETCH_MIRROR_COLLAPSE) ? 'mirror-collapse' : null), subjectCount: refused ? refused.subjectCount : named.length,
      omittedSubjectCount: refused?.omittedSubjectCount ?? 0, ...kernelMessage ? { kernelMessage } : {} } }) : null;
  const byRelation = new Map<string, CadSketchIssue[]>();
  for (const row of list) if (row.relationId) byRelation.set(row.relationId, [...byRelation.get(row.relationId) ?? [], row]);
  const issues = createCadIssueList([...refusal ? [refusal] : [], ...list.map(row => row.issue)]);
  return Object.freeze({ sketchId, refusal, message, list: Object.freeze(list), omitted: refused?.omittedSubjectCount ?? 0,
    byRelation: list.length ? byRelation : NO_CAD_SKETCH_ISSUES_BY_RELATION, issues });
}

/** A sketch with no graph to read issues from. */
export function noCadSketchIssues(sketchId: string): CadSketchIssues {
  return Object.freeze({ sketchId, refusal: null, message: null, list: Object.freeze([]), omitted: 0, byRelation: NO_CAD_SKETCH_ISSUES_BY_RELATION, issues: Object.freeze([]) });
}
