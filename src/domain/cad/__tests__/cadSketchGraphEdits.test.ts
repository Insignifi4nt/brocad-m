import { describe, expect, it } from 'vitest';
import type { CadSketchFeature } from '../cadDocument';
import { checkCadSketchGraph, parseCadSketchGraph, type CadSketchGraph } from '../cadSketchGraph';
import { appendCadSketchEntities, deleteCadSketchElements, prepareCadSketchDeletion, setCadSketchConstruction } from '../cadSketchGraphEdits';
import { applyCadEdits, reduceCadEditIntents } from '../cadOperations';
import { createCadDocument, parseCadDocument } from '../cadSchema';

function sketch(): CadSketchFeature {
  return { id: 'sketch', kind: 'sketch', name: 'Sketch', suppressed: false, plane: 'XY', offset: 0,
    profiles: [{ id: 'profile', name: 'Legacy circle', construction: true, geometry: { kind: 'circle', x: 0, y: 0, radius: ' radius ' } }],
    graph: parseCadSketchGraph({ points: [{ id: 'a', position: [' origin ', 0] }], entities: [], relations: [] }) };
}

describe('sketch graph authoring intent', () => {
  it('appends new identities referencing existing points, retains exact drivers and leaves solving to acceptance', () => {
    const source = sketch(), before = JSON.stringify(source);
    const geometry = { points: [{ id: 'b', position: [10, 3] }],
      entities: [{ id: 'ab', kind: 'line', startPointId: 'a', endPointId: 'b', construction: false }],
      relations: [{ id: 'horizontal', kind: 'horizontal', pointIds: ['a', 'b'] }]
    } satisfies CadSketchGraph;
    const result = appendCadSketchEntities({ sketch: source, geometry });
    geometry.points[0].position[1] = 99;
    expect(result.graph?.points).toEqual([{ id: 'a', position: [' origin ', 0] }, { id: 'b', position: [10, 3] }]);
    expect(result.profiles).toBe(source.profiles);
    expect(Object.isFrozen(result.graph?.points[1].position)).toBe(true);
    if (!result.graph) throw new Error('Appended graph missing.');
    expect(checkCadSketchGraph(result.graph, { origin: 0 })).toMatchObject([{ source: { id: 'horizontal' }, code: 'relation-residual' }]);
    expect(JSON.stringify(source)).toBe(before);
  });

  it('rejects identity reuse and missing references atomically, including legacy profile identities', () => {
    const source = sketch(), before = JSON.stringify(source);
    const invalid: CadSketchGraph[] = [
      { points: [{ id: 'a', position: [3, 4] }], entities: [], relations: [] },
      { points: [{ id: 'profile', position: [3, 4] }], entities: [], relations: [] },
      { points: [], entities: [{ id: 'a', kind: 'circle', centerPointId: 'a', radius: 5, construction: false }], relations: [] },
      { points: [], entities: [], relations: [{ id: 'a', kind: 'fixed-point', pointId: 'a', position: [0, 0] }] },
      { points: [], entities: [{ id: 'arc', kind: 'arc', centerPointId: 'a', startPointId: 'missing', endPointId: 'other', direction: 'cw', construction: false }], relations: [] }
    ];
    for (const geometry of invalid) {
      expect(() => appendCadSketchEntities({ sketch: source, geometry })).toThrow();
      expect(JSON.stringify(source)).toBe(before);
    }
    const document = parseCadDocument({ ...createCadDocument('Part', 'part'), schemaVersion: 2, parameters: { origin: 0, radius: 5 }, features: [source] });
    const graph = source.graph;
    if (!graph) throw new Error('Graph fixture missing.');
    expect(() => applyCadEdits(document, [{ kind: 'update-feature', feature: { ...source, graph: { ...graph,
      entities: [{ id: 'profile', kind: 'circle', centerPointId: 'a', radius: 2, construction: false }]
    } } }])).toThrow('legacy profile');
    expect(() => applyCadEdits(document, [{ kind: 'set-sketch-relation', sketchId: 'sketch', relation: {
      id: 'profile', kind: 'fixed-axis', pointId: 'a', axis: 'x', value: 0
    } }])).toThrow('legacy profile');
  });

  it('requires explicit dependency deletion and cascades only references to the selected points', () => {
    const source = appendCadSketchEntities({ sketch: sketch(), geometry: {
      points: [{ id: 'b', position: [10, 0] }, { id: 'c', position: [0, 10] }, { id: 'orphan', position: [' untouched ', 8] }],
      entities: [
        { id: 'ab', kind: 'line', startPointId: 'a', endPointId: 'b', construction: false },
        { id: 'arc', kind: 'arc', centerPointId: 'a', startPointId: 'b', endPointId: 'c', direction: 'cw', construction: false },
        { id: 'bc', kind: 'line', startPointId: 'b', endPointId: 'c', construction: false },
        { id: 'circle', kind: 'circle', centerPointId: 'c', radius: ' radius ', construction: true }
      ], relations: [
        { id: 'horizontal', kind: 'horizontal', pointIds: ['a', 'b'] },
        { id: 'axis', kind: 'fixed-axis', pointId: 'a', axis: 'x', value: ' origin ' },
        { id: 'distance', kind: 'distance', pointIds: ['b', 'c'], value: ' height ' }
      ]
    } }), before = JSON.stringify(source);
    const selected = { sketch: source, pointIds: ['a'], entityIds: [], relationIds: [] };
    expect(() => deleteCadSketchElements({ ...selected, cascade: false })).toThrow('depend');
    const cascaded = deleteCadSketchElements({ ...selected, cascade: true });
    expect(cascaded.graph?.points.map(point => point.id)).toEqual(['b', 'c', 'orphan']);
    expect(cascaded.graph?.entities.map(entity => entity.id)).toEqual(['bc', 'circle']);
    expect(cascaded.graph?.relations.map(relation => relation.id)).toEqual(['distance']);
    expect(cascaded.graph?.points[2].position).toEqual([' untouched ', 8]);
    expect(cascaded.graph?.entities[1]).toMatchObject({ radius: ' radius ', construction: true });
    expect(deleteCadSketchElements({ ...selected, entityIds: ['ab', 'arc'], relationIds: ['horizontal', 'axis'], cascade: false })).toEqual(cascaded);
    const entityOnly = deleteCadSketchElements({ sketch: source, pointIds: [], entityIds: ['ab'], relationIds: [], cascade: false });
    expect(entityOnly.graph?.points).toEqual(source.graph?.points);
    expect(entityOnly.graph?.relations).toEqual(source.graph?.relations);
    expect(JSON.stringify(source)).toBe(before);
  });

  it('prepares a deletion that takes the relations on what it deletes as an exact set, and applies only while they are exactly those', () => {
    const source = appendCadSketchEntities({ sketch: sketch(), geometry: {
      points: [{ id: 'b', position: [10, 0] }, { id: 'c', position: [0, 10] }],
      entities: [{ id: 'ab', kind: 'line', startPointId: 'a', endPointId: 'b', construction: false }, { id: 'bc', kind: 'line', startPointId: 'b', endPointId: 'c', construction: false }],
      relations: [{ id: 'horizontal', kind: 'horizontal', pointIds: ['a', 'b'] }, { id: 'distance', kind: 'distance', pointIds: ['b', 'c'], value: 14 }]
    } });
    // Point a takes the line on it and the horizontal relation that uses both, unasked, while the distance stays.
    const prepared = prepareCadSketchDeletion({ sketch: source, pointIds: ['a'], entityIds: [], relationIds: [], name: 'this point' });
    expect(prepared.edit).toEqual({ kind: 'delete-sketch-elements', sketchId: 'sketch', pointIds: ['a'], entityIds: ['ab'], relationIds: ['horizontal'], cascade: false });
    expect(prepared.removed).toEqual([]);
    const { kind: _kind, sketchId: _sketchId, ...edit } = prepared.edit;
    expect(deleteCadSketchElements({ ...edit, sketch: source })).toEqual(deleteCadSketchElements({ sketch: source, pointIds: ['a'], entityIds: [], relationIds: [], cascade: true }));
    // A relation on the line added since it was prepared is one the set does not list, so the set no longer applies.
    const grown = appendCadSketchEntities({ sketch: source, geometry: { points: [], entities: [], relations: [{ id: 'level', kind: 'horizontal', pointIds: ['b', 'a'] }] } });
    expect(() => deleteCadSketchElements({ ...edit, sketch: grown })).toThrow('depend');
  });

  it('names only the shapes made from what a deletion deletes, which go only once their IDs are listed too', () => {
    const part = applyCadEdits(parseCadDocument({ ...createCadDocument('Part', 'part'), schemaVersion: 2, parameters: {},
      features: [{ id: 'sketch', kind: 'sketch', name: 'Sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
        points: [{ id: 'k', position: [15, 0] }, { id: 'm', position: [25, 0] }], entities: [{ id: 'c', kind: 'circle', construction: false, centerPointId: 'k', radius: 2 }],
        relations: [{ id: 'level', kind: 'horizontal', pointIds: ['k', 'm'] }] } }] }), [
      { kind: 'set-sketch-generator', sketchId: 'sketch', generator: { id: 'spin', kind: 'generator', idPrefix: 'spin', construction: false,
        geometry: { kind: 'circular-pattern', seedIds: ['c'], centerId: '@origin', count: 2, angle: 360 } } }
    ]);
    const source = part.features[0] as CadSketchFeature;
    const prepared = prepareCadSketchDeletion({ sketch: source, pointIds: ['k'], entityIds: [], relationIds: [], name: 'this point' });
    expect(prepared.edit).toEqual({ kind: 'delete-sketch-elements', sketchId: 'sketch', pointIds: ['k'], entityIds: ['c'], relationIds: ['level'], cascade: false });
    expect(prepared.removed).toEqual([{ sketchId: 'sketch', relationId: 'spin', name: 'Circular pattern "spin"', generator: 'this point', reason: 'It is generated from geometry this deletes.' }]);
    const { kind: _kind, sketchId: _sketchId, ...edit } = prepared.edit;
    expect(() => deleteCadSketchElements({ ...edit, sketch: source })).toThrow('generated from the selected geometry');
    expect(deleteCadSketchElements({ ...edit, sketch: source, relationIds: [...edit.relationIds, 'spin'] }))
      .toEqual(deleteCadSketchElements({ sketch: source, pointIds: ['k'], entityIds: [], relationIds: [], cascade: true }));
  });

  it('refuses before asking a deletion its confirmed set could not make, such as a linear pattern seeded by a circle a circular pattern copies', () => {
    const part = applyCadEdits(parseCadDocument({ ...createCadDocument('Part', 'part'), schemaVersion: 2, parameters: {},
      features: [{ id: 'sketch', kind: 'sketch', name: 'Sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
        points: [{ id: 'k', position: [15, 0] }], entities: [{ id: 'c', kind: 'circle', construction: false, centerPointId: 'k', radius: 2 }], relations: [] } }] }), [
      { kind: 'set-sketch-generator', sketchId: 'sketch', generator: { id: 'spin', kind: 'generator', idPrefix: 'spin', construction: false,
        geometry: { kind: 'circular-pattern', seedIds: ['c'], centerId: '@origin', count: 2, angle: 360 } } },
      { kind: 'set-sketch-relation', sketchId: 'sketch', relation: { id: 'row', kind: 'linear-pattern', seed: { kind: 'circle', entityId: 'spin_i1_c', centerPointId: 'spin_i1_k' },
        idPrefix: 'holes', direction: '+x', count: 2, spacing: 10, omittedInstances: [] } }
    ]);
    const source = part.features[0] as CadSketchFeature;
    // A cascade would take the row with the copy it is seeded by, but the row's own relation is never deleted on its own.
    expect(() => deleteCadSketchElements({ sketch: source, pointIds: [], entityIds: [], relationIds: ['spin', 'row'], cascade: false })).toThrow('detach the pattern');
    expect(() => prepareCadSketchDeletion({ sketch: source, pointIds: [], entityIds: [], relationIds: ['spin'], name: 'Circular pattern "spin"' })).toThrow('detach the pattern');
    expect(() => prepareCadSketchDeletion({ sketch: source, pointIds: [], entityIds: ['c'], relationIds: [], name: 'this circle' })).toThrow('detach the pattern');
  });

  it('changes construction only on exact entity IDs and rejects stale or wrong-category targets', () => {
    const source = appendCadSketchEntities({ sketch: sketch(), geometry: { points: [], relations: [], entities: [
      { id: 'circle', kind: 'circle', centerPointId: 'a', radius: ' radius ', construction: false },
      { id: 'guide', kind: 'circle', centerPointId: 'a', radius: 20, construction: true }
    ] } }), before = JSON.stringify(source);
    const changed = setCadSketchConstruction({ sketch: source, entityIds: ['circle'], construction: true });
    expect(changed.graph?.entities).toEqual([
      { id: 'circle', kind: 'circle', centerPointId: 'a', radius: ' radius ', construction: true },
      { id: 'guide', kind: 'circle', centerPointId: 'a', radius: 20, construction: true }
    ]);
    expect(changed.graph?.points).toEqual(source.graph?.points);
    expect(changed.profiles).toBe(source.profiles);
    expect(() => setCadSketchConstruction({ sketch: source, entityIds: ['circle', 'a'], construction: true })).toThrow('entity');
    expect(() => deleteCadSketchElements({ sketch: source, pointIds: [], entityIds: [], relationIds: ['circle'], cascade: true })).toThrow('relation');
    expect(() => deleteCadSketchElements({ sketch: source, pointIds: ['missing'], entityIds: [], relationIds: [], cascade: true })).toThrow('point');
    expect(JSON.stringify(source)).toBe(before);
  });

  it('introduces schema 2 through explicit accepted append and keeps unsolved relations out of accepted data', () => {
    const legacy = parseCadDocument({ ...createCadDocument('Legacy', 'legacy'), parameters: { radius: 5 }, features: [{
      id: 'sketch', kind: 'sketch', name: 'Sketch', suppressed: false, plane: 'XY', offset: 0, profiles: sketch().profiles
    }] });
    const append = { kind: 'append-sketch-entities', sketchId: 'sketch', geometry: {
      points: [{ id: 'a', position: ['0', '0'] }, { id: 'b', position: [10, 3] }],
      entities: [{ id: 'ab', kind: 'line', startPointId: 'a', endPointId: 'b', construction: false }], relations: []
    } } as const;
    const accepted = applyCadEdits(legacy, [append]);
    expect(accepted.schemaVersion).toBe(2);
    expect(legacy.schemaVersion).toBe(1);
    const relation = { kind: 'append-sketch-entities', sketchId: 'sketch', geometry: {
      points: [], entities: [], relations: [{ id: 'horizontal', kind: 'horizontal', pointIds: ['a', 'b'] }]
    } } as const;
    expect(reduceCadEditIntents(accepted, [relation]).features[0]).toMatchObject({ graph: { relations: [{ id: 'horizontal' }] } });
    expect(() => applyCadEdits(accepted, [relation])).toThrow('satisfy');
    expect(accepted.features[0]).toMatchObject({ graph: { relations: [] } });
  });

  it('keeps downstream feature validation atomic instead of cascading outside the sketch', () => {
    const source = applyCadEdits(createCadDocument('Part', 'part'), [
      { kind: 'set-parameter', name: 'radius', value: 5 },
      { kind: 'add-feature', feature: { id: 'sketch', kind: 'sketch', name: 'Sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [] } },
      { kind: 'append-sketch-entities', sketchId: 'sketch', geometry: { points: [{ id: 'center', position: ['0', '0'] }], relations: [],
        entities: [{ id: 'circle', kind: 'circle', centerPointId: 'center', radius: ' radius ', construction: false }] } },
      { kind: 'add-feature', feature: { id: 'pad', kind: 'extrude', name: 'Pad', suppressed: false, sketchId: 'sketch', distance: 5, symmetric: false, operation: 'new', targetId: null } }
    ]), before = JSON.stringify(source);
    expect(() => applyCadEdits(source, [{ kind: 'rename-document', name: 'Unaccepted' },
      { kind: 'delete-sketch-elements', sketchId: 'sketch', pointIds: ['center'], entityIds: [], relationIds: [], cascade: true }
    ])).toThrow('nonempty sketch');
    expect(() => applyCadEdits(source, [{ kind: 'set-sketch-construction', sketchId: 'sketch', entityIds: ['circle'], construction: true }])).toThrow('nonempty sketch');
    expect(JSON.stringify(source)).toBe(before);
    const pad = source.features[1];
    const accepted = applyCadEdits(source, [{ kind: 'update-feature', feature: { ...pad, suppressed: true } },
      { kind: 'set-sketch-construction', sketchId: 'sketch', entityIds: ['circle'], construction: true }
    ]);
    expect(accepted.features[0]).toMatchObject({ graph: {
      points: [{ id: 'center', position: ['0', '0'] }], entities: [{ id: 'circle', radius: ' radius ', construction: true }]
    } });
    expect(accepted.features.map(feature => feature.id)).toEqual(['sketch', 'pad']);
  });
});
