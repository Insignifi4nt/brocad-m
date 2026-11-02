import { describe, expect, it } from 'vitest';
import type { CadDocument, CadSketchFeature } from '../cadDocument';
import { createCadDocument, parseCadDocument } from '../cadSchema';
import { applyCadEdits } from '../cadOperations';
import { cadEntitiesToCam, cadSketchToCam, cadSketchToDxf } from '../cadCam';
import { cadSketchToEntities } from '../cadSketchGeometry';
import { compileCadSketchGraph } from '../cadSketchGraphGeometry';
import type { CadSketchGenerator } from '../cadSketchGraph';
import { BUNDLED_CAD_PLUGINS, CAD_STAR_PLUGIN, createCadPluginProfile, type CadPluginPackage } from '../plugins/cadPlugins';

// A plugin's notes say how its curves approximate the shape it names. Export and CAM keep them for every plugin shape, a new generator
// as a saved profile, so a handoff never drops them silently.
const sketchFeature = (extra: Partial<CadSketchFeature>) => ({ kind: 'sketch', id: 'sketch', name: 'Sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [], ...extra });
const saved = (plugin: CadPluginPackage) => parseCadDocument({ ...createCadDocument('Notes', 'cad_notes'),
  features: [sketchFeature({ profiles: [{ id: 'part', name: plugin.name, construction: false, geometry: createCadPluginProfile(plugin) }] })] });
const blank = () => parseCadDocument({ ...createCadDocument('Notes', 'cad_notes'), features: [sketchFeature({})] });
const placed = (plugin: CadPluginPackage, document = blank(), id = 'part') => applyCadEdits(document,
  [{ kind: 'add-plugin-profile', sketchId: 'sketch', profileId: id, name: plugin.name, package: plugin, groupId: `${id}_drivers` }]);
const sketchOf = (document: CadDocument) => document.features.find((feature): feature is CadSketchFeature => feature.kind === 'sketch')!;
const generatorOf = (document: CadDocument, id: string) => sketchOf(document).graph!.relations.find((relation): relation is CadSketchGenerator => relation.id === id && relation.kind === 'generator')!;
const camNote = (plugin: CadPluginPackage) => `${plugin.name} v${plugin.version}: ${plugin.notes}`;
const dxfNote = (plugin: CadPluginPackage) => `${plugin.id}@${plugin.version}: ${plugin.notes}`;
const camNotes = (cam: ReturnType<typeof cadSketchToCam>) => cam.diagnostics.filter(diagnostic => diagnostic.code === 'dxf-import-warning').map(diagnostic => diagnostic.message);
/** The DXF's 999 comments, in order. */
const dxfComments = (text: string) => { const lines = text.split(/\r?\n/); return lines.flatMap((line, index) => line.trim() === '999' ? [lines[index + 1]] : []); };
const section = (document: CadDocument) => cadEntitiesToCam(cadSketchToEntities(sketchOf(document), document.parameters), document);

describe('plugin notes on export and CAM handoff', () => {
  it.each(BUNDLED_CAD_PLUGINS.map(plugin => [plugin.name, plugin] as const))('keeps the %s notes for a new generator as for a saved profile, in sketch and section handoff and DXF', (_name, plugin) => {
    const created = placed(plugin);
    expect(sketchOf(created).profiles).toEqual([]);
    for (const document of [saved(plugin), created]) {
      expect(camNotes(cadSketchToCam(document, 'sketch'))).toEqual([camNote(plugin)]);
      expect(camNotes(section(document))).toEqual([camNote(plugin)]);
      expect(dxfComments(cadSketchToDxf(document, 'sketch'))).toContain(dxfNote(plugin));
    }
  });

  it('lists a package once per CAM handoff and once per shape in DXF, and leaves out construction shapes and suppressed sketches', () => {
    // The second star sits inside the first, so the two outlines do not cross.
    const overlapping = placed(CAD_STAR_PLUGIN, placed(CAD_STAR_PLUGIN), 'second'), inner = generatorOf(overlapping, 'second');
    if (inner.geometry.kind !== 'plugin') throw new Error('The star is a plugin generator.');
    const twice = applyCadEdits(overlapping, [{ kind: 'set-sketch-generator', sketchId: 'sketch',
      generator: { ...inner, geometry: { ...inner.geometry, inputs: { ...inner.geometry.inputs, outerRadius: 10, innerRadius: 5 } } } }]);
    expect(camNotes(cadSketchToCam(twice, 'sketch'))).toEqual([camNote(CAD_STAR_PLUGIN)]);
    expect(dxfComments(cadSketchToDxf(twice, 'sketch')).filter(comment => comment === dxfNote(CAD_STAR_PLUGIN))).toHaveLength(2);
    // The second star made construction leaves the first's notes; both made construction leave none.
    const one = applyCadEdits(twice, [{ kind: 'set-sketch-generator', sketchId: 'sketch', generator: { ...generatorOf(twice, 'second'), construction: true } }]);
    expect(dxfComments(cadSketchToDxf(one, 'sketch')).filter(comment => comment === dxfNote(CAD_STAR_PLUGIN))).toHaveLength(1);
    const none = applyCadEdits(one, [{ kind: 'set-sketch-generator', sketchId: 'sketch', generator: { ...generatorOf(one, 'part'), construction: true } },
      { kind: 'set-sketch-generator', sketchId: 'sketch', generator: { id: 'disc', kind: 'generator', idPrefix: 'disc', construction: false, geometry: { kind: 'circle', x: 200, y: 0, radius: 5 } } }]);
    expect(camNotes(cadSketchToCam(none, 'sketch'))).toEqual([]);
    expect(dxfComments(cadSketchToDxf(none, 'sketch'))).not.toContain(dxfNote(CAD_STAR_PLUGIN));
    const suppressed = applyCadEdits(twice, [{ kind: 'update-feature', feature: { ...sketchOf(twice), suppressed: true } }]);
    expect(camNotes(cadEntitiesToCam(cadSketchToEntities(sketchOf(twice), twice.parameters), suppressed))).toEqual([]);
  });

  it('keeps the notes of a construction plugin shape that a linked offset copies as material', () => {
    const star = placed(CAD_STAR_PLUGIN), cycle = compileCadSketchGraph(sketchOf(star).graph!, star.parameters).cycles.find(cycle => !cycle.construction)!;
    const chain = cycle.sourceRefs.map(({ entityId, reversed }) => ({ entityId, reversed }));
    const document = applyCadEdits(star, [
      { kind: 'set-sketch-generator', sketchId: 'sketch', generator: { ...generatorOf(star, 'part'), construction: true } },
      { kind: 'set-sketch-generator', sketchId: 'sketch', generator: { id: 'wall', kind: 'generator', idPrefix: 'wall', construction: false, geometry: { kind: 'offset', chain, distance: 1 } } }]);
    expect(camNotes(cadSketchToCam(document, 'sketch'))).toEqual([camNote(CAD_STAR_PLUGIN)]);
    expect(camNotes(section(document))).toEqual([camNote(CAD_STAR_PLUGIN)]);
    expect(dxfComments(cadSketchToDxf(document, 'sketch'))).toContain(dxfNote(CAD_STAR_PLUGIN));
    // Made construction too, the offset carries no material, so neither does the star.
    const drawn = applyCadEdits(document, [{ kind: 'set-sketch-generator', sketchId: 'sketch', generator: { ...generatorOf(document, 'wall'), construction: true } },
      { kind: 'set-sketch-generator', sketchId: 'sketch', generator: { id: 'disc', kind: 'generator', idPrefix: 'disc', construction: false, geometry: { kind: 'circle', x: 200, y: 0, radius: 5 } } }]);
    expect(dxfComments(cadSketchToDxf(drawn, 'sketch'))).not.toContain(dxfNote(CAD_STAR_PLUGIN));
    // An offset of that construction offset still copies the star, so it keeps the star's notes.
    const ring = compileCadSketchGraph(sketchOf(drawn).graph!, drawn.parameters).cycles.find(cycle => cycle.sourceRefs.every(ref => ref.entityId.startsWith('wall_')))!;
    const outer = applyCadEdits(drawn, [{ kind: 'set-sketch-generator', sketchId: 'sketch', generator: { id: 'outer', kind: 'generator', idPrefix: 'outer', construction: false,
      geometry: { kind: 'offset', chain: ring.sourceRefs.map(({ entityId, reversed }) => ({ entityId, reversed })), distance: 1 } } }]);
    expect(dxfComments(cadSketchToDxf(outer, 'sketch')).filter(comment => comment === dxfNote(CAD_STAR_PLUGIN))).toHaveLength(1);
  });

  it('writes a material star that a material offset copies once in DXF, as the one shape it is', () => {
    const star = placed(CAD_STAR_PLUGIN), cycle = compileCadSketchGraph(sketchOf(star).graph!, star.parameters).cycles.find(cycle => !cycle.construction)!;
    const document = applyCadEdits(star, [{ kind: 'set-sketch-generator', sketchId: 'sketch', generator: { id: 'wall', kind: 'generator', idPrefix: 'wall', construction: false,
      geometry: { kind: 'offset', chain: cycle.sourceRefs.map(({ entityId, reversed }) => ({ entityId, reversed })), distance: 1 } } }]);
    expect(dxfComments(cadSketchToDxf(document, 'sketch')).filter(comment => comment === dxfNote(CAD_STAR_PLUGIN))).toHaveLength(1);
  });
});
