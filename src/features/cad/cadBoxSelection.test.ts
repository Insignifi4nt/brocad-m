import { describe, expect, it } from 'vitest';
import type { CadMesh } from '@/domain/cad/cadDocument';
import { cadBoxSelectedBody, cadBoxSelection, cadProjectedBounds, cadScreenBox } from './cadBoxSelection';

/**
 * A flat plate seen from above: a left face from x 0 to 10 and a right face from 10 to 20, both 10 high, with its six outline edges and the
 * edge between the faces. `dx` moves it along x.
 */
function plate(featureId: string, dx = 0): CadMesh {
  const corners = [[0, 0], [10, 0], [20, 0], [20, 10], [10, 10], [0, 10]].map(([x, y]) => [x + dx, y, 0]);
  const segments = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0], [1, 4]];
  return { featureId, name: featureId, positions: corners.flat(), normals: corners.flatMap(() => [0, 0, 1]), indices: [0, 1, 4, 0, 4, 5, 1, 2, 3, 1, 3, 4],
    edges: segments.flatMap(([a, b]) => [...corners[a], ...corners[b]]), faceGroups: [{ start: 0, count: 6, key: 'left' }, { start: 6, count: 6, key: 'right' }],
    edgeGroups: segments.map((_, index) => ({ start: index * 2, count: 2, key: `e${index}` })), volume: 0, bounds: { min: [dx, 0, 0], max: [dx + 20, 10, 0] } };
}
const project = (x: number, y: number) => ({ x, y });

/** A box 10 by 10 by 8 high with a face group per side and an edge group per edge, seen from the front: z rises up the screen, 10 pixels a millimetre. */
function block(): CadMesh {
  const corners = [0, 1, 2, 3, 4, 5, 6, 7].map(index => [index & 1 ? 10 : 0, index & 2 ? 10 : 0, index & 4 ? 8 : 0]);
  const sides: [string, number[]][] = [['bottom', [0, 1, 3, 2]], ['top', [4, 5, 7, 6]], ['front', [0, 1, 5, 4]], ['back', [2, 3, 7, 6]], ['left', [0, 2, 6, 4]], ['right', [1, 3, 7, 5]]];
  const segments = [[0, 1], [2, 3], [0, 2], [1, 3], [4, 5], [6, 7], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  return { featureId: 'block', name: 'block', positions: corners.flat(), normals: corners.flatMap(() => [0, 0, 1]), indices: sides.flatMap(([, [a, b, c, d]]) => [a, b, c, a, c, d]),
    edges: segments.flatMap(([a, b]) => [...corners[a], ...corners[b]]), faceGroups: sides.map(([key], index) => ({ start: index * 6, count: 6, key })),
    edgeGroups: segments.map(([a, b], index) => ({ start: index * 2, count: 2, key: `${a}${b}` })), volume: 800, bounds: { min: [0, 0, 0], max: [10, 10, 8] } };
}
const front = (x: number, _y: number, z: number) => ({ x: x * 10, y: (8 - z) * 10 });

describe('cad box selection', () => {
  it('normalizes drags in any direction', () => {
    expect(cadScreenBox({ x: 80, y: 10 }, { x: 20, y: 60 })).toEqual({ left: 20, top: 10, right: 80, bottom: 60 });
  });

  it('projects every vertex and skips points outside the clip range', () => {
    const project = (x: number, y: number, z: number) => z < 0 ? null : { x: x * 2, y: 100 - y * 2 };
    expect(cadProjectedBounds([0, 0, 0, 10, 5, 1, 50, 50, -1], project)).toEqual({ left: 0, top: 90, right: 20, bottom: 100 });
    expect(cadProjectedBounds([1, 1, -1], project)).toBeNull();
  });

  it('selects only a body that fits wholly inside the box, preferring the largest one', () => {
    const bodies = [
      { featureId: 'small', bounds: { left: 40, top: 40, right: 60, bottom: 60 } },
      { featureId: 'large', bounds: { left: 20, top: 20, right: 120, bottom: 90 } },
      { featureId: 'hidden', bounds: null }
    ];
    expect(cadBoxSelectedBody({ left: 30, top: 30, right: 70, bottom: 70 }, bodies)).toBe('small');
    expect(cadBoxSelectedBody({ left: 19, top: 19, right: 121, bottom: 91 }, bodies)).toBe('large');
    // Crossing the large body's edge leaves only the small body fully enclosed.
    expect(cadBoxSelectedBody({ left: 25, top: 25, right: 100, bottom: 100 }, bodies)).toBe('small');
    expect(cadBoxSelectedBody({ left: 0, top: 0, right: 10, bottom: 10 }, bodies)).toBeNull();
  });

  it('takes what a window holds and what a crossing touches, as the filter allows', () => {
    const bodies = [plate('a'), plate('b', 100)], all = { body: true, edge: true, face: true };
    const select = (rect: { left: number; top: number; right: number; bottom: number }, mode: 'window' | 'crossing', kinds = all) => cadBoxSelection({ rect, mode, bodies, kinds, project });
    const keys = (target: ReturnType<typeof select>) => target?.kind === 'topology' ? target.picks.map(pick => `${pick.kind}:${pick.key}`).sort() : target;
    // Over the left face of the first plate only: a window holds no body, a crossing touches one.
    const left = { left: -1, top: -1, right: 11, bottom: 11 };
    expect(select(left, 'window')).toBeNull();
    expect(select(left, 'crossing')).toEqual({ kind: 'body', featureId: 'a' });
    expect(select({ left: -1, top: -1, right: 21, bottom: 11 }, 'window')).toEqual({ kind: 'body', featureId: 'a' });
    // With bodies filtered out the box takes edges, and with edges filtered out too, faces.
    expect(keys(select(left, 'window', { ...all, body: false }))).toEqual(['edge:e0', 'edge:e4', 'edge:e5', 'edge:e6']);
    expect(keys(select(left, 'crossing', { ...all, body: false }))).toEqual(['edge:e0', 'edge:e1', 'edge:e3', 'edge:e4', 'edge:e5', 'edge:e6']);
    expect(keys(select(left, 'window', { body: false, edge: false, face: true }))).toEqual(['face:left']);
    expect(keys(select({ left: 9, top: 4, right: 12, bottom: 6 }, 'crossing', { body: false, edge: false, face: true }))).toEqual(['face:left', 'face:right']);
    expect(select(left, 'crossing', { body: false, edge: false, face: false })).toBeNull();
    // A crossing inside a face touches it even though no corner or edge lies in the box.
    expect(keys(select({ left: 3, top: 3, right: 6, bottom: 6 }, 'crossing', { body: false, edge: false, face: true }))).toEqual(['face:left']);
    expect(select({ left: 3, top: 3, right: 6, bottom: 6 }, 'window', { body: false, edge: true, face: true })).toBeNull();
    // Edges come from the one body with the most of them in the box.
    const wide = { left: 15, top: -1, right: 121, bottom: 11 };
    expect(select(wide, 'window', { ...all, body: false })).toMatchObject({ kind: 'topology', bodyId: 'b' });
    // A point the view cannot project keeps what holds it from lying wholly inside.
    expect(cadBoxSelection({ rect: { left: -1, top: -1, right: 21, bottom: 11 }, mode: 'window', bodies: [plate('a')], kinds: { body: false, edge: true, face: false },
      project: (x, y) => x === 20 && y === 10 ? null : { x, y } })).toMatchObject({ picks: [{ key: 'e0' }, { key: 'e1' }, { key: 'e4' }, { key: 'e5' }, { key: 'e6' }] });
  });

  it('counts only what a section keeps, for a crossing and a window alike', () => {
    // The section keeps z up to 4: the lower half of the block, the lower half of the screen.
    const below = { normal: { x: 0, y: 0, z: -1 }, constant: 4 }, all = { body: true, edge: true, face: true };
    const edges = { body: false, edge: true, face: false }, faces = { body: false, edge: false, face: true };
    const select = (rect: { left: number; top: number; right: number; bottom: number }, mode: 'window' | 'crossing', kinds = all, clip: typeof below | null = below) =>
      cadBoxSelection({ rect, mode, bodies: [block()], kinds, project: front, clip });
    const keys = (target: ReturnType<typeof select>) => target?.kind === 'topology' ? target.picks.map(pick => pick.key).sort() : target;
    // A crossing wholly in the removed part, z 6 to 7, touches nothing that is drawn; uncut it takes the body, the sides and the upright edges.
    const removed = { left: -5, top: 10, right: 105, bottom: 20 };
    expect(select(removed, 'crossing', all, null)).toEqual({ kind: 'body', featureId: 'block' });
    expect(select(removed, 'crossing')).toBeNull();
    expect(keys(select(removed, 'crossing', edges, null))).toEqual(['04', '15', '26', '37']);
    expect(select(removed, 'crossing', edges)).toBeNull();
    expect(keys(select(removed, 'crossing', faces, null))).toEqual(['back', 'front', 'left', 'right']);
    expect(select(removed, 'crossing', faces)).toBeNull();
    // The same crossing over the kept part, and one inside a cut side's face, still take them.
    expect(select({ left: -5, top: 50, right: 105, bottom: 60 }, 'crossing')).toEqual({ kind: 'body', featureId: 'block' });
    expect(keys(select({ left: 40, top: 50, right: 60, bottom: 60 }, 'crossing', faces))).toEqual(['back', 'front']);
    // A window around the kept half holds the body, the bottom and the cut sides with their upright edges; the top, all removed, is not taken.
    const kept = { left: -5, top: 35, right: 105, bottom: 85 };
    expect(select(kept, 'window', all, null)).toBeNull();
    expect(select(kept, 'window')).toEqual({ kind: 'body', featureId: 'block' });
    expect(keys(select(kept, 'window', edges))).toEqual(['01', '02', '04', '13', '15', '23', '26', '37']);
    expect(keys(select(kept, 'window', faces))).toEqual(['back', 'bottom', 'front', 'left', 'right']);
    // A window around the whole block still leaves out what the section removed.
    expect(keys(select({ left: -5, top: -5, right: 105, bottom: 85 }, 'window', faces))).toEqual(['back', 'bottom', 'front', 'left', 'right']);
    // A window that holds only part of the kept half takes none of it.
    expect(select({ left: -5, top: 45, right: 105, bottom: 85 }, 'window')).toBeNull();
  });
  it('takes a face the section cuts down to a point or a segment only where that point or segment is', () => {
    // Faces of no edges, seen from above at 10 pixels a millimetre; the section keeps z up to 0.
    const faces = (corners: readonly (readonly [number, number, number])[], indices: readonly number[]): CadMesh => ({ featureId: 'part', name: 'part',
      positions: corners.flat(), normals: corners.flatMap(() => [0, 0, 1]), indices: [...indices], edges: [],
      faceGroups: Array.from({ length: indices.length / 3 }, (_, index) => ({ start: index * 3, count: 3, key: `f${index}` })), edgeGroups: [], volume: 0,
      bounds: { min: [-1, -1, -1], max: [1, 1, 1] } });
    const below = { normal: { x: 0, y: 0, z: -1 }, constant: 0 }, kinds = { body: false, edge: false, face: true };
    const above = (x: number, y: number) => ({ x: x * 10, y: y * 10 });
    const select = (mesh: CadMesh, rect: { left: number; top: number; right: number; bottom: number }, mode: 'window' | 'crossing') => {
      const target = cadBoxSelection({ rect, mode, bodies: [mesh], kinds, project: above, clip: below });
      return target?.kind === 'topology' ? target.picks.map(pick => pick.key).sort() : target;
    };
    // Through a corner: only the corner at the origin is kept.
    const corner = faces([[0, 0, 0], [1, 0, 1], [0, 1, 1]], [0, 1, 2]);
    expect(select(corner, { left: 100, top: 100, right: 101, bottom: 101 }, 'crossing')).toBeNull();
    expect(select(corner, { left: 4, top: 4, right: 6, bottom: 6 }, 'crossing')).toBeNull();
    expect(select(corner, { left: -1, top: -1, right: 1, bottom: 1 }, 'crossing')).toEqual(['f0']);
    expect(select(corner, { left: -1, top: -1, right: 1, bottom: 1 }, 'window')).toEqual(['f0']);
    expect(select(corner, { left: 1, top: 1, right: 20, bottom: 20 }, 'window')).toBeNull();
    // Through a side: only the side from the origin to x 1 is kept, not the rest of the triangle above it on screen.
    const side = faces([[0, 0, 0], [1, 0, 0], [0, 1, 1]], [0, 1, 2]);
    expect(select(side, { left: 4, top: -1, right: 6, bottom: 1 }, 'crossing')).toEqual(['f0']);
    expect(select(side, { left: 2, top: 2, right: 4, bottom: 4 }, 'crossing')).toBeNull();
    expect(select(side, { left: 100, top: 100, right: 101, bottom: 101 }, 'crossing')).toBeNull();
    expect(select(side, { left: -1, top: -1, right: 11, bottom: 1 }, 'window')).toEqual(['f0']);
    expect(select(side, { left: -1, top: -1, right: 6, bottom: 1 }, 'window')).toBeNull();
    // A closed tetrahedron with that corner and a fourth below: material stays in view, yet a crossing far from it takes nothing.
    const solid = faces([[0, 0, 0], [1, 0, 1], [0, 1, 1], [-1, -1, -1]], [0, 1, 2, 0, 3, 1, 0, 2, 3, 1, 3, 2]);
    expect(select(solid, { left: 100, top: 100, right: 101, bottom: 101 }, 'crossing')).toBeNull();
    expect(select(solid, { left: -11, top: -11, right: -9, bottom: -9 }, 'crossing')).toEqual(['f1', 'f2', 'f3']);
  });
});
