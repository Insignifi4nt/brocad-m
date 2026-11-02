import { act, useState, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createCadDocument, parseCadDocument } from '@/domain/cad/cadSchema';
import { applyCadEdits, type CadEdit } from '@/domain/cad/cadOperations';
import type { CadDocument } from '@/domain/cad/cadDocument';
import type { CadSketchOffsetSource } from '@/domain/cad/cadSketchOffset';
import { CadSession } from './cadSession';
import { CadSketchOffsetEditor } from './CadSketchOffsetEditor';
import type { CadPrepareEdits } from './useCadPreparedPreview';
import type { CadEditCompletion } from './useCadEditSubmission';

let container: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const sourceDocument = () => parseCadDocument({ ...createCadDocument('Bore', 'offset-bore'), parameters: { clearance: 2 }, features: [{
  id: 'sketch', kind: 'sketch', name: 'Bore', suppressed: false, plane: 'XY', offset: 0,
  profiles: [{ id: 'bore', name: 'Bore', construction: false, geometry: { kind: 'circle', x: '0.00', y: ' 0 ', radius: '10.0000' } }]
}] });
function button(name: string) {
  const control = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === name);
  if (!control) throw new Error(`Missing ${name}`); return control;
}
async function click(name: string) { await act(async () => button(name).click()); }
function field() { const control = container.querySelector<HTMLInputElement>('input[aria-label="Offset distance mm"]'); if (!control) throw new Error('Missing distance'); return control; }
async function input(value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(), value); field().dispatchEvent(new Event('input', { bubbles: true })); });
}
async function settle() { await act(async () => new Promise(resolve => setTimeout(resolve, 125))); }
async function mount(overrides: { edit?(edits: readonly CadEdit[], signal?: AbortSignal): CadEditCompletion; prepare?: CadPrepareEdits; document?: CadDocument; source?: CadSketchOffsetSource } = {}) {
  const source = overrides.document ?? sourceDocument(), session = new CadSession(source), preview = vi.fn<(document: CadDocument | null) => void>(), accepted = vi.fn(), cancelled = vi.fn();
  const prepare = overrides.prepare ?? vi.fn<CadPrepareEdits>(async (edits, signal) => { signal.throwIfAborted(); return applyCadEdits(source, edits); });
  const edit = vi.fn((edits: readonly CadEdit[], signal?: AbortSignal) => overrides.edit ? overrides.edit(edits, signal) : session.edit(edits));
  function Harness() {
    const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot), [open, setOpen] = useState(true), sketch = snapshot.document.features[0];
    if (sketch.kind !== 'sketch') throw new Error('Missing sketch');
    return open ? <CadSketchOffsetEditor document={snapshot.document} documentVersion={snapshot.version} sketch={sketch} source={overrides.source ?? { kind: 'profile', profileId: 'bore' }}
      interactionLocked={false} onEditMany={edit} onPrepareEdits={prepare} onPreviewDocument={preview} onPendingChange={open => session.setWorkflowOpen(open)}
      onAccepted={ids => { accepted(ids); setOpen(false); }} onCancel={() => { cancelled(); setOpen(false); }} /> : null;
  }
  await act(async () => root.render(<Harness />));
  return { source, session, preview, prepare, edit, accepted, cancelled };
}
function previewCircle(preview: { mock: { calls: [CadDocument | null][] } }) {
  const document = [...preview.mock.calls].reverse().find(call => call[0] !== null)?.[0];
  const sketch = document?.features[0];
  if (sketch?.kind !== 'sketch' || !sketch.graph) throw new Error('Missing prepared copy');
  const circle = sketch.graph.entities[0]; if (circle.kind !== 'circle') throw new Error('Missing copied circle');
  return { document, circle };
}

it('reuses preview identities across side/expression edits, treats zero as no-op, and accepts its own published legacy copy', async () => {
  const h = await mount(); await settle();
  const first = previewCircle(h.preview); expect(first.circle.radius).toBe(11);
  await input('2'); await click('Inside'); expect(field().value).toBe('-2'); await settle();
  expect(previewCircle(h.preview).circle.radius).toBe(8);
  await click('Outside'); expect(field().value).toBe('2');
  await input('0'); expect(button('Apply').disabled).toBe(true); expect(h.session.getSnapshot().document).toBe(h.source);
  await input(' clearance '); await settle(); const outside = previewCircle(h.preview);
  expect(outside.circle.id).toBe(first.circle.id); expect(outside.circle.radius).toBe(12);
  await click('Inside'); expect(field().value).toBe('-( clearance )'); await settle();
  const inside = previewCircle(h.preview); expect(inside.circle.id).toBe(first.circle.id); expect(inside.circle.radius).toBe(8);
  expect(h.session.getSnapshot().document).toBe(h.source); expect(h.edit).not.toHaveBeenCalled();
  await click('Apply');
  expect(h.accepted).toHaveBeenCalledExactlyOnceWith([first.circle.id]); expect(h.cancelled).not.toHaveBeenCalled();
  const result = h.session.getSnapshot().document;
  expect(result).toEqual(inside.document); expect(result.schemaVersion).toBe(2); expect(result.parameters).toEqual(h.source.parameters);
  expect(result.features[0]).toMatchObject({ profiles: h.source.features[0].kind === 'sketch' ? h.source.features[0].profiles : [] });
  expect(h.edit.mock.calls[0][0]).toEqual([{ kind: 'offset-sketch-loop', sketchId: 'sketch', source: { kind: 'profile', profileId: 'bore' }, distance: '-( clearance )', idPrefix: expect.any(String) }]);
  await act(async () => h.session.undo()); expect(h.session.getSnapshot().document).toBe(h.source);
});

it('aborts a deferred Apply on Escape and ignores its late completion without changing selection or history', async () => {
  let release!: () => void, signal: AbortSignal | undefined;
  const h = await mount({ edit: (_edits, ownedSignal) => { signal = ownedSignal; return new Promise<void>(resolve => { release = resolve; }); } });
  await settle(); const baseline = h.session.getSnapshot(); await click('Apply');
  expect(signal?.aborted).toBe(false);
  await act(async () => field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expect(signal?.aborted).toBe(true); expect(h.cancelled).toHaveBeenCalledOnce();
  await act(async () => release()); expect(h.accepted).not.toHaveBeenCalled(); expect(h.session.getSnapshot().document).toBe(baseline.document);
  expect(h.session.getSnapshot().canUndo).toBe(baseline.canUndo); expect(h.preview).toHaveBeenLastCalledWith(null);
});

it('cancels on a same-ID source/version replacement and discards a late prepared preview', async () => {
  let release!: (document: CadDocument) => void, signal: AbortSignal | undefined;
  const h = await mount({ prepare: (_edits, ownedSignal) => { signal = ownedSignal; return new Promise(resolve => { release = resolve; }); } });
  await settle(); expect(button('Apply').disabled).toBe(true);
  const replacement = parseCadDocument({ ...h.source, parameters: { clearance: 3 } });
  await act(async () => h.session.replace(replacement));
  expect(h.cancelled).toHaveBeenCalledOnce(); expect(signal?.aborted).toBe(true);
  await act(async () => release(h.source));
  expect(h.preview).toHaveBeenLastCalledWith(null); expect(h.edit).not.toHaveBeenCalled(); expect(h.accepted).not.toHaveBeenCalled();
  expect(h.session.getSnapshot().document).toBe(replacement);
});

it('links an offset of a loop of sketch curves to a generator whose edges follow a later parameter edit', async () => {
  const corners = [[0, 0], [10, 0], [10, 10], [0, 10]] as const, chain = [0, 1, 2, 3].map(index => ({ entityId: `l${index}`, reversed: false }));
  const square = parseCadDocument({ ...createCadDocument('Plate', 'offset-plate'), schemaVersion: 2, parameters: { clearance: 2 }, features: [{
    id: 'sketch', kind: 'sketch', name: 'Plate', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
      points: corners.map((position, index) => ({ id: `p${index}`, position: [...position] as [number, number] })),
      entities: corners.map((_, index) => ({ id: `l${index}`, kind: 'line' as const, construction: false, startPointId: `p${index}`, endPointId: `p${(index + 1) % 4}` })),
      relations: [] } }] });
  const h = await mount({ document: square, source: { kind: 'graph-cycle', sourceRefs: chain } });
  expect(button('Independent').getAttribute('aria-pressed')).toBe('true');
  await click('Linked'); await input('clearance'); await settle();
  await click('Apply');
  const [edit] = h.edit.mock.calls[0][0];
  if (edit.kind !== 'set-sketch-generator') throw new Error('Expected a generator');
  const id = edit.generator.id;
  expect(id).toMatch(/^offset-[0-9a-f]{16}$/);
  expect(edit.generator).toEqual({ id, kind: 'generator', idPrefix: id, construction: false, geometry: { kind: 'offset', chain, distance: 'clearance' } });
  expect(h.accepted).toHaveBeenCalledExactlyOnceWith(chain.map(link => `${id}_e_${link.entityId}`));
  const joint = () => {
    const sketch = h.session.getSnapshot().document.features[0];
    return sketch.kind === 'sketch' ? sketch.graph?.points.find(point => point.id === `${id}_j_l3`)?.position : undefined;
  };
  expect(joint()).toEqual([-2, -2]);
  await act(async () => h.session.edit([{ kind: 'set-parameter', name: 'clearance', value: 3 }]));
  expect(joint()).toEqual([-3, -3]);
});
