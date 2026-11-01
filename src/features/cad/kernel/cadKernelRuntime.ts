import { CadError } from '../../../domain/cad/cadError';
import { cadFeatureActive } from '../../../domain/cad/features/cadFeatureActivity';
import { cadFeatureProducesBody, parseCadDocument } from '../../../domain/cad/cadSchema';
import { parseCadSectionRequest } from '../../../domain/cad/cadSection';
import { parseCadTopologyInspectRequest, parseCadTopologyResolvePicksRequest } from '../../../domain/cad/cadTopology';
import { parseCadTopologyAdjacencyRequest, parseCadTopologyTangentChainRequest } from '../../../domain/cad/cadTopologyAdjacency';
import { buildCadKernelModel, type CadKernelModel } from './cadKernelModel';
import type { CadKernelReply } from './cadKernelProtocol';
import { parseCadSolidImportSource } from '../../../domain/cad/cadImports';
import { prepareCadSolidImport } from './cadKernelImport';
import { importCadDxfSketch, parseCadDxfImportInput } from '../../../domain/cad/cadDxfImport';
import { importCadDxfCurve, parseCadDxfCurveImportInput } from '../../../domain/cad/cadCurveDxf';
import { inspectCadParameters } from '../../../domain/cad/cadParameters';
import { cadSketchGraphWithoutPlacement } from '../../../domain/cad/cadSketchPlacedDimensions';

/** Inspections never initialize WASM or reconstruct a missing/stale native snapshot. */
export function createCadKernelRuntime(initialize: () => Promise<void>) {
  let cached: { key: string; modelKey: string; model: CadKernelModel } | undefined;
  return {
    async evaluate(request: Record<string, unknown> & { id: number; kind: string }): Promise<CadKernelReply> {
      try {
        if (!['build', 'export', 'section', 'inspect-topology', 'resolve-topology-picks', 'inspect-adjacency', 'inspect-tangent-chain', 'import-solid', 'import-dxf', 'import-dxf-curve'].includes(request.kind)) throw new CadError('unsupported-operation', 'Unsupported CAD worker operation.');
        if (request.kind === 'import-dxf') return { id: request.id, kind: 'dxf-imported', result: importCadDxfSketch(parseCadDxfImportInput(request.input)) };
        if (request.kind === 'import-dxf-curve') return { id: request.id, kind: 'dxf-curve-imported', result: importCadDxfCurve(parseCadDxfCurveImportInput(request.input)) };
        if (request.kind === 'import-solid') {
          const source = parseCadSolidImportSource(request.source);
          await initialize();
          return { id: request.id, kind: 'solid-imported', result: prepareCadSolidImport(source) };
        }
        if (request.kind === 'export' && request.format !== 'step' && request.format !== 'stl') throw new CadError('unsupported-format', 'Unsupported CAD export format.');
        const section = request.kind === 'section' ? parseCadSectionRequest(request.section) : undefined;
        const document = parseCadDocument(request.document);
        const key = JSON.stringify(document);
        if (request.kind === 'inspect-topology') {
          const inspection = parseCadTopologyInspectRequest(request.inspection);
          if (!cached || cached.key !== key || cached.model.result.buildId !== inspection.expectedBuildId) throw new CadError('STALE_BUILD', 'The displayed exact model is no longer cached. Rebuild and select again.');
          return { id: request.id, kind: 'topology-inspected', result: cached.model.inspectTopology(inspection) };
        }
        if (request.kind === 'inspect-adjacency') {
          const adjacency = parseCadTopologyAdjacencyRequest(request.adjacency);
          if (!cached || cached.key !== key || cached.model.result.buildId !== adjacency.expectedBuildId) throw new CadError('STALE_BUILD', 'The displayed exact model is no longer cached. Rebuild and select again.');
          return { id: request.id, kind: 'adjacency-inspected', result: cached.model.topologyAdjacency(adjacency) };
        }
        if (request.kind === 'inspect-tangent-chain') {
          const chain = parseCadTopologyTangentChainRequest(request.chain);
          if (!cached || cached.key !== key || cached.model.result.buildId !== chain.expectedBuildId) throw new CadError('STALE_BUILD', 'The displayed exact model is no longer cached. Rebuild and select again.');
          return { id: request.id, kind: 'tangent-chain-inspected', result: cached.model.topologyTangentChain(chain) };
        }
        if (request.kind === 'resolve-topology-picks') {
          const selection = parseCadTopologyResolvePicksRequest(request.selection);
          if (!cached || cached.key !== key || cached.model.result.buildId !== selection.expectedBuildId) throw new CadError('STALE_BUILD', 'The displayed exact model is no longer cached. Rebuild and select again.');
          return { id: request.id, kind: 'topology-resolved', result: cached.model.resolveTopologyPicks(selection, document.parameters) };
        }
        if (document.features.some(feature => cadFeatureActive(feature, document) && cadFeatureProducesBody(feature))) await initialize();
        // Document/profile labels, parameter organization, dimension intent and
        // where dimensions are drawn have no native effect. Feature names remain
        // part of the key for mesh and STEP labels; validation and inspection use
        // the complete document.
        const features = document.features.map(feature => feature.kind === 'sketch' ? {
          ...feature, profiles: feature.profiles.map(({ name: _name, constraints: _constraints, ...profile }) => profile),
          ...(feature.graph ? { graph: cadSketchGraphWithoutPlacement(feature.graph) } : {}),
        } : feature);
        // Reuse the domain's influence policy: a disabled generic recipe field
        // still drives geometry; only explicitly dormant inputs are inactive.
        const parameters = Object.fromEntries(inspectCadParameters(document).parameters
          .filter(parameter => parameter.usages.some(usage => usage.active))
          .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
          .map(parameter => [parameter.name, parameter.value]));
        const modelKey = JSON.stringify({ id: document.id, units: document.units, parameters, features });
        if (request.kind === 'build') {
          if (!cached || cached.modelKey !== modelKey) {
            cached?.model.dispose(); cached = undefined;
            cached = { key, modelKey, model: buildCadKernelModel(document) };
          }
          cached.key = key;
          return { id: request.id, kind: 'built', result: cached.model.result };
        }
        // A rejected read-only query must retain the accepted model and its picks.
        const model = cached?.modelKey === modelKey ? cached.model : buildCadKernelModel(document);
        let reply: CadKernelReply;
        try {
          reply = section ? { id: request.id, kind: 'sectioned', result: model.section(section, document.parameters) }
            : { id: request.id, kind: 'exported', blob: model.export(request.format === 'step' ? 'step' : 'stl') };
        } catch (error) {
          if (model !== cached?.model) model.dispose();
          throw error;
        }
        if (model !== cached?.model) cached?.model.dispose();
        cached = { key, modelKey, model };
        return reply;
      } catch (error) {
        return { id: request.id, kind: 'error', message: error instanceof Error ? error.message : 'The CAD kernel could not complete this operation.',
          ...(error instanceof CadError ? { code: error.code } : {}) };
      }
    },
    dispose() { cached?.model.dispose(); cached = undefined; },
  };
}
