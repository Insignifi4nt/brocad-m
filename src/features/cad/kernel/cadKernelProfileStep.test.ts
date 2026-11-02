// @vitest-environment node
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import initOpenCascade from 'replicad-opencascadejs';
import { getOC, setOC } from 'replicad';
import type { CadCurveFeature, CadDocument, CadFeature, CadPlane, CadProfile, CadSketchFeature } from '../../../domain/cad/cadDocument';
import { cadBuildIssues } from '../../../domain/cad/cadBuildIssues';
import { cadIssueNames, cadIssueSubjectLabel } from '../cadIssuePresentation';
import { buildCadKernelModel } from './cadKernelModel';

beforeAll(async () => {
  const wasmBinary = await readFile(new URL('../../../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm', import.meta.url));
  setOC(await initOpenCascade({ wasmBinary, print: () => undefined, printErr: () => undefined }));
}, 60_000);

const base = (id: string, name = id) => ({ id, name, suppressed: false });
const rectangle = (x: number, y: number, size: number): CadProfile => ({ kind: 'rectangle', x, y, width: size, height: size, cornerRadius: 0 });
const circle = (x: number, y: number, radius: number): CadProfile => ({ kind: 'circle', x, y, radius });
function sketch(id: string, geometries: readonly CadProfile[], plane: CadPlane = 'XY', offset = 0): CadSketchFeature {
  return { ...base(id, `${id} sketch`), kind: 'sketch', plane, offset, profiles: geometries.map((geometry, index) => ({ id: `${id}_${index}`, name: `Contour ${index + 1}`, construction: false, geometry })) };
}
const extrude = (id: string, sketchId: string, operation: 'new' | 'join' | 'cut' = 'new', targetId: string | null = null, distance = 10): CadFeature =>
  ({ ...base(id), kind: 'extrude', sketchId, distance, symmetric: false, operation, targetId });
/** A 20 mm block, from sketch `stock_profile`, whose own face is the first face a rebuild builds. */
const stock: readonly CadFeature[] = [sketch('stock_profile', [rectangle(-10, -10, 20)]), extrude('stock', 'stock_profile')];
const rail: CadCurveFeature = { ...base('rail'), kind: 'curve', plane: 'XY', offset: 0, segments: [{ kind: 'line', start: [0, 0], end: [20, 0] }] };
const sweep = (operation: 'new' | 'cut' = 'new', targetId: string | null = null): CadFeature =>
  ({ ...base('sweep'), kind: 'sweep', sketchId: 'section', curveId: 'rail', operation, targetId });
const document = (features: readonly CadFeature[]): CadDocument => ({ format: 'wireedm-cad', schemaVersion: 1, id: 'profile_step', name: 'Profile step', units: 'mm', features, parameters: {} });

type Native = 'BRepBuilderAPI_MakeFace' | 'BRepBuilderAPI_MakeWire' | 'BRepPrimAPI_MakePrism' | 'BRepPrimAPI_MakeRevol';
const restores: (() => void)[] = [];
afterEach(() => { while (restores.length) restores.pop()!(); });
/** Makes call `call` of native method `method` throw `error`, or answer `answer` instead, counting the calls of every builder of that class. */
function fault(native: Native, method: string, call: number, effect: { error: string } | { answer: unknown }): { readonly calls: () => number } {
  const prototype = (getOC() as unknown as Record<Native, { prototype: Record<string, (...args: unknown[]) => unknown> }>)[native].prototype;
  const original = prototype[method]; let calls = 0;
  const spy = vi.spyOn(prototype, method).mockImplementation(function(this: unknown, ...args: unknown[]) {
    if (++calls !== call) return original.apply(this, args);
    if ('error' in effect) throw new Error(effect.error);
    return effect.answer;
  });
  restores.push(() => spy.mockRestore());
  return { calls: () => calls };
}
function diagnosticOf(features: readonly CadFeature[]) {
  const model = buildCadKernelModel(document(features));
  try {
    // The failure, and the stop the rebuild reports at the same feature.
    expect(model.result.diagnostics.map(item => [item.code === 'rebuild-stopped', item.featureId])).toEqual([[false, model.result.diagnostics[0].featureId], [true, model.result.diagnostics[0].featureId]]);
    return { diagnostic: model.result.diagnostics[0], bodies: model.result.meshes.map(mesh => mesh.featureId) };
  } finally { model.dispose(); }
}
const PROFILE = /^The sketch profile could not be turned into a face\. .*; edit the sketch\.$/;
const profileStep = (sketchId: string) => ({ operation: 'profile', input: { field: 'sketchId', id: sketchId } });

describe('the profile step of a feature that builds faces from its sketch', () => {
  it('names the sketch and its next step when an extrusion\'s face cannot be built, and the extrusion once it is', () => {
    const features = [sketch('profile', [rectangle(0, 0, 10)]), extrude('solid', 'profile')];
    fault('BRepBuilderAPI_MakeFace', 'Face', 1, { error: 'Forced face failure' });
    const { diagnostic } = diagnosticOf(features);
    expect(diagnostic).toEqual({ code: 'kernel-operation-failed', featureId: 'solid', message: expect.stringMatching(PROFILE),
      details: { ...profileStep('profile'), kernelMessage: 'Forced face failure' } });
    // The issue row names the sketch the face was built from, by its name.
    const [issue] = cadBuildIssues(document(features), { diagnostics: [diagnostic] }, 'v1').items;
    expect(cadIssueSubjectLabel(issue.subject, cadIssueNames([issue], document(features)))).toBe('solid · input profile sketch');
    restores.pop()!();
    fault('BRepPrimAPI_MakePrism', 'Shape', 1, { error: 'Forced prism failure' });
    expect(diagnosticOf(features).diagnostic).toMatchObject({ message: expect.stringMatching(/^The extrusion could not be built from its sketch\./),
      details: { operation: 'extrude', input: { field: 'sketchId', id: 'profile' }, kernelMessage: 'Forced prism failure' } });
  });

  it('takes each region of a sketch as its own face, resuming the extrusion between them', () => {
    const features = [sketch('profile', [rectangle(0, 0, 4), rectangle(10, 0, 4)]), extrude('solid', 'profile')];
    fault('BRepBuilderAPI_MakeFace', 'Face', 2, { error: 'Forced second face failure' });
    expect(diagnosticOf(features).diagnostic).toMatchObject({ details: { ...profileStep('profile'), kernelMessage: 'Forced second face failure' } });
    restores.pop()!();
    const prism = fault('BRepPrimAPI_MakePrism', 'Shape', 1, { error: 'Forced first prism failure' });
    expect(diagnosticOf(features).diagnostic).toMatchObject({ details: { operation: 'extrude', kernelMessage: 'Forced first prism failure' } }); expect(prism.calls()).toBe(1);
  });

  it('names a refusal while a contour\'s wire is built with the profile step, keeping its code and message', () => {
    // The stock's wire is the first; the cut's is the second.
    fault('BRepBuilderAPI_MakeWire', 'Error', 2, { answer: -1 });
    const { diagnostic, bodies } = diagnosticOf([...stock, sketch('hole', [circle(0, 0, 3)], 'XY', 10), extrude('cut', 'hole', 'cut', 'stock', -5)]);
    expect(diagnostic).toEqual({ code: 'invalid-profile', featureId: 'cut', message: 'The exact profile edges could not form a connected wire.',
      details: { ...profileStep('hole'), kernelMessage: null } });
    expect(bodies).toEqual(['stock']);
  });

  it('resumes a cut extrusion at its own step after the face, and at the cut after the prism', () => {
    const features = [...stock, sketch('hole', [circle(0, 0, 3)], 'XY', 10), extrude('cut', 'hole', 'cut', 'stock', -5)];
    fault('BRepBuilderAPI_MakeFace', 'Face', 2, { error: 'Forced cut face failure' });
    expect(diagnosticOf(features).diagnostic).toMatchObject({ featureId: 'cut', details: { ...profileStep('hole'), kernelMessage: 'Forced cut face failure' } });
    restores.pop()!();
    fault('BRepPrimAPI_MakePrism', 'Shape', 2, { error: 'Forced cut prism failure' });
    expect(diagnosticOf(features).diagnostic).toMatchObject({ featureId: 'cut', details: { operation: 'extrude', input: { field: 'sketchId', id: 'hole' } } });
  });

  it('names the sketch when a revolution\'s face cannot be built, and the revolution once it is', () => {
    const features: CadFeature[] = [sketch('profile', [circle(0, 10, 2)]), { ...base('ring'), kind: 'revolve', sketchId: 'profile', axis: 'x', angle: 360, operation: 'new', targetId: null }];
    fault('BRepBuilderAPI_MakeFace', 'Face', 1, { error: 'Forced revolve face failure' });
    expect(diagnosticOf(features).diagnostic).toEqual({ code: 'kernel-operation-failed', featureId: 'ring', message: expect.stringMatching(PROFILE),
      details: { ...profileStep('profile'), kernelMessage: 'Forced revolve face failure' } });
    restores.pop()!();
    fault('BRepPrimAPI_MakeRevol', 'Shape', 1, { error: 'Forced revolution failure' });
    expect(diagnosticOf(features).diagnostic).toMatchObject({ message: expect.stringMatching(/^The revolution could not be built from its sketch\./),
      details: { operation: 'revolve', input: { field: 'sketchId', id: 'profile' }, kernelMessage: 'Forced revolution failure' } });
  });

  it('names the sketch when a pocket\'s cutting face cannot be built, and the pocket once it is', () => {
    const features: CadFeature[] = [...stock, sketch('profile', [circle(0, 0, 3)], 'XY', 5),
      { ...base('pocket'), kind: 'pocket', sketchId: 'profile', targetId: 'stock', extent: { kind: 'through-all', direction: 'both' } }];
    fault('BRepBuilderAPI_MakeFace', 'Face', 2, { error: 'Forced pocket face failure' });
    expect(diagnosticOf(features)).toEqual({ bodies: ['stock'], diagnostic: { code: 'kernel-operation-failed', featureId: 'pocket', message: expect.stringMatching(PROFILE),
      details: { ...profileStep('profile'), kernelMessage: 'Forced pocket face failure' } } });
    restores.pop()!();
    // A refusal while the face is built keeps its code with the profile step.
    fault('BRepBuilderAPI_MakeFace', 'IsDone', 2, { answer: false });
    expect(diagnosticOf(features).diagnostic).toMatchObject({ code: 'pocket-tool', featureId: 'pocket', details: profileStep('profile') });
    restores.pop()!();
    // So does one while a contour's wire is built: the stock's wire is the first, the pocket's the second.
    fault('BRepBuilderAPI_MakeWire', 'Error', 2, { answer: -1 });
    expect(diagnosticOf(features).diagnostic).toMatchObject({ code: 'invalid-profile', featureId: 'pocket', details: profileStep('profile') });
    restores.pop()!();
    fault('BRepPrimAPI_MakePrism', 'Shape', 2, { error: 'Forced pocket tool failure' });
    expect(diagnosticOf(features).diagnostic).toMatchObject({ message: expect.stringMatching(/^The pocket could not be cut\./),
      details: { operation: 'pocket', input: { field: 'sketchId', id: 'profile' }, kernelMessage: 'Forced pocket tool failure' } });
  });

  it('names the section sketch when a sweep\'s face cannot be built, and resumes reading the curve once it is', () => {
    const section = sketch('section', [circle(0, 0, 1)], 'YZ');
    fault('BRepBuilderAPI_MakeFace', 'Face', 1, { error: 'Forced section face failure' });
    expect(diagnosticOf([section, rail, sweep()]).diagnostic).toEqual({ code: 'kernel-operation-failed', featureId: 'sweep', message: expect.stringMatching(PROFILE),
      details: { ...profileStep('section'), kernelMessage: 'Forced section face failure' } });
    restores.pop()!();
    fault('BRepBuilderAPI_MakeFace', 'IsDone', 1, { answer: false });
    expect(diagnosticOf([section, rail, sweep()]).diagnostic).toMatchObject({ code: 'sweep-section', details: profileStep('section') });
    restores.pop()!();
    fault('BRepBuilderAPI_MakeWire', 'Error', 1, { answer: -1 });
    expect(diagnosticOf([section, rail, sweep()]).diagnostic).toMatchObject({ code: 'invalid-profile', details: profileStep('section') });
    restores.pop()!();
    fault('BRepPrimAPI_MakePrism', 'Shape', 1, { error: 'Forced sweep segment failure' });
    expect(diagnosticOf([section, rail, sweep()]).diagnostic).toMatchObject({ message: expect.stringMatching(/^The sweep could not follow its curve\./),
      details: { operation: 'sweep', input: { field: 'curveId', id: 'rail' }, kernelMessage: 'Forced sweep segment failure' } });
  });

  it('builds a cutting sweep\'s face as the profile step and resumes the sweep, not its target, once it is', () => {
    const features = [...stock, sketch('section', [circle(0, 0, 1)], 'YZ', -15), { ...rail, offset: 0, segments: [{ kind: 'line', start: [-15, 0], end: [15, 0] }] } satisfies CadCurveFeature, sweep('cut', 'stock')];
    fault('BRepBuilderAPI_MakeFace', 'Face', 2, { error: 'Forced cutting section failure' });
    expect(diagnosticOf(features)).toEqual({ bodies: ['stock'], diagnostic: expect.objectContaining({ featureId: 'sweep', message: expect.stringMatching(PROFILE),
      details: { ...profileStep('section'), kernelMessage: 'Forced cutting section failure' } }) });
    restores.pop()!();
    fault('BRepPrimAPI_MakePrism', 'Shape', 2, { error: 'Forced cutting segment failure' });
    expect(diagnosticOf(features).diagnostic).toMatchObject({ details: { operation: 'sweep', input: { field: 'curveId', id: 'rail' }, kernelMessage: 'Forced cutting segment failure' } });
  });
});
