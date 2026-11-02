import { describe, expect, it } from 'vitest';
import type { CadDocument, CadProfile, CadSketchFeature } from '../cadDocument';
import { createCadDocument, parseCadDocument } from '../cadSchema';
import { applyCadEdits } from '../cadOperations';
import { cadSketchToDxf } from '../cadCam';
import { importCadDxfSketch } from '../cadDxfImport';
import { importCadDxfCurve } from '../cadCurveDxf';
import { resolveCadSketchRegions } from '../cadSketchGeometry';
import { BUNDLED_CAD_PLUGINS, CAD_LINKED_RECIPE_EXAMPLE } from '../plugins/cadPlugins';
import { cadSketchShapeEdits } from '../sketch-generators/cadSketchProfileViews';

// Saved sketch profiles still load, but no producer makes a new one: each new shape is a generator in the sketch graph, or sketch
// geometry. The agent tools are pinned in `cadSiteTools.test.ts`.
const blank = () => parseCadDocument({ ...createCadDocument('Producers', 'cad_producers'),
  features: [{ kind: 'sketch', id: 'sketch', name: 'Sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [] }] });
function sketchOf(document: CadDocument): CadSketchFeature {
  const sketch = document.features[0];
  if (sketch?.kind !== 'sketch') throw new Error('Sketch missing');
  return sketch;
}
const regions = (document: CadDocument) => resolveCadSketchRegions(sketchOf(document), document.parameters);
const generated = (sketch: CadSketchFeature) => (sketch.graph?.relations ?? []).flatMap(relation => relation.kind === 'generator' ? [relation.geometry.kind] : []);
const shapes: readonly CadProfile[] = [
  { kind: 'rectangle', x: 0, y: 0, width: 20, height: 10, cornerRadius: 2 },
  { kind: 'circle', x: 40, y: 5, radius: 4 },
  { kind: 'polygon', points: [[60, 0], [70, 0], [65, 9]] },
  { kind: 'slot', x: 90, y: 5, length: 12, width: 4, angle: 0 },
  { kind: 'path', segments: [{ kind: 'line', start: [110, 0], end: [120, 0] }, { kind: 'arc', center: [120, 5], radius: 5, startAngle: -90, sweep: 180 },
    { kind: 'line', start: [120, 10], end: [110, 10] }, { kind: 'line', start: [110, 10], end: [110, 0] }] }
];
function drawn(): CadDocument {
  return shapes.reduce((document, geometry, index) => applyCadEdits(document, cadSketchShapeEdits(sketchOf(document), geometry, { id: `shape_${index}`, construction: false })), blank());
}
const placed = (plugin: (typeof BUNDLED_CAD_PLUGINS)[number]) => applyCadEdits(blank(),
  [{ kind: 'add-plugin-profile', sketchId: 'sketch', profileId: 'part', name: plugin.name, package: plugin, groupId: 'drivers' }]);

describe('producers of new sketch shapes', () => {
  it('draws every shape kind as a generator, or a closed path as its own sketch geometry, and never as a saved profile', () => {
    const document = drawn(), sketch = sketchOf(document);
    expect(sketch.profiles).toEqual([]);
    expect(generated(sketch)).toEqual(['rectangle', 'circle', 'polygon', 'slot']);
    expect(regions(document)).toHaveLength(shapes.length);
  });

  it.each([...BUNDLED_CAD_PLUGINS, CAD_LINKED_RECIPE_EXAMPLE].map(plugin => [plugin.name, plugin] as const))('places the %s plugin as a plugin generator, not a saved profile', (_name, plugin) => {
    const document = placed(plugin), sketch = sketchOf(document);
    expect(sketch.profiles).toEqual([]);
    expect(generated(sketch)).toEqual(['plugin']);
    expect(regions(document).length).toBeGreaterThan(0);
  });

  const sources: readonly (readonly [string, () => CadDocument])[] = [['drawn shapes', drawn], ...BUNDLED_CAD_PLUGINS.map(plugin => [plugin.name, () => placed(plugin)] as const)];
  it.each(sources)('imports a DXF of %s as one path or circle generator per contour, stored alone', (_name, make) => {
    const source = make(), imported = importCadDxfSketch({ fileName: 'produced.dxf', text: cadSketchToDxf(source, 'sketch') });
    expect(imported.sketch.profiles).toEqual([]);
    expect(imported.sketch.graph).toMatchObject({ points: [], entities: [] });
    expect(imported.sketch.graph?.relations.every(relation => relation.kind === 'generator' && !relation.construction
      && (relation.geometry.kind === 'path' || relation.geometry.kind === 'circle'))).toBe(true);
    const count = regions(source).length;
    expect(imported.contourCount).toBe(count);
    expect(regions(parseCadDocument({ ...createCadDocument('Imported'), schemaVersion: 2, features: [imported.sketch] }))).toHaveLength(count);
  });

  it('imports a curve DXF as a curve feature, which has no sketch profiles', () => {
    const text = '0\nSECTION\n2\nENTITIES\n0\nLINE\n10\n0\n20\n0\n11\n20\n21\n0\n0\nENDSEC\n0\nEOF\n';
    expect(importCadDxfCurve({ fileName: 'Rail.dxf', text, units: 'mm', curveId: 'rail' }).curve.kind).toBe('curve');
  });
});
