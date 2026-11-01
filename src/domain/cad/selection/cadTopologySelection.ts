import type { CadTopologyAdjacency, CadTopologyTangentChain } from '../cadTopologyAdjacency';

interface Index {
  readonly edgeIndex: ReadonlyMap<string, number>;
  readonly faceIndex: ReadonlyMap<string, number>;
  /** Per face, the edges on its boundary. */
  readonly faceEdges: readonly (readonly number[])[];
}
const indexes = new WeakMap<CadTopologyAdjacency, Index>();

/** The lookups of one body's adjacency, built on first use and kept with it. */
function indexOf(adjacency: CadTopologyAdjacency): Index {
  const kept = indexes.get(adjacency);
  if (kept) return kept;
  const index: Index = { edgeIndex: new Map(adjacency.edges.map((key, at) => [key, at])), faceIndex: new Map(adjacency.faces.map((key, at) => [key, at])),
    faceEdges: adjacency.faceLoops.map(loops => [...new Set(loops.flat())]) };
  indexes.set(adjacency, index);
  return index;
}

/** The faces either side of an edge, without repeats. */
export function cadTopologyEdgeFaces(adjacency: CadTopologyAdjacency, edgeKey: string): string[] {
  const edge = indexOf(adjacency).edgeIndex.get(edgeKey);
  if (edge === undefined) return [];
  return [...new Set([adjacency.edgeFaces[edge * 2], adjacency.edgeFaces[edge * 2 + 1]].filter(face => face >= 0))].map(face => adjacency.faces[face]);
}

/** The boundary loop of `faceKey` that holds the edge, or `null` when the edge does not bound that face. */
export function cadTopologyFaceLoop(adjacency: CadTopologyAdjacency, faceKey: string, edgeKey: string): string[] | null {
  const { faceIndex, edgeIndex } = indexOf(adjacency), face = faceIndex.get(faceKey), edge = edgeIndex.get(edgeKey);
  if (face === undefined || edge === undefined) return null;
  const loop = adjacency.faceLoops[face].find(members => members.includes(edge));
  return loop ? [...new Set(loop)].map(member => adjacency.edges[member]) : null;
}

/** The faces reached from `faceKey` across edges where faces meet without a crease, the seed first. */
export function cadTopologyTangentFaces(adjacency: CadTopologyAdjacency, faceKey: string): string[] {
  const { faceIndex, faceEdges } = indexOf(adjacency), seed = faceIndex.get(faceKey);
  if (seed === undefined) return [];
  const reached = [seed], seen = new Set(reached);
  for (let cursor = 0; cursor < reached.length; cursor++) {
    for (const edge of faceEdges[reached[cursor]]) {
      if (!adjacency.edgeSmooth[edge]) continue;
      for (const face of [adjacency.edgeFaces[edge * 2], adjacency.edgeFaces[edge * 2 + 1]]) {
        if (face >= 0 && !seen.has(face)) { seen.add(face); reached.push(face); }
      }
    }
  }
  return reached.map(face => adjacency.faces[face]);
}

/** What a chain gesture on a solid asks for: the boundary loop through an edge, or the tangent run of an edge or a face. */
export type CadTopologyChainGesture = 'loop' | 'tangent';
type Seed = { readonly kind: 'edge' | 'face'; readonly key: string };
export interface CadTopologyChainPicks {
  readonly kind: 'edge' | 'face';
  readonly keys: readonly string[];
  readonly name: 'Loop' | 'Tangent chain' | 'Tangent faces';
  readonly closed: boolean;
  /** What to tell the user with the picks, when they are not what the gesture usually selects. */
  readonly note: string | null;
}
/** Said when the native builders make no tangent chain from an edge, so the chain is the edge alone. */
export const CAD_TOPOLOGY_LONE_EDGE_NOTE = 'Fillet and Chamfer make no tangent chain from this edge, so only the edge is selected.';

/**
 * The picks a loop gesture, or any gesture on a face, selects from one body's adjacency. A loop is the boundary loop holding the edge on
 * `faceKey`, the face under the pointer, or on the edge's first face when the edge does not bound that one. A face always takes its tangent
 * faces. Unknown seeds give `null`.
 */
export function cadTopologyAdjacencyChainPicks(adjacency: CadTopologyAdjacency, seed: Seed, faceKey: string | null = null): CadTopologyChainPicks | null {
  if (seed.kind === 'face') {
    const keys = cadTopologyTangentFaces(adjacency, seed.key);
    return keys.length ? { kind: 'face', keys, name: 'Tangent faces', closed: false, note: null } : null;
  }
  if (!indexOf(adjacency).edgeIndex.has(seed.key)) return null;
  const faces = cadTopologyEdgeFaces(adjacency, seed.key), face = faceKey && faces.includes(faceKey) ? faceKey : faces[0];
  const keys = face ? cadTopologyFaceLoop(adjacency, face, seed.key) : null;
  return keys ? { kind: 'edge', keys, name: 'Loop', closed: true, note: null } : { kind: 'edge', keys: [seed.key], name: 'Loop', closed: false, note: null };
}

/** The picks of an edge's native tangent chain; where the builders make none, the edge alone, with a note saying so. */
export function cadTopologyTangentChainPicks(chain: CadTopologyTangentChain): CadTopologyChainPicks {
  return { kind: 'edge', keys: chain.edges, name: 'Tangent chain', closed: chain.closed, note: chain.native ? null : CAD_TOPOLOGY_LONE_EDGE_NOTE };
}

/** How a chain gesture reads the body it runs on. Callers keep each answer for the build it belongs to. */
export interface CadTopologyChainReaders {
  adjacency(): Promise<CadTopologyAdjacency>;
  tangentChain(edgeKey: string): Promise<CadTopologyTangentChain>;
}
/**
 * The picks a chain gesture selects from one seed. An edge's tangent chain is the contour native fillet makes from it, the edges Fillet
 * and Chamfer treat when they follow tangents, so the two never differ. Loops and tangent faces come from the body's adjacency.
 */
export async function cadTopologyChainPicks(readers: CadTopologyChainReaders, seed: Seed, gesture: CadTopologyChainGesture, faceKey: string | null = null): Promise<CadTopologyChainPicks | null> {
  if (seed.kind === 'edge' && gesture === 'tangent') return cadTopologyTangentChainPicks(await readers.tangentChain(seed.key));
  return cadTopologyAdjacencyChainPicks(await readers.adjacency(), seed, faceKey);
}
