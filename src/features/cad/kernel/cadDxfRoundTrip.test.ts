// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import initOpenCascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { buildCadKernelModel } from './cadKernelModel';
import { createCadDocument, createCadSketchProfile, parseCadDocument } from '../../../domain/cad/cadSchema';
import { importCadDxfSketch } from '../../../domain/cad/cadDxfImport';
import { cadEntitiesToCam, cadSketchToDxf } from '../../../domain/cad/cadCam';
import type { CadProfile } from '../../../domain/cad/cadDocument';

beforeAll(async () => {
  const wasmBinary = await readFile(new URL('../../../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  setOC(await initOpenCascade({ wasmBinary, print: () => undefined, printErr: () => undefined }));
}, 60_000);

describe('DXF editable sketches through the native BRep kernel', () => {
  it.each([
    { name: 'rotated slot', geometry: [{ kind: 'slot', x: 5, y: -3, width: 6, length: 20, angle: 37 }], area: 84 + 9 * Math.PI, contours: 1, arcs: 2 },
    { name: 'nested circle island', geometry: [{ kind: 'circle', x: 0, y: 0, radius: 2 }, { kind: 'circle', x: 0, y: 0, radius: 10 }, { kind: 'circle', x: 0, y: 0, radius: 5 }], area: 79 * Math.PI, contours: 3, arcs: 0 },
    { name: 'concave arc', geometry: [{ kind: 'path', segments: [
      { kind: 'line', start: [0, 0], end: [10, 0] }, { kind: 'line', start: [10, 0], end: [10, 10] },
      { kind: 'line', start: [10, 10], end: [7, 10] }, { kind: 'arc', center: [5, 10], radius: 2, startAngle: 0, sweep: -180 },
      { kind: 'line', start: [3, 10], end: [0, 10] }, { kind: 'line', start: [0, 10], end: [0, 0] }
    ] }], area: 100 - 2 * Math.PI, contours: 1, arcs: 1 }
  ] satisfies readonly { name: string; geometry: readonly CadProfile[]; area: number; contours: number; arcs: number }[])('preserves exact $name material and planar section curves', ({ geometry, area, contours, arcs }) => {
    const original = parseCadDocument({ ...createCadDocument('Original', 'cad_dxf_native'), features: [{ kind: 'sketch', id: 'original', name: 'Original', suppressed: false, plane: 'XY', offset: 0,
      profiles: geometry.map((profile, index) => createCadSketchProfile({ id: `contour_${index}`, geometry: profile })) }] });
    const imported = importCadDxfSketch({ fileName: 'original.dxf', text: cadSketchToDxf(original, 'original'), sketchId: 'imported' });
    const model = buildCadKernelModel(parseCadDocument({ ...original, schemaVersion: 2, features: [imported.sketch,
      { kind: 'extrude', id: 'body', name: 'Body', suppressed: false, sketchId: 'imported', distance: 5, symmetric: false, operation: 'new', targetId: null }] }));
    try {
      expect(model.result.diagnostics).toEqual([]);
      expect(model.result.meshes[0].volume).toBeCloseTo(area * 5, 5);
      const section = model.section({ bodyId: 'body', plane: 'XY', offset: 2 });
      expect(section.contourCount).toBe(contours);
      expect(section.entities.filter(entity => entity.type === 'arc')).toHaveLength(arcs);
      expect(cadEntitiesToCam(section.entities).contours).toHaveLength(contours);
      expect(section.entities.every(entity => entity.type === 'line' || entity.type === 'arc' || entity.type === 'circle')).toBe(true);
    } finally { model.dispose(); }
  });
});
