import { memo, useMemo } from 'react';
import dagre from 'dagre';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Building2, User } from 'lucide-react';
import type { Employee } from './api';

/* Card geometry. The name plate overlaps the top of the body card and the avatar
 * overhangs the card by a few pixels, so the node box is a little taller than the
 * body and dagre is given room above each rank. */
const NODE_W = 244;
const NODE_H = 96;
const PLATE_TOP = 0;
const PLATE_H = 32;
const BODY_TOP = 15;

/* ------------------------------------------------------------------ */
/* Person card                                                         */
/* ------------------------------------------------------------------ */

interface PersonNodeData {
  employee: Employee;
  isRoot: boolean;
  [key: string]: unknown;
}

/** Two letters from the person's name, as a stand-in until photographs exist.
 *  The employee record carries no image field today, so the avatar is a reserved
 *  slot: swapping the initials for an <img> is the only change needed later. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const PersonCard = memo(({ data }: NodeProps): JSX.Element => {
  const { employee: e, isRoot } = data as PersonNodeData;
  const name = e.user.fullName ?? e.user.email;
  const role = e.designation?.name ?? e.employeeCode;
  const inactive = e.status !== 'active';

  return (
    <div
      className="group relative"
      style={{ width: NODE_W, height: NODE_H, opacity: inactive ? 0.62 : 1 }}
      title={`${name}${e.designation ? ` — ${e.designation.name}` : ''}${e.department ? `\n${e.department.name}` : ''}\nCode: ${e.employeeCode}`}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0, top: 0 }} />

      {/* Body — designation and unit */}
      <div
        className="absolute inset-x-0 bottom-0 rounded-xl border bg-card shadow-card transition-all duration-200 group-hover:-translate-y-0.5 group-hover:shadow-lg"
        style={{
          top: BODY_TOP,
          // Left undefined for everyone else so the card keeps the themed border
          // colour from the `border` utility rather than a hard-coded grey.
          borderColor: isRoot ? '#6d5dfc' : undefined,
          boxShadow: isRoot ? '0 0 0 1.5px rgba(109,93,252,0.35)' : undefined,
        }}
      >
        <div className="flex h-full flex-col justify-center gap-0.5 px-3 pb-2 pt-[22px] text-center">
          <p className="truncate text-[12.5px] font-semibold leading-tight text-foreground">{role}</p>
          {e.department ? (
            <p className="truncate text-[11px] leading-tight text-muted-foreground">
              <Building2 className="mr-0.5 inline size-3 align-[-2px]" />
              {e.department.name}
            </p>
          ) : (
            <p className="truncate text-[11px] italic leading-tight text-muted-foreground">Unassigned</p>
          )}
        </div>
      </div>

      {/* Name plate — sits across the top of the body card */}
      <div
        className="absolute flex items-center justify-center rounded-full px-3 shadow-sm"
        style={{
          top: PLATE_TOP,
          left: 12,
          right: 52,
          height: PLATE_H,
          background: isRoot ? 'linear-gradient(180deg,#6d5dfc 0%,#5646e0 100%)' : 'linear-gradient(180deg,#5b6577 0%,#454e5e 100%)',
        }}
      >
        <p className="truncate text-[12.5px] font-bold leading-none text-white">{name}</p>
      </div>

      {/* Photo slot — reserved. Initials stand in until images are stored. */}
      <div
        className="absolute flex items-center justify-center overflow-hidden rounded-full bg-muted text-[13px] font-bold text-muted-foreground"
        style={{
          top: -6,
          right: 2,
          width: 44,
          height: 44,
          border: '2px solid #ffffff',
          boxShadow: `0 0 0 2px ${isRoot ? '#6d5dfc' : '#46c2cb'}, 0 1px 3px rgba(16,24,40,0.18)`,
        }}
        aria-hidden
      >
        {name ? initials(name) : <User className="size-5" />}
      </div>

      {inactive ? (
        <span className="absolute -bottom-2 left-3 rounded-full bg-slate-500 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white shadow-sm">
          Inactive
        </span>
      ) : null}

      <Handle type="source" position={Position.Bottom} style={{ opacity: 0, bottom: 0 }} />
    </div>
  );
});
PersonCard.displayName = 'PersonCard';

const nodeTypes = { person: PersonCard };

/* ------------------------------------------------------------------ */

/** Org chart: dagre auto-layout. Solid edges = line management, dashed = matrix
 *  (dotted-line) managers. */
export function OrgChart({ employees }: { employees: Employee[] }): JSX.Element {
  const { nodes, edges } = useMemo(() => buildGraph(employees), [employees]);

  if (employees.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg border border-dashed border-border bg-muted/40 text-sm text-muted-foreground">
        No employees to chart yet.
      </div>
    );
  }

  return (
    <div className="h-[600px] w-full overflow-hidden rounded-lg border border-border bg-[#f7f8fb]">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.2}
        nodesDraggable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#d8dde8" />
        <MiniMap pannable zoomable nodeColor={() => '#c4cbde'} nodeStrokeWidth={0} />
        <Controls />
      </ReactFlow>
    </div>
  );
}

function buildGraph(employees: Employee[]): { nodes: Node[]; edges: Edge[] } {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: 'TB', nodesep: 44, ranksep: 88, marginx: 28, marginy: 28 });

  const ids = new Set(employees.map((e) => e.id));
  employees.forEach((e) => graph.setNode(e.id, { width: NODE_W, height: NODE_H }));

  // `pathOptions` is only declared on React Flow's built-in edge unions, not on the
  // generic `Edge`, but the renderer reads it off any edge (`'pathOptions' in edge`).
  const edges: (Edge & { pathOptions?: { borderRadius?: number } })[] = [];
  for (const e of employees) {
    if (e.lineManagerId && ids.has(e.lineManagerId)) {
      graph.setEdge(e.lineManagerId, e.id);
      edges.push({
        id: `l-${e.id}`,
        source: e.lineManagerId,
        target: e.id,
        // Orthogonal segments with a small radius on the turns: the shape a printed
        // org chart has, rather than a bezier swoop.
        type: 'smoothstep',
        pathOptions: { borderRadius: 6 },
        style: { stroke: '#7c8aa3', strokeWidth: 2.25 },
      });
    }
    for (const m of e.matrixManagers) {
      if (ids.has(m.id)) {
        edges.push({
          id: `m-${m.id}-${e.id}`,
          source: m.id,
          target: e.id,
          type: 'smoothstep',
          pathOptions: { borderRadius: 6 },
          style: { strokeDasharray: '7 5', stroke: '#46c2cb', strokeWidth: 2 },
        });
      }
    }
  }

  dagre.layout(graph);

  const nodes: Node[] = employees.map((e) => {
    const pos = graph.node(e.id) as { x: number; y: number };
    return {
      id: e.id,
      type: 'person',
      position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 },
      data: {
        employee: e,
        // "Root" = nobody above them in this chart. Highlighted so the top of the
        // organisation is findable at a glance.
        isRoot: !e.lineManagerId || !ids.has(e.lineManagerId),
      } as PersonNodeData,
      draggable: false,
      // Explicit dimensions so the MiniMap can draw node rects — it reads these,
      // not the measured size of the custom card.
      width: NODE_W,
      height: NODE_H,
    };
  });

  return { nodes, edges };
}
