import { act, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CadDocument, CadSketchProfile } from '@/domain/cad/cadDocument';
import { createCadDocument, parseCadDocument } from '@/domain/cad/cadSchema';
import type { CadEdit } from '@/domain/cad/cadOperations';
import type { CadSketchGenerator } from '@/domain/cad/cadSketchGraph';
import { expandCadSketchGenerators } from '@/domain/cad/sketch-generators/cadSketchGenerators';
import { CadSession } from './cadSession';
import { CadSketchProfilePanel } from './CadSketchProfilePanel';

let container: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
function makeDocument(profile: CadSketchProfile, parameters: CadDocument['parameters'] = {}): CadDocument {
  return { ...createCadDocument(), parameters, features: [{ id: 'sketch', name: 'Part section', kind: 'sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [profile] }] };
}
const rectangle: CadSketchProfile = { id: 'profile', name: 'Part', construction: false, role: 'outer', geometry: { kind: 'rectangle', x: 10, y: 20, width: 30, height: 15, cornerRadius: 0 } };
async function mount(profile = rectangle, parameters: CadDocument['parameters'] = {}) {
  const session = new CadSession(makeDocument(profile, parameters)), pending = vi.fn(), preview = vi.fn(), previewParameters = vi.fn();
  function Harness() {
    const state = useSyncExternalStore(session.subscribe, session.getSnapshot), sketch = state.document.features[0];
    if (sketch.kind !== 'sketch') throw new Error('Missing sketch');
    return <CadSketchProfilePanel document={state.document} sketch={sketch} profile={sketch.profiles[0]} onEditMany={edits => session.edit(edits)} onPendingChange={pending} onPreviewProfile={preview} onPreviewParameters={previewParameters} interactionLocked={false} cancelSignal={0} />;
  }
  await act(async () => root.render(<Harness />)); return { session, pending, preview, previewParameters };
}
async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find(entry => entry.getAttribute('aria-label') === label || entry.textContent?.trim() === label);
  if (!button) throw new Error(`Missing ${label}`); await act(async () => button.click());
}
async function input(label: string, value: string) {
  const field = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`); if (!field) throw new Error(`Missing ${label}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set; if (!setter) throw new Error('Missing native setter');
  await act(async () => { setter.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
}
function profile(session: CadSession) { const sketch = session.getSnapshot().document.features[0]; if (sketch.kind !== 'sketch') throw new Error('Missing sketch'); return sketch.profiles[0]; }
describe('explicit sketch intent panel', () => {
  it('previews the complete solved candidate and discards a cancelled input without touching the draft', async () => {
    const source = parseCadDocument({ ...makeDocument({ ...rectangle, constraints: [{ id: 'width-size', kind: 'dimension', quantity: 'width' }],
      geometry: { kind: 'rectangle', x: 10, y: 20, width: 'size', height: 15, cornerRadius: 0 } }, { size: 30 }), schemaVersion: 2,
      features: [{ ...makeDocument(rectangle).features[0], profiles: [{ ...rectangle, constraints: [{ id: 'width-size', kind: 'dimension', quantity: 'width' }], geometry: { kind: 'rectangle', x: 10, y: 20, width: 'size', height: 15, cornerRadius: 0 } }],
        graph: { points: [{ id: 'a', position: ['0', '0'] }, { id: 'b', position: [30, 0] }], entities: [{ id: 'line', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' }],
          relations: [{ id: 'horizontal', kind: 'horizontal', pointIds: ['a', 'b'] }, { id: 'length', kind: 'distance', pointIds: ['a', 'b'], value: 'size' }] } }] });
    const sketch = source.features[0]; if (sketch.kind !== 'sketch') throw new Error('Missing sketch');
    const session = new CadSession(source), before = session.getSnapshot(), preview = vi.fn(), legacyPreview = vi.fn();
    const requests: { signal: AbortSignal; resolve: (document: CadDocument) => void }[] = [];
    const prepare = vi.fn((_edits: readonly CadEdit[], signal: AbortSignal) => new Promise<CadDocument>(resolve => requests.push({ signal, resolve })));
    await act(async () => root.render(<CadSketchProfilePanel document={source} sketch={sketch} profile={sketch.profiles[0]}
      onEditMany={edits => session.edit(edits)} onPendingChange={() => undefined} onPrepareEdits={prepare} onPreviewDocument={preview}
      onPreviewProfile={legacyPreview} interactionLocked={false} cancelSignal={0} />));
    await click('Configure Width dimension'); await input('Dimension value', '35');
    await act(async () => { await vi.waitFor(() => expect(requests).toHaveLength(1)); });
    await input('Dimension value', '36'); expect(requests[0].signal.aborted).toBe(true);
    await act(async () => { await vi.waitFor(() => expect(requests).toHaveLength(2)); });
    const solved = (size: number) => parseCadDocument({ ...source, parameters: { size }, features: [{ ...sketch, graph: { ...sketch.graph!, points: [{ id: 'a', position: ['0', '0'] }, { id: 'b', position: [size, 0] }] } }] });
    await act(async () => requests[0].resolve(solved(35))); expect(preview.mock.calls.some(([value]) => value !== null)).toBe(false);
    const current = solved(36); await act(async () => requests[1].resolve(current)); expect(preview).toHaveBeenLastCalledWith(current, null);
    expect(legacyPreview.mock.calls.some(([value]) => value !== null)).toBe(false); expect(session.getSnapshot()).toBe(before);
    await click('Cancel'); expect(preview).toHaveBeenLastCalledWith(null, null); expect(session.getSnapshot()).toBe(before);
  });

  it('keeps an accepted tiny named width visible in its constraint list and exact through unchanged Apply and Cancel', async () => {
    const profile: CadSketchProfile = { ...rectangle, constraints: [{ id: 'tiny', kind: 'dimension', quantity: 'width' }],
      geometry: { kind: 'rectangle', x: 0, y: 0, width: ' size ', height: 20, cornerRadius: 0 } };
    const { session } = await mount(profile, { size: 4e-7 }), before = session.getSnapshot();
    expect(container.querySelector('[aria-label="Configure Width dimension"] span')?.textContent).toBe('4e-7 mm');
    await click('Configure Width dimension'); expect(container.querySelector<HTMLInputElement>('[aria-label="Dimension value"]')?.value).toBe('4e-7');
    await click('Apply'); expect(session.getSnapshot()).toBe(before);
    await click('Configure Width dimension'); await click('Cancel'); expect(session.getSnapshot()).toBe(before);
  });

  it('adds an explicit width as one atomic edit, preserving placement and shape metadata', async () => {
    const { session, pending } = await mount(); const before = session.getSnapshot();
    await click('Add dimension'); expect(pending).toHaveBeenLastCalledWith(true);
    await input('Dimension value', '40'); await click('Apply');
    const next = profile(session);
    expect(next.geometry).toEqual({ ...rectangle.geometry, width: 40 }); expect(next.role).toBe('outer');
    expect(next.constraints).toEqual([{ id: expect.any(String), kind: 'dimension', quantity: 'width' }]);
    expect(pending).toHaveBeenLastCalledWith(false);
    await act(async () => session.undo()); expect(session.getSnapshot().document).toEqual(before.document);
  });
  it('previews a uniform sketch fillet and cancels without changing the accepted shape', async () => {
    const { session, preview } = await mount(); const before = session.getSnapshot();
    await click('Sketch fillet'); await input('Fillet radius', '3');
    expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ geometry: { ...rectangle.geometry, cornerRadius: 3 } }));
    await click('Cancel'); expect(session.getSnapshot()).toBe(before); expect(preview).toHaveBeenLastCalledWith(null);
    await click('Sketch fillet'); await input('Fillet radius', '8');
    expect(container.querySelector('[role="alert"]')).not.toBeNull(); await click('Apply'); expect(session.getSnapshot()).toBe(before);
  });
  it('moves an explicitly dimensioned rectangle without changing size or constraints', async () => {
    const { session } = await mount({ ...rectangle, constraints: [{ id: 'width', kind: 'dimension', quantity: 'width' }] });
    await click('Move profile'); await input('Move X', '5'); await input('Move Y', '-10'); await click('Apply');
    const next = profile(session);
    expect(next.geometry).toEqual({ ...rectangle.geometry, x: 15, y: 10 }); expect(next.constraints).toEqual([{ id: 'width', kind: 'dimension', quantity: 'width' }]);
  });
  it('removes only the dimension intent and keeps the exact geometry', async () => {
    const { session } = await mount({ ...rectangle, constraints: [{ id: 'width', kind: 'dimension', quantity: 'width' }] });
    await click('Remove Width dimension'); expect(profile(session)).toEqual(rectangle);
  });
  it('offers an explicit relation edit for an arithmetic driver and preserves an unchanged expression exactly', async () => {
    const driven = { ...rectangle, constraints: [{ id: 'width', kind: 'dimension' as const, quantity: 'width' as const }], geometry: { ...rectangle.geometry, kind: 'rectangle' as const, width: '30 / 2', x: 10, y: 20, height: 15, cornerRadius: 0 } };
    const { session } = await mount(driven); const before = session.getSnapshot();
    await click('Configure Width dimension'); await click('Edit expression');
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Dimension expression"]')?.value).toBe('30 / 2');
    await click('Apply'); expect(session.getSnapshot()).toBe(before);
    await click('Configure Width dimension'); await click('Edit expression'); await input('Dimension expression', '48 / 2'); await click('Apply');
    expect(profile(session).geometry).toMatchObject({ width: '48 / 2', height: 15, x: 10, y: 20 });
    await act(async () => session.undo()); expect(profile(session)).toEqual(driven);
  });
  it('explicitly unlinks a diameter expression while preserving full precision and dimension intent', async () => {
    const circle: CadSketchProfile = { id: 'profile', name: 'Bore', construction: false, constraints: [{ id: 'diameter', kind: 'dimension', quantity: 'diameter' }], geometry: { kind: 'circle', x: 0, y: 0, radius: '1 / 3' } };
    const { session } = await mount(circle);
    await click('Configure Diameter dimension'); await click('Unlink expression');
    expect(profile(session)).toEqual({ ...circle, geometry: { ...circle.geometry, radius: 1 / 3 } });
    await act(async () => session.undo()); expect(profile(session)).toEqual(circle);
  });
  it('keeps a legacy expression dimension visible when its relation is explicitly frozen', async () => {
    const circle: CadSketchProfile = { id: 'profile', name: 'Bore', construction: false, geometry: { kind: 'circle', x: 0, y: 0, radius: '1 / 3' } };
    const { session } = await mount(circle);
    await click('Configure Diameter dimension'); await click('Unlink expression');
    expect(profile(session).geometry).toEqual({ ...circle.geometry, radius: 1 / 3 });
    expect(profile(session).constraints).toMatchObject([{ kind: 'dimension', quantity: 'diameter' }]);
    expect(container.querySelector('button[aria-label="Configure Diameter dimension"]')).not.toBeNull();
    await act(async () => session.undo()); expect(profile(session)).toEqual(circle);
  });
  it('edits and unlinks a fillet expression without losing its existing geometry or other constraints', async () => {
    const rounded = { ...rectangle, constraints: [{ id: 'width', kind: 'dimension' as const, quantity: 'width' as const }], geometry: { ...rectangle.geometry, kind: 'rectangle' as const, x: 10, y: 20, width: 30, height: 15, cornerRadius: '1 / 3' } };
    const { session } = await mount(rounded);
    const before = session.getSnapshot();
    await click('Sketch fillet'); await click('Edit expression'); await click('Apply');
    expect(session.getSnapshot()).toBe(before);
    await click('Sketch fillet'); await click('Edit expression'); await input('Fillet expression', '1 / 2'); await click('Apply');
    expect(profile(session)).toEqual({ ...rounded, geometry: { ...rounded.geometry, cornerRadius: '1 / 2' } });
    await click('Sketch fillet'); await click('Unlink expression');
    expect(profile(session)).toEqual({ ...rounded, geometry: { ...rounded.geometry, cornerRadius: .5 } });
    await act(async () => { session.undo(); session.undo(); }); expect(profile(session)).toEqual(rounded);
  });
  it('does not rewrite a saved numeric radius when the entered value is equivalent', async () => {
    const rounded = { ...rectangle, geometry: { ...rectangle.geometry, kind: 'rectangle' as const, x: 10, y: 20, width: 30, height: 15, cornerRadius: '0.3333333333333333' } };
    const { session, preview } = await mount(rounded); const before = session.getSnapshot();
    await click('Sketch fillet'); await input('Fillet radius', ' 0.33333333333333330 ');
    expect(preview).toHaveBeenLastCalledWith(null);
    await click('Apply'); expect(session.getSnapshot()).toBe(before);
    expect(profile(session)).toEqual(rounded); expect(session.getSnapshot().canUndo).toBe(false);
  });
  it('updates a named fillet driver and correlated dimensions until it is deliberately unlinked', async () => {
    const rounded = { ...rectangle, constraints: [{ id: 'width', kind: 'dimension' as const, quantity: 'width' as const }], geometry: { ...rectangle.geometry, kind: 'rectangle' as const, x: 10, y: 20, width: 'toolRadius * 10', height: 15, cornerRadius: ' toolRadius ' } };
    const { session, preview, previewParameters } = await mount(rounded, { toolRadius: 1 }); const before = session.getSnapshot();
    await click('Sketch fillet'); await input('Fillet radius', '1.5');
    expect(preview).toHaveBeenLastCalledWith(rounded); expect(previewParameters).toHaveBeenLastCalledWith({ toolRadius: 1.5 });
    expect(session.getSnapshot()).toBe(before);
    await click('Apply'); expect(profile(session)).toEqual(rounded); expect(session.getSnapshot().document.parameters.toolRadius).toBe(1.5);
    await click('Sketch fillet'); await click('Unlink expression');
    expect(profile(session)).toEqual({ ...rounded, geometry: { ...rounded.geometry, cornerRadius: 1.5 } });
    expect(session.getSnapshot().document.parameters.toolRadius).toBe(1.5);
    await act(async () => { session.undo(); session.undo(); }); expect(session.getSnapshot().document).toEqual(before.document);
  });
  it('rejects invalid fillet relations without changing the part and permits correction or cancellation', async () => {
    const rounded = { ...rectangle, geometry: { ...rectangle.geometry, kind: 'rectangle' as const, x: 10, y: 20, width: 30, height: 15, cornerRadius: '1 / 3' } };
    const { session, preview } = await mount(rounded); const before = session.getSnapshot();
    await click('Sketch fillet'); await click('Edit expression');
    for (const invalid of ['', '-1 / 3', '16 / 2', 'missingRadius']) {
      await input('Fillet expression', invalid);
      expect(container.querySelector('[role="alert"]')).not.toBeNull(); expect(preview).toHaveBeenLastCalledWith(null);
      await click('Apply'); expect(session.getSnapshot()).toBe(before);
    }
    await input('Fillet expression', '3 / 2'); expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(preview).toHaveBeenLastCalledWith({ ...rounded, geometry: { ...rounded.geometry, cornerRadius: '3 / 2' } });
    await click('Cancel'); expect(session.getSnapshot()).toBe(before); expect(preview).toHaveBeenLastCalledWith(null);
  });
  it('rejects both apply and unlink when a fillet draft has become stale', async () => {
    const rounded = { ...rectangle, geometry: { ...rectangle.geometry, kind: 'rectangle' as const, x: 10, y: 20, width: 30, height: 15, cornerRadius: '1 / 3' } };
    const { session, preview } = await mount(rounded);
    await click('Sketch fillet'); await click('Edit expression'); await input('Fillet expression', '1 / 2');
    await act(async () => session.edit([{ kind: 'set-parameter', name: 'externalChange', value: 1 }])); const accepted = session.getSnapshot();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('The part changed'); expect(preview).toHaveBeenLastCalledWith(null);
    await click('Apply'); expect(session.getSnapshot()).toBe(accepted);
    await click('Unlink expression'); expect(container.querySelector('[role="alert"]')?.textContent).toContain('The part changed');
    expect(session.getSnapshot()).toBe(accepted); expect(profile(session)).toEqual(rounded);
    await click('Cancel'); expect(session.getSnapshot()).toBe(accepted);
  });

  it('asks before a parameter-bound dimension removes relations as a generator regenerates, applies the confirmed removal as one edit, and Cancel keeps them', async () => {
    // The width and a five-sided polygon both read n, and a user point sits on the polygon's fifth corner: four removes "c4".
    const polygon: CadSketchGenerator = { id: 'poly', kind: 'generator', idPrefix: 'g-poly', construction: false,
      geometry: { kind: 'regular-polygon', x: 0, y: 0, radius: 10, sides: 'n', directionId: '@h' } };
    const corner = expandCadSketchGenerators({ points: [], entities: [], relations: [polygon] }, { n: 5 }).points.find(point => point.id === 'g-poly_v4')!.position;
    const source = parseCadDocument({ ...createCadDocument(), schemaVersion: 2, parameters: { n: 5 }, features: [{ id: 'sketch', name: 'Part section', kind: 'sketch', suppressed: false, plane: 'XY', offset: 0,
      profiles: [{ ...rectangle, constraints: [{ id: 'width-n', kind: 'dimension', quantity: 'width' }], geometry: { kind: 'rectangle', x: 40, y: 0, width: ' n ', height: 15, cornerRadius: 0 } }],
      graph: { points: [{ id: 'u', position: corner }], entities: [], relations: [polygon, { id: 'c4', kind: 'coincident', pointIds: ['u', 'g-poly_v4'] }] } }] });
    const session = new CadSession(source);
    // The first Apply reaches a part that drops the confirmation, so it is refused as an unconfirmed removal would be.
    let calls = 0;
    const edit = vi.fn((edits: readonly CadEdit[]) => session.edit(calls++ ? edits : edits.map(entry => entry.kind === 'set-parameter' ? { kind: entry.kind, name: entry.name, value: entry.value } : entry)));
    function Harness() {
      const state = useSyncExternalStore(session.subscribe, session.getSnapshot), sketch = state.document.features[0];
      if (sketch.kind !== 'sketch') throw new Error('Missing sketch');
      return <CadSketchProfilePanel document={state.document} sketch={sketch} profile={sketch.profiles[0]} onEditMany={edit} onPendingChange={() => undefined} interactionLocked={false} cancelSignal={0} />;
    }
    await act(async () => root.render(<Harness />));
    const asked = () => container.querySelector('.cad-form-hint[role="status"]')?.textContent ?? null;
    const prompt = /^This removes one relation on geometry the shape no longer has: Coincident relation 2 · .*. Apply removes it, or Cancel keeps it.$/;
    await click('Configure Width dimension'); await input('Dimension value', '4');
    expect(asked()).toMatch(prompt); expect(container.querySelector('[role="alert"]')).toBeNull();
    await click('Apply');
    expect(asked()).toMatch(prompt); expect(container.querySelector('[role="alert"]')).toBeNull(); expect(container.textContent).not.toContain('removedRelationIds');
    expect(session.getSnapshot().document).toBe(source);
    await click('Apply');
    expect(edit).toHaveBeenLastCalledWith([{ kind: 'set-parameter', name: 'n', value: 4, removedRelationIds: ['c4'] }], expect.any(AbortSignal));
    const sketch = session.getSnapshot().document.features[0];
    expect(sketch.kind === 'sketch' && sketch.graph?.relations.filter(relation => !relation.id.startsWith('g-poly_')).map(relation => relation.id)).toEqual(['poly']);
    await act(async () => session.undo()); expect(session.getSnapshot().document).toBe(source);
    await click('Configure Width dimension'); await input('Dimension value', '4'); expect(asked()).toMatch(prompt);
    await click('Cancel');
    expect(asked()).toBeNull(); expect(session.getSnapshot().document).toBe(source); expect(edit).toHaveBeenCalledTimes(2);
  });
});
