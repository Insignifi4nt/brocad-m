import type { CadDocument, CadScalar } from '@/domain/cad/cadDocument';
import { CadError } from '@/domain/cad/cadError';
import { createCadSketchMeasurementReader } from '@/domain/cad/cadSketchMeasurements';
import { measureCadSketchReferenceDimension } from '@/domain/cad/cadSketchReferenceDimensions';
import { evaluateCadScalar } from '@/domain/cad/cadExpression';
import { parseCadDocument } from '@/domain/cad/cadSchema';
import type { CadSketchGraph, CadSketchGraphEntity, CadSketchGraphRelation } from '@/domain/cad/cadSketchGraph';
import { cadSketchLinearPatternForSelection, cadSketchLinearPatternInstances } from '@/domain/cad/cadSketchLinearPattern';
import { cadSketchFixedComponents } from '@/domain/cad/cadSketchFixedComponents';
import { cadSketchRelationEntityIds, cadSketchRelationPointIds } from '@/domain/cad/cadSketchGraphReferences';
import { cadSketchRelationDefinition, cadSketchRelationMeaning } from '@/domain/cad/sketch-relations/cadSketchRelationRegistry';
import { page } from '@/features/webmcp/siteTools';
import { summarizeMessage, summarizeDiagnostic } from '@/features/webmcp/diagnosticSummaries';
import type { CadSketchSolveDiagnostics, CadSketchSolveResult, CadSketchSolverClient } from './sketch-solver/cadSketchSolverTypes';
import type { CadSketchConstraintSection } from './cadToolSchemas';
import { deepFreezeCadData } from '@/domain/cad/cadDeepFreeze';

export type CadSketchConstraintAnalysis = { readonly kind: 'solved'; readonly diagnostics: CadSketchSolveDiagnostics }
  | { readonly kind: 'rejected'; readonly reason: Extract<CadSketchSolveResult, { kind: 'rejected' }>['reason']; readonly message: string; readonly diagnostics: CadSketchSolveDiagnostics }
  | { readonly kind: 'unavailable' | 'legacy'; readonly message: string; readonly diagnostics: CadSketchSolveDiagnostics };
export interface CadSketchConstraintInspection {
  readonly sketchId: string;
  readonly pointCount: number; readonly entityCount: number; readonly relationCount: number;
  readonly legacyProfileCount: number; readonly legacyDimensionCount: number;
  /** Native freedom describes graph variables only, not legacy primitive groups. */
  readonly degreesOfFreedomScope: 'graph';
  readonly analysis: CadSketchConstraintAnalysis;
  readonly graph: CadSketchGraph | null;
  readonly parameters: CadDocument['parameters'];
}
const unknownDiagnostics = (): CadSketchSolveDiagnostics => ({ status: null, degreesOfFreedom: null,
  conflictingIds: [], redundantIds: [], partiallyRedundantIds: [], issues: [] });
const freezeData = (value: unknown) => deepFreezeCadData(value, { skipFrozen: true });

/**
 * Analyze copied numeric geometry; the accepted source and its exact drivers remain authoritative.
 * The solve also asks which points and entities are fully defined, which only inspection asks.
 */
export async function inspectCadSketchConstraints(document: CadDocument, sketchId: string,
  getSolver: () => Promise<Pick<CadSketchSolverClient, 'solve'>>, signal?: AbortSignal): Promise<CadSketchConstraintInspection> {
  signal?.throwIfAborted();
  const accepted = parseCadDocument(document), sketch = accepted.features.find(feature => feature.id === sketchId);
  if (sketch?.kind !== 'sketch') throw new CadError('missing-sketch', 'Choose an existing sketch to inspect its constraints.');
  const graph = sketch.graph ?? null;
  let analysis: CadSketchConstraintAnalysis;
  if (!graph) analysis = { kind: 'legacy', message: 'Legacy profiles keep their primitive dimensions. General graph freedom is unavailable.', diagnostics: unknownDiagnostics() };
  else {
    try {
      const solver = await getSolver(); signal?.throwIfAborted();
      const result = await solver.solve({ graph, parameters: accepted.parameters, analyseDefinition: true }, signal); signal?.throwIfAborted();
      const diagnostics = { ...result.diagnostics, degreesOfFreedom: result.diagnostics.degreesOfFreedom !== null && result.diagnostics.degreesOfFreedom >= 0
        ? result.diagnostics.degreesOfFreedom : null };
      analysis = result.kind === 'solved' ? { kind: 'solved', diagnostics }
        : { kind: 'rejected', reason: result.reason, message: result.message, diagnostics };
    } catch (error) {
      signal?.throwIfAborted();
      analysis = { kind: 'unavailable', message: error instanceof Error ? error.message : 'Constraint analysis is unavailable. Retry to restart the solver.', diagnostics: unknownDiagnostics() };
    }
  }
  const result: CadSketchConstraintInspection = { sketchId, graph, parameters: accepted.parameters,
    pointCount: graph?.points.length ?? 0, entityCount: graph?.entities.length ?? 0, relationCount: graph?.relations.length ?? 0,
    legacyProfileCount: sketch.profiles.length, legacyDimensionCount: sketch.profiles.reduce((total, profile) => total + (profile.constraints?.length ?? 0), 0),
    degreesOfFreedomScope: 'graph', analysis };
  freezeData(result); return result;
}

const entityPoints = (entity: CadSketchGraphEntity) => entity.kind === 'line' ? [entity.startPointId, entity.endPointId]
  : entity.kind === 'arc' ? [entity.centerPointId, entity.startPointId, entity.endPointId] : [entity.centerPointId];

/**
 * `defined`: the lasting relations and drivers leave none of its coordinates (or a circle's radius)
 * free to move; `under-defined`: some can still move; `unknown`: not analysed, as for a sketch not
 * solved, a group that did not converge, has conflicting constraints or a rank too close to call,
 * or analysis that ran out of its work.
 */
export type CadSketchDefinitionState = 'defined' | 'under-defined' | 'unknown';

/** The definition state of each graph point and entity the analysis classified; any other is unknown. */
function cadSketchDefinitionStates(analysis: CadSketchConstraintAnalysis) {
  const definition = analysis.kind === 'solved' ? analysis.diagnostics.definition : undefined;
  const states = new Map<string, CadSketchDefinitionState>();
  for (const id of [...definition?.definedPointIds ?? [], ...definition?.definedEntityIds ?? []]) states.set(id, 'defined');
  for (const id of [...definition?.underDefinedPointIds ?? [], ...definition?.underDefinedEntityIds ?? []]) states.set(id, 'under-defined');
  return (id: string): CadSketchDefinitionState => states.get(id) ?? 'unknown';
}

/** Exact source rows are paged separately from bounded native diagnostic summaries. */
export function pageCadSketchConstraints(inspection: CadSketchConstraintInspection, input: { section?: CadSketchConstraintSection; offset?: number; limit?: number }) {
  const graph = inspection.graph, points = new Map(graph?.points.map(point => [point.id, point]));
  const analysis = inspection.analysis, diagnostics = analysis.diagnostics;
  const conflicting = new Set(diagnostics.conflictingIds), redundant = new Set(diagnostics.redundantIds), partiallyRedundant = new Set(diagnostics.partiallyRedundantIds);
  const diagnosticState = (id: string) => analysis.kind === 'unavailable' || analysis.kind === 'legacy' ? null
    : { conflicting: conflicting.has(id), redundant: redundant.has(id), partiallyRedundant: partiallyRedundant.has(id) };
  const definition = cadSketchDefinitionStates(analysis);
  const adjacency = new Map<string, string[]>();
  for (const entity of graph?.entities ?? []) for (const id of entityPoints(entity)) {
    const edges = adjacency.get(id) ?? []; edges.push(entity.id); adjacency.set(id, edges);
  }
  const referenceComponents = graph ? cadSketchFixedComponents(graph) : null;
  const scalar = (value: CadScalar, driving = false, linked = false) => ({ scalar: value, valueMm: evaluateCadScalar(value, inspection.parameters),
    role: linked ? 'linked-reference' : typeof value === 'string' ? 'expression-driver' : driving ? 'constant-driver' : 'solver-variable' });
  const pattern = (kind: 'point' | 'entity', id: string) => {
    const owner = graph && cadSketchLinearPatternForSelection(graph, { kind, id });
    return owner ? { pattern: { relationId: owner.relation.id, index: owner.index, seedEntityId: owner.relation.seed.entityId,
      role: owner.index === 0 ? 'seed' as const : 'generated' as const } } : {};
  };
  const point = (id: string) => {
    const source = points.get(id); if (!source) throw new CadError('missing-sketch-point', 'The inspected point no longer exists.');
    const entities = adjacency.get(id) ?? [];
    return { id, ...pattern('point', id), position: source.position.map(value => scalar(value, false, referenceComponents?.pointIds.has(id))), diagnostics: diagnosticState(id),
      definition: definition(id), entityIds: entities.slice(0, 8), entityCount: entities.length,
      omittedEntityCount: Math.max(0, entities.length - 8) };
  };
  if (input.section === 'points') return page(graph?.points ?? [], input, source => point(source.id));
  if (input.section === 'entities') {
    const reader = graph ? createCadSketchMeasurementReader(graph, inspection.parameters) : null;
    return page(graph?.entities ?? [], input, source => {
      const row = { source, ...pattern('entity', source.id), diagnostics: diagnosticState(source.id), definition: definition(source.id), points: entityPoints(source).map(point),
        ...(source.kind === 'circle' ? { radius: scalar(source.radius, false, referenceComponents?.circleIds.has(source.id)) } : {}) };
      try { return { ...row, measurement: reader ? { coordinateSystem: 'sketch-local' as const, ...reader.entity(source.id) } : null }; }
      catch (error) { return { ...row, measurement: null, measurementDiagnostic: summarizeMessage(error instanceof Error ? error.message : 'Unable to measure this edge.') }; }
    });
  }
  // Driving values by their path: `value` is one row, and `position.0` and `position.1` a list of two.
  const driving = (source: CadSketchGraphRelation) => {
    const scalars = cadSketchRelationDefinition(source).scalars, rows: Record<string, unknown> = {};
    if (!scalars) return rows;
    const values = scalars.read(source);
    scalars.keys.forEach((key, index) => {
      const [path, item] = key.split('.'), row = scalar(values[index], true);
      if (item === undefined) rows[path] = row;
      else ((rows[path] ??= []) as unknown[])[Number(item)] = row;
    });
    return rows;
  };
  return page(graph?.relations ?? [], input, source => ({ source, meaning: cadSketchRelationMeaning(source), diagnostics: diagnosticState(source.id),
    points: graph ? cadSketchRelationPointIds(graph, source).map(point) : [],
    ...(cadSketchRelationEntityIds(source).length ? { entityIds: cadSketchRelationEntityIds(source) } : {}),
    ...(source.kind === 'linear-pattern' ? { pattern: { seed: source.seed, count: source.count, direction: source.direction,
      pitch: scalar(source.spacing, true), instances: cadSketchLinearPatternInstances(source) } }
      : source.kind === 'reference-dimension' && graph ? { measurement: { coordinateSystem: 'sketch-local' as const,
      valueMm: measureCadSketchReferenceDimension(graph, inspection.parameters, source), role: 'reference-measurement' as const } }
      : source.kind === 'line-angle' ? { value: { scalar: source.value, valueDegrees: evaluateCadScalar(source.value, inspection.parameters), unit: 'deg' as const,
      role: typeof source.value === 'string' ? 'expression-driver' as const : 'constant-driver' as const } }
      : driving(source)) }));
}

/**
 * Do not duplicate unbounded native ID/message arrays beside a source page. With the inspected
 * sketch's point and entity counts, the summary also counts each definition state.
 */
export function summarizeCadSketchConstraintAnalysis(analysis: CadSketchConstraintAnalysis, totals?: { readonly pointCount: number; readonly entityCount: number }) {
  const { diagnostics } = analysis, solved = analysis.kind === 'solved' ? diagnostics.definition : undefined;
  const counts = (defined: number, underDefined: number, total: number) => ({ defined, underDefined, unknown: total - defined - underDefined });
  const ids = (values: readonly string[]) => ({ ids: values.slice(0, 8), count: values.length, omittedCount: Math.max(0, values.length - 8) });
  return { kind: analysis.kind, status: diagnostics.status, degreesOfFreedom: diagnostics.degreesOfFreedom,
    ...(analysis.kind === 'rejected' ? { reason: analysis.reason } : {}),
    ...('message' in analysis ? summarizeMessage(analysis.message) : {}),
    conflicting: ids(diagnostics.conflictingIds), redundant: ids(diagnostics.redundantIds), partiallyRedundant: ids(diagnostics.partiallyRedundantIds),
    issues: diagnostics.issues.slice(0, 2).map(summarizeDiagnostic), issueCount: diagnostics.issues.length,
    omittedIssueCount: Math.max(0, diagnostics.issues.length - 2),
    ...totals ? { definition: { points: counts(solved?.definedPointIds.length ?? 0, solved?.underDefinedPointIds.length ?? 0, totals.pointCount),
      entities: counts(solved?.definedEntityIds.length ?? 0, solved?.underDefinedEntityIds.length ?? 0, totals.entityCount) } } : {} };
}
