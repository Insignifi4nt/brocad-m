import type { TObject, TSchema } from '@sinclair/typebox';
import type { CadDocument, CadFeature, CadScalar, CadSketchFeature } from '../cadDocument';
import type { CadDatumFrameLookup, CadResolvedFrame } from '../cadDatumPlanes';
import type { CadSketchQuantity } from '../cadSketchQuantity';
import type { CadSketchRegionSelection } from '../cadSketchRegionSelection';

export type CadFeatureKind = CadFeature['kind'];
// The schema stores fillet and chamfer with one shape, whose `kind` is their union, so a kind is narrowed rather than extracted.
type Narrowed<F, K> = F extends { readonly kind: infer Stored } ? K extends Stored ? F & { readonly kind: K } : never : never;
type Holding<F, K> = F extends { readonly kind: infer Stored } ? K extends Stored ? F : never : never;
/** A feature of kind `K`. */
export type CadFeatureOf<K extends CadFeatureKind> = Narrowed<CadFeature, K>;
/** The stored shape that holds kind `K`: for fillet and chamfer, the one they share. */
export type CadStoredFeatureOf<K extends CadFeatureKind> = Holding<CadFeature, K>;

/** Where the kind sits in the history: references, solids made from sketches or files, edge and face treatments, and body operations. */
export type CadFeatureFamily = 'reference' | 'solid' | 'dress-up' | 'body';
/**
 * What a feature gives later features, and so what an input slot accepts. K4's references add axes, points and frames; measured and
 * typed values (Q1, K10) add values.
 */
export type CadFeatureTrait = 'plane' | 'sketch' | 'curve' | 'body';
/** What an input is to its feature. */
export type CadFeatureSlotRole = 'support' | 'linked' | 'profile' | 'sections' | 'path' | 'target' | 'tool' | 'source';

/** A stored field that names other features: the ids it holds, and what each must give. */
export interface CadFeatureSlot<V = unknown> {
  readonly role: CadFeatureSlotRole;
  /** The trait each named feature must give. Every slot takes one trait until K4's references, which widen this. */
  readonly accepts: readonly [CadFeatureTrait];
  /** One id, one or none, or a list. */
  readonly count: 'one' | 'optional' | 'many';
  /** A list whose order is part of the feature, such as loft sections. */
  readonly ordered?: true;
  /** The ids a present value names, in order and once each. */
  ids(value: V): readonly string[];
}

export type CadScalarMapper = (value: CadScalar, path: string) => CadScalar;
export type CadFeatureQuantity = 'length' | 'angle' | 'count';
/**
 * What a number a field holds below it measures: a sketch quantity (millimetres, degrees, a whole count or a ratio without a unit, such
 * as a direction's component), an area in square millimetres, a place in a list, an angle in radians, or what the pinned plugin
 * package declares for its input.
 */
export type CadFeatureNestedQuantity = CadSketchQuantity | 'area' | 'index' | 'radians' | 'plugin';
/**
 * The quantity of the numbers at `path` below a field. A path is keys joined by `.`, where `*` stands for any index or key and
 * `{kind}` after a key, or first, keeps only a value of that kind; '' is the field itself.
 */
export interface CadFeatureQuantityPath { readonly path: string; readonly quantity: CadFeatureNestedQuantity }
/**
 * A dimension the feature stores: what it measures and the values it takes. A value, or with `magnitude` its size, at or below an
 * exclusive `min`, below an inclusive one, or above `max`, is refused with `refusal`; so is a vector whose every component is within
 * `tolerance` of zero when it must be `nonzero`. Comparisons are written as refusals, so a value that is not a number is left to the
 * checks that evaluate it.
 */
export interface CadFeatureScalar {
  readonly quantity: CadFeatureQuantity;
  /** The components of a vector; absent for one value. */
  readonly components?: 3;
  readonly integer?: true;
  readonly min?: number;
  readonly exclusiveMin?: true;
  readonly max?: number;
  readonly magnitude?: true;
  readonly nonzero?: true;
  readonly tolerance?: number;
  /** Why a value out of range is refused, as `invalid-dimension`. */
  readonly refusal?: string;
  /**
   * Stored as a plain number rather than an expression, so parameter traversals pass it by. Pattern counts stay literal until S8's
   * format cut lets them hold expressions.
   */
  readonly literal?: true;
  /** The instances the feature makes of its operands: it multiplies their solid instances and counts toward the document's pattern budget. */
  readonly repeats?: true;
}
/** A field present only for some values of another, such as a target body for every operation but a new body. */
export interface CadFeatureCondition {
  /** The field that decides. */
  readonly field: string;
  /** The value of that field for which this one is null. */
  readonly absentWhen: string;
  /** Why a feature that breaks the condition is refused, as `invalid-operation`. */
  readonly refusal: string;
}
/** One choice a field offers, with its label in forms. `key` names a choice whose stored value is not a string. */
export interface CadFeatureChoice<V = unknown> { readonly value: V; readonly label: string; readonly key?: string }

/** One stored field of a feature, after its id, name, suppression and kind: its schema and what it means. */
// Its functions are methods, so a field of any value type is read as a field of unknown values.
export interface CadFeatureField<S extends TSchema = TSchema, V = unknown> {
  readonly schema: S;
  readonly slot?: CadFeatureSlot<V>;
  readonly scalar?: CadFeatureScalar;
  /** The value with each expression-bearing scalar it holds replaced through `map`, which is given the scalar's path. */
  scalars?(value: V, path: string, map: CadScalarMapper): V;
  /**
   * What each number the field holds below it measures, for a field holding more than one dimension or count; `scalar` says it for a
   * field that is one. A function when the paths are built from another registry, read on first use.
   */
  readonly quantities?: readonly CadFeatureQuantityPath[] | (() => readonly CadFeatureQuantityPath[]);
  readonly choices?: readonly CadFeatureChoice<V>[];
  readonly condition?: CadFeatureCondition;
  /** A check of a present value made before the feature's instances are counted, such as a region selection's shape. */
  check?(value: V, context: CadFeatureCheckContext): void;
}
/** A kind's stored fields, in schema order. */
export type CadFeatureFields = { readonly [name: string]: CadFeatureField };
/** A kind's schema and the fields it was built from. Fillet and chamfer share one shape. */
export interface CadFeatureShape<S extends TObject = TObject> {
  readonly schema: S;
  readonly fields: CadFeatureFields;
}

/**
 * What a document parse offers a kind's checks. Its values are those of the document being parsed; `active` is whether the feature
 * under check takes part in the rebuild.
 */
export interface CadFeatureCheckContext {
  readonly document: CadDocument;
  readonly active: boolean;
  /** The features before the one under check, by id. */
  readonly previous: ReadonlyMap<string, CadFeature>;
  /** The frames of the active datum planes so far. */
  readonly datums: CadDatumFrameLookup;
  /** A scalar's value under the document's parameters. */
  value(scalar: CadScalar): number;
  /** The value of the feature's declared scalar field, held to its declared range. */
  scalar(feature: CadFeature, field: string): number;
  /** The values of the feature's declared vector field, held to its declared range. */
  vector(feature: CadFeature, field: string): readonly number[];
  /** Publish an active datum plane's frame to the features after it. */
  addDatumFrame(id: string, frame: CadResolvedFrame): void;
  /** That a sketch's geometry is valid under the document's parameters. An accepted sketch reading the same values is not checked again. */
  checkSketchGeometry(sketch: CadSketchFeature): void;
  /** That an active sketch-based feature's sketch is active and has regions to use. An accepted pair reading the same values is not checked again. */
  checkUsableSketch(feature: CadFeature, sketch: CadSketchFeature, selection: CadSketchRegionSelection | undefined): void;
}

/** How a feature treats bodies: it makes none, makes a new one, replaces its target, may do either, or replaces its target and consumes its tools. */
export type CadFeatureBodyBehaviour = 'none' | 'new' | 'modify-target' | 'new-or-modify' | 'consume-tools';
/** What an inactive feature leaves: its input bodies as they were, or nothing of its own. */
export type CadFeatureSuppression = 'pass-through' | 'no-output';

/** A vector component in a form: its label, the input's accessible name where it differs, and its unit where the group's is not shown. */
export interface CadFeatureFormComponent { readonly label: string; readonly inputLabel?: string; readonly unit?: 'deg' }
/** Parts of a form that a kind draws itself: sources, topology pickers and their summaries. */
export type CadFeatureFormPart = 'sketch-source' | 'loft-sections' | 'sweep-sources' | 'edge-scope' | 'topology-picker' | 'tangent-chain' | 'opening-summary';
/**
 * One control of a generic feature form, bound to a stored field: a body select, a scalar, a vector of three scalars, a select over the
 * field's choices, an instance count, an operation select that keeps its conditional target, or a part the kind draws itself.
 */
export type CadFeatureFormControl<F extends string = string> =
  | { readonly control: 'body'; readonly field: F; readonly label: string }
  | { readonly control: 'scalar'; readonly field: F; readonly label: string; readonly unit?: 'deg' }
  | { readonly control: 'vector'; readonly field: F; readonly label: string; readonly unit: 'mm' | 'deg'; readonly components: readonly [CadFeatureFormComponent, CadFeatureFormComponent, CadFeatureFormComponent] }
  | { readonly control: 'choice'; readonly field: F; readonly label: string }
  | { readonly control: 'count'; readonly field: F; readonly label: string }
  | { readonly control: 'operation'; readonly field: F; readonly label: string; readonly target: F; readonly targetLabel: string }
  | { readonly control: 'part'; readonly part: CadFeatureFormPart };
/** A form drawn by the kind's own editor, or one built from these controls in order. */
export type CadFeatureForm<F extends string = string> =
  | { readonly editor: 'bespoke'; readonly title: string }
  | { readonly editor: 'fields'; readonly title: string; readonly controls: readonly CadFeatureFormControl<F>[] };

/** What agents are told of a kind. */
export interface CadFeatureAgentExposure {
  /** Whether agent tools may name the kind. */
  readonly exposed: boolean;
  readonly description: string;
  /** The schema agents author with, where it differs from the stored one. */
  readonly authoringSchema?: TSchema;
  /** Schemas the reply names once under `$defs` and references elsewhere, to keep a large definition within the reply budget. */
  readonly sharedDefinitions?: Readonly<Record<string, TSchema>>;
}

/**
 * Everything a feature kind declares once, so consumers read features through it instead of switching on kinds: the document parser
 * checks references, dimensions and conditions through it, dependency discovery reads its slots, parameter traversals its scalars, and
 * agents its schema. What the kind shows people and agents is its `CadFeaturePresentation`, kept apart so the kernel worker, which
 * reads definitions, does not load that text. This is the view of any kind; `CadFeatureDefinition<K>` is one kind's.
 */
// Its functions are methods, so each kind's definition is read as a definition of any kind.
export interface CadAnyFeatureDefinition {
  readonly kind: CadFeatureKind;
  readonly family: CadFeatureFamily;
  /** The stored shape: validation, the agent schema and the generated docs read it. */
  readonly schema: TObject;
  readonly fields: CadFeatureFields;
  /** What the feature gives later features. */
  readonly outputs: readonly CadFeatureTrait[];
  readonly body: CadFeatureBodyBehaviour;
  /** What an inactive feature leaves. F0's body identity reads this. */
  readonly suppression: CadFeatureSuppression;
  /**
   * The occurrence a new body's key adds after the feature's id: `mirror` for a mirror image of its source. Body identity (`cadBodies.ts`)
   * reads it. A pattern's copies are `inst(i,j)` parts of the body it modifies instead, from the copies the kernel says it made.
   */
  readonly occurrence?: 'mirror';
  /**
   * Where the feature is evaluated and the version of that evaluation. E0's rebuild cache keys on it; raise the version whenever the
   * same stored feature would evaluate differently.
   */
  readonly evaluator: { readonly owner: 'domain' | 'kernel'; readonly version: number };
  /**
   * Every code its own checks and evaluation can refuse it with, apart from `CAD_FEATURE_SHARED_DIAGNOSTICS`, as far as reading the
   * code can tell. Codes of evaluating an input feature on its own, such as solving a sketch, are the input's: it is refused first.
   * `cadFeatureDiagnostics.test.ts` holds each list to the codes its checks and kernel evaluation can reach. D1 maps them to issues.
   */
  readonly diagnostics: readonly string[];
  /**
   * The solid instances the feature makes from `operands`, the instances of its body inputs, before any repeating count multiplies
   * them. Absent: none for a kind that makes no body, otherwise as many as its operands, and at least one.
   */
  instances?(feature: CadFeature, operands: number, context: CadFeatureCheckContext): number;
  /** Checks a parse makes beyond the schema, references, field checks and conditions, in the order their refusals are reported. */
  check?(feature: CadFeature, context: CadFeatureCheckContext): void;
}
/** The definition of kind `K`, whose checks read features of that kind. */
export interface CadFeatureDefinition<K extends CadFeatureKind> extends CadAnyFeatureDefinition {
  readonly kind: K;
  instances?(feature: CadFeatureOf<K>, operands: number, context: CadFeatureCheckContext): number;
  check?(feature: CadFeatureOf<K>, context: CadFeatureCheckContext): void;
}
export type CadFeatureDefinitions = { readonly [K in CadFeatureKind]: CadFeatureDefinition<K> };

/** What a kind shows people and agents: the feature editor's form and what agent tools say of it. This is the view of any kind. */
export interface CadAnyFeaturePresentation {
  readonly form: CadFeatureForm;
  readonly agent: CadFeatureAgentExposure;
}
/** The presentation of kind `K`, whose form binds fields of that kind. */
export interface CadFeaturePresentation<K extends CadFeatureKind> extends CadAnyFeaturePresentation {
  readonly form: CadFeatureForm<Extract<keyof CadStoredFeatureOf<K>, string>>;
}
export type CadFeaturePresentations = { readonly [K in CadFeatureKind]: CadFeaturePresentation<K> };
