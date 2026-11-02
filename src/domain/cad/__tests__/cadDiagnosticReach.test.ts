import { describe, expect, it } from 'vitest';
import { CadSourceIndex, cadDiagnosticReach, type CadDiagnosticReachOptions } from './cadDiagnosticReach';
import { cadSkippedMemberReads } from './cadMemberReads';

const FILE = 'src/check.ts';
/** What the walk finds from `check`, the export of one source file, having checked that it followed or reported every member read. */
const walk = (source: string, options?: CadDiagnosticReachOptions) => {
  const index = new CadSourceIndex({ [FILE]: source });
  const found = cadDiagnosticReach(index, index.exported(FILE, 'check', new Set()), options);
  expect(cadSkippedMemberReads(index, found), 'member reads skipped silently').toEqual([]);
  return found;
};
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
    }`).unexpanded).toEqual([`${FILE}: code`, `${FILE}: codeFor(kind), from ${FILE}: codeFor(…)`, `${FILE}: refusal.code, from ${FILE}: extra(…).code`]);
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
    expect(reach(source.replace('TABLE.slots.forEach(', 'later(refuse); TABLE.slots.forEach(')).unexpanded).toEqual([`${FILE}: refuse passed on`]);
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
      .toEqual([`${FILE}: inspection.code, from ${FILE}: cache.get(…).code`]);
    expect(reach(`function inspect(sketch: { name: string }) { let result = { eligible: true }; if (!sketch.name) result = { eligible: false, code: 'empty' }; return result; }\n${check}`).unexpanded)
      .toEqual([`${FILE}: inspection.code, from ${FILE}: result.code`]);
    expect(reach(`function inspect(sketch: { name: string }) { return new Inspection(sketch); }\n${check}`).unexpanded)
      .toEqual([`${FILE}: inspection.code, from ${FILE}: new Inspection(sketch).code`]);
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
    const refusal = `class Refusal extends CadError { constructor(code: string, message = '') { super(code, message); } }`;
    expect(reach(`${refusal} export function check() { throw new Refusal('refusal-code'); }`)).toEqual({ codes: ['refusal-code'], unexpanded: [] });
    // A subclass without a constructor passes its own arguments on; one with a constructor gives its own.
    expect(reach(`${refusal} class Deeper extends Refusal {} class Named extends Refusal { constructor() { super('named-code'); } }
      export function check(named: boolean) { throw named ? new Named() : new Deeper('deeper-code'); }`)).toEqual({ codes: ['deeper-code', 'named-code'], unexpanded: [] });
    // Testing an instance's class constructs nothing; any other use of the class is reported, since what constructs it is unseen.
    expect(reach(`${refusal} export function check(error: unknown) { if (error instanceof Refusal) return; throw new Refusal('refusal-code'); }`).unexpanded).toEqual([]);
    expect(reach(`${refusal} export function check() { const make = Refusal; throw new make('hidden'); }`).unexpanded).toEqual([`${FILE}: Refusal passed on`]);
    // A class that extends something else raises no CadError by its super call.
    expect(reach(`class Other extends Error { constructor(code: string) { super(code); } } export function check() { throw new Other('not-a-code'); }`).codes).toEqual([]);
  });
});
