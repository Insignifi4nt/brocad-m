import { CadError } from './cadError';
import type { CadSketchGraph, CadSketchTangentJointRelation, CadSketchGraphIssue } from './cadSketchGraph';
import { resolveCadSketchPointIdentities, resolveCadSketchGraphJoints } from './cadSketchGraphJoints';
import { resolveCadSketchCornerTopology } from './cadSketchCornerGeometry';
import { cadSketchLineDirection } from './cadSketchLineRelations';
import { cadPathClosureTolerance } from './cadAnalyticSegments';
import { cadSketchDriverTolerance } from './cadSketchPrecision';
import type { Point2 } from '@/domain/path-intel/types';
import { CAD_PRECISION } from '@/domain/precision/cadPrecision';

export class CadSketchTangentOwnershipError extends CadError<'already-driven-sketch-tangent'> {
  constructor(readonly ownerRelationId: string) {
    super('already-driven-sketch-tangent', 'This tangent joint is already driven by its fillet corner.');
  }
}

/** Authored finite endpoints only; equal coordinates never declare a joint. */
export function resolveCadSketchTangentJoint(graph: CadSketchGraph, relation: Pick<CadSketchTangentJointRelation, 'endpoints'>) {
  const [first, second] = relation.endpoints;
  const a = graph.entities.find(entity => entity.id === first.entityId), b = graph.entities.find(entity => entity.id === second.entityId);
  const line = a?.kind === 'line' ? a : b?.kind === 'line' ? b : null;
  const arc = a?.kind === 'arc' ? a : b?.kind === 'arc' ? b : null;
  if (!line || !arc)
    throw new CadError('invalid-sketch-tangent-joint', 'Tangent needs one existing straight line and one endpoint arc.');
  const linePointId = (a === line ? first : second).pointId, arcPointId = (a === arc ? first : second).pointId;
  if (![line.startPointId, line.endPointId].includes(linePointId) || ![arc.startPointId, arc.endPointId].includes(arcPointId))
    throw new CadError('invalid-sketch-tangent-joint', 'Tangent operands must name actual endpoints of their line and arc.');
  const identity = resolveCadSketchPointIdentities(graph), joint = identity(linePointId);
  if (joint !== identity(arcPointId))
    throw new CadError('invalid-sketch-tangent-joint', 'Tangent endpoints need the same point or an explicit coincident relation.');
  const otherLineEndId = linePointId === line.startPointId ? line.endPointId : line.startPointId;
  if (identity(otherLineEndId) === joint || new Set([arc.centerPointId, arc.startPointId, arc.endPointId].map(identity)).size !== 3)
    throw new CadError('invalid-sketch-tangent-joint', 'Tangent supports must retain distinct line ends, arc ends and arc center.');
  for (const owner of graph.relations) if (owner.kind === 'fillet-corner' && owner.arcId === arc.id && owner.lineIds.includes(line.id)) {
    const topology = resolveCadSketchCornerTopology(graph, owner), index = topology.lines.findIndex(item => item.id === line.id);
    if (identity(topology.trimPointIds[index]) === joint) throw new CadSketchTangentOwnershipError(owner.id);
  }
  return { line, arc, linePointId, arcPointId, otherLineEndId, arcJointIsStart: arcPointId === arc.startPointId };
}

/** Native perpendicularity is unsigned. Independently retain contact and the smooth, opposing outward branch. */
export function checkCadSketchTangentJoint(graph: CadSketchGraph, relation: CadSketchTangentJointRelation, points: ReadonlyMap<string, Point2>): CadSketchGraphIssue[] {
  const source = { kind: 'relation', id: relation.id } as const;
  try {
    const { line, arc, linePointId, arcPointId, otherLineEndId, arcJointIsStart } = resolveCadSketchTangentJoint(graph, relation);
    const outwardLine = cadSketchLineDirection({ ...line, startPointId: linePointId, endPointId: otherLineEndId }, points);
    const radial = cadSketchLineDirection({ ...line, startPointId: arc.centerPointId, endPointId: arcPointId }, points);
    const otherArcEnd = points.get(arcJointIsStart ? arc.endPointId : arc.startPointId);
    if (!outwardLine || !radial || !otherArcEnd) return []; // Owning coordinate checks report unavailable positions.
    const identity = resolveCadSketchPointIdentities(graph), joint = identity(linePointId);
    // Check the complete declared class with strict closure roundoff, never the driver floor.
    resolveCadSketchGraphJoints(graph, new Map([...points].filter(([id]) => identity(id) === joint)));
    const sigma = (arc.direction === 'ccw' ? 1 : -1) * (arcJointIsStart ? 1 : -1);
    const tangent = { x: -sigma * radial.y, y: sigma * radial.x };
    const dot = outwardLine.x * tangent.x + outwardLine.y * tangent.y;
    const cross = outwardLine.x * tangent.y - outwardLine.y * tangent.x;
    const error = Math.abs(Math.atan2(cross, -dot));
    const residualMm = 2 * Math.sin(error / 2) * Math.max(outwardLine.length, radial.length);
    // Far from the origin, rounding each coordinate alone turns a short support by more than 1e-12 radians. The
    // allowance stays tiny, so supports only a few roundoff steps long are rejected rather than read as tangent.
    const roundoff = cadPathClosureTolerance([outwardLine.start, outwardLine.end, radial.start, radial.end]) / Math.min(outwardLine.length, radial.length);
    if (!(dot < 0) || !Number.isFinite(error) || error > Math.max(CAD_PRECISION.angularAccuracyRad, Math.min(roundoff, CAD_PRECISION.angularRoundoffCapRad))
      || residualMm > cadSketchDriverTolerance([outwardLine.start, outwardLine.end, radial.start, radial.end, otherArcEnd]))
      return [{ source, code: 'relation-residual', message: 'The line and arc do not form a smooth tangent joint.', ...(Number.isFinite(residualMm) ? { residualMm } : {}) }];
    return [];
  } catch (error) { return [{ source, code: 'relation-residual', message: error instanceof Error ? error.message : 'Invalid tangent joint.' }]; }
}
