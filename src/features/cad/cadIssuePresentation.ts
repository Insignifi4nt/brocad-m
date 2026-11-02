import type { CadDocument } from '@/domain/cad/cadDocument';
import type { CadIssue, CadIssueSubject } from '@/domain/cad/cadIssues';
import { readableMessage } from '@/lib/userMessage';

type Features = Pick<CadDocument, 'features'>;

/** The name an issue's subject goes by: its feature's name, with the input or body it names, the CAM step and its source, or the part. */
export function cadIssueSubjectLabel(subject: CadIssueSubject, document: Features): string {
  const name = (id: string) => document.features.find(feature => feature.id === id)?.name ?? id;
  switch (subject.kind) {
    case 'document': return 'Part';
    case 'feature': return name(subject.featureId);
    case 'reference-slot': return `${name(subject.featureId)} · input ${name(subject.inputId)}`;
    case 'body': return `${name(subject.featureId)} · body ${subject.key}`;
    case 'cam-operation': return `${subject.operation === 'section' ? 'Section for CAM' : 'Send to CAM'} · ${name(subject.sourceId)}`;
    case 'sketch-relation': case 'sketch-entity': case 'sketch-point': return name(subject.sketchId);
  }
}

/** What issue `issue` names as its causes, by the subjects of the issues of `items` they are, or null when it names none. */
export function cadIssueCauseLabel(issue: CadIssue, items: readonly CadIssue[], document: Features): string | null {
  if (!issue.causes.length) return null;
  const labels = new Set(issue.causes.map(key => {
    const cause = items.find(item => item.key === key);
    return cause ? cadIssueSubjectLabel(cause.subject, document) : key;
  }));
  return `Cause: ${[...labels].join(', ')}`;
}

/** The text a feature's history row gives its issue: the issue's message and, when it names any, its causes. */
export function cadIssueRowText(issue: CadIssue, items: readonly CadIssue[], document: Features): string {
  const cause = cadIssueCauseLabel(issue, items, document);
  return cause ? `${readableMessage(issue.message)} · ${cause}` : readableMessage(issue.message);
}
