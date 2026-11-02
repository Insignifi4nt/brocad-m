import { MAX_CAD_KERNEL_MESSAGE, cadBoundedText, isCadRefusalFactCode, isCadRefusalFacts, type CadRefusalFactCode, type CadRefusalFacts } from './cadIssueCodes';

/**
 * What a refusal with code `C` takes after its message: the facts its code carries, or nothing for a code that carries none. A code known
 * only as a string, or a union of codes that differ in this, takes `never`, so no call type-checks: raise those through `CadError.checked`.
 */
export type CadErrorFacts<C extends string> = string extends C ? [facts: never]
  : [C] extends [CadRefusalFactCode] ? [facts: CadRefusalFacts[C]]
  : [Extract<C, CadRefusalFactCode>] extends [never] ? [] : [facts: never];

/**
 * A refusal with a stable code and a message for the user. A code that carries facts (`CadRefusalFacts`) is raised with them, and no
 * other code with any: the constructor's types require this of a literal code, `CadError.checked` is the path for a code known only at
 * run time, and both check it as they run, so no refusal lacks the facts of its code. Raising one otherwise is a programming error,
 * which throws rather than make a refusal its readers would misread.
 * `kernelMessage` keeps the kernel's own words for a refusal that came back from the worker; the message never repeats them.
 */
export class CadError<C extends string = string> extends Error {
  readonly code: string;
  readonly facts?: CadRefusalFacts[CadRefusalFactCode];
  readonly kernelMessage?: string;
  constructor(code: C, message: string, ...facts: CadErrorFacts<C>) {
    super(message);
    this.name = 'CadError';
    this.code = code;
    const [given] = facts as readonly unknown[];
    if (isCadRefusalFactCode(code) ? !isCadRefusalFacts(code, given) : given !== undefined) {
      throw new Error(`Refusal ${code} is raised ${given === undefined ? 'without its facts' : 'with facts other than those its code carries'}.`);
    }
    if (given) this.facts = Object.freeze({ ...(given as CadRefusalFacts[CadRefusalFactCode]) });
  }

  /** The refusal of a code known only at run time, with exactly the facts `code` carries, and none for a code that carries none. */
  static checked(code: string, message: string, facts?: unknown): CadError {
    const raise = CadError as unknown as new (code: string, message: string, ...facts: unknown[]) => CadError;
    return facts === undefined ? new raise(code, message) : new raise(code, message, facts);
  }

  /** The refusal a worker reply carries back, checked as `checked` does, with the kernel's own text bounded. */
  static received(code: string, message: string, extra: { readonly facts?: CadRefusalFacts[CadRefusalFactCode]; readonly kernelMessage?: string }): CadError {
    const error = CadError.checked(code, message, extra.facts);
    if (extra.kernelMessage) (error as { kernelMessage?: string }).kernelMessage = cadBoundedText(extra.kernelMessage, MAX_CAD_KERNEL_MESSAGE);
    return error;
  }
}
