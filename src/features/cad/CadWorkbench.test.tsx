import { circleRowPart, rowSketch } from '@/domain/cad/__tests__/cadSketchLinearPatternFixtures';
import { act, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AppRailProvider, useAppRail } from '@/app/AppRailContext';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CadBuildResult, CadDocument, CadMesh, CadSketchPlane } from '@/domain/cad/cadDocument';
import type { CadTopologyDescriptor, CadTopologyResolvePicksResult } from '@/domain/cad/cadTopology';
import { CadTangentContours, type CadTopologyAdjacency, type CadTopologyAdjacencyRequest, type CadTopologyTangentChain, type CadTopologyTangentChainRequest } from '@/domain/cad/cadTopologyAdjacency';
import { CAD_TOPOLOGY_LONE_EDGE_NOTE } from '@/domain/cad/selection/cadTopologySelection';
import { applyCadEdits, type CadEdit } from '@/domain/cad/cadOperations';
import { createCadDocument, parseCadDocument } from '@/domain/cad/cadSchema';
import type { CadSketchGenerator, CadSketchGraphRelation } from '@/domain/cad/cadSketchGraph';
import { expandCadSketchGenerators } from '@/domain/cad/sketch-generators/cadSketchGenerators';
import type { CadSketchGraphSelection } from '@/domain/cad/cadSketchGraphSelection';
import { measureCadSketch } from '@/domain/cad/cadMeasurements';
import { prepareCadSketchCells } from '@/domain/cad/cadSketchRegionInspection';
import { CadWorkbench, type CadWorkbenchProps } from './CadWorkbench';
import { slotSketchProfile, slotSketchWidth, snapSketchPoint, twoPointSketchProfile } from './cadSketchInteraction';
import { CadSession } from './cadSession';
import { getCadPreferences, setCadPreferences } from './cadPreferences';
import { cadFeatureCandidateKey, type CadFeaturePreviewState } from './cadFeaturePreview';
import type { CadRenderedViewControls, CadWorkbenchViewportControls } from './cadViewportControls';
import type { CadViewportContextMenuRequest } from './CadViewport';
import type { CadFeatureRegionPickCommand } from './cadFeatureReferencePicking';
import type { CadExtrudeDepthControl } from './cadExtrudeDepthInteraction';
import type { CadSketchConstraintAnalysis, CadSketchConstraintInspection } from './cadSketchConstraintInspection';
import { CadSketchPreparationError } from './cadSketchConstraintFeedback';
import { cadSketchDimensionSelectionStatus } from './cadSketchDimensionSelection';
import { useCadSketchEditing } from './useCadSketchEditing';
import { pairedBoreMirrorPart } from '@/domain/cad/__tests__/cadSketchMirrorFixtures';
import { cadSketchSourceAvailability, cadSketchSourceIssue } from '@/domain/cad/cadSketchSources';
import { cadSketchRelationOffers } from '@/domain/cad/sketch-relations/cadSketchRelationOffers';

let requestViewportMenu: ((request: CadViewportContextMenuRequest) => void) | undefined;
let pickViewportFeature: ((id: string | null) => void) | undefined;
let pickViewportPlane: ((plane: CadSketchPlane) => void) | undefined;
let viewportRegions: CadFeatureRegionPickCommand | null = null;
let viewportDepth: CadExtrudeDepthControl | null = null;
let workbenchRenders = 0;

// jsdom cannot create a WebGL context. These tests exercise the real UI and domain edits.
vi.mock('./CadViewport', async () => {
  const { useEffect } = await import('react');
  return { CadViewport: ({ hidden = false, onControlsReady, meshes = [], navigationLocked, onContextMenu, onSelect, onSelectPlane, sourceReferencePickIds, regionSelection, depthControl }: { hidden?: boolean; meshes?: CadBuildResult['meshes']; navigationLocked?: boolean; sourceReferencePickIds?: readonly string[]; regionSelection?: CadFeatureRegionPickCommand | null; depthControl?: CadExtrudeDepthControl | null; onSelect(id: string | null): void; onSelectPlane?(plane: CadSketchPlane): void; onContextMenu?(request: CadViewportContextMenuRequest): void; onControlsReady?(controls: CadRenderedViewControls | null, released?: CadRenderedViewControls): void }) => {
    // The workbench renders its viewport, hidden or not, every time it renders.
    workbenchRenders += 1;
    requestViewportMenu = onContextMenu;
    pickViewportFeature = onSelect;
    pickViewportPlane = onSelectPlane;
    viewportRegions = regionSelection ?? null;
    viewportDepth = depthControl ?? null;
    // Match WebGL's passive publication/disposal lifetime, while the real SVG
    // publishes in layout effects. Their order matters when changing modes.
    // Like the real view, a hidden viewport stays mounted but publishes no controls.
    useEffect(() => {
      if (hidden) return;
      const controls: CadRenderedViewControls = { getState: () => ({ mode: 'solid', available: true, view: 'Isometric', gridVisible: true, zoom: 1, revision: 0 }),
        fit: vi.fn(), setGrid: vi.fn(), setView: vi.fn(), capture: async () => { throw new Error('WebGL rasterization is unavailable in jsdom.'); } };
      onControlsReady?.(controls);
      return () => onControlsReady?.(null, controls);
    }, [onControlsReady, hidden]);
    if (hidden) return <div className="cad-viewport" hidden />;
    return <div aria-label="3D model viewport" data-displayed-volumes={meshes.map(mesh => mesh.volume).join(',')} data-navigation-locked={String(navigationLocked)} data-source-reference-pick-ids={sourceReferencePickIds?.join(',') ?? ''} />;
  } };
});

// The source checks keep their behavior; tests count how often the workbench runs them.
vi.mock('@/domain/cad/cadSketchSources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/domain/cad/cadSketchSources')>();
  return { ...actual, cadSketchSourceAvailability: vi.fn(actual.cadSketchSourceAvailability), cadSketchSourceIssue: vi.fn(actual.cadSketchSourceIssue) };
});
// The sketch canvas reads its dimension status line once per render in the select tool, so the call count tracks canvas renders.
vi.mock('./cadSketchDimensionSelection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cadSketchDimensionSelection')>();
  return { ...actual, cadSketchDimensionSelectionStatus: vi.fn(actual.cadSketchDimensionSelectionStatus) };
});
const canvasRenders = vi.mocked(cadSketchDimensionSelectionStatus);
// The icon row's offers keep their behavior; tests count how often the workbench asks for them.
vi.mock('@/domain/cad/sketch-relations/cadSketchRelationOffers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/domain/cad/sketch-relations/cadSketchRelationOffers')>();
  return { ...actual, cadSketchRelationOffers: vi.fn(actual.cadSketchRelationOffers) };
});
const offerRequests = vi.mocked(cadSketchRelationOffers);

let container: HTMLDivElement;
let root: Root;
let currentDocument: CadDocument;
let currentSession: CadSession;
let currentViewport: CadWorkbenchViewportControls | null;
let replaceDocument: (document: CadDocument) => void;
let replaceBuild: (build: CadBuildResult | null, state?: CadWorkbenchProps['buildState']) => void;
let replaceFeaturePreview: (preview: CadFeaturePreviewState) => void;
let removeCad: () => void;
let showCad: () => void;
const undo = vi.fn();
const save = vi.fn(async () => undefined);
const sendToCam = vi.fn(async (_sketchId: string) => undefined);
const workflow = vi.fn();
const statusMessage = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  currentViewport = null;
  viewportRegions = null;
  viewportDepth = null;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function PreviousEditorHeader() {
  const { setHeaderContent } = useAppRail();
  useEffect(() => { setHeaderContent(<span>Previous editor</span>); return () => setHeaderContent(null); }, [setHeaderContent]);
  return <div>Previous editor content</div>;
}

async function mount(initial: CadDocument = createCadDocument(), buildProps: Pick<CadWorkbenchProps, 'build' | 'buildState'> & Partial<Pick<CadWorkbenchProps, 'onSectionForCam' | 'onInspectTopology' | 'onResolveSelection' | 'onTopologyAdjacency' | 'onTopologyTangentChain' | 'onRebuild' | 'featurePreview' | 'onFeaturePreview' | 'onEdit' | 'onEditMany' | 'onWorkflowChange' | 'onBeginSketchEdit' | 'sketchEdit' | 'onInspectSketchConstraints'>> = { build: null, buildState: 'idle' }, inShell: boolean | 'previous-header' = false) {
  const session = new CadSession(initial);
  currentSession = session;
  function Harness() {
    const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
    const [build, setBuild] = useState(buildProps.build);
    const [buildState, setBuildState] = useState(buildProps.buildState);
    const [featurePreview, setFeaturePreview] = useState<CadFeaturePreviewState>(buildProps.featurePreview ?? { kind: 'idle' });
    replaceFeaturePreview = setFeaturePreview;
    const [headerContent, setHeaderContent] = useState<ReactNode | null>(null);
    const [visible, setVisible] = useState(inShell !== 'previous-header');
    removeCad = () => setVisible(false);
    showCad = () => setVisible(true);
    replaceBuild = (next, state = 'ready') => { setBuild(next); setBuildState(state); };
    const { document } = snapshot;
    currentDocument = document;
    replaceDocument = (replacement) => session.replace(replacement);
    const props: CadWorkbenchProps = {
      document, documentVersion: snapshot.version, buildVersion: buildState === 'ready' ? snapshot.version : null, ...buildProps, build, buildState, featurePreview, dirty: true, canUndo: true, canRedo: true,
      onEdit: buildProps.onEdit ?? (edit => { session.edit([edit]); }),
      onEditMany: buildProps.onEditMany ?? (edits => session.edit(edits)),
      onStatusMessage: statusMessage,
      onUndo: undo, onRedo: vi.fn(), onSave: save, onBack: vi.fn(), onWorkflowChange: buildProps.onWorkflowChange ?? ((open) => { workflow(open); session.setWorkflowOpen(open); }),
      onSendToCam: sendToCam, onOpenDocument: vi.fn(), onNewDocument: vi.fn(),
      onImportDocument: async () => undefined, onExportDocument: vi.fn(), onExportSolid: async () => undefined, onOpenDxfExport: async () => undefined,
      onViewportControlsReady: (controls) => { currentViewport = controls; },
    };
    return inShell ? <><header data-app-header>{headerContent ?? <span>Workbench</span>}</header><AppRailProvider value={{ setHeaderContent,
      openMachineSettings: vi.fn(), closeCompactDrawerWithRailFocus: vi.fn(), compactDrawer: null, compactModalHost: null, compactTransitionOverlay: false,
      isCompactViewport: false, isMiddleViewport: false, setCompactDrawer: vi.fn(), setCompactTransitionOverlay: vi.fn(), setRailCollapsed: vi.fn(), setRailContent: vi.fn() }}>
      {visible ? <CadWorkbench {...props} /> : inShell === 'previous-header' ? <PreviousEditorHeader /> : null}</AppRailProvider></> : <CadWorkbench {...props} />;
  }
  await act(async () => root.render(<Harness />));
}

/** The part name lives in the part's Properties, opened from the part row at the top of the tree. */
async function partName() {
  const field = () => container.querySelector<HTMLInputElement>('[aria-label="Part name"]');
  if (!field()) await act(async () => container.querySelector<HTMLButtonElement>('.cad-tree-document')?.click());
  const name = field(); if (!name) throw new Error('Part name missing.');
  return name;
}
function button(label: string) {
  const found = [...document.querySelectorAll('button')].find((entry) => entry.getAttribute('aria-label') === label || entry.textContent?.trim() === label);
  if (!found) throw new Error(`Button "${label}" missing.`);
  return found;
}
/** The toolbar's tool button; the Line tool's segment mode also has a button reading Line. */
function toolButton(label: string) {
  const found = document.querySelector<HTMLButtonElement>(`.cad-command-primary-tools button[aria-label="${label}"]`);
  if (!found) throw new Error(`Tool "${label}" missing.`);
  return found;
}
async function click(label: string) {
  if (label === 'Fillet' || label === 'Chamfer') await act(async () => button('Fillet / Chamfer').click());
  await act(async () => button(label).click());
}
/** Double-click the selected history row, which opens its sketch, curve or feature editor. */
async function openSelected() { await act(async () => { container.querySelector('.cad-tree-row[aria-pressed="true"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); }); }
/** Right-click a history row and run one of its menu commands. */
async function rowMenu(row: string, command: string) {
  await act(async () => button(`Select ${row} in history`).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 })));
  const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(entry => entry.textContent?.trim() === command);
  if (!item) throw new Error(`Menu command "${command}" missing.`);
  await act(async () => item.click());
}
/** Right-click the Parameters branch and run one of its menu commands. */
async function parameterMenu(command: string) {
  const branch = [...document.querySelectorAll('button')].find(entry => /^(Expand|Collapse) Parameters$/.test(entry.getAttribute('aria-label') ?? ''));
  if (!branch) throw new Error('Parameters branch missing.');
  await act(async () => branch.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 })));
  const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(entry => entry.textContent?.trim() === command);
  if (!item) throw new Error(`Menu command "${command}" missing.`);
  await act(async () => item.click());
}
function property(label: string) {
  return [...container.querySelectorAll('.cad-properties-list > div')].find(row => row.querySelector('dt')?.textContent === label)?.querySelector('dd')?.textContent;
}
async function startSketch() {
  await act(async () => viewport().apply({ kind: 'select-reference-plane', plane: 'XY' }));
  await click('Sketch');
}
function field(label: string) {
  const host = document.querySelector('.cad-parameter-editor') ?? container;
  const input = [...host.querySelectorAll('label')].find((entry) => entry.querySelector('span')?.childNodes[0]?.textContent === label)?.querySelector('input');
  if (!input) throw new Error(`Field "${label}" missing.`);
  return input;
}
async function input(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('Native input setter unavailable.');
  await act(async () => { setter.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function relation(label: string, value: string) {
  await click(`Edit ${label} relation`);
  const control = document.querySelector<HTMLInputElement>(`input[aria-label="${label} expression"]`), setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  if (!control) throw new Error('Missing expression field'); await act(async () => { setter.call(control, value); control.dispatchEvent(new Event('input', { bubbles: true })); });
  const keep = [...document.querySelectorAll('button')].find(entry => entry.textContent?.trim() === 'Keep relation'), close = document.querySelector<HTMLButtonElement>(`button[aria-label="Close ${label} relation help"]`);
  if (!keep || !close) throw new Error('Missing relation actions'); await act(async () => keep.click()); await act(async () => close.click());
}
function dimensionValue() {
  const value = container.querySelector<HTMLInputElement>('input[aria-label="Dimension value"]'); if (!value) throw new Error('Missing dimension value'); return value;
}
async function canvasClick(x: number, y: number) {
  const canvas = container.querySelector<SVGSVGElement>('[aria-label="Sketch drawing canvas"]');
  if (!canvas) throw new Error('Sketch canvas missing.');
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, toJSON: () => ({}) });
  await act(async () => canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y })));
}
// Sketching is free by default; these flows draw on grid nodes.
async function snapToGrid() {
  const toggle = container.querySelector<HTMLInputElement>('input[aria-label="Snap to grid"]'); if (!toggle) throw new Error('Grid snap toggle missing.');
  await act(async () => toggle.click());
}
/** Sets Create relations, which starts on, to the state a flow needs. */
async function drawingRelations(enabled: boolean) {
  const toggle = container.querySelector<HTMLInputElement>('input[aria-label="Create relations"]'); if (!toggle) throw new Error('Relation drawing control missing.');
  if (toggle.checked !== enabled) await act(async () => toggle.click());
  expect(toggle.checked).toBe(enabled);
}
async function canvasKey(key: string, shiftKey = false) {
  const canvas = container.querySelector<SVGSVGElement>('[aria-label="Sketch drawing canvas"]');
  if (!canvas) throw new Error('Sketch canvas missing.');
  await act(async () => { canvas.focus(); canvas.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })); });
}
/** A key as the keyboard sends it, to whatever has focus; a pick leaves focus on the geometry picked, not on the canvas. */
async function focusedKey(key: string, shiftKey = false) {
  await act(async () => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })); });
}
/** Enter on sketch geometry as a keyboard user gives it, with focus moved there first, as tabbing to it would. */
function keyboardPick(target: Element, shiftKey = false) {
  if (target instanceof SVGElement || target instanceof HTMLElement) target.focus();
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey, bubbles: true, cancelable: true }));
}
/** Escape with focus outside the canvas, which the workbench handles. */
async function windowEscape() { await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); }); }
/** What the sketch canvas asks for now, as its instructions read to assistive technology, without the keyboard help that follows. */
function pickInstruction() {
  const id = container.querySelector('[aria-label="Sketch drawing canvas"]')?.getAttribute('aria-describedby');
  return (id ? document.getElementById(id)?.textContent?.split(' Keyboard: ')[0] : null) ?? null;
}
/** Opens the Dimension tool's own menu from the canvas menu key, and runs the command named, if any. */
async function dimensionMenu(command?: string) {
  await canvasKey('ContextMenu');
  const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  if (command === undefined) return items;
  const item = items.find(entry => entry.textContent?.trim() === command);
  if (!item) throw new Error(`Dimension command "${command}" missing from ${items.map(entry => entry.textContent).join(', ')}.`);
  await act(async () => item.click());
  return items;
}
function sketchGraph() {
  const sketch = currentDocument.features[0];
  if (sketch?.kind !== 'sketch') throw new Error('Sketch missing.');
  return sketch.graph ?? { points: [], entities: [], relations: [] };
}
async function openLegacyRectangle(parameters: Readonly<Record<string, number>> = {}) {
  const original = solidDocument();
  await mount({ ...original, parameters, features: [original.features[0]] });
  await act(async () => { viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }); viewport().apply({ kind: 'select-profile', profileId: 'rectangle' }); });
}
function viewport() {
  if (!currentViewport) throw new Error('Viewport controls unavailable.');
  return currentViewport;
}

const topologyBuild: CadBuildResult = { buildId: 'build-1', meshes: [{ featureId: 'pad', name: 'Pad 1', positions: [0, 0, 10, 50, 0, 10, 50, 40, 10], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2],
  edges: [0, 0, 10, 50, 0, 10], faceGroups: [{ start: 0, count: 3, key: 'face-1' }], edgeGroups: [{ start: 0, count: 2, key: 'edge-1' }], volume: 20_000,
  bounds: { min: [0, 0, 0], max: [50, 40, 10] } }], diagnostics: [], durationMs: 1 };
const selectedEdgeQuery = { queries: [{ kind: 'edges', predicates: [{ kind: 'line-endpoints', start: [0, 0, 10], end: [50, 0, 10] }], expectedCount: 1 }], expectedCount: 1 } satisfies Extract<CadTopologyResolvePicksResult, { purpose: 'fillet' | 'chamfer' }>['selection'];
const shellOpening = { kind: 'faces', predicates: [{ kind: 'plane', normal: [0, 0, 1], offset: 10 }, { kind: 'area', value: 2000 }, { kind: 'centroid', point: [25, 20, 10] }], expectedCount: 1 } satisfies Extract<CadTopologyResolvePicksResult, { purpose: 'shell' }>['opening'];
const inspectTopology: NonNullable<CadWorkbenchProps['onInspectTopology']> = async (request) => {
  const descriptors: CadTopologyDescriptor[] = [
    { kind: 'edge', key: 'edge-1', curveType: 'line', length: 50, start: [0, 0, 10], end: [50, 0, 10], centroid: [25, 0, 10], bounds: { min: [0, 0, 10], max: [50, 0, 10] } },
    { kind: 'face', key: 'face-1', surfaceType: 'plane', area: 2000, normal: [0, 0, 1], offset: 10, centroid: [25, 20, 10], bounds: { min: [0, 0, 10], max: [50, 40, 10] } },
  ];
  const selection = request.selection;
  return { bodyId: request.bodyId, buildId: request.expectedBuildId, descriptors: descriptors.filter((descriptor) => selection.kind === 'picks'
    ? selection.picks.some((pick) => pick.key === descriptor.key) : descriptor.kind === selection.topology), total: 1, nextOffset: null };
};
const resolveTopology: NonNullable<CadWorkbenchProps['onResolveSelection']> = async (request) => request.purpose === 'shell'
  ? { bodyId: request.bodyId, buildId: request.expectedBuildId, purpose: 'shell', opening: shellOpening }
  : { bodyId: request.bodyId, buildId: request.expectedBuildId, purpose: request.purpose, selection: selectedEdgeQuery };
function solidDocument() {
  return applyCadEdits(createCadDocument(), [
    { kind: 'add-feature', feature: { id: 'sketch', name: 'Outline', kind: 'sketch', plane: 'XY', offset: 0, suppressed: false, profiles: [{ id: 'rectangle', name: 'Plate', construction: false, role: 'outer', geometry: { kind: 'rectangle', x: 0, y: 0, width: 50, height: 40, cornerRadius: 0 } }] } },
    { kind: 'add-feature', feature: { id: 'pad', name: 'Pad 1', kind: 'extrude', suppressed: false, sketchId: 'sketch', distance: 10, symmetric: false, operation: 'new', targetId: null } },
  ]);
}
async function selectTopology(kind: 'edge' | 'face') {
  await act(async () => viewport().apply({ kind: 'select-topology', additive: false, selection: { documentVersion: currentSession.getSnapshot().version,
    buildId: topologyBuild.buildId, bodyId: 'pad', picks: [{ kind, key: kind === 'edge' ? 'edge-1' : 'face-1' }] } }));
}

describe('CAD sketch interaction', () => {
  it('copies an accepted consumed profile without opening its source, then releases its workflow before editing the new sketch', async () => {
    const source = solidDocument(), begin = vi.fn((id: string) => { currentSession.assertWorkflowClosed(); return id; });
    await mount(source, { build: null, buildState: 'idle', onBeginSketchEdit: begin });
    await click('Expand Pad 1'); await click('Expand Outline');
    const openCopy = async () => {
      await act(async () => button('Plate profile').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 })));
      const action = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === 'Copy outline to editable sketch');
      if (!action) throw new Error('Profile copy action missing.'); await act(async () => action.click());
    };
    await openCopy(); expect(currentDocument).toBe(source); expect(begin).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="Sketch drawing canvas"]')).not.toBeNull();
    expect(button('Apply').disabled).toBe(false); await click('Cancel');
    expect(currentDocument).toBe(source); expect(viewport().getState().workflowOpen).toBe(false);
    await openCopy(); await click('Apply');
    expect(currentDocument.features.slice(0, source.features.length)).toEqual(source.features);
    const copy = currentDocument.features.at(-1); if (copy?.kind !== 'sketch' || !copy.graph) throw new Error('Copied sketch missing.');
    expect(copy.profiles).toEqual([]); expect(copy.graph.entities).toHaveLength(4);
    expect(begin).toHaveBeenCalledExactlyOnceWith(copy.id); expect(viewport().getState().workflowOpen).toBe(false);
    expect(viewport().getState().sketchId).toBe(copy.id);
  });
  it('switches a generated profile between construction and geometry from the tree, and copies its outline to an editable sketch', async () => {
    const plate = { id: 'plate', kind: 'generator', idPrefix: 'plate', name: 'Plate', construction: false,
      geometry: { kind: 'rectangle', x: 0, y: 0, width: 50, height: 40, cornerRadius: 0 } } as const;
    const source = parseCadDocument({ ...createCadDocument('Plate', 'generated-plate'), schemaVersion: 2, features: [{ id: 'sketch', kind: 'sketch', name: 'Outline',
      plane: 'XY', offset: 0, suppressed: false, profiles: [], graph: { points: [], entities: [], relations: [plate] } }] });
    const begin = vi.fn((id: string) => id);
    await mount(source, { build: null, buildState: 'idle', onBeginSketchEdit: begin });
    await click('Expand Outline');
    const choose = async (label: string) => {
      await act(async () => button('Plate profile').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 })));
      const action = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === label);
      if (!action) throw new Error(`${label} is missing.`); await act(async () => action.click());
    };
    const graph = () => { const sketch = currentDocument.features[0]; if (sketch.kind !== 'sketch' || !sketch.graph) throw new Error('Sketch missing.'); return sketch.graph; };
    // The generator takes the flag, and its edges follow it.
    await choose('Use as construction');
    expect(graph().relations.find(relation => relation.id === 'plate')).toEqual({ ...plate, construction: true });
    expect(graph().entities.map(entity => entity.construction)).toEqual([true, true, true, true]);
    await choose('Use as geometry');
    expect(graph().relations.find(relation => relation.id === 'plate')).toEqual(plate);
    expect(graph().entities.map(entity => entity.construction)).toEqual([false, false, false, false]);
    await choose('Copy outline to editable sketch'); await click('Apply');
    const copy = currentDocument.features.at(-1); if (copy?.kind !== 'sketch' || !copy.graph || copy.id === 'sketch') throw new Error('Copied sketch missing.');
    expect(copy.profiles).toEqual([]); expect(copy.graph.relations.filter(relation => relation.kind === 'generator')).toEqual([]);
    expect(copy.graph.entities).toHaveLength(4);
    expect(begin).toHaveBeenCalledExactlyOnceWith(copy.id);
  });
  it('edits a regular polygon\'s count, radius expression and direction line in place, confirming the relation a lost vertex takes', async () => {
    const corner = (index: number, sides: number) => { const turn = 2 * Math.PI * index / sides; return [10 * Math.cos(turn), 10 * Math.sin(turn)] as [number, number]; };
    const polygon = { id: 'poly', kind: 'generator', idPrefix: 'poly', construction: false, geometry: { kind: 'regular-polygon', x: 0, y: 0, radius: 10, sides: 6, directionId: '@h' } } as const;
    await mount(parseCadDocument({ ...createCadDocument('Hexagon', 'generated-hexagon'), parameters: { size: 4 }, schemaVersion: 2, features: [{ id: 'sketch', kind: 'sketch', name: 'Outline',
      plane: 'XY', offset: 0, suppressed: false, profiles: [], graph: { points: [{ id: 'u', position: corner(5, 6) }, { id: 'd0', position: [30, 0] }, { id: 'd1', position: [30, 10] }],
        entities: [{ id: 'dir', kind: 'line', construction: false, startPointId: 'd0', endPointId: 'd1' }],
        relations: [polygon, { id: 'tie', kind: 'coincident', pointIds: ['u', 'poly_v5'] }] } }] }));
    await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }));
    await act(async () => viewport().apply({ kind: 'select-sketch-geometry', selection: { kind: 'entity', id: 'poly_e0' } }));
    await click('Edit shape');
    const before = currentDocument;
    // Five sides drop the sixth vertex, and the relation tying the free point to it, which Apply confirms.
    await input(field('Sides'), '5');
    expect(currentDocument).toBe(before);
    expect([...container.querySelectorAll('[role="status"]')].some(element => element.textContent?.startsWith('This removes one relation on geometry the shape no longer has: Coincident relation'))).toBe(true);
    // The canvas previews the pentagon the confirmed edit makes.
    expect(container.querySelector('[data-cad-sketch-entity="poly_e4"]')).not.toBeNull(); expect(container.querySelector('[data-cad-sketch-entity="poly_e5"]')).toBeNull();
    await click('Apply');
    const generated = () => sketchGraph().relations.find(relation => relation.id === 'poly');
    expect(generated()).toEqual({ ...polygon, geometry: { ...polygon.geometry, sides: 5 } });
    expect(sketchGraph().relations.some(relation => relation.id === 'tie')).toBe(false);
    expect(sketchGraph().points.filter(point => point.id.startsWith('poly_')).map(point => point.id)).toEqual(['poly_v0', 'poly_v1', 'poly_v2', 'poly_v3', 'poly_v4']);
    // The radius follows a parameter, and the first vertex turns to lie along the chosen line, still without detaching.
    await input(field('Radius'), 'size * 2');
    const direction = container.querySelector<HTMLSelectElement>('select[aria-label="Direction"]'); if (!direction) throw new Error('Direction missing.');
    expect([...direction.options].map(option => option.value)).toEqual(['@h', '@v', 'dir']);
    await act(async () => { direction.value = 'dir'; direction.dispatchEvent(new Event('change', { bubbles: true })); });
    await click('Apply');
    expect(generated()).toEqual({ ...polygon, geometry: { ...polygon.geometry, sides: 5, radius: 'size * 2', directionId: 'dir' } });
    const tip = sketchGraph().points.find(point => point.id === 'poly_v0')!.position;
    expect(tip[0]).toBeCloseTo(0, 9); expect(tip[1]).toBeCloseTo(8, 9);
  });
  it('keeps its mirror axis chooser alive through an owned keyboard menu without replacing the copied source selection', async () => {
    const source = pairedBoreMirrorPart(); await mount(source);
    await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }));
    await act(async () => viewport().apply({ kind: 'select-sketch-geometry', selection: { kind: 'entity', id: 'bore' } }));
    await click('Mirror copy');
    const canvas = container.querySelector<SVGSVGElement>('[aria-label="Sketch drawing canvas"]');
    const axis = container.querySelector<SVGGElement>('[data-cad-sketch-entity="axis"]');
    if (!canvas || !axis) throw new Error('Mirror axis canvas missing.');
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, toJSON: () => ({}) });
    await act(async () => { axis.focus(); axis.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })); });
    const choice = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === 'Use as mirror line');
    expect(choice).toBeDefined(); expect(viewport().getState().workflowOpen).toBe(true);
    expect(viewport().getState().selectedSketchGeometrySet).toEqual([{ kind: 'entity', id: 'bore' }]); expect(currentDocument).toBe(source);
    await act(async () => choice?.click()); expect(button('Apply').disabled).toBe(false);
    await click('Apply');
    const accepted = currentDocument.features[0]; if (accepted.kind !== 'sketch' || !accepted.graph) throw new Error('Copied bore missing.');
    expect(accepted.graph.points.at(-1)?.position).toEqual([45, 15]);
    expect(accepted.graph.entities.at(-1)).toMatchObject({ kind: 'circle', radius: 3 });
    expect(viewport().getState().selectedSketchGeometrySet).toEqual([{ kind: 'entity', id: accepted.graph.entities.at(-1)?.id }]);
    expect(viewport().getState().workflowOpen).toBe(false);
  });
  it('offsets the complete selected graph loop as one detached copy and selects its new geometry', async () => {
    const source = parseCadDocument({ ...createCadDocument('Plate', 'offset-plate'), schemaVersion: 2, features: [{
      id: 'sketch', kind: 'sketch', name: 'Plate', plane: 'XY', offset: 0, suppressed: false, profiles: [], graph: {
        points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [40, 0] }, { id: 'c', position: ['40.0000', '20.00'] }, { id: 'd', position: [0, 20] }],
        entities: ['ab', 'bc', 'cd', 'da'].map((id, index) => ({ id, kind: 'line', construction: false, startPointId: ['a', 'b', 'c', 'd'][index], endPointId: ['b', 'c', 'd', 'a'][index] })), relations: []
      }
    }] });
    await mount(source);
    await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }));
    expect(button('Offset loop').disabled).toBe(true);
    await act(async () => viewport().apply({ kind: 'select-sketch-geometry', selection: { kind: 'point', id: 'a' } }));
    expect(button('Offset loop').disabled).toBe(true);
    await act(async () => viewport().apply({ kind: 'select-sketch-geometry', selection: { kind: 'entity', id: 'ab' } }));
    await click('Offset loop');
    expect(currentDocument).toBe(source); expect(viewport().getState().workflowOpen).toBe(true);
    await input(field('Offset distance'), '2'); await click('Inside');
    const sourceSketch = source.features[0]; if (sourceSketch.kind !== 'sketch' || !sourceSketch.graph) throw new Error('Plate missing.');
    for (const entity of sourceSketch.graph.entities) expect(container.querySelector(`[data-cad-sketch-entity="${entity.id}"]`)?.classList.contains('is-relation-highlighted')).toBe(true);
    expect(currentDocument).toBe(source); await click('Apply');
    const accepted = currentDocument.features[0]; if (accepted.kind !== 'sketch' || !accepted.graph) throw new Error('Offset missing.');
    expect(accepted.graph.points.slice(0, 4)).toEqual(sourceSketch.graph.points);
    expect(accepted.graph.points.slice(4).map(point => point.position)).toEqual([[2, 2], [38, 2], [38, 18], [2, 18]]);
    expect(accepted.graph.entities).toHaveLength(8);
    const copy = accepted.graph.entities.slice(4);
    expect(viewport().getState().selectedSketchGeometrySet).toEqual(copy.map(entity => ({ kind: 'entity', id: entity.id })));
    expect(viewport().getState().workflowOpen).toBe(false);
    // The selected copy is a loop Offset takes again; edges from both loops name none.
    await click('Offset loop'); expect(viewport().getState().workflowOpen).toBe(true);
    for (const entity of accepted.graph.entities) expect(container.querySelector(`[data-cad-sketch-entity="${entity.id}"]`)?.classList.contains('is-relation-highlighted')).toBe(copy.includes(entity));
    await click('Cancel'); expect(currentDocument.features[0]).toBe(accepted);
    await act(async () => viewport().apply({ kind: 'select-sketch-geometry-set', selections: [{ kind: 'entity', id: 'ab' }, { kind: 'entity', id: copy[0].id }] }));
    expect(button('Offset loop').disabled).toBe(true);
  });

  it('opens the same offset editor for a legacy profile, cancels its preview, then accepts a detached graph copy', async () => {
    const source = parseCadDocument({ ...createCadDocument(), features: [{ id: 'sketch', kind: 'sketch', name: 'Bore', plane: 'XY', offset: 0, suppressed: false,
      profiles: [{ id: 'bore', name: 'Bore', construction: false, geometry: { kind: 'circle', x: ' 0 ', y: '0.0', radius: '10.000' } }] }] });
    await mount(source); await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }));
    await act(async () => viewport().apply({ kind: 'select-profile', profileId: 'bore' })); await click('Offset loop');
    expect(viewport().getState().workflowOpen).toBe(true);
    expect(button('Rectangle').disabled).toBe(true); expect(button('Finish sketch').disabled).toBe(true);
    expect(container.querySelectorAll('[data-cad-sketch-entity]')).toHaveLength(1);
    await input(field('Offset distance'), '2'); expect(currentDocument).toBe(source);
    expect(container.querySelector('[data-cad-sketch-entity] circle')?.getAttribute('r')).toBe('12');
    await click('Cancel'); expect(currentDocument).toBe(source); expect(viewport().getState().selectedProfileId).toBe('bore');
    expect(viewport().getState().workflowOpen).toBe(false); await click('Offset loop');
    await input(field('Offset distance'), '2'); await click('Apply');
    const accepted = currentDocument.features[0]; if (accepted.kind !== 'sketch' || !accepted.graph) throw new Error('Offset missing.');
    expect(accepted.profiles).toEqual(source.features[0].kind === 'sketch' ? source.features[0].profiles : []);
    expect(accepted.graph.entities[0]).toMatchObject({ kind: 'circle', radius: 12 });
    expect(viewport().getState().selectedSketchGeometrySet).toEqual([{ kind: 'entity', id: accepted.graph.entities[0].id }]);
    expect(viewport().getState().selectedProfileId).toBeNull(); expect(viewport().getState().workflowOpen).toBe(false);
  });
  it('selects the accepted Split joint in the real owned sketch workspace after private publication', async () => {
    const initial = parseCadDocument({ ...createCadDocument(), schemaVersion: 2, features: [{ id: 'sketch', kind: 'sketch', name: 'Outline',
      suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
        points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [20, 0] }, { id: 'c', position: [20, 10] }, { id: 'd', position: [0, 10] }],
        entities: ['a', 'b', 'c', 'd'].map((id, index) => ({ id: `${id}-edge`, kind: 'line', construction: false, startPointId: id, endPointId: ['b', 'c', 'd', 'a'][index] })), relations: []
      } }, { id: 'pad', kind: 'extrude', name: 'Pad', suppressed: false, sketchId: 'sketch', distance: 5, symmetric: false, operation: 'new', targetId: null }] });
    const main = new CadSession(initial), base = main.getSnapshot(), storage = {};
    function Harness() {
      useSyncExternalStore(main.subscribe, main.getSnapshot);
      const editing = useCadSketchEditing({ session: main, storage, open: true, locked: false,
        prepare: async (document, edits, signal) => { await Promise.resolve(); signal?.throwIfAborted(); return applyCadEdits(document, edits); },
        inspect: async () => undefined, commit: (edits, version, signal) => main.editPrepared(version, async document => applyCadEdits(document, edits), signal) });
      const snapshot = editing.snapshot; currentDocument = snapshot.document;
      return <CadWorkbench document={snapshot.document} documentVersion={snapshot.version} build={null} buildVersion={null} buildState="idle" dirty={snapshot.dirty}
        canUndo={snapshot.canUndo} canRedo={snapshot.canRedo} onEdit={(edit, signal) => editing.sketchId ? editing.edit([edit], signal) : main.edit([edit])}
        onEditMany={(edits, signal) => editing.sketchId ? editing.edit(edits, signal) : main.edit(edits)} onBeginSketchEdit={editing.begin}
        sketchEdit={editing.sketchId ? { sketchId: editing.sketchId, finish: editing.finish, cancel: editing.cancel, inspectAreaRepairs: editing.inspectAreaRepairs } : undefined}
        onWorkflowChange={editing.setWorkflowOpen} onUndo={editing.undo} onRedo={editing.redo} onSave={save} onBack={vi.fn()} onSendToCam={sendToCam}
        onOpenDocument={vi.fn()} onNewDocument={vi.fn()} onImportDocument={async () => undefined} onExportDocument={vi.fn()}
        onExportSolid={async () => undefined} onOpenDxfExport={async () => undefined} onViewportControlsReady={controls => { currentViewport = controls; }} />;
    }
    await act(async () => root.render(<Harness />));
    await act(async () => viewport().apply({ kind: 'select-feature', featureId: 'sketch' })); await openSelected();
    expect(currentDocument.features).toHaveLength(1); expect(main.getSnapshot().document).toBe(base.document);
    const canvas = container.querySelector<SVGSVGElement>('[aria-label="Sketch drawing canvas"]'); if (!canvas) throw new Error('Sketch canvas missing.');
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, toJSON: () => ({}) });
    let captured = false;
    Object.assign(canvas, { setPointerCapture: () => { captured = true; }, hasPointerCapture: () => captured, releasePointerCapture: () => { captured = false; } });
    const state = viewport().getState().view; if (!state || state.mode === 'solid') throw new Error('Sketch frame missing.');
    const viewWidth = Number(canvas.getAttribute('viewBox')?.split(' ')[2]);
    const pointer = async (type: string) => {
      const event = new MouseEvent(type, { button: 2, buttons: type === 'pointerup' ? 0 : 2, bubbles: true, cancelable: true,
        clientX: 300 + (5 - state.centerMm[0]) / viewWidth * 600, clientY: 200 + state.centerMm[1] / state.heightSpanMm * 400 });
      Object.defineProperties(event, { pointerId: { value: 11 }, isPrimary: { value: true } });
      await act(async () => canvas.dispatchEvent(event));
    };
    await pointer('pointerdown'); await pointer('pointerup');
    const id = container.querySelector('[data-cad-sketch-split-point]')?.getAttribute('data-cad-sketch-split-point'); if (!id) throw new Error('Split preview missing.');
    await click('Split here');
    const localDocument = currentDocument, accepted = localDocument.features[0]; if (accepted.kind !== 'sketch') throw new Error('Accepted sketch missing.');
    expect(accepted.graph?.entities).toHaveLength(5);
    expect(viewport().getState().selectedSketchGeometrySet).toEqual([{ kind: 'point', id }]);
    expect(container.querySelector(`[data-cad-sketch-point="${id}"]`)?.getAttribute('aria-pressed')).toBe('true');
    expect(button('Move selection').disabled).toBe(false); expect(main.getSnapshot().document).toBe(base.document);
    expect(currentDocument).toBe(localDocument); expect(viewport().getState().workflowOpen).toBe(false);
    expect(main.getSnapshot().document).toBe(base.document);
  });

  it('reports an unchanged authoritative point move without inferring permanent mobility, and ignores cancelled receipts', async () => {
    const source = parseCadDocument({ ...createCadDocument(), schemaVersion: 2, features: [{ id: 'sketch', kind: 'sketch', name: 'Constrained points', plane: 'XY', offset: 0, suppressed: false, profiles: [], graph: {
      points: [{ id: 'a', position: ['0', '0'] }, { id: 'b', position: [40, 0] }, { id: 'c', position: [50, 20] }],
      entities: [{ id: 'ab', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' }],
      relations: [{ id: 'h', kind: 'horizontal', pointIds: ['a', 'b'] }, { id: 'd', kind: 'distance', pointIds: ['a', 'b'], value: 40 }]
    } }] });
    const edit = vi.fn<NonNullable<CadWorkbenchProps['onEditMany']>>(() => currentSession.getSnapshot());
    await mount(source, { build: null, buildState: 'idle', onEditMany: edit });
    await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }));
    const point = container.querySelector<SVGGElement>('[data-cad-sketch-point="b"]'); if (!point) throw new Error('Missing point.');
    await act(async () => point.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })));
    expect(edit).toHaveBeenCalledOnce(); expect(statusMessage).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('constrained'), 'info');
    expect(currentSession.getSnapshot()).toMatchObject({ document: source, canUndo: false, workflowOpen: false });
    let accept: (value: ReturnType<CadSession['getSnapshot']>) => void = () => { throw new Error('No pending move.'); };
    edit.mockImplementationOnce(() => new Promise(resolve => { accept = resolve; }));
    await act(async () => point.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })));
    const signal = edit.mock.calls[1]?.[1]; expect(signal?.aborted).toBe(false);
    await act(async () => point.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(signal?.aborted).toBe(true);
    await act(async () => accept(currentSession.getSnapshot()));
    expect(statusMessage).toHaveBeenCalledOnce(); expect(currentSession.getSnapshot()).toMatchObject({ document: source, canUndo: false, workflowOpen: false });
  });

  it('prunes removed graph targets from selection before a later source can reuse their IDs', async () => {
    const initial = parseCadDocument({ ...createCadDocument(), schemaVersion: 2, features: [{ id: 'sketch', kind: 'sketch', name: 'Source selection', plane: 'XY', offset: 0, suppressed: false, profiles: [], graph: {
      points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [20, 0] }],
      entities: [{ id: 'ab', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' }], relations: []
    } }] });
    await mount(initial);
    await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }));
    await act(async () => viewport().apply({ kind: 'select-sketch-geometry-set', selections: [{ kind: 'point', id: 'a' }, { kind: 'point', id: 'b' }] }));
    await act(async () => currentSession.edit([{ kind: 'delete-sketch-elements', sketchId: 'sketch', pointIds: ['b'], entityIds: [], relationIds: [], cascade: true }]));
    const afterRemoval = currentSession.getSnapshot();
    expect(viewport().getState().selectedSketchGeometrySet).toEqual([{ kind: 'point', id: 'a' }]);
    expect(currentSession.getSnapshot()).toBe(afterRemoval);
    const sketch = currentDocument.features[0]; if (sketch.kind !== 'sketch' || !sketch.graph) throw new Error('Sketch missing');
    const graph = sketch.graph;
    await act(async () => currentSession.edit([{ kind: 'update-feature', feature: { ...sketch, graph: { ...graph,
      points: [...graph.points, { id: 'b', position: [50, 40] }] } } }]));
    const afterReuse = currentSession.getSnapshot();
    expect(viewport().getState().selectedSketchGeometrySet).toEqual([{ kind: 'point', id: 'a' }]);
    expect(currentSession.getSnapshot()).toBe(afterReuse);
    await act(async () => currentSession.undo());
    await act(async () => currentSession.undo());
    expect(currentDocument).toEqual(initial);
    expect(viewport().getState().selectedSketchGeometrySet).toEqual([{ kind: 'point', id: 'a' }]);
  });
  it('owns one graph selection set for Shift selection, agent selection, construction and one-step set deletion', async () => {
    const initial = parseCadDocument({ ...createCadDocument(), schemaVersion: 2, features: [{ id: 'sketch', kind: 'sketch', name: 'Set sketch', plane: 'XY', offset: 0, suppressed: false, profiles: [], graph: {
      points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [20, 0] }, { id: 'c', position: [20, 10] }],
      entities: [{ id: 'ab', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' }, { id: 'bc', kind: 'line', construction: false, startPointId: 'b', endPointId: 'c' }], relations: []
    } }] });
    await mount(initial);
    await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }));
    const target = (id: string) => { const element = container.querySelector(`[data-cad-sketch-point="${id}"]`); if (!element) throw new Error('Point missing'); return element; };
    await act(async () => target('a').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    await act(async () => target('b').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true })));
    expect(viewport().getState().selectedSketchGeometrySet).toEqual([{ kind: 'point', id: 'a' }, { kind: 'point', id: 'b' }]);
    expect(viewport().getState().selectedSketchGeometry).toBeUndefined();
    expect(currentDocument).toEqual(initial); expect(currentSession.getSnapshot().canUndo).toBe(false);
    await act(async () => viewport().apply({ kind: 'select-sketch-geometry-set', selections: [{ kind: 'entity', id: 'ab' }, { kind: 'entity', id: 'bc' }] }));
    const construction = container.querySelector<HTMLInputElement>('.cad-sketch-options input'); if (!construction) throw new Error('Construction control missing');
    await act(async () => construction.click());
    const converted = currentDocument.features[0]; if (converted.kind !== 'sketch') throw new Error('Sketch missing');
    expect(converted.graph?.entities.map(entity => entity.construction)).toEqual([true, true]);
    await click('Delete selected geometry');
    const deleted = currentDocument.features[0]; if (deleted.kind !== 'sketch') throw new Error('Sketch missing');
    expect(deleted.graph?.entities).toEqual([]); expect(deleted.graph?.points).toEqual(converted.graph?.points);
    await act(async () => currentSession.undo());
    expect(currentDocument.features[0]).toEqual(converted);
  });
  it('changes the selected legacy profile construction through an owned edit without changing drawing defaults', async () => {
    const initial = parseCadDocument({ ...createCadDocument(), parameters: { slotLength: 30 }, features: [{
      id: 'sketch', kind: 'sketch', name: 'Slot sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [{
        id: 'slot', name: 'Slot', construction: false, geometry: { kind: 'slot', x: 0, y: 0, length: ' slotLength ', width: 8, angle: 20 }
      }]
    }] });
    let accept: () => void = () => { throw new Error('Missing pending construction edit.'); };
    let reject: (error: Error) => void = () => { throw new Error('Missing pending construction edit.'); };
    const edit = vi.fn<NonNullable<CadWorkbenchProps['onEdit']>>((intent, signal) => new Promise((resolve, decline) => {
      accept = () => { try { signal?.throwIfAborted(); resolve(currentSession.edit([intent])); } catch (error) { decline(error); } };
      reject = decline;
    }));
    await mount(initial, { build: null, buildState: 'idle', onEdit: edit });
    await act(async () => { viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }); viewport().apply({ kind: 'select-profile', profileId: 'slot' }); });
    const control = () => {
      const found = container.querySelector<HTMLInputElement>('.cad-sketch-options input');
      if (!found) throw new Error('Construction control missing.'); return found;
    };
    await act(async () => control().click());
    expect(edit).toHaveBeenCalledOnce(); expect(currentDocument).toBe(initial); expect(control().disabled).toBe(true);
    await act(async () => accept());
    const accepted = currentDocument, sketch = accepted.features[0];
    if (sketch.kind !== 'sketch' || initial.features[0].kind !== 'sketch') throw new Error('Sketch missing.');
    expect(sketch.profiles[0]).toEqual({ ...initial.features[0].profiles[0], construction: true });
    expect(control().checked).toBe(true);
    await act(async () => currentSession.undo()); expect(currentDocument).toEqual(initial);
    await act(async () => currentSession.redo()); expect(currentDocument).toEqual(accepted); expect(control().checked).toBe(true);
    await act(async () => control().click());
    await act(async () => reject(new Error('A downstream feature needs the material.')));
    expect(currentDocument).toEqual(accepted); expect(control().checked).toBe(true); expect(currentSession.getSnapshot().workflowOpen).toBe(false);
    await act(async () => control().click());
    const signal = edit.mock.calls.at(-1)?.[1]; expect(signal?.aborted).toBe(false);
    await canvasKey('Escape'); expect(signal?.aborted).toBe(true);
    await act(async () => accept()); expect(currentDocument).toEqual(accepted);
    await click('Rectangle'); expect(control().checked).toBe(false);
  });
  it('asks before a sketch edit\'s Finish removes a later sketch\'s relations, keeps the draft on Cancel and commits the confirmed edit on Apply', async () => {
    const polygon: CadSketchGenerator = { id: 'poly', kind: 'generator', idPrefix: 'poly', construction: false,
      geometry: { kind: 'regular-polygon', x: 40, y: 0, radius: 10, sides: 'n', directionId: '@h' } };
    const corner = expandCadSketchGenerators({ points: [], entities: [], relations: [polygon] }, { n: 6 }).points.find(point => point.id === 'poly_v5')!.position;
    const initial = parseCadDocument({ ...createCadDocument(), schemaVersion: 2, parameters: { n: 6 }, parameterMetadata: { n: { source: { kind: 'manual' } } }, features: [
      { id: 'sketch', kind: 'sketch', name: 'Outline', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
        points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [20, 0] }, { id: 'c', position: [20, 10] }, { id: 'd', position: [0, 10] }],
        entities: ['a', 'b', 'c', 'd'].map((id, index) => ({ id: `${id}-edge`, kind: 'line', construction: false, startPointId: id, endPointId: ['b', 'c', 'd', 'a'][index] })), relations: [] } },
      { id: 'pad', kind: 'extrude', name: 'Pad', suppressed: false, sketchId: 'sketch', distance: 5, symmetric: false, operation: 'new', targetId: null },
      { id: 'later', kind: 'sketch', name: 'Later polygon', suppressed: false, plane: 'XY', offset: 0, profiles: [],
        graph: { points: [{ id: 'u', position: corner }], entities: [], relations: [polygon, { id: 'tie', kind: 'coincident', pointIds: ['u', 'poly_v5'] }] } }] });
    const main = new CadSession(initial), base = main.getSnapshot(), storage = {};
    let editing: ReturnType<typeof useCadSketchEditing> | undefined;
    const commit = vi.fn((edits: readonly CadEdit[], version: string, signal?: AbortSignal) => main.editPrepared(version, async document => applyCadEdits(document, edits), signal));
    function Harness() {
      useSyncExternalStore(main.subscribe, main.getSnapshot);
      editing = useCadSketchEditing({ session: main, storage, open: true, locked: false,
        prepare: async (document, edits, signal) => { signal?.throwIfAborted(); return applyCadEdits(document, edits); }, inspect: async () => undefined, commit });
      const snapshot = editing.snapshot; currentDocument = snapshot.document;
      return <CadWorkbench document={snapshot.document} documentVersion={snapshot.version} build={null} buildVersion={null} buildState="idle" dirty={snapshot.dirty}
        canUndo={snapshot.canUndo} canRedo={snapshot.canRedo} onEdit={(edit, signal) => editing!.sketchId ? editing!.edit([edit], signal) : main.edit([edit])}
        onEditMany={(edits, signal) => editing!.sketchId ? editing!.edit(edits, signal) : main.edit(edits)} onBeginSketchEdit={editing.begin}
        sketchEdit={editing.sketchId ? { sketchId: editing.sketchId, finish: editing.finish, cancel: editing.cancel, inspectAreaRepairs: editing.inspectAreaRepairs } : undefined}
        onWorkflowChange={editing.setWorkflowOpen} onUndo={editing.undo} onRedo={editing.redo} onSave={save} onBack={vi.fn()} onSendToCam={sendToCam}
        onOpenDocument={vi.fn()} onNewDocument={vi.fn()} onImportDocument={async () => undefined} onExportDocument={vi.fn()}
        onExportSolid={async () => undefined} onOpenDxfExport={async () => undefined} onViewportControlsReady={controls => { currentViewport = controls; }} />;
    }
    await act(async () => root.render(<Harness />));
    await act(async () => viewport().apply({ kind: 'select-feature', featureId: 'sketch' })); await openSelected();
    expect(editing?.sketchId).toBe('sketch');
    await act(async () => editing!.edit([{ kind: 'set-parameter', name: 'n', value: 5 }]));
    const edited = editing!.snapshot;
    const confirmation = () => container.querySelector<HTMLElement>('[aria-label="Confirm finishing the sketch"]');
    const within = (label: string) => [...confirmation()!.querySelectorAll('button')].find(entry => entry.textContent?.trim() === label)!;
    // Finish finds the relation the later polygon loses and asks, naming it; nothing commits and the draft stays open.
    await click('Finish sketch');
    expect(commit).toHaveBeenCalledTimes(1);
    expect(confirmation()?.textContent).toContain('This removes one relation on geometry the shape no longer has: Coincident "tie". Apply removes it, or Cancel keeps it.');
    expect(container.querySelector('.cad-error')).toBeNull();
    expect(main.getSnapshot()).toMatchObject({ version: base.version }); expect(main.getSnapshot().document).toBe(base.document); expect(editing?.sketchId).toBe('sketch'); expect(editing?.snapshot.document).toBe(edited.document); expect(editing?.snapshot.version).toBe(edited.version);
    await act(async () => within('Cancel').click());
    expect(confirmation()).toBeNull(); expect(editing?.sketchId).toBe('sketch'); expect(editing?.snapshot.document).toBe(edited.document); expect(editing?.snapshot.version).toBe(edited.version); expect(main.getSnapshot()).toMatchObject({ version: base.version }); expect(main.getSnapshot().document).toBe(base.document);
    // Apply finishes again with the relation confirmed: the part is what the same confirmed parameter edit makes of it, in one undo step.
    await click('Finish sketch');
    await act(async () => within('Apply').click());
    expect(commit).toHaveBeenLastCalledWith([{ kind: 'set-parameter', name: 'n', value: 5, removedRelationIds: ['tie'] }], base.version, expect.anything());
    expect(editing?.sketchId).toBeNull(); expect(confirmation()).toBeNull();
    expect(main.getSnapshot().document).toEqual(applyCadEdits(base.document, [{ kind: 'set-parameter', name: 'n', value: 5, removedRelationIds: ['tie'] }]));
    await act(async () => main.undo()); expect(main.getSnapshot().document).toBe(base.document);
  });
  it('shows only current sketch areas while repairing a consumed boundary, without accepted suffix solids', async () => {
    const prefix = solidDocument(), sourceSketch = prefix.features[0];
    if (sourceSketch.kind !== 'sketch') throw new Error('Sketch fixture missing');
    const edited = { ...sourceSketch, id: 'second-sketch', name: 'Edited outline' };
    const initial = applyCadEdits(prefix, [{ kind: 'add-feature', feature: edited }]);
    const cells = prepareCadSketchCells(edited, initial.parameters);
    const finish = vi.fn();
    const staleConsumer = { ...prefix.features[1], id: 'second-pad', name: 'Dependent pad', sketchId: edited.id };
    if (staleConsumer.kind !== 'extrude') throw new Error('Pad fixture missing');
    const build = { ...topologyBuild, meshes: [...topologyBuild.meshes, { ...topologyBuild.meshes[0], featureId: 'second-pad', volume: 1234 }] };
    await mount(initial, { build, buildState: 'ready', sketchEdit: { sketchId: edited.id, cancel: vi.fn(), finish,
      inspectAreaRepairs: () => ({ sketchId: edited.id, localVersion: currentSession.getSnapshot().version,
        consumers: [{ feature: staleConsumer, issue: 'The selected boundary changed.', cells }] }) } });
    await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: edited.id }));
    await click('Finish sketch');
    await click('Choose areas for Dependent pad');
    expect(container.querySelector('[aria-label="3D model viewport"]')?.getAttribute('data-displayed-volumes')).toBe('');
    expect(viewportRegions?.cells).toBe(cells);
    expect(viewportRegions?.sketchId).toBe(edited.id);
    await act(async () => viewportRegions?.onSelect([cells.cells[0].reference]));
    await click('Finish area selection');
    expect(container.querySelector('form[aria-label="Update dependent sketch areas"]')).not.toBeNull();
    expect(button('Finish sketch').disabled).toBe(false);
    expect(finish).not.toHaveBeenCalled();
    expect(currentDocument).toEqual(initial);
  });
  it('releases a clean command workflow when suppression rejects because a dependent solid still needs its source', async () => {
    const initial = applyCadEdits(solidDocument(), [{ kind: 'add-feature', feature: {
      id: 'rounded', name: 'Rounded plate', kind: 'fillet', targetId: 'pad', radius: 1, suppressed: false
    } }]);
    const onWorkflowChange = (open: boolean) => { workflow(open); currentSession.setWorkflowOpen(open); };
    await mount(initial, { build: null, buildState: 'idle', onWorkflowChange });
    await act(async () => viewport().apply({ kind: 'select-feature', featureId: 'pad' }));
    const before = currentSession.getSnapshot();
    await rowMenu('Pad 1', 'Suppress feature');
    expect(currentSession.getSnapshot()).toMatchObject({ document: before.document, version: before.version, workflowOpen: false, canUndo: false });
    expect(workflow).toHaveBeenLastCalledWith(false);
    expect(currentDocument.features.find(feature => feature.id === 'pad')?.suppressed).toBe(false);
  });
  it('retains actual name-edit ownership after a synchronous command rejection', async () => {
    const onWorkflowChange = (open: boolean) => { workflow(open); currentSession.setWorkflowOpen(open); };
    await mount(solidDocument(), { build: null, buildState: 'idle', onWorkflowChange });
    const before = currentSession.getSnapshot(), name = await partName();
    await act(async () => name.focus()); await input(name, '   '); await act(async () => name.blur());
    expect(currentSession.getSnapshot()).toMatchObject({ document: before.document, version: before.version, workflowOpen: true, canUndo: false });
    expect(name.value).toBe('   '); expect(workflow).toHaveBeenLastCalledWith(true);
    await act(async () => name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(currentSession.getSnapshot().workflowOpen).toBe(false);
  });
  it('waits for sketch creation acceptance, preserves a rejected plane, and ignores a cancelled late creation', async () => {
    let rejectFirst: (error: Error) => void = () => { throw new Error('No first edit'); };
    let resolveRetry: () => void = () => { throw new Error('No retry edit'); };
    const first = new Promise<void>((_accept, reject) => { rejectFirst = reject; });
    const retry = new Promise<void>(accept => { resolveRetry = accept; });
    void first.catch(() => undefined);
    const signals: AbortSignal[] = []; let attempts = 0;
    await mount(createCadDocument(), { build: null, buildState: 'idle', onEdit: (edit, signal) => {
      if (signal) signals.push(signal);
      const wait = ++attempts === 1 ? first : attempts === 2 ? retry : null;
      currentSession.setWorkflowOpen(true, 'preparation');
      return currentSession.editPrepared(currentSession.getSnapshot().version, async source => {
        await wait; return applyCadEdits(source, [edit]);
      }, signal).finally(() => currentSession.setWorkflowOpen(false, 'preparation'));
    } });
    await startSketch();
    expect(currentDocument.features).toHaveLength(0);
    expect(container.querySelector('[aria-label="Sketch drawing canvas"]')).toBeNull();
    expect(currentSession.getSnapshot().workflowOpen).toBe(true);
    await act(async () => rejectFirst(new Error('The new sketch conflicts.')));
    expect(viewport().getState().selectedReferencePlane).toBe('XY');
    await click('Sketch');
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(signals[1]?.aborted).toBe(true);
    await act(async () => viewport().apply({ kind: 'select-reference-plane', plane: 'XZ' }));
    await click('Sketch');
    const accepted = currentDocument;
    await act(async () => resolveRetry());
    expect(currentDocument).toBe(accepted);
    expect(currentDocument.features).toMatchObject([{ kind: 'sketch', plane: 'XZ' }]);
    expect(viewport().getState()).toMatchObject({ sketchId: currentDocument.features[0].id });
  });

  it.each(['solid', 'sketch'] as const)('keeps the %s context while editing a shared value and navigates only through explicit Inspect', async context => {
    const initial = parseCadDocument({ ...createCadDocument('Tapered outlet', 'parameter_context'), parameters: { height: 20, baseRadius: 10 }, features: [
      { id: 'base', name: 'Base section', kind: 'sketch', suppressed: false, plane: 'XY', offset: 0,
        profiles: [{ id: 'base_circle', name: 'Base circle', construction: false, geometry: { kind: 'circle', x: 0, y: 0, radius: 'baseRadius' } }] },
      { id: 'outlet', name: 'Outlet section', kind: 'sketch', suppressed: false, plane: 'XY', offset: 'height',
        profiles: [{ id: 'outlet_circle', name: 'Outlet circle', construction: false, geometry: { kind: 'circle', x: 0, y: 0, radius: 5 } }] },
      { id: 'loft', name: 'Loft', kind: 'loft', suppressed: false, sketchIds: ['base', 'outlet'], ruled: false, operation: 'new', targetId: null },
    ] });
    const build = { ...topologyBuild, meshes: topologyBuild.meshes.map(mesh => ({ ...mesh, featureId: 'loft', name: 'Loft' })) };
    await mount(initial, { build, buildState: 'ready' });
    if (context === 'solid') await act(async () => viewport().apply({ kind: 'select-feature', featureId: 'loft' }));
    else {
      await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'base' }));
      await act(async () => viewport().apply({ kind: 'select-profile', profileId: 'base_circle' }));
    }
    const expectedContext = context === 'solid' ? { selectedFeatureId: 'loft', sketchId: null, selectedProfileId: null, view: { mode: 'solid' } }
      : { selectedFeatureId: 'base', sketchId: 'base', selectedProfileId: 'base_circle', view: { mode: 'sketch' } };
    expect(viewport().getState()).toMatchObject(expectedContext);
    const canvas = container.querySelector(context === 'solid' ? '[aria-label="3D model viewport"]' : '.cad-sketch-viewport');
    const cancelParameter = async () => {
      const dialog = document.querySelector('.cad-parameter-editor');
      const cancel = [...dialog?.querySelectorAll('button') ?? []].find(button => button.textContent?.trim() === 'Cancel');
      if (!cancel) throw new Error('Missing floating parameter Cancel.'); await act(async () => cancel.click());
    };
    await click('Expand Parameters'); const before = currentSession.getSnapshot();
    await click('Edit parameter height');
    expect(viewport().getState()).toMatchObject(expectedContext);
    expect(container.contains(canvas)).toBe(true);
    expect(document.querySelector('.cad-parameter-editor')?.textContent).toContain('Outlet section');
    await input(field('Value'), '25');
    expect(viewport().getState()).toMatchObject(expectedContext); expect(container.contains(canvas)).toBe(true);
    expect(currentSession.getSnapshot()).toMatchObject({ document: before.document, version: before.version, workflowOpen: true, canUndo: before.canUndo });
    await cancelParameter();
    expect(currentSession.getSnapshot()).toEqual(before); expect(viewport().getState()).toMatchObject(expectedContext); expect(container.contains(canvas)).toBe(true);
    await click('Edit parameter height'); await click('Inspect Outlet section');
    expect(viewport().getState()).toMatchObject({ selectedFeatureId: 'outlet', sketchId: 'outlet', selectedProfileId: null, view: { mode: 'sketch' } });
    expect(field('Value').value).toBe('20');
    await cancelParameter();
    expect(currentSession.getSnapshot()).toEqual(before); expect(viewport().getState()).toMatchObject({ selectedFeatureId: 'outlet', sketchId: 'outlet', view: { mode: 'sketch' } });
  });

  it('keeps an accepted thin Pad volume visibly positive without changing its exact source or history', async () => {
    const document = parseCadDocument({ ...createCadDocument(), parameters: { width: 4e-7 }, features: [
      { id: 'sketch', name: 'Thin outline', kind: 'sketch', plane: 'XY', offset: 0, suppressed: false, profiles: [{ id: 'rectangle', name: 'Thin plate', construction: false,
        geometry: { kind: 'rectangle', x: 0, y: 0, width: ' width ', height: 20, cornerRadius: 0 } }] },
      { id: 'pad', name: 'Thin Pad', kind: 'extrude', suppressed: false, sketchId: 'sketch', distance: 10, symmetric: false, operation: 'new', targetId: null }
    ] }), volume = measureCadSketch(document, 'sketch').materialAreaMm2 * 10;
    const build: CadBuildResult = { ...topologyBuild, meshes: [{ ...topologyBuild.meshes[0], name: 'Thin Pad', positions: [0, 0, 10, 4e-7, 0, 10, 4e-7, 20, 10],
      edges: [], faceGroups: [], edgeGroups: [], volume, bounds: { min: [0, 0, 0], max: [4e-7, 20, 10] } }] };
    await mount(document, { build, buildState: 'ready' }); const before = currentSession.getSnapshot();
    await act(async () => viewport().apply({ kind: 'select-feature', featureId: 'pad' })); await rowMenu('Thin Pad', 'Properties');
    expect(property('Volume')).toBe(`${volume.toLocaleString(undefined, { notation: 'scientific', maximumSignificantDigits: 6, useGrouping: false })} mm³`);
    expect(currentSession.getSnapshot()).toMatchObject({ document: before.document, version: before.version, workflowOpen: false }); expect(viewport().getState().selectedFeatureId).toBe('pad'); expect(build.meshes[0].volume).toBe(volume);
  });

  it.each(['Fillet', 'Chamfer'] as const)('refuses an explicit face for %s without broadening its scope, while deliberate body selection still permits all edges', async command => {
    const resolve = vi.fn(resolveTopology), preview = vi.fn();
    await mount(solidDocument(), { build: topologyBuild, buildState: 'ready', onInspectTopology: inspectTopology, onResolveSelection: resolve, onFeaturePreview: preview });
    await selectTopology('face');
    const before = currentSession.getSnapshot(), selection = viewport().getState().topologySelection;
    preview.mockClear(); await click(command);
    expect(currentSession.getSnapshot()).toBe(before); expect(viewport().getState().topologySelection).toEqual(selection);
    expect(resolve).not.toHaveBeenCalled(); expect(preview.mock.calls.some(([request]) => request.kind === 'candidate')).toBe(false);
    expect(container.querySelector('select[aria-label="Scope"]')).toBeNull();
    expect(statusMessage).toHaveBeenCalledWith(expect.stringContaining('Pick edges'), 'error');
    await click('Select Pad 1 in history'); await click(command);
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Scope"]')?.value).toBe('all');
    expect(resolve).not.toHaveBeenCalled(); await click('Cancel'); expect(currentSession.getSnapshot()).toEqual(before);
  });

  it('opens and selects the last of 257 accepted datum references without changing the document or history', async () => {
    const document = parseCadDocument({ ...createCadDocument('Station references', 'station_references'),
      features: Array.from({ length: 257 }, (_, index) => ({ id: `station_${index}`, name: `Station ${index}`, kind: 'datum-plane', suppressed: false,
        definition: { kind: 'world', basePlane: 'XY', origin: [0, 0, index], rotation: [0, 0, 0] } })) });
    await mount(document);
    const before = currentSession.getSnapshot();
    expect([...container.querySelectorAll<HTMLElement>('.cad-feature-node')].map(node => node.dataset.cadFeatureId)).toEqual(document.features.map(feature => feature.id));
    await act(async () => viewport().apply({ kind: 'select-feature', featureId: 'station_256' }));
    expect(viewport().getState()).toMatchObject({ selectedFeatureId: 'station_256', selectedReferencePlane: { kind: 'datum-plane', featureId: 'station_256' } });
    expect(currentSession.getSnapshot()).toBe(before);
    expect(currentDocument).toBe(document);
  });
  it('shows the selected native body component count beside volume without inferring a count from older builds or changing history', async () => {
    const counted = { ...topologyBuild, meshes: topologyBuild.meshes.map(mesh => ({ ...mesh, solidCount: 2 })) };
    await mount(solidDocument(), { build: counted, buildState: 'ready' });
    const before = currentSession.getSnapshot(); await rowMenu('Pad 1', 'Properties');
    expect(property('Volume')).toBe('20,000 mm³');
    expect(property('Solids')).toBe('2');
    await act(async () => replaceBuild(topologyBuild));
    expect(property('Solids')).toBeUndefined();
    const unknown = container.querySelector('.cad-properties-list');
    expect(unknown?.textContent).toContain('20,000 mm³');
    expect(unknown?.textContent).not.toMatch(/\d+ solids?/);
    expect(currentSession.getSnapshot()).toMatchObject({ document: before.document, version: before.version, canUndo: before.canUndo });
  });
  it('previews a sketch fillet without accepting the draft', async () => {
    await mount(solidDocument()); await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' })); await click('Plate profile');
    const before = currentSession.getSnapshot(); await click('Sketch fillet');
    const radius = container.querySelector<HTMLInputElement>('input[aria-label="Fillet radius"]'); if (!radius) throw new Error('Missing radius');
    await input(radius, '5');
    expect(currentSession.getSnapshot().document).toBe(before.document); expect(currentSession.getSnapshot().version).toBe(before.version);
    await click('Cancel'); expect(currentSession.getSnapshot().document).toBe(before.document);
  });
  it('reports annotation visibility from the actual free or dimensioned contour and preview state', async () => {
    await mount(solidDocument()); await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' })); await click('Plate profile');
    expect(viewport().getState().view).toMatchObject({ onPartDimensionsVisible: false });
    await click('Add dimension'); expect(viewport().getState().view).toMatchObject({ onPartDimensionsVisible: false }); await click('Apply');
    expect(viewport().getState().view).toMatchObject({ onPartDimensionsVisible: true });
    await click('Sketch fillet'); const radius = container.querySelector<HTMLInputElement>('input[aria-label="Fillet radius"]'); if (!radius) throw new Error('Missing radius');
    await input(radius, '5'); expect(viewport().getState().view).toMatchObject({ onPartDimensionsVisible: false });
    await click('Cancel'); expect(viewport().getState().view).toMatchObject({ onPartDimensionsVisible: true });
  });
  it('owns a tree profile rename and commits only its name as one undo step', async () => {
    const original = solidDocument(); await mount(original);
    await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }));
    await click('Plate profile');
    const target = button('Plate profile');
    await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true })));
    const name = container.querySelector<HTMLInputElement>('input[aria-label="Profile name"]'); if (!name) throw new Error('Missing tree rename');
    await input(name, 'Mounting plate');
    expect(currentSession.getSnapshot().workflowOpen).toBe(true);
    expect(button('Save').disabled).toBe(true); expect(button('Finish sketch').disabled).toBe(true);
    await click('Apply name');
    const sketch = currentDocument.features[0]; if (sketch.kind !== 'sketch') throw new Error('Missing sketch');
    expect(sketch.profiles[0]).toEqual({ ...original.features[0].kind === 'sketch' ? original.features[0].profiles[0] : {}, name: 'Mounting plate' });
    expect(currentSession.getSnapshot().workflowOpen).toBe(false);
    await act(async () => currentSession.undo()); expect(currentDocument).toEqual(original);
  });

  it('routes the contextual dimension command to the selected free contour and retains one-step Undo', async () => {
    const original = solidDocument(); await mount(original);
    await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' })); await click('Plate profile');
    const dock = container.querySelector('[aria-label="CAD tools"]'); expect(dock?.getAttribute('data-cad-tool-context')).toBe('sketch');
    const dimension = dock?.querySelector<HTMLButtonElement>('button[aria-label="Dimension"]'); if (!dimension) throw new Error('Missing dimension command');
    await act(async () => dimension.click());
    const value = container.querySelector<HTMLInputElement>('input[aria-label="Dimension value"]'); if (!value) throw new Error('Missing dimension value');
    await input(value, '60'); expect(button('Finish sketch').disabled).toBe(true);
    await click('Apply');
    const sketch = currentDocument.features[0]; if (sketch.kind !== 'sketch') throw new Error('Missing sketch');
    expect(sketch.profiles[0]).toMatchObject({ role: 'outer', constraints: [{ kind: 'dimension', quantity: 'width' }], geometry: { kind: 'rectangle', x: 0, y: 0, width: 60, height: 40, cornerRadius: 0 } });
    expect(currentSession.getSnapshot().workflowOpen).toBe(false);
    const move = dock?.querySelector<HTMLButtonElement>('button[aria-label="Move profile"]'); if (!move) throw new Error('Missing move command');
    await act(async () => move.click());
    expect(container.querySelector('input[aria-label="Move X"]')).not.toBeNull(); await click('Cancel');
    await act(async () => currentSession.undo()); expect(currentDocument).toEqual(original);
  });

  it('routes Move to the exact graph selection and owns the workspace until Cancel even at zero displacement', async () => {
    const source = parseCadDocument({ ...createCadDocument(), schemaVersion: 2, features: [{ id: 'sketch', kind: 'sketch', name: 'Movable edges', plane: 'XY', offset: 0, suppressed: false, profiles: [], graph: {
      points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [20, 0] }],
      entities: [{ id: 'line', kind: 'line', startPointId: 'a', endPointId: 'b', construction: true }], relations: []
    } }] });
    await mount(source); await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }));
    const selections = [{ kind: 'entity' as const, id: 'line' }, { kind: 'point' as const, id: 'a' }];
    await act(async () => viewport().apply({ kind: 'select-sketch-geometry-set', selections }));
    await click('Move selection'); expect(container.querySelector('input[aria-label="Move X"]')).not.toBeNull();
    expect(button('Finish sketch').disabled).toBe(true); expect(button('Save').disabled).toBe(true);
    expect(currentSession.getSnapshot()).toMatchObject({ document: source, workflowOpen: true, canUndo: false });
    await click('Cancel'); expect(currentSession.getSnapshot()).toMatchObject({ document: source, workflowOpen: false, canUndo: false });
    expect(viewport().getState().selectedSketchGeometrySet).toEqual(selections);
  });

  it('finishes the active sketch from its header without changing geometry or history', async () => {
    const original = solidDocument();
    await mount(original);
    await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }));
    const header = container.querySelector('[data-cad-sketch-header]');
    expect(header?.getAttribute('aria-label')).toBe('Sketch editing');
    const finish = header?.querySelector<HTMLButtonElement>('button[aria-label="Finish sketch"]');
    expect(finish).toBeTruthy();
    const before = currentSession.getSnapshot();
    await act(async () => finish?.click());
    expect(viewport().getState().sketchId).toBeNull();
    expect(currentSession.getSnapshot().version).toBe(before.version);
    expect(currentDocument).toEqual(original);
  });

  it('reads current inspector and sketch bar bounds only on Fit and keeps the canvas/camera stable when the panel minimizes', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
    let panelHeight = 600;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute('data-cad-model-tree')) return new DOMRect(110, 60, 180, 200);
      if (this.hasAttribute('data-cad-command-dock')) return new DOMRect(400, 789, 300, 55);
      // The sketch bar, 8 px below the top of the view and centred.
      if (this.hasAttribute('data-cad-sketch-header')) return new DOMRect(380, 58, 340, 30);
      const panel = this.hasAttribute('data-cad-properties');
      const left = panel ? 700 : 100, top = panel ? 62 : 50, width = panel ? 280 : 900, height = panel ? panelHeight : 800;
      return { x: left, y: top, left, top, right: left + width, bottom: top + height, width, height, toJSON: () => ({}) };
    });
    const initial = solidDocument(); await mount(initial);
    await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }));
    const state = viewport().getState().view;
    if (!state || state.mode === 'solid') throw new Error('Expected sketch view.');
    const scale = 800 / state.heightSpanMm;
    expect(450 + (50 - state.centerMm[0]) * scale).toBeLessThanOrEqual(600);
    expect(450 + (0 - state.centerMm[0]) * scale).toBeGreaterThanOrEqual(0);
    // The plate's top edge, at y 40, starts below the bar, whose bottom is 38 px into the view.
    expect(400 - (40 - state.centerMm[1]) * scale).toBeGreaterThanOrEqual(38);
    panelHeight = 24; await click('Minimize configuration');
    expect(viewport().getState().view).toEqual(state);
    await act(async () => viewport().apply({ kind: 'fit' }));
    const minimized = viewport().getState().view;
    expect(minimized).not.toEqual(state);
    expect(container.querySelector('.cad-center')?.contains(container.querySelector('[data-cad-model-tree]'))).toBe(true);
    expect(currentDocument).toBe(initial);
  });
  it('fits a sketch below the sketch bar, which covers the top of a short wide view', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(300);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      // The bar, 8 px below the top of the view and centred; the panels lie outside the view.
      if (this.hasAttribute('data-cad-sketch-header')) return new DOMRect(380, 58, 340, 30);
      if (this.matches('[data-cad-properties], [data-cad-model-tree], [data-cad-command-dock]')) return new DOMRect(-500, -500, 10, 10);
      return new DOMRect(100, 50, 900, 300);
    });
    await mount(solidDocument()); await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }));
    const state = viewport().getState().view;
    if (!state || state.mode === 'solid') throw new Error('Expected sketch view.');
    // The 50 × 40 plate fills the height left under the bar, so its top edge, at y 40, lies below the bar's bottom, 38 px into the view.
    const scale = 300 / state.heightSpanMm;
    expect(150 - (40 - state.centerMm[1]) * scale).toBeGreaterThanOrEqual(38);
    expect(150 - (0 - state.centerMm[1]) * scale).toBeLessThanOrEqual(300);
  });
  it('owns optional depth interaction through the real feature editor and releases one correlated batch to ordinary Apply/Undo', async () => {
    setCadPreferences({ navigationMode: 'mouse', showOnPartDimensions: true, showDepthHandles: true });
    const original = solidDocument(), initial = applyCadEdits(original, [{ kind: 'set-parameter', name: 'depth', value: 10 },
      { kind: 'update-feature', feature: { ...original.features[1], kind: 'extrude', sketchId: 'sketch', distance: ' depth ', symmetric: false, operation: 'new', targetId: null } }]);
    const preview = vi.fn<NonNullable<CadWorkbenchProps['onFeaturePreview']>>();
    await mount(initial, { build: topologyBuild, buildState: 'ready', onFeaturePreview: preview });
    await act(async () => viewport().apply({ kind: 'select-feature', featureId: 'pad' })); await act(async () => { container.querySelector('.cad-tree-row[aria-pressed="true"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    const control = viewportDepth;
    if (!control) throw new Error('Expected the current editor depth control.');
    const before = currentSession.getSnapshot(), state = control.getState();
    let token: string | null = null;
    await act(async () => { token = control.begin(state!.definitionKey); });
    if (!token) throw new Error('Expected editable gesture.');
    await act(async () => control.setQuantity(token!, 20));
    expect(viewportDepth).toBe(control); expect(field('Length').value).toBe('20');
    expect(currentDocument).toBe(initial); expect(currentSession.getSnapshot()).toMatchObject({ version: before.version, workflowOpen: true });
    const command = preview.mock.calls.map(([entry]) => entry).filter(entry => entry.kind === 'candidate').at(-1);
    if (!command || command.kind !== 'candidate') throw new Error('Missing provisional depth preview.');
    await act(async () => replaceFeaturePreview({ kind: 'ready', owner: command.owner, baseVersion: command.expectedVersion, featureId: 'pad',
      candidateId: 'depth-preview', definitionKey: cadFeatureCandidateKey(command.edits), document: applyCadEdits(initial, command.edits),
      result: { ...topologyBuild, meshes: topologyBuild.meshes.map(mesh => ({ ...mesh, volume: 40_000 })) } }));
    expect(button('Apply').disabled).toBe(true);
    await act(async () => control.release(token!)); await click('Apply');
    expect(currentDocument.parameters.depth).toBe(20); expect(currentDocument.features).toEqual(initial.features);
    await act(async () => currentSession.undo()); expect(currentDocument).toEqual(initial);
  });

  it('qualifies depth handles by device preference and selection ownership without changing the accepted part', async () => {
    setCadPreferences({ navigationMode: 'trackpad', showOnPartDimensions: false, showDepthHandles: false });
    const initial = solidDocument(); await mount(initial, { build: topologyBuild, buildState: 'ready' });
    await act(async () => viewport().apply({ kind: 'select-feature', featureId: 'pad' })); await act(async () => { container.querySelector('.cad-tree-row[aria-pressed="true"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    expect(viewportDepth).toBeNull();
    await act(async () => setCadPreferences({ navigationMode: 'trackpad', showOnPartDimensions: false }));
    const previous = viewportDepth;
    if (!previous) throw new Error('Depth handles are shown unless the device turned them off.');
    await click('Pick closed areas from model'); expect(viewportDepth).toBeNull();
    await click('Cancel area selection'); expect(viewportDepth).toBe(previous);
    await act(async () => setCadPreferences({ navigationMode: 'trackpad', showOnPartDimensions: false, showDepthHandles: false }));
    expect(viewportDepth).toBeNull(); expect(currentDocument).toBe(initial);
    await act(async () => replaceDocument({ ...initial, name: 'Another accepted part' }));
    expect(previous.getState()).toBeNull(); expect(viewportDepth).toBeNull(); expect(currentDocument.name).toBe('Another accepted part');
  });

  it('drags a selected Pad or its picked end face into one undoable Length edit without a dialog', async () => {
    setCadPreferences({ navigationMode: 'mouse', showOnPartDimensions: true });
    const initial = solidDocument(), preview = vi.fn<NonNullable<CadWorkbenchProps['onFeaturePreview']>>();
    await mount(initial, { build: topologyBuild, buildState: 'ready', onFeaturePreview: preview });
    await selectTopology('edge'); expect(viewportDepth).toBeNull();
    await selectTopology('face');
    const control = viewportDepth; if (!control) throw new Error('A picked end face must expose its Pad depth.');
    expect(control.featureId).toBe('pad'); expect(container.querySelector('[aria-label="Length"]')).toBeNull();
    const token = control.begin(control.getState()?.definitionKey ?? ''); if (!token) throw new Error('Expected a drag.');
    expect(currentSession.getSnapshot().workflowOpen).toBe(false);
    await act(async () => { control.setQuantity(token, 25); });
    expect(currentSession.getSnapshot().workflowOpen).toBe(true); expect(currentDocument).toBe(initial);
    expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'candidate', owner: control.owner }));
    await act(async () => { control.release(token); });
    expect(currentDocument.features[1]).toEqual({ ...initial.features[1], distance: 25 });
    expect(currentSession.getSnapshot()).toMatchObject({ canUndo: true, workflowOpen: false });
    expect(preview).toHaveBeenLastCalledWith({ kind: 'clear', owner: control.owner });
    expect(viewportDepth?.featureId).toBe('pad'); expect(viewportDepth).not.toBe(control);
    await act(async () => currentSession.undo()); expect(currentDocument).toEqual(initial);
  });

  it('keeps the correlated quantity preview while choosing areas and cancels only that choice before one Apply/Undo', async () => {
    const original = solidDocument();
    const initial = applyCadEdits(original, [{ kind: 'set-parameter', name: 'depth', value: 10 },
      { kind: 'update-feature', feature: { ...original.features[1], kind: 'extrude', sketchId: 'sketch', distance: ' depth ', symmetric: false, operation: 'new', targetId: null } }]);
    const preview = vi.fn<NonNullable<CadWorkbenchProps['onFeaturePreview']>>();
    await mount(initial, { build: topologyBuild, buildState: 'ready', onFeaturePreview: preview });
    await act(async () => viewport().apply({ kind: 'select-feature', featureId: 'pad' })); await act(async () => { container.querySelector('.cad-tree-row[aria-pressed="true"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    const version = currentSession.getSnapshot().version;
    await input(field('Length'), '20');
    const candidateCommand = preview.mock.calls.map(([command]) => command).filter(command => command.kind === 'candidate').at(-1);
    if (!candidateCommand || candidateCommand.kind !== 'candidate') throw new Error('Expected correlated preview.');
    const candidate = applyCadEdits(initial, candidateCommand.edits);
    await act(async () => replaceFeaturePreview({ kind: 'ready', owner: candidateCommand.owner, baseVersion: candidateCommand.expectedVersion, featureId: 'pad',
      candidateId: 'candidate', definitionKey: cadFeatureCandidateKey(candidateCommand.edits), document: candidate,
      result: { ...topologyBuild, meshes: topologyBuild.meshes.map(mesh => ({ ...mesh, volume: 40_000 })) } }));
    await click('Pick closed areas from model');
    expect(viewportRegions?.sketchId).toBe('sketch'); expect(viewportRegions?.selection).toBeUndefined();
    expect(container.querySelector('[aria-label="3D model viewport"]')?.getAttribute('data-displayed-volumes')).toBe('40000');
    expect(container.querySelector('[aria-label="3D model viewport"]')?.getAttribute('data-source-reference-pick-ids')).toBe('sketch');
    expect(requestViewportMenu).toBeUndefined(); expect(currentSession.getSnapshot()).toMatchObject({ version, workflowOpen: true });
    if (!viewportRegions) throw new Error('Missing owned region picker.');
    await act(async () => viewportRegions?.onSelect([]));
    expect(button('Apply').disabled).toBe(true); expect(currentDocument).toBe(initial);
    await click('Cancel area selection');
    expect(viewportRegions).toBeNull(); expect(field('Length').value).toBe('20'); expect(currentDocument).toBe(initial);
    await click('Apply');
    expect(currentDocument.parameters.depth).toBe(20); expect(currentDocument.features[1]).toEqual(initial.features[1]);
    await act(async () => currentSession.undo()); expect(currentDocument).toEqual(initial);
  });

  it('retains source-owned area picking through an accepted native build publication without loosening whole-source picks', async () => {
    const initial = solidDocument(); await mount(initial, { build: topologyBuild, buildState: 'ready' });
    await act(async () => viewport().apply({ kind: 'select-feature', featureId: 'pad' })); await act(async () => { container.querySelector('.cad-tree-row[aria-pressed="true"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    await click('Pick closed areas from model'); const command = viewportRegions;
    if (!command) throw new Error('Missing source-owned areas.');
    const before = currentSession.getSnapshot();
    await act(async () => replaceBuild({ ...topologyBuild, buildId: 'republished-native-build' }));
    expect(viewportRegions).toBe(command); expect(currentDocument).toBe(initial);
    expect(currentSession.getSnapshot()).toMatchObject({ version: before.version, workflowOpen: true });
    await act(async () => command.onSelect(command.cells.pack(command.cells.selectedCellIds(undefined))));
    expect(viewportRegions?.cells).toBe(command.cells); expect(viewportRegions?.placement).toBe(command.placement);
    await click('Cancel area selection'); expect(viewportRegions).toBeNull();
    await click('Pick profile sketch from model');
    expect(container.querySelector('[aria-label="3D model viewport"]')?.getAttribute('data-source-reference-pick-ids')).toBe('sketch');
    await act(async () => replaceBuild({ ...topologyBuild, buildId: 'another-native-build' }));
    expect(container.querySelector('[aria-label="3D model viewport"]')?.getAttribute('data-source-reference-pick-ids')).toBe('');
    expect(currentDocument).toBe(initial);
  });

  it('invalidates area-picking callbacks on document replacement without substituting a new source or leaving a picker open', async () => {
    const initial = solidDocument(); await mount(initial, { build: topologyBuild, buildState: 'ready' });
    await act(async () => viewport().apply({ kind: 'select-feature', featureId: 'pad' })); await act(async () => { container.querySelector('.cad-tree-row[aria-pressed="true"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    await click('Pick closed areas from model'); const previous = viewportRegions;
    if (!previous) throw new Error('Missing owned region picker.');
    const replacement = { ...initial, name: 'Replacement part' };
    await act(async () => replaceDocument(replacement));
    const acceptedReplacement = currentDocument, replacementVersion = currentSession.getSnapshot().version;
    expect(viewportRegions).toBeNull();
    await act(async () => { previous.onSelect([{ boundaryProfileId: 'rectangle', voidProfileIds: [], ancestorProfileIds: [] }]); previous.onFinish(); previous.onCancel(); });
    expect(currentDocument).toBe(acceptedReplacement); expect(currentDocument).toEqual(replacement);
    expect(currentSession.getSnapshot().version).toBe(replacementVersion);
    expect(container.querySelector('[aria-label="3D model viewport"]')?.getAttribute('data-source-reference-pick-ids')).toBe('');
    expect(container.querySelector('[aria-label="Finish area selection"]')).toBeNull();
  });

  it('picks a profile sketch with type guards and invalidates the owned picker on document replacement', async () => {
    const original = solidDocument(), first = original.features[0];
    if (first.kind !== 'sketch') throw new Error('Expected sketch fixture.');
    const initial = applyCadEdits(original, [{ kind: 'add-feature', feature: { ...first, id: 'sketch-b', name: 'Outline B', offset: 5 } }]);
    await mount(initial, { build: topologyBuild, buildState: 'ready' });
    await act(async () => viewport().apply({ kind: 'select-feature', featureId: 'sketch' }));
    await act(async () => requestViewportMenu?.({ clientX: 100, clientY: 100, trigger: 'pointer', target: { kind: 'feature', featureId: 'sketch-b' } }));
    await click('Pad sketch');
    expect((container.querySelector('[aria-label="Profile sketch"]') as HTMLSelectElement).value).toBe('sketch-b');
    await click('Pick profile sketch from model');
    expect(container.querySelector('[aria-label="3D model viewport"]')?.getAttribute('data-source-reference-pick-ids')).toBe('sketch,sketch-b');
    await act(async () => pickViewportFeature?.('pad'));
    expect(container.querySelector('[aria-label="Cancel source selection"]')).not.toBeNull();
    expect((container.querySelector('[aria-label="Profile sketch"]') as HTMLSelectElement).value).toBe('sketch-b');
    await act(async () => pickViewportFeature?.('sketch'));
    expect(container.querySelector('[aria-label="3D model viewport"]')?.getAttribute('data-source-reference-pick-ids')).toBe('');
    expect((container.querySelector('[aria-label="Profile sketch"]') as HTMLSelectElement).value).toBe('sketch');
    await click('Pick profile sketch from model');
    await act(async () => replaceDocument({ ...initial, name: 'Replaced part' }));
    expect(container.querySelector('[aria-label="Cancel source selection"]')).toBeNull();
    expect(container.querySelector('[aria-label="3D model viewport"]')?.getAttribute('data-source-reference-pick-ids')).toBe('');
    expect(currentDocument.features).toEqual(initial.features);
    expect(currentDocument.name).toBe('Replaced part');
    await click('Cancel');
  });

  it('starts Pad from a usable material sketch and keeps empty or construction-only sketches out of source choices', async () => {
    const original = solidDocument(), material = original.features[0];
    if (material.kind !== 'sketch') throw new Error('Expected material sketch.');
    await mount({ ...createCadDocument('Pad source eligibility'), features: [material,
      { ...material, id: 'empty', name: 'Empty', profiles: [] },
      { ...material, id: 'guides', name: 'Guides', profiles: material.profiles.map(profile => ({ ...profile, construction: true })) }
    ] });
    await click('Pad / Pocket');
    const select = container.querySelector<HTMLSelectElement>('[aria-label="Profile sketch"]');
    expect(select?.value).toBe(material.id);
    expect([...select?.options ?? []].map(option => option.value)).toEqual([material.id]);
    await click('Pick profile sketch from model');
    await act(async () => pickViewportFeature?.('empty'));
    expect(container.querySelector('[aria-label="Cancel source selection"]')).not.toBeNull();
    await act(async () => pickViewportFeature?.('guides'));
    expect(select?.value).toBe(material.id);
    await act(async () => pickViewportFeature?.(material.id));
    expect(container.querySelector('[aria-label="Cancel source selection"]')).toBeNull();
    expect(currentSession.getSnapshot().document.features).toHaveLength(3);
  });

  it('does not advertise Pad when the only material sketch is suppressed', async () => {
    const material = solidDocument().features[0]; if (material.kind !== 'sketch') throw new Error('Expected sketch.');
    await mount({ ...createCadDocument('Suppressed source'), features: [{ ...material, suppressed: true }] });
    expect(button('Pad / Pocket').disabled).toBe(true);
  });

  it('checks Pad, Revolve and Sweep sources again only for a new document in the model toolbar, and not while a sketch is open', async () => {
    const material = solidDocument().features[0]; if (material.kind !== 'sketch') throw new Error('Expected material sketch.');
    const sourceChecks = () => vi.mocked(cadSketchSourceAvailability).mock.calls.length + vi.mocked(cadSketchSourceIssue).mock.calls.length;
    const clearSourceChecks = () => { vi.mocked(cadSketchSourceAvailability).mockClear(); vi.mocked(cadSketchSourceIssue).mockClear(); };
    const enabled = () => ['Pad / Pocket', 'Revolve', 'Sweep'].map(label => !button(label).disabled);
    await mount({ ...createCadDocument('Source checks'), features: [material,
      { id: 'rail', name: 'Rail', kind: 'curve', suppressed: false, plane: 'XZ', offset: 0, segments: [{ kind: 'line', start: [0, 0], end: [0, 20] }] }] });
    expect(enabled()).toEqual([true, true, true]);
    // Selecting renders the workbench again for the same document.
    clearSourceChecks();
    await act(async () => viewport().apply({ kind: 'select-feature', featureId: material.id }));
    expect(enabled()).toEqual([true, true, true]); expect(sourceChecks()).toBe(0);
    await act(async () => currentSession.edit([{ kind: 'update-feature', feature: { ...material, suppressed: true } }]));
    expect(enabled()).toEqual([false, false, false]);
    await act(async () => currentSession.edit([{ kind: 'update-feature', feature: material }]));
    expect(enabled()).toEqual([true, true, true]);
    clearSourceChecks();
    await act(async () => currentSession.edit([{ kind: 'set-parameter', name: 'width', value: 5 }]));
    expect(sourceChecks()).toBeGreaterThan(0);
    await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: material.id }));
    expect(button('Finish sketch')).toBeDefined();
    clearSourceChecks();
    await act(async () => currentSession.edit([{ kind: 'update-feature', feature: { ...material, suppressed: true } }]));
    expect(sourceChecks()).toBe(0);
    await act(async () => currentSession.edit([{ kind: 'update-feature', feature: material }]));
    await click('Finish sketch');
    expect(enabled()).toEqual([true, true, true]);
  });

  it('lists transitive dependents in history order only while the delete dialog is open, and deletes them together', async () => {
    const solid = solidDocument(), material = solid.features[0]; if (material.kind !== 'sketch') throw new Error('Expected material sketch.');
    await mount(applyCadEdits(solid, [
      { kind: 'add-feature', feature: { ...material, id: 'boss_sketch', name: 'Boss sketch', offset: 10 } },
      { kind: 'add-feature', feature: { id: 'boss', name: 'Boss', kind: 'extrude', suppressed: false, sketchId: 'boss_sketch', distance: 5, symmetric: false, operation: 'join', targetId: 'pad' } },
    ]));
    const pressDelete = async (featureId: string) => {
      await act(async () => viewport().apply({ kind: 'select-feature', featureId }));
      const row = container.querySelector<HTMLButtonElement>('.cad-tree-row[aria-pressed="true"]'); if (!row) throw new Error('Selected history row missing.');
      await act(async () => { row.focus(); row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })); });
      const dialog = container.querySelector<HTMLDivElement>('[role="dialog"]'); if (!dialog) throw new Error('Delete dialog missing.');
      return dialog;
    };
    const outline = await pressDelete('sketch');
    expect(outline.textContent).toContain('This also deletes 2 dependent features.');
    expect([...outline.querySelectorAll('li')].map(item => item.textContent)).toEqual(['Pad 1', 'Boss']);
    await click('Delete with dependents');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(currentSession.getSnapshot().document.features.map(feature => feature.id)).toEqual(['boss_sketch']);
    const boss = await pressDelete('boss_sketch');
    expect(boss.querySelector('li')).toBeNull(); expect(boss.textContent).toContain('You can restore this feature with Undo.');
    await click('Delete');
    expect(currentSession.getSnapshot().document.features).toEqual([]);
  });

  it('renders the workbench again for sketch freedom only when the shown value changes', async () => {
    const source = parseCadDocument({ ...createCadDocument('Plate', 'freedom-plate'), schemaVersion: 2, features: [{
      id: 'sketch', kind: 'sketch', name: 'Plate', plane: 'XY', offset: 0, suppressed: false, profiles: [], graph: {
        points: [{ id: 'center', position: [0, 0] }], entities: [{ id: 'bore', kind: 'circle', centerPointId: 'center', radius: 5, construction: false }], relations: [] } }] });
    const session = new CadSession(source); currentSession = session;
    const answers: { version?: string; resolve(degreesOfFreedom: number): void }[] = [];
    const inspect = vi.fn((sketchId: string, version?: string) => new Promise<CadSketchConstraintInspection>(resolve => answers.push({ version, resolve: degreesOfFreedom => resolve({
      sketchId, pointCount: 1, entityCount: 1, relationCount: 0, legacyProfileCount: 0, legacyDimensionCount: 0, degreesOfFreedomScope: 'graph', graph: null, parameters: {},
      analysis: { kind: 'solved', diagnostics: { status: 'success', degreesOfFreedom, conflictingIds: [], redundantIds: [], partiallyRedundantIds: [], issues: [] } } }) })));
    let setReady: (ready: boolean) => void = () => undefined;
    function Harness() {
      const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
      const [ready, setReadyState] = useState(true); setReady = setReadyState; currentDocument = snapshot.document;
      return <CadWorkbench document={snapshot.document} documentVersion={snapshot.version} build={null} buildVersion={null} buildState="idle" dirty={snapshot.dirty}
        canUndo={snapshot.canUndo} canRedo={snapshot.canRedo} onEdit={edit => { session.edit([edit]); }} onEditMany={edits => session.edit(edits)}
        sketchAnalysisReady={ready} onInspectSketchConstraints={inspect} onWorkflowChange={open => session.setWorkflowOpen(open)} onUndo={undo} onRedo={vi.fn()}
        onSave={save} onBack={vi.fn()} onSendToCam={sendToCam} onOpenDocument={vi.fn()} onNewDocument={vi.fn()} onImportDocument={async () => undefined}
        onExportDocument={vi.fn()} onExportSolid={async () => undefined} onOpenDxfExport={async () => undefined} onViewportControlsReady={controls => { currentViewport = controls; }} />;
    }
    await act(async () => root.render(<Harness />));
    await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }));
    await act(async () => viewport().apply({ kind: 'select-sketch-geometry', selection: { kind: 'entity', id: 'bore' } }));
    const status = () => container.querySelector('[aria-label="Sketch constraint status"]')?.textContent;
    const radiusLocked = () => container.querySelector('[data-cad-sketch-circle-radius="bore"]')?.getAttribute('aria-disabled') === 'true';
    const renders = async (change: () => void) => { workbenchRenders = 0; await act(async () => change()); return workbenchRenders; };
    expect(answers.map(answer => answer.version)).toEqual([session.getSnapshot().version]);
    expect(await renders(() => answers[0].resolve(0))).toBe(1);
    expect(status()).toBe('Fully defined'); expect(radiusLocked()).toBe(true);

    // A new document hides the earlier freedom without another render.
    const moved = currentDocument.features[0]; if (moved.kind !== 'sketch' || !moved.graph) throw new Error('Sketch graph missing.');
    const move: CadEdit = { kind: 'update-feature', feature: { ...moved, graph: { ...moved.graph, points: [{ id: 'center', position: [1, 0] }] } } };
    expect(await renders(() => session.edit([move]))).toBe(1);
    expect(status()).toBe('Checking freedom…'); expect(radiusLocked()).toBe(false);
    expect(answers.map(answer => answer.version)).toEqual([expect.any(String), session.getSnapshot().version]);
    // Pausing and resuming the analysis reports no freedom again, which keeps the state.
    expect(await renders(() => setReady(false))).toBe(1); expect(status()).toBe('Editing…');
    expect(await renders(() => setReady(true))).toBe(1); expect(status()).toBe('Checking freedom…');
    expect(answers).toHaveLength(3); expect(answers[2].version).toBe(session.getSnapshot().version);
    expect(await renders(() => answers[2].resolve(0))).toBe(1);
    expect(status()).toBe('Fully defined'); expect(radiusLocked()).toBe(true);
    expect(await renders(() => answers[1].resolve(4))).toBe(0); expect(radiusLocked()).toBe(true);
    // A pause hides the answer and resuming shows it again, each a render after the status reports it. The same answer
    // from the new analysis keeps it.
    expect(await renders(() => setReady(false))).toBe(2); expect(status()).toBe('Editing…'); expect(radiusLocked()).toBe(false);
    expect(await renders(() => setReady(true))).toBe(2); expect(status()).toBe('Fully defined'); expect(radiusLocked()).toBe(true);
    expect(answers).toHaveLength(4);
    expect(await renders(() => answers[3].resolve(0))).toBe(0); expect(radiusLocked()).toBe(true);
  });

  it.each(['empty', 'guides'])('does not substitute another sketch when the selected %s sketch has no material contours', async selectedId => {
    const material = solidDocument().features[0]; if (material.kind !== 'sketch') throw new Error('Expected material sketch.');
    const initial = { ...createCadDocument('Explicit source selection'), features: [material,
      { ...material, id: 'empty', name: 'Empty', profiles: [] },
      { ...material, id: 'guides', name: 'Guides', profiles: material.profiles.map(profile => ({ ...profile, construction: true })) }
    ] };
    await mount(initial);
    const before = currentSession.getSnapshot();
    await act(async () => viewport().apply({ kind: 'select-feature', featureId: selectedId }));
    await click('Pad / Pocket');
    expect(container.querySelector('select[aria-label="Profile sketch"]')).toBeNull();
    expect(statusMessage).toHaveBeenLastCalledWith(expect.stringContaining(`Selected sketch "${selectedId === 'empty' ? 'Empty' : 'Guides'}" has no closed material contours.`), 'error');
    expect(currentSession.getSnapshot().document).toBe(before.document);
    expect(currentSession.getSnapshot().version).toBe(before.version);
    expect(currentSession.getSnapshot().workflowOpen).toBe(false);
    await act(async () => viewport().apply({ kind: 'select-feature', featureId: null }));
    await click('Pad / Pocket');
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Profile sketch"]')?.value).toBe(material.id);
  });

  it('starts Revolve from the latest active material sketch, including datum sources, and keeps invalid sources out of its picker', async () => {
    const material = solidDocument().features[0]; if (material.kind !== 'sketch') throw new Error('Expected material sketch.');
    const initial = applyCadEdits(createCadDocument('Revolve sources'), [
      { kind: 'add-feature', feature: material },
      { kind: 'add-feature', feature: { id: 'datum', name: 'Datum', kind: 'datum-plane', suppressed: false, definition: { kind: 'world', basePlane: 'XY', origin: [3, 4, 5], rotation: [20, 0, 10] } } },
      { kind: 'add-feature', feature: { ...material, id: 'datum_profile', name: 'Datum profile', plane: { kind: 'datum-plane', featureId: 'datum' } } },
      { kind: 'add-feature', feature: { ...material, id: 'suppressed', name: 'Suppressed', suppressed: true } },
      { kind: 'add-feature', feature: { ...material, id: 'empty', name: 'Empty', profiles: [] } },
      { kind: 'add-feature', feature: { ...material, id: 'guides', name: 'Guides', profiles: material.profiles.map(profile => ({ ...profile, construction: true })) } }
    ]);
    await mount(initial); const before = currentSession.getSnapshot();
    await click('Revolve');
    const sources = container.querySelector<HTMLSelectElement>('select[aria-label="Profile sketch"]');
    expect(sources?.value).toBe('datum_profile');
    expect([...sources?.options ?? []].map(option => option.value)).toEqual(['sketch', 'datum_profile']);
    await input(field('Angle'), '270');
    await click('Pick profile sketch from model');
    await act(async () => pickViewportFeature?.('guides'));
    expect(container.querySelector('[aria-label="Cancel source selection"]')).not.toBeNull();
    await act(async () => pickViewportFeature?.('empty'));
    await act(async () => pickViewportFeature?.('suppressed'));
    expect(sources?.value).toBe('datum_profile');
    await act(async () => pickViewportFeature?.(material.id));
    expect(container.querySelector('[aria-label="Cancel source selection"]')).toBeNull();
    expect(sources?.value).toBe(material.id); expect(field('Angle').value).toBe('270');
    expect(currentSession.getSnapshot().document).toBe(before.document); expect(currentSession.getSnapshot().version).toBe(before.version);
  });

  it.each(['empty', 'guides', 'suppressed'])('rejects an explicitly selected %s Revolve sketch without replacing it', async selectedId => {
    const material = solidDocument().features[0]; if (material.kind !== 'sketch') throw new Error('Expected material sketch.');
    await mount({ ...createCadDocument('Explicit Revolve source'), features: [material,
      { ...material, id: 'empty', name: 'Empty', profiles: [] },
      { ...material, id: 'guides', name: 'Guides', profiles: material.profiles.map(profile => ({ ...profile, construction: true })) },
      { ...material, id: 'suppressed', name: 'Suppressed', suppressed: true }
    ] });
    const before = currentSession.getSnapshot();
    await act(async () => viewport().apply({ kind: 'select-feature', featureId: selectedId }));
    await click('Revolve');
    expect(container.querySelector('select[aria-label="Profile sketch"]')).toBeNull();
    const selectedName = selectedId === 'empty' ? 'Empty' : selectedId === 'guides' ? 'Guides' : 'Suppressed';
    expect(statusMessage).toHaveBeenLastCalledWith(expect.stringContaining(`Selected sketch "${selectedName}" ${selectedId === 'suppressed' ? 'is suppressed' : 'has no closed material contours'}.`), 'error');
    expect(currentSession.getSnapshot().document).toBe(before.document); expect(currentSession.getSnapshot().version).toBe(before.version);
    expect(currentSession.getSnapshot().workflowOpen).toBe(false);
  });

  it('keeps Through-all source picking restricted to principal material sketches and preserves its pending editor', async () => {
    const original = solidDocument(), material = original.features[0]; if (material.kind !== 'sketch') throw new Error('Expected sketch.');
    const initial = applyCadEdits(original, [
      { kind: 'add-feature', feature: { id: 'tilted', name: 'Tilted plane', kind: 'datum-plane', suppressed: false, definition: { kind: 'world', basePlane: 'XY', origin: [0, 0, 0], rotation: [30, 0, 0] } } },
      { kind: 'add-feature', feature: { ...material, id: 'tilted_profile', name: 'Tilted profile', plane: { kind: 'datum-plane', featureId: 'tilted' } } },
      { kind: 'add-feature', feature: { ...material, id: 'bore', name: 'Bore', profiles: [{ id: 'bore_circle', name: 'Bore circle', construction: false, geometry: { kind: 'circle', x: 20, y: 20, radius: 3 } }] } },
      { kind: 'add-feature', feature: { id: 'pocket', name: 'Through pocket', kind: 'pocket', suppressed: false, sketchId: 'bore', targetId: 'pad', extent: { kind: 'through-all', direction: 'both' } } }
    ]);
    await mount(initial, { build: { ...topologyBuild, meshes: topologyBuild.meshes.map(mesh => ({ ...mesh, featureId: 'pocket' })) }, buildState: 'ready' });
    await click('Through pocket'); await act(async () => { container.querySelector('.cad-tree-row[aria-pressed="true"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    const choices = container.querySelector<HTMLSelectElement>('[aria-label="Profile sketch"]');
    expect([...choices?.options ?? []].map(option => option.value)).toEqual(['sketch', 'bore']);
    await click('Pick profile sketch from model');
    await act(async () => pickViewportFeature?.('tilted_profile'));
    expect(container.querySelector('[aria-label="Cancel source selection"]')).not.toBeNull(); expect(choices?.value).toBe('bore');
    await act(async () => pickViewportFeature?.('bore'));
    expect(container.querySelector('[aria-label="Cancel source selection"]')).toBeNull();
    expect(currentDocument).toBe(initial);
  });

  it('shows accepted geometry while picking a source and cancels the picker without discarding the numeric preview draft', async () => {
    const preview = vi.fn<NonNullable<CadWorkbenchProps['onFeaturePreview']>>();
    await mount(solidDocument(), { build: topologyBuild, buildState: 'ready', onFeaturePreview: preview });
    await act(async () => viewport().apply({ kind: 'select-feature', featureId: 'pad' })); await act(async () => { container.querySelector('.cad-tree-row[aria-pressed="true"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    await input(field('Length'), '20');
    const command = preview.mock.calls.map(([command]) => command).filter(command => command.kind === 'candidate').at(-1);
    if (!command || command.kind !== 'candidate') throw new Error('Expected preview candidate.');
    const candidate = applyCadEdits(currentDocument, command.edits);
    await act(async () => replaceFeaturePreview({ kind: 'ready', owner: command.owner, baseVersion: command.expectedVersion, featureId: 'pad', candidateId: 'candidate', definitionKey: cadFeatureCandidateKey(command.edits), document: candidate,
      result: { ...topologyBuild, buildId: 'candidate-build', meshes: topologyBuild.meshes.map(mesh => ({ ...mesh, volume: 40_000 })) } }));
    expect(container.querySelector('[aria-label="3D model viewport"]')?.getAttribute('data-displayed-volumes')).toBe('40000');
    expect(container.querySelector('[aria-label="3D model viewport"]')?.getAttribute('data-source-reference-pick-ids')).toBe('');
    await click('Pick profile sketch from model');
    expect(container.querySelector('[aria-label="3D model viewport"]')?.getAttribute('data-displayed-volumes')).toBe('20000');
    expect(container.querySelector('[aria-label="3D model viewport"]')?.getAttribute('data-source-reference-pick-ids')).toBe('sketch');
    expect(requestViewportMenu).toBeUndefined();
    expect(preview.mock.calls.at(-1)?.[0]).toEqual({ kind: 'clear', owner: command.owner });
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(container.querySelector('[aria-label="3D model viewport"]')?.getAttribute('data-source-reference-pick-ids')).toBe('');
    expect(field('Length').value).toBe('20');
    expect(preview.mock.calls.at(-1)?.[0]).toMatchObject({ kind: 'candidate', edits: [{ kind: 'update-feature', feature: { distance: 20 } }] });
    expect(currentDocument.features.find(feature => feature.id === 'pad')).toMatchObject({ distance: 10 });
    await click('Cancel');
    expect(container.querySelector('[aria-label="3D model viewport"]')?.getAttribute('data-displayed-volumes')).toBe('20000');
  });

  it('picks only an eligible preceding source into the draft, keeps other fields on Escape and commits one history step', async () => {
    const initial = applyCadEdits(solidDocument(), [
      { kind: 'add-feature', feature: { id: 'pad-b', name: 'Pad B', kind: 'extrude', suppressed: false, sketchId: 'sketch', distance: 5, symmetric: false, operation: 'new', targetId: null } },
      { kind: 'add-feature', feature: { id: 'move', name: 'Move', kind: 'transform', suppressed: false, sourceId: 'pad', translation: [1, 0, 0], rotation: [0, 0, 0] } },
      { kind: 'add-feature', feature: { id: 'later', name: 'Later pad', kind: 'extrude', suppressed: false, sketchId: 'sketch', distance: 2, symmetric: false, operation: 'new', targetId: null } },
    ]);
    await mount(initial, { buildState: 'ready', build: { ...topologyBuild, meshes: ['move', 'pad-b', 'later'].map(featureId => ({ ...topologyBuild.meshes[0], featureId })) } });
    await act(async () => viewport().apply({ kind: 'select-feature', featureId: 'move' })); await act(async () => { container.querySelector('.cad-tree-row[aria-pressed="true"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    await input(field('X'), '9');
    await act(async () => button('Pick body from model').focus());
    await click('Pick body from model');
    expect(currentSession.getSnapshot().workflowOpen).toBe(true);
    expect(currentDocument).toBe(initial);
    await act(async () => pickViewportFeature?.('later'));
    expect(container.querySelector('[aria-label="Cancel source selection"]')).not.toBeNull();
    expect((container.querySelector('[aria-label="Body"]') as HTMLSelectElement).value).toBe('pad');
    await act(async () => document.querySelector('[aria-label="Cancel source selection"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(field('X').value).toBe('9');
    expect(container.querySelector('[aria-label="Cancel source selection"]')).toBeNull();
    expect(document.activeElement).toBe(button('Pick body from model'));
    await click('Pick body from model');
    await click('Select Pad B in history');
    expect((container.querySelector('[aria-label="Body"]') as HTMLSelectElement).value).toBe('pad-b');
    expect(viewport().getState().selectedFeatureId).toBe('move');
    expect(currentDocument).toBe(initial);
    await click('Apply');
    expect(currentDocument.features.find(feature => feature.id === 'move')).toMatchObject({ sourceId: 'pad-b', translation: [9, 0, 0] });
    await act(async () => currentSession.undo());
    expect(currentDocument).toEqual(initial);
  });

  it('adds a compatible Loft section by guarded model picking while retaining the ordered draft and one undo step', async () => {
    const original = solidDocument(), sketch = original.features[0];
    if (sketch.kind !== 'sketch') throw new Error('Expected sketch fixture.');
    const initial = applyCadEdits(original, [
      { kind: 'add-feature', feature: { ...sketch, id: 'sketch-b', name: 'Outline B', offset: 10 } },
      { kind: 'add-feature', feature: { ...sketch, id: 'sketch-c', name: 'Outline C', offset: 20 } },
    ]);
    await mount(initial);
    await click('Loft');
    const sections = [...container.querySelectorAll<HTMLSelectElement>('.cad-loft-section-list select')].map(select => select.value);
    const nextId = ['sketch', 'sketch-b', 'sketch-c'].find(id => !sections.includes(id));
    if (!nextId) throw new Error('Expected an unused section.');
    await click('Pick new section from model');
    await act(async () => pickViewportFeature?.(sections[0]));
    expect(container.querySelector('[aria-label="Cancel source selection"]')).not.toBeNull();
    await act(async () => pickViewportFeature?.(nextId));
    expect([...container.querySelectorAll<HTMLSelectElement>('.cad-loft-section-list select')].map(select => select.value)).toEqual([...sections, nextId]);
    expect(currentDocument).toBe(initial);
    await click('Apply');
    expect(currentDocument.features.at(-1)).toMatchObject({ kind: 'loft', sketchIds: [...sections, nextId] });
    await act(async () => currentSession.undo());
    expect(currentDocument).toEqual(initial);
  });

  it('starts a viewport context command from the pointed body instead of the previously selected body', async () => {
    const initial = applyCadEdits(solidDocument(), [{ kind: 'add-feature', feature: { id: 'pad-b', name: 'Pad B', kind: 'extrude', suppressed: false, sketchId: 'sketch', distance: 5, symmetric: false, operation: 'new', targetId: null } }]);
    await mount(initial, { buildState: 'ready', build: { ...topologyBuild, meshes: [...topologyBuild.meshes, { ...topologyBuild.meshes[0], featureId: 'pad-b', name: 'Pad B', volume: 10_000 }] } });
    await act(async () => viewport().apply({ kind: 'select-feature', featureId: 'pad' }));
    const accepted = currentSession.getSnapshot();
    await act(async () => requestViewportMenu?.({ clientX: 100, clientY: 100, trigger: 'pointer', target: { kind: 'feature', featureId: 'pad-b' } }));
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(() => viewport().apply({ kind: 'select-feature', featureId: 'pad' })).toThrow('Apply or cancel');
    await click('Move / rotate');
    expect([...container.querySelectorAll('select')].find(select => [...select.options].some(option => option.value === 'pad-b'))?.value).toBe('pad-b');
    expect(currentSession.getSnapshot().document).toBe(accepted.document);
    await click('Apply');
    expect(currentDocument.features.at(-1)).toMatchObject({ kind: 'transform', sourceId: 'pad-b' });
    await act(async () => currentSession.undo());
    expect(currentDocument).toEqual(initial);
  });

  it('runs solid menu chains once the menu closes, keeps adjacency and native tangent chains for the shown build only and drops a chain a later pick overtook', async () => {
    const initial = applyCadEdits(solidDocument(), [{ kind: 'add-feature', feature: { id: 'pad-b', name: 'Pad B', kind: 'extrude', suppressed: false, sketchId: 'sketch', distance: 5, symmetric: false, operation: 'new', targetId: null } }]);
    const build: CadBuildResult = { ...topologyBuild, meshes: [...topologyBuild.meshes, { ...topologyBuild.meshes[0], featureId: 'pad-b', name: 'Pad B', volume: 10_000,
      faceGroups: [{ start: 0, count: 3, key: 'face-b' }], edgeGroups: [{ start: 0, count: 2, key: 'edge-b' }] }] };
    // Each body is one edge bounding one face, so its loop and its tangent chain are that edge.
    const adjacencyOf = (bodyId: string, edge: string, face: string, buildId = build.buildId): CadTopologyAdjacency => ({ bodyId, buildId, edges: [edge],
      edgeFaces: [0, -1], edgeSmooth: [false], faces: [face], faceLoops: [[[0]]] });
    const chainOf = (bodyId: string, edgeKey: string, native: boolean, buildId = build.buildId): CadTopologyTangentChain => ({ bodyId, buildId, edgeKey, edges: [edgeKey], closed: false, native });
    const reads: ((value: CadTopologyAdjacency) => void)[] = [], failures: ((cause: Error) => void)[] = [], chains: ((value: CadTopologyTangentChain) => void)[] = [];
    const read = vi.fn((_request: CadTopologyAdjacencyRequest) => new Promise<CadTopologyAdjacency>((resolve, reject) => { reads.push(resolve); failures.push(reject); }));
    const readChain = vi.fn((_request: CadTopologyTangentChainRequest) => new Promise<CadTopologyTangentChain>(resolve => { chains.push(resolve); }));
    await mount(initial, { build, buildState: 'ready', onInspectTopology: inspectTopology, onTopologyAdjacency: read, onTopologyTangentChain: readChain });
    const menu = async (bodyId: string, key: string, label: string) => {
      await act(async () => requestViewportMenu?.({ clientX: 100, clientY: 100, trigger: 'pointer', target: { kind: 'topology', hit: { bodyId, pick: { kind: 'edge', key } } } }));
      const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(row => row.textContent === label);
      if (!item) throw new Error(`${label} missing.`); await act(async () => item.click());
    };
    const picks = () => { const selection = viewport().getState().topologySelection; return selection ? `${selection.bodyId}: ${selection.picks.map(pick => pick.key).join(' ')}` : null; };
    // The command acts although the open menu held the workbench when it was drawn. While its read is pending a face is picked, and the
    // late chain leaves that pick alone.
    await menu('pad', 'edge-1', 'Select loop');
    expect(read).toHaveBeenCalledExactlyOnceWith({ bodyId: 'pad', expectedBuildId: 'build-1' }, expect.any(String), expect.any(AbortSignal));
    await selectTopology('face');
    await act(async () => reads[0](adjacencyOf('pad', 'edge-1', 'face-1')));
    expect(picks()).toBe('pad: face-1');
    // An edge's tangent chain is read from the native builder, never from adjacency, once per edge for the build. Where the builder makes
    // no contour, the status line says only the edge is selected.
    await menu('pad', 'edge-1', 'Select tangent chain');
    expect(readChain).toHaveBeenCalledExactlyOnceWith({ bodyId: 'pad', expectedBuildId: 'build-1', edgeKey: 'edge-1' }, expect.any(String), expect.any(AbortSignal));
    await act(async () => chains[0](chainOf('pad', 'edge-1', false)));
    expect(picks()).toBe('pad: edge-1'); expect(statusMessage).toHaveBeenCalledWith(CAD_TOPOLOGY_LONE_EDGE_NOTE, 'info');
    await selectTopology('face'); await menu('pad', 'edge-1', 'Select tangent chain');
    expect(picks()).toBe('pad: edge-1'); expect(readChain).toHaveBeenCalledOnce();
    // Adjacency is kept for the build, body by body: back on the first body after the second, nothing is read again.
    await menu('pad-b', 'edge-b', 'Select loop');
    await act(async () => reads[1](adjacencyOf('pad-b', 'edge-b', 'face-b')));
    expect(picks()).toBe('pad-b: edge-b');
    await menu('pad', 'edge-1', 'Select loop');
    expect(picks()).toBe('pad: edge-1'); expect(read).toHaveBeenCalledTimes(2);
    // A new build reads again, and a second chain started before the first answers is the one that applies.
    await act(async () => replaceBuild({ ...build, buildId: 'build-2' }));
    await menu('pad-b', 'edge-b', 'Select loop'); await menu('pad', 'edge-1', 'Select loop');
    expect(read).toHaveBeenCalledTimes(4);
    await act(async () => { reads[3](adjacencyOf('pad', 'edge-1', 'face-1', 'build-2')); reads[2](adjacencyOf('pad-b', 'edge-b', 'face-b', 'build-2')); });
    expect(picks()).toBe('pad: edge-1');
    // A read that fails after a later chain says nothing; one that fails while its chain is the latest request says so.
    const failed = () => statusMessage.mock.calls.filter(([message, tone]) => tone === 'error' && String(message).includes('The adjacency read failed.')).length;
    await act(async () => replaceBuild({ ...build, buildId: 'build-3' }));
    await menu('pad', 'edge-1', 'Select loop'); await menu('pad-b', 'edge-b', 'Select loop');
    await act(async () => failures[4](new Error('The adjacency read failed.')));
    expect(failed()).toBe(0);
    await act(async () => failures[5](new Error('The adjacency read failed.')));
    expect(failed()).toBe(1);
    // A failed read is not kept: the next chain on that body reads again, and its answer applies.
    await menu('pad-b', 'edge-b', 'Select loop'); expect(read).toHaveBeenCalledTimes(7);
    await act(async () => reads[6](adjacencyOf('pad-b', 'edge-b', 'face-b', 'build-3')));
    expect(picks()).toBe('pad-b: edge-b'); expect(failed()).toBe(1);
    // The reads go as soon as the shown build changes, not at the next chain: shown again after another build, a build reads afresh.
    await act(async () => replaceBuild({ ...build, buildId: 'build-4' }));
    await menu('pad', 'edge-1', 'Select loop'); await act(async () => reads[7](adjacencyOf('pad', 'edge-1', 'face-1', 'build-4')));
    await menu('pad', 'edge-1', 'Select tangent chain'); await act(async () => chains[1](chainOf('pad', 'edge-1', true, 'build-4')));
    expect(read).toHaveBeenCalledTimes(8); expect(readChain).toHaveBeenCalledTimes(2);
    await act(async () => replaceBuild({ ...build, buildId: 'build-5' }));
    await act(async () => replaceBuild({ ...build, buildId: 'build-4' }));
    await menu('pad', 'edge-1', 'Select loop'); await menu('pad', 'edge-1', 'Select tangent chain');
    expect(read).toHaveBeenCalledTimes(9); expect(readChain).toHaveBeenCalledTimes(3);
    // A chain the selection refuses is not kept, nor is its contour: Pad B's names an edge its mesh lacks, so the next chain on that edge
    // reads again.
    const refused = () => statusMessage.mock.calls.filter(([message, tone]) => tone === 'error' && String(message).includes('does not belong')).length;
    const share = vi.spyOn(CadTangentContours.prototype, 'share');
    try {
      await menu('pad-b', 'edge-b', 'Select tangent chain');
      await act(async () => chains[3]({ ...chainOf('pad-b', 'edge-b', true, 'build-4'), edges: ['edge-b', 'edge-gone'] }));
      expect(refused()).toBe(1); expect(share).toHaveBeenCalledOnce(); expect((share.mock.contexts[0] as CadTangentContours).size).toBe(0);
    } finally { share.mockRestore(); }
    await menu('pad-b', 'edge-b', 'Select tangent chain'); expect(readChain).toHaveBeenCalledTimes(5);
  });
  it('offers Select other over planes, with or without a body under the pointer', async () => {
    await mount(solidDocument(), { build: topologyBuild, buildState: 'ready' });
    const selectOther = vi.fn(), labels = () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].map(row => row.textContent);
    // Only planes under the pointer: no target, and Select other is the command.
    await act(async () => requestViewportMenu?.({ clientX: 100, clientY: 100, trigger: 'pointer', target: null, selectOther }));
    expect(labels()).toEqual(['Select other']);
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')][0].click());
    expect(selectOther).toHaveBeenCalledOnce(); expect(document.querySelector('[role="menu"]')).toBeNull();
    // A sketch outline over a plane is a feature but not a body; its menu offers Select other as well.
    await act(async () => requestViewportMenu?.({ clientX: 100, clientY: 100, trigger: 'pointer', target: { kind: 'feature', featureId: 'sketch' }, selectOther }));
    expect(labels()).toContain('Select other');
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    // Nothing under the pointer and nothing to step through opens no menu.
    await act(async () => requestViewportMenu?.({ clientX: 100, clientY: 100, trigger: 'pointer', target: null }));
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
  it('converts the pointed topology hit and dismisses context actions when the accepted build changes', async () => {
    const resolve = vi.fn(resolveTopology);
    const initial = solidDocument();
    await mount(initial, { build: topologyBuild, buildState: 'ready', onResolveSelection: resolve, onInspectTopology: inspectTopology });
    await selectTopology('edge');
    await act(async () => requestViewportMenu?.({ clientX: 100, clientY: 100, trigger: 'pointer', target: { kind: 'topology', hit: { bodyId: 'pad', pick: { kind: 'face', key: 'face-1' } } } }));
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await click('Shell from face');
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'shell', picks: [{ kind: 'face', key: 'face-1' }] }), expect.any(String), expect.any(AbortSignal));
    await click('Cancel');
    await act(async () => requestViewportMenu?.({ clientX: 100, clientY: 100, trigger: 'pointer', target: { kind: 'feature', featureId: 'pad' } }));
    await act(async () => replaceBuild({ ...topologyBuild, buildId: 'replacement-build' }));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(currentDocument).toEqual(initial);
  });

  it('uses a sketch profile context target without deleting the previously selected profile', async () => {
    const original = solidDocument();
    const sketch = original.features[0];
    if (sketch.kind !== 'sketch') throw new Error('Expected sketch fixture.');
    const initial = applyCadEdits(original, [{ kind: 'update-feature', feature: { ...sketch, profiles: [
      { id: 'rectangle', name: 'Plate', construction: false, role: 'outer', geometry: { kind: 'rectangle', x: 0, y: 0, width: 50, height: 40, cornerRadius: 0 } },
      { id: 'circle', name: 'Hole', construction: false, role: 'hole', geometry: { kind: 'circle', x: 10, y: 10, radius: 2 } },
    ] } }]);
    await mount(initial);
    await act(async () => { viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }); viewport().apply({ kind: 'select-profile', profileId: 'circle' }); });
    const canvas = container.querySelector<SVGSVGElement>('[aria-label="Sketch drawing canvas"]')!;
    await act(async () => canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true })));
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await click('Toggle construction');
    expect(currentDocument.features[0]).toMatchObject({ profiles: [{ id: 'rectangle', construction: false }, { id: 'circle', construction: true }] });
    await act(async () => currentSession.undo());
    expect(currentDocument).toEqual(initial);
  });

  it('renders an existing feature candidate while preserving accepted geometry and restores the original model on Cancel', async () => {
    const preview = vi.fn<NonNullable<CadWorkbenchProps['onFeaturePreview']>>();
    await mount(solidDocument(), { build: topologyBuild, buildState: 'ready', onFeaturePreview: preview });
    await click('Pad 1'); const before = currentSession.getSnapshot(); await act(async () => { container.querySelector('.cad-tree-row[aria-pressed="true"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    await input(field('Length'), '20');
    const command = preview.mock.calls.map(([entry]) => entry).filter(entry => entry.kind === 'candidate').at(-1);
    if (!command || command.kind !== 'candidate') throw new Error('Missing provisional feature command');
    const candidate = applyCadEdits(before.document, command.edits);
    const result: CadBuildResult = { ...topologyBuild, buildId: 'candidate-build', meshes: topologyBuild.meshes.map(mesh => ({ ...mesh, volume: 40_000, bounds: { min: [0, 0, 0], max: [50, 40, 20] } })) };
    const ready: Extract<CadFeaturePreviewState, { kind: 'ready' }> = { kind: 'ready', owner: command.owner, featureId: 'pad', baseVersion: before.version, candidateId: 'candidate_1', definitionKey: cadFeatureCandidateKey(command.edits), document: candidate, result };
    await act(async () => replaceFeaturePreview(ready));
    expect(container.querySelector('[aria-label="3D model viewport"]')?.getAttribute('data-displayed-volumes')).toBe('40000');
    expect(container.querySelector('[aria-label="3D model viewport"]')?.getAttribute('data-navigation-locked')).toBe('false');
    expect(currentSession.getSnapshot()).toMatchObject({ version: before.version, document: before.document, canUndo: false, workflowOpen: true });
    await input(field('Length'), '21');
    const nextCommand = preview.mock.calls.at(-1)?.[0]; if (!nextCommand || nextCommand.kind !== 'candidate') throw new Error('Missing latest candidate');
    const pendingKind = 'waiting' as const, pendingPreview = { kind: pendingKind, owner: command.owner, featureId: 'pad', baseVersion: before.version, candidateId: 'candidate_2', definitionKey: cadFeatureCandidateKey(nextCommand.edits), lastValid: ready };
    await act(async () => replaceFeaturePreview(pendingPreview));
    expect(container.querySelector('[aria-label="3D model viewport"]')?.getAttribute('data-displayed-volumes')).toBe('40000');
    expect(button('Apply').disabled).toBe(true); expect(currentSession.getSnapshot().document).toBe(before.document);
    await click('Cancel');
    expect(container.querySelector('[aria-label="3D model viewport"]')?.getAttribute('data-displayed-volumes')).toBe('20000');
    expect(currentSession.getSnapshot()).toEqual(before);
    // Cancel closes the editor and keeps the feature selected; reopening starts from the accepted value.
    expect(container.querySelector('[aria-label="Close feature editor"]')).toBeNull(); await act(async () => { container.querySelector('.cad-tree-row[aria-pressed="true"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    await input(field('Length'), '20');
    const retry = preview.mock.calls.map(([entry]) => entry).filter(entry => entry.kind === 'candidate').at(-1);
    if (!retry || retry.kind !== 'candidate') throw new Error('Missing retried preview');
    await act(async () => replaceFeaturePreview({ ...ready, owner: retry.owner, candidateId: 'retry', definitionKey: cadFeatureCandidateKey(retry.edits), document: applyCadEdits(before.document, retry.edits) }));
    await click('Apply');
    expect(currentSession.getSnapshot()).toMatchObject({ canUndo: true, workflowOpen: false, document: { features: [expect.anything(), { distance: 20 }] } });
    await act(async () => currentSession.undo()); expect(currentSession.getSnapshot().document).toEqual(before.document);
  });
  it('updates device dimension visibility and viewport identity without editing geometry or history', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
    setCadPreferences({ navigationMode: 'mouse', showOnPartDimensions: true });
    await mount({ ...createCadDocument(), features: [{ id: 'outline', name: 'Outline', kind: 'sketch', suppressed: false, plane: 'XY', offset: 0,
      profiles: [{ id: 'circle', name: 'Circle', construction: false, constraints: [{ id: 'diameter', kind: 'dimension', quantity: 'diameter' }], geometry: { kind: 'circle', x: 0, y: 0, radius: 5 } }] }] });
    await click('Outline'); await click('Circle profile');
    const before = currentSession.getSnapshot(); expect(container.querySelector('.cad-sketch-dimension-controls')).not.toBeNull();
    await act(async () => setCadPreferences({ navigationMode: 'trackpad', showOnPartDimensions: false }));
    expect(container.querySelector('.cad-sketch-dimension-controls')).toBeNull();
    expect(viewport().getState().view).toMatchObject({ navigationMode: 'trackpad', onPartDimensionsVisible: false });
    expect(currentSession.getSnapshot()).toBe(before);
    await act(async () => setCadPreferences({ ...getCadPreferences(), showOnPartDimensions: true }));
    expect(container.querySelector('.cad-sketch-dimension-controls')).not.toBeNull();
    expect(viewport().getState().view).toMatchObject({ onPartDimensionsVisible: true });
    expect(currentSession.getSnapshot()).toBe(before);
    await act(async () => setCadPreferences({ navigationMode: 'mouse', showOnPartDimensions: true }));
  });
  it('owns the workflow while a history context menu is open and suppresses its actual feature as one undoable edit', async () => {
    await mount({ ...createCadDocument(), features: [{ id: 'outline', name: 'Outline', kind: 'sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [] }] });
    const before = currentSession.getSnapshot(), target = button('Select Outline in history');
    await act(async () => target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 })));
    expect(currentSession.getSnapshot()).toMatchObject({ document: before.document, version: before.version, workflowOpen: true });
    await click('Suppress feature');
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(currentSession.getSnapshot()).toMatchObject({ workflowOpen: false, canUndo: true, document: { features: [{ id: 'outline', suppressed: true }] } });
    await act(async () => currentSession.undo()); expect(currentSession.getSnapshot().document).toEqual(before.document);
  });
  it('discards an edited part name on focused Escape without changing document, version or undo/redo history', async () => {
    await mount(solidDocument());
    await act(async () => {
      currentSession.edit([{ kind: 'rename-document', name: 'Reviewed part' }]);
      currentSession.edit([{ kind: 'set-parameter', name: 'width', value: 50 }]); currentSession.undo();
    });
    const before = currentSession.getSnapshot(); expect(before.canUndo).toBe(true); expect(before.canRedo).toBe(true);
    const name = await partName();
    await act(async () => name.focus()); await input(name, 'Discard this rename'); expect(currentSession.getSnapshot().workflowOpen).toBe(true);
    await act(async () => name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(name.value).toBe('Reviewed part'); expect(document.activeElement).toBe(name);
    expect(currentSession.getSnapshot()).toEqual(before); expect(currentDocument).toBe(before.document);
    await act(async () => name.blur());
    expect(currentSession.getSnapshot()).toEqual(before); expect(currentSession.getSnapshot().workflowOpen).toBe(false);
  });
  it('keeps the part-name field editable while drafting and restores a rejected draft when Properties closes', async () => {
    await mount(solidDocument()); const before = currentSession.getSnapshot();
    const name = await partName();
    await act(async () => name.focus()); await input(name, '   ');
    expect(name.matches(':disabled')).toBe(false); expect(document.activeElement).toBe(name);
    await act(async () => name.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(currentDocument).toBe(before.document); expect(name.matches(':disabled')).toBe(false);
    await click('Close properties');
    expect(container.querySelector('[aria-label="Part name"]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('.cad-tree-document')?.disabled).toBe(false);
    expect(currentSession.getSnapshot()).toMatchObject({ document: before.document, version: before.version, workflowOpen: false });
    expect((await partName()).value).toBe(before.document.name);
  });
  it('leaves composing Enter and Escape to the part-name input method', async () => {
    await mount(solidDocument()); const before = currentSession.getSnapshot();
    const name = await partName();
    await act(async () => name.focus()); await input(name, '部品');
    for (const key of ['Enter', 'Escape']) {
      const composing = new KeyboardEvent('keydown', { key, isComposing: true, bubbles: true, cancelable: true });
      await act(async () => name.dispatchEvent(composing));
      expect(composing.defaultPrevented).toBe(false); expect(name.value).toBe('部品'); expect(document.activeElement).toBe(name);
      expect(currentSession.getSnapshot()).toMatchObject({ document: before.document, version: before.version, workflowOpen: true });
    }
    await act(async () => name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(currentSession.getSnapshot()).toEqual(before);
  });
  it('keeps the specification tree over the canvas and preserves the view through inspector selection and collapse', async () => {
    await mount(solidDocument()); const before = currentSession.getSnapshot(); const controls = viewport();
    const area = container.querySelector('.cad-center'); const canvas = container.querySelector('[aria-label="3D model viewport"]');
    expect(area?.contains(container.querySelector('[data-cad-model-tree]'))).toBe(true);
    await click('Collapse Body'); await click('Expand Body');
    await act(async () => controls.apply({ kind: 'select-feature', featureId: 'pad' })); await act(async () => { container.querySelector('.cad-tree-row[aria-pressed="true"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    await click('Minimize configuration'); await click('Expand configuration');
    expect(field('Length').value).toBe('10'); expect(container.querySelector('[aria-label="3D model viewport"]')).toBe(canvas);
    expect(viewport()).toBe(controls); expect(currentSession.getSnapshot()).toBe(before);
  });

  it('switches sketch tools from single-letter shortcuts through the visible guarded tools', async () => {
    const original = solidDocument(); await mount({ ...original, features: [original.features[0]] });
    await act(async () => { viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }); });
    const press = (key: string, init: KeyboardEventInit = {}) => act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })); });
    await press('c'); expect(button('Circle').getAttribute('aria-pressed')).toBe('true');
    await press('R'); expect(button('Rectangle').getAttribute('aria-pressed')).toBe('true');
    expect(button('Rectangle').getAttribute('aria-keyshortcuts')).toBe('R');
    await press('c', { ctrlKey: true }); expect(button('Rectangle').getAttribute('aria-pressed')).toBe('true');
    await press('m'); expect(button('Mirror copy').disabled).toBe(true); expect(button('Rectangle').getAttribute('aria-pressed')).toBe('true');
    await press('t'); expect(button('Trim').disabled).toBe(true); expect(button('Rectangle').getAttribute('aria-pressed')).toBe('true');
    await press('s'); expect(button('Select').getAttribute('aria-pressed')).toBe('true');
    for (const [key, label] of [['a', 'Arc'], ['o', 'Slot']] as const) {
      await press(key); expect(button(label).getAttribute('aria-pressed')).toBe('true');
      expect(button(label).getAttribute('aria-keyshortcuts')).toBe(key.toUpperCase());
    }
    // P, Polyline's shortcut, selects the chaining Line, as L does.
    for (const key of ['l', 'p']) { await press('s'); await press(key); expect(toolButton('Line').getAttribute('aria-pressed')).toBe('true'); }
    expect(toolButton('Line').getAttribute('aria-keyshortcuts')).toBe('L P');
    const drawingTools = [...container.querySelectorAll('.cad-command-primary-tools button')].map(entry => entry.getAttribute('aria-label'));
    expect(drawingTools.slice(drawingTools.indexOf('Select'), drawingTools.indexOf('Select') + 7)).toEqual(['Select', 'Line', 'Arc', 'Rectangle', 'Circle', 'Slot', 'Trim']);
    expect(drawingTools).not.toContain('Path'); expect(drawingTools).not.toContain('Polyline');
  });

  it('enters Trim from T on a connected sketch and Escape returns to Select without editing', async () => {
    const source = parseCadDocument({ ...createCadDocument(), schemaVersion: 2, features: [{ id: 'sketch', kind: 'sketch', name: 'Lines',
      suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: { points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [10, 0] }],
        entities: [{ id: 'ab', kind: 'line', startPointId: 'a', endPointId: 'b', construction: false }], relations: [] } }] });
    await mount(source); await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }));
    const press = (key: string) => act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
    expect(button('Trim').getAttribute('aria-keyshortcuts')).toBe('T');
    await press('t'); expect(button('Trim').getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('.cad-sketch-canvas')?.classList.contains('is-trimming')).toBe(true);
    await press('Escape'); expect(button('Select').getAttribute('aria-pressed')).toBe('true'); expect(currentDocument).toBe(source);
  });

  it('selects history rows on click, opens the editor on double-click and closes it with Escape after discarding a draft', async () => {
    await mount(solidDocument()); const before = currentSession.getSnapshot();
    const row = button('Select Pad 1 in history'), escape = () => act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    await click('Select Pad 1 in history');
    expect(row.getAttribute('aria-pressed')).toBe('true'); expect([...container.querySelectorAll('label')].some(label => label.querySelector('span')?.childNodes[0]?.textContent === 'Length')).toBe(false);
    await act(async () => { row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    await input(field('Length'), '25');
    await escape(); expect(field('Length').value).toBe('10');
    await escape(); expect(container.querySelector('[aria-label="Close feature editor"]')).toBeNull();
    expect(row.getAttribute('aria-pressed')).toBe('true'); expect(currentSession.getSnapshot()).toEqual(before);
    await act(async () => { row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); }); await click('Close feature editor');
    expect(container.querySelector('[aria-label="Close feature editor"]')).toBeNull(); expect(row.getAttribute('aria-pressed')).toBe('true');
  });

  it('retains pending edits and blocks tree branch changes until cancellation', async () => {
    await mount(solidDocument()); await act(async () => viewport().apply({ kind: 'select-feature', featureId: 'pad' })); await act(async () => { container.querySelector('.cad-tree-row[aria-pressed="true"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    const before = currentSession.getSnapshot(); const length = field('Length');
    await act(async () => length.focus()); await input(length, '25');
    expect(button('Collapse Body').disabled).toBe(true); expect(button('Expand Parameters').disabled).toBe(true);
    expect(field('Length')).toBe(length); expect(length.value).toBe('25');
    await click('Cancel'); expect(container.querySelector('.cad-tree-row[aria-pressed="true"]')?.textContent).toContain('Pad 1');
    await act(async () => { container.querySelector('.cad-tree-row[aria-pressed="true"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); }); expect(field('Length').value).toBe('10');
    expect(button('Collapse Body').disabled).toBe(false); expect(currentSession.getSnapshot()).toEqual(before);
  });

  it('reclaims empty property space and restores the editor on selection without changing geometry or history', async () => {
    await mount(solidDocument(), { build: topologyBuild, buildState: 'ready' });
    const before = currentDocument; const version = currentSession.getSnapshot().version; const controls = viewport();
    expect(container.querySelector('[aria-label="Feature properties"]')).toBeNull();
    expect(container.querySelector('.cad-center')?.contains(container.querySelector('[data-cad-model-tree]'))).toBe(true);
    await act(async () => controls.apply({ kind: 'select-feature', featureId: 'pad' })); await act(async () => { container.querySelector('.cad-tree-row[aria-pressed="true"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    expect(container.querySelector('[aria-label="Feature properties"]')).not.toBeNull(); expect(field('Length').value).toBe('10');
    expect(container.querySelector('.cad-center')?.contains(container.querySelector('[data-cad-model-tree]'))).toBe(true);
    await act(async () => controls.apply({ kind: 'select-feature', featureId: null }));
    expect(container.querySelector('[aria-label="Feature properties"]')).toBeNull();
    await click('Sketch'); expect(viewport().getState()).toMatchObject({ awaitingSketchPlane: true, workflowOpen: true });
    expect(button('Save').disabled).toBe(true);
    await click('Cancel plane selection'); expect(viewport().getState()).toMatchObject({ awaitingSketchPlane: false, workflowOpen: false });
    expect(viewport()).toBe(controls); expect(currentDocument).toBe(before); expect(currentSession.getSnapshot().version).toBe(version);
  });
  it('keeps a restored inspector mounted while a pending profile edit prevents selection changes', async () => {
    await mount(solidDocument());
    await act(async () => { viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }); viewport().apply({ kind: 'select-profile', profileId: 'rectangle' }); });
    await click('Add dimension'); await input(dimensionValue(), '60');
    expect(() => viewport().apply({ kind: 'select-feature', featureId: null })).toThrow('Apply or cancel');
    expect(container.querySelector('[aria-label="Feature properties"]')).not.toBeNull(); expect(dimensionValue().value).toBe('60');
    await click('Cancel'); await click('Add dimension'); expect(dimensionValue().value).toBe('50'); await click('Cancel');
  });
  it('navigates File commands by keyboard and restores toolbar focus without changing the draft', async () => {
    await mount();
    const before = currentSession.getSnapshot(), trigger = button('File');
    await act(async () => trigger.focus());
    await click('File');
    expect(document.activeElement).toBe(button('New part'));
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(button('Open saved part'));
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(document.querySelector('[role="menu"][aria-label="CAD document commands"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await click('File');
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
    expect(document.querySelector('[role="menu"][aria-label="CAD document commands"]')).toBeNull();
    expect(document.activeElement).toBe(button('Undo'));
    expect(currentSession.getSnapshot()).toBe(before);
  });
  it('offers model rebuild recovery from File without editing the draft', async () => {
    const rebuild = vi.fn(async () => undefined);
    await mount(solidDocument(), { build: null, buildState: 'error', onRebuild: rebuild });
    const before = currentDocument; const version = currentSession.getSnapshot().version;
    await click('File'); expect(button('Rebuild model').disabled).toBe(false);
    await click('Rebuild model');
    expect(rebuild).toHaveBeenCalledTimes(1); expect(currentDocument).toBe(before); expect(currentSession.getSnapshot().version).toBe(version);
  });
  it('normalizes reverse rectangle drawing and refuses degenerate geometry', () => {
    expect(twoPointSketchProfile('rectangle', [40, 30], [0, -10])).toEqual({ kind: 'rectangle', x: 0, y: -10, width: 40, height: 40, cornerRadius: 0 });
    expect(() => twoPointSketchProfile('rectangle', [0, 0], [0, 30])).toThrow('nonzero');
    expect(twoPointSketchProfile('circle', [5, 5], [8, 9])).toEqual({ kind: 'circle', x: 5, y: 5, radius: 5 });
  });

  it('measures a slot width across its center axis and keeps legacy slots centered between both arc centers', () => {
    expect(slotSketchWidth([0, 0], [20, 0], [5, 3])).toBe(6); expect(slotSketchWidth([0, 0], [20, 0], [-40, -3])).toBe(6);
    expect(slotSketchWidth([0, 0], [0, 20], [4, 50])).toBe(8);
    expect(slotSketchProfile([0, 0], [0, 20], 10)).toEqual({ kind: 'slot', x: 0, y: 10, length: 30, width: 10, angle: 90 });
    expect(() => slotSketchWidth([3, 4], [3, 4], [10, 10])).toThrow('different point');
    expect(() => slotSketchProfile([0, 0], [20, 0], 0)).toThrow('Move away');
    expect(() => slotSketchProfile([0, 0], [20, 0], Number.NaN)).toThrow('Move away');
  });

  it('snaps both signs and preserves precision when snapping is disabled', () => {
    expect(snapSketchPoint([-12, 18], 5, true)).toEqual([-10, 20]);
    expect(snapSketchPoint([1.125, -2.375], 5, false)).toEqual([1.125, -2.375]);
    expect(() => snapSketchPoint([1, 1], 0, true)).toThrow('positive');
  });

  it('keeps the open sketch plane offset editable while nothing in it is selected', async () => {
    await mount(); await startSketch();
    await input(field('Plane offset'), '3'); await click('Apply');
    expect(currentDocument.features[0]).toMatchObject({ kind: 'sketch', plane: 'XY', offset: 3 });
  });

  it('hides the sketch plane fields while geometry in the open sketch is selected', async () => {
    const source = parseCadDocument({ ...createCadDocument('Plane fields'), schemaVersion: 2, features: [{
      id: 'sketch', kind: 'sketch', name: 'Plane fields', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
        points: [{ id: 'center', position: [0, 0] }], entities: [{ id: 'circle', kind: 'circle', construction: false, centerPointId: 'center', radius: 3 }], relations: []
      }
    }] });
    await mount(source); await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }));
    expect(field('Plane offset')).toBeTruthy();
    const center = container.querySelector('[data-cad-sketch-point="center"]'); if (!center) throw new Error('Center missing.');
    await act(async () => center.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(viewport().getState().selectedSketchGeometrySet).toEqual([{ kind: 'point', id: 'center' }]);
    expect(() => field('Plane offset')).toThrow('missing');
    // The relations tree starts collapsed and selection leaves it so; the geometry context menu opens it on the selection's relations alone.
    const only = () => container.querySelector('[data-cad-sketch-relation-list] button[aria-label="Only the selection"]')?.getAttribute('aria-pressed');
    const expanded = () => container.querySelector('[data-cad-sketch-relation-list] .cad-sketch-relation-list-toggle')?.getAttribute('aria-expanded');
    expect(expanded()).toBe('false'); expect(only()).toBeUndefined();
    const canvas = container.querySelector<SVGSVGElement>('[aria-label="Sketch drawing canvas"]'); if (!canvas) throw new Error('Canvas missing.');
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, toJSON: () => ({}) });
    await act(async () => { (center as SVGGElement).focus(); center.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })); });
    const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(entry => entry.textContent === 'Constraints and dimensions'); if (!item) throw new Error('Missing Constraints and dimensions.');
    await act(async () => item.click());
    expect(expanded()).toBe('true'); expect(only()).toBe('true');
    await act(async () => viewport().apply({ kind: 'select-sketch-geometry', selection: null }));
    expect(field('Plane offset')).toBeTruthy();
  });

  it('creates a real sketch, commits a drawn rectangle and sends that exact sketch to CAM', async () => {
    await mount();
    await click('Sketch');
    expect(workflow).toHaveBeenLastCalledWith(true);
    expect(button('Save').disabled).toBe(true);
    await act(async () => pickViewportPlane?.('XY')); await snapToGrid();
    expect(currentDocument.features[0]?.kind).toBe('sketch');
    await canvasClick(300, 200);
    expect(workflow).toHaveBeenLastCalledWith(true);
    expect(() => currentSession.assertWorkflowClosed()).toThrow('Finish or cancel');
    await canvasClick(450, 100);
    const sketch = currentDocument.features[0];
    if (sketch.kind !== 'sketch') throw new Error('Expected sketch.');
    expect(sketch.profiles).toEqual([]);
    expect(sketch.graph?.points.map(point => point.position)).toEqual([[0, 0], [50, 0], [50, 40], [0, 40]]);
    expect(sketch.graph?.entities.map(entity => entity.kind)).toEqual(['line', 'line', 'line', 'line']);
    // The corner drawn on the origin stays fixed there, because Create relations starts on.
    expect(sketch.graph?.relations.map(relation => relation.kind)).toEqual(['horizontal', 'vertical', 'horizontal', 'vertical', 'fixed-axis', 'fixed-axis']);
    expect(sketch.graph?.relations.slice(4)).toEqual([{ id: expect.any(String), kind: 'fixed-axis', pointId: sketch.graph?.points[0].id, axis: 'x', value: 0 },
      { id: expect.any(String), kind: 'fixed-axis', pointId: sketch.graph?.points[0].id, axis: 'y', value: 0 }]);
    expect(currentDocument.schemaVersion).toBe(2);
    // Drawing leaves nothing selected, so Dimension or a constraint chosen next starts from its own picks.
    expect(viewport().getState().selectedSketchGeometrySet).toEqual([]);
    expect(workflow).toHaveBeenLastCalledWith(false);
    await rowMenu(sketch.name, 'Properties');
    expect(property('Material area')).toBe('2,000 mm²'); expect(property('Boundary length')).toBe('180 mm');
    await click('File'); await click('Send sketch to CAM');
    expect(sendToCam).toHaveBeenCalledWith(sketch.id);
  });

  it('leaves nothing selected when deferred drawing acceptance publishes its source', async () => {
    let accept: (() => void) | undefined;
    await mount(createCadDocument(), { build: null, buildState: 'idle', onEdit: (edit, signal) => {
      if (edit.kind !== 'append-sketch-entities') { currentSession.edit([edit]); return; }
      return new Promise<void>(resolve => { accept = () => { signal?.throwIfAborted(); currentSession.edit([edit]); resolve(); }; });
    } });
    await startSketch(); await canvasClick(300, 200); await canvasClick(450, 100);
    expect(currentSession.getSnapshot().workflowOpen).toBe(true);
    expect(viewport().getState().selectedSketchGeometrySet).toEqual([]);
    if (!accept) throw new Error('Drawing acceptance missing');
    await act(async () => accept?.());
    const sketch = currentDocument.features[0];
    if (sketch.kind !== 'sketch' || !sketch.graph?.entities.length) throw new Error('Accepted graph missing');
    expect(viewport().getState().selectedSketchGeometrySet).toEqual([]);
    expect(currentSession.getSnapshot().workflowOpen).toBe(false);
    await click('Select');
    expect(viewport().getState().selectedSketchGeometrySet).toEqual([]);
  });

  it('appends a fresh inferred circle atomically after acceptance and aborts a cancelled attachment without clearing redo', async () => {
    const original = parseCadDocument({ ...createCadDocument(), schemaVersion: 2, parameters: { anchorX: 0 }, features: [{
      id: 'sketch', kind: 'sketch', name: 'Anchored sketch', plane: 'XY', offset: 0, suppressed: false, profiles: [],
      graph: { points: [{ id: 'anchor', position: [' anchorX ', ' 0 '] }], entities: [], relations: [] }
    }] });
    const pending: { edit: Extract<CadEdit, { kind: 'append-sketch-entities' }>; signal?: AbortSignal; accept(): void }[] = [];
    await mount(original, { build: null, buildState: 'idle', onEdit: (edit, signal) => {
      if (edit.kind !== 'append-sketch-entities') { currentSession.edit([edit]); return; }
      return new Promise<void>((resolve, reject) => pending.push({ edit, signal, accept: () => {
        if (signal?.aborted) { reject(signal.reason); return; }
        currentSession.edit([edit]); resolve();
      } }));
    } });
    await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' })); await click('Circle');
    const infer = container.querySelector<HTMLInputElement>('input[aria-label="Create relations"]');
    if (!infer) throw new Error('Coincident drawing control missing.');
    expect(infer.checked).toBe(true);
    await canvasClick(300, 200); await canvasClick(450, 200);
    expect(pending).toHaveLength(1); expect(currentDocument).toBe(original);
    expect(currentSession.getSnapshot().workflowOpen).toBe(true);
    expect(viewport().getState().selectedSketchGeometrySet).toEqual([]);
    const payload = pending[0].edit.geometry, center = payload.points[0];
    expect(payload.points).toHaveLength(1); expect(center.id).not.toBe('anchor');
    expect(center.position).toEqual([0, 0]);
    expect(payload.relations).toEqual([{ id: expect.any(String), kind: 'coincident', pointIds: [center.id, 'anchor'] }]);
    await act(async () => pending[0].accept());
    const accepted = currentDocument;
    expect(currentDocument.features[0]).toMatchObject({ graph: { points: [{ id: 'anchor', position: [' anchorX ', ' 0 '] }, center], relations: payload.relations } });
    expect(viewport().getState().selectedSketchGeometrySet).toEqual([]);
    await act(async () => currentSession.undo()); expect(currentDocument).toBe(original);
    await act(async () => currentSession.redo()); expect(currentDocument).toBe(accepted);
    await act(async () => currentSession.undo()); const before = currentSession.getSnapshot();
    await canvasClick(300, 200); await canvasClick(390, 200);
    expect(pending).toHaveLength(2); expect(pending[1].edit.geometry.relations[0]).toMatchObject({ kind: 'coincident', pointIds: [expect.any(String), 'anchor'] });
    await canvasKey('Escape'); expect(pending[1].signal?.aborted).toBe(true);
    await act(async () => pending[1].accept());
    expect(currentSession.getSnapshot()).toMatchObject({ document: before.document, version: before.version, canUndo: before.canUndo, canRedo: true, workflowOpen: false });
    expect(viewport().getState().selectedSketchGeometrySet).toEqual([]);
  });

  it('keeps a multi-click chain provisional until it is finished, and Cancel drawing discards it without changing saved geometry', async () => {
    await mount(); await startSketch(); await click('Line'); const before = currentSession.getSnapshot();
    await canvasClick(300, 200); await canvasClick(450, 200);
    expect(currentSession.getSnapshot().document).toBe(before.document);
    // Finish sketch would save the chain first; Undo waits for it.
    expect(button('Finish sketch').disabled).toBe(false); expect(button('Undo').disabled).toBe(true);
    await click('Cancel drawing');
    const sketch = currentDocument.features[0];
    expect(sketch.kind === 'sketch' && sketch.profiles).toEqual([]); expect(currentSession.getSnapshot()).toMatchObject({ document: before.document, version: before.version });
    expect(button('Finish sketch').disabled).toBe(false); expect(toolButton('Line').getAttribute('aria-pressed')).toBe('true');
    expect(workflow).toHaveBeenLastCalledWith(false);
  });

  it('accepts a drawn line once without the horizontal relation the sketch rejects as repeated, and says so', async () => {
    const appended: Extract<CadEdit, { kind: 'append-sketch-entities' }>['geometry'][] = [];
    await mount(createCadDocument(), { build: null, buildState: 'idle', onEdit: async edit => {
      if (edit.kind !== 'append-sketch-entities') { currentSession.edit([edit]); return; }
      appended.push(edit.geometry);
      const inferred = edit.geometry.relations.find(relation => relation.kind === 'horizontal');
      if (inferred) throw new CadSketchPreparationError({ sketchId: edit.sketchId, sketchName: 'Sketch', graph: edit.geometry, rejection: { kind: 'rejected', reason: 'redundant',
        message: 'Repeated relation.', diagnostics: { status: 'success', degreesOfFreedom: 0, conflictingIds: [], redundantIds: [inferred.id], partiallyRedundantIds: [], issues: [] } } });
      currentSession.edit([edit]);
    } });
    await startSketch(); await click('Line'); const empty = currentSession.getSnapshot(); statusMessage.mockClear();
    // The end lands one pixel off the start's horizontal guide, which levels it. Enter finishes the one-line chain.
    await canvasClick(330, 260); await canvasClick(420, 261); expect(appended).toHaveLength(0); await canvasKey('Enter');
    expect(appended).toHaveLength(2);
    const [first, second] = appended;
    expect(first.relations).toEqual([{ id: expect.any(String), kind: 'horizontal', pointIds: first.points.map(point => point.id) }]);
    expect(second).toEqual({ ...first, relations: [] });
    expect(statusMessage).toHaveBeenCalledExactlyOnceWith('Horizontal not added: it repeats existing relations.', 'info');
    const sketch = currentDocument.features[0];
    expect(sketch.kind === 'sketch' && sketch.graph).toMatchObject({ entities: [{ kind: 'line' }], relations: [] });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => currentSession.undo()); expect(currentSession.getSnapshot().document).toBe(empty.document);
  });

  it('saves a clicked chain with shared joints on Escape, from the canvas or anywhere, and a second Escape returns to Select', async () => {
    await mount(); await startSketch(); await snapToGrid();
    for (const [escape, at] of [[() => canvasKey('Escape'), 175], [windowEscape, 330]] as const) {
      await click('Line'); const before = currentSession.getSnapshot(), known = sketchGraph().entities.length, points = sketchGraph().points.length;
      await canvasClick(330, at); await canvasClick(450, at); await canvasClick(450, at - 60);
      expect(currentSession.getSnapshot().document).toBe(before.document);
      await escape();
      const added = sketchGraph().entities.slice(known);
      if (added.length !== 2 || added[0].kind !== 'line' || added[1].kind !== 'line') throw new Error('Expected two chained lines.');
      expect(added[0].endPointId).toBe(added[1].startPointId); expect(sketchGraph().points).toHaveLength(points + 3);
      expect(toolButton('Line').getAttribute('aria-pressed')).toBe('true'); expect(() => currentSession.assertWorkflowClosed()).not.toThrow();
      // The chain is one edit, so one undo removes it whole.
      const saved = currentSession.getSnapshot().document;
      await act(async () => currentSession.undo()); expect(currentSession.getSnapshot().document).toEqual(before.document);
      await act(async () => currentSession.redo()); expect(currentSession.getSnapshot().document).toEqual(saved);
      await escape(); expect(toolButton('Select').getAttribute('aria-pressed')).toBe('true');
    }
  });

  it('saves a chain drawn in construction mode as construction edges', async () => {
    await mount(); await startSketch(); await snapToGrid(); await click('Line');
    const construction = container.querySelector<HTMLInputElement>('.cad-sketch-options input'); if (!construction) throw new Error('Construction control missing.');
    await act(async () => construction.click()); expect(construction.checked).toBe(true);
    const known = sketchGraph().entities.length;
    await canvasClick(330, 175); await canvasClick(450, 175); await canvasClick(450, 115);
    // The mode is chosen before drawing, so it stays fixed while the chain is pending.
    expect(construction.disabled).toBe(true);
    await canvasKey('Escape');
    expect(sketchGraph().entities.slice(known).map(entity => [entity.kind, entity.construction])).toEqual([['line', true], ['line', true]]);
  });

  it('discards a lone chain start on the first Escape and returns to Select on the next', async () => {
    await mount(); await startSketch(); await click('Line'); const before = currentSession.getSnapshot();
    await canvasClick(330, 175); expect(workflow).toHaveBeenLastCalledWith(true);
    await windowEscape(); expect(currentSession.getSnapshot()).toMatchObject({ document: before.document, version: before.version });
    expect(toolButton('Line').getAttribute('aria-pressed')).toBe('true'); expect(workflow).toHaveBeenLastCalledWith(false);
    await windowEscape(); expect(toolButton('Select').getAttribute('aria-pressed')).toBe('true');
  });

  it.each(['Arc', 'Rectangle', 'Circle', 'Slot'])('discards a pending %s on the first Escape from anywhere and returns to Select on the next', async label => {
    await mount(); await startSketch(); await click(label); const before = currentSession.getSnapshot();
    await canvasClick(330, 175); expect(workflow).toHaveBeenLastCalledWith(true);
    await windowEscape(); expect(currentSession.getSnapshot()).toMatchObject({ document: before.document, version: before.version });
    expect(toolButton(label).getAttribute('aria-pressed')).toBe('true'); expect(workflow).toHaveBeenLastCalledWith(false);
    await windowEscape(); expect(toolButton('Select').getAttribute('aria-pressed')).toBe('true');
  });

  it('builds the same graph whether a chain ends with Enter, Finish or a double-click', async () => {
    await mount(); await startSketch(); await snapToGrid(); await click('Line');
    const canvasDoubleClick = async (x: number, y: number) => { await act(async () => container.querySelector('[aria-label="Sketch drawing canvas"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y, detail: 2 }))); };
    const shapes: unknown[] = [];
    for (const finish of [() => canvasKey('Enter'), () => click('Finish chain'), () => canvasDoubleClick(450, 100)]) {
      const before = currentSession.getSnapshot();
      await canvasClick(330, 175); await canvasClick(450, 175); await canvasClick(450, 100); await finish();
      const { points, entities, relations } = sketchGraph(), index = new Map(points.map((point, at) => [point.id, at]));
      shapes.push({ points: points.map(point => point.position), entities: entities.map(entity => entity.kind === 'line' ? [index.get(entity.startPointId), index.get(entity.endPointId)] : entity.kind),
        relations: relations.map(relation => relation.kind) });
      await act(async () => currentSession.undo()); expect(currentSession.getSnapshot().document).toEqual(before.document);
    }
    expect(shapes[0]).toMatchObject({ entities: [[0, 1], [1, 2]] }); expect(shapes[1]).toEqual(shapes[0]); expect(shapes[2]).toEqual(shapes[0]);
  });

  it('keeps horizontal and vertical guides on chain lines but adds none to the line that closes the chain', async () => {
    await mount(); await startSketch(); await click('Line');
    // Each end lands one pixel off the guide from its line's start, and the last click returns to the chain start.
    await canvasClick(330, 300); await canvasClick(420, 301); await canvasClick(421, 360); await canvasClick(331, 361); await canvasClick(330, 300);
    const { points, entities, relations } = sketchGraph();
    expect(entities).toHaveLength(4); expect(points).toHaveLength(4);
    expect(relations.map(relation => relation.kind)).toEqual(['horizontal', 'vertical', 'horizontal']);
    const closing = entities[3]; if (closing.kind !== 'line') throw new Error('Expected the closing line.');
    expect(relations.some(relation => 'pointIds' in relation && relation.pointIds.includes(closing.startPointId) && relation.pointIds.includes(closing.endPointId))).toBe(false);
  });

  it('saves a pending chain open before a tool switch or Finish sketch, and keeps Line and the drawn chain when that save is rejected', async () => {
    let reject = false;
    await mount(createCadDocument(), { build: null, buildState: 'idle', onEdit: edit => {
      if (reject && edit.kind === 'append-sketch-entities') throw new Error('The sketch is read-only.');
      currentSession.edit([edit]);
    } });
    await startSketch(); await snapToGrid(); await click('Line');
    // A lone start keeps the tools waiting; once a segment is complete the toolbar stays in view and usable.
    await canvasClick(330, 175); expect(toolButton('Arc').disabled).toBe(true);
    await canvasClick(450, 175); await canvasClick(450, 100);
    expect(toolButton('Arc').closest('[hidden], [inert]')).toBeNull(); expect(toolButton('Arc').disabled).toBe(false);
    await click('Arc'); expect(sketchGraph().entities.map(entity => entity.kind)).toEqual(['line', 'line']);
    expect(toolButton('Arc').getAttribute('aria-pressed')).toBe('true');
    // A shortcut switches the same way.
    await click('Line'); await canvasClick(330, 330); await canvasClick(450, 330);
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true, cancelable: true })); });
    expect(sketchGraph().entities).toHaveLength(3); expect(toolButton('Circle').getAttribute('aria-pressed')).toBe('true');
    reject = true; await click('Line'); const before = currentSession.getSnapshot();
    await canvasClick(150, 50); await canvasClick(250, 50); await click('Select');
    expect(currentSession.getSnapshot().document).toBe(before.document); expect(toolButton('Line').getAttribute('aria-pressed')).toBe('true');
    expect(statusMessage).toHaveBeenLastCalledWith(expect.stringContaining('The sketch is read-only.'), 'error'); expect(button('Finish chain').disabled).toBe(false);
    await click('Finish sketch'); expect(currentSession.getSnapshot().document).toBe(before.document); expect(button('Finish sketch')).toBeDefined();
    reject = false; await click('Finish sketch');
    expect(sketchGraph().entities).toHaveLength(4); expect(container.querySelector('button[aria-label="Finish sketch"]')).toBeNull();
    expect(() => currentSession.assertWorkflowClosed()).not.toThrow();
  });

  it('spends the second click of a double-click on the chain start once its closure is saved, leaving Line idle and the sketch finishable', async () => {
    await mount(); await startSketch(); await snapToGrid(); await click('Line');
    const canvas = container.querySelector<SVGSVGElement>('[aria-label="Sketch drawing canvas"]'); if (!canvas) throw new Error('Sketch canvas missing.');
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, toJSON: () => ({}) });
    const tap = async (x: number, y: number, detail = 1) => {
      for (const type of ['pointerdown', 'pointerup', 'click']) {
        const event = new MouseEvent(type, { button: 0, buttons: type === 'pointerdown' ? 1 : 0, bubbles: true, cancelable: true, clientX: x, clientY: y, detail });
        Object.defineProperties(event, { pointerId: { value: 12 }, isPrimary: { value: type !== 'click' } });
        await act(async () => canvas.dispatchEvent(event));
      }
    };
    await tap(300, 200); await tap(450, 200); await tap(375, 100);
    // The first click closes the chain and its save is accepted before the second press arrives.
    await tap(300, 200); await tap(300, 200, 2);
    expect(sketchGraph().entities).toHaveLength(3); expect(sketchGraph().points).toHaveLength(3);
    expect(toolButton('Line').getAttribute('aria-pressed')).toBe('true'); expect(workflow).toHaveBeenLastCalledWith(false);
    expect(container.querySelector('button[aria-label="Finish chain"]')).toBeNull(); expect(button('Finish sketch').disabled).toBe(false);
    await click('Select'); expect(toolButton('Select').getAttribute('aria-pressed')).toBe('true');
  });

  it('starts a chain from a quick click on the former start once an undo removes the closed chain', async () => {
    await mount(); await startSketch(); await snapToGrid(); await click('Line');
    const canvas = container.querySelector<SVGSVGElement>('[aria-label="Sketch drawing canvas"]'); if (!canvas) throw new Error('Sketch canvas missing.');
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, toJSON: () => ({}) });
    const tap = async (x: number, y: number, detail = 1) => {
      for (const type of ['pointerdown', 'pointerup', 'click']) {
        const event = new MouseEvent(type, { button: 0, buttons: type === 'pointerdown' ? 1 : 0, bubbles: true, cancelable: true, clientX: x, clientY: y, detail });
        Object.defineProperties(event, { pointerId: { value: 12 }, isPrimary: { value: type !== 'click' } });
        await act(async () => canvas.dispatchEvent(event));
      }
    };
    await tap(300, 200); await tap(450, 200); await tap(375, 100); await tap(300, 200);
    expect(sketchGraph().entities).toHaveLength(3);
    await act(async () => { currentSession.undo(); });
    expect(sketchGraph().entities).toHaveLength(0);
    // The undo is not the chain's own revision, so the click its closure spent is gone and this one starts the next chain.
    await tap(300, 200, 2);
    expect(button('Finish chain').disabled).toBe(true); expect(workflow).toHaveBeenLastCalledWith(true);
    await tap(450, 200); await click('Finish chain');
    expect(sketchGraph().entities).toHaveLength(1);
  });

  it('closes a free line chain on its start into shared point identities and changes only a selected edge to construction', async () => {
    await mount(); await startSketch(); await snapToGrid(); await click('Line');
    // Unticked, the start on the origin only copies its position.
    await drawingRelations(false);
    await canvasClick(300, 200); await canvasClick(450, 200); await canvasClick(375, 100); await canvasClick(300, 200);
    const sketch = currentDocument.features[0];
    if (sketch.kind !== 'sketch' || !sketch.graph) throw new Error('Graph sketch missing.');
    expect(sketch.profiles).toEqual([]);
    expect(sketch.graph.points.map(point => point.position)).toEqual([[0, 0], [50, 0], [25, 40]]);
    expect(sketch.graph.entities).toHaveLength(3); expect(sketch.graph.relations).toEqual([]);
    expect(viewport().getState().selectedSketchGeometrySet).toEqual([]);
    await click('Select');
    const edge = sketch.graph.entities[1];
    await act(async () => viewport().apply({ kind: 'select-sketch-geometry', selection: { kind: 'entity', id: edge.id } }));
    const construction = container.querySelector<HTMLInputElement>('.cad-sketch-options input');
    if (!construction) throw new Error('Construction control missing.');
    await act(async () => construction.click());
    expect(currentDocument.features[0]).toMatchObject({ graph: { points: sketch.graph.points, entities: sketch.graph.entities.map(item => ({ ...item, construction: item.id === edge.id })) } });
    expect(viewport().getState().selectedSketchGeometry).toEqual({ kind: 'entity', id: edge.id });
    expect(() => currentSession.assertWorkflowClosed()).not.toThrow();
  });

  it('places a circle diameter from the toolbar, keeps the tool on with it selected, and reopens that exact driver from its native annotation', async () => {
    const source = parseCadDocument({ ...createCadDocument(), schemaVersion: 2, features: [{ id: 'sketch', kind: 'sketch', name: 'Round plate',
      suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: { points: [{ id: 'center', position: [' 0 ', '0'] }],
        entities: [{ id: 'circle', kind: 'circle', centerPointId: 'center', radius: 5, construction: false }], relations: [] } }] });
    setCadPreferences({ ...getCadPreferences(), showOnPartDimensions: true });
    await mount(source); await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }));
    await act(async () => viewport().apply({ kind: 'select-sketch-geometry', selection: { kind: 'entity', id: 'circle' } }));
    expect(button('Dimension').disabled).toBe(false); await click('Dimension');
    // The selected circle is the first pick and previews its diameter. Escape drops the pick, then leaves the tool and gives the selection back.
    expect(pickInstruction()).toBe('Diameter · Click or press Enter to place · Or choose a point, a line, another curve, the origin or an axis · Escape drops the picks');
    await canvasKey('Escape'); expect(pickInstruction()).toBe('Dimension · Choose a line, arc, circle, point, the origin or an axis · Escape returns to Select');
    expect(viewport().getState().selectedSketchGeometrySet).toEqual([]);
    await canvasKey('Escape'); expect(button('Dimension').getAttribute('aria-pressed')).toBe('false'); expect(button('Select').getAttribute('aria-pressed')).toBe('true');
    expect(viewport().getState().selectedSketchGeometrySet).toEqual([{ kind: 'entity', id: 'circle' }]); expect(currentDocument).toBe(source);
    await click('Dimension'); await canvasKey('Enter');
    const sketch = currentDocument.features[0]; if (sketch.kind !== 'sketch' || !sketch.graph) throw new Error('Missing radial sketch.');
    const relation = sketch.graph.relations[0]; expect(relation).toMatchObject({ kind: 'radial-size', entityId: 'circle', quantity: 'diameter', value: 10 });
    // The tool stays on with nothing picked, and the new diameter is the selection.
    expect(button('Dimension').getAttribute('aria-pressed')).toBe('true');
    expect(pickInstruction()).toBe('Dimension placed · Enter or double-click edits it; choose geometry for the next one · Escape returns to Select');
    const label = container.querySelector('[data-cad-sketch-dimension] [role="button"]'); if (!label) throw new Error('Missing radial annotation.');
    expect(label.getAttribute('aria-pressed')).toBe('true'); expect(viewport().getState().selectedSketchGeometrySet).toEqual([]);
    // A click selects the dimension only; a double-click opens its editor.
    await act(async () => label.dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true, cancelable: true, detail: 1 })));
    expect(container.querySelector('.cad-parameter-editor')).toBeNull(); expect(viewport().getState().selectedSketchGeometrySet).toEqual([]);
    expect(container.querySelector('[data-cad-dimension-status]')?.textContent).toBe('Diameter selected · Double-click or Enter edits · Delete removes');
    await act(async () => label.dispatchEvent(new MouseEvent('dblclick', { button: 0, bubbles: true, cancelable: true, detail: 2 })));
    expect(field('Diameter').value).toBe('10'); expect(viewport().getState().selectedSketchGeometrySet).toEqual([]); expect(label.getAttribute('aria-pressed')).toBe('true');
    expect(currentDocument.features[0]).toBe(sketch); expect(document.activeElement).toBe(field('Diameter'));
    expect([field('Diameter').selectionStart, field('Diameter').selectionEnd]).toEqual([0, 2]);
  });

  it('places an axis dimension from its menu without an aligned driver, ordered from its left point, and reopens it on that pair', async () => {
    const source = parseCadDocument({ ...createCadDocument(), schemaVersion: 2, features: [{ id: 'sketch', kind: 'sketch', name: 'Point offsets',
      suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: { points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [30, 20] }],
        entities: [{ id: 'reference', kind: 'line', startPointId: 'a', endPointId: 'b', construction: true }], relations: [] } }] });
    setCadPreferences({ ...getCadPreferences(), showOnPartDimensions: true });
    await mount(source); await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }));
    const pair = [{ kind: 'point' as const, id: 'b' }, { kind: 'point' as const, id: 'a' }];
    await act(async () => viewport().apply({ kind: 'select-sketch-geometry-set', selections: pair }));
    await click('Dimension');
    expect(pickInstruction()).toBe('Distance · Click or press Enter to place; the pointer side chooses aligned, horizontal or vertical · Right-click for more · Escape drops the picks');
    expect(currentDocument).toBe(source); await dimensionMenu('Horizontal distance');
    const sketch = currentDocument.features[0]; if (sketch.kind !== 'sketch' || !sketch.graph) throw new Error('Offset sketch missing.');
    // The distance runs from the left point, so it reads positive whichever point was picked first.
    expect(sketch.graph.relations).toEqual([expect.objectContaining({ kind: 'axis-distance', axis: 'x', pointIds: ['a', 'b'], value: 30 })]);
    expect(() => currentSession.assertWorkflowClosed()).not.toThrow();
    const annotation = container.querySelector(`[data-cad-sketch-dimension="${sketch.graph.relations[0].id}"] [role="button"]`);
    if (!annotation) throw new Error('Axis annotation missing.');
    await act(async () => viewport().apply({ kind: 'select-sketch-geometry', selection: { kind: 'entity', id: 'reference' } }));
    await act(async () => annotation.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    // The editor works on the ordered pair without selecting it; the dimension stays the selection.
    expect(viewport().getState().selectedSketchGeometrySet).toEqual([]); expect(annotation.getAttribute('aria-pressed')).toBe('true');
    expect(field('Horizontal distance').value).toBe('30'); expect(currentDocument.features[0]).toBe(sketch);
    expect(() => currentSession.assertWorkflowClosed()).not.toThrow();
  });

  describe('canvas dimensions', () => {
    const bracket = () => parseCadDocument({ ...createCadDocument(), schemaVersion: 2, features: [{ id: 'sketch', kind: 'sketch', name: 'Bracket', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
      points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [40, 0] }, { id: 'c', position: [40, 30] }, { id: 'o', position: [10, 10] }],
      entities: [{ id: 'base', kind: 'line', startPointId: 'a', endPointId: 'b', construction: false }, { id: 'side', kind: 'line', startPointId: 'b', endPointId: 'c', construction: false },
        { id: 'hole', kind: 'circle', centerPointId: 'o', radius: 4, construction: false }],
      relations: [{ id: 'length', kind: 'distance', pointIds: ['a', 'b'], value: 40 }, { id: 'diagonal', kind: 'distance', pointIds: ['a', 'c'], value: 50 },
        { id: 'angle', kind: 'line-angle', rays: [{ lineId: 'base', towardPointId: 'a' }, { lineId: 'side', towardPointId: 'c' }], sense: 'cw', value: 90 },
        { id: 'size', kind: 'radial-size', entityId: 'hole', quantity: 'diameter', value: 8 }, { id: 'x', kind: 'fixed-axis', pointId: 'o', axis: 'x', value: 10 },
        { id: 'measured', kind: 'reference-dimension', measurement: { kind: 'line-length', entityId: 'side' } }] } }] });
    /** Opens the sketch, and its relations list under it, which starts collapsed. */
    const open = async (props?: Parameters<typeof mount>[1], source = bracket()) => {
      setCadPreferences({ ...getCadPreferences(), showOnPartDimensions: true });
      await mount(source, props); await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }));
      await expandRelations();
      return source;
    };
    const relationsToggle = () => container.querySelector<HTMLButtonElement>('[data-cad-sketch-relation-list] .cad-sketch-relation-list-toggle');
    const expandRelations = async () => { const toggle = relationsToggle(); if (toggle?.getAttribute('aria-expanded') === 'false') await act(async () => toggle.click()); };
    const relations = () => { const feature = currentDocument.features[0]; if (feature.kind !== 'sketch' || !feature.graph) throw new Error('Sketch missing.'); return feature.graph.relations; };
    const label = (id: string) => {
      const found = container.querySelector<SVGGElement>(`[data-cad-sketch-dimension="${id}"] [role="button"]`); if (!found) throw new Error(`Dimension ${id} missing.`);
      return found;
    };
    const status = () => container.querySelector('[data-cad-dimension-status]')?.textContent ?? null;
    const selectedDimensions = () => [...container.querySelectorAll('[data-cad-sketch-dimension].is-selected')].map(item => item.getAttribute('data-cad-sketch-dimension'));
    const highlighted = (kind: 'point' | 'entity') => [...container.querySelectorAll(`[data-cad-highlight-${kind}]`)].map(item => item.getAttribute(`data-cad-highlight-${kind}`));
    // React derives enter and leave from pointerout and its related target.
    const hover = async (target: Element, entered = true) => {
      const canvas = container.querySelector('[aria-label="Sketch drawing canvas"]'); if (!canvas) throw new Error('Sketch canvas missing.');
      await act(async () => (entered ? canvas : target).dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: entered ? target : canvas })));
    };
    const pick = async (id: string, shiftKey = false) => act(async () => label(id).dispatchEvent(new MouseEvent('click', { button: 0, shiftKey, detail: 1, bubbles: true, cancelable: true })));
    const press = async (id: string, key: string) => act(async () => { label(id).focus(); label(id).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
    const menuItem = (text: string) => {
      const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(entry => entry.textContent?.trim() === text); if (!item) throw new Error(`${text} missing.`);
      return item;
    };
    type Relation = ReturnType<typeof relations>[number];
    /** An agent edit, undo or redo that rewrites the sketch relations. */
    const replace = (change: (current: readonly Relation[]) => readonly Relation[]) => act(async () => {
      const feature = currentDocument.features[0]; if (feature.kind !== 'sketch' || !feature.graph) throw new Error('Sketch missing.');
      replaceDocument({ ...currentDocument, features: [{ ...feature, graph: { ...feature.graph, relations: change(feature.graph.relations) } }] });
    });
    const swap = (relation: Relation) => replace(current => current.map(item => item.id === relation.id ? relation : item));
    const entities = () => { const feature = currentDocument.features[0]; if (feature.kind !== 'sketch' || !feature.graph) throw new Error('Sketch missing.'); return feature.graph.entities.map(entity => entity.id); };
    const geometry = () => viewport().getState().selectedSketchGeometrySet;
    /** The value editor open at a dimension, or null. */
    const valueEditor = () => container.querySelector<HTMLFormElement>('form[data-cad-sketch-value-editor]');
    /** A relations tree row, named by the start of its relation label, such as `Angle` or `Distance relation 2`. */
    const relationRow = (name: string) => {
      const rows = [...container.querySelectorAll<HTMLButtonElement>('ul[aria-label="Sketch relations"] > li button[data-cad-sketch-relation-row]')];
      const found = rows.find(row => row.getAttribute('aria-label')?.startsWith(`${name} `)); if (!found) throw new Error(`${name} row missing from ${rows.map(row => row.getAttribute('aria-label')).join(', ')}.`);
      return found;
    };
    /** Double-clicks a tree row: a dimension's value editor, or its relation selected. */
    const editRow = (name: string) => act(async () => relationRow(name).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })));
    const onlySelection = () => container.querySelector<HTMLButtonElement>('[data-cad-sketch-relation-list] button[aria-label="Only the selection"]');
    /** Opens a sketch edge's context menu from the keyboard and chooses an item. */
    const geometryMenu = async (id: string, item: string) => {
      const canvas = container.querySelector<SVGSVGElement>('[aria-label="Sketch drawing canvas"]'); if (!canvas) throw new Error('Canvas missing.');
      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, toJSON: () => ({}) });
      const target = container.querySelector<SVGGElement>(`[data-cad-sketch-entity="${id}"]`); if (!target) throw new Error(`Edge ${id} missing.`);
      await act(async () => { target.focus(); target.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })); });
      await act(async () => menuItem(item).click());
    };

    it('highlights the measured geometry on hover without changing the document or the selection', async () => {
      const source = await open();
      await act(async () => viewport().apply({ kind: 'select-sketch-geometry', selection: { kind: 'point', id: 'o' } }));
      for (const [id, points, entities] of [['length', ['a', 'b'], ['base']], ['diagonal', ['a', 'c'], []], ['angle', [], ['base', 'side']], ['size', [], ['hole']], ['measured', [], ['side']]] as const) {
        await hover(label(id).querySelector('rect')!);
        expect([highlighted('point'), highlighted('entity')]).toEqual([points, entities]);
        await hover(label(id).querySelector('rect')!, false);
        expect(container.querySelector('[data-cad-sketch-highlight]')).toBeNull();
      }
      // A distance from an axis lights the point and the axis it is measured from, on its label and on its relation row.
      await hover(label('x').querySelector('rect')!);
      expect([highlighted('point'), highlighted('entity')]).toEqual([['o'], ['@v']]);
      await hover(label('x').querySelector('rect')!, false);
      const canvas = container.querySelector<SVGSVGElement>('[aria-label="Sketch drawing canvas"]')!, point = container.querySelector<SVGGElement>('[data-cad-sketch-point="o"]')!;
      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, toJSON: () => ({}) });
      await act(async () => { point.focus(); point.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })); });
      await act(async () => menuItem('Constraints and dimensions').click());
      const row = relationRow('Distance relation 5');
      await act(async () => row.focus());
      expect([highlighted('point'), highlighted('entity')]).toEqual([['o'], ['@v']]);
      await act(async () => row.blur());
      expect(container.querySelector('[data-cad-sketch-highlight]')).toBeNull();
      expect(currentDocument).toBe(source); expect(viewport().getState().selectedSketchGeometrySet).toEqual([{ kind: 'point', id: 'o' }]);
    });

    it('selects with a click, toggles with Shift, clears with Escape and opens the editor only on double-click or Enter', async () => {
      const source = await open();
      await act(async () => viewport().apply({ kind: 'select-sketch-geometry', selection: { kind: 'point', id: 'o' } }));
      await pick('length');
      expect(viewport().getState().selectedSketchGeometrySet).toEqual([]); expect(container.querySelector('.cad-parameter-editor')).toBeNull();
      expect(status()).toBe('Length selected · Double-click or Enter edits · Delete removes'); expect(selectedDimensions()).toEqual(['length']);
      // The selection keeps its geometry highlighted after the pointer leaves.
      expect(highlighted('entity')).toEqual(['base']); expect(label('length').getAttribute('aria-pressed')).toBe('true');
      await pick('size', true); expect(status()).toBe('2 dimensions selected · Delete removes them'); expect(selectedDimensions()).toEqual(['length', 'size']);
      await pick('length', true); expect(selectedDimensions()).toEqual(['size']);
      await press('diagonal', ' '); expect(selectedDimensions()).toEqual(['diagonal']);
      await canvasKey('Escape'); expect(selectedDimensions()).toEqual([]); expect(status()).toBeNull();
      expect(label('length').getAttribute('aria-label')).toBe('Dimension distance 40 mm, press Enter to edit');
      await press('diagonal', 'Enter'); expect(field('Distance').value).toBe('50');
      await act(async () => label('angle').dispatchEvent(new MouseEvent('dblclick', { button: 0, detail: 2, bubbles: true, cancelable: true })));
      expect(field('Angle').value).toBe('90'); expect(currentDocument).toBe(source);
      expect(() => currentSession.assertWorkflowClosed()).not.toThrow();
    });

    /** A post at X = x, held there by a distance from the V axis of `value`, a number or the parameter offset = x. */
    const post = (x: number, value: number | string = x) => parseCadDocument({ ...createCadDocument(), schemaVersion: 2, parameters: { offset: x }, features: [{ id: 'sketch', kind: 'sketch', name: 'Post', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
        points: [{ id: 'p', position: [x, 0] }, { id: 'q', position: [x, 30] }], entities: [{ id: 'post', kind: 'line', construction: false, startPointId: 'p', endPointId: 'q' }],
        relations: [{ id: 'x', kind: 'fixed-axis', pointId: 'p', axis: 'x', value }] } }] });

    it('reports dimensions visible to the viewport when the only one is a distance from an axis', async () => {
      await open(undefined, post(10));
      expect(label('x').getAttribute('aria-label')).toBe('Dimension distance 10 mm, press Enter to edit'); expect(viewport().getState().view).toMatchObject({ onPartDimensionsVisible: true });
      // Held on the V axis instead, the point keeps a relation and nothing is drawn.
      await open(undefined, post(0));
      expect(container.querySelector('[data-cad-sketch-dimension]')).toBeNull(); expect(viewport().getState().view).toMatchObject({ onPartDimensionsVisible: false });
      // Held there by a parameter of 0, it stays a dimension, drawn at 0.
      await open(undefined, post(0, 'offset'));
      expect(label('x').getAttribute('aria-label')).toBe('Dimension distance 0 mm, press Enter to edit'); expect(viewport().getState().view).toMatchObject({ onPartDimensionsVisible: true });
    });

    /** Two lines a hair from parallel: their supports meet about 1e10 mm away, too far to place the angle's corner reliably. */
    const nearParallel = () => parseCadDocument({ ...createCadDocument(), schemaVersion: 2, features: [{ id: 'sketch', kind: 'sketch', name: 'Slot', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
      points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [10, 0] }, { id: 'c', position: [0, 100] }, { id: 'd', position: [10, 100.0000001] }],
      entities: [{ id: 'base', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' }, { id: 'top', kind: 'line', construction: false, startPointId: 'c', endPointId: 'd' }],
      relations: [{ id: 'angle', kind: 'line-angle', rays: [{ lineId: 'base', towardPointId: 'b' }, { lineId: 'top', towardPointId: 'd' }], sense: 'ccw', value: Math.atan2(1e-7, 10) * 180 / Math.PI }] } }] });

    it('draws an angle whose lines meet out of reach across their ends, and selects, counts and edits it like any dimension', async () => {
      await open(undefined, nearParallel());
      const drawn = container.querySelector('[data-cad-sketch-dimension="angle"]');
      expect(drawn?.getAttribute('data-cad-dimension-kind')).toBe('angle');
      expect(drawn?.querySelector('path')).toBeNull(); expect(drawn?.querySelector('line.cad-sketch-graph-dimension-line')).not.toBeNull();
      expect(viewport().getState().view).toMatchObject({ onPartDimensionsVisible: true });
      await pick('angle'); expect(selectedDimensions()).toEqual(['angle']); expect(status()).toBe('Angle selected · Double-click or Enter edits · Delete removes');
      await press('angle', 'Enter'); expect(Number(field('Angle').value)).toBeCloseTo(Math.atan2(1e-7, 10) * 180 / Math.PI, 12); expect(selectedDimensions()).toEqual(['angle']);
    });

    it('selects, edits, deletes and counts only the dimensions the canvas draws, so hiding them drops them from the selection but not from the relations list', async () => {
      await open(); await pick('length'); expect(status()).toBe('Length selected · Double-click or Enter edits · Delete removes');
      await act(async () => setCadPreferences({ ...getCadPreferences(), showOnPartDimensions: false }));
      expect(container.querySelector('[data-cad-sketch-dimension]')).toBeNull(); expect(status()).toBeNull();
      expect(viewport().getState().view).toMatchObject({ onPartDimensionsVisible: false });
      await canvasKey('Delete'); expect(relations().map(relation => relation.id)).toEqual(['length', 'diagonal', 'angle', 'size', 'x', 'measured']);
      // It left the selection for good, so showing dimensions again selects nothing.
      await act(async () => setCadPreferences({ ...getCadPreferences(), showOnPartDimensions: true }));
      expect(viewport().getState().view).toMatchObject({ onPartDimensionsVisible: true }); expect(selectedDimensions()).toEqual([]); expect(status()).toBeNull();
      // Hidden, the relations list still edits it, as a relation; the canvas selection stays empty.
      await act(async () => setCadPreferences({ ...getCadPreferences(), showOnPartDimensions: false }));
      await geometryMenu('base', 'Constraints and dimensions'); await editRow('Distance relation 1');
      expect(field('Length').value).toBe('40'); expect(status()).toBeNull();
    });

    it('keeps a distance from an axis drawn, selected and editable when its parameter is edited to 0', async () => {
      await open(undefined, post(10, 'offset')); await pick('x'); expect(selectedDimensions()).toEqual(['x']);
      const moved = post(0, 'offset'); await act(async () => replaceDocument({ ...currentDocument, parameters: moved.parameters, features: moved.features }));
      expect(label('x').getAttribute('aria-label')).toBe('Dimension distance 0 mm, press Enter to edit'); expect(selectedDimensions()).toEqual(['x']);
      expect(status()).toBe('Distance selected · Double-click or Enter edits · Delete removes'); expect(viewport().getState().view).toMatchObject({ onPartDimensionsVisible: true });
      await press('x', 'Enter'); expect(field('Distance').value).toBe('0');
    });

    it('draws a distance from an axis as a dimension named Distance, and selects, edits and deletes it as one', async () => {
      // There is no solver here, so Apply moves the point the way the solver would.
      const onEditMany = vi.fn<CadWorkbenchProps['onEditMany']>(edits => currentSession.edit(edits.map((item): CadEdit => {
        const feature = currentDocument.features[0];
        if (item.kind !== 'set-sketch-relation' || item.relation.kind !== 'fixed-axis' || feature.kind !== 'sketch' || !feature.graph) return item;
        const relation = item.relation, points = feature.graph.points.map(point => point.id === relation.pointId ? { ...point, position: [Number(relation.value), point.position[1]] as const } : point);
        return { kind: 'update-feature', feature: { ...feature, graph: { ...feature.graph, points, relations: feature.graph.relations.map(entry => entry.id === relation.id ? relation : entry) } } };
      })));
      await open({ build: null, buildState: 'idle', onEditMany });
      // The hole center's X of 10 is drawn square to the V axis, with its size alone.
      expect(label('x').getAttribute('aria-label')).toBe('Dimension distance 10 mm, press Enter to edit');
      await pick('x');
      expect(status()).toBe('Distance selected · Double-click or Enter edits · Delete removes'); expect(selectedDimensions()).toEqual(['x']);
      await press('x', 'ContextMenu');
      expect(menuItem('Make reference').disabled).toBe(true);
      expect(menuItem('Make reference').getAttribute('aria-description')).toBe('A distance from the origin or an axis has no reference form yet.');
      await act(async () => menuItem('Edit value…').click()); expect(field('Distance').value).toBe('10');
      await input(field('Distance'), '12'); await click('Apply');
      expect(onEditMany.mock.lastCall?.[0]).toEqual([{ kind: 'set-sketch-relation', sketchId: 'sketch', relation: { id: 'x', kind: 'fixed-axis', pointId: 'o', axis: 'x', value: 12 } }]);
      expect(relations().find(relation => relation.id === 'x')).toEqual({ id: 'x', kind: 'fixed-axis', pointId: 'o', axis: 'x', value: 12 });
      expect(label('x').getAttribute('aria-label')).toBe('Dimension distance 12 mm, press Enter to edit'); expect(selectedDimensions()).toEqual(['x']);
      await canvasKey('Delete');
      expect(onEditMany.mock.lastCall?.[0]).toEqual([{ kind: 'remove-sketch-relation', sketchId: 'sketch', relationId: 'x' }]);
      expect(relations().map(relation => relation.id)).toEqual(['length', 'diagonal', 'angle', 'size', 'measured']);
      // A distance to a side kept upright edits on that side with the V axis it is measured from, so another row returns the selection to both.
      await replace(current => [...current, { id: 'up', kind: 'vertical', pointIds: ['b', 'c'] }, { id: 'bx', kind: 'fixed-axis', pointId: 'b', axis: 'x', value: 40 }]);
      await press('bx', 'Enter'); expect(field('Distance').value).toBe('40'); expect(selectedDimensions()).toEqual(['bx']);
      // Another row that is no dimension closes the value editor and selects its own relation.
      await editRow('Vertical'); expect(valueEditor()).toBeNull(); expect(relationRow('Vertical').getAttribute('aria-pressed')).toBe('true');
      expect(selectedDimensions()).toEqual([]); expect(geometry()).toEqual([]);
      expect(() => currentSession.assertWorkflowClosed()).not.toThrow();
    });

    it('gives Escape to a pending line chain before the tool, and to the selection only back in Select', async () => {
      await open(); await pick('length'); expect(selectedDimensions()).toEqual(['length']);
      await click('Line'); await canvasClick(100, 300); await canvasClick(200, 300); await canvasClick(200, 200);
      // The first Escape saves the chain open and keeps Line; dimension labels and their keys belong to Select.
      await canvasKey('Escape');
      expect(entities()).toHaveLength(5); expect(toolButton('Line').getAttribute('aria-pressed')).toBe('true');
      expect(container.querySelector('button[aria-label="Finish chain"]')).toBeNull(); expect(container.querySelector('[data-cad-sketch-dimension]')).toBeNull();
      // Choosing Line dropped the dimension, the saved chain leaves nothing selected, and the next Escape leaves the tool.
      expect(geometry()).toEqual([]);
      await canvasKey('Escape'); expect(toolButton('Select').getAttribute('aria-pressed')).toBe('true'); expect(geometry()).toEqual([]);
      // Back in Select, a selected dimension takes the next Escape.
      await pick('length'); expect(selectedDimensions()).toEqual(['length']);
      await canvasKey('Escape'); expect(selectedDimensions()).toEqual([]); expect(toolButton('Select').getAttribute('aria-pressed')).toBe('true');
      expect(() => currentSession.assertWorkflowClosed()).not.toThrow();
    });

    it('still applies a selection-first constraint after a dimension was selected', async () => {
      await open(); await pick('size');
      await act(async () => viewport().apply({ kind: 'select-sketch-geometry', selection: { kind: 'entity', id: 'side' } }));
      expect(selectedDimensions()).toEqual([]); expect(status()).toBeNull();
      await click('Constrain');
      const vertical = [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find(entry => entry.textContent?.trim() === 'Vertical');
      if (!vertical) throw new Error('Vertical missing.'); await act(async () => vertical.click());
      expect(relations().at(-1)).toEqual({ id: expect.any(String), kind: 'vertical', pointIds: ['b', 'c'] });
    });

    it('deletes the selected dimensions in one undoable edit and refuses while another edit is applying', async () => {
      const onEditMany = vi.fn<CadWorkbenchProps['onEditMany']>(edits => currentSession.edit(edits));
      await open({ build: null, buildState: 'idle', onEditMany });
      await pick('length'); await pick('size', true); await canvasKey('Delete');
      expect(onEditMany).toHaveBeenCalledOnce();
      expect(onEditMany.mock.calls[0][0]).toEqual([{ kind: 'remove-sketch-relation', sketchId: 'sketch', relationId: 'length' }, { kind: 'remove-sketch-relation', sketchId: 'sketch', relationId: 'size' }]);
      expect(relations().map(relation => relation.id)).toEqual(['diagonal', 'angle', 'x', 'measured']); expect(status()).toBeNull();
      // Focus never selects: Backspace on an unselected label removes the selection, and with nothing selected the focused label.
      await pick('diagonal'); await press('angle', 'Backspace');
      expect(relations().map(relation => relation.id)).toEqual(['angle', 'x', 'measured']); expect(selectedDimensions()).toEqual([]);
      let finish = () => undefined as void;
      onEditMany.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
      await press('angle', 'Delete'); await press('measured', 'Delete');
      expect(onEditMany).toHaveBeenCalledTimes(3); expect(onEditMany.mock.calls[2][0]).toEqual([{ kind: 'remove-sketch-relation', sketchId: 'sketch', relationId: 'angle' }]);
      expect(relations().map(relation => relation.id)).toEqual(['angle', 'x', 'measured']);
      await act(async () => finish());
    });

    it('reports a refused removal in the relations list wording and keeps the dimension', async () => {
      await open({ build: null, buildState: 'idle', onEditMany: edits => {
        const graph = bracket().features[0];
        if (edits[0]?.kind === 'remove-sketch-relation' && graph.kind === 'sketch' && graph.graph) throw new CadSketchPreparationError({ sketchId: 'sketch', sketchName: 'Bracket', graph: graph.graph,
          rejection: { kind: 'rejected', reason: 'failed', message: 'Solver gave up.', diagnostics: { status: 'failed', degreesOfFreedom: 1, conflictingIds: [], redundantIds: [], partiallyRedundantIds: [], issues: [] } } });
        currentSession.edit(edits);
      } });
      statusMessage.mockClear(); await pick('size'); await canvasKey('Delete');
      expect(statusMessage).toHaveBeenCalledWith(expect.stringContaining('Bracket: The sketch solver could not solve this edit.'), 'error');
      expect(relations().some(relation => relation.id === 'size')).toBe(true); expect(selectedDimensions()).toEqual(['size']);
    });

    /** Opens the header's constraint issues. */
    const openIssues = async () => { const trigger = container.querySelector<HTMLButtonElement>('[data-cad-sketch-issues]'); if (!trigger) throw new Error('Issues button missing.'); await act(async () => trigger.click()); };
    const rowKey = (row: HTMLElement, key: string) => act(async () => { row.focus(); row.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
    it('lights the geometry from relation tree rows and header issue rows without rendering the sketch canvas again', async () => {
      await open({ build: null, buildState: 'idle', onEditMany: () => {
        const feature = currentDocument.features[0]; if (feature.kind !== 'sketch' || !feature.graph) throw new Error('Sketch missing.');
        throw new CadSketchPreparationError({ sketchId: 'sketch', sketchName: 'Bracket', graph: feature.graph, rejection: { kind: 'rejected', reason: 'conflicting', message: 'Over-defined.',
          diagnostics: { status: 'failed', degreesOfFreedom: null, conflictingIds: ['length', 'diagonal'], redundantIds: [], partiallyRedundantIds: [], issues: [] } } });
      } });
      const canvas = container.querySelector<SVGSVGElement>('[aria-label="Sketch drawing canvas"]')!, point = container.querySelector<SVGGElement>('[data-cad-sketch-point="o"]')!;
      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, toJSON: () => ({}) });
      await act(async () => { point.focus(); point.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })); });
      await act(async () => menuItem('Constraints and dimensions').click());
      expect(onlySelection()?.getAttribute('aria-pressed')).toBe('true');
      // A refused Delete lists the conflicting relations as issues in the header, and marks their tree rows.
      const first = container.querySelector<HTMLButtonElement>('ul[aria-label="Sketch relations"] > li button'); if (!first) throw new Error('Relation row missing.');
      await rowKey(first, 'Delete');
      expect(container.querySelector('[data-cad-sketch-issues]')?.getAttribute('data-cad-sketch-issues')).toBe('2');
      await act(async () => onlySelection()!.click());
      expect(relationRow('Distance relation 1').getAttribute('aria-label')).toMatch(/ · Conflict$/);
      await openIssues();
      const issues = [...container.querySelectorAll<HTMLElement>('ul[aria-label="Constraint issues"] > li button')], rows = [...container.querySelectorAll<HTMLElement>('ul[aria-label="Sketch relations"] > li button'), ...issues];
      expect(issues).toHaveLength(2);
      const lit: (string | null)[][] = [];
      canvasRenders.mockClear();
      for (const row of rows) {
        const panel = row.closest('[data-cad-sketch-relation-list], .cad-sketch-header-issue-list')!;
        await act(async () => panel.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: row })));
        for (const offset of [0, 4, 9]) await act(async () => {
          const event = new MouseEvent('pointermove', { bubbles: true, clientX: 700 + offset, clientY: 100 + offset }); Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } });
          row.dispatchEvent(event);
        });
        lit.push([...highlighted('point'), ...highlighted('entity')]);
        await act(async () => row.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: panel })));
      }
      expect(lit.slice(-2)).toEqual([['a', 'b'], ['a', 'c']]); expect(lit.every(entry => entry.length > 0)).toBe(true);
      expect(container.querySelector('[data-cad-sketch-highlight]')).toBeNull(); expect(canvasRenders).not.toHaveBeenCalled();
      // A move over the canvas itself does render it, so the count is live.
      await act(async () => {
        const event = new MouseEvent('pointermove', { bubbles: true, clientX: 300, clientY: 200 }); Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } });
        canvas.dispatchEvent(event);
      });
      expect(canvasRenders).toHaveBeenCalled();
    });

    describe('a tree or issue row highlight after an outside edit, which sends the row no blur or pointer leave', () => {
      const shown = () => [highlighted('point'), highlighted('entity')];
      const enter = async (kind: 'focused' | 'hovered', row: HTMLElement) => act(async () => {
        if (kind === 'focused') row.focus(); else row.closest('[data-cad-sketch-relation-list], .cad-sketch-header-issue-list')!.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: row }));
      });

      it.each(['focused', 'hovered'] as const)('hides the highlight of a %s relation row that the edit removes, a focused one handing focus to the next row', async kind => {
        await open(); await geometryMenu('base', 'Constraints and dimensions');
        const row = relationRow('Distance relation 1'); await enter(kind, row);
        expect(shown()).toEqual([['a', 'b'], ['base']]);
        let left = 0; for (const name of ['blur', 'focusout', 'pointerout', 'pointerleave']) row.addEventListener(name, () => { left += 1; });
        await replace(current => current.filter(relation => relation.id !== 'length'));
        expect(row.isConnected).toBe(false); expect(left).toBe(0); expect(container.querySelector('[data-cad-sketch-relation-list]')).not.toBeNull();
        if (kind === 'hovered') { expect(container.querySelector('[data-cad-sketch-highlight]')).toBeNull(); return; }
        // The row that took its place, the diagonal from a to c, takes focus and lights its own geometry.
        expect((document.activeElement as HTMLElement).dataset.cadSketchRelationRow).toBe('diagonal'); expect(shown()).toEqual([['a', 'c'], []]);
      });

      // The row keeps its relation's ID, so it stays mounted: the pointer stays over it and focus stays in it, and its highlight follows the edit.
      it.each(['hovered', 'focused'] as const)('follows a %s relation row whose operands the edit changes', async kind => {
        await open(); await geometryMenu('base', 'Constraints and dimensions');
        const row = relationRow('Distance relation 1'); await enter(kind, row);
        expect(shown()).toEqual([['a', 'b'], ['base']]);
        await swap({ id: 'length', kind: 'distance', pointIds: ['b', 'c'], value: 30 });
        expect(row.isConnected).toBe(true); expect(relationRow('Distance relation 1').getAttribute('aria-label')).toContain('Point 2 and Point 3');
        expect(shown()).toEqual([['b', 'c'], ['side']]);
      });

      it('draws the highlight of a hovered relation row again when its value editor converts the relation in place', async () => {
        await open(); await geometryMenu('base', 'Constraints and dimensions'); await editRow('Reference dimension relation 6');
        expect(valueEditor()?.getAttribute('aria-label')).toBe('Reference dimension value');
        const row = relationRow('Reference dimension relation 6'); await enter('hovered', row);
        expect(shown()).toEqual([[], ['side']]);
        // Make driving turns the draft into a driving length between the line's ends; the tree names the accepted sketch, so its row
        // and highlight keep the reference until Apply, then follow the same relation in place.
        await click('Make driving');
        expect(row.getAttribute('aria-label')).toMatch(/^Reference dimension relation 6 /); expect(shown()).toEqual([[], ['side']]);
        await click('Apply');
        expect(valueEditor()).toBeNull(); expect(row.isConnected).toBe(true);
        expect(row.getAttribute('aria-label')).toMatch(/^Distance relation 6 · Point 2 and Point 3 · 30 mm/);
        expect(shown()).toEqual([['b', 'c'], ['side']]);
      });

      it('hides the highlight of a hovered issue row that the edit removes', async () => {
        await open({ build: null, buildState: 'idle', onEditMany: () => {
          const feature = currentDocument.features[0]; if (feature.kind !== 'sketch' || !feature.graph) throw new Error('Sketch missing.');
          throw new CadSketchPreparationError({ sketchId: 'sketch', sketchName: 'Bracket', graph: feature.graph, rejection: { kind: 'rejected', reason: 'conflicting', message: 'Over-defined.',
            diagnostics: { status: 'failed', degreesOfFreedom: null, conflictingIds: ['length', 'diagonal'], redundantIds: [], partiallyRedundantIds: [], issues: [] } } });
        } });
        await geometryMenu('base', 'Constraints and dimensions');
        await rowKey(relationRow('Angle'), 'Delete'); await act(async () => relationRow('Angle').blur()); await openIssues();
        const issue = container.querySelector<HTMLElement>('ul[aria-label="Constraint issues"] > li button'); if (!issue) throw new Error('Issue row missing.');
        await enter('hovered', issue); expect(shown()).toEqual([['a', 'b'], []]);
        // The issues belong to the document the Delete was refused for; the Angle stays.
        await replace(current => [...current, { id: 'ay', kind: 'fixed-axis', pointId: 'a', axis: 'y', value: 0 }]);
        expect(issue.isConnected).toBe(false); expect(relationRow('Angle')).toBeTruthy();
        expect(container.querySelector('[data-cad-sketch-highlight]')).toBeNull();
      });
    });

    it('never carries the selection or an open menu to a relation that reuses a dimension ID', async () => {
      await open();
      await pick('length');
      // A rewritten relation that measures the same points is the same dimension.
      await swap({ id: 'length', kind: 'distance', pointIds: ['b', 'a'], value: 40 }); expect(selectedDimensions()).toEqual(['length']);
      // An agent edit that reuses the ID for other points is a different dimension, so Delete has nothing to remove.
      await swap({ id: 'length', kind: 'distance', pointIds: ['b', 'c'], value: 30 });
      expect(selectedDimensions()).toEqual([]); expect(status()).toBeNull();
      const before = currentDocument; await canvasKey('Delete'); expect(currentDocument).toBe(before);
      // Undo and redo can remove a selected dimension and bring it back; it returns unselected.
      await pick('size'); const size = relations().find(relation => relation.id === 'size')!;
      await replace(current => current.filter(relation => relation.id !== 'size')); await replace(current => [...current, size]);
      expect(selectedDimensions()).toEqual([]);
      // An open menu closes when its dimension is replaced, and the replacement is neither selected nor removed.
      await press('angle', 'ContextMenu'); expect(document.querySelector('[role="menu"]')).not.toBeNull();
      await swap({ id: 'angle', kind: 'line-angle', rays: [{ lineId: 'base', towardPointId: 'b' }, { lineId: 'side', towardPointId: 'c' }], sense: 'ccw', value: 90 });
      expect(document.querySelector('[role="menu"]')).toBeNull(); expect(selectedDimensions()).toEqual([]);
      expect(relations().some(relation => relation.id === 'angle')).toBe(true);
    });

    it('offers edit, reference or driving and delete from the dimension menu, with reasons for unavailable commands', async () => {
      await open();
      // The menu key on an unselected dimension selects it first.
      await press('angle', 'ContextMenu'); expect(selectedDimensions()).toEqual(['angle']);
      expect(menuItem('Make reference').disabled).toBe(true);
      expect(menuItem('Make reference').getAttribute('aria-description')).toBe('Reference dimensions measure lengths, point distances, point to line distances, radii and diameters.');
      await act(async () => menuItem('Edit value…').click()); expect(field('Angle').value).toBe('90');
      await press('length', 'ContextMenu'); await act(async () => menuItem('Make reference').click());
      expect(relations().find(relation => relation.id === 'length')).toEqual({ id: 'length', kind: 'reference-dimension', measurement: { kind: 'line-length', entityId: 'base' } });
      // The reference measures the same length, so it stays selected.
      expect(label('length').getAttribute('aria-label')).toMatch(/^Reference dimension /); expect(selectedDimensions()).toEqual(['length']);
      await press('measured', 'ContextMenu');
      expect(menuItem('Edit value…').disabled).toBe(true);
      expect(menuItem('Edit value…').getAttribute('aria-description')).toBe('A reference dimension follows the geometry. Make it driving to set its value.');
      await act(async () => menuItem('Make driving').click());
      expect(relations().find(relation => relation.id === 'measured')).toEqual({ id: 'measured', kind: 'distance', pointIds: ['b', 'c'], value: 30 }); expect(selectedDimensions()).toEqual(['measured']);
      await pick('size'); await pick('diagonal', true); await press('size', 'ContextMenu');
      await act(async () => menuItem('Delete 2 dimensions').click());
      expect(relations().map(relation => relation.id)).toEqual(['length', 'angle', 'x', 'measured']);
      expect(() => currentSession.assertWorkflowClosed()).not.toThrow();
    });

    it.each([
      ['Enter', (id: string) => press(id, 'Enter')],
      ['a double-click', (id: string) => act(async () => label(id).dispatchEvent(new MouseEvent('dblclick', { button: 0, detail: 2, bubbles: true, cancelable: true })))],
      ['Edit value…', async (id: string) => { await press(id, 'ContextMenu'); await act(async () => menuItem('Edit value…').click()); }]
    ] as const)('keeps the dimension, not its geometry, selected after %s opens its editor, so Delete never removes geometry', async (_, edit) => {
      // There is no solver here, so Apply sizes the hole the way the solver would.
      await open({ build: null, buildState: 'idle', onEditMany: edits => currentSession.edit(edits.map((item): CadEdit => {
        const feature = currentDocument.features[0];
        if (item.kind !== 'set-sketch-relation' || item.relation.kind !== 'radial-size' || feature.kind !== 'sketch' || !feature.graph) return item;
        const relation = item.relation, entities = feature.graph.entities.map(entity => entity.id === relation.entityId && entity.kind === 'circle' ? { ...entity, radius: Number(relation.value) / 2 } : entity);
        return { kind: 'update-feature', feature: { ...feature, graph: { ...feature.graph, entities, relations: feature.graph.relations.map(entry => entry.id === relation.id ? relation : entry) } } };
      })) });
      await edit('length'); expect(field('Length').value).toBe('40');
      expect(viewport().getState().selectedSketchGeometrySet).toEqual([]); expect(selectedDimensions()).toEqual(['length']);
      // Delete with the editor open removes the dimension drawn selected, not the line it measures, and closes its editor.
      await canvasKey('Delete');
      expect(relations().map(relation => relation.id)).toEqual(['diagonal', 'angle', 'size', 'x', 'measured']); expect(entities()).toEqual(['base', 'side', 'hole']);
      expect(valueEditor()).toBeNull();
      // Cancel and Apply keep the edited dimension selected.
      await edit('size'); await input(field('Diameter'), '9'); await click('Cancel');
      expect(selectedDimensions()).toEqual(['size']); expect(viewport().getState().selectedSketchGeometrySet).toEqual([]);
      await edit('size'); await input(field('Diameter'), '10'); await click('Apply');
      expect(relations().find(relation => relation.id === 'size')).toMatchObject({ value: 10 });
      expect(selectedDimensions()).toEqual(['size']); expect(viewport().getState().selectedSketchGeometrySet).toEqual([]);
      await canvasKey('Delete');
      expect(relations().map(relation => relation.id)).toEqual(['diagonal', 'angle', 'x', 'measured']); expect(entities()).toEqual(['base', 'side', 'hole']);
    });

    it('never leaves focus, or returns it from a menu, on a label whose dimension was replaced under the same ID', async () => {
      await open();
      const pressFocused = (key: string) => act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
      // Keyboard only: an agent edit reuses the focused label's ID for other points, and Delete has nothing to act on.
      const focused = label('length'); await act(async () => focused.focus());
      await swap({ id: 'length', kind: 'distance', pointIds: ['b', 'c'], value: 30 });
      expect(label('length')).not.toBe(focused); expect(document.activeElement?.closest('[data-cad-sketch-dimension]') ?? null).toBeNull();
      let before = currentDocument; await pressFocused('Delete'); await pressFocused('Backspace'); expect(currentDocument).toBe(before);
      // A menu that the replacement closes does not hand focus to the new label.
      await press('angle', 'ContextMenu'); expect(document.querySelector('[role="menu"]')).not.toBeNull();
      await swap({ id: 'angle', kind: 'line-angle', rays: [{ lineId: 'base', towardPointId: 'b' }, { lineId: 'side', towardPointId: 'c' }], sense: 'ccw', value: 90 });
      expect(document.querySelector('[role="menu"]')).toBeNull(); expect(document.activeElement?.closest('[data-cad-sketch-dimension]') ?? null).toBeNull();
      before = currentDocument; await pressFocused('Delete'); expect(currentDocument).toBe(before);
      // A right press on a label whose dimension is replaced before the release opens no menu for the replacement.
      const canvas = container.querySelector<SVGSVGElement>('[aria-label="Sketch drawing canvas"]'); if (!canvas) throw new Error('Sketch canvas missing.');
      let captured = false;
      Object.assign(canvas, { setPointerCapture: () => { captured = true; }, hasPointerCapture: () => captured, releasePointerCapture: () => { captured = false; } });
      const right = (target: Element, type: 'pointerdown' | 'pointerup') => act(async () => {
        const event = new MouseEvent(type, { button: 2, buttons: type === 'pointerup' ? 0 : 2, bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
        Object.defineProperties(event, { pointerId: { value: 12 }, isPrimary: { value: true } }); target.dispatchEvent(event);
      });
      await right(label('size'), 'pointerdown');
      await swap({ id: 'size', kind: 'radial-size', entityId: 'hole', quantity: 'radius', value: 4 });
      await right(canvas, 'pointerup'); expect(document.querySelector('[role="menu"]')).toBeNull(); expect(selectedDimensions()).toEqual([]);
      // A rewrite that measures the same points keeps the label and its focus, and Delete removes that dimension alone.
      const kept = label('diagonal'); await act(async () => kept.focus());
      await swap({ id: 'diagonal', kind: 'distance', pointIds: ['c', 'a'], value: 50 });
      expect(label('diagonal')).toBe(kept); expect(document.activeElement).toBe(kept);
      await pressFocused('Delete');
      expect(relations().map(relation => relation.id)).toEqual(['length', 'angle', 'size', 'x', 'measured']); expect(entities()).toEqual(['base', 'side', 'hole']);
      // The same right press on an unchanged label opens its menu.
      await right(label('size'), 'pointerdown'); await right(canvas, 'pointerup');
      expect(document.querySelector('[role="menu"]')).not.toBeNull(); expect(selectedDimensions()).toEqual(['size']);
    });

    it('moves the selection to the dimension whose tree row opens its value editor, so Delete removes the dimension the editor shows', async () => {
      await open();
      await press('length', 'Enter'); expect(field('Length').value).toBe('40'); expect(selectedDimensions()).toEqual(['length']);
      await editRow('Angle'); expect(field('Angle').value).toBe('90');
      expect(relationRow('Angle').getAttribute('aria-pressed')).toBe('true'); expect(selectedDimensions()).toEqual(['angle']); expect(geometry()).toEqual([]);
      await canvasKey('Delete');
      expect(relations().map(relation => relation.id)).toEqual(['length', 'diagonal', 'size', 'x', 'measured']); expect(entities()).toEqual(['base', 'side', 'hole']);
      expect(valueEditor()).toBeNull();
    });

    it('selects the dimension, not the geometry, that a geometry menu opens for editing', async () => {
      await open();
      await geometryMenu('base', 'Constraints and dimensions');
      expect(geometry()).toEqual([{ kind: 'entity', id: 'base' }]); expect(selectedDimensions()).toEqual([]);
      await editRow('Distance relation 1'); expect(field('Length').value).toBe('40');
      expect(geometry()).toEqual([]); expect(selectedDimensions()).toEqual(['length']);
      await canvasKey('Delete');
      expect(relations().map(relation => relation.id)).toEqual(['diagonal', 'angle', 'size', 'x', 'measured']); expect(entities()).toEqual(['base', 'side', 'hole']);
      // The menu's Dimension on a dimensioned circle picks it; placing selects its existing dimension, and Enter edits that one.
      await geometryMenu('hole', 'Dimension'); await focusedKey('Enter');
      expect(statusMessage).toHaveBeenCalledWith('This is already dimensioned. Placing selects that dimension and moves it where the preview shows it.', 'info');
      expect(geometry()).toEqual([]); expect(selectedDimensions()).toEqual(['size']); expect(relations()).toHaveLength(5);
      await focusedKey('Enter'); expect(field('Diameter').value).toBe('8');
      expect(geometry()).toEqual([]); expect(selectedDimensions()).toEqual(['size']);
      await canvasKey('Delete');
      expect(relations().map(relation => relation.id)).toEqual(['diagonal', 'angle', 'x', 'measured']); expect(entities()).toEqual(['base', 'side', 'hole']);
    });

    it('keeps the selection to the dimension being edited alone, and closes its editor once anything else takes the selection', async () => {
      await open(); await replace(current => [...current, { id: 'pin', kind: 'fixed-point', pointId: 'o', position: [10, 10] }]);
      // Opening one of several selected dimensions selects that dimension alone.
      await pick('length'); await pick('diagonal', true); expect(selectedDimensions()).toEqual(['length', 'diagonal']);
      await press('diagonal', 'Enter'); expect(field('Distance').value).toBe('50');
      expect(selectedDimensions()).toEqual(['diagonal']); expect(geometry()).toEqual([]);
      // A row that is not a canvas dimension returns the selection to the geometry the panel works on; a dimension row takes it back.
      await press('size', 'Enter'); expect(selectedDimensions()).toEqual(['size']);
      // A fixed point's row opens its value editor on its mark; a dimension row takes the selection back.
      await editRow('Fixed point'); expect(valueEditor()?.getAttribute('aria-label')).toBe('Fixed point value'); expect(field('Fixed X').value).toBe('10');
      expect(selectedDimensions()).toEqual([]); expect(relationRow('Fixed point').getAttribute('aria-pressed')).toBe('true'); expect(geometry()).toEqual([]);
      await editRow('Diameter'); expect(field('Diameter').value).toBe('8'); expect(selectedDimensions()).toEqual(['size']); expect(geometry()).toEqual([]);
      // Geometry or another dimension taking the selection closes the editor.
      await act(async () => viewport().apply({ kind: 'select-sketch-geometry', selection: { kind: 'point', id: 'o' } }));
      expect(valueEditor()).toBeNull(); expect(selectedDimensions()).toEqual([]);
      await press('length', 'Enter'); expect(valueEditor()).not.toBeNull();
      await pick('angle'); expect(valueEditor()).toBeNull(); expect(selectedDimensions()).toEqual(['angle']);
    });

    it('closes a dimension editor when a legacy profile takes the selection', async () => {
      setCadPreferences({ ...getCadPreferences(), showOnPartDimensions: true });
      const source = bracket(), sketch = source.features[0]; if (sketch.kind !== 'sketch') throw new Error('Sketch missing.');
      await mount(parseCadDocument({ ...source, features: [{ ...sketch, profiles: [{ id: 'plate', name: 'Plate', construction: false, role: 'outer',
        geometry: { kind: 'rectangle', x: 0, y: 0, width: 50, height: 40, cornerRadius: 0 } }] }] }));
      await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }));
      await press('size', 'Enter'); expect(field('Diameter').value).toBe('8');
      await act(async () => viewport().apply({ kind: 'select-profile', profileId: 'plate' }));
      expect(viewport().getState().selectedProfileId).toBe('plate'); expect(valueEditor()).toBeNull(); expect(selectedDimensions()).toEqual([]);
      expect(container.querySelector('button[aria-label="Add dimension"]')).not.toBeNull();
    });

    it('closes a dimension editor when another document opens under the same sketch and relation IDs', async () => {
      await open(); await replace(current => [...current, { id: 'pin', kind: 'fixed-point', pointId: 'o', position: [10, 10] }]);
      await press('size', 'Enter'); expect(field('Diameter').value).toBe('8');
      // The editor never renders against the new document, even before the switch clears the selection, so none of its fields takes focus there.
      let refocused = 0; const record = (event: FocusEvent) => { if (event.target instanceof Element && event.target.closest('form[data-cad-sketch-value-editor]')) refocused += 1; };
      container.addEventListener('focusin', record);
      await act(async () => replaceDocument({ ...currentDocument, id: 'other-document' }));
      container.removeEventListener('focusin', record);
      expect(valueEditor()).toBeNull(); expect(selectedDimensions()).toEqual([]); expect(refocused).toBe(0);
      // The new document's dimension opens its own editor.
      await press('size', 'Enter'); expect(field('Diameter').value).toBe('8'); expect(selectedDimensions()).toEqual(['size']);
      // A fixed point's editor, opened from its row, never mounts in another part either.
      await editRow('Fixed point'); expect(relationRow('Fixed point').getAttribute('aria-pressed')).toBe('true'); expect(field('Fixed X').value).toBe('10');
      container.addEventListener('focusin', record);
      await act(async () => replaceDocument({ ...currentDocument, id: 'third-document' }));
      container.removeEventListener('focusin', record);
      expect(valueEditor()).toBeNull(); expect(geometry()).toEqual([]); expect(refocused).toBe(0);
    });

    it('deletes the selection, not a focused label or edge outside it, so Delete removes what is drawn selected', async () => {
      await open();
      const ids = () => relations().map(relation => relation.id);
      const points = () => { const feature = currentDocument.features[0]; return feature.kind === 'sketch' ? feature.graph?.points.map(point => point.id) : undefined; };
      const pressGeometry = (selector: string, key: string) => act(async () => {
        const target = container.querySelector<SVGElement>(selector); if (!target) throw new Error(`${selector} missing.`);
        target.focus(); target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      });
      // Length's editor is open and keyboard focus moves to the unselected Diagonal label: Delete removes Length and closes its editor.
      await press('length', 'Enter'); expect(field('Length').value).toBe('40');
      await press('diagonal', 'Delete');
      expect(ids()).toEqual(['diagonal', 'angle', 'size', 'x', 'measured']); expect(valueEditor()).toBeNull(); expect(selectedDimensions()).toEqual([]);
      // A focused edge removes the dimension selection, never itself.
      await pick('size'); await pressGeometry('[data-cad-sketch-entity="base"]', 'Delete');
      expect(ids()).toEqual(['diagonal', 'angle', 'x', 'measured']); expect(entities()).toEqual(['base', 'side', 'hole']);
      // Selected geometry goes on Delete from a label and stays on Backspace, which removes only dimensions; the label's dimension stays.
      await act(async () => viewport().apply({ kind: 'select-sketch-geometry', selection: { kind: 'entity', id: 'hole' } }));
      await press('angle', 'Backspace'); expect(ids()).toEqual(['diagonal', 'angle', 'x', 'measured']); expect(entities()).toEqual(['base', 'side', 'hole']);
      await press('angle', 'Delete'); expect(entities()).toEqual(['base', 'side']); expect(ids()).toEqual(['diagonal', 'angle', 'x', 'measured']);
      // A selected point goes, not the focused edge.
      await act(async () => viewport().apply({ kind: 'select-sketch-geometry', selection: { kind: 'point', id: 'o' } }));
      await pressGeometry('[data-cad-sketch-entity="side"]', 'Delete'); expect(entities()).toEqual(['base', 'side']); expect(points()).toEqual(['a', 'b', 'c']); expect(ids()).toEqual(['diagonal', 'angle', 'measured']);
      // With nothing selected the focused label or edge is the one removed.
      await press('diagonal', 'Delete'); expect(ids()).toEqual(['angle', 'measured']);
      await pressGeometry('[data-cad-sketch-entity="side"]', 'Delete'); expect(entities()).toEqual(['base']);
    });

    it('selects, edits, converts, highlights and deletes a point to line distance the circle and line picks placed from its center', async () => {
      // There is no solver here, so Apply moves the center the way the solver would; the base line lies on the H axis.
      await open({ build: null, buildState: 'idle', onEditMany: edits => currentSession.edit(edits.map((item): CadEdit => {
        const feature = currentDocument.features[0];
        if (item.kind !== 'set-sketch-relation' || item.relation.kind !== 'point-line-distance' || feature.kind !== 'sketch' || !feature.graph) return item;
        const relation = item.relation, existing = feature.graph.relations.some(entry => entry.id === relation.id);
        const points = feature.graph.points.map(point => point.id === relation.pointId ? { ...point, position: [point.position[0], Number(relation.value)] as const } : point);
        const relations = existing ? feature.graph.relations.map(entry => entry.id === relation.id ? relation : entry) : [...feature.graph.relations, relation];
        return { kind: 'update-feature', feature: { ...feature, graph: { ...feature.graph, points, relations } } };
      })) });
      const choose = (selector: string) => act(async () => {
        const target = container.querySelector(selector); if (!target) throw new Error(`${selector} missing.`);
        keyboardPick(target);
      });
      // The circle, then the line: the distance runs from the circle's center, and Enter places it.
      await click('Dimension'); await choose('[data-cad-sketch-entity="hole"]'); await choose('[data-cad-sketch-entity="base"]');
      expect(pickInstruction()).toBe('Distance · Click or press Enter to place · Right-click for more · Escape drops the picks'); await focusedKey('Enter');
      const created = relations().find(relation => relation.kind === 'point-line-distance'); if (!created) throw new Error('Point to line distance missing.');
      expect(created).toEqual({ id: expect.any(String), kind: 'point-line-distance', pointId: 'o', lineId: 'base', side: 'left', value: 10 });
      const id = created.id;
      // Escape leaves the tool and keeps the new distance selected.
      expect(selectedDimensions()).toEqual([id]); await canvasKey('Escape');
      expect(button('Dimension').getAttribute('aria-pressed')).toBe('false'); expect(selectedDimensions()).toEqual([id]);
      await act(async () => viewport().apply({ kind: 'select-sketch-geometry', selection: null }));
      // Hover highlights the center and the line; a click selects the dimension alone.
      await hover(label(id).querySelector('rect')!); expect([highlighted('point'), highlighted('entity')]).toEqual([['o'], ['base']]);
      await hover(label(id).querySelector('rect')!, false);
      await pick(id); expect(selectedDimensions()).toEqual([id]); expect(geometry()).toEqual([]);
      expect(status()).toBe('Point to line distance selected · Double-click or Enter edits · Delete removes');
      expect([highlighted('point'), highlighted('entity')]).toEqual([['o'], ['base']]);
      // Enter edits it on its center and line and keeps it selected.
      await press(id, 'Enter'); expect(field('Point to line distance').value).toBe('10');
      expect(selectedDimensions()).toEqual([id]); expect(geometry()).toEqual([]);
      expect(valueEditor()?.getAttribute('aria-label')).toBe('Point to line distance value');
      await input(field('Point to line distance'), '12'); await click('Apply');
      expect(relations().find(relation => relation.id === id)).toEqual({ ...created, value: 12 }); expect(selectedDimensions()).toEqual([id]);
      // Make reference measures the same point and line under the same ID, and Make driving restores the distance on the same side.
      await press(id, 'ContextMenu'); await act(async () => menuItem('Make reference').click());
      expect(relations().find(relation => relation.id === id)).toEqual({ id, kind: 'reference-dimension', measurement: { kind: 'point-line-distance', pointId: 'o', lineId: 'base' } });
      expect(selectedDimensions()).toEqual([id]); expect([highlighted('point'), highlighted('entity')]).toEqual([['o'], ['base']]);
      await press(id, 'ContextMenu'); await act(async () => menuItem('Make driving').click());
      expect(relations().find(relation => relation.id === id)).toMatchObject({ id, kind: 'point-line-distance', pointId: 'o', lineId: 'base', side: 'left' });
      expect(selectedDimensions()).toEqual([id]);
      // A focused label elsewhere deletes the selected distance, and only that.
      await press('length', 'Delete');
      expect(relations().map(relation => relation.id)).toEqual(['length', 'diagonal', 'angle', 'size', 'x', 'measured']); expect(selectedDimensions()).toEqual([]);
    });

    it('keeps a dimension the Dimension tool reuses selected while it converts a driver stored on a coincident alias, and drops one replaced by another measurement', async () => {
      // The base line's length is stored on q, which a Coincident relation joins to a; the clearance runs from r, joined to the center o.
      const aliased = () => { const source = bracket(), feature = source.features[0]; if (feature.kind !== 'sketch' || !feature.graph) throw new Error('Sketch missing.');
        return parseCadDocument({ ...source, features: [{ ...feature, graph: { ...feature.graph, points: [...feature.graph.points, { id: 'q', position: [0, 0] }, { id: 'r', position: [10, 10] }],
          relations: [{ id: 'joint', kind: 'coincident', pointIds: ['q', 'a'] }, { id: 'center', kind: 'coincident', pointIds: ['r', 'o'] },
            ...feature.graph.relations.map(relation => relation.id === 'length' ? { id: 'length', kind: 'distance' as const, pointIds: ['q', 'b'] as const, value: 40 } : relation),
            { id: 'clearance', kind: 'point-line-distance', pointId: 'r', lineId: 'base', side: 'left', value: 10 }] } }] }); };
      const source = await open(undefined, aliased());
      // The line's Dimension finds the driver on q and selects it rather than adding another; Make reference keeps its points and the selection.
      await geometryMenu('base', 'Dimension'); await focusedKey('Enter'); await canvasKey('Escape');
      expect(relations()).toHaveLength(source.features[0].kind === 'sketch' ? source.features[0].graph?.relations.length ?? 0 : 0);
      expect(selectedDimensions()).toEqual(['length']); expect(geometry()).toEqual([]);
      await press('length', 'ContextMenu'); await act(async () => menuItem('Make reference').click());
      expect(relations().find(relation => relation.id === 'length')).toEqual({ id: 'length', kind: 'reference-dimension', measurement: { kind: 'point-distance', pointIds: ['q', 'b'] } });
      expect(selectedDimensions()).toEqual(['length']);
      // Make driving brings it back on the same points, still selected, so a canvas Delete removes it.
      await press('length', 'ContextMenu'); await act(async () => menuItem('Make driving').click());
      expect(relations().find(relation => relation.id === 'length')).toEqual({ id: 'length', kind: 'distance', pointIds: ['q', 'b'], value: 40 }); expect(selectedDimensions()).toEqual(['length']);
      await canvasKey('Delete'); expect(relations().some(relation => relation.id === 'length')).toBe(false);
      // The circle and line find the clearance stored on r and select it; Make reference keeps it selected.
      const choose = (selector: string) => act(async () => {
        const target = container.querySelector(selector); if (!target) throw new Error(`${selector} missing.`);
        keyboardPick(target);
      });
      await click('Dimension'); await choose('[data-cad-sketch-entity="hole"]'); await choose('[data-cad-sketch-entity="base"]'); await focusedKey('Enter'); await canvasKey('Escape');
      expect(selectedDimensions()).toEqual(['clearance']);
      await press('clearance', 'ContextMenu'); await act(async () => menuItem('Make reference').click());
      expect(relations().find(relation => relation.id === 'clearance')).toMatchObject({ id: 'clearance', kind: 'reference-dimension', measurement: { kind: 'point-line-distance', lineId: 'base' } });
      expect(selectedDimensions()).toEqual(['clearance']);
      // A driver from the alias to another line under the same ID is a different dimension and drops the selection.
      await swap({ id: 'clearance', kind: 'point-line-distance', pointId: 'r', lineId: 'side', side: 'left', value: 30 });
      expect(label('clearance').getAttribute('aria-label')).toMatch(/^Dimension /); expect(selectedDimensions()).toEqual([]);
    });

    describe('across one edit that converts the selected dimensions and removes or adds their Coincident joins', () => {
      // The length runs from q and the clearance from r. Joined, q sits on a, the base line's start, and r on the center o; apart, both have moved.
      const variant = (joined: boolean, driving: boolean) => { const source = bracket(), feature = source.features[0]; if (feature.kind !== 'sketch' || !feature.graph) throw new Error('Sketch missing.');
        return parseCadDocument({ ...source, features: [{ ...feature, graph: { ...feature.graph,
          points: [...feature.graph.points, { id: 'q', position: joined ? [0, 0] : [-20, 0] }, { id: 'r', position: joined ? [10, 10] : [30, 25] }],
          relations: [...joined ? [{ id: 'joint', kind: 'coincident', pointIds: ['q', 'a'] }, { id: 'center', kind: 'coincident', pointIds: ['r', 'o'] }] : [],
            ...feature.graph.relations.filter(relation => relation.id !== 'length'),
            ...driving ? [{ id: 'length', kind: 'distance', pointIds: ['q', 'b'], value: joined ? 40 : 60 }, { id: 'clearance', kind: 'point-line-distance', pointId: 'r', lineId: 'base', side: 'left', value: joined ? 10 : 25 }]
              : [{ id: 'length', kind: 'reference-dimension', measurement: { kind: 'line-length', entityId: 'base' } }, { id: 'clearance', kind: 'reference-dimension', measurement: { kind: 'point-line-distance', pointId: 'o', lineId: 'base' } }]] } }] }); };
      /** One undoable edit that replaces the sketch with another variant. */
      const convert = (next: ReturnType<typeof variant>) => act(async () => { await currentSession.editPrepared(currentSession.getSnapshot().version, async source => ({ ...source, features: next.features })); });
      const both = async () => { await pick('length'); await pick('clearance', true); expect(selectedDimensions()).toEqual(['length', 'clearance']); };
      const measured = () => relations().filter(relation => relation.id === 'length' || relation.id === 'clearance');
      const form = () => relations().find(relation => relation.id === 'length')?.kind;
      const undo = () => act(async () => currentSession.undo()), redo = () => act(async () => currentSession.redo());

      it('drops the selection when the edit removes the joins, so Delete leaves the replacements alone', async () => {
        // The review's repro: the edit moves q and r away and makes each dimension a reference on the line and on o, other measurements now.
        await open(undefined, variant(true, true)); await both();
        await convert(variant(false, false)); expect(form()).toBe('reference-dimension'); expect(selectedDimensions()).toEqual([]);
        const references = measured(); await canvasKey('Delete'); expect(measured()).toEqual(references);
      });
      it('keeps the selection when the edit adds the joins, so Delete removes both', async () => {
        await open(undefined, variant(false, true)); await both();
        await convert(variant(true, false)); expect(form()).toBe('reference-dimension'); expect(selectedDimensions()).toEqual(['length', 'clearance']);
        await canvasKey('Delete'); expect(measured()).toEqual([]);
      });
      it('keeps the selection on undo to the joined sketch and drops it on redo of the edit that removes the joins', async () => {
        await open(undefined, variant(true, true)); await convert(variant(false, false)); await both();
        await undo(); expect(form()).toBe('distance'); expect(selectedDimensions()).toEqual(['length', 'clearance']);
        await redo(); expect(form()).toBe('reference-dimension'); expect(selectedDimensions()).toEqual([]);
      });
      it('drops the selection on undo to the loose sketch and keeps it on redo of the edit that adds the joins', async () => {
        await open(undefined, variant(false, true)); await convert(variant(true, false)); await both();
        await undo(); expect(form()).toBe('distance'); expect(selectedDimensions()).toEqual([]);
        await both(); await redo(); expect(form()).toBe('reference-dimension'); expect(selectedDimensions()).toEqual(['length', 'clearance']);
      });
    });

    it('lets an axis selection and a dimension selection replace each other, and a focused label never deletes past an axis selection', async () => {
      await open();
      const fixed = (name: string) => { const found = container.querySelector<SVGElement>(`[data-cad-sketch-fixed="${name}"][role="button"]`); if (!found) throw new Error(`${name} missing.`); return found; };
      const chooseFixed = (name: string, shiftKey = false) => act(async () => { fixed(name).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey, bubbles: true, cancelable: true })); });
      const pressed = () => ['@origin', '@h', '@v'].filter(name => container.querySelector(`[data-cad-sketch-fixed="${name}"]`)?.getAttribute('aria-pressed') === 'true');
      await pick('length'); expect(selectedDimensions()).toEqual(['length']);
      // An axis replaces the dimension selection, plainly or with Shift.
      await chooseFixed('@h'); expect(selectedDimensions()).toEqual([]); expect(pressed()).toEqual(['@h']); expect(status()).toBeNull();
      await pick('length'); expect(selectedDimensions()).toEqual(['length']); expect(pressed()).toEqual([]);
      await chooseFixed('@v', true); expect(selectedDimensions()).toEqual([]); expect(pressed()).toEqual(['@v']);
      // A Shift pick on a label replaces the axes with that dimension.
      await pick('angle', true); expect(selectedDimensions()).toEqual(['angle']); expect(pressed()).toEqual([]);
      // An axis closes an open dimension editor.
      await press('length', 'Enter'); expect(field('Length').value).toBe('40');
      await chooseFixed('@h'); expect(valueEditor()).toBeNull(); expect(selectedDimensions()).toEqual([]); expect(pressed()).toEqual(['@h']);
      // With an axis selected, Delete or Backspace on a focused label removes nothing and keeps the axis.
      const before = relations();
      await press('diagonal', 'Delete'); await press('length', 'Backspace');
      expect(relations()).toBe(before); expect(pressed()).toEqual(['@h']); expect(selectedDimensions()).toEqual([]);
    });

    const pointerSetup = () => {
      const canvas = container.querySelector<SVGSVGElement>('[aria-label="Sketch drawing canvas"]'); if (!canvas) throw new Error('Sketch canvas missing.');
      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, toJSON: () => ({}) });
      let captured = false;
      Object.assign(canvas, { setPointerCapture: () => { captured = true; }, hasPointerCapture: () => captured, releasePointerCapture: () => { captured = false; } });
      const view = viewport().getState().view; if (!view || view.mode === 'solid') throw new Error('Sketch frame missing.');
      const viewWidth = Number(canvas.getAttribute('viewBox')?.split(' ')[2]);
      /** The client position of a point drawn in the graph layer, whose coordinates are relative to the view centre. */
      const at = (x: number, y: number) => ({ clientX: 300 + x / viewWidth * 600, clientY: 200 - y / view.heightSpanMm * 400 });
      /** The client position of a sketch position, and the sketch position of a client one. */
      const sketchAt = (x: number, y: number) => at(x - view.centerMm[0], y - view.centerMm[1]);
      const sketchOf = (position: { clientX: number; clientY: number }) => ({ x: view.centerMm[0] + (position.clientX - 300) / 600 * viewWidth, y: view.centerMm[1] - (position.clientY - 200) / 400 * view.heightSpanMm });
      const hit = (id: string) => {
        const found = container.querySelector<SVGGElement>(`[data-cad-sketch-dimension-hit="${id}"]`); if (!found) throw new Error(`Dimension line ${id} missing.`);
        const line = found.querySelector('line')!, value = (name: string) => Number(line.getAttribute(name));
        return { element: line, start: at(value('x1'), value('y1')), end: at(value('x2'), value('y2')),
          along: (share: number) => at(value('x1') + (value('x2') - value('x1')) * share, value('y1') + (value('y2') - value('y1')) * share) };
      };
      const arrowTip = (id: string) => {
        const [x, y] = container.querySelector(`[data-cad-sketch-dimension="${id}"] .cad-sketch-graph-dimension-arrow`)!.getAttribute('points')!.split(' ')[0].split(',').map(Number);
        return at(x, y);
      };
      const send = (target: Element, type: string, position: { clientX: number; clientY: number }, init: MouseEventInit = {}) => act(async () => {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...position, ...init });
        Object.defineProperties(event, { pointerId: { value: 7 }, isPrimary: { value: true } }); target.dispatchEvent(event);
      });
      // Each press goes to the dimension's line as drawn now. A press the canvas takes captures the pointer, and a box it begins
      // makes the dimensions inert and draws their lines again, so its release and click reach the canvas.
      const released = (target: Element) => target.isConnected ? target : canvas;
      const clickAt = async (id: string, position: { clientX: number; clientY: number }, init: MouseEventInit = {}, detail = 1) => {
        const target = hit(id).element;
        await send(target, 'pointerdown', position, { button: 0, buttons: 1, ...init }); await send(released(target), 'pointerup', position, { button: 0, buttons: 0, ...init });
        await send(released(target), 'click', position, { button: 0, detail, ...init });
      };
      const doubleClickAt = async (id: string, position: { clientX: number; clientY: number }) => {
        await clickAt(id, position); await clickAt(id, position, {}, 2); await send(released(hit(id).element), 'dblclick', position, { button: 0, detail: 2 });
      };
      const rightClickAt = async (id: string, position: { clientX: number; clientY: number }) => {
        await send(hit(id).element, 'pointerdown', position, { button: 2, buttons: 2 }); await send(canvas, 'pointerup', position, { button: 2, buttons: 0 });
      };
      const fixedPressed = () => ['@origin', '@h', '@v'].filter(name => container.querySelector(`[data-cad-sketch-fixed="${name}"]`)?.getAttribute('aria-pressed') === 'true');
      const fixedHovered = () => [...container.querySelectorAll('[data-cad-sketch-fixed].is-pick-highlighted')].map(item => item.getAttribute('data-cad-sketch-fixed'));
      const menuItems = () => [...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent?.trim());
      return { canvas, hit, arrowTip, send, clickAt, doubleClickAt, rightClickAt, fixedPressed, fixedHovered, menuItems, sketchAt, sketchOf };
    };

    describe('a dimension line or arrow, which takes the pointer only where no geometry, axis or origin lies', () => {
      it('lies beneath every sketch point and edge, while the labels lie above them', async () => {
        await open();
        const layer = container.querySelector('.cad-sketch-graph-dimension-hits'), rows = [...container.querySelectorAll('[data-cad-sketch-point], [data-cad-sketch-entity]')];
        expect(layer?.querySelectorAll('[data-cad-sketch-dimension-hit]').length).toBe(container.querySelectorAll('[data-cad-sketch-dimension]').length);
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
          expect(layer!.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
          expect(row.compareDocumentPosition(label('length')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        }
      });

      it('selects, toggles and edits its dimension and opens its menu away from the geometry, the axes and the origin', async () => {
        await open(); const { hit, clickAt, doubleClickAt, rightClickAt, menuItems } = pointerSetup();
        const middle = hit('length').along(.5);
        await clickAt('length', middle);
        expect(selectedDimensions()).toEqual(['length']); expect(document.activeElement).toBe(label('length'));
        await clickAt('size', hit('size').along(.25), { shiftKey: true }); expect(selectedDimensions()).toEqual(['length', 'size']);
        await canvasKey('Escape'); expect(selectedDimensions()).toEqual([]);
        await rightClickAt('length', middle);
        expect(menuItems()).toEqual(expect.arrayContaining(['Edit value…', 'Make reference'])); expect(selectedDimensions()).toEqual(['length']);
        await act(async () => document.querySelector('[role="menu"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
        expect(document.querySelector('[role="menu"]')).toBeNull();
        await doubleClickAt('diagonal', hit('diagonal').along(.5)); expect(field('Distance').value).toBe('50');
      });

      it('leaves the hover, the press and the right-click on an axis under it to the axis', async () => {
        await open(); const { hit, arrowTip, clickAt, doubleClickAt, send, rightClickAt, fixedPressed, fixedHovered, menuItems } = pointerSetup();
        // Length runs from a, on the V axis, along the base; its line and arrow at a lie on that axis.
        const onAxis = hit('length').start, away = hit('length').along(.5);
        expect(arrowTip('length').clientX).toBeCloseTo(onAxis.clientX, 6);
        await send(hit('length').element, 'pointermove', away, { buttons: 0 });
        expect(highlighted('entity')).toEqual(['base']); expect(fixedHovered()).toEqual([]);
        expect(container.querySelector('[data-cad-sketch-dimension="length"]')?.classList.contains('is-pointed')).toBe(true);
        await send(hit('length').element, 'pointermove', onAxis, { buttons: 0 });
        expect(fixedHovered()).toEqual(['@v']); expect(highlighted('entity')).toEqual([]);
        expect(container.querySelector('[data-cad-sketch-dimension="length"]')?.classList.contains('is-pointed')).toBe(false);
        await clickAt('length', onAxis);
        expect(fixedPressed()).toEqual(['@v']); expect(selectedDimensions()).toEqual([]); expect(document.activeElement).not.toBe(label('length'));
        await clickAt('length', onAxis, { shiftKey: true }); expect(fixedPressed()).toEqual([]); expect(selectedDimensions()).toEqual([]);
        await doubleClickAt('length', onAxis);
        expect(fixedPressed()).toEqual(['@v']); expect(document.querySelector('.cad-parameter-editor')).toBeNull(); expect(selectedDimensions()).toEqual([]);
        await rightClickAt('length', onAxis);
        expect(menuItems()).not.toContain('Make reference'); expect(selectedDimensions()).toEqual([]);
      });

      it('offers the geometry under a right-click before its dimension', async () => {
        await open(); const { arrowTip, rightClickAt, menuItems } = pointerSetup();
        // The diameter line runs out from the hole's centre and crosses the hole where its arrow ends.
        await rightClickAt('size', arrowTip('size'));
        expect(menuItems()).toContain('Select edge'); expect(menuItems()).not.toContain('Make reference'); expect(selectedDimensions()).toEqual([]);
      });
    });

    describe('placed where they are clicked, and moved by their labels and lines', () => {
      type Linear = { readonly kind: 'linear'; readonly offset: number; readonly along: number };
      const relation = (id: string) => { const found = relations().find(item => item.id === id); if (!found) throw new Error(`Relation ${id} missing.`); return found; };
      const annotationOf = (id: string) => { const found = relation(id); return 'annotation' in found ? found.annotation : undefined; };
      const expectLinear = (id: string, offset: number, along: number) => {
        const annotation = annotationOf(id) as Linear | undefined;
        expect(annotation?.kind).toBe('linear'); expect(annotation?.offset).toBeCloseTo(offset, 6); expect(annotation?.along).toBeCloseTo(along, 6);
      };
      /** Sketch millimetres per screen pixel, as the labels are drawn. */
      const scale = () => Number(label('length').getAttribute('transform')?.match(/scale\(([^ ]+) /)?.[1]);
      /** A press, moves by the client offsets given and a release, each on the element given. */
      const dragBy = async (send: ReturnType<typeof pointerSetup>['send'], target: () => Element, from: { clientX: number; clientY: number }, ...steps: readonly (readonly [number, number])[]) => {
        await send(target(), 'pointerdown', from, { button: 0, buttons: 1 });
        let at = from;
        for (const [dx, dy] of steps) { at = { clientX: from.clientX + dx, clientY: from.clientY + dy }; await send(target(), 'pointermove', at, { buttons: 1 }); }
        await send(target(), 'pointerup', at, { button: 0, buttons: 0 }); await send(target(), 'click', at, { button: 0, detail: 1 });
      };
      const moving = () => container.querySelector('[data-cad-sketch-dimension-moving]');

      it('places a dimension where it is clicked, and moves one the picks already measure there, each as one undo step', async () => {
        await open(); await replace(current => current.filter(item => item.id !== 'measured'));
        const { canvas, hit, send, sketchAt } = pointerSetup(), before = relations();
        const place = async (entity: string, x: number, y: number) => {
          await geometryMenu(entity, 'Dimension');
          await send(canvas, 'pointermove', sketchAt(x, y), { buttons: 0 });
          await send(canvas, 'pointerdown', sketchAt(x, y), { button: 0, buttons: 1 }); await send(canvas, 'pointerup', sketchAt(x, y), { button: 0, buttons: 0 });
          await canvasKey('Escape');
        };
        // The side runs up from b, so its dimension line 12 mm to the right is 12 mm to the right of the side, its text centred on the click.
        await place('side', 52, 15);
        const added = relations().filter(item => !before.some(old => old.id === item.id));
        expect(added).toMatchObject([{ kind: 'distance', pointIds: ['b', 'c'], value: 30 }]); expectLinear(added[0].id, -12, .5);
        const drawn = hit(added[0].id).along(.5), click = sketchAt(52, 15);
        expect(drawn.clientX).toBeCloseTo(click.clientX, 6); expect(drawn.clientY).toBeCloseTo(click.clientY, 6);
        // The base already has its length, which moves to the click instead.
        const placed = relations();
        await place('base', 20, -9);
        expect(relations().map(item => item.id)).toEqual(placed.map(item => item.id)); expectLinear('length', -9, .5);
        expect(relation('length')).toMatchObject({ kind: 'distance', pointIds: ['a', 'b'], value: 40 });
        await act(async () => currentSession.undo()); expect(relations()).toEqual(placed);
        await act(async () => currentSession.undo()); expect(relations()).toEqual(before);
        await act(async () => currentSession.redo()); await act(async () => currentSession.redo()); expectLinear('length', -9, .5); expectLinear(added[0].id, -12, .5);
      });

      it('places what the preview shows for Enter while the pointer is on the sketch, and the usual layout before it has been there', async () => {
        await open(); await replace(current => current.filter(item => item.id !== 'measured'));
        const before = relations(), added = () => relations().filter(item => !before.some(old => old.id === item.id));
        // From the keyboard alone no preview is drawn, so Enter places the side's length where it is laid out automatically.
        await geometryMenu('side', 'Dimension'); await canvasKey('Enter');
        expect(added()).toEqual([{ id: expect.any(String), kind: 'distance', pointIds: ['b', 'c'], value: 30 }]);
        await canvasKey('Escape'); await act(async () => currentSession.undo()); expect(relations()).toEqual(before);
        // With the pointer on the sketch, Enter places it where the preview drew it, as a click there would.
        const { canvas, send, sketchAt } = pointerSetup();
        await geometryMenu('side', 'Dimension'); await send(canvas, 'pointermove', sketchAt(52, 15), { buttons: 0 }); await canvasKey('Enter');
        expect(added()).toMatchObject([{ kind: 'distance', pointIds: ['b', 'c'], value: 30 }]); expectLinear(added()[0].id, -12, .5);
      });

      it('drags a label along and away from its line, and the line only away from its geometry, each as one undo step selecting it', async () => {
        const source = await open(); const { hit, send, sketchOf } = pointerSetup(), mm = scale(), original = relation('length');
        // The length's line runs level with the base, so its offset is the line's height.
        const height = sketchOf(hit('length').start).y;
        // Along the line as well as away, which moves only the line.
        workflow.mockClear();
        await dragBy(send, () => hit('length').element, hit('length').along(.3), [15, -10]);
        expectLinear('length', height + 10 * mm, .5); expect(selectedDimensions()).toEqual(['length']);
        const lifted = relations();
        await dragBy(send, () => label('length'), { clientX: 200, clientY: 200 }, [10, 5], [30, 20]);
        expectLinear('length', height + 10 * mm - 20 * mm, .5 + 30 * mm / 40); expect(selectedDimensions()).toEqual(['length']);
        // Each move is accepted at once, so none opens a workflow that locks the workbench while it waits.
        expect(workflow).not.toHaveBeenCalledWith(true);
        // Text dragged beyond an extension line takes the line out to it.
        await dragBy(send, () => label('length'), { clientX: 200, clientY: 200 }, [-(1 + 30 * mm / 40) * 40 / mm, 0]);
        expect((annotationOf('length') as Linear).along).toBeLessThan(0);
        const line = hit('length'); expect(Math.min(sketchOf(line.start).x, sketchOf(line.end).x)).toBeLessThan(-5);
        await act(async () => currentSession.undo()); await act(async () => currentSession.undo()); expect(relations()).toEqual(lifted);
        await act(async () => currentSession.undo()); expect(relation('length')).toEqual(original); expect(currentDocument).toEqual(source);
      });

      it('keeps a still press a click, and cancels a drag on Escape with the selection kept', async () => {
        const source = await open(); const { send } = pointerSetup();
        // A press that moves no more than the point drag threshold selects.
        await dragBy(send, () => label('length'), { clientX: 200, clientY: 200 }, [3, 2]);
        expect(selectedDimensions()).toEqual(['length']); expect(currentDocument).toBe(source); expect(moving()).toBeNull();
        await send(label('diagonal'), 'pointerdown', { clientX: 200, clientY: 200 }, { button: 0, buttons: 1 });
        await send(label('diagonal'), 'pointermove', { clientX: 240, clientY: 230 }, { buttons: 1 });
        expect(moving()?.getAttribute('data-cad-sketch-dimension-moving')).toBe('diagonal');
        await act(async () => { label('diagonal').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
        expect(moving()).toBeNull(); expect(selectedDimensions()).toEqual(['length']);
        // Its release and click change nothing.
        await send(label('diagonal'), 'pointerup', { clientX: 240, clientY: 230 }, { button: 0, buttons: 0 }); await send(label('diagonal'), 'click', { clientX: 240, clientY: 230 }, { button: 0, detail: 1 });
        expect(currentDocument).toBe(source); expect(selectedDimensions()).toEqual(['length']); expect(currentSession.getSnapshot().canUndo).toBe(false);
      });

      it('resets the positions of the dimensions its menu acts on as one undo step, and keeps them through reference and driving', async () => {
        await open();
        const length = relation('length'), diagonal = relation('diagonal');
        await swap({ ...length, annotation: { kind: 'linear', offset: -8, along: .3 } } as typeof length); await swap({ ...diagonal, annotation: { kind: 'linear', offset: 6, along: .7 } } as typeof diagonal);
        const placed = relations();
        await press('size', 'ContextMenu');
        expect(menuItem('Reset position').disabled).toBe(true); expect(menuItem('Reset position').getAttribute('aria-description')).toBe('This dimension is already laid out automatically.');
        await canvasKey('Escape');
        await pick('length'); await pick('diagonal', true); await pick('size', true); await press('length', 'ContextMenu');
        await act(async () => menuItem('Reset 2 positions').click());
        expect([relation('length'), relation('diagonal')]).toEqual([length, diagonal]);
        await act(async () => currentSession.undo()); expect(relations()).toEqual(placed);
        // Becoming a reference and driving again keeps where it is drawn.
        await canvasKey('Escape'); await press('length', 'ContextMenu'); await act(async () => menuItem('Make reference').click());
        expect(relation('length')).toEqual({ id: 'length', kind: 'reference-dimension', measurement: { kind: 'line-length', entityId: 'base' }, annotation: { kind: 'linear', offset: -8, along: .3 } });
        await press('length', 'ContextMenu'); await act(async () => menuItem('Make driving').click());
        expect(relation('length')).toMatchObject({ kind: 'distance', annotation: { kind: 'linear', offset: -8, along: .3 } });
        await press('length', 'ContextMenu'); await act(async () => menuItem('Reset position').click());
        expect(annotationOf('length')).toBeUndefined();
      });
    });
    it('never replays a cancelled value editor when Escape later clears the selection', async () => {
      await open();
      let refocused = 0; const record = (event: FocusEvent) => { if (event.target instanceof Element && event.target.closest('form[data-cad-sketch-value-editor]')) refocused += 1; };
      const escapeFrom = (target: Element) => act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
      for (const from of ['body', 'tree'] as const) {
        await press('length', 'Enter'); await input(field('Length'), '45'); await click('Cancel');
        // Cancel closes the editor and keeps its dimension selected, mark and row alike.
        expect(valueEditor()).toBeNull(); expect(selectedDimensions()).toEqual(['length']); expect(relationRow('Distance relation 1').getAttribute('aria-pressed')).toBe('true');
        container.addEventListener('focusin', record);
        await escapeFrom(from === 'body' ? document.body : relationRow('Angle'));
        container.removeEventListener('focusin', record);
        expect(refocused).toBe(0); expect(valueEditor()).toBeNull(); expect(selectedDimensions()).toEqual([]);
        expect(relations().find(relation => relation.id === 'length')).toMatchObject({ value: 40 });
      }
    });

    it('keeps a tree row selected, or cleared, when an agent edit removes other relations', async () => {
      await open();
      await replace(current => [...current, { id: 'ay', kind: 'fixed-axis', pointId: 'a', axis: 'y', value: 0 }]);
      // A click on the H axis row selects its mark; a Shift click clears it again.
      const shiftClick = (row: HTMLElement) => act(async () => row.dispatchEvent(new MouseEvent('click', { button: 0, shiftKey: true, bubbles: true, cancelable: true })));
      await act(async () => relationRow('Coincident').click()); expect(relationRow('Coincident').getAttribute('aria-pressed')).toBe('true');
      await shiftClick(relationRow('Coincident')); expect(relationRow('Coincident').getAttribute('aria-pressed')).toBe('false');
      await act(async () => relationRow('Coincident').click());
      // An agent removes point c with what depends on it; the H axis row stays selected and nothing takes focus.
      let refocused = 0; const record = (event: FocusEvent) => { if (event.target instanceof Element && event.target.closest('[data-cad-sketch-relation-list], form[data-cad-sketch-value-editor]')) refocused += 1; };
      container.addEventListener('focusin', record);
      await act(async () => {
        const feature = currentDocument.features[0]; if (feature.kind !== 'sketch' || !feature.graph) throw new Error('Sketch missing.');
        replaceDocument({ ...currentDocument, features: [{ ...feature, graph: { ...feature.graph, points: feature.graph.points.filter(point => point.id !== 'c'),
          entities: feature.graph.entities.filter(entity => entity.id !== 'side'), relations: feature.graph.relations.filter(relation => !['diagonal', 'angle', 'measured'].includes(relation.id)) } }] });
      });
      container.removeEventListener('focusin', record);
      expect(relationRow('Coincident').getAttribute('aria-pressed')).toBe('true'); expect(refocused).toBe(0);
      expect(() => relationRow('Angle')).toThrow('missing');
    });

    it('never places a dimension whose picks Escape dropped, and opens no value editor for it', async () => {
      await open();
      await replace(current => current.filter(relation => relation.id !== 'measured'));
      await geometryMenu('side', 'Dimension');
      expect(pickInstruction()).toBe('Length · Click or press Enter to place; right-click for its horizontal or vertical distance · Or choose a second line, a point, a curve or an axis · Escape drops the picks');
      expect(valueEditor()).toBeNull();
      await canvasKey('Escape'); await canvasKey('Enter');
      expect(relations().map(relation => relation.id)).toEqual(['length', 'diagonal', 'angle', 'size', 'x']);
      // An Escape outside the canvas with nothing picked leaves the tool through the shared Escape, which places nothing either.
      await windowEscape(); expect(button('Dimension').getAttribute('aria-pressed')).toBe('false');
      await canvasKey('Enter'); expect(valueEditor()).toBeNull();
      expect(relations().map(relation => relation.id)).toEqual(['length', 'diagonal', 'angle', 'size', 'x']);
    });

    describe('relation glyphs', () => {
      const edge = (id: string, startPointId: string, endPointId: string) => ({ id, kind: 'line' as const, construction: false, startPointId, endPointId });
      /** A 40 × 20 plate: Horizontal and Vertical on its own edges, Parallel across it, X and Y held at 0 on one corner and a Length. */
      const plate = () => parseCadDocument({ ...createCadDocument(), schemaVersion: 2, features: [{ id: 'sketch', kind: 'sketch', name: 'Plate', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
        points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [40, 0] }, { id: 'c', position: [40, 20] }, { id: 'd', position: [0, 20] }],
        entities: [edge('bottom', 'a', 'b'), edge('right', 'b', 'c'), edge('top', 'c', 'd'), edge('left', 'd', 'a')],
        relations: [{ id: 'level', kind: 'horizontal', pointIds: ['a', 'b'] }, { id: 'upright', kind: 'vertical', pointIds: ['b', 'c'] }, { id: 'across', kind: 'parallel', lineIds: ['bottom', 'top'] },
          { id: 'fx', kind: 'fixed-axis', pointId: 'a', axis: 'x', value: 0 }, { id: 'fy', kind: 'fixed-axis', pointId: 'a', axis: 'y', value: 0 },
          { id: 'length', kind: 'distance', pointIds: ['a', 'b'], value: 40 }] } }] });
      const openPlate = (props?: Parameters<typeof mount>[1]) => open(props, plate());
      const glyphs = (id: string) => [...container.querySelectorAll<SVGGElement>('[data-cad-sketch-relation-glyph]')].filter(item => item.getAttribute('data-cad-sketch-relation-glyph')?.split(' ').includes(id));
      const glyph = (id: string) => { const found = glyphs(id)[0]; if (!found) throw new Error(`Glyph ${id} missing.`); return found; };
      const pointer = (target: Element, type: string, init: MouseEventInit = {}) => {
        const event = new MouseEvent(type, { button: 0, bubbles: true, cancelable: true, ...init }); Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } });
        target.dispatchEvent(event);
      };
      const press = (target: Element, shiftKey = false, detail = 1) => {
        pointer(target, 'pointerdown', { shiftKey, detail }); pointer(target, 'pointerup', { shiftKey, detail });
        target.dispatchEvent(new MouseEvent('click', { button: 0, detail, shiftKey, bubbles: true, cancelable: true }));
      };
      const clickGlyph = (id: string, shiftKey = false) => act(async () => press(glyph(id), shiftKey));
      const doubleClickGlyph = (id: string) => act(async () => {
        const target = glyph(id); press(target); press(target, false, 2); target.dispatchEvent(new MouseEvent('dblclick', { button: 0, detail: 2, bubbles: true, cancelable: true }));
      });
      const glyphKey = (id: string, key: string, shiftKey = false) => act(async () => { glyph(id).focus(); glyph(id).dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })); });
      const selectedGlyphs = () => [...new Set([...container.querySelectorAll('[data-cad-sketch-relation-glyph].is-selected')].map(item => item.getAttribute('data-cad-sketch-relation-glyph')))];
      const litGlyphs = () => [...container.querySelectorAll('[data-cad-highlight-glyph]')].map(item => item.getAttribute('data-cad-highlight-glyph'));
      const relationIds = () => relations().map(relation => relation.id);

      it('offers the selection\'s relations as an icon row that applies and removes them, and asks for no offers, analysis or render as the pointer moves', async () => {
        const onEditMany = vi.fn<CadWorkbenchProps['onEditMany']>(edits => currentSession.edit(edits));
        // An analysis that never answers counts the requests alone.
        const inspect = vi.fn<NonNullable<CadWorkbenchProps['onInspectSketchConstraints']>>(() => new Promise<never>(() => undefined));
        await openPlate({ build: null, buildState: 'idle', onEditMany, onInspectSketchConstraints: inspect });
        const row = () => container.querySelector<HTMLElement>('[data-cad-sketch-selection-actions]');
        const offer = (name: string) => { const found = row()?.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`); if (!found) throw new Error(`${name} offer missing.`); return found; };
        const parallels = () => relations().filter(relation => relation.kind === 'parallel' && relation.lineIds.includes('left'));
        expect(row()).toBeNull();
        offerRequests.mockClear();
        await act(async () => viewport().apply({ kind: 'select-sketch-geometry-set', selections: [{ kind: 'entity', id: 'right' }, { kind: 'entity', id: 'left' }] }));
        expect(row()?.getAttribute('role')).toBe('toolbar'); expect(row()?.getAttribute('aria-label')).toBe('Relations for the selection');
        expect([...row()!.querySelectorAll('button')].map(button => button.getAttribute('aria-label'))).toEqual(expect.arrayContaining(['Parallel', 'Perpendicular', 'Equal length', 'Dimension the selection']));
        expect(offer('Parallel').getAttribute('aria-pressed')).toBe('false');
        const asked = offerRequests.mock.calls.length; expect(asked).toBeGreaterThan(0);
        // Pointer moves over the canvas render it, never the workbench: no offers, analysis or preparation are asked for.
        const canvas = container.querySelector<SVGSVGElement>('[aria-label="Sketch drawing canvas"]')!, inspected = inspect.mock.calls.length;
        workbenchRenders = 0; canvasRenders.mockClear();
        for (const offset of [0, 7, 19, 40]) await act(async () => pointer(canvas, 'pointermove', { clientX: 200 + offset, clientY: 150 + offset }));
        expect(canvasRenders).toHaveBeenCalled(); expect(workbenchRenders).toBe(0);
        expect(offerRequests).toHaveBeenCalledTimes(asked); expect(inspect).toHaveBeenCalledTimes(inspected);
        // Parallel adds one relation through the edit path, and shows pressed; pressing it again removes that relation. While the edit is
        // judged the row stays in place, inactive, and the pressed button keeps focus, before and after.
        let release = () => undefined as void;
        onEditMany.mockImplementationOnce(edits => new Promise(resolve => { release = () => resolve(currentSession.edit(edits)); }));
        await act(async () => { offer('Parallel').focus(); offer('Parallel').click(); });
        expect(row()?.getAttribute('aria-busy')).toBe('true'); expect(document.activeElement).toBe(offer('Parallel'));
        expect([...row()!.querySelectorAll('button')].every(button => button.getAttribute('aria-disabled') === 'true')).toBe(true);
        await act(async () => offer('Perpendicular').click()); expect(onEditMany).toHaveBeenCalledOnce();
        await act(async () => release());
        expect(row()?.hasAttribute('aria-busy')).toBe(false); expect(document.activeElement).toBe(offer('Parallel'));
        expect(parallels()).toHaveLength(1); expect(offer('Parallel').getAttribute('aria-pressed')).toBe('true');
        const added = parallels()[0].id;
        await act(async () => offer('Parallel').click());
        expect(onEditMany.mock.lastCall?.[0]).toEqual([{ kind: 'remove-sketch-relation', sketchId: 'sketch', relationId: added }]);
        expect(parallels()).toEqual([]); expect(offer('Parallel').getAttribute('aria-pressed')).toBe('false');
        // Fix holds points, so an edge alone offers none; Escape on the row hands focus back to the canvas and keeps the selection.
        await act(async () => viewport().apply({ kind: 'select-sketch-geometry', selection: { kind: 'entity', id: 'top' } }));
        expect(row()!.querySelector('button[aria-label="Fix"]')).toBeNull();
        await act(async () => { offer('Dimension the selection').focus(); offer('Dimension the selection').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
        expect(document.activeElement).toBe(canvas); expect(geometry()).toEqual([{ kind: 'entity', id: 'top' }]);
        // Dimension starts the Dimension tool on the selection, and the row stays hidden while another tool draws.
        await act(async () => offer('Dimension the selection').click());
        expect(button('Dimension').getAttribute('aria-pressed')).toBe('true'); expect(row()).toBeNull();
        await canvasKey('Escape'); await canvasKey('Escape');
        await act(async () => viewport().apply({ kind: 'select-sketch-geometry', selection: { kind: 'entity', id: 'top' } })); expect(row()).not.toBeNull();
        await click('Line'); expect(row()).toBeNull();
      });

      it('marks every relation on the geometry it holds, names it by its operands and lights its geometry and sibling glyphs on hover without rendering the canvas', async () => {
        const source = await openPlate();
        expect([...container.querySelectorAll('[data-cad-sketch-relation-glyph]')].map(item => [item.getAttribute('data-cad-sketch-relation-glyph'), item.getAttribute('aria-label')])).toEqual([
          ['level', 'Horizontal: Point 1 and Point 2'], ['upright', 'Vertical: Point 2 and Point 3'],
          ['across', 'Parallel: Line 1 and Line 4'], ['across', 'Parallel: Line 1 and Line 4'], ['fx fy', 'Coincident: Point 1 and Origin']]);
        // The dimension keeps its own label and draws no glyph.
        expect(glyphs('length')).toEqual([]); expect(label('length')).not.toBeNull();
        canvasRenders.mockClear();
        await hover(glyphs('across')[0]);
        expect(highlighted('entity')).toEqual(['bottom', 'top']); expect(litGlyphs()).toEqual(['across', 'across']);
        await hover(glyphs('across')[0], false);
        expect(container.querySelector('[data-cad-sketch-highlight]')).toBeNull(); expect(litGlyphs()).toEqual([]);
        expect(canvasRenders).not.toHaveBeenCalled(); expect(currentDocument).toBe(source); expect(geometry()).toEqual([]);
      });

      it('selects with a click, toggles with Shift, clears with Escape and shares one selection with the dimensions', async () => {
        await openPlate();
        await act(async () => viewport().apply({ kind: 'select-sketch-geometry', selection: { kind: 'entity', id: 'left' } }));
        await clickGlyph('across');
        expect(geometry()).toEqual([]); expect(selectedGlyphs()).toEqual(['across']); expect(status()).toBe('Parallel selected · Delete removes');
        expect(glyphs('across').map(item => item.getAttribute('aria-pressed'))).toEqual(['true', 'true']); expect(highlighted('entity')).toEqual(['bottom', 'top']);
        await act(async () => label('length').dispatchEvent(new MouseEvent('click', { button: 0, shiftKey: true, detail: 1, bubbles: true, cancelable: true })));
        expect(status()).toBe('1 dimension and 1 relation selected · Delete removes them'); expect(selectedDimensions()).toEqual(['length']);
        await clickGlyph('fx', true); expect(status()).toBe('1 dimension and 3 relations selected · Delete removes them');
        await clickGlyph('across', true); expect(selectedGlyphs()).toEqual(['fx fy']);
        await clickGlyph('level'); expect(selectedGlyphs()).toEqual(['level']); expect(selectedDimensions()).toEqual([]); expect(status()).toBe('Horizontal selected · Delete removes');
        await glyphKey('fx', ' '); expect(status()).toBe('Coincident selected · Delete removes');
        await canvasKey('Escape'); expect(selectedGlyphs()).toEqual([]); expect(status()).toBeNull();
        // Escape on a focused glyph clears the selection too, and picking geometry takes the selection back.
        await clickGlyph('upright'); await glyphKey('upright', 'Escape'); expect(selectedGlyphs()).toEqual([]);
        await clickGlyph('upright'); await act(async () => viewport().apply({ kind: 'select-sketch-geometry', selection: { kind: 'entity', id: 'top' } }));
        expect(selectedGlyphs()).toEqual([]); expect(geometry()).toEqual([{ kind: 'entity', id: 'top' }]);
        expect(() => currentSession.assertWorkflowClosed()).not.toThrow();
      });

      it('deletes the selected relations and dimensions in one undoable edit, and a focused glyph\'s relations while nothing is selected', async () => {
        const onEditMany = vi.fn<CadWorkbenchProps['onEditMany']>(edits => currentSession.edit(edits));
        const source = await openPlate({ build: null, buildState: 'idle', onEditMany });
        await clickGlyph('across'); await act(async () => label('length').dispatchEvent(new MouseEvent('click', { button: 0, shiftKey: true, detail: 1, bubbles: true, cancelable: true })));
        await canvasKey('Delete');
        expect(onEditMany).toHaveBeenCalledOnce();
        expect(onEditMany.mock.calls[0][0]).toEqual([{ kind: 'remove-sketch-relation', sketchId: 'sketch', relationId: 'across' }, { kind: 'remove-sketch-relation', sketchId: 'sketch', relationId: 'length' }]);
        expect(relationIds()).toEqual(['level', 'upright', 'fx', 'fy']); expect(glyphs('across')).toEqual([]); expect(status()).toBeNull();
        await act(async () => currentSession.undo()); expect(currentDocument).toEqual(source); expect(glyphs('across')).toHaveLength(2);
        // Focus never selects: Backspace on the merged At the origin glyph removes both its relations, and focus returns to the canvas.
        await glyphKey('fx', 'Backspace');
        expect(onEditMany).toHaveBeenCalledTimes(2); expect(onEditMany.mock.calls[1][0]).toEqual([{ kind: 'remove-sketch-relation', sketchId: 'sketch', relationId: 'fx' }, { kind: 'remove-sketch-relation', sketchId: 'sketch', relationId: 'fy' }]);
        expect(relationIds()).toEqual(['level', 'upright', 'across', 'length']);
        expect(document.activeElement).toBe(container.querySelector('[aria-label="Sketch drawing canvas"]'));
      });

      it('keeps the selection and reports a refused removal in the relations list wording', async () => {
        await openPlate({ build: null, buildState: 'idle', onEditMany: edits => {
          const graph = plate().features[0];
          if (edits[0]?.kind === 'remove-sketch-relation' && graph.kind === 'sketch' && graph.graph) throw new CadSketchPreparationError({ sketchId: 'sketch', sketchName: 'Plate', graph: graph.graph,
            rejection: { kind: 'rejected', reason: 'failed', message: 'Solver gave up.', diagnostics: { status: 'failed', degreesOfFreedom: 1, conflictingIds: [], redundantIds: [], partiallyRedundantIds: [], issues: [] } } });
          currentSession.edit(edits);
        } });
        statusMessage.mockClear(); await clickGlyph('level'); await canvasKey('Delete');
        expect(statusMessage).toHaveBeenCalledWith(expect.stringContaining('Plate: The sketch solver could not solve this edit.'), 'error');
        expect(relationIds()).toContain('level'); expect(selectedGlyphs()).toEqual(['level']); expect(status()).toBe('Horizontal selected · Delete removes');
      });

      it('opens the relations list on its row from a double-click or Enter, and offers Show in relations list and Delete in its menu', async () => {
        const source = await openPlate();
        await doubleClickGlyph('across');
        expect(valueEditor()).toBeNull(); expect(relationRow('Parallel').getAttribute('aria-pressed')).toBe('true');
        // The relation stays the selection, mark and row alike.
        expect(selectedGlyphs()).toEqual(['across']); expect(geometry()).toEqual([]); expect(currentDocument).toBe(source);
        await canvasKey('Escape'); await canvasKey('Escape');
        await glyphKey('upright', 'Enter'); expect(relationRow('Vertical').getAttribute('aria-pressed')).toBe('true');
        await canvasKey('Escape'); await canvasKey('Escape');
        const canvas = container.querySelector<SVGSVGElement>('[aria-label="Sketch drawing canvas"]')!;
        vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, toJSON: () => ({}) });
        await glyphKey('fx', 'F10', true);
        expect(selectedGlyphs()).toEqual(['fx fy']);
        expect([...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent?.trim())).toEqual(['Show in relations list', 'Delete']);
        // A zero coordinate's row reads as the axis it holds the point on.
        await act(async () => menuItem('Show in relations list').click()); expect(relationRow('Coincident').getAttribute('aria-pressed')).toBe('true');
        await canvasKey('Escape'); await canvasKey('Escape');
        await glyphKey('level', 'ContextMenu'); await act(async () => menuItem('Delete').click());
        expect(relationIds()).toEqual(['upright', 'across', 'fx', 'fy', 'length']);
        expect(() => currentSession.assertWorkflowClosed()).not.toThrow();
      });

      const shiftClick = (target: Element) => act(async () => target.dispatchEvent(new MouseEvent('click', { button: 0, shiftKey: true, detail: 1, bubbles: true, cancelable: true })));
      const pressedRows = () => [...container.querySelectorAll('ul[aria-label="Sketch relations"] button[aria-pressed="true"]')].map(row => row.getAttribute('data-cad-sketch-relation-row'));
      const rowOf = (id: string) => { const found = container.querySelector<HTMLButtonElement>(`button[data-cad-sketch-relation-row="${id}"]`); if (!found) throw new Error(`Row ${id} missing.`); return found; };

      it('keeps drawn dimensions and the rows of relations the canvas does not draw in one selection that Shift extends either way, and deletes it as one undo step', async () => {
        const onEditMany = vi.fn<CadWorkbenchProps['onEditMany']>(edits => currentSession.edit(edits));
        const source = await openPlate({ build: null, buildState: 'idle', onEditMany });
        // With Show relations off, the Horizontal and Vertical relations are reached only through their tree rows.
        await act(async () => setCadPreferences({ ...getCadPreferences(), showRelations: false }));
        const removes = (...ids: string[]) => ids.map(relationId => ({ kind: 'remove-sketch-relation', sketchId: 'sketch', relationId }));
        // A dimension, then a row added with Shift.
        await act(async () => label('length').dispatchEvent(new MouseEvent('click', { button: 0, detail: 1, bubbles: true, cancelable: true })));
        await shiftClick(rowOf('level'));
        expect(selectedDimensions()).toEqual(['length']); expect(pressedRows()).toEqual(['level', 'length']);
        // A row, then a dimension added with Shift, then another row.
        await act(async () => rowOf('upright').click()); expect(selectedDimensions()).toEqual([]); expect(pressedRows()).toEqual(['upright']);
        await shiftClick(label('length')); expect(selectedDimensions()).toEqual(['length']); expect(pressedRows()).toEqual(['upright', 'length']);
        await shiftClick(rowOf('level')); expect(pressedRows()).toEqual(['level', 'upright', 'length']);
        // Shift on a selected row takes only that row out.
        await shiftClick(rowOf('upright')); expect(pressedRows()).toEqual(['level', 'length']); await shiftClick(rowOf('upright'));
        // Delete on the canvas removes the whole selection in one edit, and one undo brings it back.
        await canvasKey('Delete');
        expect(onEditMany).toHaveBeenCalledOnce(); expect(onEditMany.mock.calls[0][0]).toEqual(removes('length', 'level', 'upright'));
        expect(relationIds()).toEqual(['across', 'fx', 'fy']); expect(pressedRows()).toEqual([]);
        await act(async () => currentSession.undo()); expect(currentDocument).toEqual(source);
        // Delete on a selected row does the same.
        await act(async () => label('length').dispatchEvent(new MouseEvent('click', { button: 0, detail: 1, bubbles: true, cancelable: true })));
        await shiftClick(rowOf('upright'));
        await rowKey(rowOf('upright'), 'Delete');
        expect(onEditMany).toHaveBeenCalledTimes(2); expect(onEditMany.mock.calls[1][0]).toEqual(removes('length', 'upright'));
        await act(async () => currentSession.undo()); expect(currentDocument).toEqual(source);
        // So does the row's menu, which names everything it removes.
        await act(async () => rowOf('across').click()); await shiftClick(label('length'));
        await rowKey(rowOf('across'), 'ContextMenu');
        expect([...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent?.trim())).toContain('Delete 1 dimension and 1 relation');
        await act(async () => menuItem('Delete 1 dimension and 1 relation').click());
        expect(onEditMany).toHaveBeenCalledTimes(3); expect(onEditMany.mock.calls[2][0]).toEqual(removes('length', 'across'));
        await act(async () => currentSession.undo()); expect(currentDocument).toEqual(source);
        await act(async () => setCadPreferences({ ...getCadPreferences(), showRelations: true }));
      });

      it('keeps the marks of a sketch past the glyph limit, drawn or not, in one selection with its dimensions, and deletes them in one edit', async () => {
        const onEditMany = vi.fn<CadWorkbenchProps['onEditMany']>(edits => currentSession.edit(edits));
        // 51 squares with Horizontal and Vertical on each side: 204 marks, past the limit, so the canvas draws only the selection's. The
        // Width comes first, so its row is among those the list renders.
        const points: { id: string; position: [number, number] }[] = [], entities: ReturnType<typeof edge>[] = [];
        const held: { id: string; kind: 'horizontal' | 'vertical'; pointIds: [string, string] }[] = [];
        for (let square = 0; square < 51; square++) {
          const x = square % 10 * 14, y = Math.floor(square / 10) * 14, ids = ['a', 'b', 'c', 'd'].map(corner => `s${square}${corner}`);
          [[x, y], [x + 10, y], [x + 10, y + 10], [x, y + 10]].forEach(([px, py], corner) => points.push({ id: ids[corner], position: [px, py] }));
          ids.forEach((id, side) => {
            entities.push(edge(`s${square}e${side}`, id, ids[(side + 1) % 4]));
            held.push({ id: `s${square}r${side}`, kind: side % 2 ? 'vertical' : 'horizontal', pointIds: [id, ids[(side + 1) % 4]] });
          });
        }
        const capped = parseCadDocument({ ...createCadDocument(), schemaVersion: 2, features: [{ id: 'sketch', kind: 'sketch', name: 'Grid', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
          points, entities, relations: [{ id: 'width', kind: 'distance', pointIds: ['s0a', 's0b'], value: 10 }, ...held] } }] });
        await open({ build: null, buildState: 'idle', onEditMany }, capped);
        expect(glyphs('s0r1')).toEqual([]); expect(glyphs('s0r2')).toEqual([]);
        // The dimension, then a mark the canvas does not draw, added from its row.
        await act(async () => label('width').dispatchEvent(new MouseEvent('click', { button: 0, detail: 1, bubbles: true, cancelable: true })));
        await shiftClick(rowOf('s0r1'));
        expect(selectedDimensions()).toEqual(['width']); expect(pressedRows()).toEqual(['width', 's0r1']);
        // The other way: an undrawn mark's row, then the dimension added with Shift.
        await act(async () => rowOf('s0r2').click()); expect(pressedRows()).toEqual(['s0r2']);
        await shiftClick(label('width')); expect(pressedRows()).toEqual(['width', 's0r2']); expect(selectedDimensions()).toEqual(['width']);
        await shiftClick(rowOf('s0r1')); expect(pressedRows()).toEqual(['width', 's0r1', 's0r2']);
        await canvasKey('Delete');
        expect(onEditMany).toHaveBeenCalledOnce();
        expect(onEditMany.mock.calls[0][0].map(item => item.kind === 'remove-sketch-relation' ? item.relationId : item.kind).sort()).toEqual(['s0r1', 's0r2', 'width']);
        expect(relations().map(relation => relation.id)).not.toEqual(expect.arrayContaining(['s0r1']));
        await act(async () => currentSession.undo()); expect(currentDocument).toEqual(capped);
      });

      it('lists the relations under a collapsed heading that mounts no row, opens it to show a relation, and keeps it open for the next sketch', async () => {
        const second = plate().features[0];
        const source = parseCadDocument({ ...plate(), features: [...plate().features, { ...second, id: 'second', name: 'Second' }] });
        setCadPreferences({ ...getCadPreferences(), showOnPartDimensions: true });
        await mount(source); await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }));
        expect(relationsToggle()?.getAttribute('aria-expanded')).toBe('false'); expect(relationsToggle()?.textContent).toBe('Relations 6');
        expect(container.querySelector('[data-cad-sketch-relation-row]')).toBeNull();
        // Show in relations list opens it on the relation's row.
        const canvas = container.querySelector<SVGSVGElement>('[aria-label="Sketch drawing canvas"]')!;
        vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, toJSON: () => ({}) });
        await glyphKey('upright', 'F10', true); await act(async () => menuItem('Show in relations list').click());
        expect(relationsToggle()?.getAttribute('aria-expanded')).toBe('true'); expect(rowOf('upright').getAttribute('aria-pressed')).toBe('true');
        // Collapsed again, it unmounts its rows; Enter on a mark opens it on that mark's row.
        await canvasKey('Escape'); await act(async () => relationsToggle()!.click());
        expect(container.querySelector('[data-cad-sketch-relation-row]')).toBeNull();
        await glyphKey('across', 'Enter'); expect(relationsToggle()?.getAttribute('aria-expanded')).toBe('true'); expect(rowOf('across').getAttribute('aria-pressed')).toBe('true');
        // Left open, it stays open for the next sketch.
        await canvasKey('Escape'); await canvasKey('Escape');
        await click('Finish sketch'); await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'second' }));
        expect(relationsToggle()?.getAttribute('aria-expanded')).toBe('true'); expect(rowOf('level')).not.toBeNull();
      });

      it('lights the glyphs of a hovered relations list row and of the selected geometry', async () => {
        await openPlate();
        await act(async () => viewport().apply({ kind: 'select-sketch-geometry', selection: { kind: 'entity', id: 'bottom' } }));
        // Every mark of the bottom edge's relations lights, the Parallel's mark on the top edge too.
        expect([...container.querySelectorAll('[data-cad-sketch-relation-glyph].is-related')].map(item => item.getAttribute('data-cad-sketch-relation-glyph'))).toEqual(['level', 'across', 'across']);
        await geometryMenu('bottom', 'Constraints and dimensions');
        const row = relationRow('Parallel'), panel = row.closest('[data-cad-sketch-relation-list]')!;
        await act(async () => panel.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: row })));
        expect(litGlyphs()).toEqual(['across', 'across']); expect(highlighted('entity')).toEqual(['bottom', 'top']);
        await act(async () => row.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: panel })));
        expect(litGlyphs()).toEqual([]);
      });

      it('hides every glyph and drops a glyph selection when Show relations is off, keeping the dimensions', async () => {
        await openPlate();
        await clickGlyph('level'); await act(async () => label('length').dispatchEvent(new MouseEvent('click', { button: 0, shiftKey: true, detail: 1, bubbles: true, cancelable: true })));
        await act(async () => glyph('across').focus());
        await act(async () => setCadPreferences({ ...getCadPreferences(), showRelations: false }));
        expect(container.querySelector('[data-cad-sketch-relation-glyph]')).toBeNull();
        expect(selectedDimensions()).toEqual(['length']); expect(status()).toBe('Length selected · Double-click or Enter edits · Delete removes');
        expect(document.activeElement).toBe(container.querySelector('[aria-label="Sketch drawing canvas"]'));
        await act(async () => setCadPreferences({ ...getCadPreferences(), showRelations: true }));
        expect(glyphs('level')).toHaveLength(1); expect(selectedGlyphs()).toEqual([]);
      });

      it('keeps a selected glyph and drops a selected dimension when on-part dimensions are hidden, and shows and selects each without the other', async () => {
        const onEditMany = vi.fn<CadWorkbenchProps['onEditMany']>(edits => currentSession.edit(edits));
        await openPlate({ build: null, buildState: 'idle', onEditMany });
        await clickGlyph('level'); await act(async () => label('length').dispatchEvent(new MouseEvent('click', { button: 0, shiftKey: true, detail: 1, bubbles: true, cancelable: true })));
        await act(async () => setCadPreferences({ ...getCadPreferences(), showOnPartDimensions: false }));
        expect(container.querySelector('[data-cad-sketch-dimension]')).toBeNull(); expect(selectedDimensions()).toEqual([]);
        expect(selectedGlyphs()).toEqual(['level']); expect(status()).toBe('Horizontal selected · Delete removes');
        // With dimensions hidden, glyphs still select, open their row and delete.
        await clickGlyph('upright'); expect(selectedGlyphs()).toEqual(['upright']);
        await glyphKey('upright', 'Enter'); expect(relationRow('Vertical').getAttribute('aria-pressed')).toBe('true'); expect(selectedGlyphs()).toEqual(['upright']);
        await canvasKey('Escape'); await canvasKey('Escape');
        await clickGlyph('upright'); await canvasKey('Delete');
        expect(onEditMany.mock.lastCall?.[0]).toEqual([{ kind: 'remove-sketch-relation', sketchId: 'sketch', relationId: 'upright' }]); expect(glyphs('upright')).toEqual([]);
        // Both hidden, nothing is drawn or selected; dimensions shown again select without glyphs.
        await clickGlyph('level');
        await act(async () => setCadPreferences({ ...getCadPreferences(), showRelations: false }));
        expect(container.querySelector('[data-cad-sketch-relation-glyph]')).toBeNull(); expect(status()).toBeNull();
        await act(async () => setCadPreferences({ ...getCadPreferences(), showOnPartDimensions: true }));
        expect(selectedDimensions()).toEqual([]); expect(container.querySelector('[data-cad-sketch-relation-glyph]')).toBeNull();
        await act(async () => label('length').dispatchEvent(new MouseEvent('click', { button: 0, detail: 1, bubbles: true, cancelable: true })));
        expect(selectedDimensions()).toEqual(['length']); expect(status()).toBe('Length selected · Double-click or Enter edits · Delete removes');
        await act(async () => setCadPreferences({ ...getCadPreferences(), showRelations: true }));
      });

      it('marks a coordinate held at 0 with the Coincident symbol that the relations list and Constrain show, leaves one held away from 0 or by a parameter to its Distance, and marks the point Fix holds as Fixed', async () => {
        const onEditMany = vi.fn<CadWorkbenchProps['onEditMany']>(edits => currentSession.edit(edits));
        const axes = parseCadDocument({ ...createCadDocument(), schemaVersion: 2, parameters: { offset: 0 }, features: [{ id: 'sketch', kind: 'sketch', name: 'Plate', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
          points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [40, 0] }, { id: 'c', position: [40, 20] }, { id: 'd', position: [0, 20] }, { id: 'a2', position: [0, 0] }, { id: 'e', position: [20, 10] }],
          entities: [edge('bottom', 'a', 'b'), edge('right', 'b', 'c'), edge('top', 'c', 'd'), edge('left', 'd', 'a')],
          relations: [{ id: 'level', kind: 'fixed-axis', pointId: 'b', axis: 'y', value: 0 }, { id: 'ten', kind: 'fixed-axis', pointId: 'c', axis: 'x', value: 40 },
            { id: 'follows', kind: 'fixed-axis', pointId: 'd', axis: 'x', value: 'offset' }, { id: 'ox', kind: 'fixed-axis', pointId: 'a', axis: 'x', value: 0 },
            { id: 'join', kind: 'coincident', pointIds: ['a', 'a2'] }, { id: 'oy', kind: 'fixed-axis', pointId: 'a2', axis: 'y', value: 0 }] } }] });
        await open({ build: null, buildState: 'idle', onEditMany }, axes);
        const kind = (id: string) => glyph(id).getAttribute('data-cad-relation-glyph-kind'), paths = (element: Element | null | undefined) => [...element?.querySelectorAll('path') ?? []].map(path => path.getAttribute('d'));
        // X = 40, and X following a parameter that is 0, are Distance dimensions: drawn as labels, with no glyph.
        expect(label('ten')).not.toBeNull(); expect(label('follows')).not.toBeNull(); expect(glyphs('ten')).toEqual([]); expect(glyphs('follows')).toEqual([]);
        // Y = 0 keeps b on the H axis; X = 0 and Y = 0 on the joined a and a2 put them at the origin, one glyph for both.
        expect([...container.querySelectorAll('[data-cad-sketch-relation-glyph]')].map(item => [item.getAttribute('data-cad-sketch-relation-glyph'), item.getAttribute('aria-label')])).toEqual([
          ['level', 'Coincident: Point 2 and H axis'], ['ox oy', 'Coincident: Point 1 and Origin'], ['join', 'Coincident: Point 1 and Point 5']]);
        expect([kind('level'), kind('ox')]).toEqual(['coincident', 'coincident']);
        await clickGlyph('level'); expect(status()).toBe('Coincident selected · Delete removes');
        await glyphKey('level', 'Enter'); const row = relationRow('Coincident'); expect(row.getAttribute('aria-pressed')).toBe('true');
        // The list row and the Constrain menu's Coincident draw the same symbol.
        const listed = paths(row.querySelector('svg'));
        await click('Constrain'); expect(paths(menuItem('Coincident').querySelector('svg'))).toEqual(listed); expect(listed.length).toBeGreaterThan(0);
        await canvasKey('Escape'); await canvasKey('Escape'); await canvasKey('Escape');
        // Fix keeps a free point where it is with one fixed point, marked Fixed.
        await act(async () => viewport().apply({ kind: 'select-sketch-geometry', selection: { kind: 'point', id: 'e' } }));
        await click('Constrain');
        const fix = [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find(entry => entry.textContent?.trim() === 'Fix'); if (!fix) throw new Error('Fix missing.');
        await act(async () => fix.click());
        const fixed = relations().at(-1); expect(fixed).toEqual({ id: expect.any(String), kind: 'fixed-point', pointId: 'e', position: [20, 10] });
        expect(kind(fixed!.id)).toBe('fix'); expect(glyph(fixed!.id).getAttribute('aria-label')).toBe('Fixed point: Point 6');
      });

      it('takes no pointer events or focus with a drawing tool, a pending line chain or a geometry pick', async () => {
        await openPlate();
        const inert = () => [...container.querySelectorAll('[data-cad-sketch-relation-glyph]')].every(item => item.getAttribute('tabindex') === '-1' && item.getAttribute('pointer-events') === 'none');
        expect(inert()).toBe(false);
        await click('Line'); expect(inert()).toBe(true);
        await canvasClick(100, 300); await canvasClick(200, 300);
        expect(inert()).toBe(true); await clickGlyph('level'); expect(selectedGlyphs()).toEqual([]);
        await canvasKey('Escape'); await canvasKey('Escape'); expect(toolButton('Select').getAttribute('aria-pressed')).toBe('true'); expect(inert()).toBe(false);
        await click('Constrain');
        const parallel = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(entry => entry.textContent?.trim() === 'Parallel');
        if (!parallel) throw new Error('Parallel missing.'); await act(async () => parallel.click());
        expect(inert()).toBe(true); await clickGlyph('level'); expect(selectedGlyphs()).toEqual([]);
        await canvasKey('Escape'); expect(inert()).toBe(false);
        // Dimension keeps the placed dimensions interactive while it waits for its first pick, but never the glyphs, so its picks, preview
        // and placement click reach the geometry and canvas under them.
        await click('Dimension'); expect(inert()).toBe(true); expect(label('length').getAttribute('tabindex')).toBe('0');
        await clickGlyph('level'); expect(selectedGlyphs()).toEqual([]); expect(status()).toBeNull();
        await act(async () => keyboardPick(container.querySelector('[data-cad-sketch-entity="right"]')!));
        expect(inert()).toBe(true); await glyphKey('upright', 'Enter'); expect(selectedGlyphs()).toEqual([]); expect(valueEditor()).toBeNull();
        await canvasKey('Escape'); await canvasKey('Escape'); expect(toolButton('Select').getAttribute('aria-pressed')).toBe('true'); expect(inert()).toBe(false);
      });
    });
  });

  describe('Dimension tool placement', () => {
    type Extra = { readonly points?: readonly unknown[]; readonly entities?: readonly unknown[]; readonly relations?: readonly unknown[]; readonly parameters?: Readonly<Record<string, number>> };
    const plate = (extra: Extra = {}) => parseCadDocument({ ...createCadDocument(), schemaVersion: 2, ...extra.parameters ? { parameters: extra.parameters } : {}, features: [{ id: 'sketch', kind: 'sketch', name: 'Plate', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
      points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [40, 0] }, { id: 'c', position: [10, 20] }, { id: 'd', position: [40, 20] }, { id: 'o', position: [25, 12] }, ...extra.points ?? []],
      entities: [{ id: 'base', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' }, { id: 'top', kind: 'line', construction: false, startPointId: 'c', endPointId: 'd' },
        { id: 'hole', kind: 'circle', construction: false, centerPointId: 'o', radius: 3 }, ...extra.entities ?? []],
      relations: [...extra.relations ?? []] } }] });
    const open = async (onEditMany?: CadWorkbenchProps['onEditMany'], extra?: Extra) => {
      const source = plate(extra); await mount(source, { build: null, buildState: 'idle', ...onEditMany ? { onEditMany } : {} });
      await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }));
      return source;
    };
    const relations = () => { const feature = currentDocument.features[0]; if (feature.kind !== 'sketch' || !feature.graph) throw new Error('Sketch missing.'); return feature.graph.relations; };
    const pick = async (selector: string, shiftKey = false) => {
      const target = container.querySelector(selector); if (!target) throw new Error(`${selector} missing.`);
      await act(async () => keyboardPick(target, shiftKey));
    };
    const point = (id: string) => `[data-cad-sketch-point="${id}"]`, entity = (id: string) => `[data-cad-sketch-entity="${id}"]`, fixed = (id: string) => `[data-cad-sketch-fixed="${id}"]`;
    /** The rejection sketch preparation gives relations that over-define the sketch, here every relation the edit adds. */
    const overDefining = (edits: readonly CadEdit[], reason: 'redundant' | 'conflicting', ids?: readonly string[]) => {
      const feature = currentDocument.features[0]; if (feature.kind !== 'sketch' || !feature.graph) throw new Error('Sketch missing.');
      const added = edits.flatMap(edit => edit.kind === 'set-sketch-relation' ? [edit.relation] : []), subjects = ids ?? added.map(relation => relation.id);
      return new CadSketchPreparationError({ sketchId: 'sketch', sketchName: 'Plate', graph: { ...feature.graph, relations: [...feature.graph.relations, ...added] }, rejection: { kind: 'rejected', reason,
        message: 'Over-defined.', diagnostics: { status: 'failed', degreesOfFreedom: null, conflictingIds: reason === 'conflicting' ? subjects : [], redundantIds: reason === 'redundant' ? subjects : [], partiallyRedundantIds: [], issues: [] } } });
    };
    const settle = () => act(async () => new Promise(resolve => setTimeout(resolve, 5)));

    it('places a reference when a driving dimension would over-define the sketch, as one undo step', async () => {
      const edit = vi.fn<CadWorkbenchProps['onEditMany']>(edits => {
        if (edits.some(item => item.kind === 'set-sketch-relation' && item.relation.kind !== 'reference-dimension')) throw overDefining(edits, 'redundant');
        return currentSession.edit(edits);
      });
      const source = await open(edit);
      await click('Dimension'); await pick(entity('base')); await focusedKey('Enter');
      // Preparation rejected the driving length and left no history; the reference it placed instead is the only undo step, and the selection.
      expect(edit).toHaveBeenCalledTimes(2);
      expect(relations()).toEqual([{ id: expect.any(String), kind: 'reference-dimension', measurement: { kind: 'line-length', entityId: 'base' } }]);
      expect(statusMessage).toHaveBeenCalledWith('Placed as a reference: a driving dimension would over-define the sketch.', 'info');
      expect(pickInstruction()).toBe('Dimension placed · Enter or double-click edits it; choose geometry for the next one · Escape returns to Select');
      await act(async () => currentSession.undo()); expect(currentDocument).toEqual(source); expect(currentSession.getSnapshot().canUndo).toBe(false);
    });

    it('refuses an over-defining dimension with no reference form in the solver\'s own words, and keeps the picks', async () => {
      let refusal: Error | null = null;
      const edit = vi.fn<CadWorkbenchProps['onEditMany']>(edits => { refusal = overDefining(edits, 'conflicting'); throw refusal; });
      await open(edit);
      await click('Dimension'); await pick(point('a')); await pick(point('c')); await dimensionMenu('Horizontal distance');
      expect(edit).toHaveBeenCalledTimes(1); expect(relations()).toEqual([]);
      expect(statusMessage).toHaveBeenLastCalledWith(`Untitled part: ${(refusal as Error | null)?.message}`, 'error');
      expect(viewport().getState().selectedSketchGeometrySet).toEqual([{ kind: 'point', id: 'a' }, { kind: 'point', id: 'c' }]);
      expect(pickInstruction()).toMatch(/^Distance · Click or press Enter to place/); expect(() => currentSession.assertWorkflowClosed()).toThrow('Finish or cancel');
    });

    it('drops the relation a distance implies once preparation finds it redundant, and keeps the distance driving', async () => {
      const edit = vi.fn<CadWorkbenchProps['onEditMany']>(edits => {
        const parallel = edits.flatMap(item => item.kind === 'set-sketch-relation' && item.relation.kind === 'parallel' ? [item.relation.id] : []);
        if (parallel.length) throw overDefining(edits, 'redundant', parallel);
        return currentSession.edit(edits);
      });
      await open(edit);
      await click('Dimension'); await pick(entity('base')); await pick(entity('top')); await focusedKey('Enter');
      expect(edit).toHaveBeenCalledTimes(2);
      expect(relations()).toEqual([{ id: expect.any(String), kind: 'point-line-distance', pointId: 'c', lineId: 'base', side: 'left', value: 20 }]);
      expect(statusMessage).not.toHaveBeenCalledWith('Placed as a reference: a driving dimension would over-define the sketch.', 'info');
    });

    it('never places the fallback reference once another edit has changed the document during the placement', async () => {
      let calls = 0;
      const edit = vi.fn<CadWorkbenchProps['onEditMany']>(edits => {
        calls += 1; if (calls > 1) return currentSession.edit(edits);
        // Another edit lands while the solver is still working on this one, which it then rejects as over-defining.
        const error = overDefining(edits, 'redundant'); replaceDocument({ ...currentDocument, parameters: { agent: 1 } });
        return new Promise((_, reject) => setTimeout(() => reject(error), 0));
      });
      await open(edit);
      await click('Dimension'); await pick(entity('base')); await focusedKey('Enter'); await settle();
      expect(edit).toHaveBeenCalledTimes(1); expect(relations()).toEqual([]); expect(currentDocument.parameters).toEqual({ agent: 1 });
      expect(statusMessage).toHaveBeenLastCalledWith('Untitled part: The sketch changed before the dimension was placed. Pick the geometry again.', 'error');
      expect(button('Dimension').getAttribute('aria-pressed')).toBe('true'); expect(viewport().getState().selectedSketchGeometrySet).toEqual([]);
    });

    it('stops a placement in flight on Escape and keeps the picks, so nothing settles from it', async () => {
      const signals: AbortSignal[] = [];
      const edit = vi.fn<CadWorkbenchProps['onEditMany']>((_edits, signal) => new Promise((_, reject) => {
        if (signal) { signals.push(signal); signal.addEventListener('abort', () => reject(new DOMException('Aborted.', 'AbortError'))); }
      }));
      await open(edit);
      await click('Dimension'); await pick(entity('base')); await focusedKey('Enter');
      expect(edit).toHaveBeenCalledTimes(1); expect(pickInstruction()).toBe('Drawing is paused while another edit or operation is active.');
      await canvasKey('Escape'); await settle();
      expect(signals[0]?.aborted).toBe(true); expect(relations()).toEqual([]);
      expect(pickInstruction()).toBe('Length · Click or press Enter to place; right-click for its horizontal or vertical distance · Or choose a second line, a point, a curve or an axis · Escape drops the picks');
      expect(statusMessage).not.toHaveBeenCalledWith(expect.anything(), 'error');
    });

    it('applies a relation from the Dimension menu and leaves the tool on with nothing picked, listing what does not apply disabled with its reason', async () => {
      await open();
      await click('Dimension'); await pick(entity('base')); await pick(entity('top'));
      const items = await dimensionMenu(), item = (label: string) => items.find(entry => entry.textContent?.trim() === label);
      expect(items.map(entry => entry.textContent?.trim())).not.toContain('Swap location');
      
      expect(item('Angle')?.disabled).toBe(true); expect(item('Angle')?.getAttribute('aria-description')).toBe('These lines are parallel, so they have no angle.');
      expect(item('Place as reference')?.disabled).toBe(false); expect(item('Parallel')?.disabled).toBe(false);
      await act(async () => item('Parallel')!.click());
      expect(relations()).toEqual([{ id: expect.any(String), kind: 'parallel', lineIds: ['base', 'top'] }]);
      expect(button('Dimension').getAttribute('aria-pressed')).toBe('true'); expect(viewport().getState().selectedSketchGeometrySet).toEqual([]);
      expect(pickInstruction()).toBe('Dimension · Choose a line, arc, circle, point, the origin or an axis · Escape returns to Select');
      expect(() => currentSession.assertWorkflowClosed()).not.toThrow();
      // Its reference form is one more menu command away.
      await pick(point('o')); await pick(entity('base')); await dimensionMenu('Place as reference');
      expect(relations().at(-1)).toEqual({ id: expect.any(String), kind: 'reference-dimension', measurement: { kind: 'point-line-distance', pointId: 'o', lineId: 'base' } });
    });

    it('places an angle on lines whose corner is far beyond the sketch, drawn across their ends, then selected, counted and edited with Enter', async () => {
      setCadPreferences({ ...getCadPreferences(), showOnPartDimensions: true });
      // The lid's support meets the base's 1e6 mm to the left.
      await open(undefined, { points: [{ id: 'p', position: [0, 100] }, { id: 'q', position: [10, 100.001] }], entities: [{ id: 'lid', kind: 'line', construction: false, startPointId: 'p', endPointId: 'q' }] });
      await click('Dimension'); await pick(entity('base')); await pick(entity('lid')); await dimensionMenu('Angle');
      const angle = relations().find(relation => relation.kind === 'line-angle'); if (!angle) throw new Error('No angle placed.');
      const drawn = container.querySelector(`[data-cad-sketch-dimension="${angle.id}"]`);
      expect(drawn?.querySelector('path')).toBeNull(); expect(drawn?.querySelector('line.cad-sketch-graph-dimension-line')).not.toBeNull();
      expect(drawn?.classList.contains('is-selected')).toBe(true); expect(viewport().getState().view).toMatchObject({ onPartDimensionsVisible: true });
      await focusedKey('Enter'); expect(Number(field('Angle').value)).toBeGreaterThan(0);
    });

    // At 1e-7 their supports meet about 4e10 mm away, too far to place the corner reliably; at 1e-11 Parallel's own check holds them too.
    it.each([[1e-7, 'a hair from parallel'], [1e-11, 'that Parallel already holds']])('selects an existing angle between the base and a lid rising %s mm over 40 mm, %s, when it is placed again, drawn across their ends, and Enter edits it', async rise => {
      setCadPreferences({ ...getCadPreferences(), showOnPartDimensions: true });
      const value = Math.atan2(rise, 40) * 180 / Math.PI;
      await open(undefined, { points: [{ id: 'p', position: [0, 100] }, { id: 'q', position: [40, 100 + rise] }], entities: [{ id: 'lid', kind: 'line', construction: false, startPointId: 'p', endPointId: 'q' }],
        relations: [{ id: 'tilt', kind: 'line-angle', rays: [{ lineId: 'base', towardPointId: 'b' }, { lineId: 'lid', towardPointId: 'q' }], sense: 'ccw', value }] });
      await click('Dimension'); await pick(entity('base')); await pick(entity('lid')); await dimensionMenu('Angle');
      expect(statusMessage).toHaveBeenCalledWith('This is already dimensioned. Placing selects that dimension and moves it where the preview shows it.', 'info');
      expect(relations().map(relation => relation.id)).toEqual(['tilt']);
      const drawn = container.querySelector('[data-cad-sketch-dimension="tilt"]');
      expect(drawn?.querySelector('path')).toBeNull(); expect(drawn?.classList.contains('is-selected')).toBe(true);
      expect(viewport().getState().view).toMatchObject({ onPartDimensionsVisible: true });
      await focusedKey('Enter'); expect(Number(field('Angle').value)).toBeCloseTo(value, 12);
    });

    it('starts and ends from D, starts from selected plane references, and measures a line from an axis it runs along', async () => {
      const source = await open();
      const shortcut = () => act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true, cancelable: true })); });
      await shortcut(); expect(button('Dimension').getAttribute('aria-pressed')).toBe('true');
      await shortcut(); expect(button('Dimension').getAttribute('aria-pressed')).toBe('false');
      // A selected axis and point are the first picks, in either order.
      await pick(fixed('@h')); await pick(point('c'), true); await shortcut();
      expect(pickInstruction()).toBe('Distance · Click or press Enter to place · Right-click for more · Escape drops the picks');
      await focusedKey('Enter'); expect(relations()).toMatchObject([{ kind: 'fixed-axis', pointId: 'c', axis: 'y', value: 20 }]);
      await act(async () => currentSession.undo()); expect(currentDocument).toEqual(source);
      // A line, then an axis it runs along, keeps its distance from that axis and stays level with it; one across it takes its angle to it.
      // The axis takes no more picks and so loses its tab stop, which hands focus to the canvas, where Enter places.
      await pick(entity('top')); await pick(fixed('@h'));
      expect(container.querySelector(fixed('@h'))?.hasAttribute('tabindex')).toBe(false); expect(document.activeElement).toBe(container.querySelector('[aria-label="Sketch drawing canvas"]'));
      await focusedKey('Enter');
      expect(relations()).toEqual([{ id: expect.any(String), kind: 'fixed-axis', pointId: 'c', axis: 'y', value: 20 }, { id: expect.any(String), kind: 'horizontal', pointIds: ['c', 'd'] }]);
      await act(async () => currentSession.undo());
      await pick(entity('top')); await pick(fixed('@v')); await focusedKey('Enter');
      expect(relations()).toMatchObject([{ kind: 'line-angle', rays: [{ lineId: 'top' }, { lineId: '@v' }], value: 90 }]);
      await act(async () => currentSession.undo()); expect(currentDocument).toEqual(source);
    });

    it('reuses a dimension that already measures the picks and adds only the relation that keeps it, as one undo step', async () => {
      const reused = 'Already dimensioned: that dimension is selected, with the relation added that keeps it measuring these picks.';
      const selected = () => [...container.querySelectorAll('[data-cad-sketch-dimension].is-selected')].map(item => item.getAttribute('data-cad-sketch-dimension'));
      // One end of the top line is held from the H axis, so its other end could still move.
      const held = { id: 'held', kind: 'fixed-axis', pointId: 'c', axis: 'y', value: 20 };
      const edit = vi.fn<CadWorkbenchProps['onEditMany']>(edits => currentSession.edit(edits));
      let source = await open(edit, { relations: [held] });
      await click('Dimension'); await pick(entity('top')); await pick(fixed('@h')); await focusedKey('Enter');
      expect(edit).toHaveBeenCalledTimes(1);
      expect(relations()).toEqual([held, { id: expect.any(String), kind: 'horizontal', pointIds: ['c', 'd'] }]);
      expect(selected()).toEqual(['held']); expect(statusMessage).toHaveBeenLastCalledWith(reused, 'info');
      await act(async () => currentSession.undo()); expect(currentDocument).toEqual(source); expect(currentSession.getSnapshot().canUndo).toBe(false);
      // A distance from the base to an end of the top line keeps the gap only with Parallel; placing adds it and selects that distance.
      const gap = { id: 'gap', kind: 'point-line-distance', pointId: 'c', lineId: 'base', side: 'left', value: 20 };
      source = await open(edit, { relations: [gap] }); edit.mockClear();
      await click('Dimension'); await pick(entity('base')); await pick(entity('top')); await focusedKey('Enter');
      expect(edit).toHaveBeenCalledTimes(1); expect(relations()).toEqual([gap, { id: expect.any(String), kind: 'parallel', lineIds: ['base', 'top'] }]);
      expect(selected()).toEqual(['gap']); expect(statusMessage).toHaveBeenLastCalledWith(reused, 'info');
      // When the sketch already keeps the lines parallel some other way, nothing is added and the distance is selected.
      const redundant = vi.fn<CadWorkbenchProps['onEditMany']>(edits => { throw overDefining(edits, 'redundant'); });
      await open(redundant, { relations: [gap] });
      await click('Dimension'); await pick(entity('base')); await pick(entity('top')); await focusedKey('Enter');
      expect(redundant).toHaveBeenCalledTimes(1); expect(relations()).toEqual([gap]); expect(selected()).toEqual(['gap']);
      expect(statusMessage).toHaveBeenLastCalledWith('This is already dimensioned. Placing selects that dimension and moves it where the preview shows it.', 'info');
      expect(button('Dimension').getAttribute('aria-pressed')).toBe('true'); expect(() => currentSession.assertWorkflowClosed()).not.toThrow();
    });

    it('moves a dimension it reuses to the click, in the one edit that adds the relation keeping it', async () => {
      const gap = { id: 'gap', kind: 'point-line-distance', pointId: 'c', lineId: 'base', side: 'left', value: 20 };
      const edit = vi.fn<CadWorkbenchProps['onEditMany']>(edits => currentSession.edit(edits));
      const source = await open(edit, { relations: [gap] });
      const canvas = container.querySelector<SVGSVGElement>('[aria-label="Sketch drawing canvas"]'); if (!canvas) throw new Error('Sketch canvas missing.');
      vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, toJSON: () => ({}) });
      const view = viewport().getState().view; if (!view || view.mode === 'solid') throw new Error('Sketch frame missing.');
      const viewWidth = Number(canvas.getAttribute('viewBox')?.split(' ')[2]);
      await click('Dimension'); await pick(entity('base')); await pick(entity('top'));
      // The distance from c down to the base slides along the base to the click, 8 mm before c.
      for (const type of ['pointermove', 'pointerdown', 'pointerup']) await act(async () => {
        const event = new MouseEvent(type, { button: 0, buttons: type === 'pointerdown' ? 1 : 0, bubbles: true, cancelable: true,
          clientX: 300 + (2 - view.centerMm[0]) / viewWidth * 600, clientY: 200 - (10 - view.centerMm[1]) / view.heightSpanMm * 400 });
        Object.defineProperties(event, { pointerId: { value: 3 }, isPrimary: { value: true } }); canvas.dispatchEvent(event);
      });
      expect(edit).toHaveBeenCalledTimes(1);
      expect(relations()).toEqual([{ ...gap, annotation: { kind: 'linear', offset: expect.closeTo(-8, 6), along: .5 } }, { id: expect.any(String), kind: 'parallel', lineIds: ['base', 'top'] }]);
      const line = container.querySelector('[data-cad-sketch-dimension="gap"] .cad-sketch-graph-dimension-line');
      expect(Number(line?.getAttribute('x1')) + view.centerMm[0]).toBeCloseTo(2, 6); expect(Number(line?.getAttribute('x2')) + view.centerMm[0]).toBeCloseTo(2, 6);
      await act(async () => currentSession.undo()); expect(currentDocument).toEqual(source); expect(currentSession.getSnapshot().canUndo).toBe(false);
    });
    describe('from the origin', () => {
      const one = 'Dimension placed · Enter or double-click edits it; choose geometry for the next one · Escape returns to Select';
      const selected = () => [...container.querySelectorAll('[data-cad-sketch-dimension].is-selected')].map(item => item.getAttribute('data-cad-sketch-dimension'));
      const coordinate = (pointId: string, axis: 'x' | 'y') => relations().find(relation => relation.kind === 'fixed-axis' && relation.pointId === pointId && relation.axis === axis)?.id;
      // e sits on the V axis, and c has no coordinate of zero.
      const posts = (relations: readonly unknown[] = [], parameters?: Readonly<Record<string, number>>) => ({ points: [{ id: 'e', position: [0, 20] }], entities: [{ id: 'stub', kind: 'line', construction: false, startPointId: 'e', endPointId: 'c' }], relations, parameters });
      const place = async (picks: readonly string[], relations?: readonly unknown[], parameters?: Readonly<Record<string, number>>) => {
        await open(undefined, posts(relations, parameters)); await click('Dimension');
        for (const target of picks) await pick(target);
        statusMessage.mockClear(); await focusedKey('Enter');
      };

      const existing = 'This is already dimensioned. Placing selects that dimension and moves it where the preview shows it.';

      it('measures a point from the origin as a distance in either pick order, and Enter edits it', async () => {
        for (const picks of [[fixed('@origin'), point('c')], [point('c'), fixed('@origin')]]) {
          await place(picks);
          expect(relations()).toEqual([{ id: expect.any(String), kind: 'distance', pointIds: expect.arrayContaining(['@origin', 'c']), value: Math.hypot(10, 20) }]);
          expect(selected()).toEqual([relations()[0].id]); expect(pickInstruction()).toBe(one); expect(statusMessage).not.toHaveBeenCalled();
          await canvasKey('Enter'); expect(Number(field('Distance').value)).toBeCloseTo(Math.hypot(10, 20), 9);
        }
      });

      it('holds the coordinate a horizontal or vertical distance from the origin measures, and selects one the point keeps already', async () => {
        await open(undefined, posts()); await click('Dimension'); await pick(point('c')); await pick(fixed('@origin'));
        statusMessage.mockClear(); await dimensionMenu('Horizontal distance');
        expect(relations()).toEqual([{ id: expect.any(String), kind: 'fixed-axis', pointId: 'c', axis: 'x', value: 10 }]);
        expect(selected()).toEqual([coordinate('c', 'x')]); expect(statusMessage).not.toHaveBeenCalled();
        await canvasKey('Enter'); expect(field('Distance').value).toBe('10');
        const high = { id: 'high', kind: 'fixed-axis', pointId: 'e', axis: 'y', value: 20 };
        await open(undefined, posts([high])); await click('Dimension'); await pick(fixed('@origin')); await pick(point('e'));
        statusMessage.mockClear(); await dimensionMenu('Vertical distance');
        expect(relations()).toEqual([high]); expect(selected()).toEqual(['high']); expect(statusMessage).toHaveBeenLastCalledWith(existing, 'info');
        await canvasKey('Enter'); expect(field('Distance').value).toBe('20');
      });

      it('selects and draws a coordinate that follows a parameter at 0', async () => {
        // The horizontal distance is the kept dimension at 0, not a relation that keeps e on the V axis.
        const offset = { id: 'offset', kind: 'fixed-axis', pointId: 'e', axis: 'x', value: 'offset' };
        await open(undefined, posts([offset], { offset: 0 })); await click('Dimension'); await pick(point('e')); await pick(fixed('@origin'));
        statusMessage.mockClear(); await dimensionMenu('Horizontal distance');
        expect(relations()).toEqual([offset]); expect(selected()).toEqual(['offset']); expect(statusMessage).toHaveBeenLastCalledWith(existing, 'info');
        expect(container.querySelector('[data-cad-sketch-dimension="offset"] [role="button"]')?.getAttribute('aria-label')).toBe('Dimension distance 0 mm, press Enter to edit');
        expect(viewport().getState().view).toMatchObject({ onPartDimensionsVisible: true });
        await canvasKey('Enter'); expect(field('Distance').value).toBe('0');
      });

      it('gives a point at the origin, or on an axis, no distance from it along that axis, and says why', async () => {
        // a sits at the origin, so it has no distance from it; Coincident keeps it there.
        await place([fixed('@origin'), point('a')]);
        expect(relations()).toEqual([]); expect(selected()).toEqual([]); expect(button('Dimension').getAttribute('aria-pressed')).toBe('true');
        expect(statusMessage).toHaveBeenLastCalledWith('Untitled part: This point is at the origin, so it has no distance from it. Use Coincident to keep it there.', 'error');
        // e sits on the V axis, so its horizontal distance from the origin is refused in the menu.
        await open(undefined, posts()); await click('Dimension'); await pick(point('e')); await pick(fixed('@origin'));
        const horizontal = (await dimensionMenu())?.find(item => item.textContent?.trim() === 'Horizontal distance');
        expect(horizontal?.disabled).toBe(true); expect(relations()).toEqual([]);
        // The picks are kept for another form.
        expect(() => currentSession.assertWorkflowClosed()).toThrow('Finish or cancel');
      });
    });

    it('takes Enter, Escape and Delete from the geometry the picks leave focused, and hands focus to the canvas once it places', async () => {
      await open();
      const canvas = container.querySelector('[aria-label="Sketch drawing canvas"]'), top = container.querySelector<SVGGElement>(entity('top'));
      // Two lines leave nothing more to pick, so the focused one passes its keys on: Escape drops the picks, and Enter places their distance.
      await click('Dimension'); await pick(entity('base')); await pick(entity('top'));
      expect(document.activeElement).toBe(top); expect(top?.getAttribute('aria-disabled')).toBe('true');
      await focusedKey('Escape'); expect(pickInstruction()).toBe('Dimension · Choose a line, arc, circle, point, the origin or an axis · Escape returns to Select');
      await pick(entity('base')); await pick(entity('top')); await focusedKey('Enter');
      expect(relations()).toEqual([{ id: expect.any(String), kind: 'point-line-distance', pointId: 'c', lineId: 'base', side: 'left', value: 20 },
        { id: expect.any(String), kind: 'parallel', lineIds: ['base', 'top'] }]);
      // As after a click on empty space, focus is on the canvas, so the next Enter edits the placed distance rather than picking the line.
      expect(document.activeElement).toBe(canvas); expect(pickInstruction()).toMatch(/^Dimension placed · Enter or double-click edits it/);
      // An edge the tool would pick still leaves Delete to the placed dimension, since the tool deletes no geometry.
      await act(async () => top?.focus()); await focusedKey('Delete');
      expect(relations()).toEqual([{ id: expect.any(String), kind: 'parallel', lineIds: ['base', 'top'] }]); expect(currentDocument.features[0]).toMatchObject({ graph: { entities: [{ id: 'base' }, { id: 'top' }, { id: 'hole' }] } });
    });

    it('places the reference of a zero distance from the menu, where a click gives the driving reason', async () => {
      // A point lying on the base line, a point at the top line's end position, and a slanted line.
      await open(undefined, { points: [{ id: 'on', position: [20, 0] }, { id: 'twin', position: [40, 20] }], entities: [{ id: 'slope', kind: 'line', construction: false, startPointId: 'a', endPointId: 'd' }] });
      await click('Dimension'); await pick(point('on')); await pick(entity('base'));
      expect(pickInstruction()).toBe('Dimension · The point lies on the line. Use Point on line to keep it there. · Right-click to place it as a reference · Escape drops the picks');
      await focusedKey('Enter');
      expect(statusMessage).toHaveBeenLastCalledWith('Untitled part: The point lies on the line. Use Point on line to keep it there.', 'error'); expect(relations()).toEqual([]);
      const items = await dimensionMenu(), item = (label: string) => items.find(entry => entry.textContent?.trim() === label);
      expect(item('Place as reference')?.disabled).toBe(false); expect(item('Distance')?.disabled).toBe(true);
      await act(async () => item('Place as reference')!.click());
      expect(relations()).toEqual([{ id: expect.any(String), kind: 'reference-dimension', measurement: { kind: 'point-line-distance', pointId: 'on', lineId: 'base' } }]);
      expect(statusMessage).not.toHaveBeenCalledWith('Placed as a reference: a driving dimension would over-define the sketch.', 'info');
      // Two distinct points at one position.
      await pick(point('d')); await pick(point('twin')); await dimensionMenu('Place as reference');
      expect(relations().at(-1)).toEqual({ id: expect.any(String), kind: 'reference-dimension', measurement: { kind: 'point-distance', pointIds: ['d', 'twin'] } });
      // One slanted line places its length; its horizontal and vertical distances are in the menu by name.
      await pick(entity('slope')); await dimensionMenu('Horizontal distance');
      expect(relations().at(-1)).toMatchObject({ kind: 'axis-distance', pointIds: ['a', 'd'], axis: 'x', value: 40 });
      await pick(entity('slope')); await focusedKey('Enter');
      expect(relations().at(-1)).toMatchObject({ kind: 'distance', pointIds: ['a', 'd'], value: Math.hypot(40, 20) });
    });
  });

  it('picks two points after Dimension without moving geometry, drops the picks on Escape and places the exact ordered axis driver', async () => {
    const source = parseCadDocument({ ...createCadDocument(), schemaVersion: 2, features: [{ id: 'sketch', kind: 'sketch', name: 'Bore layout',
      suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: { points: [{ id: 'origin', position: [' 0 ', '0'] }, { id: 'center', position: [18, 12] }],
        entities: [{ id: 'outer', kind: 'circle', centerPointId: 'origin', radius: ' 50 ', construction: true },
          { id: 'bore', kind: 'circle', centerPointId: 'center', radius: ' 4 ', construction: false }], relations: [] } }] });
    await mount(source); await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }));
    const point = (id: string) => {
      const element = container.querySelector(`[data-cad-sketch-point="${id}"]`); if (!element) throw new Error('Point missing.');
      return element;
    };
    const pick = async (id: string) => act(async () => keyboardPick(point(id)));
    const accepted = currentSession.getSnapshot(); await click('Line'); await click('Dimension');
    // Dimension takes over from Line and holds nothing until its first pick.
    expect(toolButton('Line').getAttribute('aria-pressed')).toBe('false'); expect(button('Finish sketch').disabled).toBe(false);
    await pick('origin'); expect(button('Finish sketch').disabled).toBe(true);
    expect(viewport().getState().selectedSketchGeometrySet).toEqual([{ kind: 'point', id: 'origin' }]);
    expect(currentDocument).toBe(source); expect(() => currentSession.assertWorkflowClosed()).toThrow('Finish or cancel');
    await pick('origin'); expect(viewport().getState().selectedSketchGeometrySet).toHaveLength(1);
    await act(async () => point('origin').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })));
    expect(currentDocument).toBe(source); await canvasKey('Escape');
    expect(currentSession.getSnapshot()).toEqual(accepted); expect(viewport().getState().selectedSketchGeometrySet).toEqual([]);
    expect(button('Dimension').getAttribute('aria-pressed')).toBe('true');
    await pick('origin'); await pick('center');
    expect(viewport().getState().selectedSketchGeometrySet).toEqual([{ kind: 'point', id: 'origin' }, { kind: 'point', id: 'center' }]);
    expect(currentDocument).toBe(source); await dimensionMenu('Horizontal distance');
    expect(container.querySelector('[role=alert]')?.textContent ?? '').toBe('');
    expect(currentDocument.features[0]).toMatchObject({ graph: { points: source.features[0].kind === 'sketch' ? source.features[0].graph?.points : [],
      relations: [{ kind: 'axis-distance', axis: 'x', pointIds: ['origin', 'center'], value: 18 }] } });
    expect(currentSession.getSnapshot().canUndo).toBe(true); expect(() => currentSession.assertWorkflowClosed()).not.toThrow();
  });

  it('drops pending Dimension picks on a new source and places an arc radius when the arc is picked again', async () => {
    const source = parseCadDocument({ ...createCadDocument(), schemaVersion: 2, features: [{ id: 'sketch', kind: 'sketch', name: 'Arc guide',
      suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: { points: [{ id: 'center', position: [' 0 ', '0'] },
        { id: 'start', position: [5, 0] }, { id: 'end', position: [0, 5] }], entities: [
        { id: 'arc', kind: 'arc', centerPointId: 'center', startPointId: 'start', endPointId: 'end', direction: 'ccw', construction: true }], relations: [] } }] });
    await mount(source); await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }));
    await click('Dimension'); expect(() => currentSession.assertWorkflowClosed()).not.toThrow();
    const center = container.querySelector('[data-cad-sketch-point="center"]'); if (!center) throw new Error('Center missing.');
    await act(async () => keyboardPick(center));
    expect(viewport().getState().selectedSketchGeometrySet).toEqual([{ kind: 'point', id: 'center' }]); expect(() => currentSession.assertWorkflowClosed()).toThrow('Finish or cancel');
    const changed = { ...source, parameters: { newDriver: 3 } };
    await act(async () => replaceDocument(changed));
    // The picks belonged to the old version, so they go; the tool stays on for new ones.
    expect(currentDocument).toEqual(changed); const replaced = currentDocument; expect(() => currentSession.assertWorkflowClosed()).not.toThrow();
    expect(viewport().getState().selectedSketchGeometrySet).toEqual([]);
    expect(pickInstruction()).toBe('Dimension · Choose a line, arc, circle, point, the origin or an axis · Escape returns to Select');
    const arc = container.querySelector('[data-cad-sketch-entity="arc"]'); if (!arc) throw new Error('Arc missing.');
    // An arc previews its radius and still takes a point, a line, a second curve or an axis; picking it again places the radius.
    await act(async () => keyboardPick(arc));
    expect(pickInstruction()).toBe('Radius · Click or press Enter to place · Or choose a point, a line, another curve, the origin or an axis · Escape drops the picks');
    await act(async () => keyboardPick(arc));
    expect(currentDocument.features[0]).toMatchObject({ graph: { relations: [{ kind: 'radial-size', entityId: 'arc', quantity: 'radius', value: 5 }] } });
    expect(currentSession.getSnapshot().canUndo).toBe(true);
    await act(async () => currentSession.undo()); expect(currentDocument).toEqual(replaced);
  });

  it('opens graph context Dimension on its actual target and moves the retained selected set through the existing editors', async () => {
    const source = parseCadDocument({ ...createCadDocument('Menu layout'), schemaVersion: 2, features: [{
      id: 'sketch', kind: 'sketch', name: 'Menu layout', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
        points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [20, 0] }], entities: [
          { id: 'first', kind: 'circle', construction: false, centerPointId: 'a', radius: 3 },
          { id: 'second', kind: 'circle', construction: false, centerPointId: 'b', radius: 3 }], relations: []
      }
    }] });
    await mount(source); await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }));
    const canvas = container.querySelector<SVGSVGElement>('[aria-label="Sketch drawing canvas"]'); if (!canvas) throw new Error('Canvas missing.');
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, toJSON: () => ({}) });
    const edge = (id: string) => { const found = container.querySelector<SVGGElement>(`[data-cad-sketch-entity="${id}"]`); if (!found) throw new Error('Missing graph edge.'); return found; };
    const key = async (id: string, key: string, shiftKey = false) => act(async () => {
      const target = edge(id); target.focus(); target.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
    });
    const menu = async (label: string) => act(async () => {
      const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === label);
      if (!item) throw new Error(`${label} menu item missing.`); item.click();
    });
    await key('first', 'Enter'); const before = currentSession.getSnapshot();
    await key('second', 'F10', true);
    const dimensionItem = document.querySelector<HTMLButtonElement>('[role="menuitem"]'); if (!dimensionItem) throw new Error('Menu missing.');
    await act(async () => dimensionItem.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(edge('second')); expect(currentSession.getSnapshot()).toEqual(before);
    await key('second', 'F10', true); await menu('Dimension');
    expect(viewport().getState().selectedSketchGeometrySet).toEqual([{ kind: 'entity', id: 'second' }]);
    expect(pickInstruction()).toBe('Diameter · Click or press Enter to place · Or choose a point, a line, another curve, the origin or an axis · Escape drops the picks');
    expect(currentDocument).toBe(before.document);
    await canvasKey('Escape'); await canvasKey('Escape'); expect(currentDocument).toBe(before.document);
    await key('second', 'F10', true); await menu('Dimension'); await focusedKey('Enter');
    const dimensioned = currentDocument.features[0];
    expect(dimensioned).toMatchObject({ graph: { relations: [{ kind: 'radial-size', entityId: 'second', quantity: 'diameter', value: 6 }] } });
    // Escape leaves the tool; the circles then take the selection again.
    await canvasKey('Escape'); await key('second', 'Enter');
    await key('first', 'Enter', true); const selected = viewport().getState().selectedSketchGeometrySet, original = currentDocument;
    expect(selected).toEqual([{ kind: 'entity', id: 'second' }, { kind: 'entity', id: 'first' }]);
    await key('second', 'F10', true); await menu('Move selection');
    const moveX = container.querySelector<HTMLInputElement>('[aria-label="Move X"]'); if (!moveX) throw new Error('Move field missing.');
    await input(moveX, '5'); await click('Cancel'); expect(currentDocument).toBe(original);
    expect(viewport().getState().selectedSketchGeometrySet).toEqual(selected);
    await key('first', 'F10', true); await menu('Move selection');
    const nextX = container.querySelector<HTMLInputElement>('[aria-label="Move X"]'); if (!nextX) throw new Error('Move field missing.');
    await input(nextX, '5'); await click('Apply');
    expect(currentDocument.features[0]).toEqual({ ...dimensioned, graph: { ...(dimensioned.kind === 'sketch' ? dimensioned.graph : {}),
      points: [{ id: 'a', position: [5, 0] }, { id: 'b', position: [25, 0] }] } });
    await act(async () => currentSession.undo()); expect(currentDocument).toEqual(original);
  });

  it('places the same angle from a preselection and from the context menu for a linked guide and a free line', async () => {
    const base = parseCadDocument({ ...createCadDocument(), schemaVersion: 2, features: [
      { id: 'layout', kind: 'sketch', name: 'Layout', plane: 'XY', offset: 0, suppressed: false, profiles: [], graph: {
        points: [{ id: 'a', position: ['0', '0'] }, { id: 'b', position: ['20', '0'] }],
        entities: [{ id: 'guide', kind: 'line', construction: true, startPointId: 'a', endPointId: 'b' }], relations: [] } },
      { id: 'target', kind: 'sketch', name: 'Target', plane: 'XY', offset: 0, suppressed: false, profiles: [], graph: {
        points: [{ id: 'u', position: [0, 0] }, { id: 'v', position: [10, 10] }],
        entities: [{ id: 'free', kind: 'line', construction: false, startPointId: 'u', endPointId: 'v' }], relations: [] } },
    ] });
    const source = applyCadEdits(base, [{ kind: 'use-sketch-entity', sketchId: 'target', sourceSketchId: 'layout', sourceEntityId: 'guide', idPrefix: 'ref' }]);
    await mount(source); await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'target' }));
    const both = () => act(async () => viewport().apply({ kind: 'select-sketch-geometry-set', selections: [{ kind: 'entity', id: 'ref_e0' }, { kind: 'entity', id: 'free' }] }));
    const placed = () => {
      const target = currentDocument.features[1], original = source.features[1];
      if (target.kind !== 'sketch' || original.kind !== 'sketch' || !target.graph || !original.graph) throw new Error('Target missing.');
      expect(currentDocument.features[0]).toEqual(source.features[0]); expect(target.graph.points).toEqual(original.graph.points); expect(target.graph.entities).toEqual(original.graph.entities);
      expect(target.graph.relations).toEqual([...original.graph.relations, expect.objectContaining({ kind: 'line-angle', value: 45 })]);
    };
    await both(); expect(button('Dimension').disabled).toBe(false); await click('Dimension');
    expect(pickInstruction()).toBe('Angle · Click or press Enter to place; the pointer chooses the angle · Right-click for more · Escape drops the picks');
    await canvasKey('Enter'); placed();
    // Picking the same lines again finds that angle, which placing moves within its own sector.
    await canvasKey('Escape'); await canvasKey('Escape'); await both(); await click('Dimension');
    expect(pickInstruction()).toBe('Angle · Click or press Enter to place; this moves the existing angle within its own sector · Right-click for more · Escape drops the picks');
    await canvasKey('Escape'); await canvasKey('Escape');
    await act(async () => currentSession.undo()); expect(currentDocument).toEqual(source);
    await canvasKey('Escape'); await both();
    const canvas = container.querySelector<SVGSVGElement>('[aria-label="Sketch drawing canvas"]'), free = container.querySelector<SVGGElement>('[data-cad-sketch-entity="free"]');
    if (!canvas || !free) throw new Error('Line canvas missing.');
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, toJSON: () => ({}) });
    await act(async () => { free.focus(); free.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })); });
    const action = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === 'Dimension');
    if (!action) throw new Error('Dimension action missing.'); expect(action.disabled).toBe(false);
    await act(async () => action.click()); await canvasKey('Enter'); placed();
    await act(async () => currentSession.undo()); expect(currentDocument).toEqual(source);
  });

  it('keeps a chosen constraint tool active, guides its picks and commits one relation per completed pick', async () => {
    const source = parseCadDocument({ ...createCadDocument(), schemaVersion: 2, features: [{ id: 'sketch', kind: 'sketch', name: 'Lines', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
      points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [20, 2] }, { id: 'c', position: [0, 10] }, { id: 'd', position: [20, 12] }, { id: 'p', position: [5, 30] }, { id: 'q', position: [25, 30] }],
      entities: [{ id: 'first', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' }, { id: 'second', kind: 'line', construction: false, startPointId: 'c', endPointId: 'd' },
        { id: 'third', kind: 'line', construction: false, startPointId: 'p', endPointId: 'q' }],
      relations: [] } }] });
    await mount(source); await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }));
    const pick = async (selector: string) => {
      const target = container.querySelector(selector); if (!target) throw new Error(`${selector} missing.`);
      await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    };
    const choose = async (label: string) => {
      await click('Constrain');
      const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(entry => entry.textContent?.trim() === label);
      if (!item) throw new Error(`${label} missing.`); await act(async () => item.click());
    };
    await choose('Parallel'); expect(button('Constrain').getAttribute('aria-pressed')).toBe('true');
    expect(container.textContent).toContain('Parallel · Choose a line');
    await pick('[data-cad-sketch-point="p"]'); expect(viewport().getState().selectedSketchGeometrySet).toEqual([]);
    await pick('[data-cad-sketch-entity="first"]'); expect(currentDocument).toBe(source);
    expect(viewport().getState().selectedSketchGeometrySet).toEqual([{ kind: 'entity', id: 'first' }]);
    await pick('[data-cad-sketch-entity="second"]');
    const sketch = () => { const feature = currentDocument.features[0]; if (feature.kind !== 'sketch' || !feature.graph) throw new Error('Sketch missing.'); return feature.graph; };
    expect(sketch().relations).toEqual([expect.objectContaining({ kind: 'parallel', lineIds: ['first', 'second'] })]);
    expect(button('Constrain').getAttribute('aria-pressed')).toBe('true'); expect(viewport().getState().selectedSketchGeometrySet).toEqual([]);
    // The same pair again is explained instead of duplicated.
    await pick('[data-cad-sketch-entity="first"]'); await pick('[data-cad-sketch-entity="second"]');
    expect(statusMessage).toHaveBeenLastCalledWith(expect.stringContaining('Parallel is already applied here.'), 'error'); expect(sketch().relations).toHaveLength(1);
    await choose('Horizontal'); await pick('[data-cad-sketch-entity="third"]');
    expect(sketch().relations.at(-1)).toMatchObject({ kind: 'horizontal', pointIds: ['p', 'q'] });
    // The plane's own axes and origin take part only while a tool accepts them. The test session applies relations without solving, so the picks already agree.
    await choose('Coincident'); await pick('[data-cad-sketch-point="c"]');
    expect(container.querySelector('[data-cad-sketch-fixed="@origin"]')?.getAttribute('role')).toBe('button');
    await pick('[data-cad-sketch-fixed="@v"]');
    expect(sketch().relations.at(-1)).toMatchObject({ kind: 'fixed-axis', pointId: 'c', axis: 'x', value: 0 });
    await pick('[data-cad-sketch-fixed="@origin"]'); await pick('[data-cad-sketch-point="a"]');
    expect(sketch().relations.slice(-2)).toMatchObject([{ kind: 'fixed-axis', pointId: 'a', axis: 'x', value: 0 }, { kind: 'fixed-axis', pointId: 'a', axis: 'y', value: 0 }]);
    await choose('Perpendicular'); await pick('[data-cad-sketch-entity="third"]'); await pick('[data-cad-sketch-fixed="@v"]');
    expect(statusMessage).toHaveBeenLastCalledWith(expect.stringContaining('This line is already horizontal.'), 'error');
    await canvasKey('Escape'); expect(button('Constrain').getAttribute('aria-pressed')).toBe('false');
    // Leaving the tool returns the origin to ordinary selection rather than a command operand.
    expect(container.querySelector('[data-cad-sketch-fixed="@origin"]')?.getAttribute('aria-label')).toBe('Select the origin');
    // An axis keeps its capital in a name, as everywhere else.
    expect(['@h', '@v'].map(id => container.querySelector(`[data-cad-sketch-fixed="${id}"]`)?.getAttribute('aria-label'))).toEqual(['Select the H axis', 'Select the V axis']);
    expect(() => currentSession.assertWorkflowClosed()).not.toThrow();
  });

  it('takes the origin and axes in every constraint pick that expresses them exactly, from the tool or the selection', async () => {
    const source = parseCadDocument({ ...createCadDocument(), schemaVersion: 2, features: [{ id: 'sketch', kind: 'sketch', name: 'Axes', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
      points: [{ id: 'a', position: [5, 0] }, { id: 'b', position: [25, 0] }, { id: 'c', position: [-6, 10] }, { id: 'd', position: [-6, 22] }, { id: 'o', position: [0, 0] },
        { id: 'p', position: [-30, 10] }, { id: 'r', position: [-30, 22] }, { id: 'm', position: [-50, 10] }, { id: 'n', position: [-50, 22] },
        { id: 'g', position: [-70, 10] }, { id: 'h', position: [-70, 22] }],
      entities: [{ id: 'base', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' }, { id: 'side', kind: 'line', construction: false, startPointId: 'c', endPointId: 'd' },
        { id: 'ring', kind: 'circle', construction: false, centerPointId: 'o', radius: 4 }, { id: 'post', kind: 'line', construction: false, startPointId: 'p', endPointId: 'r' },
        { id: 'mast', kind: 'line', construction: false, startPointId: 'm', endPointId: 'n' }, { id: 'guide', kind: 'line', construction: false, startPointId: 'g', endPointId: 'h' }],
      relations: [] } }] });
    await mount(source); await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }));
    const pick = async (selector: string) => {
      const target = container.querySelector(selector); if (!target) throw new Error(`${selector} missing.`);
      await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    };
    const selectionChoices = async () => { await click('Constrain'); return [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')]; };
    const choose = async (label: string) => {
      await click('Constrain');
      const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(entry => entry.textContent?.trim() === label);
      if (!item) throw new Error(`${label} missing.`); await act(async () => item.click());
    };
    const sketch = () => { const feature = currentDocument.features[0]; if (feature.kind !== 'sketch' || !feature.graph) throw new Error('Sketch missing.'); return feature.graph; };
    // Tool first: a line laid on the H axis keeps both endpoints on it, and the origin centers a circle. The test session applies
    // relations without solving, so the geometry already agrees.
    await choose('Coincident'); await pick('[data-cad-sketch-entity="base"]');
    expect(container.textContent).toContain('Coincident · Choose a point to keep on this line, or an axis to lay it on');
    await pick('[data-cad-sketch-fixed="@h"]');
    expect(sketch().relations).toMatchObject([{ kind: 'fixed-axis', pointId: 'a', axis: 'y', value: 0 }, { kind: 'fixed-axis', pointId: 'b', axis: 'y', value: 0 }]);
    await choose('Concentric'); await pick('[data-cad-sketch-fixed="@origin"]'); await pick('[data-cad-sketch-entity="ring"]');
    expect(sketch().relations.slice(2)).toMatchObject([{ kind: 'fixed-axis', pointId: 'o', axis: 'x', value: 0 }, { kind: 'fixed-axis', pointId: 'o', axis: 'y', value: 0 }]);
    await canvasKey('Escape');

    // Selection first: the V axis clicked far above its arrow joins a Shift-selected line in the Constrain list.
    const canvas = container.querySelector<SVGSVGElement>('[aria-label="Sketch drawing canvas"]'); if (!canvas) throw new Error('Sketch canvas missing.');
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, toJSON: () => ({}) });
    let captured: number | null = null;
    Object.assign(canvas, { setPointerCapture: (id: number) => { captured = id; }, hasPointerCapture: (id: number) => captured === id, releasePointerCapture: () => { captured = null; } });
    const view = viewport().getState().view; if (!view || view.mode === 'solid') throw new Error('Sketch frame missing.');
    const viewWidth = Number(canvas.getAttribute('viewBox')?.split(' ')[2]);
    const pointer = async (type: string, x: number, y: number, shiftKey = false) => {
      const event = new MouseEvent(type, { button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true, shiftKey,
        clientX: 300 + (x - view.centerMm[0]) / viewWidth * 600, clientY: 200 - (y - view.centerMm[1]) / view.heightSpanMm * 400 });
      Object.defineProperties(event, { pointerId: { value: 12 }, isPrimary: { value: true } });
      await act(async () => canvas.dispatchEvent(event));
    };
    const tap = async (x: number, y: number, shiftKey = false) => { await pointer('pointerdown', x, y, shiftKey); await pointer('pointerup', x, y, shiftKey); };
    const pressed = (id: string) => container.querySelector(`[data-cad-sketch-fixed="${id}"]`)?.getAttribute('aria-pressed');
    const top = view.centerMm[1] + view.heightSpanMm * 0.45;
    await tap(0, top); expect(pressed('@v')).toBe('true');
    await tap(-6, 16, true);
    expect(viewport().getState().selectedSketchGeometrySet).toEqual([{ kind: 'entity', id: '@v' }, { kind: 'entity', id: 'side' }]); expect(pressed('@v')).toBe('true');
    // The list is the icon row's. The axis is fixed and infinite, so Horizontal and Vertical, which would turn it, and Tangent and Equal length,
    // which need its ends and length, are listed only to say why it cannot take them; Collinear lays the line on it.
    const offered = await selectionChoices();
    expect(offered.map(item => [item.textContent?.trim(), item.matches(':disabled')])).toEqual([['Horizontal', true], ['Vertical', true], ['Parallel', false],
      ['Perpendicular', false], ['Collinear', false], ['Tangent', true], ['Equal length', true]]);
    await act(async () => offered[2].click());
    expect(sketch().relations.at(-1)).toMatchObject({ kind: 'vertical', pointIds: ['c', 'd'] });

    // A Shift box adds geometry and keeps the selected axis; a plain box replaces both.
    await canvasKey('Escape'); await tap(0, top); expect(pressed('@v')).toBe('true');
    await pointer('pointerdown', -10, 17, true); await pointer('pointermove', -3, 23, true); await pointer('pointerup', -3, 23, true);
    expect(viewport().getState().selectedSketchGeometrySet).toEqual([{ kind: 'entity', id: '@v' }, { kind: 'point', id: 'd' }]); expect(pressed('@v')).toBe('true');
    await pointer('pointerdown', -10, 17); await pointer('pointermove', -3, 23); await pointer('pointerup', -3, 23);
    expect(viewport().getState().selectedSketchGeometrySet).toEqual([{ kind: 'point', id: 'd' }]); expect(pressed('@v')).toBe('false');

    // Lines upright only through Parallel with a vertical line take one endpoint on the V axis, from the tool or the selection.
    await canvasKey('Escape'); await choose('Vertical'); await pick('[data-cad-sketch-entity="guide"]');
    for (const [line, upright] of [['post', 'side'], ['mast', 'guide']]) { await choose('Parallel'); await pick(`[data-cad-sketch-entity="${line}"]`); await pick(`[data-cad-sketch-entity="${upright}"]`); }
    await choose('Coincident'); await pick('[data-cad-sketch-entity="post"]');
    let count = sketch().relations.length;
    await pick('[data-cad-sketch-fixed="@v"]');
    expect(sketch().relations.slice(count)).toMatchObject([{ kind: 'fixed-axis', pointId: 'p', axis: 'x', value: 0 }]);
    await canvasKey('Escape'); await tap(0, top); await tap(-50, 16, true);
    expect(viewport().getState().selectedSketchGeometrySet).toEqual([{ kind: 'entity', id: '@v' }, { kind: 'entity', id: 'mast' }]);
    count = sketch().relations.length;
    const collinear = (await selectionChoices()).find(item => item.textContent?.trim() === 'Collinear'); if (!collinear) throw new Error('Collinear missing.');
    await act(async () => collinear.click());
    expect(sketch().relations.slice(count)).toMatchObject([{ kind: 'fixed-axis', pointId: 'm', axis: 'x', value: 0 }]);
  });

  it('keeps a point on an arc or circle with Coincident picked after the tool, or Point on curve from the selection, and removes it from the selection menu', async () => {
    const source = parseCadDocument({ ...createCadDocument(), schemaVersion: 2, features: [{ id: 'sketch', kind: 'sketch', name: 'Curves', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
      points: [{ id: 'o', position: [0, 0] }, { id: 's', position: [10, 0] }, { id: 'e', position: [0, 10] }, { id: 'c', position: [30, 0] }, { id: 'p', position: [6, 8] }, { id: 'q', position: [34, 3] }],
      entities: [{ id: 'bow', kind: 'arc', construction: false, centerPointId: 'o', startPointId: 's', endPointId: 'e', direction: 'ccw' },
        { id: 'ring', kind: 'circle', construction: false, centerPointId: 'c', radius: 5 }], relations: [] } }] });
    await mount(source); await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }));
    const pick = async (selector: string) => {
      const target = container.querySelector(selector); if (!target) throw new Error(`${selector} missing.`);
      await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    };
    const menuItem = async (role: string, label: string) => {
      await click('Constrain');
      const item = [...document.querySelectorAll<HTMLElement>(`[role="${role}"]`)].find(entry => entry.textContent?.trim() === label);
      if (!item) throw new Error(`${label} missing.`); return item;
    };
    const relations = () => { const feature = currentDocument.features[0]; if (feature.kind !== 'sketch' || !feature.graph) throw new Error('Sketch missing.'); return feature.graph.relations; };
    const coincident = await menuItem('menuitem', 'Coincident'); await act(async () => coincident.click());
    await pick('[data-cad-sketch-entity="bow"]'); expect(container.textContent).toContain('Coincident · Choose a point to keep on this arc');
    await pick('[data-cad-sketch-point="p"]');
    expect(relations()).toEqual([{ id: expect.any(String), kind: 'point-on-curve', pointId: 'p', curveId: 'bow' }]);
    await canvasKey('Escape');
    const select = () => act(async () => viewport().apply({ kind: 'select-sketch-geometry-set', selections: [{ kind: 'point', id: 'q' }, { kind: 'entity', id: 'ring' }] }));
    await select(); const offered = await menuItem('menuitemcheckbox', 'Point on curve');
    expect(offered.getAttribute('aria-checked')).toBe('false'); await act(async () => offered.click());
    const held = relations()[1];
    expect(held).toEqual({ id: expect.any(String), kind: 'point-on-curve', pointId: 'q', curveId: 'ring' });
    await select(); const applied = await menuItem('menuitemcheckbox', 'Point on curve');
    expect(applied.getAttribute('aria-checked')).toBe('true'); await act(async () => applied.click());
    expect(relations()).toEqual([expect.objectContaining({ curveId: 'bow' })]);
    expect(() => currentSession.assertWorkflowClosed()).not.toThrow();
  });

  it('never offers to remove Concentric or Symmetric through an unrelated relation on a centre two picks share', async () => {
    // Both circles are centred on o. Coincident r joins o to q, and Symmetric s mirrors o and a about the axis line.
    const source = parseCadDocument({ ...createCadDocument(), schemaVersion: 2, features: [{ id: 'sketch', kind: 'sketch', name: 'Rings', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
      points: [{ id: 'o', position: [0, 0] }, { id: 'q', position: [0, 0] }, { id: 'a', position: [-12, 0] }, { id: 'u', position: [-6, -20] }, { id: 'v', position: [-6, 20] }],
      entities: [{ id: 'inner', kind: 'circle', construction: false, centerPointId: 'o', radius: 3 }, { id: 'outer', kind: 'circle', construction: false, centerPointId: 'o', radius: 6 },
        { id: 'axis', kind: 'line', construction: false, startPointId: 'u', endPointId: 'v' }],
      relations: [{ id: 'r', kind: 'coincident', pointIds: ['o', 'q'] }, { id: 's', kind: 'symmetric', pointIds: ['o', 'a'], lineId: 'axis' }] } }] });
    await mount(source); await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }));
    const relations = () => { const feature = currentDocument.features[0]; if (feature.kind !== 'sketch' || !feature.graph) throw new Error('Sketch missing.'); return feature.graph.relations; };
    const select = (...selections: CadSketchGraphSelection[]) => act(async () => viewport().apply({ kind: 'select-sketch-geometry-set', selections }));
    const offered = async (label: string) => {
      await click('Constrain');
      const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')].find(entry => entry.textContent?.trim() === label);
      if (!item) throw new Error(`${label} missing.`); return item;
    };
    const canvas = container.querySelector<SVGSVGElement>('[aria-label="Sketch drawing canvas"]'); if (!canvas) throw new Error('Sketch canvas missing.');
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, toJSON: () => ({}) });
    const contextMenu = async (entityId: string) => {
      const target = container.querySelector<SVGGElement>(`[data-cad-sketch-entity="${entityId}"]`); if (!target) throw new Error(`${entityId} missing.`);
      await act(async () => { target.focus(); target.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })); });
      return [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    };
    const close = () => act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    const cases = [
      { label: 'Concentric', picks: [{ kind: 'entity', id: 'inner' }, { kind: 'entity', id: 'outer' }], reason: 'These already share a center.' },
      { label: 'Symmetric', picks: [{ kind: 'point', id: 'o' }, { kind: 'entity', id: 'outer' }, { kind: 'entity', id: 'axis' }], reason: 'Symmetric points and axis endpoints need four distinct declared identities.' }
    ] as const;
    for (const { label, picks, reason } of cases) {
      await select(...picks);
      const item = await offered(label);
      expect(item.getAttribute('aria-checked'), label).toBe('false'); expect(item.disabled, label).toBe(true); expect(item.getAttribute('aria-description'), label).toBe(reason);
      await act(async () => item.click()); expect(currentDocument, label).toBe(source); await close();
      await select(...picks);
      const items = (await contextMenu('outer')).map(entry => entry.textContent?.trim());
      // The selection's own menu, without the constraint or a Remove for it.
      expect(items, label).toContain('Move selection'); expect(items, label).not.toContain(`Remove ${label.toLowerCase()}`); expect(items, label).not.toContain(label);
      await close();
    }
    // Two distinct places still name the relation that holds them, and Remove deletes only that one.
    await select({ kind: 'entity', id: 'outer' }, { kind: 'point', id: 'a' }, { kind: 'entity', id: 'axis' });
    expect((await offered('Symmetric')).getAttribute('aria-checked')).toBe('true'); await close();
    await select({ kind: 'entity', id: 'outer' }, { kind: 'point', id: 'a' }, { kind: 'entity', id: 'axis' });
    const remove = (await contextMenu('outer')).find(entry => entry.textContent?.trim() === 'Remove symmetric'); if (!remove) throw new Error('Remove symmetric missing.');
    await act(async () => remove.click());
    expect(relations()).toEqual([{ id: 'r', kind: 'coincident', pointIds: ['o', 'q'] }]);
    expect(() => currentSession.assertWorkflowClosed()).not.toThrow();
  });

  /**
   * A sketch whose selections take every kind of offer, mounted with its edits recorded, not applied, so each selection is read on the
   * same sketch: crossing lines, three stacked lines and a line meeting an arc, two circles mirrored about a line by their centres, and a
   * level base. Its helpers read the icon row, the Constrain menu's selection section and the selection's right-click relations.
   */
  async function offerParity() {
    const source = parseCadDocument({ ...createCadDocument(), schemaVersion: 2, features: [{ id: 'sketch', kind: 'sketch', name: 'Offers', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
      points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [20, 2] }, { id: 'k', position: [20, 12] }, { id: 'w', position: [30, 12] },
        { id: 'p', position: [0, 30] }, { id: 'q', position: [10, 40] }, { id: 'r', position: [0, 40] }, { id: 's', position: [10, 30] },
        { id: 'e', position: [40, 0] }, { id: 'f', position: [60, 0] }, { id: 'g', position: [40, 10] }, { id: 'h', position: [60, 12] }, { id: 'i', position: [40, 20] }, { id: 'j', position: [60, 24] },
        { id: 'o1', position: [80, 10] }, { id: 'o2', position: [100, 10] }, { id: 'u', position: [90, -10] }, { id: 'v', position: [90, 30] }],
      entities: [{ id: 'ab', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' },
        { id: 'bow', kind: 'arc', construction: false, centerPointId: 'k', startPointId: 'b', endPointId: 'w', direction: 'ccw' },
        { id: 'rise', kind: 'line', construction: false, startPointId: 'p', endPointId: 'q' }, { id: 'fall', kind: 'line', construction: false, startPointId: 'r', endPointId: 's' },
        { id: 'base', kind: 'line', construction: false, startPointId: 'e', endPointId: 'f' }, { id: 'top', kind: 'line', construction: false, startPointId: 'g', endPointId: 'h' },
        { id: 'upper', kind: 'line', construction: false, startPointId: 'i', endPointId: 'j' },
        { id: 'c1', kind: 'circle', construction: false, centerPointId: 'o1', radius: 2 }, { id: 'c2', kind: 'circle', construction: false, centerPointId: 'o2', radius: 3 },
        { id: 'mid', kind: 'line', construction: true, startPointId: 'u', endPointId: 'v' }],
      relations: [{ id: 'level', kind: 'horizontal', pointIds: ['e', 'f'] }, { id: 'mirror', kind: 'symmetric', pointIds: ['o1', 'o2'], lineId: 'mid' }] } }] });
    const onEditMany = vi.fn<CadWorkbenchProps['onEditMany']>(() => undefined);
    await mount(source, { build: null, buildState: 'idle', onEditMany }); await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }));
    const P = (id: string): CadSketchGraphSelection => ({ kind: 'point', id }), E = (id: string): CadSketchGraphSelection => ({ kind: 'entity', id });
    const select = (selections: readonly CadSketchGraphSelection[]) => act(async () => viewport().apply({ kind: 'select-sketch-geometry-set', selections: [...selections] }));
    const read = (item: HTMLButtonElement, label: string | null, pressed: string | null) => ({ label, pressed: pressed === 'true', disabled: item.disabled, help: item.getAttribute('aria-description') });
    const rowButtons = () => [...container.querySelectorAll<HTMLButtonElement>('[data-cad-sketch-selection-actions] button:not([data-cad-relation-offer="dimension"])')];
    const row = () => rowButtons().map(item => read(item, item.getAttribute('aria-label'), item.getAttribute('aria-pressed')));
    const menuItems = async () => { await click('Constrain'); return [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')]; };
    const menu = async () => (await menuItems()).map(item => read(item, item.textContent?.trim() ?? null, item.getAttribute('aria-checked')));
    const close = () => act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    const canvas = container.querySelector<SVGSVGElement>('[aria-label="Sketch drawing canvas"]'); if (!canvas) throw new Error('Sketch canvas missing.');
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, toJSON: () => ({}) });
    /** The relations the selection's right-click menu lists after its own commands. */
    const contextRelations = async (pick: CadSketchGraphSelection) => {
      const target = container.querySelector<SVGGElement>(pick.kind === 'point' ? `[data-cad-sketch-point="${pick.id}"]` : `[data-cad-sketch-entity="${pick.id}"]`); if (!target) throw new Error(`${pick.id} missing.`);
      await act(async () => { target.focus(); target.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })); });
      const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].map(item => item.textContent?.trim());
      return items.slice(items.indexOf('Move selection') + 1);
    };
    /** Every selection's row and menu lists are the same, and its right-click lists the ones that can be pressed, Remove for those shown pressed. */
    const compare = async (cases: readonly (readonly [string, readonly CadSketchGraphSelection[], readonly string[]])[]) => {
      for (const [name, picks, includes] of cases) {
        await select(picks);
        const offered = row();
        expect(offered.map(item => item.label), name).toEqual(expect.arrayContaining([...includes]));
        expect(await menu(), name).toEqual(offered);
        await close();
        await select(picks);
        expect(await contextRelations(picks.find(pick => !pick.id.startsWith('@'))!), name).toEqual(offered.filter(item => !item.disabled).map(item => item.pressed ? `Remove ${item.label!.toLowerCase()}` : item.label));
        await close();
      }
    };
    return { source, onEditMany, P, E, select, rowButtons, menuItems, compare };
  }

  it('lists in the Constrain menu exactly the relations the icon row offers for points, lines, axes and the origin, and on right-click those it can press', async () => {
    const { P, E, compare } = await offerParity();
    await compare([
      ['two points', [P('a'), P('e')], ['Coincident', 'Horizontal', 'Vertical', 'Fix']],
      ['one line', [E('base')], ['Horizontal', 'Vertical']],
      ['two crossing lines', [E('rise'), E('fall')], ['Collinear', 'Parallel', 'Perpendicular', 'Equal length']],
      ['a line and an axis', [E('ab'), E('@h')], ['Collinear', 'Parallel', 'Perpendicular']],
      ['two lines and an axis', [E('rise'), E('fall'), E('@v')], ['Symmetric']],
      ['four lines', [E('base'), E('top'), E('upper'), E('ab')], ['Horizontal', 'Parallel', 'Equal length']],
      ['five points', [P('a'), P('b'), P('e'), P('f'), P('g')], ['Coincident', 'Fix']],
      ['a point and the origin', [P('a'), P('@origin')], ['Coincident', 'Horizontal', 'Vertical']]
    ]);
  });

  it('lists in the Constrain menu exactly the relations the icon row offers for arcs and circles, and on right-click those it can press', async () => {
    const { P, E, compare } = await offerParity();
    await compare([
      ['a line and an arc', [E('ab'), E('bow')], ['Tangent']],
      ['an arc and a circle', [E('bow'), E('c1')], ['Concentric', 'Equal radius']],
      ['a point and a circle', [P('a'), E('c1')], ['Point on curve']],
      ['a circle and the origin', [E('c1'), P('@origin')], ['Concentric', 'Point on curve']],
      ['a circle and an axis', [E('c2'), E('@h')], ['Coincident', 'Tangent']],
      ['two circles and a line', [E('c1'), E('c2'), E('mid')], ['Symmetric', 'Symmetric centers']]
    ]);
  });

  it('applies or removes from the Constrain menu the same relations as from the icon row', async () => {
    const { source, onEditMany, P, E, select, rowButtons, menuItems } = await offerParity();
    // Choosing a relation in the menu makes the edits pressing its icon makes: an available one adds the same relations, an applied one,
    // shown pressed and checked, removes the relations that hold it.
    const strip = (edits: readonly CadEdit[]) => edits.map(edit => edit.kind === 'set-sketch-relation' ? { ...edit, relation: { ...edit.relation, id: 'new' } } : edit);
    for (const [picks, label] of [[[E('rise'), E('fall')], 'Collinear'], [[E('c1'), E('c2'), E('mid')], 'Symmetric centers'], [[E('base'), E('top'), E('upper'), E('ab')], 'Parallel'],
      [[E('c1'), P('@origin')], 'Concentric'], [[E('base')], 'Horizontal']] as const) {
      await select(picks);
      const icon = rowButtons().find(item => item.getAttribute('aria-label') === label); if (!icon) throw new Error(`${label} icon missing.`);
      onEditMany.mockClear(); await act(async () => icon.click());
      expect(onEditMany, label).toHaveBeenCalledOnce();
      const pressed = strip(onEditMany.mock.calls[0][0]);
      const item = (await menuItems()).find(entry => entry.textContent?.trim() === label); if (!item) throw new Error(`${label} item missing.`);
      onEditMany.mockClear(); await act(async () => item.click());
      expect(onEditMany, label).toHaveBeenCalledOnce();
      expect(strip(onEditMany.mock.calls[0][0]), label).toEqual(pressed);
    }
    expect(strip(onEditMany.mock.calls[0][0])).toEqual([{ kind: 'remove-sketch-relation', sketchId: 'sketch', relationId: 'level' }]);
    expect(currentDocument).toBe(source);
  });

  it('dimensions a point from the sketch origin or an axis in either pick order', async () => {
    const source = parseCadDocument({ ...createCadDocument(), schemaVersion: 2, features: [{ id: 'sketch', kind: 'sketch', name: 'Line', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
      points: [{ id: 'a', position: [12, -7] }, { id: 'b', position: [30, 5] }], entities: [{ id: 'ab', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' }], relations: [] } }] });
    await mount(source); await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }));
    const pick = async (selector: string) => {
      const target = container.querySelector(selector); if (!target) throw new Error(`${selector} missing.`);
      await act(async () => keyboardPick(target));
    };
    const relations = () => { const feature = currentDocument.features[0]; if (feature.kind !== 'sketch' || !feature.graph) throw new Error('Sketch missing.'); return feature.graph.relations; };
    await click('Dimension'); expect(container.querySelector('[data-cad-sketch-fixed="@origin"]')?.getAttribute('role')).toBe('button');
    await pick('[data-cad-sketch-fixed="@h"]'); expect(pickInstruction()).toBe('Dimension · Choose a point, a line, an arc or a circle to dimension from the H axis · Escape drops the picks');
    await pick('[data-cad-sketch-point="a"]'); expect(pickInstruction()).toBe('Distance · Click or press Enter to place · Right-click for more · Escape drops the picks');
    await focusedKey('Enter');
    expect(relations()).toMatchObject([{ kind: 'fixed-axis', pointId: 'a', axis: 'y', value: -7 }]);
    // A selected point starts the tool as its first pick.
    await canvasKey('Escape'); await pick('[data-cad-sketch-point="b"]'); await click('Dimension');
    expect(pickInstruction()).toBe('Dimension · Choose a second point, a line, an arc, a circle, the origin or an axis · Escape drops the picks');
    // The origin is a point, so it takes the distances of a point pair.
    await pick('[data-cad-sketch-fixed="@origin"]');
    expect(pickInstruction()).toBe('Distance · Click or press Enter to place; the pointer side chooses aligned, horizontal or vertical · Right-click for more · Escape drops the picks');
    await focusedKey('Enter');
    expect(relations().slice(1)).toEqual([{ id: expect.any(String), kind: 'distance', pointIds: ['b', '@origin'], value: Math.hypot(30, 5) }]);
    expect(() => currentSession.assertWorkflowClosed()).not.toThrow();
  });

  it('dimensions the center of a lone circle from an axis, picked by its center or its edge in either order', async () => {
    const source = parseCadDocument({ ...createCadDocument(), schemaVersion: 2, features: [{ id: 'sketch', kind: 'sketch', name: 'Bore', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
      points: [{ id: 'c', position: [8, 4] }], entities: [{ id: 'bore', kind: 'circle', construction: false, centerPointId: 'c', radius: 5 }], relations: [] } }] });
    await mount(source); await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }));
    const pick = async (selector: string) => {
      const target = container.querySelector(selector); if (!target) throw new Error(`${selector} missing.`);
      await act(async () => keyboardPick(target));
    };
    const relations = () => { const feature = currentDocument.features[0]; if (feature.kind !== 'sketch' || !feature.graph) throw new Error('Sketch missing.'); return feature.graph.relations; };
    await click('Dimension'); await pick('[data-cad-sketch-fixed="@v"]'); await pick('[data-cad-sketch-point="c"]'); await focusedKey('Enter');
    const feature = currentDocument.features[0]; if (feature.kind !== 'sketch' || !feature.graph) throw new Error('Sketch missing.');
    expect(feature.graph.relations).toMatchObject([{ kind: 'fixed-axis', pointId: 'c', axis: 'x', value: 8 }]);
    // The tool stays on: the H axis and the circle's edge measure its center.
    await pick('[data-cad-sketch-fixed="@h"]'); expect(pickInstruction()).toBe('Dimension · Choose a point, a line, an arc or a circle to dimension from the H axis · Escape drops the picks');
    await pick('[data-cad-sketch-entity="bore"]'); await focusedKey('Enter');
    expect(relations()).toMatchObject([{ axis: 'x', value: 8 }, { kind: 'fixed-axis', pointId: 'c', axis: 'y', value: 4 }]);
    await act(async () => currentSession.undo()); expect(currentDocument.features[0]).toEqual(feature);
    // From the origin it measures the distance to the center.
    await pick('[data-cad-sketch-entity="bore"]'); await pick('[data-cad-sketch-fixed="@origin"]'); await focusedKey('Enter');
    expect(relations()).toEqual([feature.graph.relations[0], { id: expect.any(String), kind: 'distance', pointIds: ['c', '@origin'], value: Math.hypot(8, 4) }]);
    await act(async () => currentSession.undo());
    expect(currentDocument.features[0]).toEqual(feature); expect(() => currentSession.assertWorkflowClosed()).not.toThrow();
  });

  it('dimensions parallel lines, a point or curve center from a line, and two curve centers with a distance', async () => {
    const source = parseCadDocument({ ...createCadDocument(), schemaVersion: 2, features: [{ id: 'sketch', kind: 'sketch', name: 'Distances', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
      points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [20, 0] }, { id: 'c', position: [0, 10] }, { id: 'd', position: [20, 10] }, { id: 'e', position: [30, 0] },
        { id: 'f', position: [40, 10] }, { id: 'p', position: [5, 4] }, { id: 'o', position: [10, -6] }, { id: 'q', position: [40, -6] }],
      entities: [{ id: 'base', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' }, { id: 'top', kind: 'line', construction: false, startPointId: 'c', endPointId: 'd' },
        { id: 'slant', kind: 'line', construction: false, startPointId: 'e', endPointId: 'f' }, { id: 'ring', kind: 'circle', construction: false, centerPointId: 'o', radius: 2 },
        { id: 'disk', kind: 'circle', construction: false, centerPointId: 'q', radius: 3 }], relations: [] } }] });
    await mount(source); await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }));
    const pick = async (selector: string) => {
      const target = container.querySelector(selector); if (!target) throw new Error(`${selector} missing.`);
      await act(async () => keyboardPick(target));
    };
    const line = (id: string) => `[data-cad-sketch-entity="${id}"]`, point = (id: string) => `[data-cad-sketch-point="${id}"]`;
    const relations = () => { const feature = currentDocument.features[0]; if (feature.kind !== 'sketch' || !feature.graph) throw new Error('Sketch missing.'); return feature.graph.relations; };
    const geometry = () => viewport().getState().selectedSketchGeometrySet;
    /** Places what the picks preview, or the form the menu names, as one undoable edit; returns the relations it added and undoes them. */
    const place = async (form?: string) => {
      if (form) await dimensionMenu(form); else await focusedKey('Enter');
      const added = relations(); await act(async () => currentSession.undo()); expect(currentDocument).toEqual(source);
      return added;
    };
    // Two parallel lines take a distance from the second line to the first, held parallel.
    await click('Dimension'); await pick(line('base')); await pick(line('top'));
    expect(await place()).toEqual([{ id: expect.any(String), kind: 'point-line-distance', pointId: 'c', lineId: 'base', side: 'left', value: 10 },
      { id: expect.any(String), kind: 'parallel', lineIds: ['base', 'top'] }]);
    // Lines that are not parallel take an angle.
    await pick(line('base')); await pick(line('slant'));
    const [angle] = await place(); expect(angle?.kind === 'line-angle' ? Number(angle.value) : NaN).toBeCloseTo(135, 9);
    // A point and a line in either order; a line is not offered with its own endpoints.
    await pick(point('p')); expect(pickInstruction()).toBe('Dimension · Choose a second point, a line, an arc, a circle, the origin or an axis · Escape drops the picks');
    await pick(line('base')); expect(await place()).toMatchObject([{ kind: 'point-line-distance', pointId: 'p', lineId: 'base', value: 4 }]);
    await pick(point('a')); await pick(line('base')); expect(geometry()).toEqual([{ kind: 'point', id: 'a' }]);
    await pick(line('top')); expect(await place()).toMatchObject([{ kind: 'point-line-distance', pointId: 'a', lineId: 'top', value: 10 }]);
    // Tab skips an endpoint of the picked line, which takes no pick; a press or Enter there places, as on empty space.
    await pick(line('base')); expect(container.querySelector(point('a'))?.getAttribute('aria-disabled')).toBe('true'); expect(geometry()).toEqual([{ kind: 'entity', id: 'base' }]);
    await pick(point('p')); expect(await place()).toMatchObject([{ kind: 'point-line-distance', pointId: 'p', lineId: 'base', value: 4 }]);
    // A circle takes a distance from a line, measured from its center, or from a second circle, center to center.
    await pick(line('ring')); await pick(line('base')); expect(await place()).toMatchObject([{ kind: 'point-line-distance', pointId: 'o', lineId: 'base', value: 6 }]);
    await pick(line('ring')); await pick(line('disk')); expect(await place()).toEqual([{ id: expect.any(String), kind: 'distance', pointIds: ['o', 'q'], value: 30 }]);
    // A point and an arc or circle, picked in either order or selected, take a point-pair distance to its center; a circle does not take its own center.
    await pick(point('p')); await pick(line('ring')); expect(await place('Horizontal distance')).toMatchObject([{ kind: 'axis-distance', axis: 'x', pointIds: ['p', 'o'], value: 5 }]);
    await pick(line('disk')); expect(container.querySelector(point('q'))?.getAttribute('aria-disabled')).toBe('true');
    expect(pickInstruction()).toBe('Diameter · Click or press Enter to place · Or choose a point, a line, another curve, the origin or an axis · Escape drops the picks');
    await pick(point('p')); expect(await place('Vertical distance')).toMatchObject([{ kind: 'axis-distance', axis: 'y', pointIds: ['q', 'p'], value: 10 }]);
    await canvasKey('Escape');
    await act(async () => viewport().apply({ kind: 'select-sketch-geometry-set', selections: [{ kind: 'point', id: 'p' }, { kind: 'entity', id: 'ring' }] }));
    await click('Dimension'); expect(geometry()).toEqual([{ kind: 'point', id: 'p' }, { kind: 'entity', id: 'ring' }]);
    expect(await place('Horizontal distance')).toMatchObject([{ kind: 'axis-distance', axis: 'x', pointIds: ['p', 'o'], value: 5 }]);
    // A selected point and line start the distance from the toolbar and from the context menu.
    await canvasKey('Escape');
    await act(async () => viewport().apply({ kind: 'select-sketch-geometry-set', selections: [{ kind: 'point', id: 'p' }, { kind: 'entity', id: 'base' }] }));
    await click('Dimension'); expect(await place()).toMatchObject([{ kind: 'point-line-distance', pointId: 'p', lineId: 'base', value: 4 }]);
    await canvasKey('Escape');
    const canvas = container.querySelector<SVGSVGElement>('[aria-label="Sketch drawing canvas"]'), base = container.querySelector<SVGGElement>(line('base'));
    if (!canvas || !base) throw new Error('Canvas missing.');
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, toJSON: () => ({}) });
    await act(async () => viewport().apply({ kind: 'select-sketch-geometry-set', selections: [{ kind: 'point', id: 'p' }, { kind: 'entity', id: 'base' }] }));
    await act(async () => { base.focus(); base.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })); });
    const action = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === 'Dimension');
    if (!action) throw new Error('Dimension action missing.'); expect(action.disabled).toBe(false);
    await act(async () => action.click()); expect(await place()).toMatchObject([{ kind: 'point-line-distance', pointId: 'p', lineId: 'base', value: 4 }]);
    expect(currentDocument).toEqual(source); expect(() => currentSession.assertWorkflowClosed()).not.toThrow();
  });

  it('measures from the center of a circle whose radius follows an expression, and leaves its size to the expression', async () => {
    const source = parseCadDocument({ ...createCadDocument(), schemaVersion: 2, parameters: { boreRadius: 2 }, features: [{ id: 'sketch', kind: 'sketch', name: 'Bores', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
      points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [20, 0] }, { id: 'p', position: [5, 4] }, { id: 'o', position: [10, -6] }, { id: 'q', position: [40, -6] }],
      entities: [{ id: 'base', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' }, { id: 'bore', kind: 'circle', construction: false, centerPointId: 'o', radius: 'boreRadius' },
        { id: 'disk', kind: 'circle', construction: false, centerPointId: 'q', radius: 3 }], relations: [] } }] });
    await mount(source); await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }));
    const pick = async (selector: string) => {
      const target = container.querySelector(selector); if (!target) throw new Error(`${selector} missing.`);
      await act(async () => keyboardPick(target));
    };
    const entity = (id: string) => `[data-cad-sketch-entity="${id}"]`, point = (id: string) => `[data-cad-sketch-point="${id}"]`;
    const relations = () => { const feature = currentDocument.features[0]; if (feature.kind !== 'sketch' || !feature.graph) throw new Error('Sketch missing.'); return feature.graph.relations; };
    const place = async (form?: string) => {
      if (form) await dimensionMenu(form); else await focusedKey('Enter');
      const added = relations(); await act(async () => currentSession.undo()); expect(currentDocument).toEqual(source);
      return added;
    };
    const waiting = 'Dimension · Choose a point, a line, another curve, the origin or an axis for a distance from its center · Escape drops the picks';
    // Picked first, it waits for a partner; picking it again or Enter does not size it.
    await click('Dimension'); await pick(entity('bore')); expect(pickInstruction()).toBe(waiting);
    await pick(entity('bore')); await focusedKey('Enter');
    expect(pickInstruction()).toBe(waiting); expect(currentDocument).toBe(source);
    await pick(entity('base')); expect(await place()).toMatchObject([{ kind: 'point-line-distance', pointId: 'o', lineId: 'base', value: 6 }]);
    // Picked second after a line, a point, a curve or the origin, it measures from its center.
    await pick(entity('base')); await pick(entity('bore')); expect(await place()).toMatchObject([{ kind: 'point-line-distance', pointId: 'o', lineId: 'base', value: 6 }]);
    await pick(point('p')); await pick(entity('bore')); expect(await place('Horizontal distance')).toMatchObject([{ kind: 'axis-distance', axis: 'x', pointIds: ['p', 'o'], value: 5 }]);
    await pick(entity('disk')); await pick(entity('bore')); expect(await place()).toEqual([{ id: expect.any(String), kind: 'distance', pointIds: ['q', 'o'], value: 30 }]);
    await pick('[data-cad-sketch-fixed="@origin"]'); await pick(entity('bore'));
    expect(await place()).toEqual([{ id: expect.any(String), kind: 'distance', pointIds: ['@origin', 'o'], value: Math.hypot(10, 6) }]);
    // Selected alone, Dimension starts the pick from it, from the toolbar and from the context menu.
    await canvasKey('Escape');
    await act(async () => viewport().apply({ kind: 'select-sketch-geometry', selection: { kind: 'entity', id: 'bore' } }));
    await click('Dimension'); expect(pickInstruction()).toBe(waiting);
    await pick(entity('disk')); expect(await place()).toEqual([{ id: expect.any(String), kind: 'distance', pointIds: ['o', 'q'], value: 30 }]);
    await canvasKey('Escape');
    const canvas = container.querySelector<SVGSVGElement>('[aria-label="Sketch drawing canvas"]'), bore = container.querySelector<SVGGElement>(entity('bore'));
    if (!canvas || !bore) throw new Error('Canvas missing.');
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, toJSON: () => ({}) });
    await act(async () => viewport().apply({ kind: 'select-sketch-geometry', selection: { kind: 'entity', id: 'bore' } }));
    await act(async () => { bore.focus(); bore.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })); });
    const action = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(item => item.textContent === 'Dimension');
    if (!action) throw new Error('Dimension action missing.'); expect(action.disabled).toBe(false);
    await act(async () => action.click()); expect(pickInstruction()).toBe(waiting);
    await pick(entity('base')); await focusedKey('Enter');
    const feature = currentDocument.features[0]; if (feature.kind !== 'sketch' || !feature.graph) throw new Error('Sketch missing.');
    expect(feature.graph.relations).toEqual([{ id: expect.any(String), kind: 'point-line-distance', pointId: 'o', lineId: 'base', side: 'right', value: 6 }]);
    expect(feature.graph.entities.find(item => item.id === 'bore')).toMatchObject({ radius: 'boreRadius' });
    expect(() => currentSession.assertWorkflowClosed()).not.toThrow();
  });

  it('starts Dimension before picking an edge, drops the picks cleanly and places a length that its editor then links to a parameter', async () => {
    await mount({ ...createCadDocument(), parameters: { plateWidth: 50 } }); await startSketch(); await snapToGrid();
    await canvasClick(300, 200); await canvasClick(450, 100); await click('Select');
    await click('Expand Parameters');
    const accepted = currentSession.getSnapshot(), created = currentDocument.features[0];
    if (created.kind !== 'sketch' || !created.graph) throw new Error('Fresh rectangle missing.');
    const edgeId = created.graph.entities[0].id;
    await canvasClick(100, 350);
    expect(viewport().getState().selectedSketchGeometrySet).toEqual([]);
    const relations = () => { const feature = currentDocument.features[0]; if (feature.kind !== 'sketch' || !feature.graph) throw new Error('Sketch missing.'); return feature.graph.relations; };
    const pickEdge = async (id: string) => {
      const target = container.querySelector(`[data-cad-sketch-entity="${id}"]`); if (!target) throw new Error('Dimension edge missing.');
      await act(async () => keyboardPick(target));
    };
    expect(button('Dimension').disabled).toBe(false); await click('Dimension');
    // The tool holds nothing until its first pick; a pick then holds the sketch until it is placed or dropped.
    expect(button('Finish sketch').disabled).toBe(false); expect(() => currentSession.assertWorkflowClosed()).not.toThrow();
    await pickEdge(edgeId);
    expect(button('Finish sketch').disabled).toBe(true); expect(button('Edit parameter plateWidth').disabled).toBe(true);
    expect(() => currentSession.assertWorkflowClosed()).toThrow('Finish or cancel');
    expect(viewport().getState().selectedSketchGeometrySet).toEqual([{ kind: 'entity', id: edgeId }]);
    expect(pickInstruction()).toBe('Length · Click or press Enter to place; right-click for its horizontal or vertical distance · Or choose a second line, a point, a curve or an axis · Escape drops the picks');
    await click('Cancel');
    expect(currentSession.getSnapshot()).toEqual(accepted); expect(currentDocument).toBe(accepted.document);
    expect(viewport().getState().selectedSketchGeometrySet).toEqual([]);
    expect(() => currentSession.assertWorkflowClosed()).not.toThrow();
    // A second line measures the angle between them.
    await pickEdge(edgeId); await pickEdge(created.graph.entities[1].id); await focusedKey('Enter');
    expect(relations().at(-1)).toMatchObject({ kind: 'line-angle', value: 90 }); expect(relations()).toHaveLength(7);
    await act(async () => currentSession.undo()); expect(currentDocument).toEqual(accepted.document);
    // Picking the same line again places its length, and Enter opens its editor, where it follows a parameter.
    await pickEdge(edgeId); await pickEdge(edgeId);
    expect(relations()).toHaveLength(7); expect(relations().at(-1)).toMatchObject({ kind: 'distance', value: 50 });
    await focusedKey('Enter'); await relation('Length', 'plateWidth'); await click('Apply');
    const sketch = currentDocument.features[0];
    if (sketch.kind !== 'sketch' || !sketch.graph) throw new Error('Graph sketch missing.');
    expect(sketch.graph.relations.map(item => item.kind)).toEqual(['horizontal', 'vertical', 'horizontal', 'vertical', 'fixed-axis', 'fixed-axis', 'distance']);
    expect(sketch.graph.relations.at(-1)).toMatchObject({ kind: 'distance', value: 'plateWidth' });
    expect(() => currentSession.assertWorkflowClosed()).not.toThrow();
  });

  it('blocks a new path while a parameter edit is pending without losing either field or history', async () => {
    await mount(); await startSketch(); await click('Line');
    const before = currentSession.getSnapshot();
    await parameterMenu('New parameter'); const pendingField = field('Name'); await input(pendingField, 'wall'); await input(field('Value'), '3');
    const pendingValue = pendingField.value;
    const canvas = container.querySelector<SVGSVGElement>('[aria-label="Sketch drawing canvas"]');
    if (!canvas) throw new Error('Sketch canvas missing');
    expect(canvas.getAttribute('tabindex')).toBe('-1');
    await canvasClick(300, 200); await canvasKey(' '); await canvasKey('ArrowRight'); await canvasKey(' ');
    expect(container.querySelector('[data-cad-path-segments]')).toBeNull(); expect(pendingField.value).toBe(pendingValue);
    expect(currentSession.getSnapshot()).toMatchObject({ document: before.document, version: before.version, canUndo: before.canUndo, workflowOpen: true });
    await click('Cancel');
    expect(currentSession.getSnapshot()).toEqual(before); expect(button('Line segment').disabled).toBe(false);
    await canvasKey(' '); await canvasKey('ArrowRight'); await canvasKey(' ');
    expect(container.querySelector('[data-cad-path-segments]')).not.toBeNull(); expect(button('Undo last').disabled).toBe(false);
    await click('Cancel drawing'); expect(currentSession.getSnapshot()).toEqual(before);
  });

  it('locks shared actions during a mixed path and cancels it without a document or history change', async () => {
    await mount(); await startSketch(); await click('Line');
    const before = currentSession.getSnapshot();
    await click('3-point Arc'); await canvasKey(' '); await canvasKey('ArrowUp'); await canvasKey('ArrowUp'); await canvasKey(' ');
    expect(currentSession.getSnapshot().workflowOpen).toBe(true);
    // No segment is complete yet, so nothing could be saved open and every shared action waits.
    for (const label of ['Finish sketch', 'Undo', 'Save', 'Select', 'Line', 'Arc', 'Rectangle', 'Slot']) expect(button(label).disabled).toBe(true);
    await canvasKey('z');
    const controlUndo = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => container.querySelector('[aria-label="Sketch drawing canvas"]')!.dispatchEvent(controlUndo));
    expect(controlUndo.defaultPrevented).toBe(true); expect(undo).not.toHaveBeenCalled();
    await click('Undo last'); expect(button('Line segment').disabled).toBe(false); expect(button('Finish sketch').disabled).toBe(true);
    await canvasKey('Escape'); expect(currentSession.getSnapshot()).toEqual(before);
    expect(button('Finish sketch').disabled).toBe(false); expect(button('Rectangle').disabled).toBe(false);
  });

  it('finishes an open line chain with Enter without inventing material and edits one of its shared joints', async () => {
    await mount(); await startSketch(); await snapToGrid(); await click('Line');
    await canvasClick(300, 200); await canvasClick(450, 200); await canvasClick(450, 100);
    expect(button('Finish chain').disabled).toBe(false); await canvasKey('Enter');
    const sketch = currentDocument.features[0];
    if (sketch.kind !== 'sketch' || !sketch.graph) throw new Error('Graph path missing.');
    expect(sketch.profiles).toEqual([]); expect(sketch.graph.points.map(point => point.position)).toEqual([[0, 0], [50, 0], [50, 40]]);
    expect(sketch.graph.entities).toHaveLength(2); expect(measureCadSketch(currentDocument, sketch.id).materialAreaMm2).toBe(0);
    expect(() => currentSession.assertWorkflowClosed()).not.toThrow();
    await click('Select');
    const joint = container.querySelector<SVGGElement>(`[data-cad-sketch-point="${sketch.graph.points[1].id}"]`);
    if (!joint) throw new Error('Path joint missing.');
    await act(async () => joint.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })));
    expect(currentDocument.features[0]).toMatchObject({ graph: { points: [{ position: [0, 0] }, { position: [55, 0] }, { position: [50, 40] }], entities: sketch.graph.entities } });
    expect(viewport().getState().selectedSketchGeometry).toEqual({ kind: 'point', id: sketch.graph.points[1].id });
  });

  it('closes a freshly drawn mixed line chain with exact shared arc joints and analytic material', async () => {
    await mount(); await startSketch(); await snapToGrid(); await click('Line');
    await canvasClick(300, 200); await canvasClick(360, 200); await click('3-point Arc');
    await canvasClick(360, 150); await canvasClick(390, 175); await click('Line segment'); await canvasClick(300, 150);
    await click('Close profile');
    const sketch = currentDocument.features[0];
    if (sketch.kind !== 'sketch' || !sketch.graph) throw new Error('Graph path missing.');
    expect(sketch.profiles).toEqual([]);
    expect(sketch.graph.entities.map(entity => entity.kind)).toEqual(['line', 'arc', 'line', 'line']);
    expect(measureCadSketch(currentDocument, sketch.id).materialAreaMm2).toBeCloseTo(400 + 50 * Math.PI, 8);
    expect(() => currentSession.assertWorkflowClosed()).not.toThrow();
  });

  it('draws one separate line per finished pair of clicks and attaches a three-point arc with its own center to existing ends by default', async () => {
    await mount(); await startSketch(); await snapToGrid(); await click('Line');
    // Clicks away from existing geometry and the axes have nothing to attach to.
    await canvasClick(330, 175); expect(workflow).toHaveBeenLastCalledWith(true);
    await canvasClick(450, 175); await canvasKey('Enter'); await canvasClick(330, 100); await canvasClick(450, 100); await canvasKey('Enter');
    let sketch = currentDocument.features[0];
    if (sketch.kind !== 'sketch' || !sketch.graph) throw new Error('Graph sketch missing.');
    expect(sketch.graph.entities.map(entity => entity.kind)).toEqual(['line', 'line']);
    expect(sketch.graph.points.map(point => point.position)).toEqual([[10, 10], [50, 10], [10, 40], [50, 40]]);
    expect(sketch.graph.relations).toEqual([]); expect(toolButton('Line').getAttribute('aria-pressed')).toBe('true');
    expect(() => currentSession.assertWorkflowClosed()).not.toThrow();
    await act(async () => currentSession.undo()); sketch = currentDocument.features[0];
    if (sketch.kind !== 'sketch' || !sketch.graph) throw new Error('Graph sketch missing.');
    const [lineStart, lineEnd] = sketch.graph.points;
    await click('Arc'); await canvasClick(330, 175); await canvasClick(450, 175); expect(workflow).toHaveBeenLastCalledWith(true);
    await canvasClick(390, 100);
    sketch = currentDocument.features[0];
    if (sketch.kind !== 'sketch' || !sketch.graph) throw new Error('Graph sketch missing.');
    const arc = sketch.graph.entities[1];
    if (arc?.kind !== 'arc') throw new Error('Expected the drawn arc.');
    expect(sketch.graph.points).toHaveLength(5); expect(sketch.graph.points.map(point => point.id)).toContain(arc.centerPointId);
    expect([arc.startPointId, arc.endPointId]).not.toContain(lineStart.id);
    expect(sketch.graph.relations).toEqual([{ id: expect.any(String), kind: 'coincident', pointIds: [arc.startPointId, lineStart.id] },
      { id: expect.any(String), kind: 'coincident', pointIds: [arc.endPointId, lineEnd.id] }]);
    // The attached arc and the line close one area together; cadEditPreparation.test.ts checks the arc follows a moved line end.
    expect(measureCadSketch(currentDocument, sketch.id).materialAreaMm2).toBeGreaterThan(0);
    expect(button('Arc').getAttribute('aria-pressed')).toBe('true'); expect(() => currentSession.assertWorkflowClosed()).not.toThrow();
  });

  it('draws a slot from both arc centers and a width click as two tangent lines and two equal arcs', async () => {
    await mount(); await startSketch(); await snapToGrid(); await click('Slot');
    await canvasClick(300, 200); await canvasClick(450, 200); expect(currentDocument.features[0]).toMatchObject({ profiles: [] });
    await canvasClick(375, 175);
    const sketch = currentDocument.features[0];
    if (sketch.kind !== 'sketch' || !sketch.graph) throw new Error('Graph sketch missing.');
    expect(sketch.profiles).toEqual([]);
    expect(sketch.graph.entities.map(entity => entity.kind)).toEqual(['line', 'arc', 'line', 'arc']);
    // The first center, drawn on the origin, stays fixed there because Create relations starts on.
    expect(sketch.graph.relations.map(relation => relation.kind)).toEqual(['tangent-joint', 'tangent-joint', 'tangent-joint', 'tangent-joint', 'equal-radius', 'fixed-axis', 'fixed-axis']);
    const [first, second] = sketch.graph.points;
    expect(sketch.graph.relations.slice(5).map(relation => relation.kind === 'fixed-axis' && relation.pointId)).toEqual([first.id, first.id]);
    expect([first.position, second.position]).toEqual([[0, 0], [50, 0]]);
    const width = 2 * Math.abs(Number(sketch.graph.points[2].position[1]));
    expect(width).toBeGreaterThan(0);
    expect(measureCadSketch(currentDocument, sketch.id).materialAreaMm2).toBeCloseTo(50 * width + Math.PI * width * width / 4, 8);
    expect(button('Slot').getAttribute('aria-pressed')).toBe('true'); expect(() => currentSession.assertWorkflowClosed()).not.toThrow();
  });

  it('edits a profile with a named expression and leaves Ctrl+Z to focused inputs', async () => {
    await openLegacyRectangle({ plateWidth: 80 });
    await click('Add dimension'); await input(dimensionValue(), 'plateWidth / 2');
    expect(button('Save').disabled).toBe(true);
    expect(workflow).toHaveBeenLastCalledWith(true);
    await act(async () => dimensionValue().dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })));
    expect(undo).not.toHaveBeenCalled();
    await click('Apply');
    const sketch = currentDocument.features[0];
    if (sketch.kind !== 'sketch') throw new Error('Expected sketch.');
    const geometry = sketch.profiles[0].geometry;
    expect(geometry.kind === 'rectangle' && geometry.width).toBe('plateWidth / 2');
    expect(sketch.profiles[0].constraints).toMatchObject([{ kind: 'dimension', quantity: 'width' }]);
    expect(workflow).toHaveBeenLastCalledWith(false);
  });

  it('refreshes selected profile fields when an imported document preserves feature and profile IDs', async () => {
    await openLegacyRectangle();
    const sketch = currentDocument.features[0];
    if (sketch.kind !== 'sketch') throw new Error('Expected sketch.');
    const profile = sketch.profiles[0];
    if (profile.geometry.kind !== 'rectangle') throw new Error('Expected rectangle.');
    const updated = applyCadEdits(currentDocument, [{ kind: 'update-feature', feature: { ...sketch, profiles: [{ ...profile, geometry: { ...profile.geometry, width: 75 } }] } }]);
    await act(async () => replaceDocument(updated));
    expect(workflow).toHaveBeenLastCalledWith(false);
    await click('Add dimension'); expect(dimensionValue().value).toBe('75'); await click('Cancel');
    const cleared = applyCadEdits(updated, [{ kind: 'update-feature', feature: { ...sketch, profiles: [] } }]);
    await act(async () => replaceDocument(cleared));
    expect(viewport().getState().selectedProfileId).toBeNull();
  });

  it('preserves the document when an expression is invalid and Cancel restores the field', async () => {
    await openLegacyRectangle();
    await click('Add dimension'); await input(dimensionValue(), 'missingParameter * 2'); await click('Apply');
    expect(container.querySelector('.cad-sketch-intent-editor [role="alert"]')?.textContent).toContain('Unknown parameter');
    const sketch = currentDocument.features[0];
    expect(sketch.kind === 'sketch' && sketch.profiles[0].geometry.kind === 'rectangle' && sketch.profiles[0].geometry.width).toBe(50);
    expect(button('Save').disabled).toBe(true);
    await click('Cancel');
    expect(workflow).toHaveBeenLastCalledWith(false);
    await click('Add dimension'); expect(dimensionValue().value).toBe('50'); await click('Cancel');
  });

  it('owns Save while editing and cancels scalar drafts with Escape without intercepting native text undo', async () => {
    await mount(solidDocument(), { build: topologyBuild, buildState: 'ready' });
    await click('Select Pad 1 in history'); await act(async () => { container.querySelector('.cad-tree-row[aria-pressed="true"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    const before = currentSession.getSnapshot();
    await input(field('Length'), 'invalid + 2');
    await act(async () => field('Length').focus());
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    const nativeUndo = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => field('Length').dispatchEvent(nativeUndo));
    expect(nativeUndo.defaultPrevented).toBe(false); expect(undo).not.toHaveBeenCalled();
    for (const modifier of ['ctrlKey', 'metaKey']) {
      const saveKey = new KeyboardEvent('keydown', { key: 's', [modifier]: true, bubbles: true, cancelable: true });
      await act(async () => field('Length').dispatchEvent(saveKey));
      expect(saveKey.defaultPrevented).toBe(true);
    }
    expect(save).not.toHaveBeenCalled(); expect(currentSession.getSnapshot()).toMatchObject({ document: before.document, version: before.version, workflowOpen: true });
    const composingEscape = new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true });
    await act(async () => field('Length').dispatchEvent(composingEscape));
    expect(field('Length').value).toBe('invalid + 2'); expect(composingEscape.defaultPrevented).toBe(false);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await act(async () => field('Length').dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(true); expect(field('Length').value).toBe('10');
    expect(currentSession.getSnapshot()).toEqual(before);
    const saveKey = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => field('Length').dispatchEvent(saveKey));
    expect(saveKey.defaultPrevented).toBe(true); expect(save).toHaveBeenCalledTimes(1);
  });

  it('cancels the scalar draft on the first Escape while focused contextual help is open', async () => {
    await mount(solidDocument(), { build: topologyBuild, buildState: 'ready' });
    await click('Select Pad 1 in history'); await act(async () => { container.querySelector('.cad-tree-row[aria-pressed="true"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    const before = currentSession.getSnapshot();
    await input(field('Length'), 'invalid + 2');
    await act(async () => field('Length').focus());
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await act(async () => field('Length').dispatchEvent(escape));
    expect(escape.defaultPrevented).toBe(true);
    expect(field('Length').value).toBe('10');
    expect(currentSession.getSnapshot()).toEqual(before);
  });

  it('cancels pending parameter fields from the focused input without changing geometry or history', async () => {
    await mount(solidDocument());
    const before = currentSession.getSnapshot(); await parameterMenu('New parameter');
    await input(field('Name'), 'wall'); await input(field('Value'), '3');
    expect(currentSession.getSnapshot().workflowOpen).toBe(true);
    await act(async () => field('Value').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(document.querySelector('.cad-parameter-editor')).toBeNull();
    expect(currentSession.getSnapshot()).toEqual(before);
  });

  it('uses the current body when starting a modification from a consumed historical feature', async () => {
    const initial = applyCadEdits(createCadDocument(), [
      { kind: 'add-feature', feature: { id: 'sketch', name: 'Outline', kind: 'sketch', plane: 'XY', offset: 0, suppressed: false, profiles: [{ id: 'rectangle', name: 'Plate', construction: false, role: 'outer', geometry: { kind: 'rectangle', x: 0, y: 0, width: 50, height: 40, cornerRadius: 0 } }] } },
      { kind: 'add-feature', feature: { id: 'pad', name: 'Pad 1', kind: 'extrude', suppressed: false, sketchId: 'sketch', distance: 10, symmetric: false, operation: 'new', targetId: null } },
      { kind: 'add-feature', feature: { id: 'fillet', name: 'Fillet 1', kind: 'fillet', suppressed: false, targetId: 'pad', radius: 1 } },
    ]);
    const section = vi.fn();
    await mount(initial, { onSectionForCam: section, buildState: 'ready', build: { buildId: 'build-1', meshes: [{ featureId: 'fillet', name: 'Fillet 1', positions: [], normals: [], indices: [], edges: [], faceGroups: [], edgeGroups: [], volume: 100, bounds: { min: [0, 0, 0], max: [50, 40, 10] } }], diagnostics: [], durationMs: 1 } });
    await click('Select Pad 1 in history'); await click('File'); await click('Section for CAM');
    expect(section).toHaveBeenCalledWith('fillet');
    await click('Move');
    expect(button('File').disabled).toBe(true);
    const sourceSelect = [...container.querySelectorAll('label')].find((label) => label.querySelector('span')?.textContent === 'Body')?.querySelector('select');
    expect(sourceSelect?.value).toBe('fillet');
    expect([...sourceSelect?.options ?? []].map((option) => option.value)).toEqual(['fillet']);
    await click('Apply');
    expect(currentDocument.features.at(-1)).toMatchObject({ kind: 'transform', sourceId: 'fillet' });
  });

  it('follows a selected historical feature to its own body by key, not to the latest body', async () => {
    const plate = { kind: 'rectangle' as const, x: 0, y: 0, width: 50, height: 40, cornerRadius: 0 }, block = { ...plate, x: 80, width: 10 };
    const initial = applyCadEdits(createCadDocument(), [
      { kind: 'add-feature', feature: { id: 'sketch', name: 'Outline', kind: 'sketch', plane: 'XY', offset: 0, suppressed: false, profiles: [{ id: 'rectangle', name: 'Plate', construction: false, geometry: plate }] } },
      { kind: 'add-feature', feature: { id: 'pad', name: 'Pad 1', kind: 'extrude', suppressed: false, sketchId: 'sketch', distance: 10, symmetric: false, operation: 'new', targetId: null } },
      { kind: 'add-feature', feature: { id: 'fillet', name: 'Fillet 1', kind: 'fillet', suppressed: false, targetId: 'pad', radius: 1 } },
      { kind: 'add-feature', feature: { id: 'block_sketch', name: 'Block outline', kind: 'sketch', plane: 'XY', offset: 0, suppressed: false, profiles: [{ id: 'block', name: 'Block', construction: false, geometry: block }] } },
      { kind: 'add-feature', feature: { id: 'block', name: 'Block', kind: 'extrude', suppressed: false, sketchId: 'block_sketch', distance: 10, symmetric: false, operation: 'new', targetId: null } },
    ]);
    const mesh = (featureId: string, name: string, bodyKey: string, min: number, max: number) => ({ featureId, bodyKey, name, positions: [], normals: [], indices: [], edges: [], faceGroups: [], edgeGroups: [], volume: 100,
      bounds: { min: [min, 0, 0] as const, max: [max, 40, 10] as const } }) as unknown as CadMesh;
    const section = vi.fn();
    await mount(initial, { onSectionForCam: section, buildState: 'ready', build: { buildId: 'build-1', meshes: [mesh('fillet', 'Fillet 1', 'pad', 0, 50), mesh('block', 'Block', 'block', 80, 90)], diagnostics: [], durationMs: 1 } });
    await click('Select Pad 1 in history'); await click('File'); await click('Section for CAM');
    expect(section).toHaveBeenLastCalledWith('fillet');
    await click('Select Outline in history'); await click('File'); await click('Section for CAM');
    expect(section).toHaveBeenLastCalledWith('block');
    await click('Select Pad 1 in history'); await click('Move');
    const sourceSelect = [...container.querySelectorAll('label')].find((label) => label.querySelector('span')?.textContent === 'Body')?.querySelector('select');
    expect(sourceSelect?.value).toBe('fillet');
    await click('Apply');
    expect(currentDocument.features.at(-1)).toMatchObject({ kind: 'transform', sourceId: 'fillet' });
  });

  it('draws snapped geometry with the keyboard and guards the real shared session', async () => {
    await mount(); await startSketch();
    await canvasKey('Enter');
    expect(() => currentSession.assertWorkflowClosed()).toThrow('Finish or cancel');
    await canvasKey('ArrowRight', true); await canvasKey('ArrowUp', true); await canvasKey('Enter');
    const sketch = currentDocument.features[0];
    expect(sketch.kind === 'sketch' && sketch.graph?.points.map(point => point.position)).toEqual([[0, 0], [50, 0], [50, 50], [0, 50]]);
    expect(() => currentSession.assertWorkflowClosed()).not.toThrow();
  });

  it('ignores right-button clicks and leaves browser zoom gestures to the browser', async () => {
    await mount(); await startSketch();
    const canvas = container.querySelector<SVGSVGElement>('[aria-label="Sketch drawing canvas"]');
    if (!canvas) throw new Error('Sketch canvas missing.');
    const originalView = canvas.getAttribute('viewBox');
    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('click', { button: 2, bubbles: true, clientX: 200, clientY: 100 }));
      canvas.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: 100, bubbles: true }));
    });
    expect(currentSession.getSnapshot().workflowOpen).toBe(false);
    expect(canvas.getAttribute('viewBox')).toBe(originalView);
    expect(container.querySelector('.cad-sketch-vertex')).toBeNull();
  });

  it('focuses the safe delete action, traps keyboard focus and restores focus on Escape', async () => {
    await mount(); await startSketch(); await click('Finish sketch');
    // Delete on the selected history row asks before deleting, and Escape returns focus to that row.
    const trigger = container.querySelector<HTMLButtonElement>('.cad-tree-row[aria-pressed="true"]'); if (!trigger) throw new Error('Selected sketch row missing.');
    await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })); });
    const dialog = container.querySelector<HTMLDivElement>('[role="dialog"]');
    if (!dialog) throw new Error('Delete dialog missing.');
    const buttons = dialog.querySelectorAll('button');
    expect(window.document.activeElement).toBe(buttons[0]);
    await act(async () => { buttons[1].focus(); buttons[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })); });
    expect(window.document.activeElement).toBe(buttons[0]);
    await act(async () => buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(currentDocument.features).toHaveLength(1);
    expect(window.document.activeElement).toBe(trigger);
    expect(currentSession.getSnapshot().workflowOpen).toBe(false);
  });

  it('publishes stable viewport controls and applies fit/grid/profile selection without editing the draft', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(650);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500);
    await mount(); await startSketch(); await snapToGrid();
    const controls = viewport();
    await canvasClick(300, 200);
    expect(() => controls.apply({ kind: 'fit' })).toThrow('Apply or cancel');
    await canvasClick(450, 100);
    expect(viewport()).toBe(controls);
    const version = currentSession.getSnapshot().version;
    await act(async () => controls.apply({ kind: 'fit' }));
    expect(controls.getState()).toMatchObject({ documentVersion: version, view: { mode: 'sketch', centerMm: [25, 20], heightSpanMm: 50 } });
    await act(async () => controls.apply({ kind: 'set-grid', visible: false }));
    expect(button('Toggle sketch grid').getAttribute('aria-pressed')).toBe('false');
    await act(async () => controls.apply({ kind: 'select-profile', profileId: null }));
    expect(controls.getState().selectedProfileId).toBeNull();
    expect(currentSession.getSnapshot().version).toBe(version);
    expect(Object.isFrozen(controls.getState().view)).toBe(true);
  });

  it('keeps the newly mounted sketch controls when the old solid renderer disposes later', async () => {
    await mount();
    expect(viewport().getState().view).toMatchObject({ mode: 'solid', available: true });
    await startSketch();
    const controls = viewport();
    expect(controls.getState().view).toMatchObject({ mode: 'sketch', available: true });
    const sketchId = currentDocument.features[0].id;
    await click('Finish sketch');
    expect(controls.getState().view).toMatchObject({ mode: 'solid', available: true });
    await act(async () => controls.apply({ kind: 'edit-sketch', sketchId }));
    expect(controls.getState().view).toMatchObject({ mode: 'sketch', available: true });
    expect(currentSession.getSnapshot().workflowOpen).toBe(false);
  });

  it('selects exact topology through keyboard-accessible rows and persists only verified geometric selectors', async () => {
    const resolve = vi.fn(resolveTopology);
    await mount(solidDocument(), { build: topologyBuild, buildState: 'ready', onInspectTopology: inspectTopology, onResolveSelection: resolve });
    await rowMenu('Pad 1', 'Properties'); await click('Inspect topology'); await click('Browse edges'); await click('1. Straight edge50 mm');
    expect(viewport().getState().topologySelection?.picks).toEqual([{ kind: 'edge', key: 'edge-1' }]);
    expect(container.querySelector('.cad-topology-summary')?.textContent).toContain('Straight edge');
    await click('Fillet');
    expect(resolve).toHaveBeenCalledWith({ bodyId: 'pad', expectedBuildId: 'build-1', purpose: 'fillet', picks: [{ kind: 'edge', key: 'edge-1' }] }, currentSession.getSnapshot().version, expect.any(AbortSignal));
    expect(currentSession.getSnapshot().workflowOpen).toBe(true);
    expect(() => currentSession.assertWorkflowClosed()).toThrow('Finish or cancel');
    const scope = [...container.querySelectorAll('label')].find((label) => label.querySelector('span')?.textContent === 'Scope')?.querySelector('select');
    expect(scope?.value).toBe('selected');
    if (!scope) throw new Error('Scope control missing.');
    await act(async () => { scope.value = 'all'; scope.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(scope.value).toBe('all'); expect(scope.selectedOptions[0]?.textContent).toBe('All edges of the body');
    await act(async () => { scope.value = 'selected'; scope.dispatchEvent(new Event('change', { bubbles: true })); });
    await relation('Radius', '1 / 2'); await click('Apply');
    const feature = currentDocument.features.at(-1);
    expect(feature).toMatchObject({ kind: 'fillet', targetId: 'pad', radius: '1 / 2', selection: selectedEdgeQuery });
    expect(JSON.stringify(feature)).not.toContain('edge-1');
    expect(viewport().getState().topologySelection).toBeNull();
    expect(currentSession.getSnapshot().workflowOpen).toBe(false);
  });

  it('creates an inward shell from one planar face with an expression thickness', async () => {
    await mount(solidDocument(), { build: topologyBuild, buildState: 'ready', onInspectTopology: inspectTopology, onResolveSelection: resolveTopology });
    expect(button('Shell').disabled).toBe(true);
    await selectTopology('face');
    expect(button('Shell').disabled).toBe(false);
    await click('Shell'); await relation('Wall thickness', '2 / 4'); await click('Apply');
    expect(currentDocument.features.at(-1)).toMatchObject({ kind: 'shell', targetId: 'pad', thickness: '2 / 4', opening: shellOpening });
    expect(currentSession.getSnapshot().workflowOpen).toBe(false);
  });

  it('aborts conversion on Cancel and ignores a late response after a newer operation starts', async () => {
    let finish: ((result: CadTopologyResolvePicksResult) => void) | undefined;
    let signal: AbortSignal | undefined;
    const resolve: NonNullable<CadWorkbenchProps['onResolveSelection']> = (_request, _version, abort) => { signal = abort; return new Promise((done) => { finish = done; }); };
    await mount(solidDocument(), { build: topologyBuild, buildState: 'ready', onInspectTopology: inspectTopology, onResolveSelection: resolve });
    await selectTopology('edge'); await click('Fillet');
    expect(currentSession.getSnapshot().workflowOpen).toBe(true);
    await click('Cancel');
    expect(signal?.aborted).toBe(true); expect(currentSession.getSnapshot().workflowOpen).toBe(false);
    await click('Chamfer');
    await act(async () => finish?.({ bodyId: 'pad', buildId: 'build-1', purpose: 'fillet', selection: selectedEdgeQuery }));
    expect(container.querySelector('.cad-inspector-title')?.textContent).toBe('Create chamfer');
    await click('Apply');
    expect(currentDocument.features.at(-1)?.kind).toBe('chamfer');
  });

  it('invalidates picks and pending conversion when the worker creates a new build of the same document', async () => {
    let finish: ((result: CadTopologyResolvePicksResult) => void) | undefined;
    let signal: AbortSignal | undefined;
    const resolve: NonNullable<CadWorkbenchProps['onResolveSelection']> = (_request, _version, abort) => { signal = abort; return new Promise((done) => { finish = done; }); };
    await mount(solidDocument(), { build: topologyBuild, buildState: 'ready', onInspectTopology: inspectTopology, onResolveSelection: resolve });
    await selectTopology('edge');
    const selected = viewport().getState().topologySelection;
    await click('Fillet');
    const version = currentSession.getSnapshot().version;
    await act(async () => replaceBuild({ ...topologyBuild, buildId: 'rebuilt-2' }));
    expect(signal?.aborted).toBe(true); expect(viewport().getState().topologySelection).toBeNull();
    expect(currentSession.getSnapshot().version).toBe(version);
    expect(currentSession.getSnapshot().workflowOpen).toBe(false);
    await act(async () => finish?.({ bodyId: 'pad', buildId: 'build-1', purpose: 'fillet', selection: selectedEdgeQuery }));
    expect(currentDocument.features).toHaveLength(2);
    expect(statusMessage).toHaveBeenCalledWith(expect.stringContaining('solid changed during selection conversion'), 'error');
    if (!selected) throw new Error('Topology selection missing.');
    expect(() => viewport().apply({ kind: 'select-topology', selection: { ...selected, picks: [...selected.picks] }, additive: false })).toThrow('solid build changed');
  });

  it('uses one live shell header, renames the part from its Properties and restores the shell on CAD exit', async () => {
    await mount(createCadDocument(), { build: null, buildState: 'idle' }, true);
    const header = container.querySelector('[data-app-header]');
    expect(container.querySelectorAll('.cad-header')).toHaveLength(1);
    expect(header?.contains(button('Save'))).toBe(true);
    const name = await partName(); expect(header?.contains(name)).toBe(false);
    await input(name, 'Edited part');
    expect(button('Save').disabled).toBe(true);
    await act(async () => name.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(currentDocument.name).toBe('Edited part');
    expect(button('Save').disabled).toBe(false);
    await click('File'); expect(header?.contains(button('Import file'))).toBe(true);
    expect(header?.querySelector<HTMLInputElement>('input[type="file"]')?.accept.split(',')).toEqual(['.wireedm-cad', '.json', '.step', '.stp', '.stl', '.dxf']);
    await act(async () => removeCad());
    expect(header?.textContent).toBe('Workbench');
    expect(container.querySelector('main')).toBeNull();
  });

  it('draws nested closed profiles without role input and measures the automatic opening', async () => {
    await mount(); await startSketch(); await snapToGrid(); await canvasClick(300, 200); await canvasClick(450, 100);
    await click('Circle'); await canvasClick(375, 150); await canvasClick(390, 150);
    const sketch = currentDocument.features[0];
    if (sketch.kind !== 'sketch') throw new Error('Sketch missing.');
    expect(sketch.profiles.every((profile) => profile.role === undefined)).toBe(true);
    expect(sketch.profiles).toEqual([]);
    expect(sketch.graph?.entities).toHaveLength(5);
    const circle = sketch.graph?.entities[4];
    if (!circle || circle.kind !== 'circle' || typeof circle.radius !== 'number') throw new Error('Numeric circle missing.');
    expect(measureCadSketch(currentDocument, sketch.id).materialAreaMm2).toBeCloseTo(2000 - Math.PI * circle.radius * circle.radius, 5);
    await click('Finish sketch'); await click('File'); await click('Send sketch to CAM');
    expect(sendToCam).toHaveBeenCalledWith(sketch.id);
  });

  it('shows imported source metadata without exposing or editing original source contents', async () => {
    const source = { format: 'step', encoding: 'utf8', fileName: 'source.step', data: 'ISO-10303-21;\nEND-ISO-10303-21;' } satisfies Extract<CadDocument['features'][number], { kind: 'imported' }>['source'];
    const initial = applyCadEdits(createCadDocument(), [{ kind: 'add-feature', feature: { id: 'imported', kind: 'imported', name: 'Imported solid', suppressed: false, source } }]);
    await mount(initial); await click('Select Imported solid in history'); await act(async () => { container.querySelector('.cad-tree-row[aria-pressed="true"]')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    expect(container.querySelector('.cad-topology-details')?.textContent).toContain('source.step');
    await act(async () => button('Select Imported solid in history').dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true })));
    const name = container.querySelector<HTMLInputElement>('input[aria-label="Feature name"]'); if (!name) throw new Error('Missing tree rename');
    await input(name, 'Renamed solid'); await click('Apply name');
    expect(currentDocument.features[0]).toMatchObject({ name: 'Renamed solid', source });
    expect(container.textContent).not.toContain('ISO-10303-21');
  });

  it('keeps CAD header commands when a previous editor cleans up its shell header', async () => {
    await mount(createCadDocument(), { build: null, buildState: 'idle' }, 'previous-header');
    expect(container.querySelector('[data-app-header]')?.textContent).toBe('Previous editor');
    await act(async () => showCad());
    expect(container.querySelectorAll('.cad-header')).toHaveLength(1);
    expect(container.querySelector('[data-app-header]')?.contains(button('File'))).toBe(true);
    await startSketch();
    expect(container.querySelector('[data-app-header]')?.contains(button('Save'))).toBe(true);
  });

  it('renders imported analytic line/arc paths, fits their exact bounds and preserves segment geometry on metadata edits', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(650);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500);
    const geometry = { kind: 'path', segments: [{ kind: 'line', start: [0, 0], end: [20, 0] }, { kind: 'arc', center: [10, 0], radius: 10, startAngle: 0, sweep: 180 }] } satisfies Extract<CadDocument['features'][number], { kind: 'sketch' }>['profiles'][number]['geometry'];
    const initial = applyCadEdits(createCadDocument(), [{ kind: 'add-feature', feature: { id: 'path-sketch', name: 'Imported sketch', kind: 'sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [{ id: 'path-profile', name: 'Contour', construction: false, geometry }] } }]);
    await mount(initial);
    await act(async () => { viewport().apply({ kind: 'edit-sketch', sketchId: 'path-sketch' }); viewport().apply({ kind: 'select-profile', profileId: 'path-profile' }); });
    const profile = container.querySelector('[aria-label="Select Contour profile"]');
    expect(profile?.querySelectorAll('path')).toHaveLength(1);
    const boundary = profile?.querySelector('path')?.getAttribute('d');
    const line = boundary?.match(/^M ([^ ]+) ([^ ]+) L ([^ ]+) ([^ ]+) A 10 10 0 0 1 /);
    if (!line) throw new Error('Expected a line joined to an exact minor CCW radius-10 arc');
    expect(Number(line[3]) - Number(line[1])).toBe(20);
    expect(Number(line[4]) - Number(line[2])).toBe(0);
    expect(boundary?.endsWith(' Z')).toBe(true);
    await click('Fit sketch');
    const view = viewport().getState().view;
    if (view?.mode !== 'sketch') throw new Error('Sketch view missing.');
    expect(view.centerMm[0]).toBeCloseTo(10, 6); expect(view.centerMm[1]).toBeCloseTo(5, 6);
    expect(container.querySelector<HTMLInputElement>('[aria-label="Path segment"]')?.value).toBe('1');
    expect(field('End X').value).toBe('20');
    await input(field('Name'), 'Renamed contour'); await click('Apply');
    const sketch = currentDocument.features[0];
    expect(sketch.kind === 'sketch' && sketch.profiles[0]).toMatchObject({ name: 'Renamed contour', geometry });
    expect(measureCadSketch(currentDocument, 'path-sketch').materialAreaMm2).toBeCloseTo(Math.PI * 50, 6);
  });
});


it('owns circle-row preview, Cancel, copy omission and detach through the contextual sketch command', async () => {
  const initial=circleRowPart(true); await mount(initial);
  await act(async()=>viewport().apply({kind:'edit-sketch',sketchId:'sketch'}));
  await act(async()=>viewport().apply({kind:'select-sketch-geometry',selection:{kind:'entity',id:'seed'}}));
  await click('Pattern'); await click('Linear pattern');
  await input(field('Pitch'),'15');
  const occurrence=()=>container.querySelector<SVGGElement>('[data-cad-pattern-instance="2"]')!;
  await act(async()=>occurrence().dispatchEvent(new MouseEvent('click',{bubbles:true})));
  expect(occurrence().getAttribute('aria-checked')).toBe('false'); expect(currentDocument).toBe(initial);
  await click('Cancel'); expect(currentDocument).toBe(initial);
  await click('Pattern'); await click('Linear pattern'); await input(field('Pitch'),'15'); await click('Apply');
  let row=rowSketch(currentDocument),owner=row.graph.relations.find(r=>r.kind==='linear-pattern');
  if(owner?.kind!=='linear-pattern')throw Error('Missing owner');
  expect(owner).toMatchObject({count:4,spacing:15,direction:'+x',omittedInstances:[]});
  const member=owner.idPrefix+'_i2_e0';
  await act(async()=>viewport().apply({kind:'select-sketch-geometry',selection:{kind:'entity',id:member}}));
  expect(button('Move selection').disabled).toBe(true);
  const construction=container.querySelector<HTMLInputElement>('.cad-sketch-options input');expect(construction?.disabled).toBe(true);
  // Edit pattern lives in the geometry context menu (Shift+F10 on the focused seed).
  const canvas=container.querySelector<SVGSVGElement>('[aria-label="Sketch drawing canvas"]');if(!canvas)throw Error('Canvas missing');
  // The keyboard menu hit-tests the focused geometry at its on-screen position.
  vi.spyOn(canvas,'getBoundingClientRect').mockReturnValue({x:0,y:0,left:0,top:0,right:600,bottom:400,width:600,height:400,toJSON:()=>({})});
  const editPattern=async()=>{
    await act(async()=>{const seed=container.querySelector<SVGGElement>('[data-cad-sketch-entity="seed"]')!;seed.focus();seed.dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true,cancelable:true}));});
    const item=[...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(entry=>entry.textContent==='Edit pattern');if(!item)throw Error('Missing Edit pattern');await act(async()=>item.click());
  };
  await editPattern(); await act(async()=>occurrence().dispatchEvent(new MouseEvent('click',{bubbles:true}))); await click('Apply');
  row=rowSketch(currentDocument); expect(row.graph.entities.some(e=>e.id===member)).toBe(false);
  await editPattern(); expect(occurrence().getAttribute('aria-checked')).toBe('false');
  await act(async()=>occurrence().dispatchEvent(new MouseEvent('click',{bubbles:true})));await click('Apply');
  row=rowSketch(currentDocument);expect(row.graph.entities.some(e=>e.id===member)).toBe(true);
  const linked=row.graph; await editPattern(); await click('Detach pattern'); expect(field('Pitch').matches(':disabled')).toBe(true);await click('Apply');
  row=rowSketch(currentDocument);expect(row.graph.relations).toEqual([]);expect(row.graph.entities).toEqual(linked.entities);expect(row.graph.points).toEqual(linked.points);
  await act(async()=>viewport().apply({kind:'select-sketch-geometry',selection:{kind:'entity',id:member}})); expect(button('Move selection').disabled).toBe(false);
});


it('keeps a linked Use endpoint available as the first Dimension point and as a fixed point-pair anchor',async()=>{
  const base=parseCadDocument({...createCadDocument(),schemaVersion:2,features:[
    {id:'layout',kind:'sketch',name:'Layout',plane:'XY',offset:0,suppressed:false,profiles:[],graph:{points:[{id:'a',position:['0','0']},{id:'b',position:['20','0']}],entities:[{id:'edge',kind:'line',construction:true,startPointId:'a',endPointId:'b'}],relations:[]}},
    {id:'target',kind:'sketch',name:'Target',plane:'XY',offset:0,suppressed:false,profiles:[],graph:{points:[{id:'o',position:[10,8]}],entities:[{id:'hole',kind:'circle',centerPointId:'o',radius:'2',construction:false}],relations:[]}}]});
  const source=applyCadEdits(base,[{kind:'use-sketch-entity',sketchId:'target',sourceSketchId:'layout',sourceEntityId:'edge',idPrefix:'guide'}]);await mount(source);
  await act(async()=>viewport().apply({kind:'edit-sketch',sketchId:'target'}));await act(async()=>viewport().apply({kind:'select-sketch-geometry',selection:{kind:'point',id:'guide_p0'}}));
  expect(button('Dimension').disabled).toBe(false);await click('Dimension');
  const target=container.querySelector<SVGGElement>('[data-cad-sketch-point="o"]')!;await act(async()=>target.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})));
  const items=await dimensionMenu(),item=(label:string)=>items.find(entry=>entry.textContent?.trim()===label);
  expect(item('Horizontal distance')?.disabled).toBe(false);expect(item('Vertical distance')?.disabled).toBe(false);expect(currentDocument).toBe(source);
});

describe('sketch definition colours and locks', () => {
  type Answer = { sketchId: string; version?: string; signal?: AbortSignal; resolve(analysis: CadSketchConstraintAnalysis): void };
  const solved = (degreesOfFreedom: number, defined: { points: string[]; entities: string[] }, under: { points: string[]; entities: string[] } = { points: [], entities: [] }): CadSketchConstraintAnalysis => ({
    kind: 'solved', diagnostics: { status: 'success', degreesOfFreedom, conflictingIds: [], redundantIds: [], partiallyRedundantIds: [], issues: [],
      definition: { definedPointIds: defined.points, underDefinedPointIds: under.points, definedEntityIds: defined.entities, underDefinedEntityIds: under.entities } } });
  /** Mounts a session whose sketch analyses wait for the test to answer them. */
  async function mountAnalysed(source: CadDocument, onPrepareEdits?: CadWorkbenchProps['onPrepareEdits']) {
    const session = new CadSession(source); currentSession = session;
    const answers: Answer[] = [];
    const inspect = vi.fn((sketchId: string, version?: string, signal?: AbortSignal) => new Promise<CadSketchConstraintInspection>(resolve => answers.push({ sketchId, version, signal, resolve: analysis => resolve({
      sketchId, pointCount: 0, entityCount: 0, relationCount: 0, legacyProfileCount: 0, legacyDimensionCount: 0, degreesOfFreedomScope: 'graph', graph: null, parameters: {}, analysis }) })));
    function Harness() {
      const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot); currentDocument = snapshot.document;
      return <CadWorkbench document={snapshot.document} documentVersion={snapshot.version} build={null} buildVersion={null} buildState="idle" dirty={snapshot.dirty}
        canUndo={snapshot.canUndo} canRedo={snapshot.canRedo} onEdit={edit => { session.edit([edit]); }} onEditMany={edits => session.edit(edits)} onPrepareEdits={onPrepareEdits}
        onInspectSketchConstraints={inspect} onWorkflowChange={open => session.setWorkflowOpen(open)} onUndo={() => session.undo()} onRedo={() => session.redo()} onStatusMessage={statusMessage}
        onSave={save} onBack={vi.fn()} onSendToCam={sendToCam} onOpenDocument={vi.fn()} onNewDocument={vi.fn()} onImportDocument={async () => undefined}
        onExportDocument={vi.fn()} onExportSolid={async () => undefined} onOpenDxfExport={async () => undefined} onViewportControlsReady={controls => { currentViewport = controls; }} />;
    }
    await act(async () => root.render(<Harness />));
    return { session, answers, answer: async (index: number, analysis: CadSketchConstraintAnalysis) => act(async () => answers[index].resolve(analysis)) };
  }
  const status = () => container.querySelector('[aria-label="Sketch constraint status"]')?.textContent;
  const entity = (id: string) => { const found = container.querySelector(`[data-cad-sketch-entity="${id}"]`); if (!found) throw new Error(`Edge ${id} missing.`); return found; };
  const point = (id: string) => { const found = container.querySelector(`[data-cad-sketch-point="${id}"]`); if (!found) throw new Error(`Point ${id} missing.`); return found; };
  const marked = (mark: string) => [...container.querySelectorAll(`.cad-sketch-graph .is-${mark}`)].map(item => item.getAttribute('data-cad-sketch-entity') ?? `point ${item.getAttribute('data-cad-sketch-point')}`).sort();
  const keyDown = async (target: Element, key: string) => act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
  const sketchFeature = (id: string, points: readonly (readonly [string, number, number])[], entities: readonly object[], relations: readonly object[] = [], profiles: readonly object[] = []) => ({
    id, kind: 'sketch', name: id === 'sketch' ? 'Bracket' : 'Second', plane: 'XY', offset: 0, suppressed: false, profiles,
    graph: { points: points.map(([pointId, x, y]) => ({ id: pointId, position: [x, y] })), entities, relations } });
  const bracketPoints = [['a', 0, 0], ['b', 20, 0], ['c', 0, 10], ['d', 20, 12], ['e', 40, 5], ['f', 0, -10], ['g', 20, -10]] as const;
  const bracketEdges = [{ id: 'base', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' }, { id: 'free', kind: 'line', construction: false, startPointId: 'c', endPointId: 'd' },
    { id: 'guide', kind: 'line', construction: true, startPointId: 'f', endPointId: 'g' }, { id: 'bore', kind: 'circle', construction: false, centerPointId: 'e', radius: 5 }];

  it('colours each defined part of a partly defined sketch, keeps legacy profiles and references as they are, and locks only defined points', async () => {
    const plate = { id: 'plate', name: 'Plate', construction: false, role: 'outer', geometry: { kind: 'rectangle', x: 60, y: 0, width: 30, height: 20, cornerRadius: 0 } };
    const source = parseCadDocument({ ...createCadDocument('Bracket', 'definition-bracket'), schemaVersion: 2, features: [sketchFeature('sketch', bracketPoints, bracketEdges, [], [plate])] });
    const h = await mountAnalysed(source);
    await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }));
    expect(marked('defined')).toEqual([]);
    // The base and the construction guide are fully defined, the free line is not, and the bore has no answer.
    await h.answer(0, solved(4, { points: ['a', 'b', 'f', 'g'], entities: ['base', 'guide'] }, { points: ['c', 'd'], entities: ['free'] }));
    expect(status()).toBe('Under defined · 4 DOF');
    expect(marked('defined')).toEqual(['base', 'guide', 'point a', 'point b', 'point f', 'point g']);
    expect(entity('guide').classList.contains('is-construction')).toBe(true);
    const legacy = container.querySelector('[aria-label="Select Plate profile"]'); if (!legacy) throw new Error('Legacy profile missing.');
    expect(legacy.classList.contains('is-defined')).toBe(false);
    expect([...container.querySelectorAll('[data-cad-sketch-fixed]')].filter(item => item.classList.contains('is-defined'))).toEqual([]);
    expect(point('a').classList.contains('is-locked')).toBe(true); expect(point('a').querySelector('title')?.textContent).toContain('Fully defined by dimensions and relations');
    expect(point('c').classList.contains('is-locked')).toBe(false);
    // Selection draws over the definition colour without dropping it.
    await act(async () => viewport().apply({ kind: 'select-sketch-geometry', selection: { kind: 'entity', id: 'base' } }));
    expect(entity('base').classList.contains('is-selected')).toBe(true); expect(entity('base').classList.contains('is-defined')).toBe(true);
    await act(async () => viewport().apply({ kind: 'select-sketch-geometry', selection: { kind: 'point', id: 'a' } }));
    expect(point('a').classList.contains('is-active')).toBe(true); expect(point('a').classList.contains('is-defined')).toBe(true);
    // A defined point refuses a nudge; an under-defined one moves.
    await keyDown(point('a'), 'ArrowRight'); expect(currentDocument).toBe(source);
    await keyDown(point('c'), 'ArrowRight'); expect(currentDocument).not.toBe(source);
    const moved = currentDocument.features[0]; if (moved.kind !== 'sketch' || !moved.graph) throw new Error('Sketch graph missing.');
    expect(moved.graph.points.find(item => item.id === 'c')?.position).not.toEqual([0, 10]);
    // The moved sketch waits for its own answer: colours stay, locks go.
    expect(status()).toBe('Checking freedom…'); expect(marked('defined')).toContain('base'); expect(point('a').classList.contains('is-locked')).toBe(false);
  });

  it('keeps dimension selection, focus and Delete working over defined geometry, where a lock refuses only moves', async () => {
    setCadPreferences({ ...getCadPreferences(), showOnPartDimensions: true });
    const source = parseCadDocument({ ...createCadDocument('Bracket', 'definition-dimension'), schemaVersion: 2, features: [
      sketchFeature('sketch', bracketPoints, bracketEdges, [{ id: 'length', kind: 'distance', pointIds: ['a', 'b'], value: 20 }])] });
    const h = await mountAnalysed(source);
    await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }));
    const defineBase = () => h.answer(h.answers.length - 1, solved(6, { points: ['a', 'b', 'f', 'g'], entities: ['base', 'guide'] }));
    await defineBase(); expect(point('a').classList.contains('is-locked')).toBe(true);
    const label = () => { const found = container.querySelector<SVGGElement>('[data-cad-sketch-dimension="length"] [role="button"]'); if (!found) throw new Error('Length label missing.'); return found; };
    const selectedDimensions = () => [...container.querySelectorAll('[data-cad-sketch-dimension].is-selected')].map(item => item.getAttribute('data-cad-sketch-dimension'));
    const highlighted = () => [...container.querySelectorAll('[data-cad-highlight-point], [data-cad-highlight-entity]')].map(item => item.getAttribute('data-cad-highlight-point') ?? item.getAttribute('data-cad-highlight-entity')).sort();
    const graph = () => { const feature = currentDocument.features[0]; if (feature.kind !== 'sketch' || !feature.graph) throw new Error('Sketch missing.'); return feature.graph; };
    // The selected dimension's highlight draws above the green rows, which keep their definition.
    await act(async () => label().dispatchEvent(new MouseEvent('click', { button: 0, detail: 1, bubbles: true, cancelable: true })));
    expect(selectedDimensions()).toEqual(['length']); expect(highlighted()).toEqual(['a', 'b', 'base']);
    expect(marked('defined')).toEqual(['base', 'guide', 'point a', 'point b', 'point f', 'point g']);
    expect(entity('base').compareDocumentPosition(container.querySelector('[data-cad-sketch-highlight]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Focus on a defined point leaves the selection, and Delete there removes the selected dimension, not the point.
    await act(async () => (point('a') as SVGGElement).focus()); expect(selectedDimensions()).toEqual(['length']);
    await keyDown(point('a'), 'Delete');
    expect(graph().relations.map(relation => relation.id)).toEqual([]); expect(graph().points.map(item => item.id)).toContain('a');
    // Once the new version is defined too, a press on a defined point still selects it, and Delete on another focused
    // defined point removes that selection; with nothing selected, Delete removes the focused defined point.
    await defineBase(); expect(point('a').classList.contains('is-locked')).toBe(true);
    const canvas = container.querySelector<SVGSVGElement>('[aria-label="Sketch drawing canvas"]'); if (!canvas) throw new Error('Sketch canvas missing.');
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, toJSON: () => ({}) });
    const view = viewport().getState().view; if (!view || view.mode === 'solid') throw new Error('Sketch frame missing.');
    const viewWidth = Number(canvas.getAttribute('viewBox')?.split(' ')[2]);
    for (const type of ['pointerdown', 'pointerup']) await act(async () => {
      const event = new MouseEvent(type, { button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true,
        clientX: 300 + (0 - view.centerMm[0]) / viewWidth * 600, clientY: 200 - (0 - view.centerMm[1]) / view.heightSpanMm * 400 });
      Object.defineProperties(event, { pointerId: { value: 12 }, isPrimary: { value: true } });
      point('a').dispatchEvent(event);
    });
    expect(point('a').classList.contains('is-active')).toBe(true);
    await act(async () => (point('b') as SVGGElement).focus()); await keyDown(point('b'), 'Delete');
    expect(graph().points.map(item => item.id)).not.toContain('a'); expect(graph().points.map(item => item.id)).toContain('b');
    await defineBase(); expect(point('f').classList.contains('is-locked')).toBe(true);
    await act(async () => (point('f') as SVGGElement).focus()); await keyDown(point('f'), 'Delete');
    expect(graph().points.map(item => item.id)).not.toContain('f');
  });

  it('never applies an older answer to parameter changes, undo or another sketch, and keeps colours until the new answer', async () => {
    const source = parseCadDocument({ ...createCadDocument('Bracket', 'definition-stale'), schemaVersion: 2, parameters: { w: 2 }, features: [
      sketchFeature('sketch', bracketPoints, bracketEdges), sketchFeature('second', bracketPoints, bracketEdges)] });
    const h = await mountAnalysed(source);
    await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }));
    await h.answer(0, solved(6, { points: ['a', 'b'], entities: ['base'] }));
    expect(marked('defined')).toEqual(['base', 'point a', 'point b']); expect(point('a').classList.contains('is-locked')).toBe(true);
    // A parameter change while the new analysis is pending keeps the colours but never the locks.
    await act(async () => h.session.edit([{ kind: 'set-parameter', name: 'w', value: 3 }]));
    expect(status()).toBe('Checking freedom…'); expect(h.answers).toHaveLength(2);
    expect(marked('defined')).toEqual(['base', 'point a', 'point b']); expect(point('a').classList.contains('is-locked')).toBe(false);
    await keyDown(point('a'), 'ArrowRight');
    const nudged = currentDocument; expect(nudged.features[0]).not.toBe(source.features[0]);
    // Undo restores the earlier document object under a new version, so its answer still does not lock.
    await act(async () => h.session.undo());
    expect(currentDocument.parameters).toEqual({ w: 3 }); expect(point('a').classList.contains('is-locked')).toBe(false);
    await act(async () => h.session.undo()); expect(currentDocument).toBe(source);
    expect(point('a').classList.contains('is-locked')).toBe(false); expect(marked('defined')).toEqual(['base', 'point a', 'point b']);
    // Answers for the versions undo left behind change nothing.
    for (const index of h.answers.keys()) if (index > 0 && index < h.answers.length - 1) await h.answer(index, solved(0, { points: bracketPoints.map(([id]) => id), entities: ['base', 'free', 'guide', 'bore'] }));
    expect(point('a').classList.contains('is-locked')).toBe(false); expect(marked('defined')).toEqual(['base', 'point a', 'point b']);
    // The current answer replaces the colours and locks.
    await h.answer(h.answers.length - 1, solved(4, { points: ['c', 'd'], entities: ['free'] }));
    expect(marked('defined')).toEqual(['free', 'point c', 'point d']);
    expect([point('a').classList.contains('is-locked'), point('c').classList.contains('is-locked')]).toEqual([false, true]);
    // Another sketch with the same identities shows nothing until its own answer arrives.
    await click('Finish sketch'); await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'second' }));
    expect(h.answers.at(-1)?.sketchId).toBe('second');
    expect(marked('defined')).toEqual([]); expect(point('c').classList.contains('is-locked')).toBe(false);
    await h.answer(h.answers.length - 1, solved(6, { points: ['a', 'b'], entities: ['base'] }));
    expect(marked('defined')).toEqual(['base', 'point a', 'point b']); expect(point('a').classList.contains('is-locked')).toBe(true);
  });

  it('keeps the freedom, colours and locks through each dimension move without a frame that drops them, and asks again after a geometry change', async () => {
    const span = { id: 'span', kind: 'distance', pointIds: ['a', 'b'], value: 20 } as const;
    const source = parseCadDocument({ ...createCadDocument('Bracket', 'definition-placed'), schemaVersion: 2, features: [sketchFeature('sketch', bracketPoints, bracketEdges, [span])] });
    const h = await mountAnalysed(source);
    await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }));
    await h.answer(0, solved(4, { points: ['a', 'b'], entities: ['base'] }));
    expect(status()).toBe('Under defined · 4 DOF'); expect(point('a').classList.contains('is-locked')).toBe(true);
    // Every commit is watched, so a render that showed the move without its analysis would leave a record.
    const records: MutationRecord[] = [], changes = new MutationObserver(list => { records.push(...list); });
    changes.observe(container, { subtree: true, attributes: true, attributeFilter: ['class'], characterData: true, childList: true });
    const kept = () => [...records.splice(0), ...changes.takeRecords()].filter(record => {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      return Boolean(target?.closest('[aria-label="Sketch constraint status"]') || record.attributeName === 'class' && target?.closest('[data-cad-sketch-point], [data-cad-sketch-entity]'));
    });
    for (const offset of [4, -6]) {
      const relation = { ...span, annotation: { kind: 'linear', offset, along: 0.5 } } as CadSketchGraphRelation;
      await act(async () => h.session.edit([{ kind: 'set-sketch-relation', sketchId: 'sketch', relation }]));
      expect(kept()).toEqual([]);
      expect(status()).toBe('Under defined · 4 DOF'); expect(point('a').classList.contains('is-locked')).toBe(true); expect(marked('defined')).toEqual(['base', 'point a', 'point b']);
    }
    expect(h.answers).toHaveLength(1);
    // Moving geometry is no dimension move: the locks wait for its own answer.
    await keyDown(point('c'), 'ArrowRight');
    expect(h.answers).toHaveLength(2); expect(status()).toBe('Checking freedom…'); expect(point('a').classList.contains('is-locked')).toBe(false);
    expect(kept().length).toBeGreaterThan(0);
    changes.disconnect();
  });

  it('marks every operand of a rejected preview beyond the eight it lists until the preview ends, over the analysis marks', async () => {
    const rungs = Array.from({ length: 11 }, (_, index) => index);
    const source = parseCadDocument({ ...createCadDocument('Ladder', 'definition-ladder'), schemaVersion: 2, features: [sketchFeature('sketch',
      [...rungs.flatMap(index => [[`l${index}`, 0, index * 5], [`r${index}`, 10, index * 5]] as const), ['t0', 0, -20], ['t1', 30, -15]],
      [...rungs.map(index => ({ id: `rung${index}`, kind: 'line', construction: false, startPointId: `l${index}`, endPointId: `r${index}` })),
        { id: 'target', kind: 'line', construction: false, startPointId: 't0', endPointId: 't1' }],
      [...rungs.slice(1).map(index => ({ id: `eq${index - 1}`, kind: 'equal-length', lineIds: [`rung${index - 1}`, `rung${index}`] })),
        { id: 'span', kind: 'distance', pointIds: ['t0', 't1'], value: Math.hypot(30, 5) }])] });
    const sketch = source.features[0]; if (sketch.kind !== 'sketch' || !sketch.graph) throw new Error('Ladder missing.');
    const graph = sketch.graph, equalIds = graph.relations.filter(relation => relation.kind === 'equal-length').map(relation => relation.id);
    const prepare = vi.fn<NonNullable<CadWorkbenchProps['onPrepareEdits']>>(async edits => {
      const added = edits.flatMap(edit => edit.kind === 'set-sketch-relation' ? [edit.relation] : []);
      throw new CadSketchPreparationError({ sketchId: 'sketch', sketchName: 'Ladder', graph: { ...graph, relations: [...graph.relations, ...added] }, rejection: { kind: 'rejected', reason: 'conflicting',
        message: 'Conflicting', diagnostics: { status: 'failed', degreesOfFreedom: null, conflictingIds: added.map(relation => relation.id), redundantIds: equalIds, partiallyRedundantIds: [], issues: [] } } });
    });
    const h = await mountAnalysed(source, prepare);
    await act(async () => viewport().apply({ kind: 'edit-sketch', sketchId: 'sketch' }));
    // An analysis the solver rejects marks its own operands.
    await h.answer(0, { kind: 'rejected', reason: 'redundant', message: 'Redundant.', diagnostics: { status: 'failed', degreesOfFreedom: null, conflictingIds: [], redundantIds: ['eq0'], partiallyRedundantIds: [], issues: [] } });
    expect(status()).toBe('Redundant relations');
    const analysisMarks = ['point l0', 'point l1', 'point r0', 'point r1', 'rung0', 'rung1'];
    expect(marked('redundant')).toEqual(analysisMarks); expect(marked('conflicting')).toEqual([]);
    await act(async () => viewport().apply({ kind: 'select-sketch-geometry', selection: { kind: 'entity', id: 'target' } }));
    // The Dimension tool selects the line's existing length, and Enter opens its editor, whose preview the solver rejects.
    await click('Dimension'); await canvasKey('Enter'); await canvasKey('Enter'); const length = container.querySelector<HTMLInputElement>('input[aria-label="Length mm"]'); if (!length) throw new Error('Length field missing.'); await input(length, '40');
    for (let turn = 0; turn < 3; turn++) await act(async () => new Promise(resolve => setTimeout(resolve, 125)));
    expect(prepare).toHaveBeenCalled();
    // All ten redundant relations hold their lines, though the header lists eight subjects and counts the rest.
    await act(async () => container.querySelector<HTMLButtonElement>('[data-cad-sketch-issues]')!.click());
    expect(container.querySelectorAll('ul[aria-label="Constraint issues"] > li > button')).toHaveLength(8);
    expect(container.querySelector('.cad-sketch-header-issue-more')?.textContent).toMatch(/^\d+ more affected items$/);
    expect(marked('redundant')).toEqual([...rungs.flatMap(index => [`point l${index}`, `point r${index}`]), ...rungs.map(index => `rung${index}`)].sort());
    expect(marked('conflicting')).toEqual(['point t0', 'point t1']);
    expect(point('t0').classList.contains('is-revealed')).toBe(true);
    // Ending the preview returns to the analysis marks.
    await click('Cancel');
    expect(marked('conflicting')).toEqual([]); expect(marked('redundant')).toEqual(analysisMarks);
    expect(currentDocument).toBe(source);
  });
});
