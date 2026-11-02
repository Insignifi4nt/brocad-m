import { CAD_SKETCH_MIRROR_ENTITIES_MAX } from '@/domain/cad/cadSketchMirror';
import type { CadSketchGenerator, CadSketchGraph } from '@/domain/cad/cadSketchGraph';
import { cadSketchGeneratorLockReason, cadSketchGeneratorMembers, cadSketchGeneratorName } from '@/domain/cad/sketch-generators/cadSketchGenerators';
import { cadSketchGeneratorConstruction, cadSketchGeneratorMoveReason } from '@/domain/cad/sketch-generators/cadSketchProfileViews';

/**
 * What the profile toolbar's commands do with a generator selected as a whole, by its profile button, its interior or a tree row. Each
 * command either acts on that generator or names why it cannot; none falls back to the drawing defaults or silently does nothing.
 * Dimension, Constrain and Use reference start their tools whatever is selected, so they are not listed.
 */
export interface CadSketchWholeGeneratorCommands {
  /** Move profile: null where it opens the Move contour editor, which writes the shape's inputs. */
  readonly move: string | null;
  /** Offset loop: null where the shape's edges are exactly one nonconstruction loop, which is then the offset's source. */
  readonly offset: string | null;
  /** Mirror copy: the shape's edges, copied independently, or why they cannot be. */
  readonly mirror: { readonly entityIds: readonly string[]; readonly reason?: never } | { readonly reason: string; readonly entityIds?: never };
  /** Pattern: a linear pattern repeats one selected free circle, never a generated shape. */
  readonly pattern: string;
  /** The corner tools: null where Fillet writes the shape's corner radius, as a rectangle's. */
  readonly corners: string | null;
  /** Construction: whether the shape's edges are construction, and why its flag cannot change that, if it cannot. */
  readonly construction: { readonly checked: boolean; readonly reason: string | null };
}

/** The profile toolbar on `generator` selected as a whole; `offsetSource` is whether the selection names one loop to offset. */
export function cadSketchWholeGeneratorCommands(graph: CadSketchGraph, generator: CadSketchGenerator, offsetSource: boolean): CadSketchWholeGeneratorCommands {
  const name = cadSketchGeneratorName(generator), { entityIds } = cadSketchGeneratorMembers(graph, generator), kind = generator.geometry.kind;
  // The reason an edit of the shape's own edges or corners is refused, naming the generator that keeps them.
  const owned = entityIds.length ? cadSketchGeneratorLockReason(graph, { id: entityIds[0] }) : null;
  const construction = cadSketchGeneratorConstruction(graph, generator);
  return {
    move: cadSketchGeneratorMoveReason(generator),
    offset: offsetSource ? null : construction.construction ? `${name} is construction geometry, so it has no loop to offset.`
      : `${name} does not make one closed loop of its own edges. Select an edge of the loop to offset.`,
    mirror: !entityIds.length ? { reason: `${name} has no edges to mirror.` }
      : entityIds.length > CAD_SKETCH_MIRROR_ENTITIES_MAX ? { reason: `Mirror copy takes at most ${CAD_SKETCH_MIRROR_ENTITIES_MAX} edges, and ${name} has ${entityIds.length}.` }
      : { entityIds },
    pattern: kind === 'circle' && owned ? owned : 'Linear pattern repeats one selected free circle.',
    corners: kind === 'rectangle' ? null : kind === 'circle' || kind === 'slot' || !owned ? `${name} has no corners to round.` : owned,
    construction: { checked: construction.construction, reason: construction.reason },
  };
}
