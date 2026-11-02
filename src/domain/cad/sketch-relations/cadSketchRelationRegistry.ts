import type { CadScalar } from '../cadDocument';
import { isAcceptedCadSketchGraph, type CadSketchGraph, type CadSketchGraphRelation } from '../cadSketchGraph';
import { cadSketchCanonicalForm, cadSketchCanonicalRelations } from './cadSketchCanonicalForms';
import { isCadSketchPointSlot, resolveCadSketchOperands } from './cadSketchOperandSignatures';
import type { CadSketchOperandNames, CadSketchOperandSignature, CadSketchRelationDefinition, CadSketchRelationDefinitions, CadSketchRelationIntent, CadSketchRelationKind } from './cadSketchRelationTypes';
import { chamferCorner, externalReference, filletCorner, generator, linearPattern } from './kinds/composites';
import { axisDistance, distance, fixedAxis, lineAngle, pointLineDistance, radialSize, referenceDimension } from './kinds/dimensions';
import { equalLength, equalRadius } from './kinds/equality';
import { fixedPoint } from './kinds/fix';
import { coincident, midpoint, pointOnCurve, pointOnLine, symmetric, tangent, tangentJoint } from './kinds/incidence';
import { collinear, horizontal, parallel, perpendicular, vertical } from './kinds/orientation';

/**
 * Every relation kind's definition, in the order the sketch graph schema lists the kinds. The graph module loads this one, so the order is
 * written here rather than read from the schema, and a test keeps the two the same.
 */
export const CAD_SKETCH_RELATION_DEFINITIONS: CadSketchRelationDefinitions = Object.freeze({
  'linear-pattern': linearPattern, 'reference-dimension': referenceDimension, 'external-reference': externalReference,
  coincident, horizontal, vertical, parallel, perpendicular, collinear,
  midpoint, 'point-on-line': pointOnLine, 'point-on-curve': pointOnCurve, 'tangent-joint': tangentJoint, tangent, symmetric,
  'equal-length': equalLength, 'equal-radius': equalRadius,
  'line-angle': lineAngle, 'radial-size': radialSize, 'fixed-point': fixedPoint, 'fixed-axis': fixedAxis,
  distance, 'point-line-distance': pointLineDistance, 'axis-distance': axisDistance,
  'fillet-corner': filletCorner, 'chamfer-corner': chamferCorner, generator
} satisfies CadSketchRelationDefinitions);
export const CAD_SKETCH_RELATION_KINDS = Object.freeze(Object.keys(CAD_SKETCH_RELATION_DEFINITIONS) as CadSketchRelationKind[]);
/** The kinds agent tools may name, in schema order. */
export const CAD_SKETCH_AGENT_RELATION_KINDS = Object.freeze(CAD_SKETCH_RELATION_KINDS.filter(kind => CAD_SKETCH_RELATION_DEFINITIONS[kind].agent.exposed));

/** A definition read for a relation of any kind: each kind's own definition takes only relations of that kind, which the lookup guarantees. */
type Definition = CadSketchRelationDefinition<CadSketchRelationKind>;
export function cadSketchRelationDefinition(relation: Pick<CadSketchGraphRelation, 'kind'>): Definition {
  return CAD_SKETCH_RELATION_DEFINITIONS[relation.kind] as unknown as Definition;
}
/** The stored operand slots of one relation. */
export function cadSketchRelationSignature(relation: CadSketchGraphRelation): CadSketchOperandSignature {
  const { stored } = cadSketchRelationDefinition(relation);
  return typeof stored === 'function' ? stored(relation) : stored;
}

// Each signature's point and edge slots, indexed once: signatures are shared constants.
interface SlotIndexes { readonly points: readonly number[]; readonly entities: readonly number[] }
const slotIndexes = new WeakMap<CadSketchOperandSignature, SlotIndexes>();
/** The slots that reference a point of their own, apart from `end` points, and the slots that name an edge, in slot order. */
export function cadSketchSignatureSlots(signature: CadSketchOperandSignature): SlotIndexes {
  let indexes = slotIndexes.get(signature);
  if (!indexes) {
    const points: number[] = [], entities: number[] = [];
    signature.slots.forEach((slot, index) => { if (!isCadSketchPointSlot(slot)) entities.push(index); else if (!slot.end) points.push(index); });
    indexes = Object.freeze({ points: Object.freeze(points), entities: Object.freeze(entities) });
    slotIndexes.set(signature, indexes);
  }
  return indexes;
}

/** Equal for two relations that hold the same thing on the same operands, whatever their stored order or values. */
export function cadSketchRelationKey(relation: CadSketchGraphRelation): string {
  return cadSketchRelationDefinition(relation).key(relation);
}
// Keys of an accepted graph, which cannot change, are read once.
const keyIndexes = new WeakMap<CadSketchGraph, ReadonlyMap<string, readonly string[]>>();
/** Each key of the graph's relations, with the relations that have it in graph order. */
export function cadSketchRelationKeyIndex(graph: CadSketchGraph): ReadonlyMap<string, readonly string[]> {
  const kept = keyIndexes.get(graph);
  if (kept) return kept;
  const index = new Map<string, string[]>();
  for (const relation of graph.relations) {
    const key = cadSketchRelationKey(relation), ids = index.get(key);
    if (ids) ids.push(relation.id); else index.set(key, [relation.id]);
  }
  if (isAcceptedCadSketchGraph(graph)) keyIndexes.set(graph, index);
  return index;
}
const NO_IDS: readonly string[] = Object.freeze([]);
/** A literal by its number, written with or without spaces or zeros; an expression by its text, since no parameters are at hand. */
function sameScalar(a: CadScalar | undefined, b: CadScalar): boolean {
  const number = (value: CadScalar) => typeof value === 'number' ? value : value.trim() === '' ? Number.NaN : Number(value);
  if (a === undefined) return false;
  const [x, y] = [number(a), number(b)];
  return Number.isFinite(x) && Number.isFinite(y) ? x === y : String(a).trim() === String(b).trim();
}
/**
 * The graph's relations that already hold what `relation` holds, in graph order. A relation on the origin or an axis that another kind
 * keeps is held by the relations of that form, when the graph has every one of them at the same value: a coordinate held at 3 does not
 * keep a point on the axis.
 */
export function cadSketchRelationsLike(graph: CadSketchGraph, relation: CadSketchRelationIntent): readonly string[] {
  const index = cadSketchRelationKeyIndex(graph), form = cadSketchCanonicalForm(graph, relation);
  if (!form) return index.get(cadSketchRelationKey(relation as CadSketchGraphRelation)) ?? NO_IDS;
  const byId = new Map(graph.relations.map(stored => [stored.id, stored]));
  const holding = cadSketchCanonicalRelations(form).map(canonical => (index.get(cadSketchRelationKey(canonical as CadSketchGraphRelation)) ?? NO_IDS)
    .filter(id => !('value' in canonical) || sameScalar((byId.get(id) as { readonly value?: CadScalar }).value, canonical.value)));
  if (holding.some(ids => !ids.length)) return NO_IDS;
  const ids = new Set(holding.flat());
  return graph.relations.filter(stored => ids.has(stored.id)).map(stored => stored.id);
}

/** The kind's name for this relation: a radial size names its radius or diameter. */
export function cadSketchRelationKindName(relation: CadSketchGraphRelation): string {
  const definition = cadSketchRelationDefinition(relation);
  return definition.nameOf ? definition.nameOf(relation) : definition.name;
}
/** What an inspection says this relation holds: a Symmetric of curves says what it does to their ends. */
export function cadSketchRelationMeaning(relation: CadSketchGraphRelation): string {
  const definition = cadSketchRelationDefinition(relation);
  return definition.meaningOf ? definition.meaningOf(relation) : definition.agent.meaning;
}
/** The operand labels of a relation's description: its point and edge slots, unless the kind names them its own way. */
export function cadSketchRelationMentions(relation: CadSketchGraphRelation, names: CadSketchOperandNames): readonly string[] {
  const definition = cadSketchRelationDefinition(relation);
  if (definition.mentions) return definition.mentions(relation, names);
  const ids = definition.operands(relation);
  return cadSketchRelationSignature(relation).slots.flatMap((slot, index) => slot.end ? [] : [isCadSketchPointSlot(slot) ? names.point(ids[index]) : names.entity(ids[index])]);
}
/** Whether a description joins the operands with an arrow, from the first to the second. */
export function isCadSketchRelationDirected(relation: CadSketchGraphRelation): boolean {
  return cadSketchRelationDefinition(relation).directed === true;
}

/** The parse checks of one relation's operands: the slots that refuse missing or mistyped operands, then its kind's own checks. */
export function checkCadSketchRelationOperands(graph: CadSketchGraph, relation: CadSketchGraphRelation): void {
  const definition = cadSketchRelationDefinition(relation);
  const operands = resolveCadSketchOperands(graph, cadSketchRelationSignature(relation), definition.operands(relation));
  definition.validate?.(graph, relation, operands);
}
