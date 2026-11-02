import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CloseIcon, ConfirmIcon } from '@wire-edm/icons-react';
import type { CadDocument, CadScalar, CadSketchFeature } from '@/domain/cad/cadDocument';
import type { CadEdit } from '@/domain/cad/cadOperations';
import type { CadSketchGenerator } from '@/domain/cad/cadSketchGraph';
import { cadSketchGeneratorName } from '@/domain/cad/sketch-generators/cadSketchGenerators';
import { CAD_SKETCH_H_AXIS_ID, CAD_SKETCH_V_AXIS_ID } from '@/domain/cad/sketch-relations/cadSketchVirtualElements';
import { userFacingMessage } from '@/lib/userMessage';
import { ScalarField, SelectField } from './CadFields';
import { CadContextHelp } from './CadContextHelp';
import { CadInspectorTitle } from './CadInspectorTitle';
import { describeCadSketchConstraintSource } from './cadSketchConstraintFeedback';
import { cadGeneratorRemovalPrompt, cadGeneratorRemovals, sameCadGeneratorRemovals, type CadGeneratorRemovals } from './cadGeneratorRemovals';
import { cadPreviewMarks, useCadPreparedPreview, type CadPrepareEdits } from './useCadPreparedPreview';
import { useCadEditSubmission, type CadEditCompletion } from './useCadEditSubmission';
import type { CadSketchDiagnosisMarks } from './cadSketchDefinitionMarks';

type RegularPolygon = Extract<CadSketchGenerator['geometry'], { kind: 'regular-polygon' }>;

/** A typed number as the number, and anything else, such as a parameter expression, as the expression. */
const scalarOf = (value: CadScalar): CadScalar => typeof value === 'string' && value.trim() && Number.isFinite(Number(value)) ? Number(value) : value;

/** The edit that sets `generator`'s inputs, confirming the relations `removedRelationIds` its regeneration removes. */
export function cadSketchGeneratorInputEdits(sketchId: string, generator: CadSketchGenerator, removedRelationIds?: readonly string[]): readonly CadEdit[] {
  const geometry = generator.geometry.kind === 'regular-polygon' ? { ...generator.geometry, x: scalarOf(generator.geometry.x), y: scalarOf(generator.geometry.y),
    radius: scalarOf(generator.geometry.radius), sides: scalarOf(generator.geometry.sides) } : generator.geometry;
  return [{ kind: 'set-sketch-generator', sketchId, generator: { ...generator, geometry }, ...removedRelationIds?.length ? { removedRelationIds } : {} }];
}

/**
 * The inputs of a generator that has no profile form, a regular polygon: its centre, radius and number of sides, each a number or a
 * parameter expression, and the line or axis its first vertex lies along. Its geometry regenerates in place, keeping its id; relations
 * on vertices and edges it stops making are shown first and removed only when Apply confirms them.
 */
export function CadSketchGeneratorInputsEditor({ generator, sketch, document, onApply, onCancel, onPendingChange, onPrepareEdits, onPreviewDocument }: {
  readonly generator: CadSketchGenerator;
  readonly sketch: CadSketchFeature;
  readonly document: CadDocument;
  onApply(edits: readonly CadEdit[], signal?: AbortSignal): CadEditCompletion;
  onCancel(): void;
  onPendingChange(pending: boolean): void;
  onPrepareEdits?: CadPrepareEdits;
  onPreviewDocument?(document: CadDocument | null, marks?: CadSketchDiagnosisMarks | null): void;
}) {
  const submission = useCadEditSubmission();
  const [draft, setDraft] = useState(generator);
  const [changed, setChanged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Each accepted revision of the record is the editor's new start.
  const accepted = JSON.stringify(generator);
  useEffect(() => { setDraft(JSON.parse(accepted) as CadSketchGenerator); setChanged(false); setError(null); }, [accepted]);
  useLayoutEffect(() => { onPendingChange(changed); }, [changed, onPendingChange]);
  const update = (next: CadSketchGenerator) => { setDraft(next); setChanged(true); setError(null); };
  const draftEdits = useMemo(() => changed ? cadSketchGeneratorInputEdits(sketch.id, draft) : null, [changed, sketch.id, draft]);
  // As the profile form does: the preview finds the relations regeneration removes and then shows the edit with them; Apply confirms them.
  const [confirmation, setConfirmation] = useState<{ readonly edits: readonly CadEdit[]; readonly removals: CadGeneratorRemovals } | null>(null);
  const removals = confirmation && confirmation.edits === draftEdits ? confirmation.removals : undefined;
  const previewEdits = useMemo(() => removals ? cadSketchGeneratorInputEdits(sketch.id, draft, removals.relationIds) : draftEdits, [removals, sketch.id, draft, draftEdits]);
  const preview = useCadPreparedPreview(document, previewEdits, onPrepareEdits, changed && !submission.applying);
  const found = preview.kind === 'error' ? preview.removals : undefined;
  useEffect(() => {
    if (found && draftEdits && !sameCadGeneratorRemovals(found, removals)) setConfirmation({ edits: draftEdits, removals: found });
  }, [found, draftEdits, removals]);
  useLayoutEffect(() => {
    onPreviewDocument?.(preview.kind === 'ready' ? preview.document : null, cadPreviewMarks(preview));
    return () => onPreviewDocument?.(null);
  }, [preview, onPreviewDocument]);
  const geometry = draft.geometry;
  if (geometry.kind !== 'regular-polygon') return null;
  const graph = sketch.graph;
  const members = `${generator.idPrefix}_`;
  const lines = graph?.entities.filter(entity => entity.kind === 'line' && !entity.id.startsWith(members)) ?? [];
  const directions = [{ value: CAD_SKETCH_H_AXIS_ID, label: 'H axis' }, { value: CAD_SKETCH_V_AXIS_ID, label: 'V axis' },
    ...lines.map(line => ({ value: line.id, label: graph ? describeCadSketchConstraintSource(graph, { kind: 'entity', id: line.id }).label : line.id }))];
  if (!directions.some(option => option.value === geometry.directionId)) directions.push({ value: geometry.directionId, label: geometry.directionId });
  const set = (next: Partial<RegularPolygon>) => update({ ...draft, geometry: { ...geometry, ...next } });
  const scalar = (label: string, key: 'x' | 'y' | 'radius' | 'sides', unit?: string) =>
    <ScalarField label={label} value={geometry[key]} parameters={document.parameters} unit={unit} onChange={value => set({ [key]: value })} />;
  const title = cadSketchGeneratorName(generator);
  return <form className="cad-property-form" aria-label={title} aria-busy={submission.applying || undefined}
    onKeyDown={event => { if (event.key === 'Escape' && changed && !submission.applying && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); submission.cancel(); onCancel(); } }}
    onSubmit={event => {
      event.preventDefault();
      if (!changed || submission.applying) return;
      const applied = draftEdits, confirmed = removals?.relationIds;
      submission.submit(signal => onApply(cadSketchGeneratorInputEdits(sketch.id, draft, confirmed), signal), () => { setChanged(false); setError(null); setConfirmation(null); }, cause => {
        // An Apply that finds removals the preview had not yet shown asks for them as the preview would.
        const asked = cadGeneratorRemovals(cause);
        if (asked && applied) { setConfirmation({ edits: applied, removals: asked }); return; }
        setError(userFacingMessage(cause, 'Unable to change this shape.'));
      });
    }}>
    <CadInspectorTitle>{title}<CadContextHelp label="Generated shape">Its vertices and edges follow these inputs and the parameters they name. Detach it to edit its geometry on its own.</CadContextHelp></CadInspectorTitle>
    <fieldset className="cad-feature-fields" disabled={submission.applying}>
      <label className="cad-field"><span>Name</span><Input value={draft.name ?? ''} onChange={event => {
        const { name: _name, ...rest } = draft; update(event.target.value.trim() ? { ...rest, name: event.target.value } : rest);
      }} /></label>
      <label className="cad-check"><Input type="checkbox" checked={draft.construction} onChange={event => update({ ...draft, construction: event.target.checked })} /> Construction geometry</label>
      {scalar('Center X', 'x')}{scalar('Center Y', 'y')}{scalar('Radius', 'radius')}{scalar('Sides', 'sides', '')}
      <SelectField label="Direction" description="The line or axis the first vertex lies along from the centre. The polygon turns with it." value={geometry.directionId}
        options={directions} onChange={directionId => set({ directionId })} />
    </fieldset>
    {error && <p role="alert" className="cad-error">{error}</p>}
    {!error && removals && <div className="cad-form-hint" role="status">{cadGeneratorRemovalPrompt(document, removals)}</div>}
    {!error && preview.kind === 'error' && !preview.removals && <div className="cad-form-hint" role="status"><span>Preview unavailable</span><CadContextHelp label="Preview unavailable">{preview.message}</CadContextHelp></div>}
    {changed && <div className="cad-form-actions"><Button type="button" onClick={() => { submission.cancel(); onCancel(); }}><CloseIcon size={13} /> Cancel</Button>
      <Button variant="primary" type="submit" className="cad-primary" disabled={submission.applying}><ConfirmIcon size={13} /> Apply</Button></div>}
  </form>;
}
