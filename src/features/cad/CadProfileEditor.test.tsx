import { act, useState, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importCadDxfSketch } from '@/domain/cad/cadDxfImport';
import { createCadDocument, parseCadDocument } from '@/domain/cad/cadSchema';
import type { CadDocument, CadPathSegment, CadProfile, CadSketchFeature } from '@/domain/cad/cadDocument';
import { resolveCadProfile } from '@/domain/cad/cadSketchGeometry';
import { measureCadSketch } from '@/domain/cad/cadMeasurements';
import { CadSession } from './cadSession';
import { CadProfileEditor } from './CadFeatureEditor';
import { cadSketchProfileEdits, cadSketchProfileViews } from '@/domain/cad/sketch-generators/cadSketchProfileViews';

const dxf = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES',
  '0', 'LINE', '8', 'PROFILE', '10', '0', '20', '0', '11', '20', '21', '0',
  '0', 'ARC', '8', 'PROFILE', '10', '10', '20', '0', '40', '10', '50', '0', '51', '180', '0', 'ENDSEC', '0', 'EOF', ''].join('\r\n');
let root: Root;
let container: HTMLDivElement;
let session: CadSession;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function currentSketch(): CadSketchFeature {
  const feature = session.getSnapshot().document.features[0];
  if (!feature || feature.kind !== 'sketch') throw new Error('Imported sketch missing');
  return feature;
}
function currentPath(): Extract<CadProfile, { kind: 'path' }> {
  const path = currentSketch().profiles[0]?.geometry;
  if (!path || path.kind !== 'path') throw new Error('Analytic path missing');
  return path;
}
async function mount(geometry?: Extract<CadProfile, { kind: 'path' }>) {
  const { sketch } = importCadDxfSketch({ fileName: 'Profile.dxf', text: dxf, sketchId: 'sketch' });
  const document: CadDocument = parseCadDocument({ ...createCadDocument('Imported contour'), parameters: { width: 40, lift: 5 },
    features: [geometry ? { ...sketch, profiles: sketch.profiles.map(profile => ({ ...profile, geometry })) } : sketch] });
  session = new CadSession(document);
  function Harness() {
    const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
    const [epoch, setEpoch] = useState(0);
    const feature = snapshot.document.features[0];
    if (feature?.kind !== 'sketch' || !feature.profiles[0]) throw new Error('Profile missing');
    return <CadProfileEditor key={epoch} profile={feature.profiles[0]} document={snapshot.document}
      onApply={profile => { session.edit([{ kind: 'update-feature', feature: { ...feature, profiles: feature.profiles.map(entry => entry.id === profile.id ? profile : entry) } }], snapshot.version); }}
      onCancel={() => setEpoch(previous => previous + 1)} onPendingChange={session.setWorkflowOpen} />;
  }
  await act(async () => root.render(<Harness />));
}
function field(label: string): HTMLInputElement {
  const input = [...container.querySelectorAll('label')].find(element => element.querySelector('span')?.childNodes[0]?.textContent === label)?.querySelector('input');
  if (!input) throw new Error(`Field ${label} missing`);
  return input;
}
async function input(element: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('Native input setter missing');
  await act(async () => { setter.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find(element => element.getAttribute('aria-label') === label || element.textContent?.trim() === label);
  if (!button) throw new Error(`Button ${label} missing`);
  await act(async () => button.click());
}
describe('imported analytic profile editing', () => {
  it('previews the accepted owning sketch when another sketch uses the same local profile ID', async () => {
    const document = parseCadDocument({ ...createCadDocument('Shared profile IDs', 'cad_shared_profile_ids'), features: [
      { id: 'first', name: 'First', kind: 'sketch', suppressed: false, plane: 'XY', offset: 0,
        profiles: [{ id: 'circle', name: 'First circle', construction: false, geometry: { kind: 'circle', x: 0, y: 0, radius: 2 } }] },
      { id: 'second', name: 'Second', kind: 'sketch', suppressed: false, plane: 'XY', offset: 0,
        profiles: [{ id: 'circle', name: 'Second circle', construction: false, geometry: { kind: 'circle', x: 0, y: 0, radius: 3 } }] }
    ] });
    const second = document.features[1]; if (second.kind !== 'sketch') throw new Error('Missing second sketch');
    const preview = vi.fn<(candidate: CadDocument | null) => void>();
    await act(async () => root.render(<CadProfileEditor document={document} profile={second.profiles[0]} onApply={() => undefined}
      onPendingChange={() => undefined} onCancel={() => undefined} onPreviewDocument={preview} />));
    await input(field('Radius'), '7');
    expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ features: [document.features[0],
      { ...second, profiles: [{ ...second.profiles[0], geometry: { ...second.profiles[0].geometry, radius: '7' } }] }
    ] }), null);
    expect(second.profiles[0].geometry).toMatchObject({ radius: 3 });
  });
  it('starts again from each revision of the part that holds the profile, also where the revision kept its object', async () => {
    const document = parseCadDocument({ ...createCadDocument('Revised part', 'cad_revised_part'), parameters: { size: 2 }, features: [
      { id: 'sketch', name: 'Sketch', kind: 'sketch', suppressed: false, plane: 'XY', offset: 0,
        profiles: [{ id: 'circle', name: 'Circle', construction: false, geometry: { kind: 'circle', x: 0, y: 0, radius: 'size' } }] }] });
    const revised = parseCadDocument({ ...document, parameters: { size: 3 } }), [sketch] = revised.features;
    if (sketch?.kind !== 'sketch' || sketch !== document.features[0]) throw new Error('Expected the revision to keep its sketch');
    const pending = vi.fn<(pending: boolean) => void>();
    const render = (part: CadDocument) => act(async () => root.render(<CadProfileEditor document={part} profile={sketch.profiles[0]}
      onApply={() => undefined} onPendingChange={pending} onCancel={() => undefined} />));
    await render(document);
    await input(field('Radius'), '7');
    expect(pending).toHaveBeenLastCalledWith(true);
    await render(revised);
    expect(field('Radius').value).toBe('size');
    expect(pending).toHaveBeenLastCalledWith(false);
  });
  it('navigates one bounded line/arc editor without starting a geometry workflow', async () => {
    await mount(); const before = session.getSnapshot();
    expect(field('Start X').value).toBe('0'); expect(field('End X').value).toBe('20'); expect(container.querySelectorAll('input')).toHaveLength(7);
    expect(container.querySelector('[aria-label="Previous path segment"] [data-workbench-icon="navigate-back"]')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('[aria-label="Next path segment"] [data-workbench-icon="navigate-forward"]')?.getAttribute('aria-hidden')).toBe('true');
    await click('Next path segment');
    expect(field('Center X').value).toBe('10'); expect(field('Radius').value).toBe('10'); expect(field('Start angle').value).toBe('0'); expect(field('Sweep').value).toBe('180');
    expect(container.querySelectorAll('input')).toHaveLength(8); expect(container.querySelector<HTMLButtonElement>('[aria-label="Next path segment"]')?.disabled).toBe(true);
    await click('Previous path segment'); expect(field('End X').value).toBe('20');
    expect(session.getSnapshot()).toBe(before); expect(container.querySelector('.cad-form-actions')).toBeNull();
  });
  it('applies line and arc expressions as one exact closed path, retaining original DXF and clockwise sweep', async () => {
    await mount(); const before = session.getSnapshot(); const source = currentSketch().source;
    await input(field('Start Y'), 'lift'); await input(field('End X'), 'width'); await input(field('End Y'), 'lift');
    await click('Next path segment');
    await input(field('Center X'), 'width / 2'); await input(field('Center Y'), 'lift'); await input(field('Radius'), 'width / 2'); await input(field('Start angle'), '360 / 2 - 180'); await input(field('Sweep'), '-180');
    expect(session.getSnapshot().version).toBe(before.version); expect(session.getSnapshot().workflowOpen).toBe(true);
    await click('Apply');
    const updated = session.getSnapshot(); expect(updated.version).not.toBe(before.version); expect(updated.workflowOpen).toBe(false);
    expect(currentPath().segments).toEqual([
      { kind: 'line', start: [0, 'lift'], end: ['width', 'lift'] },
      { kind: 'arc', center: ['width / 2', 'lift'], radius: 'width / 2', startAngle: '360 / 2 - 180', sweep: '-180' }
    ]);
    expect(resolveCadProfile(currentPath(), updated.document.parameters)).toMatchObject({ segments: [
      { kind: 'line', start: [0, 5], end: [40, 5] }, { kind: 'arc', center: [20, 5], radius: 20, startAngle: 0, sweep: -180 }
    ] });
    expect(measureCadSketch(updated.document, 'sketch').materialAreaMm2).toBeCloseTo(200 * Math.PI);
    expect(currentSketch().source).toEqual(source); expect(currentSketch().source?.text).toBe(dxf); expect(currentSketch().profiles[0].role).toBeUndefined();
    await act(async () => session.undo()); expect(session.getSnapshot().document).toEqual(before.document);
  });
  it('rejects discontinuity without repairing a joint, changing history or losing its draft', async () => {
    await mount(); const before = session.getSnapshot();
    await input(field('End X'), '21'); await click('Apply');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Match adjacent endpoints');
    expect(session.getSnapshot().document).toBe(before.document); expect(session.getSnapshot().version).toBe(before.version);
    expect(session.getSnapshot().canUndo).toBe(false); expect(session.getSnapshot().workflowOpen).toBe(true);
    await click('Next path segment'); expect(field('Radius').value).toBe('10'); expect(field('Center X').value).toBe('10');
    await click('Previous path segment'); expect(field('End X').value).toBe('21');
    await click('Cancel'); expect(field('End X').value).toBe('20'); expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(session.getSnapshot()).toEqual(before); expect(currentSketch().source?.text).toBe(dxf);
  });
  it('rejects an invalid arc expression and cancellation restores every segment', async () => {
    await mount(); const before = session.getSnapshot();
    await input(field('Start X'), 'lift'); await click('Next path segment'); await input(field('Radius'), 'unknownRadius / 2');
    expect(field('Radius').getAttribute('aria-invalid')).toBe('true'); await click('Apply');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('unknownRadius');
    expect(session.getSnapshot().document).toBe(before.document); expect(session.getSnapshot().version).toBe(before.version);
    await click('Cancel'); expect(field('Start X').value).toBe('0'); await click('Next path segment'); expect(field('Radius').value).toBe('10');
    expect(session.getSnapshot()).toEqual(before);
  });
  it('keeps segment navigation Enter from submitting pending geometry', async () => {
    await mount(); const before = session.getSnapshot();
    await input(field('End X'), '21');
    const selector = container.querySelector<HTMLInputElement>('[aria-label="Path segment"]'); if (!selector) throw new Error('Segment picker missing');
    await input(selector, '2');
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    await act(async () => { selector.dispatchEvent(enter); });
    expect(enter.defaultPrevented).toBe(true); expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(session.getSnapshot().document).toBe(before.document); expect(session.getSnapshot().version).toBe(before.version);
    expect(session.getSnapshot().canUndo).toBe(false); expect(session.getSnapshot().workflowOpen).toBe(true);
    await click('Previous path segment'); expect(field('End X').value).toBe('21');
  });
  it('jumps to distant segments in a large exact contour while keeping constant editor size', async () => {
    const segments: CadPathSegment[] = [];
    const corners = [[0, 0], [40, 0], [40, 20], [0, 20], [0, 0]];
    for (let side = 0; side < 4; side += 1) for (let index = 0; index < 128; index += 1) {
      const start = corners[side], end = corners[side + 1];
      const point = (fraction: number): readonly [number, number] => [start[0] + (end[0] - start[0]) * fraction, start[1] + (end[1] - start[1]) * fraction];
      segments.push({ kind: 'line', start: point(index / 128), end: point((index + 1) / 128) });
    }
    await mount({ kind: 'path', segments }); const before = session.getSnapshot();
    const selector = container.querySelector<HTMLInputElement>('[aria-label="Path segment"]'); if (!selector) throw new Error('Segment picker missing');
    await input(selector, '512'); expect(selector.value).toBe('512'); expect(field('End Y').value).toBe('0');
    expect(container.querySelectorAll('input')).toHaveLength(7); expect(container.querySelector<HTMLButtonElement>('[aria-label="Next path segment"]')?.disabled).toBe(true);
    await input(selector, '513'); expect(selector.value).toBe('512'); expect(session.getSnapshot()).toBe(before);
  });
});

describe('generator profile editing', () => {
  it('shows the relations a regeneration removes, and applies exactly the previewed edit when Apply confirms them', async () => {
    const document = parseCadDocument({ ...createCadDocument('Rounded plate', 'cad_rounded_plate'), schemaVersion: 2, features: [{ id: 'sketch', name: 'Sketch',
      kind: 'sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: { points: [{ id: 'u', position: [0, 0] }], entities: [], relations: [
        { id: 'rect', kind: 'generator', idPrefix: 'g-rect', construction: false, geometry: { kind: 'rectangle', x: 0, y: 0, width: 20, height: 10, cornerRadius: 0 } },
        { id: 'tie', kind: 'coincident', pointIds: ['u', 'g-rect_p0'] }] } }] });
    session = new CadSession(document);
    const before = session.getSnapshot(), previews: (CadDocument | null)[] = [];
    const applied = vi.fn<(removed: readonly string[] | undefined) => void>();
    function Harness() {
      const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
      const sketch = snapshot.document.features[0] as CadSketchFeature, profile = cadSketchProfileViews(sketch)[0];
      return <CadProfileEditor profile={profile} document={snapshot.document} onPreviewDocument={candidate => { previews.push(candidate); }}
        onApply={(next, parameters, _signal, removed) => { applied(removed); session.edit(cadSketchProfileEdits(sketch, next, parameters, removed), snapshot.version); }}
        onCancel={() => undefined} onPendingChange={() => undefined} />;
    }
    await act(async () => root.render(<Harness />));
    // Rounding the corners regenerates them as arcs, so the sharp corner the free point is tied to leaves, and its relation with it.
    await input(field('Corner radius'), '2');
    const notice = [...container.querySelectorAll('[role="status"]')].find(element => element.textContent?.startsWith('This removes one relation'));
    expect(notice?.textContent).toMatch(/^This removes one relation on geometry the shape no longer has: Coincident relation 2 · .*\. Apply removes it, or Cancel keeps it\.$/);
    const shown = previews.filter(Boolean).at(-1)!;
    expect((shown.features[0] as CadSketchFeature).graph!.relations.filter(relation => !relation.id.startsWith('g-rect_')).map(relation => relation.id)).toEqual(['rect']);
    expect(session.getSnapshot()).toBe(before);
    await click('Apply');
    expect(applied).toHaveBeenCalledExactlyOnceWith(['tie']);
    expect(session.getSnapshot().document).toEqual(shown);
  });
});
