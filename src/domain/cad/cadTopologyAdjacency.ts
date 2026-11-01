import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { CadError } from './cadError';
import { MAX_CAD_TOPOLOGY_PICKS } from './cadTopology';

/**
 * How one built body's edges and faces meet: the faces on either side of each edge and whether they meet without a crease, and each
 * face's boundary loops. Indices refer to `edges` and `faces`; keys are the build's own topology keys. Flat arrays keep a body of
 * thousands of edges small to send and quick to check.
 */
export interface CadTopologyAdjacency {
  readonly bodyId: string;
  readonly buildId: string;
  readonly edges: readonly string[];
  /** Two per edge: the faces either side, `-1` where there is none. A seam names its one face twice. */
  readonly edgeFaces: readonly number[];
  /** Per edge, whether its faces meet without a crease, so the edge is no corner of the solid. */
  readonly edgeSmooth: readonly boolean[];
  readonly faces: readonly string[];
  /** Per face, its boundary loops, each the edges it is made of. */
  readonly faceLoops: readonly (readonly (readonly number[])[])[];
}
export interface CadTopologyAdjacencyRequest { readonly bodyId: string; readonly expectedBuildId: string }

/**
 * The tangent chain of one edge, read from the native fillet builder: the contour it makes from that edge alone, which is what Fillet
 * and Chamfer treat when they follow tangent edges. Keys are the build's own topology keys.
 */
export interface CadTopologyTangentChain {
  readonly bodyId: string;
  readonly buildId: string;
  readonly edgeKey: string;
  /** The contour's edges in order along it, the seed among them; the seed alone when `native` is false. */
  readonly edges: readonly string[];
  readonly closed: boolean;
  /** False where the builders make no contour from the edge: a free or degenerate edge, or one where faces meet without a crease. */
  readonly native: boolean;
}
export interface CadTopologyTangentChainRequest { readonly bodyId: string; readonly expectedBuildId: string; readonly edgeKey: string }

/** Bodies larger than this are refused rather than sent. */
export const MAX_CAD_TOPOLOGY_ADJACENCY_ELEMENTS = 200_000;
const identifier = Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$' });
const opaque = Type.String({ minLength: 1, maxLength: 128, pattern: '\\S' });
const RequestSchema = Type.Object({ bodyId: identifier, expectedBuildId: opaque }, { additionalProperties: false });
const ChainRequestSchema = Type.Object({ bodyId: identifier, expectedBuildId: opaque, edgeKey: opaque }, { additionalProperties: false });

export function parseCadTopologyAdjacencyRequest(value: unknown): CadTopologyAdjacencyRequest {
  if (!Value.Check(RequestSchema, value)) throw new CadError('invalid-topology-request', 'Name the body and the build whose topology adjacency is wanted.');
  return Object.freeze({ bodyId: value.bodyId, expectedBuildId: value.expectedBuildId });
}
export function parseCadTopologyTangentChainRequest(value: unknown): CadTopologyTangentChainRequest {
  if (!Value.Check(ChainRequestSchema, value)) throw new CadError('invalid-topology-request', 'Name the body, the build and the edge whose tangent chain is wanted.');
  return Object.freeze({ bodyId: value.bodyId, expectedBuildId: value.expectedBuildId, edgeKey: value.edgeKey });
}

const plainArray = (value: unknown): value is unknown[] => Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype;
const keyed = (value: unknown, length?: number): value is string[] => plainArray(value) && (length === undefined || value.length === length)
  && value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 128);
const integers = (value: unknown, length: number, low: number, high: number): value is number[] => plainArray(value) && value.length === length
  && value.every(item => Number.isInteger(item) && (item as number) >= low && (item as number) < high);
const plainRecord = (value: unknown, names: readonly string[]): value is Record<string, unknown> => Boolean(value) && typeof value === 'object'
  && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value as object).length === names.length && names.every(name => Object.hasOwn(value as object, name));
const owner = (data: Record<string, unknown>) => typeof data.bodyId === 'string' && Value.Check(identifier, data.bodyId) && typeof data.buildId === 'string' && Value.Check(opaque, data.buildId);

/** Worker data checked field by field: own plain arrays of the stated lengths, indices in range and keys distinct. */
export function isCadTopologyAdjacency(value: unknown): value is CadTopologyAdjacency {
  if (!plainRecord(value, ['bodyId', 'buildId', 'edges', 'edgeFaces', 'edgeSmooth', 'faces', 'faceLoops']) || !owner(value)) return false;
  const data = value;
  if (!keyed(data.edges) || !keyed(data.faces) || data.edges.length + data.faces.length > MAX_CAD_TOPOLOGY_ADJACENCY_ELEMENTS) return false;
  const edgeCount = data.edges.length, faceCount = data.faces.length;
  if (new Set(data.edges).size !== edgeCount || new Set(data.faces).size !== faceCount) return false;
  if (!integers(data.edgeFaces, edgeCount * 2, -1, faceCount)) return false;
  if (!plainArray(data.edgeSmooth) || data.edgeSmooth.length !== edgeCount || data.edgeSmooth.some(item => typeof item !== 'boolean')) return false;
  const loops = data.faceLoops;
  if (!plainArray(loops) || loops.length !== faceCount) return false;
  for (const face of loops) {
    if (!plainArray(face)) return false;
    for (const loop of face) if (!plainArray(loop) || !integers(loop, loop.length, 0, edgeCount)) return false;
  }
  return true;
}

/** Worker data checked field by field: distinct keys holding the seed, and the seed alone, open, where the builders made no contour. */
export function isCadTopologyTangentChain(value: unknown): value is CadTopologyTangentChain {
  if (!plainRecord(value, ['bodyId', 'buildId', 'edgeKey', 'edges', 'closed', 'native']) || !owner(value)) return false;
  const data = value;
  if (typeof data.edgeKey !== 'string' || !Value.Check(opaque, data.edgeKey) || typeof data.closed !== 'boolean' || typeof data.native !== 'boolean') return false;
  if (!keyed(data.edges) || !data.edges.length || data.edges.length > MAX_CAD_TOPOLOGY_ADJACENCY_ELEMENTS || new Set(data.edges).size !== data.edges.length) return false;
  if (!data.edges.includes(data.edgeKey)) return false;
  return data.native || (data.edges.length === 1 && !data.closed);
}

/** What is kept of a tangent chain: its edges, whether they close, and whether the native builder made it. */
export type CadTangentContour = Pick<CadTopologyTangentChain, 'edges' | 'closed' | 'native'>;

/** Equal contours, as sets of edges closed the same way and made the same way, have the same key. */
const contourKey = (contour: CadTangentContour) => `${Number(contour.native)}${Number(contour.closed)}\u0000${[...contour.edges].sort().join('\u0000')}`;

/**
 * The tangent contours kept for one build. Each seed's chain is still read on its own, since another edge of a contour can stop
 * somewhere else; only chains that turn out equal, holding the same edges, closed the same way and made the same way, share one stored
 * contour, the first one read. So a closed rim of n edges read from each of its n seeds keeps one list of n edges, not n lists. A chain
 * longer than one topology selection holds is never kept, since no selection takes it. Each stored contour counts the holders sharing
 * it, and goes when the last one releases it.
 */
export class CadTangentContours {
  private readonly kept = new Map<string, { readonly contour: CadTangentContour; holders: number }>();
  /** How many contours are stored. */
  get size() { return this.kept.size; }
  /**
   * The stored contour equal to `contour`, which is stored if it is the first, held once more for the caller; null when it is too long
   * to keep.
   */
  share(contour: CadTangentContour): CadTangentContour | null {
    if (contour.edges.length > MAX_CAD_TOPOLOGY_PICKS) return null;
    const key = contourKey(contour);
    let entry = this.kept.get(key);
    if (!entry) {
      entry = { contour: Object.freeze({ edges: Object.freeze([...contour.edges]), closed: contour.closed, native: contour.native }), holders: 0 };
      this.kept.set(key, entry);
    }
    entry.holders++;
    return entry.contour;
  }
  /** Gives back one hold on a contour `share` returned; the last hold given back drops it. Any other contour is ignored. */
  release(stored: CadTangentContour) {
    const key = contourKey(stored), entry = this.kept.get(key);
    if (entry?.contour === stored && --entry.holders === 0) this.kept.delete(key);
  }
  clear() { this.kept.clear(); }
}
