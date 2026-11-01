import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AxesHelper, GridHelper, LineDashedMaterial, LineSegments, Mesh, MeshBasicMaterial, MeshStandardMaterial, OrthographicCamera, Vector3, type Camera, type Plane, type Scene } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { CadMesh, CadSketchFeature } from '@/domain/cad/cadDocument';
import { CadViewport, type CadSketchBackgroundView } from './CadViewport';
import { cadPrincipalFrame } from '@/domain/cad/cadDatumPlanes';
import { createCadSketchCameraLink } from './view/cadSketchCamera';
import { CAD_SKETCH_DIM_AMOUNT } from './view/cadSketchBackgroundStyle';
import type { CadRenderedViewControls } from './cadViewportControls';
import { prepareCadCurveReferences } from './cadCurveRendering';
import { CAD_PRINCIPAL_PLANE_REFERENCES, prepareCadViewportReferences, type CadViewportReference } from './cadViewportReferences';
import { createCadDocument } from '@/domain/cad/cadSchema';
import { CadSession } from './cadSession';
import { createCadWorkbenchViewportControls, type CadViewportBindings } from './cadWorkbenchViewport';
import { cadViewportMetadataToken } from './cadViewportToolReplies';

interface MockRenderer {
  readonly domElement: HTMLCanvasElement;
  lost: boolean;
  readonly render: ReturnType<typeof vi.fn<(scene: Scene, camera: Camera) => void>>;
  readonly dispose: ReturnType<typeof vi.fn>;
  readonly forceContextLoss: ReturnType<typeof vi.fn>;
}
const renderers = vi.hoisted((): MockRenderer[] => []);
const rasterize = vi.hoisted(() => vi.fn());
vi.mock('@/features/editor/captureEditorPreview', () => ({ captureCanvas: rasterize }));
vi.mock('three', async importOriginal => {
  const original = await importOriginal<typeof import('three')>();
  return { ...original, WebGLRenderer: class {
    domElement = document.createElement('canvas');
    lost = false;
    render = vi.fn((_scene: Scene, _camera: Camera) => undefined);
    dispose = vi.fn();
    forceContextLoss = vi.fn(() => { this.lost = true; });
    constructor() { renderers.push(this); }
    setPixelRatio() {}
    setSize(width: number, height: number) { this.domElement.width = width; this.domElement.height = height; }
    getContext() { return { isContextLost: () => this.lost }; }
  } };
});

const mesh: CadMesh = { featureId: 'body', name: 'Body', positions: [0, 0, 0, 10, 0, 0, 0, 10, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
  indices: [0, 1, 2], edges: [0, 0, 0, 10, 0, 0], faceGroups: [], edgeGroups: [], volume: 100, bounds: { min: [0, 0, 0], max: [10, 10, 10] } };
let root: Root; let container: HTMLDivElement; let controls: CadRenderedViewControls | null;
let frames: Map<number, FrameRequestCallback>; let nextFrame: number;
function renderer() { const current = renderers.at(-1); if (!current) throw new Error('Renderer unavailable'); return current; }
function currentControls() { if (!controls) throw new Error('Viewport controls unavailable'); return controls; }
function solidViewState() { const state = currentControls().getState(); if (state.mode !== 'solid') throw new Error('World viewport unavailable'); return state; }
beforeEach(() => {
  controls = null; renderers.length = 0; frames = new Map(); nextFrame = 1;
  rasterize.mockReset().mockReturnValue({ dataUrl: 'data:image/png;base64,AA==', width: 800, height: 600, source: '3d' });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = nextFrame++; frames.set(id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function mount() { await act(async () => root.render(<CadViewport meshes={[mesh]} selectedId="body" onSelect={vi.fn()} onControlsReady={value => { controls = value; }} />)); }
async function flushFrame() {
  await act(async () => {
    const callbacks = [...frames.values()]; frames.clear();
    callbacks.forEach(callback => callback(performance.now()));
  });
}
async function loseContext() { await act(async () => { renderer().lost = true; renderer().domElement.dispatchEvent(new Event('webglcontextlost')); }); }

it('draws clean near-smooth boundaries, retains exact face order and exposes every native edge only in Edge mode without moving the camera', async () => {
  const a = 8 * Math.PI / 180, s = Math.sin(a), c = Math.cos(a);
  const source: CadMesh = { ...mesh, featureId: 'fold',
    positions: [-1,0,0, 0,0,0, 0,1,0, -1,1,0, 0,0,0, c,0,-s, c,1,-s, 0,1,0],
    normals: [0,0,1, 0,0,1, 0,0,1, 0,0,1, s,0,c, s,0,c, s,0,c, s,0,c],
    indices: [0,1,2, 0,2,3, 4,5,6, 4,6,7], edges: [0,0,0, 0,1,0, -1,0,0, -1,1,0],
    faceGroups: [{key:'left',start:0,count:6},{key:'right',start:6,count:6}],
    edgeGroups: [{key:'seam',start:0,count:2},{key:'boundary',start:2,count:2}], bounds: {min:[-1,0,-s],max:[c,1,0]} };
  const original = structuredClone(source);
  const show = async (pickMode: 'body' | 'edge') => act(async () => root.render(<CadViewport meshes={[source]} selectedId="fold" onSelect={vi.fn()} pickMode={pickMode} onControlsReady={value => { controls = value; }} />));
  const drawnLines = () => {
    const scene = renderer().render.mock.calls.at(-1)![0], counts: number[] = [];
    scene.traverse(child => { if (child instanceof LineSegments && child.userData.featureId === 'fold' && child.visible && !Array.isArray(child.material) && child.material.visible) counts.push(child.geometry.getAttribute('position').count); });
    return counts;
  };
  await show('body'); await flushFrame();
  expect(drawnLines()).toEqual([2]);
  const before = solidViewState();
  const scene = renderer().render.mock.calls.at(-1)![0];
  scene.traverse(child => { if (child instanceof Mesh && child.userData.featureId === 'fold') {
    expect(Array.from(child.geometry.index!.array)).toEqual(source.indices);
    expect(child.geometry.getAttribute('normal').getX(1)).toBeCloseTo(Math.sin(4 * Math.PI / 180), 6);
  } });
  await show('edge'); await flushFrame(); expect(drawnLines()).toEqual([4]);
  expect(solidViewState()).toMatchObject({view:before.view,zoom:before.zoom});
  await show('body'); await flushFrame(); expect(drawnLines()).toEqual([2]);
  expect(source).toEqual(original);
});

it('keeps a settled ordinary viewport revision stable through repeated real-Orbit capture without owned depth or areas', async () => {
  await mount(); await flushFrame();
  for (let attempt = 0; attempt < 4; attempt++) {
    const before = currentControls().getState();
    await act(async () => { await currentControls().capture(new AbortController().signal); });
    expect(currentControls().getState()).toEqual(before);
  }
});

it('publishes actual viewport resizing once, keeps same-size notifications quiet, and rejects capture/token identity after a real midcapture resize', async () => {
  let resized: ResizeObserverCallback | undefined;
  vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { resized = callback; } observe() {} disconnect() {} });
  const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  const notify = () => resized?.([], {} as ResizeObserver);
  await mount(); await flushFrame();
  const session = new CadSession(createCadDocument('Rendered part', 'rendered_part')), snapshot = session.getSnapshot();
  const bindings: CadViewportBindings = {
    document: snapshot.document, documentVersion: snapshot.version, dirty: false, selectedFeatureId: null, selectedProfileId: null,
    selectedSketchGeometrySet: [], selectedReferencePlane: null, awaitingSketchPlane: false, sketchId: null, curveId: null, workflowOpen: false, busy: false,
    buildVersion: snapshot.version, buildId: 'build', buildState: 'ready', visibleBodyIds: [], visibleReferenceIds: [], visibleReferencePlanes: [],
    pickMode: 'body', topologySelection: null, meshes: [mesh], rendered: currentControls(),
    selectFeature: vi.fn(), selectReferencePlane: vi.fn(), editSketch: vi.fn(), editCurve: vi.fn(), selectProfile: vi.fn(), selectSketchGeometrySet: vi.fn(), finishSketch: vi.fn(), finishCurve: vi.fn(),
    selectTopology: vi.fn(), setPickMode: vi.fn(), updateView: action => action()
  };
  const boundary = createCadWorkbenchViewportControls(() => bindings), before = boundary.getState(), token = cadViewportMetadataToken(session, before);
  await act(async () => notify()); await flushFrame(); expect(boundary.getState()).toEqual(before);
  await act(async () => { width.mockReturnValue(900); notify(); }); await flushFrame();
  expect(boundary.getState().view?.revision).toBe((before.view?.revision ?? 0) + 1);
  expect(cadViewportMetadataToken(session, boundary.getState())).not.toBe(token);
  const afterResize = boundary.getState(); await act(async () => notify()); await flushFrame(); expect(boundary.getState()).toEqual(afterResize);
  await act(async () => { await expect(boundary.capture(new AbortController().signal)).resolves.toMatchObject({ viewState: afterResize }); });
  rasterize.mockImplementationOnce(() => { width.mockReturnValue(1000); notify(); return { dataUrl: 'data:image/png;base64,AA==', width: 900, height: 600, source: '3d' }; });
  await act(async () => { await expect(boundary.capture(new AbortController().signal)).rejects.toMatchObject({ code: 'STALE_VIEW' }); });
  expect(boundary.getState().view?.revision).toBe((afterResize.view?.revision ?? 0) + 1); expect(session.getSnapshot()).toEqual(snapshot);
});

it('fits 3D geometry within current unobscured pixels without reframing when an inspector changes', async () => {
  let area = { left: 0, top: 0, width: 350, height: 600 };
  const getFitArea = () => area;
  const farMesh: CadMesh = { ...mesh, positions: mesh.positions.map((value, index) => value + [100000000, -200000000, 300000000][index % 3]),
    edges: mesh.edges.map((value, index) => value + [100000000, -200000000, 300000000][index % 3]),
    bounds: { min: [100000000, -200000000, 300000000], max: [100000010, -199999990, 300000000] } };
  const show = async () => act(async () => root.render(<CadViewport meshes={[farMesh]} selectedId="body" onSelect={vi.fn()} getFitArea={getFitArea} onControlsReady={value => { controls = value; }} />));
  await show(); await flushFrame();
  const camera = renderer().render.mock.calls.at(-1)![1];
  const check = () => {
    camera.updateMatrixWorld();
    for (let index = 0; index < farMesh.positions.length; index += 3) {
      const point = new Vector3(...farMesh.positions.slice(index, index + 3)).project(camera);
      const x = (point.x + 1) * 400, y = (1 - point.y) * 300;
      expect(x).toBeGreaterThanOrEqual(area.left); expect(x).toBeLessThanOrEqual(area.left + area.width);
      expect(y).toBeGreaterThanOrEqual(area.top); expect(y).toBeLessThanOrEqual(area.top + area.height);
    }
  };
  check(); const position = camera.position.clone(), zoom = solidViewState().zoom;
  area = { left: 0, top: 35, width: 800, height: 565 }; await show(); await flushFrame();
  expect(camera.position.toArray()).toEqual(position.toArray()); expect(solidViewState().zoom).toBe(zoom);
  const direction = camera.getWorldDirection(new Vector3());
  await act(async () => currentControls().fit()); await flushFrame(); check();
  expect(camera.getWorldDirection(new Vector3()).dot(direction)).toBeCloseTo(1, 8);
  area = { left: 0, top: 0, width: 800, height: 600 }; const minimizedPosition = camera.position.clone(); await show(); await flushFrame();
  expect(camera.position.toArray()).toEqual(minimizedPosition.toArray());
  await act(async () => currentControls().fit()); await flushFrame(); check();
});

it('does not let Orbit zoom limits clip an explicit Fit into a narrow available area', async () => {
  const large: CadMesh = { ...mesh, positions: mesh.positions.map(value => value * 1000), edges: mesh.edges.map(value => value * 1000), bounds: { min: [0, 0, 0], max: [10000, 10000, 0] } };
  await act(async () => root.render(<CadViewport meshes={[large]} selectedId="body" onSelect={vi.fn()} getFitArea={() => ({ left: 0, top: 0, width: 60, height: 600 })} onControlsReady={value => { controls = value; }} />));
  await flushFrame();
  const camera = renderer().render.mock.calls.at(-1)![1]; camera.updateMatrixWorld();
  for (let index = 0; index < large.positions.length; index += 3) {
    const point = new Vector3(...large.positions.slice(index, index + 3)).project(camera);
    expect((point.x + 1) * 400).toBeGreaterThanOrEqual(0);
    expect((point.x + 1) * 400).toBeLessThanOrEqual(60);
    expect((1 - point.y) * 300).toBeGreaterThanOrEqual(0);
    expect((1 - point.y) * 300).toBeLessThanOrEqual(600);
  }
});

it('preserves a large-part Fit zoom through named-view OrbitControls recreation and capture', async () => {
  const large: CadMesh = { ...mesh, positions: mesh.positions.map(value => value * 1000), edges: mesh.edges.map(value => value * 1000), bounds: { min: [0, 0, 0], max: [10000, 10000, 0] } };
  await act(async () => root.render(<CadViewport meshes={[large]} selectedId="body" onSelect={vi.fn()} getFitArea={() => ({ left: 0, top: 0, width: 60, height: 600 })} onControlsReady={value => { controls = value; }} />));
  await flushFrame();
  const zoom = solidViewState().zoom; expect(zoom).toBeLessThan(0.01);
  for (const view of ['Top', 'Front', 'Top', 'Isometric'] as const) {
    await act(async () => currentControls().setView?.(view));
    expect(solidViewState()).toMatchObject({ view, zoom });
    await currentControls().capture(new AbortController().signal);
    expect(solidViewState()).toMatchObject({ view, zoom });
  }
});

describe('hidden under a sketch surface', () => {
  it('keeps one graphics context and its camera, publishes no controls and defers model uploads until shown', async () => {
    const edited: CadMesh = { ...mesh, featureId: 'edited', bounds: { min: [0, 0, 0], max: [40, 40, 40] } };
    const view = async (meshes: readonly CadMesh[], hidden: boolean) => { await act(async () => root.render(<CadViewport hidden={hidden} meshes={meshes} selectedId="body" onSelect={vi.fn()} onControlsReady={value => { controls = value; }} />)); };
    await view([mesh], false); await flushFrame();
    const shown = currentControls(); await act(async () => shown.setView?.('Top'));
    const zoom = solidViewState().zoom; const drawn = renderer().render.mock.calls.length;
    await view([edited], true); await flushFrame();
    expect(controls).toBeNull(); expect(container.querySelector('button[aria-label="Fit model"]')).toBeNull();
    expect(renderer().render.mock.calls.length).toBe(drawn);
    const scene = renderer().render.mock.calls[0][0]; const ids = () => { const found = new Set<string>(); scene.traverse(object => { if (object.userData.featureId) found.add(object.userData.featureId); }); return found; };
    expect(ids().has('edited')).toBe(false);
    await view([edited], false); await flushFrame();
    expect(renderers).toHaveLength(1); expect(controls).toBe(shown); expect(container.querySelector('button[aria-label="Fit model"]')).not.toBeNull();
    // The user's chosen view survives; a part that already had its first frame is not refit.
    expect(solidViewState()).toMatchObject({ view: 'Top', zoom }); expect(ids()).toEqual(new Set(['edited']));
  });
});

describe('viewport pointer ownership and hover', () => {
  const meshes: readonly CadMesh[] = [{ ...mesh, faceGroups: [{ key: 'face', start: 0, count: 3 }], edgeGroups: [{ key: 'edge', start: 0, count: 2 }] }];
  type ViewportExtra = Partial<Pick<ComponentProps<typeof CadViewport>, 'onTopologyChain' | 'onTopologySet' | 'selectionFilter' | 'topologySelection' | 'references' | 'referenceVersion' | 'onSelectPlane'>>;
  async function harness(mode: 'body' | 'face' | 'edge' | 'auto' = 'body', extra: ViewportExtra = {}) {
    const select = vi.fn(), topology = vi.fn(), contextMenu = vi.fn();
    let more = extra;
    const show = async (locked = false, navigationLocked = locked, selectedId: string | null = null, navigationMode: 'mouse' | 'trackpad' = 'mouse') => { await act(async () => root.render(<CadViewport meshes={meshes} selectedId={selectedId} onSelect={select}
      {...{ navigationLocked, navigationMode, onContextMenu: contextMenu }} pickMode={mode} onTopologyPick={topology} interactionLocked={locked} onControlsReady={value => { controls = value; }} {...more} />)); };
    const update = async (next: ViewportExtra) => { more = { ...more, ...next }; await show(); };
    await show(); await act(async () => currentControls().setView?.('Top')); await flushFrame();
    const [scene, camera] = renderer().render.mock.calls.at(-1)!; scene.updateMatrixWorld(true); camera.updateMatrixWorld();
    const point = new Vector3(2, 2, 0).project(camera), x = (point.x + 1) * 400, y = (1 - point.y) * 300;
    const canvas = renderer().domElement; canvas.setPointerCapture = vi.fn(); canvas.releasePointerCapture = vi.fn();
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) });
    const pointer = async (type: string, id = 1, dx = 0, dy = 0, pointerType: 'touch' | 'mouse' | 'pen' = 'touch', button = 0, shiftKey = false) => { await act(async () => {
      const event = new MouseEvent(type, { bubbles: true, button, shiftKey, buttons: type === 'pointerdown' || type === 'pointermove' && dx ? button === 2 ? 2 : 1 : 0, clientX: x + dx, clientY: y + dy });
      Object.defineProperties(event, { pointerId: { value: id }, pointerType: { value: pointerType }, isPrimary: { value: id === 1 } });
      canvas.dispatchEvent(event);
    }); };
    /** Screen position of a model point in the top view. */
    const at = (modelX: number, modelY: number) => { const projected = new Vector3(modelX, modelY, 0).project(camera); return { dx: (projected.x + 1) * 400 - x, dy: (1 - projected.y) * 300 - y }; };
    const mouse = async (type: string, offset: { dx: number; dy: number }, init: MouseEventInit = {}) => act(async () => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x + offset.dx, clientY: y + offset.dy, ...init });
      Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'mouse' }, isPrimary: { value: true } });
      canvas.dispatchEvent(event);
    });
    const key = async (value: string, shiftKey = false) => act(async () => { canvas.dispatchEvent(new KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true })); });
    return { select, topology, contextMenu, show, update, pointer, canvas, x, y, at, mouse, key };
  }
  it('asks for a chain on double-click: a loop, a tangent chain with Alt, tangent faces on a face, and adds with Ctrl', async () => {
    const chain = vi.fn(), h = await harness('auto', { onTopologyChain: chain });
    const face = { bodyId: 'body', pick: { kind: 'face', key: 'face' } }, edge = { bodyId: 'body', pick: { kind: 'edge', key: 'edge' } };
    await h.mouse('dblclick', h.at(2, 2));
    expect(chain).toHaveBeenLastCalledWith(face, 'loop', false, null);
    await h.mouse('dblclick', h.at(2, 2), { ctrlKey: true });
    expect(chain).toHaveBeenLastCalledWith(face, 'loop', true, null);
    // On an edge the face under the pointer is named for the loop, when there is one.
    await h.mouse('dblclick', h.at(5, .05), { altKey: true });
    expect(chain).toHaveBeenLastCalledWith(edge, 'tangent', false, 'face');
    await h.mouse('dblclick', h.at(5, .05));
    expect(chain).toHaveBeenLastCalledWith(edge, 'loop', false, 'face');
    // Nothing under the pointer, a locked view or body picking asks for nothing.
    const calls = chain.mock.calls.length;
    await h.mouse('dblclick', h.at(40, 40)); await h.show(true); await h.mouse('dblclick', h.at(2, 2));
    expect(chain).toHaveBeenCalledTimes(calls);
    const body = await harness('body', { onTopologyChain: chain }); await body.mouse('dblclick', body.at(2, 2));
    expect(chain).toHaveBeenCalledTimes(calls); expect(h.topology).not.toHaveBeenCalled();
  });
  it('steps Select other with N through the edge and the face under the pointer, and back with Shift + N', async () => {
    const set = vi.fn(), h = await harness('auto', { onTopologySet: set });
    const selection = (key: 'edge' | 'face') => ({ documentVersion: 'v1', buildId: 'b1', bodyId: 'body', picks: [{ kind: key, key }] });
    // Without a pointer over the view, N does nothing.
    await h.key('n'); expect(set).not.toHaveBeenCalled();
    await h.mouse('pointermove', h.at(5, .05));
    await h.key('n'); expect(set).toHaveBeenLastCalledWith('body', [{ kind: 'edge', key: 'edge' }]);
    await h.update({ topologySelection: selection('edge') });
    await h.key('n'); expect(set).toHaveBeenLastCalledWith('body', [{ kind: 'face', key: 'face' }]);
    await h.update({ topologySelection: selection('face') });
    await h.key('n'); expect(set).toHaveBeenLastCalledWith('body', [{ kind: 'edge', key: 'edge' }]);
    await h.key('N', true); expect(set).toHaveBeenLastCalledWith('body', [{ kind: 'edge', key: 'edge' }]);
    // The filter limits the candidates as it limits clicks: with edges off only the face is left.
    await h.update({ selectionFilter: { excluded: ['edge'] }, topologySelection: null });
    await h.key('n'); expect(set).toHaveBeenLastCalledWith('body', [{ kind: 'face', key: 'face' }]);
    expect(set).toHaveBeenCalledTimes(5);
    // Right-click offers the same step when more than one candidate is under the pointer.
    await h.update({ selectionFilter: undefined });
    await h.pointer('pointerdown', 1, h.at(5, .05).dx, h.at(5, .05).dy, 'mouse', 2); await h.pointer('pointerup', 1, h.at(5, .05).dx, h.at(5, .05).dy, 'mouse', 2);
    const request = h.contextMenu.mock.lastCall?.[0];
    expect(request).toMatchObject({ target: { kind: 'topology', hit: { pick: { kind: 'edge' } } } });
    act(() => request.selectOther()); expect(set).toHaveBeenLastCalledWith('body', [{ kind: 'edge', key: 'edge' }]);
    expect(h.select).not.toHaveBeenCalled(); expect(h.topology).not.toHaveBeenCalled();
  });
  it('offers Select other on right-click over a datum plane that crosses a face', async () => {
    // A plane standing on the line y = 2, seen edge on from the top, runs through the face under the pointer.
    const references = prepareCadViewportReferences([{ id: 'mount', name: 'Mount', kind: 'datum-plane', suppressed: false, definition: { kind: 'world', basePlane: 'XZ', origin: [0, 2, 0], rotation: [0, 0, 0] } }], {});
    const set = vi.fn(), plane = vi.fn(), h = await harness('auto', { onTopologySet: set, onSelectPlane: plane, references, referenceVersion: 'v1' });
    const { dx, dy } = h.at(2, 2);
    await h.pointer('pointerdown', 1, dx, dy, 'mouse', 2); await h.pointer('pointerup', 1, dx, dy, 'mouse', 2);
    const request = h.contextMenu.mock.lastCall?.[0];
    expect(request).toMatchObject({ target: { kind: 'feature', featureId: 'mount' } }); expect(request.selectOther).toBeTypeOf('function');
    act(() => request.selectOther());
    expect(set).toHaveBeenLastCalledWith('body', [{ kind: 'face', key: 'face' }]); expect(plane).not.toHaveBeenCalled();
  });
  it('draws a window solid and a crossing dashed, and takes edges when the filter leaves bodies out', async () => {
    const set = vi.fn(), h = await harness('auto', { onTopologySet: set }); const overlay = () => container.querySelector<HTMLElement>('.cad-box-select');
    const drag = async (from: { dx: number; dy: number }, to: { dx: number; dy: number }) => {
      await h.mouse('pointerdown', from, { shiftKey: true, buttons: 1 }); await h.mouse('pointermove', to, { shiftKey: true, buttons: 1 });
      const crossing = overlay()?.classList.contains('is-crossing'); await h.mouse('pointerup', to, { shiftKey: true }); return crossing;
    };
    // Rightward around the whole triangle: a window, which takes the body.
    expect(await drag(h.at(-2, 12), h.at(12, -2))).toBe(false); expect(h.select).toHaveBeenLastCalledWith('body');
    // Leftward over only part of it: a crossing, which takes the body it touches; drawn rightward the same box holds nothing.
    expect(await drag(h.at(4, 4), h.at(-2, -2))).toBe(true); expect(h.select).toHaveBeenLastCalledWith('body');
    expect(await drag(h.at(-2, 4), h.at(4, -2))).toBe(false); expect(h.select).toHaveBeenLastCalledWith(null);
    await h.update({ selectionFilter: { excluded: ['body'] } });
    expect(await drag(h.at(-2, 12), h.at(12, -2))).toBe(false); expect(set).toHaveBeenLastCalledWith('body', [{ kind: 'edge', key: 'edge' }]);
    expect(h.topology).not.toHaveBeenCalled();
  });
  it('clears edge picks through the click operation when an edge box takes no edge, for a window and a crossing', async () => {
    const set = vi.fn(), h = await harness('edge', { onTopologySet: set });
    const drag = async (from: { dx: number; dy: number }, to: { dx: number; dy: number }) => {
      await h.mouse('pointerdown', from, { shiftKey: true, buttons: 1 }); await h.mouse('pointermove', to, { shiftKey: true, buttons: 1 });
      await h.mouse('pointerup', to, { shiftKey: true });
    };
    // A window and a crossing away from the triangle each clear, as a click on empty space does, so a chain still being read is dropped.
    await drag(h.at(20, 20), h.at(30, 10)); expect(h.topology).toHaveBeenCalledExactlyOnceWith(null, false);
    await drag(h.at(30, 20), h.at(20, 10)); expect(h.topology).toHaveBeenCalledTimes(2); expect(h.topology).toHaveBeenLastCalledWith(null, false);
    expect(set).not.toHaveBeenCalled();
    // A box round the triangle sets its edge instead, and an edge box never selects a body.
    await drag(h.at(-2, 12), h.at(12, -2)); expect(set).toHaveBeenCalledExactlyOnceWith('body', [{ kind: 'edge', key: 'edge' }]);
    expect(h.topology).toHaveBeenCalledTimes(2); expect(h.select).not.toHaveBeenCalled();
  });
  it('requires the initiating pointer to complete a pick without unrelated pointer-up cancelling its owner', async () => {
    const h = await harness();
    await h.pointer('pointerdown', 1, 0, 0, 'mouse'); await h.pointer('pointerup', 2, 0, 0, 'pen');
    expect(h.select).not.toHaveBeenCalled();
    await h.pointer('pointerup', 1, 0, 0, 'mouse');
    expect(h.select).toHaveBeenCalledExactlyOnceWith('body');
  });
  it.each(['pointerleave', 'lostpointercapture', 'blur'] as const)('cancels the pending pick after %s, allowing a new hover and click', async cancellation => {
    const h = await harness('face'); await h.pointer('pointerdown');
    if (cancellation === 'blur') await act(async () => window.dispatchEvent(new Event('blur')));
    else await h.pointer(cancellation);
    await h.pointer('pointerup'); expect(h.topology).not.toHaveBeenCalled();
    await h.pointer('pointermove'); await flushFrame();
    expect(solidViewState().hoveredTopology).toEqual({ bodyId: 'body', pick: { kind: 'face', key: 'face' } });
    await h.pointer('pointerdown'); await h.pointer('pointerup');
    expect(h.topology).toHaveBeenCalledExactlyOnceWith({ bodyId: 'body', pick: { kind: 'face', key: 'face' } }, false);
  });
  it.each(['pointercancel', 'lostpointercapture'] as const)('ends a Shift box selection after %s so the next click picks normally', async cancellation => {
    const h = await harness('auto'); const overlay = () => container.querySelector<HTMLElement>('.cad-box-select');
    await h.pointer('pointerdown', 1, -60, -60, 'mouse', 0, true); await h.pointer('pointermove', 1, 60, 60, 'mouse', 0, true);
    expect(overlay()?.hidden).toBe(false);
    await h.pointer(cancellation, 1, 60, 60, 'mouse');
    expect(overlay()?.hidden).toBe(true);
    // The cancelled rectangle never selects, and the box no longer swallows the next press.
    await h.pointer('pointerup', 1, 60, 60, 'mouse'); expect(h.select).not.toHaveBeenCalled(); expect(h.topology).not.toHaveBeenCalled();
    await h.pointer('pointerdown', 1, 0, 0, 'mouse'); await h.pointer('pointerup', 1, 0, 0, 'mouse');
    expect(h.select.mock.calls.length + h.topology.mock.calls.length).toBe(1);
  });
  it('does not turn an orbit drag returning to its start into a selection click', async () => {
    const h = await harness(); await h.pointer('pointerdown'); await h.pointer('pointermove', 1, 20); await h.pointer('pointermove'); await h.pointer('pointerup');
    expect(h.select).not.toHaveBeenCalled();
  });
  it('clears existing hover immediately when a workflow locks and cancels picks started before that lock', async () => {
    const h = await harness('face'); await h.pointer('pointermove'); await flushFrame();
    expect(solidViewState().hoveredTopology?.pick.key).toBe('face');
    await h.show(true); expect(solidViewState().hoveredTopology).toBeNull();
    await h.show(false); await h.pointer('pointerdown'); await h.show(true); await h.show(false); await h.pointer('pointerup');
    expect(h.topology).not.toHaveBeenCalled();
  });
  it('cancels a pick interrupted by graphics loss rather than replaying it after recovery', async () => {
    const h = await harness('face'); await h.pointer('pointerdown');
    await loseContext(); await act(async () => { renderer().lost = false; renderer().domElement.dispatchEvent(new Event('webglcontextrestored')); });
    await h.pointer('pointerup'); expect(h.topology).not.toHaveBeenCalled();
  });
  it('preselects the hovered body without changing the selected feature and restores its style on leave', async () => {
    const h = await harness(); const scene = renderer().render.mock.calls.at(-1)![0];
    let body: Mesh | undefined; scene.traverse(object => { if (object instanceof Mesh && object.userData.featureId === 'body') body = object; });
    if (!body || !(body.material instanceof MeshStandardMaterial)) throw new Error('Missing body material');
    const material = body.material, original = material.color.getHex(), revision = solidViewState().revision;
    await h.pointer('pointermove'); await flushFrame();
    expect(material.color.getHex()).not.toBe(original); expect(solidViewState().revision).toBeGreaterThan(revision);
    expect(h.select).not.toHaveBeenCalled();
    await h.pointer('pointerleave'); await flushFrame(); expect(material.color.getHex()).toBe(original);
  });
  it('opens target-specific menus for a stationary right click without changing selection', async () => {
    const h = await harness('face');
    await h.pointer('pointerdown', 1, 0, 0, 'mouse', 2); await h.pointer('pointerup', 1, 0, 0, 'mouse', 2);
    expect(h.contextMenu).toHaveBeenCalledExactlyOnceWith({ clientX: h.x, clientY: h.y, trigger: 'pointer', target: { kind: 'topology', hit: { bodyId: 'body', pick: { kind: 'face', key: 'face' } } } });
    expect(h.select).not.toHaveBeenCalled(); expect(h.topology).not.toHaveBeenCalled();
  });
  it('keeps right-drag panning without opening a menu even after returning to the start', async () => {
    const h = await harness(); const camera = renderer().render.mock.calls.at(-1)![1], before = camera.position.clone();
    await h.pointer('pointerdown', 1, 0, 0, 'mouse', 2); await h.pointer('pointermove', 1, 20, 0, 'mouse', 2);
    expect(camera.position.distanceTo(before)).toBeGreaterThan(0);
    await h.pointer('pointermove', 1, 0, 0, 'mouse', 2); await h.pointer('pointerup', 1, 0, 0, 'mouse', 2);
    expect(h.contextMenu).not.toHaveBeenCalled(); expect(h.select).not.toHaveBeenCalled();
  });
  it('supports keyboard context menus for visible selection, blocks locks and cancels interrupted right gestures', async () => {
    const h = await harness(); await h.show(false, false, 'body'); h.canvas.focus();
    const key = async (key: string, shiftKey = false) => act(async () => h.canvas.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })));
    await key('ContextMenu'); expect(h.contextMenu).toHaveBeenLastCalledWith({ clientX: 400, clientY: 300, trigger: 'keyboard', target: { kind: 'feature', featureId: 'body' } });
    await key('F10', true); expect(h.contextMenu).toHaveBeenCalledTimes(2);
    await h.show(true, false, 'body'); await key('ContextMenu'); expect(h.contextMenu).toHaveBeenCalledTimes(2);
    await h.show(false); await h.pointer('pointerdown', 1, 0, 0, 'mouse', 2); await h.pointer('pointerleave'); await h.pointer('pointerup', 1, 0, 0, 'mouse', 2);
    expect(h.contextMenu).toHaveBeenCalledTimes(2);
  });
  it('allows readonly navigation while editing picks and context actions remain locked', async () => {
    const h = await harness('face'); await h.show(true, false);
    const before = solidViewState(), camera = renderer().render.mock.calls.at(-1)![1], position = camera.position.clone();
    await h.pointer('pointerdown', 1, 0, 0, 'mouse'); await h.pointer('pointermove', 1, 30, 20, 'mouse'); await h.pointer('pointerup', 1, 30, 20, 'mouse');
    await flushFrame(); expect(camera.position.distanceTo(position)).toBeGreaterThan(0); expect(solidViewState().revision).toBeGreaterThan(before.revision);
    await act(async () => h.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true })));
    expect(solidViewState().zoom).toBeGreaterThan(before.zoom);
    await h.pointer('pointerdown'); await h.pointer('pointerup'); await h.pointer('pointerdown', 1, 0, 0, 'mouse', 2); await h.pointer('pointerup', 1, 0, 0, 'mouse', 2);
    expect(h.select).not.toHaveBeenCalled(); expect(h.topology).not.toHaveBeenCalled(); expect(h.contextMenu).not.toHaveBeenCalled();
    await h.show(true); const frozen = solidViewState().revision;
    await h.pointer('pointerdown', 1, 0, 0, 'mouse'); await h.pointer('pointermove', 1, 30, 20, 'mouse'); await h.pointer('pointerup', 1, 30, 20, 'mouse');
    expect(solidViewState().revision).toBe(frozen);
  });
  it.each(['Top', 'Front', 'Isometric'] as const)('pans trackpad wheel in the %s camera plane without changing zoom or direction', async view => {
    const h = await harness(); await h.show(false, false, null, 'trackpad'); await act(async () => currentControls().setView?.(view)); await flushFrame();
    const camera = renderer().render.mock.calls.at(-1)![1]; if (!(camera instanceof OrthographicCamera)) throw new Error('Missing orthographic camera');
    const position = camera.position.clone(), direction = camera.getWorldDirection(new Vector3()), zoom = camera.zoom;
    const right = new Vector3().setFromMatrixColumn(camera.matrix, 0), up = new Vector3().setFromMatrixColumn(camera.matrix, 1);
    const wheel = new WheelEvent('wheel', { deltaX: 24, deltaY: 12, bubbles: true, cancelable: true });
    await act(async () => h.canvas.dispatchEvent(wheel));
    const expected = right.multiplyScalar(24 * (camera.right - camera.left) / zoom / 800).add(up.multiplyScalar(-12 * (camera.top - camera.bottom) / zoom / 600));
    expect(camera.position.clone().sub(position).distanceTo(expected)).toBeLessThan(1e-9);
    expect(camera.getWorldDirection(new Vector3()).distanceTo(direction)).toBeLessThan(1e-10); expect(camera.zoom).toBe(zoom); expect(wheel.defaultPrevented).toBe(true);
    const pannedPosition = camera.position.clone(); await currentControls().capture(new AbortController().signal);
    expect(camera.position.distanceTo(pannedPosition)).toBeLessThan(1e-9);
  });
  it('normalizes trackpad line/page deltas, routes Alt-wheel to orbit and Ctrl-wheel to zoom only inside canvas', async () => {
    const h = await harness(); await h.show(false, false, null, 'trackpad');
    const camera = renderer().render.mock.calls.at(-1)![1], start = camera.position.clone(), direction = camera.getWorldDirection(new Vector3());
    const wheel = async (init: WheelEventInit, target: HTMLElement = h.canvas) => { const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init }); await act(async () => target.dispatchEvent(event)); return event; };
    await wheel({ deltaX: 1, deltaMode: 1 }); const lineMovement = camera.position.clone().sub(start);
    await wheel({ deltaX: -16 }); expect(camera.position.distanceTo(start)).toBeLessThan(1e-9);
    await wheel({ deltaX: .02, deltaMode: 2 }); expect(camera.position.clone().sub(start).distanceTo(lineMovement)).toBeLessThan(1e-9);
    const beforeOrbit = camera.position.clone(), target = new Vector3(5, 5, 0).add(lineMovement), radius = beforeOrbit.distanceTo(target);
    await wheel({ deltaX: 15, deltaY: -12, altKey: true });
    expect(camera.getWorldDirection(new Vector3()).distanceTo(direction)).toBeGreaterThan(.01); expect(camera.position.distanceTo(target)).toBeCloseTo(radius, 8);
    const zoom = solidViewState().zoom; await wheel({ deltaY: -10, ctrlKey: true }); expect(solidViewState().zoom).toBeGreaterThan(zoom);
    const revision = solidViewState().revision; const outside = await wheel({ deltaY: 50 }, container); expect(outside.defaultPrevented).toBe(false); expect(solidViewState().revision).toBe(revision);
    await h.show(true, true, null, 'trackpad'); const locked = solidViewState(); await wheel({ deltaX: 20, deltaY: 20 }); await wheel({ deltaY: -10, ctrlKey: true });
    expect(solidViewState()).toEqual(locked);
    await h.show(false, false); const mouseZoom = solidViewState().zoom; await wheel({ deltaY: -50 }); expect(solidViewState().zoom).toBeGreaterThan(mouseZoom);
  });
});

describe('datum glyph rendering', () => {
  it('clears selection on empty design space even when no native build is available', async () => {
    const selected = vi.fn(), selectedPlane = vi.fn();
    await act(async () => root.render(<CadViewport meshes={[]} references={CAD_PRINCIPAL_PLANE_REFERENCES} referenceVersion="blank" selectedId={null} selectedReferencePlane="XZ"
      onSelect={selected} onSelectPlane={selectedPlane} pickingEnabled={false} onControlsReady={value => { controls = value; }} />));
    await flushFrame(); const canvas = renderer().domElement; canvas.setPointerCapture = vi.fn(); canvas.releasePointerCapture = vi.fn();
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) });
    await act(async () => { for (const type of ['pointerdown', 'pointerup']) canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: 4, clientY: 4 })); });
    expect(selected).toHaveBeenCalledExactlyOnceWith(null); expect(selectedPlane).not.toHaveBeenCalled();
  });
  it.each(['XY', 'XZ', 'YZ'] as const)('picks the %s principal patch with the actual camera ray without a native build or invented feature ID', async plane => {
    const references = CAD_PRINCIPAL_PLANE_REFERENCES.filter(reference => reference.plane === plane), selected = vi.fn(), selectedPlane = vi.fn();
    await act(async () => root.render(<CadViewport meshes={[]} references={references} referenceVersion="blank" selectedId={null} onSelect={selected}
      onSelectPlane={selectedPlane} planePickingOnly pickingEnabled={false} onControlsReady={value => { controls = value; }} />));
    await flushFrame(); expect(solidViewState()).toMatchObject({ referenceFeatureIds: [], referencePlanes: [plane], available: true });
    const scene = renderer().render.mock.calls.at(-1)![0], camera = renderer().render.mock.calls.at(-1)![1]; camera.updateMatrixWorld();
    const patch: Mesh[] = []; scene.traverse(object => { if (object instanceof Mesh && object.userData.referenceId === `principal:${plane}`) patch.push(object); });
    expect(patch).toHaveLength(1); expect(patch[0].userData.featureId).toBeNull();
    const worldPoint = plane === 'XY' ? [6, 7, 0] : plane === 'XZ' ? [6, 0, 7] : [0, 6, 7];
    const point = new Vector3(...worldPoint).project(camera), canvas = renderer().domElement;
    canvas.setPointerCapture = vi.fn(); canvas.releasePointerCapture = vi.fn();
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) });
    await act(async () => { for (const type of ['pointerdown', 'pointerup']) canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0,
      clientX: (point.x + 1) * 400, clientY: (1 - point.y) * 300 })); });
    expect(selectedPlane).toHaveBeenCalledExactlyOnceWith(plane); expect(selected).not.toHaveBeenCalled();
  });
  const datum = { id: 'mount', name: 'Mount', kind: 'datum-plane', suppressed: false, definition: { kind: 'world', basePlane: 'XY', origin: [1e8, 1e8, 1e8], rotation: [30, 0, 0] } } as const;
  it('installs bounded plane resources and capture IDs, excludes glyphs from contour Fit and disposes them once', async () => {
    const references = prepareCadViewportReferences([datum, { id: 'outline', name: 'Outline', kind: 'sketch', suppressed: false, plane: 'XY', offset: 0,
      profiles: [{ id: 'circle', name: 'Circle', construction: false, geometry: { kind: 'circle', x: 0, y: 0, radius: 2 } }] }], {});
    const show = async (references: readonly CadViewportReference[], version: string) => {
      await act(async () => root.render(<CadViewport meshes={[]} references={references} referenceVersion={version} selectedId="mount" onSelect={vi.fn()} onControlsReady={value => { controls = value; }} />));
      await currentControls().capture(new AbortController().signal);
    };
    await show(references, 'v1'); expect(solidViewState()).toMatchObject({ zoom: 8.5, referenceVersion: 'v1', referenceFeatureIds: ['mount', 'outline'] });
    const scene = renderer().render.mock.calls.at(-1)![0]; const objects: (Mesh | LineSegments)[] = [];
    scene.traverse(object => { if (object.userData.featureId === 'mount' && (object instanceof Mesh || object instanceof LineSegments)) objects.push(object); });
    expect(objects).toHaveLength(2);
    const patch = objects.find(object => object instanceof Mesh)!; expect(patch.position.toArray().every(value => value > 1e8 - 20 && value < 1e8 + 20)).toBe(true);
    expect(Array.from(patch.geometry.getAttribute('position').array).every(value => Math.abs(value) < 20)).toBe(true);
    const disposed = objects.map(object => vi.spyOn(object.geometry, 'dispose'));
    await show(references, 'v2'); expect(disposed.every(spy => spy.mock.calls.length === 0)).toBe(true);
    await show([], 'v3'); expect(disposed.every(spy => spy.mock.calls.length === 1)).toBe(true);
    expect(solidViewState()).toMatchObject({ referenceVersion: 'v3', referenceFeatureIds: [] });
  });
  it('fits datum-only scenes and prioritizes contours over the plane patch in Body picking', async () => {
    const nearDatum = { ...datum, definition: { ...datum.definition, origin: [0, 0, 0] as const, rotation: [0, 0, 0] as const } };
    const references = prepareCadViewportReferences([nearDatum, { id: 'outline', name: 'Outline', kind: 'sketch', plane: 'XY', offset: 0, suppressed: false,
      profiles: [{ id: 'rectangle', name: 'Rectangle', construction: false, geometry: { kind: 'rectangle', x: -1, y: -1, width: 2, height: 2, cornerRadius: 0 } }] }], {});
    const selected = vi.fn(); const topology = vi.fn();
    const show = async (outlines: readonly CadViewportReference[], mode: 'body' | 'face' = 'body') => {
      await act(async () => root.render(<CadViewport meshes={[]} references={outlines} referenceVersion="current" selectedId={null} onSelect={selected}
        onTopologyPick={topology} pickMode={mode} onControlsReady={value => { controls = value; }} />));
      await currentControls().capture(new AbortController().signal);
    };
    await show(references.filter(reference => reference.featureKind === 'datum-plane'));
    expect(solidViewState()).toMatchObject({ referenceFeatureIds: ['mount'] }); expect(solidViewState().zoom).toBeGreaterThan(1);
    await show(references); await act(async () => currentControls().fit()); await currentControls().capture(new AbortController().signal);
    const camera = renderer().render.mock.calls.at(-1)![1]; camera.updateMatrixWorld();
    const point = new Vector3(1, 0, 0).project(camera);
    const canvas = renderer().domElement;
    canvas.setPointerCapture = vi.fn(); canvas.releasePointerCapture = vi.fn();
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) });
    const pick = async () => { await act(async () => {
      for (const type of ['pointerdown', 'pointerup']) renderer().domElement.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: (point.x + 1) * 400, clientY: (1 - point.y) * 300 }));
    }); };
    await pick(); expect(selected).toHaveBeenLastCalledWith('outline');
    selected.mockClear(); await show(references, 'face'); await pick(); expect(selected).not.toHaveBeenCalled(); expect(topology).toHaveBeenCalledWith(null, false);
  });
  it('keeps the pick and draw order of overlapping references when an earlier one is replaced and a later line is kept', async () => {
    const outline = (id: string, name = id): CadSketchFeature => ({ id, name, kind: 'sketch', plane: 'XY', offset: 0, suppressed: false,
      profiles: [{ id: 'rectangle', name: 'Rectangle', construction: false, geometry: { kind: 'rectangle', x: -1, y: -1, width: 2, height: 2, cornerRadius: 0 } }] });
    const [first, second] = prepareCadViewportReferences([outline('a'), outline('b')], {}), [renamed] = prepareCadViewportReferences([outline('a', 'Renamed')], {});
    const selected = vi.fn();
    const show = async (outlines: readonly CadViewportReference[], version: string) => {
      await act(async () => root.render(<CadViewport meshes={[]} references={outlines} referenceVersion={version} selectedId={null} onSelect={selected} onControlsReady={value => { controls = value; }} />));
      await currentControls().capture(new AbortController().signal);
    };
    await show([first, second], 'v1'); await act(async () => currentControls().fit()); await currentControls().capture(new AbortController().signal);
    const camera = renderer().render.mock.calls.at(-1)![1]; camera.updateMatrixWorld();
    const point = new Vector3(1, 0, 0).project(camera), canvas = renderer().domElement;
    canvas.setPointerCapture = vi.fn(); canvas.releasePointerCapture = vi.fn();
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) });
    const pick = async () => { await act(async () => {
      for (const type of ['pointerdown', 'pointerup']) canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: (point.x + 1) * 400, clientY: (1 - point.y) * 300 }));
    }); };
    // Three draws opaque objects by render order, then material, then object, so the later line covers the earlier one.
    // Three numbers each material when it is made but does not declare that id.
    const materialId = (line: LineSegments) => (line.material as unknown as { readonly id: number }).id;
    const drawn = () => { const lines: LineSegments[] = []; renderer().render.mock.calls.at(-1)![0].traverse((object: unknown) => { if (object instanceof LineSegments && object.userData.referenceId) lines.push(object); });
      return lines.sort((x, y) => x.renderOrder - y.renderOrder || materialId(x) - materialId(y) || x.id - y.id).map(line => line.userData.featureId); };
    await pick(); expect(selected).toHaveBeenLastCalledWith('a'); expect(drawn()).toEqual(['a', 'b']);
    // The second line is kept and the first replaced; the first still wins the tie, and the second is still drawn last.
    await show([renamed, second], 'v2'); selected.mockClear(); await pick(); expect(selected).toHaveBeenLastCalledWith('a'); expect(drawn()).toEqual(['a', 'b']);
  });
});

describe('initial reference and solid framing', () => {
  const references = prepareCadViewportReferences([{ id: 'section', name: 'Section', kind: 'sketch', plane: 'XY', offset: 0, suppressed: false,
    profiles: [{ id: 'circle', name: 'Circle', construction: false, geometry: { kind: 'circle', x: 0, y: 0, radius: 2 } }] }], {});
  const longPad: CadMesh = { ...mesh, positions: [-2, -2, 0, 2, -2, 0, -2, 2, 300], edges: [-2, -2, 0, -2, 2, 300], bounds: { min: [-2, -2, 0], max: [2, 2, 300] } };
  const show = async (meshes: readonly CadMesh[], outlines: readonly CadViewportReference[] = references) => {
    await act(async () => root.render(<CadViewport meshes={meshes} references={outlines} referenceVersion="current" selectedId={null}
      onSelect={vi.fn()} onControlsReady={value => { controls = value; }} />));
    await currentControls().capture(new AbortController().signal);
  };
  const camera = () => { const value = renderer().render.mock.calls.at(-1)?.[1]; if (!(value instanceof OrthographicCamera)) throw new Error('CAD camera missing'); return value; };

  it('fits the first solid after reference-only viewing and preserves the camera through later geometry/visibility changes', async () => {
    await show([]); expect(solidViewState().zoom).toBe(8.5);
    await show([longPad], []); expect(solidViewState().zoom).toBeLessThan(.85);
    const firstCamera = camera(); firstCamera.updateMatrixWorld();
    for (const point of [new Vector3(-2, -2, 0), new Vector3(-2, 2, 300)]) {
      point.project(firstCamera); expect(Math.abs(point.x)).toBeLessThan(1); expect(Math.abs(point.y)).toBeLessThan(1);
    }
    const position = firstCamera.position.toArray(); const zoom = firstCamera.zoom;
    await show([{ ...longPad, positions: longPad.positions.map((value, index) => index % 3 === 2 ? value * 2 : value), bounds: { min: [-2, -2, 0], max: [2, 2, 600] } }]);
    expect(camera().position.distanceTo(new Vector3(...position))).toBeLessThan(1e-8); expect(solidViewState().zoom).toBe(zoom);
    await show([]); await show([longPad], []); expect(camera().position.distanceTo(new Vector3(...position))).toBeLessThan(1e-8); expect(solidViewState().zoom).toBe(zoom);
  });

  it.each(['wheel', 'view', 'fit'] as const)('keeps explicit %s framing before the first solid rather than overriding user camera intent', async action => {
    await show([]);
    await act(async () => {
      if (action === 'wheel') renderer().domElement.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
      else if (action === 'view') currentControls().setView?.('Front');
      else currentControls().fit();
    });
    await currentControls().capture(new AbortController().signal); const before = camera().position.toArray(); const zoom = solidViewState().zoom;
    await show([longPad], []); expect(camera().position.distanceTo(new Vector3(...before))).toBeLessThan(1e-8); expect(solidViewState().zoom).toBe(zoom);
  });
});

describe('named CAD camera views with real OrbitControls', () => {
  it.each([0, 100000000])('preserves Top through fit/capture and other named views at world coordinate %s', async origin => {
    const moved: CadMesh = { ...mesh, positions: mesh.positions.map((value, index) => index % 3 === 2 ? value : value + origin),
      edges: mesh.edges.map((value, index) => index % 3 === 2 ? value : value + origin),
      bounds: { min: [origin, origin, 0], max: [origin + 10, origin + 10, 10] } };
    const disposed = vi.spyOn(OrbitControls.prototype, 'dispose');
    await act(async () => root.render(<CadViewport meshes={[moved]} selectedId="body" onSelect={vi.fn()} onControlsReady={value => { controls = value; }} />));
    const capture = async () => { await act(async () => { await currentControls().capture(new AbortController().signal); }); };
    const renderedCamera = () => { const camera = renderer().render.mock.calls.at(-1)?.[1]; if (!(camera instanceof OrthographicCamera)) throw new Error('CAD camera missing'); return camera; };
    await capture(); const originalZoom = solidViewState().zoom;
    await act(async () => currentControls().setView?.('Top'));
    expect(solidViewState().zoom).toBe(originalZoom);
    await act(async () => currentControls().fit()); await capture();
    expect(solidViewState().view).toBe('Top');
    expect(renderedCamera().getWorldDirection(new Vector3()).distanceTo(new Vector3(0, 0, -1))).toBeLessThan(1e-10);
    expect(renderedCamera().position.x).toBeCloseTo(origin + 5, 6); expect(renderedCamera().position.y).toBeCloseTo(origin + 5, 6);
    for (const name of ['Front', 'Right', 'Isometric', 'Top'] as const) {
      const zoom = solidViewState().zoom;
      await act(async () => currentControls().setView?.(name)); await capture();
      expect(solidViewState().view).toBe(name); expect(solidViewState().zoom).toBe(zoom);
      await act(async () => currentControls().fit()); await capture(); expect(solidViewState().view).toBe(name);
      const expectedDirection = name === 'Top' ? new Vector3(0, 0, -1) : name === 'Front' ? new Vector3(0, 1, 0)
        : name === 'Right' ? new Vector3(-1, 0, 0) : new Vector3(-1, 1.2, -0.9).normalize();
      expect(renderedCamera().getWorldDirection(new Vector3()).distanceTo(expectedDirection)).toBeLessThan(1e-9);
    }
    expect(disposed).toHaveBeenCalledTimes(3);
    const revision = currentControls().getState().revision;
    for (const old of disposed.mock.contexts) { if (!(old instanceof OrbitControls)) throw new Error('Disposed controls missing'); old.dispatchEvent({ type: 'change' }); }
    expect(currentControls().getState().revision).toBe(revision);
    const camera = renderedCamera(); camera.position.x += 20;
    await capture(); expect(solidViewState().view).toBe('Custom');
  });

  it('keeps recreated controls locked, then allows orbiting after unlocking', async () => {
    const render = async (interactionLocked: boolean) => { await act(async () => root.render(<CadViewport meshes={[mesh]} selectedId="body" onSelect={vi.fn()}
      interactionLocked={interactionLocked} onControlsReady={value => { controls = value; }} />)); };
    await render(true); await act(async () => currentControls().setView?.('Top'));
    const canvas = renderer().domElement; canvas.setPointerCapture = vi.fn(); canvas.releasePointerCapture = vi.fn();
    const drag = async () => { await act(async () => {
      canvas.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, buttons: 1, clientX: 400, clientY: 300 }));
      canvas.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, button: 0, buttons: 1, clientX: 450, clientY: 320 }));
      canvas.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 450, clientY: 320 }));
    }); };
    const revision = currentControls().getState().revision; await drag();
    expect(currentControls().getState()).toMatchObject({ view: 'Top', revision });
    await render(false); await drag(); expect(solidViewState().view).toBe('Custom');
  });
});

describe('CAD WebGL context lifecycle', () => {
  it('keeps plane labels selectable without solids, respects workflow locks, and disables them during graphics recovery', async () => {
    const onSelectPlane = vi.fn();
    const render = async (interactionLocked: boolean) => { await act(async () => root.render(<CadViewport meshes={[]} selectedId={null} onSelect={vi.fn()}
      references={CAD_PRINCIPAL_PLANE_REFERENCES} referenceVersion="v1" onSelectPlane={onSelectPlane} interactionLocked={interactionLocked} onControlsReady={value => { controls = value; }} />)); };
    await render(false); await flushFrame(); const button = container.querySelector<HTMLButtonElement>('[aria-label="Select XZ plane in design area"]');
    if (!button) throw new Error('Plane label missing'); expect(button.hidden).toBe(false); expect(button.style.left).toMatch(/px$/);
    await act(async () => button.click()); expect(onSelectPlane).toHaveBeenCalledExactlyOnceWith('XZ');
    await render(true); expect(button.disabled).toBe(true); await act(async () => button.click()); expect(onSelectPlane).toHaveBeenCalledTimes(1);
    await render(false);
    await loseContext(); expect(container.querySelector('.cad-view-message button')?.textContent).toBe('Retry 3D view');
    expect(button.disabled).toBe(true); await act(async () => button.click()); expect(onSelectPlane).toHaveBeenCalledTimes(1);
  });
  it('marks lost graphics unavailable, cancels pending rendering and refuses an empty PNG capture', async () => {
    await mount(); const previous = currentControls().getState().revision;
    await loseContext();
    expect(currentControls().getState()).toMatchObject({ available: false, revision: previous + 1 }); expect(frames.size).toBe(0);
    expect(container.querySelector('[role="status"]')?.textContent).toContain('graphics context was interrupted');
    await expect(currentControls().capture(new AbortController().signal)).rejects.toMatchObject({ code: 'CAPTURE_UNAVAILABLE' });
    expect(rasterize).not.toHaveBeenCalled(); expect(renderer().render).not.toHaveBeenCalled();
  });
  it('rejects context loss during rendering and during image copying rather than returning a transparent artifact', async () => {
    await mount(); renderer().render.mockImplementationOnce(() => { renderer().lost = true; });
    await expect(currentControls().capture(new AbortController().signal)).rejects.toMatchObject({ code: 'CAPTURE_UNAVAILABLE' });
    expect(rasterize).not.toHaveBeenCalled();
    renderer().lost = false; rasterize.mockImplementationOnce(() => { renderer().lost = true; return { dataUrl: 'data:image/png;base64,AA==', width: 800, height: 600, source: '3d' }; });
    await expect(currentControls().capture(new AbortController().signal)).rejects.toMatchObject({ code: 'CAPTURE_UNAVAILABLE' });
    expect(rasterize).toHaveBeenCalledTimes(1);
  });
  it('automatically redraws the retained scene after restoration without requiring another pointer event', async () => {
    await mount(); await flushFrame(); const scene = renderer().render.mock.calls[0][0];
    await loseContext(); const lostRevision = currentControls().getState().revision; renderer().render.mockClear();
    await act(async () => { renderer().lost = false; renderer().domElement.dispatchEvent(new Event('webglcontextrestored')); });
    expect(currentControls().getState()).toMatchObject({ available: true, revision: lostRevision + 1 }); expect(container.querySelector('[role="status"]')).toBeNull();
    expect(frames.size).toBe(1); await flushFrame(); expect(renderer().render).toHaveBeenCalledTimes(1); expect(renderer().render.mock.calls[0][0]).toBe(scene);
    await expect(currentControls().capture(new AbortController().signal)).resolves.toMatchObject({ source: '3d' });
  });
  it('retries with a new context, preserves source meshes and releases the old context and event handlers', async () => {
    await mount(); const old = renderer(); const oldControls = currentControls(); await loseContext();
    const retry = [...container.querySelectorAll('button')].find(button => button.textContent === 'Retry 3D view'); if (!retry) throw new Error('Retry missing');
    await act(async () => retry.click());
    expect(renderers).toHaveLength(2); expect(old.dispose).toHaveBeenCalledTimes(1); expect(old.forceContextLoss).toHaveBeenCalledTimes(1);
    expect(oldControls.getState().available).toBe(false); await expect(oldControls.capture(new AbortController().signal)).rejects.toMatchObject({ code: 'CAPTURE_UNAVAILABLE' });
    expect(currentControls().getState().available).toBe(true); await flushFrame();
    const scene = renderer().render.mock.calls[0][0]; let uploaded = false;
    scene.traverse(object => { if (object.userData.featureId === 'body') uploaded = true; }); expect(uploaded).toBe(true);
    const currentRevision = currentControls().getState().revision;
    await act(async () => old.domElement.dispatchEvent(new Event('webglcontextrestored')));
    expect(currentControls().getState().revision).toBe(currentRevision);
  });
});

describe('versioned Curve reference rendering', () => {
  it('installs sorted Sketch/Curve IDs, keeps unchanged GPU resources, styles construction and clears removed batches', async () => {
    const prepared = prepareCadViewportReferences([{ id: 'rail', name: 'Rail', kind: 'curve', plane: 'XY', offset: 0, suppressed: false,
      segments: [{ kind: 'line', start: [0, 0], end: [20, 0] }] }, { id: 'sketch', name: 'Sketch', kind: 'sketch', plane: 'XZ', offset: 4, suppressed: false,
      profiles: [{ id: 'profile', name: 'Profile', construction: false, geometry: { kind: 'circle', x: 0, y: 0, radius: 2 } },
        { id: 'guide', name: 'Guide', construction: true, geometry: { kind: 'circle', x: 0, y: 0, radius: 1 } }] }], {});
    const curve = prepared.find(reference => reference.featureKind === 'curve'); if (!curve) throw new Error('Curve missing');
    const render = async (references: readonly CadViewportReference[], version = 'v1') => { await act(async () => root.render(<CadViewport meshes={[]} references={references}
      referenceVersion={version} selectedId="sketch" onSelect={vi.fn()} onControlsReady={value => { controls = value; }} />)); };
    const getLine = (scene: Scene, id: string) => { const lines: LineSegments[] = []; scene.traverse(object => { if (object instanceof LineSegments && object.userData.referenceId === id) lines.push(object); }); if (lines.length !== 1) throw new Error(`Missing reference ${id}`); return lines[0]; };
    await render([curve]); await currentControls().capture(new AbortController().signal); const scene = renderer().render.mock.calls.at(-1)![0];
    const original = getLine(scene, 'rail'); const disposed = vi.spyOn(original.geometry, 'dispose');
    await render(prepared); await currentControls().capture(new AbortController().signal); expect(getLine(scene, 'rail')).toBe(original); expect(disposed).not.toHaveBeenCalled();
    const state = currentControls().getState(); if (state.mode !== 'solid') throw new Error('World viewport missing');
    expect(state).toMatchObject({ referenceVersion: 'v1', referenceFeatureIds: ['rail', 'sketch'] }); expect(Object.isFrozen(state.referenceFeatureIds)).toBe(true);
    const guide = getLine(scene, 'sketch/guide'); if (!(guide.material instanceof LineDashedMaterial)) throw new Error('Construction dashes missing');
    expect(guide.material.depthTest).toBe(true); expect(guide.geometry.getAttribute('lineDistance')).toBeDefined();
    const dashSize = guide.material.dashSize; const camera = renderer().render.mock.calls.at(-1)![1]; if (!(camera instanceof OrthographicCamera)) throw new Error('CAD camera missing'); camera.zoom *= 2; camera.updateProjectionMatrix();
    await currentControls().capture(new AbortController().signal); expect(guide.material.dashSize).toBeCloseTo(dashSize / 2);
    const guideDisposed = vi.spyOn(guide.geometry, 'dispose'); const guideMaterialDisposed = vi.spyOn(guide.material, 'dispose');
    await render([curve]); expect(guideDisposed).toHaveBeenCalledTimes(1); expect(guideMaterialDisposed).toHaveBeenCalledTimes(1); expect(disposed).not.toHaveBeenCalled();
    await render([], 'v2'); expect(disposed).toHaveBeenCalledTimes(1); expect(currentControls().getState()).toMatchObject({ referenceVersion: 'v2', referenceFeatureIds: [] });
  });

  it('retains visible small far-origin Sketch outlines and disposes their installed resources on unmount', async () => {
    const references = prepareCadViewportReferences([{ id: 'far_sketch', name: 'Far sketch', kind: 'sketch', plane: 'XY', offset: 7, suppressed: false,
      profiles: [{ id: 'circle', name: 'Circle', construction: false, geometry: { kind: 'circle', x: 100000000, y: 100000000, radius: 1 } }] }], {});
    await act(async () => root.render(<CadViewport meshes={[]} references={references} referenceVersion="far1" selectedId="far_sketch" onSelect={vi.fn()} onControlsReady={value => { controls = value; }} />));
    await currentControls().capture(new AbortController().signal); const scene = renderer().render.mock.calls.at(-1)![0]; const lines: LineSegments[] = [];
    scene.traverse(object => { if (object instanceof LineSegments && object.userData.referenceId === 'far_sketch/circle') lines.push(object); }); expect(lines).toHaveLength(1);
    const line = lines[0]; const position = line.geometry.getAttribute('position'); const local = Array.from({ length: position.count }, (_, index) => new Vector3().fromBufferAttribute(position, index));
    expect(new Set(local.map(point => point.toArray().join(','))).size).toBeGreaterThan(100); expect(Math.max(...local.flatMap(point => point.toArray().map(Math.abs)))).toBeLessThan(2);
    expect(local[0].clone().applyMatrix4(line.matrixWorld).distanceTo(new Vector3(100000001, 100000000, 7))).toBeLessThan(1e-6);
    const geometryDisposed = vi.spyOn(line.geometry, 'dispose'); const material = Array.isArray(line.material) ? line.material[0] : line.material; const materialDisposed = vi.spyOn(material, 'dispose');
    await act(async () => root.render(null)); expect(geometryDisposed).toHaveBeenCalledTimes(1); expect(materialDisposed).toHaveBeenCalledTimes(1);
  });
  it('selects world Sketch references in Body mode without intercepting Face or Edge picks', async () => {
    const references = prepareCadViewportReferences([{ id: 'sketch', name: 'Sketch', kind: 'sketch', plane: 'XY', offset: 5, suppressed: false,
      profiles: [{ id: 'profile', name: 'Profile', construction: false, geometry: { kind: 'rectangle', x: 0, y: 0, width: 20, height: 10, cornerRadius: 0 } }] }], {});
    const onSelect = vi.fn(); const onTopologyPick = vi.fn();
    const render = async (pickMode: 'body' | 'face' | 'edge') => {
      await act(async () => root.render(<CadViewport meshes={[mesh]} references={references} referenceVersion="v1" selectedId={null}
        pickMode={pickMode} onSelect={onSelect} onTopologyPick={onTopologyPick} onControlsReady={value => { controls = value; }} />));
    };
    await render('body'); await currentControls().capture(new AbortController().signal);
    const camera = renderer().render.mock.calls.at(-1)![1]; const point = new Vector3(10, 0, 5).project(camera);
    const canvas = renderer().domElement;
    canvas.setPointerCapture = vi.fn(); canvas.releasePointerCapture = vi.fn();
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) });
    const pick = async () => {
      await act(async () => {
        for (const type of ['pointerdown', 'pointerup']) canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: (point.x + 1) * 400, clientY: (1 - point.y) * 300 }));
      });
    };
    await pick(); expect(onSelect).toHaveBeenLastCalledWith('sketch'); onSelect.mockClear();
    await render('face'); await pick(); await render('edge'); await pick();
    expect(onSelect).not.toHaveBeenCalled(); expect(onTopologyPick).toHaveBeenCalledTimes(2);
  });
  it('renders and captures references without meshes, advances installed version and releases replaced geometry', async () => {
    const references = prepareCadCurveReferences([{ id: 'rail', name: 'Rail', kind: 'curve', plane: 'XZ', offset: 4, suppressed: false,
      segments: [{ kind: 'line', start: [0, 0], end: [20, 0] }] }], {});
    const publish = (value: CadRenderedViewControls | null) => { controls = value; };
    await act(async () => root.render(<CadViewport meshes={[]} references={references} referenceVersion="v1" selectedId="rail" onSelect={vi.fn()} onControlsReady={publish} pickingEnabled={false} />));
    expect(currentControls().getState()).toMatchObject({ mode: 'solid', available: true, referenceVersion: 'v1' });
    await currentControls().capture(new AbortController().signal); const scene = renderer().render.mock.calls.at(-1)![0];
    let line: LineSegments | null = null; let bodies = 0;
    scene.traverse(object => { if (object instanceof LineSegments && object.userData.featureId === 'rail') line = object; if (object instanceof Mesh) bodies++; });
    expect(bodies).toBe(0); if (!line) throw new Error('Curve reference not uploaded');
    const original: LineSegments = line; const disposed = vi.spyOn(original.geometry, 'dispose');
    const guides = scene.children.filter(object => object instanceof GridHelper || object instanceof AxesHelper);
    expect(guides).toHaveLength(2);
    for (const guide of guides) {
      if (!(guide instanceof LineSegments)) throw new Error('Guide geometry missing');
      for (const material of Array.isArray(guide.material) ? guide.material : [guide.material]) expect(material.depthWrite).toBe(false);
      expect(guide.renderOrder).toBeLessThan(original.renderOrder);
    }
    for (const material of Array.isArray(original.material) ? original.material : [original.material]) expect(material.depthTest).toBe(true);
    await act(async () => root.render(<CadViewport meshes={[]} references={references} referenceVersion="v1" selectedId={null} onSelect={vi.fn()} onControlsReady={publish} pickingEnabled={false} />));
    expect(disposed).not.toHaveBeenCalled();
    const moved = references.map(reference => ({ ...reference, positions: [0, -8, 0, 20, -8, 0] }));
    const beforeRevision = currentControls().getState().revision;
    await act(async () => root.render(<CadViewport meshes={[]} references={moved} referenceVersion="v2" selectedId="rail" onSelect={vi.fn()} onControlsReady={publish} pickingEnabled={false} />));
    expect(disposed).toHaveBeenCalledTimes(1); expect(currentControls().getState()).toMatchObject({ referenceVersion: 'v2' }); expect(currentControls().getState().revision).toBeGreaterThan(beforeRevision);
    await currentControls().capture(new AbortController().signal); let coordinates: readonly number[] = [];
    renderer().render.mock.calls.at(-1)![0].traverse(object => {
      if (object instanceof LineSegments && object.userData.featureId === 'rail') {
        const position=object.geometry.getAttribute('position');
        coordinates=Array.from({length:position.count},(_,index)=>new Vector3().fromBufferAttribute(position,index).applyMatrix4(object.matrixWorld).toArray()).flat();
      }
    });
    expect(coordinates).toEqual([0, -8, 0, 20, -8, 0]);
    await act(async () => root.render(<CadViewport meshes={[]} references={[]} referenceVersion="v3" selectedId={null} onSelect={vi.fn()} onControlsReady={publish} pickingEnabled={false} />));
    expect(currentControls().getState()).toMatchObject({ referenceVersion: 'v3', referenceFeatureIds: [] });
  });
  it('keeps small far-origin curves distinct in GPU coordinates and restores their world placement',async()=>{
    const references=prepareCadCurveReferences([{id:'far_rail',name:'Far rail',kind:'curve',plane:'XY',offset:7,suppressed:false,
      segments:[{kind:'arc',center:[100000000,100000000],radius:1,startAngle:0,sweep:180}]}],{});
    await act(async()=>root.render(<CadViewport meshes={[]} references={references} referenceVersion="far1" selectedId={null} onSelect={vi.fn()} onControlsReady={value=>{controls=value;}} pickingEnabled={false}/>));
    await currentControls().capture(new AbortController().signal);const scene=renderer().render.mock.calls.at(-1)![0];
    const lines:LineSegments[]=[];scene.traverse(object=>{if(object instanceof LineSegments&&object.userData.featureId==='far_rail') lines.push(object);});
    expect(lines).toHaveLength(1);const line=lines[0];const position=line.geometry.getAttribute('position');
    const localPoints=Array.from({length:position.count},(_,index)=>new Vector3().fromBufferAttribute(position,index));
    expect(new Set(localPoints.map(point=>point.toArray().join(','))).size).toBeGreaterThan(50);
    expect(Math.max(...localPoints.flatMap(point=>point.toArray().map(Math.abs)))).toBeLessThan(2);
    expect(line.position.x).toBeCloseTo(100000000,6);expect(line.position.y).toBeCloseTo(100000000.5,6);expect(line.position.z).toBe(7);
    for(let index=0;index<localPoints.length;index++) {
      const world=localPoints[index].clone().applyMatrix4(line.matrixWorld);
      expect(world.distanceTo(new Vector3(...references[0].positions.slice(index*3,index*3+3)))).toBeLessThan(1e-6);
    }
    expect(currentControls().getState()).toMatchObject({referenceVersion:'far1',available:true});
  });
});

describe('reference plane hover', () => {
  it('reports the plane under the pointer, shows a plane hovered elsewhere and clears the report on unmount', async () => {
    const hovered = vi.fn();
    const render = async (hoveredReferencePlane: 'XY' | null) => act(async () => root.render(<CadViewport meshes={[]} references={CAD_PRINCIPAL_PLANE_REFERENCES} referenceVersion="v1" selectedId={null}
      onSelect={vi.fn()} onSelectPlane={vi.fn()} onHoverPlane={hovered} hoveredReferencePlane={hoveredReferencePlane} pickingEnabled={false} onControlsReady={value => { controls = value; }} />));
    await render(null); await flushFrame();
    const scene = renderer().render.mock.calls.at(-1)![0], camera = renderer().render.mock.calls.at(-1)![1]; camera.updateMatrixWorld();
    const patch = (plane: string) => { let found: Mesh | null = null; scene.traverse(object => { if (object instanceof Mesh && object.userData.referenceId === `principal:${plane}`) found = object; }); if (!found) throw new Error(`Missing ${plane}`); return found as Mesh; };
    const color = (plane: string) => (patch(plane).material as MeshBasicMaterial).color.getHex();
    const resting = color('XZ'), canvas = renderer().domElement;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) });
    const move = async (x: number, y: number) => { await act(async () => canvas.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, buttons: 0, clientX: x, clientY: y }))); await flushFrame(); };
    const point = new Vector3(6, 0, 7).project(camera);
    await move((point.x + 1) * 400, (1 - point.y) * 300);
    expect(hovered).toHaveBeenLastCalledWith('XZ'); expect(color('XZ')).not.toBe(resting);
    await move((point.x + 1) * 400 + 1, (1 - point.y) * 300); expect(hovered).toHaveBeenCalledTimes(1);
    await move(4, 4); expect(hovered).toHaveBeenLastCalledWith(null); expect(color('XZ')).toBe(resting);
    const xyResting = color('XY'); await render('XY'); await flushFrame();
    expect(color('XY')).toBe(0x91edff); expect(color('XY')).not.toBe(xyResting); expect(color('XZ')).toBe(resting);
    expect(container.querySelector('[aria-label="Select XY plane in design area"]')?.getAttribute('data-hovered')).toBe('true');
    expect(container.querySelector('[aria-label="Select XZ plane in design area"]')?.hasAttribute('data-hovered')).toBe(false);
    await move((point.x + 1) * 400, (1 - point.y) * 300); expect(hovered).toHaveBeenLastCalledWith('XZ');
    const calls = hovered.mock.calls.length; act(() => root.unmount()); expect(hovered).toHaveBeenCalledTimes(calls + 1); expect(hovered).toHaveBeenLastCalledWith(null);
    root = createRoot(container);
  });
});

describe('model behind an open sketch', () => {
  const placement = { frame: cadPrincipalFrame('XY'), offsetMm: 10 };
  const firstView = { center: [0, 0] as const, width: 160 * 800 / 600, span: 160 };
  // The workbench hands over the same meshes until the model changes.
  const meshes = [mesh];
  function show(sketchView: CadSketchBackgroundView | null, hidden = sketchView !== null, onSelect = vi.fn()) {
    return act(async () => root.render(<CadViewport meshes={meshes} selectedId={null} onSelect={onSelect} hidden={hidden} sketchView={sketchView}
      onControlsReady={(value, released) => { if (value) controls = value; else if (!released || controls === released) controls = null; }} />));
  }
  const drawn = () => renderer().render.mock.calls.length;
  const lastCamera = () => renderer().render.mock.calls.at(-1)![1] as OrthographicCamera;
  const lastScene = () => renderer().render.mock.calls.at(-1)![0];
  const dimAmount = () => {
    let amount: unknown;
    lastScene().traverse(child => {
      if (amount !== undefined || !(child instanceof Mesh) || child.userData.featureId !== 'body') return;
      const shader = { uniforms: {} as Record<string, { value: unknown }>, fragmentShader: '#include <premultiplied_alpha_fragment>', vertexShader: '' };
      (child.material as MeshStandardMaterial).onBeforeCompile(shader as never, renderer() as never);
      amount = shader.uniforms.cadDim.value;
    });
    return amount;
  };
  const clipping = () => {
    const planes: (readonly Plane[] | null)[] = [];
    lastScene().traverse(child => { if ((child instanceof Mesh || child instanceof LineSegments) && child.userData.featureId === 'body') planes.push((child.material as MeshStandardMaterial).clippingPlanes); });
    return planes;
  };
  const helpersVisible = () => { const helpers: boolean[] = []; lastScene().traverse(child => { if (child instanceof GridHelper || child instanceof AxesHelper) helpers.push(child.visible); }); return helpers; };

  it('draws only through the sketch camera, only when that camera or the model changes, and leaves the model camera exactly as it was', async () => {
    const link = createCadSketchCameraLink();
    await show(null); await flushFrame();
    const modelCamera = lastCamera(), framed = { position: modelCamera.position.clone(), quaternion: modelCamera.quaternion.clone(), zoom: modelCamera.zoom, top: modelCamera.top, right: modelCamera.right };
    expect(controls).not.toBeNull();
    const host = container.querySelector<HTMLElement>('.cad-webgl')!;
    const counted = () => Number(host.dataset.cadFramesDrawn);
    expect(counted()).toBe(drawn());
    const background: CadSketchBackgroundView = { placement, background: 'dimmed', cutBySketchPlane: false, camera: link };
    await show(background);
    // Behind the sketch the view publishes no controls, takes no focus and is not announced.
    expect(controls).toBeNull();
    expect(container.querySelector('.cad-viewport.is-sketch-background')?.getAttribute('aria-hidden')).toBe('true');
    // Inert, so focus the 3D canvas had is released rather than left inside a layer no one can see.
    expect(container.querySelector('.cad-viewport.is-sketch-background')?.hasAttribute('inert')).toBe(true);
    expect(renderer().domElement.tabIndex).toBe(-1);
    expect(container.querySelector('.cad-webgl canvas')).toBe(renderer().domElement);
    // Until the sketch canvas publishes its view there is no camera to draw with.
    let before = drawn(); await flushFrame(); expect(drawn()).toBe(before);
    await act(async () => link.publish(firstView)); await flushFrame();
    expect(drawn()).toBe(before + 1); expect(counted()).toBe(drawn());
    const sketchCamera = lastCamera();
    expect(sketchCamera).not.toBe(modelCamera);
    const project = (x: number, y: number) => { const point = new Vector3(x, y, 10).project(sketchCamera); return [(point.x + 1) * 400, (1 - point.y) * 300]; };
    const [px, py] = project(40, -25);
    expect(px).toBeCloseTo((40 / firstView.width + 0.5) * 800, 6); expect(py).toBeCloseTo((0.5 + 25 / 160) * 600, 6);
    expect(helpersVisible()).toEqual([false, false]);
    expect(dimAmount()).toBe(CAD_SKETCH_DIM_AMOUNT);
    // A render of the workbench with nothing new for the view, or the same view again, draws nothing.
    before = drawn();
    await show(background, true, vi.fn()); await act(async () => link.publish({ ...firstView, center: [0, 0] })); await flushFrame();
    expect(drawn()).toBe(before);
    // Each pan or zoom step draws one frame; steps within one animation frame share it.
    await act(async () => link.publish({ ...firstView, span: 120, width: 120 * 800 / 600 })); await flushFrame();
    expect(drawn()).toBe(before + 1);
    await act(async () => { link.publish({ ...firstView, center: [5, 0] }); link.publish({ ...firstView, center: [6, 0] }); link.publish({ ...firstView, center: [7, 0] }); }); await flushFrame();
    expect(drawn()).toBe(before + 2);
    expect(lastCamera()).toBe(sketchCamera);
    expect(project(7, 0)[0]).toBeCloseTo(400, 6);
    // Normal and the cut redraw once each, with no new camera.
    await show({ ...background, background: 'normal' }); await flushFrame();
    expect(dimAmount()).toBe(0); expect(drawn()).toBe(before + 3);
    const cut = { ...background, cutBySketchPlane: true };
    await show(cut); await flushFrame();
    const planes = clipping();
    // Material planes take effect only with the renderer's local clipping on.
    expect((renderer() as unknown as { localClippingEnabled?: boolean }).localClippingEnabled).toBe(true);
    expect(planes).toHaveLength(3);
    for (const entry of planes) {
      expect(entry).toHaveLength(1); expect(entry![0].normal.toArray().map(value => value + 0)).toEqual([0, 0, -1]);
      expect(entry![0].distanceToPoint(new Vector3(0, 0, 12))).toBeLessThan(0); expect(entry![0].distanceToPoint(new Vector3(0, 0, 8))).toBeGreaterThan(0);
    }
    await show(background); await flushFrame();
    expect(clipping().every(entry => entry === null)).toBe(true);
    // Hidden draws nothing, whatever the sketch canvas does.
    await show(null, true); before = drawn();
    await act(async () => link.publish({ ...firstView, center: [-20, 3] })); await flushFrame();
    expect(drawn()).toBe(before);
    await show(background); await flushFrame();
    expect(drawn()).toBe(before + 1); expect(project(-20, 3)[0]).toBeCloseTo(400, 6);
    // Leaving the sketch brings back the model camera exactly, with its grid and controls.
    await show(null); await flushFrame();
    expect(controls).not.toBeNull();
    expect(lastCamera()).toBe(modelCamera);
    expect(modelCamera.position.equals(framed.position) && modelCamera.quaternion.equals(framed.quaternion)).toBe(true);
    expect([modelCamera.zoom, modelCamera.top, modelCamera.right]).toEqual([framed.zoom, framed.top, framed.right]);
    expect(helpersVisible()).toEqual([true, true]);
    expect(dimAmount()).toBe(0);
    expect(renderer().domElement.tabIndex).toBe(0);
    // After leaving, a sketch view is no longer followed.
    before = drawn(); await act(async () => link.publish({ ...firstView, span: 300 })); await flushFrame(); expect(drawn()).toBe(before);
  });

  it('draws a frame for changed background lines but none for a new document version that leaves them the same', async () => {
    const link = createCadSketchCameraLink(); link.publish(firstView);
    const outline = (width: number) => prepareCadViewportReferences([{ id: 'base', name: 'Base', kind: 'sketch', plane: 'XY', offset: 0, suppressed: false,
      profiles: [{ id: 'plate', name: 'Plate', construction: false, geometry: { kind: 'rectangle', x: 0, y: 0, width, height: 20, cornerRadius: 0 } }] }], {});
    const background: CadSketchBackgroundView = { placement, background: 'dimmed', cutBySketchPlane: false, camera: link };
    const lines = outline(30);
    const showLines = (references: readonly CadViewportReference[], version: string) => act(async () => root.render(<CadViewport meshes={meshes} references={references} referenceVersion={version}
      selectedId={null} onSelect={vi.fn()} hidden sketchView={background} />));
    await showLines(lines, 'v1'); await flushFrame();
    const before = drawn();
    // A sketch edit commits a new document version; the lines behind the sketch are the same objects, so nothing is drawn.
    await showLines(lines, 'v2'); await flushFrame();
    expect(drawn()).toBe(before);
    await showLines(outline(40), 'v3'); await flushFrame();
    expect(drawn()).toBe(before + 1);
  });

  it('sets aside the lines a sketch leaves out and shows the same ones again when it closes', async () => {
    const link = createCadSketchCameraLink(); link.publish(firstView);
    const sketches = (width: number) => prepareCadViewportReferences(['base', 'open'].map((id, index): CadSketchFeature => ({ id, name: id, kind: 'sketch', plane: 'XY', offset: index * 10, suppressed: false,
      profiles: [{ id: `${id}-outline`, name: 'Outline', construction: false, geometry: { kind: 'rectangle', x: 0, y: 0, width: id === 'open' ? width : 30, height: 20, cornerRadius: 0 } }] })), {});
    const model = [CAD_PRINCIPAL_PLANE_REFERENCES[0], ...sketches(30)];
    const onlyBase = (references: readonly CadViewportReference[]) => references.filter(reference => reference.featureId === 'base');
    const sketchView = (cutBySketchPlane: boolean): CadSketchBackgroundView => ({ placement, background: 'dimmed', cutBySketchPlane, camera: link });
    const showLines = (references: readonly CadViewportReference[], view: CadSketchBackgroundView | null) => act(async () => root.render(<CadViewport meshes={meshes}
      references={references} referenceVersion="v1" selectedId={null} onSelect={vi.fn()} hidden={view !== null} sketchView={view} />));
    /** Reference lines and plane patches in the drawn scene. */
    const drawnLines = () => { const lines: (LineSegments | Mesh)[] = []; lastScene().traverse(child => { if ((child instanceof LineSegments || child instanceof Mesh) && child.userData.referenceId) lines.push(child); }); return lines; };
    await showLines(model, null); await flushFrame();
    const shown = drawnLines(), left = shown.filter(object => object.userData.featureId !== 'base');
    // The plane's lines and patch, and the open sketch's lines.
    expect(left).toHaveLength(3);
    const disposed = left.map(object => vi.spyOn(object.geometry, 'dispose'));
    await showLines(onlyBase(model), sketchView(true)); await flushFrame();
    expect(drawnLines()).toEqual(shown.filter(object => object.userData.featureId === 'base'));
    // Leaving the sketch brings back the same buffers and materials, uncut, so nothing is uploaded or compiled again.
    await showLines(model, null); await flushFrame();
    expect(new Set(drawnLines())).toEqual(new Set(shown));
    for (const object of left) expect((object.material as MeshBasicMaterial).clippingPlanes).toBeNull();
    expect(disposed.every(spy => spy.mock.calls.length === 0)).toBe(true);
    // A line edited while it was set aside is replaced, and a view closed during a sketch disposes the lines it set aside.
    await showLines(onlyBase(model), sketchView(false));
    const wider = sketches(50).find(reference => reference.featureId === 'open')!, edited = model.map(reference => reference.featureId === 'open' ? wider : reference);
    await showLines(edited, null); await flushFrame();
    const now = drawnLines();
    expect(now).toHaveLength(shown.length);
    expect(now.filter(object => !shown.includes(object)).map(object => object.userData.featureId)).toEqual(['open']);
    expect(disposed.map(spy => spy.mock.calls.length)).toEqual(left.map(object => object.userData.featureId === 'open' ? 1 : 0));
    const kept = now.map(object => vi.spyOn(object.geometry, 'dispose'));
    await showLines(onlyBase(edited), sketchView(false));
    await act(async () => root.render(<></>));
    expect(kept.map(spy => spy.mock.calls.length)).toEqual(now.map(() => 1));
  });

  describe('the model camera a sketch returns to', () => {
    const outline = prepareCadViewportReferences([{ id: 'base', name: 'Base', kind: 'sketch', plane: 'XY', offset: 0, suppressed: false,
      profiles: [{ id: 'plate', name: 'Plate', construction: false, geometry: { kind: 'rectangle', x: 0, y: 0, width: 30, height: 20, cornerRadius: 0 } }] }], {});
    const tall = (height: number): CadMesh => ({ ...mesh, positions: [-40, -40, 0, 40, -40, 0, -40, 40, height], edges: [-40, -40, 0, -40, 40, height], bounds: { min: [-40, -40, 0], max: [40, 40, height] } });
    const render = (meshes: readonly CadMesh[], references: readonly CadViewportReference[], hidden: boolean, sketchView: CadSketchBackgroundView | null) => act(async () => root.render(
      <CadViewport meshes={meshes} references={references} referenceVersion="v1" selectedId={null} onSelect={vi.fn()} hidden={hidden} sketchView={sketchView}
        onControlsReady={(value, released) => { if (value) controls = value; else if (!released || controls === released) controls = null; }} />));
    const snapshot = (camera: OrthographicCamera) => ({ position: camera.position.toArray(), quaternion: camera.quaternion.toArray(), up: camera.up.toArray(), zoom: camera.zoom,
      frustum: [camera.left, camera.right, camera.top, camera.bottom, camera.near, camera.far] });

    it.each(['dimmed', 'hidden'] as const)('keeps it exactly through a first build, a larger rebuild and refused view commands in %s', async mode => {
      const link = createCadSketchCameraLink(); link.publish(firstView);
      const sketchView = mode === 'dimmed' ? { placement, background: 'dimmed' as const, cutBySketchPlane: false, camera: link } : null;
      // The view shows a sketch outline and no solid yet, framed on that outline.
      await render([], outline, false, null); await flushFrame();
      const modelCamera = lastCamera(), before = snapshot(modelCamera), stale = currentControls();
      await render([], outline, true, sketchView); await flushFrame();
      // The first solid finishes while the sketch is open, then a rebuild makes it taller.
      await render([tall(20)], outline, true, sketchView); await flushFrame();
      expect(snapshot(modelCamera)).toEqual(before);
      const sketchCamera = mode === 'dimmed' ? lastCamera() : null, shallow = sketchCamera?.far;
      await render([tall(300)], outline, true, sketchView); await flushFrame();
      expect(snapshot(modelCamera)).toEqual(before);
      // Behind the sketch the depth range still follows the taller part.
      if (sketchCamera) { expect(lastCamera()).toBe(sketchCamera); expect(sketchCamera.far).toBeGreaterThan(shallow! + 250); }
      // Controls released when the sketch opened refuse to frame or turn the covered view.
      await act(async () => { stale.fit(); stale.setView?.('Front'); });
      expect(snapshot(modelCamera)).toEqual(before);
      await render([tall(300)], outline, false, null); await flushFrame();
      expect(lastCamera()).toBe(modelCamera);
      expect(snapshot(modelCamera)).toEqual(before);
      expect(solidViewState().view).toBe('Isometric');
    });

    it('frames the part once on leaving when the view had nothing but planes before the sketch', async () => {
      const link = createCadSketchCameraLink(); link.publish(firstView);
      const sketchView: CadSketchBackgroundView = { placement, background: 'dimmed', cutBySketchPlane: false, camera: link }, planes = [CAD_PRINCIPAL_PLANE_REFERENCES[0]];
      // A part that opens straight into its first sketch, whose solid builds while the sketch is open.
      await render([], planes, true, sketchView); await flushFrame();
      await render([tall(300)], planes, true, sketchView); await flushFrame();
      await render([tall(300)], planes, false, null); await flushFrame();
      const modelCamera = lastCamera(); modelCamera.updateMatrixWorld();
      for (const corner of [new Vector3(-40, -40, 0), new Vector3(40, 40, 0), new Vector3(-40, 40, 300)]) {
        corner.project(modelCamera); expect(Math.abs(corner.x)).toBeLessThan(1); expect(Math.abs(corner.y)).toBeLessThan(1);
      }
      const framed = snapshot(modelCamera);
      // That frame happens once: the next sketch and rebuild leave it alone.
      await render([tall(300)], planes, true, sketchView); await render([tall(600)], planes, true, sketchView); await render([tall(600)], planes, false, null); await flushFrame();
      expect(snapshot(modelCamera)).toEqual(framed);
    });
  });

  it('opens straight into a sketch without ever publishing model controls', async () => {
    const link = createCadSketchCameraLink(), published = vi.fn(), menu = vi.fn();
    link.publish(firstView);
    await act(async () => root.render(<CadViewport meshes={meshes} selectedId={null} onSelect={vi.fn()} onContextMenu={menu} hidden sketchView={{ placement, background: 'dimmed', cutBySketchPlane: true, camera: link }} onControlsReady={published} />));
    await flushFrame();
    expect(published).not.toHaveBeenCalled();
    expect(drawn()).toBe(1);
    expect(clipping().every(entry => entry?.length === 1)).toBe(true);
    // A menu key reaching the covered canvas opens nothing; the shown view opens its menu as before.
    const menuKey = () => act(async () => { renderer().domElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true })); });
    await menuKey(); expect(menu).not.toHaveBeenCalled();
    await act(async () => root.render(<CadViewport meshes={meshes} selectedId={null} onSelect={vi.fn()} onContextMenu={menu} onControlsReady={published} />));
    expect(published).toHaveBeenCalledTimes(1);
    await menuKey(); expect(menu).toHaveBeenCalledTimes(1);
  });
});
