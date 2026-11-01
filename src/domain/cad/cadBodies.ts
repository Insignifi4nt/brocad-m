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
   * Groups of keys that no build ties to one solid each with certainty. Each key in a group may be any of the group's pieces: pieces the
   * kernel might list in another order, pieces a solid keeping no face might have split from, their descendants through each source,
   * and earlier pieces of the body that can't be found among its solids. A reference to one resolves as ambiguous, with its group's
   * pieces as candidates. No key is in two groups.
   */
  readonly ambiguous?: readonly (readonly CadBodyKey[])[];
  /**
   * Sets of sibling keys that one split gave in an order the kernel decided: pieces tied by rank, or ordered by faces of different solids
   * or by none. These are the only steps where another kernel order would have given a solid another key, since every later step follows
   * its solid. Each set has two or more keys with one parent, each ending in a `split` step. A set is kept while one of its keys is, or
   * leads to, a piece, a group's key or a key of another kept set.
   */
  readonly interchangeable?: readonly (readonly CadBodyKey[])[];
  /** The body has more parts than the lineage tracks, so it keeps none, and references to its parts resolve as missing. */
  readonly untracked?: true;
}

/**
 * The most distinct part keys a body tracks: its pieces, the keys its groups keep and the keys its interchangeable sets keep, together.
 * Past it the body's parts are untracked from then on, never a rejected build. A group keeps every former member's key while a solid
 * descends from it, so each feature that splits or removes an ambiguous piece adds keys, however few solids are left.
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
  if (body.untracked !== undefined) return body.untracked === true && body.pieces === undefined && body.ambiguous === undefined && body.interchangeable === undefined;
  let makers: ReadonlySet<string> | undefined;
  const made = () => makers ??= new Set([body.createdBy as string, ...modifiedBy as string[]]);
  const pieces = new Set<string>();
  if (body.pieces !== undefined && !isPartKeys(body.pieces, key, made, pieces)) return false;
  // Pieces and the keys groups and sets keep count against the list limit together.
  const all = new Set(pieces);
  const lists = (value: unknown, fits: (list: readonly string[]) => boolean) => {
    if (value === undefined) return true;
    if (!Array.isArray(value) || value.length > MAX_CAD_BODY_LIST) return false;
    const seen = new Set<string>();
    for (const list of value) {
      if (!Array.isArray(list) || !list.length || !isPartKeys(list, key, made, seen) || !fits(list)) return false;
      for (const part of list) all.add(part);
      if (all.size > MAX_CAD_BODY_LIST) return false;
    }
    return true;
  };
  const parent = (part: string) => part.slice(0, part.lastIndexOf('/'));
  return lists(body.ambiguous, () => true)
    && lists(body.interchangeable, set => set.length > 1 && set.every(part => parent(part) === parent(set[0]) && part.startsWith('split(', part.lastIndexOf('/') + 1)));
}

const BODY_ISSUE_CODES: ReadonlySet<unknown> = new Set<CadBodyIssue['code']>(['ambiguous-body-parts', 'lost-body-parts', 'untracked-body-parts', 'more-body-issues']);

/** Checks a body issue received across the worker boundary. */
export function isCadBodyIssue(value: unknown): value is CadBodyIssue {
  if (typeof value !== 'object' || value === null) return false;
  const issue = value as Readonly<Record<string, unknown>>, pieces = issue.pieces;
  if (!BODY_ISSUE_CODES.has(issue.code) || !isFeatureId(issue.featureId) || !isCadBodyKey(issue.body)) return false;
  if (!Array.isArray(pieces) || pieces.length > MAX_CAD_BODY_LIST) return false;
  for (const piece of pieces) if (!isCadBodyKey(piece)) return false;
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
 * - `lost-body-parts`: `featureId` removed `pieces` of `body`, or merged them into another solid. References to them resolve as missing.
 * - `untracked-body-parts`: after `featureId`, `body` has more parts than the lineage tracks, so it keeps none from then on.
 * - `more-body-issues`: the issues from `featureId` on did not fit in the list; the message gives how many were left out.
 */
export interface CadBodyIssue {
  readonly code: 'ambiguous-body-parts' | 'lost-body-parts' | 'untracked-body-parts' | 'more-body-issues';
  readonly featureId: string;
  readonly body: CadBodyKey;
  readonly pieces: readonly CadBodyKey[];
  readonly message: string;
}

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
  readonly interchangeable?: readonly (readonly CadBodyKey[])[];
  readonly untracked?: true;
  /**
   * Keys the feature itself left ambiguous, for a new `ambiguous-body-parts` issue: none was ambiguous before it or descends from a key
   * that was.
   */
  readonly ambiguousNow: readonly CadBodyKey[];
  /** Keys that are ambiguous because they descend from a key that was ambiguous before the feature, each with that key, whose issue lists them too. */
  readonly inherited: readonly (readonly [CadBodyKey, CadBodyKey])[];
  /** Keys of the body before the feature that it removed or merged into another solid, for a `lost-body-parts` issue. */
  readonly lost: readonly CadBodyKey[];
  /** The feature gave the body more parts than the lineage tracks, for an `untracked-body-parts` issue. */
  readonly overflowed?: true;
}

const NONE: readonly CadBodyKey[] = freeze([]);
const NO_PAIRS: readonly (readonly [CadBodyKey, CadBodyKey])[] = freeze([]);
const WHOLE: CadBodyParts = freeze({ ambiguousNow: NONE, inherited: NO_PAIRS, lost: NONE });
const UNTRACKED: CadBodyParts = freeze({ untracked: true as const, ambiguousNow: NONE, inherited: NO_PAIRS, lost: NONE });
const OVERFLOWED: CadBodyParts = freeze({ untracked: true as const, ambiguousNow: NONE, inherited: NO_PAIRS, lost: NONE, overflowed: true as const });
/** What every tool solid passes on: never a key, since a key is never empty. Solids of a fused tool alone get fresh keys. */
const TOOL = '' as CadBodyKey;
/** The `from` of a solid that keeps no face. */
const NO_FACE = -2;

/** The faces of one source that a solid of the result keeps for one key: the lowest rank, and the source solid they lie in, -1 for several. */
interface Lead { rank: number; readonly source: number; solid: number }
/**
 * A solid of the result in an ordered list: those continuing one key, the tool's, the merges, or those keeping no face. `rank` orders the
 * list, by the lowest face the solid keeps, which lies in solid `from` of source `source`: -1 when it decides by several of that source's
 * solids, `NO_FACE` when it keeps none.
 */
interface Placed { readonly solid: number; readonly rank: number; readonly source: number; readonly from: number }
/** A key before a feature that a solid of its result keeps faces of, and the source they came through. */
interface Descent { readonly origin: CadBodyKey; readonly via: number }

/**
 * The entries of an ordered list whose order the kernel decides: ranks order solids only when the faces they decide by lie in the same
 * solid of a source, since faces of different solids rank in the order the kernel lists those solids, and solids keeping no face come in
 * the kernel's order. So each source's entries form a group unless they all decide by one solid, and then entries of equal rank, which the
 * kernel's order breaks, still do.
 */
function unsettled(list: readonly Placed[]): readonly (readonly Placed[])[] {
  const group = (entries: readonly Placed[], by: (entry: Placed) => number) => {
    const groups = new Map<number, Placed[]>();
    for (const entry of entries) { const same = groups.get(by(entry)); if (same) same.push(entry); else groups.set(by(entry), [entry]); }
    return [...groups.values()].filter(same => same.length > 1);
  };
  return group(list, entry => entry.source).flatMap(same => same.every(entry => entry.from >= 0 && entry.from === same[0].from)
    ? group(same, entry => entry.rank) : [same]);
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
 * Ranks order only solids whose first faces lie in the same solid of a source and differ: solids ordered by faces of different solids of
 * one source, as a whole body's several solids are, by equal ranks or by the kernel's order are ambiguous when there are two or more of
 * them, never ordered by where they lie. A piece no solid continues or merges is lost, unless pieces can't be identified.
 *
 * Ambiguity carries in groups: the keys that descend from one group through one source form a group, so the copies of one pattern
 * occurrence are never confused with another's. A group's earlier pieces that no solid continues stay in it, as keys that can't be found,
 * while any solid descends from the group through the target, and are lost once none does. So do earlier pieces continued under other
 * keys, split or copied, since the kernel's order picked which member's key each solid continued.
 */
export function cadBodyParts(input: {
  readonly featureId: string;
  readonly previous: Pick<CadBodyState, 'key' | 'pieces' | 'ambiguous' | 'interchangeable' | 'untracked'>;
  readonly beforeSolids: number | undefined;
  readonly facts: CadBodyKernelFacts;
}): CadBodyParts {
  const { featureId, previous, facts } = input, key = previous.key, count = facts.solids, before = previous.pieces;
  if (previous.untracked) return UNTRACKED;
  if (before && facts.sameSolidOrder && before.length === count) return freeze({ pieces: before, ...(previous.ambiguous ? { ambiguous: previous.ambiguous } : {}),
    ...(previous.interchangeable ? { interchangeable: previous.interchangeable } : {}), ambiguousNow: NONE, inherited: NO_PAIRS, lost: NONE });
  const patterned = facts.sources.some(source => source.kind === 'copy'), fused = facts.sources.some(source => source.kind === 'tool');
  const beforeSolids = input.beforeSolids ?? 1;
  if (!before && (count <= 1 || fused && !patterned || !patterned && !facts.removesMaterial && count <= beforeSolids)) return WHOLE;
  if (count > MAX_CAD_BODY_LIST) return OVERFLOWED;
  const traced = facts.provenance();
  if (traced.length !== count) throw new Error('Each solid of the result needs its sources.');
  if (!before && (patterned ? traced.every(sources => sources.some(entry => entry.source === 0)) : !splits(traced, count, beforeSolids))) return WHOLE;

  // The key each source solid passes on, and for a target solid or a copy the piece before it came from.
  const previousKey = (solid: number) => {
    const found = before ? before[solid] : key;
    if (found === undefined) throw new Error('A source solid the body did not have.');
    return found;
  };
  const targetFrom = new Map<CadBodyKey, CadBodyKey>();
  const continued = new Map<CadBodyKey, Placed[]>(), merged: Placed[] = [], orphans: number[] = [];
  const continuedFrom = new Set<CadBodyKey>(), mergedFrom = new Set<CadBodyKey>(), descends: (readonly Descent[])[] = [];
  const note = (into: Map<CadBodyKey, Lead>, passed: CadBodyKey, rank: number, source: number, solid: number) => {
    const lead = into.get(passed);
    if (!lead) into.set(passed, { rank, source, solid });
    else { if (rank < lead.rank) lead.rank = rank; if (lead.solid !== solid) lead.solid = -1; }
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
      if (source.kind === 'copy') { note(added, cadBodyKeyWith(origin, { kind: 'inst', i: source.i, j: source.j }), rank, entry.source, entry.solid); continue; }
      const passed = patterned ? cadBodyKeyWith(origin, { kind: 'inst', i: 0, j: 0 }) : origin;
      targetFrom.set(passed, origin);
      note(targets, passed, rank, entry.source, entry.solid);
    }
    descends[solid] = from;
    const placed = (lead: Lead): Placed => ({ solid, rank: lead.rank, source: lead.source, from: lead.solid });
    if (targets.size === 1) {
      const [[passed, lead]] = targets;
      push(passed, placed(lead)); continuedFrom.add(targetFrom.get(passed)!);
    } else if (targets.size === 0 && added.size === 1) {
      const [[passed, lead]] = added;
      push(passed, placed(lead));
    } else if (targets.size || added.size) {
      const leads = [...targets.values(), ...added.values()];
      let first = leads[0];
      for (const lead of leads) if (lead.rank < first.rank) first = lead;
      // Which of a merge's keys gives its first face depends on the kernel's order when two of them come through the same source.
      merged.push({ ...placed(first), from: leads.some(lead => lead !== first && lead.source === first.source) ? -1 : first.solid });
      for (const passed of targets.keys()) mergedFrom.add(targetFrom.get(passed)!);
    } else orphans.push(solid);
  });

  // A solid keeping no face descends from the target's one key when nothing else could have made it.
  if (orphans.length && !patterned && !fused && (!before || before.length === 1)) {
    const origin = before ? before[0] : key;
    for (const solid of orphans) { push(origin, { solid, rank: Infinity, source: -1, from: NO_FACE }); descends[solid] = [{ origin, via: 0 }]; }
    continuedFrom.add(origin);
    orphans.length = 0;
  }
  const pieces = new Array<CadBodyKey>(count), unordered: (readonly Placed[])[] = [], unchanged: number[] = [];
  const byRank = (a: Placed, b: Placed) => a.rank - b.rank || a.solid - b.solid;
  for (const [passed, list] of continued) {
    if (passed === TOOL) continue;
    list.sort(byRank);
    if (list.length === 1 && passed !== key) { pieces[list[0].solid] = passed; unchanged.push(list[0].solid); }
    else list.forEach((entry, q) => { pieces[entry.solid] = withSplit(passed, q); });
    unordered.push(...unsettled(list));
  }
  const tools = (continued.get(TOOL) ?? []).sort(byRank), left = orphans.map(solid => ({ solid, rank: Infinity, source: -1, from: NO_FACE }));
  merged.sort(byRank);
  unordered.push(...unsettled(tools), ...unsettled(merged), ...unsettled(left));
  [...tools, ...merged, ...left].forEach((entry, k) => { pieces[entry.solid] = cadBodyKey(featureId, [{ kind: 'split', k }]); });

  // Keys that must share a group: those whose order the kernel decides, and below, those a solid keeping no face leaves uncertain and the
  // descendants of each earlier group through each source.
  const sets: (readonly CadBodyKey[])[] = unordered.map(list => list.map(entry => pieces[entry.solid]));
  // Those are siblings under one parent each, and the body's new interchangeable sets.
  const swapped = sets.map(set => freeze(set));
  const groupOf = new Map<CadBodyKey, number>();
  previous.ambiguous?.forEach((group, g) => { for (const earlier of group) groupOf.set(earlier, g); });
  // Keys before that no solid continues: unidentified when a solid keeping no face could be one of them, whatever group they were in;
  // otherwise lost when merged or removed, or, for keys of an earlier group, left to their group below.
  const lost: CadBodyKey[] = [], unidentified = new Set<CadBodyKey>();
  for (const piece of before ?? []) {
    if (continuedFrom.has(piece)) continue;
    if (orphans.length && !mergedFrom.has(piece)) unidentified.add(piece); else if (!groupOf.has(piece)) lost.push(piece);
  }
  if (orphans.length) for (const [earlier] of groupOf) if (!continuedFrom.has(earlier) && !mergedFrom.has(earlier)) unidentified.add(earlier);
  if (orphans.length) {
    // A key continued unchanged by one solid may also have split into a solid keeping no face, which would then have made it key/split(q).
    const uncertain = [...left.map(entry => pieces[entry.solid]), ...unchanged.map(solid => pieces[solid]), ...unidentified];
    if (uncertain.length > 1) sets.push(uncertain);
  }
  const descent = new Map<string, CadBodyKey[]>(), inherited: (readonly [CadBodyKey, CadBodyKey])[] = [];
  pieces.forEach((piece, solid) => {
    for (const { origin, via } of descends[solid]) {
      const g = groupOf.get(origin);
      if (g === undefined) continue;
      const id = `${g} ${via}`, group = descent.get(id);
      if (!group) descent.set(id, [piece]); else if (group[group.length - 1] !== piece) group.push(piece);
      if (!groupOf.has(piece)) inherited.push([piece, origin]);
    }
  });
  const now = new Set(pieces);
  previous.ambiguous?.forEach((group, g) => {
    const home = descent.get(`${g} 0`);
    for (const earlier of group) {
      // Which member's key each solid continued follows the kernel's order, so a member's key that is no longer a piece, whether its solid
      // split, was copied or went, may name any solid descending from the group in another order: it stays while one does.
      if (now.has(earlier)) continue;
      if (home) home.push(earlier); else if (!unidentified.has(earlier)) lost.push(earlier);
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
  // An earlier interchangeable set stays while one of its keys is, or leads to, a piece, a group's key or a key of another set that stays.
  const leads = new Set<string>(), stays = new Set<readonly CadBodyKey[]>();
  const reach = (part: string) => { for (let end = part.length; end > 0 && !leads.has(part.slice(0, end)); end = part.lastIndexOf('/', end - 1)) leads.add(part.slice(0, end)); };
  for (const part of [...pieces, ...parent.keys(), ...swapped.flat()]) reach(part);
  for (let more = true; more;) {
    more = false;
    for (const set of previous.interchangeable ?? []) if (!stays.has(set) && set.some(part => leads.has(part))) { stays.add(set); set.forEach(reach); more = true; }
  }
  const interchangeable = [...(previous.interchangeable ?? []).filter(set => stays.has(set)), ...swapped];
  const all = new Set<CadBodyKey>([...pieces, ...parent.keys(), ...interchangeable.flat()]);
  if (all.size > MAX_CAD_BODY_LIST || pieces.some(piece => piece.length > MAX_CAD_BODY_KEY_LENGTH)) return OVERFLOWED;
  const groups = new Map<CadBodyKey, CadBodyKey[]>();
  for (const part of parent.keys()) { const top = root(part), group = groups.get(top); if (group) group.push(part); else groups.set(top, [part]); }
  const descended = new Set(inherited.map(([piece]) => piece));
  const ambiguousNow = [...parent.keys()].filter(part => !groupOf.has(part) && !descended.has(part));
  const ambiguous = [...groups.values()].map(group => freeze(group));
  return freeze({ pieces: freeze(pieces), ...(ambiguous.length ? { ambiguous: freeze(ambiguous) } : {}),
    ...(interchangeable.length ? { interchangeable: freeze(interchangeable) } : {}), ambiguousNow: freeze(ambiguousNow), inherited: freeze(inherited), lost: freeze(lost) });
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
  readonly interchangeable?: readonly (readonly CadBodyKey[])[];
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
    ...(body.interchangeable?.length && !body.untracked ? { interchangeable: body.interchangeable } : {})
  });
}

/** An issue as the lineage records it: an ambiguity's keys grow as later features extend it. */
interface Recorded {
  readonly about: Pick<CadBodyIssue, 'code' | 'featureId' | 'body'>;
  readonly pieces: CadBodyKey[];
  readonly listed: Set<CadBodyKey>;
  /** Fixed for every code but `ambiguous-body-parts`, whose message counts its keys. */
  readonly message?: string;
}

/** `n` pieces, in words. */
function piecesOf(n: number): string { return n === 1 ? '1 piece' : `${n} pieces`; }

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

  function record(code: CadBodyIssue['code'], featureId: string, body: CadBodyKey, pieces: readonly CadBodyKey[], message?: string): Recorded {
    const issue: Recorded = { about: { code, featureId, body }, pieces: [...pieces], listed: new Set(pieces), ...(message !== undefined ? { message } : {}) };
    issues.push(issue);
    return issue;
  }

  function report(featureId: string, body: CadBodyKey, parts: CadBodyParts) {
    if (parts.overflowed) record('untracked-body-parts', featureId, body, NONE, `Body ${body} has more parts than are tracked after ${featureId}, so references to its parts resolve as missing.`);
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
        ...(from?.interchangeable && !from.untracked ? { interchangeable: from.interchangeable } : {}),
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
 * Resolves `ref` against `lineage` as it stands before the referring feature. A whole body's key resolves to it, and a piece's to that
 * part. An ambiguous key resolves as ambiguous, with the pieces of its group as candidates, or as missing once none is left. So does a
 * key no body lists that other kernel orders would have given a solid, among the groups of its twins (`twinGroups`). Anything else is
 * missing: a lost piece, a split piece's old key, a part of an untracked body, or a consumed body or one of its parts.
 */
export function resolveCadBodyRef(ref: CadBodyRef, lineage: Pick<CadBodyLineage, 'get' | 'bodies' | 'consumed'>): CadBodyRefResolution {
  const whole = lineage.get(ref.key);
  if (whole) return { status: 'resolved', body: whole };
  const bodies = lineage.bodies(), among = (body: CadBodyState, groups: readonly (readonly CadBodyKey[])[]): CadBodyRefResolution | undefined => {
    const pieces = new Set(body.pieces), candidates = groups.flat().filter(part => pieces.has(part));
    return candidates.length ? { status: 'ambiguous', body, candidates } : undefined;
  };
  for (const body of bodies) {
    const group = body.ambiguous?.find(keys => keys.includes(ref.key)), ambiguous = group && among(body, [group]);
    if (ambiguous) return ambiguous;
    if (body.pieces?.includes(ref.key)) return { status: 'resolved', body, part: ref.key };
  }
  for (const body of bodies) {
    const groups = twinGroups(body, ref.key), ambiguous = groups && among(body, groups);
    if (ambiguous) return ambiguous;
  }
  const gone = lineage.consumed().find(body => body.key === ref.key || body.pieces?.includes(ref.key) || body.ambiguous?.some(group => group.includes(ref.key))
    || twinGroups(body, ref.key));
  return gone?.consumedBy !== undefined ? { status: 'missing', consumedBy: gone.consumedBy } : { status: 'missing' };
}

/**
 * The groups of the keys `body` lists in the place of `key`, which it does not list, in the order `body` lists its groups. Its twins are
 * the keys other kernel orders would have given its solid: kernel orders decide only which sibling of an interchangeable set names which
 * solid, and every later step follows its solid, so a twin is `key` with any of its steps, read from the first, changed to a sibling in
 * that step's interchangeable set. Steps no set holds stay, whatever groups their keys are in: a split whose pieces the faces ordered,
 * a copy and an image. Twins `body` never had lead nowhere, so the search keeps only keys that are, or lead to, a key it keeps.
 */
function twinGroups(body: CadBodyState, key: CadBodyKey): readonly (readonly CadBodyKey[])[] | undefined {
  if (!body.ambiguous || !body.interchangeable) return undefined;
  const groupOf = new Map<string, readonly CadBodyKey[]>(), setOf = new Map<string, readonly CadBodyKey[]>(), leads = new Set<string>();
  for (const group of body.ambiguous) for (const part of group) groupOf.set(part, group);
  for (const set of body.interchangeable) for (const part of set) setOf.set(part, set);
  for (const part of [...groupOf.keys(), ...setOf.keys()])
    for (let end = part.length; end > 0 && !leads.has(part.slice(0, end)); end = part.lastIndexOf('/', end - 1)) leads.add(part.slice(0, end));
  const steps = key.split('/');
  let twins = [steps[0]];
  for (const step of steps.slice(1)) {
    const next = new Set<string>();
    for (const twin of twins) for (const part of setOf.get(`${twin}/${step}`) ?? [`${twin}/${step}`]) if (leads.has(part)) next.add(part);
    if (!next.size) return undefined;
    twins = [...next];
  }
  const groups = new Set<readonly CadBodyKey[]>();
  for (const twin of twins) { const group = groupOf.get(twin); if (group) groups.add(group); }
  return groups.size ? body.ambiguous.filter(group => groups.has(group)) : undefined;
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
