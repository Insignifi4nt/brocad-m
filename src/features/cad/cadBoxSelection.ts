import type { CadMesh } from '@/domain/cad/cadDocument';
import type { CadTopologyPick } from '@/domain/cad/cadTopology';
import { cadBoxPolyline, cadBoxTakes, cadBoxTriangleTouches, type CadBoxMode, type CadBoxTest, type CadScreenPoint, type CadScreenRect } from '@/domain/cad/selection/cadSelectionBox';
export interface CadScreenBox { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }

/** The box spanned by a drag, whichever direction it went. */
export function cadScreenBox(start: { readonly x: number; readonly y: number }, end: { readonly x: number; readonly y: number }): CadScreenBox {
  return { left: Math.min(start.x, end.x), top: Math.min(start.y, end.y), right: Math.max(start.x, end.x), bottom: Math.max(start.y, end.y) };
}

/**
 * Screen extents of a body's vertices. `project` maps a world point to viewport pixels.
 * Returns null when no vertex is in front of the camera's clip range.
 */
export function cadProjectedBounds(positions: readonly number[], project: (x: number, y: number, z: number) => { readonly x: number; readonly y: number } | null): CadScreenBox | null {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (let index = 0; index + 2 < positions.length; index += 3) {
    const point = project(positions[index], positions[index + 1], positions[index + 2]);
    if (!point) continue;
    left = Math.min(left, point.x); right = Math.max(right, point.x);
    top = Math.min(top, point.y); bottom = Math.max(bottom, point.y);
  }
  return left <= right && top <= bottom ? { left, top, right, bottom } : null;
}

/**
 * The body a box selection takes: one whose whole projection lies inside the box. When several fit,
 * the largest on screen wins, so a box drawn around an assembly-sized body is not taken by a small one inside it.
 */
export function cadBoxSelectedBody(box: CadScreenBox, bodies: readonly { readonly featureId: string; readonly bounds: CadScreenBox | null }[], tolerance = 2): string | null {
  let best: { featureId: string; area: number } | null = null;
  for (const body of bodies) {
    const bounds = body.bounds;
    if (!bounds || bounds.left < box.left - tolerance || bounds.top < box.top - tolerance || bounds.right > box.right + tolerance || bounds.bottom > box.bottom + tolerance) continue;
    const area = (bounds.right - bounds.left) * (bounds.bottom - bounds.top);
    if (!best || area > best.area) best = { featureId: body.featureId, area };
  }
  return best?.featureId ?? null;
}

/** The kept side of a section: points whose signed distance `normal · point + constant` is not negative, as three.js clipping keeps them. */
export interface CadBoxClip { readonly normal: { readonly x: number; readonly y: number; readonly z: number }; readonly constant: number }

/** What a box in the model view selected: one body, the edges or faces of one body, or nothing. */
export type CadBoxTarget = { readonly kind: 'body'; readonly featureId: string }
  | { readonly kind: 'topology'; readonly bodyId: string; readonly picks: readonly CadTopologyPick[] } | null;

/**
 * What a box in the model view takes. A window, dragged rightward, takes what lies wholly inside it; a crossing, dragged leftward, what it
 * touches. Bodies come first when the filter and pick mode allow them, then edges, then faces; edges and faces come from the one body with
 * the most of them in the box. Hidden edges and faces count too. Each body's points are projected once, so the test is linear in its mesh.
 *
 * With a section `clip`, only the kept side counts, as only it is drawn: segments and triangles are cut at the plane before they are
 * tested, a window needs only the kept part inside it, and what the section removes entirely is neither inside nor touched.
 */
export function cadBoxSelection({ rect, mode, bodies, kinds, project, clip = null }: {
  rect: CadScreenRect; mode: CadBoxMode; bodies: readonly CadMesh[];
  kinds: { readonly body: boolean; readonly edge: boolean; readonly face: boolean };
  project(x: number, y: number, z: number): CadScreenPoint | null;
  clip?: CadBoxClip | null;
}): CadBoxTarget {
  type Points = readonly (CadScreenPoint | null)[];
  const projectAll = (values: readonly number[]) => {
    const points: (CadScreenPoint | null)[] = new Array(values.length / 3);
    for (let index = 0; index < points.length; index++) points[index] = project(values[index * 3], values[index * 3 + 1], values[index * 3 + 2]);
    return points;
  };
  /** Each point's signed distance to the section, or null with no section, so an uncut view pays nothing for it. */
  const distancesOf = (values: readonly number[]) => {
    if (!clip) return null;
    const { normal: { x, y, z }, constant } = clip, distances = new Float64Array(values.length / 3);
    for (let index = 0; index < distances.length; index++) distances[index] = x * values[index * 3] + y * values[index * 3 + 1] + z * values[index * 3 + 2] + constant;
    return distances;
  };
  /** Where the segment between points `a` and `b`, on either side of the section, crosses it, projected. */
  const cut = (values: readonly number[], distances: Float64Array, a: number, b: number) => {
    const t = distances[a] / (distances[a] - distances[b]);
    return project(values[a * 3] + (values[b * 3] - values[a * 3]) * t, values[a * 3 + 1] + (values[b * 3 + 1] - values[a * 3 + 1]) * t, values[a * 3 + 2] + (values[b * 3 + 2] - values[a * 3 + 2]) * t);
  };
  /** The kept part of segment `a`–`b` against the box, or null when the section removes all of it. */
  const segment = (values: readonly number[], points: Points, distances: Float64Array | null, a: number, b: number): CadBoxTest | null => {
    if (!distances || distances[a] >= 0 && distances[b] >= 0) return cadBoxPolyline(rect, [points[a] ?? null, points[b] ?? null]);
    if (distances[a] < 0 && distances[b] < 0) return null;
    const crossing = cut(values, distances, a, b);
    return cadBoxPolyline(rect, distances[a] >= 0 ? [points[a] ?? null, crossing] : [crossing, points[b] ?? null]);
  };
  /** The kept part of a triangle against the box, or null when the section removes all of it; `touches` is measured only when wanted. */
  const triangle = (values: readonly number[], points: Points, distances: Float64Array | null, corners: readonly [number, number, number], wantTouch: boolean): CadBoxTest | null => {
    let polygon: Points;
    if (!distances || corners.every(corner => distances[corner] >= 0)) polygon = corners.map(corner => points[corner] ?? null);
    else if (corners.every(corner => distances[corner] < 0)) return null;
    else {
      // One plane cuts a triangle into a triangle or a quadrilateral: its kept corners and the crossings, in order. A side crosses only
      // between corners strictly either side; a corner on the plane is kept as it is, and is not added again as a crossing. A section
      // exactly through a corner or a side keeps only that point or segment, which the box then tests as a point or a segment.
      const kept: (CadScreenPoint | null)[] = [];
      for (let index = 0; index < 3; index++) {
        const from = corners[index], to = corners[(index + 1) % 3];
        if (distances[from] >= 0) kept.push(points[from] ?? null);
        if (distances[from] > 0 && distances[to] < 0 || distances[from] < 0 && distances[to] > 0) kept.push(cut(values, distances, from, to));
      }
      polygon = kept;
    }
    if (polygon.some(point => !point)) return { inside: false, touches: false };
    const shown = polygon as readonly CadScreenPoint[];
    let touches = false;
    if (wantTouch && shown.length < 3) touches = cadBoxPolyline(rect, shown).touches;
    for (let index = 1; wantTouch && !touches && index + 1 < shown.length; index++) touches = cadBoxTriangleTouches(rect, shown[0], shown[index], shown[index + 1]);
    return { inside: cadBoxPolyline(rect, shown, true).inside, touches };
  };
  const triangles = (values: readonly number[], points: Points, distances: Float64Array | null, indices: readonly number[], start: number, end: number): CadBoxTest => {
    let kept = false, inside = true, touches = false;
    for (let at = start; at + 3 <= end && at + 2 < indices.length; at += 3) {
      const test = triangle(values, points, distances, [indices[at], indices[at + 1], indices[at + 2]], !touches);
      if (!test) continue;
      kept = true;
      if (!test.inside) inside = false;
      if (test.touches) touches = true;
      if (!inside && touches) break;
    }
    return { inside: kept && inside, touches };
  };
  /** Screen extents of what the section keeps of a body: its kept points and where its triangles' sides cross the plane. */
  const keptBounds = (body: CadMesh, points: Points, distances: Float64Array): CadScreenBox | null => {
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    const add = (point: CadScreenPoint | null) => {
      if (!point) return;
      left = Math.min(left, point.x); right = Math.max(right, point.x); top = Math.min(top, point.y); bottom = Math.max(bottom, point.y);
    };
    for (let index = 0; index < points.length; index++) if (distances[index] >= 0) add(points[index]);
    for (let at = 0; at + 2 < body.indices.length; at += 3) for (let side = 0; side < 3; side++) {
      const from = body.indices[at + side], to = body.indices[at + (side + 1) % 3];
      if (distances[from] >= 0 !== distances[to] >= 0) add(cut(body.positions, distances, from, to));
    }
    return left <= right && top <= bottom ? { left, top, right, bottom } : null;
  };
  if (kinds.body) {
    // A window keeps its body test: the whole projection of the kept part inside, the largest such body winning.
    const measured = bodies.map(body => {
      if (!clip) return { body, bounds: cadProjectedBounds(body.positions, project), points: null, distances: null };
      const points = projectAll(body.positions), distances = distancesOf(body.positions)!;
      return { body, bounds: keptBounds(body, points, distances), points, distances };
    });
    if (mode === 'window') {
      const featureId = cadBoxSelectedBody(rect, measured.map(({ body, bounds }) => ({ featureId: body.featureId, bounds })));
      return featureId ? { kind: 'body', featureId } : null;
    }
    let best: { featureId: string; area: number } | null = null;
    for (const { body, bounds, points, distances } of measured) {
      if (!bounds || bounds.right < rect.left || bounds.left > rect.right || bounds.bottom < rect.top || bounds.top > rect.bottom) continue;
      if (!triangles(body.positions, points ?? projectAll(body.positions), distances, body.indices, 0, body.indices.length).touches) continue;
      const area = (bounds.right - bounds.left) * (bounds.bottom - bounds.top);
      if (!best || area > best.area) best = { featureId: body.featureId, area };
    }
    return best ? { kind: 'body', featureId: best.featureId } : null;
  }
  for (const kind of ['edge', 'face'] as const) {
    if (!kinds[kind]) continue;
    let best: { bodyId: string; keys: string[] } | null = null;
    for (const body of bodies) {
      const keys: string[] = [];
      if (kind === 'edge') {
        const points = projectAll(body.edges), distances = distancesOf(body.edges);
        for (const group of body.edgeGroups) {
          let kept = false, inside = true, touches = false;
          for (let at = group.start; at + 1 < group.start + group.count; at += 2) {
            const test = segment(body.edges, points, distances, at, at + 1);
            if (!test) continue;
            kept = true;
            if (!test.inside) inside = false;
            if (test.touches) touches = true;
          }
          if (cadBoxTakes(mode, { inside: kept && inside, touches })) keys.push(group.key);
        }
      } else {
        const points = projectAll(body.positions), distances = distancesOf(body.positions);
        for (const group of body.faceGroups) if (cadBoxTakes(mode, triangles(body.positions, points, distances, body.indices, group.start, group.start + group.count))) keys.push(group.key);
      }
      if (keys.length && (!best || keys.length > best.keys.length)) best = { bodyId: body.featureId, keys };
    }
    if (best) return { kind: 'topology', bodyId: best.bodyId, picks: best.keys.map(key => ({ kind, key })) };
  }
  return null;
}
