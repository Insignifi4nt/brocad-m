import { CadError } from './cadError';
import type { CadIssueSubject } from './cadIssues';

/** Where a refusal was raised: the feature or input slot the document check was reading, the document, or a CAM step and its source. */
export type CadRefusalSubject = Extract<CadIssueSubject, { readonly kind: 'document' | 'feature' | 'reference-slot' | 'cam-operation' }>;
/** When an operation or step started (`cadRefusalMark`), so only a record made since then is of its own propagation. */
export type CadRefusalMark = number & { readonly cadRefusalMark: unique symbol };
type Recorded = { readonly subject: CadRefusalSubject; readonly at: number };
const records = new WeakMap<CadError, Recorded>();
let made = 0;

/**
 * Whether a step at `outer` encloses one at `inner`, so a refusal raised at `inner` passes through `outer` on its way out: the same
 * subject; a feature around one of its input slots; the document around its features and their slots; a CAM step around the document
 * check it runs, which records the feature or slot it was reading.
 */
function encloses(outer: CadRefusalSubject, inner: CadRefusalSubject): boolean {
  switch (outer.kind) {
    case 'document': return inner.kind !== 'cam-operation';
    case 'feature': return (inner.kind === 'feature' || inner.kind === 'reference-slot') && inner.featureId === outer.featureId;
    case 'reference-slot': return inner.kind === 'reference-slot' && inner.featureId === outer.featureId && inner.field === outer.field && inner.inputId === outer.inputId;
    case 'cam-operation': return inner.kind === 'feature' || inner.kind === 'reference-slot'
      || inner.kind === 'cam-operation' && inner.operation === outer.operation && inner.sourceId === outer.sourceId;
  }
}

/** Marks the start of an operation or step: a refusal recorded before it belongs to an earlier propagation of that refusal. */
export function cadRefusalMark(): CadRefusalMark { return made as CadRefusalMark; }

/**
 * Records that refusal `error` was raised at `subject` and returns it to be thrown again; anything but a `CadError` passes through
 * unrecorded. One propagation records its steps from the nearest out, so a step keeps the nearer record when it encloses it (`encloses`)
 * and the record was made since the step started (`since`, when the step marked it). Any other record is of an earlier propagation of a
 * refusal raised again, and the step's own replaces it: a reused refusal never keeps the subject of its first use, and a CAM step's never
 * carries into an operation that is no CAM step. Either way the record is the step's now, so a step that marks no start, which cannot tell,
 * makes an enclosed record its own propagation's. The refusal itself, its code and its message are unchanged.
 */
export function cadRefusalAt<E>(error: E, subject: CadRefusalSubject, since?: CadRefusalMark): E {
  if (!(error instanceof CadError)) return error;
  const recorded = records.get(error);
  const nearer = recorded && encloses(subject, recorded.subject) && (since === undefined || recorded.at > since) ? recorded.subject : Object.freeze({ ...subject });
  records.set(error, Object.freeze({ subject: nearer, at: ++made }));
  return error;
}

/** Where refusal `error` was recorded as raised, or undefined when no step recorded it, or none since `since` when the reader marked it. */
export function cadRefusalSubject(error: CadError, since?: CadRefusalMark): CadRefusalSubject | undefined {
  const recorded = records.get(error);
  return recorded && (since === undefined || recorded.at > since) ? recorded.subject : undefined;
}
