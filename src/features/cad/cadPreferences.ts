import { useSyncExternalStore } from 'react';
import { CAD_DEFAULT_SKETCH_VIEW, cadPartViewFor, parseCadSketchViewChoices, parseCadStoredSectionView, type CadPartView, type CadSketchViewChoices,
  type CadStoredSectionView } from './view/cadViewState';
import { parseCadSelectionFilter, type CadSelectionFilter } from '@/domain/cad/selection/cadSelectionFilter';

export type CadNavigationMode = 'mouse' | 'trackpad';
export interface CadPreferences { readonly navigationMode: CadNavigationMode; readonly showOnPartDimensions: boolean; readonly showDepthHandles?: boolean; readonly showRelations?: boolean;
  /** The 3D background and cut a sketch opens with: the last choice made in a sketch. */
  readonly sketchView?: CadSketchViewChoices;
  /** The section view of the part, for the document it was made in; versioned, see `CAD_SECTION_VIEW_VERSION`. */
  readonly section?: CadStoredSectionView;
  /** Origin planes, axes and point, and datum planes, in the model view; shown unless turned off. */
  readonly showReferenceGeometry?: boolean;
  /** The kinds of geometry turned off for picking in the model view. */
  readonly selectionFilter?: CadSelectionFilter }
export const CAD_PREFERENCES_KEY = 'wire-edm:cad-preferences:v1';
/** Depth handles are on unless the device explicitly turned them off; stored bytes are never rewritten. */
export const cadDepthHandlesShown = (preferences: CadPreferences) => preferences.showDepthHandles !== false;
/** Relation glyphs on the sketch canvas are on unless the device explicitly turned them off. */
export const cadRelationsShown = (preferences: CadPreferences) => preferences.showRelations !== false;
/** The sketch view choices remembered on this device, or the defaults: the part dimmed and uncut. */
export const cadSketchViewChoices = (preferences: CadPreferences): CadSketchViewChoices => preferences.sketchView ?? CAD_DEFAULT_SKETCH_VIEW;
/** The part view choices of one document on this device. */
export const cadPartViewChoices = (preferences: CadPreferences, documentId: string): CadPartView => cadPartViewFor(documentId, preferences);
const defaults: CadPreferences = Object.freeze({ navigationMode: 'mouse', showOnPartDimensions: true });
let current = defaults;
let lastRaw: string | null | undefined;
const listeners = new Set<() => void>();

function stored(): string | null | undefined {
  try { return localStorage.getItem(CAD_PREFERENCES_KEY); } catch { return undefined; }
}
function parse(raw: string | null): CadPreferences {
  if (!raw) return defaults;
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && 'navigationMode' in value && 'showOnPartDimensions' in value
      && (value.navigationMode === 'mouse' || value.navigationMode === 'trackpad') && typeof value.showOnPartDimensions === 'boolean'
      && (!('showDepthHandles' in value) || typeof value.showDepthHandles === 'boolean') && (!('showRelations' in value) || typeof value.showRelations === 'boolean')) {
      // A sketch view this build cannot read leaves the other preferences in force and the stored bytes as they are.
      const sketchView = 'sketchView' in value ? parseCadSketchViewChoices(value.sketchView) : undefined;
      const section = 'section' in value ? parseCadStoredSectionView(value.section) : undefined;
      const selectionFilter = 'selectionFilter' in value ? parseCadSelectionFilter(value.selectionFilter) : undefined;
      const showReferenceGeometry = 'showReferenceGeometry' in value && typeof value.showReferenceGeometry === 'boolean' ? value.showReferenceGeometry : undefined;
      return Object.freeze({ navigationMode: value.navigationMode, showOnPartDimensions: value.showOnPartDimensions,
        ...('showDepthHandles' in value ? { showDepthHandles: value.showDepthHandles as boolean } : {}),
        ...('showRelations' in value ? { showRelations: value.showRelations as boolean } : {}),
        ...(sketchView ? { sketchView } : {}), ...(section ? { section } : {}), ...(selectionFilter ? { selectionFilter } : {}),
        ...(showReferenceGeometry === undefined ? {} : { showReferenceGeometry }) });
    }
  } catch { /* Invalid device preferences never rewrite stored originals. */ }
  return defaults;
}

/** Device interaction preferences are independent of CAD documents and workbench storage. */
export function getCadPreferences(): CadPreferences {
  const raw = stored();
  if (raw !== undefined && raw !== lastRaw) { lastRaw = raw; current = parse(raw); }
  return current;
}
export function setCadPreferences(preferences: CadPreferences): boolean {
  current = Object.freeze({ ...preferences });
  let remembered = false;
  try {
    const raw = JSON.stringify(current);
    localStorage.setItem(CAD_PREFERENCES_KEY, raw); lastRaw = raw; remembered = true;
  } catch { /* Keep the explicit change for this session when preference storage is blocked. */ }
  listeners.forEach(listener => listener());
  return remembered;
}
const changed = (event: StorageEvent) => { if (event.key === null || event.key === CAD_PREFERENCES_KEY) listeners.forEach(listener => listener()); };
function subscribe(listener: () => void) {
  if (!listeners.size) window.addEventListener('storage', changed);
  listeners.add(listener);
  return () => { listeners.delete(listener); if (!listeners.size) window.removeEventListener('storage', changed); };
}
export function useCadPreferences(): CadPreferences { return useSyncExternalStore(subscribe, getCadPreferences, () => defaults); }
