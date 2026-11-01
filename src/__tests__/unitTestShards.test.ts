import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TestSpecification, Vitest } from 'vitest/node';
import {
  assignShards, parseUnitShardWeights, reportCheckoutRoot, unitShardWeight, unitShardWeightsFromReports, unitShardWeightsPath, WeightedShardSequencer,
  type ShardItem
} from '../../scripts/unit-test-shards';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

/** A deterministic spread of weights with a heavy tail, like the unit suite's files. */
function items(count: number, seed = 7): ShardItem[] {
  let state = seed;
  const next = () => { state = (state * 1_103_515_245 + 12_345) % 2_147_483_648; return state / 2_147_483_648; };
  return Array.from({ length: count }, (_, index) => ({ key: `src/file-${String(index).padStart(3, '0')}.test.ts`, weight: Math.round(next() ** 4 * 600) / 10 }));
}

async function weightRoot(seconds: Record<string, number>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wire-edm-shards-'));
  roots.push(root);
  await mkdir(path.join(root, 'scripts'));
  await writeFile(path.join(root, unitShardWeightsPath), JSON.stringify({ overheadSeconds: 0.5, unlistedSeconds: 0.1, seconds }));
  return root;
}

function spec(root: string, file: string, project: string, groupOrder = 0) {
  return { moduleId: path.join(root, file), pool: 'forks', project: { name: project, config: { sequence: { groupOrder }, isolate: true } } } as unknown as TestSpecification;
}

function sequencer(root: string, index: number) {
  return new WeightedShardSequencer({ config: { root, shard: { index, count: 3 } } } as unknown as Vitest);
}

function loads(entries: readonly ShardItem[], shards: readonly number[], count: number) {
  const totals = new Array<number>(count).fill(0);
  shards.forEach((shard, index) => { totals[shard] += entries[index].weight; });
  return totals;
}

describe('weighted unit shards', () => {
  it('puts every file in exactly one shard and gives each shard work', () => {
    for (const count of [1, 2, 3, 4, 7]) {
      const entries = items(631);
      const shards = assignShards(entries, count);
      expect(shards).toHaveLength(entries.length);
      expect(shards.every((shard) => Number.isInteger(shard) && shard >= 0 && shard < count)).toBe(true);
      expect(new Set(shards).size).toBe(count);
    }
  });

  it('computes the same split whatever order the files arrive in, so separate shard processes agree', () => {
    const entries = items(200, 11);
    const split = new Map(entries.map((entry, index) => [entry.key, assignShards(entries, 4)[index]]));
    const reversed = [...entries].reverse();
    const shuffled = [...entries].sort((a, b) => (a.key.split('').reverse().join('') < b.key.split('').reverse().join('') ? -1 : 1));
    for (const order of [reversed, shuffled]) {
      const shards = assignShards(order, 4);
      order.forEach((entry, index) => expect(shards[index]).toBe(split.get(entry.key)));
    }
  });

  it('orders equal weights by key, not by arrival', () => {
    const entries = [{ key: 'b', weight: 1 }, { key: 'a', weight: 1 }, { key: 'c', weight: 1 }];
    expect(assignShards(entries, 2)).toEqual([1, 0, 0]);
  });

  it('keeps the slowest shard within 2% of the average unless one file outweighs that', () => {
    const entries = items(631, 3);
    for (const count of [3, 4]) {
      const totals = loads(entries, assignShards(entries, count), count);
      const mean = totals.reduce((sum, value) => sum + value, 0) / count;
      const heaviest = Math.max(...entries.map((entry) => entry.weight));
      expect(Math.max(...totals)).toBeLessThanOrEqual(Math.max(mean * 1.02, heaviest));
    }
  });

  it('places the heaviest file alone when it outweighs everything else', () => {
    const entries = [{ key: 'slow', weight: 100 }, ...Array.from({ length: 6 }, (_, index) => ({ key: `fast-${index}`, weight: 5 }))];
    const shards = assignShards(entries, 2);
    expect(shards[0]).toBe(0);
    expect(shards.slice(1).every((shard) => shard === 1)).toBe(true);
  });

  it('rejects a shard count that is not a positive integer', () => {
    expect(() => assignShards(items(3), 0)).toThrow(/positive integer/);
    expect(() => assignShards(items(3), 1.5)).toThrow(/positive integer/);
  });

  it('weighs a file by its measured time or the unlisted time, plus the per-file setup', () => {
    const weights = { overheadSeconds: 0.6, unlistedSeconds: 0.1, seconds: { 'src/slow.test.ts': 30 } };
    expect(unitShardWeight(weights, 'src/slow.test.ts')).toBeCloseTo(30.6);
    expect(unitShardWeight(weights, 'src/new.test.ts')).toBeCloseTo(0.7);
    expect(unitShardWeight(weights, 'constructor')).toBeCloseTo(0.7);
  });

  it('rejects a table without finite, non-negative times', () => {
    expect(() => parseUnitShardWeights('{"overheadSeconds":0.6,"unlistedSeconds":0.1,"seconds":{"a":-1}}')).toThrow(/non-negative/);
    expect(() => parseUnitShardWeights('{"overheadSeconds":0.6,"seconds":{}}')).toThrow(/non-negative/);
    expect(() => parseUnitShardWeights('{"overheadSeconds":"0.6","unlistedSeconds":0.1,"seconds":{}}')).toThrow(/non-negative/);
  });

  it('reads the committed table', async () => {
    const weights = parseUnitShardWeights(await readFile(path.join(process.cwd(), unitShardWeightsPath), 'utf8'));
    expect(Object.keys(weights.seconds).length).toBeGreaterThan(0);
  });

  it('builds the table from shard reports, averaging repeated files and listing only the slow ones', () => {
    const root = '/home/runner/work/wire-edm/wire-edm';
    const report = (name: string, seconds: number) => ({ name: `${root}/${name}`, startTime: 1_000, endTime: 1_000 + seconds * 1000 });
    const weights = unitShardWeightsFromReports([
      { testResults: [report('src/b.test.ts', 4), report('src/fast-1.test.ts', 0.1)] },
      { testResults: [report('src/b.test.ts', 6), report('src/a.test.ts', 0.5), report('src/fast-2.test.ts', 0.3)] },
    ], root, 0.6);
    expect(weights).toEqual({ overheadSeconds: 0.6, unlistedSeconds: 0.2, seconds: { 'src/a.test.ts': 0.5, 'src/b.test.ts': 5 } });
    expect(Object.keys(weights.seconds)).toEqual(['src/a.test.ts', 'src/b.test.ts']);
    expect(() => unitShardWeightsFromReports([{ testResults: [{ name: '/elsewhere/src/a.test.ts', startTime: 0, endTime: 1 }] }], root, 0.6))
      .toThrow(/not under/);
  });

  it('finds the runner checkout a report was written in, whatever the local checkout and separators', () => {
    const here = new Set(['src/a.test.ts', 'packages/icons-react/src/b.test.ts']);
    const isFile = (relativePath: string) => here.has(relativePath);
    expect(reportCheckoutRoot(['/home/runner/work/repo/repo/src/gone.test.ts', '/home/runner/work/repo/repo/src/a.test.ts'], isFile))
      .toBe('/home/runner/work/repo/repo');
    expect(reportCheckoutRoot(['D:\\a\\repo\\packages\\icons-react\\src\\b.test.ts'], isFile)).toBe('D:/a/repo');
    expect(() => reportCheckoutRoot(['/home/runner/work/repo/repo/src/gone.test.ts'], isFile)).toThrow(/checkout/);
  });

  it('gives Vitest disjoint shards covering every file', async () => {
    const root = await weightRoot({ 'src/slow.test.ts': 40, 'src/medium.test.ts': 12, 'src/other.test.ts': 9 });
    const files = ['src/slow.test.ts', 'src/medium.test.ts', 'src/other.test.ts', ...Array.from({ length: 30 }, (_, index) => `src/fast-${index}.test.ts`)];
    const specs = files.map((file, index) => spec(root, file, index % 2 ? 'browser' : 'pure-domain'));
    const ids = (shard: readonly TestSpecification[]) => shard.map((entry) => entry.moduleId).sort();
    const shards = await Promise.all([1, 2, 3].map((index) => sequencer(root, index).shard([...specs])));
    expect(ids(shards.flat())).toEqual(ids(specs));
    expect(shards.map((shard) => shard.some((entry) => entry.moduleId.endsWith('slow.test.ts')))).toEqual([true, false, false]);
    expect(ids(await sequencer(root, 2).shard([...specs].reverse()))).toEqual(ids(shards[1]));
  });

  it('runs a shard project by project as Vitest does, heaviest first within each', async () => {
    const root = await weightRoot({ 'src/node-slow.test.ts': 30, 'src/dom-medium.test.ts': 12, 'src/dom-slow.test.ts': 20 });
    const specs = [
      spec(root, 'src/node-slow.test.ts', 'pure-domain'), spec(root, 'src/node-fast.test.ts', 'pure-domain'),
      spec(root, 'src/dom-fast.test.ts', 'browser'), spec(root, 'src/dom-medium.test.ts', 'browser'), spec(root, 'src/dom-slow.test.ts', 'browser'),
      spec(root, 'src/late.test.ts', 'browser', 1),
    ];
    const ordered = await sequencer(root, 1).sort([...specs].reverse());
    expect(ordered.map((entry) => path.basename(entry.moduleId))).toEqual([
      'dom-slow.test.ts', 'dom-medium.test.ts', 'dom-fast.test.ts', 'node-slow.test.ts', 'node-fast.test.ts', 'late.test.ts'
    ]);
  });
});
