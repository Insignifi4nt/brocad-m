import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { CloseIcon, ConfirmIcon } from '@wire-edm/icons-react';
import type { CadDocument, CadScalar, CadSketchFeature } from '@/domain/cad/cadDocument';
import type { CadSketchGraph, CadSketchGraphRelation } from '@/domain/cad/cadSketchGraph';
import type { CadEdit } from '@/domain/cad/cadOperations';
import { measureCadSketchReferenceDimension } from '@/domain/cad/cadSketchReferenceDimensions';
import { CadScalarEditContext, ScalarField, SelectField } from './CadFields';
import { formatCadQuantity } from './cadDisplayQuantity';
import { cadSketchDimensionToDriving, cadSketchDimensionToReference } from './cadSketchDimensionCommands';
import type { CadSketchDiagnosisMarks } from './cadSketchDefinitionMarks';
import type { CadSketchConstraintFeedback } from './cadSketchConstraintFeedback';
import { cadSketchRelationName } from './cadSketchRelationNames';
import type { CadEditCompletion } from './useCadEditSubmission';
import type { CadPrepareEdits } from './useCadPreparedPreview';
import { useCadSketchDraft } from './useCadSketchDraft';
import { useCadSketchEditorFocusReturn } from './cadFocus';
import './cad-sketch-value-editor.css';

/** The relations whose values the editor at the dimension edits: every dimension, corner size and fixed point. */
export function isCadSketchValueRelation(relation: CadSketchGraphRelation): boolean {
  return relation.kind === 'distance' || relation.kind === 'point-line-distance' || relation.kind === 'axis-distance' || relation.kind === 'fixed-axis' || relation.kind === 'line-angle'
    || relation.kind === 'radial-size' || relation.kind === 'reference-dimension' || relation.kind === 'fillet-corner' || relation.kind === 'chamfer-corner' || relation.kind === 'fixed-point';
}
/** The field name of a value, as its dimension is named elsewhere: a line's own length, a distance, a radius or diameter, an angle. */
export function cadSketchValueLabel(graph: CadSketchGraph, relation: CadSketchGraphRelation): string {
  switch (relation.kind) {
    case 'distance': return graph.entities.some(entity => entity.kind === 'line' && relation.pointIds.includes(entity.startPointId) && relation.pointIds.includes(entity.endPointId)) ? 'Length' : 'Distance';
    case 'point-line-distance': return 'Point to line distance';
    case 'axis-distance': return relation.axis === 'x' ? 'Horizontal distance' : 'Vertical distance';
    case 'fixed-axis': return 'Distance';
    case 'line-angle': return 'Angle';
    case 'radial-size': return relation.quantity === 'radius' ? 'Radius' : 'Diameter';
    case 'fillet-corner': return 'Fillet radius';
    default: return cadSketchRelationName(graph, relation);
  }
}

export interface CadSketchDimensionValueEditorProps {
  readonly document: CadDocument;
  readonly sketch: CadSketchFeature;
  readonly graph: CadSketchGraph;
  readonly relationId: string;
  /** The dimension label, relation mark or tree row the editor opens beside. */
  findAnchor(): Element | null;
  onEditMany(edits: readonly CadEdit[], signal?: AbortSignal): CadEditCompletion;
  onPrepareEdits?: CadPrepareEdits;
  onPendingChange(pending: boolean): void;
  onPreviewDocument?(document: CadDocument | null, marks?: CadSketchDiagnosisMarks | null): void;
  onFeedback?(feedback: CadSketchConstraintFeedback | null): void;
  readonly interactionLocked: boolean;
  /** Cancel or Escape with nothing pending closes the editor; focus returns to its anchor, else to the sketch canvas. */
  onClose(): void;
  onAccepted(): void;
}

/**
 * A dimension's value, edited at the dimension: expressions, parameters, units and pending precision through the shared scalar fields,
 * the reference flip both ways, and the native judge's refusal kept with the draft. Enter applies, Escape resets a change and then closes.
 */
export function CadSketchDimensionValueEditor({ document: cadDocument, sketch, graph, relationId, findAnchor, onEditMany, onPrepareEdits, onPendingChange, onPreviewDocument, onFeedback,
  interactionLocked, onClose, onAccepted }: CadSketchDimensionValueEditorProps) {
  const draft = useCadSketchDraft({ document: cadDocument, sketch, graph, interactionLocked, onEditMany, onPrepareEdits, onPendingChange, onPreviewDocument, onFeedback });
  const form = useRef<HTMLFormElement>(null), [position, setPosition] = useState<{ readonly left: number; readonly top: number; readonly maxHeight?: number } | null>(null);
  const relation = draft.draft.relations.find(item => item.id === relationId);
  const accepted = draft.source.graph.relations.find(item => item.id === relationId);
  useLayoutEffect(() => {
    const element = form.current; if (!element) return;
    const place = () => {
      // The height its content takes, also while a smaller room caps it and it scrolls.
      const anchor = findAnchor()?.getBoundingClientRect(), width = element.offsetWidth, height = element.scrollHeight + element.offsetHeight - element.clientHeight;
      const host = element.offsetParent?.getBoundingClientRect() ?? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
      const clamp = (value: number, size: number, limit: number) => Math.max(8, Math.min(limit - size - 8, value));
      // Below the label when it fits, else above it, so the value stays readable while it is typed; with no label, near the top of the view.
      // The tool dock and the sketch bar float over the view, so where the editor shares their columns it stays between the bar and the dock
      // whichever side it opens on, and when it is taller than the room between them it starts under the bar and scrolls, keeping Apply reachable.
      const left = clamp(anchor ? anchor.left - host.left + anchor.width / 2 - width / 2 : (host.width - width) / 2, width, host.width);
      const across = (selector: string) => {
        const rect = element.closest('.cad-workbench')?.querySelector(selector)?.getBoundingClientRect();
        return rect && rect.width > 0 && rect.height > 0 && rect.left - host.left < left + width && rect.right - host.left > left ? rect : null;
      };
      const dock = across('[data-cad-command-dock]'), bar = across('[data-cad-sketch-header]');
      const floor = (dock ? Math.min(host.height, dock.top - host.top) : host.height) - 8, ceiling = bar ? Math.max(8, bar.bottom - host.top + 6) : 8;
      const below = anchor ? anchor.bottom - host.top + 6 : 48, above = anchor ? anchor.top - host.top - height - 6 : 48;
      // Never shorter than one field row, even where the bar and the dock leave less.
      const next = height > floor - ceiling ? { left, top: ceiling, maxHeight: Math.max(48, floor - ceiling) }
        : { left, top: Math.min(floor - height, Math.max(ceiling, below + height <= floor ? below : above)) };
      setPosition(current => current?.left === next.left && current.top === next.top && current.maxHeight === next.maxHeight ? current : next);
    };
    place();
    // The view resizing, the bar or the dock changing size, or the editor's own content growing or shrinking places it again, once a frame
    // at most, so it keeps between the bar and the dock while it is open.
    let frame = 0;
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; place(); }); };
    const workbench = element.closest('.cad-workbench'), observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    for (const target of [element, element.offsetParent, workbench?.querySelector('[data-cad-command-dock]'), workbench?.querySelector('[data-cad-sketch-header]')]) if (target) observer?.observe(target);
    window.addEventListener('resize', schedule);
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); window.removeEventListener('resize', schedule); };
  }, [relationId, findAnchor]);
  // The first editable value takes focus, ready for typing, once the placed editor shows: until then it is hidden, and a hidden field cannot
  // take focus, so focus would stay on the dimension that opened it.
  const shown = position !== null;
  useLayoutEffect(() => {
    if (!shown) return;
    const field = [...form.current?.querySelectorAll<HTMLInputElement>('input[data-cad-field-key]') ?? []].find(input => !input.readOnly && !input.disabled);
    field?.focus({ preventScroll: true }); field?.select();
  }, [shown]);
  // While the editor holds focus, the value field that had it last. Escape's reset and a reset after an outside edit remount the fields, and
  // Apply disables them while it is checked, so focus falls to the page; it goes back to that field, or the first editable value, selected and
  // ready for typing, or to the first control above Cancel where it has no value to type. Focus the user moves elsewhere ends the hold, so
  // placing the editor again never takes focus.
  const held = useRef<{ readonly key: string | null } | null>(null);
  useLayoutEffect(() => {
    const element = form.current, hold = held.current;
    if (!element || !hold || !shown) return;
    const active = document.activeElement;
    if (active && active !== document.body && !(element.contains(active) && active.matches(':disabled'))) return;
    const inputs = [...element.querySelectorAll<HTMLInputElement>('input[data-cad-field-key]')], fields = inputs.filter(input => !input.readOnly && !input.matches(':disabled'));
    // While Apply is checked every value is disabled: focus waits for them rather than moving to a button.
    const target = fields.find(input => input.dataset.cadFieldKey === hold.key) ?? fields[0] ?? (inputs.length ? null : element.querySelector<HTMLElement>('fieldset select:not(:disabled), fieldset button:not(:disabled)'));
    target?.focus({ preventScroll: true });
    if (target instanceof HTMLInputElement) target.select();
  });
  useCadSketchEditorFocusReturn(form, findAnchor);
  if (!relation || !accepted) return null;
  const parameters = draft.parameters, change = draft.changeRelation;
  // A distance from an axis shows its size; a number on the negative side keeps its side as it is edited, and a negative entry crosses the axis.
  const axisSide = (item: Extract<CadSketchGraphRelation, { kind: 'fixed-axis' }>) => {
    const value = accepted.kind === 'fixed-axis' ? accepted.value : undefined, index = item.axis === 'x' ? 0 : 1;
    const position = typeof value === 'number' ? value : draft.source.graph.points.find(point => point.id === item.pointId)?.position[index];
    return typeof position === 'number' && position < 0 ? -1 : 1;
  };
  const sized = (item: CadSketchGraphRelation, value: CadScalar): CadScalar => item.kind === 'fixed-axis' && typeof value === 'number' && axisSide(item) < 0 ? -value : value;
  const measured = draft.measurementGraph, measuredDocument = draft.measurementDocument;
  const referenceValue = (item: Extract<CadSketchGraphRelation, { kind: 'reference-dimension' }>) => {
    if (!measured || !measuredDocument) return '—';
    try { return `${formatCadQuantity(measureCadSketchReferenceDimension(measured, measuredDocument.parameters, item))} mm`; } catch { return '—'; }
  };
  const toReference = relation.kind !== 'reference-dimension' && relation.kind !== 'fixed-point' ? cadSketchDimensionToReference(draft.draft, relation) : null;
  const toDriving = relation.kind === 'reference-dimension' ? measured && measuredDocument ? cadSketchDimensionToDriving(measured, measuredDocument.parameters, relation)
    : { relation: null, reason: 'Wait for the measurement to update.' } : null;
  // One button turns the dimension either way, so the button pressed stays, with focus, as the dimension changes kind; it waits for a
  // measurement inactive rather than disabled, which would drop its focus.
  const flip = toDriving ? { to: toDriving, label: 'Make driving', title: 'Convert this measurement into a dimension that drives geometry' }
    : toReference ? { to: toReference, label: 'Make reference', title: 'Keep measuring this without driving the geometry' } : null;
  const label = cadSketchValueLabel(draft.draft, relation);
  const submit = () => draft.apply(onAccepted);
  return <form ref={form} className="cad-property-form cad-sketch-value-editor" aria-label={`${relation.kind === 'reference-dimension' ? 'Reference dimension' : label} value`} aria-busy={draft.applying || undefined}
    data-cad-sketch-value-editor={relationId} style={position ? { left: position.left, top: position.top, ...position.maxHeight === undefined ? {} : { maxHeight: position.maxHeight, overflowY: 'auto' } } : { visibility: 'hidden' }}
    onKeyDown={event => {
      if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
      event.preventDefault(); event.stopPropagation();
      if (draft.pending && !draft.applying) draft.reset(); else if (!draft.applying) onClose();
    }}
    onSubmit={event => { event.preventDefault(); submit(); }}
    onFocus={event => { held.current = { key: event.target.getAttribute('data-cad-field-key') ?? held.current?.key ?? null }; }}
    onBlur={event => {
      // Focus moving elsewhere ends the hold; focus falling to the page because its control went or was disabled does not. A control being
      // removed can be told blur while still in the page, so that case is decided once the render that removes it is done.
      const related = event.relatedTarget, control = event.target, owner = event.currentTarget;
      if (related instanceof Node) { if (!owner.contains(related)) held.current = null; return; }
      queueMicrotask(() => { if (control.isConnected && !control.matches(':disabled') && document.activeElement !== control) held.current = null; });
    }}>
    <fieldset key={draft.resetVersion} className="cad-feature-fields" disabled={interactionLocked || draft.applying}>
      <CadScalarEditContext.Provider value={draft.scalarContext}>
        {(relation.kind === 'distance' || relation.kind === 'point-line-distance' || relation.kind === 'axis-distance' || relation.kind === 'fixed-axis' || relation.kind === 'line-angle') &&
          <ScalarField fieldKey={`${relation.id}/value`} label={label} unit={relation.kind === 'line-angle' ? 'deg' : 'mm'} value={sized(relation, relation.value)} parameters={parameters}
            onChange={value => change({ ...relation, value: sized(relation, value) })} />}
        {(relation.kind === 'radial-size' || relation.kind === 'fillet-corner') && <ScalarField fieldKey={`${relation.id}/value`} label={label} value={relation.value} parameters={parameters}
          onChange={value => change({ ...relation, value })} />}
        {relation.kind === 'chamfer-corner' && ([0, 1] as const).map(index => <ScalarField key={index} fieldKey={`${relation.id}/values.${index}`} label={`Setback ${index + 1}`} value={relation.values[index]}
          parameters={parameters} onChange={value => change({ ...relation, values: index === 0 ? [value, relation.values[1]] : [relation.values[0], value] })} />)}
        {relation.kind === 'fixed-point' && ([0, 1] as const).map(index => <ScalarField key={index} fieldKey={`${relation.id}/position.${index}`} label={`Fixed ${index ? 'Y' : 'X'}`}
          value={relation.position[index]} parameters={parameters} onChange={value => change({ ...relation, position: index === 0 ? [value, relation.position[1]] : [relation.position[0], value] })} />)}
        {relation.kind === 'reference-dimension' && <>
          {relation.measurement.kind === 'radial-size' && <SelectField label="Dimension quantity" value={relation.measurement.quantity}
            options={[{ value: 'radius', label: 'Radius' }, { value: 'diameter', label: 'Diameter' }]} onChange={quantity => {
              if (relation.measurement.kind === 'radial-size') change({ ...relation, measurement: { ...relation.measurement, quantity } });
            }} />}
          <dl className="cad-measurements cad-selection-measurements"><div><dt>Reference {relation.measurement.kind === 'radial-size' ? relation.measurement.quantity : 'distance'}</dt>
            <dd aria-label="Reference dimension value">{referenceValue(relation)}</dd></div></dl>
        </>}
      </CadScalarEditContext.Provider>
      {flip && <Button type="button" aria-disabled={!flip.to.relation || undefined} title={flip.to.reason ?? flip.title} onClick={() => { if (flip.to.relation) change(flip.to.relation); }}>{flip.label}</Button>}
    </fieldset>
    {draft.issue && <p className="cad-error" role="alert">{draft.issue}</p>}
    {draft.notice && <div className="cad-form-hint" role="status">{draft.notice}</div>}
    <div className="cad-form-actions">
      <Button type="button" disabled={draft.applying} onClick={onClose}><CloseIcon size={13} /> Cancel</Button>
      <Button variant="primary" type="submit" disabled={!draft.canApply}><ConfirmIcon size={13} /> Apply</Button>
    </div>
  </form>;
}
