import type { DxfEntity } from '@/domain/dxf/types';
import { cadFeatureActive } from './features/cadFeatureActivity';
import { dxfUnitsFromInsunitsCode } from '@/domain/dxf/parseDxf';
import { createPathPlanningDocumentFromDxfEntities } from '@/domain/path-intel/fromDxfEntities';
import type { PathPlanningDocument } from '@/domain/path-intel/types';
import type { CadDocument, CadSketchFeature } from './cadDocument';
import { CadError } from './cadError';
import { parseCadDocument } from './cadSchema';
import { cadSketchToEntities } from './cadSketchGeometry';
import { cadEntitiesToDxf } from './cadDxfExport';
import { CAD_PRECISION } from '@/domain/precision/cadPrecision';

/** What a sketch's contours are for, which its refusals name: sending it to CAM or writing it as DXF. */
const SKETCH_PURPOSE = {
  cam: { missing: 'Choose an existing sketch for CAM.', inactive: 'A suppressed sketch cannot be transferred to CAM.', empty: 'Sketch needs at least one non-construction contour for CAM.' },
  dxf: { missing: 'Choose an existing sketch for DXF export.', inactive: 'Unsuppress the sketch before exporting it as DXF.', empty: 'Sketch needs at least one non-construction contour for DXF export.' }
} as const;

function entitiesForSketch(document: CadDocument, sketchId: string, purpose: keyof typeof SKETCH_PURPOSE): DxfEntity[] {
  parseCadDocument(document);
  const sketch = document.features.find(feature => feature.id === sketchId), words = SKETCH_PURPOSE[purpose];
  if (sketch?.kind !== 'sketch') throw new CadError('missing-sketch', words.missing);
  if (!cadFeatureActive(sketch, document)) throw new CadError('suppressed-sketch', words.inactive);
  const entities = cadSketchToEntities(sketch, document.parameters);
  if (entities.length === 0) throw new CadError('empty-sketch', words.empty);
  return entities;
}

/** Sketch-local millimetres, independent of its XY/XZ/YZ display plane and offset. */
export function cadSketchToCam(document: CadDocument, sketchId: string): PathPlanningDocument {
  const result = cadEntitiesToCam(entitiesForSketch(document, sketchId, 'cam'));
  const sketch = document.features.find(feature => feature.id === sketchId);
  if (sketch?.kind !== 'sketch') return result;
  return appendPluginNotes(result, [sketch]);
}

function appendPluginNotes(result: PathPlanningDocument, sketches: readonly CadSketchFeature[]) {
  const seen = new Set<string>();
  for (const sketch of sketches) for (const profile of sketch.profiles) {
    if (profile.construction || profile.geometry.kind !== 'plugin' || !profile.geometry.package.notes) continue;
    const plugin = profile.geometry.package, key = `${plugin.id}@${plugin.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.diagnostics.push({ id: `cad_plugin_import_${seen.size}`, severity: 'warning', code: 'dxf-import-warning',
      message: `${plugin.name} v${plugin.version}: ${plugin.notes}` });
  }
  return result;
}

/** Shared analytic handoff for sketches and validated exact-kernel planar sections. */
export function cadEntitiesToCam(entities: readonly DxfEntity[], sourceDocument?: CadDocument): PathPlanningDocument {
  if (entities.length === 0 || entities.some(entity => entity.type === 'polyline' || entity.type === 'lwpolyline')) throw new CadError('cam-geometry', 'CAD handoff requires complete analytic line, arc or circle entities.');
  const units = dxfUnitsFromInsunitsCode(4);
  const result = createPathPlanningDocumentFromDxfEntities([...entities], { endpointTolerance: CAD_PRECISION.camHandoffEndpointMm, coincidenceEpsilon: CAD_PRECISION.camHandoffCoincidenceMm }, {
    units, unitDeclaration: { status: 'recognized', units }, coordinateScaleToMillimeters: 1,
    appliedUnits: { label: units.label, scaleToMillimeters: 1, basis: 'dxf-declared', confirmed: true }
  });
  if (result.segments.length !== entities.length || result.diagnostics.some(diagnostic => diagnostic.severity === 'error') || result.contours.some(contour => !contour.closed)) throw new CadError('cam-geometry', 'Sketch could not form clean closed CAM contours without changing its analytic geometry.');
  // A final-solid section may include modified plugin geometry. Preserve the active
  // document's approximation notes rather than implying those curves became exact.
  return sourceDocument ? appendPluginNotes(result, sourceDocument.features.flatMap(feature => feature.kind === 'sketch' && cadFeatureActive(feature, sourceDocument) ? [feature] : [])) : result;
}

/** Portable ASCII DXF with an explicit millimetre unit declaration and exact analytic arcs. */
export function cadSketchToDxf(document: CadDocument, sketchId: string): string {
  const entities = entitiesForSketch(document, sketchId, 'dxf');
  const sketch = document.features.find(feature => feature.id === sketchId);
  const notes = sketch?.kind === 'sketch' ? sketch.profiles.flatMap(profile => {
    if (profile.construction || profile.geometry.kind !== 'plugin') return [];
    const plugin = profile.geometry.package;
    return [`${plugin.id}@${plugin.version}: ${plugin.notes}`];
  }) : [];
  return cadEntitiesToDxf(entities, notes);
}
