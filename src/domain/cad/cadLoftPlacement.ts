import type { CadPlane } from './cadDocument';
import type { CadLoftSection } from './cadLoft';
import { CadError } from './cadError';
import {
  CAD_DATUM_NATIVE_PLACEMENT_PRECISION_MM,
  CAD_DATUM_ORTHONORMAL_RESIDUAL,
  cadFramePointToWorld,
  cadPrincipalFrame,
  type CadResolvedFrame,
} from './cadDatumPlanes';
import type { CadNumericPoint2, CadNumericPoint3 } from './cadPlanes';
import { CAD_PRECISION, cadRoundoff } from '../precision/cadPrecision';
import { MAX_CAD_LOFT_SECTIONS, MIN_CAD_LOFT_SECTIONS } from './cadLoftLimits';
export { MAX_CAD_LOFT_SECTIONS, MIN_CAD_LOFT_SECTIONS } from './cadLoftLimits';
export const CAD_LOFT_NATIVE_PRECISION = CAD_PRECISION.kernelConfusionMm;
/** Preserve the existing principal-offset comparison and range policy. */
export function cadLoftOffsetTolerance(offsets: readonly number[]): number {
  let scale = 1;
  for (const offset of offsets) {
    if (!Number.isFinite(offset) || Math.abs(offset) > 1e9)
      throw new CadError('invalid-scalar', 'Loft offsets must be finite and within one billion millimetres.');
    scale = Math.max(scale, Math.abs(offset));
  }
  return Math.max(CAD_LOFT_NATIVE_PRECISION, cadRoundoff(8, scale));
}

export interface CadResolvedLoftSection extends CadLoftSection {
  /** Normal station in the returned common frame, not a world dot product. */
  readonly stationMm: number;
  readonly tangentialOffsetMm: CadNumericPoint2;
}
export interface CadResolvedLoftSections {
  readonly sections: readonly CadResolvedLoftSection[];
  /** Principal zero origin for legacy lofts; first placed section origin otherwise. */
  readonly commonFrame: CadResolvedFrame;
  readonly legacyPrincipalPlane: CadPlane | null;
  readonly offsetTolerance: number;
  readonly placementUncertaintyMm: number;
}
export type CadLoftSectionPairInspection =
  | {
      readonly compatible: true;
      readonly commonFrame: CadResolvedFrame;
      readonly stationMm: number;
      readonly tangentialOffsetMm: CadNumericPoint2;
      readonly placementUncertaintyMm: number;
      readonly minimumGapMm: number;
      readonly basisResidual: number;
    }
  | { readonly compatible: false; readonly code: string; readonly message: string };

const dot = (a: CadNumericPoint3, b: CadNumericPoint3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (point: CadNumericPoint3) => Math.max(...point.map(Math.abs));
const originError = (section: CadLoftSection) =>
  section.placement.frame.precision.originUncertaintyMm +
  (section.offset === 0
    ? 0
    : CAD_DATUM_ORTHONORMAL_RESIDUAL * Math.max(1, scale(section.placement.frame.origin), Math.abs(section.offset)));
function commonFrame(first: CadLoftSection): CadResolvedFrame {
  const frame = first.placement.frame;
  return Object.freeze({
    ...frame,
    origin: cadFramePointToWorld(frame, first.offset, [0, 0]),
    precision: Object.freeze({ ...frame.precision, originUncertaintyMm: originError(first) }),
  });
}

/** Basis compatibility is independent of section ordering or separation. */
export function inspectCadLoftSectionPair(first: CadLoftSection, second: CadLoftSection): CadLoftSectionPairInspection {
  return inspectSectionPair(first, second, false);
}
function inspectSectionPair(first: CadLoftSection, second: CadLoftSection, canonical: boolean): CadLoftSectionPairInspection {
  if (!canonical && typeof first.plane === 'string' && typeof second.plane === 'string') {
    if (first.plane !== second.plane)
      return Object.freeze({
        compatible: false,
        code: 'unsupported-loft-planes',
        message: 'Loft sections must use the same principal sketch plane.',
      });
    return Object.freeze({
      compatible: true,
      commonFrame: cadPrincipalFrame(first.plane),
      stationMm: second.offset,
      tangentialOffsetMm: Object.freeze([0, 0] as const),
      placementUncertaintyMm: 0,
      minimumGapMm: cadLoftOffsetTolerance([first.offset, second.offset]),
      basisResidual: 0,
    });
  }
  try {
    const frame = commonFrame(first);
    const other = second.placement.frame;
    const residual = Math.max(
      ...(['u', 'v', 'normal'] as const).map((axis) => Math.hypot(...frame[axis].map((value, index) => value - other[axis][index]))),
    );
    const allowance = Math.max(CAD_DATUM_ORTHONORMAL_RESIDUAL, frame.precision.angularUncertainty + other.precision.angularUncertainty);
    if (!Number.isFinite(residual) || residual > allowance)
      throw new CadError(
        'unsupported-loft-planes',
        'Loft sections need the same oriented local axes and normal. Align the datum rotations; reversed normals, rolled axes and twisted sections are not supported.',
      );
    const origin = cadFramePointToWorld(other, second.offset, [0, 0]);
    const delta: CadNumericPoint3 = [origin[0] - frame.origin[0], origin[1] - frame.origin[1], origin[2] - frame.origin[2]];
    const x = dot(delta, frame.u);
    const y = dot(delta, frame.v);
    const station = dot(delta, frame.normal);
    const rebuilt = cadFramePointToWorld(frame, station, [x, y]);
    const roundtrip = Math.hypot(...rebuilt.map((value, index) => value - origin[index]));
    const localScale = Math.max(first.localCoordinateScaleMm, second.localCoordinateScaleMm);
    const translatedScale = Math.hypot(...delta);
    const worldScale = Math.max(1, scale(frame.origin), scale(origin));
    // Independent projections and one rigid placement, not accumulated transforms.
    // Charge numerical basis equivalence by the entire section/translation lever.
    const uncertainty =
      frame.precision.originUncertaintyMm +
      originError(second) +
      roundtrip +
      CAD_DATUM_ORTHONORMAL_RESIDUAL *
        (worldScale + Math.max(1, scale(delta)) + Math.max(1, localScale, Math.abs(x), Math.abs(y), Math.abs(station))) +
      frame.precision.angularUncertainty * (localScale + translatedScale + Math.abs(first.offset)) +
      other.precision.angularUncertainty * (second.localCoordinateScaleMm + Math.abs(second.offset)) +
      residual * (localScale + translatedScale);
    if (![x, y, station, uncertainty].every(Number.isFinite) || uncertainty > CAD_DATUM_NATIVE_PLACEMENT_PRECISION_MM)
      throw new CadError(
        'unsupported-datum-precision',
        'This loft placement exceeds the supported native precision. Reduce world distance, section dimensions or datum translation span.',
      );
    const minimumGapMm = Math.max(CAD_LOFT_NATIVE_PRECISION, cadRoundoff(8, Math.max(1, Math.abs(station)))) + 2 * uncertainty;
    return Object.freeze({
      compatible: true,
      commonFrame: frame,
      stationMm: station,
      tangentialOffsetMm: Object.freeze([x, y] as const),
      placementUncertaintyMm: uncertainty,
      minimumGapMm,
      basisResidual: residual,
    });
  } catch (error) {
    if (error instanceof CadError) return Object.freeze({ compatible: false, code: error.code, message: error.message });
    throw error;
  }
}

/** Resolve cached section placements without reevaluating their contours. */
export function resolveCadLoftSectionPlacements(sections: readonly CadLoftSection[]): CadResolvedLoftSections {
  if (sections.length < MIN_CAD_LOFT_SECTIONS || sections.length > MAX_CAD_LOFT_SECTIONS)
    throw new CadError('loft-section-limit', 'Lofts require 2–16 ordered sketch sections.');
  if (new Set(sections.map((section) => section.sketchId)).size !== sections.length)
    throw new CadError('duplicate-loft-section', 'Loft sketch sections must have unique IDs.');
  const first = sections[0];
  const legacyPrincipalPlane =
    sections.every((section) => typeof section.plane === 'string') && typeof first.plane === 'string' ? first.plane : null;
  let placementUncertaintyMm = 0;
  const placed: CadResolvedLoftSection[] = sections.map((section) => {
    // Force the canonical frame for every section of a mixed Loft, even for a
    // principal/principal pair, so stations never mix absolute and relative data.
    const inspection = inspectSectionPair(first, section, legacyPrincipalPlane === null);
    if (!inspection.compatible) throw CadError.checked(inspection.code, inspection.message);
    placementUncertaintyMm = Math.max(placementUncertaintyMm, inspection.placementUncertaintyMm);
    return Object.freeze({ ...section, stationMm: inspection.stationMm, tangentialOffsetMm: inspection.tangentialOffsetMm });
  });
  const frame = legacyPrincipalPlane === null ? commonFrame(first) : cadPrincipalFrame(legacyPrincipalPlane);
  const stationScale = Math.max(1, ...placed.map((section) => Math.abs(section.stationMm)));
  const offsetTolerance =
    legacyPrincipalPlane === null
      ? Math.max(CAD_LOFT_NATIVE_PRECISION, cadRoundoff(8, stationScale)) + 2 * placementUncertaintyMm
      : cadLoftOffsetTolerance(placed.map((section) => section.offset));
  let direction = 0;
  for (let index = 1; index < placed.length; index++) {
    const difference = placed[index].stationMm - placed[index - 1].stationMm;
    if (Math.abs(difference) <= offsetTolerance)
      throw new CadError('invalid-loft-order', 'Loft section stations must be separated beyond native and floating-point precision.');
    const sign = Math.sign(difference);
    if (direction !== 0 && sign !== direction)
      throw new CadError('invalid-loft-order', 'Loft section stations must increase or decrease strictly in the supplied order.');
    direction = sign;
  }
  return Object.freeze({
    sections: Object.freeze(placed),
    commonFrame: frame,
    legacyPrincipalPlane,
    offsetTolerance,
    placementUncertaintyMm,
  });
}
