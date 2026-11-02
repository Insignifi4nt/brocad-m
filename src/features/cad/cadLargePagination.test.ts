import { describe, expect, it, vi } from 'vitest';
import { cadBudgetFixture } from '@/domain/cad/__tests__/cadBudgetFixture';
import { CadSession } from './cadSession';
import { cadSiteTools } from './cadSiteTools';
import type { CadController } from './useCadController';
import type { CadBuildResult, CadMesh } from '@/domain/cad/cadDocument';
import { NO_CAD_BUILD_ISSUES } from '@/domain/cad/cadBuildIssues';

describe('complete CAD pagination without whole-document offset policies', () => {
  it('reads versioned exact text beyond the former 16 MiB offset and reaches the actual document end', async () => {
    const session = new CadSession(cadBudgetFixture(16 * 1024 * 1024 + 64 * 1024));
    const before = session.getSnapshot(), text = JSON.stringify(before.document);
    const tool = cadSiteTools(() => ({ session }) as unknown as CadController).find(tool => tool.name === 'cad_read_document');
    if (!tool) throw new Error('Missing document reader.');
    const offset = 16 * 1024 * 1024 + 1;
    expect(text.length).toBeGreaterThan(offset + 4096);
    expect(await tool.execute({ expectedVersion: before.version, offset, length: 4096 })).toMatchObject({ ok: true, data: {
      version: before.version, documentId: before.document.id, offset, totalLength: text.length,
      text: text.slice(offset, offset + 4096), nextOffset: offset + 4096,
    } });
    expect(await tool.execute({ expectedVersion: before.version, offset: text.length - 13, length: 4096 })).toMatchObject({ ok: true, data: {
      text: text.slice(-13), totalLength: text.length, nextOffset: null,
    } });
    expect(await tool.execute({ expectedVersion: before.version, offset: text.length + 1 })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(session.getSnapshot()).toBe(before);
    session.edit([{ kind: 'rename-document', name: 'New version' }]);
    expect(await tool.execute({ expectedVersion: before.version, offset })).toMatchObject({ ok: false, error: { code: 'STALE_STATE' } });
  });
  it('lets bounded body pages reach records beyond the shared workbench offset policy and preserves counts', async () => {
    const mesh: CadMesh = { featureId: 'body', name: 'Body', positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2], edges: [],
      faceGroups: [{ start: 0, count: 3, key: 'face' }], edgeGroups: [], volume: 1, solidCount: 1, bounds: { min: [0, 0, 0], max: [1, 1, 1] } };
    const meshes = Array.from({ length: 100_003 }, (_, index) => ({ ...mesh, featureId: `body_${index}`, name: `Body ${index}` }));
    const result: CadBuildResult = { buildId: 'complete-model', meshes, diagnostics: [], durationMs: 1 };
    const inspectBuild = vi.fn(async () => result);
    const tool = cadSiteTools(() => ({ inspectBuild, buildIssuesOf: () => NO_CAD_BUILD_ISSUES }) as unknown as CadController).find(tool => tool.name === 'cad_build');
    if (!tool) throw new Error('Missing build inspector.');
    expect(await tool.execute({ expectedVersion: 'current', offset: 100_001, limit: 1 })).toMatchObject({ ok: true, data: {
      totalBodies: 100_003, nextBodyOffset: 100_002, bodies: [{ featureId: 'body_100001', solidCount: 1, triangles: 1 }],
    } });
    expect(await tool.execute({ expectedVersion: 'current', offset: 100_002, limit: 1 })).toMatchObject({ ok: true, data: {
      totalBodies: 100_003, nextBodyOffset: null, bodies: [{ featureId: 'body_100002', solidCount: 1, triangles: 1 }],
    } });
    expect(result.meshes).toBe(meshes); expect(inspectBuild).toHaveBeenCalledTimes(2);
  });
  it('rejects unsafe offsets and oversized reply-page requests before accessing live CAD', async () => {
    const controller = vi.fn<() => CadController>(() => { throw new Error('Invalid arguments reached live CAD.'); });
    const tools = cadSiteTools(controller);
    for (const name of ['cad_read_document', 'cad_build', 'cad_inspect_topology']) {
      const tool = tools.find(tool => tool.name === name); if (!tool) throw new Error('Missing CAD reader.');
      const base = name === 'cad_inspect_topology' ? { expectedVersion: 'current', expectedBuildId: 'build', bodyId: 'body', kind: 'edge' } : { expectedVersion: 'current' };
      for (const offset of [-1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        expect(await tool.execute({ ...base, offset })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
      }
      expect(await tool.execute({ ...base, ...(name === 'cad_read_document' ? { length: 4097 } : { limit: 51 }) })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    }
    expect(controller).not.toHaveBeenCalled();
  });
});
