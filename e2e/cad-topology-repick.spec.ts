import { expect, test } from './fixtures/native-sketch-solver';
import type { CadFeature } from '../src/domain/cad/cadDocument';
import type { CadTopologyDescriptor } from '../src/domain/cad/cadTopology';
import { prepareCadTools, callCadTool as call, rawCadToolCall as rawCall, cadContext as context, generatedSketch, openFeatureEditor } from './cad-tool-helpers';

for (const kind of ['fillet', 'chamfer', 'shell'] as const) test(`replaces an existing ${kind} input with Cancel, exact agent parity, history and save`, async ({ page }, testInfo) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [
    { kind: 'add-feature', feature: generatedSketch({ id: 'outline', name: 'Footprint', kind: 'sketch', suppressed: false, plane: 'XY', offset: '0',
      profiles: [{ id: 'plate', name: 'Plate', construction: false, geometry: { kind: 'rectangle', x: '0', y: '0', width: 20, height: 10, cornerRadius: 0 } }] }) },
    { kind: 'add-feature', feature: { id: 'pad', name: 'Stock', kind: 'extrude', suppressed: false, sketchId: 'outline', distance: '5', symmetric: false, operation: 'new', targetId: null } },
  ] });
  const base = await context(page), built = await call(page, 'cad_build', { expectedVersion: base.version });
  const topology = kind === 'shell' ? 'face' : 'edge';
  const originalRows = (await call(page, 'cad_inspect_topology', { expectedVersion: base.version, expectedBuildId: built.buildId, bodyId: 'pad', kind: topology, limit: 50 })).descriptors as CadTopologyDescriptor[];
  const first = kind === 'shell' ? originalRows.find(row => row.kind === 'face' && row.surfaceType === 'plane' && row.normal[2] > .99)
    : originalRows.find(row => row.kind === 'edge' && row.curveType === 'line' && Math.abs(row.length - 20) < 1e-8);
  if (!first) throw new Error('Missing exact initial seed');
  const original = await call(page, 'cad_resolve_topology', { expectedVersion: base.version, expectedBuildId: built.buildId, bodyId: 'pad', purpose: kind, picks: [{ kind: topology, key: first.key }] });
  const feature: CadFeature = kind === 'shell' ? { id: 'treatment', name: 'Housing', kind, suppressed: false, targetId: 'pad', thickness: 1, opening: original.opening }
    : { id: 'treatment', name: 'Edge treatment', kind, suppressed: false, targetId: 'pad', radius: 1, selection: original.selection };
  await call(page, 'cad_edit_document', { expectedVersion: base.version, edits: [{ kind: 'add-feature', feature }] });
  const accepted = await context(page), acceptedBuild = await call(page, 'cad_build', { expectedVersion: accepted.version });
  const outline = await call(page, 'cad_get_feature', { expectedVersion: accepted.version, featureId: 'outline' });
  const input = await call(page, 'cad_build_feature_input', { expectedVersion: accepted.version, featureId: 'treatment', bodyId: 'pad' });
  expect(input).toMatchObject({ featureId: 'treatment', bodyId: 'pad', body: { volumeMm3: expect.closeTo(1000, 7) } });
  const rows = (await call(page, 'cad_inspect_topology', { expectedVersion: accepted.version, inputToken: input.inputToken, expectedBuildId: input.buildId, bodyId: 'pad', kind: topology, limit: 50 })).descriptors as CadTopologyDescriptor[];
  const alternative = kind === 'shell' ? rows.find(row => row.kind === 'face' && row.surfaceType === 'plane' && row.normal[2] < -.99)
    : rows.filter(row => row.kind === 'edge' && row.curveType === 'line' && Math.abs(row.length - 20) < 1e-8)[1];
  if (!alternative) throw new Error('Missing exact replacement seed');
  const ordinal = rows.indexOf(alternative);
  expect(ordinal).toBeLessThan(8);
  const replacement = await call(page, 'cad_resolve_topology', { expectedVersion: accepted.version, inputToken: input.inputToken, expectedBuildId: input.buildId, bodyId: 'pad', purpose: kind, picks: [{ kind: topology, key: alternative.key }] });
  const expected = kind === 'shell' ? { ...feature, opening: replacement.opening } : { ...feature, selection: replacement.selection };
  expect(expected).not.toEqual(feature);
  expect(await call(page, 'cad_build', { expectedVersion: accepted.version })).toMatchObject({ buildId: acceptedBuild.buildId });
  await openFeatureEditor(page, 'treatment');
  const choose = page.getByRole('button', { name: kind === 'shell' ? 'Choose opening' : 'Choose edges', exact: true });
  await choose.click();
  const browse = page.getByRole('button', { name: `Browse ${topology}s`, exact: true });
  await expect(browse).toBeEnabled();
  expect(await call(page, 'cad_get_feature', { expectedVersion: accepted.version, featureId: 'treatment' })).toMatchObject({ feature });
  await page.getByRole('button', { name: 'Cancel topology selection', exact: true }).click(); await expect(choose).toBeFocused();
  expect(await context(page)).toMatchObject({ version: accepted.version, workflowOpen: false });
  expect(await rawCall(page, 'cad_inspect_topology', { expectedVersion: accepted.version, inputToken: input.inputToken, expectedBuildId: input.buildId, bodyId: 'pad', kind: topology })).toMatchObject({ ok: false, error: { code: 'STALE_FEATURE_INPUT' } });
  await choose.click(); await expect(browse).toBeEnabled(); await browse.click();
  await expect(page.locator('.cad-topology-list button')).toHaveCount(Math.min(8, rows.length));
  await page.locator('.cad-topology-list button').nth(ordinal).click();
  await page.getByRole('button', { name: 'Use topology selection', exact: true }).click();
  const apply = page.getByRole('button', { name: 'Apply', exact: true }); await expect(apply).toBeEnabled();
  expect(await call(page, 'cad_get_feature', { expectedVersion: accepted.version, featureId: 'treatment' })).toMatchObject({ feature });
  await apply.click(); await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false });
  let current = await context(page);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: 'treatment' })).feature).toEqual(expected);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: 'outline' })).feature).toEqual(outline.feature);
  const volume = kind === 'shell' ? 424 : kind === 'chamfer' ? 990 : 1000 - 20 * (1 - Math.PI / 4);
  expect(await call(page, 'cad_build', { expectedVersion: current.version })).toMatchObject({ diagnostics: [], bodies: [{ featureId: 'treatment', solidCount: 1, volumeMm3: expect.closeTo(volume, 6) }] });
  await call(page, 'cad_history', { expectedVersion: current.version, direction: 'undo' }); current = await context(page);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: 'treatment' })).feature).toEqual(feature);
  await call(page, 'cad_history', { expectedVersion: current.version, direction: 'redo' }); current = await context(page);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: 'treatment' })).feature).toEqual(expected);
  await call(page, 'cad_history', { expectedVersion: current.version, direction: 'undo' }); current = await context(page);
  await call(page, 'cad_edit_document', { expectedVersion: current.version, edits: [{ kind: 'update-feature', feature: expected }] }); current = await context(page);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: 'treatment' })).feature).toEqual(expected);
  expect(await call(page, 'cad_build', { expectedVersion: current.version })).toMatchObject({ diagnostics: [], bodies: [{ volumeMm3: expect.closeTo(volume, 6) }] });
  await page.screenshot({ path: `tmp/cad-topology-repick-${kind}-${testInfo.project.name}.png` });
  await call(page, 'cad_save_document', { expectedVersion: current.version }); await page.reload();
  await expect(page.getByRole('main', { name: 'Parametric CAD workbench' })).toBeVisible(); current = await context(page);
  expect(current).toMatchObject({ dirty: false });
  // The portable JSON representation canonicalizes native numeric -0 to 0.
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: 'treatment' })).feature).toEqual(JSON.parse(JSON.stringify(expected)));
  expect(await call(page, 'cad_build', { expectedVersion: current.version })).toMatchObject({ diagnostics: [], bodies: [{ volumeMm3: expect.closeTo(volume, 6) }] });
});
