import type { CadDocument, CadProfile, CadSketchFeature } from './cadDocument';
import { cadFeatureActive } from './features/cadFeatureActivity';
import type { DxfPoint } from '../dxf/types';
import { CadError } from './cadError';
import { CadDocumentSchema, CadSketchFeatureSchema, isAcceptedCadSketchSource, parseCadDocument } from './cadSchema';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { isCadImportData } from './cadImportData';
import { measureCadResolvedProfile, type CadBounds2 } from './cadMeasurements';
import { resolveCadSketchContours, resolveCadSketchRegions, type CadResolvedSketchContour, type CadSketchRegion, type CadSketchMaterialRegion } from './cadSketchGeometry';
import { createCadSketchCellIndex, selectCadSketchRegions, isCadSketchGraphCellSelection,
  type CadSketchCellReference, type CadSketchCellMode, type CadSketchCellId, type CadSketchRegionSelection } from './cadSketchRegionSelection';
import { prepareCadSketchGraphCells } from './cadSketchGraphCells';
export type { CadSketchCellMode, CadSketchCellId } from './cadSketchRegionSelection';
import { readCadSketchGeometryParameters, sameCadSketchGeometryValues } from './cadSketchParameterReads';
import { CadSketchSplitTargetSchema, splitCadSketchEntity, type CadSketchSplitTarget } from './cadSketchSplit';
import { CadSketchCutAxesSchema, CadSketchRemovedRelationIdsSchema, CadSketchTrimTargetSchema, prepareCadSketchTrim, trimCadSketchEntity, type CadSketchTrimTarget,
  CadSketchExtendTargetSchema, prepareCadSketchExtend, extendCadSketchEntity, type CadSketchExtendTarget } from './cadSketchTrimExtend';
import { CadSketchOffsetRequestSchema, prepareCadSketchOffset, type CadSketchOffsetRequest } from './cadSketchOffset';
import { CadSketchMirrorRequestSchema, prepareCadSketchMirror, type CadSketchMirrorRequest } from './cadSketchMirror';
import { deepFreezeCadData } from './cadDeepFreeze';
import { CadSketchGeneratorSchema, type CadSketchGenerator } from './cadSketchGraph';

export interface CadPreparedSketchCell {
  readonly id: CadSketchCellId;
  readonly name: string;
  readonly reference: CadSketchCellReference;
  readonly boundary: CadResolvedSketchContour;
  readonly voids: readonly CadResolvedSketchContour[];
  readonly areaMm2: number;
  readonly boundaryLengthMm: number;
  readonly boundsMm: CadBounds2;
  readonly defaultMaterial: boolean;
}
export interface CadPreparedSketchCells {
  readonly mode: 'contours';
  readonly cells: readonly CadPreparedSketchCell[];
  pick(point: DxfPoint): CadPreparedSketchCell | null;
  pack(ids: readonly CadSketchCellId[]): readonly CadSketchCellReference[];
  selectedCellIds(selection?: CadSketchRegionSelection): readonly CadSketchCellId[];
  resolve(selection?: readonly CadSketchCellReference[]): readonly CadSketchRegion[];
  resolve(selection?: CadSketchRegionSelection): readonly CadSketchMaterialRegion[];
}
export type CadPreparedSketchGraphCells = Omit<ReturnType<typeof prepareCadSketchGraphCells>, 'resolve'> & {
  resolve(selection?: CadSketchRegionSelection): readonly CadSketchMaterialRegion[];
};
export type CadPreparedSketchCatalog = CadPreparedSketchCells | CadPreparedSketchGraphCells;

const preparations = new WeakMap<CadSketchFeature, { values: readonly (number | undefined)[];
  catalogs: Partial<Record<CadSketchCellMode, CadPreparedSketchCatalog>> }>();

/** Reuse source geometry only; placement and complete history still validate separately. */
export function prepareCadSketchCells(sketch: CadSketchFeature, parameters: CadDocument['parameters']): CadPreparedSketchCells;
export function prepareCadSketchCells(sketch: CadSketchFeature, parameters: CadDocument['parameters'], mode: 'contours'): CadPreparedSketchCells;
export function prepareCadSketchCells(sketch: CadSketchFeature, parameters: CadDocument['parameters'], mode: 'graph-cells'): CadPreparedSketchGraphCells;
export function prepareCadSketchCells(sketch: CadSketchFeature, parameters: CadDocument['parameters'], mode: CadSketchCellMode): CadPreparedSketchCatalog;
export function prepareCadSketchCells(sketch: CadSketchFeature, parameters: CadDocument['parameters'], mode: CadSketchCellMode = 'contours'): CadPreparedSketchCatalog {
  function build(environment: CadDocument['parameters']): CadPreparedSketchCatalog {
    if (mode === 'contours') return resolveCells(sketch, environment);
    const graph = prepareCadSketchGraphCells(sketch, environment);
    return Object.freeze({ ...graph, resolve: (selection?: CadSketchRegionSelection) => isCadSketchGraphCellSelection(selection)
      ? graph.resolve(selection) : resolveCadSketchRegions(sketch, environment, selection) });
  }
  if (!isAcceptedCadSketchSource(sketch)) return build(parameters);
  // Own data is captured once for both key and geometry. Accessors and invalid values keep the
  // ordinary evaluator, without ever adopting their result.
  const reads = readCadSketchGeometryParameters(sketch, parameters);
  if (!reads) return build(parameters);
  const previous = preparations.get(sketch);
  const reusable = previous && sameCadSketchGeometryValues(reads.values, previous.values);
  const cached = reusable ? previous.catalogs[mode] : undefined;
  if (cached) return cached;
  const cells = build(reads.environment);
  for (const cell of cells.cells) {
    // Only newly resolved objects are frozen here. The profile is borrowed from
    // the already deeply frozen parser source; raw caller inputs stay untouched.
    deepFreezeCadData(cell.boundary.geometry); if ('point' in cell.boundary) Object.freeze(cell.boundary.point); Object.freeze(cell.boundary);
  }
  preparations.set(sketch, { values: reads.values, catalogs: { ...(reusable ? previous.catalogs : {}), [mode]: cells } });
  return cells;
}

/** One complete candidate preparation serves shading, hover, selection and union. */
function resolveCells(sketch: CadSketchFeature, parameters: CadDocument['parameters']): CadPreparedSketchCells {
  if (!cadFeatureActive(sketch, { parameters })) throw new CadError('suppressed-sketch', `Sketch "${sketch.name}" is suppressed. Resume it before choosing its areas.`);
  const contours = resolveCadSketchContours(sketch, parameters);
  const index = createCadSketchCellIndex(contours);
  const measurements = new Map<string, ReturnType<typeof measureCadResolvedProfile>>();
  function measurement(contour: CadResolvedSketchContour) {
    let value = measurements.get(contour.profile.id);
    if (!value) { value = measureCadResolvedProfile(contour.geometry); measurements.set(contour.profile.id, value); }
    return value;
  }
  const cells = contours.map((boundary, id) => {
    const outer = measurement(boundary);
    const voids = index.children.get(boundary.profile.id) ?? [];
    let areaMm2 = outer.areaMm2, boundaryLengthMm = outer.perimeterMm;
    for (const child of voids) { const inside = measurement(child); areaMm2 -= inside.areaMm2; boundaryLengthMm += inside.perimeterMm; }
    return Object.freeze({ id, name: boundary.profile.name, reference: index.reference(boundary.profile.id), boundary, voids: Object.freeze([...voids]),
      areaMm2, boundaryLengthMm, boundsMm: Object.freeze({ ...outer.boundsMm }), defaultMaterial: boundary.depth % 2 === 0 });
  }).sort((a, b) => a.reference.boundaryProfileId < b.reference.boundaryProfileId ? -1 : a.reference.boundaryProfileId > b.reference.boundaryProfileId ? 1 : 0);
  const pickOrder = [...cells].sort((a, b) => b.boundary.depth - a.boundary.depth);
  function pack(ids: readonly CadSketchCellId[]) {
    if (new Set(ids).size !== ids.length || ids.some(id => !Number.isSafeInteger(id) || !cells.some(cell => cell.id === id)))
      throw new CadError('invalid-sketch-cell-id', 'Choose unique current area locators from this prepared catalog.');
    return Object.freeze(cells.filter(cell => ids.includes(cell.id)).map(cell => cell.reference));
  }
  function selectedCellIds(selection?: CadSketchRegionSelection): readonly CadSketchCellId[] {
    if (isCadSketchGraphCellSelection(selection)) return [];
    if (selection === undefined) return Object.freeze(cells.filter(cell => cell.defaultMaterial).map(cell => cell.id));
    if (selection.length === 0) return [];
    selectCadSketchRegions(contours, selection);
    return Object.freeze(cells.filter(cell => selection.some(reference => reference.boundaryProfileId === cell.reference.boundaryProfileId)).map(cell => cell.id));
  }
  function resolve(selection?: readonly CadSketchCellReference[]): readonly CadSketchRegion[];
  function resolve(selection?: CadSketchRegionSelection): readonly CadSketchMaterialRegion[];
  function resolve(selection?: CadSketchRegionSelection): readonly CadSketchMaterialRegion[] { return isCadSketchGraphCellSelection(selection)
    ? resolveCadSketchRegions(sketch, parameters, selection) : selectCadSketchRegions(contours, selection); }
  return Object.freeze({ mode: 'contours', cells: Object.freeze(cells), pack, selectedCellIds,
    pick(point: DxfPoint) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
      for (const cell of pickOrder) {
        const bounds = cell.boundsMm;
        if (point.x >= bounds.minX && point.x <= bounds.maxX && point.y >= bounds.minY && point.y <= bounds.maxY
            && cell.boundary.containsPoint(point)) return cell;
      }
      return null;
    },
    resolve,
  });
}

export function cadSketchCellModeForAreas(sketch: CadSketchFeature, parameters: CadDocument['parameters'], selection?: CadSketchRegionSelection): CadSketchCellMode {
  if (isCadSketchGraphCellSelection(selection)) return 'graph-cells';
  if (sketch.graph && !sketch.profiles.some(profile => !profile.construction)) {
    try { const catalog = prepareCadSketchCells(sketch, parameters, 'graph-cells'); if (catalog.cells.length && catalog.hasIntersections) return 'graph-cells'; } catch { /* Old material remains independently available. */ }
  }
  return 'contours';
}

/** Numeric additions/overrides keep existing semantics; topology proposals never accept a replacement sketch. */
export type CadSketchRegionProposal =
  | { readonly sketch?: CadSketchFeature; readonly split?: never; readonly trim?: never; readonly extend?: never; readonly offset?: never; readonly mirror?: never; readonly generator?: never; readonly parameterValues?: CadDocument['parameters'] }
  | { readonly split: CadSketchSplitTarget; readonly sketch?: never; readonly trim?: never; readonly extend?: never; readonly offset?: never; readonly mirror?: never; readonly generator?: never; readonly parameterValues?: CadDocument['parameters'] }
  | { readonly trim: CadSketchTrimTarget; readonly sketch?: never; readonly split?: never; readonly extend?: never; readonly offset?: never; readonly mirror?: never; readonly generator?: never; readonly parameterValues?: CadDocument['parameters'] }
  | { readonly extend: CadSketchExtendTarget; readonly sketch?: never; readonly split?: never; readonly trim?: never; readonly offset?: never; readonly mirror?: never; readonly generator?: never; readonly parameterValues?: CadDocument['parameters'] }
  | { readonly offset: CadSketchOffsetRequest; readonly sketch?: never; readonly split?: never; readonly trim?: never; readonly extend?: never; readonly mirror?: never; readonly generator?: never; readonly parameterValues?: CadDocument['parameters'] }
  | { readonly mirror: CadSketchMirrorRequest; readonly sketch?: never; readonly split?: never; readonly trim?: never; readonly extend?: never; readonly offset?: never; readonly generator?: never; readonly parameterValues?: CadDocument['parameters'] }
  | { readonly generator: CadSketchGeneratorProposal; readonly sketch?: never; readonly split?: never; readonly trim?: never; readonly extend?: never; readonly offset?: never; readonly mirror?: never; readonly parameterValues?: CadDocument['parameters'] };
/** The fields of a set-sketch-generator edit after its kind and sketch: the complete record and the relations its regeneration removes. */
export interface CadSketchGeneratorProposal { readonly generator: CadSketchGenerator; readonly removedRelationIds?: readonly string[] }
export const CadSketchRegionProposalSchema = Type.Union([
  Type.Object({ sketch: Type.Optional(CadSketchFeatureSchema), parameterValues: Type.Optional(CadDocumentSchema.properties.parameters) }, { additionalProperties: false, minProperties: 1 }),
  Type.Object({ split: CadSketchSplitTargetSchema, parameterValues: Type.Optional(CadDocumentSchema.properties.parameters) }, { additionalProperties: false }),
  Type.Object({ trim: CadSketchTrimTargetSchema, parameterValues: Type.Optional(CadDocumentSchema.properties.parameters) }, { additionalProperties: false }),
  Type.Object({ extend: CadSketchExtendTargetSchema, parameterValues: Type.Optional(CadDocumentSchema.properties.parameters) }, { additionalProperties: false }),
  Type.Object({ offset: CadSketchOffsetRequestSchema, parameterValues: Type.Optional(CadDocumentSchema.properties.parameters) }, { additionalProperties: false }),
  Type.Object({ mirror: CadSketchMirrorRequestSchema, parameterValues: Type.Optional(CadDocumentSchema.properties.parameters) }, { additionalProperties: false }),
  Type.Object({ generator: Type.Object({ generator: CadSketchGeneratorSchema, removedRelationIds: CadSketchRemovedRelationIdsSchema }, { additionalProperties: false }),
    parameterValues: Type.Optional(CadDocumentSchema.properties.parameters) }, { additionalProperties: false })
]);
export function validateCadSketchRegionProposal(proposal: CadSketchRegionProposal): void {
  if (!isCadImportData(proposal) || !Value.Check(CadSketchRegionProposalSchema, proposal))
    throw new CadError('invalid-region-proposal', 'Propose a complete same-ID sketch, one exact split, one witnessed trim or extension, one detached loop offset, one mirror copy, or the fields of one set-sketch-generator edit, with optional numeric parameter values; parameter-only proposals are also supported.');
}

function activeSketch(document: CadDocument, sketchId: string, proposal?: CadSketchRegionProposal) {
  const validated = parseCadDocument(document);
  const index = validated.features.findIndex(feature => feature.id === sketchId);
  const sketch = validated.features[index];
  if (sketch?.kind !== 'sketch') throw new CadError('missing-sketch', 'Choose an existing sketch to inspect its closed regions.');
  if (!cadFeatureActive(sketch, validated)) throw new CadError('suppressed-sketch', `Sketch "${sketch.name}" is suppressed. Resume it before choosing its areas.`);
  if (proposal !== undefined) {
    validateCadSketchRegionProposal(proposal);
    if (proposal.sketch !== undefined && proposal.sketch.id !== sketchId)
      throw new CadError('invalid-region-proposal', 'The proposed sketch must keep the same requested sketch identity.');
    // Read only this complete source and its actual preceding datum dependency.
    // Other selected solids may intentionally need repair in the same later
    // atomic batch; validating them here would prevent inspecting fresh cells.
    const parameters = { ...validated.parameters, ...proposal.parameterValues };
    let source = proposal.sketch ?? sketch;
    if (proposal.split !== undefined) {
      if (!sketch.graph) throw new CadError('missing-sketch-graph', 'Choose an existing entity-based sketch.');
      source = { ...sketch, graph: splitCadSketchEntity({ graph: sketch.graph, parameters, split: proposal.split }).graph };
    } else if (proposal.trim !== undefined) {
      if (!sketch.graph) throw new CadError('missing-sketch-graph', 'Choose an existing entity-based sketch.');
      source = { ...sketch, graph: trimCadSketchEntity({ graph: sketch.graph, parameters, trim: proposal.trim }).graph };
    } else if (proposal.extend !== undefined) {
      if (!sketch.graph) throw new CadError('missing-sketch-graph', 'Choose an existing entity-based sketch.');
      source = { ...sketch, graph: extendCadSketchEntity({ graph: sketch.graph, parameters, extend: proposal.extend }).graph };
    } else if (proposal.offset !== undefined) {
      source = prepareCadSketchOffset({ sketch, parameters, ...proposal.offset }).sketch;
    } else if (proposal.mirror !== undefined) {
      source = prepareCadSketchMirror({ sketch, parameters, ...proposal.mirror }).sketch;
    } else if (proposal.generator !== undefined) {
      // Free geometry related to the members moves only when the edit is solved, so a generator proposal is read after its edit is
      // prepared, as a complete same-ID sketch (`prepareCadSketchRegionProposal`).
      throw new CadError('invalid-region-proposal', 'Prepare a generator proposal as its set-sketch-generator edit before reading its cells.');
    }
    const sourcePlane = source.plane;
    const requiredDatums = typeof sourcePlane === 'string' ? [] : validated.features.slice(0, index)
      .filter(feature => feature.kind === 'datum-plane' && feature.id === sourcePlane.featureId);
    const candidate = parseCadDocument({ ...validated, schemaVersion: source.graph ? 2 : validated.schemaVersion, parameters, features: [...requiredDatums, source] });
    const effective = candidate.features[candidate.features.length - 1];
    if (effective.kind !== 'sketch') throw new CadError('invalid-region-proposal', 'The proposed source must remain a sketch.');
    if (!cadFeatureActive(effective, candidate)) throw new CadError('suppressed-sketch', `Sketch "${effective.name}" is suppressed. Resume it before choosing its areas.`);
    return { sketch: effective, parameters: candidate.parameters };
  }
  return { sketch, parameters: validated.parameters };
}

export interface CadSketchCellInspection {
  readonly boundaryProfileId: string;
  readonly name: string;
  readonly kind: CadProfile['kind'];
  readonly depth: number;
  readonly defaultMaterial: boolean;
  readonly areaMm2: number;
  readonly boundaryLengthMm: number;
  readonly boundsMm: CadBounds2;
  readonly reference: CadSketchCellReference;
}
export interface CadSketchGraphCellInspection {
  readonly cellId: CadSketchCellId;
  readonly name: string;
  readonly areaMm2: number;
  readonly boundaryLengthMm: number;
  readonly boundsMm: CadBounds2;
}
type InspectionResult<Item> = { sketchId: string; proposed?: true; trimPreview?: ReturnType<typeof prepareCadSketchTrim>;
  extendPreview?: ReturnType<typeof prepareCadSketchExtend>; coordinateSystem: 'sketch-local'; units: 'mm';
  items: Item[]; total: number; nextOffset: number | null };
export const CadSketchRegionReadTargetSchema = Type.Union([
  CadSketchSplitTargetSchema.anyOf[0].properties.entityId,
  Type.Object({ cellIds: Type.Array(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), { minItems: 1, uniqueItems: true }) }, { additionalProperties: false })
]);
export type CadSketchRegionReadTarget = string | { readonly cellIds: readonly CadSketchCellId[] };

export const CadSketchTrimAtSchema = Type.Object({ entityId: CadSketchTrimTargetSchema.anyOf[0].properties.entityId,
  parameter: CadSketchTrimTargetSchema.anyOf[0].properties.parameter }, { additionalProperties: false });
export const CadSketchExtendAtSchema = Type.Object({ entityId: CadSketchExtendTargetSchema.properties.entityId,
  end: CadSketchExtendTargetSchema.properties.end }, { additionalProperties: false });
export type CadSketchRegionInspectionInput = { readonly offset?: number; readonly limit?: number; readonly mode?: CadSketchCellMode } & (
  | { readonly proposal?: CadSketchRegionProposal; readonly trimAt?: never; readonly extendAt?: never; readonly axes?: never }
  | { readonly trimAt: Readonly<Pick<CadSketchTrimTarget, 'entityId' | 'parameter'>>; readonly proposal?: never; readonly extendAt?: never; readonly axes?: readonly string[] }
  | { readonly extendAt: Readonly<Pick<CadSketchExtendTarget, 'entityId' | 'end'>>; readonly proposal?: never; readonly trimAt?: never; readonly axes?: readonly string[] }
);

/** The requested window is a read boundary, not an authored cell-count ceiling. */
export function inspectCadSketchRegions(document: CadDocument, sketchId: string, input?: CadSketchRegionInspectionInput & { readonly mode?: 'contours' }): InspectionResult<CadSketchCellInspection>;
export function inspectCadSketchRegions(document: CadDocument, sketchId: string, input: CadSketchRegionInspectionInput & { readonly mode: 'graph-cells' }): InspectionResult<CadSketchGraphCellInspection>;
export function inspectCadSketchRegions(document: CadDocument, sketchId: string, input: CadSketchRegionInspectionInput): InspectionResult<CadSketchCellInspection> | InspectionResult<CadSketchGraphCellInspection>;
export function inspectCadSketchRegions(document: CadDocument, sketchId: string, input: CadSketchRegionInspectionInput = {}): InspectionResult<CadSketchCellInspection> | InspectionResult<CadSketchGraphCellInspection> {
  const offset = input.offset ?? 0, limit = input.limit ?? 10;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1)
    throw new CadError('invalid-region-page', 'Region offset must be nonnegative and limit must be a positive integer.');
  if (input.mode !== undefined && input.mode !== 'contours' && input.mode !== 'graph-cells'
    || [input.proposal, input.trimAt, input.extendAt].filter(mode => mode !== undefined).length > 1
    || input.trimAt !== undefined && (!isCadImportData(input.trimAt) || !Value.Check(CadSketchTrimAtSchema, input.trimAt))
    || input.extendAt !== undefined && (!isCadImportData(input.extendAt) || !Value.Check(CadSketchExtendAtSchema, input.extendAt))
    // The axes named to cut at belong to a Trim or Extend query.
    || input.axes !== undefined && (input.trimAt === undefined && input.extendAt === undefined || !isCadImportData(input.axes) || !Value.Check(CadSketchCutAxesSchema, input.axes)))
    throw new CadError('invalid-region-proposal', 'Query one accepted Trim or Extend target separately from a proposed source.');
  const { sketch, parameters } = activeSketch(document, sketchId, input.proposal);
  const trimPreview = input.trimAt === undefined ? undefined : (() => {
    if (!sketch.graph) throw new CadError('missing-sketch-graph', 'Choose an existing entity-based sketch.');
    return prepareCadSketchTrim({ graph: sketch.graph, parameters, ...input.trimAt, axes: input.axes });
  })();
  const extendPreview = input.extendAt === undefined ? undefined : (() => {
    if (!sketch.graph) throw new CadError('missing-sketch-graph', 'Choose an existing entity-based sketch.');
    return prepareCadSketchExtend({ graph: sketch.graph, parameters, ...input.extendAt, axes: input.axes });
  })();
  const prepared = prepareCadSketchCells(sketch, parameters, input.mode ?? 'contours');
  const start = Math.min(offset, prepared.cells.length), end = start + Math.min(limit, prepared.cells.length - start);
  const common = { sketchId, ...(input.proposal === undefined ? {} : { proposed: true as const }), ...(trimPreview === undefined ? {} : { trimPreview }), ...(extendPreview === undefined ? {} : { extendPreview }), coordinateSystem: 'sketch-local' as const, units: 'mm' as const,
    total: prepared.cells.length, nextOffset: end < prepared.cells.length ? end : null };
  if (prepared.mode === 'graph-cells') return { ...common, items: prepared.cells.slice(start, end).map(cell => ({ cellId: cell.id, name: cell.name,
    areaMm2: cell.areaMm2, boundaryLengthMm: cell.boundaryLengthMm, boundsMm: cell.boundsMm })) };
  const items: CadSketchCellInspection[] = prepared.cells.slice(start, end).map(cell => ({ boundaryProfileId: cell.reference.boundaryProfileId,
    name: cell.boundary.profile.name, kind: cell.boundary.profile.geometry.kind, depth: cell.boundary.depth,
    defaultMaterial: cell.defaultMaterial, areaMm2: cell.areaMm2, boundaryLengthMm: cell.boundaryLengthMm, boundsMm: cell.boundsMm, reference: cell.reference }));
  return { ...common, items };
}

/** Obtain only one complete signature for exact chunked tool reads. */
export function readCadSketchRegionReference(document: CadDocument, sketchId: string, target: string, proposal?: CadSketchRegionProposal): CadSketchCellReference;
export function readCadSketchRegionReference(document: CadDocument, sketchId: string, target: { readonly cellIds: readonly CadSketchCellId[] }, proposal?: CadSketchRegionProposal): import('./cadSketchRegionSelection').CadSketchGraphCellSelection;
export function readCadSketchRegionReference(document: CadDocument, sketchId: string, target: CadSketchRegionReadTarget, proposal?: CadSketchRegionProposal): CadSketchCellReference | import('./cadSketchRegionSelection').CadSketchGraphCellSelection;
export function readCadSketchRegionReference(document: CadDocument, sketchId: string, target: CadSketchRegionReadTarget, proposal?: CadSketchRegionProposal): CadSketchCellReference | import('./cadSketchRegionSelection').CadSketchGraphCellSelection {
  if (!isCadImportData(target) || !Value.Check(CadSketchRegionReadTargetSchema, target)) throw new CadError('invalid-region-read-target', 'Read one boundary ID or unique current graph cell locators.');
  const captured = typeof target === 'string' ? target : { cellIds: [...target.cellIds] };
  const { sketch, parameters } = activeSketch(document, sketchId, proposal);
  return typeof captured === 'string' ? createCadSketchCellIndex(resolveCadSketchContours(sketch, parameters)).reference(captured)
    : prepareCadSketchCells(sketch, parameters, 'graph-cells').pack(captured.cellIds);
}
