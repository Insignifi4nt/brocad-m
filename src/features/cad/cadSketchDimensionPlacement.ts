import type { CadSketchGraph, CadSketchGraphRelation, CadSketchReferenceDimension } from '@/domain/cad/cadSketchGraph';
import { evaluateCadScalar } from '@/domain/cad/cadExpression';
import { CadError } from '@/domain/cad/cadError';
import { resolveCadSketchPointIdentities } from '@/domain/cad/cadSketchGraphJoints';
import { cadSketchDriverTolerance } from '@/domain/cad/cadSketchPrecision';
import { createCadSketchLinePairDistance, createCadSketchPointLineDistance } from '@/domain/cad/cadSketchPointLineDistanceRelations';
import { cadSketchLineAngleSectors, createCadSketchLineAngleRelation, type CadSketchLineAngleGeometry } from '@/domain/cad/cadSketchAngleRelations';
import type { Point2 } from '@/domain/path-intel/types';
import { measureCadSketchReferenceDimension } from '@/domain/cad/cadSketchReferenceDimensions';
import { userFacingMessage } from '@/lib/userMessage';
import { cadSketchLinearPatternLockReason } from '@/domain/cad/cadSketchLinearPattern';
import { cadSketchExternalReferenceLockReason } from '@/domain/cad/cadSketchExternalReferences';
import { cadSketchGeneratorLockReason } from '@/domain/cad/sketch-generators/cadSketchGenerators';
import { CAD_SKETCH_NO_REFERENCE_HOLD, cadSketchDistanceForPair, cadSketchMatchingReference, cadSketchPointLineDistanceFor, cadSketchRadialRelationForEntity, cadSketchSameIdentityPair } from './cadSketchDimensionCommands';
import { isCadSketchDimensionRelation } from './cadSketchDimensionSelection';
import type { CadSketchGraphSelection } from './cadSketchGraphSelection';
import { CAD_SKETCH_H_AXIS_ID, CAD_SKETCH_ORIGIN_ID, CAD_SKETCH_V_AXIS_ID, cadSketchAxisNormal, cadSketchVirtualPosition, cadSketchVirtualSubject,
  isCadSketchVirtualAxisId, isCadSketchVirtualSelection, type CadSketchVirtualAxisId } from '@/domain/cad/sketch-relations/cadSketchVirtualElements';

/** One pick of the Dimension tool: a sketch point or edge, the origin as a point, or the H or V axis as an edge. */
export type CadSketchDimensionOperand = CadSketchGraphSelection;

/**
 * What a placed dimension measures. Point pairs, a line's ends, curve centers and a point or center with the origin take `aligned`,
 * `horizontal` or `vertical`; an arc or circle takes `radius` or `diameter`; a point, the origin, an arc or circle with a line, a point,
 * arc or circle with an axis, two parallel lines and a line along an axis take `point-line`; other line pairs, and a line with an axis,
 * take `angle`.
 */
export type CadSketchDimensionForm = 'aligned' | 'horizontal' | 'vertical' | 'radius' | 'diameter' | 'point-line' | 'angle';

/**
 * The measurements of a candidate, and an angle's sectors that the pointer chooses among; nothing in it depends on the pointer, so the plan
 * builds it once per pick. The preview draws the relations a click stores, not this.
 */
export type CadSketchDimensionPreviewSource =
  | { readonly kind: 'pair'; readonly form: 'aligned' | 'horizontal' | 'vertical'; readonly points: readonly [Point2, Point2]; readonly value: number }
  | { readonly kind: 'point-line'; readonly point: Point2; readonly line: readonly [Point2, Point2]; readonly value: number }
  | { readonly kind: 'radial'; readonly quantity: 'radius' | 'diameter'; readonly center: Point2; readonly radius: number; readonly value: number }
  | { readonly kind: 'angle'; readonly sectors: readonly CadSketchDimensionAngleSector[]; readonly fallback: number | null };
export interface CadSketchDimensionAngleSector { readonly relation: Extract<CadSketchGraphRelation, { kind: 'line-angle' }>; readonly geometry: CadSketchLineAngleGeometry }

interface CandidateBase { readonly form: CadSketchDimensionForm; readonly label: string }
/**
 * One dimension the picks can take.
 * - `available` carries the driving relations to add, the dimension first. `implied` names a value-free relation added with it, such as the
 *   Parallel that keeps two lines parallel, which is left out when the sketch already holds it. `reference` is the reference form that
 *   measures the same quantity, or null with `referenceReason`. `reuses` names a relation that already measures this, or part of it, and
 *   stays: one end of a line held from an axis without Horizontal, where `relations` holds only the implied relation that keeps it measuring
 *   the picks. Placing selects what it reuses and adds that is a dimension.
 * - `existing` names the relations that already measure this; placing selects those that are dimensions.
 * - `blocked` says why the picks cannot take this form as a driving dimension. When the reference model still measures the quantity, such as
 *   a zero distance, `reference` and `preview` carry its reference form, which the menu can place.
 */
export type CadSketchDimensionCandidate = CandidateBase & (
  | { readonly state: 'available'; readonly relations: readonly CadSketchGraphRelation[]; readonly implied: string | null; readonly reuses: string | null;
    readonly reference: CadSketchReferenceDimension | null; readonly referenceReason: string | null; readonly preview: CadSketchDimensionPreviewSource }
  | { readonly state: 'existing'; readonly relationIds: readonly string[]; readonly reason: string; readonly preview: CadSketchDimensionPreviewSource | null }
  | { readonly state: 'blocked'; readonly reason: string; readonly reference?: CadSketchReferenceDimension; readonly preview?: CadSketchDimensionPreviewSource });
export type CadSketchAvailableDimension = Extract<CadSketchDimensionCandidate, { state: 'available' }>;

/** The dimensions a set of picks can take; empty while the tool still waits for a pick. */
export interface CadSketchDimensionPlan {
  readonly operands: readonly CadSketchDimensionOperand[];
  readonly candidates: readonly CadSketchDimensionCandidate[];
  /** The two positions whose pointer regions choose `aligned`, `horizontal` or `vertical`; null when the pointer does not choose, as for one line. */
  readonly pair: readonly [Point2, Point2] | null;
  /** The form placed where the pointer does not choose one. */
  readonly defaultForm: CadSketchDimensionForm | null;
  /** The sketch and parameters the plan was made for, which a click's dimensions are placed and previewed in. */
  readonly graph: CadSketchGraph | null;
  readonly parameters: Readonly<Record<string, number>>;
}
export const NO_SKETCH_DIMENSION_PLAN: CadSketchDimensionPlan = Object.freeze({ operands: [], candidates: [], pair: null, defaultForm: null, graph: null, parameters: Object.freeze({}) });

/**
 * The CATIA and SOLIDWORKS rule for a pair of positions, with the pair's bounding box split by its horizontal and vertical extents:
 * - a pointer left or right of the box, within its vertical extent, gives the vertical distance;
 * - a pointer above or below the box, within its horizontal extent, gives the horizontal distance;
 * - a pointer inside the box or diagonally beyond a corner gives the aligned distance.
 * A pair already level or upright, within the driver tolerance, always gives the aligned distance: its horizontal or vertical
 * distance would only repeat it or measure nothing.
 */
export function cadSketchPointPairDimensionForm(a: Point2, b: Point2, pointer: Point2): 'aligned' | 'horizontal' | 'vertical' {
  const tolerance = cadSketchDriverTolerance([a, b]);
  if (Math.abs(b.x - a.x) <= tolerance || Math.abs(b.y - a.y) <= tolerance) return 'aligned';
  const beyondX = pointer.x < Math.min(a.x, b.x) || pointer.x > Math.max(a.x, b.x), beyondY = pointer.y < Math.min(a.y, b.y) || pointer.y > Math.max(a.y, b.y);
  return beyondX && !beyondY ? 'vertical' : beyondY && !beyondX ? 'horizontal' : 'aligned';
}

/** The candidate placed with the pointer at `pointer`, or the default one without a pointer. Point pairs follow the pointer regions. */
export function cadSketchDimensionCandidateAt(plan: CadSketchDimensionPlan, pointer: Point2 | null): CadSketchDimensionCandidate | null {
  if (!plan.candidates.length) return null;
  const form = plan.pair && pointer ? cadSketchPointPairDimensionForm(plan.pair[0], plan.pair[1], pointer) : plan.defaultForm;
  const chosen = plan.candidates.find(candidate => candidate.form === form);
  return chosen && chosen.state !== 'blocked' ? chosen : plan.candidates.find(candidate => candidate.form === plan.defaultForm) ?? plan.candidates[0];
}

/** The angle sector whose opening holds the pointer, or the natural corner the angle takes without one. */
export function cadSketchDimensionAngleSectorAt(source: Extract<CadSketchDimensionPreviewSource, { kind: 'angle' }>, pointer: Point2 | null): CadSketchDimensionAngleSector | null {
  if (pointer && Number.isFinite(pointer.x) && Number.isFinite(pointer.y)) {
    for (const sector of source.sectors) {
      const { vertex, first, signedSweepRadians } = sector.geometry, rx = pointer.x - vertex.x, ry = pointer.y - vertex.y;
      if (Math.hypot(rx, ry) <= cadSketchDriverTolerance([vertex, pointer])) break;
      const raw = Math.atan2(first.direction.x * ry - first.direction.y * rx, first.direction.x * rx + first.direction.y * ry) * (sector.relation.sense === 'ccw' ? 1 : -1);
      const sweep = raw < 0 ? raw + 2 * Math.PI : raw;
      if (sweep > 0 && sweep < Math.abs(signedSweepRadians)) return sector;
    }
  }
  return source.fallback === null ? null : source.sectors[source.fallback] ?? null;
}

/** The relations an available candidate adds with the pointer at `pointer`: an angle measures the sector the pointer is in. */
export function cadSketchDimensionRelationsAt(candidate: CadSketchAvailableDimension, pointer: Point2 | null):
  { readonly relations: readonly CadSketchGraphRelation[]; readonly reason: null } | { readonly relations: null; readonly reason: string } {
  if (candidate.preview.kind !== 'angle') return { relations: candidate.relations, reason: null };
  const sector = cadSketchDimensionAngleSectorAt(candidate.preview, pointer);
  return sector ? { relations: [sector.relation], reason: null } : { relations: null, reason: 'Move the pointer into the angle to measure, then place it.' };
}

/**
 * What a click with the pointer at `pointer` places for `candidate`, the same for its preview and for placing: `added`, the relations
 * it adds, and `moved`, those of the sketch it moves where the pointer puts them. An existing dimension moves; an available one adds its
 * relations and moves the one it reuses; `reference` adds the reference form instead, which a blocked candidate can only place. A
 * reason says why the click places nothing.
 */
export function cadSketchDimensionBatchAt(plan: CadSketchDimensionPlan, candidate: CadSketchDimensionCandidate, pointer: Point2 | null, reference = candidate.state === 'blocked'):
  { readonly added: readonly CadSketchGraphRelation[]; readonly moved: readonly CadSketchGraphRelation[]; readonly reason: null } | { readonly added: null; readonly moved: null; readonly reason: string } {
  const relationsOf = (ids: readonly string[]) => ids.flatMap(id => plan.graph?.relations.find(relation => relation.id === id) ?? []);
  if (candidate.state === 'existing') return { added: [], moved: relationsOf(candidate.relationIds), reason: null };
  if (reference) return candidate.reference ? { added: [candidate.reference], moved: [], reason: null }
    : { added: null, moved: null, reason: candidate.state === 'blocked' ? candidate.reason : candidate.referenceReason ?? 'This dimension has no reference form.' };
  if (candidate.state === 'blocked') return { added: null, moved: null, reason: candidate.reason };
  const { relations, reason } = cadSketchDimensionRelationsAt(candidate, pointer);
  return relations ? { added: relations, moved: candidate.reuses ? relationsOf([candidate.reuses]) : [], reason: null } : { added: null, moved: null, reason: reason! };
}

/** Preparation feedback, as `CadSketchPreparationError` reports it. */
export interface CadSketchDimensionFeedback {
  readonly reason: string;
  readonly subjects: readonly { readonly category: string; readonly source: { readonly kind: string; readonly id: string } }[];
}
/**
 * What a placement does after preparation rejects it.
 * - `without-implied`: the relation added with the dimension is redundant, and not conflicting, so the dimension is placed without it.
 * - `reference`: a driving dimension over-defines the sketch, as redundant or conflicting, so its reference form is placed instead.
 * - null: the rejection stands, with its own reason.
 */
export function cadSketchDimensionRetry(feedback: CadSketchDimensionFeedback | null, attempt: { readonly implied: string | null; readonly reference: boolean; readonly hasReference: boolean }): 'without-implied' | 'reference' | null {
  if (!feedback) return null;
  if (attempt.implied) {
    const subjects = feedback.subjects.filter(subject => subject.source.kind === 'relation' && subject.source.id === attempt.implied);
    if (subjects.some(subject => subject.category === 'redundant' || subject.category === 'partially-redundant') && !subjects.some(subject => subject.category === 'conflicting')) return 'without-implied';
  }
  return !attempt.reference && attempt.hasReference && (feedback.reason === 'redundant' || feedback.reason === 'conflicting') ? 'reference' : null;
}

/** The points and edges the Dimension tool takes next, the origin among the points and the axes among the edges. */
export interface CadSketchDimensionEligibility { readonly entityIds: readonly string[]; readonly pointIds: readonly string[] }
/** The edges and points a dimension may measure at all, and the edges among them that take a size of their own. */
export interface CadSketchDimensionPickTargets { readonly entityIds: readonly string[]; readonly sizedEntityIds: readonly string[]; readonly pointIds: readonly string[] }
/**
 * What the Dimension tool may pick in `graph`. A linear pattern's occurrences keep its spacing and take no dimension. A linked edge
 * follows its source and a generated edge the inputs of its generator, so each anchors a distance or an angle to other geometry, whose free
 * part the solve moves, but takes no size of its own. A circle whose radius follows an expression keeps its size there; its center still
 * takes distances. Driven, generated and linked points anchor a free partner or a passive measurement; a lone point still measures from
 * the origin or an axis.
 */
export function cadSketchDimensionPickTargets(graph: CadSketchGraph): CadSketchDimensionPickTargets {
  const entities = graph.entities.filter(entity => !cadSketchLinearPatternLockReason(graph, { kind: 'entity', id: entity.id }));
  return { entityIds: entities.map(entity => entity.id),
    sizedEntityIds: entities.filter(entity => !cadSketchExternalReferenceLockReason(graph, { kind: 'entity', id: entity.id }) && !cadSketchGeneratorLockReason(graph, entity)
      && !(entity.kind === 'circle' && typeof entity.radius === 'string' && !graph.relations.some(relation => relation.kind === 'radial-size' && relation.entityId === entity.id))).map(entity => entity.id),
    pointIds: graph.points.map(point => point.id) };
}
const NOTHING: CadSketchDimensionEligibility = Object.freeze({ entityIds: [], pointIds: [] });
/**
 * What the next pick may be, from `targets`, the edges and points a dimension may measure at all:
 * - first: any edge or point, the origin or an axis;
 * - after a point: another point, a line it does not end, a curve it is not the center of, the origin or an axis;
 * - after a line: any other edge, the same line again to place its length when it can take one, a point it does not end, the origin or
 *   an axis;
 * - after an arc or circle: any other edge, the same one again to place its size when it can take one, a point other than its center,
 *   the origin or an axis;
 * Edges outside `sizedEntityIds`, such as linked ones, take no size of their own and pair only with other picks.
 * - after the origin or an axis: any point or edge of the sketch, but not the origin or an axis, which are fixed together already. A line
 *   across an axis, or a point or line on it, stays pickable, so the tool can say why it takes no distance;
 * - after two picks: nothing, so a click anywhere places the dimension.
 */
export function cadSketchDimensionPickEligibility(graph: CadSketchGraph, targets: CadSketchDimensionPickTargets,
  operands: readonly CadSketchDimensionOperand[]): CadSketchDimensionEligibility {
  if (operands.length > 1) return NOTHING;
  const first = operands[0];
  const withOrigin = (ids: readonly string[]) => [...ids, CAD_SKETCH_ORIGIN_ID], withAxes = (ids: readonly string[]) => [...ids, CAD_SKETCH_H_AXIS_ID, CAD_SKETCH_V_AXIS_ID];
  if (!first) return { entityIds: withAxes(targets.entityIds), pointIds: withOrigin(targets.pointIds) };
  if (isCadSketchVirtualSelection(first)) return { entityIds: targets.entityIds, pointIds: targets.pointIds };
  const entityOf = (id: string) => graph.entities.find(entity => entity.id === id);
  if (first.kind === 'point') return { entityIds: withAxes(targets.entityIds.filter(id => {
    const entity = entityOf(id);
    return entity?.kind === 'line' ? entity.startPointId !== first.id && entity.endPointId !== first.id : entity?.centerPointId !== first.id;
  })), pointIds: withOrigin(targets.pointIds.filter(id => id !== first.id)) };
  const entity = entityOf(first.id);
  if (!entity) return NOTHING;
  const entityIds = withAxes(targets.entityIds.filter(id => id !== entity.id || targets.sizedEntityIds.includes(id)));
  if (entity.kind === 'line') return { entityIds, pointIds: withOrigin(targets.pointIds.filter(id => id !== entity.startPointId && id !== entity.endPointId)) };
  return { entityIds, pointIds: withOrigin(targets.pointIds.filter(id => id !== entity.centerPointId)) };
}
/** Whether `operand` may follow the picks `eligibility` was made for. */
export function cadSketchDimensionPickAllowed(eligibility: CadSketchDimensionEligibility, operand: CadSketchDimensionOperand): boolean {
  return (operand.kind === 'point' ? eligibility.pointIds : eligibility.entityIds).includes(operand.id);
}
/** Preselected operands the tool can start from, in the order given, or none when they do not form picks it takes. */
export function cadSketchDimensionPreselection(graph: CadSketchGraph, targets: Parameters<typeof cadSketchDimensionPickEligibility>[1], operands: readonly CadSketchDimensionOperand[]): readonly CadSketchDimensionOperand[] {
  if (operands.length > 2) return [];
  // The same edge twice places its own dimension; as a preselection it is one pick.
  return operands.every((operand, index) => cadSketchDimensionPickAllowed(cadSketchDimensionPickEligibility(graph, targets, operands.slice(0, index)), operand)
    && !(index === 1 && operands[0].kind === operand.kind && operands[0].id === operand.id)) ? operands : [];
}

const NO_REFERENCE_PAIR ='A horizontal or vertical distance has no reference form yet.';
const NO_REFERENCE_ANGLE = 'An angle has no reference form yet.';
const NO_REFERENCE_HOLD = CAD_SKETCH_NO_REFERENCE_HOLD;
/** Why placing selects a dimension that already measures the picks instead of adding one. */
export const CAD_SKETCH_DIMENSION_EXISTING_REASON = 'This is already dimensioned. Placing selects that dimension and moves it where the preview shows it.';
const EXISTING = CAD_SKETCH_DIMENSION_EXISTING_REASON;
const REUSED = 'This is already dimensioned. Placing selects that dimension, moves it where the preview shows it and adds the relation that keeps it measuring these picks.';
/**
 * The dimensions `operands` can take, in the Dimension tool's pick rules: one line or sized arc or circle; two points; a point, arc or
 * circle with a line; two lines; a point with an arc or circle, or two of them, by their centers; a point, an arc or circle center or a
 * line with the origin or an axis. The origin is a point and the axes are lines, so they take the dimensions a point or line takes, kept in
 * the form the sketch stores: a distance along an axis from the origin, or from an axis, holds the coordinate it measures. Values are the
 * current measurements, so placing one moves nothing. One line always places its length; its horizontal and vertical distances are
 * candidates the menu names, and only a pair of positions lets the pointer choose among them.
 */
export function planCadSketchDimension(graph: CadSketchGraph, parameters: Readonly<Record<string, number>>, operands: readonly CadSketchDimensionOperand[],
  newId: () => string, sizedEntityIds?: readonly string[]): CadSketchDimensionPlan {
  const at = (pointId: string): Point2 => {
    if (pointId === CAD_SKETCH_ORIGIN_ID) return ORIGIN;
    const point = graph.points.find(item => item.id === pointId);
    if (!point) throw new CadError('missing-sketch-point', 'The picked geometry is no longer available.');
    return { x: evaluateCadScalar(point.position[0], parameters), y: evaluateCadScalar(point.position[1], parameters) };
  };
  const entityOf = (id: string) => graph.entities.find(entity => entity.id === id);
  const axis = operands.find(operand => operand.kind === 'entity' && isCadSketchVirtualAxisId(operand.id))?.id as CadSketchVirtualAxisId | undefined;
  const geometry = operands.filter(operand => !isCadSketchVirtualSelection(operand));
  const lines = geometry.flatMap(operand => { const entity = operand.kind === 'entity' ? entityOf(operand.id) : undefined; return entity?.kind === 'line' ? [entity] : []; });
  const curves = geometry.flatMap(operand => { const entity = operand.kind === 'entity' ? entityOf(operand.id) : undefined; return entity && entity.kind !== 'line' ? [entity] : []; });
  const points = geometry.filter(operand => operand.kind === 'point').map(operand => operand.id);
  if (geometry.length !== lines.length + curves.length + points.length) return NO_SKETCH_DIMENSION_PLAN;
  // The origin and the axes are fixed together, so they take a dimension only with one point or edge of the sketch.
  if (geometry.length < operands.length && (operands.length !== 2 || geometry.length !== 1)) return NO_SKETCH_DIMENSION_PLAN;
  const plan = (candidates: readonly CadSketchDimensionCandidate[], defaultForm: CadSketchDimensionForm, pair: readonly [Point2, Point2] | null = null): CadSketchDimensionPlan =>
    Object.freeze({ operands, candidates, pair, defaultForm, graph, parameters });
  try {
    if (axis) return lines.length ? linePairPlan([lines[0].id, axis]) : plan([pointFromAxis(points[0] ?? curves[0].centerPointId, axis)], 'point-line');
    if (geometry.length === 1 && operands.length === 2) {
      // The origin is a point: a line takes its distance from it, and a point or center the distances of a pair.
      if (lines.length) return plan([pointLine(CAD_SKETCH_ORIGIN_ID, lines[0].id)], 'point-line');
      const own = points[0] ?? curves[0].centerPointId;
      return pairPlan(operands[0].id === CAD_SKETCH_ORIGIN_ID ? [CAD_SKETCH_ORIGIN_ID, own] : [own, CAD_SKETCH_ORIGIN_ID], null, curves.length ? 'center' : 'points');
    }
    if (geometry.length === 1) {
      // An edge that takes no size of its own, such as a linked one, waits for a partner.
      const line = lines[0], curve = curves[0], edge = line ?? curve;
      if (!edge || sizedEntityIds && !sizedEntityIds.includes(edge.id)) return NO_SKETCH_DIMENSION_PLAN;
      return line ? pairPlan([line.startPointId, line.endPointId], line.id, 'points') : radialPlan(curve);
    }
    if (geometry.length !== 2) return NO_SKETCH_DIMENSION_PLAN;
    if (lines.length === 2) return linePairPlan([lines[0].id, lines[1].id]);
    if (lines.length === 1) {
      const pointId = points[0] ?? curves[0].centerPointId;
      return plan([pointLine(pointId, lines[0].id)], 'point-line');
    }
    const pair = [...points, ...curves.map(curve => curve.centerPointId)] as [string, string];
    return pairPlan(pair, null, curves.length === 2 ? 'centers' : curves.length ? 'center' : 'points');
  } catch (cause) {
    return plan([{ form: 'aligned', label: 'Dimension', state: 'blocked', reason: userFacingMessage(cause, 'These picks cannot take a dimension.') }], 'aligned');
  }

  function identityOf() { return resolveCadSketchPointIdentities(graph); }
  /** The reference form of `measurement` when the reference model measures it, which it also does where no driving dimension can, as at zero. */
  function measuredReference(id: string, measurement: CadSketchReferenceDimension['measurement']): CadSketchReferenceDimension | null {
    const reference: CadSketchReferenceDimension = { id, kind: 'reference-dimension', measurement };
    try { return Number.isFinite(measureCadSketchReferenceDimension(graph, parameters, reference)) ? reference : null; } catch { return null; }
  }
  function pairPlan(pointIds: readonly [string, string], lineId: string | null, context: 'points' | 'center' | 'centers'): CadSketchDimensionPlan {
    const a = at(pointIds[0]), b = at(pointIds[1]), identity = identityOf();
    const blockedAll = (reason: string) => plan((['aligned', 'horizontal', 'vertical'] as const).map(form => ({ form, label: pairLabel(form, lineId !== null), state: 'blocked' as const, reason })), 'aligned');
    if (identity(pointIds[0]) === identity(pointIds[1]))
      return blockedAll(context === 'centers' ? 'These curves share a center. Use Concentric to keep them together.' : context === 'center' ? 'This point is the center. Pick another point.' : 'These points are joined, so they have no distance.');
    const tolerance = cadSketchDriverTolerance([a, b]), length = Math.hypot(b.x - a.x, b.y - a.y);
    const measurement = lineId ? { kind: 'line-length', entityId: lineId } as const : { kind: 'point-distance', pointIds: pointIds } as const;
    const fromOrigin = pointIds.indexOf(CAD_SKETCH_ORIGIN_ID);
    if (!(length > tolerance)) {
      // Distinct points at one position have no driving distance, but a reference still measures their zero distance.
      const reason = context === 'centers' ? 'These curves share a center. Use Concentric to keep them together.'
        : fromOrigin >= 0 ? `${context === 'center' ? 'This center' : 'This point'} is at the origin, so it has no distance from it. Use Coincident to keep it there.`
          : 'These points share one position, so they have no distance.';
      const preview = { kind: 'pair', form: 'aligned', points: [a, b], value: length } as const, label = pairLabel('aligned', lineId !== null);
      const existing = cadSketchMatchingReference(graph, measurement), reference = existing ? null : measuredReference(newId(), measurement);
      const aligned: CadSketchDimensionCandidate | null = existing ? { form: 'aligned', label, state: 'existing', relationIds: [existing.id], reason: EXISTING, preview }
        : reference ? { form: 'aligned', label, state: 'blocked', reason, reference, preview } : null;
      const blocked = blockedAll(reason);
      return aligned ? plan([aligned, ...blocked.candidates.slice(1)], 'aligned', lineId ? null : [a, b]) : blocked;
    }
    const aligned = (): CadSketchDimensionCandidate => {
      const label = pairLabel('aligned', lineId !== null), preview = { kind: 'pair', form: 'aligned', points: [a, b], value: length } as const;
      const existing = cadSketchDistanceForPair(graph, pointIds) ?? cadSketchMatchingReference(graph, measurement);
      if (existing) return { form: 'aligned', label, state: 'existing', relationIds: [existing.id], reason: EXISTING, preview };
      const id = newId();
      return { form: 'aligned', label, state: 'available', relations: [{ id, kind: 'distance', pointIds, value: length }], implied: null, reuses: null,
        reference: { id, kind: 'reference-dimension', measurement }, referenceReason: null, preview };
    };
    const axisCandidate = (form: 'horizontal' | 'vertical'): CadSketchDimensionCandidate => {
      const axis = form === 'horizontal' ? 'x' : 'y', label = pairLabel(form, lineId !== null), delta = axis === 'x' ? b.x - a.x : b.y - a.y;
      // The preview runs between the points in the order the distance takes them, so placing keeps its drawing.
      const preview = { kind: 'pair', form, points: (delta >= 0 ? [a, b] : [b, a]) as readonly [Point2, Point2], value: Math.abs(delta) } as const;
      const kept = fromOrigin >= 0 ? keptCoordinate(pointIds[1 - fromOrigin], axis, form, label, preview) : null;
      if (kept) return kept;
      if (!(Math.abs(delta) > tolerance)) return { form, label, state: 'blocked', reason: form === 'horizontal' ? 'These points are upright, so they have no horizontal distance.' : 'These points are level, so they have no vertical distance.' };
      // Along an axis from the origin, a point keeps that coordinate.
      if (fromOrigin >= 0) return coordinateHold(pointIds[1 - fromOrigin], axis, form, label, preview);
      const existing = cadSketchDistanceForPair(graph, pointIds, axis);
      if (existing) return { form, label, state: 'existing', relationIds: [existing.id], reason: EXISTING, preview };
      // The distance runs from the left or lower point, so its value reads positive.
      const ordered: readonly [string, string] = delta >= 0 ? pointIds : [pointIds[1], pointIds[0]];
      return { form, label, state: 'available', relations: [{ id: newId(), kind: 'axis-distance', pointIds: ordered, axis, value: Math.abs(delta) }], implied: null, reuses: null,
        reference: null, referenceReason: NO_REFERENCE_PAIR, preview };
    };
    // One line places its length wherever the pointer is; its projections stay in the menu.
    return plan([aligned(), axisCandidate('horizontal'), axisCandidate('vertical')], 'aligned', lineId ? null : [a, b]);
  }
  function radialPlan(curve: Extract<CadSketchGraph['entities'][number], { kind: 'arc' | 'circle' }>): CadSketchDimensionPlan {
    const center = at(curve.centerPointId);
    const radius = curve.kind === 'circle' ? evaluateCadScalar(curve.radius, parameters) : Math.hypot(at(curve.startPointId).x - center.x, at(curve.startPointId).y - center.y);
    const existing = cadSketchRadialRelationForEntity(graph, curve.id);
    const candidate = (quantity: 'radius' | 'diameter'): CadSketchDimensionCandidate => {
      const label = quantity === 'radius' ? 'Radius' : 'Diameter', value = quantity === 'diameter' ? 2 * radius : radius;
      const preview = { kind: 'radial', quantity, center, radius, value } as const;
      if (!(radius > 0) || !Number.isFinite(radius)) return { form: quantity, label, state: 'blocked', reason: 'This curve has no size to measure.' };
      if (curve.kind === 'circle' && typeof curve.radius === 'string' && !existing) return { form: quantity, label, state: 'blocked', reason: 'The circle radius follows its source expression. Edit that expression instead.' };
      const measurement = { kind: 'radial-size', entityId: curve.id, quantity } as const, reference = cadSketchMatchingReference(graph, measurement);
      if (existing || reference) return { form: quantity, label, state: 'existing', relationIds: [(existing ?? reference)!.id],
        reason: existing && (existing.kind !== 'radial-size' || existing.quantity === quantity) || reference ? EXISTING
          : `This curve already has a ${quantity === 'radius' ? 'diameter' : 'radius'} dimension. Placing selects it and moves it where the preview shows it.`, preview };
      const id = newId();
      return { form: quantity, label, state: 'available', relations: [{ id, kind: 'radial-size', entityId: curve.id, quantity, value }], implied: null, reuses: null,
        reference: { id, kind: 'reference-dimension', measurement }, referenceReason: null, preview };
    };
    return plan([candidate('radius'), candidate('diameter')], curve.kind === 'circle' ? 'diameter' : 'radius');
  }
  function pointLine(pointId: string, lineId: string, label = 'Distance'): CadSketchDimensionCandidate {
    const line = entityOf(lineId);
    if (line?.kind !== 'line') throw new CadError('missing-sketch-line', 'The picked line is no longer available.');
    const point = at(pointId), preview = { kind: 'point-line', point, line: [at(line.startPointId), at(line.endPointId)] as const, value: 0 } as const;
    const measurement = { kind: 'point-line-distance', pointId, lineId } as const;
    const existing = cadSketchPointLineDistanceFor(graph, { pointId, lineId }) ?? cadSketchMatchingReference(graph, measurement);
    try {
      const relation = createCadSketchPointLineDistance({ graph, parameters, pointId, lineId, relationId: newId() });
      if (existing) return { form: 'point-line', label, state: 'existing', relationIds: [existing.id], reason: EXISTING, preview: { ...preview, value: relation.value as number } };
      return { form: 'point-line', label, state: 'available', relations: [relation], implied: null, reuses: null,
        reference: { id: relation.id, kind: 'reference-dimension', measurement }, referenceReason: null, preview: { ...preview, value: relation.value as number } };
    } catch (cause) {
      // A point on the line has no driving distance, but a reference still measures its zero distance.
      const reason = userFacingMessage(cause, 'This point and line cannot take a distance.');
      const reference = measuredReference(existing?.id ?? newId(), measurement);
      if (!reference) return { form: 'point-line', label, state: 'blocked', reason };
      const measured = { ...preview, value: measureCadSketchReferenceDimension(graph, parameters, reference) };
      return existing ? { form: 'point-line', label, state: 'existing', relationIds: [existing.id], reason: EXISTING, preview: measured }
        : { form: 'point-line', label, state: 'blocked', reason, reference, preview: measured };
    }
  }
  /** Two lines, or a line and an axis, which the sketch keeps level or upright where it keeps them parallel or square. */
  function linePairPlan(lineIds: readonly [string, string]): CadSketchDimensionPlan {
    const axisId = isCadSketchVirtualAxisId(lineIds[1]) ? lineIds[1] : null, line = entityOf(lineIds[0]);
    const ends = axisId && line?.kind === 'line' ? [line.startPointId, line.endPointId] as const : null, identity = identityOf();
    const orientation = ends ? graph.relations.find(relation => (relation.kind === 'horizontal' || relation.kind === 'vertical') && cadSketchSameIdentityPair(identity, relation.pointIds, ends))
      : graph.relations.find(relation => (relation.kind === 'parallel' || relation.kind === 'perpendicular' || relation.kind === 'collinear')
        && relation.lineIds.includes(lineIds[0]) && relation.lineIds.includes(lineIds[1]));
    let distance: CadSketchDimensionCandidate;
    let parallel = false;
    if (axisId) ({ distance, along: parallel } = lineFromAxis(lineIds[0], axisId));
    else try {
      const created = createCadSketchLinePairDistance({ graph, parameters, lineIds, relationId: newId() });
      if (!created) distance = { form: 'point-line', label: 'Distance', state: 'blocked', reason: 'These lines are not parallel, so they take an angle. Pick a point and a line for a distance.' };
      else {
        parallel = created.parallel;
        const relation = created.relation, measurement = { kind: 'point-line-distance', pointId: relation.pointId, lineId: relation.lineId } as const;
        const first = entityOf(relation.lineId);
        const preview = { kind: 'point-line', point: at(relation.pointId), line: first?.kind === 'line' ? [at(first.startPointId), at(first.endPointId)] as const : [at(relation.pointId), at(relation.pointId)] as const, value: relation.value as number } as const;
        // An existing distance from either line to an end of the other already measures this gap.
        const identity = identityOf(), ends = (line: ReturnType<typeof entityOf>) => line?.kind === 'line' ? [line.startPointId, line.endPointId].map(identity) : [];
        const driver = graph.relations.find(item => item.kind === 'point-line-distance' && (item.lineId === lineIds[0] && ends(entityOf(lineIds[1])).includes(identity(item.pointId))
          || item.lineId === lineIds[1] && ends(entityOf(lineIds[0])).includes(identity(item.pointId))));
        const existing = driver ?? cadSketchMatchingReference(graph, measurement);
        // That distance holds one end of the other line, so it keeps the gap only while Parallel or Collinear keeps the lines parallel.
        const oriented = graph.relations.some(item => (item.kind === 'parallel' || item.kind === 'collinear') && item.lineIds.includes(lineIds[0]) && item.lineIds.includes(lineIds[1]));
        const implied = created.parallel && !oriented && (driver || !existing) ? { id: newId(), kind: 'parallel' as const, lineIds } : null;
        if (driver && implied) distance = { form: 'point-line', label: 'Distance', state: 'available', relations: [implied], implied: implied.id, reuses: driver.id,
          reference: null, referenceReason: REUSED, preview };
        else if (existing) distance = { form: 'point-line', label: 'Distance', state: 'existing', relationIds: [existing.id], reason: EXISTING, preview };
        else distance = { form: 'point-line', label: 'Distance', state: 'available', relations: implied ? [relation, implied] : [relation], implied: implied?.id ?? null, reuses: null,
          reference: { id: relation.id, kind: 'reference-dimension', measurement }, referenceReason: null, preview };
      }
    } catch (cause) { distance = { form: 'point-line', label: 'Distance', state: 'blocked', reason: userFacingMessage(cause, 'These lines cannot take a distance.') }; }
    let angle: CadSketchDimensionCandidate;
    const existingAngle = graph.relations.find(relation => relation.kind === 'line-angle' && relation.rays.some(ray => ray.lineId === lineIds[0]) && relation.rays.some(ray => ray.lineId === lineIds[1]));
    const anglePreview = () => {
      const relationId = newId(), sectors = cadSketchLineAngleSectors({ graph, parameters, lineIds, relationId });
      let natural: string | null = null;
      try { natural = JSON.stringify(createCadSketchLineAngleRelation({ graph, parameters, lineIds, relationId }).rays); }
      catch (cause) { if (!(cause instanceof CadError && cause.code === 'ambiguous-sketch-angle-sector')) throw cause; }
      const fallback = natural === null ? null : sectors.findIndex(sector => JSON.stringify(sector.relation.rays) === natural);
      return { kind: 'angle', sectors, fallback: fallback === null || fallback < 0 ? null : fallback } as const;
    };
    // An angle the sketch holds is selected even on lines too near parallel for its sectors; it then previews nothing.
    if (existingAngle) {
      let preview: ReturnType<typeof anglePreview> | null = null;
      try { preview = anglePreview(); } catch (cause) { if (!(cause instanceof CadError)) throw cause; }
      angle = { form: 'angle', label: 'Angle', state: 'existing', relationIds: [existingAngle.id], reason: EXISTING, preview };
    }
    else if (parallel) angle = { form: 'angle', label: 'Angle', state: 'blocked', reason: axisId ? `This line is parallel to ${cadSketchVirtualSubject(axisId)}, so it has no angle to it.` : 'These lines are parallel, so they have no angle.' };
    else if (orientation) angle = { form: 'angle', label: 'Angle', state: 'blocked', reason: `Remove ${ORIENTATION_NAMES[orientation.kind as keyof typeof ORIENTATION_NAMES]} before adding Angle.` };
    else {
      try { angle = { form: 'angle', label: 'Angle', state: 'available', relations: [], implied: null, reuses: null, reference: null, referenceReason: NO_REFERENCE_ANGLE, preview: anglePreview() }; }
      catch (cause) { angle = { form: 'angle', label: 'Angle', state: 'blocked', reason: userFacingMessage(cause, 'These lines cannot take an angle.') }; }
    }
    return plan([distance, angle], distance.state === 'blocked' ? 'angle' : 'point-line');
  }
  /** Why a point or center has no distance from an axis, or the hold that keeps it, as a candidate. */
  function pointFromAxis(pointId: string, axisId: CadSketchVirtualAxisId): CadSketchDimensionCandidate {
    const across = cadSketchAxisNormal(axisId), point = at(pointId), coordinate = across === 'x' ? point.x : point.y;
    const preview = { kind: 'point-line', point, line: [ORIGIN, cadSketchVirtualPosition(axisId)!], value: Math.abs(coordinate) } as const;
    const kept = keptCoordinate(pointId, across, 'point-line', 'Distance', preview);
    if (kept) return kept;
    // An axis is a line: a point on it has no distance from it, and holding it there is Coincident's, not a dimension's.
    if (!(Math.abs(coordinate) > cadSketchDriverTolerance([point])))
      return { form: 'point-line', label: 'Distance', state: 'blocked', reason: `This point is on ${cadSketchVirtualSubject(axisId)}, so it has no distance from it. Use Coincident to keep it there.` };
    return coordinateHold(pointId, across, 'point-line', 'Distance', preview);
  }
  /**
   * A point's distance along an axis from the origin, or square to an axis, is the coordinate it keeps: the sketch stores it as that
   * coordinate held at its current value.
   */
  /**
   * The coordinate a point keeps already as a dimension, which placing selects: also at 0 when a parameter gives that 0, where the point lies
   * on the axis but the hold stays a dimension. A plain 0 is the Coincident that keeps the point there, which no dimension reuses.
   */
  function keptCoordinate(pointId: string, axis: 'x' | 'y', form: CadSketchDimensionForm, label: string, preview: CadSketchDimensionPreviewSource): CadSketchDimensionCandidate | null {
    const identity = identityOf(), own = identity(pointId);
    const found = graph.relations.find(relation => relation.kind === 'fixed-axis' && relation.axis === axis && identity(relation.pointId) === own);
    return found && isCadSketchDimensionRelation(found) ? { form, label, state: 'existing', relationIds: [found.id], reason: EXISTING, preview } : null;
  }
  function coordinateHold(pointId: string, axis: 'x' | 'y', form: CadSketchDimensionForm, label: string, preview: CadSketchDimensionPreviewSource): CadSketchDimensionCandidate {
    const identity = identityOf(), own = identity(pointId), aliases = graph.points.filter(point => identity(point.id) === own), ids = new Set(aliases.map(alias => alias.id));
    const fixed = 'This point already has its position from a fixed point or an expression.';
    if (graph.relations.some(relation => relation.kind === 'fixed-point' && ids.has(relation.pointId))) return { form, label, state: 'blocked', reason: fixed };
    const found = graph.relations.find(relation => relation.kind === 'fixed-axis' && ids.has(relation.pointId) && relation.axis === axis);
    if (found) return { form, label, state: 'existing', relationIds: [found.id], reason: EXISTING, preview };
    if (!aliases.every(alias => typeof alias.position[axis === 'x' ? 0 : 1] === 'number')) return { form, label, state: 'blocked', reason: fixed };
    const point = at(pointId);
    return { form, label, state: 'available', relations: [{ id: newId(), kind: 'fixed-axis', pointId, axis, value: axis === 'x' ? point.x : point.y }], implied: null, reuses: null,
      reference: null, referenceReason: NO_REFERENCE_HOLD, preview };
  }
  /** A line along an axis keeps its distance from it, through one end held from the axis and Horizontal or Vertical. */
  function lineFromAxis(lineId: string, axisId: CadSketchVirtualAxisId): { readonly distance: CadSketchDimensionCandidate; readonly along: boolean } {
    const line = entityOf(lineId);
    if (line?.kind !== 'line') throw new CadError('missing-sketch-line', 'The picked line is no longer available.');
    const label = 'Distance', a = at(line.startPointId), b = at(line.endPointId), tolerance = cadSketchDriverTolerance([a, b]), name = cadSketchVirtualSubject(axisId);
    const axis = cadSketchAxisNormal(axisId), kind: 'horizontal' | 'vertical' = axis === 'y' ? 'horizontal' : 'vertical';
    const along = axis === 'y' ? Math.abs(b.y - a.y) <= tolerance : Math.abs(b.x - a.x) <= tolerance;
    const result = (distance: CadSketchDimensionCandidate) => ({ distance, along });
    if (!along) return result({ form: 'point-line', label, state: 'blocked', reason: `This line is not parallel to ${name}, so it has no distance from it.` });
    const identity = identityOf(), aliases = (pointId: string) => { const own = identity(pointId); return graph.points.filter(point => identity(point.id) === own); };
    const ends = [...aliases(line.startPointId), ...aliases(line.endPointId)], ids = new Set(ends.map(point => point.id));
    const middle = { x: a.x / 2 + b.x / 2, y: a.y / 2 + b.y / 2 }, value = axis === 'y' ? a.y : a.x;
    const preview = { kind: 'point-line', point: middle, line: [ORIGIN, cadSketchVirtualPosition(axisId)!], value: Math.abs(value) } as const;
    if (!(Math.abs(value) > tolerance)) return result({ form: 'point-line', label, state: 'blocked', reason: `This line is on ${name}, so it has no distance from it. Use Collinear to keep it there.` });
    if (graph.relations.some(relation => relation.kind === 'fixed-point' && ids.has(relation.pointId)) || ends.some(point => typeof point.position[axis === 'x' ? 0 : 1] !== 'number'))
      return result({ form: 'point-line', label, state: 'blocked', reason: 'This line already has its position from a fixed point or an expression.' });
    const startAliases = new Set(aliases(line.startPointId).map(point => point.id)), endAliases = new Set(aliases(line.endPointId).map(point => point.id));
    const heldFrom = (end: ReadonlySet<string>) => graph.relations.find(relation => relation.kind === 'fixed-axis' && relation.axis === axis && end.has(relation.pointId));
    const level = graph.relations.some(relation => relation.kind === kind && (startAliases.has(relation.pointIds[0]) && endAliases.has(relation.pointIds[1]) || startAliases.has(relation.pointIds[1]) && endAliases.has(relation.pointIds[0])));
    // One held end keeps the line's distance only while Horizontal or Vertical, or a hold on its other end too, keeps it along the axis.
    const holds = [heldFrom(startAliases), heldFrom(endAliases)].filter(relation => relation !== undefined), existing = holds[0], kept = level || holds.length === 2;
    if (existing && kept) return result({ form: 'point-line', label, state: 'existing', relationIds: holds.map(relation => relation.id), reason: EXISTING, preview });
    const implied = level ? null : { id: newId(), kind, pointIds: [line.startPointId, line.endPointId] as const };
    if (existing && implied) return result({ form: 'point-line', label, state: 'available', relations: [implied], implied: implied.id, reuses: existing.id, reference: null, referenceReason: REUSED, preview });
    const relations: CadSketchGraphRelation[] = [{ id: newId(), kind: 'fixed-axis', pointId: line.startPointId, axis, value }, ...implied ? [implied] : []];
    return result({ form: 'point-line', label, state: 'available', relations, implied: implied?.id ?? null, reuses: null, reference: null, referenceReason: NO_REFERENCE_HOLD, preview });
  }
}

const ORIGIN: Point2 = Object.freeze({ x: 0, y: 0 });
const ORIENTATION_NAMES = { parallel: 'Parallel', perpendicular: 'Perpendicular', collinear: 'Collinear', horizontal: 'Horizontal', vertical: 'Vertical' } as const;

function pairLabel(form: 'aligned' | 'horizontal' | 'vertical', line: boolean) {
  return form === 'aligned' ? line ? 'Length' : 'Aligned distance' : form === 'horizontal' ? 'Horizontal distance' : 'Vertical distance';
}
