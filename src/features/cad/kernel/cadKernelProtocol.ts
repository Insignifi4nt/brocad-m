import type { CadBuildResult, CadDocument, CadMesh, CadMeshTopologyGroup } from '../../../domain/cad/cadDocument';
import { cadBodyFeatureId, isCadBodyIssue, isCadBodyKey, isCadBodyState, MAX_CAD_BODY_ISSUES } from '../../../domain/cad/cadBodies';
import { isCadSectionResult, type CadSectionRequest, type CadSectionResult } from '../../../domain/cad/cadSection';
import { isCadTopologyInspectResult, isCadTopologyResolvePicksResult, type CadTopologyInspectRequest, type CadTopologyInspectResult,
  type CadTopologyResolvePicksRequest, type CadTopologyResolvePicksResult } from '../../../domain/cad/cadTopology';
import { isCadTopologyAdjacency, isCadTopologyTangentChain, type CadTopologyAdjacency, type CadTopologyAdjacencyRequest,
  type CadTopologyTangentChain, type CadTopologyTangentChainRequest } from '../../../domain/cad/cadTopologyAdjacency';
import { isCadSolidImportResult, type CadSolidImportSource, type CadSolidImportResult } from '../../../domain/cad/cadImports';
import { isCadDxfImportResult, type CadDxfImportInput, type CadDxfImportResult } from '../../../domain/cad/cadDxfImport';
import { isCadDxfCurveImportResult, type CadDxfCurveImportInput, type CadDxfCurveImportResult } from '../../../domain/cad/cadCurveDxf';

export type CadKernelRequest = { readonly id: number; readonly kind: 'build'; readonly document: CadDocument }
  | { readonly id: number; readonly kind: 'export'; readonly document: CadDocument; readonly format: 'step' | 'stl' }
  | { readonly id: number; readonly kind: 'section'; readonly document: CadDocument; readonly section: CadSectionRequest }
  | { readonly id: number; readonly kind: 'inspect-topology'; readonly document: CadDocument; readonly inspection: CadTopologyInspectRequest }
  | { readonly id: number; readonly kind: 'resolve-topology-picks'; readonly document: CadDocument; readonly selection: CadTopologyResolvePicksRequest }
  | { readonly id: number; readonly kind: 'inspect-adjacency'; readonly document: CadDocument; readonly adjacency: CadTopologyAdjacencyRequest }
  | { readonly id: number; readonly kind: 'inspect-tangent-chain'; readonly document: CadDocument; readonly chain: CadTopologyTangentChainRequest }
  | { readonly id: number; readonly kind: 'import-solid'; readonly source: CadSolidImportSource }
  | { readonly id: number; readonly kind: 'import-dxf'; readonly input: CadDxfImportInput }
  | { readonly id: number; readonly kind: 'import-dxf-curve'; readonly input: CadDxfCurveImportInput };
export type CadKernelReply = { readonly id: number; readonly kind: 'built'; readonly result: CadBuildResult }
  | { readonly id: number; readonly kind: 'exported'; readonly blob: Blob }
  | { readonly id: number; readonly kind: 'sectioned'; readonly result: CadSectionResult }
  | { readonly id: number; readonly kind: 'topology-inspected'; readonly result: CadTopologyInspectResult }
  | { readonly id: number; readonly kind: 'topology-resolved'; readonly result: CadTopologyResolvePicksResult }
  | { readonly id: number; readonly kind: 'adjacency-inspected'; readonly result: CadTopologyAdjacency }
  | { readonly id: number; readonly kind: 'tangent-chain-inspected'; readonly result: CadTopologyTangentChain }
  | { readonly id: number; readonly kind: 'solid-imported'; readonly result: CadSolidImportResult }
  | { readonly id: number; readonly kind: 'dxf-imported'; readonly result: CadDxfImportResult }
  | { readonly id: number; readonly kind: 'dxf-curve-imported'; readonly result: CadDxfCurveImportResult }
  | { readonly id: number; readonly kind: 'error'; readonly message: string; readonly code?: string };

/** The worker boundary receives structured clones, never executable model scripts. */
export function isCadKernelEnvelope(value: unknown): value is Record<string, unknown> & { id: number; kind: string } {
  return typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'number'
    && Number.isSafeInteger(value.id) && value.id > 0 && 'kind' in value && typeof value.kind === 'string';
}

export function isCadKernelReply(value: unknown): value is CadKernelReply {
  if (!isCadKernelEnvelope(value)) return false;
  if (value.kind === 'error') return typeof value.message === 'string' && value.message.length <= 8192
    && (value.code === undefined || typeof value.code === 'string' && value.code.length <= 128);
  if (value.kind === 'exported') return value.blob instanceof Blob;
  if (value.kind === 'sectioned') return isCadSectionResult(value.result);
  if (value.kind === 'topology-inspected') return isCadTopologyInspectResult(value.result);
  if (value.kind === 'topology-resolved') return isCadTopologyResolvePicksResult(value.result);
  if (value.kind === 'adjacency-inspected') return isCadTopologyAdjacency(value.result);
  if (value.kind === 'tangent-chain-inspected') return isCadTopologyTangentChain(value.result);
  if (value.kind === 'solid-imported') return isCadSolidImportResult(value.result);
  if (value.kind === 'dxf-imported') return isCadDxfImportResult(value.result);
  if (value.kind === 'dxf-curve-imported') return isCadDxfCurveImportResult(value.result);
  if (value.kind !== 'built' || typeof value.result !== 'object' || value.result === null) return false;
  const result = value.result;
  if (!('buildId' in result) || typeof result.buildId !== 'string' || !result.buildId.length || result.buildId.length > 128
    || !('durationMs' in result) || typeof result.durationMs !== 'number' || !Number.isFinite(result.durationMs) || result.durationMs < 0
    || !('meshes' in result) || !Array.isArray(result.meshes)
    || !('diagnostics' in result) || !Array.isArray(result.diagnostics) || result.diagnostics.length > 512) return false;
  const bodyIds = new Set<string>(), bodyKeys = new Set<string>();
  for (const mesh of result.meshes) {
    if (!isCadMesh(mesh) || bodyIds.has(mesh.featureId) || mesh.bodyKey !== undefined && bodyKeys.has(mesh.bodyKey)) return false;
    bodyIds.add(mesh.featureId);
    if (mesh.bodyKey !== undefined) bodyKeys.add(mesh.bodyKey);
  }
  // Body states, when given, describe the meshes one for one, and a body with parts keys each of its mesh's solids.
  if ('bodies' in result && result.bodies !== undefined) {
    if (!Array.isArray(result.bodies) || result.bodies.length !== result.meshes.length) return false;
    for (const [index, body] of result.bodies.entries()) {
      const mesh = result.meshes[index] as CadMesh;
      if (!isCadBodyState(body) || body.key !== mesh.bodyKey || cadBodyFeatureId(body) !== mesh.featureId) return false;
      if (body.pieces !== undefined && body.pieces.length !== (mesh.solidCount ?? 1)) return false;
    }
  }
  if ('bodyIssues' in result && result.bodyIssues !== undefined
    && (!Array.isArray(result.bodyIssues) || result.bodyIssues.length > MAX_CAD_BODY_ISSUES || !result.bodyIssues.every(isCadBodyIssue))) return false;
  for (const diagnostic of result.diagnostics) {
    if (typeof diagnostic !== 'object' || diagnostic === null || typeof diagnostic.code !== 'string'
      || diagnostic.code.length > 128 || typeof diagnostic.message !== 'string' || diagnostic.message.length > 8192
      || diagnostic.featureId !== undefined && (typeof diagnostic.featureId !== 'string' || diagnostic.featureId.length > 96)) return false;
  }
  return true;
}

function isNumbers(value: unknown): value is number[] {
  if (!Array.isArray(value)) return false;
  for (const number of value) if (typeof number !== 'number' || !Number.isFinite(number)) return false;
  return true;
}
function isGroups(value: unknown, length: number, stride: number): value is CadMeshTopologyGroup[] {
  if (!Array.isArray(value)) return false;
  let end = 0;
  for (const group of value) {
    if (typeof group !== 'object' || group === null || typeof group.key !== 'string' || !group.key.length || group.key.length > 128 || /\s/.test(group.key)
      || !Number.isSafeInteger(group.start) || group.start !== end || group.start % stride !== 0
      || !Number.isSafeInteger(group.count) || group.count <= 0 || group.count % stride !== 0 || group.start + group.count > length) return false;
    end = group.start + group.count;
  }
  return end === length;
}
function isCadMesh(value: unknown): value is CadMesh {
  if (typeof value !== 'object' || value === null || !('featureId' in value) || typeof value.featureId !== 'string' || value.featureId.length > 96
    || !('name' in value) || typeof value.name !== 'string' || value.name.length > 160
    || !('positions' in value) || !isNumbers(value.positions) || value.positions.length === 0 || value.positions.length % 3 !== 0
    || !('normals' in value) || !isNumbers(value.normals) || value.normals.length !== value.positions.length
    || !('indices' in value) || !isNumbers(value.indices) || value.indices.length === 0 || value.indices.length % 3 !== 0
    || !('edges' in value) || !isNumbers(value.edges) || value.edges.length % 6 !== 0
    || !('faceGroups' in value) || !isGroups(value.faceGroups, value.indices.length, 3)
    || !('edgeGroups' in value) || !isGroups(value.edgeGroups, value.edges.length / 3, 2)
    || !('volume' in value) || typeof value.volume !== 'number' || !Number.isFinite(value.volume) || value.volume <= 0
    || ('bodyKey' in value && value.bodyKey !== undefined && !isCadBodyKey(value.bodyKey))
    || ('solidCount' in value && value.solidCount !== undefined && (typeof value.solidCount !== 'number'
      || !Number.isSafeInteger(value.solidCount) || value.solidCount <= 0))
    || !('bounds' in value) || typeof value.bounds !== 'object' || value.bounds === null
    || !('min' in value.bounds) || !isNumbers(value.bounds.min) || value.bounds.min.length !== 3
    || !('max' in value.bounds) || !isNumbers(value.bounds.max) || value.bounds.max.length !== 3) return false;
  const vertices = value.positions.length / 3;
  if (!value.indices.every(index => Number.isInteger(index) && index >= 0 && index < vertices)) return false;
  if ('faceSolids' in value && value.faceSolids !== undefined) {
    const solids = 'solidCount' in value && typeof value.solidCount === 'number' ? value.solidCount : 0;
    if (!Array.isArray(value.faceSolids) || value.faceSolids.length !== value.faceGroups.length
      || !value.faceSolids.every(solid => Number.isSafeInteger(solid) && solid >= 0 && solid < solids)) return false;
  }
  const min = value.bounds.min; const max = value.bounds.max;
  const faceKeys = new Set(value.faceGroups.map(group => group.key));
  if (value.edgeGroups.some(group => faceKeys.has(group.key))) return false;
  return min.every((coordinate, axis) => coordinate <= max[axis]);
}
