import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dagre from 'dagre';
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Building,
  Building2,
  Boxes,
  ChevronDown,
  ChevronRight,
  Cpu,
  GraduationCap,
  Landmark,
  Maximize2,
  Megaphone,
  Minimize2,
  MonitorSmartphone,
  Network,
  Search,
  Server,
  ShieldCheck,
  TrendingUp,
  Users,
  Wallet,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { DepartmentNode } from './api';

const NODE_W = 268;
const NODE_H = 116;

/* ------------------------------------------------------------------ */
/* Visual mapping — icon + colour by department name / unit type.      */
/* ------------------------------------------------------------------ */

const NAME_ICONS: { test: RegExp; icon: LucideIcon }[] = [
  { test: /exec|office|leadership|board|c-?suite/i, icon: Building2 },
  { test: /eng|technolog|it\b|develop|software/i, icon: Cpu },
  { test: /back ?end|platform|infra|server|data/i, icon: Server },
  { test: /front ?end|web|ui|ux|design/i, icon: MonitorSmartphone },
  { test: /sales|revenue|business dev|bd\b/i, icon: TrendingUp },
  { test: /market|brand|growth|comm/i, icon: Megaphone },
  { test: /human|hr\b|people|talent|recruit/i, icon: Users },
  { test: /financ|account|payroll|treasur/i, icon: Wallet },
  { test: /legal|compliance|risk|audit|security/i, icon: ShieldCheck },
  { test: /academ|school|faculty|teach|educat/i, icon: GraduationCap },
  { test: /operation|ops|logistic|supply/i, icon: Boxes },
  { test: /gov|admin|registrar|policy/i, icon: Landmark },
];

function iconFor(dept: DepartmentNode): LucideIcon {
  for (const m of NAME_ICONS) if (m.test.test(dept.name)) return m.icon;
  switch (dept.unitType) {
    case 'division':
      return Building2;
    case 'team':
      return Network;
    default:
      return Building;
  }
}

interface Accent {
  bar: string;
  iconBg: string;
  iconFg: string;
  label: string;
}

// Colour by unit type (falls back to depth for anything unexpected) so the tree
// reads as a system: divisions indigo, departments teal, teams amber, units rose.
const ACCENTS: Record<string, Accent> = {
  division: { bar: '#6d5dfc', iconBg: 'rgba(109,93,252,0.12)', iconFg: '#6d5dfc', label: 'Division' },
  department: { bar: '#46c2cb', iconBg: 'rgba(70,194,203,0.14)', iconFg: '#2f9aa3', label: 'Department' },
  team: { bar: '#f5a524', iconBg: 'rgba(245,165,36,0.16)', iconFg: '#e08a00', label: 'Team' },
  unit: { bar: '#fb7185', iconBg: 'rgba(251,113,133,0.14)', iconFg: '#e11d48', label: 'Unit' },
};
const DEPTH_ACCENTS = ['#6d5dfc', '#46c2cb', '#f5a524', '#fb7185', '#8b7dff', '#10b981'];

function accentFor(dept: DepartmentNode, depth: number): Accent {
  return (
    ACCENTS[dept.unitType] ?? {
      bar: DEPTH_ACCENTS[depth % DEPTH_ACCENTS.length],
      iconBg: 'rgba(100,116,139,0.12)',
      iconFg: '#475569',
      label: dept.unitType,
    }
  );
}

/** Filter sentinel for units belonging to no campus. Not a campus name, so it cannot
 *  collide with one. */
const NO_CAMPUS = '\u0000none';

/* ------------------------------------------------------------------ */
/* Custom node card.                                                   */
/* ------------------------------------------------------------------ */

interface DeptNodeData {
  dept: DepartmentNode;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
  hiddenCount: number; // descendants hidden while collapsed
  matched: boolean;
  dimmed: boolean;
  onToggle: (id: string) => void;
  onOpen: (dept: DepartmentNode) => void;
  [key: string]: unknown;
}

const DeptCard = memo(({ data }: NodeProps): JSX.Element => {
  const d = data as DeptNodeData;
  const { dept, depth, hasChildren, collapsed, hiddenCount, matched, dimmed } = d;
  const accent = accentFor(dept, depth);
  const Icon = iconFor(dept);

  return (
    <div
      onClick={() => d.onOpen(dept)}
      className="group relative cursor-pointer rounded-xl border bg-card text-left shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg"
      style={{
        width: NODE_W,
        height: NODE_H,
        borderColor: matched ? accent.bar : 'var(--border, #e3e6f0)',
        boxShadow: matched ? `0 0 0 2px ${accent.bar}` : undefined,
        opacity: dimmed ? 0.35 : 1,
      }}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0, top: 0 }} />
      {/* accent bar */}
      <div className="absolute inset-x-0 top-0 h-1.5 rounded-t-xl" style={{ background: accent.bar }} />

      <div className="flex h-full flex-col gap-1.5 p-3 pt-4">
        <div className="flex items-start gap-2.5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg" style={{ background: accent.iconBg, color: accent.iconFg }}>
            <Icon className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-bold leading-tight" title={dept.name}>{dept.name}</p>
            <span className="mt-0.5 inline-block rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide" style={{ background: accent.iconBg, color: accent.iconFg }}>
              {accent.label}
            </span>
          </div>
          <span
            className="flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground"
            title={`${dept.employeeCount} direct · ${dept.totalEmployeeCount} incl. sub-units`}
          >
            <Users className="size-3" />
            {dept.employeeCount}
          </span>
        </div>

        <div className="mt-auto min-w-0">
          {/* Campus, when the unit has one. Org-wide units have none and say nothing —
              an explicit "no campus" line would be noise on 14 of 36 units here. */}
          {dept.campusName ? (
            <p className="truncate text-[11px] text-muted-foreground" title={`Campus: ${dept.campusName}`}>
              <Building2 className="mr-0.5 inline size-3" />
              {dept.campusName}
            </p>
          ) : null}
          {dept.hodName ? (
            <p className="truncate text-xs" title={`${dept.hodName} — ${dept.hodDesignation ?? ''}`}>
              <span className="font-medium text-foreground">{dept.hodName}</span>
              {dept.hodDesignation ? <span className="text-muted-foreground"> · {dept.hodDesignation}</span> : null}
            </p>
          ) : (
            <p className="truncate text-xs italic text-muted-foreground">No head assigned</p>
          )}
          {dept.totalEmployeeCount !== dept.employeeCount ? (
            <p className="text-[11px] text-muted-foreground">{dept.totalEmployeeCount} people incl. sub-units</p>
          ) : null}
        </div>
      </div>

      {hasChildren ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            d.onToggle(dept.id);
          }}
          className="nodrag nopan absolute -bottom-3 left-1/2 flex size-6 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm transition-colors hover:text-foreground"
          title={collapsed ? `Expand (${hiddenCount} hidden)` : 'Collapse'}
          aria-label={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
        </button>
      ) : null}
      {collapsed && hiddenCount > 0 ? (
        <span className="absolute -bottom-3 left-[calc(50%+16px)] rounded-full bg-brand px-1.5 py-0.5 text-[10px] font-bold text-white shadow-sm">
          +{hiddenCount}
        </span>
      ) : null}

      <Handle type="source" position={Position.Bottom} style={{ opacity: 0, bottom: 0 }} />
    </div>
  );
});
DeptCard.displayName = 'DeptCard';

const nodeTypes = { dept: DeptCard };

/* ------------------------------------------------------------------ */
/* Tree flattening + layout.                                           */
/* ------------------------------------------------------------------ */

function countDescendants(node: DepartmentNode): number {
  return node.children.reduce((sum, c) => sum + 1 + countDescendants(c), 0);
}

/** Ids of every ancestor of any node whose name/HOD matches the query. */
function ancestorsOfMatches(roots: DepartmentNode[], matches: Set<string>): Set<string> {
  const keep = new Set<string>();
  const walk = (node: DepartmentNode, trail: string[]): void => {
    const nextTrail = [...trail, node.id];
    if (matches.has(node.id)) trail.forEach((id) => keep.add(id));
    node.children.forEach((c) => walk(c, nextTrail));
  };
  roots.forEach((r) => walk(r, []));
  return keep;
}

interface FlatNode {
  dept: DepartmentNode;
  depth: number;
  collapsed: boolean;
  hasChildren: boolean;
  hiddenCount: number;
}

function flatten(
  roots: DepartmentNode[],
  collapsed: Set<string>,
  forceExpand: Set<string>,
): { flat: FlatNode[]; edges: { from: string; to: string }[] } {
  const flat: FlatNode[] = [];
  const edges: { from: string; to: string }[] = [];
  const walk = (node: DepartmentNode, depth: number, parentId: string | null): void => {
    const hasChildren = node.children.length > 0;
    const isCollapsed = hasChildren && collapsed.has(node.id) && !forceExpand.has(node.id);
    if (parentId) edges.push({ from: parentId, to: node.id });
    flat.push({
      dept: node,
      depth,
      collapsed: isCollapsed,
      hasChildren,
      hiddenCount: isCollapsed ? countDescendants(node) : 0,
    });
    if (!isCollapsed) node.children.forEach((c) => walk(c, depth + 1, node.id));
  };
  roots.forEach((r) => walk(r, 0, null));
  return { flat, edges };
}

function layout(flat: FlatNode[], rawEdges: { from: string; to: string }[]): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'TB', nodesep: 46, ranksep: 96, marginx: 24, marginy: 24 });
  flat.forEach((f) => g.setNode(f.dept.id, { width: NODE_W, height: NODE_H }));
  rawEdges.forEach((e) => g.setEdge(e.from, e.to));
  dagre.layout(g);

  const nodes: Node[] = flat.map((f) => {
    const p = g.node(f.dept.id) as { x: number; y: number };
    return {
      id: f.dept.id,
      type: 'dept',
      position: { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 },
      data: {} as DeptNodeData, // filled by caller (keeps callbacks/state fresh)
      draggable: false,
      // Explicit dimensions so the MiniMap can draw node rects (it reads these,
      // not the measured size of the custom card).
      width: NODE_W,
      height: NODE_H,
      _flat: f,
    } as Node & { _flat: FlatNode };
  });

  const edges: Edge[] = rawEdges.map((e) => ({
    id: `${e.from}-${e.to}`,
    source: e.from,
    target: e.to,
    type: 'smoothstep',
    style: { stroke: '#c4cbde', strokeWidth: 1.5 },
  }));

  return { nodes, edges };
}

/* ------------------------------------------------------------------ */
/* Persist expand/collapse across mounts (tab switches) within session.*/
/* ------------------------------------------------------------------ */
let SAVED_COLLAPSED: string[] | null = null;

/* ------------------------------------------------------------------ */
/* Main chart (inner — needs ReactFlowProvider for useReactFlow).      */
/* ------------------------------------------------------------------ */

function ChartInner({ roots, onOpen }: { roots: DepartmentNode[]; onOpen: (d: DepartmentNode) => void }): JSX.Element {
  const rf = useReactFlow();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(SAVED_COLLAPSED ?? []));
  const [query, setQuery] = useState('');
  // '' = every campus. NO_CAMPUS isolates the org-wide units, which is a real question
  // to ask of this data: here 14 of 36 units belong to no campus at all.
  const [campus, setCampus] = useState('');
  const [isFull, setIsFull] = useState(false);

  useEffect(() => {
    SAVED_COLLAPSED = [...collapsed];
  }, [collapsed]);

  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** Campus names present anywhere in the tree, for the filter. */
  const campusOptions = useMemo(() => {
    const set = new Set<string>();
    let anyUnassigned = false;
    const walk = (n: DepartmentNode): void => {
      if (n.campusName) set.add(n.campusName);
      else anyUnassigned = true;
      n.children.forEach(walk);
    };
    roots.forEach(walk);
    return { names: [...set].sort((a, b) => a.localeCompare(b)), anyUnassigned };
  }, [roots]);

  // Matches + forced ancestor expansion for search.
  const q = query.trim().toLowerCase();
  // Either filter narrows the chart; together they intersect.
  const filtering = q.length > 0 || campus.length > 0;
  const matches = useMemo(() => {
    const set = new Set<string>();
    if (!filtering) return set;
    const walk = (n: DepartmentNode): void => {
      const hay = `${n.name} ${n.hodName ?? ''} ${n.hodDesignation ?? ''}`.toLowerCase();
      const okQuery = !q || hay.includes(q);
      const okCampus = !campus || (campus === NO_CAMPUS ? !n.campusName : n.campusName === campus);
      if (okQuery && okCampus) set.add(n.id);
      n.children.forEach(walk);
    };
    roots.forEach(walk);
    return set;
  }, [roots, q, campus, filtering]);
  /*
   * Ancestors of a match stay VISIBLE rather than being filtered out. That is not a
   * compromise, it is what this data requires: a unit's campus can differ from its
   * parent's (12 of 22 parent/child pairs here), so hiding non-matching ancestors would
   * detach matching units from the tree they actually hang off. Matches are highlighted,
   * everything else is dimmed — the same behaviour search already had.
   */
  const forceExpand = useMemo(() => (filtering ? ancestorsOfMatches(roots, matches) : new Set<string>()), [roots, matches, filtering]);

  const { nodes, edges } = useMemo(() => {
    const { flat, edges: rawEdges } = flatten(roots, collapsed, forceExpand);
    const laid = layout(flat, rawEdges);
    const nodes = laid.nodes.map((n) => {
      const f = (n as Node & { _flat: FlatNode })._flat;
      const data: DeptNodeData = {
        dept: f.dept,
        depth: f.depth,
        hasChildren: f.hasChildren,
        collapsed: f.collapsed,
        hiddenCount: f.hiddenCount,
        matched: matches.has(f.dept.id),
        dimmed: filtering && !matches.has(f.dept.id),
        onToggle: toggle,
        onOpen,
      };
      return { ...n, data };
    });
    return { nodes, edges: laid.edges };
  }, [roots, collapsed, forceExpand, matches, filtering, toggle, onOpen]);

  // Fit the view when the visible set changes; when searching, fit to matches.
  const nodeIdsKey = nodes.map((n) => n.id).join(',');
  useEffect(() => {
    const t = setTimeout(() => {
      const target = filtering ? nodes.filter((n) => matches.has(n.id)) : undefined;
      rf.fitView({ padding: 0.2, duration: 400, ...(target && target.length ? { nodes: target } : {}) });
    }, 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeIdsKey, q, campus]);

  const expandAll = useCallback(() => setCollapsed(new Set()), []);
  const collapseAll = useCallback(() => {
    // collapse every node that has children
    const set = new Set<string>();
    const walk = (n: DepartmentNode): void => {
      if (n.children.length) {
        set.add(n.id);
        n.children.forEach(walk);
      }
    };
    roots.forEach(walk);
    // keep roots visible: remove root ids so their children still hide but roots render
    setCollapsed(set);
  }, [roots]);

  const toggleFullscreen = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      el.requestFullscreen?.().then(() => setIsFull(true)).catch(() => undefined);
    } else {
      document.exitFullscreen?.().then(() => setIsFull(false)).catch(() => undefined);
    }
  }, []);
  useEffect(() => {
    const onFs = (): void => setIsFull(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  return (
    <div ref={wrapRef} className="relative h-[640px] w-full overflow-hidden rounded-xl border border-border bg-muted/20">
      {/* Node position transitions give expand/collapse a smooth feel (viewport
          pan/zoom uses a different element, so it stays snappy). */}
      <style>{`.react-flow__node { transition: transform 300ms ease, opacity 200ms ease; }`}</style>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.15}
        maxZoom={1.75}
        nodesDraggable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={22} color="#e6e9f2" />
        <MiniMap
          pannable
          zoomable
          nodeStrokeWidth={2}
          nodeColor={(n) => {
            const data = n.data as unknown as DeptNodeData;
            return accentFor(data.dept, data.depth).bar;
          }}
          className="!bottom-3 !right-3 hidden rounded-lg border border-border sm:block"
        />
        <Controls showInteractive={false} className="!bottom-3 !left-3 rounded-lg border border-border" />

        <Panel position="top-left" className="!m-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search department or head…"
              className="h-9 w-64 rounded-lg border border-input bg-card pl-8 pr-8 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            {query ? (
              <button onClick={() => setQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label="Clear search">
                <X className="size-4" />
              </button>
            ) : null}
          </div>
          {campusOptions.names.length > 0 || campusOptions.anyUnassigned ? (
            <select
              value={campus}
              onChange={(e) => setCampus(e.target.value)}
              title="Show only units at one campus"
              className="mt-2 h-9 w-64 rounded-lg border border-input bg-card px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">All campuses</option>
              {campusOptions.names.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
              {campusOptions.anyUnassigned ? <option value={NO_CAMPUS}>No campus assigned</option> : null}
            </select>
          ) : null}
          {filtering ? (
            <div className="mt-1 rounded-md bg-card/90 px-2 py-1 text-xs text-muted-foreground shadow-sm">
              {matches.size} match{matches.size === 1 ? '' : 'es'}
              {campus ? ` · ${campus === NO_CAMPUS ? 'no campus' : campus}` : ''}
            </div>
          ) : null}
        </Panel>

        <Panel position="top-right" className="!m-3 flex gap-2">
          <button onClick={expandAll} className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium shadow-sm hover:bg-muted">Expand all</button>
          <button onClick={collapseAll} className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium shadow-sm hover:bg-muted">Collapse</button>
          <button onClick={() => rf.fitView({ padding: 0.2, duration: 400 })} className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium shadow-sm hover:bg-muted">Fit</button>
          <button
            onClick={toggleFullscreen}
            className="flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium shadow-sm hover:bg-muted"
            title={isFull ? 'Exit full screen' : 'Full screen'}
          >
            {isFull ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
            {isFull ? 'Exit' : 'Full screen'}
          </button>
        </Panel>
      </ReactFlow>
    </div>
  );
}

export function DepartmentOrgChart({ roots, onOpen }: { roots: DepartmentNode[]; onOpen: (d: DepartmentNode) => void }): JSX.Element {
  if (roots.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg border border-dashed border-border bg-muted/40 text-sm text-muted-foreground">
        No departments to chart yet. Add units under the Departments tab.
      </div>
    );
  }
  return (
    <ReactFlowProvider>
      <ChartInner roots={roots} onOpen={onOpen} />
    </ReactFlowProvider>
  );
}
