import type { CadScalar } from './cadDocument';
import { CadError } from './cadError';

/** No JavaScript execution, functions, property access or implicit multiplication. */
export function evaluateCadScalar(value: CadScalar, parameters: Readonly<Record<string, number>>): number {
  return evaluateScalar(value, parameters, false);
}

/** Restricted recipe math. Radians, no JavaScript, globals or property access. */
export function evaluateCadRecipeScalar(value: CadScalar, parameters: Readonly<Record<string, number>>): number {
  return evaluateScalar(value, parameters, true);
}

function finite(number: number): number {
  if (!Number.isFinite(number) || Math.abs(number) > 1e9) throw new CadError('invalid-scalar', 'Dimensions must be finite and within one billion.');
  return number;
}
function evaluateScalar(value: CadScalar, parameters: Readonly<Record<string, number>>, recipeMath: boolean): number {
  if (typeof value === 'number') return finite(value);
  if (value.length > 512) throw new CadError('expression-limit', 'Expressions may contain at most 512 characters.');
  const tokens = value.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z_0-9]*|[^\s]/g) ?? [];
  if (tokens.length > 256) throw new CadError('expression-limit', 'Expression has too many tokens.');
  let position = 0;
  let depth = 0;
  function primary(): number {
    if (++depth > 32) throw new CadError('expression-limit', 'Expression nesting exceeds 32 levels.');
    const token = tokens[position++];
    let result: number;
    if (token === '+' || token === '-') result = (token === '-' ? -1 : 1) * primary();
    else if (token === '(') {
      result = sum();
      if (tokens[position++] !== ')') throw new CadError('invalid-expression', 'Expected a closing parenthesis.');
    } else if (token !== undefined && /^(?:\d|\.\d)/.test(token)) result = Number(token);
    else if (token !== undefined && /^[A-Za-z_][A-Za-z_0-9]*$/.test(token)) {
      if (recipeMath && tokens[position] === '(') {
        position++;
        const argument = sum();
        if (token === 'min' || token === 'max') {
          if (tokens[position++] !== ',') throw new CadError('invalid-expression', 'min and max take two arguments.');
          const right = sum();
          if (tokens[position++] !== ')') throw new CadError('invalid-expression', 'Expected a closing parenthesis.');
          depth--;
          return finite(token === 'min' ? Math.min(argument, right) : Math.max(argument, right));
        }
        if (tokens[position++] !== ')') throw new CadError('invalid-expression', 'Recipe functions take one argument.');
        switch (token) {
          case 'sin': result = Math.sin(argument); break;
          case 'cos': result = Math.cos(argument); break;
          case 'tan': result = Math.tan(argument); break;
          case 'sqrt': result = Math.sqrt(argument); break;
          case 'atan': result = Math.atan(argument); break;
          case 'abs': result = Math.abs(argument); break;
          default: throw new CadError('invalid-expression', `Unknown recipe function "${token}".`);
        }
      } else {
        if (!Object.hasOwn(parameters, token)) throw new CadError('unknown-parameter', `Unknown parameter "${token}".`);
        result = parameters[token];
      }
    } else throw new CadError('invalid-expression', 'Expected a number, parameter or parenthesized expression.');
    depth--;
    return finite(result);
  }
  function product(): number {
    let result = primary();
    while (tokens[position] === '*' || tokens[position] === '/') {
      const operator = tokens[position++];
      const right = primary();
      if (operator === '/' && right === 0) throw new CadError('division-by-zero', 'Cannot divide a dimension by zero.');
      result = finite(operator === '*' ? result * right : result / right);
    }
    return result;
  }
  function sum(): number {
    let result = product();
    while (tokens[position] === '+' || tokens[position] === '-') {
      const operator = tokens[position++];
      const right = product();
      result = finite(operator === '+' ? result + right : result - right);
    }
    return result;
  }
  const result = sum();
  if (position !== tokens.length) throw new CadError('invalid-expression', `Unexpected token "${tokens[position]}".`);
  return finite(result);
}

/** Remove whole turns before trigonometry or kernel rotation to avoid large-angle roundoff. */
export function evaluateCadAngle(value: CadScalar, parameters: Readonly<Record<string, number>>): number {
  return evaluateCadScalar(value, parameters) % 360;
}
