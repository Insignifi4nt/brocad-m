/**
 * Chain selection over curves that meet at shared vertices, for sketch edges and solid edges alike. A curve's ends name vertices; two ends
 * naming the same vertex meet there, so a coincident identity is one vertex. The walk runs both ways from a seed and continues through a
 * vertex only while exactly one curve may follow; where two or more may, it stops and reports the vertex rather than choose one.
 *
 * Which curves may follow depends on the mode. A contour counts every eligible curve at the vertex, so a T junction stops it. A tangent
 * chain counts only the curves continuing smoothly, as SOLIDWORKS Select Tangency and native fillet propagation do: a curve leaving at a
 * corner neither stops it nor is reported, and two smooth continuations stop it and are reported.
 */
export type CadChainVector = readonly number[];
export type CadChainEnd = 'start' | 'end';
export interface CadChainCurve {
  readonly id: string;
  /** The vertices at the curve's start and end; a closed curve names one vertex twice. */
  readonly vertices: readonly [string, string];
  /** Unit tangents at the start and the end, both pointing in the curve's own direction; `null` where none is defined. */
  readonly tangents: readonly [CadChainVector | null, CadChainVector | null];
}
/** `tangent` follows smooth joins only; `contour` follows every join, giving the whole connected loop or open path. */
export type CadChainMode = 'tangent' | 'contour';
export interface CadChainOptions<Curve extends CadChainCurve> {
  readonly mode: CadChainMode;
  /** Whether the walk may pass through a join without turning; required for `tangent`. */
  readonly smooth?: (join: CadChainJoin<Curve>) => boolean;
  /** Which curves may join the seed's chain at all, such as construction curves only when the seed is one. Never asked of the seed. */
  readonly eligible?: (curve: Curve, seed: Curve) => boolean;
}
export interface CadChainResult {
  readonly seedId: string;
  /** Members in order along the chain, from one end to the other, or round the loop from the seed when closed. */
  readonly ids: readonly string[];
  readonly closed: boolean;
  /** Vertices where the walk stopped because more than one curve could follow; in a tangent chain, only smooth continuations count. */
  readonly branches: readonly string[];
}
/** A join the walk may pass: it arrives along `arriving` through `from`'s `fromEnd` and would leave along `leaving` through `to`'s `toEnd`. */
export interface CadChainJoin<Curve extends CadChainCurve> {
  readonly vertex: string;
  readonly arriving: CadChainVector;
  readonly leaving: CadChainVector;
  readonly from: Curve;
  readonly fromEnd: CadChainEnd;
  readonly to: Curve;
  readonly toEnd: CadChainEnd;
}
interface Incidence<Curve> { readonly curve: Curve; readonly end: CadChainEnd }
export interface CadChainGraph<Curve extends CadChainCurve = CadChainCurve> {
  readonly curves: ReadonlyMap<string, Curve>;
  readonly incidences: ReadonlyMap<string, readonly Incidence<Curve>[]>;
}

/** The vertex index of `curves`, built once and walked by every chain read from it. */
export function cadChainGraph<Curve extends CadChainCurve>(curves: readonly Curve[]): CadChainGraph<Curve> {
  const byId = new Map<string, Curve>(), incidences = new Map<string, Incidence<Curve>[]>();
  for (const curve of curves) {
    if (byId.has(curve.id)) throw new Error(`Chain curve "${curve.id}" appears twice.`);
    byId.set(curve.id, curve);
    for (const end of ['start', 'end'] as const) {
      const vertex = curve.vertices[end === 'start' ? 0 : 1], list = incidences.get(vertex);
      if (list) list.push({ curve, end }); else incidences.set(vertex, [{ curve, end }]);
    }
  }
  return { curves: byId, incidences };
}

const negate = (vector: CadChainVector) => vector.map(value => -value);
/** The direction of travel leaving a curve through `end`, or entering it from there when `entering`. */
function travel(curve: CadChainCurve, end: CadChainEnd, entering: boolean): CadChainVector | null {
  const tangent = curve.tangents[end === 'start' ? 0 : 1];
  if (!tangent) return null;
  // Leaving through the end runs along the curve; leaving through the start runs against it. Entering is the reverse.
  return (end === 'end') !== entering ? tangent : negate(tangent);
}
const other = (end: CadChainEnd): CadChainEnd => end === 'start' ? 'end' : 'start';

/**
 * The chain through `seedId`. A seed the graph lacks gives an empty chain. Each step looks only at the curves meeting the current vertex,
 * so a chain costs time in proportion to its length and the joins along it.
 */
export function cadSelectionChain<Curve extends CadChainCurve>(graph: CadChainGraph<Curve>, seedId: string, options: CadChainOptions<Curve>): CadChainResult {
  const seed = graph.curves.get(seedId);
  if (!seed) return { seedId, ids: [], closed: false, branches: [] };
  if (options.mode === 'tangent' && !options.smooth) throw new Error('A tangent chain needs a smoothness test.');
  const visited = new Set<string>([seed.id]), branches: string[] = [];
  // From a curve leaving through `end`, the one curve that may follow, `'seed'` when the walk is back at the seed, or `null` where it stops.
  const step = (curve: Curve, end: CadChainEnd): Incidence<Curve> | 'seed' | null => {
    const vertex = curve.vertices[end === 'start' ? 0 : 1];
    const arriving = travel(curve, end, false);
    const next: Incidence<Curve>[] = [];
    let closes = false;
    for (const incidence of graph.incidences.get(vertex) ?? []) {
      if (incidence.curve === curve && incidence.end === end) continue;
      if (incidence.curve !== seed && options.eligible && !options.eligible(incidence.curve, seed)) continue;
      if (options.mode === 'tangent') {
        const leaving = travel(incidence.curve, incidence.end, true);
        if (!arriving || !leaving || !options.smooth!({ vertex, arriving, leaving, from: curve, fromEnd: end, to: incidence.curve, toEnd: incidence.end })) continue;
      }
      if (incidence.curve === seed) closes = true;
      next.push(incidence);
    }
    if (next.length > 1) { branches.push(vertex); return null; }
    if (!next.length) return null;
    return closes ? 'seed' : next[0];
  };
  const walk = (end: CadChainEnd): { ids: string[]; closed: boolean } => {
    const ids: string[] = [];
    let curve = seed, exit = end;
    for (;;) {
      const next = step(curve, exit);
      if (next === 'seed') return { ids, closed: true };
      if (!next || visited.has(next.curve.id)) return { ids, closed: false };
      visited.add(next.curve.id); ids.push(next.curve.id);
      curve = next.curve; exit = other(next.end);
    }
  };
  const forward = walk('end');
  if (forward.closed) return { seedId, ids: [seed.id, ...forward.ids], closed: true, branches: [...new Set(branches)] };
  const backward = walk('start');
  return { seedId, ids: [...backward.ids.reverse(), seed.id, ...forward.ids], closed: false, branches: [...new Set(branches)] };
}
