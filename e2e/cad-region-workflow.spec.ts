import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/native-sketch-solver';
import type { CadDocument, CadFeature, CadSketchFeature, CadSketchProfile } from '../src/domain/cad/cadDocument';
import type { CadSketchCellReference } from '../src/domain/cad/cadSketchRegionSelection';
import type { CadSketchRegionProposal } from '../src/domain/cad/cadSketchRegionInspection';
import { prepareCadTools, callCadTool as call, rawCadToolCall as raw, cadContext as context, shapeGenerator } from './cad-tool-helpers';

const original = '\uFEFF0\r\nSECTION\r\n2\r\nENTITIES\r\n0\r\nCIRCLE\r\n8\r\n0\r\n10\r\n0\r\n20\r\n0\r\n40\r\n10\r\n0\r\nCIRCLE\r\n8\r\n0\r\n10\r\n0\r\n20\r\n0\r\n40\r\n6\r\n0\r\nENDSEC\r\n0\r\nEOF\r\n';
const circle = (id: string, radius: number, x: number | string = 0): CadSketchProfile => ({ id, name: id, construction: false, geometry: { kind: 'circle', x, y: 0, radius } });
const oldSelection: CadSketchCellReference = { boundaryProfileId: 'outer', voidProfileIds: ['bore'], ancestorProfileIds: [] };
const first: CadSketchFeature = { id: 'first', name: 'First selected sketch', kind: 'sketch', suppressed: false, plane: 'XY', offset: 0,
  source: { format: 'dxf', fileName: 'Contururi originale.dxf', text: original, units: 'mm' },
  profiles: [circle('outer', 10), circle('bore', 6, ' location '), circle('island', 2), circle('separate', 3, 30)] };
const second: CadSketchFeature = { ...first, id: 'second', name: 'Second selected sketch', offset: 10 };
const pad = (id: string, sketchId: string, reference = oldSelection): Extract<CadFeature, { kind: 'extrude' }> => ({
  id, name: id, kind: 'extrude', suppressed: false, sketchId, distance: ' 5e0 ', symmetric: false, operation: 'new', targetId: null, regionSelection: [reference] });
const document: CadDocument = { format: 'wireedm-cad', schemaVersion: 1, id: 'region_journey', name: 'Correlated selected areas', units: 'mm', parameters: { location: 0 },
  features: [first, pad('first_pad', first.id), second, pad('second_pad', second.id)] };

async function readChunks(page: Page, tool: string, input: Record<string, unknown>, length: number) {
  let offset = 0, text = '', total: number | undefined;
  for (;;) {
    const chunk = await call(page, tool, { ...input, offset, length });
    expect(chunk).toMatchObject({ version: input.expectedVersion, offset });
    if (typeof chunk.text !== 'string' || typeof chunk.totalLength !== 'number') throw new Error('Missing exact chunk data');
    total ??= chunk.totalLength; expect(chunk.totalLength).toBe(total); text += chunk.text;
    if (chunk.nextOffset === null) break;
    if (typeof chunk.nextOffset !== 'number' || chunk.nextOffset <= offset) throw new Error('Chunk read did not advance');
    expect(chunk.nextOffset).toBe(text.length); offset = chunk.nextOffset;
  }
  expect(text.length).toBe(total); return text;
}
async function reference(page: Page, version: string, sketchId: string, expected: CadSketchCellReference, proposal?: CadSketchRegionProposal) {
  const text = await readChunks(page, 'cad_read_sketch_region_reference', { expectedVersion: version, sketchId, boundaryProfileId: 'outer',
    ...(proposal ? { proposal } : {}) }, 41);
  const value: unknown = JSON.parse(text); expect(value).toEqual(expected);
  if (!value || typeof value !== 'object' || !('boundaryProfileId' in value) || typeof value.boundaryProfileId !== 'string'
    || !('voidProfileIds' in value) || !Array.isArray(value.voidProfileIds) || !value.voidProfileIds.every((id: unknown): id is string => typeof id === 'string')
    || !('ancestorProfileIds' in value) || !Array.isArray(value.ancestorProfileIds) || !value.ancestorProfileIds.every((id: unknown): id is string => typeof id === 'string')) throw new Error('Invalid exact region reference');
  return { boundaryProfileId: value.boundaryProfileId, voidProfileIds: value.voidProfileIds, ancestorProfileIds: value.ancestorProfileIds };
}

test('agent repairs two correlated selected sources atomically through discovered region reads and exact native history', async ({ page }) => {
  await prepareCadTools(page);
  await page.getByRole('button', { name: 'Design in CAD', exact: true }).click();
  await expect(page.getByRole('main', { name: 'Parametric CAD workbench' })).toBeVisible();
  expect(await call(page, 'cad_describe_features', { kind: 'extrude' })).toMatchObject({ kind: 'extrude', schema: { properties: {
    regionSelection: { anyOf: expect.arrayContaining([expect.objectContaining({ type: 'array', minItems: 1 })]) }
  } } });
  const blank = await context(page);
  await call(page, 'cad_import_document', { expectedVersion: blank.version, document });
  const before = await context(page);
  expect(before).toMatchObject({ featureCount: 4, parameters: { location: 0 }, canUndo: false, canRedo: false, workflowOpen: false });
  expect(before.documentId).not.toBe(document.id); expect(before.documentId).not.toBe(blank.documentId);
  const beforeText = await readChunks(page, 'cad_read_document', { expectedVersion: before.version }, 4096);
  expect(JSON.parse(beforeText)).toEqual({ ...document, id: before.documentId });
  const acceptedPage = await call(page, 'cad_inspect_sketch_regions', { expectedVersion: before.version, sketchId: first.id, limit: 2 });
  expect(acceptedPage).toMatchObject({ version: before.version, sketchId: first.id, total: 4, nextOffset: 2 });
  expect(acceptedPage).not.toHaveProperty('proposed');
  const acceptedTail = await call(page, 'cad_inspect_sketch_regions', { expectedVersion: before.version, sketchId: first.id, offset: 2, limit: 2 });
  expect(acceptedTail).toMatchObject({ total: 4, nextOffset: null, items: [{ boundaryProfileId: 'outer', areaMm2: expect.closeTo(64 * Math.PI, 9), reference: oldSelection }, { boundaryProfileId: 'separate' }] });
  expect(await reference(page, before.version, first.id, oldSelection)).toEqual(oldSelection);

  // Moving the shared bore changes both signatures; a parameter-only edit must
  // not partially accept either source or leave the earlier Pad's old selector.
  expect(await raw(page, 'cad_edit_document', { expectedVersion: before.version, edits: [{ kind: 'set-parameter', name: 'location', value: 50 }] }))
    .toMatchObject({ ok: false, error: { code: 'stale-sketch-region' } });
  expect(await context(page)).toMatchObject({ version: before.version, canUndo: false, canRedo: false });
  expect(await readChunks(page, 'cad_read_document', { expectedVersion: before.version }, 4096)).toBe(beforeText);
  // The new hole is a circle generator, since an edit can no longer add a saved profile; its region is named by its member's stable id.
  const proposedSecond: CadSketchFeature = { ...second, profiles: second.profiles.filter(profile => profile.id !== 'island'),
    graph: { points: [], entities: [], relations: [shapeGenerator(circle('fresh', 1))] } };
  const firstProposal: CadSketchRegionProposal = { parameterValues: { location: 50 } };
  const secondProposal: CadSketchRegionProposal = { sketch: proposedSecond, parameterValues: { location: 50 } };
  const expectedFirst: CadSketchCellReference = { boundaryProfileId: 'outer', voidProfileIds: ['island'], ancestorProfileIds: [] };
  const expectedSecond: CadSketchCellReference = { boundaryProfileId: 'outer', voidProfileIds: ['fresh_k0'], ancestorProfileIds: [] };
  for (const [sketchId, proposal, expected, area] of [[first.id, firstProposal, expectedFirst, 96 * Math.PI], [second.id, secondProposal, expectedSecond, 99 * Math.PI]] as const) {
    expect(await call(page, 'cad_inspect_sketch_regions', { expectedVersion: before.version, sketchId, proposal, limit: 50 }))
      .toMatchObject({ version: before.version, proposed: true, total: 4, nextOffset: null, items: expect.arrayContaining([{ boundaryProfileId: 'outer', name: 'outer', kind: 'circle', depth: 0, defaultMaterial: true,
        areaMm2: expect.closeTo(area, 9), boundaryLengthMm: expect.any(Number), boundsMm: { minX: -10, minY: -10, maxX: 10, maxY: 10 }, reference: expected,
        referenceOmitted: false, voidProfileCount: 1, ancestorProfileCount: 0, referenceLength: expect.any(Number), referenceByteLength: expect.any(Number) }]) });
  }
  const firstReference = await reference(page, before.version, first.id, expectedFirst, firstProposal);
  const secondReference = await reference(page, before.version, second.id, expectedSecond, secondProposal);
  expect(await context(page)).toMatchObject({ version: before.version, canUndo: false, canRedo: false });
  const edits = [{ kind: 'set-parameter', name: 'location', value: 50 }, { kind: 'update-feature', feature: proposedSecond },
    { kind: 'update-feature', feature: pad('first_pad', first.id, firstReference) }, { kind: 'update-feature', feature: pad('second_pad', second.id, secondReference) }];
  await call(page, 'cad_edit_document', { expectedVersion: before.version, edits });
  const after = await context(page); expect(after).toMatchObject({ parameters: { location: 50 }, canUndo: true, canRedo: false, workflowOpen: false });
  expect(after.version).not.toBe(before.version);
  const afterText = await readChunks(page, 'cad_read_document', { expectedVersion: after.version }, 4096);
  expect(JSON.parse(afterText)).toEqual({ ...document, id: before.documentId, parameters: { location: 50 }, features: [first, pad('first_pad', first.id, firstReference), proposedSecond, pad('second_pad', second.id, secondReference)] });
  expect(await call(page, 'cad_build', { expectedVersion: after.version })).toMatchObject({ version: after.version, diagnostics: [], omittedDiagnostics: 0, totalBodies: 2, nextBodyOffset: null,
    bodies: [{ featureId: 'first_pad', volumeMm3: expect.closeTo(480 * Math.PI, 7), solidCount: 1, boundsMm: { min: [-10, -10, 0], max: [10, 10, 5] } },
      { featureId: 'second_pad', volumeMm3: expect.closeTo(495 * Math.PI, 7), solidCount: 1, boundsMm: { min: [-10, -10, 10], max: [10, 10, 15] } }] });
  expect(await raw(page, 'cad_edit_document', { expectedVersion: before.version, edits })).toMatchObject({ ok: false, error: { code: 'STALE_STATE' } });
  expect(await raw(page, 'cad_read_sketch_region_reference', { expectedVersion: before.version, sketchId: first.id, boundaryProfileId: 'outer', proposal: firstProposal }))
    .toMatchObject({ ok: false, error: { code: 'STALE_STATE' } });
  expect(await context(page)).toMatchObject({ version: after.version });
  await call(page, 'cad_edit_document', { expectedVersion: after.version, edits });
  expect(await context(page)).toMatchObject({ version: after.version, canUndo: true, canRedo: false });
  await call(page, 'cad_history', { expectedVersion: after.version, direction: 'undo' });
  const undone = await context(page); expect(undone).toMatchObject({ parameters: { location: 0 }, canUndo: false, canRedo: true });
  expect(await readChunks(page, 'cad_read_document', { expectedVersion: undone.version }, 4096)).toBe(beforeText);
  await call(page, 'cad_history', { expectedVersion: undone.version, direction: 'redo' });
  const redone = await context(page); expect(redone).toMatchObject({ parameters: { location: 50 }, canUndo: true, canRedo: false });
  expect(await readChunks(page, 'cad_read_document', { expectedVersion: redone.version }, 4096)).toBe(afterText);
});
