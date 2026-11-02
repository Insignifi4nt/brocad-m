import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { CadScalarSchema } from '../cadPrimitives';
import { CadError } from '../cadError';
import { evaluateCadRecipeScalar, evaluateCadScalar } from '../cadExpression';
import { CAD_GEAR_NOTE, resolveCadGear } from '../cadGear';
import { CONFIGURED_GEAR_NOTE, GENERATED_GEAR_NOTE, resolveConfiguredCadGear, resolveGeneratedCadGear } from '../cadGearGenerated';
import { CadPluginRulesSchema, evaluatePluginDerived, pluginCondition, type CadPluginRules } from './cadPluginRules';
import type { ResolvedCadProfile } from '../cadSketchGeometry';

const strict = { additionalProperties: false };
const label = Type.String({ minLength: 1, maxLength: 160, pattern: '\\S' });
const inputName = Type.String({ pattern: '^[A-Za-z_][A-Za-z0-9_]{0,63}$' });
const packageFields = {
  format: Type.Literal('wireedm-cad-plugin'),
  id: Type.String({ pattern: '^[a-z][a-z0-9.-]{0,79}$' }), version: Type.String({ pattern: '^\\d+\\.\\d+\\.\\d+$', maxLength: 32 }),
  name: label, description: Type.String({ maxLength: 1000 }), notes: Type.String({ maxLength: 2000 }),
  inputs: Type.Array(Type.Object({ name: inputName, label, unit: Type.String({ maxLength: 20 }), default: Type.Number(),
    minimum: Type.Number(), maximum: Type.Number(), integer: Type.Boolean() }, strict), { minItems: 1, maxItems: 32 }),
  generator: Type.Union([
    Type.Object({ kind: Type.Literal('builtin'), implementation: Type.Union([Type.Literal('wireedm.spur-gear.v1'), Type.Literal('wireedm.spur-gear.v2'), Type.Literal('wireedm.spur-gear.v3')]) }, strict),
    Type.Object({ kind: Type.Literal('polygon-recipe'), repeat: CadScalarSchema,
      points: Type.Array(Type.Tuple([CadScalarSchema, CadScalarSchema]), { minItems: 1, maxItems: 128 }) }, strict)
  ])
};
export const CadPluginPackageSchema = Type.Union([
  Type.Object({ ...packageFields, apiVersion: Type.Literal(1) }, strict),
  Type.Object({ ...packageFields, apiVersion: Type.Literal(2), rules: CadPluginRulesSchema }, strict)
]);
export type CadPluginPackage = Static<typeof CadPluginPackageSchema>;
export const CadPluginProfileSchema = Type.Object({ kind: Type.Literal('plugin'), package: CadPluginPackageSchema,
  inputs: Type.Record(inputName, CadScalarSchema, { maxProperties: 32, additionalProperties: false }) }, strict);
export type CadPluginProfile = Static<typeof CadPluginProfileSchema>;

const field = (name: string, label: string, unit: string, value: number, minimum: number, maximum: number, integer = false) => ({ name, label, unit, default: value, minimum, maximum, integer });
export const CAD_GEAR_PLUGIN: CadPluginPackage = {
  format: 'wireedm-cad-plugin', apiVersion: 1, id: 'wireedm.spur-gear', version: '1.0.0', name: 'Spur gear',
  description: 'Parametric metric involute spur gear. Module, tooth count, pressure angle, profile shift and backlash.', notes: CAD_GEAR_NOTE,
  inputs: [field('module', 'Module', 'mm', 3, 0.05, 50), field('teeth', 'Teeth', '', 18, 12, 300, true),
    field('pressureAngle', 'Pressure angle', 'deg', 20, 14.5, 30), field('profileShift', 'Profile shift', '', 0, -0.5, 1),
    field('backlash', 'Backlash', 'mm', 0, 0, 50), field('tolerance', 'Flank tolerance', 'mm', 0.005, 0.00001, 0.1),
    field('x', 'Center X', 'mm', 0, -1e6, 1e6), field('y', 'Center Y', 'mm', 0, -1e6, 1e6), field('angle', 'Rotation', 'deg', 0, -360, 360)],
  generator: { kind: 'builtin', implementation: 'wireedm.spur-gear.v1' }
};
export const CAD_STAR_PLUGIN: CadPluginPackage = {
  format: 'wireedm-cad-plugin', apiVersion: 1, id: 'wireedm.star-profile', version: '1.0.0', name: 'Star profile',
  description: 'An editable example of an installable polygon recipe. Repeated inner and outer vertices.', notes: 'A decorative star profile, not an involute gear.',
  inputs: [field('lobes', 'Lobes', '', 8, 3, 100, true), field('outerRadius', 'Outer radius', 'mm', 30, 0.1, 1000), field('innerRadius', 'Inner radius', 'mm', 20, 0.1, 1000)],
  generator: { kind: 'polygon-recipe', repeat: 'lobes', points: [
    ['outerRadius * cos(index * 2 * pi / count)', 'outerRadius * sin(index * 2 * pi / count)'],
    ['innerRadius * cos((index + 0.5) * 2 * pi / count)', 'innerRadius * sin((index + 0.5) * 2 * pi / count)']
  ] }
};
function gearFieldRules(): CadPluginRules['fields'] {
  return CAD_GEAR_PLUGIN.inputs.filter(input => !['tolerance', 'profileShift'].includes(input.name)).map(input => {
    const group: CadPluginRules['fields'][number]['group'] = ['x', 'y', 'angle'].includes(input.name) ? 'placement' : ['module', 'teeth', 'pressureAngle'].includes(input.name) ? 'main' : 'advanced';
    return { name: input.name, group, minimum: input.minimum, maximum: input.name === 'backlash' ? 'module * pi / 2' : input.maximum };
  });
}
export const CAD_GEAR_V2_PLUGIN: CadPluginPackage = {
  format: 'wireedm-cad-plugin', apiVersion: 2, id: 'wireedm.spur-gear', version: '2.0.0', name: 'Spur gear',
  description: 'Metric involute teeth with rack-generated rounded roots and correlated dimensions.', notes: GENERATED_GEAR_NOTE,
  inputs: [field('module', 'Module', 'mm', 3, 0.05, 50), field('teeth', 'Teeth', '', 18, 12, 300, true),
    field('pressureAngle', 'Pressure angle', 'deg', 20, 14.5, 30), field('shiftMode', 'Profile shift', '', 0, 0, 1, true),
    field('profileShift', 'Shift coefficient', '', 0, -0.5, 0.6), field('backlash', 'Tooth thinning', 'mm', 0, 0, 50),
    field('qualityMode', 'Curve tolerance', '', 0, 0, 1, true), field('tolerance', 'Custom tolerance', 'mm', 0.005, 0.00001, 0.1),
    field('x', 'X', 'mm', 0, -1e6, 1e6), field('y', 'Y', 'mm', 0, -1e6, 1e6), field('angle', 'Rotation', 'deg', 0, -360, 360)],
  generator: { kind: 'builtin', implementation: 'wireedm.spur-gear.v2' },
  rules: {
    derived: [
      { name: 'alpha', label: 'Angle in radians', unit: '', expression: 'pressureAngle * pi / 180' },
      { name: 'rackHalfWidth', label: 'Rack space half-width', unit: '', expression: 'pi / 4 - backlash / (2 * module)' },
      { name: 'rackTipCoefficient', label: 'Rack tip coefficient', unit: '', expression: 'min(0.25 / (1 - sin(alpha)), 0.95 * (pi / 2 - rackHalfWidth - 1.25 * tan(alpha)) / (1 / cos(alpha) - tan(alpha)))' },
      { name: 'minimumShift', label: 'Minimum shift', unit: '', expression: '1.25 - teeth * sin(alpha) * sin(alpha) / 2 - rackTipCoefficient * (1 - sin(alpha))' },
      { name: 'autoShift', label: 'Automatic shift', unit: '', expression: 'max(0, minimumShift + 0.00000001)' },
      { name: 'effectiveShift', label: 'Applied shift', unit: '', expression: 'shiftMode * profileShift + (1 - shiftMode) * autoShift' },
      { name: 'effectiveTolerance', label: 'Applied tolerance', unit: 'mm', expression: 'qualityMode * tolerance + (1 - qualityMode) * min(0.005, module / 200)' },
      { name: 'pitchDiameter', label: 'Pitch Ø', unit: 'mm', expression: 'module * teeth' },
      { name: 'baseDiameter', label: 'Base Ø', unit: 'mm', expression: 'pitchDiameter * cos(alpha)' },
      { name: 'tipDiameter', label: 'Outside Ø', unit: 'mm', expression: 'pitchDiameter + 2 * module * (1 + effectiveShift)' },
      { name: 'rootDiameter', label: 'Root Ø', unit: 'mm', expression: 'pitchDiameter + 2 * module * (effectiveShift - 1.25)' },
      { name: 'circularPitch', label: 'Circular pitch', unit: 'mm', expression: 'pi * module' },
      { name: 'cutterTipRadius', label: 'Rack tip radius', unit: 'mm', expression: 'module * rackTipCoefficient' },
      { name: 'tipPsi', label: 'Tip roll', unit: '', expression: 'sqrt(tipDiameter * tipDiameter / (baseDiameter * baseDiameter) - 1)' },
      { name: 'tipThickness', label: 'Tip thickness', unit: 'mm', expression: 'tipDiameter * ((pi / 2 + 2 * effectiveShift * tan(alpha) - backlash / module) / teeth + tan(alpha) - alpha - tipPsi + atan(tipPsi))' }
    ],
    fields: [...gearFieldRules(),
      { name: 'shiftMode', group: 'advanced', minimum: 0, maximum: 1, choices: [{ value: 0, label: 'Automatic' }, { value: 1, label: 'Manual' }] },
      { name: 'profileShift', group: 'advanced', minimum: 'max(-0.5, minimumShift)', maximum: 0.6, enabledWhen: { left: 'shiftMode', operator: 'eq', right: 1 } },
      { name: 'qualityMode', group: 'advanced', minimum: 0, maximum: 1, choices: [{ value: 0, label: 'Automatic' }, { value: 1, label: 'Custom' }] },
      { name: 'tolerance', group: 'advanced', minimum: 0.00001, maximum: 'min(0.1, module / 20)', enabledWhen: { left: 'qualityMode', operator: 'eq', right: 1 } }
    ],
    constraints: [
      { left: 'tipThickness', operator: 'ge', right: 'module * 0.2', message: 'Tooth tips must be at least 0.2 × module thick. Reduce tooth thinning/profile shift or increase teeth.' },
      { left: 'effectiveShift', operator: 'ge', right: 'minimumShift', message: 'Profile shift is too small for this tooth count and pressure angle.' },
      { left: 'backlash', operator: 'lt', right: 'pi * module / 2', message: 'Tooth thinning must be smaller than half the circular pitch.' }
    ]
  }
};
function configurableGearRules(): CadPluginRules {
  if (CAD_GEAR_V2_PLUGIN.apiVersion !== 2) throw new Error('Generated gear requires correlated plugin API 2.');
  return {
    derived: [
      ...structuredClone(CAD_GEAR_V2_PLUGIN.rules.derived).flatMap(rule => rule.name === 'rackTipCoefficient' ? [{ ...rule, name: 'maximumRackTipCoefficient', label: 'Maximum rack tip coefficient' }]
        : rule.name === 'cutterTipRadius' ? []
          : rule.name === 'minimumShift' ? [{ ...rule, expression: '1.25 - teeth * sin(alpha) * sin(alpha) / 2 - effectiveRackTipCoefficient * (1 - sin(alpha))' }] : [rule]),
      { name: 'effectiveCutterTipRadius', label: 'Applied cutter tip radius', unit: 'mm', expression: 'cutterTipMode * cutterTipRadius + (1 - cutterTipMode) * module * maximumRackTipCoefficient' },
      { name: 'effectiveRackTipCoefficient', label: 'Applied rack tip coefficient', unit: '', expression: 'effectiveCutterTipRadius / module' }
    ],
    fields: [...structuredClone(CAD_GEAR_V2_PLUGIN.rules.fields).map(rule => rule.name === 'profileShift'
      ? { ...rule, maximum: 'min(1, 1.2 - effectiveRackTipCoefficient - 0.00000001)' } : rule),
      { name: 'cutterTipMode', group: 'advanced', minimum: 0, maximum: 1, choices: [{ value: 0, label: 'Automatic' }, { value: 1, label: 'Custom' }] },
      { name: 'cutterTipRadius', group: 'advanced', minimum: 'module * 0.001', maximum: 'module * maximumRackTipCoefficient', enabledWhen: { left: 'cutterTipMode', operator: 'eq', right: 1 } }
    ],
    constraints: structuredClone(CAD_GEAR_V2_PLUGIN.rules.constraints)
  };
}
/** Explicit opt-in package: saved V1/V2 snapshots and installed packages retain their exact definitions. */
export const CAD_GEAR_V3_PLUGIN: CadPluginPackage = {
  ...structuredClone(CAD_GEAR_V2_PLUGIN), apiVersion: 2, version: '3.0.0',
  description: 'Metric involute spur gear with correlated generating cutter tip radius and certified curve accuracy.', notes: CONFIGURED_GEAR_NOTE,
  inputs: [...structuredClone(CAD_GEAR_V2_PLUGIN.inputs).map(input => input.name === 'profileShift' ? { ...input, maximum: 1 } : input),
    field('cutterTipMode', 'Tooth root', '', 0, 0, 1, true), field('cutterTipRadius', 'Cutter tip radius', 'mm', 1, 0.00001, 50)],
  generator: { kind: 'builtin', implementation: 'wireedm.spur-gear.v3' }, rules: configurableGearRules()
};
export const BUNDLED_CAD_PLUGINS: readonly CadPluginPackage[] = [CAD_GEAR_V3_PLUGIN, CAD_STAR_PLUGIN];

/** Editable authoring example, installed only by an explicit authoring action. */
export const CAD_LINKED_RECIPE_EXAMPLE: CadPluginPackage = {
  ...CAD_STAR_PLUGIN, apiVersion: 2, id: 'user.linked-star', name: 'Linked star profile',
  description: 'Polygon recipe with a derived diameter and a dependent inner radius limit.',
  rules: {
    derived: [{ name: 'diameter', label: 'Outer diameter', unit: 'mm', expression: 'outerRadius * 2' }],
    fields: CAD_STAR_PLUGIN.inputs.map(input => ({ name: input.name, group: 'main', minimum: input.minimum,
      maximum: input.name === 'innerRadius' ? 'outerRadius - 0.001' : input.maximum })),
    constraints: [{ left: 'innerRadius', operator: 'lt', right: 'outerRadius', message: 'Inner radius must be smaller than outer radius.' }]
  }
};

export async function fingerprintCadPluginPackage(plugin: CadPluginPackage) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(plugin)));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function parseCadPluginPackage(value: unknown): CadPluginPackage {
  if (JSON.stringify(value)?.length > 65536 || !Value.Check(CadPluginPackageSchema, value)) throw new CadError('invalid-plugin', 'Invalid plugin package. Use a complete plugin API 1 or 2 package of at most 64 KiB.');
  const plugin = structuredClone(value);
  validateDefinition(plugin);
  resolveCadPluginProfile({ kind: 'plugin', package: plugin, inputs: Object.fromEntries(plugin.inputs.map(input => [input.name, input.default])) }, {});
  return plugin;
}

function validateDefinition(plugin: CadPluginPackage) {
  if (new TextEncoder().encode(JSON.stringify(plugin)).length > 65536) throw new CadError('plugin-size', 'Plugin package exceeds 64 KiB.');
  if (plugin.id.endsWith('.') || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/.test(plugin.id)) throw new CadError('invalid-plugin', 'Plugin identity must be a portable folder name.');
  const names = new Set<string>();
  for (const input of plugin.inputs) {
    if (names.has(input.name) || ['index', 'count', 'pi', '__proto__', 'constructor', 'prototype'].includes(input.name)) throw new CadError('invalid-plugin', 'Plugin input names must be unique and cannot use reserved names.');
    names.add(input.name);
    if (![input.minimum, input.maximum, input.default].every(Number.isFinite) || input.minimum > input.maximum || input.default < input.minimum || input.default > input.maximum || input.integer && !Number.isInteger(input.default)) throw new CadError('invalid-plugin', 'Plugin input defaults and limits are inconsistent.');
  }
  if (plugin.apiVersion === 2) {
    for (const rule of plugin.rules.derived) {
      if (names.has(rule.name) || ['index', 'count', 'pi', '__proto__', 'constructor', 'prototype'].includes(rule.name)) throw new CadError('invalid-plugin-rules', 'Derived names must be unique and distinct from inputs.');
      names.add(rule.name);
    }
    if (plugin.rules.fields.length !== plugin.inputs.length || new Set(plugin.rules.fields.map(rule => rule.name)).size !== plugin.inputs.length || plugin.rules.fields.some(rule => !plugin.inputs.some(input => input.name === rule.name))) throw new CadError('invalid-plugin-rules', 'Each editable input needs exactly one field rule.');
    for (const input of plugin.inputs) {
      const choices = plugin.rules.fields.find(rule => rule.name === input.name)?.choices;
      if (choices && (new Set(choices.map(choice => choice.value)).size !== choices.length || !choices.some(choice => choice.value === input.default)
        || choices.some(choice => !Number.isFinite(choice.value) || choice.value < input.minimum || choice.value > input.maximum || input.integer && !Number.isInteger(choice.value)))) {
        throw new CadError('invalid-plugin-rules', 'Choices need unique finite values within the input type and static range, including its default.');
      }
    }
  }
  if ((plugin.generator.kind === 'builtin' || plugin.id === CAD_GEAR_PLUGIN.id) && ![CAD_GEAR_PLUGIN, CAD_GEAR_V2_PLUGIN, CAD_GEAR_V3_PLUGIN].some(builtin => Value.Equal(plugin, builtin))) throw new CadError('invalid-plugin', 'Built-in plugin identity and definition cannot be replaced by an imported package.');
}

export function createCadPluginProfile(plugin: CadPluginPackage): CadPluginProfile {
  return { kind: 'plugin', package: parseCadPluginPackage(plugin), inputs: Object.fromEntries(plugin.inputs.map(input => [input.name, input.default])) };
}

/** Saved instances embed the exact package version, so library changes never rewrite parts. */
export function resolveCadPluginProfile(profile: CadPluginProfile, parameters: Readonly<Record<string, number>>): ResolvedCadProfile {
  return resolveCadPluginOutline(profile, parameters).shape;
}

/**
 * How a plugin's outline divides into parts that keep their meaning when its inputs change, which a sketch generator keys its members
 * by. A gear is `teeth` teeth in turn, each its left side from the root circle up, its tip arc, its right side down and the root arc
 * after it; a side is `foot` chords up to the base of the involute, then `flank` chords up to the tip. A recipe is `repeat`
 * repetitions of its `points` vertices.
 */
export type CadPluginOutlineParts =
  | { readonly kind: 'gear'; readonly teeth: number; readonly foot: number; readonly flank: number }
  | { readonly kind: 'recipe'; readonly repeat: number; readonly points: number };
export interface CadPluginOutline { readonly shape: ResolvedCadProfile; readonly parts: CadPluginOutlineParts }
/** The plugin's outline, as `resolveCadPluginProfile` gives it, with the parts it is made of. */
export function resolveCadPluginOutline(profile: CadPluginProfile, parameters: Readonly<Record<string, number>>): CadPluginOutline {
  const resolved = inspectAndGenerateProfile(profile, parameters);
  if (!resolved.ok) throw new CadError('invalid-plugin-inputs', resolved.inspection.issues[0]);
  return resolved.geometry;
}

export function inspectCadPluginProfile(profile: CadPluginProfile, parameters: Readonly<Record<string, number>>) {
  return inspectAndGenerateProfile(profile, parameters).inspection;
}

/** A resolution reuses this geometry; an inspection exposes only bounded field metadata. */
function inspectAndGenerateProfile(profile: CadPluginProfile, parameters: Readonly<Record<string, number>>) {
  const plugin = profile.package;
  validateDefinition(plugin);
  let values: Record<string, number> = {};
  const issues: string[] = [];
  if (Object.keys(profile.inputs).length !== plugin.inputs.length) issues.push('Plugin inputs must match its pinned package exactly.');
  for (const input of plugin.inputs) {
    if (!Object.hasOwn(profile.inputs, input.name)) { issues.push(`Missing plugin input "${input.name}".`); continue; }
    try {
      const value = evaluateCadScalar(profile.inputs[input.name], parameters);
      if (value < input.minimum || value > input.maximum || input.integer && !Number.isInteger(value)) issues.push(`${input.label} must be ${input.integer ? 'an integer ' : ''}between ${input.minimum} and ${input.maximum}.`);
      values[input.name] = value;
    } catch (error) { issues.push(`${input.label}: ${error instanceof Error ? error.message : 'Invalid expression.'}`); }
  }
  const fallback: CadPluginRules['fields'] = plugin.inputs.map(input => ({ name: input.name, group: 'main', minimum: input.minimum, maximum: input.maximum }));
  const fieldRules = plugin.apiVersion === 2 ? plugin.rules.fields : fallback;
  const definitions = Object.fromEntries(plugin.inputs.map(input => [input.name, input] as const));
  const fields = fieldRules.map(rule => ({ ...structuredClone(rule),
    minimum: Math.max(typeof rule.minimum === 'number' ? rule.minimum : -1e9, definitions[rule.name].minimum),
    maximum: Math.min(typeof rule.maximum === 'number' ? rule.maximum : 1e9, definitions[rule.name].maximum), enabled: true }));
  if (!issues.length && plugin.apiVersion === 2) {
    try {
      values = evaluatePluginDerived(plugin.rules, values);
      for (const [index, rule] of fieldRules.entries()) {
        const minimum = Math.max(evaluateCadRecipeScalar(rule.minimum, values), definitions[rule.name].minimum);
        const maximum = Math.min(evaluateCadRecipeScalar(rule.maximum, values), definitions[rule.name].maximum);
        const enabled = !rule.enabledWhen || pluginCondition(rule.enabledWhen, values);
        fields[index] = { ...fields[index], minimum, maximum, enabled };
        if (enabled && minimum > maximum) issues.push(`No valid range for ${rule.name} with these parameters.`);
        if (enabled && (values[rule.name] < minimum || values[rule.name] > maximum)) issues.push(`${plugin.inputs.find(input => input.name === rule.name)?.label ?? rule.name} must be between ${minimum} and ${maximum}.`);
        if (enabled && rule.choices && !rule.choices.some(choice => choice.value === values[rule.name])) issues.push(`${rule.name} must use one of its declared choices.`);
      }
      for (const constraint of plugin.rules.constraints) if (!pluginCondition(constraint, values)) issues.push(constraint.message);
    } catch (error) { issues.push(error instanceof Error ? error.message : 'Invalid plugin relations.'); }
  }
  const inspection = { values, fields, issues };
  if (!issues.length) try { return { ok: true as const, inspection, geometry: generatePluginProfile(plugin, values) }; }
  catch (error) { issues.push(error instanceof Error ? error.message : 'Invalid plugin geometry.'); }
  return { ok: false as const, inspection };
}

function generatePluginProfile(plugin: CadPluginPackage, values: Readonly<Record<string, number>>): CadPluginOutline {
  if (plugin.generator.kind === 'builtin') {
    const { x, y, module, teeth, pressureAngle, profileShift, backlash, angle, tolerance } = values;
    const gear = plugin.generator.implementation === 'wireedm.spur-gear.v3'
      ? resolveConfiguredCadGear({ x, y, module, teeth, pressureAngle, profileShift: values.effectiveShift, backlash, angle, tolerance: values.effectiveTolerance, cutterTipRadius: values.effectiveCutterTipRadius }, {})
      : plugin.generator.implementation === 'wireedm.spur-gear.v2'
        ? resolveGeneratedCadGear({ x, y, module, teeth, pressureAngle, profileShift: values.effectiveShift, backlash, angle, tolerance: values.effectiveTolerance }, {})
        : resolveCadGear({ x, y, module, teeth, pressureAngle, profileShift, backlash, angle, tolerance }, {});
    return { shape: { kind: 'path', segments: gear.segments }, parts: { kind: 'gear', teeth: gear.teeth, foot: gear.rootSteps, flank: gear.flankSteps } };
  }
  const repeat = evaluateCadRecipeScalar(plugin.generator.repeat, values);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat * plugin.generator.points.length > 2048) throw new CadError('plugin-limit', 'Plugin repeat must be a positive integer producing at most 2048 vertices.');
  const points: (readonly [number, number])[] = [];
  for (let index = 0; index < repeat; index++) {
    const scope = { ...values, index, count: repeat, pi: Math.PI };
    for (const [x, y] of plugin.generator.points) points.push([evaluateCadRecipeScalar(x, scope), evaluateCadRecipeScalar(y, scope)]);
  }
  if (points.length < 3) throw new CadError('invalid-plugin', 'Plugin must generate at least three vertices.');
  return { shape: { kind: 'polygon', points }, parts: { kind: 'recipe', repeat, points: plugin.generator.points.length } };
}
