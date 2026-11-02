import type { CadSketchGraphEntity } from '../../cadSketchGraph';
import { checkCadSketchLineRelation, resolveCadSketchLinePair } from '../../cadSketchLineRelations';
import type { CadSketchLoweringContext } from '../../sketch-solver/cadSketchLoweringContext';
import { checkCadSketchPointPair } from '../cadSketchRelationChecks';
import { CAD_SKETCH_LINE_PAIR_OPERANDS } from '../cadSketchOperandSignatures';
import type { CadSketchRelationDefinition, CadSketchRelationPlanner } from '../cadSketchRelationTypes';
import type { CadSketchGraphSelection } from '../../cadSketchGraphSelection';
import { CAD_SKETCH_POINT_PAIR_OPERANDS, LINE_SLOT, POINT_SLOT, chainedPair, sortedIds } from './kindParts';

// Directions: a line, or two points, level or upright, and two lines that keep one direction, a right angle or one line between them.

type Line = Extract<CadSketchGraphEntity, { kind: 'line' }>;
// A line aligns its own ends; two points align with each other. The planner refuses points joined in one place, and a pair the other
// direction already holds, directly or through other relations.
const LINE_EACH = { slots: [LINE_SLOT], expand: 'each' } as const;
const POINT_PAIR = { slots: [POINT_SLOT, POINT_SLOT], unordered: [[0, 1]] } as const;
const lineEnds = (planner: CadSketchRelationPlanner, pick: CadSketchGraphSelection) => {
  const line = planner.entity(pick.id) as Line;
  return [line.startPointId, line.endPointId] as const;
};

export const horizontal: CadSketchRelationDefinition<'horizontal'> = {
  kind: 'horizontal', family: 'orientation', name: 'Horizontal',
  stored: CAD_SKETCH_POINT_PAIR_OPERANDS,
  operands: relation => relation.pointIds,
  withOperands: (relation, [first, second]) => ({ ...relation, pointIds: [first, second] }),
  key: relation => `horizontal ${sortedIds(relation.pointIds)}`,
  offers: [
    { signature: LINE_EACH, plan: (planner, [line]) => planner.align('horizontal', lineEnds(planner, line)) },
    { signature: POINT_PAIR, plan: (planner, [a, b]) => planner.align('horizontal', [a.id, b.id]) }
  ],
  lower: (relation, context) => context.offset(1, relation.pointIds[0], relation.pointIds[1]),
  check: (_, relation, points) => checkCadSketchPointPair(relation, points, (a, b) => Math.abs(a.y - b.y)),
  remap: { roles: ['point', 'point'], direction: true, copy: { mirror: 'axes', offset: 'ends', pattern: 'drop' } },
  agent: { exposed: true, summary: 'Two points, such as the ends of a line, stay level.',
    meaning: 'Keeps two points at the same Y coordinate.' }
};
export const vertical: CadSketchRelationDefinition<'vertical'> = {
  kind: 'vertical', family: 'orientation', name: 'Vertical',
  stored: CAD_SKETCH_POINT_PAIR_OPERANDS,
  operands: relation => relation.pointIds,
  withOperands: (relation, [first, second]) => ({ ...relation, pointIds: [first, second] }),
  key: relation => `vertical ${sortedIds(relation.pointIds)}`,
  offers: [
    { signature: LINE_EACH, plan: (planner, [line]) => planner.align('vertical', lineEnds(planner, line)) },
    { signature: POINT_PAIR, plan: (planner, [a, b]) => planner.align('vertical', [a.id, b.id]) }
  ],
  lower: (relation, context) => context.offset(0, relation.pointIds[0], relation.pointIds[1]),
  check: (_, relation, points) => checkCadSketchPointPair(relation, points, (a, b) => Math.abs(a.x - b.x)),
  remap: { roles: ['point', 'point'], direction: true, copy: { mirror: 'axes', offset: 'ends', pattern: 'drop' } },
  agent: { exposed: true, summary: 'Two points, such as the ends of a line, stay upright.',
    meaning: 'Keeps two points at the same X coordinate.' }
};

/** Two lines, each refused unless its ends give it a direction. */
export function directedLinePair(context: CadSketchLoweringContext, lineIds: readonly [string, string]) {
  const lines = resolveCadSketchLinePair(context.graph, lineIds);
  for (const line of lines) context.direct(line.startPointId, line.endPointId, 'A sketch line has no numeric endpoints.');
  return lines;
}

// Lines that keep another of these relations, or an angle, cannot take one more.
const LINE_PAIR = chainedPair(LINE_SLOT);
export const parallel: CadSketchRelationDefinition<'parallel'> = {
  kind: 'parallel', family: 'orientation', name: 'Parallel',
  stored: CAD_SKETCH_LINE_PAIR_OPERANDS,
  operands: relation => relation.lineIds,
  withOperands: (relation, [first, second]) => ({ ...relation, lineIds: [first, second] }),
  key: relation => `parallel ${sortedIds(relation.lineIds)}`,
  offers: [{ signature: LINE_PAIR, plan: (planner, [a, b]) => planner.orient('parallel', [a.id, b.id]) }],
  lower: (relation, context) => {
    const [a, b] = directedLinePair(context, relation.lineIds);
    context.emit('parallel', [...context.support(a), ...context.support(b)]);
  },
  check: (graph, relation, points) => checkCadSketchLineRelation(graph, relation, points),
  remap: { roles: ['carrier', 'carrier'], copy: { mirror: 'follow', offset: 'follow', pattern: 'drop' } },
  agent: { exposed: true, summary: 'Two lines keep the same direction.',
    meaning: 'Keeps two line directions parallel.' }
};
export const perpendicular: CadSketchRelationDefinition<'perpendicular'> = {
  kind: 'perpendicular', family: 'orientation', name: 'Perpendicular',
  stored: CAD_SKETCH_LINE_PAIR_OPERANDS,
  operands: relation => relation.lineIds,
  withOperands: (relation, [first, second]) => ({ ...relation, lineIds: [first, second] }),
  key: relation => `perpendicular ${sortedIds(relation.lineIds)}`,
  offers: [{ signature: LINE_PAIR, plan: (planner, [a, b]) => planner.orient('perpendicular', [a.id, b.id]) }],
  lower: (relation, context) => {
    const [a, b] = directedLinePair(context, relation.lineIds);
    context.emit('perpendicular', [...context.support(a), ...context.support(b)]);
  },
  check: (graph, relation, points) => checkCadSketchLineRelation(graph, relation, points),
  remap: { roles: ['carrier', 'carrier'], copy: { mirror: 'follow', offset: 'follow', pattern: 'drop' } },
  agent: { exposed: true, summary: 'Two lines meet at a right angle.',
    meaning: 'Keeps two line directions at a right angle.' }
};
export const collinear: CadSketchRelationDefinition<'collinear'> = {
  kind: 'collinear', family: 'orientation', name: 'Collinear',
  stored: CAD_SKETCH_LINE_PAIR_OPERANDS,
  operands: relation => relation.lineIds,
  withOperands: (relation, [first, second]) => ({ ...relation, lineIds: [first, second] }),
  key: relation => `collinear ${sortedIds(relation.lineIds)}`,
  offers: [{ signature: LINE_PAIR, plan: (planner, [a, b]) => planner.orient('collinear', [a.id, b.id]) }],
  lower: (relation, context) => {
    const [a, b] = directedLinePair(context, relation.lineIds);
    context.emit('parallel', [...context.support(a), ...context.support(b)]);
    // A shared authored endpoint already supplies incidence; disjoint lines need one more equation.
    if (![b.startPointId, b.endPointId].some(pointId => pointId === a.startPointId || pointId === a.endPointId)) context.onSupport(b.startPointId, context.support(a));
  },
  check: (graph, relation, points) => checkCadSketchLineRelation(graph, relation, points),
  remap: { roles: ['carrier', 'carrier'], copy: { mirror: 'follow', offset: 'drop', pattern: 'drop' } },
  agent: { exposed: true, summary: 'Two lines lie on one infinite line.',
    meaning: 'Keeps two lines on the same infinite supporting line without joining endpoints or fixing lengths.' }
};
