import { describe, expect, it } from 'vitest';
import { parseCadSketchGraph, type CadSketchAnnotatedRelation, type CadSketchGraph, type CadSketchGraphRelation } from '../cadSketchGraph';
import { createCadDocument, parseCadDocument } from '../cadSchema';
import { createCadSketchCornerTreatment } from '../cadSketchCornerTreatment';
import { createCadFreshSketchGraph } from '../cadFreshSketchGraph';
import {
  cadSketchDimensionPlacementOf, cadSketchFeaturesEqualButPlacement, cadSketchGraphsEqualButPlacement, cadSketchGraphWithoutPlacement, cadSketchRelationsEqualButPlacement,
  withCadSketchCarriedPlacement, withCadSketchDimensionPlacement, withoutCadSketchDimensionAnnotation
} from '../cadSketchPlacedDimensions';
import { applyCadEdits, type CadEdit } from '../cadOperations';
import type { CadDocument } from '../cadDocument';
import { mirrorBoreRequest, pairedBoreMirrorPart } from './cadSketchMirrorFixtures';
import { circleRow, circleRowPart } from './cadSketchLinearPatternFixtures';
import { offsetGraphPart } from './cadSketchOffsetFixtures';
import { lineReferencePart, lineUseReference } from './cadSketchExternalReferenceFixtures';
import { extendPart, lineExtend } from './cadSketchExtendFixtures';

/** A 40 × 30 corner, a hole and two lines meeting at a, with a driving or reference dimension of each kind that can be placed. */
const source = (relations: readonly unknown[]) => ({
  points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [40, 0] }, { id: 'c', position: [40, 30] }, { id: 'o', position: [10, 10] }],
  entities: [{ id: 'base', kind: 'line', startPointId: 'a', endPointId: 'b', construction: false }, { id: 'side', kind: 'line', startPointId: 'b', endPointId: 'c', construction: false },
    { id: 'hole', kind: 'circle', centerPointId: 'o', radius: 4, construction: false }],
  relations
});
const linear = { kind: 'linear', offset: -6.5, along: 1.75 } as const, angle = { kind: 'angle', radius: 12, along: -0.25 } as const;
const radial = { kind: 'radial', angle: -Math.PI, distance: 0 } as const;
/** A stored placement, or none: a file without one has no annotation field at all. */
const stored = (annotation: unknown) => annotation === undefined ? {} : { annotation };
const placedRelations = (annotations: { linear?: unknown; angle?: unknown; radial?: unknown } = { linear, angle, radial }) => [
  { id: 'length', kind: 'distance', pointIds: ['a', 'b'], value: 'width', ...stored(annotations.linear) },
  { id: 'gap', kind: 'point-line-distance', pointId: 'o', lineId: 'base', side: 'left', value: 10, ...stored(annotations.linear) },
  { id: 'across', kind: 'axis-distance', pointIds: ['a', 'c'], axis: 'x', value: 40, ...stored(annotations.linear) },
  { id: 'x', kind: 'fixed-axis', pointId: 'o', axis: 'x', value: 10, ...stored(annotations.linear) },
  { id: 'corner', kind: 'line-angle', rays: [{ lineId: 'base', towardPointId: 'a' }, { lineId: 'side', towardPointId: 'c' }], sense: 'cw', value: 90, ...stored(annotations.angle) },
  // A leader across near-parallel lines takes the linear form.
  { id: 'leader', kind: 'line-angle', rays: [{ lineId: 'base', towardPointId: 'b' }, { lineId: 'side', towardPointId: 'c' }], sense: 'ccw', value: 90, ...stored(annotations.linear) },
  { id: 'size', kind: 'radial-size', entityId: 'hole', quantity: 'diameter', value: 8, ...stored(annotations.radial) },
  { id: 'measured', kind: 'reference-dimension', measurement: { kind: 'line-length', entityId: 'side' }, ...stored(annotations.linear) },
  { id: 'apart', kind: 'reference-dimension', measurement: { kind: 'point-distance', pointIds: ['o', 'c'] }, ...stored(annotations.linear) },
  { id: 'clear', kind: 'reference-dimension', measurement: { kind: 'point-line-distance', pointId: 'o', lineId: 'side' }, ...stored(annotations.linear) },
  { id: 'bore', kind: 'reference-dimension', measurement: { kind: 'radial-size', entityId: 'hole', quantity: 'radius' }, ...stored(annotations.radial) }
];
const relation = (graph: CadSketchGraph, id: string) => { const found = graph.relations.find(item => item.id === id); if (!found) throw new Error(`${id} missing.`); return found; };
function ids(prefix: string) { let n = 0; return () => `${prefix}_${++n}`; }
const rectangle = () => createCadFreshSketchGraph({ geometry: { kind: 'rectangle', x: 0, y: 0, width: 20, height: 10, cornerRadius: 0 }, construction: false, createId: ids('original') });

describe('stored dimension placement', () => {
  it('reads every placement variant on each dimension kind that takes it, and keeps a graph without placements exactly as it was', () => {
    const graph = parseCadSketchGraph(source(placedRelations()));
    for (const [id, annotation] of [['length', linear], ['gap', linear], ['across', linear], ['x', linear], ['corner', angle], ['leader', linear], ['size', radial],
      ['measured', linear], ['apart', linear], ['clear', linear], ['bore', radial]] as const) expect(relation(graph, id)).toMatchObject({ annotation });
    expect(Object.isFrozen((relation(graph, 'length') as { annotation?: object }).annotation)).toBe(true);
    // Without placements nothing gains an annotation field, so older files read and draw as before.
    const plain = parseCadSketchGraph(source(placedRelations({})));
    expect(plain.relations.some(item => 'annotation' in item)).toBe(false);
    expect(cadSketchGraphWithoutPlacement(plain)).toBe(plain);
    expect(cadSketchGraphWithoutPlacement(graph)).toEqual(plain);
  });

  it('reads fillet radii and both, one or neither placed chamfer setback', () => {
    const fillet = createCadSketchCornerTreatment({ graph: rectangle(), parameters: {}, pointId: 'original_1', treatment: { kind: 'fillet', radius: 2 }, createId: ids('f') }).graph;
    const placedFillet = parseCadSketchGraph({ ...fillet, relations: fillet.relations.map(item => item.kind === 'fillet-corner' ? { ...item, annotation: radial } : item) });
    expect(placedFillet.relations.at(-1)).toMatchObject({ kind: 'fillet-corner', annotation: radial });
    const chamfer = createCadSketchCornerTreatment({ graph: rectangle(), parameters: {}, pointId: 'original_1', treatment: { kind: 'chamfer', setbacks: [2, 3] }, createId: ids('c') }).graph;
    const withSides = (sides: unknown) => parseCadSketchGraph({ ...chamfer, relations: chamfer.relations.map(item => item.kind === 'chamfer-corner' ? { ...item, annotation: { kind: 'setbacks', sides } } : item) });
    for (const sides of [[{ offset: 1, along: 0.5 }, { offset: -2, along: 3 }], [null, { offset: 0, along: 0 }], [{ offset: 4, along: -1 }, null], [null, null]])
      expect(withSides(sides).relations.at(-1)).toMatchObject({ kind: 'chamfer-corner', annotation: { kind: 'setbacks', sides } });
    for (const sides of [[{ offset: 1, along: 0.5 }], [{ offset: 1, along: 0.5 }, null, null], [{ offset: 1, along: 0.5, radius: 2 }, null], [{ kind: 'linear', offset: 1, along: 0.5 }, null]])
      expect(() => withSides(sides)).toThrow();
    expect(() => parseCadSketchGraph({ ...chamfer, relations: chamfer.relations.map(item => item.kind === 'chamfer-corner' ? { ...item, annotation: linear } : item) })).toThrow();
  });

  it.each([
    ['an offset beyond a kilometre', 'length', { kind: 'linear', offset: 2e6, along: 0.5 }],
    ['text far beyond the line', 'length', { kind: 'linear', offset: 1, along: -2e4 }],
    ['a value that is not a number', 'gap', { kind: 'linear', offset: Number.NaN, along: 0.5 }],
    ['an infinite value', 'x', { kind: 'linear', offset: 1, along: Number.POSITIVE_INFINITY }],
    ['a value written as text', 'across', { kind: 'linear', offset: '1', along: 0.5 }],
    ['an unknown field', 'length', { kind: 'linear', offset: 1, along: 0.5, side: 'left' }],
    ['a missing field', 'length', { kind: 'linear', offset: 1 }],
    ['a radial form on a distance', 'length', radial],
    ['an angle form on a point to line distance', 'gap', angle],
    ['chamfer setbacks on a distance', 'length', { kind: 'setbacks', sides: [null, null] }],
    ['a linear form on a diameter', 'size', linear],
    ['an arc of no radius', 'corner', { kind: 'angle', radius: 0, along: 0.5 }],
    ['a radial form on an angle', 'corner', radial],
    ['a leader turned past a half turn', 'size', { kind: 'radial', angle: 4, distance: 5 }],
    ['text inside the centre', 'size', { kind: 'radial', angle: 0, distance: -1 }],
    ['an unknown kind', 'length', { kind: 'free', offset: 1, along: 0.5 }],
    ['a radial form on a reference length', 'measured', radial],
    ['a linear form on a reference radius', 'bore', linear]
  ] as const)('refuses %s', (_name, id, annotation) => {
    const relations = placedRelations({}).map(item => item.id === id ? { ...item, annotation } : item);
    expect(() => parseCadSketchGraph(source(relations))).toThrow();
  });

  it('names a reference placed as another kind of dimension', () => {
    const relations = placedRelations({}).map(item => item.id === 'bore' ? { ...item, annotation: linear } : item);
    expect(() => parseCadSketchGraph(source(relations))).toThrow(expect.objectContaining({ code: 'invalid-sketch-annotation', message: expect.stringContaining('"bore"') }));
    // A placement on a relation that is not a dimension is refused as an unknown field.
    expect(() => parseCadSketchGraph(source([{ id: 'level', kind: 'horizontal', pointIds: ['a', 'b'], annotation: linear }]))).toThrow();
  });

  it('saves and reads placements with the document', () => {
    const document = parseCadDocument({ ...createCadDocument('Placed', 'placed'), schemaVersion: 2, parameters: { width: 40 }, features: [{ id: 'sketch', kind: 'sketch', name: 'Sketch',
      suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: source(placedRelations()) }] });
    expect(parseCadDocument(JSON.parse(JSON.stringify(document)))).toEqual(document);
  });
});

describe('placement helpers', () => {
  const graph = parseCadSketchGraph(source(placedRelations({})));
  const distance = relation(graph, 'length'), chamfer = (() => {
    const treated = createCadSketchCornerTreatment({ graph: rectangle(), parameters: {}, pointId: 'original_1', treatment: { kind: 'chamfer', setbacks: [2, 3] }, createId: ids('c') }).graph;
    const found = treated.relations.at(-1); if (found?.kind !== 'chamfer-corner') throw new Error('Chamfer missing.');
    return found;
  })();

  it('places, reads and removes one part, and keeps a chamfer\'s other setback', () => {
    const placed = withCadSketchDimensionPlacement(distance, 0, linear);
    expect(placed).toEqual({ ...distance, annotation: linear }); expect(cadSketchDimensionPlacementOf(placed)).toEqual(linear);
    expect(withCadSketchDimensionPlacement(placed, 0, undefined)).toEqual(distance); expect('annotation' in withCadSketchDimensionPlacement(placed, 0, undefined)).toBe(false);
    expect(withoutCadSketchDimensionAnnotation(distance)).toBe(distance);
    const second = withCadSketchDimensionPlacement(chamfer, 1, { kind: 'linear', offset: 2, along: 0.25 });
    expect(second.annotation).toEqual({ kind: 'setbacks', sides: [null, { offset: 2, along: 0.25 }] });
    expect(cadSketchDimensionPlacementOf(second, 0)).toBeUndefined(); expect(cadSketchDimensionPlacementOf(second, 1)).toEqual({ kind: 'linear', offset: 2, along: 0.25 });
    const both = withCadSketchDimensionPlacement(second, 0, linear);
    expect(both.annotation).toEqual({ kind: 'setbacks', sides: [{ offset: linear.offset, along: linear.along }, { offset: 2, along: 0.25 }] });
    expect(withCadSketchDimensionPlacement(both, 1, undefined).annotation).toEqual({ kind: 'setbacks', sides: [{ offset: linear.offset, along: linear.along }, null] });
    // With neither setback placed the chamfer has no annotation at all.
    expect(withCadSketchDimensionPlacement(second, 1, undefined)).toEqual(chamfer); expect('annotation' in withCadSketchDimensionPlacement(second, 1, undefined)).toBe(false);
    // A form the setback cannot take lays it out automatically.
    expect(withCadSketchDimensionPlacement(second, 1, radial)).toEqual(chamfer);
  });

  it('tells a change of placement alone from a change of what is measured', () => {
    const placed = withCadSketchDimensionPlacement(distance, 0, linear), moved = withCadSketchDimensionPlacement(distance, 0, { ...linear, offset: 3 });
    expect(cadSketchRelationsEqualButPlacement(placed, moved)).toBe(true); expect(cadSketchRelationsEqualButPlacement(placed, distance)).toBe(true);
    expect(cadSketchRelationsEqualButPlacement(placed, { ...moved, value: 41 } as CadSketchGraphRelation)).toBe(false);
    const swapped = (relations: readonly CadSketchGraphRelation[]): CadSketchGraph => ({ ...graph, relations });
    const withMoved = swapped(graph.relations.map(item => item.id === 'length' ? moved : item));
    expect(cadSketchGraphsEqualButPlacement(graph, withMoved)).toBe(true);
    expect(cadSketchGraphsEqualButPlacement(graph, swapped(graph.relations.map(item => item.id === 'length' ? { ...moved, pointIds: ['b', 'a'] as const } : item)))).toBe(false);
    expect(cadSketchGraphsEqualButPlacement(graph, swapped(graph.relations.slice(1)))).toBe(false);
    expect(cadSketchGraphsEqualButPlacement(graph, { ...withMoved, points: graph.points.map(point => point.id === 'b' ? { ...point, position: [41, 0] as const } : point) })).toBe(false);
    const feature = { id: 'sketch', kind: 'sketch', name: 'Sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph } as const;
    expect(cadSketchFeaturesEqualButPlacement(feature, { ...feature, graph: withMoved })).toBe(true);
    expect(cadSketchFeaturesEqualButPlacement(feature, { ...feature, graph: withMoved, name: 'Renamed' })).toBe(false);
    expect(cadSketchFeaturesEqualButPlacement(feature, { ...feature, graph: withMoved, offset: 1 })).toBe(false);
    expect(cadSketchFeaturesEqualButPlacement(feature, undefined)).toBe(false);
  });

  it('carries a placement onto the driving or reference form of the same dimension, turned round when its points are', () => {
    const placed = withCadSketchDimensionPlacement({ id: 'length', kind: 'distance', pointIds: ['b', 'c'], value: 30 } as const, 0, linear);
    // The side runs b to c, so its length is taken in the same order and keeps the placement.
    expect(withCadSketchCarriedPlacement(graph, placed, { id: 'length', kind: 'reference-dimension', measurement: { kind: 'line-length', entityId: 'side' } }))
      .toMatchObject({ annotation: linear });
    // Taken from c to b, the offset is on the other side and the text the other way along.
    const reversed = withCadSketchCarriedPlacement(graph, placed, { id: 'length', kind: 'reference-dimension', measurement: { kind: 'point-distance', pointIds: ['c', 'b'] } });
    expect(reversed).toMatchObject({ annotation: { kind: 'linear', offset: 6.5, along: -0.75 } });
    expect(withCadSketchCarriedPlacement(graph, reversed, placed)).toEqual(placed);
    const size = withCadSketchDimensionPlacement({ id: 'size', kind: 'radial-size', entityId: 'hole', quantity: 'radius', value: 4 } as const, 0, radial);
    const bore = { id: 'size', kind: 'reference-dimension', measurement: { kind: 'radial-size', entityId: 'hole', quantity: 'radius' } } as const;
    expect(withCadSketchCarriedPlacement(graph, size, bore)).toEqual({ ...bore, annotation: radial });
    // A form the other kind cannot take, or none, leaves it laid out automatically.
    expect(withCadSketchCarriedPlacement(graph, size, { id: 'length', kind: 'distance', pointIds: ['b', 'c'], value: 30 })).toEqual({ id: 'length', kind: 'distance', pointIds: ['b', 'c'], value: 30 });
    expect(withCadSketchCarriedPlacement(graph, distance, bore)).toBe(bore);
  });
});

describe('editing commands', () => {
  const dimensionKinds = new Set(['distance', 'point-line-distance', 'axis-distance', 'fixed-axis', 'line-angle', 'radial-size', 'fillet-corner', 'chamfer-corner', 'reference-dimension']);
  const relationsOf = (document: CadDocument, sketchId: string) => {
    const sketch = document.features.find(feature => feature.id === sketchId); if (sketch?.kind !== 'sketch' || !sketch.graph) throw new Error(`Sketch ${sketchId} missing.`);
    return sketch.graph.relations;
  };
  /** Each placed dimension of a sketch, by ID. */
  const placements = (document: CadDocument, sketchId: string) => relationsOf(document, sketchId).flatMap(relation => 'annotation' in relation && relation.annotation ? [[relation.id, relation.annotation]] : []);
  /** The dimensions an edit adds to a sketch. */
  const addedDimensions = (before: CadDocument, after: CadDocument, sketchId: string) => {
    const ids = new Set(relationsOf(before, sketchId).map(relation => relation.id));
    return relationsOf(after, sketchId).filter(relation => !ids.has(relation.id) && dimensionKinds.has(relation.kind));
  };
  const placed = (document: CadDocument, sketchId: string, relation: CadSketchGraphRelation) => applyCadEdits(document, [{ kind: 'set-sketch-relation', sketchId, relation }]);

  it.each<[string, () => CadDocument, string, CadSketchAnnotatedRelation, CadEdit]>([
    // Mirror copy copies geometry and its joins only.
    ['Mirror copy', () => pairedBoreMirrorPart(), 'sketch', { id: 'bore-x', kind: 'fixed-axis', pointId: 'bore-center', axis: 'x', value: 15, annotation: { kind: 'linear', offset: 9, along: .5 } },
      { kind: 'mirror-sketch-geometry', sketchId: 'sketch', ...mirrorBoreRequest }],
    // A pattern's copies follow their seed, so only a reference may measure the seed.
    ['Linear pattern', () => circleRowPart(true), 'sketch', { id: 'seed-size', kind: 'reference-dimension', measurement: { kind: 'radial-size', entityId: 'seed', quantity: 'radius' }, annotation: { kind: 'radial', angle: -1, distance: 2 } },
      { kind: 'set-sketch-relation', sketchId: 'sketch', relation: circleRow }],
    ['Offset loop', () => offsetGraphPart(), 'sketch', { id: 'width', kind: 'distance', pointIds: ['a', 'b'], value: 'span', annotation: { kind: 'linear', offset: -4, along: .2 } },
      { kind: 'offset-sketch-loop', sketchId: 'sketch', source: { kind: 'graph-cycle', sourceRefs: ['ab', 'bc', 'cd', 'da'].map(entityId => ({ entityId, reversed: false })) }, distance: 2, idPrefix: 'copy' }],
    ['Use reference', () => lineReferencePart(), 'plate', { id: 'hole-radius', kind: 'radial-size', entityId: 'hole', quantity: 'radius', value: 3, annotation: { kind: 'radial', angle: 2, distance: 7 } },
      lineUseReference]
  ])('copies no dimension through %s and keeps every placement', (_name, part, sketchId, relation, edit) => {
    const source = placed(part(), sketchId, relation), result = applyCadEdits(source, [edit]);
    expect(addedDimensions(source, result, sketchId)).toEqual([]);
    expect(placements(result, sketchId)).toEqual([[relation.id, relation.annotation]]);
  });

  it('keeps placements, relative to their geometry, as Move selection and Extend move it', () => {
    const height = { kind: 'linear', offset: 3, along: .75 } as const, length = { kind: 'linear', offset: -2, along: 1.25 } as const;
    // The second blank's height drives it, and a reference measures the line Extend lengthens.
    const driven = applyCadEdits(extendPart(), [{ kind: 'set-sketch-relation', sketchId: 'sketch', relation: { id: 'height', kind: 'distance', pointIds: ['f', 'g'], value: 10, annotation: height } }]);
    const source = applyCadEdits(driven, [
      { kind: 'set-sketch-relation', sketchId: 'sketch', relation: { id: 'length', kind: 'reference-dimension', measurement: { kind: 'line-length', entityId: 'ab' }, annotation: length } }]);
    const moved = applyCadEdits(source, [{ kind: 'translate-sketch-geometry', sketchId: 'sketch', selections: ['ef', 'fg', 'gh', 'he'].map(id => ({ kind: 'entity', id })), translation: [5, -2] }]);
    expect(relationsOf(moved, 'sketch')).toEqual(relationsOf(source, 'sketch'));
    expect(placements(source, 'sketch')).toEqual([['height', height], ['length', length]]);
    // A length measured on the whole line would mean another length once the line grows, so Extend refuses it until it is removed.
    expect(() => applyCadEdits(source, [{ kind: 'extend-sketch-entity', sketchId: 'sketch', extend: lineExtend }]))
      .toThrowError(expect.objectContaining({ code: 'dependent-sketch-extend', relationIds: ['length'] }));
    const extended = applyCadEdits(driven, [{ kind: 'extend-sketch-entity', sketchId: 'sketch', extend: lineExtend }]);
    expect(relationsOf(extended, 'sketch')).toEqual(relationsOf(driven, 'sketch'));
  });
});
