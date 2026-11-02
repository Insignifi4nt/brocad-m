import type { CadDiagnostic, CadKernelOperation } from '../../../domain/cad/cadDocument';
import { CadError } from '../../../domain/cad/cadError';
import { MAX_CAD_KERNEL_MESSAGE, type CadRefusalFactCode, type CadRefusalFacts } from '../../../domain/cad/cadIssueCodes';

/** The step a feature's rebuild is taking and the input it reads, which a failure in that step names. */
export interface CadKernelStep { readonly operation: CadKernelOperation; readonly input: { readonly field: string; readonly id: string } | null }

/**
 * What a step that failed in the kernel's own words tells the user: the step, its likely cause and the repair. The kernel's text says
 * none of these, so it is kept only as a detail.
 */
const STEP_FAILURES: Readonly<Record<CadKernelOperation, string>> = {
  import: 'The imported solid could not be rebuilt. The file may hold damaged or open geometry; export it again from the program that made it.',
  profile: 'The sketch profile could not be turned into a face. A contour may cross itself or be too small; edit the sketch.',
  extrude: 'The extrusion could not be built from its sketch. A contour may cross itself or the distance may be too small; edit the sketch or the distance.',
  revolve: 'The revolution could not be built from its sketch. The profile may cross or touch the axis; keep it on one side of the axis or change the angle.',
  loft: 'The loft could not connect its sections. The sections may twist against each other or differ too much; revise their shapes or try ruled mode.',
  sweep: 'The sweep could not follow its curve. The section may be too large for a bend in the curve; reduce the section or ease the bend.',
  pocket: 'The pocket could not be cut. Its profile may miss the body or cross itself; edit the sketch or choose another target.',
  join: 'The bodies could not be joined. They may touch only along a face or an edge; overlap them or move them apart.',
  cut: 'The cut could not be made. The tool may touch the body only along a face or an edge; overlap it with the body or move it away.',
  intersect: 'The intersection could not be made. The bodies may not share material; move them so they overlap.',
  fillet: 'The fillet could not be applied. The radius may be too large for an edge or a face next to it; reduce the radius or choose other edges.',
  chamfer: 'The chamfer could not be applied. The distance may be too large for an edge or a face next to it; reduce the distance or choose other edges.',
  shell: 'The shell could not be made. The thickness may be too large for a thin or curved region; reduce the thickness or choose another opening.',
  transform: 'The body could not be moved. A translation or rotation value may be out of range; revise the values.',
  mirror: 'The body could not be mirrored. Choose another mirror plane.',
  pattern: 'The pattern could not be built. Copies may touch each other only along a face or an edge; change the spacing or the count.',
  check: 'The result is not a valid closed solid. A dimension may make faces meet or vanish; revise the inputs of this feature.',
  record: 'The result could not be prepared for display and selection. A dimension may make a face too small to draw; revise the dimensions of this feature slightly.',
};

/**
 * The failure of feature `featureId` in `step`: a refusal keeps its code, message and facts, and kernel text gets a message that names the
 * step, cause and repair.
 */
export function cadKernelFailure(featureId: string, error: unknown, step: CadKernelStep): CadDiagnostic {
  if (!(error instanceof CadError)) return { code: 'kernel-operation-failed', featureId, message: STEP_FAILURES[step.operation],
    details: { operation: step.operation, input: step.input, kernelMessage: cadKernelMessage(error) } };
  return { code: error.code, featureId, message: error.message, details: { operation: step.operation, input: step.input, kernelMessage: error.kernelMessage ?? null },
    ...(error.facts ? { facts: error.facts } : {}) };
}

/** What each worker request reports when the kernel fails in its own words. */
const REQUEST_FAILURES: Readonly<Record<string, string>> = {
  build: 'The part could not be rebuilt. Rebuild again; if this repeats, undo the last change.',
  export: 'The part could not be written to the file. Rebuild the part and export again.',
  section: 'The section could not be cut through this body. Move the section plane slightly or choose another body.',
  'inspect-topology': 'The faces and edges of this body could not be read. Rebuild the part and select again.',
  'resolve-topology-picks': 'The faces and edges of this body could not be read. Rebuild the part and select again.',
  'inspect-adjacency': 'The faces and edges of this body could not be read. Rebuild the part and select again.',
  'inspect-tangent-chain': 'The faces and edges of this body could not be read. Rebuild the part and select again.',
  'import-solid': 'The file could not be read as a solid. It may be damaged or hold no closed solid; export it again from the program that made it.',
  'import-dxf': 'The DXF file could not be read. It may be damaged; save it again as DXF and retry.',
  'import-dxf-curve': 'The DXF file could not be read. It may be damaged; save it again as DXF and retry.',
};

/** What an error reply carries: a code, a message, the kernel's own words apart from it, and the facts of a code that carries them. */
export interface CadKernelRequestFailure {
  readonly code: string; readonly message: string; readonly kernelMessage?: string; readonly facts?: CadRefusalFacts[CadRefusalFactCode];
}
/** The error reply of worker request `kind`: a refusal keeps its code, message and facts, and kernel text gets the request's message, with the text apart. */
export function cadKernelRequestFailure(kind: string, error: unknown): CadKernelRequestFailure {
  if (error instanceof CadError) return { code: error.code, message: error.message, ...(error.kernelMessage ? { kernelMessage: error.kernelMessage } : {}), ...(error.facts ? { facts: error.facts } : {}) };
  const kernelMessage = cadKernelMessage(error);
  return { code: 'kernel-operation-failed', message: REQUEST_FAILURES[kind] ?? 'The CAD kernel could not complete this operation.', ...(kernelMessage ? { kernelMessage } : {}) };
}

/** The kernel's own text for a failure, bounded; null when it gave none. */
export function cadKernelMessage(error: unknown): string | null {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : typeof error === 'number' ? `Native exception ${error}` : '';
  return text ? text.slice(0, MAX_CAD_KERNEL_MESSAGE) : null;
}
