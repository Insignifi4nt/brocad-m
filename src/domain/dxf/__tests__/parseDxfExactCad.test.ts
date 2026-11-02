// @vitest-environment node
import { expect, it } from 'vitest';
import { parseDxf } from '../parseDxf';
import { importCadDxfSketch } from '@/domain/cad/cadDxfImport';
import { cadSketchProfileViews } from '@/domain/cad/sketch-generators/cadSketchProfileViews';

const line = '0\nLINE\n10\n0\n20\n0\n11\n1\n21\n0\n';
const block = (name: string, contents: string) => `0\nBLOCK\n2\n${name}\n10\n0\n20\n0\n${contents}0\nENDBLK\n`;
const insert = (name: string, count = '1') => `0\nINSERT\n2\n${name}\n70\n${count}\n44\n2\n`;
const drawing = (contents: string, blocks = '') => `0\nSECTION\n2\nBLOCKS\n${blocks}0\nENDSEC\n0\nSECTION\n2\nENTITIES\n${contents}0\nENDSEC\n0\nEOF\n`;

it('retains all actual array entities and provenance past CAM policy ceilings while retaining CAM defaults', () => {
  const text = drawing(insert('B', '20001'), block('B', line));
  expect(() => parseDxf(text)).toThrow(expect.objectContaining({ resource: 'insertInstances' }));
  const exact = parseDxf(text, { mode: 'exact-cad' });
  expect(exact.entities).toHaveLength(20001); expect(exact.warnings).toEqual([]);
  expect(exact.entities.at(-1)).toMatchObject({ type: 'line', start: { x: 40000, y: 0 }, end: { x: 40001, y: 0 },
    source: { insertChain: [{ blockName: 'B', column: 20000 }] } });
  expect(() => parseDxf(drawing(insert('B', '9007199254740992'), block('B', line)), { mode: 'exact-cad' })).toThrow('safe integer');
});

it('keeps exact long metadata and deep block placement, but still rejects circular block references', () => {
  const layer = 'Layer'.repeat(1000), depth = 33;
  const blocks = block('B0', line + `8\n${layer}\n`) + Array.from({ length: depth }, (_, index) => block(`B${index + 1}`, insert(`B${index}`))).join('');
  const text = drawing(insert(`B${depth}`), blocks);
  expect(() => parseDxf(text)).toThrow(expect.objectContaining({ resource: 'metadataCharacters' }));
  expect(() => parseDxf(text.replace(layer, 'CUT'))).toThrow(expect.objectContaining({ resource: 'insertDepth' }));
  const exact = parseDxf(text, { mode: 'exact-cad' });
  expect(exact.entities).toHaveLength(1); expect(exact.entities[0]).toMatchObject({ layer, start: { x: 0, y: 0 }, end: { x: 1, y: 0 } });
  expect(exact.warnings).toEqual([]);
  expect(() => importCadDxfSketch({ fileName: 'cycle.dxf', units: 'mm', text: drawing(insert('B'), block('B', insert('B'))) })).toThrow('unsupported');
});

it('skips unsupported spline approximation work in exact CAD and refuses a partial imported sketch', () => {
  const degree = 17, count = 18, knots = [...Array<number>(18).fill(0), ...Array<number>(18).fill(1)];
  const spline = `0\nSPLINE\n70\n8\n71\n${degree}\n72\n${knots.length}\n73\n${count}\n`
    + knots.map(knot => `40\n${knot}\n`).join('') + Array.from({ length: count }, (_, index) => `10\n${index}\n20\n${index % 2}\n`).join('');
  const text = drawing('0\nCIRCLE\n10\n0\n20\n0\n40\n2\n' + spline);
  expect(() => parseDxf(text)).toThrow(expect.objectContaining({ resource: 'splineDegree' }));
  const exact = parseDxf(text, { mode: 'exact-cad' });
  expect(exact.entities).toHaveLength(1); expect(exact.unsupportedEntities).toEqual(['SPLINE']);
  expect(() => importCadDxfSketch({ fileName: 'spline.dxf', units: 'mm', text })).toThrow('unsupported');
});

it('resolves a deep acyclic block chain without recursion while preserving every placement and exact CAD source', () => {
  const depth = 2048, translatedInsert = (name: string) => insert(name) + '10\n1\n20\n-1\n';
  const circle = '0\nCIRCLE\n10\n2\n20\n3\n40\n2\n';
  const blocks = block('B0', circle) + Array.from({ length: depth }, (_, index) => block(`B${index + 1}`, translatedInsert(`B${index}`))).join('');
  const text = drawing(translatedInsert(`B${depth}`), blocks), parsed = parseDxf(text, { mode: 'exact-cad' });
  expect(parsed.entities).toHaveLength(1); expect(parsed.warnings).toEqual([]); expect(parsed.unsupportedEntities).toEqual([]);
  expect(parsed.entities[0]).toMatchObject({ type: 'circle', center: { x: 2 + depth + 1, y: 3 - depth - 1 }, radius: 2 });
  const chain = parsed.entities[0].source?.insertChain;
  expect(chain).toHaveLength(depth + 1); expect(chain?.every((entry, index) => entry.blockName === `B${depth - index}`)).toBe(true);
  const imported = importCadDxfSketch({ fileName: 'deep-circle.dxf', units: 'mm', text });
  expect(imported.sketch.source?.text).toBe(text); expect(cadSketchProfileViews(imported.sketch)).toHaveLength(1);
  expect(cadSketchProfileViews(imported.sketch)[0].geometry).toEqual({ kind: 'circle', x: 2 + depth + 1, y: 3 - depth - 1, radius: 2 });
  expect(() => parseDxf(text)).toThrow(expect.objectContaining({ resource: 'insertDepth' }));
}, 15_000);

it('keeps deep cyclic and malformed block sources explicit failures without importing partial material', () => {
  const depth = 2048, blocks = Array.from({ length: depth }, (_, index) => block(`B${index + 1}`, insert(`B${index}`))).join('');
  const circle = '0\nCIRCLE\n10\n0\n20\n0\n40\n2\n';
  const cycle = drawing(insert(`B${depth}`), block('B0', circle + insert(`B${depth}`)) + blocks);
  const malformed = drawing(insert(`B${depth}`), block('B0', circle).replace('10\n0\n', '10\nbad\n') + blocks);
  const parsed = parseDxf(cycle, { mode: 'exact-cad' });
  expect(parsed.unsupportedEntities).toContain('INSERT'); expect(parsed.warnings).toContain(`Skipped circular INSERT reference for BLOCK "B${depth}".`);
  for (const text of [cycle, malformed]) expect(() => importCadDxfSketch({ fileName: 'invalid-deep.dxf', units: 'mm', text })).toThrow(expect.objectContaining({ code: 'dxf-inexact' }));
}, 15_000);
