import { userFacingMessage } from '@/lib/userMessage';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { cadSketchGraphSelectionSet, isCadSketchGraphSelected, type CadSketchGraphSelection, type CadSketchGraphPickScope } from './cadSketchGraphSelection';
import { cadBoxModeFor, type CadBoxMode } from '@/domain/cad/selection/cadSelectionBox';
import type { prepareCadSketchGraphInteraction } from './cadSketchGraphInteraction';
import type { SketchPoint } from './cadSketchInteraction';

type Prepared = ReturnType<typeof prepareCadSketchGraphInteraction>;
type Projection = { point: SketchPoint; frame: string };
type Box = { readonly start: SketchPoint; readonly end: SketchPoint; readonly mode: CadBoxMode; readonly selections: readonly CadSketchGraphSelection[] };
interface Options {
  prepared: Prepared | null; enabled: boolean; locked: boolean; version?: string; cancelSignal: number; frameKey: string;
  filter: CadSketchGraphPickScope; selection: readonly CadSketchGraphSelection[];
  project(event: { clientX: number; clientY: number }): Projection | null;
  /** `additive` marks a Shift box, which adds to the selection rather than replacing it. */
  onSelectSet?(selection: readonly CadSketchGraphSelection[], additive?: boolean): void;
  onPendingChange(pending: boolean): void;
  onCancel(): void;
  onError(message: string): void;
}
interface Owner {
  pointerId: number; element: SVGSVGElement; clientX: number; clientY: number;
  start: SketchPoint; frame: string; base: readonly CadSketchGraphSelection[]; toggle: boolean; moved: boolean;
}

/** A box previews operands only. Release validates the whole set before one publication. */
export function useCadSketchBoxSelection(options: Options) {
  const latest = useRef(options); latest.current = options;
  const owner = useRef<Owner | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const cancel = useCallback((suppressClick = true) => {
    const active = owner.current; owner.current = null;
    setBox(null);
    if (!active) return;
    if (suppressClick) latest.current.onCancel();
    try { if (active.element.hasPointerCapture?.(active.pointerId)) active.element.releasePointerCapture(active.pointerId); } catch { /* Capture already ended. */ }
    latest.current.onPendingChange(false);
  }, []);
  useLayoutEffect(() => { cancel(); }, [options.prepared, options.version, options.enabled, options.locked, options.cancelSignal, options.frameKey, options.filter, cancel]);
  useEffect(() => {
    const blur = () => cancel(); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('blur', blur); cancel(); };
  }, [cancel]);
  const read = (event: PointerEvent<SVGSVGElement>) => {
    const active = owner.current, current = latest.current;
    if (!active || event.pointerId !== active.pointerId) return null;
    const projected = current.project(event);
    if (!current.enabled || current.locked || !projected || projected.frame !== active.frame) { cancel(); return null; }
    return { active, current, point: projected.point };
  };
  const query = (active: Owner, current: Options, point: SketchPoint, clientX: number): Box => {
    // Dragged rightwards the box is a window, leftwards a crossing box, by screen direction as CATIA, SOLIDWORKS and AutoCAD decide it.
    const mode = cadBoxModeFor({ x: active.clientX, y: active.clientY }, { x: clientX, y: 0 });
    const hits = current.prepared?.pickBox({ mode, filter: current.filter, bounds: {
      minX: Math.min(active.start[0], point[0]), minY: Math.min(active.start[1], point[1]),
      maxX: Math.max(active.start[0], point[0]), maxY: Math.max(active.start[1], point[1]),
    } }) ?? [];
    const selections = active.toggle ? [...active.base.filter(atom => !isCadSketchGraphSelected(hits, atom)), ...hits.filter(atom => !isCadSketchGraphSelected(active.base, atom))] : hits;
    return { start: active.start, end: point, mode, selections: cadSketchGraphSelectionSet(current.prepared?.graph, selections) };
  };
  return {
    box, pending: box !== null, active: () => owner.current !== null, cancel,
    begin(event: PointerEvent<SVGSVGElement>) {
      if (owner.current) { if (owner.current.pointerId !== event.pointerId) cancel(); return false; }
      const current = latest.current, projected = current.project(event);
      if (!current.enabled || current.locked || !current.prepared || !current.onSelectSet || !projected || event.button !== 0 || event.isPrimary === false) return false;
      event.preventDefault();
      const active: Owner = { pointerId: event.pointerId, element: event.currentTarget, clientX: event.clientX, clientY: event.clientY,
        start: projected.point, frame: projected.frame, base: current.selection, toggle: event.shiftKey, moved: false };
      owner.current = active;
      setBox({ start: active.start, end: active.start, mode: 'window', selections: active.base }); current.onPendingChange(true);
      try { active.element.setPointerCapture(active.pointerId); } catch { cancel(); }
      return true;
    },
    move(event: PointerEvent<SVGSVGElement>) {
      const next = read(event); if (!next) return;
      event.preventDefault();
      if (!(event.buttons & 1)) { cancel(); return; }
      if (!next.active.moved && Math.hypot(event.clientX - next.active.clientX, event.clientY - next.active.clientY) <= 4) return;
      next.active.moved = true;
      try { setBox(query(next.active, next.current, next.point, event.clientX)); }
      catch { setBox({ start: next.active.start, end: next.point, mode: cadBoxModeFor({ x: next.active.clientX, y: 0 }, { x: event.clientX, y: 0 }), selections: next.active.base }); }
    },
    end(event: PointerEvent<SVGSVGElement>) {
      const next = read(event); if (!next) return false;
      const moved = next.active.moved || Math.hypot(event.clientX - next.active.clientX, event.clientY - next.active.clientY) > 4;
      try {
        if (event.button === 0 && moved) next.current.onSelectSet?.(query(next.active, next.current, next.point, event.clientX).selections, next.active.toggle);
      } catch (cause) { next.current.onError(userFacingMessage(cause, 'Unable to select this geometry.')); }
      finally { cancel(false); }
      return moved;
    },
    cancelPointer(event: { pointerId: number }) { if (owner.current?.pointerId === event.pointerId) cancel(); },
  };
}
