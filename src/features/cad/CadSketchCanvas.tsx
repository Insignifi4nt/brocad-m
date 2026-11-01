import { userFacingMessage } from '@/lib/userMessage';
import { cadSketchGraphPlacedFrom } from '@/domain/cad/cadSketchGraph';
import { flushSync } from 'react-dom';
import { cadSketchLinearPatternForSelection } from '@/domain/cad/cadSketchLinearPattern';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { CloseIcon, ConfirmIcon, FitViewIcon, GridIcon, SelectIcon, SnapIcon, UndoIcon } from '@wire-edm/icons-react';
import { CadToolbarMenu } from './CadToolbarMenu';
import { CAD_DEFAULT_SELECTION_FILTER, cadSelectionAccepts, setCadSelectionKind, type CadSelectionFilter, type CadSelectionKind } from '@/domain/cad/selection/cadSelectionFilter';
import { cadSketchSelectionChain } from '@/domain/cad/selection/cadSketchSelectionChain';
import type { CadChainMode } from '@/domain/cad/selection/cadSelectionChain';
import { cadSelectOtherApply, cadSelectOtherStep } from '@/domain/cad/selection/cadSelectionCycle';
import { CadContextHelp } from './CadContextHelp';
import { CadDrawingTools, CadViewTools } from './CadCommandDock';
import type { CadCurveFeature, CadPathSegment, CadProfile, CadSketchFeature, CadSketchProfile } from '@/domain/cad/cadDocument';
import { resolveCadCurveGeometry } from '@/domain/cad/cadCurve';
import { captureSvgPreview } from '@/features/editor/captureEditorPreview';
import { ToolError } from '@/features/webmcp/siteTools';
import type { CadRenderedViewControls, CadRenderedViewState } from './cadViewportControls';
import { DRAG_GRID_CATCH_PIXELS, magnetSketchPoint, slotSketchProfile, slotSketchWidth, snapSketchPoint, twoPointSketchProfile, type SketchPoint, type SketchTool } from './cadSketchInteraction';
import { CadSketchProfileGeometry } from './CadSketchProfileGeometry';
import { createCadSketchHandlePicker, createCadSketchProfilePicker, type CadSketchHandlePick } from './cadSketchPicking';
import { cadPathDraftEndpoint, cadPathDraftPicks, closeCadPolylineProfile, closesCadPathChain, completedCadPathChain, createCadPathDraft, finishCadCurveDraft, previewCadPathDraft, releaseCadPathDraftPicks, updateCadPathDraft, type CadPathDraft, type CadPathDrawingAction } from './cadPathDrawing';
import { cadSketchDrawingInference, cadSketchDrawingInferenceLabel, cadSketchSnapAxisId, cadSketchSnapRelation, cadSketchSnapTargetLabel, prepareCadSketchGeometrySnaps, type CadSketchSnapCandidate } from './cadSketchGeometrySnaps';
import { prepareCadSketchProfilePositionSnaps } from './cadSketchProfilePositionSnaps';
import { cadSketchProfileSnapLabel } from './cadSketchSnapLabels';
import { CadSketchSnapHint } from './CadSketchSnapHint';
import { CadSketchSnapChooser } from './CadSketchSnapChooser';
import { CadPathDraftGeometry, CadPathSegmentGeometry } from './CadPathDraftGeometry';
import { cadProfileReferenceGeometry } from './cadViewportReferences';
import { CadGearInspectionOverlay } from './CadGearInspectionOverlay';
import { CadSketchDimensionControls, type CadSketchDimensionControlsProps } from './CadSketchDimensionControls';
import { readCadFitArea, type CadFitAreaReader } from './cadFitArea';
import { translateCadSketchProfile } from '@/domain/cad/cadSketchConstraints';
import { cadSketchHandleKey, moveCadSketchHandle, type CadSketchHandle } from '@/domain/cad/cadSketchHandles';
import { formatCadLocalizedQuantity, formatCadQuantity } from './cadDisplayQuantity';
import { prepareCadSketchGraphInteraction } from './cadSketchGraphInteraction';
import { cadSketchExternalReferenceForSelection } from '@/domain/cad/cadSketchExternalReferences';
import { CadSketchLinearPatternPreview } from './CadSketchLinearPatternPreview';
import { CadSketchSelectionActions } from './CadSketchSelectionActions';
import { CAD_SKETCH_RELATION_GLYPH_LIMIT, CadSketchGraphLayer, type CadSketchGraphControls } from './CadSketchGraphLayer';
import { countCadSketchRelationGlyphs } from './cadSketchRelationGlyphLayout';
import { cadSketchGraphBoundary } from '@/domain/cad/compileCadSketchGeometry';
import { cadArcSvgPath } from './cadSketchSvg';
import { useCadEditSubmission, type CadEditCompletion } from './useCadEditSubmission';
import { useCadSketchBoxSelection } from './useCadSketchBoxSelection';
import { cadSketchDimensionPick, cadSketchDimensionPickOf, cadSketchDimensionSelectionStatus, cadSketchRelationHighlight, isCadSketchGlyphRelation, type CadSketchDimensionPick } from './cadSketchDimensionSelection';
import { cadSketchDrawnDimensions } from './cadSketchGraphDimensionLayout';
import { CAD_SKETCH_AXIS_PIXELS, CAD_SKETCH_FIXED_SELECTIONS, cadSelectionFilterForSketchPick, cadSketchFixedEligible, cadSketchGeometryPickAllows, cadSketchGraphSelectionSet, cadSketchGraphSelectionsEqual,
  cadSketchPickScope, cadSketchPickScopeHasEdges, cadSketchPickScopeHasPoints, pickCadSketchFixedElement, cadSketchFixedElementsAt, type CadSketchGraphPickFilter, type CadSketchGraphPickScope } from './cadSketchGraphSelection';
import { CAD_SKETCH_H_AXIS_ID, CAD_SKETCH_ORIGIN_ID, CAD_SKETCH_V_AXIS_ID, cadSketchVirtualSubject, isCadSketchVirtualId, type CadSketchVirtualId } from '@/domain/cad/sketch-relations/cadSketchVirtualElements';
import { CadContextMenu, type CadContextMenuItem } from './CadContextMenu';
import { CadSketchDimensionPreview, CadSketchPointerReadout } from './CadSketchDimensionPreview';
import { CadSketchOverlay, cadSketchViewFrame, type CadSketchViewFrame } from './CadSketchOverlay';
import type { CadSketchGraphSelection } from './cadSketchGraphSelection';
import { cadFreshSketchFixedAxes, type CadFreshSketchDrawing, type CadFreshSketchPick } from '@/domain/cad/cadFreshSketchGraph';
import { CadSketchSplitPreview, prepareCadSketchSplitPreview, type CadSketchSplitPreview as SplitPreview } from './CadSketchSplitPreview';
import { CadSketchTrimPreview, prepareCadSketchTrimPreview, type CadSketchTrimPreview as TrimPreview,
  CadSketchExtendPreview, prepareCadSketchExtendPreview, prepareCadSketchExtendEndPreview, type CadSketchExtendPreview as ExtendPreview } from './CadSketchBoundaryPreview';
import { CAD_PRECISION } from '@/domain/precision/cadPrecision';

const NO_PROFILES: readonly CadSketchProfile[] = Object.freeze([]);
const snapDraftStart = prepareCadSketchGeometrySnaps();
/** Snap targets that place a point along a curve or guide rather than at a point of its own. */
const SNAP_PLACEMENTS: ReadonlySet<CadSketchSnapCandidate['target']['kind']> = new Set(['on-entity', 'on-axis', 'aligned']);
const ACQUIRED_POINTS = 4;
/** A drawing press that travels farther than this is a drag, and a press this close to the last placed point grabs it. */
const DRAWING_DRAG_PIXELS = 8;
/** A second drawing press this soon after the previous one, within the drag slop of it, completes a double-click. */
const DOUBLE_CLICK_MS = 500;
/** The kinds the sketch's selection filter menu offers; the model view offers its own from the same filter. */
const SKETCH_SELECTION_KINDS: readonly { readonly kind: CadSelectionKind; readonly label: string }[] = Object.freeze([
  { kind: 'point', label: 'Points' }, { kind: 'edge', label: 'Edges' }, { kind: 'axis', label: 'Axes' }, { kind: 'relation', label: 'Relations' }, { kind: 'dimension', label: 'Dimensions' }]);
/** A sketch selection holds at most this many points and edges, as its schema allows. */
const SKETCH_SELECTION_LIMIT = 64;
const sameAtom = (a: CadSketchGraphSelection, b: CadSketchGraphSelection) => a.kind === b.kind && a.id === b.id;
/** Picks whose relations name source geometry, so the source must not change while they are pending. */
const referencesSource = (pick: CadFreshSketchPick) => pick.kind === 'coincident' || pick.kind === 'on-line' || pick.kind === 'on-curve';
type DrawingPick = { readonly point: SketchPoint } & (
  | { readonly candidates: readonly CadSketchSnapCandidate[]; readonly candidate?: never }
  | { readonly candidate?: CadSketchSnapCandidate; readonly candidates?: never }
);
interface DrawingSnapChoice {
  readonly owner: object;
  readonly candidates: readonly CadSketchSnapCandidate[];
  readonly clientX: number; readonly clientY: number; readonly frame: string;
  /** The choice ends a drag from an idle Line, so the one line it completes is saved at once. */
  readonly saveLine?: boolean;
}
/** Where and when a drawing press or click happened, with its pointer type when it came from a pointer. */
interface DrawingPlacement { readonly time: number; readonly clientX: number; readonly clientY: number; readonly pointerType?: string }
/**
 * A click while drawing and the draft change it left. `pointerId` is its pointer while the press is still down, then null;
 * `finished` when the click saved a chain.
 */
interface DrawingClick extends DrawingPlacement { readonly changes: number; readonly pointerId: number | null; readonly finished: boolean }
/** A pointer event on a dimension line or arrow, as the graph layer passes it. */
type DimensionLineEvent = { readonly clientX: number; readonly clientY: number; readonly target: EventTarget | null; readonly nativeEvent: Event };
/** What one event found over a dimension line: the grip, origin or axis the canvas hover shows, and whether either, or a profile edge, keeps the pick. */
interface LineCover { readonly event: Event; readonly grip: CadSketchHandlePick | null; readonly fixed: CadSketchGraphSelection | null; readonly covered: boolean }
/** The relations a glyph's `data-cad-sketch-relation-glyph` names: one relation ID, or several joined by spaces. */
function relationGlyphPicks(graph: NonNullable<CadSketchFeature['graph']>, value: string): readonly CadSketchDimensionPick[] {
  // The glyph pressed is drawn, so the relations it names are too; the workbench checks them against its own drawn set.
  const glyph = (id: string) => { const relation = id ? graph.relations.find(item => item.id === id) : undefined; return relation && isCadSketchGlyphRelation(relation) ? cadSketchDimensionPickOf(relation) : null; };
  const whole = glyph(value);
  return whole ? [whole] : value.split(' ').flatMap(id => { const pick = glyph(id); return pick ? [pick] : []; });
}
interface DrawingCursor { readonly point: SketchPoint; readonly mode: 'pointer' | 'position'; readonly snapSuppressed: boolean }
/** What the workbench needs to finish or leave a drawing while the canvas is not focused. */
export interface CadSketchDrawingControls {
  /** One Escape for the drawing. False when nothing is pending, so the Escape leaves the tool. */
  escape(): boolean;
  /** Saves the pending line chain open and runs `after` once the save is accepted. False when no chain can be saved. */
  finishChain(after: () => void): boolean;
}
export interface CadSketchContextMenuRequest {
  readonly clientX: number;
  readonly clientY: number;
  readonly trigger: 'pointer' | 'keyboard';
  readonly profileId: string | null;
  readonly pointMm: SketchPoint;
}
interface CadSketchProfileDrag {
  readonly profile: CadSketchProfile;
  readonly sketch: CadSketchFeature;
  readonly parameters: Readonly<Record<string, number>>;
  readonly pointerId: number;
  readonly element: SVGSVGElement;
  readonly clientX: number;
  readonly clientY: number;
  readonly mmPerPixelX: number;
  readonly mmPerPixelY: number;
  readonly snap: boolean;
  readonly gridStep: number;
  readonly handle: CadSketchHandle | null;
  readonly anchor: SketchPoint | null;
  moved: boolean;
  translation: SketchPoint;
}
type CadSketchDetailSelection = { readonly kind: 'none' | 'profile' } | { readonly kind: 'handle'; readonly target: CadSketchHandlePick };
interface CadSketchOverlapPick {
  readonly prepared: ReturnType<typeof prepareCadSketchGraphInteraction>;
  readonly document: CadSketchGraphControls['document'];
  readonly version?: string; readonly cancelSignal: number; readonly filter: CadSketchGraphPickScope; readonly frameKey: string; readonly frame: string;
  readonly clientX: number; readonly clientY: number; readonly toggle: boolean; readonly candidates: readonly CadSketchGraphSelection[];
  readonly target?: CadSketchGraphSelection;
  readonly selection: readonly CadSketchGraphSelection[];
  readonly geometryPick?: CadSketchGraphControls['geometryPick'];
  readonly split?: SplitPreview;
  readonly trim?: TrimPreview;
  readonly extend?: ExtendPreview;
  readonly extendEnds?: readonly { readonly end: 'start' | 'end'; readonly preview: ExtendPreview }[];
  readonly extendEnd?: 'start' | 'end';
  readonly action?: 'split' | 'trim' | 'extend';
}

/**
 * The stretches of `[from, to]` more than `half` from `at`. The grid fills these, leaving out its zero lines, which the axes
 * draw over; half a grid step clears the zero line and keeps both neighbours.
 */
function gridBands(from: number, to: number, at: number, half: number): readonly (readonly [number, number])[] {
  return ([[from, Math.min(to, at - half)], [Math.max(from, at + half), to]] as const).filter(([start, end]) => end > start);
}

/**
 * CATIA-style H and V axes: thin lines through the sketch origin across the whole view, with fixed-size arrows naming each
 * direction. The view box spans `[-width / 2, width / 2]` across and `[-height / 2, height / 2]` down, in SVG units.
 */
function CadSketchAxes({ origin: [x, y], pixel, view: [width, height], fixedProps }: { readonly origin: SketchPoint; readonly pixel: number; readonly view: SketchPoint;
  readonly fixedProps: (id: CadSketchVirtualId, className: string, onScreen: boolean) => Record<string, unknown> }) {
  const length = CAD_SKETCH_AXIS_PIXELS * pixel, head = 6 * pixel, text = 10 * pixel, ring = 4 * pixel;
  const left = -width / 2, right = width / 2, top = -height / 2, bottom = height / 2;
  // The origin or an axis panned out of view stays drawn but leaves the keyboard order, so Tab and Enter never reach unseen operands.
  const originShown = x + ring >= left && x - ring <= right && y + ring >= top && y - ring <= bottom;
  return <g className="cad-sketch-axes">
    <g {...fixedProps(CAD_SKETCH_H_AXIS_ID, 'cad-axis-x', y >= top && y <= bottom)}>
      <line className="cad-sketch-axis-line" x1={left} y1={y} x2={right} y2={y} strokeWidth={pixel} />
      <path d={`M ${x} ${y} h ${length} m ${-head} ${-head / 2} l ${head} ${head / 2} l ${-head} ${head / 2}`} strokeWidth={pixel * 1.5} />
    </g>
    <g {...fixedProps(CAD_SKETCH_V_AXIS_ID, 'cad-axis-y', x >= left && x <= right)}>
      <line className="cad-sketch-axis-line" x1={x} y1={top} x2={x} y2={bottom} strokeWidth={pixel} />
      <path d={`M ${x} ${y} v ${-length} m ${-head / 2} ${head} l ${head / 2} ${-head} l ${head / 2} ${head}`} strokeWidth={pixel * 1.5} />
    </g>
    <circle cx={x} cy={y} r={ring} strokeWidth={pixel * 1.5} {...fixedProps(CAD_SKETCH_ORIGIN_ID, 'cad-sketch-origin', originShown)} />
    <text className="cad-sketch-axis-label" x={x + length + 3 * pixel} y={y + text / 3} fontSize={text} aria-hidden>H</text>
    <text className="cad-sketch-axis-label" x={x - text / 3} y={y - length - 3 * pixel} fontSize={text} aria-hidden>V</text>
  </g>;
}

export function CadSketchCanvas({ sketch: sourceSketch, parameters, documentVersion, placementLabel, tool, selectedProfileId, onSelectProfile, onAddProfile, onAddFreshSketch, onAddPath, onTranslateProfile, onMoveHandle, onAddCurve, onCancelCurve, curveCreation = false, onPendingChange, onDrawingControls, onExitTool, onError, cancelSignal, interactionLocked: externalInteractionLocked = false, onControlsReady, viewLocked = false, navigationMode = 'mouse', onContextMenu, graphContextMenu, previewProfile, previewSketch, graphControls, inspection, dimensionControls, getFitArea, onViewFrame, viewControls, outlined = false, selectionFilter: sharedSelectionFilter, onSelectionFilterChange }: {
  sketch: CadSketchFeature | CadCurveFeature;
  parameters: Readonly<Record<string, number>>;
  documentVersion?: string;
  placementLabel?: string;
  tool: SketchTool;
  selectedProfileId: string | null;
  onSelectProfile(id: string | null): void;
  onAddProfile(geometry: CadProfile, signal?: AbortSignal): CadEditCompletion;
  onAddFreshSketch?(drawing: CadFreshSketchDrawing, signal?: AbortSignal): CadEditCompletion;
  onAddPath?(draft: CadPathDraft, closed: boolean, signal?: AbortSignal): CadEditCompletion;
  onTranslateProfile?(profileId: string, translation: SketchPoint, signal?: AbortSignal): CadEditCompletion;
  onMoveHandle?(profileId: string, handle: CadSketchHandle, translation: SketchPoint, signal?: AbortSignal): CadEditCompletion;
  onAddCurve?(segments: readonly CadPathSegment[], signal?: AbortSignal): CadEditCompletion;
  onCancelCurve?(): void;
  curveCreation?: boolean;
  onPendingChange(pending: boolean): void;
  /** The drawing's Escape and chain finish, and whether a pending chain could be saved open now, so a tool switch saves it first. */
  onDrawingControls?(controls: CadSketchDrawingControls | null, chainSavable: boolean): void;
  /** An Escape pressed while a chain was being saved leaves the tool once that save is accepted. */
  onExitTool?(): void;
  onError(message: string): void;
  cancelSignal: number;
  interactionLocked?: boolean;
  onControlsReady?(controls: CadRenderedViewControls | null, released?: CadRenderedViewControls): void;
  viewLocked?: boolean;
  navigationMode?: 'mouse' | 'trackpad';
  onContextMenu?(request: CadSketchContextMenuRequest): void;
  graphContextMenu?(selection: readonly CadSketchGraphSelection[]): readonly CadContextMenuItem[];
  previewProfile?: CadSketchProfile | null;
  previewSketch?: CadSketchFeature | null;
  graphControls?: CadSketchGraphControls;
  inspection?: { profileIds: readonly string[]; gear?: { profileId: string; inputName: string } };
  dimensionControls?: Pick<CadSketchDimensionControlsProps, 'document' | 'onEditMany' | 'onPendingChange' | 'interactionLocked' | 'onInspectInput' | 'onConfigure'>;
  getFitArea?: CadFitAreaReader;
  /** Each view the canvas draws, after a pan, zoom or resize. Pointer moves and edits never publish one. */
  onViewFrame?(frame: CadSketchViewFrame): void;
  /** More view controls for the sketch's row in the View drawer, such as how the part behind it shows. */
  viewControls?: ReactNode;
  /** Draws a dark under-stroke beneath the sketch geometry and drawing previews, for the bright faces of a part shown plainly behind the sketch. */
  outlined?: boolean;
  /** The shared selection filter, kept with the device preferences; without it the canvas keeps a filter of its own. */
  selectionFilter?: CadSelectionFilter;
  onSelectionFilterChange?(filter: CadSelectionFilter): void;
}) {

  const sketch = previewSketch && sourceSketch.kind === 'sketch' && previewSketch.id === sourceSketch.id ? previewSketch : sourceSketch;
  const isPreview = Boolean(previewProfile || sketch !== sourceSketch);
  const submission = useCadEditSubmission();
  const [graphPending, setGraphPending] = useState(false);
  const [boxPending, setBoxPending] = useState(false);
  // Whether the selection icon row found a place clear of the selection; without one the status line says where its commands are.
  const [selectionActionsRoom, setSelectionActionsRoom] = useState(true);
  const [ownSelectionFilter, setOwnSelectionFilter] = useState<CadSelectionFilter>(CAD_DEFAULT_SELECTION_FILTER);
  const selectionFilter = sharedSelectionFilter ?? ownSelectionFilter, changeSelectionFilter = onSelectionFilterChange ?? setOwnSelectionFilter;
  const pickFilter = cadSketchPickScope(selectionFilter);
  const filterOwner = useRef({ selectionFilter, changeSelectionFilter }); filterOwner.current = { selectionFilter, changeSelectionFilter };
  // An agent's sketch pick filter sets the points, edges and axes of the same filter.
  const setPickFilter = useCallback((pick: CadSketchGraphPickFilter) => filterOwner.current.changeSelectionFilter(cadSelectionFilterForSketchPick(filterOwner.current.selectionFilter, pick)), []);
  // The origin is a point and the axes are axes to the filter.
  const filterFixed = useMemo(() => CAD_SKETCH_FIXED_SELECTIONS.filter(item => cadSelectionAccepts(selectionFilter, item.kind === 'point' ? 'point' : 'axis')), [selectionFilter]);
  // A chain's summary, shown while the selection it made stays as it is.
  const [chainStatus, setChainStatus] = useState<{ readonly selection: readonly CadSketchGraphSelection[]; readonly text: string } | null>(null);
  // Where the pointer last was over the canvas, read only when Select other is asked for.
  const lastPointer = useRef<{ readonly clientX: number; readonly clientY: number } | null>(null);
  const [overlap, setOverlap] = useState<CadSketchOverlapPick | null>(null);
  const [pickHighlight, setPickHighlight] = useState<CadSketchGraphSelection | null>(null);
  const [snapChoice, setSnapChoice] = useState<DrawingSnapChoice | null>(null);
  const [choiceHighlight, setChoiceHighlight] = useState<CadSketchSnapCandidate | null>(null);
  const baseInteractionLocked = externalInteractionLocked || submission.applying || graphPending;
  const overlapPending = overlap !== null;
  const choicePending = snapChoice !== null;
  const interactionLocked = baseInteractionLocked || overlapPending || choicePending;
  /** A pending snap choice is only the chain's next point, so finishing a line chain drops it like a pending arc endpoint. */
  const chainFinishLocked = baseInteractionLocked || overlapPending;
  /** Select and Trim pick existing geometry; every other tool places new points. */
  const drawing = tool !== 'select' && tool !== 'trim';
  /** Line chains connected lines and three-point arcs in one draft until it is finished; `path`, Polyline's name, is its alias. */
  const chainTool = tool === 'line' || tool === 'path';
  /** Arc draws one segment of the path draft and saves it at once. */
  const singleSegment = tool === 'arc';
  const pathTool = chainTool || singleSegment;
  /** Where connected edges are saved a chain can stay open, so Escape, a double-click or leaving the tool saves its segments. */
  const chainOpen = chainTool && sourceSketch.kind === 'sketch' && Boolean(onAddPath);
  const idlePathDraft = () => createCadPathDraft(tool === 'arc' ? 'arc' : 'line');
  const svg = useRef<SVGSVGElement>(null);
  /** Hands focus back to the canvas; stable, so the icon row renders again only when its own inputs change. */
  const focusCanvas = useCallback(() => svg.current?.focus(), []);
  const host = useRef<HTMLDivElement>(null);
  const instructionsId = useId();
  const [picks, setPicks] = useState<readonly CadFreshSketchPick[]>([]);
  const points = useMemo(() => picks.map(pick => pick.point), [picks]);
  const [inferCoincidence, setInferCoincidence] = useState(true);
  const [pathDraft, setPathDraft] = useState(createCadPathDraft);
  const [cursorInput, setCursorInput] = useState<DrawingCursor>({ point: [0, 0], mode: 'position', snapSuppressed: false });
  const [center, setCenter] = useState<SketchPoint>([0, 0]);
  const [span, setSpan] = useState(160);
  const [aspect, setAspect] = useState(1.3);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const measuredAspect = useRef(aspect);
  const [snap, setSnap] = useState(true);
  // Sketching is free by default. The grid is a visual reference; snapping to it is an opt-in magnet.
  const [gridSnap, setGridSnap] = useState(false);
  const [grid, setGrid] = useState(true);
  const [gridStep, setGridStep] = useState(5);
  const profileDrag = useRef<CadSketchProfileDrag | null>(null);
  const [dragPreview, setDragPreview] = useState<{ profile: CadSketchProfile; translation: SketchPoint; handle: CadSketchHandle | null } | null>(null);
  const [detailSelection, setDetailSelection] = useState<CadSketchDetailSelection>({ kind: 'profile' });
  const activeHandle = detailSelection.kind === 'handle' ? detailSelection.target : null;
  const setActiveHandle = (target: CadSketchHandlePick | null) => setDetailSelection(target ? { kind: 'handle', target } : { kind: 'profile' });
  const ownedHandleEdit = useRef<{ readonly profileId: string; readonly handle: CadSketchHandle; readonly expectedText: string } | null>(null);
  const selectionRevision = useRef({ version: documentVersion, sketch });
  const [hoverHandle, setHoverHandle] = useState<CadSketchHandlePick | null>(null);
  const [fixedHover, setFixedHover] = useState<CadSketchGraphSelection | null>(null);
  // Points the pointer rested on while drawing; each one offers horizontal and vertical guides.
  const acquired = useRef<readonly SketchPoint[]>([]);
  // Trim previews the edge piece under the cursor against the exact accepted graph; a click removes it and Trim stays active.
  const [trimHover, setTrimHover] = useState<{ readonly prepared: CadSketchOverlapPick['prepared']; readonly preview: TrimPreview } | null>(null);
  const suppressProfileClick = useRef(false);
  /**
   * A primary press while drawing. The press places its pick at once; a drag past the slop then places the next pick on
   * release, so press-drag-release draws like two clicks. A held press places nothing until it is judged: one beside the
   * last placed point (`last`) draws from that point if it drags and places its pick on a plain release, and one that could
   * complete a double-click (`second`) places its own pick once it drags. `changes` is the draft change the press left.
   * A drag that starts an idle Line saves its one line on release.
   */
  const drawingPress = useRef<DrawingPlacement & { readonly pointerId: number; changes: number; readonly fromIdle: boolean;
    held: { readonly last: SketchPoint | null; readonly raw: SketchPoint; readonly scale: SketchPoint; readonly second: DrawingClick | null } | null; dragged: boolean } | null>(null);
  /**
   * The latest click while drawing, whether or not it placed a point, so a press there soon after reads as the second click
   * of a double-click. A press is a click only once it completes, so one that is cancelled, loses its capture before its
   * release or drags clears it, as does a press while drawing is paused, a tool change or a cancellation.
   */
  const lastClick = useRef<DrawingClick | null>(null);
  /** The open chain save in flight, and what runs once it is accepted: the workbench's next tool, or leaving the tool. */
  const chainSave = useRef<{ after?: () => void } | null>(null);
  /**
   * A plain-selection press on the origin or an axis. It selects the reference on release, so a press that travels past the
   * drag slop first still boxes or moves a profile exactly as it would away from the axes.
   */
  const fixedPress = useRef<{ readonly pointerId: number; readonly clientX: number; readonly clientY: number; readonly selection: CadSketchGraphSelection; readonly additive: boolean; readonly documentVersion: string | undefined; readonly sketchId: string; readonly cancelSignal: number; readonly frame: string } | null>(null);
  // An abandoned press still ends in the browser's click, which must not select or clear what lies under it. Its pointer is kept
  // until it lifts and only then arms the suppression, so a click another pointer finishes first cannot consume it.
  const abandonedPresses = useRef(new Set<number>());
  const dropFixedPress = useCallback(() => { if (!fixedPress.current) return; abandonedPresses.current.add(fixedPress.current.pointerId); fixedPress.current = null; }, []);
  /**
   * Counts drawing draft changes, whether the latest one added a point and whether it saved a chain. A press keeps its
   * release only while its own change is the latest, so a finished, rejected or ambiguous pick, or a cancel or keyboard pick
   * during the press, ends it.
   */
  const draftChanges = useRef({ count: 0, added: false, finished: false });
  const noteDraftChange = (added: boolean) => { draftChanges.current = { count: draftChanges.current.count + 1, added, finished: false }; };
  const pendingChange = useRef(onPendingChange);
  pendingChange.current = onPendingChange;
  const edgeSubmission = useRef<CadSketchOverlapPick | null>(null);
  const cancelEdgeSubmission = useCallback(() => {
    if (!edgeSubmission.current) return;
    edgeSubmission.current = null; submission.cancel(); pendingChange.current(false);
  }, [submission.cancel]);
  useEffect(() => {
    window.addEventListener('blur', cancelEdgeSubmission);
    return () => window.removeEventListener('blur', cancelEdgeSubmission);
  }, [cancelEdgeSubmission]);
  const finishProfileDrag = useCallback((pointerId?: number, retainPreview = false) => {
    const active = profileDrag.current;
    if (!active || pointerId !== undefined && pointerId !== active.pointerId) return null;
    profileDrag.current = null;
    if (!retainPreview) {
      setDragPreview(null);
      if (active.moved) pendingChange.current(false);
    }
    try { if (active.element.hasPointerCapture?.(active.pointerId)) active.element.releasePointerCapture(active.pointerId); }
    catch { /* Capture may have ended before the cancellation event reached React. */ }
    return active;
  }, []);
  useEffect(() => {
    // Losing the window ends a press on the origin or an axis without selecting it, as it ends a profile drag.
    const blurred = () => { dropFixedPress(); finishProfileDrag(); };
    window.addEventListener('blur', blurred);
    return () => { window.removeEventListener('blur', blurred); dropFixedPress(); finishProfileDrag(); };
  }, [dropFixedPress, finishProfileDrag]);
  const pan = useRef<{ x: number; y: number; center: SketchPoint; pointerId: number; button: number; buttonMask: number; moved: boolean; element: SVGSVGElement; dimension: CadSketchDimensionPick | null; dimensionLine: boolean; relations: readonly CadSketchDimensionPick[] | null } | null>(null);
  const finishPan = useCallback((pointerId?: number) => {
    const active = pan.current;
    if (!active || pointerId !== undefined && pointerId !== active.pointerId) return;
    pan.current = null;
    try { if (active.element.hasPointerCapture?.(active.pointerId)) active.element.releasePointerCapture(active.pointerId); }
    catch { /* Capture may already have ended when the browser cancelled the pointer. */ }
  }, []);
  useEffect(() => {
    const blurred = () => finishPan();
    window.addEventListener('blur', blurred);
    return () => { window.removeEventListener('blur', blurred); finishPan(); };
  }, [finishPan]);
  const profiles = useMemo(() => sketch.kind === 'sketch' ? sketch.profiles.map(profile => previewProfile?.id === profile.id ? previewProfile : profile) : NO_PROFILES, [sketch, previewProfile]);
  const graphSourceParameters = graphControls?.document.parameters ?? parameters;
  const attachedSource = useRef<{ readonly sketch: typeof sourceSketch; readonly version: typeof documentVersion;
    readonly parameters: typeof graphSourceParameters; readonly document: CadSketchGraphControls['document'] | undefined } | null>(null);
  const pendingPicks = useMemo(() => pathTool ? cadPathDraftPicks(pathDraft) : picks.filter(pick => pick.kind !== 'position'), [pathTool, pathDraft, picks]);
  useLayoutEffect(() => { if (!pendingPicks.some(referencesSource)) attachedSource.current = null; }, [pendingPicks]);
  const attachedSourceCurrent = () => {
    const owned = attachedSource.current;
    if (!owned || owned.sketch === sourceSketch && owned.version === documentVersion && owned.parameters === graphSourceParameters && owned.document === graphControls?.document) return true;
    onError('The sketch changed. Cancel this drawing or release its pending relations before continuing.');
    return false;
  };
  const sourceGraph = useMemo(() => sourceSketch.kind === 'sketch' && sourceSketch.graph ? prepareCadSketchGraphInteraction(sourceSketch.graph, graphSourceParameters) : null, [sourceSketch, graphSourceParameters]);
  const geometryPick = graphControls?.geometryPick;
  const placedByPick = geometryPick?.placed;
  useLayoutEffect(() => {
    const canvas = svg.current, focused = document.activeElement;
    if (placedByPick && canvas && focused instanceof Element && focused !== canvas && canvas.contains(focused)) canvas.focus({ preventScroll: true });
  }, [placedByPick]);
  // A pick or lock can take the tab stop from what has focus, as an axis loses it once it takes no more picks. Focus then moves to the
  // canvas, where the pick's keys still work, instead of staying on an element outside the tab order. Chrome instead drops focus from the
  // page while the render removes the tab stop, when React dispatches no blur, so a native listener returns it to the canvas.
  useLayoutEffect(() => {
    const canvas = svg.current, focused = document.activeElement;
    if (canvas && focused instanceof SVGElement && focused !== canvas && canvas.contains(focused) && !focused.hasAttribute('tabindex')) canvas.focus({ preventScroll: true });
  });
  useEffect(() => {
    const canvas = svg.current; if (!canvas) return;
    const lost = (event: FocusEvent) => {
      const target = event.target;
      if (target !== canvas && event.relatedTarget === null && target instanceof SVGElement && !target.hasAttribute('tabindex')) canvas.focus({ preventScroll: true });
    };
    canvas.addEventListener('focusout', lost); return () => canvas.removeEventListener('focusout', lost);
  }, []);
  const positionPick = graphControls?.positionPick;
  const placement = graphControls?.placement;
  const placementAngle = placement ? `${placement.angleDegrees > 0 ? '+' : ''}${formatCadQuantity(placement.angleDegrees)}°` : '';
  const graphPickFilter = geometryPick
    ? geometryPick.eligiblePointIds.length ? geometryPick.eligibleEntityIds.length ? 'auto' : 'points' : 'edges'
    : pickFilter;
  const graphPicks = (point: SketchPoint, millimetersPerPixel: number) => {
    const hits = sourceGraph?.pick(point, millimetersPerPixel, graphPickFilter) ?? [];
    return geometryPick ? hits.filter(hit => cadSketchGeometryPickAllows(geometryPick, hit)) : hits;
  };
  // The origin and the axes join a pick only when its owner lists them as eligible, found once per pick, so a pointer move tests at most three.
  const pickFixed = useMemo(() => geometryPick ? cadSketchFixedEligible(geometryPick) : null, [geometryPick]);
  const fixedPick = pickFixed?.length ? geometryPick : undefined;
  // In plain selection the origin and axes are selected like sketch geometry, as CATIA selects its H and V axes.
  const fixedSelect = !geometryPick && !positionPick && tool === 'select' && graphControls?.onSelectSet ? graphControls : undefined;
  const fixedEligible = fixedPick ? pickFixed ?? undefined : fixedSelect ? filterFixed : undefined;
  const fixedAt = (point: SketchPoint, millimetersPerPixel: number) => fixedEligible ? pickCadSketchFixedElement(point, millimetersPerPixel, fixedEligible) : null;
  /**
   * Sketch geometry, profile grips and profile edges keep their picks where an axis crosses them; the axes take the rest of
   * their length. `covered` is what the caller already found under the pointer, so the reference test runs only when that
   * hit test found nothing, and only a pointer within reach of a reference measures the profile edges near it.
   */
  const fixedUnder = (point: SketchPoint, millimetersPerPixel: number, covered: boolean) => {
    const fixed = covered ? null : fixedAt(point, millimetersPerPixel);
    return fixed && fixedSelect && pickFilter === 'auto' && profilePicker.edgeNear(point, millimetersPerPixel) ? null : fixed;
  };
  const chooseFixed = (selection: CadSketchGraphSelection, additive: boolean) => { if (fixedPick) fixedPick.onPick(selection); else fixedSelect?.onSelect(selection, additive); };
  const selectGraphHit = (hit: CadSketchGraphSelection, additive = false) => {
    if (geometryPick) { if (cadSketchGeometryPickAllows(geometryPick, hit)) geometryPick.onPick(hit); }
    else graphControls?.onSelect(hit, additive);
  };
  const sourceProfiles = sourceSketch.kind === 'sketch' ? sourceSketch.profiles : NO_PROFILES;
  const profileSnapSources = useMemo(() => prepareCadSketchProfilePositionSnaps({ profiles: sourceProfiles, parameters: graphSourceParameters }), [sourceProfiles, graphSourceParameters]);
  // Snaps read no placement, so moving a dimension keeps them.
  const snapGraph = sourceGraph ? cadSketchGraphPlacedFrom(sourceGraph.graph) : null, snapPoints = sourceGraph?.points, snapSegments = sourceGraph?.geometry.segments;
  const drawingSnaps = useMemo(() => prepareCadSketchGeometrySnaps(snapGraph && snapPoints && snapSegments ? { graph: snapGraph, points: snapPoints, segments: snapSegments } : undefined,
    profileSnapSources), [snapGraph, snapPoints, snapSegments, profileSnapSources]);
  const visualGraph = useMemo(() => sketch === sourceSketch && parameters === graphSourceParameters ? sourceGraph
    : sketch.kind === 'sketch' && sketch.graph ? prepareCadSketchGraphInteraction(sketch.graph, parameters) : null, [sketch, sourceSketch, parameters, graphSourceParameters, sourceGraph]);
  const graphGeometry = useMemo(() => visualGraph && sketch.kind === 'sketch' ? { ...visualGraph.geometry, constructionIds: new Set(sketch.graph?.entities.filter(entity => entity.construction).map(entity => entity.id)) } : null, [visualGraph, sketch]);
  const inspectedGear = inspection?.gear ? profiles.find(profile => profile.id === inspection.gear?.profileId) : null;
  const savedCurve = useMemo(() => {
    if (sketch.kind !== 'curve' || !sketch.segments.length) return null;
    try { return resolveCadCurveGeometry(sketch, parameters); } catch { return null; }
  }, [sketch, parameters]);
  const profilePicker = useMemo(() => createCadSketchProfilePicker(profiles, parameters), [profiles, parameters]);
  const handlePicker = useMemo(() => createCadSketchHandlePicker(profiles, parameters), [profiles, parameters]);
  const handleProfile = dragPreview?.profile ?? profiles.find(profile => profile.id === selectedProfileId);
  const previewHandlePicker = useMemo(() => dragPreview ? createCadSketchHandlePicker([dragPreview.profile], parameters) : handlePicker, [dragPreview, parameters, handlePicker]);
  const visibleHandles = previewHandlePicker.handles.filter(handle => handle.profileId === handleProfile?.id);
  const displayHandles = hoverHandle && hoverHandle.profileId !== handleProfile?.id ? [...visibleHandles, hoverHandle] : visibleHandles;
  useLayoutEffect(() => { finishPan(); }, [documentVersion, interactionLocked, cancelSignal, sketch.id, profilePicker, finishPan]);
  useLayoutEffect(() => { dropFixedPress(); finishProfileDrag(); }, [documentVersion, sketch, parameters, tool, interactionLocked, cancelSignal, previewProfile, center, span, aspect, snap, gridSnap, gridStep, navigationMode, dropFixedPress, finishProfileDrag]);
  useLayoutEffect(() => {
    if (profileDrag.current && profileDrag.current.profile.id !== selectedProfileId) finishProfileDrag();
    setDetailSelection(current => current.kind === 'handle' && current.target.profileId === selectedProfileId ? current : { kind: 'profile' });
  }, [selectedProfileId, finishProfileDrag]);
  useLayoutEffect(() => {
    const previous = selectionRevision.current;
    if (previous.version === documentVersion && previous.sketch === sketch) return;
    selectionRevision.current = { version: documentVersion, sketch };
    const owned = ownedHandleEdit.current;
    ownedHandleEdit.current = null; setHoverHandle(null);
    const profile = owned && profiles.find(profile => profile.id === owned.profileId);
    const next = owned && profile && JSON.stringify(profile) === owned.expectedText
      ? handlePicker.handles.find(grip => grip.profileId === owned.profileId && cadSketchHandleKey(grip.handle) === cadSketchHandleKey(owned.handle)) : null;
    setDetailSelection(next ? { kind: 'handle', target: next } : { kind: 'none' });
  }, [documentVersion, sketch, profiles, handlePicker]);
  useEffect(() => { edgeSubmission.current = null; chainSave.current = null; submission.cancel(); setHoverHandle(null); setDetailSelection({ kind: 'profile' }); ownedHandleEdit.current = null; setDragPreview(null); }, [sketch.id, tool, cancelSignal, submission.cancel]);
  const width = span * aspect;
  const overlayFrame = useMemo(() => cadSketchViewFrame(center, width, span, viewportSize.height), [center, width, span, viewportSize.height]);
  // The under-stroke is the sketch stroke widened by a pixel on each side; 0 draws none.
  const halo = outlined ? span / 450 + 2 * span / (viewportSize.height || 600) : 0;
  const publishViewFrame = useRef(onViewFrame);
  publishViewFrame.current = onViewFrame;
  // Published before paint, so a view behind the canvas moves in the same frame as the canvas.
  useLayoutEffect(() => { publishViewFrame.current?.(overlayFrame); }, [overlayFrame, onViewFrame]);
  const drawingCandidate = (candidate: CadSketchSnapCandidate): DrawingPick => ({ point: candidate.point, candidate });
  const resolveDrawingPick = (raw: SketchPoint, snapSuppressed: boolean, mode: DrawingCursor['mode'], mmPerPixel: SketchPoint = [width / viewportSize.width, span / viewportSize.height]): DrawingPick => {
    if (snapSuppressed || mode === 'position') return { point: raw };
    // A chain's start is a target once a segment leaves it; before that it would only give a zero-length segment.
    const draftStart = !positionPick && chainTool && pathDraft.kind === 'ready' && pathDraft.segments.length ? { point: pathDraft.start } : undefined;
    if (drawing || positionPick) {
      if (draftStart) {
        // Returning to the chain's own start is explicit closing intent,
        // independent of other saved points at that same position.
        const closure = snapDraftStart({ cursor: raw, mmPerPixel, draftStart });
        if (closure.kind === 'hit') return { point: closure.candidate.point, candidate: closure.candidate };
      }
      const result = (snap ? drawingSnaps : snapDraftStart)({ cursor: raw, mmPerPixel, draftStart, references: snap, alignTo: snap ? alignSources() : undefined });
      if (result.kind === 'ambiguous') return { point: raw, candidates: result.candidates };
      // A grid the user asked to snap to outranks positions along a curve or guide, never a point.
      if (result.kind === 'hit' && !(gridSnap && SNAP_PLACEMENTS.has(result.candidate.target.kind) && gridNode(raw, mmPerPixel))) return drawingCandidate(result.candidate);
    }
    return { point: gridNode(raw, mmPerPixel) ?? raw };
  };
  const gridNode = (raw: SketchPoint, mmPerPixel: SketchPoint): SketchPoint | null => {
    const point = magnetSketchPoint(raw, gridStep, gridSnap, DRAG_GRID_CATCH_PIXELS * Math.max(mmPerPixel[0], mmPerPixel[1]));
    return point === raw ? null : point;
  };
  // Inference guides start from the drawing's own placed points and the points the pointer recently rested on.
  // The draft's own points change only with the draft, never per pointer move.
  const ownAlignSources = useMemo((): readonly SketchPoint[] => positionPick ? [] : pathTool ? pathDraft.kind === 'idle' ? []
    : [pathDraft.start, ...pathDraft.segments.map(segment => segment.end), ...(pathDraft.kind === 'arc-through' ? [pathDraft.end] : [])]
    // A rectangle's own first corner would only offer a zero-height or zero-width rectangle.
    : tool === 'rectangle' ? [] : points, [positionPick, pathTool, pathDraft, tool, points]);
  const alignSources = (): readonly SketchPoint[] => acquired.current.length ? [...ownAlignSources, ...acquired.current] : ownAlignSources;
  const cursorPick = resolveDrawingPick(cursorInput.point, cursorInput.snapSuppressed, cursorInput.mode);
  const cursor = cursorPick.point;
  const snapHint = (drawing || positionPick) && !interactionLocked ? cursorPick.candidate : undefined;
  // Snapped picks can become relations only where the drawing is saved as connected edges.
  const graphDrawing = sourceSketch.kind === 'sketch' && (pathTool ? Boolean(onAddPath) : (tool === 'rectangle' || tool === 'circle' || tool === 'slot') && Boolean(onAddFreshSketch));
  const canInfer = !positionPick && graphDrawing;
  // A circle's radius, a slot's width and an arc's through point only shape the drawing.
  const inferring = canInfer && inferCoincidence && !(tool === 'circle' && picks.length) && !(tool === 'slot' && picks.length > 1) && !(pathTool && pathDraft.kind === 'arc-through');
  const inferencePoint = inferring && snapHint && 'pointId' in snapHint.target ? snapHint.target.pointId : undefined;
  const inferenceRelation = inferring && snapHint ? cadSketchSnapRelation(snapHint.target) : null;
  // A line ending on its own start's guide keeps that relation; a return to the chain start closes it instead.
  const lineInference = (candidate: CadSketchSnapCandidate | undefined, point: SketchPoint) => inferring && pathTool && pathDraft.kind === 'ready' && pathDraft.mode === 'line'
    && candidate && (point[0] !== pathDraft.start[0] || point[1] !== pathDraft.start[1]) ? cadSketchDrawingInference(candidate.target, cadPathDraftEndpoint(pathDraft), point) : null;
  const inferredAxis = snapHint ? lineInference(snapHint, snapHint.point) : null;
  const snapLabel = inferencePoint ? `Coincident with Point ${(sourceGraph?.graph.points.findIndex(point => point.id === inferencePoint) ?? -1) + 1}`
    : snapHint ? snapHint.target.kind === 'profile-position' ? `${cadSketchProfileSnapLabel(snapHint.target, sourceProfiles)} · Position only · No relation`
    : snapHint.target.kind === 'draft-start' ? sketch.kind === 'curve' ? 'Curve start'
      : pathDraft.kind === 'ready' && pathDraft.segments.length > (pathDraft.mode === 'line' ? 1 : 0) ? 'Close chain' : 'Chain start'
    : 'pointId' in snapHint.target || snapHint.target.kind === 'midpoint' ? `${snapHint.target.kind[0].toUpperCase()}${snapHint.target.kind.slice(1)} position · No relation`
    : inferredAxis ? cadSketchDrawingInferenceLabel(snapHint.target, inferredAxis)
    : `${cadSketchSnapTargetLabel(snapHint.target)} · ${inferenceRelation ?? 'No relation'}` : '';
  const snapHighlight: CadSketchGraphSelection | null = snapHint && 'pointId' in snapHint.target ? { kind: 'point', id: snapHint.target.pointId }
    : snapHint && 'entityId' in snapHint.target ? { kind: 'entity', id: snapHint.target.entityId } : null;
  // The graph layer is memoized: its highlight keeps its identity while the cursor stays on the same target.
  const highlightKind = (snapHighlight ?? pickHighlight)?.kind, highlightId = (snapHighlight ?? pickHighlight)?.id;
  const graphHighlight = useMemo((): CadSketchGraphSelection | null => highlightKind && highlightId !== undefined ? { kind: highlightKind, id: highlightId } : null, [highlightKind, highlightId]);
  useEffect(() => {
    if (!drawing && !positionPick) return;
    const modifiers = (event: KeyboardEvent) => {
      if (event.isComposing || event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      setCursorInput(current => current.snapSuppressed === (event.ctrlKey || event.metaKey) ? current : { ...current, snapSuppressed: event.ctrlKey || event.metaKey });
    };
    const blur = () => setCursorInput(current => ({ ...current, mode: 'position', snapSuppressed: false }));
    window.addEventListener('keydown', modifiers); window.addEventListener('keyup', modifiers); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', modifiers); window.removeEventListener('keyup', modifiers); window.removeEventListener('blur', blur); };
  }, [tool, positionPick]);
  const navigation = useRef({ center, span, aspect, viewLocked, navigationMode });
  navigation.current = { center, span, aspect, viewLocked, navigationMode };
  useLayoutEffect(() => { finishPan(); if (viewLocked && !profileDrag.current?.moved) finishProfileDrag(); }, [viewLocked, navigationMode, finishPan, finishProfileDrag]);
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      // React delegates wheel with a passive listener. A native non-passive
      // listener confines browser pinch/scroll prevention to the drawing surface.
      event.preventDefault();
      const current = navigation.current, rect = element.getBoundingClientRect();
      if (current.viewLocked || pan.current || profileDrag.current || !rect.width || !rect.height) return;
      const pixels = (delta: number, extent: number) => Number.isFinite(delta) ? Math.max(-2 * extent, Math.min(2 * extent, delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? extent : 1))) : 0;
      const x = pixels(event.deltaX, rect.width), y = pixels(event.deltaY, rect.height);
      let nextCenter: SketchPoint, nextSpan = current.span;
      if (current.navigationMode === 'trackpad' && !event.ctrlKey) {
        nextCenter = [current.center[0] + x / rect.width * current.span * current.aspect, current.center[1] - y / rect.height * current.span];
      } else {
        if (!y) return;
        nextSpan = Math.max(.1, Math.min(100000, current.span * Math.exp(Math.max(-1, Math.min(1, y * .001)))));
        const cursorX = (event.clientX - rect.left) / rect.width - .5, cursorY = .5 - (event.clientY - rect.top) / rect.height;
        nextCenter = [current.center[0] + cursorX * current.aspect * (current.span - nextSpan), current.center[1] + cursorY * (current.span - nextSpan)];
      }
      navigation.current = { ...current, center: nextCenter, span: nextSpan };
      setCenter(nextCenter); setSpan(nextSpan);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, []);
  const renderedPlane = useMemo(() => typeof sketch.plane === 'string' ? sketch.plane : Object.freeze({ ...sketch.plane }), [sketch.plane]);
  // The draft is immutable, so its identity stands for it in the view signature instead of serialising a long chain per move.
  const draftRevision = useRef({ draft: pathDraft, revision: 0 });
  if (draftRevision.current.draft !== pathDraft) draftRevision.current = { draft: pathDraft, revision: draftRevision.current.revision + 1 };
  const viewRevision = useRef({ signature: '', revision: 0 });
  const viewSignature = JSON.stringify([sketch.plane, center, span, aspect, grid, snap, gridSnap, gridStep, pickFilter, boxPending, graphPending, pickHighlight, choicePending,
    choiceHighlight ? [choiceHighlight.target, choiceHighlight.point, choiceHighlight.entityIds] : null,
    overlap ? [overlap.clientX, overlap.clientY, overlap.target, overlap.split, overlap.trim, overlap.extend, overlap.extendEnds, overlap.extendEnd, overlap.action] : null, drawing || positionPick ? [cursor, picks, draftRevision.current.revision] : null, tool === 'trim' ? trimHover?.preview : null,
    snapHint ? [snapHint.target, snapHint.point, snapLabel] : null, previewProfile?.geometry, previewSketch ? [previewSketch.profiles, previewSketch.graph] : null,
    graphControls ? [graphControls.selection, graphControls.relation, graphControls.inspection, graphControls.degreesOfFreedom, graphControls.definition?.revision, graphControls.definitionLocked, graphControls.diagnosis?.revision, graphControls.showDimensions, placement] : null, inspection, dragPreview?.translation]);
  if (viewRevision.current.signature !== viewSignature) { viewRevision.current = { signature: viewSignature, revision: viewRevision.current.revision + 1 }; }
  const currentView = useRef<CadRenderedViewState>({ mode: sketch.kind, available: false, plane: renderedPlane, gridVisible: grid, snapEnabled: snap, gridSnapEnabled: gridSnap, gridStepMm: gridStep, centerMm: center, heightSpanMm: span, revision: viewRevision.current.revision });
  currentView.current = Object.freeze({ mode: sketch.kind, available: Boolean(svg.current), plane: renderedPlane, gridVisible: grid, snapEnabled: snap, gridSnapEnabled: gridSnap, gridStepMm: gridStep, centerMm: Object.freeze([...center] satisfies [number, number]), heightSpanMm: span, revision: viewRevision.current.revision, ...(sketch.kind === 'sketch' && pickFilter !== 'none' ? { sketchPickFilter: pickFilter } : {}) });
  const fitView = useRef<(() => void) | null>(null);
  const initialCursorFit = useRef(false);
  useLayoutEffect(() => {
    const container = host.current;
    if (!container) return;
    const measure = () => { if (container.clientWidth && container.clientHeight) { measuredAspect.current = container.clientWidth / container.clientHeight; setAspect(measuredAspect.current); setViewportSize({ width: container.clientWidth, height: container.clientHeight }); } };
    // Commit the actual aspect before another task can see capture availability.
    // ResizeObserver's first asynchronous delivery then repeats this measurement.
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const controls: CadRenderedViewControls = {
      getState: () => Object.freeze({ ...currentView.current, available: Boolean(svg.current) }),
      fit: () => fitView.current?.(),
      setGrid: setGrid,
      ...(sketch.kind === 'sketch' ? { setSketchPickFilter: setPickFilter } : {}),
      async capture(signal) {
        signal.throwIfAborted();
        const element = svg.current;
        if (!element) throw new ToolError('CAPTURE_UNAVAILABLE', 'Open a visible sketch first.');
        const revision = currentView.current.revision;
        const image = await captureSvgPreview(element, signal);
        signal.throwIfAborted();
        if (svg.current !== element || currentView.current.revision !== revision) throw new ToolError('STALE_VIEW', 'The sketch view changed during capture. Capture the current view again.');
        return image;
      },
    };
    onControlsReady?.(controls);
    return () => onControlsReady?.(null, controls);
  }, [onControlsReady]);
  useEffect(() => {
    setPicks([]); setPathDraft(createCadPathDraft(tool === 'arc' ? 'arc' : 'line')); setTrimHover(null);
    // The press and click history, including a click spent by a chain save, belong to their tool and cancellation. A chain
    // save changes neither, so its spent click outlives the save's acceptance.
    drawingPress.current = null; lastClick.current = null; noteDraftChange(false);
  }, [sketch.id, tool, cancelSignal]);
  // The first revision after this canvas submits an edit is that edit's own, so a chain save keeps the click it spent. Any other
  // revision, such as an undo, a redo or an agent edit, forgets the clicks before it: a press there soon after is an ordinary
  // click, also one still held, and nothing the document no longer holds is spent.
  const ownRevision = useRef(false), historyVersion = useRef(documentVersion);
  useEffect(() => {
    if (historyVersion.current === documentVersion) return;
    historyVersion.current = documentVersion;
    if (ownRevision.current) { ownRevision.current = false; return; }
    lastClick.current = null; draftChanges.current = { ...draftChanges.current, finished: false };
    const press = drawingPress.current;
    if (press?.held?.second) press.held = { ...press.held, second: null };
  }, [documentVersion]);
  useLayoutEffect(() => { setCursorInput(current => ({ ...current, mode: 'position' })); }, [sourceSketch, graphSourceParameters, tool, cancelSignal, center, span, aspect]);
  // Acquired points are positions, so a revision or a parameter change can move what they came from, also
  // where the sketch keeps its object.
  useEffect(() => { acquired.current = []; }, [sourceSketch, graphSourceParameters, documentVersion, tool, cancelSignal]);
  const pathPending = pathTool && pathDraft.kind !== 'idle';
  useLayoutEffect(() => { onPendingChange(points.length > 0 || pathPending || dragPreview !== null || submission.applying || graphPending || boxPending || overlapPending || choicePending); }, [points.length, pathPending, dragPreview !== null, submission.applying, graphPending, boxPending, overlapPending, choicePending, onPendingChange]);
  const publishGraphPending = useCallback((value: boolean) => {
    setGraphPending(value); pendingChange.current(value || points.length > 0 || pathPending || dragPreview !== null || submission.applying || boxPending || overlapPending || choicePending);
  }, [points.length, pathPending, dragPreview !== null, submission.applying, boxPending, overlapPending, choicePending]);
  const publishBoxPending = useCallback((value: boolean) => {
    setBoxPending(value); pendingChange.current(value || points.length > 0 || pathPending || dragPreview !== null || submission.applying || graphPending || overlapPending || choicePending);
  }, [points.length, pathPending, dragPreview !== null, submission.applying, graphPending, overlapPending, choicePending]);
  const getRawPoint = (event: { clientX: number; clientY: number }): SketchPoint | null => {
    const rect = svg.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    return [center[0] + (event.clientX - rect.left - rect.width / 2) / rect.width * width, center[1] - (event.clientY - rect.top - rect.height / 2) / rect.height * span];
  };
  const trimAt = (event: { clientX: number; clientY: number }): TrimPreview | null => {
    const point = getRawPoint(event), rect = svg.current?.getBoundingClientRect();
    if (tool !== 'trim' || !sourceGraph || !graphControls || sourceSketch.kind !== 'sketch' || isPreview || !point || !rect?.height) return null;
    const edge = sourceGraph.pick(point, span / rect.height, 'edges').find(hit => hit.kind === 'entity');
    return edge ? prepareCadSketchTrimPreview(sourceGraph, sourceSketch.id, edge.id, point) : null;
  };
  const trimEdge = (event: { clientX: number; clientY: number }) => {
    const preview = interactionLocked || viewLocked ? null : trimAt(event);
    if (preview?.kind !== 'ready' || !graphControls) return;
    const { edit } = preview; setTrimHover(null);
    submitEdit(signal => graphControls.onEditMany([edit], signal), () => undefined, 'Unable to trim this edge.');
  };
  const spatialFrameKey = JSON.stringify([renderedPlane, center, span, aspect, viewportSize]);
  const projectSelection = (event: { clientX: number; clientY: number }) => {
    const point = getRawPoint(event), rect = svg.current?.getBoundingClientRect();
    return point && rect ? { point, frame: JSON.stringify([renderedPlane, center, span, rect.left, rect.top, rect.width, rect.height]) } : null;
  };
  // Identity pins the complete accepted source, unfinished drawing and camera.
  // Cursor movement over the menu does not change the captured drawing intent.
  const drawingOwner = useMemo(() => ({ sourceSketch, drawingSnaps, parameters: graphSourceParameters, document: graphControls?.document,
    documentVersion, tool, picks, pathDraft, inferCoincidence, snap, gridSnap, gridStep, cancelSignal, spatialFrameKey, positionPick,
    pathAvailable: Boolean(onAddPath), freshAvailable: Boolean(onAddFreshSketch) }),
  [sourceSketch, drawingSnaps, graphSourceParameters, graphControls?.document, documentVersion, tool, picks, pathDraft, inferCoincidence, snap, gridSnap, gridStep, cancelSignal, spatialFrameKey, positionPick, Boolean(onAddPath), Boolean(onAddFreshSketch)]);
  const choiceEnvironment = useRef({ owner: drawingOwner, locked: false });
  // Our own drawing pending locks navigation; viewLocked must not dismiss its chooser.
  choiceEnvironment.current = { owner: drawingOwner, locked: baseInteractionLocked || overlapPending || isPreview };
  const choiceIsCurrent = (choice: DrawingSnapChoice) => choice.owner === choiceEnvironment.current.owner && !choiceEnvironment.current.locked
    && projectSelection(choice)?.frame === choice.frame;
  const currentSnapChoice = snapChoice && choiceIsCurrent(snapChoice) ? snapChoice : null;
  const profileSnapTarget = (currentSnapChoice ? choiceHighlight : snapHint)?.target;
  const snapProfile = profileSnapTarget?.kind === 'profile-position' ? sourceProfiles.find(profile => profile.id === profileSnapTarget.profileId) : undefined;
  const choicePointId = choiceHighlight && 'pointId' in choiceHighlight.target ? choiceHighlight.target.pointId : undefined;
  const closeSnapChoice = useCallback(() => { setSnapChoice(null); setChoiceHighlight(null); svg.current?.focus({ preventScroll: true }); }, []);
  useLayoutEffect(() => { if (snapChoice && !currentSnapChoice) closeSnapChoice(); }, [snapChoice, currentSnapChoice, closeSnapChoice]);
  useLayoutEffect(() => {
    const owned = edgeSubmission.current;
    if (owned && (externalInteractionLocked || isPreview || owned.frameKey !== spatialFrameKey || projectSelection(owned)?.frame !== owned.frame)) cancelEdgeSubmission();
  });
  const boxSelection = useCadSketchBoxSelection({ prepared: sourceGraph, enabled: tool === 'select' && !geometryPick && !positionPick && !isPreview && sketch.kind === 'sketch', locked: interactionLocked,
    version: documentVersion, cancelSignal, frameKey: spatialFrameKey, filter: pickFilter,
    selection: graphControls?.selection ?? [], onSelectSet: graphControls?.onSelectSet, onPendingChange: publishBoxPending, onError,
    onCancel: () => { suppressProfileClick.current = true; },
    project: projectSelection });
  const boxSelections = boxSelection.box?.selections;
  const dimensionStatus = tool === 'select' && sourceSketch.kind === 'sketch' ? cadSketchDimensionSelectionStatus(sourceSketch.graph, graphControls?.dimensionSelection ?? []) : null;
  // Moving a dimension leaves the relation marks as they are.
  const relationsShown = Boolean(graphControls) && graphControls?.showRelations !== false, sourceGraphValue = sourceSketch.kind === 'sketch' && sourceSketch.graph ? cadSketchGraphPlacedFrom(sourceSketch.graph) : undefined;
  const glyphCount = useMemo(() => relationsShown && sourceGraphValue ? countCadSketchRelationGlyphs(sourceGraphValue) : 0, [relationsShown, sourceGraphValue]);
  const glyphStatus = tool === 'select' && glyphCount > CAD_SKETCH_RELATION_GLYPH_LIMIT ? `Relations shown on selected or hovered geometry · ${glyphCount} marks in this sketch` : null;
  // The selection icon row hides while drawing, dragging or committing a drag; an edit or operation elsewhere, such as a press of the row itself,
  // leaves it in place, inactive, so focus on it survives the edit.
  const selectionActionsShown = Boolean(graphControls?.selectionActions && sourceGraph && tool === 'select' && !geometryPick && !positionPick && !isPreview && !boxPending
    && !graphPending && !submission.applying && dragPreview === null && points.length === 0 && !pathPending);
  const roomStatus = selectionActionsShown && !selectionActionsRoom ? 'No room beside the selection for its relation icons · Constrain and Dimension apply the same' : null;
  const chainStatusText = chainStatus && graphControls && cadSketchGraphSelectionsEqual(chainStatus.selection, graphControls.selection) ? chainStatus.text : null;
  const contextStatus = [chainStatusText, dimensionStatus, glyphStatus, roomStatus].filter(Boolean).join(' · ') || null;
  const layerControls = useMemo(() => graphControls && boxSelections ? { ...graphControls, selection: boxSelections } : graphControls, [graphControls, boxSelections]);
  const graphPickAt = useRef<(event: { clientX: number; clientY: number }) => CadSketchGraphSelection | null>(() => null);
  graphPickAt.current = event => { const point = getRawPoint(event), rect = svg.current?.getBoundingClientRect(); return point && rect?.height ? graphPicks(point, span / rect.height)[0] ?? null : null; };
  const pickGraphAt = useCallback((event: { clientX: number; clientY: number }) => graphPickAt.current(event), []);
  const overlapEnvironment = useRef({ sourceGraph, document: graphControls?.document, documentVersion, cancelSignal, geometryPick, pickFilter, spatialFrameKey, selection: graphControls?.selection, allowed: false });
  overlapEnvironment.current = { sourceGraph, document: graphControls?.document, documentVersion, cancelSignal, geometryPick, pickFilter, spatialFrameKey, selection: graphControls?.selection,
    allowed: tool === 'select' && !positionPick && !isPreview && !baseInteractionLocked };
  const overlapIsCurrent = (owned: CadSketchOverlapPick) => {
    const current = overlapEnvironment.current;
    return current.allowed && owned.prepared === current.sourceGraph && owned.document === current.document && owned.version === current.documentVersion
      && owned.cancelSignal === current.cancelSignal && owned.geometryPick === current.geometryPick && owned.filter === current.pickFilter && owned.frameKey === current.spatialFrameKey
      && cadSketchGraphSelectionsEqual(owned.selection, current.selection ?? []) && projectSelection(owned)?.frame === owned.frame;
  };
  const currentOverlap = overlap && overlapIsCurrent(overlap) ? overlap : null;
  const closeOverlap = useCallback(() => { setOverlap(null); setPickHighlight(null); }, []);
  useLayoutEffect(() => { if (overlap && !currentOverlap) closeOverlap(); }, [overlap, currentOverlap, closeOverlap]);
  const openOverlap = (event: { clientX: number; clientY: number; shiftKey?: boolean }, trigger: 'pointer' | 'keyboard' = 'pointer', focusedAtom?: CadSketchGraphSelection) => {
    const projection = projectSelection(event), rect = svg.current?.getBoundingClientRect();
    if (!sourceGraph || !graphControls || !projection || !rect?.height || tool !== 'select' || isPreview || interactionLocked) return false;
    const candidates = graphPicks(projection.point, span / rect.height);
    const focused = focusedAtom && trigger === 'keyboard' && (geometryPick ? cadSketchGeometryPickAllows(geometryPick, focusedAtom)
      : focusedAtom.kind === 'point' ? graphContextMenu && cadSketchPickScopeHasPoints(pickFilter) && sourceGraph.graph.points.some(point => point.id === focusedAtom.id)
      : cadSketchPickScopeHasEdges(pickFilter) && sourceGraph.graph.entities.some(entity => entity.id === focusedAtom.id && (entity.kind !== 'circle' || graphContextMenu || cadSketchLinearPatternForSelection(sourceGraph.graph, focusedAtom) || cadSketchExternalReferenceForSelection(sourceGraph.graph, focusedAtom)))) ? focusedAtom : undefined;
    if (!candidates.length && !focused) return false;
    const selected = graphControls.selection.length === 1 ? graphControls.selection[0] : null;
    const target = trigger === 'pointer' ? candidates.length === 1 && (candidates[0].kind === 'entity' || graphContextMenu && !geometryPick) ? candidates[0]
      : selected?.kind === 'entity' && candidates.some(atom => atom.kind === 'entity' && atom.id === selected.id) ? selected : undefined : focused;
    setOverlap({ prepared: sourceGraph, document: graphControls.document, version: documentVersion, cancelSignal, filter: pickFilter, frameKey: spatialFrameKey, frame: projection.frame, geometryPick,
      clientX: event.clientX, clientY: event.clientY, toggle: Boolean(event.shiftKey), candidates, target, selection: graphControls.selection,
      ...(geometryPick || target?.kind === 'point' ? {} : focused && sourceGraph.graph.entities.find(entity => entity.id === focused.id)?.kind === 'circle' ? { extendEnds: [] }
        : focused ? { action: 'extend', extendEnd: 'start', extendEnds: (['start', 'end'] as const).map(end => ({ end,
        preview: prepareCadSketchExtendEndPreview(sourceGraph, sourceSketch.id, focused.id, end) })) }
        : target ? { action: 'split', split: prepareCadSketchSplitPreview(sourceGraph, sourceSketch.id, target.id, projection.point),
        trim: prepareCadSketchTrimPreview(sourceGraph, sourceSketch.id, target.id, projection.point),
        extend: prepareCadSketchExtendPreview(sourceGraph, sourceSketch.id, target.id, projection.point) } : {}) });
    return true;
  };
  const selectOverlap = (atom: CadSketchGraphSelection) => {
    if (!currentOverlap || projectSelection(currentOverlap)?.frame !== currentOverlap.frame || baseInteractionLocked) return;
    try { selectGraphHit(atom, currentOverlap.toggle); }
    catch (cause) { onError(userFacingMessage(cause, 'Unable to select this geometry.')); return; }
    svg.current?.querySelector<SVGGElement>(`[data-cad-sketch-${atom.kind === 'point' ? 'point' : 'entity'}="${atom.id}"]`)?.focus({ preventScroll: true });
  };
  /**
   * Selects the edges chained to `seed`: every edge joined end to end for a contour, or only those meeting without a turn for a tangent chain.
   * A chain stops where the path forks and says so.
   */
  const selectChain = (seed: string, mode: CadChainMode, additive: boolean) => {
    // A menu command runs after its menu closes, so it reads the lock of the render that closed it, not the one that opened it.
    if (!sourceGraph || !graphControls?.onSelectSet || tool !== 'select' || sketch.kind !== 'sketch' || geometryPick || positionPick || isPreview || interactionLocked || !cadSketchPickScopeHasEdges(pickFilter)) return false;
    const chain = cadSketchSelectionChain(sourceGraph.graph, sourceGraph.parameters, seed, mode);
    if (!chain.ids.length) return false;
    const name = mode === 'tangent' ? 'Tangent chain' : 'Contour', edges = chain.ids.map(id => ({ kind: 'entity' as const, id }));
    const selection = [...additive ? graphControls.selection.filter(atom => !edges.some(edge => sameAtom(edge, atom))) : [], ...edges];
    if (selection.length > SKETCH_SELECTION_LIMIT) { onError(`This ${name.toLowerCase()} has ${chain.ids.length} edges. A selection holds at most ${SKETCH_SELECTION_LIMIT} points and edges.`); return true; }
    try {
      const next = cadSketchGraphSelectionSet(sourceGraph.graph, selection);
      graphControls.onSelectSet(next, additive);
      // The status explains a chain that grew past its seed or stopped at a fork; a lone edge selected this way needs no explaining.
      const forks = chain.branches.length;
      if (chain.ids.length === 1 && !forks) { setChainStatus(null); return true; }
      setChainStatus({ selection: next, text: `${name} · ${chain.ids.length} edge${chain.ids.length === 1 ? '' : 's'}${chain.closed ? ' · closed' : ''}${forks ? ` · stops at ${forks} fork${forks === 1 ? '' : 's'}` : ''}` });
    } catch (cause) { onError(userFacingMessage(cause, 'Unable to select this chain.')); }
    return true;
  };
  const currentSelectChain = useRef(selectChain);
  currentSelectChain.current = selectChain;
  /** The sketch position Select other works at: the pointer over the canvas, else the focused point or edge. */
  const otherPoint = (target: EventTarget | null): SketchPoint | null => {
    if (lastPointer.current) return getRawPoint(lastPointer.current);
    const element = target instanceof Element ? target.closest('[data-cad-sketch-point], [data-cad-sketch-entity]') : null;
    const pointId = element?.getAttribute('data-cad-sketch-point'), entityId = element?.getAttribute('data-cad-sketch-entity');
    const point = pointId ? sourceGraph?.points.find(item => item.id === pointId)?.position : null;
    const segment = entityId ? sourceGraph?.geometry.segments.find(item => item.id === entityId) : null;
    return point ?? (segment ? [segment.start.x, segment.start.y] : null);
  };
  /**
   * Select other: the next candidate under the pointer takes the place of the selected one, in the order a click prefers them, points
   * before edges and each by distance, with the origin among the points and the axes after the edges. Shift goes back.
   */
  const selectOther = (direction: 1 | -1, target: EventTarget | null) => {
    if (!sourceGraph || !graphControls?.onSelectSet || tool !== 'select' || sketch.kind !== 'sketch' || geometryPick || positionPick || isPreview || interactionLocked) return false;
    const rect = svg.current?.getBoundingClientRect(), point = otherPoint(target);
    if (!rect?.height || !point) return false;
    const hits = graphPicks(point, span / rect.height), fixed = fixedEligible ? cadSketchFixedElementsAt(point, span / rect.height, fixedEligible) : [];
    const candidates = [...hits.filter(hit => hit.kind === 'point'), ...fixed.filter(item => item.kind === 'point'), ...hits.filter(hit => hit.kind === 'entity'), ...fixed.filter(item => item.kind === 'entity')];
    const step = cadSelectOtherStep(candidates, graphControls.selection, sameAtom, direction);
    if (!step) return false;
    try { graphControls.onSelectSet(cadSketchGraphSelectionSet(sourceGraph.graph, cadSelectOtherApply(graphControls.selection, step, sameAtom)), false); }
    catch (cause) { onError(userFacingMessage(cause, 'Unable to select this geometry.')); return true; }
    // Keys then act on the new selection: focus moves to its element, or to the canvas, never staying on the one it replaced.
    const { candidate } = step;
    const element = svg.current?.querySelector<SVGElement>(isCadSketchVirtualId(candidate.id) ? `[data-cad-sketch-fixed="${candidate.id}"]`
      : `[data-cad-sketch-${candidate.kind === 'point' ? 'point' : 'entity'}="${CSS.escape(candidate.id)}"]`);
    (element?.getAttribute('tabindex') === '0' ? element : svg.current)?.focus({ preventScroll: true });
    return true;
  };
  const overlapTarget = currentOverlap?.target;
  const highlightEdgeAction = (action?: CadSketchOverlapPick['action'], extendEnd?: 'start' | 'end') => {
    setPickHighlight(null); setOverlap(current => current && { ...current, action, extendEnd });
  };
  const activeExtend = currentOverlap?.extendEnds?.find(option => option.end === currentOverlap.extendEnd)?.preview ?? currentOverlap?.extend;
  const extendItems: readonly CadContextMenuItem[] = currentOverlap ? (currentOverlap.extendEnds ?? (currentOverlap.extend ? [{ end: undefined, preview: currentOverlap.extend }] : []))
    .map(({ end, preview }) => ({ label: preview.label, disabled: preview.kind !== 'ready', help: preview.kind === 'unavailable' ? preview.reason : preview.help,
      onHighlight: () => highlightEdgeAction('extend', end), onSelect: () => {
        if (projectSelection(currentOverlap)?.frame !== currentOverlap.frame || baseInteractionLocked || preview.kind !== 'ready' || !graphControls) return;
        const { edit } = preview, owned = currentOverlap; edgeSubmission.current = owned;
        submitEdit(signal => graphControls.onEditMany([edit], signal), () => {
          if (edgeSubmission.current !== owned) return;
          edgeSubmission.current = null;
          if (projectSelection(owned)?.frame === owned.frame) graphControls.onSelect({ kind: 'point', id: edit.extend.endPointId });
        }, 'Unable to extend this line.');
      } })) : [];
  const patternOwner = sourceGraph && overlapTarget ? cadSketchLinearPatternForSelection(sourceGraph.graph,overlapTarget) : null;
  const actOnPattern = (action: () => void) => {
    if (!currentOverlap || !overlapIsCurrent(currentOverlap)) return;
    const owned = currentOverlap;
    flushSync(() => { closeOverlap(); pendingChange.current(false); });
    if (overlapIsCurrent(owned)) action();
  };
  const commandScope = currentOverlap && overlapTarget ? currentOverlap.selection.some(atom => atom.kind === overlapTarget.kind && atom.id === overlapTarget.id)
    ? currentOverlap.selection : [overlapTarget] : [];
  const graphCommandItems = currentOverlap && overlapTarget && !geometryPick && graphContextMenu ? graphContextMenu(commandScope).map(item => 'kind' in item ? item
    : { ...item, onHighlight: () => { highlightEdgeAction(); setPickHighlight(overlapTarget); item.onHighlight?.(); }, onSelect: () => actOnPattern(item.onSelect) }) : [];
  const referenceOwner = sourceGraph && overlapTarget ? cadSketchExternalReferenceForSelection(sourceGraph.graph, overlapTarget) : undefined;
  const overlapItems: readonly CadContextMenuItem[] = [...(currentOverlap && geometryPick ? (overlapTarget ? [overlapTarget] : currentOverlap.candidates).map(atom => ({
    label: overlapTarget ? geometryPick.label : `${geometryPick.label} · ${atom.kind === 'point' ? 'Point' : ({ line: 'Line', arc: 'Arc', circle: 'Circle' })[sourceGraph?.graph.entities.find(entity => entity.id === atom.id)?.kind ?? 'line']} ${(atom.kind === 'point' ? sourceGraph?.points.findIndex(point => point.id === atom.id) ?? -1 : sourceGraph?.geometry.segments.findIndex(entity => entity.id === atom.id) ?? -1) + 1}`,
    onHighlight: () => setPickHighlight(atom), onSelect: () => selectOverlap(atom)
  })) : currentOverlap && overlapTarget && patternOwner ? [
    {label:'Edit pattern',onSelect:()=>actOnPattern(()=>graphControls?.onEditPattern?.(patternOwner.relation.id))},
    {label:'Select seed',onSelect:()=>actOnPattern(()=>graphControls?.onSelect({kind:'entity',id:patternOwner.relation.seed.entityId}))},
    ...(patternOwner.index > 0 ? [{label:'Exclude occurrence',onSelect:()=>actOnPattern(()=>graphControls?.onDelete?.(overlapTarget))}] : [])
  ] : currentOverlap && overlapTarget ? [
    ...(referenceOwner ? [{ label: 'Detach reference', help: 'Keep this geometry and its local relations, and release its source link.', onSelect: () => {
      const owned = currentOverlap;
      if (projectSelection(owned)?.frame !== owned.frame || baseInteractionLocked || !graphControls || sourceSketch.kind !== 'sketch') return;
      edgeSubmission.current = owned;
      submitEdit(signal => graphControls.onEditMany([{ kind: 'remove-sketch-relation', sketchId: sourceSketch.id, relationId: referenceOwner.id }], signal), () => {
        if (edgeSubmission.current !== owned) return;
        edgeSubmission.current = null;
        if (projectSelection(owned)?.frame === owned.frame) graphControls.onSelect(overlapTarget);
      }, 'Unable to detach this reference.');
    } }] : []),
    ...(currentOverlap.extendEnds || overlapTarget.kind === 'point' ? [] : [
    { label: 'Split here', disabled: currentOverlap.split?.kind !== 'ready', help: currentOverlap.split?.kind === 'unavailable' ? currentOverlap.split.reason : undefined,
      onHighlight: () => highlightEdgeAction('split'), onSelect: () => {
      if (projectSelection(currentOverlap)?.frame !== currentOverlap.frame || baseInteractionLocked || currentOverlap.split?.kind !== 'ready' || !graphControls) return;
      const { edit } = currentOverlap.split;
      const owned = currentOverlap; edgeSubmission.current = owned;
      submitEdit(signal => graphControls.onEditMany([edit], signal), () => {
        if (edgeSubmission.current !== owned) return;
        edgeSubmission.current = null;
        if (projectSelection(owned)?.frame === owned.frame) graphControls.onSelect({ kind: 'point', id: edit.split.splitPointId });
      }, 'Unable to split this edge.');
    } },
    { label: 'Trim here', disabled: currentOverlap.trim?.kind !== 'ready', danger: currentOverlap.trim?.kind === 'ready' && currentOverlap.trim.edit.trim.kind === 'delete',
      help: currentOverlap.trim?.kind === 'unavailable' ? currentOverlap.trim.reason : currentOverlap.trim?.help,
      onHighlight: () => highlightEdgeAction('trim'), onSelect: () => {
        if (projectSelection(currentOverlap)?.frame !== currentOverlap.frame || baseInteractionLocked || currentOverlap.trim?.kind !== 'ready' || !graphControls) return;
        const { edit } = currentOverlap.trim, owned = currentOverlap; edgeSubmission.current = owned;
        submitEdit(signal => graphControls.onEditMany([edit], signal), () => {
          if (edgeSubmission.current !== owned) return;
          edgeSubmission.current = null;
          if (projectSelection(owned)?.frame === owned.frame) {
            if (edit.trim.kind === 'end') graphControls.onSelect({ kind: 'point', id: edit.trim.cutPointId });
            else if ('cutPointIds' in edit.trim) graphControls.onSelect({ kind: 'point', id: edit.trim.cutPointIds[0] });
            else graphControls.onSelectSet?.(graphControls.selection.filter(atom => atom.kind !== 'entity' || atom.id !== edit.trim.entityId), true);
          }
        }, 'Unable to trim this edge.');
      } }]),
    ...extendItems,
    { label: overlapTarget.kind === 'point' ? 'Select point' : 'Select edge', onHighlight: () => { highlightEdgeAction(); setPickHighlight(overlapTarget); }, onSelect: () => selectOverlap(overlapTarget) },
    ...(overlapTarget.kind === 'entity' && !isCadSketchVirtualId(overlapTarget.id) && cadSketchPickScopeHasEdges(pickFilter) ? [
      { label: 'Select contour', help: 'Every edge joined end to end with this one. Double-click an edge for the same.', onHighlight: () => { highlightEdgeAction(); setPickHighlight(overlapTarget); },
        onSelect: () => actOnPattern(() => currentSelectChain.current(overlapTarget.id, 'contour', currentOverlap.toggle)) },
      { label: 'Select tangent chain', help: 'The edges meeting this one without a turn. Alt + double-click an edge for the same.', onHighlight: () => { highlightEdgeAction(); setPickHighlight(overlapTarget); },
        onSelect: () => actOnPattern(() => currentSelectChain.current(overlapTarget.id, 'tangent', currentOverlap.toggle)) }] : []),
    ...(currentOverlap.candidates.length > 1 ? [{ label: 'Select other', help: 'N picks the next candidate under the pointer, and Shift + N the one before.', onSelect: () => setOverlap({ ...currentOverlap, target: undefined, split: undefined, trim: undefined, extend: undefined, extendEnds: undefined, extendEnd: undefined, action: undefined }) }] : [])
  ] : currentOverlap?.candidates.map(atom => {
    const point = atom.kind === 'point' ? sourceGraph?.points.find(point => point.id === atom.id) : null;
    const index = atom.kind === 'point' ? sourceGraph?.graph.points.findIndex(point => point.id === atom.id) : sourceGraph?.graph.entities.findIndex(entity => entity.id === atom.id);
    const entity = atom.kind === 'entity' ? sourceGraph?.graph.entities.find(entity => entity.id === atom.id) : null;
    const label = point ? `Point ${(index ?? -1) + 1} · ${point.position.map(value => formatCadQuantity(value)).join(', ')} mm`
      : `${entity?.kind === 'line' ? 'Line' : entity?.kind === 'circle' ? 'Circle' : 'Arc'} ${(index ?? -1) + 1}`;
    return { label, onHighlight: () => setPickHighlight(atom), onSelect: () => selectOverlap(atom) };
  }) ?? []), ...(graphCommandItems.length ? [{ kind: 'separator' } satisfies CadContextMenuItem, ...graphCommandItems] : [])];
  // A pick's own menu belongs to the pick it opened on and the pointer position it was opened for; another pick, or a lock, closes it.
  const [pickMenu, setPickMenu] = useState<{ readonly geometryPick: NonNullable<typeof geometryPick>; readonly clientX: number; readonly clientY: number; readonly pointer: { readonly x: number; readonly y: number } | null } | null>(null);
  const openPickMenu = (event: { clientX: number; clientY: number }) => {
    if (!geometryPick?.contextMenu || interactionLocked) return false;
    const pointer = geometryPick.pointer?.get() ?? null;
    if (!geometryPick.contextMenu(pointer)) return false;
    setPickMenu({ geometryPick, clientX: event.clientX, clientY: event.clientY, pointer });
    return true;
  };
  const currentPickMenu = pickMenu && pickMenu.geometryPick === geometryPick && !interactionLocked ? pickMenu : null;
  const pickMenuContent = currentPickMenu ? currentPickMenu.geometryPick.contextMenu?.(currentPickMenu.pointer) ?? null : null;
  useLayoutEffect(() => { if (pickMenu && !currentPickMenu) setPickMenu(null); }, [pickMenu, currentPickMenu]);
  const getDrawingPick = (event: { clientX: number; clientY: number; ctrlKey: boolean; metaKey: boolean }): DrawingPick => {
    const raw = getRawPoint(event) ?? [0, 0], snapSuppressed = event.ctrlKey || event.metaKey, rect = svg.current?.getBoundingClientRect();
    setCursorInput({ point: raw, snapSuppressed, mode: 'pointer' });
    const pick = resolveDrawingPick(raw, snapSuppressed, 'pointer', [width / (rect?.width || 0), span / (rect?.height || 0)]);
    const target = pick.candidate?.target;
    if (pick.candidate && target && !SNAP_PLACEMENTS.has(target.kind) && target.kind !== 'draft-start'
      && !acquired.current.some(point => point[0] === pick.point[0] && point[1] === pick.point[1])) acquired.current = [pick.candidate.point, ...acquired.current].slice(0, ACQUIRED_POINTS);
    return pick;
  };
  const pickGrip = (event: { target: EventTarget | null }, point: SketchPoint, millimetersPerPixel: number) => {
    const key = event.target instanceof Element ? event.target.closest('[data-cad-sketch-grip]')?.getAttribute('data-cad-sketch-grip') : null;
    const owned = key ? handlePicker.handles.find(grip => `${grip.profileId}/${cadSketchHandleKey(grip.handle)}` === key) : null;
    return owned ?? handlePicker.pick(point, millimetersPerPixel, selectedProfileId);
  };
  /**
   * Dimension lines and arrows lie beneath the sketch points and edges. The origin, an axis, a profile grip or profile edge under one keeps the pick too.
   * Each event is measured once: the grip, origin or axis found are the ones the canvas hover would find, so a move over a line asks no picker twice.
   */
  const lineCover = useRef<LineCover | null>(null);
  const measureLineCover = (event: DimensionLineEvent) => {
    if (lineCover.current?.event === event.nativeEvent) return lineCover.current;
    const point = getRawPoint(event), rect = svg.current?.getBoundingClientRect();
    if (!point || !rect?.height) return null;
    const millimetersPerPixel = span / rect.height, auto = pickFilter === 'auto';
    const grip = onMoveHandle ? pickGrip(event, point, millimetersPerPixel) : null, gripped = Boolean(grip && auto);
    // As in fixedUnder: a grip keeps an axis from the pointer, and so does a profile edge in plain selection.
    const edge = !gripped && auto && profilePicker.edgeNear(point, millimetersPerPixel);
    const fixed = gripped || edge && fixedSelect ? null : fixedAt(point, millimetersPerPixel);
    lineCover.current = { event: event.nativeEvent, grip, fixed, covered: gripped || edge || Boolean(fixedSelect && fixed) };
    return lineCover.current;
  };
  const dimensionLineCover = useRef(measureLineCover); dimensionLineCover.current = measureLineCover;
  const coversDimensionLine = useCallback((event: DimensionLineEvent) => Boolean(dimensionLineCover.current(event)?.covered), []);
  /**
   * A relation glyph lies beneath the dimension lines, labels, sketch points and edges. Dimensions pick only by their own elements, which
   * follow the glyph layer, so where one crosses a glyph it receives the event first. Geometry picks reach further than its elements, so a
   * glyph within that reach, or over the origin, an axis, a grip or profile edge, leaves the pick to them here.
   */
  const glyphCover = useRef<{ readonly event: Event; readonly covered: boolean } | null>(null);
  const measureGlyphCover = (event: DimensionLineEvent) => {
    if (glyphCover.current?.event === event.nativeEvent) return glyphCover.current.covered;
    const covered = Boolean(measureLineCover(event)?.covered) || graphPickAt.current(event) !== null;
    glyphCover.current = { event: event.nativeEvent, covered };
    return covered;
  };
  const relationGlyphCover = useRef(measureGlyphCover); relationGlyphCover.current = measureGlyphCover;
  const coversRelationGlyph = useCallback((event: DimensionLineEvent) => relationGlyphCover.current(event), []);
  const submitEdit = (apply: (signal: AbortSignal) => CadEditCompletion, accepted: () => void, fallback: string) => {
    pendingChange.current(true); ownRevision.current = true;
    submission.submit(apply, accepted, error => {
      ownRevision.current = false; edgeSubmission.current = null; ownedHandleEdit.current = null; chainSave.current = null; setDragPreview(null);
      pendingChange.current(points.length > 0 || pathPending);
      onError(userFacingMessage(error, fallback));
    });
  };
  const commitHandle = (profileId: string, handle: CadSketchHandle, translation: SketchPoint, signal?: AbortSignal) => {
    const profile = profiles.find(profile => profile.id === profileId);
    if (!profile || !onMoveHandle) return;
    const expected = moveCadSketchHandle({ profile, handle, translation, parameters });
    if (JSON.stringify(profile) === JSON.stringify(expected)) return;
    ownedHandleEdit.current = { profileId, handle, expectedText: JSON.stringify(expected) };
    try { return onMoveHandle(profileId, handle, translation, signal); }
    catch (error) { ownedHandleEdit.current = null; throw error; }
  };
  const moveProfile = (event: { pointerId: number; clientX: number; clientY: number }) => {
    const active = profileDrag.current;
    if (!active || event.pointerId !== active.pointerId) return;
    if (!active.moved && Math.hypot(event.clientX - active.clientX, event.clientY - active.clientY) <= 4) return;
    active.moved = true; suppressProfileClick.current = true;
    const anchor = active.anchor ?? [0, 0];
    const snapped = magnetSketchPoint([anchor[0] + (event.clientX - active.clientX) * active.mmPerPixelX, anchor[1] - (event.clientY - active.clientY) * active.mmPerPixelY], active.gridStep, active.snap,
      DRAG_GRID_CATCH_PIXELS * Math.max(active.mmPerPixelX, active.mmPerPixelY));
    const translation: SketchPoint = [snapped[0] - anchor[0], snapped[1] - anchor[1]];
    try {
      const profile = active.handle ? moveCadSketchHandle({ profile: active.profile, handle: active.handle, translation, parameters: active.parameters })
        : translateCadSketchProfile({ profile: active.profile, translation, parameters: active.parameters });
      active.translation = translation;
      setDragPreview(current => current && current.translation[0] === translation[0] && current.translation[1] === translation[1] ? current : { profile, translation, handle: active.handle });
    } catch (error) { finishProfileDrag(); onError(userFacingMessage(error, 'Unable to move this contour.')); }
  };
  /**
   * Arc saves its one segment, a drag from an idle Line saves its one line, and a chain click returning to its start saves
   * it closed. The draft keeps its earlier state until the save is accepted, so a rejected save leaves the last pick to repeat.
   */
  const changePath = (action: CadPathDrawingAction, focus = false, saveLine = false) => {
    if (interactionLocked && action.kind !== 'cancel') return;
    if (action.kind === 'cancel') submission.cancel();
    try {
      const next = updateCadPathDraft(pathDraft, action);
      if (action.kind === 'point' && action.pick && referencesSource(action.pick) && !attachedSource.current)
        attachedSource.current = { sketch: sourceSketch, version: documentVersion, parameters: graphSourceParameters, document: graphControls?.document };
      setCursorInput(current => ({ ...current, point: action.kind === 'point' ? action.point : cursor, mode: 'position' }));
      const closes = chainTool && sketch.kind === 'sketch' && closesCadPathChain(next);
      if (action.kind === 'point' && next.kind === 'ready' && next.segments.length > 0 && (singleSegment || closes || saveLine && next.segments.length === 1)) finishPath(closes, next);
      else { setPathDraft(next); noteDraftChange(action.kind === 'point'); }
    }
    catch (error) { onError(userFacingMessage(error, 'Unable to draw this path.')); }
    if (action.kind === 'cancel' && curveCreation) onCancelCurve?.();
    if (focus) svg.current?.focus();
  };
  const cancelDrawing = () => {
    noteDraftChange(false); closeSnapChoice();
    edgeSubmission.current = null; chainSave.current = null; submission.cancel(); ownedHandleEdit.current = null;
    setDragPreview(null); setPicks([]); setPathDraft(idlePathDraft()); setCursorInput(current => ({ ...current, mode: 'position' }));
    if (curveCreation) onCancelCurve?.();
  };
  const finishPath = (closed: boolean, draft: CadPathDraft = pathDraft, after?: () => void) => {
    // Every other caller is gated by the full lock; only finishing an open chain closes a pending snap choice first.
    if (chainFinishLocked) return;
    noteDraftChange(false);
    const reset = () => setPathDraft(idlePathDraft());
    try {
      if (sketch.kind === 'curve') {
        if (!onAddCurve || !curveCreation) throw new Error('Edit the existing curve dimensions in Properties.');
        const segments = finishCadCurveDraft(draft);
        submitEdit(signal => onAddCurve(segments, signal), reset, 'Unable to finish this curve.');
      } else if (onAddPath) {
        if (!attachedSourceCurrent()) return;
        // Escape or a tool switch during a chain's save runs its step once the chain is accepted, and never aborts the drawn segments.
        const owned = singleSegment ? null : { after }; chainSave.current = owned;
        // A click that saves the chain spends the double-click it begins.
        if (owned) draftChanges.current = { ...draftChanges.current, finished: true };
        submitEdit(signal => onAddPath(draft, closed, signal), () => {
          reset();
          if (!owned || chainSave.current !== owned) return;
          chainSave.current = null; owned.after?.();
        }, singleSegment ? 'Unable to add this arc.' : draft.kind !== 'idle' && draft.segments.length === 1 && !closed ? 'Unable to add this line.' : 'Unable to finish this line chain.');
      } else if (singleSegment) {
        throw new Error('This sketch keeps closed profiles only. Draw a closed chain with Line.');
      } else {
        const profile = closeCadPolylineProfile(draft);
        submitEdit(signal => onAddProfile(profile, signal), reset, 'Unable to close this path.');
      }
    }
    catch (error) { onError(userFacingMessage(error, 'Unable to close this path.')); }
    svg.current?.focus();
  };
  /**
   * Saves a chain that can stay open with its completed segments, dropping a pending arc endpoint or snap choice, and runs
   * `after` once the save is accepted. False with no completed segment. Curves and profile-only sketches keep their explicit finish.
   */
  const finishOpenChain = (after?: () => void) => {
    const completed = chainOpen && !chainFinishLocked ? completedCadPathChain(pathDraft) : null;
    if (!completed) return false;
    if (snapChoice) closeSnapChoice();
    finishPath(false, completed, after); return true;
  };
  /**
   * The latest click, when a press soon after it and within the drag slop of it, with the draft unchanged since, could
   * complete its double-click. Only a completed click begins one, so a press another pointer still holds never does, and a
   * mouse, pen or touch click pairs only with a press of its own kind.
   */
  const secondPress = (press: DrawingPlacement, pointerId: number) => {
    const previous = lastClick.current;
    return previous && previous.changes === draftChanges.current.count && (previous.pointerId === null || previous.pointerId === pointerId)
      && (!previous.pointerType || !press.pointerType || previous.pointerType === press.pointerType) && press.time - previous.time <= DOUBLE_CLICK_MS
      && Math.hypot(press.clientX - previous.clientX, press.clientY - previous.clientY) <= DRAWING_DRAG_PIXELS ? previous : null;
  };
  /**
   * Records a click after whatever it placed, so the next press can complete a double-click. A press records it while still
   * down, with its `pointerId` until the release, so a cancel, a lost capture or a drag first can drop it. A press whose
   * `pick` opens the snap chooser is no click: the chooser takes the next press, and a press outside that dismisses it is one.
   */
  const noteClick = (at: DrawingPlacement, pick?: DrawingPick, pointerId: number | null = null) => {
    const change = draftChanges.current;
    lastClick.current = pick?.candidates ? null : { time: at.time, clientX: at.clientX, clientY: at.clientY, pointerType: at.pointerType, changes: change.count, pointerId, finished: change.finished };
  };
  /** The latest click while the press that made it, by `pointerId`, is still down. */
  const pressedClick = (pointerId: number) => {
    const click = lastClick.current;
    return click && click.pointerId !== null && click.pointerId === pointerId ? click : null;
  };
  /**
   * A double-click finishes a chain that can stay open without a zero-length segment, and is then the click that saved it.
   * False with nothing complete to save, so the click stays an ordinary one.
   */
  const finishDoubleClick = (at: DrawingPlacement) => {
    lastClick.current = null;
    if (!finishOpenChain()) return false;
    noteClick(at); return true;
  };
  /**
   * One Escape for the drawing. A chain that can stay open saves its completed segments and the tool stays; any other pending
   * drawing is discarded. During a chain's save the Escape leaves the tool once the save is accepted, so it never aborts drawn
   * segments. False with nothing pending, so the Escape can leave the tool.
   */
  const escapeDrawing = (): boolean => {
    if (submission.applying) {
      if (chainSave.current) chainSave.current.after = () => onExitTool?.(); else cancelDrawing();
      return true;
    }
    if (interactionLocked) return false;
    if (pathTool && pathPending) {
      if (!finishOpenChain()) changePath({ kind: 'cancel' });
      return true;
    }
    if (!points.length) return false;
    setPicks([]); noteDraftChange(false); return true;
  };
  const drawingActions = useRef({ escape: escapeDrawing, finishChain: finishOpenChain });
  drawingActions.current = { escape: escapeDrawing, finishChain: finishOpenChain };
  const drawingControls = useMemo((): CadSketchDrawingControls => ({ escape: () => drawingActions.current.escape(), finishChain: after => drawingActions.current.finishChain(after) }), []);
  const chainSavable = chainOpen && !chainFinishLocked && completedCadPathChain(pathDraft) !== null;
  useLayoutEffect(() => {
    onDrawingControls?.(drawingControls, chainSavable);
    return () => onDrawingControls?.(null, false);
  }, [onDrawingControls, drawingControls, chainSavable]);
  const add = (geometry: CadProfile, drawing?: CadFreshSketchDrawing) => {
    noteDraftChange(false);
    try {
      if (!attachedSourceCurrent()) return;
      if (drawing && !onAddFreshSketch && picks.some(pick => pick.kind !== 'position')) throw new Error('The attached drawing cannot be saved by this editor. Cancel or release its pending relations.');
      submitEdit(signal => drawing && onAddFreshSketch ? onAddFreshSketch(drawing, signal) : onAddProfile(geometry, signal), () => setPicks([]), 'Unable to add this profile.');
    }
    catch (error) { onError(userFacingMessage(error, 'Unable to add this profile.')); }
  };
  const fit = () => {
    const coordinates: SketchPoint[] = [];
    if (savedCurve) coordinates.push([savedCurve.bounds.minX, savedCurve.bounds.minY], [savedCurve.bounds.maxX, savedCurve.bounds.maxY]);
    for (const segment of graphGeometry?.segments ?? []) coordinates.push([segment.bounds.minX, segment.bounds.minY], [segment.bounds.maxX, segment.bounds.maxY]);
    for (const point of visualGraph?.points ?? []) coordinates.push(point.position);
    for (const profile of profiles) {
      try {
        const { bounds } = cadProfileReferenceGeometry(profile.geometry, parameters);
        coordinates.push([bounds.minX, bounds.minY], [bounds.maxX, bounds.maxY]);
      } catch { /* Invalid profiles retain their diagnostic in the property editor. */ }
    }
    if (!coordinates.length) { setCenter([0, 0]); setSpan(160); return; }
    const xs = coordinates.map((point) => point[0]), ys = coordinates.map((point) => point[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const target: SketchPoint = [minX / 2 + maxX / 2, minY / 2 + maxY / 2];
    const viewport = host.current;
    const area = viewport ? readCadFitArea(viewport, getFitArea) : null;
    if (getFitArea && !area) return;
    const availableWidth = area && viewport ? area.width / viewport.clientWidth : 1;
    const availableHeight = area && viewport ? area.height / viewport.clientHeight : 1;
    const heightSpan = Math.max(20, (maxY - minY) / availableHeight, (maxX - minX) / (measuredAspect.current * availableWidth)) * 1.25;
    const framedCenter: SketchPoint = area && viewport ? [target[0] + (viewport.clientWidth / 2 - area.left - area.width / 2) * heightSpan / viewport.clientHeight,
      target[1] + (area.top + area.height / 2 - viewport.clientHeight / 2) * heightSpan / viewport.clientHeight] : target;
    setCenter(framedCenter); setSpan(heightSpan);
    if (initialCursorFit.current) {
      const snapped = snapSketchPoint(target, gridStep, gridSnap);
      setCursorInput({ point: Math.abs(snapped[0] - target[0]) <= heightSpan * measuredAspect.current / 2 && Math.abs(snapped[1] - target[1]) <= heightSpan / 2 ? snapped : target, snapSuppressed: false, mode: 'position' });
    }
  };
  fitView.current = fit;
  useLayoutEffect(() => {
    if (curveCreation) return;
    initialCursorFit.current = true; fitView.current?.(); initialCursorFit.current = false;
  }, [sketch.id, sketch.kind, curveCreation]);
  const pathPreview = useMemo(() => pathTool ? previewCadPathDraft(pathDraft, cursor) : { kind: 'none' as const }, [pathTool, pathDraft, cursor]);
  const invalidArcPoints = pathPreview.kind === 'invalid' ? [pathPreview.start, pathPreview.through, pathPreview.end].map(([x, y]) => `${x - center[0]},${y - center[1]}`).join(' ') : '';
  const pathMode = pathDraft.kind === 'arc-through' ? 'arc' : pathDraft.mode;
  const pathEnd = pathDraft.kind === 'idle' ? null : cadPathDraftEndpoint(pathDraft);
  const pathNeedsClosingLine = pathDraft.kind === 'ready' && pathDraft.segments.length > 0 && pathEnd !== null
    && (pathEnd[0] !== pathDraft.start[0] || pathEnd[1] !== pathDraft.start[1]);
  const currentTrim = tool === 'trim' && trimHover?.prepared === sourceGraph && !interactionLocked ? trimHover.preview : null;
  // An inspected relation or diagnostic that names the origin or an axis, or holds a point on one, lights it up with its geometry.
  const graphRelation = graphControls?.relation, graphInspection = graphControls?.inspection, relationGraph = sourceGraph?.graph;
  const relatedFixed = useMemo(() => {
    const named = graphInspection ?? (graphRelation && relationGraph ? cadSketchRelationHighlight(relationGraph, graphRelation) : null);
    return new Set<string>(named ? [...named.pointIds, ...named.entityIds].filter(isCadSketchVirtualId) : []);
  }, [graphInspection, graphRelation, relationGraph]);
  const fixedProps = (id: CadSketchVirtualId, className: string, onScreen: boolean) => {
    const selection = CAD_SKETCH_FIXED_SELECTIONS.find(item => item.id === id)!;
    const eligible = onScreen && Boolean(fixedEligible?.includes(selection)) && !interactionLocked, picked = Boolean(graphControls?.selection.some(item => item.id === id));
    const state = `${className}${eligible ? ' is-pick-eligible' : ''}${eligible && fixedHover === selection ? ' is-pick-highlighted' : ''}${picked ? ' is-selected' : ''}${relatedFixed.has(id) ? ' is-relation-highlighted' : ''}`;
    return eligible ? { className: state, role: 'button', tabIndex: 0, 'aria-label': `${fixedPick ? 'Use' : 'Select'} ${cadSketchVirtualSubject(id)}`, 'aria-pressed': fixedPick ? undefined : picked, 'data-cad-sketch-fixed': id,
      onKeyDown: (event: ReactKeyboardEvent<SVGElement>) => {
        if (event.key === 'Escape' && !fixedPick && graphControls?.selection.length) { event.preventDefault(); event.stopPropagation(); graphControls.onSelect(null); return; }
        if (event.key !== 'Enter' && event.key !== ' ') return; event.preventDefault(); event.stopPropagation(); chooseFixed(selection, event.shiftKey); } }
      : { className: state, 'aria-hidden': true, 'data-cad-sketch-fixed': id };
  };
  const instruction = positionPick ? `${positionPick.label} · Escape cancels` : geometryPick ? `${geometryPick.label} · ${geometryPick.escapeLabel ?? 'Escape cancels'}`
    : tool === 'trim' ? currentTrim?.kind === 'ready' ? 'Click to remove the red piece · Escape returns to Select' : currentTrim?.reason ?? 'Point at the piece of an edge to remove · Escape returns to Select'
    : pathTool && pathDraft.kind === 'arc-through' ? pathPreview.kind === 'invalid' ? pathPreview.message : 'Click a point on the arc.'
    : tool === 'arc' ? pathDraft.kind === 'idle' ? 'Click the arc start.' : 'Click the arc end.'
    : chainTool ? pathDraft.kind === 'idle' ? sketch.kind === 'curve' ? 'Click the curve start.' : chainOpen ? 'Click the line start, or drag to draw one line.' : 'Click the chain start.'
      : pathMode === 'arc' ? 'Click the arc endpoint.' : sketch.kind === 'curve' ? 'Click the next endpoint; Finish curve to save.'
      : !chainOpen ? 'Click the next endpoint; Close profile to finish.' : pathDraft.segments.length ? 'Click the next point. Click the start to close; double-click, Enter or Escape to finish open.' : 'Click the line end.'
    : tool === 'select' ? sketch.kind === 'curve' ? 'Edit curve dimensions in Properties.' : 'Select a profile to edit dimensions'
    : tool === 'slot' ? points.length > 1 ? 'Click to set the slot width' : points.length ? 'Click the second arc center' : 'Click the first arc center'
    : points.length ? tool === 'circle' ? 'Click to set the radius' : 'Click the opposite corner' : tool === 'circle' ? 'Click the circle center' : 'Click the first corner';
  let preview: CadProfile | null = null;
  const first = points[0];
  // Until the width click, the slot previews half as wide as its centers are apart.
  const slotCenters = tool === 'slot' && first ? [first, points[1] ?? cursor] as const : null;
  const slotLength = slotCenters ? Math.hypot(slotCenters[1][0] - slotCenters[0][0], slotCenters[1][1] - slotCenters[0][1]) : 0;
  try {
    if (slotCenters) preview = slotSketchProfile(...slotCenters, points.length > 1 ? slotSketchWidth(...slotCenters, cursor) : slotLength / 2);
    else if (first && (tool === 'rectangle' || tool === 'circle')) preview = twoPointSketchProfile(tool, first, cursor);
  } catch { /* The preview starts at zero size. */ }
  // The unfinished shape's size follows the cursor; the accepted geometry keeps the exact picked positions.
  const readout = (value: number) => formatCadLocalizedQuantity(value, 2);
  const segmentReadout = (from: SketchPoint) => {
    const dx = cursor[0] - from[0], dy = cursor[1] - from[1];
    return `${readout(Math.hypot(dx, dy))} mm · ${readout(Math.atan2(dy, dx) * 180 / Math.PI)}°`;
  };
  const drawingReadout = interactionLocked || positionPick ? null
    : preview?.kind === 'rectangle' && typeof preview.width === 'number' && typeof preview.height === 'number' ? `${readout(Math.abs(preview.width))} × ${readout(Math.abs(preview.height))} mm`
    : preview?.kind === 'circle' && typeof preview.radius === 'number' ? `Ø ${readout(preview.radius * 2)} mm`
    : preview?.kind === 'slot' && typeof preview.width === 'number' && typeof preview.angle === 'number'
      ? points.length > 1 ? `${readout(slotLength)} mm · width ${readout(preview.width)} mm` : `${readout(slotLength)} mm · ${readout(preview.angle)}°`
    : pathTool && pathPreview.kind === 'line' && pathEnd ? segmentReadout(pathEnd) : null;
  const placePoint = (point: SketchPoint, candidate?: CadSketchSnapCandidate, saveLine = false) => {
    if (interactionLocked) return;
    if (positionPick) {
      if (!isPreview && !viewLocked) positionPick.onPick(Object.freeze([...point] satisfies [number, number]));
      return;
    }
    if (tool === 'select') { onSelectProfile(null); return; }
    if (tool === 'trim') return;
    if (!attachedSourceCurrent()) return;
    const authoredPick = (): CadFreshSketchPick => {
      const target = canInfer && inferCoincidence ? candidate?.target : undefined;
      if (target && 'pointId' in target) return Object.freeze({ kind: 'coincident', point, sourcePointId: target.pointId, relationId: crypto.randomUUID() });
      if (target?.kind === 'on-entity' && target.entityKind === 'line') return Object.freeze({ kind: 'on-line', point, lineId: target.entityId, relationId: crypto.randomUUID() });
      if (target?.kind === 'on-entity') return Object.freeze({ kind: 'on-curve', point, curveId: target.entityId, relationId: crypto.randomUUID() });
      const targetId = target?.kind === 'origin' ? CAD_SKETCH_ORIGIN_ID : target?.kind === 'on-axis' ? cadSketchSnapAxisId(target.axis) : null;
      return targetId ? Object.freeze({ kind: 'fixed', point, targetId, relationIds: Object.freeze(cadFreshSketchFixedAxes(targetId).map(() => crypto.randomUUID())) })
        : Object.freeze({ kind: 'position', point });
    };
    if (pathTool) {
      // An arc's through point only shapes the arc.
      const pick = canInfer && pathDraft.kind !== 'arc-through' ? authoredPick() : undefined, axis = lineInference(candidate, point);
      changePath({ kind: 'point', point, ...(pick && pick.kind !== 'position' ? { pick } : {}), ...(axis ? { inferred: { kind: axis, relationId: crypto.randomUUID() } } : {}) }, false, saveLine); return;
    }
    const appendPick = (pick: CadFreshSketchPick) => {
      if (referencesSource(pick) && !attachedSource.current) attachedSource.current = { sketch: sourceSketch, version: documentVersion, parameters: graphSourceParameters, document: graphControls?.document };
      setPicks([...picks, pick]); noteDraftChange(true);
    };
    try {
      if (tool === 'slot' && points.length > 1) {
        // The width click only shapes the slot; both centers keep their own picks.
        noteDraftChange(false);
        const width = slotSketchWidth(points[0], points[1], point);
        add(slotSketchProfile(points[0], points[1], width), { kind: 'slot', first: picks[0], second: picks[1], width });
      } else if (tool === 'slot' && first) {
        if (Math.hypot(point[0] - first[0], point[1] - first[1]) < CAD_PRECISION.pointerMinimumSizeMm) throw new Error('Click a different point for the second arc center.');
        appendPick(authoredPick());
      } else if (first && (tool === 'rectangle' || tool === 'circle')) {
        // A completing pick ends the press even when its geometry is rejected.
        noteDraftChange(false);
        const geometry = twoPointSketchProfile(tool, first, point);
        add(geometry, tool === 'rectangle' ? { kind: 'rectangle', first: picks[0], opposite: authoredPick() }
          : geometry.kind === 'circle' && typeof geometry.radius === 'number' ? { kind: 'circle', center: picks[0], radius: geometry.radius } : undefined);
      } else appendPick(authoredPick());
    }
    catch (error) { onError(userFacingMessage(error, 'Unable to draw this profile.')); }
  };
  // CadContextMenu closes synchronously before invoking a chosen item. Use the
  // post-close handler so normal foreign-workflow and submission guards remain active.
  const placeChosen = useRef<(candidate: CadSketchSnapCandidate, saveLine?: boolean) => void>(() => undefined);
  placeChosen.current = (candidate, saveLine) => placePoint(candidate.point, candidate, saveLine);
  /** `saveLine` ends a drag from an idle Line, so the line it completes saves at once, also through the snap chooser. */
  const acceptDrawingPick = (pick: DrawingPick, anchor?: { clientX: number; clientY: number }, saveLine = false) => {
    if (interactionLocked) return;
    if (!pick.candidates) { placePoint(pick.point, pick.candidate, saveLine); return; }
    const bounds = svg.current?.getBoundingClientRect();
    if (!bounds?.width || !bounds.height || !attachedSourceCurrent()) return;
    const at = anchor ?? { clientX: bounds.left + bounds.width / 2 + (pick.point[0] - center[0]) / width * bounds.width,
      clientY: bounds.top + bounds.height / 2 - (pick.point[1] - center[1]) / span * bounds.height };
    const projected = projectSelection(at); if (!projected) return;
    // Opening the chooser on any path, a key included, ends the click history, so no later press pairs with an earlier click.
    pendingChange.current(true); lastClick.current = null;
    setSnapChoice({ owner: drawingOwner, candidates: pick.candidates, clientX: at.clientX, clientY: at.clientY, frame: projected.frame, ...(saveLine ? { saveLine } : {}) });
  };
  const dimensionProfile = dragPreview?.profile ?? (sketch.kind === 'sketch' ? sketch.profiles.find(profile => profile.id === selectedProfileId) : undefined);
  const dimensionBounds = useMemo(() => {
    if (!dimensionProfile) return null;
    try { return cadProfileReferenceGeometry(dimensionProfile.geometry, parameters).bounds; }
    catch { return null; }
  }, [dimensionProfile, parameters]);
  const dimensionAnchor = useMemo(() => {
    if (!dimensionBounds || !viewportSize.width || !viewportSize.height) return null;
    const x = ((dimensionBounds.minX + dimensionBounds.maxX) / 2 - center[0]) / width * viewportSize.width + viewportSize.width / 2;
    const y = (center[1] - dimensionBounds.minY) / span * viewportSize.height + viewportSize.height / 2 + 12;
    return { x: Math.max(125, Math.min(viewportSize.width - 125, x)), y: Math.max(60, Math.min(viewportSize.height - 220, y)) };
  }, [dimensionBounds, viewportSize, center, width, span]);
  // A long chain's attachment markers change only with the draft and the view, never per pointer move.
  const attachmentRadius = 6 * span / (viewportSize.height || 600);
  const attachmentMarkers = useMemo(() => pendingPicks.map((pick, index) => <circle key={index} data-cad-sketch-attachment={pick.kind === 'coincident' ? pick.sourcePointId : pick.kind === 'on-line' ? pick.lineId : pick.kind === 'on-curve' ? pick.curveId : pick.targetId}
    cx={pick.point[0] - center[0]} cy={pick.point[1] - center[1]} r={attachmentRadius} className="cad-sketch-snap-target"><title>{pick.kind === 'coincident'
      ? `Pending coincidence with Point ${(sourceGraph?.graph.points.findIndex(point => point.id === pick.sourcePointId) ?? -1) + 1}`
      : pick.kind === 'on-line' ? 'Pending point on line' : pick.kind === 'on-curve' ? 'Pending point on curve' : `Pending point ${pick.targetId === CAD_SKETCH_ORIGIN_ID ? 'at' : 'on'} ${cadSketchVirtualSubject(pick.targetId)}`}</title></circle>),
  [pendingPicks, center, attachmentRadius, sourceGraph]);
  // The view toolbar does not follow the cursor, so drawing moves reuse it instead of rendering its controls again.
  const latestFit = useRef(fit); latestFit.current = fit;
  const pickLocked = viewLocked || interactionLocked || Boolean(geometryPick || positionPick);
  const planeLabel = placementLabel ?? (typeof sketch.plane === 'string' ? sketch.plane : 'Datum plane');
  const viewTools = useMemo(() => <CadViewTools label="Sketch controls">{sketch.kind === 'sketch' && <CadToolbarMenu label="Filter" menuLabel="Sketch selection filter" title="Choose what clicks, boxes and Select other take in the sketch. The model view shares this filter." icon={<SelectIcon size={14} />}
    disabled={pickLocked} pressed={SKETCH_SELECTION_KINDS.some(({ kind }) => !cadSelectionAccepts(selectionFilter, kind))} className="cad-pattern-menu cad-selection-filter-menu"
    items={SKETCH_SELECTION_KINDS.map(({ kind, label }) => ({ key: kind, label, checked: cadSelectionAccepts(selectionFilter, kind),
      onSelect: () => changeSelectionFilter(setCadSelectionKind(selectionFilter, kind, !cadSelectionAccepts(selectionFilter, kind))) }))} />}<span className="cad-plane-label">{planeLabel}</span><Button aria-label={sketch.kind === 'curve' ? 'Fit curve' : 'Fit sketch'} disabled={viewLocked} onClick={() => latestFit.current()}><FitViewIcon size={14} /></Button><Button aria-label="Toggle sketch grid" disabled={viewLocked} aria-pressed={grid} onClick={() => setGrid(!grid)}><GridIcon size={14} /></Button><Button aria-label="Toggle snapping" title="Snap to endpoints, centers, midpoints and other geometry. Hold Ctrl or Cmd to temporarily disable snapping." disabled={viewLocked} aria-pressed={snap} onClick={() => setSnap(!snap)}><SnapIcon size={14} /></Button><label className="cad-grid-step">Grid <Input aria-label="Grid spacing" disabled={viewLocked} type="number" min="0.01" value={gridStep} onChange={(event) => { const value = Number(event.target.value); if (value > 0 && Number.isFinite(value)) setGridStep(value); }} /> mm</label><label className="cad-check"><Input type="checkbox" aria-label="Snap to grid" title="Catch the pointer at grid nodes it passes close to. Off, the grid is only a visual reference." disabled={viewLocked} checked={gridSnap} onChange={event => setGridSnap(event.target.checked)} />Snap to grid</label><CadContextHelp label="Sketch navigation">{navigationMode === 'trackpad' ? 'Use two-finger scrolling to pan and pinch to zoom.' : 'Drag with the right mouse button to pan and use the wheel to zoom.'} Press F to fit the sketch. Escape finishes a line chain or cancels unfinished drawing; with nothing pending it returns to Select.</CadContextHelp>{viewControls}</CadViewTools>, [sketch.kind, selectionFilter, changeSelectionFilter, pickLocked, planeLabel, viewLocked, grid, snap, gridStep, gridSnap, navigationMode, viewControls]);
  return <div className={`cad-sketch-viewport ${sketch.kind === 'curve' ? 'cad-curve-viewport' : ''}`} ref={host}>
    <svg ref={svg} className={`cad-sketch-canvas ${drawing ? 'is-drawing' : tool === 'trim' ? 'is-trimming' : ''}`} role="application" tabIndex={interactionLocked ? -1 : 0} aria-label={sketch.kind === 'curve' ? 'Curve drawing canvas' : 'Sketch drawing canvas'} aria-describedby={instructionsId} viewBox={`${-width / 2} ${-span / 2} ${width} ${span}`} preserveAspectRatio="none"
      onContextMenu={(event) => event.preventDefault()}
      onDoubleClick={event => {
        // A double-click on an edge selects its contour, as SOLIDWORKS selects a chain and Fusion connected curves; Alt keeps to the
        // tangent chain and Shift adds. Dimensions and relation marks keep their own double-click.
        if (event.button !== 0 || event.target instanceof Element && event.target.closest('.cad-sketch-graph-dimensions, .cad-sketch-relation-glyphs')) return;
        const point = getRawPoint(event), rect = event.currentTarget.getBoundingClientRect();
        const seed = point && rect.height ? graphPicks(point, span / rect.height).find(hit => hit.kind === 'entity') : undefined;
        if (seed && selectChain(seed.id, event.altKey ? 'tangent' : 'contour', event.shiftKey)) event.preventDefault();
      }}
      onPointerDownCapture={event => {
        // Another contact while an axis is held abandons the press and its trailing click; the same pointer pressing again replaces it.
        // This runs while capturing, since sketch geometry stops the press from reaching the canvas.
        abandonedPresses.current.delete(event.pointerId);
        if (fixedPress.current && fixedPress.current.pointerId !== event.pointerId) dropFixedPress(); else fixedPress.current = null;
        if (positionPick && event.button === 0) {
          event.preventDefault(); event.stopPropagation(); suppressProfileClick.current = true;
          if (event.isPrimary === false || interactionLocked || viewLocked || isPreview || pan.current || profileDrag.current) return;
          event.currentTarget.focus({ preventScroll: true });
          // A position pick that also takes the origin uses it exactly, unless an eligible sketch point lies under the pointer.
          const point = fixedPick && getRawPoint(event), rect = event.currentTarget.getBoundingClientRect();
          const fixed = point && rect.height ? fixedUnder(point, span / rect.height, graphPicks(point, span / rect.height).length > 0) : null;
          if (fixed) { chooseFixed(fixed, false); return; }
          acceptDrawingPick(getDrawingPick(event), event); return;
        }
        if (event.button === 0 && geometryPick?.pointer && !interactionLocked) { const raw = getRawPoint(event); if (raw) geometryPick.pointer.set({ x: raw[0], y: raw[1] }, overlayFrame.mmPerPixel); }
        // A cancelled graph drag can release over empty canvas; its trailing click still belongs to the handle.
        if (event.button === 0 && event.target instanceof Element && event.target.closest('.cad-sketch-graph')) suppressProfileClick.current = true;
      }}
      onClickCapture={event => { if (positionPick && event.button === 0 && event.detail > 0) { event.preventDefault(); event.stopPropagation(); } }}
      onPointerDown={(event) => {
        if (boxSelection.active()) { boxSelection.begin(event); return; }
        if (profileDrag.current) return;
        // Only the primary pointer owns the trailing click; a second contact must not release its suppression.
        if (event.button === 0 && event.isPrimary !== false) suppressProfileClick.current = false;
        if (pan.current) { if (event.pointerId !== pan.current.pointerId) pan.current.moved = true; return; }
        if (event.isPrimary === false) return;
        if (event.button === 1 || event.button === 2) {
          if (viewLocked) return;
          event.preventDefault(); event.currentTarget.focus({ preventScroll: true });
          // A still right release on a dimension opens the menu of the dimension pressed, which the workbench checks is still there.
          // A label takes the press; a line or arrow only where no origin, axis, profile grip or profile edge lies under it.
          const target = event.button === 2 && event.target instanceof Element ? event.target : null;
          const label = target?.closest('[data-cad-sketch-dimension]')?.getAttribute('data-cad-sketch-dimension') ?? null;
          const line = label ? null : target?.closest('[data-cad-sketch-dimension-hit]')?.getAttribute('data-cad-sketch-dimension-hit') ?? null;
          const dimensionId = label ?? (line && !dimensionLineCover.current(event)?.covered ? line : null);
          const dimension = dimensionId && sourceSketch.kind === 'sketch' && sourceSketch.graph ? cadSketchDimensionPick(cadSketchDrawnDimensions(sourceSketch.graph, graphSourceParameters), dimensionId) : null;
          // A relation glyph takes the press as a label does, only where no geometry, origin, axis, grip or profile edge lies under it.
          const glyph = label || line ? null : target?.closest('.cad-sketch-relation-glyph.is-interactive')?.getAttribute('data-cad-sketch-relation-glyph') ?? null;
          const relations = glyph && sourceSketch.kind === 'sketch' && sourceSketch.graph && !relationGlyphCover.current(event) ? relationGlyphPicks(sourceSketch.graph, glyph) : null;
          pan.current = { x: event.clientX, y: event.clientY, center, pointerId: event.pointerId, button: event.button, buttonMask: event.button === 1 ? 4 : 2, moved: false, element: event.currentTarget,
            dimension, dimensionLine: !label, relations: relations?.length ? relations : null };
          try { event.currentTarget.setPointerCapture(event.pointerId); } catch { finishPan(); }
        } else if (event.button === 0 && !interactionLocked) {
          // SVG's native focus ring is measured in drawing units. Keep pointer
          // focus on the canvas rather than the profile's millimetre bounding box.
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
          if (tool === 'trim') { suppressProfileClick.current = true; trimEdge(event); return; }
          if (drawing && !geometryPick && !positionPick) {
            // The press places the pick, so its trailing click must not place another.
            suppressProfileClick.current = true;
            const last = pathTool ? pathDraft.kind === 'arc-through' ? pathDraft.end : pathDraft.kind === 'ready' ? cadPathDraftEndpoint(pathDraft) : null : points.at(-1);
            const bounds = event.currentTarget.getBoundingClientRect(), pick = getDrawingPick(event);
            // A tap followed by a tap-drag can arrive as a second press on the point the tap placed, so wait for the release. So does
            // a chain press whose pick snaps back onto its last point, which placing would only repeat.
            const snapsBack = Boolean(chainOpen && last && !pick.candidates && pick.point[0] === last[0] && pick.point[1] === last[1]);
            const beside = last && (snapsBack || bounds.width && bounds.height && Math.hypot(event.clientX - (bounds.left + bounds.width / 2 + (last[0] - center[0]) / width * bounds.width),
              event.clientY - (bounds.top + bounds.height / 2 - (last[1] - center[1]) / span * bounds.height)) <= DRAWING_DRAG_PIXELS);
            // A press that could complete a double-click is judged on release too, wherever it lands, since only a still one
            // finishes a chain. Once a chain has its start, a drag from that point adds a segment to the chain like any later drag.
            const at = { clientX: event.clientX, clientY: event.clientY, time: event.timeStamp, pointerType: event.pointerType }, second = chainOpen ? secondPress(at, event.pointerId) : null;
            const press = { pointerId: event.pointerId, ...at, changes: draftChanges.current.count, fromIdle: chainOpen && pathDraft.kind === 'idle' && pathMode === 'line',
              held: beside || second ? { last: beside && last ? last : null, raw: getRawPoint(event) ?? [0, 0], scale: [width / bounds.width, span / bounds.height] as SketchPoint, second } : null, dragged: false };
            drawingPress.current = press;
            try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* The release still ends the press over the canvas. */ }
            if (press.held) return;
            acceptDrawingPick(pick, event);
            noteClick(press, pick, event.pointerId);
            // Only a press that added a point draws on release; a finished, rejected or ambiguous pick ends the gesture.
            const change = draftChanges.current;
            if (change.count !== press.changes && change.added) press.changes = change.count; else drawingPress.current = null;
            return;
          }
          if (tool === 'select' && sketch.kind === 'sketch' && !viewLocked && !isPreview) {
            const point = getRawPoint(event), rect = event.currentTarget.getBoundingClientRect();
            const graphHit = point && rect.height ? graphPicks(point, span / rect.height)[0] : null;
            if (graphHit) { selectGraphHit(graphHit, event.shiftKey); suppressProfileClick.current = true; return; }
            if (geometryPick) {
              // A pick takes the origin or an axis at once, since a press in a pick never drags.
              const fixed = fixedPick && point && rect.height ? fixedUnder(point, span / rect.height, false) : null;
              if (fixed) { chooseFixed(fixed, false); suppressProfileClick.current = true; } else geometryPick.onConfirm?.('pointer');
              return;
            }
            const grip = pickFilter === 'auto' && onMoveHandle && point && rect.height ? pickGrip(event, point, span / rect.height) : null;
            const fixed = fixedSelect && point && rect.height ? fixedUnder(point, span / rect.height, Boolean(grip)) : null;
            const frame = fixed ? projectSelection(event)?.frame : undefined;
            if (fixed && frame) fixedPress.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, selection: fixed, additive: event.shiftKey, documentVersion, sketchId: sketch.id, cancelSignal, frame };
            if (grip) {
              setActiveHandle(grip);
              if (selectedProfileId !== grip.profileId) onSelectProfile(grip.profileId);
              if (!grip.draggable) return;
            } else setActiveHandle(null);
            const picked = pickFilter === 'auto' && point && rect.height ? profilePicker.pick(point, span / rect.height) : null;
            if (!grip && !picked && boxSelection.begin(event)) return;
            const id = grip?.profileId ?? (onTranslateProfile && picked === selectedProfileId ? selectedProfileId : null);
            const profile = id ? sketch.profiles.find(profile => profile.id === id && profile.geometry.kind !== 'plugin') : null;
            if (profile && rect.width && rect.height) {
              profileDrag.current = { profile, sketch, parameters, pointerId: event.pointerId, element: event.currentTarget,
                clientX: event.clientX, clientY: event.clientY, mmPerPixelX: width / rect.width, mmPerPixelY: span / rect.height,
                snap: gridSnap, gridStep, handle: grip?.handle ?? null, anchor: grip?.point ?? null, moved: false, translation: [0, 0] };
              try { event.currentTarget.setPointerCapture(event.pointerId); } catch { finishProfileDrag(); }
            }
          }
        } else if (event.button === 0 && drawing && !geometryPick && !positionPick) {
          // A press while drawing is paused, such as during a chain's save, places nothing. It keeps its trailing click even when
          // the pause ends before its release, so it never starts a chain, and it ends any double-click the last click began.
          suppressProfileClick.current = true; lastClick.current = null;
        }
      }}
      onPointerUpCapture={event => {
        if (abandonedPresses.current.delete(event.pointerId)) suppressProfileClick.current = true;
        // Its release completes a drawing click.
        const click = pressedClick(event.pointerId);
        if (click) lastClick.current = { ...click, pointerId: null };
      }}
      onPointerUp={(event) => {
        const press = drawingPress.current;
        if (press && event.pointerId === press.pointerId) {
          drawingPress.current = null;
          // Nothing more once the draft changed again during the press, for example by a cancel or a keyboard pick. A held press
          // away from the last point placed nothing, so it may also begin a drawing or end an idle one.
          const held = press.held;
          if (event.button !== 0 || interactionLocked || draftChanges.current.count !== press.changes || !(points.length > 0 || pathPending || held && !held.last)) return;
          if (press.dragged) {
            // A drag is no click, so it never starts a double-click.
            acceptDrawingPick(getDrawingPick(event), event, press.fromIdle); lastClick.current = null;
          } else if (held) {
            // A still second click finishes a chain with something to finish; its first click already placed its point. The
            // second click after a click that saved the chain is spent and starts nothing.
            if (held.second?.finished) { lastClick.current = null; return; }
            if (held.second && finishDoubleClick(press)) return;
            // Otherwise a held press is a deliberate short pick, unless it repeats the last point exactly. It resolves again at
            // the pressed sketch position so Ctrl or Cmd pressed during the hold still releases snaps and relations.
            const pick = resolveDrawingPick(held.raw, event.ctrlKey || event.metaKey, 'pointer', held.scale);
            if (!held.last || pick.point[0] !== held.last[0] || pick.point[1] !== held.last[1]) acceptDrawingPick(pick, { clientX: press.clientX, clientY: press.clientY });
            noteClick(press, pick);
          }
          return;
        }
        const reference = fixedPress.current;
        if (reference && event.pointerId === reference.pointerId) {
          fixedPress.current = null;
          // A press that stayed within the drag slop is a click on the reference; the box or profile drag it started ends unapplied.
          if (event.button === 0 && Math.hypot(event.clientX - reference.clientX, event.clientY - reference.clientY) <= 4) {
            if (boxSelection.active()) boxSelection.cancel(false);
            finishProfileDrag(event.pointerId); suppressProfileClick.current = true;
            // It selects only in the document, sketch, cancellation and canvas frame it began in.
            const current = reference.documentVersion === documentVersion && reference.sketchId === sketch.id && reference.cancelSignal === cancelSignal
              && projectSelection(event)?.frame === reference.frame;
            if (current && fixedSelect && !interactionLocked) chooseFixed(reference.selection, reference.additive);
            return;
          }
        }
        if (boxSelection.active()) { if (boxSelection.end(event)) suppressProfileClick.current = true; return; }
        if (profileDrag.current) {
          if (event.pointerId !== profileDrag.current.pointerId) return;
          if (event.button === 0) moveProfile(event);
          const retain = event.button === 0 && profileDrag.current.moved && profileDrag.current.translation.some(value => value !== 0);
          const active = finishProfileDrag(event.pointerId, retain);
          if (event.button === 0 && active?.moved && (active.translation[0] !== 0 || active.translation[1] !== 0)) {
            submitEdit(signal => active.handle ? commitHandle(active.profile.id, active.handle, active.translation, signal)
              : onTranslateProfile?.(active.profile.id, active.translation, signal), () => setDragPreview(null), 'Unable to move this contour.');
          }
          return;
        }
        const active = pan.current;
        if (!active || active.pointerId !== event.pointerId) return;
        finishPan(event.pointerId);
        if (active.button !== 2 || event.button !== 2 || active.moved || Math.hypot(event.clientX - active.x, event.clientY - active.y) > 4 || interactionLocked || viewLocked) return;
        const pickItems = geometryPick?.contextMenu && !positionPick ? openPickMenu(event) : false;
        if (pickItems) return;
        const dimension = active.dimension && tool === 'select' && (!geometryPick || geometryPick.dimensionsInteractive) && !positionPick && !isPreview && graphControls?.onDimensionMenu ? active.dimension : null;
        // A label or a relation glyph opens its menu at once; a line or arrow opens its dimension's only where no sketch geometry lies under the release.
        if (dimension && !active.dimensionLine) { graphControls?.onDimensionMenu?.(dimension, { clientX: event.clientX, clientY: event.clientY }); return; }
        if (active.relations && tool === 'select' && !geometryPick && !positionPick && !isPreview && graphControls?.onRelationMenu) {
          graphControls.onRelationMenu(active.relations, { clientX: event.clientX, clientY: event.clientY }); return;
        }
        if (openOverlap(event)) return;
        if (dimension) { graphControls?.onDimensionMenu?.(dimension, { clientX: event.clientX, clientY: event.clientY }); return; }
        const point = getRawPoint(event), rect = event.currentTarget.getBoundingClientRect();
        if (!geometryPick && !positionPick && pickFilter === 'auto' && point && rect.height) onContextMenu?.({ clientX: event.clientX, clientY: event.clientY, trigger: 'pointer', profileId: profilePicker.pick(point, span / rect.height), pointMm: point });
      }}
      onPointerCancel={(event) => { if (drawingPress.current?.pointerId === event.pointerId) drawingPress.current = null; if (fixedPress.current?.pointerId === event.pointerId) dropFixedPress();
        // A cancelled pointer ends in no click, so its press cannot begin a double-click either.
        if (pressedClick(event.pointerId)) lastClick.current = null;
        abandonedPresses.current.delete(event.pointerId); boxSelection.cancelPointer(event); finishProfileDrag(event.pointerId); finishPan(event.pointerId); }}
      onLostPointerCapture={(event) => { if (drawingPress.current?.pointerId === event.pointerId) drawingPress.current = null; if (fixedPress.current?.pointerId === event.pointerId) dropFixedPress();
        // Capture lost before the release ends the press in no click. After the release, the click no longer names its pointer.
        if (pressedClick(event.pointerId)) lastClick.current = null;
        boxSelection.cancelPointer(event); finishProfileDrag(event.pointerId); finishPan(event.pointerId); }}
      onPointerMove={(event) => {
        lastPointer.current = { clientX: event.clientX, clientY: event.clientY };
        const press = drawingPress.current;
        if (press && event.pointerId === press.pointerId) {
          if (!(event.buttons & 1)) drawingPress.current = null;
          else if (!press.dragged && Math.hypot(event.clientX - press.clientX, event.clientY - press.clientY) > DRAWING_DRAG_PIXELS) {
            press.dragged = true;
            // A held second press away from the last point draws like any drag once it moves. Its own pick is placed now, and
            // rendered at once, so the release places the next pick on the updated draft.
            const held = press.held;
            if (held && !held.last) {
              press.held = null;
              flushSync(() => acceptDrawingPick(resolveDrawingPick(held.raw, event.ctrlKey || event.metaKey, 'pointer', held.scale), { clientX: press.clientX, clientY: press.clientY }));
              const change = draftChanges.current;
              if (change.count !== press.changes && change.added) press.changes = change.count; else drawingPress.current = null;
            }
          }
        }
        // A press that drags is no click.
        const click = pressedClick(event.pointerId);
        if (click && Math.hypot(event.clientX - click.clientX, event.clientY - click.clientY) > DRAWING_DRAG_PIXELS) lastClick.current = null;
        const reference = fixedPress.current;
        if (reference && event.pointerId === reference.pointerId && (!(event.buttons & 1) || Math.hypot(event.clientX - reference.clientX, event.clientY - reference.clientY) > 4)) fixedPress.current = null;
        if (boxSelection.active()) { boxSelection.move(event); return; }
        if (profileDrag.current) {
          if (event.pointerId !== profileDrag.current.pointerId) return;
          if (!(event.buttons & 1)) { finishProfileDrag(event.pointerId); return; }
          moveProfile(event); return;
        }
        const active = pan.current;
        if (active) {
          if (event.pointerId !== active.pointerId) return;
          if (Math.hypot(event.clientX - active.x, event.clientY - active.y) > 4) active.moved = true;
          if (!(event.buttons & active.buttonMask)) { finishPan(event.pointerId); return; }
          const rect = event.currentTarget.getBoundingClientRect();
          if (!rect.width || !rect.height) { finishPan(event.pointerId); return; }
          setCenter([active.center[0] - (event.clientX - active.x) / rect.width * width, active.center[1] + (event.clientY - active.y) / rect.height * span]);
        } else if (event.target instanceof Element && (event.target.closest('.cad-sketch-graph-dimension.is-interactive')
          || event.target.closest('.cad-sketch-relation-glyph.is-interactive') && !relationGlyphCover.current(event))) {
          // Hovering a selectable dimension label or relation glyph only lights up its geometry through the highlight overlay. The drawing
          // cursor keeps its last position and a grip, origin or axis hover ends once, so moving across a label renders nothing else. A glyph over
          // geometry, the origin, an axis or a grip leaves the hover to them. Drawing tools and picks make annotations inert, so there the cursor keeps following the pointer.
          if (hoverHandle) setHoverHandle(null);
          if (fixedHover) setFixedHover(null);
        } else {
          // A dimension line or arrow keeps the cursor where it was too, but the origin, an axis or a grip under it still takes the hover, as it takes the press;
          // the line's own cover test already found them for this move.
          const onLine = event.target instanceof Element && event.target.closest('[data-cad-sketch-dimension-hit]') !== null;
          // The Dimension tool's preview follows the pointer through its own store, so the move renders the preview alone.
          const pointer = geometryPick?.pointer, raw = pointer ? getRawPoint(event) : null;
          if (pointer && raw) pointer.set({ x: raw[0], y: raw[1] }, overlayFrame.mmPerPixel);
          if (!onLine && !geometryPick?.dimensionPreview) getDrawingPick(event);
          if (tool === 'trim') {
            const preview = interactionLocked || viewLocked ? null : trimAt(event);
            setTrimHover(preview && sourceGraph ? { prepared: sourceGraph, preview } : null);
          }
          const gripHover = tool === 'select' && !geometryPick && !positionPick && Boolean(onMoveHandle);
          if ((fixedEligible || gripHover) && !interactionLocked && !viewLocked) {
            const point = getRawPoint(event), rect = event.currentTarget.getBoundingClientRect(), millimetersPerPixel = rect.height ? span / rect.height : 0;
            // The graph layer's hit areas already say which sketch point, edge or dimension label is under the pointer, so hover never searches the graph.
            const graphTarget = event.target instanceof Element ? event.target.closest('[data-cad-sketch-point], [data-cad-sketch-entity], [data-cad-sketch-dimension]') : null;
            const cover = onLine ? dimensionLineCover.current(event) : null;
            const grip = gripHover && !graphTarget && point && millimetersPerPixel ? cover ? cover.grip : pickGrip(event, point, millimetersPerPixel) : null;
            if (gripHover) setHoverHandle(grip);
            if (fixedEligible) {
              const covered = Boolean(graphTarget && graphTarget.getAttribute('aria-disabled') !== 'true' || grip && pickFilter === 'auto');
              const next = cover ? covered ? null : cover.fixed : point && millimetersPerPixel ? fixedUnder(point, millimetersPerPixel, covered) : null;
              if (next !== fixedHover) setFixedHover(next);
            }
          }
        }
      }}
      onPointerLeave={() => { lastPointer.current = null; setHoverHandle(null); setFixedHover(null); setTrimHover(null); setCursorInput(current => ({ ...current, point: cursor, mode: 'position' })); }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape') dropFixedPress();
        if (positionPick && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); positionPick.onCancel(); return; }
        if (geometryPick && !interactionLocked && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); geometryPick.onCancel(); return; }
        if (event.key === 'Escape' && boxSelection.active()) { event.preventDefault(); event.stopPropagation(); suppressProfileClick.current = true; boxSelection.cancel(); return; }
        if (event.key === 'Escape' && submission.applying) {
          event.preventDefault(); event.stopPropagation(); escapeDrawing(); return;
        }
        if (event.key === 'Escape' && profileDrag.current) { event.preventDefault(); event.stopPropagation(); finishProfileDrag(); return; }
        if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) {
          event.preventDefault(); event.stopPropagation();
          if (interactionLocked || viewLocked) return;
          finishPan();
          const element = event.target instanceof Element ? event.target.closest('[data-cad-sketch-point], [data-cad-sketch-entity]') : null;
          const pointId = element?.getAttribute('data-cad-sketch-point'), entityId = element?.getAttribute('data-cad-sketch-entity');
          const point = pointId ? sourceGraph?.points.find(point => point.id === pointId)?.position : null;
          const segment = entityId ? sourceGraph?.geometry.segments.find(segment => segment.id === entityId) : null;
          const at = point ?? (segment ? [segment.start.x, segment.start.y] : center);
          const bounds = event.currentTarget.getBoundingClientRect();
          const shown = geometryPick?.pointer?.get(), menuAt = shown ? [shown.x, shown.y] : at;
          if (geometryPick?.contextMenu && !positionPick && openPickMenu({ clientX: bounds.left + bounds.width / 2 + (menuAt[0] - center[0]) / width * bounds.width,
            clientY: bounds.top + bounds.height / 2 - (menuAt[1] - center[1]) / span * bounds.height })) return;
          if (openOverlap({ clientX: bounds.left + bounds.width / 2 + (at[0] - center[0]) / width * bounds.width,
            clientY: bounds.top + bounds.height / 2 - (at[1] - center[1]) / span * bounds.height }, 'keyboard', pointId ? { kind: 'point', id: pointId } : entityId ? { kind: 'entity', id: entityId } : undefined)) return;
          const profileId = selectedProfileId && profilePicker.hasProfile(selectedProfileId) ? selectedProfileId : null;
          const rect = event.currentTarget.getBoundingClientRect();
          if (!geometryPick && !positionPick && pickFilter === 'auto') onContextMenu?.({ clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, trigger: 'keyboard', profileId, pointMm: center });
          return;
        }
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.key.toLowerCase() === 'n' && !event.nativeEvent.isComposing && selectOther(event.shiftKey ? -1 : 1, event.target)) { event.preventDefault(); event.stopPropagation(); return; }
        // A pick leaves focus on the geometry picked, which passes on the keys it has no use for once nothing more can be picked there. The
        // pick's Enter and its placed dimensions' Delete still belong to the canvas; every other key works only on the canvas itself.
        const onCanvas = event.target === event.currentTarget;
        if (!onCanvas && (event.defaultPrevented || !geometryPick || positionPick)) return;
        if (onCanvas && event.key.toLowerCase() === 'f') { if (!viewLocked) { event.preventDefault(); fit(); } return; }
        if (geometryPick?.onConfirm && !positionPick && !interactionLocked && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); geometryPick.onConfirm('key'); return; }
        if (interactionLocked || geometryPick && !positionPick && !geometryPick.dimensionsInteractive) return;
        if (event.key === 'Delete' && !geometryPick && !positionPick && tool === 'select' && graphControls?.selection.length && graphControls.onDelete) {
          event.preventDefault(); event.stopPropagation(); graphControls.onDelete(graphControls.selection[graphControls.selection.length - 1]); return;
        }
        const dimensions = tool === 'select' && !positionPick ? graphControls?.dimensionSelection ?? [] : [];
        if ((event.key === 'Delete' || event.key === 'Backspace') && dimensions.length && graphControls?.onDeleteDimension) {
          event.preventDefault(); event.stopPropagation(); graphControls.onDeleteDimension(); return;
        }
        // A pick that keeps placed dimensions interactive takes their Delete and nothing else.
        if (geometryPick && !positionPick) return;
        const step = gridStep * (event.shiftKey ? 10 : 1);
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          setCursorInput({ point: [cursor[0] + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0), cursor[1] + (event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0)], snapSuppressed: false, mode: 'position' });
        } else if ((event.key === 'Enter' || event.key === ' ') && (drawing || positionPick)) {
          event.preventDefault();
          if (positionPick) acceptDrawingPick(cursorPick);
          // Enter saves a line chain's completed segments open, dropping a pending arc endpoint, and adds a point while none is
          // complete; a sketch without connected edges can only close its chain.
          else if (event.key === 'Enter' && chainOpen && finishOpenChain()) return;
          else if (event.key === 'Enter' && chainTool && !chainOpen && pathDraft.kind === 'ready') finishPath(sketch.kind === 'sketch' && !onAddPath);
          else acceptDrawingPick(cursorPick);
        } else if (pathTool && pathPending && event.key === 'Backspace') { event.preventDefault(); changePath({ kind: 'undo-last' }); }
        else if (event.key === 'Backspace' && points.length) { event.preventDefault(); setPicks((current) => current.slice(0, -1)); noteDraftChange(false); }
        else if (event.key === 'Escape' && escapeDrawing()) event.preventDefault();
        else if (event.key === 'Escape' && tool === 'select' && (graphControls?.selection.length || graphControls?.dimensionSelection?.length)) { event.preventDefault(); event.stopPropagation(); graphControls.onSelect(null); }
      }}
      onClick={(event) => {
        // Chromium's click PointerEvent reports isPrimary=false even for the
        // primary mouse; primary-pointer filtering belongs to pointerdown.
        if (event.button !== 0 || interactionLocked || geometryPick || positionPick) return;
        if (event.detail > 0 && suppressProfileClick.current) { suppressProfileClick.current = false; event.preventDefault(); return; }
        if (tool === 'select') {
          if (event.shiftKey && graphControls) return;
          graphControls?.onSelect(null);
          const point = getRawPoint(event); const rect = svg.current?.getBoundingClientRect();
          if (point && rect?.height) {
            if (pickFilter !== 'auto') { setActiveHandle(null); onSelectProfile(null); return; }
            const grip = onMoveHandle ? pickGrip(event, point, span / rect.height) : null;
            setActiveHandle(grip);
            onSelectProfile(grip?.profileId ?? profilePicker.pick(point, span / rect.height));
          }
        } else if (drawing) {
          // A double-click that no press placed, such as a synthetic one, finishes a chain on its second click.
          if (chainOpen && event.detail >= 2 && pathDraft.kind !== 'idle') finishDoubleClick({ time: event.timeStamp, clientX: event.clientX, clientY: event.clientY });
          else acceptDrawingPick(getDrawingPick(event), event);
        }
      }}>
      <defs><pattern id="cad-sketch-grid" x={-center[0] % gridStep} y={center[1] % gridStep} width={gridStep} height={gridStep} patternUnits="userSpaceOnUse"><path d={`M ${gridStep} 0 H 0 V ${gridStep}`} fill="none" className="cad-sketch-grid-line" strokeWidth={span / 1000} /></pattern></defs>
      {grid && span / gridStep < 2000 && gridBands(-width / 2, width / 2, -center[0], gridStep / 2).flatMap(([left, right]) => gridBands(-span / 2, span / 2, center[1], gridStep / 2)
        .map(([top, bottom]) => <rect key={`${left} ${top}`} x={left} y={top} width={right - left} height={bottom - top} fill="url(#cad-sketch-grid)" />))}
      <CadSketchAxes origin={[-center[0], center[1]]} pixel={span / (viewportSize.height || 600)} view={[width, span]} fixedProps={fixedProps} />
      <g transform="scale(1,-1)" strokeWidth={span / 450}>
        {savedCurve && <g className="cad-profile is-selected"><CadPathDraftGeometry segments={savedCurve.segments} preview={false} viewCenter={center} halo={halo} /></g>}
        {(!graphControls || !sourceGraph) && graphGeometry?.segments.map(segment => {
          const boundary = cadSketchGraphBoundary(segment);
          const construction = graphGeometry.constructionIds.has(segment.id);
          const shape = boundary.type === 'line' ? <line x1={boundary.start.x - center[0]} y1={boundary.start.y - center[1]} x2={boundary.end.x - center[0]} y2={boundary.end.y - center[1]} />
            : boundary.type === 'circle' ? <circle cx={boundary.center.x - center[0]} cy={boundary.center.y - center[1]} r={boundary.radius} />
              : <path d={cadArcSvgPath(boundary, center)} />;
          return <g key={segment.id} data-cad-sketch-entity={segment.id} className={`cad-profile${construction ? ' is-construction' : ''}`} strokeDasharray={construction ? `${span / 80} ${span / 120}` : undefined}>
            {halo > 0 && <g className="cad-sketch-halo" strokeWidth={halo}>{shape}</g>}{shape}
          </g>;
        })}
        {profiles.map((profile) => <g key={profile.id} role="button" aria-disabled={Boolean(geometryPick || positionPick) || undefined} aria-label={`Select ${profile.name} profile`} aria-pressed={profile.id === selectedProfileId && detailSelection.kind === 'profile'} transform={dragPreview?.profile.id === profile.id && !dragPreview.handle ? `translate(${dragPreview.translation[0]} ${dragPreview.translation[1]})` : undefined} tabIndex={tool === 'select' && !geometryPick && !positionPick && pickFilter === 'auto' && !interactionLocked ? 0 : -1} data-cad-parameter-highlight={inspection?.profileIds.includes(profile.id) ? profile.id : undefined} data-cad-drawing-snap-profile={snapProfile?.id === profile.id ? profile.id : undefined}
          className={`cad-profile ${profile.construction ? 'is-construction' : ''} ${profile.id === selectedProfileId && detailSelection.kind === 'profile' ? 'is-selected' : ''} ${inspection?.profileIds.includes(profile.id) ? 'is-parameter-highlighted' : ''} ${snapProfile?.id === profile.id ? 'cad-sketch-entity is-pick-highlighted' : ''}`} strokeDasharray={profile.construction ? `${span / 80} ${span / 120}` : undefined} onKeyDown={(event) => { if ((event.key === 'Enter' || event.key === ' ') && tool === 'select' && !geometryPick && !positionPick && pickFilter === 'auto' && !interactionLocked) { event.preventDefault(); event.stopPropagation(); setActiveHandle(null); onSelectProfile(profile.id); } }} onClick={(event) => { if (event.detail === 0 && event.button === 0 && tool === 'select' && !geometryPick && !positionPick && pickFilter === 'auto' && !interactionLocked) { event.stopPropagation(); setActiveHandle(null); onSelectProfile(profile.id); } }}><CadSketchProfileGeometry geometry={dragPreview?.handle && dragPreview.profile.id === profile.id ? dragPreview.profile.geometry : profile.geometry} parameters={parameters} viewCenter={center} halo={halo} /></g>)}
        {tool === 'select' && !geometryPick && !positionPick && pickFilter === 'auto' && onMoveHandle && !isPreview && !externalInteractionLocked && <g className="cad-sketch-handles">
          {displayHandles.map(grip => {
            const key = `${grip.profileId}/${cadSketchHandleKey(grip.handle)}`;
            const selected = activeHandle?.profileId === grip.profileId && cadSketchHandleKey(activeHandle.handle) === cadSketchHandleKey(grip.handle);
            return <circle key={key} data-cad-sketch-grip={key} cx={grip.point[0] - center[0]} cy={grip.point[1] - center[1]} r={4 * span / (viewportSize.height || 600)}
              role="button" tabIndex={interactionLocked ? -1 : 0} aria-label={`${grip.label} of ${grip.profileName}${grip.draggable ? '' : grip.unavailableReason ? ', unavailable' : ', constrained'}`} aria-pressed={selected} aria-disabled={interactionLocked || !grip.draggable}
              className={`cad-sketch-handle${selected ? ' is-active' : ''}${grip.draggable ? '' : ' is-locked'}`}
              onClick={event => { if (!interactionLocked && event.detail === 0) { event.stopPropagation(); setActiveHandle(grip); onSelectProfile(grip.profileId); } }}
              onKeyDown={event => {
                if (interactionLocked || viewLocked || event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault(); event.stopPropagation(); setActiveHandle(grip); onSelectProfile(grip.profileId); return;
                }
                const step = gridStep * (event.shiftKey ? 10 : 1);
                const delta: SketchPoint | null = event.key === 'ArrowLeft' ? [-step, 0] : event.key === 'ArrowRight' ? [step, 0] : event.key === 'ArrowUp' ? [0, step] : event.key === 'ArrowDown' ? [0, -step] : null;
                if (!delta) return;
                event.preventDefault(); event.stopPropagation();
                if (!grip.draggable) return;
                setActiveHandle(grip); onSelectProfile(grip.profileId);
                submitEdit(signal => commitHandle(grip.profileId, grip.handle, delta, signal), () => undefined, 'Unable to edit this point.');
              }}>
              <title>{grip.label}{grip.draggable ? ' · Drag to edit, or use arrow keys' : ` · ${grip.unavailableReason ?? 'Controlled by dimensions or expressions'}`}</title>
            </circle>;
          })}
        </g>}
        {graphControls && sourceSketch.kind === 'sketch' && sourceGraph && layerControls && <CadSketchGraphLayer controls={layerControls} sketch={sourceSketch} version={documentVersion} prepared={sourceGraph} visual={visualGraph ?? undefined}
          center={center} scaleX={width / (viewportSize.width || 800)} scaleY={span / (viewportSize.height || 600)} gridStep={gridStep} snap={snap} gridSnap={gridSnap} active={tool === 'select'}
          filter={graphPickFilter} relationsSelectable={cadSelectionAccepts(selectionFilter, 'relation')} dimensionsSelectable={cadSelectionAccepts(selectionFilter, 'dimension')} highlighted={graphHighlight} halo={halo} pickAt={pickGraphAt} coversDimensionLine={coversDimensionLine} coversRelationGlyph={coversRelationGlyph}
          locked={externalInteractionLocked || Boolean(positionPick && !geometryPick) || submission.applying || points.length > 0 || pathPending || dragPreview !== null || boxPending || overlapPending || choicePending} cancelSignal={cancelSignal} onPendingChange={publishGraphPending} onError={onError} />}
        {graphControls?.patternInteraction && sourceSketch.kind === 'sketch' && (previewSketch ?? sourceSketch).graph && <CadSketchLinearPatternPreview graph={(previewSketch ?? sourceSketch).graph!} parameters={parameters} interaction={graphControls.patternInteraction} center={center} mmPerPixel={span / (viewportSize.height || 600)} />}
        {inspection?.gear && inspectedGear?.geometry.kind === 'plugin' && <CadGearInspectionOverlay profile={inspectedGear.geometry} parameters={parameters} inputName={inspection.gear.inputName} span={span} viewCenter={center} />}
        {pathTool && pathDraft.kind !== 'idle' && <>
          <CadPathDraftGeometry segments={pathDraft.segments} viewCenter={center} halo={halo} />
          <circle cx={pathDraft.start[0] - center[0]} cy={pathDraft.start[1] - center[1]} r={span / 170} className="cad-sketch-vertex" />
          {pathDraft.kind === 'arc-through' && <circle cx={pathDraft.end[0] - center[0]} cy={pathDraft.end[1] - center[1]} r={span / 170} className="cad-sketch-vertex" />}
        </>}
        {currentSnapChoice && choiceHighlight && <g pointerEvents="none" aria-hidden="true">
          {sourceGraph?.geometry.segments.filter(segment => choiceHighlight.entityIds.includes(segment.id)).map(segment => {
            const boundary = cadSketchGraphBoundary(segment);
            return <g key={segment.id} data-cad-drawing-snap-owner={segment.id} className="cad-profile cad-sketch-entity is-pick-highlighted" fill="none">
              {boundary.type === 'line' ? <line x1={boundary.start.x - center[0]} y1={boundary.start.y - center[1]} x2={boundary.end.x - center[0]} y2={boundary.end.y - center[1]} />
                : boundary.type === 'circle' ? <circle cx={boundary.center.x - center[0]} cy={boundary.center.y - center[1]} r={boundary.radius} />
                  : <path d={cadArcSvgPath(boundary, center)} />}</g>;
          })}
          <CadSketchSnapHint candidate={choiceHighlight} center={center} scaleX={width / (viewportSize.width || 800)} scaleY={span / (viewportSize.height || 600)}
            label={choiceHighlight.target.kind === 'profile-position' ? `${cadSketchProfileSnapLabel(choiceHighlight.target, sourceProfiles)} · Position only · No relation`
              : choicePointId === undefined ? 'Choose midpoint' : `Choose Point ${(sourceGraph?.graph.points.findIndex(point => point.id === choicePointId) ?? -1) + 1}`} />
        </g>}
        {points.map(([x, y], index) => <circle key={index} cx={x - center[0]} cy={y - center[1]} r={span / 170} className="cad-sketch-vertex" />)}
        {attachmentMarkers}
      </g>
    </svg>
    {/* Drawing that follows the pointer paints on its own layer, so a move repaints only it; the canvas keeps every pick. The layer stays for
        the canvas's life: promoting it when a box, pick or tool starts stalled that first frame, and an empty layer costs nothing measurable. */}
    <CadSketchOverlay frame={overlayFrame} layer="pointer">
      {geometryPick?.dimensionPreview && geometryPick.pointer && <CadSketchDimensionPreview plan={geometryPick.dimensionPreview} pointer={geometryPick.pointer} center={center} mmPerPixel={overlayFrame.mmPerPixel} />}
      {currentOverlap?.action === 'split' && currentOverlap.split?.kind === 'ready' && <CadSketchSplitPreview preview={currentOverlap.split} center={center} mmPerPixel={overlayFrame.mmPerPixel} outlined={outlined} />}
      {currentTrim?.kind === 'ready' && <CadSketchTrimPreview preview={currentTrim} center={center} mmPerPixel={overlayFrame.mmPerPixel} outlined={outlined} />}
      {currentOverlap?.action === 'trim' && currentOverlap.trim?.kind === 'ready' && <CadSketchTrimPreview preview={currentOverlap.trim} center={center} mmPerPixel={overlayFrame.mmPerPixel} outlined={outlined} />}
      {currentOverlap?.action === 'extend' && activeExtend?.kind === 'ready' && <CadSketchExtendPreview preview={activeExtend} center={center} mmPerPixel={overlayFrame.mmPerPixel} outlined={outlined} />}
      {preview && <g className="cad-profile cad-profile-preview"><CadSketchProfileGeometry geometry={preview} parameters={parameters} viewCenter={center} halo={halo} /></g>}
      {pathTool && pathDraft.kind !== 'idle' && (pathPreview.kind === 'line' || pathPreview.kind === 'arc') && <g className="cad-profile cad-profile-preview">
        {halo > 0 && <g className="cad-sketch-halo" strokeWidth={halo}><CadPathSegmentGeometry segment={pathPreview.segment} origin={center} /></g>}<CadPathSegmentGeometry segment={pathPreview.segment} origin={center} /></g>}
      {pathTool && pathDraft.kind === 'arc-through' && pathPreview.kind === 'invalid' && <g className="cad-path-invalid">
        {halo > 0 && <polyline className="cad-sketch-halo" strokeWidth={halo} points={invalidArcPoints} />}<polyline points={invalidArcPoints} /></g>}
      {drawingReadout && viewportSize.height > 0 && <g data-cad-drawing-readout="" pointerEvents="none" aria-hidden="true"
        transform={`translate(${cursor[0] - center[0]},${cursor[1] - center[1]}) scale(${width / viewportSize.width},${-span / viewportSize.height})`}>
        <rect className="cad-sketch-snap-label-bg" x="12" y="10" width={drawingReadout.length * 5.6 + 12} height="19" rx="3" />
        <text className="cad-sketch-snap-label" x="18" y="23">{drawingReadout}</text>
      </g>}
      {snapHint && viewportSize.height > 0 && <CadSketchSnapHint candidate={snapHint} center={center} scaleX={width / viewportSize.width} scaleY={span / viewportSize.height} label={snapLabel} />}
      {placement && <g data-cad-sketch-placement="" pointerEvents="none" aria-hidden="true">
        {placement.anchor && placement.target && <line className="cad-sketch-snap-target"
          x1={placement.anchor[0] - center[0]} y1={placement.anchor[1] - center[1]} x2={placement.target[0] - center[0]} y2={placement.target[1] - center[1]} />}
        {placement.anchor && <g transform={`translate(${placement.anchor[0] - center[0]},${placement.anchor[1] - center[1]}) scale(${width / (viewportSize.width || 800)},${-span / (viewportSize.height || 600)})`}>
          <path className="cad-sketch-snap-target" d="M -7 0 H 7 M 0 -7 V 7" /><rect className="cad-sketch-snap-target" x="-4" y="-4" width="8" height="8" />
        </g>}
        {placement.target && <g transform={`translate(${placement.target[0] - center[0]},${placement.target[1] - center[1]}) scale(${width / (viewportSize.width || 800)},${-span / (viewportSize.height || 600)})`}>
          <circle className="cad-sketch-snap-target" r="5" />
          <rect className="cad-sketch-snap-label-bg" x="9" y="-25" width={placementAngle.length * 5.5 + 12} height="19" rx="3" />
          <text className="cad-sketch-snap-label" x="15" y="-12">{placementAngle}</text>
        </g>}
      </g>}
      {boxSelection.box && <rect className={`cad-sketch-selection-box is-${boxSelection.box.mode}`} pointerEvents="none"
        x={Math.min(boxSelection.box.start[0], boxSelection.box.end[0]) - center[0]} y={Math.min(boxSelection.box.start[1], boxSelection.box.end[1]) - center[1]}
        width={Math.abs(boxSelection.box.end[0] - boxSelection.box.start[0])} height={Math.abs(boxSelection.box.end[1] - boxSelection.box.start[1])} />}
    </CadSketchOverlay>
    {currentSnapChoice && <CadSketchSnapChooser anchor={{ x: currentSnapChoice.clientX, y: currentSnapChoice.clientY }} candidates={currentSnapChoice.candidates} graph={sourceGraph?.graph} profiles={sourceProfiles}
      onClose={closeSnapChoice} onHighlight={candidate => { if (choiceIsCurrent(currentSnapChoice)) setChoiceHighlight(candidate); }}
      onChoose={candidate => { if (choiceIsCurrent(currentSnapChoice)) placeChosen.current(candidate, currentSnapChoice.saveLine); }}
      onOutsidePointerDown={event => {
        suppressProfileClick.current = true; event.preventDefault(); event.stopPropagation();
        // The press that dismisses the chooser is still a click, so a double-click there finishes the chain.
        if (chainOpen && event.button === 0) noteClick({ time: event.timeStamp, clientX: event.clientX, clientY: event.clientY, pointerType: event.pointerType }, undefined, event.pointerId);
      }} />}
    {currentOverlap && <CadContextMenu anchor={{ x: currentOverlap.clientX + (currentOverlap.target ? 12 : 0), y: currentOverlap.clientY + (currentOverlap.target ? 12 : 0) }} title={currentOverlap.target ? currentOverlap.target.kind === 'point' ? 'Sketch point' : 'Sketch edge' : 'Select other'} items={overlapItems} onClose={closeOverlap}
      onOutsidePointerDown={event => { event.preventDefault(); event.stopPropagation(); suppressProfileClick.current = true; }} />}
    {currentPickMenu && pickMenuContent && <CadContextMenu anchor={{ x: currentPickMenu.clientX, y: currentPickMenu.clientY }} title={pickMenuContent.title} items={pickMenuContent.items} onClose={() => setPickMenu(null)}
      onOutsidePointerDown={event => { event.preventDefault(); event.stopPropagation(); suppressProfileClick.current = true; }} />}
    {dimensionControls && sketch.kind === 'sketch' && dimensionProfile && dimensionAnchor && tool === 'select' && !isPreview && <CadSketchDimensionControls {...dimensionControls} onError={onError} interactionLocked={dimensionControls.interactionLocked || submission.applying || dragPreview !== null} sketch={sketch} profile={dimensionProfile} parameters={parameters} anchor={dimensionAnchor} project={point => ({ x: (point[0] - center[0]) / width * viewportSize.width + viewportSize.width / 2, y: (center[1] - point[1]) / span * viewportSize.height + viewportSize.height / 2 })} cancelSignal={cancelSignal} />}
    {!isPreview && inspection && inspection.profileIds.length > 0 ? <div className="cad-sketch-context" role="status">Highlighted geometry · {inspection.profileIds.length} {inspection.profileIds.length === 1 ? 'profile' : 'profiles'}</div>
      : !isPreview && contextStatus && <div className="cad-sketch-context" role="status" data-cad-dimension-status="">{contextStatus}</div>}
    <p id={instructionsId} className="cad-sr-only">{interactionLocked ? 'Drawing is paused while another edit or operation is active.' : currentTrim?.kind === 'ready' ? `${instruction}. ${currentTrim.help}` : instruction} Keyboard: arrow keys move the cursor, Shift moves ten grid steps, Space adds a point, Enter adds a point or finishes a line chain, Backspace undoes the last point or segment, Escape finishes a line chain or cancels drawing and, with nothing pending, returns to Select, F fits the sketch.</p>
    {viewTools}
    {selectionActionsShown && graphControls?.selectionActions && sourceGraph && <CadSketchSelectionActions model={graphControls.selectionActions} prepared={sourceGraph} center={center} width={width} span={span}
      pixelWidth={viewportSize.width} pixelHeight={viewportSize.height} busy={interactionLocked} onEscape={focusCanvas} onRoomChange={setSelectionActionsRoom} />}
    {/* A chain that can stay open keeps the toolbar in view, since a tool switch saves it; its tools wait for a completed segment. */}
    {!externalInteractionLocked && (tool !== 'select' || points.length > 0) && <CadDrawingTools active={points.length > 0 || pathPending && !chainOpen}><div className={`cad-sketch-instruction ${chainTool ? 'cad-path-instruction' : ''}`} onKeyDown={event => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Escape' && (submission.applying || !event.ctrlKey && !event.metaKey && !event.altKey) && escapeDrawing()) { event.preventDefault(); event.stopPropagation(); svg.current?.focus(); return; }
      if (!pathTool || !pathPending || interactionLocked || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'Backspace') { event.preventDefault(); changePath({ kind: 'undo-last' }, true); }
    }}><span>{instruction}</span>
      {canInfer && <label className="cad-check"><Input type="checkbox" aria-label="Create relations" checked={inferCoincidence} disabled={interactionLocked}
        title="Attach future snapped points with removable relations: coincident with endpoints and centers, on a line, arc or circle, or on the origin and axes. A line drawn along its start's horizontal or vertical guide stays horizontal or vertical. Switching off releases pending relations; accepted geometry is unchanged."
        onChange={event => { const enabled = event.target.checked; setInferCoincidence(enabled); if (!enabled) { setPicks(current => current.map(pick => ({ kind: 'position', point: pick.point }))); setPathDraft(releaseCadPathDraftPicks); } }} />Create relations</label>}
      {pendingPicks.length > 0 && <span aria-label="Pending relations">{pendingPicks.length} attached</span>}
      {chainTool && <>
        <div className="cad-path-modes" role="group" aria-label="Segment mode"><Button disabled={interactionLocked || pathDraft.kind === 'arc-through'} aria-label="Line segment" aria-pressed={pathMode === 'line'} onClick={() => changePath({ kind: 'mode', mode: 'line' }, true)}>Line</Button><Button disabled={interactionLocked || pathDraft.kind === 'arc-through'} aria-pressed={pathMode === 'arc'} onClick={() => changePath({ kind: 'mode', mode: 'arc' }, true)}>3-point Arc</Button></div>
        {pathPending && <>{chainOpen && <Button aria-label="Finish chain" title="Save the completed segments open, without a closing edge (Enter, double-click or Escape)" disabled={chainFinishLocked || !completedCadPathChain(pathDraft)} onClick={() => finishOpenChain()}><ConfirmIcon size={13} /> Finish</Button>}<Button aria-label={sketch.kind === 'curve' ? 'Finish curve' : 'Close profile'} title={sketch.kind === 'curve' ? 'Validate and save the open curve without a closing edge' : pathNeedsClosingLine ? 'Close the profile by adding a straight line to its start' : 'Validate and save the closed profile'} disabled={interactionLocked || pathDraft.kind !== 'ready' || !pathDraft.segments.length} onClick={() => finishPath(true)}><ConfirmIcon size={13} />{sketch.kind === 'curve' ? 'Finish curve' : pathNeedsClosingLine ? 'Close with line' : 'Close profile'}</Button><Button disabled={interactionLocked} onClick={() => changePath({ kind: 'undo-last' }, true)}><UndoIcon size={13} /> Undo last</Button><Button onClick={() => changePath({ kind: 'cancel' }, true)}><CloseIcon size={13} /> Cancel drawing</Button></>}
      </>}
      {(points.length > 0 || singleSegment && pathPending) && <Button onClick={cancelDrawing}><CloseIcon size={13} /> Cancel drawing</Button>}</div></CadDrawingTools>}
    <div className="cad-view-caption">{geometryPick?.dimensionPreview && geometryPick.pointer ? <CadSketchPointerReadout pointer={geometryPick.pointer} fallback={cursor} /> : <>{formatCadQuantity(Number(cursor[0].toFixed(3)))}, {formatCadQuantity(Number(cursor[1].toFixed(3)))} mm</>}</div>
  </div>;
}
