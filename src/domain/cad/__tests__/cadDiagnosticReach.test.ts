import ts from '@typescript/typescript6';
import { describe, expect, it } from 'vitest';
import { CadSourceIndex, cadDiagnosticReach, type CadDiagnosticReachOptions } from './cadDiagnosticReach';
import { cadSkippedMemberReads } from './cadMemberReads';

const FILE = 'src/check.ts';
/** The `CadError` class with its two factories, shaped as the application's, which a source that declares none raises. */
const CAD_ERROR = `class CadError extends Error {
  constructor(readonly code: string, message: string, readonly facts?: unknown) { super(message); }
  static checked(code: string, message: string, facts?: unknown) { return facts === undefined ? new CadError(code, message) : new CadError(code, message, facts); }
  static received(code: string, message: string, extra: object) { return CadError.checked(code, message); }
}`;
/** What the walk finds from `check`, the export of one source file, having checked that it followed or reported every member read. */
const walk = (source: string, options?: CadDiagnosticReachOptions) => {
  const index = new CadSourceIndex({ [FILE]: /\bclass CadError\b/.test(source) ? source : `${source}\n${CAD_ERROR}` });
  const found = cadDiagnosticReach(index, index.exported(FILE, 'check', new Set()), options);
  expect(cadSkippedMemberReads(index, found), 'member reads skipped silently').toEqual([]);
  return found;
};
/** The report of a name the walk cannot resolve, which a source that declares nothing by that name uses. */
const UNFOUND = (name: string) => `${FILE}: ${name}, a name the walk cannot resolve to a declaration of the source`;
/** The codes and unread sites it finds. */
const reach = (source: string, options?: CadDiagnosticReachOptions) => {
  const found = walk(source, options);
  return { codes: [...found.codes].sort(), unexpanded: found.unexpanded };
};

describe('CAD diagnostic reach', () => {
  it('reads a code held by a constant, or by a constant object', () => {
    expect(reach(`export function check() { const code = 'new-code'; throw new CadError(code, 'failure'); }`))
      .toEqual({ codes: ['new-code'], unexpanded: [] });
    expect(reach(`const CODE = 'shared-code';
      export function check(kind: string) { const issue = { code: \`new-\${kind}\`, message: 'failure' }; if (kind) throw new CadError(issue.code, issue.message); throw new CadError(CODE, ''); }`,
    { templates: { [`${FILE}: kind`]: ['cut', 'pocket'] } })).toEqual({ codes: ['new-cut', 'new-pocket', 'shared-code'], unexpanded: [] });
  });

  it('reports a template code nothing expands, and a code whose origin it cannot read', () => {
    expect(reach(`export function check(kind: string) { const issue = { code: \`new-\${kind}\`, message: 'failure' }; throw new CadError(issue.code, issue.message); }`))
      .toEqual({ codes: [], unexpanded: [`${FILE}: kind`] });
    expect(reach(`export function check(kind: string) {
      let code = 'first'; code = kind;
      if (kind === 'a') throw new CadError(code, '');
      if (kind === 'b') throw new CadError(codeFor(kind), '');
      const refusal = { code: 'hidden', ...extra(kind) };
      throw new CadError(refusal.code, '');
    }`).unexpanded).toEqual([`${FILE}: code`, `${FILE}: codeFor(kind), from ${FILE}: codeFor(…)`, UNFOUND('codeFor'), UNFOUND('extra'), `${FILE}: refusal.code, from ${FILE}: extra(…).code`]);
  });

  it('reads a parameter at each call the walk reaches, and reports a function passed on', () => {
    const source = `const refuse = (refusal: { code: string }) => new CadError(refusal.code, '');
      const TABLE = { pair: { code: 'pair-refusal' }, slots: [{ refusal: { code: 'slot-refusal' } }, { role: 'end' }] } as const;
      export function check(kind: string) {
        if (kind === 'a') throw refuse({ code: 'literal-refusal' });
        if (kind === 'b') throw refuse(TABLE.pair);
        for (const slot of TABLE.slots) if (slot.refusal) throw refuse(slot.refusal);
        TABLE.slots.forEach(slot => { if (slot.refusal) throw refuse(slot.refusal); });
      }
      export function unused() { throw refuse({ code: 'unreached-refusal' }); }`;
    expect(reach(source)).toEqual({ codes: ['literal-refusal', 'pair-refusal', 'slot-refusal'], unexpanded: [] });
    expect(reach(`${source}\nexport const later = () => [1].map(refuse);`).unexpanded).toEqual([]);
    expect(reach(source.replace('TABLE.slots.forEach(', 'later(refuse); TABLE.slots.forEach(')).unexpanded).toEqual([UNFOUND('later'), `${FILE}: refuse passed on`]);
  });

  it('takes a caught error\'s code where it is read, and lists the site', () => {
    const found = walk(`function parse() { throw new CadError('parse-refusal', ''); }
      export function check() { try { parse(); } catch (error) { if (error instanceof CadError) return { code: error.code }; } }`);
    expect({ codes: [...found.codes], unexpanded: found.unexpanded, taken: found.taken })
      .toEqual({ codes: ['parse-refusal'], unexpanded: [], taken: [`${FILE}: error.code`] });
  });

  it('reads the code of what a call returns through the function it calls, computed literal keys included', () => {
    const check = `export function check(sketch: { name: string }) {
      const inspection = inspect(sketch);
      if (!inspection.eligible) throw new CadError(inspection.code, inspection.message);
    }`;
    expect(walk(`function inspect(sketch: { name: string }) {
        if (!sketch.name) return { eligible: false, ['code']: 'new-loft-refusal', message: 'failure' };
        return Object.freeze({ eligible: true, section: sketch });
      }
      ${check}`)).toMatchObject({ codes: new Set(['new-loft-refusal']), unexpanded: [], taken: [] });
    // A key named by a constant is no `code` property where it is written, but may be the one a call's result is read by.
    expect(reach(`const CODE = 'code';
      function inspect(sketch: { name: string }) { return sketch.name ? { eligible: true } : { eligible: false, [CODE]: 'keyed-refusal', message: 'failure' }; }
      ${check}`)).toEqual({ codes: ['keyed-refusal'], unexpanded: [] });
    // Through a helper, a table entry read by a key it cannot tell, a destructured constant and a function the table holds.
    expect(reach(`const missing = (message: string) => ({ code: 'missing-point', message });
      const KINDS = {
        pair: { stored: { refusal: { code: 'pair-refusal' } } },
        point: { stored: (fixed: boolean) => fixed ? { refusal: missing('none') } : { refusal: { code: 'point-refusal' } } }
      } as const;
      function signature(kind: keyof typeof KINDS) { const { stored } = KINDS[kind]; return typeof stored === 'function' ? stored(true) : stored; }
      export function check(kind: keyof typeof KINDS) { throw new CadError(signature(kind).refusal.code, ''); }`))
      .toEqual({ codes: ['missing-point', 'pair-refusal', 'point-refusal'], unexpanded: [] });
  });

  it('follows a method called on another receiver through the receiver\'s type, not its name', () => {
    // The only method of that name in the source is no method of a platform receiver.
    expect(reach(`class Timer { abort() { throw new CadError('timer-refusal', ''); } }
      export function check(controller: AbortController) { new Timer(); controller.abort(); }`)).toEqual({ codes: [], unexpanded: [] });
    // Another method of the same name hides none of the receiver's, and adds none of its own.
    expect(reach(`class Timer { start() { throw new CadError('timer-refusal', ''); } }
      class Motor { start() { throw new CadError('motor-refusal', ''); } }
      export function check(timer: Timer) { timer.start(); }`)).toEqual({ codes: ['timer-refusal'], unexpanded: [] });
    expect(reach(`class Timer { start() { throw new CadError('timer-refusal', ''); } }
      class Countdown extends Timer { override start() { throw new CadError('countdown-refusal', ''); } }
      export function check(timer: Timer) { timer.start(); }`).codes).toEqual(['countdown-refusal', 'timer-refusal']);
  });

  it('follows overrides through every level of subclass, and only those a receiver of that type can be', () => {
    // A subclass of a subclass that overrides again runs its own method.
    expect(reach(`class Base { run() { throw new CadError('base-code', ''); } }
      class Middle extends Base { override run() { throw new CadError('middle-code', ''); } }
      class Leaf extends Middle { override run() { throw new CadError('leaf-code', ''); } }
      export function check(value: Base) { value.run(); }`)).toEqual({ codes: ['base-code', 'leaf-code', 'middle-code'], unexpanded: [] });
    // So does one below a level that inherits the method unchanged.
    expect(reach(`class Base { run() { throw new CadError('base-code', ''); } }
      class Middle extends Base { readonly middle = true; }
      class Leaf extends Middle { override run() { throw new CadError('leaf-code', ''); } }
      export function check(value: Base) { value.run(); }`).codes).toEqual(['base-code', 'leaf-code']);
    // A sibling's override is no method a receiver of the narrower type runs; a subclass of that type's still is.
    expect(reach(`class Base { run() { throw new CadError('base-code', ''); } }
      class Left extends Base { readonly left = true; }
      class Right extends Base { override run() { throw new CadError('right-code', ''); } }
      class LeftLeaf extends Left { override run() { throw new CadError('left-leaf-code', ''); } }
      export function check(value: Left) { value.run(); }`)).toEqual({ codes: ['base-code', 'left-leaf-code'], unexpanded: [] });
  });

  it('follows a method passed on as a value, given to a call or held by a constant, and reports any other use of one', () => {
    const method = `class Step { run() { throw new CadError('step-code', ''); } readonly name = 'step'; }`;
    // A callback, a function a helper calls, and a constant holding the method.
    expect(reach(`${method} export function check(value: Step) { [1].forEach(value.run); }`)).toEqual({ codes: ['step-code'], unexpanded: [] });
    expect(reach(`${method} function invoke(run: () => void) { run(); } export function check(value: Step) { invoke(value.run); }`)).toEqual({ codes: ['step-code'], unexpanded: [] });
    expect(reach(`${method} export function check(value: Step) { const run = value.run; run(); }`)).toEqual({ codes: ['step-code'], unexpanded: [] });
    // A non-null assertion or parentheses around a direct call, and an explicit call through call or apply.
    expect(reach(`${method} export function check(value: Step | undefined) { value!.run!(); (value!.run)(); value!.run.call(value); }`)).toEqual({ codes: ['step-code'], unexpanded: [] });
    // Testing whether an optional method is there gives it nowhere.
    expect(reach(`class Optional { run?(): void } export function check(value: Optional) { if (value.run) {} return !value.run || typeof value.run === 'function' || (value.run && 1) || (value.run ? 1 : 0); }`)).toEqual({ codes: [], unexpanded: [] });
    // Reading a field that holds no function is no use of a method.
    expect(reach(`${method} export function check(value: Step) { return value.name.length; }`)).toEqual({ codes: [], unexpanded: [] });
    // Any other use is reported rather than read as holding no code.
    expect(reach(`${method} export function check(value: Step) { return { later: value.run }; }`)).toEqual({ codes: [], unexpanded: [`${FILE}: value.run, a method used as a value the walk does not follow`] });
    expect(reach(`${method} export function check(value: Step) { let run = value.run; run = () => {}; run(); }`).unexpanded).toEqual([`${FILE}: value.run, a method used as a value the walk does not follow`]);
    // A receiver whose type declares nothing is reported as before.
    expect(reach(`${method} export function check(value: any) { [1].forEach(value.run); }`).unexpanded).toEqual([`${FILE}: value.run, a method its receiver's type does not declare`]);
  });

  it('runs the members of the objects and classes that fit an interface\'s, unless the interface is stopped', () => {
    const source = `interface Step { run(): void }
      const STEPS: Step[] = [{ run() { throw new CadError('step-refusal', ''); } }];
      const later = Object.freeze({ run: () => { throw new CadError('frozen-refusal', ''); } });
      class Unrelated { run(times: number) { throw new CadError('unrelated-refusal', String(times)); } }
      export function check(step: Step) { step.run(); }`;
    expect(reach(source)).toEqual({ codes: ['frozen-refusal', 'step-refusal'], unexpanded: [] });
    expect(reach(source, { stop: new Set([`${FILE}:Step`]) })).toEqual({ codes: [], unexpanded: [] });
    expect(reach(source.replace('check(step: Step)', 'check(step: any)')).unexpanded).toEqual([`${FILE}: step.run, a method its receiver's type does not declare`]);
  });

  it('reports what a call returns when it cannot read it', () => {
    const check = `export function check(sketch: { name: string }) {
      const inspection = inspect(sketch);
      if (!inspection.eligible) throw new CadError(inspection.code, inspection.message);
    }`;
    expect(reach(`function inspect(sketch: { name: string }) { return cache.get(sketch.name); }\n${check}`).unexpanded)
      .toEqual([UNFOUND('cache'), `${FILE}: inspection.code, from ${FILE}: cache.get(…).code`]);
    expect(reach(`function inspect(sketch: { name: string }) { let result = { eligible: true }; if (!sketch.name) result = { eligible: false, code: 'empty' }; return result; }\n${check}`).unexpanded)
      .toEqual([`${FILE}: inspection.code, from ${FILE}: result.code`]);
    expect(reach(`function inspect(sketch: { name: string }) { return new Inspection(sketch); }\n${check}`).unexpanded)
      .toEqual([`${FILE}: Inspection, a class the walk cannot tell, constructed`, UNFOUND('Inspection'), `${FILE}: inspection.code, from ${FILE}: new Inspection(sketch).code`]);
  });
});

// Each walk builds a TypeScript program of its own.
describe('CAD diagnostic reach through member reads', { timeout: 30_000 }, () => {
  const steps = `class Steps {
      first() { throw new CadError('first-code', ''); }
      second() { throw new CadError('second-code', ''); }
      third() { throw new CadError('third-code', ''); }
    }`;

  it('runs a getter on every read, a presence test or a destructuring included, and a setter on every write', () => {
    const shape = `class Shape {
        get area() { throw new CadError('area-code', ''); }
        set area(value: number) { throw new CadError('set-area-code', String(value)); }
        get name() { return 'shape'; }
      }`;
    expect(reach(`${shape} export function check(shape: Shape) { if (shape.area) {} }`)).toEqual({ codes: ['area-code'], unexpanded: [] });
    expect(reach(`${shape} export function check(shape: Shape) { return typeof shape.area === 'number'; }`).codes).toEqual(['area-code']);
    expect(reach(`${shape} export function check(shape: Shape) { const value = shape.area; return value; }`).codes).toEqual(['area-code']);
    expect(reach(`${shape} export function check(shape: Shape) { shape.area = 1; }`).codes).toEqual(['set-area-code']);
    // A compound assignment reads and writes.
    expect(reach(`${shape} export function check(shape: Shape) { shape.area += 1; }`).codes).toEqual(['area-code', 'set-area-code']);
    expect(reach(`${shape} export function check(shape: Shape) { const { area } = shape; return area; }`).codes).toEqual(['area-code']);
    expect(reach(`${shape} export function check({ area }: Shape) { return area; }`).codes).toEqual(['area-code']);
    expect(reach(`${shape} export function check(shape: Shape) { const { name } = shape; return name; }`).codes).toEqual([]);
    // An object's getters are a class's: one read runs it, a rest element or a spread takes every own getter.
    const held = `const SHAPE = { get area(): number { throw new CadError('object-area-code', ''); }, size: 1 };`;
    expect(reach(`${held} export function check() { return SHAPE.area ? 1 : 0; }`)).toEqual({ codes: ['object-area-code'], unexpanded: [] });
    expect(reach(`${held} export function check() { return SHAPE.size; }`)).toEqual({ codes: [], unexpanded: [] });
    expect(reach(`${held} export function check() { const { ...rest } = SHAPE; return rest; }`).codes).toEqual(['object-area-code']);
    expect(reach(`${held} export function check() { return { ...SHAPE }; }`).codes).toEqual(['object-area-code']);
  });

  it('runs an object\'s method as a class\'s: when called or given on, not when tested, and reports any other use', () => {
    const held = `const STEPS = { run() { throw new CadError('run-code', ''); }, name: 'steps' };`;
    expect(reach(`${held} export function check() { if (STEPS.run) {} return STEPS.name; }`)).toEqual({ codes: [], unexpanded: [] });
    expect(reach(`${held} export function check() { STEPS.run(); }`)).toEqual({ codes: ['run-code'], unexpanded: [] });
    expect(reach(`${held} export function check() { [1].forEach(STEPS.run); }`)).toEqual({ codes: ['run-code'], unexpanded: [] });
    expect(reach(`${held} export function check() { return { later: STEPS.run }; }`))
      .toEqual({ codes: [], unexpanded: [`${FILE}: STEPS.run, a method used as a value the walk does not follow`] });
    // Given on whole, any of its methods may be called.
    expect(reach(`${held} function use(value: object) { return value; } export function check() { use(STEPS); }`).codes).toEqual(['run-code']);
    // Its method's `this` is the object, whose other methods it calls.
    expect(reach(`const PAIR = { start() { this.finish(); }, finish() { throw new CadError('finish-code', ''); }, idle() { throw new CadError('idle-code', ''); } };
      export function check() { PAIR.start(); }`)).toEqual({ codes: ['finish-code'], unexpanded: [] });
  });

  it('follows a call on `this` to the method and to every override below its class', () => {
    const classes = `class Base { run() { this.step(); } step() { throw new CadError('base-step', ''); } }
      class Child extends Base { override step() { throw new CadError('child-step', ''); } }
      class Other { step() { throw new CadError('other-step', ''); } }`;
    expect(reach(`${classes} export function check(value: Base) { value.run(); }`)).toEqual({ codes: ['base-step', 'child-step'], unexpanded: [] });
    // An inherited method is walked once, for every receiver its class's `this` can be.
    expect(reach(`${classes} export function check(value: Child) { value.run(); }`)).toEqual({ codes: ['base-step', 'child-step'], unexpanded: [] });
    expect(reach(`class Base { run() { this.step(); } step() {} }
      class Child extends Base { override step() { super.step(); throw new CadError('child-step', ''); } }
      export function check(value: Base) { value.run(); }`)).toEqual({ codes: ['child-step'], unexpanded: [] });
  });

  it('reads an element by a literal key, a constant naming one or a key whose type allows only literals, and reports one it cannot tell', () => {
    expect(reach(`${steps} export function check(steps: Steps) { steps['first'](); }`)).toEqual({ codes: ['first-code'], unexpanded: [] });
    expect(reach(`${steps} const KEY = 'second'; export function check(steps: Steps) { steps[KEY](); }`)).toEqual({ codes: ['second-code'], unexpanded: [] });
    expect(reach(`${steps} export function check(steps: Steps, key: 'first' | 'third') { steps[key](); }`)).toEqual({ codes: ['first-code', 'third-code'], unexpanded: [] });
    expect(reach(`const TABLE = { cut: () => { throw new CadError('cut-code', ''); }, pocket: () => { throw new CadError('pocket-code', ''); } };
      export function check(kind: 'cut' | 'pocket') { TABLE[kind](); }`)).toEqual({ codes: ['cut-code', 'pocket-code'], unexpanded: [] });
    expect(reach(`${steps} export function check(steps: Steps, key: string) { (steps as unknown as Record<string, () => void>)[key](); }`))
      .toEqual({ codes: [], unexpanded: [`${FILE}: (steps as unknown as Record<string, () => void>)[key], an element read by a key the walk cannot tell`] });
    // Read by such a key, a record of values that are no functions and have no getters runs nothing, but one with a getter may.
    expect(reach(`export function check(table: Record<string, number>, key: string) { table[key] = (table[key] ?? 0) + 1; }`)).toEqual({ codes: [], unexpanded: [] });
    expect(reach(`class Shape { get area() { throw new CadError('area-code', ''); } }
      export function check(shape: Shape, key: string) { return (shape as unknown as Shape & Record<string, number>)[key]; }`).unexpanded)
      .toEqual([`${FILE}: (shape as unknown as Shape & Record<string, number>)[key], an element read by a key the walk cannot tell`]);
  });

  it('runs no method that is written over, and reports one written into a variable', () => {
    expect(reach(`${steps} export function check(steps: Steps) { steps.first = () => {}; }`)).toEqual({ codes: [], unexpanded: [] });
    expect(reach(`${steps} export function check(steps: Steps) { let run = steps.first; run = steps.second; run(); }`).unexpanded)
      .toEqual([`${FILE}: steps.first, a method used as a value the walk does not follow`, `${FILE}: steps.second, a method used as a value the walk does not follow`]);
  });

  it('follows a method returned to the caller or bound', () => {
    expect(reach(`${steps} function pick(steps: Steps) { return steps.first; } export function check(steps: Steps) { pick(steps)(); }`))
      .toEqual({ codes: ['first-code'], unexpanded: [] });
    expect(reach(`${steps} const pick = (steps: Steps) => steps.second; export function check(steps: Steps) { pick(steps)(); }`))
      .toEqual({ codes: ['second-code'], unexpanded: [] });
    expect(reach(`${steps} export function check(steps: Steps) { const run = steps.third.bind(steps); run(); }`)).toEqual({ codes: ['third-code'], unexpanded: [] });
  });

  it('reads the code of each way a CadError is raised: checked, received, and the super call of a subclass, through its constructor', () => {
    expect(reach(`const CODE = 'checked-code';
      export function check(facts: unknown) { if (facts) throw CadError.checked(CODE, '', facts); throw CadError.received('received-code', '', {}); }`))
      .toEqual({ codes: ['checked-code', 'received-code'], unexpanded: [] });
    // The factories raise the code their caller gave, read at the call: their bodies, which pass it on, are not walked.
    const factories = `class CadError extends Error {
      constructor(readonly code: string, message: string) { super(message); }
      static checked(code: string, message: string) { return new CadError(code, message); }
      static received(code: string, message: string, extra: object) { return CadError.checked(code, message); }
    }`;
    const raised = walk(`${factories} export function check(facts: unknown) { if (facts) throw CadError.checked('checked-code', ''); throw CadError.received('received-code', '', {}); }`);
    expect([[...raised.codes].sort(), raised.unexpanded, [...raised.declarations].filter(name => /checked|received/.test(name))]).toEqual([['checked-code', 'received-code'], [], []]);
    // A method of that name on another class is walked as any other.
    expect(reach(`${factories} class Other { static received(code: string) { return new CadError(code, ''); } } export function check() { throw Other.received('other-code'); }`).unexpanded)
      .toEqual([`${FILE}: code, from ${FILE}: code`]);
    const refusal =`class Refusal extends CadError { constructor(code: string, message = '') { super(code, message); } }`;
    expect(reach(`${refusal} export function check() { throw new Refusal('refusal-code'); }`)).toEqual({ codes: ['refusal-code'], unexpanded: [] });
    // A subclass without a constructor passes its own arguments on; one with a constructor gives its own.
    expect(reach(`${refusal} class Deeper extends Refusal {} class Named extends Refusal { constructor() { super('named-code'); } }
      export function check(named: boolean) { throw named ? new Named() : new Deeper('deeper-code'); }`)).toEqual({ codes: ['deeper-code', 'named-code'], unexpanded: [] });
    // Testing an instance's class constructs nothing; any other use of the class is reported, since what constructs it is unseen.
    expect(reach(`${refusal} export function check(error: unknown) { if (error instanceof Refusal) return; throw new Refusal('refusal-code'); }`).unexpanded).toEqual([]);
    // A constant that holds the class is followed to its own uses; any other use is reported, since what constructs it is unseen.
    expect(reach(`${refusal} export function check() { const make = Refusal; throw new make('held'); }`)).toEqual({ codes: ['held'], unexpanded: [] });
    expect(reach(`${refusal} export function check() { const kinds = [Refusal]; throw new kinds[0]('hidden'); }`).unexpanded)
      .toEqual([`${FILE}: Refusal passed on`, `${FILE}: kinds[0], a class the walk cannot tell, constructed`]);
    // A class that extends something else raises no CadError by its super call.
    expect(reach(`class Other extends Error { constructor(code: string) { super(code); } } export function check() { throw new Other('not-a-code'); }`).codes).toEqual([]);
  });

  it('knows the class and its factories by the declaration a name resolves to, and reads the code at each call however they are named', () => {
    // By a literal element, through a constant holding the class or a factory or another such constant, and inherited by a subclass.
    expect(reach(`export function check() { throw CadError['checked']('bracket-code', ''); }`)).toEqual({ codes: ['bracket-code'], unexpanded: [] });
    expect(reach(`export function check() { throw CadError['received']('bracket-received', '', {}); }`)).toEqual({ codes: ['bracket-received'], unexpanded: [] });
    expect(reach(`const Failure = CadError; export function check(raw: boolean) { throw raw ? new Failure('alias-new', '') : Failure.checked('alias-code', ''); }`))
      .toEqual({ codes: ['alias-code', 'alias-new'], unexpanded: [] });
    expect(reach(`const make = CadError.checked; export function check() { throw make('alias-make', ''); }`)).toEqual({ codes: ['alias-make'], unexpanded: [] });
    expect(reach(`const make = CadError['received'], again = make; export function check() { throw again('alias-again', '', {}); }`)).toEqual({ codes: ['alias-again'], unexpanded: [] });
    expect(reach(`class Sub extends CadError {} export function check() { throw Sub.checked('sub-code', ''); }`)).toEqual({ codes: ['sub-code'], unexpanded: [] });
    // A namespace import's members.
    const index = new CadSourceIndex({ 'src/errors.ts': `export ${CAD_ERROR} export const make = CadError.checked;`,
      [FILE]: `import * as errors from './errors';
        export function check(kind: number) { if (kind === 1) throw new errors.CadError('ns-new', ''); if (kind === 2) throw errors.make('ns-make', ''); throw errors.CadError.received('ns-received', '', {}); }` });
    const namespaced = cadDiagnosticReach(index, index.exported(FILE, 'check', new Set()));
    expect([[...namespaced.codes].sort(), namespaced.unexpanded, cadSkippedMemberReads(index, namespaced)]).toEqual([['ns-make', 'ns-new', 'ns-received'], [], []]);
  });

  it('follows the class, a subclass and a function that raises through any name, heritage or re-export, and reports a class it cannot tell where it is constructed', () => {
    const ERRORS = { 'src/errors.ts': `export ${CAD_ERROR}` };
    const REFUSAL = { 'src/sub.ts': `import { CadError } from './errors'; export class Refusal extends CadError { constructor(code: string) { super(code, ''); } }` };
    /** What the walk finds from `check` in `src/check.ts` among `files` and the errors module, having checked it skipped nothing. */
    const across = (files: Readonly<Record<string, string>>) => {
      const index = new CadSourceIndex({ ...ERRORS, ...files });
      const found = cadDiagnosticReach(index, index.exported(FILE, 'check', new Set()));
      expect(cadSkippedMemberReads(index, found), 'skipped silently').toEqual([]);
      return { codes: [...found.codes].sort(), unexpanded: found.unexpanded };
    };
    const cases: readonly (readonly [string, Readonly<Record<string, string>>, readonly string[]])[] = [
      // A namespace's member as a heritage, held by a constant by name or element, or constructed by element.
      ['ns-super', { [FILE]: `import * as errors from './errors'; class Refusal extends errors.CadError { constructor() { super('ns-super', ''); } } export function check() { throw new Refusal(); }` }, []],
      ['ns-alias', { [FILE]: `import * as errors from './errors'; const Failure = errors.CadError; export function check() { throw new Failure('ns-alias', ''); }` }, []],
      ['ns-element-alias', { [FILE]: `import * as errors from './errors'; const Failure = errors['CadError']; export function check() { throw new Failure('ns-element-alias', ''); }` }, []],
      ['ns-element-new', { [FILE]: `import * as errors from './errors'; export function check() { throw new errors['CadError']('ns-element-new', ''); }` }, []],
      // A subclass without a constructor, declared or a class expression, is constructed with its base's arguments, at any depth.
      ['subless-new', { [FILE]: `import { CadError } from './errors'; class Sub extends CadError {} export function check() { throw new Sub('subless-new', ''); }` }, []],
      ['subless-super', { [FILE]: `import { CadError } from './errors'; class Mid extends CadError {} class Named extends Mid { constructor() { super('subless-super', ''); } } export function check() { throw new Named(); }` }, []],
      ['class-expression', { [FILE]: `import { CadError } from './errors'; const Sub = class extends CadError {}; export function check() { throw new Sub('class-expression', ''); }` }, []],
      // A subclass with a constructor, and a function, take their codes from each use the walk reaches, through namespaces and constants.
      ['ns-subclass-new', { ...REFUSAL, [FILE]: `import * as sub from './sub'; export function check() { throw new sub.Refusal('ns-subclass-new'); }` }, []],
      ['ns-subclass-extends', { ...REFUSAL, [FILE]: `import * as sub from './sub'; class Deeper extends sub.Refusal {} export function check() { throw new Deeper('ns-subclass-extends'); }` }, []],
      ['ns-subclass-alias', { ...REFUSAL, [FILE]: `import * as sub from './sub'; const Held = sub.Refusal; export function check() { throw new Held('ns-subclass-alias'); }` }, []],
      ['class-expression-constructor', { [FILE]: `import { CadError } from './errors'; const Refusal = class extends CadError { constructor(code: string) { super(code, ''); } };
        export function check() { throw new Refusal('class-expression-constructor'); }` }, []],
      ['ns-function', { 'src/raise.ts': `import { CadError } from './errors'; export function refuse(code: string): never { throw new CadError(code, ''); }`,
        [FILE]: `import * as raise from './raise'; export function check() { raise.refuse('ns-function'); }` }, []],
      // Re-exports: renamed, an import exported on, a namespace exported by name or a namespace import exported on.
      ['renamed', { 'src/barrel.ts': `export { CadError as Failure } from './errors';`, [FILE]: `import { Failure } from './barrel'; export function check() { throw new Failure('renamed', ''); }` }, []],
      ['exported-on', { 'src/barrel.ts': `import { CadError } from './errors'; export { CadError };`, [FILE]: `import { CadError } from './barrel'; export function check() { throw new CadError('exported-on', ''); }` }, []],
      ['barrel-namespace', { 'src/barrel.ts': `export * as errors from './errors';`, [FILE]: `import { errors } from './barrel'; export function check() { throw new errors.CadError('barrel-namespace', ''); }` }, []],
      ['namespace-on', { 'src/barrel.ts': `import * as errors from './errors'; export { errors };`, 'src/again.ts': `export * from './barrel';`,
        [FILE]: `import { errors } from './again'; export function check() { throw new errors.CadError('namespace-on', ''); }` }, []],
      // A function's calls through a namespace exported by name, or a namespace import exported on and re-exported.
      ['barrel-function', { 'src/raise.ts': `import { CadError } from './errors'; export function refuse(code: string): never { throw new CadError(code, ''); }`,
        'src/barrel.ts': `export * as raise from './raise';`, [FILE]: `import { raise } from './barrel'; export function check() { raise.refuse('barrel-function'); }` }, []],
      ['function-on', { 'src/raise.ts': `import { CadError } from './errors'; export function refuse(code: string): never { throw new CadError(code, ''); }`,
        'src/barrel.ts': `import * as raise from './raise'; export { raise };`, 'src/again.ts': `export * from './barrel';`,
        [FILE]: `import { raise } from './again'; export function check() { raise['refuse']('function-on'); }` }, []],
      // A constant object's property and a readonly field are read where constructed; the class given to them is reported, as it may go anywhere.
      ['object-held', { [FILE]: `import { CadError } from './errors'; const kinds = { Failure: CadError }; export function check() { throw new kinds.Failure('object-held', ''); }` },
        [`${FILE}: CadError, the CadError class used as a value, which the walk cannot follow`]],
      ['readonly-field', { [FILE]: `import { CadError } from './errors'; class Kinds { static readonly Failure = CadError; } export function check() { throw new Kinds.Failure('readonly-field', ''); }` },
        [`${FILE}: CadError, the CadError class used as a value, which the walk cannot follow`]]
    ];
    for (const [code, files, unexpanded] of cases) expect(across(files), code).toEqual({ codes: [code], unexpanded });
    // A class the walk cannot tell is reported where it is constructed, a base given as a parameter included.
    expect(across({ [FILE]: `import { CadError } from './errors'; class Kinds { static Failure = CadError; } export function check() { throw new Kinds.Failure('field', ''); }` }))
      .toEqual({ codes: [], unexpanded: [`${FILE}: CadError, the CadError class used as a value, which the walk cannot follow`, `${FILE}: Kinds.Failure, a class the walk cannot tell, constructed`] });
    expect(across({ [FILE]: `import { CadError } from './errors';
      function mix(Base: typeof CadError) { return class extends Base { constructor() { super('mixed', ''); } }; }
      export function check() { const Mixed = mix(CadError); throw new Mixed(); }` })).toEqual({ codes: [], unexpanded: [`${FILE}: Base, a class the walk cannot tell, constructed`,
      `${FILE}: CadError, the CadError class used as a value, which the walk cannot follow`, `${FILE}: Mixed, a class the walk cannot tell, constructed`] });
    // A constant holding a namespace's class is reported when it is given on.
    expect(across({ [FILE]: `import * as errors from './errors'; const Failure = errors.CadError; export function check() { return [Failure]; }` }))
      .toEqual({ codes: [], unexpanded: [`${FILE}: Failure, a class raising CadError used as a value, which the walk cannot follow`] });
  });

  it('catches, in its check of calls, a raise or a code argument the walk did not read, by what TypeScript resolves each call to', () => {
    const index = new CadSourceIndex({ 'src/errors.ts': `export ${CAD_ERROR}`,
      'src/sub.ts': `import { CadError } from './errors'; export class Refusal extends CadError { constructor(code: string) { super(code, ''); } }`,
      // An overload stands for its implementation.
      'src/raise.ts': `import { CadError } from './errors'; export function refuse(code: 'ns-function'): never; export function refuse(code: string): never { throw new CadError(code, ''); }`,
      [FILE]: `import * as errors from './errors'; import * as sub from './sub'; import * as raise from './raise';
        class Named extends errors.CadError { constructor() { super('ns-super', ''); } }
        const Failure = errors.CadError;
        class Other extends Error { constructor(code: string, message: string) { super(message); } }
        export function check(kind: number) { if (kind === 1) throw new Named(); if (kind === 2) throw new Failure('ns-alias', ''); if (kind === 3) throw new sub.Refusal('ns-subclass');
          if (kind === 4) { const Pick = kind > 4 ? Other : errors.CadError; throw new Pick('ns-either', ''); } raise.refuse('ns-function'); }` });
    const found = cadDiagnosticReach(index, index.exported(FILE, 'check', new Set()));
    expect([[...found.codes].sort(), found.unexpanded, cadSkippedMemberReads(index, found)]).toEqual([['ns-alias', 'ns-either', 'ns-function', 'ns-subclass', 'ns-super'], [], []]);
    // A walk that took none of these raises, as one that knew the class by its own name only did.
    expect(cadSkippedMemberReads(index, { ...found, raises: new Set() })).toEqual([
      `${FILE}: new Failure('ns-alias', ''), a CadError raised whose code the walk did not read`,
      `${FILE}: new Pick('ns-either', ''), a CadError raised whose code the walk did not read`,
      `${FILE}: super('ns-super', ''), a CadError raised whose code the walk did not read`,
      `src/raise.ts: new CadError(code, ''), a CadError raised whose code the walk did not read`,
      `src/sub.ts: super(code, ''), a CadError raised whose code the walk did not read`]);
    // A walk that sought the subclass's and the function's code parameters but found their calls by their own names only.
    expect(cadSkippedMemberReads(index, { ...found, argumentsRead: new Map([...found.argumentsRead.keys()].map(owner => [owner, new Set()])) })).toEqual([
      `${FILE}: new sub.Refusal('ns-subclass'), a call whose code argument the walk did not read`,
      `${FILE}: raise.refuse('ns-function'), a call whose code argument the walk did not read`]);
    // A callee of a union type may run either part's constructor, while TypeScript resolves the construction to the first part's only.
    const either = new CadSourceIndex({ 'src/errors.ts': `export ${CAD_ERROR}`, [FILE]: `import { CadError } from './errors';
      class Other extends Error { constructor(code: string, message: string) { super(message); } }
      export function check(kind: number) { const Pick = kind > 4 ? Other : CadError; throw new Pick('either', ''); }` });
    const constructions: ts.NewExpression[] = [];
    const visit = (node: ts.Node): void => { if (ts.isNewExpression(node)) constructions.push(node); ts.forEachChild(node, visit); };
    visit(either.files.get(FILE)!);
    const classOf = (declaration: ts.Node) => (declaration.parent as ts.ClassDeclaration).name?.text;
    expect(constructions.map(construction => either.calledDeclarations(construction).map(classOf))).toEqual([['Other', 'CadError']]);
  });

  it('reports a raise whose code it cannot read, and a factory or the class used where it cannot read the code', () => {
    const cases: readonly (readonly [string, string])[] = [
      [`export function check(args: [string, string]) { throw CadError.checked(...args); }`, `${FILE}: CadError.checked(...args), a CadError raised with a code the walk cannot read`],
      [`export function check() { throw new CadError(); }`, `${FILE}: new CadError(), a CadError raised with a code the walk cannot read`],
      [`export function check() { [CadError.checked].forEach(raise => { throw raise('given', ''); }); }`, `${FILE}: CadError.checked, a CadError factory given on, whose code the walk cannot read`],
      [`export function check() { throw CadError.checked.call(null, 'called', ''); }`, `${FILE}: CadError.checked, a CadError factory called through call or apply, whose code the walk cannot read`],
      [`const make = CadError.checked; export function check() { return [make]; }`, `${FILE}: make, a CadError factory given on, whose code the walk cannot read`],
      [`export function check() { const { checked } = CadError; throw checked('destructured', ''); }`, `${FILE}: CadError, the CadError class used as a value, which the walk cannot follow`],
      [`export function check() { return [CadError]; }`, `${FILE}: CadError, the CadError class used as a value, which the walk cannot follow`]
    ];
    for (const [source, site] of cases) expect(reach(source), source).toEqual({ codes: [], unexpanded: [site] });
    // Testing for a factory runs it nothing.
    expect(reach(`export function check() { if (!CadError.checked) throw new CadError('present', ''); }`)).toEqual({ codes: ['present'], unexpanded: [] });
  });

  it('catches, in its check of member reads, a factory read whose code the walk did not read', () => {
    const index = new CadSourceIndex({ [FILE]: `${CAD_ERROR} const make = CadError.checked; export function check(kind: number) {
      if (kind === 1) throw CadError['checked']('bracket-code', ''); if (kind === 2) throw make('alias-code', ''); throw CadError.received('received-code', '', {}); }` });
    const found = cadDiagnosticReach(index, index.exported(FILE, 'check', new Set()));
    expect(cadSkippedMemberReads(index, found)).toEqual([]);
    // A walk that followed each read into its factory without reading the code, as one that suppressed the factory's body did.
    expect(cadSkippedMemberReads(index, { ...found, factoryReads: new Set() })).toEqual([
      `${FILE}: CadError.checked, a CadError factory whose code the walk did not read`,
      `${FILE}: CadError.received, a CadError factory whose code the walk did not read`,
      `${FILE}: CadError['checked'], a CadError factory whose code the walk did not read`]);
  });
});

describe('CAD diagnostic reach through default exports, closed to what it cannot find', () => {
  const ERRORS = { 'src/errors.ts': `export ${CAD_ERROR}` };
  /** The walk from `check` in `src/check.ts` among `files` and the errors module, with what it finds and what its check finds skipped. */
  const across = (files: Readonly<Record<string, string>>, options?: CadDiagnosticReachOptions) => {
    const index = new CadSourceIndex({ ...ERRORS, ...files });
    const found = cadDiagnosticReach(index, index.exported(FILE, 'check'), options);
    return { index, found, result: { codes: [...found.codes].sort(), unexpanded: found.unexpanded, skipped: cadSkippedMemberReads(index, found) } };
  };
  const result = (files: Readonly<Record<string, string>>, options?: CadDiagnosticReachOptions) => across(files, options).result;
  const subclass = (code: string, exported = 'export default class Refusal') =>
    `import { CadError } from './errors'; ${exported} extends CadError { constructor() { super('${code}', ''); } }`;
  const construct = (from: string, imported = 'Refusal') => `import ${imported} from '${from}'; export function check() { throw new Refusal(); }`;
  const CALL_DEFAULT = `import refuse from './refusal'; export function check() { refuse(); }`;
  const UNTOLD = (name: string) => `${FILE}: ${name}, a class the walk cannot tell, constructed`;

  it('follows a default export, declared named or unnamed or an expression, through a default import, a renamed import and a re-export', () => {
    const cases: readonly (readonly [string, Readonly<Record<string, string>>])[] = [
      // A default class with a constructor of its own and a default function, which the walk took for undeclared names before.
      ['default-subclass', { 'src/refusal.ts': subclass('default-subclass'), [FILE]: construct('./refusal') }],
      ['default-function', { 'src/refusal.ts': `import { CadError } from './errors'; export default function refuse() { throw new CadError('default-function', ''); }`,
        [FILE]: CALL_DEFAULT }],
      ['anonymous-class', { 'src/refusal.ts': subclass('anonymous-class', 'export default class'), [FILE]: construct('./refusal') }],
      ['anonymous-function', { 'src/refusal.ts': `import { CadError } from './errors'; export default function () { throw new CadError('anonymous-function', ''); }`,
        [FILE]: CALL_DEFAULT }],
      ['default-arrow', { 'src/refusal.ts': `import { CadError } from './errors'; export default () => { throw new CadError('default-arrow', ''); };`, [FILE]: CALL_DEFAULT }],
      // A default function given on, to be called wherever it goes.
      ['default-arrow-given', { 'src/refusal.ts': `import { CadError } from './errors'; export default () => { throw new CadError('default-arrow-given', ''); };`,
        [FILE]: `import refuse from './refusal'; export function check(run: (each: () => void) => void) { run(refuse); }` }],
      // Read only for a member, it runs that member alone.
      ['default-object', { 'src/refusal.ts': `import { CadError } from './errors'; export default { refuse() { throw new CadError('default-object', ''); },
        unread() { throw new CadError('default-object-unread', ''); } };`,
        [FILE]: `import table from './refusal'; export function check() { table.refuse(); }` }],
      // A default object given on, any of whose methods may then be called.
      ['default-object-given', { 'src/refusal.ts': `import { CadError } from './errors'; export default { refuse() { throw new CadError('default-object-given', ''); } };`,
        [FILE]: `import table from './refusal'; export function check(run: (value: object) => void) { run(table); }` }],
      ['default-class-expression', { 'src/refusal.ts': `import { CadError } from './errors'; export default (class extends CadError { constructor() { super('default-class-expression', ''); } });`,
        [FILE]: construct('./refusal') }],
      ['default-named-import', { 'src/refusal.ts': subclass('default-named-import'), [FILE]: construct('./refusal', '{ default as Refusal }') }],
      ['default-re-export', { 'src/refusal.ts': subclass('default-re-export'), 'src/barrel.ts': `export { default } from './refusal';`, [FILE]: construct('./barrel') }],
      ['default-renamed-re-export', { 'src/refusal.ts': subclass('default-renamed-re-export'), 'src/barrel.ts': `export { default as Refusal } from './refusal';`,
        [FILE]: construct('./barrel', '{ Refusal }') }],
      ['named-as-default', { 'src/refusal.ts': `${subclass('named-as-default', 'class Refusal')} export { Refusal as default };`, [FILE]: construct('./refusal') }],
      ['default-by-name', { 'src/refusal.ts': `${subclass('default-by-name', 'class Refusal')} export default Refusal;`, [FILE]: construct('./refusal') }],
      ['default-imported-on', { 'src/refusal.ts': subclass('default-imported-on'), 'src/barrel.ts': `import Refusal from './refusal'; export default Refusal;`, [FILE]: construct('./barrel') }]
    ];
    for (const [code, files] of cases) expect(result(files), code).toEqual({ codes: [code], unexpanded: [], skipped: [] });
  });

  it('reads a parameter\'s code at each call through a renamed import, a default import and a default re-export', () => {
    const raise = (declaration: string) => ({ 'src/raise.ts': `import { CadError } from './errors'; ${declaration}` });
    const DEFAULT_FUNCTION = raise(`export default function refuse(code: string): never { throw new CadError(code, ''); }`);
    const cases: readonly (readonly [string, Readonly<Record<string, string>>])[] = [
      ['renamed-import', { ...raise(`export function refuse(code: string): never { throw new CadError(code, ''); }`),
        [FILE]: `import { refuse as deny } from './raise'; export function check() { deny('renamed-import'); }` }],
      ['default-parameter', { ...DEFAULT_FUNCTION, [FILE]: `import deny from './raise'; export function check() { deny('default-parameter'); }` }],
      ['default-arrow-parameter', { ...raise(`export default (code: string): never => { throw new CadError(code, ''); };`),
        [FILE]: `import deny from './raise'; export function check() { deny('default-arrow-parameter'); }` }],
      ['default-re-exported-parameter', { ...DEFAULT_FUNCTION, 'src/barrel.ts': `export { default as deny } from './raise';`,
        [FILE]: `import { deny } from './barrel'; export function check() { deny('default-re-exported-parameter'); }` }],
      ['default-subclass-parameter', { 'src/sub.ts': `import { CadError } from './errors'; export default class Refusal extends CadError { constructor(code: string) { super(code, ''); } }`,
        [FILE]: `import Denial from './sub'; export function check() { throw new Denial('default-subclass-parameter'); }` }]
    ];
    for (const [code, files] of cases) expect(result(files), code).toEqual({ codes: [code], unexpanded: [], skipped: [] });
  });

  it('reports, rather than skips, a name it cannot find in the source, a namespace used as a value, and code of the project it does not hold', () => {
    // Forms the index has no rule for: a destructured export, a TypeScript namespace, and a default sought through `export *`, which carries none.
    expect(result({ 'src/raise.ts': `import { CadError } from './errors'; export const { refuse } = { refuse: () => { throw new CadError('destructured-export', ''); } };`,
      [FILE]: `import { refuse } from './raise'; export function check() { refuse(); }` })).toEqual({ codes: [], unexpanded: [UNFOUND('refuse')], skipped: [] });
    expect(result({ 'src/raise.ts': `import { CadError } from './errors'; export const { Refusal } = { Refusal: class extends CadError { constructor() { super('destructured-class', ''); } } };`,
      [FILE]: `import { Refusal } from './raise'; export function check() { throw new Refusal(); }` })).toEqual({ codes: [], unexpanded: [UNTOLD('Refusal'), UNFOUND('Refusal')], skipped: [] });
    expect(result({ [FILE]: `import { CadError } from './errors'; namespace Refusals { export function refuse() { throw new CadError('namespace-member', ''); } }
      export function check() { Refusals.refuse(); }` }).unexpanded).toContain(UNFOUND('Refusals'));
    expect(result({ 'src/refusal.ts': subclass('star-default'), 'src/barrel.ts': `export * from './refusal';`, [FILE]: construct('./barrel') }).unexpanded)
      .toEqual([UNTOLD('Refusal'), UNFOUND('Refusal')]);
    // A namespace given on as a value runs all its exports.
    expect(result({ 'src/raise.ts': `import { CadError } from './errors'; export function refuse(): never { throw new CadError('namespace-value', ''); }`,
      [FILE]: `import * as raise from './raise'; export function check() { Object.values(raise).forEach(each => each()); }` }))
      .toEqual({ codes: ['namespace-value'], unexpanded: [`${FILE}: raise, a namespace used as a value, which the walk cannot follow`], skipped: [] });
    // Code of the project the index does not hold, here a file outside `src`.
    expect(result({ 'packages/raise.ts': `import { CadError } from '../src/errors'; export function refuse() { throw new CadError('unindexed', ''); } export const table = { refuse };`,
      [FILE]: `import { refuse, table } from '../packages/raise'; export function check(kind: number) { if (kind) refuse(); table.refuse(); }` }))
      .toEqual({ codes: [], unexpanded: [UNFOUND('refuse'), UNFOUND('table'), `${FILE}: table.refuse, a member declared in code of the project the walk does not hold`], skipped: [] });
    // The reviewer's element of a constant array.
    expect(result({ 'src/refusal.ts': `import { CadError } from './errors'; class Refusal extends CadError { constructor() { super('array-subclass', ''); } } export const kinds = [Refusal] as const;`,
      [FILE]: `import { kinds } from './refusal'; export function check() { throw new kinds[0](); }` }).unexpanded).toContain(UNTOLD('kinds[0]'));
  });
});

describe('CAD diagnostic reach coverage, checked apart from the walk', () => {
  const ERRORS = { 'src/errors.ts': `export ${CAD_ERROR}` };
  const across = (files: Readonly<Record<string, string>>, options?: CadDiagnosticReachOptions) => {
    const index = new CadSourceIndex({ ...ERRORS, ...files });
    const found = cadDiagnosticReach(index, index.exported(FILE, 'check'), options);
    expect(cadSkippedMemberReads(index, found), 'the walk as it is').toEqual([]);
    return { index, found };
  };
  const sorted = (skipped: readonly string[]) => [...skipped].sort();
  const RAISE = { 'src/raise.ts': `import { CadError } from './errors'; export function refuse(): never { throw new CadError('entered', ''); }` };

  it('flags a name, a member read and a call of project code the walk neither entered nor reported', () => {
    const { index, found } = across({ ...RAISE,
      [FILE]: `import * as raise from './raise'; import { refuse } from './raise'; export function check(kind: number) { if (kind) refuse(); raise.refuse(); }` });
    expect([...found.codes]).toEqual(['entered']);
    const notEntered = { ...found, entries: found.entries.filter(entry => !(ts.isFunctionDeclaration(entry.node) && entry.node.name?.text === 'refuse')) };
    const REFUSE = 'src/raise.ts: refuse, which the walk neither entered nor reported';
    expect(sorted(cadSkippedMemberReads(index, notEntered))).toEqual([`${FILE}: raise.refuse(), a call of ${REFUSE}`,
      `${FILE}: raise.refuse, a member read running ${REFUSE}`, `${FILE}: refuse(), a call of ${REFUSE}`, `${FILE}: refuse, a name of ${REFUSE}`]);
  });

  it('flags a name the walk did not resolve unless it reported it, and code of the project it does not hold', () => {
    const destructured = across({ 'src/raise.ts': `import { CadError } from './errors'; export const { refuse } = { refuse: () => { throw new CadError('destructured-export', ''); } };`,
      [FILE]: `import { refuse } from './raise'; export function check() { refuse(); }` });
    expect(sorted(cadSkippedMemberReads(destructured.index, { ...destructured.found, unresolved: new Set() }))).toEqual([
      `${FILE}: refuse(), a call of src/raise.ts: refuse, which the walk neither entered nor reported`,
      `${FILE}: refuse, a name of src/raise.ts: refuse, which the walk neither entered nor reported`]);
    const unindexed = across({ 'packages/raise.ts': `import { CadError } from '../src/errors'; export function refuse() { throw new CadError('unindexed', ''); }`,
      [FILE]: `import { refuse } from '../packages/raise'; export function check() { refuse(); }` });
    expect(sorted(cadSkippedMemberReads(unindexed.index, { ...unindexed.found, unresolved: new Set() }))).toEqual([
      `${FILE}: refuse(), a call of packages/raise.ts: refuse, code the walk does not hold, not reported`,
      `${FILE}: refuse, a name of packages/raise.ts: refuse, code the walk does not hold, not reported`]);
  });

  it('accepts a declaration `stop` names only as stopped at', () => {
    const stopped = across({ ...RAISE, [FILE]: `import { refuse } from './raise'; export function check() { refuse(); }` }, { stop: new Set(['src/raise.ts:refuse']) });
    expect([...stopped.found.codes]).toEqual([]);
    expect(sorted(cadSkippedMemberReads(stopped.index, { ...stopped.found, stopped: new Set() }))).toEqual([
      `${FILE}: refuse(), a call of src/raise.ts: refuse, which the walk neither entered nor reported`,
      `${FILE}: refuse, a name of src/raise.ts: refuse, which the walk neither entered nor reported`]);
  });
});
