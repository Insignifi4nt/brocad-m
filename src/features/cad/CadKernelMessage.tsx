import { CadError } from '@/domain/cad/cadError';
import type { CadIssue } from '@/domain/cad/cadIssues';
import './cad-kernel-message.css';

/**
 * The kernel's own words for a failure, closed under the message until opened. The message names the cause and the next step; this keeps
 * what the kernel itself reported, verbatim and bounded, for a report or a closer look.
 */
export function CadKernelMessage({ text }: { readonly text: string | null }) {
  if (!text) return null;
  return <details className="cad-kernel-message"><summary>Kernel message</summary><p>{text}</p></details>;
}

/** The kernel's own words a refusal carries, or null. */
export function cadKernelMessageOf(error: unknown): string | null {
  return error instanceof CadError && error.kernelMessage ? error.kernelMessage : null;
}

/** The kernel's own words an issue keeps in its details, or null. */
export function cadIssueKernelMessage(issue: CadIssue): string | null {
  const text = (issue.details as { readonly kernelMessage?: unknown }).kernelMessage;
  return typeof text === 'string' && text ? text : null;
}
