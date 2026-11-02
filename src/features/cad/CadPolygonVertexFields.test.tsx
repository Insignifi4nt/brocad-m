import { act, useState, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CadPoint2, CadProfile, CadSketchFeature } from '@/domain/cad/cadDocument';
import { createCadDocument, parseCadDocument } from '@/domain/cad/cadSchema';
import { importCadDxfSketch } from '@/domain/cad/cadDxfImport';
import { measureCadSketch } from '@/domain/cad/cadMeasurements';
import { CadProfileEditor } from './CadFeatureEditor';
import { CadSession } from './cadSession';
import { cadSketchProfileEdits, cadSketchProfileViews, withCadSketchProfile } from '@/domain/cad/sketch-generators/cadSketchProfileViews';

const dxf = ['0', 'SECTION', '2', 'ENTITIES', '0', 'LWPOLYLINE', '90', '4', '70', '1',
  '10', '0', '20', '0', '10', '20', '20', '0', '10', '20', '20', '10', '10', '0', '20', '10', '0', 'ENDSEC', '0', 'EOF', ''].join('\r\n');
const rectangle: readonly CadPoint2[] = [[0, 0], [20, 0], [20, 10], [0, 10]];
let root: Root; let container: HTMLDivElement; let session: CadSession;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function currentSketch(): CadSketchFeature {
  const feature = session.getSnapshot().document.features[0];
  if (feature?.kind !== 'sketch') throw new Error('Sketch missing'); return feature;
}
function currentPolygon(): Extract<CadProfile, { kind: 'polygon' }> {
  const geometry = cadSketchProfileViews(currentSketch())[0]?.geometry;
  if (geometry?.kind !== 'polygon') throw new Error('Polygon missing'); return geometry;
}
async function mount(points = rectangle) {
  const imported = importCadDxfSketch({ fileName: 'Outline.dxf', text: dxf, units: 'mm', sketchId: 'outline' }).sketch;
  // The imported contour generator, given a polygon's geometry.
  const outline = withCadSketchProfile(imported, { ...cadSketchProfileViews(imported)[0], name: 'Outline', geometry: { kind: 'polygon', points } });
  session = new CadSession(parseCadDocument({ ...createCadDocument('Outline'), schemaVersion: 2, parameters: { width: 20, height: 10 }, features: [outline] }));
  function Harness() {
    const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot); const [epoch, setEpoch] = useState(0);
    const sketch = snapshot.document.features[0], profile = sketch?.kind === 'sketch' ? cadSketchProfileViews(sketch)[0] : undefined;
    if (sketch?.kind !== 'sketch' || !profile) throw new Error('Profile missing');
    return <CadProfileEditor key={epoch} profile={profile} document={snapshot.document}
      onApply={(next, parameters, _signal, removed) => session.edit(cadSketchProfileEdits(sketch, next, parameters, removed), snapshot.version)}
      onCancel={() => setEpoch(previous => previous + 1)} onPendingChange={session.setWorkflowOpen} />;
  }
  await act(async () => root.render(<Harness />));
}
function field(label: string) {
  const element = [...container.querySelectorAll('label')].find(entry => entry.querySelector('span')?.childNodes[0]?.textContent === label)?.querySelector('input');
  if (!element) throw new Error(`Missing ${label}`); return element;
}
function picker() { const element = container.querySelector<HTMLInputElement>('[aria-label="Polygon vertex"]'); if (!element) throw new Error('Picker missing'); return element; }
async function input(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); });
}
function button(label: string) {
  const element = [...container.querySelectorAll('button')].find(entry => entry.getAttribute('aria-label') === label || entry.textContent?.trim() === label);
  if (!element) throw new Error(`Missing ${label}`); return element;
}
async function click(label: string) { await act(async () => button(label).click()); }

describe('bounded polygon vertex properties', () => {
  it('keeps maximum-size polygons editable with five inputs and reaches the final vertex without a workflow', async () => {
    const points: CadPoint2[] = []; const corners = [[0, 0], [20, 0], [20, 10], [0, 10], [0, 0]];
    for (let side = 0; side < 4; side++) for (let step = 0; step < 512; step++) {
      const start = corners[side], end = corners[side + 1]; points.push([start[0] + (end[0] - start[0]) * step / 512, start[1] + (end[1] - start[1]) * step / 512]);
    }
    await mount(points); const before = session.getSnapshot(); expect(currentPolygon().points).toHaveLength(2048);
    expect(button('Previous polygon vertex').querySelector('[data-workbench-icon="navigate-back"]')?.getAttribute('aria-hidden')).toBe('true');
    expect(button('Next polygon vertex').querySelector('[data-workbench-icon="navigate-forward"]')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelectorAll('input')).toHaveLength(5); expect(button('Previous polygon vertex').disabled).toBe(true);
    await input(picker(), '2048'); expect(field('X').value).toBe('0'); expect(field('Y').value).toBe(String(10 / 512));
    expect(button('Next polygon vertex').disabled).toBe(true); expect(container.querySelectorAll('input')).toHaveLength(5);
    await input(picker(), '2049'); expect(picker().value).toBe('2048');
    await click('Previous polygon vertex'); expect(picker().value).toBe('2047'); expect(session.getSnapshot()).toBe(before);
  });

  it('preserves expression edits across vertices and applies one immutable update with exact source lineage', async () => {
    await mount(); const before = session.getSnapshot(); const source = currentSketch().source;
    await click('Next polygon vertex'); await input(field('X'), 'width + 5');
    await click('Next polygon vertex'); await input(field('X'), 'width + 5'); await input(field('Y'), 'height + 2');
    await click('Next polygon vertex'); await input(field('Y'), 'height + 2');
    await input(picker(), '2'); expect(field('X').value).toBe('width + 5');
    expect(session.getSnapshot()).toMatchObject({ document: before.document, version: before.version, canUndo: false, workflowOpen: true });
    await click('Apply'); expect(currentPolygon().points).toEqual([[0, 0], ['width + 5', 0], ['width + 5', 'height + 2'], [0, 'height + 2']]);
    expect(measureCadSketch(session.getSnapshot().document, 'outline').materialAreaMm2).toBe(300);
    expect(currentSketch().source).toEqual(source); expect(currentSketch().source?.text).toBe(dxf); expect(session.getSnapshot().workflowOpen).toBe(false);
    await act(async () => session.undo()); expect(session.getSnapshot().document).toEqual(before.document); expect(session.getSnapshot().canUndo).toBe(false);
  });

  it('retains a geometrically invalid multi-vertex draft and cancels every coordinate without changing history', async () => {
    await mount(); const before = session.getSnapshot();
    await click('Next polygon vertex'); await input(field('Y'), 'height'); await click('Next polygon vertex'); await input(field('X'), 'width');
    await click('Apply'); expect(container.querySelector('[role="alert"]')?.textContent).toBeTruthy();
    expect(session.getSnapshot()).toMatchObject({ document: before.document, version: before.version, canUndo: false, workflowOpen: true });
    await click('Previous polygon vertex'); expect(field('Y').value).toBe('height'); await click('Next polygon vertex'); expect(field('X').value).toBe('width');
    await click('Cancel'); expect(picker().value).toBe('1'); await click('Next polygon vertex'); expect(field('Y').value).toBe('0');
    expect(session.getSnapshot()).toEqual(before); expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('keeps coordinate focus and native text undo, and prevents picker Enter from applying pending geometry', async () => {
    await mount(); const before = session.getSnapshot(); const coordinate = field('X');
    await act(async () => coordinate.focus()); await input(coordinate, '-2');
    expect(document.activeElement).toBe(coordinate);
    const undo = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => coordinate.dispatchEvent(undo)); expect(undo.defaultPrevented).toBe(false);
    const next = button('Next polygon vertex'); await act(async () => next.focus());
    await click('Next polygon vertex'); expect(document.activeElement).toBe(next);
    await input(picker(), '4'); const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    await act(async () => picker().dispatchEvent(enter)); expect(enter.defaultPrevented).toBe(true);
    const composing = new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
    await act(async () => picker().dispatchEvent(composing)); expect(composing.defaultPrevented).toBe(false);
    expect(session.getSnapshot()).toMatchObject({ document: before.document, version: before.version, canUndo: false, workflowOpen: true });
    await input(picker(), '1'); expect(field('X').value).toBe('-2');
  });
});
