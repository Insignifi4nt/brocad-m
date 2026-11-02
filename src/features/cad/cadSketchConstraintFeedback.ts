import { CadError } from '@/domain/cad/cadError';
import type { CadSketchGraph, CadSketchGraphIssue } from '@/domain/cad/cadSketchGraph';
import { cadSketchEntityPointIds, cadSketchRelationEntityIds, cadSketchRelationPointIds } from '@/domain/cad/cadSketchGraphReferences';
import { cadSketchDiagnosisMarks, type CadSketchDiagnosisMarks } from './cadSketchDefinitionMarks';
import { cadSketchRelationName, cadSketchRelationOperandLabels, createCadSketchRelationLabels } from './cadSketchRelationNames';
import type { CadSketchSolveDiagnostics, CadSketchSolveResult } from './sketch-solver/cadSketchSolverTypes';

type Rejection = Extract<CadSketchSolveResult, { kind: 'rejected' }>;
type Source = CadSketchGraphIssue['source'];
type Subject = { readonly source: Source; readonly label: string; readonly pointIds: readonly string[]; readonly entityIds: readonly string[] };
export type CadSketchConstraintFeedbackSubject = Subject & (
  { readonly category: 'conflicting' | 'redundant' | 'partially-redundant' }
  | { readonly category: 'issue'; readonly code: CadSketchGraphIssue['code']; readonly detail: string; readonly residualMm?: number }
);
export interface CadSketchConstraintFeedback {
  readonly sketchId: string;
  readonly reason: Rejection['reason'];
  readonly message: string;
  readonly subjects: readonly CadSketchConstraintFeedbackSubject[];
  readonly subjectCount: number;
  readonly omittedSubjectCount: number;
  /** Only when the solver could not judge the edit at all: it could not load, its worker failed or its reply could not be read. */
  readonly cause?: 'solver-unavailable';
  /** The browser's or the solver worker's own words for that failure, bounded, when it gave any; the message never repeats them. */
  readonly kernelMessage?: string;
}
interface PreparationFailureInput {
  readonly sketchId: string; readonly sketchName: string; readonly graph: CadSketchGraph; readonly rejection: Rejection; readonly dragPointId?: string;
  /** The solver failed rather than judged the edit (`CadSketchSolverFailure`), with its own words when it gave any. */
  readonly unavailable?: { readonly kernelMessage?: string };
}

const rejectionMessages: Record<Rejection['reason'], string> = {
  conflicting: 'Sketch constraints conflict.', redundant: 'Sketch constraints are redundant.', failed: 'The sketch solver could not solve this edit.',
  'invalid-input': 'Sketch input is invalid.', 'too-large': 'A connected group of sketch relations is too large to solve.', 'invalid-solution': 'The sketch solution does not satisfy its geometry and relations.'
};
const issueDetails: Record<CadSketchGraphIssue['code'], string> = {
  'invalid-expression': 'The expression could not be evaluated.', 'invalid-coordinate': 'The coordinate is outside the supported range.',
  'degenerate-entity': 'The edge endpoints are too close.', 'invalid-radius': 'The radius is outside the supported range.',
  'arc-radius-mismatch': 'The arc endpoints have different radii.', 'invalid-distance': 'The driving distance is invalid.',
  'relation-residual': 'The geometry does not satisfy this relation.'
};

/** Ordinals describe this graph snapshot only. Exact source IDs remain the action keys. */
export function describeCadSketchConstraintSource(graph: CadSketchGraph, source: Source): Subject {
  const pointLabel = (id: string) => {
    const index = graph.points.findIndex(point => point.id === id);
    return index < 0 ? 'Unavailable point' : `Point ${index + 1}`;
  };
  let label: string, pointIds: readonly string[] = [], entityIds: readonly string[] = [];
  if (source.kind === 'relation') {
    const index = graph.relations.findIndex(relation => relation.id === source.id), relation = graph.relations[index];
    if (relation) {
      pointIds = cadSketchRelationPointIds(graph, relation); entityIds = cadSketchRelationEntityIds(relation);
      const labels = createCadSketchRelationLabels(graph), operands = cadSketchRelationOperandLabels(graph, relation, labels);
      const name = cadSketchRelationName(graph, relation, labels.centres);
      label = `${name} relation ${index + 1} · ${operands.join(relation.kind === 'axis-distance' ? ' → ' : ' and ')}`;
    } else label = 'Unavailable relation';
  } else if (source.kind === 'entity') {
    const entity = graph.entities.find(entity => entity.id === source.id);
    if (entity) {
      const ordinal = [...graph.entities].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).findIndex(item => item.id === source.id) + 1;
      label = `${entity.kind[0].toUpperCase()}${entity.kind.slice(1)} ${ordinal}`;
      pointIds = cadSketchEntityPointIds(entity); entityIds = [entity.id];
    } else label = 'Unavailable edge';
  } else {
    label = pointLabel(source.id);
    if (graph.points.some(point => point.id === source.id)) pointIds = [source.id];
  }
  return Object.freeze({ source: Object.freeze({ ...source }), label, pointIds: Object.freeze([...pointIds]), entityIds: Object.freeze([...entityIds]) });
}

/**
 * The sources a solve names, as subjects in diagnosis order: conflicting, redundant and partly redundant identities, then geometry issues,
 * at most `limit` of them. A source the graph no longer has is left out.
 */
export function cadSketchDiagnosticSubjects(graph: CadSketchGraph, diagnostics: CadSketchSolveDiagnostics, limit = Infinity, dragPointId?: string): readonly CadSketchConstraintFeedbackSubject[] {
  const subjects: CadSketchConstraintFeedbackSubject[] = [];
  for (const [category, ids] of [['conflicting', diagnostics.conflictingIds], ['redundant', diagnostics.redundantIds], ['partially-redundant', diagnostics.partiallyRedundantIds]] as const) {
    for (const id of ids) {
      if (subjects.length >= limit) break;
      const source: Source | null = graph.relations.some(item => item.id === id) ? { kind: 'relation', id }
        : graph.entities.some(item => item.id === id) ? { kind: 'entity', id } : graph.points.some(item => item.id === id) ? { kind: 'point', id } : null;
      if (source) {
        const subject = describeCadSketchConstraintSource(graph, source);
        const label = source.kind === 'point' && source.id === dragPointId ? `Move ${subject.label}`
          : source.kind === 'entity' && graph.entities.some(entity => entity.id === source.id && entity.kind === 'arc') ? `${subject.label} endpoint radii` : subject.label;
        subjects.push(Object.freeze({ ...subject, label, category }));
      }
    }
  }
  for (const issue of diagnostics.issues) {
    if (subjects.length >= limit) break;
    subjects.push(Object.freeze({ ...describeCadSketchConstraintSource(graph, issue.source), category: 'issue', code: issue.code, detail: issueDetails[issue.code],
      ...(issue.residualMm === undefined ? {} : { residualMm: issue.residualMm }) }));
  }
  return subjects;
}

function feedback({ sketchId, sketchName, graph, rejection, dragPointId, unavailable }: PreparationFailureInput): CadSketchConstraintFeedback {
  const diagnostics = rejection.diagnostics, subjects = cadSketchDiagnosticSubjects(graph, diagnostics, 8, dragPointId);
  const subjectCount = diagnostics.conflictingIds.length + diagnostics.redundantIds.length + diagnostics.partiallyRedundantIds.length + diagnostics.issues.length;
  // A solver that failed rather than judged the edit says why and how to recover, which the generic wording would hide.
  const failed = unavailable;
  const message = failed ? rejection.message : rejectionMessages[rejection.reason];
  return Object.freeze({ sketchId, reason: rejection.reason, message: `${sketchName}: ${message}`,
    subjects: Object.freeze(subjects), subjectCount, omittedSubjectCount: subjectCount - subjects.length,
    ...(failed ? { cause: 'solver-unavailable' as const, ...(failed.kernelMessage ? { kernelMessage: failed.kernelMessage } : {}) } : {}) });
}

/** A failed candidate retains diagnosis and operand identities without owning accepted data or history. */
export class CadSketchPreparationError extends CadError<`sketch-${Rejection['reason']}`> {
  readonly feedback: CadSketchConstraintFeedback;
  readonly diagnostics: CadSketchSolveDiagnostics;
  readonly solverMessage: string;
  /** Every reported operand, not only the summarized subjects, so the canvas can colour them. */
  readonly marks: CadSketchDiagnosisMarks | null;
  constructor(input: PreparationFailureInput) {
    const presentation = feedback(input);
    super(`sketch-${input.rejection.reason}` as const, presentation.message);
    this.name = 'CadSketchPreparationError'; this.feedback = presentation; this.solverMessage = input.rejection.message;
    const diagnostics = input.rejection.diagnostics;
    this.diagnostics = Object.freeze({ ...diagnostics, conflictingIds: Object.freeze([...diagnostics.conflictingIds]), redundantIds: Object.freeze([...diagnostics.redundantIds]),
      partiallyRedundantIds: Object.freeze([...diagnostics.partiallyRedundantIds]), issues: Object.freeze(diagnostics.issues.map(issue => Object.freeze({ ...issue, source: Object.freeze({ ...issue.source }) }))) });
    this.marks = cadSketchDiagnosisMarks(input.sketchId, input.graph, diagnostics);
    if (presentation.kernelMessage) (this as { kernelMessage?: string }).kernelMessage = presentation.kernelMessage;
  }
}
