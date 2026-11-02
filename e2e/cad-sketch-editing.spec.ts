import { expect, test } from './fixtures/native-sketch-solver';
import { prepareCadTools, callCadTool as call, rawCadToolCall as rawCall, cadContext as context, importCadDraft } from './cad-tool-helpers';

test('edits a free sketch vertex directly, cancels cleanly and preserves the contour through undo and save', async ({ page }) => {
  await prepareCadTools(page);
  await call(page, 'cad_open_workspace');
  const points = [[0, 0], [20, 0], [20, 10], [0, 10]];
  // Profile grips edit saved legacy profiles, which only a saved draft can hold now.
  await importCadDraft(page, [{
    kind: 'sketch', id: 'outline', name: 'Outline', suppressed: false, plane: 'XY', offset: 0,
    profiles: [{ id: 'plate', name: 'Plate', construction: false, geometry: { kind: 'polygon', points } }]
  }], { name: 'Editable plate' });
  const initial = await context(page);
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: initial.version }))
    .toMatchObject({ ok: true, data: { view: { available: true, referenceVersion: initial.version } } });
  await call(page, 'cad_set_viewport', { expectedVersion: initial.version, command: { kind: 'edit-sketch', sketchId: 'outline' } });
  await call(page, 'cad_set_viewport', { expectedVersion: initial.version, command: { kind: 'select-profile', profileId: 'plate' } });
  const grip = page.getByRole('button', { name: 'Point 2 of Plate', exact: true });
  const box = await grip.boundingBox();
  const scale = await page.getByLabel('Sketch drawing canvas').evaluate(element => {
    const canvas = element as SVGSVGElement, bounds = canvas.getBoundingClientRect();
    return { x: bounds.width / canvas.viewBox.baseVal.width, y: bounds.height / canvas.viewBox.baseVal.height };
  });
  if (!box) throw new Error('Missing vertex grip.');
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const drag = async () => {
    await page.mouse.move(start.x, start.y); await page.mouse.down();
    await page.mouse.move(start.x + 5 * scale.x, start.y + 5 * scale.y, { steps: 4 });
  };
  await drag();
  expect(await context(page)).toMatchObject({ version: initial.version, workflowOpen: true });
  await page.keyboard.press('Escape'); await page.mouse.up();
  expect(await context(page)).toMatchObject({ version: initial.version, workflowOpen: false });
  await drag(); await page.mouse.up();
  await expect(grip).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Select Plate profile', exact: true })).toHaveAttribute('aria-pressed', 'false');
  let current = await context(page);
  expect(await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: 'outline' }))
    .toMatchObject({ feature: { profiles: [{ geometry: { points: [[0, 0], [25, -5], [20, 10], [0, 10]] } }] } });
  await page.keyboard.press('Control+z');
  current = await context(page);
  expect(await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: 'outline' }))
    .toMatchObject({ feature: { profiles: [{ geometry: { points } }] } });
  await grip.press('ArrowRight');
  current = await context(page);
  const accepted = await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: 'outline' });
  expect(accepted).toMatchObject({ feature: { profiles: [{ geometry: { points: [[0, 0], [25, 0], [20, 10], [0, 10]] } }] } });
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'finish-sketch' } });
  await call(page, 'cad_save_document', { expectedVersion: current.version });
  await expect(page).toHaveURL(url => url.pathname.endsWith(`/cad/${current.documentId}`));
  await page.reload();
  await expect(page.getByRole('main', { name: 'Parametric CAD workbench' })).toBeVisible();
  const reopened = await context(page);
  expect(reopened).toMatchObject({ documentId: current.documentId, dirty: false });
  expect(await call(page, 'cad_get_feature', { expectedVersion: reopened.version, featureId: 'outline' }))
    .toMatchObject({ feature: accepted.feature });
});

test('edits slot sizes and an analytic arc joint without translating their profiles', async ({ page }) => {
  await prepareCadTools(page);
  await call(page, 'cad_open_workspace');
  const arc = { kind: 'path', segments: [
    { kind: 'arc', center: [0, 0], radius: 10, startAngle: 0, sweep: 180 },
    { kind: 'line', start: [-10, 0], end: [10, 0] }
  ] };
  // Slot size grips edit saved legacy profiles, which only a saved draft can hold now.
  await importCadDraft(page, [{
    kind: 'sketch', id: 'curves', name: 'Curves', suppressed: false, plane: 'XY', offset: 0,
    profiles: [
      { id: 'slot', name: 'Slot', construction: false, geometry: { kind: 'slot', x: 40, y: 0, length: 20, width: 10, angle: 0 } },
      { id: 'arc', name: 'Arc', construction: false, geometry: arc }
    ]
  }], { name: 'Editable curves' });
  const initial = await context(page);
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: initial.version }))
    .toMatchObject({ ok: true, data: { view: { available: true, referenceVersion: initial.version } } });
  await call(page, 'cad_set_viewport', { expectedVersion: initial.version, command: { kind: 'edit-sketch', sketchId: 'curves' } });
  await call(page, 'cad_set_viewport', { expectedVersion: initial.version, command: { kind: 'select-profile', profileId: 'slot' } });
  const construction = page.getByRole('region', { name: 'Modeling area', exact: true }).getByRole('checkbox', { name: 'Construction', exact: true });
  await construction.check();
  await expect.poll(async () => call(page, 'cad_get_feature', { expectedVersion: (await context(page)).version, featureId: 'curves' }))
    .toMatchObject({ feature: { profiles: [{ id: 'slot', construction: true, geometry: { x: 40, y: 0, length: 20, width: 10 } }, { id: 'arc', construction: false }] } });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(construction).not.toBeChecked();
  await page.getByRole('button', { name: 'Length of Slot', exact: true }).press('ArrowRight');
  await page.getByRole('button', { name: 'Width of Slot', exact: true }).press('ArrowUp');
  let current = await context(page);
  expect(await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: 'curves' }))
    .toMatchObject({ feature: { profiles: [{ geometry: { kind: 'slot', x: 40, y: 0, length: 30, width: 20, angle: 0 } }, { geometry: arc }] } });
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'select-profile', profileId: 'arc' } });
  await page.getByRole('button', { name: 'Point 1 of Arc', exact: true }).press('ArrowRight');
  current = await context(page);
  const edited = await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: 'curves' });
  expect(edited).toMatchObject({ feature: { profiles: [
    { geometry: { kind: 'slot', x: 40, y: 0, length: 30, width: 20 } },
    { geometry: { kind: 'path', segments: [{ kind: 'arc' }, { kind: 'line', start: [-10, 0], end: [15, 0] }] } }
  ] } });
  await page.keyboard.press('Control+z');
  current = await context(page);
  expect(await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: 'curves' }))
    .toMatchObject({ feature: { profiles: [{ geometry: { length: 30, width: 20 } }, { geometry: arc }] } });
});

test('drags a generated rectangle by its side grip and by its interior, each as one undoable edit of its inputs', async ({ page }) => {
  await prepareCadTools(page);
  await call(page, 'cad_open_workspace');
  const plate = { id: 'plate', kind: 'generator', idPrefix: 'plate', name: 'Plate', construction: false, geometry: { kind: 'rectangle', x: 0, y: 0, width: 20, height: 10, cornerRadius: 0 } };
  await importCadDraft(page, [{ kind: 'sketch', id: 'outline', name: 'Outline', suppressed: false, plane: 'XY', offset: 0, profiles: [],
    graph: { points: [], entities: [], relations: [plate] } }], { name: 'Generated plate' });
  const initial = await context(page);
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: initial.version }))
    .toMatchObject({ ok: true, data: { view: { available: true, referenceVersion: initial.version } } });
  await call(page, 'cad_set_viewport', { expectedVersion: initial.version, command: { kind: 'edit-sketch', sketchId: 'outline' } });
  await call(page, 'cad_set_viewport', { expectedVersion: initial.version, command: { kind: 'select-profile', profileId: 'plate' } });
  const scale = await page.getByLabel('Sketch drawing canvas').evaluate(element => {
    const canvas = element as SVGSVGElement, bounds = canvas.getBoundingClientRect();
    return { x: bounds.width / canvas.viewBox.baseVal.width, y: bounds.height / canvas.viewBox.baseVal.height };
  });
  const centre = async (name: string) => {
    const box = await page.getByRole('button', { name, exact: true }).boundingBox(); if (!box) throw new Error(`Missing ${name} grip.`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const drag = async (from: { x: number; y: number }, [dx, dy]: readonly [number, number]) => {
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    await page.mouse.move(from.x + dx * scale.x, from.y - dy * scale.y, { steps: 4 }); await page.mouse.up();
  };
  const geometry = async () => {
    const feature = (await call(page, 'cad_get_feature', { expectedVersion: (await context(page)).version, featureId: 'outline' })).feature as { graph: { relations: { id: string; geometry?: unknown }[] } };
    return feature.graph.relations.find(relation => relation.id === 'plate')?.geometry;
  };
  // The right side's grip lies on the generated edge, and takes the press from it.
  await drag(await centre('Right side of Plate'), [5, 0]);
  await expect.poll(geometry).toEqual({ ...plate.geometry, width: 25 });
  // A press inside the shape, away from its edges, moves the whole shape.
  const left = await centre('Left side of Plate'), right = await centre('Right side of Plate');
  await drag({ x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 }, [0, 5]);
  await expect.poll(geometry).toEqual({ ...plate.geometry, y: 5, width: 25 });
  await page.keyboard.press('Control+z'); await expect.poll(geometry).toEqual({ ...plate.geometry, width: 25 });
  await page.keyboard.press('Control+z'); await expect.poll(geometry).toEqual(plate.geometry);
});
