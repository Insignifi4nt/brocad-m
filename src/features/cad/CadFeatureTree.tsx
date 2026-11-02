import { cadFeatureActive, cadFeatureSuppressionFlag } from '@/domain/cad/features/cadFeatureActivity';
import { Tooltip } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { AdjustIcon, BooleanIcon, ChamferIcon, CircleIcon, CircularPatternIcon, ClosedPathIcon, CurveIcon, DatumPlaneIcon, ExpandRightIcon, FileBodyIcon, FilletIcon, ImportedBodyIcon, LayersIcon, LinearPatternIcon, LinkIcon, LoftIcon, MirrorIcon, Move3dIcon, PadIcon, PluginIcon, PocketIcon, RectangleIcon, RevolveIcon, ShellIcon, SketchIcon, SlotIcon, SweepIcon, InfoIcon, WarningIcon, type WorkbenchIconComponent } from '@wire-edm/icons-react';
import { NO_CAD_BUILD_ISSUES, type CadBuildIssues } from '@/domain/cad/cadBuildIssues';
import type { CadCurveFeature, CadDocument, CadFeature, CadPlane, CadSketchFeature, CadSketchPlane, CadSketchProfile } from '@/domain/cad/cadDocument';
import { cadFeatureDependencies } from '@/domain/cad/cadFeatureInputs';
import { featureLabels } from './CadFeatureEditor';
import { CadContextMenu, type CadContextMenuAnchor, type CadContextMenuItem } from './CadContextMenu';
import { CadTreeRename } from './CadTreeRename';
import { cadFeatureTreeRelationships } from './cadFeatureTreeModel';
import { cadIssueNames, cadIssueRowText } from './cadIssuePresentation';
import type { CadEditCompletion } from './useCadEditSubmission';
import './cad-feature-tree.css';

const icons: Record<CadFeature['kind'], WorkbenchIconComponent> = {
  'datum-plane': DatumPlaneIcon, sketch: SketchIcon, curve: CurveIcon, imported: ImportedBodyIcon, extrude: PadIcon, pocket: PocketIcon, revolve: RevolveIcon,
  loft: LoftIcon, sweep: SweepIcon, fillet: FilletIcon, chamfer: ChamferIcon, shell: ShellIcon, boolean: BooleanIcon, transform: Move3dIcon,
  'linear-pattern': LinearPatternIcon, 'circular-pattern': CircularPatternIcon, mirror: MirrorIcon,
};
const profileIcons: Record<CadSketchProfile['geometry']['kind'], WorkbenchIconComponent> = {
  rectangle: RectangleIcon, circle: CircleIcon, slot: SlotIcon, polygon: ClosedPathIcon, path: ClosedPathIcon, plugin: PluginIcon,
};
type TreeTarget = { kind: 'feature'; featureId: string } | { kind: 'profile'; featureId: string; profileId: string };
type TreeBranch = 'part' | 'model' | 'reference' | 'parameters';
export interface CadFeatureTreeProps {
  document: CadDocument;
  /** The issues of the shown build: a feature that failed is marked as an error, one an input keeps from evaluating as blocked. */
  issues?: CadBuildIssues;
  selectedId: string | null;
  selectedProfileId: string | null;
  locked: boolean;
  /** Reference picker owns row selection; no nested profile or editor actions. */
  selectionOnly?: boolean;
  selectableFeatureIds?: readonly string[];
  /** A sketch-plane request may select principal rows as well as eligible datums. */
  allowPrincipalPlaneSelection?: boolean;
  highlightedFeatureIds?: readonly string[];
  /** A single click only selects; opening a feature's editor is a separate, explicit request. */
  onSelect(id: string): void;
  /** Double-click or the row menu opens a non-sketch, non-curve feature's editor. */
  onConfigure?(feature: CadFeature): void;
  onEditSketch(feature: CadSketchFeature): void;
  onEditCurve(feature: CadCurveFeature): void;
  onSelectProfile(sketch: CadSketchFeature, profileId: string): void;
  onSuppress?(feature: CadFeature, suppressed: boolean): void;
  /** Opens read-only measurements for one feature or, with `null`, the whole body. */
  onProperties?(featureId: string | null): void;
  /** Starts a plane pick that moves the sketch onto the clicked plane. */
  onChangeSketchPlane?(feature: CadSketchFeature): void;
  onDelete?(feature: CadFeature): void;
  onUpdateProfile?(sketch: CadSketchFeature, profile: CadSketchProfile): void;
  onDeleteProfile?(sketch: CadSketchFeature, profileId: string): void;
  onCopyProfile?(sketch: CadSketchFeature, profileId: string): void;
  onContextMenuOpenChange?(open: boolean): void;
  onRename?(feature: CadFeature, name: string, profileId?: string, signal?: AbortSignal): CadEditCompletion;
  onRenamePendingChange?(pending: boolean): void;
  cancelSignal?: number;
  onCreateSketch?(plane: CadPlane): void;
  selectedReferencePlane?: CadPlane | null;
  onSelectReferencePlane?(plane: CadPlane): void;
  /** The plane under the pointer in the design area or this tree; its row shares the hover highlight. */
  hoveredReferencePlane?: CadSketchPlane | null;
  /** Pointer hover over a reference or datum plane row, and `null` when it leaves. */
  onHoverReferencePlane?(plane: CadSketchPlane | null): void;
  /** Cuts the model view by a datum plane, from that plane's context menu. */
  onSectionView?(plane: CadSketchPlane): void;
  /** Real parameter operations supplied by the workbench, mounted when expanded. */
  parameterContent?: ReactNode;
  /** Actions for the Parameters branch's context menu; choosing one reveals the branch first. */
  parameterMenu?: readonly { readonly label: string; readonly help?: string; onSelect(): void }[];
  /**
   * What the sketch being edited lists under its row, such as its relations. A new `reveal` token expands that row; the content stays
   * usable while the tree only selects.
   */
  sketchContent?: { readonly sketchId: string; readonly content: ReactNode; readonly reveal?: string | null } | null;
}

/** One ordered model history, with links taken from the same reference model as rebuild. */
export function CadFeatureTree({ document, issues = NO_CAD_BUILD_ISSUES, selectedId, selectedProfileId, locked, selectionOnly = false, highlightedFeatureIds = [], onSelect, onConfigure, onEditSketch, onEditCurve, onSelectProfile,
  selectableFeatureIds, allowPrincipalPlaneSelection = false, onSuppress, onProperties, onChangeSketchPlane, onDelete, onUpdateProfile, onDeleteProfile, onCopyProfile, onContextMenuOpenChange, onRename, onRenamePendingChange, cancelSignal = 0, onCreateSketch, sketchContent, selectedReferencePlane, onSelectReferencePlane, hoveredReferencePlane = null, onHoverReferencePlane, onSectionView, parameterContent, parameterMenu }: CadFeatureTreeProps) {

  const treeId = useId();
  const tree = useRef<HTMLOListElement>(null), returnFocus = useRef<{ documentId: string; target: TreeTarget } | null>(null);
  const pendingCallback = useRef(onRenamePendingChange); pendingCallback.current = onRenamePendingChange;
  // Starts unselected so the first render reveals an initial selection through the same nesting path.
  const [treeView, setTreeView] = useState<{ selectedId: string | null; expanded: ReadonlySet<string>; branches: ReadonlySet<TreeBranch> }>(() => ({
    selectedId: null, expanded: new Set(), branches: new Set(['part', 'model']),
  }));
  const relationships = useMemo(() => cadFeatureTreeRelationships(document.features), [document.features]);
  // Indexed once per build and history, not per row or on hover, so the rows of a long blocked chain stay linear to label.
  const issueNames = useMemo(() => cadIssueNames(issues.items, document), [issues.items, document]);
  // Reveal selection before sibling views read the tree for their initial Fit.
  // Remember the selection so ordinary rerenders preserve manual collapse.
  if (treeView.selectedId !== selectedId) {
    // A nested sketch is revealed by opening every feature that contains it.
    const reveal: string[] = [];
    for (let id: string | undefined = selectedId ?? undefined; id; id = relationships.owner.get(id)?.id) reveal.push(id);
    setTreeView({
      selectedId,
      expanded: reveal.some(id => !treeView.expanded.has(id)) ? new Set([...treeView.expanded, ...reveal]) : treeView.expanded,
      branches: selectedId && (!treeView.branches.has('part') || !treeView.branches.has('model')) ? new Set([...treeView.branches, 'part', 'model']) : treeView.branches,
    });
  }
  // The sketch being edited opens on its content, and again on each reveal, so its relations are in view.
  const contentKey = sketchContent ? `${sketchContent.sketchId}/${sketchContent.reveal ?? ''}` : null, [revealedContent, setRevealedContent] = useState<string | null>(null);
  if (contentKey !== revealedContent) {
    setRevealedContent(contentKey);
    if (sketchContent) {
      const reveal: string[] = [];
      for (let id: string | undefined = sketchContent.sketchId; id; id = relationships.owner.get(id)?.id) reveal.push(id);
      if (reveal.some(id => !treeView.expanded.has(id)) || !treeView.branches.has('part') || !treeView.branches.has('model')) {
        setTreeView({ ...treeView, expanded: new Set([...treeView.expanded, ...reveal]), branches: new Set([...treeView.branches, 'part', 'model']) });
      }
    }
  }
  const { expanded, branches } = treeView;
  const [rename, setRename] = useState<{ document: CadDocument; cancelSignal: number; target: TreeTarget } | null>(null);
  const renameCurrent = !locked && !selectionOnly && rename?.document === document && rename.cancelSignal === cancelSignal ? rename : null;
  const [menu, setMenu] = useState<{ document: CadDocument; featureId: string | null; profileId?: string; parameters?: true; anchor: CadContextMenuAnchor } | null>(null);
  const menuCurrent = !locked && !selectionOnly && !renameCurrent && menu?.document === document ? menu : null;
  const selectable = useMemo(() => selectionOnly && selectableFeatureIds ? new Set(selectableFeatureIds) : null, [selectionOnly, selectableFeatureIds]);
  const selectionDisabled = (id: string) => locked || Boolean(renameCurrent) || selectable !== null && !selectable.has(id);
  useLayoutEffect(() => { onContextMenuOpenChange?.(Boolean(menuCurrent)); return () => onContextMenuOpenChange?.(false); }, [Boolean(menuCurrent), onContextMenuOpenChange]);
  useEffect(() => { setMenu(null); }, [document, locked, selectionOnly, cancelSignal]);
  useEffect(() => { setRename(null); }, [document, locked, selectionOnly, cancelSignal]);
  useEffect(() => () => pendingCallback.current?.(false), []);
  useLayoutEffect(() => {
    onRenamePendingChange?.(Boolean(renameCurrent));
    if (renameCurrent || !returnFocus.current) return;
    const saved = returnFocus.current; returnFocus.current = null;
    if (saved.documentId !== document.id) return;
    const target = saved.target;
    const node = [...tree.current?.querySelectorAll<HTMLElement>('[data-cad-feature-id]') ?? []].find(node => node.dataset.cadFeatureId === target.featureId);
    const row = target.kind === 'feature' ? node?.querySelector<HTMLButtonElement>('.cad-feature-history-row > .cad-tree-row')
      : [...node?.querySelectorAll<HTMLButtonElement>('[data-cad-profile-id]') ?? []].find(row => row.dataset.cadProfileId === target.profileId);
    row?.focus({ preventScroll: true });
  }, [Boolean(renameCurrent), onRenamePendingChange, document.id]);
  const toggle = (id: string) => setTreeView(previous => {
    const expanded = new Set(previous.expanded); if (expanded.has(id)) expanded.delete(id); else expanded.add(id); return { ...previous, expanded };
  });
  const toggleBranch = (branch: TreeBranch) => setTreeView(previous => {
    const branches = new Set(previous.branches); if (branches.has(branch)) branches.delete(branch); else branches.add(branch); return { ...previous, branches };
  });
  const beginRename = (target: TreeTarget) => {
    if (locked || selectionOnly || renameCurrent || !onRename) return;
    returnFocus.current = { documentId: document.id, target };
    setMenu(null); setRename({ document, cancelSignal, target });
  };
  const renameEditor = (feature: CadFeature, profile?: CadSketchProfile) => <CadTreeRename kind={profile ? 'profile' : 'feature'} initialName={profile?.name ?? feature.name}
    onCancel={() => setRename(null)} onAccept={(name, signal) => {
      if (!renameCurrent || !onRename) return;
      const owner = renameCurrent;
      const completion = name !== (profile?.name ?? feature.name) ? onRename(feature, name, profile?.id, signal) : undefined;
      return Promise.resolve(completion).then(() => {
        signal?.throwIfAborted();
        setRename(current => current === owner ? null : current);
      });
    }} />;
  const openMenu = (event: MouseEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>, featureId: string | null, profileId?: string, parameters?: true) => {
    if ('key' in event && event.key === 'F2' && onRename && featureId !== null) {
      event.preventDefault(); event.stopPropagation();
      beginRename(profileId === undefined ? { kind: 'feature', featureId } : { kind: 'profile', featureId, profileId }); return;
    }
    if ('key' in event && event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
    event.preventDefault(); event.stopPropagation();
    if (locked || selectionOnly || renameCurrent) return;
    event.currentTarget.focus();
    const bounds = event.currentTarget.getBoundingClientRect();
    const anchor = 'clientX' in event && (event.clientX || event.clientY) ? { x: event.clientX, y: event.clientY } : { x: bounds.left, y: bounds.bottom };
    setMenu({ document, featureId, profileId, parameters, anchor });
  };
  const menuFeature = menuCurrent?.featureId ? relationships.byId.get(menuCurrent.featureId) : undefined;
  const menuProfile = menuFeature?.kind === 'sketch' ? menuFeature.profiles.find(profile => profile.id === menuCurrent?.profileId) : undefined;
  const menuItems: CadContextMenuItem[] = [];
  if (menuCurrent?.parameters) menuItems.push(...(parameterMenu ?? []).map(item => ({ ...item, onSelect: () => {
    setTreeView(previous => previous.branches.has('parameters') ? previous : { ...previous, branches: new Set([...previous.branches, 'parameters']) });
    item.onSelect();
  } })));
  else if (menuCurrent?.featureId === null && onProperties) menuItems.push({ label: 'Properties', onSelect: () => onProperties(null) });
  if (menuFeature) {
    if (menuProfile && menuFeature.kind === 'sketch') {
      const sketch = menuFeature, profile = menuProfile;
      menuItems.push({ label: 'Configure profile', onSelect: () => onSelectProfile(sketch, profile.id) },
        { label: 'Edit sketch', onSelect: () => onEditSketch(sketch) });
      if (onCopyProfile && cadFeatureActive(sketch, document)) menuItems.push({ label: 'Copy outline to editable sketch', onSelect: () => onCopyProfile(sketch, profile.id) });
      if (onRename) menuItems.push({ label: 'Rename profile', onSelect: () => beginRename({ kind: 'profile', featureId: sketch.id, profileId: profile.id }) });
      if (onUpdateProfile) menuItems.push({ label: profile.construction ? 'Use as geometry' : 'Use as construction', onSelect: () => onUpdateProfile(sketch, { ...profile, construction: !profile.construction }) });
      if (onDeleteProfile) menuItems.push({ kind: 'separator' }, { label: 'Delete profile', danger: true, onSelect: () => onDeleteProfile(sketch, profile.id) });
    } else {
      const feature = menuFeature;
      menuItems.push(feature.kind === 'sketch' ? { label: 'Edit sketch', onSelect: () => onEditSketch(feature) }
        : feature.kind === 'curve' ? { label: 'Edit curve', onSelect: () => onEditCurve(feature) }
          : { label: 'Edit feature', onSelect: () => (onConfigure ?? (entry => onSelect(entry.id)))(feature) });
      if (feature.kind === 'sketch' && onChangeSketchPlane) menuItems.push({ label: 'Change sketch plane', help: 'Click the new plane in the design area.', onSelect: () => onChangeSketchPlane(feature) });
      if (feature.kind === 'datum-plane' && cadFeatureActive(feature, document) && onSectionView) menuItems.push({ label: 'Section view', help: 'Cut the model view by this plane.', onSelect: () => onSectionView({ kind: 'datum-plane', featureId: feature.id }) });
      if (onRename) menuItems.push({ label: 'Rename feature', onSelect: () => beginRename({ kind: 'feature', featureId: feature.id }) });
      const inputs = cadFeatureDependencies(feature).flatMap(id => { const source = relationships.byId.get(id); return source ? [source] : []; });
      if (relationships.children.get(feature.id)?.length || relationships.shared.get(feature.id)?.length || feature.kind === 'sketch' && feature.profiles.length) {
        menuItems.push({ label: expanded.has(feature.id) ? 'Collapse details' : 'Expand details', onSelect: () => toggle(feature.id) });
      }
      if (inputs.length) menuItems.push({ kind: 'separator' }, ...inputs.map(source => ({ label: `Select input · ${source.name}`, onSelect: () => onSelect(source.id) })));
      menuItems.push({ kind: 'separator' });
      if (onProperties) menuItems.push({ label: 'Properties', onSelect: () => onProperties(feature.id) });
      if (onSuppress) menuItems.push({ label: cadFeatureSuppressionFlag(feature) ? 'Resume feature' : 'Suppress feature', onSelect: () => onSuppress(feature, !cadFeatureSuppressionFlag(feature)) });
      if (onDelete) menuItems.push({ label: 'Delete feature', danger: true, onSelect: () => onDelete(feature) });
    }
  }
  /** A sketch or curve this feature uses that lives under an earlier feature: a link, not a second copy. */
  const sharedRow = (feature: CadFeature) => { const Icon = icons[feature.kind]; return <Button type="button" key={feature.id} className={`cad-tree-row cad-tree-shared${!cadFeatureActive(feature, document) ? ' is-suppressed' : ''}`}
    disabled={selectionDisabled(feature.id)} aria-label={`Select shared ${feature.name}`} title={`${featureLabels[feature.kind]} · ${feature.name} · shared with ${relationships.owner.get(feature.id)?.name ?? 'an earlier feature'}`} onClick={() => onSelect(feature.id)}>
    <Icon size={13} /><span className="cad-feature-name">{feature.name}</span><LinkIcon size={11} aria-hidden="true" />{!cadFeatureActive(feature, document) && <span className="cad-tree-muted">off</span>}
  </Button>; };
  const renderNode = (feature: CadFeature): ReactNode => {
    const Icon = icons[feature.kind], selected = selectedId === feature.id, position = relationships.position.get(feature.id) ?? 0;
    const nested = relationships.children.get(feature.id) ?? [], shared = relationships.shared.get(feature.id) ?? [];
    const missing = [...new Set(cadFeatureDependencies(feature))].filter(id => !relationships.byId.has(id));
    const profiles = feature.kind === 'sketch' ? feature.profiles : [];
    const profileSelected = selected && profiles.some(profile => profile.id === selectedProfileId);
    const content = sketchContent?.sketchId === feature.id ? sketchContent.content : null;
    const expandable = nested.length > 0 || shared.length > 0 || missing.length > 0 || profiles.length > 0 || content !== null;
    const open = expanded.has(feature.id), detailsId = `${treeId}-${position}`;
    const issue = issues.byFeature.get(feature.id), issueText = issue ? cadIssueRowText(issue, issueNames) : null;
    const failed = issue?.state === 'failed', blocked = issue?.state === 'blocked';
    const datumPlane = feature.kind === 'datum-plane', planeHovered = datumPlane && typeof hoveredReferencePlane === 'object' && hoveredReferencePlane?.featureId === feature.id;
    return <li key={feature.id} className={`cad-feature-node${highlightedFeatureIds.includes(feature.id) ? ' is-parameter-related' : ''}`} data-cad-feature-id={feature.id} data-cad-history-position={position}>
      <div className="cad-feature-history-row">
        {expandable ? <Button type="button" className="cad-feature-disclosure" disabled={locked || Boolean(renameCurrent)} aria-label={`${open ? 'Collapse' : 'Expand'} ${feature.name}`} aria-expanded={open} aria-controls={open ? detailsId : undefined} onClick={() => toggle(feature.id)}><ExpandRightIcon size={12} /></Button>
          : <span className="cad-feature-disclosure-placeholder" aria-hidden="true" />}
        {renameCurrent?.target.kind === 'feature' && renameCurrent.target.featureId === feature.id ? renameEditor(feature) : <Button type="button" className={`cad-tree-row${profileSelected ? ' is-context' : selected ? ' is-selected' : ''}${planeHovered ? ' is-hovered' : ''}${!cadFeatureActive(feature, document) ? ' is-suppressed' : ''}${failed ? ' has-error' : blocked ? ' is-blocked' : ''}`} disabled={selectionDisabled(feature.id)}
          onPointerEnter={datumPlane && cadFeatureActive(feature, document) ? () => onHoverReferencePlane?.({ kind: 'datum-plane', featureId: feature.id }) : undefined} onPointerLeave={datumPlane ? () => onHoverReferencePlane?.(null) : undefined}
          aria-label={`Select ${feature.name} in history`} aria-pressed={selected && !profileSelected} title={`${featureLabels[feature.kind]} · ${feature.name}${issueText ? ` · ${issueText}` : ''}`}
          onContextMenu={event => openMenu(event, feature.id)} onKeyDown={event => openMenu(event, feature.id)}
          onClick={() => onSelect(feature.id)} onDoubleClick={() => { if (selectionOnly) return; if (feature.kind === 'sketch') onEditSketch(feature); else if (feature.kind === 'curve') onEditCurve(feature); else onConfigure?.(feature); }}>
          <Icon size={14} /><span className="cad-feature-name">{feature.name}</span>
          {failed && <span className="cad-tree-error" aria-label={issueText!} data-cad-issue-code={issue.code}><WarningIcon size={12} /></span>}{blocked && <span className="cad-tree-blocked" aria-label={issueText!} data-cad-issue-code={issue.code}><InfoIcon size={12} /></span>}{!cadFeatureActive(feature, document) && <span className="cad-tree-muted">off</span>}
        </Button>}
      </div>
      {expandable && open && <div id={detailsId} className="cad-feature-details">
        {nested.length > 0 && <ol className="cad-feature-list cad-feature-nested" aria-label={`${feature.name} definition`}>{nested.map(renderNode)}</ol>}
        {shared.map(sharedRow)}
        {feature.kind === 'sketch' && feature.profiles.map(profile => {
          const ProfileIcon = profileIcons[profile.geometry.kind];
          return renameCurrent?.target.kind === 'profile' && renameCurrent.target.featureId === feature.id && renameCurrent.target.profileId === profile.id ? <div key={profile.id}>{renameEditor(feature, profile)}</div> : <Button type="button" key={profile.id} data-cad-profile-id={profile.id} className={`cad-tree-row cad-tree-profile${selected && selectedProfileId === profile.id ? ' is-selected' : ''}`} disabled={locked || selectionOnly || Boolean(renameCurrent)}
          aria-label={`${profile.name} profile`} aria-pressed={selected && selectedProfileId === profile.id} title={`${profile.construction ? 'Construction profile' : 'Closed profile'} · ${profile.name}`} onClick={() => onSelectProfile(feature, profile.id)}
          onContextMenu={event => openMenu(event, feature.id, profile.id)} onKeyDown={event => openMenu(event, feature.id, profile.id)}>
          <ProfileIcon size={11} /><span>{profile.name}</span>{profile.construction && <small>ref</small>}
        </Button>;
        })}
        {content}
        {missing.map(id => <Tooltip content={`Missing feature ${id}`} key={id}><span className="cad-feature-missing-reference">{id} (missing)</span></Tooltip>)}
      </div>}
    </li>;
  };
  return <><div className="cad-specification-tree" aria-label="Part specification tree">
    {/* The chevron folds the part; its name opens the part's Properties, where the name is edited. */}
    <div className="cad-tree-document-row">
      <Button type="button" className="cad-tree-document-toggle" disabled={locked || Boolean(renameCurrent)} aria-label={`${branches.has('part') ? 'Collapse' : 'Expand'} part ${document.name}`}
        aria-expanded={branches.has('part')} aria-controls={branches.has('part') ? `${treeId}-part` : undefined} onClick={() => toggleBranch('part')}>
        <ExpandRightIcon size={12} className="cad-tree-hierarchy-toggle" />
      </Button>
      <Button type="button" className="cad-tree-document" disabled={locked || Boolean(renameCurrent) || selectionOnly || !onProperties} aria-label={`Part ${document.name} properties`}
        title="Show the part name and summary" onClick={() => onProperties?.(null)} onContextMenu={event => openMenu(event, null)} onKeyDown={event => openMenu(event, null)}>
        <FileBodyIcon size={15} /><span>{document.name}</span>
      </Button>
    </div>
    {branches.has('part') && <div id={`${treeId}-part`} className="cad-tree-document-children">
      <Button type="button" className="cad-tree-branch" disabled={locked || Boolean(renameCurrent)} aria-label={`${branches.has('reference') ? 'Collapse' : 'Expand'} Reference`}
        aria-expanded={branches.has('reference')} aria-controls={branches.has('reference') ? `${treeId}-reference` : undefined} onClick={() => toggleBranch('reference')}>
        <ExpandRightIcon size={12} className="cad-tree-hierarchy-toggle" /><DatumPlaneIcon size={13} /><span>Reference</span>
      </Button>
      {branches.has('reference') && <ul id={`${treeId}-reference`} className="cad-reference-plane-list" aria-label="Reference planes">
        {(['XY', 'XZ', 'YZ'] satisfies CadPlane[]).map(plane => <li key={plane}><Button type="button" className={`cad-tree-row${selectedReferencePlane === plane ? ' is-selected' : ''}${hoveredReferencePlane === plane ? ' is-hovered' : ''}`} aria-label={`Select ${plane} plane`} aria-pressed={selectedReferencePlane === plane}
          onPointerEnter={() => onHoverReferencePlane?.(plane)} onPointerLeave={() => onHoverReferencePlane?.(null)}
          disabled={locked || selectionOnly && !allowPrincipalPlaneSelection || Boolean(renameCurrent) || !onSelectReferencePlane} onClick={() => onSelectReferencePlane?.(plane)}><DatumPlaneIcon size={12} /><span>{plane} plane</span></Button>{onCreateSketch && <Button type="button" disabled={locked || selectionOnly || Boolean(renameCurrent)}
          aria-label={`Create sketch on ${plane} plane`} title={`Create sketch on ${plane} plane`} onClick={() => onCreateSketch(plane)}><SketchIcon size={12} /></Button>}</li>)}
      </ul>}
      {parameterContent !== undefined && parameterContent !== null && parameterContent !== false && <>
        <Button type="button" className="cad-tree-branch" disabled={locked || Boolean(renameCurrent)} aria-label={`${branches.has('parameters') ? 'Collapse' : 'Expand'} Parameters`}
          onContextMenu={event => openMenu(event, null, undefined, true)} onKeyDown={event => openMenu(event, null, undefined, true)}
          aria-expanded={branches.has('parameters')} aria-controls={branches.has('parameters') ? `${treeId}-parameters` : undefined} onClick={() => toggleBranch('parameters')}>
          <ExpandRightIcon size={12} className="cad-tree-hierarchy-toggle" /><AdjustIcon size={13} /><span>Parameters</span>
        </Button>
        {/* Stays mounted while collapsed so its menu actions can open the editor. */}
        <div id={`${treeId}-parameters`} className="cad-tree-parameters" hidden={!branches.has('parameters')}>{parameterContent}</div>
      </>}
      <Button type="button" className="cad-tree-branch" disabled={locked || Boolean(renameCurrent)} aria-label={`${branches.has('model') ? 'Collapse' : 'Expand'} Body`} onContextMenu={event => openMenu(event, null)} onKeyDown={event => openMenu(event, null)}
        aria-expanded={branches.has('model')} aria-controls={branches.has('model') ? `${treeId}-model` : undefined} onClick={() => toggleBranch('model')}>
        <ExpandRightIcon size={12} className="cad-tree-hierarchy-toggle" /><LayersIcon size={13} /><span>Body</span><small aria-label={`${document.features.length} features`}>{document.features.length}</small>
      </Button>
      {branches.has('model') && <ol ref={tree} id={`${treeId}-model`} className="cad-feature-list cad-feature-history" aria-label="Feature history and dependencies">
    {document.features.filter(feature => !relationships.owner.has(feature.id)).map(renderNode)}
      </ol>}
    </div>}
  </div>{menuCurrent && menuItems.length > 0 && <CadContextMenu anchor={menuCurrent.anchor} title={menuCurrent.parameters ? 'Parameters' : menuProfile?.name ?? menuFeature?.name ?? 'Body'} items={menuItems} onClose={() => setMenu(null)} />}</>;
}
