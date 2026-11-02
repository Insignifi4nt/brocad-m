import type { CadFeature } from './cadDocument';
import { cadFeatureActive, type CadFeatureScope } from './features/cadFeatureActivity';
import type { CadFeatureTrait } from './features/cadFeatureDefinitionTypes';
import { cadFeatureDefinition, cadFeatureLayout } from './features/cadFeatureRegistry';

export interface CadFeatureInputs {
  readonly sketchIds: readonly string[];
  readonly curveIds: readonly string[];
  readonly bodyIds: readonly string[];
  readonly datumIds: readonly string[];
}
const none: readonly string[] = Object.freeze([]);
const bucket = { sketch: 'sketchIds', curve: 'curveIds', body: 'bodyIds', plane: 'datumIds' } as const satisfies Record<CadFeatureTrait, keyof CadFeatureInputs>;

/**
 * The features `feature` names, by the trait each must give, read from its kind's slots. One traversal serves references here and
 * scalar expressions in `mapCadFeatureScalars`; K10's measured parameters join it.
 */
export function cadFeatureInputs(feature: CadFeature): CadFeatureInputs {
  const inputs = { sketchIds: none, curveIds: none, bodyIds: none, datumIds: none };
  for (const { name, meaning: slot } of cadFeatureLayout(feature).slots) {
    const value = (feature as unknown as Readonly<Record<string, unknown>>)[name];
    if (value === undefined || value === null) continue;
    const key = bucket[slot.accepts[0]], ids = slot.ids(value);
    // A slot's ids are read-only: a fresh list, or the stored one, as Loft's sections are.
    if (ids.length) inputs[key] = inputs[key].length ? [...inputs[key], ...ids] : ids;
  }
  return inputs;
}
export function cadFeatureDependencies(feature: CadFeature): string[] {
  const inputs = cadFeatureInputs(feature);
  return [...inputs.sketchIds, ...inputs.curveIds, ...inputs.bodyIds, ...inputs.datumIds];
}
export type CadBodyFeature = Exclude<CadFeature, { readonly kind: 'datum-plane' | 'sketch' | 'curve' }>;
export function cadFeatureProducesBody(feature: CadFeature): feature is CadBodyFeature {
  return cadFeatureDefinition(feature.kind).outputs.includes('body');
}
/** The bodies `feature` replaces in `scope`: none when it is inactive or keeps its inputs, as a new body does. */
export function cadConsumedBodyIds(feature: CadFeature, scope: CadFeatureScope): readonly string[] {
  const { body } = cadFeatureDefinition(feature.kind);
  return body === 'none' || body === 'new' || !cadFeatureActive(feature, scope) ? [] : cadFeatureInputs(feature).bodyIds;
}
/** Body identity derives the current bodies from the same body behaviour, keyed by their creating features. */
export { cadVisibleBodyIds } from './cadBodies';
