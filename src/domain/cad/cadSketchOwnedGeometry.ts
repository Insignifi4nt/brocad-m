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
