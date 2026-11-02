import { describe, expect, it } from 'vitest';
import type { CadProfile, CadSketchFeature } from '../cadDocument';
import { prepareCadSketchProfileCopy } from '../cadSketchProfileCopy';
import { compileCadSketchGraph } from '../cadSketchGraphGeometry';
import { measureCadResolvedProfile } from '../cadMeasurements';
import { profileCopyDxfPart, dxfProfileCopyRequest } from './cadSketchProfileCopyFixtures';
import { CAD_STAR_PLUGIN, createCadPluginProfile } from '../plugins/cadPlugins';
import { Value } from '@sinclair/typebox/value';
import { CadSketchProfileCopyRequestSchema } from '../cadSketchProfileCopy';
import { expandCadSketchGenerators } from '../sketch-generators/cadSketchGenerators';

function source(geometry: CadProfile): CadSketchFeature {
  return { id: 'source', kind: 'sketch', name: 'Original', suppressed: false, plane: 'XZ', offset: ' sourceOffset ',
    profiles: [{ id: 'outline', name: 'Original outline', construction: false, geometry }] };
}
const request = { sourceSketchId: 'source', profileId: 'outline', newSketchId: 'editable', name: 'Editable outline', idPrefix: 'copy' };
function measure(sketch: CadSketchFeature) {
  if (!sketch.graph) throw new Error('Missing editable graph.');
  const compiled = compileCadSketchGraph(sketch.graph, {});
  expect(compiled.openEntityIds).toEqual([]); expect(compiled.branchedEntityIds).toEqual([]); expect(compiled.arrangementEntityIds).toEqual([]);
  expect(compiled.cycles).toHaveLength(1);
  return measureCadResolvedProfile({ kind: 'path', segments: compiled.cycles[0].path });
}

describe('independent editable profile copy', () => {
  it('copies a generated rectangle as its members with the relations among them, leaving those that reach other geometry', () => {
    const graph = expandCadSketchGenerators({ points: [{ id: 'u', position: [30, 0] }], entities: [], relations: [
      { id: 'outline', kind: 'generator', idPrefix: 'g', construction: false, geometry: { kind: 'rectangle', x: 0, y: 0, width: 20, height: 10, cornerRadius: 0 } },
      { id: 'across', kind: 'reference-dimension', measurement: { kind: 'point-distance', pointIds: ['g_p0', 'g_p2'] } },
      { id: 'reach', kind: 'reference-dimension', measurement: { kind: 'point-distance', pointIds: ['g_p1', 'u'] } }] }, {});
    const sketch: CadSketchFeature = { ...source({ kind: 'circle', x: 0, y: 0, radius: 1 }), profiles: [], graph };
    const copy = prepareCadSketchProfileCopy({ sketch, parameters: { sourceOffset: 0 }, ...request }).sketch.graph!;
    expect(copy.points.map(point => [point.id, point.position])).toEqual([['copy_p0', [0, 0]], ['copy_p1', [20, 0]], ['copy_p2', [20, 10]], ['copy_p3', [0, 10]]]);
    expect(copy.entities[0]).toEqual({ id: 'copy_e0', kind: 'line', construction: false, startPointId: 'copy_p0', endPointId: 'copy_p1' });
    // In graph order: the user's reference first, then the rectangle's own directions; the measure that reaches "u" stays behind.
    expect(copy.relations).toEqual([{ id: 'copy_u0', kind: 'reference-dimension', measurement: { kind: 'point-distance', pointIds: ['copy_p0', 'copy_p2'] } },
      { id: 'copy_r0', kind: 'horizontal', pointIds: ['copy_p0', 'copy_p1'] }, { id: 'copy_r1', kind: 'vertical', pointIds: ['copy_p1', 'copy_p2'] },
      { id: 'copy_r2', kind: 'horizontal', pointIds: ['copy_p2', 'copy_p3'] }, { id: 'copy_r3', kind: 'vertical', pointIds: ['copy_p3', 'copy_p0'] }]);
  });

  it('copies the outline of a generator with no profile view, a regular polygon or a linked offset, as plain geometry', () => {
    const corners = [[40, 0], [50, 0], [50, 10], [40, 10]] as const;
    const graph = expandCadSketchGenerators({ points: corners.map((position, index) => ({ id: `p${index}`, position: [...position] as [number, number] })),
      entities: corners.map((_, index) => ({ id: `l${index}`, kind: 'line' as const, construction: false, startPointId: `p${index}`, endPointId: `p${(index + 1) % 4}` })), relations: [
        { id: 'hex', kind: 'generator', idPrefix: 'hex', construction: false, geometry: { kind: 'regular-polygon', x: 0, y: 0, radius: 'size', sides: 6, directionId: '@h' } },
        { id: 'wall', kind: 'generator', idPrefix: 'wall', construction: false, geometry: { kind: 'offset', chain: ['l0', 'l1', 'l2', 'l3'].map(entityId => ({ entityId, reversed: false })), distance: 2 } }] },
      { size: 10 });
    const sketch: CadSketchFeature = { ...source({ kind: 'circle', x: 0, y: 0, radius: 1 }), profiles: [], graph };
    const hex = prepareCadSketchProfileCopy({ sketch, parameters: { sourceOffset: 0, size: 10 }, ...request, profileId: 'hex' }).sketch;
    expect(hex.graph?.relations.some(relation => relation.kind === 'generator')).toBe(false);
    expect(hex.graph?.entities).toHaveLength(6); expect(measure(hex).areaMm2).toBeCloseTo(3 * Math.sqrt(3) / 2 * 100, 9);
    const wall = prepareCadSketchProfileCopy({ sketch, parameters: { sourceOffset: 0, size: 10 }, ...request, profileId: 'wall' }).sketch;
    expect(wall.graph?.relations.some(relation => relation.kind === 'generator')).toBe(false);
    // The square grown by 2 on each side, its sides extended to meet at sharp corners.
    expect(measure(wall).areaMm2).toBeCloseTo(14 * 14, 9);
  });

  it('copies a rotated parametric slot as a separate numeric graph with shared authored joints and inherited placement', () => {
    const sketch = source({ kind: 'slot', x: '11.00', y: '-7.00', length: ' slotLength ', width: '10.0000', angle: '30.00' });
    const before = JSON.stringify(sketch), parameters = { slotLength: 30, sourceOffset: 2.5 };
    const result = prepareCadSketchProfileCopy({ sketch, parameters, ...request });
    expect(result.sketch).toMatchObject({ id: 'editable', kind: 'sketch', name: 'Editable outline', suppressed: false, plane: 'XZ', offset: 2.5, profiles: [] });
    expect(result.sketch.graph?.entities.map(entity => entity.kind)).toEqual(['line', 'arc', 'line', 'arc']);
    expect(result.sketch.graph?.points.map(point => point.id)).toEqual(['copy_p0', 'copy_p1', 'copy_p2', 'copy_p3', 'copy_c1', 'copy_c3']);
    expect(result.sketch.graph?.relations).toEqual([]);
    result.sketch.graph?.entities.forEach((entity, index) => {
      if (entity.kind === 'circle') throw new Error('Expected a chain.');
      expect(entity.startPointId).toBe(`copy_p${index}`); expect(entity.endPointId).toBe(`copy_p${(index + 1) % 4}`);
    });
    expect(result.resultEntityIds).toEqual(['copy_e0', 'copy_e1', 'copy_e2', 'copy_e3']);
    expect(result.sourceSegments.filter(segment => segment.kind === 'arc').map(segment => segment.sweep)).toEqual([180, 180]);
    expect(measure(result.sketch).areaMm2).toBeCloseTo(200 + 25 * Math.PI, 10);
    expect(measure(result.sketch).perimeterMm).toBeCloseTo(40 + 10 * Math.PI, 10);
    expect(JSON.stringify(sketch)).toBe(before); expect(Object.isFrozen(sketch)).toBe(false);
    expect(Object.isFrozen(result.sketch.graph?.points[0].position)).toBe(true); expect(Object.isFrozen(result.sourceSegments[0])).toBe(true);
    expect(prepareCadSketchProfileCopy({ sketch, parameters: { ...parameters, slotLength: 50 }, ...request }).sketch).not.toEqual(result.sketch);
    expect(measure(result.sketch).areaMm2).toBeCloseTo(200 + 25 * Math.PI, 10);
  });

  it('copies a construction circle and a full-turn path as typed circles without synthetic seams or source expressions', () => {
    const sketch: CadSketchFeature = { ...source({ kind: 'circle', x: ' centerX ', y: '4.000', radius: ' diameter / 2 ' }),
      plane: { kind: 'datum-plane', featureId: 'fixture-plane' }, profiles: [{ ...source({ kind: 'circle', x: ' centerX ', y: '4.000', radius: ' diameter / 2 ' }).profiles[0], construction: true, role: 'hole' }] };
    const before = JSON.stringify(sketch), result = prepareCadSketchProfileCopy({ sketch, parameters: { centerX: 3, diameter: 8, sourceOffset: 7 }, ...request });
    expect(result.sketch.graph).toEqual({ points: [{ id: 'copy_c0', position: [3, 4] }],
      entities: [{ id: 'copy_e0', kind: 'circle', centerPointId: 'copy_c0', radius: 4, construction: true }], relations: [] });
    expect(result.sketch.plane).toEqual(sketch.plane); expect(result.sketch.plane).not.toBe(sketch.plane);
    expect(Object.isFrozen(result.sketch.plane)).toBe(true); expect(Object.isFrozen(sketch.plane)).toBe(false);
    expect(result.sourceSegments).toEqual([{ kind: 'arc', center: [3, 4], radius: 4, startAngle: 0, sweep: 360 }]);
    expect(measure(result.sketch).areaMm2).toBeCloseTo(16 * Math.PI, 10); expect(JSON.stringify(sketch)).toBe(before);
    const full = source({ kind: 'path', segments: [{ kind: 'arc', center: [3, 4], radius: 4, startAngle: 72, sweep: -360 }] });
    const copied = prepareCadSketchProfileCopy({ sketch: full, parameters: { sourceOffset: 0 }, ...request });
    expect(copied.sketch.graph?.entities[0]).toMatchObject({ kind: 'circle', radius: 4 }); expect(copied.sketch.graph?.points).toHaveLength(1);
    expect(measure(copied.sketch).areaMm2).toBeCloseTo(16 * Math.PI, 10);
  });

  it('uses already-mm accepted inch DXF supports once and leaves original Unicode text/import metadata exact', () => {
    const document = profileCopyDxfPart(), sketch = document.features.find(feature => feature.kind === 'sketch');
    if (!sketch || sketch.kind !== 'sketch') throw new Error('Missing imported source.');
    const before = JSON.stringify(document), result = prepareCadSketchProfileCopy({ sketch, parameters: document.parameters, ...dxfProfileCopyRequest });
    const arc = result.sourceSegments.find(segment => segment.kind === 'arc');
    expect(arc).toMatchObject({ radius: 25.4, sweep: 270 });
    expect(result.sketch.graph?.entities.map(entity => entity.kind)).toEqual(['arc', 'line']);
    expect(result.sketch.graph?.entities[0]).toMatchObject({ direction: 'ccw' }); expect(result.sketch.source).toBeUndefined();
    expect(result.sketch.graph?.relations).toEqual([]);
    expect(measure(result.sketch).areaMm2).toBeCloseTo(25.4 ** 2 * (3 * Math.PI / 4 + 0.5), 9);
    expect(sketch.source?.text).toContain('原本 • Major arc 😀'); expect(JSON.stringify(document)).toBe(before);
  });

  it('copies one plugin outline only, preserves its package/inputs and snapshots source dimensions independently', () => {
    const plugin = createCadPluginProfile({ ...structuredClone(CAD_STAR_PLUGIN), id: 'user.rectangle', name: 'Parametric rectangle', inputs: [
      { name: 'width', label: 'Width', unit: 'mm', default: 40, minimum: 1, maximum: 1000, integer: false },
      { name: 'height', label: 'Height', unit: 'mm', default: 20, minimum: 1, maximum: 1000, integer: false }],
      generator: { kind: 'polygon-recipe', repeat: 1, points: [[0, 0], ['width', 0], ['width', 'height'], [0, 'height']] } });
    const sketch: CadSketchFeature = { ...source(plugin), profiles: [
      { ...source(plugin).profiles[0], geometry: { ...plugin, inputs: { width: ' width ', height: '20.00' } } },
      { id: 'bore', name: 'Unselected source hole', role: 'hole', construction: false, geometry: { kind: 'circle', x: 20, y: 10, radius: 3 } }] };
    const before = JSON.stringify(sketch), result = prepareCadSketchProfileCopy({ sketch, parameters: { sourceOffset: 0, width: 40 }, ...request });
    expect(measure(result.sketch)).toMatchObject({ areaMm2: 800, perimeterMm: 120 });
    expect(result.sketch.graph?.points.map(point => point.position)).toEqual([[0, 0], [40, 0], [40, 20], [0, 20]]);
    expect(result.sketch.profiles).toEqual([]); expect(result.sketch.graph?.relations).toEqual([]);
    expect(JSON.stringify(result.sketch)).not.toContain('user.rectangle'); expect(JSON.stringify(sketch)).toBe(before);
    expect(Object.isFrozen(plugin.package)).toBe(false);
    expect(prepareCadSketchProfileCopy({ sketch, parameters: { sourceOffset: 0, width: 60 }, ...request }).sketch.graph?.points[1].position).toEqual([60, 0]);
    expect(result.sketch.graph?.points[1].position).toEqual([40, 0]);
  });

  it('preserves a clockwise concave arc and rounded joints without replacing them with sampled edges', () => {
    const notch = source({ kind: 'path', segments: [
      { kind: 'line', start: [0, 0], end: [10, 0] }, { kind: 'line', start: [10, 0], end: [10, 10] },
      { kind: 'line', start: [10, 10], end: [7, 10] }, { kind: 'arc', center: [5, 10], radius: 2, startAngle: 0, sweep: -180 },
      { kind: 'line', start: [3, 10], end: [0, 10] }, { kind: 'line', start: [0, 10], end: [0, 0] }] });
    const copied = prepareCadSketchProfileCopy({ sketch: notch, parameters: { sourceOffset: 0 }, ...request });
    expect(copied.sketch.graph?.entities).toHaveLength(6); expect(copied.sketch.graph?.entities[3]).toMatchObject({ kind: 'arc', direction: 'cw', centerPointId: 'copy_c3' });
    expect(copied.sourceSegments[3]).toMatchObject({ kind: 'arc', radius: 2, sweep: -180 });
    expect(measure(copied.sketch).areaMm2).toBeCloseTo(100 - 2 * Math.PI, 10);
    const rounded = prepareCadSketchProfileCopy({ sketch: source({ kind: 'rectangle', x: 0, y: 0, width: 40, height: 20, cornerRadius: 4 }), parameters: { sourceOffset: 0 }, ...request });
    expect(rounded.sketch.graph?.entities).toHaveLength(8); expect(rounded.sketch.graph?.entities.filter(entity => entity.kind === 'arc')).toHaveLength(4);
    expect(measure(rounded.sketch).areaMm2).toBeCloseTo(800 - (4 - Math.PI) * 16, 10);
  });

  it('rejects wrong source/identity/name and malformed prefixes while source namespaces stay independent from new graph IDs', () => {
    const sketch = source({ kind: 'rectangle', x: 0, y: 0, width: 40, height: 20, cornerRadius: 0 }), before = JSON.stringify(sketch);
    const input = { sketch, parameters: { sourceOffset: 0 }, ...request };
    for (const change of [{ sourceSketchId: 'missing' }, { profileId: 'missing' }, { newSketchId: 'source' }, { name: '  ' },
      { idPrefix: '' }, { idPrefix: 'bad prefix' }, { idPrefix: 'x'.repeat(65) }]) expect(() => prepareCadSketchProfileCopy({ ...input, ...change })).toThrow();
    expect(Value.Check(CadSketchProfileCopyRequestSchema, { ...request, extra: 1 })).toBe(false);
    expect(() => prepareCadSketchProfileCopy({ ...input, sketch: { ...sketch, suppressed: true } })).toThrow();
    const prefix = 'x'.repeat(64), result = prepareCadSketchProfileCopy({ ...input, idPrefix: prefix });
    expect(result.resultEntityIds[0]).toBe(`${prefix}_e0`);
    const sourceIdCollision = { ...sketch, profiles: [{ ...sketch.profiles[0], id: 'copy_p0' }] };
    expect(prepareCadSketchProfileCopy({ ...input, sketch: sourceIdCollision, profileId: 'copy_p0' }).sketch.graph?.points[0].id).toBe('copy_p0');
    expect(JSON.stringify(sketch)).toBe(before);
  });

  it('rejects physical source gaps, self contacts, unsupported dimensions and unrepresentable arc branches without repair', () => {
    const invalid: CadProfile[] = [
      { kind: 'circle', x: 0, y: 0, radius: 0 },
      { kind: 'slot', x: 0, y: 0, length: 5, width: 10, angle: 0 },
      { kind: 'polygon', points: [[0, 0], [10, 10], [0, 10], [10, 0]] },
      { kind: 'path', segments: [{ kind: 'line', start: [0, 0], end: [10, 0] }, { kind: 'line', start: [10 + 1e-8, 0], end: [0, 10] }, { kind: 'line', start: [0, 10], end: [0, 0] }] },
      ...[180.000000000001, 179.999999999999].map(first => ({ kind: 'path' as const, segments: [
        { kind: 'arc' as const, center: [10000, 10000] as const, radius: 10, startAngle: 0, sweep: first },
        { kind: 'arc' as const, center: [10000, 10000] as const, radius: 10, startAngle: first, sweep: 360 - first }] }))
    ];
    for (const geometry of invalid) {
      const sketch = source(geometry), before = JSON.stringify(sketch);
      expect(() => prepareCadSketchProfileCopy({ sketch, parameters: { sourceOffset: 0 }, ...request })).toThrow();
      expect(JSON.stringify(sketch)).toBe(before); expect(Object.isFrozen(sketch)).toBe(false);
    }
  });

  it('copies an exactly circular slot as a circle but rejects loss of its authored nonzero straight span', () => {
    const round = source({ kind: 'slot', x: 2, y: -3, length: 10, width: 10, angle: 30 });
    const result = prepareCadSketchProfileCopy({ sketch: round, parameters: { sourceOffset: 0 }, ...request });
    expect(result.sketch.graph?.entities).toEqual([{ id: 'copy_e0', kind: 'circle', centerPointId: 'copy_c0', radius: 5, construction: false }]);
    expect(measure(result.sketch).areaMm2).toBeCloseTo(25 * Math.PI, 10);
    const near = source({ kind: 'slot', x: 2, y: -3, length: 10 + 5e-8, width: 10, angle: 30 }), before = JSON.stringify(near);
    expect(() => prepareCadSketchProfileCopy({ sketch: near, parameters: { sourceOffset: 0 }, ...request })).toThrow('cannot keep this shape exact');
    expect(JSON.stringify(near)).toBe(before);
  });
});
