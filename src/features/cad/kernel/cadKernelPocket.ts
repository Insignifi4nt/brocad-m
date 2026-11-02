import { cast, getOC, isShape3D, Vector, type Drawing, type Shape3D, type SimplePoint, type Sketch } from 'replicad';
import { CadError } from '../../../domain/cad/cadError';
import { resolveCadPocketExtent, type CadResolvedPocketInputs } from '../../../domain/cad/cadPocket';
import { CadKernelPlane, cadKernelPlaneBasis } from './cadKernelPlane';
import { cadKernelBuilders } from './cadKernelBuilders';
import { cadKernelProfileDrawing, cadKernelSketchOnPlane } from './cadKernelSketch';
import { cadKernelDisposeOwned } from './cadKernelShapes';
import { cadKernelShapeTolerance as pocketShapeTolerance, cadKernelSolidEvidence as solidEvidence } from './cadKernelCutEvidence';
import { CAD_PRECISION } from '../../../domain/precision/cadPrecision';
import { cadKernelBounds } from './cadKernelQueries';
import type { CadKernelProfileStep } from './cadKernelFailures';

export function prepareCadPocketExtent(target: Shape3D, inputs: CadResolvedPocketInputs): ReturnType<typeof resolveCadPocketExtent> {
  // A Boolean may omit an unresolved target component completely. Its absence
  // from Common cannot be certified by inspecting only the returned material.
  solidEvidence(target, 'target');
  const [min, max] = cadKernelBounds(target);
  return resolveCadPocketExtent({ plane: inputs.plane, offsetMm: inputs.offset,
    direction: inputs.direction, sectionScaleMm: inputs.sectionScaleMm, targetBounds: { min, max }, nativeToleranceMm: pocketShapeTolerance(target) });
}

/** The through-all tool of one region, whose face is built in `faces`. */
function extrudePocketRegion(wires: readonly Sketch[], span: number, normal: SimplePoint, faces: CadKernelProfileStep): Shape3D {
  const first = wires[0];
  if (!first) throw new CadError('empty-sketch', 'Pocket needs a closed non-construction material profile.');
  const oc = getOC(); const owned = new Set<{ delete(): void }>();
  const own = <T extends { delete(): void }>(value: T): T => { owned.add(value); return value; };
  try {
    const oriented = faces(() => {
      const maker = own(new oc.BRepBuilderAPI_MakeFace(first.wire.wrapped, true));
      for (const hole of wires.slice(1)) maker.Add(hole.wire.wrapped);
      if (!maker.IsDone()) throw new CadError('pocket-tool', 'Pocket profiles could not form a planar cutting face.');
      const face = own(maker.Face());
      // All nested loops have explicit material meaning. As in Replicad's
      // CompoundSketch, fix traversal orientation only; no geometric healing.
      const fixer = own(new oc.ShapeFix_Face(face)); fixer.FixOrientation();
      return own(fixer.Face());
    });
    const vector = own(new Vector([normal[0] * span, normal[1] * span, normal[2] * span]));
    const builder = own(new oc.BRepPrimAPI_MakePrism(oriented, vector.wrapped, false, true));
    if (!builder.IsDone()) throw new CadError('pocket-tool', 'The pocket could not make its through-all cutting tool from the sketch. A contour may cross itself; edit the sketch.');
    const raw = own(builder.Shape()); const shape = cast(raw);
    if (!isShape3D(shape)) { cadKernelDisposeOwned(shape); throw new CadError('pocket-tool', 'Pocket profiles did not produce a solid cutting tool.'); }
    return shape;
  } finally { for (const value of owned) cadKernelDisposeOwned(value); }
}

/** Borrow the exact prefix target. The caller owns the returned committed cut. Each region's wires and face are built in `faces`. */
export function buildCadPocketCut(target: Shape3D, inputs: CadResolvedPocketInputs, faces: CadKernelProfileStep): Shape3D {
  const extent = prepareCadPocketExtent(target, inputs); const basis = cadKernelPlaneBasis(inputs.plane);
  const origin: SimplePoint = [basis.normal[0] * extent.startStationMm, basis.normal[1] * extent.startStationMm, basis.normal[2] * extent.startStationMm];
  const plane = new CadKernelPlane(origin, basis.u, basis.normal); const drawings: Drawing[] = []; const sketches: Sketch[] = [];
  const shapes = new Set<Shape3D>(); const own = (shape: Shape3D) => { shapes.add(shape); return shape; };
  const release = (shape: Shape3D) => { cadKernelDisposeOwned(shape); shapes.delete(shape); };
  let tool: Shape3D | undefined;
  try {
    for (const region of inputs.regions) {
      const wires = faces(() => [region.boundary, ...region.voids].map(contour => {
        const drawing = cadKernelProfileDrawing(contour.geometry, drawings); const wire = cadKernelSketchOnPlane(drawing, plane); sketches.push(wire); return wire;
      }));
      const piece = own(extrudePocketRegion(wires, extent.spanMm, basis.normal, faces)); const regionEvidence = solidEvidence(piece, 'tool');
      // Refuse each unresolved region separately: a larger cutting region must
      // not hide a thin annulus that native Common may omit at its tolerance.
      if (regionEvidence.volume <= Math.max(CAD_PRECISION.kernelMinimumVolumeMm3, 4 * regionEvidence.tolerance * regionEvidence.surfaceArea)) {
        throw new CadError('unsupported-pocket-removal', 'A cutting region is too thin to resolve at native precision. Enlarge its material width or revise its holes.');
      }
      if (tool) {
        const previous = tool; tool = own(cadKernelBuilders.fuse(previous, piece)); solidEvidence(tool, 'tool'); release(previous); release(piece);
      } else tool = piece;
    }
    if (!tool) throw new CadError('empty-sketch', 'Pocket needs a closed non-construction material profile.');
    const common = own(cadKernelBuilders.common(target, tool)); const evidence = solidEvidence(common, 'common');
    // Evidence is checked per Common solid at its own precision scale.
    // Whole-target subtraction can lose a small bore or even become negative;
    // a broad removed component must not hide a second unresolved component.
    if (evidence.tolerance * 4 > extent.capMarginMm) throw new CadError('unsupported-pocket-precision', 'Pocket intersection exceeds the reserved cap precision. Revise the target or profile.');
    release(common);
    const result = own(cadKernelBuilders.cut(target, tool)); const final = solidEvidence(result, 'result');
    if (final.tolerance * 4 > extent.capMarginMm) throw new CadError('unsupported-pocket-precision', 'Pocket result exceeds the reserved cap precision. Revise the target or profile.');
    shapes.delete(result); return result;
  } finally {
    for (const shape of shapes) cadKernelDisposeOwned(shape); sketches.forEach(cadKernelDisposeOwned); plane.delete(); drawings.forEach(drawing => drawing.blueprint.delete());
  }
}
