import { parseCadSketchGraph, type CadSketchGraph, type CadSketchGraphEntity, type CadSketchGraphPoint, type CadSketchGraphRelation } from '@/domain/cad/cadSketchGraph';
import { createCadSketchCornerTreatmentFromIds } from '@/domain/cad/cadSketchCornerTreatment';
import { cadSketchFixedComponents } from '@/domain/cad/cadSketchFixedComponents';
import type { CadSketchSolveInput } from '../sketch-solver/cadSketchSolverTypes';
import { createCadBenchmarkRectangleGraph } from './cadBenchmarkCases';

export interface CadSolverWorkloadCase {
  readonly id: string;
  readonly description: string;
  readonly input: CadSketchSolveInput;
}

/** Small, deterministic displacement of numeric starts, including fixed-point relation starts.
 * Expressions and external snapshots retain their ownership. Never timed as part of a solve. */
export function perturbCadSolverInput(input: CadSketchSolveInput, amount = .015): CadSketchSolveInput {
  const owned = cadSketchFixedComponents(input.graph);
  return { ...input, graph: parseCadSketchGraph({ ...input.graph, points: input.graph.points.map((point, index) => ({ ...point,
    position: point.position.map((value, axis) => typeof value === 'number' && !owned.pointIds.has(point.id)
      ? value + amount * Math.sin((index + 1) * 7 + axis * 3) : value)
  })) }) };
}

const line = (id: string, startPointId: string, endPointId: string, construction = false): CadSketchGraphEntity =>
  ({ id, kind: 'line', construction, startPointId, endPointId });
const offset = (id: string, from: string, to: string, axis: 'x' | 'y', value: number | string): CadSketchGraphRelation =>
  ({ id, kind: 'axis-distance', pointIds: [from, to], axis, value });

function topology(kind: 'open' | 'loop' | 'branch' | 'hub'): CadSketchGraph {
  const count = kind === 'open' ? 100 : 64;
  const positions = Array.from({ length: count }, (_, index): readonly [number, number] => {
    if (!index) return [0, 0];
    if (kind === 'hub') { const angle = (index - 1) * 2 * Math.PI / (count - 1), radius = index % 2 ? 40 : 32; return [radius * Math.cos(angle), radius * Math.sin(angle)]; }
    if (kind === 'loop') { const angle = index * 2 * Math.PI / count; return [40 * Math.cos(angle) - 40, 40 * Math.sin(angle)]; }
    return kind === 'branch' ? [Math.floor(Math.log2(index + 1)) * 10, index * 2] : [index * 3, index < 4 ? 0 : Math.floor((index - 1) / 3) % 2 * 2];
  });
  const points = positions.map((position, index) => ({ id: `p${index}`, position }));
  const entities: CadSketchGraphEntity[] = [], relations: CadSketchGraphRelation[] = [{ id: 'anchor', kind: 'fixed-point', pointId: 'p0', position: [0, 0] }];
  for (let index = 1; index < count; index++) {
    const parent = kind === 'hub' ? 0 : kind === 'branch' ? Math.floor((index - 1) / 2) : index - 1;
    entities.push(line(`edge${index}`, `p${parent}`, `p${index}`));
    for (const [axis, coordinate] of [['x', 0], ['y', 1]] as const)
      relations.push(offset(`dim${index}${axis}`, `p${parent}`, `p${index}`, axis, positions[index][coordinate] - positions[parent][coordinate]));
    if (kind === 'hub' && index > 1) entities.push(line(`tooth${index}`, `p${index - 1}`, `p${index}`));
  }
  if (kind === 'loop') entities.push(line('close', `p${count - 1}`, 'p0'));
  if (kind === 'hub') entities.push(line('close', `p${count - 1}`, 'p1'));
  return parseCadSketchGraph({ points, entities, relations: kind === 'open' ? relations.map(relation => relation.id === 'dim2y'
    ? { id: 'profileCollinear', kind: 'collinear', lineIds: ['edge1', 'edge2'] }
    : relation.id === 'dim3x' ? { id: 'profileEqual', kind: 'equal-length', lineIds: ['edge2', 'edge3'] } : relation) : relations });
}

/** Same identities and intent, with independent seeded permutations of all authoring arrays. */
export function shuffleCadSolverGraph(graph: CadSketchGraph): CadSketchGraph {
  let state = 741;
  const shuffle = <T>(values: readonly T[]): T[] => {
    const result = [...values];
    for (let index = result.length - 1; index > 0; index--) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const other = state % (index + 1); [result[index], result[other]] = [result[other], result[index]];
    }
    return result;
  };
  return parseCadSketchGraph({ points: shuffle(graph.points), entities: shuffle(graph.entities), relations: shuffle(graph.relations) });
}

/** 24-edge stepped die outline, two treated corners, a tangent capsule slot, six patterned
 * bores, a shoulder angle, symmetry guides and a midpoint. Everything is connected by intent.
 * Coordinates are dimensioned, not expression-fixed, so edits still require a numerical solve. */
export function createCadSolverDieInput(): CadSketchSolveInput {
  const parameters = { slotRadius: 3, holeRadius: 1.5, pitch: 10, datumX: -50, datumY: -40 };
  const outline: readonly (readonly [number, number])[] = [[-40, -25], [-20, -25], [-20, -22], [-10, -22], [-10, -25], [10, -25],
    [10, -22], [20, -22], [20, -25], [40, -25], [40, -10], [36, -6], [36, 6], [40, 10], [40, 25], [20, 25],
    [20, 22], [10, 22], [10, 25], [-10, 25], [-10, 22], [-20, 22], [-20, 25], [-40, 25]];
  let graph = parseCadSketchGraph({ points: outline.map((position, index) => ({ id: `v${index}`, position })),
    entities: outline.map((_, index) => line(`side${index}`, `v${index}`, `v${(index + 1) % outline.length}`)), relations: [] });
  graph = createCadSketchCornerTreatmentFromIds({ graph, parameters, pointId: 'v14', treatment: { kind: 'fillet', radius: 2,
    trimPointIds: ['filletA', 'filletB'], centerPointId: 'filletCenter', entityId: 'filletArc', relationId: 'fillet' } }).graph;
  graph = createCadSketchCornerTreatmentFromIds({ graph, parameters, pointId: 'v0', treatment: { kind: 'chamfer', setbacks: [2, 2],
    trimPointIds: ['chamferA', 'chamferB'], entityId: 'chamferEdge', relationId: 'chamfer' } }).graph;
  const points: CadSketchGraphPoint[] = [...graph.points], entities: CadSketchGraphEntity[] = [...graph.entities], relations: CadSketchGraphRelation[] = [...graph.relations];
  relations.push({ id: 'anchor', kind: 'fixed-point', pointId: 'v0', position: outline[0] });
  outline.forEach((position, index) => { if (index) for (const [axis, coordinate] of [['x', 0], ['y', 1]] as const) {
    if (index === 11 && axis === 'y') continue;
    relations.push(offset(`outline${index}${axis}`, 'v0', `v${index}`, axis, position[coordinate] - outline[0][coordinate]));
  } });
  const located = (id: string, position: readonly [number, number]) => {
    points.push({ id, position });
    relations.push(offset(`${id}x`, 'v0', id, 'x', position[0] + 40), offset(`${id}y`, 'v0', id, 'y', position[1] + 25));
  };
  located('guideEnd', [40, -25]); entities.push(line('angleGuide', 'v0', 'guideEnd', true));
  relations.push({ id: 'shoulderAngle', kind: 'line-angle', rays: [{ lineId: 'angleGuide', towardPointId: 'guideEnd' }, { lineId: 'side10', towardPointId: 'v11' }], sense: 'ccw', value: 135 });
  located('axisA', [0, -35]); located('axisB', [0, 35]); entities.push(line('symmetryAxis', 'axisA', 'axisB', true));
  points.push({ id: 'mid', position: [15, -22] }); entities.push(line('midGuide', 'mid', 'slotL', true));
  relations.push({ id: 'midpoint', kind: 'midpoint', pointId: 'mid', lineId: 'side6' });
  located('slotL', [-12, 0]); points.push({ id: 'slotR', position: [12, 0] });
  relations.push({ id: 'symmetry', kind: 'symmetric', pointIds: ['slotL', 'slotR'], lineId: 'symmetryAxis' });
  for (const [id, position] of [['slotA', [-12, 3]], ['slotB', [12, 3]], ['slotC', [12, -3]], ['slotD', [-12, -3]]] as const) points.push({ id, position });
  entities.push(line('slotTop', 'slotA', 'slotB'), line('slotBottom', 'slotC', 'slotD'),
    { id: 'slotRight', kind: 'arc', construction: false, centerPointId: 'slotR', startPointId: 'slotB', endPointId: 'slotC', direction: 'cw' },
    { id: 'slotLeft', kind: 'arc', construction: false, centerPointId: 'slotL', startPointId: 'slotD', endPointId: 'slotA', direction: 'cw' });
  for (const [edge, arc, point] of [['slotTop', 'slotLeft', 'slotA'], ['slotTop', 'slotRight', 'slotB'], ['slotBottom', 'slotRight', 'slotC'], ['slotBottom', 'slotLeft', 'slotD']] as const)
    relations.push({ id: `tangent${point}`, kind: 'tangent-joint', endpoints: [{ entityId: edge, pointId: point }, { entityId: arc, pointId: point }] });
  relations.push({ id: 'slotSize', kind: 'radial-size', entityId: 'slotLeft', quantity: 'radius', value: ' slotRadius ' },
    { id: 'slotEqual', kind: 'equal-radius', curveIds: ['slotLeft', 'slotRight'] });
  located('holeCenter', [-25, 15]); entities.push({ id: 'hole', kind: 'circle', construction: false, centerPointId: 'holeCenter', radius: 1.5 });
  relations.push({ id: 'holeSize', kind: 'radial-size', entityId: 'hole', quantity: 'radius', value: 'holeRadius' });
  for (let index = 1; index < 6; index++) {
    points.push({ id: `holes_i${index}_p0`, position: [-25 + index * 10, 15] });
    entities.push({ id: `holes_i${index}_e0`, kind: 'circle', construction: false, centerPointId: `holes_i${index}_p0`, radius: 1.5 });
  }
  relations.push({ id: 'holeRow', kind: 'linear-pattern', seed: { kind: 'circle', entityId: 'hole', centerPointId: 'holeCenter' }, idPrefix: 'holes', direction: '+x', count: 6, spacing: 'pitch', omittedInstances: [] });
  return { graph: parseCadSketchGraph({ points, entities, relations }), parameters };
}

export function createCadSolverFreeDieInput(): CadSketchSolveInput {
  const input = createCadSolverDieInput(), dimensions = input.graph.relations.filter(relation => relation.kind === 'axis-distance');
  const removed = new Set(dimensions.slice(0, Math.round(dimensions.length * .3)).map(relation => relation.id));
  return { ...input, graph: parseCadSketchGraph({ points: [...input.graph.points, { id: 'freeA', position: [55, 20] }, { id: 'freeB', position: [65, 21] },
    { id: 'expressionPoint', position: [' datumX ', ' datumY '] }, { id: 'externalA', position: [-50, -40] }, { id: 'externalB', position: [-30, -40] }],
  entities: [...input.graph.entities, line('freeLine', 'freeA', 'freeB'), line('externalLine', 'externalA', 'externalB', true)],
  relations: [...input.graph.relations.filter(relation => !removed.has(relation.id)), { id: 'external', kind: 'external-reference', entityId: 'externalLine', sourceSketchId: 'datum',
    source: { kind: 'line', entityId: 'edge', startPointId: 'a', endPointId: 'b' } }] }) };
}

function diagnosticCases(): CadSolverWorkloadCase[] {
  const points: CadSketchGraphPoint[] = [{ id: 'a', position: [0, 0] }, { id: 'b', position: [10, 0] }, { id: 'c', position: [10, 10] }];
  const distance = (id: string, value: number): CadSketchGraphRelation => ({ id, kind: 'distance', pointIds: ['a', 'b'], value });
  const cases: CadSolverWorkloadCase[] = [];
  const add = (id: string, relations: readonly CadSketchGraphRelation[], fixturePoints = points, entities: readonly CadSketchGraphEntity[] = []) =>
    cases.push({ id, description: id.replaceAll('-', ' '), input: { graph: parseCadSketchGraph({ points: fixturePoints, entities, relations }), parameters: {} } });
  add('redundant-distances', [distance('length', 10), distance('duplicate', 10)]);
  add('partial-coincident-horizontal', [{ id: 'join', kind: 'coincident', pointIds: ['a', 'b'] }, { id: 'level', kind: 'horizontal', pointIds: ['a', 'b'] }]);
  add('partial-symmetry-midpoint', [{ id: 'sym', kind: 'symmetric', pointIds: ['a', 'b'], lineId: 'axis' }, { id: 'mid', kind: 'midpoint', pointId: 'm', lineId: 'span' }],
    [...points, { id: 'm', position: [5, 0] }, { id: 'n', position: [5, 10] }], [line('span', 'a', 'b', true), line('axis', 'm', 'n', true)]);
  add('conflicting-distances', [distance('length', 10), distance('other', 12)]);
  add('conflicting-triangle', [distance('ab', 10), { id: 'bc', kind: 'distance', pointIds: ['b', 'c'], value: 10 },
    { id: 'ac', kind: 'distance', pointIds: ['a', 'c'], value: 10 }, { id: 'diagonal', kind: 'distance', pointIds: ['a', 'c'], value: 15 }]);
  add('fixed-point-vs-dimension', [{ id: 'fixA', kind: 'fixed-point', pointId: 'a', position: [0, 0] }, { id: 'fixB', kind: 'fixed-point', pointId: 'b', position: [10, 0] }, distance('size', 12)]);
  const overlapping = [distance('length', 10), distance('other', 12), distance('third', 14),
    { id: 'vertical', kind: 'axis-distance', axis: 'y', pointIds: ['a', 'b'], value: 20 } as const];
  add('overlapping-conflicts', overlapping);
  add('overlapping-conflicts-repeated', [...overlapping, distance('repeat', 10)]);
  add('impossible-triangle', [distance('ab', 10), { id: 'bc', kind: 'distance', pointIds: ['b', 'c'], value: 10 }, { id: 'ac', kind: 'distance', pointIds: ['a', 'c'], value: 30 }]);
  for (const free of [false, true]) for (const satisfied of [false, true]) {
    const fixed: CadSketchGraphPoint[] = [{ id: 'a', position: ['0', '0'] }, { id: 'b', position: ['10', '0'] }];
    add(`fully-fixed-${satisfied ? 'satisfied' : 'conflict'}${free ? '-with-free' : ''}`, [distance('fixedSize', satisfied ? 10 : 12)], free ? [...fixed, { id: 'free', position: [20, 20] }] : fixed, [line('fixedLine', 'a', 'b')]);
  }
  return cases;
}

export function createCadSolverWorkloadCases(): CadSolverWorkloadCase[] {
  const cases: CadSolverWorkloadCase[] = [];
  const add = (id: string, graph: CadSketchGraph, description = id.replaceAll('-', ' ')) => cases.push({ id, description, input: { graph, parameters: {} } });
  for (const count of [10, 60, 200]) add(`rectangles-${count}`, createCadBenchmarkRectangleGraph(count));
  for (const count of [60, 88]) add(`connected-${count}`, createCadBenchmarkRectangleGraph(count, 'r', false, true));
  for (const kind of ['open', 'loop', 'branch', 'hub'] as const) add(`topology-${kind}`, perturbCadSolverInput({ graph: topology(kind), parameters: {} }).graph);
  add('topology-hub-shuffled', shuffleCadSolverGraph(cases.find(testCase => testCase.id === 'topology-hub')!.input.graph));
  cases.push({ id: 'die-constrained', description: 'Stepped parametric die, tangent slot and patterned holes; zero freedom.', input: perturbCadSolverInput(createCadSolverDieInput(), .001) },
    { id: 'die-free', description: 'Same die with 30% of axis dimensions removed, free line, expression point and external datum.', input: perturbCadSolverInput(createCadSolverFreeDieInput(), .001) });
  for (const [id, scale, origin] of [['tiny', .001, 0], ['far-origin', 1, 5e5]] as const) {
    const graph = createCadBenchmarkRectangleGraph(1);
    add(`numeric-${id}`, parseCadSketchGraph({ ...graph, points: graph.points.map(point => ({ ...point, position: point.position.map(value => Number(value) * scale + origin) })),
      relations: graph.relations.map(relation => relation.kind === 'fixed-point' ? { ...relation, position: relation.position.map(value => Number(value) * scale + origin) }
        : relation.kind === 'distance' ? { ...relation, value: Number(relation.value) * scale } : relation) }));
  }
  const small = cases.find(testCase => testCase.id === 'numeric-tiny')!.input.graph, large = createCadBenchmarkRectangleGraph(1, 'large');
  add('numeric-mixed-scales', parseCadSketchGraph({ points: [...small.points, ...large.points.map(point => ({ ...point, position: point.position.map(value => Number(value) + 50) }))],
    entities: [...small.entities, ...large.entities], relations: [...small.relations, ...large.relations.filter(relation => relation.id !== 'large0_fixed'),
      offset('scaleLinkX', 'r0_p0', 'large0_p0', 'x', 50), offset('scaleLinkY', 'r0_p0', 'large0_p0', 'y', 50)] }));
  const die = createCadSolverDieInput();
  // The same tangent capsule at an exact start and close to tangency, with the rest of the die retained.
  cases.push({ id: 'tangency-exact', description: 'Exact tangent slot in the constrained die.', input: die },
    { id: 'tangency-near', description: 'Slot endpoints displaced 0.00001 mm from tangency.', input: { ...die, graph: parseCadSketchGraph({ ...die.graph,
      points: die.graph.points.map(point => point.id === 'slotB' ? { ...point, position: [12.00001, 3] } : point) }) } });
  return [...cases, ...diagnosticCases()];
}
