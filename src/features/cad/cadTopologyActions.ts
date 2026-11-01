import type { CadBuildResult, CadDocument } from '@/domain/cad/cadDocument';
import { isCadTopologyInspectResult, isCadTopologyResolvePicksResult, parseCadTopologyInspectRequest, parseCadTopologyResolvePicksRequest,
  type CadTopologyInspectRequest, type CadTopologyInspectResult,
  type CadTopologyResolvePicksRequest, type CadTopologyResolvePicksResult } from '@/domain/cad/cadTopology';
import { isCadTopologyAdjacency, isCadTopologyTangentChain, parseCadTopologyAdjacencyRequest, parseCadTopologyTangentChainRequest, type CadTopologyAdjacency,
  type CadTopologyAdjacencyRequest, type CadTopologyTangentChain, type CadTopologyTangentChainRequest } from '@/domain/cad/cadTopologyAdjacency';
import { ToolError } from '@/features/webmcp/siteTools';

interface TopologyKernel {
  inspectTopology(document: CadDocument, request: CadTopologyInspectRequest, signal?: AbortSignal): Promise<CadTopologyInspectResult>;
  resolveTopologyPicks(document: CadDocument, request: CadTopologyResolvePicksRequest, signal?: AbortSignal): Promise<CadTopologyResolvePicksResult>;
  topologyAdjacency(document: CadDocument, request: CadTopologyAdjacencyRequest, signal?: AbortSignal): Promise<CadTopologyAdjacency>;
  topologyTangentChain(document: CadDocument, request: CadTopologyTangentChainRequest, signal?: AbortSignal): Promise<CadTopologyTangentChain>;
}
interface Bindings {
  assertReadable(expectedVersion: string, scope?: 'editor'): void;
  getDocument(): CadDocument;
  getBuild(): { readonly result: CadBuildResult | null; readonly version: string | null; readonly state: 'idle' | 'building' | 'ready' | 'error' };
  getKernel(): Promise<TopologyKernel>;
}

/** A pick belongs to the exact visible build, not merely to a document with similar geometry. */
export function createCadTopologyActions(bindings: Bindings) {
  function current(expectedVersion: string, bodyId: string, expectedBuildId: string, scope?: 'editor') {
    bindings.assertReadable(expectedVersion, scope);
    const build = bindings.getBuild();
    if (build.state !== 'ready' || build.version !== expectedVersion || !build.result) {
      throw new ToolError('BUILD_REQUIRED', 'Build the current CAD draft successfully before inspecting or selecting topology.');
    }
    if (build.result.buildId !== expectedBuildId) throw new ToolError('STALE_BUILD', 'This topology belongs to an earlier build. Build again and select the current geometry.');
    if (!build.result.meshes.some(mesh => mesh.featureId === bodyId)) throw new ToolError('NOT_FOUND', 'The selected body is not in the current CAD build.');
    return bindings.getDocument();
  }
  async function execute<Request extends { bodyId: string; expectedBuildId: string }, Result extends { bodyId: string; buildId: string }>(
    request: Request, expectedVersion: string, signal: AbortSignal | undefined, scope: 'editor' | undefined,
    operation: (kernel: TopologyKernel, document: CadDocument) => Promise<Result>, valid: (result: unknown) => result is Result
  ) {
    signal?.throwIfAborted();
    const document = current(expectedVersion, request.bodyId, request.expectedBuildId, scope);
    const kernel = await bindings.getKernel();
    signal?.throwIfAborted(); current(expectedVersion, request.bodyId, request.expectedBuildId, scope);
    const result = await operation(kernel, document);
    signal?.throwIfAborted(); current(expectedVersion, request.bodyId, request.expectedBuildId, scope);
    if (!valid(result)) invalidResult();
    if (result.bodyId !== request.bodyId || result.buildId !== request.expectedBuildId) throw new ToolError('STALE_BUILD', 'The exact CAD model changed during inspection. Rebuild and select again.');
    return { ...result, documentId: document.id, version: expectedVersion };
  }
  function invalidResult(): never { throw new ToolError('INVALID_TOPOLOGY_RESULT', 'Topology inspection did not match its requested page or selection. Rebuild before selecting again.'); }
  return {
    async inspect(request: CadTopologyInspectRequest, expectedVersion: string, signal?: AbortSignal, scope?: 'editor') {
      const reviewed = parseCadTopologyInspectRequest(request);
      const result = await execute(reviewed, expectedVersion, signal, scope,
        (kernel, document) => kernel.inspectTopology(document, reviewed, signal), isCadTopologyInspectResult);
      if (reviewed.selection.kind === 'page') {
        const { offset, limit, topology } = reviewed.selection;
        if (offset > result.total) invalidResult();
        const count = Math.max(0, Math.min(limit, result.total - offset));
        if (result.descriptors.length !== count || result.descriptors.some(descriptor => descriptor.kind !== topology)
          || result.nextOffset !== (offset + count < result.total ? offset + count : null)) invalidResult();
      } else {
        const picks = new Set(reviewed.selection.picks.map(pick => `${pick.kind}:${pick.key}`));
        if (result.total !== picks.size || result.descriptors.length !== picks.size || result.nextOffset !== null
          || result.descriptors.some(descriptor => !picks.delete(`${descriptor.kind}:${descriptor.key}`)) || picks.size) invalidResult();
      }
      return result;
    },
    /** How one body's edges and faces meet in the exact visible build, for chains of edges and faces. */
    async adjacency(request: CadTopologyAdjacencyRequest, expectedVersion: string, signal?: AbortSignal, scope?: 'editor') {
      const reviewed = parseCadTopologyAdjacencyRequest(request);
      const { documentId: _documentId, version: _version, ...result } = await execute(reviewed, expectedVersion, signal, scope,
        (kernel, document) => kernel.topologyAdjacency(document, reviewed, signal), isCadTopologyAdjacency);
      return result as CadTopologyAdjacency;
    },
    /** The edges native fillet and chamfer treat when they follow tangents from one edge of the exact visible build. */
    async tangentChain(request: CadTopologyTangentChainRequest, expectedVersion: string, signal?: AbortSignal, scope?: 'editor') {
      const reviewed = parseCadTopologyTangentChainRequest(request);
      const { documentId: _documentId, version: _version, ...result } = await execute(reviewed, expectedVersion, signal, scope,
        (kernel, document) => kernel.topologyTangentChain(document, reviewed, signal), isCadTopologyTangentChain);
      if (result.edgeKey !== reviewed.edgeKey) invalidResult();
      return result as CadTopologyTangentChain;
    },
    async resolve(request: CadTopologyResolvePicksRequest, expectedVersion: string, signal?: AbortSignal, scope?: 'editor') {
      const reviewed = parseCadTopologyResolvePicksRequest(request);
      const result = await execute(reviewed, expectedVersion, signal, scope,
        (kernel, document) => kernel.resolveTopologyPicks(document, reviewed, signal), isCadTopologyResolvePicksResult);
      if (result.purpose !== reviewed.purpose) invalidResult();
      if (result.purpose === 'shell') {
        if (result.opening.expectedCount !== 1) invalidResult();
      } else if (result.selection.expectedCount !== reviewed.picks.length || result.selection.queries.length !== reviewed.picks.length
        || result.selection.queries.some(query => query.expectedCount !== 1)) invalidResult();
      return result;
    }
  };
}
