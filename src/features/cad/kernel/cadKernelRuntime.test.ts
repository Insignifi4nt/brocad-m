// @vitest-environment node
import { beforeAll, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import initOpenCascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { createCadDocument, parseCadDocument } from '../../../domain/cad/cadSchema';
import type { CadDocument } from '../../../domain/cad/cadDocument';
import { createCadKernelRuntime } from './cadKernelRuntime';
import { prepareCadSolidImport } from './cadKernelImport';
import { cadBytesToBase64 } from '../../../domain/cad/cadImports';

beforeAll(async () => {
  const wasmBinary = await readFile(new URL('../../../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  setOC(await initOpenCascade({ wasmBinary, print: () => undefined, printErr: () => undefined }));
}, 60_000);

const document: CadDocument = { ...createCadDocument('Block', 'runtime_block'), parameters: { width: 20 }, features: [
  { id: 'sketch', kind: 'sketch', name: 'Outline', suppressed: false, plane: 'XY', offset: 0, profiles: [
    { id: 'outline', name: 'Outline', construction: false, geometry: { kind: 'rectangle', x: 0, y: 0, width: 'width', height: 10, cornerRadius: 0 } }
  ] },
  { id: 'pad', kind: 'extrude', name: 'Pad', suppressed: false, sketchId: 'sketch', distance: 5, symmetric: false, operation: 'new', targetId: null }
] };

it('reuses native geometry for a contour rename while retaining accepted inspection ownership and solid labels', async () => {
  const runtime = createCadKernelRuntime(async () => undefined);
  const renamed: CadDocument = { ...document, features: document.features.map(feature => feature.kind === 'sketch' ? {
    ...feature, profiles: feature.profiles.map(profile => ({ ...profile, name: 'Machined contour' }))
  } : feature) };
  const originalBytes = JSON.stringify(document), renamedBytes = JSON.stringify(renamed);
  try {
    const first = await runtime.evaluate({ id: 1, kind: 'build', document });
    if (first.kind !== 'built') throw new Error('Expected original solid');
    const inspection = { bodyId: 'pad', expectedBuildId: first.result.buildId, selection: { kind: 'page', topology: 'edge', offset: 0, limit: 12 } };
    expect(await runtime.evaluate({ id: 2, kind: 'inspect-topology', document: renamed, inspection })).toMatchObject({ kind: 'error', code: 'STALE_BUILD' });
    const current = await runtime.evaluate({ id: 3, kind: 'build', document: renamed });
    if (current.kind !== 'built') throw new Error('Expected renamed contour');
    expect(current.result.buildId).toBe(first.result.buildId); expect(current.result.meshes).toBe(first.result.meshes);
    const mesh = current.result.meshes[0], originalMesh = first.result.meshes[0];
    expect(mesh.positions).toBe(originalMesh.positions); expect(mesh.edges).toBe(originalMesh.edges); expect(mesh.indices).toBe(originalMesh.indices);
    expect(mesh.volume).toBeCloseTo(1000, 7); expect(mesh.name).toBe('Pad'); expect(current.result.diagnostics).toEqual([]);
    expect(await runtime.evaluate({ id: 4, kind: 'inspect-topology', document, inspection })).toMatchObject({ kind: 'error', code: 'STALE_BUILD' });
    const topology = await runtime.evaluate({ id: 5, kind: 'inspect-topology', document: renamed, inspection });
    if (topology.kind !== 'topology-inspected') throw new Error('Expected current exact topology');
    expect(topology.result.total).toBe(12);
    const edge = topology.result.descriptors.find(descriptor => descriptor.kind === 'edge' && descriptor.curveType === 'line' && Math.abs(descriptor.length - 20) < 1e-8);
    if (!edge) throw new Error('Expected retained width edge');
    const selection = { bodyId: 'pad', expectedBuildId: first.result.buildId, purpose: 'chamfer', picks: [{ kind: 'edge', key: edge.key }] };
    expect(await runtime.evaluate({ id: 6, kind: 'resolve-topology-picks', document: renamed, selection })).toMatchObject({ kind: 'topology-resolved' });
    expect(await runtime.evaluate({ id: 7, kind: 'resolve-topology-picks', document, selection })).toMatchObject({ kind: 'error', code: 'STALE_BUILD' });
    expect(await runtime.evaluate({ id: 8, kind: 'section', document: renamed, section: { bodyId: 'pad', plane: 'XY', offset: 2 } }))
      .toMatchObject({ kind: 'sectioned', result: { contourCount: 1 } });
    const exported = await runtime.evaluate({ id: 9, kind: 'export', document: renamed, format: 'step' });
    if (exported.kind !== 'exported') throw new Error('Expected retained STEP solid');
    const step = await exported.blob.text(); expect(step).toContain("'Pad'"); expect(step).not.toContain('Machined contour');
    expect(prepareCadSolidImport({ format: 'step', fileName: 'renamed.step', encoding: 'utf8', data: step }).volume).toBeCloseTo(1000, 7);
    const invalid: CadDocument = { ...renamed, parameters: { width: -1 } };
    expect(await runtime.evaluate({ id: 10, kind: 'build', document: invalid }))
      .toMatchObject({ kind: 'error', code: 'invalid-profile', message: 'Rectangle "Machined contour" has invalid dimensions or corner radius.' });
    expect(await runtime.evaluate({ id: 11, kind: 'inspect-topology', document: renamed, inspection })).toMatchObject({ kind: 'topology-inspected' });
    const bodyRenamed: CadDocument = { ...renamed, features: renamed.features.map(feature => feature.id === 'pad' ? { ...feature, name: 'Finished block' } : feature) };
    const relabeled = await runtime.evaluate({ id: 12, kind: 'build', document: bodyRenamed });
    if (relabeled.kind !== 'built') throw new Error('Expected named body');
    expect(relabeled.result.buildId).not.toBe(first.result.buildId); expect(relabeled.result.meshes[0].name).toBe('Finished block');
    const namedExport = await runtime.evaluate({ id: 13, kind: 'export', document: bodyRenamed, format: 'step' });
    if (namedExport.kind !== 'exported') throw new Error('Expected newly labeled STEP');
    expect(await namedExport.blob.text()).toContain("'Finished block'");
    const changed = await runtime.evaluate({ id: 14, kind: 'build', document: { ...bodyRenamed, parameters: { width: 30 } } });
    if (changed.kind !== 'built') throw new Error('Expected changed geometry');
    expect(changed.result.buildId).not.toBe(relabeled.result.buildId); expect(changed.result.meshes[0].volume).toBeCloseTo(1500, 7);
    expect(await runtime.evaluate({ id: 15, kind: 'inspect-topology', document: renamed, inspection })).toMatchObject({ kind: 'error', code: 'STALE_BUILD' });
    expect(JSON.stringify(document)).toBe(originalBytes); expect(JSON.stringify(renamed)).toBe(renamedBytes);
  } finally { runtime.dispose(); }
});

it('adds and removes sketch dimension intent without rebuilding exact geometry while retaining full inspection ownership', async () => {
  const runtime = createCadKernelRuntime(async () => undefined);
  const constrained: CadDocument = { ...document, features: document.features.map(feature => feature.kind === 'sketch' ? {
    ...feature, profiles: feature.profiles.map(profile => ({ ...profile, constraints: [{ id: 'width_dimension', kind: 'dimension', quantity: 'width' }] }))
  } : feature) };
  const originalBytes = JSON.stringify(document), constrainedBytes = JSON.stringify(constrained);
  try {
    const first = await runtime.evaluate({ id: 1, kind: 'build', document });
    if (first.kind !== 'built') throw new Error('Expected original block');
    const inspection = { bodyId: 'pad', expectedBuildId: first.result.buildId, selection: { kind: 'page', topology: 'edge', offset: 0, limit: 12 } };
    expect(await runtime.evaluate({ id: 2, kind: 'inspect-topology', document: constrained, inspection })).toMatchObject({ kind: 'error', code: 'STALE_BUILD' });
    const current = await runtime.evaluate({ id: 3, kind: 'build', document: constrained });
    if (current.kind !== 'built') throw new Error('Expected dimensioned block');
    expect(current.result.buildId).toBe(first.result.buildId);
    expect(current.result.meshes).toBe(first.result.meshes);
    expect(await runtime.evaluate({ id: 4, kind: 'inspect-topology', document, inspection })).toMatchObject({ kind: 'error', code: 'STALE_BUILD' });
    expect(await runtime.evaluate({ id: 5, kind: 'inspect-topology', document: constrained, inspection })).toMatchObject({ kind: 'topology-inspected', result: { total: 12 } });
    const exported = await runtime.evaluate({ id: 6, kind: 'export', document: constrained, format: 'step' });
    if (exported.kind !== 'exported') throw new Error('Expected exact STEP after dimension intent');
    const imported = prepareCadSolidImport({ format: 'step', fileName: 'dimensioned.step', encoding: 'utf8', data: await exported.blob.text() });
    expect(imported.volume).toBeCloseTo(1000, 7); expect(imported.bounds.max).toEqual([20, 10, 5]);
    const removed = await runtime.evaluate({ id: 7, kind: 'build', document });
    if (removed.kind !== 'built') throw new Error('Expected released dimension');
    expect(removed.result.buildId).toBe(first.result.buildId); expect(removed.result.meshes).toBe(first.result.meshes);
    expect(await runtime.evaluate({ id: 8, kind: 'inspect-topology', document: constrained, inspection })).toMatchObject({ kind: 'error', code: 'STALE_BUILD' });
    expect(await runtime.evaluate({ id: 9, kind: 'inspect-topology', document, inspection })).toMatchObject({ kind: 'topology-inspected', result: { total: 12 } });
    const changed = await runtime.evaluate({ id: 10, kind: 'build', document: { ...constrained, parameters: { width: 30 } } });
    if (changed.kind !== 'built') throw new Error('Expected dimension value change');
    expect(changed.result.buildId).not.toBe(first.result.buildId); expect(changed.result.meshes[0].volume).toBeCloseTo(1500, 7);
    expect(await runtime.evaluate({ id: 11, kind: 'inspect-topology', document: constrained, inspection })).toMatchObject({ kind: 'error', code: 'STALE_BUILD' });
    expect(JSON.stringify(document)).toBe(originalBytes); expect(JSON.stringify(constrained)).toBe(constrainedBytes);
  } finally { runtime.dispose(); }
});

it('keeps the exact build when only where a sketch dimension is drawn changes', async () => {
  const runtime = createCadKernelRuntime(async () => undefined);
  const block = (width: number, annotation?: object) => parseCadDocument({ ...createCadDocument('Placed', 'runtime_placed'), schemaVersion: 2, features: [
    { id: 'sketch', name: 'Outline', kind: 'sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph: {
      points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [width, 0] }, { id: 'c', position: [width, 10] }, { id: 'd', position: [0, 10] }],
      entities: ['a', 'b', 'c', 'd'].map((id, index) => ({ id: `edge-${id}`, kind: 'line', construction: false, startPointId: id, endPointId: ['b', 'c', 'd', 'a'][index] })),
      relations: [{ id: 'width', kind: 'distance', pointIds: ['a', 'b'], value: width, ...annotation ? { annotation } : {} }] } },
    { id: 'pad', name: 'Pad', kind: 'extrude', suppressed: false, sketchId: 'sketch', distance: 5, symmetric: false, operation: 'new', targetId: null }
  ] });
  try {
    const first = await runtime.evaluate({ id: 1, kind: 'build', document: block(20) });
    if (first.kind !== 'built') throw new Error('Expected the block');
    for (const [id, annotation] of [[2, { kind: 'linear', offset: -6, along: 0.25 }], [3, { kind: 'linear', offset: 4, along: 1.5 }], [4, undefined]] as const) {
      const moved = await runtime.evaluate({ id, kind: 'build', document: block(20, annotation) });
      if (moved.kind !== 'built') throw new Error('Expected the moved dimension');
      expect(moved.result.buildId).toBe(first.result.buildId); expect(moved.result.meshes).toBe(first.result.meshes);
    }
    const resized = await runtime.evaluate({ id: 5, kind: 'build', document: block(30, { kind: 'linear', offset: -6, along: 0.25 }) });
    if (resized.kind !== 'built') throw new Error('Expected the resized block');
    expect(resized.result.buildId).not.toBe(first.result.buildId); expect(resized.result.meshes[0].volume).toBeCloseTo(1500, 7);
  } finally { runtime.dispose(); }
});

it('retains the exact native snapshot for document and parameter organization edits while pinning inspection to the accepted document', async () => {
  const runtime = createCadKernelRuntime(async () => undefined);
  try {
    const first = await runtime.evaluate({ id: 1, kind: 'build', document });
    if (first.kind !== 'built') throw Error('Expected initial solid');
    expect(first.result.meshes[0].volume).toBeCloseTo(1000, 7);
    const organized: CadDocument = { ...document, name: 'Organized block', parameterGroups: [{ id: 'dimensions', name: 'Dimensions' }],
      parameterMetadata: { width: { groupId: 'dimensions', source: { kind: 'manual' } } } };
    const inspection = { bodyId: 'pad', expectedBuildId: first.result.buildId, selection: { kind: 'page', topology: 'face', offset: 0, limit: 10 } };
    expect(await runtime.evaluate({ id: 2, kind: 'inspect-topology', document: organized, inspection })).toMatchObject({ kind: 'error', code: 'STALE_BUILD' });
    const updated = await runtime.evaluate({ id: 3, kind: 'build', document: organized });
    if (updated.kind !== 'built') throw Error('Expected organized solid');
    expect(updated.result.buildId).toBe(first.result.buildId);
    expect(updated.result.meshes).toBe(first.result.meshes);
    expect(await runtime.evaluate({ id: 4, kind: 'inspect-topology', document: organized, inspection })).toMatchObject({ kind: 'topology-inspected', result: { total: 6 } });
    expect(await runtime.evaluate({ id: 5, kind: 'inspect-topology', document, inspection })).toMatchObject({ kind: 'error', code: 'STALE_BUILD' });
    const section = await runtime.evaluate({ id: 6, kind: 'section', document: organized, section: { bodyId: 'pad', plane: 'XY', offset: 2 } });
    expect(section).toMatchObject({ kind: 'sectioned', result: { contourCount: 1 } });
    const changed = await runtime.evaluate({ id: 7, kind: 'build', document: { ...organized, parameters: { width: 30 } } });
    if (changed.kind !== 'built') throw Error('Expected resized solid');
    expect(changed.result.buildId).not.toBe(first.result.buildId);
    expect(changed.result.meshes[0].volume).toBeCloseTo(1500, 7);
    expect(changed.result.meshes[0].bounds.max[0]).toBeCloseTo(30, 6);
    expect(await runtime.evaluate({ id: 8, kind: 'inspect-topology', document: organized, inspection })).toMatchObject({ kind: 'error', code: 'STALE_BUILD' });
  } finally { runtime.dispose(); }
});

it.each(['step', 'stl'] as const)('exports verified %s material from a reused snapshot and uses current named section parameters', async format => {
  const runtime = createCadKernelRuntime(async () => undefined);
  const original: CadDocument = { ...document, parameters: { width: 20, cutHeight: 2 } };
  try {
    const first = await runtime.evaluate({ id: 1, kind: 'build', document: original });
    if (first.kind !== 'built') throw new Error('Expected material');
    const organized: CadDocument = { ...original, name: 'Reviewed block', parameterGroups: [{ id: 'source', name: 'Source dimensions' }],
      parameterMetadata: { width: { groupId: 'source', source: { kind: 'manual' } } } };
    const before = JSON.stringify(organized);
    const exported = await runtime.evaluate({ id: 2, kind: 'export', document: organized, format });
    if (exported.kind !== 'exported') throw new Error('Expected standalone export');
    const immediately = await runtime.evaluate({ id: 20, kind: 'section', document: organized, section: { bodyId: 'pad', plane: 'XY', offset: 'cutHeight' } });
    if (immediately.kind === 'error') throw new Error(`Section immediately after ${format} export: ${immediately.message}`);
    expect(immediately).toMatchObject({ kind: 'sectioned', result: { offset: 2, contourCount: 1 } });
    const source = format === 'step' ? { format: 'step' as const, fileName: 'reviewed.step', encoding: 'utf8' as const, data: await exported.blob.text() }
      : { format: 'stl' as const, fileName: 'reviewed.stl', encoding: 'base64' as const, units: 'mm' as const,
        data: cadBytesToBase64(new Uint8Array(await exported.blob.arrayBuffer())) };
    const imported = prepareCadSolidImport(source);
    expect(imported.solidCount).toBe(1);
    expect(imported.volume).toBeCloseTo(20 * 10 * 5, 6);
    imported.bounds.min.forEach(value => expect(value).toBeCloseTo(0, 6));
    imported.bounds.max.forEach((value, index) => expect(value).toBeCloseTo([20, 10, 5][index], 6));
    const current = await runtime.evaluate({ id: 3, kind: 'build', document: organized });
    if (current.kind !== 'built') throw new Error('Expected cached material');
    expect(current.result.buildId).toBe(first.result.buildId);
    expect(current.result.meshes).toBe(first.result.meshes);
    const inspection = { bodyId: 'pad', expectedBuildId: first.result.buildId, selection: { kind: 'page', topology: 'edge', offset: 0, limit: 12 } };
    const topology = await runtime.evaluate({ id: 21, kind: 'inspect-topology', document: organized, inspection });
    if (topology.kind !== 'topology-inspected') throw new Error('Expected export to retain exact topology');
    expect(topology.result.total).toBe(12);
    const edge = topology.result.descriptors.find(descriptor => descriptor.kind === 'edge' && descriptor.curveType === 'line' && Math.abs(descriptor.length - 20) < 1e-8);
    if (!edge) throw new Error('Expected width edge after export');
    expect(await runtime.evaluate({ id: 22, kind: 'resolve-topology-picks', document: organized,
      selection: { bodyId: 'pad', expectedBuildId: first.result.buildId, purpose: 'chamfer', picks: [{ kind: 'edge', key: edge.key }] } }))
      .toMatchObject({ kind: 'topology-resolved' });
    const repeated = await runtime.evaluate({ id: 23, kind: 'export', document: organized, format });
    if (repeated.kind !== 'exported') throw new Error('Expected repeat export from the same native snapshot');
    expect(repeated.blob.size).toBeGreaterThan(0);
    const stepAfter = await runtime.evaluate({ id: 24, kind: 'export', document: organized, format: 'step' });
    if (stepAfter.kind !== 'exported') throw new Error('Expected STEP export after repeated exports');
    const retained = prepareCadSolidImport({ format: 'step', fileName: 'retained.step', encoding: 'utf8', data: await stepAfter.blob.text() });
    expect(retained.volume).toBeCloseTo(1000, 6);
    expect(retained.solidCount).toBe(1);
    const section = await runtime.evaluate({ id: 4, kind: 'section', document: organized, section: { bodyId: 'pad', plane: 'XY', offset: 'cutHeight' } });
    if (section.kind === 'error') throw new Error(`Section after ${format} export: ${section.message}`);
    expect(section).toMatchObject({ kind: 'sectioned', result: { offset: 2, contourCount: 1 } });
    const changed: CadDocument = { ...organized, parameters: { ...organized.parameters, cutHeight: 9 } };
    expect(await runtime.evaluate({ id: 5, kind: 'section', document: changed, section: { bodyId: 'pad', plane: 'XY', offset: 'cutHeight' } }))
      .toMatchObject({ kind: 'error' });
    const rebuilt = await runtime.evaluate({ id: 6, kind: 'build', document: changed });
    if (rebuilt.kind !== 'built') throw new Error('Expected rebuilt block');
    expect(rebuilt.result).toBe(first.result);
    expect(rebuilt.result.meshes[0].volume).toBeCloseTo(1000, 7);
    expect(JSON.stringify(organized)).toBe(before);
  } finally { runtime.dispose(); }
});

it('keeps current pick ownership after invalid metadata/format requests and invalidates it on disposal', async () => {
  const initialize = vi.fn(async () => undefined), runtime = createCadKernelRuntime(initialize);
  try {
    const first = await runtime.evaluate({ id: 1, kind: 'build', document });
    if (first.kind !== 'built') throw new Error('Expected exact block');
    const inspection = { bodyId: 'pad', expectedBuildId: first.result.buildId, selection: { kind: 'page', topology: 'edge', offset: 0, limit: 12 } };
    expect(await runtime.evaluate({ id: 2, kind: 'export', document: { ...document, name: 'Ignored request' }, format: 'iges' }))
      .toMatchObject({ kind: 'error', code: 'unsupported-format' });
    expect(await runtime.evaluate({ id: 3, kind: 'build', document: { ...document, parameterMetadata: { absent: { source: { kind: 'manual' } } } } }))
      .toMatchObject({ kind: 'error', code: 'invalid-parameter-metadata' });
    const topology = await runtime.evaluate({ id: 4, kind: 'inspect-topology', document, inspection });
    if (topology.kind !== 'topology-inspected') throw new Error('Expected retained exact topology');
    expect(topology.result.total).toBe(12);
    const edge = topology.result.descriptors.find(descriptor => descriptor.kind === 'edge' && descriptor.curveType === 'line' && Math.abs(descriptor.length - 20) < 1e-8);
    if (!edge) throw new Error('Expected width edge');
    const selection = { bodyId: 'pad', expectedBuildId: first.result.buildId, purpose: 'chamfer', picks: [{ kind: 'edge', key: edge.key }] };
    expect(await runtime.evaluate({ id: 5, kind: 'resolve-topology-picks', document, selection })).toMatchObject({ kind: 'topology-resolved' });
    runtime.dispose(); runtime.dispose();
    const calls = initialize.mock.calls.length;
    expect(await runtime.evaluate({ id: 6, kind: 'inspect-topology', document, inspection })).toMatchObject({ kind: 'error', code: 'STALE_BUILD' });
    expect(await runtime.evaluate({ id: 7, kind: 'resolve-topology-picks', document, selection })).toMatchObject({ kind: 'error', code: 'STALE_BUILD' });
    expect(initialize.mock.calls.length).toBe(calls);
    const rebuilt = await runtime.evaluate({ id: 8, kind: 'build', document });
    if (rebuilt.kind !== 'built') throw new Error('Expected fresh material');
    expect(rebuilt.result.buildId).not.toBe(first.result.buildId);
    expect(rebuilt.result.meshes[0].volume).toBeCloseTo(1000, 7);
    expect(await runtime.evaluate({ id: 9, kind: 'resolve-topology-picks', document, selection })).toMatchObject({ kind: 'error', code: 'STALE_BUILD' });
  } finally { runtime.dispose(); }
});

it.each([
  { label: 'malformed metadata-only query', parameters: { width: 20 }, section: { bodyId: 'pad', plane: 'XY', offset: 2, extra: true }, code: 'invalid-section' },
  { label: 'outside-body metadata-only query', parameters: { width: 20 }, section: { bodyId: 'pad', plane: 'XY', offset: 9 }, code: 'empty-section' },
  { label: 'malformed geometry-changing query', parameters: { width: 30 }, section: { bodyId: 'pad', plane: 'XY', offset: 2, extra: true }, code: 'invalid-section' },
  { label: 'outside-body geometry-changing query', parameters: { width: 30 }, section: { bodyId: 'pad', plane: 'XY', offset: 9 }, code: 'empty-section' }
])('retains accepted topology after a rejected $label', async ({ parameters, section, code }) => {
  const initialize = vi.fn(async () => undefined), runtime = createCadKernelRuntime(initialize);
  const queried: CadDocument = { ...document, name: 'Queried block', parameters };
  const originalBytes = JSON.stringify(document), queriedBytes = JSON.stringify(queried);
  try {
    const first = await runtime.evaluate({ id: 1, kind: 'build', document });
    if (first.kind !== 'built') throw new Error('Expected accepted block');
    const inspection = { bodyId: 'pad', expectedBuildId: first.result.buildId, selection: { kind: 'page', topology: 'edge', offset: 0, limit: 12 } };
    const before = await runtime.evaluate({ id: 2, kind: 'inspect-topology', document, inspection });
    if (before.kind !== 'topology-inspected') throw new Error('Expected accepted topology');
    const edge = before.result.descriptors.find(descriptor => descriptor.kind === 'edge' && descriptor.curveType === 'line' && Math.abs(descriptor.length - 20) < 1e-8);
    if (!edge) throw new Error('Expected accepted width edge');
    const selection = { bodyId: 'pad', expectedBuildId: first.result.buildId, purpose: 'chamfer', picks: [{ kind: 'edge', key: edge.key }] };
    const initializationCount = initialize.mock.calls.length;
    expect(await runtime.evaluate({ id: 3, kind: 'section', document: queried, section })).toMatchObject({ kind: 'error', code });
    expect(await runtime.evaluate({ id: 4, kind: 'inspect-topology', document, inspection })).toEqual({ ...before, id: 4 });
    expect(await runtime.evaluate({ id: 5, kind: 'resolve-topology-picks', document, selection })).toMatchObject({ kind: 'topology-resolved' });
    expect(await runtime.evaluate({ id: 6, kind: 'inspect-topology', document: queried, inspection })).toMatchObject({ kind: 'error', code: 'STALE_BUILD' });
    if (code === 'invalid-section') expect(initialize.mock.calls.length).toBe(initializationCount);
    const exported = await runtime.evaluate({ id: 7, kind: 'export', document, format: 'step' });
    if (exported.kind !== 'exported') throw new Error('Expected retained accepted material');
    expect(prepareCadSolidImport({ format: 'step', fileName: 'accepted.step', encoding: 'utf8', data: await exported.blob.text() }).volume).toBeCloseTo(1000, 7);
    const accepted = await runtime.evaluate({ id: 8, kind: 'build', document });
    if (accepted.kind !== 'built') throw new Error('Expected retained accepted snapshot');
    expect(accepted.result).toBe(first.result);
    expect(await runtime.evaluate({ id: 9, kind: 'section', document: queried, section: { bodyId: 'pad', plane: 'XY', offset: 2 } }))
      .toMatchObject({ kind: 'sectioned', result: { contourCount: 1 } });
    expect(await runtime.evaluate({ id: 10, kind: 'inspect-topology', document, inspection })).toMatchObject({ kind: 'error', code: 'STALE_BUILD' });
    expect(JSON.stringify(document)).toBe(originalBytes); expect(JSON.stringify(queried)).toBe(queriedBytes);
  } finally { runtime.dispose(); }
});

it('disposes an independently resized candidate while retaining accepted material and exact pick ownership', async () => {
  const accepted = createCadKernelRuntime(async () => undefined), candidate = createCadKernelRuntime(async () => undefined);
  try {
    const first = await accepted.evaluate({ id: 1, kind: 'build', document });
    if (first.kind !== 'built') throw new Error('Expected accepted solid');
    const inspection = { bodyId: 'pad', expectedBuildId: first.result.buildId, selection: { kind: 'page', topology: 'edge', offset: 0, limit: 12 } };
    const before = await accepted.evaluate({ id: 2, kind: 'inspect-topology', document, inspection });
    if (before.kind !== 'topology-inspected') throw new Error('Expected accepted picks');
    const resized: CadDocument = { ...document, parameters: { width: 30 } };
    const preview = await candidate.evaluate({ id: 3, kind: 'build', document: resized });
    if (preview.kind !== 'built') throw new Error('Expected candidate solid');
    expect(preview.result.diagnostics).toEqual([]);
    expect(preview.result.buildId).not.toBe(first.result.buildId);
    expect(preview.result.meshes[0].volume).toBeCloseTo(1500, 7);
    expect(preview.result.meshes[0].bounds.max[0]).toBeCloseTo(30, 6);
    candidate.dispose();
    const after = await accepted.evaluate({ id: 4, kind: 'inspect-topology', document, inspection });
    expect(after).toEqual({ ...before, id: 4 });
    expect(await accepted.evaluate({ id: 5, kind: 'section', document, section: { bodyId: 'pad', plane: 'XY', offset: 2 } }))
      .toMatchObject({ kind: 'sectioned', result: { contourCount: 1 } });
    const exported = await accepted.evaluate({ id: 6, kind: 'export', document, format: 'step' });
    if (exported.kind !== 'exported') throw new Error('Expected accepted STEP');
    expect(prepareCadSolidImport({ format: 'step', fileName: 'accepted.step', encoding: 'utf8', data: await exported.blob.text() }).volume).toBeCloseTo(1000, 7);
    const retained = await accepted.evaluate({ id: 7, kind: 'build', document });
    if (retained.kind !== 'built') throw new Error('Expected retained build');
    expect(retained.result).toBe(first.result);
  } finally { accepted.dispose(); candidate.dispose(); }
});

it('retains accepted material when exporting a diagnosed candidate, while an explicit Build adopts its diagnosed prefix', async () => {
  const runtime = createCadKernelRuntime(async () => undefined);
  const failed: CadDocument = { ...document, features: [...document.features,
    { id: 'cutter', kind: 'sketch', name: 'Outside cutter', suppressed: false, plane: 'XY', offset: 0, profiles: [
      { id: 'outside', name: 'Outside circle', construction: false, geometry: { kind: 'circle', x: 50, y: 0, radius: 2 } }
    ] },
    { id: 'cut', kind: 'extrude', name: 'Non-intersecting cut', suppressed: false, sketchId: 'cutter', distance: 5, symmetric: false, operation: 'cut', targetId: 'pad' }
  ] };
  try {
    const first = await runtime.evaluate({ id: 1, kind: 'build', document });
    if (first.kind !== 'built') throw new Error('Expected accepted block');
    const inspection = { bodyId: 'pad', expectedBuildId: first.result.buildId, selection: { kind: 'page', topology: 'edge', offset: 0, limit: 12 } };
    const before = await runtime.evaluate({ id: 2, kind: 'inspect-topology', document, inspection });
    expect(before.kind).toBe('topology-inspected');
    expect(await runtime.evaluate({ id: 3, kind: 'export', document: failed, format: 'step' })).toMatchObject({ kind: 'error', code: 'invalid-export' });
    expect(await runtime.evaluate({ id: 4, kind: 'inspect-topology', document, inspection })).toEqual({ ...before, id: 4 });
    const retained = await runtime.evaluate({ id: 5, kind: 'build', document });
    if (retained.kind !== 'built') throw new Error('Expected retained accepted snapshot');
    expect(retained.result).toBe(first.result);
    const exported = await runtime.evaluate({ id: 6, kind: 'export', document, format: 'stl' });
    if (exported.kind !== 'exported') throw new Error('Expected retained STL material');
    const imported = prepareCadSolidImport({ format: 'stl', fileName: 'accepted.stl', encoding: 'base64', units: 'mm',
      data: cadBytesToBase64(new Uint8Array(await exported.blob.arrayBuffer())) });
    expect(imported.volume).toBeCloseTo(1000, 6);
    const diagnosed = await runtime.evaluate({ id: 7, kind: 'build', document: failed });
    if (diagnosed.kind !== 'built') throw new Error('Expected diagnosed Build');
    expect(diagnosed.result.buildId).not.toBe(first.result.buildId);
    expect(diagnosed.result.diagnostics).toContainEqual(expect.objectContaining({ featureId: 'cut', code: 'rebuild-stopped' }));
    expect(diagnosed.result.meshes[0].volume).toBeCloseTo(1000, 7);
    expect(await runtime.evaluate({ id: 8, kind: 'inspect-topology', document, inspection })).toMatchObject({ kind: 'error', code: 'STALE_BUILD' });
    expect(await runtime.evaluate({ id: 9, kind: 'inspect-topology', document: failed, inspection: { ...inspection, expectedBuildId: diagnosed.result.buildId } }))
      .toMatchObject({ kind: 'topology-inspected', result: { total: 12 } });
  } finally { runtime.dispose(); }
});

it('names a kernel that fails to load as the cause of a request, keeping the loader\'s words apart', async () => {
  const runtime = createCadKernelRuntime(async () => { throw new Error('WebAssembly.instantiate(): out of memory'); });
  const unavailable = { kind: 'error', code: 'kernel-unavailable', message: 'The CAD kernel could not be loaded. Reload the page; if this repeats, use a browser that runs WebAssembly.',
    kernelMessage: 'WebAssembly.instantiate(): out of memory' };
  try {
    expect(await runtime.evaluate({ id: 1, kind: 'build', document })).toEqual({ id: 1, ...unavailable });
    expect(await runtime.evaluate({ id: 2, kind: 'import-solid', source: { format: 'step', fileName: 'part.step', encoding: 'utf8', data: 'ISO-10303-21;' } })).toEqual({ id: 2, ...unavailable });
  } finally { runtime.dispose(); }
});
