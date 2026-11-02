import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { CadEditSchema } from '@/domain/cad/cadOperations';
import { CadParameterNameSchema } from '@/domain/cad/cadParameters';
import { CadDocumentSchema } from '@/domain/cad/cadSchema';
import { CadError } from '@/domain/cad/cadError';
import { CadStorageError } from '@/domain/cad/cadStorage';
import { CadSectionRequestSchema } from '@/domain/cad/cadSection';
import { CadViewportCommandSchema } from './cadViewportControls';
import { cadViewportMetadataToken, cadViewportToolState } from './cadViewportToolReplies';
import { cadFeatureDefinition, cadFeatureKinds } from '@/domain/cad/features/cadFeatureRegistry';
import { cadFeaturePresentation } from '@/domain/cad/features/cadFeaturePresentation';
import { CadTopologyPickSchema, CadTopologyResolvePicksRequestSchema } from '@/domain/cad/cadTopology';
import { CadSolidImportSourceSchema } from '@/domain/cad/cadImports';
import { CadDxfImportSourceSchema } from '@/domain/cad/cadDxfSource';
import { isCadImportData } from '@/domain/cad/cadImportData';
import type { CadDiagnostic, CadDocument, CadFeature } from '@/domain/cad/cadDocument';
import { object, page, pageFields as workbenchPageFields, SITE_TOOL_PAGE_BYTE_BUDGET, siteTool, ToolError } from '@/features/webmcp/siteTools';
import { jsonByteLength, summarizeDiagnostic } from '@/features/webmcp/diagnosticSummaries';
import { CadSessionError } from './cadSession';
import { CadPluginPackageSchema, fingerprintCadPluginPackage } from '@/domain/cad/plugins/cadPlugins';
import type { CadController } from './useCadController';
import type { CadSketchEditWarning } from './cadEditPreparation';
import { CadToolDocumentEnvelope, CadToolEditDefinitions, CadToolEditEnvelope, CadToolPluginPackageEnvelope, CadToolSketchEnvelope, CadToolSketchConstraintsQuerySchema } from './cadToolSchemas';
import { pageCadSketchConstraints, summarizeCadSketchConstraintAnalysis } from './cadSketchConstraintInspection';
import { CadSketchPreparationError } from './cadSketchConstraintFeedback';
import { CadSketchRegionProposalSchema, CadSketchTrimAtSchema, CadSketchExtendAtSchema, CadSketchRegionReadTargetSchema } from '@/domain/cad/cadSketchRegionInspection';
import { CadSketchCutAxesSchema } from '@/domain/cad/cadSketchTrimExtend';
import { CadSketchSplitDependencyError } from '@/domain/cad/cadSketchSplit';
import { CadSketchTrimDependencyError, CadSketchExtendDependencyError } from '@/domain/cad/cadSketchTrimExtend';
import { CadSketchTangentOwnershipError } from '@/domain/cad/cadSketchTangentRelations';
import { CadSketchPlacementDependencyError } from '@/domain/cad/cadSketchPlacement';
import { CAD_SKETCH_AGENT_RELATION_KINDS } from '@/domain/cad/sketch-relations/cadSketchRelationRegistry';
import { CadConstructionPointSchema, CadPathConstructionStepSchema, createCadPathProfile, createCadOpenCurveSegments } from '@/domain/cad/cadPathConstruction';
import { cadAnalyticPathMetrics, resolveCadProfile } from '@/domain/cad/cadSketchGeometry';
import { resolveCadCurve } from '@/domain/cad/cadCurve';
import { CadIdentifierSchema } from '@/domain/cad/cadPrimitives';
import { MAX_CAD_LOFT_SECTIONS, MIN_CAD_LOFT_SECTIONS } from '@/domain/cad/cadLoft';
import { CadFeatureInputRequestSchema } from './cadFeatureInput';

const id = Type.String({ minLength: 1, maxLength: 160 });
const version = { expectedVersion: id };
const pageFields = { ...workbenchPageFields, offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })) };
/** Discovery names each proposal branch; execution validates the complete witnessed target. */
const proposalTarget = (description: string) => Type.Object({}, { additionalProperties: true, description });
const regionProposalEnvelope = Type.Object({ sketch: Type.Optional(CadToolSketchEnvelope),
  split: Type.Optional(proposalTarget('split-sketch-entity target fields.')),
  trim: Type.Optional(proposalTarget('trimPreview.target plus allocated trim-sketch-entity IDs.')),
  extend: Type.Optional(proposalTarget('extendPreview.target plus endPointId.')),
  offset: Type.Optional(proposalTarget('{source,distance,idPrefix}')),
  mirror: Type.Optional(proposalTarget('{entityIds,axisLineId,idPrefix}')),
  parameterValues: CadSketchRegionProposalSchema.anyOf[0].properties.parameterValues
}, { additionalProperties: false, minProperties: 1, description: 'At most one of sketch, split, trim, extend, offset or mirror.' });
const regionInspectionSchema = Type.Union([
  object({ ...version, sketchId: CadIdentifierSchema, ...pageFields, mode: Type.Optional(Type.Literal('graph-cells')), proposal: Type.Optional(CadSketchRegionProposalSchema) }),
  object({ ...version, sketchId: CadIdentifierSchema, ...pageFields, mode: Type.Optional(Type.Literal('graph-cells')), trimAt: CadSketchTrimAtSchema, axes: Type.Optional(CadSketchCutAxesSchema) }),
  object({ ...version, sketchId: CadIdentifierSchema, ...pageFields, mode: Type.Optional(Type.Literal('graph-cells')), extendAt: CadSketchExtendAtSchema, axes: Type.Optional(CadSketchCutAxesSchema) })
]);
const regionReferenceCommon = { ...version, sketchId: CadIdentifierSchema, offset: pageFields.offset,
  length: Type.Optional(Type.Integer({ minimum: 1, maximum: 4096 })), proposal: Type.Optional(CadSketchRegionProposalSchema) };
const regionReferenceSchema = Type.Union([object({ ...regionReferenceCommon, boundaryProfileId: CadSketchRegionReadTargetSchema.anyOf[0] }),
  object({ ...regionReferenceCommon, ...CadSketchRegionReadTargetSchema.anyOf[1].properties })]);
/** Flat discovery rows; the execution unions above still reject combined or missing selectors. */
const regionInspectionDiscovery = Type.Object({ ...version, sketchId: CadIdentifierSchema, ...pageFields, mode: Type.Optional(Type.Literal('graph-cells')),
  proposal: Type.Optional(regionProposalEnvelope), trimAt: Type.Optional(CadSketchTrimAtSchema), extendAt: Type.Optional(CadSketchExtendAtSchema),
  axes: Type.Optional(CadSketchCutAxesSchema)
}, { additionalProperties: false, description: 'proposal, trimAt and extendAt are mutually exclusive.' });
const regionReferenceDiscovery = Type.Object({ ...regionReferenceCommon, proposal: Type.Optional(proposalTarget('The identical proposal object given to cad_inspect_sketch_regions.')),
  boundaryProfileId: Type.Optional(CadSketchRegionReadTargetSchema.anyOf[0]), cellIds: Type.Optional(CadSketchRegionReadTargetSchema.anyOf[1].properties.cellIds)
}, { additionalProperties: false, description: 'Exactly one of boundaryProfileId or cellIds.' });
const pathConstructionSchema = object({ start: CadConstructionPointSchema,
  steps: Type.Array(CadPathConstructionStepSchema, { minItems: 1, maxItems: 128 }) });
/**
 * `schema` with each copy of a shared schema replaced by a `$ref` to one definition under `$defs`, which carries it once with its
 * name as `$id`. A sketch definition repeats its scalar, identifier and dimension placement schemas dozens of times; naming them keeps
 * it within the reply budget. Validate it with `$defs` as references.
 */
function withSharedDefinitions(schema: TSchema, shared: Readonly<Record<string, TSchema>>): TSchema {
  const names = new Map(Object.entries(shared).map(([name, definition]) => [JSON.stringify(definition), name]));
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== 'object') return node;
    const name = names.get(JSON.stringify(node));
    if (name) return Type.Ref(name);
    const copy: Record<string | symbol, unknown> = {};
    for (const key of Reflect.ownKeys(node)) copy[key] = visit((node as Record<string | symbol, unknown>)[key]);
    return copy;
  };
  return { ...visit(schema) as TSchema, $defs: Object.fromEntries(Object.entries(shared).map(([name, definition]) => [name, { ...definition, $id: name }])) };
}
const documentText = new WeakMap<CadDocument, string>();
function diagnosticSummary(diagnostics: readonly CadDiagnostic[]) {
  const summaries = diagnostics.slice(0, 10).map(summarizeDiagnostic);
  // Body pages may use 24 KiB. Keep diagnostics bounded even for escaped Unicode.
  while (summaries.length && jsonByteLength(summaries) > 4096) summaries.pop();
  return { diagnostics: summaries, omittedDiagnostics: diagnostics.length - summaries.length };
}
/** Tool summaries retain complete entries; the immutable document stays complete. */
function parameterContext(document: CadDocument) {
  const parameters: Record<string, number> = {};
  let parameterCount = 0, retainedParameterCount = 0, parameterBytes = 2, parametersFull = false;
  for (const name in document.parameters) {
    if (!Object.hasOwn(document.parameters, name)) continue;
    parameterCount++;
    if (parametersFull) continue;
    const value = document.parameters[name];
    const bytes = jsonByteLength({ [name]: value }) - 2 + (retainedParameterCount ? 1 : 0);
    if (parameterBytes + bytes > 4096) { parametersFull = true; continue; }
    parameters[name] = value; retainedParameterCount++; parameterBytes += bytes;
  }
  const allGroups = document.parameterGroups ?? [], parameterGroups: { id: string; name: string }[] = [];
  let groupBytes = 2;
  for (const group of allGroups) {
    const summary = { id: group.id, name: group.name };
    const bytes = jsonByteLength(summary) + (parameterGroups.length ? 1 : 0);
    if (groupBytes + bytes > 4096) break;
    parameterGroups.push(summary); groupBytes += bytes;
  }
  return { parameters, parameterCount, omittedParameters: retainedParameterCount < parameterCount,
    omittedParameterCount: parameterCount - retainedParameterCount, parameterGroups, parameterGroupCount: allGroups.length,
    omittedParameterGroups: parameterGroups.length < allGroups.length, omittedParameterGroupCount: allGroups.length - parameterGroups.length };
}
// The kinds agents may name, in catalog order; each definition holds what they are told of it.
const agentFeatureKinds = cadFeatureKinds().filter(kind => cadFeaturePresentation(kind).agent.exposed);

/** No code execution or hidden controller shortcuts: agents use the visible CAD operations. */
export function cadSiteTools(getController: () => CadController) {
  function tool<S extends TSchema>(name: string, description: string, schema: S,
    execute: (cad: CadController, input: Static<S>, signal: AbortSignal) => unknown | Promise<unknown>, readOnly = true, discoverySchema?: TSchema) {
    const operation = siteTool(name, description, schema, async (input, signal) => {
      try { return await execute(getController(), input, signal); }
      catch (error) {
        if (error instanceof CadSketchPreparationError) throw new ToolError(error.code, error.message, { feedback: error.feedback,
          analysis: summarizeCadSketchConstraintAnalysis({ kind: 'rejected', reason: error.feedback.reason, message: error.solverMessage, diagnostics: error.diagnostics }) });
        if (error instanceof CadSketchSplitDependencyError) throw new ToolError(error.code, error.message, {
          relationIds: error.relationIds.slice(0, 8), relationCount: error.relationIds.length, omittedRelationCount: Math.max(0, error.relationIds.length - 8)
        });
        if (error instanceof CadSketchTrimDependencyError || error instanceof CadSketchExtendDependencyError || error instanceof CadSketchPlacementDependencyError) throw new ToolError(error.code, error.message, {
          ...(error instanceof CadSketchPlacementDependencyError ? { entityIds: error.entityIds.slice(0, 8), entityCount: error.entityIds.length, omittedEntityCount: Math.max(0, error.entityIds.length - 8) } : {}),
          relationIds: error.relationIds.slice(0, 8), relationCount: error.relationIds.length, omittedRelationCount: Math.max(0, error.relationIds.length - 8),
          pointIds: error.pointIds.slice(0, 8), pointCount: error.pointIds.length, omittedPointCount: Math.max(0, error.pointIds.length - 8)
        });
        if (error instanceof CadSketchTangentOwnershipError) throw new ToolError(error.code, error.message, { ownerRelationId: error.ownerRelationId });
        if (error instanceof CadError || error instanceof CadSessionError || error instanceof CadStorageError) throw new ToolError(error.code, error.message);
        throw error;
      }
    }, readOnly);
    return { ...operation, inputSchema: discoverySchema ?? operation.inputSchema, execute(input: unknown, options?: { signal?: AbortSignal }) {
      // Validate portable own data before TypeBox reads fields or a handler runs.
      if (!options?.signal?.aborted && !isCadImportData(input)) return Promise.resolve({ ok: false,
        error: { code: 'INVALID_ARGUMENT', message: 'CAD tool arguments must contain their own complete JSON data fields.' } });
      return operation.execute(input, options);
    } };
  }
  function context(cad: CadController) {
    const state = cad.session.getSnapshot();
    const referenceOnly = state.document.features.length > 0 && state.document.features.every(feature => feature.kind === 'curve' || feature.kind === 'datum-plane');
    const hasCurves = state.document.features.some(feature => feature.kind === 'curve');
    return { open: cad.isOpen(), version: state.version, documentId: state.document.id, name: state.document.name,
      units: state.document.units, dirty: state.dirty, savedVersion: state.savedVersion,
      featureCount: state.document.features.length, ...parameterContext(state.document),
      canUndo: state.canUndo, canRedo: state.canRedo, workflowOpen: state.workflowOpen, busy: cad.isBusy(),
      buildState: cad.buildState, buildVersion: cad.buildVersion, buildId: cad.build?.buildId ?? null,
      ...diagnosticSummary(cad.build?.diagnostics ?? []),
      supported: { sketchEntities: { schemaVersion: 2, definition: 'cad_describe_features(kind=sketch)', inspection: 'cad_inspect_sketch_constraints', edits: ['append-sketch-entities', 'delete-sketch-elements', 'set-sketch-construction', 'translate-sketch-geometry', 'place-sketch-geometry', 'move-sketch-point', 'set-sketch-relation', 'remove-sketch-relation', 'create-sketch-corner', 'split-sketch-entity', 'trim-sketch-entity', 'extend-sketch-entity', 'offset-sketch-loop', 'mirror-sketch-geometry', 'copy-sketch-profile', 'use-sketch-entity'], relations: CAD_SKETCH_AGENT_RELATION_KINDS, material: 'Whole sketch retains simple closed cycles connected by shared point IDs or explicit coincidence. Deliberate graph-cells selection can Pad/Pocket exact bounded intersection cells; inspect mode=graph-cells and pack numeric cellIds with cad_read_sketch_region_reference. Unsupported contacts reject; new cells never become automatic material.' }, sketches: ['rectangle', 'circle', 'polygon', 'slot', 'path', 'plugin'], sketchDimensions: { rectangle: ['width', 'height'], circle: ['diameter', 'radius'], slot: ['length', 'width', 'angle'], intent: 'Legacy profile dimensions bind their geometry scalars. Numeric geometry stays free; expressions stay driven. Radius/diameter share one freedom. Graph point/entity constraints are listed under sketchEntities.' }, sketchTranslation: ['rectangle', 'circle', 'slot', 'polygon', 'path'], sketchHandles: { inspection: 'cad_inspect_sketch_handles', edit: 'move-sketch-handle', scope: 'Accepted revision only; free components move without replacing dimensions or expressions.' }, plugins: { apiVersion: 2, acceptedApiVersions: [1, 2], instances: 'Exact package embedded in each profile; inputs accept named CAD parameter expressions.', relations: 'API 2 supports derived values, conditional editing, dynamic ranges, choices and constraints. Derived values cannot be stored as editable inputs.', generators: ['builtin-spur-gear', 'polygon-recipe'] }, references: ['curve', 'datum-plane'], planes: ['XY', 'XZ', 'YZ'],
        datumPlacement: { definition: 'world', supported: ['sketch', 'curve', 'extrude', 'revolve', 'loft', 'sweep'], unsupported: ['pocket'], inspection: 'cad_inspect_plane' },
        solids: ['imported', 'extrude', 'pocket', 'revolve', 'loft', 'sweep', 'fillet', 'chamfer', 'shell', 'boolean', 'transform', 'linear-pattern', 'circular-pattern', 'mirror'],
        imports: ['cad-json', 'dxf', 'step', 'stl'],
        exports: ['cad-json', 'dxf', 'step', 'stl'], expressions: 'Finite arithmetic: + - * / and parentheses over named numeric parameters. Millimeters and degrees.' },
      camHandoff: 'Choose a sketch or exact planar section of a final solid. Local 2D millimeter contours become a new detached CAM project. Sections preserve lines/arcs; unsupported curves are rejected. CAD is saved first; CAM retains its own revisions and installed machine checks.',
      nextSteps: state.workflowOpen ? ['Finish or cancel the visible CAD editor.'] : !cad.isOpen() ? ['cad_open_workspace', 'cad_create_document', 'cad_list_documents']
        : referenceOnly ? ['cad_read_features', 'cad_inspect_plane', ...(hasCurves ? ['cad_measure_curve', 'cad_export_curve_dxf'] : []), 'cad_edit_document', 'cad_save_document']
        : ['cad_read_features', 'cad_edit_document', 'cad_inspect_sketch_regions', 'cad_measure_sketch', 'cad_build', 'cad_save_document', 'cad_send_to_cam'] };
  }
  return [
    tool('cad_describe_plugin_api', 'Discover declarative CAD plugin package contracts without changing a document or storage. No arguments lists accepted API versions; apiVersion returns its complete strict package schema. Inputs and math recipes are data, never executable code. Use complete packages for installation or add-plugin-profile.', object({
      apiVersion: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(2)]))
    }), (_cad, input) => {
      if (input.apiVersion === undefined) return { items: [
        { apiVersion: 1, description: 'Bounded inputs and a pinned builtin generator or declarative polygon recipe.' },
        { apiVersion: 2, description: 'API 1 inputs/generators plus derived values, dependent bounds, choices, conditional editing and constraints.' }
      ] };
      const schema = CadPluginPackageSchema.anyOf.find(candidate => candidate.properties.apiVersion.const === input.apiVersion);
      if (!schema) throw new ToolError('NOT_FOUND', 'CAD plugin API version is not supported.');
      return { apiVersion: input.apiVersion, schema };
    }),
    tool('cad_list_plugins', 'List bounded bundled/installed CAD plugin identities, versions and packageHash pins. Read the exact package with cad_read_plugin. Saved instances embed their package; installation never updates existing parts.', object(pageFields), async (cad, input, signal) => {
      const result = await cad.plugins(signal);
      const batch = page(result.packages, input);
      const items = await Promise.all(batch.items.map(async plugin => ({ id: plugin.id, version: plugin.version, name: plugin.name, description: plugin.description.slice(0, 200), packageHash: await fingerprintCadPluginPackage(plugin) })));
      return { ...batch, items,
        diagnostics: result.diagnostics.slice(0, 10), omittedDiagnostics: Math.max(0, result.diagnostics.length - 10), truncated: result.truncated };
    }),
    tool('cad_read_plugin', 'Read the complete pinned plugin package as bounded UTF-16 text chunks. Use exact id/version/packageHash from cad_list_plugins. Concatenate text until nextOffset is null, then parse JSON. Rejects a package changed outside the application.', object({
      id: Type.String({ maxLength: 80, minLength: 1 }), version: Type.String({ maxLength: 32, minLength: 1 }), packageHash: Type.String({ pattern: '^[a-f0-9]{64}$' }),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 65536 })), length: Type.Optional(Type.Integer({ minimum: 1, maximum: 4096 }))
    }), async (cad, input, signal) => {
      const plugin = (await cad.plugins(signal)).packages.find(item => item.id === input.id && item.version === input.version);
      if (!plugin || await fingerprintCadPluginPackage(plugin) !== input.packageHash) throw new ToolError('STALE_STATE', 'Plugin package changed. Read cad_list_plugins again.');
      const text = JSON.stringify(plugin), offset = input.offset ?? 0, end = Math.min(text.length, offset + (input.length ?? 4096));
      return { id: plugin.id, version: plugin.version, packageHash: input.packageHash, text: text.slice(offset, end), totalLength: text.length, nextOffset: end < text.length ? end : null };
    }),
    tool('cad_inspect_plugin', 'Inspect one current pinned plugin profile: evaluated inputs, derived values, enabled states and issues. Same configuration evaluator; no edits or manufacturing certification. Pin version and finish workflows.', object({ ...version, sketchId: id, profileId: id }), (cad, input, signal) => cad.inspectPlugin(input.sketchId, input.profileId, input.expectedVersion, signal)),
    tool('cad_install_plugin', 'Validate and install a complete supplied CAD plugin API 1 or 2 package in the active browser cache or folder. Uses the same bounded math recipe, relation/default geometry checks, immutable ID/version collision checks and journaled writes as Plugins > Install. Does not add geometry or update existing parts. Plugin definitions are declarative data, with no network/file/application access. Finish visible editors first.', object({ ...version, package: CadPluginPackageSchema }), async (cad, input, signal) => {
      const result = await cad.installPlugin(JSON.stringify(input.package), input.expectedVersion, signal);
      return { installed: result.installed, id: result.plugin.id, version: result.plugin.version, path: result.path };
    }, false, object({ ...version, package: CadToolPluginPackageEnvelope })),
    tool('cad_inspect_plane', 'Resolve the current active datum, sketch or curve world frame and signed offset in mm. Preserves authored placement; does not certify native solid precision. Finish pending workflows; stale/unavailable references and cancellation reject. Feature definitions: cad_describe_features.', object({ ...version, featureId: id }),
      (cad, input, signal) => cad.inspectPlane(input.featureId, input.expectedVersion, signal)),
    tool('cad_inspect_sketch_regions', 'Inspect current or proposed closed sketch cells with local area/bounds. Default rows keep contour references; mode=graph-cells lists all graph-owned bounded cells, including intersections, as numeric cellId receipts to pack with cad_read_sketch_region_reference. Pin version, sketch, mode and identical proposal across pages. proposal previews one complete same-ID change, with optional numeric parameterValues; source preflight only. trimAt or extendAt return trimPreview/extendPreview; axes:[@h,@v] also cut. Complete targets per cad_describe_edits, reusing witnessed endpoint IDs, then inspect proposal.trim/extend with that exact target. offset and mirror reuse the exact edit request. Reads reserve no IDs; apply topology and consumer repairs atomically.', regionInspectionSchema, async (cad, input, signal) => {
      const { expectedVersion, mode, limit, offset = 0 } = input;
      const inspection = await cad.inspectSketchRegions(input.sketchId, input, expectedVersion, signal);
      const rows: ReadonlyArray<(typeof inspection.items)[number]> = inspection.items;
      const projected = page(rows, { limit }, cell => {
        if ('cellId' in cell) return cell;
        const referenceText = JSON.stringify(cell.reference);
        const complete = { ...cell, referenceOmitted: false, voidProfileCount: cell.reference.voidProfileIds.length,
          ancestorProfileCount: cell.reference.ancestorProfileIds.length, referenceLength: referenceText.length,
          referenceByteLength: new TextEncoder().encode(referenceText).length };
        if (jsonByteLength(complete) + 2 <= SITE_TOOL_PAGE_BYTE_BUDGET) return complete;
        const { reference: _reference, ...summary } = complete;
        return { ...summary, referenceOmitted: true, readReferenceWith: 'cad_read_sketch_region_reference' };
      });
      return { version: expectedVersion, sketchId: inspection.sketchId, ...(mode === undefined ? {} : { mode }), ...(inspection.proposed ? { proposed: true } : {}), ...(inspection.trimPreview ? { trimPreview: inspection.trimPreview } : {}), ...(inspection.extendPreview ? { extendPreview: inspection.extendPreview } : {}), coordinateSystem: inspection.coordinateSystem, units: inspection.units,
        items: projected.items, total: inspection.total,
        nextOffset: projected.nextOffset !== null ? offset + projected.nextOffset : inspection.nextOffset };
    }, true, regionInspectionDiscovery),
    tool('cad_read_sketch_region_reference', 'Read exact regionSelection reference JSON in UTF-16 chunks; concatenate until nextOffset=null. Give boundaryProfileId for an unchanged contour, or nonempty unique cellIds for one packed graph-cells selection; cell IDs are read-only locators, never saved topology. Pin version, sketch, mode and the identical optional proposal from cad_inspect_sketch_regions for every chunk. Source preflight only. Full sketch: cad_describe_features(kind=sketch). No edits.', regionReferenceSchema, async (cad, input, signal) => {
      const { expectedVersion, sketchId, proposal, offset = 0, length = 4096 } = input;
      const target = 'cellIds' in input ? { cellIds: [...input.cellIds] } : input.boundaryProfileId;
      const text = await cad.readSketchRegionReference(sketchId, target, expectedVersion, signal, proposal);
      if (offset > text.length) throw new ToolError('INVALID_ARGUMENT', 'Offset exceeds the region reference text length.');
      const end = Math.min(text.length, offset + length);
      return { version: expectedVersion, sketchId, ...(typeof target === 'string' ? { boundaryProfileId: target } : { mode: 'graph-cells', cellIds: target.cellIds }), ...(proposal === undefined ? {} : { proposed: true }),
        offset, totalLength: text.length, nextOffset: end < text.length ? end : null, text: text.slice(offset, end) };
    }, true, regionReferenceDiscovery),
    tool('cad_inspect_loft', 'Preflight 2–16 ordered sketch sources for a new Loft: exact common-frame placement, station order and precision. Does not reorder geometry or certify Join/Cut/native material. Authoring semantics: cad_describe_features(kind=loft); finish with cad_build. No edits/native work.', object({ ...version,
      sketchIds: Type.Array(CadIdentifierSchema, { minItems: MIN_CAD_LOFT_SECTIONS, maxItems: MAX_CAD_LOFT_SECTIONS, uniqueItems: true }) }),
      (cad, input, signal) => cad.inspectLoft(input.sketchIds, input.expectedVersion, signal)),
    tool('cad_inspect_sweep', 'Preflight a sketch plus open Curve for Sweep: exact placement, tangent continuity, section/rail bounds and conservative clearance. Does not relocate geometry or certify native material. Details: cad_describe_features(kind=sweep); finish with cad_build. No edits/native work.', object({ ...version, sketchId: CadIdentifierSchema, curveId: CadIdentifierSchema }),
      (cad, input, signal) => cad.inspectSweep(input.sketchId, input.curveId, input.expectedVersion, signal)),
    tool('cad_construct_curve', 'Construct and measure one open analytic line/arc chain from ordered local-mm start/steps. Keeps direction and major/minor arcs; rejects closed, disconnected, crossing or uncertain geometry. Insert returned segments with cad_edit_document using cad_describe_features(kind=curve). No edits.', pathConstructionSchema, (_cad, input) => {
      const segments = createCadOpenCurveSegments(input.start, input.steps);
      const curve = resolveCadCurve({ id: 'constructed', name: 'Curve', kind: 'curve', plane: 'XY', offset: 0, suppressed: false, segments }, {});
      return { segments, units: 'mm', segmentCount: segments.length, lengthMm: curve.length,
        startMm: curve.start, endMm: curve.end, boundsMm: curve.bounds, persisted: false };
    }),
    tool('cad_import_curve_dxf', 'Import one complete open planar line/arc chain from DXF as a fresh unsaved Curve document. Uses File > Import > Curve checks. Preserves exact source text, direction of ordered polylines, and exact circular arcs. Missing/unknown units require explicit mm/inch/cm/m; conflicting overrides, closed/multiple/branching chains, unsupported entities and approximations fail before replacing the draft. Refuses unsaved work, active workflows and stale versions; supports cancellation.', object({ ...version, source: CadDxfImportSourceSchema }),
      (cad, input, signal) => cad.importDxfCurveSource(input.source, input.expectedVersion, signal), false),
    tool('cad_measure_curve', 'Measure one exact open Curve in local and world millimeters: analytic length, bounds, ordered start/end points, plane and offset. Uses expressions in the current version. A suppressed Curve on an unavailable datum retains local measurements and returns null world placement with placementDiagnostic. Curves are reference geometry without material area or CAM contour roles. No document or storage changes.', object({ ...version, curveId: id }), async (cad, input, signal) => ({ version: input.expectedVersion, ...await cad.measureCurve(input.curveId, input.expectedVersion, signal) })),
    tool('cad_export_curve_dxf', 'Request an exact open Curve DXF download in local millimeters. Writes an ordered open LWPOLYLINE with signed circular bulges, preserving traversal. Does not close the curve, project a solid or assign CAM roles. Fails if DXF cannot preserve exact support within modeling precision.', object({ ...version, curveId: id }), (cad, input, signal) => cad.exportCurveDxf(input.curveId, input.expectedVersion, signal), false),
    tool('cad_get_context', 'Read CAD draft/version/workflow/build state and bounded parameter/group summaries. Omitted data: cad_inspect_parameters or complete cad_read_document at the same version. No writes.', object({}), cad => context(cad)),
    tool('cad_inspect_parameters', 'Read current named dimensions, groups, historical manual/plugin provenance and actual expression usages without changing the draft. With name, paginate its dimension-bearing references and read active/inactive reasons and downstream history; without name, paginate parameter summaries. Suppressed features and automatic plugin inputs are distinguished from effective links. Source is creation history and can outlive its original feature. Rejects stale versions, cancellation and pending UI workflows.', object({ ...version, name: Type.Optional(CadParameterNameSchema), ...pageFields }), async (cad, input, signal) => {
      const inspection = await cad.inspectParameters(input.expectedVersion, signal);
      const bindingSummary = (binding: typeof inspection.pluginInputs[number]) => ({ featureId: binding.featureId, profileId: binding.profileId,
        inputName: binding.inputName, effective: binding.effective, editable: binding.editable });
      const summary = (parameter: typeof inspection.parameters[number]) => ({ name: parameter.name, value: parameter.value, groupId: parameter.groupId,
        groupName: inspection.groups.find(group => group.id === parameter.groupId)?.name ?? null, source: parameter.source,
        usageCount: parameter.usages.length, activeUsageCount: parameter.usages.filter(usage => usage.active).length,
        downstreamFeatureIds: parameter.downstreamFeatureIds.slice(0, 8), downstreamCount: parameter.downstreamFeatureIds.length,
        pluginBindings: parameter.pluginBindings.slice(0, 4).map(bindingSummary), pluginBindingCount: parameter.pluginBindings.length });
      if (input.name !== undefined) {
        const parameter = inspection.parameters.find(parameter => parameter.name === input.name);
        if (!parameter) throw new ToolError('NOT_FOUND', 'Named parameter does not exist.');
        return { version: input.expectedVersion, persisted: false, parameter: summary(parameter), usages: page(parameter.usages, input) };
      }
      return { version: input.expectedVersion, persisted: false, ...page(inspection.parameters, input, summary) };
    }),
    tool('cad_construct_path', 'Construct and measure a closed analytic line/arc profile from ordered local-mm start/steps. Keeps signed major/minor arcs; adds a final straight closing edge if needed. Rejects ambiguous, crossing or zero-area geometry. Insert returned geometry with cad_edit_document using cad_describe_features(kind=sketch). No edits.', pathConstructionSchema, (_cad, input) => {
      const geometry = createCadPathProfile(input.start, input.steps);
      const resolved = resolveCadProfile(geometry, {});
      if (resolved.kind !== 'path') throw new ToolError('CONSTRUCTION_FAILED', 'The constructed profile is not an analytic path.');
      const metrics = cadAnalyticPathMetrics(resolved);
      return { geometry, units: 'mm', segmentCount: geometry.segments.length,
        areaMm2: Math.abs(metrics.signedArea), perimeterMm: metrics.length, boundsMm: metrics.bounds, persisted: false };
    }),
    tool('cad_describe_features', 'Discover exact CAD feature definitions and semantics without opening or changing a document. With no kind returns a compact catalog; provide kind for its JSON schema. Use complete feature definitions in add-feature/update-feature. Dimensions are mm, angles degrees.', object({ kind: Type.Optional(Type.Union(agentFeatureKinds.map(kind => Type.Literal(kind)))) }), (_cad, input) => {
      if (!input.kind) return { items: agentFeatureKinds.map(kind => ({ kind, description: cadFeaturePresentation(kind).agent.description })) };
      const kind = input.kind as CadFeature['kind'];
      if (!agentFeatureKinds.includes(kind)) throw new ToolError('NOT_FOUND', 'CAD feature kind was not found.');
      const { schema } = cadFeatureDefinition(kind), { agent } = cadFeaturePresentation(kind), authoring = agent.authoringSchema ?? schema;
      return { kind, description: agent.description, schema: agent.sharedDefinitions ? withSharedDefinitions(authoring, agent.sharedDefinitions) : authoring };
    }),
    tool('cad_open_workspace', 'Open the desktop CAD workspace, retaining its current draft. Refuses to leave an unsaved CAM draft or active CAM workflow.', object({}), cad => { cad.enter(); return context(cad); }, false),
    tool('cad_create_document', 'Create a blank CAD draft with a fresh identity. Does not save. Save an existing nonempty draft before replacing it.', object({ ...version, name: Type.String({ minLength: 1, maxLength: 160 }) }), (cad, input) => {
      cad.newDocument(input.name, input.expectedVersion); return context(cad);
    }, false),
    tool('cad_import_document', 'Import a complete validated wireedm-cad document as a NEW unsaved draft with a fresh identity. Call cad_describe_features for complete feature schemas; the compact feature envelope does not relax validation. Uses the visible CAD JSON Import operation; preserves expressions and feature IDs, never overwrites saved CAD. Refuses unsaved CAD/CAM drafts, stale versions and active workflows. Typed declarative CAD data only, not executable source.', object({ ...version, document: CadDocumentSchema }), async (cad, input, signal) => {
      const imported = await cad.importDocumentValue(input.document, input.expectedVersion, signal);
      return { ...context(cad), imported: imported.imported, sourceDocumentId: imported.sourceDocumentId };
    }, false, object({ ...version, document: CadToolDocumentEnvelope })),
    tool('cad_import_solid', 'Import a STEP or watertight STL file as a fresh unsaved CAD document using the same native checks as File > Import. STEP accepts UTF-8 text and embedded units. STL accepts standard padded base64 with explicit mm/inch units and produces faceted geometry. Preserves the complete original source. Refuses unsaved CAD/CAM work and open workflows. Native parsing, topology and positive-volume validation must succeed before changing the draft.', object({ ...version, source: CadSolidImportSourceSchema }),
      (cad, input, signal) => cad.importSolidSource(input.source, input.expectedVersion, signal), false),
    tool('cad_import_dxf', 'Import a complete exact DXF as a fresh CAD document containing an editable planar sketch. Preserves original text, circular arcs and analytic nesting. Uses declared units; missing/unknown units require explicit mm/inch/cm/m. Conflicting unit overrides, open/branching contours, unsupported curves and approximation are rejected. Uses the same cancellable worker operation as File > Import and refuses unsaved work or active workflows.', object({ ...version, source: CadDxfImportSourceSchema }),
      (cad, input, signal) => cad.importDxfSource(input.source, input.expectedVersion, signal), false),
    tool('cad_list_documents', 'List real saved CAD documents in the active browser cache or workbench folder. Failed files are reported and preserved.', object(pageFields), async (cad, input, signal) => {
      const result = await cad.list(signal);
      return { ...page(result.entries, input), diagnostics: result.diagnostics.slice(0, 10), omittedDiagnostics: Math.max(0, result.diagnostics.length - 10), truncated: result.truncated };
    }),
    tool('cad_open_document', 'Open a saved CAD document by ID. Refuses to replace unsaved CAD or CAM work. Read cad_get_context for expectedVersion.', object({ ...version, documentId: id }), async (cad, input, signal) => {
      await cad.openDocument(input.documentId, input.expectedVersion, signal); return context(cad);
    }, false),
    tool('cad_read_features', 'Read paginated feature definitions from the current CAD draft, including exact dimensions and expressions. Use IDs in updates; never infer them from names.', object({ ...version, ...pageFields }), (cad, input) => {
      cad.session.assertVersion(input.expectedVersion);
      return { version: input.expectedVersion, ...page(cad.session.getSnapshot().document.features, input) };
    }),
    tool('cad_read_document', 'Read complete current CAD JSON in exact bounded UTF-16 chunks, including large sketches that exceed one feature-page response. Concatenate text until nextOffset is null, then parse JSON. Offsets count JavaScript UTF-16 code units. Pin the same expectedVersion for every chunk. No save or browser download.', object({ ...version, offset: pageFields.offset, length: Type.Optional(Type.Integer({ minimum: 1, maximum: 4096 })) }), (cad, input) => {
      cad.session.assertVersion(input.expectedVersion);
      const document = cad.session.getSnapshot().document;
      let text = documentText.get(document);
      if (text === undefined) { text = JSON.stringify(document); documentText.set(document, text); }
      const offset = input.offset ?? 0;
      if (offset > text.length) throw new ToolError('INVALID_ARGUMENT', 'Offset exceeds the document text length.');
      const end = Math.min(text.length, offset + (input.length ?? 4096));
      return { version: input.expectedVersion, documentId: document.id, offset, totalLength: text.length, nextOffset: end < text.length ? end : null, text: text.slice(offset, end) };
    }),
    tool('cad_get_feature', 'Read one feature definition by exact ID in the current draft.', object({ ...version, featureId: id }), (cad, input) => {
      cad.session.assertVersion(input.expectedVersion);
      const feature = cad.session.getSnapshot().document.features.find(value => value.id === input.featureId);
      if (!feature) throw new ToolError('NOT_FOUND', 'Feature does not exist. Read cad_read_features.');
      return { version: input.expectedVersion, feature };
    }),
    tool('cad_edit_document', 'Apply typed edits atomically to the CAD draft: parameters, sketch grips/dimensions/translations, independent profile copies, preceding-sketch construction references, rename, reorder or cascade deletion. copy-sketch-profile creates a new editable numeric graph sketch from one actual accepted profile; source data stays exact. One undo step; no save. Call cad_describe_edits(kind) for fields, cad_describe_features for complete add/update definitions; execution stays strict. Rejects invalid geometry, references, stale versions and active workflows. No code execution.', object({ ...version, edits: Type.Array(CadEditSchema, { minItems: 1, maxItems: 128 }) }), async (cad, input, signal) => {
      let warnings: readonly CadSketchEditWarning[] = [];
      await cad.edit(input.edits, input.expectedVersion, true, signal, found => { warnings = found; });
      // At most eight warnings, as other edit diagnostics are listed, with how many there were.
      return { ...context(cad), ...(warnings.length ? { sketchWarnings: { items: warnings.slice(0, 8), count: warnings.length, omittedCount: Math.max(0, warnings.length - 8) } } : {}) };
    }, false, object({ ...version, edits: Type.Array(CadToolEditEnvelope, { minItems: 1, maxItems: 128 }) })),
    tool('cad_describe_edits', 'Discover CAD edit fields without opening or changing a draft. No kind returns a catalog; kind returns its strict contract. Add/update features and plugin packages use their separate complete discovery tools. Execution always validates full definitions.', object({ kind: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })) }), (_cad, input) => {
      if (!input.kind) return { items: CadToolEditDefinitions.map(schema => ({ kind: schema.properties.kind.const, description: schema.description ?? null })) };
      const schema = CadToolEditDefinitions.find(schema => schema.properties.kind.const === input.kind);
      if (!schema) throw new ToolError('NOT_FOUND', 'This CAD edit kind is unavailable. Read cad_describe_edits without kind.');
      return { kind: input.kind, schema };
    }),
    tool('cad_history', 'Undo or redo one CAD edit batch. Draft versions always advance; saved storage is unchanged until Save.', object({ ...version, direction: Type.Union([Type.Literal('undo'), Type.Literal('redo')]) }), (cad, input) => {
      if (input.direction === 'undo') cad.undo(input.expectedVersion); else cad.redo(input.expectedVersion);
      return context(cad);
    }, false),
    tool('cad_get_viewport', 'Read CAD selection, view, section, build and reference metadata with viewportToken. Large ID lists report totals/omissions; page visible-bodies or reference-features at the same expectedVersion/expectedViewportToken. STALE_VIEW needs a new summary. referencePlanes are principal glyphs without feature IDs. Verify views before capture.', Type.Union([
      object(version), object({ ...version, collection: Type.Union([Type.Literal('visible-bodies'), Type.Literal('reference-features')]),
        expectedViewportToken: Type.String({ minLength: 1, maxLength: 128 }), ...pageFields })
    ]), (cad, input) => {
      const state = cad.readViewport(input.expectedVersion);
      if (!('collection' in input)) return cadViewportToolState(cad.session, state);
      const viewportToken = cadViewportMetadataToken(cad.session, state);
      if (viewportToken !== input.expectedViewportToken) throw new ToolError('STALE_VIEW', 'The displayed viewport metadata changed. Read cad_get_viewport again before paging IDs.');
      const rows = input.collection === 'visible-bodies' ? state.visibleBodyIds : state.view?.mode === 'solid' ? state.view.referenceFeatureIds : undefined;
      if (rows === undefined) throw new ToolError('VIEW_UNAVAILABLE', 'Installed reference IDs are available in the solid viewport. Finish sketch or curve editing and wait for the reference layer.');
      return { documentId: state.documentId, documentVersion: state.documentVersion, viewportToken, collection: input.collection, ...page(rows, input) };
    }),
    tool('cad_set_viewport', 'Viewport operations: selection, named view, fit/grid, sketch/curve editing, pick mode, topology, section by the selected plane. Selecting a plane adds no sketch; cad_edit_document does. No edits or saves; active workflows block. Verify with cad_get_viewport.', object({ ...version, command: CadViewportCommandSchema }), (cad, input) => cad.changeViewport(input.command, input.expectedVersion), false),
    tool('cad_capture_preview', 'Capture current CAD draft pixels as a local PNG receipt with version, view metadata and SHA-256. Requires current build/reference layers; stale views reject. Read omitted IDs via cad_get_viewport collection pages. The blob URL is browser-local. Optional download requests a browser save; no CAD/storage edits.', object({ ...version, download: Type.Optional(Type.Boolean()) }), async (cad, input, signal) => {
      const captured = await cad.captureViewport(input.expectedVersion, input.download ?? false, signal);
      const receipt = (viewState: unknown) => ({ ...captured, viewState });
      return receipt(cadViewportToolState(cad.session, captured.viewState, receipt));
    }, false),
    tool('cad_build', 'Evaluate current CAD history in the exact solid kernel and inspect paginated body volume (mm³), bounds (mm), native solidCount (null if unavailable) and feature diagnostics. Use each returned featureId as bodyId in section and topology tools. One body can contain multiple solids. Follow nextBodyOffset with offset/limit on the same version. Lazy kernel initialization may take several seconds. Does not save or create CAM output.', object({ ...version, ...pageFields }), async (cad, input, signal) => {
      const result = await cad.inspectBuild(input.expectedVersion, signal);
      const bodies = page(result.meshes, input, mesh => ({ featureId: mesh.featureId, ...(mesh.bodyKey ? { bodyKey: mesh.bodyKey } : {}), name: mesh.name, volumeMm3: mesh.volume, solidCount: mesh.solidCount ?? null, boundsMm: mesh.bounds, triangles: mesh.indices.length / 3,
        previewFaces: new Set(mesh.faceGroups.map(group => group.key)).size, previewEdges: new Set(mesh.edgeGroups.map(group => group.key)).size }));
      return { version: input.expectedVersion, buildId: result.buildId, durationMs: result.durationMs, ...diagnosticSummary(result.diagnostics),
        bodies: bodies.items, totalBodies: bodies.total, nextBodyOffset: bodies.nextOffset };
    }),
    tool('cad_build_feature_input', 'Build the strict history before an existing Fillet, Chamfer or Shell to replace its selected edges/opening. Choose a body visible at that point; optional finite numeric parameterValues propose correlated edits without accepting them. Returns an ephemeral inputToken/buildId for the existing topology tools. The accepted document/build is unchanged. Use the resulting geometric selector and same parameter batch in cad_edit_document. Finish visible editors before agent calls.', object({ ...version, ...CadFeatureInputRequestSchema.properties }), async (cad, input, signal) => {
      const { expectedVersion, ...request } = input;
      const snapshot = await cad.buildFeatureInput(request, expectedVersion, signal);
      const mesh = snapshot.result.meshes.find(body => body.featureId === snapshot.bodyId);
      if (!mesh) throw new ToolError('NOT_FOUND', 'The requested input body is unavailable.');
      return { inputToken: snapshot.inputToken, documentId: snapshot.documentId, version: snapshot.version, featureId: snapshot.featureId, bodyId: snapshot.bodyId,
        parameterValues: snapshot.parameterValues, buildId: snapshot.result.buildId, durationMs: snapshot.result.durationMs,
        body: { featureId: mesh.featureId, name: mesh.name, volumeMm3: mesh.volume, solidCount: mesh.solidCount ?? null, boundsMm: mesh.bounds,
          previewFaces: new Set(mesh.faceGroups.map(group => group.key)).size, previewEdges: new Set(mesh.edgeGroups.map(group => group.key)).size } };
    }),
    tool('cad_inspect_topology', 'Inspect exact faces or edges of a successfully built body in world coordinates. Pin expectedVersion and expectedBuildId from cad_build, or include inputToken from cad_build_feature_input for that isolated feature input. Returns bounded descriptors and opaque keys for this build only; follow nextOffset. Lengths/coordinates are mm; areas mm². Stale snapshots are rejected without rebuilding. Keys must never be saved in features.', object({
      ...version, bodyId: id, expectedBuildId: id, kind: Type.Union([Type.Literal('edge'), Type.Literal('face')]),
      inputToken: Type.Optional(id),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 }))
    }), async (cad, input, signal) => {
      const offset = input.offset ?? 0;
      const request = { bodyId: input.bodyId, expectedBuildId: input.expectedBuildId,
        selection: { kind: 'page' as const, topology: input.kind, offset, limit: input.limit ?? 10 } };
      const result = await (input.inputToken === undefined ? cad.inspectTopology(request, input.expectedVersion, signal)
        : cad.inspectTopology(request, input.expectedVersion, signal, undefined, input.inputToken));
      const bounded = page(result.descriptors, { limit: result.descriptors.length });
      return { ...result, ...(input.inputToken === undefined ? {} : { inputToken: input.inputToken }), descriptors: bounded.items, nextOffset: bounded.nextOffset === null ? result.nextOffset : offset + bounded.nextOffset };
    }),
    tool('cad_resolve_topology', 'Convert up to 32 current edge picks into strict fillet/chamfer geometric selectors, or one planar face into an inward-shell opening query. Read-only: no feature is added. Pin the version/build from topology inspection, including inputToken for an isolated existing-feature input, then use the returned selection/opening in cad_edit_document. Exact expected counts reject ambiguity; unsupported curves fail instead of broadening selection. Numeric selectors may need explicit parameter expressions when upstream dimensions change.', object({
      ...version, ...CadTopologyResolvePicksRequestSchema.properties, inputToken: Type.Optional(id), picks: Type.Array(CadTopologyPickSchema, { minItems: 1, maxItems: 32 })
    }), async (cad, input, signal) => {
      const { expectedVersion, inputToken, ...request } = input;
      if (inputToken === undefined) return cad.resolveTopologyPicks(request, expectedVersion, signal);
      return { ...await cad.resolveTopologyPicks(request, expectedVersion, signal, undefined, inputToken), inputToken };
    }),
    tool('cad_inspect_sketch_constraints', 'Read graph freedom/status, point/entity definition and paged source relations, points or entities with exact drivers and analytic local measurements. Saved reference-dimension rows report computed measurement separately from driving values; they add no native equation. Does not apply a solve or change history. Requires a current version and closed workflows.', CadToolSketchConstraintsQuerySchema, async (cad, input, signal) => {
      const inspection = await cad.inspectSketchConstraints(input.sketchId, input.expectedVersion, signal);
      return { version: input.expectedVersion, persisted: false, sketchId: inspection.sketchId, section: input.section ?? 'relations',
        pointCount: inspection.pointCount, entityCount: inspection.entityCount, relationCount: inspection.relationCount,
        legacyProfileCount: inspection.legacyProfileCount, legacyDimensionCount: inspection.legacyDimensionCount,
        degreesOfFreedomScope: inspection.degreesOfFreedomScope, analysis: summarizeCadSketchConstraintAnalysis(inspection.analysis, inspection),
        ...pageCadSketchConstraints(inspection, input) };
    }),
    tool('cad_inspect_sketch_handles', 'Inspect revision-scoped sketch grips: exact local-mm point, handle, label and draggable state. Follow pages at one version; use the returned handle with move-sketch-handle in cad_edit_document. Grips preserve dimensions/expressions; indices are never persistent relation IDs. No edits.', object({ ...version, sketchId: id, profileId: id, ...pageFields }), async (cad, input, signal) => {
      const handles = await cad.inspectSketchHandles(input.sketchId, input.profileId, input.expectedVersion, signal);
      return { version: input.expectedVersion, sketchId: input.sketchId, profileId: input.profileId, ...page(handles, input) };
    }),
    tool('cad_measure_sketch', 'Measure one validated sketch analytically in its local millimeter coordinates: paginated per-profile area (mm²), exact perimeter (mm), bounds (mm), total material area with nested holes/islands, and cut boundary length. Construction geometry is measured separately and excluded from cut totals. This measures the sketch, not a projection of the solid. Empty sketches return zero totals and null cut bounds.', object({ ...version, sketchId: id, ...pageFields }), async (cad, input, signal) => {
      const { profiles, ...measurement } = await cad.measureSketch(input.sketchId, input.expectedVersion, signal);
      return { version: input.expectedVersion, ...measurement, profiles: page(profiles, input) };
    }),
    tool('cad_save_document', 'Save the exact shared CAD draft through the active workbench adapter with cross-tab conflict detection and journal recovery. Returns a durable save receipt. Does not generate controller output.', object(version), (cad, input, signal) => cad.save(input.expectedVersion, signal), false),
    tool('cad_inspect_section', 'Compute a final solid section on XY, XZ or YZ with a parameterized offset along the plane normal (+Z, -Y or +X respectively). Returns paginated exact local 2D lines/arcs/circles and closed-contour count. Choose a plane inside the material. Tangent, open, branching, ellipse and spline sections are rejected; no approximation. Does not save.', object({ ...version, section: CadSectionRequestSchema, ...pageFields }), async (cad, input, signal) => {
      const result = await cad.inspectSection(input.section, input.expectedVersion, signal);
      const { entities, ...summary } = result;
      return { version: input.expectedVersion, ...summary, entities: page(entities, input) };
    }),
    tool('cad_send_section_to_cam', 'Save CAD and create/open a new detached CAM project from an exact final-solid planar section. Uses the same section checks as cad_inspect_section and the visible Section for CAM action. Plane-local millimeters, no final controller output; review CAM stock, wire and installed machine setup after transfer.', object({ ...version, section: CadSectionRequestSchema }), (cad, input, signal) => cad.sendSectionToCam(input.section, input.expectedVersion, signal), false),
    tool('cad_export_section_dxf', 'Request a standalone millimeter DXF download from an exact final-solid section on XY, XZ or YZ at a parameterized plane-normal offset. Recomputes and validates the current solid; exports local 2D lines, circular arcs and circles without tessellation. Tangent, open, branching, ellipse and spline sections fail explicitly. Does not project a silhouette, save CAD or create CAM. Browser download request only.', object({ ...version, section: CadSectionRequestSchema }), (cad, input, signal) => cad.exportSectionDxf(input.section, input.expectedVersion, signal), false),
    tool('cad_send_to_cam', 'Save CAD, then create and open a NEW detached CAM project from one selected sketch in local XY millimeters. Includes non-construction closed contours with exact lines/arcs. Does not project the final solid; does not overwrite CAM or generate controller output. Review CAM planning and the installed machine setup after handoff.', object({ ...version, sketchId: id }), (cad, input, signal) => cad.sendToCam(input.sketchId, input.expectedVersion, signal), false),
    tool('cad_export_document', 'Request a portable .cad.json download of the current draft, including parametric history. This is a browser download request, not proof the browser saved it.', object(version), (cad, input) => cad.exportDocument(input.expectedVersion), false),
    tool('cad_export_solid', 'Evaluate and request a STEP B-rep or STL mesh download of the current model. Failed features block export. Browser download request only.', object({ ...version, format: Type.Union([Type.Literal('step'), Type.Literal('stl')]) }), (cad, input, signal) => cad.exportSolid(input.format, input.expectedVersion, signal), false),
    tool('cad_export_dxf', 'Request an exact 2D DXF download of a selected sketch in local coordinates. Construction geometry is excluded. Does not project the solid.', object({ ...version, sketchId: id }), (cad, input, signal) => cad.exportDxf(input.sketchId, input.expectedVersion, signal), false)
  ];
}
