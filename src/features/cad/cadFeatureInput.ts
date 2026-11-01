import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { CadBuildResult, CadDocument } from '@/domain/cad/cadDocument';
import { CadDocumentSchema, parseCadDocument } from '@/domain/cad/cadSchema';
import { cadVisibleBodyIds } from '@/domain/cad/cadFeatureInputs';
import { isCadImportData } from '@/domain/cad/cadImportData';
import { CadError } from '@/domain/cad/cadError';
import { CadIdentifierSchema } from '@/domain/cad/cadPrimitives';
import type { CadEdit } from '@/domain/cad/cadOperations';
import type { WorkbenchStorageAdapter } from '@/domain/storage/workbenchStorageAdapter';
import type { CadKernelClient } from './kernel/cadKernelClient';
import type { CadTopologyInspectRequest, CadTopologyResolvePicksRequest } from '@/domain/cad/cadTopology';
import type { CadTopologyAdjacencyRequest, CadTopologyTangentChainRequest } from '@/domain/cad/cadTopologyAdjacency';
import { createCadTopologyActions } from './cadTopologyActions';
import { ToolError } from '@/features/webmcp/siteTools';

export const CadFeatureInputRequestSchema = Type.Object({
  featureId: CadIdentifierSchema, bodyId: CadIdentifierSchema,
  parameterValues: Type.Optional(CadDocumentSchema.properties.parameters),
}, { additionalProperties: false });
type InputRequest = Static<typeof CadFeatureInputRequestSchema>;
export type CadFeatureInputRequest = Readonly<Omit<InputRequest, 'parameterValues'>> & {
  readonly parameterValues?: Readonly<NonNullable<InputRequest['parameterValues']>>;
};
export interface CadFeatureInputSnapshot {
  readonly inputToken: string;
  readonly documentId: string;
  readonly version: string;
  readonly featureId: string;
  readonly bodyId: string;
  readonly parameterValues: Readonly<Record<string, number>>;
  readonly document: CadDocument;
  readonly result: CadBuildResult;
}
type InputKernel = Pick<CadKernelClient, 'build' | 'inspectTopology' | 'resolveTopologyPicks' | 'topologyAdjacency' | 'topologyTangentChain' | 'dispose'>;
interface Bindings {
  assertCurrent(expectedVersion: string, scope?: 'editor'): { readonly document: CadDocument; readonly storage: WorkbenchStorageAdapter };
  createKernel(): Promise<InputKernel>;
  prepare(document: CadDocument, edits: readonly CadEdit[], signal?: AbortSignal): Promise<CadDocument>;
}

/** One disposable native input snapshot, separate from accepted builds and candidate readiness. */
export function createCadFeatureInputCoordinator(bindings: Bindings) {
  type Job = {
    token: string; version: string; featureId: string; bodyId: string; purpose: 'fillet' | 'chamfer' | 'shell'; scope: 'editor' | undefined;
    base: ReturnType<Bindings['assertCurrent']>; controller: AbortController; client: Promise<InputKernel> | null;
    snapshot: CadFeatureInputSnapshot | null; removeAbort(): void;
  };
  let active: Job | null = null, disposed = false;
  const stale = () => new ToolError('STALE_FEATURE_INPUT', 'This feature input is no longer current. Choose its geometry again.');
  function release(job: Job) {
    if (active === job) active = null;
    job.removeAbort(); job.controller.abort();
    void job.client?.then(client => client.dispose(), () => undefined);
  }
  function current(job: Job, expectedVersion: string, scope?: 'editor') {
    job.controller.signal.throwIfAborted();
    if (disposed || active !== job || expectedVersion !== job.version) throw stale();
    if (scope !== job.scope) throw new ToolError('WORKFLOW_OPEN', 'This feature input belongs to another workflow. Finish or cancel that selection first.');
    try {
      const next = bindings.assertCurrent(expectedVersion, scope);
      if (next.document !== job.base.document || next.storage !== job.base.storage) throw stale();
    } catch (error) { release(job); throw error; }
  }
  function ready(inputToken: string | undefined, expectedVersion: string, request: { bodyId: string; expectedBuildId: string }, scope?: 'editor') {
    const job = active;
    if (!job || job.token !== inputToken) throw stale();
    current(job, expectedVersion, scope);
    if (!job.snapshot || request.bodyId !== job.bodyId || request.expectedBuildId !== job.snapshot.result.buildId) throw stale();
    return { job, snapshot: job.snapshot };
  }
  async function read<T>(request: { bodyId: string; expectedBuildId: string }, version: string, signal: AbortSignal | undefined,
    scope: 'editor' | undefined, token: string | undefined, operation: (actions: ReturnType<typeof createCadTopologyActions>) => Promise<T>) {
    signal?.throwIfAborted();
    const { job, snapshot } = ready(token, version, request, scope);
    const actions = createCadTopologyActions({
      assertReadable(expected, access) { ready(token, expected, request, access); },
      getDocument: () => snapshot.document,
      getBuild: () => ({ result: snapshot.result, version, state: 'ready' }),
      async getKernel() {
        if (!job.client) throw stale();
        const client = await job.client;
        // Cancelling a small read discards its receipt, not the picker's native cache.
        // Only cancellation of the owned input stage terminates that worker.
        return {
          inspectTopology(document, inspection) { signal?.throwIfAborted(); return client.inspectTopology(document, inspection, job.controller.signal); },
          resolveTopologyPicks(document, selection) { signal?.throwIfAborted(); return client.resolveTopologyPicks(document, selection, job.controller.signal); },
          topologyAdjacency(document, adjacency) { signal?.throwIfAborted(); return client.topologyAdjacency(document, adjacency, job.controller.signal); },
          topologyTangentChain(document, chain) { signal?.throwIfAborted(); return client.topologyTangentChain(document, chain, job.controller.signal); },
        };
      },
    });
    try {
      const result = await operation(actions);
      current(job, version, scope); return result;
    } catch (error) {
      if (active === job && !signal?.aborted && !(error instanceof CadError && error.code !== 'STALE_BUILD')) release(job);
      throw error;
    }
  }
  return {
    async build(request: CadFeatureInputRequest, expectedVersion: string, signal?: AbortSignal, scope?: 'editor'): Promise<CadFeatureInputSnapshot> {
      signal?.throwIfAborted();
      if (disposed) throw stale();
      if (!isCadImportData(request) || !Value.Check(CadFeatureInputRequestSchema, request)) throw new ToolError('INVALID_ARGUMENT', 'Choose a feature, input body and finite numeric parameter values.');
      const captured: CadFeatureInputRequest = structuredClone(request), base = bindings.assertCurrent(expectedVersion, scope);
      const index = base.document.features.findIndex(feature => feature.id === captured.featureId), feature = base.document.features[index];
      if (!feature || (feature.kind !== 'fillet' && feature.kind !== 'chamfer' && feature.kind !== 'shell')) throw new ToolError('INVALID_FEATURE_INPUT', 'Choose an existing Fillet, Chamfer or Shell.');
      const document = parseCadDocument({ ...base.document, features: base.document.features.slice(0, index) });
      if (!cadVisibleBodyIds(document.features, document).includes(captured.bodyId)) throw new ToolError('NOT_FOUND', 'The chosen body is unavailable before this feature.');
      if (active) release(active);
      const job: Job = { token: crypto.randomUUID(), version: expectedVersion, featureId: captured.featureId, bodyId: captured.bodyId, purpose: feature.kind, scope,
        base, controller: new AbortController(), client: null, snapshot: null, removeAbort: () => signal?.removeEventListener('abort', cancel) };
      const cancel = () => release(job); active = job;
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        const parameterValues = Object.freeze({ ...captured.parameterValues });
        const edits: CadEdit[] = Object.entries(parameterValues).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
          .map(([name, value]) => ({ kind: 'set-parameter', name, value }));
        const prepared = edits.length ? await bindings.prepare(document, edits, job.controller.signal) : document;
        current(job, expectedVersion, scope);
        const kernel = job.client = Promise.resolve().then(bindings.createKernel);
        const client = await kernel; current(job, expectedVersion, scope);
        const result = await client.build(prepared, job.controller.signal); current(job, expectedVersion, scope);
        if (result.diagnostics.length) throw new ToolError('FEATURE_INPUT_BUILD_FAILED', result.diagnostics[0].message);
        if (!result.meshes.some(mesh => mesh.featureId === captured.bodyId)) throw new ToolError('NOT_FOUND', 'The requested feature input did not produce its body.');
        Object.freeze(result);
        job.snapshot = Object.freeze({ inputToken: job.token, documentId: base.document.id, version: expectedVersion,
          featureId: captured.featureId, bodyId: captured.bodyId, parameterValues, document: prepared, result });
        return job.snapshot;
      } catch (error) { if (active === job) release(job); throw error; }
    },
    inspect(request: CadTopologyInspectRequest, expectedVersion: string, signal?: AbortSignal, scope?: 'editor', inputToken?: string) {
      return read(request, expectedVersion, signal, scope, inputToken, actions => actions.inspect(request, expectedVersion, signal, scope));
    },
    adjacency(request: CadTopologyAdjacencyRequest, expectedVersion: string, signal?: AbortSignal, scope?: 'editor', inputToken?: string) {
      return read(request, expectedVersion, signal, scope, inputToken, actions => actions.adjacency(request, expectedVersion, signal, scope));
    },
    tangentChain(request: CadTopologyTangentChainRequest, expectedVersion: string, signal?: AbortSignal, scope?: 'editor', inputToken?: string) {
      return read(request, expectedVersion, signal, scope, inputToken, actions => actions.tangentChain(request, expectedVersion, signal, scope));
    },
    async resolve(request: CadTopologyResolvePicksRequest, expectedVersion: string, signal?: AbortSignal, scope?: 'editor', inputToken?: string) {
      signal?.throwIfAborted();
      const { job } = ready(inputToken, expectedVersion, request, scope);
      if (request.purpose !== job.purpose) return Promise.reject(new ToolError('INVALID_FEATURE_INPUT', 'Choose topology for the feature being edited.'));
      return read(request, expectedVersion, signal, scope, inputToken, actions => actions.resolve(request, expectedVersion, signal, scope));
    },
    clear(inputToken?: string) { if (active && (inputToken === undefined || active.token === inputToken)) release(active); },
    invalidate() { if (active) release(active); },
    dispose() { disposed = true; if (active) release(active); },
  };
}
