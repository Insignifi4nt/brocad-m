import { memo, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { MeasureIcon, type WorkbenchDrawnIconComponent } from '@wire-edm/icons-react';
import { readableMessage } from '@/lib/userMessage';
import type { CadSketchGraph } from '@/domain/cad/cadSketchGraph';
import { cadSketchRelationOffers, type CadSketchRelationOffer } from '@/domain/cad/sketch-relations/cadSketchRelationOffers';
import { CAD_SKETCH_RELATION_DEFINITIONS } from '@/domain/cad/sketch-relations/cadSketchRelationRegistry';
import type { CadSketchRelationKind } from '@/domain/cad/sketch-relations/cadSketchRelationTypes';
import { CAD_SKETCH_H_AXIS_ID, CAD_SKETCH_ORIGIN_ID, CAD_SKETCH_V_AXIS_ID, isCadSketchVirtualId } from '@/domain/cad/sketch-relations/cadSketchVirtualElements';
import type { CadSketchGraphInteraction } from './cadSketchGraphInteraction';
import type { CadSketchGraphSelection } from './cadSketchGraphSelection';
import { CAD_SKETCH_RELATION_ICONS, CAD_SKETCH_RELATION_PRESENTATION } from './sketch-relations/cadSketchRelationPresentation';
import './cad-sketch-selection-actions.css';

/**
 * The relations the selection can take, as one icon each beside the selection. Offers come from the relation registry by operand signature,
 * once per accepted graph and selection, never from a solve; the native judge still decides each click. An applied offer shows pressed, and
 * pressing it removes the relations that hold it.
 */
export interface CadSketchSelectionActionsModel {
  readonly graph: CadSketchGraph;
  readonly selection: readonly CadSketchGraphSelection[];
  readonly offers: readonly CadSketchRelationOffer[];
  /** Whether the Dimension tool takes the selection as its first picks. */
  readonly dimensionAvailable: boolean;
  readonly disabled: boolean;
  onOffer(offer: CadSketchRelationOffer): void;
  onDimension(): void;
}

/** One button of the row: its accessible name, icon, state and the help its tooltip shows. */
export interface CadSketchSelectionAction {
  readonly key: string;
  readonly label: string;
  readonly icon: WorkbenchDrawnIconComponent;
  readonly state: CadSketchRelationOffer['state'];
  readonly help: string;
  readonly offer: CadSketchRelationOffer;
}

const HELP: Partial<Record<CadSketchRelationKind | 'concentric', string>> = {
  horizontal: 'Keeps each selected line, or the two points, level.', vertical: 'Keeps each selected line, or the two points, upright.',
  parallel: 'Keeps the lines, or a line and an axis, in the same direction.', perpendicular: 'Keeps two lines, or a line and an axis, at a right angle.',
  collinear: 'Keeps the lines on one infinite line.', coincident: 'Keeps the points together, a point on the line, curve or axis, or the center of the arc or circle on the axis.',
  concentric: 'Keeps the arcs and circles on one center, or the arc or circle centered at the origin, independently of their sizes.', midpoint: 'Keeps the point halfway between the line’s endpoints as they change.',
  'point-on-line': 'Keeps the point on the line or its extension; it can still slide along it.', 'point-on-curve': 'Keeps the point on the arc or circle.',
  symmetric: 'Keeps the two points, lines, arcs or circles mirrored about the line or axis.', 'tangent-joint': 'Keeps a line and arc smoothly joined at their shared endpoint.',
  tangent: 'Keeps the edges touching smoothly.', 'equal-length': 'Keeps the lines at one length.', 'equal-radius': 'Keeps the arcs and circles at one radius.',
  'fixed-point': 'Keeps each point where it is now.'
};
const LABELS: Partial<Record<CadSketchRelationKind | 'concentric', string>> = { concentric: 'Concentric', 'fixed-point': 'Fix' };
const curveKinds = new Set(['arc', 'circle']);
/** A Coincident between arcs and circles, or of an arc or circle with the origin, is their Concentric. */
function concentric(graph: CadSketchGraph, offer: CadSketchRelationOffer) {
  const curve = (pick: CadSketchGraphSelection) => pick.kind === 'entity' && graph.entities.some(entity => entity.id === pick.id && curveKinds.has(entity.kind));
  return offer.kind === 'coincident' && offer.operands.length > 0 && offer.operands.every(part => part.length > 1
    && (part.every(curve) || part.some(curve) && part.some(pick => pick.id === CAD_SKETCH_ORIGIN_ID)));
}

const CENTER_SYMMETRY_HELP = 'Keeps the two circles’ centers mirrored about the line or axis; each radius keeps its own driver.';
/**
 * Two circles and a line or an axis take Symmetric as whole curves, which links their radii, and also on their centers alone: the registry's
 * point Symmetric on the two centers, available, applied or blocked exactly as it is for those points. Any other selection has none.
 */
export function cadSketchCenterSymmetryOffer(graph: CadSketchGraph, selection: readonly CadSketchGraphSelection[]): CadSketchRelationOffer | null {
  if (selection.length !== 3) return null;
  const centers = selection.flatMap(pick => {
    const curve = pick.kind === 'entity' ? graph.entities.find(entity => entity.id === pick.id) : undefined;
    return curve?.kind === 'circle' ? [curve.centerPointId] : [];
  });
  const line = selection.find(pick => pick.kind === 'entity' && (pick.id === CAD_SKETCH_H_AXIS_ID || pick.id === CAD_SKETCH_V_AXIS_ID
    || graph.entities.some(entity => entity.id === pick.id && entity.kind === 'line')));
  if (centers.length !== 2 || !line) return null;
  return cadSketchRelationOffers(graph, [{ kind: 'point', id: centers[0] }, { kind: 'point', id: centers[1] }, line]).find(offer => offer.kind === 'symmetric') ?? null;
}

/**
 * The row's buttons in registry order; kinds that share a name, as both tangents do, show once, applied or available before blocked.
 * A center symmetry follows Symmetric as its own button.
 */
export function cadSketchSelectionActions(graph: CadSketchGraph, offers: readonly CadSketchRelationOffer[], centers: CadSketchRelationOffer | null = null): readonly CadSketchSelectionAction[] {
  const actions: CadSketchSelectionAction[] = [];
  const rank = (state: CadSketchRelationOffer['state']) => state === 'blocked' ? 1 : 0;
  for (const offer of offers) {
    const centred = concentric(graph, offer), key = centred ? 'concentric' : offer.kind;
    const label = LABELS[key] ?? CAD_SKETCH_RELATION_DEFINITIONS[offer.kind].name;
    const icon = centred ? CAD_SKETCH_RELATION_ICONS.concentric : CAD_SKETCH_RELATION_PRESENTATION[offer.kind].icon;
    const help = offer.state === 'blocked' ? readableMessage(offer.reason ?? 'These picks cannot take this relation now.')
      : offer.state === 'applied' ? `Applied. Press to remove ${label.toLowerCase()}.` : HELP[key] ?? label;
    const action: CadSketchSelectionAction = { key, label, icon, state: offer.state, help, offer };
    const same = actions.findIndex(item => item.label === label);
    if (same < 0) actions.push(action);
    else if (rank(action.state) < rank(actions[same].state)) actions[same] = action;
  }
  if (centers) {
    const help = centers.state === 'blocked' ? readableMessage(centers.reason ?? 'These picks cannot take this relation now.')
      : centers.state === 'applied' ? 'Applied. Press to remove symmetric centers.' : CENTER_SYMMETRY_HELP;
    const at = actions.findIndex(item => item.key === 'symmetric');
    actions.splice(at < 0 ? actions.length : at + 1, 0, { key: 'symmetric-centers', label: 'Symmetric centers', icon: CAD_SKETCH_RELATION_PRESENTATION.symmetric.icon, state: centers.state, help, offer: centers });
  }
  return actions;
}

/**
 * The relations a selection takes, as the row shows them. The Constrain menu and the selection's menus list this same list, so every place
 * offers one set, with the same states, reasons and help, and choosing an item applies or removes the same relations as pressing its icon.
 */
export function cadSketchSelectionRelationActions(graph: CadSketchGraph, selection: readonly CadSketchGraphSelection[],
  offers: readonly CadSketchRelationOffer[] = cadSketchRelationOffers(graph, selection)): readonly CadSketchSelectionAction[] {
  return cadSketchSelectionActions(graph, offers, cadSketchCenterSymmetryOffer(graph, selection));
}

interface Bounds { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }
interface ViewFrame { readonly center: readonly [number, number]; readonly width: number; readonly span: number; readonly pixelWidth: number; readonly pixelHeight: number }
/** The selection's box in viewport pixels, from its points and its edges' bounds; the origin and the axes, which are fixed and endless, add nothing. */
export function cadSketchSelectionScreenBounds(prepared: Pick<CadSketchGraphInteraction, 'points' | 'geometry'>, selection: readonly CadSketchGraphSelection[], view: ViewFrame): Bounds | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x: number, y: number) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); };
  for (const pick of selection) {
    if (isCadSketchVirtualId(pick.id)) continue;
    if (pick.kind === 'point') { const point = prepared.points.find(item => item.id === pick.id); if (point) add(point.position[0], point.position[1]); continue; }
    const segment = prepared.geometry.segments.find(item => item.id === pick.id);
    if (segment) { add(segment.bounds.minX, segment.bounds.minY); add(segment.bounds.maxX, segment.bounds.maxY); }
  }
  if (!Number.isFinite(minX) || !view.width || !view.span) return null;
  const sx = view.pixelWidth / view.width, sy = view.pixelHeight / view.span;
  const x = (value: number) => (value - view.center[0]) * sx + view.pixelWidth / 2, y = (value: number) => -(value - view.center[1]) * sy + view.pixelHeight / 2;
  return { left: x(minX), right: x(maxX), top: y(maxY), bottom: y(minY) };
}

/** Pixels kept between the row and the selected geometry when the row sits inside the selection's box. */
const GEOMETRY_CLEARANCE = 3;
/**
 * Whether a row at a box in viewport pixels would cover a selected point or edge, tested against the exact geometry with the box picking
 * uses rather than against the selection's box. The origin and the axes, which are fixed and endless, are never covered.
 */
export function cadSketchSelectionCoveredBy(prepared: Pick<CadSketchGraphInteraction, 'pickBox'>, selection: readonly CadSketchGraphSelection[], view: ViewFrame) {
  const picked = new Set(selection.filter(pick => !isCadSketchVirtualId(pick.id)).map(pick => `${pick.kind}:${pick.id}`));
  const mmX = view.width / view.pixelWidth, mmY = view.span / view.pixelHeight;
  return (box: Bounds) => {
    if (!picked.size || !view.pixelWidth || !view.pixelHeight) return false;
    const bounds = { minX: view.center[0] + (box.left - GEOMETRY_CLEARANCE - view.pixelWidth / 2) * mmX, maxX: view.center[0] + (box.right + GEOMETRY_CLEARANCE - view.pixelWidth / 2) * mmX,
      minY: view.center[1] - (box.bottom + GEOMETRY_CLEARANCE - view.pixelHeight / 2) * mmY, maxY: view.center[1] - (box.top - GEOMETRY_CLEARANCE - view.pixelHeight / 2) * mmY };
    return prepared.pickBox({ bounds, mode: 'crossing' }).some(hit => picked.has(`${hit.kind}:${hit.id}`));
  };
}

/** Margins that keep the row off the sketch header above and the command dock below. */
const MARGIN = { top: 48, bottom: 64, side: 8 }, GAP = 10;
const overlaps = (a: Bounds, b: Bounds) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
/**
 * Where a row of `size` goes beside `selection` in a viewport of `viewport`: above it, centred or at either end, else below the same way,
 * else right, else left, else a corner. A place clear of the selection's box comes first, then one that `covers` says leaves the exact
 * selected geometry clear; within each, a place also clear of `avoid`, the drawn dimension labels, relation marks, floating panels and the
 * sketch bar, comes first. With no place clear of the selected geometry the result is null: the row never covers the selection.
 */
export function placeCadSketchSelectionActions(selection: Bounds | null, size: { readonly width: number; readonly height: number }, viewport: { readonly width: number; readonly height: number },
  avoid: readonly Bounds[] = [], covers: (box: Bounds) => boolean = box => selection !== null && overlaps(box, selection)): Bounds | null {
  const clampX = (left: number) => Math.max(MARGIN.side, Math.min(viewport.width - size.width - MARGIN.side, left));
  const clampY = (top: number) => Math.max(MARGIN.top, Math.min(viewport.height - size.height - MARGIN.bottom, top));
  const rect = (left: number, top: number): Bounds => ({ left, top, right: left + size.width, bottom: top + size.height });
  const corners = [rect(MARGIN.side, MARGIN.top), rect(viewport.width - size.width - MARGIN.side, MARGIN.top),
    rect(MARGIN.side, viewport.height - size.height - MARGIN.bottom), rect(viewport.width - size.width - MARGIN.side, viewport.height - size.height - MARGIN.bottom)];
  const inside = (box: Bounds) => box.left >= MARGIN.side - .5 && box.top >= MARGIN.top - .5 && box.right <= viewport.width - MARGIN.side + .5 && box.bottom <= viewport.height - MARGIN.bottom + .5;
  const open = (box: Bounds) => !avoid.some(item => overlaps(box, item));
  if (!selection) { const free = corners.filter(inside); return free.find(open) ?? free[0] ?? null; }
  const middleX = (selection.left + selection.right) / 2, middleY = (selection.top + selection.bottom) / 2;
  const across = [clampX(middleX - size.width / 2), clampX(selection.left), clampX(selection.right - size.width)];
  const candidates = [
    ...across.map(left => rect(left, selection.top - GAP - size.height)), ...across.map(left => rect(left, selection.bottom + GAP)),
    rect(selection.right + GAP, clampY(middleY - size.height / 2)), rect(selection.left - GAP - size.width, clampY(middleY - size.height / 2)), ...corners
  ].filter(inside);
  const outside = candidates.filter(box => !overlaps(box, selection)), beside = candidates.filter(box => !covers(box));
  return outside.find(open) ?? outside[0] ?? beside.find(open) ?? beside[0] ?? null;
}

/**
 * What the row keeps clear of besides the selection, in the pixels of the view it floats in: the dimension labels and relation marks a click
 * or double-click reaches, the panels floating over the view and the sketch bar. Read from the page only when the row is placed.
 */
function selectionActionObstacles(row: HTMLElement): readonly Bounds[] {
  const view = row.parentElement; if (!view) return [];
  const origin = view.getBoundingClientRect();
  const items = [...view.querySelectorAll('.cad-sketch-graph-dimension-label, .cad-sketch-relation-glyph.is-interactive'),
    ...row.closest('.cad-workbench')?.querySelectorAll('[data-cad-model-tree], [data-cad-properties], [data-cad-command-dock], [data-cad-sketch-header]') ?? []];
  return items.flatMap(item => {
    const box = item.getBoundingClientRect();
    return box.width > 0 && box.height > 0 ? [{ left: box.left - origin.left, top: box.top - origin.top, right: box.right - origin.left, bottom: box.bottom - origin.top }] : [];
  });
}

export interface CadSketchSelectionActionsProps {
  readonly model: CadSketchSelectionActionsModel;
  readonly prepared: Pick<CadSketchGraphInteraction, 'points' | 'geometry' | 'pickBox'>;
  readonly center: readonly [number, number];
  readonly width: number;
  readonly span: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  /** An edit or operation is pending: the row stays in place, and keeps focus, with every button inactive until it settles. */
  readonly busy?: boolean;
  /** Escape returns focus to the canvas, which keeps the selection; so does the row hiding or going while it holds focus. */
  onEscape(): void;
  /** Whether the row found a place clear of the selection. Without one it hides, and the canvas says where the same commands are. */
  onRoomChange?(room: boolean): void;
}

const DIMENSION_KEY = 'dimension';
/** The floating row. It renders again only when the selection, its offers or the view change, never as the pointer moves. */
export const CadSketchSelectionActions = memo(function CadSketchSelectionActions({ model, prepared, center, width, span, pixelWidth, pixelHeight, busy = false, onEscape, onRoomChange }: CadSketchSelectionActionsProps) {
  const actions = useMemo(() => cadSketchSelectionRelationActions(model.graph, model.selection, model.offers), [model.graph, model.offers, model.selection]);
  const bounds = useMemo(() => cadSketchSelectionScreenBounds(prepared, model.selection, { center, width, span, pixelWidth, pixelHeight }),
    [prepared, model.selection, center, width, span, pixelWidth, pixelHeight]);
  const covers = useMemo(() => cadSketchSelectionCoveredBy(prepared, model.selection, { center, width, span, pixelWidth, pixelHeight }),
    [prepared, model.selection, center, width, span, pixelWidth, pixelHeight]);
  const row = useRef<HTMLDivElement>(null), [position, setPosition] = useState<{ readonly left: number; readonly top: number } | 'none' | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const inactive = busy || model.disabled, count = actions.length + 1;
  const keys = useMemo(() => [...actions.map(action => action.key), DIMENSION_KEY], [actions]);
  // The key of the button holding focus, kept while focus falls to the page because that button went or could no longer be pressed.
  const focusKey = useRef<string | null>(null);
  const escape = useRef(onEscape); escape.current = onEscape;
  const room = useRef(onRoomChange); room.current = onRoomChange;
  useLayoutEffect(() => {
    const element = row.current; if (!element) return;
    // A view not measured yet has no places; the row waits for its size rather than saying it has no room.
    if (!pixelWidth || !pixelHeight) { setPosition(null); return; }
    const box = placeCadSketchSelectionActions(bounds, { width: element.offsetWidth, height: element.offsetHeight }, { width: pixelWidth, height: pixelHeight },
      selectionActionObstacles(element), covers);
    setPosition(current => !box ? 'none' : current !== null && current !== 'none' && current.left === box.left && current.top === box.top ? current : { left: box.left, top: box.top });
  }, [bounds, covers, actions, pixelWidth, pixelHeight]);
  const hidden = position === 'none', placed = position !== null;
  useLayoutEffect(() => { if (placed) room.current?.(!hidden); }, [placed, hidden]);
  useLayoutEffect(() => () => { room.current?.(true); }, []);
  useLayoutEffect(() => { setFocusIndex(index => Math.min(index, count - 1)); }, [count]);
  // The one tab stop, and the arrows, skip buttons that cannot be pressed now, which cannot take focus.
  const pressable = (index: number) => index === count - 1 ? model.dimensionAvailable : actions[index] !== undefined && actions[index].state !== 'blocked';
  const usable = (index: number) => !inactive && pressable(index);
  const indexes = Array.from({ length: count }, (_, index) => index);
  const stop = pressable(focusIndex) ? focusIndex : indexes.find(pressable) ?? focusIndex;
  /*
   * Focus survives an edit: the row stays while the edit is pending, and afterwards a button that went or can no longer be pressed hands focus
   * to the nearest one that can, else to the canvas. A row that hides, or goes, while it holds focus hands it to the canvas too.
   */
  useLayoutEffect(() => {
    const element = row.current, owner = focusKey.current;
    if (!element || owner === null || inactive) return;
    const active = document.activeElement, buttons = [...element.querySelectorAll<HTMLButtonElement>('button')];
    if (active && active !== document.body && !element.contains(active)) { focusKey.current = null; return; }
    const at = buttons.findIndex(button => button === active);
    if (at >= 0 && pressable(at) && !hidden) return;
    const from = keys.indexOf(owner) >= 0 ? keys.indexOf(owner) : Math.min(focusIndex, count - 1);
    const nearest = hidden ? undefined : [...indexes].sort((a, b) => Math.abs(a - from) - Math.abs(b - from) || a - b).find(pressable);
    if (nearest === undefined) { focusKey.current = null; escape.current(); return; }
    setFocusIndex(nearest); buttons[nearest]?.focus();
  });
  useLayoutEffect(() => { const element = row.current; return () => { if (element?.contains(document.activeElement)) escape.current(); }; }, []);
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onEscape(); return; }
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    const order = event.key === 'Home' ? indexes : event.key === 'End' ? [...indexes].reverse() : step ? indexes.slice(1).map(offset => (stop + step * offset + count) % count) : null;
    if (!order) return;
    event.preventDefault();
    const next = order.find(usable); if (next === undefined) return;
    setFocusIndex(next); row.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
  };
  const focused = (index: number) => { setFocusIndex(index); focusKey.current = keys[index] ?? null; };
  // Focus moving elsewhere ends the row's hold on it; focus falling to the page because its button went or was disabled does not. A button
  // being removed can be told blur while still in the page, so that case is decided once the render that removes it is done.
  const blurred = (event: FocusEvent<HTMLDivElement>) => {
    const related = event.relatedTarget, button = event.target, toolbar = event.currentTarget;
    if (related instanceof Node) { if (!toolbar.contains(related)) focusKey.current = null; return; }
    queueMicrotask(() => { if (button instanceof HTMLButtonElement && button.isConnected && !button.disabled && !toolbar.hidden && document.activeElement !== button) focusKey.current = null; });
  };
  return <div ref={row} className="cad-sketch-selection-actions" role="toolbar" aria-label="Relations for the selection" aria-busy={inactive || undefined} data-cad-sketch-selection-actions=""
    hidden={hidden || undefined} style={position && position !== 'none' ? { left: position.left, top: position.top } : { visibility: 'hidden' }} onKeyDown={move} onBlur={blurred}>
    {actions.map((action, index) => {
      const Icon = action.icon;
      return <Button key={action.key} type="button" size="icon" aria-label={action.label} aria-pressed={action.state === 'applied'} data-cad-relation-offer={action.key}
        data-state={action.state} title={action.help} disabled={action.state === 'blocked'} aria-disabled={inactive || undefined} tabIndex={index === stop ? 0 : -1}
        onFocus={() => focused(index)} onClick={() => { if (!inactive) model.onOffer(action.offer); }}><Icon size={14} /></Button>;
    })}
    <span className="cad-sketch-selection-actions-divider" aria-hidden="true" />
    <Button type="button" size="icon" aria-label="Dimension the selection" data-cad-relation-offer={DIMENSION_KEY} title={model.dimensionAvailable ? 'Dimension the selection, then click where the dimension goes.'
      : 'Choose one eligible point or edge, or two points, lines, arcs or circles.'} disabled={!model.dimensionAvailable} aria-disabled={inactive || undefined} tabIndex={stop === count - 1 ? 0 : -1}
      onFocus={() => focused(count - 1)} onClick={() => { if (!inactive) model.onDimension(); }}><MeasureIcon size={14} /></Button>
  </div>;
});
