import * as THREE from 'three';
import { cadClipRaycaster, cadKeptLineHits } from './view/cadSectionView';
import type { CadMesh, CadMeshTopologyGroup } from '@/domain/cad/cadDocument';
import type { CadTopologyPick, CadTopologyPickSet } from '@/domain/cad/cadTopology';
import { CadTangentContours, type CadTangentContour, type CadTopologyTangentChain } from '@/domain/cad/cadTopologyAdjacency';

/** `auto` picks an edge near the pointer, else the face under it; the others restrict picking to one kind. */
export type CadPickMode = 'auto' | 'body' | 'face' | 'edge';
export interface CadTopologyHit { readonly bodyId: string; readonly pick: CadTopologyPick }

/** Face offsets are triangle indices; edge offsets are line vertices, not XYZ scalars. */
export function topologyGroupAt(groups: readonly CadMeshTopologyGroup[], offset: number): CadMeshTopologyGroup | null {
  if (!Number.isInteger(offset) || offset < 0) return null;
  let low = 0, high = groups.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const group = groups[middle];
    if (offset < group.start) high = middle - 1;
    else if (offset >= group.start + group.count) low = middle + 1;
    else return group;
  }
  return null;
}

export function orthographicPixelSize(camera: THREE.OrthographicCamera, viewportHeight: number): number {
  return (camera.top - camera.bottom) / (camera.zoom * Math.max(1, viewportHeight));
}

/** The most edges or faces one topology selection holds. */
export const CAD_TOPOLOGY_SELECTION_LIMIT = 64;

/**
 * One read per key, shared by every later caller until the map is dropped. A failed read is forgotten, so the next caller asks again;
 * the rejection still reaches whoever awaits it.
 */
export function sharedCadTopologyRead<T>(reads: Map<string, Promise<T>>, key: string, start: () => Promise<T>): Promise<T> {
  const kept = reads.get(key);
  if (kept) return kept;
  const started = start();
  reads.set(key, started);
  started.catch(() => { if (reads.get(key) === started) reads.delete(key); });
  return started;
}

/**
 * One build's tangent chain reads, by seed edge, each shared by every later caller. Equal chains keep one stored contour, held by each
 * kept read that answered with it, and a chain longer than a selection holds is not kept. A read that fails, or whose chain a selection
 * refused, is forgotten, so the next caller reads again, and gives back its hold, so a contour no kept read holds goes too.
 */
export class CadTangentChainReads {
  private readonly reads = new Map<string, Promise<CadTopologyTangentChain>>();
  private readonly keys = new WeakMap<Promise<CadTopologyTangentChain>, string>();
  private readonly holds = new WeakMap<Promise<CadTopologyTangentChain>, CadTangentContour>();
  /** `contours` is where equal chains are stored; a caller passes its own only to look at what is kept. */
  constructor(private readonly contours = new CadTangentContours()) {}
  read(key: string, start: () => Promise<CadTopologyTangentChain>): Promise<CadTopologyTangentChain> {
    const kept = this.reads.get(key);
    if (kept) return kept;
    const started: Promise<CadTopologyTangentChain> = start().then(chain => {
      // A read forgotten before it answers takes no hold, as nothing would give it back.
      if (this.reads.get(key) !== started) return chain;
      const stored = this.contours.share(chain);
      if (!stored) { this.forget(started); return chain; }
      this.holds.set(started, stored);
      return { ...chain, edges: stored.edges };
    });
    this.reads.set(key, started); this.keys.set(started, key);
    started.catch(() => this.forget(started));
    return started;
  }
  /** Forgets a read while it is still the one kept for its edge, giving back its hold on a stored contour. */
  forget(read: Promise<CadTopologyTangentChain>) {
    const key = this.keys.get(read);
    if (key === undefined || this.reads.get(key) !== read) return;
    this.reads.delete(key);
    // The read is no longer kept, so it gives back its hold only once.
    const stored = this.holds.get(read);
    if (stored) this.contours.release(stored);
  }
}

/**
 * The exact same bounded transition serves pointer picks and declarative viewport commands. A selection holds edges or faces of one body.
 * Additive toggles each incoming pick, as Ctrl + click does; `union` adds the picks a chain or box selects without removing any.
 */
export function mergeTopologySelection(current: CadTopologyPickSet | null, incoming: CadTopologyPickSet, additive: boolean | 'union'): CadTopologyPickSet {
  if (incoming.picks.length === 0) throw new Error('Select at least one edge or face.');
  if (incoming.picks.length > CAD_TOPOLOGY_SELECTION_LIMIT) throw new Error(`This selection has ${incoming.picks.length} elements. A topology selection holds at most ${CAD_TOPOLOGY_SELECTION_LIMIT}.`);
  const kind = incoming.picks[0].kind;
  if (incoming.picks.some((pick) => pick.kind !== kind)) throw new Error('Select either edges or faces.');
  let picks = [...new Map(incoming.picks.map((pick) => [pick.key, pick])).values()];
  if (additive && current?.picks.some((pick) => pick.kind === kind)) {
    const noun = kind === 'edge' ? 'edges' : 'faces';
    if (current.documentVersion !== incoming.documentVersion || current.buildId !== incoming.buildId) throw new Error(`The selected topology is stale. Select ${noun} from the current build.`);
    if (current.bodyId !== incoming.bodyId) throw new Error(`Select ${noun} from one body for this operation.`);
    const merged = new Map(current.picks.map((pick) => [pick.key, pick]));
    for (const pick of picks) { if (additive !== 'union' && merged.has(pick.key)) merged.delete(pick.key); else merged.set(pick.key, pick); }
    picks = [...merged.values()];
  }
  if (picks.length > CAD_TOPOLOGY_SELECTION_LIMIT) throw new Error(`A topology selection holds at most ${CAD_TOPOLOGY_SELECTION_LIMIT} edges or faces.`);
  return Object.freeze({ ...incoming, picks: Object.freeze(picks.map((pick) => Object.freeze({ ...pick }))) });
}

export function validateTopologySelection(selection: CadTopologyPickSet, source: {
  documentVersion: string; buildId: string | null; meshes: readonly CadMesh[]; ready: boolean;
}): void {
  if (!source.ready || source.buildId !== selection.buildId || source.documentVersion !== selection.documentVersion) throw new Error('The solid build changed. Select topology from the current CAD draft.');
  const mesh = source.meshes.find((entry) => entry.featureId === selection.bodyId);
  if (!mesh) throw new Error('Select topology on a current visible body.');
  for (const pick of selection.picks) {
    const groups = pick.kind === 'edge' ? mesh.edgeGroups : mesh.faceGroups;
    if (!groups.some((group) => group.key === pick.key)) throw new Error('This topology key does not belong to the current body build.');
  }
}

/**
 * With a section's `clip`, `raycaster` is already limited to the kept side for faces, and the depth checks behind each edge are limited
 * the same way. Edges are measured to the part of them the section keeps, so an edge it removes is never picked from beside the cut.
 */
export function pickTopology({ mode, raycaster, bodies, edges, meshByObject, camera, viewportHeight, clip = null }: {
  mode: 'auto' | 'edge' | 'face'; raycaster: THREE.Raycaster; bodies: readonly THREE.Mesh[];
  edges: readonly THREE.LineSegments[]; meshByObject: ReadonlyMap<THREE.Object3D, CadMesh>;
  camera: THREE.OrthographicCamera; viewportHeight: number; clip?: THREE.Plane | null;
}): CadTopologyHit | null {
  if (mode === 'auto') {
    const options = { raycaster, bodies, edges, meshByObject, camera, viewportHeight, clip };
    return pickTopology({ ...options, mode: 'edge' }) ?? pickTopology({ ...options, mode: 'face' });
  }
  if (mode === 'face') {
    const hit = raycaster.intersectObjects([...bodies], false)[0];
    const mesh = hit && meshByObject.get(hit.object);
    const group = mesh && typeof hit.faceIndex === 'number' ? topologyGroupAt(mesh.faceGroups, hit.faceIndex * 3) : null;
    return mesh && group ? { bodyId: mesh.featureId, pick: { kind: 'face', key: group.key } } : null;
  }
  for (const hit of visibleEdgeHits({ raycaster, bodies, edges, meshByObject, camera, viewportHeight, clip })) return hit;
  return null;
}

type PickInput = { raycaster: THREE.Raycaster; bodies: readonly THREE.Mesh[]; edges: readonly THREE.LineSegments[]; meshByObject: ReadonlyMap<THREE.Object3D, CadMesh>;
  camera: THREE.OrthographicCamera; viewportHeight: number; clip?: THREE.Plane | null };

/**
 * Everything Select other steps through under the pointer, each once, in a stable order: the visible edges within reach, nearest the pointer
 * first, as a click prefers them, then every face the ray passes through, nearest first, faces behind the front one included.
 */
export function topologyCandidates({ mode, ...input }: PickInput & { mode: 'auto' | 'edge' | 'face' }): CadTopologyHit[] {
  const found: CadTopologyHit[] = [], seen = new Set<string>();
  const add = (hit: CadTopologyHit) => { const key = `${hit.bodyId}\u0000${hit.pick.kind}\u0000${hit.pick.key}`; if (!seen.has(key)) { seen.add(key); found.push(hit); } };
  if (mode !== 'face') for (const hit of visibleEdgeHits(input)) add(hit);
  if (mode !== 'edge') for (const hit of input.raycaster.intersectObjects([...input.bodies], false)) {
    const mesh = input.meshByObject.get(hit.object);
    const group = mesh && typeof hit.faceIndex === 'number' ? topologyGroupAt(mesh.faceGroups, hit.faceIndex * 3) : null;
    if (mesh && group) add({ bodyId: mesh.featureId, pick: { kind: 'face', key: group.key } });
  }
  return found;
}

/** The edges within six pixels of the pointer that no kept face hides, nearest the pointer first. */
function* visibleEdgeHits({ raycaster, bodies, edges, meshByObject, camera, viewportHeight, clip = null }: PickInput): Generator<CadTopologyHit> {
  const pixelSize = orthographicPixelSize(camera, viewportHeight);
  const depthRay = new THREE.Raycaster();
  const candidates = cadKeptLineHits(raycaster, edges, clip, pixelSize * 6).sort((left, right) =>
    raycaster.ray.distanceSqToPoint(left.point) - raycaster.ray.distanceSqToPoint(right.point) || left.distance - right.distance);
  for (const hit of candidates) {
    if (raycaster.ray.distanceSqToPoint(hit.point) > (pixelSize * 6) ** 2) continue;
    const mesh = meshByObject.get(hit.object);
    const group = mesh && typeof hit.index === 'number' ? topologyGroupAt(mesh.edgeGroups, hit.index) : null;
    if (!mesh || !group) continue;
    // Cast through the actual closest edge point. The pointer may be several pixels
    // away, especially at silhouettes, and must not reveal an edge behind a face.
    const projected = hit.point.clone().project(camera);
    depthRay.setFromCamera(new THREE.Vector2(projected.x, projected.y), camera); cadClipRaycaster(depthRay, clip);
    const surface = depthRay.intersectObjects([...bodies], false)[0];
    const extent = Math.max(...mesh.bounds.max.map((value, index) => value - mesh.bounds.min[index]));
    const tolerance = Math.max(1e-7, extent * 2e-7); // Only floating-point preview precision, not a whole mesh tolerance.
    if (surface && surface.distance + tolerance < depthRay.ray.origin.distanceTo(hit.point)) continue;
    yield { bodyId: mesh.featureId, pick: { kind: 'edge', key: group.key } };
  }
}
