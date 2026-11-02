import { CadError } from './cadError';
import { isCadCamCode, isCadRefusalCode, isCadRefusalFacts, type CadRefusalFactCode, type CadRefusalFacts } from './cadIssueCodes';
import { createCadIssue, type CadCamIssueOf, type CadFeatureIssueOf } from './cadIssues';
import { cadRefusalSubject } from './cadRefusalSubjects';

/** A refusal as the issue model gives it: a feature's, or a CAM step's. */
export type CadRefusalIssue = CadFeatureIssueOf | CadCamIssueOf;

/**
 * The issue of refusal `error`, the one adapter for refusals raised outside a build:
 * - a CAM step's refusal (sending a sketch to CAM, a Section for CAM), about the operation and its source, as that step recorded it;
 * - the document check's refusal with a code a feature can be refused with, about the feature or input slot it was checking, or the
 *   document when it was checking none, with the facts its code carries.
 * Its message is the refusal's own. It has no repairs, since a refused edit was never applied and leaves nothing to repair, and no causes.
 * Null for any other refusal, which its own producer reports (a sketch refusal) or which is no problem of the part (a stale version).
 */
export function cadRefusalIssue(error: unknown, key = 'refusal'): CadRefusalIssue | null {
  if (!(error instanceof CadError)) return null;
  const { code, message } = error, subject = cadRefusalSubject(error);
  const common = { key, severity: 'error', state: 'failed', message, causes: [], repairs: [] } as const;
  if (subject?.kind === 'cam-operation') return isCadCamCode(code) ? createCadIssue({ ...common, namespace: 'cam', code, subject, details: {} }) : null;
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
