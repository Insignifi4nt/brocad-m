import type { CadProfile } from '../cadDocument';
import { CadError } from '../cadError';
import { evaluateCadScalar } from '../cadExpression';
import { cadOrderedCurveEntities, cadPathClosureTolerance, type ResolvedCadPathSegment } from '../cadAnalyticSegments';
import type { CadSketchGeneratorGeometry, CadSketchGraphEntity, CadSketchGraphPoint, CadSketchGraphRelation } from '../cadSketchGraph';
import { cadAnalyticPathMetrics, checkCadSketchGeneratorShape, resolveCadProfile, type ResolvedCadProfile } from '../cadSketchGeometry';
import { cadSketchOffsetPathSegment, offsetCadSketchLoop } from '../cadSketchLoopOffset';
import { resolveCadPluginOutline, type CadPluginOutlineParts, type CadPluginProfile } from '../plugins/cadPlugins';
import { cadSketchCurveTraits } from '../sketch-relations/cadSketchCurveCapabilities';
import { copiedCadSketchRelations, copyCadSketchRelations, type CadSketchRelationCopy, type CadSketchRemapPiece } from '../sketch-relations/cadSketchRelationRemap';
import type { CadSketchOperandSignature, CadSketchOperandSlot, CadSketchRelationIntent } from '../sketch-relations/cadSketchRelationTypes';
import { CAD_PRECISION, cadSupportedLength } from '@/domain/precision/cadPrecision';
import { createArcSegment, createCircleSegment, createLineSegment } from '@/domain/path-intel/segments';
import { CAD_SKETCH_ENTRY_ID_MAX } from './cadSketchGeneratorSchema';
import type { PathSegment, Point2 } from '@/domain/path-intel/types';

// Each kind of generator: what it reads and what it generates. Generation keys every point, edge and relation by its place in the
// shape, never by coordinates or by its place among samples, so regenerating after an input change keeps each id `<idPrefix>_<key>`
// while the shape keeps that part: tooth 3's tip stays `t3_tip` however many teeth the gear has, and a listed polygon's or path's
// entry keeps its members wherever an edit inserts or removes others. A part that changes kind, such as a rectangle's corner that
// becomes an arc, takes a new key, and so do the chords of a curve sampled anew. Profile kinds generate exactly what a legacy profile
// of that geometry resolves to, after the same checks, so their regions and solids build as before.

/** Points, edges and relations a generator makes, with their final ids. */
export interface CadSketchGeneratedGeometry {
  readonly points: readonly CadSketchGraphPoint[];
  readonly entities: readonly CadSketchGraphEntity[];
  readonly relations: readonly CadSketchGraphRelation[];
}
/**
 * What generation reads beyond the record: the parameters, and the sketch geometry its operands name, stored or generated before it,
 * with the relations among that geometry.
 */
export interface CadSketchGeneratorContext {
  readonly parameters: Readonly<Record<string, number>>;
  /** The evaluated ends of the line `id` names, an axis as a unit step from the origin; undefined when it names no line. */
  line(id: string): { readonly start: Point2; readonly end: Point2 } | undefined;
  /** The evaluated position of the point `id` names, the origin's too; undefined when it names no point. */
  point(id: string): Point2 | undefined;
  /** The curve `id` names, as the sketch holds it; undefined when it names none. An axis is no curve here. */
  curve(id: string): CadSketchGraphEntity | undefined;
  /**
   * The sketch's relations that name only geometry among `ids`, and the origin and axes besides, in id order, so a copy reads them alike however
   * the graph holds them: what a copy of that geometry may carry. A relation that owns geometry, such as a generator, is not among them.
   */
  relationsAmong(ids: ReadonlySet<string>): readonly CadSketchGraphRelation[];
}
/** A generator's inputs, evaluated: `key` holds everything generation reads, so equal keys generate equal geometry. */
export interface CadSketchGeneratorEvaluation {
  readonly key: string;
  readonly build: (id: (key: string) => string, construction: boolean) => CadSketchGeneratedGeometry;
  /**
   * The closed outline its edges draw, as the legacy profile shape it was checked as: closed, of positive area and free of
   * self-intersection. Its region reads as that shape does. A generator that draws no one closed outline, such as a pattern, has none:
   * its edges join the sketch's contours as drawn edges do.
   */
  readonly shape?: () => ResolvedCadProfile;
}
export interface CadSketchGeneratorKind<G extends CadSketchGeneratorGeometry> {
  /** Sentence-case name of what it generates, as people and agents are told: a plugin's package name. */
  readonly label: (geometry: G) => string;
  /** The sketch elements it reads, as operand slots in `operands` order: one for each, so a list of curves has one slot for each curve. */
  readonly signature: (geometry: G) => CadSketchOperandSignature;
  readonly operands: (geometry: G) => readonly string[];
  readonly withOperands: (geometry: G, ids: readonly string[]) => G;
  /** Its inputs evaluated now, refused with the reason when out of range; `name` names the generator in a refusal. */
  readonly evaluate: (geometry: G, context: CadSketchGeneratorContext, name: string) => CadSketchGeneratorEvaluation;
  /** `next`, the record's geometry after an edit, with the ids of the entries it kept from `previous`: see `identifiedEntries`. */
  readonly identify?: (previous: G, next: G) => G;
  /**
   * The keys whose edge `next` joins to other parts of the shape than `previous` did, such as an edge an inserted vertex splits, which
   * settling takes through the relation remap as members that leave though their keys stay. Undefined when there are none.
   */
  readonly reshaped?: (previous: G, next: G) => ((key: string) => boolean) | undefined;
}
type Of<K extends CadSketchGeneratorGeometry['kind']> = Extract<CadSketchGeneratorGeometry, { kind: K }>;

const invalid = (message: string) => new CadError('invalid-sketch-generator', message);
const minimum = CAD_PRECISION.minimumLengthMm;

/** Collects one generator's output under its ids. */
class Output {
  readonly points: CadSketchGraphPoint[] = [];
  readonly entities: CadSketchGraphEntity[] = [];
  readonly relations: CadSketchGraphRelation[] = [];
  constructor(private readonly id: (key: string) => string, private readonly construction: boolean) {}
  point(key: string, position: readonly [number, number]): string {
    const id = this.id(key);
    this.points.push({ id, position: [position[0], position[1]] });
    return id;
  }
  line(key: string, startPointId: string, endPointId: string): string {
    const id = this.id(key);
    this.entities.push({ id, kind: 'line', construction: this.construction, startPointId, endPointId });
    return id;
  }
  arc(key: string, centerPointId: string, startPointId: string, endPointId: string, direction: 'cw' | 'ccw'): string {
    const id = this.id(key);
    this.entities.push({ id, kind: 'arc', construction: this.construction, centerPointId, startPointId, endPointId, direction });
    return id;
  }
  circle(key: string, centerPointId: string, radius: number): string {
    const id = this.id(key);
    this.entities.push({ id, kind: 'circle', construction: this.construction, centerPointId, radius });
    return id;
  }
  relation(key: string, relation: CadSketchRelationIntent): void {
    this.relations.push({ id: this.id(key), ...relation } as CadSketchGraphRelation);
  }
  /** A line's end joined smoothly to an arc's end at the point they share. */
  joint(key: string, lineId: string, arcId: string, pointId: string): void {
    this.relation(key, { kind: 'tangent-joint', endpoints: [{ entityId: lineId, pointId }, { entityId: arcId, pointId }] });
  }
  result(): CadSketchGeneratedGeometry { return { points: this.points, entities: this.entities, relations: this.relations }; }
}

function circleOutput(output: Output, center: readonly [number, number], radius: number): void {
  output.circle('c0', output.point('k0', center), radius);
}
/**
 * A rectangle from its lower-left corner. Sharp, it is four corners `p0`-`p3` counterclockwise from that corner, joined by sides `e0`-`e3`
 * from the bottom, held level and upright as a drawn rectangle is. Rounded, each corner is an arc `a<i>` about `k<i>` between tangent
 * points `t<2i+1>` and `t<2i+2>`, joined smoothly to its sides, with every arc's radius equal to the first's; a side as short as the two
 * radii leaves, and its arcs meet.
 */
function rectangleOutput(output: Output, { x, y, width: w, height: h, cornerRadius: r }: Extract<ResolvedCadProfile, { kind: 'rectangle' }>): void {
  if (!(r > 0)) {
    const p = [output.point('p0', [x, y]), output.point('p1', [x + w, y]), output.point('p2', [x + w, y + h]), output.point('p3', [x, y + h])];
    p.forEach((id, index) => output.line(`e${index}`, id, p[(index + 1) % 4]));
    p.forEach((id, index) => output.relation(`r${index}`, { kind: index % 2 === 0 ? 'horizontal' : 'vertical', pointIds: [id, p[(index + 1) % 4]] }));
    return;
  }
  const across = w - 2 * r > minimum, upright = h - 2 * r > minimum;
  const t0 = output.point('t0', [x + r, y]), t1 = across ? output.point('t1', [x + w - r, y]) : t0;
  const t2 = output.point('t2', [x + w, y + r]), t3 = upright ? output.point('t3', [x + w, y + h - r]) : t2;
  const t4 = output.point('t4', [x + w - r, y + h]), t5 = across ? output.point('t5', [x + r, y + h]) : t4;
  const t6 = output.point('t6', [x, y + h - r]), t7 = upright ? output.point('t7', [x, y + r]) : t6;
  const k = [output.point('k0', [x + w - r, y + r]), output.point('k1', [x + w - r, y + h - r]), output.point('k2', [x + r, y + h - r]), output.point('k3', [x + r, y + r])];
  const sides: (string | null)[] = [across ? output.line('e0', t0, t1) : null, null, null, null];
  const arcs = [output.arc('a0', k[0], t1, t2, 'ccw')];
  sides[1] = upright ? output.line('e1', t2, t3) : null;
  arcs.push(output.arc('a1', k[1], t3, t4, 'ccw'));
  sides[2] = across ? output.line('e2', t4, t5) : null;
  arcs.push(output.arc('a2', k[2], t5, t6, 'ccw'));
  sides[3] = upright ? output.line('e3', t6, t7) : null;
  arcs.push(output.arc('a3', k[3], t7, t0, 'ccw'));
  const ends: readonly (readonly [string, string])[] = [[t0, t1], [t2, t3], [t4, t5], [t6, t7]];
  sides.forEach((side, index) => {
    if (!side) return;
    output.relation(`r${index}`, { kind: index % 2 === 0 ? 'horizontal' : 'vertical', pointIds: [ends[index][0], ends[index][1]] });
    // The arc before the side ends at its start, and the arc after it starts at its end.
    output.joint(`j${2 * index}`, side, arcs[(index + 3) % 4], ends[index][0]);
    output.joint(`j${2 * index + 1}`, side, arcs[index], ends[index][1]);
  });
  for (let index = 1; index < 4; index++) output.relation(`q${index}`, { kind: 'equal-radius', curveIds: [arcs[0], arcs[index]] });
}
/**
 * A slot about its centre: sides `e0` and `e1` joined smoothly to end arcs `a0` about `k1` and `a1` about `k0`, of equal radius, as a
 * drawn slot is. One no longer than its width is a circle.
 */
function slotOutput(output: Output, slot: Extract<ResolvedCadProfile, { kind: 'slot' }>): void {
  const angle = slot.angle * Math.PI / 180, half = (slot.length - slot.width) / 2, r = slot.width / 2;
  if (half <= minimum) return circleOutput(output, [slot.x, slot.y], r);
  const at = (x: number, y: number): [number, number] => [slot.x + x * Math.cos(angle) - y * Math.sin(angle), slot.y + x * Math.sin(angle) + y * Math.cos(angle)];
  const k0 = output.point('k0', at(-half, 0)), k1 = output.point('k1', at(half, 0));
  const t0 = output.point('t0', at(-half, -r)), t1 = output.point('t1', at(half, -r)), t2 = output.point('t2', at(half, r)), t3 = output.point('t3', at(-half, r));
  const e0 = output.line('e0', t0, t1), a0 = output.arc('a0', k1, t1, t2, 'ccw'), e1 = output.line('e1', t2, t3), a1 = output.arc('a1', k0, t3, t0, 'ccw');
  output.joint('j0', e0, a0, t1); output.joint('j1', e1, a0, t2); output.joint('j2', e1, a1, t3); output.joint('j3', e0, a1, t0);
  output.relation('q0', { kind: 'equal-radius', curveIds: [a1, a0] });
}
/** The keys of a polygon's vertex and of the edge from it to the next. */
interface VertexKeys { readonly vertex: string; readonly edge: string }
const listedVertex = (index: number): VertexKeys => ({ vertex: `v${index}`, edge: `e${index}` });
/** Vertices `v<i>` in order, joined by edges `e<i>` from each to the next, unless `keys` names them by their part. */
function polygonOutput(output: Output, points: readonly (readonly [number, number])[], keys: (index: number) => VertexKeys = listedVertex): string[] {
  const vertices = points.map((point, index) => output.point(keys(index).vertex, point));
  return vertices.map((id, index) => output.line(keys(index).edge, id, vertices[(index + 1) % vertices.length]));
}
/** The keys of a path's segment, of the joint where it ends and of its centre when it is an arc. */
interface SegmentKeys { readonly segment: string; readonly joint: string; readonly centre: string }
const listedSegment = (index: number): SegmentKeys => ({ segment: `s${index}`, joint: `j${index}`, centre: `c${index}` });
/**
 * Segments `s<i>` in order, each ending at joint `j<i>` where the next starts, the last at the first's start; an arc's centre is `c<i>`,
 * unless `keys` names them by their part. A joint is where its segment ends, so an arc keeps the radius it was given. A path of one
 * full turn is a circle.
 */
function pathOutput(output: Output, segments: readonly ResolvedCadPathSegment[], keys: (index: number) => SegmentKeys = listedSegment): void {
  if (segments.length === 1 && segments[0].kind === 'arc' && Math.abs(segments[0].sweep) === 360)
    return circleOutput(output, segments[0].center, segments[0].radius);
  const curves = cadOrderedCurveEntities(segments);
  const joints = curves.map((curve, index) => output.point(keys(index).joint, [curve.end.x, curve.end.y]));
  segments.forEach((segment, index) => {
    const start = joints[(index + segments.length - 1) % segments.length], end = joints[index], key = keys(index);
    if (segment.kind === 'line') output.line(key.segment, start, end);
    else output.arc(key.segment, output.point(key.centre, segment.center), start, end, segment.sweep < 0 ? 'cw' : 'ccw');
  });
}
/** A profile's members; a listed polygon's or path's keyed by the entry ids `ids` when it has them, else by index. */
function profileOutput(output: Output, geometry: ResolvedCadProfile, ids?: readonly number[]): void {
  switch (geometry.kind) {
    case 'rectangle': return rectangleOutput(output, geometry);
    case 'circle': return circleOutput(output, [geometry.x, geometry.y], geometry.radius);
    case 'slot': return slotOutput(output, geometry);
    case 'polygon': polygonOutput(output, geometry.points, ids ? index => listedVertex(ids[index]) : listedVertex); return;
    case 'path': return pathOutput(output, geometry.segments, ids ? index => listedSegment(ids[index]) : listedSegment);
    default: { const exhaustive: never = geometry; throw exhaustive; }
  }
}
/**
 * A gear's outline keyed by tooth `t<k>` and part, in the order the gear draws it. Tooth k's left side rises from the root circle at
 * `t<k>_rootL`: its foot's chords `footL<n>s<i>` to the involute's base `baseL`, then its flank's chords `flankL<n>s<i>` to the tip
 * at `tipL`. Its tip arc `tip` ends at `tipR`, its right side falls by `flankR` and `footR` chords, numbered from the root up as the
 * left side's are, through `baseR` to `rootR`, and the root arc `root` after it ends where tooth k+1 rises. Arc centres are `tipC` and
 * `rootC`. A chord's key holds its run's chord count `n`, and a joint between chords is `<run><n>j<i>` after chord i, so the chords of
 * a curve sampled anew are new members, and only the teeth that leave take their own.
 */
function gearKeys({ teeth, foot, flank }: Extract<CadPluginOutlineParts, { kind: 'gear' }>, count: number): (index: number) => SegmentKeys {
  const side = foot + flank, perTooth = 2 * side + 2;
  if (count !== teeth * perTooth) throw new CadError('invalid-plugin', `The gear drew ${count} segments, not ${perTooth} for each of its ${teeth} teeth.`);
  return index => {
    const k = Math.floor(index / perTooth), at = index % perTooth, t = `t${k}_`, centre = '';
    if (at < foot) return { segment: `${t}footL${foot}s${at}`, joint: at < foot - 1 ? `${t}footL${foot}j${at}` : `${t}baseL`, centre };
    if (at < side) {
      const i = at - foot;
      return { segment: `${t}flankL${flank}s${i}`, joint: i < flank - 1 ? `${t}flankL${flank}j${i}` : `${t}tipL`, centre };
    }
    if (at === side) return { segment: `${t}tip`, joint: `${t}tipR`, centre: `${t}tipC` };
    if (at <= side + flank) {
      const i = side + flank - at;
      return { segment: `${t}flankR${flank}s${i}`, joint: i > 0 ? `${t}flankR${flank}j${i - 1}` : foot ? `${t}baseR` : `${t}rootR`, centre };
    }
    if (at < perTooth - 1) {
      const i = perTooth - 2 - at;
      return { segment: `${t}footR${foot}s${i}`, joint: i > 0 ? `${t}footR${foot}j${i - 1}` : `${t}rootR`, centre };
    }
    return { segment: `${t}root`, joint: `t${(k + 1) % teeth}_rootL`, centre: `${t}rootC` };
  };
}
/** A recipe's vertices keyed by repetition `r<k>` and the recipe point `v<i>` each repeats, with the edge `e<i>` from it to the next. */
function recipeKeys({ repeat, points }: Extract<CadPluginOutlineParts, { kind: 'recipe' }>, count: number): (index: number) => VertexKeys {
  if (count !== repeat * points) throw new CadError('invalid-plugin', `The recipe drew ${count} vertices, not ${points} for each of its ${repeat} repetitions.`);
  return index => { const k = Math.floor(index / points), i = index % points; return { vertex: `r${k}_v${i}`, edge: `r${k}_e${i}` }; };
}
/** A plugin's outline keyed by its parts. */
function partsOutput(output: Output, shape: ResolvedCadProfile, parts: CadPluginOutlineParts): void {
  if (parts.kind === 'gear' && shape.kind === 'path') return pathOutput(output, shape.segments, gearKeys(parts, shape.segments.length));
  if (parts.kind === 'recipe' && shape.kind === 'polygon') { polygonOutput(output, shape.points, recipeKeys(parts, shape.points.length)); return; }
  throw new CadError('invalid-plugin', `A ${parts.kind} outline cannot be a ${shape.kind}.`);
}
type Listed = Of<'polygon'> | Of<'path'>;
const entriesOf = (geometry: Listed): readonly unknown[] => geometry.kind === 'polygon' ? geometry.points : geometry.segments;
/** Each entry's id: the one stored for it, or its index. */
const cadSketchEntryIds = (geometry: Listed): readonly number[] => geometry.ids ?? entriesOf(geometry).map((_, index) => index);
// The largest middle of two lists, in entries of each multiplied, compared entry by entry for the entries they share.
const ENTRY_COMPARISON_LIMIT = 1_000_000;
/**
 * `next` with an id for each entry. Ids `next` gives are its own: the caller's correspondence wins. Otherwise each entry `next` holds
 * unchanged keeps its id: those in place, as the common start and end and then the longest common run in order, and then those moved,
 * as the same closed outline from another start holds them. Between two entries kept in place, a gap holding as many changed entries
 * as before keeps their ids in order, as an edit of entries' fields does. A gap that also grows or shrinks is ambiguous, an edit
 * beside an insertion or a removal, so its changed entries take fresh ids and its previous ones leave, with the relations on their
 * members through the confirmable removal: a relation never moves to an entry only guessed to replace its own. Ids that are the indices
 * are not stored.
 */
function identifiedEntries<G extends Listed>(previous: G, next: G): G {
  if (next.ids) return next;
  const before = entriesOf(previous).map(entry => JSON.stringify(entry)), after = entriesOf(next).map(entry => JSON.stringify(entry)), had = cadSketchEntryIds(previous);
  const ids: (number | undefined)[] = new Array(after.length), claimed = new Uint8Array(before.length);
  const keep = (from: number, to: number) => { ids[to] = had[from]; claimed[from] = 1; };
  let start = 0, endBefore = before.length, endAfter = after.length;
  while (start < endBefore && start < endAfter && before[start] === after[start]) { keep(start, start); start++; }
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) keep(--endBefore, --endAfter);
  // The unchanged entries of the middle in place, as pairs of indices in order.
  const pairs: [number, number][] = [], rows = endBefore - start, columns = endAfter - start;
  if (rows * columns <= ENTRY_COMPARISON_LIMIT && rows && columns) {
    const lengths = new Uint32Array((rows + 1) * (columns + 1)), at = (row: number, column: number) => row * (columns + 1) + column;
    for (let row = rows - 1; row >= 0; row--) for (let column = columns - 1; column >= 0; column--)
      lengths[at(row, column)] = before[start + row] === after[start + column] ? lengths[at(row + 1, column + 1)] + 1 : Math.max(lengths[at(row + 1, column)], lengths[at(row, column + 1)]);
    for (let row = 0, column = 0; row < rows && column < columns;) {
      if (before[start + row] === after[start + column]) { pairs.push([start + row, start + column]); keep(start + row, start + column); row++; column++; }
      else if (lengths[at(row + 1, column)] >= lengths[at(row, column + 1)]) row++; else column++;
    }
  }
  // The unchanged entries that moved.
  const moved = new Map<string, number[]>();
  for (let index = start; index < endBefore; index++) if (!claimed[index]) { const list = moved.get(before[index]); if (list) list.push(index); else moved.set(before[index], [index]); }
  for (let index = start; index < endAfter; index++) if (ids[index] === undefined) { const from = moved.get(after[index])?.shift(); if (from !== undefined) keep(from, index); }
  let gapBefore = start, gapAfter = start;
  for (const [matchedBefore, matchedAfter] of [...pairs, [endBefore, endAfter] as [number, number]]) {
    const olds: number[] = [], news: number[] = [];
    for (let index = gapBefore; index < matchedBefore; index++) if (!claimed[index]) olds.push(index);
    for (let index = gapAfter; index < matchedAfter; index++) if (ids[index] === undefined) news.push(index);
    if (olds.length === news.length) olds.forEach((from, at) => keep(from, news[at]));
    gapBefore = matchedBefore + 1; gapAfter = matchedAfter + 1;
  }
  let fresh = Math.max(-1, ...had) + 1;
  for (let index = 0; index < ids.length; index++) if (ids[index] === undefined) ids[index] = fresh++;
  if (fresh - 1 > CAD_SKETCH_ENTRY_ID_MAX) throw invalid(`This ${next.kind} has used every entry id up to ${CAD_SKETCH_ENTRY_ID_MAX}. Detach it, and draw a new one.`);
  const { ids: _none, ...plain } = next;
  return (ids.every((id, index) => id === index) ? plain : { ...plain, ids }) as G;
}
/** The entry after each one in the closed list, or the one before it, by id. */
function neighbours(geometry: Listed, step: 1 | -1): ReadonlyMap<number, number> {
  const ids = cadSketchEntryIds(geometry);
  return new Map(ids.map((id, index) => [id, ids[(index + step + ids.length) % ids.length]]));
}
/**
 * Keys `<prefix><id>` of the entries whose neighbour `step` away differs from `previous` to `next`, such as the polygon edge an
 * inserted vertex splits, which now ends at it.
 */
function rejoined(previous: Listed, next: Listed, step: 1 | -1, prefix: string): ((key: string) => boolean) | undefined {
  const was = neighbours(previous, step), keys = new Set<string>();
  for (const [id, neighbour] of neighbours(next, step)) if (was.has(id) && was.get(id) !== neighbour) keys.add(`${prefix}${id}`);
  return keys.size ? key => keys.has(key) : undefined;
}
/** A shape that passed the legacy checks, with the parts a plugin's outline is made of. */
interface Checked { readonly shape: ResolvedCadProfile; readonly parts?: CadPluginOutlineParts }
// Shapes that passed the legacy checks, most recently used last, by kind and evaluated inputs. Generators with the same inputs, such as
// many copies of one gear, resolve and check their shape once; each still gets members of its own.
const SHAPE_LIMIT = 256;
const shapes = new Map<string, Checked>();
function checked(key: string, resolve: () => Checked, name: string): Checked {
  const kept = shapes.get(key);
  if (kept) { shapes.delete(key); shapes.set(key, kept); return kept; }
  const result = resolve();
  checkCadSketchGeneratorShape(result.shape, name);
  shapes.set(key, result);
  if (shapes.size > SHAPE_LIMIT) shapes.delete(shapes.keys().next().value!);
  return result;
}
/** An evaluation's shape, found or checked when first read and then the same shape for its outline and its members. */
function checkedOnce(key: string, resolve: () => Checked, name: string): () => Checked {
  let kept: Checked | undefined;
  return () => kept ??= checked(key, resolve, name);
}
function shapeEvaluation(key: string, resolve: () => Checked, name: string): CadSketchGeneratorEvaluation {
  const get = checkedOnce(key, resolve, name);
  return { key, shape: () => get().shape, build: (id, construction) => {
    const output = new Output(id, construction), { shape, parts } = get();
    if (parts) partsOutput(output, shape, parts); else profileOutput(output, shape);
    return output.result();
  } };
}
function profileEvaluation(geometry: ResolvedCadProfile, name: string, ids?: readonly number[]): CadSketchGeneratorEvaluation {
  const key = JSON.stringify(geometry), resolve = () => ({ shape: geometry });
  if (!ids) return shapeEvaluation(key, resolve, name);
  const get = checkedOnce(key, resolve, name);
  return { key: `${key}\u0000${JSON.stringify(ids)}`, shape: () => get().shape, build: (id, construction) => {
    const output = new Output(id, construction);
    profileOutput(output, get().shape, ids);
    return output.result();
  } };
}

const NO_OPERANDS: CadSketchOperandSignature = Object.freeze({ slots: Object.freeze([]) });
const noOperands = () => NO_OPERANDS;
/** A parametric profile kind: its geometry evaluates exactly as a legacy profile's does. */
function profileKind<K extends 'rectangle' | 'circle' | 'slot'>(label: string): CadSketchGeneratorKind<Of<K>> {
  return {
    label: () => label, signature: noOperands, operands: () => [], withOperands: geometry => geometry,
    evaluate: (geometry, context, name) => profileEvaluation(resolveCadProfile(geometry as CadProfile, context.parameters), name)
  };
}
/**
 * A listed polygon or path: a profile whose points or segments may carry entry ids, which key their members. A polygon's edge `e<id>`
 * runs from its vertex `v<id>` to the next, so an inserted vertex reshapes the edge before it; a path's segment `s<id>` ends at its
 * joint `j<id>`, so an inserted segment reshapes the one after it, whose start it now is.
 */
function listedKind<K extends 'polygon' | 'path'>(label: string, entry: string, reshaped: CadSketchGeneratorKind<Of<K>>['reshaped']): CadSketchGeneratorKind<Of<K>> {
  return {
    label: () => label, signature: noOperands, operands: () => [], withOperands: geometry => geometry,
    evaluate: (geometry, context, name) => {
      const { ids } = geometry as Listed;
      if (ids && ids.length !== entriesOf(geometry as Listed).length) throw invalid(`${name} needs one entry id for each ${entry}.`);
      return profileEvaluation(resolveCadProfile(geometry as CadProfile, context.parameters), name, ids);
    },
    identify: identifiedEntries, reshaped
  };
}

// A pinned package's text, kept with the frozen package it was read from.
const packageTexts = new WeakMap<object, string>();
function packageText(plugin: object): string {
  let text = packageTexts.get(plugin);
  if (text === undefined) { text = JSON.stringify(plugin); if (Object.isFrozen(plugin)) packageTexts.set(plugin, text); }
  return text;
}
/**
 * A plugin instance generates through the plugin's own API, `resolveCadPluginOutline`, which checks its inputs against the pinned
 * package's rules and generates its outline: a recipe's vertices or the built-in gear's lines and arcs, with the teeth or repetitions
 * it is made of, which key its members. Its key is the package and the evaluated inputs, so an unchanged instance is not generated
 * again; an input that does not evaluate is left to the plugin to refuse.
 */
const plugin: CadSketchGeneratorKind<Of<'plugin'>> = {
  label: geometry => geometry.package.name, signature: noOperands, operands: () => [], withOperands: geometry => geometry,
  evaluate: (geometry, context, name) => {
    let values: string;
    try { values = JSON.stringify(Object.entries(geometry.inputs).map(([input, value]) => [input, evaluateCadScalar(value, context.parameters)])); }
    catch { values = `unevaluated ${JSON.stringify(geometry.inputs)}`; }
    return shapeEvaluation(`plugin\u0000${packageText(geometry.package)}\u0000${values}`,
      () => resolveCadPluginOutline(geometry as unknown as CadPluginProfile, context.parameters), name);
  }
};

const REGULAR_POLYGON_SIGNATURE = Object.freeze<CadSketchOperandSignature>({ generates: true,
  slots: [{ role: 'Direction', accepts: ['line'], refusal: { code: 'invalid-sketch-generator', message: 'A regular polygon needs a line or the H or V axis for its direction.' } }] });
/** At most this many sides, as a recipe plugin may generate at most 2048 vertices. */
export const CAD_SKETCH_REGULAR_POLYGON_MAX_SIDES = 1024;
/**
 * A regular polygon: vertices `v<i>` counterclockwise from the one along its direction, edges `e<i>` from each to the next, and each
 * edge's length equal to the first's.
 */
const regularPolygon: CadSketchGeneratorKind<Of<'regular-polygon'>> = {
  label: () => 'Regular polygon',
  signature: () => REGULAR_POLYGON_SIGNATURE,
  operands: geometry => [geometry.directionId],
  withOperands: (geometry, [directionId]) => ({ ...geometry, directionId }),
  evaluate: (geometry, context, name) => {
    const e = (value: number | string) => evaluateCadScalar(value, context.parameters);
    const x = e(geometry.x), y = e(geometry.y), radius = e(geometry.radius), sides = e(geometry.sides);
    if (!Number.isInteger(sides) || sides < 3 || sides > CAD_SKETCH_REGULAR_POLYGON_MAX_SIDES)
      throw invalid(`${name} needs a whole number of sides from 3 to ${CAD_SKETCH_REGULAR_POLYGON_MAX_SIDES}.`);
    if (!cadSupportedLength(radius)) throw invalid(`${name} needs a positive supported radius.`);
    const line = context.line(geometry.directionId);
    if (!line) throw invalid(`${name} needs a line or the H or V axis for its direction.`);
    const angle = Math.atan2(line.end.y - line.start.y, line.end.x - line.start.x);
    const points = Array.from({ length: sides }, (_, index): [number, number] => {
      const turn = angle + 2 * Math.PI * index / sides;
      return [x + radius * Math.cos(turn), y + radius * Math.sin(turn)];
    });
    const key = `regular-polygon\u0000${JSON.stringify([x, y, radius, sides, angle])}`;
    const get = checkedOnce(key, () => ({ shape: { kind: 'polygon', points } }), name), shape = () => get().shape;
    return { key, shape, build: (id, construction) => {
      shape();
      const output = new Output(id, construction), edges = polygonOutput(output, points);
      for (let index = 1; index < edges.length; index++) output.relation(`q${index}`, { kind: 'equal-length', lineIds: [edges[0], edges[index]] });
      return output.result();
    } };
  }
};

/** A sketch id is at most this long, as `CadIdentifierSchema` allows. */
const SKETCH_ID_LENGTH_MAX = 96;
/** `id`, refusing a member id longer than a sketch id may be, naming the generator. */
function checkedIds(id: (key: string) => string, name: string): (key: string) => string {
  return key => {
    const result = id(key);
    if (result.length > SKETCH_ID_LENGTH_MAX) throw invalid(`${name} cannot name its member "${key}" within ${SKETCH_ID_LENGTH_MAX} characters. Give it a shorter id prefix.`);
    return result;
  };
}
/** The points a curve is drawn through: its ends, then its centre, as its traits give them. */
function curvePointIds(curve: CadSketchGraphEntity): readonly string[] {
  const { ends, centre } = cadSketchCurveTraits(curve);
  return centre === null ? ends ?? [] : [...ends ?? [], centre];
}
/**
 * `curve` copied as `id` through `point`, which names the copy of each of its points, with the evaluated `radius` of a circle: a kind
 * of curve added to the graph says here how it is copied.
 */
function copiedCurve(curve: CadSketchGraphEntity, id: string, point: (pointId: string) => string, construction: boolean, radius: number): CadSketchGraphEntity {
  switch (curve.kind) {
    case 'line': return { id, kind: 'line', construction, startPointId: point(curve.startPointId), endPointId: point(curve.endPointId) };
    case 'arc': return { id, kind: 'arc', construction, centerPointId: point(curve.centerPointId), startPointId: point(curve.startPointId), endPointId: point(curve.endPointId), direction: curve.direction };
    case 'circle': return { id, kind: 'circle', construction, centerPointId: point(curve.centerPointId), radius };
    default: { const unknown: never = curve; throw invalid(`A ${(unknown as { kind: string }).kind} cannot be copied yet.`); }
  }
}
/** Curves with the points they are drawn through, at their evaluated positions, and the relations among them: what a copy reads. */
type Inputs = CadSketchGeneratedGeometry;
function inputsOf(curves: readonly CadSketchGraphEntity[], context: CadSketchGeneratorContext, name: string): Inputs {
  const points: CadSketchGraphPoint[] = [], seen = new Set<string>();
  for (const curve of curves) for (const id of curvePointIds(curve)) {
    if (seen.has(id)) continue;
    seen.add(id);
    const at = context.point(id);
    if (!at) throw invalid(`${name} cannot find the point "${id}" that "${curve.id}" is drawn through.`);
    points.push({ id, position: [at.x, at.y] });
  }
  for (const curve of curves) seen.add(curve.id);
  return { points, entities: curves, relations: context.relationsAmong(seen) };
}
/** The curves `ids` name, refused naming the generator and the curve's role when one is no curve of the sketch. */
function curvesOf(ids: readonly string[], context: CadSketchGeneratorContext, name: string, role: string): readonly CadSketchGraphEntity[] {
  return ids.map(id => {
    const curve = context.curve(id);
    if (!curve) throw invalid(`${name} needs a curve of the sketch for ${role} "${id}".`);
    return curve;
  });
}
/** Adds the relations among `inputs` that `copy` keeps, by each kind's copy rule. */
function copyRelations(output: Output, inputs: Inputs, copy: CadSketchRelationCopy): void {
  if (inputs.relations.length) output.relations.push(...copiedCadSketchRelations(copyCadSketchRelations(inputs, copy)));
}

/** One slot for each of `count` curves, which must differ, then the slots `after` them. */
function curveListSignature(count: number, slot: CadSketchOperandSlot, repeated: string, after: readonly CadSketchOperandSlot[] = []): CadSketchOperandSignature {
  return Object.freeze<CadSketchOperandSignature>({ generates: true, slots: Object.freeze([...Array.from({ length: count }, () => slot), ...after]),
    distinct: { slots: Array.from({ length: count }, (_, index) => index), refusal: { code: 'invalid-sketch-generator', message: repeated } } });
}
const curveSlot = (role: string, message: string): CadSketchOperandSlot =>
  Object.freeze<CadSketchOperandSlot>({ role, accepts: ['curve'], needs: ['movable'], refusal: { code: 'invalid-sketch-generator', message } });
const SEED_SLOT = curveSlot('Seed', 'A circular pattern copies curves of the sketch.');
const CENTRE_SLOT = Object.freeze<CadSketchOperandSlot>({ role: 'Centre', accepts: ['point'],
  refusal: { code: 'invalid-sketch-generator', message: 'A circular pattern turns about a point of the sketch or the origin.' } });
const LINK_SLOT = curveSlot('Chain curve', 'An offset follows a closed chain of curves of the sketch.');

/** At most this many occurrences of a circular pattern, its seeds' own among them. */
export const CAD_SKETCH_CIRCULAR_PATTERN_MAX_COUNT = 360;
/** At most this many curves a circular pattern copies in all its occurrences. */
export const CAD_SKETCH_CIRCULAR_PATTERN_MAX_COPIES = 4096;
/**
 * A circular pattern. Occurrence 0 is the seeds themselves; occurrence k copies each seed curve turned about the centre k steps, as the
 * curve `i<k>_<seed id>` through points `i<k>_<point id>`, so seeds that share a point share its copy, and copies each relation among the
 * seeds that a pattern keeps, a reference dimension, as `i<k>_<relation id>`. Keys hold the occurrence and what it copies, never a place
 * among the seeds, so a count change keeps the occurrences that stay, and a seed list change the copies of the seeds that stay. A copy is
 * construction when the pattern or its seed is.
 */
const circularPattern: CadSketchGeneratorKind<Of<'circular-pattern'>> = {
  label: () => 'Circular pattern',
  signature: geometry => curveListSignature(geometry.seedIds.length, SEED_SLOT, 'A circular pattern copies each seed once.', [CENTRE_SLOT]),
  operands: geometry => [...geometry.seedIds, geometry.centerId],
  withOperands: (geometry, ids) => ({ ...geometry, seedIds: ids.slice(0, geometry.seedIds.length), centerId: ids[geometry.seedIds.length] }),
  evaluate: (geometry, context, name) => {
    const count = evaluateCadScalar(geometry.count, context.parameters), angle = evaluateCadScalar(geometry.angle, context.parameters);
    if (!Number.isInteger(count) || count < 1 || count > CAD_SKETCH_CIRCULAR_PATTERN_MAX_COUNT)
      throw invalid(`${name} needs a whole number of occurrences from 1 to ${CAD_SKETCH_CIRCULAR_PATTERN_MAX_COUNT}, the seeds' own among them.`);
    if (!Number.isFinite(angle) || angle === 0 || Math.abs(angle) > 360) throw invalid(`${name} needs a nonzero angle of at most 360 degrees either way.`);
    const copies = (count - 1) * geometry.seedIds.length;
    if (copies > CAD_SKETCH_CIRCULAR_PATTERN_MAX_COPIES)
      throw invalid(`${name} would copy ${copies} curves; a circular pattern copies at most ${CAD_SKETCH_CIRCULAR_PATTERN_MAX_COPIES}.`);
    const centre = context.point(geometry.centerId);
    if (!centre) throw invalid(`${name} needs a point of the sketch or the origin to turn about.`);
    const seeds = curvesOf(geometry.seedIds, context, name, 'its seed'), inputs = inputsOf(seeds, context, name);
    const radii = seeds.map(seed => seed.kind === 'circle' ? evaluateCadScalar(seed.radius, context.parameters) : 0);
    // A full turn spaces the occurrences a turn over the count apart; a shorter angle puts the last at its end.
    const step = (Math.abs(angle) === 360 ? angle / count : count > 1 ? angle / (count - 1) : 0) * Math.PI / 180;
    const key = `circular-pattern\u0000${JSON.stringify([centre.x, centre.y, count, step, radii, inputs])}`;
    return { key, build: (id, construction) => {
      const member = checkedIds(id, name), output = new Output(member, construction);
      for (let k = 1; k < count; k++) {
        const cos = Math.cos(step * k), sin = Math.sin(step * k), points = new Map<string, string>(), curves = new Map<string, CadSketchRemapPiece>();
        for (const { id: pointId, position } of inputs.points) {
          const dx = (position[0] as number) - centre.x, dy = (position[1] as number) - centre.y;
          points.set(pointId, output.point(`i${k}_${pointId}`, [centre.x + dx * cos - dy * sin, centre.y + dx * sin + dy * cos]));
        }
        seeds.forEach((seed, at) => {
          const copy = copiedCurve(seed, member(`i${k}_${seed.id}`), pointId => points.get(pointId)!, construction || seed.construction, radii[at]);
          output.entities.push(copy);
          curves.set(seed.id, { entityId: copy.id, interval: [0, 1], orientation: 'same' });
        });
        copyRelations(output, inputs, { kind: 'pattern', curves, points, relationId: relation => member(`i${k}_${relation.id}`) });
      }
      return output.result();
    } };
  }
};

/** A chain link as a path segment, the way the chain runs it. */
function chainSegment(curve: CadSketchGraphEntity, reversed: boolean, index: number, at: (id: string) => Point2, radius: number): PathSegment {
  const common = { id: curve.id, source: { sourceEntityIndex: index, sourceEntityType: curve.kind, layer: null, exact: true } };
  switch (curve.kind) {
    case 'line': {
      const start = at(curve.startPointId), end = at(curve.endPointId);
      return createLineSegment({ ...common, start: reversed ? end : start, end: reversed ? start : end });
    }
    case 'arc': {
      const start = at(curve.startPointId), end = at(curve.endPointId);
      return createArcSegment({ ...common, center: at(curve.centerPointId), start: reversed ? end : start, end: reversed ? start : end,
        clockwise: (curve.direction === 'cw') !== reversed });
    }
    case 'circle': return createCircleSegment({ ...common, center: at(curve.centerPointId), radius });
    default: { const unknown: never = curve; throw invalid(`An offset cannot follow a ${(unknown as { kind: string }).kind} yet.`); }
  }
}
/** A closed loop as the profile shape it draws. */
function resolvedLoop(edges: readonly PathSegment[]): ResolvedCadProfile {
  const [first] = edges;
  return first.kind === 'circle' ? { kind: 'circle', x: first.center.x, y: first.center.y, radius: first.radius } : { kind: 'path', segments: edges.map(cadSketchOffsetPathSegment) };
}
/** The signed area a closed chain encloses, positive when it runs counterclockwise. */
function chainArea(edges: readonly PathSegment[]): number {
  if (edges.length === 1 && edges[0].kind === 'circle') return Math.PI * edges[0].radius ** 2;
  return cadAnalyticPathMetrics({ kind: 'path', segments: edges.map(cadSketchOffsetPathSegment) }).signedArea;
}
/**
 * A linked offset: its closed chain offset by the distance, outward when it is positive, whichever way the chain runs, and generated
 * again whenever the chain moves. Link `<id>` gives the edge `e_<id>`, its arc's centre `c_<id>` and the joint `j_<id>` where it ends
 * and the next link's edge starts, so keys follow the chain's curves, not their places in it. Each relation among the chain that an
 * offset keeps, a direction, an angle or a smooth joint, is copied as `r_<relation id>`. A chain left open or crossing itself, or one it
 * cannot offset exactly, is refused with the reason.
 */
const offset: CadSketchGeneratorKind<Of<'offset'>> = {
  label: () => 'Offset',
  signature: geometry => curveListSignature(geometry.chain.length, LINK_SLOT, 'An offset\'s chain runs along each curve once.'),
  operands: geometry => geometry.chain.map(link => link.entityId),
  withOperands: (geometry, ids) => ({ ...geometry, chain: geometry.chain.map((link, at) => ({ ...link, entityId: ids[at] })) }),
  evaluate: (geometry, context, name) => {
    const distance = evaluateCadScalar(geometry.distance, context.parameters);
    if (!Number.isFinite(distance) || distance === 0) throw invalid(`${name} needs a nonzero distance.`);
    const links = geometry.chain.map(link => link.entityId), curves = curvesOf(links, context, name, 'its chain curve'), inputs = inputsOf(curves, context, name);
    if (curves.length > 1 && curves.some(curve => !cadSketchCurveTraits(curve).ends)) throw invalid(`${name} needs a circle alone, or a chain of curves with ends.`);
    const radii = curves.map(curve => curve.kind === 'circle' ? evaluateCadScalar(curve.radius, context.parameters) : 0);
    const key = `offset\u0000${JSON.stringify([distance, geometry.chain, radii, inputs])}`;
    const get = checkedOnce(key, () => {
      const positions = new Map(inputs.points.map(point => [point.id, { x: point.position[0] as number, y: point.position[1] as number }]));
      const edges = curves.map((curve, index) => chainSegment(curve, geometry.chain[index].reversed, index, id => positions.get(id)!, radii[index]));
      if (edges[0].kind !== 'circle') edges.forEach((edge, index) => {
        const next = edges[(index + 1) % edges.length];
        if (Math.hypot(edge.end.x - next.start.x, edge.end.y - next.start.y) > cadPathClosureTolerance([edge.end, next.start]))
          throw invalid(`${name} needs a closed chain, but "${links[index]}" does not end where "${links[(index + 1) % links.length]}" starts.`);
      });
      const area = chainArea(edges);
      if (!Number.isFinite(area) || area === 0) throw invalid(`${name} needs a chain that encloses an area.`);
      try { checkCadSketchGeneratorShape(resolvedLoop(edges), 'chain'); }
      catch (error) { throw invalid(`${name} needs a simple closed chain: ${error instanceof Error ? error.message : 'it cannot be checked.'}`); }
      // To the right of a counterclockwise chain is outward.
      let result: readonly PathSegment[];
      try { result = offsetCadSketchLoop(edges, area > 0 ? distance : -distance).edges; }
      catch (error) {
        // The reason a detached offset of the chain gives, with its code, named for the generator.
        if (error instanceof CadError) throw new CadError(error.code, `${name}: ${error.message}`);
        throw invalid(`${name}: the chain cannot be offset exactly.`);
      }
      const after = chainArea(result);
      if (Math.sign(after) !== Math.sign(area) || (Math.abs(after) > Math.abs(area)) !== (distance > 0))
        throw invalid(`${name} cannot keep its offset on the side it asks for: the chain is too small for it.`);
      return { shape: resolvedLoop(result) };
    }, name), shape = () => get().shape;
    return { key, shape, build: (id, construction) => {
      const outline = shape(), member = checkedIds(id, name), output = new Output(member, construction);
      const points = new Map<string, string>(), copies = new Map<string, CadSketchRemapPiece>(), count = links.length;
      if (outline.kind === 'circle') {
        const centre = output.point(`c_${links[0]}`, [outline.x, outline.y]);
        output.circle(`e_${links[0]}`, centre, outline.radius);
        points.set(curvePointIds(curves[0])[0], centre);
      } else if (outline.kind === 'path') {
        // Link i runs from the joint after the link before it to its own, about its own centre when it is an arc.
        pathOutput(output, outline.segments, index => ({ segment: `e_${links[index]}`, joint: `j_${links[index]}`, centre: `c_${links[index]}` }));
        curves.forEach((curve, index) => {
          const [from, to, centre] = curvePointIds(curve), start = member(`j_${links[(index + count - 1) % count]}`), end = member(`j_${links[index]}`);
          points.set(geometry.chain[index].reversed ? to : from, start); points.set(geometry.chain[index].reversed ? from : to, end);
          if (centre !== undefined) points.set(centre, member(`c_${links[index]}`));
        });
      }
      geometry.chain.forEach(link => copies.set(link.entityId, { entityId: member(`e_${link.entityId}`), interval: [0, 1], orientation: link.reversed ? 'reversed' : 'same' }));
      copyRelations(output, inputs, { kind: 'offset', curves: copies, points, relationId: relation => member(`r_${relation.id}`) });
      return output.result();
    } };
  }
};

export const CAD_SKETCH_GENERATOR_KINDS: { readonly [K in CadSketchGeneratorGeometry['kind']]: CadSketchGeneratorKind<Of<K>> } = {
  plugin,
  rectangle: profileKind<'rectangle'>('Rectangle'),
  circle: profileKind<'circle'>('Circle'),
  polygon: listedKind<'polygon'>('Polygon', 'point', (previous, next) => rejoined(previous, next, 1, 'e')),
  path: listedKind<'path'>('Path', 'segment', (previous, next) => rejoined(previous, next, -1, 's')),
  slot: profileKind<'slot'>('Slot'),
  'regular-polygon': regularPolygon,
  'circular-pattern': circularPattern,
  offset
};
