import { userFacingMessage } from '@/lib/userMessage';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CloseIcon, ConfirmIcon, FilletIcon, LinkIcon, MeasureIcon, MoveIcon } from '@wire-edm/icons-react';
import type { CadDocument, CadScalar, CadSketchFeature, CadSketchProfile } from '@/domain/cad/cadDocument';
import { reduceCadEditIntents, type CadEdit } from '@/domain/cad/cadOperations';
import { needsCadSketchPreparation } from './cadEditPreparation';
import { evaluateCadScalar } from '@/domain/cad/cadExpression';
import { addCadSketchDimension, cadSketchDimensionQuantities, cadSketchDimensionScalar, inspectCadSketchDimensions, setCadSketchDimensionValue, type CadSketchDimensionQuantity } from '@/domain/cad/cadSketchConstraints';
import { cadSketchProfileEdits, cadSketchProfileGenerator, cadSketchProfileViews } from '@/domain/cad/sketch-generators/cadSketchProfileViews';
import { formatCadQuantity } from './cadDisplayQuantity';
import { CadContextHelp } from './CadContextHelp';
import { useCadEditSubmission, type CadEditCompletion } from './useCadEditSubmission';
import { cadPreviewMarks, useCadPreparedPreview, type CadPrepareEdits } from './useCadPreparedPreview';
import { cadGeneratorRemovals } from './cadGeneratorRemovals';
import { useCadGeneratorRemovalConfirmation } from './useCadGeneratorRemovalConfirmation';
import type { CadSketchDiagnosisMarks } from './cadSketchDefinitionMarks';
import './cad-sketch-profile.css';

export type CadSketchProfileCommand = { readonly token: number; readonly documentId: string; readonly profileId: string; readonly kind: 'dimension' | 'move' | 'fillet' };
type Editor = { kind: 'dimension'; quantity: CadSketchDimensionQuantity; id: string; isNew: boolean; mode: 'value' | 'expression'; value: string; initial: string }
  | { kind: 'move'; x: string; y: string }
  | { kind: 'fillet'; mode: 'value' | 'expression'; value: string; initial: string };
const title = (quantity: string) => quantity[0].toUpperCase() + quantity.slice(1);
const scalarText = (text: string): CadScalar => text.trim() && Number.isFinite(Number(text)) ? Number(text) : text.trim();

/**
 * Compact authoring intent for ordinary contours. A generated shape's view keeps its configuration editor, and this panel shows only the
 * Move contour or Sketch fillet editor its `command` opens. A move translates the view, which writes it back to the generator's inputs;
 * a fillet writes the rounded view back as one set-sketch-generator edit, or sets the parameter its corner radius reads. It calls
 * `onClose` when that editor closes or cannot open.
 */
export function CadSketchProfilePanel({ document: cadDocument, sketch, profile, onEditMany, onPendingChange, onPreviewProfile, onPreviewParameters, onPrepareEdits, onPreviewDocument, interactionLocked, otherEditorPending = false, cancelSignal, command, onCommandConsumed, onClose, exactGeometryEditor }: {
  document: CadDocument; sketch: CadSketchFeature; profile: CadSketchProfile;
  onEditMany(edits: readonly CadEdit[], signal?: AbortSignal): CadEditCompletion; onPendingChange(pending: boolean): void;
  onPreviewProfile?(profile: CadSketchProfile | null): void; onPreviewParameters?(parameters: CadDocument['parameters'] | null): void;
  onPrepareEdits?: CadPrepareEdits; onPreviewDocument?(document: CadDocument | null, marks?: CadSketchDiagnosisMarks | null): void;
  interactionLocked: boolean; otherEditorPending?: boolean; cancelSignal: number; command?: CadSketchProfileCommand | null; onCommandConsumed?(token: number): void; onClose?(): void; exactGeometryEditor?: ReactNode;
}) {
  const generated = Boolean(cadSketchProfileGenerator(sketch, profile.id));
  const [editor, setEditor] = useState<Editor | null>(null), [error, setError] = useState<string | null>(null);
  const submission = useCadEditSubmission();
  const captured = useRef<CadDocument | null>(null), previousCommand = useRef(0), previousCancel = useRef(cancelSignal), pendingCallback = useRef(onPendingChange);
  const input = useRef<HTMLInputElement>(null);
  const blocked = interactionLocked || submission.applying || otherEditorPending && !editor;
  const dimensions = useMemo(() => inspectCadSketchDimensions(profile, cadDocument.parameters), [profile, cadDocument.parameters]);
  const available = cadSketchDimensionQuantities(profile.geometry).filter(quantity => !dimensions.some(dimension => dimension.field === (quantity === 'diameter' ? 'radius' : quantity)));
  const close = () => { submission.cancel(); setEditor(null); setError(null); captured.current = null; onClose?.(); };
  /** The edits that write `next` back: a generator's inputs, or the saved profile it replaces. */
  const written = (next: CadSketchProfile): CadEdit[] => generated ? cadSketchProfileEdits(sketch, next)
    : [{ kind: 'update-feature', feature: { ...sketch, profiles: sketch.profiles.map(entry => entry.id === profile.id ? next : entry) } }];
  const dimensionEditor = (quantity: CadSketchDimensionQuantity): Extract<Editor, { kind: 'dimension' }> => {
    const dimension = dimensions.find(entry => entry.field === (quantity === 'diameter' ? 'radius' : quantity));
    const selected = dimension?.quantity ?? quantity;
    const value = String(evaluateCadScalar(cadSketchDimensionScalar(profile, selected), cadDocument.parameters) * (selected === 'diameter' ? 2 : 1));
    return { kind: 'dimension', quantity: selected, id: dimension?.id ?? crypto.randomUUID(), isNew: !dimension, mode: 'value', value, initial: value };
  };
  /** Opens the editor for `kind`; false when it cannot open. A generator's sizes are its inputs, so it has no dimension editor here. */
  const begin = (kind: CadSketchProfileCommand['kind']) => {
    if (blocked || editor) return false;
    let next: Editor;
    if (kind === 'dimension') { if (generated || !available[0]) return false; next = dimensionEditor(available[0]); }
    else if (kind === 'fillet') {
      if (profile.geometry.kind !== 'rectangle') return false;
      const value = String(evaluateCadScalar(profile.geometry.cornerRadius, cadDocument.parameters)); next = { kind, mode: 'value', value, initial: value };
    } else next = { kind, x: '0', y: '0' };
    captured.current = cadDocument; setError(null); setEditor(next);
    return true;
  };
  useLayoutEffect(() => { pendingCallback.current = onPendingChange; onPendingChange(editor !== null || submission.applying); }, [editor !== null, submission.applying, onPendingChange]);
  useLayoutEffect(() => { if (editor) input.current?.focus(); }, [editor?.kind]);
  // Release ownership before a replacement editor publishes its pending state.
  useLayoutEffect(() => () => pendingCallback.current(false), []);
  useEffect(() => { if (previousCancel.current !== cancelSignal) { previousCancel.current = cancelSignal; close(); } }, [cancelSignal]);
  useEffect(() => { if (command && command.documentId === cadDocument.id && command.profileId === profile.id && previousCommand.current !== command.token) { previousCommand.current = command.token; const opened = begin(command.kind); onCommandConsumed?.(command.token); if (!opened && generated) onClose?.(); } }, [command]);
  const built = useMemo(() => {
    if (!editor) return { edits: null, issue: null };
    try {
      if (captured.current !== cadDocument) throw new Error('The part changed. Cancel and reopen this edit.');
      const edits: CadEdit[] = [];
      const changedScalar = (scalar: CadScalar, text: string, scale: number, ...literalEdits: CadEdit[]) => {
        if (typeof scalar === 'string' && !Number.isFinite(Number(scalar))) {
          if (!Object.hasOwn(cadDocument.parameters, scalar.trim())) throw new Error('This value follows an expression. Edit its linked parameters.');
          const value = evaluateCadScalar(scalarText(text), cadDocument.parameters) / scale;
          edits.push({ kind: 'set-parameter', name: scalar.trim(), value });
        } else edits.push(...literalEdits);
      };
      if (editor.kind === 'move') {
        const dx = Number(editor.x), dy = Number(editor.y);
        if (!editor.x.trim() || !editor.y.trim() || !Number.isFinite(dx) || !Number.isFinite(dy)) throw new Error('Enter finite movement distances.');
        // A generator's view moves by the same edit, which writes the moved view back to its inputs.
        if (dx || dy) edits.push({ kind: 'translate-sketch-profiles', sketchId: sketch.id, profileIds: [profile.id], translation: [dx, dy] });
      } else if (editor.kind === 'dimension') {
        if (editor.isNew) edits.push({ kind: 'add-sketch-dimension', sketchId: sketch.id, profileId: profile.id, constraint: { id: editor.id, kind: 'dimension', quantity: editor.quantity } });
        if (editor.value !== editor.initial) {
          const scalar = cadSketchDimensionScalar(profile, editor.quantity), value = scalarText(editor.value);
          if (editor.mode === 'expression') {
            const constrained = profile.constraints?.some(constraint => constraint.id === editor.id) ? profile : addCadSketchDimension({ profile, constraint: { id: editor.id, kind: 'dimension', quantity: editor.quantity } });
            const nextProfile = setCadSketchDimensionValue({ profile: constrained, quantity: editor.quantity, value });
            edits.push({ kind: 'update-feature', feature: { ...sketch, profiles: sketch.profiles.map(entry => entry.id === profile.id ? nextProfile : entry) } });
          } else if (typeof value !== 'number' || value !== Number(editor.initial)) {
            // A value read from a parameter sets the parameter, as the dimension would, with an edit that can confirm the relations it removes.
            const parameterBound = typeof scalar === 'string' && Object.hasOwn(cadDocument.parameters, scalar.trim());
            if (!parameterBound && (profile.constraints?.some(constraint => constraint.id === editor.id) || editor.isNew)) edits.push({ kind: 'set-sketch-dimension', sketchId: sketch.id, profileId: profile.id, dimensionId: editor.id, value });
            else changedScalar(scalar, editor.value, editor.quantity === 'diameter' ? 2 : 1, { kind: 'set-sketch-dimension', sketchId: sketch.id, profileId: profile.id, dimensionId: editor.id, value });
          }
        }
      } else if (profile.geometry.kind === 'rectangle' && editor.value !== editor.initial) {
        const value = scalarText(editor.value);
        if (editor.mode === 'expression' || typeof value !== 'number' || value !== Number(editor.initial)) {
          const nextProfile = { ...profile, geometry: { ...profile.geometry, cornerRadius: value } };
          if (editor.mode === 'expression') edits.push(...written(nextProfile));
          else changedScalar(profile.geometry.cornerRadius, editor.value, 1, ...written(nextProfile));
        }
      }
      return { edits, issue: null };
    } catch (cause) { return { edits: null, issue: userFacingMessage(cause, 'Invalid sketch edit.') }; }
  }, [editor, cadDocument, sketch, profile]);
  // A parameter change that removes relations as a generator regenerates asks first; the next Apply removes them in the same edit.
  const confirmation = useCadGeneratorRemovalConfirmation(cadDocument, built.edits), { hold } = confirmation;
  const candidate = useMemo(() => {
    const edits = confirmation.edits;
    if (!edits) return { ...built, requiresSolve: false };
    const requiresSolve = needsCadSketchPreparation(cadDocument, edits);
    try {
      if (edits.length) reduceCadEditIntents(cadDocument, edits);
      return { edits, issue: null, requiresSolve };
    } catch (cause) {
      const removals = cadGeneratorRemovals(cause);
      return removals ? { edits, issue: null, requiresSolve, removals } : { edits: null, issue: userFacingMessage(cause, 'Invalid sketch edit.'), requiresSolve: false };
    }
  }, [built, confirmation.edits, cadDocument]);
  const preparedPreview = useCadPreparedPreview(cadDocument, candidate.edits, onPrepareEdits, Boolean(editor && !submission.applying));
  const found = 'removals' in candidate ? candidate.removals : preparedPreview.kind === 'error' ? preparedPreview.removals : undefined;
  useEffect(() => { hold(found); }, [found, hold]);
  const candidateIssue = candidate.issue ?? confirmation.issue ?? (preparedPreview.kind === 'error' && !preparedPreview.removals ? preparedPreview.message : null);
  useLayoutEffect(() => {
    const document = preparedPreview.kind === 'ready' ? preparedPreview.document : null;
    const nextSketch = document?.features.find(entry => entry.id === sketch.id), nextProfile = nextSketch?.kind === 'sketch' ? cadSketchProfileViews(nextSketch).find(entry => entry.id === profile.id) : null;
    const preview = Boolean(editor && candidate.edits?.length && nextProfile);
    onPreviewDocument?.(preview ? document : null, editor ? cadPreviewMarks(preparedPreview) : null);
    const legacy = preview && !onPreviewDocument && !candidate.requiresSolve;
    onPreviewProfile?.(legacy ? nextProfile ?? null : null); onPreviewParameters?.(legacy ? document?.parameters ?? null : null);
    return () => { onPreviewDocument?.(null); onPreviewProfile?.(null); onPreviewParameters?.(null); };
  }, [preparedPreview, candidate.edits, candidate.requiresSolve, editor !== null, profile.id, sketch.id, onPreviewDocument, onPreviewProfile, onPreviewParameters]);
  /** Applies `edits`; a refusal of the editor's edits `asked` for the relations they remove asks for them as the preview would. */
  const commit = (edits: readonly CadEdit[], accepted = close, asked?: readonly CadEdit[] | null) => submission.submit(signal => edits.length ? onEditMany(edits, signal) : undefined, accepted,
    cause => { if (!asked || !hold(cadGeneratorRemovals(cause), asked)) setError(userFacingMessage(cause, 'Unable to apply this sketch edit.')); });
  const activeExpression = editor?.kind === 'dimension' ? cadSketchDimensionScalar(profile, editor.quantity) : editor?.kind === 'fillet' && profile.geometry.kind === 'rectangle' ? profile.geometry.cornerRadius : null;
  const expressionDriven = typeof activeExpression === 'string' && !Number.isFinite(Number(activeExpression));
  const compoundDriven = expressionDriven && !Object.hasOwn(cadDocument.parameters, activeExpression.trim());
  const unlink = () => {
    if (blocked || !editor || editor.kind === 'move') return;
    try {
      if (captured.current !== cadDocument) throw new Error('The part changed. Cancel and reopen this edit.');
      let next: CadSketchProfile;
      if (editor.kind === 'dimension') {
        const quantity = editor.quantity, value = evaluateCadScalar(cadSketchDimensionScalar(profile, quantity), cadDocument.parameters) * (quantity === 'diameter' ? 2 : 1);
        const constrained = profile.constraints?.some(constraint => constraint.id === editor.id) ? profile : addCadSketchDimension({ profile, constraint: { id: editor.id, kind: 'dimension', quantity } });
        next = setCadSketchDimensionValue({ profile: constrained, quantity, value });
      } else {
        if (profile.geometry.kind !== 'rectangle') return;
        next = { ...profile, geometry: { ...profile.geometry, cornerRadius: evaluateCadScalar(profile.geometry.cornerRadius, cadDocument.parameters) } };
      }
      commit(written(next));
    } catch (cause) { setError(userFacingMessage(cause, 'Unable to unlink this expression.')); }
  };
  const remove = (id: string) => { if (blocked || editor) return; commit([{ kind: 'remove-sketch-dimension', sketchId: sketch.id, profileId: profile.id, dimensionId: id }], () => setError(null)); };
  // A generated shape's view shows the editor its command opened, and its configuration editor otherwise.
  if (generated && !editor) return null;
  return <div className="cad-sketch-profile-panel" onKeyDown={event => { if (event.key === 'Escape' && editor) { event.preventDefault(); event.stopPropagation(); close(); } }}>
    {!generated && <div className="cad-sketch-profile-heading"><strong>{profile.name}</strong><span>{dimensions.length ? `${dimensions.length} driving ${dimensions.length === 1 ? 'dimension' : 'dimensions'}` : 'Free geometry'}</span><CadContextHelp label="Sketch constraints">Dimensions fix the selected size or angle. Placement stays movable unless its coordinates follow an expression. Add a dimension from the tool dock or this panel, then edit its annotation on the sketch.</CadContextHelp></div>}
    {!editor && <>
      <div className="cad-sketch-profile-actions"><Button type="button" aria-label="Add dimension" title="Constrain a size or angle" disabled={blocked || !available.length} onClick={() => begin('dimension')}><MeasureIcon size={14} /> Dimension</Button><Button type="button" aria-label="Move profile" title="Move the contour without changing its dimensions" disabled={blocked} onClick={() => begin('move')}><MoveIcon size={14} /> Move</Button>{profile.geometry.kind === 'rectangle' && <Button type="button" aria-label="Sketch fillet" title="Round all four corners" disabled={blocked} onClick={() => begin('fillet')}><FilletIcon size={14} /> Fillet</Button>}</div>
      {dimensions.length > 0 && <ul className="cad-sketch-constraint-list" aria-label="Driving dimensions">{dimensions.map(dimension => <li key={dimension.field}><Button type="button" aria-label={`Configure ${title(dimension.quantity)} dimension`} disabled={blocked} onClick={() => { captured.current = cadDocument; setEditor(dimensionEditor(dimension.quantity)); }}>{title(dimension.quantity)}<span>{formatCadQuantity(dimension.value)} {dimension.units === 'deg' ? '°' : 'mm'}</span>{dimension.source === 'expression' || typeof dimension.expression === 'string' && !Number.isFinite(Number(dimension.expression)) ? <LinkIcon size={11} /> : null}</Button>{dimension.id && <Button type="button" aria-label={`Remove ${title(dimension.quantity)} dimension`} title="Release the dimension and retain the shape" disabled={blocked} onClick={() => remove(dimension.id!)}><CloseIcon size={12} /></Button>}</li>)}</ul>}
      <label className="cad-check"><Input type="checkbox" checked={profile.construction} disabled={blocked} onChange={event => commit([{ kind: 'update-feature', feature: { ...sketch, profiles: sketch.profiles.map(entry => entry.id === profile.id ? { ...entry, construction: event.target.checked } : entry) } }], () => setError(null))} /> Construction</label>
      {exactGeometryEditor && <details className="cad-plugin-disclosure"><summary>Exact geometry</summary>{exactGeometryEditor}</details>}
    </>}
    {editor && <form className="cad-sketch-intent-editor" aria-busy={submission.applying || undefined} aria-label={editor.kind === 'dimension' ? 'Driving dimension' : editor.kind === 'move' ? 'Move contour' : 'Sketch fillet'} onSubmit={event => { event.preventDefault(); if (blocked || !candidate.edits) return; commit(candidate.edits, close, built.edits); }}>
      <fieldset className="cad-feature-fields" disabled={submission.applying}>
      {editor.kind === 'dimension' ? <><label><span>Dimension</span>{editor.isNew ? <Select aria-label="Dimension quantity" value={editor.quantity} disabled={interactionLocked} onChange={event => { const quantity = available.find(entry => entry === event.target.value); if (quantity) setEditor({ ...dimensionEditor(quantity), id: editor.id }); }}>{available.map(quantity => <option key={quantity} value={quantity}>{title(quantity)}</option>)}</Select> : <strong>{title(editor.quantity)}</strong>}</label><label><span>{editor.mode === 'expression' ? 'Expression' : 'Value'}</span><Input ref={input} aria-label={editor.mode === 'expression' ? 'Dimension expression' : 'Dimension value'} disabled={interactionLocked || editor.mode === 'value' && compoundDriven} spellCheck={false} value={editor.value} onChange={event => { setError(null); setEditor({ ...editor, value: event.target.value }); }} /><small>{editor.quantity === 'angle' ? '°' : 'mm'}</small></label></>
        : editor.kind === 'move' ? <div className="cad-placement-row"><label><span>ΔX</span><Input ref={input} aria-label="Move X" value={editor.x} disabled={interactionLocked} onChange={event => setEditor({ ...editor, x: event.target.value })} /></label><label><span>ΔY</span><Input aria-label="Move Y" value={editor.y} disabled={interactionLocked} onChange={event => setEditor({ ...editor, y: event.target.value })} /></label><small>mm</small></div>
        : <label><span>Radius <CadContextHelp label="Sketch fillet radius">One tangent radius rounds all four corners of this rectangle. It cannot exceed half the smaller side. This contour operation is separate from the generating cutter radius of a gear.</CadContextHelp></span><Input ref={input} aria-label={editor.mode === 'expression' ? 'Fillet expression' : 'Fillet radius'} disabled={interactionLocked || editor.mode === 'value' && compoundDriven} value={editor.value} spellCheck={false} onChange={event => setEditor({ ...editor, value: event.target.value })} /><small>mm</small></label>}
      {editor.kind !== 'move' && (editor.kind === 'fillet' || !editor.isNew) && <div className="cad-sketch-relation"><Button type="button" disabled={interactionLocked} onClick={() => { if (activeExpression === null) return; const value = editor.kind === 'dimension' && editor.quantity === 'diameter' ? '(' + activeExpression + ') * 2' : String(activeExpression); setError(null); setEditor({ ...editor, mode: 'expression', value, initial: value }); }}>Edit expression</Button>{expressionDriven && <Button type="button" disabled={interactionLocked} onClick={unlink}>Unlink expression</Button>}<CadContextHelp label="Sketch relation">Value editing retains a shared parameter link. Edit expression explicitly changes this contour's relation. Unlink freezes its exact current value. Dimensions stay visible; the shared parameter and other contours remain unchanged.</CadContextHelp></div>}
      {(error || candidateIssue) && <p className="cad-error" role="alert">{error || candidateIssue}</p>}
      {!error && !candidateIssue && confirmation.notice && <div className="cad-form-hint" role="status">{confirmation.notice}</div>}
      </fieldset>
      <div className="cad-form-actions"><Button type="button" onClick={close}>Cancel</Button><Button variant="primary" type="submit" className="cad-primary" disabled={blocked || !candidate.edits || Boolean(candidateIssue)}><ConfirmIcon size={13} /> Apply</Button></div>
    </form>}
    {!editor && error && <p className="cad-error" role="alert">{error}</p>}
  </div>;
}
