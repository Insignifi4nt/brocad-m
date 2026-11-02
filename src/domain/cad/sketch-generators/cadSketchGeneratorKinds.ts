import type { CadProfile } from '../cadDocument';
import { CadError } from '../cadError';
import { evaluateCadScalar } from '../cadExpression';
import { cadOrderedCurveEntities, type ResolvedCadPathSegment } from '../cadAnalyticSegments';
import type { CadSketchGeneratorGeometry, CadSketchGraphEntity, CadSketchGraphPoint, CadSketchGraphRelation } from '../cadSketchGraph';
import { resolveCadProfile, validateCadSketchGeometry, type ResolvedCadProfile } from '../cadSketchGeometry';
import { resolveCadPluginOutline, type CadPluginOutlineParts, type CadPluginProfile } from '../plugins/cadPlugins';
import type { CadSketchOperandSignature, CadSketchRelationIntent } from '../sketch-relations/cadSketchRelationTypes';
import { CAD_PRECISION, cadSupportedLength } from '@/domain/precision/cadPrecision';
import type { Point2 } from '@/domain/path-intel/types';

// Each kind of generator: what it reads and what it generates. Generation keys every point, edge and relation by its place in the
// shape, never by coordinates or by its place among samples, so regenerating after an input change keeps each id `<idPrefix>_<key>`
// while the shape keeps that part: tooth 3's tip stays `t3_tip` however many teeth the gear has. A part that changes kind, such as a
// rectangle's corner that becomes an arc, takes a new key, and so do the chords of a curve sampled anew. Profile kinds generate exactly
// what a legacy profile of that geometry resolves to, after the same checks, so their regions and solids build as before.

/** Points, edges and relations a generator makes, with their final ids. */
export interface CadSketchGeneratedGeometry {
  readonly points: readonly CadSketchGraphPoint[];
  readonly entities: readonly CadSketchGraphEntity[];
  readonly relations: readonly CadSketchGraphRelation[];
}
/** What generation reads beyond the record: the parameters, and the sketch's lines an operand names. */
export interface CadSketchGeneratorContext {
  readonly parameters: Readonly<Record<string, number>>;
  /** The evaluated ends of the line `id` names, an axis as a unit step from the origin; undefined when it names no line. */
  line(id: string): { readonly start: Point2; readonly end: Point2 } | undefined;
}
/** A generator's inputs, evaluated: `key` holds everything generation reads, so equal keys generate equal geometry. */
export interface CadSketchGeneratorEvaluation {
  readonly key: string;
  readonly build: (id: (key: string) => string, construction: boolean) => CadSketchGeneratedGeometry;
  /**
   * The closed outline its edges draw, as the legacy profile shape it was checked as: closed, of positive area and free of
   * self-intersection. Its region reads as that shape does.
   */
  readonly shape: () => ResolvedCadProfile;
}
export interface CadSketchGeneratorKind<G extends CadSketchGeneratorGeometry> {
  /** Sentence-case name of what it generates, as people and agents are told: a plugin's package name. */
  readonly label: (geometry: G) => string;
  /** The sketch elements it reads, as operand slots in `operands` order: one signature for the kind. */
  readonly signature: CadSketchOperandSignature;
  readonly operands: (geometry: G) => readonly string[];
  readonly withOperands: (geometry: G, ids: readonly string[]) => G;
  /** Its inputs evaluated now, refused with the reason when out of range; `name` names the generator in a refusal. */
  readonly evaluate: (geometry: G, context: CadSketchGeneratorContext, name: string) => CadSketchGeneratorEvaluation;
  /**
   * The keys whose part of the shape `next` changes though the key stays, which settling takes through the relation remap as members
   * that leave: in a list of points or segments that grows or shrinks, those from the first entry that changed on. Undefined when each
   * key keeps its part.
   */
  readonly renumbered?: (previous: G, next: G) => ((key: string) => boolean) | undefined;
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

/** The legacy checks of one profile: sizes, closure, zero area and self-intersection, refused with the reasons a profile gives. */
function validateProfile(geometry: ResolvedCadProfile, name: string): void {
  validateCadSketchGeometry({ id: 'generator', name, kind: 'sketch', suppressed: false, plane: 'XY', offset: 0,
    profiles: [{ id: 'generator', name, construction: false, geometry: geometry as CadProfile }] }, {});
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
function profileOutput(output: Output, geometry: ResolvedCadProfile): void {
  switch (geometry.kind) {
    case 'rectangle': return rectangleOutput(output, geometry);
    case 'circle': return circleOutput(output, [geometry.x, geometry.y], geometry.radius);
    case 'slot': return slotOutput(output, geometry);
    case 'polygon': polygonOutput(output, geometry.points); return;
    case 'path': return pathOutput(output, geometry.segments);
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
/**
 * Keys of a listed polygon's or path's members from the first entry that changed on, when the list grows or shrinks: a vertex or
 * segment there is no longer the one the key named, so the user relations on it are taken through the remap. A list of the same length
 * keeps every key, as an edit of one entry's fields does.
 */
function listRenumbered(previous: readonly unknown[], next: readonly unknown[], pattern: RegExp): ((key: string) => boolean) | undefined {
  if (previous.length === next.length) return undefined;
  let first = 0;
  while (first < Math.min(previous.length, next.length) && JSON.stringify(previous[first]) === JSON.stringify(next[first])) first++;
  return key => { const match = pattern.exec(key); return match !== null && Number(match[1]) >= first; };
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
  validateProfile(result.shape, name);
  shapes.set(key, result);
  if (shapes.size > SHAPE_LIMIT) shapes.delete(shapes.keys().next().value!);
  return result;
}
function shapeEvaluation(key: string, resolve: () => Checked, name: string): CadSketchGeneratorEvaluation {
  return { key, shape: () => checked(key, resolve, name).shape, build: (id, construction) => {
    const output = new Output(id, construction), { shape, parts } = checked(key, resolve, name);
    if (parts) partsOutput(output, shape, parts); else profileOutput(output, shape);
    return output.result();
  } };
}
function profileEvaluation(geometry: ResolvedCadProfile, name: string): CadSketchGeneratorEvaluation {
  return shapeEvaluation(JSON.stringify(geometry), () => ({ shape: geometry }), name);
}

const NO_OPERANDS: CadSketchOperandSignature = Object.freeze({ slots: Object.freeze([]) });
/** A parametric profile kind: its geometry evaluates exactly as a legacy profile's does. */
function profileKind<K extends 'rectangle' | 'circle' | 'slot' | 'polygon' | 'path'>(label: string, renumbered?: CadSketchGeneratorKind<Of<K>>['renumbered']): CadSketchGeneratorKind<Of<K>> {
  return {
    label: () => label, signature: NO_OPERANDS, operands: () => [], withOperands: geometry => geometry,
    evaluate: (geometry, context, name) => profileEvaluation(resolveCadProfile(geometry as CadProfile, context.parameters), name),
    ...renumbered ? { renumbered } : {}
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
  label: geometry => geometry.package.name, signature: NO_OPERANDS, operands: () => [], withOperands: geometry => geometry,
  evaluate: (geometry, context, name) => {
    let values: string;
    try { values = JSON.stringify(Object.entries(geometry.inputs).map(([input, value]) => [input, evaluateCadScalar(value, context.parameters)])); }
    catch { values = `unevaluated ${JSON.stringify(geometry.inputs)}`; }
    return shapeEvaluation(`plugin\u0000${packageText(geometry.package)}\u0000${values}`,
      () => resolveCadPluginOutline(geometry as unknown as CadPluginProfile, context.parameters), name);
  }
};

/** At most this many sides, as a recipe plugin may generate at most 2048 vertices. */
export const CAD_SKETCH_REGULAR_POLYGON_MAX_SIDES = 1024;
/**
 * A regular polygon: vertices `v<i>` counterclockwise from the one along its direction, edges `e<i>` from each to the next, and each
 * edge's length equal to the first's.
 */
const regularPolygon: CadSketchGeneratorKind<Of<'regular-polygon'>> = {
  label: () => 'Regular polygon',
  signature: { generates: true, slots: [{ role: 'Direction', accepts: ['line'], refusal: { code: 'invalid-sketch-generator', message: 'A regular polygon needs a line or the H or V axis for its direction.' } }] },
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
    const shape = () => checked(key, () => ({ shape: { kind: 'polygon', points } }), name).shape;
    return { key, shape, build: (id, construction) => {
      shape();
      const output = new Output(id, construction), edges = polygonOutput(output, points);
      for (let index = 1; index < edges.length; index++) output.relation(`q${index}`, { kind: 'equal-length', lineIds: [edges[0], edges[index]] });
      return output.result();
    } };
  }
};

export const CAD_SKETCH_GENERATOR_KINDS: { readonly [K in CadSketchGeneratorGeometry['kind']]: CadSketchGeneratorKind<Of<K>> } = {
  plugin,
  rectangle: profileKind<'rectangle'>('Rectangle'),
  circle: profileKind<'circle'>('Circle'),
  polygon: profileKind<'polygon'>('Polygon', (previous, next) => listRenumbered(previous.points, next.points, /^[ve](\d+)$/)),
  path: profileKind<'path'>('Path', (previous, next) => listRenumbered(previous.segments, next.segments, /^[sjc](\d+)$/)),
  slot: profileKind<'slot'>('Slot'),
  'regular-polygon': regularPolygon
};
