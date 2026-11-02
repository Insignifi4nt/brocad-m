import { cast, getOC, isShape3D, type Edge, type Face, type Shape3D } from 'replicad';
import { CadError } from '../../../domain/cad/cadError';
import { cadKernelDisposeOwned, cadKernelSolids } from './cadKernelShapes';
import { CAD_PRECISION } from '../../../domain/precision/cadPrecision';

/** Explicit native builder lifetimes also cover rejected kernel operations. */
export function applyCadEdgeOperation(shape: Shape3D, edges: readonly Edge[], kind: 'fillet' | 'chamfer', radius: number, tangentPropagation = false): Shape3D {
  if (!edges.length) throw new CadError('selection-empty', 'Select at least one exact edge.', { expected: null });
  const oc = getOC();
  const builder = kind === 'fillet'
    ? new oc.BRepFilletAPI_MakeFillet(shape.wrapped, oc.ChFi3d_FilletShape.ChFi3d_Rational)
    : new oc.BRepFilletAPI_MakeChamfer(shape.wrapped);
  try {
    for (const edge of edges) builder.Add(radius, edge.wrapped);
    // Native tangent contours expand selected seeds only with explicit intent.
    // Exact seed queries and their counts have already been resolved upstream.
    if (tangentPropagation !== true) for (let contour = 1; contour <= builder.NbContours(); contour++) {
      for (let index = 1; index <= builder.NbEdges(contour); index++) {
        const propagated = builder.Edge(contour, index);
        try {
          if (!edges.some(edge => edge.wrapped.IsSame(propagated))) throw new CadError('selection-tangent-chain',
            `The ${kind} would also reach edges tangent to the selected ones. Enable Follow tangent edges or select the complete tangent chain.`);
        } finally { cadKernelDisposeOwned(propagated); }
      }
    }
    builder.Build();
    const size = kind === 'fillet' ? 'radius' : 'distance';
    if (!builder.IsDone()) throw new CadError('kernel-operation-failed', `The ${kind} could not be applied to the selected edges. The ${size} may be too large for an edge or a face next to it; reduce the ${size} or choose other edges.`);
    const raw = builder.Shape();
    try {
      const result = cast(raw);
      if (isShape3D(result)) return result;
      cadKernelDisposeOwned(result);
      throw new CadError('invalid-solid', 'The selected edge operation did not produce a solid.');
    } finally { cadKernelDisposeOwned(raw); }
  } finally { builder.delete(); }
}

export function applyCadShell(shape: Shape3D, opening: Face, thickness: number): Shape3D {
  if (thickness <= CAD_PRECISION.minimumLengthMm) throw new CadError('shell-thickness', 'Shell thickness must exceed the kernel tolerance of 0.0000001 mm.');
  const solids = cadKernelSolids(shape);
  try {
    if (solids.length !== 1) throw new CadError('shell-components', 'Shell currently requires one connected solid. Choose a body without disconnected pattern instances.');
  } finally { for (const solid of solids) cadKernelDisposeOwned(solid); }
  const oc = getOC();
  const faces = new oc.NCollection_List_TopoDS_Shape();
  const builder = new oc.BRepOffsetAPI_MakeThickSolid();
  try {
    // Append returns a copy of the stored shape, which keeps the opening's topology alive until it is deleted.
    faces.Append(opening.wrapped).delete();
    // OpenCascade uses negative offset for inward walls; the public feature is positive.
    builder.MakeThickSolidByJoin(shape.wrapped, faces, -thickness, CAD_PRECISION.kernelConfusionMm,
      oc.BRepOffset_Mode.BRepOffset_Skin, false, false, oc.GeomAbs_JoinType.GeomAbs_Arc, false);
    if (!builder.IsDone()) throw new CadError('shell-failed', 'The shell could not be made. The thickness may be too large for a thin or curved region; reduce the thickness or choose another planar opening.');
    const raw = builder.Shape();
    try {
      const result = cast(raw);
      if (isShape3D(result)) return result;
      cadKernelDisposeOwned(result);
      throw new CadError('invalid-solid', 'The shell did not produce a closed solid.');
    } finally { cadKernelDisposeOwned(raw); }
  } finally { builder.delete(); faces.delete(); }
}
