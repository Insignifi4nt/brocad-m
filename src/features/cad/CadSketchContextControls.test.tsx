import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { parseCadDocument, createCadDocument } from '@/domain/cad/cadSchema';
import type { CadSketchGraph } from '@/domain/cad/cadSketchGraph';
import { cadSketchRelationOffers, type CadSketchRelationOffer } from '@/domain/cad/sketch-relations/cadSketchRelationOffers';
import { CadSketchContextHeader } from './CadSketchContextHeader';
import { CadSketchRelationList, CAD_SKETCH_RELATION_ROW_HEIGHT, cadSketchRelationRow, type CadSketchRelationListProps } from './CadSketchRelationList';
import { CadSketchSelectionActions, cadSketchCenterSymmetryOffer, cadSketchSelectionActions, cadSketchSelectionRelationActions, placeCadSketchSelectionActions, type CadSketchSelectionActionsModel } from './CadSketchSelectionActions';
import { createCadSketchHighlightStore } from './cadSketchDimensionSelection';
import { cadSketchIssues, type CadSketchIssues } from './cadSketchIssues';
import { CadSketchPreparationError } from './cadSketchConstraintFeedback';
import { CAD_SKETCH_SOLVER_STOPPED } from './sketch-solver/cadSketchSolverFailure';

let container: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const graphOf = (graph: object, parameters: Record<string, number> = {}): CadSketchGraph => {
  const document = parseCadDocument({ ...createCadDocument('Part', 'part'), schemaVersion: 2, parameters, features: [{ id: 'sketch', kind: 'sketch', name: 'Sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [], graph }] });
  const sketch = document.features[0]; if (sketch.kind !== 'sketch' || !sketch.graph) throw new Error('Sketch missing.'); return sketch.graph;
};
const line = (id: string, startPointId: string, endPointId: string) => ({ id, kind: 'line', startPointId, endPointId, construction: false });
const key = (target: Element, name: string, init: KeyboardEventInit = {}) => act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init })));
const buttons = (scope: ParentNode = container) => [...scope.querySelectorAll<HTMLButtonElement>('button')];
const named = (name: string) => { const found = buttons().find(button => button.getAttribute('aria-label') === name); if (!found) throw new Error(`Missing ${name}`); return found; };

/** Two lines meeting at b, two circles, and an arc. */
const plate = () => graphOf({
  points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [10, 0] }, { id: 'c', position: [10, 10] }, { id: 'o1', position: [30, 0] }, { id: 'o2', position: [40, 0] },
    { id: 'q', position: [20, 10] }, { id: 's', position: [20, 0] }],
  entities: [line('ab', 'a', 'b'), line('bc', 'b', 'c'), { id: 'c1', kind: 'circle', centerPointId: 'o1', radius: 2, construction: false },
    { id: 'c2', kind: 'circle', centerPointId: 'o2', radius: 3, construction: false }, { id: 'arc', kind: 'arc', centerPointId: 'q', startPointId: 'c', endPointId: 's', direction: 'ccw', construction: false }],
  relations: [{ id: 'level', kind: 'horizontal', pointIds: ['a', 'b'] }]
});

describe('selection icon row', () => {
  it('names two arcs or circles on one centre, or one centred at the origin, Concentric, a Fix by its tool name, and a name two kinds share once, the usable one first', () => {
    const graph = plate();
    const circles = cadSketchSelectionActions(graph, cadSketchRelationOffers(graph, [{ kind: 'entity', id: 'c1' }, { kind: 'entity', id: 'c2' }]));
    expect(circles.map(action => action.label)).toEqual(expect.arrayContaining(['Concentric', 'Equal radius']));
    expect(circles.find(action => action.label === 'Concentric')).toMatchObject({ key: 'concentric', state: 'available', help: 'Keeps the arcs and circles on one center, or the arc or circle centered at the origin, independently of their sizes.' });
    // An arc or circle with the origin takes Concentric, its center held at the origin, beside Point on curve for the origin on it; with an axis,
    // Coincident holds its center on the axis. Both are what the Constrain tool makes of those picks.
    const atOrigin = cadSketchSelectionRelationActions(graph, [{ kind: 'point', id: '@origin' }, { kind: 'entity', id: 'arc' }]);
    expect(atOrigin.map(action => [action.label, action.state])).toEqual([['Concentric', 'available'], ['Point on curve', 'available']]);
    expect(atOrigin[0].offer.relations).toEqual([{ kind: 'fixed-axis', pointId: 'q', axis: 'x', value: 0 }, { kind: 'fixed-axis', pointId: 'q', axis: 'y', value: 0 }]);
    const onAxis = cadSketchSelectionRelationActions(graph, [{ kind: 'entity', id: 'c1' }, { kind: 'entity', id: '@v' }]);
    expect(onAxis.find(action => action.label === 'Coincident')).toMatchObject({ key: 'coincident', state: 'available', offer: { relations: [{ kind: 'fixed-axis', pointId: 'o1', axis: 'x', value: 0 }] } });
    // A line alone takes Horizontal, applied here and pressed to remove, and Vertical, blocked with the judge's reason; Fix holds points only.
    const edge = cadSketchSelectionActions(graph, cadSketchRelationOffers(graph, [{ kind: 'entity', id: 'ab' }]));
    expect(edge.map(action => [action.label, action.state])).toEqual([['Horizontal', 'applied'], ['Vertical', 'blocked']]);
    expect(edge[0].help).toBe('Applied. Press to remove horizontal.'); expect(edge[1].help).toBe('This is already horizontal.');
    expect(cadSketchSelectionActions(graph, cadSketchRelationOffers(graph, [{ kind: 'point', id: 'c' }])).find(action => action.key === 'fixed-point'))
      .toMatchObject({ label: 'Fix', state: 'available', help: 'Keeps each point where it is now.' });
    // Tangent and the tangent joint share a name: the row shows one button, the available offer over a blocked one in either order.
    const blocked: CadSketchRelationOffer = { kind: 'tangent', state: 'blocked', reason: 'These do not touch.', operands: [], relations: [], relationIds: [] };
    const available: CadSketchRelationOffer = { kind: 'tangent-joint', state: 'available', operands: [], relations: [], relationIds: [] };
    for (const offers of [[blocked, available], [available, blocked]]) expect(cadSketchSelectionActions(graph, offers).map(action => [action.label, action.state])).toEqual([['Tangent', 'available']]);
  });

  it('offers Symmetric centers beside Symmetric for two circles and a line or an axis, applied once their centers mirror, and for nothing else', () => {
    // Fixed radii of 2 and 3 cannot mirror as whole curves, so Symmetric is blocked, while the centers alone can mirror about the line.
    const graph = graphOf({ ...plate(), entities: plate().entities.map(entity => entity.kind === 'circle' ? { ...entity, radius: String(entity.radius) } : entity) });
    const pick = (...ids: string[]) => ids.map(id => ({ kind: 'entity' as const, id }));
    const row = (selection: ReturnType<typeof pick>, on = graph) => cadSketchSelectionActions(on, cadSketchRelationOffers(on, selection), cadSketchCenterSymmetryOffer(on, selection));
    const free = row(pick('c1', 'c2', 'ab')), at = free.findIndex(action => action.label === 'Symmetric');
    expect(free[at]).toMatchObject({ state: 'blocked', help: 'These circles have fixed radii that differ, so they cannot mirror each other.' });
    expect(free[at + 1]).toMatchObject({ key: 'symmetric-centers', label: 'Symmetric centers', state: 'available',
      help: 'Keeps the two circles’ centers mirrored about the line or axis; each radius keeps its own driver.' });
    expect(free[at + 1].offer.relations).toEqual([expect.objectContaining({ kind: 'symmetric', pointIds: ['o1', 'o2'], lineId: 'ab' })]);
    expect(row(pick('c2', '@v', 'c1')).find(action => action.key === 'symmetric-centers')?.offer.relations).toEqual([expect.objectContaining({ pointIds: ['o2', 'o1'], lineId: '@v' })]);
    // x = 35 mirrors the centers at 30 and 40.
    const mirrored = graphOf({ points: [...graph.points, { id: 'm1', position: [35, -5] }, { id: 'm2', position: [35, 5] }], entities: [...graph.entities, line('axis', 'm1', 'm2')],
      relations: [{ id: 'mirror', kind: 'symmetric', pointIds: ['o1', 'o2'], lineId: 'axis' }] });
    expect(row(pick('c1', 'c2', 'axis'), mirrored).find(action => action.key === 'symmetric-centers')).toMatchObject({ state: 'applied', help: 'Applied. Press to remove symmetric centers.', offer: { relationIds: ['mirror'] } });
    for (const selection of [pick('c1', 'c2'), pick('c1', 'arc', 'ab'), pick('c1', 'c2', 'ab', 'bc'), [{ kind: 'point' as const, id: 'o1' }, ...pick('c2', 'ab')]])
      expect(cadSketchCenterSymmetryOffer(graph, selection), JSON.stringify(selection)).toBeNull();
  });

  it('sits above the selection, else below, beside or in a corner, inside the viewport margins, and never over the selection', () => {
    const viewport = { width: 800, height: 600 }, size = { width: 160, height: 28 };
    expect(placeCadSketchSelectionActions({ left: 300, top: 300, right: 400, bottom: 360 }, size, viewport)).toEqual({ left: 270, top: 262, right: 430, bottom: 290 });
    // Under the header, the row goes below the selection.
    expect(placeCadSketchSelectionActions({ left: 300, top: 50, right: 400, bottom: 80 }, size, viewport)?.top).toBe(90);
    const overlaps = (a: { left: number; top: number; right: number; bottom: number }, b: typeof a) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    let hidden = 0;
    for (let left = 0; left < 800; left += 37) for (let top = 0; top < 600; top += 41) for (const [w, h] of [[4, 4], [120, 30], [300, 200], [600, 420], [790, 590]]) {
      const selection = { left, top, right: left + w, bottom: top + h }, box = placeCadSketchSelectionActions(selection, size, viewport);
      if (!box) { hidden += 1; continue; }
      expect(box.left).toBeGreaterThanOrEqual(8); expect(box.right).toBeLessThanOrEqual(792); expect(box.top).toBeGreaterThanOrEqual(48); expect(box.bottom).toBeLessThanOrEqual(536);
      expect(overlaps(box, selection), JSON.stringify(selection)).toBe(false);
    }
    expect(hidden).toBeGreaterThan(0);
    // A selection whose box fills the view leaves no place clear of that box, so without its exact geometry the row has no room.
    expect(placeCadSketchSelectionActions({ left: 0, top: 0, right: 800, bottom: 600 }, size, viewport)).toBeNull();
  });

  it('sits inside the selection box where the exact selected geometry leaves room, and has no room where it covers that geometry everywhere', () => {
    const viewport = { width: 800, height: 600 }, size = { width: 160, height: 28 }, selection = { left: 0, top: 0, right: 800, bottom: 600 };
    // A circle around the view: its box covers every place, but only a band near the rim touches the circle itself.
    const ring = (box: { left: number; top: number; right: number; bottom: number }) => [[box.left, box.top], [box.right, box.top], [box.left, box.bottom], [box.right, box.bottom]]
      .some(([x, y]) => Math.hypot(x - 400, y - 300) > 280) && [[box.left, box.top], [box.right, box.bottom]].some(([x, y]) => Math.hypot(x - 400, y - 300) < 320);
    const box = placeCadSketchSelectionActions(selection, size, viewport, [], ring);
    expect(box).not.toBeNull(); expect(ring(box!)).toBe(false);
    // A place clear of a label still wins among the places the geometry leaves.
    expect(placeCadSketchSelectionActions(selection, size, viewport, [{ left: 0, top: 0, right: 400, bottom: 600 }], ring)?.left).toBeGreaterThanOrEqual(400);
    expect(placeCadSketchSelectionActions(selection, size, viewport, [], () => true)).toBeNull();
  });

  it('keeps clear of the dimension labels, marks and panels it is given where it can, and of the selection always', () => {
    const viewport = { width: 800, height: 600 }, size = { width: 160, height: 28 }, selection = { left: 300, top: 50, right: 400, bottom: 80 };
    // A label under the selection's middle: the row leaves every place below for the one beside the selection.
    expect(placeCadSketchSelectionActions(selection, size, viewport, [{ left: 330, top: 95, right: 370, bottom: 110 }])).toEqual({ left: 410, top: 51, right: 570, bottom: 79 });
    // A label under the middle of a wide selection: the row moves to its start, still below it.
    expect(placeCadSketchSelectionActions({ left: 100, top: 50, right: 700, bottom: 80 }, size, viewport, [{ left: 380, top: 95, right: 420, bottom: 110 }]))
      .toEqual({ left: 100, top: 90, right: 260, bottom: 118 });
    // Nowhere clear of them: the selection alone decides.
    expect(placeCadSketchSelectionActions(selection, size, viewport, [{ left: 0, top: 0, right: 800, bottom: 600 }])).toEqual(placeCadSketchSelectionActions(selection, size, viewport));
    // With nothing but the origin or an axis selected, the row takes a free corner.
    expect(placeCadSketchSelectionActions(null, size, viewport, [{ left: 0, top: 0, right: 400, bottom: 300 }])).toEqual({ left: 632, top: 48, right: 792, bottom: 76 });
  });

  const prepared = { points: [], geometry: { segments: [] }, pickBox: () => [] } as never;
  function mountRow(model: CadSketchSelectionActionsModel, extra: { prepared?: never; onRoomChange?: (room: boolean) => void } = {}) {
    // Escape hands focus to the canvas, here a stand-in beside the row.
    const canvas = document.body.appendChild(document.createElement('button')), onEscape = vi.fn(() => canvas.focus());
    onTestFinished(() => canvas.remove());
    const render = (next: CadSketchSelectionActionsModel, busy = false) => act(async () => root.render(<CadSketchSelectionActions model={next} prepared={extra.prepared ?? prepared} center={[0, 0]}
      width={100} span={100} pixelWidth={800} pixelHeight={600} busy={busy} onEscape={onEscape} onRoomChange={extra.onRoomChange} />));
    return { onEscape, render, canvas };
  }

  it('presses offers through the model, shows applied ones pressed and blocked ones disabled, and moves focus with the arrows', async () => {
    const graph = plate(), selection = [{ kind: 'entity' as const, id: 'ab' }], offers = cadSketchRelationOffers(graph, selection);
    const onOffer = vi.fn(), onDimension = vi.fn();
    const model: CadSketchSelectionActionsModel = { graph, selection, offers, dimensionAvailable: true, disabled: false, onOffer, onDimension };
    const { onEscape, render } = mountRow(model);
    await render(model);
    const row = container.querySelector('[role="toolbar"]')!;
    expect(row.getAttribute('aria-label')).toBe('Relations for the selection');
    expect(buttons(row).map(button => [button.getAttribute('aria-label'), button.getAttribute('aria-pressed'), button.disabled])).toEqual([
      ['Horizontal', 'true', false], ['Vertical', 'false', true], ['Dimension the selection', null, false]]);
    expect(named('Vertical').dataset.state).toBe('blocked');
    await act(async () => named('Horizontal').click()); expect(onOffer).toHaveBeenCalledWith(offers.find(offer => offer.kind === 'horizontal'));
    await act(async () => named('Dimension the selection').click()); expect(onDimension).toHaveBeenCalledOnce();
    // One stop in the tab order; the arrows, Home and End move it, and Escape hands focus back to the canvas.
    expect(buttons(row).filter(button => button.tabIndex === 0)).toHaveLength(1);
    // Blocked Vertical cannot take focus, so the arrows step over it.
    await act(async () => named('Horizontal').focus()); await key(named('Horizontal'), 'ArrowRight');
    expect(document.activeElement).toBe(named('Dimension the selection'));
    await key(named('Dimension the selection'), 'ArrowLeft'); expect(document.activeElement).toBe(named('Horizontal'));
    await key(named('Horizontal'), 'End'); expect(document.activeElement).toBe(named('Dimension the selection'));
    await key(named('Dimension the selection'), 'ArrowRight'); expect(document.activeElement).toBe(named('Horizontal'));
    await key(named('Horizontal'), 'Escape'); expect(onEscape).toHaveBeenCalledOnce();
    // With the first button blocked, the tab stop starts on the first one that can be pressed.
    const vertical = cadSketchRelationOffers(graph, [{ kind: 'entity', id: 'bc' }]).map(offer => offer.kind === 'horizontal' ? { ...offer, state: 'blocked' as const, reason: 'No.' } : offer);
    await render({ ...model, offers: vertical, selection: [{ kind: 'entity', id: 'bc' }] });
    expect(buttons(row).filter(button => button.tabIndex === 0).map(button => button.getAttribute('aria-label'))).toEqual(['Vertical']);
  });

  it('keeps focus on the pressed button while its edit is pending, then on it, the nearest button that can be pressed, or the canvas', async () => {
    const graph = plate(), selection = [{ kind: 'point' as const, id: 'a' }, { kind: 'point' as const, id: 'c' }], offers = cadSketchRelationOffers(graph, selection);
    const onOffer = vi.fn();
    const model: CadSketchSelectionActionsModel = { graph, selection, offers, dimensionAvailable: true, disabled: false, onOffer, onDimension: vi.fn() };
    const { onEscape, render, canvas } = mountRow(model);
    await render(model);
    const row = container.querySelector<HTMLElement>('[role="toolbar"]')!, labels = () => buttons(row).map(button => button.getAttribute('aria-label'));
    expect(labels()).toEqual(expect.arrayContaining(['Vertical', 'Coincident', 'Fix']));
    await act(async () => { named('Vertical').focus(); named('Vertical').click(); }); expect(onOffer).toHaveBeenCalledOnce();
    // Pending: the row stays, every button inactive but focusable, and focus stays on Vertical; a press does nothing.
    await render({ ...model, disabled: true }, true);
    expect(document.activeElement).toBe(named('Vertical')); expect(row.getAttribute('aria-busy')).toBe('true');
    expect(buttons(row).map(button => button.getAttribute('aria-disabled'))).toEqual(buttons(row).map(() => 'true'));
    await act(async () => named('Coincident').click()); await act(async () => named('Dimension the selection').click());
    expect(onOffer).toHaveBeenCalledOnce(); expect(model.onDimension).not.toHaveBeenCalled();
    // Accepted: Vertical now shows applied, and keeps focus.
    const applied = offers.map(offer => offer.kind === 'vertical' ? { ...offer, state: 'applied' as const, relationIds: ['up'] } : offer);
    await render({ ...model, offers: applied });
    expect(document.activeElement).toBe(named('Vertical')); expect(named('Vertical').getAttribute('aria-pressed')).toBe('true'); expect(row.hasAttribute('aria-busy')).toBe(false);
    // An edit that takes Vertical away hands focus to the nearest button that can be pressed.
    const at = labels().indexOf('Vertical'), without = applied.filter(offer => offer.kind !== 'vertical');
    await render({ ...model, disabled: true }, true); await render({ ...model, offers: without });
    expect(labels()).not.toContain('Vertical'); expect(row.contains(document.activeElement)).toBe(true);
    expect(labels().indexOf(document.activeElement!.getAttribute('aria-label'))).toBe(Math.min(at, labels().length - 1));
    // One that leaves nothing to press hands focus to the canvas.
    await render({ ...model, offers: without.map(offer => ({ ...offer, state: 'blocked' as const, reason: 'No.' })), dimensionAvailable: false });
    expect(onEscape).toHaveBeenCalledOnce(); expect(document.activeElement).toBe(canvas);
    // The row going while it holds focus hands focus to the canvas too.
    await render(model); await act(async () => named('Fix').focus());
    await act(async () => root.render(<></>)); expect(onEscape).toHaveBeenCalledTimes(2);
  });

  it('hides, and says it has no room, when every place would cover the selected geometry, and hands focus to the canvas if it held it', async () => {
    const graph = plate(), selection = [{ kind: 'entity' as const, id: 'ab' }], offers = cadSketchRelationOffers(graph, selection), onRoomChange = vi.fn();
    const model: CadSketchSelectionActionsModel = { graph, selection, offers, dimensionAvailable: true, disabled: false, onOffer: vi.fn(), onDimension: vi.fn() };
    // A line across the whole view: its box and its exact geometry meet every place the row could take.
    const across = { points: [], geometry: { segments: [{ id: 'ab', bounds: { minX: -60, minY: -60, maxX: 60, maxY: 60 } }] }, pickBox: () => [{ kind: 'entity', id: 'ab' }] } as never;
    const clear = { points: [], geometry: { segments: [{ id: 'ab', bounds: { minX: -60, minY: -60, maxX: 60, maxY: 60 } }] }, pickBox: () => [] } as never;
    const row = () => container.querySelector<HTMLElement>('[role="toolbar"]')!;
    let h = mountRow(model, { prepared: clear, onRoomChange });
    await h.render(model);
    expect(row().hidden).toBe(false); expect(onRoomChange).toHaveBeenLastCalledWith(true);
    await act(async () => named('Horizontal').focus());
    h = mountRow(model, { prepared: across, onRoomChange });
    await h.render(model);
    expect(row().hidden).toBe(true); expect(onRoomChange).toHaveBeenLastCalledWith(false); expect(h.onEscape).toHaveBeenCalledOnce();
    // Unmounting says the row no longer needs room.
    await act(async () => root.render(<></>)); expect(onRoomChange).toHaveBeenLastCalledWith(true);
  });
});

describe('relations under the sketch in the feature tree', () => {
  const many = (count: number) => graphOf({
    points: Array.from({ length: count + 1 }, (_, index) => ({ id: `p${index}`, position: [index, 0] })),
    entities: Array.from({ length: count }, (_, index) => line(`l${index}`, `p${index}`, `p${index + 1}`)),
    relations: Array.from({ length: count }, (_, index) => ({ id: `h${index}`, kind: 'horizontal', pointIds: [`p${index}`, `p${index + 1}`] }))
  });
  const noIssues = (graph: CadSketchGraph) => cadSketchIssues({ sketchId: 'sketch', graph, version: 'v1' });
  function props(graph: CadSketchGraph, extra: Partial<CadSketchRelationListProps> = {}): CadSketchRelationListProps {
    return { graph, parameters: {}, issues: noIssues(graph), selectedIds: [], selection: [], onlySelection: false, onOnlySelection: vi.fn(), locked: false,
      onSelect: vi.fn(), onOpen: vi.fn(), onDelete: vi.fn(), onMenu: vi.fn(), expanded: true, onExpandedChange: vi.fn(), ...extra };
  }
  const rows = () => [...container.querySelectorAll<HTMLButtonElement>('[data-cad-sketch-relation-row]')];
  const row = (id: string) => { const found = container.querySelector<HTMLButtonElement>(`[data-cad-sketch-relation-row="${id}"]`); if (!found) throw new Error(`Row ${id} missing.`); return found; };
  /** jsdom lays nothing out, so the scroller reports the box the list sizes it to and keeps what it is scrolled to. */
  function scrollable() {
    const scroller = container.querySelector<HTMLElement>('.cad-sketch-relation-list-scroller')!; let top = 0;
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, get: () => top, set: value => { top = value; } });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => parseFloat(scroller.style.height) });
    return { scroller, scroll: (to: number) => act(async () => { top = to; scroller.dispatchEvent(new Event('scroll')); }) };
  }

  it('starts as one collapsed heading with the count, mounting no row, and opens and closes through it', async () => {
    const graph = many(300), base = props(graph, { expanded: false });
    await act(async () => root.render(<CadSketchRelationList {...base} />));
    const toggle = container.querySelector<HTMLButtonElement>('.cad-sketch-relation-list-toggle')!;
    expect([toggle.getAttribute('aria-expanded'), toggle.textContent]).toEqual(['false', 'Relations 300']);
    expect(rows()).toEqual([]); expect(container.querySelector('ul[aria-label="Sketch relations"]')).toBeNull(); expect(() => named('Only the selection')).toThrow();
    await act(async () => toggle.click()); expect(base.onExpandedChange).toHaveBeenCalledWith(true);
    await act(async () => root.render(<CadSketchRelationList {...base} expanded />));
    expect(toggle.getAttribute('aria-expanded')).toBe('true'); expect(toggle.getAttribute('aria-controls')).toBe(container.querySelector('.cad-sketch-relation-list-scroller')!.id);
    expect(rows().length).toBeGreaterThan(0);
    await act(async () => toggle.click()); expect(base.onExpandedChange).toHaveBeenLastCalledWith(false);
  });

  it('renders only the rows in view of 300 relations, and names each row once per accepted graph', async () => {
    const graph = many(300);
    await act(async () => root.render(<CadSketchRelationList {...props(graph)} />));
    expect(container.querySelector('small[aria-label="300 relations"]')).not.toBeNull();
    expect(rows().length).toBeLessThanOrEqual(20); expect(rows()[0].getAttribute('aria-label')).toBe('Horizontal relation 1 · Point 1 and Point 2');
    expect(container.querySelector('ul[aria-label="Sketch relations"]')?.getAttribute('style')).toContain(`height: ${300 * CAD_SKETCH_RELATION_ROW_HEIGHT}px`);
    expect(rows()[0].closest('li')?.getAttribute('aria-setsize')).toBe('300');
    const { scroll } = scrollable();
    await scroll(200 * CAD_SKETCH_RELATION_ROW_HEIGHT);
    expect(rows().length).toBeLessThanOrEqual(20); expect(() => row('h200')).not.toThrow(); expect(() => row('h0')).toThrow();
    expect(row('h200').closest('li')?.getAttribute('aria-posinset')).toBe('201');
    // Rows come from one index for each accepted graph: the same relation names the same row, and a new graph names it afresh.
    expect(cadSketchRelationRow(graph, graph.relations[5])).toBe(cadSketchRelationRow(graph, graph.relations[5]));
    const next = { ...graph, relations: [...graph.relations] };
    expect(cadSketchRelationRow(next, next.relations[5])).not.toBe(cadSketchRelationRow(graph, graph.relations[5]));
  });

  it('selects, opens, deletes and opens the menu of a row from the pointer and the keyboard, and does none of it while locked', async () => {
    const graph = many(30), base = props(graph);
    await act(async () => root.render(<CadSketchRelationList {...base} />));
    await act(async () => row('h2').click()); expect(base.onSelect).toHaveBeenLastCalledWith(graph.relations[2], false);
    await act(async () => row('h3').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))); expect(base.onSelect).toHaveBeenLastCalledWith(graph.relations[3], true);
    await act(async () => row('h3').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))); expect(base.onOpen).toHaveBeenLastCalledWith(graph.relations[3]);
    await key(row('h4'), 'Enter'); expect(base.onOpen).toHaveBeenLastCalledWith(graph.relations[4]);
    await key(row('h4'), 'Delete'); expect(base.onDelete).toHaveBeenLastCalledWith(graph.relations[4]);
    await key(row('h5'), 'Backspace'); expect(base.onDelete).toHaveBeenLastCalledWith(graph.relations[5]);
    await key(row('h6'), 'F10', { shiftKey: true }); expect(base.onMenu).toHaveBeenLastCalledWith(graph.relations[6], expect.objectContaining({ clientX: expect.any(Number) }));
    await act(async () => row('h7').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 6 })));
    expect(base.onMenu).toHaveBeenLastCalledWith(graph.relations[7], expect.objectContaining({ clientX: 5, clientY: 6 }));
    // The arrows move the one tab stop and focus along the list, scrolling as they go.
    scrollable();
    await act(async () => row('h0').focus()); expect(rows().filter(button => button.tabIndex === 0).map(button => button.dataset.cadSketchRelationRow)).toEqual(['h0']);
    await key(row('h0'), 'ArrowDown'); expect(document.activeElement).toBe(row('h1'));
    await key(row('h1'), 'End'); expect(document.activeElement).toBe(row('h29'));
    await key(row('h29'), 'Home'); expect(document.activeElement).toBe(row('h0'));
    const calls = [base.onSelect, base.onOpen, base.onDelete, base.onMenu].map(fn => vi.mocked(fn).mock.calls.length);
    // Locked, the rows stay focusable but inactive, so a row focused while its deletion is judged keeps focus.
    await act(async () => root.render(<CadSketchRelationList {...base} locked />));
    expect(document.activeElement).toBe(row('h0')); expect(rows().every(button => button.getAttribute('aria-disabled') === 'true' && !button.disabled)).toBe(true);
    await key(row('h1'), 'Delete'); await key(row('h1'), 'Enter'); await act(async () => row('h1').click());
    await act(async () => row('h1').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))); await key(row('h1'), 'F10', { shiftKey: true });
    expect([base.onSelect, base.onOpen, base.onDelete, base.onMenu].map(fn => vi.mocked(fn).mock.calls.length)).toEqual(calls);
  });

  it('moves focus and the tab stop to the nearest surviving row when the focused row is deleted, and to the heading when none is left', async () => {
    const graph = many(6), base = props(graph);
    await act(async () => root.render(<CadSketchRelationList {...base} />));
    scrollable();
    const without = (...ids: string[]) => ({ ...graph, relations: graph.relations.filter(relation => !ids.includes(relation.id)) });
    const stops = () => rows().filter(button => button.tabIndex === 0).map(button => button.dataset.cadSketchRelationRow);
    await act(async () => row('h2').focus());
    // Deleting h2 while it is focused: the row that takes its place, h3, takes focus and the one tab stop.
    await act(async () => root.render(<CadSketchRelationList {...base} graph={without('h2')} />));
    expect(document.activeElement).toBe(row('h3')); expect(stops()).toEqual(['h3']);
    // The last row deleted: the one before it.
    await act(async () => row('h5').focus());
    await act(async () => root.render(<CadSketchRelationList {...base} graph={without('h2', 'h5')} />));
    expect(document.activeElement).toBe(row('h4')); expect(stops()).toEqual(['h4']);
    // A focused row's relation deleted while focus is elsewhere moves only the tab stop.
    const outside = document.createElement('button'); document.body.append(outside);
    await act(async () => outside.focus());
    await act(async () => root.render(<CadSketchRelationList {...base} graph={without('h2', 'h4', 'h5')} />));
    expect(document.activeElement).toBe(outside); expect(stops()).toEqual(['h3']); outside.remove();
    // Every row gone: focus goes to the heading.
    await act(async () => row('h3').focus());
    await act(async () => root.render(<CadSketchRelationList {...base} graph={{ ...graph, relations: [] }} />));
    expect(document.activeElement).toBe(container.querySelector('.cad-sketch-relation-list-toggle'));
  });

  it('shows each row pressed with its mark, its value and its issue states, lights its geometry, and lists only the selection on request', async () => {
    const graph = graphOf({ points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [10, 0] }, { id: 'c', position: [10, 10] }], entities: [line('ab', 'a', 'b'), line('bc', 'b', 'c')],
      relations: [{ id: 'size', kind: 'distance', pointIds: ['a', 'b'], value: 'w' }, { id: 'up', kind: 'vertical', pointIds: ['b', 'c'] }, { id: 'tall', kind: 'distance', pointIds: ['b', 'c'], value: 10 }] }, { w: 10 });
    const issues = cadSketchIssues({ sketchId: 'sketch', graph, version: 'v1', analysis: { kind: 'rejected', reason: 'conflicting',
      diagnostics: { conflictingIds: ['up'], redundantIds: ['tall'], partiallyRedundantIds: [], issues: [] } } });
    const highlight = createCadSketchHighlightStore(), onOnlySelection = vi.fn();
    const base = props(graph, { parameters: { w: 10 }, issues, highlight, selectedIds: ['size'], onOnlySelection });
    await act(async () => root.render(<CadSketchRelationList {...base} />));
    expect(rows().map(button => [button.getAttribute('aria-label'), button.getAttribute('aria-pressed')])).toEqual([
      ['Distance relation 1 · Point 1 and Point 2 · 10 mm', 'true'], ['Vertical relation 2 · Point 2 and Point 3 · Conflict', 'false'],
      ['Distance relation 3 · Point 2 and Point 3 · 10 mm · Redundant', 'false']]);
    expect(row('up').classList.contains('has-issues')).toBe(true);
    await act(async () => row('up').focus());
    expect(highlight.getSnapshot()).toMatchObject({ kind: 'geometry', pointIds: ['b', 'c'], relationIds: ['up'] });
    await act(async () => row('up').blur()); expect(highlight.getSnapshot()).toBeNull();
    // With nothing selected the toggle is off and inactive, and pressing it does nothing; it stays focusable, so turning it off with nothing
    // selected keeps focus on it. With a selection it lists the relations on its points.
    expect([named('Only the selection').disabled, named('Only the selection').getAttribute('aria-disabled')]).toEqual([false, 'true']);
    await act(async () => named('Only the selection').click()); expect(onOnlySelection).not.toHaveBeenCalled();
    await act(async () => root.render(<CadSketchRelationList {...base} selection={[{ kind: 'point', id: 'c' }]} />));
    await act(async () => named('Only the selection').click()); expect(onOnlySelection).toHaveBeenCalledWith(true);
    await act(async () => root.render(<CadSketchRelationList {...base} selection={[{ kind: 'point', id: 'c' }]} onlySelection />));
    expect(rows().map(button => button.dataset.cadSketchRelationRow)).toEqual(['up', 'tall']); expect(named('Only the selection').getAttribute('aria-pressed')).toBe('true');
    await act(async () => root.render(<CadSketchRelationList {...base} selection={[{ kind: 'point', id: 'zz' }]} onlySelection />));
    expect(container.textContent).toContain('Nothing constrains the selection.');
  });

  it('keeps the focused row, and its focus, while the list scrolls it out of view, with the tab stop on the rows in view', async () => {
    const graph = many(120), base = props(graph);
    await act(async () => root.render(<CadSketchRelationList {...base} />));
    const { scroll } = scrollable();
    await act(async () => row('h1').focus());
    await scroll(80 * CAD_SKETCH_RELATION_ROW_HEIGHT);
    expect(document.activeElement).toBe(row('h1'));
    // The one tab stop is on a row in view, so Tab returns to the list where it is scrolled; the arrows still move on from the focused row.
    const stops = rows().filter(button => button.tabIndex === 0).map(button => Number(button.dataset.cadSketchRelationRow!.slice(1)));
    expect(stops).toHaveLength(1); expect(stops[0]).toBeGreaterThanOrEqual(70);
    await key(row('h1'), 'ArrowDown'); expect(document.activeElement).toBe(row('h2'));
  });

  it('scrolls a revealed relation into view once for each request', async () => {
    const graph = many(120), base = props(graph);
    await act(async () => root.render(<CadSketchRelationList {...base} />));
    const { scroller } = scrollable();
    await act(async () => root.render(<CadSketchRelationList {...base} reveal={{ relationId: 'h100', token: '1' }} />));
    expect(scroller.scrollTop).toBe(101 * CAD_SKETCH_RELATION_ROW_HEIGHT - parseFloat(scroller.style.height)); expect(() => row('h100')).not.toThrow();
    // The same request again does nothing after the list was scrolled away; a new one scrolls back.
    scroller.scrollTop = 0;
    await act(async () => root.render(<CadSketchRelationList {...base} reveal={{ relationId: 'h100', token: '1' }} />)); expect(scroller.scrollTop).toBe(0);
    await act(async () => root.render(<CadSketchRelationList {...base} reveal={{ relationId: 'h100', token: '2' }} />)); expect(scroller.scrollTop).toBeGreaterThan(0);
  });
});

describe('sketch context header', () => {
  const graph = () => graphOf({ points: [{ id: 'a', position: [0, 0] }, { id: 'b', position: [10, 0] }], entities: [line('ab', 'a', 'b')],
    relations: [{ id: 'level', kind: 'horizontal', pointIds: ['a', 'b'] }, { id: 'again', kind: 'horizontal', pointIds: ['b', 'a'] }] });
  const redundant = (source: CadSketchGraph): CadSketchIssues => cadSketchIssues({ sketchId: 'sketch', graph: source, version: 'v1', analysis: { kind: 'solved', reason: null,
    diagnostics: { conflictingIds: [], redundantIds: ['again'], partiallyRedundantIds: [], issues: [] } } });
  function mount(issues: CadSketchIssues, extra: { inspected?: string | null; locked?: boolean; repairsLocked?: boolean } = {}) {
    const handlers = { onInspectIssue: vi.fn(), onRepairIssue: vi.fn(), onShowDimensions: vi.fn(), onShowRelations: vi.fn() }, highlight = createCadSketchHighlightStore();
    const render = (next: CadSketchIssues, more = extra) => act(async () => root.render(<CadSketchContextHeader name="Sketch 1" status={<span>Fully defined</span>} issues={next}
      inspectedIssue={more.inspected ?? null} issuesLocked={more.locked ?? false} repairsLocked={more.repairsLocked ?? false} highlight={highlight} highlightOf={issue => ({ pointIds: issue.pointIds, entityIds: issue.entityIds })}
      dimensionsShown relationsShown={false} viewModes={<span data-testid="modes" />} actions={<button type="button" aria-label="Finish sketch">Finish</button>} {...handlers} />));
    return { handlers, highlight, render };
  }

  it('counts the issues, opens them as a list that lights and inspects each, and closes on Escape with focus back on the count', async () => {
    const source = graph(), issues = redundant(source), h = mount(issues);
    await h.render(issues);
    const header = container.querySelector('[data-cad-sketch-header]')!, count = container.querySelector<HTMLButtonElement>('[data-cad-sketch-issues]')!;
    expect(header.getAttribute('role')).toBe('group'); expect(header.getAttribute('aria-label')).toBe('Sketch editing');
    expect(header.textContent).toContain('Sketch 1'); expect(header.textContent).toContain('Fully defined');
    expect([count.getAttribute('aria-label'), count.dataset.cadSketchIssues, count.getAttribute('aria-expanded')]).toEqual(['1 constraint issue', '1', 'false']);
    // The view toggles, the view-modes slot and Finish keep their places.
    expect(named('Show dimensions').getAttribute('aria-pressed')).toBe('true'); expect(named('Show relations').getAttribute('aria-pressed')).toBe('false');
    await act(async () => named('Show relations').click()); expect(h.handlers.onShowRelations).toHaveBeenCalledWith(true);
    expect(header.querySelector('[data-cad-sketch-view-modes] [data-testid="modes"]')).not.toBeNull(); expect(header.querySelector('[aria-label="Finish sketch"]')).not.toBeNull();
    await act(async () => count.click());
    const item = container.querySelector<HTMLButtonElement>('ul[aria-label="Constraint issues"] > li > button')!;
    expect(item.textContent).toBe('Horizontal relation 2 · Point 2 and Point 1Redundant'); expect(count.getAttribute('aria-expanded')).toBe('true');
    await act(async () => item.focus()); expect(h.highlight.getSnapshot()).toMatchObject({ kind: 'geometry', pointIds: ['b', 'a'] });
    await act(async () => item.click()); expect(h.handlers.onInspectIssue).toHaveBeenCalledWith(issues.list[0]);
    await key(item, 'Escape');
    expect(container.querySelector('ul[aria-label="Constraint issues"]')).toBeNull(); expect(document.activeElement).toBe(count); expect(h.highlight.getSnapshot()).toBeNull();
  });

  it('offers each issue\'s repairs beside its row, and keeps them unavailable while an edit is pending', async () => {
    const source = graph(), issues = redundant(source), h = mount(issues);
    await h.render(issues);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-cad-sketch-issues]')!.click());
    const repair = () => container.querySelector<HTMLButtonElement>('ul[aria-label="Constraint issues"] [data-cad-issue-repair]')!;
    expect([repair().textContent, repair().getAttribute('aria-label'), repair().dataset.cadIssueRepair, repair().disabled])
      .toEqual(['Delete relation', 'Delete relation: Horizontal relation 2 · Point 2 and Point 1', 'delete-relation:again', false]);
    // Hovering the repair lights what it removes, as its row does.
    await act(async () => repair().focus()); expect(h.highlight.getSnapshot()).toMatchObject({ kind: 'geometry', pointIds: ['b', 'a'] });
    await act(async () => repair().click());
    expect(h.handlers.onRepairIssue).toHaveBeenCalledExactlyOnceWith(issues.list[0].issue.repairs[0]); expect(h.handlers.onInspectIssue).not.toHaveBeenCalled();
    await h.render(issues, { repairsLocked: true });
    expect(repair().disabled).toBe(true);
  });

  it('closes the list and drops a lit row when the issues go, and counts what a refusal left out', async () => {
    const source = graph(), issues = redundant(source), h = mount(issues);
    await h.render(issues);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-cad-sketch-issues]')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('ul[aria-label="Constraint issues"] button')!.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })));
    await act(async () => container.querySelector<HTMLButtonElement>('ul[aria-label="Constraint issues"] button')!.focus());
    expect(h.highlight.getSnapshot()).not.toBeNull();
    const none = cadSketchIssues({ sketchId: 'sketch', graph: source, version: 'v1' });
    await h.render(none);
    const count = container.querySelector<HTMLButtonElement>('[data-cad-sketch-issues]')!;
    expect([count.getAttribute('aria-label'), count.disabled]).toEqual(['No constraint issues', true]);
    expect(container.querySelector('ul[aria-label="Constraint issues"]')).toBeNull(); expect(h.highlight.getSnapshot()).toBeNull();
    await h.render({ ...issues, omitted: 4 });
    expect(count.getAttribute('aria-label')).toBe('5 constraint issues');
    await act(async () => count.click());
    expect(container.querySelector('.cad-sketch-header-issue-more')?.textContent).toBe('4 more affected items');
    // A pending edit of another sketch keeps each issue from opening on the canvas.
    await h.render({ ...issues, omitted: 4 }, { locked: true });
    expect(container.querySelector<HTMLButtonElement>('ul[aria-label="Constraint issues"] button')!.disabled).toBe(true);
  });

  it('counts a refusal that names no item, as a solver that failed gives, as one issue whose list shows its message', async () => {
    const source = graph(), unjudged = { status: null, degreesOfFreedom: null, conflictingIds: [], redundantIds: [], partiallyRedundantIds: [], issues: [] };
    const failure = new CadSketchPreparationError({ sketchId: 'sketch', sketchName: 'Sketch 1', graph: source, unavailable: { kernelMessage: 'Uncaught RangeError: out of memory' },
      rejection: { kind: 'rejected', reason: 'failed', message: CAD_SKETCH_SOLVER_STOPPED, diagnostics: unjudged } });
    const issues = cadSketchIssues({ sketchId: 'sketch', graph: source, version: 'v1', feedback: failure.feedback }), h = mount(issues);
    await h.render(issues);
    const count = container.querySelector<HTMLButtonElement>('[data-cad-sketch-issues]')!;
    expect([count.getAttribute('aria-label'), count.disabled]).toEqual(['1 constraint issue', false]);
    await act(async () => count.click());
    expect(container.querySelector('.cad-sketch-header-issue-message')?.textContent).toBe(`Sketch 1: ${CAD_SKETCH_SOLVER_STOPPED}`);
    expect(container.querySelectorAll('ul[aria-label="Constraint issues"] > li')).toHaveLength(0);
    // The header shows the message only: the solver's own words stay for agents.
    expect(container.querySelector('[data-cad-sketch-header]')!.textContent).not.toContain('out of memory');
  });

  it('keeps focus as an edit fixes the issues: on the row taking the fixed one\'s place, then the count, then the sketch canvas', async () => {
    const source = graph(), both = cadSketchIssues({ sketchId: 'sketch', graph: source, version: 'v1', analysis: { kind: 'rejected', reason: 'conflicting',
      diagnostics: { conflictingIds: ['level'], redundantIds: ['again'], partiallyRedundantIds: [], issues: [] } } });
    const one = { ...both, list: both.list.slice(0, 1) }, none = cadSketchIssues({ sketchId: 'sketch', graph: source, version: 'v1' });
    const render = (issues: CadSketchIssues, locked = false) => act(async () => root.render(<div className="cad-workbench">
      <svg className="cad-sketch-canvas" tabIndex={0} aria-label="Sketch drawing canvas" />
      <CadSketchContextHeader name="Sketch 1" status={null} issues={issues} inspectedIssue={null} issuesLocked={locked} repairsLocked={locked} onRepairIssue={vi.fn()} highlightOf={issue => ({ pointIds: issue.pointIds, entityIds: issue.entityIds })}
        onInspectIssue={vi.fn()} dimensionsShown relationsShown={false} onShowDimensions={vi.fn()} onShowRelations={vi.fn()} actions={null} />
    </div>));
    const count = () => container.querySelector<HTMLButtonElement>('[data-cad-sketch-issues]')!, items = () => [...container.querySelectorAll<HTMLButtonElement>('ul[aria-label="Constraint issues"] button[data-cad-issue-row]')];
    const canvas = () => container.querySelector('svg.cad-sketch-canvas');
    await render(both); expect(both.list).toHaveLength(2);
    await act(async () => count().click()); await act(async () => items()[1]!.focus());
    // The focused row's issue fixed, as by Undo from the row: the row now in its place, or the one before it, takes focus.
    await render(one); expect(document.activeElement).toBe(items()[0]);
    // The rows inactive while an edit applies: the count. The last issue fixed closes the list and disables the count: the canvas.
    await render(one, true); expect(document.activeElement).toBe(count());
    await render(none); expect([count().disabled, document.activeElement]).toEqual([true, canvas()]);
    // The count itself disabled while it holds focus: the canvas too.
    await render(one); await act(async () => count().focus());
    await render(none); expect(document.activeElement).toBe(canvas());
    // Focus the user moved elsewhere stays there.
    await render(both); await act(async () => count().click()); await act(async () => items()[0]!.focus());
    const outside = document.createElement('button'); document.body.append(outside);
    await act(async () => outside.focus()); await render(none);
    expect(document.activeElement).toBe(outside); outside.remove();
    // A repair holding focus holds its row's place: its issue fixed, the row now in that place takes focus.
    await render(both); await act(async () => count().click());
    await act(async () => container.querySelectorAll<HTMLButtonElement>('[data-cad-issue-repair]')[1]!.focus());
    await render(one); expect(document.activeElement).toBe(items()[0]);
  });
});
