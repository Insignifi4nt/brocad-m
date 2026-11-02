import { cast, getOC, type Shape3D, type SimplePoint } from 'replicad';
import type { DxfEntity, DxfPoint } from '../../../domain/dxf/types';
import type { CadSectionResult } from '../../../domain/cad/cadSection';
import { CadError } from '../../../domain/cad/cadError';
import { cadEntitiesToCam } from '../../../domain/cad/cadCam';
import { cadKernelPlaneBasis } from './cadKernelPlane';
import { cadKernelBounds, cadKernelCurveEnd, cadKernelCurveStart, cadKernelCurveTangentAt, cadKernelPlaneThrough } from './cadKernelQueries';
import { cadKernelDisposeOwned, cadKernelEdges, cadKernelSolids } from './cadKernelShapes';
import { assertCadSectionClosedEndpoints } from './cadKernelSectionEndpoints';
import { CAD_PRECISION, cadRoundoff } from '../../../domain/precision/cadPrecision';

const tolerance = CAD_PRECISION.kernelConfusionMm;
const tau = 2 * Math.PI;
const angularRoundoff = cadRoundoff(64, tau);
export function sectionCadKernelShape(shape: Shape3D, section: Pick<CadSectionResult, 'bodyId' | 'plane' | 'offset'>): CadSectionResult {
  const basis = cadKernelPlaneBasis(section.plane);
  const origin: SimplePoint = [basis.normal[0] * section.offset, basis.normal[1] * section.offset, basis.normal[2] * section.offset];
  const project = (coordinates: SimplePoint): DxfPoint => ({ x: coordinates[0] * basis.u[0] + coordinates[1] * basis.u[1] + coordinates[2] * basis.u[2],
    y: coordinates[0] * basis.v[0] + coordinates[1] * basis.v[1] + coordinates[2] * basis.v[2] });
  // Refuse a tangent/outside plane: cap-face intersections do not prove a cutting section.
  const normalAxis = section.plane === 'XY' ? 2 : section.plane === 'XZ' ? 1 : 0;
  const coordinate = origin[normalAxis];
  const [min, max] = cadKernelBounds(shape);
  if (coordinate <= min[normalAxis] + tolerance * 10 || coordinate >= max[normalAxis] - tolerance * 10) {
    throw new CadError('empty-section', 'The section plane must pass through the interior of the body; tangent and outside sections cannot be transferred to CAM.');
  }
  const components = cadKernelSolids(shape);
  try {
    for (const component of components) {
      const [min, max] = cadKernelBounds(component);
      if (Math.abs(coordinate - min[normalAxis]) <= tolerance * 10 || Math.abs(coordinate - max[normalAxis]) <= tolerance * 10) {
        throw new CadError('tangent-section', 'The plane touches the end of a solid component. Choose an offset that cuts through material instead of lying on an end face.');
      }
    }
  } finally { for (const component of components) cadKernelDisposeOwned(component); }
  const plane = cadKernelPlaneThrough(origin, basis.normal);
  try {
    const builder = new (getOC()).BRepAlgoAPI_Section(shape.wrapped, plane, false);
    try {
      builder.Approximation(false); builder.Build();
      if (builder.HasErrors()) throw new CadError('section-failed', 'The section could not be cut through this body. The plane may run along a face or an edge; move the section plane slightly.');
      const raw = builder.Shape();
      let output: ReturnType<typeof cast>;
      try { output = cast(raw); } finally { cadKernelDisposeOwned(raw); }
      try {
        const edges = cadKernelEdges(output);
        const entities: DxfEntity[] = [];
        try {
          if (!edges.length) throw new CadError('empty-section', 'The plane does not cut a closed outline through this body.');
          for (const edge of edges) {
            const curve = edge.curve;
            try {
              const adaptor = new (getOC()).BRepAdaptor_Curve(edge.wrapped);
              try {
                const start = project(cadKernelCurveStart(curve.wrapped)); const end = project(cadKernelCurveEnd(curve.wrapped));
                switch (curve.curveType) {
                  case 'LINE':
                    if (Math.hypot(end.x - start.x, end.y - start.y) <= tolerance) throw new CadError('degenerate-section', 'The section has a degenerate edge. Choose a different offset.');
                    entities.push({ type: 'line', layer: 'CAD_SECTION', start, end }); break;
                  case 'CIRCLE': {
                    const circle = adaptor.Circle();
                    try {
                      const point = circle.Location();
                      try {
                        const center = project([point.X(), point.Y(), point.Z()]);
                        const radius = circle.Radius();
                        const sweep = adaptor.LastParameter() - adaptor.FirstParameter();
                        if (!(sweep > 0 && sweep <= tau + angularRoundoff)) throw new CadError('invalid-section', 'The section contains an invalid circular sweep.');
                        // Millimetre endpoint tolerances cannot classify angles. A tiny
                        // missing angle can be a material opening on a large circle.
                        if (curve.isClosed && Math.abs(sweep - tau) <= angularRoundoff) entities.push({ type: 'circle', layer: 'CAD_SECTION', center, radius });
                        else {
                          const tangent = project(cadKernelCurveTangentAt(curve.wrapped, 0));
                          const clockwise = (start.x - center.x) * tangent.y - (start.y - center.y) * tangent.x < 0;
                          const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
                          const sweepRadians = clockwise ? -sweep : sweep;
                          entities.push({ type: 'arc', layer: 'CAD_SECTION', center, radius, start, end, startAngle, endAngle: startAngle + sweepRadians, sweepRadians, clockwise });
                        }
                      } finally { point.delete(); }
                    } finally { circle.delete(); }
                    break;
                  }
                  default: throw new CadError('unsupported-section-curve', `This section contains ${curve.curveType.toLowerCase().replaceAll('_', ' ')} edges. CAM transfer supports exact lines and circular arcs only. Choose another plane or offset.`);
                }
              } finally { adaptor.delete(); }
            } finally { curve.delete(); }
          }
          // Only closed unbranched outlines are suitable for planar wire EDM.
          assertCadSectionClosedEndpoints(entities, tolerance);
          const cam = cadEntitiesToCam(entities);
          return { ...section, entities, contourCount: cam.contours.length };
        } finally { for (const edge of edges) cadKernelDisposeOwned(edge); }
      } finally { cadKernelDisposeOwned(output); }
    } finally { builder.delete(); }
  } finally { plane.delete(); }
}
