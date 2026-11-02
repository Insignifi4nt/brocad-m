import { describe, expect, it, vi } from 'vitest';
import type { CadDocument, CadFeature } from '../cadDocument';
import { createCadDocument, parseCadDocument } from '../cadSchema';
import {
  cadBodyKey, cadBodyLineage, cadBodyMetadataOrphans, cadBodyOrderPlaces, cadBodyParts, cadSelectedBody, cadVisibleBodyIds, createCadBodyLineage, isCadBodyIssue, isCadBodyKey,
  isCadBodyState, MAX_CAD_BODY_ISSUES, MAX_CAD_BODY_KEY_LENGTH, MAX_CAD_BODY_LIST, parseCadBodyKey, resolveCadBodyMetadata, resolveCadBodyRef,
  type CadBodyKernelFacts, type CadBodyKey, type CadBodyOrder, type CadBodySource, type CadBodyState
} from '../cadBodies';

const base = (id: string, suppressed = false) => ({ id, name: `${id} feature`, suppressed });
const sketch = (id: string, x = 0, width = 40): CadFeature => ({ ...base(id), kind: 'sketch', plane: 'XY', offset: 0,
  profiles: [{ id: `${id}_profile`, name: 'Profile', construction: false, geometry: { kind: 'rectangle', x, y: 0, width, height: 20, cornerRadius: 0 } }] });
const pad = (id: string, sketchId: string, operation: 'new' | 'join' | 'cut' = 'new', targetId: string | null = null, suppressed = false): CadFeature =>
  ({ ...base(id, suppressed), kind: 'extrude', sketchId, distance: 10, symmetric: false, operation, targetId });
const box = [sketch('box_sketch'), pad('box', 'box_sketch')];
const peg = [sketch('peg_sketch', 60, 10), pad('peg', 'peg_sketch')];
const document = (features: readonly CadFeature[]): CadDocument => parseCadDocument({ ...createCadDocument('Bodies'), features });
const lineageOf = (features: readonly CadFeature[]) => { const parsed = document(features); return cadBodyLineage(parsed.features, parsed); };
const key = (text: string) => text as CadBodyKey;
const summary = (body: CadBodyState | undefined) => body && { key: body.key, createdBy: body.createdBy, modifiedBy: body.modifiedBy, consumedBy: body.consumedBy };

describe('body keys', () => {
  it('writes and reads the creating feature and its occurrences', () => {
    expect(cadBodyKey('pad')).toBe('pad');
    expect(cadBodyKey('flip', [{ kind: 'mirror' }])).toBe('flip/mirror');
    const nested = cadBodyKey('pad', [{ kind: 'inst', i: 2, j: 0 }, { kind: 'split', k: 1 }]);
    expect(nested).toBe('pad/inst(2,0)/split(1)');
    expect(parseCadBodyKey(nested)).toEqual({ featureId: 'pad', occurrences: [{ kind: 'inst', i: 2, j: 0 }, { kind: 'split', k: 1 }] });
    expect(isCadBodyKey('flip/mirror')).toBe(true);
  });

  it.each(['', '-pad', 'pad/', 'pad//mirror', 'pad/split(01)', 'pad/inst(1)', 'pad/split(-1)', 'pad/Mirror', 'pad/split(1) ', 'pad/mirror\n', 'pad/mirrorsplit(1)',
    'a'.repeat(97)])('refuses %j', text => {
    expect(parseCadBodyKey(text)).toBeUndefined();
    expect(isCadBodyKey(text)).toBe(false);
  });

  it('checks a key in one pass exactly as it parses it', () => {
    for (const text of ['pad', 'a'.repeat(96), 'flip/mirror', 'pad/inst(999999,0)/split(12)/mirror', 'pad/split(0)/split(1)', 'pad/inst(1000000,0)', 'pad/split(1)x'])
      expect(isCadBodyKey(text), text).toBe(parseCadBodyKey(text) !== undefined);
  });

  it('refuses text longer than the key limit and values that are not text', () => {
    const long = `pad${'/mirror'.repeat(MAX_CAD_BODY_KEY_LENGTH / 7)}`;
    expect(parseCadBodyKey(long)).toBeUndefined();
    expect(isCadBodyKey(long)).toBe(false);
    expect(parseCadBodyKey(7)).toBeUndefined();
    expect(isCadBodyKey(7)).toBe(false);
  });
});

describe('body lineage', () => {
  it('keeps a body key through fillet, chamfer, shell, transform, pocket and cut', () => {
    const features: CadFeature[] = [...box,
      { ...base('round'), kind: 'fillet', targetId: 'box', radius: 1 },
      { ...base('bevel'), kind: 'chamfer', targetId: 'round', radius: 0.5 },
      { ...base('hollow'), kind: 'shell', targetId: 'bevel', thickness: 1, opening: { kind: 'faces', expectedCount: 1, predicates: [{ kind: 'plane', normal: [0, 0, 1], offset: 10 }] } },
      { ...base('move'), kind: 'transform', sourceId: 'hollow', translation: [5, 0, 0], rotation: [0, 0, 0] },
      sketch('hole_sketch', 10, 4), { ...base('hole'), kind: 'pocket', sketchId: 'hole_sketch', targetId: 'move', extent: { kind: 'through-all', direction: 'both' } },
      sketch('slot_sketch', 20, 2), pad('slot', 'slot_sketch', 'cut', 'hole')];
    const parsed = document(features), lineage = createCadBodyLineage();
    for (const feature of parsed.features) {
      const planned = lineage.keyFor(feature, parsed);
      const change = lineage.apply(feature, parsed);
      expect(change?.state.key).toBe(planned);
      if (change && feature.id !== 'box') expect(change.kept, feature.id).toBe(true);
    }
    expect(lineage.bodies().map(summary)).toEqual([{ key: 'box', createdBy: 'box', modifiedBy: ['round', 'bevel', 'hollow', 'move', 'hole', 'slot'], consumedBy: undefined }]);
    expect(lineage.at('slot')?.key).toBe('box');
    expect(lineage.at('box')).toBeUndefined();
    for (const id of ['box', 'round', 'bevel', 'hollow', 'move', 'hole', 'slot']) expect(lineage.of(id)?.key, id).toBe('box');
    expect(lineage.of('box_sketch')).toBeUndefined();
  });

  it('keeps the target of a boolean and consumes its tool', () => {
    for (const operation of ['union', 'cut', 'intersect'] as const) {
      const lineage = lineageOf([...box, ...peg, { ...base('merge'), kind: 'boolean', targetId: 'box', toolId: 'peg', operation }]);
      expect(lineage.bodies().map(summary)).toEqual([{ key: 'box', createdBy: 'box', modifiedBy: ['merge'], consumedBy: undefined }]);
      expect(lineage.consumed().map(summary)).toEqual([{ key: 'peg', createdBy: 'peg', modifiedBy: [], consumedBy: 'merge' }]);
      expect(lineage.get(key('peg'))).toBeUndefined();
      expect(lineage.of('peg')).toBeUndefined();
      expect(lineage.of('merge')?.key).toBe('box');
    }
  });

  it('keeps the source key through a pattern, whose copies only the kernel can tell apart', () => {
    const row = lineageOf([...box, { ...base('row'), kind: 'linear-pattern', sourceId: 'box', count: 3, spacing: [50, 0, 0] }]).at('row');
    expect(row).toMatchObject({ key: 'box', modifiedBy: ['row'] });
    expect(row?.pieces).toBeUndefined();
    const ring = lineageOf([...box, { ...base('ring'), kind: 'circular-pattern', sourceId: 'box', count: 2, axis: 'z', center: [0, -30, 0], angle: 360 }]).at('ring');
    expect(ring).toMatchObject({ key: 'box', modifiedBy: ['ring'] });
  });

  it('gives a mirror image a mirror key of its own and leaves its source', () => {
    const lineage = lineageOf([...box, { ...base('flip'), kind: 'mirror', sourceId: 'box', plane: 'YZ' }, { ...base('again'), kind: 'mirror', sourceId: 'flip', plane: 'XZ' }]);
    expect(lineage.bodies().map(summary)).toEqual([
      { key: 'box', createdBy: 'box', modifiedBy: [], consumedBy: undefined },
      { key: 'flip/mirror', createdBy: 'flip', modifiedBy: [], consumedBy: undefined },
      { key: 'again/mirror', createdBy: 'again', modifiedBy: [], consumedBy: undefined }]);
    expect(lineage.of('flip')?.key).toBe('flip/mirror');
  });

  it('gives an imported solid the key of its feature', () => {
    const imported = { ...base('part'), kind: 'imported', source: {} } as unknown as CadFeature;
    const lineage = cadBodyLineage([imported, { ...base('round'), kind: 'fillet', targetId: 'part', radius: 1 }], { parameters: {} });
    expect(lineage.bodies().map(summary)).toEqual([{ key: 'part', createdBy: 'part', modifiedBy: ['round'], consumedBy: undefined }]);
    expect(cadBodyLineage([{ ...imported, suppressed: true }], { parameters: {} }).bodies()).toEqual([]);
  });

  it('passes identity through a suppressed feature as its suppression policy says', () => {
    const fillet = lineageOf([...box, { ...base('round', true), kind: 'fillet', targetId: 'box', radius: 1 }]);
    expect(fillet.bodies().map(summary)).toEqual([{ key: 'box', createdBy: 'box', modifiedBy: [], consumedBy: undefined }]);
    expect(fillet.of('round')?.key).toBe('box');
    expect(fillet.at('round')).toBeUndefined();
    const merge = lineageOf([...box, ...peg, { ...base('merge', true), kind: 'boolean', targetId: 'box', toolId: 'peg', operation: 'union' }]);
    expect(merge.bodies().map(body => body.key)).toEqual(['box', 'peg']);
    expect(merge.of('merge')?.key).toBe('box');
    const mirror = lineageOf([...box, { ...base('flip', true), kind: 'mirror', sourceId: 'box', plane: 'YZ' }]);
    expect(mirror.bodies().map(body => body.key)).toEqual(['box']);
    expect(mirror.of('flip')).toBeUndefined();
    const created = lineageOf([sketch('box_sketch'), pad('box', 'box_sketch', 'new', null, true), ...peg]);
    expect(created.bodies().map(body => body.key)).toEqual(['peg']);
    expect(created.of('box')).toBeUndefined();
  });

  it('changes keys on reorder and delete only where creation changed', () => {
    const round = { ...base('round'), kind: 'fillet', targetId: 'box', radius: 1 } as CadFeature;
    const keys = (features: readonly CadFeature[]) => lineageOf(features).bodies().map(body => body.key).sort();
    expect(keys([...box, ...peg, round])).toEqual(['box', 'peg']);
    expect(keys([...box, round, ...peg])).toEqual(['box', 'peg']);
    expect(keys([...peg, ...box, round])).toEqual(['box', 'peg']);
    expect(keys([...box, ...peg])).toEqual(['box', 'peg']);
    expect(keys([...peg])).toEqual(['peg']);
    expect(lineageOf([...box, round, ...peg]).bodies().map(body => body.key)).toEqual(['box', 'peg']);
    expect(lineageOf([...box, ...peg, round]).bodies().map(body => body.key)).toEqual(['peg', 'box']);
  });

  it('lists the ids of current bodies as the features whose results they are', () => {
    const parsed = document([...box, ...peg, { ...base('round'), kind: 'fillet', targetId: 'box', radius: 1 }]);
    expect(cadVisibleBodyIds(parsed.features, parsed)).toEqual(['peg', 'round']);
    expect(createCadBodyLineage().latest()).toBeUndefined();
    expect(cadBodyLineage(parsed.features, parsed).latest()?.key).toBe('box');
  });
});

describe('body parts', () => {
  type Entry = readonly [source: number, solid: number, rank: number];
  type Groups = readonly (readonly string[])[];
  const target = [{ kind: 'target' }] as const, fused = [{ kind: 'target' }, { kind: 'tool' }] as const;
  const copies = (n: number): CadBodySource[] => [{ kind: 'target' }, ...Array.from({ length: n }, (_, index) => ({ kind: 'copy' as const, i: index + 1, j: 0 }))];
  const facts = (solids: number, traced: readonly (readonly Entry[])[], extra: Partial<CadBodyKernelFacts> = {}): CadBodyKernelFacts =>
    ({ solids, removesMaterial: true, sources: target, provenance: vi.fn(() => traced.map(list => list.map(([source, solid, rank]) => ({ source, solid, rank })))), ...extra });
  // An order as keys alone, any piece in any place, or with what places each piece.
  type Orders = readonly (readonly string[] | { readonly keys: readonly string[]; readonly by?: readonly (readonly number[])[] })[];
  const ordersOf = (orders: Orders) => orders.map(order => Array.isArray(order) ? { keys: order } : order as Exclude<Orders[number], readonly string[]>);
  const previous = (pieces?: readonly string[], ambiguous?: Groups, orders?: Orders): CadBodyState =>
    ({ key: key('pad'), kind: 'solid', createdBy: 'pad', modifiedBy: ['cut'], ...(pieces ? { pieces: pieces.map(key) } : {}), ...(ambiguous ? { ambiguous: ambiguous.map(group => group.map(key)) } : {}),
      ...(orders ? { orders: ordersOf(orders) as CadBodyOrder[] } : {}) });
  const parts = (input: { before?: readonly string[]; ambiguous?: Groups; orders?: Orders; beforeSolids?: number; facts: CadBodyKernelFacts }) =>
    cadBodyParts({ featureId: 'cut', previous: previous(input.before, input.ambiguous, input.orders), beforeSolids: input.beforeSolids ?? input.before?.length ?? 1, facts: input.facts });
  // Unless stated, the feature made its groups' keys and its orders' keys ambiguous.
  const changed = (pieces: readonly string[], rest: { ambiguous?: Groups; orders?: Orders; ambiguousNow?: readonly string[]; inherited?: readonly (readonly [string, string])[]; lost?: readonly string[] } = {}) =>
    ({ pieces, ...(rest.ambiguous ? { ambiguous: rest.ambiguous } : {}), ...(rest.orders ? { orders: ordersOf(rest.orders) } : {}),
      ambiguousNow: rest.ambiguousNow ?? [...new Set([...rest.ambiguous?.flat() ?? [], ...ordersOf(rest.orders ?? []).flatMap(order => order.keys)])],
      inherited: rest.inherited ?? [], lost: rest.lost ?? [] });
  const whole = { ambiguousNow: [], inherited: [], lost: [] };
  const A = 'pad/split(0)', B = 'pad/split(1)', C = 'pad/split(2)';

  it('numbers the pieces of a first split by the first face each keeps, not by the kernel order', () => {
    expect(parts({ facts: facts(2, [[[0, 0, 9]], [[0, 0, 4]]]) })).toEqual(changed(['pad/split(1)', 'pad/split(0)']));
    expect(parts({ facts: facts(3, [[[0, 0, 2]], [[0, 0, 7]], [[0, 0, 5]]]) }).pieces).toEqual(['pad/split(0)', 'pad/split(2)', 'pad/split(1)']);
  });

  it('numbers pieces that keep no face after the others, and reports two or more of them as ambiguous, in any order', () => {
    expect(parts({ facts: facts(3, [[[0, 0, 3]], [], []]) }))
      .toEqual(changed(['pad/split(0)', 'pad/split(1)', 'pad/split(2)'], { orders: [['pad/split(1)', 'pad/split(2)']] }));
    expect(parts({ facts: facts(2, [[[0, 0, 3]], []]) })).toEqual(changed(['pad/split(0)', 'pad/split(1)']));
  });

  it('keeps a body whole until one of its solids may have split, whatever the totals', () => {
    const joined = facts(2, [], { removesMaterial: false, sources: fused });
    expect(parts({ facts: joined })).toEqual(whole);
    expect(joined.provenance).not.toHaveBeenCalled();
    expect(parts({ beforeSolids: 2, facts: facts(2, [[[0, 0, 1]], [[0, 1, 4]]]) })).toEqual(whole);
    // Two solids in and two out: the first split in two and the second went.
    expect(parts({ beforeSolids: 2, facts: facts(2, [[[0, 0, 1]], [[0, 0, 5]]]) })).toEqual(changed(['pad/split(0)', 'pad/split(1)']));
    // A solid keeping no face may be a piece of either solid, so the body may have split although as many solids are left.
    expect(parts({ beforeSolids: 2, facts: facts(2, [[[0, 0, 1]], []]) })).toEqual(changed(['pad/split(0)', 'pad/split(1)']));
  });

  it('orders pieces by faces of different solids only within each solid, since the solids come in the kernel order', () => {
    // A whole body of two solids, the first split: its two pieces keep their order, and the other solid's piece may come before, between
    // or after them as the kernel lists the solids. The faces of the first solid rank 1 to 9, the second's from 10.
    const block = parts({ beforeSolids: 2, facts: facts(3, [[[0, 0, 1]], [[0, 0, 5]], [[0, 1, 12]]]) });
    const placed = { keys: [A, B, C], by: [[0, 0], [0, 1], [1, 0]] };
    expect(block).toEqual(changed([A, B, C], { orders: [placed] }));
    expect(cadBodyOrderPlaces(block.orders![0])).toEqual([[0, 1], [1, 2], [0, 2]]);
    // The same holds for a fused tool of several solids, and for merges that decide by several solids of one source.
    expect(parts({ before: [A], facts: facts(3, [[[0, 0, 1]], [[1, 0, 1]], [[1, 1, 7]]], { removesMaterial: false, sources: fused }) }))
      .toEqual(changed([A, 'cut/split(0)', 'cut/split(1)'], { orders: [{ keys: ['cut/split(0)', 'cut/split(1)'], by: [[0, 0], [1, 0]] }] }));
    const merges = parts({ before: [A, B, C, 'pad/split(3)'], facts: facts(2, [[[0, 0, 1], [0, 1, 9]], [[0, 2, 12], [0, 3, 20]]]) });
    expect(merges).toEqual(changed(['cut/split(0)', 'cut/split(1)'], { orders: [{ keys: ['cut/split(0)', 'cut/split(1)'], by: [[0, 0, 1, 0], [2, 0, 3, 0]] }], lost: [A, B, C, 'pad/split(3)'] }));
    expect(cadBodyOrderPlaces(merges.orders![0])).toEqual([[0, 1], [0, 1]]);
  });

  it('never orders pieces by equal ranks, which the kernel order of the solids breaks', () => {
    expect(parts({ beforeSolids: 2, facts: facts(2, [[[0, 0, 2]], [[0, 0, 2]]]) })).toEqual(changed([A, B], { orders: [[A, B]] }));
    // Only the tied pieces are ambiguous: the piece first by rank keeps its number in either order.
    expect(parts({ facts: facts(3, [[[0, 0, 2]], [[0, 0, 1]], [[0, 0, 2]]]) })).toEqual(changed([B, A, C], { orders: [[B, C]] }));
    expect(parts({ before: [A, B], facts: facts(3, [[[0, 1, 1]], [[0, 0, 3]], [[0, 0, 3]]]) })).toEqual(changed([B, `${A}/split(0)`, `${A}/split(1)`],
      { orders: [[`${A}/split(0)`, `${A}/split(1)`]] }));
    // Within a solid of several, a tie spreads over the places either piece may take.
    const tied = parts({ beforeSolids: 2, facts: facts(3, [[[0, 0, 2]], [[0, 0, 2]], [[0, 1, 12]]]) });
    expect(tied.orders).toEqual([{ keys: [A, B, C], by: [[0, 0], [0, 0], [1, 0]] }]);
    expect(cadBodyOrderPlaces(tied.orders![0])).toEqual([[0, 1, 2], [0, 1, 2], [0, 2]]);
  });

  it('settles a piece whose place no kernel order changes, though its first faces lie in several solids', () => {
    // One solid of a fused tool's keeps the first faces of both tool solids, the other a later face of the second: the first comes first in
    // either order, so neither is ambiguous.
    const settled = parts({ before: [A], facts: facts(3, [[[0, 0, 1]], [[1, 0, 1], [1, 1, 10]], [[1, 1, 14]]], { removesMaterial: false, sources: fused }) });
    const order = { keys: ['cut/split(0)', 'cut/split(1)'], by: [[0, 0, 1, 0], [1, 1]] };
    expect(settled).toEqual(changed([A, 'cut/split(0)', 'cut/split(1)'], { orders: [order], ambiguousNow: [] }));
    expect(cadBodyOrderPlaces(settled.orders![0])).toEqual([[0], [1]]);
    // Two merges whose second keeps the first face of a third piece: that piece's solid may come first, and put the second merge first.
    const three = parts({ before: [A, B, C], facts: facts(2, [[[0, 0, 4], [0, 1, 10]], [[0, 1, 11], [0, 2, 20]]]) });
    expect(three.orders).toEqual([{ keys: ['cut/split(0)', 'cut/split(1)'], by: [[0, 0, 1, 0], [1, 1, 2, 0]] }]);
    expect(cadBodyOrderPlaces(three.orders![0])).toEqual([[0, 1], [0, 1]]);
    expect(three.ambiguousNow).toEqual(['cut/split(0)', 'cut/split(1)']);
  });

  it('records an order without places past the shared solid limit, so each of its pieces may take any of its indices', () => {
    // Six merges of two pieces each share no solid, so each piece's place follows the order of twelve solids.
    const before = Array.from({ length: 12 }, (_, k) => `pad/split(${k})`);
    const traced = Array.from({ length: 6 }, (_, k): Entry[] => [[0, 2 * k, 10 * k + 1], [0, 2 * k + 1, 10 * k + 5]]);
    const merges = parts({ before, facts: facts(6, traced) });
    expect(merges.orders).toEqual([{ keys: Array.from({ length: 6 }, (_, k) => `cut/split(${k})`) }]);
    expect(cadBodyOrderPlaces(merges.orders![0])).toEqual(Array.from({ length: 6 }, () => [0, 1, 2, 3, 4, 5]));
    // Five merges, ten shared solids, are placed exactly: any of them may come anywhere, as no two share a solid.
    const five = parts({ before: before.slice(0, 10), facts: facts(5, traced.slice(0, 5)) });
    expect(five.orders?.[0].by).toHaveLength(5);
    expect(cadBodyOrderPlaces(five.orders![0])).toEqual(Array.from({ length: 5 }, () => [0, 1, 2, 3, 4]));
  });

  it('follows each piece by its kept faces, and splits a piece under its own key', () => {
    expect(parts({ before: [A, B], facts: facts(3, [[[0, 1, 5]], [[0, 0, 2]], [[0, 1, 3]]]) }))
      .toEqual(changed(['pad/split(1)/split(1)', A, 'pad/split(1)/split(0)']));
  });

  it('treats a solid keeping no face as possibly split from any key, never as proof that a traced piece continues alone', () => {
    // The piece left keeps faces of A, and B can't be found: the fresh solid may be B, or a piece A split into.
    expect(parts({ before: [A, B], facts: facts(2, [[[0, 0, 1]], []]) })).toEqual(changed([A, 'cut/split(0)'], { ambiguous: [['cut/split(0)', A, B]] }));
    // With one piece before and no material added, a solid keeping no face can only come from that piece.
    expect(parts({ before: [A], facts: facts(2, [[[0, 0, 1]], []]) })).toEqual(changed([`${A}/split(0)`, `${A}/split(1)`]));
    // A fused tool could have made it, so it is fresh even beside one piece, and that piece may have split into it.
    expect(parts({ before: [A], facts: facts(2, [[[0, 0, 1]], []], { removesMaterial: false, sources: fused }) })).toEqual(changed([A, 'cut/split(0)'], { ambiguous: [['cut/split(0)', A]] }));
    // Pieces of a key several solids continue keep their numbers whoever else split from it, so only the fresh solid is uncertain.
    expect(parts({ before: [A, B], facts: facts(4, [[[0, 0, 1]], [[0, 0, 2]], [[0, 1, 1]], []]) }))
      .toEqual(changed([`${A}/split(0)`, `${A}/split(1)`, B, 'cut/split(0)'], { ambiguous: [['cut/split(0)', B]] }));
    expect(parts({ before: [A, B], facts: facts(5, [[[0, 0, 1]], [[0, 0, 2]], [[0, 1, 1]], [[0, 1, 2]], []]) }))
      .toEqual(changed([`${A}/split(0)`, `${A}/split(1)`, `${B}/split(0)`, `${B}/split(1)`, 'cut/split(0)']));
  });

  it('reports pieces a feature removed or merged as lost, and gives a merged solid a fresh key', () => {
    expect(parts({ before: [A, B], facts: facts(1, [[[0, 0, 1]]]) })).toEqual(changed([A], { lost: [B] }));
    // A join bridging both pieces and adding an island: the island is the tool's alone, the bridge merges both pieces.
    expect(parts({ before: [A, B], facts: facts(2, [[[0, 0, 1], [0, 1, 2], [1, 0, 3]], [[1, 0, 1]]], { removesMaterial: false, sources: fused }) }))
      .toEqual(changed(['cut/split(1)', 'cut/split(0)'], { lost: [A, B] }));
    // A tool fused into one piece keeps that piece's key.
    expect(parts({ before: [A, B], facts: facts(2, [[[0, 0, 1], [1, 0, 2]], [[0, 1, 1]]], { removesMaterial: false, sources: fused }) })).toEqual(changed([A, B]));
  });

  it('carries ambiguity to surviving pieces and their descendants, which extend the issue that reported it', () => {
    expect(parts({ before: [A, B], ambiguous: [[A, B]], facts: facts(2, [[[0, 0, 1]], [[0, 1, 1]]]) })).toEqual(changed([A, B], { ambiguous: [[A, B]], ambiguousNow: [] }));
    // Which member the solid split under A's key continued can't be told, so A stays in the group while B's solid is left unchanged.
    expect(parts({ before: [A, B], ambiguous: [[A, B]], facts: facts(3, [[[0, 0, 1]], [[0, 0, 4]], [[0, 1, 1]]]) }))
      .toEqual(changed([`${A}/split(0)`, `${A}/split(1)`, B], { ambiguous: [[`${A}/split(0)`, `${A}/split(1)`, B, A]], ambiguousNow: [],
        inherited: [[`${A}/split(0)`, A], [`${A}/split(1)`, A]] }));
    // So it does when B's solid is gone: either key may name the solid that split.
    expect(parts({ before: [A, B, C], ambiguous: [[A, B]], facts: facts(3, [[[0, 0, 1]], [[0, 0, 4]], [[0, 2, 1]]]) }))
      .toEqual(changed([`${A}/split(0)`, `${A}/split(1)`, C], { ambiguous: [[`${A}/split(0)`, `${A}/split(1)`, A, B]], ambiguousNow: [],
        inherited: [[`${A}/split(0)`, A], [`${A}/split(1)`, A]] }));
    // And when every piece of the group split, since the solids may have split into other counts in another order.
    expect(parts({ before: [A, B], ambiguous: [[A, B]], facts: facts(5, [[[0, 0, 1]], [[0, 0, 4]], [[0, 1, 1]], [[0, 1, 4]], [[0, 1, 6]]]) }))
      .toEqual(changed([`${A}/split(0)`, `${A}/split(1)`, `${B}/split(0)`, `${B}/split(1)`, `${B}/split(2)`],
        { ambiguous: [[`${A}/split(0)`, `${A}/split(1)`, `${B}/split(0)`, `${B}/split(1)`, `${B}/split(2)`, A, B]],
        ambiguousNow: [], inherited: [[`${A}/split(0)`, A], [`${A}/split(1)`, A], [`${B}/split(0)`, B], [`${B}/split(1)`, B], [`${B}/split(2)`, B]] }));
  });

  it('never reports an ambiguous piece lost while a solid it could be is left', () => {
    // Which of A and B the cut removed can't be told, so both stay ambiguous with the solid left.
    expect(parts({ before: [A, B], ambiguous: [[A, B]], facts: facts(1, [[[0, 1, 1]]]) })).toEqual(changed([B], { ambiguous: [[B, A]], ambiguousNow: [] }));
    // Merging an ambiguous piece leaves the merged solid ambiguous with the rest; a certain piece merged with it is lost.
    expect(parts({ before: [A, B, C], ambiguous: [[A, B, 'gone/split(0)']], facts: facts(2, [[[0, 0, 1], [0, 2, 1]], [[0, 1, 1]]], { removesMaterial: false, sources: fused }) }))
      .toEqual(changed(['cut/split(0)', B], { ambiguous: [['cut/split(0)', B, A, 'gone/split(0)']], ambiguousNow: [], inherited: [['cut/split(0)', A]], lost: [C] }));
    // Once no solid descends from the group, its keys are lost.
    expect(parts({ before: [A, B, C], ambiguous: [[A, B]], facts: facts(1, [[[0, 2, 1]]]) })).toEqual(changed([C], { lost: [A, B] }));
    // So is a former member's key the group kept after its own solid split or went, since it could have named either.
    expect(parts({ before: [A, B, C], ambiguous: [[A, B, 'gone/split(0)']], facts: facts(1, [[[0, 2, 1]]]) }))
      .toEqual(changed([C], { lost: ['gone/split(0)', A, B] }));
    // A solid keeping no face may be any of them.
    expect(parts({ before: [A, B], ambiguous: [[A, B]], facts: facts(2, [[], []]) })).toEqual(changed(['cut/split(0)', 'cut/split(1)'],
      { ambiguous: [['cut/split(0)', 'cut/split(1)', A, B]], orders: [['cut/split(0)', 'cut/split(1)']], ambiguousNow: ['cut/split(0)', 'cut/split(1)'] }));
    // Nor while another order gives its key the solid left: which of A and B the cut removed is the kernel's order.
    expect(parts({ before: [A, B], orders: [[A, B]], facts: facts(1, [[[0, 1, 1]]]) })).toEqual(changed([B], { orders: [[A, B]], ambiguousNow: [] }));
    // Once that solid goes too, neither key names a piece in any order, and both are lost.
    expect(parts({ before: [B, C], orders: [[A, B]], facts: facts(1, [[[0, 1, 1]]]) })).toEqual(changed([C], { lost: [A, B] }));
  });

  it('reports every key that named a removed or merged solid in some order, listed or not, the same in every order', () => {
    // A and B traded places, and the piece under A split in two by its faces. Merging A's halves loses them, and the keys under B that name
    // them in the other order, though this build never gave those keys; the other order gives the same report.
    const halves = (under: string, other: string) => ({ before: [`${under}/split(0)`, `${under}/split(1)`, other], orders: [[A, B]],
      facts: facts(2, [[[0, 0, 1], [0, 1, 1]], [[0, 2, 1]]]) });
    const lost = [`${A}/split(0)`, `${A}/split(1)`, `${B}/split(0)`, `${B}/split(1)`];
    expect(parts(halves(A, B))).toEqual(changed(['cut/split(0)', B], { orders: [[A, B]], ambiguousNow: [], lost }));
    expect(parts(halves(B, A))).toEqual(changed(['cut/split(0)', A], { orders: [[A, B]], ambiguousNow: [], lost }));
    // Removing one half loses its key and the key under B that names it in the other order; the other half's keys name the half left.
    expect(parts({ before: [`${A}/split(0)`, `${A}/split(1)`, B], orders: [[A, B]], facts: facts(2, [[[0, 1, 1]], [[0, 2, 1]]]) }))
      .toEqual(changed([`${A}/split(1)`, B], { orders: [[A, B]], ambiguousNow: [], lost: [`${A}/split(0)`, `${B}/split(0)`] }));
    // Numbers sort by value.
    const many = Array.from({ length: 12 }, (_, k) => `pad/split(${k})`);
    expect(parts({ before: many, facts: facts(1, [[[0, 11, 1]]]) }).lost).toEqual(many.slice(0, 11));
  });

  it('stops tracking a body once the keys a feature leaves lost pass the list limit, however many keys name what it removed', () => {
    // Nested splits, each traded with its sibling: 2 ** depth keys name each of the two deepest pieces in some order.
    const chain = (depth: number) => {
      const levels = Array.from({ length: depth }, (_, level) => `pad${'/split(1)'.repeat(level)}`);
      return { before: [...levels.map(prefix => `${prefix}/split(0)`), `${levels[depth - 1]}/split(1)`], orders: levels.map(prefix => [`${prefix}/split(0)`, `${prefix}/split(1)`]) };
    };
    const keeping = (count: number, removed: number) => facts(count - removed, Array.from({ length: count - removed }, (_, solid) => [[0, solid, 1]]));
    // Removing the deepest piece loses nothing: each of its keys names its sibling, which is left, in another order.
    const deep = chain(13);
    expect(parts({ ...deep, facts: keeping(14, 1) })).toMatchObject({ pieces: deep.before.slice(0, 13), lost: [] });
    // Removing both loses every key: past the limit at thirteen levels, and exactly at it at twelve.
    expect(parts({ ...deep, facts: keeping(14, 2) })).toEqual({ untracked: true, ambiguousNow: [], inherited: [], lost: [], overflowed: true });
    const shallow = parts({ ...chain(12), facts: keeping(13, 2) });
    expect([shallow.untracked, shallow.lost.length, shallow.lost[0], shallow.lost.at(-1)])
      .toEqual([undefined, 2 ** 12, `pad${'/split(0)'.repeat(12)}`, `pad${'/split(1)'.repeat(12)}`]);
  });

  it('never reads the keys of a removed piece that stays in a group, which can take more steps than the work bound', () => {
    // Two nested splits of 2,000 pieces each, in any kernel order. A key naming an inner piece may take any of 2,000 indices at each of its
    // two steps; after the first it may name any of the 2,000 outer pieces, before the feature and after it, and each index of the second
    // reads them all. So reading the keys of one removed inner piece takes about 2 * 2,000 ** 2 steps, past MAX_CAD_BODY_ORDER_WORK (2 ** 22),
    // while the body keeps 4,000 keys, within the list limit. The steps are the search's own count, so no clock decides the outcome.
    const width = 2000, outer = Array.from({ length: width }, (_, k) => `pad/split(${k})`), inner = outer.map(part => part.replace('pad', outer[0]));
    const before = [...inner, ...outer.slice(1)], orders = [outer, inner], gone = inner[1];
    const kept = before.flatMap((_, solid): (readonly Entry[])[] => solid === 1 ? [] : [[[0, solid, 1]]]);
    // Removed alone, none of its keys is lost, since each names a sibling left in another order, but finding that passes the bound.
    expect(parts({ before, orders, facts: facts(kept.length, kept) })).toMatchObject({ untracked: true, overflowed: true });
    // In a group that a piece left descends from, its key stays, naming that piece, so no key naming it can be lost and none is read.
    const carried = parts({ before, orders, ambiguous: [[inner[0], gone]], facts: facts(kept.length, kept) });
    expect([carried.untracked, carried.lost, carried.ambiguous, carried.pieces?.length]).toEqual([undefined, [], [[inner[0], gone]], kept.length]);
    // So in the group a solid keeping no face, which may be it, makes with every piece continued alone.
    const unknown = parts({ before, orders, facts: facts(kept.length + 1, [...kept, []]) });
    expect([unknown.untracked, unknown.lost, unknown.ambiguous?.map(group => [group.length, group.at(-1)])]).toEqual([undefined, [], [[kept.length + 2, gone]]]);
  });

  it('records an order only for siblings the kernel ordered at their own split, and keeps it while a key it numbers leads to one the body keeps', () => {
    const traded = { before: [A, B], orders: [[A, B]] };
    // B's halves are ambiguous through B, which extends B's issue, but its faces ordered them: only A and B could have traded keys.
    const halves = parts({ ...traded, facts: facts(3, [[[0, 0, 1]], [[0, 1, 1]], [[0, 1, 4]]]) });
    expect(halves).toEqual(changed([A, `${B}/split(0)`, `${B}/split(1)`], { orders: [[A, B]], ambiguousNow: [], inherited: [[`${B}/split(0)`, B], [`${B}/split(1)`, B]] }));
    // Halves tied by rank are an order themselves, and A and B stay while B leads to them. A's solid went, but in the other order A is B's
    // solid, which split: A is an old key, not a lost one.
    const tied = parts({ ...traded, facts: facts(2, [[[0, 1, 2]], [[0, 1, 2]]]) });
    expect(tied).toEqual(changed([`${B}/split(0)`, `${B}/split(1)`], { orders: [[A, B], [`${B}/split(0)`, `${B}/split(1)`]], ambiguousNow: [],
      inherited: [[`${B}/split(0)`, B], [`${B}/split(1)`, B]] }));
    // Once neither leads to a key the body keeps, the order goes.
    expect(parts({ ...traded, before: [A, B, C], facts: facts(1, [[[0, 2, 1]]]) })).toEqual(changed([C], { lost: [A, B] }));
    // A merge of a piece another order could have numbered otherwise gets a fresh key, which names the merge in every order.
    expect(parts({ ...traded, facts: facts(1, [[[0, 0, 1], [0, 1, 1]]]) })).toEqual(changed(['cut/split(0)'], { lost: [A, B] }));
  });

  it('substitutes only the indices some order gives, keeping the pieces of each source solid in their order', () => {
    // A box joined to an island is one body of two solids, whose faces rank in the order the kernel lists them: the box's from 1, the
    // island's from 10. A slot splits the box in two, whose order the faces settle, and the island may come before, between or after them.
    // A second slot splits the box's later piece, which is never the first piece in any order.
    const parsed = document([...box, sketch('slot_sketch', 18, 4), pad('slot', 'slot_sketch', 'cut', 'box'), pad('again', 'slot_sketch', 'cut', 'slot')]);
    const kernel: Record<string, CadBodyKernelFacts> = { box: facts(2, [], { removesMaterial: false }), slot: facts(3, [[[0, 0, 1]], [[0, 0, 5]], [[0, 1, 12]]]),
      again: facts(4, [[[0, 0, 1]], [[0, 1, 2]], [[0, 1, 6]], [[0, 2, 1]]]) }, lineage = createCadBodyLineage();
    for (const feature of parsed.features) lineage.apply(feature, parsed, kernel[feature.id] ?? facts(1, []));
    const [first, later, island] = ['box/split(0)', 'box/split(1)', 'box/split(2)'], halves = [`${later}/split(0)`, `${later}/split(1)`];
    const body = lineage.get(key('box'))!;
    expect([body.pieces, body.ambiguous, body.orders]).toEqual([[first, ...halves, island], undefined, [{ keys: [first, later, island], by: [[0, 0], [0, 1], [1, 0]] }]]);
    const resolved = (part: string) => resolveCadBodyRef({ kind: 'body', key: key(part) }, lineage);
    for (const part of [`${first}/split(0)`, `${first}/split(1)`, `${island}/split(2)`]) expect(resolved(part), part).toEqual({ status: 'missing' });
    // The island first puts the later piece third, and its halves under box/split(2).
    expect(resolved(`${island}/split(0)`)).toMatchObject({ status: 'ambiguous', candidates: [halves[0]] });
    expect(resolved(`${later}/split(1)`)).toMatchObject({ status: 'ambiguous', candidates: [halves[1]] });
    expect(resolved(first)).toMatchObject({ status: 'ambiguous', candidates: [first, island] });
    expect(resolved(island)).toMatchObject({ status: 'ambiguous', candidates: [island] });
    // The slot's issue lists its three pieces and the halves that continue one of them.
    expect(lineage.issues()).toEqual([{ code: 'ambiguous-body-parts', featureId: 'slot', body: 'box', pieces: [first, later, island, ...halves],
      message: '5 pieces of body box can\'t be told apart after slot, so references to them are ambiguous.' }]);
  });

  it('keys a pattern copy apart from the originals by the copy it keeps faces of, the original itself being inst(0,0)', () => {
    const pattern = (solids: number, traced: readonly (readonly Entry[])[], n = 2) => facts(solids, traced, { removesMaterial: false, sources: copies(n) });
    expect(parts({ facts: pattern(3, [[[0, 0, 1]], [[1, 0, 1]], [[2, 0, 1]]]) })).toEqual(changed(['pad/inst(0,0)', 'pad/inst(1,0)', 'pad/inst(2,0)']));
    // Copies fused into the originals leave the body whole.
    expect(parts({ beforeSolids: 2, facts: pattern(2, [[[0, 0, 1], [1, 0, 1]], [[0, 1, 3], [1, 1, 3]]], 1) })).toEqual(whole);
    // Copies fused into each other, away from the original, merge without a target.
    expect(parts({ facts: pattern(2, [[[0, 0, 1]], [[1, 0, 1], [2, 0, 1]]]) })).toEqual(changed(['pad/inst(0,0)', 'cut/split(0)']));
    const four = pattern(4, [[[0, 0, 1]], [[0, 1, 1]], [[1, 0, 1]], [[1, 1, 1]]], 1);
    expect(parts({ before: [A, B], facts: four })).toEqual(changed([`${A}/inst(0,0)`, `${B}/inst(0,0)`, `${A}/inst(1,0)`, `${B}/inst(1,0)`]));
    // Ambiguous pieces stay ambiguous within each copy, never with another copy's pieces; their old keys stay with the copied originals.
    expect(parts({ before: [A, B], ambiguous: [[A, B]], facts: four })).toEqual(changed([`${A}/inst(0,0)`, `${B}/inst(0,0)`, `${A}/inst(1,0)`, `${B}/inst(1,0)`],
      { ambiguous: [[`${A}/inst(0,0)`, `${B}/inst(0,0)`, A, B], [`${A}/inst(1,0)`, `${B}/inst(1,0)`]], ambiguousNow: [],
        inherited: [[`${A}/inst(0,0)`, A], [`${B}/inst(0,0)`, B], [`${A}/inst(1,0)`, A], [`${B}/inst(1,0)`, B]] }));
    // The solids of a whole body several solids strong are told apart in each copy only by the kernel's order.
    const each = [['pad/inst(0,0)/split(0)', 'pad/inst(0,0)/split(1)'], ['pad/inst(1,0)/split(0)', 'pad/inst(1,0)/split(1)']];
    expect(parts({ beforeSolids: 2, facts: four })).toEqual(changed(each.flat(), { orders: each.map(keys => ({ keys, by: [[0, 0], [1, 0]] })) }));
    // A copy that vanished is never listed.
    expect(parts({ before: ['pad/inst(0,0)', 'pad/inst(1,0)'], facts: facts(1, [[[0, 0, 1]]]) })).toEqual(changed(['pad/inst(0,0)'], { lost: ['pad/inst(1,0)'] }));
  });

  it('carries pieces through a feature that keeps the solid order, and keeps them when one solid is left', () => {
    const moved = facts(2, [], { removesMaterial: false, sameSolidOrder: true });
    expect(parts({ before: [B, A], ambiguous: [[A, B]], facts: moved })).toEqual({ pieces: [B, A], ambiguous: [[A, B]], ambiguousNow: [], inherited: [], lost: [] });
    expect(moved.provenance).not.toHaveBeenCalled();
    expect(parts({ before: [A, B], facts: facts(1, [[[0, 1, 1], [0, 0, 1]]]) })).toEqual(changed(['cut/split(0)'], { lost: [A, B] }));
  });

  it('stops tracking parts past the limits instead of failing the build', () => {
    const many = facts(MAX_CAD_BODY_LIST + 1, []);
    expect(parts({ facts: many })).toEqual({ untracked: true, ambiguousNow: [], inherited: [], lost: [], overflowed: true });
    expect(many.provenance).not.toHaveBeenCalled();
    const long = `pad${'/split(0)'.repeat(Math.floor((MAX_CAD_BODY_KEY_LENGTH - 3) / 9))}`;
    expect(parts({ before: [long], facts: facts(2, [[[0, 0, 1]], [[0, 0, 2]]]) })).toMatchObject({ untracked: true, overflowed: true });
    expect(cadBodyParts({ featureId: 'cut', previous: { ...previous(), untracked: true }, beforeSolids: 9, facts: facts(9, []) })).toEqual({ untracked: true, ambiguousNow: [], inherited: [], lost: [] });
  });

  it('counts pieces, the keys groups keep and the keys orders number against the list limit together', () => {
    // A group of the piece A and earlier keys, and a certain piece B that splits in two: the limit counts every distinct key once, so a
    // group of 4,095 keys and B's two halves make 4,097.
    const earlier = (n: number) => Array.from({ length: n }, (_, k) => `round/split(0)/split(${k})`);
    const split = (kept: number, orders?: Orders) =>
      parts({ before: [A, B], ambiguous: [[A, ...earlier(kept)]], orders, facts: facts(3, [[[0, 0, 1]], [[0, 1, 7]], [[0, 1, 8]]]) });
    const full = split(MAX_CAD_BODY_LIST - 3);
    expect(new Set([...full.pieces!, ...full.ambiguous!.flat()]).size).toBe(MAX_CAD_BODY_LIST);
    expect(split(MAX_CAD_BODY_LIST - 2)).toEqual({ untracked: true, ambiguousNow: [], inherited: [], lost: [], overflowed: true });
    // The keys an order numbers count too, while one of them leads to a key the body keeps.
    const numbered = [['round/split(0)', 'round/split(1)']];
    expect(split(MAX_CAD_BODY_LIST - 5, numbered).orders).toEqual([{ keys: numbered[0] }]);
    expect(split(MAX_CAD_BODY_LIST - 4, numbered)).toEqual({ untracked: true, ambiguousNow: [], inherited: [], lost: [], overflowed: true });
    // The worker check holds replies to the same count.
    const body = (pieces: readonly string[], group: readonly string[]): CadBodyState =>
      ({ key: key('pad'), kind: 'solid', createdBy: 'pad', modifiedBy: ['round'], pieces: pieces.map(key), ambiguous: [group.map(key)] });
    expect(isCadBodyState(body(['pad/split(0)', 'pad/split(1)'], earlier(MAX_CAD_BODY_LIST - 2)))).toBe(true);
    expect(isCadBodyState(body(['pad/split(0)', 'pad/split(1)', 'pad/split(2)'], earlier(MAX_CAD_BODY_LIST - 2)))).toBe(false);
    const swapped = [{ keys: ['round/split(9)', 'round/split(10)'].map(key) }];
    expect(isCadBodyState({ ...body(['pad/split(0)'], earlier(MAX_CAD_BODY_LIST - 3)), orders: swapped })).toBe(true);
    expect(isCadBodyState({ ...body(['pad/split(0)'], earlier(MAX_CAD_BODY_LIST - 2)), orders: swapped })).toBe(false);
  });

  it('refuses provenance that does not describe every solid', () => {
    expect(() => parts({ facts: facts(2, [[[0, 0, 1]]]) })).toThrow('Each solid of the result needs its sources.');
  });

  it('records issues with bounded messages, and leaves the lineage unchanged when the kernel facts fail', () => {
    const parsed = document([...box, sketch('slot_sketch', 18, 4), pad('slot', 'slot_sketch', 'cut', 'box')]);
    const lineage = createCadBodyLineage();
    const [boxSketch, boxPad, slotSketch, slot] = parsed.features;
    for (const feature of [boxSketch, boxPad, slotSketch]) lineage.apply(feature, parsed, facts(1, []));
    const before = lineage.bodies();
    expect(() => lineage.apply(slot, parsed, { ...facts(2, []), provenance: () => { throw new Error('kernel failed'); } })).toThrow('kernel failed');
    expect(lineage.bodies()).toEqual(before);
    expect(lineage.at('box')?.key).toBe('box');
    const change = lineage.apply(slot, parsed, facts(2, [[], []]));
    expect(change?.state).toMatchObject({ key: 'box', modifiedBy: ['slot'], pieces: ['box/split(0)', 'box/split(1)'], orders: [{ keys: ['box/split(0)', 'box/split(1)'] }] });
    expect(lineage.issues()).toEqual([{ code: 'ambiguous-body-parts', featureId: 'slot', body: 'box', pieces: ['box/split(0)', 'box/split(1)'],
      message: '2 pieces of body box can\'t be told apart after slot, so references to them are ambiguous.' }]);
    expect(lineage.issues().every(isCadBodyIssue)).toBe(true);
  });

  it('reports an ambiguity once, extending its issue with the keys that descend from it', () => {
    const features: CadFeature[] = [...box, sketch('slot_sketch', 18, 4), pad('slot', 'slot_sketch', 'cut', 'box'),
      { ...base('row'), kind: 'linear-pattern', sourceId: 'slot', count: 2, spacing: [50, 0, 0] }, sketch('nick_sketch', 60, 2), pad('nick', 'nick_sketch', 'cut', 'row')];
    const parsed = document(features), lineage = createCadBodyLineage();
    const [a, b] = ['box/split(0)', 'box/split(1)'], copy = (part: string, i: number) => `${part}/inst(${i},0)`;
    for (const feature of parsed.features) lineage.apply(feature, parsed, feature.id === 'slot' ? facts(2, [[], []])
      : feature.id === 'row' ? facts(4, [[[0, 0, 1]], [[0, 1, 1]], [[1, 0, 1]], [[1, 1, 1]]], { removesMaterial: false, sources: copies(1) })
        : feature.id === 'nick' ? facts(5, [[[0, 0, 1]], [[0, 1, 1]], [[0, 2, 1]], [[0, 2, 4]], [[0, 3, 1]]]) : facts(1, []));
    const nicked = [`${copy(a, 1)}/split(0)`, `${copy(a, 1)}/split(1)`];
    expect(lineage.issues()).toEqual([{ code: 'ambiguous-body-parts', featureId: 'slot', body: 'box', pieces: [a, b, copy(a, 0), copy(b, 0), copy(a, 1), copy(b, 1), ...nicked],
      message: '8 pieces of body box can\'t be told apart after slot, so references to them are ambiguous.' }]);
    // The body keeps the slot's order and no group, and a key of b's copy names the nicked copy in the order that swaps a and b.
    const body = lineage.get(key('box'))!;
    expect([body.ambiguous, body.orders]).toEqual([undefined, [{ keys: [a, b] }]]);
    expect(resolveCadBodyRef({ kind: 'body', key: key(`${copy(b, 1)}/split(0)`) }, lineage)).toMatchObject({ status: 'ambiguous', candidates: [nicked[0]] });
    expect(resolveCadBodyRef({ kind: 'body', key: key(`${copy(b, 1)}/split(2)`) }, lineage)).toEqual({ status: 'missing' });
  });

  it('extends an issue up to the list limit, and reports the keys past it in an issue of the later feature', () => {
    // A comb cut leaves 1,000 teeth keeping no face. Each pattern copies them, and between the two a cut takes the originals away, so the
    // cut\'s issue would reach 5,000 keys while the body never keeps more than 3,000.
    const row = (id: string, sourceId: string): CadFeature => ({ ...base(id), kind: 'linear-pattern', sourceId, count: 2, spacing: [50, 0, 0] });
    const parsed = document([...box, sketch('slot_sketch', 18, 4), pad('slot', 'slot_sketch', 'cut', 'box'), row('row', 'slot'),
      sketch('trim_sketch', 0, 45), pad('trim', 'trim_sketch', 'cut', 'row'), row('again', 'trim')]), lineage = createCadBodyLineage(), teeth = 1000;
    const copied = (source: (solid: number) => number) => facts(teeth * 2, Array.from({ length: teeth * 2 }, (_, solid) => [[Math.floor(solid / teeth), source(solid % teeth), 1]]),
      { removesMaterial: false, sources: copies(1) });
    const kernel: Record<string, CadBodyKernelFacts> = { slot: facts(teeth, Array.from({ length: teeth }, () => [])), row: copied(solid => solid),
      trim: facts(teeth, Array.from({ length: teeth }, (_, solid) => [[0, teeth + solid, 1]])), again: copied(solid => solid) };
    for (const feature of parsed.features) lineage.apply(feature, parsed, kernel[feature.id] ?? facts(1, []));
    // The cut\'s issue takes the 3,000 keys up to the second pattern, then that pattern\'s first copies and as many of its second as fit.
    const tooth = (k: number, i: number) => `box/split(${k})/inst(1,0)/inst(${i},0)`, fit = MAX_CAD_BODY_LIST - teeth * 4;
    const issues = lineage.issues();
    expect(issues.map(issue => [issue.code, issue.featureId, issue.pieces.length]))
      .toEqual([['ambiguous-body-parts', 'slot', MAX_CAD_BODY_LIST], ['lost-body-parts', 'trim', teeth], ['ambiguous-body-parts', 'again', teeth * 5 - MAX_CAD_BODY_LIST]]);
    expect([issues[0].pieces[teeth * 3], issues[0].pieces.at(-1)]).toEqual([tooth(0, 0), tooth(fit - 1, 1)]);
    expect(issues[2].pieces).toEqual(Array.from({ length: teeth - fit }, (_, k) => tooth(fit + k, 1)));
    expect(issues.every(isCadBodyIssue)).toBe(true);
    // Every ambiguous key is listed by one of them: each piece descends from a tooth the comb\'s order numbered.
    const listed = new Set(issues.flatMap(issue => issue.pieces)), body = lineage.get(key('box'))!;
    expect([body.ambiguous, body.orders?.map(order => order.keys.length)]).toEqual([undefined, [teeth]]);
    expect(body.pieces?.every(part => listed.has(part))).toBe(true);
  });

  it('stops tracking a body for good once its pieces and the keys its groups keep pass the list limit', () => {
    // A slot splits the box in two, and a comb cut leaves 100 teeth keeping no face, any of which may be either half: a group of 102 keys.
    // Each later cut splits the first tooth and removes the second, so the body keeps 100 solids while its group keeps both old keys: two
    // more at each cut, until the 1,998th cut passes the limit.
    const solids = 100, overflowing = (MAX_CAD_BODY_LIST - solids - 2) / 2 + 1;
    const cuts = Array.from({ length: overflowing + 1 }, (_, index) => pad(`c${index}`, 'slot_sketch', 'cut', index ? `c${index - 1}` : 'comb'));
    const parsed = document([...box, sketch('slot_sketch', 18, 4), pad('slot', 'slot_sketch', 'cut', 'box'), pad('comb', 'slot_sketch', 'cut', 'slot'), ...cuts]);
    const lineage = createCadBodyLineage(), later = (id: string) => /^c\d/.test(id);
    // The teeth after the first two keep their order, and the first splits into the last two solids.
    const cut = facts(solids, Array.from({ length: solids }, (_, solid) => solid < solids - 2 ? [[0, solid + 2, 1]] : [[0, 0, solid - solids + 3]]));
    const states = new Map<string, CadBodyState>();
    for (const feature of parsed.features) {
      const change = lineage.apply(feature, parsed, feature.id === 'slot' ? facts(2, [[[0, 0, 1]], [[0, 0, 2]]])
        : feature.id === 'comb' ? facts(solids, Array.from({ length: solids }, () => [])) : later(feature.id) ? cut : facts(1, []));
      if (change && later(feature.id)) states.set(feature.id, change.state);
    }
    expect(overflowing).toBe(1998);
    // The last cut tracked leaves 100 pieces in a group of exactly the limit, every old key kept; the next stops tracking.
    const tracked = states.get(`c${overflowing - 2}`)!;
    expect([tracked.pieces?.length, tracked.ambiguous?.map(group => group.length), tracked.untracked]).toEqual([solids, [MAX_CAD_BODY_LIST], undefined]);
    expect(tracked.ambiguous?.[0]).toEqual(expect.arrayContaining(['box/split(0)', 'box/split(1)', 'comb/split(1)', 'comb/split(3)']));
    expect(states.get(`c${overflowing - 1}`)).toMatchObject({ untracked: true });
    const issues = lineage.issues();
    expect(issues.map(issue => [issue.code, issue.featureId, issue.pieces.length]))
      .toEqual([['ambiguous-body-parts', 'comb', MAX_CAD_BODY_LIST], ['untracked-body-parts', `c${overflowing - 1}`, 0]]);
    // Every part, even a piece the last tracked state had, resolves as missing from then on.
    const body = lineage.get(key('box'))!;
    expect(body).toMatchObject({ modifiedBy: expect.arrayContaining([`c${overflowing}`]), untracked: true });
    expect([body.pieces, body.ambiguous, body.orders]).toEqual([undefined, undefined, undefined]);
    expect(resolveCadBodyRef({ kind: 'body', key: key('comb/split(99)') }, lineage)).toEqual({ status: 'missing' });
  }, 30_000);

  it('lists at most the issue limit, ending with a summary of the rest', () => {
    const cuts = Array.from({ length: MAX_CAD_BODY_ISSUES + 20 }, (_, index) => pad(`c${index}`, 'slot_sketch', 'cut', index ? `c${index - 1}` : 'box'));
    const parsed = document([...box, sketch('slot_sketch', 18, 4), ...cuts]), lineage = createCadBodyLineage();
    for (const feature of parsed.features) {
      const current = lineage.at(feature.kind === 'extrude' && feature.targetId ? feature.targetId : '');
      // Each cut leaves two solids keeping no face, so each reports new ambiguous pieces.
      lineage.apply(feature, parsed, current ? facts(2, [[], []]) : facts(1, []));
    }
    const issues = lineage.issues();
    expect(issues).toHaveLength(MAX_CAD_BODY_ISSUES);
    expect(issues.every(isCadBodyIssue)).toBe(true);
    expect(issues.at(-1)).toEqual({ code: 'more-body-issues', featureId: `c${MAX_CAD_BODY_ISSUES - 1}`, body: 'box', pieces: [],
      message: `21 more body issues, from feature c${MAX_CAD_BODY_ISSUES - 1} on, are not listed.` });
  });

  it('shares modifier histories, making a state only when one is asked for', () => {
    const moves = Array.from({ length: 3000 }, (_, index): CadFeature => ({ ...base(`m${index}`), kind: 'transform', sourceId: index ? `m${index - 1}` : 'box', translation: [1, 0, 0], rotation: [0, 0, 0] }));
    const parsed = document([...box, ...moves]), lineage = cadBodyLineage(parsed.features, parsed);
    expect(lineage.has('m2999')).toBe(true);
    expect(lineage.has('m2998')).toBe(false);
    const [body] = lineage.bodies();
    expect(body.modifiedBy).toHaveLength(3000);
    expect([body.modifiedBy[0], body.modifiedBy[2999]]).toEqual(['m0', 'm2999']);
    expect(lineage.at('m2999')).toBe(body);
  });
});

describe('body references, metadata and selection', () => {
  const split: CadBodyState = { key: key('box'), kind: 'solid', createdBy: 'box', modifiedBy: ['slot', 'round'],
    pieces: [key('box/split(0)'), key('round/split(0)')], ambiguous: [[key('round/split(0)'), key('box/split(1)')]] };
  const lineage = lineageOf([...box, ...peg, { ...base('merge'), kind: 'boolean', targetId: 'box', toolId: 'peg', operation: 'union' }]);
  const holding = (...bodies: CadBodyState[]) => ({ ...lineage, bodies: () => bodies, get: () => undefined }) as typeof lineage;

  it('resolves a stored body reference to a body, a part of one, its candidates, or why it is missing', () => {
    expect(resolveCadBodyRef({ kind: 'body', key: key('box') }, lineage)).toMatchObject({ status: 'resolved', body: { key: 'box' } });
    expect(resolveCadBodyRef({ kind: 'body', key: key('box/inst(7,0)') }, lineage)).toEqual({ status: 'missing' });
    expect(resolveCadBodyRef({ kind: 'body', key: key('peg') }, lineage)).toEqual({ status: 'missing', consumedBy: 'merge' });
    expect(resolveCadBodyRef({ kind: 'body', key: key('box/split(0)') }, holding(split))).toMatchObject({ status: 'resolved', part: 'box/split(0)' });
    expect(resolveCadBodyRef({ kind: 'body', key: key('round/split(0)') }, holding(split))).toMatchObject({ status: 'ambiguous', candidates: ['round/split(0)'] });
    // An earlier piece no build could find among the solids may be any ambiguous one.
    expect(resolveCadBodyRef({ kind: 'body', key: key('box/split(1)') }, holding(split))).toMatchObject({ status: 'ambiguous', candidates: ['round/split(0)'] });
    expect(resolveCadBodyRef({ kind: 'body', key: key('box/split(1)') }, holding({ ...split, pieces: [key('box/split(0)')] }))).toEqual({ status: 'missing' });
    const consumed = { ...lineage, consumed: () => [{ ...split, consumedBy: 'merge' }] } as typeof lineage;
    expect(resolveCadBodyRef({ kind: 'body', key: key('box/split(0)') }, consumed)).toEqual({ status: 'missing', consumedBy: 'merge' });
    // A key kept only in an ambiguous group was consumed with its body.
    expect(resolveCadBodyRef({ kind: 'body', key: key('box/split(1)') }, consumed)).toEqual({ status: 'missing', consumedBy: 'merge' });
  });

  it('resolves a key among the pieces it names in some kernel order, and to a piece only when it names it in every order', () => {
    const [a, b, c] = ['box/split(0)', 'box/split(1)', 'box/split(2)'];
    // Either kernel order may number a and b, and the faces of the solid b keys split it: in the other order a is that solid.
    const halves: CadBodyState = { key: key('box'), kind: 'solid', createdBy: 'box', modifiedBy: ['slot', 'cut'], pieces: [a, `${b}/split(0)`, `${b}/split(1)`, c].map(key),
      orders: [{ keys: [a, b].map(key) }] };
    const resolved = (part: string, state = halves) => resolveCadBodyRef({ kind: 'body', key: key(part) }, holding(state));
    expect(resolved(`${a}/split(0)`)).toMatchObject({ status: 'ambiguous', candidates: [`${b}/split(0)`] });
    expect(resolved(`${a}/split(1)`)).toMatchObject({ status: 'ambiguous', candidates: [`${b}/split(1)`] });
    // b's half names its piece in this order and nothing in the other; a names a in this order, and b names it in the other.
    expect(resolved(`${b}/split(1)`)).toMatchObject({ status: 'ambiguous', candidates: [`${b}/split(1)`] });
    expect(resolved(a)).toMatchObject({ status: 'ambiguous', candidates: [a] });
    expect(resolved(b)).toMatchObject({ status: 'ambiguous', candidates: [a] });
    // No order moves c, so it resolves; and no order splits that solid into more halves, or splits c.
    expect(resolved(c)).toMatchObject({ status: 'resolved', part: c });
    expect(resolved(`${a}/split(2)`)).toEqual({ status: 'missing' });
    expect(resolved(`${c}/split(0)`)).toEqual({ status: 'missing' });
    expect(resolveCadBodyRef({ kind: 'body', key: key(`${a}/split(1)`) }, { ...lineage, consumed: () => [{ ...halves, consumedBy: 'merge' }] } as typeof lineage))
      .toEqual({ status: 'missing', consumedBy: 'merge' });
    // A twin may come from a split further up: b's second half split again, and in the other order a is b's solid.
    const deeper: CadBodyState = { ...halves, pieces: [`${a}/split(0)`, `${a}/split(1)`, `${b}/split(0)`, `${b}/split(1)/split(0)`, `${b}/split(1)/split(1)`].map(key) };
    expect(resolved(`${a}/split(1)/split(0)`, deeper)).toMatchObject({ status: 'ambiguous', candidates: [`${b}/split(1)/split(0)`] });
    // Every sibling an order may place at the key's index counts.
    const apart: CadBodyState = { ...halves, pieces: [a, `${b}/split(0)`, `${c}/split(0)`, `${c}/split(1)`].map(key), orders: [{ keys: [a, b, c].map(key) }] };
    expect(resolved(`${a}/split(0)`, apart)).toMatchObject({ status: 'ambiguous', candidates: [`${b}/split(0)`, `${c}/split(0)`] });
    // A provenance group elsewhere in the body adds nothing to keys that can't reach it: a key no order gives stays missing, and a key an
    // order trades names only what that order gives. The group's own former key still resolves among its pieces.
    const fresh = ['cut/split(0)', 'cut/split(1)', 'cut/split(2)'];
    const grouped: CadBodyState = { ...halves, pieces: [...halves.pieces!, ...fresh.slice(0, 2).map(key)], ambiguous: [fresh.map(key)] };
    for (const part of [`${a}/split(2)`, `${c}/split(0)`, 'cut/split(0)/split(0)', 'cut/split(3)']) expect(resolved(part, grouped), part).toEqual({ status: 'missing' });
    expect(resolved(`${a}/split(0)`, grouped)).toMatchObject({ status: 'ambiguous', candidates: [`${b}/split(0)`] });
    expect(resolved(c, grouped)).toMatchObject({ status: 'resolved', part: c });
    expect(resolved(fresh[2], grouped)).toMatchObject({ status: 'ambiguous', candidates: fresh.slice(0, 2) });
  });

  it('takes a twin only from the split that gave the key\'s own step, never from a later key with the same steps', () => {
    // A fillet keyed two halves a and b in the kernel's order, and a cut split a. A pattern copied the pieces, a join merged the originals
    // into bridge/split(0), and a second pattern copied everything. The bridge's copy has the steps a's first copy would have had, but only
    // b, which the fillet keyed beside a, could have been a in another order.
    const [a, b, bridge] = ['round/split(0)', 'round/split(1)', 'bridge/split(0)'], copy = (part: string, ...i: number[]) => part + i.map(each => `/inst(${each},0)`).join('');
    const halves = [`${a}/split(0)`, `${a}/split(1)`, b];
    const copied: CadBodyState = { key: key('box'), kind: 'solid', createdBy: 'box', modifiedBy: ['split', 'round', 'more', 'across', 'bridge', 'down'],
      pieces: [copy(bridge, 0), ...halves.map(part => copy(part, 1, 0)), copy(bridge, 1), ...halves.map(part => copy(part, 1, 1))].map(key), orders: [{ keys: [a, b].map(key) }] };
    const resolved = (part: string, state = copied) => resolveCadBodyRef({ kind: 'body', key: key(part) }, holding(state));
    expect(resolved(copy(a, 1, 0))).toMatchObject({ status: 'ambiguous', candidates: [copy(b, 1, 0)] });
    expect(resolved(copy(a, 1, 1))).toMatchObject({ status: 'ambiguous', candidates: [copy(b, 1, 1)] });
    // Had b been split, its halves would have been copied as a's were.
    expect(resolved(copy(`${b}/split(1)`, 1, 1))).toMatchObject({ status: 'ambiguous', candidates: [copy(`${a}/split(1)`, 1, 1)] });
    // In every order, a's first copy was copied again and its original merged into the bridge.
    expect(resolved(copy(a, 1))).toEqual({ status: 'missing' });
    expect(resolved(copy(a, 0))).toEqual({ status: 'missing' });
    // Nothing the bridge made was ever split, in any order, and no order renumbers it.
    expect(resolved(`${copy(bridge, 1)}/split(0)`)).toEqual({ status: 'missing' });
    expect(resolved(copy(bridge, 1))).toMatchObject({ status: 'resolved', part: copy(bridge, 1) });
    // A copy is never another copy in another order, but the split above it may be: a's copy split as b's copy did.
    const [p, q] = ['box/split(0)', 'box/split(1)'];
    const split: CadBodyState = { key: key('box'), kind: 'solid', createdBy: 'box', modifiedBy: ['slot', 'row', 'cut'],
      pieces: [copy(p, 0), copy(q, 0), copy(p, 1), `${copy(q, 1)}/split(0)`, `${copy(q, 1)}/split(1)`].map(key), orders: [{ keys: [p, q].map(key) }] };
    expect(resolved(`${copy(p, 1)}/split(1)`, split)).toMatchObject({ status: 'ambiguous', candidates: [`${copy(q, 1)}/split(1)`] });
    expect(resolved(`${copy(p, 0)}/split(0)`, split)).toEqual({ status: 'missing' });
    // Nor once both copies share a group: only the first copy was split.
    const joined: CadBodyState = { key: key('box'), kind: 'solid', createdBy: 'box', modifiedBy: ['row', 'cut', 'bridge'],
      pieces: [`${copy(p, 0)}/split(0)`, `${copy(p, 0)}/split(1)`, copy(p, 1)].map(key), ambiguous: [[`${copy(p, 0)}/split(0)`, `${copy(p, 0)}/split(1)`, copy(p, 1), copy(p, 0)].map(key)] };
    expect(resolved(`${copy(p, 1)}/split(0)`, joined)).toEqual({ status: 'missing' });
  });

  it('trades keys only at splits an order records, never at a later split that continues a traded key', () => {
    // A fillet keyed two halves a and b in the kernel's order. A cut split b in two by its faces and another cut split b's first half. In
    // the other order a is that solid, so a's keys name b's pieces; but b's faces ordered its halves, so no order gives its second half's
    // key the pieces its first half split into.
    const [a, b] = ['round/split(0)', 'round/split(1)'];
    const pieces = [a, `${b}/split(0)/split(0)`, `${b}/split(0)/split(1)`, `${b}/split(1)`];
    const cut: CadBodyState = { key: key('box'), kind: 'solid', createdBy: 'box', modifiedBy: ['split', 'round', 'more', 'again'], pieces: pieces.map(key),
      orders: [{ keys: [a, b].map(key) }] };
    const resolved = (part: string, state = cut) => resolveCadBodyRef({ kind: 'body', key: key(part) }, holding(state));
    expect(resolved(`${b}/split(1)/split(0)`)).toEqual({ status: 'missing' });
    expect(resolved(`${a}/split(1)/split(0)`)).toEqual({ status: 'missing' });
    // Keys that follow b's solid in the other order, where it is a's, name the pieces it split into.
    for (const [part, piece] of [[`${a}/split(0)/split(0)`, pieces[1]], [`${a}/split(0)/split(1)`, pieces[2]], [`${a}/split(1)`, pieces[3]]])
      expect(resolved(part), part).toMatchObject({ status: 'ambiguous', candidates: [piece] });
    // Had b's halves tied, either half's key would name the pieces of the other, at one split or at both.
    const tied = { ...cut, orders: [[a, b], [`${b}/split(0)`, `${b}/split(1)`]].map(keys => ({ keys: keys.map(key) })) };
    expect(resolved(`${b}/split(1)/split(0)`, tied)).toMatchObject({ status: 'ambiguous', candidates: [pieces[1]] });
    expect(resolved(`${a}/split(1)/split(1)`, tied)).toMatchObject({ status: 'ambiguous', candidates: [pieces[2]] });
  });

  it('resolves an ambiguous key only among the keys it can\'t be told apart from, never another pattern occurrence\'s', () => {
    const part = (k: number, i: number) => key(`box/split(${k})/inst(${i},0)`);
    const copied: CadBodyState = { key: key('box'), kind: 'solid', createdBy: 'box', modifiedBy: ['slot', 'row'], pieces: [part(0, 0), part(1, 0), part(0, 1), part(1, 1)],
      ambiguous: [[part(0, 0), part(1, 0)], [part(0, 1), part(1, 1), key('box/split(2)/inst(1,0)')]] };
    expect(resolveCadBodyRef({ kind: 'body', key: part(0, 0) }, holding(copied))).toMatchObject({ status: 'ambiguous', candidates: [part(0, 0), part(1, 0)] });
    expect(resolveCadBodyRef({ kind: 'body', key: key('box/split(2)/inst(1,0)') }, holding(copied))).toMatchObject({ status: 'ambiguous', candidates: [part(0, 1), part(1, 1)] });
  });

  it('names a body after its creating feature until metadata is stored, and lists orphaned metadata', () => {
    const body = lineage.bodies()[0];
    expect(resolveCadBodyMetadata(body, id => `${id} name`)).toEqual({ name: 'box name', role: 'part' });
    const stored = new Map([[key('box'), { name: 'Stock', role: 'stock' as const, appearance: { color: '#336699' } }], [key('gone'), { name: 'Gone', role: 'part' as const }]]);
    expect(resolveCadBodyMetadata(body, () => undefined, stored)).toEqual({ name: 'Stock', role: 'stock', appearance: { color: '#336699' } });
    expect(cadBodyMetadataOrphans(stored, lineage)).toEqual(['gone']);
  });

  it('selects the body a selected feature leads to, wherever it is in the history, before the latest drawn body', () => {
    const two = lineageOf([...box, { ...base('round'), kind: 'fillet', targetId: 'box', radius: 1 }, ...peg]);
    expect(cadSelectedBody(two, 'box', ['round', 'peg'])?.key).toBe('box');
    expect(cadSelectedBody(two, 'round', ['round', 'peg'])?.key).toBe('box');
    expect(cadSelectedBody(two, 'box_sketch', ['round', 'peg'])?.key).toBe('peg');
    expect(cadSelectedBody(two, null, ['round', 'peg'])?.key).toBe('peg');
    expect(cadSelectedBody(two, 'box', ['peg'])?.key).toBe('peg');
    expect(cadSelectedBody(two, null, ['round', 'peg'], key('peg'))?.key).toBe('box');
    expect(cadSelectedBody(two, 'peg', [])).toBeUndefined();
  });

  it('checks body states and issues received across the worker boundary', () => {
    for (const body of [...lineage.bodies(), ...lineage.consumed(), split]) expect(isCadBodyState(JSON.parse(JSON.stringify(body)))).toBe(true);
    expect(isCadBodyState({ ...split, createdBy: 'other' })).toBe(false);
    expect(isCadBodyState({ ...split, kind: 'mesh' })).toBe(false);
    // Parts are made by the body's creator or a modifier, and never repeat the body's own key.
    expect(isCadBodyState({ ...split, pieces: ['peg/split(0)'] })).toBe(false);
    expect(isCadBodyState({ ...split, ambiguous: [['box']] })).toBe(false);
    // Ambiguous keys come in groups, each key once, and a piece is listed once.
    expect(isCadBodyState({ ...split, ambiguous: ['round/split(0)'] })).toBe(false);
    expect(isCadBodyState({ ...split, ambiguous: [[]] })).toBe(false);
    expect(isCadBodyState({ ...split, ambiguous: [['round/split(0)'], ['round/split(0)', 'box/split(1)']] })).toBe(false);
    expect(isCadBodyState({ ...split, pieces: ['box/split(0)', 'box/split(0)'] })).toBe(false);
    // An order numbers two or more siblings, with consecutive split indices in order, and no key is in two orders.
    const pair = ['box/split(0)', 'box/split(1)'];
    for (const keys of [pair, ['round/split(4)', 'round/split(5)', 'round/split(6)']]) expect(isCadBodyState({ ...split, orders: [{ keys }] }), keys.join()).toBe(true);
    for (const keys of [['box/split(0)'], ['box/split(0)', 'round/split(1)'], ['box/split(0)/inst(1,0)', 'box/split(1)/inst(1,0)'], ['box/split(0)', 'box/split(0)/split(1)'],
      ['box/split(0)', 'box/split(2)'], ['box/split(1)', 'box/split(0)']])
      expect(isCadBodyState({ ...split, orders: [{ keys }] }), keys.join()).toBe(false);
    expect(isCadBodyState({ ...split, orders: [{ keys: pair }, { keys: ['box/split(1)', 'box/split(2)'] }] })).toBe(false);
    for (const orders of ['x', [pair], [{}], [null]]) expect(isCadBodyState({ ...split, orders }), JSON.stringify(orders)).toBe(false);
    // What places each piece: pairs of whole numbers per piece, solids ascending, within the shared solid limit.
    expect(isCadBodyState({ ...split, orders: [{ keys: pair, by: [[0, 0], [0, 1, 1, 0]] }] })).toBe(true);
    const shared = (n: number) => Array.from({ length: n }, (_, k) => [2 * k, 0, 2 * k + 1, 0]);
    expect(isCadBodyState({ ...split, orders: [{ keys: ['round/split(0)', 'round/split(1)', 'round/split(2)', 'round/split(3)', 'round/split(4)'], by: shared(5) }] })).toBe(true);
    for (const by of [[[0, 0]], [[0, 0], []], [[0, 0], [1]], [[0, 0], [-1, 0]], [[0, 0], [0, 0.5]], [[0, 0], [1, 0, 0, 0]], [[0, 0], [0, 0, 0, 1]], [[0, 0], Array(22).fill(0).map((_, k) => k)], 'x'])
      expect(isCadBodyState({ ...split, orders: [{ keys: pair, by }] }), JSON.stringify(by)).toBe(false);
    expect(isCadBodyState({ ...split, orders: [{ keys: Array.from({ length: 6 }, (_, k) => `round/split(${k})`), by: shared(6) }] })).toBe(false);
    expect(isCadBodyState({ ...split, modifiedBy: ['bad id'] })).toBe(false);
    expect(isCadBodyState({ ...split, untracked: true })).toBe(false);
    expect(isCadBodyState({ key: 'box', kind: 'solid', createdBy: 'box', modifiedBy: [], untracked: true })).toBe(true);
    // A history may modify a body any number of times.
    expect(isCadBodyState({ ...split, modifiedBy: Array.from({ length: MAX_CAD_BODY_LIST + 1 }, (_, index) => `f${index}`).concat('slot', 'round') })).toBe(true);
    const issue = { code: 'lost-body-parts', featureId: 'slot', body: 'box', pieces: ['peg/split(0)'], message: 'x' };
    expect(isCadBodyIssue(issue)).toBe(true);
    expect(isCadBodyIssue({ ...issue, code: 'ambiguous-split-order' })).toBe(false);
    expect(isCadBodyIssue({ ...issue, pieces: ['bad key'] })).toBe(false);
    expect(isCadBodyIssue({ ...issue, message: 'x'.repeat(8193) })).toBe(false);
  });
});
