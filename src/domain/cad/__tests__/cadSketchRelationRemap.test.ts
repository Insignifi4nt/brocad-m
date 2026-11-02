import { describe, expect, it } from 'vitest';
import type { CadSketchFeature } from '../cadDocument';
import { createCadDocument, parseCadDocument } from '../cadSchema';
import { checkCadSketchGraph, parseCadSketchGraph, type CadSketchGraph, type CadSketchGraphRelation } from '../cadSketchGraph';
import { compileCadSketchGraph } from '../cadSketchGraphGeometry';
import { applyCadEdits } from '../cadOperations';
import { prepareCadSketchMirror } from '../cadSketchMirror';
import { prepareCadSketchOffset } from '../cadSketchOffset';
import { inspectCadSketchRegions, validateCadSketchRegionProposal } from '../cadSketchRegionInspection';
import { splitCadSketchEntity } from '../cadSketchSplit';
import { prepareCadSketchTrim, trimCadSketchEntity } from '../cadSketchTrimExtend';
import { applyCadSketchRemapOutcomes, blockedCadSketchRemaps, copyCadSketchRelations, remapCadSketchRelations, type CadSketchRemapPiece } from '../sketch-relations/cadSketchRelationRemap';
import { circleRow, circleRowPart, rowSketch } from './cadSketchLinearPatternFixtures';
import { mirrorBoreRequest, pairedBoreMirrorPart } from './cadSketchMirrorFixtures';

type Points = Readonly<Record<string, readonly [number, number]>>;
const graphOf = (points: Points, entities: readonly unknown[], relations: readonly CadSketchGraphRelation[]): CadSketchGraph =>
  parseCadSketchGraph({ points: Object.entries(points).map(([id, position]) => ({ id, position })), entities, relations });
const line = (id: string, startPointId: string, endPointId: string, construction = false) => ({ id, kind: 'line', construction, startPointId, endPointId });
const piece = (entityId: string, interval: readonly [number, number], ends?: readonly [string, string], orientation: 'same' | 'reversed' = 'same'): CadSketchRemapPiece =>
  ({ entityId, interval, orientation, ...(ends ? { ends } : {}) });
const sketchOf = (graph: CadSketchGraph): CadSketchFeature => ({ id: 'sketch', kind: 'sketch', name: 'Sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph });
/** Each touched relation's id with what the edit does to it, and the relation it becomes or the reason. */
const summary = (outcomes: ReturnType<typeof remapCadSketchRelations>) => outcomes.map(item => item.kind === 'replace' ? [item.relation.id, 'replace', item.relations]
  : item.kind === 'blocked' ? [item.relation.id, 'blocked', item.confirmable] : [item.relation.id, item.kind]);

// A 20 mm edge with an upright side at its end, a free point above it and a twin edge mirrored across y = 10.
const edgePoints: Points = { a: [0, 0], b: [20, 0], c: [20, 10], x: [5, 5], y: [15, 5], a2: [0, 20], b2: [20, 20], s: [-5, 10], t: [25, 10] };
const edgeEntities = [line('edge', 'a', 'b'), line('side', 'b', 'c'), line('twin', 'a2', 'b2'), line('axis', 's', 't', true)];

describe('relation remap by role', () => {
  it('keeps a carrier on the piece keeping the id, blocks an extent, and moves a ray toward the end the new piece holds', () => {
    const graph = graphOf(edgePoints, edgeEntities, [
      { id: 'perp', kind: 'perpendicular', lineIds: ['edge', 'side'] },
      { id: 'same', kind: 'equal-length', lineIds: ['edge', 'side'] },
      { id: 'angle', kind: 'line-angle', rays: [{ lineId: 'edge', towardPointId: 'b' }, { lineId: 'side', towardPointId: 'c' }], sense: 'ccw', value: 90 },
      { id: 'gap', kind: 'point-line-distance', pointId: 'x', lineId: 'edge', side: 'left', value: 5 },
      { id: 'level', kind: 'horizontal', pointIds: ['a', 'b'] }]);
    const outcomes = remapCadSketchRelations(graph, { curves: new Map([['edge', [piece('edge', [0, .5], ['a', 'm']), piece('after', [.5, 1], ['m', 'b'])]]]) });
    expect(summary(outcomes)).toEqual([['perp', 'retain'], ['same', 'blocked', true],
      ['angle', 'replace', [{ ...graph.relations[2], rays: [{ lineId: 'after', towardPointId: 'b' }, { lineId: 'side', towardPointId: 'c' }] }]],
      ['gap', 'retain'], ['level', 'retain']]);
    expect(blockedCadSketchRemaps(outcomes)[0].reason).toMatch(/length, ends or middle/);
    // Kept relations stay in place and a blocked one leaves only once the caller applies the outcomes.
    expect(applyCadSketchRemapOutcomes(graph.relations, outcomes).map(relation => relation.id)).toEqual(['perp', 'angle', 'gap', 'level']);
    // The whole interval kept, as a trim exactly at the end leaves it, keeps the extent.
    expect(summary(remapCadSketchRelations(graph, { curves: new Map([['edge', [piece('edge', [0, 1], ['a', 'b'])]]]) }))).toEqual(
      [['perp', 'retain'], ['same', 'retain'], ['angle', 'retain'], ['gap', 'retain'], ['level', 'retain']]);
  });

  it('turns a side over and keeps a ray and a curve symmetry on a piece that runs the other way', () => {
    const graph = graphOf(edgePoints, edgeEntities, [
      { id: 'gap', kind: 'point-line-distance', pointId: 'x', lineId: 'edge', side: 'left', value: 5 },
      { id: 'angle', kind: 'line-angle', rays: [{ lineId: 'edge', towardPointId: 'b' }, { lineId: 'side', towardPointId: 'c' }], sense: 'ccw', value: 90 },
      { id: 'pair', kind: 'symmetric', pointIds: ['x', 'y'], lineId: 'edge' },
      { id: 'mirror', kind: 'symmetric', curveIds: ['edge', 'twin'], lineId: 'axis' }]);
    // The edge rewritten from b to a: same span, its own start at the old end.
    const outcomes = remapCadSketchRelations(graph, { curves: new Map([['edge', [piece('edge', [0, 1], ['b', 'a'], 'reversed')]]]) });
    expect(summary(outcomes)).toEqual([['gap', 'replace', [{ ...graph.relations[0], side: 'right' }]], ['angle', 'retain'], ['pair', 'retain'], ['mirror', 'retain']]);
    // A reversed half keeps the ray toward the old end, now its own start.
    expect(summary(remapCadSketchRelations(graph, { curves: new Map([['edge', [piece('edge', [.5, 1], ['b', 'm'], 'reversed')]]]) }))[1])
      .toEqual(['angle', 'retain']);
  });

  it('keeps a full circle\'s carrier relations on the arc it becomes, unless a cut lands on a point held to it', () => {
    const graph = graphOf({ o: [0, 0], x: [0, 5], p: [5, 0], q: [-5, 0], k: [20, 0] }, [
      { id: 'ring', kind: 'circle', construction: false, centerPointId: 'o', radius: 5 },
      { id: 'other', kind: 'circle', construction: true, centerPointId: 'k', radius: 5 }], [
      { id: 'size', kind: 'radial-size', entityId: 'ring', quantity: 'radius', value: 5 },
      { id: 'on', kind: 'point-on-curve', pointId: 'x', curveId: 'ring' },
      { id: 'equal', kind: 'equal-radius', curveIds: ['ring', 'other'] },
      { id: 'touch', kind: 'tangent', curveIds: ['ring', '@h'] }]);
    // The arc runs from phase .75 through 1 to 1.25, past the circle's own zero.
    expect(summary(remapCadSketchRelations(graph, { curves: new Map([['ring', [piece('ring', [.75, 1.25], ['p', 'q'])]]]) })))
      .toEqual([['size', 'retain'], ['on', 'retain'], ['equal', 'retain'], ['touch', 'retain']]);
    expect(summary(remapCadSketchRelations(graph, { curves: new Map([['ring', [piece('ring', [.25, 1], ['x', 'q'])]]]) }))[1]).toEqual(['on', 'blocked', true]);
  });

  it('moves a joint at the far end of an arc over 180 degrees to the piece that keeps that end', () => {
    const graph = graphOf({ o: [0, 0], s: [10, 0], e: [0, -10], f: [10, -10] }, [
      { id: 'arc', kind: 'arc', construction: false, centerPointId: 'o', startPointId: 's', endPointId: 'e', direction: 'ccw' },
      line('lead', 'e', 'f')], [
      { id: 'size', kind: 'radial-size', entityId: 'arc', quantity: 'radius', value: 10 },
      { id: 'joint', kind: 'tangent-joint', endpoints: [{ entityId: 'arc', pointId: 'e' }, { entityId: 'lead', pointId: 'e' }] }]);
    const outcomes = remapCadSketchRelations(graph, { curves: new Map([['arc', [piece('arc', [0, .3], ['s', 'm1']), piece('after', [.7, 1], ['m2', 'e'])]]]) });
    expect(summary(outcomes)).toEqual([['size', 'retain'],
      ['joint', 'replace', [{ ...graph.relations[1], endpoints: [{ entityId: 'after', pointId: 'e' }, { entityId: 'lead', pointId: 'e' }] }]]]);
    // With that end cut away, the joint leaves with it.
    expect(summary(remapCadSketchRelations(graph, { curves: new Map([['arc', [piece('arc', [0, .3], ['s', 'm1'])]]]) }))[1]).toEqual(['joint', 'blocked', true]);
  });

  it('blocks relations on points that leave, and refuses an edit to a pattern\'s seed', () => {
    const graph = graphOf(edgePoints, edgeEntities, [{ id: 'span', kind: 'distance', pointIds: ['x', 'y'], value: 10 }]);
    expect(summary(remapCadSketchRelations(graph, { curves: new Map(), points: new Map([['x', null]]) }))).toEqual([['span', 'blocked', true]]);
    expect(summary(remapCadSketchRelations(graph, { curves: new Map(), points: new Map([['x', 'z']]) })))
      .toEqual([['span', 'replace', [{ ...graph.relations[0], pointIds: ['z', 'y'] }]]]);
    const row = rowSketch(applyCadEdits(circleRowPart(), [{ kind: 'set-sketch-relation', sketchId: 'sketch', relation: circleRow }])).graph;
    const seed = remapCadSketchRelations(row, { curves: new Map([['seed', []]]) });
    expect(summary(seed)).toEqual([['row', 'blocked', false]]);
  });

  it('never remaps the origin or an axis, even when an edit names one', () => {
    const graph = graphOf(edgePoints, edgeEntities, [
      { id: 'about-v', kind: 'symmetric', pointIds: ['x', 'y'], lineId: '@v' },
      { id: 'reach', kind: 'distance', pointIds: ['x', '@origin'], value: 7 },
      { id: 'rise', kind: 'line-angle', rays: [{ lineId: 'edge', towardPointId: 'b' }, { lineId: '@v', towardPointId: '@v' }], sense: 'ccw', value: 90 }]);
    const outcomes = remapCadSketchRelations(graph, { curves: new Map([['@h', []], ['@v', []], ['edge', [piece('edge', [0, 1], ['a', 'b'])]]]), points: new Map([['@origin', null]]) });
    expect(summary(outcomes)).toEqual([['about-v', 'retain'], ['reach', 'retain'], ['rise', 'retain']]);
  });

  it('routes a curve kind it does not know by the traits the edit gives, and by nothing else', () => {
    // A stand-in for a later curve kind, such as a spline: the rule reads only its ends, its centre and whether it is straight.
    const graph = { points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [20, 0] }, { id: 'x', position: [5, 5] }],
      entities: [{ id: 'wave', kind: 'spline', construction: false, startPointId: 'a', endPointId: 'b' }],
      relations: [{ id: 'level', kind: 'horizontal', pointIds: ['a', 'b'] }, { id: 'span', kind: 'distance', pointIds: ['a', 'x'], value: 7 },
        { id: 'same', kind: 'equal-length', lineIds: ['wave', 'wave'] }] } as unknown as CadSketchGraph;
    const cut = { curves: new Map([['wave', [piece('wave', [0, .5], ['a', 'm'])]]]), points: new Map([['b', null]]) };
    const traits = (straight: boolean) => () => ({ ends: ['a', 'b'] as const, centre: null, straight });
    // Straight, its two ends hold its direction and follow them; otherwise they are two points, one of which leaves.
    expect(summary(remapCadSketchRelations(graph, { ...cut, traits: traits(true) }))).toEqual([
      ['level', 'replace', [{ ...graph.relations[0], pointIds: ['a', 'm'] }]], ['same', 'blocked', true]]);
    expect(summary(remapCadSketchRelations(graph, { ...cut, traits: traits(false) }))).toEqual([['level', 'blocked', true], ['same', 'blocked', true]]);
    // Without traits for it, the stored kinds' reader names the kind it lacks instead of guessing.
    expect(() => remapCadSketchRelations(graph, cut)).toThrow('No curve traits for spline.');
  });

  it('treats construction geometry like any other', () => {
    for (const construction of [false, true]) {
      const graph = graphOf({ a: [0, 0], b: [40, 20], p: [10, 5] }, [line('guide', 'a', 'b', construction)], [{ id: 'on', kind: 'point-on-line', pointId: 'p', lineId: 'guide' }]);
      const split = splitCadSketchEntity({ graph, parameters: {}, split: { kind: 'line', entityId: 'guide', parameter: .5, splitPointId: 'm', newEntityId: 'after', supportRelationId: 'support' } });
      expect(split.graph.relations).toEqual([graph.relations[0], { id: 'support', kind: 'parallel', lineIds: ['guide', 'after'] }]);
      expect(split.graph.entities.map(entity => entity.construction)).toEqual([construction, construction]);
    }
  });
});

describe('relation remap through the edits', () => {
  it('keeps a Coincident and the line\'s own direction through a split at a joined end, and moves the joint to the far piece', () => {
    const graph = graphOf({ a: [0, 0], b: [20, 0], z: [20, 0], c: [30, 0] }, [line('edge', 'a', 'b'), line('stub', 'z', 'c')], [
      { id: 'join', kind: 'coincident', pointIds: ['b', 'z'] },
      { id: 'level', kind: 'horizontal', pointIds: ['a', 'b'] },
      { id: 'run', kind: 'collinear', lineIds: ['edge', 'stub'] }]);
    const split = splitCadSketchEntity({ graph, parameters: {}, split: { kind: 'line', entityId: 'edge', parameter: .25, splitPointId: 'm', newEntityId: 'after', supportRelationId: 'support' } });
    expect(split.graph.relations).toEqual([...graph.relations, { id: 'support', kind: 'parallel', lineIds: ['edge', 'after'] }]);
    expect(split.graph.entities.slice(0, 2)).toEqual([line('edge', 'a', 'm'), line('after', 'm', 'b')]);
    expect(checkCadSketchGraph(split.graph, {})).toEqual([]);
  });

  it('refuses a cut at a tangent contact, and asks to confirm a point held on the line once a cut at it makes it the line\'s end', () => {
    // The arc only touches the edge at j, its own start, so it gives the trim no cut there.
    const touching = graphOf({ a: [0, 0], b: [20, 0], j: [10, 0], o: [10, 5], e: [15, 5] }, [line('edge', 'a', 'b'),
      { id: 'bend', kind: 'arc', construction: false, centerPointId: 'o', startPointId: 'j', endPointId: 'e', direction: 'ccw' }],
      [{ id: 'on-edge', kind: 'point-on-line', pointId: 'j', lineId: 'edge' }]);
    expect(() => prepareCadSketchTrim({ graph: touching, parameters: {}, entityId: 'edge', parameter: .75 })).toThrowError(expect.objectContaining({ code: 'tangent-sketch-trim' }));
    // A fence ending on the edge at j cuts there, at the existing point.
    const graph = graphOf({ a: [0, 0], b: [20, 0], j: [10, 0], e: [10, 10] }, [line('edge', 'a', 'b'), line('fence', 'j', 'e')],
      [{ id: 'on-edge', kind: 'point-on-line', pointId: 'j', lineId: 'edge' }]);
    const { target } = prepareCadSketchTrim({ graph, parameters: {}, entityId: 'edge', parameter: .75 });
    if (target.kind !== 'end') throw new Error('Expected an end trim at the contact.');
    expect(target.boundary.endpointPointId).toBe('j');
    expect(target.removedRelationIds).toEqual(['on-edge']);
    const trimmed = trimCadSketchEntity({ graph, parameters: {}, trim: { ...target, cutPointId: 'j' } });
    expect(trimmed.graph.entities[0]).toEqual(line('edge', 'a', 'j'));
    expect(trimmed.graph.relations).toEqual([]);
  });
});

describe('copies with relations', () => {
  // An L with its own relations, a vertical mirror line at x = 20 and a far point outside the copy.
  const lShape = (relations: readonly CadSketchGraphRelation[]) => graphOf({ a: [0, 0], b: [10, 0], c: [10, 5], s: [20, -10], t: [20, 10], far: [40, 40] },
    [line('ab', 'a', 'b'), line('bc', 'b', 'c'), line('mirror', 's', 't', true)], relations);
  const lRelations: readonly CadSketchGraphRelation[] = [
    { id: 'perp', kind: 'perpendicular', lineIds: ['ab', 'bc'] },
    { id: 'len', kind: 'distance', pointIds: ['a', 'b'], value: 10, annotation: { kind: 'linear', offset: 3, along: .5 } },
    { id: 'level', kind: 'horizontal', pointIds: ['a', 'b'] },
    { id: 'gap', kind: 'point-line-distance', pointId: 'c', lineId: 'ab', side: 'left', value: 5 },
    { id: 'angle', kind: 'line-angle', rays: [{ lineId: 'ab', towardPointId: 'b' }, { lineId: 'bc', towardPointId: 'c' }], sense: 'ccw', value: 90 },
    { id: 'out', kind: 'distance', pointIds: ['c', 'far'], value: Math.hypot(30, 35) },
    { id: 'to-line', kind: 'distance', pointIds: ['b', 't'], value: Math.hypot(10, 10) },
    { id: 'pin', kind: 'fixed-point', pointId: 'a', position: [0, 0] }];

  it('carries internal relations and those reaching only the mirror line onto a mirrored copy, reflected, and drops the rest', () => {
    const graph = lShape(lRelations), sketch = sketchOf(graph);
    const mirrored = prepareCadSketchMirror({ sketch, parameters: {}, entityIds: ['ab', 'bc'], axisLineId: 'mirror', idPrefix: 'm', copyRelations: true }).sketch.graph!;
    expect(mirrored.relations.slice(0, lRelations.length)).toEqual(graph.relations);
    // Points copy in id order, a, b, c, and edges in id order, ab then bc. Placement stays with the original.
    expect(mirrored.relations.slice(lRelations.length)).toEqual([
      { id: 'm_r0', kind: 'perpendicular', lineIds: ['m_e0', 'm_e1'] },
      { id: 'm_r1', kind: 'distance', pointIds: ['m_p0', 'm_p1'], value: 10 },
      { id: 'm_r2', kind: 'point-line-distance', pointId: 'm_p2', lineId: 'm_e0', side: 'right', value: 5 },
      { id: 'm_r3', kind: 'line-angle', rays: [{ lineId: 'm_e0', towardPointId: 'm_p1' }, { lineId: 'm_e1', towardPointId: 'm_p2' }], sense: 'cw', value: 90 },
      { id: 'm_r4', kind: 'distance', pointIds: ['m_p1', 't'], value: Math.hypot(10, 10) }]);
    expect(checkCadSketchGraph(mirrored, {})).toEqual([]);
    // Each left-out relation says why.
    const reasons = Object.fromEntries(copyCadSketchRelations(graph, { kind: 'mirror', curves: new Map([['ab', piece('m_e0', [0, 1])], ['bc', piece('m_e1', [0, 1])]]),
      points: new Map([['a', 'm_p0'], ['b', 'm_p1'], ['c', 'm_p2']]), invariant: new Set(['mirror', 's', 't']), relationId: (_relation, index) => `m_r${index}` })
      .flatMap(item => item.kind === 'remove' ? [[item.relation.id, item.reason]] : []));
    expect(Object.keys(reasons)).toEqual(['level', 'out', 'pin']);
    expect(reasons.out).toMatch(/outside the copy/);
    // Without the mode the mirror copies geometry and its joins only, as before.
    expect(prepareCadSketchMirror({ sketch, parameters: {}, entityIds: ['ab', 'bc'], axisLineId: 'mirror', idPrefix: 'm' }).sketch.graph!.relations).toEqual(graph.relations);
  });

  it('keeps the axes and H and V through a mirror about the V axis, turning the H axis round', () => {
    const graph = graphOf({ a: [10, 0], b: [20, 0], c: [20, 5] }, [line('ab', 'a', 'b'), line('bc', 'b', 'c')], [
      { id: 'level', kind: 'horizontal', pointIds: ['a', 'b'] },
      { id: 'rise', kind: 'line-angle', rays: [{ lineId: 'bc', towardPointId: 'c' }, { lineId: '@h', towardPointId: '@h' }], sense: 'cw', value: 90 },
      { id: 'reach', kind: 'distance', pointIds: ['a', '@origin'], value: 10 }]);
    const edit = { kind: 'mirror-sketch-geometry', sketchId: 'sketch', entityIds: ['ab', 'bc'], axisLineId: '@v', idPrefix: 'f', copyRelations: true } as const;
    const document = applyCadEdits({ ...circleRowPart(), parameters: {}, features: [sketchOf(graph)] }, [edit]);
    const mirrored = (document.features[0] as CadSketchFeature).graph!;
    expect(mirrored.relations.slice(graph.relations.length)).toEqual([
      { id: 'f_r0', kind: 'horizontal', pointIds: ['f_p0', 'f_p1'] },
      { id: 'f_r1', kind: 'line-angle', rays: [{ lineId: 'f_e1', towardPointId: 'f_p2' }, { lineId: '@h', towardPointId: '@origin' }], sense: 'ccw', value: 90 },
      { id: 'f_r2', kind: 'distance', pointIds: ['f_p0', '@origin'], value: 10 }]);
    expect(checkCadSketchGraph(mirrored, {})).toEqual([]);
  });

  it('copies only reference dimensions onto a pattern occurrence, with one reason for drivers and another for other geometry', () => {
    const graph = graphOf({ c: [10, 10], far: [40, 10] }, [{ id: 'seed', kind: 'circle', construction: false, centerPointId: 'c', radius: 3 }], [
      { id: 'size', kind: 'radial-size', entityId: 'seed', quantity: 'radius', value: 3 },
      { id: 'measure', kind: 'reference-dimension', measurement: { kind: 'radial-size', entityId: 'seed', quantity: 'diameter' } },
      { id: 'reach', kind: 'reference-dimension', measurement: { kind: 'point-distance', pointIds: ['c', 'far'] } },
      { id: 'pin', kind: 'fixed-point', pointId: 'c', position: [10, 10] }]);
    const outcomes = copyCadSketchRelations(graph, { kind: 'pattern', curves: new Map([['seed', piece('row_i1_e0', [0, 1])]]),
      points: new Map([['c', 'row_i1_p0']]), relationId: (_relation, index) => `row_i1_r${index}` });
    expect(outcomes.flatMap(item => item.kind === 'replace' ? item.relations : [])).toEqual([
      { id: 'row_i1_r0', kind: 'reference-dimension', measurement: { kind: 'radial-size', entityId: 'row_i1_e0', quantity: 'diameter' } }]);
    const reasons = Object.fromEntries(outcomes.flatMap(item => item.kind === 'remove' ? [[item.relation.id, item.reason]] : []));
    expect(Object.keys(reasons)).toEqual(['size', 'reach', 'pin']);
    expect(reasons.size).toMatch(/pattern owns its occurrences/);
    expect(reasons.pin).toBe(reasons.size);
    expect(reasons.reach).toMatch(/outside the copy/);
  });

  it('takes copyRelations in the shared mirror and offset requests, so a proposal previews exactly what the edit commits', () => {
    const plate = pairedBoreMirrorPart(), plateSketch = plate.features[0];
    if (plateSketch.kind !== 'sketch' || !plateSketch.graph) throw new Error('Bore plate missing.');
    const sized = parseCadDocument({ ...plate, features: [{ ...plateSketch, graph: { ...plateSketch.graph,
      relations: [{ id: 'bore-size', kind: 'reference-dimension', measurement: { kind: 'radial-size', entityId: 'bore', quantity: 'diameter' } }] } }] });
    const mirror = { ...mirrorBoreRequest, copyRelations: true } as const;
    const mirrored = applyCadEdits(sized, [{ kind: 'mirror-sketch-geometry', sketchId: 'sketch', ...mirror }]), source = sized.features[0] as CadSketchFeature;
    expect(mirrored.features[0]).toEqual(prepareCadSketchMirror({ sketch: source, parameters: sized.parameters, ...mirror }).sketch);
    expect((mirrored.features[0] as CadSketchFeature).graph!.relations.map(relation => relation.id)).toEqual(['bore-size', 'mirror_r0']);
    expect(inspectCadSketchRegions(sized, 'sketch', { mode: 'graph-cells', proposal: { mirror } }))
      .toEqual({ ...inspectCadSketchRegions(mirrored, 'sketch', { mode: 'graph-cells' }), proposed: true });

    const box = graphOf({ a: [0, 0], b: [10, 0], c: [10, 5], d: [0, 5] }, [line('ab', 'a', 'b'), line('bc', 'b', 'c'), line('cd', 'c', 'd'), line('da', 'd', 'a')],
      [{ id: 'square', kind: 'perpendicular', lineIds: ['ab', 'bc'] }]);
    const boxPart = parseCadDocument({ ...createCadDocument('Box', 'box'), schemaVersion: 2, features: [sketchOf(box)] });
    const offset = { source: { kind: 'graph-cycle', sourceRefs: compileCadSketchGraph(box, {}).cycles[0].sourceRefs }, distance: 2, idPrefix: 'o', copyRelations: true } as const;
    const grown = applyCadEdits(boxPart, [{ kind: 'offset-sketch-loop', sketchId: 'sketch', ...offset }]);
    expect(grown.features[0]).toEqual(prepareCadSketchOffset({ sketch: boxPart.features[0] as CadSketchFeature, parameters: {}, ...offset }).sketch);
    expect((grown.features[0] as CadSketchFeature).graph!.relations.map(relation => relation.id)).toEqual(['square', 'o_r0']);
    expect(inspectCadSketchRegions(boxPart, 'sketch', { mode: 'graph-cells', proposal: { offset } }))
      .toEqual({ ...inspectCadSketchRegions(grown, 'sketch', { mode: 'graph-cells' }), proposed: true });

    // Both refuse a malformed flag alike.
    expect(() => validateCadSketchRegionProposal({ mirror: { ...mirrorBoreRequest, copyRelations: 'yes' } } as never))
      .toThrowError(expect.objectContaining({ code: 'invalid-region-proposal' }));
    expect(() => applyCadEdits(sized, [{ kind: 'mirror-sketch-geometry', sketchId: 'sketch', ...mirrorBoreRequest, copyRelations: 'yes' } as never]))
      .toThrowError(expect.objectContaining({ code: 'invalid-edit' }));
  });

  it('carries directions, angles and parallels onto an offset loop, but no length the offset changes', () => {
    const graph = graphOf({ a: [0, 0], b: [10, 0], c: [10, 5], d: [0, 5] }, [line('ab', 'a', 'b'), line('bc', 'b', 'c'), line('cd', 'c', 'd'), line('da', 'd', 'a')], [
      { id: 'level', kind: 'horizontal', pointIds: ['a', 'b'] },
      { id: 'upright', kind: 'vertical', pointIds: ['b', 'c'] },
      { id: 'square', kind: 'perpendicular', lineIds: ['ab', 'bc'] },
      { id: 'width', kind: 'distance', pointIds: ['a', 'b'], value: 10 },
      { id: 'across', kind: 'parallel', lineIds: ['ab', 'cd'] }]);
    const [cycle] = compileCadSketchGraph(graph, {}).cycles;
    const offset = prepareCadSketchOffset({ sketch: sketchOf(graph), parameters: {}, source: { kind: 'graph-cycle', sourceRefs: cycle.sourceRefs }, distance: 2, idPrefix: 'o', copyRelations: true });
    const result = offset.sketch.graph!, copy = (id: string) => `o_e${cycle.sourceRefs.findIndex(ref => ref.entityId === id)}`;
    const ends = (id: string) => { const entity = result.entities.find(item => item.id === copy(id)); return entity?.kind === 'line' ? [entity.startPointId, entity.endPointId].sort() : []; };
    const copied = result.relations.slice(graph.relations.length);
    expect(copied.map(relation => relation.kind)).toEqual(['horizontal', 'vertical', 'perpendicular', 'parallel']);
    expect(copied[0].kind === 'horizontal' && [...copied[0].pointIds].sort()).toEqual(ends('ab'));
    expect(copied[1].kind === 'vertical' && [...copied[1].pointIds].sort()).toEqual(ends('bc'));
    expect(copied[2]).toEqual({ id: 'o_r2', kind: 'perpendicular', lineIds: [copy('ab'), copy('bc')] });
    expect(copied[3]).toEqual({ id: 'o_r3', kind: 'parallel', lineIds: [copy('ab'), copy('cd')] });
    expect(checkCadSketchGraph(result, {})).toEqual([]);
  });
});
