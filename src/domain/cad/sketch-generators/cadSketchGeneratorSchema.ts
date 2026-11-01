import { Type } from '@sinclair/typebox';
import { CadScalarSchema } from '../cadPrimitives';
import { CadProfileSchema } from '../cadProfileSchema';
import { CAD_SKETCH_ELEMENT_ID_PATTERN } from '../sketch-relations/cadSketchVirtualElements';

// What a sketch generator generates from: a profile's geometry, as legacy profiles stored it, or a shape only generators make. A leaf,
// so the sketch graph's schema can name it.

const strict = { additionalProperties: false };
const scalar = CadScalarSchema;
/** A point or edge of the sketch, or the origin or an axis. */
const ref = Type.String({ pattern: CAD_SKETCH_ELEMENT_ID_PATTERN });

/**
 * The prefix of every id a generator generates, `<idPrefix>_<key>`. It has no underscore, so the namespace an id belongs to is the part
 * before its first one, and it is short enough to leave room for every key.
 */
export const CAD_SKETCH_GENERATOR_PREFIX_PATTERN = '^[A-Za-z0-9][A-Za-z0-9-]{0,47}$';

export const CadSketchGeneratorGeometrySchema = Type.Union([
  ...CadProfileSchema.anyOf,
  /**
   * A regular polygon about its centre, with `sides` vertices on the circle of `radius`. Its first vertex lies from the centre along
   * the direction of `directionId`, a line of the sketch or the H or V axis, so the polygon turns with that line.
   */
  Type.Object({ kind: Type.Literal('regular-polygon'), x: scalar, y: scalar, radius: scalar, sides: scalar, directionId: ref }, strict)
]);
