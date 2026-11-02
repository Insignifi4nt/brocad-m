// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CadSketchFeature } from '@/domain/cad/cadDocument';
import { setCadDevelopmentChecks } from '@/domain/cad/cadDevelopmentChecks';
import { measureCadSketch } from '@/domain/cad/cadMeasurements';
import { createCadDocument, parseCadDocument } from '@/domain/cad/cadSchema';
import { cadSketchToEntities, resolveCadSketchRegions } from '@/domain/cad/cadSketchGeometry';
import { compileCadSketchGraph, type CadSketchGraphGeometry } from '@/domain/cad/cadSketchGraphGeometry';
import { cadSketchGraphCircleControl, prepareCadSketchGraphInteraction } from './cadSketchGraphInteraction';
import { prepareCadViewportReferences, selectCadViewportReferences } from './cadViewportReferences';

// Every compiled graph made while the test runs, with its text when it was made.
const compiled: { readonly result: CadSketchGraphGeometry; readonly text: string }[] = [];
vi.mock('@/domain/cad/cadSketchGraphGeometry', async importActual => {
  const actual = await importActual<typeof import('@/domain/cad/cadSketchGraphGeometry')>();
  return { ...actual, compileCadSketchGraph: (...args: Parameters<typeof actual.compileCadSketchGraph>) => {
    const result = actual.compileCadSketchGraph(...args);
    compiled.push({ result, text: JSON.stringify(result) });
    return result;
  } };
});

const generator = (id: string, geometry: Record<string, unknown>) => ({ id, kind: 'generator', idPrefix: id, construction: false, geometry });
/** Generated and drawn cycles, a construction circle, an open edge and two crossing edges, apart from one another. */
const document = () => parseCadDocument({ ...createCadDocument('Read only', 'read_only'), schemaVersion: 2, parameters: { side: 10 }, features: [
  { id: 'sketch', kind: 'sketch', name: 'Sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
    points: [{ id: 'a', position: [100, 0] }, { id: 'b', position: ['100 + side', 0] }, { id: 'c', position: ['100 + side', 'side'] }, { id: 'd', position: [100, 'side'] },
      { id: 'o', position: [150, 0] }, { id: 'p', position: [170, 0] }, { id: 'q', position: [200, 0] }, { id: 'r', position: [210, 10] },
      { id: 's', position: [200, 10] }, { id: 't', position: [210, 0] }],
    entities: [{ id: 'ab', kind: 'line', construction: false, startPointId: 'a', endPointId: 'b' }, { id: 'bc', kind: 'line', construction: false, startPointId: 'b', endPointId: 'c' },
      { id: 'cd', kind: 'line', construction: false, startPointId: 'c', endPointId: 'd' }, { id: 'da', kind: 'line', construction: false, startPointId: 'd', endPointId: 'a' },
      { id: 'guide', kind: 'circle', construction: true, centerPointId: 'o', radius: 5 }, { id: 'open', kind: 'line', construction: false, startPointId: 'o', endPointId: 'p' },
      { id: 'qr', kind: 'line', construction: false, startPointId: 'q', endPointId: 'r' }, { id: 'st', kind: 'line', construction: false, startPointId: 's', endPointId: 't' }],
    relations: [generator('rounded', { kind: 'rectangle', x: 0, y: 0, width: 20, height: 12, cornerRadius: 3 }),
      generator('hexagon', { kind: 'regular-polygon', x: 50, y: 0, radius: 'side', sides: 6, directionId: '@h' })] } }] });

describe('compiled sketch graphs in production', () => {
  beforeAll(() => setCadDevelopmentChecks(false));
  afterAll(() => setCadDevelopmentChecks(true));

  it('freeze their lists and cycles, and no load, region, export, measurement, interaction or reference consumer writes into them', () => {
    const part = document(), sketch = part.features[0] as CadSketchFeature, graph = sketch.graph!;
    resolveCadSketchRegions(sketch, part.parameters); cadSketchToEntities(sketch, part.parameters); measureCadSketch(part, 'sketch');
    const interaction = prepareCadSketchGraphInteraction(graph, part.parameters);
    expect(prepareCadSketchGraphInteraction(graph, part.parameters)).toBe(interaction);
    interaction.pick([105, 0], 0.5, 'edges'); interaction.pick([150, 0], 0.5, 'points'); cadSketchGraphCircleControl(graph, part.parameters, 'guide');
    const references = prepareCadViewportReferences(part.features, part.parameters), kept = references.filter(reference => reference.featureId === 'sketch');
    const again = prepareCadViewportReferences(part.features, part.parameters).filter(reference => reference.featureId === 'sketch');
    expect(kept.length).toBeGreaterThan(0); expect(again.every((reference, index) => reference === kept[index])).toBe(true);
    selectCadViewportReferences(references, part, 'sketch');
    expect(compiled.length).toBeGreaterThan(3);
    for (const { result, text } of compiled) {
      expect(JSON.stringify(result)).toBe(text);
      expect([result, result.segments, result.cycles, result.openEntityIds, result.branchedEntityIds, result.arrangementEntityIds, ...result.cycles,
        ...result.cycles.flatMap(cycle => [cycle.sourceRefs, cycle.path])].every(Object.isFrozen)).toBe(true);
      // The segments and points are left to the readonly types: freezing each costs more than compiling it.
      expect(Object.isFrozen(result.segments[0])).toBe(false);
    }
    const last = compiled.at(-1)!.result;
    expect(last.cycles.map(cycle => cycle.construction).sort()).toEqual([false, false, false, true]); expect(last.openEntityIds).toEqual(['open', 'qr', 'st']); expect(last.arrangementEntityIds).toEqual(['qr', 'st']);
  });

  it('are frozen through every segment and point under development checks', () => {
    setCadDevelopmentChecks(true);
    try {
      const sketch = document().features[0] as CadSketchFeature, result = compileCadSketchGraph(sketch.graph!, { side: 10 });
      expect([result.segments[0], result.segments[0].start, result.cycles[0].path[0], result.cycles[0].sourceRefs[0]].every(Object.isFrozen)).toBe(true);
    } finally { setCadDevelopmentChecks(false); }
  });
});
