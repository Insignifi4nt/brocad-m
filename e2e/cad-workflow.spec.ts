import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/native-sketch-solver';
import { readFile } from 'node:fs/promises';
import type { CadTopologyDescriptor } from '../src/domain/cad/cadTopology';
import type { CadFeature, CadSketchFeature } from '../src/domain/cad/cadDocument';
import { prepareCadTools as prepare, rawCadToolCall as rawCall, callCadTool as call, cadContext as context, captureCadPreview, generatedSketch, importCadDraft, openFeatureEditor } from './cad-tool-helpers';

async function expectSavedCadReopened(page: Page, documentId: string) {
  await expect(page).toHaveURL(url => url.pathname.endsWith(`/cad/${encodeURIComponent(documentId)}`));
  await expect(page.getByRole('main', { name: 'Parametric CAD workbench' })).toBeVisible();
  expect(await context(page)).toMatchObject({ documentId, dirty: false, savedVersion: expect.any(String) });
}

async function openViewControls(page: Page) {
  const toggle = page.getByRole('button', { name: 'View controls', exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
}

async function editScalarRelation(page: Page, label: string, expression: string) {
  await page.getByRole('button', { name: `Edit ${label} relation`, exact: true }).click();
  const popup = page.getByRole('dialog', { name: `${label} relation help`, exact: true });
  await popup.getByRole('textbox', { name: `${label} expression`, exact: true }).fill(expression);
  await popup.getByRole('button', { name: 'Keep relation', exact: true }).click();
  await popup.getByRole('button', { name: `Close ${label} relation help`, exact: true }).click();
}

async function createSketchOnCanvasPlane(page: Page, plane: 'XY' | 'XZ' | 'YZ' = 'XY') {
  await page.getByRole('button', { name: 'Sketch', exact: true }).click();
  await page.locator('.cad-viewport').getByRole('button', { name: `Select ${plane} plane in design area`, exact: true }).click();
  await expect(page.getByLabel('Sketch drawing canvas')).toBeVisible();
}

async function expectRenderedSolidCapture(page: Page, capture: object) {
  if (!('previewUrl' in capture) || typeof capture.previewUrl !== 'string') throw new Error('Missing captured preview URL');
  const pixels = await page.evaluate(async (url) => {
    const image = new Image(); image.src = url; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Unable to inspect capture pixels');
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let opaque = 0, body = 0;
    for (let y = Math.floor(canvas.height * .2); y < canvas.height * .8; y += 3) {
      for (let x = Math.floor(canvas.width * .2); x < canvas.width * .8; x += 3) {
        const offset = 4 * (y * canvas.width + x);
        if (data[offset + 3] > 0) {
          opaque++;
          if (data[offset] + data[offset + 1] + data[offset + 2] > 300) body++;
        }
      }
    }
    return { opaque, body };
  }, capture.previewUrl);
  expect(pixels.opaque, 'Solid PNG must contain rendered pixels, not a lost-context transparent image').toBeGreaterThan(1000);
  expect(pixels.body, 'Solid PNG must contain the fitted body, not just its dark background and grid').toBeGreaterThan(100);
}
const edits = [
  { kind: 'set-parameter', name: 'width', value: 60 },
  { kind: 'add-feature', feature: generatedSketch({ id: 'outline', name: 'Manufacturing outline', kind: 'sketch', suppressed: false, plane: 'XY', offset: 0,
    profiles: [
      { id: 'plate', name: 'Plate', construction: false, geometry: { kind: 'rectangle', x: 0, y: 0, width: 'width', height: 40, cornerRadius: 3 } },
      { id: 'bore', name: 'Bore', construction: false, geometry: { kind: 'circle', x: 'width / 2', y: 20, radius: 5 } }
    ] }) },
  { kind: 'add-feature', feature: { id: 'pad', name: 'Pad', kind: 'extrude', suppressed: false, sketchId: 'outline', distance: 10, symmetric: false, operation: 'new', targetId: null } }
];

async function createBox(page: Page) {
  await prepare(page);
  const initial = await context(page);
  await call(page, 'cad_create_document', { expectedVersion: initial.version, name: 'Parametric housing' });
  const created = await context(page);
  await call(page, 'cad_edit_document', { expectedVersion: created.version, edits: [
    { kind: 'set-parameter', name: 'width', value: 20 }, { kind: 'set-parameter', name: 'height', value: 5 },
    { kind: 'add-feature', feature: generatedSketch({ id: 'outline', name: 'Footprint', kind: 'sketch', suppressed: false, plane: 'XY', offset: 0,
      profiles: [{ id: 'base', name: 'Base', construction: false, geometry: { kind: 'rectangle', x: 0, y: 0, width: 'width', height: 10, cornerRadius: 0 } }] }) },
    { kind: 'add-feature', feature: { id: 'pad', name: 'Pad', kind: 'extrude', suppressed: false, sketchId: 'outline', distance: 'height', symmetric: false, operation: 'new', targetId: null } }
  ] });
  const draft = await context(page);
  const build = await call(page, 'cad_build', { expectedVersion: draft.version });
  expect(build).toMatchObject({ bodies: [{ volumeMm3: expect.closeTo(1000, 7) }] });
  return { draft, buildId: build.buildId };
}

test('human Through-all Pocket follows target changes and exports an exact agent CAM section', async ({ page }) => {
  const { draft } = await createBox(page);
  expect(await call(page, 'cad_describe_features', { kind: 'pocket' })).toMatchObject({ kind: 'pocket', description: expect.stringContaining('through-all') });
  await call(page, 'cad_edit_document', { expectedVersion: draft.version, edits: [{ kind: 'add-feature', feature: generatedSketch({
    id: 'bore', name: 'Bore profile', kind: 'sketch', suppressed: false, plane: 'XY', offset: 'height / 2',
    profiles: [{ id: 'circle', name: 'Bore', construction: false, geometry: { kind: 'circle', x: 10, y: 5, radius: 2 } }],
  }) }] });
  const before = await context(page);
  await call(page, 'cad_build', { expectedVersion: before.version });
  await call(page, 'cad_set_viewport', { expectedVersion: before.version, command: { kind: 'select-feature', featureId: 'bore' } });
  await page.getByRole('button', { name: 'Pad / Pocket', exact: true }).click();
  const properties = page.getByRole('complementary', { name: 'Feature properties' });
  await properties.getByRole('combobox', { name: 'Operation', exact: true }).selectOption('cut');
  await properties.getByRole('combobox', { name: 'Extent', exact: true }).selectOption('through-all');
  await properties.getByRole('combobox', { name: 'Direction', exact: true }).selectOption('both');
  await expect(properties.getByRole('combobox', { name: 'Target body', exact: true })).toHaveValue('pad');
  await expect(properties.getByRole('textbox', { name: 'Length mm', exact: true })).toHaveCount(0);
  expect(await context(page)).toMatchObject({ version: before.version, workflowOpen: true });
  expect(await rawCall(page, 'cad_edit_document', { expectedVersion: before.version, edits: [{ kind: 'set-parameter', name: 'height', value: 9 }] }))
    .toMatchObject({ ok: false, error: { code: 'WORKFLOW_OPEN' } });
  await properties.getByRole('button', { name: 'Apply', exact: true }).click();
  const accepted = await context(page);
  const features = await call(page, 'cad_read_features', { expectedVersion: accepted.version });
  if (!Array.isArray(features.items)) throw new Error('Missing Pocket history');
  const pocket = features.items.at(-1) as CadFeature;
  expect(pocket).toMatchObject({ kind: 'pocket', sketchId: 'bore', targetId: 'pad', extent: { kind: 'through-all', direction: 'both' } });
  expect(pocket).not.toHaveProperty('distance'); expect(pocket).not.toHaveProperty('operation');
  expect(await call(page, 'cad_build', { expectedVersion: accepted.version })).toMatchObject({ diagnostics: [], bodies: [{ featureId: pocket.id, volumeMm3: expect.closeTo((200 - 4 * Math.PI) * 5, 6) }] });
  await openFeatureEditor(page, pocket.id);
  await properties.getByRole('combobox', { name: 'Extent', exact: true }).selectOption('distance');
  await editScalarRelation(page, 'Length', 'height / 3');
  await properties.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await context(page)).toMatchObject({ version: accepted.version, workflowOpen: false });
  expect(await call(page, 'cad_get_feature', { expectedVersion: accepted.version, featureId: pocket.id })).toMatchObject({ feature: pocket });
  await call(page, 'cad_edit_document', { expectedVersion: accepted.version, edits: [{ kind: 'set-parameter', name: 'height', value: 9 }] });
  const resized = await context(page);
  expect(await call(page, 'cad_build', { expectedVersion: resized.version })).toMatchObject({ diagnostics: [], bodies: [{ featureId: pocket.id, volumeMm3: expect.closeTo((200 - 4 * Math.PI) * 9, 6) }] });
  await call(page, 'cad_set_viewport', { expectedVersion: resized.version, command: { kind: 'select-feature', featureId: null } });
  await call(page, 'cad_set_viewport', { expectedVersion: resized.version, command: { kind: 'fit' } });
  await expectRenderedSolidCapture(page, await call(page, 'cad_capture_preview', { expectedVersion: resized.version }));
  await page.screenshot({ path: 'tmp/cad-through-all-pocket.png' });
  const downloadPromise = page.waitForEvent('download');
  await call(page, 'cad_export_solid', { expectedVersion: resized.version, format: 'step' });
  const path = await (await downloadPromise).path(); if (!path) throw new Error('Missing Pocket STEP');
  expect(await readFile(path, 'utf8')).toContain('ISO-10303-21;');
  const section = { bodyId: pocket.id, plane: 'XY', offset: 8 };
  expect(await call(page, 'cad_inspect_section', { expectedVersion: resized.version, section }))
    .toMatchObject({ contourCount: 2, offset: 8 });
  expect(await call(page, 'cad_send_section_to_cam', { expectedVersion: resized.version, section }))
    .toMatchObject({ opened: true, section: { contourCount: 2, offset: 8 } });
});

test('compact polygon properties retain multiple vertex edits and commit one shared history step', async ({ page }) => {
  await prepare(page);
  // The polygon vertex fields edit a saved legacy profile, which only a saved draft can hold now.
  const draft = await importCadDraft(page, [{ id: 'outline', name: 'Outline', kind: 'sketch', suppressed: false, plane: 'XY', offset: 0,
    profiles: [{ id: 'boundary', name: 'Boundary', construction: false, geometry: { kind: 'polygon', points: [[0, 0], [20, 0], [20, 10], [0, 10]] } }] }],
  { name: 'Editable polygon', parameters: { width: 20 } });
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: draft.version }))
    .toMatchObject({ ok: true, data: { documentVersion: draft.version } });
  await call(page, 'cad_set_viewport', { expectedVersion: draft.version, command: { kind: 'edit-sketch', sketchId: 'outline' } });
  await call(page, 'cad_set_viewport', { expectedVersion: draft.version, command: { kind: 'select-profile', profileId: 'boundary' } });
  const properties = page.getByRole('complementary', { name: 'Feature properties' });
  await properties.getByText('Exact geometry', { exact: true }).click();
  await expect(properties.getByLabel('Polygon vertex', { exact: true })).toHaveValue('1');
  await expect(properties.getByRole('textbox', { name: 'X mm', exact: true })).toBeVisible();
  await expect(properties.getByRole('textbox', { name: 'Y mm', exact: true })).toBeVisible();
  await page.getByLabel('Polygon vertex', { exact: true }).fill('2');
  await properties.getByRole('textbox', { name: 'X mm', exact: true }).fill('width + 5');
  await page.getByRole('button', { name: 'Next polygon vertex' }).click();
  await properties.getByRole('textbox', { name: 'X mm', exact: true }).fill('width + 5');
  await page.getByRole('button', { name: 'Previous polygon vertex' }).click();
  await expect(properties.getByRole('textbox', { name: /^X mm/ })).toHaveValue('width + 5');
  await page.getByLabel('Polygon vertex', { exact: true }).press('Enter');
  expect(await context(page)).toMatchObject({ version: draft.version, workflowOpen: true });
  expect(await rawCall(page, 'cad_edit_document', { expectedVersion: draft.version, edits: [{ kind: 'rename-document', name: 'Blocked' }] }))
    .toMatchObject({ ok: false, error: { code: 'WORKFLOW_OPEN' } });
  await properties.getByRole('button', { name: 'Apply', exact: true }).click();
  const edited = await context(page);
  expect(edited.version).not.toBe(draft.version);
  expect(edited).toMatchObject({ parameters: { width: 20 }, workflowOpen: false });
  expect(await call(page, 'cad_get_feature', { expectedVersion: edited.version, featureId: 'outline' }))
    .toMatchObject({ feature: { profiles: [{ geometry: { kind: 'polygon', points: [[0, 0], ['width + 5', 0], ['width + 5', 10], [0, 10]] } }] } });
  expect(await call(page, 'cad_measure_sketch', { expectedVersion: edited.version, sketchId: 'outline' }))
    .toMatchObject({ materialAreaMm2: 250 });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  const undone = await context(page);
  expect(await call(page, 'cad_measure_sketch', { expectedVersion: undone.version, sketchId: 'outline' }))
    .toMatchObject({ materialAreaMm2: 200 });
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  const redone = await context(page);
  expect(await call(page, 'cad_measure_sketch', { expectedVersion: redone.version, sketchId: 'outline' }))
    .toMatchObject({ materialAreaMm2: 250 });
});

test('graphics loss rejects blank captures and restores the same CAD draft automatically or by retry', async ({ page }) => {
  const { draft } = await createBox(page);
  await call(page, 'cad_set_viewport', { expectedVersion: draft.version, command: { kind: 'fit' } });
  const initialCapture = await captureCadPreview(page, draft.version);
  expect(initialCapture).toMatchObject({ documentId: draft.documentId, draftVersion: draft.version, contentSource: 'cad-draft', source: '3d',
    viewState: { documentVersion: draft.version, buildVersion: draft.version } });
  await expectRenderedSolidCapture(page, initialCapture);
  const loseGraphics = () => page.locator('.cad-webgl canvas').evaluate(canvas => {
    const surface = canvas as HTMLCanvasElement & { restoreCadTestContext?: () => void };
    const extension = surface.getContext('webgl2')?.getExtension('WEBGL_lose_context');
    if (!extension) throw new Error('The test renderer must expose context loss controls');
    surface.restoreCadTestContext = () => extension.restoreContext();
    extension.loseContext();
  });
  await loseGraphics();
  await expect(page.getByText('The 3D graphics context was interrupted.', { exact: true })).toBeVisible();
  expect(await rawCall(page, 'cad_capture_preview', { expectedVersion: draft.version }))
    .toMatchObject({ ok: false, error: { code: 'CAPTURE_UNAVAILABLE' } });
  expect(await context(page)).toMatchObject({ version: draft.version, documentId: draft.documentId, featureCount: 2 });
  await page.locator('.cad-webgl canvas').evaluate(canvas => {
    const restore = (canvas as HTMLCanvasElement & { restoreCadTestContext?: () => void }).restoreCadTestContext;
    if (!restore) throw new Error('Missing original graphics context');
    restore();
  });
  await expect(page.getByRole('button', { name: 'Retry 3D view', exact: true })).toBeHidden();
  await expectRenderedSolidCapture(page, await call(page, 'cad_capture_preview', { expectedVersion: draft.version }));
  await loseGraphics();
  await page.getByRole('button', { name: 'Retry 3D view', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry 3D view', exact: true })).toBeHidden();
  await expectRenderedSolidCapture(page, await call(page, 'cad_capture_preview', { expectedVersion: draft.version }));
  expect(await context(page)).toMatchObject({ version: draft.version, documentId: draft.documentId, featureCount: 2 });
  expect(await call(page, 'cad_build', { expectedVersion: draft.version }))
    .toMatchObject({ buildId: expect.any(String), bodies: [{ volumeMm3: expect.closeTo(1000, 7) }] });
});

test('ordered loft sections rebuild parametrically and carry an exact bored section into CAM', async ({ page }) => {
  await prepare(page);
  const initial = await context(page);
  await call(page, 'cad_create_document', { expectedVersion: initial.version, name: 'Tapered bushing' });
  const blank = await context(page);
  expect(await call(page, 'cad_describe_features', { kind: 'loft' })).toMatchObject({ schema: {
    required: expect.arrayContaining(['sketchIds', 'ruled', 'operation', 'targetId'])
  } });
  const sectionSketch = (id: string, name: string, offset: number | string, radius: number): CadSketchFeature => generatedSketch({
    id, name, kind: 'sketch', plane: 'XY', offset, suppressed: false,
    profiles: [{ id: `${id}_circle`, name: 'Circle', construction: false, geometry: { kind: 'circle', x: 0, y: 0, radius } }]
  });
  await call(page, 'cad_edit_document', { expectedVersion: blank.version, edits: [
    { kind: 'set-parameter', name: 'rise', value: 20 },
    { kind: 'add-feature', feature: sectionSketch('lower', 'Lower section', 0, 12) },
    { kind: 'add-feature', feature: sectionSketch('upper', 'Upper section', 'rise', 8) }
  ] });
  const sections = await context(page);
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: sections.version }))
    .toMatchObject({ ok: true, data: { documentVersion: sections.version, view: { available: true } } });
  await call(page, 'cad_set_viewport', { expectedVersion: sections.version, command: { kind: 'select-feature', featureId: 'lower' } });
  await page.getByRole('button', { name: 'Loft', exact: true }).click();
  await expect(page.getByLabel('Section 1', { exact: true })).toHaveValue('lower');
  await expect(page.getByLabel('Section 2', { exact: true })).toHaveValue('upper');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  const created = await context(page);
  const features = await call(page, 'cad_read_features', { expectedVersion: created.version });
  const loft = (features as { items: CadFeature[] }).items.find(feature => feature.kind === 'loft');
  expect(loft).toMatchObject({ sketchIds: ['lower', 'upper'], ruled: false, operation: 'new', targetId: null });
  if (!loft) throw new Error('Missing applied loft');
  expect(await call(page, 'cad_build', { expectedVersion: created.version })).toMatchObject({ diagnostics: [], totalBodies: 1,
    bodies: [{ volumeMm3: expect.closeTo(6080 * Math.PI / 3, 5) }] });
  await openFeatureEditor(page, loft.id);
  await page.getByRole('button', { name: 'Move section 1 down', exact: true }).click();
  const movedSection = page.getByLabel('Section 2', { exact: true });
  await expect(movedSection).toBeFocused();
  await expect(movedSection).toHaveValue('lower');
  await movedSection.press('Alt+ArrowDown');
  await expect.poll(() => movedSection.evaluate(select => select.matches(':open'))).toBe(true);
  await movedSection.press('Escape');
  await expect.poll(() => movedSection.evaluate(select => select.matches(':open'))).toBe(false);
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  await movedSection.press('Escape');
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeHidden();
  await expect(page.getByLabel('Section 1', { exact: true })).toHaveValue('lower');
  expect(await context(page)).toMatchObject({ version: created.version, workflowOpen: false });
  expect(await rawCall(page, 'cad_edit_document', { expectedVersion: created.version,
    edits: [{ kind: 'set-parameter', name: 'rise', value: 0 }] })).toMatchObject({ ok: false });
  expect(await context(page)).toMatchObject({ version: created.version, parameters: { rise: 20 } });
  await call(page, 'cad_edit_document', { expectedVersion: created.version, edits: [
    { kind: 'set-parameter', name: 'rise', value: 30 },
    { kind: 'add-feature', feature: sectionSketch('bore_sketch', 'Bore outline', 0, 3) },
    { kind: 'add-feature', feature: { id: 'bored', name: 'Bored bushing', kind: 'extrude', suppressed: false,
      sketchId: 'bore_sketch', distance: 'rise', symmetric: false, operation: 'cut', targetId: loft.id } }
  ] });
  const bored = await context(page);
  expect(await call(page, 'cad_build', { expectedVersion: bored.version })).toMatchObject({ diagnostics: [], totalBodies: 1,
    bodies: [{ featureId: 'bored', volumeMm3: expect.closeTo(2770 * Math.PI, 5) }] });
  const section = { bodyId: 'bored', plane: 'XY', offset: 'rise / 2' };
  expect(await call(page, 'cad_inspect_section', { expectedVersion: bored.version, section })).toMatchObject({ contourCount: 2,
    entities: { items: expect.arrayContaining([{ type: 'circle', layer: 'CAD_SECTION', center: { x: 0, y: 0 }, radius: expect.closeTo(10, 6) },
      { type: 'circle', layer: 'CAD_SECTION', center: { x: 0, y: 0 }, radius: expect.closeTo(3, 6) }]) } });
  await call(page, 'cad_set_viewport', { expectedVersion: bored.version, command: { kind: 'select-feature', featureId: 'bored' } });
  await openViewControls(page);
  await page.getByRole('button', { name: 'Fit model', exact: true }).click();
  await expectRenderedSolidCapture(page, await call(page, 'cad_capture_preview', { expectedVersion: bored.version }));
  await page.screenshot({ path: 'tmp/cad-loft-bushing.png' });
  expect(await call(page, 'cad_send_section_to_cam', { expectedVersion: bored.version, section })).toMatchObject({
    opened: true, section: { contourCount: 2, offset: 15 }
  });
  await expect(page.locator('[data-preview-model="upid"]')).toBeVisible();
});

test('datum Loft preflight and human section editing preserve placement through exact native rebuild and STEP', async ({ page }) => {
  const wasmRequests: string[] = [];
  page.context().on('request', request => { if (/\.wasm(?:\?|$)/.test(request.url())) wasmRequests.push(request.url()); });
  await prepare(page);
  await call(page, 'cad_create_document', { expectedVersion: (await context(page)).version, name: 'Tilted transition' });
  const placement = { kind: 'datum-plane' as const, featureId: 'mount' };
  const section = (id: string, offset: number | string, radius: number): CadSketchFeature => generatedSketch({
    kind: 'sketch', id, name: id === 'lower' ? 'Lower section' : 'Upper section', suppressed: false, plane: placement, offset,
    profiles: [{ id: `${id}_circle`, name: 'Circle', construction: false, geometry: { kind: 'circle', x: 0, y: 0, radius } }],
  });
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [
    { kind: 'set-parameter', name: 'height', value: 20 },
    { kind: 'set-parameter', name: 'tilt', value: 30 },
    { kind: 'add-feature', feature: { kind: 'datum-plane', id: 'mount', name: 'Mounting plane', suppressed: false,
      definition: { kind: 'world', basePlane: 'XY', origin: [30, -20, 12], rotation: ['tilt', 0, 15] } } },
    { kind: 'add-feature', feature: section('lower', 2, 10) },
    { kind: 'add-feature', feature: section('upper', 'height + 2', 6) },
  ] });
  const sources = await context(page);
  expect(await call(page, 'cad_inspect_loft', { expectedVersion: sources.version, sketchIds: ['lower', 'upper'] }))
    .toMatchObject({ eligible: true, persisted: false, nativeBuildRequired: true, stationOrigin: 'first-placed-section',
      sections: [{ sketchId: 'lower', offsetMm: 2, stationMm: 0 }, { sketchId: 'upper', offsetMm: 22, stationMm: expect.closeTo(20, 10) }] });
  expect(await rawCall(page, 'cad_inspect_loft', { expectedVersion: sources.version, sketchIds: ['lower', 'upper'], autoSort: true }))
    .toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: sources.version }))
    .toMatchObject({ ok: true, data: { view: { available: true, referenceVersion: sources.version } } });
  await call(page, 'cad_set_viewport', { expectedVersion: sources.version, command: { kind: 'select-feature', featureId: 'lower' } });
  expect(wasmRequests).toEqual([]);
  await page.getByRole('button', { name: 'Loft', exact: true }).click();
  await expect(page.getByLabel('Section 1', { exact: true })).toHaveValue('lower');
  await expect(page.getByLabel('Section 2', { exact: true })).toHaveValue('upper');
  expect(await rawCall(page, 'cad_inspect_loft', { expectedVersion: sources.version, sketchIds: ['lower', 'upper'] }))
    .toMatchObject({ ok: false, error: { code: 'WORKFLOW_OPEN' } });
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  const created = await context(page);
  const history = await call(page, 'cad_read_features', { expectedVersion: created.version });
  const loft = (history as { items: CadFeature[] }).items.find(feature => feature.kind === 'loft');
  if (!loft) throw new Error('Missing datum Loft');
  expect(loft).toMatchObject({ sketchIds: ['lower', 'upper'], ruled: false });
  expect(await call(page, 'cad_build', { expectedVersion: created.version })).toMatchObject({ diagnostics: [],
    bodies: [{ featureId: loft.id, volumeMm3: expect.closeTo(3920 * Math.PI / 3, 5) }] });
  await openFeatureEditor(page, loft.id);
  await page.getByRole('button', { name: 'Move section 1 down', exact: true }).click();
  await expect(page.getByLabel('Section 1', { exact: true })).toHaveValue('upper');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await context(page)).toMatchObject({ version: created.version, workflowOpen: false });
  await openFeatureEditor(page, loft.id);
  await expect(page.getByLabel('Section 1', { exact: true })).toHaveValue('lower');
  expect(await rawCall(page, 'cad_edit_document', { expectedVersion: created.version,
    edits: [{ kind: 'set-parameter', name: 'height', value: 0 }] })).toMatchObject({ ok: false });
  expect(await context(page)).toMatchObject({ version: created.version, parameters: { height: 20, tilt: 30 } });
  await call(page, 'cad_edit_document', { expectedVersion: created.version,
    edits: [{ kind: 'set-parameter', name: 'height', value: 30 }, { kind: 'set-parameter', name: 'tilt', value: 60 }] });
  const revised = await context(page);
  expect(await call(page, 'cad_build', { expectedVersion: revised.version })).toMatchObject({ diagnostics: [],
    bodies: [{ featureId: loft.id, volumeMm3: expect.closeTo(1960 * Math.PI, 5) }] });
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: revised.version }))
    .toMatchObject({ ok: true, data: { buildVersion: revised.version, view: { available: true, referenceVersion: revised.version } } });
  await call(page, 'cad_set_viewport', { expectedVersion: revised.version, command: { kind: 'fit' } });
  await expectRenderedSolidCapture(page, await captureCadPreview(page, revised.version));
  await page.screenshot({ path: 'tmp/cad-datum-loft.png' });
  const downloaded = page.waitForEvent('download');
  await call(page, 'cad_export_solid', { expectedVersion: revised.version, format: 'step' });
  const download = await downloaded; const path = await download.path();
  if (!path) throw new Error('Missing datum Loft STEP');
  expect(await readFile(path, 'utf8')).toContain('MANIFOLD_SOLID_BREP');
  expect(await call(page, 'cad_save_document', { expectedVersion: revised.version })).toMatchObject({ saved: true });
});

test('Sweep preflight repairs placement before human creation and exact agent CAM handoff', async ({ page, context: browserContext }) => {
  const wasmRequests: string[] = [];
  browserContext.on('request', request => { if (/\.wasm(?:\?|$)/.test(request.url())) wasmRequests.push(request.url()); });
  await prepare(page); const initial = await context(page);
  await call(page, 'cad_create_document', { expectedVersion: initial.version, name: 'Swept bend' });
  const blank = await context(page);
  const sectionSketch: CadSketchFeature = generatedSketch({ kind: 'sketch', id: 'section', name: 'Circular section', suppressed: false,
    plane: 'XY', offset: 0, profiles: [{ id: 'circle', name: 'Circle', construction: false,
      geometry: { kind: 'circle', x: 0, y: 0, radius: 'section_radius' } }] });
  await call(page, 'cad_edit_document', { expectedVersion: blank.version, edits: [
    { kind: 'set-parameter', name: 'section_radius', value: 1 },
    { kind: 'add-feature', feature: sectionSketch },
    { kind: 'add-feature', feature: { kind: 'curve', id: 'rail', name: 'Bend rail', suppressed: false, plane: 'XY', offset: 0,
      segments: [{ kind: 'line', start: [0, 0], end: [20, 0] },
        { kind: 'arc', center: [20, 10], radius: 10, startAngle: -90, sweep: 90 },
        { kind: 'line', start: [30, 10], end: [30, 30] }] } },
  ] });
  const misplaced = await context(page);
  expect(await call(page, 'cad_inspect_sweep', { expectedVersion: misplaced.version, sketchId: 'section', curveId: 'rail' }))
    .toMatchObject({ eligible: false, persisted: false, code: 'unsupported-sweep-placement', message: expect.stringContaining('YZ sketch at offset 0') });
  expect(await context(page)).toMatchObject({ version: misplaced.version, featureCount: 2 });
  await call(page, 'cad_edit_document', { expectedVersion: misplaced.version, edits: [{ kind: 'update-feature', feature: { ...sectionSketch, plane: 'YZ' } }] });
  const sources = await context(page);
  expect(await call(page, 'cad_inspect_sweep', { expectedVersion: sources.version, sketchId: 'section', curveId: 'rail' }))
    .toMatchObject({ eligible: true, persisted: false, nativeBuildRequired: true, nativeWork: 3,
      curve: { segmentCount: 3, lengthMm: expect.closeTo(40 + 5 * Math.PI, 8) } });
  expect(wasmRequests).toEqual([]);
  expect(await call(page, 'cad_describe_features', { kind: 'sweep' }))
    .toMatchObject({ schema: { required: expect.arrayContaining(['sketchId', 'curveId', 'operation', 'targetId']) } });
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: sources.version }))
    .toMatchObject({ ok: true, data: { documentVersion: sources.version } });
  await call(page, 'cad_set_viewport', { expectedVersion: sources.version, command: { kind: 'select-feature', featureId: 'rail' } });
  await page.getByRole('button', { name: 'Sweep', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Profile sketch', exact: true })).toHaveValue('section');
  await expect(page.getByRole('combobox', { name: 'Curve', exact: true })).toHaveValue('rail');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  const created = await context(page);
  const featurePage = await call(page, 'cad_read_features', { expectedVersion: created.version });
  const sweep = (featurePage as { items: CadFeature[] }).items.find(feature => feature.kind === 'sweep');
  if (!sweep) throw new Error('Sweep feature was not committed');
  expect(sweep).toMatchObject({ sketchId: 'section', curveId: 'rail', operation: 'new', targetId: null });
  const unitVolume = 40 * Math.PI + 5 * Math.PI ** 2;
  expect(await call(page, 'cad_build', { expectedVersion: created.version }))
    .toMatchObject({ diagnostics: [], totalBodies: 1, bodies: [{ featureId: sweep.id, volumeMm3: expect.closeTo(unitVolume, 6) }] });
  expect(await rawCall(page, 'cad_edit_document', { expectedVersion: created.version,
    edits: [{ kind: 'set-parameter', name: 'section_radius', value: 12 }] }))
    .toMatchObject({ ok: false, error: { code: 'unsupported-sweep-clearance' } });
  expect(await context(page)).toMatchObject({ version: created.version, parameters: { section_radius: 1 } });
  await call(page, 'cad_edit_document', { expectedVersion: created.version, edits: [{ kind: 'set-parameter', name: 'section_radius', value: 2 }] });
  const finalDraft = await context(page);
  expect(await call(page, 'cad_build', { expectedVersion: finalDraft.version }))
    .toMatchObject({ diagnostics: [], totalBodies: 1, bodies: [{ volumeMm3: expect.closeTo(4 * unitVolume, 6) }] });
  const section = { bodyId: sweep.id, plane: 'YZ', offset: 10 };
  const measured = await call(page, 'cad_inspect_section', { expectedVersion: finalDraft.version, section });
  expect(measured).toMatchObject({ contourCount: 1 });
  const entities = (measured as { entities: { items: { type: string; radius?: number }[] } }).entities.items;
  expect(entities.length).toBeGreaterThan(0);
  for (const entity of entities) { expect(['circle', 'arc']).toContain(entity.type); expect(entity.radius).toBeCloseTo(2, 6); }
  const download = page.waitForEvent('download');
  await call(page, 'cad_export_solid', { expectedVersion: finalDraft.version, format: 'step' });
  const stepPath = await (await download).path(); if (!stepPath) throw new Error('Missing STEP download');
  expect(await readFile(stepPath, 'utf8')).toContain('ISO-10303-21');
  await call(page, 'cad_set_viewport', { expectedVersion: finalDraft.version, command: { kind: 'fit' } });
  await expectRenderedSolidCapture(page, await call(page, 'cad_capture_preview', { expectedVersion: finalDraft.version }));
  await page.screenshot({ path: 'tmp/cad-swept-bend.png' });
  expect(await call(page, 'cad_send_section_to_cam', { expectedVersion: finalDraft.version, section }))
    .toMatchObject({ opened: true, sourceDocumentId: finalDraft.documentId, section: { contourCount: 1, offset: 10 } });
  await expect(page.locator('[data-preview-model="upid"]')).toBeVisible();
});

test('datum Sweep retains authored placement through human creation, parameter rebuild and exact CAM alignment', async ({ page }) => {
  const wasmRequests: string[] = [];
  page.context().on('request', request => { if (/\.wasm(?:\?|$)/.test(request.url())) wasmRequests.push(request.url()); });
  await prepare(page);
  await call(page, 'cad_create_document', { expectedVersion: (await context(page)).version, name: 'Placed sweep' });
  const datum = (id: string, basePlane: 'XY' | 'YZ') => ({ kind: 'datum-plane' as const, id, name: id === 'section_plane' ? 'Section plane' : 'Rail plane', suppressed: false,
    definition: { kind: 'world' as const, basePlane, origin: [30, -20, 12], rotation: [0, 0, 'tilt'] } });
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [
    { kind: 'set-parameter', name: 'tilt', value: 30 }, { kind: 'set-parameter', name: 'radius', value: 1 },
    { kind: 'add-feature', feature: datum('section_plane', 'YZ') },
    { kind: 'add-feature', feature: datum('rail_plane', 'XY') },
    { kind: 'add-feature', feature: generatedSketch({ kind: 'sketch', id: 'section', name: 'Section', suppressed: false,
      plane: { kind: 'datum-plane', featureId: 'section_plane' }, offset: 0,
      profiles: [{ id: 'circle', name: 'Circle', construction: false, geometry: { kind: 'circle', x: 0, y: 0, radius: 'radius' } }] }) },
    { kind: 'add-feature', feature: { kind: 'curve', id: 'rail', name: 'Bend rail', suppressed: false,
      plane: { kind: 'datum-plane', featureId: 'rail_plane' }, offset: 0,
      segments: [{ kind: 'line', start: [0, 0], end: [20, 0] },
        { kind: 'arc', center: [20, 10], radius: 10, startAngle: -90, sweep: 90 },
        { kind: 'line', start: [30, 10], end: [30, 30] }] } },
  ] });
  const sources = await context(page);
  expect(await call(page, 'cad_inspect_sweep', { expectedVersion: sources.version, sketchId: 'section', curveId: 'rail' }))
    .toMatchObject({ eligible: true, persisted: false, nativeBuildRequired: true, units: 'mm',
      section: { plane: { kind: 'datum-plane', featureId: 'section_plane' }, originWorldMm: [30, -20, 12],
        normalWorld: [expect.closeTo(Math.sqrt(3) / 2, 12), expect.closeTo(0.5, 12), 0] },
      curve: { startWorldMm: [30, -20, 12], lengthMm: expect.closeTo(40 + 5 * Math.PI, 10) } });
  expect(wasmRequests).toEqual([]);
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: sources.version }))
    .toMatchObject({ ok: true, data: { view: { available: true, referenceVersion: sources.version } } });
  await call(page, 'cad_set_viewport', { expectedVersion: sources.version, command: { kind: 'select-feature', featureId: 'rail' } });
  await page.getByRole('button', { name: 'Sweep', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Profile sketch', exact: true })).toHaveValue('section');
  await expect(page.getByRole('combobox', { name: 'Curve', exact: true })).toHaveValue('rail');
  expect(await rawCall(page, 'cad_inspect_sweep', { expectedVersion: sources.version, sketchId: 'section', curveId: 'rail' }))
    .toMatchObject({ ok: false, error: { code: 'WORKFLOW_OPEN' } });
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  const created = await context(page);
  const features = await call(page, 'cad_read_features', { expectedVersion: created.version });
  const sweep = (features as { items: CadFeature[] }).items.find(feature => feature.kind === 'sweep');
  if (!sweep) throw new Error('Missing placed Sweep');
  const unitVolume = 40 * Math.PI + 5 * Math.PI ** 2;
  expect(await call(page, 'cad_build', { expectedVersion: created.version }))
    .toMatchObject({ diagnostics: [], bodies: [{ featureId: sweep.id, volumeMm3: expect.closeTo(unitVolume, 6) }] });
  expect(await rawCall(page, 'cad_edit_document', { expectedVersion: created.version, edits: [{ kind: 'set-parameter', name: 'radius', value: 12 }] }))
    .toMatchObject({ ok: false, error: { code: 'unsupported-sweep-clearance' } });
  expect(await context(page)).toMatchObject({ version: created.version, parameters: { radius: 1, tilt: 30 } });
  await call(page, 'cad_edit_document', { expectedVersion: created.version, edits: [
    { kind: 'set-parameter', name: 'tilt', value: 60 }, { kind: 'set-parameter', name: 'radius', value: 1.5 },
  ] });
  const tilted = await context(page);
  expect(await call(page, 'cad_build', { expectedVersion: tilted.version }))
    .toMatchObject({ diagnostics: [], bodies: [{ featureId: sweep.id, volumeMm3: expect.closeTo(unitVolume * 2.25, 6) }] });
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: tilted.version }))
    .toMatchObject({ ok: true, data: { buildVersion: tilted.version, view: { available: true, referenceVersion: tilted.version } } });
  await call(page, 'cad_set_viewport', { expectedVersion: tilted.version, command: { kind: 'fit' } });
  await expectRenderedSolidCapture(page, await call(page, 'cad_capture_preview', { expectedVersion: tilted.version }));
  await page.screenshot({ path: 'tmp/cad-datum-sweep.png' });
  const downloaded = page.waitForEvent('download');
  await call(page, 'cad_export_solid', { expectedVersion: tilted.version, format: 'step' });
  const download = await downloaded; const path = await download.path();
  if (!path) throw new Error('Missing datum Sweep STEP');
  expect(await readFile(path, 'utf8')).toContain('MANIFOLD_SOLID_BREP');
  // Explicit authored alignment for an analytic principal-plane CAM section.
  await call(page, 'cad_edit_document', { expectedVersion: tilted.version, edits: [{ kind: 'set-parameter', name: 'tilt', value: 0 }] });
  const aligned = await context(page);
  expect(await call(page, 'cad_build', { expectedVersion: aligned.version }))
    .toMatchObject({ diagnostics: [], bodies: [{ featureId: sweep.id, volumeMm3: expect.closeTo(unitVolume * 2.25, 6) }] });
  const cut = { bodyId: sweep.id, plane: 'YZ', offset: 40 };
  expect(await call(page, 'cad_inspect_section', { expectedVersion: aligned.version, section: cut }))
    .toMatchObject({ contourCount: 1, entities: { items: [{ type: 'circle', center: { x: -20, y: 12 }, radius: expect.closeTo(1.5, 8) }] } });
  expect(await call(page, 'cad_send_section_to_cam', { expectedVersion: aligned.version, section: cut }))
    .toMatchObject({ opened: true, section: { contourCount: 1, offset: 40 } });
  await expect(page.locator('[data-preview-model="upid"]')).toBeVisible();
});

test('human and agent share a parametric circular bolt-hole pattern through exact CAM handoff', async ({ page }) => {
  await prepare(page);
  const initial = await context(page);
  await call(page, 'cad_create_document', { expectedVersion: initial.version, name: 'Four-bolt flange' });
  const blank = await context(page);
  expect(await call(page, 'cad_describe_features', { kind: 'circular-pattern' })).toMatchObject({
    schema: { required: expect.arrayContaining(['sourceId', 'count', 'axis', 'center', 'angle']) }
  });
  const sketch = (id: string, name: string, x: number, radius: number): CadSketchFeature => generatedSketch({
    id, name, kind: 'sketch', plane: 'XY', offset: 0, suppressed: false,
    profiles: [{ id: `${id}_circle`, name: 'Circle', construction: false, geometry: { kind: 'circle', x, y: 0, radius } }]
  });
  const pad = (id: string, name: string, sketchId: string): CadFeature => ({
    id, name, kind: 'extrude', suppressed: false, sketchId, distance: 'thickness', symmetric: false, operation: 'new', targetId: null
  });
  await call(page, 'cad_edit_document', { expectedVersion: blank.version, edits: [
    { kind: 'set-parameter', name: 'thickness', value: 8 }, { kind: 'set-parameter', name: 'sweep', value: 360 },
    ...[sketch('flange_outline', 'Flange outline', 0, 30), pad('flange_pad', 'Flange', 'flange_outline'),
      sketch('cutter_outline', 'Bolt cutter outline', 20, 3), pad('cutter_pad', 'Bolt cutter', 'cutter_outline')]
      .map(feature => ({ kind: 'add-feature', feature }))
  ] });
  const seeded = await context(page);
  expect(await call(page, 'cad_build', { expectedVersion: seeded.version })).toMatchObject({ diagnostics: [], totalBodies: 2 });
  await call(page, 'cad_set_viewport', { expectedVersion: seeded.version, command: { kind: 'select-feature', featureId: 'cutter_pad' } });
  await page.getByRole('button', { name: 'Pattern', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Circular pattern', exact: true }).click();
  await expect(page.getByLabel('Instances, including original')).toHaveValue('4');
  await editScalarRelation(page, 'Angular extent', 'sweep');
  expect(await rawCall(page, 'cad_edit_document', { expectedVersion: seeded.version,
    edits: [{ kind: 'rename-document', name: 'Must remain blocked' }] })).toMatchObject({ ok: false, error: { code: 'WORKFLOW_OPEN' } });
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  const patterned = await context(page);
  const definitions = await call(page, 'cad_read_features', { expectedVersion: patterned.version });
  const pattern = (definitions as { items: CadFeature[] }).items.find(feature => feature.kind === 'circular-pattern');
  expect(pattern).toMatchObject({ sourceId: 'cutter_pad', count: 4, axis: 'z', center: [0, 0, 0], angle: 'sweep' });
  if (!pattern) throw new Error('Missing applied circular pattern');
  await call(page, 'cad_edit_document', { expectedVersion: patterned.version, edits: [{ kind: 'add-feature', feature: {
    id: 'drilled_flange', name: 'Drilled flange', kind: 'boolean', suppressed: false,
    operation: 'cut', targetId: 'flange_pad', toolId: pattern.id
  } }] });
  const drilled = await context(page);
  expect(await call(page, 'cad_build', { expectedVersion: drilled.version })).toMatchObject({ diagnostics: [], totalBodies: 1,
    bodies: [{ featureId: 'drilled_flange', volumeMm3: expect.closeTo(6912 * Math.PI, 6),
      boundsMm: { min: [expect.closeTo(-30, 5), expect.closeTo(-30, 5), expect.closeTo(0, 5)], max: [expect.closeTo(30, 5), expect.closeTo(30, 5), expect.closeTo(8, 5)] } }] });
  const section = { bodyId: 'drilled_flange', plane: 'XY', offset: 'thickness / 2' };
  expect(await call(page, 'cad_inspect_section', { expectedVersion: drilled.version, section })).toMatchObject({ contourCount: 5 });
  await call(page, 'cad_set_viewport', { expectedVersion: drilled.version, command: { kind: 'select-feature', featureId: 'drilled_flange' } });
  await openViewControls(page);
  await page.getByRole('button', { name: 'Fit model', exact: true }).click();
  const circularCapture = await call(page, 'cad_capture_preview', { expectedVersion: drilled.version });
  expect(circularCapture).toMatchObject({ source: '3d', draftVersion: drilled.version });
  await expectRenderedSolidCapture(page, circularCapture);
  await page.screenshot({ path: 'tmp/cad-circular-flange.png' });
  await call(page, 'cad_save_document', { expectedVersion: drilled.version });
  await page.reload();
  await expectSavedCadReopened(page, drilled.documentId);
  const reloaded = await context(page);
  await call(page, 'cad_open_document', { expectedVersion: reloaded.version, documentId: drilled.documentId });
  const reopened = await context(page);
  expect(await call(page, 'cad_get_feature', { expectedVersion: reopened.version, featureId: pattern.id })).toMatchObject({ feature: pattern });
  expect(await call(page, 'cad_send_section_to_cam', { expectedVersion: reopened.version, section })).toMatchObject({
    opened: true, sourceDocumentId: drilled.documentId, section: { contourCount: 5, offset: 4 }
  });
  await expect(page.locator('[data-preview-model="upid"]')).toBeVisible();
});

test('agent selects exact top edges and chamfers only that rim', async ({ page }) => {
  const { draft, buildId } = await createBox(page);
  const topology = await call(page, 'cad_inspect_topology', { expectedVersion: draft.version, expectedBuildId: buildId, bodyId: 'pad', kind: 'edge', limit: 50 });
  const descriptors = (topology as { descriptors: CadTopologyDescriptor[] }).descriptors;
  const rim = descriptors.filter(edge => edge.kind === 'edge' && edge.curveType === 'line' && Math.abs(edge.start[2] - 5) < 1e-7 && Math.abs(edge.end[2] - 5) < 1e-7);
  expect(rim).toHaveLength(4);
  const picks = rim.map(edge => ({ kind: 'edge', key: edge.key }));
  const resolved = await call(page, 'cad_resolve_topology', { expectedVersion: draft.version, expectedBuildId: buildId, bodyId: 'pad', purpose: 'chamfer', picks });
  expect(resolved).toMatchObject({ purpose: 'chamfer', selection: { expectedCount: 4 } });
  await call(page, 'cad_set_viewport', { expectedVersion: draft.version, command: { kind: 'select-topology', additive: false,
    selection: { documentVersion: draft.version, buildId, bodyId: 'pad', picks } } });
  await expect.poll(() => call(page, 'cad_get_viewport', { expectedVersion: draft.version })).toMatchObject({ topologySelection: { bodyId: 'pad', picks } });
  const capture = await call(page, 'cad_capture_preview', { expectedVersion: draft.version });
  expect(capture).toMatchObject({ source: '3d', viewState: { topologySelection: { picks } } });
  await call(page, 'cad_edit_document', { expectedVersion: draft.version, edits: [{ kind: 'add-feature', feature: {
    id: 'chamfer', name: 'Top rim', kind: 'chamfer', suppressed: false, targetId: 'pad', radius: 1, selection: resolved.selection
  } }] });
  const changed = await context(page);
  const built = await call(page, 'cad_build', { expectedVersion: changed.version });
  expect(built).toMatchObject({ diagnostics: [], bodies: [{ featureId: 'chamfer', volumeMm3: expect.closeTo(1000 - 30 + 4 / 3, 6) }] });
  await expect(rawCall(page, 'cad_inspect_topology', { expectedVersion: changed.version, expectedBuildId: buildId, bodyId: 'chamfer', kind: 'edge' })).resolves.toMatchObject({ ok: false, error: { code: 'STALE_BUILD' } });
  const after = await call(page, 'cad_inspect_topology', { expectedVersion: changed.version, expectedBuildId: built.buildId, bodyId: 'chamfer', kind: 'edge', limit: 50 });
  const bottom = (after as { descriptors: CadTopologyDescriptor[] }).descriptors.filter(edge => edge.kind === 'edge' && edge.curveType === 'line' && Math.abs(edge.start[2]) < 1e-7 && Math.abs(edge.end[2]) < 1e-7);
  expect(bottom).toHaveLength(4);
});

test('one compact header and real face picking create an inward shell', async ({ page }) => {
  const { draft } = await createBox(page);
  await expect(page.locator('[data-app-header] .cad-header')).toHaveCount(1);
  await expect(page.locator('.cad-workbench .cad-header')).toHaveCount(0);
  await openViewControls(page);
  await page.getByLabel('Named view').selectOption('Top');
  await openViewControls(page);
  await page.getByRole('button', { name: 'Fit model', exact: true }).click();
  // Auto picking takes the face under the pointer, away from its edges.
  const canvas = page.locator('.cad-viewport canvas');
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Missing solid canvas');
  expect(bounds.height).toBeGreaterThan(650);
  await canvas.click({ position: { x: bounds.width / 2, y: bounds.height / 2 } });
  await expect.poll(() => call(page, 'cad_get_viewport', { expectedVersion: draft.version })).toMatchObject({ pickMode: 'auto', topologySelection: { bodyId: 'pad', picks: [{ kind: 'face' }] } });
  await page.getByRole('button', { name: 'Shell', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Wall thickness mm', exact: true })).toHaveValue('1');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  const changed = await context(page);
  expect(await call(page, 'cad_build', { expectedVersion: changed.version })).toMatchObject({ diagnostics: [], bodies: [{ volumeMm3: expect.closeTo(424, 7) }] });
});

test('View drawer and floating configuration preserve pending dimensions and canvas framing', async ({ page }) => {
  const { draft } = await createBox(page);
  await openFeatureEditor(page, 'pad');
  const length = page.getByRole('textbox', { name: 'Length mm', exact: true });
  const canvas = page.locator('.cad-viewport canvas');
  const originalBounds = await canvas.boundingBox();
  await editScalarRelation(page, 'Length', 'height + 2');
  await expect(length).toHaveValue('7');
  await expect(length).toHaveAttribute('readonly', '');
  const viewTab = page.getByRole('button', { name: 'View controls', exact: true });
  await viewTab.click(); await expect(viewTab).toHaveAttribute('aria-expanded', 'true');
  expect(await canvas.boundingBox()).toEqual(originalBounds);
  await viewTab.press('Escape'); await expect(viewTab).toHaveAttribute('aria-expanded', 'false');
  await expect(length).toHaveValue('7');
  expect(await context(page)).toMatchObject({ version: draft.version, workflowOpen: true });
  expect(await rawCall(page, 'cad_edit_document', { expectedVersion: draft.version, edits: [{ kind: 'set-parameter', name: 'height', value: 9 }] }))
    .toMatchObject({ ok: false, error: { code: 'WORKFLOW_OPEN' } });
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(length).toHaveValue('7');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1024);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  const changed = await context(page);
  expect(await call(page, 'cad_build', { expectedVersion: changed.version })).toMatchObject({ diagnostics: [], bodies: [{ volumeMm3: expect.closeTo(1400, 6) }] });
  expect(await call(page, 'cad_get_feature', { expectedVersion: changed.version, featureId: 'pad' })).toMatchObject({ feature: { distance: 'height + 2' } });
  await expect.poll(() => call(page, 'cad_get_viewport', { expectedVersion: changed.version })).toMatchObject({ buildVersion: changed.version });
  await openFeatureEditor(page, 'pad');
  const canvasBounds = await canvas.boundingBox();
  const expanded = await call(page, 'cad_get_viewport', { expectedVersion: changed.version });
  const framing = expanded.view as { mode: string; view: string; zoom: number; gridVisible: boolean };
  await page.getByRole('button', { name: 'Minimize configuration', exact: true }).click();
  expect(await canvas.boundingBox()).toEqual(canvasBounds);
  expect(await call(page, 'cad_get_viewport', { expectedVersion: changed.version })).toMatchObject({ view: { mode: framing.mode, view: framing.view, zoom: framing.zoom, gridVisible: framing.gridVisible } });
  await page.getByRole('button', { name: 'Expand configuration', exact: true }).click();
  await expect(length).toHaveValue('7'); expect(await canvas.boundingBox()).toEqual(canvasBounds);
  expect(await context(page)).toMatchObject({ version: changed.version, workflowOpen: false });
});

test('STEP and STL exports import as standalone solids with preserved originals', async ({ page }) => {
  test.setTimeout(120_000);
  const { draft } = await createBox(page);
  await call(page, 'cad_save_document', { expectedVersion: draft.version });
  for (const format of ['step', 'stl'] as const) {
    const before = await context(page);
    const downloadPromise = page.waitForEvent('download');
    await call(page, 'cad_export_solid', { expectedVersion: before.version, format });
    const download = await downloadPromise; const path = await download.path();
    if (!path) throw new Error('Missing geometry download');
    const bytes = await readFile(path);
    const source = format === 'step'
      ? { format, fileName: 'exchange.step', encoding: 'utf8', data: bytes.toString('utf8') }
      : { format, fileName: 'exchange.stl', encoding: 'base64', data: bytes.toString('base64'), units: 'mm' };
    expect(await call(page, 'cad_import_solid', { expectedVersion: before.version, source })).toMatchObject({ imported: true, format, sourceBytes: bytes.length, volume: expect.closeTo(1000, 6) });
    const imported = await context(page);
    expect(imported.documentId).not.toBe(before.documentId);
    expect(await call(page, 'cad_build', { expectedVersion: imported.version })).toMatchObject({ diagnostics: [], bodies: [{ volumeMm3: expect.closeTo(1000, 6) }] });
    const features = await call(page, 'cad_read_features', { expectedVersion: imported.version });
    expect(features).toMatchObject({ items: [{ kind: 'imported', source }] });
    await call(page, 'cad_save_document', { expectedVersion: imported.version });
    await page.reload();
    await expectSavedCadReopened(page, imported.documentId);
    const reloaded = await context(page);
    await call(page, 'cad_open_document', { expectedVersion: reloaded.version, documentId: imported.documentId });
    const opened = await context(page);
    expect(await call(page, 'cad_build', { expectedVersion: opened.version })).toMatchObject({ diagnostics: [], bodies: [{ volumeMm3: expect.closeTo(1000, 6) }] });
  }
});

test('visible STL import reviews source units before changing the draft', async ({ page }) => {
  const { draft } = await createBox(page);
  await call(page, 'cad_save_document', { expectedVersion: draft.version });
  const downloadPromise = page.waitForEvent('download');
  await call(page, 'cad_export_solid', { expectedVersion: draft.version, format: 'stl' });
  const download = await downloadPromise; const path = await download.path();
  if (!path) throw new Error('Missing STL download');
  await page.locator('.cad-header input[type=file]').setInputFiles({ name: 'source.stl', mimeType: 'model/stl', buffer: await readFile(path) });
  const pending = page.getByRole('dialog', { name: 'Import CAD file' });
  await expect(pending).toBeVisible();
  expect(await context(page)).toMatchObject({ documentId: draft.documentId, workflowOpen: true });
  await pending.getByLabel('Source units').selectOption('inch');
  await pending.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(pending).not.toBeVisible();
  const imported = await context(page);
  expect(await call(page, 'cad_build', { expectedVersion: imported.version })).toMatchObject({ diagnostics: [], bodies: [{ volumeMm3: expect.closeTo(1000 * 25.4 ** 3, 3) }] });
});

test('DXF exchange preserves exact rounded contours and reconstructs a standalone editable part', async ({ page }) => {
  await prepare(page);
  const initial = await context(page);
  await call(page, 'cad_create_document', { expectedVersion: initial.version, name: 'Drawing exchange' });
  const empty = await context(page);
  await call(page, 'cad_edit_document', { expectedVersion: empty.version, edits });
  const original = await context(page);
  await call(page, 'cad_save_document', { expectedVersion: original.version });
  const downloadPromise = page.waitForEvent('download');
  await call(page, 'cad_export_dxf', { expectedVersion: original.version, sketchId: 'outline' });
  const path = await (await downloadPromise).path();
  if (!path) throw new Error('Missing DXF download');
  const text = await readFile(path, 'utf8');
  const source = { format: 'dxf', fileName: 'rounded-plate.dxf', text };
  const imported = await call(page, 'cad_import_dxf', { expectedVersion: original.version, source });
  expect(imported).toMatchObject({ imported: true, contourCount: 2, scaleToMillimeters: 1 });
  if (typeof imported.sketchId !== 'string') throw new Error('Missing imported sketch ID');
  const draft = await context(page);
  expect(draft.documentId).not.toBe(original.documentId);
  const definitions = await call(page, 'cad_read_features', { expectedVersion: draft.version });
  // Each contour is a generator, stored alone: the rounded plate a closed path that keeps its four corner arcs, the bore a circle.
  expect(definitions).toMatchObject({ items: [{ kind: 'sketch', plane: 'XY', source, profiles: [], graph: { points: [], entities: [],
    relations: expect.arrayContaining([{ id: expect.any(String), kind: 'generator', idPrefix: expect.any(String), name: expect.any(String), construction: false,
      geometry: { kind: 'path', segments: expect.any(Array) } }]) } }] });
  const [sketch] = definitions.items as CadSketchFeature[];
  const paths = sketch.graph?.relations.flatMap(relation => relation.kind === 'generator' && relation.geometry.kind === 'path' ? [relation.geometry.segments] : []) ?? [];
  expect(paths).toHaveLength(1);
  expect(paths[0].flatMap(segment => segment.kind === 'arc' ? [segment.radius] : [])).toEqual(Array(4).fill(expect.closeTo(3, 9)));
  await call(page, 'cad_set_viewport', { expectedVersion: draft.version, command: { kind: 'edit-sketch', sketchId: imported.sketchId } });
  await expect(page.getByLabel('Sketch drawing canvas')).toBeVisible();
  await call(page, 'cad_set_viewport', { expectedVersion: draft.version, command: { kind: 'finish-sketch' } });
  await call(page, 'cad_edit_document', { expectedVersion: draft.version, edits: [{ kind: 'add-feature', feature: {
    id: 'import_pad', name: 'Imported outline pad', kind: 'extrude', suppressed: false, sketchId: imported.sketchId,
    distance: 10, symmetric: false, operation: 'new', targetId: null
  } }] });
  const solid = await context(page);
  const expectedVolume = (60 * 40 - (4 - Math.PI) * 9 - Math.PI * 25) * 10;
  expect(await call(page, 'cad_build', { expectedVersion: solid.version })).toMatchObject({ diagnostics: [], bodies: [{ volumeMm3: expect.closeTo(expectedVolume, 5) }] });
  await call(page, 'cad_save_document', { expectedVersion: solid.version });
  await page.reload();
  await expectSavedCadReopened(page, solid.documentId);
  const reloaded = await context(page);
  await call(page, 'cad_open_document', { expectedVersion: reloaded.version, documentId: solid.documentId });
  const opened = await context(page);
  expect(await call(page, 'cad_get_feature', { expectedVersion: opened.version, featureId: imported.sketchId })).toMatchObject({ feature: { source } });
  expect(await call(page, 'cad_build', { expectedVersion: opened.version })).toMatchObject({ diagnostics: [], bodies: [{ volumeMm3: expect.closeTo(expectedVolume, 5) }] });
});

test('an imported path is selected by its interior and edited atomically through segment fields', async ({ page }) => {
  const { draft } = await createBox(page);
  await call(page, 'cad_save_document', { expectedVersion: draft.version });
  const download = page.waitForEvent('download');
  await call(page, 'cad_export_dxf', { expectedVersion: draft.version, sketchId: 'outline' });
  const path = await (await download).path();
  if (!path) throw new Error('Missing DXF download');
  const source = { format: 'dxf', fileName: 'editable-footprint.dxf', text: await readFile(path, 'utf8') };
  const imported = await call(page, 'cad_import_dxf', { expectedVersion: draft.version, source });
  if (typeof imported.sketchId !== 'string') throw new Error('Missing imported sketch ID');
  const before = await context(page);
  await call(page, 'cad_edit_document', { expectedVersion: before.version, edits: [{ kind: 'set-parameter', name: 'tipX', value: 30 }] });
  const current = await context(page);
  const result = await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: imported.sketchId });
  expect(result).toMatchObject({ feature: { kind: 'sketch', source } });
  const feature = result.feature as CadSketchFeature;
  // The imported contour is a path generator, stored alone, and no saved profile.
  expect(feature.profiles).toEqual([]);
  const contour = feature.graph?.relations[0];
  if (contour?.kind !== 'generator' || contour.geometry.kind !== 'path') throw new Error('Expected an exact imported path generator');
  const segments = contour.geometry.segments;
  const segmentIndex = segments.findIndex(segment => segment.kind === 'line' && segment.end[0] === 20 && segment.end[1] === 0);
  if (segmentIndex < 0) throw new Error('Expected the lower right vertex');
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'edit-sketch', sketchId: imported.sketchId } });
  await openViewControls(page);
  await page.getByRole('button', { name: 'Fit sketch', exact: true }).click();
  // A genuine pointer click inside the shape must select it even though the
  // drawing uses transparent fills. The public centre is in world millimetres;
  // the visible SVG renders relative to that centre before applying its Y flip.
  const viewport = await call(page, 'cad_get_viewport', { expectedVersion: current.version });
  const view = viewport.view;
  if (!view || typeof view !== 'object' || !('mode' in view) || view.mode !== 'sketch' || !('centerMm' in view)
    || !Array.isArray(view.centerMm) || view.centerMm.length !== 2 || view.centerMm.some((value: unknown) => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error('Missing current sketch world centre');
  }
  const centerMm: [number, number] = [view.centerMm[0], view.centerMm[1]];
  const pixel = (x: number, y: number) => page.getByLabel('Sketch drawing canvas').evaluate((element, { center, at }) => {
    const canvas = element as SVGSVGElement;
    const transform = canvas.getScreenCTM();
    if (!transform) throw new Error('Missing visible sketch transformation');
    const world = canvas.createSVGPoint(); world.x = at[0] - center[0]; world.y = center[1] - at[1];
    const pixels = world.matrixTransform(transform);
    return { x: pixels.x, y: pixels.y };
  }, { center: centerMm, at: [x, y] as [number, number] });
  // The contour's edges are its sketch geometry: a click on its upper edge selects that edge, whose shape Edit shape opens.
  const edge = await pixel(10, 10);
  await page.mouse.click(edge.x, edge.y);
  await page.getByRole('form', { name: 'Sketch selection' }).getByRole('button', { name: 'Edit shape', exact: true }).click();
  await expect(page.getByLabel('Path segment', { exact: true })).toBeVisible();
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'select-profile', profileId: null } });
  await expect(page.getByLabel('Path segment', { exact: true })).toHaveCount(0);
  // Its interior selects the shape itself, which opens straight to its exact segments.
  const point = await pixel(10, 5);
  await page.mouse.click(point.x, point.y);
  await expect(page.getByLabel('Path segment', { exact: true })).toBeVisible();
  await page.getByLabel('Path segment', { exact: true }).fill(String(segmentIndex + 1));
  await page.getByRole('textbox', { name: 'End X mm', exact: true }).fill('tipX');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.locator('.cad-property-form [role="alert"]')).toContainText('continuous and closed');
  expect(await context(page)).toMatchObject({ version: current.version, workflowOpen: true });
  await page.getByLabel('Path segment', { exact: true }).fill(String((segmentIndex + 1) % segments.length + 1));
  await page.getByRole('textbox', { name: 'Start X mm', exact: true }).fill('tipX');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.locator('.cad-property-form [role="alert"]')).not.toBeVisible();
  const changed = await context(page);
  expect(changed.version).not.toBe(current.version); expect(changed.workflowOpen).toBe(false);
  expect(await call(page, 'cad_get_feature', { expectedVersion: changed.version, featureId: imported.sketchId })).toMatchObject({ feature: { source } });
  expect(await call(page, 'cad_measure_sketch', { expectedVersion: changed.version, sketchId: imported.sketchId })).toMatchObject({ materialAreaMm2: expect.closeTo(250, 6) });
  await page.screenshot({ path: 'tmp/cad-path-editor.png' });
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  await call(page, 'cad_edit_document', { expectedVersion: changed.version, edits: [{ kind: 'add-feature', feature: {
    id: 'edited_pad', name: 'Edited footprint pad', kind: 'extrude', suppressed: false, sketchId: imported.sketchId,
    distance: 5, symmetric: false, operation: 'new', targetId: null
  } }] });
  const solid = await context(page);
  expect(await call(page, 'cad_build', { expectedVersion: solid.version })).toMatchObject({ diagnostics: [], bodies: [{ volumeMm3: expect.closeTo(1250, 6) }] });
});

test('agent hollows one planar face and carries a parameterized wall section into CAM', async ({ page }) => {
  const { draft, buildId } = await createBox(page);
  const inspected = await call(page, 'cad_inspect_topology', { expectedVersion: draft.version, expectedBuildId: buildId, bodyId: 'pad', kind: 'face', limit: 50 });
  const top = (inspected as { descriptors: CadTopologyDescriptor[] }).descriptors.filter(face => face.kind === 'face' && face.surfaceType === 'plane' && face.normal[2] > .999 && Math.abs(face.offset - 5) < 1e-7);
  expect(top).toHaveLength(1);
  const resolved = await call(page, 'cad_resolve_topology', { expectedVersion: draft.version, expectedBuildId: buildId, bodyId: 'pad', purpose: 'shell', picks: [{ kind: 'face', key: top[0].key }] });
  expect(resolved).toMatchObject({ purpose: 'shell', opening: { expectedCount: 1 } });
  const shell = { id: 'shell', name: 'Housing walls', kind: 'shell', suppressed: false, targetId: 'pad', thickness: 1,
    opening: { kind: 'faces', expectedCount: 1, predicates: [{ kind: 'plane', normal: [0, 0, 1], offset: 'height' }] } };
  await call(page, 'cad_edit_document', { expectedVersion: draft.version, edits: [{ kind: 'add-feature', feature: shell }] });
  const hollow = await context(page);
  expect(await call(page, 'cad_build', { expectedVersion: hollow.version })).toMatchObject({ diagnostics: [], bodies: [{ featureId: 'shell', volumeMm3: expect.closeTo(424, 7) }] });
  await call(page, 'cad_edit_document', { expectedVersion: hollow.version, edits: [{ kind: 'set-parameter', name: 'width', value: 24 }, { kind: 'set-parameter', name: 'height', value: 8 }] });
  const resized = await context(page);
  expect(await call(page, 'cad_build', { expectedVersion: resized.version })).toMatchObject({ diagnostics: [], bodies: [{ featureId: 'shell', volumeMm3: expect.closeTo(688, 7) }] });
  const section = { bodyId: 'shell', plane: 'XY', offset: 'height / 2' };
  expect(await call(page, 'cad_inspect_section', { expectedVersion: resized.version, section })).toMatchObject({ contourCount: 2, entities: { total: 8 } });
  expect(await call(page, 'cad_send_section_to_cam', { expectedVersion: resized.version, section })).toMatchObject({ opened: true, section: { contourCount: 2, offset: 4 } });
  await expect(page.locator('[data-preview-model="upid"]')).toBeVisible();
});

test('agent builds, checks exact volume, exports, reopens and hands analytic geometry to CAM', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await prepare(page);
  const empty = await context(page);
  await call(page, 'cad_create_document', { expectedVersion: empty.version, name: 'Precision plate' });
  const created = await context(page);
  await call(page, 'cad_edit_document', { expectedVersion: created.version, edits });
  const current = await context(page);
  const result = await call(page, 'cad_build', { expectedVersion: current.version });
  const expectedVolume = (60 * 40 - (4 - Math.PI) * 9 - Math.PI * 25) * 10;
  expect(result).toMatchObject({ diagnostics: [], bodies: [{ featureId: 'pad', volumeMm3: expect.closeTo(expectedVolume, 5), boundsMm: { max: [expect.closeTo(60, 8), expect.closeTo(40, 8), expect.closeTo(10, 8)] } }] });
  await expect.poll(() => context(page)).toMatchObject({ version: current.version, buildState: 'ready', buildVersion: current.version, diagnostics: [] });
  await expect(page.locator('.cad-viewport canvas')).toBeVisible();
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'set-view', view: 'Top' } });
  await expect.poll(() => call(page, 'cad_get_viewport', { expectedVersion: current.version })).toMatchObject({ view: { mode: 'solid', view: 'Top' }, buildVersion: current.version });
  const capture = await call(page, 'cad_capture_preview', { expectedVersion: current.version });
  expect(capture).toMatchObject({ contentSource: 'cad-draft', documentId: current.documentId, draftVersion: current.version, dirty: true, source: '3d', mimeType: 'image/png', sha256: expect.stringMatching(/^[a-f0-9]{64}$/), downloadRequested: false });
  await page.screenshot({ path: 'tmp/cad-workbench.png' });
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'edit-sketch', sketchId: 'outline' } });
  await expect.poll(() => call(page, 'cad_get_viewport', { expectedVersion: current.version })).toMatchObject({ view: { mode: 'sketch', available: true } });
  const sketchCapture = await call(page, 'cad_capture_preview', { expectedVersion: current.version });
  expect(sketchCapture).toMatchObject({ contentSource: 'cad-draft', sketchId: 'outline', source: '2d', dirty: true });
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'finish-sketch' } });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);
  await expect(rawCall(page, 'cad_edit_document', { expectedVersion: created.version, edits: [{ kind: 'rename-document', name: 'Stale' }] })).resolves.toMatchObject({ ok: false, error: { code: 'STALE_STATE' } });
  const downloadPromise = page.waitForEvent('download');
  await call(page, 'cad_export_solid', { expectedVersion: current.version, format: 'step' });
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('Precision plate.step');
  const downloaded = await download.path();
  if (!downloaded) throw new Error('Missing STEP download');
  expect(await readFile(downloaded, 'utf8')).toContain('MANIFOLD_SOLID_BREP');
  await call(page, 'cad_save_document', { expectedVersion: current.version });
  await page.reload();
  await expectSavedCadReopened(page, current.documentId);
  const reloaded = await context(page);
  const library = await call(page, 'cad_list_documents');
  expect(library).toMatchObject({ items: [{ id: current.documentId, name: 'Precision plate', featureCount: 2 }] });
  await call(page, 'cad_open_document', { expectedVersion: reloaded.version, documentId: current.documentId });
  const reopened = await context(page);
  expect(reopened).toMatchObject({ dirty: false, featureCount: 2 });
  const handoff = await call(page, 'cad_send_to_cam', { expectedVersion: reopened.version, sketchId: 'outline' });
  expect(handoff).toMatchObject({ opened: true, sourceDocumentId: current.documentId, sketchId: 'outline' });
  await expect(page.locator('[data-preview-model="upid"]')).toBeVisible();
  const cam = await call(page, 'edm_get_context');
  expect(cam).toMatchObject({ draft: { dirty: false, model: 'upid' } });
  expect(errors).toEqual([]);
});

test('final-solid section preview protects its workflow and creates clean CAM geometry', async ({ page }) => {
  await prepare(page);
  const initial = await context(page);
  await call(page, 'cad_create_document', { expectedVersion: initial.version, name: 'Section plate' });
  const blank = await context(page);
  await call(page, 'cad_edit_document', { expectedVersion: blank.version,
    edits: edits.map(edit => edit.feature?.id === 'outline' ? { ...edit, feature: { ...edit.feature, offset: 5 } } : edit) });
  const current = await context(page);
  expect(await call(page, 'cad_build', { expectedVersion: current.version })).toMatchObject({
    diagnostics: [], bodies: [{ boundsMm: { min: [expect.closeTo(0, 9), expect.closeTo(0, 9), 5], max: [expect.closeTo(60, 9), expect.closeTo(40, 9), 15] } }],
  });
  const request = { bodyId: 'pad', plane: 'XY', offset: 10 };
  const section = await call(page, 'cad_inspect_section', { expectedVersion: current.version, section: request, limit: 2 });
  expect(section).toMatchObject({ bodyId: 'pad', plane: 'XY', offset: 10, contourCount: 2, entities: { items: expect.any(Array), total: 10, nextOffset: 2 } });
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Section for CAM', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Section for CAM' });
  await expect(dialog).toBeVisible();
  expect(await rawCall(page, 'cad_edit_document', { expectedVersion: current.version, edits: [{ kind: 'rename-document', name: 'Interruption' }] })).toMatchObject({ ok: false, error: { code: 'WORKFLOW_OPEN' } });
  await expect(dialog.getByLabel('Plane offset (mm)')).toHaveValue('10');
  await dialog.getByRole('button', { name: 'Preview section', exact: true }).click();
  await expect(dialog.getByRole('img', { name: 'Exact section preview' })).toBeVisible();
  await expect(dialog.getByRole('status')).toContainText('2 closed contours');
  await dialog.getByRole('button', { name: 'Send section to CAM', exact: true }).click();
  await expect(page.locator('[data-preview-model="upid"]')).toBeVisible();
  const cam = await call(page, 'edm_get_context');
  expect(cam).toMatchObject({ draft: { model: 'upid', dirty: false } });
});

test('agent path construction remains read-only before exact solid, DXF and saved CAD use', async ({ page }) => {
  await prepare(page);
  const initial = await context(page);
  const constructed = await call(page, 'cad_construct_path', {
    start: [0, -10], steps: [{ kind: 'arc', end: [0, 10], through: [10, 0] }]
  });
  expect(constructed).toMatchObject({ persisted: false, segmentCount: 2,
    areaMm2: expect.closeTo(50 * Math.PI, 8), perimeterMm: expect.closeTo(10 * Math.PI + 20, 8) });
  expect(await context(page)).toMatchObject({ version: initial.version, documentId: initial.documentId, featureCount: 0 });
  if (!('geometry' in constructed)) throw new Error('Missing constructed geometry');
  await call(page, 'cad_create_document', { expectedVersion: initial.version, name: 'Exact D profile' });
  const blank = await context(page);
  await call(page, 'cad_edit_document', { expectedVersion: blank.version, edits: [
    { kind: 'add-feature', feature: generatedSketch({ id: 'd_outline', name: 'D outline', kind: 'sketch', suppressed: false, plane: 'XY', offset: 0,
      profiles: [{ id: 'd_contour', name: 'D contour', construction: false, geometry: constructed.geometry }] }) },
    { kind: 'add-feature', feature: { id: 'd_pad', name: 'D pad', kind: 'extrude', suppressed: false,
      sketchId: 'd_outline', distance: 5, symmetric: false, operation: 'new', targetId: null } }
  ] });
  const draft = await context(page);
  expect(await call(page, 'cad_build', { expectedVersion: draft.version }))
    .toMatchObject({ diagnostics: [], bodies: [{ volumeMm3: expect.closeTo(250 * Math.PI, 7) }] });
  const section = await call(page, 'cad_inspect_section', { expectedVersion: draft.version,
    section: { bodyId: 'd_pad', plane: 'XY', offset: 2.5 } });
  expect(section).toMatchObject({ contourCount: 1, entities: { total: 2,
    items: expect.arrayContaining([expect.objectContaining({ type: 'arc', center: expect.any(Object), radius: 10,
      startAngle: expect.any(Number), endAngle: expect.any(Number) })]) } });
  const downloadPromise = page.waitForEvent('download');
  await call(page, 'cad_export_dxf', { expectedVersion: draft.version, sketchId: 'd_outline' });
  const download = await downloadPromise; const path = await download.path();
  if (!path) throw new Error('Missing analytic DXF download');
  const dxf = await readFile(path, 'utf8');
  expect(dxf).toMatch(/\bARC\b/); expect(dxf).toMatch(/\bLINE\b/);
  await call(page, 'cad_save_document', { expectedVersion: draft.version });
  await page.reload();
  await expectSavedCadReopened(page, draft.documentId);
  const reloaded = await context(page);
  await call(page, 'cad_open_document', { expectedVersion: reloaded.version, documentId: draft.documentId });
  const reopened = await context(page);
  expect(await call(page, 'cad_get_feature', { expectedVersion: reopened.version, featureId: 'd_outline' }))
    .toMatchObject({ feature: { profiles: [], graph: { relations: [{ id: 'd_contour', kind: 'generator', geometry: constructed.geometry }] } } });
  expect(await call(page, 'cad_build', { expectedVersion: reopened.version }))
    .toMatchObject({ diagnostics: [], bodies: [{ volumeMm3: expect.closeTo(250 * Math.PI, 7) }] });
});

test('agent open curves stay exact through reference rendering, DXF exchange and saved history without loading the solid engine', async ({ page }) => {
  const wasmRequests: string[] = [];
  page.context().on('request', request => { if (/\.wasm(?:\?|$)/.test(request.url())) wasmRequests.push(request.url()); });
  await prepare(page); const initial = await context(page);
  const constructed = await call(page, 'cad_construct_curve', { start: [0, 0], steps: [
    { kind: 'line', end: [20, 0] }, { kind: 'arc', end: [20, 20], through: [30, 10] }
  ] });
  expect(constructed).toMatchObject({ persisted: false, segmentCount: 2, lengthMm: expect.closeTo(20 + 10 * Math.PI, 8) });
  expect(await context(page)).toMatchObject({ version: initial.version, open: false });
  await call(page, 'cad_create_document', { expectedVersion: initial.version, name: 'Open reference rail' });
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [
    { kind: 'set-parameter', name: 'elevation', value: 7 },
    { kind: 'add-feature', feature: { id: 'rail', name: 'Bend rail', kind: 'curve', suppressed: false, plane: 'XZ', offset: 'elevation', segments: constructed.segments } }
  ] });
  const created = await context(page);
  expect(await call(page, 'cad_measure_curve', { expectedVersion: created.version, curveId: 'rail' })).toMatchObject({ lengthMm: expect.closeTo(20 + 10 * Math.PI, 8), startWorldMm: [0, -7, 0], endWorldMm: [20, -7, 20] });
  await expect.poll(async () => rawCall(page, 'cad_get_viewport', { expectedVersion: created.version })).toMatchObject({ ok: true, data: { buildState: 'idle', buildVersion: null, visibleBodyIds: [], view: { available: true, referenceVersion: created.version } } });
  await call(page, 'cad_set_viewport', { expectedVersion: created.version, command: { kind: 'fit' } });
  const capture = await call(page, 'cad_capture_preview', { expectedVersion: created.version });
  expect(capture).toMatchObject({ source: '3d', curveId: null, viewState: { buildVersion: null, view: { referenceVersion: created.version } } });
  if (typeof capture.previewUrl !== 'string') throw new Error('Missing reference preview');
  const referencePixels = await page.evaluate(async url => {
    const image = new Image(); image.src = url; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); if (!context) throw new Error('Missing pixels'); context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data; let count = 0;
    for (let index = 0; index < data.length; index += 4) if (data[index] > 100 && data[index + 1] > 140 && data[index + 2] > 140 && data[index + 3] > 0) count++;
    return count;
  }, capture.previewUrl);
  expect(referencePixels).toBeGreaterThan(100);
  await call(page, 'cad_set_viewport', { expectedVersion: created.version, command: { kind: 'edit-curve', curveId: 'rail' } });
  expect(await call(page, 'cad_capture_preview', { expectedVersion: created.version })).toMatchObject({ source: '2d', curveId: 'rail', sketchId: null, viewState: { view: { mode: 'curve', plane: 'XZ' } } });
  await call(page, 'cad_set_viewport', { expectedVersion: created.version, command: { kind: 'finish-curve' } });
  const downloadPromise = page.waitForEvent('download');
  await call(page, 'cad_export_curve_dxf', { expectedVersion: created.version, curveId: 'rail' });
  const path = await (await downloadPromise).path(); if (!path) throw new Error('Missing Curve DXF');
  const text = await readFile(path, 'utf8'); expect(text).toContain('LWPOLYLINE');
  await call(page, 'cad_save_document', { expectedVersion: created.version });
  await call(page, 'cad_import_curve_dxf', { expectedVersion: created.version, source: { format: 'dxf', fileName: 'Rail.dxf', text } });
  const imported = await context(page);
  const features = await call(page, 'cad_read_features', { expectedVersion: imported.version });
  if (!Array.isArray(features.items)) throw new Error('Missing Curve features');
  const curve = features.items[0] as CadFeature;
  expect(curve).toMatchObject({ kind: 'curve', plane: 'XY', offset: 0, source: { text } });
  expect(await call(page, 'cad_measure_curve', { expectedVersion: imported.version, curveId: curve.id })).toMatchObject({ lengthMm: expect.closeTo(20 + 10 * Math.PI, 8), startMm: [0, 0], endMm: [expect.closeTo(20, 12), 20] });
  await call(page, 'cad_save_document', { expectedVersion: imported.version });
  expect(wasmRequests, 'Reference authoring, measurement and DXF import must not request either solid WASM engine').toEqual([]);
  await page.reload(); await expectSavedCadReopened(page, imported.documentId);
  const reloaded = await context(page);
  await call(page, 'cad_open_document', { expectedVersion: reloaded.version, documentId: imported.documentId });
  expect(await call(page, 'cad_get_feature', { expectedVersion: (await context(page)).version, featureId: curve.id })).toMatchObject({ feature: curve });
  await expect(page.getByLabel('3D model viewport')).toBeVisible();
  await expect.poll(async () => rawCall(page, 'cad_get_viewport', { expectedVersion: (await context(page)).version })).toMatchObject({ ok: true, data: { view: { available: true, referenceVersion: expect.any(String) } } });
  await call(page, 'cad_set_viewport', { expectedVersion: (await context(page)).version, command: { kind: 'select-feature', featureId: curve.id } });
  await page.screenshot({ path: 'tmp/cad-open-curve.png' });
});

test('world-space sketch sections render without WASM and follow the selected feature sources', async ({ page }) => {
  const wasmRequests: string[] = [];
  page.context().on('request', request => { if (/\.wasm(?:\?|$)/.test(request.url())) wasmRequests.push(request.url()); });
  await prepare(page); const initial = await context(page);
  await call(page, 'cad_create_document', { expectedVersion: initial.version, name: 'Visible loft sections' });
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [
    { kind: 'add-feature', feature: generatedSketch({ id: 'lower', name: 'Lower section', kind: 'sketch', plane: 'XY', offset: 0, suppressed: false,
      profiles: [{ id: 'circle', name: 'Circle', construction: false, geometry: { kind: 'circle', x: 0, y: 0, radius: 12 } },
        { id: 'construction', name: 'Construction guide', construction: true, geometry: { kind: 'circle', x: 0, y: 0, radius: 16 } }] }) },
    { kind: 'add-feature', feature: generatedSketch({ id: 'upper', name: 'Upper section', kind: 'sketch', plane: 'XY', offset: 20, suppressed: false,
      profiles: [{ id: 'circle', name: 'Circle', construction: false, geometry: { kind: 'circle', x: 0, y: 0, radius: 8 } }] }) },
  ] });
  const sections = await context(page);
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: sections.version }))
    .toMatchObject({ ok: true, data: { buildState: 'idle', buildVersion: null, visibleBodyIds: [],
      view: { referenceVersion: sections.version, referenceFeatureIds: ['lower', 'upper'] } } });
  await call(page, 'cad_set_viewport', { expectedVersion: sections.version, command: { kind: 'set-grid', visible: false } });
  await call(page, 'cad_set_viewport', { expectedVersion: sections.version, command: { kind: 'fit' } });
  const capture = await call(page, 'cad_capture_preview', { expectedVersion: sections.version });
  if (typeof capture.previewUrl !== 'string') throw new Error('Missing world-space sketch preview');
  const pixels = await page.evaluate(async url => {
    const image = new Image(); image.src = url; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); if (!context) throw new Error('Missing pixels'); context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let cyan = 0; for (let index = 0; index < data.length; index += 4) if (data[index] > 100 && data[index + 1] > 140 && data[index + 2] > 140 && data[index + 3] > 0) cyan++;
    return cyan;
  }, capture.previewUrl);
  expect(pixels, 'Both Sketch sections must render before a Loft or solid engine exists').toBeGreaterThan(150);
  await page.screenshot({ path: 'tmp/cad-world-sketch-sections.png' });
  expect(wasmRequests, 'Sketch reference preparation and capture must not initialize WASM').toEqual([]);
  await call(page, 'cad_edit_document', { expectedVersion: sections.version, edits: [
    { kind: 'add-feature', feature: { id: 'loft', name: 'Loft', kind: 'loft', suppressed: false,
      sketchIds: ['lower', 'upper'], ruled: true, operation: 'new', targetId: null } }
  ] });
  const solid = await context(page);
  expect(await call(page, 'cad_build', { expectedVersion: solid.version })).toMatchObject({ diagnostics: [], bodies: [{ volumeMm3: expect.closeTo(6080 * Math.PI / 3, 6) }] });
  await call(page, 'cad_set_viewport', { expectedVersion: solid.version, command: { kind: 'select-feature', featureId: null } });
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: solid.version }))
    .toMatchObject({ ok: true, data: { view: { referenceVersion: solid.version, referenceFeatureIds: [] } } });
  await expectRenderedSolidCapture(page, await call(page, 'cad_capture_preview', { expectedVersion: solid.version }));
  await call(page, 'cad_set_viewport', { expectedVersion: solid.version, command: { kind: 'select-feature', featureId: 'loft' } });
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: solid.version }))
    .toMatchObject({ ok: true, data: { view: { referenceVersion: solid.version, referenceFeatureIds: ['lower', 'upper'] } } });
  expect(await call(page, 'cad_capture_preview', { expectedVersion: solid.version }))
    .toMatchObject({ viewState: { selectedFeatureId: 'loft', view: { referenceFeatureIds: ['lower', 'upper'] } } });
  await call(page, 'cad_set_viewport', { expectedVersion: solid.version, command: { kind: 'select-feature', featureId: 'upper' } });
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: solid.version }))
    .toMatchObject({ ok: true, data: { view: { referenceFeatureIds: ['upper'] } } });
  expect(await context(page)).toMatchObject({ version: solid.version, featureCount: 3, workflowOpen: false });
});

test('human datum creation, placement reuse and history share atomic pending-edit guards', async ({ page }) => {
  const wasmRequests: string[] = [];
  page.context().on('request', request => { if (/\.wasm(?:\?|$)/.test(request.url())) wasmRequests.push(request.url()); });
  await prepare(page);
  await call(page, 'cad_create_document', { expectedVersion: (await context(page)).version, name: 'Mounting references' });
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [{ kind: 'set-parameter', name: 'tilt', value: 30 }] });
  const before = await context(page);
  await page.getByRole('button', { name: 'Plane', exact: true }).click();
  const properties = page.getByRole('complementary', { name: 'Feature properties' });
  await properties.getByRole('textbox', { name: 'Origin X mm', exact: true }).fill('99');
  await properties.getByRole('textbox', { name: 'Origin X mm', exact: true }).fill('12');
  expect(await context(page)).toMatchObject({ version: before.version, featureCount: 0, workflowOpen: true });
  expect(await rawCall(page, 'cad_capture_preview', { expectedVersion: before.version })).toMatchObject({ ok: false, error: { code: 'WORKFLOW_OPEN' } });
  await properties.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await context(page)).toMatchObject({ version: before.version, featureCount: 0, workflowOpen: false });
  await page.getByRole('button', { name: 'Plane', exact: true }).click();
  await properties.getByRole('textbox', { name: 'Origin X mm', exact: true }).fill('12');
  await editScalarRelation(page, 'Around X', 'tilt');
  await properties.getByRole('button', { name: 'Apply', exact: true }).click();
  const accepted = await context(page);
  const rows = await call(page, 'cad_read_features', { expectedVersion: accepted.version });
  if (!Array.isArray(rows.items) || rows.items.length !== 1) throw new Error('Missing human datum');
  const datum = rows.items[0] as CadFeature;
  expect(datum).toMatchObject({ kind: 'datum-plane', name: 'Plane 1', definition: { kind: 'world', basePlane: 'XY', origin: [12, 0, 0], rotation: ['tilt', 0, 0] } });
  await openFeatureEditor(page, datum.id);
  await properties.getByRole('textbox', { name: 'Origin X mm', exact: true }).fill('24');
  expect(await rawCall(page, 'cad_inspect_plane', { expectedVersion: accepted.version, featureId: datum.id })).toMatchObject({ ok: false, error: { code: 'WORKFLOW_OPEN' } });
  await properties.getByRole('textbox', { name: 'Origin X mm', exact: true }).press('Escape');
  expect(await context(page)).toMatchObject({ version: accepted.version, workflowOpen: false });
  expect(await call(page, 'cad_inspect_plane', { expectedVersion: accepted.version, featureId: datum.id })).toMatchObject({ frame: { origin: [12, 0, 0] } });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect(await context(page)).toMatchObject({ featureCount: 0, workflowOpen: false });
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  const redone = await context(page);
  expect(await call(page, 'cad_get_feature', { expectedVersion: redone.version, featureId: datum.id })).toMatchObject({ feature: datum });
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: redone.version })).toMatchObject({ ok: true, data: { view: { available: true, referenceVersion: redone.version } } });
  await call(page, 'cad_set_viewport', { expectedVersion: redone.version, command: { kind: 'select-feature', featureId: datum.id } });
  await page.getByRole('button', { name: 'Sketch', exact: true }).click();
  await expect(page.getByLabel('Sketch drawing canvas')).toBeVisible();
  expect(await context(page)).toMatchObject({ featureCount: 2, workflowOpen: false });
  const sketched = await context(page); const history = await call(page, 'cad_read_features', { expectedVersion: sketched.version });
  if (!Array.isArray(history.items)) throw new Error('Missing sketch history');
  const sketch = history.items.at(-1) as CadSketchFeature;
  expect(sketch).toMatchObject({ kind: 'sketch', plane: { kind: 'datum-plane', featureId: datum.id }, offset: 0, profiles: [] });
  await expect(properties.getByRole('combobox', { name: 'Reference plane', exact: true })).toHaveValue(`datum:${datum.id}`);
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: sketched.version })).toMatchObject({ ok: true, data: { view: { mode: 'sketch', plane: sketch.plane } } });
  await page.screenshot({ path: 'tmp/cad-datum-sketch-editor.png' });
  expect(wasmRequests).toEqual([]);
});

test('agent datum placement stays exact through reference capture, parametric solids, STEP and local CAM handoff', async ({ page }) => {
  const wasmRequests: string[] = []; const errors: string[] = [];
  page.context().on('request', request => { if (/\.wasm(?:\?|$)/.test(request.url())) wasmRequests.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  await prepare(page);
  await call(page, 'cad_create_document', { expectedVersion: (await context(page)).version, name: 'Tilted mounting plate' });
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [
    { kind: 'set-parameter', name: 'tilt', value: 30 },
    { kind: 'add-feature', feature: { id: 'mount', name: 'Mounting plane', kind: 'datum-plane', suppressed: false,
      definition: { kind: 'world', basePlane: 'XY', origin: [30, -20, 12], rotation: ['tilt', 0, 15] } } },
  ] });
  const plane = await context(page);
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: plane.version }))
    .toMatchObject({ ok: true, data: { buildState: 'idle', buildVersion: null, visibleBodyIds: [],
      view: { available: true, referenceVersion: plane.version, referenceFeatureIds: ['mount'] } } });
  await call(page, 'cad_set_viewport', { expectedVersion: plane.version, command: { kind: 'set-grid', visible: false } });
  await call(page, 'cad_set_viewport', { expectedVersion: plane.version, command: { kind: 'fit' } });
  const planeCapture = await call(page, 'cad_capture_preview', { expectedVersion: plane.version });
  expect(planeCapture).toMatchObject({ source: '3d', viewState: { buildVersion: null, view: { referenceFeatureIds: ['mount'] } } });
  if (typeof planeCapture.previewUrl !== 'string') throw new Error('Missing datum capture');
  const visiblePixels = await page.evaluate(async url => {
    const image = new Image(); image.src = url; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); if (!context) throw new Error('Missing pixels'); context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let visible = 0; for (let i = 0; i < data.length; i += 4) if (Math.max(data[i], data[i + 1], data[i + 2]) > 100 && data[i + 3] > 0) visible++;
    return visible;
  }, planeCapture.previewUrl);
  expect(visiblePixels, 'A plane-only draft needs a visible datum glyph').toBeGreaterThan(150);
  const placement = { kind: 'datum-plane', featureId: 'mount' };
  await call(page, 'cad_edit_document', { expectedVersion: plane.version, edits: [
    { kind: 'add-feature', feature: generatedSketch({ id: 'profile', name: 'Mounting profile', kind: 'sketch', suppressed: false, plane: placement, offset: 2,
      profiles: [{ id: 'plate', name: 'Plate', construction: false, geometry: { kind: 'rectangle', x: -10, y: -5, width: 20, height: 10, cornerRadius: 0 } },
        { id: 'hole', name: 'Hole', construction: false, geometry: { kind: 'circle', x: 0, y: 0, radius: 2 } }] }) },
    { kind: 'add-feature', feature: { id: 'rail', name: 'Datum guide', kind: 'curve', suppressed: false, plane: placement, offset: 2,
      segments: [{ kind: 'line', start: [0, 0], end: [20, 0] }] } },
  ] });
  const references = await context(page);
  const expectedOrigin = [30 + Math.sin(Math.PI / 12), -20 - Math.cos(Math.PI / 12), 12 + Math.sqrt(3)];
  expect(await call(page, 'cad_inspect_plane', { expectedVersion: references.version, featureId: 'profile' })).toMatchObject({
    featureKind: 'sketch', plane: placement, datumId: 'mount', offsetMm: 2, frame: { origin: [30, -20, 12] },
    placedOriginMm: expectedOrigin.map(value => expect.closeTo(value, 10)), persisted: false });
  expect(await call(page, 'cad_measure_curve', { expectedVersion: references.version, curveId: 'rail' })).toMatchObject({
    lengthMm: 20, startWorldMm: expectedOrigin.map(value => expect.closeTo(value, 10)) });
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: references.version }))
    .toMatchObject({ ok: true, data: { view: { referenceVersion: references.version } } });
  await call(page, 'cad_set_viewport', { expectedVersion: references.version, command: { kind: 'edit-sketch', sketchId: 'profile' } });
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: references.version }))
    .toMatchObject({ ok: true, data: { view: { mode: 'sketch', available: true, plane: placement } } });
  expect(await call(page, 'cad_capture_preview', { expectedVersion: references.version })).toMatchObject({ source: '2d', sketchId: 'profile', viewState: { view: { plane: placement } } });
  await call(page, 'cad_set_viewport', { expectedVersion: references.version, command: { kind: 'finish-sketch' } });
  expect(wasmRequests, 'Datum-only references, local editing, inspection and capture must not initialize WASM').toEqual([]);
  await call(page, 'cad_edit_document', { expectedVersion: references.version, edits: [{ kind: 'add-feature', feature: {
    id: 'pad', name: 'Mounting plate', kind: 'extrude', suppressed: false, sketchId: 'profile', distance: 5, symmetric: false, operation: 'new', targetId: null,
  } }] });
  const padded = await context(page); const volume = (200 - 4 * Math.PI) * 5;
  expect(await call(page, 'cad_build', { expectedVersion: padded.version })).toMatchObject({ diagnostics: [], bodies: [{ featureId: 'pad', volumeMm3: expect.closeTo(volume, 6) }] });
  expect(await rawCall(page, 'cad_edit_document', { expectedVersion: padded.version, edits: [{ kind: 'add-feature', feature: {
    id: 'unsupported_pocket', name: 'Through all', kind: 'pocket', suppressed: false, sketchId: 'profile', targetId: 'pad', extent: { kind: 'through-all', direction: 'both' },
  } }] })).toMatchObject({ ok: false, error: { code: 'unsupported-datum-operation' } });
  expect(await context(page)).toMatchObject({ version: padded.version, featureCount: 4 });
  await call(page, 'cad_edit_document', { expectedVersion: padded.version, edits: [{ kind: 'set-parameter', name: 'tilt', value: 60 }] });
  const tilted = await context(page);
  expect(await call(page, 'cad_build', { expectedVersion: tilted.version })).toMatchObject({ diagnostics: [], bodies: [{ volumeMm3: expect.closeTo(volume, 6) }] });
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: tilted.version }))
    .toMatchObject({ ok: true, data: { buildVersion: tilted.version, view: { available: true, referenceVersion: tilted.version } } });
  await call(page, 'cad_set_viewport', { expectedVersion: tilted.version, command: { kind: 'set-view', view: 'Isometric' } });
  await call(page, 'cad_set_viewport', { expectedVersion: tilted.version, command: { kind: 'fit' } });
  await expectRenderedSolidCapture(page, await call(page, 'cad_capture_preview', { expectedVersion: tilted.version }));
  await page.screenshot({ path: 'tmp/cad-datum-mounting-plate.png' });
  const downloaded = page.waitForEvent('download');
  await call(page, 'cad_export_solid', { expectedVersion: tilted.version, format: 'step' });
  const download = await downloaded; const path = await download.path();
  if (!path) throw new Error('Missing tilted STEP export');
  expect(await readFile(path, 'utf8')).toContain('MANIFOLD_SOLID_BREP');
  expect(await call(page, 'cad_send_to_cam', { expectedVersion: tilted.version, sketchId: 'profile' }))
    .toMatchObject({ opened: true, sourceDocumentId: tilted.documentId, sketchId: 'profile' });
  await expect(page.locator('[data-preview-model="upid"]')).toBeVisible();
  expect(await call(page, 'edm_get_context')).toMatchObject({ draft: { dirty: false, model: 'upid' } });
  expect(errors).toEqual([]);
});

test('the first solid fits after reference-only viewing while later rebuilds preserve the camera', async ({ page }) => {
  await prepare(page); const initial = await context(page);
  await call(page, 'cad_create_document', { expectedVersion: initial.version, name: 'Tall pin' });
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [
    { kind: 'set-parameter', name: 'height', value: 300 },
    { kind: 'add-feature', feature: generatedSketch({ id: 'section', name: 'Pin section', kind: 'sketch', plane: 'XY', offset: 0, suppressed: false,
      profiles: [{ id: 'circle', name: 'Circle', construction: false, geometry: { kind: 'circle', x: 0, y: 0, radius: 2 } }] }) }
  ] });
  const outlined = await context(page);
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: outlined.version }))
    .toMatchObject({ ok: true, data: { view: { available: true, referenceVersion: outlined.version, referenceFeatureIds: ['section'] } } });
  const before = await call(page, 'cad_get_viewport', { expectedVersion: outlined.version });
  const outlineZoom = (before.view as { zoom: number }).zoom;
  await call(page, 'cad_edit_document', { expectedVersion: outlined.version, edits: [{ kind: 'add-feature', feature: {
    id: 'pin', name: 'Pin', kind: 'extrude', suppressed: false, sketchId: 'section', distance: 'height', symmetric: false, operation: 'new', targetId: null
  } }] });
  const padded = await context(page);
  expect(await call(page, 'cad_build', { expectedVersion: padded.version })).toMatchObject({ diagnostics: [], bodies: [{ volumeMm3: expect.closeTo(1200 * Math.PI, 5) }] });
  await expect.poll(async () => {
    const result = await rawCall(page, 'cad_get_viewport', { expectedVersion: padded.version }) as { ok: boolean; data?: { view?: { zoom?: number } } };
    return result.ok && typeof result.data?.view?.zoom === 'number' ? result.data.view.zoom : outlineZoom;
  }).toBeLessThan(outlineZoom / 10);
  const capture = await captureCadPreview(page, padded.version);
  expect(capture).toMatchObject({ documentId: padded.documentId, draftVersion: padded.version, contentSource: 'cad-draft', source: '3d',
    viewState: { documentVersion: padded.version, buildVersion: padded.version } });
  await expectRenderedSolidCapture(page, capture);
  await page.screenshot({ path: 'tmp/cad-first-solid-fit.png' });
  const framed = await call(page, 'cad_get_viewport', { expectedVersion: padded.version });
  await call(page, 'cad_edit_document', { expectedVersion: padded.version, edits: [{ kind: 'set-parameter', name: 'height', value: 600 }] });
  const longer = await context(page);
  await call(page, 'cad_build', { expectedVersion: longer.version });
  expect((await call(page, 'cad_get_viewport', { expectedVersion: longer.version })).view).toMatchObject({ zoom: (framed.view as { zoom: number }).zoom });
});

test('far-origin imported Sketch renders inside free pixels and keeps its view across geometry edits', async ({ page }) => {
  await prepare(page); const initial = await context(page);
  const text = '0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nCIRCLE\n8\n0\n10\n100000000\n20\n100000000\n40\n12\n0\nENDSEC\n0\nEOF\n';
  const imported = await call(page, 'cad_import_dxf', { expectedVersion: initial.version, source: { format: 'dxf', fileName: 'far-circle.dxf', text } });
  if (typeof imported.sketchId !== 'string') throw new Error('Missing imported Sketch ID');
  const accepted = await context(page);
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: accepted.version }))
    .toMatchObject({ ok: true, data: { view: { referenceVersion: accepted.version, referenceFeatureIds: [imported.sketchId] } } });
  await call(page, 'cad_set_viewport', { expectedVersion: accepted.version, command: { kind: 'edit-sketch', sketchId: imported.sketchId } });
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: accepted.version }))
    .toMatchObject({ ok: true, data: { view: { mode: 'sketch', available: true } } });
  const canvas = page.getByLabel('Sketch drawing canvas');
  // The contour's circle is the member `c0` of its generator `contour-1`; its halo copy lies in a group of its own.
  const circle = canvas.locator('[data-cad-sketch-entity="contour-1_c0"] > circle');
  const assertFittedCircle = async () => {
    const visible = await circle.boundingBox(), viewport = await canvas.boundingBox();
    if (!visible || !viewport) throw new Error('Missing rendered far-origin circle');
    expect(visible.width, 'R12 circle must have substantial visible pixels at 1e8 mm').toBeGreaterThan(200);
    expect(visible.height).toBeCloseTo(visible.width, 3);
    expect(visible.x).toBeGreaterThanOrEqual(viewport.x); expect(visible.x + visible.width).toBeLessThanOrEqual(viewport.x + viewport.width);
    expect(visible.y).toBeGreaterThanOrEqual(viewport.y); expect(visible.y + visible.height).toBeLessThanOrEqual(viewport.y + viewport.height);
    for (const overlay of await page.locator('[data-cad-properties], [data-cad-model-tree], [data-cad-command-dock]').all()) {
      if (!await overlay.isVisible()) continue;
      const occlusion = await overlay.boundingBox(); if (!occlusion || !occlusion.width || !occlusion.height) continue;
      const overlap = Math.min(visible.x + visible.width, occlusion.x + occlusion.width) > Math.max(visible.x, occlusion.x)
        && Math.min(visible.y + visible.height, occlusion.y + occlusion.height) > Math.max(visible.y, occlusion.y);
      expect(overlap, 'Fit must keep the whole contour clear of floating controls').toBe(false);
    }
    const capture = await call(page, 'cad_capture_preview', { expectedVersion: (await context(page)).version });
    expect(capture).toMatchObject({ source: '2d', sketchId: imported.sketchId });
    if (typeof capture.previewUrl !== 'string') throw new Error('Missing rendered Sketch capture');
    const pixels = await page.evaluate(async url => {
      const image = new Image(); image.src = url; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d'); if (!context) throw new Error('Missing Sketch pixels'); context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data; let count = 0;
      // The fully defined contour is stroked in the defined-geometry green, #5ed88a.
      for (let index = 0; index < data.length; index += 4) if (data[index + 1] > 160 && data[index + 1] - data[index] > 60 && data[index + 2] > 90 && data[index + 3] > 0) count++;
      return count;
    }, capture.previewUrl);
    expect(pixels, 'Actual rasterized far-origin circle outline must be present').toBeGreaterThan(400);
  };
  await assertFittedCircle();
  // Selecting the sketch expands its tree branch after initial layout. Keep
  // the initial-fit pixel check above, then establish a settled explicit Fit
  // and prove its real occlusions are identical for the translation comparison.
  await expect(page.getByRole('button', { name: 'Contour 1 profile', exact: true })).toBeVisible();
  await call(page, 'cad_set_viewport', { expectedVersion: accepted.version, command: { kind: 'fit' } });
  const fitLayout = () => page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('.cad-sketch-viewport'); if (!viewport) throw new Error('Missing visible Sketch');
    return {
      viewport: viewport.getBoundingClientRect().toJSON(),
      width: viewport.clientWidth, height: viewport.clientHeight,
      overlays: [...document.querySelectorAll<HTMLElement>('[data-cad-properties], [data-cad-model-tree], [data-cad-command-dock]')]
        .filter(overlay => !overlay.hidden).map(overlay => overlay.getBoundingClientRect().toJSON()),
    };
  });
  const initialLayout = await fitLayout();
  const framed = await call(page, 'cad_get_viewport', { expectedVersion: accepted.version });
  const view = framed.view;
  if (!view || typeof view !== 'object' || !('centerMm' in view) || !Array.isArray(view.centerMm)
    || view.centerMm.length !== 2 || !view.centerMm.every((value: unknown) => typeof value === 'number' && Number.isFinite(value))
    || !('heightSpanMm' in view) || typeof view.heightSpanMm !== 'number') throw new Error('Missing exact public Sketch frame');
  const initialFrame = { centerMm: [...view.centerMm], heightSpanMm: view.heightSpanMm };
  const feature = await call(page, 'cad_get_feature', { expectedVersion: accepted.version, featureId: imported.sketchId });
  const sketch = feature.feature as CadSketchFeature;
  expect(sketch).toMatchObject({ kind: 'sketch', source: { text } });
  // Reposition the exact imported contour, a circle generator stored alone, by a parameter-independent plane-local transform
  // of its inputs. The existing canvas keeps the user's frame.
  expect(sketch.profiles).toEqual([]);
  const contour = sketch.graph?.relations[0];
  if (contour?.kind !== 'generator' || contour.geometry.kind !== 'circle') throw new Error('Expected an exact imported circle generator');
  expect(contour.geometry).toEqual({ kind: 'circle', x: 100000000, y: 100000000, radius: 12 });
  await call(page, 'cad_edit_document', { expectedVersion: accepted.version, edits: [{ kind: 'set-sketch-generator', sketchId: imported.sketchId,
    generator: { ...contour, geometry: { ...contour.geometry, x: 100000100 } } }] });
  const changed = await context(page);
  expect(await call(page, 'cad_get_viewport', { expectedVersion: changed.version }))
    .toMatchObject({ view: { mode: 'sketch', ...initialFrame } });
  expect(await call(page, 'cad_get_feature', { expectedVersion: changed.version, featureId: imported.sketchId }))
    .toMatchObject({ feature: { source: { text }, profiles: [], graph: { relations: [{ id: contour.id, geometry: { kind: 'circle', x: 100000100, y: 100000000, radius: 12 } }] } } });
  expect(await fitLayout(), 'Exact translation of Fit requires unchanged viewport and floating-control bounds').toEqual(initialLayout);
  await call(page, 'cad_set_viewport', { expectedVersion: changed.version, command: { kind: 'fit' } });
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: changed.version }))
    .toMatchObject({ ok: true, data: { view: { centerMm: [initialFrame.centerMm[0] + 100, initialFrame.centerMm[1]], heightSpanMm: initialFrame.heightSpanMm } } });
  await assertFittedCircle();
  expect(await context(page)).toMatchObject({ version: changed.version });
});

test('small exact reference arcs remain visible far from the world origin', async ({ page }) => {
  await prepare(page); const initial = await context(page);
  await call(page, 'cad_create_document', { expectedVersion: initial.version, name: 'Far reference' });
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [
    { kind: 'add-feature', feature: { id: 'far', name: 'Far arc', kind: 'curve', plane: 'XY', offset: 0, suppressed: false,
      segments: [{ kind: 'arc', center: [100000000, 100000000], radius: 1, startAngle: 0, sweep: 180 }] } }
  ] });
  const accepted = await context(page);
  await expect.poll(async () => rawCall(page, 'cad_get_viewport', { expectedVersion: accepted.version })).toMatchObject({ ok: true, data: { view: { available: true, referenceVersion: accepted.version } } });
  await call(page, 'cad_set_viewport', { expectedVersion: accepted.version, command: { kind: 'set-view', view: 'Top' } });
  await call(page, 'cad_set_viewport', { expectedVersion: accepted.version, command: { kind: 'fit' } });
  const capture = await call(page, 'cad_capture_preview', { expectedVersion: accepted.version });
  if (typeof capture.previewUrl !== 'string') throw new Error('Missing far-origin preview');
  const pixels = await page.evaluate(async url => {
    const image = new Image(); image.src = url; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); if (!context) throw new Error('Missing pixels'); context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data; let count = 0;
    for (let index = 0; index < data.length; index += 4) if (data[index] > 100 && data[index + 1] > 140 && data[index + 2] > 140 && data[index + 3] > 0) count++;
    return count;
  }, capture.previewUrl);
  expect(pixels, 'R1 reference arc must not collapse when uploaded to Float32 graphics buffers').toBeGreaterThan(80);
});

test('small far-origin solids retain rendered faces, edges and physical topology picking', async ({ page }) => {
  await prepare(page); const initial = await context(page);
  await call(page, 'cad_create_document', { expectedVersion: initial.version, name: 'Far precision block' });
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [
    { kind: 'add-feature', feature: generatedSketch({ id: 'section', name: 'Square', kind: 'sketch', plane: 'XY', offset: 0, suppressed: false,
      profiles: [{ id: 'square', name: 'Square', construction: false, geometry: { kind: 'rectangle', x: -1, y: -1, width: 2, height: 2, cornerRadius: 0 } }] }) },
    { kind: 'add-feature', feature: { id: 'pad', name: 'Block', kind: 'extrude', suppressed: false, sketchId: 'section', distance: 2, symmetric: false, operation: 'new', targetId: null } },
    { kind: 'add-feature', feature: { id: 'far', name: 'Far block', kind: 'transform', suppressed: false, sourceId: 'pad', translation: [100000000, 100000000, 100000000], rotation: [0, 0, 0] } },
  ] });
  const accepted = await context(page);
  expect(await call(page, 'cad_build', { expectedVersion: accepted.version })).toMatchObject({ diagnostics: [], bodies: [{ featureId: 'far', volumeMm3: expect.closeTo(8, 6) }] });
  await call(page, 'cad_set_viewport', { expectedVersion: accepted.version, command: { kind: 'select-feature', featureId: null } });
  await call(page, 'cad_set_viewport', { expectedVersion: accepted.version, command: { kind: 'set-view', view: 'Top' } });
  await call(page, 'cad_set_viewport', { expectedVersion: accepted.version, command: { kind: 'fit' } });
  await call(page, 'cad_set_viewport', { expectedVersion: accepted.version, command: { kind: 'set-grid', visible: false } });
  await expect(page.getByLabel('Named view')).toHaveValue('Top');
  await expectRenderedSolidCapture(page, await call(page, 'cad_capture_preview', { expectedVersion: accepted.version }));
  // Keep the same selected-body colour in both images so the pixel difference
  // measures the translucent face highlight, not a change in body selection.
  await call(page, 'cad_set_viewport', { expectedVersion: accepted.version, command: { kind: 'select-feature', featureId: 'far' } });
  await call(page, 'cad_set_viewport', { expectedVersion: accepted.version, command: { kind: 'set-pick-mode', mode: 'face' } });
  const beforeFace = await call(page, 'cad_capture_preview', { expectedVersion: accepted.version });
  const canvas = page.locator('.cad-viewport canvas');
  const bounds = await canvas.boundingBox(); if (!bounds) throw new Error('Missing solid canvas');
  if (typeof beforeFace.previewUrl !== 'string') throw new Error('Missing unhighlighted body capture');
  // Fit reserves space for the floating tree and inspector. Locate this single
  // fitted body in its actual pixels instead of assuming the canvas centre or
  // reproducing the renderer's private camera extent/projection.
  const renderedBody = await page.evaluate(async url => {
    const image = new Image(); image.src = url; await image.decode();
    const pixels = document.createElement('canvas'); pixels.width = image.width; pixels.height = image.height;
    const context = pixels.getContext('2d'); if (!context) throw new Error('Missing body pixels');
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, pixels.width, pixels.height).data;
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (let y = 0; y < pixels.height; y++) for (let x = 0; x < pixels.width; x++) {
      const offset = 4 * (y * pixels.width + x);
      if (data[offset + 3] > 0 && data[offset] + data[offset + 1] + data[offset + 2] > 300) {
        left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
    }
    if (!Number.isFinite(left) || !Number.isFinite(top)) throw new Error('Fitted far-origin body is not rendered');
    return { left, top, right, bottom, width: image.width, height: image.height };
  }, beforeFace.previewUrl);
  expect(renderedBody.right - renderedBody.left, 'The 2 mm face must retain its rendered width at 1e8 mm').toBeGreaterThan(20);
  expect(renderedBody.bottom - renderedBody.top, 'The 2 mm face must retain its rendered height at 1e8 mm').toBeGreaterThan(20);
  const facePoint = {
    x: (renderedBody.left + renderedBody.right + 1) / 2 / renderedBody.width * bounds.width,
    y: (renderedBody.top + renderedBody.bottom + 1) / 2 / renderedBody.height * bounds.height,
  };
  await canvas.click({ position: facePoint });
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: accepted.version }))
    .toMatchObject({ ok: true, data: { topologySelection: { bodyId: 'far', picks: [{ kind: 'face' }] } } });
  const highlighted = await call(page, 'cad_capture_preview', { expectedVersion: accepted.version });
  await expectRenderedSolidCapture(page, highlighted);
  if (typeof highlighted.previewUrl !== 'string' || typeof beforeFace.previewUrl !== 'string') throw new Error('Missing face capture');
  const faceHighlightPixels = await page.evaluate(async urls => {
    const pixels = async (url: string) => {
      const image = new Image(); image.src = url; await image.decode(); const canvas = document.createElement('canvas');
      canvas.width = image.width; canvas.height = image.height; const context = canvas.getContext('2d'); if (!context) throw new Error('Missing pixels');
      context.drawImage(image, 0, 0); return context.getImageData(0, 0, canvas.width, canvas.height).data;
    };
    const [before, after] = await Promise.all(urls.map(pixels));
    let count = 0; for (let i = 0; i < after.length; i += 4) if (after[i] > before[i] + 12 && after[i + 2] < before[i + 2] - 2 && after[i + 3] > 0) count++;
    return count;
  }, [beforeFace.previewUrl, highlighted.previewUrl]);
  expect(faceHighlightPixels, 'The selected native face highlight must not collapse at 1e8 mm').toBeGreaterThan(100);
  await page.screenshot({ path: 'tmp/cad-far-origin-face.png' });
  await call(page, 'cad_set_viewport', { expectedVersion: accepted.version, command: { kind: 'set-pick-mode', mode: 'edge' } });
  await canvas.click({ position: { x: (renderedBody.right + .5) / renderedBody.width * bounds.width, y: facePoint.y } });
  await expect.poll(() => rawCall(page, 'cad_get_viewport', { expectedVersion: accepted.version }))
    .toMatchObject({ ok: true, data: { topologySelection: { bodyId: 'far', picks: [{ kind: 'edge' }] } } });
  const edgeCapture = await call(page, 'cad_capture_preview', { expectedVersion: accepted.version });
  await expectRenderedSolidCapture(page, edgeCapture);
  expect(await context(page)).toMatchObject({ version: accepted.version });
});

test('a missing CAD view module retains the accepted draft and live agent tools for save and download recovery', async ({ page }) => {
  const modulePattern = '**/assets/CadWorkbench-*.js';
  await page.route(modulePattern, route => route.abort('failed'));
  await prepare(page); const initial = await context(page);
  await call(page, 'cad_create_document', { expectedVersion: initial.version, name: 'Recovered rail' });
  const feature = { id: 'rail', name: 'Preserved rail', kind: 'curve', suppressed: false, plane: 'XY', offset: 0,
    segments: [{ kind: 'line', start: [0, 0], end: [25, 0] }] };
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [{ kind: 'add-feature', feature }] });
  await expect(page.getByRole('alert')).toHaveText('The CAD workspace could not be displayed.');
  const retained = await context(page); expect(retained).toMatchObject({ featureCount: 1, dirty: true, workflowOpen: false });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CAD document', exact: true }).click();
  const path = await (await downloadPromise).path(); if (!path) throw new Error('Missing recovered JSON');
  expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ id: retained.documentId, features: [feature] });
  await page.getByRole('button', { name: 'Save current document', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Document saved.' })).toBeVisible();
  expect(await context(page)).toMatchObject({ version: retained.version, dirty: false, savedVersion: expect.any(String) });
  await page.unroute(modulePattern); await page.reload();
  await expectSavedCadReopened(page, retained.documentId);
  await call(page, 'cad_open_document', { expectedVersion: (await context(page)).version, documentId: retained.documentId });
  await expect(page.getByLabel('3D model viewport')).toBeVisible();
  expect(await call(page, 'cad_get_feature', { expectedVersion: (await context(page)).version, featureId: feature.id })).toMatchObject({ feature });
});

test('a missing import dialog cancels its workflow and preserves the saved CAD document', async ({ page }) => {
  await page.route('**/assets/CadImportDialog-*.js', route => route.abort('failed'));
  const { draft } = await createBox(page);
  await call(page, 'cad_save_document', { expectedVersion: draft.version });
  await page.locator('.cad-header input[type=file]').setInputFiles({ name: 'Pending.dxf', mimeType: 'application/dxf', buffer: Buffer.from('0\nEOF\n') });
  await expect(page.getByRole('alert')).toHaveText('The CAD workspace could not be displayed.');
  expect(await context(page)).toMatchObject({ version: draft.version, documentId: draft.documentId, dirty: false, workflowOpen: false, featureCount: 2 });
  await page.getByRole('button', { name: 'Save current document', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Document saved.' })).toBeVisible();
});

test('human Curve creation keeps name, plane and geometry atomic and uses the explicit DXF import choice', async ({ page }) => {
  await prepare(page); await page.getByRole('button', { name: 'Design in CAD' }).click();
  const blank = await context(page);
  await page.getByRole('button', { name: 'Curve', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Cancelled rail');
  const canvas = page.getByLabel('Curve drawing canvas');
  await canvas.focus(); await canvas.press('Space'); await canvas.press('ArrowRight'); await canvas.press('Space');
  expect(await context(page)).toMatchObject({ version: blank.version, featureCount: 0, workflowOpen: true });
  await canvas.press('Escape');
  expect(await context(page)).toMatchObject({ version: blank.version, featureCount: 0, workflowOpen: false });
  await page.getByRole('button', { name: 'Curve', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Mounting rail');
  await page.getByRole('combobox', { name: 'Reference plane', exact: true }).selectOption('YZ');
  await page.getByRole('textbox', { name: 'Plane offset mm', exact: true }).fill('5');
  await canvas.focus(); await canvas.press('Space');
  for (let index = 0; index < 4; index++) await canvas.press('ArrowRight');
  await canvas.press('Space');
  await page.getByRole('button', { name: '3-point Arc', exact: true }).click(); await canvas.focus();
  for (let index = 0; index < 4; index++) await canvas.press('ArrowUp');
  await canvas.press('Space'); await canvas.press('ArrowRight'); await canvas.press('ArrowRight');
  await canvas.press('ArrowDown'); await canvas.press('ArrowDown'); await canvas.press('Space');
  expect(await rawCall(page, 'cad_edit_document', { expectedVersion: blank.version, edits: [{ kind: 'rename-document', name: 'Interrupted' }] })).toMatchObject({ ok: false, error: { code: 'WORKFLOW_OPEN' } });
  await page.getByRole('button', { name: 'Finish curve', exact: true }).click();
  const accepted = await context(page); expect(accepted).toMatchObject({ featureCount: 1, workflowOpen: false });
  const features = await call(page, 'cad_read_features', { expectedVersion: accepted.version });
  if (!Array.isArray(features.items)) throw new Error('Missing Curve'); const curve = features.items[0] as CadFeature;
  expect(curve).toMatchObject({ name: 'Mounting rail', kind: 'curve', plane: 'YZ', offset: '5', segments: [{ kind: 'line', start: [0, 0], end: [20, 0] }, { kind: 'arc', radius: 10, sweep: 180 }] });
  expect(await call(page, 'cad_measure_curve', { expectedVersion: accepted.version, curveId: curve.id }))
    .toMatchObject({ plane: 'YZ', offsetMm: 5, startWorldMm: [5, 0, 0], endWorldMm: [5, 20, 20], lengthMm: expect.closeTo(20 + 10 * Math.PI, 8) });
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); expect(await context(page)).toMatchObject({ featureCount: 0 });
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); const redone = await context(page);
  expect((await call(page, 'cad_get_feature', { expectedVersion: redone.version, featureId: curve.id })).feature).toEqual(curve);
  await call(page, 'cad_save_document', { expectedVersion: redone.version });
  const downloadPromise = page.waitForEvent('download'); await call(page, 'cad_export_curve_dxf', { expectedVersion: redone.version, curveId: curve.id });
  const path = await (await downloadPromise).path(); if (!path) throw new Error('Missing Curve download');
  const bytes = await readFile(path);
  await page.locator('.cad-header input[type=file]').setInputFiles({ name: 'Mounting rail.dxf', mimeType: 'application/dxf', buffer: bytes });
  const dialog = page.getByRole('dialog', { name: 'Import CAD file' });
  await dialog.getByLabel('Import as').selectOption('curve'); await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  // This is the first kernel-worker request on the page, so the import includes a cold worker start.
  await expect(dialog).not.toBeVisible({ timeout: 60_000 });
  const imported = await context(page); const importedFeatures = await call(page, 'cad_read_features', { expectedVersion: imported.version });
  expect(importedFeatures).toMatchObject({ items: [{ kind: 'curve', source: { text: bytes.toString('utf8') } }] });
});

test('human mixed polyline drawing retains invalid points and commits one exact undo step', async ({ page }) => {
  await prepare(page);
  await page.getByRole('button', { name: 'Design in CAD' }).click();
  await createSketchOnCanvasPlane(page);
  const blank = await context(page);
  const blankFeatures = await call(page, 'cad_read_features', { expectedVersion: blank.version });
  await page.getByRole('button', { name: 'Line', exact: true }).click();
  await page.getByRole('button', { name: '3-point Arc', exact: true }).click();
  const canvas = page.getByLabel('Sketch drawing canvas');
  await canvas.focus(); await canvas.press('Space');
  for (let index = 0; index < 4; index++) await canvas.press('ArrowUp');
  await canvas.press('Space');
  expect(await context(page)).toMatchObject({ workflowOpen: true, version: blank.version });
  expect(await call(page, 'cad_read_features', { expectedVersion: blank.version })).toMatchObject({ items: [{ profiles: [] }] });
  expect(await rawCall(page, 'cad_edit_document', { expectedVersion: blank.version,
    edits: [{ kind: 'rename-document', name: 'Interrupted path' }] }))
    .toMatchObject({ ok: false, error: { code: 'WORKFLOW_OPEN' } });
  // The endpoint cannot also be its arc's through point; the draft must survive.
  await canvas.press('Space');
  expect(await context(page)).toMatchObject({ workflowOpen: true, version: blank.version });
  await canvas.press('ArrowRight'); await canvas.press('ArrowRight');
  await canvas.press('ArrowDown'); await canvas.press('ArrowDown'); await canvas.press('Space');
  await page.getByRole('button', { name: 'Close profile', exact: true }).click();
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false, featureCount: 1 });
  let current = await context(page);
  expect(current.version).not.toBe(blank.version);
  const features = await call(page, 'cad_read_features', { expectedVersion: current.version });
  if (!('items' in features) || !Array.isArray(features.items)) throw new Error('Missing sketch');
  const sketch = features.items[0] as CadSketchFeature;
  expect(sketch.profiles).toEqual([]);
  const graph = sketch.graph;
  if (!graph) throw new Error('Missing authored path graph');
  expect(graph.points).toHaveLength(3); expect(graph.entities).toHaveLength(2); expect(graph.relations).toEqual([]);
  const [arc, closingLine] = graph.entities;
  if (arc.kind !== 'arc' || closingLine.kind !== 'line') throw new Error('Expected one arc and its closing line');
  expect(arc).toMatchObject({ construction: false, direction: 'ccw' });
  expect(graph.points.find(point => point.id === arc.startPointId)?.position).toEqual([0, 0]);
  expect(graph.points.find(point => point.id === arc.endPointId)?.position).toEqual([0, 20]);
  expect(graph.points.find(point => point.id === arc.centerPointId)?.position).toEqual([0, 10]);
  // These exact supports and CCW direction retain the authored R10, 180-degree semicircle.
  expect(closingLine).toMatchObject({ construction: false, startPointId: arc.endPointId, endPointId: arc.startPointId });
  expect(await call(page, 'cad_measure_sketch', { expectedVersion: current.version, sketchId: sketch.id }))
    .toMatchObject({ materialAreaMm2: expect.closeTo(50 * Math.PI, 8), boundaryLengthMm: expect.closeTo(10 * Math.PI + 20, 8),
      boundsMm: { minX: 0, minY: 0, maxX: expect.closeTo(10, 8), maxY: 20 } });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => (await context(page)).version).not.toBe(current.version);
  current = await context(page);
  expect((await call(page, 'cad_read_features', { expectedVersion: current.version })).items).toEqual(blankFeatures.items);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect.poll(async () => (await context(page)).version).not.toBe(current.version);
  current = await context(page);
  expect((await call(page, 'cad_get_feature', { expectedVersion: current.version, featureId: sketch.id })).feature).toEqual(sketch);
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  await page.getByRole('button', { name: 'Pad / Pocket', exact: true }).click();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(async () => (await context(page)).version).not.toBe(current.version);
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false });
  current = await context(page);
  expect(await call(page, 'cad_build', { expectedVersion: current.version }))
    .toMatchObject({ diagnostics: [], bodies: [{ volumeMm3: expect.closeTo(500 * Math.PI, 7) }] });
  await call(page, 'cad_set_viewport', { expectedVersion: current.version, command: { kind: 'fit' } });
  const capture = await captureCadPreview(page, current.version);
  expect(capture).toMatchObject({ documentId: current.documentId, draftVersion: current.version, contentSource: 'cad-draft', source: '3d',
    viewState: { documentVersion: current.version, buildVersion: current.version } });
  await expectRenderedSolidCapture(page, capture);
  await page.screenshot({ path: 'tmp/cad-drawn-path.png' });
});

test('human sketch drawing and dimensions share undo and active-workflow protection with agents', async ({ page }) => {
  await prepare(page);
  await page.getByRole('button', { name: 'Design in CAD' }).click();
  await createSketchOnCanvasPlane(page);
  await page.getByRole('button', { name: 'Rectangle', exact: true }).click();
  const canvas = page.getByLabel('Sketch drawing canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('No sketch canvas');
  await canvas.click({ position: { x: box.width * 0.35, y: box.height * 0.65 } });
  let current = await context(page);
  expect(current).toMatchObject({ workflowOpen: true });
  expect(await rawCall(page, 'cad_edit_document', { expectedVersion: current.version, edits: [{ kind: 'rename-document', name: 'Interrupt drawing' }] })).toMatchObject({ ok: false, error: { code: 'WORKFLOW_OPEN' } });
  await canvas.click({ position: { x: box.width * 0.6, y: box.height * 0.35 } });
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false });
  await expect.poll(async () => (await context(page)).version).not.toBe(current.version);
  const drawn = await context(page);
  const drawnFeatures = await call(page, 'cad_read_features', { expectedVersion: drawn.version });
  if (!Array.isArray(drawnFeatures.items)) throw new Error('Missing drawn sketch');
  const freeSketch = drawnFeatures.items[0] as CadSketchFeature;
  expect(freeSketch.profiles).toEqual([]);
  const graph = freeSketch.graph;
  if (!graph || graph.points.some(point => point.position.some(value => typeof value !== 'number'))) throw new Error('Expected a numeric authored rectangle graph');
  expect(graph.points).toHaveLength(4); expect(graph.entities).toHaveLength(4);
  expect(graph.relations.map(relation => relation.kind)).toEqual(['horizontal', 'vertical', 'horizontal', 'vertical']);
  const ys = graph.points.map(point => Number(point.position[1]));
  const freeHeight = Math.max(...ys) - Math.min(...ys);
  expect(freeHeight).toBeGreaterThan(0);
  const widthEdge = graph.entities.find(entity => entity.kind === 'line'
    && graph.points.find(point => point.id === entity.startPointId)?.position[1] === graph.points.find(point => point.id === entity.endPointId)?.position[1]);
  if (!widthEdge || widthEdge.kind !== 'line') throw new Error('Missing horizontal rectangle edge');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await canvas.locator(`[data-cad-sketch-entity="${widthEdge.id}"]`).focus();
  await canvas.locator(`[data-cad-sketch-entity="${widthEdge.id}"]`).press('Enter');
  await page.getByRole('button', { name: 'Dimension', exact: true }).click();
  // Dimension starts with the selected edge; picking it again places its length at the drawn size and selects it, and Enter opens its editor.
  await canvas.locator(`[data-cad-sketch-entity="${widthEdge.id}"]`).press('Enter');
  await expect(canvas.locator('[data-cad-sketch-dimension] [role="button"][aria-pressed="true"]')).toHaveCount(1);
  await expect.poll(async () => (await context(page)).version).not.toBe(drawn.version);
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false });
  const placed = await context(page);
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Length mm', exact: true }).fill('53');
  expect(await context(page)).toMatchObject({ version: placed.version, workflowOpen: true });
  expect(await rawCall(page, 'cad_edit_document', { expectedVersion: placed.version, edits: [{ kind: 'rename-document', name: 'Interrupt dimension' }] }))
    .toMatchObject({ ok: false, error: { code: 'WORKFLOW_OPEN' } });
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(async () => (await context(page)).version).not.toBe(placed.version);
  await expect.poll(() => context(page)).toMatchObject({ workflowOpen: false });
  current = await context(page);
  const features = await call(page, 'cad_read_features', { expectedVersion: current.version });
  if (!Array.isArray(features.items)) throw new Error('Missing dimensioned sketch');
  const dimensioned = features.items[0] as CadSketchFeature;
  if (!dimensioned.graph) throw new Error('Missing dimensioned rectangle graph');
  expect(dimensioned.graph.points.map(point => point.id)).toEqual(graph.points.map(point => point.id));
  expect(dimensioned.graph.entities).toEqual(graph.entities);
  expect(dimensioned.graph.relations.slice(0, 4)).toEqual(graph.relations);
  expect(dimensioned.graph.relations).toHaveLength(5);
  const width = dimensioned.graph.relations[4];
  expect(width).toMatchObject({ kind: 'distance', pointIds: [widthEdge.startPointId, widthEdge.endPointId], value: 53 });
  const xsAfter = dimensioned.graph.points.map(point => Number(point.position[0]));
  const ysAfter = dimensioned.graph.points.map(point => Number(point.position[1]));
  expect(Math.max(...xsAfter) - Math.min(...xsAfter)).toBeCloseTo(53, 8);
  expect(Math.max(...ysAfter) - Math.min(...ysAfter)).toBeCloseTo(freeHeight, 8);
  await expect(canvas.locator(`[data-cad-sketch-dimension="${width.id}"]`).getByRole('button', { name: /^Dimension distance / })).toBeVisible();
  // Placing the length and setting its value are one undo step each.
  for (const command of ['Undo', 'Undo']) {
    await page.getByRole('button', { name: command, exact: true }).click();
    await expect.poll(async () => (await context(page)).version).not.toBe(current.version); current = await context(page);
  }
  const undone = await call(page, 'cad_read_features', { expectedVersion: current.version });
  expect(undone.items).toEqual([freeSketch]);
  for (const command of ['Redo', 'Redo']) {
    await page.getByRole('button', { name: command, exact: true }).click();
    await expect.poll(async () => (await context(page)).version).not.toBe(current.version); current = await context(page);
  }
  expect((await call(page, 'cad_read_features', { expectedVersion: current.version })).items).toEqual(features.items);
  await page.getByRole('button', { name: 'Finish sketch', exact: true }).click();
  await page.getByRole('button', { name: 'Pad / Pocket', exact: true }).click();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect.poll(async () => (await context(page)).version).not.toBe(current.version);
  const padded = await context(page);
  await expect.poll(() => context(page), { timeout: 60_000 }).toMatchObject({ version: padded.version, buildState: 'ready', buildVersion: padded.version, diagnostics: [], workflowOpen: false });
  expect(await call(page, 'cad_build', { expectedVersion: padded.version })).toMatchObject({ diagnostics: [], bodies: [{ volumeMm3: expect.closeTo(53 * freeHeight * 10, 7) }] });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => context(page)).toMatchObject({ dirty: false, savedVersion: expect.any(String) });
});
