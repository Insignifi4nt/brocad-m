// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { CadSketchFeature } from '@/domain/cad/cadDocument';
import { createCadDocument, parseCadDocument } from '@/domain/cad/cadSchema';
import type { CadSketchGraph, CadSketchGraphRelation } from '@/domain/cad/cadSketchGraph';
import { CAD_GEAR_PLUGIN } from '@/domain/cad/plugins/cadPlugins';
import { solveFixedCadSketch } from './cadSketchFixedSolve';
import { createCadSketchSolverClient, type CadSketchSolverTransport } from './cadSketchSolverClient';
import { createCadSketchTestSolver } from './__tests__/cadSketchTestSolver';

const generator = (id: string, geometry: unknown, construction = false) => ({ id, kind: 'generator', idPrefix: id, construction, geometry });
/** The accepted graph of a sketch holding `relations`, with its generators' members, and `free` plain geometry beside them. */
function graphOf(relations: readonly unknown[], free: { points?: unknown[]; entities?: unknown[] } = {}, parameters: Record<string, number> = {}): CadSketchGraph {
  const document = parseCadDocument({ ...createCadDocument('Part', 'part'), schemaVersion: 2, parameters, features: [{ id: 'sketch', kind: 'sketch', name: 'Sketch',
    suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: { points: free.points ?? [], entities: free.entities ?? [], relations } }] });
  return (document.features[0] as CadSketchFeature).graph!;
}
const fixedGraphs: Record<string, CadSketchGraph> = {
  'no geometry': graphOf([]),
  'a rectangle and a bore': graphOf([generator('plate', { kind: 'rectangle', x: -10, y: -5, width: 'w', height: 10, cornerRadius: 0 }),
    generator('bore', { kind: 'circle', x: 'w / 4', y: 0, radius: 2 })], {}, { w: 20 }),
  'a rounded plate, a hexagon, a slot and a gear': graphOf([generator('plate', { kind: 'rectangle', x: -40, y: -25, width: 80, height: 50, cornerRadius: 3 }),
    generator('hex', { kind: 'regular-polygon', x: 0, y: 0, radius: 4, sides: 6, directionId: '@h' }, true),
    generator('slot', { kind: 'slot', x: -20, y: 10, length: 12, width: 4, angle: 30 }),
    generator('gear', { kind: 'plugin', package: CAD_GEAR_PLUGIN, inputs: { module: 1, teeth: 18, pressureAngle: 20, profileShift: 0, backlash: 0, tolerance: 0.05, x: 20, y: -10, angle: 0 } })]),
  'held relations between generated edges': graphOf([generator('a', { kind: 'circle', x: 0, y: 0, radius: 2 }), generator('b', { kind: 'circle', x: 0, y: 0, radius: 2 }),
    { id: 'same', kind: 'equal-radius', curveIds: ['a_c0', 'b_c0'] }, { id: 'centred', kind: 'coincident', pointIds: ['a_k0', 'b_k0'] }]),
};

describe('sketches with nothing free to move', () => {
  it('are answered as the native solver answers them, with or without definition, and are their own solution', async () => {
    const native = createCadSketchTestSolver();
    for (const [name, graph] of Object.entries(fixedGraphs)) for (const analyseDefinition of [false, true]) {
      const parameters: Record<string, number> = name === 'a rectangle and a bore' ? { w: 20 } : {}, input = { graph, parameters, ...(analyseDefinition ? { analyseDefinition } : {}) };
      const fixed = solveFixedCadSketch(input), solved = await native.solve(input);
      expect(fixed, name).not.toBeNull();
      expect(fixed!.graph, name).toBe(graph);
      expect(solved, name).toMatchObject({ kind: 'solved' });
      expect(fixed!.diagnostics, name).toEqual(solved.diagnostics);
      expect(fixed!.graph, name).toEqual(solved.kind === 'solved' ? solved.graph : undefined);
    }
  });

  it('leave free geometry, drags and failing relations to the native solver', () => {
    const line = { points: [{ id: 'p', position: [1, 1] }, { id: 'q', position: [4, 1] }], entities: [{ id: 'l', kind: 'line', startPointId: 'p', endPointId: 'q', construction: false }] };
    const bore = generator('bore', { kind: 'circle', x: 0, y: 0, radius: 2 });
    expect(solveFixedCadSketch({ graph: graphOf([bore], line), parameters: {} })).toBeNull();
    const plate = graphOf([generator('plate', { kind: 'rectangle', x: 0, y: 0, width: 10, height: 10, cornerRadius: 0 })]);
    expect(solveFixedCadSketch({ graph: plate, parameters: {}, drag: { pointId: 'plate_p0', position: [1, 1] } })).toBeNull();
    // A relation the generated geometry does not satisfy is a conflict, which only the native solver diagnoses.
    const unequal = graphOf([bore, generator('pin', { kind: 'circle', x: 9, y: 0, radius: 2 })]);
    const failing: CadSketchGraphRelation = { id: 'same', kind: 'equal-radius', curveIds: ['bore_c0', 'pin_c0'] };
    const pin = unequal.entities.find(entity => entity.id === 'pin_c0')!;
    expect(solveFixedCadSketch({ graph: { ...unequal, entities: unequal.entities.map(entity => entity === pin ? { ...pin, radius: 3 } : entity), relations: [...unequal.relations, failing] }, parameters: {} })).toBeNull();
  });

  it('never start the solver worker, which a sketch with free geometry starts', async () => {
    const started: CadSketchSolverTransport[] = [];
    const client = createCadSketchSolverClient(() => {
      const transport: CadSketchSolverTransport = { onmessage: null, onerror: null, onmessageerror: null, postMessage() {}, terminate() {} };
      started.push(transport); return transport;
    });
    const graph = fixedGraphs['a rounded plate, a hexagon, a slot and a gear'];
    await expect(client.solve({ graph, parameters: {}, analyseDefinition: true })).resolves.toMatchObject({ kind: 'solved', diagnostics: { degreesOfFreedom: 0 } });
    expect(started).toHaveLength(0);
    const line = { points: [{ id: 'p', position: [1, 1] }, { id: 'q', position: [4, 1] }], entities: [{ id: 'l', kind: 'line', startPointId: 'p', endPointId: 'q', construction: false }] };
    void client.solve({ graph: graphOf([], line), parameters: {} }).catch(() => undefined);
    expect(started).toHaveLength(1);
    client.dispose();
  });
});
