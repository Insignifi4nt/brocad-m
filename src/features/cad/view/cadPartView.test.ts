import { describe, expect, it } from 'vitest';
import {
  CAD_DEFAULT_PART_VIEW, CAD_SECTION_VIEW_VERSION, cadPartViewFor, cadShownSection, cadStoredSectionView, cadViewStateFor, parseCadStoredSectionView, reduceCadPartView
} from './cadViewState';
import { CAD_DEFAULT_SELECTION_FILTER, CAD_SELECTION_KINDS, cadSelectionAccepts, parseCadSelectionFilter, setCadSelectionKind } from '@/domain/cad/selection/cadSelectionFilter';

const datum = { kind: 'datum-plane', featureId: 'mount' } as const;

describe('part view section', () => {
  it('turns on with caps and the normal side removed, flips, drops caps and turns off; a choice that changes nothing returns the same view', () => {
    const on = reduceCadPartView(CAD_DEFAULT_PART_VIEW, { kind: 'set-section', plane: 'XZ' });
    expect(on.section).toEqual({ plane: 'XZ', flip: false, caps: true });
    expect(reduceCadPartView(on, { kind: 'set-section', plane: 'XZ' })).toBe(on);
    const flipped = reduceCadPartView(on, { kind: 'set-section-flip', flip: true });
    expect(flipped.section).toEqual({ plane: 'XZ', flip: true, caps: true });
    const bare = reduceCadPartView(flipped, { kind: 'set-section-caps', caps: false });
    expect(bare.section).toEqual({ plane: 'XZ', flip: true, caps: false });
    // A new plane starts unflipped and capped, unless told otherwise.
    expect(reduceCadPartView(bare, { kind: 'set-section', plane: datum }).section).toEqual({ plane: datum, flip: false, caps: true });
    expect(reduceCadPartView(bare, { kind: 'set-section', plane: datum, flip: true, caps: false }).section).toEqual({ plane: datum, flip: true, caps: false });
    const off = reduceCadPartView(bare, { kind: 'clear-section' });
    expect(off.section).toBeNull();
    for (const action of [{ kind: 'clear-section' }, { kind: 'set-section-flip', flip: true }, { kind: 'set-section-caps', caps: false }] as const) expect(reduceCadPartView(off, action)).toBe(off);
    expect(Object.isFrozen(on) && Object.isFrozen(on.section)).toBe(true);
  });

  it('refuses a plane that is not an origin plane or a named datum plane', () => {
    for (const plane of ['XYZ', { kind: 'datum-plane', featureId: '' }, { kind: 'face', featureId: 'f' }, null]) {
      expect(reduceCadPartView(CAD_DEFAULT_PART_VIEW, { kind: 'set-section', plane: plane as never })).toBe(CAD_DEFAULT_PART_VIEW);
    }
  });

  it('is replaced by an open sketch’s own view and returns unchanged when the sketch closes', () => {
    const part = reduceCadPartView(CAD_DEFAULT_PART_VIEW, { kind: 'set-section', plane: 'YZ' });
    const remembered = { background: 'dimmed', cutBySketchPlane: true } as const;
    expect(cadShownSection(cadViewStateFor('sketch', remembered), part)).toBeNull();
    expect(cadShownSection(cadViewStateFor(null, remembered), part)).toBe(part.section);
  });

  it('stores a versioned record for its document and reads back only a complete record of this version', () => {
    const view = reduceCadPartView(CAD_DEFAULT_PART_VIEW, { kind: 'set-section', plane: datum, flip: true }).section!;
    const stored = cadStoredSectionView(view, 'part-1');
    expect(stored).toEqual({ version: CAD_SECTION_VIEW_VERSION, documentId: 'part-1', plane: datum, flip: true, caps: true });
    const raw = JSON.parse(JSON.stringify(stored));
    expect(parseCadStoredSectionView(raw)).toEqual(stored);
    for (const broken of [{ ...raw, version: 2 }, { ...raw, version: undefined }, { ...raw, documentId: '' }, { ...raw, flip: 'yes' }, { ...raw, caps: undefined },
      { ...raw, plane: { kind: 'datum-plane' } }, { ...raw, plane: 'XX' }, null, 'section', []]) expect(parseCadStoredSectionView(broken)).toBeUndefined();
  });

  it('shows a stored section only in the document it was made in, and keeps the defaults when nothing is stored', () => {
    const section = cadStoredSectionView({ plane: 'XY', flip: false, caps: false }, 'part-1');
    expect(cadPartViewFor('part-1', { section }).section).toEqual({ plane: 'XY', flip: false, caps: false });
    expect(cadPartViewFor('part-2', { section })).toBe(CAD_DEFAULT_PART_VIEW);
    expect(cadPartViewFor('part-2', {})).toBe(CAD_DEFAULT_PART_VIEW);
    expect(cadPartViewFor('part-2', { section, showReferenceGeometry: false })).toEqual({ section: null, showReferenceGeometry: false, selectionFilter: CAD_DEFAULT_SELECTION_FILTER });
  });
});

describe('selection filter', () => {
  it('accepts every kind by default, excludes and restores one kind at a time, and returns the same filter for a choice already made', () => {
    for (const kind of CAD_SELECTION_KINDS) expect(cadSelectionAccepts(CAD_DEFAULT_SELECTION_FILTER, kind)).toBe(true);
    const noBodies = setCadSelectionKind(CAD_DEFAULT_SELECTION_FILTER, 'body', false);
    expect(cadSelectionAccepts(noBodies, 'body')).toBe(false);
    expect(CAD_SELECTION_KINDS.filter(kind => kind !== 'body').every(kind => cadSelectionAccepts(noBodies, kind))).toBe(true);
    expect(setCadSelectionKind(noBodies, 'body', false)).toBe(noBodies);
    const noPlanes = setCadSelectionKind(noBodies, 'plane', false);
    expect(noPlanes.excluded).toEqual(['body', 'plane']);
    expect(setCadSelectionKind(noPlanes, 'body', true).excluded).toEqual(['plane']);
  });

  it('reads a stored filter, drops kinds it does not know so they stay selectable, and refuses anything else', () => {
    expect(parseCadSelectionFilter({ excluded: ['edge', 'curvature', 'edge'] })).toEqual({ excluded: ['edge'] });
    expect(parseCadSelectionFilter({ excluded: [1, 'later'] })).toBe(CAD_DEFAULT_SELECTION_FILTER);
    for (const broken of [null, {}, { excluded: 'edge' }, ['edge']]) expect(parseCadSelectionFilter(broken)).toBeUndefined();
  });

  it('is part of the part view and changes nothing when the kind is already in that state', () => {
    const view = reduceCadPartView(CAD_DEFAULT_PART_VIEW, { kind: 'set-selection-kind', selection: 'axis', accepted: false });
    expect(cadSelectionAccepts(view.selectionFilter, 'axis')).toBe(false);
    expect(reduceCadPartView(view, { kind: 'set-selection-kind', selection: 'axis', accepted: false })).toBe(view);
    expect(reduceCadPartView(view, { kind: 'set-reference-geometry', shown: true })).toBe(view);
    expect(reduceCadPartView(view, { kind: 'set-reference-geometry', shown: false }).showReferenceGeometry).toBe(false);
  });
});
