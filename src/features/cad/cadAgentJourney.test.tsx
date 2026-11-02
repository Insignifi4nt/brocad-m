import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { createBrowserCacheAdapter } from '@/domain/storage/browserCacheAdapter';
import { initializeWorkbenchCatalog } from '@/domain/workbench-catalog/workbenchCatalog';
import { loadCadDocument } from '@/domain/cad/cadStorage';
import { CAD_GEAR_V3_PLUGIN, createCadPluginProfile, parseCadPluginPackage } from '@/domain/cad/plugins/cadPlugins';
import { parseDxf } from '@/domain/dxf/parseDxf';
import type { CadEdit } from '@/domain/cad/cadOperations';
import type { CadSketchGenerator } from '@/domain/cad/cadSketchGraph';
import { compileCadSketchGraph } from '@/domain/cad/cadSketchGraphGeometry';
import { storedCadDocument } from '@/domain/cad/cadStoredDocument';
import { cadSketchProfileViews } from '@/domain/cad/sketch-generators/cadSketchProfileViews';
import { expandCadSketchGenerators } from '@/domain/cad/sketch-generators/cadSketchGenerators';
import { CAD_SKETCH_GENERATOR_KINDS } from '@/domain/cad/sketch-generators/cadSketchGeneratorKinds';
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

  it('previews a linked offset and a circular pattern by proposal, then applies the same fields, confirming the removal the preview named', async () => {
    const h = await mount(), empty = h.session.getSnapshot(), corners = [[0, 0], [10, 0], [10, 10], [0, 10]];
    await h.success('cad_edit_document', { expectedVersion: empty.version, edits: [{ kind: 'set-parameter', name: 'gap', value: 2 },
      { kind: 'add-feature', feature: { id: 'plate', name: 'Plate', kind: 'sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
        points: [...corners.map((position, at) => ({ id: `p${at}`, position })), { id: 'a', position: [20, 0] }, { id: 'b', position: [25, 0] }, { id: 'u', position: [0, -25] }],
        entities: [...corners.map((_, at) => ({ id: `l${at}`, kind: 'line', construction: false, startPointId: `p${at}`, endPointId: `p${(at + 1) % 4}` })),
          { id: 's', kind: 'line', construction: true, startPointId: 'a', endPointId: 'b' }], relations: [] } } }] });
    const seeded = h.session.getSnapshot(), query = { expectedVersion: seeded.version, sketchId: 'plate', mode: 'graph-cells' };
    const offset = { id: 'wall', kind: 'generator', idPrefix: 'wall', construction: false,
      geometry: { kind: 'offset', chain: [0, 1, 2, 3].map(at => ({ entityId: `l${at}`, reversed: false })), distance: 'gap' } };
    const pattern = { id: 'spokes', kind: 'generator', idPrefix: 'spokes', construction: true, geometry: { kind: 'circular-pattern', seedIds: ['s'], centerId: '@origin', count: 4, angle: 360 } };
    // The offset's cells, read before anything is applied, at a trial gap.
    const areas = (result: Record<string, unknown>) => (result.items as { areaMm2: number }[]).map(item => item.areaMm2).sort((x, y) => x - y);
    const previewed = await h.success('cad_inspect_sketch_regions', { ...query, proposal: { generator: { generator: offset }, parameterValues: { gap: 3 } } });
    expect(previewed).toMatchObject({ proposed: true, total: 2 }); expect(areas(previewed)).toEqual([100, 256 - 100]);
    expect(h.session.getSnapshot()).toBe(seeded);
    await h.success('cad_edit_document', { expectedVersion: seeded.version, edits: [{ kind: 'set-sketch-generator', sketchId: 'plate', generator: offset },
      { kind: 'set-sketch-generator', sketchId: 'plate', generator: pattern }, { kind: 'set-sketch-relation', sketchId: 'plate', relation: { id: 'tie', kind: 'coincident', pointIds: ['u', 'spokes_i3_b'] } }] });
    const applied = h.session.getSnapshot();
    expect(areas(await h.success('cad_inspect_sketch_regions', { ...query, expectedVersion: applied.version }))).toEqual([96, 100]);
    // Three spokes lose the fourth, which the free point is tied to: the preview names the relation before any edit is sent.
    const fewer = { generator: { ...pattern, geometry: { ...pattern.geometry, count: 3 } } };
    expect(await h.call('cad_inspect_sketch_regions', { ...query, expectedVersion: applied.version, proposal: { generator: fewer } })).toMatchObject({ ok: false, error: {
      code: 'unconfirmed-sketch-generator-removals', message: expect.stringContaining('Circular pattern "spokes" no longer generates geometry'), details: { version: applied.version, relationIds: ['tie'], relationCount: 1 } } });
    const confirmed = { ...fewer, removedRelationIds: ['tie'] };
    expect(await h.success('cad_inspect_sketch_regions', { ...query, expectedVersion: applied.version, proposal: { generator: confirmed } })).toMatchObject({ proposed: true });
    await h.success('cad_edit_document', { expectedVersion: applied.version, edits: [{ kind: 'set-sketch-generator', sketchId: 'plate', ...confirmed }] });
    const sketch = h.session.getSnapshot().document.features[0];
    if (sketch.kind !== 'sketch' || !sketch.graph) throw new Error('Missing plate.');
    expect(sketch.graph.relations.map(relation => relation.id)).toEqual(['wall', 'spokes']);
    expect(sketch.graph.relations.find(relation => relation.id === 'spokes')).toEqual({ ...pattern, geometry: { ...pattern.geometry, count: 3 } });
    await h.success('cad_history', { expectedVersion: h.session.getSnapshot().version, direction: 'undo' });
    expect(h.session.getSnapshot().document).toEqual(applied.document);
    // A proposed cell's reference is read as the edit makes it: the same text as the reference read after that edit is applied.
    const restored = h.session.getSnapshot(), wider = { ...offset, geometry: { ...offset.geometry, distance: 'gap + 1' } };
    const cells = await h.success('cad_inspect_sketch_regions', { ...query, expectedVersion: restored.version, proposal: { generator: { generator: wider } } });
    const outer = (cells.items as { cellId: number; areaMm2: number }[]).reduce((x, y) => y.areaMm2 > x.areaMm2 ? y : x).cellId;
    const read = async (version: string, proposal?: unknown) => {
      const chunk = await h.success('cad_read_sketch_region_reference', { expectedVersion: version, sketchId: 'plate', cellIds: [outer], ...proposal ? { proposal } : {} });
      return { text: chunk.text, totalLength: chunk.totalLength };
    };
    const proposed = await read(restored.version, { generator: { generator: wider } });
    await h.success('cad_edit_document', { expectedVersion: restored.version, edits: [{ kind: 'set-sketch-generator', sketchId: 'plate', generator: wider }] });
    expect(await read(h.session.getSnapshot().version)).toEqual(proposed);
  });

  it("previews a generator in a sketch that uses a preceding sketch's line, with the cells and references the applied edit gives", async () => {
    const h = await mount(), empty = h.session.getSnapshot(), sketch = (id: string, offset: number, graph: unknown) => ({ id, name: id, kind: 'sketch', suppressed: false, plane: 'XY', offset, profiles: [], graph });
    const plate = (width: number) => ({ id: 'rect', kind: 'generator', idPrefix: 'rect', construction: false, geometry: { kind: 'rectangle', x: 0, y: 0, width, height: 10, cornerRadius: 0 } });
    await h.success('cad_edit_document', { expectedVersion: empty.version, edits: [
      { kind: 'add-feature', feature: sketch('layout', 0, { points: [{ id: 'a', position: [50, 0] }, { id: 'b', position: [60, 0] }],
        entities: [{ id: 'line', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' }], relations: [] }) },
      { kind: 'add-feature', feature: sketch('target', 5, { points: [], entities: [], relations: [plate(20)] }) },
      { kind: 'use-sketch-entity', sketchId: 'target', sourceSketchId: 'layout', sourceEntityId: 'line', idPrefix: 'ref' },
      // A triangle whose base ends are tied to the reference's ends.
      { kind: 'append-sketch-entities', sketchId: 'target', geometry: { points: [{ id: 'm', position: [50, 0] }, { id: 'apex', position: [55, 10] }, { id: 'n', position: [60, 0] }],
        entities: [['up', 'm', 'apex'], ['down', 'apex', 'n'], ['base', 'n', 'm']].map(([id, startPointId, endPointId]) => ({ id, kind: 'line', construction: false, startPointId, endPointId })),
        relations: [{ id: 'at-m', kind: 'coincident', pointIds: ['m', 'ref_p0'] }, { id: 'at-n', kind: 'coincident', pointIds: ['n', 'ref_p1'] }] } }] });
    const seeded = h.session.getSnapshot(), proposal = { generator: { generator: plate(30) } };
    const cells = async (version: string, extra = {}) => {
      const result = await h.success('cad_inspect_sketch_regions', { expectedVersion: version, sketchId: 'target', mode: 'graph-cells', ...extra });
      const items = (result.items as { cellId: number; areaMm2: number }[]).sort((x, y) => x.areaMm2 - y.areaMm2), texts = [];
      for (const item of items) texts.push((await h.success('cad_read_sketch_region_reference', { expectedVersion: version, sketchId: 'target', cellIds: [item.cellId], ...extra })).text);
      return { areas: items.map(item => item.areaMm2), texts };
    };
    expect((await cells(seeded.version)).areas).toEqual([expect.closeTo(50, 9), expect.closeTo(200, 9)]);
    const proposed = await cells(seeded.version, { proposal });
    expect(proposed.areas).toEqual([expect.closeTo(50, 9), expect.closeTo(300, 9)]);
    expect(h.session.getSnapshot()).toBe(seeded);
    await h.success('cad_edit_document', { expectedVersion: seeded.version, edits: [{ kind: 'set-sketch-generator', sketchId: 'target', ...proposal.generator }] });
    expect(await cells(h.session.getSnapshot().version)).toEqual(proposed);
  });

  it('lists the generator edits and every shape a generator makes in the context inventory, each edit one the catalog describes', async () => {
    const h = await mount(), supported = object((await h.success('cad_get_context', {})).supported), entities = object(supported.sketchEntities);
    expect(entities.edits).toEqual(expect.arrayContaining(['set-sketch-generator', 'detach-sketch-generator']));
    expect(entities.generators).toEqual(expect.stringContaining('inputs size and place it'));
    expect([...supported.sketches as string[]].sort()).toEqual(Object.keys(CAD_SKETCH_GENERATOR_KINDS).sort());
    const kinds = ((await h.success('cad_describe_edits', {})).items as { kind: string }[]).map(item => item.kind);
    for (const kind of entities.edits as string[]) expect(kinds, kind).toContain(kind);
  });

  it('lists a removal too large for one refusal a page at a time at its version, and applies it once every ID is confirmed', async () => {
    const h = await mount(), empty = h.session.getSnapshot();
    const polygon: CadSketchGenerator = { id: 'poly', kind: 'generator', idPrefix: 'poly', construction: false,
      geometry: { kind: 'regular-polygon', x: 0, y: 0, radius: 10, sides: 'n', directionId: '@h' } };
    const corner = expandCadSketchGenerators({ points: [], entities: [], relations: [polygon] }, { n: 6 }).points.find(point => point.id === 'poly_v5')!.position;
    // Two hundred points tied to the sixth corner. The first hundred IDs are as long as an ID may be, so 62 fill a page's 6 KiB of IDs;
    // the short rest stop at 64 IDs a page.
    const ids = Array.from({ length: 200 }, (_, at) => at < 100 ? `tie-${at}-`.padEnd(96, 'x') : `tie-${at}`);
    await h.success('cad_edit_document', { expectedVersion: empty.version, edits: [{ kind: 'set-parameter', name: 'n', value: 6 }, { kind: 'set-parameter', name: 'spare', value: 0 },
      { kind: 'add-feature', feature: { id: 'plate', name: 'Plate', kind: 'sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [],
        graph: { points: ids.map((_, at) => ({ id: `u${at}`, position: corner })), entities: [],
          relations: [polygon, ...ids.map((id, at) => ({ id, kind: 'coincident', pointIds: [`u${at}`, 'poly_v5'] }))] } } }] });
    const seeded = h.session.getSnapshot(), fewer = { kind: 'set-parameter', name: 'n', value: 5 }, sent: string[] = [], pages: number[] = [];
    for (;;) {
      expect(pages.length).toBeLessThan(4);
      const response = object(await h.call('cad_edit_document', { expectedVersion: seeded.version, edits: [{ ...fewer, ...sent.length ? { removedRelationIds: sent } : {} }] }));
      expect(new TextEncoder().encode(JSON.stringify(response)).length).toBeLessThanOrEqual(32 * 1024);
      // The message names the generator and says how to confirm, whole, however long the IDs it would list.
      expect(response).toMatchObject({ ok: false, error: { code: 'unconfirmed-sketch-generator-removals', message: expect.stringMatching(/^Regular polygon "poly" .*removedRelationIds/),
        details: { version: seeded.version, relationCount: 200, confirmedCount: sent.length } } });
      expect(object(response.error).messageTruncated).toBeUndefined();
      expect(h.session.getSnapshot().document).toBe(seeded.document);
      const details = object(object(response.error).details), page = details.relationIds as string[];
      pages.push(page.length);
      // While it fits, the message is the edit's own, which says to send them all.
      if (!sent.length) expect(object(response.error).message).toContain('Send all 200 IDs as removedRelationIds');
      expect(details.omittedRelationCount).toBe(200 - sent.length - page.length);
      sent.push(...page);
      if (details.omittedRelationCount === 0) break;
    }
    expect(pages).toEqual([62, 64, 64, 10]); expect(sent).toEqual(ids);
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

  it('pages one relation ID that a hundred sketches share, listing it on every page, and confirms it in all of them in one step', async () => {
    const h = await mount(), empty = h.session.getSnapshot();
    const polygon: CadSketchGenerator = { id: 'poly', kind: 'generator', idPrefix: 'poly', construction: false,
      geometry: { kind: 'regular-polygon', x: 0, y: 0, radius: 10, sides: 'n', directionId: '@h' } };
    const corner = expandCadSketchGenerators({ points: [], entities: [], relations: [polygon] }, { n: 6 }).points.find(point => point.id === 'poly_v5')!.position;
    // The same long relation ID ties a point to the sixth corner in each of a hundred sketches with long IDs, so its rows overflow one page.
    const tie = `tie-${'x'.repeat(80)}`, sketchIds = Array.from({ length: 100 }, (_, at) => `s${at}${'x'.repeat(80)}`);
    const sketch = (id: string) => ({ kind: 'add-feature', feature: { id, name: 'Plate', kind: 'sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [],
      graph: { points: [{ id: 'u', position: corner }], entities: [], relations: [polygon, { id: tie, kind: 'coincident', pointIds: ['u', 'poly_v5'] }] } } });
    await h.success('cad_edit_document', { expectedVersion: empty.version, edits: [{ kind: 'set-parameter', name: 'n', value: 6 }, ...sketchIds.slice(0, 50).map(sketch)] });
    await h.success('cad_edit_document', { expectedVersion: h.session.getSnapshot().version, edits: sketchIds.slice(50).map(sketch) });
    const seeded = h.session.getSnapshot(), fewer = { kind: 'set-parameter', name: 'n', value: 5 };
    const response = object(await h.call('cad_edit_document', { expectedVersion: seeded.version, edits: [fewer] }));
    expect(new TextEncoder().encode(JSON.stringify(response)).length).toBeLessThanOrEqual(32 * 1024);
    expect(h.session.getSnapshot().document).toBe(seeded.document);
    expect(response).toMatchObject({ ok: false, error: { code: 'unconfirmed-sketch-generator-removals', message: expect.stringMatching(/^Regular polygon "poly" and 99 more .*removedRelationIds/) } });
    expect(object(response.error).messageTruncated).toBeUndefined();
    // The page names the ID whole, places it in as many sketches as fit after it, and counts the rest.
    const details = object(object(response.error).details), rows = details.relations as { sketchId: string; relationId: string }[];
    expect(details).toMatchObject({ version: seeded.version, relationIds: [tie], relationCount: 1, confirmedCount: 0, omittedRelationCount: 0 });
    expect(rows.length).toBeGreaterThan(0); expect(rows.length).toBeLessThan(100);
    expect(new TextEncoder().encode(JSON.stringify([details.relationIds, rows])).length).toBeLessThanOrEqual(12 * 1024);
    expect(rows).toEqual(sketchIds.slice(0, rows.length).map(sketchId => ({ sketchId, relationId: tie })));
    expect(details.omittedRelationRowCount).toBe(100 - rows.length);
    // Sent at the version it was refused at, the one ID removes the tie from every sketch in one step.
    await h.success('cad_edit_document', { expectedVersion: seeded.version, edits: [{ ...fewer, removedRelationIds: details.relationIds }] });
    const applied = h.session.getSnapshot().document;
    expect(applied.parameters.n).toBe(5);
    for (const feature of applied.features) expect(feature.kind === 'sketch' && feature.graph?.relations.some(relation => relation.id === tie), feature.id).toBe(false);
    await h.success('cad_history', { expectedVersion: h.session.getSnapshot().version, direction: 'undo' });
    expect(h.session.getSnapshot().document).toEqual(seeded.document);
  });

  it('refuses a linked offset of a 600-curve gear outline with the bound and the count, and offsets nothing', async () => {
    const h = await mount(), profile = createCadPluginProfile(CAD_GEAR_V3_PLUGIN);
    const gear: CadSketchGenerator = { id: 'gear', kind: 'generator', idPrefix: 'gear', construction: false, geometry: { ...profile, inputs: { ...profile.inputs, teeth: 12 } } };
    await h.success('cad_edit_document', { expectedVersion: h.session.getSnapshot().version, edits: [{ kind: 'add-feature', feature: { id: 'outline', name: 'Outline', kind: 'sketch',
      suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: { points: [], entities: [], relations: [gear] } } }] });
    const seeded = h.session.getSnapshot(), sketch = seeded.document.features.find(feature => feature.id === 'outline');
    if (sketch?.kind !== 'sketch' || !sketch.graph) throw new Error('Sketch missing');
    // The outline's one loop, linked as the offset tool links a loop it is given.
    const [loop] = compileCadSketchGraph(sketch.graph, seeded.document.parameters).cycles;
    expect(loop.sourceRefs).toHaveLength(600);
    const chain = loop.sourceRefs.map(({ entityId, reversed }) => ({ entityId, reversed }));
    const response = await h.call('cad_edit_document', { expectedVersion: seeded.version, edits: [{ kind: 'set-sketch-generator', sketchId: 'outline',
      generator: { id: 'ring', kind: 'generator', idPrefix: 'ring', construction: false, geometry: { kind: 'offset', chain, distance: 1 } } }] });
    expect(response).toEqual({ ok: false, error: { code: 'invalid-sketch-generator',
      message: 'Offset "ring" follows at most 512 curves, and its chain has 600. Offset a longer loop as an independent copy with offset-sketch-loop.' } });
    expect(h.session.getSnapshot()).toBe(seeded);
  });

  it('refuses an edit envelope that is no object, or edits that are no list, with the schema issue and changes nothing', async () => {
    const h = await mount(), before = h.session.getSnapshot();
    const cases: readonly [unknown, string, string][] = [
      [null, '/', 'Expected object'], [[], '/', 'Expected object'], [7, '/', 'Expected object'], ['edits', '/', 'Expected object'], [true, '/', 'Expected object'],
      [{ expectedVersion: before.version, edits: null }, '/edits', 'Expected array'], [{ expectedVersion: before.version, edits: 'set-parameter' }, '/edits', 'Expected array'],
      [{ expectedVersion: before.version, edits: { kind: 'set-parameter', name: 'n', value: 1 } }, '/edits', 'Expected array']
    ];
    for (const [args, path, message] of cases) {
      const response = object(await h.call('cad_edit_document', args));
      expect(response, JSON.stringify(args)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT', details: { issues: expect.arrayContaining([{ path, message }]) } } });
    }
    expect(h.session.getSnapshot()).toBe(before);
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
