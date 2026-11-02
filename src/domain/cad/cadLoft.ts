import type { CadFeature, CadSketchFeature, CadSketchPlane } from './cadDocument';
import { cadFeatureActive } from './features/cadFeatureActivity';
import { CadError } from './cadError';
import { cadProfileToEntities, resolveCadSketchRegions, type ResolvedCadProfile } from './cadSketchGeometry';
import { prepareCadDatumFrames, resolveCadSketchPlacement, type CadDatumFrameLookup, type CadResolvedPlacement } from './cadDatumPlanes';
import {
  MIN_CAD_LOFT_SECTIONS,
  MAX_CAD_LOFT_SECTIONS,
  resolveCadLoftSectionPlacements,
  type CadResolvedLoftSections,
} from './cadLoftPlacement';
export {
  MIN_CAD_LOFT_SECTIONS,
  MAX_CAD_LOFT_SECTIONS,
  CAD_LOFT_NATIVE_PRECISION,
  cadLoftOffsetTolerance,
  inspectCadLoftSectionPair,
  resolveCadLoftSectionPlacements,
  type CadResolvedLoftSections,
  type CadResolvedLoftSection,
} from './cadLoftPlacement';

export type CadLoftFeature = Extract<CadFeature, { kind: 'loft' }>;
export interface CadLoftSection {
  readonly sketchId: string;
  readonly sketch: CadSketchFeature;
  readonly plane: CadSketchPlane;
  readonly offset: number;
  readonly geometry: ResolvedCadProfile;
  readonly placement: CadResolvedPlacement;
  readonly localCoordinateScaleMm: number;
}
export type CadLoftSketchInspection =
  | { readonly eligible: true; readonly section: CadLoftSection }
  | { readonly eligible: false; readonly code: string; readonly message: string };

/** UI callers cache this inspection against immutable sketch/parameter snapshots. */
export function inspectCadLoftSketch(
  sketch: CadSketchFeature,
  parameters: Readonly<Record<string, number>>,
  lookup?: CadDatumFrameLookup,
): CadLoftSketchInspection {
  if (!cadFeatureActive(sketch, { parameters })) return { eligible: false, code: 'suppressed-sketch', message: `Loft section "${sketch.name}" is suppressed.` };
  try {
    const placement = resolveCadSketchPlacement(sketch, parameters, lookup);
    const regions = resolveCadSketchRegions(sketch, parameters);
    if (regions.length === 0)
      return { eligible: false, code: 'empty-sketch', message: `Loft section "${sketch.name}" needs a closed non-construction contour.` };
    if (regions.length !== 1 || regions[0].voids.length !== 0)
      return {
        eligible: false,
        code: 'unsupported-loft-section',
        message: `Loft section "${sketch.name}" must contain exactly one material boundary without holes or islands.`,
      };
    const geometry = regions[0].boundary.geometry;
    let localCoordinateScaleMm = 0;
    for (const entity of cadProfileToEntities(geometry)) {
      if (entity.type === 'line')
        localCoordinateScaleMm = Math.max(
          localCoordinateScaleMm,
          Math.abs(entity.start.x),
          Math.abs(entity.start.y),
          Math.abs(entity.end.x),
          Math.abs(entity.end.y),
        );
      else if (entity.type === 'arc' || entity.type === 'circle')
        localCoordinateScaleMm = Math.max(
          localCoordinateScaleMm,
          Math.abs(entity.center.x) + entity.radius,
          Math.abs(entity.center.y) + entity.radius,
        );
    }
    return Object.freeze({
      eligible: true,
      section: Object.freeze({
        sketchId: sketch.id,
        sketch,
        plane: placement.plane,
        offset: placement.offsetMm,
        geometry,
        placement,
        localCoordinateScaleMm,
      }),
    });
  } catch (error) {
    if (error instanceof CadError) return { eligible: false, code: error.code, message: error.message };
    throw error;
  }
}

/** Preserve authored section order; never sort planes or discard material contours. */
export function resolveCadLoftSections(
  feature: CadLoftFeature,
  precedingFeatures: ReadonlyMap<string, CadFeature>,
  parameters: Readonly<Record<string, number>>,
  lookup?: CadDatumFrameLookup,
): CadResolvedLoftSections {
  if (feature.sketchIds.length < MIN_CAD_LOFT_SECTIONS || feature.sketchIds.length > MAX_CAD_LOFT_SECTIONS) {
    throw new CadError('loft-section-limit', 'Lofts require 2–16 ordered sketch sections.');
  }
  if (new Set(feature.sketchIds).size !== feature.sketchIds.length)
    throw new CadError('duplicate-loft-section', 'Loft sketch sections must have unique IDs.');
  const frames = lookup ?? prepareCadDatumFrames([...precedingFeatures.values()], parameters);
  const sections = feature.sketchIds.map((id) => {
    const sketch = precedingFeatures.get(id);
    if (sketch?.kind !== 'sketch') throw new CadError('invalid-reference', `Loft "${feature.name}" needs a preceding sketch "${id}".`);
    const inspection = inspectCadLoftSketch(sketch, parameters, frames);
    if (!inspection.eligible) throw CadError.checked(inspection.code, inspection.message);
    return inspection.section;
  });
  return resolveCadLoftSectionPlacements(sections);
}
