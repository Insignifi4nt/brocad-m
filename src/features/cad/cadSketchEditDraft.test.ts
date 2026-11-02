// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { CadDocument, CadSketchFeature } from '@/domain/cad/cadDocument';
import type { CadSketchGenerator } from '@/domain/cad/cadSketchGraph';
import type { CadEdit } from '@/domain/cad/cadOperations';
import { applyCadEdits } from '@/domain/cad/cadOperations';
import { createCadDocument, parseCadDocument } from '@/domain/cad/cadSchema';
import { prepareCadSketchCells } from '@/domain/cad/cadSketchRegionInspection';
import { CAD_GEAR_V3_PLUGIN, CAD_STAR_PLUGIN, createCadPluginProfile } from '@/domain/cad/plugins/cadPlugins';
import { expandCadSketchGenerators, storedCadSketchGraph } from '@/domain/cad/sketch-generators/cadSketchGenerators';
import { dxf, stock } from '@/domain/cad/__tests__/cadSketchRegionFixtures';
import { prepareCadEdits } from './cadEditPreparation';
import { CadSession } from './cadSession';
import { CadSketchEditDraft, type CadSketchAreaRepairInspection } from './cadSketchEditDraft';
import { endTrim, trimPart } from '@/domain/cad/__tests__/cadSketchTrimFixtures';
import { extendPart, lineExtend } from '@/domain/cad/__tests__/cadSketchExtendFixtures';
import { compileCadSketchGeometry } from '@/domain/cad/compileCadSketchGeometry';
import { pairedBoreMirrorPart, mirrorBoreRequest } from '@/domain/cad/__tests__/cadSketchMirrorFixtures';
import { dPlacement, placementPart, placementSketch } from '@/domain/cad/__tests__/cadSketchPlacementFixtures';
import { createCadSketchTestSolver } from './sketch-solver/__tests__/cadSketchTestSolver';

const solver = createCadSketchTestSolver();
const prepare = async (document: CadDocument, edits: readonly CadEdit[], signal?: AbortSignal) => (await prepareCadEdits(document, edits, solver, signal)).document;
const sketchOf = (document: CadDocument, id = 'sketch') => {
  const feature = document.features.find(feature => feature.id === id);
  if (feature?.kind !== 'sketch') throw new Error('Missing fixture sketch'); return feature;
};
function source(explicit = false, earlierGraph = false) {
  const sketch: CadSketchFeature = { id: 'sketch', kind: 'sketch', name: 'Consumed sketch', suppressed: false, plane: 'XY', offset: 0,
    source: { format: 'dxf', fileName: 'exact.dxf', text: dxf, units: 'mm' }, profiles: [], graph: {
      points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [' span ', 0] }, { id: 'c', position: [' span ', 10] }, { id: 'd', position: [0, 10] }],
      entities: [{ id: 'ab', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' },
        { id: 'bc', kind: 'line', construction: false, startPointId: 'b', endPointId: 'c' },
        { id: 'cd', kind: 'line', construction: false, startPointId: 'c', endPointId: 'd' },
        { id: 'da', kind: 'line', construction: false, startPointId: 'd', endPointId: 'a' }], relations: [] } };
  const parameters = { span: 20 };
  return parseCadDocument({ ...createCadDocument('Consumed part', 'consumed-part'), schemaVersion: 2, parameters,
    parameterGroups: [{ id: 'sizes', name: 'Sizes' }], parameterMetadata: { span: { groupId: 'sizes', source: { kind: 'manual' } } },
    features: [...(earlierGraph ? [{ id: 'earlier', kind: 'sketch', name: 'Earlier driver', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
      points: [{ id: 'origin', position: ['0', '0'] }, { id: 'tip', position: [20, 0] }], entities: [], relations: [
        { id: 'horizontal', kind: 'horizontal', pointIds: ['origin', 'tip'] }, { id: 'length', kind: 'distance', pointIds: ['origin', 'tip'], value: ' span ' }] } }] : []), sketch,
    { id: 'pad', name: 'Pad', kind: 'extrude', sketchId: 'sketch', distance: ' span / 2 ', symmetric: false, operation: 'new', targetId: null,
      suppressed: false, ...(explicit ? { regionSelection: prepareCadSketchCells(sketch, parameters).cells.map(cell => cell.reference) } : {}) },
    { id: 'later', kind: 'sketch', name: 'Later plugin', suppressed: false, plane: 'XY', offset: 0,
      profiles: [{ id: 'plugin', name: 'Exact plugin', construction: false, geometry: createCadPluginProfile(CAD_STAR_PLUGIN) }] }] });
}
const removeEdge: CadEdit = { kind: 'delete-sketch-elements', sketchId: 'sketch', pointIds: [], entityIds: ['bc'], relationIds: [], cascade: false };
function contourCells(repair: CadSketchAreaRepairInspection) {
  const cells = repair.consumers[0].cells;
  if (cells.mode !== 'contours') throw new Error('Expected existing whole-contour repair in this fixture.');
  return cells;
}

describe('owned consumed-sketch draft', () => {
  it('moves a dimension of the owned sketch at once, as one local undo step that Finish publishes, and prepares any other batch', async () => {
    const dimensioned = parseCadDocument({ ...source(), features: source().features.map(feature => feature.id !== 'sketch' || feature.kind !== 'sketch' ? feature
      : { ...feature, graph: { ...feature.graph!, relations: [{ id: 'width', kind: 'distance', pointIds: ['a', 'b'], value: ' span ' }] } }) });
    const main = new CadSession(dimensioned), base = main.getSnapshot(), draft = new CadSketchEditDraft(base, 'sketch'), local = draft.getSnapshot();
    const accepted = sketchOf(local.document).graph!.relations[0];
    const placing = (offset: number): CadEdit[] => [{ kind: 'set-sketch-relation', sketchId: 'sketch', relation: { ...accepted, annotation: { kind: 'linear', offset, along: 0.5 } } as typeof accepted }];
    const preparing = vi.fn(prepare), current = vi.fn();
    expect(() => draft.editPlacements([{ ...placing(4)[0], sketchId: 'later' } as CadEdit])).toThrow('sketch');
    expect(draft.editPlacements([{ kind: 'set-parameter', name: 'span', value: 30 }])).toBeNull();
    const moved = draft.editPlacements(placing(4), local.version, current);
    expect(current).toHaveBeenCalledOnce(); expect(moved?.canUndo).toBe(true); expect(draft.getSnapshot()).toBe(moved);
    expect(sketchOf(moved!.document).graph!.points).toBe(sketchOf(local.document).graph!.points);
    expect(() => draft.editPlacements(placing(5), local.version)).toThrow('The CAD draft changed');
    draft.undo(); expect(draft.getSnapshot().document).toBe(local.document); draft.redo();
    await draft.editPrepared([{ kind: 'set-parameter', name: 'span', value: 30 }], preparing);
    expect(preparing).toHaveBeenCalledOnce();
    expect(sketchOf(draft.getSnapshot().document).graph!.relations[0]).toMatchObject({ annotation: { kind: 'linear', offset: 4, along: 0.5 } });
    const finish = draft.finishEdits(base);
    expect(finish.edits.some(edit => edit.kind === 'update-feature' && edit.feature.kind === 'sketch'
      && edit.feature.graph?.relations[0].kind === 'distance' && 'annotation' in edit.feature.graph.relations[0])).toBe(true);
  });

  it('places a private detail with local no-op/Undo/Redo and one guarded full-part Finish', async () => {
    const main = new CadSession(placementPart()), base = main.getSnapshot(), draft = new CadSketchEditDraft(base, 'sketch');
    const edit = { kind: 'place-sketch-geometry', sketchId: 'sketch', ...dPlacement } as const;
    expect(() => draft.validateEdits([{ ...edit, sketchId: 'legacy' }])).toThrow('sketch');
    await draft.editPrepared([edit], prepare); const local = draft.getSnapshot();
    expect(main.getSnapshot()).toBe(base); expect(placementSketch(local.document).graph.points[0].position).toEqual([30, 20]);
    draft.undo(); const undone = draft.getSnapshot();
    await draft.editPrepared([{ ...edit, target: [0, 0], angleDegrees: 360 }], prepare);
    expect(draft.getSnapshot()).toBe(undone); expect(draft.getSnapshot().canRedo).toBe(true);
    draft.redo(); expect(draft.getSnapshot().document).toBe(local.document);
    const finish = draft.finishEdits(base);
    await main.editPrepared(base.version, document => prepare(document, finish.edits), undefined, () => draft.assertCurrent(main.getSnapshot(), finish.localVersion));
    expect(placementSketch(main.getSnapshot().document).graph).toEqual(placementSketch(local.document).graph);
    main.undo(); expect(main.getSnapshot().document).toBe(base.document); expect(main.getSnapshot().canUndo).toBe(false);
    const cancelled = new CadSketchEditDraft(main.getSnapshot(), 'sketch'); await cancelled.editPrepared([edit], prepare); cancelled.cancel();
    expect(main.getSnapshot().document).toBe(base.document); expect(main.getSnapshot().canRedo).toBe(true);
  });
  it('keeps Mirror copy private with local history and one explicit consumer repair at guarded Finish', async () => {
    const main = new CadSession(pairedBoreMirrorPart(true)), base = main.getSnapshot(), draft = new CadSketchEditDraft(base, 'sketch');
    const edit = { kind: 'mirror-sketch-geometry', sketchId: 'sketch', ...mirrorBoreRequest } as const;
    expect(() => draft.validateEdits([{ ...edit, sketchId: 'other' }])).toThrow('sketch');
    await draft.editPrepared([edit], prepare); const local = draft.getSnapshot();
    expect(main.getSnapshot()).toBe(base);
    const source = sketchOf(base.document), changed = sketchOf(local.document);
    expect(changed.graph?.entities.slice(0, source.graph?.entities.length)).toEqual(source.graph?.entities);
    draft.undo(); expect(draft.inspectAreaRepairs(base)).toBeNull(); draft.redo(); expect(draft.getSnapshot().document).toBe(local.document);
    await expect(prepare(base.document, draft.finishEdits(base).edits)).rejects.toMatchObject({ code: 'stale-sketch-region' });
    const repair = draft.inspectAreaRepairs(base); if (!repair) throw new Error('Bore plate repair missing.');
    const catalog = repair.consumers[0].cells, body = catalog.pick({ x: 5, y: 5 }); if (!body) throw new Error('Two-bore plate missing.');
    expect(body.areaMm2).toBeCloseTo(1800 - 18 * Math.PI, 10);
    const pad = base.document.features[1]; if (pad.kind !== 'extrude') throw new Error('Pad missing.');
    const regionSelection = catalog.pack([body.id]), finish = draft.finishEdits(base, [{ kind: 'update-feature', feature: { ...pad, regionSelection } }]);
    await main.editPrepared(base.version, document => prepare(document, finish.edits), undefined,
      () => draft.assertCurrent(main.getSnapshot(), finish.localVersion));
    const accepted = main.getSnapshot(); expect(accepted.document.features).toEqual([changed, { ...pad, regionSelection }]);
    main.undo(); expect(main.getSnapshot().document).toBe(base.document); expect(main.getSnapshot().canUndo).toBe(false);
    main.redo(); expect(main.getSnapshot().document).toBe(accepted.document);
  });
  it('repairs a vanished graph lens using current graph cells and accepts source plus explicit replacement in one undo', async () => {
    const sketch: CadSketchFeature = { id: 'lens', kind: 'sketch', name: 'Lens source', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
      points: [{ id: 'a', position: ['0.000', 0] }, { id: 'b', position: [' separation ', '0.00'] }], entities: [
        { id: 'left', kind: 'circle', construction: false, centerPointId: 'a', radius: '5.000' },
        { id: 'right', kind: 'circle', construction: false, centerPointId: 'b', radius: 5 }], relations: []
    } };
    const parameters = { separation: 6 }, cells = prepareCadSketchCells(sketch, parameters, 'graph-cells');
    const lens = cells.pick({ x: 3, y: 0 }); if (!lens) throw new Error('Lens missing.');
    const pad = { id: 'lens-pad', kind: 'extrude', name: 'Lens pad', suppressed: false, sketchId: sketch.id,
      distance: ' 5e0 ', symmetric: false, operation: 'new', targetId: null, regionSelection: cells.pack([lens.id]) } as const;
    const main = new CadSession(parseCadDocument({ ...createCadDocument(), schemaVersion: 2, parameters, features: [sketch, pad] }));
    const base = main.getSnapshot(), draft = new CadSketchEditDraft(base, sketch.id);
    await draft.editPrepared([{ kind: 'set-parameter', name: 'separation', value: 11 }], prepare);
    const local = draft.getSnapshot(); expect(main.getSnapshot()).toBe(base);
    expect(local.document.features[0]).toEqual(sketch);
    await expect(prepare(base.document, draft.finishEdits(base).edits)).rejects.toMatchObject({ code: 'stale-sketch-region' });
    const repair = draft.inspectAreaRepairs(base); if (!repair) throw new Error('Missing lens repair.');
    expect(repair.consumers).toHaveLength(1);
    const replacement = repair.consumers[0].cells;
    expect(replacement.mode).toBe('graph-cells'); expect(replacement.cells).toHaveLength(2);
    const disk = replacement.pick({ x: 0, y: 0 }); if (!disk) throw new Error('Current disk missing.');
    expect(disk.areaMm2).toBeCloseTo(25 * Math.PI, 10);
    draft.undo(); expect(draft.inspectAreaRepairs(base)).toBeNull(); draft.redo();
    const regionSelection = replacement.pack([disk.id]);
    const finish = draft.finishEdits(base, [{ kind: 'update-feature', feature: { ...pad, regionSelection } }]);
    await main.editPrepared(base.version, document => prepare(document, finish.edits), undefined,
      () => draft.assertCurrent(main.getSnapshot(), finish.localVersion));
    expect(main.getSnapshot().document.features).toEqual([sketch, { ...pad, regionSelection }]);
    expect(main.getSnapshot().document.parameters).toEqual({ separation: 11 });
    main.undo(); expect(main.getSnapshot().document).toBe(base.document); expect(main.getSnapshot().canUndo).toBe(false);
  });

  it('keeps a detached inset private, preserves local redo for zero, and finishes one guarded area repair with Cancel recovery', async () => {
    const main = new CadSession(source(true)), base = main.getSnapshot(), draft = new CadSketchEditDraft(base, 'sketch');
    const cycle = compileCadSketchGeometry(sketchOf(base.document), base.document.parameters).graph?.cycles[0];
    if (!cycle) throw new Error('Source cycle missing.');
    const edit = { kind: 'offset-sketch-loop', sketchId: 'sketch', source: { kind: 'graph-cycle', sourceRefs: cycle.sourceRefs }, distance: -1, idPrefix: 'inset' } satisfies CadEdit;
    expect(() => draft.validateEdits([{ ...edit, sketchId: 'later' }])).toThrow();
    await draft.editPrepared([edit], prepare); const local = draft.getSnapshot(); expect(main.getSnapshot()).toBe(base);
    expect(sketchOf(local.document).graph?.points.slice(0, 4)).toEqual(sketchOf(base.document).graph?.points);
    draft.undo(); const undone = draft.getSnapshot(); expect(undone.canRedo).toBe(true);
    await draft.editPrepared([{ ...edit, distance: 0 }], prepare); expect(draft.getSnapshot()).toBe(undone);
    draft.redo(); expect(draft.getSnapshot().document).toBe(local.document);
    const repair = draft.inspectAreaRepairs(base); if (!repair) throw new Error('Area repair missing.');
    const ring = contourCells(repair).cells.find(cell => cell.defaultMaterial); if (!ring) throw new Error('Inset ring missing.');
    expect(ring.areaMm2).toBeCloseTo(56, 10);
    const pad = base.document.features[1]; if (pad.kind !== 'extrude') throw new Error('Pad missing.');
    const finish = draft.finishEdits(base, [{ kind: 'update-feature', feature: { ...pad, regionSelection: [ring.reference] } }]);
    await main.editPrepared(base.version, document => prepare(document, finish.edits), undefined,
      () => draft.assertCurrent(main.getSnapshot(), finish.localVersion));
    const accepted = main.getSnapshot(); main.undo(); expect(main.getSnapshot().document).toBe(base.document); expect(main.getSnapshot().canUndo).toBe(false);
    main.redo(); expect(main.getSnapshot().document).toBe(accepted.document); main.undo();
    const cancelled = new CadSketchEditDraft(main.getSnapshot(), 'sketch'); let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pending = cancelled.editPrepared([edit], async (document, edits, signal) => { await gate; return prepare(document, edits, signal); });
    cancelled.cancel(); release(); await expect(pending).rejects.toThrow(); expect(main.getSnapshot().canRedo).toBe(true);
  });
  it.each([
    { name: 'Trim', part: trimPart, edit: { kind: 'trim-sketch-entity', sketchId: 'sketch', trim: endTrim } satisfies CadEdit },
    { name: 'Extend', part: extendPart, edit: { kind: 'extend-sketch-entity', sketchId: 'sketch', extend: lineExtend } satisfies CadEdit }
  ])('$name keeps consumed geometry private with local history, explicit area repair, deferred Cancel and one global Finish', async ({ name, part, edit }) => {
    const main = new CadSession(part(true)), base = main.getSnapshot(), draft = new CadSketchEditDraft(base, 'sketch');
    expect(() => draft.validateEdits([{ ...edit, sketchId: 'other' }])).toThrow('sketch');
    await draft.editPrepared([edit], prepare);
    const local = draft.getSnapshot();
    expect(main.getSnapshot()).toBe(base); expect(sketchOf(local.document).source).toEqual(sketchOf(base.document).source);
    draft.undo(); expect(draft.getSnapshot().document).toEqual(draft.initialDocument); expect(draft.inspectAreaRepairs(base)).toBeNull();
    draft.redo(); expect(draft.getSnapshot().document).toBe(local.document);
    await expect(prepare(base.document, draft.finishEdits(base).edits)).rejects.toMatchObject({ code: 'stale-sketch-region' });
    const repair = draft.inspectAreaRepairs(base); if (!repair) throw new Error('Missing area repair.');
    const currentCells = repair.consumers[0].cells;
    // Extend leaves an open overhang at a real T-joint. The graph catalog also
    // exposes that closed plate; deliberately retain the other original blank.
    expect(currentCells.cells).toHaveLength(name === 'Extend' ? 2 : 1);
    expect(currentCells.cells.every(cell => cell.areaMm2 === 200)).toBe(true);
    const pad = base.document.features[1]; if (pad.kind !== 'extrude') throw new Error('Missing pad.');
    const remaining = currentCells.pick({ x: 50, y: 5 }); if (!remaining) throw new Error('Remaining original blank missing.');
    const regionSelection = currentCells.pack([remaining.id]);
    const finish = draft.finishEdits(base, [{ kind: 'update-feature', feature: { ...pad, regionSelection } }]);
    await main.editPrepared(base.version, document => prepare(document, finish.edits), undefined,
      () => draft.assertCurrent(main.getSnapshot(), finish.localVersion));
    const accepted = main.getSnapshot(); expect(accepted.document.features[1]).toEqual({ ...pad, regionSelection });
    main.undo(); expect(main.getSnapshot().document).toBe(base.document); expect(main.getSnapshot().canUndo).toBe(false);
    main.redo(); expect(main.getSnapshot().document).toBe(accepted.document);
    const cancelBase = main.getSnapshot(); main.undo();
    const cancelled = new CadSketchEditDraft(main.getSnapshot(), 'sketch'); let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pending = cancelled.editPrepared([edit], async (document, edits, signal) => { await gate; return prepare(document, edits, signal); });
    cancelled.cancel(); release(); await expect(pending).rejects.toThrow();
    expect(main.getSnapshot().canRedo).toBe(true); main.redo(); expect(main.getSnapshot().document).toBe(cancelBase.document);
  });

  it('splits a consumed edge privately and requires explicit area repair before one guarded Finish', async () => {
    const main = new CadSession(source(true)), base = main.getSnapshot(), draft = new CadSketchEditDraft(base, 'sketch');
    const split = { kind: 'split-sketch-entity', sketchId: 'sketch', split: { kind: 'line', entityId: 'ab', parameter: .25,
      splitPointId: 'cut', newEntityId: 'after', supportRelationId: 'support' } } satisfies CadEdit;
    expect(() => draft.validateEdits([{ ...split, sketchId: 'later' }])).toThrow('sketch');
    await draft.editPrepared([split], prepare);
    const local = draft.getSnapshot(), localSketch = sketchOf(local.document);
    expect(main.getSnapshot()).toBe(base);
    expect(localSketch.graph?.points.slice(0, 4)).toEqual(sketchOf(base.document).graph?.points);
    expect(localSketch.graph?.points[4]).toEqual({ id: 'cut', position: [5, 0] });
    expect(localSketch.source).toEqual(sketchOf(base.document).source);
    draft.undo(); expect(draft.getSnapshot().document).toEqual(draft.initialDocument); expect(draft.inspectAreaRepairs(base)).toBeNull();
    draft.redo(); expect(draft.getSnapshot().document).toBe(local.document);
    await expect(prepare(base.document, draft.finishEdits(base).edits)).rejects.toThrow();
    const repair = draft.inspectAreaRepairs(base); if (!repair) throw new Error('Split area repair missing');
    expect(repair.consumers.map(consumer => consumer.feature.id)).toEqual(['pad']);
    expect(contourCells(repair).cells).toHaveLength(1);
    expect(contourCells(repair).cells[0]).toMatchObject({ areaMm2: 200, boundaryLengthMm: 60 });
    const pad = base.document.features[1]; if (pad.kind !== 'extrude') throw new Error('Missing pad');
    const regionSelection = contourCells(repair).cells.map(cell => cell.reference);
    expect(regionSelection).not.toEqual(pad.regionSelection); expect(JSON.stringify(regionSelection)).toContain('after');
    const finish = draft.finishEdits(base, [{ kind: 'update-feature', feature: { ...pad, regionSelection } }]);
    await main.editPrepared(base.version, document => prepare(document, finish.edits), undefined, () => draft.assertCurrent(main.getSnapshot(), finish.localVersion));
    const accepted = main.getSnapshot();
    expect(accepted.document.features[1]).toEqual({ ...pad, regionSelection });
    expect(accepted.document.features.slice(2)).toEqual(base.document.features.slice(2));
    expect(sketchOf(accepted.document).source).toEqual(sketchOf(base.document).source);
    main.undo(); expect(main.getSnapshot().document).toBe(base.document); expect(main.getSnapshot().canUndo).toBe(false);
    const cancelBase = main.getSnapshot(), cancelled = new CadSketchEditDraft(cancelBase, 'sketch');
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pending = cancelled.editPrepared([split], async (document, edits, signal) => { await gate; return prepare(document, edits, signal); });
    cancelled.cancel(); const retained = cancelled.getSnapshot(); release();
    await expect(pending).rejects.toThrow(); expect(cancelled.getSnapshot()).toBe(retained); expect(main.getSnapshot()).toBe(cancelBase);
    expect(main.getSnapshot().canRedo).toBe(true); main.redo(); expect(main.getSnapshot().document).toBe(accepted.document);
  });

  it('moves a consumed graph privately, retains exact drivers/source and finishes as one global undo', async () => {
    const main = new CadSession(source()), base = main.getSnapshot(), draft = new CadSketchEditDraft(base, 'sketch');
    const move: CadEdit = { kind: 'translate-sketch-geometry', sketchId: 'sketch', selections: ['ab', 'bc', 'cd', 'da'].map(id => ({ kind: 'entity', id })), translation: [0, 5] };
    expect(() => draft.validateEdits([{ ...move, sketchId: 'later' }])).toThrow('sketch');
    await draft.editPrepared([move], prepare);
    expect(main.getSnapshot()).toBe(base);
    const moved = draft.getSnapshot();
    expect(sketchOf(moved.document).graph?.points.map(point => point.position)).toEqual([[0, 5], [' span ', 5], [' span ', 15], [0, 15]]);
    expect(sketchOf(moved.document).source).toEqual(sketchOf(base.document).source);
    draft.undo(); expect(draft.getSnapshot().document).toEqual(draft.initialDocument);
    draft.redo(); expect(draft.getSnapshot().document).toBe(moved.document);
    const finish = draft.finishEdits(base);
    await main.editPrepared(base.version, document => prepare(document, finish.edits));
    expect(main.getSnapshot().document.features.slice(1)).toEqual(base.document.features.slice(1));
    main.undo(); expect(main.getSnapshot().document).toBe(base.document); expect(main.getSnapshot().canUndo).toBe(false);
  });

  it('creates a parametric corner locally and finishes it without changing the original DXF or downstream definitions', async () => {
    const main = new CadSession(source()), base = main.getSnapshot(), draft = new CadSketchEditDraft(base, 'sketch');
    const edit: CadEdit = { kind: 'create-sketch-corner', sketchId: 'sketch', pointId: 'a', treatment: {
      kind: 'fillet', radius: ' span / 10 ', trimPointIds: ['p', 'q'], centerPointId: 'center', entityId: 'arc', relationId: 'corner'
    } };
    expect(() => draft.validateEdits([{ ...edit, sketchId: 'later' }])).toThrow('sketch');
    await draft.editPrepared([edit], prepare);
    expect(main.getSnapshot()).toBe(base);
    const local = sketchOf(draft.getSnapshot().document);
    expect(local.source).toEqual(sketchOf(base.document).source);
    expect(local.graph?.relations).toContainEqual(expect.objectContaining({ id: 'corner', kind: 'fillet-corner', value: ' span / 10 ' }));
    const finish = draft.finishEdits(base);
    await main.editPrepared(base.version, document => prepare(document, finish.edits));
    expect(main.getSnapshot().document.features.slice(1)).toEqual(base.document.features.slice(1));
    expect(sketchOf(main.getSnapshot().document).source).toEqual(sketchOf(base.document).source);
    main.undo(); expect(main.getSnapshot().document).toBe(base.document);
  });

  it('edits an open prefix, keeps the valid full part exact, and reuses local bounded undo/redo', async () => {
    const main = new CadSession(source()), base = main.getSnapshot(), draft = new CadSketchEditDraft(base, 'sketch');
    expect(draft.getSnapshot().document.features.map(feature => feature.id)).toEqual(['sketch']);
    expect(() => applyCadEdits(base.document, [removeEdge])).toThrow();
    await draft.editPrepared([removeEdge], prepare);
    expect(sketchOf(draft.getSnapshot().document).graph?.entities.map(entity => entity.id)).toEqual(['ab', 'cd', 'da']);
    expect(main.getSnapshot()).toBe(base); expect(parseCadDocument(base.document)).toBe(base.document);
    const open = draft.getSnapshot(); draft.undo();
    expect(draft.getSnapshot().document).toEqual(draft.initialDocument);
    expect(draft.getSnapshot().canRedo).toBe(true); draft.redo(); expect(draft.getSnapshot().document).toBe(open.document);
    expect(main.getSnapshot()).toBe(base);
    const retained = draft.getSnapshot(), finish = draft.finishEdits(base);
    await expect(prepare(base.document, finish.edits)).rejects.toThrow();
    expect(draft.getSnapshot()).toBe(retained); expect(main.getSnapshot()).toBe(base);
  });

  it('finishes a reconnected sketch as one atomic source snapshot instead of replaying local commands', async () => {
    const main = new CadSession(source()), base = main.getSnapshot(), draft = new CadSketchEditDraft(base, 'sketch');
    await draft.editPrepared([removeEdge], prepare);
    await draft.editPrepared([{ kind: 'append-sketch-entities', sketchId: 'sketch', geometry: { points: [], relations: [], entities: [
      { id: 'replacement', kind: 'line', construction: false, startPointId: 'b', endPointId: 'c' }] } }], prepare);
    const finish = draft.finishEdits(base);
    expect(finish).toMatchObject({ baseVersion: base.version, localVersion: draft.getSnapshot().version, noOp: false });
    expect(finish.edits.map(edit => edit.kind)).toEqual(['update-feature']);
    await main.editPrepared(base.version, document => prepare(document, finish.edits), undefined, () => draft.assertCurrent(main.getSnapshot(), finish.localVersion));
    const accepted = main.getSnapshot(); expect(accepted.canUndo).toBe(true);
    expect(sketchOf(accepted.document).graph?.entities.some(entity => entity.id === 'replacement')).toBe(true);
    expect(accepted.document.features.slice(1)).toEqual(base.document.features.slice(1));
    main.undo(); expect(main.getSnapshot().document).toBe(base.document); expect(main.getSnapshot().canUndo).toBe(false);
    main.redo(); expect(main.getSnapshot().document).toBe(accepted.document);
  });

  it('requires explicit new area witnesses when a consumed contour identity changes', async () => {
    const main = new CadSession(source(true)), base = main.getSnapshot(), draft = new CadSketchEditDraft(base, 'sketch');
    expect(draft.inspectAreaRepairs(base)).toBeNull();
    await draft.editPrepared([removeEdge], prepare);
    expect(() => draft.inspectAreaRepairs(base)).toThrow(expect.objectContaining({ code: 'SKETCH_AREA_REPAIR_UNAVAILABLE' }));
    await draft.editPrepared([{ kind: 'append-sketch-entities', sketchId: 'sketch', geometry: { points: [], relations: [], entities: [
      { id: 'replacement', kind: 'line', construction: false, startPointId: 'b', endPointId: 'c' }] } }], prepare);
    await expect(prepare(base.document, draft.finishEdits(base).edits)).rejects.toThrow();
    const pad = base.document.features.find(feature => feature.id === 'pad'); if (pad?.kind !== 'extrude') throw new Error('Missing pad');
    const repair = draft.inspectAreaRepairs(base); if (!repair) throw new Error('Missing area repair');
    expect(repair).toMatchObject({ sketchId: 'sketch', localVersion: draft.getSnapshot().version, consumers: [{ feature: pad, issue: expect.any(String) }] });
    expect(repair.consumers[0].feature).toBe(pad);
    const regionSelection = contourCells(repair).cells.map(cell => cell.reference);
    expect(JSON.stringify(regionSelection)).toContain('replacement');
    const finish = draft.finishEdits(base, [{ kind: 'update-feature', feature: { ...pad, regionSelection } }]);
    const result = await prepare(base.document, finish.edits);
    expect(result.features[1]).toMatchObject({ regionSelection }); expect(main.getSnapshot()).toBe(base);
  });

  it('preserves valid, suppressed and whole-sketch consumers while inspecting only stale active explicit choices', async () => {
    const original = source(true), sketch = sketchOf(original), pad = original.features[1]; if (pad.kind !== 'extrude') throw new Error('Missing pad');
    const mixed = { ...sketch, profiles: [{ id: 'separate', name: 'Separate', construction: false, geometry: { kind: 'circle' as const, x: 50, y: 0, radius: 2 } }] };
    const unchangedSelection = prepareCadSketchCells(mixed, original.parameters).cells.filter(cell => cell.reference.boundaryProfileId === 'separate').map(cell => cell.reference);
    const { regionSelection: _explicit, ...whole } = pad;
    const document = parseCadDocument({ ...original, features: [...stock(), mixed, pad,
      { id: 'pocket', name: 'Pocket', kind: 'pocket', suppressed: false, sketchId: 'sketch', targetId: 'stock', extent: { kind: 'through-all', direction: 'both' }, regionSelection: pad.regionSelection },
      { ...pad, id: 'suppressed', suppressed: true },
      { ...pad, id: 'valid', regionSelection: unchangedSelection }, { ...whole, id: 'whole' }, ...original.features.slice(2)] });
    const main = new CadSession(document), base = main.getSnapshot(), draft = new CadSketchEditDraft(base, 'sketch');
    await draft.editPrepared([removeEdge, { kind: 'append-sketch-entities', sketchId: 'sketch', geometry: { points: [], relations: [], entities: [
      { id: 'replacement', kind: 'line', construction: false, startPointId: 'b', endPointId: 'c' }] } }], prepare);
    const local = draft.getSnapshot(), repair = draft.inspectAreaRepairs(base);
    expect(repair?.consumers.map(consumer => consumer.feature.id)).toEqual(['pad', 'pocket']);
    expect(repair?.consumers.every(consumer => consumer.cells.cells.length === 2)).toBe(true); expect(draft.getSnapshot()).toBe(local); expect(main.getSnapshot()).toBe(base);
    draft.cancel(); expect(() => draft.inspectAreaRepairs(base)).toThrow(expect.objectContaining({ code: 'SKETCH_DRAFT_CLOSED' }));
  });

  it('keeps solved earlier numeric graphs when linked parameters change, without weakening exact drivers or suffix source', async () => {
    const main = new CadSession(source(false, true)), base = main.getSnapshot(), draft = new CadSketchEditDraft(base, 'sketch');
    await draft.editPrepared([{ kind: 'set-parameter', name: 'span', value: 30 },
      { kind: 'set-sketch-relation', sketchId: 'sketch', relation: { id: 'horizontal', kind: 'horizontal', pointIds: ['a', 'b'] } }], prepare);
    expect(sketchOf(draft.getSnapshot().document, 'earlier').graph?.points[1].position).toEqual([30, 0]);
    const finish = draft.finishEdits(base);
    expect(finish.edits.map(edit => edit.kind === 'update-feature' ? edit.feature.id : edit.kind)).toEqual(['set-parameter', 'earlier', 'sketch']);
    const final = await prepare(base.document, finish.edits);
    expect(sketchOf(final, 'earlier').graph?.points[0].position).toEqual(['0', '0']);
    expect(sketchOf(final, 'earlier').graph?.relations[1]).toMatchObject({ value: ' span ' });
    expect(sketchOf(final).graph?.points[1].position).toEqual([' span ', 0]);
    expect(final.parameterMetadata).toEqual(base.document.parameterMetadata);
    expect(final.parameterGroups).toEqual(base.document.parameterGroups);
    expect(final.features.slice(2)).toEqual(base.document.features.slice(2));
    expect(sketchOf(final).source).toEqual(sketchOf(base.document).source); expect(main.getSnapshot()).toBe(base);
  });

  it('lets an earlier generator regenerate under a changed parameter, removing only the relations the draft confirms, through Finish', async () => {
    const polygon: CadSketchGenerator = { id: 'poly', kind: 'generator', idPrefix: 'poly', construction: false,
      geometry: { kind: 'regular-polygon', x: 0, y: 0, radius: 10, sides: 'n', directionId: '@h' } };
    const corner = expandCadSketchGenerators({ points: [], entities: [], relations: [polygon] }, { n: 6 }).points.find(point => point.id === 'poly_v5')!.position;
    const original = source(), document = parseCadDocument({ ...original, parameters: { ...original.parameters, n: 6 },
      parameterMetadata: { ...original.parameterMetadata, n: { source: { kind: 'manual' } } },
      features: [{ id: 'earlier', kind: 'sketch', name: 'Earlier polygon', suppressed: false, plane: 'XY', offset: 0, profiles: [],
        graph: { points: [{ id: 'u', position: corner }], entities: [], relations: [polygon, { id: 'tie', kind: 'coincident', pointIds: ['u', 'poly_v5'] }] } },
        ...original.features] });
    const main = new CadSession(document), base = main.getSnapshot(), draft = new CadSketchEditDraft(base, 'sketch');
    const ids = (snapshot: { document: CadDocument }) => sketchOf(snapshot.document, 'earlier').graph!.points.map(point => point.id);
    const stored = (snapshot: { document: CadDocument }) => storedCadSketchGraph(sketchOf(snapshot.document, 'earlier').graph!);
    // Seven sides add a corner and an edge to the earlier polygon, which keeps its record and the relation on the sixth corner.
    await draft.editPrepared([{ kind: 'set-parameter', name: 'n', value: 7 }], prepare);
    const seven = draft.getSnapshot();
    expect(ids(seven)).toContain('poly_v6');
    expect(stored(seven).relations).toEqual(stored(base).relations);
    // Five sides lose that corner: the draft refuses until its edit confirms the relation it removes, then removes only that one.
    await expect(draft.editPrepared([{ kind: 'set-parameter', name: 'n', value: 5 }], prepare))
      .rejects.toMatchObject({ code: 'unconfirmed-sketch-generator-removals', relationIds: ['tie'] });
    expect(draft.getSnapshot()).toBe(seven);
    await draft.editPrepared([{ kind: 'set-parameter', name: 'n', value: 5, removedRelationIds: ['tie'] }], prepare);
    const five = draft.getSnapshot();
    expect(ids(five)).not.toContain('poly_v5');
    expect(stored(five).relations.map(relation => relation.id)).toEqual(['poly']);
    draft.undo(); expect(draft.getSnapshot().document).toBe(seven.document);
    draft.redo(); expect(draft.getSnapshot().document).toBe(five.document);
    // A prepared prefix may not drop an earlier relation, change an earlier generator's record though its members match it, or add a feature.
    const earlierOf = (value: CadDocument) => sketchOf(value, 'earlier');
    const withEarlier = (value: CadDocument, graph: CadSketchFeature['graph']) => parseCadDocument({ ...value, features: value.features.map(feature => feature.id === 'earlier' ? { ...earlierOf(value), graph } : feature) });
    const unsanctioned = [
      async (value: CadDocument, edits: readonly CadEdit[]) => { const next = await prepare(value, edits), graph = stored({ document: next });
        return withEarlier(next, { ...graph, relations: graph.relations.filter(relation => relation.id !== 'tie') }); },
      async (value: CadDocument, edits: readonly CadEdit[]) => { const next = await prepare(value, edits), graph = stored({ document: next });
        return withEarlier(next, { ...graph, relations: graph.relations.map(relation => relation.kind === 'generator' ? { ...relation, construction: true } : relation) }); },
      async (value: CadDocument, edits: readonly CadEdit[]) => { const next = await prepare(value, edits);
        return parseCadDocument({ ...next, features: [...next.features, { id: 'extra', kind: 'sketch', name: 'Extra', suppressed: false, plane: 'XY', offset: 0, profiles: [] }] }); }];
    draft.undo();
    for (const preparation of unsanctioned)
      await expect(draft.editPrepared([{ kind: 'set-parameter', name: 'span', value: 25 }], preparation)).rejects.toMatchObject({ code: 'SKETCH_DRAFT_SCOPE' });
    expect(draft.getSnapshot().document).toBe(seven.document);
    draft.redo();
    // Finish publishes the parameter and the regenerated earlier sketch, which the full part accepts as the draft showed it.
    const finish = draft.finishEdits(base);
    expect(finish.edits.map(edit => edit.kind === 'update-feature' ? edit.feature.id : edit.kind)).toEqual(['set-parameter', 'earlier']);
    const final = await prepare(base.document, finish.edits);
    expect(sketchOf(final, 'earlier')).toEqual(sketchOf(five.document, 'earlier'));
    expect(final.features.slice(1)).toEqual(base.document.features.slice(1));
    expect(main.getSnapshot()).toBe(base);
  });

  it('lets an earlier gear whose teeth follow a parameter change its member count during a later sketch\'s draft', async () => {
    const plugin = createCadPluginProfile(CAD_GEAR_V3_PLUGIN);
    const gear: CadSketchGenerator = { id: 'gear', kind: 'generator', idPrefix: 'g', construction: false,
      geometry: { ...plugin, inputs: { ...plugin.inputs, teeth: 't' } } as CadSketchGenerator['geometry'] };
    const original = source(), document = parseCadDocument({ ...original, parameters: { ...original.parameters, t: 18 },
      features: [{ id: 'earlier', kind: 'sketch', name: 'Earlier gear', suppressed: false, plane: 'XY', offset: 0, profiles: [],
        graph: { points: [], entities: [], relations: [gear] } }, ...original.features] });
    const main = new CadSession(document), base = main.getSnapshot(), draft = new CadSketchEditDraft(base, 'sketch');
    const count = (value: CadDocument) => sketchOf(value, 'earlier').graph!.entities.length;
    await draft.editPrepared([{ kind: 'set-parameter', name: 't', value: 17 },
      { kind: 'set-sketch-relation', sketchId: 'sketch', relation: { id: 'horizontal', kind: 'horizontal', pointIds: ['a', 'b'] } }], prepare);
    expect(count(draft.getSnapshot().document)).toBeLessThan(count(base.document));
    const finish = draft.finishEdits(base), final = await prepare(base.document, finish.edits);
    expect(sketchOf(final, 'earlier')).toEqual(sketchOf(draft.getSnapshot().document, 'earlier'));
    expect(sketchOf(final)).toEqual(sketchOf(draft.getSnapshot().document));
  });

  it('does not touch main redo on Cancel or an unchanged Finish, including restored local geometry', async () => {
    const main = new CadSession(source()); main.edit([{ kind: 'rename-document', name: 'Keep redo' }]); main.undo();
    const base = main.getSnapshot(), draft = new CadSketchEditDraft(base, 'sketch');
    await draft.editPrepared([removeEdge], prepare); draft.undo();
    expect(draft.finishEdits(base)).toMatchObject({ noOp: true, edits: [] });
    expect(main.getSnapshot()).toBe(base); expect(main.getSnapshot().canRedo).toBe(true);
    draft.cancel(); expect(main.getSnapshot()).toBe(base); expect(main.getSnapshot().canRedo).toBe(true);
    await expect(draft.editPrepared([removeEdge], prepare)).rejects.toMatchObject({ code: 'SKETCH_DRAFT_CLOSED' });
    expect(() => draft.finishEdits(base)).toThrow(); main.redo(); expect(main.getSnapshot().document.name).toBe('Keep redo');
  });

  it('derives a no-op from restored final values even when local action history remains', async () => {
    const main = new CadSession(source()), base = main.getSnapshot(), draft = new CadSketchEditDraft(base, 'sketch');
    await draft.editPrepared([{ kind: 'set-parameter', name: 'span', value: 30 }], prepare);
    await draft.editPrepared([{ kind: 'set-parameter', name: 'span', value: 20 }], prepare);
    expect(draft.getSnapshot().canUndo).toBe(true);
    expect(draft.finishEdits(base)).toMatchObject({ noOp: true, edits: [] }); expect(main.getSnapshot()).toBe(base);
  });

  it('keeps local history behind pending field ownership and rejects preparation after that ownership changes', async () => {
    const main = new CadSession(source()), base = main.getSnapshot(), draft = new CadSketchEditDraft(base, 'sketch');
    await draft.editPrepared([removeEdge], prepare);
    draft.setWorkflowOpen(true);
    const pendingUndo = draft.getSnapshot();
    expect(() => draft.undo()).toThrow(expect.objectContaining({ code: 'WORKFLOW_OPEN' }));
    expect(draft.getSnapshot()).toBe(pendingUndo);
    draft.setWorkflowOpen(false); draft.undo(); draft.setWorkflowOpen(true);
    const pendingRedo = draft.getSnapshot();
    expect(() => draft.redo()).toThrow(expect.objectContaining({ code: 'WORKFLOW_OPEN' }));
    expect(draft.getSnapshot()).toBe(pendingRedo);
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const preparation = draft.editPrepared([{ kind: 'set-parameter', name: 'span', value: 30 }], async (document, edits, signal) => {
      await gate; return prepare(document, edits, signal);
    });
    draft.setWorkflowOpen(false); const retained = draft.getSnapshot(); release();
    await expect(preparation).rejects.toMatchObject({ code: 'WORKFLOW_CHANGED' });
    expect(draft.getSnapshot()).toBe(retained); expect(main.getSnapshot()).toBe(base);
    draft.redo(); expect(draft.getSnapshot().document.parameters.span).toBe(20);
    draft.cancel(); expect(() => draft.setWorkflowOpen(true)).toThrow(expect.objectContaining({ code: 'SKETCH_DRAFT_CLOSED' }));
  });

  it('pins the local revision of Finish and preserves parameter provenance referring to a later plugin', async () => {
    const original = source(), document = parseCadDocument({ ...original, parameterMetadata: { span: { groupId: 'sizes', source: {
      kind: 'plugin', featureId: 'later', profileId: 'plugin', inputName: 'radius', packageId: CAD_STAR_PLUGIN.id, packageVersion: CAD_STAR_PLUGIN.version } } } });
    const main = new CadSession(document), base = main.getSnapshot(), draft = new CadSketchEditDraft(base, 'sketch');
    expect(draft.initialDocument.parameterMetadata).toEqual(base.document.parameterMetadata);
    const finish = draft.finishEdits(base);
    await draft.editPrepared([removeEdge], prepare);
    expect(() => draft.assertCurrent(base, finish.localVersion)).toThrow(expect.objectContaining({ code: 'STALE_STATE' }));
    expect(() => draft.assertSource({ ...base, version: 'replacement-version' })).toThrow();
    expect(main.getSnapshot()).toBe(base);
  });

  it('refuses an invalid intent batch atomically before calling preparation', async () => {
    const main = new CadSession(source(false, true)), draft = new CadSketchEditDraft(main.getSnapshot(), 'sketch'), before = draft.getSnapshot();
    const prepared = vi.fn(prepare);
    const invalid: CadEdit[] = [{ kind: 'rename-document', name: 'No' }, { kind: 'delete-feature', featureId: 'pad', cascade: true },
      { kind: 'move-feature', featureId: 'sketch', beforeId: null }, { kind: 'remove-parameter', name: 'span' },
      { kind: 'set-parameter-group', group: { id: 'other', name: 'Other' } },
      { kind: 'copy-sketch-profile', sourceSketchId: 'sketch', profileId: 'plugin', newSketchId: 'copy', name: 'Copy', idPrefix: 'copy' },
      { kind: 'update-feature', feature: { ...sketchOf(before.document, 'earlier'), name: 'No' } },
      { kind: 'set-sketch-relation', sketchId: 'earlier', relation: { id: 'other', kind: 'fixed-axis', pointId: 'tip', axis: 'y', value: 0 } }];
    for (const edit of invalid) await expect(draft.editPrepared([{ kind: 'set-parameter', name: 'span', value: 30 }, edit], prepared)).rejects.toMatchObject({ code: 'SKETCH_DRAFT_SCOPE' });
    expect(prepared).not.toHaveBeenCalled(); expect(draft.getSnapshot()).toBe(before);
  });

  it.each(['name', 'driver', 'relation', 'metadata', 'source'] as const)('rejects unexpected %s mutations from a prepared prefix', async kind => {
    const main = new CadSession(source(false, true)), draft = new CadSketchEditDraft(main.getSnapshot(), 'sketch'), before = draft.getSnapshot();
    const prepareUnexpected = async () => {
      const earlier = sketchOf(before.document, 'earlier'); if (!earlier.graph) throw new Error('Missing graph');
      return parseCadDocument(kind === 'metadata' ? { ...before.document, parameterGroups: [{ id: 'sizes', name: 'Changed' }] }
        : kind === 'source' ? { ...before.document, features: before.document.features.map(feature => feature.id === 'sketch' && feature.kind === 'sketch'
          ? { ...feature, source: { ...feature.source, text: `${dxf} ` } } : feature) }
          : { ...before.document, features: [{ ...earlier, ...(kind === 'name' ? { name: 'Changed' } : { graph: { ...earlier.graph,
            ...(kind === 'driver' ? { points: [{ ...earlier.graph.points[0], position: [' 0 ', '0'] }, earlier.graph.points[1]] }
              : { relations: earlier.graph.relations.slice(0, 1) }) } }) }, ...before.document.features.slice(1)] });
    };
    await expect(draft.editPrepared([], prepareUnexpected)).rejects.toMatchObject({ code: 'SKETCH_DRAFT_SCOPE' });
    expect(draft.getSnapshot()).toBe(before);
  });

  it('refuses unrelated consumer changes and never automatically removes explicit selections', () => {
    const main = new CadSession(source(true)), base = main.getSnapshot(), draft = new CadSketchEditDraft(base, 'sketch');
    const pad = base.document.features[1]; if (pad.kind !== 'extrude') throw new Error('Missing pad');
    for (const edit of [{ kind: 'update-feature' as const, feature: { ...pad, distance: 15 } },
      { kind: 'update-feature' as const, feature: { ...pad, id: 'other' } }, { kind: 'rename-document' as const, name: 'No' }])
      expect(() => draft.finishEdits(base, [edit])).toThrow();
    expect(draft.finishEdits(base)).toMatchObject({ noOp: true, edits: [] }); expect(main.getSnapshot()).toBe(base);
  });

  it('captures complete intent before lazy preparation and keeps new numeric parameter metadata explicit', async () => {
    const main = new CadSession(source()), base = main.getSnapshot(), draft = new CadSketchEditDraft(base, 'sketch');
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const parameter = { kind: 'set-parameter' as const, name: 'newSize', value: 30 }, edits: CadEdit[] = [parameter];
    const pending = draft.editPrepared(edits, async (document, captured, signal) => { await gate; return prepare(document, captured, signal); });
    parameter.value = 99; edits.push({ kind: 'rename-document', name: 'Unreviewed' }); release(); await pending;
    expect(draft.getSnapshot().document.parameters.newSize).toBe(30);
    expect(draft.getSnapshot().document.parameterMetadata?.newSize).toEqual({ source: { kind: 'manual' } });
    const finish = draft.finishEdits(base);
    expect(finish.edits).toEqual([{ kind: 'set-parameter', name: 'newSize', value: 30 }]);
    expect((await prepare(base.document, finish.edits)).parameterMetadata?.newSize).toEqual({ source: { kind: 'manual' } });
    expect(main.getSnapshot()).toBe(base);
  });

  it('retains the normal atomic Finish limit instead of splitting an accumulated local draft', async () => {
    const main = new CadSession(source()), base = main.getSnapshot(), draft = new CadSketchEditDraft(base, 'sketch');
    await draft.editPrepared(Array.from({ length: 256 }, (_, index) => ({ kind: 'set-parameter', name: `p${index}`, value: index })), prepare);
    expect(draft.finishEdits(base).edits).toHaveLength(256);
    await draft.editPrepared([{ kind: 'set-parameter', name: 'another', value: 1 }], prepare);
    expect(() => draft.finishEdits(base)).toThrow(expect.objectContaining({ code: 'edit-limit' }));
    expect(draft.getSnapshot().document.parameters.another).toBe(1); expect(main.getSnapshot()).toBe(base);
  });

  it('preserves an owned embedded package and exact expression/source bytes while refusing package replacement', async () => {
    const original = source(), owned = sketchOf(original);
    const packageProfile = { id: 'plugin', name: 'Construction plugin', construction: true, geometry: createCadPluginProfile(CAD_STAR_PLUGIN) };
    const document = parseCadDocument({ ...original, features: original.features.map(feature => feature.id === 'sketch' ? { ...owned, profiles: [packageProfile] } : feature) });
    const main = new CadSession(document), base = main.getSnapshot(), draft = new CadSketchEditDraft(base, 'sketch');
    await draft.editPrepared([{ kind: 'set-sketch-construction', sketchId: 'sketch', entityIds: ['bc'], construction: true }], prepare);
    const local = sketchOf(draft.getSnapshot().document);
    expect(JSON.stringify(local.profiles[0].geometry)).toBe(JSON.stringify(packageProfile.geometry));
    expect(local.source?.text).toBe(dxf); expect(local.graph?.points[1].position[0]).toBe(' span ');
    const changedPackage = { ...packageProfile.geometry.package, name: 'Replaced package' };
    await expect(draft.editPrepared([{ kind: 'update-feature', feature: { ...local, profiles: [{ ...packageProfile,
      geometry: { ...packageProfile.geometry, package: changedPackage } }] } }], prepare)).rejects.toMatchObject({ code: 'SKETCH_DRAFT_SCOPE' });
    expect(sketchOf(draft.getSnapshot().document)).toBe(local); expect(main.getSnapshot()).toBe(base);
  });

  it.each(['cancel', 'undo', 'base-version', 'base-document'] as const)('rejects a late local result after %s without accepting its candidate', async cause => {
    const main = new CadSession(source()), base = main.getSnapshot(), draft = new CadSketchEditDraft(base, 'sketch');
    await draft.editPrepared([removeEdge], prepare);
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let current = base;
    const pending = draft.editPrepared([{ kind: 'set-parameter', name: 'span', value: 30 }], async (document, edits, signal) => {
      await gate; return prepare(document, edits, signal);
    }, draft.getSnapshot().version, undefined, () => draft.assertSource(current));
    if (cause === 'cancel') draft.cancel();
    if (cause === 'undo') draft.undo();
    if (cause === 'base-version') current = { ...base, version: 'different-version' };
    if (cause === 'base-document') current = { ...base, document: parseCadDocument({ ...base.document, name: 'New source' }) };
    const retained = draft.getSnapshot(); release();
    await expect(pending).rejects.toThrow(); expect(draft.getSnapshot()).toBe(retained); expect(main.getSnapshot()).toBe(base);
  });
});

// A private Finish publishes snapshots; explicit owner release must precede later independent member edits.
it.each(['move', 'delete'] as const)('finishes a deliberate pattern detach followed by member %s without weakening shared snapshot guards', async action => {
  const initial = await prepare(source(), [
    { kind: 'append-sketch-entities', sketchId: 'sketch', geometry: { points: [{ id: 'seed_center', position: ['3', '5'] }],
      entities: [{ id: 'seed', kind: 'circle', centerPointId: 'seed_center', radius: ' 1.5 ', construction: false }], relations: [] } },
    { kind: 'set-sketch-relation', sketchId: 'sketch', relation: { id: 'holes', kind: 'linear-pattern',
      seed: { kind: 'circle', entityId: 'seed', centerPointId: 'seed_center' }, idPrefix: 'row', direction: '+x', count: 3, spacing: ' 5.00 ', omittedInstances: [] } }
  ]);
  const main = new CadSession(initial), base = main.getSnapshot(), draft = new CadSketchEditDraft(base, 'sketch');
  const detach: CadEdit = { kind: 'remove-sketch-relation', sketchId: 'sketch', relationId: 'holes' };
  await draft.editPrepared([detach], prepare);
  const edit: CadEdit = action === 'move' ? { kind: 'move-sketch-point', sketchId: 'sketch', pointId: 'row_i1_p0', translation: [0, 1] }
    : { kind: 'delete-sketch-elements', sketchId: 'sketch', pointIds: ['row_i1_p0'], entityIds: ['row_i1_e0'], relationIds: [], cascade: false };
  await draft.editPrepared([edit], prepare);
  const local = sketchOf(draft.getSnapshot().document), finish = draft.finishEdits(base);
  expect(finish.edits[0]).toEqual(detach); expect(main.getSnapshot()).toBe(base);
  await main.editPrepared(base.version, document => prepare(document, finish.edits));
  expect(sketchOf(main.getSnapshot().document)).toEqual(local); expect(main.getSnapshot().document.features.slice(1)).toEqual(base.document.features.slice(1));
  main.undo(); expect(main.getSnapshot().document).toEqual(base.document); draft.cancel();
});
