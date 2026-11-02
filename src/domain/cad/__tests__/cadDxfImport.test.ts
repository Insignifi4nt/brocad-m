import { describe, expect, it } from 'vitest';
import type { CadDocument, CadProfile, CadSketchFeature } from '../cadDocument';
import { createCadDocument, createCadSketchProfile, parseCadDocument } from '../cadSchema';
import { cadSketchToDxf, cadSketchToCam } from '../cadCam';
import { cadSketchToEntities, cadProfileContainsPoint, resolveCadProfile, resolveCadSketchRegions } from '../cadSketchGeometry';
import { measureCadSketch } from '../cadMeasurements';
import { importCadDxfSketch, isCadDxfImportResult, parseCadDxfImportInput } from '../cadDxfImport';
import { parseCadDxfImportSource } from '../cadDxfSource';
import { CadError } from '../cadError';
import type { CadSketchGraph } from '../cadSketchGraph';
import { cadSketchProfileViews, withCadSketchProfile } from '../sketch-generators/cadSketchProfileViews';

function part(geometries: readonly CadProfile[]): CadDocument {
  const sketch: CadSketchFeature = { kind: 'sketch', id: 'sketch', name: 'Drawing', suppressed: false, plane: 'XY', offset: 0,
    profiles: geometries.map((geometry, index) => createCadSketchProfile({ id: `contour_${index}`, name: `Contour ${index}`, geometry })) };
  return parseCadDocument({ ...createCadDocument('Drawing', 'cad_drawing'), features: [sketch] });
}
function fromSketch(sketch: CadSketchFeature): CadDocument {
  return parseCadDocument({ ...createCadDocument('Imported', 'cad_imported_dxf'), schemaVersion: 2, features: [sketch] });
}
/** The imported sketch as a document holds it, with each contour generator's lines, arcs and circle. */
function loaded(sketch: CadSketchFeature): CadSketchFeature { return fromSketch(sketch).features[0] as CadSketchFeature; }
/** Each imported contour: the generator's shape, seen as the profile it replaces. */
const contours = (sketch: CadSketchFeature) => cadSketchProfileViews(sketch);
const concave: CadProfile = { kind: 'path', segments: [
  { kind: 'line', start: [0, 0], end: [10, 0] }, { kind: 'line', start: [10, 0], end: [10, 10] },
  { kind: 'line', start: [10, 10], end: [7, 10] }, { kind: 'arc', center: [5, 10], radius: 2, startAngle: 0, sweep: -180 },
  { kind: 'line', start: [3, 10], end: [0, 10] }, { kind: 'line', start: [0, 10], end: [0, 0] }
] };
function dxf(body: readonly (string | number)[], units: string | number | null = 4): string {
  return [ ...(units === null ? [] : ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', units, '0', 'ENDSEC']),
    '0', 'SECTION', '2', 'ENTITIES', ...body, '0', 'ENDSEC', '0', 'EOF', '' ].join('\n');
}
const circleBody = ['0', 'CIRCLE', '8', 'original-layer', '10', '0', '20', '0', '40', '2'];

describe('exact standalone CAD DXF round trip', () => {
  it('preserves a complete local DXF beyond the shared CAM byte ceiling without dropping its analytic contour', () => {
    const text = dxf(circleBody) + ' '.repeat(16 * 1024 * 1024 + 1);
    const imported = importCadDxfSketch({ fileName: 'large-local.dxf', text });
    expect(imported.sketch.source?.text).toBe(text); expect(imported.sourceEntityCount).toBe(1); expect(imported.contourCount).toBe(1);
    expect(isCadDxfImportResult(imported)).toBe(true);
    expect(measureCadSketch(fromSketch(imported.sketch), imported.sketch.id).materialAreaMm2).toBeCloseTo(4 * Math.PI, 7);
  });
  it('imports and exports every edge of a closed contour beyond former profile and aggregate edge ceilings', () => {
    const count = 8193, radius = 100, vertices = Array.from({ length: count }, (_, index) => ({ x: radius * Math.cos(index * 2 * Math.PI / count), y: radius * Math.sin(index * 2 * Math.PI / count) }));
    const text = dxf(vertices.flatMap((vertex, index) => {
      const next = vertices[(index + 1) % count]; return ['0', 'LINE', '10', vertex.x, '20', vertex.y, '11', next.x, '21', next.y];
    }));
    const imported = importCadDxfSketch({ fileName: 'many-edges.dxf', text });
    expect(imported.sourceEntityCount).toBe(count); expect(imported.contourCount).toBe(1); expect(imported.sketch.source?.text).toBe(text);
    expect(isCadDxfImportResult(imported)).toBe(true);
    const document = fromSketch(imported.sketch), measurements = measureCadSketch(document, imported.sketch.id);
    expect(measurements.materialAreaMm2).toBeCloseTo(count * radius ** 2 * Math.sin(2 * Math.PI / count) / 2, 6);
    const exported = cadSketchToDxf(document, imported.sketch.id), roundtrip = importCadDxfSketch({ fileName: 'again.dxf', text: exported });
    expect(roundtrip.sourceEntityCount).toBe(count); expect(contours(roundtrip.sketch)).toHaveLength(1);
    // Direct polygon authoring uses the same geometry capacity contract as the imported path.
    expect(part([{ kind: 'polygon', points: vertices.map(vertex => [vertex.x, vertex.y]) }]).features).toHaveLength(1);
  }, 30_000);
  it('retains every independent analytic profile beyond the former 256-contour ceiling', () => {
    const count = 257, text = dxf(Array.from({ length: count }, (_, index) => ['0', 'CIRCLE', '10', index * 4, '20', 0, '40', 1]).flat());
    const imported = importCadDxfSketch({ fileName: 'profiles.dxf', text });
    expect(imported.contourCount).toBe(count); expect(contours(imported.sketch)).toHaveLength(count); expect(isCadDxfImportResult(imported)).toBe(true);
    expect(measureCadSketch(fromSketch(imported.sketch), imported.sketch.id).materialAreaMm2).toBeCloseTo(count * Math.PI, 7);
  });
  it.each([
    { name: 'rectangle', geometry: { kind: 'rectangle', x: 1, y: 2, width: 20, height: 10, cornerRadius: 0 } },
    { name: 'rounded rectangle', geometry: { kind: 'rectangle', x: 1, y: 2, width: 20, height: 10, cornerRadius: 2 } },
    { name: 'maximum-radius capsule', geometry: { kind: 'rectangle', x: 1, y: 2, width: 20, height: 10, cornerRadius: 5 } },
    { name: 'maximum-radius circular rectangle', geometry: { kind: 'rectangle', x: 1, y: 2, width: 10, height: 10, cornerRadius: 5 } },
    { name: 'rotated slot', geometry: { kind: 'slot', x: 5, y: -3, length: 20, width: 6, angle: 37 } },
    { name: 'circular slot', geometry: { kind: 'slot', x: 5, y: -3, length: 6, width: 6, angle: -121 } },
    { name: 'circle', geometry: { kind: 'circle', x: 3, y: 4, radius: 5 } },
    { name: 'clockwise polygon', geometry: { kind: 'polygon', points: [[0, 0], [0, 10], [10, 10], [10, 0]] } },
    { name: 'concave circular scallop', geometry: concave }
  ] satisfies readonly { name: string; geometry: CadProfile }[])('preserves $name area, perimeter and analytic curve count', ({ geometry }) => {
    const original = part([geometry]); const text = cadSketchToDxf(original, 'sketch');
    const imported = importCadDxfSketch({ fileName: 'drawing.DXF', text, sketchId: 'imported' });
    const result = fromSketch(imported.sketch);
    expect(imported).toMatchObject({ scaleToMillimeters: 1, contourCount: 1 });
    expect(imported.sketch).toMatchObject({ plane: 'XY', offset: 0, source: { text, fileName: 'drawing.DXF' } });
    // The contour is a path or circle generator stored alone, with no saved profile and no CAM role.
    expect(imported.sketch.profiles).toEqual([]);
    expect(imported.sketch.graph).toMatchObject({ points: [], entities: [], relations: [{ id: 'contour_1', kind: 'generator', idPrefix: 'contour-1', name: 'Contour 1', construction: false }] });
    expect(imported.sketch.graph!.relations.every(relation => !('role' in relation))).toBe(true);
    const before = measureCadSketch(original, 'sketch'); const after = measureCadSketch(result, 'imported');
    expect(after.materialAreaMm2).toBeCloseTo(before.materialAreaMm2, 9);
    expect(after.boundaryLengthMm).toBeCloseTo(before.boundaryLengthMm, 9);
    const beforeSketch = original.features[0]; if (beforeSketch.kind !== 'sketch') throw new Error('Expected sketch');
    const types = (feature: CadSketchFeature) => cadSketchToEntities(feature, {}).map(entity => entity.type).sort();
    expect(types(loaded(imported.sketch))).toEqual(types(beforeSketch));
    expect(cadSketchToCam(result, 'imported').contours).toHaveLength(1);
    const again = importCadDxfSketch({ fileName: 'again.dxf', text: cadSketchToDxf(result, 'imported') });
    expect(measureCadSketch(fromSketch(again.sketch), again.sketch.id).materialAreaMm2).toBeCloseTo(before.materialAreaMm2, 9);
  });
  it('reconstructs nested material and islands from shuffled source entities without importing CAM roles', () => {
    const original = part([{ kind: 'circle', x: 0, y: 0, radius: 2 }, { kind: 'circle', x: 0, y: 0, radius: 10 }, { kind: 'circle', x: 0, y: 0, radius: 5 }]);
    const imported = importCadDxfSketch({ fileName: 'nested.dxf', text: cadSketchToDxf(original, 'sketch') });
    expect(resolveCadSketchRegions(loaded(imported.sketch), {})).toHaveLength(2);
    expect(measureCadSketch(fromSketch(imported.sketch), imported.sketch.id).materialAreaMm2).toBeCloseTo(79 * Math.PI, 10);
    expect(contours(imported.sketch).every(profile => profile.geometry.kind === 'circle')).toBe(true);
    expect(imported.sketch.graph!.relations.every(relation => !('role' in relation))).toBe(true);
  });
  it('expands bulged closed polylines into exact circular arcs with no tessellation', () => {
    const text = dxf(['0', 'LWPOLYLINE', '8', 'PART', '90', '2', '70', '1', '10', '-5', '20', '0', '42', '1', '10', '5', '20', '0', '42', '1']);
    const imported = importCadDxfSketch({ fileName: 'bulge.dxf', text });
    const geometry = contours(imported.sketch)[0].geometry;
    expect(geometry).toMatchObject({ kind: 'path', segments: [{ kind: 'arc', radius: 5 }, { kind: 'arc', radius: 5 }] });
    expect(measureCadSketch(fromSketch(imported.sketch), imported.sketch.id).materialAreaMm2).toBeCloseTo(25 * Math.PI, 10);
    expect(cadSketchToEntities(loaded(imported.sketch), {}).every(entity => entity.type === 'arc')).toBe(true);
  });
  it.each([false, true])('preserves a concave bulged polyline with reversed winding=%s through DXF export', reversed => {
    const vertices = reversed ? [[0, 0, 0], [0, 10, 0], [3, 10, 1], [7, 10, 0], [10, 10, 0], [10, 0, 0]]
      : [[0, 0, 0], [10, 0, 0], [10, 10, 0], [7, 10, -1], [3, 10, 0], [0, 10, 0]];
    const text = dxf(['0', 'LWPOLYLINE', '90', vertices.length, '70', '1', ...vertices.flatMap(([x, y, bulge]) => ['10', x, '20', y, '42', bulge])]);
    let sketch = importCadDxfSketch({ fileName: 'concave-bulge.dxf', text }).sketch;
    for (let iteration = 0; iteration < 2; iteration++) {
      const geometry = resolveCadProfile(contours(sketch)[0].geometry, {});
      expect(cadProfileContainsPoint(geometry, { x: 5, y: 9 })).toBe(false);
      expect(cadProfileContainsPoint(geometry, { x: 5, y: 7 })).toBe(true);
      expect(measureCadSketch(fromSketch(sketch), sketch.id).materialAreaMm2).toBeCloseTo(100 - 2 * Math.PI, 10);
      expect(cadSketchToEntities(loaded(sketch), {}).filter(entity => entity.type === 'arc')).toMatchObject([{ clockwise: true, sweepRadians: -Math.PI }]);
      sketch = importCadDxfSketch({ fileName: 'again.dxf', text: cadSketchToDxf(fromSketch(sketch), sketch.id) }).sketch;
    }
  });
});

describe('DXF units, exact source lineage and import rejection', () => {
  it.each([{ code: 1, factor: 25.4 }, { code: 4, factor: 1 }, { code: 5, factor: 10 }, { code: 6, factor: 1000 }])('applies declared units code $code exactly once', ({ code, factor }) => {
    const imported = importCadDxfSketch({ fileName: 'units.dxf', text: dxf(circleBody, code) });
    expect(imported.scaleToMillimeters).toBe(factor);
    expect(contours(imported.sketch)[0].geometry).toMatchObject({ kind: 'circle', radius: 2 * factor });
    expect(contours(importCadDxfSketch({ fileName: 'again.dxf', text: cadSketchToDxf(fromSketch(imported.sketch), imported.sketch.id) }).sketch)[0].geometry).toMatchObject({ radius: 2 * factor });
  });
  it.each([null, 0, 999, 'malformed'])('requires explicit units for declaration %s without borrowing CAM preferences', units => {
    const text = dxf(circleBody, units);
    expect(() => importCadDxfSketch({ fileName: 'units.dxf', text })).toThrow('Choose mm, inch, cm or m explicitly');
    const imported = importCadDxfSketch({ fileName: 'units.dxf', text, units: 'inch' });
    expect(contours(imported.sketch)[0].geometry).toMatchObject({ radius: 50.8 });
    expect(imported.sketch.source).toMatchObject({ text, units: 'inch' });
  });
  it('rejects a conflicting declared-unit override and preserves BOM/CRLF source bytes through geometry edits', () => {
    const text = `\ufeff${dxf(circleBody).replaceAll('\n', '\r\n')}`;
    expect(() => importCadDxfSketch({ fileName: 'part.dxf', text, units: 'inch' })).toThrow('conflict');
    const imported = importCadDxfSketch({ fileName: 'part.dxf', text });
    const sketch = imported.sketch;
    const edited = parseCadDocument({ ...fromSketch(sketch), features: [withCadSketchProfile(sketch, { ...contours(sketch)[0], geometry: { kind: 'circle', x: 0, y: 0, radius: 3 } })] });
    expect(contours(edited.features[0] as CadSketchFeature)[0].geometry).toMatchObject({ radius: 3 });
    expect(edited.features[0]).toMatchObject({ source: { text } });
    expect(sketch.source?.text).toBe(text);
  });
  it.each([['CR', '\r'], ['CRCRLF', '\r\r\n']])('imports a complete DXF whose lines end with %s', (_, ending) => {
    const imported = importCadDxfSketch({ fileName: 'part.dxf', text: dxf(circleBody).replaceAll('\n', ending) });
    expect(imported.contourCount).toBe(1);
    expect(measureCadSketch(fromSketch(imported.sketch), imported.sketch.id).materialAreaMm2).toBeCloseTo(4 * Math.PI, 7);
  });
  it.each([
    { name: 'open line', body: ['0', 'LINE', '10', '0', '20', '0', '11', '10', '21', '0'] },
    { name: 'unsupported ellipse', body: [...circleBody, '0', 'ELLIPSE', '10', '0', '20', '0'] },
    { name: 'dropped invalid line', body: [...circleBody, '0', 'LINE', '10', 'x', '20', '0', '11', '1', '21', '0'] },
    { name: 'zero length line', body: [...circleBody, '0', 'LINE', '10', '0', '20', '0', '11', '0', '21', '0'] },
    { name: 'crossing circles', body: [...circleBody, '0', 'CIRCLE', '10', '1', '20', '0', '40', '2'] }
  ])('rejects $name instead of importing a partial or repaired sketch', ({ body }) => {
    expect(() => importCadDxfSketch({ fileName: 'reject.dxf', text: dxf(body) })).toThrow(CadError);
  });
  it('refuses contours that cross or touch, although generated curves may cross in a sketch', () => {
    for (const x of ['1', '4']) {
      expect(() => importCadDxfSketch({ fileName: 'apart.dxf', text: dxf([...circleBody, '0', 'CIRCLE', '10', x, '20', '0', '40', '2']) }))
        .toThrow(expect.objectContaining({ code: 'profile-intersection', message: 'Profiles "Contour 1" and "Contour 2" overlap or touch.' }));
    }
  });
  it('rejects a physical closing gap and branching paths instead of bridging them', () => {
    const line = (x: number, y: number, ex: number, ey: number) => ['0', 'LINE', '10', x, '20', y, '11', ex, '21', ey];
    const gap = dxf([...line(0, 0, 10, 0), ...line(10, 0, 10, 10), ...line(10, 10, 0, 10), ...line(0, 10, 0, 1e-5)]);
    expect(() => importCadDxfSketch({ fileName: 'gap.dxf', text: gap })).toThrow('without bridging');
    const branch = dxf([...line(0, 0, 10, 0), ...line(10, 0, 10, 10), ...line(10, 10, 0, 0), ...line(10, 0, 20, 0)]);
    expect(() => importCadDxfSketch({ fileName: 'branch.dxf', text: branch })).toThrow('unbranched');
  });
  it('refuses truncated or ambiguous DXF framing before geometry conversion', () => {
    const complete = dxf(circleBody);
    for (const text of [complete.replace('0\nEOF\n', ''), complete.replace('0\nENDSEC\n0\nEOF', '0\nEOF'), `${complete}0\nLINE\n`, complete.slice(0, -3),
      complete.replace('0\nEOF', '0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF')]) {
      expect(() => importCadDxfSketch({ fileName: 'partial.dxf', text })).toThrow(CadError);
    }
  });
  it.each([30, 31, 32, 38, 39])('rejects nonzero spatial code %s rather than silently projecting geometry', code => {
    const text = dxf([...circleBody, code, 10]);
    try { importCadDxfSketch({ fileName: 'elevated.dxf', text }); throw new Error('Expected rejection'); }
    catch (error) { expect(error).toMatchObject({ code: 'dxf-unsupported-3d' }); }
    expect(importCadDxfSketch({ fileName: 'zero.dxf', text: dxf([...circleBody, code, 0]) }).contourCount).toBe(1);
  });
  it('rejects block insertion heights and block-local elevation while allowing irrelevant header metadata', () => {
    const header = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '9', '$EXTMIN', '10', '0', '20', '0', '30', '12', '0', 'ENDSEC'];
    const blocks = ['0', 'SECTION', '2', 'BLOCKS', '0', 'BLOCK', '2', 'SHAPE', '10', '0', '20', '0', '30', '0', ...circleBody, '0', 'ENDBLK', '0', 'ENDSEC'];
    const insertion = ['0', 'SECTION', '2', 'ENTITIES', '0', 'INSERT', '2', 'SHAPE', '10', '0', '20', '0', '30', '0', '0', 'ENDSEC', '0', 'EOF', ''];
    const complete = [...header, ...blocks, ...insertion].join('\n');
    expect(importCadDxfSketch({ fileName: 'blocks.dxf', text: complete }).contourCount).toBe(1);
    expect(() => importCadDxfSketch({ fileName: 'insert.dxf', text: complete.replace('2\nSHAPE\n10\n0\n20\n0\n30\n0\n0\nENDSEC', '2\nSHAPE\n10\n0\n20\n0\n30\n10\n0\nENDSEC') })).toThrow('block insertion heights');
    expect(() => importCadDxfSketch({ fileName: 'block.dxf', text: complete.replace('30\n0\n0\nCIRCLE', '30\n10\n0\nCIRCLE') })).toThrow('block insertion heights');
  });
  it('preserves UTF-8 originals above the former source cap and rejects non-own or malformed data', () => {
    const source = { format: 'dxf', fileName: 'part.dxf', text: dxf(circleBody) };
    expect(() => parseCadDxfImportSource(Object.create(source))).toThrow(CadError);
    const text = dxf([...Array.from({ length: 1000 }, () => [999, '孔😀'.repeat(320)]).flat(), ...circleBody]);
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(2 * 1024 * 1024);
    const imported = importCadDxfSketch({ fileName: 'part.dxf', text });
    expect(imported.sketch.source?.text).toBe(text); expect(imported.contourCount).toBe(1);
    expect(isCadDxfImportResult(imported)).toBe(true); expect(measureCadSketch(fromSketch(imported.sketch), imported.sketch.id).materialAreaMm2).toBeCloseTo(4 * Math.PI, 7);
    expect(() => parseCadDxfImportSource({ ...source, fileName: '../part.dxf' })).toThrow(CadError);
    for (const fileName of ['part\n.dxf', 'part\u0000.dxf', 'part\u007f.dxf']) expect(() => parseCadDxfImportSource({ ...source, fileName })).toThrow(CadError);
    expect(() => parseCadDxfImportSource({ ...source, text: '\ud800' })).toThrow('unpaired');
  });
});

describe('DXF worker boundary', () => {
  const input = { fileName: 'part.dxf', text: dxf(circleBody), sketchId: 'picked_sketch', name: 'Exact original' };
  it('accepts an immutable request and complete response without reparsing source geometry', () => {
    expect(Object.isFrozen(parseCadDxfImportInput(input))).toBe(true);
    expect(isCadDxfImportResult(importCadDxfSketch(input))).toBe(true);
    for (const units of [null, 0, 999, 'malformed']) expect(isCadDxfImportResult(importCadDxfSketch({ ...input, text: dxf(circleBody, units), units: 'inch' }))).toBe(true);
  });
  it('rejects malformed requests, inherited fields and accessors without invoking them', () => {
    for (const value of [{ ...input, extra: true }, { ...input, sketchId: '../escape' }, { ...input, name: ' ' }, { ...input, units: 'feet' }, Object.create(input)]) {
      expect(() => parseCadDxfImportInput(value)).toThrow(CadError);
    }
    let reads = 0;
    const getter = { ...input }; Object.defineProperty(getter, 'text', { get: () => { reads++; return input.text; }, enumerable: true });
    expect(() => parseCadDxfImportInput(getter)).toThrow(CadError);
    expect(reads).toBe(0);
    const sourceGetter = { format: 'dxf', fileName: input.fileName };
    Object.defineProperty(sourceGetter, 'text', { get: () => { reads++; return input.text; }, enumerable: true });
    expect(() => parseCadDxfImportSource(sourceGetter)).toThrow(CadError); expect(reads).toBe(0);
  });
  it('rejects mismatched metadata, invalid geometry and nonportable response data', () => {
    const valid = importCadDxfSketch(input), contour = valid.sketch.graph!.relations[0];
    const withGraph = (change: Partial<Record<keyof CadSketchGraph, readonly unknown[]>>) => ({ ...valid, sketch: { ...valid.sketch, graph: { ...valid.sketch.graph!, ...change } } });
    expect(isCadDxfImportResult(withGraph({}))).toBe(true);
    for (const value of [{ ...valid, extra: 1 }, { ...valid, contourCount: 2 }, { ...valid, sourceEntityCount: 0 }, { ...valid, scaleToMillimeters: 25.4 },
      { ...valid, unitDeclaration: { status: 'recognized', units: { source: 'dxf-insunits', code: 4, label: 'inches', scaleToMillimeters: 25.4 } } },
      { ...valid, sketch: { ...valid.sketch, plane: 'XZ' } }, { ...valid, sketch: { ...valid.sketch, offset: 1 } },
      { ...valid, sketch: { ...valid.sketch, source: undefined } }, { ...valid, sketch: { ...valid.sketch, graph: undefined } },
      // A saved profile, a contour that is not an exact path or circle, construction or a CAM role, and geometry of the sketch's own.
      { ...valid, sketch: { ...valid.sketch, profiles: [createCadSketchProfile({ id: 'legacy', geometry: { kind: 'circle', x: 0, y: 0, radius: 2 } })] } },
      withGraph({ relations: [{ ...contour, role: 'outer' }] }), withGraph({ relations: [{ ...contour, construction: true }] }),
      withGraph({ relations: [{ ...contour, geometry: { kind: 'circle', x: 0, y: 0, radius: -1 } }] }),
      withGraph({ relations: [{ ...contour, geometry: { kind: 'rectangle', x: 0, y: 0, width: 2, height: 2, cornerRadius: 0 } }] }),
      withGraph({ points: [{ id: 'stray', position: [9, 9] }] }), withGraph({ relations: [contour, { id: 'fixed', kind: 'fixed', pointIds: ['contour-1_c'] }] }),
      Object.create(valid)]) {
      expect(isCadDxfImportResult(value)).toBe(false);
    }
    let reads = 0; const getter = { ...valid };
    Object.defineProperty(getter, 'sketch', { get: () => { reads++; return valid.sketch; }, enumerable: true });
    expect(isCadDxfImportResult(getter)).toBe(false); expect(reads).toBe(0);
  });
});
