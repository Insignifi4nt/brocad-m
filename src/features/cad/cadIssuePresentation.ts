import type { CadDocument } from '@/domain/cad/cadDocument';
import type { CadIssue, CadIssueSubject } from '@/domain/cad/cadIssues';
import { readableMessage } from '@/lib/userMessage';

/**
 * What issue text reads its names from: each feature's name by id and each issue of the shown list by key, the first of a repeated id or
 * key. Indexed once for a list of rows (`cadIssueNames`), so labelling every row of a long history stays linear in its length.
 */
export interface CadIssueNames {
  /** The name of feature `featureId`, or the id itself when the document has no such feature. */
  feature(featureId: string): string;
  /** The issue of the shown list with key `key`. */
  issue(key: string): CadIssue | undefined;
}

/** The names of the features of `document` and the issues of list `items`, each indexed once, on its first read: a list nothing labels indexes nothing. */
export function cadIssueNames(items: readonly CadIssue[], document: Pick<CadDocument, 'features'>): CadIssueNames {
  let features: Map<string, string> | undefined, issues: Map<string, CadIssue> | undefined;
  return Object.freeze({
    feature(featureId: string) {
      if (!features) { features = new Map(); for (const feature of document.features) if (!features.has(feature.id)) features.set(feature.id, feature.name); }
      return features.get(featureId) ?? featureId;
    },
    issue(key: string) {
      if (!issues) { issues = new Map(); for (const item of items) if (!issues.has(item.key)) issues.set(item.key, item); }
      return issues.get(key);
    }
  });
}

/** The name an issue's subject goes by: its feature's name, with the input or body it names, the CAM or export step and its source, or the part. */
export function cadIssueSubjectLabel(subject: CadIssueSubject, names: CadIssueNames): string {
  switch (subject.kind) {
    case 'document': return 'Part';
    case 'feature': return names.feature(subject.featureId);
    case 'reference-slot': return `${names.feature(subject.featureId)} · input ${names.feature(subject.inputId)}`;
    case 'body': return `${names.feature(subject.featureId)} · body ${subject.key}`;
    case 'cam-operation': return `${subject.operation === 'section' ? 'Section for CAM' : 'Send to CAM'} · ${names.feature(subject.sourceId)}`;
    case 'export-operation': return `Section DXF export · ${names.feature(subject.sourceId)}`;
    case 'sketch-relation': case 'sketch-entity': case 'sketch-point': return names.feature(subject.sketchId);
  }
}

/** What issue `issue` names as its causes, by the subjects of the issues of the shown list they are, or null when it names none. */
export function cadIssueCauseLabel(issue: CadIssue, names: CadIssueNames): string | null {
  if (!issue.causes.length) return null;
  const labels = new Set(issue.causes.map(key => {
    const cause = names.issue(key);
    return cause ? cadIssueSubjectLabel(cause.subject, names) : key;
  }));
  return `Cause: ${[...labels].join(', ')}`;
}

/** The text a feature's history row gives its issue: the issue's message and, when it names any, its causes. */
export function cadIssueRowText(issue: CadIssue, names: CadIssueNames): string {
  const cause = cadIssueCauseLabel(issue, names);
  return cause ? `${readableMessage(issue.message)} · ${cause}` : readableMessage(issue.message);
}
