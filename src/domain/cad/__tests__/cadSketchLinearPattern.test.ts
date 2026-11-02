import { describe, expect, it } from 'vitest';
import { parseCadDocument } from '../cadSchema';
import { applyCadEdits } from '../cadOperations';
import type { CadEdit } from '../cadOperations';
import { isAcceptedCadSketchGraph, type CadSketchGraphRelation, type CadSketchLinearPattern } from '../cadSketchGraph';
import { cadSketchLinearPatternForSelection, cadSketchLinearPatternInstances, cadSketchLinearPatternLockReason, reconcileCadSketchLinearPattern } from '../cadSketchLinearPattern';
import { circleRow, circleRowPart, rowSketch } from './cadSketchLinearPatternFixtures';
const set = (relation: CadSketchLinearPattern): CadEdit => ({ kind: 'set-sketch-relation', sketchId: 'sketch', relation });
const copying = (relation: CadSketchLinearPattern): CadEdit => ({ kind: 'set-sketch-relation', sketchId: 'sketch', relation, copyRelations: true });
/** The free seed with a driving radius, a reference diameter, a reference distance to a point outside the row and a fixed centre. */
function measuredSeedPart() {
  const part = circleRowPart(true), sketch = rowSketch(part);
  const relations: CadSketchGraphRelation[] = [{ id: 'size', kind: 'radial-size', entityId: 'seed', quantity: 'radius', value: 3 },
    { id: 'measure', kind: 'reference-dimension', measurement: { kind: 'radial-size', entityId: 'seed', quantity: 'diameter' } },
    { id: 'reach', kind: 'reference-dimension', measurement: { kind: 'point-distance', pointIds: ['center', 'far'] } },
    { id: 'pin', kind: 'fixed-point', pointId: 'center', position: [10, 10] }];
  return parseCadDocument({ ...part, features: [{ ...sketch, graph: { ...sketch.graph, points: [...sketch.graph.points, { id: 'far', position: [10, 40] }], relations } }] });
}
const occurrenceMeasure = (index: number) => ({ id: `holes_i${index}_r0`, kind: 'reference-dimension',
  measurement: { kind: 'radial-size', entityId: `holes_i${index}_e0`, quantity: 'diameter' } });

describe('persistent circle row source and ownership', () => {
  it('allocates stable occurrences, retains exact seed/spacing, and preserves omissions across shrink/regrowth', () => {
    const source = circleRowPart(), patterned = applyCadEdits(source, [set(circleRow)]);
    const graph = rowSketch(patterned).graph;
    expect(graph.points.slice(1)).toEqual([25, 40, 55].map((x, i) => ({ id: `holes_i${i + 1}_p0`, position: [x, 10] })));
    expect(graph.points[0]).toEqual(rowSketch(source).graph.points[0]); expect(graph.entities[0]).toEqual(rowSketch(source).graph.entities[0]);
    expect(graph.relations).toEqual([circleRow]);
    expect(cadSketchLinearPatternInstances(circleRow).filter(instance => instance.active).map(instance => instance.index)).toEqual([1, 2, 3]);
    expect(cadSketchLinearPatternLockReason(graph, { kind: 'entity', id: 'holes_i1_e0' })).toBeTruthy();
    expect(cadSketchLinearPatternLockReason(graph, { kind: 'point', id: 'center' })).toBeNull();
    const smaller = applyCadEdits(patterned, [set({ ...circleRow, count: 2, omittedInstances: [3] })]);
    const regrown = applyCadEdits(smaller, [set({ ...circleRow, omittedInstances: [3] })]);
    expect(rowSketch(regrown).graph.entities.map(entity => entity.id)).toEqual(['seed', 'holes_i1_e0', 'holes_i2_e0']);
    expect(rowSketch(regrown).graph.relations[0]).toMatchObject({ omittedInstances: [3] });
    expect(applyCadEdits(regrown, [set({ ...circleRow, omittedInstances: [3] })])).toEqual(regrown);
  });
  it('finds the same owners in an accepted graph as by scanning an unaccepted copy', () => {
    const graph = rowSketch(applyCadEdits(circleRowPart(), [set({ ...circleRow, count: 5, omittedInstances: [2] })])).graph, copy = structuredClone(graph);
    expect(isAcceptedCadSketchGraph(graph)).toBe(true); expect(isAcceptedCadSketchGraph(copy)).toBe(false);
    const ids = [...graph.points.map(point => point.id), ...graph.entities.map(entity => entity.id), 'holes_i2_p0', 'holes_i2_e0', 'holes_i5_p0', 'holes_i5_e0', 'missing'];
    for (const kind of ['point', 'entity'] as const) for (const id of ids)
      expect(cadSketchLinearPatternForSelection(graph, { kind, id })).toEqual(cadSketchLinearPatternForSelection(copy, { kind, id }));
    expect(cadSketchLinearPatternForSelection(graph, { kind: 'entity', id: 'seed' })).toEqual({ relation: graph.relations[0], index: 0 });
    expect(cadSketchLinearPatternForSelection(graph, { kind: 'point', id: 'center' })).toEqual({ relation: graph.relations[0], index: 0 });
    expect(cadSketchLinearPatternForSelection(graph, { kind: 'point', id: 'holes_i4_p0' })).toEqual({ relation: graph.relations[0], index: 4 });
    expect(cadSketchLinearPatternForSelection(graph, { kind: 'entity', id: 'holes_i2_e0' })).toBeNull();
    expect(cadSketchLinearPatternForSelection(graph, { kind: 'point', id: 'holes_i4_e0' })).toBeNull();
    // Each accepted graph answers for itself, and a graph that can still change is read again.
    expect(cadSketchLinearPatternForSelection(rowSketch(circleRowPart()).graph, { kind: 'entity', id: 'seed' })).toBeNull();
    (copy.relations as unknown[]).length = 0;
    expect(cadSketchLinearPatternForSelection(copy, { kind: 'entity', id: 'seed' })).toBeNull();
  });
  it('rejects forged members, aliases, drivers, cascade seed deletion and identity rebinding', () => {
    const patterned = applyCadEdits(circleRowPart(), [set(circleRow)]), sketch = rowSketch(patterned), before = JSON.stringify(patterned);
    const edits: unknown[] = [set({ ...circleRow, idPrefix: 'other' }), set({ ...circleRow, seed: { ...circleRow.seed, centerPointId: 'holes_i1_p0' } }),
      { kind: 'set-sketch-relation', sketchId: 'sketch', relation: { id: 'drive-copy', kind: 'fixed-axis', pointId: 'holes_i1_p0', axis: 'x', value: 25 } },
      { kind: 'move-sketch-point', sketchId: 'sketch', pointId: 'holes_i1_p0', translation: [1, 0] },
      { kind: 'delete-sketch-elements', sketchId: 'sketch', pointIds: [], entityIds: ['seed'], relationIds: [], cascade: true },
      { kind: 'append-sketch-entities', sketchId: 'sketch', geometry: { points: [], relations: [], entities: [{ id: 'alias', kind: 'circle', construction: false, centerPointId: 'holes_i1_p0', radius: 2 }] } },
      { kind: 'update-feature', feature: { ...sketch, graph: { ...sketch.graph, points: sketch.graph.points.map(point => point.id === 'holes_i1_p0' ? { ...point, position: [26, 10] } : point) } } }
    ];
    for (const edit of edits) expect(() => applyCadEdits(patterned, [edit] as CadEdit[])).toThrow();
    expect(JSON.stringify(patterned)).toBe(before);
  });
  it('blocks dependent omission, rejects regrowth collisions and preserves explicitly detached geometry', () => {
    const patterned = applyCadEdits(circleRowPart(), [set(circleRow)]);
    const measured = applyCadEdits(patterned, [{ kind: 'set-sketch-relation', sketchId: 'sketch', relation: {
      id: 'measurement', kind: 'reference-dimension', measurement: { kind: 'radial-size', entityId: 'holes_i3_e0', quantity: 'radius' } } }]);
    expect(() => applyCadEdits(measured, [set({ ...circleRow, count: 2 })])).toThrow();
    const smaller = applyCadEdits(patterned, [set({ ...circleRow, count: 2 })]), sketch = rowSketch(smaller);
    const occupied = applyCadEdits(smaller, [{ kind: 'update-feature', feature: { ...sketch, graph: { ...sketch.graph,
      points: [...sketch.graph.points, { id: 'unrelated', position: [70, 20] }], entities: [...sketch.graph.entities,
        { id: 'holes_i3_e0', kind: 'circle', construction: true, centerPointId: 'unrelated', radius: 2 }] } } }]);
    expect(() => applyCadEdits(occupied, [set(circleRow)])).toThrow();
    const detachedLookalikes = { ...rowSketch(patterned).graph, relations: [{ ...circleRow, count: 2 }] };
    expect(() => reconcileCadSketchLinearPattern({ graph: detachedLookalikes, parameters: patterned.parameters, relation: circleRow, previous: circleRow })).toThrow('predecessor');
    const copied = rowSketch(occupied), complete = rowSketch(patterned);
    expect(() => applyCadEdits(occupied, [{ kind: 'update-feature', feature: { ...copied, graph: { ...complete.graph,
      points: [...complete.graph.points, { id: 'unrelated', position: [70, 20] }] } } }])).toThrow();
    const detached = applyCadEdits(patterned, [{ kind: 'remove-sketch-relation', sketchId: 'sketch', relationId: circleRow.id }]);
    expect(rowSketch(detached).graph.points).toEqual(rowSketch(patterned).graph.points);
    expect(rowSketch(detached).graph.entities).toEqual(rowSketch(patterned).graph.entities);
    expect(rowSketch(detached).graph.relations).toEqual([]);
    expect(parseCadDocument(JSON.parse(JSON.stringify(patterned)))).toEqual(patterned);
  });
  it('copies the seed reference dimensions onto each occurrence it creates with copyRelations, and leaves the seed drivers to the pattern', () => {
    const source = measuredSeedPart(), seedRelations = rowSketch(source).graph.relations;
    // Without the flag nothing is copied, as before.
    expect(rowSketch(applyCadEdits(source, [set(circleRow)])).graph.relations).toEqual([...seedRelations, circleRow]);
    const patterned = applyCadEdits(source, [copying(circleRow)]);
    expect(rowSketch(patterned).graph.relations).toEqual([...seedRelations, circleRow, ...[1, 2, 3].map(occurrenceMeasure)]);
    // Regrowth copies onto the new occurrence only; the occurrences it keeps keep their relations as they are.
    const grown = applyCadEdits(patterned, [copying({ ...circleRow, count: 5 })]);
    expect(rowSketch(grown).graph.relations).toEqual([...seedRelations, { ...circleRow, count: 5 }, ...[1, 2, 3, 4].map(occurrenceMeasure)]);
    // Omission still goes through the remap: a copied reference on the occurrence blocks it until it is removed.
    expect(() => applyCadEdits(grown, [set({ ...circleRow, count: 5, omittedInstances: [2] })])).toThrow('Remove dependent relations');
    const released = applyCadEdits(grown, [{ kind: 'remove-sketch-relation', sketchId: 'sketch', relationId: 'holes_i2_r0' },
      set({ ...circleRow, count: 5, omittedInstances: [2] })]);
    expect(rowSketch(released).graph.entities.map(entity => entity.id)).toEqual(['seed', 'holes_i1_e0', 'holes_i3_e0', 'holes_i4_e0']);
    // A copied id that already names other data refuses, and the flag means nothing on any other relation.
    const taken = applyCadEdits(source, [{ kind: 'set-sketch-relation', sketchId: 'sketch', relation: { id: 'holes_i1_r0', kind: 'distance', pointIds: ['center', 'far'], value: 30 } }]);
    expect(() => applyCadEdits(taken, [copying(circleRow)])).toThrowError(expect.objectContaining({ code: 'invalid-sketch-pattern' }));
    // A new owner reserves its own id: a copied reference or an occurrence that would reuse it refuses alike, and nothing is applied.
    for (const id of ['holes_i1_r0', 'holes_i1_e0', 'holes_i2_p0'])
      expect(() => applyCadEdits(source, [copying({ ...circleRow, id })])).toThrowError(expect.objectContaining({ code: 'invalid-sketch-pattern' }));
    expect(() => applyCadEdits(source, [{ kind: 'set-sketch-relation', sketchId: 'sketch', relation: seedRelations[0], copyRelations: true }]))
      .toThrowError(expect.objectContaining({ code: 'invalid-edit' }));
  });
  it('validates count/omission/positive spacing boundaries and never leaves detached former members in a snapshot shrink', () => {
    const source = circleRowPart(), patterned = applyCadEdits(source, [set(circleRow)]), sketch = rowSketch(patterned);
    for (const relation of [{ ...circleRow, count: 33 }, { ...circleRow, spacing: 0 }, { ...circleRow, spacing: '1 / 0' },
      { ...circleRow, omittedInstances: [0] }, { ...circleRow, omittedInstances: [1, 1] }, { ...circleRow, idPrefix: 'x'.repeat(65) }])
      expect(() => applyCadEdits(source, [set(relation)])).toThrow();
    expect(() => applyCadEdits(patterned, [{ kind: 'update-feature', feature: { ...sketch, graph: { ...sketch.graph,
      relations: [{ ...circleRow, count: 2 }] } } }])).toThrow();
    for (const direction of ['+x', '-x', '+y', '-y'] as const) {
      const row = applyCadEdits(source, [set({ ...circleRow, direction })]);
      expect(rowSketch(row).graph.points[1].position).toEqual(direction === '+x' ? [25, 10] : direction === '-x' ? [-5, 10] : direction === '+y' ? [10, 25] : [10, -5]);
    }
    expect(rowSketch(applyCadEdits(source, [set({ ...circleRow, count: 32 })])).graph.entities).toHaveLength(32);
  });
});
