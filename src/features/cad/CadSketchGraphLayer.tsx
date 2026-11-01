import { userFacingMessage } from '@/lib/userMessage';
import { Value } from '@sinclair/typebox/value';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent, type MouseEvent } from 'react';
import type { CadDocument, CadSketchFeature } from '@/domain/cad/cadDocument';
import { cadEditsOnlyPlaceDimensions, type CadEdit } from '@/domain/cad/cadOperations';
import { cadSketchGraphPlacedFrom, type CadSketchGraph, type CadSketchGraphRelation } from '@/domain/cad/cadSketchGraph';
import { cadSketchEntityPointIds, cadSketchRelationEntityIds, cadSketchRelationPointIds } from '@/domain/cad/cadSketchGraphReferences';
import type { CadAnalyticBoundary } from '@/domain/cad/cadSketchGeometry';
import { cadSketchGraphBoundary } from '@/domain/cad/compileCadSketchGeometry';
import { cadPathClosureTolerance } from '@/domain/cad/cadAnalyticSegments';
import { cadSketchGraphCircleControl, cadSketchGraphCircleRadiusEdit, cadSketchGraphPointTranslation, prepareCadSketchGraphInteraction, type CadSketchGraphPointControl, type CadSketchGraphSelection } from './cadSketchGraphInteraction';
import { DRAG_GRID_CATCH_PIXELS, magnetSketchPoint, magnetSketchValue, type SketchPoint } from './cadSketchInteraction';
import { cadArcSvgPath } from './cadSketchSvg';
import { formatCadQuantity } from './cadDisplayQuantity';
import { CadSketchGraphDimensions } from './CadSketchGraphDimensions';
import { cadSketchRelationsEqualButPlacement } from '@/domain/cad/cadSketchPlacedDimensions';
import { CadSketchRelationGlyphs, type CadSketchRelationGlyphFocus } from './CadSketchRelationGlyphs';
import type { CadSketchDimensionRelation } from './cadSketchGraphDimensionLayout';
import { useCadEditSubmission, type CadEditCompletion } from './useCadEditSubmission';
import { useCadContinuousPreview, type CadPrepareEdits } from './useCadPreparedPreview';
import { cadSketchGeometryPickAllows, cadSketchPickScopeHasEdges, cadSketchPickScopeHasPoints, type CadSketchGeometryPick, type CadSketchGraphPickScope } from './cadSketchGraphSelection';
import { cadSketchSnapTargetLabel, type CadSketchSnapCandidate } from './cadSketchGeometrySnaps';
import { cadSketchLinearPatternLockReason } from '@/domain/cad/cadSketchLinearPattern';
import { CadSketchSnapHint } from './CadSketchSnapHint';
import { CadSketchHighlightOverlay } from './CadSketchHighlightOverlay';
import { createCadSketchHighlightStore, NO_SKETCH_DIMENSION_IDS, type CadSketchDimensionPick, type CadSketchHighlightStore } from './cadSketchDimensionSelection';
import { cadSketchGeometryMark, type CadSketchDefinitionMarks, type CadSketchDiagnosisMarks, type CadSketchGeometryMark } from './cadSketchDefinitionMarks';

type Prepared = ReturnType<typeof prepareCadSketchGraphInteraction>;
export interface CadSketchGraphControls {
  readonly document: CadDocument;
  readonly selection: readonly CadSketchGraphSelection[];
  readonly relation?: CadSketchGraphRelation | null;
  /** The points and edges an inspected relation names, the origin and the axes among them. */
  readonly inspection?: { readonly pointIds: readonly string[]; readonly entityIds: readonly string[] } | null;
  readonly degreesOfFreedom?: number | null;
  /** What the latest accepted analysis proved fully defined; its colours may trail the shown version until the next result. */
  readonly definition?: CadSketchDefinitionMarks | null;
  /** True only while `definition` belongs to the shown accepted version: its defined points and circles then refuse moves. */
  readonly definitionLocked?: boolean;
  /** Operands of a rejected preview, Apply or accepted analysis; a failed drag in this layer marks its own above them. */
  readonly diagnosis?: CadSketchDiagnosisMarks | null;
  readonly showDimensions?: boolean;
  readonly geometryPick?: CadSketchGeometryPick;
  readonly positionPick?: { readonly label: string; onPick(point: SketchPoint): void; onCancel(): void };
  readonly placement?: { readonly anchor: SketchPoint | null; readonly target: SketchPoint | null; readonly angleDegrees: number };
  readonly patternInteraction?: import('./CadSketchLinearPatternEditor').CadSketchLinearPatternInteraction;
  onEditPattern?(relationId: string): void;
  /** Selects a point or edge, the origin and the axes among them. */
  onSelect(selection: CadSketchGraphSelection | null, additive?: boolean): void;
  /** Replaces the geometry selection; `additive` keeps the selected origin and axes, which a box never takes, as a Shift box does. */
  onSelectSet?(selections: readonly CadSketchGraphSelection[], additive?: boolean): void;
  /** Delete removes this selection; Delete on a focused point or edge passes `focused`, so the owner removes its selection and the element only while nothing is selected. */
  onDelete?(selection: CadSketchGraphSelection, focused?: true): void;
  onConfigureRelation?(relation: CadSketchDimensionRelation): void;
  /** Relation IDs of the dimensions selected on the canvas; a geometry selection replaces them. */
  readonly dimensionSelection?: readonly string[];
  /**
   * Label commands name the dimension the label was drawn for. Delete without one removes the dimension selection; a focused label's
   * Delete or Backspace passes its dimension and key, and the owner removes the selection and that dimension only while nothing is selected.
   */
  onSelectDimension?(dimension: CadSketchDimensionPick | null, additive: boolean): void;
  onDeleteDimension?(dimension?: CadSketchDimensionPick, key?: 'Delete' | 'Backspace'): void;
  onDimensionMenu?(dimension: CadSketchDimensionPick, at: { readonly clientX: number; readonly clientY: number }): void;
  /** Relation glyphs on the canvas; false draws none. */
  readonly showRelations?: boolean;
  /**
   * Glyph commands name the relations the glyph was drawn for, and share the annotation selection with the dimensions. A click selects
   * them, Shift toggles them and `null` clears that selection; a focused glyph's Delete or Backspace passes its relations and key, and
   * the owner removes the selection, and those relations only while nothing is selected.
   */
  onSelectRelations?(relations: readonly CadSketchDimensionPick[] | null, additive: boolean): void;
  /** Double-click or Enter on a glyph: a fixed point's value editor, or the relation's row in the relations tree. */
  onOpenRelation?(relation: CadSketchDimensionPick): void;
  /** The relations the selection takes, shown as an icon row beside it while nothing is drawn or dragged. */
  readonly selectionActions?: import('./CadSketchSelectionActions').CadSketchSelectionActionsModel | null;
  onDeleteRelations?(relations: readonly CadSketchDimensionPick[], key: 'Delete' | 'Backspace'): void;
  onRelationMenu?(relations: readonly CadSketchDimensionPick[], at: { readonly clientX: number; readonly clientY: number }): void;
  /** Hover highlight shared with the dock rows; without one the layer keeps its own. */
  readonly highlight?: CadSketchHighlightStore;
  onEditMany(edits: readonly CadEdit[], signal?: AbortSignal): CadEditCompletion;
  readonly onPrepareEdits?: CadPrepareEdits;
  onPreviewDocument?(document: CadDocument | null, marks?: CadSketchDiagnosisMarks | null): void;
}
type CircleControl = ReturnType<typeof cadSketchGraphCircleControl>;
/**
 * Above this many relation glyphs only those on selected or inspected geometry, the selected ones and, once the pointer rests on it in Select,
 * those of the geometry, glyph or list row it points at are drawn. During a
 * drag the glyph layer is composited apart and moved glyphs draw beside it, but each shown glyph still adds rows, hit areas and the frames'
 * moved marks. At 4× CPU slowdown, a 60-move point drag over 200 shown glyphs measured within noise of the same sketch without glyphs (2%
 * less time, no more long-task time); 400 shown took 25% longer, with 26% more long-task time. 200 is every mark of 50 rectangles with
 * Horizontal or Vertical on each edge.
 */
export const CAD_SKETCH_RELATION_GLYPH_LIMIT = 200;
type GlyphEvent = { readonly clientX: number; readonly clientY: number; readonly target: EventTarget | null; readonly nativeEvent: Event };
type Intent = { readonly kind: 'point'; readonly point: CadSketchGraphPointControl; readonly translation: SketchPoint; readonly snap: CadSketchSnapCandidate | null }
  | { readonly kind: 'radius'; readonly circle: CircleControl; readonly radius: number }
  | { readonly kind: 'translate'; readonly selections: readonly CadSketchGraphSelection[]; readonly anchor: SketchPoint; readonly translation: SketchPoint };
interface DragFrame {
  readonly pointerId: number; readonly element: SVGGElement;
  readonly clientX: number; readonly clientY: number; readonly step: number; readonly snap: boolean; readonly gridSnap: boolean;
  readonly scaleX: number; readonly scaleY: number;
  cursor: SketchPoint; snapSuppressed: boolean;
  moved: boolean;
  /** A press on an item that is already part of a multi-selection keeps the set for dragging; a plain click still selects the item alone. */
  readonly pick?: CadSketchGraphSelection;
}
type Drag = DragFrame & ({ readonly kind: 'point'; readonly point: CadSketchGraphPointControl; readonly prepared: Prepared; readonly guides: readonly SketchPoint[]; translation: SketchPoint; candidate: CadSketchSnapCandidate | null }
  | { readonly kind: 'radius'; readonly circle: CircleControl; radius: number }
  | { readonly kind: 'translate'; readonly selections: readonly CadSketchGraphSelection[]; readonly anchor: SketchPoint; readonly normal: SketchPoint | null; translation: SketchPoint });

/** The far ends of the lines that meet at a point, which a drag can line up with. */
function lineNeighbours(prepared: Prepared, pointId: string): readonly SketchPoint[] {
  const ids = prepared.graph.entities.flatMap(entity => entity.kind !== 'line' ? [] : entity.startPointId === pointId ? [entity.endPointId] : entity.endPointId === pointId ? [entity.startPointId] : []);
  return prepared.points.filter(point => ids.includes(point.id) && point.id !== pointId).map(point => point.position);
}
/** Exact translation accepts at most this many selections at once. */
const MAX_TRANSLATED_SELECTIONS = 64;

function Boundary({ boundary, center, className, strokeWidth }: { boundary: CadAnalyticBoundary; center: SketchPoint; className?: string; strokeWidth?: number }) {
  return boundary.type === 'line' ? <line className={className} strokeWidth={strokeWidth} x1={boundary.start.x - center[0]} y1={boundary.start.y - center[1]} x2={boundary.end.x - center[0]} y2={boundary.end.y - center[1]} />
    : boundary.type === 'circle' ? <circle className={className} strokeWidth={strokeWidth} cx={boundary.center.x - center[0]} cy={boundary.center.y - center[1]} r={boundary.radius} />
      : <path className={className} strokeWidth={strokeWidth} d={cadArcSvgPath(boundary, center)} />;
}

type GraphSegment = Prepared['geometry']['segments'][number];
type GraphPoint = Prepared['points'][number];
/** The layer's current handlers; memoized rows call them through one stable ref, so a row renders only when its own state changes. */
interface GraphItemActions {
  move(event: PointerEvent<SVGGElement>): void;
  endDrag(event: PointerEvent<SVGGElement>): void;
  cancelPointer(event: PointerEvent<SVGGElement>): void;
  lostCapture(event: PointerEvent<SVGGElement>): void;
  entityDown(event: PointerEvent<SVGGElement>, segment: GraphSegment): void;
  entityClick(event: MouseEvent<SVGGElement>, id: string): void;
  entityKey(event: ReactKeyboardEvent<SVGGElement>, id: string): void;
  pointDown(event: PointerEvent<SVGGElement>, point: GraphPoint): void;
  pointClick(event: MouseEvent<SVGGElement>, id: string): void;
  pointKey(event: ReactKeyboardEvent<SVGGElement>, point: GraphPoint): void;
}
type Actions = { readonly current: GraphItemActions };

const FULLY_DEFINED_HINT = 'Fully defined by dimensions and relations';

const GraphEntityRow = memo(function GraphEntityRow({ segment, index, sketchName, selected, related, highlighted, construction, mark, interactive, active, center, scaleY, halo, actions }: {
  segment: GraphSegment; index: number; sketchName: string; selected: boolean; related: boolean; highlighted: boolean; construction: boolean; mark: CadSketchGeometryMark;
  interactive: boolean; active: boolean; center: SketchPoint; scaleY: number; halo: number; actions: Actions;
}) {
  const boundary = cadSketchGraphBoundary(segment);
  return <g data-cad-sketch-entity={segment.id} className={`cad-profile cad-sketch-entity${selected ? ' is-selected' : ''}${related ? ' is-relation-highlighted' : ''}${highlighted ? ' is-pick-highlighted' : ''}${construction ? ' is-construction' : ''}${mark ? ` is-${mark}` : ''}`}
    role="button" aria-label={`${segment.kind[0].toUpperCase()}${segment.kind.slice(1)} ${index + 1} in ${sketchName}`} aria-pressed={selected} aria-disabled={!interactive || undefined} tabIndex={interactive ? 0 : -1}
    strokeDasharray={construction ? `${scaleY * 6} ${scaleY * 4}` : undefined}
    onPointerDown={event => actions.current.entityDown(event, segment)} onPointerMove={event => actions.current.move(event)} onPointerUp={event => actions.current.endDrag(event)}
    onPointerCancel={event => actions.current.cancelPointer(event)} onLostPointerCapture={event => actions.current.lostCapture(event)}
    onClick={event => actions.current.entityClick(event, segment.id)} onKeyDown={event => actions.current.entityKey(event, segment.id)}>
    {halo > 0 && <Boundary boundary={boundary} center={center} className="cad-sketch-halo" strokeWidth={halo} />}
    <Boundary boundary={boundary} center={center} />
    {active && <g className="cad-sketch-entity-hit" strokeWidth={12 * scaleY}><Boundary boundary={boundary} center={center} /></g>}
  </g>;
});

const GraphPointRow = memo(function GraphPointRow({ point, original, graph, degreesOfFreedom, fixed, mark, index, sketchName, referenceCorner, revealed, selected, related, highlighted, interactive, active, center, scaleX, scaleY, actions }: {
  point: GraphPoint; original: GraphPoint; graph: CadSketchGraph; degreesOfFreedom: number | null | undefined; fixed: boolean; mark: CadSketchGeometryMark; index: number; sketchName: string;
  referenceCorner: boolean; revealed: boolean; selected: boolean; related: boolean; highlighted: boolean; interactive: boolean; active: boolean;
  center: SketchPoint; scaleX: number; scaleY: number; actions: Actions;
}) {
  // Numeric coordinates allow a move request; they do not establish this point's freedom. `fixed` does: the shown
  // version's analysis proved both coordinates determined.
  const coordinateDriven = !original.freeAxes.some(Boolean), canRequestMove = degreesOfFreedom !== 0 && !coordinateDriven && !fixed;
  const movementHint = cadSketchLinearPatternLockReason(graph, { kind: 'point', id: point.id }) ?? (coordinateDriven ? 'Coordinates follow dimensions or expressions' : degreesOfFreedom === 0 || fixed
    ? FULLY_DEFINED_HINT : `Movement follows dimensions and relations${original.freeAxes.every(Boolean) ? '' : ` · ${original.freeAxes[0] ? 'Y' : 'X'} coordinate is driven`}`);
  const x = point.position[0] - center[0], y = point.position[1] - center[1];
  return <g data-cad-sketch-point={point.id} data-cad-reference-corner={referenceCorner || undefined} role="button" aria-label={`${referenceCorner ? 'Reference corner' : 'Point'} ${index + 1} in ${sketchName}`} aria-pressed={selected} aria-disabled={!interactive || undefined} pointerEvents={active ? undefined : 'none'}
    tabIndex={interactive ? 0 : -1} className={`cad-sketch-graph-point${revealed ? ' is-revealed' : ''}${selected ? ' is-active' : ''}${related ? ' is-relation-highlighted' : ''}${highlighted ? ' is-pick-highlighted' : ''}${canRequestMove ? '' : ' is-locked'}${mark ? ` is-${mark}` : ''}`}
    onPointerDown={event => actions.current.pointDown(event, point)} onPointerMove={event => actions.current.move(event)} onPointerUp={event => actions.current.endDrag(event)}
    onPointerCancel={event => actions.current.cancelPointer(event)} onLostPointerCapture={event => actions.current.lostCapture(event)}
    onClick={event => actions.current.pointClick(event, point.id)} onKeyDown={event => actions.current.pointKey(event, point)}>
    <circle cx={x} cy={y} r={7 * scaleY} className="cad-sketch-point-hit" />
    {referenceCorner ? <path d={`M ${x} ${y + 4 * scaleY} L ${x + 4 * scaleX} ${y} L ${x} ${y - 4 * scaleY} L ${x - 4 * scaleX} ${y} Z`} className="cad-sketch-point-mark" />
      : <circle cx={x} cy={y} r={3 * scaleY} className="cad-sketch-point-mark" />}
    <title>{referenceCorner ? 'Original reference corner · ' : ''}{formatCadQuantity(point.position[0])}, {formatCadQuantity(point.position[1])} mm · {movementHint}</title>
  </g>;
});

/**
 * Point and size handles share one gesture owner; solved previews never become accepted geometry. The layer is memoized,
 * so drawing-cursor moves in the canvas do not render every edge and point again; callers pass stable props.
 */
export const CadSketchGraphLayer = memo(function CadSketchGraphLayer({ controls, sketch, version, prepared, visual, center, scaleX, scaleY, gridStep, snap, gridSnap = false, active, locked, cancelSignal, onPendingChange, onError, filter = 'auto', relationsSelectable = true, dimensionsSelectable = true, pickAt, coversDimensionLine, coversRelationGlyph, highlighted, halo = 0 }: {
  controls: CadSketchGraphControls; sketch: CadSketchFeature; version?: string; prepared: Prepared; visual?: Prepared;
  center: SketchPoint; scaleX: number; scaleY: number; gridStep: number; snap: boolean; gridSnap?: boolean; active: boolean; locked: boolean; cancelSignal: number;
  onPendingChange(pending: boolean): void; onError(message: string): void;
  filter?: CadSketchGraphPickScope;
  /** Whether the selection filter lets clicks take relation marks and dimension labels. */
  relationsSelectable?: boolean;
  dimensionsSelectable?: boolean;
  pickAt?(event: { clientX: number; clientY: number }): CadSketchGraphSelection | null;
  /** Whether the origin or an axis, a profile grip or a profile edge under the pointer keeps the pick from a dimension line or arrow. */
  coversDimensionLine?(event: GlyphEvent): boolean;
  /** Whether sketch geometry, the origin or an axis, a profile grip or a profile edge under the pointer keeps the pick from a relation glyph. */
  coversRelationGlyph?(event: GlyphEvent): boolean;
  highlighted?: CadSketchGraphSelection | null;
  /** Width, in sketch units, of the dark under-stroke each edge gets over a plainly shown part; 0 draws none. */
  halo?: number;
}) {
  const submission = useCadEditSubmission();
  const [ownHighlight] = useState(createCadSketchHighlightStore), highlightStore = controls.highlight ?? ownHighlight;
  const [intent, setIntent] = useState<Intent | null>(null);
  const [dimensionHits, setDimensionHits] = useState<SVGGElement | null>(null);
  const drag = useRef<Drag | null>(null);
  const callbacks = useRef({ controls, onPendingChange, onError }); callbacks.current = { controls, onPendingChange, onError };
  const lastPreview = useRef<{ source: CadDocument; document: CadDocument } | null>(null);
  // The glyph layer is memoized, so its commands keep their identity and read the current controls when they run.
  const [glyphCommands] = useState(() => ({
    select: (relations: readonly CadSketchDimensionPick[] | null, additive: boolean) => callbacks.current.controls.onSelectRelations?.(relations, additive),
    open: (relation: CadSketchDimensionPick) => callbacks.current.controls.onOpenRelation?.(relation),
    remove: (relations: readonly CadSketchDimensionPick[], key: 'Delete' | 'Backspace') => callbacks.current.controls.onDeleteRelations?.(relations, key),
    menu: (relations: readonly CadSketchDimensionPick[], at: { readonly clientX: number; readonly clientY: number }) => callbacks.current.controls.onRelationMenu?.(relations, at)
  }));
  // Glyphs on the selected or inspected geometry draw as related, and stay drawn on a sketch above the glyph limit.
  const glyphFocus = useMemo((): CadSketchRelationGlyphFocus | null => {
    const pointIds = [...controls.selection.filter(item => item.kind === 'point').map(item => item.id), ...controls.inspection?.pointIds ?? []];
    const entityIds = [...controls.selection.filter(item => item.kind === 'entity').map(item => item.id), ...controls.inspection?.entityIds ?? []];
    return pointIds.length || entityIds.length ? { pointIds, entityIds } : null;
  }, [controls.selection, controls.inspection]);
  const release = useCallback(() => {
    const owned = drag.current; drag.current = null;
    try { if (owned?.element.hasPointerCapture?.(owned.pointerId)) owned.element.releasePointerCapture(owned.pointerId); } catch { /* Capture may already be released. */ }
  }, []);
  const cancel = useCallback(() => {
    release(); submission.cancel(); lastPreview.current = null; setIntent(null);
    callbacks.current.onPendingChange(false);
  }, [release, submission.cancel]);
  const frame = `${center[0]},${center[1]},${scaleX},${scaleY},${filter}`;
  const source = useRef({ document: controls.document, version, cancelSignal, frame, prepared, sketchId: sketch.id });
  useLayoutEffect(() => {
    const previous = source.current; source.current = { document: controls.document, version, cancelSignal, frame, prepared, sketchId: sketch.id };
    if (previous.document === controls.document && previous.version === version && previous.cancelSignal === cancelSignal
      && previous.frame === frame && previous.prepared === prepared && previous.sketchId === sketch.id) return;
    cancel();
    if (previous.document.id !== controls.document.id || previous.cancelSignal !== cancelSignal) callbacks.current.controls.onSelect(null);
  }, [controls.document, version, cancelSignal, frame, prepared, sketch.id, cancel]);
  useEffect(() => { if (!active || locked) cancel(); }, [active, locked, cancel]);
  useEffect(() => {
    const blur = () => cancel(); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('blur', blur); release(); callbacks.current.onPendingChange(false); };
  }, [cancel, release]);
  const updateDrag = useCallback((owned: Drag) => {
    if (!owned.moved) return;
    // Geometry targets follow Snap; grid nodes catch only when grid snapping is switched on.
    const enabled = owned.snap && !owned.snapSuppressed, grid = owned.gridSnap && !owned.snapSuppressed, catchRadius = DRAG_GRID_CATCH_PIXELS * Math.max(owned.scaleX, owned.scaleY);
    if (owned.kind === 'translate') {
      const raw: SketchPoint = [owned.cursor[0] - owned.anchor[0], owned.cursor[1] - owned.anchor[1]], normal = owned.normal;
      const distance = normal ? magnetSketchValue(raw[0] * normal[0] + raw[1] * normal[1], owned.step, grid, catchRadius) : 0;
      const translation = normal ? [normal[0] * distance, normal[1] * distance] as const : magnetSketchPoint(raw, owned.step, grid, catchRadius);
      owned.translation = translation;
      setIntent(current => current?.kind === 'translate' && current.translation[0] === translation[0] && current.translation[1] === translation[1] ? current
        : { kind: 'translate', selections: owned.selections, anchor: owned.anchor, translation });
      return;
    }
    if (owned.kind === 'radius') {
      const distance = Math.hypot(owned.cursor[0] - owned.circle.center[0], owned.cursor[1] - owned.circle.center[1]);
      owned.radius = magnetSketchValue(distance, owned.step, grid, catchRadius);
      setIntent(current => current?.kind === 'radius' && Object.is(current.radius, owned.radius) ? current : { kind: 'radius', circle: owned.circle, radius: owned.radius });
      return;
    }
    // Edges, axes and the origin attract the point as they do while drawing; its line neighbours offer horizontal and vertical guides.
    const result = enabled ? owned.prepared.snap({ cursor: owned.cursor, mmPerPixel: [owned.scaleX, owned.scaleY], excludePointIds: [owned.point.id], references: true, alignTo: owned.guides }) : null;
    let candidate = result?.kind === 'hit' ? result.candidate : null;
    if (candidate) {
      const target = candidate.point;
      const tolerance = cadPathClosureTolerance([{ x: owned.point.position[0], y: owned.point.position[1] }, { x: target[0], y: target[1] }]);
      if (owned.point.freeAxes.some((free, axis) => !free && Math.abs(target[axis] - owned.point.position[axis]) > tolerance)) candidate = null;
    }
    owned.candidate = candidate;
    const target = candidate?.point ?? magnetSketchPoint(owned.cursor, owned.step, grid, catchRadius);
    owned.translation = cadSketchGraphPointTranslation(owned.point, target);
    const key = (snap: CadSketchSnapCandidate | null) => !snap ? '' : `${snap.target.kind}:${snap.target.kind === 'midpoint' ? snap.target.entityId : 'pointId' in snap.target ? snap.target.pointId : ''}`;
    setIntent(current => current?.kind === 'point' && current.translation.every((value, index) => value === owned.translation[index]) && key(current.snap) === key(candidate)
      ? current : { kind: 'point', point: owned.point, translation: owned.translation, snap: candidate });
  }, []);
  useEffect(() => {
    const modifier = (event: KeyboardEvent) => {
      const owned = drag.current;
      if (!owned || event.isComposing || (event.key !== 'Control' && event.key !== 'Meta')) return;
      owned.snapSuppressed = event.ctrlKey || event.metaKey;
      updateDrag(owned);
    };
    window.addEventListener('keydown', modifier); window.addEventListener('keyup', modifier);
    return () => { window.removeEventListener('keydown', modifier); window.removeEventListener('keyup', modifier); };
  }, [updateDrag]);
  const editFor = useCallback((next: Intent): CadEdit | null => next.kind === 'translate'
    ? next.translation.some(value => value !== 0) ? { kind: 'translate-sketch-geometry', sketchId: sketch.id, selections: next.selections, translation: next.translation } : null
    : next.kind === 'point'
    ? next.translation.some(value => value !== 0) ? { kind: 'move-sketch-point', sketchId: sketch.id, pointId: next.point.id, translation: next.translation } : null
    : next.radius === next.circle.radius ? null : cadSketchGraphCircleRadiusEdit(sketch, controls.document.parameters, next.circle.entityId, next.radius), [sketch, controls.document.parameters]);
  const candidate = useMemo(() => {
    try { const edit = intent ? editFor(intent) : null; return { edits: edit ? [edit] : null, issue: null }; }
    catch (cause) { return { edits: null, issue: userFacingMessage(cause, 'Invalid circle radius.') }; }
  }, [intent, editFor]);
  const edits = candidate.edits;
  // A drag solves continuously and draws its result here only; publishing every frame would re-render the whole workbench.
  const preview = useCadContinuousPreview(controls.document, edits, controls.onPrepareEdits, Boolean(intent && !submission.applying));
  if (!edits) lastPreview.current = null;
  if (preview.kind === 'ready') lastPreview.current = { source: controls.document, document: preview.document };
  const previewDocument = intent && lastPreview.current?.source === controls.document ? lastPreview.current.document : null;
  const displayed = useMemo(() => {
    const candidate = previewDocument?.features.find(feature => feature.id === sketch.id);
    return candidate?.kind === 'sketch' && candidate.graph ? prepareCadSketchGraphInteraction(candidate.graph, previewDocument!.parameters) : visual ?? prepared;
  }, [previewDocument, sketch.id, visual, prepared]);
  const construction = useMemo(() => new Set(sketch.graph?.entities.filter(entity => entity.construction).map(entity => entity.id)), [sketch.graph]);
  const entities = useMemo(() => new Map(sketch.graph?.entities.map(entity => [entity.id, entity])), [sketch.graph]);
  const sourcePoints = useMemo(() => new Map(prepared.points.map(point => [point.id, point])), [prepared.points]);
  // Point rows read no placement, so moving a dimension renders none of them again.
  const pointGraph = cadSketchGraphPlacedFrom(prepared.graph);
  // Undo and selection cleanup can render one frame with an old inspector relation.
  const currentRelation = controls.relation && displayed.graph.relations.find(relation => relation.id === controls.relation?.id);
  const relatedPoints = new Set(controls.inspection?.pointIds ?? (currentRelation ? cadSketchRelationPointIds(displayed.graph, currentRelation) : []));
  const relatedEntities = new Set(controls.inspection?.entityIds ?? (currentRelation ? cadSketchRelationEntityIds(currentRelation) : []));
  const referenceCorners = new Set(displayed.graph.relations.filter(relation => relation.kind === 'fillet-corner' || relation.kind === 'chamfer-corner').map(relation => relation.pointId));
  // Vertices stay quiet until they matter: free points, selected geometry, relations, picks, hover and keyboard focus reveal them.
  const supportedPoints = useMemo(() => new Set(displayed.graph.entities.flatMap(cadSketchEntityPointIds)), [displayed.graph.entities]);
  const pointUses = useMemo(() => {
    const uses = new Map<string, number>();
    for (const entity of prepared.graph.entities) for (const id of new Set(cadSketchEntityPointIds(entity))) uses.set(id, (uses.get(id) ?? 0) + 1);
    return uses;
  }, [prepared.graph.entities]);
  const selectionPoints = new Set(controls.selection.flatMap(selection => {
    const entity = selection.kind === 'entity' ? displayed.graph.entities.find(candidate => candidate.id === selection.id) : undefined;
    return entity ? cadSketchEntityPointIds(entity) : [];
  }));
  const choose = (selection: CadSketchGraphSelection, additive = false) => {
    if (active && !locked && !submission.applying) {
      if (controls.geometryPick) {
        if (cadSketchGeometryPickAllows(controls.geometryPick, selection)) controls.geometryPick.onPick(selection);
        return;
      }
      try { if (additive) controls.onSelect(selection, true); else controls.onSelect(selection); }
      catch (cause) { onError(userFacingMessage(cause, 'Unable to select this geometry.')); }
    }
  };
  const commit = (next: Intent) => {
    let edit: CadEdit | null;
    try { edit = editFor(next); } catch (cause) { cancel(); callbacks.current.onError(userFacingMessage(cause, 'Unable to resize this circle.')); return; }
    if (!edit) { cancel(); return; }
    callbacks.current.onPendingChange(true); setIntent(next);
    submission.submit(signal => controls.onEditMany([edit], signal), cancel,
      error => { cancel(); callbacks.current.onError(userFacingMessage(error, 'Unable to edit this sketch geometry.')); });
  };
  const move = (event: PointerEvent<SVGGElement>, released = false) => {
    const owned = drag.current;
    if (!owned || owned.pointerId !== event.pointerId) return;
    event.stopPropagation();
    if (!released && !(event.buttons & 1)) { cancel(); return; }
    if (!owned.moved && Math.hypot(event.clientX - owned.clientX, event.clientY - owned.clientY) <= 4) return;
    owned.moved = true;
    const origin = owned.kind === 'point' ? owned.point.position : owned.kind === 'translate' ? owned.anchor : [owned.circle.center[0] + owned.circle.radius, owned.circle.center[1]];
    owned.cursor = [origin[0] + (event.clientX - owned.clientX) * owned.scaleX,
      origin[1] - (event.clientY - owned.clientY) * owned.scaleY];
    owned.snapSuppressed = event.ctrlKey || event.metaKey;
    updateDrag(owned);
  };
  const endDrag = (event: PointerEvent<SVGGElement>) => {
    const owned = drag.current; if (!owned || owned.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation(); if (event.button === 0) move(event, true); release();
    if (event.button === 0 && owned.moved) commit(owned.kind === 'point' ? { kind: 'point', point: owned.point, translation: owned.translation, snap: owned.candidate }
      : owned.kind === 'translate' ? { kind: 'translate', selections: owned.selections, anchor: owned.anchor, translation: owned.translation }
      : { kind: 'radius', circle: owned.circle, radius: owned.radius });
    else { cancel(); if (event.button === 0 && owned.pick) choose(owned.pick); }
  };
  const interactive = active && !locked && !submission.applying;
  /**
   * A released dimension drag stores its placement as one edit. It changes only where the dimension is drawn: a relation that differs
   * from the accepted one in anything else, as a preview's might, is refused, and one that changes nothing is not submitted. The part
   * accepts such an edit at once, so a host that settles it there and then shows nothing as pending or locked; one that returns a
   * promise is owned and waited for like any submitted edit.
   */
  const moveDimension = (dimension: CadSketchDimensionPick, relation: CadSketchGraphRelation) => {
    const accepted = sketch.graph?.relations.find(item => item.id === dimension.id);
    if (!interactive || controls.geometryPick || drag.current || intent || !accepted || !cadSketchRelationsEqualButPlacement(accepted, relation) || Value.Equal(accepted, relation)) return false;
    const edits: CadEdit[] = [{ kind: 'set-sketch-relation', sketchId: sketch.id, relation }];
    const refused = (error: unknown) => callbacks.current.onError(userFacingMessage(error, 'Unable to move this dimension.'));
    const submit = (apply: (signal: AbortSignal) => CadEditCompletion) => {
      callbacks.current.onPendingChange(true);
      submission.submit(apply, () => callbacks.current.onPendingChange(false), error => { callbacks.current.onPendingChange(false); refused(error); });
    };
    if (!cadEditsOnlyPlaceDimensions(controls.document, edits)) { submit(signal => controls.onEditMany(edits, signal)); return true; }
    const owner = new AbortController();
    let completion: CadEditCompletion;
    try { completion = controls.onEditMany(edits, owner.signal); } catch (error) { refused(error); return false; }
    if (completion && 'then' in completion) {
      const settling = completion;
      submit(signal => { signal.addEventListener('abort', () => owner.abort(), { once: true }); return settling; });
    }
    return true;
  };
  const snapCandidate = intent?.kind === 'point' ? intent.snap : null;
  const solvedPoint = preview.kind === 'ready' && !preview.stale && intent?.kind === 'point' ? displayed.points.find(point => point.id === intent.point.id) : null;
  const attained = Boolean(snapCandidate && solvedPoint && Math.hypot(solvedPoint.position[0] - snapCandidate.point[0], solvedPoint.position[1] - snapCandidate.point[1])
    <= cadPathClosureTolerance([{ x: solvedPoint.position[0], y: solvedPoint.position[1] }, { x: snapCandidate.point[0], y: snapCandidate.point[1] }]));
  const limited = Boolean(snapCandidate && !preview.stale && (preview.kind === 'error' || preview.kind === 'ready' && !attained));
  const snapLabel = snapCandidate ? `${cadSketchSnapTargetLabel(snapCandidate.target)} · ${limited ? 'Constraints limit movement' : 'No relation'}` : '';
  const edgesInteractive = interactive && cadSketchPickScopeHasEdges(filter), pointsInteractive = interactive && cadSketchPickScopeHasPoints(filter);
  const singleEntity = controls.selection.length === 1 && controls.selection[0].kind === 'entity' ? entities.get(controls.selection[0].id) : null;
  const circle = singleEntity?.kind === 'circle' ? cadSketchGraphCircleControl(prepared.graph, prepared.parameters, singleEntity.id) : null;
  const shownCircle = circle && displayed.graph.entities.some(entity => entity.id === circle.entityId && entity.kind === 'circle')
    ? cadSketchGraphCircleControl(displayed.graph, displayed.parameters, circle.entityId) : null;
  const radiusGripOffset = shownCircle ? Math.max(shownCircle.radius, 16 * Math.max(scaleX, scaleY)) : 0;
  const radiusGripX = shownCircle ? shownCircle.center[0] + radiusGripOffset - center[0] : 0;
  // Only a definition of the shown version locks; an older one may still colour the geometry but never refuses a move.
  const fixedPoint = (id: string) => Boolean(controls.definitionLocked && controls.definition?.pointIds.has(id));
  const movesDefined = (selections: readonly CadSketchGraphSelection[]) => controls.definitionLocked === true && selections.some(selection => {
    const entity = selection.kind === 'entity' ? entities.get(selection.id) : undefined;
    return selection.kind === 'point' ? fixedPoint(selection.id) : entity ? cadSketchEntityPointIds(entity).some(fixedPoint) : false;
  });
  const circleDefined = Boolean(circle && controls.definitionLocked && controls.definition?.entityIds.has(circle.entityId));
  const radiusInteractive = edgesInteractive && !controls.geometryPick && circle?.lockedReason === null && controls.degreesOfFreedom !== 0 && !circleDefined;
  // A stale rejection belongs to an earlier target, so it marks nothing while the next solve runs.
  const dragMarks = preview.kind === 'error' && !preview.stale && preview.marks?.sketchId === sketch.id ? preview.marks : null;
  // The same holds for the target marker: a stale rejection was for another target.
  const rejection = preview.kind === 'error' && !preview.stale ? preview.message : null;
  const diagnosis = dragMarks ?? (controls.diagnosis?.sketchId === sketch.id ? controls.diagnosis : null);
  const selected = (kind: CadSketchGraphSelection['kind'], id: string) => controls.selection.some(selection => selection.kind === kind && selection.id === id);
  const focusTarget = (element: SVGGElement, target: CadSketchGraphSelection) => element.closest('.cad-sketch-graph')?.querySelector<SVGGElement>(`[data-cad-sketch-${target.kind === 'point' ? 'point' : 'entity'}="${target.id}"]`)?.focus({ preventScroll: true });
  /** Pressing an item of the current multi-selection drags the whole set; a click without movement narrows to the item. */
  const grabsSelection = (target: CadSketchGraphSelection, additive: boolean) => !additive && !controls.geometryPick && controls.selection.length > 1
    && controls.selection.length <= MAX_TRANSLATED_SELECTIONS && selected(target.kind, target.id);
  const startTranslate = (event: PointerEvent<SVGGElement>, selections: readonly CadSketchGraphSelection[], anchor: SketchPoint, normal: SketchPoint | null, pick?: CadSketchGraphSelection) => {
    callbacks.current.onPendingChange(true);
    drag.current = { kind: 'translate', selections, anchor, normal, translation: [0, 0], pick, pointerId: event.pointerId, element: event.currentTarget, clientX: event.clientX, clientY: event.clientY,
      step: gridStep, snap, gridSnap, scaleX, scaleY, cursor: anchor, snapSuppressed: event.ctrlKey || event.metaKey, moved: false };
    setIntent({ kind: 'translate', selections, anchor, translation: [0, 0] });
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { cancel(); }
  };
  /** The pressed sketch position, so the drag marker sits under the pointer; tests without layout fall back to the edge's own anchor. */
  const pressedPoint = (event: PointerEvent<SVGGElement>, fallback: SketchPoint): SketchPoint => {
    const matrix = event.currentTarget.getScreenCTM?.();
    if (!matrix) return fallback;
    const local = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return Number.isFinite(local.x) && Number.isFinite(local.y) ? [local.x + center[0], local.y + center[1]] : fallback;
  };
  const clickTarget = (event: MouseEvent<SVGGElement>, target: CadSketchGraphSelection, eligible: boolean) => {
    if (!active) return;
    if (event.detail === 0) { if (eligible) { event.stopPropagation(); choose(target, event.shiftKey); } }
    else if (pickAt ? pickAt(event) : eligible) event.stopPropagation();
  };
  const edgeAllowed = (id: string) => edgesInteractive && (!controls.geometryPick || controls.geometryPick.eligibleEntityIds.includes(id));
  const pointAllowed = (id: string) => pointsInteractive && (!controls.geometryPick || controls.geometryPick.eligiblePointIds.includes(id));
  const movable = (original: GraphPoint) => controls.degreesOfFreedom !== 0 && original.freeAxes.some(Boolean) && !fixedPoint(original.id);
  const actions = useRef<GraphItemActions>(null!);
  actions.current = {
    move: event => move(event), endDrag,
    cancelPointer: event => { if (drag.current?.pointerId === event.pointerId) { event.stopPropagation(); cancel(); } },
    lostCapture: event => { if (drag.current?.pointerId === event.pointerId) cancel(); },
    entityDown: (event, segment) => {
      if (event.button !== 0 || !edgeAllowed(segment.id)) return; const target = pickAt ? pickAt(event) : { kind: 'entity' as const, id: segment.id }; if (!target) return;
      event.stopPropagation(); if (event.isPrimary === false || drag.current) return; event.preventDefault(); focusTarget(event.currentTarget, target);
      const own = target.kind === 'entity' && target.id === segment.id, grouped = own && grabsSelection(target, event.shiftKey);
      // A set that would carry a defined point stays put, and the press narrows to the pressed edge as a click would.
      if (!grouped || interactive && controls.degreesOfFreedom !== 0 && movesDefined(controls.selection)) choose(target, event.shiftKey);
      if (!own || !interactive || controls.geometryPick || event.shiftKey || controls.degreesOfFreedom === 0 || movesDefined(grouped ? controls.selection : [target])) return;
      const boundary = cadSketchGraphBoundary(segment), entity = entities.get(segment.id);
      const anchor = pressedPoint(event, boundary.type === 'line' ? [(boundary.start.x + boundary.end.x) / 2, (boundary.start.y + boundary.end.y) / 2] : [boundary.center.x, boundary.center.y]);
      if (grouped) { startTranslate(event, controls.selection, anchor, null, target); return; }
      // A connected line slides along its normal and stretches its neighbours; free edges, arcs and circles move as they are.
      const length = boundary.type === 'line' ? Math.hypot(boundary.end.x - boundary.start.x, boundary.end.y - boundary.start.y) : 0;
      const connected = entity?.kind === 'line' && [entity.startPointId, entity.endPointId].some(id => (pointUses.get(id) ?? 0) > 1);
      startTranslate(event, [target], anchor, boundary.type === 'line' && connected && length > 0 ? [-(boundary.end.y - boundary.start.y) / length, (boundary.end.x - boundary.start.x) / length] : null);
    },
    entityClick: (event, id) => clickTarget(event, { kind: 'entity', id }, edgeAllowed(id)),
    entityKey: (event, id) => {
      if (!edgeAllowed(id) || drag.current || event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); choose({ kind: 'entity', id }, event.shiftKey); }
      else if (event.key === 'Delete' && !controls.geometryPick && controls.onDelete) { event.preventDefault(); event.stopPropagation(); controls.onDelete({ kind: 'entity', id }, true); }
    },
    pointDown: (event, point) => {
      if (event.button !== 0 || !pointAllowed(point.id)) return;
      const target = pickAt ? pickAt(event) : { kind: 'point' as const, id: point.id };
      if (!target) return;
      event.stopPropagation(); if (event.isPrimary === false || drag.current || !interactive) return;
      event.preventDefault(); focusTarget(event.currentTarget, target);
      const original = sourcePoints.get(point.id) ?? point, own = target.kind === 'point' && target.id === point.id;
      if (own && grabsSelection(target, event.shiftKey) && controls.degreesOfFreedom !== 0) {
        // A set that would carry a defined point stays put; the press only narrows to the pressed point, as a click would.
        if (movesDefined(controls.selection)) choose(target, false); else startTranslate(event, controls.selection, original.position, null, target);
        return;
      }
      choose(target, event.shiftKey);
      if (controls.geometryPick || !own) return;
      if (event.shiftKey || !movable(original)) return; // A plain pick above replaces the old set with this point.
      callbacks.current.onPendingChange(true);
      drag.current = { kind: 'point', point: original, pointerId: event.pointerId, element: event.currentTarget, clientX: event.clientX, clientY: event.clientY, step: gridStep, snap, gridSnap, scaleX, scaleY,
        prepared, guides: lineNeighbours(prepared, original.id), cursor: original.position, snapSuppressed: event.ctrlKey || event.metaKey, moved: false, translation: [0, 0], candidate: null };
      setIntent({ kind: 'point', point: original, translation: [0, 0], snap: null });
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { cancel(); }
    },
    pointClick: (event, id) => clickTarget(event, { kind: 'point', id }, pointAllowed(id)),
    pointKey: (event, point) => {
      if (!pointAllowed(point.id) || drag.current || event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); choose({ kind: 'point', id: point.id }, event.shiftKey); return; }
      if (controls.geometryPick) return;
      if (event.key === 'Delete' && controls.onDelete) { event.preventDefault(); event.stopPropagation(); controls.onDelete({ kind: 'point', id: point.id }, true); return; }
      const step = gridStep * (event.shiftKey ? 10 : 1);
      const delta: SketchPoint | null = event.key === 'ArrowLeft' ? [-step, 0] : event.key === 'ArrowRight' ? [step, 0] : event.key === 'ArrowUp' ? [0, step] : event.key === 'ArrowDown' ? [0, -step] : null;
      if (!delta) return;
      event.preventDefault(); event.stopPropagation(); if (controls.selection.length > 1) return; choose({ kind: 'point', id: point.id });
      const original = sourcePoints.get(point.id) ?? point;
      if (movable(original)) commit({ kind: 'point', point: original, translation: cadSketchGraphPointTranslation(original, [original.position[0] + delta[0], original.position[1] + delta[1]]), snap: null });
    }
  };
  return <g className={`cad-sketch-graph${interactive && !controls.geometryPick ? ' is-draggable' : ''}${intent && !submission.applying ? ' is-dragging' : ''}`} onKeyDown={event => { if (event.key === 'Escape' && (drag.current || intent || submission.applying)) { event.preventDefault(); event.stopPropagation(); cancel(); } }}>
    {/* Relation glyphs lie lowest, beneath the dimension lines, points and edges, and leave a press over geometry, the origin or an axis, a grip or a profile edge to the canvas.
        A drag or an applying edit turns the whole layer inert and keeps the tab stops, so neither renders a glyph row when it starts or ends. */}
    {controls.showRelations !== false && <CadSketchRelationGlyphs graph={displayed.graph} topology={(visual ?? prepared).graph} parameters={displayed.parameters} topologyParameters={(visual ?? prepared).parameters} center={center} mmPerPixel={scaleY}
      selectedIds={controls.dimensionSelection ?? NO_SKETCH_DIMENSION_IDS} inspectedRelationId={controls.relation?.id ?? null} focus={glyphFocus} limit={CAD_SKETCH_RELATION_GLYPH_LIMIT}
      focusable={active && !locked && !controls.geometryPick && Boolean(controls.onSelectRelations)}
      interactive={interactive && relationsSelectable && !controls.geometryPick && !drag.current && Boolean(controls.onSelectRelations)} highlight={highlightStore} covered={coversRelationGlyph}
      onSelect={glyphCommands.select} onOpen={glyphCommands.open} onDelete={glyphCommands.remove} onMenu={glyphCommands.menu} />}
    {/* Dimension lines and arrows take the pointer beneath the points and edges, so the geometry they end on or cross keeps its picks. */}
    <g ref={setDimensionHits} className="cad-sketch-graph-dimension-hits" />
    {displayed.geometry.segments.map((segment, index) => {
      const entity = entities.get(segment.id);
      return <GraphEntityRow key={segment.id} segment={segment} index={index} sketchName={sketch.name} selected={selected('entity', segment.id)}
        related={relatedEntities.has(segment.id) || entity?.kind === 'line' && relatedPoints.has(entity.startPointId) && relatedPoints.has(entity.endPointId)}
        highlighted={Boolean(snapCandidate?.entityIds.includes(segment.id)) || highlighted?.kind === 'entity' && highlighted.id === segment.id}
        construction={construction.has(segment.id)} mark={cadSketchGeometryMark('entity', segment.id, controls.definition, diagnosis)}
        interactive={edgeAllowed(segment.id)} active={active} center={center} scaleY={scaleY} halo={halo} actions={actions} />;
    })}
    {displayed.points.map((point, index) => {
      const snapTarget = snapCandidate?.target, isSelected = selected('point', point.id);
      const isHighlighted = Boolean(snapTarget && 'pointId' in snapTarget && snapTarget.pointId === point.id) || highlighted?.kind === 'point' && highlighted.id === point.id;
      const mark = cadSketchGeometryMark('point', point.id, controls.definition, diagnosis);
      const revealed = filter === 'points' || !supportedPoints.has(point.id) || selectionPoints.has(point.id) || isSelected || relatedPoints.has(point.id) || isHighlighted
        || mark === 'conflicting' || mark === 'redundant';
      return <GraphPointRow key={point.id} point={point} original={sourcePoints.get(point.id) ?? point} graph={pointGraph} degreesOfFreedom={controls.degreesOfFreedom}
        fixed={fixedPoint(point.id)} mark={mark} index={index} sketchName={sketch.name}
        referenceCorner={referenceCorners.has(point.id)} revealed={revealed} selected={isSelected} related={relatedPoints.has(point.id)} highlighted={isHighlighted}
        interactive={pointAllowed(point.id)} active={active} center={center} scaleX={scaleX} scaleY={scaleY} actions={actions} />;
    })}
    {circle && shownCircle && active && !controls.geometryPick && <g data-cad-sketch-circle-radius={circle.entityId} className={`cad-sketch-graph-point${radiusInteractive ? '' : ' is-locked'}`}
      role="button" aria-label={`Resize circle radius in ${sketch.name}`} aria-disabled={!radiusInteractive || undefined} tabIndex={radiusInteractive ? 0 : -1}
      onPointerDown={event => {
        if (event.button !== 0 || !active) return; event.stopPropagation();
        if (!radiusInteractive || event.isPrimary === false || drag.current) return;
        event.preventDefault(); event.currentTarget.focus({ preventScroll: true }); choose({ kind: 'entity', id: circle.entityId }, event.shiftKey);
        if (event.shiftKey) return;
        callbacks.current.onPendingChange(true);
        drag.current = { kind: 'radius', circle, pointerId: event.pointerId, element: event.currentTarget, clientX: event.clientX, clientY: event.clientY,
          step: gridStep, snap, gridSnap, scaleX, scaleY, cursor: [circle.center[0] + circle.radius, circle.center[1]], snapSuppressed: event.ctrlKey || event.metaKey, moved: false, radius: circle.radius };
        setIntent({ kind: 'radius', circle, radius: circle.radius });
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { cancel(); }
      }} onPointerMove={move} onPointerUp={endDrag}
      onPointerCancel={event => { if (drag.current?.pointerId === event.pointerId) { event.stopPropagation(); cancel(); } }}
      onLostPointerCapture={event => { if (drag.current?.pointerId === event.pointerId) cancel(); }}
      onClick={event => { if (active) event.stopPropagation(); }}
      onKeyDown={event => {
        if (!radiusInteractive || drag.current || event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
        const sign = event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 0;
        if (!sign) return; event.preventDefault(); event.stopPropagation();
        commit({ kind: 'radius', circle, radius: circle.radius + sign * gridStep * (event.shiftKey ? 10 : 1) });
      }}>
      {radiusGripOffset > shownCircle.radius && <line x1={shownCircle.center[0] + shownCircle.radius - center[0]} y1={shownCircle.center[1] - center[1]}
        x2={radiusGripX} y2={shownCircle.center[1] - center[1]} stroke="var(--muted-foreground)" strokeWidth={scaleY} pointerEvents="none" />}
      <circle cx={radiusGripX} cy={shownCircle.center[1] - center[1]} r={7 * scaleY} className="cad-sketch-point-hit" />
      <path d={`M ${radiusGripX} ${shownCircle.center[1] - center[1] + 4 * scaleY} l ${4 * scaleX} ${-4 * scaleY} l ${-4 * scaleX} ${-4 * scaleY} l ${-4 * scaleX} ${4 * scaleY} Z`} className="cad-sketch-point-mark" />
      <title>{circle.lockedReason ?? (controls.degreesOfFreedom === 0 || circleDefined ? FULLY_DEFINED_HINT : `Radius ${formatCadQuantity(shownCircle.radius)} mm · Drag to resize, or use arrow keys`)}</title>
    </g>}
    <CadSketchHighlightOverlay store={highlightStore} prepared={displayed} center={center} mmPerPixel={scaleY} selectedRelationIds={controls.dimensionSelection ?? NO_SKETCH_DIMENSION_IDS} />
    {active && controls.showDimensions !== false && <CadSketchGraphDimensions graph={displayed.graph} parameters={displayed.parameters} center={center} mmPerPixel={scaleY}
      selectedRelationId={controls.relation?.id} selectedIds={controls.dimensionSelection} highlight={highlightStore} hitLayer={dimensionHits} covered={coversDimensionLine}
      interactive={interactive && dimensionsSelectable && (!controls.geometryPick || controls.geometryPick.dimensionsInteractive === true) && !drag.current && Boolean(controls.onConfigureRelation)} onConfigure={relation => controls.onConfigureRelation?.(relation)}
      onSelect={(dimension, additive) => controls.onSelectDimension?.(dimension, additive)} onDelete={(dimension, key) => controls.onDeleteDimension?.(dimension, key)}
      onMenu={(dimension, at) => controls.onDimensionMenu?.(dimension, at)} onMove={controls.geometryPick ? undefined : moveDimension} />}
    {intent && drag.current?.moved && <circle className={`cad-sketch-drag-target${rejection !== null || candidate.issue ? ' is-invalid' : ''}`}
      cx={(intent.kind === 'point' ? intent.point.position[0] + intent.translation[0] : intent.kind === 'translate' ? intent.anchor[0] + intent.translation[0] : intent.circle.center[0] + intent.radius) - center[0]}
      cy={(intent.kind === 'point' ? intent.point.position[1] + intent.translation[1] : intent.kind === 'translate' ? intent.anchor[1] + intent.translation[1] : intent.circle.center[1]) - center[1]} r={5 * scaleY}>
      <title>{candidate.issue ?? rejection ?? 'Drag target'}</title></circle>}
    {snapCandidate && <CadSketchSnapHint candidate={snapCandidate} center={center} scaleX={scaleX} scaleY={scaleY} label={snapLabel} attained={attained} />}
  </g>;
});
