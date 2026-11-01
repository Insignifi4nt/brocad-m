// Rebuilds scripts/unit-test-shard-weights.json from the Vitest JSON reports of every unit shard of one or more review runs
// (the unit-test-timings-* artifacts); a file reported more than once is averaged. Usage: tsx scripts/update-unit-test-shard-weights.ts <report.json>...
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  parseUnitShardWeights, reportCheckoutRoot, unitShardWeightsFromReports, unitShardWeightsPath, type VitestJsonReport
} from './unit-test-shards';

const files = process.argv.slice(2);
if (!files.length) throw new Error('Pass the JSON report of every unit shard of one or more runs.');
const checkout = process.cwd();
const target = path.join(checkout, unitShardWeightsPath);
const { overheadSeconds } = parseUnitShardWeights(readFileSync(target, 'utf8'));
const reports = files.map((file) => JSON.parse(readFileSync(file, 'utf8')) as VitestJsonReport);
const isFile = (relativePath: string) => statSync(path.join(checkout, relativePath), { throwIfNoEntry: false })?.isFile() ?? false;
const root = reportCheckoutRoot(reports.flatMap((report) => report.testResults.map(({ name }) => name)), isFile);
const weights = unitShardWeightsFromReports(reports, root, overheadSeconds);
writeFileSync(target, `${JSON.stringify(weights, null, 2)}\n`);
console.log(`Wrote ${Object.keys(weights.seconds).length} measured files to ${unitShardWeightsPath}.`);
