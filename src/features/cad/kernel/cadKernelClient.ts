import type { CadBuildResult, CadDocument } from '../../../domain/cad/cadDocument';
import { parseCadDocument } from '../../../domain/cad/cadSchema';
import { parseCadSectionRequest, type CadSectionRequest, type CadSectionResult } from '../../../domain/cad/cadSection';
import { isCadKernelEnvelope, isCadKernelReply, type CadKernelReply, type CadKernelRequest } from './cadKernelProtocol';
import { CadError } from '../../../domain/cad/cadError';
import { parseCadTopologyInspectRequest, parseCadTopologyResolvePicksRequest, type CadTopologyInspectRequest, type CadTopologyInspectResult,
  type CadTopologyResolvePicksRequest, type CadTopologyResolvePicksResult } from '../../../domain/cad/cadTopology';
import { parseCadTopologyAdjacencyRequest, parseCadTopologyTangentChainRequest, type CadTopologyAdjacency, type CadTopologyAdjacencyRequest,
  type CadTopologyTangentChain, type CadTopologyTangentChainRequest } from '../../../domain/cad/cadTopologyAdjacency';
import { parseCadSolidImportSource, cadSolidImportByteLength, type CadSolidImportSource, type CadSolidImportResult } from '../../../domain/cad/cadImports';
import { parseCadDxfImportInput, type CadDxfImportInput, type CadDxfImportResult } from '../../../domain/cad/cadDxfImport';
import { parseCadDxfCurveImportInput, type CadDxfCurveImportInput, type CadDxfCurveImportResult } from '../../../domain/cad/cadCurveDxf';

export interface CadKernelClient {
  build(document: CadDocument, signal?: AbortSignal): Promise<CadBuildResult>;
  export(document: CadDocument, format: 'step' | 'stl', signal?: AbortSignal): Promise<Blob>;
  section(document: CadDocument, request: CadSectionRequest, signal?: AbortSignal): Promise<CadSectionResult>;
  inspectTopology(document: CadDocument, request: CadTopologyInspectRequest, signal?: AbortSignal): Promise<CadTopologyInspectResult>;
  resolveTopologyPicks(document: CadDocument, request: CadTopologyResolvePicksRequest, signal?: AbortSignal): Promise<CadTopologyResolvePicksResult>;
  topologyAdjacency(document: CadDocument, request: CadTopologyAdjacencyRequest, signal?: AbortSignal): Promise<CadTopologyAdjacency>;
  topologyTangentChain(document: CadDocument, request: CadTopologyTangentChainRequest, signal?: AbortSignal): Promise<CadTopologyTangentChain>;
  importSolid(source: CadSolidImportSource, signal?: AbortSignal): Promise<CadSolidImportResult>;
  importDxf(input: CadDxfImportInput, signal?: AbortSignal): Promise<CadDxfImportResult>;
  importDxfCurve(input: CadDxfCurveImportInput, signal?: AbortSignal): Promise<CadDxfCurveImportResult>;
  dispose(): void;
}
export interface CadWorkerTransport {
  postMessage(message: CadKernelRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
}
interface PendingJob {
  request: CadKernelRequest;
  resolve(reply: CadKernelReply): void;
  reject(error: Error): void;
  cleanup(): void;
}
type CommandWithoutId<T> = T extends CadKernelRequest ? Omit<T, 'id'> : never;
type CadKernelCommand = CommandWithoutId<CadKernelRequest>;
const abortError = () => new DOMException('CAD operation canceled.', 'AbortError');

function matchesTopologyRequest(request: CadKernelRequest, reply: CadKernelReply): boolean {
  if (reply.kind === 'error') return true;
  if (request.kind === 'build') return reply.kind === 'built';
  if (request.kind === 'export') return reply.kind === 'exported';
  if (request.kind === 'section') return reply.kind === 'sectioned';
  if (request.kind === 'import-solid') return reply.kind === 'solid-imported' && reply.result.format === request.source.format
    && reply.result.fileName === request.source.fileName && reply.result.sourceBytes === cadSolidImportByteLength(request.source);
  if (request.kind === 'import-dxf') return reply.kind === 'dxf-imported'
    && reply.result.sketch.source?.fileName === request.input.fileName && reply.result.sketch.source.text === request.input.text
    && reply.result.sketch.source.units === request.input.units
    && (request.input.sketchId === undefined || reply.result.sketch.id === request.input.sketchId)
    && (request.input.name === undefined || reply.result.sketch.name === request.input.name);
  if (request.kind === 'import-dxf-curve') return reply.kind === 'dxf-curve-imported'
    && reply.result.curve.source?.fileName === request.input.fileName && reply.result.curve.source.text === request.input.text
    && reply.result.curve.source.units === request.input.units
    && (request.input.curveId === undefined || reply.result.curve.id === request.input.curveId)
    && (request.input.name === undefined || reply.result.curve.name === request.input.name);
  if (reply.kind === 'topology-inspected') {
    if (request.kind !== 'inspect-topology' || reply.result.buildId !== request.inspection.expectedBuildId || reply.result.bodyId !== request.inspection.bodyId) return false;
    const result = reply.result; const selection = request.inspection.selection;
    if (selection.kind === 'picks') return result.total === selection.picks.length && result.nextOffset === null && result.descriptors.length === selection.picks.length
      && result.descriptors.every((descriptor, index) => descriptor.key === selection.picks[index].key && descriptor.kind === selection.picks[index].kind);
    return result.descriptors.length === Math.min(selection.limit, Math.max(0, result.total - selection.offset))
      && result.descriptors.every(descriptor => descriptor.kind === selection.topology)
      && result.nextOffset === (selection.offset + result.descriptors.length < result.total ? selection.offset + result.descriptors.length : null);
  }
  if (reply.kind === 'adjacency-inspected') return request.kind === 'inspect-adjacency'
    && reply.result.buildId === request.adjacency.expectedBuildId && reply.result.bodyId === request.adjacency.bodyId;
  if (reply.kind === 'tangent-chain-inspected') return request.kind === 'inspect-tangent-chain' && reply.result.buildId === request.chain.expectedBuildId
    && reply.result.bodyId === request.chain.bodyId && reply.result.edgeKey === request.chain.edgeKey;
  if (reply.kind === 'topology-resolved') return request.kind === 'resolve-topology-picks'
    && reply.result.buildId === request.selection.expectedBuildId && reply.result.bodyId === request.selection.bodyId && reply.result.purpose === request.selection.purpose
    && (reply.result.purpose === 'shell' ? request.selection.picks.length === 1 : reply.result.selection.expectedCount === request.selection.picks.length);
  return false;
}

/** A finite queue owns one worker; cancellation, failure and disposal release WASM. */
export function createCadKernelClient(makeWorker: () => CadWorkerTransport = () => new Worker(new URL('./cadKernel.worker.ts', import.meta.url), { type: 'module', name: 'wireedm-cad-kernel' })): CadKernelClient {
  let worker: CadWorkerTransport | undefined;
  let active: PendingJob | undefined;
  const queue: PendingJob[] = [];
  let disposed = false;
  let id = 0;
  function terminate() { worker?.terminate(); worker = undefined; }
  function finish(reply: CadKernelReply | Error) {
    const job = active;
    if (!job) return;
    active = undefined;
    job.cleanup();
    if ('kind' in reply) job.resolve(reply); else job.reject(reply);
    pump();
  }
  function fail(error: Error) { terminate(); finish(error); }
  function pump() {
    if (disposed || active || !queue.length) return;
    active = queue.shift();
    if (!active) return;
    try {
      if (!worker) {
        const transport = makeWorker(); worker = transport;
        transport.onmessage = event => {
          if (worker !== transport) return;
          if (isCadKernelEnvelope(event.data) && event.data.id !== active?.request.id) return;
          if (!isCadKernelReply(event.data)) { fail(new Error('Invalid CAD worker response.')); return; }
          if (event.data.id !== active?.request.id) return; // A stale worker can never overwrite a newer request.
          if (!active || !matchesTopologyRequest(active.request, event.data)) { fail(new Error('CAD topology response does not match the requested body and build.')); return; }
          finish(event.data.kind === 'error' ? event.data.code ? new CadError(event.data.code, event.data.message) : new Error(event.data.message) : event.data);
        };
        transport.onerror = () => { if (worker === transport) fail(new Error('The CAD worker stopped. Retry the operation to restart it.')); };
        transport.onmessageerror = () => { if (worker === transport) fail(new Error('The CAD worker response could not be read.')); };
      }
      worker.postMessage(active.request);
    } catch (error) { fail(error instanceof Error ? error : new Error('Unable to start the CAD worker.')); }
  }
  function request(command: CadKernelCommand, signal?: AbortSignal): Promise<CadKernelReply> {
    if (disposed) return Promise.reject(new Error('CAD kernel client has been disposed.'));
    if (signal?.aborted) return Promise.reject(abortError());
    if (queue.length >= 4) return Promise.reject(new Error('The CAD queue is full. Wait for the current operations to finish.'));
    const validated = command.kind === 'import-solid' ? { ...command, source: parseCadSolidImportSource(command.source) }
      : command.kind === 'import-dxf' ? { ...command, input: parseCadDxfImportInput(command.input) }
      : command.kind === 'import-dxf-curve' ? { ...command, input: parseCadDxfCurveImportInput(command.input) }
      : { ...command, document: parseCadDocument(command.document) };
    return new Promise((resolve, reject) => {
      // Boundary parsers already capture immutable input. postMessage performs the
      // worker crossing; another full clone here duplicates large imported originals.
      const payload: CadKernelRequest = { ...validated, id: ++id };
      const job: PendingJob = { request: payload, resolve, reject, cleanup: () => signal?.removeEventListener('abort', cancel) };
      const cancel = () => {
        if (active === job) { fail(abortError()); return; }
        const index = queue.indexOf(job);
        if (index >= 0) { queue.splice(index, 1); job.cleanup(); job.reject(abortError()); }
      };
      signal?.addEventListener('abort', cancel, { once: true });
      queue.push(job); pump();
    });
  }
  return {
    async build(document, signal) {
      const reply = await request({ kind: 'build', document }, signal);
      if (reply.kind !== 'built') throw new Error('Unexpected CAD build response.');
      return reply.result;
    },
    async export(document, format, signal) {
      const reply = await request({ kind: 'export', document, format }, signal);
      if (reply.kind !== 'exported') throw new Error('Unexpected CAD export response.');
      return reply.blob;
    },
    async section(document, section, signal) {
      const reply = await request({ kind: 'section', document, section: structuredClone(parseCadSectionRequest(section)) }, signal);
      if (reply.kind !== 'sectioned') throw new Error('Unexpected CAD section response.');
      return reply.result;
    },
    async inspectTopology(document, inspection, signal) {
      const reply = await request({ kind: 'inspect-topology', document, inspection: parseCadTopologyInspectRequest(inspection) }, signal);
      if (reply.kind !== 'topology-inspected') throw new Error('Unexpected CAD topology inspection response.');
      return reply.result;
    },
    async resolveTopologyPicks(document, selection, signal) {
      const reply = await request({ kind: 'resolve-topology-picks', document, selection: parseCadTopologyResolvePicksRequest(selection) }, signal);
      if (reply.kind !== 'topology-resolved') throw new Error('Unexpected CAD topology selection response.');
      return reply.result;
    },
    async topologyAdjacency(document, adjacency, signal) {
      const reply = await request({ kind: 'inspect-adjacency', document, adjacency: parseCadTopologyAdjacencyRequest(adjacency) }, signal);
      if (reply.kind !== 'adjacency-inspected') throw new Error('Unexpected CAD topology adjacency response.');
      return reply.result;
    },
    async topologyTangentChain(document, chain, signal) {
      const reply = await request({ kind: 'inspect-tangent-chain', document, chain: parseCadTopologyTangentChainRequest(chain) }, signal);
      if (reply.kind !== 'tangent-chain-inspected') throw new Error('Unexpected CAD tangent chain response.');
      return reply.result;
    },
    async importSolid(source, signal) {
      const reply = await request({ kind: 'import-solid', source: parseCadSolidImportSource(source) }, signal);
      if (reply.kind !== 'solid-imported') throw new Error('Unexpected CAD solid import response.');
      return reply.result;
    },
    async importDxf(input, signal) {
      const reply = await request({ kind: 'import-dxf', input: parseCadDxfImportInput(input) }, signal);
      if (reply.kind !== 'dxf-imported') throw new Error('Unexpected CAD DXF import response.');
      return reply.result;
    },
    async importDxfCurve(input, signal) {
      const reply = await request({ kind: 'import-dxf-curve', input: parseCadDxfCurveImportInput(input) }, signal);
      if (reply.kind !== 'dxf-curve-imported') throw new Error('Unexpected CAD Curve DXF import response.');
      return reply.result;
    },
    dispose() {
      if (disposed) return;
      disposed = true; terminate();
      if (active) { active.cleanup(); active.reject(abortError()); active = undefined; }
      for (const job of queue.splice(0)) { job.cleanup(); job.reject(abortError()); }
    }
  };
}
