import { userFacingMessage } from '@/lib/userMessage';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CadDocument, CadScalar, CadSketchFeature } from '@/domain/cad/cadDocument';
import type { CadSketchGraph, CadSketchGraphRelation } from '@/domain/cad/cadSketchGraph';
import { mapCadSketchRelationScalars } from '@/domain/cad/cadSketchGraphReferences';
import { reduceCadEditIntents, validateCadEditBatch, type CadEdit } from '@/domain/cad/cadOperations';
import type { CadScalarEditContextValue, CadScalarValueDraft } from './CadFields';
import { useCadEditSubmission, type CadEditCompletion } from './useCadEditSubmission';
import { cadPreviewMarks, useCadPreparedPreview, type CadPrepareEdits } from './useCadPreparedPreview';
import type { CadSketchDiagnosisMarks } from './cadSketchDefinitionMarks';
import { CadSketchPreparationError, type CadSketchConstraintFeedback } from './cadSketchConstraintFeedback';
import { cadGeneratorRemovals } from './cadGeneratorRemovals';
import { useCadGeneratorRemovalConfirmation } from './useCadGeneratorRemovalConfirmation';

/**
 * One pending edit of an accepted sketch, as the value editor at a dimension and the inspector's sketch editors make it: a draft graph whose
 * relation, point and circle changes become edits, or the edits of a command, with parameter changes first. The prepared edit path previews
 * it, the native judge accepts or refuses it on Apply, and a refusal keeps the draft with its feedback. Expressions, parameters, units and
 * pending precision come from the scalar fields that share `scalarContext`. Relations a parameter change removes as generators regenerate
 * are asked about first, and the next Apply removes them in the same edit.
 */
export interface CadSketchDraftOptions {
  readonly document: CadDocument;
  readonly sketch: CadSketchFeature;
  readonly graph: CadSketchGraph;
  /** The edits of a command, such as a move or a corner, instead of the draft's own changes; an Error says why it cannot apply yet. */
  readonly command?: readonly CadEdit[] | Error | null;
  /** Point and circle keys whose accepted scalars the fields compare a draft with. */
  readonly geometryScalars?: Readonly<Record<string, CadScalar>>;
  /** Whether the draft stays pending though it changes nothing, as an open move does. */
  readonly held?: boolean;
  readonly interactionLocked: boolean;
  onEditMany(edits: readonly CadEdit[], signal?: AbortSignal): CadEditCompletion;
  onPrepareEdits?: CadPrepareEdits;
  onPendingChange(pending: boolean): void;
  onPreviewDocument?(document: CadDocument | null, marks?: CadSketchDiagnosisMarks | null): void;
  /** The feedback of a refused preview or Apply, or null once there is none; it reaches the header and the tree through the issue adapter. */
  onFeedback?(feedback: CadSketchConstraintFeedback | null): void;
}

export function useCadSketchDraft({ document: cadDocument, sketch, graph, command = null, geometryScalars, held = false, interactionLocked, onEditMany, onPrepareEdits,
  onPendingChange, onPreviewDocument, onFeedback }: CadSketchDraftOptions) {
  const submission = useCadEditSubmission();
  const latest = useRef({ document: cadDocument, sketch, graph }); latest.current = { document: cadDocument, sketch, graph };
  const [source, setSource] = useState(latest.current), [draft, setDraftState] = useState<CadSketchGraph>(graph);
  const [parameterEdits, setParameterEdits] = useState<Readonly<Record<string, number>>>({});
  const [valueDrafts, setValueDrafts] = useState<Readonly<Record<string, CadScalarValueDraft>>>({});
  const [fieldIssues, setFieldIssues] = useState<Readonly<Record<string, string>>>({});
  const [relationPending, setRelationPending] = useState<Readonly<Record<string, boolean>>>({});
  const [relationEdits, setRelationEdits] = useState<Readonly<Record<string, boolean>>>({});
  const [error, setError] = useState<string | CadSketchConstraintFeedback | null>(null), [resetVersion, setResetVersion] = useState(0);
  /** The full operand marks of the refused Apply whose feedback `error` holds; any other error drops them. */
  const [appliedFailure, setAppliedFailure] = useState<{ feedback: CadSketchConstraintFeedback; marks: CadSketchDiagnosisMarks | null } | null>(null);
  const reset = useCallback(() => {
    submission.cancel(); setSource(latest.current); setDraftState(latest.current.graph);
    setParameterEdits({}); setValueDrafts({}); setFieldIssues({}); setRelationPending({}); setRelationEdits({}); setError(null); setAppliedFailure(null);
    setResetVersion(version => version + 1);
  }, [submission.cancel]);
  const setDraft = useCallback((update: (current: CadSketchGraph) => CadSketchGraph) => { setError(null); setDraftState(update); }, []);
  const changeRelation = useCallback((relation: CadSketchGraphRelation) => setDraft(current => ({ ...current, relations: current.relations.some(item => item.id === relation.id)
    ? current.relations.map(item => item.id === relation.id ? relation : item) : [...current.relations, relation] })), [setDraft]);
  const removeRelation = useCallback((id: string) => setDraft(current => ({ ...current, relations: current.relations.filter(relation => relation.id !== id) })), [setDraft]);
  const setValueDraft = useCallback((key: string, value: CadScalarValueDraft | null) => {
    setError(null); setValueDrafts(previous => { const next = { ...previous }; if (value) next[key] = value; else delete next[key]; return next; });
  }, []);
  const setIssue = useCallback((key: string, issue: string | null) => setFieldIssues(previous => {
    if ((previous[key] ?? null) === issue) return previous;
    const next = { ...previous }; if (issue) next[key] = issue; else delete next[key]; return next;
  }), []);
  const setBindingPending = useCallback((key: string, pending: boolean) => setRelationPending(previous => {
    if (Boolean(previous[key]) === pending) return previous;
    const next = { ...previous }; if (pending) next[key] = true; else delete next[key]; return next;
  }), []);
  const markRelationEdited = useCallback((key: string) => setRelationEdits(previous => previous[key] ? previous : { ...previous, [key]: true }), []);
  const changeParameter = useCallback((name: string, value: number) => {
    setError(null); setParameterEdits(previous => { const next = { ...previous }; if (value === source.document.parameters[name]) delete next[name]; else next[name] = value; return next; });
  }, [source.document]);
  const parameters = useMemo(() => ({ ...source.document.parameters, ...parameterEdits }), [source.document, parameterEdits]);
  const acceptedScalars = useMemo(() => {
    const values: Record<string, CadScalar> = { ...geometryScalars };
    for (const relation of source.graph.relations) mapCadSketchRelationScalars(relation, (value, key) => { values[`${relation.id}/${key}`] = value; return value; });
    return values;
  }, [geometryScalars, source.graph]);
  const built = useMemo(() => {
    try {
      const edits: CadEdit[] = Object.entries(parameterEdits).map(([name, value]) => ({ kind: 'set-parameter', name, value }));
      if (command instanceof Error) throw command;
      if (command) edits.push(...command);
      else {
        // A value typed back to what it was changes nothing, though the draft holds new point or edge lists.
        const pointsChanged = draft.points !== source.graph.points && JSON.stringify(draft.points) !== JSON.stringify(source.graph.points);
        const entitiesChanged = draft.entities !== source.graph.entities && JSON.stringify(draft.entities) !== JSON.stringify(source.graph.entities);
        if (pointsChanged || entitiesChanged) edits.push({ kind: 'update-feature', feature: { ...source.sketch, graph: { ...source.graph, points: draft.points, entities: draft.entities } } });
        const originals = new Map(source.graph.relations.map(relation => [relation.id, relation])), current = new Set(draft.relations.map(relation => relation.id));
        for (const relation of source.graph.relations) if (!current.has(relation.id)) edits.push({ kind: 'remove-sketch-relation', sketchId: sketch.id, relationId: relation.id });
        for (const relation of draft.relations) if (JSON.stringify(originals.get(relation.id)) !== JSON.stringify(relation)) edits.push({ kind: 'set-sketch-relation', sketchId: sketch.id, relation });
      }
      if (edits.length && source.document !== cadDocument) throw new Error('The part changed. Cancel this edit and use the current selection.');
      return { edits, issue: null };
    } catch (cause) { return { edits: null, issue: userFacingMessage(cause, 'Invalid sketch relation.') }; }
  }, [parameterEdits, command, draft, source, cadDocument, sketch.id]);
  const confirmation = useCadGeneratorRemovalConfirmation(cadDocument, built.edits);
  const candidate = useMemo(() => {
    const edits = confirmation.edits;
    if (!edits?.length) return built;
    try {
      // Preparation solves preceding parameter changes before geometry-dependent commands.
      if (onPrepareEdits) validateCadEditBatch(edits); else reduceCadEditIntents(cadDocument, edits);
      return { edits, issue: null };
    } catch (cause) {
      const removals = cadGeneratorRemovals(cause);
      return removals ? { edits, issue: null, removals } : { edits: null, issue: userFacingMessage(cause, 'Invalid sketch relation.') };
    }
  }, [built, confirmation.edits, cadDocument, onPrepareEdits]);
  const scalarPending = Object.keys(fieldIssues).length > 0 || Object.values(relationPending).some(Boolean);
  const changed = Boolean(candidate.edits?.length) || candidate.issue !== null;
  const pending = held || changed || scalarPending || submission.applying;
  const callbacks = useRef({ onPendingChange, onPreviewDocument, onFeedback }); callbacks.current = { onPendingChange, onPreviewDocument, onFeedback };
  useLayoutEffect(() => { onPendingChange(pending); }, [pending, onPendingChange]);
  useLayoutEffect(() => () => { callbacks.current.onPendingChange(false); callbacks.current.onPreviewDocument?.(null); callbacks.current.onFeedback?.(null); }, []);
  useEffect(() => { if (source.document !== cadDocument && !pending) reset(); }, [source.document, cadDocument, pending, reset]);
  const prepared = useCadPreparedPreview(cadDocument, candidate.edits, onPrepareEdits, Boolean(onPrepareEdits && changed && !scalarPending && !submission.applying && !interactionLocked));
  const measurementDocument = prepared.kind === 'ready' ? prepared.document : !changed ? source.document : null;
  const measurementSketch = measurementDocument?.features.find(feature => feature.id === sketch.id);
  const measurementGraph = measurementSketch?.kind === 'sketch' ? measurementSketch.graph ?? null : null;
  const failedApply = typeof error === 'object' && error !== null;
  const failureMarks = source.document !== cadDocument ? null : failedApply ? appliedFailure?.feedback === error ? appliedFailure.marks : null : cadPreviewMarks(prepared);
  useLayoutEffect(() => { onPreviewDocument?.(prepared.kind === 'ready' ? prepared.document : null, failureMarks); return () => onPreviewDocument?.(null); }, [prepared, failureMarks, onPreviewDocument]);
  const found = 'removals' in candidate ? candidate.removals : prepared.kind === 'error' ? prepared.removals : undefined;
  const { hold } = confirmation;
  useEffect(() => { hold(found); }, [found, hold]);
  // Relations the edit removes are asked about, not refused: the next Apply confirms them.
  const blockingIssue = candidate.issue ?? confirmation.issue ?? (prepared.kind === 'error' && !prepared.removals ? prepared.message : null);
  const feedback = source.document === cadDocument ? failedApply ? error : prepared.kind === 'error' && !prepared.removals ? prepared.feedback ?? null : null : null;
  useLayoutEffect(() => { onFeedback?.(feedback); }, [feedback, onFeedback]);
  const issue = typeof error === 'string' ? error : feedback?.message ?? blockingIssue;
  const canApply = !interactionLocked && !submission.applying && !scalarPending && Boolean(candidate.edits?.length) && !blockingIssue;
  /** Applies the draft as one edit. A refusal keeps the draft and shows its feedback; `refused` may apply something else instead. */
  const apply = (accepted?: () => void, refused?: (cause: unknown, edits: readonly CadEdit[]) => boolean) => {
    if (!canApply || !candidate.edits) return;
    setError(null);
    const asked = built.edits;
    const run = (edits: readonly CadEdit[]) => submission.submit(signal => onEditMany(edits, signal), () => { reset(); accepted?.(); }, cause => {
      // An Apply that finds removals the preview had not shown asks for them as the preview would.
      if (hold(cadGeneratorRemovals(cause), asked)) return;
      if (refused?.(cause, edits)) return;
      if (cause instanceof CadSketchPreparationError) setAppliedFailure({ feedback: cause.feedback, marks: cause.marks });
      setError(cause instanceof CadSketchPreparationError ? cause.feedback : userFacingMessage(cause, 'Unable to apply this sketch edit.'));
    });
    run(candidate.edits);
  };
  const scalarContext: CadScalarEditContextValue = { parameters, acceptedScalars, relationEdits, valueDrafts, setValueDraft, setIssue,
    setRelationPending: setBindingPending, markRelationEdited, changeParameter };
  return { source, draft, setDraft, changeRelation, removeRelation, parameters, scalarContext, candidate, prepared, measurementDocument, measurementGraph,
    issue, notice: issue ? null : confirmation.notice, feedback, pending, canApply, applying: submission.applying, apply, reset, resetVersion, setError };
}
export type CadSketchDraft = ReturnType<typeof useCadSketchDraft>;
