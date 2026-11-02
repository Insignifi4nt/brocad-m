import { useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CloseIcon, ConfirmIcon } from '@wire-edm/icons-react';
import type { CadDocument, CadScalar, CadSketchFeature } from '@/domain/cad/cadDocument';
import type { CadSketchGraph } from '@/domain/cad/cadSketchGraph';
import type { CadEdit } from '@/domain/cad/cadOperations';
import { CadScalarEditContext, ScalarField } from './CadFields';
import { CadContextHelp } from './CadContextHelp';
import type { CadSketchGraphSelection } from './cadSketchGraphInteraction';
import type { CadSketchDiagnosisMarks } from './cadSketchDefinitionMarks';
import type { CadSketchConstraintFeedback } from './cadSketchConstraintFeedback';
import type { CadEditCompletion } from './useCadEditSubmission';
import type { CadPrepareEdits } from './useCadPreparedPreview';
import './cad-sketch-profile.css';
import { useCadSketchDraft, type CadSketchDraft } from './useCadSketchDraft';
import { useCadSketchEditorFocusReturn } from './cadFocus';

/** What the move and corner editors share with the sketch they edit. */
export interface CadSketchGeometryEditorProps {
  readonly document: CadDocument;
  readonly sketch: CadSketchFeature;
  readonly graph: CadSketchGraph;
  onEditMany(edits: readonly CadEdit[], signal?: AbortSignal): CadEditCompletion;
  onPrepareEdits?: CadPrepareEdits;
  onPendingChange(pending: boolean): void;
  onPreviewDocument?(document: CadDocument | null, marks?: CadSketchDiagnosisMarks | null): void;
  onFeedback?(feedback: CadSketchConstraintFeedback | null): void;
  readonly interactionLocked: boolean;
  /** Cancel, Escape, or an accepted edit with nothing to select closes the editor; focus it held goes to the sketch canvas. */
  onClose(): void;
}

/** Cancel and Apply, with the draft's issue above them. */
function DraftActions({ draft, onCancel }: { readonly draft: CadSketchDraft; onCancel(): void }) {
  return <>
    {draft.issue && <p className="cad-error" role="alert">{draft.issue}</p>}
    {draft.notice && <div className="cad-form-hint" role="status">{draft.notice}</div>}
    <div className="cad-form-actions"><Button type="button" disabled={draft.applying} onClick={onCancel}><CloseIcon size={13} /> Cancel</Button>
      <Button variant="primary" type="submit" disabled={!draft.canApply}><ConfirmIcon size={13} /> Apply</Button></div>
  </>;
}
const escapeCloses = (draft: CadSketchDraft, close: () => void) => (event: React.KeyboardEvent) => {
  if (event.key !== 'Escape' || event.nativeEvent.isComposing || draft.applying) return;
  event.preventDefault(); event.stopPropagation(); close();
};

/** Moves the selected points and edges together by a typed distance, or hands them to placement for a picked move and rotation. */
export function CadSketchMoveEditor({ selection, onPlaceGeometry, ...props }: CadSketchGeometryEditorProps & {
  readonly selection: readonly CadSketchGraphSelection[];
  onPlaceGeometry?(): void;
}) {
  const [move, setMove] = useState({ x: '0', y: '0' });
  const command = useMemo((): readonly CadEdit[] | Error => {
    const dx = Number(move.x), dy = Number(move.y);
    if (!move.x.trim() || !move.y.trim() || !Number.isFinite(dx) || !Number.isFinite(dy)) return new Error('Enter finite movement distances.');
    return dx || dy ? [{ kind: 'translate-sketch-geometry', sketchId: props.sketch.id, selections: selection, translation: [dx, dy] }] : [];
  }, [move, props.sketch.id, selection]);
  const draft = useCadSketchDraft({ ...props, command, held: true });
  const change = (axis: 'x' | 'y', value: string) => { draft.setError(null); setMove(current => ({ ...current, [axis]: value })); };
  const form = useRef<HTMLFormElement>(null);
  useCadSketchEditorFocusReturn(form);
  return <form ref={form} className="cad-property-form cad-sketch-profile-panel" aria-label="Move selection" aria-busy={draft.applying || undefined} onKeyDown={escapeCloses(draft, props.onClose)}
    onSubmit={event => { event.preventDefault(); draft.apply(props.onClose); }}>
    <div className="cad-property-title">Move selection
      <CadContextHelp label="Move selection">Translate the selected points and edges together without changing their sizes. Shared endpoints also change their incident edges. Outside points and existing dimensions stay in place; a blocked move rejects instead of stretching the selection or releasing constraints.</CadContextHelp></div>
    <fieldset className="cad-feature-fields" disabled={props.interactionLocked || draft.applying}>
      {onPlaceGeometry && <Button type="button" disabled={draft.applying || [move.x, move.y].some(value => !value.trim() || Number(value) !== 0)} onClick={onPlaceGeometry}>Place and rotate…</Button>}
      <div className="cad-placement-row"><label><span>ΔX</span><Input aria-label="Move X" autoFocus value={move.x} onChange={event => change('x', event.target.value)} /></label>
        <label><span>ΔY</span><Input aria-label="Move Y" value={move.y} onChange={event => change('y', event.target.value)} /></label><small>mm</small></div>
    </fieldset>
    <DraftActions draft={draft} onCancel={props.onClose} />
  </form>;
}

type Corner = { readonly kind: 'fillet'; readonly radius: CadScalar } | { readonly kind: 'chamfer'; readonly setbacks: readonly [CadScalar, CadScalar] };

/** Rounds or bevels the corner of two lines at the selected point; the original corner stays as a reference. */
export function CadSketchCornerEditor({ kind, pointId, onAccepted, ...props }: CadSketchGeometryEditorProps & {
  readonly kind: 'fillet' | 'chamfer';
  readonly pointId: string;
  onAccepted(entityId: string, relationId: string): void;
}) {
  const [corner, setCorner] = useState<Corner>(() => kind === 'fillet' ? { kind, radius: 1 } : { kind, setbacks: [1, 1] });
  const [ids] = useState(() => ({ trimPointIds: [crypto.randomUUID(), crypto.randomUUID()] as const, centerPointId: crypto.randomUUID(), entityId: crypto.randomUUID(), relationId: crypto.randomUUID() }));
  const command = useMemo((): readonly CadEdit[] => [{ kind: 'create-sketch-corner', sketchId: props.sketch.id, pointId, treatment: corner.kind === 'fillet'
    ? { ...corner, ...ids } : { ...corner, trimPointIds: ids.trimPointIds, entityId: ids.entityId, relationId: ids.relationId } }], [corner, ids, pointId, props.sketch.id]);
  const draft = useCadSketchDraft({ ...props, command });
  const title = corner.kind === 'fillet' ? 'Sketch fillet' : 'Sketch chamfer';
  const form = useRef<HTMLFormElement>(null);
  useCadSketchEditorFocusReturn(form);
  return <form ref={form} className="cad-property-form cad-sketch-profile-panel" aria-label={title} aria-busy={draft.applying || undefined} onKeyDown={escapeCloses(draft, props.onClose)}
    onSubmit={event => { event.preventDefault(); draft.apply(() => onAccepted(ids.entityId, ids.relationId)); }}>
    <div className="cad-property-title">{title}
      <CadContextHelp label="Corner treatment">The original corner stays as a reference, preserving its dimensions. Fillet radius rounds this corner tangentially. Chamfer setbacks measure from the original corner along the two incident lines.</CadContextHelp></div>
    <fieldset key={draft.resetVersion} className="cad-feature-fields" disabled={props.interactionLocked || draft.applying}>
      <CadScalarEditContext.Provider value={draft.scalarContext}>
        {corner.kind === 'fillet' && <ScalarField fieldKey="corner/value" label="Fillet radius" value={corner.radius} parameters={draft.parameters} onChange={radius => { draft.setError(null); setCorner({ kind: 'fillet', radius }); }} />}
        {corner.kind === 'chamfer' && ([0, 1] as const).map(index => <ScalarField key={index} fieldKey={`corner/values.${index}`} label={`Setback ${index + 1}`} value={corner.setbacks[index]} parameters={draft.parameters}
          onChange={value => { draft.setError(null); setCorner({ ...corner, setbacks: index === 0 ? [value, corner.setbacks[1]] : [corner.setbacks[0], value] }); }} />)}
      </CadScalarEditContext.Provider>
    </fieldset>
    <DraftActions draft={draft} onCancel={props.onClose} />
  </form>;
}
