// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { CadMesh } from '@/domain/cad/cadDocument';
import { CadTangentChainReads, mergeTopologySelection, orthographicPixelSize, pickTopology, topologyGroupAt, validateTopologySelection } from './cadTopologyPicking';
import { CadTangentContours, type CadTopologyTangentChain } from '@/domain/cad/cadTopologyAdjacency';
import { cadLocalRenderPositions, cadRenderOrigin } from './cadRenderCoordinates';

function scene(edgeHeight = 5, worldOffset = 0, scale = 1) {
  const camera = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 1000);
  camera.position.set(worldOffset, worldOffset, worldOffset + 100); camera.lookAt(worldOffset, worldOffset, worldOffset); camera.updateMatrixWorld();
  const positioned = (values: readonly number[]) => values.map(value => value * scale + worldOffset);
  const mesh: CadMesh = { featureId: 'body', name: 'Body', positions: positioned([-20, -20, 5, 20, -20, 5, 20, 20, 5, -20, 20, 5]),
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2, 0, 2, 3], edges: positioned([0, -10, edgeHeight, 0, 10, edgeHeight]),
    faceGroups: [{ start: 0, count: 6, key: 'face' }], edgeGroups: [{ start: 0, count: 2, key: 'edge' }], volume: 0,
    bounds: { min: [worldOffset - 20 * scale, worldOffset - 20 * scale, worldOffset], max: [worldOffset + 20 * scale, worldOffset + 20 * scale, worldOffset + 5 * scale] } };
  const origin = cadRenderOrigin(mesh.bounds);
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(cadLocalRenderPositions(mesh.positions, origin), 3)); geometry.setIndex([...mesh.indices]);
  const body = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })); body.position.set(...origin); body.updateMatrixWorld();
  const lineGeometry = new THREE.BufferGeometry(); lineGeometry.setAttribute('position', new THREE.BufferAttribute(cadLocalRenderPositions(mesh.edges, origin), 3));
  const lines = new THREE.LineSegments(lineGeometry, new THREE.LineBasicMaterial()); lines.position.set(...origin); lines.updateMatrixWorld();
  const raycaster = new THREE.Raycaster();
  const pick = (mode: 'edge' | 'face', x: number, y = 0) => {
    const projected = new THREE.Vector3(x * scale + worldOffset, y * scale + worldOffset, edgeHeight * scale + worldOffset).project(camera);
    raycaster.setFromCamera(new THREE.Vector2(projected.x, projected.y), camera);
    return pickTopology({ mode, raycaster, bodies: [body], edges: [lines], meshByObject: new Map<THREE.Object3D, CadMesh>([[body, mesh], [lines, mesh]]), camera, viewportHeight: 1000 });
  };
  return { camera, mesh, pick, dispose: () => { geometry.dispose(); lineGeometry.dispose(); body.material.dispose(); lines.material.dispose(); } };
}

describe('CAD topology picking', () => {
  it('shares each edge\'s tangent chain read, stores equal contours once and forgets failed, refused and overlong chains with their contours', async () => {
    const contours = new CadTangentContours(), reads = new CadTangentChainReads(contours);
    const chainOf = (edgeKey: string, edges: readonly string[]): CadTopologyTangentChain => ({ bodyId: 'pad', buildId: 'build-1', edgeKey, edges: [...edges], closed: true, native: true });
    const start = vi.fn((edgeKey: string, edges: readonly string[]) => Promise.resolve(chainOf(edgeKey, edges)));
    const a = await reads.read('a', () => start('a', ['a', 'b', 'c']));
    expect(await reads.read('a', () => start('a', ['a']))).toBe(a); expect(start).toHaveBeenCalledOnce();
    // Another seed of the same contour keeps its own answer, pointing to the edges stored first.
    const b = await reads.read('b', () => start('b', ['b', 'c', 'a']));
    expect(b).toEqual(chainOf('b', ['a', 'b', 'c'])); expect(b.edges).toBe(a.edges); expect(contours.size).toBe(1);
    // A refused chain of its own is forgotten with its contour, however many chains are refused.
    for (const seed of ['d', 'g', 'h']) { const read = reads.read(seed, () => start(seed, [seed, `${seed}-next`])); await read; expect(contours.size).toBe(2); reads.forget(read); }
    expect(contours.size).toBe(1);
    // A contour stays while another kept read holds it. Forgetting a refused read again leaves the newer read and its hold alone.
    const refused = reads.read('a', () => start('a', ['a'])); reads.forget(refused); expect(contours.size).toBe(1);
    const newer = reads.read('a', () => start('a', ['a', 'b', 'c'])); reads.forget(refused);
    expect(reads.read('a', () => start('a', ['a']))).toBe(newer); expect((await newer).edges).toBe(a.edges);
    reads.forget(reads.read('b', () => start('b', ['b']))); expect(contours.size).toBe(1);
    reads.forget(newer); expect(contours.size).toBe(0); expect(start).toHaveBeenCalledTimes(6);
    // A read forgotten before it answers takes no hold.
    const early = reads.read('e', () => start('e', ['e'])); reads.forget(early); await early; expect(contours.size).toBe(0);
    // A failed read and a chain longer than a selection holds reach their caller but are not kept, and store nothing.
    await expect(reads.read('f', () => Promise.reject(new Error('The chain read failed.')))).rejects.toThrow('The chain read failed.');
    expect(contours.size).toBe(0);
    await reads.read('f', () => start('f', ['f'])); expect(start).toHaveBeenCalledTimes(8); expect(contours.size).toBe(1);
    const long = Array.from({ length: 65 }, (_, index) => `l${index}`);
    expect((await reads.read('l0', () => start('l0', long))).edges).toEqual(long);
    await reads.read('l0', () => start('l0', long)); expect(start).toHaveBeenCalledTimes(10); expect(contours.size).toBe(1);
  });
  it('picks far-origin two-millimetre faces and edges while retaining solid occlusion', () => {
    const visible = scene(5, 100000000, .05);
    try {
      expect(visible.pick('face', 5, -5)).toEqual({ bodyId: 'body', pick: { kind: 'face', key: 'face' } });
      expect(visible.pick('edge', 0)).toEqual({ bodyId: 'body', pick: { kind: 'edge', key: 'edge' } });
    } finally { visible.dispose(); }
    const hidden = scene(4.99, 100000000, .05);
    try { expect(hidden.pick('edge', 0)).toBeNull(); }
    finally { hidden.dispose(); }
  });
  it('maps triangle-index and line-vertex group boundaries without mixing XYZ offsets', () => {
    const groups = [{ start: 0, count: 6, key: 'first' }, { start: 6, count: 3, key: 'second' }];
    expect(topologyGroupAt(groups, 5)?.key).toBe('first'); expect(topologyGroupAt(groups, 6)?.key).toBe('second');
    for (const offset of [-1, .5, 9]) expect(topologyGroupAt(groups, offset)).toBeNull();
    const data = scene();
    try { expect(data.pick('face', 5, -5)).toEqual({ bodyId: 'body', pick: { kind: 'face', key: 'face' } }); }
    finally { data.dispose(); }
  });
  it('keeps edge hit tolerance at six screen pixels across orthographic zoom', () => {
    const data = scene();
    try {
      for (const zoom of [.2, 1, 10]) {
        data.camera.zoom = zoom; data.camera.updateProjectionMatrix();
        const size = orthographicPixelSize(data.camera, 1000);
        expect(data.pick('edge', size * 5)).toEqual({ bodyId: 'body', pick: { kind: 'edge', key: 'edge' } });
        expect(data.pick('edge', size * 7)).toBeNull();
      }
    } finally { data.dispose(); }
  });
  it('rejects hidden edges behind a surface, including pointers near the projected edge', () => {
    const data = scene(0);
    try { expect(data.pick('edge', 0)).toBeNull(); expect(data.pick('edge', .4)).toBeNull(); }
    finally { data.dispose(); }
    const shallow = scene(4.99);
    try { expect(shallow.pick('edge', 0)).toBeNull(); }
    finally { shallow.dispose(); }
  });
  it('toggles same-body edges, rejects cross-body addition and enforces the selection limit', () => {
    const first = { documentVersion: 'v1', buildId: 'build1', bodyId: 'body', picks: [{ kind: 'edge', key: 'a' }] } satisfies Parameters<typeof mergeTopologySelection>[1];
    const second = { ...first, picks: [{ kind: 'edge', key: 'b' }] } satisfies typeof first;
    const selected = mergeTopologySelection(first, second, true);
    expect(selected.picks.map((pick) => pick.key)).toEqual(['a', 'b']);
    expect(mergeTopologySelection(selected, first, true).picks.map((pick) => pick.key)).toEqual(['b']);
    expect(() => mergeTopologySelection(first, { ...second, bodyId: 'other' }, true)).toThrow('one body');
    expect(() => mergeTopologySelection(first, { ...second, buildId: 'new' }, true)).toThrow('stale');
    const maximum = { ...first, picks: Array.from({ length: 64 }, (_, index) => ({ kind: 'edge', key: String(index) } satisfies typeof first.picks[number])) };
    expect(() => mergeTopologySelection(maximum, first, true)).toThrow('at most 64');
    expect(Object.isFrozen(selected.picks)).toBe(true);
  });
  it('adds a chain by union, keeps faces of one body together and replaces across kinds', () => {
    type PickSet = Parameters<typeof mergeTopologySelection>[1];
    const edges: PickSet = { documentVersion: 'v1', buildId: 'build1', bodyId: 'body', picks: [{ kind: 'edge', key: 'a' }, { kind: 'edge', key: 'b' }] };
    const chain: PickSet = { ...edges, picks: [{ kind: 'edge', key: 'b' }, { kind: 'edge', key: 'c' }] };
    // A union keeps the edge both share where a toggle would drop it.
    expect(mergeTopologySelection(edges, chain, 'union').picks.map(pick => pick.key)).toEqual(['a', 'b', 'c']);
    expect(mergeTopologySelection(edges, chain, true).picks.map(pick => pick.key)).toEqual(['a', 'c']);
    const faces: PickSet = { ...edges, picks: [{ kind: 'face', key: 'top' }, { kind: 'face', key: 'side' }] };
    expect(mergeTopologySelection(null, faces, false).picks).toHaveLength(2);
    expect(mergeTopologySelection(faces, { ...faces, picks: [{ kind: 'face', key: 'top' }] }, true).picks.map(pick => pick.key)).toEqual(['side']);
    expect(mergeTopologySelection(edges, faces, 'union').picks.map(pick => pick.kind)).toEqual(['face', 'face']);
    expect(() => mergeTopologySelection(null, { ...faces, picks: [...faces.picks, { kind: 'edge', key: 'a' }] }, false)).toThrow('either edges or faces');
    expect(() => mergeTopologySelection(null, { ...edges, picks: [] }, false)).toThrow('at least one');
  });
  it('rejects a key from another build or body even when the document version is unchanged', () => {
    const data = scene();
    try {
      const picked = { documentVersion: 'v1', buildId: 'build1', bodyId: 'body', picks: [{ kind: 'edge', key: 'edge' }] } satisfies Parameters<typeof validateTopologySelection>[0];
      const source = { documentVersion: 'v1', buildId: 'build1', meshes: [data.mesh], ready: true };
      expect(() => validateTopologySelection(picked, source)).not.toThrow();
      expect(() => validateTopologySelection(picked, { ...source, buildId: 'rebuilt' })).toThrow('solid build changed');
      expect(() => validateTopologySelection({ ...picked, picks: [{ kind: 'edge', key: 'elsewhere' }] }, source)).toThrow('does not belong');
      expect(() => validateTopologySelection(picked, { ...source, ready: false })).toThrow('solid build changed');
    } finally { data.dispose(); }
  });
});
