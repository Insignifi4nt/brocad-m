import { userFacingMessage } from '@/lib/userMessage';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ContextType } from 'react';
import { CloseIcon, ConfirmIcon, SelectIcon } from '@wire-edm/icons-react';
import type { CadDocument, CadFeature, CadPoint3, CadScalar, CadSketchProfile } from '@/domain/cad/cadDocument';
import { CadError } from '@/domain/cad/cadError';
import { resolveCadProfile } from '@/domain/cad/cadSketchGeometry';
import { cadSketchSourceAvailability } from '@/domain/cad/cadSketchSources';
import { cadSketchRegionSelectionCount } from '@/domain/cad/cadSketchRegionSelection';
import { mapCadFeatureScalars } from '@/domain/cad/cadParameters';
import { CadScalarEditContext, ScalarField, SelectField, type CadScalarValueDraft } from './CadFields';
export { ScalarField, SelectField } from './CadFields';
import { CadPathSegmentFields } from './CadPathSegmentFields';
import { CadPolygonVertexFields } from './CadPolygonVertexFields';
import { CadPluginFields } from './CadPluginFields';
import { inspectCadPluginProfile } from '@/domain/cad/plugins/cadPlugins';
import { cadSketchPlacedFrom, cadVisibleBodyIds } from '@/domain/cad/cadSchema';
import { cadFeatureActive } from '@/domain/cad/features/cadFeatureActivity';
import type { CadFeatureChoice, CadFeatureFormControl, CadFeatureFormPart } from '@/domain/cad/features/cadFeatureDefinitionTypes';
import { cadFeatureDefinition, cadFeatureKinds } from '@/domain/cad/features/cadFeatureRegistry';
import { cadFeaturePresentation } from '@/domain/cad/features/cadFeaturePresentation';
import { CadTopologyQuerySummary } from './CadTopologyQuerySummary';
import { CadLoftSections } from './CadLoftSections';
import { CadSweepSources } from './CadSweepSources';
import { CadExtrudeFields } from './CadExtrudeFields';
import { CadSketchSourceField } from './CadSketchSourceField';
import { CadPlacementNormal } from './CadPlacementNormal';
import { CadPlacementField } from './CadPlacementField';
import { CadDatumPlaneFields } from './CadDatumPlaneFields';
import { CadContextHelp } from './CadContextHelp';
import { cadFeatureHelp } from './cadFieldHelp';
import { cadFeatureCandidateEdits, cadFeatureCandidateKey, type CadFeaturePreviewCommand, type CadFeaturePreviewState } from './cadFeaturePreview';
import { CadFeatureReferencePickingContext, type CadFeatureReferencePickCommand } from './cadFeatureReferencePicking';
import { cadScalarValueIntent, parseCadNumericQuantity } from '@/domain/cad/cadScalarValueIntent';
import { inspectCadExtrudeDepth, type CadExtrudeDepthControl, type CadExtrudeDepthState } from './cadExtrudeDepthInteraction';
import { useCadEditSubmission, type CadEditCompletion } from './useCadEditSubmission';
import { cadPreviewMarks, useCadPreparedPreview, type CadPrepareEdits } from './useCadPreparedPreview';
import type { CadSketchDiagnosisMarks } from './cadSketchDefinitionMarks';
import { CadInspectorTitle } from './CadInspectorTitle';

/** Each kind's name in the history and the inspector, as its definition titles its form. */
export const featureLabels = Object.fromEntries(cadFeatureKinds().map(kind => [kind, cadFeaturePresentation(kind).form.title])) as Record<CadFeature['kind'], string>;

/** A choice as a select names it: its key, or its value where that is already a string. */
const choiceKey = (choice: CadFeatureChoice) => choice.key ?? String(choice.value);

function VectorFields({ label, unit, children }: { label: string; unit: 'mm' | 'deg'; children: React.ReactNode }) {
  return <div className="cad-vector-fields" role="group" aria-label={label}><div className="cad-field-section">{label}<small>{unit}</small></div><div className="cad-vector-row">{children}</div></div>;
}

interface CadFeatureEditorProps {
  feature: CadFeature;
  document: CadDocument;
  isNew: boolean;
  onApply(feature: CadFeature, parameters: Readonly<Record<string, number>>, signal?: AbortSignal): CadEditCompletion;
  onCancel(): void;
  onPendingChange(pending: boolean): void;
  currentBodyIds?: readonly string[];
  documentVersion?: string;
  onFeaturePreview?(command: CadFeaturePreviewCommand): void;
  featurePreview?: CadFeaturePreviewState;
  previewEnabled?: boolean;
  onReferencePick?(command: CadFeatureReferencePickCommand): void;
  topologyPickingEnabled?: boolean;
  /** Moves focus to the choice of edges or opening as it is asked for, by a repair that has them chosen again. */
  focusTopologyPick?: boolean;
  onDepthInteractionReady?(control: CadExtrudeDepthControl | null, released?: CadExtrudeDepthControl): void;
}

export function CadFeatureEditor(props: CadFeatureEditorProps) {
  // Accepted same-ID kind conversions must reset the form before an old draft
  // is rendered against incompatible source fields. Local extent toggles keep
  // the accepted kind until Apply, so their dormant expressions remain intact.
  return <CadFeatureEditorForm key={`${props.feature.id}/${props.feature.kind}`} {...props} />;
}

function CadFeatureEditorForm({ feature, document, isNew, onApply, onCancel, onPendingChange, currentBodyIds, documentVersion, onFeaturePreview, featurePreview, previewEnabled = true, onReferencePick, topologyPickingEnabled = false, focusTopologyPick = false, onDepthInteractionReady }: CadFeatureEditorProps) {
  const submission = useCadEditSubmission();
  const cancel = () => { submission.cancel(); onCancel(); };
  const previewOwner = useId(), previewCallback = useRef(onFeaturePreview);
  previewCallback.current = onFeaturePreview;
  // Each revision of the part that holds an existing feature accepts it again, also where the
  // revision kept its object unchanged. A feature the part no longer holds, or a new feature's
  // draft, stays with the revision it was opened in.
  const baseline = useRef({ feature, version: documentVersion });
  if (baseline.current.feature !== feature || !isNew && baseline.current.version !== documentVersion && document.features.includes(feature)) baseline.current = { feature, version: documentVersion };
  const accepted = baseline.current;
  const staleDraft = accepted.version !== documentVersion;
  const draftSource = useRef(feature);
  const pickerCallback = useRef(onReferencePick); pickerCallback.current = onReferencePick;
  const topologyPickButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (focusTopologyPick) topologyPickButton.current?.focus(); }, [focusTopologyPick]);
  const [picker, setPicker] = useState<Exclude<CadFeatureReferencePickCommand, { kind: 'clear' }> | null>(null);
  const pickCurrent = picker?.expectedVersion === documentVersion ? picker : null;
  const pickToken = useRef<symbol | null>(null);
  const regionStart = useRef<{ feature: CadFeature; document: CadDocument; version: string } | null>(null);
  const pickEnvironment = useRef({ document, documentVersion }); pickEnvironment.current = { document, documentVersion };
  const pickerFocus = useRef<HTMLElement | null>(null);
  const wasPicking = useRef(false);
  const endPick = (token = pickToken.current, keepSelection = false) => {
    if (token !== pickToken.current) return;
    const saved = regionStart.current, current = pickEnvironment.current;
    if (!keepSelection && saved && saved.document === current.document && saved.version === current.documentVersion) setDraft(saved.feature);
    pickToken.current = null; regionStart.current = null; setPicker(null);
  };
  useLayoutEffect(() => {
    if (wasPicking.current && !pickCurrent && pickerFocus.current?.isConnected) pickerFocus.current.focus({ preventScroll: true });
    wasPicking.current = Boolean(pickCurrent);
  }, [pickCurrent]);
  const [draft, setDraft] = useState(feature);
  const [parameterEdits, setParameterEdits] = useState<Readonly<Record<string, number>>>({});
  const [valueDrafts, setValueDrafts] = useState<Readonly<Record<string, CadScalarValueDraft>>>({});
  const [fieldIssues, setFieldIssues] = useState<Readonly<Record<string, string>>>({});
  const [relationPending, setRelationPendingFields] = useState<Readonly<Record<string, boolean>>>({});
  const [relationEdits, setRelationEdits] = useState<Readonly<Record<string, boolean>>>({});
  const [depthGestureActive, setDepthGestureActive] = useState(false);
  // A sketch whose dimensions alone were moved holds the scalars of the sketch it was placed from.
  const scalarSource = feature.kind === 'sketch' ? cadSketchPlacedFrom(feature) : feature;
  const acceptedScalars = useMemo(() => {
    const values: Record<string, CadScalar> = {};
    mapCadFeatureScalars(scalarSource, (value, path) => { values[path] = value; return value; });
    return values;
  }, [scalarSource]);
  const featureChanged = useMemo(() => draft !== feature && JSON.stringify(draft) !== JSON.stringify(feature), [draft, feature]);
  const changed = featureChanged || Object.keys(parameterEdits).length > 0;
  const scalarPending = Object.keys(fieldIssues).length > 0 || Object.values(relationPending).some(Boolean);
  const effectiveDocument = useMemo(() => ({ ...document, parameters: { ...document.parameters, ...parameterEdits } }), [document, parameterEdits]);
  const areasMissing = useMemo(() => {
    if (draft.kind !== 'extrude' && draft.kind !== 'pocket') return false;
    if (draft.regionSelection !== undefined) return cadSketchRegionSelectionCount(draft.regionSelection) === 0;
    const source = effectiveDocument.features.find(feature => feature.id === draft.sketchId);
    return source?.kind === 'sketch' && cadSketchSourceAvailability(source, draft.kind, effectiveDocument.parameters).kind === 'choose-areas';
  }, [draft, effectiveDocument]);
  const setValueDraft = useCallback((key: string, value: CadScalarValueDraft | null) => setValueDrafts(previous => {
    const next = { ...previous }; if (value) next[key] = value; else delete next[key]; return next;
  }), []);
  const setIssue = useCallback((key: string, issue: string | null) => setFieldIssues(previous => {
    if ((previous[key] ?? null) === issue) return previous;
    const next = { ...previous }; if (issue) next[key] = issue; else delete next[key]; return next;
  }), []);
  const setRelationPending = useCallback((key: string, pending: boolean) => setRelationPendingFields(previous => {
    if (Boolean(previous[key]) === pending) return previous;
    const next = { ...previous }; if (pending) next[key] = true; else delete next[key]; return next;
  }), []);
  const changeParameter = useCallback((name: string, value: number) => setParameterEdits(previous => {
    const next = { ...previous }; if (value === document.parameters[name]) delete next[name]; else next[name] = value; return next;
  }), [document.parameters]);
  const markRelationEdited = useCallback((key: string) => setRelationEdits(previous => previous[key] ? previous : { ...previous, [key]: true }), []);
  const scalarContext = { parameters: effectiveDocument.parameters, acceptedScalars, relationEdits, valueDrafts, setValueDraft, setIssue, setRelationPending, markRelationEdited, changeParameter };
  const [error, setError] = useState<string | null>(null);
  const [capturedEdges, setCapturedEdges] = useState(feature.kind === 'fillet' || feature.kind === 'chamfer' ? feature.selection : null);
  const candidateEdits = useMemo(() => cadFeatureCandidateEdits({ feature: draft, isNew, parameters: parameterEdits }), [draft, isNew, parameterEdits]);
  useEffect(() => { draftSource.current = feature; setDraft(feature); setCapturedEdges(feature.kind === 'fillet' || feature.kind === 'chamfer' ? feature.selection : null); setParameterEdits({}); setValueDrafts({}); setRelationEdits({}); setError(null); setPicker(null); pickToken.current = null; regionStart.current = null; }, [feature, accepted]);
  useLayoutEffect(() => { onPendingChange(isNew || draftSource.current === feature && (changed || scalarPending || Boolean(pickCurrent) || depthGestureActive)); }, [isNew, feature, changed, scalarPending, pickCurrent, depthGestureActive, onPendingChange]);
  useLayoutEffect(() => { onReferencePick?.(pickCurrent ?? { kind: 'clear', owner: previewOwner }); }, [onReferencePick, pickCurrent, previewOwner]);
  useLayoutEffect(() => () => pickerCallback.current?.({ kind: 'clear', owner: previewOwner }), [previewOwner]);
  useLayoutEffect(() => {
    if (!onFeaturePreview || !documentVersion) return;
    if (!staleDraft && !areasMissing && draftSource.current === feature && previewEnabled && pickCurrent?.kind !== 'pick' && pickCurrent?.kind !== 'pick-topology' && (isNew || changed || scalarPending)) {
      onFeaturePreview(scalarPending
        ? { kind: 'blocked', owner: previewOwner, expectedVersion: documentVersion, edits: candidateEdits, message: Object.values(fieldIssues)[0] ?? 'Finish editing the relation before applying this feature.' }
        : { kind: 'candidate', owner: previewOwner, expectedVersion: documentVersion, edits: candidateEdits });
    }
    else onFeaturePreview({ kind: 'clear', owner: previewOwner });
  }, [candidateEdits, isNew, changed, scalarPending, areasMissing, fieldIssues, documentVersion, previewOwner, onFeaturePreview, previewEnabled, pickCurrent?.kind, staleDraft, feature]);
  useLayoutEffect(() => () => previewCallback.current?.({ kind: 'clear', owner: previewOwner }), [previewOwner]);
  const preview = featurePreview && featurePreview.kind !== 'idle' && featurePreview.owner === previewOwner && featurePreview.baseVersion === documentVersion ? featurePreview : null;
  const currentPreviewReady = useMemo(() => !scalarPending && preview?.kind === 'ready' && preview.definitionKey === cadFeatureCandidateKey(candidateEdits), [preview, candidateEdits, scalarPending]);
  const waitingForPreview = Boolean(onFeaturePreview && documentVersion && !currentPreviewReady);
  const depthModel = useMemo(() => {
    if (!onDepthInteractionReady || !documentVersion) return null;
    try { return inspectCadExtrudeDepth(effectiveDocument, draft); } catch { return null; }
  }, [onDepthInteractionReady, documentVersion, effectiveDocument, draft]);
  const depthState = useMemo<CadExtrudeDepthState | null>(() => {
    if (!depthModel) return null;
    const reason = staleDraft || draftSource.current !== feature ? 'The part changed. Cancel and reopen this feature.'
      : !previewEnabled || pickCurrent ? 'Finish the current selection or dialog first.'
        : scalarPending ? 'Finish editing Length or its relation first.'
          : !depthGestureActive && (isNew || changed) && waitingForPreview ? 'Wait for the current preview before dragging.' : null;
    return { model: depthModel, definitionKey: cadFeatureCandidateKey(candidateEdits), gestureActive: depthGestureActive,
      capability: reason ? { kind: 'locked', reason } : depthModel.capability };
  }, [depthModel, staleDraft, feature, previewEnabled, pickCurrent, scalarPending, depthGestureActive, isNew, changed, waitingForPreview, candidateEdits]);
  const depthSnapshot = { draft, parameterEdits, valueDrafts, fieldIssues, relationEdits, error };
  const depthEnvironment = useRef({ state: depthState, document, documentVersion, previewEnabled, pickCurrent, staleDraft, snapshot: depthSnapshot });
  depthEnvironment.current = { state: depthState, document, documentVersion, previewEnabled, pickCurrent, staleDraft, snapshot: depthSnapshot };
  const depthGesture = useRef<{ token: string; document: CadDocument; version: string; sketchId: string; snapshot: typeof depthSnapshot } | null>(null);
  const depthListeners = useRef(new Set<() => void>()), depthMounted = useRef(true);
  const restoreDepthSnapshot = useCallback((saved: typeof depthSnapshot) => {
    setDraft(saved.draft); setParameterEdits(saved.parameterEdits); setValueDrafts(saved.valueDrafts);
    setFieldIssues(saved.fieldIssues); setRelationEdits(saved.relationEdits); setError(saved.error);
  }, []);
  const depthControl = useMemo<CadExtrudeDepthControl>(() => {
    const baseVersion = documentVersion ?? '', featureId = feature.id;
    const current = () => {
      const env = depthEnvironment.current;
      return depthMounted.current && env.documentVersion === baseVersion && !env.staleDraft ? env : null;
    };
    const owns = (token: string) => {
      const env = current(), gesture = depthGesture.current;
      return env && gesture?.token === token && env.document === gesture.document && env.state?.model.sketchId === gesture.sketchId
        && env.previewEnabled && !env.pickCurrent ? { env, gesture } : null;
    };
    const finish = () => { depthGesture.current = null; setDepthGestureActive(false); };
    return { owner: previewOwner, featureId, baseVersion,
      subscribe(listener) { depthListeners.current.add(listener); return () => { depthListeners.current.delete(listener); }; },
      getState: () => current()?.state ?? null,
      begin(expectedDefinitionKey) {
        const env = current();
        if (!env?.state || env.state.definitionKey !== expectedDefinitionKey || env.state.capability.kind !== 'editable' || depthGesture.current) return null;
        const token = crypto.randomUUID();
        depthGesture.current = { token, document: env.document, version: baseVersion, sketchId: env.state.model.sketchId, snapshot: env.snapshot };
        setDepthGestureActive(true); return token;
      },
      setQuantity(token, quantityMm) {
        const owned = owns(token), env = owned?.env, candidate = env?.snapshot.draft;
        if (!env || candidate?.kind !== 'extrude') return false;
        const text = String(quantityMm); setValueDraft('distance', { source: candidate.distance, text });
        try {
          const quantity = parseCadNumericQuantity(text), intent = cadScalarValueIntent({ source: candidate.distance,
            parameters: { ...env.document.parameters, ...env.snapshot.parameterEdits }, quantity,
            acceptedSource: acceptedScalars.distance, relationEdited: env.snapshot.relationEdits.distance });
          if (intent.kind === 'locked') return false;
          setIssue('distance', null); setError(null);
          if (intent.kind === 'parameter') changeParameter(intent.name, intent.value);
          else if (intent.kind === 'scalar') { setValueDraft('distance', { source: intent.source, text }); setDraft({ ...candidate, distance: intent.source }); }
        } catch (cause) { setIssue('distance', userFacingMessage(cause, 'Invalid numeric value.')); }
        return true;
      },
      release(token) { if (!owns(token)) return false; finish(); return true; },
      cancel(token) {
        const owned = owns(token); if (!owned) return false;
        finish(); restoreDepthSnapshot(owned.gesture.snapshot); return true;
      }
    };
  }, [documentVersion, feature.id, previewOwner, setValueDraft, setIssue, changeParameter, acceptedScalars, restoreDepthSnapshot]);
  useLayoutEffect(() => {
    const gesture = depthGesture.current;
    if (gesture) {
      const sameSource = !staleDraft && gesture.document === document && gesture.version === documentVersion
        && draft.kind === 'extrude' && gesture.sketchId === draft.sketchId;
      if (!sameSource || !previewEnabled || pickCurrent || !depthModel) {
        depthGesture.current = null; setDepthGestureActive(false);
        if (sameSource) restoreDepthSnapshot(gesture.snapshot);
      }
    }
    depthListeners.current.forEach(listener => listener());
  }, [depthState, staleDraft, previewEnabled, pickCurrent, depthModel, document, documentVersion, draft, restoreDepthSnapshot]);
  useLayoutEffect(() => {
    onDepthInteractionReady?.(depthModel ? depthControl : null);
    return () => onDepthInteractionReady?.(null, depthControl);
  }, [onDepthInteractionReady, Boolean(depthModel), depthControl]);
  useLayoutEffect(() => { depthMounted.current = true; return () => { depthMounted.current = false; depthGesture.current = null; depthListeners.current.forEach(listener => listener()); }; }, []);
  const update = (next: CadFeature) => { setDraft(next); setError(null); };
  const featureIndex = document.features.findIndex((entry) => entry.id === feature.id);
  const preceding = featureIndex < 0 ? document.features : document.features.slice(0, featureIndex);
  const visibleIds = cadVisibleBodyIds(preceding, document);
  const bodies = preceding.filter((entry) => visibleIds.includes(entry.id) && (!isNew || !currentBodyIds || currentBodyIds.includes(entry.id))).map((entry) => ({ value: entry.id, label: entry.name }));
  const sketches = preceding.filter((entry) => entry.kind === 'sketch' && cadFeatureActive(entry, document)).map((entry) => ({ value: entry.id, label: entry.name }));
  const scalar = (fieldKey: string, label: string, value: CadScalar, onChange: (next: CadScalar) => void, unit?: string, inputLabel?: string) => <CadScalarEditContext.Provider key={fieldKey} value={scalarContext}><ScalarField fieldKey={fieldKey} label={label} inputLabel={inputLabel} value={value} parameters={effectiveDocument.parameters} onChange={onChange} unit={unit} /></CadScalarEditContext.Provider>;
  const body = (label: string, value: string, onChange: (next: string) => void) => {
    // A suppressed feature can retain unavailable inputs. Never let the native
    // select display its first available body as if it were the stored input.
    const options = value && !bodies.some(entry => entry.value === value)
      ? [{ value, label: `${document.features.find(entry => entry.id === value)?.name ?? 'Body'} (unavailable)`, disabled: true }, ...bodies]
      : bodies;
    return <SelectField reference label={label} value={value} options={options} onChange={onChange} />;
  };
  const topologyPicker = (target: Extract<CadFeature, { kind: 'fillet' | 'chamfer' | 'shell' }>) => !isNew && topologyPickingEnabled && onReferencePick && documentVersion
    ? <div className="cad-context-actions"><Button ref={topologyPickButton} type="button" data-cad-topology-pick={target.kind === 'shell' ? 'opening' : 'selection'} disabled={staleDraft || scalarPending || submission.applying || !visibleIds.includes(target.targetId)} onClick={() => {
      if (pickToken.current || depthGestureActive) return;
      const token = Symbol('topology-pick'); pickToken.current = token;
      pickerFocus.current = window.document.activeElement instanceof HTMLElement ? window.document.activeElement : null;
      setPicker({ kind: 'pick-topology', owner: previewOwner, expectedVersion: documentVersion, purpose: target.kind,
        label: target.kind === 'shell' ? 'Opening face' : 'Edges', request: { featureId: feature.id, bodyId: target.targetId, parameterValues: { ...parameterEdits } },
        onSelect(result) {
          const environment = pickEnvironment.current;
          if (pickToken.current !== token || environment.document !== document || environment.documentVersion !== documentVersion) return;
          if (result.bodyId !== target.targetId || result.purpose !== target.kind) throw new Error('The topology choice does not belong to this feature input.');
          if (result.purpose === 'shell' && target.kind === 'shell') update({ ...target, opening: result.opening });
          else if (result.purpose !== 'shell' && target.kind !== 'shell') { setCapturedEdges(result.selection); update({ ...target, selection: result.selection }); }
          endPick(token, true);
        }, onCancel: () => endPick(token) });
    }}><SelectIcon size={13} />{target.kind === 'shell' ? 'Choose opening' : 'Choose edges'}</Button></div> : null;
  // Kinds with a fields form are drawn from their definition's controls, in order; the parts below are drawn by their kind.
  const definition = cadFeatureDefinition(draft.kind), form = cadFeaturePresentation(draft.kind).form;
  const stored = (field: string) => (draft as unknown as Readonly<Record<string, unknown>>)[field];
  const store = (field: string, value: unknown) => update({ ...draft, [field]: value } as CadFeature);
  const edged = draft.kind === 'fillet' || draft.kind === 'chamfer' ? draft : null;
  const tangentId = `${previewOwner}-tangent`;
  const part = (name: CadFeatureFormPart): React.ReactNode => {
    const misplaced = () => { throw new Error(`The ${name} part does not belong to ${draft.kind} features.`); };
    switch (name) {
      case 'sketch-source': return draft.kind === 'revolve' ? <CadSketchSourceField document={effectiveDocument} sketches={sketches} purpose="revolve" sketchId={draft.sketchId} onChange={sketchId => update({ ...draft, sketchId })} /> : misplaced();
      case 'loft-sections': return draft.kind === 'loft' ? <CadLoftSections document={effectiveDocument} featureId={feature.id} sketchIds={draft.sketchIds} applyError={error} onChange={sketchIds => update({ ...draft, sketchIds })} /> : misplaced();
      case 'sweep-sources': return draft.kind === 'sweep' ? <CadSweepSources document={effectiveDocument} featureId={feature.id} applyError={error} sketchId={draft.sketchId} curveId={draft.curveId} onChange={sources => update({ ...draft, ...sources })} /> : misplaced();
      case 'edge-scope': {
        if (!edged) return misplaced();
        const { tangentPropagation: _tangent, ...strict } = edged;
        return <SelectField label="Scope" value={edged.selection ? 'selected' : 'all'} options={[
          { value: 'all', label: 'All edges of the body' },
          { value: 'selected', label: capturedEdges ? edged.tangentPropagation
            ? `${capturedEdges.expectedCount} ${capturedEdges.expectedCount === 1 ? 'edge' : 'edges'} + tangents` : `Selected edges (${capturedEdges.expectedCount})`
            : 'Selected edges, pick before starting', disabled: !capturedEdges },
        ]} onChange={scope => update(scope === 'selected' ? { ...edged, selection: capturedEdges } : { ...strict, selection: null })} />;
      }
      case 'topology-picker': return draft.kind === 'fillet' || draft.kind === 'chamfer' || draft.kind === 'shell' ? topologyPicker(draft) : misplaced();
      case 'tangent-chain': {
        if (!edged) return misplaced();
        const { tangentPropagation: _tangent, ...strict } = edged;
        return edged.selection && <><div className="cad-check"><Input id={tangentId} type="checkbox" aria-label="Follow tangent edges" checked={edged.tangentPropagation === true}
          onChange={event => update(event.target.checked ? { ...edged, tangentPropagation: true }
            : (feature.kind === 'fillet' || feature.kind === 'chamfer') && typeof feature.tangentPropagation === 'boolean' ? { ...edged, tangentPropagation: false } : strict)} />
          <label htmlFor={tangentId}>Follow tangent edges</label><CadContextHelp label="Follow tangent edges">
            Continue along smoothly connected edges using the native tangent chain. The selected count is your picked seeds; the operation also follows their chains, including split circular rims. Disconnected rims stay separate.
          </CadContextHelp></div><CadTopologyQuerySummary selection={edged.selection} /></>;
      }
      case 'opening-summary': return draft.kind === 'shell' ? <CadTopologyQuerySummary selection={draft.opening} /> : misplaced();
    }
  };
  const choices = (field: string, label: string, onChange: (value: unknown) => void) => {
    const declared = definition.fields[field]?.choices ?? [], value = stored(field), current = declared.find(choice => choice.value === value);
    return <SelectField label={label} value={current ? choiceKey(current) : String(value)} options={declared.map(choice => ({ value: choiceKey(choice), label: choice.label }))}
      onChange={key => onChange(declared.find(choice => choiceKey(choice) === key)?.value)} />;
  };
  const control = (entry: CadFeatureFormControl): React.ReactNode => {
    if (entry.control === 'part') return part(entry.part);
    const { field, label } = entry, value = stored(field);
    switch (entry.control) {
      case 'body': return body(label, (value as string | null) ?? '', next => store(field, next));
      case 'scalar': return scalar(field, label, value as CadScalar, next => store(field, next), entry.unit);
      case 'vector': {
        const vector = value as CadPoint3;
        return <VectorFields label={label} unit={entry.unit}>{entry.components.map((component, axis) => scalar(`${field}.${axis}`, component.label, vector[axis],
          next => store(field, vector.map((held, index) => index === axis ? next : held)), component.unit, component.inputLabel))}</VectorFields>;
      }
      case 'choice': return choices(field, label, next => store(field, next));
      case 'count': {
        const count = definition.fields[field]?.scalar;
        return <label className="cad-field"><span>{label}</span><Input type="number" min={String(count?.min)} max={String(count?.max)} value={value as number} onChange={(event) => store(field, Number(event.target.value))} /></label>;
      }
      case 'operation': {
        // The target is held only where the operation keeps one; choosing such an operation proposes the latest body.
        const target = stored(entry.target) as string | null, absentWhen = definition.fields[entry.target]?.condition?.absentWhen;
        return <>{choices(field, label, operation => update({ ...draft, [field]: operation, [entry.target]: operation === absentWhen ? null : target ?? bodies.at(-1)?.value ?? null } as CadFeature))}
          {value !== absentWhen && body(entry.targetLabel, target ?? '', next => store(entry.target, next))}</>;
      }
    }
  };
  let fields: React.ReactNode;
  if (form.editor === 'fields') fields = <>{form.controls.map((entry, index) => <Fragment key={index}>{control(entry)}</Fragment>)}</>;
  else switch (draft.kind) {
    case 'datum-plane': fields = <CadScalarEditContext.Provider value={scalarContext}><CadDatumPlaneFields feature={draft} parameters={effectiveDocument.parameters} onChange={update} /></CadScalarEditContext.Provider>; break;
    case 'imported': fields = <><dl className="cad-topology-details"><dt>Source file</dt><dd>{draft.source.fileName}</dd><dt>Format</dt><dd>{draft.source.format.toUpperCase()}</dd>{draft.source.format === 'stl' && <><dt>Source units</dt><dd>{draft.source.units === 'inch' ? 'inch' : 'mm'}</dd></>}</dl></>; break;
    case 'sketch': fields = <><CadPlacementField document={document} featureId={draft.id} plane={draft.plane} onChange={plane => update({ ...draft, plane })} />{scalar('offset', 'Plane offset', draft.offset, (offset) => update({ ...draft, offset }))}<CadPlacementNormal plane={draft.plane} document={effectiveDocument} />{draft.source && <dl className="cad-topology-details"><dt>Source file</dt><dd>{draft.source.fileName}</dd><dt>Source units</dt><dd>{draft.source.units ?? 'File declaration'}</dd></dl>}</>; break;
    case 'curve': fields = <><CadPlacementField document={document} featureId={draft.id} plane={draft.plane} onChange={plane => update({ ...draft, plane })} />{scalar('offset', 'Plane offset', draft.offset, offset => update({ ...draft, offset }))}<CadPlacementNormal plane={draft.plane} document={effectiveDocument} /><CadPathSegmentFields label="Curve" segments={draft.segments} parameters={effectiveDocument.parameters} onChange={segments => update({ ...draft, segments })} />{draft.source && <dl className="cad-topology-details"><dt>Source file</dt><dd>{draft.source.fileName}</dd><dt>Source units</dt><dd>{draft.source.units ?? 'File declaration'}</dd></dl>}</>; break;
    case 'extrude':
    case 'pocket': {
      if (feature.kind !== 'extrude' && feature.kind !== 'pocket') throw new Error('Extrude editor source changed.');
      fields = <CadScalarEditContext.Provider value={scalarContext}><CadExtrudeFields feature={draft} initialFeature={feature} revision={accepted} document={effectiveDocument} bodies={bodies} sketches={sketches} onChange={update} /></CadScalarEditContext.Provider>; break;
    }
    default: throw new Error(`${form.title} features have no editor of their own.`);
  }
  const pickingContext = useMemo<ContextType<typeof CadFeatureReferencePickingContext>>(() => {
    if (!onReferencePick || !documentVersion || staleDraft) return null;
    const owns = (token: symbol) => pickToken.current === token && pickEnvironment.current.document === document && pickEnvironment.current.documentVersion === documentVersion;
    const begin = () => {
      if (pickToken.current || depthGestureActive) return null;
      pickerFocus.current = window.document.activeElement instanceof HTMLElement ? window.document.activeElement : null;
      const token = Symbol('feature-pick'); pickToken.current = token; return token;
    };
    return { precedingIds: new Set(preceding.map(feature => feature.id)),
      begin(label: string, eligibleIds: readonly string[], onSelect: (id: string) => void) {
        const token = begin(); if (!token) return;
        setPicker({ kind: 'pick', owner: previewOwner, expectedVersion: documentVersion, label, eligibleIds,
          onSelect(id) { if (!owns(token) || !eligibleIds.includes(id)) return; onSelect(id); endPick(token, true); }, onCancel: () => endPick(token) });
      },
      beginRegions(sketchId, cells, placement, selection, onSelect) {
        if ((draft.kind !== 'extrude' && draft.kind !== 'pocket') || draft.sketchId !== sketchId || !preceding.some(feature => feature.id === sketchId && feature.kind === 'sketch' && cadFeatureActive(feature, document))) return;
        const token = begin(); if (!token) return;
        regionStart.current = { feature: draft, document, version: documentVersion };
        setPicker({ kind: 'pick-regions', owner: previewOwner, expectedVersion: documentVersion, label: 'Sketch areas', sketchId, cells, placement, selection,
          onSelect(next) {
            if (!owns(token)) return;
            onSelect(next); setPicker(previous => previous?.kind === 'pick-regions' ? { ...previous, selection: next } : previous);
          }, onFinish: () => { if (owns(token)) endPick(token, true); }, onCancel: () => endPick(token) });
      }
    };
  }, [onReferencePick, documentVersion, staleDraft, preceding, depthGestureActive, previewOwner, document, draft]);
  return <form hidden={pickCurrent?.kind === 'pick-topology'} className="cad-property-form" aria-busy={submission.applying || undefined} onKeyDown={event => { if (pickCurrent && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); endPick(); } }} onSubmit={(event) => { event.preventDefault(); if (pickCurrent || staleDraft || scalarPending || areasMissing || depthGestureActive || submission.applying) return; if (waitingForPreview) { setError('Wait for a valid preview of this edit.'); return; } submission.submit(signal => onApply(draft, parameterEdits, signal), () => setError(null), cause => setError(userFacingMessage(cause, 'Unable to apply this feature.'))); }}>
    <CadInspectorTitle>{isNew ? 'Create' : 'Edit'} {featureLabels[draft.kind].toLowerCase()}<CadContextHelp label={featureLabels[draft.kind]}>{cadFeatureHelp[draft.kind]}</CadContextHelp></CadInspectorTitle>
    <fieldset className="cad-feature-fields" disabled={Boolean(pickCurrent) || staleDraft || depthGestureActive || submission.applying}>
    <CadFeatureReferencePickingContext.Provider value={pickingContext}>{fields}</CadFeatureReferencePickingContext.Provider></fieldset>
    {pickCurrent?.kind === 'pick' && <div className="cad-reference-pick-status" role="status">Pick {pickCurrent.label.toLowerCase()} in the model or history<Button type="button" aria-label="Cancel source selection" onClick={() => endPick()}><CloseIcon size={13} /></Button></div>}
    {preview?.kind === 'error' && <p className="cad-error" role="alert">{preview.message}</p>}
    {error && <p className="cad-error" role="alert">{error}</p>}
    {staleDraft && <p className="cad-error" role="alert">The part changed. Cancel this edit and reopen the current feature.</p>}
    {areasMissing && !pickCurrent && !staleDraft && <div className="cad-form-hint" role="status">Choose the closed areas to {draft.kind === 'pocket' ? 'cut' : 'pad'} before Apply</div>}
    {(isNew || changed || scalarPending || staleDraft || depthGestureActive) && <div className="cad-form-actions"><Button type="button" onClick={cancel}><CloseIcon size={13} /> Cancel</Button><Button variant="primary" type="submit" className="cad-primary" disabled={!isNew && !changed || scalarPending || areasMissing || waitingForPreview || Boolean(pickCurrent) || staleDraft || depthGestureActive || submission.applying}><ConfirmIcon size={13} /> Apply</Button></div>}
  </form>;
}

export function CadProfileEditor({ profile, document, onApply, onCancel, onPendingChange, onInspectInput, onPreviewProfile, onPreviewParameters, onPrepareEdits, onPreviewDocument }: {
  profile: CadSketchProfile;
  document: CadDocument;
  onApply(profile: CadSketchProfile, parameters: Readonly<Record<string, number>>, signal?: AbortSignal): CadEditCompletion;
  onCancel(): void;
  onPendingChange(pending: boolean): void;
  onInspectInput?(name: string | null): void;
  onPreviewProfile?(profile: CadSketchProfile | null): void;
  onPreviewParameters?(parameters: CadDocument['parameters'] | null): void;
  onPrepareEdits?: CadPrepareEdits;
  onPreviewDocument?(document: CadDocument | null, marks?: CadSketchDiagnosisMarks | null): void;
}) {
  const submission = useCadEditSubmission();
  const [draft, setDraft] = useState(profile);
  const [changed, setChanged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parameterDrafts, setParameterDrafts] = useState<Record<string, string>>({});
  const [bindingPending, setBindingPending] = useState(false);
  // Each revision of the part that holds the profile accepts it again, also where it kept its object.
  const baseline = useRef({ profile, document });
  if (baseline.current.profile !== profile || baseline.current.document !== document
    && document.features.some(feature => feature.kind === 'sketch' && feature.profiles.includes(profile))) baseline.current = { profile, document };
  const accepted = baseline.current;
  useEffect(() => { setDraft(profile); setChanged(false); setError(null); setParameterDrafts({}); }, [profile, accepted]);
  useLayoutEffect(() => { onPendingChange(changed || bindingPending); }, [changed, bindingPending, onPendingChange]);
  const update = (next: CadSketchProfile) => { setDraft(next); setChanged(true); setError(null); };
  const parameterEdits = useMemo(() => Object.fromEntries(Object.entries(parameterDrafts).filter(([, text]) => text.trim() && Number.isFinite(Number(text)) && Math.abs(Number(text)) <= 1e9).map(([name, text]) => [name, Number(text)])), [parameterDrafts]);
  const effectiveParameters = useMemo(() => ({ ...document.parameters, ...parameterEdits }), [document.parameters, parameterEdits]);
  const parameterIssues = Object.entries(parameterDrafts).filter(([name]) => !Object.hasOwn(parameterEdits, name)).map(([name]) => `Parameter ${name} needs a finite numeric value.`);
  const scalar = (label: string, value: CadScalar, onChange: (next: CadScalar) => void, unit?: string) => <ScalarField label={label} value={value} parameters={effectiveParameters} onChange={onChange} unit={unit} />;
  const geometry = draft.geometry;
  const pluginInspection = useMemo(() => geometry.kind === 'plugin' ? inspectCadPluginProfile(geometry, effectiveParameters) : undefined, [geometry, effectiveParameters]);
  const pluginIssues = [...pluginInspection?.issues ?? [], ...parameterIssues];
  const previewValid = useMemo(() => { if (pluginInspection) return !pluginInspection.issues.length; try { resolveCadProfile(geometry, effectiveParameters); return true; } catch { return false; } }, [geometry, effectiveParameters, pluginInspection]);
  const previewEdits = useMemo(() => {
    const owner = document.features.find(feature => feature.kind === 'sketch' && feature.profiles.includes(profile));
    return owner?.kind === 'sketch' ? cadFeatureCandidateEdits({ feature: { ...owner, profiles: owner.profiles.map(entry => entry.id === profile.id ? draft : entry) }, isNew: false, parameters: parameterEdits }) : null;
  }, [document, profile, draft, parameterEdits]);
  const preparedPreview = useCadPreparedPreview(document, previewEdits, onPrepareEdits, changed && !bindingPending && !pluginIssues.length && previewValid && !submission.applying);
  useLayoutEffect(() => {
    const candidate = preparedPreview.kind === 'ready' ? preparedPreview.document : null;
    onPreviewDocument?.(candidate, cadPreviewMarks(preparedPreview));
    const preview = !onPreviewDocument && changed && draft.id === profile.id && !pluginIssues.length && previewValid && !document.features.some(feature => feature.kind === 'sketch' && feature.graph);
    onPreviewProfile?.(preview ? draft : null); onPreviewParameters?.(preview ? effectiveParameters : null);
    return () => { onPreviewDocument?.(null); onPreviewProfile?.(null); onPreviewParameters?.(null); };
  }, [preparedPreview, document, draft, changed, profile.id, pluginIssues.length, previewValid, effectiveParameters, onPreviewDocument, onPreviewProfile, onPreviewParameters]);
  const profileOptions = <><label className="cad-field"><span>Name</span><Input value={draft.name} onChange={(event) => update({ ...draft, name: event.target.value })} /></label>
    <label className="cad-check"><Input type="checkbox" checked={draft.construction} onChange={(event) => update({ ...draft, construction: event.target.checked })} /> Construction geometry</label></>;
  let fields: React.ReactNode;
  switch (geometry.kind) {
    case 'plugin': fields = <CadPluginFields profile={geometry} parameters={effectiveParameters} parameterDrafts={parameterDrafts} onBindingPendingChange={setBindingPending} onChangeParameter={(name, value) => { setParameterDrafts(current => ({ ...current, [name]: value })); setChanged(true); setError(null); }} inspection={pluginInspection} onInspectInput={onInspectInput} onChange={geometry => update({ ...draft, geometry })} />; break;
    case 'rectangle': fields = <>{scalar('Origin X', geometry.x, (x) => update({ ...draft, geometry: { ...geometry, x } }))}{scalar('Origin Y', geometry.y, (y) => update({ ...draft, geometry: { ...geometry, y } }))}{scalar('Width', geometry.width, (width) => update({ ...draft, geometry: { ...geometry, width } }))}{scalar('Height', geometry.height, (height) => update({ ...draft, geometry: { ...geometry, height } }))}{scalar('Corner radius', geometry.cornerRadius, (cornerRadius) => update({ ...draft, geometry: { ...geometry, cornerRadius } }))}</>; break;
    case 'circle': fields = <>{scalar('Center X', geometry.x, (x) => update({ ...draft, geometry: { ...geometry, x } }))}{scalar('Center Y', geometry.y, (y) => update({ ...draft, geometry: { ...geometry, y } }))}{scalar('Radius', geometry.radius, (radius) => update({ ...draft, geometry: { ...geometry, radius } }))}</>; break;
    case 'slot': fields = <>{scalar('Center X', geometry.x, (x) => update({ ...draft, geometry: { ...geometry, x } }))}{scalar('Center Y', geometry.y, (y) => update({ ...draft, geometry: { ...geometry, y } }))}{scalar('Length', geometry.length, (length) => update({ ...draft, geometry: { ...geometry, length } }))}{scalar('Width', geometry.width, (width) => update({ ...draft, geometry: { ...geometry, width } }))}{scalar('Angle', geometry.angle, (angle) => update({ ...draft, geometry: { ...geometry, angle } }), 'deg')}</>; break;
    case 'polygon': fields = <CadPolygonVertexFields points={geometry.points} parameters={document.parameters} onChange={points => update({ ...draft, geometry: { ...geometry, points } })} />; break;
    case 'path': fields = <CadPathSegmentFields segments={geometry.segments} parameters={document.parameters} onChange={segments => update({ ...draft, geometry: { ...geometry, segments } })} />; break;
  }
  return <form className={`cad-property-form ${geometry.kind === 'plugin' ? 'cad-plugin-form' : ''}`} aria-busy={submission.applying || undefined} onSubmit={(event) => {
    event.preventDefault();
    if (pluginIssues.length || submission.applying) return;
    const { role: _legacyRole, ...next } = draft;
    submission.submit(signal => onApply(next, parameterEdits, signal), () => { setChanged(false); setError(null); setParameterDrafts({}); }, cause => {
      setError(cause instanceof CadError && cause.code === 'open-profile'
        ? `${cause.message} Match adjacent endpoints, including the last and first segment, before applying.`
        : userFacingMessage(cause, 'Unable to apply this profile.'));
    });
  }}>
    <CadInspectorTitle>{geometry.kind === 'plugin' ? geometry.package.name : `${geometry.kind[0].toUpperCase()}${geometry.kind.slice(1)} profile`}</CadInspectorTitle>
    <fieldset className="cad-feature-fields" disabled={submission.applying}>
    {geometry.kind !== 'plugin' && profileOptions}
    {fields}
    {geometry.kind === 'plugin' && <details className="cad-plugin-disclosure cad-plugin-profile-options"><summary>Profile options</summary>{profileOptions}</details>}
    </fieldset>
    {pluginIssues.length > 0 && <div role="alert" className="cad-error">{pluginIssues.map((issue, index) => <p key={index}>{issue}</p>)}</div>}
    {error && <p role="alert" className="cad-error">{error}</p>}
    {!error && preparedPreview.kind === 'error' && <div className="cad-form-hint" role="status"><span>Preview unavailable</span><CadContextHelp label="Preview unavailable">{preparedPreview.message}</CadContextHelp></div>}
    {changed && <div className="cad-form-actions"><Button type="button" onClick={() => { submission.cancel(); onCancel(); }}><CloseIcon size={13} /> Cancel</Button><Button variant="primary" type="submit" className="cad-primary" disabled={!changed || bindingPending || pluginIssues.length > 0 || submission.applying}><ConfirmIcon size={13} /> Apply</Button></div>}
  </form>;
}
