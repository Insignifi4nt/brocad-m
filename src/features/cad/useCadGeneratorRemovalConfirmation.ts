import { useCallback, useMemo, useState } from 'react';
import { Value } from '@sinclair/typebox/value';
import type { CadDocument } from '@/domain/cad/cadDocument';
import type { CadEdit } from '@/domain/cad/cadOperations';
import { cadGeneratorRemovalPrompt, cadGeneratorRemovalRefusal, confirmCadGeneratorRemovals, sameCadGeneratorRemovals,
  type CadGeneratorRemovals } from './cadGeneratorRemovals';

/** Whether two batches are the same edits; an editor that rebuilds equal edits keeps what it was asked. */
const sameEdits = (left: readonly CadEdit[], right: readonly CadEdit[] | null) => left === right || Boolean(right && Value.Equal(left, right));

/**
 * The confirmation an editor asks for before its edits remove relations as generators regenerate. What a preview or an Apply of
 * `edits` found they remove is held with them, and while the editor's edits stay those or equal ones, they carry the IDs that confirm
 * it, so the next Apply removes the relations in the same batch and undo step. Other edits drop the confirmation, and Cancel, which
 * discards the edits, keeps the relations.
 */
export function useCadGeneratorRemovalConfirmation(document: CadDocument, edits: readonly CadEdit[] | null) {
  const [held, setHeld] = useState<{ readonly edits: readonly CadEdit[]; readonly removals: CadGeneratorRemovals } | null>(null);
  const removals = held && sameEdits(held.edits, edits) ? held.removals : undefined;
  const confirmed = useMemo(() => edits && removals ? confirmCadGeneratorRemovals(edits, removals.relationIds) : undefined, [edits, removals]);
  /** Holds what a refusal of `refused`, the editor's edits unless it names others, found they remove; false when it found nothing. */
  const hold = useCallback((found: CadGeneratorRemovals | undefined, refused: readonly CadEdit[] | null = edits) => {
    if (!found || !refused) return false;
    setHeld(current => current && sameEdits(current.edits, refused) && sameCadGeneratorRemovals(current.removals, found) ? current : { edits: refused, removals: found });
    return true;
  }, [edits]);
  const text = useMemo(() => removals ? confirmed ? cadGeneratorRemovalPrompt(document, removals) : cadGeneratorRemovalRefusal(document, removals) : null,
    [document, removals, confirmed]);
  return {
    /** The edits to preview and apply, confirming the held removals when one of them can. */
    edits: confirmed ?? edits,
    removals,
    /** The confirmation shown while the next Apply removes the held relations. */
    notice: confirmed ? text : null,
    /** Why the edits cannot apply: they remove relations and none of them can confirm it. */
    issue: confirmed ? null : text,
    hold,
  };
}
export type CadGeneratorRemovalConfirmation = ReturnType<typeof useCadGeneratorRemovalConfirmation>;
