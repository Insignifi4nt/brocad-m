/**
 * Select other: the candidates under the pointer, in their stable order, taken one after another. The step starts from the most recently
 * selected candidate and replaces it with the next, wrapping round; with no candidate selected it starts at the first, or the last going back.
 */
export interface CadSelectOtherStep<T> {
  readonly candidate: T;
  readonly index: number;
  /** The selected candidate the step moves away from, which the new one takes the place of, or `null` when none was selected. */
  readonly replaces: T | null;
}

export function cadSelectOtherStep<T>(candidates: readonly T[], selection: readonly T[], same: (a: T, b: T) => boolean, direction: 1 | -1 = 1): CadSelectOtherStep<T> | null {
  if (!candidates.length) return null;
  for (let at = selection.length - 1; at >= 0; at--) {
    const index = candidates.findIndex(candidate => same(candidate, selection[at]));
    if (index < 0) continue;
    const next = (index + direction + candidates.length) % candidates.length;
    return { candidate: candidates[next], index: next, replaces: selection[at] };
  }
  const index = direction > 0 ? 0 : candidates.length - 1;
  return { candidate: candidates[index], index, replaces: null };
}

/** The selection after a step: the replaced candidate swapped in place, else the new candidate alone. */
export function cadSelectOtherApply<T>(selection: readonly T[], step: CadSelectOtherStep<T>, same: (a: T, b: T) => boolean): T[] {
  if (step.replaces === null) return [step.candidate];
  const replaced = step.replaces;
  const next = selection.map(item => same(item, replaced) ? step.candidate : item);
  return next.filter((item, index) => next.findIndex(other => same(other, item)) === index);
}
