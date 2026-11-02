import type { CadFeature } from './cadDocument';
import { cadFeatureActive, type CadFeatureScope } from './features/cadFeatureActivity';
import { cadFeatureDefinition, cadFeatureLayout } from './features/cadFeatureRegistry';

/**
 * Body identity. A body is keyed by the feature that created it, plus an occurrence where that feature makes a body that is a copy of
 * another or a piece of one. Features that modify a body keep its key, so later features, the tree, selection, CAM and agents can
 * name it however often it is filleted, cut, moved or patterned. Every rebuild derives the states again from the history with
 * `createCadBodyLineage`, the kernel with the facts only its geometry knows. Nothing here is stored before S8's format cut, which
 * stores `CadBodyRef` targets and `CadBodyMetadata` keyed by these keys.
 */

/** What a body is: closed solids, an open sheet or wires. Every kernel body is a validated solid until surface and wire features arrive. */
export type CadBodyKind = 'solid' | 'sheet' | 'wire';

/**
 * A step from a creating feature to one of the bodies it makes, or from a body to a part of it:
 * - `inst(i,j)`: a pattern's copy, i along its first direction and j along its second, both 0 for the original in place. Patterns have
 *   one direction until a second count arrives, so j is 0;
 * - `split(k)`: the kth piece of a body a feature split, numbered by kernel topology;
 * - `mirror`: a mirror image of the feature's source.
 */
export type CadBodyOccurrence =
  | { readonly kind: 'inst'; readonly i: number; readonly j: number }
  | { readonly kind: 'split'; readonly k: number }
  | { readonly kind: 'mirror' };

declare const bodyKeyBrand: unique symbol;
/** A body key's canonical text: the creating feature's id, then each occurrence after a slash, as `pad`, `flip/mirror`, `pad/split(1)` or `pad/inst(2,0)`. */
export type CadBodyKey = string & { readonly [bodyKeyBrand]: true };

/** The longest key text accepted: a feature id and occurrence segments, which nest once per pattern and per split of a piece. */
export const MAX_CAD_BODY_KEY_LENGTH = 4096;
const FEATURE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const SEGMENT = /^(?:inst\((0|[1-9]\d{0,5}),(0|[1-9]\d{0,5})\)|split\((0|[1-9]\d{0,5})\)|mirror)$/;
/** A whole key in one test, for checks that need no parts: each segment starts with a slash and a fixed word, so it runs in linear time. */
const BODY_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}(?:\/(?:inst\((?:0|[1-9]\d{0,5}),(?:0|[1-9]\d{0,5})\)|split\((?:0|[1-9]\d{0,5})\)|mirror))*$/;

function segment(occurrence: CadBodyOccurrence): string {
  return occurrence.kind === 'inst' ? `inst(${occurrence.i},${occurrence.j})` : occurrence.kind === 'split' ? `split(${occurrence.k})` : 'mirror';
}

/** The key of a body `featureId` creates, with the occurrences that lead from that feature to it. */
export function cadBodyKey(featureId: string, occurrences: readonly CadBodyOccurrence[] = []): CadBodyKey {
  return [featureId, ...occurrences.map(segment)].join('/') as CadBodyKey;
}

/** The key of an occurrence within the body or occurrence `key`. */
export function cadBodyKeyWith(key: CadBodyKey, occurrence: CadBodyOccurrence): CadBodyKey {
  return `${key}/${segment(occurrence)}` as CadBodyKey;
}

/** The creating feature and occurrences of a key's canonical text, or `undefined` for text that is not one. */
export function parseCadBodyKey(text: unknown): { readonly featureId: string; readonly occurrences: readonly CadBodyOccurrence[] } | undefined {
  if (typeof text !== 'string' || text.length > MAX_CAD_BODY_KEY_LENGTH) return undefined;
  const [featureId, ...segments] = text.split('/');
  if (!FEATURE_ID.test(featureId)) return undefined;
  const occurrences: CadBodyOccurrence[] = [];
  for (const part of segments) {
    const match = SEGMENT.exec(part);
    if (!match) return undefined;
    occurrences.push(match[1] !== undefined ? { kind: 'inst', i: Number(match[1]), j: Number(match[2]) } : match[3] !== undefined ? { kind: 'split', k: Number(match[3]) } : { kind: 'mirror' });
  }
  return { featureId, occurrences };
}

/** Whether `text` is a key's canonical text, as `parseCadBodyKey` reads it, without building its parts. */
export function isCadBodyKey(text: unknown): text is CadBodyKey {
  return typeof text === 'string' && text.length <= MAX_CAD_BODY_KEY_LENGTH && BODY_KEY.test(text);
}

/**
 * One body after a rebuild: its key and kind, the feature that created it and those that modified it since, in history order, and the
 * Boolean that consumed it as a tool, if one did. The last of `createdBy` and `modifiedBy` is the feature whose result the body now is:
 * what stored target and source fields and `CadMesh.featureId` name until S8 (`cadBodyFeatureId`).
 */
export interface CadBodyState {
  readonly key: CadBodyKey;
  readonly kind: CadBodyKind;
  readonly createdBy: string;
  readonly modifiedBy: readonly string[];
  readonly consumedBy?: string;
  /**
   * The key of each of the body's solids, by the solid numbers `CadMesh.faceSolids` uses, once a split or a pattern's separate copy gave
   * it parts; absent while the body is whole. A body with parts keeps them until K5, even when one solid is left. No key repeats.
   */
  readonly pieces?: readonly CadBodyKey[];
  /**
   * Groups of keys that a solid keeping no face leaves uncertain, since no face shows which piece it came from: the solid, the keys one
   * solid continued unchanged beside it and the keys no solid continues, then their descendants through each source and the members
   * that can't be found while the group descends through the target. A reference to one resolves as ambiguous with the group's pieces
   * among its candidates: a stated superset of the pieces it names. No key is in two groups.
   */
  readonly ambiguous?: readonly (readonly CadBodyKey[])[];
  /**
   * The splits whose pieces the kernel's order numbered, with what decides each piece's place, from which `cadBodyOrderPlaces` gives every
   * index each piece takes in some order. These are the only steps where another kernel order would give a solid another key, since
   * every later step follows its solid. An order is kept while one of its keys is, or leads to, a piece or a group's key.
   */
  readonly orders?: readonly CadBodyOrder[];
  /** The body has more parts than the lineage tracks, so it keeps none, and references to its parts resolve as missing. */
  readonly untracked?: true;
}

/**
 * A split whose pieces the kernel's order numbered: their keys, siblings with consecutive indices, in this build's order, and what decides
 * each one's place. A Boolean may list its solids in any order, and a source's faces follow the order of the source's solids, so:
 * - without `by`, any order may number the pieces in any order: they tied on their first face, or kept no face;
 * - with `by`, each piece's first face lies in one of several source solids, and `by` gives, for each piece, pairs of a source solid and
 *   the piece's first face in it, both as ranks from 0, solids ascending. A piece comes after every piece keeping a face of a solid listed
 *   before the first of its own, then after the pieces whose first face in that solid comes before its own, and among those tying with it
 *   in any order.
 * `cadBodyOrderPlaces` gives every index each piece takes in some order.
 */
export interface CadBodyOrder {
  readonly keys: readonly CadBodyKey[];
  readonly by?: readonly (readonly number[])[];
}

/**
 * The most source solids an order's places are found for exactly when its pieces keep faces of several of them: past it, and past
 * `MAX_CAD_BODY_ORDER_WORK`, the order is recorded without `by`, so each of its pieces may take any of its indices, a stated superset.
 */
export const MAX_CAD_BODY_SHARED_SOLIDS = 10;
/**
 * The most work finding an order's places may take, in steps over its shared solids and its pieces, and the most reading of keys finding
 * the keys one feature leaves lost. Past either, the order is recorded without `by`, or the body's parts are untracked.
 */
export const MAX_CAD_BODY_ORDER_WORK = 2 ** 22;

/**
 * The most distinct part keys a body tracks: its pieces, the keys its groups keep and the keys its orders number, together. Past it the
 * body's parts are untracked from then on, never a rejected build. A group keeps every former member's key while a solid descends from it,
 * so each feature that splits or removes an ambiguous piece adds keys, however few solids are left. It also bounds the keys one feature
 * leaves lost, which nested reordered splits multiply: past it the body's parts are untracked, since a shorter list would depend on the
 * kernel order.
 */
export const MAX_CAD_BODY_LIST = 4096;

function isFeatureId(value: unknown): value is string { return typeof value === 'string' && FEATURE_ID.test(value); }

/**
 * Part keys of the body `key`, none in `seen` and each added to it: keys other than its own, each made by the body's creator or one of
 * its modifiers, as every piece, copy and fresh key is. `makers` is built only for a body with parts.
 */
function isPartKeys(value: unknown, key: string, makers: () => ReadonlySet<string>, seen: Set<string>): value is CadBodyKey[] {
  if (!Array.isArray(value) || value.length > MAX_CAD_BODY_LIST) return false;
  for (const part of value) {
    if (!isCadBodyKey(part) || seen.has(part)) return false;
    const slash = part.indexOf('/');
    if (slash < 0 || part === key || !makers().has(part.slice(0, slash))) return false;
    seen.add(part);
  }
  return true;
}

/** Checks a body state received across the worker boundary. Every build reply runs it once per body, so it builds nothing it can avoid. */
export function isCadBodyState(value: unknown): value is CadBodyState {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Readonly<Record<string, unknown>>, key = body.key;
  if (!isCadBodyKey(key)) return false;
  const slash = key.indexOf('/'), modifiedBy = body.modifiedBy;
  if (body.createdBy !== (slash < 0 ? key : key.slice(0, slash))) return false;
  if (body.kind !== 'solid' && body.kind !== 'sheet' && body.kind !== 'wire') return false;
  // As long as the history: a body may be modified by any number of features.
  if (!Array.isArray(modifiedBy)) return false;
  for (const id of modifiedBy) if (!isFeatureId(id)) return false;
  if (body.consumedBy !== undefined && !isFeatureId(body.consumedBy)) return false;
  if (body.untracked !== undefined) return body.untracked === true && body.pieces === undefined && body.ambiguous === undefined && body.orders === undefined;
  let makers: ReadonlySet<string> | undefined;
  const made = () => makers ??= new Set([body.createdBy as string, ...modifiedBy as string[]]);
  const pieces = new Set<string>();
  if (body.pieces !== undefined && !isPartKeys(body.pieces, key, made, pieces)) return false;
  // Pieces and the keys groups and orders keep count against the list limit together.
  const all = new Set(pieces);
  const lists = (value: unknown, list: (item: unknown) => unknown, fits: (item: unknown, keys: readonly string[]) => boolean) => {
    if (value === undefined) return true;
    if (!Array.isArray(value) || value.length > MAX_CAD_BODY_LIST) return false;
    const seen = new Set<string>();
    for (const item of value) {
      const keys = list(item);
      if (!Array.isArray(keys) || !keys.length || !isPartKeys(keys, key, made, seen) || !fits(item, keys)) return false;
      for (const part of keys) all.add(part);
      if (all.size > MAX_CAD_BODY_LIST) return false;
    }
    return true;
  };
  return lists(body.ambiguous, group => group, () => true)
    && lists(body.orders, order => typeof order === 'object' && order !== null ? (order as Readonly<Record<string, unknown>>).keys : undefined, isOrder);
}

/** Whether `keys`, part keys already checked, and `order`'s `by` make an order `cadBodyParts` could have recorded. */
function isOrder(order: unknown, keys: readonly string[]): boolean {
  if (keys.length < 2) return false;
  const first = keys[0], parent = first.slice(0, first.lastIndexOf('/') + 1), start = splitIndexOf(first);
  if (start === undefined) return false;
  for (const [i, part] of keys.entries()) if (part !== `${parent}split(${start + i})`) return false;
  const by = (order as Readonly<Record<string, unknown>>).by;
  if (by === undefined) return true;
  if (!Array.isArray(by) || by.length !== keys.length) return false;
  for (const pairs of by) {
    if (!Array.isArray(pairs) || !pairs.length || pairs.length % 2 || pairs.length > 2 * MAX_CAD_BODY_SHARED_SOLIDS) return false;
    for (const [i, value] of pairs.entries()) if (!Number.isSafeInteger(value) || value < 0 || i % 2 === 0 && i && value <= pairs[i - 2]) return false;
  }
  return orderWork(by) <= MAX_CAD_BODY_ORDER_WORK;
}

/** The index of a key whose last occurrence is `split(k)`, or `undefined`. */
function splitIndexOf(key: string): number | undefined {
  const match = /\/split\((0|[1-9]\d{0,5})\)$/.exec(key);
  return match ? Number(match[1]) : undefined;
}

const BODY_ISSUE_CODES: ReadonlySet<unknown> = new Set<CadBodyIssue['code']>(['ambiguous-body-parts', 'lost-body-parts', 'untracked-body-parts', 'more-body-issues']);

/** Checks a body issue received across the worker boundary. */
export function isCadBodyIssue(value: unknown): value is CadBodyIssue {
  if (typeof value !== 'object' || value === null) return false;
  const issue = value as Readonly<Record<string, unknown>>, pieces = issue.pieces;
  if (!BODY_ISSUE_CODES.has(issue.code) || !isFeatureId(issue.featureId) || !isCadBodyKey(issue.body)) return false;
  if (!Array.isArray(pieces) || pieces.length > MAX_CAD_BODY_LIST) return false;
  for (const piece of pieces) if (!isCadBodyKey(piece)) return false;
  if (issue.reason !== undefined && (issue.code !== 'untracked-body-parts' || !UNTRACKED_REASONS.has(issue.reason))) return false;
  return typeof issue.message === 'string' && issue.message.length <= MAX_CAD_BODY_ISSUE_MESSAGE;
}

/** The feature whose result the body now is: its last modifier, or its creator. */
export function cadBodyFeatureId(state: Pick<CadBodyState, 'createdBy' | 'modifiedBy'>): string {
  return state.modifiedBy.length ? state.modifiedBy[state.modifiedBy.length - 1] : state.createdBy;
}

/**
 * A body fact a rebuild could not settle, for D1 to adopt as an issue. `pieces` lists every key it is about, in full; the message names
 * only their count, so its length is bounded by the body key's.
 * - `ambiguous-body-parts`: after `featureId`, no build ties `pieces` of `body` to one solid each with certainty. References to them
 *   resolve as ambiguous. Each ambiguous key is listed by the issue of the feature that made it ambiguous: a later key that is ambiguous
 *   only because it descends from one extends that issue, so the same uncertainty is reported once, until the issue lists
 *   `MAX_CAD_BODY_LIST` keys; past that, the later feature lists the rest in an issue of its own.
 * - `lost-body-parts`: `pieces` of `body` named a solid before `featureId` in some kernel order and name none after it in any, since it
 *   removed or merged their solids. It lists every such key, whether or not this build gave it, digits by value, so every kernel order
 *   reports the same. References to them resolve as missing.
 * - `untracked-body-parts`: after `featureId`, the lineage stops tracking the parts of `body`, so it keeps none from then on. `reason`
 *   gives the bound it passed: more solids than it tracks (`part-limit`); more part names or longer ones than it tracks, whether names
 *   the body keeps or names it lost (`key-limit`); or more work to find which names were lost than a rebuild allows (`search-limit`),
 *   which can stop it even when none was.
 * - `more-body-issues`: the issues from `featureId` on did not fit in the list; the message gives how many were left out.
 */
export interface CadBodyIssue {
  readonly code: 'ambiguous-body-parts' | 'lost-body-parts' | 'untracked-body-parts' | 'more-body-issues';
  readonly featureId: string;
  readonly body: CadBodyKey;
  readonly pieces: readonly CadBodyKey[];
  readonly message: string;
  /** Given for `untracked-body-parts` only. */
  readonly reason?: CadBodyUntrackedReason;
}
/** Why the lineage stopped tracking a body's parts: more solids than it tracks, more or longer part names, or more tracing work than a rebuild allows. */
export type CadBodyUntrackedReason = 'part-limit' | 'key-limit' | 'search-limit';
const UNTRACKED_REASONS: ReadonlySet<unknown> = new Set<CadBodyUntrackedReason>(['part-limit', 'key-limit', 'search-limit']);

/** The most issues one build lists: the last place goes to a `more-body-issues` summary when there are more. */
export const MAX_CAD_BODY_ISSUES = 512;
/** The longest issue message: a body key and a sentence. */
const MAX_CAD_BODY_ISSUE_MESSAGE = 8192;

/**
 * A shape whose faces a feature's result may keep: the target before the feature, a pattern's copy of it, at `inst(i,j)`, or a tool the
 * feature fused into it. A pattern's copy at `inst(0,0)` is the target itself.
 */
export type CadBodySource = { readonly kind: 'target' } | { readonly kind: 'copy'; readonly i: number; readonly j: number } | { readonly kind: 'tool' };

/** A solid of a source that a solid of the result keeps a face of unchanged, with the first such face's place in the source's face order, from 1. */
export interface CadBodySolidSource {
  /** The source's place in `CadBodyKernelFacts.sources`. */
  readonly source: number;
  /** The solid's number in the source, as `CadMesh.faceSolids` numbers a result's solids; a copy numbers its solids as the target does. */
  readonly solid: number;
  readonly rank: number;
}

/** What only the kernel knows about a feature's result, which the body's parts depend on. */
export interface CadBodyKernelFacts {
  /** The result's solid count. */
  readonly solids: number;
  /** Whether the feature removes material from its target, and so may split it. */
  readonly removesMaterial: boolean;
  /** The result lists its solids exactly as its target did, as a moved copy does. */
  readonly sameSolidOrder?: boolean;
  /** The shapes the feature combined, its target first. */
  readonly sources: readonly CadBodySource[];
  /** For each solid of the result, every source solid it keeps a face of; called only when the body's parts depend on it. */
  provenance(): readonly (readonly CadBodySolidSource[])[];
}

/** How one feature changed the bodies: the body it made or kept, and the keys it consumed. */
export interface CadBodyChange {
  readonly state: CadBodyState;
  /** Whether the feature kept the key of a body that existed before it. */
  readonly kept: boolean;
  readonly consumed: readonly CadBodyKey[];
}

/**
 * The bodies of one history, applied feature by feature in history order. A feature's body behaviour decides its effect:
 * - `none`: no body;
 * - `new`: a body keyed by the feature, with the kind's `occurrence`, such as a mirror image's `mirror`;
 * - `modify-target`: its target or source keeps its key and records the feature as a modifier;
 * - `new-or-modify`: as `modify-target` when it names a target, otherwise as `new`;
 * - `consume-tools`: as `modify-target` for its target; each tool is consumed by it.
 * With the kernel's facts, the kept body's parts follow its solids (`cadBodyParts`): a pattern's separate copies are `inst(i,j)` parts and
 * split pieces `split(k)` parts. A new body starts whole, a mirror image too, whatever parts its source has. An inactive feature changes
 * no body. Its suppression decides what its own id stands for meanwhile: `pass-through` passes on the body it would have changed (`of`);
 * `no-output` stands for nothing.
 */
export interface CadBodyLineage {
  /** Applies the next feature. The kernel passes facts about its result; without them the lineage tracks no pieces. */
  apply(feature: CadFeature, scope: CadFeatureScope, facts?: CadBodyKernelFacts): CadBodyChange | undefined;
  /** The key `feature` would make or keep if applied next, without applying it. */
  keyFor(feature: CadFeature, scope: CadFeatureScope): CadBodyKey | undefined;
  /** Whether `featureId` is the feature whose result a current body is, as `at` finds it, without making the body's state. */
  has(featureId: string): boolean;
  /** The current body whose state `featureId` is: how a stored target or source resolves to a body until S8 stores body refs. */
  at(featureId: string): CadBodyState | undefined;
  /** The current body that `featureId` created, modified or, suppressed with `pass-through`, passes on: where a selected feature leads. */
  of(featureId: string): CadBodyState | undefined;
  /** The current body with `key`. */
  get(key: CadBodyKey): CadBodyState | undefined;
  /** Current bodies, oldest current state first, as meshes list them. */
  bodies(): readonly CadBodyState[];
  /** Bodies consumed as Boolean tools, in the order they were consumed. */
  consumed(): readonly CadBodyState[];
  /** The body most recently created or modified. */
  latest(): CadBodyState | undefined;
  issues(): readonly CadBodyIssue[];
}

/** The body inputs of `feature`: the one it keeps, by its target or source slot, and the others, which it consumes as tools. */
function bodyInputs(feature: CadFeature): { readonly kept: string | undefined; readonly tools: readonly string[] } {
  let kept: string | undefined; const tools: string[] = [];
  for (const { name, meaning: slot } of cadFeatureLayout(feature).slots) {
    if (slot.accepts[0] !== 'body') continue;
    const value = (feature as unknown as Readonly<Record<string, unknown>>)[name];
    if (value === undefined || value === null) continue;
    for (const id of slot.ids(value)) {
      if (kept === undefined && (slot.role === 'target' || slot.role === 'source')) kept = id;
      else tools.push(id);
    }
  }
  return { kept, tools };
}

function withSplit(key: CadBodyKey, k: number): CadBodyKey { return cadBodyKeyWith(key, { kind: 'split', k }); }

function freeze<T extends object>(value: T): T { return Object.freeze(value); }

/** How a feature that kept a body's key changed its parts. */
export interface CadBodyParts {
  readonly pieces?: readonly CadBodyKey[];
  readonly ambiguous?: readonly (readonly CadBodyKey[])[];
  readonly orders?: readonly CadBodyOrder[];
  readonly untracked?: true;
  /**
   * Keys the feature itself left ambiguous, for a new `ambiguous-body-parts` issue: none was ambiguous before it or descends from a key
   * that was.
   */
  readonly ambiguousNow: readonly CadBodyKey[];
  /** Keys that are ambiguous because they descend from a key that was ambiguous before the feature, each with that key, whose issue lists them too. */
  readonly inherited: readonly (readonly [CadBodyKey, CadBodyKey])[];
  /**
   * Every key that named a solid of the body before the feature, in some kernel order, and that it left naming none in any, for a
   * `lost-body-parts` issue, sorted so that every kernel order gives the same list.
   */
  readonly lost: readonly CadBodyKey[];
  /** Why the feature left the body's parts untracked, for an `untracked-body-parts` issue. */
  readonly overflowed?: CadBodyUntrackedReason;
}

const NONE: readonly CadBodyKey[] = freeze([]);
const NO_PAIRS: readonly (readonly [CadBodyKey, CadBodyKey])[] = freeze([]);
const WHOLE: CadBodyParts = freeze({ ambiguousNow: NONE, inherited: NO_PAIRS, lost: NONE });
const UNTRACKED: CadBodyParts = freeze({ untracked: true as const, ambiguousNow: NONE, inherited: NO_PAIRS, lost: NONE });
const overflowed = (reason: CadBodyUntrackedReason): CadBodyParts => freeze({ untracked: true as const, ambiguousNow: NONE, inherited: NO_PAIRS, lost: NONE, overflowed: reason });
const OVERFLOWED: Readonly<Record<CadBodyUntrackedReason, CadBodyParts>> = { 'part-limit': overflowed('part-limit'), 'key-limit': overflowed('key-limit'), 'search-limit': overflowed('search-limit') };
/** What every tool solid passes on: never a key, since a key is never empty. Solids of a fused tool alone get fresh keys. */
const TOOL = '' as CadBodyKey;

/**
 * The faces of one source that a solid of the result keeps for one key: the lowest rank, the source it lies in, which comes first of those
 * the key's faces come through, and the lowest rank in each of that source's solids.
 */
interface Lead { rank: number; source: number; solids: Map<number, number> }
/**
 * A solid of the result in an ordered list: those continuing one key, the tool's, the merges, or those keeping no face. `rank` orders the
 * list, by the lowest face the solid keeps, which lies in source `source`, -1 when it keeps none. `solids` gives the lowest face it keeps in
 * each solid of that source, which decides its place in other kernel orders.
 */
interface Placed { readonly solid: number; readonly rank: number; readonly source: number; readonly solids: readonly (readonly [number, number])[] }
/** A key before a feature that a solid of its result keeps faces of, and the source they came through. */
interface Descent { readonly origin: CadBodyKey; readonly via: number }
/** Entries `start` to `end` of an ordered list, which the kernel's order numbers, with what places each one, as `CadBodyOrder.by`. */
interface Run { readonly start: number; readonly end: number; readonly by?: readonly (readonly number[])[] }

/**
 * The runs of an ordered list whose order the kernel decides: ranks order solids by faces of one solid of a source, since faces of
 * different solids rank in the order the kernel lists those solids, and solids keeping no face come in the kernel's order. So a source's
 * entries that decide by several of its solids are a run, with what places each one; of those that decide by one, entries of equal rank,
 * which the kernel's order breaks, are a run, as the entries keeping no face are. An entry alone is in no run, whatever decides it.
 */
function orderRuns(list: readonly Placed[]): readonly Run[] {
  const runs: Run[] = [];
  for (let start = 0, end = 1; start < list.length; start = end, end = start + 1) {
    while (end < list.length && list[end].source === list[start].source) end++;
    if (end - start < 2) continue;
    const group = list.slice(start, end), solids = [...new Set(group.flatMap(entry => entry.solids.map(([solid]) => solid)))].sort((a, b) => a - b);
    if (solids.length > 1) {
      const by = orderBy(group, solids);
      runs.push(orderWork(by) <= MAX_CAD_BODY_ORDER_WORK ? { start, end, by } : { start, end });
    } else if (!solids.length) runs.push({ start, end });
    else for (let at = start, to = at + 1; at < end; at = to, to = at + 1) {
      while (to < end && list[to].rank === list[at].rank) to++;
      if (to - at > 1) runs.push({ start: at, end: to });
    }
  }
  return runs;
}

/** Each entry's source solids and first faces in them, as ranks from 0, solids ascending. */
function orderBy(group: readonly Placed[], solids: readonly number[]): readonly (readonly number[])[] {
  const numbers = new Map(solids.map((solid, n) => [solid, n])), ranks = new Map<number, number[]>(solids.map(solid => [solid, []]));
  for (const entry of group) for (const [solid, rank] of entry.solids) ranks.get(solid)!.push(rank);
  const dense = new Map([...ranks].map(([solid, list]) => [solid, new Map([...new Set(list)].sort((a, b) => a - b).map((rank, n) => [rank, n]))]));
  return freeze(group.map(entry => freeze([...entry.solids].sort((a, b) => a[0] - b[0]).flatMap(([solid, rank]) => [numbers.get(solid)!, dense.get(solid)!.get(rank)!]))));
}

/**
 * The work finding the places of an order with `by` takes: each piece keeping a face of a shared solid, one some piece keeps first faces
 * of together with another solid, counts each subset of the shared solids, and the sums of the other pieces' blocks. Infinite past
 * `MAX_CAD_BODY_SHARED_SOLIDS`.
 */
function orderWork(by: readonly (readonly number[])[]): number {
  const shared = new Set<number>();
  for (const pairs of by) if (pairs.length > 2) for (let i = 0; i < pairs.length; i += 2) shared.add(pairs[i]);
  if (shared.size > MAX_CAD_BODY_SHARED_SOLIDS) return Infinity;
  let touching = 0;
  for (const pairs of by) for (let i = 0; i < pairs.length; i += 2) if (shared.has(pairs[i])) { touching++; break; }
  return touching * (2 ** shared.size + Math.min(touching, by.length - touching + 1) * ((by.length >>> 5) + 1));
}

/** A set of places from 0, as bits. */
type Places = Uint32Array;
function noPlaces(count: number): Places { return new Uint32Array((count >>> 5) + 1); }
function hasPlace(places: Places, at: number): boolean { return (places[at >>> 5] >>> (at & 31) & 1) === 1; }
function addPlace(places: Places, at: number): void { places[at >>> 5] |= 1 << (at & 31); }
/** Adds to `into` each place of `from` moved up by `shift`, top down so that `from` may be `into`. Places past `into`'s size are dropped. */
function addShifted(into: Places, from: Places, shift: number): void {
  const words = shift >>> 5, bits = shift & 31;
  for (let i = into.length - 1; i >= words; i--) {
    const at = i - words;
    into[i] |= from[at] << bits | (bits && at ? from[at - 1] >>> 32 - bits : 0);
  }
}
/** `places` moved up by each of 0 to `width`. */
function spread(places: Places, width: number): Places {
  const out = places.slice();
  for (let covered = 1; covered <= width;) { const step = Math.min(covered, width + 1 - covered); addShifted(out, out, step); covered += step; }
  return out;
}

const orderPlaces = new WeakMap<CadBodyOrder, readonly Places[]>();
/** The places, from the order's first index, each of `order`'s pieces takes in some kernel order; found once per order. */
function placesOf(order: CadBodyOrder): readonly Places[] {
  let found = orderPlaces.get(order);
  if (!found) {
    if (order.by) found = byPlaces(order.by);
    else {
      const every = noPlaces(order.keys.length);
      for (let at = 0; at < order.keys.length; at++) addPlace(every, at);
      found = order.keys.map(() => every);
    }
    orderPlaces.set(order, found);
  }
  return found;
}

/** Every index each of `order`'s pieces takes in some kernel order, ascending. */
export function cadBodyOrderPlaces(order: CadBodyOrder): readonly (readonly number[])[] {
  const start = splitIndexOf(order.keys[0]) ?? 0, count = order.keys.length;
  return placesOf(order).map(places => { const list: number[] = []; for (let at = 0; at < count; at++) if (hasPlace(places, at)) list.push(start + at); return list; });
}

/** Whether a kernel order other than this build's may give `order`'s piece `i` another index. */
function unsettledAt(order: CadBodyOrder, i: number): boolean {
  if (!order.by) return true;
  const places = placesOf(order)[i];
  let seen = 0;
  for (let at = 0; at < order.keys.length; at++) if (hasPlace(places, at) && ++seen > 1) return true;
  return false;
}

/**
 * The places of an order with `by`. A piece comes first in its solid t when the other solids it keeps faces of come after t, and then
 * comes after the pieces keeping a face of a solid before t, whichever of the other solids those are, after the pieces whose first face in t
 * comes before its own, and anywhere among those tying with it there. A solid whose pieces keep faces of it alone adds them as a block, so
 * the blocks before t add each sum of block sizes; for the shared solids, each subset that may come before t is counted.
 */
function byPlaces(by: readonly (readonly number[])[]): readonly Places[] {
  const count = by.length, bit = new Map<number, number>();
  for (const pairs of by) if (pairs.length > 2) for (let i = 0; i < pairs.length; i += 2) if (!bit.has(pairs[i])) bit.set(pairs[i], bit.size);
  const full = (1 << bit.size) - 1, masks = by.map(pairs => {
    let mask = 0;
    for (let i = 0; i < pairs.length; i += 2) { const b = bit.get(pairs[i]); if (b !== undefined) mask |= 1 << b; }
    return mask;
  });
  const touching = masks.filter(mask => mask).length, blocks = new Map<number, number[]>();
  by.forEach((pairs, e) => { if (masks[e]) return; const block = blocks.get(pairs[0]); if (block) block.push(e); else blocks.set(pairs[0], [e]); });
  // within[m]: the pieces keeping faces of shared solids in m only, so the shared solids in p come before every other piece of theirs.
  const within = new Int32Array(full + 1);
  for (const mask of masks) if (mask) within[mask]++;
  for (let b = 0; b < bit.size; b++) for (let m = 0; m <= full; m++) if (m & 1 << b) within[m] += within[m ^ 1 << b];
  const claimed = (before: number) => touching - within[full & ~before];
  // The sums of block sizes, leaving one block of a size out for that block's own pieces, by bounded subset sums.
  const sizes = new Map<number, number>(), sums = new Map<number, Places>();
  for (const block of blocks.values()) sizes.set(block.length, (sizes.get(block.length) ?? 0) + 1);
  const sumsWithout = (size: number) => {
    let found = sums.get(size);
    if (!found) {
      found = noPlaces(count); addPlace(found, 0);
      for (const [length, many] of sizes)
        for (let left = many - (length === size ? 1 : 0), take = 1; left > 0; left -= take, take *= 2) addShifted(found, found, length * Math.min(take, left));
      sums.set(size, found);
    }
    return found;
  };
  const places = new Array<Places>(count);
  // A block's piece: any subset of the shared solids and any other blocks may come before its solid.
  const claims = noPlaces(count), withClaims = new Map<number, Places>();
  for (let before = 0; before <= full; before++) addPlace(claims, claimed(before));
  for (const block of blocks.values()) {
    let base = withClaims.get(block.length);
    if (!base) {
      const without = sumsWithout(block.length);
      base = noPlaces(count);
      for (let at = 0; at <= touching; at++) if (hasPlace(claims, at)) addShifted(base, without, at);
      withClaims.set(block.length, base);
    }
    const ranks = block.map(e => by[e][1]).sort((a, b) => a - b);
    for (const e of block) {
      const rank = by[e][1], less = lowerBound(ranks, rank), ties = lowerBound(ranks, rank + 1) - less - 1, placed = noPlaces(count);
      addShifted(placed, spread(base, ties), less);
      places[e] = placed;
    }
  }
  // A piece keeping faces of shared solids: for each solid t of its own that comes first, each subset of the shared solids it keeps no face
  // of may come before t, counted with the pieces of t before it and those tying with it that keep no face of that subset.
  const spans: number[][] = by.map(() => []);
  const add = (counts: Int32Array, mask: number, step: number) => { for (let m = mask; m <= full; m = (m + 1) | mask) counts[m] += step; };
  for (const [solid, b] of bit) {
    const at: (readonly [number, number])[] = [];
    by.forEach((pairs, e) => { if (masks[e] & 1 << b) for (let i = 0; i < pairs.length; i += 2) if (pairs[i] === solid) at.push([e, pairs[i + 1]]); });
    at.sort((x, y) => x[1] - y[1]);
    const less = new Int32Array(full + 1), tied = new Int32Array(full + 1);
    for (let from = 0, to = 1; from < at.length; from = to, to = from + 1) {
      while (to < at.length && at[to][1] === at[from][1]) to++;
      for (let i = from; i < to; i++) add(tied, masks[at[i][0]], 1);
      for (let i = from; i < to; i++) {
        const e = at[i][0], others = full & ~masks[e];
        for (let before = others; ; before = (before - 1) & others) {
          const after = full & ~before, first = claimed(before) + less[after];
          spans[e].push(first, first + tied[after] - 1);
          if (!before) break;
        }
      }
      for (let i = from; i < to; i++) { add(tied, masks[at[i][0]], -1); add(less, masks[at[i][0]], 1); }
    }
  }
  const sumsAll = sumsWithout(0);
  masks.forEach((mask, e) => {
    if (!mask) return;
    const list = spans[e], pairs: [number, number][] = [];
    for (let i = 0; i < list.length; i += 2) pairs.push([list[i], list[i + 1]]);
    pairs.sort((x, y) => x[0] - y[0]);
    const placed = noPlaces(count);
    for (let i = 0; i < pairs.length;) {
      const low = pairs[i][0];
      let high = pairs[i][1];
      for (i++; i < pairs.length && pairs[i][0] <= high + 1; i++) high = Math.max(high, pairs[i][1]);
      addShifted(placed, spread(sumsAll, high - low), low);
    }
    places[e] = placed;
  });
  // Each piece takes the index this build gave it: kept should faces ever rank otherwise, so a piece is never settled at another index.
  places.forEach((placed, e) => addPlace(placed, e));
  return freeze(places);
}

/** The first place in `sorted` holding a value of at least `value`. */
function lowerBound(sorted: readonly number[], value: number): number {
  let low = 0, high = sorted.length;
  while (low < high) { const mid = (low + high) >>> 1; if (sorted[mid] < value) low = mid + 1; else high = mid; }
  return low;
}

/** A body's orders by the keys they number, and by the key whose pieces they number, for resolving its keys; made once per list. */
interface OrderIndex { readonly at: ReadonlyMap<string, readonly [CadBodyOrder, number]>; readonly under: ReadonlyMap<string, readonly CadBodyOrder[]> }
const NO_ORDERS: OrderIndex = { at: new Map(), under: new Map() };
const orderIndexes = new WeakMap<readonly CadBodyOrder[], OrderIndex>();
function orderIndex(orders: readonly CadBodyOrder[] | undefined): OrderIndex {
  if (!orders?.length) return NO_ORDERS;
  let index = orderIndexes.get(orders);
  if (!index) {
    const at = new Map<string, readonly [CadBodyOrder, number]>(), under = new Map<string, CadBodyOrder[]>();
    for (const order of orders) {
      order.keys.forEach((part, i) => at.set(part, [order, i]));
      const parent = order.keys[0].slice(0, order.keys[0].lastIndexOf('/')), list = under.get(parent);
      if (list) list.push(order); else under.set(parent, [order]);
    }
    orderIndexes.set(orders, index = { at, under });
  }
  return index;
}

/** Whether a kernel order other than this build's may give the solid `key` names, or one it descends from, another index. */
function unsettled(index: OrderIndex, key: string): boolean {
  if (!index.at.size) return false;
  for (let end = key.length; end > 0; end = key.lastIndexOf('/', end - 1)) {
    const found = index.at.get(key.slice(0, end));
    if (found && unsettledAt(found[0], found[1])) return true;
  }
  return false;
}

/**
 * The parts of a body after a feature that kept its key, from every source solid each solid of the result keeps a face of. A key is
 * inherited only when continuity is certain; anything else gets a fresh key, a reported ambiguity or a reported loss. Precise lineage
 * through Booleans and splits waits for the kernel's own history (K3).
 *
 * A whole body stays whole until one of its solids may have split (one leaves several solids, a solid keeps none of its faces, or a
 * feature without a tool or copies leaves more solids than it had), or a pattern leaves a copy apart from the originals. A tool fused into
 * a whole body keeps it whole.
 *
 * Each source solid passes on a key: a target solid its piece's key, or the body's while whole; a pattern's copy `inst(i,j)` of it, the
 * target itself being `inst(0,0)`; a tool solid no key. Then each solid of the result:
 * - continues the one target key it keeps faces of: a Boolean keeps its target's key;
 * - keeping no target face, continues the one copy key it keeps faces of, or the tool;
 * - keeping faces of several target keys, or of several copies and no target, merges them: it gets a fresh key, and the merged pieces
 *   are reported lost;
 * - keeping no face at all, descends from the target's one key when the target has one and the feature added no material. Otherwise it
 *   gets a fresh key, and since face provenance is then incomplete, nothing proves that a key one solid continues did not also split into
 *   it, or which piece no solid continues it is: those keys and it are ambiguous together.
 * A key continued by one solid stays; continued by several, each is `key/split(q)`, q by the rank of the first face it keeps, then the
 * solids keeping none. Fresh keys are `feature/split(k)`: solids continuing the tool by rank, merges by rank, then solids keeping no face.
 * Where the kernel's order decides those indices, the split is recorded as an order (`orderRuns`) with what places each piece; a piece
 * that some order places otherwise is ambiguous, and so is every key continuing it. A key that named a piece before, in some order, and
 * names none now is lost, unless a solid it could name continues, as an old key does once its solid split or was copied. Every key naming
 * a removed or merged piece in some order is checked, including those neither this build's pieces nor its orders list, so the keys lost
 * are the same in every kernel order; past `MAX_CAD_BODY_LIST` of them, or `MAX_CAD_BODY_ORDER_WORK` steps of reading, the body's parts
 * are untracked.
 *
 * Uncertain provenance carries in groups: the keys that descend from one group through one source form a group, so the copies of one
 * pattern occurrence are never confused with another's. A group's earlier keys that are no longer pieces stay in it, as keys that can't
 * be found, while any solid descends from the group through the target, and are lost once none does.
 */
export function cadBodyParts(input: {
  readonly featureId: string;
  readonly previous: Pick<CadBodyState, 'key' | 'pieces' | 'ambiguous' | 'orders' | 'untracked'>;
  readonly beforeSolids: number | undefined;
  readonly facts: CadBodyKernelFacts;
}): CadBodyParts {
  const { featureId, previous, facts } = input, key = previous.key, count = facts.solids, before = previous.pieces;
  if (previous.untracked) return UNTRACKED;
  if (before && facts.sameSolidOrder && before.length === count) return freeze({ pieces: before, ...(previous.ambiguous ? { ambiguous: previous.ambiguous } : {}),
    ...(previous.orders ? { orders: previous.orders } : {}), ambiguousNow: NONE, inherited: NO_PAIRS, lost: NONE });
  const patterned = facts.sources.some(source => source.kind === 'copy'), fused = facts.sources.some(source => source.kind === 'tool');
  const beforeSolids = input.beforeSolids ?? 1;
  if (!before && (count <= 1 || fused && !patterned || !patterned && !facts.removesMaterial && count <= beforeSolids)) return WHOLE;
  if (count > MAX_CAD_BODY_LIST) return OVERFLOWED['part-limit'];
  const traced = facts.provenance();
  if (traced.length !== count) throw new Error('Each solid of the result needs its sources.');
  if (!before && (patterned ? traced.every(sources => sources.some(entry => entry.source === 0)) : !splits(traced, count, beforeSolids))) return WHOLE;

  // The key each source solid passes on, and the key before it came from.
  const previousKey = (solid: number) => {
    const found = before ? before[solid] : key;
    if (found === undefined) throw new Error('A source solid the body did not have.');
    return found;
  };
  const originOf = new Map<CadBodyKey, CadBodyKey>();
  const continued = new Map<CadBodyKey, Placed[]>(), merged: Placed[] = [], orphans: number[] = [];
  const continuedFrom = new Set<CadBodyKey>(), mergedFrom = new Set<CadBodyKey>(), descends: (readonly Descent[])[] = [];
  // Only the first source a key's faces come through decides the solid's place: its faces rank before any later source's.
  const note = (into: Map<CadBodyKey, Lead>, passed: CadBodyKey, rank: number, source: number, solid: number) => {
    const lead = into.get(passed);
    if (!lead) { into.set(passed, { rank, source, solids: new Map([[solid, rank]]) }); return; }
    if (source > lead.source) return;
    if (source < lead.source) { lead.rank = rank; lead.source = source; lead.solids = new Map([[solid, rank]]); return; }
    if (rank < lead.rank) lead.rank = rank;
    const known = lead.solids.get(solid);
    if (known === undefined || rank < known) lead.solids.set(solid, rank);
  };
  const push = (passed: CadBodyKey, entry: Placed) => { const list = continued.get(passed); if (list) list.push(entry); else continued.set(passed, [entry]); };
  traced.forEach((sources, solid) => {
    const targets = new Map<CadBodyKey, Lead>(), added = new Map<CadBodyKey, Lead>(), from: Descent[] = [];
    for (const entry of sources) {
      const source = facts.sources[entry.source];
      if (!source) throw new Error('A source the feature did not combine.');
      // Ranks of different sources compare source first.
      const rank = entry.source * 2 ** 32 + entry.rank;
      if (source.kind === 'tool') { note(added, TOOL, rank, entry.source, entry.solid); continue; }
      const origin = previousKey(entry.solid);
      from.push({ origin, via: entry.source });
      const passed = source.kind === 'copy' ? cadBodyKeyWith(origin, { kind: 'inst', i: source.i, j: source.j })
        : patterned ? cadBodyKeyWith(origin, { kind: 'inst', i: 0, j: 0 }) : origin;
      originOf.set(passed, origin);
      note(source.kind === 'copy' ? added : targets, passed, rank, entry.source, entry.solid);
    }
    descends[solid] = from;
    const placed = (lead: Lead): Placed => ({ solid, rank: lead.rank, source: lead.source, solids: [...lead.solids] });
    if (targets.size === 1) {
      const [[passed, lead]] = targets;
      push(passed, placed(lead)); continuedFrom.add(originOf.get(passed)!);
    } else if (targets.size === 0 && added.size === 1) {
      const [[passed, lead]] = added;
      push(passed, placed(lead));
    } else if (targets.size || added.size) {
      const leads = [...targets.values(), ...added.values()];
      let first = leads[0];
      for (const lead of leads) if (lead.rank < first.rank) first = lead;
      // A merge's first face is the first that any of its keys keeps through the source that comes first.
      const solids = new Map<number, number>();
      for (const lead of leads) {
        if (lead.source !== first.source) continue;
        for (const [at, rank] of lead.solids) { const known = solids.get(at); if (known === undefined || rank < known) solids.set(at, rank); }
      }
      merged.push({ solid, rank: first.rank, source: first.source, solids: [...solids] });
      for (const passed of targets.keys()) mergedFrom.add(originOf.get(passed)!);
    } else orphans.push(solid);
  });

  // A solid keeping no face descends from the target's one key when nothing else could have made it.
  if (orphans.length && !patterned && !fused && (!before || before.length === 1)) {
    const origin = before ? before[0] : key;
    for (const solid of orphans) { push(origin, { solid, rank: Infinity, source: -1, solids: [] }); descends[solid] = [{ origin, via: 0 }]; }
    continuedFrom.add(origin); originOf.set(origin, origin);
    orphans.length = 0;
  }
  const pieces = new Array<CadBodyKey>(count), unchanged: number[] = [], orders: CadBodyOrder[] = [];
  const byRank = (a: Placed, b: Placed) => a.rank - b.rank || a.solid - b.solid;
  const ordered = (list: readonly Placed[]) => {
    for (const run of orderRuns(list))
      orders.push(freeze({ keys: freeze(list.slice(run.start, run.end).map(entry => pieces[entry.solid])), ...(run.by ? { by: run.by } : {}) }));
  };
  for (const [passed, list] of continued) {
    if (passed === TOOL) continue;
    list.sort(byRank);
    if (list.length === 1 && passed !== key) { pieces[list[0].solid] = passed; unchanged.push(list[0].solid); }
    else list.forEach((entry, q) => { pieces[entry.solid] = withSplit(passed, q); });
    ordered(list);
  }
  const tools = (continued.get(TOOL) ?? []).sort(byRank), left = orphans.map((solid): Placed => ({ solid, rank: Infinity, source: -1, solids: [] }));
  merged.sort(byRank);
  [...tools, ...merged, ...left].forEach((entry, k) => { pieces[entry.solid] = cadBodyKey(featureId, [{ kind: 'split', k }]); });
  ordered(tools); ordered(merged); ordered(left);

  // Keys that must share a group: those a solid keeping no face leaves uncertain, and the descendants of each earlier group through each
  // source.
  // The group each earlier key is in comes from the index the previous state already has.
  const sets: (readonly CadBodyKey[])[] = [], groupOf = partsOf(previous).groupOf;
  const groupAt = new Map(previous.ambiguous?.map((group, g) => [group, g]));
  // Keys before that no solid continues are unidentified when a solid keeping no face could be one of them, whatever group they were in.
  const unidentified = new Set<CadBodyKey>();
  if (orphans.length) for (const piece of before ?? []) if (!continuedFrom.has(piece) && !mergedFrom.has(piece)) unidentified.add(piece);
  if (orphans.length) for (const earlier of previous.ambiguous?.flat() ?? []) if (!continuedFrom.has(earlier) && !mergedFrom.has(earlier)) unidentified.add(earlier);
  if (orphans.length) {
    // A key continued unchanged by one solid may also have split into a solid keeping no face, which would then have made it key/split(q).
    const uncertain = [...left.map(entry => pieces[entry.solid]), ...unchanged.map(solid => pieces[solid]), ...unidentified];
    if (uncertain.length > 1) sets.push(uncertain);
  }
  const descent = new Map<string, CadBodyKey[]>(), inherited: (readonly [CadBodyKey, CadBodyKey])[] = [];
  pieces.forEach((piece, solid) => {
    for (const { origin, via } of descends[solid]) {
      const originGroup = groupOf.get(origin);
      if (!originGroup) continue;
      const id = `${groupAt.get(originGroup)} ${via}`, group = descent.get(id);
      if (!group) descent.set(id, [piece]); else if (group[group.length - 1] !== piece) group.push(piece);
      if (!groupOf.has(piece)) inherited.push([piece, origin]);
    }
  });
  // A key continuing one that another kernel order could have numbered otherwise names another solid in that order, so it is ambiguous
  // through that key. A merge's fresh key is not: it names the merge whichever key each piece had.
  const earlier = orderIndex(previous.orders);
  for (const [passed, list] of continued) {
    const origin = originOf.get(passed);
    if (origin === undefined || groupOf.has(origin) || !unsettled(earlier, origin)) continue;
    for (const entry of list) if (pieces[entry.solid] !== origin) inherited.push([pieces[entry.solid], origin]);
  }
  const current = new Set(pieces);
  previous.ambiguous?.forEach((group, g) => {
    const home = descent.get(`${g} 0`);
    for (const member of group) {
      // Which member a solid continued is uncertain, so a member's key that is no longer a piece, whether its solid split, was copied or
      // went, may name any solid descending from the group: it stays while one does.
      if (!current.has(member) && home) home.push(member);
    }
  });
  sets.push(...descent.values());

  // Groups are the sets joined wherever they share a key, in the order their keys first appear.
  const parent = new Map<CadBodyKey, CadBodyKey>();
  const root = (part: CadBodyKey): CadBodyKey => {
    let top = part;
    while (parent.get(top) !== top) top = parent.get(top)!;
    for (let at = part; at !== top;) { const next = parent.get(at)!; parent.set(at, top); at = next; }
    return top;
  };
  for (const set of sets) {
    for (const part of set) if (!parent.has(part)) parent.set(part, part);
    for (const part of set.slice(1)) parent.set(root(part), root(set[0]));
  }
  // An earlier order stays while one of its keys is, or leads to, a piece or a group's key: no key leads through its others.
  const leads = addLeads(new Set(), [...pieces, ...parent.keys()]);
  const kept = [...(previous.orders ?? []).filter(order => order.keys.some(part => leads.has(part))), ...orders];
  const all = new Set<CadBodyKey>([...pieces, ...parent.keys(), ...kept.flatMap(order => order.keys)]);
  if (all.size > MAX_CAD_BODY_LIST || pieces.some(piece => piece.length > MAX_CAD_BODY_KEY_LENGTH)) return OVERFLOWED['key-limit'];
  const groups = new Map<CadBodyKey, CadBodyKey[]>();
  for (const part of parent.keys()) { const top = root(part), group = groups.get(top); if (group) group.push(part); else groups.set(top, [part]); }
  const ambiguous = [...groups.values()].map(group => freeze(group));
  // A key that named a piece before, in some kernel order, and names none now is lost, unless a solid it could name continues: then that
  // solid split or was copied, and the key is an old one. So a piece's key is not lost while another order gives it a solid that is left.
  const after: CadBodyPartsView = { pieces, ambiguous: ambiguous.length ? ambiguous : undefined, orders: kept };
  partsOf(after, leads);
  // Only a key naming a piece no solid continues, or a member of a group no solid descends from through the target, can be lost: the
  // members of a group a solid descends from that way are all in a group with that solid now. Every key naming one of those in some kernel
  // order is checked, whether or not this build gave it, so the keys lost are the same in every order. A key naming one that is still a
  // piece or a group's key names it now too, since the orders that let it are kept: the search would find none of their keys lost, at far
  // greater cost, so they are skipped.
  const homeless = previous.ambiguous?.filter((_, g) => !descent.has(`${g} 0`)).flat() ?? [], stays = passer(after, () => true);
  const lost = lostKeys(previous, after, [...(before ?? []).filter(piece => !continuedFrom.has(piece)), ...homeless].filter(part => !stays(part)), continuedFrom);
  if (typeof lost === 'string') return OVERFLOWED[lost];
  // The keys this feature made ambiguous: its groups' keys and the pieces its orders may place otherwise, unless they were ambiguous before
  // or are ambiguous through a key that was.
  const descended = new Set(inherited.map(([piece]) => piece));
  const orderedNow = orders.flatMap(order => order.keys.filter((_, i) => unsettledAt(order, i)));
  const fresh = (part: CadBodyKey) => !descended.has(part) && !groupOf.has(part) && !unsettled(earlier, part);
  const ambiguousNow = [...new Set([...[...parent.keys()].filter(fresh), ...orderedNow.filter(fresh)])];
  return freeze({ pieces: freeze(pieces), ...(ambiguous.length ? { ambiguous: freeze(ambiguous) } : {}),
    ...(kept.length ? { orders: freeze(kept) } : {}), ambiguousNow: freeze(ambiguousNow), inherited: freeze(inherited), lost: freeze(lost) });
}

/**
 * Whether a whole body may have split: there are more solids than it had, one of its solids leaves several, or a solid of the result keeps
 * none of its faces, and so might be a piece of any of them.
 */
function splits(traced: readonly (readonly CadBodySolidSource[])[], count: number, beforeSolids: number): boolean {
  if (count > beforeSolids) return true;
  const reached = new Map<number, number>();
  for (const [solid, sources] of traced.entries()) {
    let kept = false;
    for (const entry of sources) {
      if (entry.source !== 0) continue;
      kept = true;
      const last = reached.get(entry.solid);
      if (last !== undefined && last !== solid) return true;
      reached.set(entry.solid, solid);
    }
    if (!kept) return true;
  }
  return false;
}

/** A body's modifiers, shared by its states: each modifier links to the history before it, so applying one copies nothing. */
interface History { readonly featureId: string; readonly before: History | undefined; readonly length: number }

/** What the lineage keeps of a body. Its state, with the modifiers as a list, is made once, when asked for. */
interface Body {
  readonly key: CadBodyKey;
  readonly createdBy: string;
  readonly history: History | undefined;
  readonly consumedBy?: string;
  readonly pieces?: readonly CadBodyKey[];
  readonly ambiguous?: readonly (readonly CadBodyKey[])[];
  readonly orders?: readonly CadBodyOrder[];
  readonly untracked?: true;
  readonly solids: number | undefined;
  readonly order: number;
  state?: CadBodyState;
}

function stateOf(body: Body): CadBodyState {
  if (body.state) return body.state;
  const modifiedBy = new Array<string>(body.history?.length ?? 0);
  for (let link = body.history; link; link = link.before) modifiedBy[link.length - 1] = link.featureId;
  return body.state = freeze({
    key: body.key, kind: 'solid' as const, createdBy: body.createdBy, modifiedBy: freeze(modifiedBy),
    ...(body.consumedBy !== undefined ? { consumedBy: body.consumedBy } : {}),
    ...(body.untracked ? { untracked: true as const } : {}),
    ...(body.pieces && !body.untracked ? { pieces: body.pieces } : {}),
    ...(body.ambiguous?.length && !body.untracked ? { ambiguous: body.ambiguous } : {}),
    ...(body.orders?.length && !body.untracked ? { orders: body.orders } : {})
  });
}

/** An issue as the lineage records it: an ambiguity's keys grow as later features extend it. */
interface Recorded {
  readonly about: Pick<CadBodyIssue, 'code' | 'featureId' | 'body' | 'reason'>;
  readonly pieces: CadBodyKey[];
  readonly listed: Set<CadBodyKey>;
  /** Fixed for every code but `ambiguous-body-parts`, whose message counts its keys. */
  readonly message?: string;
}

/** `n` pieces, in words. */
function piecesOf(n: number): string { return n === 1 ? '1 piece' : `${n} pieces`; }

/** What an `untracked-body-parts` issue says, by its cause. */
const UNTRACKED_MESSAGES: Readonly<Record<CadBodyUntrackedReason, (body: CadBodyKey, featureId: string) => string>> = {
  'part-limit': (body, featureId) => `Body ${body} has more parts than are tracked after ${featureId}, so references to its parts resolve as missing.`,
  'key-limit': (body, featureId) => `Body ${body} has more part names, or longer ones, than are tracked after ${featureId}, so references to its parts resolve as missing.`,
  'search-limit': (body, featureId) => `Finding which parts of body ${body} were lost after ${featureId} takes more work than a rebuild allows, so its parts are no longer tracked and references to them resolve as missing.`
};

export function createCadBodyLineage(): CadBodyLineage {
  /** Current bodies by the feature whose result each now is, in the order meshes list them. */
  const current = new Map<string, Body>();
  const byKey = new Map<CadBodyKey, string>();
  /** The key of the body each feature created, modified or passes on, for `of`. */
  const owners = new Map<string, CadBodyKey>();
  const consumed: Body[] = [], issues: Recorded[] = [];
  /** The ambiguity issues listing each ambiguous key, which keys descending from it extend. */
  const causes = new Map<CadBodyKey, Recorded[]>();
  let applied = 0;

  function plan(feature: CadFeature, scope: CadFeatureScope) {
    const definition = cadFeatureDefinition(feature.kind);
    if (definition.body === 'none' || !cadFeatureActive(feature, scope)) return undefined;
    const { kept, tools } = definition.body === 'new' ? { kept: undefined, tools: [] } : bodyInputs(feature);
    const target = kept === undefined ? undefined : current.get(kept);
    // A target that is not a current body is refused before any rebuild; a prediction starts a body of its own for it.
    const key = target?.key ?? cadBodyKey(feature.id, definition.occurrence === 'mirror' ? [{ kind: 'mirror' }] : []);
    return { kept, tools, target, key };
  }

  function record(code: CadBodyIssue['code'], featureId: string, body: CadBodyKey, pieces: readonly CadBodyKey[], message?: string, reason?: CadBodyUntrackedReason): Recorded {
    const issue: Recorded = { about: { code, featureId, body, ...(reason ? { reason } : {}) }, pieces: [...pieces], listed: new Set(pieces), ...(message !== undefined ? { message } : {}) };
    issues.push(issue);
    return issue;
  }

  function report(featureId: string, body: CadBodyKey, parts: CadBodyParts) {
    if (parts.overflowed) record('untracked-body-parts', featureId, body, NONE, UNTRACKED_MESSAGES[parts.overflowed](body, featureId), parts.overflowed);
    // A key ambiguous only through an ambiguous key it descends from extends that key's issues; one no issue can take is reported here.
    const fresh = new Set(parts.ambiguousNow);
    for (const [piece, origin] of parts.inherited) {
      const reasons = causes.get(origin);
      if (!reasons?.length) { fresh.add(piece); continue; }
      for (const issue of reasons) {
        if (issue.listed.has(piece)) continue;
        if (issue.pieces.length >= MAX_CAD_BODY_LIST) { fresh.add(piece); continue; }
        issue.pieces.push(piece); issue.listed.add(piece);
        const known = causes.get(piece);
        if (!known) causes.set(piece, [issue]); else if (!known.includes(issue)) known.push(issue);
      }
    }
    if (fresh.size) {
      const issue = record('ambiguous-body-parts', featureId, body, [...fresh]);
      for (const piece of fresh) { const known = causes.get(piece); if (!known) causes.set(piece, [issue]); else known.push(issue); }
    }
    if (parts.lost.length) record('lost-body-parts', featureId, body, parts.lost,
      `${piecesOf(parts.lost.length)} of body ${body} no longer exist as separate solids after ${featureId}, which removed them or merged them into another.`);
  }

  return {
    apply(feature, scope, facts) {
      applied++;
      const step = plan(feature, scope);
      if (!step) {
        const definition = cadFeatureDefinition(feature.kind);
        if (definition.body !== 'none' && definition.suppression === 'pass-through' && definition.body !== 'new') {
          const kept = bodyInputs(feature).kept, passed = kept === undefined ? undefined : current.get(kept);
          if (passed) owners.set(feature.id, passed.key);
        }
        return undefined;
      }
      const { kept, tools, target: previous, key } = step;
      // Settle everything that can fail before changing the lineage.
      const parts = previous && facts ? cadBodyParts({ featureId: feature.id, previous, beforeSolids: previous.solids, facts }) : undefined;
      const from = parts ?? previous;
      const next: Body = {
        key, createdBy: previous?.createdBy ?? feature.id,
        history: previous ? { featureId: feature.id, before: previous.history, length: (previous.history?.length ?? 0) + 1 } : undefined,
        ...(from?.untracked ? { untracked: true as const } : {}),
        ...(from?.pieces && !from.untracked ? { pieces: from.pieces } : {}),
        ...(from?.ambiguous && !from.untracked ? { ambiguous: from.ambiguous } : {}),
        ...(from?.orders && !from.untracked ? { orders: from.orders } : {}),
        solids: facts?.solids, order: applied
      };
      const gone: CadBodyKey[] = [];
      if (kept !== undefined && previous) current.delete(kept);
      for (const id of tools) {
        const tool = current.get(id);
        if (!tool) continue;
        current.delete(id); byKey.delete(tool.key); gone.push(tool.key);
        consumed.push({ ...tool, consumedBy: feature.id, state: undefined });
      }
      current.set(feature.id, next);
      byKey.set(key, feature.id); owners.set(feature.id, key);
      if (parts) report(feature.id, key, parts);
      return freeze({ get state() { return stateOf(next); }, kept: previous !== undefined, consumed: freeze(gone) });
    },
    keyFor(feature, scope) { return plan(feature, scope)?.key; },
    has(featureId) { return current.has(featureId); },
    at(featureId) { const body = current.get(featureId); return body && stateOf(body); },
    of(featureId) {
      const key = owners.get(featureId), id = key === undefined ? undefined : byKey.get(key), body = id === undefined ? undefined : current.get(id);
      return body && stateOf(body);
    },
    get(key) { const id = byKey.get(key), body = id === undefined ? undefined : current.get(id); return body && stateOf(body); },
    bodies() { return [...current.values()].map(stateOf); },
    consumed() { return consumed.map(stateOf); },
    latest() {
      let latest: Body | undefined;
      for (const body of current.values()) if (!latest || body.order > latest.order) latest = body;
      return latest && stateOf(latest);
    },
    issues() {
      const listed = issues.slice(0, issues.length <= MAX_CAD_BODY_ISSUES ? issues.length : MAX_CAD_BODY_ISSUES - 1).map(issue => freeze({
        ...issue.about, pieces: freeze([...issue.pieces]),
        message: issue.message ?? `${piecesOf(issue.pieces.length)} of body ${issue.about.body} can't be told apart after ${issue.about.featureId}, so references to them are ambiguous.`
      }));
      if (issues.length <= MAX_CAD_BODY_ISSUES) return listed;
      const first = issues[listed.length].about;
      return [...listed, freeze({ code: 'more-body-issues' as const, featureId: first.featureId, body: first.body, pieces: NONE,
        message: `${issues.length - listed.length} more body issues, from feature ${first.featureId} on, are not listed.` })];
    }
  };
}

/** The lineage of `features` read in `scope`, without kernel facts: keys, creators, modifiers and consumers, but no pieces. */
export function cadBodyLineage(features: readonly CadFeature[], scope: CadFeatureScope): CadBodyLineage {
  const lineage = createCadBodyLineage();
  for (const feature of features) lineage.apply(feature, scope);
  return lineage;
}

/**
 * The built body a selection leads to, by key: the body `selectedId` created, modified or passes on, when the build drew it; otherwise
 * the body most recently created or modified among those drawn. `builtIds` are the ids of the drawn bodies, as `CadMesh.featureId`
 * gives them. `except` leaves out one body, for a second operand.
 */
export function cadSelectedBody(lineage: CadBodyLineage, selectedId: string | null | undefined, builtIds: readonly string[], except?: CadBodyKey): CadBodyState | undefined {
  const drawn = (body: CadBodyState) => body.key !== except && builtIds.includes(cadBodyFeatureId(body));
  const selected = selectedId == null ? undefined : lineage.of(selectedId);
  if (selected && drawn(selected)) return selected;
  return lineage.bodies().filter(drawn).at(-1);
}

/** The bodies left after `features` in `scope`, as the ids of the features whose results they are, oldest current state first. */
export function cadVisibleBodyIds(features: readonly CadFeature[], scope: CadFeatureScope): readonly string[] {
  return cadBodyLineage(features, scope).bodies().map(cadBodyFeatureId);
}

/**
 * S8's stored reference to a body, for a feature's target, source or tool: its key, resolved against the bodies just before the
 * referring feature. A key with a piece or pattern occurrence names that part of a body. Not stored before S8's format cut; until then
 * a stored target holds the id of the feature whose result the body is, resolved with `CadBodyLineage.at`.
 */
export interface CadBodyRef { readonly kind: 'body'; readonly key: CadBodyKey }

/** How a body reference resolves, with the outcomes every reference shares. */
export type CadBodyRefResolution =
  | { readonly status: 'resolved'; readonly body: CadBodyState; readonly part?: CadBodyKey }
  | { readonly status: 'missing'; readonly consumedBy?: string }
  | { readonly status: 'ambiguous'; readonly body: CadBodyState; readonly candidates: readonly CadBodyKey[] };

/**
 * Resolves `ref` against `lineage` as it stands before the referring feature. A whole body's key resolves to it. A part's key resolves
 * among the pieces it names in some kernel order (`cadBodyKeyTwins`), with the pieces of any group those keys are in: to that part when it
 * names the same piece in every order and is in no group, otherwise as ambiguous among those pieces, or as missing when there are none.
 * So a lost piece, a split piece's old key, a part of an untracked body and a consumed body or one of its parts are missing.
 */
export function resolveCadBodyRef(ref: CadBodyRef, lineage: Pick<CadBodyLineage, 'get' | 'bodies' | 'consumed'>): CadBodyRefResolution {
  const whole = lineage.get(ref.key);
  if (whole) return { status: 'resolved', body: whole };
  for (const body of lineage.bodies()) {
    const candidates = namedPieces(body, ref.key);
    if (!candidates) continue;
    if (!candidates.length) return { status: 'missing' };
    if (candidates.length === 1 && candidates[0] === ref.key && !partsOf(body).groupOf.has(ref.key) && !unsettled(orderIndex(body.orders), ref.key))
      return { status: 'resolved', body, part: ref.key };
    return { status: 'ambiguous', body, candidates };
  }
  const gone = lineage.consumed().find(body => body.key === ref.key || cadBodyKeyTwins(body, ref.key).length);
  return gone?.consumedBy !== undefined ? { status: 'missing', consumedBy: gone.consumedBy } : { status: 'missing' };
}

/** What resolving a key reads of a body: its pieces, groups and orders. */
type CadBodyPartsView = Pick<CadBodyState, 'pieces' | 'ambiguous' | 'orders'>;

/**
 * The pieces of `body` that `key` names in some kernel order, with the pieces of any group those keys are in, in the body's order: none
 * when `key` led to the body's parts but names no piece now, and `undefined` when it never led to them.
 */
function namedPieces(body: CadBodyPartsView, key: CadBodyKey): readonly CadBodyKey[] | undefined {
  const twins = cadBodyKeyTwins(body, key);
  if (!twins.length) return undefined;
  const { pieces, groupOf } = partsOf(body), named = new Set<string>();
  for (const twin of twins) {
    if (pieces.has(twin)) named.add(twin);
    for (const part of groupOf.get(twin) ?? NONE) if (pieces.has(part)) named.add(part);
  }
  return body.pieces!.filter(piece => named.has(piece));
}

/**
 * Tells whether a piece or group key of `body` stands, as `namedPieces` reads them, for a piece that passes `test`: it is one, or its group
 * has one, looking through each group once.
 */
function passer(body: CadBodyPartsView, test: (piece: string) => boolean): (part: string) => boolean {
  const { pieces, groupOf } = partsOf(body), passing = new Map<readonly CadBodyKey[], boolean>();
  return part => {
    if (pieces.has(part) && test(part)) return true;
    const group = groupOf.get(part);
    if (!group) return false;
    let found = passing.get(group);
    if (found === undefined) passing.set(group, found = group.some(member => pieces.has(member) && test(member)));
    return found;
  };
}

/**
 * A body's pieces, the group each group key is in, and every key that is, or leads to, a piece or a group's key. Made once per list of
 * pieces and groups, so the state a feature leaves reuses what `cadBodyParts` made for it.
 */
interface PartsIndex { readonly pieces: ReadonlySet<string>; readonly groupOf: ReadonlyMap<string, readonly CadBodyKey[]>; readonly leads: ReadonlySet<string> }
const partsIndexes = new WeakMap<readonly CadBodyKey[], { readonly ambiguous: CadBodyState['ambiguous']; readonly index: PartsIndex }>();
const NO_PARTS: PartsIndex = { pieces: new Set(), groupOf: new Map(), leads: new Set() };
/** Adds to `leads` every key that is, or leads to, one of `parts`. */
function addLeads(leads: Set<string>, parts: Iterable<string>): Set<string> {
  for (const part of parts) for (let end = part.length; end > 0 && !leads.has(part.slice(0, end)); end = part.lastIndexOf('/', end - 1)) leads.add(part.slice(0, end));
  return leads;
}
function partsOf(body: CadBodyPartsView, leads?: ReadonlySet<string>): PartsIndex {
  if (!body.pieces) return NO_PARTS;
  const known = partsIndexes.get(body.pieces);
  if (known && known.ambiguous === body.ambiguous) return known.index;
  const groupOf = new Map<string, readonly CadBodyKey[]>();
  for (const group of body.ambiguous ?? []) for (const part of group) groupOf.set(part, group);
  const index = { pieces: new Set(body.pieces), groupOf, leads: leads ?? addLeads(new Set(), [...body.pieces, ...groupOf.keys()]) };
  partsIndexes.set(body.pieces, { ambiguous: body.ambiguous, index });
  return index;
}

/**
 * The pieces and group keys of `body` that name a solid `key` names in some kernel order, `key` among them when it is one. Kernel orders
 * decide only the indices of the splits `body.orders` records, and each order decides one split, whatever the others did, while every later
 * step follows its solid. So reading `key` from its first step, each split step may be the step itself or any sibling the split's order
 * may place at its index; every other step stays: a split whose pieces the faces ordered, a copy and an image. Keys `body` never had lead
 * nowhere, so the search keeps only keys that are, or lead to, a piece or a group's key.
 */
function cadBodyKeyTwins(body: CadBodyPartsView, key: CadBodyKey): readonly CadBodyKey[] {
  if (!body.pieces) return NONE;
  const { pieces, groupOf, leads } = partsOf(body), steps = key.split('/');
  if (!leads.has(steps[0])) return NONE;
  const index = orderIndex(body.orders);
  let twins = [steps[0]];
  for (const step of steps.slice(1)) {
    const next = new Set<string>(), split = /^split\((\d+)\)$/.exec(step), at = split ? Number(split[1]) : -1;
    for (const twin of twins) {
      if (leads.has(`${twin}/${step}`)) next.add(`${twin}/${step}`);
      if (!split) continue;
      for (const order of index.under.get(twin) ?? []) {
        const start = splitIndexOf(order.keys[0])!, places = placesOf(order);
        if (at < start || at >= start + order.keys.length) continue;
        order.keys.forEach((part, i) => { if (leads.has(part) && hasPlace(places[i], at - start)) next.add(part); });
      }
    }
    if (!next.size) return NONE;
    twins = [...next];
  }
  return twins.filter(twin => pieces.has(twin) || groupOf.has(twin)) as CadBodyKey[];
}

/** How far reading a key has got in a body: the keys it may name so far, as shared lists, which `key` numbers. */
interface KeyReading { readonly key: string; readonly lists: readonly (readonly string[])[]; keys?: readonly string[] }

/**
 * Reads keys against `body` a step at a time, as `cadBodyKeyTwins` does: each key reached passes on the key the step leads it to, or the
 * siblings its split's order may place at the step's index. Those come as lists found once, so two readings that reach the same lists have
 * the same `key` without listing their keys.
 */
function keyReader(body: CadBodyPartsView) {
  const { leads } = partsOf(body), index = orderIndex(body.orders);
  const numbers = new Map<readonly string[], number>(), singles = new Map<string, readonly string[]>(), placed = new Map<CadBodyOrder, Map<number, readonly string[]>>();
  const reading = (lists: readonly (readonly string[])[]): KeyReading => {
    const unique = [...new Set(lists)].filter(list => list.length);
    const ids = unique.map(list => { let n = numbers.get(list); if (n === undefined) numbers.set(list, n = numbers.size); return n; });
    return { key: ids.sort((a, b) => a - b).join(','), lists: unique };
  };
  const single = (part: string) => { let list = singles.get(part); if (!list) singles.set(part, list = [part]); return list; };
  const siblings = (order: CadBodyOrder, at: number) => {
    let byAt = placed.get(order);
    if (!byAt) placed.set(order, byAt = new Map());
    const slot = order.by ? at : -1;
    let list = byAt.get(slot);
    if (!list) { const places = placesOf(order); byAt.set(slot, list = order.keys.filter((part, i) => leads.has(part) && (slot < 0 || hasPlace(places[i], at)))); }
    return list;
  };
  const keysOf = (state: KeyReading) => state.keys ??= state.lists.length === 1 ? state.lists[0] : [...new Set(state.lists.flat())];
  return {
    rootReading: (root: string) => reading(leads.has(root) ? [single(root)] : []),
    readingKeys: keysOf,
    nextReading(state: KeyReading, step: string): KeyReading {
      const split = /^split\((\d+)\)$/.exec(step), at = split ? Number(split[1]) : -1, lists: (readonly string[])[] = [];
      for (const twin of keysOf(state)) {
        const next = `${twin}/${step}`;
        let listed = false;
        if (split) for (const order of index.under.get(twin) ?? []) {
          const start = splitIndexOf(order.keys[0])!;
          if (at < start || at >= start + order.keys.length) continue;
          lists.push(siblings(order, at - start));
          if (order.keys[at - start] === next) listed = true;
        }
        if (!listed && leads.has(next)) lists.push(single(next));
      }
      return reading(lists);
    }
  };
}

/**
 * The keys that named one of `parts` of `previous` in some kernel order and name no piece of `after` in any, none naming a piece before
 * that `continued` holds, digits by value; `key-limit` past `MAX_CAD_BODY_LIST` of them, for one part or in all, or `search-limit` past
 * `MAX_CAD_BODY_ORDER_WORK` steps of reading. A part's keys are read a step at a time, before and after together: a split step one of `previous`'s orders numbers may be any
 * index that order may place the part at, and every other step stays. Keys whose readings reach the same lists at a step are lost or not
 * alike whatever follows, so each pair of readings is followed once, and the work grows with the keys lost, not with every key naming a part.
 */
function lostKeys(previous: CadBodyPartsView, after: CadBodyPartsView, parts: readonly CadBodyKey[], continued: ReadonlySet<string>): CadBodyKey[] | 'key-limit' | 'search-limit' {
  if (!parts.length) return [];
  const before = keyReader(previous), now = keyReader(after), index = orderIndex(previous.orders);
  const namedBefore = passer(previous, () => true), continues = passer(previous, piece => continued.has(piece)), namedNow = passer(after, () => true);
  const indices = new Map<Places, readonly string[]>(), numbers = new Map<Places, number>(), read = new Set<string>(), lost = new Set<CadBodyKey>();
  let work = 0, stopped: 'key-limit' | 'search-limit' = 'search-limit';
  for (const part of parts) {
    // What each step of a key naming the part may be, and those choices as text, the same for parts named by the same keys' steps.
    const steps = part.split('/'), choices: (readonly string[])[] = [];
    let prefix = steps[0], signature = steps[0];
    for (const step of steps.slice(1)) {
      prefix += `/${step}`;
      const found = index.at.get(prefix);
      if (!found) { choices.push([step]); signature += `/${step}`; continue; }
      const [order, i] = found, places = placesOf(order)[i];
      let list = indices.get(places);
      if (!list) {
        const start = splitIndexOf(order.keys[0])!, made: string[] = [];
        for (let at = 0; at < order.keys.length; at++) if (hasPlace(places, at)) made.push(`split(${start + at})`);
        indices.set(places, list = made);
        numbers.set(places, numbers.size);
      }
      choices.push(list);
      signature += `/#${numbers.get(places)}`;
    }
    if (read.has(signature)) continue;
    read.add(signature);
    // The ends of the lost keys from each step on, for the readings reached there.
    const known = new Map<string, readonly string[] | undefined>();
    const follow = (at: number, nowRead: KeyReading, beforeRead: KeyReading): readonly string[] | undefined => {
      const key = `${at} ${nowRead.key} ${beforeRead.key}`;
      if (known.has(key)) return known.get(key);
      let ends: readonly string[] | undefined;
      if (at === choices.length) {
        const was = before.readingKeys(beforeRead);
        ends = !now.readingKeys(nowRead).some(namedNow) && !was.some(continues) && was.some(namedBefore) ? [''] : NONE;
      } else {
        const found: string[] = [];
        for (const choice of choices[at]) {
          work += now.readingKeys(nowRead).length + before.readingKeys(beforeRead).length + 1;
          if (work > MAX_CAD_BODY_ORDER_WORK) { stopped = 'search-limit'; return undefined; }
          const rest = follow(at + 1, now.nextReading(nowRead, choice), before.nextReading(beforeRead, choice));
          if (!rest) return undefined;
          for (const end of rest) found.push(`/${choice}${end}`);
          if (found.length > MAX_CAD_BODY_LIST) { stopped = 'key-limit'; return undefined; }
        }
        ends = found;
      }
      known.set(key, ends);
      return ends;
    };
    const ends = follow(0, now.rootReading(steps[0]), before.rootReading(steps[0]));
    if (!ends) return stopped;
    for (const end of ends) if (steps[0].length + end.length <= MAX_CAD_BODY_KEY_LENGTH) lost.add(`${steps[0]}${end}` as CadBodyKey);
    if (lost.size > MAX_CAD_BODY_LIST) return 'key-limit';
  }
  return [...lost].sort(compareCadBodyKeys);
}

/** Orders keys whatever order they were found in: character by character, runs of digits by their value, and a key before those it leads to. */
function compareCadBodyKeys(a: string, b: string): number {
  const digit = (code: number) => code >= 48 && code <= 57;
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const x = a.charCodeAt(i), y = b.charCodeAt(j);
    if (digit(x) && digit(y)) {
      let to = i, end = j;
      while (to < a.length && digit(a.charCodeAt(to))) to++;
      while (end < b.length && digit(b.charCodeAt(end))) end++;
      if (to - i !== end - j) return to - i - (end - j);
      for (; i < to; i++, j++) if (a.charCodeAt(i) !== b.charCodeAt(j)) return a.charCodeAt(i) - b.charCodeAt(j);
    } else if (x !== y) return x - y;
    else { i++; j++; }
  }
  return a.length - i - (b.length - j);
}

/** What a body is for in a setup: the part made, the stock it is cut from, a fixture holding it, or reference geometry. */
export type CadBodyRole = 'part' | 'stock' | 'fixture' | 'reference';
/** How a body is drawn: an sRGB colour as `#rrggbb`. */
export interface CadBodyAppearance { readonly color: string }
/**
 * What S8 stores for a body, keyed by its key: a name, a role, and optionally an appearance and a material name. Display only:
 * metadata never changes geometry, and an entry whose body is gone is a harmless orphan.
 */
export interface CadBodyMetadata {
  readonly name: string;
  readonly role: CadBodyRole;
  readonly appearance?: CadBodyAppearance;
  readonly material?: string;
}

/**
 * A body's metadata: what `stored` holds for its key, or the defaults until S8 stores any, its creating feature's name and the `part`
 * role. `stored` is S8's record; F0 passes none.
 */
export function resolveCadBodyMetadata(body: CadBodyState, featureName: (featureId: string) => string | undefined,
  stored?: ReadonlyMap<CadBodyKey, CadBodyMetadata>): CadBodyMetadata {
  return stored?.get(body.key) ?? { name: featureName(body.createdBy) ?? body.key, role: 'part' };
}

/** The keys in S8's stored metadata that name no current or consumed body, which display ignores. */
export function cadBodyMetadataOrphans(stored: ReadonlyMap<CadBodyKey, CadBodyMetadata>, lineage: CadBodyLineage): readonly CadBodyKey[] {
  const known = new Set<CadBodyKey>([...lineage.bodies(), ...lineage.consumed()].map(body => body.key));
  return [...stored.keys()].filter(key => !known.has(key));
}
