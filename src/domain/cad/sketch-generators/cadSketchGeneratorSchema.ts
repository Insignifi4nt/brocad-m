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

/** The largest entry id of a listed polygon or path. */
export const CAD_SKETCH_ENTRY_ID_MAX = 999_999;
/**
 * A listed polygon's points or path's segments may carry entry ids, one each, which key the members each entry generates in place of
 * its place in the list: an entry inserted, removed or moved leaves the others their members. Without them an entry's id is its index.
 */
const entryIds = Type.Optional(Type.Array(Type.Integer({ minimum: 0, maximum: CAD_SKETCH_ENTRY_ID_MAX }), { uniqueItems: true }));
const [plugin, rectangle, circle, polygon, path, slot] = CadProfileSchema.anyOf;

export const CadSketchGeneratorGeometrySchema = Type.Union([
  plugin, rectangle, circle, Type.Object({ ...polygon.properties, ids: entryIds }, strict), Type.Object({ ...path.properties, ids: entryIds }, strict), slot,
  /**
   * A regular polygon about its centre, with `sides` vertices on the circle of `radius`. Its first vertex lies from the centre along
   * the direction of `directionId`, a line of the sketch or the H or V axis, so the polygon turns with that line.
   */
  Type.Object({ kind: Type.Literal('regular-polygon'), x: scalar, y: scalar, radius: scalar, sides: scalar, directionId: ref }, strict)
]);
