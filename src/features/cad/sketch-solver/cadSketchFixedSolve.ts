import { cadSketchFixedComponents } from '../../../domain/cad/cadSketchFixedComponents';
import { checkCadSketchGraph } from '../../../domain/cad/cadSketchGraph';
import type { CadSketchSolveDiagnostics, CadSketchSolveInput, CadSketchSolveResult } from './cadSketchSolverTypes';

/**
 * The solve of a sketch with nothing free to move: every point and every circle radius is held fixed, as a generator's members and a
 * linked reference's edges are, and every relation already holds. Its solution is the graph itself, with no freedom left and every point
 * and edge defined, which is what the native solver answers for it. Null for a drag, for free geometry and for a relation that fails, which
 * the native solver answers. Sketches made only of generated and referenced geometry are then shown, checked and edited without starting
 * the solver worker or loading its WebAssembly.
 */
export function solveFixedCadSketch(input: CadSketchSolveInput): Extract<CadSketchSolveResult, { kind: 'solved' }> | null {
  if (input.drag) return null;
  const { graph } = input, fixed = cadSketchFixedComponents(graph);
  for (const point of graph.points) if (!fixed.pointIds.has(point.id)) return null;
  for (const entity of graph.entities) if (entity.kind === 'circle' && !fixed.circleIds.has(entity.id)) return null;
  if (checkCadSketchGraph(graph, input.parameters).length) return null;
  const diagnostics: CadSketchSolveDiagnostics = { status: 'success', degreesOfFreedom: 0, conflictingIds: [], redundantIds: [], partiallyRedundantIds: [], issues: [],
    ...(input.analyseDefinition ? { definition: { definedPointIds: graph.points.map(point => point.id), underDefinedPointIds: [],
      definedEntityIds: graph.entities.map(entity => entity.id), underDefinedEntityIds: [] } } : {}) };
  return { kind: 'solved', graph, diagnostics };
}
