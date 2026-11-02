import { describe, expect, it } from 'vitest';
import { prepareCadSketchCells, inspectCadSketchRegions, readCadSketchRegionReference } from '../cadSketchRegionInspection';
import { part, refs, sketch } from './cadSketchRegionFixtures';
import { pad } from './cadSketchRegionFixtures';
import { CadSession } from '@/features/cad/cadSession';
import type { CadSketchFeature } from '../cadDocument';
import { createCadDocument, parseCadDocument } from '../cadSchema';
import { reduceCadEditIntents } from '../cadOperations';
import type { CadSketchRegionProposal } from '../cadSketchRegionInspection';
import { endTrim, trimPart, middleTrim, middleTrimPart } from './cadSketchTrimFixtures';
import { extendPart, lineExtend } from './cadSketchExtendFixtures';
import { offsetCirclePart } from './cadSketchOffsetFixtures';
import { circleTrimPart, lowerDAreaMm2 } from './cadSketchCircleTrimFixtures';
import { middleArcTrimPart, clippedDAreaMm2 } from './cadSketchMiddleArcTrimFixtures';
import { arcExtendPart, quarterSegmentAreaMm2, extendedSegmentAreaMm2 } from './cadSketchArcExtendFixtures';
import { measureCadResolvedProfile } from '../cadMeasurements';
import { pairedBoreMirrorPart, mirrorBoreRequest } from './cadSketchMirrorFixtures';
import { prepareCadSketchMirror } from '../cadSketchMirror';

function splitSource() {
  return parseCadDocument({ ...createCadDocument('Split regions', 'split-regions'), schemaVersion: 2, parameters: { span: 20, retained: 7 }, features: [{
    id: 'graph', name: 'Outline', kind: 'sketch', plane: 'XY', offset: 0, suppressed: false, profiles: [], source: sketch().source, graph: {
      points: [{ id: 'a', position: ['0', '0'] }, { id: 'b', position: [' span ', '0'] }, { id: 'c', position: [' span ', 10] }, { id: 'd', position: ['0', 10] }],
      entities: ['a', 'b', 'c', 'd'].map((id, index) => ({ id: `edge-${id}`, kind: 'line', construction: false, startPointId: id, endPointId: ['b', 'c', 'd', 'a'][index] })), relations: []
    }
  }] });
}
const split = { kind: 'line', entityId: 'edge-a', parameter: .5, splitPointId: 'joint', newEntityId: 'a-new', supportRelationId: 'straight' } as const;

describe('prepared closed-cell inspection and physical selection', () => {
  it('packs the same detached bore proposal and requires an explicit plate repair in one undoable batch', () => {
    const document = pairedBoreMirrorPart(true), session = new CadSession(document), before = session.getSnapshot(), original = JSON.stringify(document);
    const proposal = { mirror: mirrorBoreRequest }, inspection = inspectCadSketchRegions(document, 'sketch', { mode: 'graph-cells', proposal });
    expect(inspection.proposed).toBe(true);
    const body = [...inspection.items].sort((a, b) => b.areaMm2 - a.areaMm2)[0];
    expect(body.areaMm2).toBeCloseTo(1800 - 18 * Math.PI, 10);
    const selection = readCadSketchRegionReference(document, 'sketch', { cellIds: [body.cellId] }, proposal);
    const sketch = document.features[0], pad = document.features[1]; if (sketch.kind !== 'sketch' || pad.kind !== 'extrude') throw new Error('Plate missing.');
    const expected = prepareCadSketchMirror({ sketch, parameters: document.parameters, ...mirrorBoreRequest });
    expect(prepareCadSketchCells(expected.sketch, document.parameters, 'graph-cells').pack([body.cellId])).toEqual(selection);
    const edit = { kind: 'mirror-sketch-geometry', sketchId: 'sketch', ...mirrorBoreRequest } as const;
    expect(() => session.edit([edit], before.version)).toThrowError(expect.objectContaining({ code: 'stale-sketch-region' }));
    expect(session.getSnapshot()).toBe(before); expect(JSON.stringify(document)).toBe(original);
    session.edit([edit, { kind: 'update-feature', feature: { ...pad, regionSelection: selection } }], before.version);
    const accepted = session.getSnapshot(); expect(accepted.document.features).toEqual([expected.sketch, { ...pad, regionSelection: selection }]);
    session.undo(); expect(session.getSnapshot().document).toBe(document); session.redo(); expect(session.getSnapshot().document).toBe(accepted.document);
  });
  it('queries and proposes arc Extend before an explicit two-cell union repair while retaining the original divider', () => {
    const source = arcExtendPart(), sketch = source.features[0]; if (sketch.kind !== 'sketch') throw new Error('Arc sketch missing.');
    const catalog = prepareCadSketchCells(sketch, source.parameters, 'graph-cells'), oldSelection = catalog.pack(catalog.cells.map(cell => cell.id));
    expect(catalog.cells).toHaveLength(1); expect(catalog.cells[0].areaMm2).toBeCloseTo(quarterSegmentAreaMm2, 10);
    const document = parseCadDocument({ ...source, features: [...source.features, { id: 'pad', kind: 'extrude', name: 'Quarter blank', sketchId: 'sketch',
      suppressed: false, distance: 5, symmetric: false, operation: 'new', targetId: null, regionSelection: oldSelection }] });
    const session = new CadSession(document), before = session.getSnapshot(), original = JSON.stringify(document);
    const current = inspectCadSketchRegions(document, 'sketch', { mode: 'graph-cells' });
    const query = inspectCadSketchRegions(document, 'sketch', { mode: 'graph-cells', extendAt: { entityId: 'arc', end: 'end' } });
    expect(query.items).toEqual(current.items);
    const preview = query.extendPreview; if (!preview) throw new Error('Arc extension preview missing.');
    expect(preview.target).toMatchObject({ kind: 'arc', boundary: { endpointPointId: 'c', position: [-6, 8] } });
    expect(preview.added.kind).toBe('arc'); expect(preview.extended.kind).toBe('arc');
    const extend = { ...preview.target, endPointId: 'c' }, proposal = { extend };
    const inspection = inspectCadSketchRegions(document, 'sketch', { mode: 'graph-cells', proposal });
    expect(inspection).toMatchObject({ proposed: true, total: 2 });
    expect(inspection.items.reduce((area, cell) => area + cell.areaMm2, 0)).toBeCloseTo(extendedSegmentAreaMm2, 10);
    const ids = inspection.items.map(cell => cell.cellId), reference = readCadSketchRegionReference(document, 'sketch', { cellIds: ids }, proposal);
    const edit = { kind: 'extend-sketch-entity', sketchId: 'sketch', extend } as const, effective = reduceCadEditIntents(document, [edit]), changed = effective.features[0];
    if (changed.kind !== 'sketch') throw new Error('Extended segment missing.');
    const prepared = prepareCadSketchCells(changed, effective.parameters, 'graph-cells');
    expect(prepared.pack(ids)).toEqual(reference);
    const union = prepared.resolve(reference); expect(union).toHaveLength(1);
    expect(measureCadResolvedProfile(union[0].boundary.geometry).areaMm2).toBeCloseTo(extendedSegmentAreaMm2, 10);
    expect(() => session.edit([edit], before.version)).toThrowError(expect.objectContaining({ code: 'stale-sketch-region' }));
    expect(session.getSnapshot()).toBe(before); expect(JSON.stringify(document)).toBe(original);
    const pad = document.features[1]; if (pad.kind !== 'extrude') throw new Error('Quarter consumer missing.');
    session.edit([edit, { kind: 'update-feature', feature: { ...pad, regionSelection: reference } }], before.version);
    const accepted = session.getSnapshot(); expect(accepted.document.features[0]).toEqual(changed);
    expect(accepted.document.features[1]).toMatchObject({ regionSelection: reference });
    session.undo(); expect(session.getSnapshot().document).toBe(document); session.redo(); expect(session.getSnapshot().document).toBe(accepted.document);
  });

  it('queries and proposes middle-arc Trim before an explicit clipped-D repair without carrying the old D union witness', () => {
    const source = middleArcTrimPart(), sketch = source.features[0]; if (sketch.kind !== 'sketch') throw new Error('D sketch missing.');
    const catalog = prepareCadSketchCells(sketch, source.parameters, 'graph-cells'), wholeD = catalog.pack(catalog.cells.map(cell => cell.id));
    expect(catalog.cells.reduce((area, cell) => area + cell.areaMm2, 0)).toBeCloseTo(lowerDAreaMm2, 10);
    const document = parseCadDocument({ ...source, features: [...source.features, { id: 'pad', kind: 'extrude', name: 'D blank', sketchId: 'sketch',
      suppressed: false, distance: 5, symmetric: false, operation: 'new', targetId: null, regionSelection: wholeD }] });
    const session = new CadSession(document), before = session.getSnapshot(), original = JSON.stringify(document);
    const current = inspectCadSketchRegions(document, 'sketch', { mode: 'graph-cells' });
    const query = inspectCadSketchRegions(document, 'sketch', { mode: 'graph-cells', trimAt: { entityId: 'arc', parameter: .5 } });
    expect(query.items).toEqual(current.items);
    const preview = query.trimPreview; if (!preview || preview.target.kind !== 'middle' || !('survivors' in preview)) throw new Error('Middle arc preview missing.');
    expect(preview.removed.kind).toBe('arc'); expect(preview.survivors.map(segment => segment.kind)).toEqual(['arc', 'arc']);
    expect(preview.target.boundaries.map(boundary => boundary.endpointPointId)).toEqual(['p', 'q']);
    const trim = { ...preview.target, cutPointIds: ['p', 'q'] as const, newEntityId: 'after', supportRelationId: 'common-radius' }, proposal = { trim };
    const inspection = inspectCadSketchRegions(document, 'sketch', { mode: 'graph-cells', proposal });
    expect(inspection).toMatchObject({ proposed: true, total: 1 }); expect(inspection.items[0].areaMm2).toBeCloseTo(clippedDAreaMm2, 10);
    const reference = readCadSketchRegionReference(document, 'sketch', { cellIds: [inspection.items[0].cellId] }, proposal);
    const edit = { kind: 'trim-sketch-entity', sketchId: 'sketch', trim } as const, effective = reduceCadEditIntents(document, [edit]), changed = effective.features[0];
    if (changed.kind !== 'sketch') throw new Error('Clipped D missing.');
    expect(prepareCadSketchCells(changed, effective.parameters, 'graph-cells').pack([inspection.items[0].cellId])).toEqual(reference);
    expect(() => session.edit([edit], before.version)).toThrowError(expect.objectContaining({ code: 'stale-sketch-region' }));
    expect(session.getSnapshot()).toBe(before); expect(JSON.stringify(document)).toBe(original);
    const pad = document.features[1]; if (pad.kind !== 'extrude') throw new Error('D consumer missing.');
    session.edit([edit, { kind: 'update-feature', feature: { ...pad, regionSelection: reference } }], before.version);
    const accepted = session.getSnapshot(); expect(accepted.document.features[0]).toEqual(changed);
    expect(accepted.document.features[1]).toMatchObject({ regionSelection: reference });
    session.undo(); expect(session.getSnapshot().document).toBe(document); session.redo(); expect(session.getSnapshot().document).toBe(accepted.document);
  });

  it('queries and proposes the same circle Trim before an explicit lower-D consumer repair, without reusing a full-disk source witness', () => {
    const source = circleTrimPart(), sketch = source.features[0]; if (sketch.kind !== 'sketch') throw new Error('Circle sketch missing.');
    const catalog = prepareCadSketchCells(sketch, source.parameters, 'graph-cells'), fullDisk = catalog.pack(catalog.cells.map(cell => cell.id));
    const document = parseCadDocument({ ...source, features: [...source.features, { id: 'pad', kind: 'extrude', name: 'Disk blank', sketchId: 'sketch',
      suppressed: false, distance: 5, symmetric: false, operation: 'new', targetId: null, regionSelection: fullDisk }] });
    const session = new CadSession(document), before = session.getSnapshot(), original = JSON.stringify(document);
    const current = inspectCadSketchRegions(document, 'sketch', { mode: 'graph-cells' });
    const query = inspectCadSketchRegions(document, 'sketch', { mode: 'graph-cells', trimAt: { entityId: 'disk', parameter: .25 } });
    expect(query.items).toEqual(current.items);
    const preview = query.trimPreview; if (!preview || preview.target.kind !== 'circle') throw new Error('Circle preview missing.');
    expect(preview.target).not.toHaveProperty('cutPointIds');
    expect(preview.target.boundaries.map(boundary => boundary.endpointPointId)).toEqual(['b', 'a']);
    const trim = { ...preview.target, cutPointIds: ['b', 'a'] as const }, proposal = { trim };
    const inspection = inspectCadSketchRegions(document, 'sketch', { mode: 'graph-cells', proposal });
    expect(inspection).toMatchObject({ proposed: true, total: 1 }); expect(inspection.items[0].areaMm2).toBeCloseTo(lowerDAreaMm2, 10);
    const reference = readCadSketchRegionReference(document, 'sketch', { cellIds: [inspection.items[0].cellId] }, proposal);
    const edit = { kind: 'trim-sketch-entity', sketchId: 'sketch', trim } as const, effective = reduceCadEditIntents(document, [edit]), changed = effective.features[0];
    if (changed.kind !== 'sketch') throw new Error('Proposed sketch missing.');
    expect(prepareCadSketchCells(changed, effective.parameters, 'graph-cells').pack([inspection.items[0].cellId])).toEqual(reference);
    expect(() => session.edit([edit], before.version)).toThrowError(expect.objectContaining({ code: 'stale-sketch-region' }));
    expect(session.getSnapshot()).toBe(before); expect(JSON.stringify(document)).toBe(original);
    const pad = document.features[1]; if (pad.kind !== 'extrude') throw new Error('Disk consumer missing.');
    session.edit([edit, { kind: 'update-feature', feature: { ...pad, regionSelection: reference } }], before.version);
    const accepted = session.getSnapshot(); expect(accepted.document.features[0]).toEqual(changed);
    expect(accepted.document.features[1]).toMatchObject({ regionSelection: reference });
    session.undo(); expect(session.getSnapshot().document).toBe(document); session.redo(); expect(session.getSnapshot().document).toBe(accepted.document);
  });

  it('preflights the same detached offset request before an atomic explicit-consumer repair', () => {
    const source = offsetCirclePart(), sketch = source.features[0]; if (sketch.kind !== 'sketch') throw new Error('Missing circle.');
    const acceptedReference = prepareCadSketchCells(sketch, source.parameters).cells[0].reference;
    const document = parseCadDocument({ ...source, features: [...source.features, { id: 'pad', kind: 'extrude', name: 'Bore stock',
      sketchId: 'sketch', suppressed: false, distance: 5, symmetric: false, operation: 'new', targetId: null, regionSelection: [acceptedReference] }] });
    const session = new CadSession(document), before = session.getSnapshot();
    const offset = { source: { kind: 'profile', profileId: 'circle' }, distance: 'offsetMm', idPrefix: 'detached' } as const;
    const proposal = { offset, parameterValues: { offsetMm: -2 } }, result = inspectCadSketchRegions(document, 'sketch', { proposal });
    expect(result.proposed).toBe(true); expect(result.total).toBe(2);
    const ring = result.items.find(item => item.depth === 0); if (!ring) throw new Error('Offset ring missing.');
    expect(ring.areaMm2).toBeCloseTo(Math.PI * 36, 10);
    expect(readCadSketchRegionReference(document, 'sketch', ring.boundaryProfileId, proposal)).toEqual(ring.reference);
    const edits = [{ kind: 'set-parameter', name: 'offsetMm', value: -2 }, { kind: 'offset-sketch-loop', sketchId: 'sketch', ...offset }] as const;
    expect(() => session.edit(edits, before.version)).toThrowError(expect.objectContaining({ code: 'stale-sketch-region' }));
    expect(session.getSnapshot()).toBe(before);
    const pad = document.features[1]; if (pad.kind !== 'extrude') throw new Error('Missing pad.');
    session.edit([...edits, { kind: 'update-feature', feature: { ...pad, regionSelection: [ring.reference] } }], before.version);
    const accepted = session.getSnapshot(); expect(accepted.document.features[0]).toMatchObject({ profiles: sketch.profiles });
    session.undo(); expect(session.getSnapshot().document).toBe(document); expect(session.getSnapshot().canUndo).toBe(false);
    session.redo(); expect(session.getSnapshot().document).toBe(accepted.document);
    expect(() => inspectCadSketchRegions(document, 'sketch', { proposal: { offset, sketch } as never })).toThrowError(expect.objectContaining({ code: 'invalid-region-proposal' }));
  });
  it('queries the middle span without allocating IDs and keeps accepted cells separate from proposed survivors', () => {
    const source = middleTrimPart(), before = JSON.stringify(source), current = inspectCadSketchRegions(source, 'sketch');
    const query = inspectCadSketchRegions(source, 'sketch', { trimAt: { entityId: 'ab', parameter: .5 } });
    expect(query.items).toEqual(current.items); expect(query.total).toBe(2);
    const { cutPointIds: _cuts, newEntityId: _new, supportRelationId: _support, ...target } = middleTrim;
    expect(query.trimPreview).toMatchObject({ target, removed: { length: 10 }, survivors: [{ length: 5 }, { length: 5 }],
      cuts: [{ point: [5, 0] }, { point: [15, 0] }] });
    for (const field of ['cutPointIds', 'newEntityId', 'supportRelationId']) expect(query.trimPreview?.target).not.toHaveProperty(field);
    expect(JSON.stringify(source)).toBe(before);
  });
  it('queries a line extension without allocating IDs and rejects changed witnesses or mixed read modes', () => {
    const source = extendPart(), original = JSON.stringify(source), accepted = inspectCadSketchRegions(source, 'sketch');
    const query = inspectCadSketchRegions(source, 'sketch', { extendAt: { entityId: 'ab', end: 'start' } });
    expect(query.items).toEqual(accepted.items); expect(query.total).toBe(2); expect(query).not.toHaveProperty('proposed');
    const { endPointId: _end, ...target } = lineExtend;
    expect(query.extendPreview).toMatchObject({ target, point: [-5, 0], added: { kind: 'line', length: 5 }, extended: { kind: 'line', length: 25 } });
    expect(query.extendPreview?.target).not.toHaveProperty('endPointId');
    const stale = { ...lineExtend, boundary: { ...lineExtend.boundary, position: [-6, 0] as const } };
    expect(() => inspectCadSketchRegions(source, 'sketch', { proposal: { extend: stale } })).toThrowError(expect.objectContaining({ code: 'stale-sketch-extend' }));
    for (const input of [{ extendAt: { entityId: 'ab', end: 'start' }, proposal: { extend: lineExtend } },
      { extendAt: { entityId: 'ab', end: 'start' }, trimAt: { entityId: 'ab', parameter: .1 } }])
      expect(() => inspectCadSketchRegions(source, 'sketch', input as never)).toThrowError(expect.objectContaining({ code: 'invalid-region-proposal' }));
    expect(JSON.stringify(source)).toBe(original);
  });

  it('queries an exact end-trim witness without allocating IDs, changing cells or pretending the trim was applied', () => {
    const source = trimPart(), original = JSON.stringify(source);
    const accepted = inspectCadSketchRegions(source, 'sketch');
    const query = inspectCadSketchRegions(source, 'sketch', { trimAt: { entityId: 'ab', parameter: .1 } });
    expect(query.items).toEqual(accepted.items); expect(query.total).toBe(2); expect(query).not.toHaveProperty('proposed');
    const { cutPointId: _cut, ...target } = endTrim;
    expect(query.trimPreview).toMatchObject({ target, point: [5, 0], removed: { kind: 'line', length: 5 }, survivor: { kind: 'line', length: 15 } });
    expect(query.trimPreview?.target).not.toHaveProperty('cutPointId');
    expect(JSON.stringify(source)).toBe(original);
    expect(() => inspectCadSketchRegions(source, 'sketch', { trimAt: { entityId: 'ab', parameter: .1 }, proposal: { trim: endTrim } } as never))
      .toThrowError(expect.objectContaining({ code: 'invalid-region-proposal' }));
    expect(() => inspectCadSketchRegions(source, 'sketch', { trimAt: { entityId: 'ab', parameter: NaN } })).toThrow();
  });

  it.each([
    { name: 'Trim', part: trimPart, topology: { trim: endTrim }, edit: { kind: 'trim-sketch-entity', sketchId: 'sketch', trim: endTrim } as const },
    { name: 'Middle Trim', part: middleTrimPart, topology: { trim: middleTrim }, edit: { kind: 'trim-sketch-entity', sketchId: 'sketch', trim: middleTrim } as const },
    { name: 'Extend', part: extendPart, topology: { extend: lineExtend }, edit: { kind: 'extend-sketch-entity', sketchId: 'sketch', extend: lineExtend } as const }
  ])('preflights the actual $name result and exact remaining refs before an atomic explicit-consumer repair', ({ part, topology, edit }) => {
    const session = new CadSession(part(true)), before = session.getSnapshot(), original = JSON.stringify(before.document);
    const proposal = { ...topology, parameterValues: { added: 11 } };
    const inspection = inspectCadSketchRegions(before.document, 'sketch', { proposal });
    expect(inspection).toMatchObject({ proposed: true, total: 1, items: [{ areaMm2: 200, boundaryLengthMm: 60 }] });
    const reference = inspection.items[0].reference;
    expect(readCadSketchRegionReference(before.document, 'sketch', reference.boundaryProfileId, proposal)).toEqual(reference);
    const edits = [{ kind: 'set-parameter', name: 'added', value: 11 }, edit] as const;
    const reduced = reduceCadEditIntents(before.document, edits), effective = reduced.features[0];
    if (effective.kind !== 'sketch') throw new Error('Missing sketch.');
    expect(prepareCadSketchCells(effective, reduced.parameters).cells.map(cell => cell.reference)).toEqual([reference]);
    expect(() => session.edit(edits, before.version)).toThrowError(expect.objectContaining({ code: 'stale-sketch-region' }));
    expect(session.getSnapshot()).toBe(before); expect(JSON.stringify(before.document)).toBe(original);
    const pad = before.document.features[1]; if (pad.kind !== 'extrude') throw new Error('Missing pad.');
    session.edit([...edits, { kind: 'update-feature', feature: { ...pad, regionSelection: [reference] } }], before.version);
    const accepted = session.getSnapshot(); expect(accepted.document.features[0]).toEqual(effective);
    expect(effective.source).toEqual(before.document.features[0].kind === 'sketch' ? before.document.features[0].source : undefined);
    session.undo(); expect(session.getSnapshot().document).toBe(before.document); expect(session.getSnapshot().canUndo).toBe(false);
    session.redo(); expect(session.getSnapshot().document).toBe(accepted.document);
  });

  it('refuses mixed or stale trim proposals and drops a driven detached end without editing accepted data', () => {
    const document = trimPart(), feature = document.features[0]; if (feature.kind !== 'sketch' || !feature.graph) throw new Error('Missing trim sketch.');
    const original = JSON.stringify(document);
    for (const proposal of [{ trim: endTrim, sketch: feature }, { trim: endTrim, split },
      { trim: { ...endTrim, boundary: { ...endTrim.boundary, position: [6, 0] } } }])
      expect(() => inspectCadSketchRegions(document, 'sketch', { proposal: proposal as unknown as CadSketchRegionProposal })).toThrow();
    const driven = parseCadDocument({ ...document, features: [{ ...feature, graph: { ...feature.graph,
      points: feature.graph.points.map(point => point.id === 'a' ? { ...point, position: [' 0 ', 0] } : point) } }] });
    const areas = (source: typeof document) => inspectCadSketchRegions(source, 'sketch', { proposal: { trim: endTrim } }).items.map(item => item.areaMm2);
    expect(areas(driven)).toEqual(areas(document)); expect(areas(document).length).toBeGreaterThan(0);
    expect(JSON.stringify(document)).toBe(original);
  });

  it('preflights the exact named split and additive parameter values before one atomic explicit-consumer repair', () => {
    const source = splitSource(), oldReference = inspectCadSketchRegions(source, 'graph').items[0].reference;
    const consumer = { ...pad([oldReference]), sketchId: 'graph' };
    const session = new CadSession({ ...source, features: [...source.features, consumer] }), before = session.getSnapshot(), original = JSON.stringify(before.document);
    const proposal = { split, parameterValues: { span: 30, added: 11 } };
    const inspection = inspectCadSketchRegions(before.document, 'graph', { proposal }), reference = inspection.items[0].reference;
    expect(inspection).toMatchObject({ proposed: true, total: 1, items: [{ areaMm2: 300, boundaryLengthMm: 80 }] });
    expect(reference).not.toEqual(oldReference);
    expect(readCadSketchRegionReference(before.document, 'graph', reference.boundaryProfileId, proposal)).toEqual(reference);
    const edits = [{ kind: 'set-parameter', name: 'span', value: 30 }, { kind: 'set-parameter', name: 'added', value: 11 },
      { kind: 'split-sketch-entity', sketchId: 'graph', split }] as const;
    const reduced = reduceCadEditIntents(before.document, edits), effective = reduced.features[0];
    if (effective.kind !== 'sketch') throw new Error('Split sketch missing.');
    expect(prepareCadSketchCells(effective, reduced.parameters).cells.map(cell => cell.reference)).toEqual(inspection.items.map(cell => cell.reference));
    expect(reduced.parameters).toEqual({ span: 30, retained: 7, added: 11 });
    expect(() => session.edit(edits, before.version)).toThrowError(expect.objectContaining({ code: 'stale-sketch-region' }));
    expect(session.getSnapshot()).toBe(before); expect(JSON.stringify(before.document)).toBe(original);
    session.edit([...edits, { kind: 'update-feature', feature: { ...consumer, regionSelection: [reference] } }], before.version);
    const accepted = session.getSnapshot(); expect(accepted.document.features[0]).toEqual(effective);
    expect(effective.source).toEqual(source.features[0].kind === 'sketch' ? source.features[0].source : undefined);
    expect(effective.graph?.points.slice(0, 4)).toEqual(source.features[0].kind === 'sketch' ? source.features[0].graph?.points : undefined);
    session.undo(); expect(session.getSnapshot().document).toBe(before.document); expect(session.getSnapshot().canUndo).toBe(false);
    session.redo(); expect(session.getSnapshot().document).toBe(accepted.document);
  });

  it('rejects mixed, stale and whole-entity-owned split proposals without changing source or guessing repair', () => {
    const source = splitSource(), feature = source.features[0]; if (feature.kind !== 'sketch' || !feature.graph) throw new Error('Split sketch missing.');
    const original = JSON.stringify(source);
    const mixed = { split, sketch: feature } as unknown as CadSketchRegionProposal;
    expect(() => inspectCadSketchRegions(source, 'graph', { proposal: mixed })).toThrowError(expect.objectContaining({ code: 'invalid-region-proposal' }));
    expect(() => inspectCadSketchRegions(source, 'graph', { proposal: { split: { ...split, entityId: 'removed' } } })).toThrow();
    expect(() => inspectCadSketchRegions(source, 'graph', { proposal: { split: { ...split, splitPointId: 'a' } } })).toThrow();
    const blocked = parseCadDocument({ ...source, features: [{ ...feature, graph: { ...feature.graph,
      relations: [{ id: 'whole-edge', kind: 'equal-length', lineIds: ['edge-a', 'edge-c'] }] } }] });
    expect(() => inspectCadSketchRegions(blocked, 'graph', { proposal: { split } })).toThrowError(expect.objectContaining({ code: 'dependent-sketch-split', relationIds: ['whole-edge'] }));
    expect(JSON.stringify(source)).toBe(original);
  });

  it('refuses to guess a split source that needs a native solve after proposed parameter overrides', () => {
    const source = splitSource(), feature = source.features[0]; if (feature.kind !== 'sketch' || !feature.graph) throw new Error('Split sketch missing.');
    const driven = parseCadDocument({ ...source, features: [{ ...feature, graph: { ...feature.graph,
      points: feature.graph.points.map(point => point.id === 'b' ? { ...point, position: [20, 0] } : point),
      relations: [{ id: 'span-driver', kind: 'distance', pointIds: ['a', 'b'], value: ' span ' }] } }] });
    const original = JSON.stringify(driven);
    expect(() => inspectCadSketchRegions(driven, 'graph', { proposal: { split, parameterValues: { span: 30 } } })).toThrowError(expect.objectContaining({ code: 'invalid-sketch-graph-geometry' }));
    expect(JSON.stringify(driven)).toBe(original);
  });
  it('preflights each shared-driver source even when an earlier selected extrusion also needs the same atomic repair', () => {
    const first: CadSketchFeature = { ...sketch(), profiles: sketch().profiles.map(profile => profile.id === 'bore' && profile.geometry.kind === 'circle'
      ? { ...profile, geometry: { ...profile.geometry, x: 'location' } } : profile) };
    const second: CadSketchFeature = { ...first, id: 'second', name: 'Second' };
    const session = new CadSession(part([first, pad([refs.outer]), second, { ...pad([refs.outer]), id: 'second_pad', sketchId: 'second' }], { location: 0 }));
    const before = session.getSnapshot(), proposal = { parameterValues: { location: 50 } };
    expect(() => session.edit([{ kind: 'set-parameter', name: 'location', value: 50 }], before.version)).toThrow(/region.*changed/i);
    const later = inspectCadSketchRegions(before.document, 'second', { proposal });
    const earlier = inspectCadSketchRegions(before.document, 'regions', { proposal });
    const newRef = { boundaryProfileId: 'outer', voidProfileIds: ['island'], ancestorProfileIds: [] };
    expect(later.items.find(cell => cell.boundaryProfileId === 'outer')?.reference).toEqual(newRef);
    expect(earlier.items.find(cell => cell.boundaryProfileId === 'outer')?.reference).toEqual(newRef);
    expect(later.items.find(cell => cell.boundaryProfileId === 'outer')?.areaMm2).toBeCloseTo(96 * Math.PI, 10);
    expect(session.getSnapshot()).toBe(before);
    session.edit([{ kind: 'set-parameter', name: 'location', value: 50 }, { kind: 'update-feature', feature: pad([newRef]) },
      { kind: 'update-feature', feature: { ...pad([newRef]), id: 'second_pad', sketchId: 'second' } }], before.version);
    const accepted = session.getSnapshot(); expect(accepted.document.features[0]).toEqual(first); expect(accepted.document.features[2]).toEqual(second);
    session.undo(); expect(session.getSnapshot().document).toEqual(before.document); expect(session.getSnapshot().canUndo).toBe(false);
    session.redo(); expect(session.getSnapshot().document).toEqual(accepted.document);
  });

  it('preflights proposed source and numeric parameters before one atomic topology-and-selection edit', () => {
    const source: CadSketchFeature = { ...sketch(), profiles: sketch().profiles.map(profile => profile.id === 'bore' && profile.geometry.kind === 'circle'
      ? { ...profile, geometry: { ...profile.geometry, x: 'location' } } : profile) };
    const session = new CadSession(part([source, pad([refs.outer])], { location: 0 })), before = session.getSnapshot();
    const proposedSource: CadSketchFeature = { ...source, profiles: source.profiles.filter(profile => profile.id !== 'island').concat([
      { id: 'fresh', name: 'Fresh', construction: false, geometry: { kind: 'circle', x: 0, y: 0, radius: 1 } },
    ]) };
    expect(() => session.edit([{ kind: 'update-feature', feature: proposedSource }, { kind: 'set-parameter', name: 'location', value: 50 }], before.version)).toThrow(/region.*changed/i);
    const proposal = { sketch: proposedSource, parameterValues: { location: 50 } }, input = { proposal };
    const inspection = inspectCadSketchRegions(before.document, 'regions', input);
    const outer = inspection.items.find(cell => cell.boundaryProfileId === 'outer');
    expect(inspection).toMatchObject({ proposed: true, total: 4 });
    expect(outer?.reference).toEqual({ boundaryProfileId: 'outer', voidProfileIds: ['fresh'], ancestorProfileIds: [] });
    expect(outer?.areaMm2).toBeCloseTo(99 * Math.PI, 10);
    expect(readCadSketchRegionReference(before.document, 'regions', 'outer', proposal)).toEqual(outer?.reference);
    expect(session.getSnapshot()).toBe(before); expect(JSON.stringify(proposedSource.source)).toBe(JSON.stringify(source.source));
    if (!outer) throw new Error('No proposed outer cell');
    session.edit([{ kind: 'update-feature', feature: proposedSource }, { kind: 'set-parameter', name: 'location', value: 50 },
      { kind: 'update-feature', feature: pad([outer.reference]) }], before.version);
    const accepted = session.getSnapshot();
    expect(accepted.document.features[0]).toEqual(proposedSource); expect(accepted.document.parameters).toEqual({ location: 50 });
    session.edit([{ kind: 'update-feature', feature: proposedSource }], accepted.version); expect(session.getSnapshot()).toBe(accepted);
    session.undo(); expect(session.getSnapshot().document).toEqual(before.document); expect(session.getSnapshot().canUndo).toBe(false);
    session.redo(); expect(session.getSnapshot().document).toEqual(accepted.document);
  });

  it('validates proposal identity, complete unselected geometry and effective values while keeping accepted-only inspection exact', () => {
    const source = sketch(), document = part([source, pad([refs.outer])]), text = JSON.stringify(document);
    const wrongId = { proposal: { sketch: { ...source, id: 'other' } } };
    expect(() => inspectCadSketchRegions(document, 'regions', wrongId)).toThrow(/same.*sketch|identity/i);
    const suppressed = { proposal: { sketch: { ...source, suppressed: true } } };
    expect(() => inspectCadSketchRegions(document, 'regions', suppressed)).toThrow(/suppressed/i);
    const tangent = { proposal: { sketch: { ...source, profiles: [...source.profiles, { id: 'touch', name: 'Unselected tangent', construction: false,
      geometry: { kind: 'circle' as const, x: 13, y: 0, radius: 3 } }] } } };
    expect(() => inspectCadSketchRegions(document, 'regions', tangent)).toThrow(/touch|overlap/i);
    const invalidValue = { proposal: { parameterValues: { invalid: Infinity } } };
    expect(() => inspectCadSketchRegions(document, 'regions', invalidValue)).toThrow();
    const sourceOnly = { proposal: { sketch: { ...source, profiles: source.profiles.filter(profile => profile.id !== 'island') } } };
    expect(inspectCadSketchRegions(document, 'regions', sourceOnly).items[0].reference).toEqual({ ...refs.bore, voidProfileIds: [] });
    expect(inspectCadSketchRegions(document, 'regions').items[0].reference).toEqual(refs.bore);
    expect(inspectCadSketchRegions(document, 'regions')).not.toHaveProperty('proposed'); expect(JSON.stringify(document)).toBe(text);
  });

  it('validates only actual preceding datum dependencies without relocating or admitting missing, later or suppressed frames', () => {
    const source = sketch(), datum = { id: 'datum', name: 'Datum', kind: 'datum-plane' as const, suppressed: false,
      definition: { kind: 'world' as const, basePlane: 'XY' as const, origin: [10, 20, 30] as const, rotation: ['tilt', 0, 0] as const } };
    const placed = { ...source, plane: { kind: 'datum-plane' as const, featureId: 'datum' } };
    const proposal = { sketch: placed, parameterValues: { tilt: 30 } };
    const document = part([datum, source, pad([refs.outer])], { tilt: 0 });
    expect(inspectCadSketchRegions(document, 'regions', { proposal }).items[0].reference).toEqual(refs.bore);
    expect(() => inspectCadSketchRegions(part([source, datum], { tilt: 0 }), 'regions', { proposal })).toThrow(/preceding datum/i);
    expect(() => inspectCadSketchRegions(part([source], { tilt: 0 }), 'regions', { proposal })).toThrow(/preceding datum/i);
    expect(() => inspectCadSketchRegions(part([{ ...datum, suppressed: true }, source], { tilt: 0 }), 'regions', { proposal }))
      .toThrowError(expect.objectContaining({ code: 'unavailable-datum-plane' }));
    expect(JSON.stringify(document.features[1])).toBe(JSON.stringify(source));
  });

  it('reports complete cells, independent analytic quantities and exact canonical references', () => {
    const source = sketch(); const text = JSON.stringify(source);
    const prepared = prepareCadSketchCells(source, {});
    expect(prepared.cells.map(cell => cell.reference)).toEqual([refs.bore, refs.island, refs.outer, refs.separate]);
    for (const [id, coefficient, perimeter, material] of [['bore', 32, 16, false], ['island', 4, 4, true],
      ['outer', 64, 32, true], ['separate', 9, 6, true]] as const) {
      const cell = prepared.cells.find(cell => cell.reference.boundaryProfileId === id);
      expect(cell?.areaMm2).toBeCloseTo(coefficient * Math.PI, 10);
      expect(cell?.boundaryLengthMm).toBeCloseTo(perimeter * Math.PI, 10);
      expect(cell?.defaultMaterial).toBe(material);
    }
    expect(prepared.cells.find(cell => cell.reference.boundaryProfileId === 'outer')?.boundsMm).toEqual({ minX: -10, minY: -10, maxX: 10, maxY: 10 });
    expect(prepared.resolve([refs.outer, refs.bore]).map(region => ({ outer: region.boundary.profile.id,
      holes: region.voids.map(contour => contour.profile.id) }))).toEqual([{ outer: 'outer', holes: ['island'] }]);
    expect(JSON.stringify(source)).toBe(text);
  });

  it('picks the deepest actual analytic cell and keeps an immutable preparation valid without resolving another source', () => {
    const prepared = prepareCadSketchCells(sketch(), {});
    expect(prepared.pick({ x: 8, y: 0 })?.reference).toEqual(refs.outer);
    expect(prepared.pick({ x: 4, y: 0 })?.reference).toEqual(refs.bore);
    expect(prepared.pick({ x: 0, y: 0 })?.reference).toEqual(refs.island);
    expect(prepared.pick({ x: 30, y: 0 })?.reference).toEqual(refs.separate);
    expect(prepared.pick({ x: 15, y: 0 })).toBeNull();
    expect(prepared.pick({ x: Infinity, y: 0 })).toBeNull();
    const changed = prepareCadSketchCells({ ...sketch(), profiles: sketch().profiles.filter(profile => profile.id !== 'island') }, {});
    expect(changed.pick({ x: 0, y: 0 })?.reference).toEqual({ ...refs.bore, voidProfileIds: [] });
    expect(prepared.pick({ x: 0, y: 0 })?.reference).toEqual(refs.island);
  });

  it('tracks graph point, radius and relation drivers in accepted cell preparations while excluding placement', () => {
    const document = parseCadDocument({ ...createCadDocument('Circle', 'circle'), schemaVersion: 2,
      parameters: { origin: 2, radius: 5, fix: 2, placement: 17 }, features: [{
        id: 'graph', kind: 'sketch', name: 'Graph', suppressed: false, plane: 'XY', offset: 'placement', profiles: [], graph: {
          points: [{ id: 'center', position: [' origin ', 0] }],
          entities: [{ id: 'circle', kind: 'circle', centerPointId: 'center', radius: ' radius ', construction: false }],
          relations: [{ id: 'fixed', kind: 'fixed-axis', pointId: 'center', axis: 'x', value: ' fix ' }]
        }
      }] }), source = document.features[0], before = JSON.stringify(document);
    if (source.kind !== 'sketch') throw new Error('Graph fixture missing.');
    const initial = prepareCadSketchCells(source, document.parameters);
    expect(initial.cells[0].areaMm2).toBeCloseTo(25 * Math.PI, 11);
    expect(initial.pick({ x: 6, y: 0 })?.reference.boundaryProfileId).toBe('circle');
    expect(prepareCadSketchCells(source, { ...document.parameters, placement: 99, unrelated: 123 })).toBe(initial);
    expect(() => prepareCadSketchCells(source, { ...document.parameters, fix: 3 })).toThrow('driving relation');
    const enlarged = prepareCadSketchCells(source, { ...document.parameters, radius: 7 });
    expect(enlarged).not.toBe(initial); expect(enlarged.cells[0].areaMm2).toBeCloseTo(49 * Math.PI, 11);
    const moved = prepareCadSketchCells(source, { ...document.parameters, origin: 3, fix: 3 });
    expect(moved.cells[0].boundsMm).toEqual({ minX: expect.closeTo(-2, 12), minY: expect.closeTo(-5, 12), maxX: expect.closeTo(8, 12), maxY: expect.closeTo(5, 12) });
    expect(inspectCadSketchRegions(document, 'graph').items[0].areaMm2).toBeCloseTo(25 * Math.PI, 11);
    expect(JSON.stringify(document)).toBe(before);
  });

  it('reuses actual concave and circular path containment rather than bounding boxes', () => {
    const source = sketch(false);
    const path = { id: 'path', name: 'Circular path', construction: false, geometry: { kind: 'path' as const, segments: [
      { kind: 'arc' as const, center: [0, 0] as const, radius: 10, startAngle: 90, sweep: 180 },
      { kind: 'arc' as const, center: [0, 0] as const, radius: 10, startAngle: 270, sweep: 180 },
    ] } };
    const prepared = prepareCadSketchCells({ ...source, profiles: [path] }, {});
    expect(prepared.pick({ x: 9, y: 0 })?.reference.boundaryProfileId).toBe('path');
    expect(prepared.pick({ x: 9, y: 9 })).toBeNull();
    expect(prepared.cells[0].areaMm2).toBeCloseTo(100 * Math.PI, 10);
    const concave = prepareCadSketchCells({ ...source, profiles: [{ id: 'concave', name: 'Concave', construction: false,
      geometry: { kind: 'polygon', points: [[0, 0], [10, 0], [10, 2], [2, 2], [2, 8], [10, 8], [10, 10], [0, 10]] } }] }, {});
    expect(concave.pick({ x: 1, y: 5 })?.reference.boundaryProfileId).toBe('concave');
    expect(concave.pick({ x: 6, y: 5 })).toBeNull();
    expect(concave.cells[0].areaMm2).toBe(52);
  });

  it('pages stable cell identities with complete references and preserves source originals', () => {
    const document = part([sketch()]); const text = JSON.stringify(document);
    const first = inspectCadSketchRegions(document, 'regions', { offset: 0, limit: 2 });
    const second = inspectCadSketchRegions(document, 'regions', { offset: 2, limit: 2 });
    expect(first).toMatchObject({ sketchId: 'regions', coordinateSystem: 'sketch-local', total: 4, nextOffset: 2 });
    expect(second).toMatchObject({ total: 4, nextOffset: null });
    expect([...first.items, ...second.items].map(cell => cell.reference)).toEqual([refs.bore, refs.island, refs.outer, refs.separate]);
    expect(readCadSketchRegionReference(document, 'regions', 'bore')).toEqual(refs.bore);
    expect(JSON.stringify(document)).toBe(text);
  });

  it('refuses inactive sketches and absent cells without substituting another source', () => {
    expect(() => inspectCadSketchRegions(part([{ ...sketch(), suppressed: true }]), 'regions')).toThrow(/suppressed/i);
    expect(() => inspectCadSketchRegions(part([sketch()]), 'missing')).toThrow(/sketch/i);
    expect(() => readCadSketchRegionReference(part([sketch()]), 'regions', 'missing')).toThrow(/region/i);
    expect(() => inspectCadSketchRegions(part([sketch()]), 'regions', { offset: -1 })).toThrow();
  });
});
