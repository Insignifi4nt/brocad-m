import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { Button } from '@/components/ui/button';
import { ExpandRightIcon, SelectIcon, type WorkbenchDrawnIconComponent } from '@wire-edm/icons-react';
import type { CadDocument, CadScalar } from '@/domain/cad/cadDocument';
import type { CadSketchGraph, CadSketchGraphRelation } from '@/domain/cad/cadSketchGraph';
import { evaluateCadScalar } from '@/domain/cad/cadExpression';
import { cadSketchRelationPointIds } from '@/domain/cad/cadSketchGraphReferences';
import { measureCadSketchReferenceDimension } from '@/domain/cad/cadSketchReferenceDimensions';
import { CAD_SKETCH_VIRTUAL_LABELS } from '@/domain/cad/sketch-relations/cadSketchVirtualElements';
import { formatCadQuantity } from './cadDisplayQuantity';
import { cadSketchRelationHighlight, type CadSketchHighlightStore } from './cadSketchDimensionSelection';
import type { CadSketchGraphSelection } from './cadSketchGraphSelection';
import type { CadSketchIssue, CadSketchIssues } from './cadSketchIssues';
import { cadSketchRelationGlyphKind } from './cadSketchRelationGlyphLayout';
import { cadSketchRelationAxis, cadSketchRelationName, cadSketchRelationOperandLabels, createCadSketchRelationLabels, type CadSketchRelationLabels } from './cadSketchRelationNames';
import { CAD_SKETCH_RELATION_ICONS, CAD_SKETCH_RELATION_PRESENTATION } from './sketch-relations/cadSketchRelationPresentation';
import './cad-sketch-relation-list.css';

/** One relation as its tree row shows it, named once per accepted graph. */
export interface CadSketchRelationRow {
  readonly relation: CadSketchGraphRelation;
  /** "Parallel relation 3 · Line 1 and Line 2", as the constraint issues name it too. */
  readonly label: string;
  /** The name the row shows first, such as "Coincident with the V axis" for a point held on an axis. */
  readonly title: string;
  readonly operands: string;
  readonly icon: WorkbenchDrawnIconComponent;
}
interface RelationIndex { readonly labels: CadSketchRelationLabels; readonly rows: Map<string, CadSketchRelationRow>; readonly positions: ReadonlyMap<string, number> }
const indexes = new WeakMap<CadSketchGraph, RelationIndex>();
/** The derived index of one accepted graph: positions at once, row names as rows are first shown. Built once per graph. */
function relationIndex(graph: CadSketchGraph): RelationIndex {
  let index = indexes.get(graph);
  if (!index) { index = { labels: createCadSketchRelationLabels(graph), rows: new Map(), positions: new Map(graph.relations.map((relation, at) => [relation.id, at])) }; indexes.set(graph, index); }
  return index;
}
export function cadSketchRelationRow(graph: CadSketchGraph, relation: CadSketchGraphRelation): CadSketchRelationRow {
  const index = relationIndex(graph), kept = index.rows.get(relation.id);
  if (kept?.relation === relation) return kept;
  const name = cadSketchRelationName(graph, relation, index.labels.centres), operands = cadSketchRelationOperandLabels(graph, relation, index.labels)
    .join(relation.kind === 'axis-distance' ? ' → ' : ' and ');
  const axis = cadSketchRelationAxis(relation), glyph = cadSketchRelationGlyphKind(graph, relation, index.labels.centres);
  const row: CadSketchRelationRow = Object.freeze({ relation, label: `${name} relation ${(index.positions.get(relation.id) ?? 0) + 1} · ${operands}`,
    title: axis ? `Coincident with the ${CAD_SKETCH_VIRTUAL_LABELS[axis]}` : name, operands, icon: glyph ? CAD_SKETCH_RELATION_ICONS[glyph] : CAD_SKETCH_RELATION_PRESENTATION[relation.kind].icon });
  index.rows.set(relation.id, row);
  return row;
}

function quantity(value: CadScalar, parameters: CadDocument['parameters'], unit: 'mm' | 'deg' = 'mm') {
  try { return `${formatCadQuantity(evaluateCadScalar(value, parameters))}${unit === 'deg' ? '°' : ' mm'}`; } catch { return '—'; }
}
/** The value a dimension row shows: a distance from an axis by its size, a reference by what it measures now. */
export function cadSketchRelationRowQuantity(graph: CadSketchGraph, relation: CadSketchGraphRelation, parameters: CadDocument['parameters']): string | null {
  if (cadSketchRelationAxis(relation)) return null;
  switch (relation.kind) {
    case 'fixed-axis': {
      const value = relation.value;
      return typeof value === 'number' ? quantity(Math.abs(value), parameters) : quantity(value, parameters);
    }
    case 'distance': case 'point-line-distance': case 'axis-distance': case 'fillet-corner': case 'radial-size': return quantity(relation.value, parameters);
    case 'line-angle': return quantity(relation.value, parameters, 'deg');
    case 'chamfer-corner': return relation.values.map(value => quantity(value, parameters)).join(' / ');
    case 'reference-dimension': try { return `(${formatCadQuantity(measureCadSketchReferenceDimension(graph, parameters, relation))} mm)`; } catch { return '(—)'; }
    default: return null;
  }
}

export const CAD_SKETCH_RELATION_ROW_HEIGHT = 22;
const VISIBLE_ROWS = 12, OVERSCAN = 4;

export interface CadSketchRelationListProps {
  /** The accepted graph; the list never names a draft. */
  readonly graph: CadSketchGraph;
  readonly parameters: CadDocument['parameters'];
  readonly issues: CadSketchIssues;
  /** The relations drawn selected, by their marks or by their rows. */
  readonly selectedIds: readonly string[];
  /** The geometry selection; "Only the selection" lists the relations on its points. */
  readonly selection: readonly CadSketchGraphSelection[];
  readonly onlySelection: boolean;
  onOnlySelection(only: boolean): void;
  readonly locked: boolean;
  readonly highlight?: CadSketchHighlightStore;
  /** A row's relation becomes the selection, its mark too; `additive` adds or removes it. */
  onSelect(relation: CadSketchGraphRelation, additive: boolean): void;
  /** Double-click or Enter: a dimension's value editor, a pattern's editor, a generator's inputs, or the relation selected. */
  onOpen(relation: CadSketchGraphRelation): void;
  /** Delete or Backspace: the selected relations, or the focused row's when it is not selected. */
  onDelete(relation: CadSketchGraphRelation): void;
  onMenu(relation: CadSketchGraphRelation, at: { readonly clientX: number; readonly clientY: number }): void;
  /** A relation to scroll into view, with a token that changes on every request. */
  readonly reveal?: { readonly relationId: string | null; readonly token: string } | null;
  /** Whether the rows show. The list starts collapsed, so opening a sketch mounts no row; the workbench opens it on a reveal. */
  readonly expanded: boolean;
  onExpandedChange(expanded: boolean): void;
}

/**
 * The sketch's relations under it in the feature tree, every relation the canvas marks and those it cannot, as the canvas caps its marks
 * and some overlap. Collapsed, it is one heading with the count; expanded, rows render only where the list is scrolled, so a sketch with
 * hundreds of relations opens and scrolls like a small one.
 */
export const CadSketchRelationList = memo(function CadSketchRelationList({ expanded, ...props }: CadSketchRelationListProps) {
  const listId = useId(), toggle = useRef<HTMLButtonElement>(null);
  const { graph, selection, onlySelection, onOnlySelection, onExpandedChange } = props;
  return <div className="cad-sketch-relation-list" data-cad-sketch-relation-list="">
    <div className="cad-sketch-relation-list-heading">
      <Button ref={toggle} type="button" className="cad-sketch-relation-list-toggle" aria-expanded={expanded} aria-controls={expanded ? listId : undefined}
        title={expanded ? 'Hide the relations of this sketch' : 'List the relations of this sketch'} onClick={() => onExpandedChange(!expanded)}>
        <ExpandRightIcon size={10} />Relations <small aria-label={`${graph.relations.length} relations`}>{graph.relations.length}</small>
      </Button>
      {/* Inactive rather than disabled with nothing selected, so turning it off then keeps focus on it. */}
      {expanded && <Button type="button" size="icon" aria-label="Only the selection" aria-pressed={onlySelection} aria-disabled={!selection.length && !onlySelection || undefined}
        title="List only the relations on the selected points and edges" onClick={() => { if (selection.length || onlySelection) onOnlySelection(!onlySelection); }}><SelectIcon size={12} /></Button>}
    </div>
    {expanded && <CadSketchRelationRows {...props} id={listId} onEmpty={() => toggle.current?.focus({ preventScroll: true })} />}
  </div>;
});

/** The expanded list's rows. */
function CadSketchRelationRows({ id, graph, parameters, issues, selectedIds, selection, onlySelection, locked, highlight, onSelect, onOpen, onDelete, onMenu, reveal, onEmpty }:
  Omit<CadSketchRelationListProps, 'expanded'> & { readonly id: string; onEmpty(): void }) {
  const owner = useId(), scroller = useRef<HTMLDivElement>(null), shown = useRef<{ readonly graph: CadSketchGraph; readonly relation: CadSketchGraphRelation } | null>(null);
  const [scrollTop, setScrollTop] = useState(0), [focusId, setFocusId] = useState<string | null>(null), keyboardMove = useRef(false);
  // Where the focused row was, and whether the rows still hold focus though it fell to the page, as when that row's relation was deleted.
  const focusAt = useRef(0), holdsFocus = useRef(false);
  const relations = useMemo(() => {
    if (!onlySelection || !selection.length) return graph.relations;
    const points = new Set(selection.flatMap(pick => pick.kind === 'point' ? [pick.id] : graph.entities.filter(entity => entity.id === pick.id).flatMap(entity => entity.kind === 'line'
      ? [entity.startPointId, entity.endPointId] : entity.kind === 'arc' ? [entity.centerPointId, entity.startPointId, entity.endPointId] : [entity.centerPointId])));
    const entities = new Set(selection.filter(pick => pick.kind === 'entity').map(pick => pick.id));
    return graph.relations.filter(relation => cadSketchRelationPointIds(graph, relation).some(id => points.has(id)) || cadSketchRelationHighlight(graph, relation).entityIds.some(id => entities.has(id)));
  }, [graph, onlySelection, selection]);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const positions = useMemo(() => new Map(relations.map((relation, at) => [relation.id, at])), [relations]);
  const height = Math.max(1, Math.min(relations.length, VISIBLE_ROWS)) * CAD_SKETCH_RELATION_ROW_HEIGHT;
  const first = Math.max(0, Math.floor(scrollTop / CAD_SKETCH_RELATION_ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(relations.length, Math.ceil((scrollTop + height) / CAD_SKETCH_RELATION_ROW_HEIGHT) + OVERSCAN);
  const scrollTo = (at: number) => {
    const element = scroller.current; if (!element) return;
    const top = at * CAD_SKETCH_RELATION_ROW_HEIGHT;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + CAD_SKETCH_RELATION_ROW_HEIGHT > element.scrollTop + element.clientHeight) element.scrollTop = top + CAD_SKETCH_RELATION_ROW_HEIGHT - element.clientHeight;
    setScrollTop(element.scrollTop);
  };
  const revealed = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!reveal || revealed.current === reveal.token) return;
    revealed.current = reveal.token;
    const at = reveal.relationId ? relations.findIndex(relation => relation.id === reveal.relationId) : 0;
    if (at >= 0) scrollTo(at);
  }, [reveal, relations]);
  // The focused row's relation gone, as after Delete, the tab stop moves to the row that took its place, else the one before it, and focus
  // follows it if the deleted row held it; with no row left, focus goes to the heading.
  useLayoutEffect(() => {
    if (focusId === null || positions.has(focusId)) return;
    const at = Math.min(focusAt.current, relations.length - 1), next = relations[at];
    const lost = holdsFocus.current && (document.activeElement === null || document.activeElement === document.body);
    setFocusId(next?.id ?? null);
    if (!next) { holdsFocus.current = false; if (lost) onEmpty(); return; }
    focusAt.current = at;
    if (lost) { keyboardMove.current = true; scrollTo(at); }
  }, [positions, relations, focusId]);
  // A row the keyboard moves to takes focus once it renders, though the row it left may have scrolled out and taken focus with it.
  useLayoutEffect(() => {
    if (!focusId || !keyboardMove.current) return;
    const target = scroller.current?.querySelector<HTMLButtonElement>(`[data-cad-sketch-relation-row="${CSS.escape(focusId)}"]`);
    if (target) { keyboardMove.current = false; target.focus({ preventScroll: true }); }
  }, [focusId, first, last]);
  const hide = () => { if (shown.current) highlight?.hide(owner); shown.current = null; };
  const show = (relation: CadSketchGraphRelation, from = graph) => {
    shown.current = { graph: from, relation }; highlight?.show(owner, { kind: 'geometry', ...cadSketchRelationHighlight(from, relation), relationIds: [relation.id] });
  };
  // An edit elsewhere sends a hovered or focused row no leave: its highlight goes with a removed relation and follows one changed in place.
  useLayoutEffect(() => {
    const current = shown.current; if (!current || current.graph === graph) return;
    const relation = graph.relations.find(item => item.id === current.relation.id);
    if (relation) show(relation); else hide();
  });
  useEffect(() => () => highlight?.hide(owner), [highlight, owner]);
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>, relation: CadSketchGraphRelation, at: number) => {
    if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? relations.length - 1 : Math.max(0, Math.min(relations.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)));
      keyboardMove.current = true; setFocusId(relations[next]?.id ?? null); scrollTo(next);
    } else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); if (!locked) onDelete(relation); }
    else if (event.key === 'Enter') { event.preventDefault(); if (!locked) onOpen(relation); }
    else if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) {
      event.preventDefault(); event.stopPropagation();
      const box = event.currentTarget.getBoundingClientRect(); if (!locked) onMenu(relation, { clientX: box.left, clientY: box.bottom });
    }
  };
  const menu = (event: MouseEvent<HTMLButtonElement>, relation: CadSketchGraphRelation) => { event.preventDefault(); event.stopPropagation(); if (!locked) onMenu(relation, event); };
  const issueStates = (list: readonly CadSketchIssue[] | undefined) => list?.length ? [...new Set(list.map(issue => issue.state))] : null;
  // The tab stop is the focused row, else the first row in view, so it survives scrolling and a deleted row.
  const focusIndex = focusId === null ? undefined : positions.get(focusId);
  const stopId = focusIndex !== undefined && focusIndex >= first && focusIndex < last ? focusId : relations[first]?.id;
  // The rows in view, and the focused row though the list scrolled it out of view, which keeps focus rather than dropping it to the page.
  const rendered = Array.from({ length: Math.max(0, last - first) }, (_, offset) => first + offset);
  if (focusIndex !== undefined && (focusIndex < first || focusIndex >= last)) rendered.push(focusIndex);
  // Focus moving elsewhere ends the rows' hold on it; focus falling to the page because its row went does not. A row being removed can be
  // told blur while still in the page, so that case is decided once the render that removes it is done.
  const blurred = (event: FocusEvent<HTMLButtonElement>) => {
    hide();
    const related = event.relatedTarget, row = event.currentTarget;
    if (related instanceof Node) { if (!scroller.current?.contains(related)) holdsFocus.current = false; return; }
    queueMicrotask(() => { if (row.isConnected && document.activeElement !== row) holdsFocus.current = false; });
  };
  return relations.length === 0 ? <p id={id} className="cad-sketch-relation-list-empty">{onlySelection && selection.length ? 'Nothing constrains the selection.' : 'No relations yet.'}</p>
      : <div ref={scroller} id={id} className="cad-sketch-relation-list-scroller" style={{ height }} onScroll={event => setScrollTop(event.currentTarget.scrollTop)}>
        <ul aria-label="Sketch relations" style={{ height: relations.length * CAD_SKETCH_RELATION_ROW_HEIGHT }}>
          {rendered.map(at => {
            const relation = relations[at], row = cadSketchRelationRow(graph, relation), Icon = row.icon, states = issueStates(issues.byRelation.get(relation.id));
            const value = cadSketchRelationRowQuantity(graph, relation, parameters);
            // A pending edit leaves the rows in place, inactive, so the focused row keeps focus while its deletion is judged.
            return <li key={relation.id} aria-setsize={relations.length} aria-posinset={at + 1} style={{ top: at * CAD_SKETCH_RELATION_ROW_HEIGHT }}>
              <Button type="button" className={`cad-sketch-relation-row${selected.has(relation.id) ? ' is-selected' : ''}${states ? ' has-issues' : ''}`} data-cad-sketch-relation-row={relation.id}
                aria-label={[row.label, value, ...states ?? []].filter(Boolean).join(' · ')} aria-pressed={selected.has(relation.id)} aria-disabled={locked || undefined} tabIndex={stopId === relation.id ? 0 : -1}
                onFocus={() => { setFocusId(relation.id); focusAt.current = at; holdsFocus.current = true; show(relation); }} onBlur={blurred} onPointerEnter={() => show(relation)} onPointerLeave={hide}
                onClick={event => { if (!locked) onSelect(relation, event.shiftKey || event.ctrlKey || event.metaKey); }} onDoubleClick={() => { if (!locked) onOpen(relation); }}
                onKeyDown={event => keyDown(event, relation, at)} onContextMenu={event => menu(event, relation)}>
                <Icon size={12} /><span className="cad-sketch-relation-name">{row.title}</span><span className="cad-sketch-relation-operands">{row.operands}</span>
                {value && <span className="cad-sketch-relation-value">{value}</span>}{states && <small className="cad-sketch-relation-state">{states.join(', ')}</small>}
              </Button>
            </li>;
          })}
        </ul>
      </div>;
}
