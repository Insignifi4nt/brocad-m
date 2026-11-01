import { Type, type Static } from '@sinclair/typebox';
import { CadError } from '@/domain/cad/cadError';
import type { CadSketchGraph } from '@/domain/cad/cadSketchGraph';
import { CAD_SKETCH_H_AXIS_ID, CAD_SKETCH_ORIGIN_ID, CAD_SKETCH_V_AXIS_ID, isCadSketchVirtualSelection } from '@/domain/cad/sketch-relations/cadSketchVirtualElements';
import type { CadSketchGraphSelection } from '@/domain/cad/cadSketchGraphSelection';
import { cadSketchZeroScalar } from '@/domain/cad/sketch-relations/cadSketchRelationPlanning';
import type { CadContextMenuItem } from './CadContextMenu';
import type { CadSketchDimensionPlan } from './cadSketchDimensionPlacement';
import type { CadSketchPointerStore } from './CadSketchDimensionPreview';
import { cadSelectionAccepts, setCadSelectionKind, type CadSelectionFilter } from '@/domain/cad/selection/cadSelectionFilter';

export { CadSketchGraphSelectionSchema, CadSketchGraphSelectionSetSchema, cadSketchGraphSelectionSet } from '@/domain/cad/cadSketchGraphSelection';
export type { CadSketchGraphSelection } from '@/domain/cad/cadSketchGraphSelection';
export { cadSketchZeroScalar };

export const CadSketchGraphPickFilterSchema = Type.Union([Type.Literal('auto'), Type.Literal('points'), Type.Literal('edges')]);
export type CadSketchGraphPickFilter = Static<typeof CadSketchGraphPickFilterSchema>;
/** What a sketch pick reaches under the selection filter: `none` when both points and edges are filtered out. */
export type CadSketchGraphPickScope = CadSketchGraphPickFilter | 'none';
export const cadSketchPickScopeHasPoints = (scope: CadSketchGraphPickScope) => scope === 'auto' || scope === 'points';
export const cadSketchPickScopeHasEdges = (scope: CadSketchGraphPickScope) => scope === 'auto' || scope === 'edges';

/** The sketch geometry the shared selection filter lets a pick reach. */
export function cadSketchPickScope(filter: CadSelectionFilter): CadSketchGraphPickScope {
  const points = cadSelectionAccepts(filter, 'point'), edges = cadSelectionAccepts(filter, 'edge');
  return points ? edges ? 'auto' : 'points' : edges ? 'edges' : 'none';
}

/**
 * The shared filter with the kinds a sketch pick filter names: Auto takes points, edges and the axes; Points takes points and the origin;
 * Edges takes edges and the axes. The other kinds keep their state.
 */
export function cadSelectionFilterForSketchPick(filter: CadSelectionFilter, pick: CadSketchGraphPickFilter): CadSelectionFilter {
  return setCadSelectionKind(setCadSelectionKind(setCadSelectionKind(filter, 'point', pick !== 'edges'), 'edge', pick !== 'points'), 'axis', pick !== 'points');
}

/** A command borrows selection without enabling geometry edits or changing its frozen operands. */
export interface CadSketchGeometryPick {
  readonly eligibleEntityIds: readonly string[];
  readonly eligiblePointIds: readonly string[];
  readonly label: string;
  onPick(selection: CadSketchGraphSelection): void;
  /** Finishes a pick that already has enough geometry, from Enter or a click on empty space. */
  onConfirm?(source: 'pointer' | 'key'): void;
  onCancel(): void;
  /** Takes the sketch position of every pointer move and press over the canvas while the pick lasts. */
  readonly pointer?: CadSketchPointerStore;
  /**
   * The dimension the picks would place, previewed at the pointer. While it is shown, pointer moves only update `pointer`, so they
   * render the preview and nothing else.
   */
  readonly dimensionPreview?: CadSketchDimensionPlan;
  /** Commands a right release or the menu key opens in place of the overlap chooser, for the pointer position given; null keeps the chooser. */
  contextMenu?(pointer: { readonly x: number; readonly y: number } | null): { readonly title: string; readonly items: readonly CadContextMenuItem[] } | null;
  /** Placed dimensions stay selectable, editable, deletable and keep their menus while the pick waits for its first geometry. */
  readonly dimensionsInteractive?: boolean;
  /**
   * The placement the label offers to edit, a new value each time one becomes the selection. Focus the picks left on sketch geometry then
   * moves to the canvas, as a click on empty space places, so Enter edits the placed dimension rather than picking that geometry again.
   */
  readonly placed?: object;
  /** What Escape does, after the label; `Escape cancels` without it. */
  readonly escapeLabel?: string;
}
/** Screen reach of the origin and the axes; the origin reaches a little further so it wins where the axes cross. */
export const CAD_SKETCH_FIXED_PICK_PIXELS = 6;
/** Screen length of the H and V arrows that mark each axis direction from the origin. The axes themselves cross the whole view. */
export const CAD_SKETCH_AXIS_PIXELS = 72;
/** The origin as a point and the H and V axes as edges, picked and selected as other sketch geometry is. */
export const CAD_SKETCH_FIXED_SELECTIONS: readonly CadSketchGraphSelection[] = Object.freeze([CAD_SKETCH_ORIGIN_ID, CAD_SKETCH_H_AXIS_ID, CAD_SKETCH_V_AXIS_ID]
  .map(id => Object.freeze({ kind: id === CAD_SKETCH_ORIGIN_ID ? 'point' as const : 'entity' as const, id })));
/**
 * The eligible origin or axis under a sketch-space point, nearest first, or null. As in CATIA the axes are whole lines through the
 * origin, so they are picked anywhere along their length; the check stays constant time, as `eligible` holds at most the three of them.
 */
export function pickCadSketchFixedElement(point: readonly [number, number], millimetersPerPixel: number, eligible: readonly CadSketchGraphSelection[]): CadSketchGraphSelection | null {
  if (!eligible.length || !Number.isFinite(millimetersPerPixel) || millimetersPerPixel <= 0) return null;
  const reach = CAD_SKETCH_FIXED_PICK_PIXELS * millimetersPerPixel, find = (id: string) => eligible.find(item => item.id === id);
  const origin = find(CAD_SKETCH_ORIGIN_ID);
  if (origin && Math.hypot(point[0], point[1]) <= reach * 1.5) return origin;
  const across = Math.abs(point[1]), along = Math.abs(point[0]), h = across <= reach ? find(CAD_SKETCH_H_AXIS_ID) : undefined, v = along <= reach ? find(CAD_SKETCH_V_AXIS_ID) : undefined;
  return h && v ? across <= along ? h : v : h ?? v ?? null;
}
/**
 * Every eligible fixed element within reach of `point`, for Select other: the origin first, then the axes nearest first. The first is the
 * one `pickCadSketchFixedElement` prefers.
 */
export function cadSketchFixedElementsAt(point: readonly [number, number], millimetersPerPixel: number, eligible: readonly CadSketchGraphSelection[]): CadSketchGraphSelection[] {
  if (!eligible.length || !Number.isFinite(millimetersPerPixel) || millimetersPerPixel <= 0) return [];
  const reach = CAD_SKETCH_FIXED_PICK_PIXELS * millimetersPerPixel, find = (id: string) => eligible.find(item => item.id === id);
  const origin = Math.hypot(point[0], point[1]) <= reach * 1.5 ? find(CAD_SKETCH_ORIGIN_ID) : undefined;
  const axes = [{ axis: find(CAD_SKETCH_H_AXIS_ID), distance: Math.abs(point[1]) }, { axis: find(CAD_SKETCH_V_AXIS_ID), distance: Math.abs(point[0]) }]
    .filter(({ axis, distance }) => axis && distance <= reach).sort((a, b) => a.distance - b.distance).map(({ axis }) => axis!);
  return [...origin ? [origin] : [], ...axes];
}
/** The origin and the axes a pick or plain selection may take: those the pick lists as eligible, or all three. */
export const cadSketchFixedEligible = (pick: Pick<CadSketchGeometryPick, 'eligiblePointIds' | 'eligibleEntityIds'> | null): readonly CadSketchGraphSelection[] =>
  pick ? CAD_SKETCH_FIXED_SELECTIONS.filter(selection => cadSketchGeometryPickAllows(pick, selection)) : CAD_SKETCH_FIXED_SELECTIONS;
export function cadSketchGeometryPickAllows(pick: Pick<CadSketchGeometryPick, 'eligiblePointIds' | 'eligibleEntityIds'>, selection: CadSketchGraphSelection): boolean {
  return (selection.kind === 'point' ? pick.eligiblePointIds : pick.eligibleEntityIds).includes(selection.id);
}

function freezeSelection(selections: readonly CadSketchGraphSelection[]): readonly CadSketchGraphSelection[] {
  return Object.freeze(selections.map(selection => Object.freeze({ kind: selection.kind, id: selection.id })));
}

/** The origin and the axes belong to every sketch. */
function belongsToGraph(graph: CadSketchGraph | undefined, selection: CadSketchGraphSelection): boolean {
  return Boolean(graph && isCadSketchVirtualSelection(selection)) || Boolean((selection.kind === 'point' ? graph?.points : graph?.entities)?.some(item => item.id === selection.id));
}

export function isCadSketchGraphSelected(current: readonly CadSketchGraphSelection[], atom: CadSketchGraphSelection): boolean {
  return current.some(selection => selection.kind === atom.kind && selection.id === atom.id);
}

export function cadSketchGraphSelectionsEqual(left: readonly CadSketchGraphSelection[], right: readonly CadSketchGraphSelection[]): boolean {
  return left.length === right.length && left.every((selection, index) => selection.kind === right[index].kind && selection.id === right[index].id);
}

/** Shift selection operates on already validated source identities; callers validate new targets against their active graph. */
export function toggleCadSketchGraphSelection(current: readonly CadSketchGraphSelection[], atom: CadSketchGraphSelection): readonly CadSketchGraphSelection[] {
  if (isCadSketchGraphSelected(current, atom)) return freezeSelection(current.filter(selection => selection.kind !== atom.kind || selection.id !== atom.id));
  if (current.length >= 64) throw new CadError('invalid-sketch-selection', 'Choose up to 64 distinct sketch points or edges.');
  return freezeSelection([...current, atom]);
}

/** Internal history/source reconciliation only. External requests must use strict whole-set validation. */
export function reconcileCadSketchGraphSelection(graph: CadSketchGraph | undefined, current: readonly CadSketchGraphSelection[]): readonly CadSketchGraphSelection[] {
  const retained = current.filter(selection => belongsToGraph(graph, selection));
  return retained.length === current.length ? current : freezeSelection(retained);
}
