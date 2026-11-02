import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { CadIdentifierSchema, CadLabelSchema, CadPoint2Schema, CadScalarSchema } from './cadPrimitives';
import { cadImportDataFields, isCadImportData } from './cadImportData';
import { CadError } from './cadError';
import { evaluateCadScalar } from './cadExpression';
import { cadPathClosureTolerance } from './cadAnalyticSegments';
import { cadSketchEntityPointIds, cadSketchRelationPointIds } from './cadSketchGraphReferences';
import { cadSketchFixedComponents } from './cadSketchFixedComponents';
import { deepFreezeCadData } from './cadDeepFreeze';
import { cadSketchRelationsEqualButPlacement } from './cadSketchPlacedDimensions';
import { cadSketchRelationDefinition, checkCadSketchRelationOperands } from './sketch-relations/cadSketchRelationRegistry';
import { CAD_PRECISION } from '@/domain/precision/cadPrecision';
import { cadSketchCanonicalForm, cadSketchCanonicalRefusal } from './sketch-relations/cadSketchCanonicalForms';
import { CAD_SKETCH_ELEMENT_ID_PATTERN, CadSketchPositions, isCadSketchReservedId } from './sketch-relations/cadSketchVirtualElements';
import { CAD_SKETCH_GENERATOR_PREFIX_PATTERN, CadSketchGeneratorGeometrySchema } from './sketch-generators/cadSketchGeneratorSchema';

const strict = { additionalProperties: false };
const id = CadIdentifierSchema;
/** An id a relation names: a stored point or edge, or the origin or an axis by its reserved id. */
const ref = Type.String({ pattern: CAD_SKETCH_ELEMENT_ID_PATTERN }), refPair = Type.Tuple([ref, ref]);
const entity = { id, construction: Type.Boolean() };
const angleRay = Type.Object({ lineId: ref, towardPointId: ref }, strict);
const tangentEndpoint = Type.Object({ entityId: ref, pointId: ref }, strict);
/**
 * Where a dimension is drawn, in sketch millimetres relative to the geometry it measures, so it follows that geometry. Display only:
 * no solver, analysis or output reads it, and a dimension without one is laid out automatically.
 * `offset` is the dimension line's signed distance from its baseline and `along` the text's place along it, 0.5 centred and outside
 * [0, 1] beyond the extension lines. An angle's `radius` is its arc's distance from the vertex and `along` the text's fraction of the
 * sweep. A radius or diameter's `angle` is its leader's direction in sketch radians and `distance` its text's distance from the centre.
 */
const placementOffset = Type.Number({ minimum: -CAD_PRECISION.modelExtentMm, maximum: CAD_PRECISION.modelExtentMm }), placementAlong = Type.Number({ minimum: -1e4, maximum: 1e4 });
const linearPlacement = { offset: placementOffset, along: placementAlong };
const linearAnnotation = Type.Object({ kind: Type.Literal('linear'), ...linearPlacement }, strict);
const angleAnnotation = Type.Object({ kind: Type.Literal('angle'), radius: Type.Number({ exclusiveMinimum: 0, maximum: CAD_PRECISION.modelExtentMm }), along: placementAlong }, strict);
const radialAnnotation = Type.Object({ kind: Type.Literal('radial'), angle: Type.Number({ minimum: -Math.PI, maximum: Math.PI }), distance: Type.Number({ minimum: 0, maximum: CAD_PRECISION.modelExtentMm }) }, strict);
/** A chamfer's two setbacks, each placed or, when null, laid out automatically. */
const setbacksAnnotation = Type.Object({ kind: Type.Literal('setbacks'), sides: Type.Tuple([Type.Union([Type.Object(linearPlacement, strict), Type.Null()]),
  Type.Union([Type.Object(linearPlacement, strict), Type.Null()])]) }, strict);
/** A reference's variant must fit its measurement; parsing checks that. An angle's leader across near-parallel lines takes the linear variant. */
const annotations = {
  linear: { annotation: Type.Optional(linearAnnotation) }, radial: { annotation: Type.Optional(radialAnnotation) },
  angle: { annotation: Type.Optional(Type.Union([angleAnnotation, linearAnnotation])) }, setbacks: { annotation: Type.Optional(setbacksAnnotation) },
  reference: { annotation: Type.Optional(Type.Union([linearAnnotation, radialAnnotation])) }
};
export const CadSketchDimensionAnnotationSchema = Type.Union([linearAnnotation, angleAnnotation, radialAnnotation, setbacksAnnotation]);
/**
 * Geometry a generator makes from its inputs and keeps: points, edges and relations with ids `<idPrefix>_<key>`. Only the record is stored;
 * a document's parse regenerates the rest (see `expandCadSketchGenerators`). Its optional name is what people called the shape, as a
 * profile's name was.
 */
export const CadSketchGeneratorSchema = Type.Object({ id, kind: Type.Literal('generator'), idPrefix: Type.String({ pattern: CAD_SKETCH_GENERATOR_PREFIX_PATTERN }),
  name: Type.Optional(CadLabelSchema), construction: Type.Boolean(), geometry: CadSketchGeneratorGeometrySchema }, strict);
export const CadSketchGraphSchema = Type.Object({
  points: Type.Array(Type.Object({ id, position: CadPoint2Schema }, strict)),
  entities: Type.Array(Type.Union([
    Type.Object({ ...entity, kind: Type.Literal('line'), startPointId: id, endPointId: id }, strict),
    Type.Object({ ...entity, kind: Type.Literal('arc'), centerPointId: id, startPointId: id, endPointId: id,
      direction: Type.Union([Type.Literal('cw'), Type.Literal('ccw')]) }, strict),
    Type.Object({ ...entity, kind: Type.Literal('circle'), centerPointId: id, radius: CadScalarSchema }, strict)
  ])),
  relations: Type.Array(Type.Union([
    Type.Object({ id, kind: Type.Literal('linear-pattern'), seed: Type.Object({ kind: Type.Literal('circle'), entityId: ref, centerPointId: ref }, strict),
      idPrefix: Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' }), direction: Type.Union((['+x', '-x', '+y', '-y'] as const).map(direction => Type.Literal(direction))),
      count: Type.Integer({ minimum: 1, maximum: 32 }), spacing: CadScalarSchema,
      omittedInstances: Type.Array(Type.Integer({ minimum: 1, maximum: 31 }), { uniqueItems: true, maxItems: 31 }) }, strict),
    Type.Object({ id, kind: Type.Literal('reference-dimension'), measurement: Type.Union([
      Type.Object({ kind: Type.Literal('line-length'), entityId: ref }, strict),
      Type.Object({ kind: Type.Literal('point-distance'), pointIds: refPair }, strict),
      Type.Object({ kind: Type.Literal('point-line-distance'), pointId: ref, lineId: ref }, strict),
      Type.Object({ kind: Type.Literal('radial-size'), entityId: ref, quantity: Type.Union([Type.Literal('radius'), Type.Literal('diameter')]) }, strict)
    ]), ...annotations.reference }, strict),
    Type.Object({ id, kind: Type.Literal('external-reference'), entityId: id, sourceSketchId: id, source: Type.Union([
      Type.Object({ kind: Type.Literal('line'), entityId: id, startPointId: id, endPointId: id }, strict),
      Type.Object({ kind: Type.Literal('circle'), entityId: id, centerPointId: id }, strict)
    ]) }, strict),
    ...(['coincident', 'horizontal', 'vertical'] as const).map(kind => Type.Object({ id, kind: Type.Literal(kind), pointIds: refPair }, strict)),
    Type.Object({ id, kind: Type.Literal('parallel'), lineIds: refPair }, strict),
    Type.Object({ id, kind: Type.Literal('perpendicular'), lineIds: refPair }, strict),
    Type.Object({ id, kind: Type.Literal('collinear'), lineIds: refPair }, strict),
    Type.Object({ id, kind: Type.Literal('midpoint'), pointId: ref, lineId: ref }, strict),
    Type.Object({ id, kind: Type.Literal('point-on-line'), pointId: ref, lineId: ref }, strict),
    Type.Object({ id, kind: Type.Literal('point-on-curve'), pointId: ref, curveId: ref }, strict),
    Type.Object({ id, kind: Type.Literal('tangent-joint'), endpoints: Type.Tuple([tangentEndpoint, tangentEndpoint]) }, strict),
    // An arc or circle touching an axis, on either side of it.
    Type.Object({ id, kind: Type.Literal('tangent'), curveIds: refPair }, strict),
    // Two points, or two lines, arcs or circles, mirrored about a line or an axis. Mirrored curves store no pairing of their points:
    // it is read from their ends' identities, the arcs' directions and the geometry before an edit.
    Type.Object({ id, kind: Type.Literal('symmetric'), pointIds: refPair, lineId: ref }, strict),
    Type.Object({ id, kind: Type.Literal('symmetric'), curveIds: refPair, lineId: ref }, strict),
    Type.Object({ id, kind: Type.Literal('equal-length'), lineIds: refPair }, strict),
    Type.Object({ id, kind: Type.Literal('equal-radius'), curveIds: refPair }, strict),
    Type.Object({ id, kind: Type.Literal('line-angle'), rays: Type.Tuple([angleRay, angleRay]), sense: Type.Union([Type.Literal('cw'), Type.Literal('ccw')]), value: CadScalarSchema, ...annotations.angle }, strict),
    Type.Object({ id, kind: Type.Literal('radial-size'), entityId: ref, quantity: Type.Union([Type.Literal('radius'), Type.Literal('diameter')]), value: CadScalarSchema, ...annotations.radial }, strict),
    Type.Object({ id, kind: Type.Literal('fixed-point'), pointId: ref, position: CadPoint2Schema }, strict),
    Type.Object({ id, kind: Type.Literal('fixed-axis'), pointId: ref, axis: Type.Union([Type.Literal('x'), Type.Literal('y')]), value: CadScalarSchema, ...annotations.linear }, strict),
    Type.Object({ id, kind: Type.Literal('distance'), pointIds: refPair, value: CadScalarSchema, ...annotations.linear }, strict),
    // The side is seen from the line's start looking toward its end.
    Type.Object({ id, kind: Type.Literal('point-line-distance'), pointId: ref, lineId: ref, side: Type.Union([Type.Literal('left'), Type.Literal('right')]), value: CadScalarSchema, ...annotations.linear }, strict),
    Type.Object({ id, kind: Type.Literal('axis-distance'), pointIds: refPair, axis: Type.Union([Type.Literal('x'), Type.Literal('y')]), value: CadScalarSchema, ...annotations.linear }, strict),
    Type.Object({ id, kind: Type.Literal('fillet-corner'), pointId: ref, lineIds: refPair, arcId: id, value: CadScalarSchema, ...annotations.radial }, strict),
    Type.Object({ id, kind: Type.Literal('chamfer-corner'), pointId: ref, lineIds: refPair, chamferId: id, values: Type.Tuple([CadScalarSchema, CadScalarSchema]), ...annotations.setbacks }, strict),
    CadSketchGeneratorSchema
  ]))
}, strict);
type Immutable<T> = { readonly [K in keyof T]: Immutable<T[K]> };
export type CadSketchGraph = Immutable<Static<typeof CadSketchGraphSchema>>;
export type CadSketchGraphPoint = CadSketchGraph['points'][number];
export type CadSketchGraphEntity = CadSketchGraph['entities'][number];
export type CadSketchGraphRelation = CadSketchGraph['relations'][number];
export type CadSketchLinearPattern = Extract<CadSketchGraphRelation, { kind: 'linear-pattern' }>;
export type CadSketchGenerator = Extract<CadSketchGraphRelation, { kind: 'generator' }>;
export type CadSketchGeneratorGeometry = CadSketchGenerator['geometry'];
export type CadSketchReferenceDimension = Extract<CadSketchGraphRelation, { kind: 'reference-dimension' }>;
export type CadSketchExternalReference = Extract<CadSketchGraphRelation, { kind: 'external-reference' }>;
export type CadSketchCornerRelation = Extract<CadSketchGraphRelation, { kind: 'fillet-corner' | 'chamfer-corner' }>;
export type CadSketchLineRelation = Extract<CadSketchGraphRelation, { kind: 'parallel' | 'perpendicular' | 'collinear' }>;
export type CadSketchRadialRelation = Extract<CadSketchGraphRelation, { kind: 'radial-size' }>;
export type CadSketchEqualRelation = Extract<CadSketchGraphRelation, { kind: 'equal-length' | 'equal-radius' }>;
export type CadSketchAngleRelation = Extract<CadSketchGraphRelation, { kind: 'line-angle' }>;
export type CadSketchAxisDistanceRelation = Extract<CadSketchGraphRelation, { kind: 'axis-distance' }>;
export type CadSketchMidpointRelation = Extract<CadSketchGraphRelation, { kind: 'midpoint' }>;
export type CadSketchSymmetricRelation = Extract<CadSketchGraphRelation, { kind: 'symmetric' }>;
export type CadSketchSymmetricPointsRelation = Extract<CadSketchSymmetricRelation, { pointIds: unknown }>;
export type CadSketchSymmetricCurvesRelation = Extract<CadSketchSymmetricRelation, { curveIds: unknown }>;
export type CadSketchPointOnLineRelation = Extract<CadSketchGraphRelation, { kind: 'point-on-line' }>;
export type CadSketchPointOnCurveRelation = Extract<CadSketchGraphRelation, { kind: 'point-on-curve' }>;
export type CadSketchPointLineDistanceRelation = Extract<CadSketchGraphRelation, { kind: 'point-line-distance' }>;
export type CadSketchTangentJointRelation = Extract<CadSketchGraphRelation, { kind: 'tangent-joint' }>;
export type CadSketchTangentRelation = Extract<CadSketchGraphRelation, { kind: 'tangent' }>;
export type CadSketchDimensionAnnotation = Immutable<Static<typeof CadSketchDimensionAnnotationSchema>>;
export type CadSketchLinearAnnotation = Extract<CadSketchDimensionAnnotation, { kind: 'linear' }>;
export type CadSketchAngleAnnotation = Extract<CadSketchDimensionAnnotation, { kind: 'angle' }>;
export type CadSketchRadialAnnotation = Extract<CadSketchDimensionAnnotation, { kind: 'radial' }>;
export type CadSketchSetbacksAnnotation = Extract<CadSketchDimensionAnnotation, { kind: 'setbacks' }>;
/** A relation that can carry a placement. */
export type CadSketchAnnotatedRelation = Extract<CadSketchGraphRelation, { annotation?: unknown }>;
const issueCodes = ['invalid-expression', 'invalid-coordinate', 'degenerate-entity', 'invalid-radius', 'arc-radius-mismatch', 'invalid-distance', 'relation-residual'] as const;
export const CadSketchGraphIssueSchema = Type.Object({
  source: Type.Object({ kind: Type.Union([Type.Literal('point'), Type.Literal('entity'), Type.Literal('relation')]), id }, strict),
  code: Type.Union(issueCodes.map(code => Type.Literal(code))),
  message: Type.String(), residualMm: Type.Optional(Type.Number({ minimum: 0 }))
}, strict);
export type CadSketchGraphIssue = Immutable<Static<typeof CadSketchGraphIssueSchema>>;


// Only this parser's detached, deeply frozen successful outputs are trusted; parsing one again
// returns it as it is. Copies, structured clones and proxies cross the full boundary. Validity
// depends on structure, identities, number-vs-string scalars and each number's schema range,
// never on how numeric values relate, so a solved copy with in-range numbers stays valid.
const acceptedGraphs = new WeakSet<CadSketchGraph>();

// A graph from `cadSketchGraphWithPlacements`, mapped to the first accepted graph of its line of dimension moves.
const placementSources = new WeakMap<CadSketchGraph, CadSketchGraph>();

/**
 * The accepted graph `graph` was made from by moving dimensions alone, the first of that line, or `graph` itself. It holds the same
 * points, entities and relations apart from where dimensions are drawn, so a result that never reads placement can be computed from
 * it and kept across those moves.
 */
export function cadSketchGraphPlacedFrom(graph: CadSketchGraph): CadSketchGraph {
  return placementSources.get(graph) ?? graph;
}

/** Whether `graph` is one of those trusted outputs, which cannot change, so facts read from it can be kept with it. */
export function isAcceptedCadSketchGraph(graph: CadSketchGraph): boolean {
  return acceptedGraphs.has(graph);
}

/** Parse unsolved intent without solving, changing scalars, or checking geometric residuals. */
export function parseCadSketchGraph(value: unknown): CadSketchGraph {
  if (typeof value === 'object' && value !== null && acceptedGraphs.has(value as CadSketchGraph)) return value as CadSketchGraph;
  return acceptCadSketchGraph(detachCadSketchGraph(value));
}

// Points, edges and relations a sketch generator made. Generation is typed code whose output meets the schema, and it froze each one,
// so they are kept as they are instead of being cloned and checked again each time a graph holding them is parsed. A proxy or copy of
// one is a different object and crosses the full boundary.
const generatedItems = new WeakSet<object>();
/** Freeze and trust a sketch generator's output; only generation calls it, on what it has just made. */
export function trustCadSketchGeneratedItems<T extends object>(items: readonly T[]): readonly T[] {
  for (const item of items) generatedItems.add(deepFreezeCadData(item));
  return Object.freeze(items);
}
const isGenerated = (item: unknown) => typeof item === 'object' && item !== null && generatedItems.has(item);
type Detached = { -readonly [K in keyof CadSketchGraph]: CadSketchGraph[K] extends readonly (infer T)[] ? T[] : CadSketchGraph[K] };

/**
 * The graph detached from `value` and checked against the schema, not yet checked for references or accepted. Generated items are kept as
 * they are; everything else is cloned and checked.
 */
export function detachCadSketchGraph(value: unknown): CadSketchGraph {
  const invalid = () => new CadError('invalid-sketch-graph', 'Sketch graph must contain complete portable point, entity and relation data.');
  // Accessors are refused before cloning reads them; the detached copy is then checked again,
  // since a proxy can change the source between the first walk and the clone.
  if (!isCadImportData(value, isGenerated)) throw invalid();
  const fields = cadImportDataFields(value);
  const lists = fields && [fields.points, fields.entities, fields.relations].map(list => Array.isArray(list) ? Array.from(list as unknown[]) : null);
  if (!fields || !lists || lists.some(list => !list) || !lists.some(list => list!.some(isGenerated))) {
    let graph: CadSketchGraph;
    try { graph = structuredClone(value) as CadSketchGraph; } catch { throw invalid(); }
    if (!isCadImportData(graph)) throw invalid();
    assertNoReservedCadSketchIds(graph);
    if (!Value.Check(CadSketchGraphSchema, graph)) throw invalid();
    return graph;
  }
  const [points, entities, relations] = lists as unknown[][];
  const own = { ...fields, points: points.filter(item => !isGenerated(item)), entities: entities.filter(item => !isGenerated(item)), relations: relations.filter(item => !isGenerated(item)) };
  let copy: Detached;
  try { copy = structuredClone(own) as Detached; } catch { throw invalid(); }
  if (!isCadImportData(copy)) throw invalid();
  assertNoReservedCadSketchIds(copy);
  if (!Value.Check(CadSketchGraphSchema, copy)) throw invalid();
  // Each list in its submitted order, with the generated items where they were.
  const merge = <T>(source: unknown[], cloned: T[]): T[] => { let at = 0; return source.map(item => isGenerated(item) ? item as T : cloned[at++]); };
  return { ...copy, points: merge(points, copy.points), entities: merge(entities, copy.entities), relations: merge(relations, copy.relations) };
}

/**
 * Accept a detached graph: identities, references, operands, canonical forms and placements are checked, then it is frozen. Generated
 * items are checked as everything else is, since what they reference must still be there.
 */
export function acceptCadSketchGraph(graph: CadSketchGraph): CadSketchGraph {
  if (acceptedGraphs.has(graph)) return graph;
  const ids = new Set<string>(), points = new Set(graph.points.map(point => point.id));
  for (const item of [...graph.points, ...graph.entities, ...graph.relations]) {
    if (ids.has(item.id)) throw new CadError('duplicate-sketch-id', `Duplicate sketch graph identity "${item.id}".`);
    ids.add(item.id);
  }
  const references = (owner: string, refs: readonly string[]) => {
    if (new Set(refs).size !== refs.length) throw new CadError('invalid-sketch-reference', `Sketch graph "${owner}" needs distinct point references.`);
    for (const ref of refs) if (!points.has(ref)) throw new CadError('missing-sketch-point', `Sketch graph "${owner}" references missing point "${ref}".`);
  };
  for (const item of graph.entities) references(item.id, cadSketchEntityPointIds(item));
  // The lists are final here: frozen now, the relation checks look operands up by id instead of scanning.
  deepFreezeCadData(graph.points, { skipFrozen: true }); deepFreezeCadData(graph.entities, { skipFrozen: true });
  // Each kind's definition checks its operands: the slots that refuse missing or mistyped ones, then its own checks.
  for (const item of graph.relations) {
    checkCadSketchRelationOperands(graph, item);
    const canonical = cadSketchCanonicalForm(graph, item);
    if (canonical) throw cadSketchCanonicalRefusal(item, canonical);
    assertCadSketchPlacementFits(item);
    references(item.id, cadSketchRelationPointIds(graph, item));
  }
  deepFreezeCadData(graph, { skipFrozen: true });
  acceptedGraphs.add(graph);
  return graph;
}

/**
 * Ids starting with `@` name the origin and the H and V axes, which every sketch has and none stores, so a stored point, edge or relation
 * cannot take one, and an edge cannot end at one. Read before the schema check, which would give no reason, by every reader of stored or
 * submitted sketch data: a graph, a document and the edits that add points, edges or relations. Anything but a graph's lists is left to
 * the schema check.
 */
export function assertNoReservedCadSketchIds(graph: unknown) {
  if (typeof graph !== 'object' || graph === null) return;
  const lists = graph as { readonly points?: unknown; readonly entities?: unknown; readonly relations?: unknown };
  for (const list of [lists.points, lists.entities, lists.relations]) if (Array.isArray(list)) for (const item of list as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    for (const [key, value] of Object.entries(item)) if ((key === 'id' || list === lists.entities && key.endsWith('PointId')) && typeof value === 'string' && isCadSketchReservedId(value)) {
      throw new CadError('reserved-sketch-id', key === 'id' ? `Sketch id "${value}" is reserved: ids starting with "@" name the origin and the H and V axes.`
        : `Sketch edge "${String((item as { id?: unknown }).id)}" cannot end at "${value}": only relations name the origin and the axes.`);
    }
  }
}

/** A placement the schema admits for every relation that has one, but that fits only some of its measurements, is refused. */
function assertCadSketchPlacementFits(relation: CadSketchGraphRelation) {
  if (relation.kind === 'reference-dimension' && relation.annotation && (relation.annotation.kind === 'radial') !== (relation.measurement.kind === 'radial-size'))
    throw new CadError('invalid-sketch-annotation', `Reference dimension "${relation.id}" has a placement for another kind of dimension.`);
}

/**
 * `source` with each of `relations` in place of the relation with its identity, from which it differs only in where it is drawn.
 * Placement takes part in no reference, geometry or solve check, so only the new placements are checked, and every other point,
 * entity and relation is the accepted graph's own frozen data: the result is accepted without parsing it again. Null when a relation is
 * new or changes more than its placement, which needs the full parse; `source` itself when nothing changes.
 */
export function cadSketchGraphWithPlacements(source: CadSketchGraph, relations: readonly unknown[]): CadSketchGraph | null {
  const graph = parseCadSketchGraph(source);
  const invalid = () => new CadError('invalid-sketch-graph', 'Sketch relations must contain complete portable relation data.');
  if (!isCadImportData(relations) || !Array.isArray(relations)) throw invalid();
  let copies: unknown[];
  try { copies = structuredClone(relations) as unknown[]; } catch { throw invalid(); }
  if (!isCadImportData(copies) || !copies.every(relation => Value.Check(CadSketchGraphSchema.properties.relations.items, relation))) throw invalid();
  const next = [...graph.relations];
  let changed = false;
  for (const relation of copies as CadSketchGraphRelation[]) {
    const index = next.findIndex(item => item.id === relation.id);
    if (index < 0 || !cadSketchRelationsEqualButPlacement(next[index], relation)) return null;
    if (Value.Equal(next[index], relation)) continue;
    assertCadSketchPlacementFits(relation);
    next[index] = deepFreezeCadData(relation); changed = true;
  }
  if (!changed) return graph;
  const placed: CadSketchGraph = Object.freeze({ ...graph, relations: Object.freeze(next) });
  acceptedGraphs.add(placed); placementSources.set(placed, cadSketchGraphPlacedFrom(graph));
  return placed;
}

/** Changes whenever `cadSketchSolvedSlots` orders or selects values differently; a reply must carry it. */
export const CAD_SKETCH_SOLVED_LAYOUT_VERSION = 1;
export type CadSketchSolvedSlot = { readonly kind: 'point'; readonly index: number; readonly axis: 0 | 1 } | { readonly kind: 'radius'; readonly index: number };

/**
 * The numbers a solver writes, in this order: each point's numeric x then y, in point order, then
 * each circle's numeric radius, in entity order. Expressions, external-reference snapshots and generated members stay fixed.
 */
export function cadSketchSolvedSlots(graph: CadSketchGraph): readonly CadSketchSolvedSlot[] {
  const owned = cadSketchFixedComponents(graph), slots: CadSketchSolvedSlot[] = [];
  graph.points.forEach((point, index) => {
    if (owned.pointIds.has(point.id)) return;
    for (const axis of [0, 1] as const) if (typeof point.position[axis] === 'number') slots.push({ kind: 'point', index, axis });
  });
  graph.entities.forEach((entity, index) => {
    if (entity.kind === 'circle' && typeof entity.radius === 'number' && !owned.circleIds.has(entity.id)) slots.push({ kind: 'radius', index });
  });
  return slots;
}

export function cadSketchSolvedValues(graph: CadSketchGraph): number[] {
  return cadSketchSolvedSlots(graph).map(slot => {
    const value = slot.kind === 'point' ? graph.points[slot.index].position[slot.axis] : (graph.entities[slot.index] as { readonly radius: number | string }).radius;
    if (typeof value !== 'number') throw new Error('A solved sketch slot is not numeric.');
    return value;
  });
}

/**
 * `graph` with its solved slots replaced by `values`, which must be a dense array of one finite
 * number within the scalar range per slot. Everything else, including each unchanged point and
 * circle, is the accepted graph's own frozen data, so the result is accepted without parsing it.
 * Callers check first that the solver kept the fixed values it was given.
 */
export function cadSketchGraphWithSolvedValues(source: CadSketchGraph, values: readonly unknown[]): CadSketchGraph {
  const graph = parseCadSketchGraph(source), slots = cadSketchSolvedSlots(graph);
  const invalid = () => new CadError('invalid-sketch-solution', 'The sketch solution does not match its graph.');
  if (!Array.isArray(values) || values.length !== slots.length) throw invalid();
  const points = [...graph.points], entities = [...graph.entities];
  for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
    // Indexed reads see holes as undefined, which fail here.
    const value: unknown = values[slotIndex], slot = slots[slotIndex];
    if (typeof value !== 'number' || !(Math.abs(value) <= 1e9)) throw invalid();
    if (slot.kind === 'point') {
      const point = points[slot.index];
      if (Object.is(point.position[slot.axis], value)) continue;
      const position: [number | string, number | string] = [point.position[0], point.position[1]];
      position[slot.axis] = value;
      points[slot.index] = Object.freeze({ ...point, position: Object.freeze(position) });
    } else {
      const circle = entities[slot.index] as Extract<CadSketchGraph['entities'][number], { kind: 'circle' }>;
      if (!Object.is(circle.radius, value)) entities[slot.index] = Object.freeze({ ...circle, radius: value });
    }
  }
  const solved: CadSketchGraph = Object.freeze({ ...graph, points: Object.freeze(points), entities: Object.freeze(entities) });
  acceptedGraphs.add(solved);
  return solved;
}

/** Nonrepairing acceptance check. Empty issues means current numeric geometry and relations agree. */
export function checkCadSketchGraph(graph: CadSketchGraph, parameters: Readonly<Record<string, number>>): readonly CadSketchGraphIssue[] {
  const issues: CadSketchGraphIssue[] = [], points = new CadSketchPositions();
  const scalar = (value: number | string) => evaluateCadScalar(value, parameters);
  const report = (source: CadSketchGraphIssue['source'], code: CadSketchGraphIssue['code'], message: string, residualMm?: number) => {
    issues.push({ source, code, message, ...(residualMm === undefined ? {} : { residualMm }) });
  };
  for (const point of graph.points) {
    const source = { kind: 'point', id: point.id } as const;
    try {
      const x = scalar(point.position[0]), y = scalar(point.position[1]);
      if (Math.abs(x) > 1e9 || Math.abs(y) > 1e9) report(source, 'invalid-coordinate', 'Sketch point exceeds the supported coordinate range.');
      else points.set(point.id, { x, y });
    } catch (error) { report(source, 'invalid-expression', error instanceof Error ? error.message : 'Invalid point expression.'); }
  }
  for (const item of graph.entities) {
    const source = { kind: 'entity', id: item.id } as const;
    try {
      if (item.kind === 'circle') {
        const radius = scalar(item.radius);
        if (radius <= CAD_PRECISION.minimumLengthMm || radius > CAD_PRECISION.modelExtentMm) report(source, 'invalid-radius', 'Circle radius must be positive and within one million millimetres.');
        continue;
      }
      const start = points.get(item.startPointId), end = points.get(item.endPointId);
      if (!start || !end) continue;
      if (Math.hypot(start.x - end.x, start.y - end.y) <= CAD_PRECISION.minimumLengthMm) {
        report(source, 'degenerate-entity', 'A line or endpoint arc needs distinct endpoints; use a circle for a full turn.'); continue;
      }
      if (item.kind === 'arc') {
        const center = points.get(item.centerPointId); if (!center) continue;
        const radius = Math.hypot(start.x - center.x, start.y - center.y), other = Math.hypot(end.x - center.x, end.y - center.y);
        if (radius <= CAD_PRECISION.minimumLengthMm || radius > CAD_PRECISION.modelExtentMm) report(source, 'invalid-radius', 'Arc radius must be positive and within one million millimetres.');
        const residual = Math.abs(radius - other);
        if (residual > cadPathClosureTolerance([center, start, end])) report(source, 'arc-radius-mismatch', 'Arc endpoints must share their declared center and radius.', residual);
      }
    } catch (error) { report(source, 'invalid-expression', error instanceof Error ? error.message : 'Invalid entity expression.'); }
  }
  // Each relation's definition checks it. Cross-feature authority, such as a linked reference's source, is checked by the document parser.
  for (const relation of graph.relations) {
    const source = { kind: 'relation', id: relation.id } as const;
    try {
      issues.push(...cadSketchRelationDefinition(relation).check(graph, relation, points, parameters));
    } catch (error) { report(source, 'invalid-expression', error instanceof Error ? error.message : 'Invalid relation expression.'); }
  }
  deepFreezeCadData(issues);
  return issues;
}
