// TypeScript 7 ships no compiler API yet; AST tooling uses the TypeScript 6 package.
import ts from '@typescript/typescript6';
import {
  bareExpression, calleeOf, isCadErrorFactory, isExtended, isReference, isTypeOnly, methodUse, type CadDiagnosticReach, type CadMemberRead, type CadSourceIndex
} from './cadDiagnosticReach';

/**
 * Visits the code a walk entered, found apart from the walk: each entered node's code but its types and imports, and for an object read
 * only for its members, not its methods and accessors nor those of the objects its properties hold, which run only as member reads run
 * them. The class a class extends is code.
 */
function visitEntered(reach: CadDiagnosticReach, found: (file: string, child: ts.Node) => void): void {
  for (const { file, node, held } of reach.entries) {
    const heldObjects = new Set<ts.Node>(held ? [held] : []);
    const visit = (child: ts.Node): void => {
      if (isExtended(child)) { visit(child.expression); return; }
      if (isTypeOnly(child)) return;
      found(file, child);
      if (heldObjects.has(child)) {
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
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
      || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      if (node.body) visit(node.body);
      for (const parameter of node.parameters) { if (parameter.initializer) visit(parameter.initializer); if (!ts.isIdentifier(parameter.name)) visit(parameter.name); }
    } else if (ts.isPropertyDeclaration(node)) { if (node.initializer) visit(node.initializer); }
    else if (ts.isPropertyAssignment(node)) visit(node.initializer);
    else visit(node);
  }
}

/**
 * Every member read, by name or by element, in the code a walk entered (`visitEntered`). The walk follows or reports each one; one it
 * leaves without an outcome it skipped silently.
 */
export function cadMemberReads(reach: CadDiagnosticReach): readonly { readonly file: string; readonly read: CadMemberRead }[] {
  const found = new Map<CadMemberRead, string>();
  visitEntered(reach, (file, child) => { if (ts.isPropertyAccessExpression(child) || ts.isElementAccessExpression(child)) found.set(child, file); });
  return [...found].map(([read, file]) => ({ file, read }));
}

/** Every call, `new` and `super(…)` call in the code a walk entered (`visitEntered`). */
export function cadCalls(reach: CadDiagnosticReach): readonly { readonly file: string; readonly call: ts.CallExpression | ts.NewExpression }[] {
  const found = new Map<ts.CallExpression | ts.NewExpression, string>();
  visitEntered(reach, (file, child) => { if (ts.isCallExpression(child) || ts.isNewExpression(child)) found.set(child, file); });
  return [...found].map(([call, file]) => ({ file, call }));
}

/** Whether declaration `node`, which holds code, runs when read with `use`: a getter on a read, a setter on a write, a function when called or given on. */
function runsWhen(node: ts.Node, use: ReturnType<typeof methodUse>): boolean {
  if (ts.isGetAccessorDeclaration(node)) return use !== 'write';
  if (ts.isSetAccessorDeclaration(node)) return use === 'write' || use === 'update';
  return use === 'called' || use === 'passed' || use === 'other';
}

/** A node's text on one line, shortened, for a report. */
const shortly = (node: ts.Node) => { const text = node.getText().replace(/\s+/g, ' '); return text.length > 80 ? `${text.slice(0, 79)}…` : text; };
/** A declaration's name, or its text on one line, shortened, where it is, for a report. */
const declared = (index: CadSourceIndex, node: ts.Node) => {
  const name = ts.getNameOfDeclaration(node as ts.Declaration);
  return `${index.where(node)}: ${name && !ts.isComputedPropertyName(name) ? name.getText() : shortly(node)}`;
};

/**
 * The nodes that show the code using declaration `node` runs was entered: a function's own node, with a body; a variable's or a default
 * export's value, or that of the declaration a name is destructured from; a class's constructor, field values, static blocks and the
 * class it extends; a property's value. None for one that holds no code: a signature, an overload, a variable declared without a value,
 * a parameter, an enum member. Any other declaration, such as a TypeScript namespace or a module, stands for itself, which no walk
 * enters, so it is never taken as entered.
 */
function codeOf(node: ts.Node): readonly ts.Node[] {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) return node.body ? [node] : [];
  if (ts.isVariableDeclaration(node)) return node.initializer ? [node.initializer] : [];
  if (ts.isExportAssignment(node)) return [node.expression];
  if (ts.isBindingElement(node)) {
    let root: ts.Node = node;
    while (ts.isBindingElement(root) || ts.isObjectBindingPattern(root) || ts.isArrayBindingPattern(root)) root = root.parent;
    return ts.isVariableDeclaration(root) && root.initializer ? [root.initializer] : [];
  }
  if (ts.isClassLike(node)) {
    const base = node.heritageClauses?.find(clause => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
    return [...node.members.flatMap((member): readonly ts.Node[] => ts.isConstructorDeclaration(member) ? member.body ? [member] : []
      : ts.isPropertyDeclaration(member) ? member.initializer ? [member.initializer] : [] : ts.isClassStaticBlockDeclaration(member) ? [member] : []), ...base ? [base] : []];
  }
  if (ts.isPropertyAssignment(node)) return [node.initializer];
  if (ts.isPropertyDeclaration(node)) return node.initializer ? [node.initializer] : [];
  if (ts.isParameter(node) || ts.isEnumMember(node) || ts.isPropertySignature(node) || ts.isMethodSignature(node) || ts.isTypeParameterDeclaration(node)) return [];
  return [node];
}
/** Whether a declaration is one a name declares, rather than a member of an object, a class or a type. */
function isNameLevel(node: ts.Node): boolean {
  return ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isVariableDeclaration(node) || ts.isEnumDeclaration(node) || ts.isExportAssignment(node)
    || ts.isBindingElement(node) || ts.isModuleDeclaration(node) || ts.isSourceFile(node);
}
/** Whether member declaration `node` holds code of its own: a getter, setter or method with a body, or a property whose value is a function. */
function holdsCode(index: CadSourceIndex, node: ts.Node): boolean {
  if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isMethodDeclaration(node)) return !!node.body;
  return (ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node) && !!node.initializer || ts.isShorthandPropertyAssignment(node)) && index.callable(node.name);
}
/** Where the value `node` gives is used: past parentheses, assertions and non-null assertions. */
function outermost(node: ts.Expression): ts.Expression {
  let outer = node;
  while (ts.isParenthesizedExpression(outer.parent) || ts.isNonNullExpression(outer.parent) || ts.isAsExpression(outer.parent) || ts.isSatisfiesExpression(outer.parent)) outer = outer.parent;
  return outer;
}

/**
 * What a walk skipped silently, as `file: text` and why, found by TypeScript's own resolution rather than the walk's. The code the walk
 * entered (`visitEntered`) is checked for coverage: whatever of the project TypeScript says it runs, the walk entered, stopped at
 * (`stopped`) or reported. Code of the project the index does not hold counts only as reported.
 * - Each name used as a value (`unresolved` when reported): the code of each declaration TypeScript gives it (`codeOf`), a module's
 *   namespace read only for its members.
 * - Each member read (`cadMemberReads`): one it left without an outcome; one it says runs nothing of the source (`no-code`, `outside`)
 *   although a declaration TypeScript gives it holds code that the read runs; one reported as unexpanded but not listed among the walk's
 *   unexpanded sites; a read of a `CadError` factory that runs it, which the walk neither reported nor read the code of (`factoryReads`).
 *   Unless it reported the read, the code of each declaration TypeScript gives it that the read runs: a namespace's export whatever the
 *   use, a member that holds code by how it is used.
 * - Each call, `new` and `super(…)` call (`cadCalls`): unless it reported the construction (`untold`), the name called or the member read
 *   called, each function, method or constructor TypeScript gives it, each part of a union callee included (`calledDeclarations`), but the
 *   `CadError` factories, whose code is read at each call. One that resolves to the `CadError` constructor, inherited or not, or a factory,
 *   which the walk neither took as a raise (`raises`) nor reported, unless it reported a factory, or a class raising `CadError`, given on
 *   (`escaped`). One that resolves to a function or constructor whose parameter gives a code, at which the walk did not read that
 *   parameter (`argumentsRead`), unless it reported that function or constructor passed on (`escaped`). A call that may run a function
 *   TypeScript gives no implementation of (`unimplemented`), such as a callable parameter, a variable or a member only a signature
 *   declares, which the walk neither traced from the value that gives it (`traced`) nor reported: its targets say nothing of what it
 *   runs. A member read it calls may stand instead when the walk stopped at it, or followed it and each signature TypeScript gives it is
 *   one an object or class of the source fits (`accessedMembers`), whose code the member reads' check finds entered.
 */
export function cadSkippedMemberReads(index: CadSourceIndex, reach: CadDiagnosticReach): readonly string[] {
  const skipped: string[] = [];
  const entered = new Set<ts.Node>(reach.entries.map(entry => entry.node));
  visitEntered(reach, (_file, child) => entered.add(child));
  const stoppedCode = new Set<ts.Node>([...reach.stopped].flatMap(node => [node, ...codeOf(node)]));
  const covered = (node: ts.Node) => stoppedCode.has(node) || codeOf(node).every(code => entered.has(code) || stoppedCode.has(code));
  // Names.
  visitEntered(reach, (file, child) => {
    if (!ts.isIdentifier(child) || !isReference(child) || reach.unresolved.has(child)) return;
    const { declarations, value } = index.nameDeclarations(child), at = `${file}: ${child.text}`;
    if (!value) return;
    if (!declarations.length && !['undefined', 'arguments', 'globalThis'].includes(child.text)) skipped.push(`${at}, a name TypeScript cannot resolve, not reported`);
    for (const declaration of declarations) {
      const place = index.place(declaration);
      if (place === 'outside') continue;
      if (place === 'unindexed') skipped.push(`${at}, a name of ${declared(index, declaration)}, code the walk does not hold, not reported`);
      else if (ts.isSourceFile(declaration)) {
        const outer = outermost(child), parent = outer.parent;
        if (!((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === outer || ts.isTypeOfExpression(parent)))
          skipped.push(`${at}, a namespace used as a value, not reported`);
      } else if (!covered(declaration)) skipped.push(`${at}, a name of ${declared(index, declaration)}, which the walk neither entered nor reported`);
    }
  });
  // Member reads.
  for (const { file, read } of cadMemberReads(reach)) {
    const outcome = reach.accesses.get(read), at = `${file}: ${read.getText()}`, use = methodUse(read);
    if (outcome === undefined) skipped.push(`${at}, without an outcome`);
    else if (outcome !== 'unexpanded' && !reach.factoryReads.has(read) && index.codeDeclarationsAt(read).some(({ node }) => isCadErrorFactory(node) && runsWhen(node, use)))
      skipped.push(`${at}, a CadError factory whose code the walk did not read`);
    else if (outcome === 'unexpanded' && !reach.unexpanded.some(site => site.startsWith(`${at}, `))) skipped.push(`${at}, unexpanded but not reported`);
    else if (outcome === 'no-code' || outcome === 'outside') {
      const running = index.codeDeclarationsAt(read).filter(({ node }) => runsWhen(node, use));
      for (const { file: owner, node } of running) skipped.push(`${at}, ${outcome} although it runs ${owner}:${node.getText().split('\n')[0].slice(0, 60)}`);
    }
    if (outcome === undefined || outcome === 'unexpanded') continue;
    for (const declaration of index.readDeclarations(read)) {
      const place = index.place(declaration);
      if (place === 'outside' || isCadErrorFactory(declaration)) continue;
      if (place === 'unindexed') skipped.push(`${at}, a member of ${declared(index, declaration)}, code the walk does not hold, not reported`);
      else if ((isNameLevel(declaration) || holdsCode(index, declaration) && runsWhen(declaration, use)) && !covered(declaration))
        skipped.push(`${at}, a member read running ${declared(index, declaration)}, which the walk neither entered nor reported`);
    }
  }
  // Calls and constructions.
  const raising = (declaration: ts.Node) => ts.isConstructorDeclaration(declaration) && ts.isClassDeclaration(declaration.parent) && declaration.parent.name?.text === 'CadError'
    || isCadErrorFactory(declaration);
  const reported = (call: ts.CallExpression | ts.NewExpression) => {
    if (reach.untold.has(call)) return true;
    const callee = bareExpression(call.expression);
    return ts.isIdentifier(callee) ? reach.unresolved.has(callee) : (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) && reach.accesses.get(callee) === 'unexpanded';
  };
  const settledMember = (call: ts.CallExpression) => {
    const callee = calleeOf(call), value = callee && bareExpression(callee);
    if (!value || !(ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value))) return false;
    const outcome = reach.accesses.get(value);
    if (outcome === 'stopped') return true;
    const name = ts.isPropertyAccessExpression(value) ? value.name.text : ts.isStringLiteralLike(value.argumentExpression) ? value.argumentExpression.text : undefined;
    return outcome === 'followed' && name !== undefined && index.accessedMembers(value, name, () => true)?.bare.length === 0;
  };
  for (const { file, call } of cadCalls(reach)) {
    const at = `${file}: ${shortly(call)}`;
    if (ts.isCallExpression(call) && index.unimplemented(call) && !reach.traced.has(call) && !reported(call) && !settledMember(call))
      skipped.push(`${at}, a call of a function TypeScript gives no implementation of, which the walk neither traced nor reported`);
    for (const target of index.calledDeclarations(call)) {
      if (raising(target)) {
        if (!reach.raises.has(call) && !reach.untold.has(call) && !reach.escaped.has(target)) skipped.push(`${at}, a CadError raised whose code the walk did not read`);
      } else if (reach.argumentsRead.get(target)?.has(call) === false && !reach.escaped.has(target)) skipped.push(`${at}, a call whose code argument the walk did not read`);
      if (isCadErrorFactory(target) || reported(call) || reach.escaped.has(target)) continue;
      if (index.place(target) === 'unindexed') skipped.push(`${at}, a call of ${declared(index, target)}, code the walk does not hold, not reported`);
      else if (!covered(target)) skipped.push(`${at}, a call of ${declared(index, target)}, which the walk neither entered nor reported`);
    }
  }
  return [...new Set(skipped)].sort();
}
