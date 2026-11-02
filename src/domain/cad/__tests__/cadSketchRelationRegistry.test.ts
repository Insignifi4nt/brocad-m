import { describe, expect, it } from 'vitest';
import { CadSketchGraphSchema, parseCadSketchGraph, type CadSketchGraphRelation } from '../cadSketchGraph';
import { cadSketchRelationEntityIds, cadSketchRelationPointIds, mapCadSketchRelationScalars } from '../cadSketchGraphReferences';
import { CAD_SKETCH_AGENT_RELATION_KINDS, CAD_SKETCH_RELATION_DEFINITIONS, CAD_SKETCH_RELATION_KINDS, cadSketchRelationDefinition, cadSketchRelationKey, cadSketchRelationKeyIndex,
  cadSketchRelationMentions, cadSketchRelationSignature, cadSketchRelationsLike } from '../sketch-relations/cadSketchRelationRegistry';
import type { CadSketchRelationKind, CadSketchRelationOf } from '../sketch-relations/cadSketchRelationTypes';

// One relation of each kind; operands need not exist, since accessors and keys read data alone.
const examples: { readonly [K in CadSketchRelationKind]: CadSketchRelationOf<K> } = {
  'linear-pattern': { id: 'r1', kind: 'linear-pattern', seed: { kind: 'circle', entityId: 'c1', centerPointId: 'p1' }, idPrefix: 'lp', direction: '+x', count: 3, spacing: 'gap', omittedInstances: [2] },
  'reference-dimension': { id: 'r2', kind: 'reference-dimension', measurement: { kind: 'point-distance', pointIds: ['p1', 'p2'] } },
  'external-reference': { id: 'r3', kind: 'external-reference', entityId: 'l9', sourceSketchId: 's2', source: { kind: 'line', entityId: 'x1', startPointId: 'x2', endPointId: 'x3' } },
  coincident: { id: 'r4', kind: 'coincident', pointIds: ['p1', 'p2'] },
  horizontal: { id: 'r5', kind: 'horizontal', pointIds: ['p1', 'p2'] },
  vertical: { id: 'r6', kind: 'vertical', pointIds: ['p2', 'p3'] },
  parallel: { id: 'r7', kind: 'parallel', lineIds: ['l1', 'l2'] },
  perpendicular: { id: 'r8', kind: 'perpendicular', lineIds: ['l1', 'l2'] },
  collinear: { id: 'r9', kind: 'collinear', lineIds: ['l1', 'l2'] },
  midpoint: { id: 'r10', kind: 'midpoint', pointId: 'p3', lineId: 'l1' },
  'point-on-line': { id: 'r11', kind: 'point-on-line', pointId: 'p3', lineId: 'l1' },
  'point-on-curve': { id: 'r12', kind: 'point-on-curve', pointId: 'p3', curveId: 'c1' },
  'tangent-joint': { id: 'r13', kind: 'tangent-joint', endpoints: [{ entityId: 'l1', pointId: 'p2' }, { entityId: 'a1', pointId: 'p4' }] },
  tangent: { id: 'r26', kind: 'tangent', curveIds: ['c1', '@h'] },
  symmetric: { id: 'r14', kind: 'symmetric', pointIds: ['p1', 'p2'], lineId: 'l3' },
  'equal-length': { id: 'r15', kind: 'equal-length', lineIds: ['l1', 'l2'] },
  'equal-radius': { id: 'r16', kind: 'equal-radius', curveIds: ['c1', 'a1'] },
  'line-angle': { id: 'r17', kind: 'line-angle', rays: [{ lineId: 'l1', towardPointId: 'p2' }, { lineId: 'l2', towardPointId: 'p5' }], sense: 'ccw', value: 30 },
  'radial-size': { id: 'r18', kind: 'radial-size', entityId: 'c1', quantity: 'diameter', value: 'd' },
  'fixed-point': { id: 'r19', kind: 'fixed-point', pointId: 'p1', position: [1, 'y0'] },
  'fixed-axis': { id: 'r20', kind: 'fixed-axis', pointId: 'p1', axis: 'x', value: 0 },
  distance: { id: 'r21', kind: 'distance', pointIds: ['p1', 'p2'], value: 5 },
  'point-line-distance': { id: 'r22', kind: 'point-line-distance', pointId: 'p3', lineId: 'l1', side: 'left', value: 2 },
  'axis-distance': { id: 'r23', kind: 'axis-distance', pointIds: ['p1', 'p2'], axis: 'y', value: -3 },
  'fillet-corner': { id: 'r24', kind: 'fillet-corner', pointId: 'p2', lineIds: ['l1', 'l2'], arcId: 'a9', value: 1 },
  'chamfer-corner': { id: 'r25', kind: 'chamfer-corner', pointId: 'p2', lineIds: ['l1', 'l2'], chamferId: 'l8', values: [1, '2 * t'] },
  generator: { id: 'r27', kind: 'generator', idPrefix: 'g1', construction: false, geometry: { kind: 'regular-polygon', x: 0, y: 'cy', radius: 5, sides: 'n', directionId: 'l1' } }
};
// A reference dimension's operands depend on what it measures, and a symmetric's on whether it mirrors points or curves.
const references: readonly CadSketchGraphRelation[] = [
  { id: 'q1', kind: 'reference-dimension', measurement: { kind: 'line-length', entityId: 'l1' } },
  { id: 'q2', kind: 'reference-dimension', measurement: { kind: 'point-line-distance', pointId: 'p1', lineId: 'l1' }, annotation: { kind: 'linear', offset: 2, along: 0.5 } },
  { id: 'q3', kind: 'reference-dimension', measurement: { kind: 'radial-size', entityId: 'c1', quantity: 'radius' } },
  { id: 'q4', kind: 'symmetric', curveIds: ['a1', 'a2'], lineId: 'l3' },
  { id: 'q5', kind: 'generator', idPrefix: 'g2', construction: true, geometry: { kind: 'rectangle', x: 0, y: 0, width: 'w', height: 4, cornerRadius: 0 } }
];
const all = [...Object.values(examples) as CadSketchGraphRelation[], ...references];
// A kind with several stored shapes, such as Symmetric, appears once for each.
const schemaKinds = [...new Set(CadSketchGraphSchema.properties.relations.items.anyOf.map(relation => relation.properties.kind.const))];
const operandsOf = (relation: CadSketchGraphRelation) => cadSketchRelationDefinition(relation).operands(relation);
const withOperands = (relation: CadSketchGraphRelation, ids: readonly string[]) => cadSketchRelationDefinition(relation).withOperands(relation, ids);
/** The stored ids with each unordered group reversed, an `end` slot after a grouped slot moving with it. */
function reordered(relation: CadSketchGraphRelation): readonly string[] | null {
  const { slots, unordered } = cadSketchRelationSignature(relation);
  if (!unordered?.length) return null;
  const ids = [...operandsOf(relation)];
  for (const group of unordered) {
    const moved = group.map(slot => [ids[slot], slots[slot + 1]?.end ? ids[slot + 1] : undefined] as const).reverse();
    group.forEach((slot, index) => { ids[slot] = moved[index][0]; if (moved[index][1] !== undefined) ids[slot + 1] = moved[index][1]!; });
  }
  return ids;
}
const pathValue = (relation: CadSketchGraphRelation, key: string) => key.split('.').reduce<unknown>((at, part) => (at as Record<string, unknown>)[part], relation);

describe('sketch relation definitions', () => {
  it('define every kind once, in schema order, with its own kind and the name and summary people and agents read', () => {
    expect(CAD_SKETCH_RELATION_KINDS).toEqual(schemaKinds);
    expect(Object.keys(examples).sort()).toEqual([...schemaKinds].sort());
    for (const kind of CAD_SKETCH_RELATION_KINDS) {
      const definition = CAD_SKETCH_RELATION_DEFINITIONS[kind];
      expect(definition.kind).toBe(kind);
      expect(definition.name).toMatch(/^[A-Z][a-z ]+$/);
      expect(definition.agent.summary).toMatch(/^[A-Z].+\.$/);
    }
    // A generator is made and changed through its own edits, never named as a relation.
    expect(CAD_SKETCH_AGENT_RELATION_KINDS).toEqual(schemaKinds.filter(kind => kind !== 'generator'));
    expect(Object.isFrozen(CAD_SKETCH_RELATION_DEFINITIONS)).toBe(true);
  });

  it('look definitions up by kind alone', () => {
    for (const relation of all) expect(cadSketchRelationDefinition(relation)).toBe(CAD_SKETCH_RELATION_DEFINITIONS[relation.kind]);
  });

  it('give one stored id for each slot, and write back exactly the relation they read', () => {
    for (const relation of all) {
      const ids = operandsOf(relation), { slots } = cadSketchRelationSignature(relation);
      expect(ids, relation.kind).toHaveLength(slots.length);
      expect(withOperands(relation, ids), relation.kind).toEqual(relation);
      const fresh = ids.map((id, index) => `${id}_${index}`);
      expect(operandsOf(withOperands(relation, fresh)), relation.kind).toEqual(fresh);
      for (const [index, slot] of slots.entries()) {
        expect(slot.role, relation.kind).toMatch(/^[A-Z][a-z ]+$/);
        if (slot.end) expect(index, `${relation.kind} end slot follows an edge`).toBeGreaterThan(0);
      }
    }
  });

  it('read driving values at the paths their keys name and write back exactly what they read', () => {
    const valued = new Set<string>();
    for (const relation of all) {
      const scalars = cadSketchRelationDefinition(relation).scalars;
      if (relation.kind === 'generator') {
        // Its inputs are its geometry's, by the geometry's own paths.
        const mapped = mapCadSketchRelationScalars(relation, (value, key) => `${key}:${value}`);
        expect(mapped).toEqual({ ...relation, geometry: Object.fromEntries(Object.entries(relation.geometry).map(([key, value]) =>
          [key, key === 'kind' || key === 'directionId' ? value : `geometry.${key}:${value}`])) });
        continue;
      }
      if (!scalars) { expect(mapCadSketchRelationScalars(relation, () => 'changed')).toBe(relation); continue; }
      valued.add(relation.kind);
      const values = scalars.read(relation);
      expect(values).toEqual(scalars.keys.map(key => pathValue(relation, key)));
      expect(scalars.write(relation, values)).toEqual(relation);
      const mapped = mapCadSketchRelationScalars(relation, (value, key) => `${key}:${value}`);
      expect(Object.keys(mapped)).toEqual(Object.keys(relation));
      for (const key of scalars.keys) expect(pathValue(mapped, key)).toBe(`${key}:${pathValue(relation, key)}`);
    }
    expect([...valued].sort()).toEqual(['axis-distance', 'chamfer-corner', 'distance', 'fillet-corner', 'fixed-axis', 'fixed-point', 'line-angle', 'linear-pattern', 'point-line-distance', 'radial-size']);
  });

  it('keep a key across the order of an unordered group, and change it with any operand that is not an end', () => {
    for (const relation of all) {
      const key = cadSketchRelationKey(relation), ids = operandsOf(relation), { slots } = cadSketchRelationSignature(relation);
      expect(key.startsWith(`${relation.kind} `), relation.kind).toBe(true);
      const swapped = reordered(relation);
      if (swapped) {
        expect(swapped, relation.kind).not.toEqual(ids);
        expect(cadSketchRelationKey(withOperands(relation, swapped)), relation.kind).toBe(key);
      }
      slots.forEach((slot, index) => {
        if (slot.end) return;
        const changed = ids.map((id, at) => at === index ? 'other' : id);
        expect(cadSketchRelationKey(withOperands(relation, changed)), `${relation.kind} slot ${index}`).not.toBe(key);
      });
    }
  });

  it('give a pair stored either way one key, whatever its values, and an axis distance its direction', () => {
    const { 'line-angle': angle, 'axis-distance': axis, 'radial-size': radial } = examples;
    expect(cadSketchRelationKey({ ...angle, rays: [angle.rays[1], angle.rays[0]], sense: 'cw', value: 60 })).toBe(cadSketchRelationKey(angle));
    expect(cadSketchRelationKey({ ...radial, quantity: 'radius', value: 4 })).toBe(cadSketchRelationKey(radial));
    expect(cadSketchRelationKey({ ...axis, pointIds: ['p2', 'p1'] })).not.toBe(cadSketchRelationKey(axis));
    expect(cadSketchRelationKey({ ...axis, axis: 'x' })).not.toBe(cadSketchRelationKey(axis));
    expect(cadSketchRelationKey(examples['fixed-axis'])).not.toBe(cadSketchRelationKey({ ...examples['fixed-axis'], axis: 'y' }));
    expect(new Set(references.map(cadSketchRelationKey)).size).toBe(references.length);
  });

  it('name each point and edge slot in a description unless the kind names its operands its own way', () => {
    const names = { point: (id: string) => `point ${id}`, entity: (id: string) => `edge ${id}` };
    expect(cadSketchRelationMentions(examples.symmetric, names)).toEqual(['point p1', 'point p2', 'edge l3']);
    expect(cadSketchRelationMentions(examples['line-angle'], names)).toEqual(['edge l1', 'edge l2']);
    expect(cadSketchRelationMentions(examples['linear-pattern'], names)).toEqual(['edge c1']);
    expect(cadSketchRelationMentions(examples['tangent-joint'], names)).toEqual(['edge l1 at point p2', 'edge a1 at point p4']);
    // A held X is a distance from the V axis, which is named as any edge is.
    expect(cadSketchRelationMentions(examples['fixed-axis'], names)).toEqual(['point p1', 'edge @v']);
    expect(cadSketchRelationMentions(examples['fillet-corner'], names)).toEqual(['point p2']);
    expect(cadSketchRelationMentions(examples['external-reference'], names)).toEqual(['edge l9']);
  });

  it('list the edges a relation names and keeps, and the points of them it references', () => {
    expect(cadSketchRelationEntityIds(examples['fillet-corner'])).toEqual(['l1', 'l2', 'a9']);
    expect(cadSketchRelationEntityIds(examples['tangent-joint'])).toEqual(['l1', 'a1']);
    expect(cadSketchRelationEntityIds(examples['external-reference'])).toEqual(['l9']);
    expect(cadSketchRelationEntityIds(examples['linear-pattern'])).toEqual(['c1', 'lp_i1_e0']);
    expect(cadSketchRelationEntityIds(examples.coincident)).toEqual([]);
    const graph = parseCadSketchGraph({
      points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [4, 0] }, { id: 'c', position: [2, 3] }],
      entities: [{ id: 'base', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' }],
      relations: [{ id: 'mid', kind: 'midpoint', pointId: 'c', lineId: 'base' }, { id: 'level', kind: 'horizontal', pointIds: ['a', 'b'] }]
    });
    expect(cadSketchRelationPointIds(graph, graph.relations[0])).toEqual(['c', 'a', 'b']);
    // Points alone are the relation's own stored, frozen list.
    const level = graph.relations[1] as Extract<CadSketchGraphRelation, { pointIds: unknown }>;
    expect(cadSketchRelationPointIds(graph, level)).toBe(level.pointIds);
    expect(() => cadSketchRelationPointIds(graph, { id: 'loose', kind: 'midpoint', pointId: 'c', lineId: 'gone' }))
      .toThrow('Sketch relation "loose" references missing entity "gone".');
  });

  it('index the keys of an accepted graph once, and find the relations a new one would repeat', () => {
    const source = {
      points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [4, 0] }, { id: 'c', position: [4, 3] }],
      entities: [],
      relations: [{ id: 'one', kind: 'horizontal', pointIds: ['a', 'b'] }, { id: 'two', kind: 'horizontal', pointIds: ['b', 'a'] }, { id: 'three', kind: 'vertical', pointIds: ['b', 'c'] }]
    };
    const graph = parseCadSketchGraph(source);
    expect(cadSketchRelationKeyIndex(graph)).toBe(cadSketchRelationKeyIndex(graph));
    expect(cadSketchRelationsLike(graph, { kind: 'horizontal', pointIds: ['a', 'b'] })).toEqual(['one', 'two']);
    expect(cadSketchRelationsLike(graph, { kind: 'vertical', pointIds: ['c', 'b'] })).toEqual(['three']);
    expect(cadSketchRelationsLike(graph, { kind: 'vertical', pointIds: ['a', 'b'] })).toEqual([]);
    // A graph the parser did not accept can change, so its index is read again each time.
    const loose = structuredClone(graph) as typeof graph;
    expect(cadSketchRelationKeyIndex(loose)).not.toBe(cadSketchRelationKeyIndex(loose));
    expect(cadSketchRelationKeyIndex(loose)).toEqual(cadSketchRelationKeyIndex(graph));
  });
});
