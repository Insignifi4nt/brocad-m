import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { WarningIcon } from '@wire-edm/icons-react';
import type { CadBuildIssues } from '@/domain/cad/cadBuildIssues';
import type { CadDocument } from '@/domain/cad/cadDocument';
import { cadIssueFeatureId, type CadIssueRepair } from '@/domain/cad/cadIssues';
import { readableMessage } from '@/lib/userMessage';
import { cadIssueCauseLabel, cadIssueSubjectLabel } from './cadIssuePresentation';
import './cad-model-issue-list.css';

export interface CadModelIssueListProps {
  /** The issues of the build the workbench shows. */
  readonly issues: CadBuildIssues;
  readonly document: Pick<CadDocument, 'features'>;
  /** Why the repairs cannot run now, or null when they can. */
  readonly repairsLocked: string | null;
  /** Selects the feature an issue is about in the history. */
  onSelectFeature(featureId: string): void;
  /** Runs a repair an issue offers: editing its feature, or choosing its edges or opening again. */
  onRepair(repair: CadIssueRepair): void;
}

/**
 * The count of the problems of the shown build, in the CAD header, which opens as a list: each issue with what it is about, its message and
 * what it names as its cause, and the repairs it offers. Body issues are listed with the feature failures and the features they block.
 */
export function CadModelIssueList({ issues, document, repairsLocked, onSelectFeature, onRepair }: CadModelIssueListProps) {
  const [open, setOpen] = useState(false), listId = useId(), trigger = useRef<HTMLButtonElement>(null);
  const count = issues.items.length, failed = issues.items.some(issue => issue.severity === 'error');
  useLayoutEffect(() => { if (!count) setOpen(false); }, [count]);
  if (!count) return null;
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const label = `${count} model ${count === 1 ? 'issue' : 'issues'}`;
  return <div className="cad-header-issues" data-cad-model-issues={count}>
    <Button ref={trigger} type="button" className={failed ? 'has-failures' : undefined} aria-label={label} aria-expanded={open} aria-controls={open ? listId : undefined}
      title="Show the model issues" onClick={() => setOpen(value => !value)}><WarningIcon size={13} /><span>{count}</span></Button>
    {open && <div id={listId} className="cad-header-issue-list" onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); close(); } }}>
      <ul aria-label="Model issues">{issues.items.map(issue => {
        const subject = cadIssueSubjectLabel(issue.subject, document), cause = cadIssueCauseLabel(issue, issues.items, document), featureId = cadIssueFeatureId(issue.subject);
        return <li key={issue.key} data-cad-issue-code={issue.code} data-cad-issue-state={issue.state} data-cad-issue-severity={issue.severity}>
          <Button type="button" data-cad-issue-row="" disabled={featureId === null} title={featureId === null ? undefined : `Select ${subject} in history`}
            onClick={() => { if (featureId !== null) onSelectFeature(featureId); }}>
            <span className="cad-header-issue-subject">{subject}</span><span className="cad-header-issue-message">{readableMessage(issue.message)}</span>
            {cause && <small className="cad-header-issue-cause">{cause}</small>}
          </Button>
          {issue.repairs.length > 0 && <span className="cad-header-issue-repairs">{issue.repairs.map(repair => <Button key={repair.id} type="button" size="sm" data-cad-issue-repair={repair.id}
            aria-label={`${repair.label}: ${subject}`} title={repairsLocked ?? repair.label} disabled={repairsLocked !== null}
            onClick={() => { setOpen(false); onRepair(repair); }}>{repair.label}</Button>)}</span>}
        </li>;
      })}</ul>
    </div>}
  </div>;
}
