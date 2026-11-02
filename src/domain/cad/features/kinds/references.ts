import { Type } from '@sinclair/typebox';
import type { CadDatumPlaneFeature, CadPathSegment, CadSketchPlane, CadSketchProfile } from '../../cadDocument';
import { CadError } from '../../cadError';
import { CadProfileSchema } from '../../cadProfileSchema';
import { CadIdentifierSchema, CadLabelSchema, CadPathSegmentSchema, CadPlaneSchema, CadScalarSchema, CadSketchPlaneSchema } from '../../cadPrimitives';
import { CadDxfImportSourceSchema, parseCadDxfImportSource } from '../../cadDxfSource';
import { CadSketchDimensionConstraintSchema, validateCadSketchConstraints } from '../../cadSketchConstraints';
import { CadSketchGraphSchema, type CadSketchGraph } from '../../cadSketchGraph';
import { expandCadSketchGenerators } from '../../sketch-generators/cadSketchGenerators';
import { assertCadSketchExternalReferences } from '../../cadSketchExternalReferences';
import { resolveCadSketchPlacement, resolveCadWorldDatum } from '../../cadDatumPlanes';
import { resolveCadCurveGeometry } from '../../cadCurve';
import type { CadFeatureDefinition } from '../cadFeatureDefinitionTypes';
import { cadFeatureField, cadFeatureScalarField, cadFeatureShape } from '../cadFeatureFields';
import { CAD_PATH_SEGMENT_QUANTITIES, CAD_PROFILE_QUANTITIES, cadQuantitiesUnder, cadSketchGraphQuantities, mapCadPathSegments, mapCadPoint3, mapCadProfileScalars,
  mapCadSketchGraphScalars } from '../cadFeatureScalarMaps';

const strict = { additionalProperties: false };
export { CadProfileSchema };

export const CadSketchProfileSchema = Type.Object({ id: CadIdentifierSchema, name: CadLabelSchema, construction: Type.Boolean(),
  role: Type.Optional(Type.Union([Type.Literal('outer'), Type.Literal('hole')])), geometry: CadProfileSchema,
  constraints: Type.Optional(Type.Array(CadSketchDimensionConstraintSchema, { maxItems: 6 })) }, strict);

/** The plane a sketch or curve is drawn on: a principal plane, or a preceding datum plane it names. */
const support = cadFeatureField<typeof CadSketchPlaneSchema, CadSketchPlane>(CadSketchPlaneSchema, {
  slot: { role: 'support', accepts: ['plane'], count: 'optional', ids: plane => typeof plane === 'string' ? [] : [plane.featureId] } });
const offset = cadFeatureScalarField({ quantity: 'length' });
const importSource = cadFeatureField(Type.Optional(CadDxfImportSourceSchema));
const point3 = Type.Tuple([CadScalarSchema, CadScalarSchema, CadScalarSchema]);

const worldDefinition = Type.Object({ kind: Type.Literal('world'), basePlane: CadPlaneSchema, origin: point3, rotation: point3 }, strict);
const datumPlaneShape = cadFeatureShape(Type.Literal('datum-plane'), {
  // World origin in millimetres and rotation in degrees.
  definition: cadFeatureField<typeof worldDefinition, CadDatumPlaneFeature['definition']>(worldDefinition, {
    scalars: (definition, path, map) => ({ ...definition, origin: mapCadPoint3(definition.origin, `${path}.origin`, map), rotation: mapCadPoint3(definition.rotation, `${path}.rotation`, map) }),
    quantities: [{ path: '{world}.origin.*', quantity: 'length' }, { path: '{world}.rotation.*', quantity: 'angle' }] })
});
export const CadDatumPlaneFeatureSchema = datumPlaneShape.schema;

export const datumPlane = {
  kind: 'datum-plane', family: 'reference', ...datumPlaneShape,
  outputs: ['plane'], body: 'none', suppression: 'no-output', evaluator: { owner: 'domain', version: 1 },
  diagnostics: ['invalid-datum-plane', 'invalid-plane', 'unsupported-datum-frame'],
  check(feature, context) {
    const resolved = resolveCadWorldDatum(feature, context.document.parameters);
    if (context.active) context.addDatumFrame(feature.id, resolved);
  }
} satisfies CadFeatureDefinition<'datum-plane'>;

const sketchProfiles = Type.Array(CadSketchProfileSchema);
const optionalGraph = Type.Optional(CadSketchGraphSchema);
const sketchShape = cadFeatureShape(Type.Literal('sketch'), {
  plane: support,
  offset,
  profiles: cadFeatureField<typeof sketchProfiles, readonly CadSketchProfile[]>(sketchProfiles, {
    scalars: (profiles, path, map) => profiles.map((profile, index) => ({ ...profile, geometry: mapCadProfileScalars(profile.geometry, `${path}.${index}.geometry`, map) })),
    quantities: cadQuantitiesUnder('*.geometry', CAD_PROFILE_QUANTITIES) }),
  source: importSource,
  graph: cadFeatureField<typeof optionalGraph, CadSketchGraph>(optionalGraph, {
    // Another sketch whose entities this one uses as read-only references.
    slot: { role: 'linked', accepts: ['sketch'], count: 'many',
      ids: graph => [...new Set(graph.relations.flatMap(relation => relation.kind === 'external-reference' ? [relation.sourceSketchId] : []))] },
    scalars: mapCadSketchGraphScalars, quantities: cadSketchGraphQuantities })
});
export const CadSketchFeatureSchema = sketchShape.schema;

export const sketch = {
  kind: 'sketch', family: 'reference', ...sketchShape,
  outputs: ['sketch'], body: 'none', suppression: 'no-output', evaluator: { owner: 'domain', version: 1 },
  diagnostics: [
    // Format, ids and profiles.
    'unsupported-sketch-format', 'reserved-sketch-id', 'duplicate-sketch-id', 'duplicate-sketch-constraint', 'invalid-dimension', 'invalid-profile', 'invalid-profile-role',
    'open-profile', 'profile-intersection', 'self-intersection', 'invalid-radius', 'invalid-distance', 'invalid-corner-geometry', 'invalid-corner-topology',
    'invalid-gear', 'invalid-plugin', 'invalid-plugin-inputs', 'invalid-plugin-rules', 'plugin-limit', 'plugin-size', 'invalid-dxf-source',
    // The graph: its entities, relations, solution and annotations.
    'invalid-sketch-graph', 'invalid-sketch-graph-geometry', 'sketch-graph-precision', 'missing-sketch-entity', 'missing-sketch-point', 'invalid-sketch-cycle',
    'non-canonical-sketch-relation', 'fixed-sketch-relation', 'overconstrained-sketch-dimension', 'already-driven-sketch-radius',
    'unsupported-sketch-dimension', 'unsupported-sketch-operand', 'invalid-sketch-operand', 'invalid-sketch-angle', 'invalid-sketch-angle-ray',
    'invalid-sketch-line-pair', 'invalid-sketch-midpoint', 'invalid-sketch-pattern', 'owned-sketch-pattern', 'invalid-sketch-generator', 'owned-sketch-generator', 'stale-sketch-generator', 'invalid-sketch-point-line-distance',
    'invalid-sketch-point-on-curve', 'invalid-sketch-point-on-line', 'invalid-sketch-radial-entity', 'invalid-sketch-radius-pair',
    'invalid-sketch-reference-dimension', 'invalid-sketch-symmetry', 'invalid-sketch-tangent', 'invalid-sketch-tangent-joint', 'invalid-sketch-annotation',
    // Its regions.
    'invalid-region-selection', 'stale-sketch-region', 'invalid-sketch-cells', 'invalid-sketch-cell-id', 'unsupported-sketch-cells',
    // References to the geometry of other features, and its placement.
    'invalid-sketch-reference', 'unavailable-sketch-reference', 'stale-sketch-reference', 'changed-sketch-reference', 'invalid-plane', 'unavailable-datum-plane',
    'unsupported-datum-frame'],
  check(feature, context) {
    const { document } = context;
    context.scalar(feature, 'offset');
    if (feature.graph) {
      if (document.schemaVersion !== 2) throw new CadError('unsupported-sketch-format', 'Stable sketch entities require CAD schema 2. Preserve the schema 1 original when saving an upgrade.');
      // Keep the parser's accepted graph, with its generators' members, so later parses of it are free. An accepted feature
      // is frozen and holds its accepted graph already, whose members a parse with other parameters must not find stale.
      const graph = expandCadSketchGenerators(feature.graph, document.parameters);
      if (graph !== feature.graph) (feature as { graph: CadSketchGraph }).graph = graph;
      assertCadSketchExternalReferences({ sketch: feature, parameters: document.parameters, previous: context.previous });
    }
    if (feature.source) parseCadDxfImportSource(feature.source);
    const ids = new Set<string>();
    const dimensionIds = new Set<string>();
    for (const profile of feature.profiles) {
      if (ids.has(profile.id)) throw new CadError('duplicate-id', `Duplicate profile ID "${profile.id}" in sketch "${feature.name}".`);
      ids.add(profile.id);
      validateCadSketchConstraints(profile);
      for (const constraint of profile.constraints ?? []) {
        if (dimensionIds.has(constraint.id)) throw new CadError('duplicate-sketch-constraint', 'Sketch dimension IDs must be unique within their sketch.');
        dimensionIds.add(constraint.id);
      }
    }
    context.checkSketchGeometry(feature);
    if (context.active) resolveCadSketchPlacement(feature, document.parameters, context.datums);
  }
} satisfies CadFeatureDefinition<'sketch'>;

const curveSegments = Type.Array(CadPathSegmentSchema, { minItems: 1 });
const curveShape = cadFeatureShape(Type.Literal('curve'), {
  plane: support,
  offset,
  segments: cadFeatureField<typeof curveSegments, readonly CadPathSegment[]>(curveSegments, { scalars: mapCadPathSegments,
    quantities: cadQuantitiesUnder('*', CAD_PATH_SEGMENT_QUANTITIES) }),
  source: importSource
});
export const CadCurveFeatureSchema = curveShape.schema;

export const curve = {
  kind: 'curve', family: 'reference', ...curveShape,
  outputs: ['curve'], body: 'none', suppression: 'no-output', evaluator: { owner: 'domain', version: 1 },
  diagnostics: ['invalid-curve', 'closed-curve', 'disconnected-curve', 'self-intersection', 'invalid-profile', 'invalid-dxf-source', 'invalid-plane',
    'unavailable-datum-plane', 'unsupported-datum-frame'],
  check(feature, context) {
    resolveCadCurveGeometry(feature, context.document.parameters);
    if (context.active) resolveCadSketchPlacement(feature, context.document.parameters, context.datums);
  }
} satisfies CadFeatureDefinition<'curve'>;
