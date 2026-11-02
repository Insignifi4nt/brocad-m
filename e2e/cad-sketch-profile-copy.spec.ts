import { expect, test } from './fixtures/native-sketch-solver';
import type { CadSketchFeature } from '../src/domain/cad/cadDocument';
import { prepareCadTools, callCadTool as call, cadContext as context, historyRow, importCadDraft } from './cad-tool-helpers';

test('copies a generated outline into an independent editable sketch, rounds one corner and reopens its solid', async ({ page }) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  const source: CadSketchFeature = { id: 'generator', name: 'Generated plate', kind: 'sketch', suppressed: false, plane: 'XY', offset: ' lift ', profiles: [
    { id: 'plate-profile', name: 'Plate outline', construction: false, geometry: { kind: 'plugin', inputs: { width: ' profileWidth ' }, package: {
      format: 'wireedm-cad-plugin', apiVersion: 1, id: 'workshop.plate-profile', version: '1.0.0', name: 'Plate outline', description: 'Rectangular plate outline.', notes: '',
      inputs: [{ name: 'width', label: 'Width', unit: 'mm', default: 40, minimum: 1, maximum: 1000, integer: false }],
      generator: { kind: 'polygon-recipe', repeat: 1, points: [[0, 0], ['width', 0], ['width', 20], [0, 20]] }
    } } }
  ] };
  // The canvas profile menu copies a saved legacy profile, which only a saved draft can hold now.
  await importCadDraft(page, [source], { parameters: { profileWidth: 40, lift: 2 } });
  await page.getByRole('button', { name: 'Expand Generated plate', exact: true }).click();
  let current = await context(page); const base = current;
  const read = (id: string) => call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: id }).then(reply => reply.feature);
  const openCopy = async () => {
    await page.getByRole('button', { name: 'Plate outline profile', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Copy outline to editable sketch', exact: true }).click();
    await expect(page.getByRole('form', { name: 'Copy outline', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
  };
  await openCopy(); expect(await read(source.id)).toEqual(source);
  await expect(page.locator('[data-cad-sketch-entity][aria-disabled="true"]')).toHaveCount(4);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await context(page)).toMatchObject({ version: base.version, featureCount: 1, workflowOpen: false });
  await openCopy(); await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('form', { name: 'Copy outline', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Finish sketch', exact: true })).toBeEnabled();
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false, featureCount: 2 }); current = await context(page);
  const copy = (await call(page, 'cad_read_features', { expectedVersion: current.version })).items[1];
  expect(await read(source.id)).toEqual(source); expect(copy).toMatchObject({ kind: 'sketch', plane: 'XY', offset: 2, profiles: [] });
  expect(copy.graph.points.map((point: { position: number[] }) => point.position)).toEqual([[0, 0], [40, 0], [40, 20], [0, 20]]);
  expect(copy.graph.relations).toEqual([]);
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  await call(page, 'cad_history', { expectedVersion: current.version, direction: 'undo' }); current = await context(page);
  expect(current.featureCount).toBe(1); expect(await read(source.id)).toEqual(source);
  const request = { sourceSketchId: source.id, profileId: 'plate-profile', newSketchId: copy.id, name: copy.name, idPrefix: copy.graph.entities[0].id.slice(0, -3) };
  await call(page, 'cad_edit_document', { expectedVersion: current.version, edits: [{ kind: 'copy-sketch-profile', ...request }] }); current = await context(page);
  expect(await read(copy.id)).toEqual(copy); expect(await read(source.id)).toEqual(source);
  await (await historyRow(page, copy.name)).dblclick();
  await page.getByRole('button', { name: 'Point 1 in ' + copy.name, exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Sketch corner tools', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Fillet', exact: true }).click();
  await page.getByRole('textbox', { name: 'Fillet radius mm', exact: true }).fill('2');
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false }); current = await context(page);
  const rounded = await read(copy.id); expect(rounded.graph.relations).toEqual([expect.objectContaining({ kind: 'fillet-corner', value: 2 })]);
  expect((await call(page, 'cad_measure_sketch', { expectedVersion: current.version, sketchId: copy.id })).materialAreaMm2).toBeCloseTo(796 + Math.PI, 9);
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  const pad = { id: 'pad', name: 'Copied plate', kind: 'extrude', sketchId: copy.id, suppressed: false, distance: 5, symmetric: false, operation: 'new', targetId: null };
  await call(page, 'cad_edit_document', { expectedVersion: current.version, edits: [{ kind: 'add-feature', feature: pad }] }); current = await context(page);
  const built = await call(page, 'cad_build', { expectedVersion: current.version });
  expect(built.diagnostics).toEqual([]); expect(built.bodies).toHaveLength(1); expect(built.bodies[0]).toMatchObject({ solidCount: 1, boundsMm: { min: [0, 0, 2].map(value => expect.closeTo(value, 12)), max: [40, 20, 7].map(value => expect.closeTo(value, 12)) } });
  expect(built.bodies[0].volumeMm3).toBeCloseTo(3980 + 5 * Math.PI, 7);
  await call(page, 'cad_edit_document', { expectedVersion: current.version, edits: [{ kind: 'set-parameter', name: 'profileWidth', value: 60 }, { kind: 'set-parameter', name: 'lift', value: 6 }] }); current = await context(page);
  expect(await read(source.id)).toEqual(source); expect(await read(copy.id)).toEqual(rounded); expect(await read(pad.id)).toEqual(pad);
  expect((await call(page, 'cad_build', { expectedVersion: current.version })).bodies[0].volumeMm3).toBeCloseTo(3980 + 5 * Math.PI, 7);
  const section = await call(page, 'cad_inspect_section', { expectedVersion: current.version, section: { bodyId: pad.id, plane: 'XY', offset: 4.5 } });
  expect(section.contourCount).toBe(1); expect(section.entities.nextOffset).toBeNull();
  expect(section.entities.items.filter((entity: { type: string }) => entity.type === 'line')).toHaveLength(4);
  expect(section.entities.items.filter((entity: { type: string }) => entity.type === 'arc')).toEqual([expect.objectContaining({ radius: expect.closeTo(2, 12), sweepRadians: expect.closeTo(-Math.PI / 2, 10) })]);
  await call(page, 'cad_history', { expectedVersion: current.version, direction: 'undo' }); current = await context(page);
  expect(current.parameters).toEqual({ profileWidth: 40, lift: 2 }); expect(await read(copy.id)).toEqual(rounded);
  await call(page, 'cad_history', { expectedVersion: current.version, direction: 'redo' }); current = await context(page);
  await call(page, 'cad_save_document', { expectedVersion: current.version }); await page.reload();
  await expect(page.getByRole('main', { name: 'Parametric CAD workbench' })).toBeVisible(); current = await context(page);
  expect(current.dirty).toBe(false); expect(current.parameters).toEqual({ profileWidth: 60, lift: 6 });
  expect(await read(source.id)).toEqual(source); expect(await read(copy.id)).toEqual(rounded); expect(await read(pad.id)).toEqual(pad);
});
