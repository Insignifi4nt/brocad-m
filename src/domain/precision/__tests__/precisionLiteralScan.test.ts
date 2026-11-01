import { describe, expect, it } from 'vitest';
import { checkPrecisionLiterals, precisionLiteralsIn } from '../../../../scripts/check-precision-literals';

const scan = (text: string) => precisionLiteralsIn('fixture.ts', text);

describe('precision literal scanner', () => {
  it('finds each spelling of a tolerance, on its line', () => {
    const source = [
      'const a = x < 1e-9;',
      'const b = x < 1E-12;',
      'const c = x < 0.00001;',
      'const d = x < 10 ** -9;',
      'const e = x < (2) ** -(52);',
      'const f = x < Math.pow(10, -9);',
      "const g = x < Number('1e-9');",
      'const h = x < parseFloat("0.000002");',
      'const i = x < Number.parseFloat(`1e-7`);',
      "const j = x < +'1e-9';",
      'const k = Number.EPSILON;',
      "const l = Number['EPSILON'];",
      'const m = (Number).EPSILON;',
      'const n = Number?.EPSILON;',
      'const o = globalThis.Number.EPSILON;',
      'const { EPSILON } = Number;',
      "const { 'EPSILON': eps } = (Number as NumberConstructor);"
    ].join('\n');
    expect(scan(source)).toEqual([
      { literal: '1e-9', line: 1 },
      { literal: '1e-12', line: 2 },
      { literal: '0.00001', line: 3 },
      { literal: '10**-9', line: 4 },
      { literal: '2**-52', line: 5 },
      { literal: 'Math.pow(10,-9)', line: 6 },
      { literal: "Number('1e-9')", line: 7 },
      { literal: "parseFloat('0.000002')", line: 8 },
      { literal: "Number.parseFloat('1e-7')", line: 9 },
      { literal: "+'1e-9'", line: 10 },
      { literal: 'Number.EPSILON', line: 11 },
      { literal: 'Number.EPSILON', line: 12 },
      { literal: 'Number.EPSILON', line: 13 },
      { literal: 'Number.EPSILON', line: 14 },
      { literal: 'Number.EPSILON', line: 15 },
      { literal: 'Number.EPSILON', line: 16 },
      { literal: 'Number.EPSILON', line: 17 }
    ]);
  });

  it('ignores comments, text, ordinary numbers and arithmetic on variables', () => {
    const source = [
      '// below 1e-9, or Number.EPSILON',
      "const message = 'Use 1e-9 or Number.EPSILON';",
      "const label = Number('12.5') + Number('1e9') + Number(value);",
      'const step = 0.001 + 1e9 + 1e+3 + 0 + 0x10 + 10n;',
      'const power = 10 ** -digits + x ** 2 + 10 ** 3 + Math.pow(x, -2);',
      'const other = config.EPSILON + Math.EPSILON + EPSILON;',
      'const { EPSILON: local } = settings;'
    ].join('\n');
    expect(scan(source)).toEqual([]);
  });

  // Parses every source file, so its time grows with the repository and the runner's load.
  it('passes on the repository with every allowance used exactly', async () => {
    const result = await checkPrecisionLiterals();
    expect(result.problems).toEqual([]);
    expect(result.checked).toBeGreaterThan(500);
  }, 30_000);
});
