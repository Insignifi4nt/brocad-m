import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { CloseIcon, ConfirmIcon, LinkIcon, MeasureIcon } from '@wire-edm/icons-react';
import type { CadScalar } from '@/domain/cad/cadDocument';
import type { CadSketchGraph, CadSketchGraphRelation, CadSketchReferenceDimension } from '@/domain/cad/cadSketchGraph';
import type { CadEdit } from '@/domain/cad/cadOperations';
import { evaluateCadScalar } from '@/domain/cad/cadExpression';
import { withCadSketchCarriedPlacement } from '@/domain/cad/cadSketchPlacedDimensions';
import { resolveCadSketchPointLineDistanceOperands } from '@/domain/cad/cadSketchPointLineDistanceRelations';
import { cadSketchLinearPatternForSelection } from '@/domain/cad/cadSketchLinearPattern';
import { cadSketchOwnedGeometryLockReason } from '@/domain/cad/cadSketchOwnedGeometry';
import { cadSketchExternalReferenceForSelection } from '@/domain/cad/cadSketchExternalReferences';
import { CadScalarEditContext, ScalarField } from './CadFields';
import { CadContextHelp } from './CadContextHelp';
import { CadSketchSelectionMeasurements } from './CadSketchSelectionMeasurements';
import { formatCadQuantity } from './cadDisplayQuantity';
import { describeCadSketchConstraintSource } from './cadSketchConstraintFeedback';
import { cadSketchDrivingDimensionFor, cadSketchMatchingReference, cadSketchRadialRelationForEntity } from './cadSketchDimensionCommands';
import type { CadSketchGraphSelection } from './cadSketchGraphInteraction';
import type { CadSketchGeometryEditorProps } from './CadSketchGeometryEditors';
import './cad-sketch-profile.css';
import { useCadSketchDraft } from './useCadSketchDraft';
import { cadSketchGeneratorName, cadSketchGeneratorOwner } from '@/domain/cad/sketch-generators/cadSketchGenerators';
import { cadSketchProfileGenerator } from '@/domain/cad/sketch-generators/cadSketchProfileViews';

type Measurement = CadSketchReferenceDimension['measurement'];

/** A point with a line it does not end on, or an arc or circle's centre with a line: the operands of a point to line distance. */
function pointLineOperands(graph: CadSketchGraph, selection: readonly CadSketchGraphSelection[]) {
  if (selection.length !== 2) return null;
  const line = selection.map(atom => atom.kind === 'entity' ? graph.entities.find(entity => entity.id === atom.id) : undefined).find(entity => entity?.kind === 'line');
  const other = line && selection.find(atom => atom.kind === 'point' || atom.id !== line.id);
  const curve = other?.kind === 'entity' ? graph.entities.find(entity => entity.id === other.id) : undefined;
  const pointId = other?.kind === 'point' ? other.id : curve && curve.kind !== 'line' ? curve.centerPointId : null;
  if (!line || !pointId) return null;
  const operands = { pointId, lineId: line.id };
  try { resolveCadSketchPointLineDistanceOperands(graph, operands); return operands; } catch { return null; }
}

/** The edits that save a measurement of the selection as a reference dimension: a dimension driving it becomes the reference under its own ID. */
export function cadSketchReferenceEdits(graph: CadSketchGraph, sketchId: string, measurement: Measurement): readonly CadEdit[] {
  if (cadSketchMatchingReference(graph, measurement)) return [];
  const driver = cadSketchDrivingDimensionFor(graph, measurement);
  const built: CadSketchReferenceDimension = { id: driver?.id ?? crypto.randomUUID(), kind: 'reference-dimension', measurement };
  // A driver that becomes the reference keeps where it was drawn.
  const relation: CadSketchGraphRelation = driver ? withCadSketchCarriedPlacement(graph, driver, built) : built;
  return [{ kind: 'set-sketch-relation', sketchId, relation }];
}

/**
 * What the inspector shows for selected sketch geometry: what it is, its measurements, the pattern or linked reference it belongs to, a
 * reference measurement, and the expressions on its coordinates or circle radius. Relations come from the icon row beside the selection.
 */
export function CadSketchSelectionInspector({ selection, onApply, onEditPattern, onSelectPatternSeed, onEditGenerator, ...props }: Omit<CadSketchGeometryEditorProps, 'onClose'> & {
  /** The selected points and edges, without the origin and the axes. */
  readonly selection: readonly CadSketchGraphSelection[];
  /** Applies a one-step edit, such as a reference measurement or a detach, at once. */
  onApply(edits: readonly CadEdit[]): void;
  onEditPattern?(relationId: string, detach?: true): void;
  onSelectPatternSeed?(entityId: string): void;
  /** Opens the configuration of the generator `generatorId`, as its profile's was. */
  onEditGenerator?(generatorId: string): void;
}) {
  const { graph, sketch, document: cadDocument } = props;
  const singleton = selection.length === 1 ? selection[0] : null;
  const originalPoint = singleton?.kind === 'point' ? graph.points.find(point => point.id === singleton.id) : undefined;
  const originalEntity = singleton?.kind === 'entity' ? graph.entities.find(entity => entity.id === singleton.id) : undefined;
  const geometryScalars = useMemo(() => {
    const values: Record<string, CadScalar> = {};
    if (originalEntity?.kind === 'circle') values.radius = originalEntity.radius;
    if (originalPoint) { values['coordinate/x'] = originalPoint.position[0]; values['coordinate/y'] = originalPoint.position[1]; }
    return values;
  }, [originalEntity, originalPoint]);
  const draft = useCadSketchDraft({ ...props, geometryScalars });
  const point = singleton?.kind === 'point' ? draft.draft.points.find(item => item.id === singleton.id) : undefined;
  const entity = singleton?.kind === 'entity' ? draft.draft.entities.find(item => item.id === singleton.id) : undefined;
  const kinds = selection.map(atom => atom.kind === 'point' ? 'point' : graph.entities.find(item => item.id === atom.id)?.kind ?? 'point');
  const pointPair = selection.length === 2 && kinds.every(kind => kind === 'point') ? [selection[0].id, selection[1].id] as const : null;
  const linePair = selection.length === 2 && kinds.every(kind => kind === 'line');
  const curvePair = selection.length === 2 && kinds.every(kind => kind === 'arc' || kind === 'circle');
  const pointLine = pointLineOperands(graph, selection);
  const pattern = singleton ? cadSketchLinearPatternForSelection(graph, singleton) : null;
  const patternLock = selection.map(atom => cadSketchOwnedGeometryLockReason(graph, atom)).find(Boolean) ?? null;
  const generator = selection.map(atom => cadSketchGeneratorOwner(graph, atom.id)).find(Boolean);
  const configurable = generator && cadSketchProfileGenerator(sketch, generator.id);
  const reference = singleton ? cadSketchExternalReferenceForSelection(graph, singleton) : undefined;
  const referenceSource = reference ? cadDocument.features.find(feature => feature.id === reference.sourceSketchId)?.name : null;
  const radialDriver = entity ? cadSketchRadialRelationForEntity(graph, entity.id) : undefined;
  const measurement: Measurement | null = pointPair ? { kind: 'point-distance', pointIds: pointPair }
    : entity?.kind === 'line' ? { kind: 'line-length', entityId: entity.id }
      : entity ? { kind: 'radial-size', entityId: entity.id, quantity: radialDriver?.kind === 'radial-size' ? radialDriver.quantity : entity.kind === 'circle' ? 'diameter' : 'radius' }
        : pointLine ? { kind: 'point-line-distance', ...pointLine } : null;
  const measured = measurement ? measurement.kind === 'radial-size' ? measurement.quantity : measurement.kind === 'line-length' ? 'length' : 'distance' : null;
  const referenceEdits = measurement ? cadSketchReferenceEdits(graph, sketch.id, measurement) : null;
  const title = pointPair ? 'Point pair' : linePair ? 'Line pair' : curvePair ? 'Curve pair' : selection.length > 1 ? `${selection.length} selected`
    : point ? 'Point' : entity?.kind === 'circle' ? 'Circle' : entity?.kind === 'line' ? 'Line' : 'Arc';
  const pointName = (id: string) => `Point ${graph.points.findIndex(item => item.id === id) + 1}`;
  const edgeName = (id: string) => describeCadSketchConstraintSource(graph, { kind: 'entity', id }).label;
  const summary = selection.length < 2 ? null : pointPair ? pointPair.map((id, index) => `${index ? 'To' : 'From'} ${pointName(id)}`).join(' → ')
    : linePair || curvePair ? selection.map(atom => edgeName(atom.id)).join(' · ') : pointLine ? `${pointName(pointLine.pointId)} · ${edgeName(pointLine.lineId)}`
      : `${kinds.filter(kind => kind === 'point').length} points · ${kinds.filter(kind => kind !== 'point').length} edges`;
  const setCoordinate = (index: 0 | 1, value: CadScalar) => draft.setDraft(current => ({ ...current, points: current.points.map(item => item.id === singleton?.id
    ? { ...item, position: index === 0 ? [value, item.position[1]] : [item.position[0], value] } : item) }));
  const setRadius = (radius: CadScalar) => draft.setDraft(current => ({ ...current, entities: current.entities.map(item => item.id === singleton?.id && item.kind === 'circle' ? { ...item, radius } : item) }));
  return <form className="cad-property-form cad-sketch-profile-panel" aria-label="Sketch selection" aria-busy={draft.applying || undefined}
    onKeyDown={event => { if (event.key === 'Escape' && draft.pending && !draft.applying && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); draft.reset(); } }}
    onSubmit={event => { event.preventDefault(); draft.apply(); }}>
    <div className="cad-property-title">{title}</div>
    {summary && <div className="text-xs text-muted-foreground">{summary}</div>}
    <fieldset key={draft.resetVersion} className="cad-feature-fields" disabled={props.interactionLocked || draft.applying}>
      {pattern && <div className="cad-sketch-profile-actions"><span>{pattern.index === 0 ? 'Pattern seed' : `Pattern occurrence ${pattern.index + 1}`}</span>
        <Button type="button" disabled={draft.pending || !onEditPattern} onClick={() => onEditPattern?.(pattern.relation.id)}>Edit pattern</Button>
        {pattern.index > 0 && <Button type="button" disabled={draft.pending || !onSelectPatternSeed} onClick={() => onSelectPatternSeed?.(pattern.relation.seed.entityId)}>Select seed</Button>}
        <Button type="button" disabled={draft.pending || !onEditPattern} title="Detach all occurrences and retain their current geometry" onClick={() => onEditPattern?.(pattern.relation.id, true)}>Detach pattern</Button>
        <CadContextHelp label="Pattern ownership">Copies follow the seed and pitch. Edit the pattern to omit or restore copies; detach before moving or resizing one independently.</CadContextHelp></div>}
      {generator && <div className="cad-sketch-profile-actions"><span>{cadSketchGeneratorName(generator)}</span>
        {configurable && <Button type="button" disabled={draft.pending || !onEditGenerator} onClick={() => onEditGenerator?.(generator.id)}>Edit shape</Button>}
        <Button type="button" disabled={draft.pending} title="Keep the generated geometry as ordinary sketch geometry"
          onClick={() => onApply([{ kind: 'detach-sketch-generator', sketchId: sketch.id, generatorId: generator.id }])}>Detach</Button>
        <CadContextHelp label="Generated geometry">This geometry follows its shape's inputs and parameters. Edit the shape to change it; detach it to move or trim its edges on their own.</CadContextHelp></div>}
      {!draft.pending && <CadSketchSelectionMeasurements graph={graph} parameters={cadDocument.parameters} selection={selection} pointPair={pointPair} />}
      {reference && <div className="cad-sketch-profile-heading"><LinkIcon size={13} /><span className="min-w-0 truncate">{referenceSource}</span>
        <CadContextHelp label="Linked reference">This construction edge follows its source sketch. Its position and size are read-only; use it for snaps or to constrain other geometry. Detach retains the current shape and local relations.</CadContextHelp>
        {entity?.kind === 'circle' && <span>R {formatCadQuantity(evaluateCadScalar(entity.radius, draft.parameters))} mm</span>}
        <Button type="button" disabled={draft.pending} title="Detach this source link and retain the current geometry"
          onClick={() => onApply([{ kind: 'remove-sketch-relation', sketchId: sketch.id, relationId: reference.id }])}>Detach reference</Button>
      </div>}
      {referenceEdits && measured && <div className="cad-sketch-profile-actions">
        <Button type="button" disabled={draft.pending || !referenceEdits.length} title={referenceEdits.length ? 'Save this measurement without driving the geometry' : 'This measurement is already saved as a reference dimension.'}
          onClick={() => onApply(referenceEdits)}><MeasureIcon size={13} /> Reference {measured}</Button>
        <CadContextHelp label="Reference dimension">Save a measurement on the sketch. It follows the geometry and does not constrain or move it. Use Make driving to set its size deliberately.</CadContextHelp></div>}
      <CadScalarEditContext.Provider value={draft.scalarContext}>
        {point && ([0, 1] as const).map(index => typeof point.position[index] === 'string' || typeof originalPoint?.position[index] === 'string'
          ? <ScalarField key={index} fieldKey={`coordinate/${index ? 'y' : 'x'}`} label={index ? 'Y' : 'X'} value={point.position[index]} parameters={draft.parameters} onChange={value => setCoordinate(index, value)} /> : null)}
        {entity?.kind === 'circle' && !radialDriver && !reference && !patternLock && <ScalarField fieldKey="radius" label="Radius" value={entity.radius} parameters={draft.parameters} onChange={setRadius} />}
      </CadScalarEditContext.Provider>
    </fieldset>
    {draft.issue && <p className="cad-error" role="alert">{draft.issue}</p>}
    {draft.pending && <div className="cad-form-actions"><Button type="button" disabled={draft.applying} onClick={draft.reset}><CloseIcon size={13} /> Cancel</Button>
      <Button variant="primary" type="submit" disabled={!draft.canApply}><ConfirmIcon size={13} /> Apply</Button></div>}
  </form>;
}
