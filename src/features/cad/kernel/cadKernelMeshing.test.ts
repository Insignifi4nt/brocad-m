// @vitest-environment node
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import initOpenCascade from 'replicad-opencascadejs';
import { getOC, isShape3D, makeBox, makeCylinder, makeCompound, measureVolume, setOC, type Shape3D } from 'replicad';
import { meshCadKernelPreview } from './cadKernelMeshing';
import { CadKernelTopology } from './cadKernelTopology';

beforeAll(async () => {
  const wasmBinary = await readFile(new URL('../../../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  setOC(await initOpenCascade({ wasmBinary, print: () => undefined, printErr: () => undefined }));
}, 60_000);
afterEach(() => vi.restoreAllMocks());
const options = { tolerance: .05, angularTolerance: .15 };
function preview(shape: Shape3D) {
  const box = shape.boundingBox;
  try { const [min, max] = box.bounds; return meshCadKernelPreview(shape, { min, max }, options); }
  finally { box.delete(); }
}

describe('native preview extraction precision', () => {
  it.each([[100000000, 100000000, 100000000], [-100000000, 100000000, -100000000]] as const)('keeps a native 2 mm cube distinct at %s,%s,%s and maps every group to original exact topology', (x, y, z) => {
    const shape = makeBox([x, y, z], [x + 2, y + 2, z + 2]); const topology = new CadKernelTopology(shape);
    try {
      // Reproduce the pinned extractor's premature world-coordinate Float32 loss.
      const old = shape.mesh(options); expect(new Set(old.vertices.map((_, index) => index % 3 === 0 ? old.vertices.slice(index, index + 3).join(',') : null).filter(Boolean)).size).toBeLessThan(8);
      const originalBox = shape.boundingBox; let before: string;
      try { before = JSON.stringify(originalBox.bounds); } finally { originalBox.delete(); }
      const result = preview(shape); const { faceGroups, edgeGroups } = topology.meshGroups(result.mesh, result.edgeMesh);
      const vertices = Array.from({ length: result.mesh.vertices.length / 3 }, (_, index) => result.mesh.vertices.slice(index * 3, index * 3 + 3));
      expect(new Set(vertices.map(point => point.join(','))).size).toBe(8); expect(result.mesh.triangles).toHaveLength(36);
      expect(result.mesh.normals).toHaveLength(result.mesh.vertices.length); expect(result.mesh.normals.every(value => Number.isFinite(value) && Math.abs(value) <= 1)).toBe(true);
      const faces = topology.inspect({ bodyId: 'body', expectedBuildId: 'build', selection: { kind: 'page', topology: 'face', offset: 0, limit: 100 } }, 'build').descriptors;
      const edges = topology.inspect({ bodyId: 'body', expectedBuildId: 'build', selection: { kind: 'page', topology: 'edge', offset: 0, limit: 100 } }, 'build').descriptors;
      expect(faceGroups).toHaveLength(6); expect(edgeGroups).toHaveLength(12);
      for (const group of faceGroups) {
        const face = faces.find(face => face.key === group.key); if (face?.kind !== 'face' || face.surfaceType !== 'plane') throw new Error('Original planar face missing');
        for (let index = group.start; index < group.start + group.count; index++) {
          const point = vertices[result.mesh.triangles[index]]; const dot = point.reduce((sum, value, axis) => sum + value * face.normal[axis], 0);
          expect(dot).toBeCloseTo(face.offset, 5);
          const normal = result.mesh.normals.slice(result.mesh.triangles[index] * 3, result.mesh.triangles[index] * 3 + 3);
          expect(normal.reduce((sum, value, axis) => sum + value * face.normal[axis], 0)).toBeCloseTo(1, 6);
        }
      }
      for (const group of edgeGroups) {
        const edge = edges.find(edge => edge.key === group.key); if (edge?.kind !== 'edge' || edge.curveType !== 'line') throw new Error('Original linear edge missing');
        const start = result.edgeMesh.lines.slice(group.start * 3, group.start * 3 + 3); const end = result.edgeMesh.lines.slice((group.start + group.count - 1) * 3, (group.start + group.count) * 3);
        expect([start, end]).toContainEqual([...edge.start]); expect([start, end]).toContainEqual([...edge.end]);
      }
      expect(measureVolume(shape)).toBeCloseTo(8, 6); const after = shape.boundingBox;
      try { expect(JSON.stringify(after.bounds)).toBe(before); } finally { after.delete(); }
    } finally { topology.dispose(); shape.delete(); }
  });

  it('retains curved face/edge identity for a moved cylinder and disconnected compound', () => {
    const first = makeCylinder(2, 3, [100000000, -100000000, 100000000]);
    const second = makeBox([100000010, -100000000, 100000000], [100000012, -99999998, 100000002]);
    const shape = makeCompound([first, second]);
    if (!isShape3D(shape)) { shape.delete(); first.delete(); second.delete(); throw new Error('Compound fixture must be a 3D body.'); }
    const topology = new CadKernelTopology(shape);
    try {
      const result = preview(shape); const groups = topology.meshGroups(result.mesh, result.edgeMesh);
      expect(groups.faceGroups).toHaveLength(9); expect(new Set(groups.edgeGroups.map(group => group.key)).size).toBe(15);
      expect(result.mesh.vertices.every(value => Number.isFinite(value))).toBe(true); expect(measureVolume(shape)).toBeCloseTo(12 * Math.PI + 8, 6);
    } finally { topology.dispose(); shape.delete(); first.delete(); second.delete(); }
  });

  it.each([-3, 3.5, 4, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid native triangle count %s, releases handles and preserves the exact source for retry', countValue => {
    const oc = getOC(); const shape = makeBox([100000000, 0, 0], [100000002, 2, 2]); const topology = new CadKernelTopology(shape);
    const rawDisposed = vi.spyOn(oc.ReplicadMeshData.prototype, 'delete'); const transformDisposed = vi.spyOn(oc.BRepBuilderAPI_Transform.prototype, 'delete');
    const count = vi.spyOn(oc.ReplicadMeshData.prototype, 'getTrianglesSize').mockReturnValueOnce(countValue);
    try {
      // The message names the cause; the check that failed is kept as the kernel's own account.
      expect(() => preview(shape)).toThrow(expect.objectContaining({ code: 'invalid-mesh', message: 'The body could not be drawn: its display mesh came back incomplete. Rebuild the part.',
        kernelMessage: 'The kernel returned an invalid preview buffer size.' })); expect(rawDisposed).toHaveBeenCalledTimes(1); expect(transformDisposed).toHaveBeenCalledTimes(1); count.mockRestore();
      const result = preview(shape); expect(topology.meshGroups(result.mesh, result.edgeMesh).faceGroups).toHaveLength(6); expect(measureVolume(shape)).toBeCloseTo(8, 6);
    } finally { topology.dispose(); shape.delete(); }
  });
  it.each(['unaligned', 'fractional', 'invalid-signed', 'invalid-unsigned', 'past-heap'] as const)('rejects a %s native preview pointer without reading outside physical memory and permits retry', kind => {
    const oc = getOC(), shape = makeBox([100000000, 0, 0], [100000002, 2, 2]), topology = new CadKernelTopology(shape);
    const rawDisposed = vi.spyOn(oc.ReplicadMeshData.prototype, 'delete'), transformDisposed = vi.spyOn(oc.BRepBuilderAPI_Transform.prototype, 'delete');
    const value = kind === 'unaligned' ? 1 : kind === 'fractional' ? .5 : kind === 'invalid-signed' ? -0x80000001
      : kind === 'invalid-unsigned' ? 0x100000000 : oc.wasmMemory.buffer.byteLength;
    const pointer = vi.spyOn(oc.ReplicadMeshData.prototype, 'getVerticesPtr').mockReturnValueOnce(value);
    try {
      const account = kind === 'unaligned' || kind === 'past-heap' ? 'The kernel returned an invalid preview buffer.' : 'The kernel returned an invalid preview buffer pointer.';
      expect(() => preview(shape)).toThrow(expect.objectContaining({ code: 'invalid-mesh', kernelMessage: account }));
      expect(rawDisposed).toHaveBeenCalledTimes(1); expect(transformDisposed).toHaveBeenCalledTimes(1); pointer.mockRestore();
      const result = preview(shape);
      expect(topology.meshGroups(result.mesh, result.edgeMesh).faceGroups).toHaveLength(6);
      expect(measureVolume(shape)).toBeCloseTo(8, 6);
    } finally { topology.dispose(); shape.delete(); }
  });
});
