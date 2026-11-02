// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@/domain/cad/cadDocument';
import { createCadDocument, parseCadDocument } from '@/domain/cad/cadSchema';
import type { CadSketchGraph, CadSketchGraphRelation, CadSketchReferenceDimension } from '@/domain/cad/cadSketchGraph';
import { prepareCadEdits } from './cadEditPreparation';
import { createCadSketchTestSolver } from './sketch-solver/__tests__/cadSketchTestSolver';
import { cadSketchDimensionPickEligibility, cadSketchDimensionPickTargets, planCadSketchDimension, type CadSketchDimensionOperand } from './cadSketchDimensionPlacement';
import { cadSketchDimensionToDriving } from './cadSketchDimensionCommands';

const solver = createCadSketchTestSolver();
// A 20 by 10 plate generated at the origin, a free point 5 above it and a free sloped line beside it.
const part = () => parseCadDocument({ ...createCadDocument('Plate', 'plate'), schemaVersion: 2, features: [{ id: 'sketch', kind: 'sketch', name: 'Sketch', suppressed: false,
  plane: 'XY', offset: 0, profiles: [], graph: {
    points: [{ id: 'p', position: [5, 15] }, { id: 'f0', position: [30, 0] }, { id: 'f1', position: [40, 5] }],
    entities: [{ id: 'free', kind: 'line', construction: false, startPointId: 'f0', endPointId: 'f1' }],
    relations: [{ id: 'plate', kind: 'generator', idPrefix: 'plate', construction: false, geometry: { kind: 'rectangle', x: 0, y: 0, width: 20, height: 10, cornerRadius: 0 } }] } }] });
const graphOf = (document: CadDocument): CadSketchGraph => {
  const sketch = document.features[0];
  if (sketch.kind !== 'sketch' || !sketch.graph) throw new Error('Expected a sketch graph');
  return sketch.graph;
};
const position = (graph: CadSketchGraph, id: string) => graph.points.find(point => point.id === id)!.position;
/** The plate's bottom edge, found by where it is. */
function bottomOf(graph: CadSketchGraph) {
  const edge = graph.entities.find(entity => entity.kind === 'line' && entity.id.startsWith('plate_') && position(graph, entity.startPointId)[1] === 0 && position(graph, entity.endPointId)[1] === 0);
  if (edge?.kind !== 'line') throw new Error('Expected the bottom edge of the plate');
  return edge;
}
const point = (id: string): CadSketchDimensionOperand => ({ kind: 'point', id }), entity = (id: string): CadSketchDimensionOperand => ({ kind: 'entity', id });
let ids = 0;
const newId = () => `dimension-${++ids}`;

describe('dimensions anchored on generated geometry', () => {
  it('pick a generated edge as an anchor, in either order, but never for a size of its own', () => {
    const graph = graphOf(part()), bottom = bottomOf(graph), targets = cadSketchDimensionPickTargets(graph);
    expect(targets.entityIds).toContain(bottom.id);
    expect(targets.sizedEntityIds).not.toContain(bottom.id);
    expect(targets.sizedEntityIds).toContain('free');
    // The point first, then the edge; the edge first, then the point; either way, the distance from the edge to the point.
    for (const operands of [[point('p'), entity(bottom.id)], [entity(bottom.id), point('p')]]) {
      const next = cadSketchDimensionPickEligibility(graph, targets, operands.slice(0, 1));
      expect(operands[1].kind === 'point' ? next.pointIds : next.entityIds).toContain(operands[1].id);
      const plan = planCadSketchDimension(graph, {}, operands, newId, targets.sizedEntityIds);
      expect(plan.candidates).toMatchObject([{ form: 'point-line', state: 'available', relations: [{ kind: 'point-line-distance', pointId: 'p', lineId: bottom.id, value: 15 }] }]);
    }
    // The edge again is no length: its generator sizes it.
    expect(cadSketchDimensionPickEligibility(graph, targets, [entity(bottom.id)]).entityIds).not.toContain(bottom.id);
    expect(planCadSketchDimension(graph, {}, [entity(bottom.id)], newId, targets.sizedEntityIds).candidates).toEqual([]);
    // A free line and a generated edge take an angle, in either order.
    for (const operands of [[entity('free'), entity(bottom.id)], [entity(bottom.id), entity('free')]]) {
      expect(cadSketchDimensionPickEligibility(graph, targets, operands.slice(0, 1)).entityIds).toContain(operands[1].id);
      expect(planCadSketchDimension(graph, {}, operands, newId, targets.sizedEntityIds).candidates.find(candidate => candidate.form === 'angle')).toMatchObject({ state: 'available' });
    }
  });

  it('move only the free geometry when a dimension from a generated edge drives it', async () => {
    const document = part(), graph = graphOf(document), bottom = bottomOf(graph);
    const placed = planCadSketchDimension(graph, {}, [point('p'), entity(bottom.id)], newId, cadSketchDimensionPickTargets(graph).sizedEntityIds).candidates[0];
    if (placed?.state !== 'available') throw new Error('Expected an available dimension');
    const relation = { ...placed.relations[0], value: 25 } as CadSketchGraphRelation;
    const driven = graphOf((await prepareCadEdits(document, [{ kind: 'set-sketch-relation', sketchId: 'sketch', relation }], solver)).document);
    expect(position(driven, 'p')[1]).toBeCloseTo(25, 9);
    for (const generated of graph.points.filter(item => item.id.startsWith('plate_'))) expect(position(driven, generated.id)).toEqual(generated.position);
  });

  it('turn a reference from a generated edge into a driving dimension, but not one only generated geometry spans', () => {
    const graph = graphOf(part()), bottom = bottomOf(graph);
    const reference = (id: string, measurement: CadSketchReferenceDimension['measurement']): CadSketchReferenceDimension => ({ id, kind: 'reference-dimension', measurement });
    const withReferences = { ...graph, relations: [...graph.relations,
      reference('height', { kind: 'point-line-distance', pointId: 'p', lineId: bottom.id }),
      reference('across', { kind: 'point-distance', pointIds: [bottom.startPointId, 'p'] }),
      reference('span', { kind: 'point-distance', pointIds: [bottom.startPointId, bottom.endPointId] }),
      reference('length', { kind: 'line-length', entityId: bottom.id })] };
    const drive = (id: string) => cadSketchDimensionToDriving(withReferences, {}, withReferences.relations.find(relation => relation.id === id)!);
    expect(drive('height')).toMatchObject({ reason: null, relation: { id: 'height', kind: 'point-line-distance', pointId: 'p', lineId: bottom.id, value: 15 } });
    expect(drive('across')).toMatchObject({ reason: null, relation: { id: 'across', kind: 'distance' } });
    const owned = 'Rectangle "plate" generates this geometry. Edit the generator\'s inputs, or detach it, before editing generated geometry.';
    expect(drive('span')).toEqual({ relation: null, reason: owned });
    expect(drive('length')).toEqual({ relation: null, reason: owned });
  });
});
