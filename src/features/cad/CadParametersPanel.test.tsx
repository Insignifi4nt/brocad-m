import { act, createRef, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCadDocument, parseCadDocument } from '@/domain/cad/cadSchema';
import type { CadSketchFeature } from '@/domain/cad/cadDocument';
import type { CadSketchGenerator } from '@/domain/cad/cadSketchGraph';
import { expandCadSketchGenerators } from '@/domain/cad/sketch-generators/cadSketchGenerators';
import { applyCadEdits, type CadEdit } from '@/domain/cad/cadOperations';
import { CAD_GEAR_V2_PLUGIN } from '@/domain/cad/plugins/cadPlugins';
import { CadSession } from './cadSession';
import { CadParametersPanel, type CadParametersPanelControls } from './CadParametersPanel';

let container: HTMLDivElement, root: Root;
// The tree's Parameters menu drives these commands.
const controls = createRef<CadParametersPanelControls>();
async function create(kind: 'parameter' | 'group') { await act(async () => controls.current?.create(kind)); }
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
function dialog() { const panel = document.querySelector<HTMLDivElement>('.cad-parameter-editor'); if (!panel) throw new Error('Missing floating parameter editor'); return panel; }
async function click(label: string) {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(button => button.getAttribute('aria-label') === label || button.textContent?.trim() === label);
  if (!button) throw new Error(`Missing button ${label}`); await act(async () => button.click());
}
async function input(label: string, value: string) {
  const element = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!element) throw new Error(`Missing ${label}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('Missing native setter');
  await act(async () => { setter.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); });
}
function linkedDocument() {
  return { ...createCadDocument(), parameters: { radius: 3, freeValue: 9 }, features: [{ id: 'sketch', name: 'Shaft section', kind: 'sketch' as const, suppressed: false, plane: 'XY' as const, offset: 0,
    profiles: [{ id: 'circle', name: 'Bore', construction: false, geometry: { kind: 'circle' as const, x: 0, y: 0, radius: 'radius' } }] }] };
}
async function renderPanel(session = new CadSession(linkedDocument())) {
  const inspect = vi.fn(), pending = vi.fn(), edits = vi.fn((batch: readonly CadEdit[]) => { session.edit(batch); });
  function Harness() {
    const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
    return <CadParametersPanel controls={controls} document={state.document} onEditMany={edits} onInspectParameter={inspect} onPendingChange={pending} interactionLocked={false} cancelSignal={0} />;
  }
  await act(async () => root.render(<Harness />)); return { session, inspect, pending, edits };
}
describe('document parameter editing', () => {
  it('asks before a value removes relations as a generator regenerates, and applies the confirmed removal in the same edit', async () => {
    const polygon: CadSketchGenerator = { id: 'poly', kind: 'generator', idPrefix: 'g-poly', construction: false,
      geometry: { kind: 'regular-polygon', x: 0, y: 0, radius: 10, sides: 'n', directionId: '@h' } };
    const corner = expandCadSketchGenerators({ points: [], entities: [], relations: [polygon] }, { n: 5 }).points.find(point => point.id === 'g-poly_v4')!.position;
    const session = new CadSession(parseCadDocument({ ...createCadDocument(), schemaVersion: 2, parameters: { n: 5 }, features: [{ id: 'sketch', name: 'Plate', kind: 'sketch',
      suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: { points: [{ id: 'u', position: corner }], entities: [],
        relations: [polygon, { id: 'c4', kind: 'coincident', pointIds: ['u', 'g-poly_v4'] }] } }] }));
    const { edits } = await renderPanel(session), before = session.getSnapshot();
    // Four sides lose the fifth corner and the relation on it: Apply first says so and changes nothing.
    await click('Edit parameter n'); await input('Parameter value', '4'); await click('Apply');
    expect(dialog().querySelector('[role="status"]')?.textContent).toMatch(/^This removes one relation on geometry the shape no longer has: Coincident relation 2 · .*\. Apply removes it, or Cancel keeps it\.$/);
    expect(dialog().querySelector('[role="alert"]')).toBeNull();
    expect(session.getSnapshot()).toBe(before);
    await click('Apply');
    expect(edits).toHaveBeenLastCalledWith([{ kind: 'set-parameter', name: 'n', value: 4, removedRelationIds: ['c4'] }], expect.anything());
    const graph = (session.getSnapshot().document.features[0] as CadSketchFeature).graph!;
    expect(graph.relations.filter(relation => !relation.id.startsWith('g-poly_')).map(relation => relation.id)).toEqual(['poly']);
    expect(document.querySelector('.cad-parameter-editor')).toBeNull();
    // A changed value asks again rather than confirming a removal it was not shown.
    session.undo();
    await click('Edit parameter n'); await input('Parameter value', '4'); await click('Apply'); await input('Parameter value', '3');
    expect(dialog().querySelector('[role="status"]')).toBeNull();
  });

  it('retains a rejected asynchronous edit and cancels its old owner before another editor opens', async () => {
    const session = new CadSession(linkedDocument()), pending = vi.fn();
    let rejectEdit: (error: Error) => void = () => { throw new Error('Edit was not started.'); };
    let acceptEdit: () => void = () => { throw new Error('Edit was not started.'); };
    let activeSignal: AbortSignal | undefined;
    const apply = vi.fn((batch: readonly CadEdit[], signal?: AbortSignal) => {
      activeSignal = signal;
      return new Promise<void>((resolve, reject) => { rejectEdit = reject; acceptEdit = () => { signal?.throwIfAborted(); session.edit(batch); resolve(); }; });
    });
    await act(async () => root.render(<CadParametersPanel document={session.getSnapshot().document} onEditMany={apply}
      onInspectParameter={() => {}} onPendingChange={pending} interactionLocked={false} cancelSignal={0} />));
    const before = session.getSnapshot();
    await click('Edit parameter radius'); await input('Parameter value', '5'); await click('Apply');
    expect(dialog().querySelector<HTMLInputElement>('input[aria-label="Parameter value"]')?.value).toBe('5');
    expect(dialog().querySelector<HTMLInputElement>('input[aria-label="Parameter value"]')?.disabled || dialog().querySelector('fieldset')?.disabled).toBe(true);
    expect(pending).toHaveBeenLastCalledWith(true);
    await act(async () => rejectEdit(new Error('These constraints conflict.')));
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('constraints conflict');
    expect(dialog().querySelector<HTMLInputElement>('input[aria-label="Parameter value"]')?.value).toBe('5');
    expect(session.getSnapshot()).toBe(before);
    await click('Apply'); await click('Close parameter editor');
    expect(activeSignal?.aborted).toBe(true);
    await click('Edit parameter freeValue');
    expect(() => acceptEdit()).toThrow();
    await act(async () => rejectEdit(new DOMException('Cancelled', 'AbortError')));
    expect(dialog().getAttribute('aria-label')).toBe('Edit freeValue');
    expect(dialog().querySelector('[role="alert"]')).toBeNull();
    expect(session.getSnapshot()).toBe(before);
  });
  it.each([4e-9, -4e-9])('keeps the nonzero named angle %s visible while its raw editor and Cancel retain exact data', async angle => {
    const initial = { ...createCadDocument(), parameters: { tilt: angle, ordinary: 1234567.891234567 }, features: [{ id: 'slot', name: 'Slot', kind: 'sketch' as const,
      suppressed: false, plane: 'XY' as const, offset: 0, profiles: [{ id: 'profile', name: 'Slot', construction: false,
        geometry: { kind: 'slot' as const, x: 0, y: 0, length: 20, width: 8, angle: ' tilt ' } }] }] };
    const { session, edits } = await renderPanel(new CadSession(initial)), before = session.getSnapshot();
    expect(container.querySelector('[aria-label="Edit parameter tilt"] output')?.textContent).toBe(angle.toLocaleString(undefined, { notation: 'scientific', maximumSignificantDigits: 6, useGrouping: false }));
    expect(container.querySelector('[aria-label="Edit parameter ordinary"] output')?.textContent).toBe(initial.parameters.ordinary.toLocaleString(undefined, { maximumFractionDigits: 8, useGrouping: false }));
    await click('Edit parameter tilt'); expect(document.querySelector<HTMLInputElement>('input[aria-label="Parameter value"]')?.value).toBe(String(angle));
    await click('Cancel'); expect(session.getSnapshot()).toBe(before); expect(edits).not.toHaveBeenCalled();
  });

  it('opens beside the sidebar, shows real usage and preserves a linked rename atomically', async () => {
    const { session, inspect, pending, edits } = await renderPanel();
    await click('Edit parameter radius');
    expect(container.querySelector('.cad-parameter-editor')).toBeNull(); expect(dialog().parentElement).toBe(document.body);
    expect(dialog().textContent).toContain('Shaft section'); expect(inspect).toHaveBeenLastCalledWith('radius'); expect(pending).toHaveBeenLastCalledWith(true);
    await input('Parameter name', 'shaftRadius'); await input('Parameter value', '5'); await click('Apply');
    const state = session.getSnapshot(); expect(state.document.parameters).toEqual({ shaftRadius: 5, freeValue: 9 });
    const sketch = state.document.features[0]; expect(sketch.kind === 'sketch' && sketch.profiles[0].geometry.kind === 'circle' && sketch.profiles[0].geometry.radius).toBe('shaftRadius');
    expect(edits).toHaveBeenCalledTimes(1); expect(document.querySelector('.cad-parameter-editor')).toBeNull(); expect(pending).toHaveBeenLastCalledWith(false);
    await act(async () => session.undo()); expect(session.getSnapshot().document.parameters.radius).toBe(3);
  });
  it('keeps invalid edits and duplicate additions in the floating form without writes', async () => {
    const { session, edits } = await renderPanel(); const before = session.getSnapshot().document;
    await click('Edit parameter radius'); await input('Parameter value', '0'); await click('Apply');
    expect(dialog().querySelector('[role="alert"]')).not.toBeNull(); expect(session.getSnapshot().document).toBe(before); expect(document.querySelector<HTMLInputElement>('input[aria-label="Parameter value"]')?.value).toBe('0');
    await click('Cancel'); await create('parameter'); await input('Parameter name', 'radius'); await input('Parameter value', '100'); await click('Apply');
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('already exists'); expect(session.getSnapshot().document).toBe(before);
    await input('Parameter name', 'clearance'); await input('Parameter value', '0.5'); await click('Apply'); expect(session.getSnapshot().document.parameters.clearance).toBe(0.5);
    expect(edits).toHaveBeenCalledTimes(2); // Rejected geometry attempt and accepted addition; duplicate rejected in UI.
  });
  it('creates and renames groups, moves a value, and ungroups without deleting it', async () => {
    const { session } = await renderPanel();
    await create('group'); await input('Group name', 'Dimensions'); await click('Apply');
    const groupId = session.getSnapshot().document.parameterGroups?.[0].id; expect(groupId).toBeTruthy();
    await click('Edit parameter freeValue');
    const select = dialog().querySelector<HTMLSelectElement>('select'); if (!select || !groupId) throw new Error('Missing group choice');
    await act(async () => { select.value = groupId; select.dispatchEvent(new Event('change', { bubbles: true })); }); await click('Apply');
    expect(session.getSnapshot().document.parameterMetadata?.freeValue.groupId).toBe(groupId);
    await click('Rename parameter group Dimensions'); await input('Group name', 'Plate settings'); await click('Apply');
    expect(container.textContent).toContain('Plate settings'); await click('Rename parameter group Plate settings'); await click('Remove parameter group');
    expect(session.getSnapshot().document.parameters.freeValue).toBe(9); expect(session.getSnapshot().document.parameterMetadata?.freeValue.groupId).toBeUndefined();
  });
  it('distinguishes plugin-linked parameters from local profile inputs', async () => {
    const initial = linkedDocument();
    const doc = applyCadEdits(initial, [{ kind: 'add-plugin-profile', sketchId: 'sketch', profileId: 'gear', name: 'Gear', package: CAD_GEAR_V2_PLUGIN, groupId: 'gear_dimensions' }]);
    await renderPanel(new CadSession(doc));
    expect(container.textContent).toContain('Gear'); expect(container.querySelector('.cad-local-inputs')?.textContent).toContain('Rotation');
    const row = Array.from(container.querySelectorAll<HTMLButtonElement>('.cad-parameter-list-row')).find(button => button.textContent?.includes('Module'));
    if (!row) throw new Error('Missing linked Module parameter');
    expect(row.querySelector('.cad-parameter-origin svg')).not.toBeNull(); await act(async () => row.click());
    expect(dialog().textContent).toContain('module'); expect(dialog().querySelector<HTMLButtonElement>('button[aria-label="Remove parameter"]')?.disabled).toBe(true);
  });
  it('cancels on Escape and restores focus without a mutation', async () => {
    const { session, edits } = await renderPanel(); const before = session.getSnapshot().document;
    const row = container.querySelector<HTMLButtonElement>('button[aria-label="Edit parameter freeValue"]'); if (!row) throw new Error('Missing parameter row');
    await act(async () => { row.focus(); row.click(); }); await input('Parameter value', '75');
    await act(async () => dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.activeElement).toBe(row); expect(document.querySelector('.cad-parameter-editor')).toBeNull(); expect(session.getSnapshot().document).toBe(before); expect(edits).not.toHaveBeenCalled();
  });
  it('rejects a stale editor without replacing newer values', async () => {
    const { session, edits } = await renderPanel();
    await click('Edit parameter freeValue'); await input('Parameter value', '75');
    await act(async () => session.edit([{ kind: 'set-parameter', name: 'freeValue', value: 22 }]));
    await click('Apply');
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('part changed'); expect(session.getSnapshot().document.parameters.freeValue).toBe(22); expect(edits).not.toHaveBeenCalled();
  });
  it('cancels through the parent signal and blocks starting a locked editor', async () => {
    const doc = linkedDocument(), pending = vi.fn(), edit = vi.fn(), inspect = vi.fn();
    const render = (signal: number, locked = false) => root.render(<CadParametersPanel controls={controls} document={doc} onEditMany={edit} onInspectParameter={inspect} onPendingChange={pending} interactionLocked={locked} cancelSignal={signal} />);
    await act(async () => render(0)); await click('Edit parameter freeValue'); await input('Parameter value', '75');
    await act(async () => render(1)); expect(document.querySelector('.cad-parameter-editor')).toBeNull(); expect(pending).toHaveBeenLastCalledWith(false); expect(edit).not.toHaveBeenCalled();
    await act(async () => render(1, true)); await create('parameter'); expect(document.querySelector('.cad-parameter-editor')).toBeNull();
  });
});
