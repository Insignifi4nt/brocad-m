import type { CadDocument } from '@/domain/cad/cadDocument';
import { CadError } from '@/domain/cad/cadError';
import type { CadEdit } from '@/domain/cad/cadOperations';
import type { CadSketchGeneratorRemovedRelation } from '@/domain/cad/sketch-generators/cadSketchGenerators';
import { describeCadSketchConstraintSource } from './cadSketchConstraintFeedback';

/**
 * The relations a refused edit would remove as generators regenerate: the IDs that confirm them as removedRelationIds, and each relation
 * with the sketch it is in, as one parameter may remove relations with the same ID from several sketches.
 */
export interface CadGeneratorRemovals {
  readonly relationIds: readonly string[];
  readonly relations: readonly CadSketchGeneratorRemovedRelation[];
}

/** What a refused edit would remove, which confirming its relationIds removes; undefined for any other failure. */
export function cadGeneratorRemovals(error: unknown): CadGeneratorRemovals | undefined {
  if (!(error instanceof CadError) || error.code !== 'unconfirmed-sketch-generator-removals') return undefined;
  const { relationIds, relations } = error as CadError & { readonly relationIds?: unknown; readonly relations?: unknown };
  const text = (value: unknown) => typeof value === 'string';
  return Array.isArray(relationIds) && relationIds.length && relationIds.every(text) && Array.isArray(relations) && relations.length
    && relations.every(relation => typeof relation === 'object' && relation !== null && text(relation.relationId) && text(relation.name) && text(relation.generator))
    ? { relationIds, relations } : undefined;
}

/** Whether two refusals ask to confirm the same relation IDs. */
export const sameCadGeneratorRemovals = (left: CadGeneratorRemovals | undefined, right: CadGeneratorRemovals | undefined) =>
  left === right || Boolean(left && right && left.relationIds.length === right.relationIds.length && left.relationIds.every((id, index) => id === right.relationIds[index]));

/**
 * What confirming `removals` removes, as a trim says what leaves with its piece: the first few relations, by their labels in `document`
 * when it holds their sketch, otherwise as the refusal named them, and on whose shapes.
 */
export function cadGeneratorRemovalText(document: CadDocument, removals: CadGeneratorRemovals): string {
  const { relations } = removals;
  const labels = relations.slice(0, 3).map(relation => {
    const sketch = document.features.find(feature => feature.kind === 'sketch' && (relation.sketchId === undefined || feature.id === relation.sketchId)
      && feature.graph?.relations.some(value => value.id === relation.relationId));
    return sketch?.kind === 'sketch' && sketch.graph ? describeCadSketchConstraintSource(sketch.graph, { kind: 'relation', id: relation.relationId }).label : relation.name;
  });
  const omitted = relations.length - labels.length, shapes = new Set(relations.map(relation => `${relation.sketchId ?? ''}\u0000${relation.generator}`)).size;
  return `This removes ${relations.length === 1 ? 'one relation' : `${relations.length} relations`} on geometry the ${shapes === 1 ? 'shape' : 'shapes'} no longer ${shapes === 1 ? 'has' : 'have'}: ${labels.join('; ')}${omitted ? `; ${omitted} more` : ''}.`;
}

/** The notice an editor shows while its next Apply confirms `removals`. */
export function cadGeneratorRemovalPrompt(document: CadDocument, removals: CadGeneratorRemovals): string {
  const them = removals.relations.length === 1 ? 'it' : 'them';
  return `${cadGeneratorRemovalText(document, removals)} Apply removes ${them}, or Cancel keeps ${them}.`;
}

/** Why edits that remove `removals` cannot apply when none of them is an edit that can confirm the removal. */
export function cadGeneratorRemovalRefusal(document: CadDocument, removals: CadGeneratorRemovals): string {
  return `${cadGeneratorRemovalText(document, removals)} Remove ${removals.relations.length === 1 ? 'it' : 'them'} first, or keep the shape's inputs.`;
}

/**
 * `edits` confirming they remove `relationIds` as generators regenerate: the first edit that sets a parameter or a generator carries all
 * of them, as a batch removes what its edits confirm together, and no other edit carries any. Undefined when no edit can carry them.
 */
export function confirmCadGeneratorRemovals(edits: readonly CadEdit[], relationIds: readonly string[]): CadEdit[] | undefined {
  const carrier = edits.findIndex(edit => edit.kind === 'set-parameter' || edit.kind === 'set-sketch-generator');
  if (carrier < 0) return undefined;
  return edits.map((edit, index) => {
    if (edit.kind !== 'set-parameter' && edit.kind !== 'set-sketch-generator') return edit;
    const { removedRelationIds: _removed, ...rest } = edit;
    return index === carrier ? { ...rest, removedRelationIds: [...relationIds] } : rest;
  });
}
