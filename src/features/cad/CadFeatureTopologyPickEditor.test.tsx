import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CadDocument, CadFeature } from '@/domain/cad/cadDocument';
import type { CadEdgeSelection, CadTopologyResolvePicksResult } from '@/domain/cad/cadTopology';
import { createCadDocument } from '@/domain/cad/cadSchema';
import { CadFeatureEditor } from './CadFeatureEditor';
import type { CadFeatureReferencePickCommand } from './cadFeatureReferencePicking';
import type { CadFeaturePreviewCommand } from './cadFeaturePreview';

let root: Root, host: HTMLDivElement;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const original: CadEdgeSelection = { expectedCount: 1, queries: [{ kind: 'edges', expectedCount: 1, predicates: [{ kind: 'line-endpoints', start: [0, 0, 0], end: [20, 0, 0] }] }] };
const replacement: CadEdgeSelection = { expectedCount: 1, queries: [{ kind: 'edges', expectedCount: 1, predicates: [{ kind: 'line-endpoints', start: [0, 10, 0], end: [20, 10, 0] }] }] };
const oldOpening = { kind: 'faces' as const, expectedCount: 1, predicates: [{ kind: 'plane' as const, normal: [0, 0, 1] as const, offset: 10 }] };
const newOpening = { ...oldOpening, predicates: [{ kind: 'plane' as const, normal: [0, -1, 0] as const, offset: 0 }] };
function button(label: string) { const entry = [...host.querySelectorAll('button')].find(entry => entry.getAttribute('aria-label') === label || entry.textContent?.trim() === label); if (!entry) throw new Error(`Missing ${label}`); return entry; }
async function click(label: string) { await act(async () => button(label).click()); }
async function type(label: string, text: string) {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`); if (!input) throw new Error(`Missing ${label}`);
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function mount(kind: 'fillet' | 'chamfer' | 'shell', preview?: (command: CadFeaturePreviewCommand) => void) {
  const feature: CadFeature = kind === 'shell'
    ? { id: 'treatment', name: 'Opening', kind, suppressed: false, targetId: 'pad', thickness: 'wall', opening: oldOpening }
    : { id: 'treatment', name: 'Edge treatment', kind, suppressed: false, targetId: 'pad', radius: 'wall', selection: original, tangentPropagation: true };
  const source: CadDocument = { ...createCadDocument(), parameters: { wall: 2 }, features: [
    { id: 'outline', name: 'Outline', kind: 'sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [{ id: 'plate', name: 'Plate', construction: false, geometry: { kind: 'rectangle', x: 0, y: 0, width: 20, height: 10, cornerRadius: 0 } }] },
    { id: 'pad', name: 'Pad', kind: 'extrude', suppressed: false, sketchId: 'outline', distance: 'wall * 5', symmetric: false, operation: 'new', targetId: null }, feature
  ] };
  let command: CadFeatureReferencePickCommand | null = null;
  const apply = vi.fn(), pending = vi.fn();
  const render = async (version = 'v1', part = source, focusTopologyPick = false) => { await act(async () => root.render(<CadFeatureEditor feature={feature} document={part} documentVersion={version} isNew={false}
    topologyPickingEnabled focusTopologyPick={focusTopologyPick} onReferencePick={next => { command = next; }} onFeaturePreview={preview} onPendingChange={pending} onApply={apply} onCancel={vi.fn()} />)); };
  await render();
  const begin = async () => { await click(kind === 'shell' ? 'Choose opening' : 'Choose edges'); const current = command; if (current?.kind !== 'pick-topology') throw new Error('Missing topology picker'); return current; };
  const result: CadTopologyResolvePicksResult = kind === 'shell' ? { purpose: kind, bodyId: 'pad', buildId: 'prefix', opening: newOpening } : { purpose: kind, bodyId: 'pad', buildId: 'prefix', selection: replacement };
  return { source, feature, apply, pending, render, begin, result };
}

it.each(['fillet', 'chamfer', 'shell'] as const)('replaces the consumed %s input only after an explicit choice, with the same pending parameters', async kind => {
  const h = await mount(kind), exact = structuredClone(h.source);
  await type(kind === 'shell' ? 'Wall thickness mm' : kind === 'fillet' ? 'Radius mm' : 'Distance mm', '3');
  const picker = await h.begin();
  expect(picker.request).toEqual({ featureId: 'treatment', bodyId: 'pad', parameterValues: { wall: 3 } });
  expect(host.querySelector<HTMLFieldSetElement>('.cad-feature-fields')?.disabled).toBe(true);
  expect(h.apply).not.toHaveBeenCalled(); expect(h.source).toEqual(exact);
  await act(async () => picker.onSelect(h.result));
  await click('Apply');
  expect(h.apply).toHaveBeenCalledWith(kind === 'shell' ? { ...h.feature, opening: newOpening } : { ...h.feature, selection: replacement }, { wall: 3 }, expect.any(AbortSignal));
  expect(h.source).toEqual(exact);
});

it.each(['fillet', 'shell'] as const)('moves focus to the %s choice when a repair asks for it again, and only then', async kind => {
  const h = await mount(kind), choice = () => host.querySelector<HTMLButtonElement>('[data-cad-topology-pick]')!;
  expect([choice().dataset.cadTopologyPick, document.activeElement === choice()]).toEqual([kind === 'shell' ? 'opening' : 'selection', false]);
  await h.render('v1', h.source, true);
  expect(document.activeElement).toBe(choice());
});

it('retains the newly chosen seeds when returning from an explicit all-edges scope', async () => {
  const h = await mount('fillet'), picker = await h.begin(); await act(async () => picker.onSelect(h.result));
  const scope = host.querySelector<HTMLSelectElement>('select[aria-label="Scope"]')!;
  for (const value of ['all', 'selected']) await act(async () => { scope.value = value; scope.dispatchEvent(new Event('change', { bubbles: true })); });
  await click('Apply'); expect(h.apply.mock.calls[0][0]).toMatchObject({ selection: replacement });
});

it('clears the candidate before picking and Cancel restores focus without replacing the stored selector', async () => {
  const preview = vi.fn(), h = await mount('fillet', preview);
  const trigger = button('Choose edges'); trigger.focus(); const picker = await h.begin();
  expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'clear' }));
  await act(async () => picker.onCancel());
  expect(document.activeElement).toBe(trigger); expect(h.pending).toHaveBeenLastCalledWith(false);
  await act(async () => picker.onSelect(h.result));
  expect(h.pending).toHaveBeenLastCalledWith(false); expect(h.apply).not.toHaveBeenCalled();
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="Scope"]')?.value).toBe('selected');
});

it('drops a retained callback when a revision that still holds the feature starts the form again', async () => {
  const h = await mount('shell'), picker = await h.begin(); await h.render('v2');
  await act(async () => picker.onSelect(h.result));
  expect(h.apply).not.toHaveBeenCalled();
  expect(host.querySelector('.cad-error')).toBeNull();
  expect(h.pending).toHaveBeenLastCalledWith(false);
});

it('rejects a retained callback after a revision that no longer holds the feature', async () => {
  const h = await mount('shell'), picker = await h.begin();
  await h.render('v2', { ...h.source, features: h.source.features.map(feature => feature === h.feature ? { ...feature } : feature) });
  await act(async () => picker.onSelect(h.result));
  expect(h.apply).not.toHaveBeenCalled();
  expect(host.querySelector('.cad-error')?.textContent).toContain('part changed');
});
