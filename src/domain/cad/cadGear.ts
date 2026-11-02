import type { CadScalar } from './cadDocument';
import type { ResolvedCadPathSegment } from './cadAnalyticSegments';
import { evaluateCadAngle, evaluateCadScalar } from './cadExpression';
import { CadError } from './cadError';
import { CAD_PRECISION } from '../precision/cadPrecision';

export interface CadGearProfile { readonly x: CadScalar; readonly y: CadScalar; readonly module: CadScalar; readonly teeth: CadScalar; readonly pressureAngle: CadScalar; readonly profileShift: CadScalar; readonly backlash: CadScalar; readonly angle: CadScalar; readonly tolerance: CadScalar }
export const DEFAULT_CAD_GEAR: CadGearProfile = { x: 0, y: 0, module: 3, teeth: 18, pressureAngle: 20, profileShift: 0, backlash: 0, angle: 0, tolerance: 0.005 };
export const CAD_GEAR_NOTE = 'Involute flanks use straight segments within the specified tolerance. Root and tip circles are exact. Roots use straight radial extensions, without cutter-generated trochoids or fillets. Review root strength and mating clearance before manufacture.';
export const CAD_GEAR_CUTTER_RANGES = [
  { low: 12, high: 13 }, { low: 14, high: 16 }, { low: 17, high: 20 }, { low: 21, high: 25 },
  { low: 26, high: 34 }, { low: 35, high: 54 }, { low: 55, high: 134 }, { low: 135, high: 300 }
] as const;

/** Shared nominal dimensions and input validation, before any boundary sampling. */
function resolveCadGearSpec(profile: CadGearProfile, parameters: Readonly<Record<string, number>>) {
  const e = (value: number | string) => evaluateCadScalar(value, parameters);
  const m = e(profile.module), z = e(profile.teeth), alphaDegrees = e(profile.pressureAngle);
  const shift = e(profile.profileShift), backlash = e(profile.backlash), tolerance = e(profile.tolerance);
  const x = e(profile.x), y = e(profile.y), rotation = evaluateCadAngle(profile.angle, parameters) * Math.PI / 180;
  const fail = (message: string): never => { throw new CadError('invalid-gear', message); };
  if (m < 0.05 || m > 50) fail('Gear module must be between 0.05 and 50 mm.');
  if (!Number.isInteger(z) || z < 12 || z > 300) fail('Gear tooth count must be an integer from 12 to 300.');
  if (alphaDegrees < 14.5 || alphaDegrees > 30) fail('Gear pressure angle must be between 14.5 and 30 degrees.');
  if (shift < -0.5 || shift > 1) fail('Gear profile shift must be between -0.5 and 1.');
  if (backlash < 0 || backlash >= m * Math.PI / 2) fail('Gear backlash must be nonnegative and smaller than half the circular pitch.');
  if (tolerance < 0.00001 || tolerance > Math.min(0.1, m / 20)) fail('Gear flank tolerance must be at least 0.00001 mm and at most min(0.1 mm, module / 20).');
  const alpha = alphaDegrees * Math.PI / 180;
  const minimumShift = 1 - z * Math.sin(alpha) ** 2 / 2;
  if (shift < minimumShift - CAD_PRECISION.gearUndercutShiftSlack) fail(`This gear needs profile shift at least ${minimumShift.toFixed(4)} to avoid standard rack undercut. Increase tooth count, pressure angle or profile shift.`);
  const pitchRadius = m * z / 2, baseRadius = pitchRadius * Math.cos(alpha);
  const tipRadius = m * (z / 2 + 1 + shift), rootRadius = m * (z / 2 - 1.25 + shift);
  const toothHalfAngle = (Math.PI / 2 + 2 * shift * Math.tan(alpha) - backlash / m) / z;
  const baseHalfAngle = toothHalfAngle + Math.tan(alpha) - alpha;
  const startT = Math.sqrt(Math.max(0, (rootRadius / baseRadius) ** 2 - 1));
  const endT = Math.sqrt((tipRadius / baseRadius) ** 2 - 1);
  const inv = (t: number) => t - Math.atan(t);
  const rootHalfAngle = baseHalfAngle - inv(startT), tipHalfAngle = baseHalfAngle - inv(endT);
  if (!(rootRadius > 0 && endT > startT && tipHalfAngle > CAD_PRECISION.gearAngleMarginRad && rootHalfAngle < Math.PI / z - CAD_PRECISION.gearAngleMarginRad)) fail('Gear teeth overlap or have pointed tips. Adjust profile shift, backlash, pressure angle or tooth count.');
  return { m, z, x, y, rotation, tolerance, pitchRadius, baseRadius, tipRadius, rootRadius, toothHalfAngle, baseHalfAngle,
    startT, endT, rootHalfAngle, tipHalfAngle };
}

/** Nominal validation only. Each pinned generator applies its own sampling and edge budget. */
export function resolveCadGearMetrics(profile: CadGearProfile, parameters: Readonly<Record<string, number>>) {
  const { m, z, tolerance, pitchRadius, baseRadius, tipRadius, rootRadius, toothHalfAngle } = resolveCadGearSpec(profile, parameters);
  return { teeth: z, module: m, pitchDiameter: 2 * pitchRadius, tipDiameter: 2 * tipRadius, rootDiameter: 2 * rootRadius,
    baseDiameter: 2 * baseRadius, toothThickness: 2 * pitchRadius * toothHalfAngle, tolerance };
}

/** Standard full-depth external spur gear. No approximation is hidden in saved geometry. */
export function resolveCadGear(profile: CadGearProfile, parameters: Readonly<Record<string, number>>) {
  const { m, z, x, y, rotation, tolerance, pitchRadius, baseRadius, tipRadius, rootRadius, toothHalfAngle, baseHalfAngle,
    startT, endT, rootHalfAngle, tipHalfAngle } = resolveCadGearSpec(profile, parameters);
  const fail = (message: string): never => { throw new CadError('invalid-gear', message); };
  const inv = (t: number) => t - Math.atan(t);
  // Linear interpolation error <= max|r''(t)| * dt² / 8.
  // For the involute r(t), |r''(t)| = rb * sqrt(1+t²).
  const steps = Math.max(2, Math.ceil((endT - startT) / Math.sqrt(8 * tolerance / (baseRadius * Math.sqrt(1 + endT ** 2)))));
  const radialRoot = rootRadius < baseRadius - CAD_PRECISION.minimumLengthMm;
  const edgeCount = z * (2 * steps + 2 + (radialRoot ? 2 : 0));
  if (edgeCount > 8192) fail('Gear exceeds the 8192-edge modeling budget. Increase flank tolerance or reduce tooth count/module.');
  const segments: ResolvedCadPathSegment[] = [];
  const polar = (radius: number, a: number): readonly [number, number] => [x + radius * Math.cos(a), y + radius * Math.sin(a)];
  const line = (start: readonly [number, number], end: readonly [number, number]) => { segments.push({ kind: 'line', start, end }); };
  const arc = (radius: number, start: number, sweep: number) => { segments.push({ kind: 'arc', center: [x, y], radius, startAngle: start * 180 / Math.PI, sweep: sweep * 180 / Math.PI }); };
  const flank = (t: number, center: number, upper: boolean): readonly [number, number] => {
    const a = center + (upper ? baseHalfAngle - inv(t) : -baseHalfAngle + inv(t));
    return polar(baseRadius * Math.sqrt(1 + t * t), a);
  };
  for (let tooth = 0; tooth < z; tooth++) {
    const center = rotation + tooth * 2 * Math.PI / z;
    if (radialRoot) line(polar(rootRadius, center - rootHalfAngle), flank(startT, center, false));
    for (let i = 0; i < steps; i++) line(flank(startT + (endT - startT) * i / steps, center, false), flank(startT + (endT - startT) * (i + 1) / steps, center, false));
    arc(tipRadius, center - tipHalfAngle, 2 * tipHalfAngle);
    for (let i = steps; i > 0; i--) line(flank(startT + (endT - startT) * i / steps, center, true), flank(startT + (endT - startT) * (i - 1) / steps, center, true));
    if (radialRoot) line(flank(startT, center, true), polar(rootRadius, center + rootHalfAngle));
    arc(rootRadius, center + rootHalfAngle, 2 * Math.PI / z - 2 * rootHalfAngle);
  }
  // Each side of a tooth: a radial line from the root circle to the base circle, when the root is below it, then the flank's chords.
  return { segments, teeth: z, module: m, pitchDiameter: 2 * pitchRadius, tipDiameter: 2 * tipRadius, rootDiameter: 2 * rootRadius,
    baseDiameter: 2 * baseRadius, toothThickness: 2 * pitchRadius * toothHalfAngle, tolerance, edgeCount, rootSteps: radialRoot ? 1 : 0, flankSteps: steps };
}
