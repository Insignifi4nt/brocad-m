import { prepareCadEdits } from './cadEditPreparation';
import { symmetricRelation, symmetryPart } from '@/domain/cad/__tests__/cadSketchSymmetryFixtures';
import { pointOnLineRelation, pointOnLinePart } from '@/domain/cad/__tests__/cadSketchPointOnLineFixtures';
import { tangentJoint, tangentPart } from '@/domain/cad/__tests__/cadSketchTangentFixtures';
import { circleRow, circleRowPart } from '@/domain/cad/__tests__/cadSketchLinearPatternFixtures';
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createCadDocument, parseCadDocument } from '@/domain/cad/cadSchema';
import { inspectCadSketchConstraints, pageCadSketchConstraints, summarizeCadSketchConstraintAnalysis } from './cadSketchConstraintInspection';
import { createCadSketchCornerTreatment } from '@/domain/cad/cadSketchCornerTreatment';
import { parseCadSketchGraph } from '@/domain/cad/cadSketchGraph';
import { Value } from '@sinclair/typebox/value';
import { CadToolEditDefinitions } from './cadToolSchemas';
import { applyCadEdits } from '@/domain/cad/cadOperations';
import { createCadSketchTestSolver, loadCadSketchTestNativeSolver } from './sketch-solver/__tests__/cadSketchTestSolver';
import { createCadSketchNativeRuntime } from './sketch-solver/cadSketchNativeRuntime';
import { CAD_SKETCH_NATIVE_FAILED, CAD_SKETCH_SOLVER_NOT_LOADED, CAD_SKETCH_SOLVER_UNREADABLE, CadSketchSolverFailure } from './sketch-solver/cadSketchSolverFailure';
import { createCadSketchSolverLoader } from './sketch-solver/cadSketchSolverLoader';
import type { CadSketchSolverClient } from './sketch-solver/cadSketchSolverTypes';
import { cadSketchAnalysisIssues, cadSketchIssues } from './cadSketchIssues';

const solver = createCadSketchTestSolver();
const source = () => parseCadDocument({ ...createCadDocument('Line', 'line'), schemaVersion: 2, parameters: { span: 20 }, features: [{
  id: 'sketch', name: 'Sketch', kind: 'sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
    points: [{ id: 'a', position: [' 0 ', '0'] }, { id: 'b', position: [20, 0] }],
    entities: [{ id: 'edge', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' }],
    relations: [{ id: 'horizontal', kind: 'horizontal', pointIds: ['a', 'b'] }, { id: 'length', kind: 'distance', pointIds: ['a', 'b'], value: ' span ' }]
  }
}] });

describe('accepted sketch constraint inspection', () => {
  it('discovers scalar-free saved measurements and reads linked/expression geometry without inventing driving values', async () => {
    const document = applyCadEdits(parseCadDocument({ ...createCadDocument('Measured references'), schemaVersion: 2, parameters: { radius: 3 }, features: [
      { id: 'layout', name: 'Layout', kind: 'sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
        points: [{ id: 'center', position: ['4.000', '6'] }], entities: [{ id: 'circle', kind: 'circle', construction: true, centerPointId: 'center', radius: ' radius ' }], relations: [] } },
      { id: 'target', name: 'Target', kind: 'sketch', suppressed: false, plane: 'XY', offset: 5, profiles: [] }
    ] }), [{ kind: 'use-sketch-entity', sketchId: 'target', sourceSketchId: 'layout', sourceEntityId: 'circle', idPrefix: 'used' }]);
    const set = CadToolEditDefinitions.find(schema => schema.properties.kind.const === 'set-sketch-relation');
    if (!set) throw new Error('Missing relation discovery.');
    const annotated = applyCadEdits(document, ['layout', 'target'].map(sketchId => ({ kind: 'set-sketch-relation', sketchId, relation: {
      id: 'read-diameter', kind: 'reference-dimension', measurement: { kind: 'radial-size', entityId: sketchId === 'layout' ? 'circle' : 'used_e0', quantity: 'diameter' }
    } })));
    const exact = JSON.stringify(annotated);
    for (const sketchId of ['layout', 'target']) {
      const inspection = await inspectCadSketchConstraints(annotated, sketchId, async () => solver);
      expect(inspection.analysis).toMatchObject({ kind: 'solved', diagnostics: { degreesOfFreedom: 0 } });
      const row = pageCadSketchConstraints(inspection, { section: 'relations' }).items.find(item => 'source' in item && item.source.id === 'read-diameter');
      if (!row || !('source' in row)) throw new Error('Missing measured relation row.');
      expect(row).toMatchObject({ source: { id: 'read-diameter', kind: 'reference-dimension' },
        measurement: { coordinateSystem: 'sketch-local', valueMm: 6, role: 'reference-measurement' } });
      expect(row).not.toHaveProperty('value');
      const edit = { kind: 'set-sketch-relation', sketchId, relation: row.source };
      expect(Value.Check(set, edit)).toBe(true);
      expect(Value.Check(set, { ...edit, relation: { ...row.source, value: 6 } })).toBe(false);
    }
    expect(JSON.stringify(annotated)).toBe(exact);
  });
  it('exposes numeric reference snapshots as linked values with their actual source identity', async () => {
    const document = applyCadEdits(parseCadDocument({ ...createCadDocument('Reference'), schemaVersion: 2, parameters: { size: 3 }, features: [
      { id: 'layout', name: 'Layout', kind: 'sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
        points: [{ id: 'center', position: ['4', '6'] }], entities: [{ id: 'circle', kind: 'circle', construction: true, centerPointId: 'center', radius: ' size ' }], relations: [] } },
      { id: 'target', name: 'Raised sketch', kind: 'sketch', suppressed: false, plane: 'XY', offset: 5, profiles: [] }
    ] }), [{ kind: 'use-sketch-entity', sketchId: 'target', sourceSketchId: 'layout', sourceEntityId: 'circle', idPrefix: 'used' }]);
    const exact = JSON.stringify(document), inspection = await inspectCadSketchConstraints(document, 'target', async () => solver);
    expect(inspection.analysis.diagnostics.degreesOfFreedom).toBe(0);
    const entity = pageCadSketchConstraints(inspection, { section: 'entities' }).items[0];
    expect(entity).toMatchObject({ measurement: { coordinateSystem: 'sketch-local', kind: 'circle', radiusMm: 3, diameterMm: 6, circumferenceMm: 6 * Math.PI } });
    expect(entity).toMatchObject({ radius: { scalar: 3, valueMm: 3, role: 'linked-reference' }, points: [
      { position: [{ scalar: 4, role: 'linked-reference' }, { scalar: 6, role: 'linked-reference' }] }
    ] });
    expect(pageCadSketchConstraints(inspection, { section: 'relations' }).items[0]).toMatchObject({ source: {
      id: 'used_reference', kind: 'external-reference', entityId: 'used_e0', sourceSketchId: 'layout', source: { kind: 'circle', entityId: 'circle', centerPointId: 'center' }
    }, entityIds: ['used_e0'] });
    expect(JSON.stringify(document)).toBe(exact);
  });
  it('discovers a scalar-free midpoint and inspects its selected point, finite line and exact endpoint drivers', async () => {
    const relation = { id: 'middle-of-ab', kind: 'midpoint', pointId: 'middle', lineId: 'ab' };
    const set = CadToolEditDefinitions.find(schema => schema.properties.kind.const === 'set-sketch-relation');
    const remove = CadToolEditDefinitions.find(schema => schema.properties.kind.const === 'remove-sketch-relation');
    if (!set || !remove) throw new Error('Missing relation edit discovery');
    const edit = { kind: 'set-sketch-relation', sketchId: 'sketch', relation };
    expect(Value.Check(set, edit)).toBe(true); expect(Value.Check(set, { ...edit, relation: { ...relation, value: 1 } })).toBe(false);
    expect(Value.Check(remove, { kind: 'remove-sketch-relation', sketchId: 'sketch', relationId: relation.id })).toBe(true);
    const document = parseCadDocument({ ...createCadDocument('Midpoint bore'), schemaVersion: 2, parameters: { span: 22, boreRadius: 3 }, features: [{
      id: 'sketch', kind: 'sketch', name: 'Located bore', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
        points: [{ id: 'a', position: ['2.000', '-4.00'] }, { id: 'b', position: [' span ', '6.000'] }, { id: 'middle', position: ['(2 + span) / 2', '1.000'] }],
        entities: [{ id: 'ab', kind: 'line', construction: true, startPointId: 'a', endPointId: 'b' },
          { id: 'bore', kind: 'circle', construction: false, centerPointId: 'middle', radius: ' boreRadius ' }], relations: [relation]
      }
    }] }), exact = JSON.stringify(document);
    const inspection = await inspectCadSketchConstraints(document, 'sketch', async () => solver);
    const row = pageCadSketchConstraints(inspection, { section: 'relations' }).items[0];
    expect(row).toMatchObject({ source: relation, entityIds: ['ab'], points: [
      { id: 'middle', position: [{ scalar: '(2 + span) / 2', role: 'expression-driver' }, { scalar: '1.000', role: 'expression-driver' }] },
      { id: 'a', position: [{ scalar: '2.000' }, { scalar: '-4.00' }] }, { id: 'b', position: [{ scalar: ' span ' }, { scalar: '6.000' }] }
    ] });
    expect(row).not.toHaveProperty('value'); expect(JSON.stringify(document)).toBe(exact);
  });
  it('reports signed axis values and exact ordered center/reference operands without modifying accepted source', async () => {
    const document = parseCadDocument({ ...createCadDocument('Bore', 'axis-bore'), schemaVersion: 2,
      parameters: { left: -30, rise: 20 }, features: [{ id: 'sketch', name: 'Bore', kind: 'sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
        points: [{ id: 'reference', position: [' 10 ', '7'] }, { id: 'center', position: [-20, 27] }],
        entities: [{ id: 'bore', kind: 'circle', construction: true, centerPointId: 'center', radius: ' 2 ' }], relations: [
          { id: 'left', kind: 'axis-distance', pointIds: ['reference', 'center'], axis: 'x', value: ' left ' },
          { id: 'height', kind: 'axis-distance', pointIds: ['center', 'reference'], axis: 'y', value: ' -rise ' }
        ]
      } }] }), before = JSON.stringify(document);
    const inspection = await inspectCadSketchConstraints(document, 'sketch', async () => solver);
    expect(inspection.analysis).toMatchObject({ kind: 'solved', diagnostics: { degreesOfFreedom: 0, issues: [] } });
    expect(pageCadSketchConstraints(inspection, { section: 'relations' }).items).toMatchObject([
      { source: { id: 'left', kind: 'axis-distance', axis: 'x', pointIds: ['reference', 'center'], value: ' left ' },
        value: { scalar: ' left ', valueMm: -30, role: 'expression-driver' }, points: [{ id: 'reference' }, { id: 'center' }] },
      { source: { id: 'height', kind: 'axis-distance', axis: 'y', pointIds: ['center', 'reference'], value: ' -rise ' },
        value: { scalar: ' -rise ', valueMm: -20, role: 'expression-driver' }, points: [{ id: 'center' }, { id: 'reference' }] }
    ]);
    expect(JSON.stringify(document)).toBe(before);
  });

  it('reports exact angle ray intent and degree drivers without a misleading millimeter value', async () => {
    const document = parseCadDocument({ ...createCadDocument('Angle', 'angle'), schemaVersion: 2, parameters: { angle: 90 }, features: [{
      id: 'sketch', kind: 'sketch', name: 'Corner', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
        points: [{ id: 'v', position: ['0', '0'] }, { id: 'a', position: ['10', '0'] }, { id: 'b', position: [0, 10] }],
        entities: [{ id: 'reference', kind: 'line', construction: true, startPointId: 'a', endPointId: 'v' },
          { id: 'moving', kind: 'line', construction: false, startPointId: 'v', endPointId: 'b' }],
        relations: [{ id: 'dimension', kind: 'line-angle', rays: [{ lineId: 'reference', towardPointId: 'a' }, { lineId: 'moving', towardPointId: 'b' }], sense: 'ccw', value: ' angle ' }]
      }
    }] }), before = JSON.stringify(document);
    const inspection = await inspectCadSketchConstraints(document, 'sketch', async () => solver);
    const page = pageCadSketchConstraints(inspection, { section: 'relations' });
    expect(page.items[0]).toMatchObject({ source: { id: 'dimension', sense: 'ccw', value: ' angle ' }, entityIds: ['reference', 'moving'],
      value: { scalar: ' angle ', valueDegrees: 90, unit: 'deg', role: 'expression-driver' } });
    expect(page.items[0]).not.toHaveProperty('value.valueMm');
    expect(JSON.stringify(document)).toBe(before);
  });

  it('exposes equal-radius exact curve identities and deduplicated operands without a driving scalar', async () => {
    const document = parseCadDocument({ ...createCadDocument('Curves', 'equality'), schemaVersion: 2, parameters: { size: 20 }, features: [{
      id: 'sketch', kind: 'sketch', name: 'Curves', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
        points: [{ id: 'center', position: ['0', '0'] }, { id: 'start', position: [10, '0'] }, { id: 'end', position: ['0', 10] }],
        entities: [{ id: 'circle', kind: 'circle', construction: true, centerPointId: 'center', radius: 10 },
          { id: 'arc', kind: 'arc', construction: false, centerPointId: 'center', startPointId: 'start', endPointId: 'end', direction: 'cw' }],
        relations: [{ id: 'dimension', kind: 'radial-size', entityId: 'circle', quantity: 'diameter', value: ' size ' },
          { id: 'same', kind: 'equal-radius', curveIds: ['arc', 'circle'] }]
      }
    }] }), before = JSON.stringify(document);
    const inspection = await inspectCadSketchConstraints(document, 'sketch', async () => solver);
    expect(inspection.analysis).toMatchObject({ kind: 'solved', diagnostics: { degreesOfFreedom: 0 } });
    const row = pageCadSketchConstraints(inspection, { section: 'relations', offset: 1 }).items[0];
    expect(row).toMatchObject({ source: { id: 'same', kind: 'equal-radius', curveIds: ['arc', 'circle'] },
      entityIds: ['arc', 'circle'], points: [{ id: 'center' }, { id: 'start' }, { id: 'end' }] });
    expect(row).not.toHaveProperty('value'); expect(JSON.stringify(document)).toBe(before);
  });

  it.each(['radius', 'diameter'] as const)('exposes a radial %s source in displayed units with the actual curve reference', async quantity => {
    const size = quantity === 'diameter' ? 20 : 10;
    const document = parseCadDocument({ ...createCadDocument('Circle', 'radial'), schemaVersion: 2, parameters: { size }, features: [{
      id: 'sketch', kind: 'sketch', name: 'Circle', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
        points: [{ id: 'center', position: [' 0 ', '0'] }], entities: [{ id: 'circle', kind: 'circle', construction: true, centerPointId: 'center', radius: 10 }],
        relations: [{ id: 'dimension', kind: 'radial-size', entityId: 'circle', quantity, value: ' size ' }]
      }
    }] }), before = JSON.stringify(document);
    const inspection = await inspectCadSketchConstraints(document, 'sketch', async () => solver);
    expect(inspection.analysis).toMatchObject({ kind: 'solved', diagnostics: { degreesOfFreedom: 0 } });
    expect(pageCadSketchConstraints(inspection, { section: 'relations' }).items).toMatchObject([{
      source: { id: 'dimension', kind: 'radial-size', quantity, value: ' size ' }, entityIds: ['circle'], points: [{ id: 'center' }],
      value: { scalar: ' size ', valueMm: size, role: 'expression-driver' }
    }]);
    expect(JSON.stringify(document)).toBe(before);
  });

  it.each(['parallel', 'perpendicular', 'collinear'] as const)('exposes %s line identities and exact deduplicated point operands without inventing a scalar', async kind => {
    const document = parseCadDocument({ ...createCadDocument('Pair', 'pair'), schemaVersion: 2, features: [{ id: 'sketch', kind: 'sketch', name: 'Pair',
      suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
        points: [{ id: 'a', position: [' 0 ', '0'] }, { id: 'b', position: ['10', '0'] }, { id: 'c', position: kind === 'perpendicular' ? [0, 8] : [8, 0] }],
        entities: [{ id: 'reference', kind: 'line', construction: true, startPointId: 'a', endPointId: 'b' },
          { id: 'moving', kind: 'line', construction: false, startPointId: 'a', endPointId: 'c' }],
        relations: [{ id: 'direction', kind, lineIds: ['reference', 'moving'] }]
      } }] }), exact = JSON.stringify(document);
    const inspection = await inspectCadSketchConstraints(document, 'sketch', async () => solver);
    expect(inspection.analysis).toMatchObject({ kind: 'solved', diagnostics: { degreesOfFreedom: 1 } });
    const row = pageCadSketchConstraints(inspection, { section: 'relations' }).items[0];
    expect(row).toMatchObject({ source: { id: 'direction', kind, lineIds: ['reference', 'moving'] },
      entityIds: ['reference', 'moving'], meaning: kind === 'parallel' ? 'Keeps two line directions parallel.' : kind === 'perpendicular' ? 'Keeps two line directions at a right angle.'
        : 'Keeps two lines on the same infinite supporting line without joining endpoints or fixing lengths.',
      points: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
    expect(row).not.toHaveProperty('value'); expect(row).not.toHaveProperty('values');
    expect(JSON.stringify(document)).toBe(exact);
  });

  it.each(['fillet', 'chamfer'] as const)('exposes %s supports, generated geometry and exact driving quantities to agents', async kind => {
    const base = source(), feature = base.features[0];
    if (feature.kind !== 'sketch') throw new Error('Missing sketch fixture.');
    const graph = parseCadSketchGraph({ points: [{ id: 'v', position: [' 0 ', '0'] }, { id: 'a', position: ['20', '0'] }, { id: 'b', position: ['0', '16'] }],
      entities: [{ id: 'a-line', kind: 'line', construction: false, startPointId: 'v', endPointId: 'a' },
        { id: 'b-line', kind: 'line', construction: false, startPointId: 'v', endPointId: 'b' }], relations: [] });
    let id = 0;
    const treated = createCadSketchCornerTreatment({ graph, parameters: { size: 2 }, pointId: 'v', createId: () => `new-${++id}`,
      treatment: kind === 'fillet' ? { kind, radius: ' size ' } : { kind, setbacks: [' size ', 'size + 1'] } });
    const document = parseCadDocument({ ...base, parameters: { size: 2 }, features: [{ ...feature, graph: treated.graph }] });
    const exact = JSON.stringify(document), inspection = await inspectCadSketchConstraints(document, 'sketch', async () => solver);
    expect(inspection.analysis.kind).toBe('solved');
    const row = pageCadSketchConstraints(inspection, {}).items[0];
    if (!('entityIds' in row) || !('points' in row)) throw new Error('Expected an entity-owned corner relation.');
    expect(row.entityIds).toEqual(['a-line', 'b-line', treated.entityId]);
    expect(new Set(row.points.map(point => point.id))).toEqual(new Set(treated.graph.points.map(point => point.id)));
    if (kind === 'fillet') expect(row).toMatchObject({ value: { scalar: ' size ', valueMm: 2, role: 'expression-driver' } });
    else expect(row).toMatchObject({ values: [{ scalar: ' size ', valueMm: 2, role: 'expression-driver' }, { scalar: 'size + 1', valueMm: 3, role: 'expression-driver' }] });
    expect(JSON.stringify(document)).toBe(exact);
  });

  it('reports native graph freedom and exact relation drivers without publishing a solved graph', async () => {
    const document = source(), exact = JSON.stringify(document);
    const inspection = await inspectCadSketchConstraints(document, 'sketch', async () => solver);
    expect(inspection).toMatchObject({ sketchId: 'sketch', pointCount: 2, entityCount: 1, relationCount: 2, legacyProfileCount: 0,
      analysis: { kind: 'solved', diagnostics: { status: 'success', degreesOfFreedom: 0 } } });
    expect(inspection.graph).toBe(document.features[0].kind === 'sketch' ? document.features[0].graph : null);
    expect(JSON.stringify(document)).toBe(exact);
    const relations = pageCadSketchConstraints(inspection, { section: 'relations', offset: 1, limit: 1 });
    expect(relations).toMatchObject({ total: 2, nextOffset: null, items: [{ source: { id: 'length', value: ' span ' },
      value: { scalar: ' span ', valueMm: 20, role: 'expression-driver' },
      points: [{ id: 'a', position: [{ scalar: ' 0 ', role: 'expression-driver' }, { scalar: '0', role: 'expression-driver' }] },
        { id: 'b', position: [{ scalar: 20, role: 'solver-variable' }, { scalar: 0, role: 'solver-variable' }] }] }] });
    expect(pageCadSketchConstraints(inspection, { section: 'points', offset: 1, limit: 1 })).toMatchObject({ total: 2, nextOffset: null,
      items: [{ id: 'b', entityIds: ['edge'], entityCount: 1, omittedEntityCount: 0 }] });
    expect(pageCadSketchConstraints(inspection, { section: 'entities' })).toMatchObject({ total: 1, nextOffset: null,
      items: [{ source: { id: 'edge', startPointId: 'a', endPointId: 'b' }, points: [{ id: 'a' }, { id: 'b' }], measurement: { kind: 'line', lengthMm: 20, deltaMm: [20, 0] } }] });
    expect(pageCadSketchConstraints(inspection, { offset: 2 })).toEqual({ items: [], total: 2, nextOffset: null });
    const original = document.features[0]; if (original.kind !== 'sketch' || !original.graph) throw Error('Missing graph');
    const originalGraph = original.graph;
    const diagnosed = await inspectCadSketchConstraints(document, 'sketch', async () => ({ solve: async () => ({ kind: 'solved',
      graph: { ...originalGraph, points: originalGraph.points.map(p => p.id === 'b' ? { ...p, position: [15, 0] } : p) }, diagnostics: inspection.analysis.diagnostics }) }));
    expect(diagnosed.analysis.kind).toBe('solved');
    expect(pageCadSketchConstraints(diagnosed, { section: 'entities' }).items[0]).toMatchObject({ measurement: { lengthMm: 20, deltaMm: [20, 0] } });
    expect(JSON.stringify(document)).toBe(exact);

  });

  it('asks native which points and entities are defined, then pages and counts each state', async () => {
    const original = source(), sketch = original.features[0];
    if (sketch.kind !== 'sketch' || !sketch.graph) throw new Error('Missing fixture graph');
    // A free point joined to the driven line: the line is defined, the tail is not.
    const document = parseCadDocument({ ...original, features: [{ ...sketch, graph: { ...sketch.graph, points: [...sketch.graph.points, { id: 'c', position: [25, 4] }],
      entities: [...sketch.graph.entities, { id: 'tail', kind: 'line', construction: false, startPointId: 'b', endPointId: 'c' }] } }] });
    const inputs: unknown[] = [];
    const inspection = await inspectCadSketchConstraints(document, 'sketch', async () => ({ solve: input => { inputs.push(input); return solver.solve(input); } }));
    expect(inputs).toMatchObject([{ analyseDefinition: true }]);
    expect(pageCadSketchConstraints(inspection, { section: 'points' }).items).toMatchObject([{ id: 'a', definition: 'defined' }, { id: 'b', definition: 'defined' },
      { id: 'c', definition: 'under-defined' }]);
    expect(pageCadSketchConstraints(inspection, { section: 'entities' }).items).toMatchObject([{ source: { id: 'edge' }, definition: 'defined',
      points: [{ id: 'a', definition: 'defined' }, { id: 'b', definition: 'defined' }] }, { source: { id: 'tail' }, definition: 'under-defined' }]);
    expect(summarizeCadSketchConstraintAnalysis(inspection.analysis, inspection)).toMatchObject({ degreesOfFreedom: 2,
      definition: { points: { defined: 2, underDefined: 1, unknown: 0 }, entities: { defined: 1, underDefined: 1, unknown: 0 } } });
    expect(summarizeCadSketchConstraintAnalysis(inspection.analysis)).not.toHaveProperty('definition');
    // Nothing is classified without a solution.
    const duplicated = parseCadDocument({ ...document, features: [{ ...sketch, graph: { ...sketch.graph, relations: [...sketch.graph.relations,
      { id: 'duplicate', kind: 'distance', pointIds: ['a', 'b'], value: ' span ' }] } }] });
    const rejected = await inspectCadSketchConstraints(duplicated, 'sketch', async () => solver);
    expect(rejected.analysis.kind).toBe('rejected');
    expect(pageCadSketchConstraints(rejected, { section: 'points' }).items.map(row => 'definition' in row && row.definition)).toEqual(['unknown', 'unknown']);
    expect(summarizeCadSketchConstraintAnalysis(rejected.analysis, rejected)).toMatchObject({
      definition: { points: { defined: 0, underDefined: 0, unknown: 2 }, entities: { defined: 0, underDefined: 0, unknown: 1 } } });
  });

  it('reports redundant native relation identities without repairing accepted source', async () => {
    const original = source(), sketch = original.features[0];
    if (sketch.kind !== 'sketch' || !sketch.graph) throw new Error('Missing fixture graph');
    const document = parseCadDocument({ ...original, features: [{ ...sketch, graph: { ...sketch.graph, relations: [...sketch.graph.relations,
      { id: 'duplicate', kind: 'distance', pointIds: ['a', 'b'], value: ' span ' }] } }] }), exact = JSON.stringify(document);
    const inspection = await inspectCadSketchConstraints(document, 'sketch', async () => solver);
    expect(inspection).toMatchObject({ relationCount: 3, analysis: { kind: 'rejected', reason: 'redundant',
      diagnostics: { status: 'success', redundantIds: ['duplicate'] } } });
    expect(inspection.graph).toBe(document.features[0].kind === 'sketch' ? document.features[0].graph : null);
    expect(pageCadSketchConstraints(inspection, { offset: 2 })).toMatchObject({ items: [{ source: { id: 'duplicate' },
      diagnostics: { conflicting: false, redundant: true, partiallyRedundant: false } }] });
    expect(JSON.stringify(document)).toBe(exact);
  });

  it('reports legacy dimension counts without starting native analysis or inventing graph freedom', async () => {
    const document = parseCadDocument({ ...createCadDocument(), features: [{ id: 'sketch', kind: 'sketch', name: 'Legacy', suppressed: false,
      plane: 'XY', offset: 0, profiles: [{ id: 'circle', name: 'Circle', construction: false,
        constraints: [{ id: 'diameter', kind: 'dimension', quantity: 'diameter' }], geometry: { kind: 'circle', x: 0, y: 0, radius: 5 } }] }] });
    const getSolver = vi.fn(async () => solver);
    const inspection = await inspectCadSketchConstraints(document, 'sketch', getSolver);
    expect(inspection).toMatchObject({ graph: null, pointCount: 0, entityCount: 0, relationCount: 0,
      legacyProfileCount: 1, legacyDimensionCount: 1, degreesOfFreedomScope: 'graph', analysis: { kind: 'legacy',
        diagnostics: { status: null, degreesOfFreedom: null } } });
    expect(getSolver).not.toHaveBeenCalled();
    expect(pageCadSketchConstraints(inspection, {})).toEqual({ items: [], total: 0, nextOffset: null });
  });

  it('keeps native graph freedom separate from coexisting legacy primitive dimensions', async () => {
    const document = parseCadDocument({ ...createCadDocument(), schemaVersion: 2, features: [{ id: 'sketch', kind: 'sketch', name: 'Mixed source', suppressed: false,
      plane: 'XY', offset: 0, profiles: [{ id: 'circle', name: 'Circle', construction: false,
        constraints: [{ id: 'diameter', kind: 'dimension', quantity: 'diameter' }], geometry: { kind: 'circle', x: 100, y: 0, radius: 5 } }],
      graph: { points: [{ id: 'free', position: [1, 2] }], entities: [], relations: [] } }] });
    const exact = JSON.stringify(document), inspection = await inspectCadSketchConstraints(document, 'sketch', async () => solver);
    expect(inspection).toMatchObject({ pointCount: 1, legacyProfileCount: 1, legacyDimensionCount: 1, degreesOfFreedomScope: 'graph',
      analysis: { kind: 'solved', diagnostics: { status: 'success', degreesOfFreedom: 2 } } });
    expect(JSON.stringify(document)).toBe(exact);
  });

  it('keeps native failure retryable and propagates cancellation instead of reporting unavailable', async () => {
    const document = source(), exact = JSON.stringify(document);
    const failed = await inspectCadSketchConstraints(document, 'sketch', async () => { throw new Error('slot-3: Worker initialization failed after 2e-13 s'); });
    expect(failed.analysis).toMatchObject({ kind: 'unavailable', message: 'slot-3: Worker initialization failed after 2e-13 s', diagnostics: {
      status: null, degreesOfFreedom: null, conflictingIds: [], redundantIds: [] } });
    expect(pageCadSketchConstraints(failed, { limit: 1 })).toMatchObject({ items: [{ diagnostics: null }] });
    const abort = new AbortController();
    await expect(inspectCadSketchConstraints(document, 'sketch', async () => { abort.abort(); return solver; }, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(JSON.stringify(document)).toBe(exact);
    expect((await inspectCadSketchConstraints(document, 'sketch', async () => solver)).analysis.kind).toBe('solved');
  });

  it('reports a solver that failed rather than judged the sketch as an unavailable analysis naming that cause, with its words bounded for agents, and the sketch refusal its header shows', async () => {
    const words = `The reply could not be deserialized: ${'孔'.repeat(1000)}`;
    const failed = await inspectCadSketchConstraints(source(), 'sketch', async () => ({ solve: async () => { throw new CadSketchSolverFailure(CAD_SKETCH_SOLVER_UNREADABLE, words); } }));
    expect(failed.analysis).toMatchObject({ kind: 'unavailable', message: CAD_SKETCH_SOLVER_UNREADABLE, cause: 'solver-unavailable', kernelMessage: words,
      diagnostics: { status: null, degreesOfFreedom: null } });
    const summary = summarizeCadSketchConstraintAnalysis(failed.analysis) as Record<string, unknown>;
    expect(summary).toMatchObject({ kind: 'unavailable', message: CAD_SKETCH_SOLVER_UNREADABLE, cause: 'solver-unavailable', kernelMessage: expect.stringMatching(/^The reply could not be deserialized: 孔+…$/) });
    expect(new TextEncoder().encode(JSON.stringify(summary.kernelMessage)).byteLength).toBeLessThanOrEqual(1024);
    const header = cadSketchIssues({ sketchId: 'sketch', graph: failed.graph!, version: 'v1', analysis: cadSketchAnalysisIssues(failed.analysis) });
    expect(header.refusal).toMatchObject({ code: 'sketch-failed', message: CAD_SKETCH_SOLVER_UNREADABLE, details: { cause: 'solver-unavailable', kernelMessage: words } });
    // A solver whose module cannot be loaded, after an update or with the network down, is the same failure, and the next inspection loads it again.
    const load = vi.fn<() => Promise<CadSketchSolverClient>>(async () => { throw new TypeError('Failed to fetch dynamically imported module: https://example.test/assets/cadSketchSolverClient-1a2b3c.js'); }), loader = createCadSketchSolverLoader(load);
    const unloaded = await inspectCadSketchConstraints(source(), 'sketch', loader.load);
    expect(unloaded.analysis).toMatchObject({ kind: 'unavailable', message: CAD_SKETCH_SOLVER_NOT_LOADED, cause: 'solver-unavailable', kernelMessage: 'Failed to fetch dynamically imported module: https://example.test/assets/cadSketchSolverClient-1a2b3c.js' });
    expect(summarizeCadSketchConstraintAnalysis(unloaded.analysis)).toMatchObject({ cause: 'solver-unavailable', kernelMessage: 'Failed to fetch dynamically imported module: https://example.test/assets/cadSketchSolverClient-1a2b3c.js' });
    expect(cadSketchIssues({ sketchId: 'sketch', graph: unloaded.graph!, version: 'v1', analysis: cadSketchAnalysisIssues(unloaded.analysis) }).refusal)
      .toMatchObject({ code: 'sketch-failed', message: CAD_SKETCH_SOLVER_NOT_LOADED, details: { cause: 'solver-unavailable', kernelMessage: 'Failed to fetch dynamically imported module: https://example.test/assets/cadSketchSolverClient-1a2b3c.js' } });
    load.mockResolvedValueOnce({ ...solver, dispose: () => undefined });
    expect((await inspectCadSketchConstraints(source(), 'sketch', loader.load)).analysis).not.toHaveProperty('cause');
    expect(load).toHaveBeenCalledTimes(2);
    // A native instance that traps is the same failure, and the next inspection runs on a fresh instance.
    let loads = 0;
    const runtime = createCadSketchNativeRuntime({ loadNative: async () => ++loads === 1
      ? { memoryBytes: () => 0, solve: () => { throw new WebAssembly.RuntimeError('unreachable'); } } : loadCadSketchTestNativeSolver() });
    const trapped = await inspectCadSketchConstraints(source(), 'sketch', async () => runtime);
    expect(trapped.analysis).toMatchObject({ kind: 'unavailable', message: CAD_SKETCH_NATIVE_FAILED, cause: 'solver-unavailable', kernelMessage: 'unreachable' });
    expect(cadSketchIssues({ sketchId: 'sketch', graph: trapped.graph!, version: 'v1', analysis: cadSketchAnalysisIssues(trapped.analysis) }).refusal)
      .toMatchObject({ code: 'sketch-failed', message: CAD_SKETCH_NATIVE_FAILED, details: { cause: 'solver-unavailable', kernelMessage: 'unreachable' } });
    expect((await inspectCadSketchConstraints(source(), 'sketch', async () => runtime)).analysis.kind).toBe('solved'); expect(loads).toBe(2);
    // Any other failure, such as a full queue, stays an unavailable analysis without that cause, and no refusal.
    const other = await inspectCadSketchConstraints(source(), 'sketch', async () => ({ solve: async () => { throw new Error('The sketch solve queue is full.'); } }));
    expect(other.analysis).toMatchObject({ kind: 'unavailable', message: 'The sketch solve queue is full.' });
    expect(other.analysis).not.toHaveProperty('cause');
    expect(summarizeCadSketchConstraintAnalysis(other.analysis)).not.toHaveProperty('cause');
    expect(cadSketchAnalysisIssues(other.analysis)).toBeNull();
  });

  it('bounds native diagnostic summaries and keeps unknown freedom distinct from zero', async () => {
    const ids = Array.from({ length: 300 }, (_, index) => `relation-${index}-${'a'.repeat(75)}`);
    const inspection = await inspectCadSketchConstraints(source(), 'sketch', async () => ({ solve: async () => ({
      kind: 'rejected', reason: 'conflicting', message: '孔'.repeat(20_000), diagnostics: { status: 'failed', degreesOfFreedom: -1,
        conflictingIds: ids, redundantIds: ids, partiallyRedundantIds: ids,
        issues: ids.map(id => ({ source: { kind: 'relation', id }, code: 'relation-residual', message: '孔'.repeat(2000) })) }
    }) }));
    expect(inspection.analysis.diagnostics.degreesOfFreedom).toBeNull();
    const summary = summarizeCadSketchConstraintAnalysis(inspection.analysis);
    expect(summary).toMatchObject({ kind: 'rejected', status: 'failed', degreesOfFreedom: null,
      conflicting: { ids: ids.slice(0, 8), count: 300, omittedCount: 292 }, issueCount: 300, omittedIssueCount: 298 });
    expect(new TextEncoder().encode(JSON.stringify(summary)).byteLength).toBeLessThan(8 * 1024);
    expect(inspection.analysis.diagnostics.conflictingIds).toEqual(ids);
  });
});


it('exposes actual pattern ownership and stable omitted mappings without changing accepted source',async()=>{
  const document=applyCadEdits(circleRowPart(),[{kind:'set-sketch-relation',sketchId:'sketch',relation:{...circleRow,omittedInstances:[2]}}]);
  const exact=JSON.stringify(document), inspection=await inspectCadSketchConstraints(document,'sketch',async()=>solver);
  expect(inspection.analysis).toMatchObject({kind:'solved',diagnostics:{degreesOfFreedom:0}});
  const rows=pageCadSketchConstraints(inspection,{section:'entities'}).items;
  expect(rows.find(row=>'source'in row&&row.source.id==='seed')).toMatchObject({pattern:{relationId:'row',index:0,seedEntityId:'seed',role:'seed'}});
  expect(rows.find(row=>'source'in row&&row.source.id==='holes_i3_e0')).toMatchObject({pattern:{relationId:'row',index:3,seedEntityId:'seed',role:'generated'},radius:{valueMm:3}});
  const owner=pageCadSketchConstraints(inspection,{section:'relations'}).items[0];
  expect(owner).toMatchObject({source:{id:'row'},pattern:{count:4,direction:'+x',pitch:{scalar:' pitch ',valueMm:15,role:'expression-driver'},instances:expect.arrayContaining([{index:2,pointId:'holes_i2_p0',entityId:'holes_i2_e0',inRange:true,omitted:true,active:false}])}});
  expect(JSON.stringify(document)).toBe(exact);
});


it('inspects symmetry with all point and axis identities and no invented value or size driver',async()=>{
  const source=symmetryPart(),prepared=await prepareCadEdits(source,[{kind:'set-sketch-relation',sketchId:'sketch',relation:symmetricRelation}],solver);
  const inspection=await inspectCadSketchConstraints(prepared.document,'sketch',async()=>solver);const row=pageCadSketchConstraints(inspection,{section:'relations'}).items[0];
  expect(row).toMatchObject({source:symmetricRelation,entityIds:['axis'],points:[{id:'left'},{id:'right'},{id:'axis-a'},{id:'axis-b'}]});expect(row).not.toHaveProperty('value');
});

it('inspects actual point-on-line dependencies and sliding freedom without inventing a dimension',async()=>{
  const source=pointOnLinePart(),prepared=await prepareCadEdits(source,[{kind:'set-sketch-relation',sketchId:'sketch',relation:pointOnLineRelation}],solver);
  const inspection=await inspectCadSketchConstraints(prepared.document,'sketch',async()=>solver),row=pageCadSketchConstraints(inspection,{section:'relations'}).items[0];
  expect(inspection.analysis).toMatchObject({kind:'solved',diagnostics:{degreesOfFreedom:1}});
  expect(row).toMatchObject({source:pointOnLineRelation,entityIds:['guide'],points:[{id:'p'},{id:'a'},{id:'b'}]});expect(row).not.toHaveProperty('value');
});

it('inspects the tangent endpoint tuple and every support without inventing a radius driver',async()=>{
  const source=tangentPart(),prepared=await prepareCadEdits(source,[{kind:'set-sketch-relation',sketchId:'sketch',relation:tangentJoint}],solver);
  const inspection=await inspectCadSketchConstraints(prepared.document,'sketch',async()=>solver),row=pageCadSketchConstraints(inspection,{section:'relations'}).items.find(row=>'source'in row&&row.source.id===tangentJoint.id);
  expect(inspection.analysis).toMatchObject({kind:'solved',diagnostics:{degreesOfFreedom:0}});expect(row).toMatchObject({source:tangentJoint});
  if(!row||!('points'in row)||!('entityIds'in row))throw Error('Missing tangent dependencies');
  expect(new Set(row.points.map(point=>point.id))).toEqual(new Set(['a','j','c','e']));expect(new Set(row.entityIds)).toEqual(new Set(['line','arc']));expect(row).not.toHaveProperty('value');
});
