// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { applyCadEdits, CadEditSchema, type CadEdit } from '@/domain/cad/cadOperations';
import { createCadDocument, parseCadDocument } from '@/domain/cad/cadSchema';
import { prepareCadSketchProfileCopy } from '@/domain/cad/cadSketchProfileCopy';
import { compileCadSketchGraph } from '@/domain/cad/cadSketchGraphGeometry';
import type { CadSketchFeature } from '@/domain/cad/cadDocument';
import type { CadSketchGraph } from '@/domain/cad/cadSketchGraph';
import { cadAnalyticPathMetrics } from '@/domain/cad/cadSketchGeometry';
import { resolveCadSketchPlacement } from '@/domain/cad/cadDatumPlanes';
import { prepareCadDocumentFrames } from '@/domain/cad/cadDocumentFrames';
import { prepareCadSketchCells } from '@/domain/cad/cadSketchRegionInspection';
import { profileCopySlotPart, profileCopyDxfPart, slotProfileCopyRequest, dxfProfileCopyRequest } from '@/domain/cad/__tests__/cadSketchProfileCopyFixtures';
import { needsCadSketchPreparation, prepareCadEdits } from './cadEditPreparation';
import { CadSession } from './cadSession';
import { createCadSketchTestSolver } from './sketch-solver/__tests__/cadSketchTestSolver';

const runtime = createCadSketchTestSolver();

describe('document-level independent profile copy preparation', () => {
  // An imported DXF holds contour generators, which need schema 2.
  it.each([{ part: profileCopySlotPart, request: slotProfileCopyRequest, dof: 10, schema: 1 }, { part: profileCopyDxfPart, request: dxfProfileCopyRequest, dof: 5, schema: 2 }])('prepares the exact known $part.name candidate from schema $schema without changing its source', async ({ part, request, dof, schema }) => {
    const document = part(), source = document.features[0]; if (source.kind !== 'sketch') throw new Error('Profile source missing.');
    const edit = { kind: 'copy-sketch-profile', ...request } as const;
    expect(Value.Check(CadEditSchema, edit)).toBe(true); expect(document.schemaVersion).toBe(schema);
    expect(needsCadSketchPreparation(document, [edit])).toBe(true);
    const before = JSON.stringify(document), copy = prepareCadSketchProfileCopy({ sketch: source, parameters: document.parameters, ...request });
    const expected = parseCadDocument({ ...document, schemaVersion: 2, features: [...document.features, copy.sketch] });
    const prepared = await prepareCadEdits(document, [edit], runtime);
    expect(prepared.document).toEqual(expected); expect(prepared.document.features[0]).toEqual(source);
    expect(prepared.document.parameterGroups).toEqual(document.parameterGroups); expect(prepared.document.parameterMetadata).toEqual(document.parameterMetadata);
    // A DXF source is a graph sketch too, of fixed generated contours, so it is reported beside the copy.
    expect(prepared.sketchDiagnostics.find(entry => entry.sketchId === 'copy')).toEqual({ sketchId: 'copy', diagnostics: { status: 'success', degreesOfFreedom: dof,
      conflictingIds: [], redundantIds: [], partiallyRedundantIds: [], issues: [] } });
    expect(resolveCadSketchPlacement(copy.sketch, document.parameters, prepareCadDocumentFrames(expected))).toEqual(
      resolveCadSketchPlacement(source, document.parameters, prepareCadDocumentFrames(expected)));
    expect(copy.sketch.profiles).toEqual([]); expect(copy.sketch.source).toBeUndefined(); expect(typeof copy.sketch.offset).toBe('number');
    if (!copy.sketch.graph) throw new Error('Copied graph missing.');
    expect(copy.sketch.graph.relations).toEqual([]);
    if (request.profileId === 'contour_1') expect(compileCadSketchGraph(copy.sketch.graph, {}).segments.find(segment => segment.kind === 'arc')).toMatchObject({ radius: 25.4, sweepRadians: Math.PI * 1.5 });
    expect(JSON.stringify(document)).toBe(before);
  });

  it('copies a generated outline as its members with the joints and equal radii they were made with, the outline the legacy profile copies', async () => {
    const legacy = profileCopySlotPart(), source = legacy.features[0]; if (source.kind !== 'sketch') throw new Error('Profile source missing.');
    const [profile] = source.profiles;
    const generated = parseCadDocument({ ...legacy, schemaVersion: 2, features: [{ ...source, profiles: [], graph: { points: [], entities: [],
      relations: [{ id: profile.id, kind: 'generator', idPrefix: profile.id, name: profile.name, construction: false, geometry: profile.geometry }] } }] });
    const edit = { kind: 'copy-sketch-profile', ...slotProfileCopyRequest } as const;
    const prepared = await prepareCadEdits(generated, [edit], runtime), copied = prepared.document;
    expect(copied.features[0]).toEqual(generated.features[0]);
    const graph = (copied.features[1] as CadSketchFeature).graph!, bare = ((await prepareCadEdits(legacy, [edit], runtime)).document.features[1] as CadSketchFeature).graph!;
    // The slot's sides, caps and centres under the copy's prefix, holding what a drawn slot holds; the legacy copy has bare edges.
    expect(graph.entities.map(entity => entity.id)).toEqual(['copy_e0', 'copy_a0', 'copy_e1', 'copy_a1']);
    expect(graph.relations.map(relation => [relation.id, relation.kind])).toEqual([['copy_j0', 'tangent-joint'], ['copy_j1', 'tangent-joint'], ['copy_j2', 'tangent-joint'],
      ['copy_j3', 'tangent-joint'], ['copy_q0', 'equal-radius']]);
    expect(graph.relations[0]).toEqual({ id: 'copy_j0', kind: 'tangent-joint', endpoints: [{ entityId: 'copy_e0', pointId: 'copy_t1' }, { entityId: 'copy_a0', pointId: 'copy_t1' }] });
    expect(bare.relations).toEqual([]);
    const metrics = (copy: CadSketchGraph) => cadAnalyticPathMetrics({ kind: 'path', segments: compileCadSketchGraph(copy, {}).cycles[0].path });
    const [made, drawn] = [metrics(graph), metrics(bare)];
    expect(made.signedArea).toBeCloseTo(drawn.signedArea, 9); expect(made.length).toBeCloseTo(drawn.length, 9);
    expect(prepared.sketchDiagnostics.find(entry => entry.sketchId === 'copy')?.diagnostics).toMatchObject({ status: 'success', conflictingIds: [], redundantIds: [], partiallyRedundantIds: [] });
  });

  it('uses the preceding parameter intent and retains shared datum placement and existing source consumers', async () => {
    const base = profileCopySlotPart(), source = base.features[0]; if (source.kind !== 'sketch') throw new Error('Source missing.');
    const sketch = { ...source, plane: { kind: 'datum-plane', featureId: 'datum' } } as const;
    const cells = prepareCadSketchCells(sketch, base.parameters);
    const document = parseCadDocument({ ...base, features: [{ id: 'datum', kind: 'datum-plane', name: 'Plane', suppressed: false,
      definition: { kind: 'world', basePlane: 'XY', origin: [0, 0, 3], rotation: [0, 0, 30] } }, sketch,
      { id: 'pad', kind: 'extrude', name: 'Original slot', sketchId: 'source', distance: 5, symmetric: false, operation: 'new', targetId: null,
        suppressed: false, regionSelection: cells.pack(cells.cells.map(cell => cell.id)) }] });
    const edit = { kind: 'copy-sketch-profile', ...slotProfileCopyRequest } as const;
    const result = await prepareCadEdits(document, [{ kind: 'set-parameter', name: 'slotLength', value: 40 }, edit], runtime);
    const expectedCopy = prepareCadSketchProfileCopy({ sketch, parameters: { ...document.parameters, slotLength: 40 }, ...slotProfileCopyRequest });
    expect(result.document.features).toEqual([...document.features, expectedCopy.sketch]);
    expect(expectedCopy.sketch.plane).toEqual(sketch.plane); expect(expectedCopy.sketch.offset).toBe(2.5);
    expect(result.document.features[2]).toEqual(document.features[2]);
    const reordered = { ...result.document, features: [expectedCopy.sketch, ...document.features] };
    expect(() => parseCadDocument(reordered)).toThrow();
  });

  it('refuses document-wide feature collisions and unavailable sources atomically without upgrading the accepted source', () => {
    const document = profileCopySlotPart(), session = new CadSession(document), before = session.getSnapshot();
    expect(() => session.edit([{ kind: 'copy-sketch-profile', ...slotProfileCopyRequest, newSketchId: 'source' }], before.version)).toThrowError(expect.objectContaining({ code: 'duplicate-id' }));
    expect(() => applyCadEdits(createCadDocument(), [{ kind: 'copy-sketch-profile', ...slotProfileCopyRequest }])).toThrow();
    expect(session.getSnapshot()).toBe(before); expect(document.schemaVersion).toBe(1);
  });

  it('keeps projection and cancellation failures out of accepted history', async () => {
    const session = new CadSession(profileCopySlotPart()), before = session.getSnapshot();
    const edits = [{ kind: 'copy-sketch-profile', ...slotProfileCopyRequest }] as const satisfies readonly CadEdit[];
    const projected = { solve: async (...args: Parameters<typeof runtime.solve>) => {
      const result = await runtime.solve(...args); if (result.kind !== 'solved') return result;
      return { ...result, graph: { ...result.graph, points: result.graph.points.map(point => ({ ...point, position: [Number(point.position[0]) + 1, point.position[1]] as const })) } };
    } };
    await expect(session.editPrepared(before.version, async document => (await prepareCadEdits(document, edits, projected)).document)).rejects.toMatchObject({ code: 'sketch-profile-copy-intent' });
    expect(session.getSnapshot()).toBe(before);
    const abort = new AbortController(), interrupted = { solve: async (...args: Parameters<typeof runtime.solve>) => { const result = await runtime.solve(...args); abort.abort(); return result; } };
    await expect(session.editPrepared(before.version, async document => (await prepareCadEdits(document, edits, interrupted, abort.signal)).document, abort.signal)).rejects.toThrow();
    expect(session.getSnapshot()).toBe(before);
  });
});
