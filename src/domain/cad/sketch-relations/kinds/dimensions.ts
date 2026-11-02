import { CadError } from '../../cadError';
import type { CadSketchGraphEntity, CadSketchGraphPoint } from '../../cadSketchGraph';
import { evaluateCadScalar } from '../../cadExpression';
import { cadSketchAngleRaysOnLines, cadSketchDrivingAngle, checkCadSketchAngleRelation, resolveCadSketchAngleRays } from '../../cadSketchAngleRelations';
import { assertCadSketchPointLineDistanceIdentities, assertCadSketchPointLineDistanceValue, cadSketchPointLineDistanceLength, cadSketchPointLineSideSign,
  checkCadSketchPointLineDistanceRelation, resolveCadSketchPointLineDistanceOperands } from '../../cadSketchPointLineDistanceRelations';
import { cadSketchDrivingRadius, checkCadSketchRadialRelation, resolveCadSketchRadialEntity } from '../../cadSketchRadialRelations';
import { resolveCadSketchReferenceDimension } from '../../cadSketchReferenceDimensions';
import { checkCadSketchHeldPoint, checkCadSketchPointDistance, checkCadSketchPointPair } from '../cadSketchRelationChecks';
import { CAD_SKETCH_ANGLE_OPERANDS, CAD_SKETCH_POINT_LINE_DISTANCE_OPERANDS, CAD_SKETCH_RADIAL_OPERANDS } from '../cadSketchOperandSignatures';
import type { CadSketchOperandSignature, CadSketchRelationDefinition } from '../cadSketchRelationTypes';
import { cadSketchAxisOfNormal } from '../cadSketchVirtualElements';
import { CAD_SKETCH_POINT_OPERANDS, CAD_SKETCH_POINT_PAIR_OPERANDS, LINE_SLOT, POINT_SLOT, ROUND_SLOT, sortedIds } from './kindParts';

// Relations that hold a value: lengths, angles and sizes. Dimensions take their value from the person who places them, so none is
// offered from a selection.

type Line = Extract<CadSketchGraphEntity, { kind: 'line' }>;
type Round = Extract<CadSketchGraphEntity, { kind: 'arc' | 'circle' }>;
const value = {
  keys: ['value'],
  quantity: { value: 'length' } as const,
  read: (relation: { readonly value: string | number }) => [relation.value],
  write: <R extends { readonly value: string | number }>(relation: R, [next]: readonly (string | number)[]): R => ({ ...relation, value: next })
};

export const distance: CadSketchRelationDefinition<'distance'> = {
  kind: 'distance', family: 'dimension', name: 'Distance',
  stored: CAD_SKETCH_POINT_PAIR_OPERANDS,
  operands: relation => relation.pointIds,
  withOperands: (relation, [first, second]) => ({ ...relation, pointIds: [first, second] }),
  scalars: value,
  key: relation => `distance ${sortedIds(relation.pointIds)}`,
  lower: (relation, context) => context.sized(context.span(relation.pointIds[0], relation.pointIds[1]), context.value(relation.id, 'value')),
  check: (_, relation, points, parameters) => checkCadSketchPointDistance(relation, points, parameters),
  remap: { roles: ['point', 'point'], copy: { mirror: 'follow', offset: 'drop', pattern: 'drop' } },
  agent: { exposed: true, summary: 'Two points keep a set distance apart.',
    meaning: 'Keeps the straight-line distance between two points.' }
};

export const pointLineDistance: CadSketchRelationDefinition<'point-line-distance'> = {
  kind: 'point-line-distance', family: 'dimension', name: 'Point to line distance',
  stored: CAD_SKETCH_POINT_LINE_DISTANCE_OPERANDS,
  operands: relation => [relation.pointId, relation.lineId],
  withOperands: (relation, [pointId, lineId]) => ({ ...relation, pointId, lineId }),
  scalars: value,
  // The side is part of what the value says, as an angle's sector is.
  key: relation => `point-line-distance ${relation.pointId} ${relation.lineId}`,
  validate: (graph, relation, [point, line]) => {
    assertCadSketchPointLineDistanceIdentities(graph, point as CadSketchGraphPoint, line as Line);
    assertCadSketchPointLineDistanceValue(relation);
  },
  lower: (relation, context) => {
    const { line } = resolveCadSketchPointLineDistanceOperands(context.graph, relation), length = cadSketchPointLineDistanceLength(context.value(relation.id, 'value'));
    // The signed distance holds the stored side, whatever moved the point or the line since it was set.
    context.emit('point-line-distance', [...context.point(relation.pointId), ...context.support(line)], cadSketchPointLineSideSign(relation.side) * length);
  },
  check: (graph, relation, points, parameters) => checkCadSketchPointLineDistanceRelation(graph, relation, points, parameters),
  // The side is seen along the line, so it turns over with a reflection or with a line that now runs the other way.
  remap: { roles: ['point', 'carrier'], apart: [[0, 1]], copy: { mirror: 'follow', offset: 'drop', pattern: 'drop' },
    orient: (relation, { reflected, reversed }) => reflected !== reversed[1] ? { ...relation, side: relation.side === 'left' ? 'right' : 'left' } : relation },
  agent: { exposed: true, summary: 'A point keeps a set distance from a line, on one side of it.',
    meaning: 'Keeps a point at a positive distance from the infinite supporting line of the named line, on the side it starts on. Does not fix the line or make it parallel to anything.' }
};

export const axisDistance: CadSketchRelationDefinition<'axis-distance'> = {
  kind: 'axis-distance', family: 'dimension', name: 'Axis distance',
  nameOf: relation => relation.axis === 'x' ? 'Horizontal distance' : 'Vertical distance',
  // Measured from the first point to the second along the axis.
  stored: { slots: [{ role: 'From point', accepts: ['point'] }, { role: 'To point', accepts: ['point'] }] },
  directed: true,
  operands: relation => relation.pointIds,
  withOperands: (relation, [first, second]) => ({ ...relation, pointIds: [first, second] }),
  scalars: value,
  key: relation => `axis-distance ${relation.axis} ${relation.pointIds.join(' ')}`,
  lower: (relation, context) => context.offset(relation.axis === 'x' ? 0 : 1, relation.pointIds[0], relation.pointIds[1], context.value(relation.id, 'value')),
  // The stored order gives the direction, including negative and zero offsets.
  check: (_, relation, points, parameters) => checkCadSketchPointPair(relation, points,
    (a, b) => Math.abs((b[relation.axis] - a[relation.axis]) - evaluateCadScalar(relation.value, parameters))),
  remap: { roles: ['point', 'point'], copy: { mirror: 'drop', offset: 'drop', pattern: 'drop' } },
  agent: { exposed: true, summary: 'One point keeps a set horizontal or vertical distance from another.',
    meaning: 'Drives the signed second-minus-first point coordinate along the declared sketch axis.' }
};

export const fixedAxis: CadSketchRelationDefinition<'fixed-axis'> = {
  kind: 'fixed-axis', family: 'dimension', name: 'Distance',
  stored: CAD_SKETCH_POINT_OPERANDS,
  operands: relation => [relation.pointId],
  withOperands: (relation, [pointId]) => ({ ...relation, pointId }),
  scalars: value,
  key: relation => `fixed-axis ${relation.axis} ${relation.pointId}`,
  // A distance from an axis names the axis among its operands, as a distance between two lines names both. An X coordinate is a
  // distance from the V axis.
  mentions: (relation, names) => [names.point(relation.pointId), names.entity(cadSketchAxisOfNormal(relation.axis))],
  lower: (relation, context) => context.hold(relation.pointId, relation.axis === 'x' ? 0 : 1, context.value(relation.id, 'value')),
  check: (_, relation, points, parameters) => checkCadSketchHeldPoint(relation, points, point => ({ ...point, [relation.axis]: evaluateCadScalar(relation.value, parameters) })),
  remap: { roles: ['point'], copy: { mirror: 'drop', offset: 'drop', pattern: 'drop' } },
  agent: { exposed: true, summary: 'A point keeps a set distance from the H or V axis; at 0 it lies on that axis.',
    meaning: 'Keeps one point coordinate, X measured from the Y axis or Y from the X axis; the other can remain free. A value that is 0 whatever the parameters are keeps the point on that axis; any other value is a distance from the axis, on the side its sign gives.' }
};

export const lineAngle: CadSketchRelationDefinition<'line-angle'> = {
  kind: 'line-angle', family: 'dimension', name: 'Angle',
  stored: CAD_SKETCH_ANGLE_OPERANDS,
  operands: relation => relation.rays.flatMap(ray => [ray.lineId, ray.towardPointId]),
  withOperands: (relation, [first, firstToward, second, secondToward]) => ({ ...relation,
    rays: [{ ...relation.rays[0], lineId: first, towardPointId: firstToward }, { ...relation.rays[1], lineId: second, towardPointId: secondToward }] }),
  scalars: { ...value, quantity: { value: 'angle' } as const },
  // One angle between two lines, stored from either; its rays and sense choose the sector the value measures.
  key: relation => `line-angle ${sortedIds(relation.rays.map(ray => ray.lineId))}`,
  validate: (_, relation, [first, , second]) => { cadSketchAngleRaysOnLines([first as Line, second as Line], relation.rays); },
  lower: (relation, context) => {
    const [a, b] = resolveCadSketchAngleRays(context.graph, relation.rays);
    for (const { line } of [a, b]) context.direct(line.startPointId, line.endPointId, 'A sketch ray has no numeric endpoints.');
    context.emit('angle', [...context.through(a.fromPointId, a.towardPointId), ...context.through(b.fromPointId, b.towardPointId)],
      cadSketchDrivingAngle(context.value(relation.id, 'value'), relation.sense).signedRadians);
  },
  check: (graph, relation, points, parameters) => checkCadSketchAngleRelation(graph, relation, points, parameters),
  // Each ray runs toward a point, so it keeps its direction on a line that now runs the other way; a reflection turns the sector over.
  remap: { roles: ['toward', 'end', 'toward', 'end'], copy: { mirror: 'follow', offset: 'follow', pattern: 'drop' },
    orient: (relation, { reflected }) => reflected ? { ...relation, sense: relation.sense === 'cw' ? 'ccw' : 'cw' } : relation },
  agent: { exposed: true, summary: 'Two lines keep a set angle between them.',
    meaning: 'Drives the declared clockwise or counterclockwise sector between two explicit line rays in degrees.' }
};

export const radialSize: CadSketchRelationDefinition<'radial-size'> = {
  kind: 'radial-size', family: 'dimension', name: 'Radial size',
  nameOf: relation => relation.quantity === 'radius' ? 'Radius' : 'Diameter',
  stored: CAD_SKETCH_RADIAL_OPERANDS,
  operands: relation => [relation.entityId],
  withOperands: (relation, [entityId]) => ({ ...relation, entityId }),
  scalars: value,
  // A radius and a diameter hold one size.
  key: relation => `radial-size ${relation.entityId}`,
  validate: (_, __, [entity]) => {
    const round = entity as Round;
    if (round.kind === 'circle' && typeof round.radius === 'string')
      throw new CadError('already-driven-sketch-radius', 'Edit or explicitly release the existing circle-radius expression before adding a radial dimension.');
  },
  lower: (relation, context) => {
    const entity = resolveCadSketchRadialEntity(context.graph, relation.entityId), radius = cadSketchDrivingRadius(context.value(relation.id, 'value'), relation.quantity);
    context.sized(context.size(entity), radius);
  },
  check: (graph, relation, points, parameters) => checkCadSketchRadialRelation(graph, relation, points, parameters),
  remap: { roles: ['carrier'], copy: { mirror: 'follow', offset: 'drop', pattern: 'drop' } },
  agent: { exposed: true, summary: 'An arc or circle keeps a set radius or diameter.',
    meaning: 'Drives circle or arc size using the declared radius or diameter.' }
};

const REFERENCE_LINE_LENGTH = { slots: [{ ...LINE_SLOT, needs: ['length'] }] } as const satisfies CadSketchOperandSignature;
const REFERENCE_POINT_LINE = { slots: [POINT_SLOT, LINE_SLOT] } as const satisfies CadSketchOperandSignature;
const REFERENCE_RADIAL = { slots: [ROUND_SLOT] } as const satisfies CadSketchOperandSignature;
export const referenceDimension: CadSketchRelationDefinition<'reference-dimension'> = {
  kind: 'reference-dimension', family: 'dimension', name: 'Reference dimension',
  // A reference reads what it measures and drives nothing, so it has no value to change.
  stored: ({ measurement }) => measurement.kind === 'line-length' ? REFERENCE_LINE_LENGTH : measurement.kind === 'point-distance' ? CAD_SKETCH_POINT_PAIR_OPERANDS
    : measurement.kind === 'point-line-distance' ? REFERENCE_POINT_LINE : REFERENCE_RADIAL,
  operands: ({ measurement }) => measurement.kind === 'point-distance' ? measurement.pointIds
    : measurement.kind === 'point-line-distance' ? [measurement.pointId, measurement.lineId] : [measurement.entityId],
  withOperands: (relation, [first, second]) => {
    const measurement = relation.measurement;
    return { ...relation, measurement: measurement.kind === 'point-distance' ? { ...measurement, pointIds: [first, second] }
      : measurement.kind === 'point-line-distance' ? { ...measurement, pointId: first, lineId: second } : { ...measurement, entityId: first } };
  },
  key: ({ measurement }) => `reference-dimension ${measurement.kind} ${measurement.kind === 'point-distance' ? sortedIds(measurement.pointIds)
    : measurement.kind === 'point-line-distance' ? `${measurement.pointId} ${measurement.lineId}` : measurement.entityId}`,
  validate: (graph, relation) => { resolveCadSketchReferenceDimension(graph, relation); },
  // It drives nothing, and the geometry's own checks stay authoritative.
  lower: () => {},
  check: () => [],
  // A reference reads what it measures, so a length on a changed extent would read something else: it blocks as a driving length does.
  remap: { roles: ({ measurement }) => measurement.kind === 'line-length' ? ['extent'] : measurement.kind === 'point-distance' ? ['point', 'point']
    : measurement.kind === 'point-line-distance' ? ['point', 'carrier'] : ['carrier'], copy: { mirror: 'follow', offset: 'drop', pattern: 'follow' } },
  agent: { exposed: true, summary: 'A measurement shown on the sketch without driving it.',
    meaning: 'Measures current geometry without driving it or adding a native equation.' }
};
