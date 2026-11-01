import type { CadSketchPlane } from '@/domain/cad/cadDocument';
import { CAD_DEFAULT_SELECTION_FILTER, parseCadSelectionFilter, sameCadSelectionFilter, setCadSelectionKind, type CadSelectionFilter, type CadSelectionKind } from '@/domain/cad/selection/cadSelectionFilter';

/**
 * What the CAD view shows around the geometry being edited. It is display state: it lives with the device preferences, never in a
 * CAD document, and changing it rebuilds nothing. The sketch context and its remembered choices sit beside the part view's own
 * choices: the section view, the reference geometry shown and the selection filter.
 */
export type CadSketchBackground = 'normal' | 'dimmed' | 'hidden';
/** Where picks land while a sketch is open. Only the open sketch for now; picking other geometry arrives with projections. */
export type CadSketchPickScope = 'sketch';
/** The sketch view choices a user makes, which every sketch opened later starts with. */
export interface CadSketchViewChoices { readonly background: CadSketchBackground; readonly cutBySketchPlane: boolean }
export type CadViewContext = { readonly kind: 'part' } | {
  readonly kind: 'sketch';
  readonly featureId: string;
  readonly background: CadSketchBackground;
  readonly cutBySketchPlane: boolean;
  readonly pickScope: CadSketchPickScope;
};
export interface CadViewState {
  readonly context: CadViewContext;
  /** The last sketch view choices, kept while no sketch is open so the next one starts with them. */
  readonly remembered: CadSketchViewChoices;
}
export type CadViewAction =
  | { readonly kind: 'enter-sketch'; readonly featureId: string }
  | { readonly kind: 'leave-sketch' }
  | { readonly kind: 'set-sketch-background'; readonly background: CadSketchBackground }
  | { readonly kind: 'set-cut-by-sketch-plane'; readonly cut: boolean };

/** A new sketch shows the part dimmed behind it, uncut, and picks only in itself. */
export const CAD_DEFAULT_SKETCH_VIEW: CadSketchViewChoices = Object.freeze({ background: 'dimmed', cutBySketchPlane: false });
export const CAD_SKETCH_BACKGROUNDS: readonly CadSketchBackground[] = Object.freeze(['normal', 'dimmed', 'hidden']);
const PART_CONTEXT: CadViewContext = Object.freeze({ kind: 'part' });

export function createCadViewState(remembered: CadSketchViewChoices = CAD_DEFAULT_SKETCH_VIEW): CadViewState {
  return Object.freeze({ context: PART_CONTEXT, remembered });
}

function sketchContext(featureId: string, choices: CadSketchViewChoices): CadViewContext {
  return Object.freeze({ kind: 'sketch', featureId, background: choices.background, cutBySketchPlane: choices.cutBySketchPlane, pickScope: 'sketch' });
}

/** Changing a choice outside a sketch does nothing; a choice made inside one is remembered for the next. */
export function reduceCadViewState(state: CadViewState, action: CadViewAction): CadViewState {
  const { context } = state;
  switch (action.kind) {
    case 'enter-sketch':
      return context.kind === 'sketch' && context.featureId === action.featureId ? state : Object.freeze({ ...state, context: sketchContext(action.featureId, state.remembered) });
    case 'leave-sketch':
      return context.kind === 'part' ? state : Object.freeze({ ...state, context: PART_CONTEXT });
    case 'set-sketch-background': {
      if (context.kind !== 'sketch' || context.background === action.background || !CAD_SKETCH_BACKGROUNDS.includes(action.background)) return state;
      const remembered = Object.freeze({ ...state.remembered, background: action.background });
      return Object.freeze({ context: sketchContext(context.featureId, { background: action.background, cutBySketchPlane: context.cutBySketchPlane }), remembered });
    }
    case 'set-cut-by-sketch-plane': {
      if (context.kind !== 'sketch' || context.cutBySketchPlane === action.cut) return state;
      const remembered = Object.freeze({ ...state.remembered, cutBySketchPlane: action.cut });
      return Object.freeze({ context: sketchContext(context.featureId, { background: context.background, cutBySketchPlane: action.cut }), remembered });
    }
  }
}

/** The state the workbench shows: the open sketch, if any, with the remembered choices. */
export function cadViewStateFor(sketchId: string | null, remembered: CadSketchViewChoices): CadViewState {
  const state = createCadViewState(remembered);
  return sketchId === null ? state : reduceCadViewState(state, { kind: 'enter-sketch', featureId: sketchId });
}

/** Stored choices from a preference record; anything missing or unsupported falls back to the default for that choice alone. */
export function parseCadSketchViewChoices(value: unknown): CadSketchViewChoices | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const background = 'background' in value && CAD_SKETCH_BACKGROUNDS.includes(value.background as CadSketchBackground) ? value.background as CadSketchBackground : undefined;
  const cut = 'cutBySketchPlane' in value && typeof value.cutBySketchPlane === 'boolean' ? value.cutBySketchPlane : undefined;
  if (background === undefined && cut === undefined) return undefined;
  return Object.freeze({ background: background ?? CAD_DEFAULT_SKETCH_VIEW.background, cutBySketchPlane: cut ?? CAD_DEFAULT_SKETCH_VIEW.cutBySketchPlane });
}

/** The plane a section view cuts by: an origin plane or a datum plane. Planar faces wait for document references, so the type stays open. */
export type CadSectionPlane = CadSketchPlane;
/** A visual cut of the part view. `flip` keeps the other side; `caps` closes the cut solids with a flat colour. Nothing here is exact geometry. */
export interface CadSectionView { readonly plane: CadSectionPlane; readonly flip: boolean; readonly caps: boolean }
/** The part view's own choices, kept on this device and never in a document. */
export interface CadPartView {
  readonly section: CadSectionView | null;
  readonly showReferenceGeometry: boolean;
  readonly selectionFilter: CadSelectionFilter;
}
export type CadPartViewAction =
  | { readonly kind: 'set-section'; readonly plane: CadSectionPlane; readonly flip?: boolean; readonly caps?: boolean }
  | { readonly kind: 'clear-section' }
  | { readonly kind: 'set-section-flip'; readonly flip: boolean }
  | { readonly kind: 'set-section-caps'; readonly caps: boolean }
  | { readonly kind: 'set-reference-geometry'; readonly shown: boolean }
  | { readonly kind: 'set-selection-kind'; readonly selection: CadSelectionKind; readonly accepted: boolean }
  | { readonly kind: 'set-selection-filter'; readonly filter: CadSelectionFilter };

/** The section record's version in the device preferences. A record of any other version is ignored, and reading never rewrites it. */
export const CAD_SECTION_VIEW_VERSION = 1;
/** A stored section. It names the document it was made in, since a datum plane's ID means nothing in another document. */
export interface CadStoredSectionView extends CadSectionView { readonly version: typeof CAD_SECTION_VIEW_VERSION; readonly documentId: string }
/** No section, the origin planes, axes and point shown, and every kind selectable. */
export const CAD_DEFAULT_PART_VIEW: CadPartView = Object.freeze({ section: null, showReferenceGeometry: true, selectionFilter: CAD_DEFAULT_SELECTION_FILTER });

const samePlane = (a: CadSectionPlane, b: CadSectionPlane) => a === b || typeof a === 'object' && typeof b === 'object' && a.featureId === b.featureId;
export const isCadSectionPlane = (value: unknown): value is CadSectionPlane => value === 'XY' || value === 'XZ' || value === 'YZ'
  || Boolean(value) && typeof value === 'object' && (value as { kind?: unknown }).kind === 'datum-plane'
    && typeof (value as { featureId?: unknown }).featureId === 'string' && (value as { featureId: string }).featureId.length > 0;
const section = (plane: CadSectionPlane, flip: boolean, caps: boolean): CadSectionView =>
  Object.freeze({ plane: typeof plane === 'string' ? plane : Object.freeze({ kind: 'datum-plane', featureId: plane.featureId }), flip, caps });

/** A new section removes the side the plane normal points to and shows caps unless told otherwise; a choice with no section does nothing. */
export function reduceCadPartView(view: CadPartView, action: CadPartViewAction): CadPartView {
  const current = view.section;
  switch (action.kind) {
    case 'set-section': {
      if (!isCadSectionPlane(action.plane)) return view;
      const flip = action.flip ?? false, caps = action.caps ?? true;
      if (current && samePlane(current.plane, action.plane) && current.flip === flip && current.caps === caps) return view;
      return Object.freeze({ ...view, section: section(action.plane, flip, caps) });
    }
    case 'clear-section':
      return current ? Object.freeze({ ...view, section: null }) : view;
    case 'set-section-flip':
      return !current || current.flip === action.flip ? view : Object.freeze({ ...view, section: section(current.plane, action.flip, current.caps) });
    case 'set-section-caps':
      return !current || current.caps === action.caps ? view : Object.freeze({ ...view, section: section(current.plane, current.flip, action.caps) });
    case 'set-reference-geometry':
      return view.showReferenceGeometry === action.shown ? view : Object.freeze({ ...view, showReferenceGeometry: action.shown });
    case 'set-selection-kind': {
      const selectionFilter = setCadSelectionKind(view.selectionFilter, action.selection, action.accepted);
      return selectionFilter === view.selectionFilter ? view : Object.freeze({ ...view, selectionFilter });
    }
    case 'set-selection-filter': {
      const selectionFilter = parseCadSelectionFilter(action.filter) ?? view.selectionFilter;
      return sameCadSelectionFilter(selectionFilter, view.selectionFilter) ? view : Object.freeze({ ...view, selectionFilter });
    }
  }
}

/**
 * The section the model view draws. An open sketch's own cut takes its place: no section shows while a sketch is open, and the same
 * section returns when the sketch closes, since opening and closing a sketch never changes the part view.
 */
export function cadShownSection(state: CadViewState, part: CadPartView): CadSectionView | null {
  return state.context.kind === 'sketch' ? null : part.section;
}

/** The record a section is stored as, for the document it belongs to. */
export function cadStoredSectionView(view: CadSectionView, documentId: string): CadStoredSectionView {
  return Object.freeze({ version: CAD_SECTION_VIEW_VERSION, documentId, plane: view.plane, flip: view.flip, caps: view.caps });
}

/** A stored section of this version with every field readable, or `undefined`. */
export function parseCadStoredSectionView(value: unknown): CadStoredSectionView | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== CAD_SECTION_VIEW_VERSION || typeof record.documentId !== 'string' || !record.documentId || !isCadSectionPlane(record.plane)
    || typeof record.flip !== 'boolean' || typeof record.caps !== 'boolean') return undefined;
  return cadStoredSectionView(section(record.plane, record.flip, record.caps), record.documentId);
}

/** The part view of one document from the stored choices. A section stored for another document is not shown here. */
export function cadPartViewFor(documentId: string, stored: { readonly section?: CadStoredSectionView; readonly showReferenceGeometry?: boolean; readonly selectionFilter?: CadSelectionFilter }): CadPartView {
  const shown = stored.section && stored.section.documentId === documentId ? section(stored.section.plane, stored.section.flip, stored.section.caps) : null;
  if (!shown && stored.showReferenceGeometry === undefined && !stored.selectionFilter) return CAD_DEFAULT_PART_VIEW;
  return Object.freeze({ section: shown, showReferenceGeometry: stored.showReferenceGeometry ?? true, selectionFilter: stored.selectionFilter ?? CAD_DEFAULT_SELECTION_FILTER });
}
