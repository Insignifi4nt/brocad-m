import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createCadDocument, parseCadDocument } from '@/domain/cad/cadSchema';
import { CadSketchConstraintStatus, type CadSketchConstraintReport } from './CadSketchConstraintStatus';
import type { CadSketchConstraintInspection } from './cadSketchConstraintInspection';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { container.remove(); vi.unstubAllGlobals(); });

function plate() {
  const source = parseCadDocument({ ...createCadDocument('Plate', 'status-plate'), schemaVersion: 2, features: [{
    id: 'sketch', kind: 'sketch', name: 'Plate', plane: 'XY', offset: 0, suppressed: false, profiles: [], graph: {
      points: [{ id: 'center', position: [0, 0] }], entities: [{ id: 'bore', kind: 'circle', centerPointId: 'center', radius: 5, construction: false }], relations: [] } }] });
  const sketch = source.features[0]; if (sketch.kind !== 'sketch') throw new Error('Expected sketch.');
  const answers: ((degreesOfFreedom: number | null) => void)[] = [], failures: ((cause: Error) => void)[] = [];
  const inspect = (sketchId: string) => new Promise<CadSketchConstraintInspection>((resolve, reject) => { failures.push(reject); answers.push(degreesOfFreedom => resolve({
    sketchId, pointCount: 1, entityCount: 1, relationCount: 0, legacyProfileCount: 0, legacyDimensionCount: 0, degreesOfFreedomScope: 'graph', graph: null, parameters: {},
    analysis: { kind: 'solved', diagnostics: { status: 'success', degreesOfFreedom, conflictingIds: [], redundantIds: [], partiallyRedundantIds: [], issues: [] } } })); });
  const reports: (string | null)[] = [];
  const onReport = (report: CadSketchConstraintReport | null) => { reports.push(report && `${report.version} ${report.live ? 'live' : 'paused'} ${report.analysis.diagnostics.degreesOfFreedom}`); };
  const render = (enabled: boolean, version = '1') => act(async () => root.render(<CadSketchConstraintStatus document={source} sketch={sketch} version={version} inspect={inspect} enabled={enabled} onReport={onReport} />));
  return { answers, failures, reports, render };
}
const status = () => container.querySelector('[aria-label="Sketch constraint status"]')?.textContent;

it('reports each answer without first reporting nothing, and nothing once it is removed', async () => {
  const { answers, reports, render } = plate();
  await render(true); await act(async () => answers[0](3));
  expect(reports).toEqual([null, '1 live 3']);
  await render(false); await render(true);
  expect(reports).toEqual([null, '1 live 3', '1 paused 3', '1 live 3']);
  // The new analysis gives the same answer, reported again on its own.
  await act(async () => answers[1](3));
  expect(reports).toEqual([null, '1 live 3', '1 paused 3', '1 live 3', '1 live 3']);
  await act(async () => root.unmount());
  expect(reports).toEqual([null, '1 live 3', '1 paused 3', '1 live 3', '1 live 3', null]);
});

it('names the definition state, keeps the last result while the next version is checked and drops it on failure', async () => {
  const { answers, failures, reports, render } = plate();
  await render(true); await act(async () => answers[0](3));
  expect(status()).toBe('Under defined · 3 DOF');
  expect(container.querySelector('[aria-label="Sketch colours"]')?.getAttribute('aria-description')).toMatch(/^Green: fully defined/);
  // The workbench decides what an older version may still show; the status only says which version answered.
  await render(true, '2');
  expect(status()).toBe('Checking freedom…'); expect(reports.at(-1)).toBe('1 live 3');
  await act(async () => answers[1](0));
  expect(status()).toBe('Fully defined'); expect(reports.at(-1)).toBe('2 live 0');
  await render(true, '3'); await act(async () => answers[2](null));
  expect(status()).toBe('Definition unknown');
  await render(true, '4'); await act(async () => failures[3](new Error('Solver offline.')));
  expect(status()).toBe('Freedom unavailable'); expect(reports.at(-1)).toBeNull();
});

it('keeps the analysis for the next version that only moves a dimension, and asks again after any other change', async () => {
  const document = (value: number, annotation?: object, parameters: Record<string, number> = {}) => parseCadDocument({ ...createCadDocument('Bar', 'status-bar'), schemaVersion: 2, parameters,
    features: [{ id: 'sketch', kind: 'sketch', name: 'Bar', plane: 'XY', offset: 0, suppressed: false, profiles: [], graph: {
      points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [value, 0] }], entities: [{ id: 'bar', kind: 'line', startPointId: 'a', endPointId: 'b', construction: false }],
      relations: [{ id: 'length', kind: 'distance', pointIds: ['a', 'b'], value, ...annotation ? { annotation } : {} }] } }] });
  const versions: (string | undefined)[] = [], answers: ((degreesOfFreedom: number) => void)[] = [], reports: (string | null)[] = [];
  const inspect = (sketchId: string, version?: string) => new Promise<CadSketchConstraintInspection>(resolve => { versions.push(version); answers.push(degreesOfFreedom => resolve({
    sketchId, pointCount: 2, entityCount: 1, relationCount: 1, legacyProfileCount: 0, legacyDimensionCount: 0, degreesOfFreedomScope: 'graph', graph: null, parameters: {},
    analysis: { kind: 'solved', diagnostics: { status: 'success', degreesOfFreedom, conflictingIds: [], redundantIds: [], partiallyRedundantIds: [], issues: [] } } })); });
  // What each version shows when it is first drawn, before any effect has run for it.
  const drawn: (string | null | undefined)[] = [];
  const FirstFrame = () => { useLayoutEffect(() => { drawn.push(status()); }); return null; };
  const render = (source: ReturnType<typeof document>, version: string) => act(async () => {
    const sketch = source.features[0]; if (sketch.kind !== 'sketch') throw new Error('Expected sketch.');
    root.render(<><CadSketchConstraintStatus document={source} sketch={sketch} version={version} inspect={inspect} enabled
      onReport={report => { reports.push(report && `${report.version} ${report.analysis.diagnostics.degreesOfFreedom}`); }} /><FirstFrame /></>);
  });
  const placed = { kind: 'linear', offset: 3, along: 0.5 };
  await render(document(10), '1'); await act(async () => answers[0](3));
  // Moving the dimension, and undoing that, change nothing the analysis reads.
  await render(document(10, placed), '2');
  expect(versions).toEqual(['1']); expect(status()).toBe('Under defined · 3 DOF'); expect(reports.at(-1)).toBe('2 3');
  await render(document(10), '3');
  expect(versions).toEqual(['1']); expect(reports.at(-1)).toBe('3 3');
  // Each move shows the kept analysis from its first frame, never a check in between.
  expect(drawn.slice(1, 3)).toEqual(['Under defined · 3 DOF', 'Under defined · 3 DOF']);
  // A new value is analysed, and so is a move made before that answer arrives, which follows no analysed version.
  await render(document(12, placed), '4'); expect(versions).toEqual(['1', '4']); expect(status()).toBe('Checking freedom…');
  await render(document(12, { ...placed, offset: 5 }), '5'); expect(versions).toEqual(['1', '4', '5']);
  await act(async () => answers[2](1)); expect(status()).toBe('Under defined · 1 DOF');
  // A parameter change with the move is analysed too.
  await render(document(12, placed, { spare: 1 }), '6'); expect(versions).toEqual(['1', '4', '5', '6']);
});

it('analyses a sketch with nothing free to move in its first render, without asking the solver', async () => {
  const source = parseCadDocument({ ...createCadDocument('Plate', 'status-generated'), schemaVersion: 2, parameters: { width: 40 }, features: [{
    id: 'sketch', kind: 'sketch', name: 'Plate', plane: 'XY', offset: 0, suppressed: false, profiles: [], graph: { points: [], entities: [], relations: [
      { id: 'plate', kind: 'generator', idPrefix: 'plate', construction: false, geometry: { kind: 'rectangle', x: 0, y: 0, width: 'width', height: 20, cornerRadius: 2 } },
      { id: 'bore', kind: 'generator', idPrefix: 'bore', construction: false, geometry: { kind: 'circle', x: 'width / 2', y: 10, radius: 4 } }] } }] });
  const [sketch] = source.features; if (sketch.kind !== 'sketch') throw new Error('Expected sketch.');
  const shownSketch = sketch;
  const inspect = vi.fn(() => new Promise<CadSketchConstraintInspection>(() => undefined));
  // What each commit shows: a view captured after the first one must not change when an answer arrives.
  const shown: (string | null)[] = [], defined: (readonly string[] | undefined)[] = [];
  function Probe({ version }: { version: string }) {
    return <CadSketchConstraintStatus document={source} sketch={shownSketch} version={version} inspect={inspect} enabled onReport={report => {
      shown.push(report && `${report.version} ${report.live ? 'live' : 'paused'} ${report.analysis.diagnostics.degreesOfFreedom}`);
      defined.push(report?.analysis.kind === 'solved' ? report.analysis.diagnostics.definition?.definedPointIds : undefined);
    }} />;
  }
  await act(async () => root.render(<Probe version="1" />));
  expect(status()).toBe('Fully defined');
  expect(shown).toEqual(['1 live 0']);
  expect(defined[0]).toEqual(sketch.graph!.points.map(point => point.id));
  expect(inspect).not.toHaveBeenCalled();
  await act(async () => root.render(<Probe version="2" />));
  expect(shown).toEqual(['1 live 0', '2 live 0']); expect(inspect).not.toHaveBeenCalled();
});

it('keeps the shown analysis live while paused, as during a capture, and starts none until it resumes', async () => {
  const answers: ((degreesOfFreedom: number | null) => void)[] = [], reports: (string | null)[] = [];
  const source = parseCadDocument({ ...createCadDocument('Plate', 'status-plate'), schemaVersion: 2, features: [{
    id: 'sketch', kind: 'sketch', name: 'Plate', plane: 'XY', offset: 0, suppressed: false, profiles: [], graph: {
      points: [{ id: 'center', position: [0, 0] }], entities: [{ id: 'bore', kind: 'circle', centerPointId: 'center', radius: 5, construction: false }], relations: [] } }] });
  const [sketch] = source.features; if (sketch.kind !== 'sketch') throw new Error('Expected sketch.');
  const shownSketch = sketch;
  const inspect = vi.fn((sketchId: string) => new Promise<CadSketchConstraintInspection>(resolve => answers.push(degreesOfFreedom => resolve({
    sketchId, pointCount: 1, entityCount: 1, relationCount: 0, legacyProfileCount: 0, legacyDimensionCount: 0, degreesOfFreedomScope: 'graph', graph: null, parameters: {},
    analysis: { kind: 'solved', diagnostics: { status: 'success', degreesOfFreedom, conflictingIds: [], redundantIds: [], partiallyRedundantIds: [], issues: [] } } }))));
  const onReport = (report: CadSketchConstraintReport | null) => { reports.push(report && `${report.version} ${report.live ? 'live' : 'paused'} ${report.analysis.diagnostics.degreesOfFreedom}`); };
  const render = (paused: boolean, version = '1') => act(async () => root.render(<CadSketchConstraintStatus document={source} sketch={shownSketch} version={version} inspect={inspect} enabled paused={paused} onReport={onReport} />));
  await render(false); await act(async () => answers[0](3));
  expect(reports).toEqual([null, '1 live 3']);
  await render(true);
  expect(reports).toEqual([null, '1 live 3']); expect(status()).toBe('Under defined · 3 DOF');
  // A version shown while paused waits for the pause to end.
  await render(true, '2');
  expect(inspect).toHaveBeenCalledTimes(1); expect(status()).toBe('Checking freedom…');
  await render(false, '2'); await act(async () => answers[1](2));
  expect(inspect).toHaveBeenCalledTimes(2); expect(reports.at(-1)).toBe('2 live 2');
});
