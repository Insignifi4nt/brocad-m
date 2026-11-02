import { Type } from '@sinclair/typebox';
import type { CadPlane } from '../../cadDocument';
import { CadError } from '../../cadError';
import { CadPlaneSchema } from '../../cadPrimitives';
import { MAX_CAD_PATTERN_COUNT, MIN_CAD_PATTERN_COUNT, resolveCadCircularPattern } from '../../cadPatterns';
import { CAD_PRECISION } from '../../../precision/cadPrecision';
import type { CadFeatureDefinition } from '../cadFeatureDefinitionTypes';
import { cadFeatureField, cadFeatureReference, cadFeatureScalarField, cadFeatureShape, cadFeatureVectorField } from '../cadFeatureFields';
import { cadMaterialDiagnostics, cadSourceBodyField, cadTargetBodyField } from './solidFields';

const booleanOperation = Type.Union([Type.Literal('union'), Type.Literal('cut'), Type.Literal('intersect')]);
const booleanShape = cadFeatureShape(Type.Literal('boolean'), {
  targetId: cadTargetBodyField,
  toolId: cadFeatureReference({ role: 'tool', accepts: ['body'] }),
  operation: cadFeatureField<typeof booleanOperation, 'union' | 'cut' | 'intersect'>(booleanOperation,
    { choices: [{ value: 'union', label: 'Union' }, { value: 'cut', label: 'Subtract tool' }, { value: 'intersect', label: 'Intersection' }] })
});

export const boolean = {
  kind: 'boolean', family: 'body', ...booleanShape,
  outputs: ['body'], body: 'consume-tools', suppression: 'pass-through', evaluator: { owner: 'kernel', version: 1 },
  diagnostics: ['missing-body', 'invalid-instances', ...cadMaterialDiagnostics('cut')],
  check(feature) { if (feature.targetId === feature.toolId) throw new CadError('invalid-operation', 'Boolean target and tool must be different bodies.'); }
} satisfies CadFeatureDefinition<'boolean'>;

const transformShape = cadFeatureShape(Type.Literal('transform'), {
  sourceId: cadSourceBodyField,
  translation: cadFeatureVectorField({ quantity: 'length' }),
  // Degrees around world X, then Y, then Z, about the world origin.
  rotation: cadFeatureVectorField({ quantity: 'angle' })
});

export const transform = {
  kind: 'transform', family: 'body', ...transformShape,
  outputs: ['body'], body: 'modify-target', suppression: 'pass-through', evaluator: { owner: 'kernel', version: 1 },
  diagnostics: ['invalid-dimension', 'missing-body'],
  check(feature, context) { context.vector(feature, 'translation'); context.vector(feature, 'rotation'); }
} satisfies CadFeatureDefinition<'transform'>;

/** Instances of a pattern, including the original. A literal until S8's format cut lets it hold expressions. */
const patternCount = cadFeatureField(Type.Integer({ minimum: MIN_CAD_PATTERN_COUNT, maximum: MAX_CAD_PATTERN_COUNT }),
  { scalar: { quantity: 'count', integer: true, min: MIN_CAD_PATTERN_COUNT, max: MAX_CAD_PATTERN_COUNT, literal: true, repeats: true } });
const patternDiagnostics = ['invalid-dimension', 'pattern-limit', 'instance-limit', 'invalid-instances', 'missing-body'];

const linearPatternShape = cadFeatureShape(Type.Literal('linear-pattern'), {
  sourceId: cadSourceBodyField,
  count: patternCount,
  // The translation between instances.
  spacing: cadFeatureVectorField({ quantity: 'length', nonzero: true, tolerance: CAD_PRECISION.minimumLengthMm, refusal: 'Pattern spacing must be nonzero.' })
});

export const linearPattern = {
  kind: 'linear-pattern', family: 'body', ...linearPatternShape,
  outputs: ['body'], body: 'modify-target', suppression: 'pass-through', evaluator: { owner: 'kernel', version: 1 },
  diagnostics: patternDiagnostics,
  check(feature, context) { context.vector(feature, 'spacing'); }
} satisfies CadFeatureDefinition<'linear-pattern'>;

const worldAxis = Type.Union([Type.Literal('x'), Type.Literal('y'), Type.Literal('z')]);
const circularPatternShape = cadFeatureShape(Type.Literal('circular-pattern'), {
  sourceId: cadSourceBodyField,
  count: patternCount,
  // The positive world axis the copies turn around, through `center`. K4 makes it a reference.
  axis: cadFeatureField<typeof worldAxis, 'x' | 'y' | 'z'>(worldAxis, { choices: [{ value: 'x', label: 'World X' }, { value: 'y', label: 'World Y' }, { value: 'z', label: 'World Z' }] }),
  center: cadFeatureVectorField({ quantity: 'length' }),
  // The signed total extent; resolving the pattern holds it to its range.
  angle: cadFeatureScalarField({ quantity: 'angle' })
});

export const circularPattern = {
  kind: 'circular-pattern', family: 'body', ...circularPatternShape,
  outputs: ['body'], body: 'modify-target', suppression: 'pass-through', evaluator: { owner: 'kernel', version: 1 },
  diagnostics: ['invalid-pattern', ...patternDiagnostics],
  check(feature, context) { resolveCadCircularPattern(feature, context.document.parameters); }
} satisfies CadFeatureDefinition<'circular-pattern'>;

const mirrorShape = cadFeatureShape(Type.Literal('mirror'), {
  sourceId: cadSourceBodyField,
  // A principal plane through the world origin. K4 makes it a reference.
  plane: cadFeatureField<typeof CadPlaneSchema, CadPlane>(CadPlaneSchema, { choices: (['XY', 'XZ', 'YZ'] as const).map(value => ({ value, label: `${value} plane` })) })
});

export const mirror = {
  kind: 'mirror', family: 'body', ...mirrorShape,
  // The source stays a body of its own beside the mirrored copy.
  outputs: ['body'], body: 'new', suppression: 'no-output', occurrence: 'mirror', evaluator: { owner: 'kernel', version: 1 },
  diagnostics: ['missing-body']
} satisfies CadFeatureDefinition<'mirror'>;
