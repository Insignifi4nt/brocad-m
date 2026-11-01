import { act, useSyncExternalStore, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CadDocument, CadFeature, CadSketchPlane } from '@/domain/cad/cadDocument';
import { createCadDocument } from '@/domain/cad/cadSchema';
import { CadSession } from './cadSession';
import { CadWorkbench } from './CadWorkbench';
import type { CadWorkbenchViewportControls } from './cadViewportControls';
import { CAD_PREFERENCES_KEY, getCadPreferences, setCadPreferences } from './cadPreferences';
import type { CadOriginSelection, CadViewportSection } from './CadViewport';
import type { CadSelectionFilter } from '@/domain/cad/selection/cadSelectionFilter';

interface ShownViewport {
  references: readonly { referenceId: string; featureKind: string; name: string; plane?: CadSketchPlane }[];
  section: CadViewportSection | null; selectedOrigin: CadOriginSelection | null; selectionFilter?: CadSelectionFilter;
  selectOrigin?(selection: CadOriginSelection): void;
}
let viewport: ShownViewport | undefined;
const renderedView = { getState: () => ({ available: true, mode: 'model' }), fit() {}, setGrid() {}, capture: async () => { throw new Error('No capture in this test'); } };
vi.mock('./CadViewport', async () => { const { useEffect } = await import('react'); return { CadViewport: ({ hidden = false, references = [], onSelectPlane, section = null, selectedOrigin = null, onSelectOrigin, selectionFilter, viewControls, onControlsReady }: {
  hidden?: boolean; references?: ShownViewport['references']; onSelectPlane?(plane: CadSketchPlane): void; section?: CadViewportSection | null;
  selectedOrigin?: CadOriginSelection | null; onSelectOrigin?(selection: CadOriginSelection): void; selectionFilter?: CadSelectionFilter; viewControls?: ReactNode;
  onControlsReady?(controls: unknown, released?: unknown): void;
}) => {
  useEffect(() => { if (hidden) return; onControlsReady?.(renderedView); return () => onControlsReady?.(null, renderedView); }, [hidden, onControlsReady]);
  if (hidden) { viewport = undefined; return <div className="cad-viewport" hidden />; }
  viewport = { references, section, selectedOrigin, selectionFilter, selectOrigin: onSelectOrigin };
  return <div aria-label="3D model viewport">{references.filter(reference => reference.plane).map(reference => <button key={reference.referenceId}
    aria-label={`Select ${reference.name} in design area`} onClick={() => onSelectPlane?.(reference.plane!)}>{reference.name}</button>)}<div>{viewControls}</div></div>;
} }; });

let root: Root, container: HTMLDivElement, session: CadSession, controls: CadWorkbenchViewportControls | null;
const statusMessage = vi.fn();
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  localStorage.removeItem(CAD_PREFERENCES_KEY); setCadPreferences({ navigationMode: 'mouse', showOnPartDimensions: true });
  statusMessage.mockClear(); controls = null; viewport = undefined; container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); localStorage.removeItem(CAD_PREFERENCES_KEY); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function mount(initial: CadDocument = createCadDocument()) {
  session = new CadSession(initial);
  function Harness() {
    const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
    return <CadWorkbench document={snapshot.document} documentVersion={snapshot.version} build={null} buildState="idle" buildVersion={null}
      dirty={snapshot.dirty} canUndo={snapshot.canUndo} canRedo={snapshot.canRedo} onEdit={edit => session.edit([edit])} onEditMany={edits => session.edit(edits)}
      onUndo={() => session.undo()} onRedo={() => session.redo()} onWorkflowChange={open => session.setWorkflowOpen(open)}
      onBack={vi.fn()} onSendToCam={async () => undefined} onSave={async () => undefined} onOpenDocument={vi.fn()} onNewDocument={vi.fn()}
      onImportDocument={async () => undefined} onExportDocument={vi.fn()} onExportSolid={async () => undefined} onViewportControlsReady={value => { controls = value; }} onStatusMessage={statusMessage} />;
  }
  await act(async () => root.render(<Harness />));
}
const button = (label: string) => {
  const found = [...container.querySelectorAll('button')].find(entry => entry.getAttribute('aria-label') === label || entry.textContent?.trim() === label);
  if (!found) throw new Error(`Missing ${label}`); return found;
};
const click = (label: string) => act(async () => button(label).click());
const shown = () => { if (!viewport) throw new Error('Model view not shown'); return viewport; };
const state = () => { if (!controls) throw new Error('Missing viewport controls'); return controls.getState(); };
const escape = () => act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
const stored = () => JSON.parse(localStorage.getItem(CAD_PREFERENCES_KEY) ?? 'null');
const datum: CadFeature = { kind: 'datum-plane', id: 'mount', name: 'Mount plane', suppressed: false, definition: { kind: 'world', basePlane: 'XY', origin: [0, 0, 5], rotation: [0, 0, 0] } };
const front: CadFeature = { kind: 'sketch', id: 'front', name: 'Front', suppressed: false, plane: 'XZ', offset: 0,
  profiles: [{ id: 'block', name: 'Block', construction: false, geometry: { kind: 'rectangle', x: 20, y: 5, width: 4, height: 6, cornerRadius: 0 } }] };

describe('reference geometry in the model view', () => {
  it('shows the origin planes, axes and point, and only the selected one once reference geometry is turned off', async () => {
    await mount();
    const kinds = () => shown().references.map(reference => reference.referenceId);
    expect(kinds()).toEqual(['principal:XY', 'principal:XZ', 'principal:YZ', 'origin:x', 'origin:y', 'origin:z', 'origin:point']);
    await act(async () => shown().selectOrigin?.({ kind: 'axis', axis: 'y' }));
    expect(shown().selectedOrigin).toEqual({ kind: 'axis', axis: 'y' });
    // Agents read the picked axis; the state carries it only while one is picked.
    expect(state()).toMatchObject({ selectedOrigin: { kind: 'axis', axis: 'y' }, selectedReferencePlane: null });
    await click('Show reference geometry');
    expect(button('Show reference geometry').getAttribute('aria-pressed')).toBe('false'); expect(stored()).toMatchObject({ showReferenceGeometry: false });
    expect(kinds()).toEqual(['origin:y']);
    await click('Expand Reference'); await click('Select XZ plane');
    expect(kinds()).toEqual(['principal:XZ']); expect(shown().selectedOrigin).toBeNull(); expect(state()).not.toHaveProperty('selectedOrigin');
    await click('Show reference geometry'); expect(kinds()).toHaveLength(7); expect(stored()).not.toHaveProperty('showReferenceGeometry');
  });

  it('keeps the selection filter on this device and hands it to the model view', async () => {
    await mount();
    await click('Filter');
    const rows = [...document.querySelectorAll('[role="menuitemcheckbox"]')].map(row => [row.textContent?.trim(), row.getAttribute('aria-checked')]);
    expect(rows).toEqual([['Bodies', 'true'], ['Faces', 'true'], ['Edges', 'true'], ['Planes', 'true'], ['Axes', 'true'], ['Points', 'true']]);
    await act(async () => (document.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]'))!.click());
    expect(shown().selectionFilter).toEqual({ excluded: ['body'] }); expect(stored()).toMatchObject({ selectionFilter: { excluded: ['body'] } });
    await act(async () => root.unmount()); root = createRoot(container); await mount();
    expect(shown().selectionFilter).toEqual({ excluded: ['body'] });
  });
});

describe('commands from a selected reference', () => {
  it('starts a datum plane on a selected origin plane and a revolve about a selected origin axis', async () => {
    await mount({ ...createCadDocument(), features: [front] });
    await click('Select XZ plane in design area'); await click('Plane'); await click('Apply');
    expect(session.getSnapshot().document.features.at(-1)).toMatchObject({ kind: 'datum-plane', definition: { basePlane: 'XZ', origin: [0, 0, 0], rotation: [0, 0, 0] } });
    // On XZ the sketch's own Y axis is the world Z axis.
    await act(async () => shown().selectOrigin?.({ kind: 'axis', axis: 'z' })); await click('Revolve'); await click('Apply');
    expect(session.getSnapshot().document.features.at(-1)).toMatchObject({ kind: 'revolve', sketchId: 'front', axis: 'y' });
  });

  it('explains an axis the revolve cannot use instead of turning about a default', async () => {
    await mount({ ...createCadDocument(), features: [front] });
    const before = session.getSnapshot().document;
    await act(async () => shown().selectOrigin?.({ kind: 'axis', axis: 'y' })); await click('Revolve');
    expect(statusMessage).toHaveBeenLastCalledWith(expect.stringContaining('the Y axis is not one of them'), 'error');
    expect(container.querySelector('[aria-label="Feature properties"]')).toBeNull();
    expect(session.getSnapshot().document).toBe(before);
  });
});

describe('section view', () => {
  it('cuts by a selected plane, flips, drops caps, keeps the choice for this document and turns off with a second Escape', async () => {
    await mount();
    expect(button('Section view').disabled).toBe(true);
    await click('Select XZ plane in design area');
    await click('Section view');
    expect(shown().section).toMatchObject({ flip: false, caps: true, frame: { normal: [0, -1, 0] } });
    expect(state().section).toEqual({ plane: 'XZ', flip: false, caps: true });
    expect(stored().section).toEqual({ version: 1, documentId: session.getSnapshot().document.id, plane: 'XZ', flip: false, caps: true });
    await click('Flip section'); expect(shown().section).toMatchObject({ flip: true });
    const caps = container.querySelector<HTMLInputElement>('label.cad-check input[type="checkbox"]')!;
    await act(async () => caps.click()); expect(shown().section).toMatchObject({ flip: true, caps: false });

    await act(async () => root.unmount()); root = createRoot(container);
    const document = session.getSnapshot().document; await mount(document);
    expect(shown().section).toMatchObject({ flip: true, caps: false });
    // Another document starts without it, and leaves this one's alone.
    await act(async () => root.unmount()); root = createRoot(container); await mount();
    expect(shown().section).toBeNull(); expect(stored().section.documentId).toBe(document.id);

    await act(async () => root.unmount()); root = createRoot(container); await mount(document);
    await click('Select XY plane in design area'); expect(state().selectedReferencePlane).toBe('XY');
    await escape(); expect(state().selectedReferencePlane).toBeNull(); expect(shown().section).not.toBeNull();
    await escape(); expect(shown().section).toBeNull(); expect(stored()).not.toHaveProperty('section');
  });

  it('turns off when its datum plane is suppressed, stays off when it returns, and gives way to an open sketch', async () => {
    await mount({ ...createCadDocument(), features: [datum] });
    await click('Select Mount plane in design area'); await click('Section view');
    expect(shown().section?.frame.origin).toEqual([0, 0, 5]);
    // A rebuild that leaves the plane in place keeps the same section object.
    const section = shown().section;
    await act(async () => session.replace({ ...session.getSnapshot().document, name: 'Renamed' })); expect(shown().section).toBe(section);
    await act(async () => session.replace({ ...session.getSnapshot().document, parameters: {}, features: [{ ...datum, definition: { ...datum.definition, origin: [0, 0, 6] } } as CadFeature] }));
    expect(shown().section?.frame.origin).toEqual([0, 0, 6]);

    await click('Select Mount plane in design area'); await click('Sketch');
    expect(state().sketchId).not.toBeNull(); expect(viewport?.section ?? null).toBeNull();
    await click('Finish sketch'); expect(shown().section?.frame.origin).toEqual([0, 0, 6]);

    const features = session.getSnapshot().document.features.filter(feature => feature.kind === 'datum-plane');
    await act(async () => session.replace({ ...session.getSnapshot().document, features: features.map(feature => feature.id === 'mount' ? { ...feature, suppressed: true } : feature) }));
    expect(shown().section).toBeNull(); expect(stored()).not.toHaveProperty('section');
    await act(async () => session.replace({ ...session.getSnapshot().document, features }));
    expect(shown().section).toBeNull();
  });

  it('turns off when its datum plane is deleted', async () => {
    await mount({ ...createCadDocument(), features: [datum] });
    await click('Select Mount plane in design area'); await click('Section view'); expect(shown().section).not.toBeNull();
    await act(async () => session.replace({ ...session.getSnapshot().document, features: [] }));
    expect(shown().section).toBeNull(); expect(getCadPreferences().section).toBeUndefined();
  });

  it('lets agents turn it on by the selected plane, change its side and caps, and turn it off, with the same checks', async () => {
    await mount({ ...createCadDocument(), features: [datum, front] });
    const apply = (command: Parameters<CadWorkbenchViewportControls['apply']>[0]) => act(async () => controls!.apply(command));
    await expect(apply({ kind: 'set-section', on: true })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await apply({ kind: 'select-reference-plane', plane: { kind: 'datum-plane', featureId: 'mount' } });
    await apply({ kind: 'set-section', on: true, caps: false });
    expect(state().section).toEqual({ plane: { kind: 'datum-plane', featureId: 'mount' }, flip: false, caps: false });
    await apply({ kind: 'select-feature', featureId: null });
    await apply({ kind: 'set-section', on: true, flip: true });
    expect(state().section).toEqual({ plane: { kind: 'datum-plane', featureId: 'mount' }, flip: true, caps: false });
    await apply({ kind: 'set-section', on: false }); expect(state().section).toBeNull();
    await apply({ kind: 'edit-sketch', sketchId: 'front' });
    await expect(apply({ kind: 'set-section', on: true })).rejects.toMatchObject({ code: 'WRONG_VIEW' });
  });

  it('offers Section view in a datum plane’s tree menu', async () => {
    await mount({ ...createCadDocument(), features: [datum] });
    await act(async () => button('Select Mount plane in history').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })));
    const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(entry => entry.textContent?.includes('Section view'));
    if (!item) throw new Error('Missing Section view menu item'); await act(async () => item.click());
    expect(state().section).toEqual({ plane: { kind: 'datum-plane', featureId: 'mount' }, flip: false, caps: true });
  });
});
