import { act, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CadDocument, CadSketchFeature } from '@/domain/cad/cadDocument';
import { applyCadEdits, type CadEdit } from '@/domain/cad/cadOperations';
import { createCadDocument, parseCadDocument } from '@/domain/cad/cadSchema';
import { prepareCadSketchCells } from '@/domain/cad/cadSketchRegionInspection';
import { CadSession } from './cadSession';
import { useCadSketchEditing } from './useCadSketchEditing';
import type { CadSketchAreaRepairInspection } from './cadSketchEditDraft';

let root: Root, container: HTMLDivElement;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const part = () => parseCadDocument({ ...createCadDocument('Consumed plate', 'consumed'), features: [
  { id: 'sketch', kind: 'sketch', name: 'Outline', suppressed: false, plane: 'XY', offset: 0, profiles: [
    { id: 'plate', name: 'Plate', construction: false, geometry: { kind: 'rectangle', x: 0, y: 0, width: 20, height: 10, cornerRadius: 0 } }
  ] },
  { id: 'pad', kind: 'extrude', name: 'Pad', suppressed: false, sketchId: 'sketch', distance: 5, symmetric: false, operation: 'new', targetId: null }
] });
const sketchOf = (document: CadDocument) => document.features[0] as CadSketchFeature;
const prepare = async (document: CadDocument, edits: readonly CadEdit[], signal?: AbortSignal) => { signal?.throwIfAborted(); return applyCadEdits(document, edits); };
function rectangle(document: CadDocument, width: number): CadEdit {
  const sketch = sketchOf(document), profile = sketch.profiles[0];
  if (profile.geometry.kind !== 'rectangle') throw new Error('Expected fixture rectangle.');
  return { kind: 'update-feature', feature: { ...sketch, profiles: [{ ...profile, geometry: { ...profile.geometry, width } }] } };
}
async function mount(document = part(), extra: Pick<Parameters<typeof useCadSketchEditing>[0], 'prepareCommit' | 'warn'> = {}) {
  const session = new CadSession(document);
  let current: ReturnType<typeof useCadSketchEditing> | undefined, storage: object | null = {}, open = true, locked = false;
  const preparing = vi.fn(prepare), inspect = vi.fn(async (_document: CadDocument, _sketchId: string, signal?: AbortSignal) => { signal?.throwIfAborted(); return { proof: 'inspection' }; });
  const commit = vi.fn((edits: readonly CadEdit[], version: string, signal?: AbortSignal) => session.editPrepared(version, document => prepare(document, edits, signal), signal));
  function Harness() {
    useSyncExternalStore(session.subscribe, session.getSnapshot);
    current = useCadSketchEditing({ session, storage, open, locked, prepare: preparing, inspect, commit, ...extra });
    return null;
  }
  const rerender = async () => { await act(async () => root.render(<Harness />)); };
  await rerender();
  return { session, preparing, commit, inspect, editing: () => { if (!current) throw new Error('Hook missing.'); return current; }, rerender,
    changeHost: async (next: { storage?: object | null; open?: boolean; locked?: boolean }) => {
      if ('storage' in next) storage = next.storage ?? null; if ('open' in next) open = next.open ?? false; if ('locked' in next) locked = next.locked ?? false; await rerender();
    } };
}

function explicitlySelectedPart() {
  const document = part(), sketch = sketchOf(document), pad = document.features[1];
  if (pad.kind !== 'extrude') throw new Error('Missing pad');
  const regionSelection = prepareCadSketchCells(sketch, document.parameters).cells.map(cell => cell.reference);
  return parseCadDocument({ ...document, features: [sketch, { ...pad, regionSelection }] });
}
function replacePlate(document: CadDocument): CadEdit {
  const sketch = sketchOf(document);
  return { kind: 'update-feature', feature: { ...sketch, profiles: sketch.profiles.map(profile => ({ ...profile, id: 'replacement' })) } };
}
function contourCells(repair: CadSketchAreaRepairInspection) {
  const cells = repair.consumers[0].cells;
  if (cells.mode !== 'contours') throw new Error('Expected whole-contour repair in this fixture.');
  return cells;
}

it('inspects stale area choices before submission and finishes geometry plus explicit consumer repairs in one global undo', async () => {
  const h = await mount(explicitlySelectedPart()), base = h.session.getSnapshot();
  await act(async () => h.editing().begin('sketch')); expect(h.editing().inspectAreaRepairs()).toBeNull();
  await act(async () => h.editing().edit([replacePlate(base.document)]));
  const repair = h.editing().inspectAreaRepairs(); if (!repair) throw new Error('Missing repair');
  expect(repair.consumers.map(consumer => consumer.feature.id)).toEqual(['pad']);
  expect(h.session.getSnapshot().document).toBe(base.document);
  const selections = repair.consumers.map(consumer => ({ featureId: consumer.feature.id, selection: contourCells(repair).cells.map(cell => cell.reference) }));
  await act(async () => h.editing().setWorkflowOpen(true));
  expect(() => h.editing().inspectAreaRepairs()).toThrow(expect.objectContaining({ code: 'WORKFLOW_OPEN' }));
  await act(async () => h.editing().finish(undefined, { localVersion: repair.localVersion, selections }));
  const accepted = h.session.getSnapshot(); expect(h.editing().sketchId).toBeNull();
  expect(sketchOf(accepted.document).profiles[0].id).toBe('replacement');
  expect(accepted.document.features[1]).toMatchObject({ regionSelection: selections[0].selection });
  expect(h.commit).toHaveBeenCalledOnce(); h.session.undo(); expect(h.session.getSnapshot().document).toBe(base.document);
  expect(h.session.getSnapshot().canUndo).toBe(false); h.session.redo(); expect(h.session.getSnapshot().document).toBe(accepted.document);
});

it('prepares a committed draft edit with its solve warnings and tells them once accepted, and a preview without them', async () => {
  const warning = { code: 'mirror-shrank', relationId: 'mirror', curves: [{ entityId: 'copy', beforeMm: 20, afterMm: 1e-5 }],
    message: 'Symmetric shrank Line 2 from 20.000 mm to 0.00001 mm. Check the mirror and its relations.', sketchId: 'sketch', sketchName: 'Outline' } as const;
  const prepareCommit = vi.fn(async (document: CadDocument, edits: readonly CadEdit[], signal?: AbortSignal) => ({ document: await prepare(document, edits, signal), sketchWarnings: [warning] }));
  const warn = vi.fn(), h = await mount(part(), { prepareCommit, warn }), base = h.session.getSnapshot();
  await act(async () => h.editing().begin('sketch'));
  await act(async () => { await h.editing().prepare([rectangle(base.document, 25)], new AbortController().signal); });
  expect(warn).not.toHaveBeenCalled(); expect(prepareCommit).not.toHaveBeenCalled(); expect(h.preparing).toHaveBeenCalledOnce();
  await act(async () => h.editing().edit([rectangle(base.document, 30)]));
  expect(prepareCommit).toHaveBeenCalledOnce(); expect(warn).toHaveBeenCalledExactlyOnceWith([warning], expect.any(String)); expect(h.preparing).toHaveBeenCalledOnce();
  // A refused edit tells nothing.
  prepareCommit.mockRejectedValueOnce(new Error('Refused.'));
  await act(async () => { await expect(h.editing().edit([rectangle(base.document, 35)])).rejects.toThrow('Refused.'); });
  expect(warn).toHaveBeenCalledOnce();
  // An accepted edit without warnings tells none, with its own version, so the sketch's issues drop the earlier ones.
  prepareCommit.mockImplementationOnce(async (document, edits, signal) => ({ document: await prepare(document, edits, signal), sketchWarnings: [] }));
  await act(async () => h.editing().edit([rectangle(base.document, 40)]));
  expect(warn).toHaveBeenCalledTimes(2); expect(warn.mock.lastCall?.[0]).toEqual([]); expect(warn.mock.lastCall?.[1]).not.toBe(warn.mock.calls[0][1]);
});

it('refuses stale local repair revisions and invalid, empty, duplicate or unrelated choices without committing', async () => {
  const h = await mount(explicitlySelectedPart()), base = h.session.getSnapshot(); await act(async () => h.editing().begin('sketch'));
  await act(async () => h.editing().edit([replacePlate(base.document)]));
  const repair = h.editing().inspectAreaRepairs(); if (!repair) throw new Error('Missing repair');
  const valid = { featureId: 'pad', selection: contourCells(repair).cells.map(cell => cell.reference) };
  const oldPad = base.document.features[1]; if (oldPad.kind !== 'extrude' || !oldPad.regionSelection) throw new Error('Missing original selection');
  for (const selections of [[], [{ ...valid, selection: [] }], [valid, valid], [{ ...valid, selection: [...valid.selection, ...valid.selection] }], [{ ...valid, featureId: 'sketch' }],
    [{ ...valid, selection: oldPad.regionSelection }]]) {
    await act(async () => { await expect(h.editing().finish(undefined, { localVersion: repair.localVersion, selections })).rejects.toThrow(); });
    expect(h.editing().sketchId).toBe('sketch'); expect(h.session.getSnapshot().document).toBe(base.document);
  }
  await act(async () => h.editing().edit([rectangle(h.editing().snapshot.document, 30)]));
  await act(async () => { await expect(h.editing().finish(undefined, { localVersion: repair.localVersion, selections: [valid] })).rejects.toMatchObject({ code: 'STALE_STATE' }); });
  expect(h.commit).not.toHaveBeenCalled(); expect(h.session.getSnapshot().version).toBe(base.version);
});

it.each([false, true])('captures explicit repairs before deferred Finish and preserves cancellation=%s', async cancelled => {
  const h = await mount(explicitlySelectedPart()), base = h.session.getSnapshot(); await act(async () => h.editing().begin('sketch'));
  await act(async () => h.editing().edit([replacePlate(base.document)]));
  const repair = h.editing().inspectAreaRepairs(); if (!repair) throw new Error('Missing repair');
  const selection = contourCells(repair).cells.map(cell => ({ ...cell.reference })), selections = [{ featureId: 'pad', selection }];
  let complete: () => void = () => { throw new Error('Missing deferred commit'); };
  h.commit.mockImplementationOnce((edits, version, signal) => h.session.editPrepared(version,
    document => new Promise(resolve => { complete = () => resolve(applyCadEdits(document, edits)); }), signal));
  let finishing: Promise<unknown> | undefined;
  await act(async () => { finishing = h.editing().finish(undefined, { localVersion: repair.localVersion, selections }); void finishing.catch(() => undefined); });
  selection[0].boundaryProfileId = 'changed-after-submission'; selections.push({ featureId: 'unrelated', selection: [] });
  if (cancelled) await act(async () => h.editing().cancel());
  await act(async () => { complete(); if (cancelled) await expect(finishing).rejects.toThrow(); else await finishing; });
  expect(h.editing().sketchId).toBeNull();
  if (cancelled) expect(h.session.getSnapshot()).toMatchObject({ document: base.document, version: base.version, canUndo: false });
  else expect(h.session.getSnapshot().document.features[1]).toMatchObject({ regionSelection: [{ boundaryProfileId: 'replacement' }] });
});

it('owns a valid private prefix, rejects an open Finish, and commits the repaired boundary as one global undo step', async () => {
  const h = await mount(), base = h.session.getSnapshot();
  await act(async () => h.editing().begin('sketch'));
  expect(h.editing().snapshot.document.features.map(feature => feature.id)).toEqual(['sketch']);
  expect(() => h.session.assertWorkflowClosed()).toThrow('Finish or cancel');
  const sketch = sketchOf(base.document);
  await act(async () => h.editing().edit([{ kind: 'update-feature', feature: { ...sketch, profiles: [] } }]));
  expect(h.session.getSnapshot().document).toBe(base.document); expect(h.session.getSnapshot().version).toBe(base.version);
  await act(async () => { await expect(h.editing().finish()).rejects.toThrow(); });
  expect(h.editing().sketchId).toBe('sketch'); expect(sketchOf(h.editing().snapshot.document).profiles).toEqual([]);
  await act(async () => h.editing().edit([rectangle(base.document, 30)]));
  await act(async () => h.editing().finish());
  expect(h.editing().sketchId).toBeNull(); expect(h.session.getSnapshot().document.features).toHaveLength(2);
  expect(sketchOf(h.session.getSnapshot().document).profiles[0].geometry).toMatchObject({ width: 30 });
  expect(h.session.getSnapshot().workflowOpen).toBe(false);
  h.session.undo(); expect(h.session.getSnapshot().document).toBe(base.document);
});

it('keeps local Undo/Redo scoped and Cancel preserves the full source and pre-existing global redo', async () => {
  const h = await mount(); h.session.edit([{ kind: 'rename-document', name: 'Later name' }]); h.session.undo();
  const base = h.session.getSnapshot(); await act(async () => h.editing().begin('sketch'));
  await act(async () => h.editing().edit([rectangle(base.document, 30)]));
  await act(async () => h.editing().undo()); expect(sketchOf(h.editing().snapshot.document).profiles[0].geometry).toMatchObject({ width: 20 });
  await act(async () => h.editing().redo()); expect(sketchOf(h.editing().snapshot.document).profiles[0].geometry).toMatchObject({ width: 30 });
  await act(async () => h.editing().cancel());
  expect(h.session.getSnapshot()).toMatchObject({ document: base.document, version: base.version, canRedo: true, workflowOpen: false });
  h.session.redo(); expect(h.session.getSnapshot().document.name).toBe('Later name');
});

it('finishes an unchanged edit without clearing global redo or invoking the part commit', async () => {
  const h = await mount(); h.session.edit([{ kind: 'rename-document', name: 'Redo me' }]); h.session.undo(); const base = h.session.getSnapshot();
  await act(async () => h.editing().begin('sketch')); await act(async () => h.editing().finish());
  expect(h.commit).not.toHaveBeenCalled(); expect(h.session.getSnapshot()).toMatchObject({ document: base.document, version: base.version, canRedo: true, workflowOpen: false });
});

it('cancels a deferred Finish without accepting its late full-part candidate', async () => {
  const h = await mount(), base = h.session.getSnapshot(); await act(async () => h.editing().begin('sketch'));
  await act(async () => h.editing().edit([rectangle(base.document, 30)]));
  let complete: () => void = () => { throw new Error('Commit preparation missing.'); };
  h.commit.mockImplementationOnce((edits, version, signal) => h.session.editPrepared(version,
    document => new Promise(resolve => { complete = () => { resolve(applyCadEdits(document, edits)); }; }), signal));
  let finishing: Promise<unknown> | undefined;
  await act(async () => { finishing = h.editing().finish(); void finishing.catch(() => undefined); });
  expect(h.editing().working).toBe(true);
  await act(async () => h.editing().cancel());
  await act(async () => { complete(); await expect(finishing).rejects.toThrow(); });
  expect(h.editing().sketchId).toBeNull();
  expect(h.session.getSnapshot()).toMatchObject({ document: base.document, version: base.version, canUndo: false, workflowOpen: false });
});

it('waits for local workflow ownership before analysis or history and inspects the actual private source', async () => {
  const h = await mount(); await act(async () => h.editing().begin('sketch')); const local = h.editing().snapshot;
  await act(async () => h.editing().setWorkflowOpen(true));
  expect(h.editing().analysisReady).toBe(false); expect(() => h.editing().undo()).toThrow('Finish or cancel');
  await expect(h.editing().inspect('sketch', local.version)).rejects.toThrow('Finish or cancel');
  await act(async () => h.editing().setWorkflowOpen(false));
  await h.editing().inspect('sketch', local.version);
  expect(h.inspect).toHaveBeenCalledWith(local.document, 'sketch', expect.any(AbortSignal)); expect(h.editing().analysisReady).toBe(true);
});

it('pauses analysis without leaving it while the workspace is locked, as for a capture', async () => {
  const h = await mount();
  expect(h.editing()).toMatchObject({ analysisReady: true, analysisPaused: false });
  await h.changeHost({ locked: true });
  expect(h.editing()).toMatchObject({ analysisReady: true, analysisPaused: true });
  await h.changeHost({ locked: false });
  expect(h.editing()).toMatchObject({ analysisReady: true, analysisPaused: false });
});

it.each(['storage', 'open', 'source'] as const)('aborts a pending local edit when its %s owner changes and preserves the accepted full part', async change => {
  const h = await mount(), base = h.session.getSnapshot(); await act(async () => h.editing().begin('sketch'));
  let complete: (document: CadDocument) => void = () => { throw new Error('Preparation missing'); };
  h.preparing.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
  let editing: Promise<unknown> | undefined;
  await act(async () => { const started = Promise.resolve(h.editing().edit([rectangle(base.document, 30)])); editing = started; void started.catch(() => undefined); });
  if (change === 'source') await act(async () => h.session.replace(part()));
  else await h.changeHost(change === 'storage' ? { storage: {} } : { open: false });
  expect(h.editing().sketchId).toBeNull();
  await act(async () => { complete(applyCadEdits({ ...base.document, features: [base.document.features[0]] }, [rectangle(base.document, 30)])); await expect(editing).rejects.toThrow(); });
  expect(sketchOf(h.session.getSnapshot().document).profiles[0].geometry).toMatchObject({ width: 20 });
});
