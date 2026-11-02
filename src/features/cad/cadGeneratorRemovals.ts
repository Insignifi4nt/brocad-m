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

/** The relation `relation` names in `document`, and how it is labelled: a generator by its name, another relation as its sketch lists it. */
function removedRelation(document: CadDocument, relation: CadSketchGeneratorRemovedRelation) {
  const sketch = document.features.find(feature => feature.kind === 'sketch' && (relation.sketchId === undefined || feature.id === relation.sketchId)
    && feature.graph?.relations.some(value => value.id === relation.relationId));
  const graph = sketch?.kind === 'sketch' ? sketch.graph : undefined, value = graph?.relations.find(item => item.id === relation.relationId);
  return { shape: value?.kind === 'generator', label: graph && value?.kind !== 'generator' ? describeCadSketchConstraintSource(graph, { kind: 'relation', id: relation.relationId }).label : relation.name };
}

/**
 * What confirming `removals` removes, as a trim says what leaves with its piece: the first few relations, by their labels in `document`
 * when it holds their sketch, otherwise as the refusal named them, and on whose shapes.
 */
export function cadGeneratorRemovalText(document: CadDocument, removals: CadGeneratorRemovals): string {
  const { relations } = removals;
  const labels = relations.slice(0, 3).map(relation => removedRelation(document, relation).label);
  const omitted = relations.length - labels.length, shapes = new Set(relations.map(relation => `${relation.sketchId ?? ''}\u0000${relation.generator}`)).size;
  return `This removes ${relations.length === 1 ? 'one relation' : `${relations.length} relations`} on geometry the ${shapes === 1 ? 'shape' : 'shapes'} no longer ${shapes === 1 ? 'has' : 'have'}: ${labels.join('; ')}${omitted ? `; ${omitted} more` : ''}.`;
}

/** The notice an editor shows while its next Apply confirms `removals`. */
export function cadGeneratorRemovalPrompt(document: CadDocument, removals: CadGeneratorRemovals): string {
  const them = removals.relations.length === 1 ? 'it' : 'them';
  return `${cadGeneratorRemovalText(document, removals)} Apply removes ${them}, or Cancel keeps ${them}.`;
}

/**
 * The notice a deletion's dialog shows while Delete confirms `removals`: the relations that use the geometry it deletes and the shapes made
 * from that geometry, the first few by their labels in `document`, which go with it unless Cancel keeps everything.
 */
export function cadDeletionRemovalPrompt(document: CadDocument, removals: CadGeneratorRemovals): string {
  const found = removals.relations.map(relation => removedRelation(document, relation)), shapes = found.filter(item => item.shape).length;
  const count = (value: number, noun: string) => value === 1 ? `one ${noun}` : `${value} ${noun}s`;
  const parts = [...found.length > shapes ? [count(found.length - shapes, 'relation')] : [], ...shapes ? [count(shapes, 'shape')] : []];
  const labels = found.slice(0, 3).map(item => item.label), omitted = found.length - labels.length, them = found.length === 1 ? 'it' : 'them';
  return `This also removes ${parts.join(' and ')} that ${found.length === 1 ? 'uses' : 'use'} its geometry: ${labels.join('; ')}${omitted ? `; ${omitted} more` : ''}.`
    + ` Delete removes ${them}, or Cancel keeps ${them}.`;
}

/** Why edits that remove `removals` cannot apply when none of them is an edit that can confirm the removal. */
export function cadGeneratorRemovalRefusal(document: CadDocument, removals: CadGeneratorRemovals): string {
  return `${cadGeneratorRemovalText(document, removals)} Remove ${removals.relations.length === 1 ? 'it' : 'them'} first, or keep the shape's inputs.`;
}

/**
 * `edits` confirming they remove `relationIds` as generators regenerate: the first edit that sets a parameter or a generator carries all
 * of them, as a batch removes what its edits confirm together, and no other edit carries any. A batch with neither, such as a prepared
 * deletion, confirms them by listing them among the relationIds of its first delete-sketch-elements edit without cascade, the exact set
 * it removes. Undefined when no edit can carry them.
 */
export function confirmCadGeneratorRemovals(edits: readonly CadEdit[], relationIds: readonly string[]): CadEdit[] | undefined {
  const carrier = edits.findIndex(edit => edit.kind === 'set-parameter' || edit.kind === 'set-sketch-generator');
  if (carrier < 0) {
    const deletion = edits.findIndex(edit => edit.kind === 'delete-sketch-elements' && !edit.cascade);
    return deletion < 0 ? undefined : edits.map((edit, index) => index === deletion && edit.kind === 'delete-sketch-elements'
      ? { ...edit, relationIds: [...new Set([...edit.relationIds, ...relationIds])] } : edit);
  }
  return edits.map((edit, index) => {
    if (edit.kind !== 'set-parameter' && edit.kind !== 'set-sketch-generator') return edit;
    const { removedRelationIds: _removed, ...rest } = edit;
    return index === carrier ? { ...rest, removedRelationIds: [...relationIds] } : rest;
  });
}
