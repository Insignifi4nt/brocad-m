import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CadSectionRequest, CadSectionResult } from '@/domain/cad/cadSection';
import type { CadMesh } from '@/domain/cad/cadDocument';
import { CadError } from '@/domain/cad/cadError';
import { cadRefusalAt } from '@/domain/cad/cadRefusalSubjects';
import { CadSectionDialog } from './CadSectionDialog';

let host: HTMLDivElement; let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  HTMLDialogElement.prototype.showModal = vi.fn();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const section: CadSectionResult = { bodyId: 'pad', plane: 'XY', offset: 5, contourCount: 1, entities: [{ type: 'circle', layer: 'CAD', center: { x: 0, y: 0 }, radius: 10 }] };
const body: Pick<CadMesh, 'featureId' | 'name' | 'bounds'> = { featureId: 'pad', name: 'Pad', bounds: { min: [2, -6, 0], max: [22, 10, 10] } };
const button = (name: string) => {
  const result = [...host.querySelectorAll('button')].find(button => button.textContent === name);
  if (!result) throw new Error(`Button ${name} missing`); return result;
};
it('pins the preview to its exact request and requires fresh review after changing the plane', async () => {
  const inspect = vi.fn(async () => section); const send = vi.fn(async () => undefined); const close = vi.fn();
  await act(async () => root.render(<CadSectionDialog bodies={[body]} initialBodyId="pad" version="v1" onInspect={inspect} onSend={send} onClose={close} />));
  expect(button('Send section to CAM').disabled).toBe(true);
  await act(async () => button('Preview section').click());
  expect(inspect).toHaveBeenCalledWith({ bodyId: 'pad', plane: 'XY', offset: '5' }, 'v1', expect.any(AbortSignal));
  expect(host.querySelector('svg')?.getAttribute('aria-label')).toBe('Exact section preview');
  expect(button('Send section to CAM').disabled).toBe(false);
  const select = host.querySelectorAll('select')[1];
  await act(async () => { select.value = 'YZ'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(button('Send section to CAM').disabled).toBe(true);
  expect(host.querySelector('svg')).toBeNull();
  await act(async () => button('Preview section').click());
  await act(async () => button('Send section to CAM').click());
  expect(send).toHaveBeenCalledWith({ bodyId: 'pad', plane: 'YZ', offset: '12' }, 'v1', expect.any(AbortSignal));
  expect(close).toHaveBeenCalledOnce();
});
it('aborts outstanding section computation and preserves the dialog on a reported failure', async () => {
  let signal: AbortSignal | undefined;
  const inspect = vi.fn((_request: CadSectionRequest, _version: string, current: AbortSignal) => {
    signal = current;
    return new Promise<CadSectionResult>((_resolve, reject) => current.addEventListener('abort', () => reject(new DOMException('Canceled', 'AbortError'))));
  });
  await act(async () => root.render(<CadSectionDialog bodies={[body]} initialBodyId="pad" version="v1" onInspect={inspect} onSend={async () => undefined} onClose={vi.fn()} />));
  await act(async () => button('Preview section').click());
  expect(button('Close').disabled).toBe(true);
  await act(async () => button('Cancel section').click());
  expect(signal?.aborted).toBe(true);
  expect(button('Close').disabled).toBe(false);
  expect(button('Send section to CAM').disabled).toBe(true);
  expect(host.querySelector('[role=alert]')).toBeNull();
});
it('shows a refused Section with its own message and the code of its CAM issue', async () => {
  const refusal = (recorded: boolean) => {
    const error = new CadError('empty-section', 'The section plane does not cross the body.');
    return recorded ? cadRefusalAt(error, { kind: 'cam-operation', operation: 'section', sourceId: 'pad' }) : error;
  };
  let recorded = true;
  const inspect = vi.fn(async () => { throw refusal(recorded); });
  await act(async () => root.render(<CadSectionDialog bodies={[body]} initialBodyId="pad" version="v1" onInspect={inspect} onSend={async () => undefined} onClose={vi.fn()} />));
  await act(async () => button('Preview section').click());
  const alert = () => host.querySelector<HTMLElement>('[role=alert]');
  expect([alert()?.textContent, alert()?.dataset.cadIssueCode]).toEqual(['The section plane does not cross the body.', 'empty-section']);
  // A failure no CAM step recorded keeps its message and gives no issue code.
  recorded = false;
  await act(async () => button('Preview section').click());
  expect([alert()?.textContent, alert()?.hasAttribute('data-cad-issue-code')]).toEqual(['The section plane does not cross the body.', false]);
  // Nor does one a step recorded before this preview started, which the preview gives again unrecorded.
  const earlier = refusal(true);
  inspect.mockImplementation(async () => { throw earlier; });
  await act(async () => button('Preview section').click());
  expect([alert()?.textContent, alert()?.hasAttribute('data-cad-issue-code')]).toEqual(['The section plane does not cross the body.', false]);
  expect(host.querySelector('details')).toBeNull();
});
it('keeps the kernel\'s own words for a failed Section under a closed disclosure, out of the alert', async () => {
  const message = 'The section could not be cut through this body, for a reason the kernel did not name. Move the section plane slightly or choose another body.';
  const inspect = vi.fn(async () => { throw cadRefusalAt(CadError.received('kernel-operation-failed', message, { kernelMessage: 'BRepAlgoAPI_Section: not done' }),
    { kind: 'cam-operation', operation: 'section', sourceId: 'pad' }); });
  await act(async () => root.render(<CadSectionDialog bodies={[body]} initialBodyId="pad" version="v1" onInspect={inspect} onSend={async () => undefined} onClose={vi.fn()} />));
  await act(async () => button('Preview section').click());
  const alert = host.querySelector<HTMLElement>('[role=alert]'), disclosure = host.querySelector<HTMLDetailsElement>('details');
  expect([alert?.textContent, alert?.dataset.cadIssueCode]).toEqual([message, 'kernel-operation-failed']);
  expect([disclosure?.open, disclosure?.querySelector('summary')?.textContent, disclosure?.querySelector('p')?.textContent]).toEqual([false, 'Kernel message', 'BRepAlgoAPI_Section: not done']);
});
it('uses the selected raised body and signed plane midpoint while retaining exact custom offsets through review', async () => {
  const raised: typeof body = { featureId: 'raised', name: 'Raised', bounds: { min: [50, -20, 5], max: [70, -10, 10] } };
  const inspect = vi.fn(async () => section), send = vi.fn(async () => undefined), close = vi.fn();
  let props: ComponentProps<typeof CadSectionDialog> = { bodies: [body, raised], initialBodyId: 'raised', version: 'v1', onInspect: inspect, onSend: send, onClose: close };
  const show = async (next: Partial<typeof props> = {}) => { props = { ...props, ...next }; await act(async () => root.render(<CadSectionDialog {...props} />)); };
  await show();
  const offset = host.querySelector<HTMLInputElement>('input'), selects = host.querySelectorAll('select');
  if (!offset || selects.length !== 2) throw new Error('Section controls missing.');
  expect(selects[0].value).toBe('raised'); expect(offset.value).toBe('7.5');
  await act(async () => button('Preview section').click());
  expect(inspect).toHaveBeenLastCalledWith({ bodyId: 'raised', plane: 'XY', offset: '7.5' }, 'v1', expect.any(AbortSignal));
  const custom = ' 7.123456789012345 ';
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(offset, custom); offset.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(button('Send section to CAM').disabled).toBe(true);
  await show({ bodies: [{ ...body }, { ...raised }] }); expect(offset.value).toBe(custom);
  await act(async () => button('Preview section').click()); expect(offset.value).toBe(custom);
  await act(async () => button('Send section to CAM').click());
  expect(send).toHaveBeenLastCalledWith({ bodyId: 'raised', plane: 'XY', offset: custom }, 'v1', expect.any(AbortSignal));
  const select = async (index: number, value: string) => act(async () => { selects[index].value = value; selects[index].dispatchEvent(new Event('change', { bubbles: true })); });
  await select(1, 'XZ'); expect(offset.value).toBe('15'); expect(button('Send section to CAM').disabled).toBe(true);
  await act(async () => button('Preview section').click());
  expect(inspect).toHaveBeenLastCalledWith({ bodyId: 'raised', plane: 'XZ', offset: '15' }, 'v1', expect.any(AbortSignal));
  await select(0, 'pad'); expect(offset.value).toBe('-2'); expect(button('Send section to CAM').disabled).toBe(true);
  await act(async () => button('Preview section').click());
  expect(inspect).toHaveBeenLastCalledWith({ bodyId: 'pad', plane: 'XZ', offset: '-2' }, 'v1', expect.any(AbortSignal));
  expect(raised).toEqual({ featureId: 'raised', name: 'Raised', bounds: { min: [50, -20, 5], max: [70, -10, 10] } });
});
it('uses an actual default body and retains its tiny nonzero midpoint without display rounding', async () => {
  const tiny: typeof body = { ...body, featureId: 'tiny', bounds: { min: [0, 0, 2e-7], max: [10, 10, 4e-7] } };
  const inspect = vi.fn(async () => section);
  await act(async () => root.render(<CadSectionDialog bodies={[tiny, body]} initialBodyId="unavailable" version="v1" onInspect={inspect} onSend={vi.fn()} onClose={vi.fn()} />));
  expect(host.querySelector('select')?.value).toBe('tiny'); expect(host.querySelector('input')?.value).toBe('3e-7');
  await act(async () => button('Preview section').click());
  expect(inspect).toHaveBeenCalledExactlyOnceWith({ bodyId: 'tiny', plane: 'XY', offset: '3e-7' }, 'v1', expect.any(AbortSignal));
});
