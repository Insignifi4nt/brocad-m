import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { CAD_SKETCH_SOLVED_LAYOUT_VERSION, CadSketchGraphIssueSchema, cadSketchGraphWithSolvedValues, cadSketchSolvedValues, checkCadSketchGraph,
  parseCadSketchGraph, type CadSketchGraph } from '../../../domain/cad/cadSketchGraph';
import { CadIdentifierSchema, CadNumberSchema } from '../../../domain/cad/cadPrimitives';
import { cadImportDataCopy, cadImportDataFields, isCadImportData } from '../../../domain/cad/cadImportData';
import { CadError } from '../../../domain/cad/cadError';
import { cadSketchExternalReferenceComponents } from '../../../domain/cad/cadSketchExternalReferences';
import { cadSketchFixedComponents } from '../../../domain/cad/cadSketchFixedComponents';
import { cadSketchLinearPatternLockReason } from '../../../domain/cad/cadSketchLinearPattern';
import { cadSketchGeneratorLockReason } from '../../../domain/cad/sketch-generators/cadSketchGenerators';
import type { CadSketchSolveDiagnostics, CadSketchSolveInput, CadSketchSolveResult } from './cadSketchSolverTypes';

// The graph is not part of this schema: its own parser validates it, once.
const envelopeSchema = Type.Object({ parameters: Type.Record(Type.String(), CadNumberSchema),
  drag: Type.Optional(Type.Object({ pointId: CadIdentifierSchema, position: Type.Tuple([CadNumberSchema, CadNumberSchema]) }, { additionalProperties: false })),
  analyseDefinition: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const diagnosticsFields = {
  status: Type.Union([Type.Literal('success'), Type.Literal('converged'), Type.Literal('failed'), Type.Literal('invalid'), Type.Null()]),
  degreesOfFreedom: Type.Union([Type.Integer(), Type.Null()]),
  conflictingIds: Type.Array(CadIdentifierSchema), redundantIds: Type.Array(CadIdentifierSchema), partiallyRedundantIds: Type.Array(CadIdentifierSchema),
  issues: Type.Array(CadSketchGraphIssueSchema)
};
const diagnosticsSchema = Type.Object(diagnosticsFields, { additionalProperties: false });
// Only a solved result says which geometry is defined.
const solvedDiagnosticsSchema = Type.Object({ ...diagnosticsFields, definition: Type.Optional(Type.Object({
  definedPointIds: Type.Array(CadIdentifierSchema), underDefinedPointIds: Type.Array(CadIdentifierSchema),
  definedEntityIds: Type.Array(CadIdentifierSchema), underDefinedEntityIds: Type.Array(CadIdentifierSchema)
}, { additionalProperties: false })) }, { additionalProperties: false });
const resultSchema = Type.Union([
  Type.Object({ kind: Type.Literal('solved'), layout: Type.Literal(CAD_SKETCH_SOLVED_LAYOUT_VERSION), values: Type.Array(Type.Number()), diagnostics: solvedDiagnosticsSchema },
    { additionalProperties: false }),
  Type.Object({ kind: Type.Literal('rejected'), reason: Type.Union([Type.Literal('invalid-input'), Type.Literal('too-large'), Type.Literal('conflicting'), Type.Literal('redundant'), Type.Literal('failed'), Type.Literal('invalid-solution')]),
    message: Type.String({ maxLength: 8192 }), diagnostics: diagnosticsSchema }, { additionalProperties: false })
]);
export interface CadSketchSolverRequest { readonly id: number; readonly kind: 'solve'; readonly input: CadSketchSolveInput }
export type CadSketchSolverReply = { readonly id: number; readonly kind: 'result'; readonly result: CadSketchSolveResult }
  | { readonly id: number; readonly kind: 'error'; readonly message: string };
/** A solved result crosses the worker boundary as its solved values only; the client applies them to its own request graph. */
export type CadSketchSolverWireResult = Exclude<CadSketchSolveResult, { readonly kind: 'solved' }>
  | { readonly kind: 'solved'; readonly layout: number; readonly values: readonly number[]; readonly diagnostics: CadSketchSolveDiagnostics };
export type CadSketchSolverWireReply = { readonly id: number; readonly kind: 'result'; readonly result: CadSketchSolverWireResult }
  | { readonly id: number; readonly kind: 'error'; readonly message: string };

export function cadSketchSolverWireResult(result: CadSketchSolveResult): CadSketchSolverWireResult {
  return result.kind === 'solved' ? { kind: 'solved', layout: CAD_SKETCH_SOLVED_LAYOUT_VERSION, values: cadSketchSolvedValues(result.graph), diagnostics: result.diagnostics } : result;
}

export function parseCadSketchSolveInput(value: unknown): CadSketchSolveInput {
  // Each field is read once, so the graph validated is the graph used.
  const fields = cadImportDataFields(value);
  if (!fields || !('graph' in fields)) throw new Error('Invalid sketch solver input.');
  const { graph: source, ...fieldsBesideGraph } = fields;
  // A private copy, so parsing the graph cannot change the parameters or drag checked here.
  const envelope = cadImportDataCopy(fieldsBesideGraph);
  if (!isCadImportData(envelope) || !Value.Check(envelopeSchema, envelope)) throw new Error('Invalid sketch solver input.');
  let graph: CadSketchGraph;
  try { graph = parseCadSketchGraph(source); }
  catch (error) { throw error instanceof CadError && error.code === 'invalid-sketch-graph' ? new Error('Invalid sketch solver input.') : error; }
  const { parameters, drag, analyseDefinition } = envelope;
  if (drag && analyseDefinition) throw new Error('A sketch drag cannot ask which geometry is defined.');
  if (drag && !graph.points.some(point => point.id === drag.pointId)) throw new Error('The sketch drag point does not exist.');
  if (drag && cadSketchExternalReferenceComponents(graph).pointIds.has(drag.pointId)) throw new Error('Detach the sketch reference before dragging its geometry.');
  if (drag && cadSketchLinearPatternLockReason(graph, { kind: 'point', id: drag.pointId })) throw new Error('Edit the seed or detach the linear pattern before dragging generated geometry.');
  const generatedLock = drag ? cadSketchGeneratorLockReason(graph, { id: drag.pointId }) : null;
  if (generatedLock) throw new Error(generatedLock);
  return Object.freeze({ graph, parameters: Object.freeze({ ...parameters }), ...(drag ? { drag: Object.freeze({ pointId: drag.pointId,
    position: Object.freeze([drag.position[0], drag.position[1]] satisfies [number, number]) }) } : {}), ...(analyseDefinition ? { analyseDefinition: true } : {}) });
}

/**
 * Whether a solved reply's definition is one `input` can have: present exactly when asked for,
 * naming only its points and entities, each once.
 */
function definitionMatchesInput(input: CadSketchSolveInput, definition: CadSketchSolveDiagnostics['definition']) {
  if (!definition) return input.analyseDefinition !== true;
  if (input.analyseDefinition !== true) return false;
  const distinct = (known: readonly { readonly id: string }[], ...lists: readonly (readonly string[])[]) => {
    const ids = new Set(known.map(item => item.id)), seen = new Set<string>();
    return lists.every(list => list.every(id => ids.has(id) && !seen.has(id) && seen.add(id)));
  };
  return distinct(input.graph.points, definition.definedPointIds, definition.underDefinedPointIds)
    && distinct(input.graph.entities, definition.definedEntityIds, definition.underDefinedEntityIds);
}

export function isCadSketchSolverEnvelope(value: unknown): value is { id: number; kind: string } {
  return typeof value === 'object' && value !== null && 'id' in value && Number.isSafeInteger(value.id) && typeof value.id === 'number' && value.id > 0
    && 'kind' in value && typeof value.kind === 'string';
}

export function cadSketchSolutionMatchesInput(input: CadSketchSolveInput, graph: CadSketchSolveInput['graph']) {
  if (graph.points.length !== input.graph.points.length || graph.entities.length !== input.graph.entities.length) return false;
  const owned = cadSketchFixedComponents(input.graph);
  return Value.Equal({ ...graph, points: graph.points.map((point, index) => ({ ...point,
    position: point.position.map((value, axis) => typeof input.graph.points[index].position[axis] === 'number' && !owned.pointIds.has(input.graph.points[index].id) ? input.graph.points[index].position[axis] : value)
  })), entities: graph.entities.map((entity, index) => {
    const original = input.graph.entities[index];
    return entity.kind === 'circle' && original.kind === 'circle' && typeof original.radius === 'number' && !owned.circleIds.has(original.id) ? { ...entity, radius: original.radius } : entity;
  }) }, input.graph);
}

export function parseCadSketchSolverReply(value: unknown, input: CadSketchSolveInput): CadSketchSolverReply {
  if (!isCadSketchSolverEnvelope(value)) throw new Error('Invalid sketch worker response.');
  if (value.kind === 'error' && 'message' in value && typeof value.message === 'string' && value.message.length <= 8192) return { id: value.id, kind: 'error', message: value.message };
  if (value.kind !== 'result' || !('result' in value) || !Value.Check(resultSchema, value.result)) throw new Error('Invalid sketch worker response.');
  const result = value.result;
  const diagnostics: CadSketchSolveDiagnostics = result.diagnostics;
  const knownIds = new Set([...input.graph.points, ...input.graph.entities, ...input.graph.relations].map(item => item.id));
  if ([...diagnostics.conflictingIds, ...diagnostics.redundantIds, ...diagnostics.partiallyRedundantIds].some(id => !knownIds.has(id))
    || diagnostics.issues.some(issue => !knownIds.has(issue.source.id))) throw new Error('Sketch worker diagnostics do not match the request.');
  if (result.kind === 'rejected') return { id: value.id, kind: 'result', result: { ...result, diagnostics } };
  let graph: CadSketchGraph | undefined;
  try { graph = cadSketchGraphWithSolvedValues(input.graph, result.values); } catch { graph = undefined; }
  // Freedom is unknown (null) when the solver could not decide rank near a singular configuration.
  if (!graph || (diagnostics.status !== 'success' && diagnostics.status !== 'converged') || diagnostics.degreesOfFreedom !== null && diagnostics.degreesOfFreedom < 0
    || diagnostics.conflictingIds.length || diagnostics.redundantIds.length || diagnostics.partiallyRedundantIds.length || diagnostics.issues.length
    || !definitionMatchesInput(input, diagnostics.definition)
    || checkCadSketchGraph(graph, input.parameters).length) throw new Error('Sketch worker solution does not match its request or constraints.');
  return { id: value.id, kind: 'result', result: { kind: 'solved', graph, diagnostics } };
}
