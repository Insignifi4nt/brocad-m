import { readFile } from 'node:fs/promises';
import { expect, test } from './fixtures/native-sketch-solver';
import { prepareCadTools, callCadTool as call, rawCadToolCall as rawCall, cadContext as context, enableGridSnap, historyRow, relationOffer, relationRow, openSketchRelations } from './cad-tool-helpers';

test('resizes a free circle directly, cancels cleanly and preserves explicit size ownership through extrusion and reopen', async ({ page }) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  const sketch = { id: 'circle', kind: 'sketch', name: 'Round blank', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
    points: [{ id: 'center', position: [' centerX ', '0.00'] }],
    entities: [{ id: 'rim', kind: 'circle', construction: false, centerPointId: 'center', radius: 5 }], relations: []
  } };
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [
    { kind: 'set-parameter', name: 'centerX', value: 2.1 }, { kind: 'add-feature', feature: sketch }
  ] });
  const initial = await context(page);
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: initial.version })).toMatchObject({ ok: true, data: { view: { available: true } } });
  await call(page, 'cad_set_viewport', { expectedVersion: initial.version, command: { kind: 'edit-sketch', sketchId: sketch.id } });
  await enableGridSnap(page);
  await call(page, 'cad_set_viewport', { expectedVersion: initial.version, command: { kind: 'select-sketch-geometry-set', selections: [{ kind: 'entity', id: 'rim' }] } });
  const grip = page.getByRole('button', { name: 'Resize circle radius in Round blank', exact: true });
  const rim = page.locator('[data-cad-sketch-entity="rim"] > circle');
  const startDrag = async () => {
    const box = await grip.boundingBox(), canvas = await page.getByLabel('Sketch drawing canvas').boundingBox();
    if (!box || !canvas) throw new Error('Circle resize geometry unavailable.');
    const viewport = await call(page, 'cad_get_viewport', { expectedVersion: initial.version });
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    // Grid snapping is a short magnet, so release close to the 10 mm node.
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 4.95 * canvas.height / viewport.view.heightSpanMm, y);
    await expect(rim).toHaveAttribute('r', '10');
  };
  await startDrag();
  expect((await call(page, 'cad_get_feature', { expectedVersion: initial.version, featureId: sketch.id })).feature).toEqual(sketch);
  await page.keyboard.press('Escape'); await page.mouse.up(); await expect(rim).toHaveAttribute('r', '5');
  expect((await context(page)).version).toBe(initial.version);
  await startDrag(); await page.mouse.up();
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false });
  let current = await context(page);
  const resized = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature;
  expect(resized.graph.entities).toEqual([{ ...sketch.graph.entities[0], radius: 10 }]); expect(resized.graph.points).toEqual(sketch.graph.points);
  await call(page, 'cad_history', { expectedVersion: current.version, direction: 'undo' }); current = await context(page);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature).toEqual(sketch);
  await call(page, 'cad_edit_document', { expectedVersion: current.version, edits: [{ kind: 'update-feature', feature: resized }] }); current = await context(page);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature).toEqual(resized);
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'select-sketch-geometry-set', selections: [{ kind: 'entity', id: 'rim' }] } });
  await grip.press('ArrowLeft'); await expect(rim).toHaveAttribute('r', '5');
  const dimensionCanvas = await page.getByLabel('Sketch drawing canvas').boundingBox();
  if (!dimensionCanvas) throw new Error('Dimension canvas unavailable.');
  // Empty canvas below the sketch header clears the selection.
  await page.mouse.click(dimensionCanvas.x + dimensionCanvas.width / 2, dimensionCanvas.y + 60);
  await expect(grip).toHaveCount(0);
  await page.getByRole('button', { name: 'Dimension', exact: true }).click();
  // A picked circle previews its diameter; picking it again places it at the measured size and selects it, and Enter opens its editor.
  await page.locator('[data-cad-sketch-entity="rim"]').press('Enter'); await page.locator('[data-cad-sketch-entity="rim"]').press('Enter');
  await expect(page.locator('[data-cad-sketch-dimension] [role="button"][aria-pressed="true"]')).toHaveCount(1);
  await page.getByLabel('Sketch drawing canvas').press('Enter');
  await page.getByRole('textbox', { name: 'Diameter mm', exact: true }).fill('16');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false }); current = await context(page);
  // The placed diameter stays selected, so the rim is selected again to show its grip.
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'select-sketch-geometry-set', selections: [{ kind: 'entity', id: 'rim' }] } });
  await expect(grip).toHaveAttribute('aria-disabled', 'true');
  const locked = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature;
  expect(locked.graph.entities[0].radius).toBe(8); expect(locked.graph.points).toEqual(sketch.graph.points);
  const lockedBox = await grip.boundingBox(); if (!lockedBox) throw new Error('Driven radius grip unavailable.');
  await page.mouse.move(lockedBox.x + lockedBox.width / 2, lockedBox.y + lockedBox.height / 2); await page.mouse.down();
  await page.mouse.move(lockedBox.x + 50, lockedBox.y); await page.mouse.up();
  expect((await context(page)).version).toBe(current.version);
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  await call(page, 'cad_edit_document', { expectedVersion: current.version, edits: [{ kind: 'add-feature', feature: {
    id: 'pad', kind: 'extrude', name: 'Thickness', suppressed: false, sketchId: sketch.id, distance: ' 5e0 ', symmetric: false, operation: 'new', targetId: null
  } }] });
  current = await context(page); const built = await call(page, 'cad_build', { expectedVersion: current.version });
  expect(built.diagnostics).toEqual([]); expect(built.bodies[0].volumeMm3).toBeCloseTo(320 * Math.PI, 6);
  await call(page, 'cad_save_document', { expectedVersion: current.version }); await page.reload();
  await expect(page.getByRole('main', { name: 'Parametric CAD workbench' })).toBeVisible(); current = await context(page);
  expect(current.dirty).toBe(false); expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature).toEqual(locked);
});

test('locates a bore with signed relative X/Y drivers, preserves cancelled edits and reopens the same human and agent solid', async ({ page }) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  const sketch = { id: 'located', kind: 'sketch', name: 'Located bore', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
    points: [{ id: 'a', position: [' 0.00 ', '0'] }, { id: 'b', position: ['60', '0'] }, { id: 'c', position: ['60', '40'] },
      { id: 'd', position: ['0', '40'] }, { id: 'hole', position: [30, 20] }],
    entities: [{ id: 'ab', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' },
      { id: 'bc', kind: 'line', construction: false, startPointId: 'b', endPointId: 'c' },
      { id: 'cd', kind: 'line', construction: false, startPointId: 'c', endPointId: 'd' },
      { id: 'da', kind: 'line', construction: false, startPointId: 'd', endPointId: 'a' },
      { id: 'bore', kind: 'circle', construction: false, centerPointId: 'hole', radius: ' 4 ' }], relations: []
  } };
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [
    { kind: 'set-parameter', name: 'boreX', value: 30 }, { kind: 'set-parameter', name: 'boreY', value: 20 }, { kind: 'add-feature', feature: sketch }
  ] }); let current = await context(page);
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: current.version }))
    .toMatchObject({ ok: true, data: { view: { available: true, referenceVersion: current.version } } });
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'edit-sketch', sketchId: sketch.id } });
  const pair = [{ kind: 'point', id: 'a' }, { kind: 'point', id: 'hole' }];
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'select-sketch-geometry-set', selections: pair } });
  const bind = async (label: string, expression: string) => {
    await page.getByRole('button', { name: `Edit ${label} relation`, exact: true }).click();
    await page.getByRole('textbox', { name: `${label} expression`, exact: true }).fill(expression);
    await page.getByRole('button', { name: 'Keep relation', exact: true }).click();
    await page.getByRole('button', { name: `Close ${label} relation help`, exact: true }).click();
  };
  const canvas = page.getByLabel('Sketch drawing canvas');
  // Dimension starts from the selected pair. Its menu places the distance it names at the measured value and selects it, or selects the one
  // already there, and Enter opens that dimension's editor.
  const place = async (form: 'Horizontal distance' | 'Vertical distance', selections = pair) => {
    await call(page, 'cad_set_viewport', { expectedVersion: (await context(page)).version, command: { kind: 'select-sketch-geometry-set', selections } });
    await page.getByRole('button', { name: 'Dimension', exact: true }).click();
    await canvas.press('Shift+F10'); await page.getByRole('menuitem', { name: form, exact: true }).click();
    await expect(page.locator('[data-cad-sketch-dimension] [role="button"][aria-pressed="true"]')).toHaveCount(1);
    await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false });
    await page.keyboard.press('Enter');
  };
  const apply = async () => { await page.getByRole('button', { name: 'Apply', exact: true }).click(); await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false }); };
  await place('Horizontal distance'); const placed = await context(page);
  const measured = (await call(page, 'cad_get_feature', { expectedVersion: placed.version, featureId: sketch.id })).feature;
  expect(measured.graph).toEqual({ ...sketch.graph, relations: [{ id: expect.any(String), kind: 'axis-distance', axis: 'x', pointIds: ['a', 'hole'], value: 30 }] });
  await bind('Horizontal distance', ' boreX ');
  await page.getByRole('textbox', { name: 'Horizontal distance mm', exact: true }).fill('35');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await context(page)).toMatchObject({ version: placed.version, parameters: { boreX: 30, boreY: 20 }, workflowOpen: false });
  expect((await call(page, 'cad_get_feature', { expectedVersion: placed.version, featureId: sketch.id })).feature).toEqual(measured);
  await place('Horizontal distance'); await bind('Horizontal distance', ' boreX ');
  await page.getByRole('textbox', { name: 'Horizontal distance mm', exact: true }).fill('35'); await apply();
  await place('Vertical distance'); await bind('Vertical distance', ' boreY '); await apply();
  current = await context(page);
  const human = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature;
  expect(human.graph.points).toEqual([...sketch.graph.points.slice(0, 4), { id: 'hole', position: [35, 20] }]);
  expect(human.graph.entities).toEqual(sketch.graph.entities);
  expect(human.graph.relations).toEqual([
    expect.objectContaining({ kind: 'axis-distance', axis: 'x', pointIds: ['a', 'hole'], value: ' boreX ' }),
    expect.objectContaining({ kind: 'axis-distance', axis: 'y', pointIds: ['a', 'hole'], value: ' boreY ' })
  ]);
  for (let step = 0; step < 4; step++) await page.keyboard.press('Control+z');
  await expect.poll(async () => (await call(page, 'cad_get_feature', { expectedVersion: (await context(page)).version, featureId: sketch.id })).feature).toEqual(sketch);
  for (let step = 0; step < 4; step++) await page.keyboard.press('Control+Shift+z');
  await expect.poll(async () => (await call(page, 'cad_get_feature', { expectedVersion: (await context(page)).version, featureId: sketch.id })).feature).toEqual(human);
  current = await context(page);
  // The reversed pair selects the same driver rather than adding a negative one.
  await place('Horizontal distance', [...pair].reverse());
  await expect(page.getByRole('textbox', { name: 'Horizontal distance mm', exact: true })).toHaveValue('35');
  expect(await context(page)).toMatchObject({ version: current.version, workflowOpen: false });
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  for (let step = 0; step < 4; step++) { await call(page, 'cad_history', { expectedVersion: current.version, direction: 'undo' }); current = await context(page); }
  const regions = await call(page, 'cad_inspect_sketch_regions', { expectedVersion: current.version, sketchId: sketch.id,
    proposal: { sketch: human, parameterValues: { boreX: 35 } } });
  const region = regions.items.find((item: { areaMm2: number }) => item.areaMm2 > 1000);
  expect(region.areaMm2).toBeCloseTo(2400 - 16 * Math.PI, 7);
  const pad = { id: 'pad', kind: 'extrude', name: 'Located plate', suppressed: false, sketchId: sketch.id, distance: ' 5e0 ',
    symmetric: false, operation: 'new', targetId: null, regionSelection: [region.reference] };
  await call(page, 'cad_edit_document', { expectedVersion: current.version, edits: [
    { kind: 'set-parameter', name: 'boreX', value: 35 },
    ...human.graph.relations.map((relation: unknown) => ({ kind: 'set-sketch-relation', sketchId: sketch.id, relation })), { kind: 'add-feature', feature: pad }
  ] }); current = await context(page);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature).toEqual(human);
  const built = await call(page, 'cad_build', { expectedVersion: current.version }); expect(built.diagnostics).toEqual([]);
  expect(built.bodies).toHaveLength(1); expect(built.bodies[0].volumeMm3).toBeCloseTo(12000 - 80 * Math.PI, 7);
  await call(page, 'cad_save_document', { expectedVersion: current.version }); await page.reload();
  await expect(page.getByRole('main', { name: 'Parametric CAD workbench' })).toBeVisible(); current = await context(page);
  expect(current.dirty).toBe(false);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature).toEqual(human);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: pad.id })).feature).toEqual(pad);
});

test('drives an obtuse corner in degrees through its real annotation, retains its expression and edits the consumed part privately', async ({ page }) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  const sketch = { id: 'triangle', kind: 'sketch', name: 'Angled plate', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
    points: [{ id: 'v', position: [' 0.00 ', '0'] }, { id: 'a', position: ['10', '0'] }, { id: 'b', position: [-5, Math.sqrt(75)] }],
    entities: [{ id: 'incoming', kind: 'line', construction: false, startPointId: 'a', endPointId: 'v' },
      { id: 'outgoing', kind: 'line', construction: false, startPointId: 'v', endPointId: 'b' },
      { id: 'closing', kind: 'line', construction: false, startPointId: 'b', endPointId: 'a' }],
    relations: [{ id: 'side-length', kind: 'distance', pointIds: ['v', 'b'], value: ' 10 ' }]
  } };
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [{ kind: 'set-parameter', name: 'cornerAngle', value: 120 }, { kind: 'add-feature', feature: sketch }] });
  let current = await context(page);
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: current.version })).toMatchObject({ ok: true, data: { view: { available: true, referenceVersion: current.version } } });
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'edit-sketch', sketchId: sketch.id } });
  await page.locator('[data-cad-sketch-entity="incoming"]').press('Enter');
  await page.locator('[data-cad-sketch-entity="outgoing"]').press('Shift+Enter');
  await page.getByRole('button', { name: 'Dimension', exact: true }).click();
  // Without a pointer the angle takes the corner at the shared joint; Enter places it there and Enter again opens its editor.
  await page.getByLabel('Sketch drawing canvas').press('Enter');
  await expect(page.locator('[data-cad-sketch-dimension] [role="button"][aria-pressed="true"]')).toHaveCount(1);
  await page.getByLabel('Sketch drawing canvas').press('Enter');
  const degrees = page.getByRole('textbox', { name: 'Angle deg', exact: true });
  await expect.poll(async () => Number(await degrees.inputValue())).toBeCloseTo(120, 10);
  await page.getByRole('button', { name: 'Edit Angle relation', exact: true }).click();
  await page.getByRole('textbox', { name: 'Angle expression', exact: true }).fill(' cornerAngle ');
  await page.getByRole('button', { name: 'Keep relation', exact: true }).click();
  await page.getByRole('button', { name: 'Close Angle relation help', exact: true }).click();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false }); current = await context(page);
  const angled = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature;
  const angle = angled.graph.relations.find((relation: { kind: string }) => relation.kind === 'line-angle');
  expect(angle).toMatchObject({ rays: [{ lineId: 'incoming', towardPointId: 'a' }, { lineId: 'outgoing', towardPointId: 'b' }], sense: 'ccw', value: ' cornerAngle ' });
  expect(angled.graph.points.slice(0, 2)).toEqual(sketch.graph.points.slice(0, 2));
  await page.getByRole('button', { name: /^Dimension angle / }).dblclick(); await degrees.fill('110');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await context(page)).version).toBe(current.version);
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  await call(page, 'cad_edit_document', { expectedVersion: current.version, edits: [{ kind: 'add-feature', feature: {
    id: 'pad', kind: 'extrude', name: 'Angled solid', suppressed: false, sketchId: sketch.id, distance: ' 5e0 ', symmetric: false, operation: 'new', targetId: null
  } }] }); current = await context(page);
  const built = await call(page, 'cad_build', { expectedVersion: current.version }); expect(built.diagnostics).toEqual([]);
  expect(built.bodies[0].volumeMm3).toBeCloseTo(250 * Math.sin(120 * Math.PI / 180), 7);
  await (await historyRow(page, 'Angled plate')).dblclick();
  await page.getByRole('button', { name: /^Dimension angle / }).dblclick(); await degrees.fill('110');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  expect((await context(page)).version).toBe(current.version);
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false }); current = await context(page);
  expect(current.parameters.cornerAngle).toBe(110);
  const changed = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature;
  expect(changed.graph.relations.find((relation: { kind: string }) => relation.kind === 'line-angle')).toEqual(angle);
  expect(changed.graph.points.slice(0, 2)).toEqual(sketch.graph.points.slice(0, 2));
  expect((await call(page, 'cad_build', { expectedVersion: current.version })).bodies[0].volumeMm3).toBeCloseTo(250 * Math.sin(110 * Math.PI / 180), 7);
  await page.keyboard.press('Control+z'); current = await context(page);
  expect(current.parameters.cornerAngle).toBe(120); expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature).toEqual(angled);
  await page.keyboard.press('Control+Shift+z'); current = await context(page);
  await call(page, 'cad_save_document', { expectedVersion: current.version }); await page.reload();
  await expect(page.getByRole('main', { name: 'Parametric CAD workbench' })).toBeVisible(); current = await context(page);
  expect(current.dirty).toBe(false); expect(current.parameters.cornerAngle).toBe(110);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature).toEqual(changed);
});

test('splits a consumed sketch edge at its cursor, repairs its selected area deliberately and restores the complete edit with one Undo', async ({ page }) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  const sketch = { id: 'outline', kind: 'sketch', name: 'Split outline', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
    points: [{ id: 'a', position: [' 0.0000 ', '0'] }, { id: 'b', position: [40, 0] }, { id: 'c', position: [40, 20] }, { id: 'd', position: [0, 20] }],
    entities: [{ id: 'ab', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' },
      { id: 'bc', kind: 'line', construction: false, startPointId: 'b', endPointId: 'c' },
      { id: 'cd', kind: 'line', construction: false, startPointId: 'c', endPointId: 'd' },
      { id: 'da', kind: 'line', construction: false, startPointId: 'd', endPointId: 'a' }], relations: []
  } };
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [{ kind: 'add-feature', feature: sketch }] });
  let current = await context(page);
  const regions = await call(page, 'cad_inspect_sketch_regions', { expectedVersion: current.version, sketchId: sketch.id });
  const pad = { id: 'pad', kind: 'extrude', name: 'Split plate', suppressed: false, sketchId: sketch.id,
    regionSelection: [regions.items[0].reference], distance: ' 5e0 ', symmetric: false, operation: 'new', targetId: null };
  await call(page, 'cad_edit_document', { expectedVersion: current.version, edits: [{ kind: 'add-feature', feature: pad }] }); current = await context(page);
  await call(page, 'cad_build', { expectedVersion: current.version });
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: current.version }))
    .toMatchObject({ ok: true, data: { view: { available: true, referenceVersion: current.version } } });
  await (await historyRow(page, 'Split outline')).dblclick();
  // Public tools read the accepted part, never the human's private sketch draft.
  // Place this human gesture from the actual painted endpoint locations.
  const a = await page.locator('[data-cad-sketch-point="a"]').boundingBox(), b = await page.locator('[data-cad-sketch-point="b"]').boundingBox();
  if (!a || !b) throw new Error('Sketch endpoints unavailable.');
  await page.mouse.click(a.x + a.width / 2 + .33 * (b.x + b.width / 2 - a.x - a.width / 2), a.y + a.height / 2 - 1, { button: 'right' });
  const split = page.getByRole('menuitem', { name: 'Split here', exact: true }); await expect(split).toBeEnabled();
  const jointId = await page.locator('[data-cad-sketch-split-point]').getAttribute('data-cad-sketch-split-point'); if (!jointId) throw new Error('Split marker unavailable.');
  const previewX = Number(await page.locator('[data-cad-sketch-split-point]').getAttribute('cx')) - Number(await page.locator('[data-cad-sketch-point="a"] circle').first().getAttribute('cx'));
  // Firefox/native input can round to a whole CSS pixel. Only pointer placement
  // uses that screen allowance; accepted geometry must match its exact preview.
  expect(Math.abs(previewX - 13.2)).toBeLessThanOrEqual(40 / Math.abs(b.x + b.width / 2 - a.x - a.width / 2));
  await split.click();
  await expect(page.locator(`[data-cad-sketch-point="${jointId}"]`)).toBeVisible();
  await expect(page.locator(`[data-cad-sketch-point="${jointId}"]`)).toHaveAttribute('aria-pressed', 'true');
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature).toEqual(sketch);
  await page.keyboard.press('Control+z'); await expect(page.locator(`[data-cad-sketch-point="${jointId}"]`)).toHaveCount(0);
  await page.keyboard.press('Control+Shift+z'); await expect(page.locator(`[data-cad-sketch-point="${jointId}"]`)).toBeVisible();
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Update dependent sketch areas', exact: true })).toBeVisible();
  expect((await context(page)).version).toBe(current.version);
  await page.getByRole('button', { name: 'Choose areas for Split plate', exact: true }).click();
  const areaCanvas = page.getByLabel('3D model canvas'), areaBox = await areaCanvas.boundingBox(); if (!areaBox) throw new Error('Area view unavailable.');
  await page.mouse.click(areaBox.x + areaBox.width / 2, areaBox.y + areaBox.height / 2);
  await page.getByRole('button', { name: 'Finish area selection', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Finish sketch', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false }); current = await context(page);
  const changed = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature;
  expect(changed.graph.points.slice(0, 4)).toEqual(sketch.graph.points); expect(changed.graph.entities).toHaveLength(5);
  expect(changed.graph.points.find((point: { id: string }) => point.id === jointId).position).toEqual([expect.closeTo(previewX, 12), 0]);
  expect(changed.graph.relations).toEqual([{ id: expect.any(String), kind: 'parallel', lineIds: ['ab', expect.any(String)] }]);
  const changedPad = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: pad.id })).feature;
  expect({ ...changedPad, regionSelection: pad.regionSelection }).toEqual(pad); expect(changedPad.regionSelection).not.toEqual(pad.regionSelection);
  const built = await call(page, 'cad_build', { expectedVersion: current.version }); expect(built.diagnostics).toEqual([]); expect(built.bodies[0].volumeMm3).toBeCloseTo(4000, 7);
  await page.keyboard.press('Control+z'); current = await context(page);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature).toEqual(sketch);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: pad.id })).feature).toEqual(pad);
  await page.keyboard.press('Control+Shift+z'); current = await context(page);
  await call(page, 'cad_save_document', { expectedVersion: current.version }); await page.reload(); await expect(page.getByRole('main', { name: 'Parametric CAD workbench' })).toBeVisible();
  current = await context(page); expect(current.dirty).toBe(false);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature).toEqual(changed);
});

test('trims a consumed edge, reconnects deliberately and matches the same guarded agent batch through save', async ({ page }) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  const sketch = { id: 'outline', kind: 'sketch', name: 'Trim outline', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
    points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [40, 0] }, { id: 'c', position: ['40.0000', '20.00'] }, { id: 'd', position: [0, 20] },
      { id: 'fence-a', position: ['10.00', '-5'] }, { id: 'fence-b', position: ['10.00', '5'] }],
    entities: [{ id: 'ab', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' },
      { id: 'bc', kind: 'line', construction: false, startPointId: 'b', endPointId: 'c' },
      { id: 'cd', kind: 'line', construction: false, startPointId: 'c', endPointId: 'd' },
      { id: 'da', kind: 'line', construction: false, startPointId: 'd', endPointId: 'a' },
      { id: 'fence', kind: 'line', construction: true, startPointId: 'fence-a', endPointId: 'fence-b' }], relations: [
        { id: 'bottom-horizontal', kind: 'horizontal', pointIds: ['a', 'b'] },
        { id: 'right-vertical', kind: 'vertical', pointIds: ['b', 'c'] },
        { id: 'top-horizontal', kind: 'horizontal', pointIds: ['c', 'd'] },
        { id: 'left-vertical', kind: 'vertical', pointIds: ['d', 'a'] }
      ]
  } };
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [{ kind: 'add-feature', feature: sketch }] });
  let current = await context(page);
  const regions = await call(page, 'cad_inspect_sketch_regions', { expectedVersion: current.version, sketchId: sketch.id });
  const pad = { id: 'pad', kind: 'extrude', name: 'Trim plate', suppressed: false, sketchId: sketch.id,
    regionSelection: [regions.items[0].reference], distance: ' 5e0 ', symmetric: false, operation: 'new', targetId: null };
  await call(page, 'cad_edit_document', { expectedVersion: current.version, edits: [{ kind: 'add-feature', feature: pad }] }); current = await context(page);
  const base = current;
  await call(page, 'cad_build', { expectedVersion: base.version });
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: base.version }))
    .toMatchObject({ ok: true, data: { view: { available: true, referenceVersion: base.version } } });
  const openTrim = async () => {
    await (await historyRow(page, 'Trim outline')).dblclick();
    const a = await page.locator('[data-cad-sketch-point="a"]').boundingBox(), b = await page.locator('[data-cad-sketch-point="b"]').boundingBox();
    if (!a || !b) throw new Error('Trim endpoints unavailable.');
    await page.mouse.click(a.x + a.width / 2 + .1 * (b.x + b.width / 2 - a.x - a.width / 2), a.y + a.height / 2 - 1, { button: 'right' });
    const trim = page.getByRole('menuitem', { name: 'Trim here', exact: true }); await expect(trim).toBeEnabled(); await trim.focus();
    await expect(page.getByLabel('Trim preview', { exact: true })).toBeVisible();
    const pointId = await page.locator('[data-cad-sketch-trim-point]').getAttribute('data-cad-sketch-trim-point');
    if (!pointId) throw new Error('Trim point unavailable.');
    await trim.click(); await expect(page.locator(`[data-cad-sketch-point="${pointId}"]`)).toHaveAttribute('aria-pressed', 'true');
    return pointId;
  };
  await openTrim();
  expect((await call(page, 'cad_get_feature', { expectedVersion: base.version, featureId: sketch.id })).feature).toEqual(sketch);
  await page.getByRole('button', { name: 'Cancel sketch edits', exact: true }).click();
  await expect.poll(() => context(page)).toMatchObject({ version: base.version, workflowOpen: false });
  const cutPointId = await openTrim();
  await page.keyboard.press('Control+z'); await expect(page.locator(`[data-cad-sketch-point="${cutPointId}"]`)).toHaveCount(0);
  await page.keyboard.press('Control+Shift+z'); await expect(page.locator(`[data-cad-sketch-point="${cutPointId}"]`)).toBeVisible();
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel sketch edits', exact: true })).toBeVisible();
  expect((await context(page)).version).toBe(base.version);
  const endpoints = [];
  for (const id of ['a', cutPointId]) {
    const box = await page.locator(`[data-cad-sketch-point="${id}"]`).boundingBox(); if (!box) throw new Error('Reconnection endpoint unavailable.');
    endpoints.push({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  }
  await page.getByRole('button', { name: 'Line', exact: true }).click(); await expect(page.getByRole('checkbox', { name: 'Create relations', exact: true })).toBeChecked();
  for (const point of endpoints) await page.mouse.click(point.x, point.y);
  await page.getByRole('button', { name: 'Finish chain', exact: true }).click();
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Update dependent sketch areas', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Choose areas for Trim plate', exact: true }).click();
  const area = await page.getByLabel('3D model canvas').boundingBox(); if (!area) throw new Error('Area selection unavailable.');
  await page.mouse.click(area.x + area.width / 2, area.y + area.height / 2);
  await page.getByRole('button', { name: 'Finish area selection', exact: true }).click();
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false }); current = await context(page);
  const human = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature;
  expect(human.graph.points.slice(0, sketch.graph.points.length)).toEqual(sketch.graph.points);
  expect(human.graph.points.find((point: { id: string }) => point.id === cutPointId).position).toEqual([10, 0]);
  expect(human.graph.entities[0]).toEqual({ ...sketch.graph.entities[0], startPointId: cutPointId });
  expect(human.graph.relations.slice(0, sketch.graph.relations.length)).toEqual([{ ...sketch.graph.relations[0], pointIds: [cutPointId, 'b'] }, ...sketch.graph.relations.slice(1)]);
  // The cut inside the fence stays on it, so the reconnected outline keeps following that line.
  const [attachment, ...joins] = human.graph.relations.slice(sketch.graph.relations.length);
  expect(attachment).toEqual({ id: expect.any(String), kind: 'point-on-line', pointId: cutPointId, lineId: 'fence' });
  // The connector has its own two points, each attached to a survivor by a removable coincident relation.
  expect(joins.map((relation: { kind: string; pointIds: readonly string[] }) => [relation.kind, relation.pointIds[1]])).toEqual([['coincident', 'a'], ['coincident', cutPointId]]);
  expect((await call(page, 'cad_build', { expectedVersion: current.version })).bodies[0].volumeMm3).toBeCloseTo(4000, 7);
  await page.keyboard.press('Control+z'); current = await context(page);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature).toEqual(sketch);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: pad.id })).feature).toEqual(pad);
  const query = await call(page, 'cad_inspect_sketch_regions', { expectedVersion: current.version, sketchId: sketch.id, trimAt: { entityId: 'ab', parameter: .1 } });
  expect(query.items).toHaveLength(1);
  expect(query.trimPreview.target).toEqual({ kind: 'end', entityId: 'ab', parameter: .1, end: 'start',
    boundary: { entityId: 'fence', index: 0, parameter: .25, position: [10, 0] } });
  expect(query.trimPreview.attachment).toEqual({ kind: 'point-on-line', lineId: 'fence' });
  const trim = { ...query.trimPreview.target, cutPointId, attachRelationId: attachment.id };
  const openProposal = await call(page, 'cad_inspect_sketch_regions', { expectedVersion: current.version, sketchId: sketch.id, proposal: { trim } });
  expect(openProposal.items).toEqual([]);
  const replacement = await call(page, 'cad_inspect_sketch_regions', { expectedVersion: current.version, sketchId: sketch.id, proposal: { sketch: human } });
  const changedPad = { ...pad, regionSelection: [replacement.items[0].reference] };
  const connector = human.graph.entities.find((entity: { id: string }) => !sketch.graph.entities.some(original => original.id === entity.id));
  expect(connector).toBeDefined();
  const connectorPoints = human.graph.points.filter((point: { id: string }) => point.id !== cutPointId && !sketch.graph.points.some(original => original.id === point.id));
  expect(connectorPoints.map((point: { id: string }) => point.id)).toEqual([connector.startPointId, connector.endPointId]);
  const edits = [{ kind: 'trim-sketch-entity', sketchId: sketch.id, trim },
    { kind: 'append-sketch-entities', sketchId: sketch.id, geometry: { points: connectorPoints, entities: [connector], relations: joins } },
    { kind: 'update-feature', feature: changedPad }];
  const failed = await rawCall(page, 'cad_edit_document', { expectedVersion: current.version, edits: edits.slice(0, 1) }); expect(failed.ok).toBe(false);
  expect((await context(page)).version).toBe(current.version);
  await call(page, 'cad_edit_document', { expectedVersion: current.version, edits }); current = await context(page);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature).toEqual(human);
  const built = await call(page, 'cad_build', { expectedVersion: current.version }); expect(built.diagnostics).toEqual([]); expect(built.bodies[0].volumeMm3).toBeCloseTo(4000, 7);
  await call(page, 'cad_save_document', { expectedVersion: current.version }); await page.reload();
  await expect(page.getByRole('main', { name: 'Parametric CAD workbench' })).toBeVisible(); current = await context(page);
  expect(current.dirty).toBe(false);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature).toEqual(human);
});

test('removes a consumed middle span, attaches a bridge to both exact survivors and matches the same agent repair through save', async ({ page }) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  const sketch = { id: 'outline', kind: 'sketch', name: 'Notched plate', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
    points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [20, 0] }, { id: 'c', position: ['20.0000', '10.00'] }, { id: 'd', position: [0, 10] },
      { id: 'fence-left', position: [5, -5] }, { id: 'cut-left', position: [5, 0] },
      { id: 'fence-right', position: [15, -5] }, { id: 'cut-right', position: [15, 0] }],
    entities: [{ id: 'ab', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' },
      { id: 'bc', kind: 'line', construction: false, startPointId: 'b', endPointId: 'c' },
      { id: 'cd', kind: 'line', construction: false, startPointId: 'c', endPointId: 'd' },
      { id: 'da', kind: 'line', construction: false, startPointId: 'd', endPointId: 'a' },
      { id: 'left-cutter', kind: 'line', construction: true, startPointId: 'fence-left', endPointId: 'cut-left' },
      { id: 'right-cutter', kind: 'line', construction: true, startPointId: 'fence-right', endPointId: 'cut-right' }],
    relations: [{ id: 'bottom', kind: 'horizontal', pointIds: ['a', 'b'] }, { id: 'right', kind: 'vertical', pointIds: ['b', 'c'] },
      { id: 'top', kind: 'horizontal', pointIds: ['c', 'd'] }, { id: 'left', kind: 'vertical', pointIds: ['d', 'a'] }]
  } };
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [{ kind: 'add-feature', feature: sketch }] });
  let current = await context(page);
  const originalRegions = await call(page, 'cad_inspect_sketch_regions', { expectedVersion: current.version, sketchId: sketch.id });
  const pad = { id: 'pad', kind: 'extrude', name: 'Notched blank', suppressed: false, sketchId: sketch.id,
    regionSelection: [originalRegions.items[0].reference], distance: ' 5e0 ', symmetric: false, operation: 'new', targetId: null };
  await call(page, 'cad_edit_document', { expectedVersion: current.version, edits: [{ kind: 'add-feature', feature: pad }] }); current = await context(page);
  const base = current; await call(page, 'cad_build', { expectedVersion: base.version });
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: base.version }))
    .toMatchObject({ ok: true, data: { view: { available: true, referenceVersion: base.version } } });
  await (await historyRow(page, 'Notched plate')).dblclick();
  const openTrim = async () => {
    const a = await page.locator('[data-cad-sketch-point="a"]').boundingBox(), b = await page.locator('[data-cad-sketch-point="b"]').boundingBox();
    if (!a || !b) throw new Error('Middle-trim endpoints unavailable.');
    await page.mouse.click((a.x + a.width / 2 + b.x + b.width / 2) / 2, a.y + a.height / 2 - 1, { button: 'right' });
    const trim = page.getByRole('menuitem', { name: 'Trim here', exact: true }); await expect(trim).toBeEnabled(); await trim.focus();
    await expect(page.getByLabel('Trim preview', { exact: true })).toBeVisible();
    await expect(page.locator('[data-cad-sketch-trim-point]')).toHaveCount(2);
    expect(await page.locator('[data-cad-sketch-trim-point]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-cad-sketch-trim-point'))))
      .toEqual(['cut-left', 'cut-right']);
    return trim;
  };
  await openTrim(); await page.keyboard.press('Escape'); await expect(page.getByLabel('Trim preview', { exact: true })).toHaveCount(0);
  expect((await call(page, 'cad_get_feature', { expectedVersion: base.version, featureId: sketch.id })).feature).toEqual(sketch);
  await (await openTrim()).click();
  const countAfterTrim = sketch.graph.entities.length + 1;
  await expect(page.locator('[data-cad-sketch-entity]')).toHaveCount(countAfterTrim);
  await page.keyboard.press('Control+z'); await expect(page.locator('[data-cad-sketch-entity]')).toHaveCount(sketch.graph.entities.length);
  await page.keyboard.press('Control+Shift+z'); await expect(page.locator('[data-cad-sketch-entity]')).toHaveCount(countAfterTrim);
  expect((await context(page)).version).toBe(base.version);
  await page.getByRole('button', { name: 'Line', exact: true }).click(); await expect(page.getByRole('checkbox', { name: 'Create relations', exact: true })).toBeChecked();
  const left = await page.locator('[data-cad-sketch-point="cut-left"]').boundingBox(); if (!left) throw new Error('Left retained endpoint unavailable.');
  await page.mouse.click(left.x + left.width / 2, left.y + left.height / 2);
  await page.keyboard.press('ArrowUp'); await page.keyboard.press('Space');
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Space');
  const right = await page.locator('[data-cad-sketch-point="cut-right"]').boundingBox(); if (!right) throw new Error('Right retained endpoint unavailable.');
  await page.mouse.click(right.x + right.width / 2, right.y + right.height / 2);
  await page.getByRole('button', { name: 'Finish chain', exact: true }).click();
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Update dependent sketch areas', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Choose areas for Notched blank', exact: true }).click();
  const area = await page.getByLabel('3D model canvas').boundingBox(); if (!area) throw new Error('Replacement area unavailable.');
  // The notch is in the lower quarter of the view; the upper plate is unambiguous material.
  await page.mouse.click(area.x + area.width / 2, area.y + area.height * .4);
  await page.getByRole('button', { name: 'Finish area selection', exact: true }).click();
  expect((await call(page, 'cad_get_feature', { expectedVersion: base.version, featureId: sketch.id })).feature).toEqual(sketch);
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false }); current = await context(page);
  const human = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature;
  expect(human.graph.points.slice(0, sketch.graph.points.length)).toEqual(sketch.graph.points);
  expect(human.graph.relations.slice(0, sketch.graph.relations.length)).toEqual(sketch.graph.relations);
  const support = human.graph.relations.find((relation: { kind: string }) => relation.kind === 'collinear'); expect(support).toBeDefined();
  expect(human.graph.relations.filter((relation: { kind: string; pointIds?: readonly string[] }) => relation.kind === 'coincident').map((relation: { pointIds: readonly string[] }) => relation.pointIds[1]))
    .toEqual(['cut-left', 'cut-right']);
  expect(support.lineIds[0]).toBe('ab');
  expect(human.graph.entities[0]).toEqual({ ...sketch.graph.entities[0], endPointId: 'cut-left' });
  expect(human.graph.entities.find((entity: { id: string }) => entity.id === support.lineIds[1]))
    .toEqual({ ...sketch.graph.entities[0], id: support.lineIds[1], startPointId: 'cut-right' });
  const built = await call(page, 'cad_build', { expectedVersion: current.version }); expect(built.diagnostics).toEqual([]);
  expect(built.bodies).toHaveLength(1); expect(built.bodies[0].volumeMm3).toBeCloseTo(750, 7);
  await call(page, 'cad_history', { expectedVersion: current.version, direction: 'undo' }); current = await context(page);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature).toEqual(sketch);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: pad.id })).feature).toEqual(pad);
  const query = await call(page, 'cad_inspect_sketch_regions', { expectedVersion: current.version, sketchId: sketch.id, trimAt: { entityId: 'ab', parameter: .5 } });
  expect(query.trimPreview.target).toMatchObject({ kind: 'middle', entityId: 'ab', parameter: .5,
    boundaries: [{ entityId: 'left-cutter', parameter: .25, position: [5, 0], endpointPointId: 'cut-left' },
      { entityId: 'right-cutter', parameter: .75, position: [15, 0], endpointPointId: 'cut-right' }] });
  const trim = { ...query.trimPreview.target, cutPointIds: ['cut-left', 'cut-right'], newEntityId: support.lineIds[1], supportRelationId: support.id };
  const openProposal = await call(page, 'cad_inspect_sketch_regions', { expectedVersion: current.version, sketchId: sketch.id, proposal: { trim } });
  expect(openProposal.items).toEqual([]);
  const replacement = await call(page, 'cad_inspect_sketch_regions', { expectedVersion: current.version, sketchId: sketch.id, proposal: { sketch: human } });
  expect(replacement.items[0].areaMm2).toBeCloseTo(150, 9);
  const changedPad = { ...pad, regionSelection: [replacement.items[0].reference] };
  const additions = { points: human.graph.points.slice(sketch.graph.points.length),
    entities: human.graph.entities.filter((entity: { id: string }) => entity.id !== support.lineIds[1] && !sketch.graph.entities.some(original => original.id === entity.id)),
    relations: human.graph.relations.filter((relation: { id: string }) => relation.id !== support.id && !sketch.graph.relations.some(original => original.id === relation.id)) };
  const edits = [{ kind: 'trim-sketch-entity', sketchId: sketch.id, trim },
    { kind: 'append-sketch-entities', sketchId: sketch.id, geometry: additions }, { kind: 'update-feature', feature: changedPad }];
  expect((await rawCall(page, 'cad_edit_document', { expectedVersion: current.version, edits: edits.slice(0, 1) })).ok).toBe(false);
  expect((await context(page)).version).toBe(current.version);
  await call(page, 'cad_edit_document', { expectedVersion: current.version, edits }); current = await context(page);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature).toEqual(human);
  expect((await call(page, 'cad_build', { expectedVersion: current.version })).bodies[0].volumeMm3).toBeCloseTo(750, 7);
  await call(page, 'cad_save_document', { expectedVersion: current.version }); await page.reload();
  await expect(page.getByRole('main', { name: 'Parametric CAD workbench' })).toBeVisible(); current = await context(page);
  expect(current.dirty).toBe(false);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature).toEqual(human);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: pad.id })).feature).toEqual(changedPad);
});

test('extends the chosen line end to its exact boundary joint, matches the agent operation and preserves the closed solid through save', async ({ page }) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  const sketch = { id: 'outline', kind: 'sketch', name: 'Extend outline', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
    points: [{ id: 'a', position: [3, 0] }, { id: 'b', position: [20, '0.00'] }, { id: 'c', position: [20, 10] },
      { id: 'd', position: ['0.0000', '10.00'] }, { id: 'e', position: [0, 0] }],
    entities: [{ id: 'ab', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' },
      { id: 'bc', kind: 'line', construction: false, startPointId: 'b', endPointId: 'c' },
      { id: 'cd', kind: 'line', construction: false, startPointId: 'c', endPointId: 'd' },
      { id: 'de', kind: 'line', construction: false, startPointId: 'd', endPointId: 'e' }], relations: [
        { id: 'bottom-horizontal', kind: 'horizontal', pointIds: ['a', 'b'] },
        { id: 'right-vertical', kind: 'vertical', pointIds: ['b', 'c'] },
        { id: 'top-horizontal', kind: 'horizontal', pointIds: ['c', 'd'] },
        { id: 'left-vertical', kind: 'vertical', pointIds: ['d', 'e'] }
      ]
  } };
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [{ kind: 'add-feature', feature: sketch }] });
  let current = await context(page); const baseVersion = current.version;
  expect((await call(page, 'cad_inspect_sketch_regions', { expectedVersion: current.version, sketchId: sketch.id })).items).toEqual([]);
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: current.version }))
    .toMatchObject({ ok: true, data: { view: { available: true, referenceVersion: current.version } } });
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'edit-sketch', sketchId: sketch.id } });
  const openExtend = async () => {
    const a = await page.locator('[data-cad-sketch-point="a"]').boundingBox(), b = await page.locator('[data-cad-sketch-point="b"]').boundingBox();
    if (!a || !b) throw new Error('Extend source endpoints unavailable.');
    await page.mouse.click(a.x + a.width / 2 + .15 * (b.x + b.width / 2 - a.x - a.width / 2), a.y + a.height / 2 - 1, { button: 'right' });
    const extend = page.getByRole('menuitem', { name: 'Extend start', exact: true }); await expect(extend).toBeEnabled(); await extend.focus();
    await expect(page.getByLabel('Extend preview', { exact: true })).toBeVisible();
    await expect(page.locator('[data-cad-sketch-extend-point]')).toHaveAttribute('data-cad-sketch-extend-point', 'e');
    return extend;
  };
  const focusedLine = page.locator('[data-cad-sketch-entity="ab"]');
  await focusedLine.press('Shift+F10');
  const keyboardStart = page.getByRole('menuitem', { name: 'Extend start', exact: true });
  await expect(keyboardStart).toBeEnabled(); await keyboardStart.focus();
  await expect(page.locator('[data-cad-sketch-extend-point]')).toHaveAttribute('data-cad-sketch-extend-point', 'e');
  await expect(page.getByRole('menuitem', { name: 'Extend end', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape'); await expect(focusedLine).toBeFocused();
  await openExtend(); await page.keyboard.press('Escape');
  expect((await context(page)).version).toBe(baseVersion);
  expect((await call(page, 'cad_get_feature', { expectedVersion: baseVersion, featureId: sketch.id })).feature).toEqual(sketch);
  await (await openExtend()).click(); await expect(page.locator('[data-cad-sketch-point="e"]')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false }); current = await context(page);
  const human = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature;
  expect(human.graph.points).toEqual(sketch.graph.points.filter((point: { id: string }) => point.id !== 'a'));
  expect(human.graph.relations).toEqual([{ ...sketch.graph.relations[0], pointIds: ['e', 'b'] }, ...sketch.graph.relations.slice(1)]);
  expect(human.graph.entities).toEqual([{ ...sketch.graph.entities[0], startPointId: 'e' }, ...sketch.graph.entities.slice(1)]);
  await page.keyboard.press('Control+z'); current = await context(page);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature).toEqual(sketch);
  await page.keyboard.press('Control+Shift+z'); current = await context(page);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature).toEqual(human);
  await page.keyboard.press('Control+z'); current = await context(page);
  await focusedLine.press('Shift+F10'); await page.getByRole('menuitem', { name: 'Extend start', exact: true }).click();
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false }); current = await context(page);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature).toEqual(human);
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  await call(page, 'cad_history', { expectedVersion: current.version, direction: 'undo' }); current = await context(page);
  const query = await call(page, 'cad_inspect_sketch_regions', { expectedVersion: current.version, sketchId: sketch.id, extendAt: { entityId: 'ab', end: 'start' } });
  expect(query.items).toEqual([]);
  expect(query.extendPreview.target).toEqual({ kind: 'line', entityId: 'ab', end: 'start',
    boundary: { entityId: 'de', index: 0, parameter: -3 / 17, position: [0, 0], endpointPointId: 'e' } });
  const extend = { ...query.extendPreview.target, endPointId: query.extendPreview.target.boundary.endpointPointId };
  const proposal = { extend };
  const regions = await call(page, 'cad_inspect_sketch_regions', { expectedVersion: current.version, sketchId: sketch.id, proposal });
  expect(regions.items).toHaveLength(1); expect(regions.items[0]).toMatchObject({ areaMm2: 200, boundaryLengthMm: 60 });
  const exact = await call(page, 'cad_read_sketch_region_reference', { expectedVersion: current.version, sketchId: sketch.id, proposal, boundaryProfileId: regions.items[0].reference.boundaryProfileId });
  expect(JSON.parse(exact.text)).toEqual(regions.items[0].reference);
  const pad = { id: 'pad', kind: 'extrude', name: 'Extended plate', suppressed: false, sketchId: sketch.id,
    regionSelection: [regions.items[0].reference], distance: ' 5e0 ', symmetric: false, operation: 'new', targetId: null };
  await call(page, 'cad_edit_document', { expectedVersion: current.version, edits: [{ kind: 'extend-sketch-entity', sketchId: sketch.id, extend }, { kind: 'add-feature', feature: pad }] });
  current = await context(page);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature).toEqual(human);
  const built = await call(page, 'cad_build', { expectedVersion: current.version }); expect(built.diagnostics).toEqual([]);
  expect(built.bodies).toHaveLength(1); expect(built.bodies[0].volumeMm3).toBeCloseTo(1000, 7);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: pad.id })).feature).toEqual(pad);
  await call(page, 'cad_save_document', { expectedVersion: current.version }); await page.reload();
  await expect(page.getByRole('main', { name: 'Parametric CAD workbench' })).toBeVisible(); current = await context(page);
  expect(current.dirty).toBe(false);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature).toEqual(human);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: pad.id })).feature).toEqual(pad);
});

test('chooses exact stacked snap identities, preserves a cancelled path attempt and saves the same human and agent solid', async ({ page }) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  const sketch = { id: 'stacked', kind: 'sketch', name: 'Stacked endpoints', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
    points: [{ id: 'a', position: [2.1, 3.2] }, { id: 'b', position: [22.1, 3.2] }, { id: 'c', position: [22.1, 13.2] }, { id: 'd', position: [2.1, 13.2] },
      { id: 'other-a', position: [2.1, 3.2] }, { id: 'other-b', position: [22.1, 3.2] }],
    entities: [{ id: 'bc', kind: 'line', construction: false, startPointId: 'b', endPointId: 'c' },
      { id: 'cd', kind: 'line', construction: false, startPointId: 'c', endPointId: 'd' },
      { id: 'da', kind: 'line', construction: false, startPointId: 'd', endPointId: 'a' }], relations: [
      { id: 'right', kind: 'vertical', pointIds: ['b', 'c'] }, { id: 'top', kind: 'horizontal', pointIds: ['c', 'd'] }, { id: 'left', kind: 'vertical', pointIds: ['d', 'a'] }]
  } };
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [{ kind: 'add-feature', feature: sketch }] });
  let current = await context(page); const initialVersion = current.version;
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: current.version }))
    .toMatchObject({ ok: true, data: { view: { available: true, referenceVersion: current.version } } });
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'edit-sketch', sketchId: sketch.id } });
  await page.getByRole('button', { name: 'Line', exact: true }).click(); await expect(page.getByRole('checkbox', { name: 'Create relations', exact: true })).toBeChecked();
  const openChoice = async (id: string) => {
    const bounds = await page.locator(`[data-cad-sketch-point="${id}"]`).boundingBox(); if (!bounds) throw new Error('Stacked source point unavailable.');
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await expect(page.getByRole('menu')).toBeVisible();
  };
  await openChoice('a');
  await expect.poll(() => context(page)).toMatchObject({ version: initialVersion, workflowOpen: true });
  expect(await rawCall(page, 'cad_edit_document', { expectedVersion: initialVersion, edits: [{ kind: 'rename-document', name: 'Foreign edit' }] }))
    .toMatchObject({ ok: false, error: { code: 'WORKFLOW_OPEN' } });
  await page.keyboard.press('Escape'); await expect.poll(() => context(page)).toMatchObject({ version: initialVersion, workflowOpen: false });
  expect((await call(page, 'cad_get_feature', { expectedVersion: initialVersion, featureId: sketch.id })).feature).toEqual(sketch);
  await openChoice('a'); await page.getByRole('menuitem', { name: /^Point 1\b/ }).click();
  await openChoice('b'); await page.keyboard.press('Escape');
  expect((await context(page))).toMatchObject({ version: initialVersion, workflowOpen: true });
  await expect(page.getByRole('button', { name: 'Finish chain', exact: true })).toBeDisabled();
  await openChoice('b'); await page.getByRole('menuitem', { name: /^Point 2\b/ }).click();
  await page.getByRole('button', { name: 'Finish chain', exact: true }).click();
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false }); current = await context(page);
  const human = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature;
  // The chosen points keep their identity: the connector gets its own points, attached to exactly the chosen ones.
  expect(human.graph.points.slice(0, sketch.graph.points.length)).toEqual(sketch.graph.points); expect(human.graph.points).toHaveLength(sketch.graph.points.length + 2);
  expect(human.graph.relations.slice(0, sketch.graph.relations.length)).toEqual(sketch.graph.relations);
  expect(human.graph.entities.slice(0, 3)).toEqual(sketch.graph.entities); expect(human.graph.entities).toHaveLength(4);
  const [start, end] = human.graph.points.slice(sketch.graph.points.length), joins = human.graph.relations.slice(sketch.graph.relations.length);
  const connector = human.graph.entities[3]; expect(connector).toMatchObject({ kind: 'line', startPointId: start.id, endPointId: end.id, construction: false });
  expect(joins).toEqual([{ id: expect.any(String), kind: 'coincident', pointIds: [start.id, 'a'] }, { id: expect.any(String), kind: 'coincident', pointIds: [end.id, 'b'] }]);
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  await call(page, 'cad_history', { expectedVersion: current.version, direction: 'undo' }); current = await context(page);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature).toEqual(sketch);
  const regions = await call(page, 'cad_inspect_sketch_regions', { expectedVersion: current.version, sketchId: sketch.id, proposal: { sketch: human } });
  expect(regions.items).toHaveLength(1); expect(regions.items[0].areaMm2).toBeCloseTo(200, 8);
  const pad = { id: 'pad', kind: 'extrude', name: 'Joined plate', suppressed: false, sketchId: sketch.id, distance: ' 5e0 ',
    symmetric: false, operation: 'new', targetId: null, regionSelection: [regions.items[0].reference] };
  await call(page, 'cad_edit_document', { expectedVersion: current.version, edits: [
    { kind: 'append-sketch-entities', sketchId: sketch.id, geometry: { points: [start, end], entities: [connector], relations: joins } }, { kind: 'add-feature', feature: pad }
  ] }); current = await context(page);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature).toEqual(human);
  const built = await call(page, 'cad_build', { expectedVersion: current.version }); expect(built.diagnostics).toEqual([]);
  expect(built.bodies).toHaveLength(1); expect(built.bodies[0].volumeMm3).toBeCloseTo(1000, 7);
  await call(page, 'cad_save_document', { expectedVersion: current.version }); await page.reload();
  await expect(page.getByRole('main', { name: 'Parametric CAD workbench' })).toBeVisible(); current = await context(page);
  expect(current.dirty).toBe(false);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature).toEqual(human);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: pad.id })).feature).toEqual(pad);
});

test('attaches reversed rectangle picks deliberately, follows their drivers and detaches through the selection icon row', async ({ page }) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  const feature = { id: 'attached', kind: 'sketch', name: 'Attached rectangle', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
    points: [{ id: 'a', position: [' anchor ', '3.2'] }, { id: 'c', position: ['22.1', '13.2'] }], entities: [], relations: []
  } };
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [{ kind: 'set-parameter', name: 'anchor', value: 2.1 }, { kind: 'add-feature', feature }] });
  let current = await context(page);
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: current.version })).toMatchObject({ ok: true, data: { view: { available: true, referenceVersion: current.version } } });
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'edit-sketch', sketchId: feature.id } });
  await page.getByRole('button', { name: 'Rectangle', exact: true }).click();
  // Create relations starts on, so snapped corners attach without touching the box.
  await expect(page.getByRole('checkbox', { name: 'Create relations', exact: true })).toBeChecked();
  const canvas = page.getByLabel('Sketch drawing canvas');
  for (const [x, y] of [[22.2, 13.3], [2.2, 3.3]]) {
    const state = await call(page, 'cad_get_viewport', { expectedVersion: current.version });
    const box = await canvas.boundingBox(); if (!box) throw new Error('Sketch projection unavailable.');
    await page.mouse.click(box.x + box.width / 2 + (x - state.view.centerMm[0]) * box.height / state.view.heightSpanMm,
      box.y + box.height / 2 - (y - state.view.centerMm[1]) * box.height / state.view.heightSpanMm);
  }
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false }); current = await context(page);
  const attached = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: feature.id })).feature;
  expect(attached.graph.points.slice(0, 2)).toEqual(feature.graph.points);
  const links = attached.graph.relations.filter((relation: { kind: string }) => relation.kind === 'coincident'); expect(links).toHaveLength(2);
  expect(links.map((relation: { pointIds: string[] }) => relation.pointIds[1])).toEqual(['c', 'a']);
  const link = links.find((relation: { pointIds: string[] }) => relation.pointIds[1] === 'a');
  await call(page, 'cad_edit_document', { expectedVersion: current.version, edits: [{ kind: 'set-parameter', name: 'anchor', value: 4.1 }] }); current = await context(page);
  const following = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: feature.id })).feature;
  const followingPosition = following.graph.points.find((point: { id: string }) => point.id === link.pointIds[0]).position;
  expect(followingPosition[0]).toBeCloseTo(4.1, 12); expect(followingPosition[1]).toBeCloseTo(3.2, 12);
  expect((await call(page, 'cad_measure_sketch', { expectedVersion: current.version, sketchId: feature.id })).materialAreaMm2).toBeCloseTo(180, 8);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'select-sketch-geometry-set', selections: [{ kind: 'point', id: link.pointIds[0] }, { kind: 'point', id: 'a' }] } });
  const coincidence = relationOffer(page, 'Coincident'); await expect(coincidence).toHaveAttribute('aria-pressed', 'true'); await coincidence.click();
  await expect(coincidence).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false }); current = await context(page);
  const detached = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: feature.id })).feature;
  expect(detached.graph.points).toEqual(following.graph.points); expect(detached.graph.relations).toEqual(following.graph.relations.filter((relation: { id: string }) => relation.id !== link.id));
  await call(page, 'cad_edit_document', { expectedVersion: current.version, edits: [{ kind: 'set-parameter', name: 'anchor', value: 6.1 }] }); current = await context(page);
  const movedSource = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: feature.id })).feature;
  expect(movedSource.graph.points.find((point: { id: string }) => point.id === link.pointIds[0]).position).toEqual(followingPosition);
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z'); current = await context(page);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: feature.id })).feature).toEqual(following);
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  await call(page, 'cad_edit_document', { expectedVersion: current.version, edits: [{ kind: 'add-feature', feature: {
    id: 'pad', kind: 'extrude', name: 'Attached plate', suppressed: false, sketchId: feature.id, distance: 5, symmetric: false, operation: 'new', targetId: null
  } }] });
  current = await context(page); const built = await call(page, 'cad_build', { expectedVersion: current.version });
  expect(built.diagnostics).toEqual([]); expect(built.bodies[0].volumeMm3).toBeCloseTo(900, 7);
  await call(page, 'cad_save_document', { expectedVersion: current.version }); await page.reload();
  await expect(page.getByRole('main', { name: 'Parametric CAD workbench' })).toBeVisible(); current = await context(page);
  expect(current.dirty).toBe(false); expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: feature.id })).feature).toEqual(following);
});

test('draws from a legacy slot position without inventing a joint, then moves the reference and saves the detached solid', async ({ page }) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  const sketch = { id: 'legacy', kind: 'sketch', name: 'Legacy reference', suppressed: false, plane: 'XY', offset: 0, profiles: [{
    id: 'slot', name: 'Reference slot', construction: true, geometry: { kind: 'slot', x: ' slotX ', y: 3.2, length: 20, width: 6, angle: 30 }
  }] };
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [
    { kind: 'set-parameter', name: 'slotX', value: 2.1 }, { kind: 'add-feature', feature: sketch }
  ] }); let current = await context(page);
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: current.version }))
    .toMatchObject({ ok: true, data: { view: { available: true, referenceVersion: current.version } } });
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'edit-sketch', sketchId: sketch.id } });
  await page.getByRole('button', { name: 'Circle', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Create relations', exact: true })).toBeChecked();
  const profile = await page.getByRole('button', { name: 'Select Reference slot profile', exact: true }).boundingBox();
  if (!profile) throw new Error('Legacy source geometry unavailable.');
  const x = profile.x + profile.width / 2, y = profile.y + profile.height / 2;
  await page.mouse.move(x, y);
  await expect(page.locator('[data-cad-sketch-snap-kind="profile-position"]')).toBeVisible();
  await page.mouse.click(x, y); await page.keyboard.press('Escape');
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature).toEqual(sketch);
  await page.mouse.click(x, y);
  // One exact keyboard grid step sizes the circle around the acquired off-grid center.
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('Space');
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false }); current = await context(page);
  const human = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature;
  expect(human.profiles).toEqual(sketch.profiles); expect(human.graph.points).toEqual([{ id: expect.any(String), position: [2.1, 3.2] }]);
  expect(human.graph.relations).toEqual([]); expect(human.graph.entities).toHaveLength(1);
  const circle = human.graph.entities[0]; expect(circle).toMatchObject({ kind: 'circle', construction: false, centerPointId: human.graph.points[0].id });
  expect(circle.radius).toBe(5);
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  await call(page, 'cad_history', { expectedVersion: current.version, direction: 'undo' }); current = await context(page);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature).toEqual(sketch);
  await call(page, 'cad_history', { expectedVersion: current.version, direction: 'redo' }); current = await context(page);
  await call(page, 'cad_edit_document', { expectedVersion: current.version, edits: [{ kind: 'set-parameter', name: 'slotX', value: 12.1 }] }); current = await context(page);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature).toEqual(human);
  const regions = await call(page, 'cad_inspect_sketch_regions', { expectedVersion: current.version, sketchId: sketch.id }); expect(regions.items).toHaveLength(1);
  const pad = { id: 'pad', kind: 'extrude', name: 'Detached boss', suppressed: false, sketchId: sketch.id, distance: ' 5e0 ',
    symmetric: false, operation: 'new', targetId: null, regionSelection: [regions.items[0].reference] };
  await call(page, 'cad_edit_document', { expectedVersion: current.version, edits: [{ kind: 'add-feature', feature: pad }] }); current = await context(page);
  const built = await call(page, 'cad_build', { expectedVersion: current.version }); expect(built.diagnostics).toEqual([]);
  expect(built.bodies).toHaveLength(1); expect(built.bodies[0].volumeMm3).toBeCloseTo(Math.PI * circle.radius ** 2 * 5, 7);
  await call(page, 'cad_save_document', { expectedVersion: current.version }); await page.reload();
  await expect(page.getByRole('main', { name: 'Parametric CAD workbench' })).toBeVisible(); current = await context(page);
  expect(current).toMatchObject({ dirty: false, parameters: { slotX: 12.1 } });
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature).toEqual(human);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: pad.id })).feature).toEqual(pad);
});

test('places a plate and bore from off-grid geometry snaps, then extrudes and reopens their exact independent source', async ({ page }) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  const feature = { id: 'snapped', kind: 'sketch', name: 'Snap references', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
    points: [{ id: 'a', position: [' anchor ', '3.2'] }, { id: 'b', position: [22.1, 3.2] }, { id: 'c', position: [22.1, 13.2] },
      { id: 'left', position: [2.1, 8.2] }, { id: 'right', position: [22.1, 8.2] }],
    entities: [{ id: 'base', kind: 'line', startPointId: 'a', endPointId: 'b', construction: true },
      { id: 'side', kind: 'line', startPointId: 'b', endPointId: 'c', construction: true },
      { id: 'axis', kind: 'line', startPointId: 'left', endPointId: 'right', construction: true }], relations: []
  } };
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [
    { kind: 'set-parameter', name: 'anchor', value: 2.1 }, { kind: 'add-feature', feature }
  ] });
  let current = await context(page);
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: current.version })).toMatchObject({ ok: true, data: { view: { available: true, referenceVersion: current.version } } });
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'edit-sketch', sketchId: feature.id } });
  const canvas = page.getByLabel('Sketch drawing canvas');
  const project = async (x: number, y: number) => {
    const state = await call(page, 'cad_get_viewport', { expectedVersion: current.version });
    const box = await canvas.boundingBox(); if (!box) throw new Error('Sketch projection unavailable.');
    return { x: box.x + box.width / 2 + (x - state.view.centerMm[0]) * box.height / state.view.heightSpanMm,
      y: box.y + box.height / 2 - (y - state.view.centerMm[1]) * box.height / state.view.heightSpanMm };
  };
  await page.getByRole('button', { name: 'Rectangle', exact: true }).click();
  // Unticked, snaps copy their exact off-grid positions and add no relation.
  await page.getByRole('checkbox', { name: 'Create relations', exact: true }).uncheck();
  let at = await project(2.2, 3.3); await page.mouse.move(at.x, at.y);
  await expect(page.locator('[data-cad-sketch-snap="a"]')).toBeVisible(); await page.mouse.click(at.x, at.y);
  at = await project(22.2, 13.3); await page.mouse.click(at.x, at.y);
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false }); current = await context(page);
  const plate = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: feature.id })).feature;
  expect(plate.graph.points.slice(0, 5)).toEqual(feature.graph.points);
  expect(plate.graph.points.slice(5).map((point: { position: number[] }) => point.position)).toEqual([[2.1, 3.2], [22.1, 3.2], [22.1, 13.2], [2.1, 13.2]]);
  expect(plate.graph.entities.slice(3).flatMap((entity: { startPointId: string; endPointId: string }) => [entity.startPointId, entity.endPointId])).not.toContain('a');
  expect(plate.graph.relations.map((relation: { kind: string }) => relation.kind)).toEqual(['horizontal', 'vertical', 'horizontal', 'vertical']);
  await page.getByRole('button', { name: 'Circle', exact: true }).click();
  at = await project(12.2, 8.3); await page.mouse.move(at.x, at.y);
  await expect(page.locator('[data-cad-sketch-snap-kind="midpoint"]')).toBeVisible(); await page.mouse.click(at.x, at.y);
  at = await project(14.1, 8.2); await page.keyboard.down('Control'); await page.mouse.click(at.x, at.y); await page.keyboard.up('Control');
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false }); current = await context(page);
  const drawn = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: feature.id })).feature;
  expect(drawn.graph.points.at(-1).position).toEqual([12.1, 8.2]); expect(drawn.graph.entities.at(-1).radius).toBeGreaterThan(1.9); expect(drawn.graph.entities.at(-1).radius).toBeLessThan(2.1);
  expect(drawn.graph.relations).toEqual(plate.graph.relations);
  // A freehand unsnapped pick has screen precision; a driving dimension supplies the exact size.
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'select-sketch-geometry-set', selections: [{ kind: 'entity', id: drawn.graph.entities.at(-1).id }] } });
  await page.getByRole('button', { name: 'Dimension', exact: true }).click();
  await page.getByLabel('Sketch drawing canvas').press('Enter'); await expect(page.locator('[data-cad-sketch-dimension] [role="button"][aria-pressed="true"]')).toHaveCount(1);
  await page.getByLabel('Sketch drawing canvas').press('Enter');
  await page.getByRole('textbox', { name: 'Diameter mm', exact: true }).fill('4');
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled(); await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false }); current = await context(page);
  const accepted = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: feature.id })).feature;
  expect(accepted.graph.entities.at(-1)).toMatchObject({ kind: 'circle', radius: 2 });
  expect(accepted.graph.relations).toEqual([...plate.graph.relations, expect.objectContaining({ kind: 'radial-size', quantity: 'diameter', value: 4 })]);
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  await call(page, 'cad_edit_document', { expectedVersion: current.version, edits: [{ kind: 'add-feature', feature: {
    id: 'pad', kind: 'extrude', name: 'Plate thickness', suppressed: false, sketchId: feature.id, distance: 5, symmetric: false, operation: 'new', targetId: null
  } }] });
  current = await context(page); const built = await call(page, 'cad_build', { expectedVersion: current.version });
  expect(built.diagnostics).toEqual([]); expect(built.bodies[0].volumeMm3).toBeCloseTo(1000 - 20 * Math.PI, 6);
  await call(page, 'cad_save_document', { expectedVersion: current.version }); await page.reload();
  await expect(page.getByRole('main', { name: 'Parametric CAD workbench' })).toBeVisible(); current = await context(page);
  expect(current.dirty).toBe(false); expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: feature.id })).feature).toEqual(accepted);
});

test('moves selected constrained geometry privately without distortion, then finishes, undoes and reopens its solid', async ({ page }) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  const feature = { id: 'movable', kind: 'sketch', name: 'Movable plate', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
    points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [20, 0] }, { id: 'c', position: [20, 10] }, { id: 'd', position: [0, 10] },
      { id: 'center', position: [5, 5] }, { id: 'outside', position: [' 99 ', '99'] }],
    entities: [{ id: 'ab', kind: 'line', startPointId: 'a', endPointId: 'b', construction: false },
      { id: 'bc', kind: 'line', startPointId: 'b', endPointId: 'c', construction: false },
      { id: 'cd', kind: 'line', startPointId: 'c', endPointId: 'd', construction: false },
      { id: 'da', kind: 'line', startPointId: 'd', endPointId: 'a', construction: false },
      { id: 'hole', kind: 'circle', centerPointId: 'center', radius: ' bore ', construction: false }],
    relations: [{ id: 'horizontal', kind: 'horizontal', pointIds: ['a', 'b'] }, { id: 'vertical', kind: 'vertical', pointIds: ['b', 'c'] },
      { id: 'top', kind: 'horizontal', pointIds: ['c', 'd'] }, { id: 'left', kind: 'vertical', pointIds: ['d', 'a'] },
      { id: 'width', kind: 'distance', pointIds: ['a', 'b'], value: ' 20 ' }, { id: 'height', kind: 'distance', pointIds: ['b', 'c'], value: ' 10 ' }]
  } };
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [
    { kind: 'set-parameter', name: 'bore', value: 2 }, { kind: 'add-feature', feature }, { kind: 'add-feature', feature: {
      id: 'pad', kind: 'extrude', name: 'Thickness', suppressed: false, sketchId: feature.id, distance: 5, symmetric: false, operation: 'new', targetId: null
    } }
  ] });
  const base = await context(page); await call(page, 'cad_build', { expectedVersion: base.version });
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: base.version })).toMatchObject({ ok: true, data: { view: { available: true, referenceVersion: base.version } } });
  const open = async () => {
    await (await historyRow(page, 'Movable plate')).dblclick();
    await expect(page.getByRole('button', { name: 'Cancel sketch edits', exact: true })).toBeVisible();
  };
  const selectAll = async () => {
    await page.getByRole('button', { name: 'Line 1 in Movable plate', exact: true }).press('Enter');
    for (const name of ['Line 2', 'Line 3', 'Line 4', 'Circle 5', 'Point 1']) await page.getByRole('button', { name: `${name} in Movable plate`, exact: true }).press('Shift+Enter');
  };
  const enterMove = async () => {
    await page.getByRole('button', { name: 'Move selection', exact: true }).click();
    await page.getByRole('textbox', { name: 'Move X', exact: true }).fill('10.0000');
    await page.getByRole('textbox', { name: 'Move Y', exact: true }).fill('5');
  };
  await open(); await page.getByRole('button', { name: 'Line 3 in Movable plate', exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Move selection', exact: true }).click();
  await page.getByRole('textbox', { name: 'Move Y', exact: true }).fill('5.0000');
  await expect(page.getByRole('alert')).toContainText(/move|translation|constraint/i);
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
  expect((await call(page, 'cad_get_feature', { expectedVersion: base.version, featureId: feature.id })).feature).toEqual(feature);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await selectAll(); await enterMove(); await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
  expect((await call(page, 'cad_get_feature', { expectedVersion: base.version, featureId: feature.id })).feature).toEqual(feature);
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.locator('[data-cad-sketch-point="b"] title')).toHaveText(/30, 5 mm/);
  // The preview already shows the moved point before Apply finishes, and undo waits for no pending edit, so wait for the Move panel to close.
  await expect(page.getByRole('textbox', { name: 'Move X', exact: true })).toBeHidden();
  await page.keyboard.press('Control+z'); await expect(page.locator('[data-cad-sketch-point="b"] title')).toHaveText(/20, 0 mm/);
  await page.keyboard.press('Control+Shift+z'); await expect(page.locator('[data-cad-sketch-point="b"] title')).toHaveText(/30, 5 mm/);
  expect(await context(page)).toMatchObject({ version: base.version, workflowOpen: true });
  await page.getByRole('button', { name: 'Cancel sketch edits', exact: true }).click();
  await expect.poll(() => context(page)).toMatchObject({ version: base.version, workflowOpen: false });
  await open(); await selectAll(); await enterMove(); await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.locator('[data-cad-sketch-point="b"] title')).toHaveText(/30, 5 mm/);
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false }); let current = await context(page);
  const accepted = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: feature.id })).feature;
  expect(accepted.graph.points).toEqual(feature.graph.points.map(point => point.id === 'outside' ? point : { ...point, position: [Number(point.position[0]) + 10, Number(point.position[1]) + 5] }));
  expect(accepted.graph.entities).toEqual(feature.graph.entities); expect(accepted.graph.relations).toEqual(feature.graph.relations);
  const built = await call(page, 'cad_build', { expectedVersion: current.version });
  expect(built.diagnostics).toEqual([]); expect(built.bodies[0].boundsMm).toEqual({ min: [10, 5, 0], max: [30, 15, 5] });
  expect(built.bodies[0].volumeMm3).toBeCloseTo(1000 - 20 * Math.PI, 7);
  await page.keyboard.press('Control+z'); current = await context(page);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: feature.id })).feature).toEqual(feature);
  await page.keyboard.press('Control+Shift+z'); current = await context(page);
  await call(page, 'cad_save_document', { expectedVersion: current.version }); await page.reload();
  await expect(page.getByRole('main', { name: 'Parametric CAD workbench' })).toBeVisible(); current = await context(page);
  expect(current.dirty).toBe(false); expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: feature.id })).feature).toEqual(accepted);
});

test('keeps plate sides and hole radii equal while editing their drivers, then extrudes and reopens the exact part', async ({ page }) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  const feature = { id: 'equal', kind: 'sketch', name: 'Equal plate', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
    points: [{ id: 'a', position: [' 0 ', '0'] }, { id: 'b', position: [40, '0'] }, { id: 'c', position: [40, 20] },
      { id: 'd', position: ['0', 20] }, { id: 'h1', position: ['10', '10'] }, { id: 'h2', position: ['30', '30'] }],
    entities: [{ id: 'ab', kind: 'line', startPointId: 'a', endPointId: 'b', construction: false },
      { id: 'bc', kind: 'line', startPointId: 'b', endPointId: 'c', construction: false },
      { id: 'cd', kind: 'line', startPointId: 'c', endPointId: 'd', construction: false },
      { id: 'da', kind: 'line', startPointId: 'd', endPointId: 'a', construction: false },
      { id: 'hole1', kind: 'circle', centerPointId: 'h1', radius: 2, construction: false },
      { id: 'hole2', kind: 'circle', centerPointId: 'h2', radius: 3, construction: false }],
    relations: [{ id: 'horizontal', kind: 'horizontal', pointIds: ['c', 'd'] }, { id: 'vertical', kind: 'vertical', pointIds: ['b', 'c'] },
      { id: 'width', kind: 'distance', pointIds: ['a', 'b'], value: ' side ' },
      { id: 'hole-size', kind: 'radial-size', entityId: 'hole1', quantity: 'diameter', value: ' bore ' }]
  } };
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [
    { kind: 'set-parameter', name: 'side', value: 40 }, { kind: 'set-parameter', name: 'bore', value: 4 }, { kind: 'add-feature', feature }
  ] });
  let current = await context(page);
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: current.version })).toMatchObject({ ok: true, data: { view: { available: true, referenceVersion: current.version } } });
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'edit-sketch', sketchId: feature.id } });
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'select-sketch-geometry-set', selections: [{ kind: 'entity', id: 'bc' }, { kind: 'entity', id: 'ab' }] } });
  // An offer applies at once; this sketch feeds no solid, so each press is one undoable document edit.
  const equalLength = relationOffer(page, 'Equal length'); await equalLength.click(); await expect(equalLength).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false }); current = await context(page);
  const square = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: feature.id })).feature;
  expect(square.graph.points.slice(0, 4)).toEqual([feature.graph.points[0], feature.graph.points[1], { id: 'c', position: [40, 40] }, { id: 'd', position: ['0', 40] }]);
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'select-sketch-geometry-set', selections: [{ kind: 'entity', id: 'hole2' }, { kind: 'entity', id: 'hole1' }] } });
  const equalRadius = relationOffer(page, 'Equal radius'); await equalRadius.click(); await expect(equalRadius).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false }); current = await context(page);
  await page.getByRole('button', { name: 'Dimension diameter 4 mm, press Enter to edit', exact: true }).dblclick();
  await page.getByRole('textbox', { name: 'Diameter mm', exact: true }).fill('8');
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled(); await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false, parameters: { bore: 8 } }); current = await context(page);
  const accepted = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: feature.id })).feature;
  expect(accepted.graph.entities.filter((entity: { kind: string }) => entity.kind === 'circle')).toEqual([
    { ...feature.graph.entities[4], radius: 4 }, { ...feature.graph.entities[5], radius: 4 }
  ]);
  expect(accepted.graph.relations).toEqual([...feature.graph.relations,
    expect.objectContaining({ kind: 'equal-length', lineIds: ['bc', 'ab'] }), expect.objectContaining({ kind: 'equal-radius', curveIds: ['hole2', 'hole1'] })]);
  await page.keyboard.press('Control+z'); current = await context(page);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: feature.id })).feature.graph.entities.filter((entity: { kind: string }) => entity.kind === 'circle').map((entity: { radius: number }) => entity.radius)).toEqual([2, 2]);
  await page.keyboard.press('Control+Shift+z'); current = await context(page);
  expect((await call(page, 'cad_measure_sketch', { expectedVersion: current.version, sketchId: feature.id })).materialAreaMm2).toBeCloseTo(1600 - 32 * Math.PI, 8);
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  await call(page, 'cad_edit_document', { expectedVersion: current.version, edits: [{ kind: 'add-feature', feature: {
    id: 'pad', kind: 'extrude', name: 'Plate thickness', suppressed: false, sketchId: feature.id, distance: 5, symmetric: false, operation: 'new', targetId: null
  } }] });
  current = await context(page); const built = await call(page, 'cad_build', { expectedVersion: current.version });
  expect(built.diagnostics).toEqual([]); expect(built.bodies[0].volumeMm3).toBeCloseTo(8000 - 160 * Math.PI, 7);
  await call(page, 'cad_save_document', { expectedVersion: current.version }); await page.reload();
  await expect(page.getByRole('main', { name: 'Parametric CAD workbench' })).toBeVisible(); current = await context(page);
  expect(current.dirty).toBe(false); expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: feature.id })).feature).toEqual(accepted);
});

test('drives a circle diameter and major-arc radius through native dimensions, then saves their exact extrusion', async ({ page }) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  const feature = { id: 'radial', kind: 'sketch', name: 'Radial plate', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
    points: [{ id: 'center', position: [' 0 ', '0'] }, { id: 'arc-center', position: ['20', '0'] },
      { id: 'start', position: [25, '0'] }, { id: 'end', position: ['20', 5] }],
    entities: [{ id: 'disk', kind: 'circle', centerPointId: 'center', radius: 5, construction: false },
      { id: 'arc', kind: 'arc', centerPointId: 'arc-center', startPointId: 'start', endPointId: 'end', direction: 'cw', construction: true }], relations: []
  } };
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [
    { kind: 'set-parameter', name: 'nominal', value: 12 }, { kind: 'add-feature', feature }
  ] });
  let current = await context(page);
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: current.version })).toMatchObject({ ok: true, data: { view: { available: true, referenceVersion: current.version } } });
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'edit-sketch', sketchId: feature.id } });
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'select-sketch-geometry', selection: { kind: 'entity', id: 'disk' } } });
  const canvas = page.getByLabel('Sketch drawing canvas');
  // The selected disk places its diameter at the drawn 10 mm and selects it; Enter opens its editor.
  await page.getByRole('button', { name: 'Dimension', exact: true }).click(); await canvas.press('Enter'); await expect(page.locator('[data-cad-sketch-dimension] [role="button"][aria-pressed="true"]')).toHaveCount(1);
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false }); current = await context(page);
  const placed = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: feature.id })).feature;
  expect(placed).toEqual({ ...feature, graph: { ...feature.graph, relations: [{ id: expect.any(String), kind: 'radial-size', entityId: 'disk', quantity: 'diameter', value: 10 }] } });
  await canvas.press('Enter');
  await page.getByRole('textbox', { name: 'Diameter mm', exact: true }).fill('12.0000');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: feature.id })).feature).toEqual(placed);
  await page.getByRole('button', { name: 'Dimension diameter 10 mm, press Enter to edit', exact: true }).dblclick();
  await page.getByRole('button', { name: 'Edit Diameter relation', exact: true }).click();
  await page.getByRole('textbox', { name: 'Diameter expression', exact: true }).fill(' nominal ');
  await page.getByRole('button', { name: 'Keep relation', exact: true }).click();
  await page.getByRole('button', { name: 'Close Diameter relation help', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled(); await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false }); current = await context(page);
  await page.getByRole('button', { name: 'Dimension diameter 12 mm, press Enter to edit', exact: true }).dblclick();
  await page.getByRole('textbox', { name: 'Diameter mm', exact: true }).fill('16');
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled(); await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false, parameters: { nominal: 16 } }); current = await context(page);
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'select-sketch-geometry', selection: { kind: 'entity', id: 'arc' } } });
  await page.getByRole('button', { name: 'Dimension', exact: true }).click(); await canvas.press('Enter'); await expect(page.locator('[data-cad-sketch-dimension] [role="button"][aria-pressed="true"]')).toHaveCount(1);
  await canvas.press('Enter');
  await page.getByRole('textbox', { name: 'Radius mm', exact: true }).fill('6');
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled(); await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false }); current = await context(page);
  const accepted = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: feature.id })).feature;
  expect(accepted.graph.entities).toEqual([{ ...feature.graph.entities[0], radius: 8 }, feature.graph.entities[1]]);
  expect(accepted.graph.points).toEqual([feature.graph.points[0], feature.graph.points[1], { id: 'start', position: [26, '0'] }, { id: 'end', position: ['20', 6] }]);
  expect(accepted.graph.relations).toEqual([expect.objectContaining({ kind: 'radial-size', quantity: 'diameter', value: ' nominal ', entityId: 'disk' }),
    expect.objectContaining({ kind: 'radial-size', quantity: 'radius', value: 6, entityId: 'arc' })]);
  await expect(page.getByRole('button', { name: 'Dimension radius 6 mm, press Enter to edit', exact: true })).toBeVisible();
  expect((await call(page, 'cad_measure_sketch', { expectedVersion: current.version, sketchId: feature.id })).materialAreaMm2).toBeCloseTo(64 * Math.PI, 9);
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  await call(page, 'cad_edit_document', { expectedVersion: current.version, edits: [{ kind: 'add-feature', feature: {
    id: 'pad', kind: 'extrude', name: 'Round plate thickness', suppressed: false, sketchId: feature.id, distance: 5, symmetric: false, operation: 'new', targetId: null
  } }] });
  current = await context(page); const built = await call(page, 'cad_build', { expectedVersion: current.version });
  expect(built.diagnostics).toEqual([]); expect(built.bodies[0].volumeMm3).toBeCloseTo(320 * Math.PI, 7);
  await call(page, 'cad_save_document', { expectedVersion: current.version }); await page.reload();
  await expect(page.getByRole('main', { name: 'Parametric CAD workbench' })).toBeVisible(); current = await context(page);
  expect(current.dirty).toBe(false); expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: feature.id })).feature).toEqual(accepted);
});

test('aligns selected material edges to a construction reference, then rebuilds and reopens the constrained plate', async ({ page }) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  const feature = { id: 'aligned', kind: 'sketch', name: 'Aligned plate', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
    points: [{ id: 'a', position: [' 0 ', '0'] }, { id: 'b', position: ['40', '0'] }, { id: 'c', position: [35, 15] },
      { id: 'd', position: ['0', '20'] }, { id: 'e', position: ['60', '0'] }, { id: 'f', position: ['80', '0'] }],
    entities: [{ id: 'ab', kind: 'line', startPointId: 'a', endPointId: 'b', construction: false },
      { id: 'bc', kind: 'line', startPointId: 'b', endPointId: 'c', construction: false },
      { id: 'cd', kind: 'line', startPointId: 'c', endPointId: 'd', construction: false },
      { id: 'da', kind: 'line', startPointId: 'd', endPointId: 'a', construction: false },
      { id: 'reference', kind: 'line', startPointId: 'e', endPointId: 'f', construction: true }], relations: []
  } };
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [{ kind: 'add-feature', feature }] });
  let current = await context(page);
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: current.version })).toMatchObject({ ok: true, data: { view: { available: true, referenceVersion: current.version } } });
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'edit-sketch', sketchId: feature.id } });
  await page.getByRole('button', { name: 'Line 3 in Aligned plate', exact: true }).click();
  await page.getByRole('button', { name: 'Line 5 in Aligned plate', exact: true }).press('Shift+Enter');
  await expect(relationOffer(page, 'Parallel')).toBeEnabled(); expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: feature.id })).feature).toEqual(feature);
  await relationOffer(page, 'Parallel').click(); await expect(relationOffer(page, 'Parallel')).toHaveAttribute('aria-pressed', 'true');
  await expect(relationOffer(page, 'Perpendicular')).toBeDisabled();
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false }); current = await context(page);
  const parallel = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: feature.id })).feature;
  expect(parallel.graph.points.find((point: { id: string }) => point.id === 'c').position).toEqual([35, 20]);
  expect(parallel.graph.relations).toContainEqual(expect.objectContaining({ kind: 'parallel', lineIds: ['cd', 'reference'] }));
  await page.getByRole('button', { name: 'Line 2 in Aligned plate', exact: true }).click();
  await page.getByRole('button', { name: 'Line 5 in Aligned plate', exact: true }).press('Shift+Enter');
  await relationOffer(page, 'Perpendicular').click(); await expect(relationOffer(page, 'Perpendicular')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false }); current = await context(page);
  const aligned = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: feature.id })).feature;
  expect(aligned.graph.points.find((point: { id: string }) => point.id === 'c').position).toEqual([40, 20]);
  expect(aligned.graph.points[0].position).toEqual([' 0 ', '0']);
  expect(aligned.graph.relations).toEqual([...parallel.graph.relations, expect.objectContaining({ kind: 'perpendicular', lineIds: ['bc', 'reference'] })]);
  await page.keyboard.press('Control+z'); current = await context(page);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: feature.id })).feature).toEqual(parallel);
  await page.keyboard.press('Control+Shift+z'); current = await context(page);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: feature.id })).feature).toEqual(aligned);
  expect((await call(page, 'cad_measure_sketch', { expectedVersion: current.version, sketchId: feature.id })).materialAreaMm2).toBeCloseTo(800, 9);
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  await call(page, 'cad_edit_document', { expectedVersion: current.version, edits: [{ kind: 'add-feature', feature: {
    id: 'pad', kind: 'extrude', name: 'Plate thickness', suppressed: false, sketchId: feature.id, distance: 5, symmetric: false, operation: 'new', targetId: null
  } }] });
  current = await context(page); const built = await call(page, 'cad_build', { expectedVersion: current.version });
  expect(built.diagnostics).toEqual([]); expect(built.bodies[0].volumeMm3).toBeCloseTo(4000, 7);
  await call(page, 'cad_save_document', { expectedVersion: current.version }); await page.reload();
  await expect(page.getByRole('main', { name: 'Parametric CAD workbench' })).toBeVisible(); current = await context(page);
  expect(current.dirty).toBe(false); expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: feature.id })).feature).toEqual(aligned);
});

test('joins distinct sketch endpoints deliberately, then exports and saves their exact constrained extrusion', async ({ page }) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  const feature = { id: 'joined', kind: 'sketch', name: 'Joined plate', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
    points: [[0, 0], [20, 0], [20, 0], [20, 10], [20, 10], [0, 10], [0, 10], [0, 5]].map((position, index) => ({ id: `p${index}`, position: index === 0 ? [' 0 ', ' 0 '] : position })),
    entities: [0, 1, 2, 3].map(index => ({ id: `line${index}`, kind: 'line', construction: false, startPointId: `p${index * 2}`, endPointId: `p${index * 2 + 1}` })),
    relations: [...[0, 1, 2].map(index => ({ id: `join${index}`, kind: 'coincident', pointIds: [`p${index * 2 + 1}`, `p${index * 2 + 2}`] })),
      ...[0, 1, 2, 3].map(index => ({ id: `axis${index}`, kind: index % 2 ? 'vertical' : 'horizontal', pointIds: [`p${index * 2}`, `p${index * 2 + 1}`] })),
      { id: 'width', kind: 'distance', pointIds: ['p0', 'p1'], value: ' 20 ' }, { id: 'height', kind: 'distance', pointIds: ['p2', 'p3'], value: 10 }]
  } };
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [{ kind: 'add-feature', feature }] });
  let current = await context(page);
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: current.version })).toMatchObject({ ok: true, data: { view: { available: true, referenceVersion: current.version } } });
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'edit-sketch', sketchId: 'joined' } });
  await page.getByRole('button', { name: 'Point 1 in Joined plate', exact: true }).click();
  await page.getByRole('button', { name: 'Point 8 in Joined plate', exact: true }).click({ modifiers: ['Shift'] });
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: 'joined' })).feature).toEqual(feature);
  await relationOffer(page, 'Coincident').click(); await expect(relationOffer(page, 'Coincident')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false }); current = await context(page);
  const joined = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: 'joined' })).feature;
  expect(joined.graph.points).toHaveLength(8); expect(joined.graph.points[0].position).toEqual([' 0 ', ' 0 ']); expect(joined.graph.points[7].position).toEqual([0, 0]);
  const closure = joined.graph.relations.find((relation: { kind: string; id: string }) => relation.kind === 'coincident' && !feature.graph.relations.some(source => source.id === relation.id));
  expect(closure).toMatchObject({ kind: 'coincident', pointIds: ['p0', 'p7'] });
  expect((await call(page, 'cad_measure_sketch', { expectedVersion: current.version, sketchId: 'joined' })).materialAreaMm2).toBeCloseTo(200, 9);
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  const downloading = page.waitForEvent('download'); await call(page, 'cad_export_dxf', { expectedVersion: current.version, sketchId: 'joined' });
  const path = await (await downloading).path(); if (!path) throw new Error('DXF download missing.');
  expect((await readFile(path, 'utf8')).match(/\nLINE\r?\n/g)).toHaveLength(4);
  await call(page, 'cad_edit_document', { expectedVersion: current.version, edits: [{ kind: 'add-feature', feature: {
    id: 'pad', kind: 'extrude', name: 'Plate thickness', suppressed: false, sketchId: 'joined', distance: 5, symmetric: false, operation: 'new', targetId: null
  } }] });
  current = await context(page);
  const built = await call(page, 'cad_build', { expectedVersion: current.version }); expect(built.diagnostics).toEqual([]); expect(built.bodies[0].volumeMm3).toBeCloseTo(1000, 7);
  expect(await rawCall(page, 'cad_edit_document', { expectedVersion: current.version, edits: [{ kind: 'remove-sketch-relation', sketchId: 'joined', relationId: closure.id }] })).toMatchObject({ ok: false });
  expect((await context(page)).version).toBe(current.version);
  await call(page, 'cad_save_document', { expectedVersion: current.version }); await page.reload();
  await expect(page.getByRole('main', { name: 'Parametric CAD workbench' })).toBeVisible();
  current = await context(page); expect(current.dirty).toBe(false);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: 'joined' })).feature).toEqual(joined);
});

test('selects analytic boxes and overlapping sketch operands through shared filters without changing geometry', async ({ page }) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  const feature = { id: 'spatial', kind: 'sketch', name: 'Spatial sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
    points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [20, 0] }, { id: 'c', position: [40, 20] }],
    entities: [{ id: 'ab', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' },
      { id: 'bc', kind: 'line', construction: false, startPointId: 'b', endPointId: 'c' }], relations: []
  } };
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [{ kind: 'add-feature', feature }] });
  const current = await context(page);
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: current.version })).toMatchObject({ ok: true, data: { view: { available: true, referenceVersion: current.version } } });
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'edit-sketch', sketchId: feature.id } });
  const canvas = page.getByLabel('Sketch drawing canvas');
  const project = async (x: number, y: number) => {
    const state = await call(page, 'cad_get_viewport', { expectedVersion: current.version });
    const view = state.view as { centerMm: [number, number] };
    return canvas.evaluate((element, { x, y, center }) => {
      const matrix = (element as SVGSVGElement).getScreenCTM(); if (!matrix) throw new Error('Sketch projection unavailable.');
      const p = new DOMPoint(x - center[0], center[1] - y).matrixTransform(matrix); return { x: p.x, y: p.y };
    }, { x, y, center: view.centerMm });
  };
  /** Drags a box and returns how it was drawn: a window rightwards, a crossing leftwards. */
  const box = async (start: [number, number], end: [number, number]) => {
    const a = await project(...start), b = await project(...end);
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 3 });
    const drawn = page.locator('.cad-sketch-selection-box'), dashed = await drawn.evaluate(element => getComputedStyle(element).strokeDasharray);
    const mode = await drawn.getAttribute('class'); await page.mouse.up();
    return { mode: mode?.match(/is-(window|crossing)/)?.[1], dashed: dashed !== 'none' };
  };
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'set-sketch-pick-filter', filter: 'points' } });
  expect(await box([-2, -2], [22, 2])).toEqual({ mode: 'window', dashed: false });
  expect((await call(page, 'cad_get_viewport', { expectedVersion: current.version })).selectedSketchGeometrySet).toEqual([{ kind: 'point', id: 'a' }, { kind: 'point', id: 'b' }]);
  expect(await context(page)).toMatchObject({ version: current.version, workflowOpen: false });
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'set-sketch-pick-filter', filter: 'edges' } });
  expect(await box([22, 4], [-2, -2])).toEqual({ mode: 'crossing', dashed: true });
  expect((await call(page, 'cad_get_viewport', { expectedVersion: current.version })).selectedSketchGeometrySet).toEqual([{ kind: 'entity', id: 'ab' }, { kind: 'entity', id: 'bc' }]);
  // Drawn rightwards over the same span the window holds only the line wholly inside it.
  await canvas.press('Escape');
  expect(await box([-2, -2], [22, 4])).toEqual({ mode: 'window', dashed: false });
  expect((await call(page, 'cad_get_viewport', { expectedVersion: current.version })).selectedSketchGeometrySet).toEqual([{ kind: 'entity', id: 'ab' }]);
  await canvas.press('Escape');
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'set-sketch-pick-filter', filter: 'auto' } });
  const at = await project(20, 0); await page.mouse.click(at.x, at.y, { button: 'right' });
  const menu = page.getByRole('menu', { name: 'Select other actions', exact: true });
  await expect(menu).toBeVisible(); expect(await context(page)).toMatchObject({ workflowOpen: true });
  await menu.getByRole('menuitem', { name: 'Line 2', exact: true }).hover();
  await expect(page.locator('[data-cad-sketch-entity="bc"]')).toHaveClass(/is-pick-highlighted/);
  await menu.press('Escape'); expect((await call(page, 'cad_get_viewport', { expectedVersion: current.version })).selectedSketchGeometrySet).toEqual([]);
  await page.mouse.click(at.x, at.y, { button: 'right' });
  const empty = await project(-5, -5); await page.mouse.click(empty.x, empty.y);
  await expect(menu).toBeHidden(); expect((await call(page, 'cad_get_viewport', { expectedVersion: current.version })).selectedSketchGeometrySet).toEqual([]);
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await menu.getByRole('menuitem', { name: 'Line 2', exact: true }).click();
  expect((await call(page, 'cad_get_viewport', { expectedVersion: current.version })).selectedSketchGeometrySet).toEqual([{ kind: 'entity', id: 'bc' }]);
  const selectedEdge = page.getByRole('button', { name: 'Line 2 in Spatial sketch', exact: true });
  await expect(selectedEdge).toBeFocused(); await selectedEdge.press('Shift+F10');
  await page.getByRole('menu', { name: 'Sketch edge actions', exact: true }).getByRole('menuitem', { name: 'Select other', exact: true }).click();
  await menu.getByRole('menuitem', { name: /^Point 2 ·/ }).click();
  await expect(page.getByRole('button', { name: 'Point 2 in Spatial sketch', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  expect((await call(page, 'cad_get_viewport', { expectedVersion: current.version })).selectedSketchGeometrySet).toEqual([{ kind: 'point', id: 'b' }]);
  // A double-click on an edge selects its contour, both lines through their shared corner; with Alt its tangent chain, which that corner ends.
  const selected = async () => ((await call(page, 'cad_get_viewport', { expectedVersion: current.version })).selectedSketchGeometrySet as { kind: string; id: string }[])
    .map(atom => `${atom.kind}:${atom.id}`).sort().join(' ');
  await canvas.press('Escape');
  const onLine = await project(30, 10);
  await page.mouse.dblclick(onLine.x, onLine.y);
  await expect.poll(selected).toBe('entity:ab entity:bc');
  await expect(page.locator('.cad-sketch-context')).toContainText('Contour · 2 edges');
  await page.keyboard.down('Alt'); await page.mouse.dblclick(onLine.x, onLine.y); await page.keyboard.up('Alt');
  await expect.poll(selected).toBe('entity:bc');
  // From an empty selection N steps through everything under the pointer at the corner: the point, both lines, then the axis the corner lies on,
  // and round again. With something under the pointer already selected, it steps on from that.
  await canvas.press('Escape'); await expect.poll(selected).toBe('');
  const corner = await project(20, 0); await page.mouse.move(corner.x, corner.y);
  let last = await selected();
  const step = async (key: string) => { await page.keyboard.press(key); await expect.poll(selected).not.toBe(last); last = await selected(); return last; };
  const seen = [await step('n'), await step('n'), await step('n'), await step('n')];
  expect(seen[0]).toBe('point:b'); expect(new Set(seen.slice(1, 3))).toEqual(new Set(['entity:ab', 'entity:bc'])); expect(seen[3]).not.toMatch(/point:|entity:(ab|bc)/);
  expect(await step('n')).toBe('point:b');
  expect(await step('Shift+N')).toBe(seen[3]);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: feature.id })).feature).toEqual(feature);
  expect(await context(page)).toMatchObject({ version: current.version, workflowOpen: false });
});

test('selects point pairs directly for alignment and linked distance without implicit dragging or discarded constraints', async ({ page }) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [
    { kind: 'set-parameter', name: 'spacing', value: 40 },
    { kind: 'add-feature', feature: { id: 'pair-sketch', kind: 'sketch', name: 'Pair sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
      points: [{ id: 'a', position: [' 0 ', ' 0 '] }, { id: 'b', position: [30, 10] }, { id: 'c', position: [50, 10] }],
      entities: [{ id: 'bc', kind: 'line', construction: false, startPointId: 'b', endPointId: 'c' }], relations: []
    } } }
  ] });
  let current = await context(page);
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: current.version }))
    .toMatchObject({ ok: true, data: { view: { available: true, referenceVersion: current.version } } });
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'edit-sketch', sketchId: 'pair-sketch' } });
  await page.getByRole('button', { name: 'Point 1 in Pair sketch', exact: true }).click();
  await page.getByRole('button', { name: 'Point 2 in Pair sketch', exact: true }).click({ modifiers: ['Shift'] });
  expect(await context(page)).toMatchObject({ version: current.version, workflowOpen: false });
  const pair = [{ kind: 'point', id: 'a' }, { kind: 'point', id: 'b' }];
  expect((await call(page, 'cad_get_viewport', { expectedVersion: current.version })).selectedSketchGeometrySet).toEqual(pair);
  await relationOffer(page, 'Horizontal').click(); await expect(relationOffer(page, 'Horizontal')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false }); current = await context(page);
  const aligned = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: 'pair-sketch' })).feature;
  expect(aligned.graph.points[0].position).toEqual([' 0 ', ' 0 ']); expect(aligned.graph.points[1].position).toEqual([30, 0]);
  await page.getByRole('button', { name: 'Dimension', exact: true }).click();
  await page.getByLabel('Sketch drawing canvas').press('Enter'); await expect(page.locator('[data-cad-sketch-dimension] [role="button"][aria-pressed="true"]')).toHaveCount(1);
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false }); current = await context(page);
  const measured = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: 'pair-sketch' })).feature;
  expect(measured.graph).toEqual({ ...aligned.graph, relations: [...aligned.graph.relations, { id: expect.any(String), kind: 'distance', pointIds: ['a', 'b'], value: 30 }] });
  await page.getByLabel('Sketch drawing canvas').press('Enter');
  await page.getByRole('textbox', { name: 'Distance mm', exact: true }).fill('35'); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: 'pair-sketch' })).feature).toEqual(measured);
  await page.locator('[data-cad-sketch-dimension] [role="button"][aria-pressed="true"]').dblclick();
  await page.getByRole('button', { name: 'Edit Distance relation', exact: true }).click();
  await page.getByRole('textbox', { name: 'Distance expression', exact: true }).fill(' spacing ');
  await page.getByRole('button', { name: 'Keep relation', exact: true }).click();
  await page.getByRole('button', { name: 'Close Distance relation help', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled(); await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false }); current = await context(page);
  const constrained = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: 'pair-sketch' })).feature;
  expect(constrained.graph.points[1].position).toEqual([40, 0]); expect(constrained.graph.points[2].position).toEqual([50, 10]);
  expect(constrained.graph.relations).toContainEqual(expect.objectContaining({ kind: 'horizontal' }));
  expect(constrained.graph.relations).toContainEqual(expect.objectContaining({ kind: 'distance', value: ' spacing ' }));
  // A relation the bound distance forbids goes to the native judge, which refuses it: the part keeps its version, the header counts
  // the conflict and its issue highlights the points. The bound distance stays selected, so the pair is picked again.
  await page.getByRole('button', { name: 'Point 1 in Pair sketch', exact: true }).click();
  await page.getByRole('button', { name: 'Point 2 in Pair sketch', exact: true }).click({ modifiers: ['Shift'] });
  await expect(relationOffer(page, 'Vertical')).toBeDisabled();
  const joining = relationOffer(page, 'Coincident'); await joining.click();
  const issues = page.locator('[data-cad-sketch-issues]'); await expect(issues).toBeEnabled(); await issues.click();
  const diagnostic = page.getByRole('list', { name: 'Constraint issues', exact: true }).locator('[data-cad-issue-category="conflicting"]').first();
  await expect(diagnostic).toBeEnabled();
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false, version: current.version });
  await expect(joining).toHaveAttribute('aria-pressed', 'false'); await diagnostic.click();
  await expect(page.locator('.cad-sketch-graph-point.is-relation-highlighted').first()).toBeVisible();
  expect((await context(page)).version).toBe(current.version);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: 'pair-sketch' })).feature).toEqual(constrained);
  const rejection = await rawCall(page, 'cad_edit_document', { expectedVersion: current.version, edits: [{ kind: 'set-sketch-relation', sketchId: 'pair-sketch',
    relation: { id: 'attempted-vertical', kind: 'vertical', pointIds: ['a', 'b'] } }] });
  expect(rejection).toMatchObject({ ok: false, error: { code: 'sketch-conflicting', details: { feedback: { sketchId: 'pair-sketch', reason: 'conflicting',
    subjects: expect.arrayContaining([expect.objectContaining({ category: 'conflicting', pointIds: ['a', 'b'] })]) } } } });
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: 'pair-sketch' })).feature).toEqual(constrained);
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'select-sketch-geometry-set', selections: [...pair].reverse() } });
  expect((await call(page, 'cad_get_viewport', { expectedVersion: current.version })).selectedSketchGeometrySet).toEqual([...pair].reverse());
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
  await expect.poll(async () => (await call(page, 'cad_get_feature', { expectedVersion: (await context(page)).version, featureId: 'pair-sketch' })).feature).toEqual(aligned);
});

test('rounds and bevels constrained corners with linked drivers, native dimensions, exact extrusion and reopen', async ({ page }) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [
    { kind: 'set-parameter', name: 'size', value: 2 },
    { kind: 'add-feature', feature: { id: 'outline', kind: 'sketch', name: 'Corner plate', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
      points: [{ id: 'a', position: [' 0 ', '0'] }, { id: 'b', position: [20, '0'] }, { id: 'c', position: ['size * 10', '10'] }, { id: 'd', position: ['0', '10'] }],
      entities: [
        { id: 'ab', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' },
        { id: 'bc', kind: 'line', construction: false, startPointId: 'b', endPointId: 'c' },
        { id: 'cd', kind: 'line', construction: false, startPointId: 'c', endPointId: 'd' },
        { id: 'da', kind: 'line', construction: false, startPointId: 'd', endPointId: 'a' }
      ], relations: [{ id: 'width', kind: 'distance', pointIds: ['a', 'b'], value: 'size * 10' }]
    } } }
  ] });
  let current = await context(page);
  const original = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: 'outline' })).feature;
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: current.version }))
    .toMatchObject({ ok: true, data: { view: { available: true, referenceVersion: current.version } } });
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'edit-sketch', sketchId: 'outline' } });
  await page.getByRole('button', { name: 'Point 1 in Corner plate', exact: true }).click();
  const openFillet = async () => {
    await page.getByRole('button', { name: 'Sketch corner tools', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Fillet', exact: true }).click();
  };
  await openFillet();
  await page.getByRole('textbox', { name: 'Fillet radius mm', exact: true }).fill('2');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await context(page)).version).toBe(current.version);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: 'outline' })).feature).toEqual(original);
  await openFillet();
  await page.getByRole('button', { name: 'Edit Fillet radius relation', exact: true }).click();
  await page.getByRole('textbox', { name: 'Fillet radius expression', exact: true }).fill(' size ');
  await page.getByRole('button', { name: 'Keep relation', exact: true }).click();
  await page.getByRole('button', { name: 'Close Fillet radius relation help', exact: true }).click();
  await page.getByRole('textbox', { name: 'Fillet radius mm', exact: true }).fill('3');
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(async () => (await context(page)).version).not.toBe(current.version);
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false });
  current = await context(page);
  const rounded = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: 'outline' })).feature;
  expect(rounded.graph.points[0]).toEqual(original.graph.points[0]);
  expect(rounded.graph.points[1].position).toEqual([30, '0']);
  expect(rounded.graph.relations.at(-1)).toMatchObject({ kind: 'fillet-corner', value: ' size ' });
  const roundedArea = 291 + 9 * Math.PI / 4;
  expect((await call(page, 'cad_measure_sketch', { expectedVersion: current.version, sketchId: 'outline' })).materialAreaMm2).toBeCloseTo(roundedArea, 8);
  await page.locator(`[data-cad-sketch-dimension="${rounded.graph.relations.at(-1).id}"] [role="button"]`).dblclick();
  await expect(page.getByRole('textbox', { name: 'Fillet radius mm', exact: true })).toHaveValue('3');
  await page.getByRole('textbox', { name: 'Fillet radius mm', exact: true }).fill('4');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await context(page)).version).toBe(current.version);
  await call(page, 'cad_edit_document', { expectedVersion: current.version, edits: [{ kind: 'create-sketch-corner', sketchId: 'outline', pointId: 'b', treatment: {
    kind: 'chamfer', setbacks: [2, 3], trimPointIds: ['chamfer-a', 'chamfer-b'], entityId: 'chamfer', relationId: 'bevel'
  } }] });
  current = await context(page);
  const accepted = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: 'outline' })).feature;
  expect(accepted.graph.relations.at(-1)).toMatchObject({ id: 'bevel', kind: 'chamfer-corner', lineIds: ['ab', 'bc'], values: [2, 3] });
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'fit' } });
  await page.locator('[data-cad-sketch-dimension="bevel"] [role="button"]').first().dblclick();
  await expect(page.getByRole('textbox', { name: 'Setback 1 mm', exact: true })).toHaveValue('2');
  await expect(page.getByRole('textbox', { name: 'Setback 2 mm', exact: true })).toHaveValue('3');
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  await call(page, 'cad_edit_document', { expectedVersion: current.version, edits: [{ kind: 'add-feature', feature: {
    id: 'pad', kind: 'extrude', name: 'Corner plate thickness', suppressed: false, sketchId: 'outline', distance: 5, symmetric: false, operation: 'new', targetId: null
  } }] });
  current = await context(page);
  const built = await call(page, 'cad_build', { expectedVersion: current.version });
  expect(built.diagnostics).toEqual([]); expect(built.bodies[0].volumeMm3).toBeCloseTo((roundedArea - 3) * 5, 6);
  const downloading = page.waitForEvent('download'); await call(page, 'cad_export_solid', { expectedVersion: current.version, format: 'step' });
  const path = await (await downloading).path(); if (!path) throw new Error('STEP download missing.');
  expect((await readFile(path, 'utf8')).startsWith('ISO-10303-21;')).toBe(true);
  await call(page, 'cad_save_document', { expectedVersion: current.version }); await page.reload();
  await expect(page.getByRole('main', { name: 'Parametric CAD workbench' })).toBeVisible();
  const reopened = await context(page); expect(reopened.dirty).toBe(false);
  expect((await call(page, 'cad_get_feature', { expectedVersion: reopened.version, featureId: 'outline' })).feature).toEqual(accepted);
});

test('draws and constrains fresh geometry through the UI, then extrudes, exports and reopens the exact sketch', async ({ page }) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  let current = await context(page);
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: current.version }))
    .toMatchObject({ ok: true, data: { view: { available: true } } });
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'select-reference-plane', plane: 'XY' } });
  await page.getByRole('button', { name: 'Sketch', exact: true }).click();
  await enableGridSnap(page);
  const canvas = page.getByLabel('Sketch drawing canvas');
  const clickPoint = async (x: number, y: number) => {
    const point = await canvas.evaluate((element, [x, y]) => {
      const matrix = (element as SVGSVGElement).getScreenCTM();
      if (!matrix) throw new Error('Sketch projection unavailable.');
      const point = new DOMPoint(x, -y).matrixTransform(matrix); return { x: point.x, y: point.y };
    }, [x, y]);
    await page.mouse.click(point.x, point.y);
  };
  await clickPoint(0, 0); await clickPoint(40, 25);
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false });
  current = await context(page);
  const features = await call(page, 'cad_read_features', { expectedVersion: current.version });
  const sketch = features.items[0];
  expect(sketch.profiles).toEqual([]); expect(sketch.graph.points).toHaveLength(4);
  // Create relations starts on, so the corner drawn on the origin stays fixed there.
  expect(sketch.graph.relations.map((relation: { kind: string }) => relation.kind)).toEqual(['horizontal', 'vertical', 'horizontal', 'vertical', 'fixed-axis', 'fixed-axis']);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await expect(page.getByLabel('Sketch constraint status')).toHaveText('Under defined · 2 DOF');
  // Drawing left nothing selected. Dimension picks the bottom line, picking it again places its length at the drawn size and selects it, and Enter opens its editor.
  expect((await call(page, 'cad_get_viewport', { expectedVersion: current.version })).selectedSketchGeometrySet).toEqual([]);
  const bottom = page.locator(`[data-cad-sketch-entity="${sketch.graph.entities[0].id}"]`);
  await page.getByRole('button', { name: 'Dimension', exact: true }).click(); await bottom.press('Enter'); await bottom.press('Enter');
  const dimension = page.locator('[data-cad-sketch-dimension] [role="button"][aria-pressed="true"]'); await expect(dimension).toHaveCount(1);
  await expect.poll(async () => (await context(page)).version).not.toBe(current.version);
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false }); current = await context(page);
  await page.getByLabel('Sketch drawing canvas').press('Enter');
  await page.getByRole('textbox', { name: 'Length mm', exact: true }).fill('30');
  expect(await context(page)).toMatchObject({ version: current.version, workflowOpen: true });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect.poll(() => context(page)).toMatchObject({ version: current.version, workflowOpen: false });
  await dimension.dblclick();
  await page.getByRole('textbox', { name: 'Length mm', exact: true }).fill('30');
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(async () => (await context(page)).version).not.toBe(current.version);
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false });
  current = await context(page);
  await expect(page.getByLabel('Sketch constraint status')).toHaveText('Under defined · 1 DOF');
  const resized = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature;
  expect(resized.graph.points.map((point: { id: string }) => point.id)).toEqual(sketch.graph.points.map((point: { id: string }) => point.id));
  expect(resized.graph.relations.at(-1)).toMatchObject({ kind: 'distance', value: 30 });
  expect((await call(page, 'cad_measure_sketch', { expectedVersion: current.version, sketchId: sketch.id })).materialAreaMm2).toBeCloseTo(750, 7);
  const xs = resized.graph.points.map((point: { position: number[] }) => point.position[0]);
  // The grid magnet catches whole 5 mm nodes, so the circle sits on the node nearest the middle.
  const centerX = Math.round((Math.min(...xs) + Math.max(...xs)) / 10) * 5;
  await page.getByRole('button', { name: 'Circle', exact: true }).click();
  await clickPoint(centerX, 10); await clickPoint(centerX + 5, 10);
  await expect.poll(async () => (await context(page)).version).not.toBe(current.version);
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false });
  current = await context(page);
  const accepted = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature;
  expect(accepted.graph.entities.at(-1)).toMatchObject({ kind: 'circle', radius: 5 });
  const area = 750 - Math.PI * 25;
  expect((await call(page, 'cad_measure_sketch', { expectedVersion: current.version, sketchId: sketch.id })).materialAreaMm2).toBeCloseTo(area, 7);
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  await page.getByRole('button', { name: 'Pad / Pocket', exact: true }).click();
  await page.getByRole('textbox', { name: 'Length mm', exact: true }).fill('5');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(async () => (await context(page)).version).not.toBe(current.version);
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false });
  current = await context(page);
  const built = await call(page, 'cad_build', { expectedVersion: current.version });
  expect(built.diagnostics).toEqual([]); expect(built.bodies[0].volumeMm3).toBeCloseTo(area * 5, 6);
  await page.getByRole('button', { name: 'File', exact: true }).click();
  const downloading = page.waitForEvent('download'); await page.getByRole('menuitem', { name: 'Export STEP', exact: true }).click();
  const path = await (await downloading).path(); if (!path) throw new Error('STEP download missing.');
  expect((await readFile(path, 'utf8')).startsWith('ISO-10303-21;')).toBe(true);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => context(page)).toMatchObject({ dirty: false }); await page.reload();
  await expect(page.getByRole('main', { name: 'Parametric CAD workbench' })).toBeVisible();
  const reopened = await context(page);
  expect((await call(page, 'cad_get_feature', { expectedVersion: reopened.version, featureId: sketch.id })).feature).toEqual(accepted);
});

test('moves one shared graph point over an enclosing profile, with cancel, undo and keyboard editing', async ({ page }) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [{ kind: 'add-feature', feature: {
    id: 'outline', kind: 'sketch', name: 'Outline', suppressed: false, plane: 'XY', offset: 0,
    profiles: [{ id: 'outer', name: 'Outer', construction: false, geometry: { kind: 'rectangle', x: -5, y: -10, width: 40, height: 30, cornerRadius: 0 } }],
    graph: { points: [{ id: 'a', position: ['0', '0'] }, { id: 'b', position: [20, 0] }, { id: 'c', position: [20, 10] }, { id: 'd', position: [0, 10] }],
      entities: [
        { id: 'ab', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' },
        { id: 'bc', kind: 'line', construction: false, startPointId: 'b', endPointId: 'c' },
        { id: 'cd', kind: 'line', construction: false, startPointId: 'c', endPointId: 'd' },
        { id: 'da', kind: 'line', construction: false, startPointId: 'd', endPointId: 'a' }
      ], relations: [] }
  } }] });
  const initial = await context(page);
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: initial.version }))
    .toMatchObject({ ok: true, data: { view: { available: true, referenceVersion: initial.version } } });
  await call(page, 'cad_set_viewport', { expectedVersion: initial.version, command: { kind: 'edit-sketch', sketchId: 'outline' } });
  await enableGridSnap(page);
  const point = page.getByRole('button', { name: 'Point 2 in Outline', exact: true });
  const box = await point.boundingBox();
  const scale = await page.getByLabel('Sketch drawing canvas').evaluate(element => {
    const canvas = element as SVGSVGElement, bounds = canvas.getBoundingClientRect();
    return { x: bounds.width / canvas.viewBox.baseVal.width, y: bounds.height / canvas.viewBox.baseVal.height };
  });
  if (!box) throw new Error('Missing graph point.');
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const drag = async () => {
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.mouse.move(start.x + 5 * scale.x, start.y - 5 * scale.y, { steps: 4 });
  };
  await drag();
  expect(await context(page)).toMatchObject({ version: initial.version, workflowOpen: true });
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect.poll(() => context(page)).toMatchObject({ version: initial.version, workflowOpen: false });
  await drag(); await page.mouse.up();
  await expect.poll(async () => (await context(page)).version).not.toBe(initial.version);
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false });
  await expect(point).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Select Outer profile', exact: true })).toHaveAttribute('aria-pressed', 'false');
  const source = async () => call(page, 'cad_get_feature', { expectedVersion: (await context(page)).version, featureId: 'outline' });
  expect(await source()).toMatchObject({ feature: {
    profiles: [{ geometry: { x: -5, y: -10, width: 40, height: 30 } }],
    graph: { points: [{ id: 'a', position: ['0', '0'] }, { id: 'b', position: [25, 5] }, { id: 'c', position: [20, 10] }, { id: 'd', position: [0, 10] }] }
  } });
  await page.keyboard.press('Control+z');
  await expect.poll(source).toMatchObject({ feature: { graph: { points: [{ position: ['0', '0'] }, { position: [20, 0] }, { position: [20, 10] }, { position: [0, 10] }] } } });
  const beforeNudge = (await context(page)).version;
  await point.press('ArrowRight');
  await expect.poll(async () => (await context(page)).version).not.toBe(beforeNudge);
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false });
  expect(await source()).toMatchObject({ feature: { graph: { points: [{ position: ['0', '0'] }, { position: [25, 0] }, { position: [20, 10] }, { position: [0, 10] }] } } });
  const beforeLocked = (await context(page)).version;
  const locked = page.getByRole('button', { name: 'Point 1 in Outline', exact: true });
  await locked.press('ArrowRight');
  expect(await context(page)).toMatchObject({ version: beforeLocked, workflowOpen: false });
  // The refused nudge still selects its point, and focus never selects, so Delete would remove Point 1; Space selects Point 2 first.
  await expect(locked).toHaveAttribute('aria-pressed', 'true');
  await point.press(' '); await expect(point).toHaveAttribute('aria-pressed', 'true'); await expect(locked).toHaveAttribute('aria-pressed', 'false');
  await point.press('Delete');
  await expect.poll(async () => (await context(page)).version).not.toBe(beforeLocked);
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false });
  const deleted = await source();
  expect(deleted.feature.graph.points.map((item: { id: string }) => item.id)).toEqual(['a', 'c', 'd']);
  expect(deleted.feature.graph.entities.map((item: { id: string }) => item.id)).toEqual(['cd', 'da']);
  expect(deleted.feature.profiles).toHaveLength(1);
  await page.keyboard.press('Control+z');
  await expect.poll(source).toMatchObject({ feature: { graph: { points: [{ position: ['0', '0'] }, { position: [25, 0] }, { position: [20, 10] }, { position: [0, 10] }] } } });
});

test('keeps an authored polyline open, moves one joint and closes a separate analytic line-arc boundary', async ({ page }) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  let current = await context(page);
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: current.version }))
    .toMatchObject({ ok: true, data: { view: { available: true } } });
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'select-reference-plane', plane: 'XY' } });
  await page.getByRole('button', { name: 'Sketch', exact: true }).click();
  await enableGridSnap(page);
  await page.getByRole('button', { name: 'Line', exact: true }).click();
  const canvas = page.getByLabel('Sketch drawing canvas');
  const clickPoint = async (x: number, y: number) => {
    const point = await canvas.evaluate((element, [x, y]) => {
      const matrix = (element as SVGSVGElement).getScreenCTM();
      if (!matrix) throw new Error('Sketch projection unavailable.');
      const point = new DOMPoint(x, -y).matrixTransform(matrix); return { x: point.x, y: point.y };
    }, [x, y]);
    await page.mouse.click(point.x, point.y);
  };
  await clickPoint(0, 0); await clickPoint(20, 0); await clickPoint(20, 20);
  await page.getByRole('button', { name: 'Finish chain', exact: true }).click();
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false }); current = await context(page);
  const sketch = (await call(page, 'cad_read_features', { expectedVersion: current.version })).items[0];
  expect(sketch.graph.entities).toHaveLength(2); expect(sketch.graph.points.map((point: { position: number[] }) => point.position)).toEqual([[0, 0], [20, 0], [20, 20]]);
  // Create relations starts on, so the start drawn on the origin stays fixed there.
  expect(sketch.graph.relations.map((relation: { kind: string; pointId: string }) => [relation.kind, relation.pointId])).toEqual([['fixed-axis', sketch.graph.points[0].id], ['fixed-axis', sketch.graph.points[0].id]]);
  expect((await call(page, 'cad_measure_sketch', { expectedVersion: current.version, sketchId: sketch.id })).materialAreaMm2).toBe(0);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('button', { name: `Point 2 in ${sketch.name}`, exact: true }).press('ArrowRight');
  await expect.poll(async () => (await context(page)).version).not.toBe(current.version);
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false }); current = await context(page);
  await expect(page.getByLabel('Sketch constraint status')).toHaveText('Under defined · 4 DOF');
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature.graph.points.map((point: { position: number[] }) => point.position))
    .toEqual([[0, 0], [25, 0], [20, 20]]);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await context(page)).version).not.toBe(current.version);
  current = await context(page);
  await page.getByRole('button', { name: 'Line', exact: true }).click();
  await clickPoint(40, 0); await clickPoint(60, 0);
  await page.getByRole('button', { name: '3-point Arc', exact: true }).click();
  await clickPoint(60, 20); await clickPoint(70, 10);
  await page.getByRole('button', { name: 'Line segment', exact: true }).click(); await clickPoint(40, 20);
  await page.getByRole('button', { name: 'Close profile', exact: true }).click();
  await expect.poll(async () => (await context(page)).version).not.toBe(current.version);
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false }); current = await context(page);
  const accepted = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature;
  expect(accepted.graph.entities.map((entity: { kind: string }) => entity.kind)).toEqual(['line', 'line', 'line', 'arc', 'line', 'line']);
  expect(accepted.graph.points.slice(0, 3)).toEqual(sketch.graph.points);
  const area = 400 + 50 * Math.PI;
  expect((await call(page, 'cad_measure_sketch', { expectedVersion: current.version, sketchId: sketch.id })).materialAreaMm2).toBeCloseTo(area, 7);
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  await page.getByRole('button', { name: 'Pad / Pocket', exact: true }).click();
  await page.getByRole('textbox', { name: 'Length mm', exact: true }).fill('5'); await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(async () => (await context(page)).version).not.toBe(current.version);
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false }); current = await context(page);
  const built = await call(page, 'cad_build', { expectedVersion: current.version });
  expect(built.diagnostics).toEqual([]); expect(built.bodies[0].volumeMm3).toBeCloseTo(area * 5, 6);
});

test('edits graph relations and linked circle radius through the shared inspector with honest freedom and edge-only picking', async ({ page }) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [
    { kind: 'set-parameter', name: 'radius', value: 10 },
    { kind: 'add-feature', feature: { id: 'outline', kind: 'sketch', name: 'Outline', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
      points: [{ id: 'center', position: ['0', '0'] }, { id: 'a', position: ['30', '0'] }, { id: 'b', position: [40, 5] }],
      entities: [{ id: 'ring', kind: 'circle', construction: false, centerPointId: 'center', radius: ' radius ' },
        { id: 'ab', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' }], relations: []
    } } }
  ] });
  let current = await context(page);
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: current.version }))
    .toMatchObject({ ok: true, data: { view: { available: true, referenceVersion: current.version } } });
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'edit-sketch', sketchId: 'outline' } });
  await expect(page.getByLabel('Sketch constraint status')).toHaveText('Under defined · 2 DOF');
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'select-sketch-geometry', selection: { kind: 'entity', id: 'ring' } } });
  const ring = page.locator('[data-cad-sketch-entity="ring"] > circle');
  const interior = await ring.evaluate(element => {
    const circle = element as SVGCircleElement, matrix = circle.getScreenCTM();
    if (!matrix) throw new Error('Circle projection is unavailable.');
    const point = new DOMPoint(circle.cx.baseVal.value + 4, circle.cy.baseVal.value + 4).matrixTransform(matrix);
    return { x: point.x, y: point.y };
  });
  await page.mouse.click(interior.x, interior.y);
  expect((await call(page, 'cad_get_viewport', { expectedVersion: current.version })).selectedSketchGeometry).toBeUndefined();
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'select-sketch-geometry', selection: { kind: 'entity', id: 'ab' } } });
  const endY = () => page.locator('[data-cad-sketch-entity="ab"] > line').evaluate(line => Number(line.getAttribute('y2')) - Number(line.getAttribute('y1')));
  await expect.poll(endY).toBeCloseTo(5, 9);
  await relationOffer(page, 'Horizontal').click(); await expect(relationOffer(page, 'Horizontal')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(endY).toBeCloseTo(0, 9);
  await expect.poll(async () => (await context(page)).version).not.toBe(current.version);
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false });
  current = await context(page);
  await expect(page.getByLabel('Sketch constraint status')).toHaveText('Under defined · 1 DOF');
  expect((await call(page, 'cad_get_viewport', { expectedVersion: current.version })).selectedSketchGeometry).toEqual({ kind: 'entity', id: 'ab' });
  const canvas = page.getByLabel('Sketch drawing canvas');
  await relationOffer(page, 'Dimension the selection').click(); await expect(canvas).toHaveAccessibleDescription(/Click or press Enter to place/);
  await canvas.press('Enter'); await expect(page.locator('[data-cad-sketch-dimension] [role="button"][aria-pressed="true"]')).toHaveCount(1);
  await canvas.press('Enter'); await page.getByRole('textbox', { name: 'Length mm', exact: true }).fill('15'); await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(async () => (await context(page)).version).not.toBe(current.version);
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false });
  current = await context(page);
  await expect(page.getByLabel('Sketch constraint status')).toHaveText('Fully defined');
  await expect(page.getByRole('button', { name: 'Point 3 in Outline', exact: true })).toHaveClass(/is-locked/);
  const inspection = await call(page, 'cad_inspect_sketch_constraints', { expectedVersion: current.version, sketchId: 'outline' });
  expect(inspection.analysis).toMatchObject({ kind: 'solved', degreesOfFreedom: 0 });
  const feature = await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: 'outline' });
  expect(feature.feature.graph.points[2].position[0]).toBeCloseTo(45, 8);
  await page.getByRole('button', { name: 'Dimension distance 15 mm, press Enter to edit', exact: true }).dblclick();
  await page.getByRole('textbox', { name: 'Length mm', exact: true }).fill('17.5');
  await expect.poll(() => page.locator('[data-cad-sketch-entity="ab"] > line').evaluate(line => Number(line.getAttribute('x2')) - Number(line.getAttribute('x1')))).toBeCloseTo(17.5, 9);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Dimension distance 15 mm, press Enter to edit', exact: true }).dblclick();
  await expect(page.getByRole('textbox', { name: 'Length mm', exact: true })).toHaveValue('15');
  expect((await context(page)).version).toBe(current.version);
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'select-sketch-geometry', selection: { kind: 'entity', id: 'ring' } } });
  await page.getByRole('textbox', { name: 'Radius mm', exact: true }).fill('12.5'); await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(async () => (await context(page)).version).not.toBe(current.version);
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false });
  current = await context(page);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: 'outline' })).feature.graph.entities[0].radius).toBe(' radius ');
  expect((await call(page, 'cad_inspect_parameters', { expectedVersion: current.version })).items).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'radius', value: 12.5 })]));
});

test('turns a line green once its dimensions and relations fully define it, under selection and hover, and back when its length is removed', async ({ page }) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  // Expressions fix the start point; the second line stays free throughout.
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [
    { kind: 'add-feature', feature: { id: 'outline', kind: 'sketch', name: 'Outline', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
      points: [{ id: 'a', position: ['30', '0'] }, { id: 'b', position: [40, 5] }, { id: 'c', position: [0, 20] }, { id: 'd', position: [10, 30] }],
      entities: [{ id: 'ab', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' }, { id: 'cd', kind: 'line', construction: false, startPointId: 'c', endPointId: 'd' }],
      relations: []
    } } }
  ] });
  let current = await context(page);
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: current.version }))
    .toMatchObject({ ok: true, data: { view: { available: true, referenceVersion: current.version } } });
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'edit-sketch', sketchId: 'outline' } });
  const status = page.getByLabel('Sketch constraint status'), stroke = (id: string) => page.locator(`[data-cad-sketch-entity="${id}"]`).evaluate(element => getComputedStyle(element).stroke);
  const select = (id: string | null) => call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'select-sketch-geometry', selection: id ? { kind: 'entity', id } : null } });
  const green = 'rgb(94, 216, 138)', blueGrey = 'rgb(159, 194, 211)';
  await expect(status).toHaveText('Under defined · 6 DOF');
  await expect(page.getByRole('button', { name: 'Sketch colours', exact: true })).toBeVisible();
  expect([await stroke('ab'), await stroke('cd')]).toEqual([blueGrey, blueGrey]);
  await select('ab');
  await relationOffer(page, 'Horizontal').click(); await expect(relationOffer(page, 'Horizontal')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await context(page)).version).not.toBe(current.version);
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false });
  current = await context(page);
  await expect(status).toHaveText('Under defined · 5 DOF');
  const canvas = page.getByLabel('Sketch drawing canvas');
  await relationOffer(page, 'Dimension the selection').click(); await expect(canvas).toHaveAccessibleDescription(/Click or press Enter to place/);
  await canvas.press('Enter'); await expect(page.locator('[data-cad-sketch-dimension] [role="button"][aria-pressed="true"]')).toHaveCount(1);
  await canvas.press('Enter'); await page.getByRole('textbox', { name: 'Length mm', exact: true }).fill('15'); await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(async () => (await context(page)).version).not.toBe(current.version);
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false });
  current = await context(page);
  await expect(status).toHaveText('Under defined · 4 DOF');
  // Selection and hover draw over the definition colour exactly as over an under-defined line.
  // The Dimension tool leaves its new dimension selected, so the line is picked again.
  await select('ab'); const selected = await stroke('ab'); expect(selected).not.toBe(green);
  await select('cd'); expect(await stroke('cd')).toBe(selected);
  await select(null);
  await expect.poll(() => stroke('ab')).toBe(green); expect(await stroke('cd')).toBe(blueGrey);
  await expect(page.locator('[data-cad-sketch-point="b"]')).toHaveClass(/is-locked/);
  const middle = (id: string) => page.locator(`[data-cad-sketch-entity="${id}"] > line`).evaluate(element => {
    const line = element as SVGLineElement, matrix = line.getScreenCTM();
    if (!matrix) throw new Error('Line projection is unavailable.');
    const point = new DOMPoint((line.x1.baseVal.value + line.x2.baseVal.value) / 2, (line.y1.baseVal.value + line.y2.baseVal.value) / 2).matrixTransform(matrix);
    return { x: point.x, y: point.y };
  });
  const hovered = await middle('cd'); await page.mouse.move(hovered.x, hovered.y);
  // Hover draws on the next render, so wait for it before taking its colour.
  await expect.poll(() => stroke('cd')).not.toBe(blueGrey);
  const hover = await stroke('cd');
  const defined = await middle('ab'); await page.mouse.move(defined.x, defined.y);
  await expect.poll(() => stroke('ab')).toBe(hover);
  await page.mouse.move(5, 5); await expect.poll(() => stroke('ab')).toBe(green);
  // Removing the length frees the line again.
  // Its row under the sketch in the feature tree removes it with Delete.
  await select('ab'); await openSketchRelations(page);
  await relationRow(page, /^(Length|Distance) relation/).press('Delete');
  await expect.poll(async () => (await context(page)).version).not.toBe(current.version);
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false });
  current = await context(page);
  await expect(status).toHaveText('Under defined · 5 DOF');
  await select(null);
  await expect.poll(() => stroke('ab')).toBe(blueGrey);
  await expect(page.locator('[data-cad-sketch-point="b"]')).not.toHaveClass(/is-locked/);
});

test('previews and applies a linked size across legacy and solved sketch geometry, with cancel and undo', async ({ page }) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [
    { kind: 'set-parameter', name: 'width', value: 20 },
    { kind: 'add-feature', feature: { id: 'outline', kind: 'sketch', name: 'Linked geometry', suppressed: false, plane: 'XY', offset: 0,
      profiles: [{ id: 'plate', name: 'Plate', construction: false, constraints: [{ id: 'width-dimension', kind: 'dimension', quantity: 'width' }],
        geometry: { kind: 'rectangle', x: 40, y: 0, width: ' width ', height: 5, cornerRadius: 0 } }],
      graph: { points: [{ id: 'a', position: ['0', '0'] }, { id: 'b', position: [20, 0] }],
        entities: [{ id: 'ab', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' }],
        relations: [{ id: 'horizontal', kind: 'horizontal', pointIds: ['a', 'b'] }, { id: 'length', kind: 'distance', pointIds: ['a', 'b'], value: 'width' }] } } }
  ] });
  const initial = await context(page);
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: initial.version }))
    .toMatchObject({ ok: true, data: { view: { available: true, referenceVersion: initial.version } } });
  await call(page, 'cad_set_viewport', { expectedVersion: initial.version, command: { kind: 'edit-sketch', sketchId: 'outline' } });
  await call(page, 'cad_set_viewport', { expectedVersion: initial.version, command: { kind: 'select-profile', profileId: 'plate' } });
  const length = () => page.locator('[data-cad-sketch-entity="ab"] > line').evaluate(line => Number(line.getAttribute('x2')) - Number(line.getAttribute('x1')));
  // The legacy rectangle and the solved line both follow the shared width parameter.
  const plate = () => page.getByRole('button', { name: 'Select Plate profile', exact: true }).evaluate(group => (group as SVGGElement).getBBox().width);
  await expect.poll(length).toBeCloseTo(20, 9); await expect.poll(plate).toBeCloseTo(20, 6);
  await page.getByRole('button', { name: 'Configure Width dimension', exact: true }).click();
  await page.getByRole('textbox', { name: 'Dimension value', exact: true }).fill('30');
  await expect.poll(length).toBeCloseTo(30, 9); await expect.poll(plate).toBeCloseTo(30, 6);
  expect(await context(page)).toMatchObject({ version: initial.version, workflowOpen: true });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect.poll(length).toBeCloseTo(20, 9); await expect.poll(plate).toBeCloseTo(20, 6); expect((await context(page)).version).toBe(initial.version);
  await page.getByRole('button', { name: 'Configure Width dimension', exact: true }).click();
  await page.getByRole('textbox', { name: 'Dimension value', exact: true }).fill('30');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false });
  const current = await context(page); expect(current.version).not.toBe(initial.version);
  await expect.poll(length).toBeCloseTo(30, 9); await expect.poll(plate).toBeCloseTo(30, 6);
  const accepted = await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: 'outline' });
  expect(accepted.feature.profiles[0].geometry.width).toBe(' width '); expect(accepted.feature.graph.points[1].position[0]).toBeCloseTo(30, 9);
  await page.keyboard.press('Control+z'); await expect.poll(length).toBeCloseTo(20, 9); await expect.poll(plate).toBeCloseTo(20, 6);
});

test('solves a saved entity sketch through WebMCP, rejects conflicts and exports its exact extrusion', async ({ page, solverRequests: nativeRequests }) => {
  await prepareCadTools(page);
  await call(page, 'cad_open_workspace');
  const initial = await context(page);
  expect(nativeRequests.some(url => url.includes('planegcs'))).toBe(false);
  await call(page, 'cad_edit_document', { expectedVersion: initial.version, edits: [
    { kind: 'set-parameter', name: 'width', value: 20 },
    { kind: 'add-feature', feature: { kind: 'sketch', id: 'outline', name: 'Constrained outline', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
      points: [{ id: 'a', position: ['0', '0'] }, { id: 'b', position: [20, 0] }, { id: 'c', position: [20, 10] }, { id: 'd', position: [0, 10] }],
      entities: [
        { id: 'ab', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' },
        { id: 'bc', kind: 'line', construction: false, startPointId: 'b', endPointId: 'c' },
        { id: 'cd', kind: 'line', construction: false, startPointId: 'c', endPointId: 'd' },
        { id: 'da', kind: 'line', construction: false, startPointId: 'd', endPointId: 'a' }
      ], relations: [
        { id: 'h1', kind: 'horizontal', pointIds: ['a', 'b'] }, { id: 'v1', kind: 'vertical', pointIds: ['b', 'c'] },
        { id: 'h2', kind: 'horizontal', pointIds: ['c', 'd'] }, { id: 'v2', kind: 'vertical', pointIds: ['d', 'a'] },
        { id: 'width', kind: 'distance', pointIds: ['a', 'b'], value: ' width ' }, { id: 'height', kind: 'distance', pointIds: ['a', 'd'], value: 10 }
      ]
    } } }
  ] });
  let current = await context(page);
  await call(page, 'cad_edit_document', { expectedVersion: current.version, edits: [{ kind: 'set-parameter', name: 'width', value: 30 }] });
  current = await context(page);
  const accepted = await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: 'outline' });
  expect(accepted.feature.graph.points[0].position).toEqual(['0', '0']);
  expect(accepted.feature.graph.points[1].position[0]).toBeCloseTo(30, 9);
  expect(accepted.feature.graph.points[2].position[0]).toBeCloseTo(30, 9);
  expect(accepted.feature.graph.relations[4].value).toBe(' width ');
  const conflict = await rawCall(page, 'cad_edit_document', { expectedVersion: current.version, edits: [
    { kind: 'set-sketch-relation', sketchId: 'outline', relation: { id: 'conflict', kind: 'distance', pointIds: ['a', 'b'], value: 10 } }
  ] });
  expect(conflict.ok).toBe(false); expect((await context(page)).version).toBe(current.version);
  // The native solver diagnoses the conflict; its module is the only solver fetched.
  expect(nativeRequests.some(url => url.includes('sketch_solver'))).toBe(true);
  expect(nativeRequests.some(url => url.includes('planegcs'))).toBe(false);
  expect(nativeRequests.some(url => url.includes('replicad_single') || url.includes('occt-import-js'))).toBe(false);
  await call(page, 'cad_edit_document', { expectedVersion: current.version, edits: [{ kind: 'add-feature', feature: {
    id: 'pad', kind: 'extrude', name: 'Plate', suppressed: false, sketchId: 'outline', distance: 5, symmetric: false, operation: 'new', targetId: null
  } }] });
  current = await context(page);
  const built = await call(page, 'cad_build', { expectedVersion: current.version });
  expect(built.diagnostics).toEqual([]);
  expect(built.bodies[0].volumeMm3).toBeCloseTo(1500, 7);
  const downloadPromise = page.waitForEvent('download');
  await call(page, 'cad_export_solid', { expectedVersion: current.version, format: 'step' });
  const download = await downloadPromise, path = await download.path();
  if (!path) throw new Error('STEP download is missing.');
  expect((await readFile(path, 'utf8')).startsWith('ISO-10303-21;')).toBe(true);
  await call(page, 'cad_save_document', { expectedVersion: current.version });
  await page.reload();
  await expect(page.getByRole('main', { name: 'Parametric CAD workbench' })).toBeVisible();
  const reopened = await context(page);
  expect(reopened).toMatchObject({ documentId: current.documentId, dirty: false });
  expect((await call(page, 'cad_get_feature', { expectedVersion: reopened.version, featureId: 'outline' })).feature).toEqual(accepted.feature);
});

test('edits a consumed sketch privately with local history, rejected Finish, exact Cancel and one final part undo', async ({ page }) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [
    { kind: 'add-feature', feature: { id: 'outline', kind: 'sketch', name: 'Outline', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
      points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [20, 0] }, { id: 'c', position: [20, 10] }, { id: 'd', position: [0, 10] }],
      entities: [
        { id: 'ab', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' },
        { id: 'bc', kind: 'line', construction: false, startPointId: 'b', endPointId: 'c' },
        { id: 'cd', kind: 'line', construction: false, startPointId: 'c', endPointId: 'd' },
        { id: 'da', kind: 'line', construction: false, startPointId: 'd', endPointId: 'a' }
      ], relations: []
    } } },
    { kind: 'add-feature', feature: { id: 'pad', kind: 'extrude', name: 'Pad', suppressed: false, sketchId: 'outline', distance: 5, symmetric: false, operation: 'new', targetId: null } }
  ] });
  const base = await context(page), original = (await call(page, 'cad_get_feature', { expectedVersion: base.version, featureId: 'outline' })).feature;
  await call(page, 'cad_build', { expectedVersion: base.version });
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: base.version }))
    .toMatchObject({ ok: true, data: { view: { available: true, referenceVersion: base.version } } });
  const openEdit = async () => {
    await (await historyRow(page, 'Outline')).dblclick();
    await expect(page.getByRole('button', { name: 'Cancel sketch edits', exact: true })).toBeVisible();
  };
  await openEdit();
  expect(await context(page)).toMatchObject({ version: base.version, workflowOpen: true });
  expect((await rawCall(page, 'cad_edit_document', { expectedVersion: base.version, edits: [{ kind: 'rename-document', name: 'Concurrent agent' }] })).ok).toBe(false);
  expect(await page.getByRole('button', { name: 'Save', exact: true }).isEnabled()).toBe(false);
  await page.getByRole('textbox', { name: 'Plane offset mm', exact: true }).fill('2');
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toHaveCount(0);
  expect((await call(page, 'cad_get_feature', { expectedVersion: base.version, featureId: 'outline' })).feature).toEqual(original);
  await page.getByRole('button', { name: 'Line 2 in Outline', exact: true }).press('Delete');
  await expect(page.locator('[data-cad-sketch-entity]')).toHaveCount(3);
  expect((await call(page, 'cad_get_feature', { expectedVersion: base.version, featureId: 'outline' })).feature).toEqual(original);
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Finish sketch', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Cancel sketch edits', exact: true })).toBeVisible();
  expect(await context(page)).toMatchObject({ version: base.version, workflowOpen: true });
  await page.keyboard.press('Control+z'); await expect(page.locator('[data-cad-sketch-entity]')).toHaveCount(4);
  await page.getByRole('button', { name: 'Point 2 in Outline', exact: true }).press('ArrowRight');
  await expect(page.locator('[data-cad-sketch-point="b"] title')).toHaveText(/25, 0 mm/);
  expect((await call(page, 'cad_get_feature', { expectedVersion: base.version, featureId: 'outline' })).feature).toEqual(original);
  await page.getByRole('button', { name: 'Cancel sketch edits', exact: true }).click();
  await expect(page.getByLabel('3D model viewport')).toBeVisible();
  await expect.poll(() => context(page)).toMatchObject({ version: base.version, workflowOpen: false });
  expect((await call(page, 'cad_get_feature', { expectedVersion: base.version, featureId: 'outline' })).feature).toEqual(original);
  await openEdit();
  await page.getByRole('button', { name: 'Line 2 in Outline', exact: true }).press('Delete');
  await expect(page.locator('[data-cad-sketch-entity]')).toHaveCount(3);
  const endpoints = [];
  for (const id of ['b', 'c']) {
    const box = await page.locator(`[data-cad-sketch-point="${id}"]`).boundingBox();
    if (!box) throw new Error('Sketch endpoint unavailable.');
    endpoints.push({ x: box.x + box.width / 2 + 1, y: box.y + box.height / 2 + 1 });
  }
  await page.getByRole('button', { name: 'Line', exact: true }).click(); await expect(page.getByRole('checkbox', { name: 'Create relations', exact: true })).toBeChecked();
  for (const point of endpoints) await page.mouse.click(point.x, point.y);
  await page.getByRole('button', { name: 'Finish chain', exact: true }).click();
  await expect(page.locator('[data-cad-sketch-entity]')).toHaveCount(4);
  expect((await call(page, 'cad_get_feature', { expectedVersion: base.version, featureId: 'outline' })).feature).toEqual(original);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  // The replacement edge has its own two points, held on the survivors by coincident relations.
  await expect(page.locator('[data-cad-sketch-point]')).toHaveCount(6);
  await page.getByRole('button', { name: 'Point 2 in Outline', exact: true }).press('ArrowRight');
  await expect(page.locator('[data-cad-sketch-point="b"] title')).toHaveText(/25, 0 mm/);
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  await expect(page.getByLabel('3D model viewport')).toBeVisible();
  await expect.poll(async () => (await context(page)).version).not.toBe(base.version);
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false });
  const changed = await context(page), built = await call(page, 'cad_build', { expectedVersion: changed.version });
  expect(built.diagnostics).toEqual([]); expect(built.bodies[0].volumeMm3).toBeCloseTo(1125, 7);
  await page.keyboard.press('Control+z');
  const undone = await context(page);
  expect((await call(page, 'cad_get_feature', { expectedVersion: undone.version, featureId: 'outline' })).feature).toEqual(original);
});

test('reselects explicit extrusion areas after replacing a consumed boundary without changing the accepted part early', async ({ page }) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [{ kind: 'add-feature', feature: {
    id: 'outline', kind: 'sketch', name: 'Selected outline', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
      points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [40, 0] }, { id: 'c', position: [40, 20] }, { id: 'd', position: [0, 20] }],
      entities: [{ id: 'ab', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' },
        { id: 'bc', kind: 'line', construction: false, startPointId: 'b', endPointId: 'c' },
        { id: 'cd', kind: 'line', construction: false, startPointId: 'c', endPointId: 'd' },
        { id: 'da', kind: 'line', construction: false, startPointId: 'd', endPointId: 'a' }], relations: []
    }
  } }] });
  let current = await context(page);
  const regions = await call(page, 'cad_inspect_sketch_regions', { expectedVersion: current.version, sketchId: 'outline' });
  await call(page, 'cad_edit_document', { expectedVersion: current.version, edits: [{ kind: 'add-feature', feature: {
    id: 'pad', kind: 'extrude', name: 'Selected pad', suppressed: false, sketchId: 'outline', regionSelection: [regions.items[0].reference],
    distance: ' 5e0 ', symmetric: false, operation: 'new', targetId: null
  } }] });
  current = await context(page);
  const originalSketch = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: 'outline' })).feature;
  const originalPad = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: 'pad' })).feature;
  await call(page, 'cad_build', { expectedVersion: current.version });
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: current.version }))
    .toMatchObject({ ok: true, data: { view: { available: true, referenceVersion: current.version } } });
  await (await historyRow(page, 'Selected outline')).dblclick();
  await expect(page.getByRole('button', { name: 'Cancel sketch edits', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Line 2 in Selected outline', exact: true }).press('Delete');
  const endpoints = [];
  for (const id of ['b', 'c']) {
    const box = await page.locator(`[data-cad-sketch-point="${id}"]`).boundingBox(); if (!box) throw new Error('Endpoint unavailable.');
    endpoints.push({ x: box.x + box.width / 2 + 1, y: box.y + box.height / 2 + 1 });
  }
  await page.getByRole('button', { name: 'Line', exact: true }).click(); await expect(page.getByRole('checkbox', { name: 'Create relations', exact: true })).toBeChecked();
  for (const point of endpoints) await page.mouse.click(point.x, point.y);
  await page.getByRole('button', { name: 'Finish chain', exact: true }).click();
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Update dependent sketch areas', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Finish sketch', exact: true })).toBeDisabled();
  expect((await context(page)).version).toBe(current.version);
  const chooseReplacement = async () => {
    await page.getByRole('button', { name: 'Choose areas for Selected pad', exact: true }).click();
    const canvas = page.getByLabel('3D model canvas'); await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox(); if (!box) throw new Error('Area canvas unavailable.');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.getByRole('button', { name: 'Finish area selection', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Finish sketch', exact: true })).toBeEnabled();
  };
  await chooseReplacement();
  await page.getByRole('button', { name: 'Back to sketch', exact: true }).click();
  await expect(page.getByLabel('Sketch drawing canvas')).toBeVisible();
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: 'outline' })).feature).toEqual(originalSketch);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: 'pad' })).feature).toEqual(originalPad);
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click(); await chooseReplacement();
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  await expect(page.getByLabel('3D model viewport')).toBeVisible();
  await expect.poll(async () => (await context(page)).version).not.toBe(current.version);
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false });
  const accepted = await context(page), changedPad = (await call(page, 'cad_get_feature', { expectedVersion: accepted.version, featureId: 'pad' })).feature;
  expect({ ...changedPad, regionSelection: originalPad.regionSelection }).toEqual(originalPad);
  expect(changedPad.regionSelection).not.toEqual(originalPad.regionSelection);
  const built = await call(page, 'cad_build', { expectedVersion: accepted.version });
  expect(built.diagnostics).toEqual([]); expect(built.bodies[0].volumeMm3).toBeCloseTo(4000, 7);
  await page.keyboard.press('Control+z'); const undone = await context(page);
  expect((await call(page, 'cad_get_feature', { expectedVersion: undone.version, featureId: 'outline' })).feature).toEqual(originalSketch);
  expect((await call(page, 'cad_get_feature', { expectedVersion: undone.version, featureId: 'pad' })).feature).toEqual(originalPad);
});
