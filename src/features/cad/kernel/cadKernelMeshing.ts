import { getOC, type Shape3D, type ShapeEdgeMesh, type ShapeMesh } from 'replicad';
import type { BRepBuilderAPI_Transform, TopoDS_Shape } from 'replicad-opencascadejs';
import type { CadMesh } from '../../../domain/cad/cadDocument';
import { CadError } from '../../../domain/cad/cadError';
import { cadKernelDisposeShape, cadKernelSolids } from './cadKernelShapes';

interface MeshOptions { readonly tolerance: number; readonly angularTolerance: number }
type TopologyKind = 'face' | 'edge';

function checkedCount(count: number, multiple: number): number {
  if (!Number.isSafeInteger(count) || count < 0 || count % multiple) throw CadError.received('invalid-mesh', 'The body could not be drawn: its display mesh came back incomplete. Rebuild the part.', { kernelMessage: 'The kernel returned an invalid preview buffer size.' });
  return count;
}

/** Native pointers are read only after checking sizes, against the current heap. */
function readNumbers(pointer: number, count: number, format: 'float' | 'unsigned' | 'signed'): number[] {
  const buffer = getOC().wasmMemory.buffer;
  if (!Number.isSafeInteger(pointer) || pointer < -0x80000000 || pointer > 0xffffffff) throw CadError.received('invalid-mesh', 'The body could not be drawn: its display mesh came back incomplete. Rebuild the part.', { kernelMessage: 'The kernel returned an invalid preview buffer pointer.' });
  const start = (pointer >>> 0) / 4;
  if (!Number.isInteger(start) || start + count > buffer.byteLength / 4) throw CadError.received('invalid-mesh', 'The body could not be drawn: its display mesh came back incomplete. Rebuild the part.', { kernelMessage: 'The kernel returned an invalid preview buffer.' });
  const heap = format === 'float' ? new Float32Array(buffer) : format === 'unsigned' ? new Uint32Array(buffer) : new Int32Array(buffer);
  return Array.from(heap.subarray(start, start + count));
}

/** ModifiedShape establishes exact provenance. Indexed maps use IsSame identity,
 * including locations, and resolve hash collisions in their native buckets. */
function transformedIndices(shape: TopoDS_Shape, localized: TopoDS_Shape, transform: BRepBuilderAPI_Transform): ReadonlyMap<string, number> {
  const oc = getOC(); const indices = new Map<string, number>();
  for (const kind of ['face', 'edge'] as const) {
    const nativeKind = kind === 'face' ? oc.TopAbs_ShapeEnum.TopAbs_FACE : oc.TopAbs_ShapeEnum.TopAbs_EDGE;
    const sourceMap = new oc.NCollection_IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher();
    try {
      const localizedMap = new oc.NCollection_IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher();
      try {
        const explorer = new oc.TopExp_Explorer(localized, nativeKind, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
        try {
          // The additive native extractors construct this same exact map, including
          // unmeshed elements. A group ID is a map index, never an explorer position.
          while (explorer.More()) {
            const element = explorer.Current();
            try { localizedMap.Add(element); }
            finally { element.Nullify(); element.delete(); }
            explorer.Next();
          }
          explorer.Init(shape, nativeKind, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
          while (explorer.More()) {
            const original = explorer.Current();
            try {
              const modified = transform.ModifiedShape(original);
              try {
                const localizedIndex = modified.IsNull() ? 0 : localizedMap.FindIndex(modified);
                if (!localizedIndex) throw CadError.received('topology-mapping', 'The body could not be drawn: its display faces and edges differ from the exact body. Rebuild the part; if this repeats, revise the dimensions of this feature slightly.', { kernelMessage: 'Preview translation could not identify an exact source element.' });
                const sourceIndex = sourceMap.Add(original), key = `${kind}:${localizedIndex}`;
                const previous = indices.get(key);
                if (previous !== undefined && previous !== sourceIndex) throw CadError.received('topology-mapping', 'The body could not be drawn: its display faces and edges differ from the exact body. Rebuild the part; if this repeats, revise the dimensions of this feature slightly.', { kernelMessage: 'Preview translation does not preserve exact topology identity.' });
                indices.set(key, sourceIndex);
              } finally { modified.Nullify(); modified.delete(); }
            } finally { original.Nullify(); original.delete(); }
            explorer.Next();
          }
          if (sourceMap.Extent() !== localizedMap.Extent()) throw CadError.received('topology-mapping', 'The body could not be drawn: its display faces and edges differ from the exact body. Rebuild the part; if this repeats, revise the dimensions of this feature slightly.', { kernelMessage: 'Preview translation changed the exact topology inventory.' });
        } finally { explorer.delete(); }
      } finally { localizedMap.delete(); }
    } finally { sourceMap.delete(); }
  }
  return indices;
}

function sourceIndex(indices: ReadonlyMap<string, number>, kind: TopologyKind, index: number): number {
  const original = indices.get(`${kind}:${index}`);
  if (original === undefined) throw new CadError('topology-mapping', 'A preview element does not match the original exact body.');
  return original;
}
function restoreWorld(values: number[], origin: readonly number[]) {
  for (let index = 0; index < values.length; index++) values[index] += origin[index % 3];
  return values;
}

/** Replicad 1.1 extracts Float32 world vertices. Translate the native preview first,
 * then restore world coordinates as JS doubles and remap exact topology indices.
 * The original BRep/location, exact operations, descriptors and exports stay intact. */
export function meshCadKernelPreview(shape: Shape3D, bounds: CadMesh['bounds'], options: MeshOptions): { mesh: ShapeMesh; edgeMesh: ShapeEdgeMesh } {
  const oc = getOC();
  const origin = bounds.min.map((minimum, axis) => minimum / 2 + bounds.max[axis] / 2);
  const translation = new oc.gp_Trsf();
  try {
    const vector = new oc.gp_Vec(-origin[0], -origin[1], -origin[2]);
    try {
      translation.SetTranslation(vector);
      const transform = new oc.BRepBuilderAPI_Transform(shape.wrapped, translation, false, false);
      try {
        const localized = transform.Shape();
        try {
          const indices = transformedIndices(shape.wrapped, localized, transform);
          const raw = oc.ReplicadMeshExtractor.extractWithTopologyIndices(localized, options.tolerance, options.angularTolerance, false);
          let mesh: ShapeMesh;
          try {
            const vertices = checkedCount(raw.getVerticesSize(), 3);
            const normals = checkedCount(raw.getNormalsSize(), 3);
            const triangles = checkedCount(raw.getTrianglesSize(), 3);
            if (vertices !== normals) throw CadError.received('invalid-mesh', 'The body could not be drawn: its display mesh came back incomplete. Rebuild the part.', { kernelMessage: 'The kernel returned mismatched preview vertices and normals.' });
            const groups = readNumbers(raw.getFaceGroupsPtr(), checkedCount(raw.getFaceGroupsSize(), 3), 'signed');
            const faceGroups: ShapeMesh['faceGroups'] = [];
            for (let index = 0; index < groups.length; index += 3) faceGroups.push({ start: groups[index], count: groups[index + 1], faceId: sourceIndex(indices, 'face', groups[index + 2]) });
            mesh = { vertices: restoreWorld(readNumbers(raw.getVerticesPtr(), vertices, 'float'), origin), normals: readNumbers(raw.getNormalsPtr(), normals, 'float'),
              triangles: readNumbers(raw.getTrianglesPtr(), triangles, 'unsigned'), faceGroups };
          } finally { raw.delete(); }
          const rawEdges = oc.ReplicadEdgeMeshExtractor.extractWithTopologyIndices(localized, options.tolerance, options.angularTolerance);
          try {
            const lineCount = checkedCount(rawEdges.getLinesSize(), 6);
            const groups = readNumbers(rawEdges.getEdgeGroupsPtr(), checkedCount(rawEdges.getEdgeGroupsSize(), 3), 'signed');
            const edgeGroups: ShapeEdgeMesh['edgeGroups'] = [];
            for (let index = 0; index < groups.length; index += 3) edgeGroups.push({ start: groups[index], count: groups[index + 1], edgeId: sourceIndex(indices, 'edge', groups[index + 2]) });
            return { mesh, edgeMesh: { lines: restoreWorld(readNumbers(rawEdges.getLinesPtr(), lineCount, 'float'), origin), edgeGroups } };
          } finally { rawEdges.delete(); }
        } finally { localized.Nullify(); localized.delete(); }
      } finally { transform.delete(); }
    } finally { vector.delete(); }
  } finally { translation.delete(); }
}

/**
 * The native solid each face of `faceIds` bounds, numbered as `cadKernelSolids` lists the solids of `shape`, or `undefined` when a face
 * bounds no solid or more than one, so that faces do not tell the solids apart. A face id is the face's index in the map of `shape`'s
 * faces, as the preview's face groups give it. Section caps count the solids of a body in groups by these numbers. Costs O(faces).
 */
export function cadKernelFaceSolids(shape: Shape3D, faceIds: readonly number[]): number[] | undefined {
  const oc = getOC(), face = oc.TopAbs_ShapeEnum.TopAbs_FACE, any = oc.TopAbs_ShapeEnum.TopAbs_SHAPE;
  const faces = new oc.NCollection_IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher();
  try {
    const explorer = new oc.TopExp_Explorer(shape.wrapped, face, any);
    try {
      // The same map, in the same order, as the one the face ids index.
      for (; explorer.More(); explorer.Next()) { const element = explorer.Current(); try { faces.Add(element); } finally { element.Nullify(); element.delete(); } }
      const solidOf = new Int32Array(faces.Extent() + 1).fill(-1), solids = cadKernelSolids(shape);
      try {
        for (const [index, solid] of solids.entries()) {
          for (explorer.Init(solid.wrapped, face, any); explorer.More(); explorer.Next()) {
            const element = explorer.Current();
            try {
              const id = faces.FindIndex(element);
              if (!id || (solidOf[id] >= 0 && solidOf[id] !== index)) return undefined;
              solidOf[id] = index;
            } finally { element.Nullify(); element.delete(); }
          }
        }
      } finally { for (const solid of solids) cadKernelDisposeShape(solid); }
      const labels = faceIds.map(id => (Number.isSafeInteger(id) && id > 0 && id < solidOf.length ? solidOf[id] : -1));
      return labels.every(label => label >= 0) ? labels : undefined;
    } finally { explorer.delete(); }
  } finally { faces.delete(); }
}
