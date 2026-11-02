import { expect, type Locator, type Page } from '@playwright/test';

// Exercise production registrations without a browser-specific WebMCP transport.
// Native WebMCP interoperability is also checked in the Codex in-app browser.
export async function prepareCadTools(page: Page) {
  await page.addInitScript(() => {

    const tools = new Map<string, { execute(input: unknown): Promise<unknown> }>();
    Object.defineProperty(document, 'modelContext', { configurable: true, value: {
      registerTool(tool: { name: string; execute(input: unknown): Promise<unknown> }, options: { signal: AbortSignal }) {
        tools.set(tool.name, tool);
        options.signal.addEventListener('abort', () => { if (tools.get(tool.name) === tool) tools.delete(tool.name); });
      }
    } });
    Object.defineProperty(document, '__cadTestTools', { value: tools });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Design in CAD' })).toBeEnabled();
}

/** Tool payloads are untyped JSON; journeys assert their shape at the point of use. */
export type CadToolData = Record<string, any>;

export async function rawCadToolCall(page: Page, name: string, input: unknown = {}): Promise<CadToolData> {
  return page.evaluate(async ({ name, input }) => {
    const tools = (document as Document & { __cadTestTools: Map<string, { execute(input: unknown): Promise<unknown> }> }).__cadTestTools;
    const tool = tools.get(name);
    if (!tool) throw new Error(`Missing registered tool ${name}`);
    return tool.execute(input) as Promise<CadToolData>;
  }, { name, input });
}

export async function callCadTool(page: Page, name: string, input: unknown = {}): Promise<CadToolData> {
  const result = await rawCadToolCall(page, name, input);
  return cadToolData(name, result);
}

function cadToolData(name: string, result: unknown): CadToolData {
  expect(result, `${name}: ${JSON.stringify(result)}`).toMatchObject({ ok: true });
  if (!result || typeof result !== 'object' || !('data' in result) || !result.data || typeof result.data !== 'object') throw new Error('Invalid tool result');
  return result.data as CadToolData;
}

export async function cadContext(page: Page): Promise<CadToolData & { version: string; documentId: string }> {
  const value = await callCadTool(page, 'cad_get_context');
  if (!('version' in value) || typeof value.version !== 'string' || !('documentId' in value) || typeof value.documentId !== 'string') throw new Error('Invalid CAD context');
  return { ...value, version: value.version, documentId: value.documentId };
}

export async function captureCadPreview(page: Page, expectedVersion: string): Promise<CadToolData> {
  const result = await rawCadToolCall(page, 'cad_capture_preview', { expectedVersion });
  if (result && typeof result === 'object' && 'ok' in result && result.ok === false
      && 'error' in result && result.error && typeof result.error === 'object'
      && 'code' in result.error && result.error.code === 'STALE_VIEW') {
    // A changing rendered layer invalidates the PNG, not the caller's accepted
    // document version. Follow the public recovery instruction exactly once.
    await callCadTool(page, 'cad_get_viewport', { expectedVersion });
    return callCadTool(page, 'cad_capture_preview', { expectedVersion });
  }
  return cadToolData('cad_capture_preview', result);
}

/** A feature's history row; a sketch nested under the solid that uses it is revealed by expanding its owners first. */
async function revealHistoryRow(page: Page, row: Locator): Promise<Locator> {
  const collapsed = page.getByRole('list', { name: 'Feature history and dependencies' }).locator('.cad-feature-disclosure[aria-expanded="false"]:not([disabled])');
  // A sketch sits collapsed under the solid that consumes it, and the tree may still be catching up with the last edit.
  for (const deadline = Date.now() + 10_000; Date.now() < deadline && !await row.isVisible();) {
    if (await collapsed.count()) await collapsed.first().click(); else await page.waitForTimeout(100);
  }
  return row;
}
export function historyRow(page: Page, name: string): Promise<Locator> {
  return revealHistoryRow(page, page.getByRole('button', { name: `Select ${name} in history`, exact: true }));
}
/** Selecting a feature only selects it; its editor opens from a double-click on its history row. */
export async function openFeatureEditor(page: Page, featureId: string) {
  await (await revealHistoryRow(page, page.locator(`[data-cad-feature-id="${featureId}"] > .cad-feature-history-row .cad-tree-row`))).dblclick();
}

/** Sketching is free by default; journeys that place geometry on whole millimetres turn the grid magnet on. */
export async function enableGridSnap(page: Page) {
  const toggle = page.getByRole('checkbox', { name: 'Snap to grid', exact: true });
  const view = page.getByRole('button', { name: 'View controls', exact: true });
  const opened = !await toggle.isVisible() && await view.getAttribute('aria-expanded') !== 'true';
  if (opened) await view.click();
  await toggle.check();
  if (opened) await view.click();
}

/** Selected sketch geometry lists only its own relations under the sketch in the feature tree, from its context menu; the target defaults to the first selected item. */
export async function openSketchRelations(page: Page, target?: Locator) {
  await (target ?? page.locator('[data-cad-sketch-entity].is-selected, [data-cad-sketch-point][aria-pressed="true"]').first()).press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Constraints and dimensions', exact: true }).click();
}

/** Opens the relations list under the sketch being edited, which starts closed, and stays open once opened. */
export async function openRelationsList(page: Page) {
  const toggle = page.locator('[data-cad-sketch-relation-list] .cad-sketch-relation-list-toggle');
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

/** A relation the selection can take, in the icon row beside it: pressing it applies the relation, or removes it once applied. */
export function relationOffer(page: Page, name: string): Locator {
  return page.getByRole('toolbar', { name: 'Relations for the selection', exact: true }).getByRole('button', { name, exact: true });
}

/** A relation's row under the sketch being edited, in the feature tree, by the start of its name, such as "Radius relation". */
export function relationRow(page: Page, name: string | RegExp): Locator {
  const pattern = typeof name === 'string' ? new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) : name;
  return page.getByRole('list', { name: 'Sketch relations', exact: true }).getByRole('button', { name: pattern });
}

interface LegacyProfile<G = unknown> { readonly id: string; readonly name: string; readonly construction: boolean; readonly geometry: G }
/**
 * The generator an agent adds a shape with, now that a batch cannot give a sketch a saved profile: the profile's id, name, construction
 * flag and geometry, with an id prefix made from its id. Profile dimensions do not carry over; a generator is sized by its inputs.
 */
export function shapeGenerator<G>(profile: LegacyProfile<G>, idPrefix = profile.id.replace(/[^A-Za-z0-9-]/g, '-')) {
  return { id: profile.id, kind: 'generator' as const, idPrefix, name: profile.name, construction: profile.construction, geometry: profile.geometry };
}
/** `feature` as an agent adds it now: a sketch's saved profiles become generators after its own relations; any other feature as it is. */
export function generatedSketch<T>(feature: T): T {
  const sketch = feature as T & { kind?: string; profiles?: readonly LegacyProfile[]; graph?: { points: readonly unknown[]; entities: readonly unknown[]; relations: readonly unknown[] } };
  if (sketch.kind !== 'sketch' || !sketch.profiles?.length) return feature;
  const graph = sketch.graph ?? { points: [], entities: [], relations: [] };
  return { ...sketch, profiles: [], graph: { ...graph, relations: [...graph.relations, ...sketch.profiles.map(profile => shapeGenerator(profile))] } };
}
/**
 * Opens `features` as a fresh unsaved draft named `name`, through the CAD JSON import a saved document opens with. Journeys that cover
 * saved legacy profiles start from one, since an edit batch can no longer add them.
 */
export async function importCadDraft(page: Page, features: readonly unknown[], { name = 'Seeded draft', parameters = {} }: { readonly name?: string; readonly parameters?: Readonly<Record<string, number>> } = {}) {
  await callCadTool(page, 'cad_import_document', { expectedVersion: (await cadContext(page)).version,
    document: { format: 'wireedm-cad', schemaVersion: 2, id: 'seeded_draft', name, units: 'mm', parameters, features } });
  return cadContext(page);
}
