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
 * geometry and keeps its faces in an order of its own. Each Boolean may list its result's solids in any order, and a face's rank is its
 * place in its source's face order, so faces of different solids rank in the order the source listed them, as the kernel's do. Every
 * combination of independent per-Boolean orders, or a bounded sample of them, must resolve every key the same way after every feature:
 * the same solid when certain, the same solids when ambiguous, or missing in all of them. Keys are those any order lists, and every key
 * formed from one by changing the indices of any of its split steps.
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
  let state = seed >>> 0 || 1;
  const next = () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state / 2 ** 32; };
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

  /** Splits `split` solids into pieces, one keeping no face now and then, nicks others and may remove one. */
  function cut(id: string, body: readonly Solid[], split: readonly Solid[], pieces = 2 + rand.int(2)): Step {
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
      if (pieces > 2 && share[1].length && rand.chance(0.1)) share[0].push(share[1][0]);
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
    const initial = Array.from({ length: rand.chance(0.2) ? 2 : 1 }, () => solid([], 6));
    const steps: Step[] = [];
    let body: readonly Solid[] = initial;
    const add = (step: Step) => { steps.push(step); body = step.made.map(each => each.solid); };
    if (rand.chance(0.4)) {
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

/** Builds `history` with each Boolean listing its solids as `orders` says, by its place among the Booleans. */
function run(history: History, parsed: CadDocument, orders: readonly ((count: number) => readonly number[])[]): Run {
  const lineage = createCadBodyLineage(), steps = new Map(history.steps.map(step => [step.id, step]));
  let body: readonly Solid[] = history.initial, booleans = 0;
  const states: { bodies: readonly CadBodyState[]; solids: readonly number[] }[] = [];
  for (const feature of parsed.features) {
    const step = steps.get(feature.id);
    if (feature.id === 'box') { lineage.apply(feature, parsed, { solids: body.length, removesMaterial: false, sources: [{ kind: 'target' }], provenance: () => [] }); continue; }
    if (!step) { lineage.apply(feature, parsed); continue; }
    const index = new Map<number, number>(), toolIndex = new Map((step.tool ?? []).map((each, at) => [each.id, at]));
    body.forEach((each, at) => index.set(each.id, at));
    // As the tracer ranks a source's faces: in the source's order, a face two of its solids share ranked once and never traced.
    const ranked = (solids: readonly Solid[]) => {
      const ranks = new Map<number, number>(), shared = new Set<number>();
      for (const face of solids.flatMap(each => each.faces)) if (ranks.has(face)) shared.add(face); else ranks.set(face, ranks.size + 1);
      for (const face of shared) ranks.delete(face);
      return ranks;
    };
    const ranks = ranked(body), toolRanks = ranked(step.tool ?? []);
    let made: readonly Made[];
    if (step.boolean) { const order = orders[booleans++](step.made.length); made = order.map(at => step.made[at]); }
    else made = [...step.made].sort((a, b) => index.get(a.follows!)! - index.get(b.follows!)!);
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

const booleansOf = (history: History) => history.steps.filter(step => step.boolean).length;
const view = (bodies: readonly CadBodyState[]): Pick<CadBodyLineage, 'get' | 'bodies' | 'consumed'> =>
  ({ get: key => bodies.find(body => body.key === key), bodies: () => bodies, consumed: () => [] });

/** How `key` resolves after one step of one run: its status and the solids it stands for, by identity. */
function resolution(state: Run['states'][number], key: string): string {
  const result = resolveCadBodyRef({ kind: 'body', key: key as CadBodyKey }, view(state.bodies));
  if (result.status === 'missing') return 'missing';
  const pieces = result.body.pieces, parts = result.status === 'ambiguous' ? result.candidates : result.part;
  const solids = !pieces || parts === undefined ? state.solids : (typeof parts === 'string' ? [parts] : parts).map(part => state.solids[pieces.indexOf(part)]);
  return `${result.status} ${[...solids].sort((a, b) => a - b).join(',')}`;
}

/** Every key the runs list after a step, and each formed from one by changing the indices of any of its split steps. */
const keysAt = (runs: readonly Run[], at: number): string[] => cadBodyKeyVariants(runs.flatMap(each => each.states[at].bodies.flatMap(body =>
  [body.key, ...body.pieces ?? [], ...body.ambiguous?.flat() ?? [], ...body.interchangeable?.flat() ?? []])));

/** The order combinations to build: every one of three orders per Boolean while few, then a sample that has each Boolean's orders alone. */
function combinations(rand: Random, booleans: number, limit: number): number[][] {
  const choices = 3;
  if (choices ** booleans <= limit) return Array.from({ length: choices ** booleans }, (_, n) => Array.from({ length: booleans }, (__, b) => Math.floor(n / choices ** b) % choices));
  const picked = new Map<string, number[]>();
  const add = (combo: number[]) => picked.set(combo.join(), combo);
  add(Array.from({ length: booleans }, () => 0));
  for (let b = 0; b < booleans; b++) for (let c = 1; c < choices; c++) add(Array.from({ length: booleans }, (_, at) => at === b ? c : 0));
  while (picked.size < limit) add(Array.from({ length: booleans }, () => rand.int(choices)));
  return [...picked.values()];
}

interface Disagreement { readonly seed: number; readonly shape: string; readonly step: string; readonly key: string; readonly first: string; readonly other: string; readonly combo: string }

/** Checks one generated history, returning the first disagreements found. */
function checkHistory(seed: number, limit: number): { disagreements: Disagreement[]; booleans: number; combos: number; renumbered: boolean } {
  const rand = random(seed), history = generator(rand)(), parsed = featuresOf(history), booleans = booleansOf(history);
  // Each Boolean gets three orders of its own: as made, reversed and shuffled.
  const shuffles = history.steps.filter(step => step.boolean).map(step => shuffled(rand, step.made.map((_, at) => at)));
  const combos = combinations(rand, booleans, limit);
  const runs = combos.map(combo => run(history, parsed, combo.map((choice, b) => (count: number) =>
    choice === 0 ? Array.from({ length: count }, (_, at) => at) : choice === 1 ? Array.from({ length: count }, (_, at) => count - 1 - at) : shuffles[b])));
  const disagreements: Disagreement[] = [];
  const issues = (each: Run) => each.issues.map(issue => `${issue.code} ${issue.featureId} ${issue.pieces.length}`).sort().join('; ');
  for (const each of runs.slice(1)) if (issues(each) !== issues(runs[0]))
    disagreements.push({ seed, shape: history.shape, step: 'issues', key: '', first: issues(runs[0]), other: issues(each), combo: combos[runs.indexOf(each)].join('') });
  let renumbered = false;
  history.steps.forEach((step, at) => {
    for (const key of keysAt(runs, at)) {
      const first = resolution(runs[0].states[at], key);
      for (let other = 1; other < runs.length; other++) {
        const found = resolution(runs[other].states[at], key);
        if (found !== first) { disagreements.push({ seed, shape: history.shape, step: step.id, key, first, other: found, combo: combos[other].join('') }); break; }
      }
    }
    const listed = runs[0].states[at].bodies[0]?.pieces ?? [];
    for (const piece of listed) for (const each of runs.slice(1)) {
      const where = each.states[at].bodies[0]?.pieces?.indexOf(piece) ?? -1;
      if (where >= 0 && each.states[at].solids[where] !== runs[0].states[at].solids[listed.indexOf(piece)]) renumbered = true;
    }
  });
  return { disagreements, booleans, combos: combos.length, renumbered };
}

describe('body identity across kernel solid orders', () => {
  it('resolves every key, listed or formed by changing a split index, the same way in every combination of Boolean orders', () => {
    const seeds = Number(process.env.CAD_BODY_ORDER_SEEDS ?? 120), limit = Number(process.env.CAD_BODY_ORDER_COMBOS ?? 81);
    const found: Disagreement[] = [];
    let renumbered = 0, template = 0;
    for (let seed = 1; seed <= seeds; seed++) {
      const checked = checkHistory(seed, limit);
      found.push(...checked.disagreements.slice(0, 3));
      if (checked.renumbered) renumbered++;
      if (checked.disagreements[0]?.shape === 'template') template++;
    }
    if (process.env.CAD_BODY_ORDER_REPORT) console.log(JSON.stringify({ seeds, failing: new Set(found.map(each => each.seed)).size, template, renumbered, found: found.slice(0, 40) }, null, 1));
    expect(found).toEqual([]);
    // The orders must change which solid some key names, or the check proves nothing.
    expect(renumbered).toBeGreaterThan(seeds / 4);
  }, 300_000);
});

