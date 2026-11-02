import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createCadDocument, parseCadDocument } from '@/domain/cad/cadSchema';
import type { CadMesh } from '@/domain/cad/cadDocument';
import type { CadSectionResult } from '@/domain/cad/cadSection';
import { CadError } from '@/domain/cad/cadError';
import { cadRefusalAt } from '@/domain/cad/cadRefusalSubjects';
import { CadDxfExportDialog, type CadDxfExportDialogProps } from './CadDxfExportDialog';

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  HTMLDialogElement.prototype.showModal = vi.fn();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const cadDocument = parseCadDocument({ ...createCadDocument('Gear plate', 'gear_plate'), features: [
  { id: 'sketch', name: 'Original outline', kind: 'sketch', suppressed: false, plane: 'XZ', offset: 12,
    profiles: [{ id: 'outline', name: 'Plate', construction: false, geometry: { kind: 'circle', x: 4, y: 5, radius: 10 } },
      { id: 'reference', name: 'Reference', construction: true, geometry: { kind: 'circle', x: 0, y: 0, radius: 30 } }] },
  { id: 'rail', name: 'Open guide', kind: 'curve', suppressed: false, plane: 'XY', offset: 0, segments: [{ kind: 'line', start: [0, 0], end: [10, 0] }] },
  { id: 'hidden', name: 'Suppressed guide', kind: 'curve', suppressed: true, plane: 'XY', offset: 0, segments: [{ kind: 'line', start: [0, 0], end: [10, 0] }] }
] });
const body: CadMesh = { featureId: 'pad', name: 'Finished plate', positions: [], normals: [], indices: [], edges: [], faceGroups: [], edgeGroups: [],
  volume: 100, bounds: { min: [-10, -6, 0], max: [10, 10, 10] } };
const section: CadSectionResult = { bodyId: 'pad', plane: 'XY', offset: 5, contourCount: 2, entities: [
  { type: 'circle', layer: 'CAD', center: { x: 4, y: 5 }, radius: 10 }, { type: 'circle', layer: 'CAD', center: { x: 4, y: 5 }, radius: 2 }
] };
function props(overrides: Partial<CadDxfExportDialogProps> = {}): CadDxfExportDialogProps {
  return { document: cadDocument, bodies: [body], version: 'v1', currentVersion: 'v1', onClose: vi.fn(),
    onExportSketch: vi.fn(async () => undefined), onExportCurve: vi.fn(async () => undefined),
    onInspectSection: vi.fn(async () => section), onExportSection: vi.fn(async () => undefined), ...overrides };
}
function button(name: string) {
  const found = [...host.querySelectorAll('button')].find(candidate => candidate.textContent === name || candidate.getAttribute('aria-label') === name);
  if (!found) throw new Error(`Missing button ${name}`); return found;
}
async function changeSelect(select: HTMLSelectElement, value: string) { await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })); }); }
async function type(input: HTMLInputElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
it('exports the chosen local sketch or open reference curve, excluding construction and suppressed sources', async () => {
  const callbacks = props({ initialFeatureId: 'sketch' });
  await act(async () => root.render(<CadDxfExportDialog {...callbacks} />));
  expect(host.querySelector('.cad-dxf-preview svg')?.getAttribute('aria-label')).toBe('Sketch DXF preview');
  expect(host.querySelectorAll('.cad-dxf-preview svg circle')).toHaveLength(1);
  expect(host.querySelector('.cad-dxf-preview svg circle')?.getAttribute('r')).toBe('10');
  await act(async () => button('Download DXF').click());
  expect(callbacks.onExportSketch).toHaveBeenCalledWith('sketch', 'v1', expect.any(AbortSignal));
  expect(callbacks.onExportSection).not.toHaveBeenCalled();
  await act(async () => host.querySelector<HTMLInputElement>('input[value=curve]')?.click());
  expect(host.querySelector('.cad-dxf-preview svg')?.getAttribute('aria-label')).toBe('Reference curve DXF preview');
  expect([...host.querySelectorAll('option')].map(option => option.textContent)).toEqual(['Open guide']);
  await act(async () => button('Download DXF').click());
  expect(callbacks.onExportCurve).toHaveBeenCalledWith('rail', 'v1', expect.any(AbortSignal));
});
it('requires preview of the actual body and chosen height, invalidating review after the plane or offset changes', async () => {
  const callbacks = props();
  await act(async () => root.render(<CadDxfExportDialog {...callbacks} />));
  const offset = host.querySelector<HTMLInputElement>('[aria-label="Section offset (mm)"]');
  if (!offset) throw new Error('Missing height');
  expect(offset.value).toBe('5');
  expect(button('Download DXF').disabled).toBe(true);
  await act(async () => button('Preview section').click());
  expect(callbacks.onInspectSection).toHaveBeenCalledWith({ bodyId: 'pad', plane: 'XY', offset: '5' }, 'v1', expect.any(AbortSignal));
  expect(host.querySelectorAll('.cad-dxf-preview svg circle')).toHaveLength(2);
  expect(button('Download DXF').disabled).toBe(false);
  await type(offset, '3');
  expect(button('Download DXF').disabled).toBe(true);
  expect(host.querySelector('.cad-dxf-preview svg')).toBeNull();
  await changeSelect(host.querySelectorAll('select')[1], 'XZ');
  expect(offset.value).toBe('-2');
  await type(offset, '5');
  await act(async () => button('Preview section').click());
  await act(async () => button('Download DXF').click());
  expect(callbacks.onExportSection).toHaveBeenCalledWith({ bodyId: 'pad', plane: 'XZ', offset: '5' }, 'v1', expect.any(AbortSignal));
  expect(callbacks.onClose).toHaveBeenCalledOnce();
});
it('reports unsupported section errors and invalid expressions with a usable correction path', async () => {
  const callbacks = props({ onInspectSection: vi.fn(async () => { throw new Error('Unsupported elliptical section. Choose another plane.'); }) });
  await act(async () => root.render(<CadDxfExportDialog {...callbacks} />));
  await act(async () => button('Preview section').click());
  expect(host.querySelector('[role=alert]')?.textContent).toContain('elliptical section');
  expect(button('Download DXF').disabled).toBe(true);
  const offset = host.querySelector<HTMLInputElement>('[aria-label="Section offset (mm)"]');
  if (!offset) throw new Error('Missing offset');
  await type(offset, 'missing / 2');
  expect(host.querySelector('[role=alert]')?.textContent).toContain('missing');
  expect(button('Preview section').disabled).toBe(true);
  await type(offset, '5');
  expect(button('Preview section').disabled).toBe(false);
});
it('shows a refused section export with the code of its export issue, and the kernel\'s own words under a closed disclosure', async () => {
  const subject = { kind: 'export-operation', format: 'dxf-section', sourceId: 'pad' } as const;
  const message = 'The section could not be cut through this body, for a reason the kernel did not name. Move the section plane slightly or choose another body.';
  const callbacks = props({ onInspectSection: vi.fn(async () => { throw cadRefusalAt(new CadError('empty-section', 'The section plane does not cross the body.'), subject); }) });
  await act(async () => root.render(<CadDxfExportDialog {...callbacks} />));
  const alert = () => host.querySelector<HTMLElement>('[role=alert]');
  await act(async () => button('Preview section').click());
  expect([alert()?.textContent, alert()?.dataset.cadIssueCode]).toEqual(['The section plane does not cross the body.', 'empty-section']);
  expect(host.querySelector('details')).toBeNull();
  // The download, after a reviewed preview, gives its own refusal the same way.
  vi.mocked(callbacks.onInspectSection).mockResolvedValue(section);
  vi.mocked(callbacks.onExportSection).mockImplementation(async () => { throw cadRefusalAt(CadError.received('kernel-operation-failed', message, { kernelMessage: 'BRepAlgoAPI_Section: not done' }), subject); });
  await act(async () => button('Preview section').click());
  await act(async () => button('Download DXF').click());
  const disclosure = host.querySelector<HTMLDetailsElement>('details');
  expect([alert()?.textContent, alert()?.dataset.cadIssueCode]).toEqual([message, 'kernel-operation-failed']);
  expect([disclosure?.open, disclosure?.querySelector('summary')?.textContent, disclosure?.querySelector('p')?.textContent]).toEqual([false, 'Kernel message', 'BRepAlgoAPI_Section: not done']);
  expect(alert()?.textContent).not.toContain('BRepAlgoAPI');
  expect(callbacks.onClose).not.toHaveBeenCalled();
  // A refusal recorded before this preview started, which the preview gives again unrecorded, has no code here.
  const earlier = cadRefusalAt(new CadError('empty-section', 'The section plane does not cross the body.'), subject);
  vi.mocked(callbacks.onInspectSection).mockImplementation(async () => { throw earlier; });
  await act(async () => button('Preview section').click());
  expect([alert()?.textContent, alert()?.hasAttribute('data-cad-issue-code')]).toEqual(['The section plane does not cross the body.', false]);
  expect(host.querySelector('details')).toBeNull();
});
it.each(['close', 'stale', 'cancel'] as const)('aborts an outstanding section on %s and never publishes its late preview', async change => {
  let signal: AbortSignal | undefined, resolve: ((result: CadSectionResult) => void) | undefined;
  const callbacks = props({ onInspectSection: vi.fn((_request, _version, current) => { signal = current; return new Promise<CadSectionResult>(done => { resolve = done; }); }) });
  await act(async () => root.render(<CadDxfExportDialog {...callbacks} />));
  await act(async () => button('Preview section').click());
  await act(async () => {
    if (change === 'close') button('Close DXF export').click();
    else if (change === 'cancel') button('Cancel operation').click();
    else root.render(<CadDxfExportDialog {...callbacks} currentVersion="v2" />);
  });
  expect(signal?.aborted).toBe(true);
  await act(async () => resolve?.(section));
  expect(host.querySelector('.cad-dxf-preview svg')).toBeNull();
  expect(button('Download DXF').disabled).toBe(true);
  expect(callbacks.onExportSection).not.toHaveBeenCalled();
  expect(callbacks.onClose).toHaveBeenCalledTimes(change === 'close' ? 1 : 0);
  if (change === 'stale') expect(host.querySelector('[role=alert]')?.textContent).toContain('draft changed');
});
it('keeps help inside the modal so keyboard and native dialog focus can reach it', async () => {
  await act(async () => root.render(<CadDxfExportDialog {...props()} />));
  await act(async () => button('DXF geometry source help').click());
  const modal = host.querySelector('dialog');
  expect(modal?.querySelector('[role=dialog]')?.textContent).toContain('solid silhouette');
});
it('initializes a section body when a same-version build finishes, retaining a later custom height', async () => {
  const callbacks = props({ bodies: [], initialFeatureId: 'sketch' });
  await act(async () => root.render(<CadDxfExportDialog {...callbacks} />));
  expect(host.querySelector<HTMLInputElement>('input[value=section]')?.disabled).toBe(true);
  await act(async () => root.render(<CadDxfExportDialog {...callbacks} bodies={[body]} />));
  await act(async () => host.querySelector<HTMLInputElement>('input[value=section]')?.click());
  const offset = host.querySelector<HTMLInputElement>('[aria-label="Section offset (mm)"]');
  if (!offset) throw new Error('Missing section height');
  expect(offset.value).toBe('5');
  expect(button('Preview section').disabled).toBe(false);
  await type(offset, '3');
  await act(async () => root.render(<CadDxfExportDialog {...callbacks} bodies={[{ ...body }]} />));
  expect(offset.value).toBe('3');
  await act(async () => button('Preview section').click());
  expect(callbacks.onInspectSection).toHaveBeenCalledWith({ bodyId: 'pad', plane: 'XY', offset: '3' }, 'v1', expect.any(AbortSignal));
});
