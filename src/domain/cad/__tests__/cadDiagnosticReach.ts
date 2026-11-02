import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// TypeScript 7 ships no compiler API yet; AST tooling uses the TypeScript 6 package.
import ts from '@typescript/typescript6';

/**
 * The `CadError` codes code can raise, found without running it. From each root it follows, through the source of `src`, every name a
 * walked function uses: the nearest declaration in scope, an import to the declaration it names, members of constant objects and
 * namespace imports, `this` members, and a method called on another receiver, through the declarations TypeScript gives that member of
 * the receiver's type, and the members that override it in classes extending its class. A member only an interface, a type or an
 * abstract class declares runs the members of that name of the source's object literals and classes whose type fits the receiver's. A
 * member declared outside the source, by the platform or a library, holds no code. A used class runs its constructor and field
 * initializers; its methods are walked only when called. An overload signature stands for its implementation.
 *
 * It collects the first argument of each `CadError` and the `code` of each object literal, written plainly, quoted or as a computed
 * literal key, which carries a refusal to the `CadError` an inspection raises. A code is read through:
 * - each branch of a conditional and each side of `??`, `||` and `&&`;
 * - constants, properties of object literals (from the last: a spread or a computed key it cannot tell may hold one, and an absent one
 *   holds none) and elements of list literals, by a literal key or, for a key it cannot tell, through every element and property;
 * - `for…of` variables, the first parameter of a list iteration's callback, and names destructured from a constant, a `for…of` list or
 *   a parameter, with any default;
 * - a parameter, at each call of its function the walk reaches;
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
}
export interface CadDiagnosticRoot { readonly file: string; readonly node: ts.Node }
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
interface CadReference { readonly file: string; readonly identifier: ts.Identifier }
interface Member { readonly file: string; readonly node: ts.Node }
/** A member a call runs, with the type that declares the member called on the receiver, as `file:name`. */
interface CalledMember extends Member { readonly through: string | undefined }

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

/** The application's compiler options, from its TypeScript configuration, without output. */
function programOptions(): ts.CompilerOptions {
  const configuration = ts.getParsedCommandLineOfConfigFile(path.join(root, 'tsconfig.app.json'), {}, {
    ...ts.sys, onUnRecoverableConfigFileDiagnostic: diagnostic => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')); }
  });
  if (!configuration) throw new Error('The application has no TypeScript configuration.');
  return { ...configuration.options, noEmit: true };
}
/** The name of the interface, type alias or class that declares a member. */
function ownerName(declaration: ts.Declaration): string | undefined {
  const owner = ts.isTypeLiteralNode(declaration.parent) && ts.isTypeAliasDeclaration(declaration.parent.parent) ? declaration.parent.parent : declaration.parent;
  return (ts.isInterfaceDeclaration(owner) || ts.isTypeAliasDeclaration(owner) || ts.isClassLike(owner)) && owner.name ? owner.name.text : undefined;
}
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
/** What `identifier` names in its own file: its declaration, a {@link Binding}, or undefined for a name declared elsewhere. */
function binding(identifier: ts.Identifier): ts.Node | Binding | undefined {
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
  private readonly members = new Map<string, Member[]>();
  private readonly indexed = new Set<ts.Node>();
  /** Gives a member called on another receiver the declarations of the receiver's type. */
  private readonly checker: ts.TypeChecker;
  /** The indexed path of each program source file that is the source's. */
  private readonly paths = new Map<ts.SourceFile, string>();
  private readonly calls = new Map<ts.PropertyAccessExpression, readonly CalledMember[] | undefined>();

  private readonly referenceCache = new Map<ts.Node, readonly CadReference[]>();

  /**
   * Indexes the source of `src`, or `sources`, text by path, for a test of the walk itself. The files are those of one TypeScript program
   * with the application's compiler options, so each receiver has a type.
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
      host.getSourceFile = (name, version, ...rest) => {
        const found = text(name);
        return found === undefined ? getSourceFile.call(host, name, version, ...rest) : ts.createSourceFile(name, found, version, true);
      };
    }
    const program = ts.createProgram({ rootNames: files.map(absolute), options, host });
    this.checker = program.getTypeChecker();
    for (const file of files) {
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
    const imports = new Map<string, Import>(), exports = new Map<string, Import>(), stars: string[] = [];
    const member = (name: string, node: ts.Node) => {
      if (this.indexed.has(node)) return;
      this.indexed.add(node);
      const list = this.members.get(name), entry = { file, node };
      if (list) list.push(entry); else this.members.set(name, [entry]);
    };
    const exported = (node: ts.Node) => ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
    for (const statement of source.statements) {
      if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name && exported(statement))
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
        else if (ts.isNamedExports(statement.exportClause)) for (const element of statement.exportClause.elements)
          exports.set(element.name.text, { module, name: (element.propertyName ?? element.name).text });
      }
      if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) exports.set('default', { module: file, name: statement.expression.text });
    }
    // Every class's and object literal's members, which may implement a member an interface or type declares.
    const visit = (node: ts.Node) => {
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) for (const element of node.members) {
        const name = propertyName(element.name);
        if (name && (ts.isMethodDeclaration(element) || ts.isGetAccessorDeclaration(element) || ts.isPropertyDeclaration(element))) member(name, element);
      }
      if (ts.isObjectLiteralExpression(node)) for (const property of node.properties) {
        const name = propertyName(property.name);
        if (name && (ts.isMethodDeclaration(property) || ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)
          || ts.isGetAccessorDeclaration(property))) member(name, property);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    this.imports.set(file, imports); this.exports.set(file, exports); this.starExports.set(file, stars);
  }

  /** The declarations `identifier` names: the nearest in scope, or what an import of it names. */
  resolve(file: string, identifier: ts.Identifier): readonly CadDiagnosticRoot[] {
    const local = lexical(identifier);
    if (local === 'parameter') return [];
    if (local) return [{ file, node: local }];
    const imported = this.imports.get(file)?.get(identifier.text);
    return imported && imported.name !== '*' ? this.exported(imported.module, imported.name, new Set()) : [];
  }
  /** The namespace module `name` imports in `file`, if it is one. */
  namespace(file: string, name: string): string | undefined {
    const imported = this.imports.get(file)?.get(name);
    return imported?.name === '*' ? imported.module : undefined;
  }
  exported(module: string, name: string, seen: Set<string>): readonly CadDiagnosticRoot[] {
    if (seen.has(module)) return [];
    seen.add(module);
    const entry = this.exports.get(module)?.get(name);
    if (entry) {
      if (entry.module !== module) return this.exported(entry.module, entry.name, new Set());
      const source = this.files.get(module)!;
      for (const statement of source.statements) {
        if (ts.isFunctionDeclaration(statement) && !statement.body) continue;
        if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === entry.name) return [{ file: module, node: statement }];
        if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations)
          if (ts.isIdentifier(declaration.name) && declaration.name.text === entry.name) return [{ file: module, node: declaration }];
      }
      return [];
    }
    for (const star of this.starExports.get(module) ?? []) {
      const found = this.exported(star, name, seen);
      if (found.length) return found;
    }
    return [];
  }
  /** Methods and properties of classes and object literals named `name`. */
  membersNamed(name: string): readonly Member[] { return this.members.get(name) ?? []; }
  /**
   * What calling `access` runs, from the declarations TypeScript gives its member on the receiver's type: each of the source's with a
   * body or value and the members of classes that extend its class; for one an interface, a type or an abstract class of the source
   * declares, the members of that name of the source's object literals and classes whose type fits the receiver's. A declaration outside
   * the source, the platform's or a library's, runs nothing of the source, and nor does a signature no object or class of the source fits.
   * Undefined when the type gives no declaration at all, as for a receiver of type `any`.
   */
  calledMembers(access: ts.PropertyAccessExpression): readonly CalledMember[] | undefined {
    const cached = this.calls.get(access);
    if (cached || this.calls.has(access)) return cached;
    const name = access.name.text, declarations = this.checker.getSymbolAtLocation(access.name)?.declarations ?? [];
    let found: CalledMember[] | undefined;
    if (declarations.length) {
      const receiver = this.checker.getApparentType(this.checker.getNonNullableType(this.checker.getTypeAtLocation(access.expression)));
      const members = new Map<ts.Node, CalledMember>(), candidates = this.membersNamed(name);
      for (const declaration of declarations) {
        const file = this.paths.get(declaration.getSourceFile());
        if (file === undefined) continue;
        const owner = ownerName(declaration), through = owner && `${file}:${owner}`;
        if (!isSignature(declaration)) members.set(declaration, { file, node: declaration, through });
        // A class that extends the declaring one may override the member; any object or class whose type fits the receiver's may implement a signature.
        for (const candidate of candidates) if (candidate.node !== declaration && !members.has(candidate.node)
          && (this.inherits(candidate.node, name, declaration) || isSignature(declaration) && this.fits(candidate.node, receiver))) members.set(candidate.node, { ...candidate, through });
      }
      found = [...members.values()];
    }
    this.calls.set(access, found);
    return found;
  }
  /** Whether `member`'s class implements or extends a type whose member `name` is `declaration`. */
  private inherits(member: ts.Node, name: string, declaration: ts.Declaration): boolean {
    const owner = member.parent;
    return ts.isClassLike(owner) && !!owner.heritageClauses?.some(clause => clause.types.some(type =>
      this.propertyDeclarations(this.checker.getTypeAtLocation(type), name).includes(declaration)));
  }
  /** Whether the object literal or class instance that has `member` can be a value of `receiver`'s type. */
  private fits(member: ts.Node, receiver: ts.Type): boolean {
    const owner = member.parent;
    return (ts.isObjectLiteralExpression(owner) || ts.isClassLike(owner)) && this.checker.isTypeAssignableTo(this.checker.getTypeAtLocation(owner), receiver);
  }
  /** The declarations of property `name` of `type`, through each member of a union or intersection. */
  private propertyDeclarations(type: ts.Type, name: string): readonly ts.Declaration[] {
    if (type.isUnionOrIntersection()) return type.types.flatMap(part => this.propertyDeclarations(part, name));
    return this.checker.getPropertyOfType(this.checker.getApparentType(type), name)?.declarations ?? [];
  }
  /** Every use of `name` in the source that resolves to `declaration`. */
  references(declaration: CadDiagnosticRoot, name: string): readonly CadReference[] {
    const cached = this.referenceCache.get(declaration.node);
    if (cached) return cached;
    const found: CadReference[] = [];
    for (const [file, source] of this.files) {
      if (!source.text.includes(name)) continue;
      const visit = (node: ts.Node) => {
        if (ts.isIdentifier(node) && node.text === name && isReference(node) && this.resolve(file, node).some(target => target.node === declaration.node)) found.push({ file, identifier: node });
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    this.referenceCache.set(declaration.node, found);
    return found;
  }
}

export function cadDiagnosticReach(index: CadSourceIndex, roots: readonly CadDiagnosticRoot[], options: CadDiagnosticReachOptions = {}): CadDiagnosticReach {
  const { templates = {}, stop = new Set<string>(), receivers } = options;
  const codes = new Set<string>(), unexpanded = new Set<string>(), taken = new Set<string>(), walked = new Set<ts.Node>(), declarations = new Set<string>();
  const templated: { readonly file: string; readonly value: ts.TemplateExpression }[] = [];
  const queue: CadDiagnosticRoot[] = [...roots];
  const push = ({ file, node }: CadDiagnosticRoot) => {
    const name = (node as { name?: ts.Node }).name;
    if (name && ts.isIdentifier(name) && stop.has(`${file}:${name.text}`)) return;
    const named = name && propertyName(name as ts.PropertyName);
    if (named) declarations.add(`${file}:${named}`);
    // A variable's initializer and a class's constructor and field initializers are what using them runs.
    if (ts.isVariableDeclaration(node)) { if (node.initializer) queue.push({ file, node: node.initializer }); }
    else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      for (const element of node.members) if (ts.isConstructorDeclaration(element) || ts.isPropertyDeclaration(element) && element.initializer) queue.push({ file, node: element });
    } else queue.push({ file, node });
  };
  /** Parameters that carry a code, read at the function's walked calls once the walk is complete. */
  const passed: { readonly file: string; readonly owner: ts.FunctionLikeDeclaration; readonly position: number; readonly path: readonly string[]; readonly at: string }[] = [];
  const read = new Set<string>();
  const isConstant = (declaration: ts.VariableDeclaration) => (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0;
  /** The string a key names: a literal, or a constant of the source initialized to one. */
  const keyText = (file: string, key: ts.Expression): string | undefined => {
    const value = bareExpression(key);
    if (ts.isStringLiteralLike(value)) return value.text;
    if (!ts.isIdentifier(value)) return undefined;
    const [found] = index.resolve(file, value);
    const initializer = found && ts.isVariableDeclaration(found.node) && isConstant(found.node) && found.node.initializer && bareExpression(found.node.initializer);
    return initializer && ts.isStringLiteralLike(initializer) ? initializer.text : undefined;
  };
  /** Collects the codes `expression` gives once `path` is read off it; `at` is the site reported if it cannot. */
  const codesOf = (file: string, expression: ts.Expression, path: readonly string[] = [], at = `${file}: ${expression.getText()}`): void => {
    const value = bareExpression(expression), key = `${file}:${value.pos}:${value.end}:${path.join('.')}`;
    if (read.has(key)) return;
    read.add(key);
    // Where the reading is, shown after the site when it went elsewhere; a call's arguments are left out.
    const here = (text = expression.getText()) => `${file}: ${text}${path.map(name => name === ELEMENT ? ELEMENT : name === CALL ? '(…)' : `.${name}`).join('')}`;
    const unread = () => { const reached = here(); unexpanded.add(reached === at ? at : `${at}, from ${reached}`); };
    /** What `rest` reads off a function of `owned`: each result of a call, read on. A function holds no code of its own. */
    const called = (owned: string, owner: ts.FunctionLikeDeclaration, rest: readonly string[]) => {
      if (rest[0] === CALL) for (const result of returnsOf(owner)) codesOf(owned, result, rest.slice(1), at);
    };
    /** What a declaration of the source gives: a constant's value, or a function's results. */
    const declared = ({ file: owned, node }: CadDiagnosticRoot, rest: readonly string[]) => {
      if (ts.isVariableDeclaration(node) && node.initializer && isConstant(node)) codesOf(owned, node.initializer, rest, at);
      else if (isFunctionLike(node)) called(owned, node, rest);
      else unread();
    };
    if (path.length > DEPTH) { unread(); return; }
    if (ts.isConditionalExpression(value)) { codesOf(file, value.whenTrue, path, at); codesOf(file, value.whenFalse, path, at); return; }
    if (ts.isBinaryExpression(value) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(value.operatorToken.kind)) {
      codesOf(file, value.left, path, at); codesOf(file, value.right, path, at);
      return;
    }
    if (value.kind === ts.SyntaxKind.NullKeyword || ts.isIdentifier(value) && value.text === 'undefined') return;
    if (ts.isStringLiteralLike(value) || ts.isTemplateExpression(value)) {
      if (!path.length && ts.isStringLiteralLike(value)) codes.add(value.text);
      // Expanded once the walk is complete, when every declaration a substitution's values may depend on is known.
      else if (!path.length && ts.isTemplateExpression(value)) templated.push({ file, value });
      // A string's members hold no code, but what its methods return is built at run time.
      else if (path.includes(CALL)) unread();
      return;
    }
    if (ts.isPropertyAccessExpression(value)) { codesOf(file, value.expression, [value.name.text, ...path], at); return; }
    if (ts.isElementAccessExpression(value)) {
      // A numeric index reads any element; a key the walk cannot tell reads any element or property.
      codesOf(file, value.expression, [keyText(file, value.argumentExpression) ?? ELEMENT, ...path], at);
      return;
    }
    if (ts.isCallExpression(value)) { codesOf(file, value.expression, [CALL, ...path], at); return; }
    if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) { called(file, value, path); return; }
    if (ts.isArrayLiteralExpression(value) && path[0] === ELEMENT) {
      for (const element of value.elements) if (!ts.isOmittedExpression(element))
        codesOf(file, ts.isSpreadElement(element) ? element.expression : element, ts.isSpreadElement(element) ? path : path.slice(1), at);
      return;
    }
    if (ts.isObjectLiteralExpression(value) && path.length) {
      // From the last property: one of that name replaces those before it, and a spread or a computed key may hold it. An absent property
      // holds no code.
      const [name, ...rest] = path;
      for (const property of [...value.properties].reverse()) {
        if (ts.isSpreadAssignment(property)) { codesOf(file, property.expression, path, at); continue; }
        const key = propertyName(property.name), named = name === ELEMENT || key === name;
        if (!named && !(key === undefined && property.name && ts.isComputedPropertyName(property.name))) continue;
        if (ts.isPropertyAssignment(property)) codesOf(file, property.initializer, rest, at);
        else if (ts.isShorthandPropertyAssignment(property)) codesOf(file, property.name, rest, at);
        else if (ts.isMethodDeclaration(property)) called(file, property, rest);
        else unread();
        if (named && name !== ELEMENT) return;
      }
      return;
    }
    if (ts.isIdentifier(value)) {
      const bound = binding(value);
      if (bound && isBinding(bound)) {
        if (bound.kind === 'parameter') passed.push({ file, owner: bound.owner, position: bound.position, path, at });
        else if (bound.kind === 'element') codesOf(file, bound.of, [ELEMENT, ...path], at);
        // A caught error's code was collected at the `CadError` that raised it, in the walked `try` block.
        else if (bound.kind === 'caught' && path.length === 1 && path[0] === 'code') taken.add(here());
        else if (bound.kind === 'variable' && bound.element) destructured(file, bound.element, path, at, unread);
        else unread();
        return;
      }
      const namespace = index.namespace(file, value.text);
      if (namespace) {
        const found = path[0] === ELEMENT || path[0] === CALL || !path.length ? [] : index.exported(namespace, path[0], new Set());
        if (found.length) found.forEach(declaration => declared(declaration, path.slice(1))); else unread();
        return;
      }
      const found = index.resolve(file, value);
      if (found.length) found.forEach(declaration => declared(declaration, path)); else unread();
      return;
    }
    unread();
  };
  /**
   * What a destructured name gives: the path its pattern reads off the value destructured, a `const` declaration's initializer, each
   * element of a `for…of` list or a parameter, and any default along the way.
   */
  const destructured = (file: string, element: ts.BindingElement, path: readonly string[], at: string, unread: () => void) => {
    let node: ts.Node = element, below = path;
    while (ts.isBindingElement(node)) {
      if (node.initializer) codesOf(file, node.initializer, below, at);
      const pattern: ts.BindingPattern = node.parent;
      // A rest element holds the remaining elements or properties, read by the same path.
      if (!node.dotDotDotToken) {
        const key = ts.isArrayBindingPattern(pattern) ? ELEMENT : propertyName(node.propertyName ?? node.name);
        if (key === undefined) { unread(); return; }
        below = [key, ...below];
      }
      node = pattern.parent;
    }
    if (ts.isParameter(node) && isFunctionLike(node.parent)) passed.push({ file, owner: node.parent, position: node.parent.parameters.indexOf(node), path: below, at });
    else if (ts.isVariableDeclaration(node) && ts.isForOfStatement(node.parent.parent) && isConstant(node)) codesOf(file, node.parent.parent.expression, [ELEMENT, ...below], at);
    else if (ts.isVariableDeclaration(node) && node.initializer && isConstant(node)) codesOf(file, node.initializer, below, at);
    else unread();
  };
  const member = (file: string, access: ts.PropertyAccessExpression) => {
    const name = access.name.text, receiver = bareExpression(access.expression);
    if (ts.isIdentifier(receiver)) {
      const namespace = index.namespace(file, receiver.text);
      if (namespace) { index.exported(namespace, name, new Set()).forEach(push); return; }
      const declared = index.resolve(file, receiver);
      const objects = declared.flatMap(found => {
        const value = ts.isVariableDeclaration(found.node) && found.node.initializer && bareExpression(found.node.initializer);
        return value && ts.isObjectLiteralExpression(value) ? [{ file: found.file, value }] : [];
      });
      if (lexical(receiver) === 'parameter') {
        const stands = receivers?.(file, receiver.text);
        if (stands && ts.isObjectLiteralExpression(stands.node)) objects.push({ file: stands.file, value: stands.node });
      }
      if (objects.length) {
        for (const { file: owner, value } of objects) for (const property of value.properties) if (propertyName(property.name) === name) push({ file: owner, node: property });
        return;
      }
    }
    if (receiver.kind === ts.SyntaxKind.ThisKeyword) {
      const owner = ts.findAncestor(access, node => ts.isClassLike(node)) as ts.ClassLikeDeclaration | undefined;
      for (const element of owner?.members ?? []) if (propertyName(element.name) === name) push({ file, node: element });
      return;
    }
    if (!(ts.isCallExpression(access.parent) && access.parent.expression === access)) return;
    // The receiver's type says which members a call runs; when it cannot, any of the source's of that name might.
    const called = index.calledMembers(access);
    if (called) for (const found of called) { if (!found.through || !stop.has(found.through)) push(found); }
    else if (index.membersNamed(name).length) unexpanded.add(`${file}: ${access.getText()}, a method its receiver's type does not declare`);
  };
  while (queue.length) {
    const { file, node } = queue.pop()!;
    if (walked.has(node)) continue;
    walked.add(node);
    const visit = (child: ts.Node) => {
      if (ts.isTypeNode(child) || ts.isInterfaceDeclaration(child) || ts.isTypeAliasDeclaration(child) || ts.isImportDeclaration(child)) return;
      if ((ts.isNewExpression(child) || ts.isCallExpression(child)) && ts.isIdentifier(child.expression) && child.expression.text === 'CadError' && child.arguments?.[0]) codesOf(file, child.arguments[0]);
      else if (ts.isPropertyAssignment(child) && propertyName(child.name) === 'code') codesOf(file, child.initializer);
      else if (ts.isShorthandPropertyAssignment(child) && child.name.text === 'code') codesOf(file, child.name);
      if (ts.isIdentifier(child) && isReference(child)) index.resolve(file, child).forEach(push);
      if (ts.isPropertyAccessExpression(child)) member(file, child);
      ts.forEachChild(child, visit);
    };
    if (isFunctionLike(node)) { if (node.body) visit(node.body); for (const parameter of node.parameters) if (parameter.initializer) visit(parameter.initializer); }
    else if (ts.isPropertyDeclaration(node)) { if (node.initializer) visit(node.initializer); }
    else if (ts.isPropertyAssignment(node)) visit(node.initializer);
    else visit(node);
  }
  // A parameter gives what each walked call passes it; a function passed on as a value has callers the walk cannot see.
  const inWalk = (node: ts.Node) => ts.findAncestor(node, ancestor => walked.has(ancestor)) !== undefined;
  for (let next = passed.pop(); next; next = passed.pop()) {
    const { file, owner, position, path, at } = next, named = functionName(owner);
    if (!named) { unexpanded.add(`${at}, from ${file}: ${owner.parameters[position].name.getText()}`); continue; }
    for (const { file: caller, identifier } of index.references({ file, node: named.declaration }, named.name)) {
      if (!inWalk(identifier)) continue;
      const call = identifier.parent;
      if (!((ts.isCallExpression(call) || ts.isNewExpression(call)) && call.expression === identifier)) { unexpanded.add(`${caller}: ${identifier.text} passed on`); continue; }
      const given = call.arguments ?? [], fallback = owner.parameters[position].initializer;
      if (given.slice(0, position + 1).some(ts.isSpreadElement)) unexpanded.add(`${caller}: ${call.getText()}`);
      else if (given[position]) codesOf(caller, given[position], path, at);
      else if (fallback) codesOf(file, fallback, path, at);
      else unexpanded.add(`${caller}: ${call.getText()}`);
    }
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
  return { codes, unexpanded: [...unexpanded].sort(), taken: [...taken].sort(), declarations };
}

/** The name a function is called by and the declaration it resolves to: a function declaration, or a variable holding the function. */
function functionName(owner: ts.FunctionLikeDeclaration): { readonly name: string; readonly declaration: ts.Node } | undefined {
  if (ts.isFunctionDeclaration(owner) && owner.name) return { name: owner.name.text, declaration: owner };
  const holder = owner.parent;
  if ((ts.isArrowFunction(owner) || ts.isFunctionExpression(owner)) && ts.isVariableDeclaration(holder) && holder.initializer === owner && ts.isIdentifier(holder.name))
    return { name: holder.name.text, declaration: holder };
  return undefined;
}

/** Whether the identifier uses a value, rather than naming a declaration, a member or a property. */
function isReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if ((ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)
    || ts.isPropertySignature(parent) || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent) || ts.isEnumMember(parent)) && parent.name === node) return false;
  return !((ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)
    || ts.isFunctionExpression(parent) || ts.isClassExpression(parent) || ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)
    || ts.isExportSpecifier(parent) || ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) && (parent as { name?: ts.Node; label?: ts.Node }).name === node);
}
