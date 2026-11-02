import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { createCadDocument, parseCadDocument } from '../cadSchema';
import { applyCadEdits, CadEditSchema, type CadEdit } from '../cadOperations';
import { cadScalarParameterNames, inspectCadParameters } from '../cadParameters';
import { CAD_GEAR_V2_PLUGIN, CAD_GEAR_V3_PLUGIN, CAD_STAR_PLUGIN, createCadPluginProfile } from '../plugins/cadPlugins';
import { resolveCadProfile } from '../cadSketchGeometry';
import type { CadFeature } from '../cadDocument';
import { cadSketchProfileViews } from '../sketch-generators/cadSketchProfileViews';
import { CadSession } from '@/features/cad/cadSession';

const blankSketch = { kind: 'sketch', id: 'sketch', name: 'Sketch', suppressed: false, plane: 'XY', offset: 0, profiles: [] } as const;
const initial = () => parseCadDocument({ ...createCadDocument('Part', 'cad_parameters'), features: [blankSketch] });
// A plugin instance is a generator, seen as the profile it was.
const pluginOf = (feature: CadFeature) => {
  const view = feature.kind === 'sketch' ? cadSketchProfileViews(feature)[0] : undefined;
  if (view?.geometry.kind !== 'plugin') throw new Error('Plugin missing');
  return { ...view, geometry: view.geometry };
};
const addGear: CadEdit = { kind: 'add-plugin-profile', sketchId: 'sketch', profileId: 'gear', name: 'Gear', package: CAD_GEAR_V2_PLUGIN, groupId: 'gear_dimensions' };

describe('named CAD dimension groups and ownership', () => {
  it('adds scoped plugin drivers atomically without reusing existing parameters or creating inactive and placement clutter', () => {
    const before = parseCadDocument({ ...initial(), parameters: { module: 99, p_gear_module: 77 } });
    const session = new CadSession(before); session.edit([addGear], session.getSnapshot().version);
    const after = session.getSnapshot().document, sketch = after.features[0];
    const instance = pluginOf(sketch);
    // The instance is a plugin generator: its record keeps the pinned package and inputs, and the parse regenerates its shape.
    if (sketch.kind !== 'sketch' || !sketch.graph) throw new Error('Expected a graph');
    expect(sketch.profiles).toEqual([]);
    expect(sketch.graph.relations.find(relation => relation.id === 'gear')).toMatchObject({ kind: 'generator', idPrefix: 'gear', name: 'Gear' });
    expect(sketch.graph.entities.length).toBeGreaterThan(100);
    expect(after.parameters).toMatchObject({ module: 99, p_gear_module: 77, p_gear_module_2: 3, p_gear_teeth: 18, p_gear_pressureAngle: 20, p_gear_backlash: 0 });
    expect(Object.keys(after.parameters)).toHaveLength(6);
    expect(instance.geometry.inputs).toMatchObject({ module: 'p_gear_module_2', teeth: 'p_gear_teeth', profileShift: 0, tolerance: 0.005, x: 0, y: 0, angle: 0 });
    expect(after.parameterGroups).toEqual([{ id: 'gear_dimensions', name: 'Gear' }]);
    expect(after.parameterMetadata?.p_gear_module_2).toEqual({ groupId: 'gear_dimensions', source: { kind: 'plugin', featureId: 'sketch', profileId: 'gear', inputName: 'module', packageId: CAD_GEAR_V2_PLUGIN.id, packageVersion: '2.0.0' } });
    expect(instance.geometry.package).toEqual(CAD_GEAR_V2_PLUGIN);
    expect(before.parameters).toEqual({ module: 99, p_gear_module: 77 });
    session.undo(); expect(session.getSnapshot().document).toEqual(before);
    session.redo(); expect(session.getSnapshot().document).toEqual(after);
  });
  it('creates separate groups and drivers for two plugin instances, including generic recipe inputs', () => {
    const document = applyCadEdits(initial(), [addGear,
      { kind: 'add-feature', feature: { ...blankSketch, id: 'sketch2' } },
      { ...addGear, sketchId: 'sketch2', profileId: 'gear2', groupId: 'gear2_dimensions' },
      { kind: 'add-feature', feature: { ...blankSketch, id: 'sketch3' } },
      { ...addGear, sketchId: 'sketch3', profileId: 'star', name: 'Star', package: CAD_STAR_PLUGIN, groupId: 'star_dimensions' }]);
    expect(document.parameterGroups?.map(group => group.name)).toEqual(['Gear', 'Gear 2', 'Star']);
    expect(document.parameters).toMatchObject({ p_gear_module: 3, p_gear_2_module: 3, p_star_outerRadius: 30 });
    const changed = applyCadEdits(document, [{ kind: 'set-parameter', name: 'p_gear_module', value: 4 }]);
    expect(changed.parameters.p_gear_2_module).toBe(3); expect(changed.parameters.p_gear_module).toBe(4);
  });
  it('keeps existing plain documents exact on reads and existing value edits', () => {
    const before = parseCadDocument({ ...initial(), parameters: { dimension: 4 } });
    const text = JSON.stringify(before); inspectCadParameters(before);
    expect(JSON.stringify(before)).toBe(text);
    const after = applyCadEdits(before, [{ kind: 'set-parameter', name: 'dimension', value: 5 }]);
    expect(after).not.toHaveProperty('parameterGroups'); expect(after).not.toHaveProperty('parameterMetadata');
    expect(inspectCadParameters(after).parameters[0].source).toEqual({ kind: 'manual' });
  });
  it('renames tokens across expressions while retaining exact names, IDs, pinned manifests and origins', () => {
    const grouped = applyCadEdits(initial(), [addGear, { kind: 'set-parameter', name: 'p_gear_module_extra', value: 5 }]);
    const renamed = applyCadEdits(grouped, [{ kind: 'rename-parameter', name: 'p_gear_module', newName: 'pitch_module' }]);
    expect(renamed.parameters).toHaveProperty('pitch_module', 3); expect(renamed.parameters).not.toHaveProperty('p_gear_module');
    expect(renamed.parameters.p_gear_module_extra).toBe(5);
    const sketch = renamed.features[0];
    const instance = pluginOf(sketch);
    expect(instance.geometry.inputs.module).toBe('pitch_module'); expect(instance.id).toBe('gear');
    expect(instance.geometry.package).toEqual(CAD_GEAR_V2_PLUGIN);
    expect(renamed.parameterMetadata?.pitch_module).toEqual(grouped.parameterMetadata?.p_gear_module);
  });
  it('moves values and renames/removes groups without erasing historical provenance or shared values', () => {
    const grouped = applyCadEdits(initial(), [addGear]);
    const changed = applyCadEdits(grouped, [{ kind: 'set-parameter-group', group: { id: 'user', name: 'User dimensions' } },
      { kind: 'move-parameter', name: 'p_gear_module', groupId: 'user' }, { kind: 'set-parameter-group', group: { id: 'gear_dimensions', name: 'Drive gear' } },
      { kind: 'remove-parameter-group', groupId: 'user' }, { kind: 'delete-feature', featureId: 'sketch', cascade: true }]);
    expect(changed.parameters).toEqual(grouped.parameters); expect(changed.parameterGroups).toEqual([{ id: 'gear_dimensions', name: 'Drive gear' }]);
    expect(changed.parameterMetadata?.p_gear_module).toEqual({ source: grouped.parameterMetadata?.p_gear_module.source });
    expect(inspectCadParameters(changed).parameters.find(parameter => parameter.name === 'p_gear_module')?.usages).toEqual([]);
  });
  it('allows ordinary dimension names that also name recipe functions without rewriting the pinned recipe namespace', () => {
    const before = applyCadEdits(initial(), [addGear]);
    const after = applyCadEdits(before, [{ kind: 'rename-parameter', name: 'p_gear_module', newName: 'sin' },
      { kind: 'rename-parameter', name: 'p_gear_teeth', newName: 'pi' }]);
    const original = before.features[0], renamed = after.features[0];
    if (original.kind !== 'sketch' || renamed.kind !== 'sketch') throw new Error('Expected sketches');
    expect(resolveCadProfile(pluginOf(renamed).geometry, after.parameters)).toEqual(resolveCadProfile(pluginOf(original).geometry, before.parameters));
    expect(after.parameters.sin).toBe(3); expect(after.parameters.pi).toBe(18);
    const instance = pluginOf(renamed);
    expect(instance.geometry.package).toEqual(CAD_GEAR_V2_PLUGIN);
    expect(instance.geometry.inputs).toMatchObject({ module: 'sin', teeth: 'pi' });
  });
  it('rejects invalid groups, metadata, duplicate names and invalid geometry without changing its input', () => {
    const before = applyCadEdits(initial(), [addGear]); const text = JSON.stringify(before);
    const invalid: CadEdit[][] = [
      [{ ...addGear }], [{ kind: 'rename-parameter', name: 'p_gear_module', newName: 'p_gear_teeth' }],
      [{ kind: 'move-parameter', name: 'p_gear_module', groupId: 'absent' }],
      [{ kind: 'set-parameter-group', group: { id: 'another', name: 'gear' } }],
      [{ kind: 'set-parameter', name: 'p_gear_module', value: -3 }]
    ];
    for (const edits of invalid) expect(() => applyCadEdits(before, edits)).toThrow();
    expect(() => parseCadDocument({ ...before, parameterMetadata: { absent: { source: { kind: 'manual' } } } })).toThrow('missing parameter');
    expect(() => parseCadDocument({ ...before, parameterMetadata: { p_gear_module: { groupId: 'absent', source: { kind: 'manual' } } } })).toThrow('missing group');
    expect(JSON.stringify(before)).toBe(text);
  });
  it('adds valid scoped plugin drivers beyond former parameter and group counts while preserving previous dimensions and provenance', () => {
    const parameters = Object.fromEntries(Array.from({ length: 128 }, (_, index) => [`dimension_${index}`, index]));
    const before = parseCadDocument({ ...initial(), parameters,
      parameterGroups: Array.from({ length: 64 }, (_, index) => ({ id: `group_${index}`, name: `Group ${index}` })),
      parameterMetadata: Object.fromEntries(Object.keys(parameters).map(name => [name, { groupId: 'group_63', source: { kind: 'manual' } }])),
    }), original = JSON.stringify(before), after = applyCadEdits(before, [addGear]);
    expect(after.parameters).toMatchObject(before.parameters); expect(Object.keys(after.parameters)).toHaveLength(132);
    expect(after.parameterGroups).toEqual([...before.parameterGroups ?? [], { id: 'gear_dimensions', name: 'Gear' }]);
    expect(after.parameterMetadata).toMatchObject(before.parameterMetadata!);
    expect(after.parameterMetadata?.p_gear_module).toMatchObject({ groupId: 'gear_dimensions', source: { kind: 'plugin', profileId: 'gear', inputName: 'module' } });
    const sketch = after.features[0];
    if (sketch.kind !== 'sketch') throw new Error('Expected sketch');
    expect(resolveCadProfile(pluginOf(sketch).geometry, after.parameters)).toEqual(resolveCadProfile(createCadPluginProfile(CAD_GEAR_V2_PLUGIN), {}));
    expect(parseCadDocument(JSON.parse(JSON.stringify(after)))).toEqual(after); expect(JSON.stringify(before)).toBe(original);
  });
  it('strict edit discovery agrees with executed group and plugin operations', () => {
    const edits: CadEdit[] = [addGear, { kind: 'set-parameter-group', group: { id: 'other', name: 'Other' } },
      { kind: 'move-parameter', name: 'p_gear_module', groupId: 'other' }, { kind: 'rename-parameter', name: 'p_gear_module', newName: 'new_module' }];
    expect(edits.every(edit => Value.Check(CadEditSchema, edit))).toBe(true);
    expect(Value.Check(CadEditSchema, { ...addGear, extra: true })).toBe(false);
    expect(Value.Check(CadEditSchema, { kind: 'move-parameter', name: 'x', groupId: 'other', source: 'plugin' })).toBe(false);
    expect(applyCadEdits(initial(), edits).parameters.new_module).toBe(3);
  });
});

describe('current dimension usage inspection', () => {
  it('reports the dormant custom cutter radius separately from its applied automatic value', () => {
    const profile = createCadPluginProfile(CAD_GEAR_V3_PLUGIN); profile.inputs.cutterTipRadius = 'tool_tip';
    const document = parseCadDocument({ ...initial(), parameters: { tool_tip: .5 }, features: [{ ...blankSketch,
      profiles: [{ id: 'gear', name: 'Gear', construction: false, geometry: profile }] }] });
    const automatic = inspectCadParameters(document);
    expect(automatic.pluginInputs.find(input => input.inputName === 'cutterTipRadius')).toMatchObject({ value: .5, appliedValue: expect.any(Number), effective: false, editable: false });
    expect(automatic.parameters[0].usages[0].active).toBe(false);
    const manual = parseCadDocument({ ...document, features: [{ ...blankSketch, profiles: [{ id: 'gear', name: 'Gear', construction: false,
      geometry: { ...profile, inputs: { ...profile.inputs, cutterTipMode: 1 } } }] }] });
    const inspected = inspectCadParameters(manual);
    expect(inspected.pluginInputs.find(input => input.inputName === 'cutterTipRadius')).toMatchObject({ expression: 'tool_tip', value: .5, appliedValue: .5, effective: true, editable: true });
    expect(inspected.parameters[0].usages[0].active).toBe(true);
  });
  it('uses exact lexical identifiers without substring or scientific exponent false positives', () => {
    expect(cadScalarParameterNames('width + width_extra * 1e-3 + e')).toEqual(['width', 'width_extra', 'e']);
    const document = parseCadDocument({ ...initial(), parameters: { width: 5, width_extra: 3, e: 2 }, features: [{ ...blankSketch,
      profiles: [{ id: 'width', name: 'width', construction: false, geometry: { kind: 'rectangle', x: 0, y: 0, width: 'width_extra + 1e-3', height: 'e', cornerRadius: 0 } }] }] });
    const inspected = inspectCadParameters(document);
    expect(inspected.parameters.find(parameter => parameter.name === 'width')?.usages).toEqual([]);
    expect(inspected.parameters.find(parameter => parameter.name === 'e')?.usages).toHaveLength(1);
    expect(inspected.parameters.find(parameter => parameter.name === 'width_extra')?.usages[0]).toMatchObject({ profileId: 'width', path: 'profiles.0.geometry.width', active: true });
    const renamed = applyCadEdits(document, [{ kind: 'rename-parameter', name: 'e', newName: 'base_height' }]);
    const sketch = renamed.features[0];
    if (sketch.kind !== 'sketch' || sketch.profiles[0].geometry.kind !== 'rectangle') throw new Error('Expected rectangle');
    expect(sketch.profiles[0].geometry).toMatchObject({ width: 'width_extra + 1e-3', height: 'base_height' });
  });
  it('reports active plugin links, automatic inactive bindings, local inputs and downstream body consumers', () => {
    const profile = createCadPluginProfile(CAD_GEAR_V2_PLUGIN);
    profile.inputs.module = 'm'; profile.inputs.profileShift = 'saved_shift';
    const document = parseCadDocument({ ...initial(), parameters: { m: 3, saved_shift: 0.3 }, features: [{ ...blankSketch,
      profiles: [{ id: 'gear', name: 'Gear', construction: false, geometry: profile }] },
      { id: 'body', name: 'Body', kind: 'extrude', suppressed: false, sketchId: 'sketch', distance: 5, symmetric: false, operation: 'new', targetId: null },
      { id: 'move', name: 'Move', kind: 'transform', suppressed: false, sourceId: 'body', translation: [1, 0, 0], rotation: [0, 0, 0] }] });
    const inspected = inspectCadParameters(document);
    expect(inspected.parameters.find(parameter => parameter.name === 'm')).toMatchObject({ downstreamFeatureIds: ['body', 'move'], usages: [{ active: true, inputName: 'module' }] });
    expect(inspected.parameters.find(parameter => parameter.name === 'saved_shift')).toMatchObject({ downstreamFeatureIds: [], usages: [{ active: false, inputName: 'profileShift', reason: expect.stringContaining('automatically') }] });
    expect(inspected.pluginInputs.find(input => input.inputName === 'teeth')).toMatchObject({ linked: false, effective: true, parameterNames: [] });
    expect(inspected.pluginInputs.find(input => input.inputName === 'module')).toMatchObject({ linked: true, expression: 'm', parameterNames: ['m'] });
    expect(inspected.pluginInputs.find(input => input.inputName === 'profileShift')).toMatchObject({ value: 0.3, appliedValue: 0, effective: false });
  });
  it('distinguishes locked recipe editing from an automatic input that stops driving geometry', () => {
    const plugin = { ...CAD_STAR_PLUGIN, apiVersion: 2 as const, rules: { derived: [], constraints: [], fields: CAD_STAR_PLUGIN.inputs.map(input => ({
      name: input.name, group: 'main' as const, minimum: input.minimum, maximum: input.maximum,
      ...(input.name === 'outerRadius' ? { enabledWhen: { left: 'lobes', operator: 'eq' as const, right: 3 } } : {}) })) } };
    const profile = createCadPluginProfile(plugin); profile.inputs.outerRadius = 'radius';
    const document = parseCadDocument({ ...initial(), parameters: { radius: 30 }, features: [{ ...blankSketch,
      profiles: [{ id: 'star', name: 'Star', construction: false, geometry: profile }] }] });
    const inspected = inspectCadParameters(document);
    expect(inspected.pluginInputs.find(input => input.inputName === 'outerRadius')).toMatchObject({ editable: false, effective: true, linked: true });
    expect(inspected.parameters[0].usages[0].active).toBe(true);
  });
});
