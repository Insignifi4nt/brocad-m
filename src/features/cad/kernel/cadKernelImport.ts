import { cast, getOC, isShape3D, type Shape3D } from 'replicad';
import type { TopoDS_Shape } from 'replicad-opencascadejs';
import { CadError } from '../../../domain/cad/cadError';
import { cadKernelDisposeOwned, cadKernelFaces, cadKernelIsValid, cadKernelSolids } from './cadKernelShapes';
import { cadKernelBuilders } from './cadKernelBuilders';
import { cadSolidImportBytes, parseCadSolidImportSource, type CadSolidImportResult, type CadSolidImportSource } from '../../../domain/cad/cadImports';
import { CadKernelTopology } from './cadKernelTopology';
import { assertCadStepLengthUnits } from './cadKernelStepUnits';
import { CAD_PRECISION } from '../../../domain/precision/cadPrecision';
import { cadKernelBounds } from './cadKernelQueries';

function castSolid(raw: TopoDS_Shape): Shape3D {
  const shape = cast(raw);
  if (isShape3D(shape)) return shape;
  cadKernelDisposeOwned(shape); throw new CadError('import-not-solid', 'The file contains surfaces or curves instead of closed solids.');
}

function readStep(path: string, data: string): Shape3D {
  const oc = getOC(); const reader = new oc.STEPControl_Reader();
  try {
    if (reader.ReadFile(path) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new CadError('step-read', 'This STEP file could not be read. It may be damaged or not a STEP file; export it again from the program that made it.');
    if (!assertCadStepLengthUnits(data).nativeTransferSupported) throw new CadError('step-units-unsupported',
      'This STEP uses a conversion-based length unit referring to another conversion-based unit. The current native reader cannot resolve that structure reliably. Re-export with SI length units or a direct conversion to SI. The original file has not changed.');
    // OC length conversion uses millimetres as the reference unit. Apply after ReadFile.
    reader.SetSystemLengthUnit(1);
    const roots = reader.NbRootsForTransfer();
    if (!Number.isSafeInteger(roots) || roots < 1) throw new CadError('step-roots', 'STEP import requires transferable roots.');
    if (reader.TransferRoots() !== roots) throw new CadError('step-transfer', 'Not every STEP root could be transferred. Import was rejected to preserve all source geometry.');
    const raw = reader.OneShape();
    try { if (raw.IsNull()) throw new CadError('import-empty', 'The STEP file contains no geometry.'); return castSolid(raw); }
    finally { cadKernelDisposeOwned(raw); }
  } finally { reader.delete(); }
}

function stlFacetCount(bytes: Uint8Array): number {
  if (bytes.length >= 84) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = view.getUint32(80, true);
    if (84 + count * 50 === bytes.length) {
      for (let facet = 0; facet < count; facet++) for (let coordinate = 0; coordinate < 12; coordinate++) {
        const value = view.getFloat32(84 + facet * 50 + coordinate * 4, true);
        if (!Number.isFinite(value)) throw new CadError('stl-coordinate', 'STL facets must contain finite normals and vertices.');
      }
      return count;
    }
  }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new CadError('stl-read', 'The binary STL triangle count does not match its byte length.'); }
  if (!/^\s*solid\b/i.test(text)) throw new CadError('stl-read', 'Supply a complete binary or ASCII STL file.');
  const contents = /^\s*solid[^\r\n]*[\r\n]+([\s\S]*?)\bendsolid[^\r\n]*\s*$/i.exec(text);
  if (!contents) throw new CadError('stl-read', 'Supply a complete ASCII STL solid.');
  const number = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[Ee][+-]?\\d+)?';
  const triple = `(${number})\\s+(${number})\\s+(${number})`;
  const facet = new RegExp(`\\s*facet\\s+normal\\s+${triple}\\s+outer\\s+loop\\s+vertex\\s+${triple}\\s+vertex\\s+${triple}\\s+vertex\\s+${triple}\\s+endloop\\s+endfacet`, 'iy');
  let offset = 0; let count = 0;
  while (offset < contents[1].length) {
    facet.lastIndex = offset;
    const match = facet.exec(contents[1]);
    if (!match && /^\s*$/.test(contents[1].slice(offset))) break;
    if (!match || match.slice(1).some(value => !Number.isFinite(Number(value)))) throw new CadError('stl-coordinate', 'ASCII STL requires complete facets with finite normals and vertices.');
    offset = facet.lastIndex;
    ++count;
  }
  return count;
}
function readStl(path: string, bytes: Uint8Array, units: 'mm' | 'inch'): Shape3D {
  const facets = stlFacetCount(bytes);
  if (facets < 4) throw new CadError('stl-facets', 'Closed faceted STL import requires at least four complete triangles.');
  const oc = getOC(); const reader = new oc.StlAPI_Reader(); const raw = new oc.TopoDS_Shell();
  let input: Shape3D | undefined;
  const sewing = new oc.BRepBuilderAPI_Sewing(CAD_PRECISION.kernelConfusionMm, true, true, false, false);
  try {
    if (!reader.Read(raw, path) || raw.IsNull()) throw new CadError('stl-read', 'This STL file could not be read. It may be damaged or not an STL file; export it again from the program that made it.');
    input = castSolid(raw);
    const faces = cadKernelFaces(input);
    try { if (faces.length !== facets) throw new CadError('stl-incomplete', 'The STL reader omitted facets. Repair the source mesh before importing.'); }
    finally { for (const face of faces) cadKernelDisposeOwned(face); }
    if (units === 'inch') { const scaled = cadKernelBuilders.scale(input, 25.4); cadKernelDisposeOwned(input); input = scaled; }
    sewing.Add(input.wrapped); sewing.Perform();
    if (sewing.NbFreeEdges() || sewing.NbMultipleEdges()) throw new CadError('stl-open', 'STL import requires a watertight manifold mesh without open or multiply shared edges.');
    const sewn = sewing.SewedShape();
    try {
      if (sewn.IsNull() || sewn.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_SHELL) throw new CadError('stl-shells', 'STL import currently requires one connected closed shell. Use STEP for multiple solids or nested enclosed cavities.');
      if (!oc.BRep_Tool.IsClosed(sewn)) throw new CadError('stl-open', 'The STL shell is not closed.');
      const unify = new oc.ShapeUpgrade_UnifySameDomain(sewn, true, true, false);
      try {
        unify.Build(); const unified = unify.Shape();
        try {
          if (unified.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_SHELL || !oc.BRep_Tool.IsClosed(unified)) throw new CadError('stl-open', 'The merged faceted shell is not closed.');
          const shell = oc.TopoDS.Shell(unified); const maker = new oc.BRepBuilderAPI_MakeSolid(shell);
          try {
            const solid = maker.Solid();
            try {
              if (!oc.BRepLib.OrientClosedSolid(solid)) throw new CadError('stl-orientation', 'The STL shell cannot be consistently oriented as a closed solid.');
              return castSolid(solid);
            } finally { cadKernelDisposeOwned(solid); }
          } finally { maker.delete(); cadKernelDisposeOwned(shell); }
        } finally { cadKernelDisposeOwned(unified); }
      } finally { unify.delete(); }
    } finally { cadKernelDisposeOwned(sewn); }
  } finally { sewing.delete(); if (input) cadKernelDisposeOwned(input); cadKernelDisposeOwned(raw); reader.delete(); }
}

function analyze(shape: Shape3D, source: CadSolidImportSource, sourceBytes: number): CadSolidImportResult {
  const oc = getOC();
  // Bound topology before the more expensive manifold checks and tessellation.
  const topology = new CadKernelTopology(shape); topology.dispose();
  // Ignore descendants of solids: any remaining faces/edges/vertices are free geometry.
  for (const type of [oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_VERTEX]) {
    const explorer = new oc.TopExp_Explorer(shape.wrapped, type, oc.TopAbs_ShapeEnum.TopAbs_SOLID);
    try { if (explorer.More()) throw new CadError('import-not-solid', 'The file contains loose surfaces or curves alongside solids. No geometry was silently discarded.'); }
    finally { explorer.delete(); }
  }
  const solids = cadKernelSolids(shape);
  let volume = 0;
  try {
    if (!solids.length || !cadKernelIsValid(shape)) throw new CadError('import-invalid', 'The file must contain valid closed manifold solids.');
    for (const solid of solids) {
      const shells = solid.wrapped; const shellExplorer = new oc.TopExp_Explorer(shells, oc.TopAbs_ShapeEnum.TopAbs_SHELL, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
      try {
        while (shellExplorer.More()) {
          const shell = shellExplorer.Current();
          try { if (!oc.BRep_Tool.IsClosed(shell)) throw new CadError('import-open', 'The imported solid has an open shell. Repair the source before importing.'); }
          finally { cadKernelDisposeOwned(shell); }
          shellExplorer.Next();
        }
      } finally { shellExplorer.delete(); }
      const properties = new oc.GProp_GProps();
      try {
        oc.BRepGProp.VolumeProperties(solid.wrapped, properties, false, false, false);
        const componentVolume = properties.Mass();
        if (!Number.isFinite(componentVolume) || componentVolume <= CAD_PRECISION.kernelMinimumVolumeMm3) throw new CadError('import-volume', 'Every imported solid must have positive volume and consistent outward orientation.');
        volume += componentVolume;
      } finally { properties.delete(); }
    }
    const [min, max] = cadKernelBounds(shape);
    if ([...min, ...max].some(value => !Number.isFinite(value) || Math.abs(value) > 1e9) || !Number.isFinite(volume)) throw new CadError('import-bounds', 'Imported dimensions exceed the finite millimetre coordinate budget.');
    return { format: source.format, fileName: source.fileName, representation: source.format === 'step' ? 'exact-brep' : 'faceted-brep', volume,
      bounds: { min, max }, solidCount: solids.length, sourceBytes };
  } finally { for (const solid of solids) cadKernelDisposeOwned(solid); }
}

/** Read the immutable original every construction; no persisted BRep is trusted. */
export function loadCadSolidImport(value: CadSolidImportSource): { shape: Shape3D; analysis: CadSolidImportResult } {
  const source = parseCadSolidImportSource(value); const bytes = cadSolidImportBytes(source);
  const oc = getOC(); const path = `/cad-import-${crypto.randomUUID()}.${source.format === 'step' ? 'step' : 'stl'}`;
  let shape: Shape3D | undefined;
  let written = false;
  try {
    oc.FS.writeFile(path, bytes); written = true;
    shape = source.format === 'step' ? readStep(path, source.data) : readStl(path, bytes, source.units);
    const analysis = analyze(shape, source, bytes.length);
    return { shape, analysis };
  } catch (error) { if (shape) cadKernelDisposeOwned(shape); throw error; }
  finally { if (written) oc.FS.unlink(path); }
}
export function prepareCadSolidImport(source: CadSolidImportSource): CadSolidImportResult {
  const loaded = loadCadSolidImport(source);
  try { return loaded.analysis; } finally { cadKernelDisposeOwned(loaded.shape); }
}
