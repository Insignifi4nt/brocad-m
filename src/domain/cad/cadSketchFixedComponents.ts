import type { CadSketchGraph } from './cadSketchGraph';
import { cadSketchExternalReferenceComponents } from './cadSketchExternalReferences';
import { cadSketchGeneratedComponents } from './sketch-generators/cadSketchGenerators';

/** Points and circle radii a solve keeps as they are. */
export interface CadSketchFixedComponents { readonly pointIds: ReadonlySet<string>; readonly circleIds: ReadonlySet<string> }
const kept = new WeakMap<CadSketchGraph, CadSketchFixedComponents>();
/**
 * What the solver holds fixed beyond expressions: a linked reference's edge, which follows its source, and a generator's members, which
 * follow its inputs. Neither is solved, dragged or moved by a relation; a relation on one moves the other geometry it names.
 */
export function cadSketchFixedComponents(graph: CadSketchGraph): CadSketchFixedComponents {
  const generated = cadSketchGeneratedComponents(graph);
  if (!generated.pointIds.size && !generated.circleIds.size) return cadSketchExternalReferenceComponents(graph);
  const found = kept.get(graph);
  if (found) return found;
  const references = cadSketchExternalReferenceComponents(graph);
  const union = (a: ReadonlySet<string>, b: ReadonlySet<string>): ReadonlySet<string> => a.size ? new Set([...b, ...a]) : b;
  const result = Object.freeze({ pointIds: union(references.pointIds, generated.pointIds), circleIds: union(references.circleIds, generated.circleIds) });
  kept.set(graph, result);
  return result;
}
