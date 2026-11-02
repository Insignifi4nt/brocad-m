import { userFacingMessage } from '@/lib/userMessage';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CadDocument } from '@/domain/cad/cadDocument';
import { applyCadEdits, type CadEdit } from '@/domain/cad/cadOperations';
import { needsCadSketchPreparation } from './cadEditPreparation';
import { CadSketchPreparationError, type CadSketchConstraintFeedback } from './cadSketchConstraintFeedback';
import type { CadSketchDiagnosisMarks } from './cadSketchDefinitionMarks';
import { cadGeneratorRemovalIds } from './cadGeneratorRemovals';

export type CadPrepareEdits = (edits: readonly CadEdit[], signal: AbortSignal) => Promise<CadDocument>;
type Preview = { readonly kind: 'idle' | 'waiting' } | { readonly kind: 'ready'; readonly document: CadDocument }
  | { readonly kind: 'error'; readonly message: string; readonly feedback?: CadSketchConstraintFeedback; readonly marks?: CadSketchDiagnosisMarks | null;
    /** The relations the edit removes as a generator regenerates, which the same edits confirming them with removedRelationIds apply. */
    readonly removals?: readonly string[] };

function previewError(error: unknown, fallback: string): Extract<Preview, { kind: 'error' }> {
  const removals = cadGeneratorRemovalIds(error);
  return { kind: 'error', message: userFacingMessage(error, fallback),
    ...(error instanceof CadSketchPreparationError ? { feedback: error.feedback, marks: error.marks } : {}), ...removals ? { removals } : {} };
}

/** The operands a rejected preview reported, which the canvas colours until the preview changes or ends. */
export function cadPreviewMarks(preview: Preview): CadSketchDiagnosisMarks | null {
  return preview.kind === 'error' ? preview.marks ?? null : null;
}

/** Keep solved sketch candidates disposable and discard late results from a different input. */
export function useCadPreparedPreview(source: CadDocument, edits: readonly CadEdit[] | null, prepare: CadPrepareEdits | undefined, enabled: boolean, debounceMs = 100): Preview {
  const asynchronous = Boolean(edits?.length && prepare && needsCadSketchPreparation(source, edits));
  const immediate = useMemo<Preview>(() => {
    if (!enabled || !edits?.length) return { kind: 'idle' };
    if (asynchronous) return { kind: 'waiting' };
    try { return { kind: 'ready', document: applyCadEdits(source, edits) }; }
    catch (error) { return previewError(error, 'This sketch edit is not valid.'); }
  }, [source, edits, enabled, asynchronous]);
  const [resolved, setResolved] = useState<{ source: CadDocument; edits: readonly CadEdit[]; prepare: CadPrepareEdits; preview: Preview } | null>(null);
  useEffect(() => {
    if (!enabled || !asynchronous || !edits || !prepare) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void Promise.resolve().then(() => { controller.signal.throwIfAborted(); return prepare(edits, controller.signal); }).then(document => {
        if (!controller.signal.aborted) setResolved({ source, edits, prepare, preview: { kind: 'ready', document } });
      }, error => {
        if (!controller.signal.aborted) setResolved({ source, edits, prepare, preview: previewError(error, 'This sketch edit could not be solved.') });
      });
    }, debounceMs);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [source, edits, prepare, enabled, asynchronous, debounceMs]);
  return enabled && asynchronous && resolved?.source === source && resolved.edits === edits && resolved.prepare === prepare ? resolved.preview : immediate;
}

/**
 * Pointer gestures change their edits every frame. A debounce would restart on each move and solve only when the pointer
 * pauses, so this keeps exactly one solve in flight and starts the newest edits as soon as it returns. The last solved
 * result stays visible meanwhile; it may trail the pointer by one solve but never belongs to another source or gesture.
 */
/** `stale` marks an older solve still drawn while the latest edits solve; it must not confirm what the latest edits reach. */
export function useCadContinuousPreview(source: CadDocument, edits: readonly CadEdit[] | null, prepare: CadPrepareEdits | undefined, enabled: boolean): Preview & { readonly stale?: boolean } {
  const asynchronous = Boolean(edits?.length && prepare && needsCadSketchPreparation(source, edits));
  const immediate = useMemo<Preview>(() => {
    if (!enabled || !edits?.length) return { kind: 'idle' };
    if (asynchronous) return { kind: 'waiting' };
    try { return { kind: 'ready', document: applyCadEdits(source, edits) }; }
    catch (error) { return previewError(error, 'This sketch edit is not valid.'); }
  }, [source, edits, enabled, asynchronous]);
  const [resolved, setResolved] = useState<{ source: CadDocument; prepare: CadPrepareEdits; edits: readonly CadEdit[]; preview: Preview } | null>(null);
  const run = useRef<{ source: CadDocument; prepare: CadPrepareEdits; controller: AbortController; latest: readonly CadEdit[] | null } | null>(null);
  const active = enabled && asynchronous && Boolean(prepare);
  useEffect(() => {
    if (!active || !edits || !prepare) return;
    const current = run.current;
    if (current && current.source === source && current.prepare === prepare) { current.latest = edits; return; }
    current?.controller.abort();
    const owned = { source, prepare, controller: new AbortController(), latest: edits as readonly CadEdit[] | null };
    run.current = owned;
    const next = () => {
      const pending = owned.latest; owned.latest = null;
      if (!pending || owned.controller.signal.aborted) { if (run.current === owned && !owned.controller.signal.aborted) run.current = null; return; }
      void Promise.resolve().then(() => { owned.controller.signal.throwIfAborted(); return prepare(pending, owned.controller.signal); }).then(
        document => { if (!owned.controller.signal.aborted) setResolved({ source, prepare, edits: pending, preview: { kind: 'ready', document } }); },
        error => { if (!owned.controller.signal.aborted) setResolved({ source, prepare, edits: pending, preview: previewError(error, 'This sketch edit could not be solved.') }); })
        .finally(next);
    };
    next();
  }, [active, source, edits, prepare]);
  // A finished or cancelled gesture discards its solves, so the next gesture never starts from them.
  useEffect(() => {
    if (active) return;
    run.current?.controller.abort(); run.current = null; setResolved(null);
  }, [active]);
  useEffect(() => () => run.current?.controller.abort(), []);
  return active && resolved?.source === source && resolved.prepare === prepare ? resolved.edits === edits ? resolved.preview : { ...resolved.preview, stale: true } : immediate;
}
