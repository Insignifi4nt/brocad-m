// @vitest-environment node
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import initOpenCascade from 'replicad-opencascadejs';
import { getOC, makeBox, setOC } from 'replicad';
import { applyCadEdgeOperation } from './cadKernelOperations';

beforeAll(async () => {
  const wasmBinary = await readFile(new URL('../../../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  setOC(await initOpenCascade({ wasmBinary, print: () => undefined, printErr: () => undefined }));
}, 60_000);
afterEach(() => { vi.restoreAllMocks(); });

/** What rounding or bevelling every edge of a box raises once the kernel's builder reports it could not. */
function refusal(kind: 'fillet' | 'chamfer'): unknown {
  const box = makeBox([0, 0, 0], [20, 16, 10]);
  try { applyCadEdgeOperation(box, box.edges, kind, 1); return null; } catch (error) { return error; } finally { box.delete(); }
}

it('names the size to reduce when the kernel refuses an edge operation: the radius of a fillet, the distance of a chamfer', () => {
  const oc = getOC();
  vi.spyOn(oc.BRepFilletAPI_MakeFillet.prototype, 'IsDone').mockReturnValue(false);
  vi.spyOn(oc.BRepFilletAPI_MakeChamfer.prototype, 'IsDone').mockReturnValue(false);
  expect(refusal('fillet')).toMatchObject({ code: 'kernel-operation-failed',
    message: 'The fillet could not be applied to the selected edges. The radius may be too large for an edge or a face next to it; reduce the radius or choose other edges.' });
  expect(refusal('chamfer')).toMatchObject({ code: 'kernel-operation-failed',
    message: 'The chamfer could not be applied to the selected edges. The distance may be too large for an edge or a face next to it; reduce the distance or choose other edges.' });
});
