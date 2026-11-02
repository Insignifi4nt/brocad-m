import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// TypeScript 7 ships no compiler API yet; AST tooling uses the TypeScript 6 package.
import ts from '@typescript/typescript6';

/**
 * The `CadError` codes code can raise, found without running it. From each root it follows, through the source of `src`, every name a
 * walked function uses: the nearest declaration in scope and an import to the declaration it names, a default export, named or not,
 * being the export named `default`. It fails closed: a name it cannot resolve to a declaration of the source is reported, never taken
 * for one outside it or for no code, and only a name TypeScript resolves to the platform's or a library's declarations alone, or to no
 * value, is skipped; a namespace import used as a value is reported and runs all its exports; and a name or member declared in code of
 * the project outside `src`, which the walk does not hold, is reported. Every member read, by name or by element, is followed or
 * reported, never skipped (`accesses`):
 * - a namespace import's member is the export it names;
 * - a constant object literal's member, or one of the object a parameter stands for (`receivers`), is its last property of that name;
 * - any other member, `this` members included, is each declaration TypeScript gives it on the receiver's type, with the members that
 *   override it in classes below its class, at any depth, whose instances can be values of the receiver's type. A member only an
 *   interface, a type or an abstract class declares stands for the members of that name of the source's object literals and classes whose
 *   type fits the receiver's. A member declared outside the source, by the platform or a library, holds no code;
 * - an element read by a literal key, a constant naming one or a key whose type allows only literals is the member of each name; one read
 *   by a key the walk cannot tell runs no code of the source unless what it holds is a function called or given on, which is reported.
 * Classes and constant objects are alike: using one runs a class's constructor and field initializers, and those of the class it
 * extends, and an object's property values; their methods and accessors run only as a member read runs them. A getter runs on every
 * read, a presence test included, and a setter on every write. A method, or a property holding a function, runs when called or when read
 * as a value and given on, to a call, `bind`, a constant or the caller as a result, since it may be called wherever it goes; testing
 * whether one is there runs nothing, and any other use of one is reported. A constant object read other than for a member, given on or
 * spread, may have any method called, so it runs them all. An overload signature stands for its implementation. A destructuring read
 * runs the getters it reads.
 *
 * Every call is followed or reported. A call of a name or a member read runs the declarations it resolves to, as above. A call of any
 * other value, such as a parameter, a variable, a destructured name, what a call returns, or a member only signatures declare, runs the
 * functions that value is established to hold (`CadTrace`); a value it cannot establish is reported where it is called, never taken to run
 * nothing.
 *
 * It collects the first argument of each `CadError` raised and the `code` of each object literal, written plainly, quoted or as a computed
 * literal key, which carries a refusal to the `CadError` an inspection raises. A raise is known by the declaration what it constructs or
 * calls resolves to, never by a name. Each way to write one is followed or reported:
 * - followed: a `new` of the `CadError` class, or of a class without a constructor of its own that extends it at any depth, which gives
 *   its base's constructor its own arguments; a `super(…)` in a class whose base is either; a call of one of its two factories
 *   (`checked`, `received`), on the class or a subclass, whose body is not walked, since it raises the code its caller gave;
 * - followed: each of these named by its own name, a constant that holds it, in turn, a namespace import's member by name or by a
 *   literal element, a re-export (`export { … } from`, `export *`, an import exported on), a namespace re-exported (`export * as`, a
 *   namespace import exported on), a class expression, a constant object's property, a readonly field's value or either branch of a
 *   conditional; a default export of a class, a function, an expression or a name, or a name exported `as default`, through a default
 *   import, `import { default as … }` and `export { default } from`; and a class's base (`extends`) named any of these ways;
 * - followed: a subclass with a constructor of its own, and a function, whose parameter gives the code, at each `new`, `super(…)` and
 *   call of it the walk reaches by its name, a namespace's member or a constant that holds it;
 * - reported where it is: a `new` or `super(…)` whose class the walk cannot tell, as one held by a parameter, a variable that is not
 *   constant, a call's result or a member it cannot read;
 * - reported: the class, a class raising it or a factory given on, returned, destructured or held other than by a constant; a factory
 *   called through `call` or `apply`; a subclass or function passed on, or unnamed; a raise whose code is missing or spread.
 * A check apart from the walk (`cadSkippedMemberReads`) asks TypeScript what each name, member read, call and construction in the walked
 * code resolves to, each part of a union callee included: each declaration of the project it gives must be one the walk entered,
 * stopped at or reported, and each raise or code argument one it read or reported. A call that may run a function TypeScript gives no
 * implementation of must be one the walk traced from its value or reported. A part TypeScript's types reduced away, as a class of the
 * same shape as another, only the walk follows. A code is read through:
 * - each branch of a conditional and each side of `??`, `||` and `&&`;
 * - constants, properties of object literals (from the last: a spread or a computed key it cannot tell may hold one, and an absent one
 *   holds none) and elements of list literals, by a literal key or, for a key it cannot tell, through every element and property;
 * - `for…of` variables, the first parameter of a list iteration's callback, and names destructured from a constant, a `for…of` list or
 *   a parameter, with any default;
 * - a parameter, at each call of its function the walk reaches; a constructor's at each `new` and each subclass's `super(…)`;
 * - a call, through what each `return` of the function it names gives, a function of the source or one held by a constant or a
 *   property it reads.
 *
 * A template code is expanded through `templates`, the values each substitution takes keyed by `file: source text`. A caught error's
 * `code` is taken where it is read: the `CadError` in the walked `try` block that raised it gave it. Each such site is listed as
 * `taken`. Any other code is reported: a template `templates` does not expand, a variable that is not constant, a call of a function
 * outside the source, a member of a value it cannot read, and a parameter of a function passed on as a value, whose calls the walk
 * cannot see. So is a call of a method the source has a member of that name for, on a receiver whose type gives the method no
 * declaration, such as `any`.
 */
export interface CadDiagnosticReach {
  readonly codes: ReadonlySet<string>;
  /** Codes it could not read, as `file: text`, followed by `, from file: text` where the reading stopped elsewhere. */
  readonly unexpanded: readonly string[];
  /** Where it took a caught error's code, as `file: text`. */
  readonly taken: readonly string[];
  /** The named functions, variables, classes and members it walked, as `file:name`. */
  readonly declarations: ReadonlySet<string>;
  /** What became of each member read in the walked code (`CadMemberOutcome`). */
  readonly accesses: ReadonlyMap<ts.Node, CadMemberOutcome>;
  /** The member reads of a `CadError` factory whose code the walk read: at a call, or through a constant that holds the factory, at its calls. */
  readonly factoryReads: ReadonlySet<CadMemberRead>;
  /** The code walked: each node entered, and for a constant object read only for its members, that object. */
  readonly entries: readonly CadDiagnosticEntry[];
  /** The raises it took: each `new`, `super(…)` and factory call whose code it read, or reported as one it cannot read. */
  readonly raises: ReadonlySet<ts.Node>;
  /** The `new`s and `super(…)` calls it reported because it cannot tell the class they construct. */
  readonly untold: ReadonlySet<ts.Node>;
  /** Each function or constructor whose parameter gives a code, with the calls and constructions at which it read that parameter. */
  readonly argumentsRead: ReadonlyMap<ts.Node, ReadonlySet<ts.Node>>;
  /**
   * The functions and constructors among those whose calls it cannot all see, reported as passed on or unnamed, the methods it reported
   * used as a value it does not follow, and the `CadError` factories once it reported one, or a class raising `CadError`, given on as a value.
   */
  readonly escaped: ReadonlySet<ts.Node>;
  /**
   * The names it reported because it cannot resolve them to a declaration of the source, and TypeScript does not show them to be outside
   * it: no name is taken to run nothing because the walk cannot find what it names.
   */
  readonly unresolved: ReadonlySet<ts.Node>;
  /** The declarations it did not enter because `stop` names them or the type that declares them. */
  readonly stopped: ReadonlySet<ts.Node>;
  /**
   * The calls and the functions given to code outside the source whose function it traced from the value they run (`CadTrace`), rather
   * than entering a declaration they name.
   */
  readonly traced: ReadonlySet<ts.Node>;
}
export interface CadDiagnosticRoot { readonly file: string; readonly node: ts.Node }
/** A node the walk entered. Under `held`, a constant object read only for its members, it walks no method or accessor of that object. */
export interface CadDiagnosticEntry extends CadDiagnosticRoot { readonly held?: ts.ObjectLiteralExpression }
/**
 * What became of a member read: `followed` into the members it runs; `stopped` at members of a type `stop` names; `no-code` when it runs
 * nothing of the source (a write without a setter, a presence test, a value that holds no function, an absent property); `outside` when
 * every declaration it has is the platform's or a library's; `unexpanded` when it is reported; `traced` when a function it runs is the
 * value its receiver holds, which only signatures of the source declare and no object or class of the source fits (`CadTrace`).
 */
export type CadMemberOutcome = 'followed' | 'stopped' | 'no-code' | 'outside' | 'unexpanded' | 'traced';
/**
 * What the walk reads a value for: `code`, the codes it gives; `callee`, the functions a call of it runs. A function is established as
 * one the walk entered, written there or held by a constant, a destructured name, an element of a list, an object's property, what a
 * call returns, the function `bind` binds, or the argument each walked call gives a parameter, through each branch. So is what a
 * variable or a private property holds: its value and each value assigned to it; what a constant map's `get` gives: each value a `set`
 * call stores; and the argument a function returned by a named function gets: at each walked call of that function's result. What the
 * platform or a library holds runs no code of the source. Any other value is reported: a parameter of a function the walk sees no call
 * of, a variable declared without a value and never assigned, a value assigned to it where the walk does not enter, a map given on or
 * built with entries, and a signature no object or class of the source fits included. A source declaration with no body is no proof
 * that calling it runs no code of the source.
 */
export type CadTrace = 'code' | 'callee';
/** A member read by name or by element. */
export type CadMemberRead = ts.PropertyAccessExpression | ts.ElementAccessExpression;
export interface CadDiagnosticReachOptions {
  /**
   * The values a template substitution takes, keyed by `file: source text`: a list, or a function of the declarations walked, for a
   * substitution whose value depends on the caller, such as an operation name each caller passes.
   */
  readonly templates?: Readonly<Record<string, readonly string[] | ((declarations: ReadonlySet<string>) => readonly string[])>>;
  /**
   * Declarations not to walk, as `file:name`: hubs such as a registry, whose members are other kinds' evaluators, and types whose
   * members, called on a receiver of that type, are.
   */
  readonly stop?: ReadonlySet<string>;
  /** The object a parameter stands for, by file and parameter name, such as the parse context a kind's checks are given. */
  readonly receivers?: (file: string, name: string) => CadDiagnosticRoot | undefined;
}

type Import = { readonly module: string; readonly name: string };
/** A use of a declaration: its name, or a namespace's member that names it, by name or by a literal element. */
interface CadReference { readonly file: string; readonly site: ts.Identifier | CadMemberRead }
interface Member { readonly file: string; readonly node: ts.Node }
/** A member a call runs, with the type that declares the member called on the receiver, as `file:name`. */
interface CalledMember extends Member { readonly through: string | undefined }
/**
 * The members a member read may run (`accessedMembers`): `source` when a declaration is the source's, `unindexed` when one is code of
 * the project the index does not hold, and `bare`, the type that declares each signature of the source no object or class of the source
 * fits, as `file:name`.
 */
interface CadAccessedMembers { readonly members: readonly CalledMember[]; readonly source: boolean; readonly unindexed: boolean; readonly bare: readonly (string | undefined)[] }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)
    || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node);
}
/** A property's name, written plainly, quoted or as a computed literal key (`['code']`). */
function propertyName(name: ts.PropertyName | ts.DeclarationName | undefined): string | undefined {
  if (name && ts.isComputedPropertyName(name)) {
    const key = bareExpression(name.expression);
    return ts.isStringLiteralLike(key) ? key.text : undefined;
  }
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name) || ts.isNumericLiteral(name)) ? name.text : undefined;
}
/** The element of a destructuring pattern that binds `name`, at any depth. */
function elementNamed(pattern: ts.BindingName, name: string): ts.BindingElement | undefined {
  if (ts.isIdentifier(pattern)) return undefined;
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) continue;
    const found = ts.isIdentifier(element.name) ? element.name.text === name ? element : undefined : elementNamed(element.name, name);
    if (found) return found;
  }
  return undefined;
}
/** What a function returns: the expression of each `return` in its own body, or its expression body. */
function returnsOf(owner: ts.FunctionLikeDeclaration): readonly ts.Expression[] {
  if (!owner.body) return [];
  if (!ts.isBlock(owner.body)) return [owner.body];
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (isFunctionLike(node) || ts.isClassLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) found.push(node.expression);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(owner.body, visit);
  return found;
}
function binds(name: ts.BindingName, wanted: string): boolean {
  return ts.isIdentifier(name) ? name.text === wanted : name.elements.some(element => !ts.isOmittedExpression(element) && binds(element.name, wanted));
}
/** The expression without parentheses, assertions and `Object.freeze`, which leave the object it gives. */
export function bareExpression(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)
    || (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'Object' && node.expression.name.text === 'freeze' && node.arguments.length === 1))
    node = ts.isCallExpression(node) ? node.arguments[0] : node.expression;
  return node;
}

/** The application's compiler options, from its TypeScript configuration, without output, read once per test file. */
let applicationOptions: ts.CompilerOptions | undefined;
function programOptions(): ts.CompilerOptions {
  if (applicationOptions) return applicationOptions;
  const configuration = ts.getParsedCommandLineOfConfigFile(path.join(root, 'tsconfig.app.json'), {}, {
    ...ts.sys, onUnRecoverableConfigFileDiagnostic: diagnostic => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')); }
  });
  if (!configuration) throw new Error('The application has no TypeScript configuration.');
  return applicationOptions = { ...configuration.options, noEmit: true };
}
/**
 * The platform and package declaration files, parsed once per test file and shared by every index built from given text. Each such
 * index is a program over the same declarations with the same options; a parsed source file is never changed, and TypeScript keeps each
 * checker's symbols apart from the files it reads, so programs can share them as its language service does.
 */
const declarationFiles = new Map<string, ts.SourceFile>();
/** The name of the interface, type alias or class that declares a member. */
function ownerName(declaration: ts.Declaration): string | undefined {
  const owner = ts.isTypeLiteralNode(declaration.parent) && ts.isTypeAliasDeclaration(declaration.parent.parent) ? declaration.parent.parent : declaration.parent;
  return (ts.isInterfaceDeclaration(owner) || ts.isTypeAliasDeclaration(owner) || ts.isClassLike(owner)) && owner.name ? owner.name.text : undefined;
}
/** The export name of a module's default export. */
const DEFAULT = 'default';
function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some(modifier => modifier.kind === kind);
}
/**
 * Whether `statement` is a module's default export written as a declaration or an expression: `export default function` or `class`,
 * named or not, or `export default` of an expression other than a name, which an `export default name` exports as that name.
 */
function isDefaultDeclaration(statement: ts.Statement): statement is ts.FunctionDeclaration | ts.ClassDeclaration | ts.ExportAssignment {
  if (ts.isExportAssignment(statement)) return !statement.isExportEquals && !ts.isIdentifier(statement.expression);
  return (ts.isFunctionDeclaration(statement) && !!statement.body || ts.isClassDeclaration(statement))
    && hasModifier(statement, ts.SyntaxKind.ExportKeyword) && hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
}
/** What declaration `node` holds as a value it was given once: a `const` variable's initializer, or the expression a module exports as default. */
function constantValue(node: ts.Node): ts.Expression | undefined {
  if (ts.isVariableDeclaration(node)) return (ts.getCombinedNodeFlags(node) & ts.NodeFlags.Const) !== 0 ? node.initializer : undefined;
  return ts.isExportAssignment(node) && !node.isExportEquals ? node.expression : undefined;
}
/** What declaration `node` is initialized to: a variable's initializer, or the expression a module exports as default. */
function initialValue(node: ts.Node): ts.Expression | undefined {
  return ts.isVariableDeclaration(node) ? node.initializer : ts.isExportAssignment(node) && !node.isExportEquals ? node.expression : undefined;
}
/** The name a declaration is used by in its own file, when it has one. */
export function declarationName(node: ts.Node): string | undefined {
  return (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name ? node.name.text
    : ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) ? node.name.text : undefined;
}
/** Where a program file stands: the indexed `source`; `outside`, the platform's or a library's declarations, or data; or `unindexed` code of the project. */
export type CadSourcePlace = 'source' | 'outside' | 'unindexed';

/** A declaration with no body or value of its own: a member an interface, a type or an abstract class declares. */
function isSignature(declaration: ts.Declaration): boolean {
  return ts.isMethodSignature(declaration) || ts.isPropertySignature(declaration) || ts.isPropertyDeclaration(declaration) && !declaration.initializer
    || ts.isMethodDeclaration(declaration) && !declaration.body;
}

/**
 * A name that is no declaration the walk can enter: a function's parameter, a caught error, an element of a list (a `for…of` variable,
 * or the first parameter of a callback given to a list's iteration method), or another loop or destructured variable, with the pattern
 * element that binds it when it is destructured from a declaration, a parameter or a `for…of` list.
 */
type Binding =
  | { readonly kind: 'parameter'; readonly owner: ts.FunctionLikeDeclaration; readonly position: number }
  | { readonly kind: 'caught' }
  | { readonly kind: 'element'; readonly of: ts.Expression }
  | { readonly kind: 'variable'; readonly element?: ts.BindingElement };
const destructuring = (pattern: ts.BindingName, name: string): Binding => ({ kind: 'variable', element: elementNamed(pattern, name) });
/**
 * The declaration with a value that `identifier` is destructured from, as a statement declares it, or undefined for any other name. Its
 * value runs as a variable's does, wherever the name is used, a closure entered apart from the code around it included.
 */
function destructuredDeclaration(identifier: ts.Identifier): ts.VariableDeclaration | undefined {
  const found = binding(identifier);
  if (!found || !isBinding(found) || found.kind !== 'variable' || !found.element) return undefined;
  let root: ts.Node = found.element;
  while (ts.isBindingElement(root) || ts.isObjectBindingPattern(root) || ts.isArrayBindingPattern(root)) root = root.parent;
  return ts.isVariableDeclaration(root) && root.initializer && ts.isVariableStatement(root.parent.parent) ? root : undefined;
}
/** A node's text on one line, shortened, for a report. */
export function brief(node: ts.Node): string {
  const text = node.getText().replace(/\s+/g, ' ');
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}
/**
 * What call `call` runs: its callee, or the function `call` or `apply` is read off. None for `super(…)` and `import(…)`.
 */
export function calleeOf(call: ts.CallExpression): ts.Expression | undefined {
  const callee = bareExpression(call.expression);
  if (callee.kind === ts.SyntaxKind.SuperKeyword || callee.kind === ts.SyntaxKind.ImportKeyword) return undefined;
  return ts.isPropertyAccessExpression(callee) && (callee.name.text === 'call' || callee.name.text === 'apply') ? bareExpression(callee.expression) : callee;
}
/**
 * Whether name `site` is assigned there: the target of an assignment or an update, or a name a destructuring assignment or a loop's head
 * assigns.
 */
function isAssigned(site: ts.Node): boolean {
  let outer: ts.Node = site;
  while (ts.isParenthesizedExpression(outer.parent) || ts.isNonNullExpression(outer.parent) || ts.isAsExpression(outer.parent) || ts.isSatisfiesExpression(outer.parent)) outer = outer.parent;
  const parent = outer.parent;
  if ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)) return true;
  // A destructuring assignment's pattern is written as a literal, whose elements and property values it assigns, at any depth.
  let target: ts.Node = outer;
  while (ts.isShorthandPropertyAssignment(target.parent) || ts.isPropertyAssignment(target.parent) && target.parent.initializer === target || ts.isSpreadAssignment(target.parent)
    || ts.isSpreadElement(target.parent) || ts.isArrayLiteralExpression(target.parent) || ts.isObjectLiteralExpression(target.parent)
    || ts.isBinaryExpression(target.parent) && target.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && target.parent.left === target && target !== outer
      && (ts.isObjectLiteralExpression(target.parent.parent) || ts.isArrayLiteralExpression(target.parent.parent) || ts.isPropertyAssignment(target.parent.parent))) target = target.parent;
  const holder = target.parent;
  return ts.isBinaryExpression(holder) && holder.left === target && holder.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && holder.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    || (ts.isForOfStatement(holder) || ts.isForInStatement(holder)) && holder.initializer === target;
}
/** The platform's maps, whose `get` gives what `set` stored. */
const MAPS: ReadonlySet<string> = new Set(['Map', 'WeakMap']);
/** The assignments that give their target the value on their right: `=`, and `??=`, `||=` and `&&=`, which may keep the one it holds. */
const ASSIGNMENTS: ReadonlySet<ts.SyntaxKind> = new Set([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken]);
/** The path segment that reads any element of a list, or any property of an object read by a key the walk cannot tell. */
const ELEMENT = '[]';
/** The path segment that calls a function and reads what it returns. */
const CALL = '()';
/** The longest path read; a function returning a member of its own result would grow it without end. */
const DEPTH = 24;
/** List methods whose callback's first parameter is each element. */
const ITERATIONS = new Set(['map', 'flatMap', 'forEach', 'some', 'every', 'find', 'findLast', 'filter', 'findIndex', 'findLastIndex']);

/**
 * The declaration `identifier` names in its own file: a function, class or variable in an enclosing scope, `parameter` for a parameter,
 * loop, catch or destructured variable, which stands for a value the walk cannot follow, or undefined for a name declared elsewhere.
 */
function lexical(identifier: ts.Identifier): ts.Node | 'parameter' | undefined {
  const found = binding(identifier);
  return found && isBinding(found) ? 'parameter' : found;
}
/** Bindings' kinds are words; syntax kinds are numbers. */
const isBinding = (found: ts.Node | Binding): found is Binding => typeof found.kind === 'string';
/** What each identifier names, kept since the walk and its check ask again for the same name. */
const bindings = new WeakMap<ts.Identifier, ts.Node | Binding | undefined>();
/** What `identifier` names in its own file: its declaration, a {@link Binding}, or undefined for a name declared elsewhere. */
function binding(identifier: ts.Identifier): ts.Node | Binding | undefined {
  if (bindings.has(identifier)) return bindings.get(identifier);
  const found = scopeBinding(identifier);
  bindings.set(identifier, found);
  return found;
}
function scopeBinding(identifier: ts.Identifier): ts.Node | Binding | undefined {
  const name = identifier.text, variable = { kind: 'variable' } as const;
  const inStatements = (statements: readonly ts.Statement[]) => {
    for (const statement of statements) {
      if (ts.isFunctionDeclaration(statement) && !statement.body) continue; // An overload signature; its implementation follows.
      if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name?.text === name) return statement;
      if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration;
        if (!ts.isIdentifier(declaration.name) && binds(declaration.name, name)) return destructuring(declaration.name, name);
      }
    }
    return undefined;
  };
  for (let scope: ts.Node | undefined = identifier.parent; scope; scope = scope.parent) {
    if (isFunctionLike(scope)) {
      const position = scope.parameters.findIndex(parameter => binds(parameter.name, name));
      if (position >= 0) {
        if (!ts.isIdentifier(scope.parameters[position].name)) return destructuring(scope.parameters[position].name, name);
        const call = scope.parent;
        if (position === 0 && ts.isCallExpression(call) && call.arguments[0] === scope && ts.isPropertyAccessExpression(call.expression) && ITERATIONS.has(call.expression.name.text))
          return { kind: 'element', of: call.expression.expression };
        return { kind: 'parameter', owner: scope, position };
      }
      if (ts.isFunctionExpression(scope) && scope.name?.text === name) return scope;
    }
    if (ts.isCatchClause(scope) && scope.variableDeclaration && binds(scope.variableDeclaration.name, name))
      return ts.isIdentifier(scope.variableDeclaration.name) ? { kind: 'caught' } : variable;
    if ((ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) && scope.initializer && ts.isVariableDeclarationList(scope.initializer)) {
      const declaration = scope.initializer.declarations.find(declaration => binds(declaration.name, name));
      if (declaration) return !ts.isForOfStatement(scope) ? variable : ts.isIdentifier(declaration.name) ? { kind: 'element', of: scope.expression }
        : destructuring(declaration.name, name);
    }
    if (ts.isClassExpression(scope) && scope.name?.text === name) return scope;
    const found = ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope) ? inStatements(scope.statements)
      : ts.isCaseBlock(scope) ? scope.clauses.map(clause => inStatements(clause.statements)).find(Boolean) : undefined;
    if (found) return found;
  }
  return undefined;
}

export class CadSourceIndex {
  readonly files = new Map<string, ts.SourceFile>();
  private readonly imports = new Map<string, Map<string, Import>>();
  private readonly exports = new Map<string, Map<string, Import>>();
  private readonly starExports = new Map<string, string[]>();
  /** The namespaces each file exports by name (`export * as name from`), as the module each names. */
  private readonly namespaceExports = new Map<string, Map<string, string>>();
  private readonly members = new Map<string, Member[]>();
  private readonly indexed = new Set<ts.Node>();
  /** Gives a member called on another receiver the declarations of the receiver's type. */
  private readonly checker: ts.TypeChecker;
  /** The indexed path of each program source file that is the source's. */
  private readonly paths = new Map<ts.SourceFile, string>();
  private readonly calls = new Map<string, CadAccessedMembers | undefined>();
  private readonly callKeys = new Map<ts.Node, number>();

  private readonly referenceCache = new Map<ts.Node, readonly CadReference[]>();

  /**
   * Indexes the source of `src`, or `sources`, text by path, for a test of the walk itself, of which it holds the files in `src`. The files
   * are those of one TypeScript program with the application's compiler options, so each receiver has a type.
   */
  constructor(sources?: Readonly<Record<string, string>>) {
    const files = sources ? Object.keys(sources) : execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src'], { cwd: root, encoding: 'utf8' })
      .split('\n').filter(file => /\.tsx?$/.test(file) && !file.endsWith('.d.ts') && !/(__tests__|\.test\.|\.spec\.)/.test(file));
    const options = programOptions(), host = ts.createCompilerHost(options, true);
    const absolute = (file: string) => path.join(root, file).replaceAll('\\', '/');
    if (sources) {
      // The given text stands for each file; the platform's declarations still come from the compiler.
      const given = new Map(files.map(file => [absolute(file), sources[file]]));
      const { fileExists, readFile, getSourceFile } = host, text = (name: string) => given.get(name.replaceAll('\\', '/'));
      host.fileExists = name => text(name) !== undefined || fileExists.call(host, name);
      host.readFile = name => text(name) ?? readFile.call(host, name);
      host.getSourceFile = (name, version, onError, fresh) => {
        const found = text(name);
        if (found !== undefined) return ts.createSourceFile(name, found, version, true);
        if (fresh || !name.endsWith('.d.ts')) return getSourceFile.call(host, name, version, onError, fresh);
        const key = `${typeof version === 'object' ? `${version.languageVersion}:${version.impliedNodeFormat ?? ''}:${version.jsDocParsingMode ?? ''}` : version}\n${name}`;
        let shared = declarationFiles.get(key);
        if (!shared) { shared = getSourceFile.call(host, name, version, onError); if (shared) declarationFiles.set(key, shared); }
        return shared;
      };
    }
    const program = ts.createProgram({ rootNames: files.map(absolute), options, host });
    this.checker = program.getTypeChecker();
    // Given text outside `src` stays in the program as code of the project the index does not hold.
    for (const file of files.filter(file => file.startsWith('src/'))) {
      const source = program.getSourceFile(absolute(file));
      if (!source) throw new Error(`The program has no source file for ${file}.`);
      this.files.set(file, source);
      this.paths.set(source, file);
    }
    for (const [file, source] of this.files) this.indexFile(file, source);
  }

  private resolveModule(from: string, specifier: string): string | undefined {
    const bare = specifier.split('?')[0];
    const base = bare.startsWith('@/') ? `src/${bare.slice(2)}` : bare.startsWith('.') ? path.posix.join(path.posix.dirname(from), bare) : undefined;
    return base && ['.ts', '.tsx', '/index.ts', '/index.tsx', ''].map(ending => base + ending).find(candidate => this.files.has(candidate));
  }

  private indexFile(file: string, source: ts.SourceFile) {
    const imports = new Map<string, Import>(), exports = new Map<string, Import>(), stars: string[] = [], namespaces = new Map<string, string>();
    const member = (name: string, node: ts.Node) => {
      if (this.indexed.has(node)) return;
      this.indexed.add(node);
      const list = this.members.get(name), entry = { file, node };
      if (list) list.push(entry); else this.members.set(name, [entry]);
    };
    const exported = (node: ts.Node) => hasModifier(node, ts.SyntaxKind.ExportKeyword);
    for (const statement of source.statements) {
      // A default export is exported as `default` only, whatever its own name.
      if (isDefaultDeclaration(statement)) exports.set(DEFAULT, { module: file, name: DEFAULT });
      else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name && exported(statement))
        exports.set(statement.name.text, { module: file, name: statement.name.text });
      if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        if (exported(statement)) exports.set(declaration.name.text, { module: file, name: declaration.name.text });
        const value = declaration.initializer && bareExpression(declaration.initializer);
        if (value && ts.isObjectLiteralExpression(value)) for (const property of value.properties) {
          const name = propertyName(property.name);
          if (name && (ts.isMethodDeclaration(property) || ts.isPropertyAssignment(property))) member(name, property);
        }
      }
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.importClause && !statement.importClause.isTypeOnly) {
        const module = this.resolveModule(file, statement.moduleSpecifier.text);
        if (!module) continue;
        const clause = statement.importClause, bindings = clause.namedBindings;
        if (clause.name) imports.set(clause.name.text, { module, name: 'default' });
        if (bindings && ts.isNamespaceImport(bindings)) imports.set(bindings.name.text, { module, name: '*' });
        else if (bindings) for (const element of bindings.elements) if (!element.isTypeOnly) imports.set(element.name.text, { module, name: (element.propertyName ?? element.name).text });
      }
      if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
        const module = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? this.resolveModule(file, statement.moduleSpecifier.text) : file;
        if (!module) continue;
        if (!statement.exportClause) stars.push(module);
        else if (ts.isNamespaceExport(statement.exportClause)) namespaces.set(statement.exportClause.name.text, module);
        else if (ts.isNamedExports(statement.exportClause)) for (const element of statement.exportClause.elements)
          exports.set(element.name.text, { module, name: (element.propertyName ?? element.name).text });
      }
      if (ts.isExportAssignment(statement) && !statement.isExportEquals && ts.isIdentifier(statement.expression)) exports.set(DEFAULT, { module: file, name: statement.expression.text });
    }
    // Every class's and object literal's members, which may implement a member an interface or type declares.
    const visit = (node: ts.Node) => {
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) for (const element of node.members) {
        const name = propertyName(element.name);
        if (name && (ts.isMethodDeclaration(element) || ts.isGetAccessorDeclaration(element) || ts.isSetAccessorDeclaration(element) || ts.isPropertyDeclaration(element))) member(name, element);
      }
      if (ts.isObjectLiteralExpression(node)) for (const property of node.properties) {
        const name = propertyName(property.name);
        if (name && (ts.isMethodDeclaration(property) || ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)
          || ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property))) member(name, property);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    this.imports.set(file, imports); this.exports.set(file, exports); this.starExports.set(file, stars); this.namespaceExports.set(file, namespaces);
  }

  /** The declarations `identifier` names: the nearest in scope, or what an import of it names. */
  resolve(file: string, identifier: ts.Identifier): readonly CadDiagnosticRoot[] {
    const local = lexical(identifier);
    if (local === 'parameter') return [];
    if (local) return [{ file, node: local }];
    const imported = this.imports.get(file)?.get(identifier.text);
    return imported && imported.name !== '*' ? this.exported(imported.module, imported.name) : [];
  }
  /** Every declaration module `module` exports, by name or as its default, its own or another module's through a re-export. */
  moduleExports(module: string): readonly CadDiagnosticRoot[] {
    const names = new Set<string>(), seen = new Set<string>();
    const collect = (from: string, star: boolean) => {
      if (seen.has(from)) return;
      seen.add(from);
      for (const name of this.exports.get(from)?.keys() ?? []) if (!star || name !== DEFAULT) names.add(name);
      for (const next of this.starExports.get(from) ?? []) collect(next, true);
    };
    collect(module, false);
    return [...names].flatMap(name => this.exported(module, name));
  }
  /** The path of the file that holds `node`, from the repository's root. */
  where(node: ts.Node): string {
    const source = node.getSourceFile();
    return this.paths.get(source) ?? path.relative(root, source.fileName).replaceAll('\\', '/');
  }
  /** Where the file that holds `node` stands (`CadSourcePlace`). */
  place(node: ts.Node): CadSourcePlace {
    const source = node.getSourceFile();
    if (this.paths.has(source)) return 'source';
    return source.isDeclarationFile || /\.json$/i.test(source.fileName) || /[\\/]node_modules[\\/]/.test(source.fileName) ? 'outside' : 'unindexed';
  }
  /**
   * The value TypeScript gives what `identifier` names, past imports and re-exports, a shorthand property's included: its declarations,
   * none for a name it cannot resolve, and whether the name is of a value rather than only a type.
   */
  nameDeclarations(identifier: ts.Identifier): { readonly declarations: readonly ts.Declaration[]; readonly value: boolean } {
    const parent = identifier.parent;
    let symbol = ts.isShorthandPropertyAssignment(parent) && parent.name === identifier ? this.checker.getShorthandAssignmentValueSymbol(parent)
      : this.checker.getSymbolAtLocation(identifier);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = this.checker.getAliasedSymbol(symbol);
    return symbol ? { declarations: symbol.declarations ?? [], value: (symbol.flags & ts.SymbolFlags.Value) !== 0 } : { declarations: [], value: true };
  }
  /**
   * Whether TypeScript shows that `identifier`, which the index cannot resolve to a declaration of the source, names nothing of it: a value
   * every declaration of which is the platform's, a library's or data, a type, which runs nothing, or `undefined`, `arguments` or
   * `globalThis`. Any other name, one TypeScript cannot resolve or one declared in code of the project, is not.
   */
  outsideName(identifier: ts.Identifier): boolean {
    const { declarations, value } = this.nameDeclarations(identifier);
    if (!declarations.length) return value && ['undefined', 'arguments', 'globalThis'].includes(identifier.text);
    return !value || declarations.every(declaration => this.place(declaration) === 'outside');
  }
  /**
   * The module namespace `identifier` names in `file`, unless a declaration in scope shadows it: a namespace import, or a name imported
   * from a module that exports a namespace, as `export * as name from` does or as `export { name }` does of a namespace import, through
   * any re-export.
   */
  namespace(file: string, identifier: ts.Identifier): string | undefined {
    return lexical(identifier) === undefined ? this.importedNamespace(file, identifier.text, new Set()) : undefined;
  }
  private importedNamespace(file: string, name: string, seen: Set<string>): string | undefined {
    const imported = this.imports.get(file)?.get(name);
    return !imported ? undefined : imported.name === '*' ? imported.module : this.exportedNamespace(imported.module, imported.name, seen);
  }
  private exportedNamespace(module: string, name: string, seen: Set<string>): string | undefined {
    const key = `${module}:${name}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    const named = this.namespaceExports.get(module)?.get(name);
    if (named) return named;
    const entry = this.exports.get(module)?.get(name);
    if (entry) return entry.module === module ? this.importedNamespace(module, entry.name, seen) : this.exportedNamespace(entry.module, entry.name, seen);
    for (const star of this.starExports.get(module) ?? []) {
      const found = this.exportedNamespace(star, name, seen);
      if (found) return found;
    }
    return undefined;
  }
  private readonly exportCache = new Map<string, readonly CadDiagnosticRoot[]>();
  /**
   * The declaration module `module` exports as `name`: a function, class, enum or variable it declares, its default export (`export
   * default` of a declaration, named or not, or of an expression), or what it exports on from another module, by name, by a default
   * re-export or through `export *`, which never carries a default. Empty when the index finds none.
   */
  exported(module: string, name: string, seen: Set<string> = new Set()): readonly CadDiagnosticRoot[] {
    // Kept per module and name; one being found gives none to a cycle of re-exports through it.
    const key = `${module}\n${name}`, top = seen.size === 0;
    if (top) {
      const cached = this.exportCache.get(key);
      if (cached) return cached;
      this.exportCache.set(key, []);
    }
    const found = this.exportedOnce(module, name, seen);
    if (top) this.exportCache.set(key, found);
    return found;
  }
  private exportedOnce(module: string, name: string, seen: Set<string>): readonly CadDiagnosticRoot[] {
    if (seen.has(module)) return [];
    seen.add(module);
    const entry = this.exports.get(module)?.get(name);
    if (entry) {
      if (entry.module !== module) return this.exported(entry.module, entry.name);
      const source = this.files.get(module)!;
      if (entry.name === DEFAULT) {
        const declared = source.statements.find(isDefaultDeclaration);
        return declared ? [{ file: module, node: declared }] : [];
      }
      for (const statement of source.statements) {
        if (ts.isFunctionDeclaration(statement) && !statement.body) continue;
        if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name?.text === entry.name)
          return [{ file: module, node: statement }];
        if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations)
          if (ts.isIdentifier(declaration.name) && declaration.name.text === entry.name) return [{ file: module, node: declaration }];
      }
      // An import exported on (`import { name } from …; export { name };`) is the declaration it imports.
      const imported = this.imports.get(module)?.get(entry.name);
      return imported && imported.name !== '*' ? this.exported(imported.module, imported.name) : [];
    }
    if (name === DEFAULT) return [];
    for (const star of this.starExports.get(module) ?? []) {
      const found = this.exportedOnce(star, name, seen);
      if (found.length) return found;
    }
    return [];
  }
  /** Methods and properties of classes and object literals named `name`. */
  membersNamed(name: string): readonly Member[] { return this.members.get(name) ?? []; }
  /**
   * The members reading member `name` of `access`'s receiver may run, from the declarations TypeScript gives it on the receiver's type:
   * each of the source's with a body or value and the members of classes that extend its class; for one an interface, a type or an
   * abstract class of the source declares, the members of that name of the source's object literals and classes whose type fits the
   * receiver's. A declaration outside the source, the platform's or a library's, runs nothing of the source, and nor does a signature no
   * object or class of the source fits. Only members `runs` says the read runs are tried against the receiver's type, which is the costly
   * part. `source` when any declaration is the source's; `unindexed` when any is code of the project the index does not hold. Undefined
   * when the type gives no declaration at all, as for a receiver of type `any`.
   */
  accessedMembers(access: CadMemberRead, name: string, runs: (member: ts.Node) => boolean): CadAccessedMembers | undefined {
    const id = this.callKeys.get(access) ?? this.callKeys.set(access, this.callKeys.size).get(access)!, key = `${id}:${name}`;
    const cached = this.calls.get(key);
    if (cached || this.calls.has(key)) return cached;
    const declarations = ts.isPropertyAccessExpression(access) ? this.checker.getSymbolAtLocation(access.name)?.declarations ?? []
      : this.propertyDeclarations(this.checker.getTypeAtLocation(access.expression), name);
    let found: CadAccessedMembers | undefined;
    if (declarations.length) {
      const receiver = this.checker.getApparentType(this.checker.getNonNullableType(this.checker.getTypeAtLocation(access.expression)));
      const members = new Map<ts.Node, CalledMember>();
      let candidates: readonly Member[] | undefined, source = false, unindexed = false;
      const bare: (string | undefined)[] = [];
      for (const declaration of declarations) {
        const file = this.paths.get(declaration.getSourceFile());
        if (file === undefined) { unindexed ||= this.place(declaration) === 'unindexed'; continue; }
        source = true;
        candidates ??= this.membersNamed(name).filter(candidate => runs(candidate.node));
        const owner = ownerName(declaration), through = owner && `${file}:${owner}`;
        if (!isSignature(declaration)) members.set(declaration, { file, node: declaration, through });
        // A class below the declaring one, at any depth, may override the member, and any object or class may implement a signature; either
        // runs only when an instance of it can be a value of the receiver's type.
        let implemented = false;
        for (const candidate of candidates) if (candidate.node !== declaration
          && (isSignature(declaration) && (this.declaredAs(candidate.node, name, declaration) || this.fits(candidate.node, receiver))
            || this.overrides(candidate.node, name, declaration) && this.fits(candidate.node, receiver))) {
          implemented = true;
          if (!members.has(candidate.node)) members.set(candidate.node, { ...candidate, through });
        }
        if (isSignature(declaration) && !implemented) bare.push(through);
      }
      found = { members: [...members.values()], source, unindexed, bare };
    }
    this.calls.set(key, found);
    return found;
  }
  /**
   * The declarations TypeScript gives member `name` read by `access`: the source's, with their files, whether any is outside it, and
   * whether any is code of the project the index does not hold.
   */
  memberDeclarations(access: CadMemberRead, name: string): { readonly members: readonly Member[]; readonly outside: boolean; readonly unindexed: boolean } {
    const declarations = ts.isPropertyAccessExpression(access) ? this.checker.getSymbolAtLocation(access.name)?.declarations ?? []
      : this.propertyDeclarations(this.checker.getTypeAtLocation(access.expression), name);
    const members: Member[] = [];
    let outside = false, unindexed = false;
    for (const declaration of declarations) {
      const file = this.paths.get(declaration.getSourceFile());
      if (file !== undefined) members.push({ file, node: declaration });
      else if (this.place(declaration) === 'outside') outside = true; else unindexed = true;
    }
    return { members, outside, unindexed };
  }
  /** The string literals the type of key `key` allows, when it allows nothing else. */
  literalKeys(key: ts.Expression): readonly string[] | undefined {
    const type = this.checker.getTypeAtLocation(key), parts = type.isUnion() ? type.types : [type];
    return parts.length && parts.every(part => part.isStringLiteral()) ? parts.map(part => (part as ts.StringLiteralType).value) : undefined;
  }
  /** The getters, of the source, of the properties of the type of `node`, or of those named `names`; only object literals' with `own`. */
  getters(node: ts.Node, names?: readonly string[], own = false): readonly Member[] {
    const type = this.checker.getApparentType(this.checker.getNonNullableType(this.checker.getTypeAtLocation(node)));
    const properties = names ? names.flatMap(name => this.propertyDeclarations(type, name)) : type.getProperties().flatMap(property => property.declarations ?? []);
    return properties.flatMap(declaration => {
      const file = this.paths.get(declaration.getSourceFile());
      return file !== undefined && ts.isGetAccessorDeclaration(declaration) && (!own || ts.isObjectLiteralExpression(declaration.parent)) ? [{ file, node: declaration }] : [];
    });
  }
  /** Whether what `node` gives has a source getter among the properties of its type. */
  hasGetters(node: ts.Node): boolean { return this.getters(node).length > 0; }
  /** Whether the type of `node` says nothing of its members: `any` or `unknown`. */
  untyped(node: ts.Node): boolean {
    return (this.checker.getNonNullableType(this.checker.getTypeAtLocation(node)).flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
  }
  /**
   * The declarations of the source that hold code of their own, which TypeScript gives member read `access` on the receiver's type,
   * without the walk's reading of constants: getters, setters, methods with a body, and properties whose value is a function. For a key
   * read by element, each literal its type allows. A check of the walk's outcomes uses it.
   */
  codeDeclarationsAt(access: CadMemberRead): readonly Member[] {
    const receiver = this.checker.getTypeAtLocation(access.expression);
    let declarations: readonly ts.Declaration[];
    if (ts.isPropertyAccessExpression(access)) declarations = this.checker.getSymbolAtLocation(access.name)?.declarations ?? [];
    else {
      const key = this.checker.getTypeAtLocation(access.argumentExpression), parts = key.isUnion() ? key.types : [key];
      declarations = parts.flatMap(part => part.isStringLiteral() || part.isNumberLiteral() ? this.propertyDeclarations(receiver, String(part.value)) : []);
    }
    return declarations.flatMap(declaration => {
      const file = this.paths.get(declaration.getSourceFile());
      const holds = ts.isGetAccessorDeclaration(declaration) || ts.isSetAccessorDeclaration(declaration) ? !!declaration.body
        : ts.isMethodDeclaration(declaration) ? !!declaration.body
          : (ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration(declaration) && declaration.initializer || ts.isShorthandPropertyAssignment(declaration))
            && this.callable(declaration.name);
      return file !== undefined && holds ? [{ file, node: declaration }] : [];
    });
  }
  /**
   * Every declaration TypeScript gives member read `access` on the receiver's type, past imports and re-exports, as a namespace's member
   * is: for a key read by element, each literal its type allows. A check of the walk's coverage uses it.
   */
  readDeclarations(access: CadMemberRead): readonly ts.Declaration[] {
    let symbols: readonly ts.Symbol[];
    if (ts.isPropertyAccessExpression(access)) { const symbol = this.checker.getSymbolAtLocation(access.name); symbols = symbol ? [symbol] : []; }
    else {
      const receiver = this.checker.getTypeAtLocation(access.expression), key = this.checker.getTypeAtLocation(access.argumentExpression);
      symbols = (key.isUnion() ? key.types : [key]).flatMap(part => part.isStringLiteral() || part.isNumberLiteral() ? this.propertySymbols(receiver, String(part.value)) : []);
    }
    return symbols.flatMap(symbol => (symbol.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(symbol) : symbol).declarations ?? []);
  }
  private propertySymbols(type: ts.Type, name: string): readonly ts.Symbol[] {
    if (type.isUnionOrIntersection()) return type.types.flatMap(part => this.propertySymbols(part, name));
    const symbol = this.checker.getPropertyOfType(this.checker.getApparentType(type), name);
    return symbol ? [symbol] : [];
  }
  /**
   * Whether `member` overrides `declaration`: its class implements or extends a type whose member `name` is `declaration`, or is a member
   * of a class above it that overrides `declaration` in turn.
   */
  private overrides(member: ts.Node, name: string, declaration: ts.Declaration, seen = new Set<ts.Node>()): boolean {
    const owner = member.parent;
    if (!ts.isClassLike(owner) || seen.has(member)) return false;
    seen.add(member);
    return !!owner.heritageClauses?.some(clause => clause.types.some(type => this.propertyDeclarations(this.checker.getTypeAtLocation(type), name)
      .some(inherited => inherited === declaration || this.overrides(inherited, name, declaration, seen))));
  }
  /**
   * The code of the project that call or construction `call` may run, as TypeScript gives it: for each signature of the callee's type, each
   * part of a union apart, the function, method or constructor with a body that implements it, inherited by a class without a constructor
   * of its own, an overload standing for its implementation; for a `super(…)`, the constructor it resolves to. Code the index does not
   * hold is given too. None for the platform's and libraries', a signature only a type declares, or a class with no constructor at any
   * depth. A part TypeScript reduced away, as a class of the same shape as another, it cannot give, so there the walk is the only check,
   * following each branch by declaration. No call is resolved against its arguments, which is the costly part. A check of the walk uses it.
   */
  calledDeclarations(call: ts.CallExpression | ts.NewExpression): readonly ts.Node[] {
    if (ts.isCallExpression(call) && call.expression.kind === ts.SyntaxKind.SuperKeyword) return this.implementation(this.checker.getResolvedSignature(call)?.declaration);
    const type = this.checker.getNonNullableType(this.checker.getTypeAtLocation(call.expression));
    const signatures = (part: ts.Type) => {
      const apparent = this.checker.getApparentType(part);
      return ts.isNewExpression(call) ? apparent.getConstructSignatures() : apparent.getCallSignatures();
    };
    return [...new Set((type.isUnion() ? type.types : [type]).flatMap(part => signatures(part).flatMap(signature => this.implementation(signature.declaration))))];
  }
  /**
   * The private property of the source member read `access` names, one only its class may read: declared `private` or with a `#` name.
   * A class with one takes no other object's shape, so no object written elsewhere is one of it.
   */
  privateProperty(access: ts.PropertyAccessExpression): ts.PropertyDeclaration | undefined {
    const declarations = this.checker.getSymbolAtLocation(access.name)?.declarations ?? [];
    const [member] = declarations;
    return declarations.length === 1 && ts.isPropertyDeclaration(member) && this.place(member) !== 'outside'
      && (ts.isPrivateIdentifier(member.name) || (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Private) !== 0) ? member : undefined;
  }
  /** Every read of private property `member` in the files the index holds: by name on any receiver, or by a string key. */
  propertyReads(member: ts.PropertyDeclaration): readonly CadReference[] {
    const cached = this.referenceCache.get(member);
    if (cached) return cached;
    const found: CadReference[] = [], text = member.name.getText(), names = (symbol: ts.Symbol | undefined) => symbol?.declarations?.includes(member) ?? false;
    for (const [file, source] of this.files) {
      if (!source.text.includes(text.replace(/^#/, ''))) continue;
      const visit = (node: ts.Node) => {
        if (ts.isPropertyAccessExpression(node) && node.name.text === text && names(this.checker.getSymbolAtLocation(node.name))) found.push({ file, site: node });
        else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === text
          && names(this.checker.getApparentType(this.checker.getNonNullableType(this.checker.getTypeAtLocation(node.expression))).getProperty(text))) found.push({ file, site: node });
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    this.referenceCache.set(member, found);
    return found;
  }
  /**
   * Whether call `call`, or the function `call` or `apply` calls, may run a function TypeScript gives no implementation of: a signature
   * of the project only a type declares, as a function type, an interface's method or a callable parameter's type, each part of a union
   * callee apart. A check of the walk uses it.
   */
  unimplemented(call: ts.CallExpression): boolean {
    const callee = calleeOf(call);
    if (!callee) return false;
    const type = this.checker.getNonNullableType(this.checker.getTypeAtLocation(callee));
    return (type.isUnion() ? type.types : [type]).some(part => this.checker.getApparentType(part).getCallSignatures().some(({ declaration }) =>
      declaration !== undefined && !ts.isJSDocSignature(declaration) && this.place(declaration) !== 'outside' && !this.implementation(declaration).length));
  }
  /**
   * Whether the member `path` ends at, read off what `node` gives through members, elements and calls by the types TypeScript gives each
   * step, each part of a union apart, is declared only by the platform or a library. Never for a type that says nothing, as `any`.
   */
  outsideMember(node: ts.Node, path: readonly string[]): boolean {
    let types: readonly ts.Type[] = [this.checker.getTypeAtLocation(node)];
    for (const [step, name] of path.entries()) {
      const parts = types.flatMap(type => { const bare = this.checker.getNonNullableType(type); return bare.isUnion() ? bare.types : [bare]; }).map(type => this.checker.getApparentType(type));
      if (!parts.length || parts.some(part => part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) return false;
      if (name === CALL) types = parts.flatMap(part => part.getCallSignatures().map(signature => signature.getReturnType()));
      else if (name === ELEMENT) types = parts.flatMap(part => { const element = this.checker.getIndexTypeOfType(part, ts.IndexKind.Number) ?? this.checker.getIndexTypeOfType(part, ts.IndexKind.String); return element ? [element] : []; });
      else {
        const symbols = parts.map(part => part.getProperty(name));
        if (symbols.some(symbol => !symbol)) return false;
        if (step === path.length - 1) {
          const declarations = symbols.flatMap(symbol => symbol!.declarations ?? []);
          return declarations.length > 0 && declarations.every(declaration => this.place(declaration) === 'outside');
        }
        types = symbols.map(symbol => this.checker.getTypeOfSymbolAtLocation(symbol!, node));
      }
    }
    return false;
  }
  /** The code of the project that signature declaration `declaration` stands for: itself with a body, or an overload's implementation. */
  private implementation(declaration: ts.SignatureDeclaration | ts.JSDocSignature | undefined): readonly ts.Node[] {
    if (!declaration || ts.isJSDocSignature(declaration) || !isFunctionLike(declaration) || this.place(declaration) === 'outside') return [];
    if (declaration.body) return [declaration];
    const owner = declaration.parent, name = declaration.name && propertyName(declaration.name);
    const siblings: readonly ts.Node[] = ts.isClassLike(owner) ? owner.members : ts.isSourceFile(owner) || ts.isBlock(owner) || ts.isModuleBlock(owner) ? owner.statements : [];
    return siblings.filter(sibling => isFunctionLike(sibling) && sibling.body !== undefined && sibling.kind === declaration.kind
      && (ts.isConstructorDeclaration(sibling) || sibling.name !== undefined && propertyName(sibling.name) === name)).slice(0, 1);
  }
  private factories: readonly ts.Node[] | undefined;
  /** The `CadError` factories the source declares. */
  cadErrorFactories(): readonly ts.Node[] {
    return this.factories ??= [...this.files.values()].flatMap(source => source.statements.filter(isCadErrorClass)
      .flatMap(declared => (declared as ts.ClassDeclaration).members.filter(isCadErrorFactory)));
  }
  /** Whether what `node` gives can be called. */
  callable(node: ts.Node): boolean {
    return this.checker.getNonNullableType(this.checker.getTypeAtLocation(node)).getCallSignatures().length > 0;
  }
  /**
   * Whether object literal member `member` implements signature `declaration`: the type the literal is written as, which its declaration
   * or the place it is given gives it, declares its member `name` there. A definition written for one kind of a registry is one, although
   * its type, taking only that kind's values, is no value of the registry's type over every kind.
   */
  private declaredAs(member: ts.Node, name: string, declaration: ts.Declaration): boolean {
    const owner = member.parent, written = ts.isObjectLiteralExpression(owner) ? this.checker.getContextualType(owner) : undefined;
    return written !== undefined && this.propertyDeclarations(written, name).includes(declaration);
  }
  /**
   * Whether the object literal or class instance that has `member` can be a value of `receiver`'s type. An object literal's own type is
   * fresh, which TypeScript checks for properties the receiver's type lacks; once held, as a value read as the receiver is, it may have
   * more, so its widened type, which is not fresh, is tried too.
   */
  private fits(member: ts.Node, receiver: ts.Type): boolean {
    const owner = member.parent;
    if (!ts.isObjectLiteralExpression(owner) && !ts.isClassLike(owner)) return false;
    const type = this.checker.getTypeAtLocation(owner);
    return this.checker.isTypeAssignableTo(type, receiver) || ts.isObjectLiteralExpression(owner) && this.checker.isTypeAssignableTo(this.checker.getWidenedType(type), receiver);
  }
  /** The declarations of property `name` of `type`, through each member of a union or intersection. */
  private propertyDeclarations(type: ts.Type, name: string): readonly ts.Declaration[] {
    if (type.isUnionOrIntersection()) return type.types.flatMap(part => this.propertyDeclarations(part, name));
    return this.checker.getPropertyOfType(this.checker.getApparentType(type), name)?.declarations ?? [];
  }
  private importers: Map<ts.Node, { readonly file: string; readonly name: string }[]> | undefined;
  /** The names each declaration of the source is imported by, in each file that imports it, under its own name, another or as a default. */
  private importedNames(): ReadonlyMap<ts.Node, readonly { readonly file: string; readonly name: string }[]> {
    if (this.importers) return this.importers;
    const found = new Map<ts.Node, { readonly file: string; readonly name: string }[]>();
    for (const [file, imports] of this.imports) for (const [local, { module, name }] of imports) {
      if (name === '*') continue;
      for (const { node } of this.exported(module, name)) (found.get(node) ?? found.set(node, []).get(node)!).push({ file, name: local });
    }
    return this.importers = found;
  }
  private namespaceMembers: readonly { readonly file: string; readonly site: CadMemberRead; readonly module: string; readonly key: string }[] | undefined;
  /** Every member of a namespace the source reads by name or by a literal element, with the module and the export name it reads. */
  private namespaceReads() {
    if (this.namespaceMembers) return this.namespaceMembers;
    const found: { file: string; site: CadMemberRead; module: string; key: string }[] = [];
    for (const [file, source] of this.files) {
      const imports = this.imports.get(file)!;
      if (![...imports.values()].some(entry => entry.name === '*' || this.exportedNamespace(entry.module, entry.name, new Set()))) continue;
      const visit = (node: ts.Node) => {
        if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
          const key = ts.isPropertyAccessExpression(node) ? node.name : bareExpression(node.argumentExpression), receiver = bareExpression(node.expression);
          const text = ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : undefined;
          const module = text !== undefined && ts.isIdentifier(receiver) && imports.has(receiver.text) ? this.namespace(file, receiver) : undefined;
          if (module && text !== undefined) found.push({ file, site: node, module, key: text });
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    return this.namespaceMembers = found;
  }
  /**
   * Every use in the source that resolves to `declaration`: its name in its own file, each name it is imported by elsewhere, under its own
   * name, another or as a default, and each namespace member that reads it, by name or by a literal element.
   */
  references(declaration: CadDiagnosticRoot): readonly CadReference[] {
    const cached = this.referenceCache.get(declaration.node);
    if (cached) return cached;
    const found: CadReference[] = [];
    const names = (target: CadDiagnosticRoot) => target.node === declaration.node, own = declarationName(declaration.node);
    const scans = new Map<string, Set<string>>();
    for (const { file, name } of [...own ? [{ file: declaration.file, name: own }] : [], ...this.importedNames().get(declaration.node) ?? []])
      (scans.get(file) ?? scans.set(file, new Set()).get(file)!).add(name);
    for (const [file, wanted] of scans) {
      const visit = (node: ts.Node) => {
        if (ts.isIdentifier(node) && wanted.has(node.text) && isReference(node) && this.resolve(file, node).some(names)) found.push({ file, site: node });
        ts.forEachChild(node, visit);
      };
      visit(this.files.get(file)!);
    }
    for (const { file, site, module, key } of this.namespaceReads()) if (this.exported(module, key).some(names)) found.push({ file, site });
    this.referenceCache.set(declaration.node, found);
    return found;
  }
}

export function cadDiagnosticReach(index: CadSourceIndex, roots: readonly CadDiagnosticRoot[], options: CadDiagnosticReachOptions = {}): CadDiagnosticReach {
  const { templates = {}, stop = new Set<string>(), receivers } = options;
  const codes = new Set<string>(), unexpanded = new Set<string>(), taken = new Set<string>(), walked = new Set<ts.Node>(), declarations = new Set<string>();
  const walkedHeld = new Set<ts.Node>(), entries: CadDiagnosticEntry[] = [], accesses = new Map<ts.Node, CadMemberOutcome>(), factoryReads = new Set<CadMemberRead>();
  const templated: { readonly file: string; readonly value: ts.TemplateExpression }[] = [];
  const raises = new Set<ts.Node>(), untold = new Set<ts.Node>(), argumentsRead = new Map<ts.Node, Set<ts.Node>>(), escaped = new Set<ts.Node>();
  const unresolved = new Set<ts.Node>(), stopped = new Set<ts.Node>();
  /** The names, member reads, calls and constructions the walk visited, where it reads a parameter's arguments. */
  const visited = new Set<ts.Node>();
  /** The functions the walk entered: declarations it took and functions written in the code it walked. */
  const entered = new Set<ts.Node>();
  /** The calls, and functions given on, whose function the walk traces from the value that gives it (`CadTrace`). */
  const traced = new Set<ts.Node>();
  /** What each of them runs: `value`, read by `path`, traced once the walk is complete and every function it enters is known. */
  const callees: { readonly file: string; readonly site: ts.Node; readonly value: ts.Expression; readonly path: readonly string[]; readonly what: string }[] = [];
  /**
   * The walked calls of each member holding a function, a method or a property read by name (`classify`), which give that function's
   * parameters, and the members whose function goes where the walk cannot see its arguments: given on, called through `call` or
   * `apply`, or reached as a value.
   */
  const memberCalls = new Map<ts.Node, { readonly file: string; readonly call: ts.CallExpression }[]>(), memberGiven = new Set<ts.Node>();
  const queue: CadDiagnosticEntry[] = [...roots];
  /** Enters declaration `found`; `receiver` when it is read only for a member, so a constant object runs its methods only as they are read. */
  const push = ({ file, node }: CadDiagnosticRoot, receiver = false) => {
    const name = (node as { name?: ts.Node }).name;
    if (name && ts.isIdentifier(name) && stop.has(`${file}:${name.text}`)) { stopped.add(node); return; }
    // A factory's caller gives the code it raises, which is read at each call (`factoryRead`); its body only passes that code on. One
    // reached another way may raise a code the walk never reads.
    if (isCadErrorFactory(node)) { unexpanded.add(`${file}: ${(name as ts.Identifier).text}, a CadError factory reached where the walk cannot read its code`); return; }
    const named = name && propertyName(name as ts.PropertyName);
    if (named) declarations.add(`${file}:${named}`);
    // A variable's initializer, the expression a module exports as default, and a class's constructor, field initializers and static
    // blocks are what using them runs.
    const initial = initialValue(node);
    if (ts.isVariableDeclaration(node) || ts.isExportAssignment(node)) {
      const value = initial && bareExpression(initial);
      if (initial) queue.push({ file, node: initial, held: receiver && value && ts.isObjectLiteralExpression(value) ? value : undefined });
    } else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      for (const element of node.members)
        if (ts.isConstructorDeclaration(element) || ts.isPropertyDeclaration(element) && element.initializer || ts.isClassStaticBlockDeclaration(element)) queue.push({ file, node: element });
      // Constructing it runs the constructor and field initializers of the class it extends, which its `super(…)` gives arguments.
      const base = node.heritageClauses?.find(clause => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
      if (base) queue.push({ file, node: base.expression });
    } else queue.push({ file, node });
  };
  /** Parameters that carry a code, or a function a call runs (`CadTrace`), read at the function's walked calls once the walk is complete. */
  const passed: { readonly file: string; readonly owner: ts.FunctionLikeDeclaration; readonly position: number; readonly path: readonly string[]; readonly at: string; readonly trace: CadTrace }[] = [];
  const read = new Set<string>();
  const isConstant = (declaration: ts.VariableDeclaration) => (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0;
  /** The string a key names: a literal, or a constant of the source initialized to one. */
  const keyText = (file: string, key: ts.Expression): string | undefined => {
    const value = bareExpression(key);
    if (ts.isStringLiteralLike(value)) return value.text;
    if (!ts.isIdentifier(value)) return undefined;
    const [found] = index.resolve(file, value), constant = found && constantValue(found.node), initializer = constant && bareExpression(constant);
    return initializer && ts.isStringLiteralLike(initializer) ? initializer.text : undefined;
  };
  /**
   * Reads what `expression` gives once `path` is read off it, for `trace`: collects its codes, or checks the walk entered each function a
   * call of it runs. `at` is the site reported if it cannot.
   */
  const codesOf = (file: string, expression: ts.Expression, path: readonly string[] = [], at = `${file}: ${expression.getText()}`, trace: CadTrace = 'code'): void => {
    const value = bareExpression(expression), key = `${trace}:${file}:${value.pos}:${value.end}:${path.join('.')}`;
    if (read.has(key)) return;
    read.add(key);
    const callee = trace === 'callee';
    // Where the reading is, shown after the site when it went elsewhere; a call's arguments are left out.
    const here = (text = callee ? brief(expression) : expression.getText()) => `${file}: ${text}${path.map(name => name === ELEMENT ? ELEMENT : name === CALL ? '(…)' : `.${name}`).join('')}`;
    const unread = () => { const reached = here(); unexpanded.add(reached === at ? at : `${at}, from ${reached}`); };
    /**
     * What `rest` reads off a function of `owned`: each result of a call, read on. A function holds no code of its own; called, it runs,
     * which the walk entered.
     */
    const called = (owned: string, owner: ts.FunctionLikeDeclaration, rest: readonly string[]) => {
      if (rest[0] === CALL) for (const result of returnsOf(owner)) codesOf(owned, result, rest.slice(1), at, trace);
      else if (callee && rest.length) unread();
      else if (callee && stopped.has(owner)) return;
      else if (callee && !owner.body) unexpanded.add(`${at}, from ${owned}: ${brief(owner)}, a function with no body`);
      else if (callee && !entered.has(owner)) unexpanded.add(`${at}, from ${owned}: ${brief(owner)}, a function the walk did not enter`);
    };
    /**
     * What a declaration of the source gives: a constant's value, or a function's results. Called, a class or an enum runs nothing, a
     * declaration `stop` names is one the walk stops at, a constant map's `get` gives what it stores, and a variable runs its value or
     * any value assigned to it.
     */
    const declared = ({ file: owned, node }: CadDiagnosticRoot, rest: readonly string[]) => {
      const name = declarationName(node);
      if (callee && name !== undefined && stop.has(`${owned}:${name}`)) { stopped.add(node); return; }
      const variable = callee && ts.isVariableDeclaration(node) && isConstant(node) ? node : undefined, made = variable?.initializer && bareExpression(variable.initializer);
      if (variable && made && ts.isNewExpression(made) && ts.isIdentifier(made.expression) && MAPS.has(made.expression.text) && index.outsideName(made.expression)
        && rest[0] === 'get' && rest[1] === CALL) { stored(owned, variable, made, rest.slice(2)); return; }
      const constant = constantValue(node);
      if (constant) codesOf(owned, constant, rest, at, trace);
      else if (isFunctionLike(node)) called(owned, node, rest);
      else if (callee && !rest.length && (ts.isClassLike(node) || ts.isEnumDeclaration(node))) return;
      else if (callee && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) assigned(node, owned, index.references({ file: owned, node }), rest);
      else unread();
    };
    /**
     * What `get` gives of constant map `node`, made empty by `made`: each value a `set` call on it stores. Read, tested or cleared, it
     * stores nothing; built with entries, or used any other way, as given on, it may hold what the walk does not see.
     */
    const stored = (owned: string, node: ts.VariableDeclaration, made: ts.NewExpression, rest: readonly string[]) => {
      if (made.arguments?.length) unexpanded.add(`${at}, from ${owned}: ${brief(made)}, a map built with entries the walk cannot read`);
      for (const { file: user, site } of index.references({ file: owned, node })) {
        const outer = outermost(site as ts.Expression), member = outer.parent, call = member.parent;
        const method = ts.isPropertyAccessExpression(member) && member.expression === outer ? member.name.text : undefined;
        if (method === 'set' && ts.isCallExpression(call) && call.expression === member && call.arguments.length === 2 && !isReceiver(outermost(call))) codesOf(user, call.arguments[1], rest, at, trace);
        else if (method !== 'get' && method !== 'has' && method !== 'delete' && method !== 'clear') unexpanded.add(`${at}, from ${user}: ${brief(member)}, a use of a map the walk cannot read`);
      }
    };
    /**
     * What variable or private property `holder` holds: its initializer and each value assigned to it at `sites`, all of its reads that
     * write it; any other write is reported, and so is one with neither, such as a variable only declared, whose value is set where the
     * walk cannot see.
     */
    const assigned = (holder: ts.VariableDeclaration | ts.PropertyDeclaration, owned: string, sites: readonly CadReference[], rest: readonly string[]) => {
      let given = !!holder.initializer;
      if (holder.initializer) codesOf(owned, holder.initializer, rest, at, trace);
      for (const { file: writer, site } of sites) {
        if (!isAssigned(site)) continue;
        const outer = outermost(site as ts.Expression), write = outer.parent;
        given = true;
        if (ts.isBinaryExpression(write) && write.left === outer && ASSIGNMENTS.has(write.operatorToken.kind)) codesOf(writer, write.right, rest, at, trace);
        else unexpanded.add(`${at}, from ${writer}: ${brief(write)}, a write the walk cannot read`);
      }
      if (!given) unexpanded.add(`${at}, from ${owned}: ${brief(holder.name)}, declared with no value the walk can find`);
    };
    if (path.length > DEPTH) { unread(); return; }
    // Called, a member the platform or a library declares on the type of what reaches it runs none of the source, as a member read does.
    if (callee && path.length && path[path.length - 1] !== CALL && path[path.length - 1] !== ELEMENT && index.outsideMember(value, path)) return;
    if (ts.isConditionalExpression(value)) { codesOf(file, value.whenTrue, path, at, trace); codesOf(file, value.whenFalse, path, at, trace); return; }
    if (ts.isBinaryExpression(value) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(value.operatorToken.kind)) {
      codesOf(file, value.left, path, at, trace); codesOf(file, value.right, path, at, trace);
      return;
    }
    // A logical assignment gives what its target held or what it assigns.
    if (callee && ts.isBinaryExpression(value) && ASSIGNMENTS.has(value.operatorToken.kind) && value.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
      codesOf(file, value.left, path, at, trace); codesOf(file, value.right, path, at, trace);
      return;
    }
    if (value.kind === ts.SyntaxKind.NullKeyword || ts.isIdentifier(value) && value.text === 'undefined') return;
    // Called, a value of no function's type, such as a string, an object or a class, runs nothing; one of type `any` may be any function.
    if (callee && !path.length && !ts.isIdentifier(value) && !index.untyped(value) && !index.callable(value)) return;
    if (ts.isStringLiteralLike(value) || ts.isTemplateExpression(value)) {
      if (callee) return;
      if (!path.length && ts.isStringLiteralLike(value)) codes.add(value.text);
      // Expanded once the walk is complete, when every declaration a substitution's values may depend on is known.
      else if (!path.length && ts.isTemplateExpression(value)) templated.push({ file, value });
      // A string's members hold no code, but what its methods return is built at run time.
      else if (path.includes(CALL)) unread();
      return;
    }
    // Called, a private property read through `this` holds what its class assigns it.
    const owned = callee && ts.isPropertyAccessExpression(value) && value.expression.kind === ts.SyntaxKind.ThisKeyword ? index.privateProperty(value) : undefined;
    if (owned) { assigned(owned, file, index.propertyReads(owned), path); return; }
    // Called, any other member read the walk took runs what its outcome (`CadMemberOutcome`) says: the members it followed, which it
    // entered or traced, or none past a stop, a library's member or a report.
    if (callee && !path.length && (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) && accesses.has(value)) return;
    if (ts.isPropertyAccessExpression(value)) { codesOf(file, value.expression, [value.name.text, ...path], at, trace); return; }
    if (ts.isElementAccessExpression(value)) {
      // A numeric index reads any element; a key the walk cannot tell reads any element or property.
      codesOf(file, value.expression, [keyText(file, value.argumentExpression) ?? ELEMENT, ...path], at, trace);
      return;
    }
    // `Array.from(source, map)` holds what `map` returns.
    if (ts.isCallExpression(value) && path[0] === ELEMENT && value.arguments.length === 2 && value.expression.getText() === 'Array.from') {
      codesOf(file, value.arguments[1], [CALL, ...path.slice(1)], at, trace);
      return;
    }
    // Called, the function the platform's `bind` makes runs the function bound.
    const binder = callee && ts.isCallExpression(value) ? bareExpression(value.expression) : undefined;
    if (binder && ts.isPropertyAccessExpression(binder) && binder.name.text === 'bind' && index.outsideMember(binder.expression, ['bind'])) { codesOf(file, binder.expression, path, at, trace); return; }
    if (ts.isCallExpression(value)) { codesOf(file, value.expression, [CALL, ...path], at, trace); return; }
    if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) { called(file, value, path); return; }
    if (ts.isArrayLiteralExpression(value) && path[0] === ELEMENT) {
      for (const element of value.elements) if (!ts.isOmittedExpression(element))
        codesOf(file, ts.isSpreadElement(element) ? element.expression : element, ts.isSpreadElement(element) ? path : path.slice(1), at, trace);
      return;
    }
    if (ts.isObjectLiteralExpression(value) && path.length) {
      // From the last property: one of that name replaces those before it, and a spread or a computed key may hold it. An absent property
      // holds no code.
      const [name, ...rest] = path;
      for (const property of [...value.properties].reverse()) {
        if (ts.isSpreadAssignment(property)) { codesOf(file, property.expression, path, at, trace); continue; }
        const key = propertyName(property.name), named = name === ELEMENT || key === name;
        if (!named && !(key === undefined && property.name && ts.isComputedPropertyName(property.name))) continue;
        // Reached as a value and called, a member's function is given arguments no walked call of the member shows.
        if (callee || rest[0] === CALL) memberGiven.add(property);
        if (ts.isPropertyAssignment(property)) codesOf(file, property.initializer, rest, at, trace);
        else if (ts.isShorthandPropertyAssignment(property)) codesOf(file, property.name, rest, at, trace);
        else if (ts.isMethodDeclaration(property)) called(file, property, rest);
        else unread();
        if (named && name !== ELEMENT) return;
      }
      return;
    }
    if (ts.isIdentifier(value)) {
      const bound = binding(value);
      if (bound && isBinding(bound)) {
        if (bound.kind === 'parameter') passed.push({ file, owner: bound.owner, position: bound.position, path, at, trace });
        else if (bound.kind === 'element') codesOf(file, bound.of, [ELEMENT, ...path], at, trace);
        // A caught error's code was collected at the `CadError` that raised it, in the walked `try` block.
        else if (bound.kind === 'caught' && !callee && path.length === 1 && path[0] === 'code') taken.add(here());
        else if (bound.kind === 'variable' && bound.element) destructured(file, bound.element, path, at, unread, trace);
        else unread();
        return;
      }
      const namespace = index.namespace(file, value);
      if (namespace) {
        const found = path[0] === ELEMENT || path[0] === CALL || !path.length ? [] : index.exported(namespace, path[0], new Set());
        if (found.length) found.forEach(declaration => declared(declaration, path.slice(1))); else unread();
        return;
      }
      const found = index.resolve(file, value);
      if (found.length) found.forEach(declaration => declared(declaration, path));
      // Called, a function of the platform or a library runs no code of the source; what one returns or holds may be the source's.
      else if (!callee || path.length || !index.outsideName(value)) unread();
      return;
    }
    unread();
  };
  /**
   * What a destructured name gives: the path its pattern reads off the value destructured, a `const` declaration's initializer, each
   * element of a `for…of` list or a parameter, and any default along the way.
   */
  const destructured = (file: string, element: ts.BindingElement, path: readonly string[], at: string, unread: () => void, trace: CadTrace) => {
    let node: ts.Node = element, below = path;
    while (ts.isBindingElement(node)) {
      if (node.initializer) codesOf(file, node.initializer, below, at, trace);
      const pattern: ts.BindingPattern = node.parent;
      // A rest element holds the remaining elements or properties, read by the same path.
      if (!node.dotDotDotToken) {
        const key = ts.isArrayBindingPattern(pattern) ? ELEMENT : propertyName(node.propertyName ?? node.name);
        if (key === undefined) { unread(); return; }
        below = [key, ...below];
      }
      node = pattern.parent;
    }
    if (ts.isParameter(node) && isFunctionLike(node.parent)) passed.push({ file, owner: node.parent, position: node.parent.parameters.indexOf(node), path: below, at, trace });
    else if (ts.isVariableDeclaration(node) && ts.isForOfStatement(node.parent.parent) && isConstant(node)) codesOf(file, node.parent.parent.expression, [ELEMENT, ...below], at, trace);
    else if (ts.isVariableDeclaration(node) && node.initializer && isConstant(node)) codesOf(file, node.initializer, below, at, trace);
    else unread();
  };
  /** The object literals `receiver` names: a variable's value, or the object a parameter stands for (`receivers`). */
  const objectsOf = (file: string, receiver: ts.Identifier) => {
    const objects = index.resolve(file, receiver).flatMap(found => {
      const initial = initialValue(found.node), value = initial && bareExpression(initial);
      return value && ts.isObjectLiteralExpression(value) ? [{ file: found.file, value }] : [];
    });
    if (lexical(receiver) === 'parameter') {
      const stands = receivers?.(file, receiver.text);
      if (stands && ts.isObjectLiteralExpression(stands.node)) objects.push({ file: stands.file, value: stands.node });
    }
    return objects;
  };
  /**
   * The properties of object literal `value` that reading `name` gives: the last of that name, with the other accessor of a pair. Undefined
   * when a spread or a computed key the walk cannot tell, after any of them, may give it instead; empty when nothing does.
   */
  const lastProperties = (value: ts.ObjectLiteralExpression, name: string): readonly ts.ObjectLiteralElementLike[] | undefined => {
    const found: ts.ObjectLiteralElementLike[] = [];
    for (const property of [...value.properties].reverse()) {
      const key = ts.isSpreadAssignment(property) ? undefined : propertyName(property.name);
      if (key === name) {
        const accessor = ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property);
        if (!accessor && found.length) break;
        found.push(property);
        if (!accessor) break;
      } else if (key === undefined && (ts.isSpreadAssignment(property) || property.name !== undefined && ts.isComputedPropertyName(property.name))) {
        return found.length ? found : undefined;
      }
    }
    return found;
  };
  /** The raise `call` makes: its first argument is the code, which a missing or spread argument hides. */
  const raisedAt = (file: string, call: ts.CallExpression | ts.NewExpression) => {
    raises.add(call);
    const first = call.arguments?.[0];
    if (first && !ts.isSpreadElement(first)) codesOf(file, first);
    else unexpanded.add(`${file}: ${call.getText()}, a CadError raised with a code the walk cannot read`);
  };
  /**
   * The classes `expression` names, by declaration: a class or class expression, a constant that holds one, a namespace's export by name or
   * literal element, a constant object's property, a readonly field's value, a module's default export, and each branch of a
   * conditional, through each in turn. Empty for what is no class of the source, such as the platform's; undefined when it cannot tell,
   * as for a parameter, a variable that is not constant, a call's result, a member it cannot read, a namespace, or a name or member it
   * cannot find in the source that TypeScript does not show to be outside it.
   */
  const classesNamed = (file: string, expression: ts.Expression, seen = new Set<ts.Node>()): readonly CadDiagnosticRoot[] | undefined => {
    const value = bareExpression(expression);
    if (seen.has(value)) return [];
    seen.add(value);
    const all = (parts: readonly (readonly CadDiagnosticRoot[] | undefined)[]) => parts.includes(undefined) ? undefined : parts.flatMap(part => part ?? []);
    const declared = (found: readonly CadDiagnosticRoot[]) => all(found.map(({ file: owner, node }) => {
      if (ts.isClassLike(node)) return [{ file: owner, node }];
      if (ts.isVariableDeclaration(node) || ts.isExportAssignment(node)) { const constant = constantValue(node); return constant ? classesNamed(owner, constant, seen) : undefined; }
      if (ts.isPropertyAssignment(node)) return classesNamed(owner, node.initializer, seen);
      if (ts.isShorthandPropertyAssignment(node)) return classesNamed(owner, node.name, seen);
      if (ts.isPropertyDeclaration(node)) return node.initializer && ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Readonly ? classesNamed(owner, node.initializer, seen) : undefined;
      return ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isEnumDeclaration(node) ? [] : undefined;
    }));
    if (ts.isClassExpression(value)) return [{ file, node: value }];
    if (ts.isConditionalExpression(value)) return all([classesNamed(file, value.whenTrue, seen), classesNamed(file, value.whenFalse, seen)]);
    if (ts.isIdentifier(value)) {
      const bound = binding(value);
      if (bound && isBinding(bound) || index.namespace(file, value)) return undefined;
      const found = index.resolve(file, value);
      return found.length ? declared(found) : index.outsideName(value) ? [] : undefined;
    }
    if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
      const key = ts.isPropertyAccessExpression(value) ? value.name.text : keyText(file, value.argumentExpression);
      if (key === undefined) return undefined;
      const receiver = bareExpression(value.expression), namespace = ts.isIdentifier(receiver) ? index.namespace(file, receiver) : undefined;
      if (namespace) { const found = index.exported(namespace, key); return found.length ? declared(found) : undefined; }
      const objects = ts.isIdentifier(receiver) ? objectsOf(file, receiver) : [];
      if (objects.length) {
        const properties = objects.map(({ file: owner, value: object }) => lastProperties(object, key)?.map(node => ({ file: owner, node })));
        return properties.includes(undefined) ? undefined : declared(properties.flatMap(found => found ?? []));
      }
      const { members, outside, unindexed } = index.memberDeclarations(value, key);
      return unindexed ? undefined : members.length ? declared(members) : outside ? [] : undefined;
    }
    return undefined;
  };
  /** The base class expression of class `node`. */
  const extendsOf = (node: ts.ClassLikeDeclaration | undefined) => node?.heritageClauses?.find(clause => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
  const raisers = new Map<ts.Node, 'class' | 'factory' | undefined>();
  /**
   * What declaration `found` is: `class` for the `CadError` class, a class without a constructor whose base is one in turn, since its
   * arguments go to its base's constructor, or a constant that holds one; `factory` for one of its factories held by a constant, or a
   * constant that holds one in turn; undefined for anything else.
   */
  const raiser = ({ file, node }: CadDiagnosticRoot): 'class' | 'factory' | undefined => {
    if (raisers.has(node)) return raisers.get(node);
    raisers.set(node, undefined);
    let found: 'class' | 'factory' | undefined;
    const raisesClass = (expression: ts.Expression) => classesNamed(file, expression)?.some(named => raiser(named) === 'class') === true;
    if (isCadErrorClass(node)) found = 'class';
    else if (ts.isClassLike(node)) {
      const base = extendsOf(node);
      if (base && !node.members.some(ts.isConstructorDeclaration) && raisesClass(base)) found = 'class';
    } else if (constantValue(node)) {
      const value = bareExpression(constantValue(node)!);
      if (ts.isIdentifier(value)) found = index.resolve(file, value).map(raiser).find(Boolean);
      else if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) {
        const key = ts.isPropertyAccessExpression(value) ? value.name.text : keyText(file, value.argumentExpression);
        if ((key === undefined || FACTORIES.has(key)) && index.codeDeclarationsAt(value).some(member => isCadErrorFactory(member.node))) found = 'factory';
      }
      if (!found && raisesClass(value)) found = 'class';
    }
    raisers.set(node, found);
    return found;
  };
  /** Where `read` gives what it names: past parentheses, assertions and non-null assertions. */
  const outermost = (read: ts.Expression) => {
    let outer: ts.Expression = read;
    while (ts.isParenthesizedExpression(outer.parent) || ts.isNonNullExpression(outer.parent) || ts.isAsExpression(outer.parent) || ts.isSatisfiesExpression(outer.parent)) outer = outer.parent;
    return outer;
  };
  /** What gives what `outer` gives: the outermost conditional it is a branch of, at any depth, or itself. */
  const branchOf = (outer: ts.Expression): ts.Expression => {
    while (ts.isConditionalExpression(outer.parent) && outer.parent.condition !== outer) outer = outermost(outer.parent);
    return outer;
  };
  /** Whether `outer` is what a constant is initialized to, so the constant holds what it gives. */
  const heldByConstant = (outer: ts.Expression) => ts.isVariableDeclaration(outer.parent) && outer.parent.initializer === outer && ts.isIdentifier(outer.parent.name) && isConstant(outer.parent);
  /**
   * A read of a `CadError` factory, by name or through a constant that holds it: called, its first argument is the code; held by another
   * constant, it is read at that constant's calls. A presence test or a write runs nothing; any other use is reported.
   */
  const factoryRead = (file: string, read: ts.Expression): CadMemberOutcome => {
    const outer = outermost(read), parent = outer.parent;
    if (ts.isCallExpression(parent) && parent.expression === outer) raisedAt(file, parent);
    else if (!heldByConstant(outer)) {
      const use = methodUse(read);
      if (use === 'tested' || use === 'write' || use === 'update') return 'no-code';
      unexpanded.add(`${file}: ${read.getText()}, a CadError factory ${use === 'called' ? 'called through call or apply' : 'given on'}, whose code the walk cannot read`);
      index.cadErrorFactories().forEach(factory => escaped.add(factory));
      if (!ts.isIdentifier(read)) factoryReads.add(read as CadMemberRead);
      return 'unexpanded';
    }
    if (!ts.isIdentifier(read)) factoryReads.add(read as CadMemberRead);
    return 'followed';
  };
  /**
   * A read of the `CadError` class: constructed or called, its first argument is the code. Testing an instance's class, reading a member,
   * extending it or a constant that holds it, through either branch of a conditional, raises nothing here; any other use, destructuring it included, is reported, since what
   * constructs it or calls its factories is unseen.
   */
  const classRead = (file: string, read: ts.Expression) => {
    const outer = outermost(read), parent = outer.parent;
    if ((ts.isNewExpression(parent) || ts.isCallExpression(parent)) && parent.expression === outer) { raisedAt(file, parent); return; }
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && parent.right === outer || isReceiver(outer)
      || ts.isExpressionWithTypeArguments(parent) && ts.isHeritageClause(parent.parent) || heldByConstant(branchOf(outer))) return;
    unexpanded.add(`${file}: ${read.getText()}, ${ts.isIdentifier(read) && read.text === 'CadError' ? 'the CadError class' : 'a class raising CadError'} used as a value, which the walk cannot follow`);
    // What calls its factories through that value is unseen; what constructs it is a `new` the walk cannot tell, reported where it is.
    index.cadErrorFactories().forEach(factory => escaped.add(factory));
  };
  /** Whether member `node` runs when read with `use`: a getter on a read, a setter on a write, a function when called or given on. */
  const runs = (node: ts.Node, use: ReturnType<typeof methodUse>) => {
    if (ts.isGetAccessorDeclaration(node)) return use !== 'write';
    if (ts.isSetAccessorDeclaration(node)) return use === 'write' || use === 'update';
    return (use === 'called' || use === 'passed' || use === 'other') && index.callable((node as { name?: ts.Node }).name ?? node);
  };
  /**
   * Runs what member read `access` runs of members `found`, by how it is used (`methodUse`): a getter on any read, a presence test
   * included; a setter on a write; a method, or a property holding a function, when called or given on. Reading a property that holds no
   * function runs nothing, and any other use of a function is reported.
   */
  const classify = (file: string, access: CadMemberRead, found: readonly CalledMember[]): CadMemberOutcome => {
    const use = methodUse(access);
    let outcome: CadMemberOutcome = 'no-code';
    const follow = (found: CalledMember) => {
      const node = found.node, at = siteOf(access), calls = use === 'called' || use === 'passed';
      // A member's walked calls give its function's parameters, a call the walk stops at included; given on, or called through `call` or
      // `apply`, it gets them elsewhere.
      if (calls && !ts.isGetAccessorDeclaration(node) && !ts.isSetAccessorDeclaration(node)) {
        if (ts.isCallExpression(at) && at.expression === outermost(access)) (memberCalls.get(node) ?? memberCalls.set(node, []).get(node)!).push({ file, call: at });
        else memberGiven.add(node);
      }
      if (found.through && stop.has(found.through)) { stopped.add(node); if (outcome === 'no-code') outcome = 'stopped'; return; }
      push(found);
      outcome = 'followed';
      if (!calls) return;
      // Called or given on, what a property holds or a getter returns runs, traced from that value.
      if (ts.isGetAccessorDeclaration(node)) for (const result of returnsOf(node)) callees.push({ file: found.file, site: at, value: result, path: [], what: 'a function a getter returns' });
      else if (ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node) && node.initializer) callees.push({ file: found.file, site: at, value: node.initializer!, path: [], what: 'a function a property holds' });
      else if (ts.isShorthandPropertyAssignment(node) || ts.isParameter(node) && ts.isIdentifier(node.name)) callees.push({ file: found.file, site: at, value: node.name as ts.Identifier, path: [], what: 'a function a property holds' });
      else if (ts.isPropertyDeclaration(node)) unexpanded.add(`${file}: ${brief(at)}, from ${found.file}: ${brief(node)}, a property declared without a value`);
    };
    for (const each of found) {
      const node = each.node;
      if (ts.isGetAccessorDeclaration(node)) { if (use !== 'write') follow(each); continue; }
      if (ts.isSetAccessorDeclaration(node)) { if (use === 'write' || use === 'update') follow(each); continue; }
      if (use === 'write' || use === 'update' || use === 'tested' || !ts.isMethodDeclaration(node) && !index.callable(access)) continue;
      if (isCadErrorFactory(node)) {
        if (factoryRead(file, access) === 'unexpanded') return 'unexpanded';
        outcome = 'followed';
        continue;
      }
      if (use === 'other') {
        unexpanded.add(`${file}: ${access.getText()}, a method used as a value the walk does not follow`);
        // What calls the methods it may give is unseen.
        found.forEach(member => escaped.add(member.node));
        return 'unexpanded';
      }
      follow(each);
    }
    return outcome;
  };
  /** What member read `access` runs, which it enters; every way out names what became of it. */
  const memberOutcome = (file: string, access: CadMemberRead): CadMemberOutcome => {
    const receiver = bareExpression(access.expression), use = methodUse(access);
    const key = ts.isElementAccessExpression(access) ? keyText(file, access.argumentExpression) : access.name.text;
    const names = key !== undefined ? [key] : index.literalKeys((access as ts.ElementAccessExpression).argumentExpression);
    if (!names) {
      // An element read by a key the walk cannot tell runs no code of the source, unless what it holds is a function called or given on,
      // or the receiver has a getter it may read.
      const calls = use === 'called' || (use === 'passed' || use === 'other') && index.callable(access);
      if (!calls && (use === 'write' || !index.hasGetters(access.expression))) return 'no-code';
      unexpanded.add(`${file}: ${access.getText()}, an element read by a key the walk cannot tell`);
      return 'unexpanded';
    }
    if (ts.isIdentifier(receiver)) {
      const namespace = index.namespace(file, receiver);
      if (namespace) {
        // A namespace's member is the export it names, used as any other name is.
        const found = names.flatMap(name => index.exported(namespace, name, new Set()));
        if (!found.length) { unexpanded.add(`${file}: ${access.getText()}, a namespace member the walk cannot find`); return 'unexpanded'; }
        let outcome: CadMemberOutcome = 'followed';
        for (const declaration of found) {
          const raises = raiser(declaration);
          if (raises === 'class') classRead(file, access);
          if (raises === 'factory' && factoryRead(file, access) === 'unexpanded') outcome = 'unexpanded';
          push(declaration, isReceiver(access));
        }
        return outcome;
      }
      const objects = objectsOf(file, receiver);
      if (objects.length) {
        const found = objects.flatMap(({ file: owner, value }) => names.map(name => lastProperties(value, name)?.map(node => ({ file: owner, node, through: undefined }))));
        // A spread or a computed key that may give the member leaves it to the receiver's type.
        if (found.every(properties => properties !== undefined)) return classify(file, access, found.flatMap(properties => properties ?? []));
      }
    }
    // The receiver's type says which members the read runs.
    const found: CalledMember[] = [], undeclared: string[] = [], bare: string[] = [];
    let source = false;
    for (const name of names) {
      const declared = index.accessedMembers(access, name, member => runs(member, use));
      if (!declared) undeclared.push(name);
      else if (declared.unindexed) { unexpanded.add(`${file}: ${access.getText()}, a member declared in code of the project the walk does not hold`); return 'unexpanded'; }
      else {
        found.push(...declared.members); source ||= declared.source;
        if (declared.bare.some(through => !through || !stop.has(through))) bare.push(name);
      }
    }
    if (undeclared.length && index.untyped(access.expression)) {
      // A receiver whose type says nothing, such as `any`, may be any of the source's members of that name.
      if (undeclared.some(name => index.membersNamed(name).some(candidate => runs(candidate.node, use)))) {
        unexpanded.add(`${file}: ${access.getText()}, a method its receiver's type does not declare`);
        return 'unexpanded';
      }
    } else if (undeclared.length && (use === 'called' || use === 'passed' || use === 'other') && index.callable(access)) {
      // A type that gives the member without declaring it, such as a record mapped over kinds, has no getter; a function it holds is a
      // property or method of that name of the source's object literals and classes, any of which it may hold.
      const holders = undeclared.flatMap(name => index.membersNamed(name)).filter(candidate => runs(candidate.node, use) && !ts.isGetAccessorDeclaration(candidate.node));
      if (!holders.length) { unexpanded.add(`${file}: ${access.getText()}, a function its receiver's type holds that the walk cannot find`); return 'unexpanded'; }
      found.push(...holders.map(holder => ({ ...holder, through: undefined })));
    }
    // Called or given on, a function only signatures of the source declare, which no object or class of the source fits, is what the
    // receiver holds, traced from the receiver.
    const traces = (use === 'called' || use === 'passed') && bare.length > 0 && index.callable(access);
    const own = traces && ts.isPropertyAccessExpression(access) && access.expression.kind === ts.SyntaxKind.ThisKeyword && index.privateProperty(access);
    if (traces) for (const name of bare)
      callees.push({ file, site: siteOf(access), value: own ? access : access.expression, path: own ? [] : [name], what: 'a member only a signature declares' });
    if (found.length) { const outcome = classify(file, access, found); return outcome === 'no-code' && traces ? 'traced' : outcome; }
    if (traces) return 'traced';
    return undeclared.length || source ? 'no-code' : 'outside';
  };
  const member = (file: string, access: CadMemberRead) => { accesses.set(access, memberOutcome(file, access)); };
  /** A destructuring read runs the getters of the names it binds, and every own getter a rest element takes. */
  const destructuredGetters = (file: string, pattern: ts.ObjectBindingPattern) => {
    const names: string[] = [];
    let rest = false;
    for (const element of pattern.elements) {
      if (element.dotDotDotToken) { rest = true; continue; }
      const name = propertyName(element.propertyName ?? (ts.isIdentifier(element.name) ? element.name : undefined));
      if (name !== undefined) names.push(name);
      else if (index.hasGetters(pattern)) unexpanded.add(`${file}: ${element.getText()}, a destructured key the walk cannot tell`);
    }
    for (const found of index.getters(pattern, names)) push(found);
    if (rest) for (const found of index.getters(pattern, undefined, true)) push(found);
  };
  /**
   * A name the walk resolves to no declaration of the source. A parameter, a caught error and a loop or destructured variable stand for a
   * value read where it is given; a variable a statement destructures also runs the value it is destructured from
   * (`destructuredDeclaration`). A namespace runs its exports as its members are read; used as a value any other way, it is reported, and
   * runs them all, as a constant object does. Any other name is reported unless TypeScript shows it names nothing of the source
   * (`outsideName`): the walk never takes a name it cannot find to run nothing.
   */
  const unfound = (file: string, name: ts.Identifier) => {
    const declaration = destructuredDeclaration(name);
    if (declaration) { push({ file, node: declaration }); return; }
    if (lexical(name) === 'parameter') return;
    const namespace = index.namespace(file, name);
    if (namespace) {
      if (isReceiver(name) || ts.isTypeOfExpression(outermost(name).parent)) return;
      unresolved.add(name);
      unexpanded.add(`${file}: ${name.text}, a namespace used as a value, which the walk cannot follow`);
      for (const found of index.moduleExports(namespace)) push(found);
      return;
    }
    if (index.outsideName(name)) return;
    unresolved.add(name);
    unexpanded.add(`${file}: ${name.text}, a name the walk cannot resolve to a declaration of the source`);
  };
  /**
   * Whether calling `callee` runs a function the walk does not enter by its name, which it traces from the value that gives it instead
   * (`CadTrace`): a parameter, a loop, caught or destructured name, a variable, or any value but a name, a member read or a function
   * written there. A function or class declaration, an enum, a namespace and a raise, whose code `raisedAt` reads, are entered by name;
   * a member read runs what `memberOutcome` gives; a name the walk cannot resolve is reported (`unfound`).
   */
  const heldFunction = (file: string, callee: ts.Expression): boolean => {
    const value = bareExpression(callee);
    if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value) || ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return false;
    if (!ts.isIdentifier(value)) return true;
    const bound = binding(value);
    if (bound && isBinding(bound)) return true;
    if (index.namespace(file, value)) return false;
    return index.resolve(file, value).some(declaration => !raiser(declaration) && !ts.isClassLike(declaration.node) && !ts.isEnumDeclaration(declaration.node)
      && !(isFunctionLike(declaration.node) && declaration.node.body));
  };
  /** The call that runs what `read` gives, directly or through `call` or `apply`, or the read itself when it is given on. */
  const siteOf = (read: ts.Expression): ts.Node => {
    const outer = outermost(read), parent = outer.parent;
    if (ts.isCallExpression(parent) && parent.expression === outer) return parent;
    return ts.isPropertyAccessExpression(parent) && parent.expression === outer && ts.isCallExpression(parent.parent) && parent.parent.expression === parent ? parent.parent : read;
  };
  /**
   * A call of a function a value gives, and a function a value gives that is passed to code outside the source, which may call it, are
   * traced from that value. A function given to a function of the source is read at that function's calls of its parameter.
   */
  const heldCall = (file: string, child: ts.Node) => {
    if (ts.isCallExpression(child)) {
      const callee = calleeOf(child);
      if (callee && heldFunction(file, callee)) callees.push({ file, site: child, value: callee, path: [], what: 'a call of a function a value gives' });
      return;
    }
    if (!ts.isIdentifier(child) || !isReference(child) || methodUse(child) !== 'passed') return;
    const outer = outermost(child), call = outer.parent;
    if ((ts.isCallExpression(call) || ts.isNewExpression(call)) && call.arguments?.includes(outer) && heldFunction(file, child) && index.callable(child)
      && !index.calledDeclarations(call).length && !(ts.isCallExpression(call) && index.unimplemented(call)))
      callees.push({ file, site: child, value: child, path: [], what: 'a function given to code outside the source' });
  };
  while (queue.length) {
    const entry = queue.pop()!, { file, node, held } = entry;
    if (walked.has(node) || held && walkedHeld.has(node)) continue;
    (held ? walkedHeld : walked).add(node);
    entries.push(entry);
    // Objects read only for their members: the held one and those its properties hold.
    const heldObjects = new Set<ts.Node>(held ? [held] : []);
    const visit = (child: ts.Node) => {
      // The class a class written here extends is a value, which constructing it runs.
      if (isExtended(child)) { visit(child.expression); return; }
      if (isTypeOnly(child)) return;
      if (ts.isPropertyAssignment(child) && propertyName(child.name) === 'code') codesOf(file, child.initializer);
      else if (ts.isShorthandPropertyAssignment(child) && child.name.text === 'code') codesOf(file, child.name);
      if (ts.isIdentifier(child) || ts.isPropertyAccessExpression(child) || ts.isElementAccessExpression(child) || ts.isCallExpression(child) || ts.isNewExpression(child)) visited.add(child);
      if (isFunctionLike(child)) entered.add(child);
      heldCall(file, child);
      // A `new` of a class that raises, and the `super(…)` of a class whose base raises, however each is named, raise one. One whose class
      // the walk cannot tell is reported.
      const constructs = ts.isNewExpression(child) ? child.expression
        : ts.isCallExpression(child) && child.expression.kind === ts.SyntaxKind.SuperKeyword ? extendsOf(ts.findAncestor(child, ts.isClassLike)) : undefined;
      if (constructs) {
        const classes = classesNamed(file, constructs);
        if (!classes) { untold.add(child); unexpanded.add(`${file}: ${constructs.getText()}, a class the walk cannot tell, constructed`); }
        else if (classes.some(found => raiser(found) === 'class')) raisedAt(file, child as ts.NewExpression | ts.CallExpression);
      }
      if (ts.isIdentifier(child) && isReference(child)) {
        const found = index.resolve(file, child);
        for (const each of found) {
          const raises = raiser(each);
          if (raises === 'class') classRead(file, child);
          else if (raises === 'factory') factoryRead(file, child);
          push(each, isReceiver(child));
        }
        if (!found.length) unfound(file, child);
      }
      if (ts.isPropertyAccessExpression(child) || ts.isElementAccessExpression(child)) member(file, child);
      if (ts.isObjectBindingPattern(child)) destructuredGetters(file, child);
      if (ts.isSpreadAssignment(child)) index.getters(child.expression, undefined, true).forEach(found => push(found));
      if (heldObjects.has(child)) {
        // A held object's methods and accessors run as member reads run them, as a class's do; its property values run with it.
        for (const property of (child as ts.ObjectLiteralExpression).properties) {
          if (ts.isMethodDeclaration(property) || ts.isGetAccessorDeclaration(property) || ts.isSetAccessorDeclaration(property)) {
            if (ts.isComputedPropertyName(property.name)) visit(property.name);
            continue;
          }
          const value = ts.isPropertyAssignment(property) ? bareExpression(property.initializer) : undefined;
          if (value && ts.isObjectLiteralExpression(value)) heldObjects.add(value);
          visit(property);
        }
        return;
      }
      ts.forEachChild(child, visit);
    };
    if (isFunctionLike(node)) {
      entered.add(node);
      if (node.body) visit(node.body);
      // A parameter's default and the getters and defaults of a destructured parameter run as it is called.
      for (const parameter of node.parameters) { if (parameter.initializer) visit(parameter.initializer); if (!ts.isIdentifier(parameter.name)) visit(parameter.name); }
    }
    else if (ts.isPropertyDeclaration(node)) { if (node.initializer) visit(node.initializer); }
    else if (ts.isPropertyAssignment(node)) visit(node.initializer);
    else visit(node);
  }
  // A parameter gives what each walked call passes it; a function passed on as a value has callers the walk cannot see.
  /**
   * The walked uses of declaration `declaration`: its names and the namespace members that read it (`references`), and those of each
   * constant that holds it, in turn, instead of the constant's initializer.
   */
  const uses = (file: string, declaration: ts.Node, seen = new Set<ts.Node>()): readonly { readonly file: string; readonly site: ts.Expression; readonly outer: ts.Expression }[] => {
    if (seen.has(declaration)) return [];
    seen.add(declaration);
    return index.references({ file, node: declaration }).flatMap(({ file: caller, site }) => {
      if (!visited.has(site)) return [];
      const outer = outermost(site), holder = outer.parent;
      return heldByConstant(outer) && ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name) ? uses(caller, holder, seen) : [{ file: caller, site, outer }];
    });
  };
  /**
   * The declaration a class is used by: a class declaration, named or a module's default export, or the constant or default export that
   * holds a class expression.
   */
  const className = (owner: ts.ClassLikeDeclaration): ts.Node | undefined => {
    if (ts.isClassDeclaration(owner)) return owner.name || hasModifier(owner, ts.SyntaxKind.DefaultKeyword) ? owner : undefined;
    const holder = outermost(owner).parent;
    if (ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name) && isConstant(holder)) return holder;
    return ts.isExportAssignment(holder) && !holder.isExportEquals ? holder : undefined;
  };
  /**
   * What each walked `new` of class `owner` gives parameter `position` of constructor `built`, its own or the one it inherits, and each
   * walked `super(…)` of a subclass, however the class is named.
   */
  const constructed = (file: string, owner: ts.ClassLikeDeclaration, built: ts.ConstructorDeclaration, position: number, path: readonly string[], at: string, trace: CadTrace) => {
    const named = className(owner);
    if (!named) { unexpanded.add(`${at}, from ${file}: an unnamed class`); escaped.add(built); return; }
    for (const { file: caller, site, outer } of uses(file, named)) {
      const parent = outer.parent;
      if (ts.isNewExpression(parent) && parent.expression === outer) { argument(caller, parent, built, position, path, at, file, trace); continue; }
      const clause = ts.isExpressionWithTypeArguments(parent) && ts.isHeritageClause(parent.parent) && parent.parent.token === ts.SyntaxKind.ExtendsKeyword ? parent.parent : undefined;
      if (clause) {
        const subclass = clause.parent;
        if (!ts.isClassLike(subclass)) continue;
        const own = subclass.members.find(ts.isConstructorDeclaration);
        // A subclass without a constructor passes its own arguments on.
        if (!own) { constructed(caller, subclass, built, position, path, at, trace); continue; }
        const visit = (node: ts.Node): void => {
          if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) { if (visited.has(node)) argument(caller, node, built, position, path, at, file, trace); return; }
          if (!isFunctionLike(node) || node === own) ts.forEachChild(node, visit);
        };
        visit(own);
        continue;
      }
      // Testing an instance's class or reading a static member constructs nothing.
      if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && parent.right === outer || isReceiver(outer)) continue;
      unexpanded.add(`${caller}: ${site.getText()} passed on`);
      escaped.add(built);
    }
  };
  /**
   * What call `call` of `owner` gives the parameter at `position`, or its default, read for `trace`. Called without one, a parameter
   * gives no function to call.
   */
  const argument = (caller: string, call: ts.NewExpression | ts.CallExpression, owner: ts.FunctionLikeDeclaration, position: number, path: readonly string[], at: string, file: string, trace: CadTrace) => {
    const given = call.arguments ?? [], fallback = owner.parameters[position].initializer;
    (argumentsRead.get(owner) ?? argumentsRead.set(owner, new Set()).get(owner)!).add(call);
    if (given.slice(0, position + 1).some(ts.isSpreadElement)) unexpanded.add(`${caller}: ${call.getText()}`);
    else if (given[position]) codesOf(caller, given[position], path, at, trace);
    else if (fallback) codesOf(file, fallback, path, at, trace);
    else if (trace === 'code') unexpanded.add(`${caller}: ${call.getText()}`);
  };
  /**
   * What gives parameter `position` of function `owner`, written as an argument of a call, when a function is traced from it: each
   * function of the source TypeScript says the call runs takes `owner` as a parameter it calls, and each of those walked calls gives an
   * argument, read on. Given on to another function of the source, the parameter is read there in turn; any other use of it is reported.
   * False when the walk cannot tell, as for a call of code outside the source, or a function that takes `owner` by a pattern or a rest
   * parameter. `outer` is the argument that gives `owner`: itself, or a value that holds it.
   */
  const given = (file: string, owner: ts.FunctionLikeDeclaration, position: number, path: readonly string[], at: string,
    outer: ts.Expression = outermost(owner as ts.Expression), seen = new Set<ts.Node>()): boolean => {
    const call = outer.parent;
    if (!ts.isCallExpression(call) && !ts.isNewExpression(call)) return false;
    const slot = call.arguments?.indexOf(outer) ?? -1;
    if (slot < 0 || call.arguments!.slice(0, slot).some(ts.isSpreadElement) || ts.isCallExpression(call) && index.unimplemented(call)) return false;
    const runners = index.calledDeclarations(call);
    const takes = runners.map(runner => isFunctionLike(runner) && index.place(runner) === 'source' ? runner.parameters[slot] : undefined);
    if (!runners.length || takes.some(parameter => !parameter || parameter.dotDotDotToken || !ts.isIdentifier(parameter.name))) return false;
    runners.forEach((runner, place) => {
      const parameter = takes[place]!, name = (parameter.name as ts.Identifier).text, where = index.where(runner);
      if (seen.has(parameter)) return;
      seen.add(parameter);
      if (!entered.has(runner)) { unexpanded.add(`${at}, from ${where}: ${brief(runner)}, a function the walk did not enter`); return; }
      const visit = (node: ts.Node) => {
        if (ts.isIdentifier(node) && node.text === name && isReference(node) && index.nameDeclarations(node).declarations.includes(parameter)) {
          const site = outermost(node), use = site.parent;
          if (ts.isCallExpression(use) && use.expression === site) { if (visited.has(use)) argument(where, use, owner, position, path, at, file, 'callee'); }
          else if (!(ts.isCallExpression(use) || ts.isNewExpression(use)) || !use.arguments?.includes(site) || visited.has(use) && !given(file, owner, position, path, at, site, seen))
            unexpanded.add(`${at}, from ${where}: ${brief(use)}, ${name} given on`);
        }
        ts.forEachChild(node, visit);
      };
      visit(runner);
    });
    return true;
  };
  /** The list whose iteration method (`ITERATIONS`) is given `outer` as its callback, which takes each element, its index and the list. */
  const iteratedBy = (outer: ts.Expression) => {
    const call = outer.parent;
    return ts.isCallExpression(call) && call.arguments[0] === outer && ts.isPropertyAccessExpression(call.expression) && ITERATIONS.has(call.expression.name.text) ? call.expression.expression : undefined;
  };
  /** What a list's iteration gives a callback's parameter `position`: each element, its index, which holds nothing, or the list. */
  const iterated = (file: string, list: ts.Expression, position: number, path: readonly string[], at: string, trace: CadTrace) => {
    if (position === 0) codesOf(file, list, [ELEMENT, ...path], at, trace);
    else if (position === 2) codesOf(file, list, path, at, trace);
  };
  /** The named function whose result function `owner` is: an arrow's body, or what a `return` gives. */
  const returnedBy = (owner: ts.FunctionLikeDeclaration) => {
    const outer = outermost(owner as ts.Expression), parent = outer.parent;
    let maker: ts.Node | undefined = ts.isArrowFunction(parent) && parent.body === outer ? parent : undefined;
    if (ts.isReturnStatement(parent)) for (let node: ts.Node = parent.parent; node && !maker; node = node.parent) if (isFunctionLike(node)) maker = node;
    return maker && isFunctionLike(maker) ? functionName(maker) : undefined;
  };
  /**
   * What the walked calls of named function `maker`, which returns function `owner`, give its parameter `position`: each result called at
   * once, or given to a function of the source (`given`). Any other use of a result is reported.
   */
  const made = (file: string, maker: ts.Node, owner: ts.FunctionLikeDeclaration, position: number, path: readonly string[], at: string, parameter: string) => {
    const calls = uses(file, maker);
    if (!calls.length) unexpanded.add(`${at}, from ${file}: ${parameter}, a parameter of a function the walk sees no call of`);
    for (const { file: caller, site, outer } of calls) {
      const call = outer.parent, result = ts.isCallExpression(call) && call.expression === outer ? outermost(call) : undefined, use = result?.parent;
      if (result && use && ts.isCallExpression(use) && use.expression === result) argument(caller, use, owner, position, path, at, file, 'callee');
      else if (!result || !given(file, owner, position, path, at, result)) { unexpanded.add(`${caller}: ${brief(call)}, the function ${brief(site)} returns, passed on`); escaped.add(owner); }
    }
  };
  /** The member that holds function `owner`, read by name: a method, or a property whose value it is. */
  const holderOf = (owner: ts.FunctionLikeDeclaration): ts.Node | undefined => {
    if (ts.isMethodDeclaration(owner)) return owner;
    const outer = outermost(owner as ts.Expression), parent = outer.parent;
    return (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) && parent.initializer === outer ? parent : undefined;
  };
  /** The functions whose parameters member calls gave, checked once every trace is done for a member that went elsewhere. */
  const membered: { readonly holder: ts.Node; readonly owner: ts.Node; readonly at: string; readonly file: string; readonly parameter: string }[] = [];
  /**
   * What the walked calls of member `holder` give parameter `position` of its function `owner`, those the walk stops at included. A
   * member called nowhere the walk reaches gives what the walk does not see.
   */
  const memberArguments = (holder: ts.Node, owner: ts.FunctionLikeDeclaration, position: number, path: readonly string[], at: string, file: string, trace: CadTrace, parameter: string) => {
    const calls = memberCalls.get(holder) ?? [];
    if (!calls.length) {
      if (trace === 'callee') unexpanded.add(`${at}, from ${file}: ${parameter}, a parameter of a function the walk sees no call of`);
      else { unexpanded.add(`${at}, from ${file}: ${parameter}`); escaped.add(owner); }
    }
    for (const { file: caller, call } of calls) argument(caller, call, owner, position, path, at, file, trace);
    membered.push({ holder, owner, at, file, parameter });
  };
  // Each call of a function a value gives, and each such function given to code outside the source, runs what the value holds.
  for (const { file, site, value, path, what } of callees) { traced.add(site); codesOf(file, value, path, `${file}: ${brief(site)}, ${what}`, 'callee'); }
  for (let next = passed.pop(); next; next = passed.pop()) {
    const { file, owner, position, path, at, trace } = next;
    // Sought, its calls are checked even where the walk found none.
    if (!argumentsRead.has(owner)) argumentsRead.set(owner, new Set());
    if (ts.isConstructorDeclaration(owner)) { constructed(file, owner.parent, owner, position, path, at, trace); continue; }
    const named = functionName(owner), parameter = brief(owner.parameters[position].name), holder = named ? undefined : holderOf(owner);
    const list = iteratedBy(outermost(owner as ts.Expression));
    if (!named && list) { iterated(file, list, position, path, at, trace); continue; }
    if (holder) { memberArguments(holder, owner, position, path, at, file, trace, parameter); continue; }
    const maker = !named && trace === 'callee' ? returnedBy(owner) : undefined;
    if (maker) { made(file, maker, owner, position, path, at, parameter); continue; }
    if (!named) {
      if (trace === 'callee' && given(file, owner, position, path, at)) continue;
      unexpanded.add(`${at}, from ${file}: ${parameter}`); escaped.add(owner); continue;
    }
    const calls = uses(file, named);
    // A function called nowhere the walk reaches, a root's own included, is given its functions by code the walk does not see.
    if (trace === 'callee' && !calls.length) unexpanded.add(`${at}, from ${file}: ${parameter}, a parameter of a function the walk sees no call of`);
    for (const { file: caller, site, outer } of calls) {
      const call = outer.parent;
      const list = iteratedBy(outer);
      if ((ts.isCallExpression(call) || ts.isNewExpression(call)) && call.expression === outer) argument(caller, call, owner, position, path, at, file, trace);
      else if (list) iterated(caller, list, position, path, at, trace);
      // Held by a property, a function takes its parameters from the property's walked calls.
      else if ((ts.isPropertyAssignment(call) || ts.isPropertyDeclaration(call)) && call.initializer === outer || ts.isShorthandPropertyAssignment(call) && call.name === outer)
        memberArguments(call, owner, position, path, at, file, trace, parameter);
      else { unexpanded.add(`${caller}: ${site.getText()} passed on`); escaped.add(owner); }
    }
  }
  // A member whose function went where the walk cannot see its arguments gives its parameters values the walk did not read.
  for (const { holder, owner, at, file, parameter } of membered) if (memberGiven.has(holder)) {
    unexpanded.add(`${at}, from ${file}: ${parameter}, a parameter of a function its member gives on`);
    escaped.add(owner);
  }
  expansion: for (const { file, value } of templated) {
    let variants = [value.head.text];
    for (const span of value.templateSpans) {
      const key = `${file}: ${span.expression.getText()}`, given = templates[key];
      if (!given) { unexpanded.add(key); continue expansion; }
      const options = typeof given === 'function' ? given(declarations) : given;
      variants = variants.flatMap(prefix => options.map(option => prefix + option + span.literal.text));
    }
    for (const variant of variants) codes.add(variant);
  }
  return { codes, unexpanded: [...unexpanded].sort(), taken: [...taken].sort(), declarations, accesses, factoryReads, entries, raises, untold, argumentsRead, escaped, unresolved, stopped, traced };
}

/** Whether `node` is the class a class extends, as its `extends` clause writes it, which is a value. */
export function isExtended(node: ts.Node): node is ts.ExpressionWithTypeArguments {
  return ts.isExpressionWithTypeArguments(node) && ts.isHeritageClause(node.parent) && node.parent.token === ts.SyntaxKind.ExtendsKeyword && ts.isClassLike(node.parent.parent);
}
/** Whether `node` is only a type, a type parameter or an import, none of which runs. */
export function isTypeOnly(node: ts.Node): boolean {
  return ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isImportDeclaration(node) || ts.isTypeParameterDeclaration(node);
}

/** Whether `node` is read only for a member: the receiver of a member read. */
function isReceiver(node: ts.Expression): boolean {
  const parent = node.parent;
  return (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node;
}

/**
 * How a member read is used: `called` directly, through parentheses or a non-null assertion, or through `call` or `apply`; `passed` to a
 * call, to `bind`, to a constant or to the caller as a function's result, which may call it; `write` as the target of `=`; `update` as the target of another assignment or of
 * `++` or `--`, which reads it too; `tested` for presence, as a condition, the operand of `!` or `typeof`, a side of a comparison or
 * the left side of `&&`, none of which gives the function on; or `other`.
 */
export function methodUse(access: ts.Expression): 'called' | 'passed' | 'write' | 'update' | 'tested' | 'other' {
  let outer: ts.Expression = access;
  while (ts.isParenthesizedExpression(outer.parent) || ts.isNonNullExpression(outer.parent) || ts.isAsExpression(outer.parent) || ts.isSatisfiesExpression(outer.parent)) outer = outer.parent;
  const parent = outer.parent;
  // An operand that gives the expression its value, as either side of `||` or `??`, the right side of `&&` or a branch of a conditional,
  // is used as that expression is.
  if (ts.isBinaryExpression(parent) && (parent.operatorToken.kind === ts.SyntaxKind.BarBarToken || parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    || parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && parent.right === outer)
    || ts.isConditionalExpression(parent) && parent.condition !== outer) return methodUse(parent);
  if (ts.isCallExpression(parent) && parent.expression === outer) return 'called';
  if (ts.isPropertyAccessExpression(parent) && parent.expression === outer && (parent.name.text === 'call' || parent.name.text === 'apply')
    && ts.isCallExpression(parent.parent) && parent.parent.expression === parent) return 'called';
  if (ts.isPropertyAccessExpression(parent) && parent.expression === outer && parent.name.text === 'bind' && ts.isCallExpression(parent.parent) && parent.parent.expression === parent) return 'passed';
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.arguments?.includes(outer)) return 'passed';
  if (ts.isReturnStatement(parent) && parent.expression === outer || ts.isArrowFunction(parent) && parent.body === outer) return 'passed';
  if (ts.isVariableDeclaration(parent) && parent.initializer === outer && ts.isIdentifier(parent.name) && (ts.getCombinedNodeFlags(parent) & ts.NodeFlags.Const) !== 0) return 'passed';
  if (ts.isBinaryExpression(parent) && parent.left === outer && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
    return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken ? 'write' : 'update';
  if ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)) return 'update';
  if ((ts.isConditionalExpression(parent) || ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) && (ts.isConditionalExpression(parent) ? parent.condition : parent.expression) === outer
    || ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken || ts.isTypeOfExpression(parent)
    || ts.isBinaryExpression(parent) && ([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(parent.operatorToken.kind)
      || parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && parent.left === outer)) return 'tested';
  return 'other';
}

/** The names of the `CadError` factories. */
const FACTORIES: ReadonlySet<string> = new Set(['checked', 'received']);
/** Whether declaration `node` is the `CadError` class. */
function isCadErrorClass(node: ts.Node): boolean { return ts.isClassDeclaration(node) && node.name?.text === 'CadError'; }
/** Whether declaration `node` is `CadError.checked` or `CadError.received`, whose callers give the code they raise as their first argument. */
export function isCadErrorFactory(node: ts.Node): boolean {
  return ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && FACTORIES.has(node.name.text)
    && node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword) === true && isCadErrorClass(node.parent);
}

/**
 * The declaration a function is used by: a function declaration, named or a module's default export, or the variable or default export
 * that holds the function.
 */
function functionName(owner: ts.FunctionLikeDeclaration): ts.Node | undefined {
  if (ts.isFunctionDeclaration(owner)) return owner.name || hasModifier(owner, ts.SyntaxKind.DefaultKeyword) ? owner : undefined;
  const holder = owner.parent;
  if (!ts.isArrowFunction(owner) && !ts.isFunctionExpression(owner)) return undefined;
  if (ts.isVariableDeclaration(holder) && holder.initializer === owner && ts.isIdentifier(holder.name)) return holder;
  return ts.isExportAssignment(holder) && !holder.isExportEquals && holder.expression === owner ? holder : undefined;
}

/**
 * Whether the identifier uses a value, rather than naming a declaration, a member, a property, a destructured or JSX attribute's key, an
 * import or export, a label or a meta-property.
 */
export function isReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if ((ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)
    || ts.isPropertySignature(parent) || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent) || ts.isEnumMember(parent)
    || ts.isMetaProperty(parent) || ts.isJsxAttribute(parent)) && parent.name === node) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === node || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isJsxNamespacedName(parent)) return false;
  if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return (parent as { label?: ts.Node }).label !== node;
  return !((ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)
    || ts.isFunctionExpression(parent) || ts.isClassExpression(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isNamespaceExport(parent)
    || ts.isEnumDeclaration(parent) || ts.isModuleDeclaration(parent) || ts.isTypeParameterDeclaration(parent)) && (parent as { name?: ts.Node }).name === node);
}

