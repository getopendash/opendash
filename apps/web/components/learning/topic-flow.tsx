"use client";

import "@xyflow/react/dist/base.css";
import { Button, Tooltip } from "@heroui/react";
import type { TopicGraph } from "@opendash/core";
import {
  type Edge,
  type EdgeProps,
  getBezierPath,
  Handle,
  type Node,
  type NodeProps,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import { Maximize, Minus, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { createContext, useContext, useMemo, useState } from "react";
import { extentOf, type FlowNodeData, layoutTopicFlow } from "@/lib/topic-flow";

type TopicNode = Node<FlowNodeData, "topic">;
type TopicEdge = Edge<{ label: string | null; isnt: boolean }, "topic">;

/** What the pointer is on, and what's next to it: everything else dims. */
const Focus = createContext<{ on: string | null; near: Set<string> }>({ on: null, near: new Set() });

const TONE: Record<FlowNodeData["tone"], string> = {
  term: "border-accent bg-accent-soft",
  isnt: "border-danger bg-surface-secondary",
  learned: "border-border bg-surface-tertiary",
  plain: "border-border bg-surface-secondary",
};

function TopicNodeView({ id, data }: NodeProps<TopicNode>) {
  const focus = useContext(Focus);
  const dim = focus.on !== null && focus.on !== id && !focus.near.has(id);
  return (
    <Tooltip delay={250} closeDelay={0}>
      {/* The trigger fills the node, so the box is the node's full size and edges meet its sides. */}
      <Tooltip.Trigger className="block h-full w-full">
        <div
          className={`flex h-full w-full flex-col justify-center gap-0.5 rounded-xl border px-3 py-2 transition-opacity ${TONE[data.tone]} ${
            data.href ? "cursor-pointer hover:border-accent" : ""
          } ${dim ? "opacity-35" : ""}`}
        >
          <Handle type="target" position={Position.Left} isConnectable={false} className="invisible" />
          <span className={`truncate text-micro ${data.tone === "isnt" ? "text-danger" : "text-muted"}`}>
            {data.label}
          </span>
          <span className={`line-clamp-2 break-words text-body ${data.tone === "term" ? "font-medium" : ""}`}>
            {data.title}
          </span>
          {data.sub ? <span className="truncate text-small text-muted">{data.sub}</span> : null}
          <Handle type="source" position={Position.Right} isConnectable={false} className="invisible" />
        </div>
      </Tooltip.Trigger>
      <Tooltip.Content>
        <span className="flex max-w-xs flex-col gap-0.5">
          <span className="font-medium">{data.full}</span>
          {data.detail ? <span>{data.detail}</span> : null}
          {data.href ? <span className="text-muted">Click to open</span> : null}
        </span>
      </Tooltip.Content>
    </Tooltip>
  );
}

function TopicEdgeView({ id, source, target, sourceX, sourceY, targetX, targetY, data }: EdgeProps<TopicEdge>) {
  const focus = useContext(Focus);
  const lit = focus.on !== null && (focus.on === source || focus.on === target);
  const dim = focus.on !== null && !lit;
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition: Position.Right,
    targetX,
    targetY,
    targetPosition: Position.Left,
  });
  const tone = data?.isnt ? "stroke-danger" : lit ? "stroke-accent" : "stroke-border";
  return (
    <g className={`transition-opacity ${dim ? "opacity-25" : ""}`}>
      <path
        id={id}
        d={path}
        fill="none"
        strokeWidth={lit ? 1.75 : 1.25}
        strokeDasharray={data?.isnt ? "5 4" : undefined}
        className={tone}
      />
      {data?.label ? (
        <text
          x={labelX}
          y={labelY + 4}
          textAnchor="middle"
          paintOrder="stroke"
          strokeWidth={4}
          strokeLinejoin="round"
          className={`stroke-surface text-micro ${data.isnt ? "fill-danger" : "fill-muted"}`}
        >
          {data.label}
        </text>
      ) : null}
    </g>
  );
}

const nodeTypes = { topic: TopicNodeView };
const edgeTypes = { topic: TopicEdgeView };

function Zoom() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  return (
    <Panel position="top-right" className="flex gap-1">
      <Button size="sm" variant="ghost" isIconOnly aria-label="Zoom in" onPress={() => zoomIn({ duration: 150 })}>
        <Plus className="size-3.5" aria-hidden />
      </Button>
      <Button size="sm" variant="ghost" isIconOnly aria-label="Zoom out" onPress={() => zoomOut({ duration: 150 })}>
        <Minus className="size-3.5" aria-hidden />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        isIconOnly
        aria-label="Fit it all in"
        onPress={() => fitView({ duration: 200, padding: 0.12 })}
      >
        <Maximize className="size-3.5" aria-hidden />
      </Button>
    </Panel>
  );
}

/** Its frame's height, in steps, from the drawing's own (so a small one isn't lost in a tall frame). */
const frame = (height: number) => (height <= 220 ? "h-72" : height <= 320 ? "h-96" : height <= 440 ? "h-120" : "h-140");

/**
 * A topic's diagram, drawn with React Flow and laid out by dagre: how it was learned, the term, what it
 * means and the tables it isn't, and what's on that table. Hover a box for its whole name and what it is, and to see
 * what it's joined to; click to open it. The wheel scrolls the page; the buttons zoom.
 */
export function TopicFlow({ graph }: { graph: TopicGraph }) {
  const router = useRouter();
  // React Flow marks its root "light" or "dark", which are the theme's own classes too: it must say the app's theme,
  // or everything inside it takes the other theme's tokens.
  const { resolvedTheme } = useTheme();
  const laid = useMemo(() => layoutTopicFlow(graph), [graph]);
  const [on, setOn] = useState<string | null>(null);
  const near = useMemo(
    () => new Set(laid.edges.flatMap((e) => (e.source === on ? [e.target] : e.target === on ? [e.source] : []))),
    [laid.edges, on],
  );
  if (laid.nodes.length < 2) return null;
  const extent = extentOf(laid.nodes);
  return (
    <div className={`${frame(extent.height)} w-full rounded-xl border border-border bg-surface`}>
      {resolvedTheme ? (
        <ReactFlowProvider>
          <Focus.Provider value={{ on, near }}>
            <ReactFlow<TopicNode, TopicEdge>
              colorMode={resolvedTheme === "dark" ? "dark" : "light"}
              nodes={laid.nodes}
              edges={laid.edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              fitView
              fitViewOptions={{ padding: 0.12, maxZoom: 1 }}
              minZoom={0.3}
              maxZoom={1.5}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              zoomOnScroll={false}
              zoomOnDoubleClick={false}
              panOnScroll={false}
              preventScrolling={false}
              proOptions={{ hideAttribution: true }}
              onNodeMouseEnter={(_, n) => setOn(n.id)}
              onNodeMouseLeave={() => setOn(null)}
              onNodeClick={(_, n) => {
                if (!n.data.href) return;
                if (n.data.href.startsWith("#")) window.location.hash = n.data.href;
                else router.push(n.data.href);
              }}
            >
              <Zoom />
            </ReactFlow>
          </Focus.Provider>
        </ReactFlowProvider>
      ) : null}
    </div>
  );
}
