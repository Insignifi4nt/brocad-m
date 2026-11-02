import { CadError } from './cadError';
import { isCadCamCode, isCadExportCode, isCadRefusalCode, isCadRefusalFacts, type CadRefusalFactCode, type CadRefusalFacts } from './cadIssueCodes';
import { createCadIssue, type CadCamIssueOf, type CadExportIssueOf, type CadFeatureIssueOf } from './cadIssues';
import { cadRefusalSubject, type CadRefusalMark } from './cadRefusalSubjects';

/** A refusal as the issue model gives it: a feature's, a CAM step's or an export step's. */
export type CadRefusalIssue = CadFeatureIssueOf | CadCamIssueOf | CadExportIssueOf;

/**
 * The issue of refusal `error`, the one adapter for refusals raised outside a build:
 * - a CAM step's refusal (sending a sketch to CAM, a Section for CAM), about the operation and its source, as that step recorded it, with
 *   any code the step can raise (`CAD_CAM_STEP_CODES`);
 * - an export step's refusal (a section, sketch or reference curve DXF export), about the export and its source, as that step recorded it, with any code the step
 *   can raise (`CAD_EXPORT_STEP_CODES`);
 * - the document check's refusal with a code a feature can be refused with, about the feature or input slot it was checking, or the
 *   document when it was checking none, with the facts its code carries.
 * Where it was raised is what the steps of the reader's operation recorded (`since`, when the reader marked its start), never a step of
 * an earlier operation that raised the same refusal. Its message is the refusal's own. It has no repairs, since a refused edit was never applied and leaves nothing to repair, and no causes.
 * Null for any other refusal, which its own producer reports (a sketch refusal) or which is no problem of the part (a stale version). A CAM
 * or export step's other failures are no problem of the step or its source either, so they give null too:
 * - `kernel-unavailable`: the kernel could not be loaded, or its worker could not be started or handed the request, failed with an
 *   unexpected error, or sent a reply that could not be read, which fails every request alike;
 * - a cancelled request, a stale version or workflow, or a kernel result that does not match the request, which are no `CadError`;
 * - a request the controller refuses before the step names its source, such as a malformed section request;
 * - a disposed model or kernel client, or a full request queue, which are no `CadError` either.
 */
export function cadRefusalIssue(error: unknown, key = 'refusal', since?: CadRefusalMark): CadRefusalIssue | null {
  if (!(error instanceof CadError)) return null;
  const { code, message } = error, subject = cadRefusalSubject(error, since);
  const common = { key, severity: 'error', state: 'failed', message, causes: [], repairs: [] } as const;
  if (subject?.kind === 'cam-operation') {
    if (subject.operation === 'section') return isCadCamCode('section', code) ? createCadIssue({ ...common, namespace: 'cam', code, subject: { ...subject, operation: 'section' }, details: {} }) : null;
    return isCadCamCode('send-sketch', code) ? createCadIssue({ ...common, namespace: 'cam', code, subject: { ...subject, operation: 'send-sketch' }, details: {} }) : null;
  }
  if (subject?.kind === 'export-operation') {
    if (subject.format === 'dxf-sketch') return isCadExportCode('dxf-sketch', code) ? createCadIssue({ ...common, namespace: 'export', code, subject: { ...subject, format: 'dxf-sketch' }, details: {} }) : null;
    if (subject.format === 'dxf-curve') return isCadExportCode('dxf-curve', code) ? createCadIssue({ ...common, namespace: 'export', code, subject: { ...subject, format: 'dxf-curve' }, details: {} }) : null;
    return isCadExportCode('dxf-section', code) ? createCadIssue({ ...common, namespace: 'export', code, subject: { ...subject, format: 'dxf-section' }, details: {} }) : null;
  }
  if (!isCadRefusalCode(code) || code === 'rebuild-stopped') return null;
  const at = subject ?? { kind: 'document' } as const;
  /** The facts code `fact` carries; raising a refusal checks them, so a fact code without them is a programming error. */
  const factsOf = <C extends CadRefusalFactCode>(fact: C): CadRefusalFacts[C] => {
    if (!isCadRefusalFacts(fact, error.facts)) throw new Error(`The ${fact} refusal gives no facts.`);
    return error.facts as CadRefusalFacts[C];
  };
  switch (code) {
    case 'selection-count-mismatch': return createCadIssue({ ...common, namespace: 'feature', code, subject: at, details: factsOf(code) });
    case 'selection-empty': return createCadIssue({ ...common, namespace: 'feature', code, subject: at, details: factsOf(code) });
    default: return createCadIssue({ ...common, namespace: 'feature', code, subject: at, details: {} });
  }
}
