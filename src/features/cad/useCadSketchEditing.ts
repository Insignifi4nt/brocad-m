import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CadDocument } from '@/domain/cad/cadDocument';
import type { CadEdit } from '@/domain/cad/cadOperations';
import { cadFeatureDependencies } from '@/domain/cad/cadSchema';
import { CadSession, CadSessionError } from './cadSession';
import { CadSketchEditDraft, type CadSketchAreaRepairs, type CadSketchDraftPreparation } from './cadSketchEditDraft';
import type { CadEditCompletion } from './useCadEditSubmission';
import type { CadSketchEditWarning } from './cadEditPreparation';

interface Owner {
  readonly draft: CadSketchEditDraft;
  readonly storage: object;
  readonly abort: AbortController;
  pending: boolean;
  finishing: boolean;
}
interface Host<Inspection> {
  readonly session: CadSession;
  readonly storage: object | null;
  readonly open: boolean;
  readonly locked: boolean;
  /** Prepares a previewed batch. */
  prepare: CadSketchDraftPreparation;
  /** Prepares a batch the draft commits, with the warnings its solves gave; `prepare` stands in, with none, where it is absent. */
  prepareCommit?(document: CadDocument, edits: readonly CadEdit[], signal?: AbortSignal): Promise<{ readonly document: CadDocument; readonly sketchWarnings: readonly CadSketchEditWarning[] }>;
  /** Told the warnings of a batch the draft accepted, and the draft version that batch made. */
  warn?(warnings: readonly CadSketchEditWarning[], version: string): void;
  inspect(document: CadDocument, sketchId: string, signal?: AbortSignal): Promise<Inspection>;
  commit(edits: readonly CadEdit[], expectedVersion: string, signal?: AbortSignal): CadEditCompletion;
}

/** Human sketch drafts own a private valid prefix; public agent batches keep full-part atomic edits. */
export function useCadSketchEditing<Inspection>(host: Host<Inspection>) {
  const { session } = host;
  const latest = useRef(host); latest.current = host;
  const current = useRef<Owner | null>(null);
  const [owner, setOwner] = useState<Owner | null>(null), [working, setWorking] = useState(false);
  const local = useSyncExternalStore(owner?.draft.subscribe ?? session.subscribe, owner?.draft.getSnapshot ?? session.getSnapshot);
  const accepted = session.getSnapshot();
  const snapshot = useMemo(() => owner ? { ...local, savedVersion: accepted.savedVersion,
    dirty: accepted.dirty || JSON.stringify(local.document) !== JSON.stringify(owner.draft.initialDocument) } : local,
  [owner, local, accepted.savedVersion, accepted.dirty]);
  const release = useCallback((owned: Owner) => {
    if (current.current !== owned) return;
    current.current = null; owned.abort.abort(); owned.draft.cancel();
    session.setWorkflowOpen(false, 'sketch-edit'); setOwner(null); setWorking(false);
  }, [session]);
  const cancel = useCallback(() => { if (current.current) release(current.current); }, [release]);
  const assertOwner = (owned: Owner, localVersion?: string) => {
    owned.abort.signal.throwIfAborted();
    const now = latest.current;
    if (current.current !== owned || !now.open || now.locked || now.storage !== owned.storage)
      throw new CadSessionError('STALE_STATE', 'The sketch workspace changed. Open a fresh sketch edit.');
    owned.draft.assertCurrent(session.getSnapshot(), localVersion);
  };
  const requireOwner = () => {
    const owned = current.current;
    if (!owned) throw new CadSessionError('SKETCH_DRAFT_CLOSED', 'Open the consumed sketch before editing its draft.');
    assertOwner(owned); session.assertWorkflowClosed('sketch-edit');
    if (owned.pending) throw new CadSessionError('BUSY', 'Wait for the current sketch operation.');
    return owned;
  };
  const requireIdle = (owned: Owner) => {
    if (owned.draft.getSnapshot().workflowOpen) throw new CadSessionError('WORKFLOW_OPEN', 'Finish or cancel the active sketch field or gesture first.');
  };
  useLayoutEffect(() => {
    const owned = current.current;
    if (!owned) return;
    if (!host.open || host.locked || host.storage !== owned.storage) { release(owned); return; }
    if (!owned.finishing) {
      try { owned.draft.assertSource(session.getSnapshot()); } catch { release(owned); }
    }
  }, [session, accepted.document, accepted.version, host.open, host.locked, host.storage, release]);
  useEffect(() => () => cancel(), [cancel]);
  const begin = (sketchId: string) => {
    if (current.current?.draft.pin.sketchId === sketchId) { assertOwner(current.current); return; }
    session.assertWorkflowClosed();
    const now = latest.current, source = session.getSnapshot();
    if (!now.open || !now.storage || now.locked) throw new CadSessionError('BUSY', 'Wait for the CAD workspace.');
    const index = source.document.features.findIndex(feature => feature.id === sketchId && feature.kind === 'sketch');
    if (index < 0) throw new CadSessionError('NOT_FOUND', 'Choose an existing sketch.');
    if (!source.document.features.slice(index + 1).some(feature => cadFeatureDependencies(feature).includes(sketchId))) return;
    const owned: Owner = { draft: new CadSketchEditDraft(source, sketchId), storage: now.storage, abort: new AbortController(), pending: false, finishing: false };
    current.current = owned; setOwner(owned); session.setWorkflowOpen(true, 'sketch-edit');
  };
  const edit = (edits: readonly CadEdit[], signal?: AbortSignal) => {
    let owned: Owner, placed: ReturnType<CadSketchEditDraft['editPlacements']>;
    try {
      owned = requireOwner(); signal?.throwIfAborted();
      // Moving dimensions is accepted at once, with no preparation to wait for or show. A refusal still settles as a prepared edit's does.
      placed = owned.draft.editPlacements(edits, undefined, () => assertOwner(owned));
    } catch (cause) { return Promise.reject(cause); }
    return placed ?? editPrepared(owned, edits, signal);
  };
  const editPrepared = async (owned: Owner, edits: readonly CadEdit[], signal?: AbortSignal) => {
    owned.pending = true; setWorking(true);
    const combined = signal ? AbortSignal.any([signal, owned.abort.signal]) : owned.abort.signal;
    let warnings: readonly CadSketchEditWarning[] = [];
    try {
      const accepted = await owned.draft.editPrepared(edits, async (document, captured, signal) => {
        const now = latest.current;
        if (!now.prepareCommit) return now.prepare(document, captured, signal);
        const prepared = await now.prepareCommit(document, captured, signal);
        warnings = prepared.sketchWarnings; return prepared.document;
      }, undefined, combined, () => assertOwner(owned));
      latest.current.warn?.(warnings, owned.draft.getSnapshot().version);
      return accepted;
    } finally { if (current.current === owned) { owned.pending = false; setWorking(false); } }
  };
  const prepare = async (edits: readonly CadEdit[], signal: AbortSignal) => {
    const owned = requireOwner(), source = owned.draft.getSnapshot(); owned.draft.validateEdits(edits);
    const captured = structuredClone(edits), combined = AbortSignal.any([signal, owned.abort.signal]); combined.throwIfAborted();
    const candidate = await latest.current.prepare(source.document, captured, combined);
    combined.throwIfAborted(); assertOwner(owned, source.version); return candidate;
  };
  const inspect = async (sketchId: string, expectedVersion?: string, signal?: AbortSignal) => {
    const owned = requireOwner(); requireIdle(owned);
    const source = owned.draft.getSnapshot(); owned.draft.assertCurrent(session.getSnapshot(), expectedVersion ?? source.version);
    if (sketchId !== owned.draft.pin.sketchId) throw new CadSessionError('NOT_FOUND', 'Inspect the sketch owned by this edit.');
    const combined = signal ? AbortSignal.any([signal, owned.abort.signal]) : owned.abort.signal;
    const inspection = await latest.current.inspect(source.document, sketchId, combined);
    combined.throwIfAborted(); assertOwner(owned, source.version); requireIdle(owned); return inspection;
  };
  const inspectAreaRepairs = () => {
    const owned = requireOwner(); requireIdle(owned);
    return owned.draft.inspectAreaRepairs(session.getSnapshot());
  };
  const finish = async (signal?: AbortSignal, repairs?: CadSketchAreaRepairs, removedRelationIds?: readonly string[]) => {
    const owned = requireOwner(), source = session.getSnapshot(), consumerEdits: CadEdit[] = [];
    if (repairs !== undefined) {
      owned.draft.assertCurrent(source, repairs.localVersion);
      const inspection = owned.draft.inspectAreaRepairs(source);
      if (!inspection || !Array.isArray(repairs.selections) || !repairs.selections.length)
        throw new CadSessionError('SKETCH_AREA_REPAIR_SELECTION', 'Choose replacement areas for the affected consumers.');
      const consumers = new Map(inspection.consumers.map(consumer => [consumer.feature.id, consumer])), repaired = new Set<string>();
      for (const entry of repairs.selections) {
        const consumer = consumers.get(entry.featureId);
        if (!consumer || repaired.has(entry.featureId)) throw new CadSessionError('SKETCH_AREA_REPAIR_SELECTION', 'Choose each affected consumer once without changing unrelated features.');
        consumer.cells.resolve(entry.selection); repaired.add(entry.featureId);
        consumerEdits.push({ kind: 'update-feature', feature: { ...consumer.feature, regionSelection: entry.selection } });
      }
    }
    const prepared = owned.draft.finishEdits(source, consumerEdits, removedRelationIds);
    if (prepared.noOp) { release(owned); return; }
    owned.pending = true; owned.finishing = true; setWorking(true);
    const combined = signal ? AbortSignal.any([signal, owned.abort.signal]) : owned.abort.signal;
    try {
      assertOwner(owned, prepared.localVersion);
      const result = await latest.current.commit(prepared.edits, prepared.baseVersion, combined);
      combined.throwIfAborted(); release(owned); return result;
    } catch (cause) {
      if (current.current === owned) {
        try { owned.draft.assertSource(session.getSnapshot()); } catch { release(owned); }
      }
      throw cause;
    } finally {
      if (current.current === owned) { owned.pending = false; owned.finishing = false; setWorking(false); }
    }
  };
  const setWorkflowOpen = useCallback((open: boolean) => {
    if (current.current) current.current.draft.setWorkflowOpen(open); else session.setWorkflowOpen(open);
  }, [session]);
  return { sketchId: owner?.draft.pin.sketchId ?? null, snapshot, working,
    // A locked workspace, as while the draft is saved or captured, only pauses analysis: what it shows stays live.
    analysisReady: !working && !local.workflowOpen, analysisPaused: host.locked,
    begin, cancel, finish, edit, prepare, inspect, inspectAreaRepairs, setWorkflowOpen,
    undo: () => { const owned = requireOwner(); requireIdle(owned); owned.draft.undo(); },
    redo: () => { const owned = requireOwner(); requireIdle(owned); owned.draft.redo(); } };
}
