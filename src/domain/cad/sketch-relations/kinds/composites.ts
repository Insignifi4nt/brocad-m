import { checkCadSketchCornerRelation, resolveCadSketchCornerTopology } from '../../cadSketchCornerGeometry';
import { validateCadSketchExternalReference } from '../../cadSketchExternalReferences';
import { cadSketchLinearPatternInstances, checkCadSketchLinearPattern, validateCadSketchLinearPattern } from '../../cadSketchLinearPattern';
import type { CadSketchLoweringContext } from '../../sketch-solver/cadSketchLoweringContext';
import { checkCadSketchExternalReferenceOwnership } from '../cadSketchRelationChecks';
import type { CadSketchOperandSignature, CadSketchRelationDefinition, CadSketchRelationOf, CadSketchRemapRule } from '../cadSketchRelationTypes';
import { sortedIds } from './kindParts';

// Relations that made geometry and keep it: a pattern's copies, a linked reference's construction edge and a corner's arc or chamfer
// line. Tools create them with that geometry, so none is offered from a selection.

export const linearPattern: CadSketchRelationDefinition<'linear-pattern'> = {
  kind: 'linear-pattern', family: 'composite', name: 'Linear pattern',
  stored: { slots: [{ role: 'Seed circle', accepts: ['circle'] }, { role: 'Seed centre', accepts: ['point'], end: true }] },
  operands: ({ seed }) => [seed.entityId, seed.centerPointId],
  withOperands: (relation, [entityId, centerPointId]) => ({ ...relation, seed: { ...relation.seed, entityId, centerPointId } }),
  scalars: { keys: ['spacing'], quantity: { spacing: 'length' }, read: relation => [relation.spacing], write: (relation, [spacing]) => ({ ...relation, spacing }) },
  // The copies in range and not omitted.
  owns: relation => {
    const active = cadSketchLinearPatternInstances(relation).filter(member => member.active);
    return { pointIds: active.map(member => member.pointId), entityIds: active.map(member => member.entityId) };
  },
  key: relation => `linear-pattern ${relation.seed.entityId}`,
  validate: (graph, relation) => { validateCadSketchLinearPattern(graph, relation); },
  // Each active copy keeps the seed's centre moved along the axis by its place in the row, and the seed's size.
  lower: (relation, context) => {
    const axis = relation.direction.endsWith('x') ? 0 : 1, sign = relation.direction.startsWith('-') ? -1 : 1;
    for (const member of cadSketchLinearPatternInstances(relation).filter(member => member.active)) {
      for (const coordinate of [0, 1] as const)
        context.offset(coordinate, relation.seed.centerPointId, member.pointId, coordinate === axis ? sign * member.index * context.value(relation.id, 'spacing') : 0);
      context.equalSizes(context.size(context.edge(relation.seed.entityId)), context.size(context.edge(member.entityId)));
    }
  },
  check: (graph, relation, _, parameters) => checkCadSketchLinearPattern(graph, parameters, relation),
  remap: { roles: ['source', 'end'], owned: 'refuse', copy: { mirror: 'drop', offset: 'drop', pattern: 'drop' } },
  agent: { exposed: true, summary: 'Copies of a circle repeat at a set spacing along X or Y.',
    meaning: 'Owns a row of circles. Copies follow the seed center and radius at the declared signed axis pitch. Edit this owner to change count, direction or exclusions; detach before independent copy edits.' }
};

export const externalReference: CadSketchRelationDefinition<'external-reference'> = {
  kind: 'external-reference', family: 'composite', name: 'Linked reference',
  // Its source lives in another sketch; here it keeps one construction edge that follows that source.
  stored: { slots: [] },
  operands: () => [],
  withOperands: relation => relation,
  owns: relation => ({ pointIds: [], entityIds: [relation.entityId] }),
  key: relation => `external-reference ${relation.entityId}`,
  mentions: (relation, names) => [names.entity(relation.entityId)],
  validate: (graph, relation) => { validateCadSketchExternalReference(graph, relation); },
  // Its edge's points and radius follow the source, so they compile as fixed values and it adds no equation.
  lower: () => {},
  check: (graph, relation) => checkCadSketchExternalReferenceOwnership(graph, relation),
  remap: { roles: [], owned: 'refuse', copy: { mirror: 'drop', offset: 'drop', pattern: 'drop' } },
  agent: { exposed: true, summary: 'A construction line or circle follows an edge of another sketch.',
    meaning: 'Linked construction geometry follows a stable preceding sketch edge along the shared plane normal. Detach explicitly to retain its current numeric shape without the source link.' }
};

/** The corner's topology, with the original corner point kept on both lines' supports. */
function cornerOnSupports(relation: CadSketchRelationOf<'fillet-corner' | 'chamfer-corner'>, context: CadSketchLoweringContext) {
  const topology = resolveCadSketchCornerTopology(context.graph, relation), [a, b] = topology.lines;
  context.onSupport(relation.pointId, context.support(a));
  context.onSupport(relation.pointId, context.support(b));
  return topology;
}
const CORNER = {
  slots: [{ role: 'Corner point', accepts: ['point'], needs: ['movable'] }, { role: 'First line', accepts: ['line'], needs: ['ends'] }, { role: 'Second line', accepts: ['line'], needs: ['ends'] }]
} as const satisfies CadSketchOperandSignature;
/** A corner joins each line at its trim point and keeps the arc or chamfer line it made, which an edit may only remove with it. */
const CORNER_REMAP = {
  roles: ['point', 'joint', 'joint'],
  ends: (graph, relation) => { const { trimPointIds } = resolveCadSketchCornerTopology(graph, relation); return [undefined, trimPointIds[0], trimPointIds[1]]; },
  owned: 'confirm', copy: { mirror: 'drop', offset: 'drop', pattern: 'drop' }
} as const satisfies CadSketchRemapRule<CadSketchRelationOf<'fillet-corner' | 'chamfer-corner'>>;
export const filletCorner: CadSketchRelationDefinition<'fillet-corner'> = {
  kind: 'fillet-corner', family: 'composite', name: 'Fillet',
  stored: CORNER,
  operands: relation => [relation.pointId, ...relation.lineIds],
  withOperands: (relation, [pointId, first, second]) => ({ ...relation, pointId, lineIds: [first, second] }),
  scalars: { keys: ['value'], quantity: { value: 'length' }, read: relation => [relation.value], write: (relation, [value]) => ({ ...relation, value }) },
  owns: relation => ({ pointIds: [], entityIds: [relation.arcId] }),
  key: relation => `fillet-corner ${relation.pointId} ${sortedIds(relation.lineIds)}`,
  mentions: (relation, names) => [names.point(relation.pointId)],
  validate: (graph, relation) => { resolveCadSketchCornerTopology(graph, relation); },
  lower: (relation, context) => {
    const topology = cornerOnSupports(relation, context), [a, b] = topology.lines, [p, q] = topology.trimPointIds;
    if (topology.entity.kind !== 'arc') throw new Error('A fillet requires its referenced arc.');
    // The arc's radius at each trim point is square to that point's line, and its size is the value.
    const centre = context.centre(topology.entity);
    context.emit('perpendicular', [...context.support(a), ...context.through(centre, p)]);
    context.emit('perpendicular', [...context.support(b), ...context.through(centre, q)]);
    context.sized(context.span(centre, p), context.value(relation.id, 'value'));
  },
  check: (graph, relation, points, parameters) => checkCadSketchCornerRelation(graph, relation, points, parameters),
  remap: { ...CORNER_REMAP, normalize: relation => relation.lineIds[0] < relation.lineIds[1] ? relation : { ...relation, lineIds: [relation.lineIds[1], relation.lineIds[0]] } },
  agent: { exposed: true, summary: 'An arc of a set radius rounds the corner where two lines meet.',
    meaning: 'Keeps a tangent minor arc at the original reference corner, with a driving radius and finite trimmed sides.' }
};
export const chamferCorner: CadSketchRelationDefinition<'chamfer-corner'> = {
  kind: 'chamfer-corner', family: 'composite', name: 'Chamfer',
  stored: CORNER,
  operands: relation => [relation.pointId, ...relation.lineIds],
  withOperands: (relation, [pointId, first, second]) => ({ ...relation, pointId, lineIds: [first, second] }),
  scalars: { keys: ['values.0', 'values.1'], quantity: { 'values.0': 'length', 'values.1': 'length' }, read: relation => relation.values, write: (relation, [first, second]) => ({ ...relation, values: [first, second] }) },
  owns: relation => ({ pointIds: [], entityIds: [relation.chamferId] }),
  key: relation => `chamfer-corner ${relation.pointId} ${sortedIds(relation.lineIds)}`,
  mentions: (relation, names) => [names.point(relation.pointId)],
  validate: (graph, relation) => { resolveCadSketchCornerTopology(graph, relation); },
  lower: (relation, context) => {
    const [p, q] = cornerOnSupports(relation, context).trimPointIds;
    context.sized(context.span(relation.pointId, p), context.value(relation.id, 'values.0'));
    context.sized(context.span(relation.pointId, q), context.value(relation.id, 'values.1'));
  },
  check: (graph, relation, points, parameters) => checkCadSketchCornerRelation(graph, relation, points, parameters),
  // A chamfer's setbacks, and where each is drawn, stay with their lines.
  remap: { ...CORNER_REMAP, normalize: relation => {
    if (relation.lineIds[0] < relation.lineIds[1]) return relation;
    const sides = relation.annotation?.sides;
    return { ...relation, lineIds: [relation.lineIds[1], relation.lineIds[0]], values: [relation.values[1], relation.values[0]],
      ...(sides ? { annotation: { kind: 'setbacks' as const, sides: [sides[1], sides[0]] as const } } : {}) };
  } },
  agent: { exposed: true, summary: 'A line cuts the corner where two lines meet, set back by two lengths.',
    meaning: 'Keeps two driving setbacks along the finite sides of the original reference corner.' }
};
