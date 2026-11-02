// TypeScript 7 ships no compiler API yet; AST tooling uses the TypeScript 6 package.
import ts from '@typescript/typescript6';
import { bareExpression, isCadErrorFactory, methodUse, type CadDiagnosticReach, type CadMemberRead, type CadSourceIndex } from './cadDiagnosticReach';

/**
 * Visits the code a walk entered, found apart from the walk: each entered node's code but its types and imports, and for an object read
 * only for its members, not its methods and accessors nor those of the objects its properties hold, which run only as member reads run
 * them.
 */
function visitEntered(reach: CadDiagnosticReach, found: (file: string, child: ts.Node) => void): void {
  for (const { file, node, held } of reach.entries) {
    const heldObjects = new Set<ts.Node>(held ? [held] : []);
    const visit = (child: ts.Node): void => {
      if (ts.isTypeNode(child) || ts.isInterfaceDeclaration(child) || ts.isTypeAliasDeclaration(child) || ts.isImportDeclaration(child)) return;
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

/** A call's text on one line, shortened, for a report. */
const shortly = (node: ts.Node) => { const text = node.getText().replace(/\s+/g, ' '); return text.length > 80 ? `${text.slice(0, 79)}…` : text; };

/**
 * The member reads and calls a walk skipped silently, as `file: text` and why, found by TypeScript's own resolution rather than the walk's:
 * - each member read of the walked code (`cadMemberReads`) it left without an outcome, and each it says runs nothing of the source
 *   (`no-code`, `outside`) although a declaration TypeScript gives it holds code that the read runs (`codeDeclarationsAt`). A read
 *   reported as unexpanded is listed among the walk's unexpanded sites too. A read of a `CadError` factory that runs it, which the walk
 *   neither reported nor read the code of (`factoryReads`), skipped a code;
 * - each call, `new` and `super(…)` call of the walked code (`cadCalls`) that TypeScript resolves to the `CadError` constructor, inherited
 *   or not, or to a factory, which the walk neither took as a raise (`raises`) nor reported as constructing a class it cannot tell
 *   (`untold`), however the class or factory is named, unless it reported a factory, or a class raising `CadError`, given on
 *   (`escaped`), when what calls the factory through that value is unseen;
 * - each such call TypeScript resolves to a function or constructor whose parameter gives a code, at which the walk did not read that
 *   parameter (`argumentsRead`), unless it reported that function or constructor passed on (`escaped`), when what calls it is unseen.
 */
export function cadSkippedMemberReads(index: CadSourceIndex, reach: CadDiagnosticReach): readonly string[] {
  const skipped: string[] = [];
  for (const { file, read } of cadMemberReads(reach)) {
    const outcome = reach.accesses.get(read), at = `${file}: ${read.getText()}`;
    if (outcome === undefined) skipped.push(`${at}, without an outcome`);
    else if (outcome !== 'unexpanded' && !reach.factoryReads.has(read) && index.codeDeclarationsAt(read).some(({ node }) => isCadErrorFactory(node) && runsWhen(node, methodUse(read))))
      skipped.push(`${at}, a CadError factory whose code the walk did not read`);
    else if (outcome === 'unexpanded' && !reach.unexpanded.some(site => site.startsWith(`${at}, `))) skipped.push(`${at}, unexpanded but not reported`);
    else if (outcome === 'no-code' || outcome === 'outside') {
      const use = methodUse(read), running = index.codeDeclarationsAt(read).filter(({ node }) => runsWhen(node, use));
      for (const { file: owner, node } of running) skipped.push(`${at}, ${outcome} although it runs ${owner}:${node.getText().split('\n')[0].slice(0, 60)}`);
    }
  }
  const raising = (declaration: ts.Node) => ts.isConstructorDeclaration(declaration) && ts.isClassDeclaration(declaration.parent) && declaration.parent.name?.text === 'CadError'
    || isCadErrorFactory(declaration);
  for (const { file, call } of cadCalls(reach))
    for (const target of index.calledDeclarations(call, declaration => raising(declaration) || reach.argumentsRead.has(declaration))) {
      if (raising(target)) {
        if (!reach.raises.has(call) && !reach.untold.has(call) && !reach.escaped.has(target)) skipped.push(`${file}: ${shortly(call)}, a CadError raised whose code the walk did not read`);
      } else if (reach.argumentsRead.get(target)?.has(call) === false && !reach.escaped.has(target))
        skipped.push(`${file}: ${shortly(call)}, a call whose code argument the walk did not read`);
    }
  return [...new Set(skipped)].sort();
}
