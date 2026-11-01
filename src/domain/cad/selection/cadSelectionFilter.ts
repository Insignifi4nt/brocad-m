/**
 * Which kinds of geometry a pick may land on. The filter is display state kept with the device preferences. It records the kinds turned
 * off, so a kind added later starts selectable. One filter serves the part and its sketches: points cover sketch points and the origin,
 * edges sketch edges as well as solid ones, and axes the sketch axes as well as the origin's; relations and dimensions are sketch marks.
 */
export type CadSelectionKind = 'body' | 'face' | 'edge' | 'vertex' | 'plane' | 'axis' | 'point' | 'relation' | 'dimension';
export interface CadSelectionFilter { readonly excluded: readonly CadSelectionKind[] }

export const CAD_SELECTION_KINDS: readonly CadSelectionKind[] = Object.freeze(['body', 'face', 'edge', 'vertex', 'plane', 'axis', 'point', 'relation', 'dimension']);
/** Everything is selectable until the user turns a kind off. */
export const CAD_DEFAULT_SELECTION_FILTER: CadSelectionFilter = Object.freeze({ excluded: Object.freeze([]) });

const isKind = (value: unknown): value is CadSelectionKind => CAD_SELECTION_KINDS.includes(value as CadSelectionKind);
const filterOf = (excluded: Iterable<CadSelectionKind>): CadSelectionFilter => {
  const set = new Set(excluded);
  return set.size ? Object.freeze({ excluded: Object.freeze(CAD_SELECTION_KINDS.filter(kind => set.has(kind))) }) : CAD_DEFAULT_SELECTION_FILTER;
};

/** Whether a pick on geometry of this kind may select it. */
export function cadSelectionAccepts(filter: CadSelectionFilter, kind: CadSelectionKind): boolean {
  return !filter.excluded.includes(kind);
}

/** The filter with one kind turned on or off; the same filter when nothing changes. */
export function setCadSelectionKind(filter: CadSelectionFilter, kind: CadSelectionKind, accepted: boolean): CadSelectionFilter {
  if (!isKind(kind) || cadSelectionAccepts(filter, kind) === accepted) return filter;
  return filterOf(accepted ? filter.excluded.filter(entry => entry !== kind) : [...filter.excluded, kind]);
}

export function sameCadSelectionFilter(a: CadSelectionFilter, b: CadSelectionFilter): boolean {
  return a === b || a.excluded.length === b.excluded.length && a.excluded.every(kind => b.excluded.includes(kind));
}

/** A stored filter; kinds this build does not know are dropped, and anything else unreadable gives `undefined`. */
export function parseCadSelectionFilter(value: unknown): CadSelectionFilter | undefined {
  if (!value || typeof value !== 'object' || !('excluded' in value) || !Array.isArray(value.excluded)) return undefined;
  return filterOf(value.excluded.filter(isKind));
}
