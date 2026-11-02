import { Type } from '@sinclair/typebox';
import type { CadEdgeSelection, CadFaceQuery } from '../../cadTopology';
import { CadEdgeSelectionSchema, CadFaceQuerySchema, resolveCadEdgeSelection, validateCadShellOpening } from '../../cadTopology';
import type { CadRefusalCode } from '../../cadIssueCodes';
import { CAD_PRECISION } from '../../../precision/cadPrecision';
import type { CadFeatureCheckContext, CadFeatureDefinition, CadFeatureOf } from '../cadFeatureDefinitionTypes';
import { cadFeatureField, cadFeatureScalarField, cadFeatureShape } from '../cadFeatureFields';
import { CAD_EDGE_SELECTION_QUANTITIES, CAD_FACE_QUERY_QUANTITIES, mapCadEdgeSelectionScalars, mapCadFaceQueryScalars } from '../cadFeatureScalarMaps';
import { cadTargetBodyField } from './solidFields';

const positiveLength = { quantity: 'length', min: CAD_PRECISION.minimumLengthMm, exclusiveMin: true, max: CAD_PRECISION.modelExtentMm } as const;
const edgeSelection = Type.Optional(Type.Union([CadEdgeSelectionSchema, Type.Null()]));

// Fillet and chamfer store one shape, whose kind is either.
const edgeTreatmentShape = cadFeatureShape(Type.Union([Type.Literal('fillet'), Type.Literal('chamfer')]), {
  targetId: cadTargetBodyField,
  // A chamfer's distance.
  radius: cadFeatureScalarField({ ...positiveLength, refusal: 'Edge radius must be positive and within one million millimetres.' }),
  // Absent or null: every edge of the target.
  selection: cadFeatureField<typeof edgeSelection, CadEdgeSelection>(edgeSelection, { scalars: mapCadEdgeSelectionScalars, quantities: CAD_EDGE_SELECTION_QUANTITIES }),
  tangentPropagation: cadFeatureField(Type.Optional(Type.Boolean()))
});

function checkEdgeTreatment(feature: CadFeatureOf<'fillet' | 'chamfer'>, context: CadFeatureCheckContext) {
  context.scalar(feature, 'radius');
  if (feature.selection) resolveCadEdgeSelection(feature.selection, context.document.parameters);
}
const edgeTreatmentDiagnostics: readonly CadRefusalCode[] = ['invalid-selector', 'invalid-selector-dimension', 'invalid-direction', 'selection-empty', 'selection-count-mismatch',
  'selection-tangent-chain', 'unsupported-selection', 'invalid-dimension', 'missing-body'];

export const fillet = {
  kind: 'fillet', family: 'dress-up', ...edgeTreatmentShape,
  outputs: ['body'], body: 'modify-target', suppression: 'pass-through', evaluator: { owner: 'kernel', version: 1 },
  diagnostics: edgeTreatmentDiagnostics,
  check: checkEdgeTreatment
} satisfies CadFeatureDefinition<'fillet'>;

export const chamfer = {
  kind: 'chamfer', family: 'dress-up', ...edgeTreatmentShape,
  outputs: ['body'], body: 'modify-target', suppression: 'pass-through', evaluator: { owner: 'kernel', version: 1 },
  diagnostics: edgeTreatmentDiagnostics,
  check: checkEdgeTreatment
} satisfies CadFeatureDefinition<'chamfer'>;

const shellShape = cadFeatureShape(Type.Literal('shell'), {
  targetId: cadTargetBodyField,
  thickness: cadFeatureScalarField({ ...positiveLength, refusal: 'Inward shell thickness must be positive and within one million millimetres.' }),
  // The one planar face the shell opens.
  opening: cadFeatureField<typeof CadFaceQuerySchema, CadFaceQuery>(CadFaceQuerySchema, { scalars: mapCadFaceQueryScalars, quantities: CAD_FACE_QUERY_QUANTITIES })
});

export const shell = {
  kind: 'shell', family: 'dress-up', ...shellShape,
  outputs: ['body'], body: 'modify-target', suppression: 'pass-through', evaluator: { owner: 'kernel', version: 1 },
  diagnostics: ['invalid-shell-opening', 'invalid-selector', 'invalid-selector-dimension', 'invalid-direction', 'selection-empty', 'selection-count-mismatch',
    'unsupported-selection', 'shell-thickness', 'shell-components', 'shell-failed', 'invalid-dimension', 'missing-body'],
  check(feature, context) {
    context.scalar(feature, 'thickness');
    validateCadShellOpening(feature.opening, context.document.parameters);
  }
} satisfies CadFeatureDefinition<'shell'>;
