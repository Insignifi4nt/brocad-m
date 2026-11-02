// @vitest-environment node
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import initOpenCascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { buildCadKernelModel } from './cadKernelModel';
import type { CadDocument, CadFeature, CadMesh, CadProfile, CadSketchFeature } from '../../../domain/cad/cadDocument';

/** Moves the native shell result sideways, standing in for a kernel shell that drifts outside its target. */
const shellDrift = vi.hoisted(() => ({ xMm: 0 }));
vi.mock('./cadKernelOperations', async importOriginal => {
  const actual = await importOriginal<typeof import('./cadKernelOperations')>();
  return { ...actual, applyCadShell: (...args: Parameters<typeof actual.applyCadShell>) => {
    const shell = actual.applyCadShell(...args);
    return shellDrift.xMm === 0 ? shell : shell.translate(shellDrift.xMm, 0, 0);
  } };
});

beforeAll(async () => {
  const wasmBinary = await readFile(new URL('../../../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  setOC(await initOpenCascade({ wasmBinary, print: () => undefined, printErr: () => undefined }));
}, 60_000);
beforeEach(() => { shellDrift.xMm = 0; });

const base = (id: string) => ({ id, name: id, suppressed: false });
const sketch = (id: string, geometry: CadProfile): CadSketchFeature => ({ ...base(id), kind: 'sketch', plane: 'XY', offset: 0,
  profiles: [{ id: `${id}_profile`, name: id, construction: false, role: 'outer', geometry }] });
const extrude = (id: string, sketchId: string, distance: number): CadFeature => ({ ...base(id), kind: 'extrude', sketchId, distance, symmetric: false, operation: 'new', targetId: null });
const square = (side: number): CadProfile => ({ kind: 'rectangle', x: 0, y: 0, width: side, height: side, cornerRadius: 0 });
const doc = (features: readonly CadFeature[]): CadDocument => ({ format: 'wireedm-cad', schemaVersion: 1, id: 'test', name: 'Test', units: 'mm', parameters: {}, features });

function built(features: readonly CadFeature[]): { diagnostics: readonly string[]; message: string | undefined; mesh: CadMesh | undefined } {
  const model = buildCadKernelModel(doc(features));
  try {
    const { diagnostics, meshes } = model.result;
    return { diagnostics: diagnostics.map(({ code }) => code), message: diagnostics[0]?.message, mesh: meshes[0] };
  } finally { model.dispose(); }
}

/** Largest gap between neighbouring mesh vertices around a circular rim, as the sagitta of that chord. */
function rimChordDeviation(mesh: CadMesh, radius: number): number {
  const angles: number[] = [];
  for (let index = 0; index < mesh.positions.length; index += 3) {
    const x = mesh.positions[index], y = mesh.positions[index + 1];
    if (Math.abs(Math.hypot(x, y) - radius) < 1e-3) angles.push(Math.atan2(y, x));
  }
  angles.sort((a, b) => a - b);
  let gap = angles[0] + 2 * Math.PI - angles[angles.length - 1];
  for (let index = 1; index < angles.length; index++) gap = Math.max(gap, angles[index] - angles[index - 1]);
  return radius * (1 - Math.cos(gap / 2));
}

describe('kernel minimum volume for solid material', () => {
  it('rejects a 0.001 mm square extruded 0.0004 mm as an empty solid', () => {
    expect(built([sketch('profile', square(0.001)), extrude('body', 'profile', 0.0004)]).diagnostics).toEqual(['empty-solid', 'rebuild-stopped']);
  });

  it('keeps a 0.001 mm square extruded 0.003 mm as solid material', () => {
    const { diagnostics, mesh } = built([sketch('profile', square(0.001)), extrude('body', 'profile', 0.003)]);
    expect(diagnostics).toEqual([]);
    expect(mesh?.volume).toBeCloseTo(3e-9, 15);
  });
});

describe('kernel bounds slack for inward shells', () => {
  const shelled = (): readonly CadFeature[] => [sketch('profile', square(10)), extrude('box', 'profile', 10),
    { ...base('shell'), kind: 'shell', targetId: 'box', thickness: 1, opening: { kind: 'faces', expectedCount: 1,
      predicates: [{ kind: 'plane', normal: [0, 0, 1], offset: 10 }] } }];

  it('accepts a shell whose bounds reach 0.0000004 mm beyond its target', () => {
    shellDrift.xMm = 4e-7;
    const { diagnostics, mesh } = built(shelled());
    expect(diagnostics).toEqual([]);
    expect(mesh?.volume).toBeCloseTo(424, 6);
  });

  it('rejects a shell whose bounds reach 0.000003 mm beyond its target', () => {
    shellDrift.xMm = 3e-6;
    const { diagnostics, message } = built(shelled());
    expect(diagnostics).toEqual(['shell-failed', 'rebuild-stopped']);
    expect(message).toContain('grew outside the body');
  });
});

describe('display tessellation chord deviation', () => {
  it('meshes a 100 mm radius cylinder within 0.05 mm of its surface but no finer than 0.01 mm', () => {
    const { diagnostics, mesh } = built([sketch('profile', { kind: 'circle', x: 0, y: 0, radius: 100 }), extrude('cylinder', 'profile', 1)]);
    expect(diagnostics).toEqual([]);
    if (!mesh) throw new Error('Expected a cylinder mesh');
    const deviation = rimChordDeviation(mesh, 100);
    expect(deviation).toBeLessThanOrEqual(0.05);
    expect(deviation).toBeGreaterThan(0.01);
  });
});
