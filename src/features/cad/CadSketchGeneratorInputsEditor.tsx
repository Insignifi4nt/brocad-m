import { useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CloseIcon, ConfirmIcon } from '@wire-edm/icons-react';
import type { CadDocument, CadScalar, CadSketchFeature } from '@/domain/cad/cadDocument';
import type { CadEdit } from '@/domain/cad/cadOperations';
import type { CadSketchGenerator } from '@/domain/cad/cadSketchGraph';
import { cadSketchGeneratorName } from '@/domain/cad/sketch-generators/cadSketchGenerators';
import { cadSketchGeneratorConstruction } from '@/domain/cad/sketch-generators/cadSketchProfileViews';
import { CAD_SKETCH_H_AXIS_ID, CAD_SKETCH_ORIGIN_ID, CAD_SKETCH_V_AXIS_ID } from '@/domain/cad/sketch-relations/cadSketchVirtualElements';
import { userFacingMessage } from '@/lib/userMessage';
import { ScalarField, SelectField } from './CadFields';
import { CadContextHelp } from './CadContextHelp';
import { CadInspectorTitle } from './CadInspectorTitle';
import { describeCadSketchConstraintSource } from './cadSketchConstraintFeedback';
import { cadGeneratorRemovalPrompt, cadGeneratorRemovals, sameCadGeneratorRemovals, type CadGeneratorRemovals } from './cadGeneratorRemovals';
import { cadPreviewMarks, useCadPreparedPreview, type CadPrepareEdits } from './useCadPreparedPreview';
import { useCadEditSubmission, type CadEditCompletion } from './useCadEditSubmission';
import type { CadSketchDiagnosisMarks } from './cadSketchDefinitionMarks';

type Geometry = CadSketchGenerator['geometry'];
/** The generators with no profile form, whose inputs this editor sets. */
type InputGeometry = Extract<Geometry, { kind: 'regular-polygon' | 'circular-pattern' | 'offset' }>;
const hasInputs = (geometry: Geometry): geometry is InputGeometry =>
  geometry.kind === 'regular-polygon' || geometry.kind === 'circular-pattern' || geometry.kind === 'offset';

/** A typed number as the number, and anything else, such as a parameter expression, as the expression. */
const scalarOf = (value: CadScalar): CadScalar => typeof value === 'string' && value.trim() && Number.isFinite(Number(value)) ? Number(value) : value;
function typed(geometry: Geometry): Geometry {
  switch (geometry.kind) {
    case 'regular-polygon': return { ...geometry, x: scalarOf(geometry.x), y: scalarOf(geometry.y), radius: scalarOf(geometry.radius), sides: scalarOf(geometry.sides) };
    case 'circular-pattern': return { ...geometry, count: scalarOf(geometry.count), angle: scalarOf(geometry.angle) };
    case 'offset': return { ...geometry, distance: scalarOf(geometry.distance) };
    default: return geometry;
  }
}

/** The edit that sets `generator`'s inputs, confirming the relations `removedRelationIds` its regeneration removes. */
export function cadSketchGeneratorInputEdits(sketchId: string, generator: CadSketchGenerator, removedRelationIds?: readonly string[]): readonly CadEdit[] {
  return [{ kind: 'set-sketch-generator', sketchId, generator: { ...generator, geometry: typed(generator.geometry) }, ...removedRelationIds?.length ? { removedRelationIds } : {} }];
}

/**
 * The inputs of a generator that has no profile form, each a number or a parameter expression: a regular polygon's centre, radius and
 * number of sides, and the line or axis its first vertex lies along; a circular pattern's count, angle and centre; a linked offset's
 * distance. Its geometry regenerates in place, keeping its id; members it stops making, and the relations on them, are shown first and
 * removed only when Apply confirms them.
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
  if (!hasInputs(geometry)) return null;
  const graph = sketch.graph;
  const members = `${generator.idPrefix}_`;
  const label = (kind: 'point' | 'entity', id: string) => graph ? describeCadSketchConstraintSource(graph, { kind, id }).label : id;
  const set = (next: Partial<InputGeometry>) => update({ ...draft, geometry: { ...geometry, ...next } as InputGeometry });
  const scalar = (text: string, value: CadScalar, key: string, unit?: string) =>
    <ScalarField label={text} value={value} parameters={document.parameters} unit={unit} onChange={next => set({ [key]: next })} />;
  let fields: ReactNode, help: string;
  if (geometry.kind === 'regular-polygon') {
    const lines = graph?.entities.filter(entity => entity.kind === 'line' && !entity.id.startsWith(members)) ?? [];
    const directions = [{ value: CAD_SKETCH_H_AXIS_ID, label: 'H axis' }, { value: CAD_SKETCH_V_AXIS_ID, label: 'V axis' }, ...lines.map(line => ({ value: line.id, label: label('entity', line.id) }))];
    if (!directions.some(option => option.value === geometry.directionId)) directions.push({ value: geometry.directionId, label: geometry.directionId });
    help = 'Its vertices and edges follow these inputs and the parameters they name. Detach it to edit its geometry on its own.';
    fields = <>{scalar('Center X', geometry.x, 'x')}{scalar('Center Y', geometry.y, 'y')}{scalar('Radius', geometry.radius, 'radius')}{scalar('Sides', geometry.sides, 'sides', '')}
      <SelectField label="Direction" description="The line or axis the first vertex lies along from the centre. The polygon turns with it." value={geometry.directionId}
        options={directions} onChange={directionId => set({ directionId })} /></>;
  } else if (geometry.kind === 'circular-pattern') {
    const centres = [{ value: CAD_SKETCH_ORIGIN_ID, label: 'Origin' },
      ...(graph?.points ?? []).filter(point => !point.id.startsWith(members)).map(point => ({ value: point.id, label: label('point', point.id) }))];
    if (!centres.some(option => option.value === geometry.centerId)) centres.push({ value: geometry.centerId, label: geometry.centerId });
    const seeds = geometry.seedIds.length === 1 ? 'its seed' : `its ${geometry.seedIds.length} seeds`;
    help = `Its copies follow ${seeds}, the centre and these inputs. The count includes the seeds; a full turn spaces them evenly. Detach it to edit the copies on their own.`;
    fields = <>{scalar('Count', geometry.count, 'count', '')}{scalar('Angle', geometry.angle, 'angle', 'deg')}
      <SelectField label="Center" description="The point the copies turn about." value={geometry.centerId} options={centres} onChange={centerId => set({ centerId })} /></>;
  } else {
    help = 'Its edges follow the chain it offsets and the distance, outward when positive. Detach it to edit them on their own.';
    fields = scalar('Distance', geometry.distance, 'distance');
  }
  const title = cadSketchGeneratorName(generator);
  // A pattern of construction seeds makes construction copies whatever its own flag says, so the box shows that and says why.
  const constructionLock = graph ? cadSketchGeneratorConstruction(graph, generator).reason : null;
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
    <CadInspectorTitle>{title}<CadContextHelp label="Generated geometry">{help}</CadContextHelp></CadInspectorTitle>
    <fieldset className="cad-feature-fields" disabled={submission.applying}>
      <label className="cad-field"><span>Name</span><Input value={draft.name ?? ''} onChange={event => {
        const { name: _name, ...rest } = draft; update(event.target.value.trim() ? { ...rest, name: event.target.value } : rest);
      }} /></label>
      <label className="cad-check"><Input type="checkbox" checked={constructionLock ? true : draft.construction} disabled={Boolean(constructionLock)} title={constructionLock ?? undefined} onChange={event => update({ ...draft, construction: event.target.checked })} /> Construction geometry</label>
      {fields}
    </fieldset>
    {error && <p role="alert" className="cad-error">{error}</p>}
    {!error && removals && <div className="cad-form-hint" role="status">{cadGeneratorRemovalPrompt(document, removals)}</div>}
    {!error && preview.kind === 'error' && !preview.removals && <div className="cad-form-hint" role="status"><span>Preview unavailable</span><CadContextHelp label="Preview unavailable">{preview.message}</CadContextHelp></div>}
    {changed && <div className="cad-form-actions"><Button type="button" onClick={() => { submission.cancel(); onCancel(); }}><CloseIcon size={13} /> Cancel</Button>
      <Button variant="primary" type="submit" className="cad-primary" disabled={submission.applying}><ConfirmIcon size={13} /> Apply</Button></div>}
  </form>;
}
