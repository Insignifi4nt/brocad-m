import { ChamferIcon, FilletIcon, LinearPatternIcon, LinkIcon, MeasureIcon, ClosedPathIcon, RelationCoincidentIcon, RelationCollinearIcon, RelationConcentricIcon, RelationEqualLengthIcon,
  RelationEqualRadiusIcon, RelationFixIcon, RelationHorizontalIcon, RelationMidpointIcon, RelationParallelIcon, RelationPerpendicularIcon, RelationPointOnCurveIcon,
  RelationPointOnLineIcon, RelationSymmetricIcon, RelationTangentIcon, RelationVerticalIcon, type WorkbenchDrawnIconComponent } from '@wire-edm/icons-react';
import type { CadSketchRelationKind } from '@/domain/cad/sketch-relations/cadSketchRelationTypes';

/** The drawing a glyph shows, one per relation kind as the user knows it; a Concentric is stored as a Coincident between two centres. */
export type CadSketchRelationGlyphKind = 'horizontal' | 'vertical' | 'parallel' | 'perpendicular' | 'collinear' | 'equal-length' | 'equal-radius' | 'tangent'
  | 'coincident' | 'concentric' | 'midpoint' | 'symmetric' | 'fix' | 'point-on-line' | 'point-on-curve';
export const CAD_SKETCH_RELATION_ICONS: Readonly<Record<CadSketchRelationGlyphKind, WorkbenchDrawnIconComponent>> = {
  horizontal: RelationHorizontalIcon, vertical: RelationVerticalIcon, parallel: RelationParallelIcon, perpendicular: RelationPerpendicularIcon, collinear: RelationCollinearIcon,
  'equal-length': RelationEqualLengthIcon, 'equal-radius': RelationEqualRadiusIcon, tangent: RelationTangentIcon, coincident: RelationCoincidentIcon, concentric: RelationConcentricIcon,
  midpoint: RelationMidpointIcon, symmetric: RelationSymmetricIcon, fix: RelationFixIcon, 'point-on-line': RelationPointOnLineIcon, 'point-on-curve': RelationPointOnCurveIcon
};

/**
 * Where a relation's glyphs sit, read from its operands with points by Coincident identity:
 * - `between`: on the line whose ends are its two points, or else on both points;
 * - `edges`: on each edge it names;
 * - `at-point`: on its first point;
 * - `at-end`: on the first end it joins at;
 * - `operands`: on each point, then each edge, it names;
 * - `curves`: on the first arc or circle centred on each of its points.
 */
export type CadSketchRelationGlyphAnchor = 'between' | 'edges' | 'at-point' | 'at-end' | 'operands' | 'curves';
export interface CadSketchRelationGlyphPresentation { readonly glyph: CadSketchRelationGlyphKind; readonly anchor: CadSketchRelationGlyphAnchor }
export interface CadSketchRelationPresentation {
  /**
   * The glyph the canvas draws, or null for a relation drawn otherwise: dimensions draw as dimensions, and a linear pattern and a linked
   * reference and a generator keep their own controls, whose Detach keeps their geometry, so a glyph Delete must never stand in for it.
   */
  readonly glyph: CadSketchRelationGlyphPresentation | null;
  /** The glyph of a Coincident between two arc or circle centres, which reads as Concentric. */
  readonly centred?: CadSketchRelationGlyphPresentation;
  /**
   * Drawn only while it holds a point on an axis, the form a Coincident with the axis takes; held away from the axis, the coordinate is a
   * Distance dimension.
   */
  readonly onAxisOnly?: true;
  /** The icon that stands for the kind: its glyph's drawing, or the tool that makes it. */
  readonly icon: WorkbenchDrawnIconComponent;
}
const glyph = (kind: CadSketchRelationGlyphKind, anchor: CadSketchRelationGlyphAnchor): CadSketchRelationPresentation => ({ glyph: { glyph: kind, anchor }, icon: CAD_SKETCH_RELATION_ICONS[kind] });
const drawnOtherwise = (icon: WorkbenchDrawnIconComponent): CadSketchRelationPresentation => ({ glyph: null, icon });

/** How each relation kind shows on the canvas and in the relations list. */
type Presentations = { readonly [K in CadSketchRelationKind]: CadSketchRelationPresentation };
export const CAD_SKETCH_RELATION_PRESENTATION: Presentations = Object.freeze({
  'linear-pattern': drawnOtherwise(LinearPatternIcon), 'reference-dimension': drawnOtherwise(MeasureIcon), 'external-reference': drawnOtherwise(LinkIcon),
  coincident: { ...glyph('coincident', 'at-point'), centred: { glyph: 'concentric', anchor: 'curves' } },
  horizontal: glyph('horizontal', 'between'), vertical: glyph('vertical', 'between'),
  parallel: glyph('parallel', 'edges'), perpendicular: glyph('perpendicular', 'edges'), collinear: glyph('collinear', 'edges'),
  midpoint: glyph('midpoint', 'at-point'), 'point-on-line': glyph('point-on-line', 'at-point'), 'point-on-curve': glyph('point-on-curve', 'operands'),
  'tangent-joint': glyph('tangent', 'at-end'), tangent: glyph('tangent', 'edges'), symmetric: glyph('symmetric', 'operands'),
  'equal-length': glyph('equal-length', 'edges'), 'equal-radius': glyph('equal-radius', 'edges'),
  'line-angle': drawnOtherwise(MeasureIcon), 'radial-size': drawnOtherwise(MeasureIcon), 'fixed-point': glyph('fix', 'at-point'),
  'fixed-axis': { ...glyph('coincident', 'at-point'), onAxisOnly: true },
  distance: drawnOtherwise(MeasureIcon), 'point-line-distance': drawnOtherwise(MeasureIcon), 'axis-distance': drawnOtherwise(MeasureIcon),
  'fillet-corner': drawnOtherwise(FilletIcon), 'chamfer-corner': drawnOtherwise(ChamferIcon), generator: drawnOtherwise(ClosedPathIcon)
} satisfies Presentations);
