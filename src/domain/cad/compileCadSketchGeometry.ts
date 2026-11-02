import type { CadProfile, CadSketchFeature, CadSketchProfile } from './cadDocument';
import { CadError } from './cadError';
import { compileCadSketchGraph, type CadSketchGraphCycle, type CadSketchGraphGeometry, type CadSketchGraphSourceRef } from './cadSketchGraphGeometry';
import { cadSketchGeneratorOutlines, type CadSketchGeneratorOutline } from './sketch-generators/cadSketchGenerators';
import type { PathSegment } from '@/domain/path-intel/types';
import type { DxfEntity } from '@/domain/dxf/types';

/** Exact supports for display/reference consumers, including open entities. */
export function cadSketchGraphBoundary(segment: PathSegment): Extract<DxfEntity, { type: 'line' | 'circle' | 'arc' }> {
  if (segment.kind === 'line') return { type: 'line', layer: null, start: segment.start, end: segment.end };
  if (segment.kind === 'circle') return { type: 'circle', layer: null, center: segment.center, radius: segment.radius };
  return { type: 'arc', layer: null, center: segment.center, radius: segment.radius, start: segment.start, end: segment.end,
    startAngle: segment.startAngleRadians, endAngle: segment.startAngleRadians + segment.sweepRadians, sweepRadians: segment.sweepRadians, clockwise: segment.sweepRadians < 0 };
}

export interface CadCompiledSketchProfile extends CadSketchProfile {
  /** Derived only. Never saved back as a second authoritative coordinate owner. */
  readonly graphSourceRefs?: readonly CadSketchGraphSourceRef[];
  /** The generator whose whole closed outline the contour is: its geometry is the shape the generator's kind checked. */
  readonly generatorId?: string;
}

/** The generator whose edges are exactly the cycle's, all of them and no other. */
function outlineOf(cycle: CadSketchGraphCycle, outlines: ReadonlyMap<string, CadSketchGeneratorOutline>): CadSketchGeneratorOutline | undefined {
  const first = cycle.sourceRefs[0].entityId, at = first.indexOf('_'), outline = at > 0 ? outlines.get(first.slice(0, at)) : undefined;
  return outline && outline.entityIds.size === cycle.sourceRefs.length && cycle.sourceRefs.every(ref => outline.entityIds.has(ref.entityId)) ? outline : undefined;
}

/**
 * One material adapter for legacy groups and the graph's exact simple cycles. A cycle that is one generator's whole outline reads as that
 * generator's shape under its name, as the profile it replaces did: a circle, rectangle, slot, polygon or path. Any other cycle is a path
 * contour.
 */
export function compileCadSketchGeometry(sketch: CadSketchFeature, parameters: Readonly<Record<string, number>>): { readonly profiles: readonly CadCompiledSketchProfile[]; readonly graph: CadSketchGraphGeometry | null } {
  if (!sketch.graph) return { profiles: sketch.profiles, graph: null };
  const graph = compileCadSketchGraph(sketch.graph, parameters);
  const legacyIds = new Set(sketch.profiles.map(profile => profile.id));
  for (const item of [...sketch.graph.points, ...sketch.graph.entities, ...sketch.graph.relations]) {
    if (legacyIds.has(item.id)) throw new CadError('duplicate-sketch-id', `Sketch graph identity "${item.id}" is already owned by a legacy profile.`);
  }
  const outlines = cadSketchGeneratorOutlines(sketch.graph, parameters);
  const profiles: readonly CadCompiledSketchProfile[] = [...sketch.profiles, ...graph.cycles.map((cycle): CadCompiledSketchProfile => {
    const outline = outlines.size ? outlineOf(cycle, outlines) : undefined;
    return outline ? { id: cycle.sourceRefs[0].entityId, name: outline.generator.name ?? outline.generator.id, construction: cycle.construction,
      geometry: outline.shape as CadProfile, graphSourceRefs: cycle.sourceRefs, generatorId: outline.generator.id }
      : { id: cycle.sourceRefs[0].entityId, name: 'Contour', construction: cycle.construction, geometry: { kind: 'path', segments: cycle.path }, graphSourceRefs: cycle.sourceRefs };
  })];
  return { profiles, graph };
}
