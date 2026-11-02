import type { CadRefusalFactCode, CadRefusalFacts } from './cadIssueCodes';

/**
 * A refusal with a stable code and a message for the user. A code that carries facts (`CadRefusalFacts`) is raised with them, and
 * `isCadRefusalFacts` holds them to the code wherever they cross a boundary.
 */
export class CadError extends Error {
  readonly facts?: CadRefusalFacts[CadRefusalFactCode];
  constructor(code: 'selection-count-mismatch', message: string, facts: CadRefusalFacts['selection-count-mismatch']);
  constructor(code: 'selection-empty', message: string, facts: CadRefusalFacts['selection-empty']);
  constructor(code: string, message: string);
  constructor(readonly code: string, message: string, facts?: CadRefusalFacts[CadRefusalFactCode]) {
    super(message);
    this.name = 'CadError';
    if (facts) this.facts = Object.freeze({ ...facts });
  }
}
