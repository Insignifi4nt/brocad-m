import { cadPathClosureTolerance } from '../../cadAnalyticSegments';
import type { CadSketchGraphEntity, CadSketchGraphPoint } from '../../cadSketchGraph';
import { assertCadSketchMidpointIdentities, resolveCadSketchMidpointOperands } from '../../cadSketchMidpointRelations';
import { assertCadSketchPointOnLineIdentities, checkCadSketchPointOnLineRelation, resolveCadSketchPointOnLineOperands } from '../../cadSketchPointOnLineRelations';
import { assertCadSketchPointOnCurveIdentities, checkCadSketchPointOnCurveRelation, resolveCadSketchPointOnCurveOperands } from '../../cadSketchPointOnCurveRelations';
import { assertCadSketchCurveSymmetry, assertCadSketchSymmetryIdentities, cadSketchMirrorIndex, checkCadSketchSymmetricRelation, isCadSketchCurveSymmetry,
  resolveCadSketchCurveSymmetryOperands, resolveCadSketchSymmetryOperands, type CadSketchMirroredCurve } from '../../cadSketchSymmetryRelations';
import { startCadSketchMirror } from '../../sketch-solver/cadSketchMirrorStarts';
import { checkCadSketchTangentJoint, resolveCadSketchTangentJoint } from '../../cadSketchTangentRelations';
import { checkCadSketchMidpoint, checkCadSketchPointPair } from '../cadSketchRelationChecks';
import { CAD_SKETCH_CURVE_SYMMETRY_OPERANDS, CAD_SKETCH_MIDPOINT_OPERANDS, CAD_SKETCH_POINT_ON_CURVE_OPERANDS, CAD_SKETCH_POINT_ON_LINE_OPERANDS, CAD_SKETCH_SYMMETRY_OPERANDS,
  resolveCadSketchOperands } from '../cadSketchOperandSignatures';
import { evaluateCadScalar } from '../../cadExpression';
import { cadSketchDriverTolerance } from '../../cadSketchPrecision';
import type { CadSketchRelationDefinition, CadSketchRelationOf } from '../cadSketchRelationTypes';
import type { CadSketchLoweringContext } from '../../sketch-solver/cadSketchLoweringContext';
import { CAD_SKETCH_ORIGIN_ID, cadSketchAxisNormal, isCadSketchVirtualAxisId, type CadSketchVirtualAxisId } from '../cadSketchVirtualElements';
import { CAD_SKETCH_POINT_PAIR_OPERANDS, LINE_SLOT, POINT_SLOT, ROUND_SLOT, chainedPair, sortedIds } from './kindParts';

// Points that lie on, or in a set place on, other geometry. Their parse checks resolve exact identities: proximity never stands in for one.

type Line = Extract<CadSketchGraphEntity, { kind: 'line' }>;
type Round = Extract<CadSketchGraphEntity, { kind: 'arc' | 'circle' }>;

export const coincident: CadSketchRelationDefinition<'coincident'> = {
  kind: 'coincident', family: 'incidence', name: 'Coincident',
  stored: CAD_SKETCH_POINT_PAIR_OPERANDS,
  operands: relation => relation.pointIds,
  withOperands: (relation, [first, second]) => ({ ...relation, pointIds: [first, second] }),
  key: relation => `coincident ${sortedIds(relation.pointIds)}`,
  offers: [
    { signature: chainedPair(POINT_SLOT), plan: (planner, [a, b]) => planner.coincide([a.id, b.id]) },
    // Two arcs or circles share their centre: a Coincident between the centres, which reads as Concentric.
    { signature: chainedPair(ROUND_SLOT), plan: (planner, [a, b]) => planner.concentric(planner.entity(a.id) as Round, planner.entity(b.id) as Round) },
    // An arc or circle centred at the origin, which also reads as Concentric, or on an axis: its centre takes the coordinates they fix.
    { signature: { slots: [ROUND_SLOT, { role: 'Origin', accepts: ['point'] }] },
      plan: (planner, [curve, origin]) => origin.id === CAD_SKETCH_ORIGIN_ID ? planner.centre(planner.entity(curve.id) as Round, origin.id) : null },
    { signature: { slots: [ROUND_SLOT, { role: 'Axis', accepts: ['axis'] }] }, plan: (planner, [curve, axis]) => planner.centre(planner.entity(curve.id) as Round, axis.id) }
  ],
  lower: (relation, context) => context.together(() => {
    context.offset(0, relation.pointIds[0], relation.pointIds[1]);
    context.offset(1, relation.pointIds[0], relation.pointIds[1]);
  }),
  // Points joined in one place close a path, so they meet within its closure tolerance.
  check: (_, relation, points) => checkCadSketchPointPair(relation, points, (a, b) => Math.hypot(a.x - b.x, a.y - b.y), cadPathClosureTolerance),
  remap: { roles: ['point', 'point'], copy: { mirror: 'unjoined', offset: 'centres', pattern: 'drop' } },
  agent: { exposed: true, summary: 'Two points share one position. Between two arc or circle centres it reads as Concentric.',
    meaning: 'Keeps two distinct source points at the same location.' }
};

export const midpoint: CadSketchRelationDefinition<'midpoint'> = {
  kind: 'midpoint', family: 'incidence', name: 'Midpoint',
  stored: CAD_SKETCH_MIDPOINT_OPERANDS,
  operands: relation => [relation.pointId, relation.lineId],
  withOperands: (relation, [pointId, lineId]) => ({ ...relation, pointId, lineId }),
  key: relation => `midpoint ${relation.pointId} ${relation.lineId}`,
  validate: (graph, _, [point, line]) => { assertCadSketchMidpointIdentities(graph, point as CadSketchGraphPoint, line as Line); },
  offers: [{ signature: { slots: [POINT_SLOT, { ...LINE_SLOT, needs: ['midpoint'] }] }, plan: (planner, [point, line]) => planner.place({ kind: 'midpoint', pointId: point.id, lineId: line.id }) }],
  lower: (relation, context) => {
    const { line } = resolveCadSketchMidpointOperands(context.graph, relation);
    context.together(() => {
      for (const axis of [0, 1] as const)
        context.emit('midpoint', [context.point(line.startPointId)[axis], context.point(line.endPointId)[axis], context.point(relation.pointId)[axis]]);
    });
  },
  check: (graph, relation, points) => checkCadSketchMidpoint(graph, relation, points),
  remap: { roles: ['point', 'extent'], apart: [[0, 1]], copy: { mirror: 'follow', offset: 'drop', pattern: 'drop' } },
  agent: { exposed: true, summary: 'A point stays at the middle of a line.',
    meaning: 'Keeps one distinct graph point halfway between a graph line’s endpoints, including construction lines. Does not join material boundaries.' }
};

export const pointOnLine: CadSketchRelationDefinition<'point-on-line'> = {
  kind: 'point-on-line', family: 'incidence', name: 'Point on line',
  stored: CAD_SKETCH_POINT_ON_LINE_OPERANDS,
  operands: relation => [relation.pointId, relation.lineId],
  withOperands: (relation, [pointId, lineId]) => ({ ...relation, pointId, lineId }),
  key: relation => `point-on-line ${relation.pointId} ${relation.lineId}`,
  validate: (graph, _, [point, line]) => { assertCadSketchPointOnLineIdentities(graph, point as CadSketchGraphPoint, line as Line); },
  offers: [{ signature: { slots: [POINT_SLOT, LINE_SLOT] }, plan: (planner, [point, line]) => planner.place({ kind: 'point-on-line', pointId: point.id, lineId: line.id }) }],
  lower: (relation, context) => {
    const { line } = resolveCadSketchPointOnLineOperands(context.graph, relation);
    context.direct(line.startPointId, line.endPointId, 'A point-on-line guide has no numeric endpoints.');
    context.onSupport(relation.pointId, context.support(line));
  },
  check: (graph, relation, points) => checkCadSketchPointOnLineRelation(graph, relation, points),
  remap: { roles: ['point', 'carrier'], apart: [[0, 1]], copy: { mirror: 'follow', offset: 'drop', pattern: 'drop' } },
  agent: { exposed: true, summary: 'A point stays on the infinite line through a line.',
    meaning: 'Keeps a point on the infinite supporting line of the named guide, with sliding freedom unless other dimensions constrain it. Does not join material boundaries, fix the guide or drive a circle radius.' }
};

export const pointOnCurve: CadSketchRelationDefinition<'point-on-curve'> = {
  kind: 'point-on-curve', family: 'incidence', name: 'Point on curve',
  stored: CAD_SKETCH_POINT_ON_CURVE_OPERANDS,
  operands: relation => [relation.pointId, relation.curveId],
  withOperands: (relation, [pointId, curveId]) => ({ ...relation, pointId, curveId }),
  key: relation => `point-on-curve ${relation.pointId} ${relation.curveId}`,
  validate: (graph, _, [point, curve]) => { assertCadSketchPointOnCurveIdentities(graph, point as CadSketchGraphPoint, curve as Round); },
  offers: [{ signature: { slots: [POINT_SLOT, ROUND_SLOT] }, plan: (planner, [point, curve]) => planner.place({ kind: 'point-on-curve', pointId: point.id, curveId: curve.id }) }],
  // The full supporting circle: the point's spoke matches an arc's start spoke, or a circle's radius.
  lower: (relation, context) => context.onCircle(relation.pointId, resolveCadSketchPointOnCurveOperands(context.graph, relation).curve),
  check: (graph, relation, points, parameters) => checkCadSketchPointOnCurveRelation(graph, relation, points, parameters),
  remap: { roles: ['point', 'carrier'], apart: [[0, 1]], copy: { mirror: 'follow', offset: 'drop', pattern: 'drop' } },
  agent: { exposed: true, summary: 'A point stays on the full circle of an arc or circle.',
    meaning: 'Keeps a point on the full supporting circle of the named arc or circle, with sliding freedom unless other dimensions constrain it. Does not join material boundaries, trim the arc or fix the curve.' }
};

const mirrored = { role: 'Point or curve', accepts: ['point', 'line', 'arc', 'circle'] } as const;
type CurveSymmetry = Extract<CadSketchRelationOf<'symmetric'>, { readonly curveIds: unknown }>;
/**
 * Mirrored curves, every point pair whole: each pair of distinct points mirrors as two points do, a point both curves share lies on
 * the axis and needs nothing where it is an end of the axis line, and circles keep one radius. With every pair whole no point has a
 * second place to settle, as the other crossing of an arc's circle with a single equation would be. The relation yields (see
 * `yields`), so what the curves' own structure, fixed values or other relations already keep of it, such as the second arc's radius
 * or two level lines' level ends, is solved but never reported as redundant. Two lines lower to four equations, arcs to six and
 * circles to three, fewer where they share points; arcs remove one freedom fewer than their equations, as the second arc's radius follows.
 * Which way two lines pair, and where the solve sets out, `startCadSketchMirror` decides, planning every curve Symmetric of the sketch
 * together in relation-id order, so pairs that point Symmetrics and earlier mirrors keep about the same line are kept.
 */
function lowerCurveSymmetry(relation: CurveSymmetry, context: CadSketchLoweringContext) {
  const { curves, line } = resolveCadSketchCurveSymmetryOperands(context.graph, relation), identity = (pointId: string) => context.identity(pointId);
  context.direct(line.startPointId, line.endPointId, 'A symmetry axis has no numeric endpoints.');
  const support = context.support(line), ends = new Set(isCadSketchVirtualAxisId(line.id) ? [] : [line.startPointId, line.endPointId].map(identity));
  for (const { pointIds: [p, q], self } of startCadSketchMirror(relation, context)) {
    if (self) { if (!ends.has(identity(p))) context.onSupport(p, support); continue; }
    const operands = [...context.point(p), ...context.point(q), ...support];
    context.emit('symmetric-midpoint', operands); context.emit('symmetric-perpendicular', operands);
  }
  const [a, b] = curves;
  if (a.kind === 'circle' && b.kind === 'circle') context.equalSizes(context.size(a), context.size(b));
}
const symmetricPointsMeaning = 'Keeps two point positions reflected about the infinite supporting line of the named axis. It does not fix that axis, join points or equalize circle radii.';
export const symmetric: CadSketchRelationDefinition<'symmetric'> = {
  kind: 'symmetric', family: 'incidence', name: 'Symmetric',
  nameOf: relation => isCadSketchCurveSymmetry(relation) ? 'Symmetric curves' : 'Symmetric points',
  stored: relation => isCadSketchCurveSymmetry(relation) ? CAD_SKETCH_CURVE_SYMMETRY_OPERANDS : CAD_SKETCH_SYMMETRY_OPERANDS,
  operands: relation => isCadSketchCurveSymmetry(relation) ? [...relation.curveIds, relation.lineId] : [...relation.pointIds, relation.lineId],
  withOperands: (relation, [first, second, lineId]) => isCadSketchCurveSymmetry(relation) ? { ...relation, curveIds: [first, second], lineId } : { ...relation, pointIds: [first, second], lineId },
  key: relation => `symmetric ${relation.lineId} ${sortedIds(isCadSketchCurveSymmetry(relation) ? relation.curveIds : relation.pointIds)}`,
  yields: isCadSketchCurveSymmetry,
  validate: (graph, relation, [first, second, line]) => {
    if (isCadSketchCurveSymmetry(relation)) assertCadSketchCurveSymmetry(graph, first as CadSketchMirroredCurve, second as CadSketchMirroredCurve, line as Line);
    else assertCadSketchSymmetryIdentities(graph, first as CadSketchGraphPoint, second as CadSketchGraphPoint, line as Line);
  },
  // The mirrored points, or every point of the mirrored curves once, then the axis line's ends: the pair and the axis it is mirrored about.
  pointIds: (graph, relation) => {
    if (!isCadSketchCurveSymmetry(relation)) {
      const { line } = resolveCadSketchSymmetryOperands(graph, relation);
      return [...relation.pointIds, line.startPointId, line.endPointId];
    }
    const [first, second, line] = resolveCadSketchOperands(graph, CAD_SKETCH_CURVE_SYMMETRY_OPERANDS, [...relation.curveIds, relation.lineId]) as readonly [CadSketchMirroredCurve, CadSketchMirroredCurve, Line];
    const own = (curve: CadSketchMirroredCurve) => curve.kind === 'line' ? [curve.startPointId, curve.endPointId]
      : curve.kind === 'arc' ? [curve.centerPointId, curve.startPointId, curve.endPointId] : [curve.centerPointId];
    return [...new Set([...own(first), ...own(second), line.startPointId, line.endPointId])];
  },
  // Two points, a point and a circle by its centre, or two lines, arcs or circles of one kind, about the pick `cadSketchMirrorIndex` names.
  offers: [{ signature: { slots: [mirrored, mirrored, { role: 'Axis line', accepts: ['line'] }], unordered: [[0, 1]] },
    plan: (planner, picks) => cadSketchMirrorIndex(picks.map(pick => pick.kind === 'point' ? planner.point(pick.id) : planner.entity(pick.id))) === 2
      ? planner.mirror([picks[0], picks[1]], planner.entity(picks[2].id) as Line) : null }],
  // The pair's midpoint lies on the axis and the pair's span is square to it: one constraint of two equations. Curves mirror pair by pair.
  lower: (relation, context) => {
    if (isCadSketchCurveSymmetry(relation)) return lowerCurveSymmetry(relation, context);
    const { line } = resolveCadSketchSymmetryOperands(context.graph, relation);
    context.direct(line.startPointId, line.endPointId, 'A symmetry axis has no numeric endpoints.');
    const operands = [...context.point(relation.pointIds[0]), ...context.point(relation.pointIds[1]), ...context.support(line)];
    context.together(() => { context.emit('symmetric-midpoint', operands); context.emit('symmetric-perpendicular', operands); });
  },
  check: (graph, relation, points, parameters) => checkCadSketchSymmetricRelation(graph, relation, points, parameters),
  meaningOf: relation => isCadSketchCurveSymmetry(relation) ? 'Keeps two lines, two arcs or two circles reflected about the infinite supporting line of the named axis, '
    + 'each end onto its mirror and an arc’s sweep reversed. Mirrored circles and arcs keep one radius. It does not fix that axis or join points.' : symmetricPointsMeaning,
  // Mirrored curves pair their ends, so any change to either curve's extent changes what they mirror; the axis is only a carrier.
  remap: { roles: relation => isCadSketchCurveSymmetry(relation) ? ['extent', 'extent', 'carrier'] : ['point', 'point', 'carrier'], apart: [[0, 2], [1, 2]],
    copy: { mirror: 'follow', offset: 'drop', pattern: 'drop' } },
  agent: { exposed: true, summary: 'Two points, lines, arcs or circles mirror each other about a line or an axis.', meaning: symmetricPointsMeaning }
};

const tangentCurve = (role: string) => ({ role, accepts: ['line', 'arc'], needs: ['ends'] }) as const;
export const tangentJoint: CadSketchRelationDefinition<'tangent-joint'> = {
  kind: 'tangent-joint', family: 'incidence', name: 'Tangent',
  // Each curve with the end it joins at.
  stored: { slots: [tangentCurve('First curve'), { role: 'First joint end', accepts: ['point'], end: true },
    tangentCurve('Second curve'), { role: 'Second joint end', accepts: ['point'], end: true }], unordered: [[0, 2]] },
  operands: relation => relation.endpoints.flatMap(endpoint => [endpoint.entityId, endpoint.pointId]),
  withOperands: (relation, [first, firstPoint, second, secondPoint]) => ({ ...relation,
    endpoints: [{ ...relation.endpoints[0], entityId: first, pointId: firstPoint }, { ...relation.endpoints[1], entityId: second, pointId: secondPoint }] }),
  key: relation => `tangent-joint ${sortedIds(relation.endpoints.map(endpoint => `${endpoint.entityId}@${endpoint.pointId}`))}`,
  mentions: (relation, names) => relation.endpoints.map(endpoint => `${names.entity(endpoint.entityId)} at ${names.point(endpoint.pointId)}`),
  validate: (graph, relation) => { resolveCadSketchTangentJoint(graph, relation); },
  // A line and an arc join at the one pair of their ends that share a place. Each joint end follows its curve's pick, so the picks keep
  // their own order, and two lines or two arcs take none.
  offers: [{ signature: { slots: [tangentCurve('First curve'), tangentCurve('Second curve')] }, plan: (planner, [a, b]) => {
    const first = planner.entity(a.id)!, second = planner.entity(b.id)!;
    return first.kind === second.kind ? null : planner.tangent(first, second);
  } }],
  // The line, from the joint toward its other end, is square to the arc's radius at the joint.
  lower: (relation, context) => {
    const { arc, linePointId, arcPointId, otherLineEndId } = resolveCadSketchTangentJoint(context.graph, relation), centre = context.centre(arc);
    context.direct(linePointId, otherLineEndId, 'A tangent support has no numeric endpoints.');
    context.direct(centre, arcPointId, 'A tangent support has no numeric endpoints.');
    context.emit('perpendicular', [...context.through(linePointId, otherLineEndId), ...context.through(centre, arcPointId)]);
    // A centre that starts along the line has no side to turn to.
    context.squareStart(arcPointId, centre, otherLineEndId);
  },
  check: (graph, relation, points) => checkCadSketchTangentJoint(graph, relation, points),
  remap: { roles: ['joint', 'end', 'joint', 'end'], copy: { mirror: 'follow', offset: 'follow', pattern: 'drop' } },
  agent: { exposed: true, summary: 'A line and an arc that share an endpoint join smoothly there.',
    meaning: 'Keeps one line and one arc smoothly opposed at their explicitly joined endpoints. Declared endpoint identity, arc direction and existing size drivers remain authoritative; it adds no coincidence or radius driver.' }
};

const axisTangentRefusal = { code: 'invalid-sketch-tangent', message: 'Tangent to an axis needs an existing arc or circle and the H or V axis.' } as const;
// An arc or circle touching the H or V axis, on whichever side of it the arc or circle is.
export const tangent: CadSketchRelationDefinition<'tangent'> = {
  kind: 'tangent', family: 'incidence', name: 'Tangent',
  stored: { slots: [{ role: 'Arc or circle', accepts: ['round'], refusal: axisTangentRefusal }, { role: 'Axis', accepts: ['axis'], refusal: axisTangentRefusal }] },
  operands: relation => relation.curveIds,
  withOperands: (relation, [curve, axis]) => ({ ...relation, curveIds: [curve, axis] }),
  key: relation => `tangent ${relation.curveIds[0]} ${relation.curveIds[1]}`,
  offers: [{ signature: { slots: [ROUND_SLOT, { role: 'Axis', accepts: ['axis'] }] }, plan: (planner, [curve, axis]) => planner.tangent(planner.entity(curve.id)!, planner.entity(axis.id)!) }],
  // Signed, on the side the centre starts on, so the curve never crosses the axis to touch it from the other side, and a centre that
  // starts on the axis has a regular equation there. At or above 0 across the axis, the centre's coordinate across it is the size.
  // Below, the size is that coordinate negated, the mirror of the form above, with the same unknowns and dependences (see `negatedSize`).
  lower: (relation, context) => {
    const curve = context.edge(relation.curveIds[0]), centre = context.centre(curve);
    const axis = cadSketchAxisNormal(relation.curveIds[1] as CadSketchVirtualAxisId) === 'y' ? 1 : 0, across = context.point(centre)[axis];
    if (context.side(centre, axis) > 0) context.equalSizes(context.size(curve), { kind: 'parameter', index: across });
    else context.negatedSize(curve, centre, axis);
  },
  check: (graph, relation, points, parameters) => {
    const source = { kind: 'relation', id: relation.id } as const;
    try {
      const curve = graph.entities.find(entity => entity.id === relation.curveIds[0]) as Round | undefined, centre = curve && points.get(curve.centerPointId);
      const start = curve?.kind === 'arc' ? points.get(curve.startPointId) : undefined;
      if (!curve || !centre || curve.kind === 'arc' && !start) return []; // Owning point checks report missing or invalid coordinates.
      const radius = curve.kind === 'circle' ? evaluateCadScalar(curve.radius, parameters) : Math.hypot(start!.x - centre.x, start!.y - centre.y);
      const across = cadSketchAxisNormal(relation.curveIds[1] as CadSketchVirtualAxisId) === 'y' ? centre.y : centre.x, residualMm = Math.abs(Math.abs(across) - radius);
      return !Number.isFinite(residualMm) || residualMm > cadSketchDriverTolerance([centre, ...(start ? [start] : [])])
        ? [{ source, code: 'relation-residual', message: 'The arc or circle does not touch its axis.', ...(Number.isFinite(residualMm) ? { residualMm } : {}) }] : [];
    } catch (error) {
      return [{ source, code: 'invalid-expression', message: error instanceof Error ? error.message : 'Invalid tangent to an axis.' }];
    }
  },
  remap: { roles: ['carrier', 'carrier'], copy: { mirror: 'follow', offset: 'drop', pattern: 'drop' } },
  agent: { exposed: true, summary: 'An arc or circle touches the H or V axis.',
    meaning: 'Keeps the full circle of an arc or circle touching an axis, on the side its centre starts on.' }
};
