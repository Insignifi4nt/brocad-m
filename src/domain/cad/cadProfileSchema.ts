import { Type } from '@sinclair/typebox';
import { CadPathSegmentSchema, CadPoint2Schema, CadScalarSchema } from './cadPrimitives';
import { CadPluginProfileSchema } from './plugins/cadPlugins';

// A profile's geometry: a plugin instance or a parametric shape. Legacy sketch profiles store it, and a sketch generator generates
// graph geometry from it. A leaf, so the sketch graph's schema can name it.
const strict = { additionalProperties: false };
const scalar = CadScalarSchema;
const point2 = CadPoint2Schema;

export const CadProfileSchema = Type.Union([
  CadPluginProfileSchema,
  Type.Object({ kind: Type.Literal('rectangle'), x: scalar, y: scalar, width: scalar, height: scalar, cornerRadius: scalar }, strict),
  Type.Object({ kind: Type.Literal('circle'), x: scalar, y: scalar, radius: scalar }, strict),
  Type.Object({ kind: Type.Literal('polygon'), points: Type.Array(point2, { minItems: 3 }) }, strict),
  Type.Object({ kind: Type.Literal('path'), segments: Type.Array(CadPathSegmentSchema, { minItems: 1 }) }, strict),
  Type.Object({ kind: Type.Literal('slot'), x: scalar, y: scalar, length: scalar, width: scalar, angle: scalar }, strict)
]);
