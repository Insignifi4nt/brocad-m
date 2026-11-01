// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import initOpenCascade from 'replicad-opencascadejs';
import { getOC, makeBox, makeCompound, setOC } from 'replicad';
import type { CadDocument, CadFeature, CadPlane } from '../../../domain/cad/cadDocument';
import { parseCadDocument } from '../../../domain/cad/cadSchema';
import type { CadEdgeSelection, CadTopologyDescriptor, CadTopologyPick } from '../../../domain/cad/cadTopology';
import { isCadTopologyInspectResult } from '../../../domain/cad/cadTopology';
import { buildCadKernelModel, type CadKernelModel } from './cadKernelModel';
import { CadKernelTopology } from './cadKernelTopology';
import { createCadKernelRuntime } from './cadKernelRuntime';
import { isCadKernelReply } from './cadKernelProtocol';
import { cadKernelPlaneBasis } from './cadKernelPlane';
import { isCadTopologyAdjacency, isCadTopologyTangentChain, type CadTopologyAdjacency, type CadTopologyTangentChain } from '../../../domain/cad/cadTopologyAdjacency';
import { cadTopologyFaceLoop, cadTopologyTangentFaces } from '../../../domain/cad/selection/cadTopologySelection';

beforeAll(async () => {
  const wasmBinary = await readFile(new URL('../../../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  setOC(await initOpenCascade({ wasmBinary, print: () => undefined, printErr: () => undefined }));
}, 60_000);
const base = (id: string) => ({ id, name: id, suppressed: false });
function boxDocument(plane: CadPlane = 'XY', offset = 0): CadDocument {
  return { format: 'wireedm-cad', schemaVersion: 1, id: 'part', name: 'Part', units: 'mm', parameters: { width: 20, height: 10, depth: 5 }, features: [
    { ...base('sketch'), kind: 'sketch', plane, offset, profiles: [{ id: 'outer', name: 'Outer', construction: false, role: 'outer',
      geometry: { kind: 'rectangle', x: 0, y: 0, width: 'width', height: 'height', cornerRadius: 0 } }] },
    { ...base('box'), kind: 'extrude', sketchId: 'sketch', distance: 'depth', symmetric: false, operation: 'new', targetId: null },
  ] };
}
const withFeatures = (document: CadDocument, ...features: CadFeature[]) => parseCadDocument({ ...document, features: [...document.features, ...features] });
function built(document: CadDocument, check: (model: CadKernelModel) => void) {
  const model = buildCadKernelModel(document);
  try { check(model); } finally { model.dispose(); }
}
function page(model: CadKernelModel, kind: 'edge' | 'face', bodyId = 'box'): readonly CadTopologyDescriptor[] {
  return model.inspectTopology({ bodyId, expectedBuildId: model.result.buildId, selection: { kind: 'page', topology: kind, offset: 0, limit: 100 } }).descriptors;
}
const selected: CadEdgeSelection = { expectedCount: 1, queries: [{ kind: 'edges', expectedCount: 1,
  predicates: [{ kind: 'line-endpoints', start: [0, 0, 'depth'], end: ['width', 0, 'depth'] }] }] };

describe('exact topology and selected mechanical features', () => {
  it('preserves valid material and exact face/edge picks when every bounded public hash collides', () => {
    const hasher = vi.spyOn(getOC().ReplicadShapeHasher, 'HashCode').mockReturnValue(1);
    try {
      built(boxDocument(), model => {
        expect(model.result.diagnostics).toEqual([]);
        const mesh = model.result.meshes[0], edges = page(model, 'edge'), faces = page(model, 'face');
        expect(mesh.volume).toBeCloseTo(1000, 8);
        expect(edges).toHaveLength(12); expect(faces).toHaveLength(6);
        expect(new Set(mesh.edgeGroups.map(group => group.key)).size).toBe(12);
        expect(new Set(mesh.faceGroups.map(group => group.key)).size).toBe(6);
        expect(mesh.faceGroups.reduce((sum, group) => sum + group.count, 0)).toBe(mesh.indices.length);
        expect(mesh.edgeGroups.reduce((sum, group) => sum + group.count, 0)).toBe(mesh.edges.length / 3);
        for (const group of mesh.edgeGroups) {
          const edge = edges.find(entry => entry.key === group.key);
          if (edge?.kind !== 'edge' || edge.curveType !== 'line') throw new Error('Missing exact edge descriptor.');
          const start = mesh.edges.slice(group.start * 3, group.start * 3 + 3);
          const end = mesh.edges.slice((group.start + group.count - 1) * 3, (group.start + group.count) * 3);
          const endpoints = [edge.start, edge.end];
          expect(endpoints.some(point => point.every((value, axis) => Math.abs(value - start[axis]) < 1e-7))).toBe(true);
          expect(endpoints.some(point => point.every((value, axis) => Math.abs(value - end[axis]) < 1e-7))).toBe(true);
          expect(model.resolveTopologyPicks({ bodyId: 'box', expectedBuildId: model.result.buildId, purpose: 'fillet', picks: [{ kind: 'edge', key: edge.key }] })).toMatchObject({ purpose: 'fillet', selection: { expectedCount: 1 } });
        }
        for (const group of mesh.faceGroups) {
          const face = faces.find(entry => entry.key === group.key);
          if (face?.kind !== 'face' || face.surfaceType !== 'plane') throw new Error('Missing exact face descriptor.');
          for (const index of mesh.indices.slice(group.start, group.start + group.count)) {
            const distance = face.normal.reduce((sum, value, axis) => sum + value * mesh.positions[index * 3 + axis], 0);
            expect(distance).toBeCloseTo(face.offset, 7);
          }
          expect(model.resolveTopologyPicks({ bodyId: 'box', expectedBuildId: model.result.buildId, purpose: 'shell', picks: [{ kind: 'face', key: face.key }] })).toMatchObject({ purpose: 'shell', opening: { expectedCount: 1 } });
        }
        expect(model.section({ bodyId: 'box', plane: 'XY', offset: 2 }).contourCount).toBe(1);
      });
    } finally { hasher.mockRestore(); }
  });
  it('maps face indices and edge vertices to exact opaque topology and paginates without duplicates', () => {
    built(boxDocument(), model => {
      expect(model.result.diagnostics).toEqual([]);
      expect(isCadKernelReply({ id: 1, kind: 'built', result: model.result })).toBe(true);
      const mesh = model.result.meshes[0];
      expect(mesh.faceGroups.reduce((sum, group) => sum + group.count, 0)).toBe(mesh.indices.length);
      expect(mesh.edgeGroups.reduce((sum, group) => sum + group.count, 0)).toBe(mesh.edges.length / 3);
      expect(mesh.faceGroups.map(group => group.start)).toEqual([0, 6, 12, 18, 24, 30]);
      const edges = page(model, 'edge'); const faces = page(model, 'face');
      expect(edges).toHaveLength(12); expect(faces).toHaveLength(6);
      expect(new Set(edges.map(edge => edge.key)).size).toBe(12);
      expect(mesh.edgeGroups.every(group => edges.some(edge => edge.key === group.key))).toBe(true);
      expect(mesh.faceGroups.every(group => faces.some(face => face.key === group.key))).toBe(true);
      const first = model.inspectTopology({ bodyId: 'box', expectedBuildId: model.result.buildId, selection: { kind: 'page', topology: 'face', offset: 0, limit: 2 } });
      expect(first).toMatchObject({ total: 6, nextOffset: 2 }); expect(isCadTopologyInspectResult(first)).toBe(true);
      const last = model.inspectTopology({ bodyId: 'box', expectedBuildId: model.result.buildId, selection: { kind: 'page', topology: 'face', offset: 4, limit: 2 } });
      expect(last.nextOffset).toBeNull();
      const top = faces.find(face => face.kind === 'face' && face.surfaceType === 'plane' && face.normal[2] > .99);
      expect(top?.kind === 'face' && top.area).toBeCloseTo(200, 6);
      expect(top).toMatchObject({ offset: 5 });
    });
  });
  it('atomically converts picks to geometric selectors and applies only the selected edge', () => {
    let selection: CadEdgeSelection = selected;
    built(boxDocument(), model => {
      const edge = page(model, 'edge').find(edge => edge.kind === 'edge' && edge.curveType === 'line' && edge.length === 20 && edge.start[1] === 0 && edge.start[2] === 5);
      expect(edge).toBeDefined(); if (!edge) throw new Error('Missing top edge');
      const picked = { kind: 'edge' as const, key: edge.key };
      const resolved = model.resolveTopologyPicks({ bodyId: 'box', expectedBuildId: model.result.buildId, purpose: 'fillet', picks: [picked] });
      expect(resolved.purpose).toBe('fillet'); if (resolved.purpose === 'shell') throw new Error('Unexpected shell selector');
      selection = resolved.selection;
      expect(JSON.stringify(selection)).not.toContain(edge.key);
      expect(selection).toMatchObject({ expectedCount: 1, queries: [{ expectedCount: 1 }] });
      expect(() => model.resolveTopologyPicks({ bodyId: 'box', expectedBuildId: model.result.buildId, purpose: 'fillet', picks: [picked, { kind: 'edge', key: 'unknown' }] })).toThrow('does not belong');
    });
    built(withFeatures(boxDocument(), { ...base('round'), kind: 'fillet', targetId: 'box', radius: .5, selection }), model => {
      expect(model.result.diagnostics).toEqual([]);
      expect(model.result.meshes[0].volume).toBeCloseTo(1000 - (1 - Math.PI / 4) * .5 ** 2 * 20, 6);
    });
    built(withFeatures(boxDocument(), { ...base('bevel'), kind: 'chamfer', targetId: 'box', radius: 1, selection }), model => {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo(990, 6);
    });
  });
  it('re-resolves parameter expressions after dimensional changes and rejects missing or ambiguous matches', () => {
    built(withFeatures({ ...boxDocument(), parameters: { width: 30, height: 10, depth: 5 } }, { ...base('bevel'), kind: 'chamfer', targetId: 'box', radius: 1, selection: selected }), model => {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo(1485, 6);
    });
    for (const selection of [
      { expectedCount: 1, queries: [{ kind: 'edges' as const, expectedCount: 1, predicates: [{ kind: 'length' as const, value: 10 }] }] },
      { expectedCount: 1, queries: [{ kind: 'edges' as const, expectedCount: 1, predicates: [{ kind: 'length' as const, value: 123 }] }] },
    ]) built(withFeatures(boxDocument(), { ...base('bad'), kind: 'fillet', targetId: 'box', radius: .5, selection }), model => {
      expect(model.result.diagnostics[0].code).toMatch(/selection-(count-mismatch|empty)/);
      expect(model.result.meshes[0].featureId).toBe('box'); expect(model.result.meshes[0].volume).toBeCloseTo(1000, 6);
      expect(() => model.export('step')).toThrow('Fix the feature diagnostics');
    });
  });
  it.each(['fillet', 'chamfer'] as const)('preserves an exact concave %s through a planar CAM section', kind => {
    const original = boxDocument(); const sketch = original.features[0];
    if (sketch.kind !== 'sketch') throw new Error('Expected sketch');
    const document = parseCadDocument({ ...original, features: [{ ...sketch, profiles: [{ ...sketch.profiles[0],
      geometry: { kind: 'polygon', points: [[0, 0], [20, 0], [20, 10], [10, 10], [10, 20], [0, 20]] } }] }, original.features[1]] });
    const selection: CadEdgeSelection = { expectedCount: 1, queries: [{ kind: 'edges', expectedCount: 1,
      predicates: [{ kind: 'line-endpoints', start: [10, 10, 0], end: [10, 10, 'depth'] }] }] };
    built(withFeatures(document, { ...base('finished'), kind, targetId: 'box', radius: 1, selection }), model => {
      expect(model.result.diagnostics).toEqual([]);
      const addedArea = kind === 'fillet' ? 1 - Math.PI / 4 : .5;
      expect(model.result.meshes[0].volume).toBeCloseTo((300 + addedArea) * 5, 6);
      const section = model.section({ bodyId: 'finished', plane: 'XY', offset: 2 });
      expect(section.contourCount).toBe(1);
      if (kind === 'fillet') {
        const arcs = section.entities.filter(entity => entity.type === 'arc');
        expect(arcs).toHaveLength(1);
        expect(arcs[0].radius).toBeCloseTo(1, 8);
        expect(arcs[0].center).toMatchObject({ x: 11, y: 11 });
        expect(Math.abs(arcs[0].sweepRadians ?? 0)).toBeCloseTo(Math.PI / 2, 8);
      } else {
        expect(section.entities.every(entity => entity.type === 'line')).toBe(true);
        expect(section.entities).toHaveLength(7);
      }
    });
  });
  it('deduplicates overlapping query unions but requires both individual and union counts', () => {
    const overlapping = { queries: [selected.queries[0], selected.queries[0]], expectedCount: 1 };
    built(withFeatures(boxDocument(), { ...base('bevel'), kind: 'chamfer', targetId: 'box', radius: 1, selection: overlapping }), model => {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo(990, 6);
    });
    built(withFeatures(boxDocument(), { ...base('bad'), kind: 'chamfer', targetId: 'box', radius: 1, selection: { ...overlapping, expectedCount: 2 } }), model => {
      expect(model.result.diagnostics[0].code).toBe('selection-count-mismatch'); expect(model.result.meshes[0].volume).toBeCloseTo(1000);
    });
  });
  it('rejects unselected tangent propagation and accepts an explicitly selected complete rounded rim', () => {
    const original = boxDocument(); const sketch = original.features[0];
    if (sketch.kind !== 'sketch') throw new Error('Expected sketch');
    const document = parseCadDocument({ ...original, features: [{ ...sketch, profiles: sketch.profiles.map(profile => ({ ...profile,
      geometry: { kind: 'rectangle', x: 0, y: 0, width: 20, height: 10, cornerRadius: 2 } })) }, original.features[1]] });
    let selection = selected;
    built(document, model => {
      const arc = page(model, 'edge').find(edge => edge.kind === 'edge' && edge.curveType === 'circle' && edge.center[2] === 5);
      if (!arc) throw new Error('Missing top corner arc');
      const resolved = model.resolveTopologyPicks({ bodyId: 'box', expectedBuildId: model.result.buildId, purpose: 'fillet', picks: [{ kind: 'edge', key: arc.key }] });
      if (resolved.purpose === 'shell') throw new Error('Unexpected face selector'); selection = resolved.selection;
    });
    for (const kind of ['fillet', 'chamfer'] as const) {
      built(withFeatures(document, { ...base('partial'), kind, targetId: 'box', radius: .5, selection }), model => {
        expect(model.result.diagnostics[0].code).toBe('selection-tangent-chain'); expect(model.result.meshes[0].featureId).toBe('box');
      });
      built(withFeatures(document, { ...base('complete'), kind, targetId: 'box', radius: .5, selection: {
        expectedCount: 8, queries: [{ kind: 'edges', expectedCount: 8, predicates: [{ kind: 'on-plane', normal: [0, 0, 1], offset: 5 }] }]
      } }), model => { expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].featureId).toBe('complete'); });
    }
  });
  it.each(['fillet', 'chamfer'] as const)('follows explicitly allowed %s tangent chains from one visible plate or split-bore seed only', kind => {
    const document = parseCadDocument({ ...boxDocument(), parameters: {}, features: [
      { ...base('profile'), kind: 'sketch', plane: 'XY', offset: 0, profiles: [
        { id: 'plate', name: 'Plate', construction: false, geometry: { kind: 'rectangle', x: 0, y: 0, width: 80, height: 50, cornerRadius: 3 } },
        { id: 'bore', name: 'Bore', construction: false, geometry: { kind: 'circle', x: 40, y: 25, radius: 5 } },
      ] },
      { ...base('box'), kind: 'extrude', sketchId: 'profile', distance: 10, symmetric: false, operation: 'new', targetId: null },
    ] });
    const originalText = JSON.stringify(document), original = buildCadKernelModel(document);
    try {
      expect(original.result.diagnostics).toEqual([]);
      expect(original.result.meshes[0].volume).toBeCloseTo(39640 - 160 * Math.PI, 7);
      const edges = page(original, 'edge'), onTop = (edge: CadTopologyDescriptor) => edge.bounds.min[2] === 10 && edge.bounds.max[2] === 10;
      const bore = (edge: CadTopologyDescriptor) => edge.kind === 'edge' && edge.curveType === 'circle' && Math.abs(edge.radius - 5) < 1e-7;
      const outerTop = edges.filter(edge => onTop(edge) && !bore(edge)), boreTop = edges.filter(edge => onTop(edge) && bore(edge));
      expect(outerTop).toHaveLength(8); expect(boreTop).toHaveLength(2);
      const straight = outerTop.find(edge => edge.kind === 'edge' && edge.curveType === 'line' && Math.abs(edge.length - 74) < 1e-7);
      if (!straight) throw new Error('Missing the physically picked 74 mm straight edge');
      const geometry = (items: readonly CadTopologyDescriptor[]) => items.map(({ key: _key, ...value }) => JSON.stringify(value)).sort();
      for (const [seed, complete, unrelated] of [
        [straight, outerTop, edges.filter(edge => edge.bounds.max[2] === 0 || bore(edge))],
        [boreTop[0], boreTop, edges.filter(edge => edge.bounds.max[2] === 0 || onTop(edge) && !bore(edge))],
      ] as const) {
        const resolve = (items: readonly CadTopologyDescriptor[]) => {
          const result = original.resolveTopologyPicks({ bodyId: 'box', expectedBuildId: original.result.buildId, purpose: kind,
            picks: items.map(edge => ({ kind: 'edge' as const, key: edge.key })) });
          if (result.purpose === 'shell') throw new Error('Unexpected shell selector'); return result.selection;
        };
        const selection = resolve([seed]), completeSelection = resolve(complete);
        expect(selection.expectedCount).toBe(1);
        for (const policy of [{}, { tangentPropagation: false }]) built(withFeatures(document,
          { ...base('strict'), kind, targetId: 'box', radius: .5, selection, ...policy }), model => {
          expect(model.result.diagnostics[0]?.code).toBe('selection-tangent-chain');
          expect(model.result.meshes[0].volume).toBe(original.result.meshes[0].volume);
        });
        let completeVolume = 0;
        built(withFeatures(document, { ...base('complete'), kind, targetId: 'box', radius: .5, selection: completeSelection }), model => {
          expect(model.result.diagnostics).toEqual([]); completeVolume = model.result.meshes[0].volume;
        });
        built(withFeatures(document, { ...base('followed'), kind, targetId: 'box', radius: .5, selection, tangentPropagation: true }), model => {
          expect(model.result.diagnostics).toEqual([]);
          expect(model.result.meshes[0].volume).toBeCloseTo(completeVolume, 7);
          expect(model.result.meshes[0].volume).toBeLessThan(original.result.meshes[0].volume);
          const finished = page(model, 'edge', 'followed');
          expect(geometry(finished.filter(edge => unrelated.some(before => geometry([edge])[0] === geometry([before])[0])))).toEqual(geometry(unrelated));
          if (seed === boreTop[0] && kind === 'chamfer') expect(model.result.meshes[0].volume)
            .toBeCloseTo(39640 - 160 * Math.PI - Math.PI * (5 * .5 ** 2 + .5 ** 3 / 3), 7);
        });
        built(withFeatures(document, { ...base('stale-count'), kind, targetId: 'box', radius: .5,
          selection: { ...selection, expectedCount: 2 }, tangentPropagation: true }), model => {
          expect(model.result.diagnostics[0]?.code).toBe('selection-count-mismatch');
          expect(model.result.meshes[0].volume).toBe(original.result.meshes[0].volume);
        });
      }
      expect(JSON.stringify(document)).toBe(originalText);
      expect(page(original, 'edge')).toEqual(edges);
    } finally { original.dispose(); }
  });
  it('selects exactly a circular bore rim, deduplicates seam occurrences and rejects cylindrical shell openings', () => {
    const document = withFeatures(boxDocument(),
      { ...base('hole'), kind: 'sketch', plane: 'XY', offset: 0, profiles: [{ id: 'hole-profile', name: 'Hole', construction: false, role: 'outer', geometry: { kind: 'circle', x: 10, y: 5, radius: 3 } }] },
      { ...base('bore'), kind: 'extrude', sketchId: 'hole', distance: 5, symmetric: false, operation: 'cut', targetId: 'box' });
    let selection: CadEdgeSelection = selected;
    built(document, model => {
      const edges = page(model, 'edge', 'bore'); const faces = page(model, 'face', 'bore');
      expect(edges).toHaveLength(15);
      const circle = edges.find(edge => edge.kind === 'edge' && edge.curveType === 'circle' && Math.abs(edge.center[2] - 5) < 1e-7);
      if (!circle) throw new Error('Missing bore rim');
      const resolved = model.resolveTopologyPicks({ bodyId: 'bore', expectedBuildId: model.result.buildId, purpose: 'chamfer', picks: [{ kind: 'edge', key: circle.key }] });
      if (resolved.purpose === 'shell') throw new Error('Unexpected shell selector'); selection = resolved.selection;
      const cylinder = faces.find(face => face.kind === 'face' && face.surfaceType === 'cylinder'); if (!cylinder) throw new Error('Missing bore wall');
      expect(() => model.resolveTopologyPicks({ bodyId: 'bore', expectedBuildId: model.result.buildId, purpose: 'shell', picks: [{ kind: 'face', key: cylinder.key }] })).toThrow('planar face');
    });
    built(withFeatures(document, { ...base('bevel'), kind: 'chamfer', targetId: 'bore', radius: .5, selection }), model => {
      expect(model.result.diagnostics).toEqual([]);
      expect(model.result.meshes[0].volume).toBeCloseTo(1000 - Math.PI * 3 ** 2 * 5 - Math.PI * (3 * .5 ** 2 + .5 ** 3 / 3), 6);
    });
  });
  it.each(['XY', 'XZ', 'YZ'] as const)('shells inward through one oriented planar face on %s with nonzero offset', async plane => {
    const document = boxDocument(plane, 10); const normal = cadKernelPlaneBasis(plane).normal;
    const shell = withFeatures(document, { ...base('shell'), kind: 'shell', targetId: 'box', thickness: 1,
      opening: { kind: 'faces', expectedCount: 1, predicates: [{ kind: 'plane', normal, offset: 15 }] } });
    const model = buildCadKernelModel(shell);
    try {
      expect(model.result.diagnostics).toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo(424, 6);
      expect(model.section({ bodyId: 'shell', plane, offset: 12 }).contourCount).toBe(2);
      expect((await model.export('step').text())).toContain('MANIFOLD_SOLID_BREP');
    } finally { model.dispose(); }
  });
  it('converts one planar face pick into a shell query and preserves the solid after impossible thickness', () => {
    const opening = { kind: 'faces' as const, expectedCount: 1, predicates: [{ kind: 'plane' as const, normal: [0, 0, 1] as const, offset: 5 }] };
    built(boxDocument(), model => {
      const face = page(model, 'face').find(face => face.kind === 'face' && face.surfaceType === 'plane' && face.normal[2] > .99);
      if (!face) throw new Error('Missing opening');
      const resolved = model.resolveTopologyPicks({ bodyId: 'box', expectedBuildId: model.result.buildId, purpose: 'shell', picks: [{ kind: 'face', key: face.key }] });
      if (resolved.purpose !== 'shell') throw new Error('Unexpected edge selector');
      built(withFeatures(boxDocument(), { ...base('shell'), kind: 'shell', targetId: 'box', thickness: 1, opening: resolved.opening }), hollow => {
        expect(hollow.result.diagnostics).toEqual([]); expect(hollow.result.meshes[0].volume).toBeCloseTo(424, 6);
      });
    });
    for (const thickness of [6, 100]) built(withFeatures(boxDocument(), { ...base('shell'), kind: 'shell', targetId: 'box', thickness, opening }), model => {
      expect(model.result.diagnostics).not.toEqual([]); expect(model.result.meshes[0].volume).toBeCloseTo(1000, 6);
      expect(() => model.export('stl')).toThrow('Fix the feature diagnostics');
    });
  });
  it('rejects stale build keys and picks belonging to another body without approximating identity', () => {
    const first = buildCadKernelModel(boxDocument()); const second = buildCadKernelModel(boxDocument());
    try {
      expect(first.result.buildId).not.toBe(second.result.buildId);
      const pick: CadTopologyPick = { kind: 'edge', key: first.result.meshes[0].edgeGroups[0].key };
      expect(() => second.inspectTopology({ bodyId: 'box', expectedBuildId: first.result.buildId, selection: { kind: 'picks', picks: [pick] } })).toThrow('snapshot is stale');
      expect(() => second.inspectTopology({ bodyId: 'box', expectedBuildId: second.result.buildId, selection: { kind: 'picks', picks: [pick] } })).toThrow('does not belong');
      first.dispose(); expect(() => first.inspectTopology({ bodyId: 'box', expectedBuildId: first.result.buildId, selection: { kind: 'picks', picks: [pick] } })).toThrow('snapshot is stale');
    } finally { first.dispose(); second.dispose(); }
  });
  it('retains every exact element of a compound above the former body topology cap and cleans up its inventory', () => {
    const shapes = Array.from({ length: 2084 }, (_, index) => makeBox([index * 2, 0, 0], [index * 2 + 1, 1, 1]));
    const compound = makeCompound(shapes);
    try {
      const topology = new CadKernelTopology(compound.asShape3D());
      try {
        expect(topology.count).toBe(37512);
        const tail = topology.inspect({ bodyId: 'large', expectedBuildId: 'large-build', selection: { kind: 'page', topology: 'edge', offset: 25000, limit: 100 } }, 'large-build');
        expect(tail).toMatchObject({ total: 25008, nextOffset: null });
        expect(tail.descriptors).toHaveLength(8); expect(isCadTopologyInspectResult(tail)).toBe(true);
        expect(tail.descriptors.every(descriptor => descriptor.kind === 'edge' && descriptor.curveType === 'line' && Math.abs(descriptor.length - 1) < 1e-9)).toBe(true);
        const end = topology.inspect({ bodyId: 'large', expectedBuildId: 'large-build', selection: { kind: 'page', topology: 'edge', offset: 25008, limit: 100 } }, 'large-build');
        expect(end).toMatchObject({ descriptors: [], total: 25008, nextOffset: null });
        expect(() => topology.inspect({ bodyId: 'large', expectedBuildId: 'large-build', selection: { kind: 'page', topology: 'edge', offset: 25009, limit: 100 } }, 'large-build')).toThrow('beyond the available');
      } finally { topology.dispose(); }
    }
    finally { compound.delete(); shapes.forEach(shape => shape.delete()); }
    built(boxDocument(), model => expect(page(model, 'edge')).toHaveLength(12));
  });
  it('builds and exports all valid bodies beyond the former complete topology cap', () => {
    const features: CadFeature[] = [];
    for (let body = 0; body < 4; body++) {
      const points: [number, number][] = Array.from({ length: 1563 }, (_, index) => [body * 3 + Math.cos(index * 2 * Math.PI / 1563), Math.sin(index * 2 * Math.PI / 1563)]);
      features.push({ ...base(`sketch_${body}`), kind: 'sketch', plane: 'XY', offset: 0, profiles: [{ id: `profile_${body}`, name: 'Outline', role: 'outer', construction: false, geometry: { kind: 'polygon', points } }] },
        { ...base(`body_${body}`), kind: 'extrude', sketchId: `sketch_${body}`, distance: 1, symmetric: false, operation: 'new', targetId: null });
    }
    built(parseCadDocument({ ...boxDocument(), features }), model => {
      expect(model.result.diagnostics).toEqual([]);
      expect(model.result.meshes.map(mesh => mesh.featureId)).toEqual(['body_0', 'body_1', 'body_2', 'body_3']);
      expect(model.result.meshes.every(mesh => mesh.volume > 3.14 && mesh.volume < 3.142)).toBe(true);
      // The four bodies together exceed the former 25,000-element topology cap.
      expect(model.result.meshes.reduce((total, mesh) => total + mesh.faceGroups.length + mesh.edgeGroups.length, 0)).toBeGreaterThan(25_000);
      expect(model.export('step').size).toBeGreaterThan(0);
    });
  // Four 1,563-edge native solids exercise real geometry beyond the old policy.
  }, 60_000);
});

type Outline = readonly (readonly [number, number])[];
/** A polygon sketched on a principal plane and extruded `depth` along its normal into a new body named `id`. */
const extruded = (id: string, plane: CadPlane, offset: number, points: Outline, depth: number) => [
  { ...base(`${id}_profile`), kind: 'sketch', plane, offset, profiles: [{ id: 'outline', name: 'Outline', construction: false, geometry: { kind: 'polygon', points } }] },
  { ...base(id), kind: 'extrude', sketchId: `${id}_profile`, distance: depth, symmetric: false, operation: 'new', targetId: null }];
/** A prism 5 mm tall on a polygon in the XY plane. */
const prism = (points: Outline) => parseCadDocument({ ...boxDocument(), parameters: {}, features: extruded('box', 'XY', 0, points, 5) });
/** The body `box` that a union or intersection of two extruded polygons makes. */
const joined = (operation: 'union' | 'intersect', stock: readonly unknown[], tool: readonly unknown[]) => parseCadDocument({ ...boxDocument(), parameters: {},
  features: [...stock, ...tool, { ...base('box'), kind: 'boolean', operation, targetId: 'stock', toolId: 'tool' }] });
/**
 * The bodies the edge-treatment tests use: a box, a box with rounded corners, a rounded plate with a bore, a prism whose outline turns
 * 0.001 rad at one corner, a prism whose outline turns 0.0995 rad and then 0.2 rad, a prism whose outline turns 0.05 rad under a top
 * that rises 5 mm per mm from its front, so the top edges either side of the turn meet at 0.25 rad, and a block with a wedge fused to
 * it, whose straight front top edges meet where the flat top gives way to the wedge's 0.2 slope. The last two are treated with the
 * 0.1 mm the review measured them with.
 */
function chainFixtures(): readonly { readonly name: string; readonly document: CadDocument; readonly radius?: number }[] {
  const original = boxDocument(), sketch = original.features[0];
  if (sketch.kind !== 'sketch') throw new Error('Expected sketch');
  const rounded = parseCadDocument({ ...original, features: [{ ...sketch, profiles: sketch.profiles.map(profile => ({ ...profile,
    geometry: { kind: 'rectangle', x: 0, y: 0, width: 20, height: 10, cornerRadius: 2 } })) }, original.features[1]] });
  const plate = parseCadDocument({ ...original, parameters: {}, features: [
    { ...base('profile'), kind: 'sketch', plane: 'XY', offset: 0, profiles: [
      { id: 'plate', name: 'Plate', construction: false, geometry: { kind: 'rectangle', x: 0, y: 0, width: 80, height: 50, cornerRadius: 3 } },
      { id: 'bore', name: 'Bore', construction: false, geometry: { kind: 'circle', x: 40, y: 25, radius: 5 } }] },
    { ...base('box'), kind: 'extrude', sketchId: 'profile', distance: 10, symmetric: false, operation: 'new', targetId: null }] });
  const within = 10 * Math.tan(0.0995), beyond = within + 10 * Math.tan(0.0995 + 0.1005);
  return [{ name: 'box', document: parseCadDocument(original) }, { name: 'rounded box', document: rounded }, { name: 'plate with a bore', document: plate },
    { name: 'near-tangent polygon', document: prism([[0, 0], [10, 0], [20, 0.01], [20, 10], [0, 10]]) },
    { name: 'polygon turning 0.0995 then 0.2 rad', document: prism([[0, 0], [10, 0], [20, within], [30, beyond], [30, 20], [0, 20]]) },
    // In the YZ plane u is Y and v is Z.
    { name: 'near-tangent prism under a slope', document: joined('intersect', extruded('stock', 'XY', 0, [[0, 0], [10, 0], [20, 0.5], [20, 10], [0, 10]], 200),
      extruded('tool', 'YZ', 0, [[0, 0], [10, 0], [10, 55], [0, 5]], 25)), radius: 0.1 },
    { name: 'block and wedge', document: joined('union', extruded('stock', 'XY', 0, [[0, 0], [10, 0], [10, 10], [0, 10]], 5),
      extruded('tool', 'YZ', 10, [[0, 0], [10, 0], [10, 7], [0, 5]], 10)), radius: 0.1 }];
}
/** Runs `body` counting the native fillet builders made meanwhile. */
function countingBuilders(body: (made: ReturnType<typeof vi.fn>) => void) {
  const oc = getOC(), Builder = oc.BRepFilletAPI_MakeFillet, made = vi.fn();
  oc.BRepFilletAPI_MakeFillet = function (...args: ConstructorParameters<typeof Builder>) { made(); return new Builder(...args); } as unknown as typeof Builder;
  try { body(made); } finally { oc.BRepFilletAPI_MakeFillet = Builder; }
}
const adjacencyOf = (model: CadKernelModel): CadTopologyAdjacency => model.topologyAdjacency({ bodyId: 'box', expectedBuildId: model.result.buildId });
const chainOf = (model: CadKernelModel, edgeKey: string): CadTopologyTangentChain => model.topologyTangentChain({ bodyId: 'box', expectedBuildId: model.result.buildId, edgeKey });
/** The key of the edge running between two points, read from where its bounds lie. */
function edgeBetween(model: CadKernelModel) {
  const edges = page(model, 'edge');
  return (from: readonly number[], to: readonly number[]) => {
    const min = from.map((value, axis) => Math.min(value, to[axis])), max = from.map((value, axis) => Math.max(value, to[axis]));
    const found = edges.filter(({ bounds }) => min.every((value, axis) => Math.abs(bounds.min[axis] - value) < 1e-6 && Math.abs(bounds.max[axis] - max[axis]) < 1e-6));
    if (found.length !== 1) throw new Error(`Expected one edge from ${from} to ${to}, found ${found.length}`); return found[0].key;
  };
}

describe('topology adjacency and native tangent chains for selection chains', () => {
  it('reads how the edges and faces of each fixture meet', () => {
    const [box, rounded, plate] = chainFixtures();
    built(box.document, model => {
      const adjacency = adjacencyOf(model), edges = page(model, 'edge'), faces = page(model, 'face');
      expect(isCadTopologyAdjacency(adjacency)).toBe(true);
      expect(adjacency).toMatchObject({ bodyId: 'box', buildId: model.result.buildId });
      expect(new Set(adjacency.edges)).toEqual(new Set(edges.map(edge => edge.key)));
      expect(new Set(adjacency.faces)).toEqual(new Set(faces.map(face => face.key)));
      expect(adjacency.edgeSmooth.every(smooth => !smooth)).toBe(true);
      expect(adjacency.faceLoops.map(loops => loops.map(loop => loop.length))).toEqual(Array(6).fill([4]));
      for (const face of adjacency.faces) expect(cadTopologyTangentFaces(adjacency, face)).toEqual([face]);
      // The same build answers from its cache with the same data.
      expect(adjacencyOf(model)).toEqual(adjacency);
      expect(() => model.topologyAdjacency({ bodyId: 'box', expectedBuildId: 'another-build' })).toThrow('snapshot is stale');
    });
    built(rounded.document, model => {
      const adjacency = adjacencyOf(model), edges = page(model, 'edge');
      // The vertical edges where the corner cylinders meet the side planes are smooth, so the side wall is one tangent run of eight faces.
      const vertical = edges.filter(edge => edge.bounds.min[2] === 0 && edge.bounds.max[2] === 5).map(edge => adjacency.edges.indexOf(edge.key));
      expect(vertical).toHaveLength(8); expect(vertical.every(index => adjacency.edgeSmooth[index])).toBe(true);
      const side = page(model, 'face').find(face => face.kind === 'face' && face.surfaceType === 'plane' && Math.abs(face.normal[2]) < 1e-9);
      if (!side) throw new Error('Missing side face');
      expect(cadTopologyTangentFaces(adjacency, side.key)).toHaveLength(8);
    });
    built(plate.document, model => {
      const adjacency = adjacencyOf(model), edges = page(model, 'edge');
      const boreTop = edges.filter(edge => edge.kind === 'edge' && edge.curveType === 'circle' && Math.abs(edge.radius - 5) < 1e-7 && edge.bounds.min[2] === 10);
      expect(boreTop).toHaveLength(2);
      const topFace = page(model, 'face').find(face => face.kind === 'face' && face.surfaceType === 'plane' && face.normal[2] === 1);
      if (!topFace) throw new Error('Missing top face');
      expect(adjacency.faceLoops[adjacency.faces.indexOf(topFace.key)]).toHaveLength(2);
      expect(new Set(cadTopologyFaceLoop(adjacency, topFace.key, boreTop[0].key))).toEqual(new Set(boreTop.map(edge => edge.key)));
    });
  });
  it('reads each edge\'s tangent chain from a native fillet builder once per build, and the edge alone where the builder makes none', () => {
    const [box, rounded, plate, near, turning, sloped, wedge] = chainFixtures();
    built(box.document, model => {
      for (const edge of page(model, 'edge')) {
        const chain = chainOf(model, edge.key);
        expect(isCadTopologyTangentChain(chain)).toBe(true);
        expect(chain).toEqual({ bodyId: 'box', buildId: model.result.buildId, edgeKey: edge.key, edges: [edge.key], closed: false, native: true });
      }
      const edge = page(model, 'edge')[0].key;
      expect(() => model.topologyTangentChain({ bodyId: 'box', expectedBuildId: 'another-build', edgeKey: edge })).toThrow('snapshot is stale');
      expect(() => chainOf(model, 'edge:missing')).toThrow('The edge is not in this build');
      expect(() => chainOf(model, page(model, 'face')[0].key)).toThrow('The edge is not in this build');
    });
    built(rounded.document, model => {
      const edges = page(model, 'edge'), top = edges.filter(edge => edge.bounds.min[2] === 5 && edge.bounds.max[2] === 5).map(edge => edge.key);
      expect(top).toHaveLength(8);
      countingBuilders(made => {
        const chain = chainOf(model, top[0]);
        expect(chain).toMatchObject({ edgeKey: top[0], closed: true, native: true }); expect(new Set(chain.edges)).toEqual(new Set(top));
        // The build keeps each edge's chain: asked again, it answers without another builder. Another edge of the chain reads its own.
        expect(chainOf(model, top[0])).toEqual(chain); expect(made).toHaveBeenCalledOnce();
        expect(new Set(chainOf(model, top[1]).edges)).toEqual(new Set(top)); expect(made).toHaveBeenCalledTimes(2);
      });
      // A smooth edge between a corner cylinder and a side plane gives the builder no contour.
      const smooth = edges.find(edge => edge.bounds.min[2] === 0 && edge.bounds.max[2] === 5);
      if (!smooth) throw new Error('Missing vertical edge');
      expect(chainOf(model, smooth.key)).toMatchObject({ edges: [smooth.key], closed: false, native: false });
    });
    built(plate.document, model => {
      const boreTop = page(model, 'edge').filter(edge => edge.kind === 'edge' && edge.curveType === 'circle' && Math.abs(edge.radius - 5) < 1e-7 && edge.bounds.min[2] === 10);
      const chain = chainOf(model, boreTop[0].key);
      expect(chain).toMatchObject({ closed: true, native: true }); expect(new Set(chain.edges)).toEqual(new Set(boreTop.map(edge => edge.key)));
    });
    built(near.document, model => {
      const edge = edgeBetween(model);
      expect(new Set(chainOf(model, edge([0, 0, 5], [10, 0, 5])).edges)).toEqual(new Set([edge([0, 0, 5], [10, 0, 5]), edge([10, 0, 5], [20, 0.01, 5])]));
    });
    built(turning.document, model => {
      const edge = edgeBetween(model), within = 10 * Math.tan(0.0995), beyond = within + 10 * Math.tan(0.2);
      expect(new Set(chainOf(model, edge([0, 0, 5], [10, 0, 5])).edges)).toEqual(new Set([edge([0, 0, 5], [10, 0, 5]), edge([10, 0, 5], [20, within, 5])]));
      expect(chainOf(model, edge([20, within, 5], [30, beyond, 5]))).toMatchObject({ edges: [edge([20, within, 5], [30, beyond, 5])], native: true });
    });
    // The front faces turn 0.05 rad, so native follows the top edges round that corner although they meet at 0.25 rad.
    built(sloped.document, model => {
      const edge = edgeBetween(model), seed = edge([0, 0, 5], [10, 0, 5]);
      expect(new Set(chainOf(model, seed).edges)).toEqual(new Set([seed, edge([10, 0, 5], [20, 0.5, 7.5])]));
      // Strict treatment of the seed alone fails its tangent check, as native would add the edge round the turn.
      const selection = model.resolveTopologyPicks({ bodyId: 'box', expectedBuildId: model.result.buildId, purpose: 'fillet', picks: [{ kind: 'edge', key: seed }] });
      if (selection.purpose === 'shell') throw new Error('Unexpected shell selector');
      built(withFeatures(sloped.document, { ...base('strict'), kind: 'fillet', targetId: 'box', radius: 0.1, selection: selection.selection }), strict => {
        expect(strict.result.diagnostics[0]?.code).toBe('selection-tangent-chain');
      });
    });
    // The two front faces are one plane, but the flat top and the wedge's slope meet at 0.2 rad, so native stops at the join.
    built(wedge.document, model => {
      const edge = edgeBetween(model), seed = edge([0, 0, 5], [10, 0, 5]);
      expect(chainOf(model, seed)).toMatchObject({ edges: [seed], closed: false, native: true });
      expect(chainOf(model, edge([10, 0, 5], [20, 0, 5]))).toMatchObject({ edges: [edge([10, 0, 5], [20, 0, 5])], native: true });
    });
  });
  it('keeps one stored contour for equal chains read from every seed, and none for a chain longer than a selection holds', () => {
    // A straight run, a quarter round of 32 facets each turning π/64 rad and another straight run, with square corners either end, so the
    // top edges make one open chain of 34.
    const facets = Array.from({ length: 31 }, (_, index) => { const angle = -Math.PI / 2 + (index + 1) * Math.PI / 64; return [20 + 10 * Math.cos(angle), 10 + 10 * Math.sin(angle)] as const; });
    built(prism([[0, 0], [20, 0], ...facets, [30, 10], [30, 30], [0, 30]]), model => countingBuilders(made => {
      const first = chainOf(model, edgeBetween(model)([0, 0, 5], [20, 0, 5]));
      expect(first).toMatchObject({ closed: false, native: true }); expect(first.edges).toHaveLength(34); expect(Object.isFrozen(first.edges)).toBe(true);
      // Every edge of the run still reads its own builder, and as its chain is the same, it points to the one stored contour.
      for (const key of first.edges) expect(chainOf(model, key).edges).toBe(first.edges);
      expect(made).toHaveBeenCalledTimes(34);
    }));
    // The top rim of a 128-sided prism, each side turning π/64 rad, is one closed chain of 128 edges. No selection holds it, so it is not
    // kept: each read makes its own builder and list.
    built(prism(Array.from({ length: 128 }, (_, index) => [10 * Math.cos(index * Math.PI / 64), 10 * Math.sin(index * Math.PI / 64)] as const)), model => countingBuilders(made => {
      const seed = page(model, 'edge').find(edge => edge.bounds.min[2] === 5 && edge.bounds.max[2] === 5);
      if (!seed) throw new Error('Missing top edge');
      const chain = chainOf(model, seed.key);
      expect(chain).toMatchObject({ closed: true, native: true }); expect(chain.edges).toHaveLength(128);
      const again = chainOf(model, seed.key);
      expect(again.edges).toEqual(chain.edges); expect(again.edges).not.toBe(chain.edges); expect(made).toHaveBeenCalledTimes(2);
    }));
  });
  it.each(['fillet', 'chamfer'] as const)('chains every seed to exactly the edges native %s tangent propagation treats', kind => {
    const untreatable: Record<string, string[]> = {};
    for (const { name, document, radius = 0.5 } of chainFixtures()) {
      const original = buildCadKernelModel(document);
      try {
        const adjacency = adjacencyOf(original), done = new Set<string>();
        const bounds = new Map(page(original, 'edge').map(edge => [edge.key, edge.bounds]));
        // An edge by where it runs, rounded to the micrometre, so the cases native cannot treat read plainly.
        const where = (key: string) => { const box = bounds.get(key); return box ? [...box.min, ...box.max].map(value => +value.toFixed(3)).join(',') : key; };
        const seeds = adjacency.edges.filter((_, index) => !adjacency.edgeSmooth[index]);
        expect(seeds.length, name).toBeGreaterThan(0);
        for (const seed of seeds) {
          const chain = chainOf(original, seed);
          // Every member of a chain chains back to the same edges.
          for (const member of chain.edges) expect(new Set(chainOf(original, member).edges), name).toEqual(new Set(chain.edges));
          const key = [...chain.edges].sort().join(' ');
          if (done.has(key)) continue;
          done.add(key);
          const resolve = (keys: readonly string[]) => {
            const result = original.resolveTopologyPicks({ bodyId: 'box', expectedBuildId: original.result.buildId, purpose: kind, picks: keys.map(edge => ({ kind: 'edge' as const, key: edge })) });
            if (result.purpose === 'shell') throw new Error('Unexpected shell selector'); return result.selection;
          };
          let followed: number | string = 0, explicit: number | string = 0;
          built(withFeatures(document, { ...base('followed'), kind, targetId: 'box', radius, selection: resolve([seed]), tangentPropagation: true }), model => {
            followed = model.result.diagnostics[0]?.code ?? model.result.meshes[0].volume;
          });
          // Strict treatment of the chain passes its tangent check only when it holds every edge native propagation would add, and matches
          // its volume only when it holds no others.
          built(withFeatures(document, { ...base('chained'), kind, targetId: 'box', radius, selection: resolve(chain.edges) }), model => {
            explicit = model.result.diagnostics[0]?.code ?? model.result.meshes[0].volume;
          });
          if (typeof followed === 'string') {
            // Native cannot treat this edge at all. Strict treatment of the chain then fails the same way, past its tangent check.
            expect(explicit, `${name}: ${chain.edges.length} edges`).toBe(followed);
            (untreatable[name] ??= []).push(`${followed}${chain.native ? '' : ' without a contour'} ${chain.edges.map(where).join(' ')}`);
            continue;
          }
          // An edge the builder makes no contour from is one native cannot treat either.
          expect(chain.native, `${name}: ${where(seed)}`).toBe(true);
          expect(explicit, `${name}: ${chain.edges.length} edges`).toBeCloseTo(followed, 7);
          // A treatment of a concave edge adds material, so the check is only that the body changed.
          expect(Math.abs(followed - original.result.meshes[0].volume)).toBeGreaterThan(1e-9);
        }
        expect(done.size, name).toBeGreaterThan(0);
      } finally { original.dispose(); }
    }
    // The side edges where an outline turns 0.001 or 0.0995 rad are too flat a crease for the builder to make a contour from. Native
    // follows the sloped prism's top edges round its turn, and the block's front top edge onto the wedge's, but leaves no valid solid
    // there; strict treatment of the chain fails the same way, past its tangent check.
    const crease = 'kernel-operation-failed without a contour 10,0,0,10,0,5';
    expect(untreatable).toEqual({ 'near-tangent polygon': [crease], 'polygon turning 0.0995 then 0.2 rad': [crease],
      'near-tangent prism under a slope': [crease, 'invalid-solid 0,0,5,10,0,5 10,0,5,20,0.5,7.5', ...kind === 'fillet' ? ['invalid-solid 20,0.5,7.5,20,10,55'] : []],
      'block and wedge': ['invalid-solid 10,0,5,20,0,5'] });
  }, 120_000);
});

describe('native worker cache and snapshot lifetime', () => {
  it('does not initialize or rehydrate stale inspections and retains build IDs only on exact cache hits', async () => {
    let initializationCalls = 0;
    const runtime = createCadKernelRuntime(async () => { initializationCalls++; });
    const document = boxDocument();
    const inspection = { bodyId: 'box', expectedBuildId: 'missing', selection: { kind: 'page', topology: 'edge', offset: 0, limit: 2 } };
    try {
      expect(await runtime.evaluate({ id: 1, kind: 'inspect-topology', document, inspection })).toMatchObject({ kind: 'error', code: 'STALE_BUILD' });
      expect(initializationCalls).toBe(0);
      const first = await runtime.evaluate({ id: 2, kind: 'build', document }); if (first.kind !== 'built') throw new Error('Expected build');
      const again = await runtime.evaluate({ id: 3, kind: 'build', document }); if (again.kind !== 'built') throw new Error('Expected build');
      expect(again.result.buildId).toBe(first.result.buildId);
      const valid = { ...inspection, expectedBuildId: first.result.buildId };
      const inspected = await runtime.evaluate({ id: 4, kind: 'inspect-topology', document, inspection: valid }); expect(inspected.kind).toBe('topology-inspected'); expect(isCadKernelReply(inspected)).toBe(true);
      expect(await runtime.evaluate({ id: 5, kind: 'inspect-topology', document: { ...document, name: 'Changed' }, inspection: valid })).toMatchObject({ kind: 'error', code: 'STALE_BUILD' });
      expect(await runtime.evaluate({ id: 6, kind: 'export', document, format: 'step' })).toMatchObject({ kind: 'exported' });
      expect((await runtime.evaluate({ id: 7, kind: 'inspect-topology', document, inspection: valid })).kind).toBe('topology-inspected');
      const adjacency = await runtime.evaluate({ id: 70, kind: 'inspect-adjacency', document, adjacency: { bodyId: 'box', expectedBuildId: first.result.buildId } });
      expect(adjacency).toMatchObject({ kind: 'adjacency-inspected', result: { bodyId: 'box', buildId: first.result.buildId } }); expect(isCadKernelReply(adjacency)).toBe(true);
      expect(await runtime.evaluate({ id: 71, kind: 'inspect-adjacency', document, adjacency: { bodyId: 'box', expectedBuildId: 'missing' } })).toMatchObject({ kind: 'error', code: 'STALE_BUILD' });
      const edgeKey = adjacency.kind === 'adjacency-inspected' ? adjacency.result.edges[0] : 'missing';
      const chain = await runtime.evaluate({ id: 72, kind: 'inspect-tangent-chain', document, chain: { bodyId: 'box', expectedBuildId: first.result.buildId, edgeKey } });
      expect(chain).toMatchObject({ kind: 'tangent-chain-inspected', result: { bodyId: 'box', buildId: first.result.buildId, edgeKey, edges: [edgeKey], native: true } }); expect(isCadKernelReply(chain)).toBe(true);
      expect(await runtime.evaluate({ id: 73, kind: 'inspect-tangent-chain', document, chain: { bodyId: 'box', expectedBuildId: 'missing', edgeKey } })).toMatchObject({ kind: 'error', code: 'STALE_BUILD' });
      expect(await runtime.evaluate({ id: 74, kind: 'inspect-tangent-chain', document, chain: { bodyId: 'box', expectedBuildId: first.result.buildId, edgeKey: '' } })).toMatchObject({ kind: 'error', code: 'invalid-topology-request' });
      runtime.dispose();
      expect(await runtime.evaluate({ id: 8, kind: 'inspect-topology', document, inspection: valid })).toMatchObject({ kind: 'error', code: 'STALE_BUILD' });
      const rebuilt = await runtime.evaluate({ id: 9, kind: 'build', document }); if (rebuilt.kind !== 'built') throw new Error('Expected build');
      expect(rebuilt.result.buildId).not.toBe(first.result.buildId);
    } finally { runtime.dispose(); }
  });
});
