import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { createBrowserCacheAdapter } from '@/domain/storage/browserCacheAdapter';
import { initializeWorkbenchCatalog } from '@/domain/workbench-catalog/workbenchCatalog';
import { loadCadDocument } from '@/domain/cad/cadStorage';
import { parseCadPluginPackage } from '@/domain/cad/plugins/cadPlugins';
import { parseDxf } from '@/domain/dxf/parseDxf';
import type { CadEdit } from '@/domain/cad/cadOperations';
import type { CadSketchGenerator } from '@/domain/cad/cadSketchGraph';
import { storedCadDocument } from '@/domain/cad/cadStoredDocument';
import { cadSketchProfileViews } from '@/domain/cad/sketch-generators/cadSketchProfileViews';
import { expandCadSketchGenerators } from '@/domain/cad/sketch-generators/cadSketchGenerators';
import { CadSession } from './cadSession';
import { useCadController, type CadController } from './useCadController';
import { cadSiteTools } from './cadSiteTools';

// These journeys use actual browser cache, parameter/geometry checks and exports.
// Native BRep work is separately exercised by the kernel suites.
vi.mock('./kernel/cadKernelClient', () => ({ createCadKernelClient: () => ({ dispose() {} }) }));
// A generated shape puts its geometry in the sketch graph, which an edit solves first. These journeys' graphs hold only generated geometry,
// which is fixed, so the solve gives each back as it is.
vi.mock('./sketch-solver/cadSketchSolverClient', () => ({ createCadSketchSolverClient: () => ({ dispose() {}, solve: async (input: { graph: unknown }) => ({ kind: 'solved', graph: input.graph,
  diagnostics: { status: 'success', degreesOfFreedom: 0, conflictingIds: [], redundantIds: [], partiallyRedundantIds: [], issues: [] } }) }) }));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  localStorage.clear(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return Object.fromEntries(Object.entries(value));
}
async function mount() {
  const connected = await initializeWorkbenchCatalog(createBrowserCacheAdapter(localStorage, { namespace: 'cad-agent-journey' }));
  if (!connected.ok) throw new Error(connected.error.message);
  const workbench = connected.workbench;
  const session = new CadSession(); let controller: CadController | null = null;
  function Harness() {
    const [open, setOpen] = useState(true);
    controller = useCadController({ connectedWorkbench: workbench, workbenchInteractionLocked: false,
      runAgentWorkbenchOperation: async () => { throw new Error('Unexpected CAM operation'); } }, session, open, setOpen, () => null);
    return null;
  }
  await act(async () => root.render(<Harness />));
  function current() { if (!controller) throw new Error('Controller missing'); return controller; }
  const tools = cadSiteTools(current);
  async function call(name: string, args: unknown, signal?: AbortSignal) {
    const tool = tools.find(item => item.name === name); if (!tool) throw new Error(`Missing ${name}`);
    let response: unknown; await act(async () => { response = await tool.execute(args, { signal }); });
    return response;
  }
  async function success(name: string, args: unknown) {
    const response = object(await call(name, args)); expect(response.ok, JSON.stringify(response)).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(response)).length).toBeLessThanOrEqual(32 * 1024);
    return object(response.data);
  }
  /** Saved profiles load and stay editable, but no agent edit adds one, so a journey that edits them starts from a draft that has them. */
  async function legacy(edits: readonly CadEdit[]) { await act(async () => { session.edit(edits); }); }
  return { session, call, success, legacy, workbench };
}
describe('CAD agent discovery and authoring journeys', () => {
  it('discovers revision-scoped grips and edits one vertex through the guarded shared operation', async () => {
    const h = await mount(), seed: CadEdit[] = [{ kind: 'add-feature', feature: {
      id: 'outline', name: 'Outline', kind: 'sketch', suppressed: false, plane: 'XY', offset: 0,
      profiles: [{ id: 'plate', name: 'Plate', construction: false, geometry: { kind: 'polygon', points: [[0, 0], [20, 0], [20, 10], [0, 10]] } }]
    } }];
    const empty = h.session.getSnapshot();
    expect(await h.call('cad_edit_document', { expectedVersion: empty.version, edits: seed })).toMatchObject({ ok: false, error: { code: 'legacy-sketch-profile', message: expect.stringContaining('set-sketch-generator') } });
    expect(h.session.getSnapshot()).toBe(empty);
    await h.legacy(seed);
    const before = h.session.getSnapshot(), query = { expectedVersion: before.version, sketchId: 'outline', profileId: 'plate', offset: 1, limit: 1 };
    const contract = await h.success('cad_describe_edits', { kind: 'move-sketch-handle' });
    expect(object(contract.schema).required).toEqual(expect.arrayContaining(['sketchId', 'profileId', 'handle', 'translation']));
    const handles = await h.success('cad_inspect_sketch_handles', query);
    expect(handles).toMatchObject({ total: 4, nextOffset: 2, items: [{ handle: { kind: 'vertex', index: 1 }, point: [20, 0], draggable: true }] });
    expect(h.session.getSnapshot()).toBe(before);
    if (!Array.isArray(handles.items)) throw new Error('Missing handle page');
    const edit = { kind: 'move-sketch-handle', sketchId: 'outline', profileId: 'plate', handle: object(handles.items[0]).handle, translation: [5, -2] };
    await h.success('cad_edit_document', { expectedVersion: before.version, edits: [edit] });
    const after = h.session.getSnapshot();
    expect(after.document.features[0]).toMatchObject({ profiles: [{ geometry: { points: [[0, 0], [25, -2], [20, 10], [0, 10]] } }] });
    expect(await h.call('cad_inspect_sketch_handles', query)).toMatchObject({ ok: false, error: { code: 'STALE_STATE' } });
    await h.success('cad_history', { expectedVersion: after.version, direction: 'undo' });
    expect(h.session.getSnapshot().document).toEqual(before.document);
    await act(async () => h.session.setWorkflowOpen(true));
    expect(await h.call('cad_inspect_sketch_handles', { ...query, expectedVersion: h.session.getSnapshot().version })).toMatchObject({ ok: false, error: { code: 'WORKFLOW_OPEN' } });
    expect(await h.call('cad_edit_document', { expectedVersion: h.session.getSnapshot().version, edits: [edit] })).toMatchObject({ ok: false, error: { code: 'WORKFLOW_OPEN' } });
  });

  it('removes the relations on geometry a generator stops making only when the edit lists them, as one undo step', async () => {
    const h = await mount(), empty = h.session.getSnapshot();
    const polygon: CadSketchGenerator = { id: 'poly', kind: 'generator', idPrefix: 'poly', construction: false,
      geometry: { kind: 'regular-polygon', x: 0, y: 0, radius: 10, sides: 'n', directionId: '@h' } };
    const corner = expandCadSketchGenerators({ points: [], entities: [], relations: [polygon] }, { n: 5 }).points.find(point => point.id === 'poly_v4')!.position;
    await h.success('cad_edit_document', { expectedVersion: empty.version, edits: [{ kind: 'set-parameter', name: 'n', value: 5 },
      { kind: 'add-feature', feature: { id: 'plate', name: 'Plate', kind: 'sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [],
        graph: { points: [{ id: 'u', position: corner }], entities: [], relations: [] } } },
      { kind: 'set-sketch-generator', sketchId: 'plate', generator: polygon },
      { kind: 'set-sketch-relation', sketchId: 'plate', relation: { id: 'c4', kind: 'coincident', pointIds: ['u', 'poly_v4'] } }] });
    const seeded = h.session.getSnapshot(), fewer = { kind: 'set-parameter', name: 'n', value: 4 };
    // Four sides lose the fifth corner: the edit names the polygon and lists every relation it would remove, and changes nothing.
    expect(await h.call('cad_edit_document', { expectedVersion: seeded.version, edits: [fewer] })).toMatchObject({ ok: false, error: {
      code: 'unconfirmed-sketch-generator-removals', message: expect.stringContaining('Regular polygon "poly" no longer generates geometry'),
      details: { relationIds: ['c4'], relationCount: 1 } } });
    expect(h.session.getSnapshot()).toMatchObject({ version: seeded.version }); expect(h.session.getSnapshot().document).toBe(seeded.document);
    await h.success('cad_edit_document', { expectedVersion: seeded.version, edits: [{ ...fewer, removedRelationIds: ['c4'] }] });
    const reduced = h.session.getSnapshot(), sketch = reduced.document.features[0];
    expect(sketch.kind === 'sketch' && sketch.graph?.relations.filter(relation => !relation.id.startsWith('poly_')).map(relation => relation.id)).toEqual(['poly']);
    await h.success('cad_history', { expectedVersion: reduced.version, direction: 'undo' });
    expect(h.session.getSnapshot().document).toEqual(seeded.document);
  });

  it('lists a removal too large for one refusal a page at a time at its version, and applies it once every ID is confirmed', async () => {
    const h = await mount(), empty = h.session.getSnapshot();
    const polygon: CadSketchGenerator = { id: 'poly', kind: 'generator', idPrefix: 'poly', construction: false,
      geometry: { kind: 'regular-polygon', x: 0, y: 0, radius: 10, sides: 'n', directionId: '@h' } };
    const corner = expandCadSketchGenerators({ points: [], entities: [], relations: [polygon] }, { n: 6 }).points.find(point => point.id === 'poly_v5')!.position;
    // Two hundred points tied to the sixth corner, by IDs long enough that the whole set overflows one refusal's details.
    const ids = Array.from({ length: 200 }, (_, at) => `tie-${at}-${'x'.repeat(70)}`);
    await h.success('cad_edit_document', { expectedVersion: empty.version, edits: [{ kind: 'set-parameter', name: 'n', value: 6 }, { kind: 'set-parameter', name: 'spare', value: 0 },
      { kind: 'add-feature', feature: { id: 'plate', name: 'Plate', kind: 'sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [],
        graph: { points: ids.map((_, at) => ({ id: `u${at}`, position: corner })), entities: [],
          relations: [polygon, ...ids.map((id, at) => ({ id, kind: 'coincident', pointIds: [`u${at}`, 'poly_v5'] }))] } } }] });
    const seeded = h.session.getSnapshot(), fewer = { kind: 'set-parameter', name: 'n', value: 5 }, sent: string[] = [];
    for (let pages = 1; ; pages++) {
      expect(pages).toBeLessThanOrEqual(4);
      const response = object(await h.call('cad_edit_document', { expectedVersion: seeded.version, edits: [{ ...fewer, ...sent.length ? { removedRelationIds: sent } : {} }] }));
      expect(new TextEncoder().encode(JSON.stringify(response)).length).toBeLessThanOrEqual(32 * 1024);
      expect(response).toMatchObject({ ok: false, error: { code: 'unconfirmed-sketch-generator-removals', message: expect.stringContaining('Send all 200 IDs as removedRelationIds'),
        details: { version: seeded.version, relationCount: 200, confirmedCount: sent.length } } });
      expect(h.session.getSnapshot().document).toBe(seeded.document);
      const details = object(object(response.error).details), page = details.relationIds as string[];
      expect(page.length).toBeGreaterThan(0);
      expect(details.omittedRelationCount).toBe(200 - sent.length - page.length);
      sent.push(...page);
      if (details.omittedRelationCount === 0) break;
    }
    expect(sent).toEqual(ids);
    // A confirmation pinned to a version the draft has left is refused, and changes nothing; at the current version it applies.
    await h.success('cad_edit_document', { expectedVersion: seeded.version, edits: [{ kind: 'set-parameter', name: 'spare', value: 1 }] });
    const moved = h.session.getSnapshot();
    expect(await h.call('cad_edit_document', { expectedVersion: seeded.version, edits: [{ ...fewer, removedRelationIds: sent }] })).toMatchObject({ ok: false, error: { code: 'STALE_STATE' } });
    expect(h.session.getSnapshot()).toBe(moved);
    await h.success('cad_edit_document', { expectedVersion: moved.version, edits: [{ ...fewer, removedRelationIds: sent }] });
    const sketch = h.session.getSnapshot().document.features[0];
    expect(sketch.kind === 'sketch' && sketch.graph?.relations.filter(relation => !relation.id.startsWith('poly_')).map(relation => relation.id)).toEqual(['poly']);
    await h.success('cad_history', { expectedVersion: h.session.getSnapshot().version, direction: 'undo' });
    expect(h.session.getSnapshot().document).toEqual(moved.document);
  });

  it('keeps initial CAD discovery below 50 KiB without repeating complete plugin recipe schemas', () => {
    const tools = cadSiteTools(() => { throw new Error('Registration must not invoke a controller'); });
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
    const metadata = tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }));
    expect(bytes(metadata)).toBeLessThanOrEqual(50 * 1024);
    expect(bytes(metadata.find(tool => tool.name === 'cad_edit_document'))).toBeLessThanOrEqual(8 * 1024);
    expect(bytes(metadata.find(tool => tool.name === 'cad_install_plugin'))).toBeLessThanOrEqual(2 * 1024);
  });
  it.each([1, 2])('discovers the full plugin API %i recipe contract but refuses envelope-only installation', async apiVersion => {
    const h = await mount(), before = h.session.getSnapshot();
    expect(await h.success('cad_describe_plugin_api', {})).toMatchObject({ items: [{ apiVersion: 1 }, { apiVersion: 2 }] });
    const discovery = await h.success('cad_describe_plugin_api', { apiVersion }), schema = object(discovery.schema);
    expect(object(object(schema.properties).apiVersion).const).toBe(apiVersion);
    expect(schema.required).toEqual(expect.arrayContaining(['inputs', 'generator']));
    if (apiVersion === 2) expect(schema.required).toContain('rules');
    const args = { expectedVersion: before.version, package: { format: 'wireedm-cad-plugin', id: 'example.incomplete', version: '1.0.0', name: 'Incomplete', apiVersion } };
    const install = cadSiteTools(() => { throw new Error('Metadata only'); }).find(tool => tool.name === 'cad_install_plugin');
    if (!install || !h.workbench.adapter.listFiles) throw new Error('Missing discovery or inventory');
    expect(Value.Check(install.inputSchema, args)).toBe(true);
    const inventory = await h.workbench.adapter.listFiles();
    await expect(h.call('cad_install_plugin', args))
      .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    const edit = cadSiteTools(() => { throw new Error('Metadata only'); }).find(tool => tool.name === 'cad_edit_document');
    if (!edit) throw new Error('Missing edit discovery');
    const incompleteBatch = { expectedVersion: before.version, edits: [
      { kind: 'add-feature', feature: { kind: 'sketch', id: 'section', name: 'Section', suppressed: false, plane: 'XY', offset: 0, profiles: [] } },
      { kind: 'add-plugin-profile', sketchId: 'section', profileId: 'profile', name: 'Incomplete', groupId: 'drivers', package: args.package }
    ] };
    expect(Value.Check(edit.inputSchema, incompleteBatch)).toBe(true);
    await expect(h.call('cad_edit_document', incompleteBatch)).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(h.session.getSnapshot()).toBe(before);
    expect(await h.workbench.adapter.listFiles()).toEqual(inventory);
  });
  it('exposes a complete bounded schema for every feature in the discovery catalog', async () => {
    const h = await mount(), before = h.session.getSnapshot();
    const catalog = await h.success('cad_describe_features', {});
    if (!Array.isArray(catalog.items)) throw new Error('Missing discovery catalog');
    for (const row of catalog.items) {
      const entry = object(row), definition = await h.success('cad_describe_features', { kind: entry.kind });
      const schema = object(definition.schema), properties = object(schema.properties);
      expect(schema.additionalProperties).toBe(false);
      const kind = object(properties.kind), alternatives = Array.isArray(kind.anyOf) ? kind.anyOf.map(item => object(item).const) : [kind.const];
      expect(alternatives).toContain(entry.kind);
      expect(schema.required).toEqual(expect.arrayContaining(['id', 'kind', 'name', 'suppressed']));
    }
    expect(h.session.getSnapshot()).toBe(before);
  });
  it('adds driving dimensions, edits displayed values and moves a sketch in one guarded undo step', async () => {
    const h = await mount();
    await h.success('cad_create_document', { expectedVersion: h.session.getSnapshot().version, name: 'Driven plate' });
    await h.legacy([
      { kind: 'set-parameter', name: 'span', value: 40 },
      { kind: 'add-feature', feature: { id: 'outline', name: 'Outline', kind: 'sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [
        { id: 'plate', name: 'Plate', construction: false, geometry: { kind: 'rectangle', x: 0, y: 0, width: 30, height: 20, cornerRadius: 0 } },
        { id: 'bore', name: 'Bore', construction: false, geometry: { kind: 'circle', x: 15, y: 10, radius: 2 } },
      ] } },
    ]);
    const free = h.session.getSnapshot();
    await h.success('cad_edit_document', { expectedVersion: free.version, edits: [
      { kind: 'add-sketch-dimension', sketchId: 'outline', profileId: 'plate', constraint: { id: 'plate_width', kind: 'dimension', quantity: 'width' } },
      { kind: 'add-sketch-dimension', sketchId: 'outline', profileId: 'bore', constraint: { id: 'bore_diameter', kind: 'dimension', quantity: 'diameter' } },
    ] });
    const constrained = h.session.getSnapshot(), intent = await h.success('cad_get_feature', { expectedVersion: constrained.version, featureId: 'outline' });
    expect(intent.feature).toMatchObject({ profiles: [
      { geometry: { kind: 'rectangle', x: 0, y: 0, width: 30, height: 20, cornerRadius: 0 },
        constraints: [{ id: 'plate_width', kind: 'dimension', quantity: 'width' }] },
      { geometry: { kind: 'circle', x: 15, y: 10, radius: 2 }, constraints: [{ id: 'bore_diameter', kind: 'dimension', quantity: 'diameter' }] },
    ] });
    await h.success('cad_edit_document', { expectedVersion: constrained.version, edits: [
      { kind: 'set-sketch-dimension', sketchId: 'outline', profileId: 'plate', dimensionId: 'plate_width', value: 'span' },
      { kind: 'set-sketch-dimension', sketchId: 'outline', profileId: 'bore', dimensionId: 'bore_diameter', value: 10 },
      { kind: 'translate-sketch-profiles', sketchId: 'outline', profileIds: ['plate', 'bore'], translation: [3, -4] },
    ] });
    const moved = h.session.getSnapshot(), geometry = await h.success('cad_get_feature', { expectedVersion: moved.version, featureId: 'outline' });
    expect(geometry.feature).toMatchObject({ profiles: [
      { id: 'plate', geometry: { kind: 'rectangle', x: 3, y: -4, width: 'span', height: 20 }, constraints: [{ id: 'plate_width', kind: 'dimension', quantity: 'width' }] },
      { id: 'bore', geometry: { kind: 'circle', x: 18, y: 6, radius: 5 }, constraints: [{ id: 'bore_diameter', kind: 'dimension', quantity: 'diameter' }] },
    ] });
    const measured = await h.success('cad_measure_sketch', { expectedVersion: moved.version, sketchId: 'outline' });
    expect(measured.materialAreaMm2).toBeCloseTo(800 - 25 * Math.PI, 8);
    await h.success('cad_history', { expectedVersion: moved.version, direction: 'undo' });
    expect(h.session.getSnapshot().document).toEqual(constrained.document);
    await h.success('cad_history', { expectedVersion: h.session.getSnapshot().version, direction: 'redo' });
    expect(h.session.getSnapshot().document).toEqual(moved.document);
    await h.success('cad_save_document', { expectedVersion: h.session.getSnapshot().version });
    expect((await loadCadDocument(h.workbench.adapter, moved.document.id)).document).toEqual(moved.document);
    await h.success('cad_edit_document', { expectedVersion: h.session.getSnapshot().version, edits: [
      { kind: 'remove-sketch-dimension', sketchId: 'outline', profileId: 'plate', dimensionId: 'plate_width' },
      { kind: 'remove-sketch-dimension', sketchId: 'outline', profileId: 'bore', dimensionId: 'bore_diameter' },
    ] });
    const removed = await h.success('cad_get_feature', { expectedVersion: h.session.getSnapshot().version, featureId: 'outline' });
    expect(removed.feature).toMatchObject({ profiles: [
      { id: 'plate', geometry: { width: 'span' } }, { id: 'bore', geometry: { radius: 5 } },
    ] });
    const profiles = object(removed.feature).profiles;
    if (!Array.isArray(profiles)) throw new Error('Missing profiles');
    expect(profiles.every(profile => object(profile).constraints === undefined)).toBe(true);
    expect(h.session.getSnapshot().dirty).toBe(true);
    expect((await loadCadDocument(h.workbench.adapter, moved.document.id)).document).toEqual(moved.document);
  });
  it('keeps new sketch edits atomic across dimension conflicts, driven positions and agent ownership guards', async () => {
    const h = await mount();
    await h.legacy([
      { kind: 'set-parameter', name: 'boreX', value: 15 },
      { kind: 'add-feature', feature: { id: 'outline', name: 'Outline', kind: 'sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [
        { id: 'plate', name: 'Plate', construction: false, geometry: { kind: 'rectangle', x: 0, y: 0, width: 30, height: 20, cornerRadius: 0 } },
        { id: 'bore', name: 'Bore', construction: false, geometry: { kind: 'circle', x: 'boreX', y: 10, radius: 2 } },
      ] } },
      { kind: 'add-sketch-dimension', sketchId: 'outline', profileId: 'plate', constraint: { id: 'plate_width', kind: 'dimension', quantity: 'width' } },
      { kind: 'add-sketch-dimension', sketchId: 'outline', profileId: 'bore', constraint: { id: 'bore_diameter', kind: 'dimension', quantity: 'diameter' } },
    ]);
    const before = h.session.getSnapshot();
    const conflicts = [
      ['overconstrained-sketch-dimension', { kind: 'add-sketch-dimension', sketchId: 'outline', profileId: 'plate', constraint: { id: 'second_width', kind: 'dimension', quantity: 'width' } }],
      ['overconstrained-sketch-dimension', { kind: 'add-sketch-dimension', sketchId: 'outline', profileId: 'bore', constraint: { id: 'bore_radius', kind: 'dimension', quantity: 'radius' } }],
      ['duplicate-sketch-constraint', { kind: 'add-sketch-dimension', sketchId: 'outline', profileId: 'plate', constraint: { id: 'plate_width', kind: 'dimension', quantity: 'height' } }],
      ['unsupported-sketch-dimension', { kind: 'add-sketch-dimension', sketchId: 'outline', profileId: 'plate', constraint: { id: 'rectangle_angle', kind: 'dimension', quantity: 'angle' } }],
      ['missing-sketch-dimension', { kind: 'set-sketch-dimension', sketchId: 'outline', profileId: 'plate', dimensionId: 'gone', value: 40 }],
      ['missing-sketch-dimension', { kind: 'remove-sketch-dimension', sketchId: 'outline', profileId: 'bore', dimensionId: 'gone' }],
      ['invalid-profile', { kind: 'set-sketch-dimension', sketchId: 'outline', profileId: 'bore', dimensionId: 'bore_diameter', value: 0 }],
      ['driven-sketch-position', { kind: 'translate-sketch-profiles', sketchId: 'outline', profileIds: ['plate', 'bore'], translation: [1, 0] }],
      ['missing-profile', { kind: 'translate-sketch-profiles', sketchId: 'outline', profileIds: ['plate', 'gone'], translation: [0, 1] }],
    ] satisfies ReadonlyArray<readonly [string, CadEdit]>;
    for (const [code, invalid] of conflicts) {
      expect(await h.call('cad_edit_document', { expectedVersion: before.version, edits: [
        { kind: 'set-parameter', name: 'probe', value: 123 }, invalid,
      ] })).toMatchObject({ ok: false, error: { code } });
      expect(h.session.getSnapshot()).toBe(before);
    }
    const valid = { kind: 'translate-sketch-profiles', sketchId: 'outline', profileIds: ['bore'], translation: [0, 1] };
    expect(await h.call('cad_edit_document', { expectedVersion: 'stale-version', edits: [valid] })).toMatchObject({ ok: false, error: { code: 'STALE_STATE' } });
    expect(h.session.getSnapshot()).toBe(before);
    const abort = new AbortController(); abort.abort();
    expect(await h.call('cad_edit_document', { expectedVersion: before.version, edits: [valid] }, abort.signal)).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(h.session.getSnapshot()).toBe(before);
    await act(async () => h.session.setWorkflowOpen(true));
    const owned = h.session.getSnapshot();
    expect(await h.call('cad_edit_document', { expectedVersion: owned.version, edits: [valid] })).toMatchObject({ ok: false, error: { code: 'WORKFLOW_OPEN' } });
    expect(h.session.getSnapshot()).toBe(owned);
    await act(async () => h.session.setWorkflowOpen(false));
    await h.success('cad_edit_document', { expectedVersion: before.version, edits: [valid] });
    const result = await h.success('cad_get_feature', { expectedVersion: h.session.getSnapshot().version, featureId: 'outline' });
    expect(result.feature).toMatchObject({ profiles: [{ geometry: { x: 0, y: 0 } }, { geometry: { x: 'boreX', y: 11 } }] });
    await h.success('cad_history', { expectedVersion: h.session.getSnapshot().version, direction: 'undo' });
    expect(h.session.getSnapshot().document).toEqual(before.document);
  });
  it('preserves shared named bindings, rejects compound-driver value edits and unlinks only an explicitly replaced scalar', async () => {
    const h = await mount();
    await h.legacy([
      { kind: 'set-parameter', name: 'plateSize', value: 30 }, { kind: 'set-parameter', name: 'boreRadius', value: 2 },
      { kind: 'add-feature', feature: { id: 'outline', name: 'Linked plate', kind: 'sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [
        { id: 'plate', name: 'Plate', construction: false, geometry: { kind: 'rectangle', x: 0, y: 0, width: ' plateSize ', height: 20, cornerRadius: 0 } },
        { id: 'bore', name: 'Bore', construction: false, geometry: { kind: 'circle', x: 'plateSize / 2', y: 10, radius: 'boreRadius' } },
        { id: 'reference', name: 'Reference width', construction: true, geometry: { kind: 'rectangle', x: 50, y: 0, width: 'plateSize', height: 10, cornerRadius: 0 } },
        { id: 'compound', name: 'Double radius', construction: true, geometry: { kind: 'circle', x: 100, y: 0, radius: 'boreRadius * 2' } },
      ] } },
      { kind: 'add-sketch-dimension', sketchId: 'outline', profileId: 'plate', constraint: { id: 'plate_width', kind: 'dimension', quantity: 'width' } },
      { kind: 'add-sketch-dimension', sketchId: 'outline', profileId: 'bore', constraint: { id: 'bore_diameter', kind: 'dimension', quantity: 'diameter' } },
      { kind: 'add-sketch-dimension', sketchId: 'outline', profileId: 'compound', constraint: { id: 'compound_radius', kind: 'dimension', quantity: 'radius' } },
    ]);
    const original = h.session.getSnapshot();
    const edited = await h.success('cad_edit_document', { expectedVersion: original.version, edits: [
      { kind: 'set-sketch-dimension', sketchId: 'outline', profileId: 'plate', dimensionId: 'plate_width', value: 40 },
      { kind: 'set-sketch-dimension', sketchId: 'outline', profileId: 'bore', dimensionId: 'bore_diameter', value: 10 },
    ] });
    expect(edited.parameters).toEqual({ plateSize: 40, boreRadius: 5 });
    const linked = h.session.getSnapshot();
    const read = await h.success('cad_get_feature', { expectedVersion: linked.version, featureId: 'outline' });
    expect(read.feature).toMatchObject({ profiles: [
      { geometry: { width: ' plateSize ' } }, { geometry: { x: 'plateSize / 2', radius: 'boreRadius' } },
      { geometry: { width: 'plateSize' } }, { geometry: { radius: 'boreRadius * 2' } },
    ] });
    const measured = await h.success('cad_measure_sketch', { expectedVersion: linked.version, sketchId: 'outline' });
    expect(measured.materialAreaMm2).toBeCloseTo(800 - 25 * Math.PI, 8);
    expect(await h.call('cad_edit_document', { expectedVersion: linked.version, edits: [
      { kind: 'set-parameter', name: 'probe', value: 123 },
      { kind: 'set-sketch-dimension', sketchId: 'outline', profileId: 'compound', dimensionId: 'compound_radius', value: 12 },
    ] })).toMatchObject({ ok: false, error: { code: 'driven-sketch-dimension' } });
    expect(h.session.getSnapshot()).toBe(linked);

    const feature = object(read.feature), profiles = feature.profiles;
    if (!Array.isArray(profiles)) throw new Error('Missing complete sketch profiles');
    const unlinked = { ...feature, profiles: profiles.map(value => {
      const profile = object(value);
      return profile.id === 'plate' ? { ...profile, geometry: { ...object(profile.geometry), width: 40 } } : profile;
    }) };
    await h.success('cad_edit_document', { expectedVersion: linked.version, edits: [
      { kind: 'update-feature', feature: unlinked },
      { kind: 'remove-sketch-dimension', sketchId: 'outline', profileId: 'plate', dimensionId: 'plate_width' },
    ] });
    const freed = h.session.getSnapshot();
    const current = await h.success('cad_get_feature', { expectedVersion: freed.version, featureId: 'outline' });
    expect(current.feature).toMatchObject({ profiles: [
      { geometry: { width: 40 } }, { geometry: { radius: 'boreRadius' } },
      { geometry: { width: 'plateSize' } }, { geometry: { radius: 'boreRadius * 2' } },
    ] });
    expect(freed.document.parameters).toEqual({ plateSize: 40, boreRadius: 5 });
    await h.success('cad_history', { expectedVersion: freed.version, direction: 'undo' });
    expect(h.session.getSnapshot().document).toEqual(linked.document);
    await h.success('cad_history', { expectedVersion: h.session.getSnapshot().version, direction: 'redo' });
    expect(h.session.getSnapshot().document).toEqual(freed.document);
    await h.success('cad_edit_document', { expectedVersion: h.session.getSnapshot().version, edits: [{ kind: 'set-parameter', name: 'plateSize', value: 50 }] });
    const after = await h.success('cad_measure_sketch', { expectedVersion: h.session.getSnapshot().version, sketchId: 'outline' });
    expect(after.materialAreaMm2).toBeCloseTo(800 - 25 * Math.PI, 8);
  });
  it('discovers a pinned gear, constructs a grouped part, corrects its drivers, and saves/exports without losing aliases or recipe identity', async () => {
    const h = await mount(), before = h.session.getSnapshot();
    await h.success('cad_create_document', { expectedVersion: before.version, name: 'Agent gear' });
    const listing = await h.success('cad_list_plugins', { limit: 10 });
    if (!Array.isArray(listing.items)) throw new Error('Missing plugin list');
    const pin = listing.items.map(object).find(row => row.id === 'wireedm.spur-gear' && row.version === '3.0.0');
    if (!pin) throw new Error('Missing configurable gear package');
    let offset: unknown = 0, text = '';
    while (offset !== null) {
      const chunk = await h.success('cad_read_plugin', { id: pin.id, version: pin.version, packageHash: pin.packageHash, offset, length: 512 });
      if (typeof chunk.text !== 'string') throw new Error('Missing exact package text');
      text += chunk.text; offset = chunk.nextOffset;
    }
    const recipe = parseCadPluginPackage(JSON.parse(text));
    await h.success('cad_edit_document', { expectedVersion: h.session.getSnapshot().version, edits: [
      { kind: 'add-feature', feature: { id: 'section', kind: 'sketch', name: 'Gear section', suppressed: false, plane: 'XY', offset: 0, profiles: [] } },
      { kind: 'add-plugin-profile', sketchId: 'section', profileId: 'gear', name: 'Gear', package: recipe, groupId: 'drivers' },
      { kind: 'set-parameter', name: 'boreRadius', value: 2 },
    ] });
    const grouped = h.session.getSnapshot(), sketch = grouped.document.features[0];
    const gear = sketch.kind === 'sketch' ? sketch.graph?.relations.find((relation): relation is CadSketchGenerator => relation.kind === 'generator') : undefined;
    if (sketch.kind !== 'sketch' || !gear) throw new Error('Missing generated gear');
    expect(sketch.profiles).toEqual([]);
    const geometry = gear.geometry;
    if (geometry.kind !== 'plugin') throw new Error('Missing generated gear recipe');
    const moduleAlias = geometry.inputs.module, teethAlias = geometry.inputs.teeth;
    if (typeof moduleAlias !== 'string' || typeof teethAlias !== 'string') throw new Error('Gear drivers are not linked');
    const inspected = await h.success('cad_inspect_plugin', { expectedVersion: grouped.version, sketchId: sketch.id, profileId: gear.id });
    expect(inspected.derived).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'pitchDiameter', value: 54 })]));
    await expect(h.call('cad_edit_document', { expectedVersion: grouped.version, edits: [{ kind: 'set-parameter', name: teethAlias, value: 4 }] }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-sketch-generator', message: expect.stringContaining('Spur gear "gear": Teeth') } });
    // The gear's sketch is solved before the edit, so its preparation republishes the snapshot; the draft itself is unchanged.
    expect(h.session.getSnapshot()).toMatchObject({ version: grouped.version, document: grouped.document });
    expect(h.session.getSnapshot().document).toBe(grouped.document);
    await h.success('cad_edit_document', { expectedVersion: grouped.version, edits: [
      { kind: 'set-parameter', name: moduleAlias, value: 4 },
      { kind: 'set-sketch-generator', sketchId: sketch.id, generator: { ...gear, geometry: { ...geometry, inputs: { ...geometry.inputs, cutterTipMode: 1, cutterTipRadius: 0.5 } } } },
      { kind: 'set-sketch-generator', sketchId: sketch.id, generator: { id: 'bore', kind: 'generator', idPrefix: 'bore', name: 'Bore', construction: false, geometry: { kind: 'circle', x: 0, y: 0, radius: 'boreRadius' } } }
    ] });
    const corrected = h.session.getSnapshot();
    const resolved = await h.success('cad_inspect_plugin', { expectedVersion: corrected.version, sketchId: sketch.id, profileId: gear.id });
    expect(resolved.derived).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'pitchDiameter', value: 72 }), expect.objectContaining({ name: 'effectiveCutterTipRadius', value: 0.5 })
    ]));
    await expect(h.call('cad_measure_sketch', { expectedVersion: grouped.version, sketchId: sketch.id })).resolves.toMatchObject({ ok: false, error: { code: 'STALE_STATE' } });
    const abort = new AbortController(); abort.abort();
    await expect(h.call('cad_save_document', { expectedVersion: corrected.version }, abort.signal)).resolves.toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(h.session.getSnapshot()).toBe(corrected);
    await h.success('cad_history', { expectedVersion: corrected.version, direction: 'undo' }); expect(h.session.getSnapshot().document).toEqual(grouped.document);
    await h.success('cad_history', { expectedVersion: h.session.getSnapshot().version, direction: 'redo' }); expect(h.session.getSnapshot().document).toEqual(corrected.document);
    const version = h.session.getSnapshot().version;
    expect(await h.success('cad_save_document', { expectedVersion: version })).toMatchObject({ saved: true, draftMarkedSaved: true });
    expect((await loadCadDocument(h.workbench.adapter, corrected.document.id)).document).toEqual(corrected.document);
    const blobs: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { if (blob instanceof Blob) blobs.push(blob); return `blob:cad-agent-${blobs.length}`; });
    const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    await h.success('cad_export_dxf', { expectedVersion: version, sketchId: sketch.id });
    await h.success('cad_export_document', { expectedVersion: version });
    const read = (blob: Blob) => new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsText(blob); });
    expect(parseDxf(await read(blobs[0])).entities).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'circle', radius: 2 })]));
    // The export carries the generator records alone; a load makes their members again.
    expect(JSON.parse(await read(blobs[1]))).toEqual(storedCadDocument(corrected.document));
    const exported = h.session.getSnapshot().document.features[0], exportedGear = exported.kind === 'sketch' ? cadSketchProfileViews(exported)[0]?.geometry : undefined;
    expect(exportedGear?.kind === 'plugin' && exportedGear.package).toEqual(recipe);
    expect(exportedGear?.kind === 'plugin' && exportedGear.inputs.module).toBe(moduleAlias);
    expect(download).toHaveBeenCalledTimes(2); expect(h.session.getSnapshot()).toMatchObject({ version, dirty: false });
  });
});
