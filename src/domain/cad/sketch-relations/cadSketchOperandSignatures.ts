import { CadError } from '../cadError';
import type { CadSketchGraph, CadSketchGraphPoint } from '../cadSketchGraph';
import { cadSketchGraphEntity, cadSketchGraphPoint } from '../cadSketchGraphLookup';
import type { CadSketchEdge, CadSketchElement, CadSketchOperandCapability, CadSketchOperandSignature, CadSketchOperandSlot, CadSketchOperandTrait, CadSketchOperandType,
  CadSketchRefusal, CadSketchResolvedOperands } from './cadSketchRelationTypes';
import { CAD_SKETCH_VIRTUAL_LABELS, cadSketchVirtualAxis, cadSketchVirtualPoint, isCadSketchVirtualId, type CadSketchVirtualPoint } from './cadSketchVirtualElements';

// Shared by the relation definitions and by the resolvers other modules call, so a check is written once. This module imports nothing
// that imports the sketch graph, so the resolvers can use it while the graph module is still loading.

const traits: Readonly<Record<CadSketchOperandType, readonly CadSketchOperandTrait[]>> = {
  point: ['point'], line: ['line', 'curve'], arc: ['arc', 'round', 'curve'], circle: ['circle', 'round', 'curve'], axis: ['axis', 'line', 'curve']
};
/** Whether an element of this type fits the slot. */
export function cadSketchSlotAccepts(slot: Pick<CadSketchOperandSlot, 'accepts'>, type: CadSketchOperandType): boolean {
  return slot.accepts.some(trait => traits[type].includes(trait));
}
const pointSlot = (slot: CadSketchOperandSlot) => slot.accepts.includes('point');
/** Whether the slot names a point rather than an edge. */
export const isCadSketchPointSlot = pointSlot;

/** A point by id: the origin in constant time, or one of the graph's own. */
export const cadSketchElementPoint = (graph: CadSketchGraph, id: string): CadSketchGraphPoint | CadSketchVirtualPoint | undefined =>
  cadSketchVirtualPoint(id) ?? graph.points.find(item => item.id === id);
/** An edge by id: an axis in constant time, or one of the graph's own. */
export const cadSketchElementEdge = (graph: CadSketchGraph, id: string): CadSketchEdge | undefined =>
  cadSketchVirtualAxis(id) ?? graph.entities.find(item => item.id === id);
/** What an element is to a slot. */
export const cadSketchOperandType = (element: CadSketchElement): CadSketchOperandType => 'kind' in element ? element.kind : 'point';

const CAPABILITIES: Readonly<Record<CadSketchOperandType, readonly CadSketchOperandCapability[]>> = {
  point: ['movable'], line: ['movable', 'ends', 'length', 'midpoint'], arc: ['movable', 'ends'], circle: ['movable'], axis: []
};
/** Whether the element gives what a slot needs: the origin and the axes are fixed, and an axis is infinite. */
export function cadSketchOperandCan(element: CadSketchElement, capability: CadSketchOperandCapability): boolean {
  return !isCadSketchVirtualId(element.id) && CAPABILITIES[cadSketchOperandType(element)].includes(capability);
}
/** Why the element cannot give what a slot needs, in a sentence people and agents are shown. */
export function cadSketchCapabilityReason(element: CadSketchElement, capability: CadSketchOperandCapability): string {
  const virtual = isCadSketchVirtualId(element.id), name = element.id === '@origin' ? 'The origin'
    : virtual ? `The ${CAD_SKETCH_VIRTUAL_LABELS[element.id as keyof typeof CAD_SKETCH_VIRTUAL_LABELS]}` : `This ${cadSketchOperandType(element)}`;
  if (capability === 'movable') return `${name} is fixed, so it cannot take this relation.`;
  const lacks = capability === 'ends' ? 'ends' : capability === 'length' ? 'length' : 'middle';
  return virtual ? `${name} is infinite, so it has no ${lacks}.` : `${name} has no ${lacks}.`;
}
/** The refusal of an operand that lacks a capability its slot needs. */
export const cadSketchCapabilityRefusal = (element: CadSketchElement, capability: CadSketchOperandCapability): CadSketchRefusal =>
  ({ code: 'unsupported-sketch-operand', message: cadSketchCapabilityReason(element, capability) });
/** The first capability the slot needs that the element lacks, or undefined. */
export const cadSketchMissingCapability = (slot: Pick<CadSketchOperandSlot, 'needs'>, element: CadSketchElement): CadSketchOperandCapability | undefined =>
  slot.needs?.find(capability => !cadSketchOperandCan(element, capability));

const ALL_FIXED: CadSketchRefusal = { code: 'fixed-sketch-relation', message: 'A relation needs a sketch point or edge: the origin and the H and V axes are fixed already.' };
const refuse = (refusal: CadSketchRefusal) => new CadError(refusal.code, refusal.message);
/**
 * The origin or an axis in a slot, refused unless the slot takes its type and it gives what the slot needs. An `end` slot is the kind's
 * own to check, as an end of the edge before it.
 */
function virtualOperand(slot: CadSketchOperandSlot, id: string): CadSketchElement | undefined {
  if (slot.end) return undefined;
  const element = pointSlot(slot) ? cadSketchVirtualPoint(id) : cadSketchVirtualAxis(id);
  if (!element || !cadSketchSlotAccepts(slot, cadSketchOperandType(element))) {
    const label = id === '@origin' ? 'origin' : CAD_SKETCH_VIRTUAL_LABELS[id as keyof typeof CAD_SKETCH_VIRTUAL_LABELS];
    throw refuse({ code: 'invalid-sketch-operand', message: `The ${label} cannot be the ${slot.role.toLowerCase()} of this relation.` });
  }
  const missing = cadSketchMissingCapability(slot, element);
  if (missing) throw refuse(cadSketchCapabilityRefusal(element, missing));
  return element;
}

/**
 * The element of each stored operand, checking the slots that declare a refusal: an id repeated among the `distinct` slots first, then
 * each slot in order, missing or of a type it does not accept. A slot without a refusal is left to the point references check and
 * resolves to undefined, so parsing looks up only what it checks. The origin and the axes resolve in constant time in every slot that
 * takes their type and gets what it needs from them; a relation that names nothing else is refused.
 */
export function resolveCadSketchOperands(graph: CadSketchGraph, signature: CadSketchOperandSignature, ids: readonly string[]): CadSketchResolvedOperands {
  if (signature.distinct) {
    const seen = new Set<string>();
    for (const index of signature.distinct.slots) {
      if (seen.has(ids[index])) throw refuse(signature.distinct.refusal);
      seen.add(ids[index]);
    }
  }
  if (!signature.generates && ids.some(isCadSketchVirtualId) && signature.slots.every((slot, index) => slot.end || isCadSketchVirtualId(ids[index]))) throw refuse(ALL_FIXED);
  return signature.slots.map((slot, index): CadSketchElement | undefined => {
    const id = ids[index];
    if (isCadSketchVirtualId(id)) return virtualOperand(slot, id);
    if (!slot.refusal) return undefined;
    if (pointSlot(slot)) {
      const point = cadSketchGraphPoint(graph, id);
      if (!point) throw refuse(slot.refusal);
      return point;
    }
    const entity = cadSketchGraphEntity(graph, id);
    if (!entity || !cadSketchSlotAccepts(slot, entity.kind)) throw refuse(slot.refusal);
    return entity;
  });
}

const linePairRefusal = { code: 'invalid-sketch-line-pair', message: 'Choose two distinct existing sketch lines.' } as const;
const radialRefusal = { code: 'invalid-sketch-radial-entity', message: 'Radial geometry requires an existing circle or arc.' } as const;
const missingPoint = (message: string) => ({ code: 'missing-sketch-point', message });

/** Two distinct lines: Parallel, Perpendicular and Collinear, where either may be an axis. */
export const CAD_SKETCH_LINE_PAIR_OPERANDS = {
  slots: [{ role: 'First line', accepts: ['line'], refusal: linePairRefusal }, { role: 'Second line', accepts: ['line'], refusal: linePairRefusal }],
  unordered: [[0, 1]], distinct: { slots: [0, 1], refusal: linePairRefusal }
} as const satisfies CadSketchOperandSignature;
/** Two distinct lines of one length: an axis is infinite, so it has none. */
export const CAD_SKETCH_EQUAL_LENGTH_OPERANDS = {
  slots: [{ role: 'First line', accepts: ['line'], needs: ['length'], refusal: linePairRefusal }, { role: 'Second line', accepts: ['line'], needs: ['length'], refusal: linePairRefusal }],
  unordered: [[0, 1]], distinct: { slots: [0, 1], refusal: linePairRefusal }
} as const satisfies CadSketchOperandSignature;
/** One arc or circle a size is read from. */
export const CAD_SKETCH_RADIAL_OPERANDS = {
  slots: [{ role: 'Arc or circle', accepts: ['round'], refusal: radialRefusal }]
} as const satisfies CadSketchOperandSignature;
/** Two distinct arcs or circles of one radius. */
export const CAD_SKETCH_RADIUS_PAIR_OPERANDS = {
  slots: [{ role: 'First arc or circle', accepts: ['round'], refusal: radialRefusal }, { role: 'Second arc or circle', accepts: ['round'], refusal: radialRefusal }],
  unordered: [[0, 1]], distinct: { slots: [0, 1], refusal: { code: 'invalid-sketch-radius-pair', message: 'Choose two distinct circles or arcs.' } }
} as const satisfies CadSketchOperandSignature;
export const CAD_SKETCH_MIDPOINT_OPERANDS = {
  slots: [{ role: 'Point', accepts: ['point'], refusal: missingPoint('The midpoint relation needs an existing point.') },
    { role: 'Line', accepts: ['line'], needs: ['midpoint'], refusal: { code: 'invalid-sketch-midpoint', message: 'The midpoint relation needs an existing line.' } }]
} as const satisfies CadSketchOperandSignature;
export const CAD_SKETCH_POINT_ON_LINE_OPERANDS = {
  slots: [{ role: 'Point', accepts: ['point'], refusal: missingPoint('Point on line needs an existing sketch point.') },
    { role: 'Guide line', accepts: ['line'], refusal: { code: 'invalid-sketch-point-on-line', message: 'Point on line needs an existing straight guide.' } }]
} as const satisfies CadSketchOperandSignature;
export const CAD_SKETCH_POINT_ON_CURVE_OPERANDS = {
  slots: [{ role: 'Point', accepts: ['point'], refusal: missingPoint('Point on curve needs an existing sketch point.') },
    { role: 'Arc or circle', accepts: ['round'], refusal: { code: 'invalid-sketch-point-on-curve', message: 'Point on curve needs an existing arc or circle.' } }]
} as const satisfies CadSketchOperandSignature;
export const CAD_SKETCH_POINT_LINE_DISTANCE_OPERANDS = {
  slots: [{ role: 'Point', accepts: ['point'], refusal: missingPoint('Point to line distance needs an existing sketch point.') },
    { role: 'Line', accepts: ['line'], refusal: { code: 'invalid-sketch-point-line-distance', message: 'Point to line distance needs an existing straight line.' } }]
} as const satisfies CadSketchOperandSignature;
const symmetricPoint = missingPoint('Symmetry needs two existing sketch points.');
export const CAD_SKETCH_SYMMETRY_OPERANDS = {
  slots: [{ role: 'First point', accepts: ['point'], refusal: symmetricPoint }, { role: 'Second point', accepts: ['point'], refusal: symmetricPoint },
    { role: 'Axis line', accepts: ['line'], refusal: { code: 'invalid-sketch-symmetry', message: 'Symmetry needs an existing straight axis line.' } }],
  unordered: [[0, 1]]
} as const satisfies CadSketchOperandSignature;
const symmetricCurve = { code: 'invalid-sketch-symmetry', message: 'Symmetry needs two existing lines, arcs or circles.' } as const;
/**
 * Two lines, arcs or circles mirrored about a line or an axis. An axis is fixed, so it is never one of the mirrored pair; the parse
 * refuses a pair of two kinds.
 */
export const CAD_SKETCH_CURVE_SYMMETRY_OPERANDS = {
  slots: [{ role: 'First curve', accepts: ['line', 'arc', 'circle'], needs: ['movable'], refusal: symmetricCurve },
    { role: 'Second curve', accepts: ['line', 'arc', 'circle'], needs: ['movable'], refusal: symmetricCurve },
    { role: 'Axis line', accepts: ['line'], refusal: { code: 'invalid-sketch-symmetry', message: 'Symmetry needs an existing straight axis line.' } }],
  unordered: [[0, 1]], distinct: { slots: [0, 1, 2], refusal: { code: 'invalid-sketch-symmetry', message: 'Symmetry needs two distinct curves and a separate line to mirror about.' } }
} as const satisfies CadSketchOperandSignature;
/** An angle's two lines, each with the end its ray points toward. */
export const CAD_SKETCH_ANGLE_OPERANDS = {
  slots: [{ role: 'First line', accepts: ['line'], refusal: linePairRefusal }, { role: 'First ray end', accepts: ['point'], end: true },
    { role: 'Second line', accepts: ['line'], refusal: linePairRefusal }, { role: 'Second ray end', accepts: ['point'], end: true }],
  distinct: { slots: [0, 2], refusal: linePairRefusal }
} as const satisfies CadSketchOperandSignature;
