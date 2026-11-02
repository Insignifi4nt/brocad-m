import { describe, expect, it } from 'vitest';
import { createCadDocument } from '@/domain/cad/cadSchema';
import { cadDeletionRemovalPrompt, cadDeletionsRemovalPrompt } from './cadGeneratorRemovals';

describe('deletion prompts', () => {
  const shape = (relationId: string, name: string) => ({ sketchId: 'sketch', relationId, name, generator: 'Hex', reason: 'It is generated from geometry this deletes.' });
  const removals = (...relations: ReturnType<typeof shape>[]) => ({ relationIds: relations.map(relation => relation.relationId), relations });
  const document = createCadDocument('Part', 'part');

  it('name only the shapes made from what is deleted, the first few of many', () => {
    expect(cadDeletionRemovalPrompt(document, removals(shape('off', 'Offset "off"')))).toBe('This also removes the shape Offset "off" made from it.');
    expect(cadDeletionsRemovalPrompt(document, removals(shape('off', 'Offset "off"'), shape('spin', 'Circular pattern "spin"'))))
      .toBe('This also removes 2 shapes made from them: Offset "off"; Circular pattern "spin".');
    const many = ['a', 'b', 'c', 'd', 'e'].map(id => shape(id, `Offset "${id}"`));
    expect(cadDeletionRemovalPrompt(document, removals(...many))).toBe('This also removes 5 shapes made from it: Offset "a"; Offset "b"; Offset "c"; 2 more.');
  });
});
