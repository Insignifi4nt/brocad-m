// Records the relation remap parity fixture that src/domain/cad/__tests__/cadSketchRelationRemapParity.test.ts replays: what trim,
// extend, split, mirror, offset, profile copy and the linear pattern's reconcile did to relations, for every call the Vitest suite made,
// before one remap rule replaced their own relation handling. Record it only on the source commit the manifest names.
//
// Steps, from that commit's root:
//   git apply scripts/record-sketch-relation-remap-parity.capture.patch
//   WIREEDM_CAPTURE_REMAP_PARITY=<dir> node node_modules/vitest/vitest.mjs --run
//   git checkout -- src && git clean -f src/domain/cad/cadSketchRemapParityCapture.ts
//   node scripts/record-sketch-relation-remap-parity.mjs --capture <dir> --commit <sha>
// Each call is kept once, by its operation and input; calls whose input has more than 300 relations are not captured.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const args = process.argv.slice(2), option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const capture = option('--capture'), commit = option('--commit');
if (!capture || !commit) throw new Error('Give --capture <dir> and --commit <sha>.');
const fixture = new URL('../src/domain/cad/__tests__/fixtures/relation-remap-parity.json.gz', import.meta.url);
const manifest = new URL('../src/domain/cad/__tests__/fixtures/relation-remap-parity.manifest.json', import.meta.url);
const records = new Map();
for (const file of readdirSync(capture).filter(name => name.endsWith('.jsonl')).sort())
  for (const line of readFileSync(`${capture}/${file}`, 'utf8').split('\n')) if (line) {
    const record = JSON.parse(line);
    if (!records.has(record.hash)) records.set(record.hash, { operation: record.operation, input: record.input, outcome: record.outcome });
  }
const sorted = [...records.entries()].sort(([a, x], [b, y]) => x.operation < y.operation ? -1 : x.operation > y.operation ? 1 : a < b ? -1 : a > b ? 1 : 0).map(([, record]) => record);
const text = JSON.stringify({ format: 1, records: sorted }), bytes = gzipSync(text, { level: 9 });
writeFileSync(fileURLToPath(fixture), bytes);
const counts = {};
for (const record of sorted) counts[record.operation] = (counts[record.operation] ?? 0) + 1;
const sha256 = value => createHash('sha256').update(value).digest('hex');
writeFileSync(fileURLToPath(manifest), JSON.stringify({ sourceCommit: commit, records: sorted.length, operations: counts,
  jsonBytes: Buffer.byteLength(text), gzipBytes: bytes.length, jsonSha256: sha256(text), gzipSha256: sha256(bytes),
  steps: 'See scripts/record-sketch-relation-remap-parity.mjs.' }, null, 2) + '\n');
console.log(sorted.length, counts, bytes.length);
