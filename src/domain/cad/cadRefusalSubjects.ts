import { CadError } from './cadError';
import type { CadIssueSubject } from './cadIssues';

/** Where a refusal was raised: the feature or input slot the document check was reading, the document, or a CAM step and its source. */
export type CadRefusalSubject = Extract<CadIssueSubject, { readonly kind: 'document' | 'feature' | 'reference-slot' | 'cam-operation' }>;
const subjects = new WeakMap<CadError, CadRefusalSubject>();

/**
 * Records that refusal `error` was raised at `subject`, unless a step it passed through first recorded a nearer one, and returns it to be
 * thrown again. Anything but a `CadError` passes through unrecorded. The refusal itself, its code and its message are unchanged.
 */
export function cadRefusalAt<E>(error: E, subject: CadRefusalSubject): E {
  if (error instanceof CadError && !subjects.has(error)) subjects.set(error, Object.freeze({ ...subject }));
  return error;
}

/** Where refusal `error` was recorded as raised, or undefined when no step recorded it. */
export function cadRefusalSubject(error: CadError): CadRefusalSubject | undefined { return subjects.get(error); }
