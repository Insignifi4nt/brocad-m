import { Value } from '@sinclair/typebox/value';
import type { CadCurveFeature, CadFeature, CadSketchFeature, CadSweepFeature } from './cadDocument';
export type { CadSweepFeature } from './cadDocument';
import { CadError } from './cadError';
import { isCadImportData } from './cadImportData';
import { inspectCadLoftSketch, type CadLoftSection } from './cadLoft';
import { resolveCadCurve, type CadResolvedCurve } from './cadCurve';
import type { CadNumericPoint3 } from './cadPlanes';
import { resolveCadSweepClearance, type CadSweepClearance } from './cadSweepClearance';
import { cadOrderedCurveEntities } from './cadAnalyticSegments';
import { cadProfileToEntities } from './cadSketchGeometry';
import { prepareCadDatumFrames, type CadDatumFrameLookup } from './cadDatumPlanes';
import { resolveCadSweepPlacement, type CadSweepPlacement } from './cadSweepPlacement';
import { cadFeatureActive } from './features/cadFeatureActivity';
import { CadSweepFeatureSchema } from './features/kinds/solids';

export const MAX_CAD_SWEEP_SEGMENTS = 64;
export const MAX_CAD_SWEEP_WORK = 2048;
export { CAD_SWEEP_NATIVE_PRECISION, CAD_SWEEP_TOPOLOGY_TOLERANCE } from './cadSweepClearance';
export { CadSweepFeatureSchema };
export type CadSweepSection = CadLoftSection;
export type CadSweepSketchInspection = { readonly eligible: true; readonly section: CadSweepSection } | { readonly eligible: false; readonly code: string; readonly message: string };
export interface CadResolvedSweepInputs {
  readonly section: CadSweepSection;
  readonly curveFeature: CadCurveFeature;
  readonly curve: CadResolvedCurve;
  readonly frame: { readonly tangent: CadNumericPoint3; readonly normal: CadNumericPoint3; readonly binormal: CadNumericPoint3 };
  readonly clearance: CadSweepClearance;
  readonly sectionEdgeCount: number;
  readonly nativeWork: number;
  readonly placement: CadSweepPlacement;
}
export type CadSweepInspection = { readonly eligible: true; readonly inputs: CadResolvedSweepInputs } | { readonly eligible: false; readonly code: string; readonly message: string };

/** Same one-boundary contract as Loft, with operation-specific diagnostics. */
export function inspectCadSweepSketch(sketch: CadSketchFeature, parameters: Readonly<Record<string, number>>, lookup?: CadDatumFrameLookup): CadSweepSketchInspection {
  const inspection = inspectCadLoftSketch(sketch, parameters, lookup);
  return inspection.eligible ? inspection : { ...inspection, code: inspection.code === 'unsupported-loft-section' ? 'unsupported-sweep-section' : inspection.code,
    message: inspection.message.replaceAll('Loft', 'Sweep') };
}
function cross(a: CadNumericPoint3, b: CadNumericPoint3): CadNumericPoint3 {
  return Object.freeze([a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]);
}

/** Preserve source placement and authored traversal; reject unsupported precision/clearance. */
export function resolveCadSweepInputs(feature: CadSweepFeature, precedingFeatures: ReadonlyMap<string, CadFeature>, parameters: Readonly<Record<string, number>>, lookup?: CadDatumFrameLookup): CadResolvedSweepInputs {
  if (!isCadImportData(feature) || !Value.Check(CadSweepFeatureSchema, feature)) throw new CadError('invalid-feature', 'Malformed declarative Sweep feature.');
  if (feature.operation === 'new' && feature.targetId !== null || feature.operation !== 'new' && feature.targetId === null) throw new CadError('invalid-operation', 'New bodies have no target; join and cut require a target body.');
  const sketch = precedingFeatures.get(feature.sketchId); const curveFeature = precedingFeatures.get(feature.curveId);
  if (sketch?.kind !== 'sketch' || curveFeature?.kind !== 'curve') throw new CadError('invalid-reference', 'Sweep requires one preceding sketch and one preceding reference curve.');
  const frames = lookup ?? prepareCadDatumFrames([...precedingFeatures.values()], parameters);
  const sectionInspection = inspectCadSweepSketch(sketch, parameters, frames);
  if (!sectionInspection.eligible) throw CadError.checked(sectionInspection.code, sectionInspection.message);
  if (!cadFeatureActive(curveFeature, { parameters })) throw new CadError('suppressed-curve', `Sweep curve "${curveFeature.name}" is suppressed.`);
  const section = sectionInspection.section; const curve = resolveCadCurve(curveFeature, parameters, frames);
  const resolvedPlacement = resolveCadSweepPlacement(section, curve);
  if (curve.segments.length > MAX_CAD_SWEEP_SEGMENTS) throw new CadError('sweep-work-limit', `Sweep currently supports at most ${MAX_CAD_SWEEP_SEGMENTS} curve segments. The reference curve remains valid; simplify it for this solid operation.`);
  const entities = section.geometry.kind === 'path' ? cadOrderedCurveEntities(section.geometry.segments) : cadProfileToEntities(section.geometry);
  const sectionEdgeCount = entities.length; const nativeWork = sectionEdgeCount * curve.segments.length;
  if (nativeWork > MAX_CAD_SWEEP_WORK) throw new CadError('sweep-work-limit', `Sweep section edges × curve segments must be at most ${MAX_CAD_SWEEP_WORK}. Simplify the section or curve; their reference geometry remains valid.`);
  const clearance = resolveCadSweepClearance(curve, resolvedPlacement.profileRadiusMm, resolvedPlacement.sectionScaleMm, resolvedPlacement.placement.uncertaintyMm, resolvedPlacement.placement.worldScaleMm);
  return Object.freeze({ section, curveFeature, curve, frame: Object.freeze({ tangent: curve.startTangentWorld,
    normal: cross(curve.frame.normal, curve.startTangentWorld), binormal: curve.frame.normal }),
    clearance, sectionEdgeCount, nativeWork, placement: resolvedPlacement.placement });
}
export function inspectCadSweepInputs(feature: CadSweepFeature, precedingFeatures: ReadonlyMap<string, CadFeature>, parameters: Readonly<Record<string, number>>, lookup?: CadDatumFrameLookup): CadSweepInspection {
  try { return { eligible: true, inputs: resolveCadSweepInputs(feature, precedingFeatures, parameters, lookup) }; }
  catch (error) { if (error instanceof CadError) return { eligible: false, code: error.code, message: error.message }; throw error; }
}
