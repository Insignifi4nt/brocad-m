import type { Page, TestInfo } from '@playwright/test';
import { expect, test } from './fixtures/native-sketch-solver';
import { prepareCadTools, callCadTool as call, cadContext as context, generatedSketch } from './cad-tool-helpers';

const rectangle = (id: string, x: number, y: number, width: number, height: number, construction = false) =>
  ({ id, name: id, construction, geometry: { kind: 'rectangle', x, y, width, height, cornerRadius: 0 } });
// A plate from z 0 to 10 and a separate block from z 15 to 25. The open sketch lies on the plate's top face, z = 10, so the
// block stands wholly on the viewer's side of the sketch plane and the plate wholly behind it.
const features = [
  { id: 'base', name: 'Base', kind: 'sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [rectangle('plate', 0, 0, 60, 40)] },
  { id: 'pad', name: 'Pad', kind: 'extrude', suppressed: false, sketchId: 'base', distance: 10, symmetric: false, operation: 'new', targetId: null },
  { id: 'riser', name: 'Riser', kind: 'sketch', suppressed: false, plane: 'XY', offset: 15, profiles: [rectangle('block', 70, 10, 20, 20)] },
  { id: 'block', name: 'Block', kind: 'extrude', suppressed: false, sketchId: 'riser', distance: 10, symmetric: false, operation: 'new', targetId: null },
  { id: 'top', name: 'Top sketch', kind: 'sketch', suppressed: false, plane: 'XY', offset: 10, profiles: [
    rectangle('frame', -10, -10, 110, 60, true), { id: 'hole', name: 'Hole', construction: false, geometry: { kind: 'circle', x: 30, y: 20, radius: 4 } }] }
];
// Probes in sketch millimetres: inside each body, and the background beside them. Each is compared with the same pixels with the
// 3D background hidden, so the sketch grid and the background gradient drop out.
const PROBES = { plate: [12, 30], block: [80, 20], beside: [65, 20], above: [5, 45] } as const;
type Probe = keyof typeof PROBES;

const background = (page: Page) => page.locator('.cad-viewport.is-sketch-background .cad-webgl');
const framesDrawn = async (page: Page) => Number(await background(page).getAttribute('data-cad-frames-drawn'));
/** Waits until the view behind the sketch has drawn and stopped drawing. */
async function settled(page: Page) {
  let last = -1;
  await expect.poll(async () => { const now = await framesDrawn(page); const steady = now > 0 && now === last; last = now; return steady; }, { intervals: [250] }).toBe(true);
  return last;
}
async function project(page: Page, version: string, [x, y]: readonly [number, number]) {
  const view = (await call(page, 'cad_get_viewport', { expectedVersion: version })).view as { centerMm: [number, number] };
  return page.getByLabel('Sketch drawing canvas').evaluate((element, { x, y, center }) => {
    const matrix = (element as SVGSVGElement).getScreenCTM(); if (!matrix) throw new Error('Sketch projection unavailable.');
    const point = new DOMPoint(x - center[0], center[1] - y).matrixTransform(matrix); return { x: point.x, y: point.y };
  }, { x, y, center: view.centerMm });
}
/** The mean brightness of a 9 × 9 pixel patch at each probe, read from what the page shows: the sketch over the 3D view. */
async function brightness(page: Page, version: string, info: TestInfo, shot?: string): Promise<Record<Probe, number>> {
  const points = await Promise.all((Object.keys(PROBES) as Probe[]).map(async name => [name, await project(page, version, PROBES[name])] as const));
  const path = shot ? info.outputPath(`${shot}.png`) : undefined;
  const png = await page.screenshot(path ? { path } : {});
  if (path) await info.attach(shot!, { path, contentType: 'image/png' });
  const values = await page.evaluate(async ({ data, points }) => {
    const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d'); if (!context) throw new Error('Unable to read the page pixels.');
    context.drawImage(image, 0, 0);
    return points.map(([, { x, y }]) => {
      const { data } = context.getImageData(Math.round(x) - 4, Math.round(y) - 4, 9, 9); let sum = 0;
      for (let index = 0; index < data.length; index += 4) sum += 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
      return sum / (data.length / 4);
    });
  }, { data: png.toString('base64'), points });
  return Object.fromEntries(points.map(([name], index) => [name, values[index]])) as Record<Probe, number>;
}
async function choose(page: Page, mode: 'Normal' | 'Dimmed' | 'Hidden') {
  await page.getByRole('combobox', { name: /3D background/ }).selectOption({ label: mode });
}
async function openViewControls(page: Page) {
  const toggle = page.getByRole('button', { name: 'View controls', exact: true });
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
}
async function modelCamera(page: Page, version: string) {
  const label = page.locator('.cad-viewport [data-cad-plane-label]').first();
  await expect(label).toBeAttached();
  // Labels move only when a frame is drawn, which software GL can hold back under load; read them after two frames.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const view = (await call(page, 'cad_get_viewport', { expectedVersion: version })).view as { mode: string; view: string; zoom: number };
  return { mode: view.mode, view: view.view, zoom: view.zoom, label: await label.evaluate(element => [(element as HTMLElement).style.left, (element as HTMLElement).style.top]) };
}

test('shows the part dimmed behind a sketch on its top face, hides or shows it plainly, cuts away what faces the viewer and restores the model view', async ({ page }, info) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: features.map(feature => ({ kind: 'add-feature', feature: generatedSketch(feature) })) });
  const document = await context(page);
  const built = await call(page, 'cad_build', { expectedVersion: document.version });
  expect((built.bodies as { volumeMm3: number }[]).map(body => Math.round(body.volumeMm3)).sort((a, b) => a - b)).toEqual([4_000, 24_000]);
  await expect.poll(async () => (await call(page, 'cad_get_viewport', { expectedVersion: document.version })).view).toMatchObject({ mode: 'solid', available: true, referenceVersion: document.version });
  let before = await modelCamera(page, document.version);
  await expect.poll(async () => { const now = await modelCamera(page, document.version), same = JSON.stringify(now) === JSON.stringify(before); before = now; return same; }, { intervals: [300] }).toBe(true);

  await call(page, 'cad_set_viewport', { expectedVersion: document.version, command: { kind: 'edit-sketch', sketchId: 'top' } });
  await expect(page.getByLabel('Sketch drawing canvas')).toBeVisible();
  // Behind the sketch the 3D view is decoration: it takes no pointer, focus or accessible name.
  await expect(page.locator('.cad-viewport.is-sketch-background')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('.cad-viewport.is-sketch-background')).toHaveCSS('pointer-events', 'none');
  await expect(background(page).locator('canvas')).toHaveAttribute('tabindex', '-1');
  await openViewControls(page);
  await expect(page.getByRole('combobox', { name: /3D background/ })).toHaveValue('dimmed');
  const cut = page.getByRole('checkbox', { name: 'Cut part by sketch plane', exact: true });
  await expect(cut).not.toBeChecked();
  await settled(page);
  const dimmed = await brightness(page, document.version, info, 'dimmed');

  await choose(page, 'Normal'); await settled(page);
  const normal = await brightness(page, document.version, info, 'normal');
  // Over the plain part each sketch stroke lies on a dark under-stroke, in the theme background colour, that takes no pointer.
  const halos = page.locator('svg.cad-sketch-canvas .cad-sketch-halo');
  // The frame and hole are generators, drawn as their members: the frame's four lines and the hole's circle each have one.
  await expect(halos).toHaveCount(5);
  for (const halo of await halos.all()) {
    await expect(halo).toHaveCSS('stroke', 'rgb(18, 26, 32)');
    await expect(halo).toHaveCSS('pointer-events', 'none');
  }
  await choose(page, 'Hidden');
  await expect(halos).toHaveCount(0);
  await expect(page.locator('.cad-viewport.is-sketch-background')).toHaveCount(0);
  await expect(cut).toBeDisabled();
  const hidden = await brightness(page, document.version, info, 'hidden');
  const shown = (probes: Record<Probe, number>, probe: Probe, base = hidden) => probes[probe] - base[probe];
  const report = JSON.stringify({ dimmed, normal, hidden });
  // Shown plainly both bodies stand well clear of the background; dimmed they keep a clearly smaller part of that contrast.
  // Beside them the background reads the same whether the 3D view is drawn under the sketch or not.
  for (const body of ['plate', 'block'] as const) {
    expect(shown(normal, body), report).toBeGreaterThan(40);
    expect(shown(dimmed, body), report).toBeGreaterThan(shown(normal, body) * 0.15);
    expect(shown(dimmed, body), report).toBeLessThan(shown(normal, body) * 0.6);
  }
  for (const empty of ['beside', 'above'] as const) for (const probes of [normal, dimmed]) expect(Math.abs(shown(probes, empty)), report).toBeLessThan(3);

  // The cut removes the block, which stands on the viewer's side of the sketch plane, and keeps the plate behind it.
  await choose(page, 'Normal'); await cut.check(); await settled(page);
  const cutNormal = await brightness(page, document.version, info, 'cut-normal');
  const cutReport = JSON.stringify({ normal, cutNormal, hidden });
  expect(Math.abs(shown(cutNormal, 'block')), cutReport).toBeLessThan(3);
  expect(Math.abs(cutNormal.plate - normal.plate), cutReport).toBeLessThan(3);
  await choose(page, 'Dimmed'); await settled(page);
  await expect(halos).toHaveCount(0);
  const cutDimmed = await brightness(page, document.version, info, 'cut-dimmed');
  expect(Math.abs(shown(cutDimmed, 'block')), JSON.stringify({ cutDimmed, hidden })).toBeLessThan(3);
  expect(Math.abs(cutDimmed.plate - dimmed.plate), JSON.stringify({ cutDimmed, dimmed })).toBeLessThan(3);

  // Hover, a box drag and a Line preview draw nothing behind the sketch; a zoom step draws one frame.
  const canvas = await page.getByLabel('Sketch drawing canvas').boundingBox(); if (!canvas) throw new Error('Sketch canvas unavailable.');
  const drawn = await settled(page);
  const at = (fx: number, fy: number) => [canvas.x + canvas.width * fx, canvas.y + canvas.height * fy] as const;
  for (let step = 0; step <= 20; step++) await page.mouse.move(...at(0.2 + step * 0.03, 0.3 + step * 0.01));
  // A box drag over empty sketch, between the plate's edge and the construction frame.
  const [from, to] = [await project(page, document.version, [2, 46]), await project(page, document.version, [40, 43])];
  await page.mouse.move(from.x, from.y); await page.mouse.down(); for (let step = 1; step <= 10; step++) await page.mouse.move(from.x + (to.x - from.x) * step / 10, from.y + (to.y - from.y) * step / 10); await page.mouse.up();
  await page.getByRole('button', { name: 'Line', exact: true }).click();
  for (let step = 0; step <= 20; step++) await page.mouse.move(...at(0.7 - step * 0.02, 0.6 - step * 0.01));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  expect(await framesDrawn(page)).toBe(drawn);
  await page.mouse.move(...at(0.5, 0.5)); await page.mouse.wheel(0, 120);
  await expect.poll(() => framesDrawn(page)).toBe(drawn + 1);
  await page.waitForTimeout(300);
  expect(await framesDrawn(page)).toBe(drawn + 1);
  // The zoomed view still lines the part up with the sketch: the plate shows where the sketch says it is, the cut block does not.
  const zoomed = await brightness(page, document.version, info);
  await choose(page, 'Hidden'); await expect(page.locator('.cad-viewport.is-sketch-background')).toHaveCount(0);
  const zoomedHidden = await brightness(page, document.version, info);
  const zoomReport = JSON.stringify({ zoomed, zoomedHidden, cutDimmed, hidden });
  expect(shown(zoomed, 'plate', zoomedHidden), zoomReport).toBeGreaterThan(shown(cutDimmed, 'plate') * 0.8);
  expect(Math.abs(shown(zoomed, 'block', zoomedHidden)), zoomReport).toBeLessThan(3);
  expect(Math.abs(shown(zoomed, 'beside', zoomedHidden)), zoomReport).toBeLessThan(3);
  await choose(page, 'Dimmed'); await settled(page);

  // Leaving the sketch brings back the model camera exactly; the choices stay for the next sketch.
  await call(page, 'cad_set_viewport', { expectedVersion: document.version, command: { kind: 'finish-sketch' } });
  await expect(page.getByLabel('Sketch drawing canvas')).toHaveCount(0);
  await expect.poll(() => modelCamera(page, document.version)).toEqual(before);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('wire-edm:cad-preferences:v1') ?? '{}').sketchView)).toEqual({ background: 'dimmed', cutBySketchPlane: true });
});

const focused = (page: Page) => page.evaluate(() => {
  const active = document.activeElement;
  return active?.matches('svg.cad-sketch-canvas') ? 'sketch' : active?.matches('.cad-viewport canvas') ? `3d${active.closest('[inert]') ? ' inert' : ''}` : active?.tagName.toLowerCase() ?? 'none';
});
const sketchSpan = async (page: Page, version: string) => ((await call(page, 'cad_get_viewport', { expectedVersion: version })).view as { heightSpanMm: number }).heightSpanMm;

test('moves focus from the 3D view into the sketch it opens, so the sketch keys work, and back when the sketch closes', async ({ page }) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: features.filter(feature => feature.kind === 'sketch').map(feature => ({ kind: 'add-feature', feature: generatedSketch(feature) })) });
  const document = await context(page);
  const model = page.locator('.cad-viewport:not(.is-sketch-background) canvas');
  await expect(model).toBeVisible();
  await model.focus();
  expect(await focused(page)).toBe('3d');
  await call(page, 'cad_set_viewport', { expectedVersion: document.version, command: { kind: 'edit-sketch', sketchId: 'top' } });
  await expect(page.getByLabel('Sketch drawing canvas')).toBeVisible();
  await expect(page.locator('.cad-viewport.is-sketch-background')).toHaveAttribute('inert', '');
  expect(await focused(page)).toBe('sketch');
  // F fits the sketch only when the sketch canvas itself has focus.
  const opened = await sketchSpan(page, document.version);
  const box = await page.getByLabel('Sketch drawing canvas').boundingBox(); if (!box) throw new Error('Sketch canvas unavailable.');
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.4); await page.mouse.wheel(0, 360);
  await expect.poll(() => sketchSpan(page, document.version)).not.toBe(opened);
  const zoomed = await sketchSpan(page, document.version);
  await page.keyboard.press('f');
  await expect.poll(() => sketchSpan(page, document.version)).toBeLessThan(zoomed);
  await call(page, 'cad_set_viewport', { expectedVersion: document.version, command: { kind: 'finish-sketch' } });
  await expect(page.getByLabel('Sketch drawing canvas')).toHaveCount(0);
  expect(await focused(page)).toBe('3d');
});

test('keeps the model camera exactly where the sketch found it when the first solid builds and then grows while the sketch is open', async ({ page }) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: features.filter(feature => feature.kind === 'sketch').map(feature => ({ kind: 'add-feature', feature: generatedSketch(feature) })) });
  const outlines = await context(page);
  expect((await call(page, 'cad_build', { expectedVersion: outlines.version })).bodies).toHaveLength(0);
  await expect.poll(async () => (await call(page, 'cad_get_viewport', { expectedVersion: outlines.version })).view).toMatchObject({ mode: 'solid', available: true, referenceVersion: outlines.version });
  // The view frames the outlines, the only geometry so far.
  let before = await modelCamera(page, outlines.version);
  await expect.poll(async () => { const now = await modelCamera(page, outlines.version), same = JSON.stringify(now) === JSON.stringify(before); before = now; return same; }, { intervals: [300] }).toBe(true);
  await call(page, 'cad_set_viewport', { expectedVersion: outlines.version, command: { kind: 'edit-sketch', sketchId: 'top' } });
  await expect(page.getByLabel('Sketch drawing canvas')).toBeVisible();
  const drawn = await settled(page);
  // The first solids build behind the open sketch, which draws them.
  await call(page, 'cad_edit_document', { expectedVersion: outlines.version, edits: features.filter(feature => feature.kind === 'extrude').map(feature => ({ kind: 'add-feature', feature: generatedSketch(feature) })) });
  const padded = await context(page);
  expect((await call(page, 'cad_build', { expectedVersion: padded.version })).bodies).toHaveLength(2);
  await expect.poll(() => framesDrawn(page)).toBeGreaterThan(drawn);
  // A rebuild makes the block ten times taller, so the part's bounds change again.
  const block = features.find(feature => feature.id === 'block')!;
  await call(page, 'cad_edit_document', { expectedVersion: padded.version, edits: [{ kind: 'update-feature', feature: { ...block, distance: 100 } }] });
  const taller = await context(page);
  expect((await call(page, 'cad_build', { expectedVersion: taller.version })).bodies).toHaveLength(2);
  await settled(page);
  await call(page, 'cad_set_viewport', { expectedVersion: taller.version, command: { kind: 'finish-sketch' } });
  await expect(page.getByLabel('Sketch drawing canvas')).toHaveCount(0);
  await expect.poll(async () => (await call(page, 'cad_get_viewport', { expectedVersion: taller.version })).view).toMatchObject({ mode: 'solid', available: true, referenceVersion: taller.version });
  expect(await modelCamera(page, taller.version)).toEqual(before);
});

test('outlines the piece an Extend preview adds over a plainly shown face, keeping its dashes', async ({ page }) => {
  await prepareCadTools(page); await call(page, 'cad_open_workspace');
  // An edge on the plate's top face stops short of a fence line; extending its end adds a piece that lies over nothing but the face.
  const lines = { id: 'lines', name: 'Lines', kind: 'sketch', suppressed: false, plane: 'XY', offset: 10, profiles: [], graph: {
    points: [{ id: 'a', position: [10, 10] }, { id: 'b', position: [20, 10] }, { id: 'f1', position: [40, 0] }, { id: 'f2', position: [40, 30] }],
    entities: [{ id: 'edge', kind: 'line', startPointId: 'a', endPointId: 'b', construction: false },
      { id: 'fence', kind: 'line', startPointId: 'f1', endPointId: 'f2', construction: false }], relations: [] } };
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version,
    edits: [...features.slice(0, 2), lines].map(feature => ({ kind: 'add-feature', feature: generatedSketch(feature) })) });
  const document = await context(page);
  expect((await call(page, 'cad_build', { expectedVersion: document.version })).bodies).toHaveLength(1);
  await call(page, 'cad_set_viewport', { expectedVersion: document.version, command: { kind: 'edit-sketch', sketchId: 'lines' } });
  await expect(page.getByLabel('Sketch drawing canvas')).toBeVisible();
  await openViewControls(page); await choose(page, 'Normal'); await settled(page);
  await page.locator('[data-cad-sketch-entity="edge"]').press('Shift+F10');
  const extend = page.getByRole('menuitem', { name: 'Extend end', exact: true }); await expect(extend).toBeEnabled(); await extend.focus();
  const preview = page.getByLabel('Extend preview', { exact: true });
  const added = preview.locator('line.is-added:not(.cad-sketch-halo)'), under = preview.locator('line.is-added.cad-sketch-halo');
  await expect(added).toHaveCount(1); await expect(under).toHaveCount(1);
  await expect(preview.locator('.cad-sketch-halo')).toHaveCount(3);
  const style = (element: Element) => { const css = getComputedStyle(element); return { stroke: css.stroke, width: css.strokeWidth, dashes: css.strokeDasharray, pointer: css.pointerEvents }; };
  const piece = await added.evaluate(style), halo = await under.evaluate(style);
  expect(piece.dashes).toBe('5px, 3px'); expect(piece.width).toBe('2px'); expect(piece.stroke).not.toBe('rgb(18, 26, 32)');
  expect(halo).toEqual({ stroke: 'rgb(18, 26, 32)', width: '4px', dashes: piece.dashes, pointer: 'none' });
  expect(await under.evaluate((element, other) => ['x1', 'y1', 'x2', 'y2'].map(name => element.getAttribute(name)).join() === other, await added.evaluate(element => ['x1', 'y1', 'x2', 'y2'].map(name => element.getAttribute(name)).join()))).toBe(true);
  await page.keyboard.press('Escape');
});
