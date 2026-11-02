import type { CadSketchGraph, CadSketchGraphRelation } from '@/domain/cad/cadSketchGraph';
import { CadSketchPreparationError } from './cadSketchConstraintFeedback';

export type CadSketchInferenceDropReason = CadSketchPreparationError['feedback']['reason'];

const thenable = <T>(value: T | PromiseLike<T>): value is PromiseLike<T> =>
  typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
// A synchronous submission stays synchronous, so the caller's acceptance timing is unchanged.
function settle<T>(run: () => T | PromiseLike<T>, recover: (error: unknown) => T | PromiseLike<T>): T | Promise<T> {
  let result: T | PromiseLike<T>;
  try { result = run(); } catch (error) { return recover(error) as T | Promise<T>; }
  return thenable(result) ? Promise.resolve(result).then(undefined, recover) : result;
}
function then<T, U>(value: T | PromiseLike<T>, next: (value: T) => U): U | Promise<U> {
  return thenable(value) ? Promise.resolve(value).then(next) : next(value);
}

/** Relations a preparation failure names. */
function blamedIds(error: CadSketchPreparationError): ReadonlySet<string> {
  const { conflictingIds, redundantIds, partiallyRedundantIds, issues } = error.diagnostics;
  return new Set([...conflictingIds, ...redundantIds, ...partiallyRedundantIds, ...issues.flatMap(issue => issue.source.kind === 'relation' ? [issue.source.id] : [])]);
}

/**
 * Append a drawing whose inferred horizontal and vertical relations are optional. The full graph goes first, so a
 * drawing the sketch accepts costs one preparation. When preparation rejects it, the blamed inferences are dropped
 * and the drawing is tried once more, then once without any inference, whose failure is the one reported. Attachments
 * are never dropped. An abort, any other error, a solver that failed rather than judged the drawing, a failure that blames only other
 * relations, or a changed base (`current` false) stops at once. Every attempt keeps the same identities, and at most one is accepted.
 */
export function appendCadSketchGraphWithInferences<T>({ graph, inferredIds, submit, signal, current, onDropped }: {
  readonly graph: CadSketchGraph;
  readonly inferredIds: readonly string[];
  readonly submit: (graph: CadSketchGraph) => T | PromiseLike<T>;
  readonly signal?: AbortSignal;
  readonly current: () => boolean;
  readonly onDropped: (dropped: readonly CadSketchGraphRelation[], reason: CadSketchInferenceDropReason) => void;
}): T | Promise<T> {
  const inferred = new Set(inferredIds.filter(id => graph.relations.some(relation => relation.id === id)));
  const retryable = (error: unknown): error is CadSketchPreparationError => error instanceof CadSketchPreparationError && error.feedback.cause !== 'solver-unavailable'
    && !signal?.aborted && current();
  const commitWithout = (ids: ReadonlySet<string>, reason: CadSketchInferenceDropReason) =>
    then(submit(Object.freeze({ ...graph, relations: Object.freeze(graph.relations.filter(relation => !ids.has(relation.id))) })), result => {
      onDropped(graph.relations.filter(relation => ids.has(relation.id)), reason); return result;
    });
  return settle(() => submit(graph), error => {
    if (!inferred.size || !retryable(error)) throw error;
    const blamed = blamedIds(error), named = new Set([...inferred].filter(id => blamed.has(id)));
    // Without those inferences the same relations would still fail.
    if (blamed.size && !named.size) throw error;
    const reason = error.feedback.reason;
    if (!named.size || named.size === inferred.size) return commitWithout(inferred, reason);
    return settle(() => commitWithout(named, reason), retry => {
      if (!retryable(retry)) throw retry;
      return commitWithout(inferred, reason);
    });
  });
}

/** A neutral note naming the inferred relations a drawing was accepted without. */
export function cadSketchInferenceNote(dropped: readonly CadSketchGraphRelation[], reason: CadSketchInferenceDropReason): string {
  const names = [...new Set(dropped.map(relation => relation.kind))].join(' and '), plural = dropped.length > 1;
  const why = reason === 'redundant' ? plural ? 'they repeat existing relations' : 'it repeats existing relations'
    : reason === 'conflicting' ? plural ? 'they conflict with existing relations' : 'it conflicts with existing relations'
    : plural ? 'the sketch could not keep them' : 'the sketch could not keep it';
  return `${names[0].toUpperCase()}${names.slice(1)}${plural ? ' relations' : ''} not added: ${why}.`;
}
