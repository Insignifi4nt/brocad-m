import { act, useState, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CadDocument, CadProfile, CadSketchProfile } from '@/domain/cad/cadDocument';
import type { CadEdit } from '@/domain/cad/cadOperations';
import { createCadDocument, parseCadDocument } from '@/domain/cad/cadSchema';
import type { CadSketchGenerator } from '@/domain/cad/cadSketchGraph';
import { expandCadSketchGenerators } from '@/domain/cad/sketch-generators/cadSketchGenerators';
import { CAD_GEAR_V2_PLUGIN, createCadPluginProfile } from '@/domain/cad/plugins/cadPlugins';
import { CadSession } from './cadSession';
import { CadSketchDimensionControls, type CadSketchDimensionControlsProps } from './CadSketchDimensionControls';

let container: HTMLDivElement, root: Root, cancelControls: () => void = () => undefined;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
/** Every fixture is the same part, so a replacement stands for an edit, undo or redo of it. */
function makeDocument(geometry: CadProfile, parameters: Readonly<Record<string, number>> = {}, constraints?: CadSketchProfile['constraints']): CadDocument {
  return { ...createCadDocument('Untitled part', 'cad_part'), parameters, features: [{ id: 'sketch', name: 'Part section', kind: 'sketch', suppressed: false, plane: 'XY', offset: 0,
    profiles: [{ id: 'profile', name: 'Part', construction: false, geometry, ...(constraints ? { constraints } : {}) }] }] };
}
async function click(label: string) {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(button => button.getAttribute('aria-label') === label || button.textContent?.trim() === label);
  if (!button) throw new Error(`Missing ${label}`); await act(async () => button.click());
}
/** A chip is named after its quantity; a click selects it and a double-click or Enter opens its editor. */
function findChip(label: string) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('.cad-dimension-chips > button')).find(button => button.getAttribute('aria-label')?.startsWith(`Dimension ${label.toLowerCase()} `)) ?? null;
}
function chip(label: string) { const found = findChip(label); if (!found) throw new Error(`Missing ${label} chip`); return found; }
async function open(label: string) { await act(async () => chip(label).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }))); }
async function key(label: string, name: string, shiftKey = false) {
  await act(async () => { chip(label).focus(); chip(label).dispatchEvent(new KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true, cancelable: true })); });
}
async function input(label: string, value: string) {
  const element = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`); if (!element) throw new Error(`Missing ${label}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set; if (!setter) throw new Error('Missing native setter');
  await act(async () => { setter.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function renderControls(document: CadDocument, apply?: CadSketchDimensionControlsProps['onEditMany'], project?: CadSketchDimensionControlsProps['project']) {
  const session = new CadSession(document), pending = vi.fn(), inspect = vi.fn(), configure = vi.fn(), error = vi.fn();
  const edit = vi.fn((edits: readonly CadEdit[]) => apply ? apply(edits) : session.edit(edits));
  function Harness() {
    const state = useSyncExternalStore(session.subscribe, session.getSnapshot), sketch = state.document.features[0];
    const [cancelSignal, setCancelSignal] = useState(0); cancelControls = () => setCancelSignal(value => value + 1);
    if (sketch.kind !== 'sketch') throw new Error('Missing test sketch');
    return <CadSketchDimensionControls document={state.document} sketch={sketch} profile={sketch.profiles[0]} parameters={state.document.parameters} anchor={{ x: 200, y: 150 }} project={project} onEditMany={edit} onPendingChange={pending} interactionLocked={false} cancelSignal={cancelSignal} onInspectInput={inspect} onConfigure={configure} onError={error} />;
  }
  await act(async () => root.render(<Harness />)); return { session, pending, inspect, configure, edit, error };
}
function currentGeometry(session: CadSession) { const sketch = session.getSnapshot().document.features[0]; if (sketch.kind !== 'sketch') throw new Error('Missing sketch'); return sketch.profiles[0].geometry; }
describe('on-part sketch dimension editing', () => {
  it('asks before a parameter-bound dimension removes relations as a generator regenerates, applies the confirmed removal as one edit, and Cancel keeps them', async () => {
    // The width and a five-sided polygon both read n, and a user point sits on the polygon's fifth corner: four removes "c4".
    const polygon: CadSketchGenerator = { id: 'poly', kind: 'generator', idPrefix: 'g-poly', construction: false,
      geometry: { kind: 'regular-polygon', x: 0, y: 0, radius: 10, sides: 'n', directionId: '@h' } };
    const corner = expandCadSketchGenerators({ points: [], entities: [], relations: [polygon] }, { n: 5 }).points.find(point => point.id === 'g-poly_v4')!.position;
    const base = makeDocument({ kind: 'rectangle', x: 40, y: 0, width: ' n ', height: 15, cornerRadius: 0 }, { n: 5 }), sketch = base.features[0];
    if (sketch.kind !== 'sketch') throw new Error('Missing sketch');
    const source = parseCadDocument({ ...base, schemaVersion: 2, features: [{ ...sketch, graph: { points: [{ id: 'u', position: corner }], entities: [],
      relations: [polygon, { id: 'c4', kind: 'coincident', pointIds: ['u', 'g-poly_v4'] }] } }] });
    // The first Apply reaches a part that drops the confirmation, so it is refused as an unconfirmed removal would be.
    let calls = 0, session: CadSession | undefined;
    const h = await renderControls(source, edits => session!.edit(calls++ ? edits : edits.map(entry => entry.kind === 'set-parameter' ? { kind: entry.kind, name: entry.name, value: entry.value } : entry)));
    session = h.session;
    const asked = () => container.querySelector('.cad-form-hint[role="status"]')?.textContent ?? null;
    const prompt = /^This removes one relation on geometry the shape no longer has: Coincident relation 2 · .*. Apply removes it, or Cancel keeps it.$/;
    await open('Width'); await input('Width value', '4');
    expect(asked()).toMatch(prompt); expect(container.querySelector('[role="alert"]')).toBeNull();
    await click('Apply');
    expect(asked()).toMatch(prompt); expect(container.querySelector('[role="alert"]')).toBeNull(); expect(container.textContent).not.toContain('removedRelationIds');
    expect(h.session.getSnapshot().document).toBe(source);
    await click('Apply');
    expect(h.edit).toHaveBeenLastCalledWith([{ kind: 'set-parameter', name: 'n', value: 4, removedRelationIds: ['c4'] }], expect.any(AbortSignal));
    const after = h.session.getSnapshot().document.features[0];
    expect(after.kind === 'sketch' && after.graph?.relations.filter(relation => !relation.id.startsWith('g-poly_')).map(relation => relation.id)).toEqual(['poly']);
    await act(async () => h.session.undo()); expect(h.session.getSnapshot().document).toBe(source);
    await open('Width'); await input('Width value', '4'); expect(asked()).toMatch(prompt);
    await click('Cancel');
    expect(asked()).toBeNull(); expect(h.session.getSnapshot().document).toBe(source); expect(h.edit).toHaveBeenCalledTimes(2);
  });
  it.each(['width', 'diameter', 'angle'] as const)('displays a supported tiny %s without zeroing its signed value or changing an unchanged edit', async quantity => {
    const magnitude = 4e-7, parameters: Readonly<Record<string, number>> = quantity === 'width' ? { size: magnitude } : {};
    const geometry: CadProfile = quantity === 'width' ? { kind: 'rectangle', x: 0, y: 0, width: ' size ', height: 20, cornerRadius: 0 }
      : quantity === 'diameter' ? { kind: 'circle', x: 0, y: 0, radius: magnitude / 2 }
        : { kind: 'slot', x: 0, y: 0, width: 8, length: 20, angle: -magnitude };
    const { session, edit } = await renderControls(makeDocument(geometry, parameters, [{ id: 'tiny', kind: 'dimension', quantity }]));
    const before = session.getSnapshot(), label = quantity[0].toUpperCase() + quantity.slice(1), value = quantity === 'angle' ? -magnitude : magnitude;
    expect(chip(label).querySelector('strong')?.textContent).toBe(String(value));
    await open(label); expect(container.querySelector<HTMLInputElement>(`input[aria-label="${label} value"]`)?.value).toBe(String(value));
    await click('Apply'); expect(session.getSnapshot()).toBe(before); expect(edit).not.toHaveBeenCalled();
    await key(label, 'Enter'); await click('Cancel'); expect(session.getSnapshot()).toBe(before);
  });

  it('keeps numeric mouse geometry free until a driving dimension is explicitly added', async () => {
    const { session } = await renderControls(makeDocument({ kind: 'rectangle', x: 10, y: 20, width: 30, height: 15, cornerRadius: 0 }));
    const before = session.getSnapshot();
    expect(findChip('Width')).toBeNull();
    expect(findChip('Height')).toBeNull();
    await act(async () => session.edit([{ kind: 'add-sketch-dimension', sketchId: 'sketch', profileId: 'profile', constraint: { id: 'width', kind: 'dimension', quantity: 'width' } }]));
    expect(findChip('Width')).not.toBeNull();
    expect(findChip('Height')).toBeNull();
    expect(currentGeometry(session)).toEqual(before.document.features[0].kind === 'sketch' && before.document.features[0].profiles[0].geometry);
  });
  it.each(['literal', 'numeric text', 'parameter'] as const)('preserves full-precision %s radius and history when an unchanged diameter is applied', async source => {
    const radius = 1 / 3;
    const storedRadius = source === 'parameter' ? 'shaftRadius' : source === 'numeric text' ? String(radius) : radius;
    const { session, edit } = await renderControls(makeDocument({ kind: 'circle', x: 0, y: 0, radius: storedRadius }, source === 'parameter' ? { shaftRadius: radius } : {}, [{ id: 'diameter', kind: 'dimension', quantity: 'diameter' }]));
    const before = session.getSnapshot();
    await open('Diameter');
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Diameter value"]')?.value).toBe(String(radius * 2));
    await click('Apply');
    expect(session.getSnapshot()).toBe(before);
    expect(currentGeometry(session)).toEqual({ kind: 'circle', x: 0, y: 0, radius: storedRadius });
    expect(edit).not.toHaveBeenCalled();
  });
  it('edits a linked circle diameter through its radius parameter without detaching it', async () => {
    const { session, edit, pending } = await renderControls(makeDocument({ kind: 'circle', x: 0, y: 0, radius: 'shaftRadius' }, { shaftRadius: 3 }));
    expect(chip('Diameter').textContent).toContain('6');
    await open('Diameter'); expect(pending).toHaveBeenLastCalledWith(true);
    await input('Diameter value', '10'); await click('Apply');
    expect(session.getSnapshot().document.parameters.shaftRadius).toBe(5); const geometry = currentGeometry(session); expect(geometry.kind === 'circle' && geometry.radius).toBe('shaftRadius');
    expect(edit).toHaveBeenCalledWith([{ kind: 'set-parameter', name: 'shaftRadius', value: 5 }], expect.any(AbortSignal)); expect(container.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => session.undo()); expect(session.getSnapshot().document.parameters.shaftRadius).toBe(3);
  });
  it('updates a literal rectangle dimension without changing its other coordinates or dimensions', async () => {
    const { session } = await renderControls(makeDocument({ kind: 'rectangle', x: 10, y: 20, width: 30, height: 15, cornerRadius: 2 }, {}, [{ id: 'height', kind: 'dimension', quantity: 'height' }]));
    await open('Height'); await input('Height value', '22'); await click('Apply');
    expect(currentGeometry(session)).toEqual({ kind: 'rectangle', x: 10, y: 20, width: 30, height: 22, cornerRadius: 2 });
  });
  it('keeps compound bindings read-only and links to their configuration', async () => {
    const { session, configure, edit } = await renderControls(makeDocument({ kind: 'slot', x: 0, y: 0, length: 'width * 3', width: 'width', angle: 30 }, { width: 4 }));
    const before = session.getSnapshot().document; await open('Length');
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('width * 3'); expect(container.querySelector('input')).toBeNull();
    await click('Profile configuration'); expect(configure).toHaveBeenCalledWith('length'); expect(edit).not.toHaveBeenCalled(); expect(session.getSnapshot().document).toBe(before);
  });
  it('blocks invalid slot proportions while keeping the draft available for correction', async () => {
    const { session, edit } = await renderControls(makeDocument({ kind: 'slot', x: 0, y: 0, length: 20, width: 8, angle: 15 }, {}, [{ id: 'length', kind: 'dimension', quantity: 'length' }]));
    const before = session.getSnapshot().document; await open('Length'); await input('Length value', '6');
    expect(container.querySelector('[role="alert"]')).not.toBeNull(); await click('Apply'); expect(edit).not.toHaveBeenCalled(); expect(session.getSnapshot().document).toBe(before);
    await input('Length value', '30'); await click('Apply'); expect(currentGeometry(session)).toEqual({ kind: 'slot', x: 0, y: 0, length: 30, width: 8, angle: 15 });
  });
  it('updates gear tooth aliases with the same correlated geometry guards as the profile editor', async () => {
    const gear = createCadPluginProfile(CAD_GEAR_V2_PLUGIN); gear.inputs.teeth = 'toothCount'; gear.inputs.module = 'gearModule';
    const { session, edit } = await renderControls(makeDocument(gear, { toothCount: 18, gearModule: 3 }));
    await open('Teeth'); await input('Teeth value', '12.5'); expect(container.querySelector('[role="alert"]')?.textContent).toContain('integer'); await click('Apply'); expect(edit).not.toHaveBeenCalled();
    await input('Teeth value', '12'); await click('Apply'); expect(session.getSnapshot().document.parameters.toothCount).toBe(12);
    const geometry = currentGeometry(session); expect(geometry.kind === 'plugin' && geometry.inputs.teeth).toBe('toothCount');
    await open('Module'); await input('Module value', '4'); await click('Apply'); expect(session.getSnapshot().document.parameters.gearModule).toBe(4);
  });
  it('rejects stale drafts and cancels on Escape without overwriting newer values', async () => {
    const { session, edit, pending } = await renderControls(makeDocument({ kind: 'circle', x: 0, y: 0, radius: 'radius' }, { radius: 3 }));
    const diameter = chip('Diameter');
    await key('Diameter', 'Enter'); await input('Diameter value', '12');
    await act(async () => session.edit([{ kind: 'set-parameter', name: 'radius', value: 4 }]));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('part changed'); await click('Apply'); expect(edit).not.toHaveBeenCalled();
    const form = container.querySelector('form'); if (!form) throw new Error('Missing dimension editor');
    await act(async () => form.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(container.querySelector('form')).toBeNull(); expect(document.activeElement).toBe(diameter); expect(pending).toHaveBeenLastCalledWith(false); expect(session.getSnapshot().document.parameters.radius).toBe(4);
  });
});

describe('on-part sketch dimension selection', () => {
  const slotGeometry: CadProfile = { kind: 'slot', x: 0, y: 0, length: 20, width: 8, angle: 'tilt' };
  const width = { id: 'width', kind: 'dimension', quantity: 'width' } as const, length = { id: 'length', kind: 'dimension', quantity: 'length' } as const;
  const slot = (constraints: CadSketchProfile['constraints'] = [width, length]) => makeDocument(slotGeometry, { tilt: 15 }, constraints);
  const menuOpen = () => document.querySelector('[role="menu"]') !== null;
  const pick = async (label: string, shiftKey = false) => act(async () => chip(label).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, shiftKey })));
  const pressed = () => Array.from(container.querySelectorAll('.cad-dimension-chips > button[aria-pressed="true"]')).map(button => button.getAttribute('aria-label'));
  const menuItem = (text: string) => {
    const item = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(entry => entry.textContent?.trim() === text); if (!item) throw new Error(`Missing ${text}`);
    return item;
  };

  it('selects with a click, toggles with Shift and clears with Escape without opening the editor', async () => {
    const { session, edit, pending } = await renderControls(slot()), before = session.getSnapshot();
    expect(chip('Width').getAttribute('aria-label')).toBe('Dimension width 8 mm, press Enter to edit');
    await pick('Width'); expect(pressed()).toEqual(['Dimension width 8 mm, press Enter to edit']); expect(container.querySelector('form')).toBeNull();
    expect(pending).not.toHaveBeenCalledWith(true);
    await pick('Length', true); expect(pressed()).toHaveLength(2);
    await pick('Width', true); expect(pressed()).toEqual(['Dimension length 20 mm, press Enter to edit']);
    await key('Length', 'Escape'); expect(pressed()).toEqual([]);
    await key('Length', 'Enter'); expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Length dimension');
    expect(session.getSnapshot()).toBe(before); expect(edit).not.toHaveBeenCalled();
  });

  it('highlights the leader of a hovered or selected chip', async () => {
    await renderControls(slot(), undefined, point => ({ x: 200 + point[0] * 4, y: 150 - point[1] * 4 }));
    const active = () => Array.from(container.querySelectorAll('.cad-dimension-leaders g.is-active')).map(group => group.getAttribute('data-cad-dimension'));
    const surface = container.querySelector('.cad-sketch-dimension-controls'); if (!surface) throw new Error('Missing dimension controls');
    expect(active()).toEqual([]);
    // React derives enter and leave from pointerout and its related target.
    await act(async () => surface.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: chip('Width') })));
    expect(active()).toEqual(['width']);
    expect(container.querySelector('[data-cad-dimension="width"] line:not(.cad-dimension-extension)')?.getAttribute('marker-end')).toMatch(/-active\)$/);
    await act(async () => chip('Width').dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: surface })));
    expect(active()).toEqual([]);
    await pick('Length'); expect(active()).toEqual(['length']);
  });

  it('drops the leader highlight of a hovered chip whose constraint is replaced, which sends it no pointer leave', async () => {
    const { session } = await renderControls(slot(), undefined, point => ({ x: 200 + point[0] * 4, y: 150 - point[1] * 4 }));
    const active = () => Array.from(container.querySelectorAll('.cad-dimension-leaders g.is-active')).map(group => group.getAttribute('data-cad-dimension'));
    const surface = container.querySelector('.cad-sketch-dimension-controls'); if (!surface) throw new Error('Missing dimension controls');
    const hovered = chip('Width'); await act(async () => surface.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: hovered })));
    expect(active()).toEqual(['width']);
    // A value change keeps the chip and its hover.
    await act(async () => session.edit([{ kind: 'set-parameter', name: 'tilt', value: 20 }]));
    expect(chip('Width')).toBe(hovered); expect(active()).toEqual(['width']);
    // A replacement constraint on the same field mounts a new chip, which the pointer has not entered.
    await act(async () => session.replace(slot([{ id: 'width-2', kind: 'dimension', quantity: 'width' }, length])));
    expect(hovered.isConnected).toBe(false); expect(findChip('Width')).not.toBeNull(); expect(active()).toEqual([]);
  });

  it('deletes the selected driving dimensions in one edit and leaves expression sizes in place', async () => {
    const { session, edit } = await renderControls(slot());
    await pick('Width'); await pick('Length', true); await key('Length', 'Delete');
    expect(edit).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledWith([{ kind: 'remove-sketch-dimension', sketchId: 'sketch', profileId: 'profile', dimensionId: 'width' },
      { kind: 'remove-sketch-dimension', sketchId: 'sketch', profileId: 'profile', dimensionId: 'length' }], expect.any(AbortSignal));
    expect(findChip('Width')).toBeNull(); expect(findChip('Length')).toBeNull();
    // The angle follows its parameter; Delete leaves it and the document alone.
    const after = session.getSnapshot(); await pick('Angle'); await key('Angle', 'Backspace');
    expect(edit).toHaveBeenCalledOnce(); expect(session.getSnapshot()).toBe(after);
    await act(async () => session.undo()); expect(findChip('Width')).not.toBeNull(); expect(findChip('Length')).not.toBeNull();
  });

  it('deletes the selected chips from a focused chip outside the selection, and the focused chip only while none is selected', async () => {
    const { edit } = await renderControls(slot());
    // Focus never selects, so Delete on the focused Length removes the Width drawn selected.
    await pick('Width'); await key('Length', 'Delete');
    expect(edit).toHaveBeenCalledExactlyOnceWith([{ kind: 'remove-sketch-dimension', sketchId: 'sketch', profileId: 'profile', dimensionId: 'width' }], expect.any(AbortSignal));
    expect(findChip('Width')).toBeNull(); expect(findChip('Length')).not.toBeNull();
    // A selected size that has no dimension to remove keeps the focused chip as well.
    await pick('Angle'); await key('Length', 'Backspace'); expect(edit).toHaveBeenCalledOnce(); expect(findChip('Length')).not.toBeNull();
    await key('Length', 'Escape'); expect(pressed()).toEqual([]);
    await key('Length', 'Delete');
    expect(edit).toHaveBeenCalledTimes(2);
    expect(edit).toHaveBeenLastCalledWith([{ kind: 'remove-sketch-dimension', sketchId: 'sketch', profileId: 'profile', dimensionId: 'length' }], expect.any(AbortSignal));
  });

  it('reports a refused removal and keeps the chip selected', async () => {
    const { error } = await renderControls(slot(), () => { throw new Error('The slot needs its width.'); });
    await pick('Width'); await key('Width', 'Delete');
    expect(error).toHaveBeenCalledWith('The slot needs its width.'); expect(pressed()).toEqual(['Dimension width 8 mm, press Enter to edit']);
  });

  it('closes a chip menu when the part changes or the edit is cancelled, so it never removes a replacement constraint', async () => {
    const { session, edit } = await renderControls(slot());
    await key('Width', 'ContextMenu'); expect(menuOpen()).toBe(true);
    // An agent replaces the Width constraint on the same profile while the menu is open.
    await act(async () => session.replace(slot([{ id: 'width-2', kind: 'dimension', quantity: 'width' }, length])));
    expect(menuOpen()).toBe(false); expect(pressed()).toEqual([]);
    expect(findChip('Width')).not.toBeNull(); expect(edit).not.toHaveBeenCalled();
    // Any other change to the part, or Cancel, also closes it.
    await key('Length', 'ContextMenu'); expect(menuOpen()).toBe(true);
    await act(async () => session.edit([{ kind: 'set-parameter', name: 'tilt', value: 20 }])); expect(menuOpen()).toBe(false);
    await key('Length', 'ContextMenu'); expect(menuOpen()).toBe(true);
    await act(async () => cancelControls()); expect(menuOpen()).toBe(false);
    expect(edit).not.toHaveBeenCalled();
  });

  it('never leaves focus, or returns it from a menu or editor, on a chip whose constraint was replaced', async () => {
    const { session, edit } = await renderControls(slot());
    const pressFocused = (name: string) => act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })); });
    const replaceWidth = (id: string) => act(async () => session.replace(slot([{ id, kind: 'dimension', quantity: 'width' }, length])));
    // Keyboard only: the focused chip's constraint is replaced, so Delete has nothing to act on.
    const focused = chip('Width'); await act(async () => focused.focus());
    await replaceWidth('width-2'); expect(chip('Width')).not.toBe(focused); expect(document.activeElement).not.toBe(chip('Width'));
    await pressFocused('Delete'); await pressFocused('Backspace'); expect(edit).not.toHaveBeenCalled();
    // A menu that the replacement closes does not hand focus to the new chip.
    await key('Width', 'ContextMenu'); expect(menuOpen()).toBe(true);
    await replaceWidth('width-3'); expect(menuOpen()).toBe(false); expect(document.activeElement).not.toBe(chip('Width'));
    await pressFocused('Delete'); expect(edit).not.toHaveBeenCalled();
    // Nor does an editor closed after the replacement.
    await key('Width', 'Enter'); expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    await replaceWidth('width-4'); await click('Close dimension editor');
    expect(document.activeElement).not.toBe(chip('Width')); await pressFocused('Delete'); expect(edit).not.toHaveBeenCalled();
    // A chip whose value changes keeps its focus, and Delete removes that dimension.
    const kept = chip('Length'); await act(async () => kept.focus());
    await act(async () => session.edit([{ kind: 'set-parameter', name: 'tilt', value: 20 }]));
    expect(chip('Length')).toBe(kept); expect(document.activeElement).toBe(kept); await pressFocused('Delete');
    expect(edit).toHaveBeenCalledExactlyOnceWith([{ kind: 'remove-sketch-dimension', sketchId: 'sketch', profileId: 'profile', dimensionId: 'length' }], expect.any(AbortSignal));
  });

  it('selects the chip its editor opens on and keeps it selected through Cancel and Apply', async () => {
    const { edit } = await renderControls(slot());
    const widthSelected = (value = 8) => expect(pressed()).toEqual([`Dimension width ${value} mm, press Enter to edit`]);
    await pick('Length'); await key('Width', 'Enter'); widthSelected();
    await click('Cancel'); widthSelected(); expect(document.activeElement).toBe(chip('Width'));
    await act(async () => chip('Width').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 })));
    await input('Width value', '9'); await click('Apply'); widthSelected(9);
    await key('Width', 'Delete');
    expect(edit).toHaveBeenLastCalledWith([{ kind: 'remove-sketch-dimension', sketchId: 'sketch', profileId: 'profile', dimensionId: 'width' }], expect.any(AbortSignal));
  });

  it('selects only the chip its editor opens on, out of several selected chips', async () => {
    const { edit } = await renderControls(slot());
    await pick('Length'); await pick('Width', true); expect(pressed()).toHaveLength(2);
    await key('Width', 'Enter'); expect(pressed()).toEqual(['Dimension width 8 mm, press Enter to edit']);
    await click('Cancel'); await key('Width', 'Delete');
    expect(edit).toHaveBeenCalledExactlyOnceWith([{ kind: 'remove-sketch-dimension', sketchId: 'sketch', profileId: 'profile', dimensionId: 'width' }], expect.any(AbortSignal));
  });

  it('closes a chip editor and clears the chip selection when another document opens under the same IDs', async () => {
    const { session, edit } = await renderControls(slot());
    await pick('Length'); await key('Width', 'Enter'); expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => session.replace({ ...session.getSnapshot().document, id: 'other-document' }));
    expect(container.querySelector('[role="dialog"]')).toBeNull(); expect(pressed()).toEqual([]);
    // Delete on the new document's chip removes that chip alone.
    await key('Length', 'Delete');
    expect(edit).toHaveBeenCalledExactlyOnceWith([{ kind: 'remove-sketch-dimension', sketchId: 'sketch', profileId: 'profile', dimensionId: 'length' }], expect.any(AbortSignal));
  });

  it('never carries a selection to a constraint added after the selected one went away', async () => {
    const { session, edit } = await renderControls(slot());
    await pick('Width'); await pick('Length', true); expect(pressed()).toHaveLength(2);
    // Removed elsewhere, then added again with the same ID: the returning chip starts unselected.
    await act(async () => session.replace(slot([length]))); expect(findChip('Width')).toBeNull();
    await act(async () => session.replace(slot([width, length])));
    expect(pressed()).toEqual(['Dimension length 20 mm, press Enter to edit']);
    await key('Length', 'Delete');
    expect(edit).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledWith([{ kind: 'remove-sketch-dimension', sketchId: 'sketch', profileId: 'profile', dimensionId: 'length' }], expect.any(AbortSignal));
  });

  it('drops the selection when a constraint keeps its ID but measures another quantity', async () => {
    const circle = (quantity: 'radius' | 'diameter') => makeDocument({ kind: 'circle', x: 0, y: 0, radius: 5 }, {}, [{ id: 'size', kind: 'dimension', quantity }]);
    const { session } = await renderControls(circle('radius'));
    await pick('Radius'); expect(pressed()).toEqual(['Dimension radius 5 mm, press Enter to edit']);
    await act(async () => session.replace(circle('diameter')));
    expect(findChip('Diameter')).not.toBeNull(); expect(pressed()).toEqual([]);
  });

  it('offers edit, a disabled reference conversion and delete from the chip menu', async () => {
    const { edit } = await renderControls(slot());
    await key('Width', 'ContextMenu'); expect(pressed()).toEqual(['Dimension width 8 mm, press Enter to edit']);
    expect(menuItem('Make reference').disabled).toBe(true);
    expect(menuItem('Make reference').getAttribute('aria-description')).toBe('Profile dimensions always drive their profile. Copy the outline to an editable sketch to measure it with a reference dimension.');
    await act(async () => menuItem('Edit value…').click()); expect(container.querySelector<HTMLInputElement>('input[aria-label="Width value"]')?.value).toBe('8');
    await click('Cancel');
    await key('Angle', 'F10', true); expect(menuItem('Delete').disabled).toBe(true);
    expect(menuItem('Delete').getAttribute('aria-description')).toBe('This size follows its linked expression, so there is no dimension to remove. Edit the expression instead.');
    await act(async () => document.querySelector('[role="menu"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    await act(async () => chip('Length').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 30 })));
    await act(async () => menuItem('Delete').click());
    expect(edit).toHaveBeenCalledWith([{ kind: 'remove-sketch-dimension', sketchId: 'sketch', profileId: 'profile', dimensionId: 'length' }], expect.any(AbortSignal));
  });
});
