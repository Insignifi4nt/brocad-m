import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { prepareCadTools, callCadTool as call, cadContext as context, generatedSketch } from './cad-tool-helpers';

test('saved CAD survives dashboard reopen, browser history, direct reload and STEP export', async ({ page }) => {
  await prepareCadTools(page);
  const initial = await context(page);
  await call(page, 'cad_create_document', { expectedVersion: initial.version, name: 'Saved routing part' });
  await call(page, 'cad_edit_document', { expectedVersion: (await context(page)).version, edits: [
    { kind: 'add-feature', feature: generatedSketch({ id: 'outline', name: 'Outline', kind: 'sketch', suppressed: false, plane: 'XY', offset: 0,
      profiles: [{ id: 'rectangle', name: 'Plate', construction: false, geometry: { kind: 'rectangle', x: 0, y: 0, width: 20, height: 10, cornerRadius: 0 } }] }) },
    { kind: 'add-feature', feature: { id: 'pad', name: 'Thickness', kind: 'extrude', suppressed: false, sketchId: 'outline', distance: 5, symmetric: false, operation: 'new', targetId: null } }
  ] });
  const saved = await call(page, 'cad_save_document', { expectedVersion: (await context(page)).version });
  const projectId = String(saved.documentId);
  await expect(page).toHaveURL(new RegExp(`/cad/${projectId}$`));
  const projectUrl = page.url();
  await page.goBack();
  await expect(page).toHaveURL(/wireedm-gcode-parser\/$/);
  await page.getByRole('button', { name: `Open project ${projectId} in CAD`, exact: true }).click();
  await expect(page).toHaveURL(projectUrl);
  // The URL publishes before the guarded open finishes. Navigate history after the actual CAD view is ready.
  await expect(page.getByRole('button', { name: 'Workbench', exact: true })).toBeVisible();
  await expect(page.getByText('Opening project…', { exact: true })).toBeHidden();
  await page.goBack();
  await expect(page.getByRole('button', { name: `Open project ${projectId} in CAD`, exact: true })).toBeVisible();
  await expect(page.getByText('Opening project…', { exact: true })).toBeHidden();
  await page.goForward();
  await expect(page).toHaveURL(projectUrl);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Workbench', exact: true })).toBeVisible();
  const reopened = await context(page);
  expect(reopened).toMatchObject({ documentId: projectId, dirty: false });
  const build = await call(page, 'cad_build', { expectedVersion: reopened.version });
  expect(build).toMatchObject({ bodies: [{ volumeMm3: expect.closeTo(1000, 7) }] });
  const download = page.waitForEvent('download');
  await call(page, 'cad_export_solid', { expectedVersion: reopened.version, format: 'step' });
  expect((await download).suggestedFilename()).toBe('Saved routing part.step');
});

test('static-host deep links show recoverable missing projects and settings has history', async ({ page }) => {
  await prepareCadTools(page);
  const fallback = await readFile('dist/404.html', 'utf8');
  await page.route('**/cad/cad_missing', route => route.fulfill({ status: 404, contentType: 'text/html', body: fallback }));
  await page.goto('/wireedm-gcode-parser/cad/cad_missing');
  await expect(page.getByRole('region', { name: 'Page unavailable' })).toBeVisible();
  await page.getByRole('button', { name: 'Back to projects', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Design in CAD', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await page.getByRole('button', { name: 'CAD', exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/cad$/);
  await page.reload();
  await expect(page.getByRole('dialog', { name: 'Workbench settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await expect(page).toHaveURL(/wireedm-gcode-parser\/$/);
});
