import { act, useState, useSyncExternalStore, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CadDocument, CadSketchFeature } from '@/domain/cad/cadDocument';
import type { CadSketchGenerator, CadSketchGraph } from '@/domain/cad/cadSketchGraph';
import { expandCadSketchGenerators } from '@/domain/cad/sketch-generators/cadSketchGenerators';
import { applyCadEdits, type CadEdit } from '@/domain/cad/cadOperations';
import { createCadDocument, parseCadDocument } from '@/domain/cad/cadSchema';
import { CadSession } from './cadSession';
import { CadSketchDimensionValueEditor } from './CadSketchDimensionValueEditor';
import { CadSketchCornerEditor, CadSketchMoveEditor, type CadSketchGeometryEditorProps } from './CadSketchGeometryEditors';
import { CadSketchSelectionInspector } from './CadSketchSelectionInspector';
import { CadSketchPreparationError } from './cadSketchConstraintFeedback';

let container: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

type Shared = Omit<CadSketchGeometryEditorProps, 'onClose'>;
/** Mounts an editor on a live session, so Apply changes the document the editor reads, as in the workbench. */
async function mount(source: CadDocument, render: (props: Shared) => ReactElement, options: { readonly edit?: Shared['onEditMany'] } = {}) {
  const session = new CadSession(source), preview = vi.fn(), feedback = vi.fn(), pending = vi.fn((open: boolean) => session.setWorkflowOpen(open));
  const edit = vi.fn<Shared['onEditMany']>(options.edit ?? ((edits, signal) => { signal?.throwIfAborted(); return session.edit(edits); }));
  const prepare = vi.fn<NonNullable<Shared['onPrepareEdits']>>(async (edits, signal) => { signal.throwIfAborted(); return applyCadEdits(session.getSnapshot().document, edits); });
  function Harness() {
    const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot), sketch = snapshot.document.features[0];
    if (sketch.kind !== 'sketch' || !sketch.graph) throw new Error('Sketch fixture missing.');
    return render({ document: snapshot.document, sketch, graph: sketch.graph, onEditMany: edit, onPrepareEdits: prepare, onPendingChange: pending, onPreviewDocument: preview,
      onFeedback: feedback, interactionLocked: false });
  }
  await act(async () => root.render(<Harness />));
  return { session, edit, prepare, preview, feedback, pending, rerender: () => act(async () => root.render(<Harness />)) };
}
const sketchOf = (document: CadDocument) => { const sketch = document.features[0]; if (sketch.kind !== 'sketch' || !sketch.graph) throw new Error('Sketch missing.'); return sketch as CadSketchFeature & { graph: CadSketchGraph }; };
const part = (graph: object, parameters: Record<string, number> = {}) => parseCadDocument({ ...createCadDocument('Part', 'part'), schemaVersion: 2, parameters, features: [{
  id: 'sketch', kind: 'sketch', name: 'Sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph }] });
function field(name: string) { const found = container.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`); if (!found) throw new Error(`Missing input ${name}`); return found; }
function button(name: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === name || item.textContent?.trim() === name);
  if (!found) throw new Error(`Missing button ${name}`); return found;
}
const click = (name: string) => act(async () => button(name).click());
async function input(name: string, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set; if (!setter) throw new Error('Native input setter missing.');
  await act(async () => { const control = field(name); setter.call(control, value); control.dispatchEvent(new Event('input', { bubbles: true })); });
}
const settle = () => act(async () => new Promise(resolve => setTimeout(resolve, 125)));
const key = (target: Element, name: string) => act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })));
const line = (id: string, startPointId: string, endPointId: string) => ({ id, kind: 'line', startPointId, endPointId, construction: false });
/** A workbench with the sketch canvas and one drawn dimension, whose label holds its tab stop; the editor goes as it closes, as the workbench drops it. */
function Closable({ editor }: { readonly editor: (close: () => void) => ReactElement }) {
  const [open, setOpen] = useState(true);
  return <div className="cad-workbench">
    <svg className="cad-sketch-canvas" tabIndex={0} aria-label="Sketch drawing canvas"><g data-cad-sketch-dimension="size"><g role="button" tabIndex={0} aria-label="Dimension size" /></g></svg>
    {open && editor(() => setOpen(false))}
  </div>;
}
const canvas = () => container.querySelector('svg.cad-sketch-canvas'), dimensionLabel = () => container.querySelector('[aria-label="Dimension size"]');

describe('value editor at a dimension', () => {
  const editor = (relationId: string, close = vi.fn(), accepted = vi.fn()) => (props: Shared) =>
    <CadSketchDimensionValueEditor {...props} relationId={relationId} findAnchor={() => null} onClose={close} onAccepted={accepted} />;

  it('edits a linked distance through its parameter, previews privately, and Escape resets before it closes', async () => {
    // The stand-in preparation checks the geometry without solving it, so the far end follows the parameter as a solve would place it.
    const source = part({ points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: ['span', '0'] }], entities: [line('base', 'a', 'b')],
      relations: [{ id: 'span', kind: 'distance', pointIds: ['a', 'b'], value: ' span ' }] }, { span: 10 });
    const close = vi.fn(), accepted = vi.fn(), h = await mount(source, editor('span', close, accepted));
    const form = container.querySelector('form[data-cad-sketch-value-editor="span"]')!;
    expect(form.getAttribute('aria-label')).toBe('Length value'); expect(field('Length mm').value).toBe('10');
    // The first value takes focus, ready for typing.
    expect(document.activeElement).toBe(field('Length mm'));
    await input('Length mm', '12.5'); await settle();
    expect(h.preview).toHaveBeenLastCalledWith(expect.objectContaining({ parameters: { span: 12.5 } }), null); expect(h.session.getSnapshot().document).toBe(source);
    await key(form, 'Escape'); expect(field('Length mm').value).toBe('10'); expect(close).not.toHaveBeenCalled(); expect(h.pending).toHaveBeenLastCalledWith(false);
    await key(form, 'Escape'); expect(close).toHaveBeenCalledOnce();
    // A numeric edit keeps the parameter link: the parameter changes and the dimension still reads it.
    await input('Length mm', '12.5'); await click('Apply');
    const after = h.session.getSnapshot().document;
    expect(after.parameters.span).toBe(12.5); expect(sketchOf(after).graph.relations).toEqual([{ id: 'span', kind: 'distance', pointIds: ['a', 'b'], value: ' span ' }]);
    expect(accepted).toHaveBeenCalledOnce();
    await act(async () => h.session.undo()); expect(h.session.getSnapshot().document).toBe(source);
  });

  it('opens below its dimension unless the tool dock or the sketch bar would cover it there, keeping Apply reachable', async () => {
    // The view: the dock floats over columns 300 to 700 from 700 px down, and the sketch bar over 380 to 720 down to 50 px.
    const workbench = document.createElement('div'); workbench.className = 'cad-workbench'; document.body.append(workbench); workbench.append(container);
    const dock = document.createElement('div'), bar = document.createElement('div'), label = document.createElement('div');
    dock.setAttribute('data-cad-command-dock', ''); bar.setAttribute('data-cad-sketch-header', ''); workbench.append(dock, bar, label);
    let anchor = new DOMRect(400, 600, 40, 12);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this === dock ? new DOMRect(300, 700, 400, 50) : this === bar ? new DOMRect(380, 8, 340, 42) : this === label ? anchor : new DOMRect(0, 0, 0, 0);
    });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(228); vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(120);
    const source = part({ points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [10, 0] }], entities: [line('base', 'a', 'b')],
      relations: [{ id: 'size', kind: 'distance', pointIds: ['a', 'b'], value: 10 }] });
    const top = () => (container.querySelector<HTMLFormElement>('form[data-cad-sketch-value-editor]')!).style.top;
    const open = async () => { await act(async () => root.render(<></>)); await mount(source, props => <CadSketchDimensionValueEditor {...props} relationId="size" findAnchor={() => label} onClose={vi.fn()} onAccepted={vi.fn()} />); };
    try {
      // Below the label at 618 px it would reach 738 px, under the dock, so it opens above the label instead.
      await open(); expect(top()).toBe('474px');
      // Clear of the dock's columns it opens below.
      anchor = new DOMRect(40, 600, 40, 12); await open(); expect(top()).toBe('618px');
      // Under the dock with too little room above the label, it stops under the bar rather than over it.
      anchor = new DOMRect(400, 150, 40, 12); vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(560); await open(); expect(top()).toBe('56px');
    } finally { document.body.append(container); workbench.remove(); vi.restoreAllMocks(); }
  });

  it('stays between the sketch bar and the tool dock on either side of its dimension, and scrolls where they leave too little room', async () => {
    // The view is 1000 by 800 px; the sketch bar floats over columns 300 to 700 down to 36 px, and the dock over them from 700 px down.
    const workbench = document.createElement('div'); workbench.className = 'cad-workbench'; document.body.append(workbench); workbench.append(container);
    const dock = document.createElement('div'), bar = document.createElement('div'), label = document.createElement('div');
    dock.setAttribute('data-cad-command-dock', ''); bar.setAttribute('data-cad-sketch-header', ''); workbench.append(dock, bar, label);
    let anchor = new DOMRect(400, 0, 40, 12), height = 120;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this === dock ? new DOMRect(300, 700, 400, 50) : this === bar ? new DOMRect(300, 8, 400, 28) : this === label ? anchor : new DOMRect(0, 0, 1000, 800);
    });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(228); vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => height);
    const source = part({ points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [10, 0] }], entities: [line('base', 'a', 'b')],
      relations: [{ id: 'size', kind: 'distance', pointIds: ['a', 'b'], value: 10 }] });
    const style = () => (container.querySelector<HTMLFormElement>('form[data-cad-sketch-value-editor]')!).style;
    const open = async () => { await act(async () => root.render(<></>)); await mount(source, props => <CadSketchDimensionValueEditor {...props} relationId="size" findAnchor={() => label} onClose={vi.fn()} onAccepted={vi.fn()} />); };
    try {
      // A label panned up under the bar would put the editor at 18 px below it; it starts under the bar at 42 px instead.
      await open(); expect([style().top, style().maxHeight]).toEqual(['42px', '']);
      // A label panned down under the dock would put the editor above it at 634 px, reaching 754 px; it ends 8 px above the dock instead.
      anchor = new DOMRect(400, 760, 40, 12); await open(); expect([style().top, style().maxHeight]).toEqual(['572px', '']);
      // Taller than the 650 px between the bar and the dock, it starts under the bar and scrolls within them.
      height = 700; await open(); expect([style().top, style().maxHeight, style().overflowY]).toEqual(['42px', '650px', 'auto']);
    } finally { document.body.append(container); workbench.remove(); vi.restoreAllMocks(); }
  });

  it('places itself again, once a frame, as the view resizes or its content grows, staying between the bar and the dock', async () => {
    // A 1440 by 900 px view that shrinks to 440 and then 200 px high, with the dock 20 px off its bottom and the bar along its top.
    const workbench = document.createElement('div'); workbench.className = 'cad-workbench'; document.body.append(workbench); workbench.append(container);
    const dock = document.createElement('div'), bar = document.createElement('div'), label = document.createElement('div');
    dock.setAttribute('data-cad-command-dock', ''); bar.setAttribute('data-cad-sketch-header', ''); workbench.append(dock, bar, label);
    let view = new DOMRect(0, 0, 1440, 900), height = 120;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this === workbench ? view : this === dock ? new DOMRect(500, view.height - 70, 440, 50) : this === bar ? new DOMRect(560, 8, 320, 28)
        : this === label ? new DOMRect(700, 600, 40, 12) : new DOMRect(0, 0, 0, 0);
    });
    vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockReturnValue(workbench);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(228); vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => height);
    // The page's resize observers, so a change of size can be reported to the editor.
    const observers: { readonly report: ResizeObserverCallback; readonly targets: Element[] }[] = [];
    vi.stubGlobal('ResizeObserver', class {
      readonly targets: Element[] = [];
      constructor(report: ResizeObserverCallback) { observers.push({ report, targets: this.targets }); }
      observe(target: Element) { this.targets.push(target); }
      unobserve() {}
      disconnect() { this.targets.length = 0; }
    });
    const source = part({ points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [10, 0] }], entities: [line('base', 'a', 'b')],
      relations: [{ id: 'size', kind: 'distance', pointIds: ['a', 'b'], value: 10 }] });
    const form = () => container.querySelector<HTMLFormElement>('form[data-cad-sketch-value-editor]')!;
    const placed = () => [form().style.top, form().style.maxHeight];
    const nextFrame = (change: () => void) => act(async () => { change(); await new Promise(resolve => requestAnimationFrame(() => resolve(undefined))); });
    const resize = (next: number) => nextFrame(() => { view = new DOMRect(0, 0, 1440, next); window.dispatchEvent(new Event('resize')); });
    try {
      await mount(source, props => <CadSketchDimensionValueEditor {...props} relationId="size" findAnchor={() => label} onClose={vi.fn()} onAccepted={vi.fn()} />);
      // Below its label, ending at 738 px with the dock at 830 px.
      expect(placed()).toEqual(['618px', '']);
      // At 440 px high the dock is at 370 px, so the editor ends 8 px above it.
      await resize(440); expect(placed()).toEqual(['242px', '']);
      // At 200 px high only 80 px are left between the bar and the dock, so it starts under the bar and scrolls in them.
      await resize(200); expect(placed()).toEqual(['42px', '80px']);
      // The view grown back has room again: its content takes its full height below the label, unscrolled.
      await resize(900); expect(placed()).toEqual(['618px', '']);
      // The editor, the view, the dock and the bar are watched; content grown past the room below the label, such as a refusal shown
      // under the value, moves the editor above the label.
      const watching = observers.find(observer => observer.targets.includes(form()));
      expect(watching?.targets).toEqual(expect.arrayContaining([form(), workbench, dock, bar]));
      height = 300; await nextFrame(() => watching?.report([], {} as ResizeObserver)); expect(placed()).toEqual(['294px', '']);
    } finally { document.body.append(container); workbench.remove(); vi.restoreAllMocks(); }
  });

  it('takes focus once it shows, because a field hidden while the editor is placed cannot take focus', async () => {
    const source = part({ points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [10, 0] }], entities: [line('base', 'a', 'b')],
      relations: [{ id: 'size', kind: 'distance', pointIds: ['a', 'b'], value: 10 }] });
    // jsdom lets a hidden field take focus, so each focus records whether the editor was showing at the time.
    const showing: boolean[] = [], focus = HTMLElement.prototype.focus;
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
      if (this instanceof HTMLInputElement) showing.push(this.closest('form')?.style.visibility !== 'hidden');
      focus.call(this, options);
    });
    try {
      await mount(source, editor('size'));
      expect(document.activeElement).toBe(field('Length mm'));
      expect(showing).toEqual([true]);
    } finally { vi.restoreAllMocks(); }
  });

  it('keeps focus through the reset Escape makes, with the value selected, and through the reference flip, and returns it to its dimension, else the canvas, however it closes', async () => {
    const source = part({ points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [10, 0] }], entities: [line('base', 'a', 'b')],
      relations: [{ id: 'size', kind: 'distance', pointIds: ['a', 'b'], value: 10 }] });
    // The far end follows the parameter, so the stand-in preparation accepts an applied length.
    const linked = part({ points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: ['span', '0'] }], entities: [line('base', 'a', 'b')],
      relations: [{ id: 'size', kind: 'distance', pointIds: ['a', 'b'], value: ' span ' }] }, { span: 10 });
    const open = async (anchored = true, from = source) => {
      await act(async () => root.render(<></>));
      return mount(from, props => <Closable editor={close => <CadSketchDimensionValueEditor {...props} relationId="size" onClose={close} onAccepted={close}
        findAnchor={() => anchored ? container.querySelector('[data-cad-sketch-dimension="size"]') : null} />} />);
    };
    // Escape resets an edited value, remounting the fields: the value takes focus again, selected, ready for typing.
    await open(); await input('Length mm', '12'); await key(field('Length mm'), 'Escape');
    expect([document.activeElement === field('Length mm'), field('Length mm').value, field('Length mm').selectionStart, field('Length mm').selectionEnd]).toEqual([true, '10', 0, 2]);
    // A clean Escape closes it: focus goes to the label holding the dimension's tab stop, not to its group.
    await key(field('Length mm'), 'Escape'); expect(document.activeElement).toBe(dimensionLabel());
    // Cancel and Apply the same; with no dimension to return to, the canvas.
    await open(); await click('Cancel'); expect(document.activeElement).toBe(dimensionLabel());
    await open(true, linked); await input('Length mm', '12'); await click('Apply'); await settle(); expect(document.activeElement).toBe(dimensionLabel());
    await open(false); await click('Cancel'); expect(document.activeElement).toBe(canvas());
    // Focus the user moved elsewhere stays there.
    await open(); const outside = document.createElement('button'); document.body.append(outside);
    await act(async () => outside.focus()); await click('Cancel'); expect(document.activeElement).toBe(outside); outside.remove();
    // The reference flip is one button, so the button pressed keeps focus as the dimension changes kind.
    await open(); await act(async () => button('Make reference').focus()); await click('Make reference');
    expect([document.activeElement === button('Make driving'), button('Make driving').getAttribute('aria-disabled')]).toEqual([true, 'true']);
  });

  it('keeps a distance from an axis on its side of the axis and edits an angle in degrees', async () => {
    const source = part({ points: [{ id: 'a', position: [-10, 0] }, { id: 'b', position: [0, 0] }, { id: 'c', position: [0, 10] }], entities: [line('base', 'a', 'b'), line('side', 'b', 'c')],
      relations: [{ id: 'left', kind: 'fixed-axis', pointId: 'a', axis: 'x', value: -10 },
        { id: 'corner', kind: 'line-angle', rays: [{ lineId: 'base', towardPointId: 'a' }, { lineId: 'side', towardPointId: 'c' }], sense: 'cw', value: 90 }] });
    const h = await mount(source, editor('left'));
    expect(field('Distance mm').value).toBe('10');
    await input('Distance mm', '12'); await click('Apply');
    expect(h.edit).toHaveBeenLastCalledWith([{ kind: 'set-sketch-relation', sketchId: 'sketch', relation: { id: 'left', kind: 'fixed-axis', pointId: 'a', axis: 'x', value: -12 } }], expect.any(AbortSignal));
    await act(async () => root.render(<></>));
    await mount(h.session.getSnapshot().document, editor('corner'));
    expect(field('Angle deg').value).toBe('90');
  });

  it('turns a dimension into a reference and back under the same ID, on Apply only', async () => {
    const source = part({ points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [10, 0] }], entities: [line('base', 'a', 'b')],
      relations: [{ id: 'size', kind: 'distance', pointIds: ['a', 'b'], value: 10 }] });
    const h = await mount(source, editor('size'));
    await click('Make reference'); expect(h.session.getSnapshot().document).toBe(source);
    expect(container.querySelector('form')?.getAttribute('aria-label')).toBe('Reference dimension value');
    await click('Apply');
    expect(sketchOf(h.session.getSnapshot().document).graph.relations).toEqual([{ id: 'size', kind: 'reference-dimension', measurement: { kind: 'line-length', entityId: 'base' } }]);
    await act(async () => root.render(<></>));
    const again = await mount(h.session.getSnapshot().document, editor('size'));
    expect(container.querySelector('[aria-label="Reference dimension value"] dd, dd[aria-label="Reference dimension value"]')?.textContent).toBe('10 mm');
    await click('Make driving'); await click('Apply');
    expect(sketchOf(again.session.getSnapshot().document).graph.relations).toEqual([{ id: 'size', kind: 'distance', pointIds: ['a', 'b'], value: 10 }]);
  });

  it('keeps a refused Apply open with its message, and reports the refusal for the header and the tree', async () => {
    const source = part({ points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [10, 0] }], entities: [line('base', 'a', 'b')],
      relations: [{ id: 'size', kind: 'distance', pointIds: ['a', 'b'], value: 10 }] });
    const close = vi.fn(), accepted = vi.fn(), graph = sketchOf(source).graph;
    const refusal = new CadSketchPreparationError({ sketchId: 'sketch', sketchName: 'Sketch', graph, rejection: { kind: 'rejected', reason: 'conflicting', message: 'Over-defined.',
      diagnostics: { status: 'failed', degreesOfFreedom: null, conflictingIds: ['size'], redundantIds: [], partiallyRedundantIds: [], issues: [] } } });
    const h = await mount(source, editor('size', close, accepted), { edit: () => { throw refusal; } });
    await input('Length mm', '12'); await click('Apply');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Sketch: Sketch constraints conflict');
    expect(h.feedback).toHaveBeenLastCalledWith(refusal.feedback); expect(close).not.toHaveBeenCalled(); expect(accepted).not.toHaveBeenCalled();
    expect(field('Length mm').value).toBe('12');
  });

  it('edits both coordinates of a fixed point, each through its own parameter', async () => {
    const source = part({ points: [{ id: 'p', position: ['px', 'py'] }], entities: [],
      relations: [{ id: 'pin', kind: 'fixed-point', pointId: 'p', position: [' px ', ' py '] }] }, { px: 3, py: 4 });
    const h = await mount(source, editor('pin'));
    expect(container.querySelector('form')?.getAttribute('aria-label')).toBe('Fixed point value');
    expect([field('Fixed X mm').value, field('Fixed Y mm').value]).toEqual(['3', '4']);
    await input('Fixed X mm', '5'); await input('Fixed Y mm', '6'); await click('Apply');
    expect(h.edit).toHaveBeenLastCalledWith([{ kind: 'set-parameter', name: 'px', value: 5 }, { kind: 'set-parameter', name: 'py', value: 6 }], expect.any(AbortSignal));
    expect(sketchOf(h.session.getSnapshot().document).graph.relations).toEqual([{ id: 'pin', kind: 'fixed-point', pointId: 'p', position: [' px ', ' py '] }]);
  });
});

describe('selection inspector', () => {
  const inspector = (selection: Parameters<typeof CadSketchSelectionInspector>[0]['selection'], onApply = vi.fn()) => (props: Shared) =>
    <CadSketchSelectionInspector {...props} selection={selection} onApply={onApply} />;

  it('saves a reference measurement of the selection at once, once', async () => {
    const source = part({ points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [10, 0] }], entities: [line('base', 'a', 'b')], relations: [] });
    const onApply = vi.fn();
    await mount(source, inspector([{ kind: 'entity', id: 'base' }], onApply));
    expect(container.querySelector('.cad-property-title')?.textContent).toBe('Line');
    await click('Reference length');
    expect(onApply).toHaveBeenCalledWith([{ kind: 'set-sketch-relation', sketchId: 'sketch', relation: { id: expect.any(String), kind: 'reference-dimension', measurement: { kind: 'line-length', entityId: 'base' } } }]);
    const saved = part({ points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [10, 0] }], entities: [line('base', 'a', 'b')],
      relations: [{ id: 'kept', kind: 'reference-dimension', measurement: { kind: 'line-length', entityId: 'base' } }] });
    await act(async () => root.render(<></>));
    await mount(saved, inspector([{ kind: 'entity', id: 'base' }]));
    expect(button('Reference length').disabled).toBe(true);
  });

  it('edits a circle radius through its parameter link, and an expression point through its coordinates', async () => {
    const source = part({ points: [{ id: 'center', position: ['offset', '0'] }], relations: [],
      entities: [{ id: 'circle', kind: 'circle', centerPointId: 'center', radius: ' radius ', construction: false }] }, { radius: 5, offset: 2 });
    const h = await mount(source, inspector([{ kind: 'entity', id: 'circle' }]));
    expect(container.querySelector('button[type="submit"]')).toBeNull();
    await input('Radius mm', '7.25'); await settle();
    expect(h.preview).toHaveBeenLastCalledWith(expect.objectContaining({ parameters: { radius: 7.25, offset: 2 } }), null);
    await click('Apply');
    expect(h.edit).toHaveBeenLastCalledWith([{ kind: 'set-parameter', name: 'radius', value: 7.25 }], expect.any(AbortSignal));
    expect(sketchOf(h.session.getSnapshot().document).graph.entities).toEqual([{ id: 'circle', kind: 'circle', centerPointId: 'center', radius: ' radius ', construction: false }]);
    await act(async () => root.render(<></>));
    const point = await mount(h.session.getSnapshot().document, inspector([{ kind: 'point', id: 'center' }]));
    expect(field('X mm').value).toBe('2');
    await input('X mm', '3'); await click('Apply');
    expect(point.session.getSnapshot().document.parameters.offset).toBe(3);
  });

  it('asks before a parameter removes relations as a generator regenerates, applies the confirmed removal as one edit, and Cancel keeps them', async () => {
    // Five sides from n, a user point on the fifth corner, and a point whose X reads n: four sides lose the corner and "c4" on it.
    const polygon: CadSketchGenerator = { id: 'poly', kind: 'generator', idPrefix: 'g-poly', construction: false,
      geometry: { kind: 'regular-polygon', x: 0, y: 0, radius: 10, sides: 'n', directionId: '@h' } };
    const corner = expandCadSketchGenerators({ points: [], entities: [], relations: [polygon] }, { n: 5 }).points.find(point => point.id === 'g-poly_v4')!.position;
    const source = part({ points: [{ id: 'u', position: corner }, { id: 'w', position: [' n ', '0'] }], entities: [],
      relations: [polygon, { id: 'c4', kind: 'coincident', pointIds: ['u', 'g-poly_v4'] }] }, { n: 5 });
    const h = await mount(source, inspector([{ kind: 'point', id: 'w' }]));
    const asked = () => container.querySelector('.cad-form-hint[role="status"]')?.textContent ?? null;
    const prompt = /^This removes one relation on geometry the shape no longer has: Coincident relation 2 · .*. Apply removes it, or Cancel keeps it.$/;
    // Apply before the preview has looked: its refusal asks in the editor's words and changes nothing.
    await input('X mm', '4'); await click('Apply');
    expect(asked()).toMatch(prompt); expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain('removedRelationIds'); expect(h.session.getSnapshot().document).toBe(source);
    // Typing the value back drops the question with the edits it was about; typing them again asks again.
    await input('X mm', '5'); expect(asked()).toBeNull(); expect(container.querySelector('[role="alert"]')).toBeNull();
    await input('X mm', '4'); expect(asked()).toMatch(prompt);
    await settle(); await click('Apply');
    expect(h.edit).toHaveBeenLastCalledWith([{ kind: 'set-parameter', name: 'n', value: 4, removedRelationIds: ['c4'] }], expect.any(AbortSignal));
    expect(sketchOf(h.session.getSnapshot().document).graph.relations.filter(relation => !relation.id.startsWith('g-poly_')).map(relation => relation.id)).toEqual(['poly']);
    await act(async () => h.session.undo()); expect(h.session.getSnapshot().document).toBe(source);
    // The preview asks as well; Cancel drops the change and its question, and the part keeps the relation.
    // The confirmed edit previews next, so the canvas shows what Apply makes. A fresh editor has nothing held: the preview alone asks.
    await act(async () => root.render(<></>)); await h.rerender();
    await input('X mm', '4'); await settle(); await settle();
    expect(asked()).toMatch(prompt); expect(h.preview).toHaveBeenLastCalledWith(expect.objectContaining({ parameters: { n: 4 } }), null);
    await click('Cancel');
    expect(asked()).toBeNull(); expect(container.querySelector('[role="alert"]')).toBeNull(); expect(field('X mm').value).toBe('5');
    expect(h.session.getSnapshot().document).toBe(source); expect(h.edit).toHaveBeenCalledTimes(2);
  });
});

describe('move and corner editors', () => {
  it('moves the selection by a typed distance from zero, previews privately and accepts one exact translation', async () => {
    const source = part({ points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [20, 0] }, { id: 'outside', position: [' 30 ', '0'] }],
      entities: [{ ...line('line', 'a', 'b'), construction: true }], relations: [{ id: 'width', kind: 'distance', pointIds: ['a', 'b'], value: ' 20 ' }] });
    const selections = [{ kind: 'entity' as const, id: 'line' }, { kind: 'point' as const, id: 'a' }], close = vi.fn(), place = vi.fn();
    const h = await mount(source, props => <CadSketchMoveEditor {...props} selection={selections} onPlaceGeometry={place} onClose={close} />);
    expect(field('Move X').value).toBe('0'); expect(h.pending).toHaveBeenLastCalledWith(true); expect(button('Apply').disabled).toBe(true);
    // Place and rotate hands over to picked placement only from zero.
    expect(button('Place and rotate…').disabled).toBe(false);
    await input('Move X', '10'); await input('Move Y', '5'); await settle();
    expect(button('Place and rotate…').disabled).toBe(true); expect(h.session.getSnapshot().document).toBe(source);
    expect(h.preview).toHaveBeenLastCalledWith(expect.objectContaining({ features: [expect.objectContaining({ graph: expect.objectContaining({
      points: [{ id: 'a', position: [10, 5] }, { id: 'b', position: [30, 5] }, { id: 'outside', position: [' 30 ', '0'] }] }) })] }), null);
    await click('Apply');
    expect(h.edit).toHaveBeenLastCalledWith([{ kind: 'translate-sketch-geometry', sketchId: 'sketch', selections, translation: [10, 5] }], expect.any(AbortSignal));
    expect(close).toHaveBeenCalledOnce();
    await act(async () => root.render(<></>)); await act(async () => h.session.undo()); expect(h.session.getSnapshot().document).toBe(source);
  });

  it('returns focus to the sketch canvas as it closes', async () => {
    const source = part({ points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [20, 0] }], entities: [line('line', 'a', 'b')], relations: [] });
    await mount(source, props => <Closable editor={close => <CadSketchMoveEditor {...props} selection={[{ kind: 'entity', id: 'line' }]} onClose={close} />} />);
    expect(document.activeElement).toBe(field('Move X'));
    await click('Cancel'); expect(document.activeElement).toBe(canvas());
  });

  it('rounds a corner with a typed radius and hands the new arc and its relation to the caller', async () => {
    const source = part({ points: [{ id: 'a', position: [10, 0] }, { id: 'b', position: [0, 0] }, { id: 'c', position: [0, 10] }], entities: [line('base', 'a', 'b'), line('side', 'b', 'c')], relations: [] });
    const accepted = vi.fn();
    const h = await mount(source, props => <CadSketchCornerEditor {...props} kind="fillet" pointId="b" onAccepted={accepted} onClose={vi.fn()} />);
    expect(container.querySelector('form')?.getAttribute('aria-label')).toBe('Sketch fillet');
    await input('Fillet radius mm', '2'); await click('Apply');
    const edits = h.edit.mock.lastCall?.[0] as readonly CadEdit[];
    expect(edits).toEqual([expect.objectContaining({ kind: 'create-sketch-corner', sketchId: 'sketch', pointId: 'b', treatment: expect.objectContaining({ kind: 'fillet', radius: 2 }) })]);
    const treatment = edits[0].kind === 'create-sketch-corner' ? edits[0].treatment : null;
    expect(accepted).toHaveBeenCalledWith(treatment?.entityId, treatment?.relationId);
    expect(sketchOf(h.session.getSnapshot().document).graph.relations).toEqual([expect.objectContaining({ id: treatment?.relationId, kind: 'fillet-corner' })]);
  });
});
