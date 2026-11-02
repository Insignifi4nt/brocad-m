import { placementPart, dPlacement } from '@/domain/cad/__tests__/cadSketchPlacementFixtures';
import { describe, expect, it, vi } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import type { TSchema } from '@sinclair/typebox';
import { CadDocumentSchema, CadFeatureSchema, createCadDocument, parseCadDocument } from '@/domain/cad/cadSchema';
import { applyCadEdits, CadEditSchema } from '@/domain/cad/cadOperations';
import { CadToolEditDefinitions, CadToolEditEnvelope } from './cadToolSchemas';
import { cadSiteTools } from './cadSiteTools';
import type { CadController } from './useCadController';
import type { CadBuildResult } from '@/domain/cad/cadDocument';
import { refs as regionRefs, pad as regionPad, pocket as regionPocket, sketch as regionSketch } from '@/domain/cad/__tests__/cadSketchRegionFixtures';
import { CadSketchSplitDependencyError } from '@/domain/cad/cadSketchSplit';
import { CadSketchTrimDependencyError, CadSketchExtendDependencyError } from '@/domain/cad/cadSketchTrimExtend';
import { endTrim, middleTrim } from '@/domain/cad/__tests__/cadSketchTrimFixtures';
import { lineExtend } from '@/domain/cad/__tests__/cadSketchExtendFixtures';
import { CadSession } from './cadSession';

it('offers explicit graph-cell inspection and unique numeric receipt reads without accepting mixed legacy targets', async () => {
  const controller = vi.fn<() => CadController>(() => { throw new Error('Invalid graph receipt reached operations'); });
  const tools = cadSiteTools(controller), inspect = tools.find(tool => tool.name === 'cad_inspect_sketch_regions'), read = tools.find(tool => tool.name === 'cad_read_sketch_region_reference');
  if (!inspect || !read) throw new Error('Missing region tools');
  expect(Value.Check(inspect.inputSchema, { expectedVersion: 'current', sketchId: 'sketch', mode: 'graph-cells' })).toBe(true);
  expect(Value.Check(read.inputSchema, { expectedVersion: 'current', sketchId: 'sketch', cellIds: [0, 2], proposal: { parameterValues: { separation: 7 } } })).toBe(true);
  for (const cellIds of [[], [0, 0], [-1], [.5], [Infinity], ['0']])
    expect(await read.execute({ expectedVersion: 'current', sketchId: 'sketch', cellIds })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
  expect(await read.execute({ expectedVersion: 'current', sketchId: 'sketch', cellIds: [0], boundaryProfileId: 'old' })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
  expect(await inspect.execute({ expectedVersion: 'current', sketchId: 'sketch', mode: 'guess' })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
  expect(controller).not.toHaveBeenCalled();
});

describe('CAD tool argument boundary and discovery', () => {
  it('discovers strict reference creation and typed source witnesses without accepting caller snapshots', async () => {
    const controller = vi.fn<() => CadController>(() => { throw new Error('Invalid reference reached controller.'); });
    const edit = cadSiteTools(controller).find(tool => tool.name === 'cad_edit_document');
    const discovery = cadSiteTools(() => ({} as CadController)).find(tool => tool.name === 'cad_describe_edits');
    if (!edit || !discovery) throw new Error('Edit tools missing.');
    const request = { kind: 'use-sketch-entity', sketchId: 'target', sourceSketchId: 'layout', sourceEntityId: 'line', idPrefix: 'ref' };
    expect(await discovery.execute({ kind: request.kind })).toMatchObject({ ok: true, data: { schema: { additionalProperties: false,
      required: expect.arrayContaining(['sketchId', 'sourceSketchId', 'sourceEntityId', 'idPrefix']) } } });
    expect(Value.Check(CadEditSchema, request)).toBe(true);
    const relation = { id: 'ref_reference', kind: 'external-reference', entityId: 'ref_e0', sourceSketchId: 'layout',
      source: { kind: 'line', entityId: 'line', startPointId: 'a', endPointId: 'b' } };
    expect(Value.Check(CadEditSchema, { kind: 'set-sketch-relation', sketchId: 'target', relation })).toBe(true);
    for (const invalid of [{ ...request, position: [0, 10] }, { ...request, source: relation.source }, { ...request, idPrefix: 'x'.repeat(65) },
      { kind: 'set-sketch-relation', sketchId: 'target', relation: { ...relation, source: { ...relation.source, position: [0, 10] } } }])
      expect(await edit.execute({ expectedVersion: 'current', edits: [invalid] })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(controller).not.toHaveBeenCalled();
  });
  it('takes a point to line distance only with the side of the line its point keeps', async () => {
    const controller = vi.fn<() => CadController>(() => { throw new Error('A distance without its side reached the controller.'); });
    const edit = cadSiteTools(controller).find(tool => tool.name === 'cad_edit_document');
    if (!edit) throw new Error('Edit tool missing.');
    const relation = { id: 'rib_gap', kind: 'point-line-distance', pointId: 'rib_start', lineId: 'base', side: 'left', value: 12 };
    expect(Value.Check(CadEditSchema, { kind: 'set-sketch-relation', sketchId: 'sketch', relation })).toBe(true);
    const { side: _side, ...sideless } = relation;
    for (const invalid of [sideless, { ...relation, side: 'above' }])
      expect(await edit.execute({ expectedVersion: 'current', edits: [{ kind: 'set-sketch-relation', sketchId: 'sketch', relation: invalid }] })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(controller).not.toHaveBeenCalled();
  });

  it('takes a dimension placement only of its own kind and within bounds, and reads it back', async () => {
    const session = new CadSession(parseCadDocument({ ...createCadDocument(), schemaVersion: 2, features: [{ id: 'sketch', kind: 'sketch', name: 'Bar', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
      points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [10, 0] }], entities: [{ id: 'bar', kind: 'line', startPointId: 'a', endPointId: 'b', construction: false }], relations: [] } }] }));
    const edits = vi.fn((edits: Parameters<CadSession['edit']>[0], version?: string) => session.edit(edits, version));
    const controller = { session, edit: edits, isOpen: () => true, isBusy: () => false, buildState: 'idle', buildVersion: null, build: null } as unknown as CadController;
    const tools = cadSiteTools(() => controller), edit = tools.find(tool => tool.name === 'cad_edit_document'), read = tools.find(tool => tool.name === 'cad_get_feature');
    if (!edit || !read) throw new Error('Edit or read tool missing.');
    const width = { id: 'width', kind: 'distance', pointIds: ['a', 'b'], value: 10 };
    const set = (relation: unknown) => edit.execute({ expectedVersion: session.getSnapshot().version, edits: [{ kind: 'set-sketch-relation', sketchId: 'sketch', relation }] });
    // A placement of another kind, out of range or with other fields never reaches the controller.
    for (const annotation of [{ kind: 'radial', angle: 0, distance: 5 }, { kind: 'linear', offset: 2e6, along: .5 }, { kind: 'linear', offset: 1, along: .5, side: 0 }, { kind: 'linear', offset: 1 }])
      expect(await set({ ...width, annotation })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(edits).not.toHaveBeenCalled();
    // A reference's placement must fit what it measures.
    expect(await set({ id: 'measured', kind: 'reference-dimension', measurement: { kind: 'line-length', entityId: 'bar' }, annotation: { kind: 'radial', angle: 0, distance: 5 } }))
      .toMatchObject({ ok: false, error: { code: 'invalid-sketch-annotation' } });
    expect(session.getSnapshot().canUndo).toBe(false);
    const annotation = { kind: 'linear', offset: -4, along: .25 };
    expect(await set({ ...width, annotation })).toMatchObject({ ok: true });
    expect(await read.execute({ expectedVersion: session.getSnapshot().version, featureId: 'sketch' })).toMatchObject({ ok: true, data: { feature: { graph: { relations: [{ ...width, annotation }] } } } });
  });

  it('returns the warnings an accepted edit\'s sketch solves gave, at most eight with their count, and none where there were none', async () => {
    const session = new CadSession(parseCadDocument({ ...createCadDocument(), schemaVersion: 2 }));
    const warning = (at: number) => ({ code: 'mirror-shrank', relationId: `mirror-${at}`, curves: [{ entityId: 'copy', beforeMm: 10, afterMm: 1e-6 }],
      message: 'Symmetric shrank Line 2 from 10.000 mm to 0.000001 mm. Check the mirror and its relations.', sketchId: 'sketch', sketchName: 'Sketch' });
    let given: readonly ReturnType<typeof warning>[] = [];
    const controller = { session, isOpen: () => true, isBusy: () => false, buildState: 'idle', buildVersion: null, build: null,
      edit: (edits: Parameters<CadSession['edit']>[0], version: string | undefined, _fromAgent: boolean, _signal: AbortSignal | undefined, warned?: (warnings: readonly unknown[]) => void) => {
        const accepted = session.edit(edits, version); warned?.(given); return accepted;
      } } as unknown as CadController;
    const edit = cadSiteTools(() => controller).find(tool => tool.name === 'cad_edit_document');
    if (!edit) throw new Error('Edit tool missing.');
    const rename = (name: string) => edit.execute({ expectedVersion: session.getSnapshot().version, edits: [{ kind: 'rename-document', name }] });
    const quiet = await rename('Quiet');
    expect(quiet).toMatchObject({ ok: true });
    expect(quiet).not.toHaveProperty('data.sketchWarnings');
    given = [warning(1)];
    expect(await rename('One')).toMatchObject({ ok: true, data: { name: 'One', sketchWarnings: { items: [warning(1)], count: 1, omittedCount: 0 } } });
    given = Array.from({ length: 10 }, (_, at) => warning(at));
    expect(await rename('Many')).toMatchObject({ ok: true, data: { sketchWarnings: { items: given.slice(0, 8), count: 10, omittedCount: 2 } } });
  });

  it('discovers the document-level profile copy edit and rejects caller geometry before controller access', async () => {
    const controller = vi.fn<() => CadController>(() => { throw new Error('Malformed profile copy reached controller.'); });
    const tools = cadSiteTools(controller), edit = tools.find(tool => tool.name === 'cad_edit_document');
    const describe = cadSiteTools(() => ({} as CadController)).find(tool => tool.name === 'cad_describe_edits');
    if (!edit || !describe) throw new Error('Missing edit tools.');
    const request = { kind: 'copy-sketch-profile', sourceSketchId: 'source', profileId: 'slot', newSketchId: 'copy', name: 'Editable outline', idPrefix: 'copy' };
    const discovered = await describe.execute({ kind: request.kind });
    expect(discovered).toMatchObject({ ok: true, data: { schema: { additionalProperties: false, required: expect.arrayContaining(['sourceSketchId', 'profileId', 'newSketchId', 'name', 'idPrefix']) } } });
    expect(Value.Check(CadEditSchema, request)).toBe(true);
    for (const invalid of [{ ...request, plane: 'XY' }, { ...request, geometry: {} }, { ...request, targetProfileId: 'other' },
      { ...request, newSketchId: 'bad/id' }, { ...request, name: ' ' }, { ...request, idPrefix: 'x'.repeat(65) }])
      expect(await edit.execute({ expectedVersion: 'current', edits: [invalid] })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(controller).not.toHaveBeenCalled();
  });
  it('shares strict Mirror identities between edit discovery and mutually exclusive read proposals', async () => {
    const controller = vi.fn<() => CadController>(() => { throw new Error('Malformed mirror reached controller.'); });
    const tools = cadSiteTools(controller), reads = tools.filter(tool => tool.name === 'cad_inspect_sketch_regions' || tool.name === 'cad_read_sketch_region_reference');
    const mirror = { entityIds: ['bore'], axisLineId: 'axis', idPrefix: 'mirror' };
    const definition = CadToolEditDefinitions.find(edit => edit.properties.kind.const === 'mirror-sketch-geometry');
    if (!definition) throw new Error('Mirror edit definition missing.');
    expect(Value.Check(definition, { kind: 'mirror-sketch-geometry', sketchId: 'sketch', ...mirror })).toBe(true);
    for (const tool of reads) {
      const query = { expectedVersion: 'current', sketchId: 'sketch', ...(tool.name === 'cad_read_sketch_region_reference' ? { cellIds: [0] } : { mode: 'graph-cells' }) };
      expect(Value.Check(tool.inputSchema, { ...query, proposal: { mirror, parameterValues: { axisX: 35 } } })).toBe(true);
      for (const proposal of [{ mirror, sketch: regionSketch() }, { mirror, offset: {} }, { mirror: { ...mirror, entityIds: [] } },
        { mirror: { ...mirror, entityIds: ['bore', 'bore'] } }, { mirror: { ...mirror, entityIds: Array.from({ length: 65 }, (_, i) => `e${i}`) } },
        { mirror: { ...mirror, reflectedPoints: [[45, 15]] } }, { mirror: { ...mirror, idPrefix: 'x'.repeat(65) } }])
        expect(await tool.execute({ ...query, proposal })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    }
    expect(controller).not.toHaveBeenCalled();
  });
  it('exposes the same strict detached offset request in edit discovery and mutually exclusive region proposals', async () => {
    const controller = vi.fn<() => CadController>(() => { throw new Error('Malformed offset reached controller.'); });
    const tools = cadSiteTools(controller), reads = tools.filter(tool => tool.name === 'cad_inspect_sketch_regions' || tool.name === 'cad_read_sketch_region_reference');
    const offset = { source: { kind: 'graph-cycle', sourceRefs: [{ entityId: 'edge', reversed: false }] }, distance: ' inset ', idPrefix: 'copy' };
    const definition = CadToolEditDefinitions.find(edit => edit.properties.kind.const === 'offset-sketch-loop');
    if (!definition) throw new Error('Offset edit definition missing.');
    expect(Value.Check(definition, { kind: 'offset-sketch-loop', sketchId: 'sketch', ...offset })).toBe(true);
    for (const tool of reads) {
      const query = { expectedVersion: 'current', sketchId: 'sketch', ...(tool.name === 'cad_read_sketch_region_reference' ? { boundaryProfileId: 'circle' } : {}) };
      expect(Value.Check(tool.inputSchema, { ...query, proposal: { offset, parameterValues: { inset: -2 } } })).toBe(true);
      for (const proposal of [{ offset, trim: endTrim }, { offset, sketch: regionSketch() }, { offset: { ...offset, idPrefix: 'x'.repeat(65) } },
        { offset: { ...offset, source: { ...offset.source, sourceRefs: [] } } }, { offset: { ...offset, geometry: {} } }])
        expect(await tool.execute({ ...query, proposal })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    }
    expect(controller).not.toHaveBeenCalled();
  });
  it('exposes line-Extend query and exact proposals with mutually exclusive modes and finite unbounded source parameters', async () => {
    const controller = vi.fn<() => CadController>(() => { throw new Error('Invalid extend reached operations.'); });
    const tools = cadSiteTools(controller), inspect = tools.find(tool => tool.name === 'cad_inspect_sketch_regions'), read = tools.find(tool => tool.name === 'cad_read_sketch_region_reference');
    if (!inspect || !read) throw new Error('Missing region tools.');
    expect(Value.Check(inspect.inputSchema, { expectedVersion: 'current', sketchId: 'regions', extendAt: { entityId: 'ab', end: 'start' } })).toBe(true);
    for (const tool of [inspect, read]) {
      const query = { expectedVersion: 'current', sketchId: 'regions', ...(tool === read ? { boundaryProfileId: 'outer' } : {}) };
      expect(Value.Check(tool.inputSchema, { ...query, proposal: { extend: lineExtend } })).toBe(true);
      expect(Value.Check(tool.inputSchema, { ...query, proposal: { extend: { ...lineExtend, boundary: { ...lineExtend.boundary, parameter: -2e9 } }, parameterValues: { span: 30 } } })).toBe(true);
      for (const proposal of [{ extend: lineExtend, trim: endTrim }, { extend: lineExtend, sketch: regionSketch() }, { extend: lineExtend, split: {} },
        { extend: { ...lineExtend, endPointId: undefined } }, { extend: { ...lineExtend, boundary: { ...lineExtend.boundary, parameter: Infinity } } }])
        expect(await tool.execute({ ...query, proposal })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    }
    for (const mode of [{ extendAt: { entityId: 'ab', end: 'start' }, proposal: { extend: lineExtend } },
      { extendAt: { entityId: 'ab', end: 'start' }, trimAt: { entityId: 'ab', parameter: .1 } },
      { extendAt: { entityId: 'ab', end: 'middle' } }, { extendAt: { entityId: 'ab', end: 'start', parameter: -.25 } }])
      expect(await inspect.execute({ expectedVersion: 'current', sketchId: 'regions', ...mode })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(controller).not.toHaveBeenCalled();
  });

  it('accepts end/middle/circle/delete trim proposals on the existing reads and refuses mixed or unwitnessed input before controller access', async () => {
    const controller = vi.fn<() => CadController>(() => { throw new Error('Malformed trim reached controller.'); });
    const tools = cadSiteTools(controller), inspect = tools.find(tool => tool.name === 'cad_inspect_sketch_regions'), read = tools.find(tool => tool.name === 'cad_read_sketch_region_reference');
    if (!inspect || !read) throw new Error('Missing region reads.');
    const deletion = { kind: 'delete', entityId: 'edge', parameter: .5 };
    const circle = { kind: 'circle', entityId: 'disk', parameter: .25, boundaries: [
      { entityId: 'chord', index: 0, parameter: .1, position: [8, 6], endpointPointId: 'b' },
      { entityId: 'chord', index: 1, parameter: .4, position: [-8, 6], endpointPointId: 'a' }], cutPointIds: ['b', 'a'] };
    const trimEdit = CadToolEditDefinitions.find(schema => schema.properties.kind.const === 'trim-sketch-entity');
    if (!trimEdit) throw new Error('Missing Trim edit discovery.');
    expect(Value.Check(trimEdit, { kind: 'trim-sketch-entity', sketchId: 'sketch', trim: circle })).toBe(true);
    expect(Value.Check(inspect.inputSchema, { expectedVersion: 'current', sketchId: 'regions', trimAt: { entityId: 'ab', parameter: .1 } })).toBe(true);
    // The axes a query names to cut at go beside Trim or Extend, and a target may name one as its boundary.
    expect(Value.Check(inspect.inputSchema, { expectedVersion: 'current', sketchId: 'regions', trimAt: { entityId: 'ab', parameter: .1 }, axes: ['@h', '@v'] })).toBe(true);
    expect(Value.Check(trimEdit, { kind: 'trim-sketch-entity', sketchId: 'sketch', trim: { ...endTrim, boundary: { ...endTrim.boundary, entityId: '@h' } } })).toBe(true);
    for (const input of [{ trimAt: { entityId: 'ab', parameter: .1 }, proposal: { trim: endTrim } },
      { trimAt: { entityId: 'ab', parameter: .1, cutPointId: 'forbidden' } }, { trimAt: { entityId: 'ab', parameter: 2 } },
      { axes: ['@h'] }, { proposal: { trim: endTrim }, axes: ['@h'] }, { trimAt: { entityId: 'ab', parameter: .1 }, axes: ['@origin'] },
      { extendAt: { entityId: 'ab', end: 'start' }, axes: ['@v', '@v'] }])
      expect(await inspect.execute({ expectedVersion: 'current', sketchId: 'regions', ...input })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    for (const tool of [inspect, read]) {
      const query = { expectedVersion: 'current', sketchId: 'regions', ...(tool === read ? { boundaryProfileId: 'outer' } : {}) };
      for (const proposal of [{ trim: endTrim }, { trim: middleTrim }, { trim: circle }, { trim: deletion, parameterValues: { span: 30 } }])
        expect(Value.Check(tool.inputSchema, { ...query, proposal })).toBe(true);
      for (const proposal of [{ trim: endTrim, sketch: regionSketch() }, { trim: endTrim, split: {} },
        { trim: { ...endTrim, boundary: undefined } }, { trim: { ...endTrim, end: 'middle' } },
        { trim: { ...endTrim, boundary: { ...endTrim.boundary, parameter: '0.25' } } },
        { trim: { ...middleTrim, supportRelationId: undefined } }, { trim: { ...middleTrim, boundaries: [middleTrim.boundaries[0]] } },
        { trim: { ...middleTrim, cutPointIds: ['one'] } }, { trim: { ...middleTrim, end: 'start' } },
        { trim: { ...circle, cutPointIds: ['one'] } }, { trim: { ...circle, boundaries: [circle.boundaries[0]] } },
        { trim: { ...circle, newEntityId: 'unused' } },
        { trim: { ...deletion, cutPointId: 'unused' } }, { trim: endTrim, parameterValues: { span: '30' } }]) {
        expect(await tool.execute({ ...query, proposal })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
      }
    }
    expect(controller).not.toHaveBeenCalled();
  });

  it.each([CadSketchTrimDependencyError, CadSketchExtendDependencyError])('bounds exact trim/extend relation and endpoint-driver blocker IDs independently for %s', async DependencyError => {
    const relationIds = Array.from({ length: 12 }, (_, index) => `relation-${index}`), pointIds = Array.from({ length: 10 }, (_, index) => `point-${index}`);
    const failure = new DependencyError(relationIds, pointIds);
    const tool = cadSiteTools(() => { throw failure; }).find(tool => tool.name === 'cad_inspect_sketch_regions');
    if (!tool) throw new Error('Missing region inspection.');
    const proposal = DependencyError === CadSketchTrimDependencyError ? { trim: endTrim } : { extend: lineExtend };
    expect(await tool.execute({ expectedVersion: 'current', sketchId: 'graph', proposal })).toMatchObject({
      ok: false, error: { code: failure.code, details: {
        relationIds: relationIds.slice(0, 8), relationCount: 12, omittedRelationCount: 4,
        pointIds: pointIds.slice(0, 8), pointCount: 10, omittedPointCount: 2
      } }
    });
    expect(failure.relationIds).toEqual(relationIds); expect(failure.pointIds).toEqual(pointIds);
  });

  it.each(['extrude', 'pocket'] as const)('advertises the exact optional closed-cell selection schema for %s without widening other feature kinds', async kind => {
    const describe = cadSiteTools(() => ({} as CadController)).find(tool => tool.name === 'cad_describe_features');
    if (!describe) throw new Error('Missing feature discovery');
    const reply = await describe.execute({ kind }) as { ok: boolean; data: { schema: Parameters<typeof Value.Check>[0]; description: string } };
    expect(reply.ok).toBe(true); expect(reply.data.description).toContain('regionSelection');
    const feature = kind === 'extrude' ? regionPad([regionRefs.outer]) : regionPocket([regionRefs.outer]);
    expect(Value.Check(reply.data.schema, feature)).toBe(true); expect(Value.Check(CadFeatureSchema, feature)).toBe(true);
    for (const regionSelection of [[], [regionRefs.outer, regionRefs.outer], [{ ...regionRefs.outer, nativeKey: 'face' }], [{ ...regionRefs.outer, voidProfileIds: ['bore', 'bore'] }]])
      expect(Value.Check(reply.data.schema, { ...feature, regionSelection })).toBe(false);
    expect(Value.Check(CadFeatureSchema, { id: 'revolve', name: 'Revolve', kind: 'revolve', suppressed: false,
      sketchId: 'regions', angle: 180, axis: 'x', operation: 'new', targetId: null, regionSelection: [regionRefs.outer] })).toBe(false);
  });

  it('keeps region inspection and reference reading narrow and refuses extra or invalid arguments before operations', async () => {
    const controller = vi.fn<() => CadController>(() => { throw new Error('Invalid region query reached operations'); });
    const tools = cadSiteTools(controller), inspect = tools.find(tool => tool.name === 'cad_inspect_sketch_regions');
    const read = tools.find(tool => tool.name === 'cad_read_sketch_region_reference');
    if (!inspect || !read) throw new Error('Missing region inspection/read tools');
    expect(Value.Check(inspect.inputSchema, { expectedVersion: 'current', sketchId: 'regions', offset: 100001, limit: 1 })).toBe(true);
    expect(Value.Check(read.inputSchema, { expectedVersion: 'current', sketchId: 'regions', boundaryProfileId: 'outer', offset: 100001, length: 4096 })).toBe(true);
    for (const proposal of [{ sketch: regionSketch() }, { parameterValues: { location: 50 } }, { sketch: regionSketch(), parameterValues: { location: 50 } }]) {
      expect(Value.Check(inspect.inputSchema, { expectedVersion: 'current', sketchId: 'regions', proposal })).toBe(true);
      expect(Value.Check(read.inputSchema, { expectedVersion: 'current', sketchId: 'regions', boundaryProfileId: 'outer', proposal })).toBe(true);
    }
    for (const input of [{ expectedVersion: 'current', sketchId: 'regions', point: [0, 0] }, { expectedVersion: 'current', sketchId: 'regions', offset: -1 },
      { expectedVersion: 'current', sketchId: 'regions', limit: 0 }, { expectedVersion: 'current', sketchId: 'not/an/id' }])
      expect(await inspect.execute(input)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    for (const input of [{ expectedVersion: 'current', sketchId: 'regions', boundaryProfileId: 'outer', length: 4097 },
      { expectedVersion: 'current', sketchId: 'regions', boundaryProfileId: 'outer', source: 'guess' }, { expectedVersion: 'current', sketchId: 'regions' }])
      expect(await read.execute(input)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    for (const proposal of [{}, { sketch: regionPad() }, { sketch: { ...regionSketch(), profiles: [{ unknown: true }] } },
      { parameterValues: { location: '50' } }, { parameterValues: { location: Infinity } }, { parameters: { location: 50 } }]) {
      expect(await inspect.execute({ expectedVersion: 'current', sketchId: 'regions', proposal })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
      expect(await read.execute({ expectedVersion: 'current', sketchId: 'regions', boundaryProfileId: 'outer', proposal })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    }
    expect(controller).not.toHaveBeenCalled(); expect(inspect.annotations?.readOnlyHint).toBe(true); expect(read.annotations?.readOnlyHint).toBe(true);
  });

  it('accepts split proposals on both existing region reads and rejects mixed/extra arms before controller access', async () => {
    const controller = vi.fn<() => CadController>(() => { throw new Error('Invalid split proposal reached operations'); });
    const tools = cadSiteTools(controller), inspect = tools.find(tool => tool.name === 'cad_inspect_sketch_regions'), read = tools.find(tool => tool.name === 'cad_read_sketch_region_reference');
    if (!inspect || !read) throw new Error('Missing region reads.');
    const line = { kind: 'line', entityId: 'edge', parameter: .5, splitPointId: 'joint', newEntityId: 'second', supportRelationId: 'straight' };
    const arc = { kind: 'arc', entityId: 'edge', parameter: .25, splitPointId: 'joint', newEntityId: 'second' };
    for (const tool of [inspect, read]) {
      const query = { expectedVersion: 'current', sketchId: 'regions', ...(tool === read ? { boundaryProfileId: 'outer' } : {}) };
      for (const proposal of [{ split: line }, { split: arc, parameterValues: { span: 30 } }]) expect(Value.Check(tool.inputSchema, { ...query, proposal })).toBe(true);
      for (const proposal of [{ split: line, sketch: regionSketch() }, { split: { ...line, parameter: 0 } }, { split: { ...arc, supportRelationId: 'unused' } },
        { split: { ...line, newEntityId: undefined } }, { split: { ...line, parameter: '0.5' } }, { split: line, parameterValues: { span: '30' } }, { split: line, edits: [] }]) {
        expect(await tool.execute({ ...query, proposal })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
      }
    }
    expect(controller).not.toHaveBeenCalled();
  });

  it('returns exact bounded split blocker identities without putting machine IDs in the human repair message', async () => {
    const ids = Array.from({ length: 12 }, (_, index) => `whole-edge-${index}`), failure = new CadSketchSplitDependencyError(ids);
    const tools = cadSiteTools(() => { throw failure; }), inspect = tools.find(tool => tool.name === 'cad_inspect_sketch_regions');
    if (!inspect) throw new Error('Missing region inspection.');
    const reply = await inspect.execute({ expectedVersion: 'current', sketchId: 'graph', proposal: {
      split: { kind: 'line', entityId: 'edge', parameter: .5, splitPointId: 'joint', newEntityId: 'second', supportRelationId: 'straight' }
    } });
    expect(reply).toMatchObject({ ok: false, error: { code: 'dependent-sketch-split', details: { relationIds: ids.slice(0, 8), relationCount: 12, omittedRelationCount: 4 } } });
    expect(JSON.stringify(reply)).not.toContain('whole-edge-11'); expect(failure.message).not.toContain(ids[0]);
    expect(failure.relationIds).toEqual(ids);
  });

  it('identifies unselected placement dependencies and preserves the actual session after rejection',async()=>{
    const source=placementPart(),session=new CadSession(source),before=session.getSnapshot();
    const request={kind:'place-sketch-geometry',sketchId:'sketch',...dPlacement,selections:[{kind:'entity',id:'arc'}]}as const;
    const tool=cadSiteTools(()=>{session.edit([request],before.version);throw Error('Expected the incident boundary to reject');}).find(t=>t.name==='cad_edit_document');
    if(!tool)throw Error('Missing edit tool');
    expect(await tool.execute({expectedVersion:before.version,edits:[request]})).toMatchObject({ok:false,error:{code:'dependent-sketch-placement',details:{entityIds:expect.arrayContaining(['chord'])}}});
    expect(session.getSnapshot()).toBe(before);
  });

  it('returns the actual fillet owner for a duplicate tangent without changing accepted source or history', async () => {
    const source = applyCadEdits(parseCadDocument({ ...createCadDocument('Corner'), schemaVersion: 2, features: [{
      id: 'sketch', kind: 'sketch', name: 'Corner', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
        points: [{ id: 'v', position: [0, 0] }, { id: 'a', position: [20, 0] }, { id: 'b', position: [0, 20] }],
        entities: [{ id: 'first', kind: 'line', construction: false, startPointId: 'v', endPointId: 'a' },
          { id: 'second', kind: 'line', construction: false, startPointId: 'v', endPointId: 'b' }], relations: []
      }
    }] }), [{ kind: 'create-sketch-corner', sketchId: 'sketch', pointId: 'v', treatment: {
      kind: 'fillet', radius: 2, trimPointIds: ['trim-a', 'trim-b'], centerPointId: 'center', entityId: 'arc', relationId: 'fillet-owner'
    } }]);
    const session = new CadSession(source), before = session.getSnapshot();
    const duplicate = { kind: 'set-sketch-relation', sketchId: 'sketch', relation: { id: 'duplicate', kind: 'tangent-joint', endpoints: [
      { entityId: 'first', pointId: 'trim-a' }, { entityId: 'arc', pointId: 'trim-a' }
    ] } } as const;
    const tool = cadSiteTools(() => {
      session.edit([duplicate], before.version);
      throw new Error('The fillet-owned contact should have rejected before controller access.');
    }).find(entry => entry.name === 'cad_edit_document');
    if (!tool) throw new Error('Missing edit tool.');
    expect(await tool.execute({ expectedVersion: before.version, edits: [duplicate] })).toMatchObject({ ok: false,
      error: { code: 'already-driven-sketch-tangent', details: { ownerRelationId: 'fillet-owner' } } });
    expect(session.getSnapshot()).toBe(before);
  });

  it('advertises the same complete sketch profile capacity that the shared authoring schema accepts', async () => {
    const tool = cadSiteTools(() => ({} as CadController)).find(entry => entry.name === 'cad_describe_features');
    if (!tool) throw new Error('Missing feature discovery');
    const reply = await tool.execute({ kind: 'sketch' }) as { readonly ok: boolean; readonly data: { readonly schema: Parameters<typeof Value.Check>[0] & { readonly $defs: Record<string, TSchema> } } };
    if (!reply.ok) throw new Error('Expected discovery');
    const data = reply.data, references = Object.values(data.schema.$defs);
    const sketch = { kind: 'sketch', id: 'many', name: 'Many contours', suppressed: false, plane: 'XY', offset: 0,
      profiles: Array.from({ length: 257 }, (_, index) => ({ id: `circle_${index}`, name: `Circle ${index}`, construction: false, geometry: { kind: 'circle', x: index * 4, y: 0, radius: 1 } })) };
    expect(Value.Check(CadFeatureSchema, sketch)).toBe(true); expect(Value.Check(data.schema, references, sketch)).toBe(true);
    expect(Value.Check(data.schema, references, { ...sketch, unknown: true })).toBe(false);
    // Repeated scalar, identifier, element reference, profile geometry and placement schemas are named once, so the definition stays within the reply budget.
    expect(Object.keys(data.schema.$defs)).toEqual(['CadScalar', 'CadIdentifier', 'CadSketchElementId', 'CadProfilePlugin', 'CadProfileRectangle', 'CadProfileCircle', 'CadProfilePolygon',
      'CadProfilePath', 'CadProfileSlot', 'CadSketchLinearAnnotation', 'CadSketchAngleAnnotation', 'CadSketchRadialAnnotation', 'CadSketchSetbacksAnnotation']);
    expect(JSON.stringify(reply).length).toBeLessThan(30 * 1024);
    const graph = (annotation: unknown) => ({ ...sketch, profiles: [], graph: { points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [10, 0] }], entities: [],
      relations: [{ id: 'width', kind: 'distance', pointIds: ['a', 'b'], value: 10, annotation }] } });
    expect(Value.Check(data.schema, references, graph({ kind: 'linear', offset: 5, along: 0.25 }))).toBe(true);
    expect(Value.Check(data.schema, references, graph({ kind: 'radial', angle: 0, distance: 5 }))).toBe(false);
    expect(Value.Check(data.schema, references, graph({ kind: 'linear', offset: 5e6, along: 0.25 }))).toBe(false);
    // A generator reads the same profile geometry by reference.
    const generator = (geometry: unknown) => ({ ...sketch, profiles: [], graph: { points: [], entities: [], relations: [{ id: 'g', kind: 'generator', idPrefix: 'g', construction: false, geometry }] } });
    expect(Value.Check(data.schema, references, generator({ kind: 'slot', x: 0, y: 0, length: 20, width: 'w', angle: 0 }))).toBe(true);
    expect(Value.Check(data.schema, references, generator({ kind: 'regular-polygon', x: 0, y: 0, radius: 5, sides: 6, directionId: '@h' }))).toBe(true);
    expect(Value.Check(data.schema, references, generator({ kind: 'slot', x: 0, y: 0, length: 20 }))).toBe(false);
  });
  it('offers a narrow feature-input build and tokened topology reads without granting editor workflow scope', async () => {
    const controller = vi.fn<() => CadController>(() => { throw new Error('Invalid input reached controller'); });
    const tools = cadSiteTools(controller), build = tools.find(tool => tool.name === 'cad_build_feature_input');
    const inspect = tools.find(tool => tool.name === 'cad_inspect_topology'), resolve = tools.find(tool => tool.name === 'cad_resolve_topology');
    if (!build || !inspect || !resolve) throw new Error('Missing feature-input topology tools');
    expect(Value.Check(build.inputSchema, { expectedVersion: 'current', featureId: 'round', bodyId: 'pad', parameterValues: { height: 15 } })).toBe(true);
    expect(Value.Check(inspect.inputSchema, { expectedVersion: 'current', expectedBuildId: 'input', bodyId: 'pad', kind: 'edge', inputToken: 'input-token' })).toBe(true);
    expect(Value.Check(resolve.inputSchema, { expectedVersion: 'current', expectedBuildId: 'input', bodyId: 'pad', purpose: 'fillet', picks: [{ kind: 'edge', key: 'edge' }], inputToken: 'input-token' })).toBe(true);
    for (const invalid of [{ scope: 'editor' }, { parameterValues: { height: '15' } }, { document: createCadDocument() }]) {
      expect(await build.execute({ expectedVersion: 'current', featureId: 'round', bodyId: 'pad', ...invalid })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    }
    expect(controller).not.toHaveBeenCalled();
  });
  it('reports native solid counts per paginated body and keeps older unknown counts explicitly null', async () => {
    const mesh = { featureId: 'joined', name: 'Joined', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2], edges: [],
      faceGroups: [{ start: 0, count: 3, key: 'face' }], edgeGroups: [], volume: 8064, bounds: { min: [0, 0, 0] as const, max: [24, 20, 20] as const } };
    const build: CadBuildResult = { buildId: 'accepted_join', meshes: [{ ...mesh, solidCount: 2 }, { ...mesh, featureId: 'older', name: 'Older body', volume: 64 }], diagnostics: [], durationMs: 1 };
    const inspectBuild = vi.fn(async () => build), tool = cadSiteTools(() => ({ inspectBuild }) as unknown as CadController).find(entry => entry.name === 'cad_build');
    if (!tool) throw new Error('Missing build tool');
    expect(await tool.execute({ expectedVersion: 'accepted', offset: 0, limit: 1 })).toMatchObject({ ok: true, data: {
      version: 'accepted', buildId: 'accepted_join', totalBodies: 2, nextBodyOffset: 1,
      bodies: [{ featureId: 'joined', volumeMm3: 8064, solidCount: 2 }],
    } });
    expect(await tool.execute({ expectedVersion: 'accepted', offset: 1, limit: 1 })).toMatchObject({ ok: true, data: {
      totalBodies: 2, nextBodyOffset: null, bodies: [{ featureId: 'older', volumeMm3: 64, solidCount: null }],
    } });
    expect(inspectBuild).toHaveBeenCalledTimes(2); expect(inspectBuild).toHaveBeenCalledWith('accepted', expect.any(AbortSignal));
    expect(build.meshes[1]).not.toHaveProperty('solidCount');
  });
  it('advertises plane selection with the shared strict view-only contract and rejects creation or face-derived arguments before operations', async () => {
    const controller = vi.fn<() => CadController>(() => { throw new Error('Invalid plane selection reached operations'); });
    const tool = cadSiteTools(controller).find(tool => tool.name === 'cad_set_viewport');
    if (!tool) throw new Error('Missing viewport tool');
    for (const plane of ['XY', 'XZ', 'YZ', { kind: 'datum-plane', featureId: 'mount' }, null]) {
      expect(Value.Check(tool.inputSchema, { expectedVersion: 'current', command: { kind: 'select-reference-plane', plane } })).toBe(true);
    }
    for (const command of [{ kind: 'select-reference-plane', plane: 'ZX' }, { kind: 'select-reference-plane', plane: { kind: 'face', bodyId: 'stock', key: 'face' } },
      { kind: 'select-reference-plane', plane: { kind: 'datum-plane', featureId: 'mount', offset: 4 } },
      { kind: 'select-reference-plane', plane: 'XY', createSketch: true }, { kind: 'select-reference-plane', plane: 'XY', featureId: 'new_sketch' }]) {
      expect(await tool.execute({ expectedVersion: 'current', command })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    }
    expect(controller).not.toHaveBeenCalled();
  });
  it('advertises dimension intent and translation with the exact shared narrow edit contracts', () => {
    const edit = cadSiteTools(() => { throw new Error('Discovery must not run operations'); }).find(entry => entry.name === 'cad_edit_document');
    if (!edit) throw new Error('Missing CAD edit tool');
    const descriptions = {
      'add-sketch-dimension': 'Driving dimension intent',
      'set-sketch-dimension': 'displayed quantity',
      'remove-sketch-dimension': 'retains the geometry scalar',
      'translate-sketch-profiles': 'expression-driven position',
    };
    expect(edit.inputSchema.properties.edits.items).toBe(CadToolEditEnvelope);
    for (const [kind, meaning] of Object.entries(descriptions)) {
      const declared = CadToolEditDefinitions.find(schema => schema.properties.kind.const === kind);
      const shared = CadEditSchema.anyOf.find(schema => schema.properties.kind.const === kind);
      expect(declared?.description).toContain(meaning);
      expect(declared?.properties).toEqual(shared?.properties);
      expect(declared?.required).toEqual(shared?.required);
      expect(declared?.additionalProperties).toBe(false);
    }
    const dimension = CadToolEditDefinitions.find(schema => schema.properties.kind.const === 'set-sketch-dimension');
    expect(dimension?.description).toContain('Named bindings update parameters');
    expect(dimension?.description).toContain('compound drivers reject');
  });
  it('rejects widened dimension and move arguments before accessing the shared draft', async () => {
    const controller = vi.fn<() => CadController>(() => { throw new Error('Invalid sketch edit reached operations'); });
    const edit = cadSiteTools(controller).find(entry => entry.name === 'cad_edit_document');
    if (!edit) throw new Error('Missing edit tool');
    const add = { kind: 'add-sketch-dimension', sketchId: 'outline', profileId: 'plate', constraint: { id: 'width', kind: 'dimension', quantity: 'width' } };
    const set = { kind: 'set-sketch-dimension', sketchId: 'outline', profileId: 'plate', dimensionId: 'width', value: 'span' };
    const remove = { kind: 'remove-sketch-dimension', sketchId: 'outline', profileId: 'plate', dimensionId: 'width' };
    const move = { kind: 'translate-sketch-profiles', sketchId: 'outline', profileIds: ['plate'], translation: [1, -2] };
    for (const valid of [add, set, remove, move]) expect(Value.Check(edit.inputSchema, { expectedVersion: 'current', edits: [valid] })).toBe(true);
    for (const invalid of [{ ...add, constraint: { ...add.constraint, quantity: 'x' } },
      { ...add, constraint: { ...add.constraint, value: 20 } }, { ...add, constraint: { ...add.constraint, kind: 'fixed' } },
      { ...set, value: { parameter: 'span' } }, { ...set, value: Infinity }, { ...remove, freeze: true },
      { ...move, profileIds: [] }, { ...move, profileIds: ['plate', 'plate'] },
      { ...move, profileIds: Array.from({ length: 257 }, (_, index) => `contour_${index}`) },
      { ...move, translation: [1, 2, 3] }, { ...move, translation: [1, NaN] }, { ...move, force: true }]) {
      expect(await edit.execute({ expectedVersion: 'current', edits: [invalid] })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    }
    expect(controller).not.toHaveBeenCalled();
  });
  it('discovers strict graph authoring edits and rejects implicit repair or widened deletion before draft access', async () => {
    const controller = vi.fn<() => CadController>(() => { throw new Error('Invalid graph edit reached operations'); });
    const tool = cadSiteTools(controller).find(entry => entry.name === 'cad_edit_document');
    if (!tool) throw new Error('Missing CAD edit tool');
    const append = { kind: 'append-sketch-entities', sketchId: 'sketch', geometry: { points: [{ id: 'new', position: [' span ', 0] }],
      entities: [{ id: 'line', kind: 'line', startPointId: 'existing', endPointId: 'new', construction: false }], relations: [] } };
    const remove = { kind: 'delete-sketch-elements', sketchId: 'sketch', pointIds: ['new'], entityIds: [], relationIds: [], cascade: false };
    const construction = { kind: 'set-sketch-construction', sketchId: 'sketch', entityIds: ['line'], construction: true };
    for (const edit of [append, remove, construction]) {
      const declared = CadToolEditDefinitions.find(schema => schema.properties.kind.const === edit.kind);
      const shared = CadEditSchema.anyOf.find(schema => schema.properties.kind.const === edit.kind);
      if (!declared || !shared) throw new Error('Graph edit discovery missing.');
      expect(declared.properties).toEqual(shared.properties);
      expect(declared.required).toEqual(shared.required);
      expect(Value.Check(declared, edit)).toBe(true);
      expect(Value.Check(declared, { ...edit, heal: true })).toBe(false);
    }
    for (const edit of [
      { ...append, geometry: { ...append.geometry, provenance: 'generated' } },
      { ...append, geometry: { ...append.geometry, points: [{ id: 'new', position: [0, 1, 2] }] } },
      { ...remove, pointIds: ['new', 'new'] }, { ...remove, cascade: 'automatic' },
      { kind: 'delete-sketch-elements', sketchId: 'sketch', pointIds: [], entityIds: [], cascade: true },
      { ...construction, entityIds: ['line', 'line'] }, { ...construction, construction: 1 }, { ...construction, force: true }
    ]) expect(await tool.execute({ expectedVersion: 'current', edits: [edit] })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(controller).not.toHaveBeenCalled();
  });
  it('bounds ordered Loft preflight and rejects repair or source payloads before reaching operations', async () => {
    const controller = vi.fn<() => CadController>(() => { throw new Error('Invalid Loft inspection reached the controller'); });
    const inspect = cadSiteTools(controller).find(entry => entry.name === 'cad_inspect_loft');
    if (!inspect) throw new Error('Missing Loft inspection');
    const input = { expectedVersion: 'current', sketchIds: ['lower', 'upper'] };
    expect(Value.Check(inspect.inputSchema, input)).toBe(true);
    for (const invalid of [{ ...input, sketchIds: ['lower'] }, { ...input, sketchIds: ['lower', 'lower'] },
      { ...input, sketchIds: Array.from({ length: 17 }, (_, i) => `section_${i}`) },
      { ...input, sketchIds: ['lower', 'not an id'] }, { ...input, autoSort: true }, { ...input, includeGeometry: true },
      { ...input, ruled: false }, { ...input, targetId: 'body' }]) {
      expect(await inspect.execute(invalid)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    }
    expect(controller).not.toHaveBeenCalled();
  });
  it('discovers world datums and rejects inactive placement fields before shared operations', async () => {
    const controller = vi.fn<() => CadController>(() => { throw new Error('Invalid datum reached the controller'); });
    const tools = cadSiteTools(controller); const edit = tools.find(entry => entry.name === 'cad_edit_document');
    const inspect = tools.find(entry => entry.name === 'cad_inspect_plane');
    if (!edit || !inspect) throw new Error('Missing datum tools');
    const definition = { kind: 'world', basePlane: 'XZ', origin: [0, 0, 12], rotation: [0, 45, 0] };
    const datum = { kind: 'datum-plane', id: 'plane', name: 'Plane', suppressed: false, definition };
    for (const feature of [{ ...datum, definition: { ...definition, normal: [0, 0, 1] } },
      { ...datum, definition: { ...definition, attachment: { bodyId: 'stock' } } },
      { ...datum, definition: { ...definition, rotation: [0, 45] } },
      { ...datum, definition: { ...definition, basePlane: 'ZX' } },
      { ...datum, offset: 4 },
      { kind: 'sketch', id: 'profile', name: 'Profile', suppressed: false, offset: 0, profiles: [],
        plane: { kind: 'datum-plane', featureId: 'plane', normal: [0, 0, 1] } }]) {
      const input = { expectedVersion: 'current', edits: [{ kind: 'add-feature', feature }] };
      expect(Value.Check(edit.inputSchema, input)).toBe(true);
      expect(await edit.execute(input)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    }
    expect(await inspect.execute({ expectedVersion: 'current', featureId: 'plane', includeSource: true }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(controller).not.toHaveBeenCalled();
    const discovery = cadSiteTools(() => ({} as CadController)).find(entry => entry.name === 'cad_describe_features');
    expect(await discovery?.execute({ kind: 'datum-plane' })).toMatchObject({ ok: true, data: {
      kind: 'datum-plane', description: expect.stringContaining('cad_inspect_plane'),
      schema: { additionalProperties: false, properties: { definition: { additionalProperties: false,
        required: expect.arrayContaining(['kind', 'basePlane', 'origin', 'rotation']) } } } } });
  });
  it('discovers strict Through-all Pocket and rejects inactive distance fields before shared operations', async () => {
    const controller = vi.fn<() => CadController>(() => { throw new Error('Invalid Pocket reached the controller'); });
    const edit = cadSiteTools(controller).find(entry => entry.name === 'cad_edit_document');
    if (!edit) throw new Error('Missing edit tool');
    const complete = { kind: 'pocket', id: 'cut', name: 'Through bore', suppressed: false, sketchId: 'bore', targetId: 'stock', extent: { kind: 'through-all', direction: 'both' } };
    for (const feature of [{ ...complete, distance: 100 }, { ...complete, symmetric: true }, { ...complete, operation: 'cut' },
      { ...complete, extent: { kind: 'through-all', direction: 'up' } }, { ...complete, targetId: null }]) {
      const input = { expectedVersion: 'current', edits: [{ kind: 'add-feature', feature }] };
      expect(Value.Check(edit.inputSchema, input)).toBe(true);
      expect(await edit.execute(input)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    }
    expect(controller).not.toHaveBeenCalled();
    const discovery = cadSiteTools(() => ({} as CadController)).find(entry => entry.name === 'cad_describe_features');
    expect(await discovery?.execute({ kind: 'pocket' })).toMatchObject({ ok: true, data: {
      kind: 'pocket', description: expect.stringContaining('XZ -Y'), schema: { additionalProperties: false,
        required: expect.arrayContaining(['sketchId', 'targetId', 'extent']), properties: { extent: { additionalProperties: false } } },
    } });
  });
  it('discovers Sweep and rejects incomplete geometry edits behind compact registration', async () => {
    const controller = vi.fn<() => CadController>(() => { throw new Error('Invalid feature reached the controller'); });
    const tools = cadSiteTools(controller); const edit = tools.find(entry => entry.name === 'cad_edit_document');
    const inspect = tools.find(entry => entry.name === 'cad_inspect_sweep');
    if (!edit || !inspect) throw new Error('Missing Sweep tools');
    const envelope = { kind: 'sweep', id: 'bend', name: 'Bend', suppressed: false };
    const complete = { ...envelope, sketchId: 'section', curveId: 'rail', operation: 'new', targetId: null };
    for (const feature of [envelope, { ...complete, curveId: null }, { ...complete, autoPlace: true }, { ...complete, twist: 90 }]) {
      const input = { expectedVersion: 'current', edits: [{ kind: 'add-feature', feature }] };
      expect(Value.Check(edit.inputSchema, input)).toBe(true);
      expect(await edit.execute(input)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    }
    expect(await inspect.execute({ expectedVersion: 'current', sketchId: 'section', curveId: 'rail', repair: true }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(controller).not.toHaveBeenCalled();
    const discovery = cadSiteTools(() => ({} as CadController)).find(entry => entry.name === 'cad_describe_features');
    expect(await discovery?.execute({ kind: 'sweep' })).toMatchObject({ ok: true, data: { kind: 'sweep',
      description: expect.stringContaining('cad_inspect_sweep'), schema: { additionalProperties: false,
        required: expect.arrayContaining(['sketchId', 'curveId', 'operation', 'targetId']) } } });
  });
  it('keeps registered feature envelopes compact while rejecting invalid complete edits before the controller', async () => {
    const controller = vi.fn<() => CadController>(() => { throw new Error('Invalid feature reached the controller'); });
    const edit = cadSiteTools(controller).find(item => item.name === 'cad_edit_document');
    if (!edit) throw new Error('Missing edit tool');
    const complete = { kind: 'circular-pattern', id: 'array', name: 'Array', suppressed: false,
      sourceId: 'body', count: 4, axis: 'z', center: [0, 0, 0], angle: 360 };
    const envelope = { kind: 'circular-pattern', id: 'array', name: 'Array', suppressed: false };
    for (const feature of [envelope, { ...complete, count: 101 }, { ...complete, center: [0, 0] },
      { ...complete, angle: { value: 360 } }, { ...complete, unexpected: true }, { ...complete, kind: 'unsupported-solid' }]) {
      const input = { expectedVersion: 'current', edits: [{ kind: 'add-feature', feature }] };
      expect(Value.Check(edit.inputSchema, input)).toBe(true);
      expect(await edit.execute(input)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    }
    const update = { expectedVersion: 'current', edits: [{ kind: 'update-feature', feature: envelope }] };
    expect(Value.Check(edit.inputSchema, update)).toBe(true);
    expect(await edit.execute(update)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    let reads = 0;
    const accessor = { ...complete, get count() { reads++; return 4; } };
    expect(await edit.execute({ expectedVersion: 'current', edits: [{ kind: 'add-feature', feature: accessor }] }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    const abort = new AbortController(); abort.abort();
    expect(await edit.execute(update, { signal: abort.signal })).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(reads).toBe(0); expect(controller).not.toHaveBeenCalled();
    expect(JSON.stringify(edit.inputSchema).length).toBeLessThan(JSON.stringify(CadEditSchema).length / 3);
    expect(Value.Check(edit.inputSchema, { ...update, unknown: true })).toBe(false);
    expect(Value.Check(edit.inputSchema, { ...update, edits: Array(129).fill(update.edits[0]) })).toBe(false);
  });
  it('makes no new saved sketch profile through any tool that is not read-only', () => {
    // Saved profiles still load, but no agent tool makes a new one. A tool added here must say what it gives a sketch.
    const sketches: Readonly<Record<string, string>> = {
      cad_edit_document: 'refuses a new saved profile (legacy-sketch-profile), and places a plugin as a plugin generator',
      cad_import_dxf: 'one path or circle generator per contour', cad_import_curve_dxf: 'a curve feature, no sketch', cad_import_solid: 'an imported solid, no sketch',
      cad_create_document: 'an empty draft', cad_history: 'an earlier state of the draft',
      cad_import_document: 'the document as given, as the JSON Import loads a saved one', cad_open_document: 'the saved document as it was',
      ...Object.fromEntries(['cad_install_plugin', 'cad_open_workspace', 'cad_set_viewport', 'cad_capture_preview', 'cad_save_document', 'cad_send_section_to_cam',
        'cad_export_section_dxf', 'cad_send_to_cam', 'cad_export_document', 'cad_export_solid', 'cad_export_dxf', 'cad_export_curve_dxf'].map(name => [name, 'no change']))
    };
    const writing = cadSiteTools(() => { throw new Error('Unused controller'); }).filter(tool => !tool.annotations?.readOnlyHint).map(tool => tool.name);
    expect([...writing].sort()).toEqual(Object.keys(sketches).sort());
  });
  it('retains full import validation behind the compact document registration', async () => {
    const controller = vi.fn<() => CadController>(() => { throw new Error('Invalid document reached the controller'); });
    const tool = cadSiteTools(controller).find(item => item.name === 'cad_import_document');
    if (!tool) throw new Error('Missing import tool');
    const document = { format: 'wireedm-cad', schemaVersion: 1, id: 'part', name: 'Part', units: 'mm', parameters: {},
      features: [{ id: 'import', name: 'Imported', kind: 'imported', suppressed: false,
        source: { format: 'stl', fileName: 'mesh.stl', encoding: 'base64', data: 'AAAA' } }] };
    const input = { expectedVersion: 'current', document };
    expect(Value.Check(tool.inputSchema, input)).toBe(true);
    expect(await tool.execute(input)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(controller).not.toHaveBeenCalled();
    expect(JSON.stringify(tool.inputSchema).length).toBeLessThan(JSON.stringify(CadDocumentSchema).length / 3);
    expect(Value.Check(tool.inputSchema, { ...input, document: { ...document, unknown: true } })).toBe(false);
    const largeEnvelope = { ...input, document: { ...document, features: Array(257).fill(document.features[0]) } };
    expect(Value.Check(tool.inputSchema, largeEnvelope)).toBe(true);
    expect(await tool.execute(largeEnvelope)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(controller).not.toHaveBeenCalled();
  });
  it('rejects inherited and accessor arguments before schema reads or any shared operation', async () => {
    const controller = vi.fn<() => CadController>(() => { throw new Error('A malformed request reached the controller'); });
    const tool = cadSiteTools(controller).find(item => item.name === 'cad_create_document');
    if (!tool) throw new Error('Missing create tool');
    expect(await tool.execute(Object.create({ expectedVersion: 'current', name: 'Part' }))).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    let reads = 0;
    const getter = { name: 'Part', get expectedVersion() { reads++; return 'current'; } };
    expect(await tool.execute(getter)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(reads).toBe(0); expect(controller).not.toHaveBeenCalled();
    const cancellation = new AbortController(); cancellation.abort();
    expect(await tool.execute(getter, { signal: cancellation.signal })).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(reads).toBe(0); expect(controller).not.toHaveBeenCalled();
  });
  it('offers automatically nested sketch authoring while retaining saved legacy schema compatibility', async () => {
    const tool = cadSiteTools(() => ({} as CadController)).find(item => item.name === 'cad_describe_features');
    if (!tool) throw new Error('Missing discovery tool');
    const result = await tool.execute({ kind: 'sketch' });
    expect(result).toMatchObject({ ok: true, data: { kind: 'sketch', schema: { properties: { profiles: { items: { properties: {
      id: expect.anything(), construction: expect.anything(), geometry: expect.anything(),
      constraints: { type: 'array', maxItems: 6, items: { additionalProperties: false, required: ['id', 'kind', 'quantity'], properties: { kind: { const: 'dimension' } } } },
    } } } } } } });
    const text = JSON.stringify(result);
    expect(text).not.toContain('"role"');
    const stored = CadFeatureSchema.anyOf.find(schema => schema.properties.kind.const === 'sketch');
    if (!stored || !('profiles' in stored.properties)) throw new Error('Missing stored sketch schema');
    expect(stored.properties.profiles.items.properties.role).toBeDefined();
  });
  it('discovers the circular pattern contract with explicit total-extent and body-consumption semantics', async () => {
    const tool = cadSiteTools(() => ({} as CadController)).find(item => item.name === 'cad_describe_features');
    if (!tool) throw new Error('Missing discovery tool');
    expect(await tool.execute({})).toMatchObject({ ok: true, data: { items: expect.arrayContaining([
      { kind: 'linear-pattern', description: expect.stringContaining('Fuse') },
      { kind: 'circular-pattern', description: expect.stringContaining('signed total angular extent') }
    ]) } });
    expect(await tool.execute({ kind: 'circular-pattern' })).toMatchObject({ ok: true, data: {
      kind: 'circular-pattern', description: expect.stringContaining('without a duplicate endpoint'),
      schema: { additionalProperties: false, required: expect.arrayContaining(['sourceId', 'count', 'axis', 'center', 'angle']),
        properties: { count: { type: 'integer', minimum: 2, maximum: 100 }, center: { minItems: 3, maxItems: 3 } } }
    } });
  });
});
