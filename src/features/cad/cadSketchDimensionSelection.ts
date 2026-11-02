import type { CadSketchGraph, CadSketchGraphRelation } from '@/domain/cad/cadSketchGraph';
import { resolveCadSketchPointIdentities } from '@/domain/cad/cadSketchGraphJoints';
import { cadSketchRelationEntityIds } from '@/domain/cad/cadSketchGraphReferences';
import type { CadSketchDimensionRelation, CadSketchDrawnDimensions } from './cadSketchGraphDimensionLayout';
import { cadSketchAxisDistanceLine } from './cadSketchDimensionCommands';
import { cadSketchZeroScalar } from './cadSketchGraphSelection';
import { cadSketchRelationDefinition } from '@/domain/cad/sketch-relations/cadSketchRelationRegistry';
import { CAD_SKETCH_ORIGIN_ID, cadSketchAxisOfNormal, isCadSketchVirtualId } from '@/domain/cad/sketch-relations/cadSketchVirtualElements';
import { cadSketchCurveCentres, cadSketchRelationName, isCadSketchConcentric } from './cadSketchRelationNames';

const DIMENSION_KINDS: ReadonlySet<CadSketchGraphRelation['kind']> = new Set(['distance', 'point-line-distance', 'axis-distance', 'fixed-axis', 'radial-size', 'fillet-corner', 'chamfer-corner', 'line-angle', 'reference-dimension']);
/**
 * Relations of the dimension kinds, which the canvas lays out as annotations and the properties count. A coordinate held from an axis is a
 * distance from that axis, unless it is 0 whatever the parameters are, which keeps its point on the axis as a relation. Whether one is drawn,
 * and so can be picked on the canvas, is the layout's: see `cadSketchDrawnDimensions`.
 */
export const isCadSketchDimensionRelation = (relation: CadSketchGraphRelation): relation is CadSketchDimensionRelation => DIMENSION_KINDS.has(relation.kind)
  && !(relation.kind === 'fixed-axis' && cadSketchZeroScalar(relation.value));
/**
 * Relations the canvas draws as a selectable annotation: the dimensions, and the geometric relations drawn as relation glyphs. A linear
 * pattern and a linked reference keep their own canvas and list controls, whose Detach keeps their geometry, so they are no annotation.
 */
export const isCadSketchAnnotationRelation = (relation: CadSketchGraphRelation): boolean => relation.kind !== 'linear-pattern' && relation.kind !== 'external-reference';
/** Relations drawn as relation glyphs: every annotation that is no dimension, a coordinate held at 0 among them. */
export const isCadSketchGlyphRelation = (relation: CadSketchGraphRelation): boolean => !isCadSketchDimensionRelation(relation) && isCadSketchAnnotationRelation(relation);
/**
 * The canvas annotations of one graph that a pick can name: the dimensions it draws, as `cadSketchDrawnDimensions` resolves them, and
 * every relation glyph while `glyphs` is set. On-part dimensions and Show relations each switch one of the two, never the other.
 */
export interface CadSketchDrawnAnnotations extends CadSketchDrawnDimensions { readonly glyphs: boolean }
const NO_DRAWN_IDS: ReadonlySet<string> = new Set();
/** The annotations drawn for a graph: `dimensions` when they are drawn for it, and the glyphs when `glyphs` is set. */
export function cadSketchDrawnAnnotations(graph: CadSketchGraph, dimensions: CadSketchDrawnDimensions | undefined, glyphs: boolean): CadSketchDrawnAnnotations {
  return Object.freeze({ graph, ids: dimensions?.graph === graph ? dimensions.ids : NO_DRAWN_IDS, glyphs });
}

/**
 * What a dimension measures, with the operands it was authored on. A driving and a reference form of one quantity share it, and it names
 * points and lines as the relation does, never through the Coincident joins of the graph it was picked in.
 */
export type CadSketchDimensionMeasure =
  | { readonly kind: 'point-distance'; readonly pointIds: readonly string[] }
  | { readonly kind: 'line-length'; readonly lineId: string }
  | { readonly kind: 'point-line-distance'; readonly pointId: string; readonly lineId: string }
  | { readonly kind: 'radial-size'; readonly entityId: string; readonly quantity: string }
  | { readonly kind: 'own'; readonly key: string };
/**
 * One selected dimension: its relation ID, or a profile chip's field, and what it was authored to measure. A different dimension that
 * reuses the ID, after undo, redo or an agent edit, is a different pick and never inherits the selection.
 * - `form` is the kind of relation, such as a driving distance or a reference to a line's length.
 * - `identity` is what that form names: a reference to a line keeps the line, so it survives a Trim or Extend that rewrites an endpoint.
 * - `measures` is the measured quantity that a driving and a reference form share, so Make reference and Make driving keep the pick.
 *   It follows from the form and identity.
 */
export interface CadSketchDimensionPick { readonly id: string; readonly form: string; readonly identity: string; readonly measures: CadSketchDimensionMeasure }
/** Dimensions selected on the canvas or on a profile, in selection order. Geometry selection replaces it. */
export const NO_SKETCH_DIMENSIONS: readonly CadSketchDimensionPick[] = Object.freeze([]);
export const NO_SKETCH_DIMENSION_IDS: readonly string[] = Object.freeze([]);
const MAX_SELECTED_DIMENSIONS = 64;
/**
 * Whether two picks name the same dimension in `graph`, the sketch as it is now. The same form must name the same thing. Another form must
 * measure the same quantity there: both picks' operands go through that graph's Coincident joins and its lines' current endpoints, whatever
 * graph either pick was taken in. Without a graph, as for profile chips, only the same form matches.
 */
export function sameCadSketchDimensionPick(a: CadSketchDimensionPick, b: CadSketchDimensionPick, graph: CadSketchGraph | null | undefined): boolean {
  if (a.id !== b.id) return false;
  if (a.form === b.form) return a.identity === b.identity;
  return graph ? measuredIn(graph, a.measures) === measuredIn(graph, b.measures) : false;
}
const samePick = sameCadSketchDimensionPick;
const equalPick = (a: CadSketchDimensionPick, b: CadSketchDimensionPick) => a.id === b.id && a.form === b.form && a.identity === b.identity;

/** A plain pick selects one dimension; an additive pick toggles it in or out of the current set. Picks compare in `graph`, as above. */
export function selectCadSketchDimension(current: readonly CadSketchDimensionPick[], pick: CadSketchDimensionPick, graph: CadSketchGraph | null | undefined, additive = false): readonly CadSketchDimensionPick[] {
  if (!additive) return current.length === 1 && samePick(current[0], pick, graph) ? current : Object.freeze([pick]);
  if (current.some(item => samePick(item, pick, graph))) { const kept = current.filter(item => !samePick(item, pick, graph)); return kept.length ? Object.freeze(kept) : NO_SKETCH_DIMENSIONS; }
  return current.length >= MAX_SELECTED_DIMENSIONS ? current : Object.freeze([...current, pick]);
}
/**
 * The same for a glyph that draws several relations, such as X and Y held at 0 on one point drawn as one Coincident glyph with the origin: a plain pick selects
 * them all; an additive pick removes them once all are selected, and otherwise adds the ones missing.
 */
export function selectCadSketchAnnotations(current: readonly CadSketchDimensionPick[], picks: readonly CadSketchDimensionPick[], graph: CadSketchGraph | null | undefined, additive = false): readonly CadSketchDimensionPick[] {
  if (picks.length === 1) return selectCadSketchDimension(current, picks[0], graph, additive);
  if (!picks.length) return current;
  const selected = (pick: CadSketchDimensionPick, among: readonly CadSketchDimensionPick[]) => among.some(item => samePick(item, pick, graph));
  if (!additive) return current.length === picks.length && picks.every(pick => selected(pick, current)) ? current : Object.freeze([...picks]);
  if (picks.every(pick => selected(pick, current))) { const kept = current.filter(item => !selected(item, picks)); return kept.length ? Object.freeze(kept) : NO_SKETCH_DIMENSIONS; }
  const added = picks.filter(pick => !selected(pick, current));
  return current.length + added.length > MAX_SELECTED_DIMENSIONS ? current : Object.freeze([...current, ...added]);
}
/** Keeps the picks that still name an available dimension; an unchanged set keeps its identity. */
export function keepCadSketchDimensionPicks(current: readonly CadSketchDimensionPick[], available: (pick: CadSketchDimensionPick) => boolean): readonly CadSketchDimensionPick[] {
  if (!current.length) return current;
  const kept = current.filter(available);
  return kept.length === current.length ? current : kept.length ? Object.freeze(kept) : NO_SKETCH_DIMENSIONS;
}
export function cadSketchDimensionIds(current: readonly CadSketchDimensionPick[]): readonly string[] {
  return current.length ? Object.freeze(current.map(pick => pick.id)) : NO_SKETCH_DIMENSION_IDS;
}

const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}` : JSON.stringify(value);
// One resolver per graph, kept on that graph, so a canvas of dimensions joins its Coincident relations once and no graph reads another's joins.
// A graph that names a missing point keeps raw IDs.
const identities = new WeakMap<CadSketchGraph, (pointId: string) => string>();
/** The point a graph's Coincident relations join a point ID to, the same ID for every point of one place; cached per graph. */
export function cadSketchPointIdentity(graph: CadSketchGraph): (pointId: string) => string {
  let identity = identities.get(graph);
  if (!identity) {
    let root: (pointId: string) => string;
    try { root = resolveCadSketchPointIdentities(graph); } catch { root = id => id; }
    identity = id => { try { return root(id); } catch { return id; } };
    identities.set(graph, identity);
  }
  return identity;
}
/** The quantity a pick measures, resolved in `graph`: points through its Coincident joins, a line's length through its current endpoints. */
function measuredIn(graph: CadSketchGraph, measures: CadSketchDimensionMeasure): string {
  const point = cadSketchPointIdentity(graph);
  switch (measures.kind) {
    case 'point-distance': return canonical(['point-distance', measures.pointIds.map(point).sort()]);
    case 'point-line-distance': return canonical(['point-line-distance', point(measures.pointId), measures.lineId]);
    case 'line-length': {
      // A line the graph no longer holds measures nothing that a driving distance does.
      const line = graph.entities.find(entity => entity.id === measures.lineId);
      return line?.kind === 'line' ? canonical(['point-distance', [line.startPointId, line.endPointId].map(point).sort()]) : canonical(measures);
    }
    default: return canonical(measures);
  }
}
/**
 * The pick for a dimension relation, without its value or where it is drawn. Editing the value or moving it keeps the selection, and so do
 * Make reference and Make driving, which keep the measured length, distance, radius or diameter. A relation that measures something else does not.
 * The pick keeps the operands as authored. Only a comparison resolves them, in the graph it compares in, so a driver on a coincident alias of a
 * line's endpoint and the line's reference measure the same length only while that graph joins the two points.
 * A point to line distance names its point and line, not its side, which an edit that turns the line around flips to keep the point where it is.
 */
export function cadSketchDimensionPickOf(relation: CadSketchGraphRelation): CadSketchDimensionPick {
  const pair = (pointIds: readonly string[]) => [...pointIds].sort();
  const pick = (form: string, identity: unknown, measures: CadSketchDimensionMeasure) => ({ id: relation.id, form, identity: canonical(identity), measures });
  switch (relation.kind) {
    case 'distance': return pick('distance', pair(relation.pointIds), { kind: 'point-distance', pointIds: pair(relation.pointIds) });
    case 'point-line-distance': return pick('point-line-distance', [relation.pointId, relation.lineId], { kind: 'point-line-distance', pointId: relation.pointId, lineId: relation.lineId });
    case 'radial-size': return pick('radial-size', [relation.entityId, relation.quantity], { kind: 'radial-size', entityId: relation.entityId, quantity: relation.quantity });
    case 'reference-dimension': {
      const measurement = relation.measurement, form = `reference/${measurement.kind}`;
      if (measurement.kind === 'radial-size') return pick(form, [measurement.entityId, measurement.quantity], { kind: 'radial-size', entityId: measurement.entityId, quantity: measurement.quantity });
      if (measurement.kind === 'point-distance') return pick(form, pair(measurement.pointIds), { kind: 'point-distance', pointIds: pair(measurement.pointIds) });
      if (measurement.kind === 'point-line-distance') return pick(form, [measurement.pointId, measurement.lineId], { kind: 'point-line-distance', pointId: measurement.pointId, lineId: measurement.lineId });
      // A line reference names its line, so it survives a Trim or Extend; a comparison measures the line's endpoints in its own graph.
      return pick(form, measurement.entityId, { kind: 'line-length', lineId: measurement.entityId });
    }
    default: {
      // A relation's own value, values or fixed position is what an edit changes, and its annotation only where it is drawn; the relation
      // keeps its pick through either.
      const identity = canonical(Object.fromEntries(Object.entries(relation).filter(([key]) => key !== 'id' && key !== 'value' && key !== 'values' && key !== 'position' && key !== 'annotation')));
      return { id: relation.id, form: relation.kind, identity, measures: { kind: 'own', key: `${relation.kind}/${identity}` } };
    }
  }
}
/**
 * The pick for a canvas annotation that is drawn: a dimension the canvas draws, or a relation glyph while the glyphs are drawn. Null when
 * the relation is gone, is no annotation or is not drawn.
 */
export function cadSketchDimensionPick(drawn: CadSketchDrawnDimensions | CadSketchDrawnAnnotations, relationId: string): CadSketchDimensionPick | null {
  const glyphs = 'glyphs' in drawn && drawn.glyphs, relation = glyphs || drawn.ids.has(relationId) ? drawn.graph.relations.find(item => item.id === relationId) : undefined;
  return relation && (isCadSketchDimensionRelation(relation) ? drawn.ids.has(relationId) : glyphs && isCadSketchGlyphRelation(relation)) ? cadSketchDimensionPickOf(relation) : null;
}
/** Whether a pick still names the dimension the graph holds under its ID, drawn or not. */
export function isCadSketchDimensionInGraph(graph: CadSketchGraph, pick: CadSketchDimensionPick): boolean {
  const relation = graph.relations.find(item => item.id === pick.id);
  return Boolean(relation && isCadSketchDimensionRelation(relation) && samePick(cadSketchDimensionPickOf(relation), pick, graph));
}
/** Whether a pick still names a drawn annotation, the one the graph holds under its ID. */
export function isCadSketchDimensionPickCurrent(drawn: CadSketchDrawnDimensions | undefined, pick: CadSketchDimensionPick): boolean {
  const current = drawn ? cadSketchDimensionPick(drawn, pick.id) : null;
  return Boolean(drawn && current && samePick(current, pick, drawn.graph));
}
/**
 * Undo, redo, deletion and agent edits can remove or replace a selected dimension or relation, an edit can leave one with nothing to draw
 * it on, and hiding dimensions or relation glyphs leaves the hidden ones undrawn; the rest stay selected. Each pick compares in the new graph, and a kept pick takes the dimension's current form and operands.
 */
export function reconcileCadSketchDimensionSelection(drawn: CadSketchDrawnDimensions | undefined, current: readonly CadSketchDimensionPick[]): readonly CadSketchDimensionPick[] {
  if (!current.length) return current;
  if (!drawn) return NO_SKETCH_DIMENSIONS;
  const graph = drawn.graph;
  let changed = false;
  const kept = current.flatMap(pick => {
    const now = cadSketchDimensionPick(drawn, pick.id);
    if (!now || !samePick(now, pick, graph)) { changed = true; return []; }
    if (!equalPick(now, pick)) changed = true;
    return [equalPick(now, pick) ? pick : now];
  });
  return !changed ? current : kept.length ? Object.freeze(kept) : NO_SKETCH_DIMENSIONS;
}
/**
 * Mount keys for canvas annotations, dimensions and relation glyphs, for the relations `include` takes. A relation keeps its key while each new graph names the same
 * dimension, compared in that new graph, so focus and a menu's focus return stay with it; a replacement under the same ID gets a new key, so it never inherits either.
 */
export function createCadSketchDimensionKeys(include: (relation: CadSketchGraphRelation) => boolean = isCadSketchAnnotationRelation) {
  let entries = new Map<string, { pick: CadSketchDimensionPick; generation: number }>(), next = 0;
  return (graph: CadSketchGraph): ReadonlyMap<string, string> => {
    const updated = new Map<string, { pick: CadSketchDimensionPick; generation: number }>(), keys = new Map<string, string>();
    for (const relation of graph.relations) {
      if (!isCadSketchAnnotationRelation(relation) || !include(relation)) continue;
      const pick = cadSketchDimensionPickOf(relation), previous = entries.get(relation.id);
      const entry = previous && samePick(previous.pick, pick, graph) ? { pick, generation: previous.generation } : { pick, generation: next++ };
      updated.set(relation.id, entry); keys.set(relation.id, `${relation.id}/${entry.generation}`);
    }
    entries = updated;
    return keys;
  };
}

/** Sentence-case name of a canvas dimension, as the relations list names it. */
export function cadSketchDimensionName(graph: CadSketchGraph, relation: CadSketchDimensionRelation): string {
  switch (relation.kind) {
    case 'distance': return graph.entities.some(entity => entity.kind === 'line' && relation.pointIds.includes(entity.startPointId) && relation.pointIds.includes(entity.endPointId)) ? 'Length' : 'Distance';
    case 'point-line-distance': return 'Point to line distance';
    case 'axis-distance': return relation.axis === 'x' ? 'Horizontal distance' : 'Vertical distance';
    // A distance from an axis is named like a distance between parallel lines; only its highlight shows the axis.
    case 'fixed-axis': return 'Distance';
    case 'radial-size': return relation.quantity === 'radius' ? 'Radius' : 'Diameter';
    case 'fillet-corner': return 'Fillet';
    case 'chamfer-corner': return 'Chamfer';
    case 'line-angle': return 'Angle';
    case 'reference-dimension': return 'Reference dimension';
  }
}
/** How a relation glyph that draws X and Y held at 0 on one place names them: the point is Coincident with the origin. */
export const CAD_SKETCH_ORIGIN_PAIR_NAME = 'Coincident';
/**
 * Whether the relations are X and Y held at 0 on one point, or on points that Coincident joins in one place: two relation glyph
 * relations that one glyph draws as the point at the origin. A coordinate held away from 0 is a Distance dimension, never part of one.
 */
export function isCadSketchOriginPair(graph: CadSketchGraph, relations: readonly CadSketchGraphRelation[]): boolean {
  const [first, second] = relations;
  if (relations.length !== 2 || !relations.every(isCadSketchGlyphRelation) || first.kind !== 'fixed-axis' || second.kind !== 'fixed-axis' || first.axis === second.axis) return false;
  const identity = cadSketchPointIdentity(graph);
  return identity(first.pointId) === identity(second.pointId);
}
/**
 * What the canvas status line says about the selected dimensions and relations, rows of the relations list without a mark among them;
 * selection never opens the editor. X and Y held at 0 on one point, drawn as one Coincident glyph with the origin, read as that glyph. A
 * linear pattern detaches through its editor, so it is never counted.
 */
export function cadSketchDimensionSelectionStatus(graph: CadSketchGraph | undefined, ids: readonly string[]): string | null {
  if (!graph || !ids.length) return null;
  // Each relation once, though a row and its mark may both name it.
  const named = new Set(ids), relations = graph.relations.filter(item => named.has(item.id) && item.kind !== 'linear-pattern');
  if (!relations.length) return null;
  const dimensions = relations.filter(isCadSketchDimensionRelation);
  if (isCadSketchOriginPair(graph, relations)) return `${CAD_SKETCH_ORIGIN_PAIR_NAME} selected · Delete removes`;
  if (relations.length === 1) return dimensions.length ? `${cadSketchDimensionName(graph, dimensions[0])} selected · Double-click or Enter edits · Delete removes`
    : `${cadSketchRelationName(graph, relations[0])} selected · Delete ${relations[0].kind === 'external-reference' ? 'detaches' : 'removes'}`;
  return `${cadSketchAnnotationCount(graph, relations.map(relation => relation.id))} selected · Delete removes them`;
}
/**
 * "1 shape, 2 dimensions and 1 relation": the relations the IDs name, as the status line, a Delete command and its dialog count them. A
 * generator counts as the shape it deletes, and a source reference as the relation it is.
 */
export function cadSketchAnnotationCount(graph: CadSketchGraph, ids: readonly string[]): string {
  const relations = graph.relations.filter(relation => ids.includes(relation.id));
  const shapes = relations.filter(relation => relation.kind === 'generator').length, dimensions = relations.filter(isCadSketchDimensionRelation).length;
  const parts = ([[shapes, 'shape'], [dimensions, 'dimension'], [relations.length - shapes - dimensions, 'relation']] as const)
    .flatMap(([n, noun]) => n ? [`${n} ${noun}${n === 1 ? '' : 's'}`] : []);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] ?? '0 relations';
}

/** Geometry a relation names directly, the origin and the axes among it, plus the origin or the axis a coordinate is measured from. */
export interface CadSketchHighlight { readonly pointIds: readonly string[]; readonly entityIds: readonly string[] }
export const NO_SKETCH_HIGHLIGHT: CadSketchHighlight = Object.freeze({ pointIds: [], entityIds: [] });
/** A graph's point and edge IDs, its lines by their two end IDs and its curves by centre, built once per graph so naming many relations reads no graph twice. */
interface GeometryIndex {
  readonly points: ReadonlySet<string>; readonly entities: ReadonlySet<string>;
  /** Line indices in graph order, by the Coincident identities of their ends as `start end` and `end start`. */
  readonly lines: ReadonlyMap<string, readonly number[]>;
  readonly centres: ReadonlyMap<string, readonly string[]>;
}
const geometryIndices = new WeakMap<CadSketchGraph, GeometryIndex>();
function geometryIndex(graph: CadSketchGraph): GeometryIndex {
  let index = geometryIndices.get(graph);
  if (!index) {
    const lines = new Map<string, number[]>(), identity = cadSketchPointIdentity(graph);
    graph.entities.forEach((entity, at) => {
      if (entity.kind !== 'line') return;
      const start = identity(entity.startPointId), end = identity(entity.endPointId);
      for (const key of new Set([`${start} ${end}`, `${end} ${start}`])) lines.set(key, [...lines.get(key) ?? [], at]);
    });
    index = { points: new Set(graph.points.map(point => point.id)), entities: new Set(graph.entities.map(entity => entity.id)), lines, centres: cadSketchCurveCentres(graph) };
    geometryIndices.set(graph, index);
  }
  return index;
}
export function cadSketchRelationHighlight(graph: CadSketchGraph, relation: CadSketchGraphRelation): CadSketchHighlight {
  const named = relation.kind === 'reference-dimension' ? relation.measurement.kind === 'point-distance' ? relation.measurement.pointIds
    : relation.measurement.kind === 'point-line-distance' ? [relation.measurement.pointId] : []
    : relation.kind === 'tangent-joint' ? relation.endpoints.map(endpoint => endpoint.pointId)
      : 'pointIds' in relation ? relation.pointIds : 'pointId' in relation ? [relation.pointId] : [];
  const { points, entities, lines, centres } = geometryIndex(graph);
  // A dimension or relation between a line's own endpoints, or points that Coincident joins to them, is about that line, and a Concentric
  // about the curves on its two centres.
  const identity = cadSketchPointIdentity(graph), [first, second] = named.map(identity);
  const spanned = relation.kind === 'coincident' && isCadSketchConcentric(graph, relation, centres) ? relation.pointIds.flatMap(id => centres.get(id) ?? [])
    : named.length === 2 ? [...new Set([`${first} ${second}`, `${first} ${first}`, `${second} ${second}`].flatMap(key => lines.get(key) ?? []))].sort((a, b) => a - b).map(at => graph.entities[at].id) : [];
  // A coordinate is measured from the axis across it: X from the V axis, Y from the H axis, and a fixed point from the origin. A distance
  // drawn to a line kept along the axis lights that line.
  const fixed = [...cadSketchRelationDefinition(relation).operands(relation).filter(isCadSketchVirtualId),
    ...relation.kind === 'fixed-axis' ? [cadSketchAxisOfNormal(relation.axis)] : relation.kind === 'fixed-point' ? [CAD_SKETCH_ORIGIN_ID] : []];
  const measured = relation.kind === 'fixed-axis' && isCadSketchDimensionRelation(relation) ? cadSketchAxisDistanceLine(graph, relation)?.id : undefined;
  return { pointIds: [...new Set([...named.filter(id => points.has(id)), ...fixed.filter(id => id === CAD_SKETCH_ORIGIN_ID)])],
    entityIds: [...new Set([...[...cadSketchRelationEntityIds(relation), ...spanned, ...measured ? [measured] : []].filter(id => entities.has(id)), ...fixed.filter(id => id !== CAD_SKETCH_ORIGIN_ID)])] };
}

/**
 * A relation resolves against the drawn graph, so a dimension removed by undo highlights nothing; dock rows pass their own draft geometry,
 * with the relations whose canvas glyphs they light up. A glyph that draws several relations shows them all.
 */
export type CadSketchHighlightSource = { readonly kind: 'relation'; readonly relationId: string } | { readonly kind: 'relations'; readonly relationIds: readonly string[] }
  | ({ readonly kind: 'geometry'; readonly relationIds?: readonly string[] } & CadSketchHighlight);
/** The relations a highlight names, whose glyphs light up with it. */
export function cadSketchHighlightRelationIds(source: CadSketchHighlightSource | null): readonly string[] {
  return !source ? NO_SKETCH_DIMENSION_IDS : source.kind === 'relation' ? [source.relationId] : source.relationIds ?? NO_SKETCH_DIMENSION_IDS;
}
/**
 * Hover highlight shared by canvas dimensions and dock rows. Only the overlay subscribes, so hovering renders no graph rows,
 * no canvas and no workbench. Each owner shows and hides only its own highlight.
 */
export interface CadSketchHighlightStore {
  getSnapshot(): CadSketchHighlightSource | null;
  subscribe(listener: () => void): () => void;
  show(owner: string, source: CadSketchHighlightSource): void;
  hide(owner: string): void;
}
export function createCadSketchHighlightStore(): CadSketchHighlightStore {
  let owner: string | null = null, current: CadSketchHighlightSource | null = null;
  const listeners = new Set<() => void>();
  const publish = () => { for (const listener of [...listeners]) listener(); };
  return {
    getSnapshot: () => current,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    show: (key, source) => {
      if (owner === key && current && JSON.stringify(current) === JSON.stringify(source)) return;
      owner = key; current = source; publish();
    },
    hide: key => { if (owner !== key) return; owner = null; current = null; publish(); }
  };
}
