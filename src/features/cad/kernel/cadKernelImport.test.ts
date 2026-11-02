// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import initOpenCascade from 'replicad-opencascadejs';
import { exportSTEP, getOC, makeBox, makeCompound, makePolygon, setOC } from 'replicad';
import { cadBytesToBase64, isCadSolidImportResult, type CadSolidImportSource } from '../../../domain/cad/cadImports';
import type { CadDocument, CadFeature } from '../../../domain/cad/cadDocument';
import { parseCadDocument } from '../../../domain/cad/cadSchema';
import { prepareCadSolidImport } from './cadKernelImport';
import { buildCadKernelModel } from './cadKernelModel';
import { createCadKernelRuntime } from './cadKernelRuntime';
import { isCadKernelReply } from './cadKernelProtocol';
import { assertCadStepLengthUnits } from './cadKernelStepUnits';
import { importCadDxfSketch } from '../../../domain/cad/cadDxfImport';

let step: CadSolidImportSource;
let binaryStl: CadSolidImportSource;
let asciiStl: CadSolidImportSource;
beforeAll(async () => {
  const wasmBinary = await readFile(new URL('../../../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  setOC(await initOpenCascade({ wasmBinary, print: () => undefined, printErr: () => undefined }));
  const box = makeBox([0, 0, 0], [20, 10, 5]);
  try {
    step = { format: 'step', encoding: 'utf8', fileName: 'part.step', data: await exportSTEP([{ shape: box, name: 'Part' }], { unit: 'MM', modelUnit: 'MM' }).text() };
    binaryStl = { format: 'stl', encoding: 'base64', fileName: 'part.stl', units: 'mm', data: cadBytesToBase64(new Uint8Array(await box.blobSTL({ binary: true }).arrayBuffer())) };
    asciiStl = { ...binaryStl, data: cadBytesToBase64(new Uint8Array(await box.blobSTL({ binary: false }).arrayBuffer())) };
  } finally { box.delete(); }
}, 60_000);
const base = (id: string) => ({ id, name: id, suppressed: false });
const document = (source: CadSolidImportSource, tail: readonly CadFeature[] = []): CadDocument => parseCadDocument({
  format: 'wireedm-cad', schemaVersion: 1, id: 'part', name: 'Imported part', units: 'mm', parameters: {},
  features: [{ ...base('imported'), kind: 'imported', source }, ...tail],
});

describe('original-source native solid import', () => {
  it('imports exact STEP with millimetres and preserves the source through rebuild, Boolean and export', async () => {
    const analysis = prepareCadSolidImport(step);
    expect(isCadSolidImportResult(analysis)).toBe(true);
    expect(analysis).toMatchObject({ format: 'step', representation: 'exact-brep', solidCount: 1 });
    expect(analysis.volume).toBeCloseTo(1000, 6); expect(analysis.bounds.max).toEqual([20, 10, 5]);
    const original = step.data;
    const model = buildCadKernelModel(document(step, [
      { ...base('cut-profile'), kind: 'sketch', plane: 'XY', offset: 0, profiles: [{ id: 'cut', name: 'Cut', construction: false, geometry: { kind: 'circle', x: 10, y: 5, radius: 2 } }] },
      { ...base('cut'), kind: 'extrude', sketchId: 'cut-profile', distance: 5, symmetric: false, operation: 'cut', targetId: 'imported' },
    ]));
    try {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo(1000 - 20 * Math.PI, 6);
      expect(model.section({ bodyId: 'cut', plane: 'XY', offset: 2 }).contourCount).toBe(2);
      expect(await model.export('step').text()).toContain('MANIFOLD_SOLID_BREP');
      expect(step.data).toBe(original);
    } finally { model.dispose(); }
  });
  it('converts STEP metre and inch contexts into exact millimetre dimensions', async () => {
    if (step.format !== 'step') throw new Error('Expected STEP');
    const metres = { ...step, data: step.data.replace('SI_UNIT(.MILLI.,.METRE.)', 'SI_UNIT($,.METRE.)') };
    expect(metres.data).not.toBe(step.data);
    const metric = prepareCadSolidImport(metres);
    expect(metric.bounds.max[0]).toBeCloseTo(20_000, 5); expect(metric.volume).toBeCloseTo(1e12, -2);
    const box = makeBox([0, 0, 0], [20, 10, 5]);
    try {
      const inch = { ...step, data: await exportSTEP([{ shape: box }], { unit: 'INCH', modelUnit: 'MM' }).text() };
      const result = prepareCadSolidImport(inch); expect(result.bounds.max[0]).toBeCloseTo(20, 6); expect(result.volume).toBeCloseTo(1000, 5);
    } finally { box.delete(); }
  });
  it('requires real declared STEP context units and ignores lookalike comments or string contents', () => {
    if (step.format !== 'step') throw new Error('Expected STEP');
    const missing = step.data.replace(/GLOBAL_UNIT_ASSIGNED_CONTEXT/g, 'UNRECOGNIZED_CONTEXT');
    const fake = "#999=(GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNIT_ASSIGNED_CONTEXT((#998)));#998=(LENGTH_UNIT() SI_UNIT(.MILLI.,.METRE.));";
    expect(() => assertCadStepLengthUnits(`${missing}\n/* ${fake} */`)).toThrow('must declare');
    expect(() => assertCadStepLengthUnits(`${missing}\n#997='${fake}';`)).toThrow('must declare');
    expect(() => assertCadStepLengthUnits(`${step.data}\n#1=FAKE_UNIT();`)).toThrow('duplicate entity');
  });
  it('rejects corrupt STEP conversion factors, missing references and unknown metric prefixes before transfer', async () => {
    if (step.format !== 'step') throw new Error('Expected STEP');
    const box = makeBox([0, 0, 0], [20, 10, 5]);
    let inch: string;
    try { inch = await exportSTEP([{ shape: box }], { unit: 'INCH', modelUnit: 'MM' }).text(); }
    finally { box.delete(); }
    const measure = /#(\d+)\s*=\s*LENGTH_MEASURE_WITH_UNIT\(25\.4,#(\d+)\);/.exec(inch);
    if (!measure) throw new Error('Expected native inch conversion');
    const invalid = [
      ...['0.', '-25.4', '1.E309', '$'].map(value => inch.replace('LENGTH_MEASURE_WITH_UNIT(25.4,', `LENGTH_MEASURE_WITH_UNIT(${value},`)),
      inch.replace(measure[0], ''),
      inch.replace(measure[0], `#${measure[1]} = LENGTH_MEASURE_WITH_UNIT(25.4,#99999999);`),
      inch.replace('DIMENSIONAL_EXPONENTS(1.,0.,0.,0.,0.,0.,0.)', 'DIMENSIONAL_EXPONENTS(0.,0.,1.,0.,0.,0.,0.)'),
      inch.replace('SI_UNIT(.MILLI.,.METRE.)', 'SI_UNIT(.UNKNOWN.,.METRE.)'),
      inch.replace('SI_UNIT(.MILLI.,.METRE.)', 'SI_UNIT(.MILLI.,.SECOND.)'),
      step.data.replace('SI_UNIT(.MILLI.,.METRE.)', 'SI_UNIT(.UNKNOWN.,.METRE.)'),
    ];
    for (const data of invalid) expect(() => prepareCadSolidImport({ ...step, data })).toThrow(/length units/);
    const cycle = '#1=(GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNIT_ASSIGNED_CONTEXT((#2)));#2=(CONVERSION_BASED_UNIT(\'INCH\',#3) LENGTH_UNIT() NAMED_UNIT(#4));#3=LENGTH_MEASURE_WITH_UNIT(25.4,#2);#4=DIMENSIONAL_EXPONENTS(1.,0.,0.,0.,0.,0.,0.);';
    expect(() => assertCadStepLengthUnits(cycle)).toThrow(/length units/);
    expect(prepareCadSolidImport({ ...step, data: inch }).volume).toBeCloseTo(1000, 5);
  });
  it('retains every STEP solid and rejects surfaces instead of silently discarding them', async () => {
    const first = makeBox([0, 0, 0], [10, 10, 10]); const second = makeBox([20, 0, 0], [30, 10, 10]);
    const face = makePolygon([[-2.5, -2.5, 15], [2.5, -2.5, 15], [2.5, 2.5, 15], [-2.5, 2.5, 15]]);
    try {
      const pair: CadSolidImportSource = { format: 'step', encoding: 'utf8', fileName: 'pair.step', data: await exportSTEP([{ shape: first }, { shape: second }]).text() };
      const result = prepareCadSolidImport(pair); expect(result.solidCount).toBe(2); expect(result.volume).toBeCloseTo(2000, 6);
      const model = buildCadKernelModel(document(pair));
      try {
        expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].solidCount).toBe(2);
        expect(model.result.meshes[0].volume).toBeCloseTo(2000, 6);
        expect(isCadKernelReply({ id: 1, kind: 'built', result: model.result })).toBe(true);
      } finally { model.dispose(); }
      const surface: CadSolidImportSource = { ...pair, data: await exportSTEP([{ shape: face }]).text() };
      expect(() => prepareCadSolidImport(surface)).toThrow(/surfaces|closed manifold/);
      const mixed: CadSolidImportSource = { ...pair, data: await exportSTEP([{ shape: first }, { shape: face }]).text() };
      expect(() => prepareCadSolidImport(mixed)).toThrow(/surfaces|closed manifold/);
    } finally { first.delete(); second.delete(); face.delete(); }
  });
  it('imports binary and ASCII watertight STL honestly as faceted BRep with explicit units', async () => {
    for (const source of [binaryStl, asciiStl]) {
      const analysis = prepareCadSolidImport(source);
      expect(isCadSolidImportResult(analysis)).toBe(true); expect(analysis).toMatchObject({ representation: 'faceted-brep', solidCount: 1 });
      expect(analysis.volume).toBeCloseTo(1000, 6);
      const model = buildCadKernelModel(document(source));
      try { expect(model.result.diagnostics).toEqual([]); expect(await model.export('step').text()).toContain('MANIFOLD_SOLID_BREP'); }
      finally { model.dispose(); }
    }
    if (binaryStl.format !== 'stl') throw new Error('Expected STL');
    const inch = prepareCadSolidImport({ ...binaryStl, units: 'inch' });
    expect(inch.bounds.max[0]).toBeCloseTo(508, 5); expect(inch.volume).toBeCloseTo(1000 * 25.4 ** 3, 3);
  });
  it('rejects open, truncated, nonfinite and multiple-shell STL and cleans native files after failures', async () => {
    if (binaryStl.format !== 'stl') throw new Error('Expected STL');
    const bytes = Uint8Array.from(atob(binaryStl.data), character => character.charCodeAt(0));
    const missing = bytes.slice(0, -50); new DataView(missing.buffer).setUint32(80, 11, true);
    expect(() => prepareCadSolidImport({ ...binaryStl, data: cadBytesToBase64(missing) })).toThrow(/watertight|closed/);
    expect(() => prepareCadSolidImport({ ...binaryStl, data: cadBytesToBase64(bytes.slice(0, -3)) })).toThrow(/byte length|complete/);
    const nonfinite = bytes.slice(); new DataView(nonfinite.buffer).setFloat32(96, NaN, true);
    expect(() => prepareCadSolidImport({ ...binaryStl, data: cadBytesToBase64(nonfinite) })).toThrow('finite');
    const lateInvalid = new Uint8Array(84 + 4001 * 50), lateView = new DataView(lateInvalid.buffer);
    lateView.setUint32(80, 4001, true); lateView.setFloat32(84 + 4000 * 50 + 12, NaN, true);
    expect(() => prepareCadSolidImport({ ...binaryStl, data: cadBytesToBase64(lateInvalid) })).toThrow('finite');
    if (asciiStl.format !== 'stl') throw new Error('Expected STL');
    const ascii = new TextDecoder().decode(Uint8Array.from(atob(asciiStl.data), character => character.charCodeAt(0)));
    for (const corrupt of [ascii.replace(/vertex\s+\S+/, 'vertex NaN'), ascii.replace(/vertex\s+\S+/, 'vertex 1e309'), ascii.replace(/endfacet/, 'missingfacet')]) {
      expect(() => prepareCadSolidImport({ ...asciiStl, data: cadBytesToBase64(new TextEncoder().encode(corrupt)) })).toThrow('finite');
    }
    const first = makeBox([0, 0, 0], [10, 10, 10]); const second = makeBox([20, 0, 0], [30, 10, 10]); const pair = makeCompound([first, second]);
    try {
      const data = cadBytesToBase64(new Uint8Array(await pair.blobSTL({ binary: true }).arrayBuffer()));
      expect(() => prepareCadSolidImport({ ...binaryStl, data })).toThrow('one connected closed shell');
    } finally { pair.delete(); first.delete(); second.delete(); }
    expect(getOC().FS.readdir('/')).not.toEqual(expect.arrayContaining([expect.stringMatching(/^cad-import-/)]));
    expect(prepareCadSolidImport(binaryStl).volume).toBeCloseTo(1000, 6);
  });
  it('never trusts a duplicated BRep and retains prior geometry when a later original source is malformed', () => {
    const broken: CadSolidImportSource = { format: 'step', fileName: 'broken.step', encoding: 'utf8', data: 'not a STEP file' };
    const model = buildCadKernelModel(document(step, [{ ...base('broken'), kind: 'imported', source: broken }]));
    try {
      expect(model.result.diagnostics[0]).toMatchObject({ featureId: 'broken', code: 'step-read' });
      expect(model.result.meshes[0].featureId).toBe('imported'); expect(model.result.meshes[0].volume).toBeCloseTo(1000, 6);
      expect(() => model.export('step')).toThrow('Fix the feature diagnostics');
    } finally { model.dispose(); }
    expect(() => parseCadDocument({ ...document(step), features: [{ ...base('tampered'), kind: 'imported', source: broken, brep: 'fake' }] })).toThrow();
  });
  it('prepares import analysis through worker runtime without invalidating the displayed model snapshot', async () => {
    const runtime = createCadKernelRuntime(async () => undefined); const part = document(step);
    try {
      const build = await runtime.evaluate({ id: 1, kind: 'build', document: part }); if (build.kind !== 'built') throw new Error('Expected model');
      const imported = await runtime.evaluate({ id: 2, kind: 'import-solid', source: binaryStl });
      expect(imported.kind).toBe('solid-imported'); expect(isCadKernelReply(imported)).toBe(true);
      const inspected = await runtime.evaluate({ id: 3, kind: 'inspect-topology', document: part, inspection: { bodyId: 'imported', expectedBuildId: build.result.buildId,
        selection: { kind: 'page', topology: 'face', offset: 0, limit: 2 } } });
      expect(inspected.kind).toBe('topology-inspected');
      const dxf = await runtime.evaluate({ id: 4, kind: 'import-dxf', input: { fileName: 'circle.dxf', units: 'mm', text: '0\nSECTION\n2\nENTITIES\n0\nCIRCLE\n10\n0\n20\n0\n40\n2\n0\nENDSEC\n0\nEOF\n' } });
      expect(dxf.kind).toBe('dxf-imported'); expect(isCadKernelReply(dxf)).toBe(true);
      const cached = await runtime.evaluate({ id: 5, kind: 'build', document: part });
      expect(cached).toMatchObject({ kind: 'built', result: { buildId: build.result.buildId } });
    } finally { runtime.dispose(); }
  });
  it('rebuilds imported DXF line/arc contours as exact editable native solids', async () => {
    const text = ['0', 'SECTION', '2', 'ENTITIES',
      '0', 'LINE', '10', '0', '20', '0', '11', '10', '21', '0',
      '0', 'ARC', '10', '10', '20', '5', '40', '5', '50', '270', '51', '90',
      '0', 'LINE', '10', '10', '20', '10', '11', '0', '21', '10',
      '0', 'LINE', '10', '0', '20', '10', '11', '0', '21', '0', '0', 'ENDSEC', '0', 'EOF', ''].join('\n');
    const imported = importCadDxfSketch({ fileName: 'd-shaped.dxf', text, units: 'mm', sketchId: 'dxf-sketch' });
    const doc = parseCadDocument({ ...document(step), schemaVersion: 2, features: [imported.sketch,
      { ...base('dxf-pad'), kind: 'extrude', sketchId: 'dxf-sketch', distance: 5, operation: 'new', targetId: null, symmetric: false }] });
    const model = buildCadKernelModel(doc);
    try {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo((100 + 12.5 * Math.PI) * 5, 6);
      expect(model.section({ bodyId: 'dxf-pad', plane: 'XY', offset: 2 }).entities.filter(entity => entity.type === 'arc')).toHaveLength(1);
      expect(await model.export('step').text()).toContain('MANIFOLD_SOLID_BREP');
      expect(imported.sketch.source?.text).toBe(text);
    } finally { model.dispose(); }
  });
});
