// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { CadSketchFeature } from '@/domain/cad/cadDocument';
import type { CadSketchGraph } from '@/domain/cad/cadSketchGraph';
import { createCadDocument, parseCadDocument } from '@/domain/cad/cadSchema';
import { CAD_GEAR_V3_PLUGIN, CAD_STAR_PLUGIN, createCadPluginProfile } from '@/domain/cad/plugins/cadPlugins';
import { cadSketchGeneratorMembers } from '@/domain/cad/sketch-generators/cadSketchGenerators';
import { cadSketchWholeGenerator } from '@/domain/cad/sketch-generators/cadSketchProfileViews';
import { cadSketchOffsetSource } from './CadSketchOffsetEditor';
import { cadSketchWholeGeneratorCommands } from './cadSketchWholeGeneratorCommands';

const square = (at: number, construction = false): Pick<CadSketchGraph, 'points' | 'entities'> => {
  const corners = [[at, 0], [at + 10, 0], [at + 10, 10], [at, 10]] as const;
  return { points: corners.map((position, index) => ({ id: `p${index}`, position: [...position] })),
    entities: corners.map((_, index) => ({ id: `l${index}`, kind: 'line', construction, startPointId: `p${index}`, endPointId: `p${(index + 1) % 4}` })) };
};
/** The commands on generator `id` of a sketch holding `relations` and `geometry`, selected as a whole, with the shape's edge ids. */
function commands(relations: readonly unknown[], id: string, geometry: Pick<CadSketchGraph, 'points' | 'entities'> = { points: [], entities: [] }) {
  const document = parseCadDocument({ ...createCadDocument('Kinds', 'whole-generator-kinds'), schemaVersion: 2, features: [{ id: 'sketch', kind: 'sketch', name: 'Shapes',
    suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: { ...geometry, relations } }] });
  const sketch = document.features[0] as CadSketchFeature, generator = cadSketchWholeGenerator(sketch, id);
  if (!sketch.graph || !generator) throw new Error(`Missing ${id}.`);
  const source = cadSketchOffsetSource(sketch, document.parameters, [], id);
  return { ...cadSketchWholeGeneratorCommands(sketch.graph, generator, Boolean(source)), edges: cadSketchGeneratorMembers(sketch.graph, generator).entityIds, source };
}
const generator = (id: string, geometry: unknown, construction = false) => ({ id, kind: 'generator', idPrefix: id, construction, geometry });
const owned = (name: string) => `${name} generates this geometry. Edit the generator's inputs, or detach it, before editing generated geometry.`;
const pattern = 'Linear pattern repeats one selected free circle.';

describe('the profile toolbar on a generator selected as a whole', () => {
  it('works on each kind, or names why not, and never falls back to the drawing defaults', () => {
    const offsetOf = (chain: readonly string[]) => ({ kind: 'offset', chain: chain.map(entityId => ({ entityId, reversed: false })), distance: 2 });
    const kinds = {
      rectangle: commands([generator('plate', { kind: 'rectangle', x: 0, y: 0, width: 20, height: 10, cornerRadius: 0 })], 'plate'),
      circle: commands([generator('hole', { kind: 'circle', x: 0, y: 0, radius: 2 })], 'hole'),
      slot: commands([generator('slot', { kind: 'slot', x: 0, y: 0, length: 10, width: 4, angle: 0 })], 'slot'),
      'regular polygon': commands([generator('hex', { kind: 'regular-polygon', x: 0, y: 0, radius: 5, sides: 6, directionId: '@h' })], 'hex'),
      polygon: commands([generator('tri', { kind: 'polygon', points: [[0, 0], [10, 0], [5, 8]] })], 'tri'),
      path: commands([generator('round', { kind: 'path', segments: [{ kind: 'arc', center: [0, 0], radius: 3, startAngle: 0, sweep: 180 },
        { kind: 'arc', center: [0, 0], radius: 3, startAngle: 180, sweep: 180 }] })], 'round'),
      'circular pattern': commands([generator('spokes', { kind: 'circular-pattern', seedIds: ['l0'], centerId: '@origin', count: 4, angle: 360 })], 'spokes', square(20)),
      offset: commands([generator('wall', offsetOf(['l0', 'l1', 'l2', 'l3']))], 'wall', square(20)),
      plugin: commands([generator('star', createCadPluginProfile(CAD_STAR_PLUGIN))], 'star'),
    };
    const rows = Object.fromEntries(Object.entries(kinds).map(([kind, { edges: _edges, source: _source, ...row }]) => [kind, { ...row, mirror: row.mirror.reason ?? row.mirror.entityIds.length }]));
    expect(rows).toEqual({
      rectangle: { move: null, offset: null, mirror: 4, pattern, corners: null, construction: { checked: false, reason: null } },
      circle: { move: null, offset: null, mirror: 1, pattern: owned('Circle "hole"'), corners: 'Circle "hole" has no corners to round.', construction: { checked: false, reason: null } },
      slot: { move: null, offset: null, mirror: 4, pattern, corners: 'Slot "slot" has no corners to round.', construction: { checked: false, reason: null } },
      'regular polygon': { move: 'Regular polygon "hex" is placed by its centre. Set its Center X and Y inputs to move it.', offset: null, mirror: 6, pattern,
        corners: owned('Regular polygon "hex"'), construction: { checked: false, reason: null } },
      polygon: { move: null, offset: null, mirror: 3, pattern, corners: owned('Polygon "tri"'), construction: { checked: false, reason: null } },
      path: { move: null, offset: null, mirror: 2, pattern, corners: owned('Path "round"'), construction: { checked: false, reason: null } },
      'circular pattern': { move: 'Circular pattern "spokes" follows its seeds and centre. Move those to move it.',
        offset: 'Circular pattern "spokes" does not make one closed loop of its own edges. Select an edge of the loop to offset.', mirror: 3, pattern,
        corners: owned('Circular pattern "spokes"'), construction: { checked: false, reason: null } },
      offset: { move: 'Offset "wall" follows the loop it offsets. Move that loop to move it.', offset: null, mirror: kinds.offset.edges.length, pattern,
        corners: owned('Offset "wall"'), construction: { checked: false, reason: null } },
      plugin: { move: 'Move a generated plugin contour through its placement configuration.', offset: null, mirror: 16, pattern,
        corners: owned('Star profile "star"'), construction: { checked: false, reason: null } },
    });
    // Where Offset loop works, its source is the one loop made of exactly the shape's edges.
    for (const [kind, { edges, source }] of Object.entries(kinds)) {
      if (kind === 'circular pattern') { expect(source, kind).toBeNull(); continue; }
      expect(source?.kind === 'graph-cycle' && source.sourceRefs.map(ref => ref.entityId).sort(), kind).toEqual([...edges].sort());
    }
  });

  it('says why a construction shape has no loop, a pattern of construction seeds stays construction, and a gear is too long to mirror', () => {
    expect(commands([generator('plate', { kind: 'rectangle', x: 0, y: 0, width: 20, height: 10, cornerRadius: 0 }, true)], 'plate')).toMatchObject({
      offset: 'Rectangle "plate" is construction geometry, so it has no loop to offset.', construction: { checked: true, reason: null } });
    const seeds = commands([generator('spokes', { kind: 'circular-pattern', seedIds: ['l0'], centerId: '@origin', count: 4, angle: 360 })], 'spokes', square(20, true));
    expect(seeds).toMatchObject({ offset: 'Circular pattern "spokes" is construction geometry, so it has no loop to offset.',
      construction: { checked: true, reason: 'Circular pattern "spokes" copies construction seeds, so its copies stay construction. Change the seeds instead.' } });
    const gear = createCadPluginProfile(CAD_GEAR_V3_PLUGIN);
    const many = commands([generator('gear', { ...gear, inputs: { ...gear.inputs, teeth: 12 } })], 'gear');
    expect(many.edges).toHaveLength(600);
    expect(many.mirror).toEqual({ reason: 'Mirror copy takes at most 64 edges, and Spur gear "gear" has 600.' });
  });
});
