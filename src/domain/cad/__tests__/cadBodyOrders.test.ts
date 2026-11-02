import { describe, expect, it } from 'vitest';
import type { CadDocument, CadFeature } from '../cadDocument';
import { createCadDocument, parseCadDocument } from '../cadSchema';
import {
  createCadBodyLineage, resolveCadBodyRef, type CadBodyIssue, type CadBodyKernelFacts, type CadBodyKey, type CadBodyLineage, type CadBodySolidSource,
  type CadBodySource, type CadBodyState
} from '../cadBodies';
import { cadBodyKeyVariants } from './cadBodyKeyVariants';

/**
 * An oracle for kernel solid orders. A small model of the kernel builds generated histories of one body, where each solid stands for its
 * geometry and keeps its faces in an order of its own. The kernel may list the body's first solids, each Boolean's result and each join's
 * tool in any order, and a face's rank is its place in its source's face order, so faces of different solids rank in the order the source
 * lists them, as the kernel's do. Building a history in every combination of those orders shows what each key truly names after each
 * feature: nothing when no combination has it as a piece, one solid when every combination has it as that solid, and otherwise the solids
 * it is a piece as in some combination. The resolver must give exactly that, but for one stated superset: a provenance group the key can
 * reach may add its pieces, since a solid keeping no face of the body may continue any member, which no order shows. A key reaches a group
 * holding it, or holding a key that was a piece as the same solid as it in some combination after some feature so far. Keys are those any
 * combination lists after the feature or before it, and every key formed from one by changing the indices of any of its split steps. A
 * history with too many combinations is built in a sample of them, where every key must resolve the same way in each and stand for every
 * solid the sample shows it is a piece as.
 *
 * Every combination must report the same lost keys, each one naming a solid before the feature and none after it. Built in every
 * combination, with no group before the feature or after it, the keys reported lost are exactly those some combination had as a piece
 * before, none has as a piece after, and whose solids no solid of the result continues: keeps traced faces of that solid alone among the
 * target's, or keeps no traced face at all, when the target had one solid and nothing was added.
 */

interface Solid { readonly id: number; readonly faces: readonly number[] }
/** A face a result solid keeps of a source solid: which source, and the solid there, by identity, and the faces it keeps. */
interface Kept { readonly source: number; readonly from: number; readonly faces: readonly number[] }
interface Made { readonly solid: Solid; readonly keeps: readonly Kept[]; /** For a feature whose result follows its target's order, the solid it follows. */ readonly follows?: number }
/** One feature as geometry: the same whatever order the kernel lists solids in. */
interface Step {
  readonly id: string;
  readonly kind: 'cut' | 'fillet' | 'pattern' | 'join';
  readonly boolean: boolean;
  readonly removesMaterial: boolean;
  readonly sources: readonly CadBodySource[];
  readonly made: readonly Made[];
  /** A fused tool's solids, in the tool's own order. */
  readonly tool?: readonly Solid[];
  readonly copies?: number;
}
interface History { readonly initial: readonly Solid[]; readonly steps: readonly Step[]; readonly shape: string }

function random(seed: number) {
  // Small seeds give small first draws, so the seed is mixed and the first draws are dropped.
  let state = Math.imul(seed, 0x9e3779b1) >>> 0 || 1;
  const next = () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state / 2 ** 32; };
  for (let drop = 0; drop < 8; drop++) next();
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(list: readonly T[]) => list[Math.floor(next() * list.length)], chance: (p: number) => next() < p };
}
type Random = ReturnType<typeof random>;
function shuffled<T>(rand: Random, list: readonly T[]): T[] {
  const copy = [...list];
  for (let at = copy.length - 1; at > 0; at--) { const other = rand.int(at + 1); [copy[at], copy[other]] = [copy[other], copy[at]]; }
  return copy;
}

/** Generates histories, keeping solid and face numbers unique within one. */
function generator(rand: Random) {
  let solids = 0, faces = 0;
  const fresh = (n: number) => Array.from({ length: n }, () => ++faces);
  const solid = (kept: readonly number[], added = 1 + rand.int(3)): Solid => ({ id: ++solids, faces: shuffled(rand, [...kept, ...fresh(added)]) });
  const some = (list: readonly number[], min: number) => { const picked = list.filter(() => rand.chance(0.6)); return picked.length >= min ? picked : list.slice(0, Math.max(min, 1)); };

  /** Splits `split` solids into pieces, one keeping no face now and then and two tying as often as `ties`, nicks others and may remove one. */
  function cut(id: string, body: readonly Solid[], split: readonly Solid[], pieces = 2 + rand.int(2), ties = 0.1): Step {
    const made: Made[] = [];
    const removed = body.length > split.length + 1 && rand.chance(0.2) ? body.find(each => !split.includes(each)) : undefined;
    for (const each of body) {
      if (each === removed) continue;
      if (!split.includes(each)) {
        if (rand.chance(0.2)) { const kept = some(each.faces, 1); made.push({ solid: solid(kept), keeps: [{ source: 0, from: each.id, faces: kept }] }); }
        else made.push({ solid: each, keeps: [{ source: 0, from: each.id, faces: each.faces }] });
        continue;
      }
      const order = shuffled(rand, each.faces), share = Array.from({ length: pieces }, () => [] as number[]);
      order.forEach((face, at) => { if (at < pieces || rand.chance(0.7)) share[at % pieces].push(face); });
      if (rand.chance(0.15)) share[pieces - 1] = [];
      // Now and then two pieces keep the same lowest face, as a tie the kernel's order breaks.
      if (pieces > 2 && share[1].length && rand.chance(ties)) share[0].push(share[1][0]);
      for (const kept of share) made.push({ solid: solid(kept), keeps: kept.length ? [{ source: 0, from: each.id, faces: kept }] : [] });
    }
    return { id, kind: 'cut', boolean: true, removesMaterial: true, sources: [{ kind: 'target' }], made };
  }

  /** Rounds some solids: one rounded on every edge keeps no face. The result lists solids in its target's order. */
  function fillet(id: string, body: readonly Solid[]): Step {
    const all = rand.chance(0.6);
    const made = body.map((each): Made => {
      if (!all && rand.chance(0.5)) return { solid: each, keeps: [{ source: 0, from: each.id, faces: each.faces }], follows: each.id };
      if (rand.chance(0.75)) return { solid: solid([], each.faces.length), keeps: [], follows: each.id };
      const kept = some(each.faces, 1);
      return { solid: solid(kept), keeps: [{ source: 0, from: each.id, faces: kept }], follows: each.id };
    });
    return { id, kind: 'fillet', boolean: false, removesMaterial: false, sources: [{ kind: 'target' }], made };
  }

  /** Copies every solid apart, now and then fusing a copy into an original or into another copy. */
  function pattern(id: string, body: readonly Solid[], copies = 1 + rand.int(2)): Step {
    const sources: CadBodySource[] = [{ kind: 'target' }, ...Array.from({ length: copies }, (_, at) => ({ kind: 'copy' as const, i: at + 1, j: 0 }))];
    const made: Made[] = [], originals = new Map(body.map(each => [each.id, { solid: each, keeps: [{ source: 0, from: each.id, faces: each.faces }] as Kept[] }]));
    const copied: { solid: Solid; keeps: Kept[] }[] = [];
    for (let c = 1; c <= copies; c++) for (const each of body) copied.push({ solid: solid([], each.faces.length), keeps: [{ source: c, from: each.id, faces: each.faces }] });
    if (rand.chance(0.15) && copied.length) {
      // A copy reaching an original: the fused solid keeps faces of both.
      const copy = copied.splice(rand.int(copied.length), 1)[0], into = rand.pick(body);
      const kept = [{ source: 0, from: into.id, faces: some(into.faces, 1) }, { ...copy.keeps[0], faces: some(copy.keeps[0].faces, 1) }];
      originals.set(into.id, { solid: solid(kept.flatMap(each => each.faces)), keeps: kept });
    } else if (rand.chance(0.15) && copied.length > 1) {
      // Two copies reaching each other, away from the originals.
      const [first, second] = [copied.splice(rand.int(copied.length), 1)[0], copied.splice(rand.int(copied.length), 1)[0]];
      const kept = [first, second].map(each => ({ ...each.keeps[0], faces: some(each.keeps[0].faces, 1) }));
      copied.push({ solid: solid(kept.flatMap(each => each.faces)), keeps: kept });
    }
    made.push(...originals.values(), ...copied);
    return { id, kind: 'pattern', boolean: true, removesMaterial: false, sources, made, copies };
  }

  /** Fuses a tool of one or two solids: each bridges solids, reaches one or stands apart as an island. */
  function join(id: string, body: readonly Solid[], bridge?: readonly Solid[]): Step {
    const tools = Array.from({ length: bridge ? 1 : 1 + rand.int(2) }, () => solid([], 4));
    const made: Made[] = [], taken = new Set<number>();
    for (const tool of tools) {
      const free = body.filter(each => !taken.has(each.id));
      const reach = bridge && tool === tools[0] ? bridge : rand.chance(0.25) || !free.length ? [] : shuffled(rand, free).slice(0, 1 + rand.int(Math.min(3, free.length)));
      for (const each of reach) taken.add(each.id);
      const keeps: Kept[] = [...reach.map(each => ({ source: 0, from: each.id, faces: some(each.faces, 1) })), { source: 1, from: tool.id, faces: some(tool.faces, 1) }];
      made.push({ solid: solid(keeps.flatMap(each => each.faces), 0), keeps });
    }
    for (const each of body) if (!taken.has(each.id)) made.push({ solid: each, keeps: [{ source: 0, from: each.id, faces: each.faces }] });
    return { id, kind: 'join', boolean: true, removesMaterial: false, sources: [{ kind: 'target' }, { kind: 'tool' }], made, tool: tools };
  }

  return function history(): History {
    const shape = rand.pick(['template', 'template', 'small', 'small', 'small', 'random', 'random'] as const);
    const initial = Array.from({ length: rand.chance(shape === 'small' ? 0.6 : 0.2) ? 2 : 1 }, () => solid([], 6));
    const steps: Step[] = [];
    let body: readonly Solid[] = initial;
    const add = (step: Step) => { steps.push(step); body = step.made.map(each => each.solid); };
    if (shape === 'small') {
      // One or two solids split, joined, rounded or copied a few times: few enough solids to build every combination of orders. Two first
      // solids stand for a body joined to an island, whose pieces keep their order within each solid while the solids may come in any order.
      const pieces = () => 2 + (rand.chance(0.4) ? 1 : 0);
      add(cut('f0', body, [rand.pick(body)], pieces(), 0.5));
      for (let at = 1, count = 1 + rand.int(3); at <= count && body.length <= 3; at++) {
        const kind = rand.pick(['cut', 'cut', 'cut', 'fillet', 'join', 'pattern'] as const), id = `f${at}`;
        if (kind === 'fillet') add(fillet(id, body));
        else if (kind === 'join') add(join(id, body));
        else if (kind === 'pattern' && body.length <= 2) add(pattern(id, body, 1));
        else add(cut(id, body, [rand.pick(body)], pieces(), 0.5));
      }
      return { initial, steps, shape };
    }
    if (shape === 'template') {
      // Split, round, split a piece, copy, bridge originals and copy again: the shape of the last review rounds' cases.
      add(cut('split', body, [rand.pick(body)], 2));
      add(fillet('round', body));
      add(cut('more', body, [rand.pick(body)], 2 + rand.int(2)));
      if (rand.chance(0.5)) add(cut('again', body, [rand.pick(body)], 2));
      add(pattern('across', body, 1));
      if (body.length > 1) add(join('bridge', body, shuffled(rand, body).slice(0, 2)));
      add(pattern('down', body, 1));
      return { initial, steps, shape: 'template' };
    }
    const count = 3 + rand.int(4);
    for (let at = 0; at < count; at++) {
      const kind = at === 0 ? 'cut' : rand.pick(['cut', 'cut', 'fillet', 'pattern', 'join'] as const);
      const id = `f${at}`;
      if (kind === 'cut') add(cut(id, body, shuffled(rand, body).slice(0, 1 + (body.length > 2 && rand.chance(0.3) ? 1 : 0))));
      else if (kind === 'fillet') add(fillet(id, body));
      else if (kind === 'pattern' && body.length <= 8) add(pattern(id, body));
      else add(join(id, body));
      if (body.length > 24) break;
    }
    return { initial, steps, shape: 'random' };
  };
}

const base = (id: string) => ({ id, name: id, suppressed: false });
const sketch = (id: string): CadFeature => ({ ...base(id), kind: 'sketch', plane: 'XY', offset: 0,
  profiles: [{ id: `${id}_profile`, name: 'Profile', construction: false, geometry: { kind: 'rectangle', x: 0, y: 0, width: 40, height: 20, cornerRadius: 0 } }] });
const extrude = (id: string, operation: 'new' | 'join' | 'cut', targetId: string | null): CadFeature =>
  ({ ...base(id), kind: 'extrude', sketchId: `${id}_sketch`, distance: 10, symmetric: false, operation, targetId });

/** The features a history's steps stand for, each changing the body the step before it made. */
function featuresOf(history: History): CadDocument {
  const features: CadFeature[] = [sketch('box_sketch'), extrude('box', 'new', null)];
  let previous = 'box';
  for (const step of history.steps) {
    if (step.kind === 'cut' || step.kind === 'join') features.push(sketch(`${step.id}_sketch`), extrude(step.id, step.kind, previous));
    else if (step.kind === 'fillet') features.push({ ...base(step.id), kind: 'fillet', targetId: previous, radius: 1 } as CadFeature);
    else features.push({ ...base(step.id), kind: 'linear-pattern', sourceId: previous, count: step.copies! + 1, spacing: [100, 0, 0] } as CadFeature);
    previous = step.id;
  }
  return parseCadDocument({ ...createCadDocument('Orders'), features });
}

/** The body after each step in one combination of orders: its state, the solids its pieces key, in order, and its issues at the end. */
interface Run { readonly states: readonly { readonly bodies: readonly CadBodyState[]; readonly solids: readonly number[] }[]; readonly issues: readonly CadBodyIssue[] }

/** The orders the kernel may choose in `history`, by how many solids each orders: the first solids', then each step's result's, when a
 * Boolean, and its tool's. */
const freedomsOf = (history: History): number[] =>
  [history.initial.length, ...history.steps.flatMap(step => [...step.boolean ? [step.made.length] : [], ...step.tool ? [step.tool.length] : []])];

/** Builds `history` with each order the kernel may choose given by `combination`, one list of places per freedom. */
function run(history: History, parsed: CadDocument, combination: readonly (readonly number[])[]): Run {
  const lineage = createCadBodyLineage(), steps = new Map(history.steps.map(step => [step.id, step]));
  let next = 0;
  const ordered = <T>(list: readonly T[]): T[] => combination[next++].map(at => list[at]);
  let body: readonly Solid[] = ordered(history.initial);
  const states: { bodies: readonly CadBodyState[]; solids: readonly number[] }[] = [];
  for (const feature of parsed.features) {
    const step = steps.get(feature.id);
    if (feature.id === 'box') { lineage.apply(feature, parsed, { solids: body.length, removesMaterial: false, sources: [{ kind: 'target' }], provenance: () => [] }); continue; }
    if (!step) { lineage.apply(feature, parsed); continue; }
    const made = step.boolean ? ordered(step.made) : [...step.made].sort((a, b) => body.findIndex(each => each.id === a.follows) - body.findIndex(each => each.id === b.follows));
    const tool = step.tool ? ordered(step.tool) : [];
    const index = new Map<number, number>(), toolIndex = new Map(tool.map((each, at) => [each.id, at]));
    body.forEach((each, at) => index.set(each.id, at));
    // As the tracer ranks a source's faces: in the source's order, a face two of its solids share ranked once and never traced.
    const ranked = (solids: readonly Solid[]) => {
      const ranks = new Map<number, number>(), shared = new Set<number>();
      for (const face of solids.flatMap(each => each.faces)) if (ranks.has(face)) shared.add(face); else ranks.set(face, ranks.size + 1);
      for (const face of shared) ranks.delete(face);
      return ranks;
    };
    const ranks = ranked(body), toolRanks = ranked(tool);
    const provenance = (): CadBodySolidSource[][] => made.map(each => each.keeps.flatMap(kept => {
      const tool = step.sources[kept.source].kind === 'tool';
      const faceRanks = kept.faces.flatMap(face => (tool ? toolRanks : ranks).get(face) ?? []);
      return faceRanks.length ? [{ source: kept.source, solid: (tool ? toolIndex : index).get(kept.from)!, rank: Math.min(...faceRanks) }] : [];
    }));
    const facts: CadBodyKernelFacts = { solids: made.length, removesMaterial: step.removesMaterial, sources: step.sources, provenance };
    lineage.apply(feature, parsed, facts);
    body = made.map(each => each.solid);
    states.push({ bodies: lineage.bodies(), solids: body.map(each => each.id) });
  }
  return { states, issues: lineage.issues() };
}

const view = (bodies: readonly CadBodyState[]): Pick<CadBodyLineage, 'get' | 'bodies' | 'consumed'> =>
  ({ get: key => bodies.find(body => body.key === key), bodies: () => bodies, consumed: () => [] });

/** How a key resolves after one step of one run: its status and the solids it stands for, by identity. */
interface Seen { readonly status: 'resolved' | 'ambiguous' | 'missing'; readonly solids: readonly number[] }
function resolution(state: Run['states'][number], key: string): Seen {
  const result = resolveCadBodyRef({ kind: 'body', key: key as CadBodyKey }, view(state.bodies));
  if (result.status === 'missing') return { status: 'missing', solids: [] };
  const pieces = result.body.pieces, parts = result.status === 'ambiguous' ? result.candidates : result.part;
  const solids = !pieces || parts === undefined ? state.solids : (typeof parts === 'string' ? [parts] : parts).map(part => state.solids[pieces.indexOf(part)]);
  return { status: result.status, solids: [...new Set(solids)].sort((a, b) => a - b) };
}
const shown = (seen: Seen) => `${seen.status} ${seen.solids.join(',')}`;
/** The solid `key` is a piece as after one step of one run, if it is one. */
function pieceSolid(state: Run['states'][number], key: string): number | undefined {
  const at = state.bodies[0]?.pieces?.indexOf(key as CadBodyKey) ?? -1;
  return at >= 0 ? state.solids[at] : undefined;
}
/** The solids of the pieces in the body's provenance groups after one step of one run that hold one of `reached`, or in all of them. */
function groupedSolids(state: Run['states'][number], reached?: ReadonlySet<string>): ReadonlySet<number> {
  const body = state.bodies[0], grouped = new Set<number>();
  for (const group of body?.ambiguous ?? []) {
    if (reached && !group.some(part => reached.has(part))) continue;
    for (const part of group) { const at = body.pieces?.indexOf(part) ?? -1; if (at >= 0) grouped.add(state.solids[at]); }
  }
  return grouped;
}

/** For each step, every key that is a piece in some run, with the solids it is a piece as, and each solid with those keys. */
function piecesBySteps(runs: readonly Run[], steps: number) {
  return Array.from({ length: steps }, (_, at) => {
    const solidsOf = new Map<string, Set<number>>(), keysOf = new Map<number, Set<string>>();
    for (const each of runs) each.states[at].bodies[0]?.pieces?.forEach((part, n) => {
      const solid = each.states[at].solids[n];
      (solidsOf.get(part) ?? solidsOf.set(part, new Set()).get(part)!).add(solid);
      (keysOf.get(solid) ?? keysOf.set(solid, new Set()).get(solid)!).add(part);
    });
    return { solidsOf, keysOf };
  });
}
/** The keys whose groups `key` reaches after step `at`: itself, and every key that was a piece as the same solid as it after a step so far. */
function reachedBy(byStep: ReturnType<typeof piecesBySteps>, key: string, at: number): ReadonlySet<string> {
  const reached = new Set([key]);
  for (let step = 0; step <= at; step++) for (const solid of byStep[step].solidsOf.get(key) ?? []) for (const part of byStep[step].keysOf.get(solid)!) reached.add(part);
  return reached;
}

/**
 * The solids of the body before `step` that a solid of its result continues, as faces show it: one keeping traced faces of that target solid
 * alone, or, when the target had one solid and the step added nothing, one keeping no traced face. A face two solids of a source share is
 * never traced.
 */
function continuedSolids(step: Step, before: readonly Solid[]): ReadonlySet<number> {
  const traced = (solids: readonly Solid[]) => {
    const seen = new Set<number>(), shared = new Set<number>();
    for (const face of solids.flatMap(each => each.faces)) if (seen.has(face)) shared.add(face); else seen.add(face);
    return (face: number) => seen.has(face) && !shared.has(face);
  };
  const body = traced(before), tool = traced(step.tool ?? []), continued = new Set<number>();
  let faceless = false;
  for (const made of step.made) {
    const keeps = made.keeps.filter(kept => kept.faces.some(step.sources[kept.source].kind === 'tool' ? tool : body));
    const targets = new Set(keeps.filter(kept => step.sources[kept.source].kind === 'target').map(kept => kept.from));
    if (targets.size === 1) continued.add([...targets][0]);
    if (!keeps.length) faceless = true;
  }
  if (faceless && before.length === 1 && step.sources.every(source => source.kind === 'target')) continued.add(before[0].id);
  return continued;
}

/** Every key the runs list after a step or before it, and each formed from one by changing the indices of any of its split steps. */
function keysBySteps(runs: readonly Run[], steps: number): string[][] {
  const listed = new Set<string>();
  return Array.from({ length: steps }, (_, at) => {
    for (const each of runs) for (const body of each.states[at].bodies)
      for (const part of [body.key, ...body.pieces ?? [], ...body.ambiguous?.flat() ?? [], ...body.orders?.flatMap(order => order.keys) ?? []]) listed.add(part);
    return cadBodyKeyVariants(listed);
  });
}

const inOrder = (count: number) => Array.from({ length: count }, (_, at) => at);
const factorial = (count: number): number => count <= 1 ? 1 : count * factorial(count - 1);
const permutations = (list: readonly number[]): number[][] =>
  list.length ? list.flatMap((first, at) => permutations(list.filter((_, other) => other !== at)).map(rest => [first, ...rest])) : [[]];
/**
 * The combinations of orders to build: every one while there are at most `every`, otherwise a sample of `sample` that has each freedom
 * reversed and shuffled alone.
 */
function combinations(rand: Random, counts: readonly number[], every: number, sample: number): { combos: number[][][]; exhaustive: boolean } {
  if (counts.reduce((product, count) => product * factorial(count), 1) <= every)
    return { combos: counts.reduce<number[][][]>((all, count) => all.flatMap(combo => permutations(inOrder(count)).map(order => [...combo, order])), [[]]), exhaustive: true };
  const picked = new Map<string, number[][]>(), add = (combo: number[][]) => picked.set(JSON.stringify(combo), combo), identity = counts.map(inOrder);
  add(identity);
  counts.forEach((count, at) => {
    if (count < 2) return;
    add(identity.map((order, other) => other === at ? [...order].reverse() : order));
    add(identity.map((order, other) => other === at ? shuffled(rand, order) : order));
  });
  while (picked.size < sample) add(counts.map(count => shuffled(rand, inOrder(count))));
  return { combos: [...picked.values()], exhaustive: false };
}

/**
 * What is wrong with `seen`, if anything, given the solids `truth` a key is a piece as across every combination, whether it is the same
 * piece in all of them, the solids of the run's provenance groups the key reaches, found only when needed, and whether the key is in one.
 */
function imprecision(seen: Seen, truth: readonly number[], certain: boolean, reachable: () => ReadonlySet<number>, inGroup: boolean): string | undefined {
  if (truth.some(solid => !seen.solids.includes(solid))) return 'leaves out a solid it is a piece as in some order';
  if (seen.solids.some(solid => !truth.includes(solid) && !reachable().has(solid))) return 'stands for a solid it is a piece as in no order, outside every group it reaches';
  if (seen.status === 'resolved' && !certain) return 'resolves although it is not the same piece in every order';
  if (seen.status !== 'resolved' && certain && !inGroup) return 'is ambiguous although it is the same piece in every order and in no group';
  return undefined;
}
/** What is wrong with `seen`, if anything, given what a sample of the combinations shows. */
function unsoundness(seen: Seen, truth: readonly number[], certain: boolean): string | undefined {
  if (truth.some(solid => !seen.solids.includes(solid))) return 'leaves out a solid it is a piece as in some order';
  if (seen.status === 'resolved' && !certain) return 'resolves although it is not the same piece in every order';
  return undefined;
}

interface Disagreement { readonly seed: number; readonly shape: string; readonly step: string; readonly key: string; readonly problem: string; readonly seen: string; readonly truth: string; readonly combo: string }
interface Checked {
  readonly disagreements: Disagreement[]; readonly combos: number; readonly exhaustive: boolean; readonly renumbered: boolean;
  /**
   * Keys checked exactly: in bodies without groups, ambiguous among several solids, and missing though formed like a listed key; missing
   * beside groups it reaches none of; and lost, at the steps whose losses were checked exactly.
   */
  readonly ambiguous: number; readonly phantoms: number; readonly besideGroups: number; readonly losses: number; readonly lossSteps: number;
  /** Lost keys checked exactly that the first combination never had as a piece: keys only another order gave. */
  readonly unlisted: number;
}

/** Checks one generated history, returning the first disagreements found. */
function checkHistory(seed: number, every: number, sample: number): Checked {
  const rand = random(seed), history = generator(rand)(), parsed = featuresOf(history);
  const { combos, exhaustive } = combinations(rand, freedomsOf(history), every, sample);
  const runs = combos.map(combo => run(history, parsed, combo)), keys = keysBySteps(runs, history.steps.length), byStep = piecesBySteps(runs, history.steps.length);
  const disagreements: Disagreement[] = [];
  const disagree = (step: string, key: string, problem: string, seen: string, truth: string, n: number) =>
    disagreements.push({ seed, shape: history.shape, step, key, problem, seen, truth, combo: JSON.stringify(combos[n]) });
  // Lost keys must be the same list in every combination; other issues name keys a combination gives, so only their counts must agree.
  const issues = (each: Run) => each.issues.map(issue => `${issue.code} ${issue.featureId} ${issue.code === 'lost-body-parts' ? issue.pieces.join(' ') : issue.pieces.length}`).sort().join('; ');
  for (const [n, each] of runs.entries()) if (issues(each) !== issues(runs[0])) disagree('issues', '', 'other issues', issues(each), issues(runs[0]), n);
  const lostAt = (each: Run, featureId: string) => each.issues.find(issue => issue.code === 'lost-body-parts' && issue.featureId === featureId)?.pieces ?? [];
  let renumbered = false, ambiguous = 0, phantoms = 0, besideGroups = 0, losses = 0, lossSteps = 0, unlisted = 0;
  history.steps.forEach((step, at) => {
    const states = runs.map(each => each.states[at]), wholes = new Set(states.flatMap(state => state.bodies.map(body => body.key as string)));
    for (const key of keys[at]) {
      const seen = states.map(state => resolution(state, key));
      const other = seen.findIndex(each => shown(each) !== shown(seen[0]));
      if (other >= 0) { disagree(step.id, key, 'resolves otherwise in another order', shown(seen[other]), shown(seen[0]), other); continue; }
      if (wholes.has(key)) continue;
      const named = states.map(state => pieceSolid(state, key)), truth = [...new Set(named.filter(solid => solid !== undefined))].sort((a, b) => a - b);
      const certain = truth.length === 1 && named.every(solid => solid !== undefined);
      let reached: ReadonlySet<string> | undefined;
      for (const [n, state] of states.entries()) {
        const inGroup = state.bodies[0]?.ambiguous?.some(group => group.includes(key as CadBodyKey)) ?? false;
        let reachable: ReadonlySet<number> | undefined;
        const groupsReached = () => reachable ??= groupedSolids(state, reached ??= reachedBy(byStep, key, at));
        const problem = exhaustive ? imprecision(seen[n], truth, certain, groupsReached, inGroup) : unsoundness(seen[n], truth, certain);
        if (problem) { disagree(step.id, key, problem, shown(seen[n]), truth.join(','), n); break; }
        if (!exhaustive || n) continue;
        if (!state.bodies[0]?.ambiguous) { if (truth.length > 1) ambiguous++; else if (!truth.length) phantoms++; }
        else if (!truth.length && !groupsReached().size) besideGroups++;
      }
    }
    // Each reported loss named a solid before the step and names none after it, in its own combination.
    for (const [n, each] of runs.entries()) for (const key of lostAt(each, step.id)) {
      const before = at ? resolution(each.states[at - 1], key).status : 'missing', after = resolution(each.states[at], key).status;
      if (before === 'missing' || after !== 'missing') disagree(step.id, key, 'is reported lost though it did not name a solid before and none after', `${before} then ${after}`, '', n);
    }
    // Built in every combination with no groups, the losses are exactly the keys some combination had as a piece before the step, none has
    // as a piece after it, and whose solids no solid continues.
    const previous = at ? runs.map(each => each.states[at - 1]) : [];
    const plain = (state: Run['states'][number]) => !state.bodies[0]?.ambiguous && !state.bodies[0]?.untracked;
    if (exhaustive && at && previous.every(plain) && states.every(plain)) {
      lossSteps++;
      const continued = continuedSolids(step, history.steps[at - 1].made.map(made => made.solid)), reported = lostAt(runs[0], step.id);
      for (const key of new Set([...keys[at], ...reported])) {
        const was = previous.flatMap(state => pieceSolid(state, key) ?? []), lost = was.length > 0 && states.every(state => pieceSolid(state, key) === undefined) && !was.some(solid => continued.has(solid));
        if (lost) { losses++; if (pieceSolid(previous[0], key) === undefined) unlisted++; }
        if (lost !== reported.includes(key as CadBodyKey)) disagree(step.id, key, lost ? 'is lost but not reported' : 'is reported lost though it is not', reported.join(' '), was.join(','), 0);
      }
    }
    const listed = runs[0].states[at].bodies[0]?.pieces ?? [];
    for (const piece of listed) for (const each of runs.slice(1)) {
      const where = each.states[at].bodies[0]?.pieces?.indexOf(piece) ?? -1;
      if (where >= 0 && each.states[at].solids[where] !== runs[0].states[at].solids[listed.indexOf(piece)]) renumbered = true;
    }
  });
  return { disagreements, combos: combos.length, exhaustive, renumbered, ambiguous, phantoms, besideGroups, losses, lossSteps, unlisted };
}

/** Seeds past the default run that once found a disagreement: each reported losses that depended on the order of a join's solids. */
const REGRESSIONS = [424, 492, 718, 885, 1003];

describe('body identity across kernel solid orders', () => {
  it('resolves every key, listed or formed by changing split indices, to exactly the solids it is a piece as in some combination of orders', () => {
    const count = Number(process.env.CAD_BODY_ORDER_SEEDS ?? 120), every = Number(process.env.CAD_BODY_ORDER_EVERY ?? 2000);
    const sample = Number(process.env.CAD_BODY_ORDER_COMBOS ?? 81);
    const seeds = [...new Set([...Array.from({ length: count }, (_, at) => at + 1), ...REGRESSIONS])];
    const found: Disagreement[] = [];
    let renumbered = 0, exhaustive = 0, ambiguous = 0, phantoms = 0, besideGroups = 0, losses = 0, lossSteps = 0, unlisted = 0, combos = 0;
    for (const seed of seeds) {
      const checked = checkHistory(seed, every, sample);
      found.push(...checked.disagreements.slice(0, 3));
      if (checked.renumbered) renumbered++;
      if (checked.exhaustive) exhaustive++;
      ambiguous += checked.ambiguous; phantoms += checked.phantoms; besideGroups += checked.besideGroups; combos += checked.combos;
      losses += checked.losses; lossSteps += checked.lossSteps; unlisted += checked.unlisted;
    }
    if (process.env.CAD_BODY_ORDER_REPORT) console.log(JSON.stringify({ seeds: seeds.length, exhaustive, combos, ambiguous, phantoms, besideGroups, losses, lossSteps, unlisted, renumbered,
      failing: [...new Set(found.map(each => each.seed))], found: found.slice(0, 40) }, null, 1));
    expect(found).toEqual([]);
    // The orders must change which solid some key names, and a share of the histories must be built in every combination, with keys
    // ambiguous among several solids, keys no order lists, beside groups too, and lost keys checked exactly, or the check proves little.
    expect(renumbered).toBeGreaterThan(seeds.length / 4);
    expect(exhaustive).toBeGreaterThan(seeds.length / 4);
    expect([ambiguous > seeds.length / 2, phantoms > seeds.length, besideGroups > seeds.length, losses > seeds.length / 10]).toEqual([true, true, true, true]);
  }, 300_000);
});

