import type { CadDiagnostic, CadKernelFailureDetails, CadKernelOperation } from './cadDocument';

/**
 * Every code a feature can be refused with: the codes of each kind's `diagnostics` and of `CAD_FEATURE_SHARED_DIAGNOSTICS`, which this
 * list types, so a kind cannot name a code missing from it. `cadIssueCodes.test.ts` holds the list to exactly the codes those lists name,
 * and `cadFeatureDiagnostics.test.ts` holds each list to the codes its checks and evaluation reach. The kernel and the document check
 * refuse with these codes, and the issue model types each one's details.
 */
export const CAD_REFUSAL_CODES = Object.freeze([
  'already-driven-sketch-radius', 'already-driven-sketch-tangent', 'changed-sketch-reference', 'closed-curve', 'cut-erased', 'cut-invalid', 'cut-no-material', 'cut-open',
  'cut-tool', 'disconnected-curve', 'division-by-zero', 'duplicate-id', 'duplicate-loft-section', 'duplicate-sketch-constraint',
  'duplicate-sketch-id', 'empty-profile', 'empty-reference', 'empty-sketch', 'empty-solid', 'expression-limit', 'feature-limit',
  'fixed-sketch-relation', 'import-bounds', 'import-empty', 'import-invalid', 'import-not-solid', 'import-open', 'import-size',
  'import-volume', 'instance-limit', 'invalid-corner-geometry', 'invalid-corner-topology', 'invalid-curve', 'invalid-curve-placement',
  'invalid-datum-plane', 'invalid-dimension', 'invalid-direction', 'invalid-distance', 'invalid-dxf-source', 'invalid-expression',
  'invalid-feature', 'invalid-gear', 'invalid-import', 'invalid-import-encoding', 'invalid-instances', 'invalid-loft-order', 'invalid-mesh',
  'invalid-operation', 'invalid-pattern', 'invalid-plane', 'invalid-plugin', 'invalid-plugin-inputs', 'invalid-plugin-rules',
  'invalid-pocket-bounds', 'invalid-pocket-extent', 'invalid-profile', 'invalid-profile-role', 'invalid-radius', 'invalid-reference',
  'invalid-region-selection', 'invalid-scalar', 'invalid-selector', 'invalid-selector-dimension', 'invalid-shell-opening',
  'invalid-sketch-angle', 'invalid-sketch-angle-ray', 'invalid-sketch-annotation', 'invalid-sketch-cell-id', 'invalid-sketch-cells',
  'invalid-sketch-cycle', 'invalid-sketch-graph', 'invalid-sketch-graph-geometry', 'invalid-sketch-line-pair', 'invalid-sketch-midpoint',
  'invalid-sketch-operand', 'invalid-sketch-pattern', 'invalid-sketch-point-line-distance', 'invalid-sketch-point-on-curve',
  'invalid-sketch-point-on-line', 'invalid-sketch-radial-entity', 'invalid-sketch-radius-pair', 'invalid-sketch-reference',
  'invalid-sketch-reference-dimension', 'invalid-sketch-symmetry', 'invalid-sketch-tangent', 'invalid-sketch-tangent-joint', 'invalid-solid',
  'kernel-operation-failed', 'loft-failed', 'loft-invalid', 'loft-open', 'loft-overshoot', 'loft-placement', 'loft-section-limit',
  'loft-sections', 'loft-volume', 'missing-body', 'missing-sketch', 'missing-sketch-entity', 'missing-sketch-point', 'missing-target',
  'non-canonical-sketch-relation', 'open-profile', 'overconstrained-sketch-dimension', 'owned-sketch-pattern', 'pattern-limit',
  'plugin-limit', 'plugin-size', 'pocket-erased', 'pocket-invalid', 'pocket-no-material', 'pocket-open', 'pocket-span-limit', 'pocket-tool',
  'profile-intersection', 'rebuild-stopped', 'reserved-sketch-id', 'selection-count-mismatch', 'selection-empty', 'selection-tangent-chain',
  'self-intersection', 'shell-components', 'shell-failed', 'shell-thickness', 'sketch-graph-precision', 'stale-sketch-reference',
  'stale-sketch-region', 'step-read', 'step-roots', 'step-transfer', 'step-units', 'step-units-unsupported', 'stl-coordinate', 'stl-facets',
  'stl-incomplete', 'stl-open', 'stl-orientation', 'stl-read', 'stl-shells', 'suppressed-curve', 'suppressed-sketch', 'sweep-curve',
  'sweep-empty', 'sweep-failed', 'sweep-invalid', 'sweep-open', 'sweep-section', 'sweep-volume', 'sweep-work-limit', 'topology-mapping',
  'unavailable-body', 'unavailable-datum-plane', 'unavailable-sketch-reference', 'unknown-parameter', 'unlowerable-sketch-operand', 'unsupported-cut-precision',
  'unsupported-cut-removal', 'unsupported-cut-target', 'unsupported-datum-frame', 'unsupported-datum-operation',
  'unsupported-datum-precision', 'unsupported-loft-planes', 'unsupported-loft-section', 'unsupported-pocket-precision',
  'unsupported-pocket-removal', 'unsupported-pocket-span', 'unsupported-pocket-target', 'unsupported-selection', 'unsupported-sketch-cells',
  'unsupported-sketch-dimension', 'unsupported-sketch-format', 'unsupported-sketch-operand', 'unsupported-sweep-clearance',
  'unsupported-sweep-corner', 'unsupported-sweep-placement', 'unsupported-sweep-precision', 'unsupported-sweep-section'
] as const);
export type CadRefusalCode = (typeof CAD_REFUSAL_CODES)[number];
const REFUSAL_CODES: ReadonlySet<unknown> = new Set(CAD_REFUSAL_CODES);
export function isCadRefusalCode(code: unknown): code is CadRefusalCode { return REFUSAL_CODES.has(code); }

/**
 * The facts a refusal code carries beyond its message, for consumers that need them; a code not listed carries none.
 * - `selection-count-mismatch`: how many elements a geometric selector requires and how many it matched, never none (that is `selection-empty`).
 * - `selection-empty`: how many it requires, or null when it asks for at least one.
 * - `kernel-unrecognised`: the code a build gave that this list does not have (`cadReceivedDiagnostic`). No check raises it.
 */
export interface CadRefusalFacts {
  readonly 'selection-count-mismatch': { readonly expected: number; readonly actual: number };
  readonly 'selection-empty': { readonly expected: number | null };
  readonly 'kernel-unrecognised': { readonly refusalCode: string };
}
export type CadRefusalFactCode = keyof CadRefusalFacts;
const atLeast = (value: unknown, least: number) => Number.isSafeInteger(value) && (value as number) >= least;
const FACTS: { readonly [C in CadRefusalFactCode]: { readonly keys: readonly (keyof CadRefusalFacts[C])[]; readonly check: (facts: Readonly<Record<string, unknown>>) => boolean } } = {
  'selection-count-mismatch': { keys: ['expected', 'actual'], check: facts => atLeast(facts.expected, 1) && atLeast(facts.actual, 1) && facts.expected !== facts.actual },
  'selection-empty': { keys: ['expected'], check: facts => facts.expected === null || atLeast(facts.expected, 1) },
  'kernel-unrecognised': { keys: ['refusalCode'], check: facts => isText(facts.refusalCode, MAX_CAD_DIAGNOSTIC_CODE) && !isCadRefusalCode(facts.refusalCode) && !isCadRefusalFactCode(facts.refusalCode) }
};
export function isCadRefusalFactCode(code: unknown): code is CadRefusalFactCode { return typeof code === 'string' && Object.hasOwn(FACTS, code); }
/** Whether `value` is the facts of `code`: exactly the fields it lists, each in range. A code that lists none has no facts. */
export function isCadRefusalFacts<C extends string>(code: C, value: unknown): value is C extends CadRefusalFactCode ? CadRefusalFacts[C] : never {
  if (!isCadRefusalFactCode(code) || typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value), { keys: listed, check } = FACTS[code] as { readonly keys: readonly string[]; readonly check: (facts: Readonly<Record<string, unknown>>) => boolean };
  return keys.length === listed.length && keys.every(key => listed.includes(key)) && check(value as Readonly<Record<string, unknown>>);
}

/** The steps a kernel failure can name. */
export const CAD_KERNEL_OPERATIONS: readonly CadKernelOperation[] = Object.freeze(['import', 'profile', 'extrude', 'revolve', 'loft', 'sweep', 'pocket', 'join', 'cut',
  'intersect', 'fillet', 'chamfer', 'shell', 'transform', 'mirror', 'pattern', 'check', 'record'] satisfies readonly CadKernelOperation[]);
/** The longest kernel text a failure keeps; longer text is cut to it (`cadBoundedText`) before it is published. */
export const MAX_CAD_KERNEL_MESSAGE = 2048;
/** The longest code a diagnostic gives. Codes are identifiers written in the source, far shorter. */
export const MAX_CAD_DIAGNOSTIC_CODE = 128;
/**
 * The longest message a diagnostic or error reply gives. Messages are written in the source with names and values in them, far shorter;
 * the worker still cuts a longer one to it (`cadBoundedText`) before it replies, as it does kernel text.
 */
export const MAX_CAD_DIAGNOSTIC_MESSAGE = 8192;
/**
 * The longest input field name and input id a failure names. A field is a feature field name written in the source, and an id a feature
 * id, which the document schema holds to 96 characters, so no producer exceeds either.
 */
const MAX_INPUT_FIELD = 64, MAX_INPUT_ID = 96;
function isText(value: unknown, most: number) { return typeof value === 'string' && value.length > 0 && value.length <= most; }
/** `text`, or when it is longer than `most` characters, its start cut to fit with an ellipsis after it. */
export function cadBoundedText(text: string, most: number): string {
  return text.length <= most ? text : `${text.slice(0, most - 1)}…`;
}
/**
 * Diagnostic `diagnostic` as the app takes it in, the same object when nothing changes:
 * - a code this list has is kept, and any other becomes `kernel-unrecognised`, which keeps the code it gave in its facts and its message,
 *   feature and details as they were, so a refusal no registry lists still reaches the issue model under a code of its own, never renamed
 *   to another refusal;
 * - kernel text longer than `MAX_CAD_KERNEL_MESSAGE` is cut to it, as the worker cuts it before replying.
 * A build reply passes through this where it is received, and the issues of a build pass it again, which changes nothing.
 */
export function cadReceivedDiagnostic(diagnostic: CadDiagnostic): CadDiagnostic {
  let received = diagnostic;
  const text = diagnostic.details?.kernelMessage;
  if (diagnostic.details && text && text.length > MAX_CAD_KERNEL_MESSAGE) {
    received = { ...received, details: { ...diagnostic.details, kernelMessage: cadBoundedText(text, MAX_CAD_KERNEL_MESSAGE) } };
  }
  if (isCadRefusalCode(diagnostic.code) || diagnostic.code === 'kernel-unrecognised') return received;
  const { facts: _facts, ...rest } = received;
  return { ...rest, code: 'kernel-unrecognised', facts: { refusalCode: cadBoundedText(diagnostic.code, MAX_CAD_DIAGNOSTIC_CODE) } };
}
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);
/**
 * Whether `value` is a kernel failure's details: a known step, a bounded input or none, and kernel text of at most `kernelMessageMost`
 * characters or none, and nothing else. The worker boundary admits text of any length, which it cuts as it takes the reply in.
 */
export function isCadKernelFailureDetails(value: unknown, kernelMessageMost = MAX_CAD_KERNEL_MESSAGE): value is CadKernelFailureDetails {
  if (!isRecord(value) || Object.keys(value).length !== 3 || !CAD_KERNEL_OPERATIONS.includes(value.operation as CadKernelOperation)) return false;
  const input = value.input;
  if (input !== null && (!isRecord(input) || Object.keys(input).length !== 2 || !isText(input.field, MAX_INPUT_FIELD) || !isText(input.id, MAX_INPUT_ID))) return false;
  return value.kernelMessage === null || isText(value.kernelMessage, kernelMessageMost);
}

/** The refusals of a sketch edit or of the accepted sketch's analysis: `sketch-` and the solver's reason, as edit preparation spells them. */
export const CAD_SKETCH_REFUSAL_CODES = Object.freeze(['sketch-conflicting', 'sketch-redundant', 'sketch-failed', 'sketch-invalid-input', 'sketch-too-large',
  'sketch-invalid-solution'] as const);
export type CadSketchRefusalCode = (typeof CAD_SKETCH_REFUSAL_CODES)[number];
/** A relation the solver names as conflicting, redundant or partly redundant. */
export type CadSketchRelationCode = 'relation-conflicting' | 'relation-redundant' | 'relation-partially-redundant';
/** The graph check's codes (`cadSketchGraph.ts`). */
export type CadSketchGraphCode = 'invalid-expression' | 'invalid-coordinate' | 'degenerate-entity' | 'invalid-radius' | 'arc-radius-mismatch' | 'invalid-distance'
  | 'relation-residual';
/** Every sketch code: its refusals, the items they and the analysis list, and the warning of an accepted edit that shrank mirrored curves. */
export type CadSketchCode = CadSketchRefusalCode | CadSketchRelationCode | CadSketchGraphCode | 'mirror-shrank';

/** The codes of sending a sketch to CAM and of a Section for CAM. */
export const CAD_CAM_CODES = Object.freeze(['missing-sketch', 'suppressed-sketch', 'empty-sketch', 'cam-geometry', 'invalid-section', 'empty-section',
  'degenerate-section', 'tangent-section', 'unsupported-section-curve', 'section-failed', 'kernel-operation-failed'] as const);
export type CadCamCode = (typeof CAD_CAM_CODES)[number];
