import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

/**
 * Measured test seconds per file, kept in `scripts/unit-test-shard-weights.json`. Stale or missing entries only
 * make the shards less even: every file is still assigned to exactly one shard.
 */
export interface UnitShardWeights {
  /** Environment, import and setup time that every file adds to its own test time. */
  readonly overheadSeconds: number;
  /** Test time assumed for a file the table does not list (new files and the many fast ones). */
  readonly unlistedSeconds: number;
  /** Test seconds by root-relative POSIX path. */
  readonly seconds: Readonly<Record<string, number>>;
}

export interface ShardItem {
  /** Unique and stable across processes: it orders equal weights. */
  readonly key: string;
  readonly weight: number;
}

export const unitShardWeightsPath = 'scripts/unit-test-shard-weights.json';
/** Files measured below this are left out of the table and use its unlisted time. */
export const unitShardListedSeconds = 0.5;

/**
 * Assigns every item to one of `count` shards: heaviest first, each onto the lightest shard so far (equal loads go to
 * the lower shard). The split depends only on the keys and weights, never on input order, so each shard's process
 * computes the same split independently. Returns each item's zero-based shard, in input order.
 */
export function assignShards(items: readonly ShardItem[], count: number): number[] {
  if (!Number.isInteger(count) || count < 1) throw new Error(`Shard count must be a positive integer, not ${count}.`);
  const order = items.map((_, index) => index).sort((a, b) => items[b].weight - items[a].weight
    || (items[a].key < items[b].key ? -1 : items[a].key > items[b].key ? 1 : 0));
  const loads = new Array<number>(count).fill(0);
  const shards = new Array<number>(items.length);
  for (const index of order) {
    let lightest = 0;
    for (let shard = 1; shard < count; shard++) if (loads[shard] < loads[lightest]) lightest = shard;
    shards[index] = lightest;
    loads[lightest] += items[index].weight;
  }
  return shards;
}

export function unitShardWeight(weights: UnitShardWeights, file: string): number {
  return weights.overheadSeconds + (Object.hasOwn(weights.seconds, file) ? weights.seconds[file] : weights.unlistedSeconds);
}

export function parseUnitShardWeights(text: string): UnitShardWeights {
  const value = JSON.parse(text) as Partial<UnitShardWeights>;
  const finite = (entry: unknown) => typeof entry === 'number' && Number.isFinite(entry) && entry >= 0;
  if (!finite(value.overheadSeconds) || !finite(value.unlistedSeconds) || typeof value.seconds !== 'object' || value.seconds === null
    || !Object.values(value.seconds).every(finite)) throw new Error(`${unitShardWeightsPath} must give non-negative overheadSeconds, unlistedSeconds and seconds.`);
  return value as UnitShardWeights;
}

/** A Vitest JSON report's per-file timing, as `--reporter=json` writes it. */
export interface VitestJsonReport {
  readonly testResults: readonly { readonly name: string; readonly startTime: number; readonly endTime: number }[];
}

/**
 * Finds the checkout directory a run's reports were written in: the absolute name of the first reported file whose
 * tail is a file in this checkout, without that tail. Reports name files absolutely, on the runner's file system.
 */
export function reportCheckoutRoot(names: readonly string[], isFile: (relativePath: string) => boolean): string {
  for (const name of names) {
    const parts = toPosix(name).split('/');
    for (let index = 1; index < parts.length; index++) if (isFile(parts.slice(index).join('/'))) return parts.slice(0, index).join('/');
  }
  throw new Error('None of the reported test files is in this checkout.');
}

/**
 * Builds the weight table from JSON reports of every shard of one or more runs, whose files are named under `root`. A file
 * reported more than once is averaged. The per-file overhead is not in the reports, so it is kept from the current table.
 */
export function unitShardWeightsFromReports(reports: readonly VitestJsonReport[], root: string, overheadSeconds: number): UnitShardWeights {
  const prefix = `${toPosix(root).replace(/\/$/, '')}/`;
  const runs = new Map<string, number[]>();
  for (const report of reports) for (const result of report.testResults) {
    const name = toPosix(result.name);
    if (!name.startsWith(prefix)) throw new Error(`${result.name} is not under ${root}.`);
    const file = name.slice(prefix.length);
    runs.set(file, [...runs.get(file) ?? [], Math.max(0, result.endTime - result.startTime) / 1000]);
  }
  const means = [...runs].map(([file, seconds]) => [file, seconds.reduce((sum, value) => sum + value, 0) / seconds.length] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const unlisted = means.filter(([, seconds]) => seconds < unitShardListedSeconds);
  return {
    overheadSeconds,
    unlistedSeconds: round(unlisted.reduce((sum, [, seconds]) => sum + seconds, 0) / Math.max(1, unlisted.length), 2),
    seconds: Object.fromEntries(means.filter(([, seconds]) => seconds >= unitShardListedSeconds).map(([file, seconds]) => [file, round(seconds, 1)])),
  };
}

/** Vitest sequencer that shards by measured weight instead of by path hash, so no shard holds most of the slow files. */
export class WeightedShardSequencer extends BaseSequencer {
  private weights: UnitShardWeights | undefined;

  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { index, count } = this.ctx.config.shard!;
    const shards = assignShards(files.map((spec) => ({ key: this.key(spec), weight: this.weight(spec) })), count);
    return files.filter((_, position) => shards[position] === index - 1);
  }

  /**
   * Keeps Vitest's own grouping (group order, then project, isolated files first), so the Node-only suites and their
   * timing checks still run after the jsdom and kernel suites rather than beside them. Within each group the heaviest
   * files start first, so none of them is left running alone at the end.
   */
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    if (!this.ctx.config.shard) return super.sort(files);
    const keyed = files.map((spec) => ({ spec, key: this.key(spec), weight: this.weight(spec) }));
    keyed.sort((a, b) => compareGroups(a.spec, b.spec) || b.weight - a.weight || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return keyed.map(({ spec }) => spec);
  }

  private key(spec: TestSpecification) {
    return `${spec.project.name}\0${spec.pool}\0${relativePosix(this.ctx.config.root, spec.moduleId)}`;
  }

  private weight(spec: TestSpecification) {
    this.weights ??= parseUnitShardWeights(readFileSync(path.join(this.ctx.config.root, unitShardWeightsPath), 'utf8'));
    return unitShardWeight(this.weights, relativePosix(this.ctx.config.root, spec.moduleId));
  }
}

/** The order Vitest's own sequencer gives files from different groups and projects. */
function compareGroups(a: TestSpecification, b: TestSpecification) {
  return a.project.config.sequence.groupOrder - b.project.config.sequence.groupOrder
    || (a.project.name < b.project.name ? -1 : a.project.name > b.project.name ? 1 : 0)
    || Number(!a.project.config.isolate) - Number(!b.project.config.isolate);
}

function relativePosix(root: string, file: string) {
  return path.relative(root, file).split(path.sep).join('/');
}

function toPosix(file: string) {
  return file.replaceAll('\\', '/');
}

function round(value: number, digits: number) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
