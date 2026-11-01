import { expect, test } from './fixtures/native-sketch-solver';
import type { Locator, Page } from '@playwright/test';
import { prepareCadTools, callCadTool as call, cadContext as context, historyRow } from './cad-tool-helpers';

test('selects a dimension with a click, edits it on double-click and removes selected dimensions with Delete in one undo step', async ({ page }) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  const sketch = { id: 'bracket', kind: 'sketch', name: 'Bracket', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
    points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [40, 0] }, { id: 'c', position: [40, 30] }],
    entities: [{ id: 'base', kind: 'line', startPointId: 'a', endPointId: 'b', construction: false }, { id: 'side', kind: 'line', startPointId: 'b', endPointId: 'c', construction: false }],
    relations: [{ id: 'length', kind: 'distance', pointIds: ['a', 'b'], value: 40 }, { id: 'rise', kind: 'axis-distance', pointIds: ['b', 'c'], axis: 'y', value: 30 },
      { id: 'run', kind: 'axis-distance', pointIds: ['a', 'c'], axis: 'x', value: 40 }] } };
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [{ kind: 'add-feature', feature: sketch }] });
  await (await historyRow(page, 'Bracket')).dblclick();
  await expect(page.getByRole('button', { name: 'Finish sketch', exact: true })).toBeVisible();
  const label = (id: string) => page.locator(`[data-cad-sketch-dimension="${id}"] [role="button"]`);
  const status = page.locator('[data-cad-dimension-status]');

  // A click selects only: the measured line lights up and the editor stays closed.
  await label('length').click();
  await expect(label('length')).toHaveAttribute('aria-pressed', 'true');
  await expect(status).toHaveText('Length selected · Double-click or Enter edits · Delete removes');
  await expect(page.locator('[data-cad-highlight-entity="base"]')).toHaveCount(1);
  await expect(page.getByRole('textbox', { name: 'Length mm', exact: true })).toHaveCount(0);
  await label('length').dblclick();
  await expect(page.getByRole('textbox', { name: 'Length mm', exact: true })).toHaveValue('40');

  await label('rise').click(); await label('run').click({ modifiers: ['Shift'] });
  await expect(status).toHaveText('2 dimensions selected · Delete removes them');
  await page.keyboard.press('Delete');
  await expect(label('rise')).toHaveCount(0); await expect(label('run')).toHaveCount(0); await expect(label('length')).toHaveCount(1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(label('rise')).toHaveCount(1); await expect(label('run')).toHaveCount(1);

  // Right-click selects the dimension and offers the shared commands; unavailable ones say why.
  const box = await label('rise').boundingBox(); if (!box) throw new Error('Dimension label unavailable.');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await expect(label('rise')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('menuitem', { name: 'Make reference', exact: true })).toBeDisabled();
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await expect(label('rise')).toHaveCount(0);
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false });
  const current = await context(page);
  const finished = (await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: 'bracket' })).feature;
  expect(finished.graph.relations).toEqual([sketch.graph.relations[0], sketch.graph.relations[2]]);
});

test('keeps the selection colour on a hovered or focused dimension label or chip, with focus still marked', async ({ page }) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  const sketch = { id: 'bracket', kind: 'sketch', name: 'Bracket', suppressed: false, plane: 'XY', offset: 0,
    profiles: [{ id: 'plate', name: 'Plate', construction: false, constraints: [{ id: 'width-dimension', kind: 'dimension', quantity: 'width' }],
      geometry: { kind: 'rectangle', x: 60, y: 0, width: 20, height: 10, cornerRadius: 0 } }],
    graph: { points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [40, 0] }, { id: 'c', position: [40, 30] }],
      entities: [{ id: 'base', kind: 'line', startPointId: 'a', endPointId: 'b', construction: false }, { id: 'side', kind: 'line', startPointId: 'b', endPointId: 'c', construction: false }],
      relations: [{ id: 'length', kind: 'distance', pointIds: ['a', 'b'], value: 40 }, { id: 'measured', kind: 'reference-dimension', measurement: { kind: 'line-length', entityId: 'side' } }] } };
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [{ kind: 'add-feature', feature: sketch }] });
  await (await historyRow(page, 'Bracket')).dblclick();
  await expect(page.getByRole('button', { name: 'Finish sketch', exact: true })).toBeVisible();
  const label = (id: string) => page.locator(`[data-cad-sketch-dimension="${id}"] [role="button"]`);
  const colour = (target: Locator) => target.evaluate(element => getComputedStyle(element).color);
  // A theme colour as it resolves where the target sits.
  const theme = (target: Locator, name: string) => target.evaluate((element, variable) => {
    const probe = element instanceof SVGElement ? document.createElementNS('http://www.w3.org/2000/svg', 'g') : document.createElement('span');
    probe.style.color = `var(${variable})`; element.parentNode!.append(probe);
    const value = getComputedStyle(probe).color; probe.remove(); return value;
  }, name);
  const length = page.locator('[data-cad-sketch-dimension="length"]'), measured = page.locator('[data-cad-sketch-dimension="measured"]');
  const primary = await theme(length, '--primary'), foreground = await theme(length, '--foreground');
  expect(primary).not.toBe(foreground);

  // A clicked label stays in the selection colour while the pointer is still over it, for a driving and a reference dimension.
  await label('length').click(); await expect(label('length')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => colour(length)).toBe(primary);
  await label('measured').click(); await expect(label('measured')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => colour(measured)).toBe(primary);
  // Hover still brightens an unselected label.
  await label('length').hover(); await expect.poll(() => colour(length)).toBe(foreground); expect(await colour(measured)).toBe(primary);

  // Keyboard focus on the selected label keeps the selection colour and adds the underline; once unselected, focus brightens it.
  await page.mouse.move(2, 2); await label('measured').focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  await expect.poll(() => label('measured').evaluate(element => element.matches(':focus-visible'))).toBe(true);
  await expect(label('measured')).toHaveAttribute('aria-pressed', 'true'); expect(await colour(measured)).toBe(primary);
  const underline = () => measured.locator('.cad-sketch-graph-dimension-text').evaluate(element => getComputedStyle(element).textDecorationLine);
  expect(await underline()).toBe('underline');
  await page.keyboard.press('Escape'); await expect(label('measured')).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => colour(measured)).toBe(foreground); expect(await underline()).toBe('underline');

  // A selected profile chip keeps the selection colour under the pointer and with keyboard focus, which draws the focus ring.
  await call(page, 'cad_set_viewport', { expectedVersion: (await context(page)).version, command: { kind: 'select-profile', profileId: 'plate' } });
  const chip = page.getByRole('button', { name: /^Dimension width / });
  await chip.click(); await expect(chip).toHaveAttribute('aria-pressed', 'true');
  const chipPrimary = await theme(chip, '--primary');
  await expect.poll(() => colour(chip)).toBe(chipPrimary);
  await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  await expect.poll(() => chip.evaluate(element => element.matches(':focus-visible'))).toBe(true);
  await expect.poll(() => colour(chip)).toBe(chipPrimary); expect(await chip.evaluate(element => getComputedStyle(element).outlineStyle)).toBe('solid');
});

test('leaves every pointer action on a point or an edge under a dimension line or arrow to that geometry, and the dimension its line elsewhere', async ({ page }) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  const sketch = { id: 'plate', kind: 'sketch', name: 'Plate', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
    points: [{ id: 'o', position: [30, 20] }], entities: [{ id: 'hole', kind: 'circle', centerPointId: 'o', radius: 10, construction: false }],
    relations: [{ id: 'size', kind: 'radial-size', entityId: 'hole', quantity: 'radius', value: 10 }] } };
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [{ kind: 'add-feature', feature: sketch }] });
  await (await historyRow(page, 'Plate')).dblclick();
  await expect(page.getByRole('button', { name: 'Finish sketch', exact: true })).toBeVisible();
  const label = page.locator('[data-cad-sketch-dimension="size"] [role="button"]'), pointed = page.locator('[data-cad-sketch-dimension="size"].is-pointed');
  const point = page.locator('[data-cad-sketch-point="o"]'), edge = page.locator('[data-cad-sketch-entity="hole"]');
  const editor = page.getByRole('textbox', { name: 'Radius mm', exact: true }), reference = page.getByRole('menuitem', { name: 'Make reference', exact: true });
  const highlights = page.locator('[data-cad-highlight-point], [data-cad-highlight-entity]'), status = page.locator('[data-cad-dimension-status]');
  /** Where the radius line starts, on the centre point; where its arrow ends, on the circle; and a place on the line inside the circle away from both. */
  const place = (which: 'centre' | 'tip' | 'between') => page.locator('[data-cad-sketch-dimension-hit="size"]').evaluate((group, which) => {
    const line = group.querySelector('line')!, value = (name: string) => Number(line.getAttribute(name));
    const [tipX, tipY] = group.querySelector('polygon')!.getAttribute('points')!.split(' ')[0].split(',').map(Number);
    const [x, y] = which === 'centre' ? [value('x1'), value('y1')] : which === 'tip' ? [tipX, tipY] : [(value('x1') + tipX) / 2, (value('y1') + tipY) / 2];
    const screen = new DOMPoint(x, y).matrixTransform(line.getScreenCTM()!); return { x: screen.x, y: screen.y };
  }, which);
  const mark = async () => { const box = await point.locator('.cad-sketch-point-mark').boundingBox(); if (!box) throw new Error('Centre point unavailable.'); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; };
  const centre = await place('centre'), tip = await place('tip'), start = await mark();
  expect(Math.hypot(centre.x - start.x, centre.y - start.y)).toBeLessThan(1);
  const clear = async () => {
    await page.mouse.move(2, 2); await page.getByRole('application', { name: 'Sketch drawing canvas', exact: true }).press('Escape');
    await expect(point).toHaveAttribute('aria-pressed', 'false'); await expect(edge).toHaveAttribute('aria-pressed', 'false'); await expect(label).toHaveAttribute('aria-pressed', 'false');
  };
  const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
    await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
    await page.mouse.move(to.x, to.y, { steps: 4 });
  };

  for (const [row, at, menu] of [[point, centre, 'Select point'], [edge, tip, 'Select edge']] as const) {
    // Hover lights the geometry, not the dimension.
    await page.mouse.move(at.x, at.y);
    await expect.poll(() => row.evaluate(element => element.matches(':hover'))).toBe(true);
    await expect(pointed).toHaveCount(0); await expect(highlights).toHaveCount(0);
    // A click and a double-click select the geometry; the dimension stays unselected and its editor closed.
    await page.mouse.click(at.x, at.y); await expect(row).toHaveAttribute('aria-pressed', 'true'); await expect(label).toHaveAttribute('aria-pressed', 'false');
    await page.mouse.dblclick(at.x, at.y); await expect(row).toHaveAttribute('aria-pressed', 'true');
    await expect(editor).toHaveCount(0); await expect(label).toHaveAttribute('aria-pressed', 'false'); await expect(status).toHaveCount(0);
    await clear();
    // A right-click offers the geometry's commands, not the dimension's.
    await page.mouse.click(at.x, at.y, { button: 'right' });
    await expect(page.getByRole('menuitem', { name: menu, exact: true })).toBeVisible(); await expect(reference).toHaveCount(0);
    await page.keyboard.press('Escape'); await expect(page.getByRole('menuitem', { name: menu, exact: true })).toHaveCount(0);
    await clear();
    // A drag moves the circle.
    await drag(at, { x: at.x + 30, y: at.y + 20 }); await page.mouse.up();
    await expect.poll(async () => { const now = await mark(); return Math.hypot(now.x - start.x - 30, now.y - start.y - 20); }).toBeLessThan(3);
    await expect(label).toHaveAttribute('aria-pressed', 'false');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(async () => { const now = await mark(); return Math.hypot(now.x - start.x, now.y - start.y); }).toBeLessThan(1);
    await clear();
  }
  // Shift adds the edge under the arrow to the point under the line.
  await page.mouse.click(centre.x, centre.y); await page.keyboard.down('Shift'); await page.mouse.click(tip.x, tip.y); await page.keyboard.up('Shift');
  await expect(point).toHaveAttribute('aria-pressed', 'true'); await expect(edge).toHaveAttribute('aria-pressed', 'true'); await expect(label).toHaveAttribute('aria-pressed', 'false');
  await clear();

  // Geometry a filter leaves out still keeps the press from the dimension, so the press there begins a box, as anywhere off the selectable geometry.
  // The filter keeps points, edges or both; each row toggles one kind.
  const filter = async (value: 'points' | 'edges' | 'auto') => {
    const view = page.getByRole('button', { name: 'View controls', exact: true });
    for (const [row, wanted] of [['Points', value !== 'edges'], ['Edges', value !== 'points']] as const) {
      await view.click(); await page.getByRole('button', { name: 'Filter', exact: true }).click();
      const item = page.getByRole('menuitemcheckbox', { name: row, exact: true });
      if ((await item.getAttribute('aria-checked') === 'true') !== wanted) await item.click(); else await page.keyboard.press('Escape');
      if (await page.getByRole('group', { name: 'Sketch controls' }).isVisible()) await view.click();
    }
  };
  await filter('points');
  await drag(tip, { x: centre.x - 30, y: centre.y + 30 }); await expect(page.locator('.cad-sketch-selection-box')).toHaveCount(1);
  await page.mouse.up(); await expect(point).toHaveAttribute('aria-pressed', 'true'); await expect(label).toHaveAttribute('aria-pressed', 'false');
  await clear(); await filter('edges');
  // Drawn leftwards, the box takes the circle it crosses.
  const radius = Math.hypot(tip.x - centre.x, tip.y - centre.y);
  await drag(centre, { x: centre.x - radius * 1.5, y: centre.y + radius / 2 }); await expect(page.locator('.cad-sketch-selection-box')).toHaveCount(1);
  await page.mouse.up(); await expect(edge).toHaveAttribute('aria-pressed', 'true'); await expect(label).toHaveAttribute('aria-pressed', 'false');
  await clear(); await filter('auto');

  // Away from the geometry, the line still selects, edits and opens the menu of its dimension.
  const between = await place('between');
  await page.mouse.click(between.x, between.y); await expect(label).toHaveAttribute('aria-pressed', 'true');
  await expect(status).toHaveText('Radius selected · Double-click or Enter edits · Delete removes');
  await expect(point).toHaveAttribute('aria-pressed', 'false'); await expect(edge).toHaveAttribute('aria-pressed', 'false');
  await clear();
  await page.mouse.click(between.x, between.y, { button: 'right' }); await expect(reference).toBeVisible(); await expect(label).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape'); await expect(reference).toHaveCount(0);
  await page.mouse.dblclick(between.x, between.y); await expect(editor).toHaveValue('10');
});

test('leaves a construction edge its picks in the gaps of its dashes, where a dimension line or arrow lies beneath', async ({ page }) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  const sketch = { id: 'plate', kind: 'sketch', name: 'Plate', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
    points: [{ id: 'o', position: [30, 20] }], entities: [{ id: 'hole', kind: 'circle', centerPointId: 'o', radius: 10, construction: true }],
    relations: [{ id: 'size', kind: 'radial-size', entityId: 'hole', quantity: 'radius', value: 10 }] } };
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [{ kind: 'add-feature', feature: sketch }] });
  await (await historyRow(page, 'Plate')).dblclick();
  await expect(page.getByRole('button', { name: 'Finish sketch', exact: true })).toBeVisible();
  const label = page.locator('[data-cad-sketch-dimension="size"] [role="button"]'), edge = page.locator('[data-cad-sketch-entity="hole"]');
  // Every place on the dashed circle answers with the circle, gaps included; only the value label, which keeps its pick, may cover it.
  const owners = await page.locator('[data-cad-sketch-point="o"] .cad-sketch-point-mark').evaluate(mark => {
    const centre = mark.getBoundingClientRect(), x = centre.x + centre.width / 2, y = centre.y + centre.height / 2;
    const hit = document.querySelector('[data-cad-sketch-dimension-hit="size"]') as SVGGElement, line = hit.querySelector('line')!;
    const [tipX, tipY] = hit.querySelector('polygon')!.getAttribute('points')!.split(' ')[0].split(',').map(Number);
    const tip = new DOMPoint(tipX, tipY).matrixTransform(line.getScreenCTM()!), radius = Math.hypot(tip.x - x, tip.y - y);
    const counts = { edge: 0, label: 0, other: [] as string[] };
    for (let step = 0; step < 180; step += 1) {
      const angle = step * Math.PI / 90, element = document.elementFromPoint(x + radius * Math.cos(angle), y + radius * Math.sin(angle));
      if (element?.closest('[data-cad-sketch-entity="hole"]')) counts.edge += 1;
      else if (element?.closest('[data-cad-sketch-dimension="size"]')) counts.label += 1;
      else counts.other.push(element ? element.getAttribute('class') ?? element.tagName : 'none');
    }
    return { ...counts, tip: { x: tip.x, y: tip.y } };
  });
  expect(owners.other).toEqual([]); expect(owners.edge).toBeGreaterThan(150);
  // At the arrow tip, the circle takes the click and the dimension stays unselected.
  await page.mouse.click(owners.tip.x, owners.tip.y);
  await expect(edge).toHaveAttribute('aria-pressed', 'true'); await expect(label).toHaveAttribute('aria-pressed', 'false');
});

/** Opens a 40 mm line with its length dimension for editing. */
async function openStrip(page: Page) {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  const sketch = { id: 'strip', kind: 'sketch', name: 'Strip', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
    points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [40, 0] }],
    entities: [{ id: 'base', kind: 'line', startPointId: 'a', endPointId: 'b', construction: false }],
    relations: [{ id: 'length', kind: 'distance', pointIds: ['a', 'b'], value: 40 }] } };
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [{ kind: 'add-feature', feature: sketch }] });
  await (await historyRow(page, 'Strip')).dblclick();
  await expect(page.getByRole('button', { name: 'Finish sketch', exact: true })).toBeVisible();
  return sketch;
}

test('opens the value editor with its value focused from a double-click or Enter, so typing edits it, and keeps it between the bar and the dock as the window shrinks', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const sketch = await openStrip(page);
  const label = page.locator('[data-cad-sketch-dimension="length"] [role="button"]'), value = page.getByRole('textbox', { name: 'Length mm', exact: true });
  /** Types over the selected value without clicking it first, and applies it with Enter. */
  const typeValue = async (text: string) => { await expect(value).toBeFocused(); await page.keyboard.type(text); await page.keyboard.press('Enter'); await expect(value).toHaveCount(0); };
  // A double-click opens the editor with the value focused and selected.
  await label.dblclick(); await expect(value).toHaveValue('40'); await typeValue('45');
  // Enter on the dimension opens it the same way.
  await label.focus(); await page.keyboard.press('Enter'); await expect(value).toHaveValue('45'); await typeValue('50');

  // Opened at 1440 by 900 px, the editor moves as the window shrinks to 440 px high: where it shares the columns of the bar or the dock it
  // stays between them, it stays in the window, and its value keeps focus.
  await label.dblclick(); await expect(value).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 440 });
  const editor = page.locator('form[data-cad-sketch-value-editor="length"]'), dock = page.locator('[data-cad-command-dock]'), bar = page.locator('[data-cad-sketch-header]');
  const box = async (locator: Locator) => { const found = await locator.boundingBox(); if (!found) throw new Error('Box unavailable.'); return found; };
  const across = (one: { x: number; width: number }, other: { x: number; width: number }) => one.x < other.x + other.width && other.x < one.x + one.width;
  await expect.poll(async () => {
    const [form, under, over] = [await box(editor), await box(dock), await box(bar)];
    return { belowBar: !across(form, over) || form.y >= over.y + over.height, aboveDock: !across(form, under) || form.y + form.height <= under.y, inWindow: form.y + form.height <= 440 };
  }).toEqual({ belowBar: true, aboveDock: true, inWindow: true });
  await typeValue('55');
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false });
  const finished = (await call(page, 'cad_get_feature', { expectedVersion: (await context(page)).version, featureId: 'strip' })).feature;
  expect(finished.graph.relations).toEqual([{ ...sketch.graph.relations[0], value: 55 }]);
});

test('keeps the value focused through the reset Escape makes, and returns focus to the dimension as the editor closes, so the canvas keys work', async ({ page }) => {
  await openStrip(page);
  const label = page.locator('[data-cad-sketch-dimension="length"] [role="button"]'), value = page.getByRole('textbox', { name: 'Length mm', exact: true });
  const editor = page.locator('form[data-cad-sketch-value-editor="length"]'), canvas = page.getByRole('application', { name: 'Sketch drawing canvas', exact: true });
  // Escape resets an edited value: the value keeps focus, selected, so typing replaces it rather than reaching the tool shortcuts.
  await label.dblclick(); await expect(value).toBeFocused();
  await page.keyboard.type('47'); await page.keyboard.press('Escape');
  await expect(value).toHaveValue('40'); await expect(value).toBeFocused();
  await page.keyboard.type('48'); await expect(value).toHaveValue('48'); await expect(editor).toHaveCount(1);
  // Cancel returns focus to the dimension's label, where Enter opens it again.
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(editor).toHaveCount(0); await expect(label).toBeFocused();
  await page.keyboard.press('Enter'); await expect(value).toBeFocused(); await expect(value).toHaveValue('40');
  // A clean Escape the same.
  await page.keyboard.press('Escape'); await expect(editor).toHaveCount(0); await expect(label).toBeFocused();
  await page.keyboard.press('Enter'); await expect(value).toBeFocused();
  // Apply the same: the dimension stays selected, so Delete on its label removes it, and focus then goes to the canvas.
  await page.keyboard.type('48'); await editor.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(editor).toHaveCount(0); await expect(label).toBeFocused(); await expect(label).toContainText('48');
  await page.keyboard.press('Delete'); await expect(label).toHaveCount(0); await expect(canvas).toBeFocused();
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false });
  expect((await call(page, 'cad_get_feature', { expectedVersion: (await context(page)).version, featureId: 'strip' })).feature.graph.relations).toEqual([]);
});
