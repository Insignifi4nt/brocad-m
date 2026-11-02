import { Type, type Static } from '@sinclair/typebox';
import type { CadDocument, CadFeature, CadScalar } from './cadDocument';
import { CadError } from './cadError';
import { cadFeatureDependencies } from './cadFeatureInputs';
import { evaluateCadScalar } from './cadExpression';
import { createCadPluginProfile, inspectCadPluginProfile, type CadPluginPackage } from './plugins/cadPlugins';
import { cadFeatureActive } from './features/cadFeatureActivity';
import { cadFeatureLayout } from './features/cadFeatureRegistry';
import type { CadSketchGenerator } from './cadSketchGraph';
import { cadSketchGeneratorPrefixFor, setCadSketchGenerator } from './sketch-generators/cadSketchGeneratorEdits';
import { cadSketchProfileViews } from './sketch-generators/cadSketchProfileViews';

const strict = { additionalProperties: false };
export const CadParameterNameSchema = Type.String({ pattern: '^[A-Za-z_][A-Za-z0-9_]{0,63}$' });
const id = Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$' });
export const CadParameterGroupSchema = Type.Object({ id, name: Type.String({ minLength: 1, maxLength: 160, pattern: '\\S' }) }, strict);
export const CadParameterSourceSchema = Type.Union([
  Type.Object({ kind: Type.Literal('manual') }, strict),
  Type.Object({ kind: Type.Literal('plugin'), featureId: id, profileId: id, inputName: CadParameterNameSchema,
    packageId: Type.String({ pattern: '^[a-z][a-z0-9.-]{0,79}$' }), packageVersion: Type.String({ pattern: '^\\d+\\.\\d+\\.\\d+$', maxLength: 32 }) }, strict)
]);
export const CadParameterMetadataSchema = Type.Object({ groupId: Type.Optional(id), source: CadParameterSourceSchema }, strict);
export type CadParameterGroup = Static<typeof CadParameterGroupSchema>;
export type CadParameterSource = Static<typeof CadParameterSourceSchema>;
export type CadParameterMetadata = Static<typeof CadParameterMetadataSchema>;

export function validateCadParameterMetadata(document: CadDocument) {
  const ids = new Set<string>(), names = new Set<string>();
  for (const group of document.parameterGroups ?? []) {
    if (ids.has(group.id) || names.has(group.name.trim().toLocaleLowerCase('en'))) throw new CadError('duplicate-parameter-group', 'Parameter group IDs and names must be unique.');
    ids.add(group.id); names.add(group.name.trim().toLocaleLowerCase('en'));
  }
  for (const [name, metadata] of Object.entries(document.parameterMetadata ?? {})) {
    if (!Object.hasOwn(document.parameters, name)) throw new CadError('invalid-parameter-metadata', `Parameter metadata refers to missing parameter "${name}".`);
    if (metadata.groupId !== undefined && !ids.has(metadata.groupId)) throw new CadError('missing-parameter-group', `Parameter "${name}" refers to a missing group.`);
    // Source is historical provenance. Deleting its original profile must not
    // delete shared dimensions or invalidate a document that still uses them.
  }
}

/** Tokens match the scalar parser, including scientific notation as one token. */
export function cadScalarParameterNames(value: CadScalar): readonly string[] {
  if (typeof value === 'number') return [];
  return [...new Set((value.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z_0-9]*|[^\s]/g) ?? []).filter(token => /^[A-Za-z_][A-Za-z_0-9]*$/.test(token)))];
}
type ScalarMapper = (value: CadScalar, path: string) => CadScalar;

/**
 * `feature` with each dimension-bearing scalar replaced through `map`, which is given its path, in schema order. Ids, source text and
 * pinned packages stay exact. Fields absent or null are left out, as are pattern counts, which stay literal.
 */
export function mapCadFeatureScalars(feature: CadFeature, map: ScalarMapper): CadFeature {
  const { mapped } = cadFeatureLayout(feature);
  if (!mapped.length) return feature;
  const stored = feature as unknown as Readonly<Record<string, unknown>>, copy: Record<string, unknown> = { ...stored };
  for (const { name, field } of mapped) {
    const value = stored[name];
    if (value !== undefined && value !== null) copy[name] = field.scalars!(value, name, map);
  }
  return copy as unknown as CadFeature;
}

export function renameCadScalarParameter(value: CadScalar, name: string, newName: string): CadScalar {
  return typeof value === 'number' ? value : value.replace(/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z_0-9]*/g, token => token === name ? newName : token);
}

export interface CadParameterUsage {
  readonly featureId: string; readonly featureName: string; readonly profileId?: string; readonly inputName?: string;
  readonly path: string; readonly expression: string; readonly active: boolean; readonly reason?: string;
}
export interface CadPluginInputBinding {
  readonly featureId: string; readonly featureName: string; readonly profileId: string; readonly profileName: string;
  readonly inputName: string; readonly label: string; readonly expression: CadScalar; readonly value: number; readonly appliedValue: number;
  readonly parameterNames: readonly string[]; readonly linked: boolean; readonly effective: boolean; readonly editable: boolean;
}

/**
 * Current expression links and downstream history; reads never attach metadata. A plugin's inputs are read from a legacy plugin profile
 * or from a plugin generator, through the sketch's profile views.
 */
export function inspectCadParameters(document: CadDocument) {
  const usages = new Map<string, CadParameterUsage[]>(Object.keys(document.parameters).map(name => [name, []]));
  const pluginInputs: CadPluginInputBinding[] = [];
  for (const feature of document.features) {
    const active = cadFeatureActive(feature, document);
    if (feature.kind === 'sketch') for (const profile of cadSketchProfileViews(feature)) if (profile.geometry.kind === 'plugin') {
      const inspection = inspectCadPluginProfile(profile.geometry, document.parameters);
      for (const input of profile.geometry.package.inputs) {
        const field = inspection.fields.find(field => field.name === input.name), expression = profile.geometry.inputs[input.name];
        const parameterNames = cadScalarParameterNames(expression).filter(name => Object.hasOwn(document.parameters, name));
        // A conditional editing lock does not discard a generic recipe's stored
        // value. Only the built-in gear explicitly replaces these inputs in its
        // automatic modes; generic recipes still evaluate their pinned inputs.
        const generated = profile.geometry.package.generator.kind === 'builtin' && ['wireedm.spur-gear.v2', 'wireedm.spur-gear.v3'].includes(profile.geometry.package.generator.implementation);
        const automatic = generated && (input.name === 'profileShift' && inspection.values.shiftMode === 0
          || input.name === 'tolerance' && inspection.values.qualityMode === 0 || input.name === 'cutterTipRadius' && inspection.values.cutterTipMode === 0);
        const appliedValue = automatic ? inspection.values[input.name === 'profileShift' ? 'effectiveShift' : input.name === 'tolerance' ? 'effectiveTolerance' : 'effectiveCutterTipRadius'] : inspection.values[input.name];
        pluginInputs.push({ featureId: feature.id, featureName: feature.name, profileId: profile.id, profileName: profile.name,
          inputName: input.name, label: input.label, expression, value: inspection.values[input.name], appliedValue, parameterNames,
          linked: parameterNames.length > 0, effective: active && !automatic, editable: field?.enabled !== false });
      }
    }
    mapCadFeatureScalars(feature, (value, path) => {
      if (typeof value !== 'string') return value;
      const match = feature.kind === 'sketch' ? /^(profiles|graph\.relations)\.(\d+)\.geometry(?:\.inputs\.([A-Za-z_][A-Za-z_0-9]*))?/.exec(path) : null;
      const profile = match && feature.kind === 'sketch' ? (match[1] === 'profiles' ? feature.profiles : feature.graph?.relations ?? [])[Number(match[2])] : undefined;
      const binding = match?.[3] ? pluginInputs.find(binding => binding.featureId === feature.id && binding.profileId === profile?.id && binding.inputName === match[3]) : undefined;
      const effective = active && binding?.effective !== false;
      for (const name of cadScalarParameterNames(value)) usages.get(name)?.push({ featureId: feature.id, featureName: feature.name,
        ...(profile ? { profileId: profile.id } : {}), ...(binding ? { inputName: binding.inputName } : {}), path, expression: value, active: effective,
        ...(!effective ? { reason: !active ? 'Feature is suppressed.' : 'Input is controlled automatically; the stored expression is inactive.' } : {}) });
      return value;
    });
  }
  return { groups: document.parameterGroups ?? [], pluginInputs, parameters: Object.entries(document.parameters).map(([name, value]) => {
    const references = usages.get(name) ?? [], directlyUsed = new Set(references.filter(usage => usage.active).map(usage => usage.featureId));
    const affected = new Set(directlyUsed);
    for (const feature of document.features) if (cadFeatureActive(feature, document) && cadFeatureDependencies(feature).some(id => affected.has(id))) affected.add(feature.id);
    return { name, value, groupId: document.parameterMetadata?.[name]?.groupId ?? null,
      source: document.parameterMetadata?.[name]?.source ?? { kind: 'manual' satisfies CadParameterSource['kind'] },
      usages: references, downstreamFeatureIds: [...affected].filter(id => !directlyUsed.has(id)),
      pluginBindings: pluginInputs.filter(binding => binding.parameterNames.includes(name)) };
  }) };
}

/**
 * New plugin instances get new dimensions, never similarly named existing values. The instance is a plugin generator with the id
 * `profileId`, which regenerates its shape whenever those dimensions change; saved plugin profiles keep loading as they were.
 */
export function addCadPluginProfile(document: CadDocument, input: { sketchId: string; profileId: string; name: string; package: CadPluginPackage; groupId: string }): CadDocument {
  const sketch = document.features.find(feature => feature.id === input.sketchId);
  if (sketch?.kind !== 'sketch') throw new CadError('missing-sketch', 'Choose an existing sketch for the plugin profile.');
  const used = (feature: CadFeature) => feature.id === input.profileId || feature.kind === 'sketch' && (feature.profiles.some(profile => profile.id === input.profileId)
    || Boolean(feature.graph && [feature.graph.points, feature.graph.entities, feature.graph.relations].some(items => items.some(item => item.id === input.profileId))));
  if (document.features.some(used)) throw new CadError('duplicate-id', 'Plugin profile ID already exists.');
  if (document.parameterGroups?.some(group => group.id === input.groupId)) throw new CadError('duplicate-parameter-group', 'New plugin parameter group ID already exists.');
  const geometry = createCadPluginProfile(input.package), inspected = inspectCadPluginProfile(geometry, document.parameters);
  const parameters = { ...document.parameters }, metadata = { ...document.parameterMetadata };
  let groupName = input.name.trim(), suffix = 2;
  const existingNames = new Set(document.parameterGroups?.map(group => group.name.trim().toLocaleLowerCase('en')));
  while (existingNames.has(groupName.toLocaleLowerCase('en'))) groupName = `${input.name.trim().slice(0, 150)} ${suffix++}`;
  const scope = groupName.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 28) || 'plugin';
  const prefix = `p_${scope}`;
  for (const field of inspected.fields) {
    if (!field.enabled || field.group === 'placement' || field.choices || geometry.package.generator.kind === 'builtin' && ['x', 'y', 'angle'].includes(field.name)) continue;
    const base = `${prefix}_${field.name}`.slice(0, 60);
    let name = base, suffix = 2;
    while (Object.hasOwn(parameters, name)) name = `${base.slice(0, 58)}_${suffix++}`;
    const value = evaluateCadScalar(geometry.inputs[field.name], document.parameters);
    parameters[name] = value; geometry.inputs[field.name] = name;
    metadata[name] = { groupId: input.groupId, source: { kind: 'plugin', featureId: sketch.id, profileId: input.profileId,
      inputName: field.name, packageId: geometry.package.id, packageVersion: geometry.package.version } };
  }
  const generator: CadSketchGenerator = { id: input.profileId, kind: 'generator', idPrefix: cadSketchGeneratorPrefixFor(sketch, input.profileId),
    ...(input.name.trim() ? { name: input.name.trim().slice(0, 160) } : {}), construction: false, geometry };
  const updated = setCadSketchGenerator(sketch, generator);
  return { ...document, parameters, parameterMetadata: metadata, parameterGroups: [...document.parameterGroups ?? [], { id: input.groupId, name: groupName }],
    features: document.features.map(feature => feature.id === sketch.id ? updated : feature) };
}
