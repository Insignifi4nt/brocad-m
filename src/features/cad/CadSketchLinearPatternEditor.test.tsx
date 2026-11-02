import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { applyCadEdits, reduceCadEditIntents, type CadEdit } from '@/domain/cad/cadOperations';
import { createCadDocument, parseCadDocument } from '@/domain/cad/cadSchema';
import type { CadDocument } from '@/domain/cad/cadDocument';
import type { CadSketchGenerator } from '@/domain/cad/cadSketchGraph';
import { expandCadSketchGenerators } from '@/domain/cad/sketch-generators/cadSketchGenerators';
import { CadSketchLinearPatternEditor, type CadSketchLinearPatternInteraction } from './CadSketchLinearPatternEditor';

let root: Root, container: HTMLDivElement;
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function deferred<T>() { let resolve: (value: T) => void = () => { throw new Error('Not ready'); }; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function button(label: string) { const element = [...container.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === label || b.textContent?.trim() === label); if (!element) throw new Error('Missing '+label); return element; }
async function input(label: string, text: string) {
  const element = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`); if (!element) throw new Error('Missing field '+label);
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, text); element.dispatchEvent(new Event('input', { bubbles: true })); });
}
async function fixture(prepare?: ComponentProps<typeof CadSketchLinearPatternEditor>['onPrepareEdits']) {
  const seed = parseCadDocument({ ...createCadDocument(), schemaVersion: 2, parameters: { pitch: 15 }, features: [{ id: 'sketch', kind: 'sketch', name: 'Hole row', plane: 'XY', offset: 0, suppressed: false, profiles: [],
    graph: { points: [{ id: 'center', position: ['10', '10'] }], entities: [{ id: 'seed', kind: 'circle', centerPointId: 'center', radius: '3', construction: false }], relations: [] } }] });
  const document = applyCadEdits(seed, [{ kind: 'set-sketch-relation', sketchId: 'sketch', relation: { id: 'holes', kind: 'linear-pattern', seed: { kind: 'circle', entityId: 'seed', centerPointId: 'center' },
    idPrefix: 'row', count: 4, direction: '+x', spacing: ' pitch ', omittedInstances: [] } }]);
  const sketch = document.features[0]; if (sketch.kind !== 'sketch') throw new Error('Sketch missing');
  const edit = vi.fn(async (_edits: readonly CadEdit[], _signal?: AbortSignal) => undefined), accepted = vi.fn(), cancelled = vi.fn(), preview = vi.fn();
  const interaction = vi.fn<(value: CadSketchLinearPatternInteraction | null) => void>();
  let props: ComponentProps<typeof CadSketchLinearPatternEditor> = { document, documentVersion: 'one', sketch, request: { kind: 'edit', relationId: 'holes' }, interactionLocked: false,
    onEditMany: edit, onPrepareEdits: prepare ?? (async edits => reduceCadEditIntents(document, edits)), onPreviewDocument: preview, onPendingChange: vi.fn(), onInteractionChange: interaction, onCancel: cancelled, onAccepted: accepted };
  const render = async (next: Partial<typeof props> = {}) => { props = { ...props, ...next }; await act(async () => root.render(<CadSketchLinearPatternEditor key={document.id} {...props} />)); };
  const settle = async () => act(async () => vi.advanceTimersByTimeAsync(100));
  await render(); return { document, props: () => props, edit, accepted, cancelled, preview, interaction, render, settle };
}
it('edits linked pitch, direction and omissions through one persistent owner without replacing its scalar link', async () => {
  const h = await fixture(); await input('Pitch mm', '16'); await act(async () => button('Reverse pattern direction').click());
  const current = h.interaction.mock.calls.at(-1)?.[0]; if (!current) throw new Error('Pattern interaction missing');
  await act(async () => current.onToggleInstance(2)); await h.settle();
  await act(async () => button('Apply').click()); expect(h.edit).toHaveBeenCalledOnce();
  expect(h.edit.mock.calls[0][0]).toEqual([{ kind: 'set-parameter', name: 'pitch', value: 16 }, { kind: 'set-sketch-relation', sketchId: 'sketch', relation: {
    id: 'holes', kind: 'linear-pattern', seed: { kind: 'circle', entityId: 'seed', centerPointId: 'center' }, idPrefix: 'row', count: 4, direction: '-x', spacing: ' pitch ', omittedInstances: [2] } }]);
  expect(h.accepted).toHaveBeenCalledExactlyOnceWith({ seedEntityId: 'seed', relationId: 'holes' }); expect(h.document.parameters.pitch).toBe(15);
});
it('closes an unchanged owner without an edit, and cancels invalid count without changing geometry', async () => {
  const h = await fixture(); await act(async () => button('Apply').click()); expect(h.edit).not.toHaveBeenCalled(); expect(h.accepted).toHaveBeenCalledOnce();
  const next = await fixture(); await input('Count', '1.5'); expect(button('Apply').disabled).toBe(true);
  await act(async () => button('Cancel').click()); expect(next.edit).not.toHaveBeenCalled(); expect(next.cancelled).toHaveBeenCalledOnce();
});
it('rejects an outdated preview and its canvas callbacks when source ownership changes', async () => {
  const gate = deferred<CadDocument>(), prepare = vi.fn(async (_edits: readonly CadEdit[], _signal: AbortSignal) => gate.promise);
  const h = await fixture(prepare); await input('Pitch mm', '16'); await h.settle(); expect(prepare).toHaveBeenCalledOnce();
  const interaction = h.interaction.mock.calls.at(-1)?.[0]; if (!interaction) throw new Error('Interaction missing');
  await h.render({ documentVersion: 'two' }); await act(async () => { interaction.onToggleInstance(1); gate.resolve(h.document); });
  expect(prepare.mock.calls[0][1].aborted).toBe(true); expect(h.cancelled).toHaveBeenCalledOnce(); expect(h.edit).not.toHaveBeenCalled();
  expect(h.preview.mock.calls.at(-1)?.[0] ?? null).toBeNull();
});
it('asks before a linked pitch removes relations as a generator regenerates, applies the confirmed removal with the pattern, and Cancel applies nothing', async () => {
  // The pitch and a five-sided polygon both read n, and a user point sits on the polygon's fifth corner: four removes "c4".
  const polygon: CadSketchGenerator = { id: 'poly', kind: 'generator', idPrefix: 'g-poly', construction: false,
    geometry: { kind: 'regular-polygon', x: 0, y: 0, radius: 10, sides: 'n', directionId: '@h' } };
  const corner = expandCadSketchGenerators({ points: [], entities: [], relations: [polygon] }, { n: 5 }).points.find(point => point.id === 'g-poly_v4')!.position;
  const seed = parseCadDocument({ ...createCadDocument(), schemaVersion: 2, parameters: { n: 5 }, features: [{ id: 'sketch', kind: 'sketch', name: 'Hole row', plane: 'XY', offset: 0, suppressed: false, profiles: [],
    graph: { points: [{ id: 'center', position: ['20', '20'] }, { id: 'u', position: corner }], entities: [{ id: 'seed', kind: 'circle', centerPointId: 'center', radius: '1', construction: false }],
      relations: [polygon, { id: 'c4', kind: 'coincident', pointIds: ['u', 'g-poly_v4'] }] } }] });
  const document = applyCadEdits(seed, [{ kind: 'set-sketch-relation', sketchId: 'sketch', relation: { id: 'holes', kind: 'linear-pattern', seed: { kind: 'circle', entityId: 'seed', centerPointId: 'center' },
    idPrefix: 'row', count: 3, direction: '+x', spacing: ' n ', omittedInstances: [] } }]);
  const sketch = document.features[0]; if (sketch.kind !== 'sketch') throw new Error('Sketch missing');
  // The part refuses an edit that does not confirm what it removes, as the workbench does.
  const edit = vi.fn(async (edits: readonly CadEdit[], _signal?: AbortSignal) => { reduceCadEditIntents(document, edits); }), accepted = vi.fn(), cancelled = vi.fn();
  const props: ComponentProps<typeof CadSketchLinearPatternEditor> = { document, documentVersion: 'one', sketch, request: { kind: 'edit', relationId: 'holes' }, interactionLocked: false,
    onEditMany: edit, onPrepareEdits: async edits => reduceCadEditIntents(document, edits), onPreviewDocument: vi.fn(), onPendingChange: vi.fn(), onInteractionChange: vi.fn(), onCancel: cancelled, onAccepted: accepted };
  const settle = async () => act(async () => vi.advanceTimersByTimeAsync(100));
  const asked = () => container.querySelector('.cad-form-hint[role="status"]')?.textContent ?? null;
  const prompt = /^This removes one relation on geometry the shape no longer has: Coincident relation 2 · .*\. Apply removes it, or Cancel keeps it\.$/;
  await act(async () => root.render(<CadSketchLinearPatternEditor key="first" {...props} />));
  await input('Pitch mm', '4'); await settle();
  expect(asked()).toMatch(prompt); expect(container.querySelector('[role="alert"]')).toBeNull(); expect(container.textContent).not.toContain('removedRelationIds');
  await settle(); expect(button('Apply').disabled).toBe(false);
  await act(async () => button('Apply').click());
  expect(edit).toHaveBeenCalledExactlyOnceWith([{ kind: 'set-parameter', name: 'n', value: 4, removedRelationIds: ['c4'] }], expect.any(AbortSignal));
  expect(accepted).toHaveBeenCalledOnce();
  // Asked again in a new session, Cancel ends it with no edit.
  await act(async () => root.render(<CadSketchLinearPatternEditor key="second" {...props} />));
  await input('Pitch mm', '4'); await settle(); expect(asked()).toMatch(prompt);
  await act(async () => button('Cancel').click());
  expect(cancelled).toHaveBeenCalledOnce(); expect(edit).toHaveBeenCalledOnce();
  // A removal only the part finds on Apply asks the same way, and the next Apply confirms it.
  await act(async () => root.render(<CadSketchLinearPatternEditor key="third" {...props} onPrepareEdits={async () => document} />));
  await input('Pitch mm', '4'); await settle(); expect(asked()).toBeNull();
  await act(async () => button('Apply').click());
  expect(edit).toHaveBeenCalledTimes(2); expect(asked()).toMatch(prompt); expect(container.querySelector('[role="alert"]')).toBeNull();
  await settle(); await act(async () => button('Apply').click());
  expect(edit).toHaveBeenLastCalledWith([{ kind: 'set-parameter', name: 'n', value: 4, removedRelationIds: ['c4'] }], expect.any(AbortSignal));
  expect(accepted).toHaveBeenCalledTimes(2);
});
