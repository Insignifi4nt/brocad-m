import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { FitViewIcon, GridIcon, ViewIcon } from '@wire-edm/icons-react';
import { CadContextHelp } from './CadContextHelp';
import { CadViewTools } from './CadCommandDock';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { CadMesh, CadPlane, CadSketchPlane } from '@/domain/cad/cadDocument';
import type { CadTopologyPick, CadTopologyPickSet } from '@/domain/cad/cadTopology';
import { cadBoxModeFor } from '@/domain/cad/selection/cadSelectionBox';
import { cadSelectOtherApply, cadSelectOtherStep } from '@/domain/cad/selection/cadSelectionCycle';
import type { CadTopologyChainGesture } from '@/domain/cad/selection/cadTopologySelection';
import { captureCanvas } from '@/features/editor/captureEditorPreview';
import { ToolError } from '@/features/webmcp/siteTools';
import type { CadNamedView, CadRenderedViewControls } from './cadViewportControls';
import { pickTopology, topologyCandidates, topologyGroupAt, type CadPickMode, type CadTopologyHit } from './cadTopologyPicking';
import { cadBoxSelection, cadScreenBox } from './cadBoxSelection';
import { createCadTopologyHighlights } from './cadTopologyHighlights';
import { pickCadCurveReference } from './cadCurveRendering';
import { cadReferenceFeatureIds, cadReferencePlanes, cadSameReferencePlane, isCadContourReference, isCadOriginMarker, type CadViewportReference } from './cadViewportReferences';
import { cadLocalRenderPositions, cadRenderOrigin } from './cadRenderCoordinates';
import { prepareCadMeshDisplay } from './cadMeshDisplay';
import { createCadRegionSelectionOverlay } from './cadRegionSelectionOverlay';
import type { CadFeatureRegionPickCommand } from './cadFeatureReferencePicking';
import type { CadExtrudeDepthControl } from './cadExtrudeDepthInteraction';
import { createCadExtrudeDepthHandle } from './cadExtrudeDepthHandle';
import { readCadFitArea, type CadFitAreaReader } from './cadFitArea';
import './cad-plane-selection.css';
import './cad-depth-handle.css';
import { cadViewBackground } from './cadViewBackground';
import { cadSketchClipPlane, cadSketchClipTolerance, syncCadSketchCamera, type CadSketchCameraLink, type CadSketchPlacementFrame } from './view/cadSketchCamera';
import { CAD_SKETCH_DIM_AMOUNT, createCadBackgroundDim } from './view/cadSketchBackgroundStyle';
import type { CadResolvedFrame } from '@/domain/cad/cadDatumPlanes';
import { cadBoundsClipped, cadClipRaycaster, cadSectionClipPlane } from './view/cadSectionView';
import { cadCapBodySolids, createCadSectionCaps } from './view/cadSectionCaps';
import { CAD_DEFAULT_SELECTION_FILTER, cadSelectionAccepts, type CadSelectionFilter, type CadSelectionKind } from '@/domain/cad/selection/cadSelectionFilter';
import type { CadOriginSelection } from './view/cadReferenceSelection';
const NO_REFERENCES: readonly CadViewportReference[] = Object.freeze([]);
const NO_SOURCE_PICK_IDS: readonly string[] = Object.freeze([]);
/** An origin axis or the origin point picked in the model view. */
export type { CadOriginSelection };
const originSelection = (reference: CadViewportReference): CadOriginSelection | null => reference.featureKind === 'origin-axis'
  ? { kind: 'axis', axis: reference.axis } : reference.featureKind === 'origin-point' ? { kind: 'point' } : null;
const sameOrigin = (reference: CadViewportReference, selection: CadOriginSelection | null) => {
  const own = originSelection(reference);
  return Boolean(own && selection && own.kind === selection.kind && (own.kind === 'point' || selection.kind === 'axis' && own.axis === selection.axis));
};
/** Origin axes in the colours of the axis triad, a little muted so a model in front stays the focus. */
const ORIGIN_AXIS_COLORS = { x: 0xd9776e, y: 0x86c979, z: 0x6f9be0 } as const;
export interface CadViewportContextMenuRequest {
  readonly clientX: number;
  readonly clientY: number;
  readonly trigger: 'pointer' | 'keyboard';
  /** A topology target names the face under the pointer too, which the loop through an edge follows. */
  readonly target: { readonly kind: 'feature'; readonly featureId: string } | { readonly kind: 'topology'; readonly hit: CadTopologyHit; readonly faceKey?: string | null } | null;
  /** Selects the next of the candidates under the pointer when there is more than one, as N does. */
  readonly selectOther?: () => void;
}
/** One of the candidates Select other steps through. */
type CadViewportOther = { readonly kind: 'topology'; readonly hit: CadTopologyHit } | { readonly kind: 'plane'; readonly key: string; readonly plane: CadSketchPlane }
  | { readonly kind: 'body'; readonly featureId: string };
const samePick = (a: CadTopologyPick, b: CadTopologyPick) => a.kind === b.kind && a.key === b.key;
const sameOther = (a: CadViewportOther, b: CadViewportOther) => a.kind === 'topology' ? b.kind === 'topology' && a.hit.bodyId === b.hit.bodyId && samePick(a.hit.pick, b.hit.pick)
  : a.kind === 'plane' ? b.kind === 'plane' && a.key === b.key : b.kind === 'body' && a.featureId === b.featureId;
const planeKey = (plane: CadSketchPlane) => typeof plane === 'string' ? plane : `datum:${plane.featureId}`;

/**
 * The model drawn behind an open sketch. The sketch canvas lies on top and owns every pointer and key; this view only draws, through a camera
 * the sketch canvas drives, and only when that camera or the model changes.
 */
export interface CadSketchBackgroundView {
  readonly placement: CadSketchPlacementFrame;
  readonly background: 'normal' | 'dimmed';
  readonly cutBySketchPlane: boolean;
  readonly camera: CadSketchCameraLink;
}

/**
 * The section the model view cuts by, resolved to its plane in the world. Bodies, their edges and sketch outlines are clipped; the
 * planes, axes and points stay whole so another one can be picked. Picks never land on the removed side.
 */
export interface CadViewportSection {
  readonly frame: CadResolvedFrame;
  readonly flip: boolean;
  readonly caps: boolean;
}

export function CadViewport({ meshes, references = NO_REFERENCES, referenceVersion = null, selectedId, onSelect, onControlsReady, interactionLocked = false,
  navigationLocked = interactionLocked, navigationMode = 'mouse', onContextMenu, pickMode = 'body', topologySelection = null, onTopologyPick, pickingEnabled = true, getFitArea,
  selectedReferencePlane = null, hoveredReferencePlane = null, onSelectPlane, onHoverPlane, planePickingOnly = false, sourceReferencePickIds = NO_SOURCE_PICK_IDS, regionSelection = null, depthControl = null, busyInputLocked = false, hidden = false, sketchView = null,
  section = null, selectionFilter = CAD_DEFAULT_SELECTION_FILTER, selectedOrigin = null, onSelectOrigin, viewControls, onTopologyChain, onTopologySet }: {
  meshes: readonly CadMesh[];
  references?: readonly CadViewportReference[];
  referenceVersion?: string | null;
  selectedId: string | null;
  onSelect(id: string | null): void;
  selectedReferencePlane?: CadSketchPlane | null;
  onSelectPlane?(plane: CadSketchPlane): void;
  /** A plane hovered elsewhere, such as its tree row, shares the canvas hover colour. */
  hoveredReferencePlane?: CadSketchPlane | null;
  /** Reports the reference or datum plane under the pointer, and `null` when it leaves. */
  onHoverPlane?(plane: CadSketchPlane | null): void;
  planePickingOnly?: boolean;
  /** Only a current form-owned source picker supplies eligible sketch/curve IDs. */
  sourceReferencePickIds?: readonly string[];
  regionSelection?: CadFeatureRegionPickCommand | null;
  depthControl?: CadExtrudeDepthControl | null;
  /** Storage/capture locks input while unchanged idle visuals stay installed. */
  busyInputLocked?: boolean;
  onControlsReady?(controls: CadRenderedViewControls | null, released?: CadRenderedViewControls): void;
  interactionLocked?: boolean;
  navigationLocked?: boolean;
  navigationMode?: 'mouse' | 'trackpad';
  onContextMenu?(request: CadViewportContextMenuRequest): void;
  pickMode?: CadPickMode;
  topologySelection?: CadTopologyPickSet | null;
  onTopologyPick?(hit: CadTopologyHit | null, additive: boolean): void;
  pickingEnabled?: boolean;
  getFitArea?: CadFitAreaReader;
  /**
   * A sketch surface covers the model. The view stays mounted so leaving the sketch keeps the camera and needs no new graphics context, and it
   * publishes no controls and takes no input. With `sketchView` it still draws the model behind the sketch.
   */
  hidden?: boolean;
  /** Draws the model behind the covering sketch with the sketch's own camera. The model camera stays untouched, so leaving restores it exactly. */
  sketchView?: CadSketchBackgroundView | null;
  /** Cuts the model view by a plane. While a sketch background is drawn, the sketch's own cut applies instead. */
  section?: CadViewportSection | null;
  /** Kinds a free pick may land on. Picks a command owns, such as a sketch plane or a source, ignore it. */
  selectionFilter?: CadSelectionFilter;
  selectedOrigin?: CadOriginSelection | null;
  onSelectOrigin?(selection: CadOriginSelection): void;
  /** Part view controls the workbench owns, shown with the navigation controls. */
  viewControls?: ReactNode;
  /**
   * A double-click on topology asks for its chain: the loop through an edge on `faceKey`, the face under the pointer, or with Alt its tangent
   * chain; a face asks for its tangent faces. Ctrl, Cmd or Shift adds the chain to the selection.
   */
  onTopologyChain?(hit: CadTopologyHit, gesture: CadTopologyChainGesture, additive: boolean, faceKey: string | null): void;
  /** Replaces the topology selection with these edges or faces of one body, as a box or Select other chooses them. */
  onTopologySet?(bodyId: string, picks: readonly CadTopologyPick[]): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const planeLabels = useRef<HTMLDivElement>(null);
  const depthLabel = useRef<HTMLDivElement>(null);
  const boxOverlay = useRef<HTMLDivElement>(null);
  const controller = useRef<CadRenderedViewControls | null>(null);
  const publish = useRef(onControlsReady);
  publish.current = onControlsReady;
  const sourceReferenceIds = useMemo(() => new Set(sourceReferencePickIds), [sourceReferencePickIds]);
  // Auto picking still selects whole features (references, datums, sketches) and so owns the same body-level interactions.
  const bodyLevel = pickMode === 'body' || pickMode === 'auto';
  const ownedRegions = bodyLevel && !planePickingOnly ? regionSelection : null;
  // Face picking keeps depth drags too: a click without a drag still picks the face.
  const ownedDepth = (bodyLevel || pickMode === 'face') && !planePickingOnly && !ownedRegions ? depthControl : null;
  const regionPlacementKey = ownedRegions ? JSON.stringify(ownedRegions.placement) : '';
  // Selection-only rerenders may replace wrapper arrays; prepared cells and the
  // resolved placement remain the authoritative region interaction identity.
  const referenceInteraction = ownedRegions?.cells ?? references;
  const sourceInteraction = ownedRegions?.sketchId ?? sourceReferenceIds;
  const meshInteraction = ownedRegions?.cells ?? meshes;
  const referenceVersionInteraction = ownedRegions?.expectedVersion ?? referenceVersion;
  const data = useRef({ meshes, references, referenceVersion, selectedId, onSelect, pickMode, topologySelection, onTopologyPick, interactionLocked, navigationLocked, navigationMode, onContextMenu, pickingEnabled, getFitArea, selectedReferencePlane, hoveredReferencePlane, onSelectPlane, onHoverPlane, planePickingOnly, sourceReferenceIds, regionSelection: ownedRegions, depthControl: ownedDepth, busyInputLocked, hidden, sketchView, section, selectionFilter, selectedOrigin, onSelectOrigin, onTopologyChain, onTopologySet });
  data.current = { meshes, references, referenceVersion, selectedId, onSelect, pickMode, topologySelection, onTopologyPick, interactionLocked, navigationLocked, navigationMode, onContextMenu, pickingEnabled, getFitArea, selectedReferencePlane, hoveredReferencePlane, onSelectPlane, onHoverPlane, planePickingOnly, sourceReferenceIds, regionSelection: ownedRegions, depthControl: ownedDepth, busyInputLocked, hidden, sketchView, section, selectionFilter, selectedOrigin, onSelectOrigin, onTopologyChain, onTopologySet };
  const present = useRef<((hidden: boolean, sketch: CadSketchBackgroundView | null) => void) | null>(null);
  const redraw = useRef<(() => void) | null>(null);
  const recolor = useRef<(() => void) | null>(null);
  const highlight = useRef<(() => void) | null>(null);
  const applySection = useRef<(() => void) | null>(null);
  const cancelInteraction = useRef<((preserveDepth?: boolean, preserveHover?: boolean) => void) | null>(null);
  const preserveIdleHover = useRef(false);
  const interactionOwner = useRef<{ scene: readonly unknown[]; busy: boolean } | null>(null);
  const cancelDepth = useRef<(() => void) | null>(null);
  const uploadedMeshes = useRef<readonly CadMesh[] | null>(null);
  const uploadedReferences = useRef<readonly CadViewportReference[] | null>(null);
  const uploadReferences = useRef<(() => void) | null>(null);
  const updateRegions = useRef<(() => void) | null>(null);
  const updateDepth = useRef<(() => void) | null>(null);
  const orbit = useRef<OrbitControls | null>(null);
  const [graphicsFailure, setGraphicsFailure] = useState<'unavailable' | 'lost' | null>(null);
  const [contextGeneration, setContextGeneration] = useState(0);
  const unavailable = graphicsFailure !== null;
  const [gridVisible, setGridVisible] = useState(true);
  const [viewName, setViewName] = useState<CadNamedView | 'Custom'>('Isometric');
  const [depthDragging, setDepthDragging] = useState(false);

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    let renderer: THREE.WebGLRenderer;
    // Section caps count how the cut winds round each point in the stencil buffer.
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true }); }
    catch { setGraphicsFailure('unavailable'); return; }
    setGraphicsFailure(null); setGridVisible(true); setViewName('Isometric');
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(pixelRatio);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Only materials given clipping planes are clipped: the cut behind an open sketch.
    renderer.localClippingEnabled = true;
    container.appendChild(renderer.domElement);
    renderer.domElement.tabIndex = data.current.hidden || data.current.navigationLocked && data.current.interactionLocked ? -1 : 0;
    renderer.domElement.setAttribute('aria-label', '3D model canvas');
    const scene = new THREE.Scene();
    const background = cadViewBackground(); scene.background = background;
    const regions = createCadRegionSelectionOverlay(); scene.add(regions.group);
    const camera = new THREE.OrthographicCamera(-100, 100, 100, -100, 0.01, 100000);
    camera.up.set(0, 0, 1);
    camera.position.set(160, -180, 140);
    const createOrbitControls = () => {
      const next = new OrbitControls(camera, renderer.domElement);
      next.enableDamping = false;
      next.screenSpacePanning = true;
      next.minZoom = Math.min(0.01, camera.zoom);
      next.maxZoom = 10000;
      next.enabled = !data.current.navigationLocked && !data.current.busyInputLocked;
      return next;
    };
    let controls = createOrbitControls();
    orbit.current = controls;
    scene.add(new THREE.HemisphereLight(0xd7e6ff, 0x383b43, 2));
    const light = new THREE.DirectionalLight(0xffffff, 3);
    light.position.set(100, -100, 200);
    scene.add(light);
    const grid = new THREE.GridHelper(1000, 100, 0x465666, 0x293640);
    grid.rotation.x = Math.PI / 2;
    for (const material of Array.isArray(grid.material) ? grid.material : [grid.material]) material.depthWrite = false;
    grid.renderOrder = -2;
    scene.add(grid);
    const axes = new THREE.AxesHelper(30);
    for (const material of Array.isArray(axes.material) ? axes.material : [axes.material]) material.depthWrite = false;
    axes.renderOrder = -1;
    scene.add(axes);
    const solids = new THREE.Group();
    const referenceLines = new THREE.Group();
    const pickableReferences: THREE.LineSegments[] = [];
    const installedReferences = new Map<string, { reference: CadViewportReference; line: THREE.LineSegments; patch?: THREE.Mesh }>();
    // Lines an open sketch leaves out of its background, out of the scene but kept with their buffers and shader programs, so
    // leaving the sketch shows them again without rebuilding them.
    const setAsideReferences = new Map<string, { reference: CadViewportReference; line: THREE.LineSegments; patch?: THREE.Mesh }>();
    const pickableBodies: THREE.Mesh[] = [];
    const pickableEdges: THREE.LineSegments[] = [];
    const meshByObject = new Map<THREE.Object3D, CadMesh>();
    const highlights = createCadTopologyHighlights();
    scene.add(solids);
    scene.add(referenceLines);
    scene.add(highlights.objects);
    // Behind an open sketch the view draws through the sketch's camera, so the model camera keeps its exact place for the return.
    const sketchCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const sketchClip = new THREE.Plane(), sketchClipPlanes = [sketchClip];
    // A section cuts the model view while no sketch covers it; an open sketch's own cut replaces it.
    const sectionClip = new THREE.Plane(), sectionClipPlanes = [sectionClip];
    let sectionShown = false;
    // The caps join the scene only while a capped section shows, so a view without one draws and walks nothing extra. Caps of large
    // bodies finish in later slices, and then draw.
    const caps = createCadSectionCaps({ onChange: () => { if (!disposed) { placeCaps(); render(); } } });
    const placeCaps = () => { if (!caps.group.visible) scene.remove(caps.group); else if (caps.group.parent !== scene) scene.add(caps.group); };
    const solidBounds = new THREE.Box3();
    /** The clip a pick honours: the section's in the model view, none otherwise. */
    const pickClip = () => sectionShown && !sketch ? sectionClip : null;
    // Picks of bodies, edges and outlines use this copy of the pointer ray, limited to the kept side of a section.
    const clippedRay = new THREE.Raycaster();
    const dim = createCadBackgroundDim();
    // Covered by a sketch, the view draws only as that sketch's background. Otherwise, while hidden, it neither draws nor sizes itself, and
    // model uploads wait until it is shown again.
    let sketch: CadSketchBackgroundView | null = data.current.hidden ? data.current.sketchView : null;
    let visible = !data.current.hidden || sketch !== null;
    let releaseSketchCamera: (() => void) | null = null;
    // Scene bounds set the sketch camera's depth range and the cut tolerance; they change only with the model.
    const sceneBounds = new THREE.Box3();
    let sceneBoundsCurrent = false;
    const currentSceneBounds = () => {
      if (!sceneBoundsCurrent) { sceneBounds.makeEmpty(); sceneBounds.expandByObject(solids); sceneBounds.expandByObject(referenceLines); sceneBoundsCurrent = true; }
      return sceneBounds;
    };
    /** Every frame drawn, counted on the host so tests can tell that sketch hover and drag draw none. */
    let framesDrawn = 0;
    let frame: number | null = null;
    let disposed = false;
    let pendingHover: PointerEvent | null = null;
    let hoveredFeatureId: string | null = null;
    let namedDirection = camera.position.clone().sub(controls.target).normalize();
    const viewState: { view: CadNamedView | 'Custom'; gridVisible: boolean; revision: number; hoveredTopology: CadTopologyHit | null } = { view: 'Isometric', gridVisible: true, revision: 0, hoveredTopology: null };
    let depthPointer: number | null = null;
    const releaseDepthCapture = () => {
      const pointerId = depthPointer; depthPointer = null;
      if (pointerId === null) return;
      try { if (renderer.domElement.hasPointerCapture?.(pointerId)) renderer.domElement.releasePointerCapture(pointerId); }
      catch { /* The platform may already have released this capture. */ }
    };
    const updateDepthLabel = () => {
      const label = depthLabel.current, state = depth.getState(); if (!label) return;
      label.hidden = !state?.visible || renderer.getContext().isContextLost();
      if (!state) return;
      label.textContent = state.capability.kind === 'locked' && state.hovered ? state.capability.reason : state.label;
      label.dataset.active = String(state.active); label.dataset.locked = String(state.capability.kind === 'locked');
      label.style.left = `${Math.max(4, Math.min(container.clientWidth - label.offsetWidth - 4, state.screenPoint.x + 16))}px`;
      label.style.top = `${Math.max(4, Math.min(container.clientHeight - label.offsetHeight - 4, state.screenPoint.y - 12))}px`;
    };
    const depth = createCadExtrudeDepthHandle({
      requestRender() { if (!disposed) { viewState.revision++; updateDepthLabel(); render(); } },
      onInteractionChange(active) {
        if (!active) releaseDepthCapture();
        controls.enabled = !active && !data.current.navigationLocked;
        if (!disposed) setDepthDragging(active);
      }
    });
    let installedReferenceVersion: string | null = null;
    let installedReferenceFeatureIds: readonly string[] = Object.freeze([]);
    let installedReferencePlanes: readonly CadPlane[] = Object.freeze([]);
    let hoveredPlaneReference: string | null = null;
    const updatePlaneLabels = () => {
      camera.updateMatrixWorld();
      for (const label of planeLabels.current?.querySelectorAll<HTMLElement>('[data-cad-plane-label]') ?? []) {
        const reference = installedReferences.get(label.dataset.cadPlaneLabel ?? '')?.reference;
        if (!reference?.labelPosition) { label.hidden = true; continue; }
        const point = new THREE.Vector3(...reference.labelPosition).project(camera);
        label.hidden = point.z < -1 || point.z > 1 || Math.abs(point.x) > 1 || Math.abs(point.y) > 1;
        label.style.left = `${(point.x + 1) * container.clientWidth / 2}px`;
        label.style.top = `${(1 - point.y) * container.clientHeight / 2}px`;
      }
    };
    const render = () => {
      if (frame !== null || !visible) return;
      frame = requestAnimationFrame(() => {
        if (disposed || renderer.getContext().isContextLost()) { frame = null; return; }
        if (sketch) {
          // Nothing behind the sketch takes pointer input, so a frame here only follows the sketch camera or the model.
          frame = null;
          const view = sketch.camera.current();
          if (!view) return;
          const bounds = currentSceneBounds();
          syncCadSketchCamera(sketchCamera, sketch.placement, view, bounds);
          cadSketchClipPlane(sketch.placement, cadSketchClipTolerance(bounds), sketchClip);
          updateReferenceStyles(); renderer.render(scene, sketchCamera); countFrame();
          return;
        }
        depth.setView(camera, container.clientWidth, container.clientHeight); updateDepthLabel();
        const event = pendingHover; pendingHover = null;
        if (event && !down && depthPointer === null && !event.buttons && (!data.current.interactionLocked || data.current.depthControl)) {
          setRay(event);
          depth.hover(localPixel(event));
          if (depth.hitTest(localPixel(event))) { setHover(null); setFeatureHover(null); }
          else if (data.current.interactionLocked) { setHover(null); setFeatureHover(null); }
          else if (data.current.regionSelection) setRegionHover(raycaster.ray);
          else if (data.current.pickMode === 'body' || data.current.planePickingOnly || data.current.pickMode === 'auto' && !data.current.pickingEnabled) {
            const feature = data.current.planePickingOnly ? null : hitFeature(false), origin = feature ? null : hitOrigin();
            setFeatureHover(data.current.planePickingOnly ? null : feature ?? (origin ? null : hitFeature()), (origin ?? hitPlane())?.referenceId ?? null);
          }
          else if (data.current.pickMode === 'auto') {
            // A reference, datum or sketch in front wins, then an origin axis or point; otherwise the nearest edge or the face under the pointer.
            const feature = hitFeature(false), origin = feature ? null : hitOrigin(), topology = feature || origin ? null : hitTopology();
            setHover(topology); setFeatureHover(feature, feature || topology ? null : (origin ?? hitPlane())?.referenceId ?? null);
          }
          else if (data.current.pickingEnabled) setHover(hitTopology());
        }
        updateReferenceStyles(); updatePlaneLabels(); renderer.render(scene, camera); countFrame(); frame = null;
      });
    };
    const countFrame = () => { framesDrawn++; container.dataset.cadFramesDrawn = String(framesDrawn); };
    let renderedWidth = 0, renderedHeight = 0;
    const resize = () => {
      if (!visible) return;
      const width = Math.max(1, container.clientWidth);
      const height = Math.max(1, container.clientHeight);
      if (width !== renderedWidth || height !== renderedHeight) {
        renderedWidth = width; renderedHeight = height;
        const halfHeight = 85;
        camera.left = -halfHeight * width / height;
        camera.right = halfHeight * width / height;
        camera.top = halfHeight;
        camera.bottom = -halfHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height);
        dim.setHeight(Math.floor(height * pixelRatio));
        highlights.resize(width, height);
        viewState.revision++;
      }
      render();
    };
    // A reference-only scene and its first solid have separate initial frames.
    // Later rebuilds, or an explicitly chosen camera, never trigger another fit.
    let fittedReferences = false, fittedSolid = false, userFramed = false, fittingAutomatically = false;
    // While a sketch surface covers the view the model camera stays where the sketch found it, so leaving returns to it exactly. A first
    // fit asked for meanwhile waits, and runs on leaving only when the view had nothing but planes to show before the sketch opened.
    let cover: { geometryBefore: boolean; fitWaiting: boolean } | null = data.current.hidden ? { geometryBefore: false, fitWaiting: false } : null;
    const showsGeometry = () => solids.children.length > 0 || [...installedReferences.values(), ...setAsideReferences.values()].some(({ reference }) => isCadContourReference(reference));
    const fitFirst = () => {
      if (userFramed) return;
      if (cover) cover.fitWaiting = true; else fit(true);
    };
    const fit = (automatic = false) => {
      if (!automatic) userFramed = true;
      fittingAutomatically = automatic;
      try {
        const area = readCadFitArea(container, data.current.getFitArea);
        if (!area) return;
        const bounds = new THREE.Box3().setFromObject(solids);
        if (!automatic && data.current.regionSelection) {
          const regionBounds = regions.getBounds(); if (regionBounds) bounds.union(regionBounds);
        } else {
          const contours = data.current.references.filter(isCadContourReference);
          // With nothing else to show, the planes frame the view; the origin axes and point never do.
          const fitReferences = !bounds.isEmpty() || contours.length ? contours : data.current.references.filter(reference => !isCadOriginMarker(reference));
          for (const reference of fitReferences) bounds.union(new THREE.Box3(new THREE.Vector3(...reference.bounds.min), new THREE.Vector3(...reference.bounds.max)));
        }
        const center = bounds.isEmpty() ? new THREE.Vector3() : bounds.getCenter(new THREE.Vector3());
        const size = bounds.isEmpty() ? new THREE.Vector3(100, 100, 100) : bounds.getSize(new THREE.Vector3());
        const direction = camera.position.clone().sub(controls.target).normalize();
        camera.zoom = Math.min((camera.right - camera.left) * area.width / container.clientWidth, (camera.top - camera.bottom) * area.height / container.clientHeight) / Math.max(20, size.length() * 1.18);
        // Explicit Fit must not be clipped by the navigation limit on large parts.
        controls.minZoom = Math.min(0.01, camera.zoom);
        camera.updateMatrixWorld();
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion), up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
        center.addScaledVector(right, (container.clientWidth / 2 - area.left - area.width / 2) * (camera.right - camera.left) / (camera.zoom * container.clientWidth));
        center.addScaledVector(up, (area.top + area.height / 2 - container.clientHeight / 2) * (camera.top - camera.bottom) / (camera.zoom * container.clientHeight));
        controls.target.copy(center);
        camera.position.copy(center).addScaledVector(direction, Math.max(200, size.length() * 3));
        camera.far = Math.max(100000, size.length() * 10);
        camera.updateProjectionMatrix();
        controls.update();
        render();
      } finally { fittingAutomatically = false; }
    };
    const disposeSolids = () => {
      pickableBodies.length = 0;
      pickableEdges.length = 0;
      meshByObject.clear();
      for (const child of [...solids.children]) {
        if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
          child.geometry.dispose();
          const materials = Array.isArray(child.material) ? child.material : [child.material];
          for (const material of materials) material.dispose();
        }
        solids.remove(child);
      }
    };
    const disposeReferences = () => {
      for (const { line, patch } of [...installedReferences.values(), ...setAsideReferences.values()]) disposeReference(line, patch);
      installedReferences.clear(); setAsideReferences.clear();
      pickableReferences.length = 0;
    };
    const disposeReference = (line: THREE.LineSegments, patch?: THREE.Mesh) => {
      if (patch) { patch.geometry.dispose(); for (const material of Array.isArray(patch.material) ? patch.material : [patch.material]) material.dispose(); referenceLines.remove(patch); }
      line.geometry.dispose();
      for (const material of Array.isArray(line.material) ? line.material : [line.material]) material.dispose();
      referenceLines.remove(line);
    };
    const referenceSelected = (reference: CadViewportReference) => reference.plane ? cadSameReferencePlane(reference.plane, data.current.selectedReferencePlane)
      || reference.featureId !== null && reference.featureId === data.current.selectedId
      : isCadOriginMarker(reference) ? sameOrigin(reference, data.current.selectedOrigin) : reference.featureId === data.current.selectedId;
    const referenceHovered = (reference: CadViewportReference) => reference.referenceId === hoveredPlaneReference || reference.featureId !== null && reference.featureId === hoveredFeatureId
      || Boolean(reference.plane) && cadSameReferencePlane(reference.plane ?? null, data.current.hoveredReferencePlane);
    const referenceColor = (reference: CadViewportReference) => referenceSelected(reference) ? 0xf0c779 : referenceHovered(reference) ? 0x91edff
      : reference.featureKind === 'principal-plane' ? ({ XY: 0x80b7d4, XZ: 0x94cda4, YZ: 0xd2aaa0 }[reference.plane])
        : reference.featureKind === 'origin-axis' ? ORIGIN_AXIS_COLORS[reference.axis] : reference.featureKind === 'origin-point' ? 0xe7edf2 : reference.construction ? 0x698594 : 0x89b9c6;
    const isPickingSource = (reference: CadViewportReference) => (data.current.pickMode === 'body' || data.current.pickMode === 'auto') && !data.current.planePickingOnly
      && (reference.featureKind === 'sketch' || reference.featureKind === 'curve') && reference.featureId !== null && data.current.sourceReferenceIds.has(reference.featureId);
    const updateReferenceStyles = () => {
      referenceLines.visible = !data.current.regionSelection;
      const drawing = sketch ? sketchCamera : camera;
      const worldPerPixel = (drawing.top - drawing.bottom) / drawing.zoom / Math.max(1, container.clientHeight);
      for (const { reference, line, patch } of installedReferences.values()) {
        if (patch && patch.material instanceof THREE.MeshBasicMaterial) { patch.material.color.setHex(referenceColor(reference)); patch.material.opacity = referenceSelected(reference) ? .18 : referenceHovered(reference) ? .12 : .075; }
        if (line.material instanceof THREE.LineBasicMaterial) {
          // Source choice must expose a valid sketch/curve enclosed by a solid.
          // Normal viewing and topology picking retain ordinary hidden-line depth.
          const pickingSource = isPickingSource(reference);
          line.material.color.setHex(pickingSource ? reference.featureId === hoveredFeatureId ? 0xa6440e : 0xb84f18 : referenceColor(reference));
          line.material.depthTest = !pickingSource;
          line.material.depthWrite = !pickingSource && !reference.construction;
        }
        if (line.material instanceof THREE.LineDashedMaterial) { line.material.dashSize = worldPerPixel * 6; line.material.gapSize = worldPerPixel * 4; }
        // The origin marker keeps five pixels per arm at every zoom; only its scale changes, never its buffers.
        if (reference.featureKind === 'origin-point' && line.scale.x !== worldPerPixel * 5) { line.scale.setScalar(worldPerPixel * 5); line.updateMatrixWorld(); }
      }
    };
    // Every model material carries the dim, at zero outside a sketch, so switching Normal and Dimmed compiles nothing.
    /** The cut the model's materials carry: the open sketch's, else the section's. */
    const modelClip = () => sketch ? sketch.cutBySketchPlane ? sketchClipPlanes : null : sectionShown ? sectionClipPlanes : null;
    /** Behind a sketch every line follows its cut; in the model view a section leaves planes, axes and points whole. */
    const referenceClip = (contour: boolean) => sketch || contour ? modelClip() : null;
    const styleMaterial = <T extends THREE.Material>(material: T, contour = true): T => {
      dim.install(material);
      material.clippingPlanes = referenceClip(contour);
      return material;
    };
    /** Applies the open sketch's background and cut, or the plain model view when no sketch is open. */
    const applySketchStyle = () => {
      const clip = modelClip();
      for (const group of [solids, referenceLines]) for (const child of group.children) {
        if (!(child instanceof THREE.Mesh || child instanceof THREE.LineSegments)) continue;
        // three.js compiles the cut into the program and recompiles when the number of planes changes.
        const planes = group === solids ? clip : referenceClip(child.userData.contour === true);
        for (const material of Array.isArray(child.material) ? child.material : [child.material]) material.clippingPlanes = planes;
      }
      highlights.setClippingPlanes(sketch ? null : clip);
      caps.setPlane(sectionShown && !sketch && data.current.section?.caps ? sectionClip : null);
      placeCaps();
      dim.setAmount(sketch?.background === 'dimmed' ? CAD_SKETCH_DIM_AMOUNT : 0);
      // The grid, axes and pick highlights belong to the model view; the sketch draws its own.
      grid.visible = !sketch && viewState.gridVisible; axes.visible = !sketch; highlights.objects.visible = !sketch;
    };
    const updateReferences = () => {
      const changed = uploadedReferences.current !== data.current.references;
      if (changed) {
        const wanted = new Map(data.current.references.map(reference => [reference.referenceId, reference]));
        // Read from the props, since this runs before the view hears that a sketch opened or closed.
        const behindSketch = data.current.hidden && data.current.sketchView !== null;
        for (const [id, installed] of installedReferences) {
          const next = wanted.get(id);
          if (next === installed.reference) continue;
          installedReferences.delete(id);
          if (next || !behindSketch) { disposeReference(installed.line, installed.patch); continue; }
          referenceLines.remove(installed.line); if (installed.patch) referenceLines.remove(installed.patch);
          setAsideReferences.set(id, installed);
        }
        for (const [id, kept] of setAsideReferences) {
          const next = wanted.get(id);
          if (!next && behindSketch) continue;
          setAsideReferences.delete(id);
          if (next !== kept.reference) { disposeReference(kept.line, kept.patch); continue; }
          // The cut as the view stands; when a sketch closes, the style pass that follows sets it for every line again.
          for (const object of kept.patch ? [kept.line, kept.patch] : [kept.line]) {
            for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.clippingPlanes = referenceClip(object.userData.contour === true);
            referenceLines.add(object);
          }
          installedReferences.set(id, kept);
        }
        for (const reference of data.current.references) {
          if (installedReferences.has(reference.referenceId)) continue;
          // Float32 world vertices lose small curves far from the origin. Keep
          // GPU coordinates local; Three composes the world/camera translations
          // in double precision before uploading the model-view matrix.
          const origin = cadRenderOrigin(reference.bounds);
          const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(cadLocalRenderPositions(reference.positions, origin), 3));
          const contour = isCadContourReference(reference);
          const material = styleMaterial(reference.construction ? new THREE.LineDashedMaterial({ color: referenceColor(reference), depthWrite: false }) : new THREE.LineBasicMaterial({ color: referenceColor(reference) }), contour);
          const line = new THREE.LineSegments(geometry, material);
          line.userData.contour = contour;
          if (reference.construction) line.computeLineDistances();
          line.position.set(origin[0], origin[1], origin[2]);
          line.userData.featureKind = reference.featureKind; line.userData.featureId = reference.featureId; line.userData.referenceId = reference.referenceId; referenceLines.add(line); line.updateMatrixWorld(true);
          let patch: THREE.Mesh | undefined;
          if (reference.planePatch) {
            const patchGeometry = new THREE.BufferGeometry(); patchGeometry.setAttribute('position', new THREE.BufferAttribute(cadLocalRenderPositions(reference.planePatch, origin), 3));
            // A flat patch shows one side per pixel, so one pass draws what three.js's back-then-front passes would, without looking up its program twice a frame.
            patch = new THREE.Mesh(patchGeometry, styleMaterial(new THREE.MeshBasicMaterial({ color: referenceColor(reference), transparent: true, opacity: .055, side: THREE.DoubleSide, depthWrite: false, forceSinglePass: true }), false));
            patch.position.set(...origin); patch.userData.featureId = reference.featureId; patch.userData.referenceId = reference.referenceId; referenceLines.add(patch); patch.updateMatrixWorld(true);
          }
          installedReferences.set(reference.referenceId, { reference, line, patch });
        }
        // Picked and drawn in the order of the references, which a kept line would otherwise leave for the lines installed
        // after it: equal render orders draw in the order their materials were made. Orders stay between 1 and 2.
        pickableReferences.length = 0;
        for (const id of wanted.keys()) { const installed = installedReferences.get(id); if (installed) pickableReferences.push(installed.line); }
        pickableReferences.forEach((line, index) => { line.renderOrder = 1 + index / pickableReferences.length; });
        uploadedReferences.current = data.current.references;
        sceneBoundsCurrent = false;
      }
      installedReferenceVersion = data.current.referenceVersion;
      installedReferenceFeatureIds = cadReferenceFeatureIds(data.current.references);
      installedReferencePlanes = cadReferencePlanes(data.current.references);
      viewState.revision++;
      if (!fittedReferences && !fittedSolid && data.current.references.length && !data.current.meshes.length) {
        fittedReferences = true;
        fitFirst();
      }
      // Behind a sketch only changed lines need a frame; a new reference version alone, such as a sketch edit, draws nothing new.
      if (changed || !sketch) render();
    };
    const update = () => {
      uploadedMeshes.current = data.current.meshes;
      disposeSolids();
      for (const mesh of data.current.meshes) {
        const origin = cadRenderOrigin(mesh.bounds);
        const display = prepareCadMeshDisplay(mesh);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(cadLocalRenderPositions(mesh.positions, origin), 3));
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(display.normals, 3));
        geometry.setIndex(new THREE.Uint32BufferAttribute(mesh.indices, 1));
        const selected = mesh.featureId === data.current.selectedId;
        const material = styleMaterial(new THREE.MeshStandardMaterial({ color: selected ? 0x79c8e6 : 0xa3b0bf, roughness: 0.55, metalness: 0.18, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
        const body = new THREE.Mesh(geometry, material);
        body.position.set(...origin);
        body.userData.featureId = mesh.featureId;
        solids.add(body);
        pickableBodies.push(body);
        meshByObject.set(body, mesh);
        const edges = new THREE.BufferGeometry();
        edges.setAttribute('position', new THREE.BufferAttribute(cadLocalRenderPositions(mesh.edges, origin), 3));
        const lines = new THREE.LineSegments(edges, styleMaterial(new THREE.LineBasicMaterial({ color: selected ? 0xb5eafd : 0x344452 })));
        lines.material.visible = data.current.pickMode === 'edge';
        lines.position.set(...origin);
        lines.userData.featureId = mesh.featureId;
        lines.userData.nativeEdges = true;
        solids.add(lines);
        pickableEdges.push(lines);
        meshByObject.set(lines, mesh);
        const displayEdges = new THREE.BufferGeometry();
        displayEdges.setAttribute('position', new THREE.BufferAttribute(cadLocalRenderPositions(display.edges, origin), 3));
        const outline = new THREE.LineSegments(displayEdges, styleMaterial(new THREE.LineBasicMaterial({ color: selected ? 0xb5eafd : 0x344452 })));
        outline.material.visible = data.current.pickMode !== 'edge';
        outline.position.set(...origin); outline.userData.featureId = mesh.featureId; outline.userData.displayEdges = true;
        solids.add(outline);
      }
      sceneBoundsCurrent = false;
      solidBounds.makeEmpty(); solidBounds.expandByObject(solids);
      caps.setBodies(pickableBodies, body => { const mesh = meshByObject.get(body); return mesh && cadCapBodySolids(mesh); });
      syncSection(); applySketchStyle();
      if (!fittedSolid && data.current.meshes.length) {
        fittedSolid = true;
        fitFirst();
      }
      viewState.hoveredTopology = null;
      hoveredFeatureId = null;
      updateHighlights();
      render();
    };
    /** Places the section plane for the model as it stands; the tolerance follows the model's size. */
    const syncSection = () => {
      const next = data.current.section;
      sectionShown = Boolean(next);
      if (next) cadSectionClipPlane(next.frame, next.flip, cadSketchClipTolerance(solidBounds.isEmpty() ? null : solidBounds), sectionClip);
    };
    const updateSection = () => {
      syncSection(); applySketchStyle();
      // A hover on the side just removed must not stay lit; the next pointer move finds what is under it now.
      pendingHover = null; setHover(null); setFeatureHover(null);
      viewState.revision++; render();
    };
    const updateHighlights = () => {
      if (highlights.update({ meshes: data.current.meshes, selection: data.current.topologySelection, hover: viewState.hoveredTopology })) {
        viewState.revision++; render();
      }
    };
    const setHover = (hit: CadTopologyHit | null) => {
      const previous = viewState.hoveredTopology;
      if (previous?.bodyId === hit?.bodyId && previous?.pick.key === hit?.pick.key) return;
      viewState.hoveredTopology = hit;
      updateHighlights();
    };
    const updateSelection = () => {
      for (const child of solids.children) {
        // A picked face or edge highlights itself; tinting its whole body would hide which one is selected.
        const selected = child.userData.featureId === data.current.selectedId && !data.current.topologySelection?.picks.length;
        const hovered = child.userData.featureId === hoveredFeatureId;
        if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshStandardMaterial) child.material.color.setHex(selected ? 0x79c8e6 : hovered ? 0xb2d2df : 0xa3b0bf);
        else if (child instanceof THREE.LineSegments && child.material instanceof THREE.LineBasicMaterial) {
          child.material.color.setHex(selected ? 0xb5eafd : hovered ? 0x91edff : 0x344452);
          if (child.userData.nativeEdges) child.material.visible = data.current.pickMode === 'edge';
          if (child.userData.displayEdges) child.material.visible = data.current.pickMode !== 'edge';
        }
      }
      updateReferenceStyles();
      render();
    };
    // The tree mirrors canvas hover only for planes: a principal plane, or a datum plane's glyph.
    let reportedPlaneHover: string | null = null;
    const reportPlaneHover = () => {
      const entries = [...installedReferences.values()].map(entry => entry.reference);
      const reference = entries.find(entry => entry.referenceId === hoveredPlaneReference)
        ?? (hoveredFeatureId === null ? undefined : entries.find(entry => entry.featureKind === 'datum-plane' && entry.featureId === hoveredFeatureId));
      const plane = reference?.plane ?? null, key = plane === null ? null : typeof plane === 'string' ? plane : `datum:${plane.featureId}`;
      if (key === reportedPlaneHover) return;
      reportedPlaneHover = key; data.current.onHoverPlane?.(plane);
    };
    const setFeatureHover = (id: string | null, planeId: string | null = null) => {
      if (hoveredFeatureId === id && hoveredPlaneReference === planeId) return;
      hoveredFeatureId = id; hoveredPlaneReference = planeId; viewState.revision++; updateSelection(); reportPlaneHover();
    };
    const setRegionHover = (ray: THREE.Ray | null) => { if (regions.hover(ray)) { viewState.revision++; render(); } };
    const updateRegionSelection = () => { if (regions.update(data.current.regionSelection)) { viewState.revision++; render(); } };
    const updateDepthSelection = () => {
      depth.update(data.current.depthControl, data.current.busyInputLocked);
      if (data.current.depthControl) { if (!depth.group.parent) scene.add(depth.group); }
      else scene.remove(depth.group);
      depth.setView(camera, container.clientWidth, container.clientHeight); updateDepthLabel();
    };
    const raycaster = new THREE.Raycaster();
    let down: { pointerId: number; button: number; x: number; y: number; moved: boolean } | null = null;
    const activePointers = new Set<number>();
    const setRay = (event: { readonly clientX: number; readonly clientY: number }) => {
      const rect = renderer.domElement.getBoundingClientRect();
      raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / Math.max(1, rect.width) * 2 - 1, -(event.clientY - rect.top) / Math.max(1, rect.height) * 2 + 1), camera);
      clippedRay.ray.copy(raycaster.ray); clippedRay.camera = camera; cadClipRaycaster(clippedRay, pickClip());
    };
    /** A command that owns the pick, such as a sketch-plane request, a source or a region pick, is not filtered. */
    const accepts = (kind: CadSelectionKind) => data.current.planePickingOnly || data.current.sourceReferenceIds.size > 0 || Boolean(data.current.regionSelection)
      || cadSelectionAccepts(data.current.selectionFilter, kind);
    /** The topology a free pick may land on: Auto narrows to edges or faces when the filter leaves only one of them. */
    const topologyMode = (): 'auto' | 'edge' | 'face' | null => {
      const mode = data.current.pickMode;
      if (mode === 'body') return null;
      if (mode !== 'auto') return mode;
      const edges = accepts('edge'), faces = accepts('face');
      return edges && faces ? 'auto' : edges ? 'edge' : faces ? 'face' : null;
    };
    const localPixel = (event: PointerEvent) => { const rect = renderer.domElement.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
    const hitTopology = () => { const mode = topologyMode(); return mode === null ? null : pickTopology({ mode,
      raycaster: clippedRay, bodies: pickableBodies, edges: pickableEdges, meshByObject, camera, viewportHeight: container.clientHeight, clip: pickClip() }); };
    /** Without `includeBodies`, only features drawn over the solid (references, datums, sketches) are returned. */
    const hitFeature = (includeBodies = true): string | null => {
      if (data.current.sourceReferenceIds.size && !data.current.planePickingOnly) {
        const sourceReferences = pickableReferences.filter(line => {
          const reference = installedReferences.get(line.userData.referenceId)?.reference;
          return reference && isPickingSource(reference);
        });
        const sourceId = pickCadCurveReference({ raycaster: clippedRay, references: sourceReferences, bodies: [], camera, viewportHeight: container.clientHeight, clip: pickClip(), cut: true });
        if (sourceId) return sourceId;
      }
      const clip = pickClip(), viewportHeight = container.clientHeight;
      // Sketch and curve outlines are cut with the bodies, so they are picked along the kept part of the ray only.
      const referenceId = pickCadCurveReference({ raycaster: clippedRay, references: pickableReferences.filter(line => line.userData.contour === true), bodies: pickableBodies, camera, viewportHeight, clip, cut: true });
      if (referenceId) return referenceId;
      const planes = accepts('plane');
      const datumId = planes ? pickCadCurveReference({ raycaster, references: pickableReferences.filter(line => line.userData.featureKind === 'datum-plane'), bodies: pickableBodies, camera, viewportHeight, clip }) : null;
      if (datumId) return datumId;
      const patches = planes ? [...installedReferences.values()].flatMap(entry => entry.patch && entry.reference.featureId !== null ? [entry.patch] : []) : [];
      const patchHit = patches.length ? raycaster.intersectObjects(patches, false)[0] : undefined;
      const surface = clippedRay.intersectObjects(pickableBodies, false)[0];
      if (patchHit && (!surface || patchHit.distance <= surface.distance + 1e-7)) return patchHit.object.userData.featureId;
      const id: unknown = data.current.pickingEnabled && includeBodies && accepts('body') ? surface?.object.userData.featureId : null;
      return typeof id === 'string' ? id : null;
    };
    /** The origin point, else an origin axis, near the pointer and not behind kept material. */
    const hitOrigin = (): CadViewportReference | null => {
      if (data.current.planePickingOnly || data.current.sourceReferenceIds.size || data.current.regionSelection) return null;
      const options = { raycaster, bodies: pickableBodies, camera, viewportHeight: container.clientHeight, clip: pickClip(), key: 'referenceId' as const };
      const lines = (kind: 'origin-point' | 'origin-axis') => pickableReferences.filter(line => line.userData.featureKind === kind);
      const id = (accepts('point') ? pickCadCurveReference({ ...options, references: lines('origin-point') }) : null)
        ?? (accepts('axis') ? pickCadCurveReference({ ...options, references: lines('origin-axis') }) : null);
      return id ? installedReferences.get(id)?.reference ?? null : null;
    };
    const selectOrigin = (reference: CadViewportReference) => { const selection = originSelection(reference); if (selection) data.current.onSelectOrigin?.(selection); };
    const hitPlane = (): CadViewportReference | null => {
      if (!accepts('plane')) return null;
      const planeLines = pickableReferences.filter(line => installedReferences.get(line.userData.referenceId)?.reference.plane);
      raycaster.params.Line.threshold = (camera.top - camera.bottom) / camera.zoom / Math.max(1, container.clientHeight) * 5;
      const patches = [...installedReferences.values()].flatMap(entry => entry.patch && entry.reference.plane ? [entry.patch] : []);
      const hit = raycaster.intersectObjects([...planeLines, ...patches], false)[0];
      return hit ? installedReferences.get(hit.object.userData.referenceId)?.reference ?? null : null;
    };
    /** The face under the pointer, whatever the filter, which the loop through an edge follows. */
    const faceUnder = () => pickTopology({ mode: 'face', raycaster: clippedRay, bodies: pickableBodies, edges: pickableEdges, meshByObject, camera, viewportHeight: container.clientHeight, clip: pickClip() });
    /** Where the pointer last was over the view, kept so N can work there; nothing else is done on a move. */
    let lastPointer: { clientX: number; clientY: number } | null = null;
    /**
     * The candidates under the ray for Select other, in a stable order: the topology the pick mode and filter allow, visible edges nearest the
     * pointer and then faces by depth, those behind included; in body picking the bodies by depth; then the planes by depth.
     */
    const otherCandidates = (): CadViewportOther[] => {
      const current = data.current;
      if (current.regionSelection || current.sourceReferenceIds.size) return [];
      const found: CadViewportOther[] = [];
      const mode = current.planePickingOnly ? null : topologyMode();
      if (mode && current.pickingEnabled) for (const hit of topologyCandidates({ mode, raycaster: clippedRay, bodies: pickableBodies, edges: pickableEdges, meshByObject, camera, viewportHeight: container.clientHeight, clip: pickClip() }))
        found.push({ kind: 'topology', hit });
      if (current.pickMode === 'body' && !current.planePickingOnly && current.pickingEnabled && accepts('body')) {
        const seen = new Set<string>();
        for (const hit of clippedRay.intersectObjects(pickableBodies, false)) {
          const id: unknown = hit.object.userData.featureId;
          if (typeof id === 'string' && !seen.has(id)) { seen.add(id); found.push({ kind: 'body', featureId: id }); }
        }
      }
      if ((current.pickMode === 'auto' || current.pickMode === 'body') && accepts('plane')) {
        const planeLines = pickableReferences.filter(line => installedReferences.get(line.userData.referenceId)?.reference.plane);
        raycaster.params.Line.threshold = (camera.top - camera.bottom) / camera.zoom / Math.max(1, container.clientHeight) * 5;
        const patches = [...installedReferences.values()].flatMap(entry => entry.patch && entry.reference.plane ? [entry.patch] : []);
        const seen = new Set<string>();
        for (const hit of raycaster.intersectObjects([...planeLines, ...patches], false)) {
          const plane = installedReferences.get(hit.object.userData.referenceId)?.reference.plane;
          if (!plane || seen.has(planeKey(plane))) continue;
          seen.add(planeKey(plane)); found.push({ kind: 'plane', key: planeKey(plane), plane });
        }
      }
      return found;
    };
    /** The selection as Select other sees it: the picked edges or faces, the selected plane and, in body picking, the selected body. */
    const currentOthers = (): CadViewportOther[] => {
      const current = data.current, selection = current.topologySelection;
      return [...selection ? selection.picks.map(pick => ({ kind: 'topology' as const, hit: { bodyId: selection.bodyId, pick } })) : [],
        ...current.selectedReferencePlane ? [{ kind: 'plane' as const, key: planeKey(current.selectedReferencePlane), plane: current.selectedReferencePlane }] : [],
        ...current.pickMode === 'body' && current.selectedId ? [{ kind: 'body' as const, featureId: current.selectedId }] : []];
    };
    /**
     * Select other: the next candidate takes the place of the selected one. Within edges or faces of one body it swaps in place and the rest
     * stay selected; otherwise it is selected alone. Shift goes back.
     */
    const stepOther = (candidates: readonly CadViewportOther[], direction: 1 | -1) => {
      const current = data.current, step = cadSelectOtherStep(candidates, currentOthers(), sameOther, direction);
      if (!step || current.interactionLocked || current.busyInputLocked) return false;
      const candidate = step.candidate, replaces = step.replaces, selection = current.topologySelection;
      if (candidate.kind === 'topology') {
        const swap = replaces?.kind === 'topology' && selection?.bodyId === candidate.hit.bodyId && selection.picks.every(pick => pick.kind === candidate.hit.pick.kind);
        const picks = swap ? cadSelectOtherApply(selection.picks, { candidate: candidate.hit.pick, index: step.index, replaces: replaces.hit.pick }, samePick) : [candidate.hit.pick];
        if (current.onTopologySet) current.onTopologySet(candidate.hit.bodyId, picks); else current.onTopologyPick?.(candidate.hit, false);
      } else if (candidate.kind === 'plane') current.onSelectPlane?.(candidate.plane);
      else current.onSelect(candidate.featureId);
      return true;
    };
    const selectOtherKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'n' || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.defaultPrevented) return;
      const current = data.current, at = lastPointer;
      if (!at || current.hidden || current.busyInputLocked || current.interactionLocked || depthPointer !== null || box || renderer.getContext().isContextLost()) return;
      setRay(at);
      if (stepOther(otherCandidates(), event.shiftKey ? -1 : 1)) { event.preventDefault(); event.stopPropagation(); }
    };
    /**
     * A double-click on an edge selects its loop on the face under the pointer, and with Alt its tangent chain; on a face, its tangent faces.
     * Ctrl, Cmd or Shift adds to the selection. This follows the loop and tangency selections of SOLIDWORKS and Fusion.
     */
    const doubleClick = (event: MouseEvent) => {
      const current = data.current;
      if (event.button !== 0 || !current.onTopologyChain || current.hidden || current.busyInputLocked || current.interactionLocked || !current.pickingEnabled || current.planePickingOnly
        || current.regionSelection || current.sourceReferenceIds.size || current.pickMode === 'body' || depthPointer !== null || box || renderer.getContext().isContextLost()) return;
      setRay(event);
      if (current.pickMode === 'auto' && (hitFeature(false) || hitOrigin())) return;
      const hit = hitTopology();
      if (!hit) return;
      const face = hit.pick.kind === 'edge' ? faceUnder() : null;
      event.preventDefault();
      current.onTopologyChain(hit, event.altKey ? 'tangent' : 'loop', event.ctrlKey || event.metaKey || event.shiftKey, face?.bodyId === hit.bodyId ? face.pick.key : null);
    };
    const pointerDown = (event: PointerEvent) => {
      if (data.current.busyInputLocked) return;
      pendingHover = null; setHover(null); setFeatureHover(null); setRegionHover(null);
      if (data.current.interactionLocked && data.current.navigationLocked) return;
      activePointers.add(event.pointerId);
      renderer.domElement.focus({ preventScroll: true });
      if (data.current.interactionLocked) return;
      if (down && down.pointerId !== event.pointerId) down.moved = true;
      else if ((event.button === 0 || event.button === 2) && event.isPrimary !== false) down = { pointerId: event.pointerId, button: event.button, x: event.clientX, y: event.clientY, moved: false };
    };
    // Capture runs before OrbitControls' bubble listeners. Only a successful,
    // editor-owned gesture takes navigation and pointer capture away from them.
    // A press on the Pad's end face waits for a real drag; a plain click still picks that face.
    let facePress: { pointerId: number; x: number; y: number; ray: THREE.Ray; point: [number, number, number]; normal: [number, number, number] } | null = null;
    const endFaceHit = () => {
      const hit = data.current.depthControl?.ownsEndFace ? clippedRay.intersectObjects(pickableBodies.filter(body => body.visible), false)[0] : undefined;
      const mesh = hit && meshByObject.get(hit.object);
      const group = mesh && typeof hit.faceIndex === 'number' ? topologyGroupAt(mesh.faceGroups, hit.faceIndex * 3) : null;
      // The face must belong to this Pad, not merely line up with its end cap.
      if (!hit?.face || !mesh || !group || !data.current.depthControl?.ownsEndFace?.(mesh, group.key)) return null;
      const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      const point: [number, number, number] = [hit.point.x, hit.point.y, hit.point.z], direction: [number, number, number] = [normal.x, normal.y, normal.z];
      return depth.faceAt(point, direction) ? { point, normal: direction } : null;
    };
    const captureDepth = (event: PointerEvent) => {
      pendingHover = null; down = null; setHover(null); setFeatureHover(null); setRegionHover(null);
      renderer.domElement.focus({ preventScroll: true });
      try { renderer.domElement.setPointerCapture(event.pointerId); }
      catch { depth.cancel(); }
    };
    const depthPointerDown = (event: PointerEvent) => {
      if (depthPointer !== null || facePress) { event.preventDefault(); event.stopImmediatePropagation(); return; }
      if (!data.current.depthControl || data.current.busyInputLocked || data.current.navigationLocked || renderer.getContext().isContextLost() || event.button !== 0 || event.isPrimary === false || event.shiftKey) return;
      depth.setView(camera, container.clientWidth, container.clientHeight); setRay(event);
      depthPointer = event.pointerId;
      if (!depth.begin(event.pointerId, raycaster.ray, localPixel(event))) {
        depthPointer = null;
        const face = data.current.interactionLocked ? null : endFaceHit();
        if (!face) return;
        facePress = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, ray: raycaster.ray.clone(), ...face };
        try { renderer.domElement.setPointerCapture(event.pointerId); } catch { /* The press still ends on this canvas. */ }
        event.preventDefault(); event.stopImmediatePropagation(); return;
      }
      captureDepth(event);
      event.preventDefault(); event.stopImmediatePropagation();
    };
    const depthPointerMove = (event: PointerEvent) => {
      const press = facePress;
      if (press && depthPointer === null) {
        if (event.pointerId === press.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) {
          facePress = null; depthPointer = press.pointerId;
          if (!depth.beginFace(press.pointerId, press.ray, press.point, press.normal)) { depthPointer = null; releaseFacePress(press.pointerId); }
          else { captureDepth(event); setRay(event); depth.move(event.pointerId, raycaster.ray); }
        }
        event.preventDefault(); event.stopImmediatePropagation(); return;
      }
      if (depthPointer === null) return;
      if (event.pointerId === depthPointer) { setRay(event); depth.move(event.pointerId, raycaster.ray); }
      event.preventDefault(); event.stopImmediatePropagation();
    };
    const releaseFacePress = (pointerId: number) => {
      try { if (renderer.domElement.hasPointerCapture?.(pointerId)) renderer.domElement.releasePointerCapture(pointerId); }
      catch { /* Capture may already have been released. */ }
    };
    const depthPointerUp = (event: PointerEvent) => {
      const press = facePress;
      if (press && event.pointerId === press.pointerId) {
        // No drag happened: hand the release to the ordinary click pick, as if it had seen the press.
        facePress = null; releaseFacePress(press.pointerId);
        if (event.button === 0) { activePointers.add(press.pointerId); down = { pointerId: press.pointerId, button: 0, x: press.x, y: press.y, moved: false }; }
        return;
      }
      if (depthPointer === null) return;
      if (event.pointerId === depthPointer && event.button === 0) depth.release(event.pointerId);
      event.preventDefault(); event.stopImmediatePropagation();
    };
    // Shift + left drag draws a selection box instead of panning: dragged rightward a window, taking what lies wholly inside, and leftward a
    // crossing, taking what it touches, as in CATIA, SOLIDWORKS and AutoCAD. It takes a body, else edges, else faces, as the filter allows.
    let box: { pointerId: number; start: { x: number; y: number }; end: { x: number; y: number } } | null = null;
    const drawBox = () => {
      const overlay = boxOverlay.current;
      if (!overlay) return;
      const rectangle = box && Math.hypot(box.end.x - box.start.x, box.end.y - box.start.y) > 4 ? cadScreenBox(box.start, box.end) : null;
      overlay.hidden = !rectangle;
      overlay.classList.toggle('is-crossing', Boolean(box && rectangle && cadBoxModeFor(box.start, box.end) === 'crossing'));
      if (rectangle) Object.assign(overlay.style, { left: `${rectangle.left}px`, top: `${rectangle.top}px`, width: `${rectangle.right - rectangle.left}px`, height: `${rectangle.bottom - rectangle.top}px` });
    };
    const endBox = () => {
      const ended = box; box = null; drawBox();
      if (ended) { try { if (renderer.domElement.hasPointerCapture?.(ended.pointerId)) renderer.domElement.releasePointerCapture(ended.pointerId); } catch { /* Capture may already be gone. */ } }
    };
    const boxPointerDown = (event: PointerEvent) => {
      if (box) { event.preventDefault(); event.stopImmediatePropagation(); return; }
      const current = data.current;
      if (!event.shiftKey || event.button !== 0 || event.isPrimary === false || current.pickMode !== 'auto' && current.pickMode !== 'edge' || current.busyInputLocked || current.interactionLocked || current.navigationLocked || current.planePickingOnly
        || current.regionSelection || depthPointer !== null || facePress || !current.pickingEnabled || renderer.getContext().isContextLost()) return;
      const start = localPixel(event);
      box = { pointerId: event.pointerId, start, end: start };
      pendingHover = null; down = null; setHover(null); setFeatureHover(null);
      renderer.domElement.focus({ preventScroll: true });
      try { renderer.domElement.setPointerCapture(event.pointerId); } catch { /* The box still follows moves over the canvas. */ }
      event.preventDefault(); event.stopImmediatePropagation();
    };
    const boxPointerMove = (event: PointerEvent) => {
      if (!box) return;
      if (event.pointerId === box.pointerId) { box.end = localPixel(event); drawBox(); }
      event.preventDefault(); event.stopImmediatePropagation();
    };
    const boxPointerUp = (event: PointerEvent) => {
      if (!box) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.pointerId !== box.pointerId) return;
      const { start } = box, end = localPixel(event);
      endBox();
      if (data.current.interactionLocked) return;
      if (Math.hypot(end.x - start.x, end.y - start.y) <= 4) {
        // A Shift click without a drag stays an ordinary pick.
        setRay(event);
        const auto = data.current.pickMode === 'auto', id = auto ? hitFeature(false) : null, origin = id || !auto ? null : hitOrigin(), hit = id || origin ? null : hitTopology();
        if (id) data.current.onSelect(id);
        else if (origin) selectOrigin(origin);
        else if (hit) data.current.onTopologyPick?.(hit, true);
        return;
      }
      camera.updateMatrixWorld();
      const width = container.clientWidth, height = container.clientHeight, point = new THREE.Vector3();
      const project = (x: number, y: number, z: number) => {
        point.set(x, y, z).project(camera);
        return point.z < -1 || point.z > 1 ? null : { x: (point.x + 1) / 2 * width, y: (1 - point.y) / 2 * height };
      };
      // A body the section removes entirely is not drawn, so the box cannot choose it, and of the rest only the kept side counts, for a
      // window as for a crossing. A command's edge pick takes edges whatever the filter.
      const clip = pickClip(), auto = data.current.pickMode === 'auto';
      const bodies = pickableBodies.flatMap(body => { const mesh = meshByObject.get(body); return body.visible && mesh && !cadBoundsClipped(mesh.bounds, clip) ? [mesh] : []; });
      const target = cadBoxSelection({ rect: cadScreenBox(start, end), mode: cadBoxModeFor(start, end), bodies, project, clip,
        kinds: { body: auto && accepts('body'), edge: !auto || accepts('edge'), face: auto && accepts('face') } });
      if (target?.kind === 'topology') { if (data.current.onTopologySet) data.current.onTopologySet(target.bodyId, target.picks); }
      else if (auto) data.current.onSelect(target?.featureId ?? null);
      // An empty box in edge or face picking clears the picks through the same operation as a click on empty space, so a chain still being
      // read is dropped too.
      else data.current.onTopologyPick?.(null, false);
    };
    const pointerMove = (event: PointerEvent) => {
      lastPointer = { clientX: event.clientX, clientY: event.clientY };
      if (data.current.busyInputLocked) return;
      if (down && down.pointerId === event.pointerId && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) down.moved = true;
      if (down || event.buttons || data.current.interactionLocked && !data.current.depthControl || !data.current.pickingEnabled && data.current.pickMode !== 'body' && data.current.pickMode !== 'auto') { setHover(null); setFeatureHover(null); return; }
      pendingHover = event; render();
    };
    const cancelPointerInteraction = (preserveDepth = false, preserveHover = false) => {
      if (!preserveDepth) depth.cancel();
      if (facePress) { releaseFacePress(facePress.pointerId); facePress = null; }
      endBox();
      pendingHover = null; down = null;
      if (!preserveHover) { setHover(null); setFeatureHover(null); setRegionHover(null); }
      if (!activePointers.size) return;
      const cancelled = [...activePointers]; activePointers.clear();
      // Disconnect clears OrbitControls' active pointers and document drag
      // listeners. Reconnect preserves the camera/target and future gestures.
      controls.disconnect(); controls.connect(renderer.domElement);
      for (const pointerId of cancelled) {
        try { if (renderer.domElement.hasPointerCapture?.(pointerId)) renderer.domElement.releasePointerCapture(pointerId); }
        catch { /* Capture may already have been lost or cancelled by the browser. */ }
      }
    };
    const cancelAllPointers = () => cancelPointerInteraction(false, data.current.busyInputLocked && preserveIdleHover.current);
    const pointerLeave = () => { lastPointer = null; if (depthPointer !== null && renderer.domElement.hasPointerCapture?.(depthPointer) || box && renderer.domElement.hasPointerCapture?.(box.pointerId)) return; cancelAllPointers(); depth.hover(null); };
    const ownsPointer = (pointerId: number) => activePointers.has(pointerId) || depthPointer === pointerId || box?.pointerId === pointerId || facePress?.pointerId === pointerId;
    const pointerCancel = (event: PointerEvent) => { if (ownsPointer(event.pointerId)) cancelPointerInteraction(); };
    const lostPointerCapture = (event: PointerEvent) => { if (ownsPointer(event.pointerId)) cancelPointerInteraction(); };
    const pointerUp = (event: PointerEvent) => {
      if (data.current.busyInputLocked) return;
      const tracked = activePointers.delete(event.pointerId);
      // OrbitControls also listens on document. A foreign pointer release must
      // not terminate or reinterpret its active mouse/pen navigation gesture.
      if (!tracked && activePointers.size) { event.stopPropagation(); return; }
      if (!down || event.pointerId !== down.pointerId) return;
      if (event.button !== down.button || down.moved || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4 || data.current.interactionLocked) { down = null; return; }
      down = null;
      setRay(event);
      if (data.current.regionSelection) {
        if (renderer.getContext().isContextLost()) return;
        if (event.button === 0) {
          const selection = regions.selectionForRay(raycaster.ray, event.shiftKey || event.ctrlKey || event.metaKey);
          if (selection) data.current.regionSelection.onSelect(selection);
        }
        return;
      }
      if (event.button === 2) {
        const auto = data.current.pickMode === 'auto', feature = auto ? hitFeature(false) : null;
        const hit = data.current.pickingEnabled && !feature ? hitTopology() : null;
        const id = feature ?? (data.current.pickMode === 'body' || auto && !hit ? hitFeature() : null);
        // Select other is offered over a plane or outline as well, whenever more than one candidate lies under the pointer.
        const face = hit?.pick.kind === 'edge' ? faceUnder() : null, others = otherCandidates();
        data.current.onContextMenu?.({ clientX: event.clientX, clientY: event.clientY, trigger: 'pointer',
          target: hit ? { kind: 'topology', hit, ...face ? { faceKey: face.bodyId === hit.bodyId ? face.pick.key : null } : {} } : id ? { kind: 'feature', featureId: id } : null,
          ...(others.length > 1 ? { selectOther: () => { stepOther(others, 1); } } : {}) });
        return;
      }
      if (data.current.pickMode === 'auto' && !data.current.planePickingOnly && data.current.pickingEnabled) {
        const id = hitFeature(false);
        if (id) { data.current.onSelect(id); return; }
        const origin = hitOrigin();
        if (origin) { selectOrigin(origin); return; }
        const hit = hitTopology();
        if (hit) { data.current.onTopologyPick?.(hit, event.ctrlKey || event.metaKey); return; }
        const plane = hitPlane();
        if (plane?.plane) data.current.onSelectPlane?.(plane.plane);
        else if (data.current.onTopologyPick) data.current.onTopologyPick(null, false);
        else data.current.onSelect(null);
        return;
      }
      if (data.current.pickMode === 'body' || data.current.pickMode === 'auto') {
        const plane = hitPlane();
        if (data.current.planePickingOnly) { if (plane?.plane) data.current.onSelectPlane?.(plane.plane); return; }
        const overlay = hitFeature(false), origin = overlay ? null : hitOrigin(), id = overlay ?? (origin ? null : hitFeature());
        if (id) data.current.onSelect(id);
        else if (origin) selectOrigin(origin);
        else if (plane?.plane) data.current.onSelectPlane?.(plane.plane);
        else data.current.onSelect(null);
        return;
      }
      if (!data.current.pickingEnabled) return;
      data.current.onTopologyPick?.(hitTopology(), event.ctrlKey || event.metaKey);
    };
    // Native contextmenu timing differs across platforms. Open on release so
    // a right drag can finish as a pan without an early popup on mouse-down.
    const nativeContextMenu = (event: MouseEvent) => event.preventDefault();
    const keyboardContextMenu = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && depthPointer !== null) { event.preventDefault(); event.stopImmediatePropagation(); cancelPointerInteraction(); return; }
      if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
      event.preventDefault();
      if (depthPointer !== null || data.current.hidden || data.current.interactionLocked || data.current.regionSelection || !data.current.onContextMenu || renderer.getContext().isContextLost()) return;
      cancelPointerInteraction();
      const selection = data.current.topologySelection;
      const mesh = selection && data.current.pickingEnabled ? data.current.meshes.find(mesh => mesh.featureId === selection.bodyId) : null;
      const pick = selection?.picks.find(pick => (pick.kind === 'edge' ? mesh?.edgeGroups : mesh?.faceGroups)?.some(group => group.key === pick.key));
      const selected = data.current.selectedId;
      const visibleFeature = selected && (data.current.references.some(reference => reference.featureId === selected) || data.current.pickingEnabled && data.current.meshes.some(mesh => mesh.featureId === selected));
      const rect = renderer.domElement.getBoundingClientRect();
      data.current.onContextMenu({ clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, trigger: 'keyboard',
        target: selection && pick ? { kind: 'topology', hit: { bodyId: selection.bodyId, pick } } : visibleFeature ? { kind: 'feature', featureId: selected } : null });
    };
    const wheelNavigation = (event: WheelEvent) => {
      if (depthPointer !== null || data.current.busyInputLocked || data.current.navigationLocked || renderer.getContext().isContextLost()) { event.preventDefault(); event.stopImmediatePropagation(); return; }
      // Ctrl-wheel is the browser's synthesized pinch gesture. OrbitControls
      // already normalizes it and prevents browser zoom on this canvas only.
      if (data.current.navigationMode !== 'trackpad' || event.ctrlKey) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (activePointers.size) return;
      const width = Math.max(1, container.clientWidth), height = Math.max(1, container.clientHeight);
      const pixels = (delta: number, extent: number) => Number.isFinite(delta) ? THREE.MathUtils.clamp(delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? extent : 1), -2 * extent, 2 * extent) : 0;
      const x = pixels(event.deltaX, width), y = pixels(event.deltaY, height);
      if (!x && !y) return;
      pendingHover = null; setHover(null); setFeatureHover(null);
      if (event.altKey) {
        controls.rotateLeft(THREE.MathUtils.clamp(2 * Math.PI * x / height, -Math.PI / 2, Math.PI / 2));
        controls.rotateUp(THREE.MathUtils.clamp(2 * Math.PI * y / height, -Math.PI / 2, Math.PI / 2));
      } else controls.pan(-x, -y);
    };
    const onChange = () => {
      setRegionHover(null);
      depth.hover(null); depth.setView(camera, container.clientWidth, container.clientHeight);
      if (!fittingAutomatically) userFramed = true;
      if (viewState.view !== 'Custom' && camera.position.clone().sub(controls.target).normalize().distanceToSquared(namedDirection) > 1e-12) { viewState.view = 'Custom'; setViewName('Custom'); }
      viewState.revision++; render();
    };
    const onStart = () => { pendingHover = null; setHover(null); setFeatureHover(null); setRegionHover(null); };
    const attachOrbitListeners = (instance: OrbitControls) => {
      instance.addEventListener('change', onChange);
      instance.addEventListener('start', onStart);
    };
    const releaseOrbitControls = (instance: OrbitControls) => {
      instance.removeEventListener('change', onChange);
      instance.removeEventListener('start', onStart);
      instance.dispose();
    };
    const contextLost = () => {
      if (disposed) return;
      cancelPointerInteraction();
      if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
      pendingHover = null;
      viewState.revision++;
      updateDepthLabel();
      setGraphicsFailure('lost');
    };
    const contextRestored = () => {
      if (disposed) return;
      // Three restores its GPU resources first. Demand rendering must then redraw
      // the retained scene rather than waiting for the next pointer interaction.
      viewState.revision++;
      setGraphicsFailure(null);
      resize();
    };
    renderer.domElement.addEventListener('webglcontextlost', contextLost);
    renderer.domElement.addEventListener('webglcontextrestored', contextRestored);
    attachOrbitListeners(controls);
    renderer.domElement.addEventListener('pointerdown', pointerDown);
    renderer.domElement.addEventListener('pointerdown', depthPointerDown, true);
    renderer.domElement.addEventListener('pointerdown', boxPointerDown, true);
    renderer.domElement.addEventListener('pointermove', boxPointerMove, true);
    renderer.domElement.addEventListener('pointerup', boxPointerUp, true);
    renderer.domElement.addEventListener('pointermove', depthPointerMove, true);
    renderer.domElement.addEventListener('pointerup', depthPointerUp, true);
    renderer.domElement.addEventListener('pointerup', pointerUp);
    renderer.domElement.addEventListener('pointermove', pointerMove);
    renderer.domElement.addEventListener('pointerleave', pointerLeave);
    renderer.domElement.addEventListener('pointercancel', pointerCancel);
    renderer.domElement.addEventListener('lostpointercapture', lostPointerCapture);
    renderer.domElement.addEventListener('contextmenu', nativeContextMenu);
    renderer.domElement.addEventListener('keydown', keyboardContextMenu);
    renderer.domElement.addEventListener('keydown', selectOtherKey);
    renderer.domElement.addEventListener('dblclick', doubleClick);
    renderer.domElement.addEventListener('wheel', wheelNavigation, { capture: true, passive: false });
    window.addEventListener('blur', cancelAllPointers);
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    if (sketch) releaseSketchCamera = sketch.camera.subscribe(render);
    resize();
    if (visible) { update(); updateReferences(); }
    updateRegionSelection();
    updateDepthSelection();
    applySketchStyle();
    redraw.current = () => { if (visible) update(); };
    uploadReferences.current = () => { if (visible) updateReferences(); };
    updateRegions.current = updateRegionSelection;
    updateDepth.current = updateDepthSelection;
    recolor.current = updateSelection;
    highlight.current = () => {
      if (data.current.interactionLocked && !preserveIdleHover.current || !data.current.pickingEnabled || data.current.pickMode !== 'auto' && viewState.hoveredTopology?.pick.kind !== data.current.pickMode) viewState.hoveredTopology = null;
      updateHighlights();
    };
    cancelInteraction.current = cancelPointerInteraction;
    applySection.current = updateSection;
    cancelDepth.current = () => depth.cancel();
    updateHighlights();
    controller.current = {
      getState: () => Object.freeze({ mode: 'solid', available: !disposed && !renderer.getContext().isContextLost(), view: viewState.view, gridVisible: viewState.gridVisible, zoom: camera.zoom, revision: viewState.revision, referenceVersion: installedReferenceVersion, referenceFeatureIds: installedReferenceFeatureIds, referencePlanes: installedReferencePlanes,
        ...(sectionShown && !sketch ? { section: Object.freeze({ caps: data.current.section?.caps === true, normal: Object.freeze([sectionClip.normal.x + 0, sectionClip.normal.y + 0, sectionClip.normal.z + 0] as const), constant: sectionClip.constant }) } : {}),
        hoveredTopology: viewState.hoveredTopology ? Object.freeze({ ...viewState.hoveredTopology, pick: Object.freeze({ ...viewState.hoveredTopology.pick }) }) : null }),
      // Only a shown model view publishes these; a covered one also refuses them, so nothing moves the camera a sketch will return to.
      fit() { if (!cover) fit(); },
      setGrid(visible) { grid.visible = visible; viewState.gridVisible = visible; viewState.revision++; setGridVisible(visible); render(); },
      setView(name) {
        if (cover) return;
        const direction = name === 'Top' ? new THREE.Vector3(0, 0, 1) : name === 'Front' ? new THREE.Vector3(0, -1, 0) : name === 'Right' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(1, -1.2, 0.9).normalize();
        const distance = Math.max(1000, camera.position.distanceTo(controls.target));
        const up = new THREE.Vector3(0, name === 'Top' ? 1 : 0, name === 'Top' ? 0 : 1);
        if (!camera.up.equals(up)) {
          const target = controls.target.clone();
          releaseOrbitControls(controls);
          camera.up.copy(up);
          // OrbitControls captures the up basis at construction. Its constructor
          // also updates the camera before our retained target is restored.
          controls = createOrbitControls();
          controls.target.copy(target);
          orbit.current = controls;
          attachOrbitListeners(controls);
        }
        camera.position.copy(controls.target).addScaledVector(direction, distance);
        namedDirection = direction.clone().normalize();
        viewState.view = name; viewState.revision++; setViewName(name);
        controls.update(); render();
      },
      async capture(signal) {
        signal.throwIfAborted();
        const assertGraphicsAvailable = () => {
          if (disposed || renderer.getContext().isContextLost()) throw new ToolError('CAPTURE_UNAVAILABLE', 'The 3D graphics context is unavailable. Wait for recovery or retry the 3D view.');
        };
        assertGraphicsAvailable();
        if (uploadedMeshes.current !== data.current.meshes) update();
        if (uploadedReferences.current !== data.current.references || installedReferenceVersion !== data.current.referenceVersion) updateReferences();
        updateRegionSelection();
        updateDepthSelection();
        updateSelection();
        updateHighlights();
        controls.update();
        depth.setView(camera, container.clientWidth, container.clientHeight); updateDepthLabel();
        if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
        updateReferenceStyles(); updatePlaneLabels(); renderer.render(scene, camera);
        assertGraphicsAvailable();
        const image = captureCanvas(renderer.domElement, '3d');
        assertGraphicsAvailable();
        signal.throwIfAborted();
        return image;
      },
    };
    const publishedControls = controller.current;
    // The model view publishes its controls only while it is shown on its own; behind a sketch it only draws.
    present.current = (covered, nextSketch) => {
      const nextSketchView = covered ? nextSketch : null, nextVisible = !covered || nextSketchView !== null;
      if (disposed || nextVisible === visible && nextSketchView === sketch) return;
      if (covered && !cover) cover = { geometryBefore: showsGeometry(), fitWaiting: false };
      const wasShown = visible, wasPublished = visible && !sketch;
      if (nextSketchView?.camera !== sketch?.camera) {
        releaseSketchCamera?.();
        releaseSketchCamera = nextSketchView ? nextSketchView.camera.subscribe(render) : null;
      }
      visible = nextVisible; sketch = nextSketchView;
      const publishes = visible && !sketch;
      renderer.domElement.tabIndex = covered || data.current.navigationLocked && data.current.interactionLocked ? -1 : 0;
      if (wasPublished && !publishes) {
        cancelPointerInteraction();
        pendingHover = null;
        publish.current?.(null, publishedControls);
      }
      if (!visible && frame !== null) { cancelAnimationFrame(frame); frame = null; }
      applySketchStyle();
      if (!visible) return;
      if (!wasShown) {
        resize();
        if (uploadedMeshes.current !== data.current.meshes) update();
        updateReferences();
        updateSelection();
        updateHighlights();
      }
      if (!covered && cover) {
        const ended = cover;
        cover = null;
        if (ended.fitWaiting && !ended.geometryBefore && !userFramed) fit(true);
      }
      render();
      if (publishes && !wasPublished) publish.current?.(publishedControls);
    };
    if (visible && !sketch) publish.current?.(publishedControls);
    return () => {
      disposed = true;
      present.current = null;
      releaseSketchCamera?.(); releaseSketchCamera = null;
      observer.disconnect();
      depth.dispose(); releaseDepthCapture();
      releaseOrbitControls(controls);
      orbit.current = null;
      renderer.domElement.removeEventListener('pointerdown', pointerDown);
      renderer.domElement.removeEventListener('pointerdown', depthPointerDown, true);
      renderer.domElement.removeEventListener('pointerdown', boxPointerDown, true);
      renderer.domElement.removeEventListener('pointermove', boxPointerMove, true);
      renderer.domElement.removeEventListener('pointerup', boxPointerUp, true);
      renderer.domElement.removeEventListener('pointermove', depthPointerMove, true);
      renderer.domElement.removeEventListener('pointerup', depthPointerUp, true);
      renderer.domElement.removeEventListener('pointerup', pointerUp);
      renderer.domElement.removeEventListener('pointermove', pointerMove);
      renderer.domElement.removeEventListener('pointerleave', pointerLeave);
      renderer.domElement.removeEventListener('pointercancel', pointerCancel);
      renderer.domElement.removeEventListener('lostpointercapture', lostPointerCapture);
      renderer.domElement.removeEventListener('contextmenu', nativeContextMenu);
      renderer.domElement.removeEventListener('keydown', keyboardContextMenu);
      renderer.domElement.removeEventListener('keydown', selectOtherKey);
      renderer.domElement.removeEventListener('dblclick', doubleClick);
      renderer.domElement.removeEventListener('wheel', wheelNavigation, true);
      window.removeEventListener('blur', cancelAllPointers);
      renderer.domElement.removeEventListener('webglcontextlost', contextLost);
      renderer.domElement.removeEventListener('webglcontextrestored', contextRestored);
      if (frame !== null) cancelAnimationFrame(frame);
      if (reportedPlaneHover !== null) { reportedPlaneHover = null; data.current.onHoverPlane?.(null); }
      disposeSolids();
      disposeReferences();
      caps.dispose();
      applySection.current = null;
      regions.dispose();
      highlights.dispose();
      grid.geometry.dispose();
      for (const material of Array.isArray(grid.material) ? grid.material : [grid.material]) material.dispose();
      axes.geometry.dispose();
      for (const material of Array.isArray(axes.material) ? axes.material : [axes.material]) material.dispose();
      renderer.dispose(); background.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      controller.current = null;
      redraw.current = null;
      recolor.current = null;
      highlight.current = null;
      cancelInteraction.current = null;
      uploadedMeshes.current = null;
      uploadedReferences.current = null; uploadReferences.current = null;
      updateRegions.current = null;
      updateDepth.current = null; cancelDepth.current = null;
      if (depthLabel.current) depthLabel.current.hidden = true;
      publish.current?.(null, publishedControls);
    };
  }, [contextGeneration]);

  useEffect(() => { if (uploadedMeshes.current !== meshes) redraw.current?.(); }, [meshes]);
  useLayoutEffect(() => { uploadReferences.current?.(); }, [references, referenceVersion]);
  useLayoutEffect(() => { updateRegions.current?.(); }, [ownedRegions]);
  useLayoutEffect(() => { updateDepth.current?.(); }, [ownedDepth, busyInputLocked]);
  useEffect(() => { recolor.current?.(); }, [selectedId, selectedReferencePlane, hoveredReferencePlane, sourceReferenceIds, pickMode, planePickingOnly, topologySelection]);
  useEffect(() => { highlight.current?.(); }, [topologySelection, pickMode, meshes, pickingEnabled, interactionLocked]);
  useLayoutEffect(() => {
    const scene = [meshInteraction, referenceInteraction, referenceVersionInteraction, sourceInteraction, selectedId, selectedReferencePlane,
      pickMode, topologySelection, pickingEnabled, planePickingOnly, ownedRegions?.owner, ownedRegions?.expectedVersion, ownedRegions?.sketchId,
      ownedRegions?.cells, regionPlacementKey, ownedDepth];
    const previous = interactionOwner.current;
    preserveIdleHover.current = Boolean((busyInputLocked || previous?.busy) && previous?.scene.every((value, index) => Object.is(value, scene[index])));
    interactionOwner.current = { scene, busy: busyInputLocked };
    cancelInteraction.current?.(Boolean(ownedDepth) && !navigationLocked && !busyInputLocked, preserveIdleHover.current);
    if (orbit.current) orbit.current.enabled = !navigationLocked && !busyInputLocked && !ownedDepth?.getState()?.gestureActive;
    const canvas = host.current?.querySelector('canvas');
    if (canvas) canvas.tabIndex = hidden || navigationLocked && interactionLocked ? -1 : 0;
  }, [interactionLocked, navigationLocked, navigationMode, pickMode, meshInteraction, referenceInteraction, referenceVersionInteraction, pickingEnabled, sourceInteraction,
    ownedRegions?.owner, ownedRegions?.expectedVersion, ownedRegions?.sketchId, ownedRegions?.cells, regionPlacementKey,
    busyInputLocked, ownedDepth, selectedId, selectedReferencePlane, topologySelection, planePickingOnly]);
  useLayoutEffect(() => { cancelDepth.current?.(); }, [navigationLocked, navigationMode]);
  useLayoutEffect(() => { present.current?.(hidden, sketchView); }, [hidden, sketchView]);
  useLayoutEffect(() => { applySection.current?.(); }, [section]);
  useEffect(() => { recolor.current?.(); }, [selectedOrigin]);
  // A filter change drops a hover the filter now refuses; the next pointer move finds what may be picked.
  useLayoutEffect(() => { cancelInteraction.current?.(true); }, [selectionFilter]);
  // Behind a sketch the same graphics host draws under the sketch canvas and takes no input; the sketch owns every control.
  // Inert also releases focus the 3D canvas already had, which a negative tab index alone would leave inside the hidden layer.
  if (hidden && sketchView) return <div className="cad-viewport is-sketch-background" aria-hidden="true" inert><div className="cad-webgl" ref={host} /></div>;
  // Hidden, only the graphics host stays so the sketch surface owns every visible control.
  if (hidden) return <div className="cad-viewport" hidden><div className="cad-webgl" ref={host} aria-label="3D model viewport" /></div>;
  return <div className="cad-viewport">
    <div className="cad-webgl" ref={host} aria-label="3D model viewport" />
    <div className="cad-depth-label" ref={depthLabel} hidden aria-live="off" />
    <div className="cad-box-select" ref={boxOverlay} hidden />
    <div className="cad-plane-labels" ref={planeLabels} aria-label="Reference planes in design area">
      {references.filter(reference => reference.plane && reference.labelPosition).map(reference => <Button key={reference.referenceId} type="button" data-cad-plane-label={reference.referenceId}
        aria-label={`Select ${reference.name} in design area`} aria-pressed={cadSameReferencePlane(reference.plane ?? null, selectedReferencePlane)}
        data-hovered={cadSameReferencePlane(reference.plane ?? null, hoveredReferencePlane) || undefined}
        disabled={depthDragging || interactionLocked || unavailable || !bodyLevel || !onSelectPlane} onClick={() => { if (reference.plane) onSelectPlane?.(reference.plane); }}
        onPointerEnter={() => onHoverPlane?.(reference.plane ?? null)} onPointerLeave={() => onHoverPlane?.(null)}>{reference.name}</Button>)}
    </div>
    <CadViewTools label="Viewport controls">
      <ViewIcon size={14} />
      <Select density="compact" aria-label="Named view" value={viewName} disabled={depthDragging || navigationLocked || unavailable} onChange={(event) => {
        const name = (['Isometric', 'Top', 'Front', 'Right'] satisfies CadNamedView[]).find((entry) => entry === event.target.value);
        if (name) controller.current?.setView?.(name);
      }}>{viewName === 'Custom' && <option value="Custom" disabled>Custom</option>}{(['Isometric', 'Top', 'Front', 'Right'] satisfies CadNamedView[]).map((name) => <option key={name} value={name}>{name}</option>)}</Select>
      <span className="cad-divider" />
      <Button title="Fit model" aria-label="Fit model" disabled={depthDragging || navigationLocked || unavailable} onClick={() => controller.current?.fit()}><FitViewIcon size={14} /></Button>
      <Button title="Toggle grid" aria-label="Toggle grid" disabled={navigationLocked || unavailable} aria-pressed={gridVisible} onClick={() => controller.current?.setGrid(!gridVisible)}><GridIcon size={14} /></Button>
      {viewControls}
      <CadContextHelp label="Model navigation">{navigationMode === 'trackpad' ? 'Use two-finger scrolling to pan, pinch to zoom, and Alt + scroll to orbit.' : 'Drag to orbit, drag with the right mouse button to pan, and use the wheel to zoom.'} Clicking picks the edge, face or reference under the pointer. Shift + drag a box around a whole body to select it. Ctrl or Command + click toggles individual edge selections.</CadContextHelp>
    </CadViewTools>
    {unavailable ? <div className="cad-view-message" role="status"><strong>{graphicsFailure === 'lost' ? 'The 3D graphics context was interrupted.' : '3D graphics are unavailable in this browser.'}</strong><span>{graphicsFailure === 'lost' ? 'Waiting for recovery. Retry the view if it stays blank; your CAD document is retained.' : 'Sketch editing and document operations remain available. Enable WebGL to view solids.'}</span><Button type="button" disabled={interactionLocked} onClick={() => setContextGeneration(generation => generation + 1)}>Retry 3D view</Button></div> : null}
    {topologySelection?.picks.length ? <div className="cad-view-caption">{topologySelection.picks.length} {topologySelection.picks[0].kind}{topologySelection.picks.length === 1 ? '' : 's'} selected</div> : null}
  </div>;
}
