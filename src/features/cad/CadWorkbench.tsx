import { userFacingMessage } from '@/lib/userMessage';
import { cadFeatureActive } from '@/domain/cad/features/cadFeatureActivity';
import { MenuItem, MenuSeparator, MenuSurface } from '@/components/ui/menu';
import { Tooltip } from '@/components/ui/tooltip';
import { useCadEditSubmission, type CadEditCompletion } from './useCadEditSubmission';
import { cadGeneratorRemovalPrompt, cadGeneratorRemovals, type CadGeneratorRemovals } from './cadGeneratorRemovals';
import type { CadPrepareEdits } from './useCadPreparedPreview';
import type { CadSketchGraphSelection } from './cadSketchGraphInteraction';
import { isCadSketchGraphSelected, reconcileCadSketchGraphSelection, toggleCadSketchGraphSelection, type CadSketchGeometryPick } from './cadSketchGraphSelection';
import { cadSketchFixedElementError, cadSketchVirtualSubject, isCadSketchVirtualId, isCadSketchVirtualSelection } from '@/domain/cad/sketch-relations/cadSketchVirtualElements';
import type { CadSketchGenerator, CadSketchGraph, CadSketchGraphRelation } from '@/domain/cad/cadSketchGraph';
import { cadSketchProfileEdits, cadSketchProfileGenerator, cadSketchProfileViews, cadSketchShapeEdits, withCadSketchProfile, withoutCadSketchProfile } from '@/domain/cad/sketch-generators/cadSketchProfileViews';
import { createCadFreshSketchDrawing, createCadFreshSketchGraph, type CadFreshSketchDrawing } from '@/domain/cad/cadFreshSketchGraph';
import { createCadPathDraftGraph } from './cadPathDraftGraph';
import { inspectCadSketchCornerTarget } from '@/domain/cad/cadSketchCornerTreatment';
import { cadPathDraftInferences, type CadPathDraft } from './cadPathDrawing';
import { CadSketchContextHeader } from './CadSketchContextHeader';
import { CadSketchDimensionValueEditor, isCadSketchValueRelation } from './CadSketchDimensionValueEditor';
import { CadSketchCornerEditor, CadSketchMoveEditor } from './CadSketchGeometryEditors';
import { CadSketchSelectionInspector } from './CadSketchSelectionInspector';
import { CadSketchGeneratorInputsEditor } from './CadSketchGeneratorInputsEditor';
import { CadSketchRelationList } from './CadSketchRelationList';
import { cadSketchSelectionRelationActions, type CadSketchSelectionAction, type CadSketchSelectionActionsModel } from './CadSketchSelectionActions';
import { cadSketchAnalysisIssues, cadSketchIssuesStandInForD1, NO_CAD_SKETCH_ISSUES_BY_RELATION, type CadSketchAnalysisIssues, type CadSketchIssue } from './cadSketchIssues';
import { cadSketchRelationOffers, type CadSketchRelationOffer } from '@/domain/cad/sketch-relations/cadSketchRelationOffers';
import type { CadSketchWarningsRecord } from './cadEditPreparation';
import {
  CAD_SKETCH_ORIGIN_PAIR_NAME, cadSketchAnnotationCount, cadSketchDimensionIds, cadSketchDimensionPick, cadSketchDimensionPickOf, cadSketchDrawnAnnotations, cadSketchRelationHighlight, createCadSketchHighlightStore,
  isCadSketchDimensionInGraph, isCadSketchDimensionPickCurrent, isCadSketchDimensionRelation, isCadSketchGlyphRelation, isCadSketchOriginPair, NO_SKETCH_DIMENSIONS, reconcileCadSketchDimensionSelection,
  sameCadSketchDimensionPick, selectCadSketchAnnotations, selectCadSketchDimension, type CadSketchDimensionPick
} from './cadSketchDimensionSelection';
import { cadSketchRelationName } from './cadSketchRelationNames';
import { CAD_SKETCH_RELATION_ICONS } from './CadSketchRelationGlyphs';
import { cadSketchDimensionToDriving, cadSketchDimensionToReference } from './cadSketchDimensionCommands';
import {
  CAD_SKETCH_DIMENSION_EXISTING_REASON, cadSketchDimensionBatchAt, cadSketchDimensionCandidateAt, cadSketchDimensionPickAllowed, cadSketchDimensionPickEligibility, cadSketchDimensionPickTargets, cadSketchDimensionPreselection, cadSketchDimensionRetry,
  NO_SKETCH_DIMENSION_PLAN, planCadSketchDimension, type CadSketchDimensionForm, type CadSketchDimensionOperand, type CadSketchDimensionPickTargets
} from './cadSketchDimensionPlacement';
import { createCadSketchPointerStore } from './CadSketchDimensionPreview';
import type { Point2 } from '@/domain/path-intel/types';
import { cadSketchDrawnDimensions, placeCadSketchDimensions } from './cadSketchGraphDimensionLayout';
import { withoutCadSketchDimensionAnnotation } from '@/domain/cad/cadSketchPlacedDimensions';
import { CadSketchAreaRepairPanel } from './CadSketchAreaRepairPanel';
import { CadSketchOffsetEditor, cadSketchOffsetSource } from './CadSketchOffsetEditor';
import { CadSketchLinearPatternEditor, type CadSketchLinearPatternRequest, type CadSketchLinearPatternInteraction } from './CadSketchLinearPatternEditor';
import { cadSketchLinearPatternForSelection } from '@/domain/cad/cadSketchLinearPattern';
import { cadSketchOwnedGeometryLockReason } from '@/domain/cad/cadSketchOwnedGeometry';
import { CadSketchMirrorEditor, type CadSketchMirrorInteraction } from './CadSketchMirrorEditor';
import { CadSketchPlacementEditor, type CadSketchPlacementInteraction } from './CadSketchPlacementEditor';
import { CadSketchProfileCopyEditor } from './CadSketchProfileCopyEditor';
import { CadSketchReferenceEditor, type CadSketchReferenceInteraction } from './CadSketchReferenceEditor';
import { cadSketchReferenceSources, cadSketchExternalReferenceLockReason } from '@/domain/cad/cadSketchExternalReferences';
import type { CadSketchProfileCopyRequest } from '@/domain/cad/cadSketchProfileCopy';
import { Value } from '@sinclair/typebox/value';
import type { CadSketchOffsetSource } from '@/domain/cad/cadSketchOffset';
import type { CadSketchAreaRepairInspection, CadSketchAreaRepairs } from './cadSketchEditDraft';
import { CadSketchConstraintStatus, type CadInspectSketchConstraints, type CadSketchConstraintReport } from './CadSketchConstraintStatus';
import { cadSketchDefinitionMarks, cadSketchDiagnosisMarks, type CadSketchDefinitionMarks, type CadSketchDiagnosisMarks } from './cadSketchDefinitionMarks';
import { CadSketchPreparationError, type CadSketchConstraintFeedback } from './cadSketchConstraintFeedback';
import { appendCadSketchGraphWithInferences, cadSketchInferenceNote } from './cadSketchInferenceFallback';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { useOptionalAppRail } from '@/app/AppRailContext';
import { AddIcon, ArcIcon, ArrowLeft, BooleanIcon, CameraCaptureIcon, Check, ChevronDown, ChevronRight, CircleIcon, CloseIcon, CurveIcon, DatumPlaneIcon, Download, FilePlus2, FolderOpen, Loader2, LineIcon, LinkIcon, LoftIcon, MeasureIcon, ConstraintIcon, MirrorIcon, Move3dIcon, MoveIcon, OffsetIcon, OriginIcon, FlipVerticalIcon, PadPocketIcon, PencilRuler, RectangleIcon, Redo2, RefreshIcon, RevolveIcon, Save, SectionCamIcon, SectionViewIcon, SelectIcon, SendCamIcon, ShellIcon, SketchIcon, SlotIcon, SweepIcon, Trash2, TrimIcon, Undo2, type WorkbenchIconComponent } from '@wire-edm/icons-react';

import { CadFeatureTree } from './CadFeatureTree';
import { CadCommandDock } from './CadCommandDock';
import type { CadBuildResult, CadCurveFeature, CadDocument, CadFeature, CadPathSegment, CadPlane, CadSketchPlane, CadProfile, CadSketchFeature, CadSketchProfile } from '@/domain/cad/cadDocument';
import { cadEditsOnlyPlaceDimensions, type CadEdit } from '@/domain/cad/cadOperations';
import type { CadTopologyPick, CadTopologyPickSet, CadTopologyResolvePicksRequest, CadTopologyResolvePicksResult } from '@/domain/cad/cadTopology';
import { cadTopologyChainPicks, type CadTopologyChainGesture, type CadTopologyChainPicks } from '@/domain/cad/selection/cadTopologySelection';
import type { CadTopologyAdjacency, CadTopologyAdjacencyRequest, CadTopologyTangentChain, CadTopologyTangentChainRequest } from '@/domain/cad/cadTopologyAdjacency';
import { cadDocumentsPlacedAlike, cadFeatureDependencies, cadFeatureProducesBody } from '@/domain/cad/cadSchema';
import { cadBodyFeatureId, cadBodyLineage, cadSelectedBody, type CadBodyLineage } from '@/domain/cad/cadBodies';
import { CadFeatureEditor, CadProfileEditor, featureLabels } from './CadFeatureEditor';
import { CadSketchProfilePanel, type CadSketchProfileCommand } from './CadSketchProfilePanel';
import { cadSketchDimensionQuantities, inspectCadSketchDimensions, translateCadSketchProfile } from '@/domain/cad/cadSketchConstraints';
import { moveCadSketchHandle, type CadSketchHandle } from '@/domain/cad/cadSketchHandles';
import { cadSketchSourceAvailability, cadSketchSourceIssue, cadSketchSourceIssueMessage, pickCadSketchSource, type CadSketchSourcePurpose } from '@/domain/cad/cadSketchSources';
import { CadSketchCanvas, type CadSketchContextMenuRequest, type CadSketchDrawingControls } from './CadSketchCanvas';
import { CadViewport, type CadOriginSelection, type CadSketchBackgroundView, type CadViewportContextMenuRequest, type CadViewportSection } from './CadViewport';
import { CadContextHelp } from './CadContextHelp';
import { Select } from '@/components/ui/select';
import { prepareCadDatumFrames, resolveCadSketchPlacement } from '@/domain/cad/cadDatumPlanes';
import { CAD_SKETCH_BACKGROUNDS, cadShownSection, cadStoredSectionView, cadViewStateFor, reduceCadPartView, reduceCadViewState, type CadPartViewAction, type CadSectionPlane, type CadViewAction } from './view/cadViewState';
import { cadSectionPlaneAvailable, resolveCadSectionFrame, sameCadSectionFrame } from './view/cadSectionView';
import { cadFeatureWithReference, cadReferenceSelectionName, type CadReferenceSelection } from './view/cadReferenceSelection';
import { cadSelectionAccepts, type CadSelectionFilter, type CadSelectionKind } from '@/domain/cad/selection/cadSelectionFilter';
import { createCadSketchCameraLink, sameCadSketchPlacementFrame, type CadSketchCameraView, type CadSketchPlacementFrame } from './view/cadSketchCamera';
import { cadSketchBackgroundReferences } from './view/cadSketchBackgroundStyle';
import { CadContextMenu, type CadContextMenuItem } from './CadContextMenu';
import { CadTopologyInspector, type CadInspectTopology } from './CadTopologyInspector';
import { CadTangentChainReads, mergeTopologySelection, sharedCadTopologyRead, validateTopologySelection, type CadPickMode, type CadTopologyHit } from './cadTopologyPicking';
import type { SketchTool } from './cadSketchInteraction';
import { CAD_KERNEL_THIRD_PARTY } from './kernel/cadKernelNotices';
import { ToolError } from '@/features/webmcp/siteTools';
import { createCadWorkbenchViewportControls, type CadViewportBindings } from './cadWorkbenchViewport';
import type { CadRenderedViewControls, CadWorkbenchViewportControls } from './cadViewportControls';
import { CadPatternCommand } from './CadPatternCommand';
import { CadToolbarMenu } from './CadToolbarMenu';
import { CAD_SKETCH_CONSTRAINT_TOOLS, cadSketchConstraintStep, cadSketchConstraintToolHelp, cadSketchConstraintToolLabels, type CadSketchConstraintPick, type CadSketchConstraintTool } from './cadSketchConstraintTool';
import { cadSketchRelationPlacement } from '@/domain/cad/cadSketchRelationPlacement';
import { CadEdgeTreatmentCommand } from './CadEdgeTreatmentCommand';
import { CadPluginsPanel, type CadPluginCommands } from './CadPluginsPanel';
import { type CadPluginPackage } from '@/domain/cad/plugins/cadPlugins';
import { inspectCadParameters, type CadParameterUsage } from '@/domain/cad/cadParameters';
import { CadParametersPanel, type CadParametersPanelControls } from './CadParametersPanel';
import { CadInspectorTitle, CadInspectorTitleContext, type CadInspectorTitleHost } from './CadInspectorTitle';
import { initialCadLoftSketchIds, inspectCadLoftCandidates } from './cadLoftUi';
import { createCadSelectEscapeGuard } from './cadSelectEscape';
import { CadCurveCreationFields } from './CadCurveCreationFields';
import { cadModelBounds, cadOriginReferences, cadReferenceFeatureIds, cadReferencePlanes, cadReferencesWithHoveredPlane, cadSameReferencePlane, prepareCadViewportReferences, selectCadViewportReferences, type CadViewportReference } from './cadViewportReferences';
import { cadPlacementLabel } from './cadPlacementUi';
import { cadPropertySummary } from './cadPropertySummary';
import { initialCadSweepSourceIds, inspectCadSweepCandidates } from './cadSweepUi';
import { useCadNotifications, type CadNotificationState } from './useCadNotifications';
import { cadFeatureCandidateEdits, type CadFeatureCandidateEdits, type CadFeaturePreviewCommand, type CadFeaturePreviewState } from './cadFeaturePreview';
import { cadDepthHandlesShown, cadPartViewChoices, cadRelationsShown, cadSketchViewChoices, getCadPreferences, setCadPreferences, useCadPreferences, type CadPreferences } from './cadPreferences';
import type { CadFeatureReferencePickCommand } from './cadFeatureReferencePicking';
import { useCadFeatureTopologyPick, type CadFeatureInputPicking } from './useCadFeatureTopologyPick';
import type { CadExtrudeDepthControl } from './cadExtrudeDepthInteraction';
import { cadDirectDepthTarget, createCadDirectDepthControl, type CadDirectDepthEnvironment } from './cadDirectDepthControl';
import { cadUnobscuredFitArea, type CadFitAreaReader } from './cadFitArea';
const NO_MESHES: readonly CadBuildResult['meshes'][number][] = Object.freeze([]);
const NO_SKETCH_SELECTIONS: readonly CadSketchGraphSelection[] = Object.freeze([]);
const NO_RELATION_IDS: readonly string[] = Object.freeze([]);
const NO_RELATION_OFFERS: readonly CadSketchRelationOffer[] = Object.freeze([]);
const NO_SELECTION_RELATIONS: readonly CadSketchSelectionAction[] = Object.freeze([]);
const NO_DIMENSION_PICK_TARGETS: CadSketchDimensionPickTargets = Object.freeze({ entityIds: [], sizedEntityIds: [], pointIds: [] });
/** A relation of the selection in a right-click menu: Remove for an applied one, as the icon shown pressed removes it. */
const relationMenuLabel = (action: CadSketchSelectionAction) => action.state === 'applied' ? `Remove ${action.label.toLowerCase()}` : action.label;
/** The sketch with its profile view `profileId`, a legacy profile or a generator, renamed. */
function renamedProfile(sketch: CadSketchFeature, profileId: string, name: string): CadSketchFeature {
  const view = cadSketchProfileViews(sketch).find(entry => entry.id === profileId);
  return view ? withCadSketchProfile(sketch, { ...view, name }) : sketch;
}
/** The generator record `id` of the sketch, which the inspector configures as it does a profile. */
const shapeGeneratorOf = (sketch: CadSketchFeature, id: string) => sketch.graph?.relations.find((relation): relation is CadSketchGenerator => relation.kind === 'generator' && relation.id === id);
function afterCadEdit(completion: CadEditCompletion, accepted: () => void, signal?: AbortSignal): CadEditCompletion {
  const finish = (result: Awaited<CadEditCompletion>) => { signal?.throwIfAborted(); accepted(); return result; };
  return completion && 'then' in completion ? completion.then(finish) : finish(completion);
}
const SKETCH_RELATION_FAILURE = 'Unable to apply this sketch relation.';
/** A Constrain tool's drawing is the glyph its relation draws on the canvas; Equal draws as equal length. */
function constraintToolIcon(tool: CadSketchConstraintTool) {
  const Icon = CAD_SKETCH_RELATION_ICONS[tool === 'equal' ? 'equal-length' : tool];
  return <Icon size={14} />;
}
/**
 * A sketch command on the selection: a value editor at a dimension, relation mark or tree row, or the move and corner editors. A value
 * editor belongs to its document, sketch and relation; `pick` is the drawn dimension or mark it was opened on, which stays the whole
 * selection, and `version` the document version it was opened at, so an editor opened as its relation is added waits for that relation.
 */
type GraphRelationCommand = { readonly kind: 'value'; readonly token: string; readonly documentId: string; readonly sketchId: string; readonly relationId: string; readonly pick: CadSketchDimensionPick | null; readonly version: string }
  | { readonly kind: 'move' | 'fillet' | 'chamfer'; readonly token: string };
/**
 * The Dimension tool from the moment it starts until it ends. `previousGraphPick` and `previousProfileId` come back when it ends without
 * placing anything; `placed` keeps the dimensions it placed or reused last, with whether they have been selected yet; `picks` are
 * its pending operands.
 */
interface DimensionToolSession<GraphPick> {
  readonly id: string; readonly documentId: string; readonly sketchId: string;
  readonly previousGraphPick: GraphPick; readonly previousProfileId: string | null;
  readonly placed: { readonly picks: readonly CadSketchDimensionPick[]; readonly selected: boolean } | null;
  readonly picks: { readonly document: CadDocument; readonly version: string; readonly operands: readonly CadSketchDimensionOperand[] } | null;
}
const NO_DIMENSION_OPERANDS: readonly CadSketchDimensionOperand[] = Object.freeze([]);
const DIMENSION_REFERENCE_STATUS = 'Placed as a reference: a driving dimension would over-define the sketch.';
const DIMENSION_REUSED_STATUS = 'Already dimensioned: that dimension is selected, with the relation added that keeps it measuring these picks.';
const NO_SKETCH_RELATIONS: readonly CadSketchGraphRelation[] = Object.freeze([]);
type CanvasMenu = { document: CadDocument; version: string; buildId: string | null } & (
  { kind: 'solid'; request: CadViewportContextMenuRequest } |
  { kind: 'sketch'; sketchId: string; request: CadSketchContextMenuRequest } |
  { kind: 'annotation'; sketchId: string; picks: readonly CadSketchDimensionPick[]; cancel: number; request: { readonly clientX: number; readonly clientY: number } } |
  /** A relations tree row whose relation the canvas does not draw. */
  { kind: 'relation-row'; sketchId: string; relationId: string; cancel: number; request: { readonly clientX: number; readonly clientY: number } });
import './cad-workbench.css';
import './cad-plugins.css';

export interface CadWorkbenchProps extends CadPluginCommands {
  document: CadDocument;
  documentVersion: string;
  buildVersion: string | null;
  build: CadBuildResult | null;
  buildState: 'idle' | 'building' | 'ready' | 'error';
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  errorMessage?: string | null;
  onStatusMessage?: CadNotificationState['onStatusMessage'];
  storageBusy?: boolean;
  externalWorkflowOpen?: boolean;
  sketchAnalysisReady?: boolean;
  /** No new sketch analysis starts, as while the workspace is locked, but the one shown stays live. */
  sketchAnalysisPaused?: boolean;
  onBeginSketchEdit?(sketchId: string): void;
  sketchEdit?: { readonly sketchId: string; inspectAreaRepairs(): CadSketchAreaRepairInspection | null; finish(signal?: AbortSignal, repairs?: CadSketchAreaRepairs, removedRelationIds?: readonly string[]): CadEditCompletion; cancel(): void };
  onEdit(edit: CadEdit, signal?: AbortSignal): CadEditCompletion;
  onEditMany(edits: readonly CadEdit[], signal?: AbortSignal): CadEditCompletion;
  onPrepareEdits?: CadPrepareEdits;
  onInspectSketchConstraints?: CadInspectSketchConstraints;
  /** Shrinks an accepted sketch edit made that no length driver sets, for the document version it produced. */
  sketchWarnings?: CadSketchWarningsRecord | null;
  onUndo(): void;
  onRedo(): void;
  onBack(): void;
  onWorkflowChange(open: boolean): void;
  onSendToCam(sketchId: string): Promise<void>;
  onSave(): Promise<void>;
  onOpenDocument(): void;
  onNewDocument(): void;
  onImportDocument(file: File): Promise<void>;
  onExportDocument(): void;
  onExportSolid(format: 'step' | 'stl'): Promise<void>;
  onOpenDxfExport?(): void;
  onRebuild?(): Promise<void>;
  onSectionForCam?(bodyId: string): void;
  onViewportControlsReady?(controls: CadWorkbenchViewportControls | null): void;
  onCaptureViewport?(): Promise<void>;
  onInspectTopology?: CadInspectTopology;
  onResolveSelection?(request: CadTopologyResolvePicksRequest, expectedVersion: string, signal: AbortSignal): Promise<CadTopologyResolvePicksResult>;
  /** How one body's edges and faces meet in the visible build; without it or the tangent chain read, chains are unavailable and single picks still work. */
  onTopologyAdjacency?(request: CadTopologyAdjacencyRequest, expectedVersion: string, signal: AbortSignal): Promise<CadTopologyAdjacency>;
  /** The edges native fillet and chamfer treat when they follow tangents from one edge of the visible build. */
  onTopologyTangentChain?(request: CadTopologyTangentChainRequest, expectedVersion: string, signal: AbortSignal): Promise<CadTopologyTangentChain>;
  featureInputPicking?: CadFeatureInputPicking;
  featurePreview?: CadFeaturePreviewState;
  onFeaturePreview?(command: CadFeaturePreviewCommand): void;
}

/** The latest sketch analysis as the workbench shows it, for the accepted document and version it belongs to. */
interface SketchAnalysisState {
  readonly document: CadDocument; readonly version: string; readonly sketchId: string;
  readonly freedom: number | null; readonly locks: boolean;
  readonly definition: CadSketchDefinitionMarks | null; readonly diagnosis: CadSketchDiagnosisMarks | null;
  /** The analysis's conflicting, redundant and unmet relations, as the issue adapter reads them. */
  readonly issues: CadSketchAnalysisIssues | null;
}
const NO_SKETCH_ANALYSIS = Object.freeze({ freedom: null, locks: false, definition: null, diagnosis: null, issues: null });
/**
 * Freedom and definition locks need the exact accepted document and version. Colours stay with the same sketch of the
 * same document until the next result replaces them, so undo or a parameter change never moves an old lock onto new state.
 */
function shownSketchAnalysis(state: SketchAnalysisState | null, document: CadDocument, version: string, sketchId: string | null | undefined) {
  if (!state || state.document.id !== document.id || state.sketchId !== sketchId) return NO_SKETCH_ANALYSIS;
  // A version that only moved this sketch's dimensions holds the same analysis, so its freedom and locks show from its first render.
  // The same document at another version, as undo restores it, waits for its own analysis.
  const exact = state.document === document ? state.version === version : cadDocumentsPlacedAlike(state.document, document, state.sketchId);
  return { freedom: exact ? state.freedom : null, locks: exact && state.locks, definition: state.definition, diagnosis: state.diagnosis, issues: state.issues };
}

/** The kinds the model view's selection filter offers. Vertices are not picked in 3D, so that kind is left to the sketch canvas. */
const PART_SELECTION_KINDS: readonly { readonly kind: CadSelectionKind; readonly label: string }[] = Object.freeze([
  { kind: 'body', label: 'Bodies' }, { kind: 'face', label: 'Faces' }, { kind: 'edge', label: 'Edges' },
  { kind: 'plane', label: 'Planes' }, { kind: 'axis', label: 'Axes' }, { kind: 'point', label: 'Points' }]);

function featureDraft(kind: CadFeature['kind'], document: CadDocument, selected: CadFeature | undefined, bodyIds: readonly string[], lineage: CadBodyLineage, plane: CadSketchPlane = selected?.kind === 'datum-plane' && cadFeatureActive(selected, document) ? Object.freeze({ kind: 'datum-plane', featureId: selected.id }) : 'XY'): CadFeature {
  const id = crypto.randomUUID();
  const sequence = document.features.filter((feature) => feature.kind === kind).length + 1;
  const base = { id, name: `${kind === 'extrude' ? 'Extrude' : featureLabels[kind]} ${sequence}`, suppressed: false };
  const sourceError = (purpose: CadSketchSourcePurpose, fallback: string) => selected?.kind === 'sketch' ? cadSketchSourceIssueMessage(selected, purpose, document.parameters) ?? fallback : fallback;
  // The body the selected feature leads to by key, wherever it is in that body's history; otherwise the latest drawn body.
  const target = cadSelectedBody(lineage, selected?.id, bodyIds), body = target && { id: cadBodyFeatureId(target) };
  switch (kind) {
    case 'datum-plane': return { ...base, kind, definition: { kind: 'world', basePlane: 'XY', origin: [0, 0, 0], rotation: [0, 0, 0] } };
    case 'sketch': return { ...base, kind, plane, offset: 0, profiles: [] };
    case 'curve': return { ...base, kind, plane, offset: 0, segments: [] };
    case 'imported': throw new Error('Use File > Import to add an external solid.');
    case 'extrude': {
      const source = pickCadSketchSource({ features: document.features, selectedId: selected?.id ?? null, purpose: kind, parameters: document.parameters });
      if (!source) throw new Error(sourceError(kind, 'Create a sketch with closed material contours before adding a Pad.'));
      return { ...base, kind, sketchId: source.id, distance: 10, symmetric: false, operation: 'new', targetId: null };
    }
    case 'pocket': {
      const source = pickCadSketchSource({ features: document.features, selectedId: selected?.id ?? null, purpose: kind, parameters: document.parameters });
      if (!source || !body) throw new Error(sourceError(kind, 'Through-all Pocket requires a closed material sketch on XY, XZ or YZ and a target body.'));
      return { ...base, kind, sketchId: source.id, targetId: body.id, extent: { kind: 'through-all', direction: 'both' } };
    }
    case 'revolve': {
      const source = pickCadSketchSource({ features: document.features, selectedId: selected?.id ?? null, purpose: kind, parameters: document.parameters });
      if (!source) throw new Error(sourceError(kind, 'Create a sketch with closed material contours before adding a Revolve.'));
      return { ...base, kind, sketchId: source.id, angle: 360, axis: 'y', operation: 'new', targetId: null };
    }
    case 'loft': return { ...base, kind, sketchIds: initialCadLoftSketchIds(inspectCadLoftCandidates(document), selected?.kind === 'sketch' ? selected.id : undefined), ruled: false, operation: 'new', targetId: null };
    case 'sweep': return { ...base, kind, ...initialCadSweepSourceIds(inspectCadSweepCandidates(document), selected?.id), operation: 'new', targetId: null };
    case 'fillet':
    case 'chamfer': if (!body) throw new Error('Create a solid body first.'); return { ...base, kind, targetId: body.id, radius: 1 };
    case 'shell': throw new Error('Pick one planar face before starting an inward shell.');
    case 'boolean': { const other = target && cadSelectedBody(lineage, null, bodyIds, target.key), tool = other && { id: cadBodyFeatureId(other) }; if (!body || !tool) throw new Error('A boolean operation needs two independent solid bodies.'); return { ...base, kind, targetId: body.id, toolId: tool.id, operation: 'union' }; }
    case 'transform': if (!body) throw new Error('Create a solid body first.'); return { ...base, kind, sourceId: body.id, translation: [0, 0, 0], rotation: [0, 0, 0] };
    case 'linear-pattern': if (!body) throw new Error('Create a solid body first.'); return { ...base, kind, sourceId: body.id, count: 2, spacing: [30, 0, 0] };
    case 'circular-pattern': if (!body) throw new Error('Create a solid body first.'); return { ...base, kind, sourceId: body.id, count: 4, axis: 'z', center: [0, 0, 0], angle: 360 };
    case 'mirror': if (!body) throw new Error('Create a solid body first.'); return { ...base, kind, sourceId: body.id, plane: 'YZ' };
  }
}

export function CadWorkbench(props: CadWorkbenchProps) {

  const commandSubmission = useCadEditSubmission();
  const { document, build, buildState, dirty, canUndo, canRedo, storageBusy = false, externalWorkflowOpen = false } = props;
  const getFitArea = useCallback<CadFitAreaReader>(viewport => {
    // Query current DOM only on Fit: panels never alter canvas layout or camera. The sketch bar counts too, so a fitted sketch and its
    // dimensions start clear of it.
    const overlays = viewport.closest('.cad-workbench')?.querySelectorAll<HTMLElement>('[data-cad-properties], [data-cad-model-tree], [data-cad-command-dock], [data-cad-sketch-header]');
    const bounds = viewport.getBoundingClientRect();
    return cadUnobscuredFitArea({ left: bounds.left, top: bounds.top, width: viewport.clientWidth, height: viewport.clientHeight },
      [...overlays ?? []].filter(overlay => !overlay.hidden).map(overlay => overlay.getBoundingClientRect()));
  }, []);
  const preferences = useCadPreferences();
  const renderedPreferences = useRef({ navigationMode: preferences.navigationMode, onPartDimensionsVisible: false });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Selecting keeps a feature highlighted; only an explicit open shows its editor. */
  const [openFeatureId, setOpenFeatureId] = useState<string | null>(null);
  /** The parameters a Length dragged to a value that removes relations hands to its Pad's editor, which asks before applying them. */
  const [openingParameters, setOpeningParameters] = useState<{ readonly featureId: string; readonly parameters: Readonly<Record<string, number>> } | null>(null);
  /** The shape a grip or drag moved a generator to where that removes relations, which its exact editor opens at and asks before applying. */
  const [openingProfile, setOpeningProfile] = useState<{ readonly profileId: string; readonly geometry: CadProfile; readonly token: number } | null>(null);
  /** A selected origin plane, origin axis or the origin point; a datum plane is selected as its feature. */
  const [planeSelection, setPlaneSelection] = useState<{ documentId: string; plane?: CadSketchPlane; origin?: CadOriginSelection } | null>(null);
  // Pointer hover over a plane in either the tree or the design area; both views show it.
  const [planeHover, setPlaneHover] = useState<{ documentId: string; plane: CadSketchPlane } | null>(null);
  /** A plane pick either creates a sketch or, with `replaceSketchId`, moves that sketch onto the picked plane. */
  const [sketchPlaneRequest, setSketchPlaneRequest] = useState<{ document: CadDocument; version: string; replaceSketchId?: string } | null>(null);
  /** Read-only measurements open on request from a context menu, never from a plain selection; `selection` follows the selected feature. */
  const [properties, setProperties] = useState<{ readonly kind: 'body' | 'selection' } | null>(null);
  const planeRequestOwner = useRef<typeof sketchPlaneRequest>(null);
  const [sketchId, setSketchId] = useState<string | null>(null);
  const [curveId, setCurveId] = useState<string | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  /** Geometry, the origin and the axes among it, or canvas dimensions selected in the open sketch; a dimension selection excludes geometry. */
  const [graphPick, setGraphPick] = useState<{ sketchId: string; selections: readonly CadSketchGraphSelection[]; dimensions?: readonly CadSketchDimensionPick[] } | null>(null);
  /** Hover highlight shared by canvas dimensions and dock rows; only the canvas overlay subscribes. */
  const [sketchHighlight] = useState(createCadSketchHighlightStore);
  /**
   * The Dimension tool. It stays on across placements, its picks belong to the document version they were made on, and `placed` keeps the
   * dimension it placed last, which becomes the selection once the sketch holds it.
   */
  const [dimensionTool, setDimensionTool] = useState<DimensionToolSession<typeof graphPick> | null>(null);
  /** The pointer over the sketch while the tool is on; only its preview and coordinate readout subscribe. */
  const [dimensionPointer] = useState(createCadSketchPointerStore);
  /** The value editor, or the move or corner editor, open on the selection. */
  const [graphRelationCommand, setGraphRelationCommand] = useState<GraphRelationCommand | null>(null);
  const [offsetCommand, setOffsetCommand] = useState<{ sketchId: string; source: CadSketchOffsetSource; token: string } | null>(null);
  const [mirrorCommand, setMirrorCommand] = useState<{ sketchId: string; entityIds: readonly string[]; token: string } | null>(null);
  const [patternCommand, setPatternCommand] = useState<{ sketchId: string; request: CadSketchLinearPatternRequest; token: string } | null>(null);
  const [patternInteraction, setPatternInteraction] = useState<CadSketchLinearPatternInteraction | null>(null);
  const [mirrorInteraction, setMirrorInteraction] = useState<CadSketchMirrorInteraction | null>(null);
  const [placementCommand, setPlacementCommand] = useState<{sketchId:string;selections:readonly CadSketchGraphSelection[];token:string}|null>(null);
  const [placementInteraction, setPlacementInteraction] = useState<CadSketchPlacementInteraction|null>(null);
  const [sketchReferenceCommand, setSketchReferenceCommand] = useState<{ sketchId: string; token: string } | null>(null);
  const [sketchReferenceInteraction, setSketchReferenceInteraction] = useState<CadSketchReferenceInteraction | null>(null);
  const [profileCopyCommand, setProfileCopyCommand] = useState<{ request: CadSketchProfileCopyRequest; token: string } | null>(null);
  const [profileCopyPreview, setProfileCopyPreview] = useState<CadDocument | null>(null);
  const [profileCopyAccepted, setProfileCopyAccepted] = useState<{ document: CadDocument; sketchId: string } | null>(null);
  const [diagnosticInspection, setDiagnosticInspection] = useState<{ document: CadDocument; sketchId: string; issue: CadSketchIssue } | null>(null);
  /** The refusal of the last edit made from the icon row, a value editor or a sketch editor, until the next edit or document. */
  const [editFeedback, setEditFeedback] = useState<{ document: CadDocument; feedback: CadSketchConstraintFeedback } | null>(null);
  /** Relations tree rows selected whose relations the canvas does not draw; drawn ones select through their marks. */
  const [relationRowPick, setRelationRowPick] = useState<{ documentId: string; sketchId: string; relationIds: readonly string[] } | null>(null);
  /** The tree row to scroll to, and the geometry whose relations alone the list shows, kept while the selection moves to its rows. */
  const [relationListReveal, setRelationListReveal] = useState<{ relationId: string | null; token: string } | null>(null);
  // The relations list under the sketch starts collapsed, so opening a sketch mounts no row, and stays open for later sketches once opened.
  const [relationListOpen, setRelationListOpen] = useState(false);
  const [relationListScope, setRelationListScope] = useState<{ documentId: string; sketchId: string; selection: readonly CadSketchGraphSelection[] } | null>(null);
  const [sketchAnalysis, setSketchAnalysis] = useState<SketchAnalysisState | null>(null);
  const [newFeature, setNewFeature] = useState<CadFeature | null>(null);
  const [tool, setTool] = useState<SketchTool>('select');
  /** A positional constraint tool stays active across commits; its picks belong to the document they were made on. */
  const [constraintToolRequest, setConstraintToolRequest] = useState<{ readonly sketchId: string; readonly tool: CadSketchConstraintTool; readonly document: CadDocument; readonly picks: readonly CadSketchConstraintPick[] } | null>(null);
  const [construction, setConstruction] = useState(false);
  const [fileMenu, setFileMenu] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useCadNotifications({ document, documentVersion: props.documentVersion, build, buildVersion: props.buildVersion,
    buildState, errorMessage: error || props.errorMessage || null, onStatusMessage: props.onStatusMessage });
  const [drawingPending, setDrawingPending] = useState(false);
  /** The sketch canvas's drawing controls, and whether its pending line chain could be saved open now. */
  const drawingControls = useRef<CadSketchDrawingControls | null>(null);
  const [chainSavable, setChainSavable] = useState(false);
  const publishDrawingControls = useCallback((controls: CadSketchDrawingControls | null, savable: boolean) => { drawingControls.current = controls; setChainSavable(savable); }, []);
  /** Finish sketch waits for a pending chain's open save, then runs against the document that save produced. */
  const [finishAfterChain, setFinishAfterChain] = useState(false);
  const [editorPending, setEditorPending] = useState(false);
  const [areaRepair, setAreaRepair] = useState<{ document: CadDocument; inspection: CadSketchAreaRepairInspection } | null>(null);
  const [areaRepairReady, setAreaRepairReady] = useState(false), areaRepairFormId = useId();
  const currentAreaRepair = areaRepair?.document === document && areaRepair.inspection.localVersion === props.documentVersion && props.sketchEdit ? areaRepair.inspection : null;
  useLayoutEffect(() => { if (areaRepair && !currentAreaRepair) setAreaRepair(null); }, [areaRepair, currentAreaRepair]);
  // Relations a sketch edit's Finish removes from later sketches whose generators regenerate under its parameters, which Apply confirms,
  // for the draft as it was when Finish found them, with the area choices that Finish carried.
  const [finishRemovals, setFinishRemovals] = useState<{ readonly document: CadDocument; readonly version: string; readonly removals: CadGeneratorRemovals; readonly repairs?: CadSketchAreaRepairs } | null>(null);
  const currentFinishRemovals = finishRemovals?.document === document && finishRemovals.version === props.documentVersion && props.sketchEdit ? finishRemovals : null;
  useLayoutEffect(() => { if (finishRemovals && !currentFinishRemovals) setFinishRemovals(null); }, [finishRemovals, currentFinishRemovals]);
  const [parameterPending, setParameterPending] = useState(false);
  const [dimensionPending, setDimensionPending] = useState(false);
  const [treeMenuOpen, setTreeMenuOpen] = useState(false);
  const [canvasMenu, setCanvasMenu] = useState<CanvasMenu | null>(null);
  const [referencePick, setReferencePick] = useState<{ command: Exclude<CadFeatureReferencePickCommand, { kind: 'clear' }>; document: CadDocument; buildId: string | null } | null>(null);
  const [depthInteraction, setDepthInteraction] = useState<{ control: CadExtrudeDepthControl; document: CadDocument } | null>(null);
  /** True while a direct (dialog-free) Pad drag has changed the Length and not yet been released. */
  const [directDepthActive, setDirectDepthActive] = useState(false);
  const directDepthOwner = useId();
  const depthDocument = useRef(document); depthDocument.current = document;
  const publishDepthInteraction = useCallback((control: CadExtrudeDepthControl | null, released?: CadExtrudeDepthControl) => {
    setDepthInteraction(previous => control ? previous?.control === control && previous.document === depthDocument.current ? previous
      : { control, document: depthDocument.current } : !released || previous?.control === released ? null : previous);
  }, []);
  const pickEnvironment = useRef({ document, buildId: build?.buildId ?? null }); pickEnvironment.current = { document, buildId: build?.buildId ?? null };
  const requestReferencePick = useCallback((command: CadFeatureReferencePickCommand) => {
    setReferencePick(previous => command.kind === 'clear' ? previous?.command.owner === command.owner ? null : previous
      : previous?.command === command ? previous : { command, ...pickEnvironment.current });
  }, []);
  const [cancelSignal, setCancelSignal] = useState(0);
  const [deleteFeature, setDeleteFeature] = useState<CadFeature | null>(null);
  const [inspectedParameter, setInspectedParameter] = useState<string | null>(null);
  const [inspectedInput, setInspectedInput] = useState<{ profileId: string; inputName: string } | null>(null);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [titleSlot, setTitleSlot] = useState<HTMLElement | null>(null);
  const [titleClaims, setTitleClaims] = useState(0);
  const titleHost = useMemo<CadInspectorTitleHost>(() => ({ slot: titleSlot, claim: () => { setTitleClaims(count => count + 1); return () => setTitleClaims(count => count - 1); } }), [titleSlot]);
  const [profilePreview, setProfilePreview] = useState<CadSketchProfile | null>(null);
  const [previewParameters, setPreviewParameters] = useState<CadDocument['parameters'] | null>(null);
  const [sketchPreview, setSketchPreview] = useState<{ source: CadDocument; document: CadDocument | null; marks: CadSketchDiagnosisMarks | null } | null>(null);
  const publishSketchPreview = useCallback((candidate: CadDocument | null, marks: CadSketchDiagnosisMarks | null = null) =>
    setSketchPreview(candidate || marks ? { source: document, document: candidate, marks } : null), [document]);
  const [nameDraft, setNameDraft] = useState(document.name);
  const [namePending, setNamePending] = useState(false);
  const [treeRenamePending, setTreeRenamePending] = useState(false);
  const [profileCommand, setProfileCommand] = useState<CadSketchProfileCommand | null>(null);
  const profileCommandSequence = useRef(0);
  const shell = useOptionalAppRail();
  const [headerHost, setHeaderHost] = useState<HTMLDivElement | null>(null);
  const portalHost = useMemo(() => <div className="cad-shell-header" ref={setHeaderHost} />, []);
  const publishHeader = shell?.setHeaderContent;
  // Match the editor's passive header lifetime: all previous editor cleanups run
  // before this publication, so a departing editor cannot erase the CAD header.
  useEffect(() => {
    if (!publishHeader) return;
    publishHeader(portalHost);
    return () => publishHeader(null);
  }, [publishHeader, portalHost]);
  const [pickMode, setPickMode] = useState<CadPickMode>('auto');
  const [pickedTopology, setPickedTopologyState] = useState<CadTopologyPickSet | null>(null);
  // Each change to the topology selection, and each chain request, takes the next number; a chain answered after either is dropped.
  const topologyRequest = useRef(0);
  const setPickedTopology = useCallback((next: CadTopologyPickSet | null) => { topologyRequest.current++; setPickedTopologyState(next); }, []);
  const [resolvingTopology, setResolvingTopology] = useState<'fillet' | 'chamfer' | 'shell' | null>(null);
  const topologyResolution = useRef<{ controller: AbortController; source: CadTopologyPickSet } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const parameterControls = useRef<CadParametersPanelControls>(null);
  const fileMenuTrigger = useRef<HTMLButtonElement>(null);
  const fileMenuPanel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (fileMenu) fileMenuPanel.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [fileMenu]);
  const deleteDialog = useRef<HTMLDivElement>(null);
  const renderedControls = useRef<CadRenderedViewControls | null>(null);
  const sourceRenderedControls = useRef<CadRenderedViewControls | null>(null);
  const viewportBindings = useRef<CadViewportBindings | null>(null);
  const publishRenderedControls = useCallback((controls: CadRenderedViewControls | null, released?: CadRenderedViewControls) => {
    if (controls) {
      sourceRenderedControls.current = controls;
      renderedControls.current = { ...controls, getState: () => {
        const state = controls.getState();
        return Object.freeze({ ...state, navigationMode: renderedPreferences.current.navigationMode,
          onPartDimensionsVisible: state.mode === 'sketch' && renderedPreferences.current.onPartDimensionsVisible });
      } };
    } else if (!released || sourceRenderedControls.current === released) { sourceRenderedControls.current = null; renderedControls.current = null; }
  }, []);
  const viewportControls = useMemo(() => createCadWorkbenchViewportControls(() => {
    const bindings = viewportBindings.current;
    if (!bindings) throw new ToolError('VIEW_UNAVAILABLE', 'Wait for the CAD workspace to load.');
    return { ...bindings, rendered: renderedControls.current };
  }), []);
  // Another tool, a sketch command, a feature workflow or another sketch ends the Dimension tool; a placement it is applying keeps it on.
  const dimensionToolEnded = tool !== 'select' || newFeature !== null || deleteFeature !== null || pluginsOpen || resolvingTopology !== null || profileId !== null || graphRelationCommand !== null
    || offsetCommand !== null || mirrorCommand !== null || patternCommand !== null || placementCommand !== null || sketchReferenceCommand !== null || profileCopyCommand !== null || profileCommand !== null;
  const currentDimensionTool = !dimensionToolEnded && dimensionTool?.documentId === document.id && dimensionTool.sketchId === sketchId ? dimensionTool : null;
  // Picks belong to the part and version they were made on; an edit, undo, redo, rename, storage or plugin workflow drops them.
  const dimensionPicksBlocked = drawingPending || editorPending || parameterPending || dimensionPending || namePending || treeRenamePending || treeMenuOpen || storageBusy || externalWorkflowOpen;
  const currentDimensionPicks = !dimensionPicksBlocked && currentDimensionTool?.picks?.document === document && currentDimensionTool.picks.version === props.documentVersion ? currentDimensionTool.picks : null;
  const dimensionToolOwner = useRef(currentDimensionTool); dimensionToolOwner.current = currentDimensionTool;
  useLayoutEffect(() => { if (dimensionTool && !currentDimensionTool) setDimensionTool(null); }, [dimensionTool, currentDimensionTool]);
  /** Ends the tool. Without a placement the selection and profile it started from come back; otherwise the last placed dimension stays selected. */
  const endDimensionTool = useCallback(() => {
    const session = dimensionToolOwner.current; dimensionToolOwner.current = null; setDimensionTool(null);
    if (session && !session.placed) { setGraphPick(session.previousGraphPick); setProfileId(session.previousProfileId); }
  }, []);
  useLayoutEffect(() => {
    if (!currentDimensionTool?.picks || currentDimensionPicks) return;
    setDimensionTool(current => current === currentDimensionTool ? { ...current, picks: null } : current); setGraphPick(null);
  }, [currentDimensionTool, currentDimensionPicks]);
  const referenceContextBlocked = drawingPending || pluginsOpen || parameterPending || dimensionPending || namePending || treeRenamePending || deleteFeature !== null || resolvingTopology !== null || treeMenuOpen || externalWorkflowOpen;
  const referencePickBlocked = referenceContextBlocked || storageBusy;
  const currentOwnedPick = !referencePickBlocked && referencePick?.document === document && referencePick.command.expectedVersion === props.documentVersion
    && (referencePick.command.kind === 'pick-regions' || referencePick.command.kind === 'pick-topology' || referencePick.buildId === (build?.buildId ?? null)) ? referencePick.command : null;
  const currentReferencePick = currentOwnedPick?.kind === 'pick' ? currentOwnedPick : null;
  const currentRegionPick = currentOwnedPick?.kind === 'pick-regions' ? currentOwnedPick : null;
  const currentTopologyPick = currentOwnedPick?.kind === 'pick-topology' ? currentOwnedPick : null;
  const inputPicker = useCadFeatureTopologyPick(currentTopologyPick, document, props.documentVersion, props.featureInputPicking);
  const regionReferenceIds = useMemo(() => currentRegionPick ? [currentRegionPick.sketchId] : [], [currentRegionPick?.sketchId]);
  const currentSketchPlaneRequest = !referencePickBlocked && !editorPending && !newFeature && !currentOwnedPick
    && sketchPlaneRequest?.document === document && sketchPlaneRequest.version === props.documentVersion ? sketchPlaneRequest : null;
  planeRequestOwner.current = currentSketchPlaneRequest;
  useLayoutEffect(() => { if (sketchPlaneRequest && !currentSketchPlaneRequest) setSketchPlaneRequest(null); }, [sketchPlaneRequest, currentSketchPlaneRequest]);
  useLayoutEffect(() => { if (referencePick && !currentOwnedPick) { referencePick.command.onCancel(); setReferencePick(null); } }, [referencePick, currentOwnedPick]);
  const canvasMenuBlocked = Boolean(currentDimensionPicks) || drawingPending || pluginsOpen || editorPending || parameterPending || dimensionPending || namePending || treeRenamePending || newFeature !== null || deleteFeature !== null || resolvingTopology !== null || treeMenuOpen || storageBusy || externalWorkflowOpen || Boolean(currentOwnedPick);
  const currentCanvasMenu = !canvasMenuBlocked && canvasMenu?.document === document && canvasMenu.version === props.documentVersion && canvasMenu.buildId === (build?.buildId ?? null)
    && (canvasMenu.kind !== 'annotation' && canvasMenu.kind !== 'relation-row' || canvasMenu.cancel === cancelSignal) ? canvasMenu : null;
  useLayoutEffect(() => { if (canvasMenu && !currentCanvasMenu) setCanvasMenu(null); }, [canvasMenu, currentCanvasMenu]);
  const pendingOtherCommands = commandSubmission.applying || directDepthActive || pluginsOpen || parameterPending || dimensionPending || namePending || treeRenamePending || newFeature !== null || deleteFeature !== null || resolvingTopology !== null || treeMenuOpen || Boolean(currentCanvasMenu) || Boolean(currentOwnedPick) || Boolean(currentSketchPlaneRequest) || Boolean(currentAreaRepair);
  const pendingOutsideDrawing = editorPending || pendingOtherCommands || Boolean(currentDimensionPicks);
  const pending = drawingPending || pendingOutsideDrawing;
  // Menu commands run after their menu closes, from a closure rendered while it was open.
  const latestPending = useRef(pending);
  latestPending.current = pending;
  const locked = pending || storageBusy || externalWorkflowOpen;
  /** A line chain that can be saved open is the only pending work, so tools and Finish sketch save it first instead of waiting. */
  const chainOnly = drawingPending && chainSavable && !pendingOutsideDrawing;
  const toolsLocked = chainOnly ? storageBusy || externalWorkflowOpen : locked;
  /** Profile and offset editors yield to any other command, rename, storage or plugin workflow. */
  const sketchEditorLocked = commandSubmission.applying || drawingPending || parameterPending || dimensionPending || namePending || treeRenamePending || storageBusy || resolvingTopology !== null || externalWorkflowOpen || pluginsOpen;
  const interactionState = useRef({ locked, document, version: props.documentVersion, sketchId, cancel: cancelSignal }); interactionState.current = { locked, document, version: props.documentVersion, sketchId, cancel: cancelSignal };
  const currentSketchReferencePick = !pendingOtherCommands && !storageBusy && !externalWorkflowOpen && sketchReferenceCommand?.sketchId === sketchId && sketchReferenceInteraction?.kind === 'source' ? sketchReferenceInteraction : null;
  const treeLocked = Boolean(currentDimensionPicks) || commandSubmission.applying || (currentReferencePick || currentSketchPlaneRequest || currentSketchReferencePick ? false : drawingPending || pluginsOpen || editorPending || parameterPending || dimensionPending || namePending || newFeature !== null || deleteFeature !== null || resolvingTopology !== null || storageBusy || externalWorkflowOpen || Boolean(currentCanvasMenu));
  const navigationLocked = commandSubmission.applying || drawingPending || pluginsOpen || treeRenamePending || externalWorkflowOpen || storageBusy || deleteFeature !== null || resolvingTopology !== null || treeMenuOpen || Boolean(currentCanvasMenu);
  const previewEnabled = !pluginsOpen && !treeRenamePending && !externalWorkflowOpen && !storageBusy && !treeMenuOpen && !currentCanvasMenu && !currentReferencePick && !currentTopologyPick;
  const selected = document.features.find((feature) => feature.id === selectedId);
  // Keyed on what activity reads, so the plane keeps its identity across edits that leave the selection and parameters alone.
  const selectedReferencePlane = useMemo<CadSketchPlane | null>(() => selected?.kind === 'datum-plane' && cadFeatureActive(selected, { parameters: document.parameters })
    ? Object.freeze({ kind: 'datum-plane', featureId: selected.id }) : !selected && planeSelection?.documentId === document.id ? planeSelection.plane ?? null : null,
  [selected, planeSelection, document.id, document.parameters]);
  const selectedOrigin = useMemo<CadOriginSelection | null>(() => !selected && planeSelection?.documentId === document.id ? planeSelection.origin ?? null : null, [selected, planeSelection, document.id]);
  /** The reference a new feature takes from the selection: a selected plane, an origin axis or the origin point. */
  const selectedReference = useMemo<CadReferenceSelection | null>(() => selectedReferencePlane ? Object.freeze({ kind: 'plane', plane: selectedReferencePlane }) : selectedOrigin,
    [selectedReferencePlane, selectedOrigin]);
  const hoveredReferencePlane = planeHover?.documentId === document.id && (typeof planeHover.plane === 'string'
    || document.features.some(feature => feature.kind === 'datum-plane' && cadFeatureActive(feature, document) && typeof planeHover.plane === 'object' && feature.id === planeHover.plane.featureId)) ? planeHover.plane : null;
  const hoverReferencePlane = useCallback((plane: CadSketchPlane | null) => setPlaneHover(previous => {
    const next = plane ? { documentId: document.id, plane } : null;
    return previous?.documentId === next?.documentId && cadSameReferencePlane(previous?.plane ?? null, next?.plane ?? null) ? previous : next;
  }), [document.id]);
  const sketch = document.features.find((feature): feature is CadSketchFeature => feature.kind === 'sketch' && feature.id === sketchId);
  const graphSelections = useMemo(() => graphPick?.sketchId === sketch?.id ? reconcileCadSketchGraphSelection(sketch?.graph, graphPick?.selections ?? NO_SKETCH_SELECTIONS) : NO_SKETCH_SELECTIONS, [graphPick, sketch]);
  // The dimensions the canvas draws, from the layout it draws them with, and its relation glyphs while Show relations is on: canvas
  // selection, editing, Delete and the viewport flag act only on these.
  const relationsShown = cadRelationsShown(preferences);
  const sketchGraph = sketch?.graph, dimensionsShown = preferences.showOnPartDimensions && tool === 'select';
  const drawnDimensions = useMemo(() => sketchGraph && dimensionsShown ? cadSketchDrawnDimensions(sketchGraph, document.parameters) : undefined, [sketchGraph, dimensionsShown, document.parameters]);
  const drawnAnnotations = useMemo(() => sketchGraph && (drawnDimensions || relationsShown) ? cadSketchDrawnAnnotations(sketchGraph, drawnDimensions, relationsShown) : undefined,
    [sketchGraph, drawnDimensions, relationsShown]);
  // A selected dimension or relation that disappears, whose ID now names a different one, or that is no longer drawn, leaves the selection for good.
  const graphDimensionPicks = useMemo(() => graphPick?.sketchId === sketch?.id ? reconcileCadSketchDimensionSelection(drawnAnnotations, graphPick?.dimensions ?? NO_SKETCH_DIMENSIONS) : NO_SKETCH_DIMENSIONS,
    [graphPick, sketch, drawnAnnotations]);
  const graphDimensions = useMemo(() => cadSketchDimensionIds(graphDimensionPicks), [graphDimensionPicks]);
  useLayoutEffect(() => {
    if (!graphPick || graphPick.selections === graphSelections && (graphPick.dimensions ?? NO_SKETCH_DIMENSIONS) === graphDimensionPicks) return;
    setGraphPick(current => current === graphPick ? graphSelections.length || graphDimensionPicks.length
      ? { ...current, selections: graphSelections, dimensions: graphDimensionPicks } : null : current);
  }, [graphPick, graphSelections, graphDimensionPicks]);
  // A value editor belongs to its document, its sketch and the relation it edits. One opened on a drawn dimension or mark keeps that as the
  // whole selection, and closes once a profile, geometry, the origin, an axis or another annotation takes the selection, another document opens
  // under the same IDs, Delete, undo, redo or an agent edit removes its relation or replaces it under the same ID, or hiding it stops drawing it.
  // One opened as its relation is added, as a new corner's is, waits for the version that adds it.
  const valueCommand = graphRelationCommand?.kind === 'value' ? graphRelationCommand : null;
  const valueSketch = valueCommand && valueCommand.documentId === document.id && valueCommand.sketchId === sketch?.id && !profileId ? sketch : null;
  const valueRelation = valueSketch && valueCommand ? valueSketch.graph?.relations.find(item => item.id === valueCommand.relationId) : undefined;
  const valueEditorCurrent = Boolean(valueSketch?.graph && valueCommand && (valueRelation ? isCadSketchValueRelation(valueRelation) && (valueCommand.pick
    ? !graphSelections.length && graphDimensionPicks.length === 1 && sameCadSketchDimensionPick(graphDimensionPicks[0], valueCommand.pick, valueSketch.graph) && isCadSketchDimensionPickCurrent(drawnAnnotations, valueCommand.pick)
    : !graphDimensionPicks.length) : valueCommand.version === props.documentVersion));
  useLayoutEffect(() => { if (valueCommand && !valueEditorCurrent) setGraphRelationCommand(current => current === valueCommand ? null : current); }, [valueCommand, valueEditorCurrent]);
  /** Tree rows selected for relations the canvas does not draw; a selection elsewhere clears them. */
  const relationRowIds = relationRowPick && relationRowPick.documentId === document.id && relationRowPick.sketchId === sketch?.id ? relationRowPick.relationIds : NO_RELATION_IDS;
  const selectedRelationIds = useMemo(() => relationRowIds.length ? [...graphDimensions, ...relationRowIds] : graphDimensions, [graphDimensions, relationRowIds]);
  /**
   * The selected relations Delete removes: drawn dimensions and marks while they still show their relations, and tree rows of relations the
   * canvas does not draw. A pattern detaches through its editor instead.
   */
  const removableSelectedRelationIds = (graph: CadSketchGraph) => {
    const drawn = graphDimensions.filter(id => drawnAnnotations?.graph === graph && cadSketchDimensionPick(drawnAnnotations, id));
    const listed = relationRowIds.filter(id => !drawn.includes(id) && graph.relations.some(item => item.id === id && item.kind !== 'linear-pattern'));
    return listed.length ? [...drawn, ...listed] : drawn;
  };
  const relationListSelection = relationListScope && relationListScope.documentId === document.id && relationListScope.sketchId === sketch?.id ? relationListScope.selection : null;
  /** The selected points and edges edits may change: the selection without the origin and the axes, which are fixed. */
  const graphGeometry = useMemo(() => {
    const own = graphSelections.filter(item => !isCadSketchVirtualSelection(item));
    return own.length === graphSelections.length ? graphSelections : Object.freeze(own);
  }, [graphSelections]);
  const graphSelection = graphSelections.length === 1 ? graphSelections[0] : null;
  const graphEntities = sketch?.graph?.entities.filter(entity => isCadSketchGraphSelected(graphSelections, { kind: 'entity', id: entity.id })) ?? [];
  const selectedGraphEntity = graphSelection?.kind === 'entity' ? sketch?.graph?.entities.find(entity => entity.id === graphSelection.id) : null;
  const graphForReferences = sketch?.graph;
  const graphEditLock = graphForReferences ? graphGeometry.map(atom => cadSketchOwnedGeometryLockReason(graphForReferences, atom) ?? cadSketchExternalReferenceLockReason(graphForReferences, atom)).find(Boolean) ?? null : null;
  const selectedPattern = graphForReferences && graphSelection ? cadSketchLinearPatternForSelection(graphForReferences, graphSelection) : null;
  const patternConstructionLocked = Boolean(graphForReferences && graphGeometry.some(atom => cadSketchLinearPatternForSelection(graphForReferences, atom)));
  const sketchCornerAvailable = useMemo(() => {
    if (graphSelection?.kind !== 'point' || !sketch?.graph) return false;
    try { inspectCadSketchCornerTarget(sketch.graph, graphSelection.id, document.parameters); return true; } catch { return false; }
  }, [graphSelection, sketch, document.parameters]);
  const selectGraphSet = useCallback((selections: readonly CadSketchGraphSelection[]) => {
    // Source controls and accepted creation callbacks supply known IDs; agent input is validated
    // at the viewport boundary. A creation callback can precede this render's graph update.
    setGraphPick(sketchId && selections.length ? { sketchId, selections } : null);
    setGraphRelationCommand(null); setRelationRowPick(null);
    if (selections.length) { setProfileId(null); setProfileCommand(null); }
  }, [sketchId]);
  const selectGraph = useCallback((selection: CadSketchGraphSelection | null, additive = false) => {
    selectGraphSet(selection ? additive ? toggleCadSketchGraphSelection(graphSelections, selection) : [selection] : NO_SKETCH_SELECTIONS);
  }, [graphSelections, selectGraphSet]);
  /**
   * A dimension or relation glyph pick replaces the geometry selection and never opens the editor; double-click or Enter does.
   * Dimensions, relation marks and tree rows of relations the canvas does not draw share one relation selection, so Shift adds any of them
   * to the others. A label or glyph names the relations it was drawn for, so one that a replacement under the same ID has taken over selects nothing.
   */
  const selectGraphAnnotations = useCallback((annotations: readonly CadSketchDimensionPick[] | null, additive = false) => {
    if (!sketchId) return;
    const drawn = sketch?.id === sketchId ? drawnAnnotations : undefined, graph = drawn?.graph;
    const picks = annotations && drawn ? annotations.flatMap(item => { const pick = cadSketchDimensionPick(drawn, item.id); return pick && sameCadSketchDimensionPick(pick, item, drawn.graph) ? [pick] : []; }) : [];
    if (annotations && (!annotations.length || picks.length !== annotations.length)) return;
    const dimensions = annotations ? selectCadSketchAnnotations(graphDimensionPicks, picks, graph, additive) : NO_SKETCH_DIMENSIONS;
    setGraphPick(dimensions.length ? { sketchId, selections: NO_SKETCH_SELECTIONS, dimensions } : null);
    setGraphRelationCommand(null);
    if (!annotations || !additive) setRelationRowPick(null);
    if (dimensions.length) { setProfileId(null); setProfileCommand(null); }
  }, [sketchId, sketch, graphDimensionPicks, drawnAnnotations]);
  const selectGraphDimension = useCallback((dimension: CadSketchDimensionPick | null, additive = false) => selectGraphAnnotations(dimension ? [dimension] : null, additive), [selectGraphAnnotations]);
  // The canvas lights the relation a value editor edits, or the one tree row selected for a relation it does not draw.
  const inspectedRelation = (valueEditorCurrent ? valueRelation : relationRowIds.length === 1 ? sketch?.graph?.relations.find(item => item.id === relationRowIds[0]) : undefined) ?? null;
  const inspectIssue = useCallback((issue: CadSketchIssue | null) => setDiagnosticInspection(issue && sketchId ? { document, sketchId, issue } : null), [document, sketchId]);
  const inspectedIssue = diagnosticInspection?.document === document && diagnosticInspection.sketchId === sketch?.id ? diagnosticInspection.issue : null;
  /** An issue lights its geometry, its relation's mark, and the origin or axis that relation names or holds a point on. */
  const issueHighlight = useCallback((issue: CadSketchIssue) => {
    const graph = sketch?.graph, relation = issue.relationId ? graph?.relations.find(item => item.id === issue.relationId) : undefined;
    const named = graph && relation ? cadSketchRelationHighlight(graph, relation) : null;
    const fixed = (ids: readonly string[] | undefined, shown: readonly string[]) => ids?.filter(id => isCadSketchVirtualId(id) && !shown.includes(id)) ?? [];
    return { pointIds: [...issue.pointIds, ...fixed(named?.pointIds, issue.pointIds)], entityIds: [...issue.entityIds, ...fixed(named?.entityIds, issue.entityIds)], relationIds: relation ? [relation.id] : [] };
  }, [sketch]);
  const diagnosticHighlight = useMemo(() => inspectedIssue ? issueHighlight(inspectedIssue) : null, [inspectedIssue, issueHighlight]);
  // A report that leaves the shown freedom, locks and colours as they are queues no update, so the workbench does not
  // render again for it. Equal definitions keep their marks, so a new version with the same result changes nothing.
  const requestedAnalysis = useRef(sketchAnalysis);
  const publishSketchReport = useCallback((report: CadSketchConstraintReport | null) => {
    if (!sketchId) return;
    const previous = requestedAnalysis.current, owned = report?.document.id === document.id && report.sketchId === sketchId ? report : null;
    const kept = previous?.document.id === document.id && previous.sketchId === sketchId ? previous : null;
    let next: SketchAnalysisState | null = null;
    if (owned) {
      const analysis = owned.analysis, sourceSketch = owned.document.features.find(feature => feature.id === sketchId);
      const definition = cadSketchDefinitionMarks(analysis.kind === 'solved' ? analysis.diagnostics.definition : undefined, kept?.definition);
      const diagnosis = analysis.kind === 'rejected' && sourceSketch?.kind === 'sketch' && sourceSketch.graph
        ? cadSketchDiagnosisMarks(sketchId, sourceSketch.graph, analysis.diagnostics, kept?.diagnosis) : null;
      next = { document: owned.document, version: owned.version, sketchId, freedom: owned.live && analysis.kind === 'solved' ? analysis.diagnostics.degreesOfFreedom : null,
        locks: owned.live && definition !== null, definition, diagnosis, issues: cadSketchAnalysisIssues(analysis, kept?.issues) };
    }
    const before = shownSketchAnalysis(previous, document, props.documentVersion, sketchId), after = shownSketchAnalysis(next, document, props.documentVersion, sketchId);
    if (before.freedom === after.freedom && before.locks === after.locks && before.definition === after.definition && before.diagnosis === after.diagnosis && before.issues === after.issues) return;
    requestedAnalysis.current = next; setSketchAnalysis(next);
  }, [document, props.documentVersion, sketchId]);
  const shownAnalysis = shownSketchAnalysis(sketchAnalysis, document, props.documentVersion, sketch?.id);
  const shownFeedback = editFeedback?.document === document && editFeedback.feedback.sketchId === sketch?.id ? editFeedback.feedback : null;
  const shownWarnings = props.sketchWarnings && props.sketchWarnings.version === props.documentVersion ? props.sketchWarnings.warnings : null;
  /** Conflicting, redundant and unmet relations, a refused edit's subjects and unsized shrinks, for the header and the relations tree alike. */
  const sketchIssues = useMemo(() => !sketch ? null : sketch.graph ? cadSketchIssuesStandInForD1({ sketchId: sketch.id, graph: sketch.graph, analysis: shownAnalysis.issues, feedback: shownFeedback, warnings: shownWarnings })
    : { sketchId: sketch.id, message: null, list: [], omitted: 0, byRelation: NO_CAD_SKETCH_ISSUES_BY_RELATION },
    [sketch, shownAnalysis.issues, shownFeedback, shownWarnings]);
  /** A sketch editor, the value editor or the icon row reports its refusal here, or null once it has none. */
  const reportEditFeedback = useCallback((feedback: CadSketchConstraintFeedback | null) => setEditFeedback(current => feedback ? current?.feedback === feedback && current.document === document ? current : { document, feedback }
    : current?.document === document ? null : current), [document]);
  const graphFreedom = shownAnalysis.freedom;
  /**
   * Every way of opening a value editor comes here: double-click or Enter on a dimension label or a fixed point's mark, Edit value…, or a
   * tree row. A drawn dimension or mark becomes the whole selection, so Delete removes what is drawn selected, before and after Apply or
   * Cancel; the editor opens beside it, or beside the tree row of a relation the canvas does not draw.
   */
  const editSketchValue = useCallback((relationId: string, pick: CadSketchDimensionPick | null) => {
    if (!sketchId) return;
    if (pick) { setGraphPick({ sketchId, selections: NO_SKETCH_SELECTIONS, dimensions: selectCadSketchDimension(NO_SKETCH_DIMENSIONS, pick, null) }); setRelationRowPick(null); }
    setProfileId(null); setProfileCommand(null);
    // A relation the canvas does not draw opens its editor beside its tree row, so the list opens.
    if (!pick) setRelationListOpen(true);
    setGraphRelationCommand({ kind: 'value', token: crypto.randomUUID(), documentId: document.id, sketchId, relationId, pick, version: props.documentVersion });
  }, [document.id, sketchId, props.documentVersion]);
  /** Opens the relations tree and scrolls it to a row, listing every relation so the row is there. */
  const revealRelationRow = useCallback((relationId: string | null) => {
    if (relationId) setRelationListScope(null);
    setRelationListOpen(true);
    setRelationListReveal({ relationId, token: crypto.randomUUID() });
  }, []);
  /**
   * Double-click, Enter or Edit value… opens the value editor of the dimension or fixed point shown, never a replacement under the same
   * ID; on another relation's mark it selects the mark and scrolls the relations tree to its row.
   */
  const configureGraphRelation = useCallback((relation: CadSketchGraphRelation) => {
    const graph = sketch?.graph, pick = graph && drawnAnnotations?.graph === graph ? cadSketchDimensionPick(drawnAnnotations, relation.id) : null;
    if (interactionState.current.locked || !sketchId || !graph || !pick || !sameCadSketchDimensionPick(pick, cadSketchDimensionPickOf(relation), graph)) return;
    if (isCadSketchValueRelation(relation)) { editSketchValue(relation.id, pick); return; }
    selectGraphAnnotations([pick]); revealRelationRow(relation.id);
  }, [sketchId, sketch, drawnAnnotations, editSketchValue, selectGraphAnnotations, revealRelationRow]);
  /** A glyph's double-click or Enter names the relation it was drawn for; one a replacement under the same ID has taken over opens nothing. */
  const openGraphRelation = useCallback((pick: CadSketchDimensionPick) => {
    const relation = sketch?.graph?.relations.find(item => item.id === pick.id);
    if (relation && isCadSketchGlyphRelation(relation) && drawnAnnotations?.graph === sketch?.graph && isCadSketchDimensionPickCurrent(drawnAnnotations, pick)) configureGraphRelation(relation);
  }, [sketch, drawnAnnotations, configureGraphRelation]);
  // Another part or sketch starts with nothing selected before anything renders against it, so a relations row open on the old
  // selection never mounts, or takes focus, in the new part.
  const [pickScope, setPickScope] = useState({ documentId: document.id, sketchId });
  if (pickScope.documentId !== document.id || pickScope.sketchId !== sketchId) { setPickScope({ documentId: document.id, sketchId }); setGraphPick(null); }
  const curve = document.features.find((feature): feature is CadCurveFeature => feature.kind === 'curve' && feature.id === curveId);
  const curveCreation = newFeature?.kind === 'curve' ? newFeature : null;
  const canvasReference = curveCreation ?? curve ?? sketch;
  const preparedSketchDocument = (editorPending || drawingPending) && sketchPreview?.source === document ? sketchPreview.document : null;
  // A rejected preview or Apply marks its operands until the editor publishes again; otherwise a rejected analysis does.
  const previewMarks = (editorPending || drawingPending) && sketchPreview?.source === document && sketchPreview.marks?.sketchId === sketch?.id ? sketchPreview.marks : null;
  const preparedSketch = preparedSketchDocument?.features.find((feature): feature is CadSketchFeature => feature.kind === 'sketch' && feature.id === sketch?.id);
  // Body identity for this history, derived once per document rather than on every render.
  const bodyLineage = useMemo(() => cadBodyLineage(document.features, document), [document]);
  const visibleBodyIds = useMemo(() => bodyLineage.bodies().map(cadBodyFeatureId), [bodyLineage]);
  // Hovering a plane renders the workbench again; the drawn bodies and the section body change only with the build or the selection.
  const currentBodyIds = useMemo(() => buildState === 'ready' ? build?.meshes.map((mesh) => mesh.featureId).filter((id) => visibleBodyIds.includes(id)) ?? [] : [],
    [buildState, build, visibleBodyIds]);
  const topologyReady = buildState === 'ready' && props.buildVersion === props.documentVersion && Boolean(build);
  const topologySelection = pickedTopology && !canvasReference && topologyReady && pickedTopology.documentVersion === props.documentVersion && pickedTopology.buildId === build?.buildId
    && currentBodyIds.includes(pickedTopology.bodyId) ? pickedTopology : null;
  const depthVisualEligible = !pluginsOpen && !treeRenamePending && !externalWorkflowOpen && !treeMenuOpen && !currentCanvasMenu && !currentReferencePick;
  const depthHandlesShown = cadDepthHandlesShown(preferences);
  // Onshape-style: with no dialog open, the selected Pad (or the Pad of a picked end face) drags its Length in place.
  const directDepthFeatureId = depthHandlesShown && !newFeature && !canvasReference && !(selected && openFeatureId === selected.id) && !props.sketchEdit
    ? cadDirectDepthTarget(document, topologyReady ? build?.meshes ?? [] : [], topologySelection, selectedId) : null;
  const directDepthEnvironment = useRef<CadDirectDepthEnvironment>({ document, documentVersion: props.documentVersion, enabled: false });
  directDepthEnvironment.current = { document, documentVersion: props.documentVersion, enabled: !locked };
  const directDepthCallbacks = useRef({ preview: props.onFeaturePreview, commit: (_edits: CadFeatureCandidateEdits) => undefined as void, ask: (_edits: CadFeatureCandidateEdits) => undefined as void });
  const directDepth = useMemo(() => directDepthFeatureId ? createCadDirectDepthControl({
    featureId: directDepthFeatureId, baseVersion: props.documentVersion, owner: `${directDepthOwner}:${directDepthFeatureId}`,
    read: () => directDepthEnvironment.current,
    preview: command => directDepthCallbacks.current.preview?.(command),
    commit: edits => directDepthCallbacks.current.commit(edits),
    ask: edits => directDepthCallbacks.current.ask(edits),
    onGestureChange: setDirectDepthActive
  }) : null, [directDepthFeatureId, props.documentVersion, directDepthOwner]);
  useEffect(() => () => directDepth?.dispose(), [directDepth]);
  useLayoutEffect(() => { directDepth?.refresh(); }, [directDepth, document, locked]);
  const editorDepthControl = depthInteraction?.document === document && depthInteraction.control.baseVersion === props.documentVersion
    && depthInteraction.control.featureId === (newFeature?.id ?? selectedId) ? depthInteraction.control : null;
  const currentDepthControl = depthHandlesShown && !canvasReference && !currentOwnedPick && !currentSketchPlaneRequest
    && !referenceContextBlocked && depthVisualEligible ? editorDepthControl ?? directDepth : null;
  const ownedPreview = props.featurePreview && props.featurePreview.kind !== 'idle' && props.featurePreview.baseVersion === props.documentVersion
    && ((editorPending || newFeature !== null) && props.featurePreview.featureId === (newFeature?.id ?? selectedId)
      || directDepth !== null && props.featurePreview.owner === directDepth.owner) ? props.featurePreview : null;
  const candidatePreview = currentReferencePick || currentTopologyPick ? null : ownedPreview?.kind === 'ready' ? ownedPreview : ownedPreview?.lastValid ?? null;
  const displayedDocument = candidatePreview?.document ?? document;
  const displayedBuild = candidatePreview?.result ?? build;
  const displayedMeshes = currentTopologyPick ? inputPicker.meshes : displayedDocument.features.some(feature => cadFeatureActive(feature, displayedDocument) && cadFeatureProducesBody(feature)) ? displayedBuild?.meshes ?? NO_MESHES : NO_MESHES;
  const preparedReferences = useMemo(() => prepareCadViewportReferences(displayedDocument.features, displayedDocument.parameters), [displayedDocument.features, displayedDocument.parameters]);
  // Origin planes and axes span the model; they change only when the model outgrows a size step, so a rebuild usually keeps them.
  const modelBounds = useMemo(() => cadModelBounds(displayedMeshes, preparedReferences), [displayedMeshes, preparedReferences]);
  const originReferences = useMemo(() => cadOriginReferences(modelBounds), [modelBounds]);
  const partView = useMemo(() => cadPartViewChoices(preferences, document.id), [preferences, document.id]);
  const referenceGeometryShown = partView.showReferenceGeometry;
  const baseReferences = useMemo(() => currentTopologyPick ? [] : currentRegionPick ? preparedReferences.filter(reference => reference.featureId === currentRegionPick.sketchId && !reference.construction) : currentReferencePick ? preparedReferences.filter(reference => reference.featureId !== null && currentReferencePick.eligibleIds.includes(reference.featureId))
    : currentSketchPlaneRequest ? [...originReferences.filter(reference => reference.featureKind === 'principal-plane'), ...preparedReferences.filter(reference => reference.featureKind === 'datum-plane')]
      // Like CATIA's default planes, the origin planes, axes and point, and every datum plane, stay in the design area so either view can
      // pick them. With reference geometry turned off only the selected one stays, and datum planes show as the selection needs them.
      : referenceGeometryShown ? [...originReferences, ...preparedReferences.filter(reference => reference.featureKind === 'datum-plane'),
        ...selectCadViewportReferences(preparedReferences, displayedDocument, selectedId).filter(reference => reference.featureKind !== 'datum-plane')]
      : [...originReferences.filter(reference => reference.featureKind === 'principal-plane' ? reference.plane === selectedReferencePlane
        : reference.featureKind === 'origin-axis' ? selectedOrigin?.kind === 'axis' && selectedOrigin.axis === reference.axis : reference.featureKind === 'origin-point' && selectedOrigin?.kind === 'point'),
        ...selectCadViewportReferences(preparedReferences, displayedDocument, selectedId)],
    [preparedReferences, originReferences, referenceGeometryShown, selectedReferencePlane, selectedOrigin, displayedDocument.features, selectedId, currentReferencePick, currentRegionPick, currentTopologyPick, currentSketchPlaneRequest]);
  // Hovering an installed plane keeps the same references, so the viewport keeps its own hover.
  const references = useMemo(() => currentTopologyPick || currentRegionPick || currentReferencePick || currentSketchPlaneRequest ? baseReferences
    : cadReferencesWithHoveredPlane(baseReferences, preparedReferences, hoveredReferencePlane, originReferences),
    [baseReferences, preparedReferences, originReferences, hoveredReferencePlane, currentTopologyPick, currentRegionPick, currentReferencePick, currentSketchPlaneRequest]);
  const visibleReferenceIds = useMemo(() => cadReferenceFeatureIds(references), [references]);
  const visibleReferencePlanes = useMemo(() => cadReferencePlanes(references), [references]);
  const hasActiveBodyFeatures = document.features.some(feature => cadFeatureActive(feature, document) && cadFeatureProducesBody(feature));
  useEffect(() => { if (!hasActiveBodyFeatures) setPickMode('auto'); }, [hasActiveBodyFeatures]);
  const selectedSketch = selected?.kind === 'sketch' ? selected : sketch;
  // A generator of a profile's shape is configured as that profile was.
  const profile = sketch ? cadSketchProfileViews(sketch).find((entry) => entry.id === profileId) : undefined;
  // A generator without a profile form, a regular polygon, is configured by its own inputs editor.
  const shapeGenerator = sketch && profileId && !profile ? shapeGeneratorOf(sketch, profileId) : undefined;
  const offsetSource = useMemo(() => sketch ? cadSketchOffsetSource(sketch, document.parameters, graphGeometry, profileId) : null, [sketch, document.parameters, graphGeometry, profileId]);
  const currentOffset = offsetCommand?.sketchId === sketch?.id ? offsetCommand : null;
  const currentPattern = patternCommand?.sketchId === sketch?.id ? patternCommand : null;
  useLayoutEffect(() => { if (patternCommand && !currentPattern) setPatternCommand(null); }, [patternCommand, currentPattern]);
  const currentMirror = mirrorCommand?.sketchId === sketch?.id ? mirrorCommand : null;
  const currentPlacement = placementCommand?.sketchId === sketch?.id ? placementCommand : null;
  const placementPositionPick = currentPlacement ? placementInteraction?.positionPick : undefined;
  useLayoutEffect(() => { if(placementCommand && !currentPlacement) setPlacementCommand(null); },[placementCommand,currentPlacement]);
  const currentSketchReference = sketchReferenceCommand?.sketchId === sketch?.id ? sketchReferenceCommand : null;
  const referenceSources = useMemo(() => sketch ? cadSketchReferenceSources(document, sketch.id) : [], [document, sketch]);
  useLayoutEffect(() => { if (sketchReferenceCommand && !currentSketchReference) setSketchReferenceCommand(null); }, [sketchReferenceCommand, currentSketchReference]);
  const copiedPreview = profileCopyCommand && profileCopyPreview?.features.find(feature => feature.kind === 'sketch' && feature.id === profileCopyCommand.request.newSketchId);
  const mirrorAxisPick = currentMirror && mirrorInteraction?.kind === 'choose-line' ? mirrorInteraction.pick : undefined;
  useLayoutEffect(() => { if (offsetCommand && !currentOffset) setOffsetCommand(null); }, [offsetCommand, currentOffset]);
  useLayoutEffect(() => { if (mirrorCommand && !currentMirror) setMirrorCommand(null); }, [mirrorCommand, currentMirror]);
  const canvasParameters = preparedSketchDocument?.parameters ?? previewParameters ?? document.parameters;
  // The editing canvas shows the part behind it; source and copy previews keep the plain sketch surface.
  const backgroundSketch = canvasReference && !currentRegionPick && !currentSketchReferencePick?.source && !(copiedPreview && profileCopyPreview) ? canvasReference : null;
  const openSketchViewId = backgroundSketch?.id ?? null;
  const sketchViewState = cadViewStateFor(openSketchViewId, cadSketchViewChoices(preferences)), sketchViewContext = sketchViewState.context;
  const sketchBackground = sketchViewContext.kind === 'sketch' ? sketchViewContext.background : null;
  const sketchCut = sketchViewContext.kind === 'sketch' && sketchViewContext.cutBySketchPlane;
  /** A choice made in a sketch is a device preference: every sketch opened later starts with it. */
  const changeSketchView = useCallback((action: CadViewAction) => {
    const stored = getCadPreferences(), current = cadViewStateFor(openSketchViewId, cadSketchViewChoices(stored)), next = reduceCadViewState(current, action);
    if (next !== current) setCadPreferences({ ...stored, sketchView: next.remembered });
  }, [openSketchViewId]);
  /**
   * Part view choices are device preferences too. The section belongs to the document it was made in, so another document keeps its
   * own; the reference geometry and the selection filter apply to every document. Defaults are not written.
   */
  const changePartView = useCallback((action: CadPartViewAction) => {
    const stored = getCadPreferences(), current = cadPartViewChoices(stored, document.id), next = reduceCadPartView(current, action);
    if (next === current) return;
    const written: { -readonly [Key in keyof CadPreferences]: CadPreferences[Key] } = { ...stored };
    delete written.section; delete written.showReferenceGeometry; delete written.selectionFilter;
    const section = next.section ? cadStoredSectionView(next.section, document.id) : stored.section?.documentId !== document.id ? stored.section : undefined;
    if (section) written.section = section;
    if (!next.showReferenceGeometry) written.showReferenceGeometry = false;
    if (next.selectionFilter.excluded.length) written.selectionFilter = next.selectionFilter;
    setCadPreferences(written);
  }, [document.id]);
  const changeSelectionFilter = useCallback((filter: CadSelectionFilter) => changePartView({ kind: 'set-selection-filter', filter }), [changePartView]);
  // A section by a datum plane that is deleted or suppressed turns off; undoing that does not bring the section back.
  const sectionAvailable = !partView.section || cadSectionPlaneAvailable(partView.section.plane, document);
  useLayoutEffect(() => { if (!sectionAvailable) changePartView({ kind: 'clear-section' }); }, [sectionAvailable, changePartView]);
  /** Turns the section on by a plane, or off; the view controls, the menus and agents all come here. */
  const setSectionView = useCallback((section: { readonly plane: CadSectionPlane; readonly flip?: boolean; readonly caps?: boolean } | null) => {
    if (!section) { changePartView({ kind: 'clear-section' }); return; }
    if (!cadSectionPlaneAvailable(section.plane, interactionState.current.document)) return;
    changePartView({ kind: 'set-section', plane: section.plane, ...(section.flip === undefined ? {} : { flip: section.flip }), ...(section.caps === undefined ? {} : { caps: section.caps }) });
  }, [changePartView]);
  // An open sketch or curve shows its own view; the section returns when it closes.
  const shownSection = sectionAvailable && !sketch && !curve ? cadShownSection(sketchViewState, partView) : null;
  // The plane is compared by value, so a rebuild that leaves it in place keeps the view's clipping as it is.
  const viewportSectionCache = useRef<CadViewportSection | null>(null);
  const viewportSection = useMemo((): CadViewportSection | null => {
    const frame = shownSection ? resolveCadSectionFrame(shownSection.plane, displayedDocument.features, displayedDocument.parameters) : null;
    const previous = viewportSectionCache.current;
    const next = frame && shownSection ? previous && previous.flip === shownSection.flip && previous.caps === shownSection.caps && sameCadSectionFrame(previous.frame, frame) ? previous
      : Object.freeze({ frame, flip: shownSection.flip, caps: shownSection.caps }) : null;
    viewportSectionCache.current = next;
    return next;
  }, [shownSection, displayedDocument.features, displayedDocument.parameters]);
  // One link for the workbench's life: the canvas publishes each view it draws and the viewport behind it follows.
  const [sketchCameraLink] = useState(createCadSketchCameraLink);
  const publishSketchViewFrame = useCallback((frame: CadSketchCameraView) => sketchCameraLink.publish(frame), [sketchCameraLink]);
  // Placement is compared by value, so edits inside the sketch keep the background as it is.
  const placementCache = useRef<CadSketchPlacementFrame | null>(null);
  const sketchPlacement = useMemo(() => {
    let next: CadSketchPlacementFrame | null = null;
    if (backgroundSketch) try { next = resolveCadSketchPlacement(backgroundSketch, canvasParameters, prepareCadDatumFrames(document.features, canvasParameters)); } catch { next = null; }
    if (!sameCadSketchPlacementFrame(placementCache.current, next)) placementCache.current = next;
    return placementCache.current;
  }, [backgroundSketch, document.features, canvasParameters]);
  const backgroundReferenceCache = useRef<readonly CadViewportReference[] | null>(null);
  const sketchBackgroundReferences = useMemo(() => {
    if (!openSketchViewId) return null;
    backgroundReferenceCache.current = cadSketchBackgroundReferences(preparedReferences, openSketchViewId, backgroundReferenceCache.current);
    return backgroundReferenceCache.current;
  }, [preparedReferences, openSketchViewId]);
  const sketchBackgroundView = useMemo((): CadSketchBackgroundView | null => sketchPlacement && (sketchBackground === 'normal' || sketchBackground === 'dimmed')
    ? Object.freeze({ placement: sketchPlacement, background: sketchBackground, cutBySketchPlane: sketchCut, camera: sketchCameraLink }) : null,
  [sketchPlacement, sketchBackground, sketchCut, sketchCameraLink]);
  // The sketch surface covering the model view, named as its canvas is keyed, so a different sketch counts as a new surface.
  const coveringSketchKey = currentSketchReferencePick?.source ? `use-source/${currentSketchReferencePick.source.id}`
    : copiedPreview?.kind === 'sketch' && profileCopyPreview ? `copy/${copiedPreview.id}`
    : canvasReference && !currentRegionPick ? `${document.id}/${canvasReference.id}` : null;
  const modelingArea = useRef<HTMLElement>(null);
  const shownSketchSurface = useRef(coveringSketchKey);
  // However a sketch opens or closes (tree, double-click, agent, undo), focus the covered model view held moves to the sketch canvas,
  // and focus a closing sketch canvas held moves back to the model view. Focus anywhere else stays where it is.
  useLayoutEffect(() => {
    const previous = shownSketchSurface.current, area = modelingArea.current;
    shownSketchSurface.current = coveringSketchKey;
    if (previous === coveringSketchKey || !area) return;
    const active = window.document.activeElement, lost = !active || active === window.document.body;
    if (coveringSketchKey) {
      if (lost || area.querySelector('.cad-viewport')?.contains(active)) area.querySelector<SVGSVGElement>('svg.cad-sketch-canvas')?.focus({ preventScroll: true });
    } else if (lost) area.querySelector<HTMLCanvasElement>('.cad-viewport canvas')?.focus({ preventScroll: true });
  }, [coveringSketchKey]);
  const sketchViewControls = useMemo(() => sketchBackground === null ? null : <span className="cad-sketch-view-choices" role="group" aria-label="Part behind the sketch">
    <span className="cad-divider" />
    <label className="cad-grid-step">3D background <Select density="compact" value={sketchBackground} onChange={event => {
      const background = CAD_SKETCH_BACKGROUNDS.find(entry => entry === event.target.value);
      if (background) changeSketchView({ kind: 'set-sketch-background', background });
    }}><option value="normal">Normal</option><option value="dimmed">Dimmed</option><option value="hidden">Hidden</option></Select></label>
    <label className="cad-check"><Input type="checkbox" checked={sketchCut} disabled={sketchBackground === 'hidden'} onChange={event => changeSketchView({ kind: 'set-cut-by-sketch-plane', cut: event.target.checked })} />Cut part by sketch plane</label>
    <CadContextHelp label="Part behind the sketch">The part shows behind the sketch, seen square to the sketch plane, and follows every pan and zoom. Dimmed fades it toward the background; Hidden leaves only the sketch. Cut part by sketch plane removes the material between you and the sketch plane while the part shows. Clicks and picks reach only the open sketch. These choices stay on this device for the next sketch.</CadContextHelp>
  </span>, [sketchBackground, sketchCut, changeSketchView]);
  const sectionPlaneName = selectedReferencePlane ? cadReferenceSelectionName({ kind: 'plane', plane: selectedReferencePlane }, document.features) : null;
  // Section, reference geometry and the selection filter sit with the model view's own controls; an open sketch or curve has its own.
  const partViewControls = sketch || curve ? null : <span className="cad-part-view-choices" role="group" aria-label="Section and selection">
    <span className="cad-divider" />
    <Button aria-label="Section view" aria-pressed={Boolean(shownSection)} disabled={navigationLocked || !shownSection && !selectedReferencePlane}
      title={shownSection ? 'Turn the section view off (Escape)' : sectionPlaneName ? `Section view by ${sectionPlaneName}` : 'Section view: select a plane first'}
      onClick={() => { if (shownSection) setSectionView(null); else if (selectedReferencePlane) setSectionView({ plane: selectedReferencePlane }); }}><SectionViewIcon size={14} /></Button>
    {shownSection && <>
      <Button aria-label="Flip section" title="Keep the other side of the section plane" aria-pressed={shownSection.flip} disabled={navigationLocked}
        onClick={() => changePartView({ kind: 'set-section-flip', flip: !shownSection.flip })}><FlipVerticalIcon size={14} /></Button>
      <label className="cad-check"><Input type="checkbox" title="Fill the cut material with a flat colour" checked={shownSection.caps} disabled={navigationLocked}
        onChange={event => changePartView({ kind: 'set-section-caps', caps: event.target.checked })} />Caps</label>
    </>}
    <Button aria-label="Show reference geometry" title="Show the origin planes, axes and point, and the datum planes" aria-pressed={partView.showReferenceGeometry}
      onClick={() => changePartView({ kind: 'set-reference-geometry', shown: !partView.showReferenceGeometry })}><OriginIcon size={14} /></Button>
    <CadToolbarMenu label="Filter" menuLabel="Selection filter" title="Choose what clicks and hover can select in the model view" icon={<SelectIcon size={14} />} disabled={false}
      pressed={partView.selectionFilter.excluded.length > 0} className="cad-pattern-menu cad-selection-filter-menu"
      items={PART_SELECTION_KINDS.map(({ kind, label }) => ({ key: kind, label, checked: cadSelectionAccepts(partView.selectionFilter, kind),
        onSelect: () => changePartView({ kind: 'set-selection-kind', selection: kind, accepted: !cadSelectionAccepts(partView.selectionFilter, kind) }) }))} />
    <CadContextHelp label="Section and selection">Select a plane, in the tree or in the design area, then Section view cuts the model by it. Flip keeps the other side, Caps fills the cut material, and Escape with nothing selected turns the section off. The section is a view only: it changes nothing in the part, and clicks reach only what it leaves. Show reference geometry shows the origin planes, axes and point and the datum planes. Filter chooses what clicks and hover can select. These choices stay on this device.</CadContextHelp>
  </span>;
  const dimensionGeometry = profile?.geometry;
  renderedPreferences.current = { navigationMode: preferences.navigationMode, onPartDimensionsVisible: preferences.showOnPartDimensions
    && tool === 'select' && (Boolean(drawnDimensions?.ids.size)
      || !profilePreview && !preparedSketch && Boolean(profile && (inspectCadSketchDimensions(profile, document.parameters).length || dimensionGeometry?.kind === 'plugin' && dimensionGeometry.package.id === 'wireedm.spur-gear'))) };
  const parameterInspection = useMemo(() => inspectCadParameters(document), [document]);
  const parameterUsages = parameterInspection.parameters.find(parameter => parameter.name === inspectedParameter)?.usages.filter(usage => usage.active) ?? [];
  const highlightedProfiles = parameterUsages.filter(usage => usage.featureId === sketch?.id && usage.profileId).map(usage => usage.profileId).filter((id): id is string => typeof id === 'string');
  const gearUsage = parameterUsages.find(usage => usage.featureId === sketch?.id && usage.inputName && usage.profileId);
  const sketchInspection = currentOffset?.source.kind === 'profile' ? { profileIds: [currentOffset.source.profileId] } : inspectedParameter ? { profileIds: [...new Set(highlightedProfiles)],
    ...(gearUsage?.profileId && gearUsage.inputName ? { gear: { profileId: gearUsage.profileId, inputName: gearUsage.inputName } } : {}) }
    : inspectedInput && profile?.id === inspectedInput.profileId ? { profileIds: [profile.id], gear: inspectedInput } : undefined;
  const inspectInput = useCallback((name: string | null) => { setInspectedInput(name && profileId ? { profileId, inputName: name } : null); if (name) setInspectedParameter(null); }, [profileId]);
  useEffect(() => { setProfilePreview(null); setPreviewParameters(null); setSketchPreview(null); setInspectorCollapsed(false); }, [selectedId, sketchId, profileId]);
  // Only the model toolbar offers Pad, Revolve and Sweep, so an open sketch or curve skips their source checks, and other
  // renders of the same document reuse them.
  const modelToolbar = !sketch && !curve && !curveCreation;
  const modelSketchSources = useMemo(() => modelToolbar ? {
    pad: document.features.some(feature => feature.kind === 'sketch' && cadSketchSourceAvailability(feature, 'extrude', document.parameters).kind !== 'unavailable'),
    revolve: document.features.some(feature => feature.kind === 'sketch' && cadSketchSourceIssue(feature, 'revolve', document.parameters) === null),
    sweep: document.features.some(feature => feature.kind === 'sketch' && cadFeatureActive(feature, document) && cadSketchSourceIssue(feature, 'extrude', document.parameters) === null),
  } : null, [modelToolbar, document.features, document.parameters]);
  const hasBody = currentBodyIds.length > 0;
  const hasSolid = hasActiveBodyFeatures && buildState === 'ready' && Boolean(displayedMeshes.length);
  const propertiesFeature = properties?.kind === 'selection' ? selected : undefined;
  const currentProperties = properties?.kind === 'body' || propertiesFeature ? properties : null;
  const partPropertiesOpen = Boolean(currentProperties) && (currentProperties?.kind === 'body' || !propertiesFeature);
  // Selecting only highlights. The panel belongs to an open editor, an active command or an explicit Properties request.
  const featureEditorOpen = Boolean(selected && openFeatureId === selected.id && !sketch);
  const inspectorVisible = Boolean(profileCopyCommand || featureEditorOpen || sketch || curve || newFeature || resolvingTopology || currentProperties);
  const floatingPluginInspector = profile?.geometry.kind === 'plugin';

  const chainsAvailable = Boolean(props.onTopologyAdjacency && props.onTopologyTangentChain);
  const topologySource = useRef({ documentVersion: props.documentVersion, buildId: build?.buildId ?? null, ready: topologyReady });
  topologySource.current = { documentVersion: props.documentVersion, buildId: build?.buildId ?? null, ready: topologyReady };
  useLayoutEffect(() => {
    if (pickedTopology && !topologySelection) setPickedTopology(null);
    const resolving = topologyResolution.current;
    if (resolving && (!topologyReady || resolving.source.documentVersion !== props.documentVersion || resolving.source.buildId !== build?.buildId)) {
      resolving.controller.abort(); topologyResolution.current = null; setResolvingTopology(null);
      setError('The solid changed during selection conversion. Select topology from the current build.');
    }
  }, [props.documentVersion, props.buildVersion, build?.buildId, buildState, sketchId, pickedTopology, topologySelection, topologyReady]);
  useEffect(() => () => topologyResolution.current?.controller.abort(), []);
  const selectedFeatureId = selected?.id;
  const sectionBodyId = useMemo(() => { const body = cadSelectedBody(bodyLineage, selectedFeatureId, currentBodyIds); return body && cadBodyFeatureId(body); },
    [bodyLineage, selectedFeatureId, currentBodyIds]);
  const run = (action: () => CadEditCompletion) => {
    setError(null); setFileMenu(false);
    try { Promise.resolve(action()).catch((cause: unknown) => setError(userFacingMessage(cause, 'The operation could not be completed.'))); }
    catch (cause) { setError(userFacingMessage(cause, 'The operation could not be completed.')); }
  };
  /** Submits one edit; `asked` takes a refusal the caller answers itself, such as one to confirm, which is then not shown as an error. */
  const submitEdit = (apply: (signal: AbortSignal) => CadEditCompletion, accepted: () => void = () => undefined, failure = 'The edit could not be completed.', asked?: (cause: unknown) => boolean) => {
    props.onWorkflowChange(true);
    setError(null); setFileMenu(false); reportEditFeedback(null);
    commandSubmission.submit(apply, accepted, cause => {
      // A synchronous rejection can batch applying true→false without a pending-effect change.
      props.onWorkflowChange(latestPending.current);
      if (asked?.(cause)) return;
      setError(userFacingMessage(cause, failure));
      // The native judge's refusal names its relations in the header and the relations tree, as well as on the error line.
      if (cause instanceof CadSketchPreparationError) reportEditFeedback(cause.feedback);
    });
  };
  directDepthCallbacks.current = { preview: props.onFeaturePreview, commit: edits => {
    const owner = directDepth?.owner, featureId = edits[0].feature.id;
    const clear = () => { if (owner) props.onFeaturePreview?.({ kind: 'clear', owner }); };
    // One undoable edit; the dragged Pad stays selected so its handle remains under the pointer.
    submitEdit(signal => {
      try { return Promise.resolve(props.onEditMany(edits, signal)).finally(clear); }
      catch (cause) { clear(); throw cause; }
    }, () => { setPickedTopology(null); setSelectedId(featureId); });
  }, ask: edits => {
    // The drag has no dialog to ask in, so the Pad's editor opens with the dragged parameter and asks before Apply removes anything.
    const feature = document.features.find(entry => entry.id === edits[0].feature.id);
    if (!feature) return;
    setOpeningParameters({ featureId: feature.id, parameters: Object.fromEntries(edits.flatMap(edit => edit.kind === 'set-parameter' ? [[edit.name, edit.value]] : [])) });
    openFeatureEditor(feature);
  } };
  useEffect(() => { if (openingParameters && openFeatureId !== openingParameters.featureId) setOpeningParameters(null); }, [openFeatureId, openingParameters]);
  useEffect(() => { if (openingProfile && profileId !== openingProfile.profileId) setOpeningProfile(null); }, [profileId, openingProfile]);
  const deleteProfile = (source: CadSketchFeature, id: string) => submitEdit(signal => props.onEdit({ kind: 'update-feature', feature: withoutCadSketchProfile(source, id) }, signal),
    () => setProfileId(current => current === id ? null : current));
  const applyCanvasEdits = (edits: readonly CadEdit[], signal?: AbortSignal) => {
    // Moving dimensions is accepted at once, so it opens no workflow for its caller to close.
    if (cadEditsOnlyPlaceDimensions(document, edits)) return props.onEditMany(edits, signal);
    props.onWorkflowChange(true);
    const received = (result: Awaited<CadEditCompletion>) => {
      if (!signal?.aborted && result?.document === document && interactionState.current.document === document
        && interactionState.current.version === props.documentVersion && interactionState.current.sketchId === sketchId
        && edits.length === 1 && edits[0].kind === 'move-sketch-point' && edits[0].sketchId === sketchId) {
        props.onStatusMessage?.('This move is constrained by the sketch dimensions and relations.', 'info');
      }
      return result;
    };
    const completion = props.onEditMany(edits, signal);
    return completion && 'then' in completion ? completion.then(received) : received(completion);
  };
  /**
   * A profile moved on the canvas, by a grip or a drag: a saved profile by `legacy`, a generator's view by writing the `moved` shape as its
   * inputs. Where that removes relations nothing applies, and the generator's exact editor opens at the moved shape, where Apply asks, as a
   * Length dragged to such a value opens its Pad's editor.
   */
  const moveCanvasProfile = (id: string, moved: (profile: CadSketchProfile) => CadSketchProfile, legacy: CadEdit, signal?: AbortSignal): CadEditCompletion => {
    if (!sketch) return;
    const view = cadSketchProfileGenerator(sketch, id) ? cadSketchProfileViews(sketch).find(entry => entry.id === id) : undefined;
    if (!view) return applyCanvasEdits([legacy], signal);
    const next = moved(view);
    const ask = (cause: unknown) => {
      if (!cadGeneratorRemovals(cause)) throw cause;
      setOpeningProfile(current => ({ profileId: id, geometry: next.geometry, token: (current?.token ?? 0) + 1 }));
      selectProfile(id); setInspectorCollapsed(false);
    };
    try {
      const completion = applyCanvasEdits(cadSketchProfileEdits(sketch, next), signal);
      return completion && 'then' in completion ? completion.catch(ask) : completion;
    } catch (cause) { ask(cause); }
  };
  useEffect(() => commandSubmission.cancel(), [document.id, commandSubmission.cancel]);
  useLayoutEffect(() => { props.onWorkflowChange(pending); }, [pending, props.onWorkflowChange]);
  useLayoutEffect(() => {
    props.onViewportControlsReady?.(viewportControls);
    return () => props.onViewportControlsReady?.(null);
  }, [props.onViewportControlsReady, viewportControls]);
  const workflowCallback = useRef(props.onWorkflowChange);
  workflowCallback.current = props.onWorkflowChange;
  useEffect(() => () => workflowCallback.current(false), []);
  useEffect(() => { setNameDraft(document.name); }, [document.name]);
  // Closing the part's Properties, or a rename rejected after it closed, restores the saved name so no hidden draft holds the commands.
  useEffect(() => {
    if (namePending && !partPropertiesOpen && !commandSubmission.applying) { setNameDraft(document.name); setNamePending(false); }
  }, [namePending, partPropertiesOpen, commandSubmission.applying, document.name]);
  useEffect(() => {
    const dialog = deleteDialog.current;
    if (!deleteFeature || !dialog) return;
    const previous = window.document.activeElement;
    const buttons = () => [...dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    buttons()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); commandSubmission.cancel(); setDeleteFeature(null); }
      else if (event.key === 'Tab') {
        const entries = buttons();
        const first = entries[0], last = entries.at(-1);
        if (event.shiftKey && window.document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && window.document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    dialog.addEventListener('keydown', onKey);
    return () => { dialog.removeEventListener('keydown', onKey); if (previous instanceof HTMLElement) previous.focus(); };
  }, [deleteFeature, commandSubmission.cancel]);
  useEffect(() => {
    if (selectedId && !document.features.some((feature) => feature.id === selectedId)) setSelectedId(null);
    if (curveId && !document.features.some(feature => feature.kind === 'curve' && feature.id === curveId)) setCurveId(null);
    if (sketchId && !document.features.some((feature) => feature.id === sketchId && feature.kind === 'sketch')) { setSketchId(null); setProfileId(null); }
    else if (profileId && !(sketch && (cadSketchProfileViews(sketch).some((entry) => entry.id === profileId) || shapeGeneratorOf(sketch, profileId)))) setProfileId(null);
  }, [document.id, document.features, selectedId, sketchId, curveId, profileId, sketch]);
  const cancel = useCallback(() => {
    if (dimensionToolOwner.current) { commandSubmission.cancel(); endDimensionTool(); return; }
    commandSubmission.cancel(); setConstraintToolRequest(null);
    // The relations command ends with the selection that cancellation clears, before the panel could remount its row.
    setGraphRelationCommand(null);
    planeRequestOwner.current = null; setSketchPlaneRequest(null);
    setCanvasMenu(null); setAreaRepair(null); setOffsetCommand(null); setMirrorCommand(null); setMirrorInteraction(null); setPlacementCommand(null); setPlacementInteraction(null); setPatternCommand(null); setPatternInteraction(null);
    setProfileCopyCommand(null); setProfileCopyPreview(null); setProfileCopyAccepted(null);
    setSketchReferenceCommand(null); setSketchReferenceInteraction(null);
    topologyResolution.current?.controller.abort(); topologyResolution.current = null; setResolvingTopology(null);
    setPickedTopology(null);
    setCancelSignal((value) => value + 1); setOpeningParameters(null); setOpeningProfile(null); setNewFeature(null); setDrawingPending(false); setEditorPending(false); setParameterPending(false); setDimensionPending(false); setTreeRenamePending(false); setDeleteFeature(null); setFileMenu(false); setTool('select'); setError(null);
    setInspectedParameter(null); setInspectedInput(null); setProfilePreview(null); setPreviewParameters(null); setProfileCommand(null); setNameDraft(document.name); setNamePending(false);
  }, [document.name, commandSubmission.cancel, endDimensionTool]);
  /** Cancel and the close control leave an open feature editor; the selection stays. */
  const closeFeatureEditor = () => { cancel(); setOpenFeatureId(null); };
  // Escape first discards an editor draft, then a second Escape closes the clean editor, then a third clears the part selection.
  // A drawing takes Escape first: a line chain saves its completed segments, any other pending shape is discarded, and only
  // an Escape with nothing pending leaves the tool.
  const escape = () => {
    if (!pendingOutsideDrawing && drawingControls.current?.escape()) return;
    if (escapeDimensionTool()) return;
    leave();
  };
  const leave = () => {
    const idle = !pending && !featureEditorOpen && !currentProperties && !newFeature && !sketch && !curve && !currentOwnedPick && !currentSketchPlaneRequest && !resolvingTopology && !deleteFeature && !currentCanvasMenu;
    if (!pending) setOpenFeatureId(null);
    cancel(); setProperties(null);
    if (!idle) return;
    if (!selected && !selectedReference && !profileId && shownSection) { changePartView({ kind: 'clear-section' }); return; }
    setSelectedId(null); setProfileId(null); setPlaneSelection(null);
  };
  const selectEscapeGuard = useMemo(() => createCadSelectEscapeGuard(window.document), []);
  /** Delete on a selected part feature asks before deleting, like the menu entry; sketch geometry keeps its own Delete. */
  const deleteSelected = () => {
    if (!selected || sketch || curve || featureEditorOpen || newFeature || interactionState.current.locked) return false;
    setProfileId(null); setDeleteFeature(selected); return true;
  };
  const hotkeys = useRef({ pending, chainOnly, storageBusy, props, escape, leave, deleteSelected, selectEscapeGuard, referencePick: currentOwnedPick });
  hotkeys.current = { pending, chainOnly, storageBusy: storageBusy || externalWorkflowOpen, props, escape, leave, deleteSelected, selectEscapeGuard, referencePick: currentOwnedPick };
  const leaveDrawingTool = useCallback(() => hotkeys.current.leave(), []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const target = event.target;
      const current = hotkeys.current;
      const modifier = (event.ctrlKey || event.metaKey) && !event.altKey;
      // Save belongs to the app even while an unfinished edit blocks it. Never
      // let this shortcut open the browser's Save Page dialog or commit fields.
      if (modifier && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (!current.pending && !current.storageBusy && !current.props.sketchEdit) run(current.props.onSave);
        return;
      }
      if (target instanceof HTMLSelectElement && (event.key !== 'Escape' || !current.selectEscapeGuard(target))) return;
      if (event.key === 'Escape') { event.preventDefault(); if (current.referencePick) current.referencePick.onCancel(); else current.escape(); return; }
      if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA'].includes(target.tagName))) return;
      if (event.key === 'Delete' && !modifier && !current.pending && !current.storageBusy && current.deleteSelected()) { event.preventDefault(); return; }
      // A tool shortcut also works while a line chain that can be saved open is pending; the tool saves it first.
      if (!modifier && !event.altKey && !event.shiftKey && /^[a-z]$/i.test(event.key) && (!current.pending || current.chainOnly) && !current.storageBusy) {
        const tool = window.document.querySelector<HTMLButtonElement>(`.cad-command-primary-tools:not([hidden]) button[aria-keyshortcuts~="${event.key.toUpperCase()}"]`);
        if (tool && !tool.disabled && !tool.closest('[inert]')) { event.preventDefault(); tool.click(); }
        return;
      }
      if (!modifier || !['z', 'y'].includes(event.key.toLowerCase())) return;
      event.preventDefault();
      if (current.pending || current.storageBusy) return;
      if (event.key.toLowerCase() === 'z') { if (event.shiftKey ? current.props.canRedo : current.props.canUndo) run(event.shiftKey ? current.props.onRedo : current.props.onUndo); }
      else if (current.props.canRedo) run(current.props.onRedo);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const startTopologyFeature = async (purpose: 'fillet' | 'chamfer' | 'shell', explicitSelection?: CadTopologyPickSet) => {
    const source = explicitSelection ?? topologySelection;
    if (!source || !props.onResolveSelection) throw new Error(purpose === 'shell' ? 'Pick one planar face before starting an inward shell.' : 'Pick edges before starting this operation.');
    if (purpose === 'shell' && source.picks.length !== 1) throw new Error('Shell opens one face. Select a single planar face before starting an inward shell.');
    validateTopologySelection(source, { documentVersion: props.documentVersion, buildId: build?.buildId ?? null, meshes: build?.meshes ?? [], ready: topologyReady });
    const controller = new AbortController();
    topologyResolution.current = { controller, source }; setResolvingTopology(purpose); props.onWorkflowChange(true);
    try {
      const result = await props.onResolveSelection({ bodyId: source.bodyId, expectedBuildId: source.buildId, purpose, picks: source.picks }, source.documentVersion, controller.signal);
      controller.signal.throwIfAborted();
      const current = topologySource.current;
      if (topologyResolution.current?.controller !== controller || !current.ready || current.documentVersion !== source.documentVersion || current.buildId !== source.buildId
        || result.buildId !== source.buildId || result.bodyId !== source.bodyId || result.purpose !== purpose) throw new Error('The solid changed during selection conversion. Select topology again.');
      const base = { id: crypto.randomUUID(), name: `${featureLabels[purpose]} ${document.features.filter((feature) => feature.kind === purpose).length + 1}`, suppressed: false, targetId: result.bodyId };
      const feature: CadFeature = result.purpose === 'shell' ? { ...base, kind: 'shell', thickness: 1, opening: result.opening }
        : { ...base, kind: result.purpose, radius: 1, selection: result.selection };
      setNewFeature(feature); setSketchId(null); setProfileId(null); setEditorPending(false);
    } catch (cause) {
      if (!controller.signal.aborted && topologyResolution.current?.controller === controller) throw cause;
    } finally {
      if (topologyResolution.current?.controller === controller) { topologyResolution.current = null; setResolvingTopology(null); }
    }
  };
  const startFeature = (kind: CadFeature['kind'], plane?: CadPlane, source?: CadFeature) => run(() => {
    if (!source && (kind === 'fillet' || kind === 'chamfer') && topologySelection?.picks.some(pick => pick.kind !== 'edge')) {
      throw new Error('Pick edges for Fillet / Chamfer, or select the body in the tree to treat all its edges.');
    }
    if (kind === 'shell' || !source && (kind === 'fillet' || kind === 'chamfer') && topologySelection?.picks[0]?.kind === 'edge') return startTopologyFeature(kind);
    // A command opened from a feature's own menu works on that feature; otherwise a selected plane, axis or the origin feeds it.
    const draft = cadFeatureWithReference(featureDraft(kind, document, source ?? selected, currentBodyIds, bodyLineage, plane), source ? null : selectedReference, document);
    setProperties(null); setNewFeature(draft); setSketchId(null); setCurveId(null); if (kind === 'curve') setTool('path'); setProfileId(null); setEditorPending(false);
  });
  const createSketchOnPlane = (plane: CadSketchPlane) => {
    if (typeof plane !== 'string' && !document.features.some(feature => feature.id === plane.featureId && feature.kind === 'datum-plane' && cadFeatureActive(feature, document))) return;
    const feature = featureDraft('sketch', document, undefined, currentBodyIds, bodyLineage, plane);
    setPlaneSelection({ documentId: document.id, plane });
    submitEdit(signal => props.onEdit({ kind: 'add-feature', feature }, signal), () => {
      setPlaneSelection(null); setPickedTopology(null); setSelectedId(feature.id); setSketchId(feature.id); setCurveId(null); setProfileId(null); setTool('rectangle'); setError(null);
    });
  };
  const pickSketchPlane = (plane: CadSketchPlane) => {
    const owner = currentSketchPlaneRequest;
    if (!owner || planeRequestOwner.current !== owner) return;
    if (typeof plane !== 'string' && !document.features.some(feature => feature.id === plane.featureId && feature.kind === 'datum-plane' && cadFeatureActive(feature, document))) return;
    // Consume synchronously before the edit: duplicate pointer releases and old
    // callbacks cannot insert a second sketch into the accepted revision.
    planeRequestOwner.current = null; setSketchPlaneRequest(null);
    if (owner.replaceSketchId) { const replaceId = owner.replaceSketchId; run(() => moveSketchToPlane(replaceId, plane)); return; }
    run(() => createSketchOnPlane(plane));
  };
  /** Change sketch plane: the sketch lies on the picked plane, so a former plane offset is cleared. */
  const moveSketchToPlane = (sketchId: string, plane: CadSketchPlane) => {
    const index = document.features.findIndex(feature => feature.id === sketchId), source = document.features[index];
    if (source?.kind !== 'sketch') return;
    if (typeof plane !== 'string' && document.features.findIndex(feature => feature.id === plane.featureId) > index) throw new Error(`Choose a plane defined before ${source.name}.`);
    submitEdit(signal => props.onEdit({ kind: 'update-feature', feature: { ...source, plane, offset: 0 } }, signal), () => { setSelectedId(source.id); setPlaneSelection(null); });
  };
  const beginChangeSketchPlane = (feature: CadSketchFeature) => {
    if (interactionState.current.locked) return;
    setOpenFeatureId(null); setProperties(null); setSelectedId(feature.id); setProfileId(null); setPlaneSelection(null); setPickedTopology(null); setError(null);
    setSketchPlaneRequest({ document, version: props.documentVersion, replaceSketchId: feature.id });
  };
  const openProperties = (target: { readonly kind: 'body' } | { readonly kind: 'feature'; readonly featureId: string }) => {
    if (interactionState.current.locked) return;
    setOpenFeatureId(null); setProperties({ kind: target.kind === 'body' ? 'body' : 'selection' }); setInspectorCollapsed(false);
    if (target.kind === 'feature') { setSelectedId(target.featureId); setProfileId(null); }
  };
  const startSketch = () => {
    if (interactionState.current.locked) return;
    if (selectedReferencePlane) { run(() => createSketchOnPlane(selectedReferencePlane)); return; }
    setSelectedId(null); setProfileId(null); setPlaneSelection(null); setSketchPlaneRequest({ document, version: props.documentVersion }); setPickedTopology(null); setError(null);
  };
  const choose = (id: string | null) => { if (currentTopologyPick) return; if (currentSketchReferencePick) { if (id) currentSketchReferencePick.chooseSource(id); return; } if (currentRegionPick) return; if (currentReferencePick) { if (id && currentReferencePick.eligibleIds.includes(id)) currentReferencePick.onSelect(id); return; }
    if (currentSketchPlaneRequest) { const target = document.features.find(feature => feature.id === id && feature.kind === 'datum-plane' && cadFeatureActive(feature, document)); if (target) pickSketchPlane({ kind: 'datum-plane', featureId: target.id }); return; }
    if (interactionState.current.locked || props.sketchEdit && id !== props.sketchEdit.sketchId) return; setGraphPick(null); setGraphRelationCommand(null); setPlaneSelection(null); setPickedTopology(null); setSelectedId(id); setProfileId(null); if (!id) setProperties(current => current?.kind === 'selection' ? null : current); if (id !== sketchId) setSketchId(null); if (id !== curveId) setCurveId(null); if (id !== openFeatureId) setOpenFeatureId(null); setError(null); return true; };
  const openFeatureEditor = (feature: CadFeature) => { if (choose(feature.id)) setOpenFeatureId(feature.id); };
  /** Double-click intent: sketches and curves open their geometry editors, other features their settings. */
  const configureFeature = (feature: CadFeature) => {
    if (feature.kind === 'sketch') editSketch(feature); else if (feature.kind === 'curve') editCurve(feature); else openFeatureEditor(feature);
  };
  const selectReferencePlane = (plane: CadSketchPlane | null) => {
    if (currentSketchPlaneRequest) { if (plane) pickSketchPlane(plane); return; }
    if (interactionState.current.locked) return;
    if (typeof plane === 'object' && plane !== null) { const target = document.features.find(feature => feature.id === plane.featureId && feature.kind === 'datum-plane' && cadFeatureActive(feature, document)); if (target) choose(target.id); return; }
    choose(null); setPlaneSelection(plane ? { documentId: document.id, plane } : null);
  };
  const selectOriginReference = (selection: CadOriginSelection) => {
    if (currentTopologyPick || currentSketchReferencePick || currentRegionPick || currentReferencePick || currentSketchPlaneRequest || interactionState.current.locked) return;
    choose(null); setPlaneSelection({ documentId: document.id, origin: selection });
  };
  const editSketch = (feature: CadSketchFeature, owned = true) => {
    if (interactionState.current.locked) return;
    try { if (owned) props.onBeginSketchEdit?.(feature.id); }
    catch (cause) { setError(userFacingMessage(cause, 'Unable to open this sketch edit.')); return; }
    setGraphPick(null); setGraphRelationCommand(null); setPickedTopology(null); setCurveId(null); setSketchId(feature.id); setSelectedId(feature.id); setProfileId(null); setTool('select'); setProperties(null);
  };
  const beginProfileCopy = (source: CadSketchFeature, id: string) => {
    const latest = interactionState.current;
    if (latest.locked || props.sketchEdit || latest.document !== document || latest.version !== props.documentVersion
      || latest.document.features.find(feature => feature.id === source.id) !== source || !cadFeatureActive(source, latest.document)) return;
    const outline = cadSketchProfileViews(source).find(profile => profile.id === id); if (!outline) return;
    setProfileCopyPreview(null); setProfileCopyAccepted(null); setInspectorCollapsed(false); setError(null);
    setProfileCopyCommand({ token: crypto.randomUUID(), request: { sourceSketchId: source.id, profileId: id,
      newSketchId: `sketch_${crypto.randomUUID()}`, name: `${outline.name.slice(0, 155)} copy`, idPrefix: `copy_${crypto.randomUUID().replaceAll('-', '')}` } });
  };
  // The copy editor releases pending in layout cleanup; only then may the normal entry assert a closed workflow.
  useEffect(() => {
    if (!profileCopyAccepted || profileCopyCommand || pending) return;
    const accepted = profileCopyAccepted; setProfileCopyAccepted(null);
    if (storageBusy || externalWorkflowOpen || !Value.Equal(document, accepted.document)) return;
    const target = document.features.find(feature => feature.id === accepted.sketchId);
    if (target?.kind === 'sketch') editSketch(target);
  }, [profileCopyAccepted, profileCopyCommand, pending, document, storageBusy, externalWorkflowOpen]);
  const editCurve = (feature: CadCurveFeature) => { if (interactionState.current.locked || !cadFeatureActive(feature, interactionState.current.document)) return; setPickedTopology(null); setSketchId(null); setCurveId(feature.id); setSelectedId(feature.id); setProfileId(null); setTool('select'); setProperties(null); };
  const openSolidMenu = (request: CadViewportContextMenuRequest) => {
    // Over planes alone there is no target, and Select other is the one command.
    if (interactionState.current.locked || !request.target && !request.selectOther) return;
    if (!request.target) { setCanvasMenu({ kind: 'solid', document, version: props.documentVersion, buildId: build?.buildId ?? null, request }); return; }
    if (request.target.kind === 'topology') {
      try { validateTopologySelection({ documentVersion: props.documentVersion, buildId: build?.buildId ?? '', bodyId: request.target.hit.bodyId, picks: [request.target.hit.pick] },
        { documentVersion: props.documentVersion, buildId: build?.buildId ?? null, meshes: build?.meshes ?? [], ready: topologyReady }); }
      catch { return; }
    } else {
      const featureId = request.target.featureId;
      if (!document.features.some(feature => feature.id === featureId && cadFeatureActive(feature, document))) return;
    }
    setCanvasMenu({ kind: 'solid', document, version: props.documentVersion, buildId: build?.buildId ?? null, request });
  };
  const openSketchMenu = (request: CadSketchContextMenuRequest) => {
    if (interactionState.current.locked || !sketch || !request.profileId || !sketch.profiles.some(profile => profile.id === request.profileId)) return;
    setCanvasMenu({ kind: 'sketch', document, version: props.documentVersion, buildId: build?.buildId ?? null, sketchId: sketch.id, request });
  };
  /**
   * Right-click or the menu key on a dimension or relation glyph selects it first, unless it is already part of the selection. The menu
   * keeps the part, version, cancellation and the relations it opened on; a change to any of them closes it, and each command checks them again.
   */
  const openAnnotationMenu = (annotations: readonly CadSketchDimensionPick[], request: { readonly clientX: number; readonly clientY: number }) => {
    const graph = sketch?.graph;
    const picks = graph && drawnAnnotations?.graph === graph ? annotations.flatMap(item => { const pick = cadSketchDimensionPick(drawnAnnotations, item.id); return pick && sameCadSketchDimensionPick(pick, item, graph) ? [pick] : []; }) : [];
    if (interactionState.current.locked || !sketch || !graph || !picks.length || picks.length !== annotations.length) return;
    if (!picks.every(pick => graphDimensionPicks.some(item => sameCadSketchDimensionPick(item, pick, graph)))) selectGraphAnnotations(picks);
    setCanvasMenu({ kind: 'annotation', document, version: props.documentVersion, buildId: build?.buildId ?? null, sketchId: sketch.id, picks, cancel: cancelSignal, request });
  };
  const canvasMenuItems: CadContextMenuItem[] = [];
  let canvasMenuTitle = 'Body';
  if (currentCanvasMenu?.kind === 'solid') {
    const target = currentCanvasMenu.request.target;
    const id = target?.kind === 'topology' ? target.hit.bodyId : target?.kind === 'feature' ? target.featureId : null;
    const feature = document.features.find(feature => feature.id === id);
    // Select other steps through whatever lies under the pointer, planes included, so it does not need a body.
    const selectOther = currentCanvasMenu.request.selectOther;
    const selectOtherItem: CadContextMenuItem | null = selectOther
      ? { label: 'Select other', help: 'The next candidate under the pointer, faces behind included. N does the same, and Shift + N goes back.', onSelect: () => run(() => selectOther()) } : null;
    if (!feature && selectOtherItem) { canvasMenuTitle = 'Selection'; canvasMenuItems.push(selectOtherItem); }
    if (feature) {
      canvasMenuTitle = feature.name;
      if (feature.kind !== 'sketch') canvasMenuItems.push({ label: 'Edit feature', onSelect: () => openFeatureEditor(feature) });
      if (feature.kind === 'datum-plane' && cadFeatureActive(feature, document)) canvasMenuItems.push({ label: 'Section view', onSelect: () => setSectionView({ plane: { kind: 'datum-plane', featureId: feature.id } }) });
      if (feature.kind === 'sketch') canvasMenuItems.push({ label: 'Edit sketch', onSelect: () => editSketch(feature) }, { label: 'Change sketch plane', help: 'Click the new plane in the design area.', onSelect: () => beginChangeSketchPlane(feature) },
        { label: 'Pad sketch', disabled: cadSketchSourceAvailability(feature, 'extrude', document.parameters).kind === 'unavailable', onSelect: () => startFeature('extrude', undefined, feature) },
        { label: 'Revolve sketch', disabled: cadSketchSourceIssue(feature, 'revolve', document.parameters) !== null, onSelect: () => startFeature('revolve', undefined, feature) });
      else if (feature.kind === 'curve') canvasMenuItems.push({ label: 'Edit curve', onSelect: () => editCurve(feature) });
      if (currentBodyIds.includes(feature.id)) {
        if (target?.kind === 'topology' && chainsAvailable) {
          const { hit } = target, faceKey = target.faceKey ?? null;
          if (hit.pick.kind === 'edge') canvasMenuItems.push(
            { label: 'Select loop', help: 'The edges around the face under the pointer that hold this one. Double-click an edge for the same.', onSelect: () => chainTopology(hit, 'loop', false, faceKey) },
            { label: 'Select tangent chain', help: 'The edges Fillet and Chamfer treat with this one when they follow tangent edges. Alt + double-click an edge for the same.', onSelect: () => chainTopology(hit, 'tangent', false, faceKey) });
          else canvasMenuItems.push({ label: 'Select tangent faces', help: 'The faces meeting this one without a crease. Double-click a face for the same.', onSelect: () => chainTopology(hit, 'tangent', false, null) });
        }
        if (selectOtherItem) canvasMenuItems.push(selectOtherItem);
        if (target?.kind === 'topology' && props.onResolveSelection) {
          const picks: CadTopologyPickSet = { bodyId: feature.id, buildId: build?.buildId ?? '', documentVersion: props.documentVersion, picks: [target.hit.pick] };
          if (target.hit.pick.kind === 'face') canvasMenuItems.push({ label: 'Shell from face', onSelect: () => run(() => startTopologyFeature('shell', picks)) });
          else for (const kind of ['fillet', 'chamfer'] as const) canvasMenuItems.push({ label: `${featureLabels[kind]} selected edge`, onSelect: () => run(() => startTopologyFeature(kind, picks)) });
        }
        canvasMenuItems.push({ kind: 'separator' }, ...(['transform', 'linear-pattern', 'circular-pattern', 'mirror'] as const).map(kind => ({ label: featureLabels[kind], onSelect: () => startFeature(kind, undefined, feature) })));
        if (props.onSectionForCam) canvasMenuItems.push({ label: 'Section for CAM', onSelect: () => run(() => props.onSectionForCam?.(feature.id)) });
      } else if (selectOtherItem) canvasMenuItems.push(selectOtherItem);
      canvasMenuItems.push({ kind: 'separator' }, { label: 'Properties', onSelect: () => openProperties({ kind: 'feature', featureId: feature.id }) }, { label: 'Suppress feature', onSelect: () => submitEdit(signal => props.onEdit({ kind: 'update-feature', feature: { ...feature, suppressed: true } }, signal)) },
        { label: 'Delete feature', danger: true, onSelect: () => { setSelectedId(feature.id); setProfileId(null); setDeleteFeature(feature); } });
    }
  } else if (currentCanvasMenu?.kind === 'annotation') {
    const menu = currentCanvasMenu, source = sketch?.id === menu.sketchId ? sketch : undefined;
    const relation = source?.graph?.relations.find(item => item.id === menu.picks[0].id);
    // Menu commands run after the menu closes; a changed part, version, sketch or cancellation drops them.
    const current = () => interactionState.current.document === menu.document && interactionState.current.version === menu.version && interactionState.current.sketchId === menu.sketchId
      && interactionState.current.cancel === menu.cancel;
    const shown = source?.graph && relation && drawnAnnotations?.graph === source.graph && menu.picks.every(pick => isCadSketchDimensionPickCurrent(drawnAnnotations, pick)) ? source.graph : null;
    // Delete removes the selection when the menu's annotation is part of it, as Delete does on the canvas.
    const removed = shown && menu.picks.every(pick => graphDimensionPicks.some(item => sameCadSketchDimensionPick(item, pick, shown))) ? removableSelectedRelationIds(shown) : menu.picks.map(pick => pick.id);
    const deleteItem: CadContextMenuItem = { label: removed.length > menu.picks.length && shown ? `Delete ${cadSketchAnnotationCount(shown, removed)}` : 'Delete', danger: true,
      onSelect: () => { if (current()) deleteSketchAnnotations(menu.picks); } };
    if (shown && relation && !isCadSketchDimensionRelation(relation)) {
      // A glyph that draws X and Y held at 0 on one point reads as the point at the origin.
      const pair = isCadSketchOriginPair(shown, menu.picks.flatMap(pick => shown.relations.filter(item => item.id === pick.id)));
      canvasMenuTitle = pair ? CAD_SKETCH_ORIGIN_PAIR_NAME : cadSketchRelationName(shown, relation);
      canvasMenuItems.push({ label: 'Show in relations list', help: 'Scroll the relations under the sketch in the feature tree to this one.', onSelect: () => { if (current()) revealRelationRow(relation.id); } }, { kind: 'separator' }, deleteItem);
    } else if (shown && relation && isCadSketchDimensionRelation(relation)) {
      const graph = shown, reference = relation.kind === 'reference-dimension';
      const convert = (conversion: ReturnType<typeof cadSketchDimensionToReference>) => {
        if (!conversion.relation || !current()) return;
        const next = conversion.relation;
        submitEdit(signal => props.onEditMany([{ kind: 'set-sketch-relation', sketchId: menu.sketchId, relation: next }], signal), undefined, SKETCH_RELATION_FAILURE);
      };
      const toReference = reference ? null : cadSketchDimensionToReference(graph, relation);
      const drivingBlocked = reference && graphFreedom === 0 ? 'The sketch is fully defined, so a driving dimension here would over-define it. Remove a dimension or relation first.' : null;
      const toDriving = reference && !drivingBlocked ? cadSketchDimensionToDriving(graph, document.parameters, relation) : null;
      canvasMenuTitle = reference ? 'Reference dimension' : 'Dimension';
      canvasMenuItems.push({ label: 'Edit value…', disabled: reference, help: reference ? 'A reference dimension follows the geometry. Make it driving to set its value.' : undefined,
        onSelect: () => { if (current()) configureGraphRelation(relation); } });
      if (reference) canvasMenuItems.push({ label: 'Make driving', disabled: !toDriving?.relation, help: drivingBlocked ?? toDriving?.reason ?? undefined, onSelect: () => { if (toDriving) convert(toDriving); } });
      else if (toReference) canvasMenuItems.push({ label: 'Make reference', disabled: !toReference.relation, help: toReference.reason ?? undefined, onSelect: () => convert(toReference) });
      // Reset position lays the dimensions the menu acts on out automatically again, in one edit; Delete acts on the same set.
      const placed = removed.flatMap(id => {
        const item = graph.relations.find(candidate => candidate.id === id);
        return item && isCadSketchDimensionRelation(item) && 'annotation' in item && item.annotation ? [item] : [];
      });
      canvasMenuItems.push({ label: placed.length > 1 ? `Reset ${placed.length} positions` : 'Reset position', disabled: !placed.length,
        help: placed.length ? undefined : 'This dimension is already laid out automatically.',
        onSelect: () => { if (current() && placed.length) submitEdit(signal => props.onEditMany(placed.map(item => ({ kind: 'set-sketch-relation', sketchId: menu.sketchId, relation: withoutCadSketchDimensionAnnotation(item) })), signal), undefined, SKETCH_RELATION_FAILURE); } });
      canvasMenuItems.push({ kind: 'separator' }, deleteItem);
    }
  } else if (currentCanvasMenu?.kind === 'relation-row') {
    const menu = currentCanvasMenu, graph = sketch?.id === menu.sketchId ? sketch.graph : undefined, relation = graph?.relations.find(item => item.id === menu.relationId);
    const current = () => interactionState.current.document === menu.document && interactionState.current.version === menu.version && interactionState.current.sketchId === menu.sketchId
      && interactionState.current.cancel === menu.cancel;
    if (graph && relation) {
      canvasMenuTitle = cadSketchRelationName(graph, relation);
      if (isCadSketchValueRelation(relation)) canvasMenuItems.push({ label: 'Edit value…', onSelect: () => { if (current()) editSketchValue(relation.id, null); } });
      if (relation.kind === 'linear-pattern') canvasMenuItems.push({ label: 'Edit pattern', onSelect: () => { if (current()) editSketchPattern(relation.id); } },
        { label: 'Select seed', onSelect: () => { if (current()) selectGraph({ kind: 'entity', id: relation.seed.entityId }); } },
        { label: 'Detach pattern', help: 'Detach all occurrences and retain their current geometry.', onSelect: () => { if (current()) editSketchPattern(relation.id, true); } });
      else {
        const removed = selectedRelationIds.includes(relation.id) ? removableSelectedRelationIds(graph) : [relation.id];
        canvasMenuItems.push(...canvasMenuItems.length ? [{ kind: 'separator' } as const] : [], relation.kind === 'external-reference' && removed.length === 1
          ? { label: 'Detach reference', help: 'Detach this source link and retain the current geometry.', onSelect: () => { if (current()) deleteRelationRow(relation); } }
          : { label: removed.length > 1 ? `Delete ${cadSketchAnnotationCount(graph, removed)}` : 'Delete', danger: true, onSelect: () => { if (current()) deleteRelationRow(relation); } });
      }
    }
  } else if (currentCanvasMenu?.kind === 'sketch') {
    const source = document.features.find((feature): feature is CadSketchFeature => feature.kind === 'sketch' && feature.id === currentCanvasMenu.sketchId);
    const target = source && cadSketchProfileViews(source).find(profile => profile.id === currentCanvasMenu.request.profileId);
    if (source && target) {
      canvasMenuTitle = target.name;
      canvasMenuItems.push({ label: 'Copy outline to editable sketch', disabled: Boolean(props.sketchEdit), help: props.sketchEdit ? 'Finish or cancel sketch edits before copying an outline.' : undefined, onSelect: () => beginProfileCopy(source, target.id) });
      canvasMenuItems.push({ label: 'Configure profile', onSelect: () => { editSketch(source); setProfileId(target.id); setInspectorCollapsed(false); } },
        { label: 'Toggle construction', onSelect: () => submitEdit(signal => props.onEdit({ kind: 'update-feature', feature: withCadSketchProfile(source, { ...target, construction: !target.construction }) }, signal)) },
        { kind: 'separator' }, { label: 'Delete profile', danger: true, onSelect: () => deleteProfile(source, target.id) });
    }
  }
  const hasMaterial = (feature: CadSketchFeature) => cadSketchSourceIssue(feature, 'extrude', document.parameters) === null;
  const selectTopology = (incoming: CadTopologyPickSet | null, additive: boolean | 'union') => {
    if (locked) return;
    if (!incoming) { setPickedTopology(null); return; }
    validateTopologySelection(incoming, { documentVersion: props.documentVersion, buildId: build?.buildId ?? null, meshes: build?.meshes ?? [], ready: topologyReady });
    const next = mergeTopologySelection(topologySelection, incoming, additive);
    setPickedTopology(next.picks.length ? next : null); setSelectedId(incoming.bodyId);
    if (pickMode !== 'auto') setPickMode(incoming.picks[0].kind);
    setSketchId(null); setCurveId(null); setProfileId(null);  setError(null);
  };
  const changePickMode = (mode: CadPickMode) => { if (locked) return; if (mode !== pickMode) setPickedTopology(null); setPickMode(mode); };
  const latestSelectTopology = useRef(selectTopology); latestSelectTopology.current = selectTopology;
  /** Replaces the topology selection with edges or faces a box or Select other chose. */
  const setTopology = (bodyId: string, picks: readonly CadTopologyPick[]) => run(() => {
    selectTopology({ documentVersion: props.documentVersion, buildId: build?.buildId ?? '', bodyId, picks }, false);
  });
  // Each body's adjacency and each edge's tangent chain for the shown version and build, read on first use and dropped as soon as the
  // shown build or version changes or stops being ready.
  const chainReads = useRef<{ readonly key: string; readonly adjacency: Map<string, Promise<CadTopologyAdjacency>>; readonly chains: CadTangentChainReads } | null>(null);
  const chainSource = topologyReady && build?.buildId ? `${props.documentVersion}\u0000${build.buildId}` : null;
  useEffect(() => { if (chainReads.current?.key !== chainSource) chainReads.current = null; }, [chainSource]);
  /** Selects the loop or tangent chain through an edge, or the tangent faces of a face; `additive` adds them without removing any. */
  const chainTopology = (hit: CadTopologyHit, gesture: CadTopologyChainGesture, additive: boolean, faceKey: string | null) => run(async () => {
    // A menu command runs after its menu closes, so the lock and build are read now, not from the render that opened the menu.
    const readAdjacency = props.onTopologyAdjacency, readChain = props.onTopologyTangentChain, report = props.onStatusMessage;
    const { buildId, documentVersion: version, ready } = topologySource.current, cancel = interactionState.current.cancel;
    if (interactionState.current.locked || !readAdjacency || !readChain || !buildId || !ready) return;
    const ticket = ++topologyRequest.current, key = `${version}\u0000${buildId}`, signal = new AbortController().signal;
    if (chainReads.current?.key !== key) chainReads.current = { key, adjacency: new Map(), chains: new CadTangentChainReads() };
    const reads = chainReads.current;
    let chainRead: Promise<CadTopologyTangentChain> | null = null;
    const readers = {
      adjacency: () => sharedCadTopologyRead(reads.adjacency, hit.bodyId, () => readAdjacency({ bodyId: hit.bodyId, expectedBuildId: buildId }, version, signal)),
      tangentChain: (edgeKey: string) => (chainRead = reads.chains.read(`${hit.bodyId}\u0000${edgeKey}`,
        () => readChain({ bodyId: hit.bodyId, expectedBuildId: buildId, edgeKey }, version, signal))),
    };
    // A later pick, clear or chain, a cancellation, a newer build or version, or a workflow begun since makes the chain stale: it is
    // dropped, and so is its failure, rather than applied over newer work.
    const stale = () => {
      const now = topologySource.current, state = interactionState.current;
      return topologyRequest.current !== ticket || state.locked || state.cancel !== cancel || !now.ready || now.buildId !== buildId || now.documentVersion !== version;
    };
    let found: CadTopologyChainPicks | null;
    try { found = await cadTopologyChainPicks(readers, hit.pick, gesture, faceKey); } catch (cause) { if (stale()) return; throw cause; }
    if (stale() || !found) return;
    const { kind, keys, note } = found;
    // A chain the selection refuses is not kept: the next gesture reads it again.
    try { latestSelectTopology.current({ documentVersion: version, buildId, bodyId: hit.bodyId, picks: keys.map(item => ({ kind, key: item })) }, additive ? 'union' : false); }
    catch (cause) { if (chainRead) reads.chains.forget(chainRead); throw cause; }
    if (note) report?.(note, 'info');
  });
  const pickTopology = (hit: CadTopologyHit | null, additive: boolean) => run(() => {
    // A click on empty space clears the part selection like it does in body picking; an open editor keeps its feature.
    if (!hit) { selectTopology(null, false); if (!featureEditorOpen && !newFeature) { setSelectedId(null); setPlaneSelection(null); setProperties(current => current?.kind === 'selection' ? null : current); } return; }
    selectTopology({ documentVersion: props.documentVersion, buildId: build?.buildId ?? '', bodyId: hit.bodyId, picks: [hit.pick] }, additive);
  });
  const selectProfile = (id: string | null) => { if (!editorPending && !treeRenamePending) { setGraphPick(null); setGraphRelationCommand(null); setProfileId(id); setProfileCommand(null); } };
  const applyFeature = async (feature: CadFeature, parameters: Readonly<Record<string, number>>, signal?: AbortSignal, removedRelationIds?: readonly string[]) => {
    await props.onEditMany(cadFeatureCandidateEdits({ feature, isNew: Boolean(newFeature), parameters, removedRelationIds }), signal);
    signal?.throwIfAborted();
    setPickedTopology(null); setOpeningParameters(null);
    setNewFeature(null); setEditorPending(false); setSelectedId(feature.id); setOpenFeatureId(null); setError(null);
    if (feature.kind === 'sketch' && newFeature && !sketch) { setSketchId(feature.id); setTool('rectangle'); }
  };
  const addSketchGraph = (graph: CadSketchGraph, signal?: AbortSignal) => {
    if (!sketch) throw new Error('Open a sketch before drawing.');
    props.onWorkflowChange(true);
    // Drawing leaves nothing selected, so a command chosen next starts from its own picks rather than from one edge of the new shape.
    return afterCadEdit(props.onEdit({ kind: 'append-sketch-entities', sketchId: sketch.id, geometry: graph }, signal), () => {
      selectGraph(null); setError(null);
    }, signal);
  };
  const addPath = (draft: CadPathDraft, closed: boolean, signal?: AbortSignal) => {
    const graph = createCadPathDraftGraph({ draft, closed, construction, createId: () => crypto.randomUUID(), existingGraph: sketch?.graph, parameters: document.parameters });
    const inferredIds = cadPathDraftInferences(draft).map(inferred => inferred.relationId);
    if (!inferredIds.length) return addSketchGraph(graph, signal);
    // A retry without inferred relations must still extend the sketch the drawing started on.
    const base = interactionState.current;
    return appendCadSketchGraphWithInferences({ graph, inferredIds, signal, submit: next => addSketchGraph(next, signal),
      current: () => interactionState.current.version === base.version && interactionState.current.sketchId === base.sketchId,
      onDropped: (dropped, reason) => props.onStatusMessage?.(cadSketchInferenceNote(dropped, reason), 'info') });
  };
  const addFreshSketch = (drawing: CadFreshSketchDrawing, signal?: AbortSignal) => {
    if (!sketch) throw new Error('Open a sketch before drawing.');
    const created = createCadFreshSketchDrawing({ drawing, construction, createId: () => crypto.randomUUID(), existingGraph: sketch.graph, parameters: document.parameters });
    return addSketchGraph(created.geometry, signal);
  };
  const addProfile = (geometry: CadProfile, signal?: AbortSignal) => {
    if (!sketch) throw new Error('Open a sketch before drawing.');
    if (geometry.kind === 'circle' || geometry.kind === 'polygon' || geometry.kind === 'rectangle' && geometry.cornerRadius === 0) {
      return addSketchGraph(createCadFreshSketchGraph({ geometry, construction, createId: () => crypto.randomUUID() }), signal);
    }
    // A rounded rectangle or a slot is a generator, configured as its profile was; a path with arcs is kept as its lines and arcs.
    const id = crypto.randomUUID();
    props.onWorkflowChange(true);
    return afterCadEdit(props.onEditMany(cadSketchShapeEdits(sketch, geometry, { id, construction }), signal), () => {
      if (geometry.kind === 'path') selectGraph(null); else setProfileId(id);
      setError(null);
    }, signal);
  };
  const addPlugin = (plugin: CadPluginPackage) => {
    try {
      const target = sketch ?? selectedSketch ?? featureDraft('sketch', document, selected, currentBodyIds, bodyLineage);
      if (target.kind !== 'sketch') throw new Error('Plugin profiles require a sketch.');
      const id = crypto.randomUUID();
      const edits: CadEdit[] = document.features.some(feature => feature.id === target.id) ? [] : [{ kind: 'add-feature', feature: target }];
      edits.push({ kind: 'add-plugin-profile', sketchId: target.id, profileId: id, name: plugin.name, package: plugin, groupId: `pg_${crypto.randomUUID()}` });
      submitEdit(signal => props.onEditMany(edits, signal), () => {
        setPluginsOpen(false); setSketchId(target.id); setSelectedId(target.id); setProfileId(id); setTool('select');
      });
    } catch (cause) { setError(userFacingMessage(cause, 'Unable to add this plugin.')); }
  };
  const inspectParameterUsage = (usage: Pick<CadParameterUsage, 'featureId' | 'profileId' | 'inputName'>) => {
    const feature = document.features.find(feature => feature.id === usage.featureId);
    if (!feature || !cadFeatureActive(feature, document)) return;
    setSelectedId(feature.id); setCurveId(null); setPickedTopology(null);
    setInspectedInput(usage.profileId && usage.inputName ? { profileId: usage.profileId, inputName: usage.inputName } : null);
    if (feature.kind === 'sketch') { setSketchId(feature.id); setProfileId(usage.profileId ?? null); setTool('select'); }
    else { setSketchId(null); setProfileId(null); if (feature.kind === 'curve') setCurveId(feature.id); }
  };
  const inspectParameter = (name: string | null) => {
    setInspectedParameter(name); setInspectedInput(null);
  };
  const deleteSketchGeometry = (selection: CadSketchGraphSelection) => {
    if (!sketch || interactionState.current.locked) return;
    // The origin and the axes stay, as Delete leaves anything it cannot remove.
    const selections = (isCadSketchGraphSelected(graphSelections, selection) ? graphSelections : [selection]).filter(item => !isCadSketchVirtualSelection(item));
    if (!selections.length) return;
    const owners = sketch.graph && selections.map(atom => cadSketchLinearPatternForSelection(sketch.graph!, atom));
    if (owners?.some(Boolean)) {
      const owner = owners[0];
      if (!owner || owners.some(item => !item || item.relation.id !== owner.relation.id || item.index === 0)) {
        setError('Detach the pattern before deleting its seed or combining pattern and independent selections.'); return;
      }
      const omittedInstances = [...new Set([...owner.relation.omittedInstances, ...owners.map(item => item!.index)])].sort((a,b)=>a-b);
      submitEdit(signal => props.onEdit({kind:'set-sketch-relation',sketchId:sketch.id,relation:{...owner.relation,omittedInstances}},signal),()=>selectGraph(null)); return;
    }
    submitEdit(signal => props.onEdit({ kind: 'delete-sketch-elements', sketchId: sketch.id,
      pointIds: selections.filter(item => item.kind === 'point').map(item => item.id), entityIds: selections.filter(item => item.kind === 'entity').map(item => item.id), relationIds: [], cascade: true }, signal), () => selectGraph(null));
  };
  /**
   * Delete without annotations, or from the menu of a selected one, removes every selected dimension and relation; with another dimension
   * or relation glyph it removes just its relations, and only while the label or glyph still shows the relations it was drawn for. The
   * removals are one undoable batch through the same prepared edit path as the relations list, which reports a refused removal in its
   * words and keeps the selection.
   */
  const deleteSketchAnnotations = (annotations?: readonly CadSketchDimensionPick[]) => {
    const graph = sketch?.graph;
    if (!sketch || !graph || interactionState.current.locked || annotations && (!annotations.length || !annotations.every(pick => isCadSketchDimensionPickCurrent(drawnAnnotations, pick)))) return;
    const selected = !annotations || annotations.some(pick => graphDimensionPicks.some(item => sameCadSketchDimensionPick(item, pick, graph)));
    const drawn = (id: string) => drawnAnnotations?.graph === graph && cadSketchDimensionPick(drawnAnnotations, id) !== null;
    const ids = selected ? removableSelectedRelationIds(graph) : annotations.map(pick => pick.id).filter(drawn);
    if (!ids.length) return;
    submitEdit(signal => props.onEditMany(ids.map(id => ({ kind: 'remove-sketch-relation' as const, sketchId: sketch.id, relationId: id })), signal), () => {
      setGraphPick(current => current?.dimensions?.some(pick => ids.includes(pick.id)) ? null : current);
      setRelationRowPick(current => current?.relationIds.some(id => ids.includes(id)) ? null : current);
    }, SKETCH_RELATION_FAILURE);
  };
  /**
   * Delete and Backspace on a focused label, point or edge act on the selection, as they do on the canvas: Delete removes the selected
   * dimensions or geometry, Backspace the selected dimensions. Focus never selects, so what is drawn selected is what goes. The focused
   * item is removed only while nothing is selected, a label only while it still shows its dimension; a selection the key cannot remove,
   * such as the origin, an axis, a profile or geometry under Backspace, stays and nothing is removed.
   */
  const deleteFromFocus = (focused: { readonly annotations: readonly CadSketchDimensionPick[] } | { readonly geometry: CadSketchGraphSelection }, key: 'Delete' | 'Backspace') => {
    if (graphDimensionPicks.length || relationRowIds.length) deleteSketchAnnotations();
    else if (graphSelections.length) { if (key === 'Delete') deleteSketchGeometry(graphSelections[graphSelections.length - 1]); }
    else if (profileId) return;
    else if ('annotations' in focused) deleteSketchAnnotations(focused.annotations);
    else deleteSketchGeometry(focused.geometry);
  };
  const removeSelected = () => {
    if (graphSelections.length) { deleteSketchGeometry(graphSelections[0]); return; }
    if (sketch && profile) { submitEdit(signal => props.onEdit({ kind: 'update-feature', feature: withoutCadSketchProfile(sketch, profile.id) }, signal), () => setProfileId(current => current === profile.id ? null : current)); return; }
    if (selected) setDeleteFeature(selected);
  };
  const closeSketchView = () => { setOffsetCommand(null); setAreaRepair(null); setFinishRemovals(null); setSketchId(null); setProfileId(null); setGraphPick(null); setGraphRelationCommand(null); setTool('select'); };
  // The form can disappear when Finish releases its draft. Keep navigation with the stable workspace;
  // the authoritative finish operation already guards cancellation before committing the part.
  // A Finish that would remove relations from later sketches as their generators regenerate asks first, as the parameter editor does,
  // and the draft stays open until Apply confirms them.
  const askFinishRemovals = (cause: unknown, repairs?: CadSketchAreaRepairs) => {
    const removals = cadGeneratorRemovals(cause);
    if (!removals) return false;
    setAreaRepair(null); setFinishRemovals({ document, version: props.documentVersion, removals, ...repairs ? { repairs } : {} }); setInspectorCollapsed(false);
    return true;
  };
  const finishSketchWithAreas = (repairs: CadSketchAreaRepairs, signal: AbortSignal): CadEditCompletion =>
    Promise.resolve(afterCadEdit(props.sketchEdit!.finish(signal, repairs), closeSketchView)).catch(cause => { if (!askFinishRemovals(cause, repairs)) throw cause; });
  const confirmFinishRemovals = (confirmation: NonNullable<typeof finishRemovals>) => {
    setFinishRemovals(null);
    submitEdit(signal => props.sketchEdit!.finish(signal, confirmation.repairs, confirmation.removals.relationIds), closeSketchView, undefined, cause => askFinishRemovals(cause, confirmation.repairs));
  };
  const finishSketch = () => {
    if (chainOnly) { drawingControls.current?.finishChain(() => setFinishAfterChain(true)); return; }
    if (props.sketchEdit) {
      try {
        const inspection = props.sketchEdit.inspectAreaRepairs();
        if (inspection) { setAreaRepairReady(false); setAreaRepair({ document, inspection }); setTool('select'); setGraphPick(null); setProfileId(null); setInspectorCollapsed(false); return; }
      } catch (cause) { setError(userFacingMessage(cause, 'Correct the sketch before choosing replacement areas.')); return; }
      submitEdit(signal => props.sketchEdit!.finish(signal), closeSketchView, undefined, cause => askFinishRemovals(cause));
    }
    else closeSketchView();
  };
  useEffect(() => { if (finishAfterChain && !pending) { setFinishAfterChain(false); finishSketch(); } });
  const cancelSketchEdit = () => { cancel(); props.sketchEdit?.cancel(); closeSketchView(); };
  const finishCurve = () => { setCurveId(null); setTool('select'); };
  const addCurve = (segments: readonly CadPathSegment[], signal?: AbortSignal) => {
    if (!curveCreation) throw new Error('Start a new Curve before finishing its geometry.');
    props.onWorkflowChange(true);
    return afterCadEdit(props.onEdit({ kind: 'add-feature', feature: { ...curveCreation, segments } }, signal), () => {
      setNewFeature(null); setSelectedId(curveCreation.id); setCurveId(curveCreation.id); setSketchId(null); setTool('select'); setDrawingPending(false); setEditorPending(false); setError(null);
    }, signal);
  };
  viewportBindings.current = {
    document, documentVersion: props.documentVersion, dirty, selectedFeatureId: selected?.id ?? null, selectedProfileId: profile?.id ?? null,
    selectedSketchGeometrySet: graphSelections,
    sketchId: sketch?.id ?? null, curveId: curve?.id ?? null, selectedReferencePlane, ...(selectedOrigin ? { selectedOrigin } : {}), section: partView.section, setSection: setSectionView, awaitingSketchPlane: Boolean(currentSketchPlaneRequest), workflowOpen: pending || externalWorkflowOpen, busy: storageBusy, buildVersion: props.buildVersion,
    buildState, visibleBodyIds: currentBodyIds, visibleReferenceIds, visibleReferencePlanes, rendered: renderedControls.current,
    buildId: topologyReady ? build?.buildId ?? null : null, pickMode, topologySelection, meshes: build?.meshes ?? [],
    selectFeature: choose, selectReferencePlane,
    // Agent view navigation does not claim an exclusive human draft. Agent edits stay full-part atomic batches.
    editSketch: (id) => { const target = document.features.find((feature) => feature.kind === 'sketch' && feature.id === id); if (target?.kind === 'sketch') editSketch(target, false); },
    editCurve: (id) => { const target = document.features.find((feature) => feature.kind === 'curve' && feature.id === id); if (target?.kind === 'curve') editCurve(target); },
    selectProfile, selectSketchGeometrySet: selectGraphSet, finishSketch, finishCurve,
    selectTopology, setPickMode: changePickMode,
    updateView: (action) => flushSync(action),
  };
  // Only the open delete dialog lists the features a delete takes with it.
  const dependentNames: string[] = [];
  if (deleteFeature) {
    const deletingIds = new Set([deleteFeature.id]);
    for (const feature of document.features) if (cadFeatureDependencies(feature).some((id) => deletingIds.has(id))) deletingIds.add(feature.id);
    for (const feature of document.features) if (deletingIds.has(feature.id) && feature.id !== deleteFeature.id) dependentNames.push(feature.name);
  }
  /** A shortcut presses the visible tool itself, so it keeps every disabled and workflow guard. */
  const toolButton = (label: string, Icon: WorkbenchIconComponent, action: () => void, disabled = false, active = false, hint?: string, shortcut?: string) => <Button className={`cad-tool ${active ? 'is-active' : ''}`} title={`${hint ?? label}${shortcut ? ` (${shortcut.split(' ').join(' or ')})` : ''}`} aria-label={label} aria-keyshortcuts={shortcut} disabled={disabled || storageBusy} aria-pressed={active} onClick={action}><Icon size={15} /><span>{label}</span></Button>;
  /** A tool switch first saves a pending line chain open; a rejected save keeps Line and its draft for correction. */
  const chooseTool = (next: SketchTool) => {
    const apply = () => { setTool(next); if (next !== 'select') { setProfileId(null); setGraphPick(null); } };
    if (chainOnly) drawingControls.current?.finishChain(apply); else apply();
  };
  const drawingToolButton = (kind: Exclude<SketchTool, 'select' | 'trim' | 'path'>, label: string, Icon: WorkbenchIconComponent, hint: string | undefined, shortcut: string) =>
    toolButton(label, Icon, () => chooseTool(kind), toolsLocked, tool === kind || kind === 'line' && tool === 'path', hint, shortcut);
  const beginProfileCommand = (kind: CadSketchProfileCommand['kind']) => {
    if (locked || !profile || profile.geometry.kind === 'plugin') return;
    setTool('select'); setInspectorCollapsed(false); setProfileCommand({ token: ++profileCommandSequence.current, documentId: document.id, profileId: profile.id, kind });
  };
  const openGraphMove = (selections: readonly CadSketchGraphSelection[]) => {
    selectGraphSet(selections);
    setTool('select'); setGraphRelationCommand({ kind: 'move', token: crypto.randomUUID() }); setInspectorCollapsed(false);
  };
  const beginSketchMove = () => {
    if (locked) return;
    if (!graphGeometry.length) { beginProfileCommand('move'); return; }
    openGraphMove(graphGeometry);
  };
  const beginSketchPlacement = () => {
    if (!sketch?.graph || !graphGeometry.length || pendingOtherCommands || drawingPending || storageBusy || externalWorkflowOpen) return;
    setTool('select'); setGraphRelationCommand(null); setPlacementInteraction(null);
    setPlacementCommand({sketchId:sketch.id,selections:graphGeometry,token:crypto.randomUUID()}); setInspectorCollapsed(false);
  };
  const openedAt = openingProfile?.profileId === profile?.id ? openingProfile : null;
  const exactProfileEditor = profile && sketch ? <CadProfileEditor onPrepareEdits={props.onPrepareEdits} onPreviewDocument={publishSketchPreview} key={`${profile.id}-${cancelSignal}${openedAt ? `-${openedAt.token}` : ''}`} profile={profile} initialGeometry={openedAt?.geometry} document={document} onInspectInput={inspectInput} onPreviewProfile={setProfilePreview} onPreviewParameters={setPreviewParameters} onApply={async (next, parameters, signal, removedRelationIds) => {
    await props.onEditMany(cadSketchProfileEdits(sketch, next, parameters, removedRelationIds), signal); signal?.throwIfAborted(); setEditorPending(false); setOpeningProfile(null);
  }} onCancel={cancel} onPendingChange={setEditorPending} /> : null;
  // A generator's shape is configured by the exact editor alone: the profile panel's dimensions belong to saved profiles.
  const selectedProfileEditor = profile && sketch && profile.geometry.kind !== 'plugin' && !cadSketchProfileGenerator(sketch, profile.id) ? <CadSketchProfilePanel key={`${profile.id}-${cancelSignal}`} document={document} sketch={sketch} profile={profile} command={profileCommand} onCommandConsumed={token => setProfileCommand(current => current?.token === token ? null : current)} otherEditorPending={editorPending} onEditMany={props.onEditMany} onPendingChange={setEditorPending} onPreviewProfile={setProfilePreview} onPreviewParameters={setPreviewParameters} onPrepareEdits={props.onPrepareEdits} onPreviewDocument={publishSketchPreview} interactionLocked={sketchEditorLocked} cancelSignal={cancelSignal} exactGeometryEditor={profile.geometry.kind === 'polygon' || profile.geometry.kind === 'path' ? exactProfileEditor : undefined} /> : exactProfileEditor;
  const propertyRows = useMemo(() => currentProperties ? cadPropertySummary(document, currentProperties.kind === 'body' || !propertiesFeature ? { kind: 'body' } : { kind: 'feature', feature: propertiesFeature }, displayedMeshes, feature => cadPlacementLabel(feature.plane, document.features)) : [], [currentProperties, propertiesFeature, document, displayedMeshes]);
  const propertiesView = currentProperties && <div className="cad-property-form cad-properties-summary">
    {currentProperties.kind === 'body' || !propertiesFeature ? <>
      <CadInspectorTitle>Part<small>{document.name}</small></CadInspectorTitle>
      {/* The part is renamed here, as in CATIA's part Properties; Enter or leaving the field saves, Escape restores. */}
      <label className="cad-field"><span>Name</span><Input className="cad-document-name" aria-label="Part name" value={nameDraft} disabled={Boolean(props.sketchEdit || currentDimensionPicks) || commandSubmission.applying || drawingPending || editorPending || parameterPending || dimensionPending || newFeature !== null || deleteFeature !== null || resolvingTopology !== null || storageBusy || Boolean(currentSketchPlaneRequest || currentReferencePick)} onChange={(event) => { setNameDraft(event.target.value); setNamePending(event.target.value !== document.name); }} onBlur={(event) => { if (event.relatedTarget instanceof HTMLElement && event.relatedTarget.hasAttribute('data-cad-panel-resizer')) return; if (nameDraft !== document.name) submitEdit(signal => props.onEdit({ kind: 'rename-document', name: nameDraft }, signal), () => setNamePending(false)); }} onKeyDown={(event) => { if (event.nativeEvent.isComposing) return; if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); commandSubmission.cancel(); setNameDraft(document.name); setNamePending(false); } }} /></label>
    </> : <CadInspectorTitle>{propertiesFeature.name}<small>{featureLabels[propertiesFeature.kind]}</small></CadInspectorTitle>}
    <dl className="cad-properties-list">{propertyRows.map(row => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>
  </div>;
  const sketchDimensionAvailable = profile && cadSketchDimensionQuantities(profile.geometry).some(quantity => !inspectCadSketchDimensions(profile, document.parameters).some(dimension => dimension.field === (quantity === 'diameter' ? 'radius' : quantity)));
  const dimensionPickTargets = useMemo(() => sketch?.graph ? cadSketchDimensionPickTargets(sketch.graph) : NO_DIMENSION_PICK_TARGETS, [sketch]);
  const canPickDimension = Boolean(dimensionPickTargets.entityIds.length || dimensionPickTargets.pointIds.length);
  /**
   * The toolbar button and D start the tool, on the selected geometry and plane references when they are picks it takes, and end it when it is
   * on. A selected profile with a dimension to add opens that profile's dimension command instead.
   */
  const beginSketchDimension = () => {
    if (dimensionToolOwner.current) { if (!locked) endDimensionTool(); return; }
    if (locked || !sketch) return;
    if (sketchDimensionAvailable && !graphSelections.length) { beginProfileCommand('dimension'); return; }
    startDimensionTool(preselectedDimensionOperands(graphSelections));
  };
  const graphContextMenu = (selections: readonly CadSketchGraphSelection[]): readonly CadContextMenuItem[] => {
    const graph = sketch?.graph;
    if (!graph || !sketch || !selections.length) return [];
    const sourceSketchId = sketch.id;
    const dimensionStart = preselectedDimensionOperands(selections), geometry = selections.filter(atom => !isCadSketchVirtualSelection(atom));
    const moveLock = geometry.length ? geometry.map(atom => cadSketchOwnedGeometryLockReason(graph, atom) ?? cadSketchExternalReferenceLockReason(graph, atom)).find(Boolean) : cadSketchFixedElementError().message;
    const act = (action: () => void) => {
      const current = interactionState.current;
      if (current.locked || current.document !== document || current.version !== props.documentVersion || current.sketchId !== sourceSketchId) return;
      action();
    };
    const scopeHelp = selections.length === 1 ? `Use this ${selections[0].kind === 'point' ? 'point' : 'edge'}.` : `Use the ${selections.length} selected points and edges.`;
    return [
      { label: 'Dimension', disabled: !dimensionStart.length, help: dimensionStart.length ? `${scopeHelp} Then click where the dimension goes.` : 'Choose one eligible point or edge, or two points, lines, arcs or circles. Linked and generated edges retain their owners.',
        onSelect: () => act(() => { if (dimensionStart.length) startDimensionTool(dimensionStart); }) },
      { label: 'Constraints and dimensions', help: `${scopeHelp} List, edit or remove what constrains it, under the sketch in the feature tree.`, onSelect: () => act(() => {
        selectGraphSet(selections); setRelationListScope(geometry.length ? { documentId: document.id, sketchId: sourceSketchId, selection: geometry } : null); revealRelationRow(null);
      }) },
      { label: 'Move selection', disabled: Boolean(moveLock), help: moveLock ?? `${scopeHelp} Keep existing dimensions and relations.`, onSelect: () => act(() => { if (!moveLock) openGraphMove(geometry); }) },
      ...relationMenuItems(graph, sourceSketchId, selections, act),
    ];
  };
  const dimensionOperands = currentDimensionPicks?.operands ?? NO_DIMENSION_OPERANDS;
  // The plan measures every dimension the picks can take once per pick, so moving the pointer only lays out the preview again.
  const dimensionPlan = useMemo(() => sketch?.graph && dimensionOperands.length
    ? planCadSketchDimension(sketch.graph, document.parameters, dimensionOperands, () => crypto.randomUUID(), dimensionPickTargets.sizedEntityIds) : NO_SKETCH_DIMENSION_PLAN,
  [sketch, document.parameters, dimensionOperands, dimensionPickTargets]);
  const dimensionEligibility = useMemo(() => currentDimensionTool && sketch?.graph ? cadSketchDimensionPickEligibility(sketch.graph, dimensionPickTargets, dimensionOperands) : null,
    [currentDimensionTool, sketch, dimensionPickTargets, dimensionOperands]);
  /** Selected geometry and plane references as picks the tool can start from, in that order, or none when they are not picks it takes. */
  const preselectedDimensionOperands = (selections: readonly CadSketchGraphSelection[]) => sketch?.graph
    ? cadSketchDimensionPreselection(sketch.graph, dimensionPickTargets, selections) : NO_DIMENSION_OPERANDS;
  /** The picks are the selection while they wait, and belong to this document version. */
  const showDimensionPicks = (session: DimensionToolSession<typeof graphPick>, operands: readonly CadSketchDimensionOperand[]) => {
    const next = Object.freeze({ ...session, picks: operands.length ? Object.freeze({ document, version: props.documentVersion, operands }) : null });
    dimensionToolOwner.current = next; setDimensionTool(next); setError(null);
    setGraphPick(operands.length ? { sketchId: session.sketchId, selections: operands } : null);
    if (operands.length) props.onWorkflowChange(true);
  };
  /** Placing, choosing a relation or reusing an existing dimension leaves the tool on with no picks; `placed` becomes the selection. */
  const settleDimension = (session: DimensionToolSession<typeof graphPick>, placed: DimensionToolSession<typeof graphPick>['placed']) => {
    const next = Object.freeze({ ...session, picks: null, placed });
    dimensionToolOwner.current = next; setDimensionTool(next); setGraphPick(null);
  };
  /**
   * The toolbar button, D, a preselection and the geometry menu start the tool here, on picks or none. It closes the sketch commands that
   * would end it and keeps the selection and profile it started from, which come back when it ends without placing anything.
   */
  const startDimensionTool = (operands: readonly CadSketchDimensionOperand[]) => {
    if (!sketch?.graph) return;
    setTool('select'); setConstraintToolRequest(null); setGraphRelationCommand(null); setProfileId(null); setProfileCommand(null);
    setOffsetCommand(null); setMirrorCommand(null); setMirrorInteraction(null); setPlacementCommand(null); setPlacementInteraction(null); setPatternCommand(null); setPatternInteraction(null);
    setSketchReferenceCommand(null); setSketchReferenceInteraction(null); setProfileCopyCommand(null); setProfileCopyPreview(null);
    dimensionPointer.set(null);
    showDimensionPicks({ id: crypto.randomUUID(), documentId: document.id, sketchId: sketch.id, previousGraphPick: graphPick, previousProfileId: profileId, placed: null, picks: null }, operands);
  };
  /** Escape stops a placement or drops the picks; with neither, the shared Escape leaves the tool for Select. */
  const escapeDimensionTool = () => {
    const session = dimensionToolOwner.current;
    if (!session || !commandSubmission.applying && !session.picks) return false;
    if (commandSubmission.applying) commandSubmission.cancel();
    else showDimensionPicks(session, NO_DIMENSION_OPERANDS);
    return true;
  };
  /**
   * Places the dimension the picks preview at the pointer, or the form a menu names, driving or as a reference, in one edit through the
   * prepared edit path, so it is one undo step. A driving dimension that preparation rejects as over-defining is placed as its reference
   * instead when it has one; otherwise the rejection stands in its own words and the picks stay. A quantity that a dimension already measures
   * moves that dimension to the pointer and selects it. Each dimension is stored where the preview drew it, from the same placement of the
   * same relations: its line or arc through the pointer, one the click also places stepped clear of it, and an existing or reused one in the
   * sector or side it measures. The edit checks the tool, document, version and sketch before each attempt, so a stale placement never applies.
   */
  const placeDimension = (choice: { readonly form?: CadSketchDimensionForm; readonly reference?: boolean; readonly pointer?: Point2 | null } = {}) => {
    const session = dimensionToolOwner.current, picks = currentDimensionPicks, graph = sketch?.graph;
    if (!session || !picks || session.picks !== picks || !sketch || !graph || commandSubmission.applying) return;
    const pointer = choice.pointer === undefined ? dimensionPointer.get() : choice.pointer, scale = dimensionPointer.scale(), parameters = document.parameters;
    // What is placed is what the preview shows at the pointer; before the pointer has been over the canvas, Enter places the automatic layout.
    const place = (relations: readonly CadSketchGraphRelation[]) => pointer && scale ? placeCadSketchDimensions(graph, parameters, relations, pointer, scale).relations : relations;
    const sourceSketchId = sketch.id;
    const current = () => {
      const state = interactionState.current;
      return dimensionToolOwner.current?.id === session.id && state.document === picks.document && state.version === picks.version && state.sketchId === sourceSketchId;
    };
    const candidate = choice.form ? dimensionPlan.candidates.find(item => item.form === choice.form) ?? null : cadSketchDimensionCandidateAt(dimensionPlan, pointer);
    if (!candidate) return;
    // A blocked driving form whose quantity a reference still measures, such as a zero distance, places only as that reference.
    if (candidate.state === 'blocked' && !(choice.reference && candidate.reference)) { setError(candidate.reason); return; }
    if (candidate.state === 'existing') {
      const picks = candidate.relationIds.flatMap(id => drawnDimensions ? cadSketchDimensionPick(drawnDimensions, id) ?? [] : []);
      const settle = () => { const owner = dimensionToolOwner.current; if (owner?.id !== session.id) return; settleDimension(owner, { picks, selected: false }); props.onStatusMessage?.(candidate.reason, 'info'); };
      // An existing dimension moves to the pointer as one edit of its placement alone, which solves nothing.
      const existing = cadSketchDimensionBatchAt(dimensionPlan, candidate, pointer).moved ?? NO_SKETCH_RELATIONS, moved = place(existing).filter((relation, index) => relation !== existing[index]);
      if (!moved.length) { settle(); return; }
      submitEdit(signal => {
        if (signal.aborted || !current()) throw new Error('The sketch changed before the dimension was placed. Pick the geometry again.');
        return applyCanvasEdits(moved.map(relation => ({ kind: 'set-sketch-relation' as const, sketchId: sourceSketchId, relation })), signal);
      }, settle, 'The dimension could not be placed.');
      return;
    }
    const reference = candidate.reference ?? null;
    if (choice.reference && !reference) return;
    // What a click adds and the relation it reuses are the preview's; an angle measures the sector the pointer is in.
    const first = cadSketchDimensionBatchAt(dimensionPlan, candidate, pointer, Boolean(choice.reference));
    if (!first.added) { setError(first.reason); return; }
    // A reused relation stays and is selected with what the placement adds, when it is a dimension: the placement adds only the implied relation that
    // keeps a reused dimension measuring the picks.
    const reused = first.moved[0] ?? null, plannedImplied = candidate.state === 'available' ? candidate.implied : null;
    const keepsReused = Boolean(reused) && first.added.every(relation => relation.id === plannedImplied);
    let placed: readonly CadSketchGraphRelation[] = NO_SKETCH_RELATIONS, referenced = false, fellBack = false, added = false;
    submitEdit(async signal => {
      let relations: readonly CadSketchGraphRelation[] = first.added, implied = choice.reference ? null : plannedImplied;
      referenced = Boolean(choice.reference);
      for (;;) {
        if (signal.aborted || !current()) throw new Error('The sketch changed before the dimension was placed. Pick the geometry again.');
        // The reused dimension moves to the click with what it adds, as one placement; one whose implied relation the sketch already holds needs no other edit.
        const moving = reused && !referenced ? [reused] : NO_SKETCH_RELATIONS, batch = place([...relations, ...moving]);
        const moved = batch.slice(relations.length).filter((relation, index) => relation !== moving[index]);
        if (!relations.length && !moved.length) { placed = reused ? [reused] : NO_SKETCH_RELATIONS; return; }
        try {
          await applyCanvasEdits([...batch.slice(0, relations.length), ...moved].map(relation => ({ kind: 'set-sketch-relation' as const, sketchId: sourceSketchId, relation })), signal);
          placed = referenced || !reused ? relations : [reused, ...relations]; added = relations.length > 0; return;
        } catch (cause) {
          if (signal.aborted || !(cause instanceof CadSketchPreparationError)) throw cause;
          // A rejected preparation leaves no history, so the attempt that applies is the only undo step.
          const retry = cadSketchDimensionRetry(cause.feedback, { implied, reference: referenced, hasReference: Boolean(reference) });
          if (retry === 'without-implied') { relations = relations.filter(relation => relation.id !== implied); implied = null; }
          else if (retry === 'reference' && reference) { relations = [reference]; implied = null; referenced = true; fellBack = true; }
          else throw cause;
        }
      }
    }, () => {
      const owner = dimensionToolOwner.current, relations = placed;
      if (owner?.id !== session.id || !relations.length) return;
      // Only dimensions are selected, and each is drawn.
      const picks = relations.filter(isCadSketchDimensionRelation).map(cadSketchDimensionPickOf);
      settleDimension(owner, { picks, selected: false });
      if (fellBack) props.onStatusMessage?.(DIMENSION_REFERENCE_STATUS, 'info');
      else if (keepsReused && !referenced) props.onStatusMessage?.(added ? DIMENSION_REUSED_STATUS : CAD_SKETCH_DIMENSION_EXISTING_REASON, 'info');
    }, 'The dimension could not be placed.');
  };
  // Placed dimensions become the selection once the sketch holds them, so Enter or a double-click opens an editor and Delete removes them.
  // Only those the canvas draws are selected; one it cannot draw stays in the relations list.
  useLayoutEffect(() => {
    const session = currentDimensionTool, placed = session?.placed, graph = sketch?.graph;
    if (!session || !placed?.picks.length || placed.selected || !graph || !placed.picks.every(pick => isCadSketchDimensionInGraph(graph, pick))) return;
    const picks = Object.freeze(placed.picks.filter(pick => isCadSketchDimensionPickCurrent(drawnDimensions, pick)));
    setGraphPick(picks.length ? { sketchId: session.sketchId, selections: NO_SKETCH_SELECTIONS, dimensions: picks } : null);
    setDimensionTool(current => current === session ? { ...current, placed: { ...placed, picks, selected: true } } : current);
  }, [currentDimensionTool, sketch, drawnDimensions]);
  /** Picking the same line, or an arc or circle with a size, again places its own dimension; after two picks a click anywhere places. */
  const pickDimensionOperand = (operand: CadSketchDimensionOperand) => {
    const session = dimensionToolOwner.current;
    if (!session || session !== currentDimensionTool || !dimensionEligibility || commandSubmission.applying) return;
    const operands = currentDimensionPicks?.operands ?? NO_DIMENSION_OPERANDS, first = operands[0];
    if (operands.length === 1 && operand.kind === 'entity' && first.kind === 'entity' && first.id === operand.id) { placeDimension(); return; }
    if (cadSketchDimensionPickAllowed(dimensionEligibility, operand)) showDimensionPicks(session, [...operands, operand]);
  };
  /**
   * A click on empty space or Enter places the previewed dimension. Without picks a click on empty space clears the selection, and Enter opens
   * the editor of the one selected dimension, as it does on the dimension's label.
   */
  const confirmDimension = (source: 'pointer' | 'key') => {
    const session = dimensionToolOwner.current;
    if (!session || session !== currentDimensionTool) return;
    if (currentDimensionPicks) { if (dimensionPlan.candidates.length) placeDimension(); return; }
    if (source === 'pointer') { setGraphPick(null); return; }
    // The last placement can select both coordinates of a point; Enter edits the first.
    const only = (graphDimensionPicks.length === 1 || shownPlacement) && !graphSelections.length ? graphDimensionPicks[0] : null;
    const relation = only ? sketch?.graph?.relations.find(item => item.id === only.id) : undefined;
    if (relation && isCadSketchDimensionRelation(relation)) configureGraphRelation(relation);
  };
  /**
   * Right-click or the menu key while picks wait: their reference form, every dimension they take, then the geometric relations that fit them.
   * Each command keeps the pointer position the menu opened at and runs only while the tool, picks, document, version and sketch are the ones
   * it opened on. Commands that do not apply stay listed, disabled, with their reason.
   */
  const dimensionMenu = (pointer: Point2 | null): { readonly title: string; readonly items: readonly CadContextMenuItem[] } | null => {
    const session = dimensionToolOwner.current, picks = currentDimensionPicks, graph = sketch?.graph;
    if (!session || session !== currentDimensionTool || !picks || !graph || !sketch) return null;
    const sourceSketchId = sketch.id, shown = cadSketchDimensionCandidateAt(dimensionPlan, pointer);
    const owned = () => {
      const current = interactionState.current;
      return dimensionToolOwner.current?.id === session.id && dimensionToolOwner.current.picks === picks && current.document === picks.document && current.version === picks.version && current.sketchId === sourceSketchId;
    };
    const items: CadContextMenuItem[] = [];
    if (shown) {
      // A reference is judged on its own: a zero distance has no driving form, but its reference still measures it.
      const reference = shown.state === 'existing' ? null : shown.reference ?? null;
      items.push({ label: 'Place as reference', disabled: !reference,
        help: reference ? 'Place this dimension as a reference, which follows the geometry.' : shown.state === 'available' ? shown.referenceReason ?? undefined : shown.reason,
        onSelect: () => { if (owned()) placeDimension({ form: shown.form, reference: true, pointer }); } });
      for (const candidate of dimensionPlan.candidates) items.push({ label: candidate.label, disabled: candidate.state === 'blocked', help: candidate.state === 'available' ? undefined : candidate.reason,
        onSelect: () => { if (owned()) placeDimension({ form: candidate.form, pointer }); } });
    }
    // The relations the picks take, as the icon row would offer them on the same selection.
    const relations = cadSketchSelectionRelationActions(graph, picks.operands);
    if (relations.length) items.push(...items.length ? [{ kind: 'separator' as const }] : [], ...relations.map(action => ({
      label: relationMenuLabel(action), disabled: action.state === 'blocked', help: action.help,
      onSelect: () => {
        if (!owned() || action.state === 'blocked' || commandSubmission.applying) return;
        applySketchEdits(relationOfferEdits(graph, sourceSketchId, action.offer), () => { const owner = dimensionToolOwner.current; if (owner?.id === session.id) settleDimension(owner, owner.placed); });
      } })));
    return items.length ? { title: 'Dimension', items } : null;
  };
  const dimensionActions = useRef({ pick: pickDimensionOperand, confirm: confirmDimension, escape: escapeDimensionTool, menu: dimensionMenu });
  dimensionActions.current = { pick: pickDimensionOperand, confirm: confirmDimension, escape: escapeDimensionTool, menu: dimensionMenu };
  /** The last placement while it is the selection and no picks wait, which Enter then edits. */
  const lastPlacement = currentDimensionTool?.placed;
  const shownPlacement = lastPlacement && !dimensionOperands.length && lastPlacement.picks.length && graphDimensionPicks.length === lastPlacement.picks.length
    && lastPlacement.picks.every((pick, index) => sameCadSketchDimensionPick(graphDimensionPicks[index], pick, sketch?.graph)) ? lastPlacement : undefined;
  /** The status line names the next step: what to pick, what a click or Enter places, and that right-click offers more. */
  const dimensionLabel = (() => {
    if (!currentDimensionTool) return '';
    const first = dimensionOperands[0], usable = dimensionPlan.candidates.filter(candidate => candidate.state !== 'blocked');
    if (!first) return !shownPlacement ? 'Dimension · Choose a line, arc, circle, point, the origin or an axis'
      : shownPlacement.picks.length > 1 ? 'Dimensions placed · Enter edits the first, or double-click one to edit it; choose geometry for the next one'
        : 'Dimension placed · Enter or double-click edits it; choose geometry for the next one';
    const line = first.kind === 'entity' && sketch?.graph?.entities.find(entity => entity.id === first.id)?.kind === 'line';
    if (!dimensionPlan.candidates.length) return isCadSketchVirtualSelection(first) ? `Dimension · Choose a point, a line, an arc or a circle to dimension from ${cadSketchVirtualSubject(first.id)}`
      : first.kind === 'point' ? 'Dimension · Choose a second point, a line, an arc, a circle, the origin or an axis'
        : line ? 'Dimension · Choose a second line, a point, a curve or an axis to dimension from this line'
          : 'Dimension · Choose a point, a line, another curve, the origin or an axis for a distance from its center';
    // With nothing to place, give the reason of the form a click or Enter tries, so the status message after either one matches.
    const tried = cadSketchDimensionCandidateAt(dimensionPlan, null), blocked = tried?.state === 'blocked' ? tried : null;
    if (!usable.length) return `Dimension · ${blocked?.reason ?? 'These picks cannot take a dimension.'}${blocked?.reference ? ' · Right-click to place it as a reference' : ''}`;
    const shown = usable.find(candidate => candidate.form === dimensionPlan.defaultForm) ?? usable[0];
    const name = dimensionPlan.pair ? 'Distance' : shown.label;
    // One line places its length wherever the pointer is; its horizontal and vertical distances are in the menu. Picks that only find
    // dimensions the sketch has move them, and an angle keeps its own sector.
    const how = usable.every(candidate => candidate.state === 'existing') ? shown.form === 'angle' ? '; this moves the existing angle within its own sector' : '; this moves the existing dimension'
      : !dimensionPlan.pair ? shown.form === 'angle' ? '; the pointer chooses the angle' : line && dimensionOperands.length === 1 ? '; right-click for its horizontal or vertical distance' : ''
      : '; the pointer side chooses aligned, horizontal or vertical';
    const next = dimensionOperands.length > 1 ? ' · Right-click for more' : line ? ' · Or choose a second line, a point, a curve or an axis' : ' · Or choose a point, a line, another curve, the origin or an axis';
    return `${name} · Click or press Enter to place${how}${next}`;
  })();
  const dimensionGeometryPick = useMemo<CadSketchGeometryPick | undefined>(() => {
    if (!currentDimensionTool || !dimensionEligibility) return undefined;
    return {
      eligibleEntityIds: dimensionEligibility.entityIds, eligiblePointIds: dimensionEligibility.pointIds,
      label: dimensionLabel, escapeLabel: dimensionOperands.length ? 'Escape drops the picks' : 'Escape returns to Select',
      pointer: dimensionPointer, dimensionPreview: dimensionPlan.candidates.length ? dimensionPlan : undefined, dimensionsInteractive: !dimensionOperands.length, placed: shownPlacement,
      contextMenu: pointer => dimensionActions.current.menu(pointer ? { x: pointer.x, y: pointer.y } : null),
      onPick: selection => dimensionActions.current.pick(selection),
      onConfirm: source => dimensionActions.current.confirm(source),
      onCancel: () => { if (!dimensionActions.current.escape()) leaveDrawingTool(); }
    };
  }, [currentDimensionTool, dimensionEligibility, dimensionOperands, dimensionLabel, dimensionPointer, dimensionPlan, shownPlacement, leaveDrawingTool]);
  const currentConstraintTool = sketch?.graph && constraintToolRequest?.sketchId === sketch.id && tool === 'select' && !currentDimensionTool ? constraintToolRequest : null;
  useLayoutEffect(() => { if (constraintToolRequest && !currentConstraintTool) setConstraintToolRequest(null); }, [constraintToolRequest, currentConstraintTool]);
  // New positional relations first carry a free shape onto their target, as CATIA does, so the solver only has to hold it there.
  const constraintEdits = (graph: CadSketchGraph, sourceSketchId: string, relations: readonly CadSketchGraphRelation[]): readonly CadEdit[] => {
    const placement = cadSketchRelationPlacement(graph, relations);
    return [...placement ? [{ kind: 'translate-sketch-geometry' as const, sketchId: sourceSketchId, ...placement }] : [],
      ...relations.map(relation => ({ kind: 'set-sketch-relation' as const, sketchId: sourceSketchId, relation }))];
  };
  // What the registry's operand signatures say the selection takes, the origin and the axes among it, with no solver call; a pointer move
  // changes none of it. The icon row offers it, and the Constrain menu lists the same relations first, as CATIA's Constraint Definition
  // dialog does, so the two never differ.
  const selectionOffers = useMemo(() => sketch?.graph && tool === 'select' && !currentConstraintTool && graphSelections.length
    ? cadSketchRelationOffers(sketch.graph, graphSelections) : NO_RELATION_OFFERS, [sketch?.graph, tool, currentConstraintTool, graphSelections]);
  const relationOffers = currentDimensionTool ? NO_RELATION_OFFERS : selectionOffers;
  const selectionRelations = useMemo(() => sketch?.graph && selectionOffers !== NO_RELATION_OFFERS ? cadSketchSelectionRelationActions(sketch.graph, graphSelections, selectionOffers) : NO_SELECTION_RELATIONS,
    [sketch?.graph, graphSelections, selectionOffers]);
  const selectionDimensionOperands = useMemo(() => sketch?.graph && relationOffers !== NO_RELATION_OFFERS ? cadSketchDimensionPreselection(sketch.graph, dimensionPickTargets, graphSelections) : NO_DIMENSION_OPERANDS,
    [sketch?.graph, relationOffers, dimensionPickTargets, graphSelections]);
  /** The edits an offer makes: its relations, carrying free geometry onto them first, or the removal of the relations an applied one names. */
  const relationOfferEdits = (graph: CadSketchGraph, sourceSketchId: string, offer: CadSketchRelationOffer): readonly CadEdit[] => offer.state === 'applied'
    ? offer.relationIds.map(relationId => ({ kind: 'remove-sketch-relation' as const, sketchId: sourceSketchId, relationId }))
    : constraintEdits(graph, sourceSketchId, offer.relations.map(intent => ({ ...intent, id: crypto.randomUUID() }) as CadSketchGraphRelation));
  /** After the selection's commands, the relations its icon row would press: the same ones, with the same help, adding or removing the same relations. */
  const relationMenuItems = (graph: CadSketchGraph, sourceSketchId: string, picks: readonly CadSketchConstraintPick[], act: (action: () => void) => void): readonly CadContextMenuItem[] => {
    const usable = cadSketchSelectionRelationActions(graph, picks).filter(action => action.state !== 'blocked');
    return usable.length ? [{ kind: 'separator' }, ...usable.map(action => ({ label: relationMenuLabel(action), help: action.help,
      onSelect: () => act(() => applySketchEdits(relationOfferEdits(graph, sourceSketchId, action.offer))) }))] : [];
  };
  const beginConstraintTool = (kind: CadSketchConstraintTool) => {
    if (locked || !sketch?.graph) return;
    if (dimensionToolOwner.current) endDimensionTool();
    setTool('select'); setGraphRelationCommand(null); setProfileId(null); selectGraphSet(NO_SKETCH_SELECTIONS); setError(null);
    setConstraintToolRequest({ sketchId: sketch.id, tool: kind, document, picks: [] });
  };
  const constraintGeometryPick = useMemo<CadSketchGeometryPick | undefined>(() => {
    const graph = sketch?.graph;
    if (!currentConstraintTool || !graph || commandSubmission.applying) return undefined;
    const request = currentConstraintTool, picks: readonly CadSketchConstraintPick[] = request.document === document ? request.picks : NO_SKETCH_SELECTIONS;
    const step = cadSketchConstraintStep(graph, request.tool, picks, () => crypto.randomUUID());
    if (step.status !== 'more') return undefined;
    const restart = () => { setConstraintToolRequest({ ...request, document, picks: [] }); selectGraphSet(NO_SKETCH_SELECTIONS); };
    const pick = (operand: CadSketchConstraintPick) => {
      const current = interactionState.current;
      if (current.locked || current.document !== document || current.sketchId !== request.sketchId) return;
      const next = [...picks, operand], result = cadSketchConstraintStep(graph, request.tool, next, () => crypto.randomUUID());
      if (result.status === 'more') {
        setConstraintToolRequest({ ...request, document, picks: next });
        selectGraphSet(next); setError(null); return;
      }
      if (result.status === 'invalid') { restart(); setError(result.reason); return; }
      const sourceSketchId = request.sketchId;
      restart();
      // The tool stays active; the next pick starts a new constraint on the updated sketch.
      const edits = constraintEdits(graph, sourceSketchId, result.relations);
      submitEdit(signal => applyCanvasEdits(edits, signal));
    };
    return {
      eligibleEntityIds: step.entityIds, eligiblePointIds: step.pointIds,
      label: `${cadSketchConstraintToolLabels[request.tool]} · ${step.prompt}`,
      onCancel: () => { setConstraintToolRequest(null); selectGraphSet(NO_SKETCH_SELECTIONS); },
      onPick: pick
    };
  }, [currentConstraintTool, sketch, document, commandSubmission.applying, selectGraphSet]);
  const beginSketchOffset = () => {
    if (locked || !offsetSource || !sketch) return;
    setTool('select'); setGraphRelationCommand(null); setOffsetCommand({ sketchId: sketch.id, source: offsetSource, token: crypto.randomUUID() }); setInspectorCollapsed(false);
  };
  const mirrorSourceIds = graphGeometry.length && graphEntities.length === graphGeometry.length ? graphEntities.map(entity => entity.id) : [];
  // The H and V axes are always there to mirror about.
  const canMirrorSketch = mirrorSourceIds.length > 0 && mirrorSourceIds.length <= 64;
  const beginSketchMirror = () => {
    if (locked || !canMirrorSketch || !sketch) return;
    setTool('select'); setGraphRelationCommand(null); setMirrorInteraction(null);
    setMirrorCommand({ sketchId: sketch.id, entityIds: mirrorSourceIds, token: crypto.randomUUID() }); setInspectorCollapsed(false);
  };
  const editSketchPattern = (relationId: string, detach?: true) => {
    if (interactionState.current.locked || !sketch?.graph?.relations.some(relation => relation.id === relationId && relation.kind === 'linear-pattern')) return;
    setTool('select'); setGraphRelationCommand(null); setPatternInteraction(null);
    setPatternCommand({sketchId:sketch.id,request:{kind:'edit',relationId,...(detach ? {detach} : {})},token:crypto.randomUUID()}); setInspectorCollapsed(false);
  };
  const canPatternSketch = Boolean(selectedPattern || selectedGraphEntity?.kind === 'circle' && !selectedGraphEntity.construction && !graphEditLock);
  const beginSketchPattern = () => {
    if (locked || !sketch || !canPatternSketch) return;
    if (selectedPattern) { editSketchPattern(selectedPattern.relation.id); return; }
    if (selectedGraphEntity?.kind !== 'circle') return;
    setTool('select'); setGraphRelationCommand(null); setPatternInteraction(null);
    setPatternCommand({sketchId:sketch.id,request:{kind:'create',seedEntityId:selectedGraphEntity.id},token:crypto.randomUUID()}); setInspectorCollapsed(false);
  };
  const beginSketchReference = () => {
    if (locked || !sketch || !referenceSources.length) return;
    setTool('select'); setGraphRelationCommand(null); setSketchReferenceInteraction(null);
    setSketchReferenceCommand({ sketchId: sketch.id, token: crypto.randomUUID() }); setInspectorCollapsed(false);
  };
  const beginSketchCorner = (kind: 'fillet' | 'chamfer') => {
    if (locked) return;
    if (graphSelection?.kind !== 'point') { if (kind === 'fillet') beginProfileCommand('fillet'); return; }
    setTool('select'); setGraphRelationCommand({ kind, token: crypto.randomUUID() }); setInspectorCollapsed(false);
  };
  const acceptSketchCorner = (entityId: string, relationId: string) => {
    selectGraph({ kind: 'entity', id: entityId });
    if (sketchId) setGraphRelationCommand({ kind: 'value', token: crypto.randomUUID(), documentId: document.id, sketchId, relationId, pick: null, version: props.documentVersion });
  };
  const changeConstruction = (value: boolean) => {
    if (interactionState.current.locked || patternConstructionLocked) return;
    if (tool === 'select' && graphSelections.length) {
      if (sketch && graphEntities.length === graphGeometry.length)
        submitEdit(signal => props.onEdit({ kind: 'set-sketch-construction', sketchId: sketch.id, entityIds: graphEntities.map(entity => entity.id), construction: value }, signal));
      return;
    }
    if (tool === 'select' && sketch && profile) {
      submitEdit(signal => props.onEdit({ kind: 'update-feature', feature: withCadSketchProfile(sketch, { ...profile, construction: value }) }, signal));
      return;
    }
    setConstruction(value);
  };
  const parameterMenu = [
    { label: 'New parameter', help: 'A named value that dimensions can use in expressions. Editing it updates every linked dimension.', onSelect: () => parameterControls.current?.create('parameter') },
    { label: 'New group', help: 'A folder for organising parameters. Removing a group keeps its values.', onSelect: () => parameterControls.current?.create('group') },
  ];
  const parameterContent = <CadParametersPanel controls={parameterControls} key={`parameters-${externalWorkflowOpen}-${pluginsOpen}`} document={document} onEditMany={props.onEditMany} onInspectParameter={inspectParameter} onInspectUsage={inspectParameterUsage} onPendingChange={setParameterPending} interactionLocked={Boolean(props.sketchEdit || currentDimensionPicks) || commandSubmission.applying || drawingPending || editorPending || dimensionPending || namePending || treeRenamePending || newFeature !== null || resolvingTopology !== null || storageBusy || deleteFeature !== null || externalWorkflowOpen || pluginsOpen || Boolean(currentSketchPlaneRequest || currentReferencePick)} cancelSignal={cancelSignal} />;
  const applySketchEdits = (edits: readonly CadEdit[], accepted?: () => void) => submitEdit(signal => applyCanvasEdits(edits, signal), accepted, SKETCH_RELATION_FAILURE);
  /** Pressing an offer adds its relations, carrying free geometry onto them first, or removes the relations an applied one names. */
  const applyRelationOffer = (offer: CadSketchRelationOffer) => {
    const graph = sketch?.graph;
    if (!sketch || !graph || offer.state === 'blocked' || interactionState.current.locked) return;
    applySketchEdits(relationOfferEdits(graph, sketch.id, offer));
  };
  const selectionActionHandlers = useRef({ offer: applyRelationOffer, dimension: () => undefined as void });
  selectionActionHandlers.current = { offer: applyRelationOffer, dimension: () => { if (selectionDimensionOperands.length) startDimensionTool(selectionDimensionOperands); } };
  const selectionActions = useMemo((): CadSketchSelectionActionsModel | null => sketch?.graph && (relationOffers.length || selectionDimensionOperands.length) ? {
    graph: sketch.graph, selection: graphSelections, offers: relationOffers, dimensionAvailable: selectionDimensionOperands.length > 0, disabled: locked,
    onOffer: offer => selectionActionHandlers.current.offer(offer), onDimension: () => selectionActionHandlers.current.dimension()
  } : null, [sketch?.graph, graphSelections, relationOffers, selectionDimensionOperands, locked]);
  const sketchCommandLocked = commandSubmission.applying || drawingPending || parameterPending || dimensionPending || namePending || treeRenamePending || storageBusy || externalWorkflowOpen || pluginsOpen;
  const closeGraphCommand = () => setGraphRelationCommand(null);
  const valueAnchorId = valueEditorCurrent ? valueCommand?.relationId ?? null : null;
  /** The dimension label, relation mark or tree row a value editor opens beside, in that order. */
  const findValueAnchor = useCallback(() => {
    const root = modelingArea.current;
    if (!root || !valueAnchorId) return null;
    const id = CSS.escape(valueAnchorId);
    return root.querySelector(`[data-cad-sketch-dimension="${id}"]`) ?? root.querySelector(`[data-cad-sketch-relation-glyph~="${id}"]`) ?? root.querySelector(`[data-cad-sketch-relation-row="${id}"]`);
  }, [valueAnchorId]);
  /** Closing the value editor keeps its dimension selected; the editor returns focus to what it opened beside, else to the canvas. */
  const closeValueEditor = () => setGraphRelationCommand(current => current?.kind === 'value' ? null : current);
  const drawnRelationPick = (relationId: string) => { const graph = sketch?.graph; return graph && drawnAnnotations?.graph === graph ? cadSketchDimensionPick(drawnAnnotations, relationId) : null; };
  /** A tree row selects its relation's mark when the canvas draws it, otherwise the row itself; Shift, Ctrl or Command adds or removes it. */
  const selectRelationRow = (relation: CadSketchGraphRelation, additive: boolean) => {
    if (!sketch?.graph) return;
    const pick = drawnRelationPick(relation.id);
    if (pick) { selectGraphAnnotations([pick], additive); return; }
    const ids = !additive ? [relation.id] : relationRowIds.includes(relation.id) ? relationRowIds.filter(id => id !== relation.id) : [...relationRowIds, relation.id];
    // Shift keeps the selected dimensions and marks: they and the rows are one relation selection, which replaces the geometry selection.
    setGraphPick(current => additive && current?.dimensions?.length ? current.selections.length ? { ...current, selections: NO_SKETCH_SELECTIONS } : current : null);
    setGraphRelationCommand(null); setProfileId(null); setProfileCommand(null);
    setRelationRowPick(ids.length ? { documentId: document.id, sketchId: sketch.id, relationIds: ids } : null);
  };
  /** Double-click or Enter on a row: a value editor, a pattern's editor, or the relation selected. */
  const openRelationRow = (relation: CadSketchGraphRelation) => {
    if (!sketch?.graph || interactionState.current.locked) return;
    if (relation.kind === 'linear-pattern') { editSketchPattern(relation.id); return; }
    const pick = drawnRelationPick(relation.id);
    if (!isCadSketchValueRelation(relation)) { selectRelationRow(relation, false); return; }
    if (!pick) selectRelationRow(relation, false);
    editSketchValue(relation.id, pick);
  };
  /**
   * Delete on a row removes the whole relation selection, drawn and listed alike, in one undo step when the row is part of it, otherwise the
   * row's own relation; a pattern detaches through its editor.
   */
  const deleteRelationRow = (relation: CadSketchGraphRelation) => {
    const graph = sketch?.graph;
    if (!sketch || !graph || interactionState.current.locked) return;
    if (relation.kind === 'linear-pattern') { editSketchPattern(relation.id, true); return; }
    if (selectedRelationIds.includes(relation.id)) { deleteSketchAnnotations(); return; }
    const pick = drawnRelationPick(relation.id);
    if (pick) { deleteSketchAnnotations([pick]); return; }
    applySketchEdits([{ kind: 'remove-sketch-relation' as const, sketchId: sketch.id, relationId: relation.id }]);
  };
  const openRelationRowMenu = (relation: CadSketchGraphRelation, at: { readonly clientX: number; readonly clientY: number }) => {
    if (!sketch?.graph || interactionState.current.locked) return;
    const pick = drawnRelationPick(relation.id);
    if (pick) { openAnnotationMenu([pick], at); return; }
    if (!selectedRelationIds.includes(relation.id)) selectRelationRow(relation, false);
    setCanvasMenu({ kind: 'relation-row', document, version: props.documentVersion, buildId: build?.buildId ?? null, sketchId: sketch.id, relationId: relation.id, cancel: cancelSignal, request: { clientX: at.clientX, clientY: at.clientY } });
  };
  const relationRowActions = useRef({ select: selectRelationRow, open: openRelationRow, remove: deleteRelationRow, menu: openRelationRowMenu, scope: (() => undefined) as (only: boolean) => void,
    expand: (() => undefined) as (expanded: boolean) => void });
  relationRowActions.current = { select: selectRelationRow, open: openRelationRow, remove: deleteRelationRow, menu: openRelationRowMenu,
    scope: only => setRelationListScope(only && sketch && graphGeometry.length ? { documentId: document.id, sketchId: sketch.id, selection: graphGeometry } : null),
    expand: setRelationListOpen };
  // Stable row commands keep the memoized list from rendering again for anything but its own inputs.
  const [relationRowCommands] = useState(() => ({
    select: (relation: CadSketchGraphRelation, additive: boolean) => relationRowActions.current.select(relation, additive),
    open: (relation: CadSketchGraphRelation) => relationRowActions.current.open(relation),
    remove: (relation: CadSketchGraphRelation) => relationRowActions.current.remove(relation),
    menu: (relation: CadSketchGraphRelation, at: { readonly clientX: number; readonly clientY: number }) => relationRowActions.current.menu(relation, at),
    scope: (only: boolean) => relationRowActions.current.scope(only),
    expand: (expanded: boolean) => relationRowActions.current.expand(expanded),
  }));
  // Choosing areas swaps the sketch canvas for the 3D view, where no mark is drawn for a row to select, so the list waits for the sketch.
  const sketchRelationContent = sketch?.graph && sketchIssues && !currentRegionPick ? { sketchId: sketch.id, reveal: relationListReveal?.token ?? null, content: <CadSketchRelationList graph={sketch.graph}
    parameters={document.parameters} issues={sketchIssues} selectedIds={selectedRelationIds} selection={relationListSelection ?? graphGeometry} onlySelection={relationListSelection !== null}
    onOnlySelection={relationRowCommands.scope} locked={locked} highlight={sketchHighlight} onSelect={relationRowCommands.select} onOpen={relationRowCommands.open}
    onDelete={relationRowCommands.remove} onMenu={relationRowCommands.menu} reveal={relationListReveal} expanded={relationListOpen} onExpandedChange={relationRowCommands.expand} /> } : null;
  /** Inspecting an issue of a relation the canvas does not draw opens its row too, the one place it can be selected or deleted. */
  const inspectHeaderIssue = (issue: CadSketchIssue | null) => {
    inspectIssue(issue);
    if (issue?.relationId && sketch?.graph?.relations.some(item => item.id === issue.relationId) && !drawnRelationPick(issue.relationId)) revealRelationRow(issue.relationId);
  };
  const sketchHeader = sketch && sketchIssues ? <CadSketchContextHeader name={sketch.name}
    status={!currentAreaRepair ? <CadSketchConstraintStatus document={document} sketch={sketch} version={props.documentVersion} inspect={props.onInspectSketchConstraints} onReport={publishSketchReport} enabled={props.sketchAnalysisReady !== false && !pending && !externalWorkflowOpen} paused={storageBusy || props.sketchAnalysisPaused === true} /> : null}
    issues={sketchIssues} inspectedIssue={inspectedIssue?.key ?? null} issuesLocked={commandSubmission.applying || storageBusy || externalWorkflowOpen} onInspectIssue={inspectHeaderIssue}
    highlight={sketchHighlight} highlightOf={issueHighlight} dimensionsShown={preferences.showOnPartDimensions} relationsShown={relationsShown}
    onShowDimensions={shown => { setCadPreferences({ ...getCadPreferences(), showOnPartDimensions: shown }); }} onShowRelations={shown => { setCadPreferences({ ...getCadPreferences(), showRelations: shown }); }}
    actions={<>{currentAreaRepair ? <Button variant="primary" className="cad-sketch-header-finish" type="submit" form={areaRepairFormId} aria-label="Finish sketch" title="Finish sketch with replacement areas" disabled={!areaRepairReady || storageBusy || externalWorkflowOpen}><Check size={14} /><span>Finish</span></Button>
      : <Button variant="primary" className="cad-sketch-header-finish" aria-label="Finish sketch" title="Finish sketch" disabled={toolsLocked} onClick={finishSketch}><Check size={14} /><span>Finish</span></Button>}
      {props.sketchEdit && <Button size="icon" aria-label="Cancel sketch edits" title="Discard sketch edits" disabled={storageBusy} onClick={cancelSketchEdit}><CloseIcon size={13} /></Button>}</>} /> : null;
  const valueEditor = valueEditorCurrent && valueCommand && valueRelation && sketch?.graph ? <CadSketchDimensionValueEditor key={valueCommand.token} document={document} sketch={sketch} graph={sketch.graph}
    relationId={valueRelation.id} findAnchor={findValueAnchor} onEditMany={props.onEditMany} onPrepareEdits={props.onPrepareEdits} onPendingChange={setEditorPending}
    onPreviewDocument={publishSketchPreview} onFeedback={reportEditFeedback} interactionLocked={sketchCommandLocked} onClose={closeValueEditor} onAccepted={closeValueEditor} /> : null;
  const specificationTree = <CadFeatureTree sketchContent={sketchRelationContent} onSectionView={sketch || curve ? undefined : plane => setSectionView({ plane })} parameterContent={parameterContent} parameterMenu={parameterMenu} selectionOnly={Boolean(props.sketchEdit || currentReferencePick || currentSketchPlaneRequest || currentSketchReferencePick)} allowPrincipalPlaneSelection={Boolean(currentSketchPlaneRequest)} selectableFeatureIds={currentSketchReferencePick ? currentSketchReferencePick.eligibleSketchIds : props.sketchEdit ? [props.sketchEdit.sketchId] : currentReferencePick?.eligibleIds ?? (currentSketchPlaneRequest ? document.features.filter(feature => feature.kind === 'datum-plane' && cadFeatureActive(feature, document)).map(feature => feature.id) : undefined)} document={document} diagnostics={build?.diagnostics} selectedId={selectedId} selectedProfileId={profileId} locked={treeLocked} onRenamePendingChange={setTreeRenamePending} cancelSignal={cancelSignal} selectedReferencePlane={typeof selectedReferencePlane === 'string' ? selectedReferencePlane : null} onSelectReferencePlane={selectReferencePlane} hoveredReferencePlane={hoveredReferencePlane} onHoverReferencePlane={hoverReferencePlane} onCreateSketch={plane => { if (!interactionState.current.locked) run(() => createSketchOnPlane(plane)); }} onRename={(feature, name, renamedProfileId, signal) => {
    if (document.features.find(entry => entry.id === feature.id) !== feature) throw new Error('The part changed. Cancel and reopen the rename editor.');
    return props.onEdit({ kind: 'update-feature', feature: renamedProfileId && feature.kind === 'sketch' ? renamedProfile(feature, renamedProfileId, name) : { ...feature, name } }, signal);
  }} onContextMenuOpenChange={setTreeMenuOpen} onProperties={id => openProperties(id ? { kind: 'feature', featureId: id } : { kind: 'body' })} onChangeSketchPlane={beginChangeSketchPlane} onSuppress={(feature, suppressed) => submitEdit(signal => props.onEdit({ kind: 'update-feature', feature: { ...feature, suppressed } }, signal))} onDelete={feature => { setSelectedId(feature.id); setProfileId(null); setDeleteFeature(feature); }} onUpdateProfile={(source, next) => submitEdit(signal => props.onEdit({ kind: 'update-feature', feature: withCadSketchProfile(source, next) }, signal))} onDeleteProfile={deleteProfile} onCopyProfile={props.sketchEdit ? undefined : beginProfileCopy} highlightedFeatureIds={parameterUsages.map(usage => usage.featureId)} onSelect={choose} onConfigure={configureFeature} onEditSketch={editSketch} onEditCurve={editCurve} onSelectProfile={(feature, id) => { editSketch(feature); setProfileId(id); setProfileCommand(null); }} />;

  const header = <div className="cad-header" aria-label="CAD document commands" inert={deleteFeature || pluginsOpen || externalWorkflowOpen || currentCanvasMenu || treeMenuOpen ? true : undefined}>
      <Button className="cad-back" aria-label="Workbench" title="Back to Workbench" onClick={() => run(props.onBack)} disabled={locked || Boolean(props.sketchEdit)}><ArrowLeft size={14} /></Button>
      <span className={`cad-save-state ${dirty ? 'is-dirty' : ''}`}>{dirty ? 'Unsaved' : ''}</span>
      {buildState === 'error' && <span className="cad-header-build-state" role="status">Feature needs attention</span>}
      <div className="cad-header-actions">
        <div className="cad-menu-anchor"><Button ref={fileMenuTrigger} disabled={locked || Boolean(props.sketchEdit)} aria-haspopup="menu" aria-expanded={fileMenu} aria-controls="cad-file-menu" onClick={() => setFileMenu(!fileMenu)}>File <ChevronDown size={12} /></Button>{fileMenu && <><Button variant="scrim" tabIndex={-1} className="cad-menu-scrim" aria-label="Close file menu" onClick={() => setFileMenu(false)} /><MenuSurface ref={fileMenuPanel} onKeyDown={event => {
          if (event.key !== 'Tab' || event.nativeEvent.isComposing) return;
          event.preventDefault(); event.stopPropagation();
          const trigger = fileMenuTrigger.current, toolbar = trigger?.closest('.cad-header-actions');
          const controls = [...toolbar?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []]
            .filter(control => !fileMenuPanel.current?.contains(control) && !control.classList.contains('cad-menu-scrim'));
          const index = controls.findIndex(control => control === trigger);
          setFileMenu(false); (controls[index + (event.shiftKey ? -1 : 1)] ?? trigger)?.focus();
        }} onDismiss={() => { setFileMenu(false); fileMenuTrigger.current?.focus(); }} className="cad-file-menu" id="cad-file-menu" aria-label="CAD document commands"><MenuItem onClick={() => run(props.onNewDocument)}><FilePlus2 size={14} /> New part</MenuItem><MenuItem onClick={() => run(props.onOpenDocument)}><FolderOpen size={14} /> Open saved part</MenuItem><MenuItem onClick={() => { setFileMenu(false); fileInput.current?.click(); }}><FolderOpen size={14} /> Import file</MenuItem>{props.onCaptureViewport && <MenuItem disabled={locked || (!canvasReference && (hasActiveBodyFeatures ? !hasSolid || props.buildVersion !== props.documentVersion : references.length === 0))} onClick={() => run(() => props.onCaptureViewport?.())}><CameraCaptureIcon size={14} /> Capture view PNG</MenuItem>}<MenuSeparator />{props.onRebuild && <MenuItem disabled={locked} onClick={() => run(() => props.onRebuild?.())}><RefreshIcon size={14} /> Rebuild model</MenuItem>}<MenuItem onClick={() => run(props.onExportDocument)}><Download size={14} /> Download CAD document</MenuItem><MenuItem disabled={!hasSolid} onClick={() => run(() => props.onExportSolid('step'))}><Download size={14} /> Export STEP</MenuItem><MenuItem disabled={!hasSolid} onClick={() => run(() => props.onExportSolid('stl'))}><Download size={14} /> Export STL</MenuItem><MenuItem disabled={!document.features.some(feature => cadFeatureActive(feature, document) && (feature.kind === 'sketch' && hasMaterial(feature) || feature.kind === 'curve')) && !hasSolid || !props.onOpenDxfExport} onClick={() => run(() => props.onOpenDxfExport?.())}><Download size={14} /> Export DXF</MenuItem><Tooltip content={CAD_KERNEL_THIRD_PARTY.description}><MenuItem asChild><a href={CAD_KERNEL_THIRD_PARTY.href} aria-label={CAD_KERNEL_THIRD_PARTY.label}  target="_blank" rel="noopener noreferrer">Geometry kernel licenses</a></MenuItem></Tooltip><MenuSeparator />{props.onSectionForCam && <MenuItem disabled={locked || !sectionBodyId || !hasSolid || props.buildVersion !== props.documentVersion || Boolean(build?.diagnostics.length)} title="Create CAM geometry from a planar section" onClick={() => sectionBodyId && run(() => props.onSectionForCam?.(sectionBodyId))}><SectionCamIcon size={14} /> Section for CAM</MenuItem>}<MenuItem disabled={locked || (!selectedSketch || !hasMaterial(selectedSketch))} onClick={() => selectedSketch && run(() => props.onSendToCam(selectedSketch.id))}><SendCamIcon size={14} /> Send sketch to CAM</MenuItem></MenuSurface></>}</div>
        <Button aria-label="Undo" title="Undo · Ctrl+Z" disabled={!canUndo || locked} onClick={() => run(props.onUndo)}><Undo2 size={15} /></Button><Button aria-label="Redo" title="Redo · Ctrl+Shift+Z" disabled={!canRedo || locked} onClick={() => run(props.onRedo)}><Redo2 size={15} /></Button>
        <Button disabled={locked || Boolean(props.sketchEdit)} onClick={() => run(props.onSave)}><Save size={14} /> {storageBusy ? 'Working…' : 'Save'}</Button>

      </div>
      <Input ref={fileInput} type="file" accept=".wireedm-cad,.json,.step,.stp,.stl,.dxf" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) run(() => props.onImportDocument(file)); event.target.value = ''; }} />
    </div>;

  const toolbar = <div className="cad-toolbar" aria-label="CAD tools" data-cad-tool-context={sketch ? 'sketch' : curve || curveCreation ? 'curve' : 'model'} inert={deleteFeature || pluginsOpen || externalWorkflowOpen || currentCanvasMenu || treeMenuOpen ? true : undefined}>
      {!canvasReference && <div className="cad-tool-group">{toolButton('Sketch', SketchIcon, startSketch, locked)}{toolButton('Plane', DatumPlaneIcon, () => startFeature('datum-plane'), locked)}{toolButton('Curve', CurveIcon, () => startFeature('curve'), locked)}</div>}
      <div className="cad-tool-group">{toolButton('Plugins', AddIcon, () => setPluginsOpen(true), locked || Boolean(props.sketchEdit))}</div>
      {sketch ? <><div className="cad-tool-group">{toolButton('Select', SelectIcon, () => { if (dimensionToolOwner.current) endDimensionTool(); chooseTool('select'); }, toolsLocked, tool === 'select' && !currentDimensionTool, undefined, 'S')}{drawingToolButton('line', 'Line', LineIcon, 'Draw connected lines: click each point, then double-click, press Enter or Escape to finish, or click the start to close. Drag to draw one line. 3-point Arc adds arcs to the chain. A line along the horizontal or vertical guide from its start stays horizontal or vertical', 'L P')}{drawingToolButton('arc', 'Arc', ArcIcon, 'Draw a three-point arc: click its start, its end, then a point on the arc', 'A')}{drawingToolButton('rectangle', 'Rectangle', RectangleIcon, undefined, 'R')}{drawingToolButton('circle', 'Circle', CircleIcon, undefined, 'C')}{drawingToolButton('slot', 'Slot', SlotIcon, 'Draw a slot: click both arc centers, then a point to set the width', 'O')}{toolButton('Trim', TrimIcon, () => chooseTool('trim'), toolsLocked || !sketch.graph, tool === 'trim', sketch.graph ? 'Click edge pieces to remove them up to the nearest crossing edge' : 'Trim needs a sketch drawn with connected edges', 'T')}</div><div className="cad-tool-group">{toolButton('Dimension', MeasureIcon, beginSketchDimension, currentDimensionTool ? locked : locked || !sketchDimensionAvailable && !canPickDimension, Boolean(currentDimensionTool), 'Dimension: pick the geometry, then click where the dimension goes', 'D')}<CadToolbarMenu label="Constrain" menuLabel="Constraint tools" title="Constrain the selected geometry, or choose a constraint and then pick the geometry it asks for." icon={<ConstraintIcon size={15} strokeWidth={1.5} />} disabled={locked || !sketch.graph} pressed={Boolean(currentConstraintTool)}
        items={[...selectionRelations.length ? [{ kind: 'label' as const, key: 'selection', label: 'For the selection' }, ...selectionRelations.map(action => ({ key: `selection-${action.key}`, label: action.label, icon: <action.icon size={14} />,
          checked: action.state === 'applied', disabled: action.state === 'blocked', title: action.help, onSelect: () => applyRelationOffer(action.offer) })),
          { kind: 'separator' as const, key: 'tools-separator' }, { kind: 'label' as const, key: 'tools', label: 'Choose, then pick' }] : [],
          ...CAD_SKETCH_CONSTRAINT_TOOLS.map(kind => ({ key: kind, label: cadSketchConstraintToolLabels[kind], icon: constraintToolIcon(kind), title: cadSketchConstraintToolHelp[kind], onSelect: () => beginConstraintTool(kind) }))]} />{toolButton(graphSelections.length ? 'Move selection' : 'Move profile', MoveIcon, beginSketchMove, locked || Boolean(graphEditLock) || !graphSelections.length && (!profile || profile.geometry.kind === 'plugin'), false, graphEditLock ?? 'Move selected geometry without releasing dimensions')}{toolButton('Offset loop', OffsetIcon, beginSketchOffset, locked || !offsetSource, Boolean(currentOffset), 'Create an independent copy of one closed nonconstruction loop')}{toolButton('Mirror copy', MirrorIcon, beginSketchMirror, locked || !canMirrorSketch, Boolean(currentMirror), 'Mirror selected edges, then choose a line in the sketch. The copy is independent.', 'M')}<CadPatternCommand context="sketch" disabled={locked || !canPatternSketch} onChoose={beginSketchPattern} />{toolButton('Use reference', LinkIcon, beginSketchReference, locked || !referenceSources.length, Boolean(currentSketchReference), 'Use a linked line or circle from an earlier sketch on this plane')}<CadEdgeTreatmentCommand context="sketch" disabled={locked || profile?.geometry.kind !== 'rectangle' && !sketchCornerAvailable} chamferAvailable={sketchCornerAvailable} onChoose={beginSketchCorner} /></div><div className="cad-sketch-options"><label><Input type="checkbox" checked={tool === 'select' && graphSelections.length ? graphEntities.length === graphSelections.length && graphEntities.every(entity => entity.construction) : tool === 'select' && profile ? profile.construction : construction} disabled={locked || Boolean(graphEditLock) || patternConstructionLocked || tool === 'select' && graphSelections.some(selection => selection.kind === 'point')} onChange={(event) => changeConstruction(event.target.checked)} /> Construction</label></div></> : curve || curveCreation ? null : <><div className="cad-tool-group">{toolButton('Pad / Pocket', PadPocketIcon, () => startFeature('extrude'), locked || !modelSketchSources?.pad, false, undefined, 'E')}{toolButton('Revolve', RevolveIcon, () => startFeature('revolve'), locked || !modelSketchSources?.revolve)}{toolButton('Loft', LoftIcon, () => startFeature('loft'), locked || document.features.filter(feature => feature.kind === 'sketch' && cadFeatureActive(feature, document)).length < 2, false, 'Loft through ordered sketch sections')}{toolButton('Sweep', SweepIcon, () => startFeature('sweep'), locked || !modelSketchSources?.sweep || !document.features.some(feature => feature.kind === 'curve' && cadFeatureActive(feature, document)), false, 'Sweep a profile along a reference Curve')}</div><div className="cad-tool-group"><CadEdgeTreatmentCommand disabled={locked || !hasBody} onChoose={kind => startFeature(kind)} />{toolButton('Shell', ShellIcon, () => startFeature('shell'), locked || !topologyReady || !props.onResolveSelection || topologySelection?.picks[0]?.kind !== 'face')}{toolButton('Boolean', BooleanIcon, () => startFeature('boolean'), locked || currentBodyIds.length < 2)}</div><div className="cad-tool-group">{toolButton('Move', Move3dIcon, () => startFeature('transform'), locked || !hasBody)}<CadPatternCommand disabled={locked || !hasBody} onChoose={kind => startFeature(kind)} />{toolButton('Mirror', MirrorIcon, () => startFeature('mirror'), locked || !hasBody)}</div></>}
    </div>;
  // The model view stays mounted under a sketch surface so leaving the sketch keeps its camera and graphics context.
  const sketchSurface = coveringSketchKey !== null;
  // A part shown plainly can be as bright as the sketch strokes, so the sketch then draws them over a dark under-stroke.
  const sketchOutlined = sketchSurface && sketchBackgroundView?.background === 'normal';
  return <main className="cad-workbench" aria-label="Parametric CAD workbench">
    {publishHeader ? headerHost && createPortal(header, headerHost) : header}
    <div className="cad-body" inert={deleteFeature || pluginsOpen || externalWorkflowOpen || currentCanvasMenu || treeMenuOpen ? true : undefined}>
      <section ref={modelingArea} className={`cad-center${sketchSurface && sketchBackgroundView ? ' has-sketch-background' : ''}${sketchHeader ? ' has-sketch-header' : ''}`} aria-label="Modeling area"><CadCommandDock toolbar={toolbar}><CadViewport hidden={sketchSurface} sketchView={sketchSurface ? sketchBackgroundView : null} key={document.id} depthControl={currentDepthControl} busyInputLocked={storageBusy} regionSelection={currentRegionPick} sourceReferencePickIds={currentRegionPick ? regionReferenceIds : currentReferencePick?.eligibleIds} getFitArea={getFitArea} onContextMenu={currentOwnedPick || currentSketchPlaneRequest ? undefined : openSolidMenu} navigationMode={preferences.navigationMode} navigationLocked={navigationLocked} meshes={currentAreaRepair && currentRegionPick ? NO_MESHES : displayedMeshes} references={sketchSurface && sketchBackgroundView && sketchBackgroundReferences ? sketchBackgroundReferences : references} referenceVersion={currentTopologyPick ? inputPicker.source?.inputToken ?? null : candidatePreview?.candidateId ?? props.documentVersion} selectedId={currentTopologyPick ? currentTopologyPick.request.bodyId : newFeature?.id ?? selectedId} selectedReferencePlane={selectedReferencePlane} hoveredReferencePlane={hoveredReferencePlane} onHoverPlane={hoverReferencePlane} onSelect={choose} onSelectPlane={selectReferencePlane}
        selectedOrigin={selectedOrigin} onSelectOrigin={selectOriginReference} section={viewportSection} selectionFilter={partView.selectionFilter} viewControls={partViewControls} planePickingOnly={Boolean(currentSketchPlaneRequest)} interactionLocked={currentTopologyPick ? inputPicker.busy : locked && !currentOwnedPick && !currentSketchPlaneRequest} onControlsReady={publishRenderedControls} pickMode={currentTopologyPick ? inputPicker.mode : currentOwnedPick || currentSketchPlaneRequest ? 'body' : pickMode} topologySelection={currentTopologyPick ? inputPicker.selection : candidatePreview || currentOwnedPick ? null : topologySelection} pickingEnabled={currentTopologyPick ? Boolean(inputPicker.source) && !inputPicker.busy : Boolean(currentOwnedPick) || topologyReady && !candidatePreview} onTopologyPick={currentTopologyPick ? inputPicker.pick : currentOwnedPick || currentSketchPlaneRequest ? undefined : pickTopology}
        onTopologyChain={currentTopologyPick ? inputPicker.chain : currentOwnedPick || currentSketchPlaneRequest || !chainsAvailable ? undefined : chainTopology}
        onTopologySet={currentTopologyPick ? inputPicker.set : currentOwnedPick || currentSketchPlaneRequest ? undefined : setTopology} />{currentSketchReferencePick?.source ? <CadSketchCanvas outlined={sketchOutlined}
          key={`use-source/${currentSketchReferencePick.source.id}`} sketch={currentSketchReferencePick.source} parameters={document.parameters} documentVersion={props.documentVersion}
          placementLabel={cadPlacementLabel(currentSketchReferencePick.source.plane, document.features)} tool="select" selectedProfileId={null}
          onSelectProfile={() => undefined} onAddProfile={addProfile} onPendingChange={setDrawingPending} onError={setError}
          cancelSignal={cancelSignal} interactionLocked={pendingOtherCommands || storageBusy || externalWorkflowOpen}
          onControlsReady={publishRenderedControls} getFitArea={getFitArea} navigationMode={preferences.navigationMode}
          graphControls={{ document, selection: [], geometryPick: currentSketchReferencePick.pick, onSelect: () => undefined, onEditMany: props.onEditMany }} /> : copiedPreview?.kind === 'sketch' && profileCopyPreview ? <CadSketchCanvas outlined={sketchOutlined}
          key={copiedPreview.id} sketch={copiedPreview} parameters={profileCopyPreview.parameters} documentVersion={props.documentVersion}
          placementLabel={cadPlacementLabel(copiedPreview.plane, profileCopyPreview.features)} tool="select" selectedProfileId={null}
          onSelectProfile={selectProfile} onAddProfile={addProfile} onPendingChange={setDrawingPending} onError={setError}
          cancelSignal={cancelSignal} interactionLocked onControlsReady={publishRenderedControls} getFitArea={getFitArea} navigationMode={preferences.navigationMode}
          graphControls={{ document: profileCopyPreview, selection: [], onSelect: selectGraph, onEditMany: props.onEditMany }} /> : canvasReference && !currentRegionPick ? <CadSketchCanvas outlined={sketchOutlined} getFitArea={getFitArea} graphContextMenu={graphContextMenu} onContextMenu={openSketchMenu} navigationMode={preferences.navigationMode} dimensionControls={preferences.showOnPartDimensions ? { document, onEditMany: props.onEditMany, onPendingChange: setDimensionPending, interactionLocked: Boolean(currentDimensionPicks) || commandSubmission.applying || externalWorkflowOpen || pluginsOpen || editorPending || parameterPending || namePending || treeRenamePending || newFeature !== null || deleteFeature !== null || resolvingTopology !== null || storageBusy, onInspectInput: inspectInput, onConfigure: name => { setInspectorCollapsed(false); inspectInput(name); } } : undefined} previewProfile={profilePreview} previewSketch={preparedSketch} selectionFilter={partView.selectionFilter} onSelectionFilterChange={changeSelectionFilter} graphControls={sketch ? { document, selection: graphSelections, patternInteraction: currentPattern ? patternInteraction ?? undefined : undefined, onEditPattern: editSketchPattern, geometryPick: currentPlacement ? placementInteraction?.geometryPick : mirrorAxisPick ?? dimensionGeometryPick ?? constraintGeometryPick, positionPick: placementPositionPick, placement: currentPlacement ? placementInteraction?.placement : undefined, relation: inspectedRelation, inspection: currentMirror && mirrorInteraction?.kind === 'preview' ? { pointIds: [], entityIds: [mirrorInteraction.axisLineId] } : currentOffset?.source.kind === 'graph-cycle' ? { pointIds: [], entityIds: currentOffset.source.sourceRefs.map(ref => ref.entityId) } : diagnosticHighlight, degreesOfFreedom: graphFreedom, definition: shownAnalysis.definition, definitionLocked: shownAnalysis.locks, diagnosis: previewMarks ?? shownAnalysis.diagnosis, showDimensions: preferences.showOnPartDimensions, showRelations: relationsShown, selectionActions, onSelect: selectGraph, onSelectSet: selectGraphSet, onDelete: (selection, focused) => focused ? deleteFromFocus({ geometry: selection }, 'Delete') : deleteSketchGeometry(selection), onConfigureRelation: configureGraphRelation, dimensionSelection: graphDimensions, onSelectDimension: selectGraphDimension, onDeleteDimension: (dimension, key) => dimension ? deleteFromFocus({ annotations: [dimension] }, key ?? 'Delete') : deleteSketchAnnotations(), onDimensionMenu: (dimension, at) => openAnnotationMenu([dimension], at), onSelectRelations: selectGraphAnnotations, onOpenRelation: openGraphRelation, onDeleteRelations: (relations, key) => deleteFromFocus({ annotations: relations }, key), onRelationMenu: openAnnotationMenu, highlight: sketchHighlight, onEditMany: applyCanvasEdits, onPrepareEdits: props.onPrepareEdits, onPreviewDocument: publishSketchPreview } : undefined} inspection={sketchInspection} key={`${document.id}/${canvasReference.id}`} sketch={canvasReference} documentVersion={props.documentVersion} parameters={preparedSketchDocument?.parameters ?? previewParameters ?? document.parameters} placementLabel={cadPlacementLabel(canvasReference.plane, document.features)} tool={tool} selectedProfileId={profileId} onSelectProfile={canvasReference.kind === 'curve' ? () => undefined : selectProfile} onAddProfile={addProfile} onAddFreshSketch={addFreshSketch} onAddPath={addPath} onTranslateProfile={(id, translation, signal) => { if (!sketch) return; return moveCanvasProfile(id, profile => translateCadSketchProfile({ profile, translation, parameters: document.parameters }), { kind: 'translate-sketch-profiles', sketchId: sketch.id, profileIds: [id], translation }, signal); }} onMoveHandle={(id, handle: CadSketchHandle, translation, signal) => { if (!sketch) return; return moveCanvasProfile(id, profile => moveCadSketchHandle({ profile, handle, translation, parameters: document.parameters }), { kind: 'move-sketch-handle', sketchId: sketch.id, profileId: id, handle, translation }, signal); }} onAddCurve={addCurve} onCancelCurve={cancel} curveCreation={Boolean(curveCreation)} onPendingChange={setDrawingPending} onDrawingControls={publishDrawingControls} onExitTool={leaveDrawingTool} onError={setError} cancelSignal={cancelSignal} interactionLocked={curveCreation ? commandSubmission.applying || editorPending || parameterPending || namePending || storageBusy || deleteFeature !== null || resolvingTopology !== null : pendingOtherCommands || editorPending && !mirrorAxisPick && !placementPositionPick || storageBusy || externalWorkflowOpen} viewLocked={navigationLocked} onControlsReady={publishRenderedControls} onViewFrame={backgroundSketch ? publishSketchViewFrame : undefined} viewControls={backgroundSketch ? sketchViewControls : undefined} /> : null}
        {currentSketchPlaneRequest && <div className="cad-plane-request" role="status"><PencilRuler size={14} /><span>{currentSketchPlaneRequest.replaceSketchId ? `Click the new plane for ${document.features.find(feature => feature.id === currentSketchPlaneRequest.replaceSketchId)?.name ?? 'the sketch'}` : 'Select a plane in the design area'}</span><Button aria-label="Cancel plane selection" onClick={cancel}>Cancel</Button></div>}
        {buildState === 'building' && <div className="cad-build-overlay" role="status"><Loader2 size={13} className="cad-spin" /> Building solid geometry…</div>}
        {sketchHeader}{valueEditor}
        <div className="cad-tree-overlay" data-cad-model-tree aria-label="Feature tree and parameters">{specificationTree}</div>
        </CadCommandDock>
      </section>
      {inspectorVisible && <aside key={`configuration-${externalWorkflowOpen}-${pluginsOpen}`} className={`cad-properties cad-floating-inspector${floatingPluginInspector ? ' cad-plugin-inspector' : ''}${inspectorCollapsed ? ' is-minimized' : ''}`} data-cad-properties aria-label="Feature properties"><CadInspectorTitleContext.Provider value={titleHost}><div className="cad-panel-heading"><span className="cad-panel-title">{titleClaims > 0 && !inspectorCollapsed ? null : currentTopologyPick ? currentTopologyPick.purpose === 'shell' ? 'Choose opening' : 'Choose edges' : currentRegionPick ? 'Choose areas' : sketch ? sketch.name : curve ? curve.name : newFeature ? 'New feature' : currentProperties ? 'Properties' : profile ? 'Configuration' : selected?.name ?? 'Properties'}<span ref={setTitleSlot} className="cad-panel-title-slot" hidden={inspectorCollapsed} /></span>{currentTopologyPick ? <><Button variant="primary" className="cad-panel-finish" type="button" aria-label="Use topology selection" disabled={inputPicker.busy || !inputPicker.selection?.picks.length} onClick={() => { void inputPicker.finish(); }}><Check size={16} /></Button><Button type="button" aria-label="Cancel topology selection" onClick={currentTopologyPick.onCancel}><CloseIcon size={13} /></Button></> : currentRegionPick ? <><Button variant="primary" className="cad-panel-finish" aria-label="Finish area selection" title="Keep these areas" type="button" onClick={event => { event.preventDefault(); currentRegionPick.onFinish(); }}><Check size={16} /></Button><Button aria-label="Cancel area selection" title="Restore previous area choice" type="button" onClick={event => { event.preventDefault(); currentRegionPick.onCancel(); }}><CloseIcon size={13} /></Button></> : <>{curve && !curveCreation && <Button variant="primary" className="cad-panel-finish" aria-label="Finish curve editing" title="Finish curve editing" disabled={locked} onClick={finishCurve}><Check size={14} /><span>Finish</span></Button>}{currentProperties && !featureEditorOpen && !sketch && !curve && !newFeature && <Button aria-label="Close properties" title="Close properties (Esc)" onClick={() => setProperties(null)}><CloseIcon size={13} /></Button>}{featureEditorOpen && !curve && !newFeature && <Button aria-label="Close feature editor" title="Close editor (Esc)" disabled={commandSubmission.applying} onClick={closeFeatureEditor}><CloseIcon size={13} /></Button>}<Button aria-label={inspectorCollapsed ? 'Expand configuration' : 'Minimize configuration'} aria-expanded={!inspectorCollapsed} disabled={pending} onClick={() => setInspectorCollapsed(!inspectorCollapsed)}>{inspectorCollapsed ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</Button>{(sketch ? graphSelections.length > 0 || profile : featureEditorOpen) && !newFeature && <Button aria-label={graphSelections.length > 1 ? 'Delete selected geometry' : graphSelection ? `Delete selected ${graphSelection.kind === 'point' ? 'point and attached geometry' : 'edge'}` : 'Delete selected feature or profile'} disabled={locked || Boolean(props.sketchEdit && !graphSelections.length && !profile)} onClick={removeSelected}><Trash2 size={13} /></Button>}</>}</div>
        {currentRegionPick && <div className="cad-region-pick-hint" role="status">Click an area · Shift adds or removes</div>}
        {currentTopologyPick && <div className="cad-property-form">
          <div className="cad-region-pick-hint" role="status">{!inputPicker.source ? inputPicker.busy ? 'Showing feature input…' : 'Feature input unavailable' : inputPicker.busy ? 'Checking selection…' : inputPicker.notice ?? (inputPicker.mode === 'face' ? 'Pick one planar face to open' : 'Pick edges · Ctrl or Command adds or removes')}</div>
          {inputPicker.error && <p className="cad-error" role="alert">{inputPicker.error}</p>}
          {inputPicker.source && <CadTopologyInspector bodyId={inputPicker.source.bodyId} buildId={inputPicker.source.result.buildId} documentVersion={props.documentVersion}
            pickMode={inputPicker.mode} selection={inputPicker.selection} locked={inputPicker.busy} onInspect={inputPicker.inspect}
            onSelect={(pick, additive) => inputPicker.pick({ bodyId: currentTopologyPick.request.bodyId, pick }, additive)} onClear={() => inputPicker.pick(null, false)} />}
        </div>}
        <div hidden={inspectorCollapsed}>
        {resolvingTopology && <div className="cad-topology-resolving" role="status"><Loader2 size={14} className="cad-spin" /><span>Verifying {resolvingTopology === 'shell' ? 'opening face' : 'selected edges'}…</span><Button onClick={cancel}>Cancel</Button></div>}
        {currentProperties && !featureEditorOpen && !currentTopologyPick && !newFeature && !sketch && !resolvingTopology && props.onInspectTopology && topologyReady && build && (topologySelection?.bodyId ?? (selected && currentBodyIds.includes(selected.id) ? selected.id : null)) && <CadTopologyInspector key={`${props.documentVersion}-${build.buildId}-${topologySelection?.bodyId ?? selectedId}-${pickMode}`} bodyId={topologySelection?.bodyId ?? selectedId ?? ''} buildId={build.buildId} documentVersion={props.documentVersion} pickMode={pickMode === 'auto' ? topologySelection?.picks[0]?.kind ?? 'body' : pickMode} selection={topologySelection} locked={locked} onInspect={props.onInspectTopology} onSelect={(pick, additive) => pickTopology({ bodyId: topologySelection?.bodyId ?? selectedId ?? '', pick }, additive)} onClear={() => run(() => viewportControls.apply({ kind: 'clear-topology' }))} />}
        <fieldset className="cad-editor-fieldset" disabled={commandSubmission.applying || drawingPending && !curveCreation || parameterPending || dimensionPending || namePending && !partPropertiesOpen || treeRenamePending || storageBusy || resolvingTopology !== null}>{curveCreation ? <CadCurveCreationFields draft={curveCreation} document={document} onChange={setNewFeature} onCancel={cancel} /> : newFeature ? <CadFeatureEditor onDepthInteractionReady={publishDepthInteraction} onReferencePick={requestReferencePick} key={`${newFeature.id}-${cancelSignal}`} feature={newFeature} document={document} documentVersion={props.documentVersion} onFeaturePreview={props.onFeaturePreview} featurePreview={props.featurePreview} previewEnabled={previewEnabled} isNew currentBodyIds={currentBodyIds} onApply={applyFeature} onCancel={cancel} onPendingChange={setEditorPending} /> : currentAreaRepair ? <CadSketchAreaRepairPanel key={currentAreaRepair.localVersion} formId={areaRepairFormId} document={document} documentVersion={props.documentVersion} inspection={currentAreaRepair} interactionLocked={storageBusy || externalWorkflowOpen || commandSubmission.applying} onReferencePick={requestReferencePick} onReadyChange={setAreaRepairReady} onFinish={finishSketchWithAreas} onCancel={() => setAreaRepair(null)} /> : currentFinishRemovals ? <div className="cad-property-form" role="group" aria-label="Confirm finishing the sketch"><div className="cad-property-title">Finish sketch</div><p className="cad-form-hint" role="status">{cadGeneratorRemovalPrompt(document, currentFinishRemovals.removals)}</p><div className="cad-form-actions"><Button type="button" onClick={() => setFinishRemovals(null)}><CloseIcon size={13} /> Cancel</Button><Button variant="primary" type="button" className="cad-primary" onClick={() => confirmFinishRemovals(currentFinishRemovals)}><Check size={13} /> Apply</Button></div></div> : currentDimensionPicks ? <div className="cad-property-form"><div className="cad-property-title">Dimension</div><span role="status">{dimensionGeometryPick?.label}</span><div className="cad-form-actions"><Button onClick={escapeDimensionTool}>Cancel</Button></div></div> : profileCopyCommand ? <CadSketchProfileCopyEditor key={profileCopyCommand.token} document={document} documentVersion={props.documentVersion}
          request={profileCopyCommand.request} onEditMany={props.onEditMany} onPrepareEdits={props.onPrepareEdits}
          onPreviewDocument={setProfileCopyPreview} onPendingChange={setEditorPending}
          interactionLocked={pendingOtherCommands || drawingPending || storageBusy || externalWorkflowOpen || Boolean(props.sketchEdit)}
          onCancel={() => { setProfileCopyCommand(null); setProfileCopyPreview(null); }}
          onAccepted={candidate => { setProfileCopyAccepted({ document: candidate, sketchId: profileCopyCommand.request.newSketchId }); setProfileCopyCommand(null); }} /> : currentSketchReference && sketch ? <CadSketchReferenceEditor key={currentSketchReference.token} document={document} documentVersion={props.documentVersion} sketch={sketch}
          onEditMany={props.onEditMany} onPrepareEdits={props.onPrepareEdits} onPreviewDocument={publishSketchPreview} onPendingChange={setEditorPending}
          onInteractionChange={setSketchReferenceInteraction} onCancel={() => setSketchReferenceCommand(null)}
          onAccepted={entityId => { selectGraph({ kind: 'entity', id: entityId }); setSketchReferenceCommand(null); }}
          interactionLocked={pendingOtherCommands || drawingPending && !currentSketchReferencePick || storageBusy || externalWorkflowOpen} /> : currentPattern && sketch ? <CadSketchLinearPatternEditor key={currentPattern.token} document={document} documentVersion={props.documentVersion} sketch={sketch} request={currentPattern.request}
            onEditMany={props.onEditMany} onPrepareEdits={props.onPrepareEdits} onPreviewDocument={publishSketchPreview} onPendingChange={setEditorPending} onInteractionChange={setPatternInteraction}
            onCancel={() => setPatternCommand(null)} onAccepted={({seedEntityId}) => { selectGraph({kind:'entity',id:seedEntityId}); setPatternCommand(null); }}
            interactionLocked={pendingOtherCommands || drawingPending || storageBusy || externalWorkflowOpen} /> : currentPlacement && sketch ? <CadSketchPlacementEditor key={currentPlacement.token} document={document} documentVersion={props.documentVersion} sketch={sketch} selections={currentPlacement.selections} onEditMany={props.onEditMany} onPrepareEdits={props.onPrepareEdits} onPreviewDocument={publishSketchPreview} onPendingChange={setEditorPending} onInteractionChange={setPlacementInteraction} onCancel={() => setPlacementCommand(null)} onAccepted={() => setPlacementCommand(null)} interactionLocked={pendingOtherCommands || drawingPending && !placementPositionPick || storageBusy || externalWorkflowOpen} /> : currentMirror && sketch ? <CadSketchMirrorEditor key={currentMirror.token} document={document} documentVersion={props.documentVersion} sketch={sketch} entityIds={currentMirror.entityIds} onEditMany={props.onEditMany} onPrepareEdits={props.onPrepareEdits} onPreviewDocument={publishSketchPreview} onPendingChange={setEditorPending} onInteractionChange={setMirrorInteraction} onCancel={() => setMirrorCommand(null)} onAccepted={entityIds => { selectGraphSet(entityIds.map(id => ({ kind: 'entity', id }))); setMirrorCommand(null); }} interactionLocked={pendingOtherCommands || drawingPending && !mirrorAxisPick || storageBusy || externalWorkflowOpen} /> : currentOffset && sketch ? <CadSketchOffsetEditor key={currentOffset.token} document={document} documentVersion={props.documentVersion} sketch={sketch} source={currentOffset.source} onEditMany={props.onEditMany} onPrepareEdits={props.onPrepareEdits} onPreviewDocument={publishSketchPreview} onPendingChange={setEditorPending} onCancel={() => setOffsetCommand(null)} onAccepted={entityIds => { selectGraphSet(entityIds.map(id => ({ kind: 'entity', id }))); setOffsetCommand(null); }} interactionLocked={sketchEditorLocked} /> : sketch?.graph && graphRelationCommand?.kind === 'move' && graphGeometry.length ? <CadSketchMoveEditor key={`${graphRelationCommand.token}-${cancelSignal}`} document={document} sketch={sketch} graph={sketch.graph}
            selection={graphGeometry} onEditMany={props.onEditMany} onPrepareEdits={props.onPrepareEdits} onPendingChange={setEditorPending} onPreviewDocument={publishSketchPreview} onFeedback={reportEditFeedback}
            interactionLocked={sketchCommandLocked} onPlaceGeometry={beginSketchPlacement} onClose={closeGraphCommand} />
          : sketch?.graph && (graphRelationCommand?.kind === 'fillet' || graphRelationCommand?.kind === 'chamfer') && graphSelection?.kind === 'point' ? <CadSketchCornerEditor key={`${graphRelationCommand.token}-${cancelSignal}`}
            kind={graphRelationCommand.kind} pointId={graphSelection.id} document={document} sketch={sketch} graph={sketch.graph} onEditMany={props.onEditMany} onPrepareEdits={props.onPrepareEdits}
            onPendingChange={setEditorPending} onPreviewDocument={publishSketchPreview} onFeedback={reportEditFeedback} interactionLocked={sketchCommandLocked} onAccepted={acceptSketchCorner} onClose={closeGraphCommand} />
          : sketch?.graph && !profile && graphGeometry.length > 0 && graphRelationCommand?.kind !== 'move' && graphRelationCommand?.kind !== 'fillet' && graphRelationCommand?.kind !== 'chamfer' ? <CadSketchSelectionInspector
            key={JSON.stringify([document.id, sketch.id, graphGeometry, cancelSignal])} document={document} sketch={sketch} graph={sketch.graph} selection={graphGeometry} onEditMany={props.onEditMany}
            onPrepareEdits={props.onPrepareEdits} onPendingChange={setEditorPending} onPreviewDocument={publishSketchPreview} onFeedback={reportEditFeedback} interactionLocked={sketchCommandLocked}
            onApply={edits => applySketchEdits(edits)} onEditPattern={editSketchPattern} onSelectPatternSeed={id => selectGraph({ kind: 'entity', id })}
            onEditGenerator={id => { selectGraph(null); selectProfile(id); setInspectorCollapsed(false); }} /> : profile && sketch ? selectedProfileEditor : shapeGenerator && sketch ? <CadSketchGeneratorInputsEditor key={`${shapeGenerator.id}-${cancelSignal}`} generator={shapeGenerator} sketch={sketch} document={document}
            onApply={async (edits, signal) => { await props.onEditMany(edits, signal); signal?.throwIfAborted(); setEditorPending(false); }} onCancel={cancel} onPendingChange={setEditorPending}
            onPrepareEdits={props.onPrepareEdits} onPreviewDocument={publishSketchPreview} /> : selected && (featureEditorOpen || curve?.id === selected.id || sketch?.id === selected.id && !graphSelections.length && !currentProperties) ? <CadFeatureEditor topologyPickingEnabled={Boolean(props.featureInputPicking)} onDepthInteractionReady={publishDepthInteraction} onReferencePick={requestReferencePick} key={`${selected.id}-${cancelSignal}`} feature={selected} document={document} documentVersion={props.documentVersion} onFeaturePreview={props.onFeaturePreview} featurePreview={props.featurePreview} previewEnabled={previewEnabled} isNew={false} onApply={applyFeature}
            initialParameters={openingParameters?.featureId === selected.id ? openingParameters.parameters : undefined} onCancel={closeFeatureEditor} onPendingChange={setEditorPending} /> : currentProperties ? propertiesView : null}</fieldset>
        </div>
      </CadInspectorTitleContext.Provider></aside>}
    </div>
    {deleteFeature && <div className="cad-dialog-backdrop"><div ref={deleteDialog} className="cad-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="cad-delete-title"><h2 id="cad-delete-title">Delete {deleteFeature.name}?</h2>{dependentNames.length ? <><p>This also deletes {dependentNames.length} dependent feature{dependentNames.length === 1 ? '' : 's'}.</p><ul>{dependentNames.map((name) => <li key={name}>{name}</li>)}</ul></> : <p>You can restore this feature with Undo.</p>}<div className="cad-form-actions"><Button onClick={() => { commandSubmission.cancel(); setDeleteFeature(null); }}>Cancel</Button><Button variant="danger" className="cad-danger" disabled={commandSubmission.applying} onClick={() => submitEdit(signal => props.onEdit({ kind: 'delete-feature', featureId: deleteFeature.id, cascade: dependentNames.length > 0 }, signal), () => { setDeleteFeature(null); setSelectedId(current => current === deleteFeature.id ? null : current); })}><Trash2 size={13} /> Delete{dependentNames.length ? ' with dependents' : ''}</Button></div></div></div>}
    {currentCanvasMenu && canvasMenuItems.length > 0 && <CadContextMenu anchor={{ x: currentCanvasMenu.request.clientX, y: currentCanvasMenu.request.clientY }} title={canvasMenuTitle} items={canvasMenuItems} onClose={() => setCanvasMenu(null)} />}
    {pluginsOpen && <CadPluginsPanel onClose={() => { commandSubmission.cancel(); setPluginsOpen(false); }} onAdd={addPlugin} onListPlugins={props.onListPlugins} onInstallPlugin={props.onInstallPlugin} />}
  </main>;
}

export default CadWorkbench;
