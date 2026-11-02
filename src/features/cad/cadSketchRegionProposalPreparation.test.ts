// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@/domain/cad/cadDocument';
import type { CadEdit } from '@/domain/cad/cadOperations';
import { createCadDocument, parseCadDocument } from '@/domain/cad/cadSchema';
import { inspectCadSketchRegions, prepareCadSketchCells, readCadSketchRegionReference, type CadSketchRegionProposal } from '@/domain/cad/cadSketchRegionInspection';
import { prepareCadEdits } from './cadEditPreparation';
import { CadSketchPreparationError } from './cadSketchConstraintFeedback';
import { prepareCadSketchRegionProposal } from './cadSketchRegionProposalPreparation';
import { createCadSketchTestSolver } from './sketch-solver/__tests__/cadSketchTestSolver';

const solver = createCadSketchTestSolver();
const prepare = (document: CadDocument, proposal: CadSketchRegionProposal) => prepareCadSketchRegionProposal(document, 'sketch', proposal, solver);
/** The graph cells of `proposal`, read from the part its preparation leaves. */
const read = async (document: CadDocument, proposal: CadSketchRegionProposal, sketchId = 'sketch') => {
  const prepared = await prepareCadSketchRegionProposal(document, sketchId, proposal, solver);
  return inspectCadSketchRegions(prepared.document, sketchId, { mode: 'graph-cells', proposal: prepared.proposal });
};
const refusal = async (work: Promise<unknown>) => {
  const error = await work.then(() => { throw new Error('Expected a refusal.'); }, (caught: unknown) => caught as Error & Record<string, unknown>);
  return { ...error, message: error.message };
};
const plate = (width: number) => ({ id: 'rect', kind: 'generator', idPrefix: 'rect', construction: false,
  geometry: { kind: 'rectangle', x: 0, y: 0, width, height: 10, cornerRadius: 0 } }) as const;

describe('generator region proposals', () => {
  it('are read as their edit is prepared, so free geometry tied to a member moves as the solved edit moves it', async () => {
    const sketch = { id: 'sketch', kind: 'sketch', name: 'Plate', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
      points: [{ id: 'free', position: [20, 0] }, { id: 'centre', position: [25, 5] }],
      entities: [{ id: 'bore', kind: 'circle', construction: false, centerPointId: 'centre', radius: 2 }],
      relations: [plate(20), { id: 'tie', kind: 'coincident', pointIds: ['free', 'rect_p1'] }] } } as const;
    const alone = parseCadDocument({ ...createCadDocument('Anchored', 'anchored'), schemaVersion: 2, features: [sketch] });
    const accepted = alone.features[0]; if (accepted.kind !== 'sketch') throw new Error('Missing plate.');
    // A later pad holds the narrow plate's area. The wider plate takes the bore beside it as a hole, so the pad needs its area chosen
    // again in the same batch, which the proposal must still let an agent read the new cells for.
    const narrow = prepareCadSketchCells(accepted, alone.parameters, 'graph-cells');
    const stock = narrow.pack(narrow.cells.filter(cell => Math.abs(cell.areaMm2 - 200) < 1e-9).map(cell => cell.id));
    const document = parseCadDocument({ ...alone, features: [accepted, { id: 'pad', kind: 'extrude', name: 'Plate stock', sketchId: 'sketch', suppressed: false,
      distance: 5, symmetric: false, operation: 'new', targetId: null, regionSelection: stock }] });
    const edit: CadEdit = { kind: 'set-sketch-generator', sketchId: 'sketch', generator: plate(30) };
    const proposal = { generator: { generator: plate(30) } };
    // The fixed members alone would leave the free point behind, so the cells are never read from the unsolved graph.
    expect(() => inspectCadSketchRegions(document, 'sketch', { proposal })).toThrowError(expect.objectContaining({ code: 'invalid-region-proposal' }));
    const prepared = await prepare(document, proposal), applied = (await prepareCadEdits(alone, [edit], solver)).document;
    const moved = applied.features[0]; if (moved.kind !== 'sketch') throw new Error('Missing wider plate.');
    expect(moved.graph?.points.find(point => point.id === 'free')?.position).toEqual([30, 0]);
    expect(moved.graph?.relations.some(relation => relation.id === 'tie')).toBe(true);
    expect(prepared.proposal).toEqual({ sketch: moved });
    expect(prepared.document.features).toEqual([moved]);
    expect(() => prepareCadSketchCells(moved, applied.parameters, 'graph-cells').resolve(stock)).toThrowError(expect.objectContaining({ code: 'stale-sketch-region' }));
    for (const mode of ['contours', 'graph-cells'] as const) {
      const proposed = inspectCadSketchRegions(prepared.document, 'sketch', { mode, proposal: prepared.proposal });
      expect(proposed.proposed).toBe(true);
      expect(proposed.items).toEqual(inspectCadSketchRegions(applied, 'sketch', { mode }).items);
    }
    const [bore, cell] = inspectCadSketchRegions(applied, 'sketch', { mode: 'graph-cells' }).items.sort((x, y) => x.areaMm2 - y.areaMm2);
    expect([bore.areaMm2, cell.areaMm2]).toEqual([expect.closeTo(4 * Math.PI, 9), expect.closeTo(300 - 4 * Math.PI, 9)]);
    expect(readCadSketchRegionReference(prepared.document, 'sketch', { cellIds: [cell.cellId] }, prepared.proposal))
      .toEqual(readCadSketchRegionReference(applied, 'sketch', { cellIds: [cell.cellId] }));
  });

  it('give the cells, and refuse the removals, of the edit with the same fields and parameter values', async () => {
    const corners = [[0, 0], [10, 0], [10, 10], [0, 10]] as const;
    const offset = { id: 'off', kind: 'generator', idPrefix: 'off', construction: false,
      geometry: { kind: 'offset', chain: [0, 1, 2, 3].map(index => ({ entityId: `l${index}`, reversed: false })), distance: 'gap' } } as const;
    const pattern = { id: 'pat', kind: 'generator', idPrefix: 'pat', construction: true, geometry: { kind: 'circular-pattern', seedIds: ['s'], centerId: '@origin', count: 4, angle: 360 } } as const;
    const document = parseCadDocument({ ...createCadDocument('Generated', 'generated-proposals'), schemaVersion: 2, parameters: { gap: 2 }, features: [{
      id: 'sketch', kind: 'sketch', name: 'Plate', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
        points: [...corners.map((position, index) => ({ id: `p${index}`, position: [...position] as [number, number] })),
          { id: 'a', position: [20, 0] }, { id: 'b', position: [25, 0] }, { id: 'u', position: [0, -25] }],
        entities: [...corners.map((_, index) => ({ id: `l${index}`, kind: 'line' as const, construction: false, startPointId: `p${index}`, endPointId: `p${(index + 1) % 4}` })),
          { id: 's', kind: 'line', construction: true, startPointId: 'a', endPointId: 'b' }],
        relations: [offset, pattern, { id: 'tie', kind: 'coincident', pointIds: ['u', 'pat_i3_b'] }] } }] });
    const areas = async (proposal?: CadSketchRegionProposal) => (proposal ? await read(document, proposal) : inspectCadSketchRegions(document, 'sketch', { mode: 'graph-cells' }))
      .items.map(item => item.areaMm2).sort((x, y) => x - y);
    expect(await areas()).toEqual([196 - 100, 100]);
    // A parameter value and a changed distance are read as the edit reads them.
    const wider = { generator: { generator: { ...offset, geometry: { ...offset.geometry, distance: 'gap + 1' } } }, parameterValues: { gap: 3 } };
    expect(await areas(wider)).toEqual([100, 324 - 100]);
    // A later sketch the value breaks needs repairing in the same batch: only the part up to the proposed sketch is prepared, so the
    // proposal still reads while the whole part refuses.
    const later = parseCadDocument({ ...document, features: [...document.features, { id: 'later', kind: 'sketch', name: 'Pinned', suppressed: false,
      plane: 'XY', offset: 5, profiles: [], graph: { points: [{ id: 'm', position: [0, 0] }, { id: 'n', position: [2, 0] }], entities: [],
        relations: [{ id: 'm-fixed', kind: 'fixed-point', pointId: 'm', position: [0, 0] }, { id: 'n-fixed', kind: 'fixed-point', pointId: 'n', position: [2, 0] }, { id: 'span', kind: 'distance', pointIds: ['m', 'n'], value: 'gap' }] } }] });
    await expect(prepareCadEdits(later, [{ kind: 'set-parameter', name: 'gap', value: 3 }, { kind: 'set-sketch-generator', sketchId: 'sketch', ...wider.generator }], solver)).rejects.toBeInstanceOf(CadSketchPreparationError);
    expect((await read(later, wider)).items.map(item => item.areaMm2).sort((x, y) => x - y))
      .toEqual([100, 324 - 100]);
    // Three occurrences leave the fourth, which the free point is tied to: the proposal refuses as the edit does, with its details.
    const fewer = { ...pattern, geometry: { ...pattern.geometry, count: 3 } };
    for (const removedRelationIds of [undefined, ['other']]) {
      const fields = { generator: fewer, ...removedRelationIds ? { removedRelationIds } : {} };
      const proposed = await refusal(prepare(document, { generator: fields }));
      expect(proposed).toMatchObject({ code: 'unconfirmed-sketch-generator-removals' });
      expect(proposed).toEqual(await refusal(prepareCadEdits(document, [{ kind: 'set-sketch-generator', sketchId: 'sketch', ...fields }], solver)));
    }
    const confirmed = { generator: { generator: fewer, removedRelationIds: ['tie'] } };
    expect(await areas(confirmed)).toEqual([96, 100]);
    await expect(prepare(document, { ...confirmed, offset: {} } as never)).rejects.toMatchObject({ code: 'invalid-region-proposal' });
    // The edit with the same fields gives the cells the proposal showed.
    const applied = (await prepareCadEdits(document, [{ kind: 'set-sketch-generator', sketchId: 'sketch', ...confirmed.generator }], solver)).document;
    expect(inspectCadSketchRegions(applied, 'sketch', { mode: 'graph-cells' }).items)
      .toEqual((await read(document, confirmed)).items);
  });
  it("read a sketch that uses a preceding sketch's line with that sketch as the edit leaves it, solved for the parameter values", async () => {
    // The layout's line runs from (50, 0) to (span, 0). The target uses it as a reference, and a free triangle's base is tied to its ends.
    // The layout itself uses a line of an earlier sketch, so the target needs that sketch through the layout.
    const blank = parseCadDocument({ ...createCadDocument('Linked', 'linked-proposal'), schemaVersion: 2, parameters: { span: 60 }, features: [
      { id: 'base', kind: 'sketch', name: 'Base', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
        points: [{ id: 'c', position: [0, -20] }, { id: 'd', position: [10, -20] }], entities: [{ id: 'axis', kind: 'line', construction: true, startPointId: 'c', endPointId: 'd' }], relations: [] } },
      { id: 'layout', kind: 'sketch', name: 'Layout', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
        points: [{ id: 'a', position: [50, 0] }, { id: 'b', position: ['span', 0] }], entities: [{ id: 'line', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' }], relations: [] } },
      { id: 'target', kind: 'sketch', name: 'Target', suppressed: false, plane: 'XY', offset: 5, profiles: [], graph: {
        points: [], entities: [], relations: [plate(20)] } }] });
    const document = (await prepareCadEdits(blank, [{ kind: 'use-sketch-entity', sketchId: 'layout', sourceSketchId: 'base', sourceEntityId: 'axis', idPrefix: 'axis' },
      { kind: 'use-sketch-entity', sketchId: 'target', sourceSketchId: 'layout', sourceEntityId: 'line', idPrefix: 'ref' },
      { kind: 'append-sketch-entities', sketchId: 'target', geometry: { points: [{ id: 'm', position: [50, 0] }, { id: 'apex', position: [55, 10] }, { id: 'n', position: [60, 0] }],
        entities: [['up', 'm', 'apex'], ['down', 'apex', 'n'], ['base', 'n', 'm']].map(([id, startPointId, endPointId]) => ({ id, kind: 'line' as const, construction: false, startPointId, endPointId })),
        relations: [{ id: 'at-m', kind: 'coincident', pointIds: ['m', 'ref_p0'] }, { id: 'at-n', kind: 'coincident', pointIds: ['n', 'ref_p1'] }] } }], solver)).document;
    const cells = (from: CadDocument) => inspectCadSketchRegions(from, 'target', { mode: 'graph-cells' }).items;
    expect(cells(document).map(item => item.areaMm2).sort((x, y) => x - y)).toEqual([expect.closeTo(50, 9), expect.closeTo(200, 9)]);
    // A complete proposal of the sketch as it is reads as the sketch does.
    const target = document.features[2]; if (target.kind !== 'sketch') throw new Error('Missing target.');
    expect(inspectCadSketchRegions(document, 'target', { mode: 'graph-cells', proposal: { sketch: target } }).items).toEqual(cells(document));
    const wider = { generator: { generator: plate(30) } }, moved = { ...wider, parameterValues: { span: 70 } };
    for (const [proposal, edits] of [[wider, []], [moved, [{ kind: 'set-parameter', name: 'span', value: 70 }]]] as const) {
      const applied = (await prepareCadEdits(document, [...edits, { kind: 'set-sketch-generator', sketchId: 'target', ...proposal.generator }], solver)).document;
      const read = await prepareCadSketchRegionProposal(document, 'target', proposal, solver);
      const proposed = inspectCadSketchRegions(read.document, 'target', { mode: 'graph-cells', proposal: read.proposal });
      expect(proposed.items).toEqual(cells(applied));
      for (const item of proposed.items) expect(readCadSketchRegionReference(read.document, 'target', { cellIds: [item.cellId] }, read.proposal))
        .toEqual(readCadSketchRegionReference(applied, 'target', { cellIds: [item.cellId] }));
    }
    // With span 70 the layout's line is 20 long, so the triangle on it doubles, as the edit makes it.
    const read = await prepareCadSketchRegionProposal(document, 'target', moved, solver);
    expect(inspectCadSketchRegions(read.document, 'target', { mode: 'graph-cells', proposal: read.proposal }).items.map(item => item.areaMm2).sort((x, y) => x - y))
      .toEqual([expect.closeTo(100, 9), expect.closeTo(300, 9)]);
  });
});
