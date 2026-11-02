import { cast, Compound, getOC, isShape3D, type Drawing, type Shape3D, type SimplePoint, type Sketch } from 'replicad';
import type { CadBuildResult, CadDocument, CadFeature, CadMesh, CadScalar, CadSketchFeature } from '../../../domain/cad/cadDocument';
import { evaluateCadAngle, evaluateCadScalar } from '../../../domain/cad/cadExpression';
import { CadError } from '../../../domain/cad/cadError';
import { isCadRefusalFactCode, isCadRefusalFacts } from '../../../domain/cad/cadIssueCodes';
import { resolveCadSketchRegions, type CadSketchMaterialRegion } from '../../../domain/cad/cadSketchGeometry';
import type { CadSectionRequest, CadSectionResult } from '../../../domain/cad/cadSection';
import { createCadKernelPlane } from './cadKernelPlane';
import { resolveCadExtrudeRevolvePlacement, resolveCadWorldDatum, type CadDatumFrameLookup, type CadResolvedFrame } from '../../../domain/cad/cadDatumPlanes';
import { cadKernelProfileDrawing, cadKernelSketchFace, cadKernelSketchOnPlane } from './cadKernelSketch';
import { sectionCadKernelShape } from './cadKernelSection';
import { CadKernelTopology } from './cadKernelTopology';
import { parseCadTopologyAdjacencyRequest, parseCadTopologyTangentChainRequest, type CadTopologyAdjacency, type CadTopologyAdjacencyRequest,
  type CadTopologyTangentChain, type CadTopologyTangentChainRequest } from '../../../domain/cad/cadTopologyAdjacency';
import { applyCadEdgeOperation, applyCadShell } from './cadKernelOperations';
import { loadCadSolidImport } from './cadKernelImport';
import { MAX_CAD_PATTERN_INSTANCES, resolveCadCircularPattern } from '../../../domain/cad/cadPatterns';
import { resolveCadLoftSections } from '../../../domain/cad/cadLoft';
import { buildCadLoftSolid } from './cadKernelLoft';
import { resolveCadSweepInputs } from '../../../domain/cad/cadSweep';
import { buildCadSweepSolid } from './cadKernelSweep';
import { resolveCadPocketInputs } from '../../../domain/cad/cadPocket';
import { buildCadPocketCut } from './cadKernelPocket';
import { cadKernelSolidEvidence, cutCadKernelConfirmedMaterial } from './cadKernelCutEvidence';
import { cadKernelFaceSolids, meshCadKernelPreview } from './cadKernelMeshing';
import { cadKernelDisposeOwned, cadKernelDisposeShape, cadKernelIsValid, cadKernelSolids } from './cadKernelShapes';
import { cadKernelAx1, cadKernelBuilders, cadKernelScaledUnitVector } from './cadKernelBuilders';
import { exportCadKernelStep } from './cadKernelExport';
import { parseCadTopologyInspectRequest, parseCadTopologyResolvePicksRequest, type CadTopologyInspectRequest, type CadTopologyInspectResult,
  type CadTopologyResolvePicksRequest, type CadTopologyResolvePicksResult } from '../../../domain/cad/cadTopology';
import { CAD_PRECISION } from '../../../domain/precision/cadPrecision';
import { createCadBodyLineage, type CadBodyKey, type CadBodySource } from '../../../domain/cad/cadBodies';
import { createCadKernelFaceSources, type CadKernelFaceSources } from './cadKernelBodyPieces';
import { cadFeatureActive } from '../../../domain/cad/features/cadFeatureActivity';
import { cadFeatureScalar, cadFeatureScalarAccepts } from '../../../domain/cad/features/cadFeatureRegistry';
import { cadKernelBounds, cadKernelVolume } from './cadKernelQueries';
import { cadKernelOperationOf } from '../../../domain/cad/cadBuildIssues';
import type { CadKernelOperation } from '../../../domain/cad/cadDocument';
import { cadKernelFailure, type CadKernelStep } from './cadKernelFailures';

/** BRep state stays inside the worker. Only tessellation and export bytes leave it. */
export interface CadKernelModel {
  readonly result: CadBuildResult;
  export(format: 'step' | 'stl'): Blob;
  section(request: CadSectionRequest, parameters?: CadDocument['parameters']): CadSectionResult;
  inspectTopology(request: CadTopologyInspectRequest): CadTopologyInspectResult;
  resolveTopologyPicks(request: CadTopologyResolvePicksRequest, parameters?: CadDocument['parameters']): CadTopologyResolvePicksResult;
  topologyAdjacency(request: CadTopologyAdjacencyRequest): CadTopologyAdjacency;
  /** The edges native fillet and chamfer treat when they follow tangents from one edge of a body. */
  topologyTangentChain(request: CadTopologyTangentChainRequest): CadTopologyTangentChain;
  dispose(): void;
}

const meshOptions = { tolerance: CAD_PRECISION.tessellationMm, angularTolerance: CAD_PRECISION.tessellationAngleRad };

/**
 * Returns the solid count and whole-shape volume so callers reuse the measurement.
 * Pass topologyChecked only when this exact shape passed OpenCascade's validity
 * check and no kernel operation has used it since.
 */
function validateSolid(shape: Shape3D, topologyChecked = false): { solidCount: number; volume: number } {
  if (shape.isNull) throw new CadError('empty-solid', 'The operation produced no solid.');
  const solids = cadKernelSolids(shape);
  try {
    if (!solids.length || solids.some(solid => !positiveVolume(cadKernelVolume(solid)))) {
      throw new CadError('empty-solid', 'The operation must contain closed solids with positive volume.');
    }
  } finally { for (const solid of solids) cadKernelDisposeShape(solid); }
  if (!topologyChecked && !cadKernelIsValid(shape)) throw new CadError('invalid-solid', 'The result is not a valid closed solid: some of its faces cross or leave gaps. Reduce the dimensions of this feature or revise its inputs.');
  const volume = cadKernelVolume(shape);
  if (!positiveVolume(volume)) throw new CadError('empty-solid', 'The operation must produce a closed solid with positive volume.');
  return { solidCount: solids.length, volume };
}

function positiveVolume(volume: number) {
  return Number.isFinite(volume) && volume > CAD_PRECISION.kernelMinimumVolumeMm3;
}

function shapeMesh(shape: Shape3D, feature: CadFeature, bodyKey: CadBodyKey, topology: CadKernelTopology, { solidCount, volume }: { solidCount: number; volume: number }): CadMesh {
  const [min, max] = cadKernelBounds(shape);
  const { mesh, edgeMesh } = meshCadKernelPreview(shape, { min, max }, meshOptions);
  const groups = topology.meshGroups(mesh, edgeMesh);
  // The face groups that meshGroups keeps, in its order: those with triangles.
  const faceSolids = solidCount > 1 ? cadKernelFaceSolids(shape, mesh.faceGroups.filter(group => group.count > 0).map(group => group.faceId)) : undefined;
  return { featureId: feature.id, bodyKey, name: feature.name, positions: mesh.vertices, normals: mesh.normals, indices: mesh.triangles,
    edges: edgeMesh.lines, ...groups, volume, solidCount, ...(faceSolids ? { faceSolids } : {}), bounds: { min, max } };
}

/** Operations commit only after exact topology validation and successful meshing. */
export function buildCadKernelModel(document: CadDocument): CadKernelModel {
  const started = performance.now();
  const buildId = crypto.randomUUID();
  const shapes = new Set<Shape3D>();
  /** Built bodies by key. The lineage resolves a stored target, the id of the feature whose result a body is, to its key. */
  const bodies = new Map<CadBodyKey, { shape: Shape3D; feature: CadFeature; mesh: CadMesh; instances: number; topology: CadKernelTopology }>();
  const lineage = createCadBodyLineage();
  const sketches = new Map<string, CadSketchFeature>();
  const references = new Map<string, CadFeature>();
  const datumFrames = new Map<string, CadResolvedFrame>();
  const frameLookup: CadDatumFrameLookup = Object.freeze({ get: (id: string) => datumFrames.get(id) });
  const diagnostics: CadBuildResult['diagnostics'][number][] = [];
  const number = (value: CadScalar) => evaluateCadScalar(value, document.parameters);
  const own = (shape: Shape3D) => { shapes.add(shape); return shape; };
  const release = (shape: Shape3D) => { cadKernelDisposeShape(shape); shapes.delete(shape); };
  /** Applies an owned operation to a transient input, then releases the input. A failed operation leaves the input to releaseTransientShapes. */
  const replace = (input: Shape3D, operation: (input: Shape3D) => Shape3D) => { const next = own(operation(input)); release(input); return next; };
  const entryOf = (id: string) => { const state = lineage.at(id); return state ? bodies.get(state.key) : undefined; };
  const body = (id: string) => {
    const found = entryOf(id);
    if (!found) throw new CadError('missing-body', `Body ${id} is unavailable or has already been consumed. Choose a current body from the feature tree.`);
    return found.shape;
  };
  const instancesOf = (id: string) => entryOf(id)?.instances ?? 1;
  const checkedInstances = (count: number) => {
    if (!Number.isSafeInteger(count) || count < 1) throw new CadError('invalid-instances', 'Expanded solid instance counts must be positive safe integers.');
    return count;
  };
  const checkedPatternInstances = (count: number) => {
    checkedInstances(count);
    if (count > MAX_CAD_PATTERN_INSTANCES) throw new CadError('instance-limit', 'Expanded nested patterns may contain at most 1000 solid instances. Reduce the pattern counts.');
    return count;
  };
  function releaseTransientShapes() {
    const retained = new Set([...bodies.values()].map(item => item.shape));
    for (const shape of shapes) if (!retained.has(shape)) { cadKernelDisposeShape(shape); shapes.delete(shape); }
  }

  /** A single region returns its checked shape unchanged; several regions return their fused, unchecked union. */
  function fromSketch(feature: Extract<CadFeature, { kind: 'extrude' | 'revolve' }>, regions: readonly CadSketchMaterialRegion[]): { shape: Shape3D; checked: boolean } {
    const sketch = sketches.get(feature.sketchId);
    if (!sketch) throw new CadError('missing-sketch', 'The source sketch is unavailable or suppressed.');
    const placement = resolveCadExtrudeRevolvePlacement(feature, sketch, document.parameters, frameLookup);
    const orientation = placement.frame;
    const offset = placement.offsetMm;
    const distance = feature.kind === 'extrude' ? number(feature.distance) : 0;
    const originOffset = offset - (feature.kind === 'extrude' && feature.symmetric ? distance / 2 : 0);
    const plane = createCadKernelPlane(orientation, originOffset);
    const revolutionAxis: SimplePoint = [...(feature.kind === 'revolve' && feature.axis === 'y' ? orientation.v : orientation.u)];
    const drawings: Drawing[] = [];
    const consumedSketches: Sketch[] = [];
    try {
      const origin: SimplePoint = plane.origin.toTuple();
      let result: Shape3D | undefined;
      for (const region of regions) {
        const boundaries = [region.boundary, ...region.voids];
        const wires = boundaries.map(item => { const drawing = cadKernelProfileDrawing(item.geometry, drawings); const wire = cadKernelSketchOnPlane(drawing, plane); consumedSketches.push(wire); return wire; });
        const face = cadKernelSketchFace(wires), oc = getOC();
        try {
          const vector = feature.kind === 'extrude' ? cadKernelScaledUnitVector(orientation.normal, distance) : null;
          const axis = feature.kind === 'revolve' ? cadKernelAx1(origin, revolutionAxis) : null;
          try {
            const builder = vector ? new oc.BRepPrimAPI_MakePrism(face.wrapped, vector, false, true)
              : axis && feature.kind === 'revolve' ? new oc.BRepPrimAPI_MakeRevol(face.wrapped, axis, number(feature.angle) * Math.PI / 180, false) : null;
            if (!builder) throw new CadError('empty-solid', 'The profile needs an extrusion direction or revolution axis.');
            try {
              const raw = builder.Shape();
              try {
                const built = cast(raw);
                if (!isShape3D(built)) { built.delete(); throw new CadError('empty-solid', 'The sketch profile made no closed solid. A contour may be open or too small; close or enlarge it in the sketch.'); }
                const shape = own(built);
                if (feature.operation === 'cut') cadKernelSolidEvidence(shape, 'tool', 'Cut');
                else validateSolid(shape);
                result = result ? own(cadKernelBuilders.fuse(result, shape)) : shape;
              } finally { raw.Nullify(); raw.delete(); }
            } finally { builder.delete(); }
          } finally { vector?.delete(); axis?.delete(); }
        } finally { cadKernelDisposeShape(face); }
      }
      if (!result) throw new CadError('empty-sketch', 'A solid feature needs at least one closed non-construction profile.');
      return { shape: result, checked: regions.length === 1 };
    } finally {
      for (const sketched of consumedSketches) cadKernelDisposeOwned(sketched);
      plane.delete();
      for (const drawing of drawings) drawing.blueprint.delete();
    }
  }

  for (const [featureIndex, feature] of document.features.entries()) {
    if (!cadFeatureActive(feature, document)) { lineage.apply(feature, document); continue; }
    // A pattern records each copy's faces before releasing it, so the copies' solids can be traced in its result.
    let copyFaces: CadKernelFaceSources | undefined;
    // The step the rebuild of this feature is taking and the input it reads, which its failure names.
    let step: CadKernelStep = { operation: cadKernelOperationOf(feature), input: null };
    const at = (operation: CadKernelOperation, field?: string, id?: string | null) => { step = { operation, input: field && id ? { field, id } : null }; };
    try {
      let result: Shape3D;
      // Whether the feature takes material from its target, and so may split it, and whether its result lists solids as its source did.
      let removesMaterial = false, sameSolidOrder = false;
      // The tool a join or union fused into its target, and the copies a pattern made, whose faces the result may keep.
      let fusedTool: Shape3D | undefined;
      const copies: CadBodySource[] = [];
      // True only when result itself was just validated, with no kernel operation on it since.
      let topologyChecked = false;
      let instances = 1;
      switch (feature.kind) {
        case 'datum-plane': datumFrames.set(feature.id, resolveCadWorldDatum(feature, document.parameters)); references.set(feature.id, feature); continue;
        case 'sketch': sketches.set(feature.id, feature); references.set(feature.id, feature); continue;
        case 'curve': references.set(feature.id, feature); continue; // Exact reference geometry produces and consumes no native body.
        case 'imported': {
          at('import');
          const imported = loadCadSolidImport(feature.source);
          result = own(imported.shape); instances = checkedInstances(imported.analysis.solidCount); break;
        }
        case 'extrude': case 'revolve': {
          at(feature.kind, 'sketchId', feature.sketchId);
          const sourceSketch = sketches.get(feature.sketchId);
          if (!sourceSketch) throw new CadError('missing-sketch', 'The source sketch is unavailable or suppressed.');
          const regions = resolveCadSketchRegions(sourceSketch, document.parameters, feature.kind === 'extrude' ? feature.regionSelection : undefined);
          instances = regions.length;
          if (feature.targetId !== null) instances = checkedInstances(instances + instancesOf(feature.targetId));
          const sketched = fromSketch(feature, regions);
          result = sketched.shape; topologyChecked = sketched.checked;
          if (feature.operation !== 'new') {
            if (!feature.targetId) throw new CadError('missing-target', 'Join and cut need a target body.');
            at(feature.operation, 'targetId', feature.targetId);
            const target = body(feature.targetId);
            removesMaterial = feature.operation === 'cut';
            if (feature.operation === 'join') fusedTool = result;
            result = own(feature.operation === 'join' ? cadKernelBuilders.fuse(target, result)
              : cutCadKernelConfirmedMaterial(target, result, { toolConfirmed: sketched.checked }));
            topologyChecked = feature.operation === 'cut';
          }
          break;
        }
        case 'loft': {
          at('loft');
          const sections = resolveCadLoftSections(feature, references, document.parameters, frameLookup);
          if (feature.operation !== 'new') {
            if (!feature.targetId) throw new CadError('missing-target', 'Join and cut need a target body.');
            at(feature.operation, 'targetId', feature.targetId);
            const target = body(feature.targetId);
            instances = checkedInstances(1 + instancesOf(feature.targetId));
            at('loft');
            const loft = own(buildCadLoftSolid(sections, feature.ruled));
            at(feature.operation, 'targetId', feature.targetId);
            removesMaterial = feature.operation === 'cut';
            if (feature.operation === 'join') fusedTool = loft;
            result = own(feature.operation === 'join' ? cadKernelBuilders.fuse(target, loft) : cutCadKernelConfirmedMaterial(target, loft));
            topologyChecked = feature.operation === 'cut';
          } else result = own(buildCadLoftSolid(sections, feature.ruled));
          break;
        }
        case 'sweep': {
          at('sweep', 'curveId', feature.curveId);
          const inputs = resolveCadSweepInputs(feature, references, document.parameters, frameLookup);
          if (feature.operation !== 'new') {
            if (!feature.targetId) throw new CadError('missing-target', 'Join and cut need a target body.');
            at(feature.operation, 'targetId', feature.targetId);
            const target = body(feature.targetId);
            instances = checkedInstances(1 + instancesOf(feature.targetId));
            at('sweep', 'curveId', feature.curveId);
            const sweep = own(buildCadSweepSolid(inputs));
            at(feature.operation, 'targetId', feature.targetId);
            removesMaterial = feature.operation === 'cut';
            if (feature.operation === 'join') fusedTool = sweep;
            result = own(feature.operation === 'join' ? cadKernelBuilders.fuse(target, sweep) : cutCadKernelConfirmedMaterial(target, sweep));
            topologyChecked = feature.operation === 'cut';
          } else result = own(buildCadSweepSolid(inputs));
          break;
        }
        case 'pocket': {
          at('pocket', 'targetId', feature.targetId);
          const target = body(feature.targetId);
          at('pocket', 'sketchId', feature.sketchId);
          const prefix = new Map(document.features.slice(0, featureIndex).map(entry => [entry.id, entry]));
          const inputs = resolveCadPocketInputs(feature, prefix, document.parameters);
          instances = checkedInstances(inputs.regionCount + instancesOf(feature.targetId));
          removesMaterial = true;
          result = own(buildCadPocketCut(target, inputs)); break;
        }
        case 'fillet': case 'chamfer': {
          at(feature.kind, 'targetId', feature.targetId);
          const target = body(feature.targetId);
          instances = instancesOf(feature.targetId);
          const topology = entryOf(feature.targetId)?.topology;
          if (!topology) throw new CadError('missing-body', 'The selected target body is unavailable.');
          result = own(feature.selection ? applyCadEdgeOperation(target, topology.selectedEdges(feature.selection, document.parameters), feature.kind, number(feature.radius), feature.tangentPropagation === true)
            : feature.kind === 'fillet' ? cadKernelBuilders.filletAll(target, number(feature.radius)) : cadKernelBuilders.chamferAll(target, number(feature.radius)));
          break;
        }
        case 'shell': {
          at('shell', 'targetId', feature.targetId);
          const target = body(feature.targetId); const topology = entryOf(feature.targetId)?.topology;
          if (!topology) throw new CadError('missing-body', 'The shell target body is unavailable.');
          instances = instancesOf(feature.targetId);
          result = own(applyCadShell(target, topology.selectedFace(feature.opening, document.parameters), number(feature.thickness)));
          if (!(cadKernelVolume(result) < cadKernelVolume(target) - CAD_PRECISION.kernelMinimumVolumeMm3)) throw new CadError('shell-failed', 'The inward shell did not remove material. Reduce its thickness or choose another opening.');
          const [originalMin, originalMax] = cadKernelBounds(target); const [shellMin, shellMax] = cadKernelBounds(result);
          if (shellMin.some((value, axis) => value < originalMin[axis] - CAD_PRECISION.kernelBoundsSlackMm) || shellMax.some((value, axis) => value > originalMax[axis] + CAD_PRECISION.kernelBoundsSlackMm)) {
            throw new CadError('shell-failed', 'The shell grew outside the body instead of making inward walls. Reduce the thickness or choose another opening.');
          }
          break;
        }
        case 'boolean': {
          const operation = feature.operation === 'union' ? 'join' : feature.operation;
          at(operation, 'targetId', feature.targetId);
          const target = body(feature.targetId);
          at(operation, 'toolId', feature.toolId);
          const tool = body(feature.toolId);
          instances = checkedInstances(instancesOf(feature.targetId) + instancesOf(feature.toolId));
          removesMaterial = feature.operation !== 'union';
          if (feature.operation === 'union') fusedTool = tool;
          result = own(feature.operation === 'union' ? cadKernelBuilders.fuse(target, tool) : feature.operation === 'cut' ? cutCadKernelConfirmedMaterial(target, tool) : cadKernelBuilders.common(target, tool));
          topologyChecked = feature.operation === 'cut';
          break;
        }
        case 'transform': {
          at('transform', 'sourceId', feature.sourceId);
          instances = instancesOf(feature.sourceId);
          // A moved copy lists its solids in its source's order.
          sameSolidOrder = true;
          result = own(body(feature.sourceId).clone());
          for (let axis = 0; axis < 3; axis++) {
            const angle = evaluateCadAngle(feature.rotation[axis], document.parameters);
            if (angle !== 0) result = replace(result, shape => cadKernelBuilders.rotate(shape, angle, [0, 0, 0], axis === 0 ? [1, 0, 0] : axis === 1 ? [0, 1, 0] : [0, 0, 1]));
          }
          const translation = [number(feature.translation[0]), number(feature.translation[1]), number(feature.translation[2])] as const;
          result = replace(result, shape => cadKernelBuilders.translate(shape, translation));
          break;
        }
        case 'mirror': at('mirror', 'sourceId', feature.sourceId); instances = instancesOf(feature.sourceId); result = replace(own(body(feature.sourceId).clone()), shape => cadKernelBuilders.mirror(shape, feature.plane)); break;
        case 'linear-pattern': {
          at('pattern', 'sourceId', feature.sourceId);
          if (!cadFeatureScalarAccepts(cadFeatureScalar(feature.kind, 'count'), feature.count)) throw new CadError('pattern-limit', 'Patterns require 2–100 instances.');
          const source = body(feature.sourceId);
          instances = checkedPatternInstances(instancesOf(feature.sourceId) * feature.count);
          const spacing = feature.spacing.map(number);
          result = source;
          copyFaces = createCadKernelFaceSources(); copyFaces.add(source);
          for (let index = 1; index < feature.count; index++) {
            // Keep only the original seed and current union while building, just as for circular patterns.
            const instance = replace(own(source.clone()), shape => cadKernelBuilders.translate(shape, [spacing[0] * index, spacing[1] * index, spacing[2] * index]));
            copyFaces.add(instance); copies.push({ kind: 'copy', i: index, j: 0 });
            const previous = result;
            result = own(cadKernelBuilders.fuse(previous, instance));
            release(instance);
            if (previous !== source) release(previous);
          }
          break;
        }
        case 'circular-pattern': {
          at('pattern', 'sourceId', feature.sourceId);
          const pattern = resolveCadCircularPattern(feature, document.parameters);
          const source = body(feature.sourceId);
          instances = checkedPatternInstances(instancesOf(feature.sourceId) * pattern.count);
          const center: SimplePoint = [...pattern.center]; const direction: SimplePoint = [...pattern.direction];
          result = source;
          copyFaces = createCadKernelFaceSources(); copyFaces.add(source);
          for (const [place, angle] of pattern.angles.slice(1).entries()) {
            // Keep only the original seed and current union while constructing the pattern.
            const instance = replace(own(source.clone()), shape => cadKernelBuilders.rotate(shape, angle, center, direction));
            copyFaces.add(instance); copies.push({ kind: 'copy', i: place + 1, j: 0 });
            const previous = result;
            result = own(cadKernelBuilders.fuse(previous, instance));
            release(instance);
            if (previous !== source) release(previous);
          }
          break;
        }
        default: { const exhaustive: never = feature; throw new Error(`Unsupported feature: ${exhaustive}`); }
      }
      at('check');
      const measured = validateSolid(result, topologyChecked);
      at('record');
      const topology = new CadKernelTopology(result);
      try {
        const key = lineage.keyFor(feature, document);
        // Every kind the switch builds makes or changes a body, so this cannot happen; it adds no diagnostic code of its own.
        if (key === undefined) throw new Error('The feature made no body.');
        const mesh = shapeMesh(result, feature, key, topology, measured);
        const made = result, previous = bodies.get(key), recorded = copyFaces, tool = fusedTool;
        const sources: CadBodySource[] = [{ kind: 'target' }, ...tool ? [{ kind: 'tool' } as const] : [], ...copies];
        // The lineage settles the body's parts before it changes, so a failure here leaves it and the built bodies as they were.
        const change = lineage.apply(feature, document, { solids: measured.solidCount, removesMaterial, sameSolidOrder, sources,
          provenance: () => {
            if (recorded) return recorded.trace(made);
            if (!previous) throw new Error('The feature kept no body.');
            const traced = createCadKernelFaceSources();
            try {
              traced.add(previous.shape);
              if (tool) traced.add(tool);
              return traced.trace(made);
            } finally { traced.dispose(); }
          } })!;
        for (const consumed of change.consumed) { bodies.get(consumed)?.topology.dispose(); bodies.delete(consumed); }
        previous?.topology.dispose();
        bodies.set(key, { shape: result, feature, mesh, instances, topology });
      } catch (error) { topology.dispose(); throw error; }
      releaseTransientShapes();
    } catch (error) {
      releaseTransientShapes();
      // The reply guard refuses a code that carries facts without them; in development the site that raised it is found here.
      if (import.meta.env?.DEV && error instanceof CadError && isCadRefusalFactCode(error.code) && !isCadRefusalFacts(error.code, error.facts)) {
        throw new Error(`Refusal ${error.code} of ${feature.id} is raised without its facts.`);
      }
      diagnostics.push(cadKernelFailure(feature.id, error, step));
      diagnostics.push({ code: 'rebuild-stopped', featureId: feature.id, message: 'Rebuild stopped here. The preview shows the preceding valid features; downstream features have not been evaluated.' });
      break;
    } finally { copyFaces?.dispose(); }
  }
  let disposed = false;
  const built = lineage.bodies().filter(state => bodies.has(state.key));
  return {
    result: { buildId, meshes: built.map(state => bodies.get(state.key)!.mesh), diagnostics, bodies: built, bodyIssues: lineage.issues(), durationMs: performance.now() - started },
    export(format) {
      if (disposed) throw new Error('CAD model has been disposed.');
      if (diagnostics.length) throw new CadError('invalid-export', 'Fix the feature diagnostics before exporting. The retained preview is not the requested model.');
      const active = built.map(state => bodies.get(state.key)!);
      if (!active.length) throw new CadError('empty-export', 'Create a valid solid before exporting.');
      if (format === 'step') return exportCadKernelStep(active.map(({ shape, feature }) => ({ shape, name: feature.name })));
      const oc = getOC(), compound = new Compound(new oc.TopoDS_Compound());
      try {
        const builder = new oc.TopoDS_Builder();
        try {
          builder.MakeCompound(compound.wrapped);
          for (const { shape } of active) builder.Add(compound.wrapped, shape.wrapped);
          return compound.blobSTL({ ...meshOptions, binary: true });
        } finally { builder.delete(); }
      } finally { cadKernelDisposeShape(compound); }
    },
    section(request, parameters = document.parameters) {
      if (disposed) throw new Error('CAD model has been disposed.');
      if (diagnostics.length) throw new CadError('invalid-section', 'Fix the model diagnostics before extracting a section. The retained preview is not the requested solid.');
      return sectionCadKernelShape(body(request.bodyId), { bodyId: request.bodyId, plane: request.plane, offset: evaluateCadScalar(request.offset, parameters) });
    },
    inspectTopology(request) {
      const parsed = parseCadTopologyInspectRequest(request);
      if (disposed || parsed.expectedBuildId !== buildId) throw new CadError('STALE_BUILD', 'The topology snapshot is stale. Rebuild the current document and select again.');
      body(parsed.bodyId);
      const topology = entryOf(parsed.bodyId)?.topology;
      if (!topology) throw new CadError('missing-body', 'This body has no faces or edges in the current build. Rebuild the part and select again.');
      return topology.inspect(parsed, buildId);
    },
    topologyAdjacency(request) {
      const parsed = parseCadTopologyAdjacencyRequest(request);
      if (disposed || parsed.expectedBuildId !== buildId) throw new CadError('STALE_BUILD', 'The topology snapshot is stale. Rebuild the current document and select again.');
      body(parsed.bodyId);
      const topology = entryOf(parsed.bodyId)?.topology;
      if (!topology) throw new CadError('missing-body', 'This body has no faces or edges in the current build. Rebuild the part and select again.');
      return topology.adjacency(parsed.bodyId, buildId);
    },
    topologyTangentChain(request) {
      const parsed = parseCadTopologyTangentChainRequest(request);
      if (disposed || parsed.expectedBuildId !== buildId) throw new CadError('STALE_BUILD', 'The topology snapshot is stale. Rebuild the current document and select again.');
      const shape = body(parsed.bodyId), topology = entryOf(parsed.bodyId)?.topology;
      if (!topology) throw new CadError('missing-body', 'This body has no faces or edges in the current build. Rebuild the part and select again.');
      return topology.tangentChain(shape, parsed.bodyId, buildId, parsed.edgeKey);
    },
    resolveTopologyPicks(request, parameters = document.parameters) {
      const parsed = parseCadTopologyResolvePicksRequest(request);
      if (disposed || parsed.expectedBuildId !== buildId) throw new CadError('STALE_BUILD', 'The topology snapshot is stale. Rebuild the current document and select again.');
      if (diagnostics.length) throw new CadError('invalid-selection', 'Fix the feature diagnostics before applying a topology selection.');
      body(parsed.bodyId);
      const topology = entryOf(parsed.bodyId)?.topology;
      if (!topology) throw new CadError('missing-body', 'This body has no faces or edges in the current build. Rebuild the part and select again.');
      return topology.resolvePicks(parsed, buildId, parameters);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of bodies.values()) entry.topology.dispose();
      for (const shape of shapes) cadKernelDisposeShape(shape);
    }
  };
}
