import type { CadDocument } from '@/domain/cad/cadDocument';
import { applyCadEdits, type CadEdit } from '@/domain/cad/cadOperations';
import { createCadDocument, parseCadDocument } from '@/domain/cad/cadSchema';
import { storedCadDocumentText } from '@/domain/cad/cadStoredDocument';
import type { SavedCadDocument } from '@/domain/cad/cadStorage';

export interface CadSessionSnapshot {
  readonly document: CadDocument;
  readonly version: string;
  readonly savedVersion: string | null;
  readonly dirty: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly workflowOpen: boolean;
}
export class CadSessionError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export function hasCadDraftContent(document: CadDocument): boolean {
  return document.features.length > 0 || Object.keys(document.parameters).length > 0 || Boolean(document.parameterGroups?.length) || document.name !== 'Untitled part';
}
export function hasUnsavedCadDraft(snapshot: Pick<CadSessionSnapshot, 'dirty' | 'savedVersion' | 'document'>): boolean {
  return snapshot.dirty && (snapshot.savedVersion !== null || hasCadDraftContent(snapshot.document));
}
interface HistoryEntry { readonly document: CadDocument; readonly textLength: number }
type CadWorkflowScope = 'editor' | 'section' | 'import' | 'dxf-export' | 'library' | 'preparation' | 'sketch-edit';
const MAX_HISTORY_STEPS = 50;
const MAX_HISTORY_CHARACTERS = 8 * 1024 * 1024;

/** The UI and agents edit exactly this draft; every accepted batch is one undo step. */
export class CadSession {
  private listeners = new Set<() => void>();
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];
  private pastTextLength = 0;
  private currentText: string;
  private savedText: string | null = null;
  private workflows = new Set<CadWorkflowScope>();
  private workflowRevision = 0;
  private snapshot: CadSessionSnapshot;
  constructor(document = createCadDocument()) {
    this.snapshot = Object.freeze({ document: parseCadDocument(document), version: crypto.randomUUID(), savedVersion: null,
      dirty: true, canUndo: false, canRedo: false, workflowOpen: false });
    this.currentText = storedCadDocumentText(this.snapshot.document);
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  assertVersion(expected: string) {
    if (this.snapshot.version !== expected) throw new CadSessionError('STALE_STATE', 'The CAD draft changed. Read cad_get_context again.');
  }
  assertWorkflowClosed(except?: CadWorkflowScope) {
    if ([...this.workflows].some(scope => scope !== except)) throw new CadSessionError('WORKFLOW_OPEN', 'Finish or cancel the active CAD editor, import, section, library or DXF export dialog first.');
  }
  assertStorageSwitchAllowed() {
    this.assertWorkflowClosed();
    if (hasUnsavedCadDraft(this.snapshot)) throw new CadSessionError('UNSAVED_DRAFT', 'Save the CAD draft before switching workbench storage.');
  }
  setWorkflowOpen = (open: boolean, scope: CadWorkflowScope = 'editor') => {
    if (this.workflows.has(scope) === open) return;
    this.workflowRevision++;
    if (open) this.workflows.add(scope); else this.workflows.delete(scope);
    const workflowOpen = this.workflows.size > 0;
    if (this.snapshot.workflowOpen === workflowOpen) return;
    this.publish({ ...this.snapshot, workflowOpen });
  };
  edit = (edits: readonly CadEdit[], expectedVersion = this.snapshot.version) => {
    this.assertVersion(expectedVersion);
    return this.acceptEdit(applyCadEdits(this.snapshot.document, edits));
  };
  /** Preparation never owns accepted data/history. Recheck the exact workflow before one commit. */
  editPrepared = async (expectedVersion: string, prepare: (document: CadDocument, signal?: AbortSignal) => Promise<CadDocument>, signal?: AbortSignal, assertCurrent?: () => void) => {
    signal?.throwIfAborted(); this.assertVersion(expectedVersion);
    const source = this.snapshot.document, workflowRevision = this.workflowRevision;
    const candidate = await prepare(source, signal);
    signal?.throwIfAborted(); this.assertVersion(expectedVersion);
    if (this.workflowRevision !== workflowRevision) throw new CadSessionError('WORKFLOW_CHANGED', 'The CAD editor changed while this edit was being prepared. Apply the current edit again.');
    assertCurrent?.();
    const next = parseCadDocument(candidate);
    if (next.id !== source.id) throw new CadSessionError('IDENTITY_MISMATCH', 'An edit cannot replace the identity of the open part.');
    return this.acceptEdit(next);
  };
  private acceptEdit(next: CadDocument) {
    const text = storedCadDocumentText(next);
    if (text === this.currentText) return this.snapshot;
    this.pushPast(this.currentEntry());
    this.future = [];
    this.changed(next, text);
    return this.snapshot;
  }
  undo = (expectedVersion = this.snapshot.version) => {
    this.assertVersion(expectedVersion); this.assertWorkflowClosed();
    const previous = this.past.pop();
    if (!previous) return;
    this.pastTextLength -= previous.textLength;
    this.future.push(this.currentEntry()); this.changed(previous.document);
  };
  redo = (expectedVersion = this.snapshot.version) => {
    this.assertVersion(expectedVersion); this.assertWorkflowClosed();
    const next = this.future.pop();
    if (!next) return;
    this.pushPast(this.currentEntry()); this.changed(next.document);
  };
  replace(document: CadDocument, saved: SavedCadDocument | null = null) {
    const parsed = parseCadDocument(document);
    if (saved && storedCadDocumentText(parseCadDocument(saved.document)) !== storedCadDocumentText(parsed)) {
      throw new CadSessionError('INVALID_SAVE_RECEIPT', 'The saved CAD receipt does not describe the document being opened.');
    }
    this.workflows.clear();
    this.workflowRevision++;
    this.past = []; this.future = []; this.pastTextLength = 0;
    this.currentText = storedCadDocumentText(parsed);
    this.savedText = saved ? this.currentText : null;
    this.publish({ document: parsed, version: crypto.randomUUID(), savedVersion: saved?.savedVersion ?? null,
      dirty: !saved, canUndo: false, canRedo: false, workflowOpen: false });
  }
  markSaved(saved: SavedCadDocument, expectedVersion: string) {
    this.assertVersion(expectedVersion);
    const savedText = storedCadDocumentText(parseCadDocument(saved.document));
    if (savedText !== this.currentText) throw new CadSessionError('INVALID_SAVE_RECEIPT', 'The saved CAD receipt does not describe the reviewed draft.');
    this.savedText = savedText;
    this.publish({ ...this.snapshot, savedVersion: saved.savedVersion, dirty: false });
  }
  detachStorage() {
    this.savedText = null;
    this.publish({ ...this.snapshot, savedVersion: null, dirty: true });
  }
  private currentEntry(): HistoryEntry { return { document: this.snapshot.document, textLength: this.currentText.length }; }
  private pushPast(entry: HistoryEntry) {
    this.past.push(entry); this.pastTextLength += entry.textLength;
    // Preserve the original serialized-array character budget, including brackets
    // and commas. Only immutable document lengths are retained; no history text.
    while (this.past.length > MAX_HISTORY_STEPS || this.past.length > 1
      && this.pastTextLength + this.past.length + 1 > MAX_HISTORY_CHARACTERS) {
      const removed = this.past.shift();
      if (removed) this.pastTextLength -= removed.textLength;
    }
  }
  private changed(document: CadDocument, text = storedCadDocumentText(document)) {
    this.currentText = text;
    this.publish({ ...this.snapshot, document, version: crypto.randomUUID(), dirty: text !== this.savedText,
      canUndo: this.past.length > 0, canRedo: this.future.length > 0 });
  }
  private publish(snapshot: CadSessionSnapshot) {
    this.snapshot = Object.freeze(snapshot);
    for (const listener of this.listeners) listener();
  }
}
