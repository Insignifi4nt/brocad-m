import { userFacingMessage } from '@/lib/userMessage';
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Value } from '@sinclair/typebox/value';
import { Button } from '@/components/ui/button';
import { CloseIcon, ConfirmIcon } from '@wire-edm/icons-react';
import type { CadDocument } from '@/domain/cad/cadDocument';
import type { CadSketchDiagnosisMarks } from './cadSketchDefinitionMarks';
import type { CadEdit } from '@/domain/cad/cadOperations';
import { CadContextHelp } from './CadContextHelp';
import { useCadEditSubmission, type CadEditCompletion } from './useCadEditSubmission';

export interface CadSketchCommandSessionProps {
  document: CadDocument;
  documentVersion: string;
  interactionLocked: boolean;
  onEditMany(edits: readonly CadEdit[], signal?: AbortSignal): CadEditCompletion;
  /** `marks` colours the operands of a rejected preview on the canvas until the preview changes or ends. */
  onPreviewDocument(document: CadDocument | null, marks?: CadSketchDiagnosisMarks | null): void;
  onPendingChange(pending: boolean): void;
  onCancel(): void;
}

/**
 * One disposable sketch command: frozen source document, stale-source cancellation,
 * pending/preview lifetimes and a single guarded submission. `extra` is captured once.
 */
export function useCadSketchCommandSession<P extends CadSketchCommandSessionProps, T extends object>(props: P, extra: () => T, onDispose?: (latest: P) => void) {
  const [owner] = useState(() => ({ document: props.document, version: props.documentVersion, ...extra() }));
  const [error, setError] = useState<string | null>(null);
  const submission = useCadEditSubmission(), ended = useRef(false), submitted = useRef<CadDocument | null>(null);
  const callbacks = useRef(props); callbacks.current = props;
  const applying = useRef(false); applying.current = submission.applying;
  const sourceCurrent = props.document === owner.document && props.documentVersion === owner.version;
  // A successful session publication may render before its promise's accepted callback.
  const ownPublication = submission.applying && submitted.current !== null && Value.Equal(props.document, submitted.current);
  const cancel = () => { if (!ended.current) { ended.current = true; submission.cancel(); callbacks.current.onCancel(); } };
  useLayoutEffect(() => { if (props.interactionLocked || !sourceCurrent && !ownPublication) cancel(); }, [props.interactionLocked, sourceCurrent, ownPublication]);
  useLayoutEffect(() => { callbacks.current.onPendingChange(true); return () => {
    onDispose?.(callbacks.current); callbacks.current.onPendingChange(false); callbacks.current.onPreviewDocument(null);
  }; }, []);
  const blocked = ended.current || !sourceCurrent || props.interactionLocked || submission.applying;
  /** Submits prepared edits once; `accept` runs only if the session is still open, and `refused` may handle a refusal instead of its message. */
  const submit = (edits: readonly CadEdit[], prepared: CadDocument, accept: () => void, failure: string, refused?: (cause: unknown) => boolean) => {
    if (blocked) return;
    submitted.current = prepared;
    submission.submit(signal => callbacks.current.onEditMany(edits, signal), () => {
      if (ended.current) return;
      ended.current = true; accept();
    }, cause => { submitted.current = null; if (!refused?.(cause)) setError(userFacingMessage(cause, failure)); });
  };
  /** Live check for deferred callbacks such as canvas picks; reads refs, never render-time values. */
  const closed = () => ended.current || applying.current || callbacks.current.interactionLocked || callbacks.current.document !== owner.document || callbacks.current.documentVersion !== owner.version;
  /** Ends the session without an edit, e.g. when nothing changed. */
  const finish = (accept: () => void) => { if (!closed()) { ended.current = true; accept(); } };
  return { owner, error, setError, cancel, submit, finish, closed, submittedDocument: submitted.current, applying: submission.applying, sourceCurrent, blocked,
    /** Live previews run only while this session may still apply. */
    previewEnabled: sourceCurrent && !props.interactionLocked && !submission.applying };
}

interface FormProps {
  label: string;
  title?: string;
  icon?: ReactNode;
  help: ReactNode;
  session: ReturnType<typeof useCadSketchCommandSession>;
  canApply: boolean;
  issue: string | null;
  status?: ReactNode;
  formRef?: RefObject<HTMLFormElement | null>;
  onSubmit(): void;
  children?: ReactNode;
}

/** Shared sketch command chrome: heading, Escape to cancel, Enter to apply, status line and actions. */
export function CadSketchCommandForm({ label, title = label, icon, help, session, canApply, issue, status, formRef, onSubmit, children }: FormProps) {
  return <form ref={formRef} className="cad-property-form cad-sketch-profile-panel" aria-label={label} aria-busy={session.applying || undefined}
    onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); session.cancel(); } }}
    onSubmit={event => { event.preventDefault(); if (canApply && !session.blocked) onSubmit(); }}>
    <div className="cad-sketch-profile-heading">{icon}<strong>{title}</strong><CadContextHelp label={label}>{help}</CadContextHelp></div>
    {children}
    {status}
    {issue && <p className="cad-error" role="alert">{issue}</p>}
    <div className="cad-form-actions"><Button type="button" onClick={session.cancel}><CloseIcon size={13} /> Cancel</Button>
      <Button variant="primary" type="submit" disabled={session.blocked || !canApply}><ConfirmIcon size={13} /> Apply</Button></div>
  </form>;
}
