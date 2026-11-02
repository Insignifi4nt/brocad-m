import { describe, expect, it, vi } from 'vitest';
import { parseCadSketchGraph, type CadSketchGraph } from '@/domain/cad/cadSketchGraph';
import {
  cadSketchAnnotationCount, cadSketchDimensionIds, cadSketchDimensionPick, cadSketchDimensionSelectionStatus, cadSketchDrawnAnnotations, cadSketchRelationHighlight, createCadSketchDimensionKeys, createCadSketchHighlightStore,
  isCadSketchDimensionPickCurrent, isCadSketchDimensionRelation, isCadSketchGlyphRelation, keepCadSketchDimensionPicks, NO_SKETCH_DIMENSION_IDS, NO_SKETCH_DIMENSIONS,
  reconcileCadSketchDimensionSelection, selectCadSketchAnnotations, selectCadSketchDimension, type CadSketchDimensionPick
} from './cadSketchDimensionSelection';
import { cadSketchDimensionToDriving, cadSketchDimensionToReference } from './cadSketchDimensionCommands';
import { cadSketchDrawnDimensions } from './cadSketchGraphDimensionLayout';

const graph = parseCadSketchGraph({
  points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [40, 0] }, { id: 'c', position: [40, 30] }, { id: 'o', position: [10, 10] }],
  entities: [{ id: 'base', kind: 'line', startPointId: 'a', endPointId: 'b', construction: false },
    { id: 'side', kind: 'line', startPointId: 'b', endPointId: 'c', construction: false },
    { id: 'hole', kind: 'circle', centerPointId: 'o', radius: 4, construction: false }],
  relations: [
    { id: 'length', kind: 'distance', pointIds: ['a', 'b'], value: 40 },
    { id: 'diagonal', kind: 'distance', pointIds: ['a', 'c'], value: 50 },
    { id: 'rise', kind: 'axis-distance', pointIds: ['b', 'c'], axis: 'y', value: 30 },
    { id: 'angle', kind: 'line-angle', rays: [{ lineId: 'base', towardPointId: 'a' }, { lineId: 'side', towardPointId: 'c' }], sense: 'cw', value: 90 },
    { id: 'size', kind: 'radial-size', entityId: 'hole', quantity: 'diameter', value: 8 },
    { id: 'x', kind: 'fixed-axis', pointId: 'o', axis: 'x', value: 10 },
    { id: 'y', kind: 'fixed-axis', pointId: 'o', axis: 'y', value: 10 },
    { id: 'parallel-free', kind: 'horizontal', pointIds: ['a', 'b'] }
  ]
});

const parameters = { offset: 0, width: 40 };
const drawn = (source: CadSketchGraph) => cadSketchDrawnDimensions(source, parameters);

describe('sketch dimension selection', () => {
  const pick = (id: string) => { const found = cadSketchDimensionPick(drawn(graph), id); if (!found) throw new Error(`${id} is not a dimension`); return found; };
  const withRelation = (relation: (typeof graph.relations)[number]) => ({ ...graph, relations: graph.relations.map(item => item.id === relation.id ? relation : item) });

  it('selects one dimension, toggles with Shift and keeps identity when nothing changes', () => {
    const one = selectCadSketchDimension(NO_SKETCH_DIMENSIONS, pick('length'), graph);
    expect(cadSketchDimensionIds(one)).toEqual(['length']);
    expect(selectCadSketchDimension(one, pick('length'), graph)).toBe(one);
    const two = selectCadSketchDimension(one, pick('size'), graph, true);
    expect(cadSketchDimensionIds(two)).toEqual(['length', 'size']);
    expect(cadSketchDimensionIds(selectCadSketchDimension(two, pick('rise'), graph))).toEqual(['rise']);
    expect(cadSketchDimensionIds(selectCadSketchDimension(two, pick('length'), graph, true))).toEqual(['size']);
    expect(selectCadSketchDimension([pick('size')], pick('size'), graph, true)).toBe(NO_SKETCH_DIMENSIONS);
    expect(Object.isFrozen(two)).toBe(true); expect(cadSketchDimensionIds(NO_SKETCH_DIMENSIONS)).toBe(NO_SKETCH_DIMENSION_IDS);
  });

  it('caps an additive selection', () => {
    let current: readonly CadSketchDimensionPick[] = NO_SKETCH_DIMENSIONS;
    for (let index = 0; index < 70; index++) current = selectCadSketchDimension(current, { id: `d${index}`, form: 'distance', identity: 'pair', measures: { kind: 'own', key: 'pair' } }, graph, true);
    expect(current).toHaveLength(64);
  });

  it('reconciles after undo or deletion: removed or non-dimension relations drop out and an intact set keeps its identity', () => {
    const current = Object.freeze([pick('length'), pick('size')]);
    expect(reconcileCadSketchDimensionSelection(drawn(graph), current)).toBe(current);
    const withoutSize = { ...graph, relations: graph.relations.filter(relation => relation.id !== 'size') };
    expect(cadSketchDimensionIds(reconcileCadSketchDimensionSelection(drawn(withoutSize), current))).toEqual(['length']);
    // Positional relations and a coordinate held on an axis are not canvas dimensions; a coordinate held off an axis is a distance from it,
    // and a parameter keeps it one even while the parameter is 0.
    expect(cadSketchDimensionPick(drawn(graph), 'parallel-free')).toBeNull(); expect(cadSketchDimensionPick(drawn(graph), 'x')).toMatchObject({ id: 'x', form: 'fixed-axis' });
    const onAxis = withRelation({ id: 'x', kind: 'fixed-axis', pointId: 'o', axis: 'x', value: '1 - 1' });
    expect(cadSketchDimensionPick(drawn(onAxis), 'x')).toBeNull(); expect(reconcileCadSketchDimensionSelection(drawn(onAxis), [pick('x')])).toBe(NO_SKETCH_DIMENSIONS);
    expect(cadSketchDimensionPick(drawn(withRelation({ id: 'x', kind: 'fixed-axis', pointId: 'o', axis: 'x', value: ' offset ' })), 'x')).toMatchObject({ id: 'x' });
    expect(reconcileCadSketchDimensionSelection(drawn(graph), [{ ...pick('length'), id: 'parallel-free' }])).toBe(NO_SKETCH_DIMENSIONS);
    // While relation glyphs are drawn, positional relations and a coordinate held on an axis select as glyphs, by their own operands. A pick
    // under another form drops out, and so does every glyph once the glyphs are hidden; with the dimensions hidden, the glyphs stay.
    const marked = (source: CadSketchGraph, glyphs = true) => cadSketchDrawnAnnotations(source, drawn(source), glyphs);
    expect(cadSketchDimensionPick(marked(graph), 'parallel-free')?.form).toBe('horizontal'); expect(cadSketchDimensionPick(marked(onAxis), 'x')?.form).toBe('fixed-axis');
    expect(cadSketchDimensionPick(marked(graph), 'x')).toEqual(pick('x'));
    const glyph = Object.freeze([pick('length'), cadSketchDimensionPick(marked(graph), 'parallel-free')!]);
    expect(reconcileCadSketchDimensionSelection(marked(graph), glyph)).toBe(glyph);
    expect(reconcileCadSketchDimensionSelection(marked(withRelation({ id: 'parallel-free', kind: 'horizontal', pointIds: ['b', 'c'] })), glyph)).toEqual([pick('length')]);
    expect(reconcileCadSketchDimensionSelection(marked(graph, false), glyph)).toEqual([pick('length')]);
    expect(reconcileCadSketchDimensionSelection(cadSketchDrawnAnnotations(graph, undefined, true), glyph)).toEqual([glyph[1]]);
    expect(reconcileCadSketchDimensionSelection(cadSketchDrawnAnnotations(graph, drawn(onAxis), true), glyph)).toEqual([glyph[1]]);
    expect(reconcileCadSketchDimensionSelection(undefined, current)).toBe(NO_SKETCH_DIMENSIONS);
    expect(reconcileCadSketchDimensionSelection(drawn(graph), NO_SKETCH_DIMENSIONS)).toBe(NO_SKETCH_DIMENSIONS);
  });

  it('keeps a dimension whose value changes, but drops an ID that now names a different measurement', () => {
    const current = Object.freeze([pick('length'), pick('size')]);
    // A new value, or an expression, is the same dimension.
    expect(reconcileCadSketchDimensionSelection(drawn(withRelation({ id: 'length', kind: 'distance', pointIds: ['b', 'a'], value: ' width ' })), current)).toBe(current);
    // An agent edit or undo that reuses the ID for other points, another kind or the other radial quantity does not inherit the selection.
    expect(cadSketchDimensionIds(reconcileCadSketchDimensionSelection(drawn(withRelation({ id: 'length', kind: 'distance', pointIds: ['a', 'c'], value: 40 })), current))).toEqual(['size']);
    expect(cadSketchDimensionIds(reconcileCadSketchDimensionSelection(drawn(withRelation({ id: 'length', kind: 'axis-distance', pointIds: ['a', 'b'], axis: 'x', value: 40 })), current))).toEqual(['size']);
    expect(cadSketchDimensionIds(reconcileCadSketchDimensionSelection(drawn(withRelation({ id: 'size', kind: 'radial-size', entityId: 'hole', quantity: 'radius', value: 4 })), current))).toEqual(['length']);
    const angle = pick('angle');
    expect(reconcileCadSketchDimensionSelection(drawn(withRelation({ id: 'angle', kind: 'line-angle', rays: [{ lineId: 'base', towardPointId: 'a' }, { lineId: 'side', towardPointId: 'c' }], sense: 'cw', value: 45 })), [angle])).toEqual([angle]);
    expect(reconcileCadSketchDimensionSelection(drawn(withRelation({ id: 'angle', kind: 'line-angle', rays: [{ lineId: 'base', towardPointId: 'a' }, { lineId: 'side', towardPointId: 'c' }], sense: 'ccw', value: 90 })), [angle])).toBe(NO_SKETCH_DIMENSIONS);
  });

  it('keeps every kind of dimension selected when it is placed, moved or reset, which changes only where it is drawn', () => {
    const current = Object.freeze(['length', 'rise', 'angle', 'size', 'x'].map(pick));
    const placed = { ...graph, relations: graph.relations.map(relation => relation.id === 'angle' ? { ...relation, annotation: { kind: 'angle' as const, radius: 9, along: 0.25 } }
      : relation.id === 'size' ? { ...relation, annotation: { kind: 'radial' as const, angle: 1, distance: 6 } }
      : ['length', 'rise', 'x'].includes(relation.id) ? { ...relation, annotation: { kind: 'linear' as const, offset: -7, along: 1.5 } } : relation) } as CadSketchGraph;
    expect(reconcileCadSketchDimensionSelection(drawn(placed), current)).toBe(current);
    for (const id of ['length', 'rise', 'angle', 'size', 'x']) expect(isCadSketchDimensionPickCurrent(drawn(placed), pick(id))).toBe(true);
    // The pick made from the relation as placed names the same dimension back in the graph without the placement, as Reset leaves it.
    const placedPicks = Object.freeze(current.map(item => cadSketchDimensionPick(drawn(placed), item.id)!));
    expect(reconcileCadSketchDimensionSelection(drawn(graph), placedPicks)).toBe(placedPicks);
  });

  it('keeps the selection through Make reference and Make driving, which measure the same thing', () => {
    const current = Object.freeze([pick('length'), pick('diagonal'), pick('size')]);
    const referenced = { ...graph, relations: graph.relations.map(relation => relation.id === 'length' ? { id: 'length', kind: 'reference-dimension' as const, measurement: { kind: 'line-length' as const, entityId: 'base' } }
      : relation.id === 'diagonal' ? { id: 'diagonal', kind: 'reference-dimension' as const, measurement: { kind: 'point-distance' as const, pointIds: ['c', 'a'] as const } }
        : relation.id === 'size' ? { id: 'size', kind: 'reference-dimension' as const, measurement: { kind: 'radial-size' as const, entityId: 'hole', quantity: 'diameter' as const } } : relation) };
    const kept = reconcileCadSketchDimensionSelection(drawn(referenced), current);
    expect(cadSketchDimensionIds(kept)).toEqual(['length', 'diagonal', 'size']);
    // The kept picks take the reference form, and Make driving brings them back.
    expect(kept.map(item => item.form)).toEqual(['reference/line-length', 'reference/point-distance', 'reference/radial-size']);
    expect(reconcileCadSketchDimensionSelection(drawn(graph), kept)).toEqual(current);
    // A reference to another line under the same ID is a different dimension.
    expect(cadSketchDimensionIds(reconcileCadSketchDimensionSelection(drawn(withRelation({ id: 'length', kind: 'reference-dimension', measurement: { kind: 'line-length', entityId: 'side' } })), current))).toEqual(['diagonal', 'size']);
  });

  it('keeps a line reference selected when Trim or Extend rewrites an endpoint of its line, and through a later Make driving', () => {
    const measured = { id: 'measured', kind: 'reference-dimension' as const, measurement: { kind: 'line-length' as const, entityId: 'base' } };
    const referenced = { ...graph, relations: [...graph.relations.filter(relation => relation.id !== 'length'), measured] };
    const current = Object.freeze([cadSketchDimensionPick(drawn(referenced), 'measured')!]);
    // Trim gives the base line a new end point; the reference still names the base line.
    const trimmed = { ...referenced, points: [...referenced.points, { id: 'n', position: [25, 0] as const }],
      entities: referenced.entities.map(entity => entity.id === 'base' && entity.kind === 'line' ? { ...entity, endPointId: 'n' } : entity) };
    const kept = reconcileCadSketchDimensionSelection(drawn(trimmed), current);
    expect(cadSketchDimensionIds(kept)).toEqual(['measured']);
    const driving = { ...trimmed, relations: trimmed.relations.map(relation => relation.id === 'measured' ? { id: 'measured', kind: 'distance' as const, pointIds: ['a', 'n'] as const, value: 25 } : relation) };
    expect(cadSketchDimensionIds(reconcileCadSketchDimensionSelection(drawn(driving), kept))).toEqual(['measured']);
    // Pointing the reference at another line, or a driving length between other points, is a different dimension.
    const repointed = { ...trimmed, relations: trimmed.relations.map(relation => relation.id === 'measured' ? { ...measured, measurement: { kind: 'line-length' as const, entityId: 'side' } } : relation) };
    expect(reconcileCadSketchDimensionSelection(drawn(repointed), kept)).toBe(NO_SKETCH_DIMENSIONS);
    const elsewhere = { ...trimmed, relations: trimmed.relations.map(relation => relation.id === 'measured' ? { id: 'measured', kind: 'distance' as const, pointIds: ['a', 'b'] as const, value: 40 } : relation) };
    expect(reconcileCadSketchDimensionSelection(drawn(elsewhere), kept)).toBe(NO_SKETCH_DIMENSIONS);
  });

  it('matches a driver and its reference through Coincident joins, and only through them', () => {
    // q is joined to a and r to the center o; loose sits on a without a join.
    const joined = parseCadSketchGraph({
      points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [40, 0] }, { id: 'c', position: [40, 30] }, { id: 'q', position: [0, 0] }, { id: 'loose', position: [0, 0] },
        { id: 'o', position: [10, 10] }, { id: 'r', position: [10, 10] }],
      entities: [{ id: 'base', kind: 'line', startPointId: 'a', endPointId: 'b', construction: false }, { id: 'side', kind: 'line', startPointId: 'b', endPointId: 'c', construction: false }],
      relations: [{ id: 'joint', kind: 'coincident', pointIds: ['q', 'a'] }, { id: 'center', kind: 'coincident', pointIds: ['r', 'o'] },
        { id: 'length', kind: 'distance', pointIds: ['q', 'b'], value: 40 }, { id: 'clearance', kind: 'point-line-distance', pointId: 'r', lineId: 'base', side: 'left', value: 10 }]
    });
    type Relation = (typeof joined.relations)[number];
    const change = (source: typeof joined, relations: Readonly<Record<string, Relation>>) => ({ ...source, relations: source.relations.map(relation => relations[relation.id] ?? relation) });
    const current = Object.freeze([cadSketchDimensionPick(drawn(joined), 'length')!, cadSketchDimensionPick(drawn(joined), 'clearance')!]);
    // The line's Dimension editor stores Reference length on the line, and the circle double-pick's reference on the center it picked.
    const referenced = change(joined, { length: { id: 'length', kind: 'reference-dimension', measurement: { kind: 'line-length', entityId: 'base' } },
      clearance: { id: 'clearance', kind: 'reference-dimension', measurement: { kind: 'point-line-distance', pointId: 'o', lineId: 'base' } } });
    const kept = reconcileCadSketchDimensionSelection(drawn(referenced), current);
    expect(cadSketchDimensionIds(kept)).toEqual(['length', 'clearance']);
    // Make driving on the line's endpoints and the center keeps them, and so does a driver back on the aliases.
    const driving = change(referenced, { length: { id: 'length', kind: 'distance', pointIds: ['a', 'b'], value: 40 },
      clearance: { id: 'clearance', kind: 'point-line-distance', pointId: 'o', lineId: 'base', side: 'left', value: 10 } });
    expect(cadSketchDimensionIds(reconcileCadSketchDimensionSelection(drawn(driving), kept))).toEqual(['length', 'clearance']);
    expect(cadSketchDimensionIds(reconcileCadSketchDimensionSelection(drawn(joined), kept))).toEqual(['length', 'clearance']);
    expect(isCadSketchDimensionPickCurrent(drawn(change(joined, { length: { id: 'length', kind: 'reference-dimension', measurement: { kind: 'point-distance', pointIds: ['b', 'a'] } } })), current[0])).toBe(true);
    // Another line, another point, or a point that only lies on a, is a different measurement under the same ID.
    const replaced = (relation: Relation, pick: CadSketchDimensionPick) => isCadSketchDimensionPickCurrent(drawn(change(joined, { [relation.id]: relation })), pick);
    expect(replaced({ id: 'length', kind: 'reference-dimension', measurement: { kind: 'line-length', entityId: 'side' } }, current[0])).toBe(false);
    expect(replaced({ id: 'length', kind: 'reference-dimension', measurement: { kind: 'point-distance', pointIds: ['loose', 'b'] } }, current[0])).toBe(false);
    expect(replaced({ id: 'clearance', kind: 'reference-dimension', measurement: { kind: 'point-line-distance', pointId: 'o', lineId: 'side' } }, current[1])).toBe(false);
    expect(replaced({ id: 'clearance', kind: 'reference-dimension', measurement: { kind: 'point-line-distance', pointId: 'c', lineId: 'base' } }, current[1])).toBe(false);
    // Without the join, the line's reference measures other points than the driver on q did.
    const unjoined = { ...joined, relations: joined.relations.filter(relation => relation.id !== 'joint') };
    expect(reconcileCadSketchDimensionSelection(drawn(change(unjoined, { length: referenced.relations.find(relation => relation.id === 'length')! })), [cadSketchDimensionPick(drawn(unjoined), 'length')!])).toBe(NO_SKETCH_DIMENSIONS);
    // A line reference keeps its pick through a Trim that ends the line on a new point, and a later driver on that point's alias still matches it.
    const trimmed = { ...referenced, points: [...referenced.points, { id: 'n', position: [25, 0] as const }, { id: 'm', position: [25, 0] as const }],
      entities: referenced.entities.map(entity => entity.id === 'base' && entity.kind === 'line' ? { ...entity, endPointId: 'n' } : entity),
      relations: [...referenced.relations, { id: 'end', kind: 'coincident' as const, pointIds: ['m', 'n'] as const }] };
    const trimmedKept = reconcileCadSketchDimensionSelection(drawn(trimmed), [kept[0]]);
    expect(cadSketchDimensionIds(trimmedKept)).toEqual(['length']);
    expect(cadSketchDimensionIds(reconcileCadSketchDimensionSelection(drawn(change(trimmed, { length: { id: 'length', kind: 'distance', pointIds: ['q', 'm'], value: 25 } })), trimmedKept))).toEqual(['length']);
    expect(reconcileCadSketchDimensionSelection(drawn(change(trimmed, { length: { id: 'length', kind: 'distance', pointIds: ['q', 'b'], value: 40 } })), trimmedKept)).toBe(NO_SKETCH_DIMENSIONS);
  });

  describe('across one edit that converts a dimension and removes or adds its Coincident joins', () => {
    const sketch = (points: Readonly<Record<string, readonly [number, number]>>, relations: readonly object[]) => parseCadSketchGraph({
      points: Object.entries(points).map(([id, position]) => ({ id, position })),
      entities: [{ id: 'base', kind: 'line', startPointId: 'a', endPointId: 'b', construction: false }, { id: 'side', kind: 'line', startPointId: 'b', endPointId: 'c', construction: false }],
      relations
    });
    // A length on q and a point to line distance on r. Together, q sits on a and r on the center o; apart, both have moved.
    const together = { a: [0, 0], b: [40, 0], c: [40, 30], q: [0, 0], o: [10, 10], r: [10, 10] } as const, apart = { ...together, q: [-20, 5], r: [30, 25] } as const;
    const joints = [{ id: 'joint', kind: 'coincident', pointIds: ['q', 'a'] }, { id: 'center', kind: 'coincident', pointIds: ['r', 'o'] }];
    const drivers = [{ id: 'length', kind: 'distance', pointIds: ['q', 'b'], value: 40 }, { id: 'clearance', kind: 'point-line-distance', pointId: 'r', lineId: 'base', side: 'left', value: 10 }];
    const references = [{ id: 'length', kind: 'reference-dimension', measurement: { kind: 'line-length', entityId: 'base' } },
      { id: 'clearance', kind: 'reference-dimension', measurement: { kind: 'point-line-distance', pointId: 'o', lineId: 'base' } }];
    const joined = sketch(together, [...joints, ...drivers]), detached = sketch(apart, references), loose = sketch(apart, drivers), attached = sketch(together, [...joints, ...references]);

    // The review's repro: the edit removes the joins, moves q and r away and makes each dimension, under its ID, a reference on the line and on o.
    it.each(['length', 'clearance'])('drops the %s, renews its key and selects its successor afresh when the edit removes its join', id => {
      const picked = Object.freeze([cadSketchDimensionPick(drawn(joined), id)!]), successor = cadSketchDimensionPick(drawn(detached), id)!;
      expect(reconcileCadSketchDimensionSelection(drawn(detached), picked)).toBe(NO_SKETCH_DIMENSIONS);
      expect(isCadSketchDimensionPickCurrent(drawn(detached), picked[0])).toBe(false);
      expect(selectCadSketchDimension(picked, successor, detached, true)).toEqual([picked[0], successor]);
      const keys = createCadSketchDimensionKeys(), before = keys(joined).get(id);
      expect(keys(detached).get(id)).not.toBe(before);
    });
    it.each(['length', 'clearance'])('keeps the %s and its key when the edit adds the join it is measured through', id => {
      const picked = Object.freeze([cadSketchDimensionPick(drawn(loose), id)!]);
      expect(cadSketchDimensionIds(reconcileCadSketchDimensionSelection(drawn(attached), picked))).toEqual([id]);
      expect(isCadSketchDimensionPickCurrent(drawn(attached), picked[0])).toBe(true);
      expect(selectCadSketchDimension(picked, cadSketchDimensionPick(drawn(attached), id)!, attached, true)).toBe(NO_SKETCH_DIMENSIONS);
      const keys = createCadSketchDimensionKeys(), before = keys(loose).get(id);
      expect(keys(attached).get(id)).toBe(before);
      // A pick keeps the operands it was authored on, so the graph it was picked in has no say.
      expect(cadSketchDimensionPick(drawn(joined), id)).toEqual(picked[0]);
    });
  });

  it('keeps a mount key while the ID names the same dimension and renews it when a replacement takes the ID', () => {
    const keys = createCadSketchDimensionKeys(), first = keys(graph).get('length');
    expect(keys(withRelation({ id: 'length', kind: 'distance', pointIds: ['b', 'a'], value: 41 })).get('length')).toBe(first);
    expect(keys(withRelation({ id: 'length', kind: 'reference-dimension', measurement: { kind: 'line-length', entityId: 'base' } })).get('length')).toBe(first);
    expect(keys(graph).get('length')).toBe(first);
    const replaced = keys(withRelation({ id: 'length', kind: 'distance', pointIds: ['a', 'c'], value: 50 })).get('length');
    expect(replaced).not.toBe(first);
    // Restoring the first dimension replaces the one shown, so it mounts afresh too.
    expect(keys(graph).get('length')).not.toBe(replaced);
    // The dimensions layer keys only dimensions, the glyph layer only the others, a coordinate held on an axis among them; both share one key rule.
    expect(keys(graph).has('parallel-free')).toBe(true);
    expect(createCadSketchDimensionKeys(isCadSketchDimensionRelation)(graph).has('parallel-free')).toBe(false);
    expect([...createCadSketchDimensionKeys(isCadSketchGlyphRelation)(graph).keys()]).toEqual(['parallel-free']);
    expect([...createCadSketchDimensionKeys(isCadSketchGlyphRelation)(withRelation({ id: 'x', kind: 'fixed-axis', pointId: 'o', axis: 'x', value: 0 })).keys()]).toEqual(['x', 'parallel-free']);
    expect(isCadSketchDimensionPickCurrent(drawn(graph), pick('length'))).toBe(true);
    expect(isCadSketchDimensionPickCurrent(drawn(withRelation({ id: 'length', kind: 'distance', pointIds: ['a', 'c'], value: 50 })), pick('length'))).toBe(false);
    expect(isCadSketchDimensionPickCurrent(undefined, pick('length'))).toBe(false);
  });

  it('describes the selection for the status line without opening the editor', () => {
    expect(cadSketchDimensionSelectionStatus(graph, ['length'])).toBe('Length selected · Double-click or Enter edits · Delete removes');
    expect(cadSketchDimensionSelectionStatus(graph, ['diagonal'])).toBe('Distance selected · Double-click or Enter edits · Delete removes');
    expect(cadSketchDimensionSelectionStatus(graph, ['x'])).toBe('Distance selected · Double-click or Enter edits · Delete removes');
    expect(cadSketchDimensionSelectionStatus(graph, ['size', 'rise'])).toBe('2 dimensions selected · Delete removes them');
    expect(cadSketchDimensionSelectionStatus(graph, [])).toBeNull();
    expect(cadSketchDimensionSelectionStatus(graph, ['gone'])).toBeNull();
  });

  it('describes a relation glyph selection by the relation names, X and Y held at 0 on one place as one Coincident with the origin, and a mixed one by its counts', () => {
    expect(cadSketchDimensionSelectionStatus(graph, ['parallel-free'])).toBe('Horizontal selected · Delete removes');
    // Held away from the axes, X and Y are two Distance dimensions.
    expect(cadSketchDimensionSelectionStatus(graph, ['x'])).toBe('Distance selected · Double-click or Enter edits · Delete removes');
    expect(cadSketchDimensionSelectionStatus(graph, ['x', 'y'])).toBe('2 dimensions selected · Delete removes them');
    // Held at 0, each is the Coincident that keeps the point on an axis, and both on one place, or on Coincident points, read as one with the origin.
    const zero = parseCadSketchGraph({ ...graph, points: [...graph.points, { id: 'p', position: [0, 0] }],
      relations: [...graph.relations.filter(relation => relation.kind !== 'fixed-axis'), { id: 'x', kind: 'fixed-axis', pointId: 'o', axis: 'x', value: 0 },
        { id: 'y', kind: 'fixed-axis', pointId: 'o', axis: 'y', value: '0 * 2' }, { id: 'join', kind: 'coincident', pointIds: ['p', 'a'] }, { id: 'ay', kind: 'fixed-axis', pointId: 'p', axis: 'y', value: 0 },
        { id: 'ax', kind: 'fixed-axis', pointId: 'a', axis: 'x', value: 0 }, { id: 'away', kind: 'fixed-axis', pointId: 'c', axis: 'x', value: 40 }, { id: 'cy', kind: 'fixed-axis', pointId: 'c', axis: 'y', value: 0 }] });
    expect(cadSketchDimensionSelectionStatus(zero, ['x'])).toBe('Coincident selected · Delete removes');
    expect(cadSketchDimensionSelectionStatus(zero, ['x', 'y'])).toBe('Coincident selected · Delete removes');
    expect(cadSketchDimensionSelectionStatus(zero, ['ay', 'ax'])).toBe('Coincident selected · Delete removes');
    expect(cadSketchDimensionSelectionStatus(zero, ['x', 'ay'])).toBe('2 relations selected · Delete removes them');
    // One coordinate at 0 and the other away from it is a relation and a dimension, never one glyph.
    expect(cadSketchDimensionSelectionStatus(zero, ['away', 'cy'])).toBe('1 dimension and 1 relation selected · Delete removes them');
    expect(cadSketchDimensionSelectionStatus(graph, ['length', 'x', 'y'])).toBe('3 dimensions selected · Delete removes them');
    expect(cadSketchDimensionSelectionStatus(zero, ['parallel-free', 'x', 'y'])).toBe('3 relations selected · Delete removes them');
  });

  it('counts a selection of shapes, dimensions and relations as Delete and its dialog name it', () => {
    // A generator counts as the shape it deletes, and a source reference, which Delete detaches, as the relation it is.
    const shaped: CadSketchGraph = { ...graph, relations: [...graph.relations,
      { id: 'ring', kind: 'generator', idPrefix: 'ring', construction: false, geometry: { kind: 'circle', x: 0, y: 0, radius: 4 } },
      { id: 'disc', kind: 'generator', idPrefix: 'disc', construction: false, geometry: { kind: 'circle', x: 20, y: 0, radius: 2 } },
      { id: 'link', kind: 'external-reference', entityId: 'hole', sourceSketchId: 'layout', source: { kind: 'circle', entityId: 'circle', centerPointId: 'center' } }] };
    expect(cadSketchAnnotationCount(shaped, ['ring', 'parallel-free'])).toBe('1 shape and 1 relation');
    expect(cadSketchAnnotationCount(shaped, ['parallel-free', 'disc', 'length', 'ring'])).toBe('2 shapes, 1 dimension and 1 relation');
    expect(cadSketchAnnotationCount(shaped, ['ring', 'disc'])).toBe('2 shapes');
    expect(cadSketchAnnotationCount(shaped, ['link', 'parallel-free'])).toBe('2 relations');
    expect(cadSketchAnnotationCount(shaped, ['size', 'rise'])).toBe('2 dimensions');
    expect(cadSketchDimensionSelectionStatus(shaped, ['ring', 'parallel-free'])).toBe('1 shape and 1 relation selected · Delete removes them');
    // The status line counts rows without a mark too: a source reference, which Delete detaches, but never a linear pattern, which detaches through its editor.
    expect(cadSketchDimensionSelectionStatus(shaped, ['ring', 'length', 'parallel-free', 'link'])).toBe('1 shape, 1 dimension and 2 relations selected · Delete removes them');
    expect(cadSketchDimensionSelectionStatus(shaped, ['link'])).toBe('Linked reference selected · Delete detaches');
    // A row and the mark it selected name one relation.
    expect(cadSketchDimensionSelectionStatus(shaped, ['ring', 'ring'])).toBe('Circle selected · Delete removes');
    const patterned: CadSketchGraph = { ...shaped, relations: [...shaped.relations, { id: 'row', kind: 'linear-pattern', seed: { entityId: 'base' }, count: 2,
      direction: { kind: 'vector', x: 0, y: 1 }, spacing: 10, occurrences: [] } as unknown as CadSketchGraph['relations'][number]] };
    expect(cadSketchDimensionSelectionStatus(patterned, ['row'])).toBeNull();
    expect(cadSketchDimensionSelectionStatus(patterned, ['row', 'link', 'length'])).toBe('1 dimension and 1 relation selected · Delete removes them');
  });

  it('selects the relations of one glyph together: a click replaces the selection, Shift adds them or, when all are selected, removes them', () => {
    // X and Y held at 0 on one point draw one Coincident glyph with the origin.
    const origin = parseCadSketchGraph({ ...graph, relations: graph.relations.map(relation => relation.kind === 'fixed-axis' ? { ...relation, value: 0 } : relation) });
    const glyph = (id: string) => { const found = cadSketchDimensionPick(cadSketchDrawnAnnotations(origin, drawn(origin), true), id); if (!found) throw new Error(`${id} is not drawn`); return found; };
    const fixed = [glyph('x'), glyph('y')], one = selectCadSketchAnnotations(NO_SKETCH_DIMENSIONS, [pick('length')], origin);
    expect(cadSketchDimensionIds(selectCadSketchAnnotations(one, fixed, origin))).toEqual(['x', 'y']);
    const both = selectCadSketchAnnotations(one, fixed, origin, true);
    expect(cadSketchDimensionIds(both)).toEqual(['length', 'x', 'y']);
    expect(selectCadSketchAnnotations(both, [glyph('y'), glyph('x')], origin)).not.toBe(both);
    expect(cadSketchDimensionIds(selectCadSketchAnnotations(both, fixed, origin, true))).toEqual(['length']);
    expect(selectCadSketchAnnotations(selectCadSketchAnnotations(NO_SKETCH_DIMENSIONS, fixed, origin), fixed, origin, true)).toBe(NO_SKETCH_DIMENSIONS);
    // Hiding relation glyphs keeps the dimensions selected, and an unchanged set keeps its identity.
    expect(cadSketchDimensionIds(keepCadSketchDimensionPicks(both, item => item.id === 'length'))).toEqual(['length']);
    expect(keepCadSketchDimensionPicks(both, () => true)).toBe(both);
  });
});

describe('sketch relation highlight', () => {
  const highlight = (id: string) => cadSketchRelationHighlight(graph, graph.relations.find(relation => relation.id === id)!);
  it('names the measured points and the line they span for a length', () => {
    expect(highlight('length')).toEqual({ pointIds: ['a', 'b'], entityIds: ['base'] });
    expect(highlight('diagonal')).toEqual({ pointIds: ['a', 'c'], entityIds: [] });
    expect(highlight('rise')).toEqual({ pointIds: ['b', 'c'], entityIds: ['side'] });
  });
  it('names the lines of an angle and the curve of a radius or diameter', () => {
    expect(highlight('angle')).toEqual({ pointIds: [], entityIds: ['base', 'side'] });
    expect(highlight('size')).toEqual({ pointIds: [], entityIds: ['hole'] });
  });
  it('names the axis a coordinate is measured from', () => {
    expect(highlight('x')).toEqual({ pointIds: ['o'], entityIds: ['@v'] });
    expect(highlight('y')).toEqual({ pointIds: ['o'], entityIds: ['@h'] });
    // A distance to a line kept upright along the Y axis lights that line too; held on the axis, it is a relation about its point alone.
    const upright = { ...graph, relations: [...graph.relations, { id: 'v', kind: 'vertical' as const, pointIds: ['c', 'b'] as const }] };
    expect(cadSketchRelationHighlight(upright, { id: 'sideX', kind: 'fixed-axis', pointId: 'b', axis: 'x', value: 40 })).toEqual({ pointIds: ['b'], entityIds: ['side', '@v'] });
    expect(cadSketchRelationHighlight(upright, { id: 'sideX', kind: 'fixed-axis', pointId: 'b', axis: 'x', value: 0 })).toEqual({ pointIds: ['b'], entityIds: ['@v'] });
  });
  it('names every line between the two points in graph order, whichever way each runs, and each graph from its own geometry', () => {
    const lines = parseCadSketchGraph({
      points: [{ id: 'p', position: [0, 0] }, { id: 'q', position: [10, 0] }, { id: 'r', position: [10, 10] }],
      entities: [{ id: 'z', kind: 'line', startPointId: 'q', endPointId: 'p', construction: false }, { id: 'other', kind: 'line', startPointId: 'q', endPointId: 'r', construction: false },
        { id: 'a', kind: 'line', startPointId: 'p', endPointId: 'q', construction: true }],
      relations: [{ id: 'level', kind: 'horizontal', pointIds: ['p', 'q'] }, { id: 'upright', kind: 'vertical', pointIds: ['r', 'q'] }]
    });
    expect(cadSketchRelationHighlight(lines, lines.relations[0])).toEqual({ pointIds: ['p', 'q'], entityIds: ['z', 'a'] });
    expect(cadSketchRelationHighlight(lines, lines.relations[1])).toEqual({ pointIds: ['r', 'q'], entityIds: ['other'] });
    const removed = { ...lines, entities: lines.entities.filter(entity => entity.id !== 'z') };
    expect(cadSketchRelationHighlight(removed, removed.relations[0]).entityIds).toEqual(['a']);
  });
  it('names the line between points that Coincident joins to its ends, keeping the named points', () => {
    const joined = parseCadSketchGraph({
      points: [{ id: 'p', position: [0, 0] }, { id: 'q', position: [10, 0] }, { id: 'pp', position: [0, 0] }, { id: 'qq', position: [10, 0] }],
      entities: [{ id: 'base', kind: 'line', startPointId: 'p', endPointId: 'q', construction: false }],
      relations: [{ id: 'jp', kind: 'coincident', pointIds: ['p', 'pp'] }, { id: 'jq', kind: 'coincident', pointIds: ['qq', 'q'] },
        { id: 'level', kind: 'horizontal', pointIds: ['pp', 'qq'] }, { id: 'span', kind: 'distance', pointIds: ['qq', 'p'], value: 10 }]
    });
    expect(cadSketchRelationHighlight(joined, joined.relations[2])).toEqual({ pointIds: ['pp', 'qq'], entityIds: ['base'] });
    expect(cadSketchRelationHighlight(joined, joined.relations[3])).toEqual({ pointIds: ['qq', 'p'], entityIds: ['base'] });
  });
});

describe('sketch highlight store', () => {
  it('publishes only real changes and lets each owner clear only its own highlight', () => {
    const store = createCadSketchHighlightStore(), listener = vi.fn(), stop = store.subscribe(listener);
    store.show('dimension:length', { kind: 'relation', relationId: 'length' });
    store.show('dimension:length', { kind: 'relation', relationId: 'length' });
    expect(listener).toHaveBeenCalledOnce();
    store.show('row', { kind: 'geometry', pointIds: ['a'], entityIds: [] });
    store.hide('dimension:length');
    expect(store.getSnapshot()).toEqual({ kind: 'geometry', pointIds: ['a'], entityIds: [] });
    store.hide('row');
    expect(store.getSnapshot()).toBeNull(); expect(listener).toHaveBeenCalledTimes(3);
    stop(); store.show('row', { kind: 'relation', relationId: 'size' });
    expect(listener).toHaveBeenCalledTimes(3);
  });
});

describe('sketch dimension conversions', () => {
  const relation = (id: string) => graph.relations.find(item => item.id === id)!;
  it('turns a driving length, distance or diameter into a reference with the same identity', () => {
    expect(cadSketchDimensionToReference(graph, relation('length'))).toEqual({ reason: null,
      relation: { id: 'length', kind: 'reference-dimension', measurement: { kind: 'line-length', entityId: 'base' } } });
    expect(cadSketchDimensionToReference(graph, relation('diagonal')).relation).toEqual({ id: 'diagonal', kind: 'reference-dimension', measurement: { kind: 'point-distance', pointIds: ['a', 'c'] } });
    expect(cadSketchDimensionToReference(graph, relation('size')).relation).toEqual({ id: 'size', kind: 'reference-dimension', measurement: { kind: 'radial-size', entityId: 'hole', quantity: 'diameter' } });
  });
  it('explains why other dimensions cannot become references', () => {
    expect(cadSketchDimensionToReference(graph, relation('angle'))).toEqual({ relation: null, reason: 'Reference dimensions measure lengths, point distances, point to line distances, radii and diameters.' });
    expect(cadSketchDimensionToReference(graph, relation('rise')).reason).toBe('Reference dimensions measure lengths, point distances, point to line distances, radii and diameters.');
    expect(cadSketchDimensionToReference(graph, relation('x'))).toEqual({ relation: null, reason: 'A distance from the origin or an axis has no reference form yet.' });
    const measured = { ...graph, relations: [...graph.relations, { id: 'measured', kind: 'reference-dimension' as const, measurement: { kind: 'line-length' as const, entityId: 'base' } }] };
    expect(cadSketchDimensionToReference(measured, relation('length')).reason).toBe('A reference dimension already measures this. Delete this dimension instead.');
  });
  it('turns a reference into a driving dimension at its measured value, unless a driver already exists', () => {
    const reference = { id: 'measured', kind: 'reference-dimension' as const, measurement: { kind: 'line-length' as const, entityId: 'side' } };
    const measured = { ...graph, relations: [...graph.relations, reference] };
    expect(cadSketchDimensionToDriving(measured, {}, reference)).toEqual({ reason: null, relation: { id: 'measured', kind: 'distance', pointIds: ['b', 'c'], value: 30 } });
    const driven = { id: 'measured', kind: 'reference-dimension' as const, measurement: { kind: 'line-length' as const, entityId: 'base' } };
    expect(cadSketchDimensionToDriving({ ...graph, relations: [...graph.relations, driven] }, {}, driven).reason).toBe('An existing dimension already drives this distance. Edit that dimension instead.');
    expect(cadSketchDimensionToDriving(graph, {}, relation('length')).reason).toBe('This dimension already drives the geometry.');
  });
});
