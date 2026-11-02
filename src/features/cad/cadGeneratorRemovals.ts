import type { CadDocument } from '@/domain/cad/cadDocument';
import { CadError } from '@/domain/cad/cadError';
import { describeCadSketchConstraintSource } from './cadSketchConstraintFeedback';

/** The relations a refused edit would remove as a generator regenerates, which confirming them with removedRelationIds removes. */
export function cadGeneratorRemovalIds(error: unknown): readonly string[] | undefined {
  if (!(error instanceof CadError) || error.code !== 'unconfirmed-sketch-generator-removals') return undefined;
  const ids = (error as CadError & { readonly relationIds?: unknown }).relationIds;
  return Array.isArray(ids) && ids.length && ids.every(id => typeof id === 'string') ? ids : undefined;
}

/** What confirming `ids` removes from `document`, as a trim says what leaves with its piece: the first few relations by their labels. */
export function cadGeneratorRemovalText(document: CadDocument, ids: readonly string[]): string {
  const labels = ids.slice(0, 3).map(id => {
    const sketch = document.features.find(feature => feature.kind === 'sketch' && feature.graph?.relations.some(relation => relation.id === id));
    return sketch?.kind === 'sketch' && sketch.graph ? describeCadSketchConstraintSource(sketch.graph, { kind: 'relation', id }).label : id;
  });
  const omitted = ids.length - labels.length;
  return `This removes ${ids.length === 1 ? 'one relation' : `${ids.length} relations`} on geometry the shape no longer has: ${labels.join('; ')}${omitted ? `; ${omitted} more` : ''}.`;
}
