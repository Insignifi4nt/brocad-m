import type { CadRefusalFactCode, CadRefusalFacts } from './cadIssueCodes';

/**
 * A refusal with a stable code and a message for the user. A code that carries facts (`CadRefusalFacts`) is raised with them, and
 * `isCadRefusalFacts` holds them to the code wherever they cross a boundary. `kernelMessage` keeps the kernel's own words for a refusal
 * that came back from the worker; the message never repeats them.
 */
export class CadError extends Error {
  readonly facts?: CadRefusalFacts[CadRefusalFactCode];
  readonly kernelMessage?: string;
  constructor(code: 'selection-count-mismatch', message: string, facts: CadRefusalFacts['selection-count-mismatch']);
  constructor(code: 'selection-empty', message: string, facts: CadRefusalFacts['selection-empty']);
  constructor(code: string, message: string);
  constructor(readonly code: string, message: string, facts?: CadRefusalFacts[CadRefusalFactCode]) {
    super(message);
    this.name = 'CadError';
    if (facts) this.facts = Object.freeze({ ...facts });
  }

  /** The refusal a worker reply carries back, its facts and kernel text already checked by the reply guard. */
  static received(code: string, message: string, extra: { readonly facts?: CadRefusalFacts[CadRefusalFactCode]; readonly kernelMessage?: string }): CadError {
    const error = new CadError(code, message), writable = error as { facts?: CadError['facts']; kernelMessage?: string };
    if (extra.facts) writable.facts = Object.freeze({ ...extra.facts });
    if (extra.kernelMessage) writable.kernelMessage = extra.kernelMessage;
    return error;
  }
}
