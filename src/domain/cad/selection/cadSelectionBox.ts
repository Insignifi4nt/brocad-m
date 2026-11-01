/**
 * Window and crossing box selection. A box dragged rightward is a window and takes what lies wholly inside it; a box dragged leftward is a
 * crossing and takes whatever it touches. Every test here is linear in the points it is given.
 */
export type CadBoxMode = 'window' | 'crossing';
export interface CadScreenPoint { readonly x: number; readonly y: number }
export interface CadScreenRect { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }
export interface CadBoxTest { readonly inside: boolean; readonly touches: boolean }

/** The mode of a box from where the drag started and where it is now; a drag straight up or down is a window. */
export function cadBoxModeFor(start: CadScreenPoint, end: CadScreenPoint): CadBoxMode {
  return end.x >= start.x ? 'window' : 'crossing';
}

export function cadScreenRect(start: CadScreenPoint, end: CadScreenPoint): CadScreenRect {
  return { left: Math.min(start.x, end.x), top: Math.min(start.y, end.y), right: Math.max(start.x, end.x), bottom: Math.max(start.y, end.y) };
}

/** Whether a box of `mode` takes an item that lies wholly `inside` it, or merely `touches` it. */
export function cadBoxTakes(mode: CadBoxMode, test: CadBoxTest): boolean {
  return mode === 'window' ? test.inside : test.touches;
}

const inRect = (rect: CadScreenRect, point: CadScreenPoint) => point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;

/** Whether the segment from `a` to `b` meets the rectangle, by clipping it to the rectangle's slabs. */
export function cadBoxSegmentTouches(rect: CadScreenRect, a: CadScreenPoint, b: CadScreenPoint): boolean {
  let low = 0, high = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  for (const [delta, near, far] of [[dx, rect.left - a.x, rect.right - a.x], [dy, rect.top - a.y, rect.bottom - a.y]] as const) {
    if (delta === 0) { if (near > 0 || far < 0) return false; continue; }
    let enter = near / delta, exit = far / delta;
    if (enter > exit) [enter, exit] = [exit, enter];
    low = Math.max(low, enter); high = Math.min(high, exit);
    if (low > high) return false;
  }
  return true;
}

/** A polyline, open or closed, against the rectangle. Points the view cannot project are `null` and make the polyline not wholly inside. */
export function cadBoxPolyline(rect: CadScreenRect, points: readonly (CadScreenPoint | null)[], closed = false): CadBoxTest {
  let inside = points.length > 0, touches = false;
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    if (!point) { inside = false; continue; }
    if (inRect(rect, point)) touches = true; else inside = false;
    const next = index + 1 < points.length ? points[index + 1] : closed ? points[0] : null;
    if (!touches && next && cadBoxSegmentTouches(rect, point, next)) touches = true;
  }
  return { inside, touches };
}

const side = (a: CadScreenPoint, b: CadScreenPoint, point: CadScreenPoint) => (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
function inTriangle(a: CadScreenPoint, b: CadScreenPoint, c: CadScreenPoint, point: CadScreenPoint): boolean {
  const ab = side(a, b, point), bc = side(b, c, point), ca = side(c, a, point);
  return (ab >= 0 && bc >= 0 && ca >= 0) || (ab <= 0 && bc <= 0 && ca <= 0);
}

/**
 * Whether the triangle meets the rectangle: a corner of either inside the other, or an edge of the triangle crossing the rectangle. A
 * triangle of no area on screen, a point or a segment, meets it only where that point or segment does: it holds no rectangle corner.
 */
export function cadBoxTriangleTouches(rect: CadScreenRect, a: CadScreenPoint, b: CadScreenPoint, c: CadScreenPoint): boolean {
  if (inRect(rect, a) || inRect(rect, b) || inRect(rect, c)) return true;
  if (cadBoxSegmentTouches(rect, a, b) || cadBoxSegmentTouches(rect, b, c) || cadBoxSegmentTouches(rect, c, a)) return true;
  return side(a, b, c) !== 0 && inTriangle(a, b, c, { x: rect.left, y: rect.top });
}
