import { Type } from '@sinclair/typebox';
import { cadFeatureSuppressionFlag } from './features/cadFeatureActivity';
import { Value } from '@sinclair/typebox/value';
import { dxfUnitsFromInsunitsCode, parseDxf, splitDxfLines } from '@/domain/dxf/parseDxf';
import type { DxfUnitDeclaration } from '@/domain/dxf/types';
import { pathSegmentsFromDxfEntities } from '@/domain/path-intel/fromDxfEntities';
import { clusterSegmentEndpoints } from '@/domain/path-intel/endpointClusters';
import { buildChains } from '@/domain/path-intel/chains';
import { createArcSegment, createCircleSegment, createLineSegment } from '@/domain/path-intel/segments';
import type { PathSegment, Point2 } from '@/domain/path-intel/types';
import type { CadPathSegment, CadProfile, CadSketchFeature } from './cadDocument';
import { CadError } from './cadError';
import { CadDxfImportSourceSchema, CadDxfUnitsSchema, parseCadDxfImportSource, type CadDxfUnits } from './cadDxfSource';
import { CadFeatureSchema, createCadDocument, parseCadDocument } from './cadSchema';
import { cadPathClosureTolerance, checkCadSketchShapesApart } from './cadSketchGeometry';
import type { CadSketchGenerator } from './cadSketchGraph';
import { isCadImportData } from './cadImportData';
import { storedCadSketchGraph } from './sketch-generators/cadSketchGenerators';

export interface CadDxfImportInput {
  readonly fileName: string; readonly text: string; readonly units?: CadDxfUnits;
  readonly sketchId?: string; readonly name?: string;
}
/**
 * A DXF imported as a sketch: each closed contour is a path or circle generator `contour_<n>`, stored alone, which a parse expands to
 * its lines, arcs and circle. The sketch holds no saved profile and no geometry of its own.
 */
export interface CadDxfImportResult {
  readonly sketch: CadSketchFeature; readonly unitDeclaration: DxfUnitDeclaration;
  readonly scaleToMillimeters: number; readonly sourceEntityCount: number; readonly contourCount: number;
}
const scales: Readonly<Record<CadDxfUnits, number>> = { mm: 1, inch: 25.4, cm: 10, m: 1000 };
const strict = { additionalProperties: false };
export const CadDxfImportInputSchema = Type.Object({ fileName: CadDxfImportSourceSchema.properties.fileName, text: CadDxfImportSourceSchema.properties.text,
  units: Type.Optional(CadDxfUnitsSchema), sketchId: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$' })),
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 160, pattern: '\\S' })) }, strict);
const drawingUnits = Type.Object({ source: Type.Literal('dxf-insunits'), code: Type.Integer(), label: Type.String({ minLength: 1, maxLength: 160 }),
  scaleToMillimeters: Type.Union([Type.Number({ exclusiveMinimum: 0 }), Type.Null()]) }, strict);
const unitDeclarationSchema = Type.Union([
  Type.Object({ status: Type.Literal('missing') }, strict),
  Type.Object({ status: Type.Literal('malformed'), rawValue: Type.Union([Type.String(), Type.Null()]) }, strict),
  Type.Object({ status: Type.Union([Type.Literal('recognized'), Type.Literal('unknown'), Type.Literal('unitless')]), units: drawingUnits }, strict)
]);
const resultSchema = Type.Object({ sketch: CadFeatureSchema, unitDeclaration: unitDeclarationSchema,
  scaleToMillimeters: Type.Number({ exclusiveMinimum: 0 }), sourceEntityCount: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  contourCount: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) }, strict);

export function parseCadDxfImportInput(value: unknown): CadDxfImportInput {
  if (!isCadImportData(value) || !Value.Check(CadDxfImportInputSchema, value)) throw new CadError('invalid-dxf-source', 'Provide DXF filename, exact text and optional units, sketch ID and name.');
  const source = parseCadDxfImportSource({ format: 'dxf', fileName: value.fileName, text: value.text, ...(value.units === undefined ? {} : { units: value.units }) });
  return Object.freeze({ fileName: source.fileName, text: source.text, ...(source.units === undefined ? {} : { units: source.units }),
    ...(value.sketchId === undefined ? {} : { sketchId: value.sketchId }), ...(value.name === undefined ? {} : { name: value.name }) });
}

/** Validate detached worker data and units without reparsing the original DXF. */
export function isCadDxfImportResult(value: unknown): value is CadDxfImportResult {
  try {
    if (!isCadImportData(value) || !Value.Check(resultSchema, value) || value.sketch.kind !== 'sketch' || !value.sketch.source
      || value.sketch.plane !== 'XY' || value.sketch.offset !== 0 || cadFeatureSuppressionFlag(value.sketch) || value.sketch.profiles.length || !value.sketch.graph
      || value.sketch.graph.points.length || value.sketch.graph.entities.length || value.contourCount !== value.sketch.graph.relations.length
      || value.sketch.graph.relations.some(relation => relation.kind !== 'generator' || relation.construction
        || (relation.geometry.kind !== 'path' && relation.geometry.kind !== 'circle'))) return false;
    const source = parseCadDxfImportSource(value.sketch.source);
    const declaration = value.unitDeclaration;
    let declared: number | null = null;
    if ('units' in declaration) {
      const canonical = dxfUnitsFromInsunitsCode(declaration.units.code);
      if (canonical.label !== declaration.units.label || canonical.scaleToMillimeters !== declaration.units.scaleToMillimeters
        || declaration.status !== (canonical.code === 0 ? 'unitless' : canonical.scaleToMillimeters === null ? 'unknown' : 'recognized')) return false;
      declared = declaration.status === 'recognized' ? canonical.scaleToMillimeters : null;
    }
    const chosen = source.units === undefined ? null : scales[source.units];
    if (declared !== null && chosen !== null && declared !== chosen || (declared ?? chosen) !== value.scaleToMillimeters) return false;
    parseCadDocument({ ...createCadDocument('Imported DXF', 'cad_import_validation'), schemaVersion: 2, features: [value.sketch] });
    return true;
  } catch { return false; }
}

/** The shared parser is intentionally tolerant; CAD authoring requires a complete file. */
export function assertCompleteCadDxf(text: string): void {
  const lines = splitDxfLines(text.replace(/^\uFEFF/, ''));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (lines.length % 2 !== 0) throw new CadError('dxf-incomplete', 'DXF group-code/value pairs are incomplete. Preserve the original file.');
  let section: string | null = null; let entitiesSections = 0; let eof = false; let entity: string | null = null;
  const spatialEntities = new Set(['LINE', 'ARC', 'CIRCLE', 'LWPOLYLINE', 'POLYLINE', 'VERTEX', 'INSERT', 'BLOCK']);
  for (let index = 0; index < lines.length; index += 2) {
    if (!/^\s*\d+\s*$/.test(lines[index])) throw new CadError('dxf-incomplete', 'DXF contains a malformed group-code pair.');
    const code = Number(lines[index]);
    if ((section === 'ENTITIES' || section === 'BLOCKS') && entity !== null && spatialEntities.has(entity) && [30, 31, 32, 38, 39].includes(code)) {
      const raw = lines[index + 1].trim(); const z = Number(raw);
      if (!raw || !Number.isFinite(z) || z !== 0) throw new CadError('dxf-unsupported-3d', 'CAD DXF imports require geometry in the XY plane at Z=0 with zero thickness. Nonzero elevations and block insertion heights require an explicit plane transform.');
    }
    if (code !== 0) continue;
    const value = lines[index + 1].trim().toUpperCase();
    entity = value;
    if (value === 'SECTION') {
      if (section !== null || eof || Number(lines[index + 2]) !== 2 || !lines[index + 3]?.trim()) throw new CadError('dxf-incomplete', 'DXF sections are malformed or incomplete.');
      section = lines[index + 3].trim().toUpperCase();
      if (section === 'ENTITIES') entitiesSections++;
    } else if (value === 'ENDSEC') {
      if (section === null) throw new CadError('dxf-incomplete', 'DXF contains an unmatched section ending.');
      section = null; entity = null;
    } else if (value === 'EOF') {
      if (section !== null || index + 2 !== lines.length) throw new CadError('dxf-incomplete', 'DXF ends inside a section or contains trailing data.');
      eof = true;
    }
  }
  if (!eof || section !== null || entitiesSections !== 1) throw new CadError('dxf-incomplete', 'Provide one complete ENTITIES section and an EOF marker.');
}

/** Exact editable XY geometry. Reuses curve/chain math without constructing CAM plans. */
export function importCadDxfSketch(input: CadDxfImportInput): CadDxfImportResult {
  input = parseCadDxfImportInput(input);
  const source = parseCadDxfImportSource({ format: 'dxf', fileName: input.fileName, text: input.text, ...(input.units !== undefined ? { units: input.units } : {}) });
  assertCompleteCadDxf(source.text);
  const parsed = parseDxf(source.text, { mode: 'exact-cad' });
  if (parsed.unsupportedEntities.length || parsed.warnings.length || parsed.entities.some(entity => entity.type === 'line' && entity.approximation)) {
    throw new CadError('dxf-inexact', 'DXF contains unsupported, omitted or approximated geometry. CAD requires complete exact lines, circular arcs and circles.');
  }
  const declared = parsed.unitDeclaration.status === 'recognized' ? parsed.unitDeclaration.units.scaleToMillimeters : null;
  const chosen = source.units ? scales[source.units] : null;
  if (declared !== null && chosen !== null && declared !== chosen) throw new CadError('dxf-units-conflict', 'Explicit units conflict with the DXF declaration. Use the declared units or correct the original file.');
  const scaleToMillimeters = declared ?? chosen;
  if (scaleToMillimeters === null || !Number.isFinite(scaleToMillimeters) || scaleToMillimeters <= 0) throw new CadError('dxf-units-required', 'DXF does not declare recognized length units. Choose mm, inch, cm or m explicitly.');
  const built = pathSegmentsFromDxfEntities(parsed.entities, { endpointTolerance: 0, coincidenceEpsilon: 0 });
  if (built.diagnostics.length || built.segments.some(segment => !segment.source.exact)) throw new CadError('dxf-inexact', 'DXF cannot be imported without discarding or approximating a segment.');
  if (!built.segments.length) throw new CadError('dxf-empty', 'DXF has no closed sketch geometry.');
  const scaled = (point: Point2): Point2 => ({ x: point.x * scaleToMillimeters, y: point.y * scaleToMillimeters });
  const segments: PathSegment[] = built.segments.map(segment => {
    const common = { id: segment.id, source: segment.source };
    if (segment.kind === 'circle') return createCircleSegment({ ...common, center: scaled(segment.center), radius: segment.radius * scaleToMillimeters });
    if (segment.kind === 'line') return createLineSegment({ ...common, start: scaled(segment.start), end: scaled(segment.end) });
    return createArcSegment({ ...common, start: scaled(segment.start), end: scaled(segment.end), center: scaled(segment.center),
      radius: segment.radius * scaleToMillimeters, sweepRadians: segment.sweepRadians, clockwise: segment.clockwise });
  });
  const roundoff = cadPathClosureTolerance(segments.flatMap(segment => [segment.start, segment.end]));
  const options = { endpointTolerance: 0, coincidenceEpsilon: roundoff };
  const clusters = clusterSegmentEndpoints(segments, options);
  const chains = buildChains(segments, clusters, options);
  if (clusters.diagnostics.length || chains.diagnostics.length || chains.chains.some(chain => !chain.closed)
    || chains.chains.reduce((total, chain) => total + chain.segmentRefs.length, 0) !== segments.length) {
    throw new CadError('dxf-open-contour', 'DXF must contain closed, unbranched contours without bridging or repairing gaps.');
  }
  const byId = new Map(segments.map(segment => [segment.id, segment]));
  const contours = chains.chains.map((chain, index): CadSketchGenerator => {
    const first = byId.get(chain.segmentRefs[0]?.segmentId);
    if (!first) throw new CadError('dxf-inexact', 'A DXF contour references missing geometry.');
    let geometry: CadProfile;
    if (chain.segmentRefs.length === 1 && first.kind === 'circle') geometry = { kind: 'circle', x: first.center.x, y: first.center.y, radius: first.radius };
    else {
      const path: CadPathSegment[] = chain.segmentRefs.map(reference => {
        const segment = byId.get(reference.segmentId);
        if (!segment || segment.kind === 'circle') throw new CadError('dxf-inexact', 'A circle cannot be mixed into an open contour chain.');
        if (segment.kind === 'line') {
          const start = reference.reversed ? segment.end : segment.start; const end = reference.reversed ? segment.start : segment.end;
          return { kind: 'line', start: [start.x, start.y], end: [end.x, end.y] };
        }
        const original = parsed.entities[segment.source.sourceEntityIndex];
        const originalAngle = original?.type === 'arc' ? original.startAngle * Math.PI / 180 : segment.startAngleRadians;
        return { kind: 'arc', center: [segment.center.x, segment.center.y], radius: segment.radius,
          startAngle: (reference.reversed ? originalAngle + segment.sweepRadians : originalAngle) * 180 / Math.PI,
          sweep: (reference.reversed ? -segment.sweepRadians : segment.sweepRadians) * 180 / Math.PI };
      });
      geometry = { kind: 'path', segments: path };
    }
    return { id: `contour_${index + 1}`, kind: 'generator', idPrefix: `contour-${index + 1}`, name: `Contour ${index + 1}`, construction: false, geometry };
  });
  // Each contour stays whole and apart from the others, as one closed region boundary.
  checkCadSketchShapesApart(contours.map(contour => ({ name: contour.name!, geometry: contour.geometry as CadProfile })));
  const sketch: CadSketchFeature = { kind: 'sketch', id: input.sketchId ?? `sketch_${crypto.randomUUID()}`, name: input.name ?? (source.fileName.replace(/\.dxf$/i, '').trim().slice(0, 160) || 'Imported sketch'),
    suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: { points: [], entities: [], relations: contours }, source };
  const validated = parseCadDocument({ ...createCadDocument(sketch.name), schemaVersion: 2, features: [sketch] }).features[0];
  if (validated.kind !== 'sketch' || !validated.graph) throw new CadError('dxf-inexact', 'The DXF import did not produce a sketch.');
  return { sketch: { ...validated, graph: storedCadSketchGraph(validated.graph) }, unitDeclaration: parsed.unitDeclaration, scaleToMillimeters,
    sourceEntityCount: parsed.entities.length, contourCount: contours.length };
}
