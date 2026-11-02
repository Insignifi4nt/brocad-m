import { readFile } from 'node:fs/promises';
import { expect, test } from './fixtures/native-sketch-solver';
import type { CadSketchFeature } from '../src/domain/cad/cadDocument';
import type { CadSketchCellReference } from '../src/domain/cad/cadSketchRegionSelection';
import { prepareCadTools, callCadTool as call, rawCadToolCall as rawCall, cadContext as context, historyRow, importCadDraft } from './cad-tool-helpers';

test('offsets a consumed plate into an independent wall loop and matches the exact agent repair through save', async ({ page }) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  const sketch: CadSketchFeature = { id: 'outline', kind: 'sketch', name: 'Wall outline', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
    points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [40, 0] }, { id: 'c', position: ['40.0000', '20.00'] }, { id: 'd', position: [0, 20] }],
    entities: [{ id: 'ab', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' },
      { id: 'bc', kind: 'line', construction: false, startPointId: 'b', endPointId: 'c' },
      { id: 'cd', kind: 'line', construction: false, startPointId: 'c', endPointId: 'd' },
      { id: 'da', kind: 'line', construction: false, startPointId: 'd', endPointId: 'a' }],
    relations: [{ id: 'bottom', kind: 'horizontal', pointIds: ['a', 'b'] }, { id: 'right', kind: 'vertical', pointIds: ['b', 'c'] },
      { id: 'top', kind: 'horizontal', pointIds: ['c', 'd'] }, { id: 'left', kind: 'vertical', pointIds: ['d', 'a'] }]
  } };
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [{ kind: 'add-feature', feature: sketch }] });
  let current = await context(page);
  const regions = await call(page, 'cad_inspect_sketch_regions', { expectedVersion: current.version, sketchId: sketch.id });
  const originalReference = (regions.items as { reference: CadSketchCellReference }[])[0].reference;
  const sourceRefs = originalReference.graphContours?.find(contour => contour.profileId === originalReference.boundaryProfileId)?.sourceRefs;
  if (!sourceRefs) throw new Error('Current graph-cycle witness unavailable.');
  const pad = { id: 'pad', kind: 'extrude', name: 'Wall blank', suppressed: false, sketchId: sketch.id,
    regionSelection: [originalReference], distance: ' 5e0 ', symmetric: false, operation: 'new', targetId: null };
  await call(page, 'cad_edit_document', { expectedVersion: current.version, edits: [{ kind: 'add-feature', feature: pad }] }); current = await context(page);
  const base = current;
  await call(page, 'cad_build', { expectedVersion: base.version });
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: base.version }))
    .toMatchObject({ ok: true, data: { view: { available: true, referenceVersion: base.version } } });
  await (await historyRow(page, 'Wall outline')).dblclick();
  const openOffset = async () => {
    await page.locator('[data-cad-sketch-entity="ab"]').press('Enter');
    await page.getByRole('button', { name: 'Offset loop', exact: true }).click();
    await page.getByRole('textbox', { name: 'Offset distance mm', exact: true }).fill('2');
  };
  await openOffset();
  await page.getByRole('button', { name: 'Inside', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
  expect((await call(page, 'cad_get_feature', { expectedVersion: base.version, featureId: sketch.id })).feature).toEqual(sketch);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('[data-cad-sketch-entity]')).toHaveCount(4);
  expect((await context(page)).version).toBe(base.version);
  await openOffset();
  await page.getByRole('button', { name: 'Inside', exact: true }).click();
  await page.getByRole('button', { name: 'Outside', exact: true }).click();
  await page.getByRole('button', { name: 'Inside', exact: true }).click();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.locator('[data-cad-sketch-entity]')).toHaveCount(8);
  await page.keyboard.press('Control+z'); await expect(page.locator('[data-cad-sketch-entity]')).toHaveCount(4);
  await page.keyboard.press('Control+Shift+z'); await expect(page.locator('[data-cad-sketch-entity]')).toHaveCount(8);
  expect((await context(page)).version).toBe(base.version);
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Update dependent sketch areas', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Choose areas for Wall blank', exact: true }).click();
  await page.getByRole('button', { name: 'View controls', exact: true }).click();
  await page.getByRole('combobox', { name: 'Named view', exact: true }).selectOption('Top');
  await page.getByRole('button', { name: 'Fit model', exact: true }).click();
  await page.getByRole('button', { name: 'View controls', exact: true }).click();
  const area = await page.getByLabel('3D model canvas').boundingBox();
  if (!area) throw new Error('Replacement wall area unavailable.');
  // Fitted from the top, below the sketch bar, this lands in the 2 mm wall along the plate's far edge, at (20, 19) mm.
  await page.mouse.click(area.x + area.width * .558, area.y + area.height * .2492);
  await page.getByRole('button', { name: 'Finish area selection', exact: true }).click();
  expect((await call(page, 'cad_get_feature', { expectedVersion: base.version, featureId: sketch.id })).feature).toEqual(sketch);
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false }); current = await context(page);
  const human = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature as CadSketchFeature;
  if (!human.graph || !sketch.graph) throw new Error('Accepted source graph unavailable.');
  expect(human.graph.points.slice(0, 4)).toEqual(sketch.graph.points);
  expect(human.graph.entities.slice(0, 4)).toEqual(sketch.graph.entities);
  expect(human.graph.relations).toEqual(sketch.graph.relations);
  expect(human.graph.points.slice(4).map(point => point.position)).toEqual([[2, 2], [38, 2], [38, 18], [2, 18]]);
  const first = human.graph.entities[4]; expect(first.id.endsWith('_e0')).toBe(true);
  const idPrefix = first.id.slice(0, -3);
  const built = await call(page, 'cad_build', { expectedVersion: current.version });
  expect(built.diagnostics).toEqual([]);
  expect(built.bodies).toHaveLength(1);
  expect((built.bodies as { volumeMm3: number }[])[0].volumeMm3).toBeCloseTo(1120, 7);
  await call(page, 'cad_history', { expectedVersion: current.version, direction: 'undo' }); current = await context(page);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature).toEqual(sketch);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: pad.id })).feature).toEqual(pad);
  const offset = { source: { kind: 'graph-cycle', sourceRefs }, distance: -2, idPrefix };
  const proposed = await call(page, 'cad_inspect_sketch_regions', { expectedVersion: current.version, sketchId: sketch.id, proposal: { offset } });
  const wall = (proposed.items as { areaMm2: number; defaultMaterial: boolean; reference: CadSketchCellReference }[]).find(item => item.defaultMaterial);
  if (!wall) throw new Error('Proposed wall cell unavailable.');
  expect(wall.areaMm2).toBeCloseTo(224, 9);
  const changedPad = { ...pad, regionSelection: [wall.reference] };
  const edit = { kind: 'offset-sketch-loop', sketchId: sketch.id, ...offset };
  expect((await rawCall(page, 'cad_edit_document', { expectedVersion: current.version, edits: [edit] })).ok).toBe(false);
  expect((await context(page)).version).toBe(current.version);
  await call(page, 'cad_edit_document', { expectedVersion: current.version, edits: [edit, { kind: 'update-feature', feature: changedPad }] }); current = await context(page);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature).toEqual(human);
  expect(((await call(page, 'cad_build', { expectedVersion: current.version })).bodies as { volumeMm3: number }[])[0].volumeMm3).toBeCloseTo(1120, 7);
  const downloading = page.waitForEvent('download');
  await call(page, 'cad_export_dxf', { expectedVersion: current.version, sketchId: sketch.id });
  const downloaded = await (await downloading).path(); if (!downloaded) throw new Error('Wall DXF missing.');
  expect((await readFile(downloaded, 'utf8')).match(/\nLINE\r?\n/g)).toHaveLength(8);
  await call(page, 'cad_save_document', { expectedVersion: current.version }); await page.reload();
  await expect(page.getByRole('main', { name: 'Parametric CAD workbench' })).toBeVisible(); current = await context(page);
  expect(current.dirty).toBe(false);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature).toEqual(human);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: pad.id })).feature).toEqual(changedPad);
});

test('previews a legacy rounded loop exclusively and keeps its analytic copy independent through source changes and export', async ({ page }) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  const sketch: CadSketchFeature = { id: 'clearance', kind: 'sketch', name: 'Rounded clearance', suppressed: false, plane: 'XY', offset: 0,
    profiles: [{ id: 'slot', name: 'Rotated slot', construction: false,
      geometry: { kind: 'slot', x: '11.00', y: '-7.00', length: ' slotLength ', width: '10.0000', angle: '30.00' } }] };
  // A legacy slot loads from a saved draft; an edit can no longer add one.
  const base = await importCadDraft(page, [sketch], { parameters: { slotLength: 30 } });
  await (await historyRow(page, 'Rounded clearance')).dblclick();
  await page.getByRole('button', { name: 'Rotated slot profile', exact: true }).click();
  await page.getByRole('button', { name: 'Offset loop', exact: true }).click();
  await page.getByRole('textbox', { name: 'Offset distance mm', exact: true }).fill('2');
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
  expect((await context(page)).workflowOpen).toBe(true);
  await expect(page.getByRole('button', { name: 'Circle', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Finish sketch', exact: true })).toBeDisabled();
  await expect(page.locator('[data-cad-sketch-entity]')).toHaveCount(4);
  expect((await call(page, 'cad_get_feature', { expectedVersion: base.version, featureId: sketch.id })).feature).toEqual(sketch);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('[data-cad-sketch-entity]')).toHaveCount(0);
  expect((await context(page)).workflowOpen).toBe(false);
  await page.getByRole('button', { name: 'Offset loop', exact: true }).click();
  await page.getByRole('textbox', { name: 'Offset distance mm', exact: true }).fill('2');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false });
  let current = await context(page);
  const copied = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature as CadSketchFeature;
  expect(copied.profiles).toEqual(sketch.profiles);
  expect(copied.graph?.entities.filter(entity => entity.kind === 'arc')).toHaveLength(2);
  expect(copied.graph?.entities.filter(entity => entity.kind === 'line')).toHaveLength(2);
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  await call(page, 'cad_edit_document', { expectedVersion: current.version, edits: [{ kind: 'add-feature', feature: {
    id: 'pad', kind: 'extrude', name: 'Clearance thickness', suppressed: false, sketchId: sketch.id,
    distance: ' 5e0 ', symmetric: false, operation: 'new', targetId: null
  } }] }); current = await context(page);
  const firstBuild = await call(page, 'cad_build', { expectedVersion: current.version });
  expect(firstBuild.diagnostics).toEqual([]);
  expect((firstBuild.bodies as { volumeMm3: number }[])[0].volumeMm3).toBeCloseTo(5 * (80 + 24 * Math.PI), 7);
  await call(page, 'cad_edit_document', { expectedVersion: current.version, edits: [{ kind: 'set-parameter', name: 'slotLength', value: 32 }] }); current = await context(page);
  const changed = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature as CadSketchFeature;
  expect(changed).toEqual(copied);
  const changedBuild = await call(page, 'cad_build', { expectedVersion: current.version });
  expect(changedBuild.diagnostics).toEqual([]);
  expect((changedBuild.bodies as { volumeMm3: number }[])[0].volumeMm3).toBeCloseTo(5 * (60 + 24 * Math.PI), 7);
  const downloading = page.waitForEvent('download');
  await call(page, 'cad_export_dxf', { expectedVersion: current.version, sketchId: sketch.id });
  const downloaded = await (await downloading).path(); if (!downloaded) throw new Error('Rounded DXF missing.');
  const dxf = await readFile(downloaded, 'utf8');
  expect(dxf.match(/\nARC\r?\n/g)).toHaveLength(4); expect(dxf.match(/\nLINE\r?\n/g)).toHaveLength(4);
  await call(page, 'cad_save_document', { expectedVersion: current.version }); await page.reload();
  await expect(page.getByRole('main', { name: 'Parametric CAD workbench' })).toBeVisible(); current = await context(page);
  expect(current.dirty).toBe(false); expect((current.parameters as Record<string, number>).slotLength).toBe(32);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature).toEqual(copied);
});
