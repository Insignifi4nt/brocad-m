import type { CadSketchGraphEntity } from '../cadSketchGraph';

/**
 * What the relation rule reads from a curve, whatever its kind: the points at its start and end when it has ends, the point it is drawn
 * about when it has one, and whether its carrier is a straight line. Remapping and copying read curves only through these traits, so a
 * new kind of curve, such as an ellipse or a spline, joins by giving its traits here and its pieces' intervals in each edit.
 */
export interface CadSketchCurveTraits {
  readonly ends: readonly [string, string] | null;
  readonly centre: string | null;
  readonly straight: boolean;
}
/** Reads a curve's traits. An edit or a copy may carry its own reader for a curve kind this one does not know yet. */
export type CadSketchCurveCapabilities = (curve: CadSketchGraphEntity) => CadSketchCurveTraits;

/** The traits of each stored curve kind; a kind added to the graph must say here what it has. */
export const cadSketchCurveTraits: CadSketchCurveCapabilities = curve => {
  switch (curve.kind) {
    case 'line': return { ends: [curve.startPointId, curve.endPointId], centre: null, straight: true };
    case 'arc': return { ends: [curve.startPointId, curve.endPointId], centre: curve.centerPointId, straight: false };
    case 'circle': return { ends: null, centre: curve.centerPointId, straight: false };
    default: { const unknown: never = curve; throw new Error(`No curve traits for ${(unknown as { kind: string }).kind}.`); }
  }
};
