import { describe, expect, it, vi } from 'vitest';
import type { CadDocument, CadMesh } from '@/domain/cad/cadDocument';
import { createCadDocument, parseCadDocument } from '@/domain/cad/cadSchema';
import type { CadSketchGenerator } from '@/domain/cad/cadSketchGraph';
import { cadDirectDepthTarget, createCadDirectDepthControl, type CadDirectDepthEnvironment } from './cadDirectDepthControl';
import { cadExtrudeDepthEdits, cadExtrudeEndFaceAt, cadExtrudeForEndFace, inspectCadExtrudeDepth } from './cadExtrudeDepthInteraction';
import type { CadFeaturePreviewCommand } from './cadFeaturePreview';

function part(distance: number | string = 20): CadDocument {
  return { ...createCadDocument('Direct depth', 'direct_depth'), parameters: { depth: 20 }, features: [
    { id: 'sketch', name: 'Outline', kind: 'sketch', suppressed: false, plane: 'XY', offset: 5, profiles: [
      { id: 'rectangle', name: 'Rectangle', construction: false, geometry: { kind: 'rectangle', x: 0, y: 0, width: 20, height: 10, cornerRadius: 0 } }
    ] },
    { id: 'pad', name: 'Pad', kind: 'extrude', suppressed: false, sketchId: 'sketch', distance, symmetric: false, operation: 'new', targetId: null }
  ] };
}
const model = (document: CadDocument) => {
  const result = inspectCadExtrudeDepth(document, document.features[1]); if (!result) throw new Error('Expected a depth model'); return result;
};
/** A box mesh for the Pad: its top cap (face:top) and one side wall (face:side). */
function padMesh(document: CadDocument, featureId = 'pad'): CadMesh {
  const { minX, maxX, minY, maxY } = model(document).materialBoundsMm, top = 25;
  const positions = [minX, minY, top, maxX, minY, top, maxX, maxY, top, minX, maxY, top, maxX, minY, 5, maxX, maxY, 5];
  const normals = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0];
  return { featureId, name: 'Pad', positions, normals, indices: [0, 1, 2, 0, 2, 3, 4, 5, 2, 4, 2, 1], edges: [],
    faceGroups: [{ key: 'face:top', start: 0, count: 6 }, { key: 'face:side', start: 6, count: 6 }], edgeGroups: [], volume: 1,
    bounds: { min: [minX, minY, 5], max: [maxX, maxY, top] } };
}

describe('direct Pad depth edits', () => {
  it('writes a literal Length or the bound parameter, refuses zero and leaves an unchanged Length alone', () => {
    const literal = part();
    expect(cadExtrudeDepthEdits(literal, 'pad', 32.5)).toEqual({ kind: 'edits', edits: [{ kind: 'update-feature', feature: { ...literal.features[1], distance: 32.5 } }] });
    expect(cadExtrudeDepthEdits(literal, 'pad', 20)).toEqual({ kind: 'unchanged' });
    expect(cadExtrudeDepthEdits(literal, 'pad', 0)).toMatchObject({ kind: 'locked' });
    expect(cadExtrudeDepthEdits(literal, 'sketch', 30)).toMatchObject({ kind: 'locked' });
    const bound = part(' depth ');
    expect(cadExtrudeDepthEdits(bound, 'pad', 30)).toEqual({ kind: 'edits', edits: [{ kind: 'update-feature', feature: bound.features[1] }, { kind: 'set-parameter', name: 'depth', value: 30 }] });
  });

  it('recognizes only points on the end cap with a parallel normal', () => {
    const depth = model(part()), { minX, maxX, minY, maxY } = depth.materialBoundsMm, center = [(minX + maxX) / 2, (minY + maxY) / 2] as const;
    expect(cadExtrudeEndFaceAt(depth, [center[0], center[1], 25], [0, 0, 1])).toBe(true);
    expect(cadExtrudeEndFaceAt(depth, [center[0], center[1], 25], [0, 0, -2])).toBe(true);
    expect(cadExtrudeEndFaceAt(depth, [center[0], center[1], 24], [0, 0, 1])).toBe(false);
    expect(cadExtrudeEndFaceAt(depth, [maxX + 1, center[1], 25], [0, 0, 1])).toBe(false);
    expect(cadExtrudeEndFaceAt(depth, [center[0], center[1], 25], [1, 0, 0])).toBe(false);
    expect(cadExtrudeEndFaceAt(depth, [center[0], center[1], 25], [0, 0, 0])).toBe(false);
  });

  it('finds the Pad that owns a picked end face and picks the selected Pad otherwise', () => {
    const document = part(), mesh = padMesh(document);
    expect(cadExtrudeForEndFace(document, mesh, 'face:top')).toBe('pad');
    expect(cadExtrudeForEndFace(document, mesh, 'face:side')).toBeNull();
    expect(cadExtrudeForEndFace(document, mesh, 'face:missing')).toBeNull();
    const pick = (key: string, kind: 'face' | 'edge' = 'face') => ({ documentVersion: 'v1', buildId: 'b1', bodyId: 'pad', picks: [{ kind, key }] });
    expect(cadDirectDepthTarget(document, [mesh], pick('face:top'), 'pad')).toBe('pad');
    expect(cadDirectDepthTarget(document, [mesh], pick('face:side'), 'pad')).toBeNull();
    expect(cadDirectDepthTarget(document, [mesh], pick('edge:1', 'edge'), 'pad')).toBeNull();
    expect(cadDirectDepthTarget(document, [mesh], { ...pick('face:top'), picks: [{ kind: 'face', key: 'face:top' }, { kind: 'face', key: 'face:side' }] }, 'pad')).toBeNull();
    expect(cadDirectDepthTarget(document, [], null, 'pad')).toBe('pad');
    expect(cadDirectDepthTarget(document, [], null, 'sketch')).toBeNull();
    const suppressed = { ...document, features: [document.features[0], { ...document.features[1], suppressed: true }] };
    expect(cadDirectDepthTarget(suppressed, [], null, 'pad')).toBeNull();
  });
});

describe('direct Pad depth control', () => {
  function harness(document = part(), asking = false) {
    const environment = { current: { document, documentVersion: 'v1', enabled: true } as CadDirectDepthEnvironment };
    const preview = vi.fn<(command: CadFeaturePreviewCommand) => void>(), commit = vi.fn(), gesture = vi.fn<(active: boolean) => void>(), ask = vi.fn();
    const control = createCadDirectDepthControl({ featureId: 'pad', baseVersion: 'v1', owner: 'direct', read: () => environment.current, preview, commit, onGestureChange: gesture,
      ...asking ? { ask } : {} });
    const begin = () => { const token = control.begin(control.getState()?.definitionKey ?? ''); if (!token) throw new Error('Expected a drag'); return token; };
    return { environment, preview, commit, gesture, ask, control, begin };
  }

  it('previews each Length and commits exactly one edit on release', () => {
    const { control, preview, commit, gesture, begin } = harness(), token = begin();
    expect(gesture).not.toHaveBeenCalled();
    expect(control.setQuantity(token, 27.123)).toBe(true);
    expect(control.setQuantity(token, 31.004)).toBe(true);
    expect(gesture.mock.calls).toEqual([[true]]);
    expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'candidate', owner: 'direct', expectedVersion: 'v1' }));
    expect(control.getState()).toMatchObject({ gestureActive: true, model: { quantityMm: 31 } });
    expect(control.release(token)).toBe(true);
    expect(gesture.mock.calls).toEqual([[true], [false]]);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][0]).toEqual([{ kind: 'update-feature', feature: expect.objectContaining({ id: 'pad', distance: 31 }) }]);
    expect(control.release(token)).toBe(false);
  });

  it('keeps the last valid Length through zero and restores the part on cancel', () => {
    const { control, preview, commit, gesture, begin } = harness(), token = begin();
    control.setQuantity(token, 30); preview.mockClear();
    expect(control.setQuantity(token, 0)).toBe(true);
    expect(preview).not.toHaveBeenCalled();
    expect(control.cancel(token)).toBe(true);
    expect(preview).toHaveBeenLastCalledWith({ kind: 'clear', owner: 'direct' });
    expect(gesture.mock.calls).toEqual([[true], [false]]);
    expect(commit).not.toHaveBeenCalled();
  });

  it('does not lock the workbench or commit when a press never changes the Length', () => {
    const { control, preview, commit, gesture, begin } = harness(), token = begin();
    control.setQuantity(token, 20.001);
    expect(control.release(token)).toBe(true);
    expect(gesture).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled();
    expect(preview).toHaveBeenLastCalledWith({ kind: 'clear', owner: 'direct' });
  });

  it('waits while another workflow owns the part and cancels a drag when the part changes', () => {
    const { control, environment, preview, commit, begin } = harness();
    environment.current = { ...environment.current, enabled: false };
    expect(control.getState()).toBeNull(); expect(control.begin('anything')).toBeNull();
    environment.current = { ...environment.current, enabled: true };
    const token = begin(); control.setQuantity(token, 30);
    environment.current = { ...environment.current, enabled: false };
    expect(control.getState()?.gestureActive).toBe(true);
    environment.current = { ...environment.current, document: part(40), documentVersion: 'v2', enabled: true };
    control.refresh();
    expect(preview).toHaveBeenLastCalledWith({ kind: 'clear', owner: 'direct' });
    expect(control.release(token)).toBe(false); expect(commit).not.toHaveBeenCalled();
    expect(control.getState()).toBeNull();
  });

  it('keeps the last valid Length when a drag reaches a value the part rejects', () => {
    const { control, preview, begin } = harness(), token = begin();
    control.setQuantity(token, 30); preview.mockClear();
    expect(control.setQuantity(token, 5_000_000)).toBe(true);
    expect(preview).not.toHaveBeenCalled();
    expect(control.getState()).toMatchObject({ gestureActive: true, model: { quantityMm: 30 } });
    expect(control.setQuantity(token, 31)).toBe(true); expect(control.getState()?.model.quantityMm).toBe(31);
  });

  it('drags only from an end face of its own Pad, not a coplanar face of another body', () => {
    const document = part(), sketch = document.features[0], pad = document.features[1];
    if (sketch.kind !== 'sketch' || pad.kind !== 'extrude') throw new Error('Expected a Pad');
    const two: CadDocument = { ...document, features: [...document.features,
      { ...sketch, id: 'boss-sketch', name: 'Boss', profiles: [{ ...sketch.profiles[0], id: 'boss-rectangle' }] }, { ...pad, id: 'boss', name: 'Boss', sketchId: 'boss-sketch' }] };
    const { control } = harness(two);
    expect(control.ownsEndFace?.(padMesh(two), 'face:top')).toBe(true);
    expect(control.ownsEndFace?.({ ...padMesh(two), featureId: 'boss' }, 'face:top')).toBe(false);
    expect(control.ownsEndFace?.(padMesh(two), 'face:side')).toBe(false);
  });

  it('applies nothing and hands the edits on to ask when released at a Length that removes relations, and commits a later Length that removes none', () => {
    // The Pad's Length is n, which also counts a polygon's sides; the center's distance to the fifth corner, "c4", lasts only while n is at least 5.
    const polygon: CadSketchGenerator = { id: 'poly', kind: 'generator', idPrefix: 'g-poly', construction: false,
      geometry: { kind: 'regular-polygon', x: 0, y: 0, radius: 10, sides: 'n', directionId: '@h' } };
    const base = part(' n ');
    const document = parseCadDocument({ ...base, schemaVersion: 2, parameters: { n: 5 }, features: [...base.features, { id: 'poly-sketch', name: 'Polygon', kind: 'sketch', suppressed: false,
      plane: 'XY', offset: 0, profiles: [], graph: { points: [{ id: 'u', position: [0, 0] }], entities: [], relations: [polygon, { id: 'c4', kind: 'distance', pointIds: ['u', 'g-poly_v4'], value: 10 }] } }] });
    const removing = [{ kind: 'update-feature', feature: document.features[1] }, { kind: 'set-parameter', name: 'n', value: 4 }];
    const first = harness(document, true), token = first.begin();
    expect(first.control.setQuantity(token, 4)).toBe(true);
    // The canvas shows no candidate the part refuses, and the release asks instead of committing.
    expect(first.preview).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'candidate' }));
    expect(first.control.release(token)).toBe(true);
    expect(first.ask.mock.calls).toEqual([[removing]]); expect(first.commit).not.toHaveBeenCalled();
    expect(first.preview).toHaveBeenLastCalledWith({ kind: 'clear', owner: 'direct' }); expect(first.control.getState()?.gestureActive).toBe(false);
    // A Length that removes nothing after one that would commits as before.
    const second = harness(document, true), again = second.begin();
    second.control.setQuantity(again, 4); second.control.setQuantity(again, 7);
    expect(second.control.release(again)).toBe(true);
    expect(second.ask).not.toHaveBeenCalled(); expect(second.commit.mock.calls).toEqual([[[removing[0], { kind: 'set-parameter', name: 'n', value: 7 }]]]);
    // A caller that cannot ask keeps the last Length that removes nothing.
    const silent = harness(document), quiet = silent.begin();
    silent.control.setQuantity(quiet, 7); silent.control.setQuantity(quiet, 4); silent.control.release(quiet);
    expect(silent.commit.mock.calls).toEqual([[[removing[0], { kind: 'set-parameter', name: 'n', value: 7 }]]]);
  });

  it('cancels an open drag when disposed', () => {
    const { control, preview, gesture, begin } = harness(), token = begin();
    control.setQuantity(token, 30); control.dispose();
    expect(gesture).toHaveBeenLastCalledWith(false);
    expect(preview).toHaveBeenLastCalledWith({ kind: 'clear', owner: 'direct' });
    expect(control.getState()).toBeNull();
  });
});
