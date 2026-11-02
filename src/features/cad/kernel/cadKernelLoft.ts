import { cast, getOC, isShape3D, type Drawing, type Shape3D, type SimplePoint, type Sketch } from 'replicad';
import { CadError } from '../../../domain/cad/cadError';
import { CAD_LOFT_NATIVE_PRECISION, type resolveCadLoftSections } from '../../../domain/cad/cadLoft';
import { CadKernelPlane, cadKernelPlaneBasis } from './cadKernelPlane';
import { cadKernelProfileDrawing, cadKernelSketchOnPlane } from './cadKernelSketch';
import { cadKernelDisposeOwned, cadKernelIsValid, cadKernelSolids } from './cadKernelShapes';
import type { CadResolvedFrame } from '../../../domain/cad/cadDatumPlanes';
import { CAD_PRECISION } from '../../../domain/precision/cadPrecision';
import { cadKernelBounds, cadKernelVolume } from './cadKernelQueries';

function validateLoftSolid(shape: Shape3D) {
  const oc = getOC();
  const solids = cadKernelSolids(shape);
  try {
    if (solids.length !== 1) throw new CadError('loft-invalid', 'A loft must produce exactly one closed solid. Revise the section shapes or spacing.');
    if (!cadKernelIsValid(shape)) throw new CadError('loft-invalid', 'The loft made a body whose faces cross or leave gaps. Revise the section shapes or try ruled mode.');
    const explorer = new oc.TopExp_Explorer(shape.wrapped, oc.TopAbs_ShapeEnum.TopAbs_SHELL, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    try {
      while (explorer.More()) {
        const shell = explorer.Current();
        try { if (!oc.BRep_Tool.IsClosed(shell)) throw new CadError('loft-open', 'The loft produced an open shell. Revise its section shapes.'); }
        finally { cadKernelDisposeOwned(shell); }
        explorer.Next();
      }
    } finally { explorer.delete(); }
    const volume = cadKernelVolume(shape);
    if (!Number.isFinite(volume) || volume <= CAD_PRECISION.kernelMinimumVolumeMm3) throw new CadError('loft-volume', 'The loft must contain positive volume with outward orientation. Revise the section spacing.');
  } finally { for (const solid of solids) cadKernelDisposeOwned(solid); }
}

/** The fitted solid is constructed in canonical XY, then placed rigidly once. */
function placeLoftSolid(shape: Shape3D, frame: CadResolvedFrame): Shape3D {
  const oc = getOC();
  const owned: { delete(): void }[] = [];
  const own = <T extends { delete(): void }>(value: T): T => { owned.push(value); return value; };
  let builder: InstanceType<typeof oc.BRepBuilderAPI_Transform> | undefined;
  let result: Shape3D | undefined;
  try {
    const transform = own(new oc.gp_Trsf());
    const reference = own(new oc.gp_Ax3());
    const origin = own(new oc.gp_Pnt(...frame.origin));
    const normal = own(new oc.gp_Dir(...frame.normal));
    const u = own(new oc.gp_Dir(...frame.u));
    const target = own(new oc.gp_Ax3(origin, normal, u));
    transform.SetDisplacement(reference, target);
    // Own the native builder explicitly; the convenience transform hides it.
    builder = new oc.BRepBuilderAPI_Transform(shape.wrapped, transform, true, false);
    if (!builder.IsDone()) throw CadError.received('loft-placement', 'The loft could not be moved onto its datum plane. The move copies the loft exactly, so the loft built before it is likely damaged; rebuild the part, and if this repeats, revise its sections or recreate the datum plane.', { kernelMessage: 'OpenCascade could not place the fitted loft in its datum frame.' });
    const raw = builder.Shape();
    try {
      const placed = cast(raw);
      if (!isShape3D(placed)) { cadKernelDisposeOwned(placed); throw CadError.received('loft-placement', 'The loft could not be moved onto its datum plane. The move copies the loft exactly, so the loft built before it is likely damaged; rebuild the part, and if this repeats, revise its sections or recreate the datum plane.', { kernelMessage: 'Datum placement did not preserve the native loft solid.' }); }
      result = placed;
    } finally { cadKernelDisposeOwned(raw); }
    validateLoftSolid(result);
    return result;
  } catch (error) { if (result) cadKernelDisposeOwned(result); throw error; }
  finally { builder?.delete(); for (const value of owned.reverse()) cadKernelDisposeOwned(value); }
}

/** The caller owns the returned solid, including native fitted surfaces in smooth mode. */
export function buildCadLoftSolid(resolved: ReturnType<typeof resolveCadLoftSections>, ruled: boolean): Shape3D {
  const first = resolved.sections[0]; const last = resolved.sections.at(-1);
  if (!first || !last) throw new CadError('loft-sections', 'A loft needs at least two ordered sketch sections.');
  const oc = getOC();
  const builder = new oc.BRepOffsetAPI_ThruSections(true, ruled, CAD_LOFT_NATIVE_PRECISION);
  const planes: CadKernelPlane[] = []; const drawings: Drawing[] = []; const sketches: Sketch[] = [];
  let shape: Shape3D | undefined;
  try {
    builder.CheckCompatibility(true);
    // Compatibility may split edges or change wire origins; never mutate source wires.
    builder.SetMutableInput(false);
    for (const section of resolved.sections) {
      const basis = resolved.legacyPrincipalPlane === null ? cadKernelPlaneBasis('XY') : cadKernelPlaneBasis(resolved.legacyPrincipalPlane);
      const origin: SimplePoint = resolved.legacyPrincipalPlane === null
        ? [section.tangentialOffsetMm[0], section.tangentialOffsetMm[1], section.stationMm]
        : [basis.normal[0] * section.offset, basis.normal[1] * section.offset, basis.normal[2] * section.offset];
      const plane = new CadKernelPlane(origin, basis.u, basis.normal); planes.push(plane);
      const drawing = cadKernelProfileDrawing(section.geometry, drawings);
      const sketch = cadKernelSketchOnPlane(drawing, plane); sketches.push(sketch);
      builder.AddWire(sketch.wire.wrapped);
    }
    builder.Build();
    if (!builder.IsDone()) throw new CadError('loft-failed', 'The loft could not connect these sections. They may twist against each other or differ too much; revise their shapes or try ruled mode.');
    const raw = builder.Shape();
    try {
      const built = cast(raw);
      if (!isShape3D(built)) { cadKernelDisposeOwned(built); throw new CadError('loft-invalid', 'The loft made no closed solid. The sections may cross each other or one may be open; revise the sections or try ruled mode.'); }
      shape = built;
    } finally { cadKernelDisposeOwned(raw); }
    validateLoftSolid(shape);
    // Native validity alone can accept a fitted surface outside its end planes.
    // Optimal native bounds include native precision padding even for an exact cylinder.
    const [min, max] = cadKernelBounds(shape); const normal = cadKernelPlaneBasis(resolved.legacyPrincipalPlane ?? 'XY').normal;
    const lower = normal.reduce((sum, value, axis) => sum + value * (value < 0 ? max[axis] : min[axis]), 0);
    const upper = normal.reduce((sum, value, axis) => sum + value * (value < 0 ? min[axis] : max[axis]), 0);
    const tolerance = CAD_LOFT_NATIVE_PRECISION + resolved.offsetTolerance;
    const firstStation = resolved.legacyPrincipalPlane === null ? first.stationMm : first.offset;
    const lastStation = resolved.legacyPrincipalPlane === null ? last.stationMm : last.offset;
    if (!Number.isFinite(lower) || !Number.isFinite(upper)
      || lower < Math.min(firstStation, lastStation) - tolerance || upper > Math.max(firstStation, lastStation) + tolerance) {
      throw new CadError('loft-overshoot', 'The loft extends beyond its end-section planes. Try ruled mode or adjust the section spacing.');
    }
    if (resolved.legacyPrincipalPlane === null) {
      const local = shape;
      shape = placeLoftSolid(local, resolved.commonFrame);
      cadKernelDisposeOwned(local);
    }
    return shape;
  } catch (error) { if (shape) cadKernelDisposeOwned(shape); throw error; }
  finally {
    builder.delete();
    for (const sketch of sketches) cadKernelDisposeOwned(sketch);
    for (const plane of planes) plane.delete();
    for (const drawing of drawings) drawing.blueprint.delete();
  }
}
