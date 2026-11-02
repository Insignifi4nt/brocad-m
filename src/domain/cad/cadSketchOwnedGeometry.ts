import { CadError } from './cadError';
import type { CadSketchGraph } from './cadSketchGraph';
import type { CadSketchGraphSelection } from './cadSketchGraphSelection';
import { cadSketchLinearPatternLockReason } from './cadSketchLinearPattern';
import { cadSketchGeneratorLockReason } from './sketch-generators/cadSketchGenerators';

/**
 * Why the selected point or edge cannot be edited on its own: a linear pattern or a generator made it and keeps it. Null for geometry
 * nothing keeps. A linked reference's edge has a reason of its own (`cadSketchExternalReferenceLockReason`).
 */
export function cadSketchOwnedGeometryLockReason(graph: CadSketchGraph, selection: CadSketchGraphSelection): string | null {
  return cadSketchLinearPatternLockReason(graph, selection) ?? cadSketchGeneratorLockReason(graph, selection);
}

/** The refusal of an edit of the selected point or edge on its own, coded by what keeps it; null for geometry nothing keeps. */
export function cadSketchOwnedGeometryError(graph: CadSketchGraph, selection: CadSketchGraphSelection): CadError | null {
  const pattern = cadSketchLinearPatternLockReason(graph, selection);
  if (pattern) return new CadError('owned-sketch-pattern', pattern);
  const generator = cadSketchGeneratorLockReason(graph, selection);
  return generator ? new CadError('owned-sketch-generator', generator) : null;
}
