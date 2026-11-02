import { getOC, type Shape3D } from 'replicad';
import type { TopoDS_Shape } from 'replicad-opencascadejs';
import type { CadBodySolidSource } from '../../../domain/cad/cadBodies';
import { cadKernelDisposeShape, cadKernelSolids } from './cadKernelShapes';

/**
 * The faces of the shapes one feature combined, source by source, so that each solid of its result can be traced to every source solid
 * it keeps a face of unchanged: the same native face, wherever its orientation. A face's rank is its place in its source's face order,
 * from 1. A face that two solids of a source, or two sources, share proves neither, since which of them it would be given to follows the
 * order they are listed in, so it is never traced. Solids are numbered as `cadKernelSolids` lists them, which is how
 * `CadMesh.faceSolids` numbers them; a copy made by moving a clone lists its solids and faces in its original's order. The record holds
 * native handles to the faces, so a source may be released once added. Adding and tracing cost O(faces).
 */
export interface CadKernelFaceSources {
  /** Adds the faces of the next source. */
  add(shape: Shape3D): void;
  /** For each solid of `result`, each source solid it keeps a face of, with the lowest rank among those faces. */
  trace(result: Shape3D): CadBodySolidSource[][];
  dispose(): void;
}

export function createCadKernelFaceSources(): CadKernelFaceSources {
  const oc = getOC(), face = oc.TopAbs_ShapeEnum.TopAbs_FACE, any = oc.TopAbs_ShapeEnum.TopAbs_SHAPE;
  const faces = new oc.NCollection_IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher();
  // By face index, from 1: its source, the solid of the source it bounds, or UNBOUND or SHARED, and its rank there.
  const UNBOUND = -1, SHARED = -2, sourceOf = [-1], solidOf = [UNBOUND], rankOf = [0];
  let sources = 0;
  function visit(shape: TopoDS_Shape, each: (element: TopoDS_Shape) => void) {
    const explorer = new oc.TopExp_Explorer(shape, face, any);
    try {
      for (; explorer.More(); explorer.Next()) { const element = explorer.Current(); try { each(element); } finally { element.Nullify(); element.delete(); } }
    } finally { explorer.delete(); }
  }
  return {
    add(shape) {
      const source = sources++;
      let rank = 0;
      visit(shape.wrapped, element => {
        const id = faces.Add(element);
        if (id === sourceOf.length) { sourceOf.push(source); solidOf.push(UNBOUND); rankOf.push(++rank); } else if (sourceOf[id] !== source) solidOf[id] = SHARED;
      });
      const solids = cadKernelSolids(shape);
      try {
        for (const [number, solid] of solids.entries()) visit(solid.wrapped, element => {
          const id = faces.FindIndex(element);
          if (id && sourceOf[id] === source && solidOf[id] !== SHARED) solidOf[id] = solidOf[id] === UNBOUND || solidOf[id] === number ? number : SHARED;
        });
      } finally { for (const solid of solids) cadKernelDisposeShape(solid); }
    },
    trace(result) {
      const solids = cadKernelSolids(result);
      try {
        return solids.map(solid => {
          const reached = new Map<number, Map<number, number>>();
          visit(solid.wrapped, element => {
            const id = faces.FindIndex(element);
            if (!id || solidOf[id] < 0) return;
            let bySolid = reached.get(sourceOf[id]);
            if (!bySolid) reached.set(sourceOf[id], bySolid = new Map());
            const rank = bySolid.get(solidOf[id]);
            if (rank === undefined || rankOf[id] < rank) bySolid.set(solidOf[id], rankOf[id]);
          });
          const entries: CadBodySolidSource[] = [];
          for (const [source, bySolid] of reached) for (const [number, rank] of bySolid) entries.push({ source, solid: number, rank });
          return entries;
        });
      } finally { for (const solid of solids) cadKernelDisposeShape(solid); }
    },
    dispose() { faces.delete(); }
  };
}
