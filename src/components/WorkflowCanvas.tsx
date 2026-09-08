import { useEffect, useMemo, useRef, useState } from "react";
import * as ipc from "../ipc";
import { AGENT_CLIS, type AgentConfigField } from "../projects";
import {
  WORKFLOW_TRIGGER_CATALOG,
  type WorkflowAgentBlock,
  type WorkflowAgentStep,
  type WorkflowDefinition,
  type WorkflowStep,
  type WorkflowTriggerKind,
} from "../workflowDefinition";
import { modelChoicesFor, workflowAgentType } from "../workflowAgents";
import { loadWorkflowAgentLibrary } from "../workflowAgentLibrary";
import type { WorkflowRunDetail } from "../workflowRun";
import { Button, Select, TextInput } from "./ui";
import { AgentIcon } from "./icons";

interface WorkflowCanvasProps {
  definition: WorkflowDefinition;
  run?: WorkflowRunDetail | null;
  projectRoot: string;
  onChange: (definition: WorkflowDefinition) => void;
}

const NODE_W = 220;
const NODE_H = 112;
const WIRED_TRIGGERS: WorkflowTriggerKind[] = [
  "manual", "pr.comment", "issue.opened", "issue.updated", "issue.closed",
  "issue.reopened", "issue.comment",
];
const pointFor = (definition: WorkflowDefinition, id: string, index: number) =>
  definition.canvas?.nodes[id] ?? { x: 100 + index * 270, y: 150 };
const titleFor = (step: WorkflowStep) => step.name || step.id;
const positiveOutcome = (step: WorkflowStep) =>
  step.kind === "human" ? step.card.actions[0]?.response ?? "approve"
    : step.kind === "gate" || step.kind === "watch" ? "pass" : "success";
const newId = (prefix: string, held: readonly string[]) => {
  let index = 1;
  while (held.includes(`${prefix}-${index}`)) index += 1;
  return `${prefix}-${index}`;
};

export function WorkflowCanvas({ definition, run, projectRoot, onChange }: WorkflowCanvasProps) {
  const surface = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [linking, setLinking] = useState<{
    from: string; startX: number; startY: number; x: number; y: number;
  } | null>(null);
  const [profiles, setProfiles] = useState<ipc.AgentProfile[]>([]);
  const [libraryAgents, setLibraryAgents] = useState<WorkflowAgentBlock[]>([]);
  const [libraryError, setLibraryError] = useState("");
  const viewport = definition.canvas?.viewport ?? { x: 0, y: 0, zoom: 1 };
  const nodes = definition.canvas?.nodes ?? {};

  useEffect(() => { void ipc.profilesList().then(setProfiles).catch(() => setProfiles([])); }, []);
  useEffect(() => {
    void loadWorkflowAgentLibrary(projectRoot).then((result) => {
      setLibraryAgents(result.agents);
      setLibraryError(result.errors[0] ?? "");
    });
  }, [projectRoot]);

  const visibleAgents = useMemo(() => {
    const merged = new Map(libraryAgents.map((agent) => [agent.id, agent]));
    for (const agent of definition.agents ?? []) merged.set(agent.id, agent);
    return [...merged.values()];
  }, [definition.agents, libraryAgents]);

  const patch = (next: Partial<WorkflowDefinition>) => onChange({ ...definition, ...next });
  const patchCanvas = (
    nextNodes = nodes,
    nextViewport = viewport,
  ) => patch({ canvas: { nodes: nextNodes, viewport: nextViewport } });
  const position = (id: string, index: number) => pointFor(definition, id, index);
  const setPosition = (id: string, value: { x: number; y: number }) =>
    patchCanvas({ ...nodes, [id]: value });

  const updateAgent = (id: string, values: Partial<WorkflowAgentBlock>) => {
    const current = visibleAgents.find((agent) => agent.id === id);
    if (!current) return;
    const next = { ...current, ...values };
    patch({ agents: [
      ...(definition.agents ?? []).filter((agent) => agent.id !== id),
      next,
    ] });
  };
  const updateAgentConfig = (agent: WorkflowAgentBlock, key: string, value: string) => {
    const config = { ...(agent.config ?? {}) };
    if (value) config[key] = value;
    else delete config[key];
    updateAgent(agent.id, { config: Object.keys(config).length > 0 ? config : undefined });
  };
  const updateStep = (id: string, values: Partial<WorkflowStep>) => {
    patch({ steps: definition.steps.map((step) =>
      step.id === id ? { ...step, ...values } as WorkflowStep : step) });
  };
  const updateTrigger = (index: number, kind: WorkflowTriggerKind) => {
    patch({ triggers: definition.triggers.map((trigger, at) => at === index ? { kind } : trigger) });
  };

  const addAgentBlock = () => {
    const held = (definition.agents ?? []).map((agent) => agent.id);
    const id = newId("agent", held);
    const agent: WorkflowAgentBlock = {
      id,
      name: `Agent ${held.length + 1}`,
      type: AGENT_CLIS[0]?.id ?? "inherit",
      prompt: "",
    };
    patch({ agents: [...(definition.agents ?? []), agent] });
    setSelected(`agentlib:${id}`);
  };

  const addStep = (kind: "agent" | "human" | "gate", at: { x: number; y: number }, agent?: string) => {
    const ids = definition.steps.map((step) => step.id);
    const id = newId(kind, ids);
    let step: WorkflowStep;
    if (kind === "agent") {
      step = {
        id, name: "Agent task", kind, agent,
        prompt: "Describe what this agent should do.",
        capabilities: ["workspace-read"],
      };
    } else if (kind === "human") {
      step = {
        id, name: "Decision", kind, capabilities: [],
        card: {
          reason: "choice", title: "Choose the next path",
          actions: [
            { label: "Continue", response: "continue", tone: "primary" },
            { label: "Stop", response: "stop", tone: "danger" },
          ],
        },
      };
    } else {
      const evidence = definition.steps.find((candidate) => candidate.kind === "agent");
      if (!evidence) return;
      step = {
        id, name: "Evidence gate", kind, capabilities: [],
        evidence: { stepId: evidence.id, predicate: "attempt.completed" },
      };
    }
    const edges = [
      ...definition.edges,
      { from: id, on: positiveOutcome(step), to: "$completed" as const },
      ...(step.kind === "human"
        ? [{ from: id, on: step.card.actions[1].response, to: "$cancelled" as const }]
        : [{ from: id, on: step.kind === "gate" ? "fail" : "failure", to: "$failed" as const }]),
    ];
    patch({
      agents: agent && !definition.agents?.some((candidate) => candidate.id === agent)
        ? [...(definition.agents ?? []), visibleAgents.find((candidate) => candidate.id === agent)!].filter(Boolean)
        : definition.agents,
      steps: [...definition.steps, step],
      start: definition.steps.length === 0 ? id : definition.start,
      edges,
      canvas: { nodes: { ...nodes, [id]: at }, viewport },
    });
    setSelected(id);
  };

  const connect = (from: string, to: string) => {
    if (from.startsWith("trigger:")) {
      patch({ start: to });
      return;
    }
    const step = definition.steps.find((candidate) => candidate.id === from);
    if (!step || from === to) return;
    const outcome = positiveOutcome(step);
    const rest = definition.edges.filter((edge) => !(edge.from === from && edge.on === outcome));
    patch({ edges: [...rest, { from, on: outcome, to }] });
  };

  const beginLink = (event: React.PointerEvent, from: string) => {
    event.stopPropagation();
    const rect = surface.current?.getBoundingClientRect();
    if (!rect) return;
    const startX = event.clientX - rect.left;
    const startY = event.clientY - rect.top;
    setLinking({ from, startX, startY, x: startX, y: startY });
    const move = (next: PointerEvent) =>
      setLinking((held) => held && ({ ...held, x: next.clientX - rect.left, y: next.clientY - rect.top }));
    const up = (next: PointerEvent) => {
      const target = document.elementFromPoint(next.clientX, next.clientY)?.closest<HTMLElement>("[data-flow-node]");
      if (target?.dataset.flowNode) connect(from, target.dataset.flowNode);
      setLinking(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const dragNode = (event: React.PointerEvent, id: string, index: number) => {
    if ((event.target as HTMLElement).closest("button,input,textarea,select")) return;
    event.stopPropagation();
    const initial = position(id, index);
    const origin = { x: event.clientX, y: event.clientY };
    const move = (next: PointerEvent) => setPosition(id, {
      x: initial.x + (next.clientX - origin.x) / viewport.zoom,
      y: initial.y + (next.clientY - origin.y) / viewport.zoom,
    });
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const pan = (event: React.PointerEvent) => {
    if (event.target !== surface.current) return;
    setSelected(null);
    const origin = { x: event.clientX, y: event.clientY, vx: viewport.x, vy: viewport.y };
    const move = (next: PointerEvent) => patchCanvas(nodes, {
      ...viewport,
      x: origin.vx + next.clientX - origin.x,
      y: origin.vy + next.clientY - origin.y,
    });
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const worldPoint = (clientX: number, clientY: number) => {
    const rect = surface.current?.getBoundingClientRect();
    return rect ? {
      x: (clientX - rect.left - viewport.x) / viewport.zoom,
      y: (clientY - rect.top - viewport.y) / viewport.zoom,
    } : { x: 120, y: 120 };
  };

  const deleteSelected = () => {
    if (!selected) return;
    if (selected.startsWith("agentlib:")) {
      const id = selected.slice(9);
      if (definition.steps.some((step) => step.kind === "agent" && step.agent === id)) return;
      patch({ agents: (definition.agents ?? []).filter((agent) => agent.id !== id) });
    } else if (selected.startsWith("trigger:")) {
      if (definition.triggers.length <= 1) return;
      const at = Number(selected.slice(8));
      patch({ triggers: definition.triggers.filter((_, index) => index !== at) });
    } else {
      const remaining = definition.steps.filter((step) => step.id !== selected);
      if (remaining.length === 0) return;
      patch({
        steps: remaining,
        start: definition.start === selected ? remaining[0].id : definition.start,
        edges: definition.edges
          .filter((edge) => edge.from !== selected)
          .map((edge) => edge.to === selected ? { ...edge, to: "$failed" as const } : edge),
      });
    }
    setSelected(null);
  };

  const selectedAgent = selected?.startsWith("agentlib:")
    ? visibleAgents.find((agent) => agent.id === selected.slice(9)) : undefined;
  const selectedStep = definition.steps.find((step) => step.id === selected);
  const selectedTrigger = selected?.startsWith("trigger:") ? Number(selected.slice(8)) : -1;
  const selectedAgentType = selectedAgent?.type === "inherit"
    ? undefined : workflowAgentType(selectedAgent?.type ?? "");
  const configFields = selectedAgentType?.execution?.fields ?? [];
  const stepStates = useMemo(() => new Map(run?.steps.map((step) => [step.id, step.state]) ?? []), [run]);

  const edgePaths = definition.edges.flatMap((edge) => {
    if (edge.to.startsWith("$")) return [];
    const fromIndex = definition.steps.findIndex((step) => step.id === edge.from);
    const toIndex = definition.steps.findIndex((step) => step.id === edge.to);
    if (fromIndex < 0 || toIndex < 0 || edge.on !== positiveOutcome(definition.steps[fromIndex])) return [];
    const from = position(edge.from, fromIndex + definition.triggers.length);
    const to = position(edge.to, toIndex + definition.triggers.length);
    const x1 = from.x + NODE_W;
    const y1 = from.y + NODE_H / 2;
    const x2 = to.x;
    const y2 = to.y + NODE_H / 2;
    const bend = Math.max(70, Math.abs(x2 - x1) * .45);
    return [{ id: `${edge.from}:${edge.on}`, d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}` }];
  });

  const renderAgentField = (agent: WorkflowAgentBlock, field: AgentConfigField) => {
    const value = agent.config?.[field.key] ?? "";
    if (field.control === "profile") {
      return (
        <label key={field.key}>{field.label}<Select value={value} onChange={(event) => updateAgentConfig(agent, field.key, event.target.value)}>
          <option value="">Active account</option>
          {profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.label}</option>)}
        </Select></label>
      );
    }
    const choices = field.control === "model" ? modelChoicesFor(field) : field.choices ?? [];
    if (choices.length > 0) {
      return (
        <label key={field.key}>{field.label}<Select value={value} onChange={(event) => updateAgentConfig(agent, field.key, event.target.value)}>
          <option value="">Agent default</option>
          {choices.map((choice) => (
            <option value={"id" in choice ? choice.id : choice.value} key={"id" in choice ? `${choice.id}:${choice.hint}` : choice.value}>
              {"id" in choice ? `${choice.label} — ${choice.hint}` : choice.label}
            </option>
          ))}
        </Select></label>
      );
    }
    return (
      <label key={field.key}>{field.label}<TextInput
        placeholder={field.placeholder}
        value={value}
        onChange={(event) => updateAgentConfig(agent, field.key, event.target.value)}
      /></label>
    );
  };

  return (
    <div className="workflow-studio">
      <aside className="workflow-node-library">
        <div className="workflow-section-label">Node library</div>
        <section>
          <strong>Agents</strong>
          <p>Reusable execution profiles. Drag one into the workflow.</p>
          {libraryError && <p className="workflow-library-error">{libraryError}</p>}
          {visibleAgents.map((agent) => (
            <button
              key={agent.id}
              className={`workflow-agent-block${selected === `agentlib:${agent.id}` ? " is-selected" : ""}`}
              draggable
              onDragStart={(event) => event.dataTransfer.setData("application/x-canopy-agent", agent.id)}
              onClick={() => setSelected(`agentlib:${agent.id}`)}
            >
              <AgentIcon id={agent.type} size={16} />
              <span><b>{agent.name}</b><small>{agent.type}{agent.config?.model ? ` · ${agent.config.model}` : ""}</small></span>
              <i>⋮⋮</i>
            </button>
          ))}
          <Button size="sm" variant="ghost" onClick={addAgentBlock}>+ New agent</Button>
        </section>
        <section>
          <strong>Flow</strong>
          <button draggable onDragStart={(event) => event.dataTransfer.setData("application/x-canopy-node", "human")}>◇ Human decision</button>
          <button draggable disabled={!definition.steps.some((step) => step.kind === "agent")} onDragStart={(event) => event.dataTransfer.setData("application/x-canopy-node", "gate")}>◆ Evidence gate</button>
        </section>
        <section>
          <strong>Events</strong>
          <button onClick={() => patch({ triggers: [...definition.triggers, { kind: "issue.opened" }] })}>＋ Add event trigger</button>
        </section>
      </aside>

      <div
        ref={surface}
        className="workflow-canvas"
        onPointerDown={pan}
        onWheel={(event) => {
          event.preventDefault();
          const zoom = Math.min(2, Math.max(.35, viewport.zoom * (event.deltaY > 0 ? .9 : 1.1)));
          patchCanvas(nodes, { ...viewport, zoom });
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          const at = worldPoint(event.clientX, event.clientY);
          const agent = event.dataTransfer.getData("application/x-canopy-agent");
          const kind = event.dataTransfer.getData("application/x-canopy-node") as "human" | "gate";
          if (agent) addStep("agent", at, agent);
          else if (kind) addStep(kind, at);
        }}
      >
        <div className="workflow-canvas-world" style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` }}>
          <svg className="workflow-canvas-wires" aria-hidden>
            {definition.triggers.map((_, index) => {
              const from = position(`trigger:${index}`, index);
              const toIndex = definition.steps.findIndex((step) => step.id === definition.start);
              const to = position(definition.start, Math.max(0, toIndex) + definition.triggers.length);
              const x1 = from.x + NODE_W, y1 = from.y + NODE_H / 2, x2 = to.x, y2 = to.y + NODE_H / 2;
              return <path key={`trigger:${index}`} d={`M ${x1} ${y1} C ${x1 + 80} ${y1}, ${x2 - 80} ${y2}, ${x2} ${y2}`} />;
            })}
            {edgePaths.map((edge) => <path key={edge.id} d={edge.d} />)}
          </svg>

          {definition.triggers.map((trigger, index) => {
            const id = `trigger:${index}`;
            const at = position(id, index);
            return (
              <article
                key={id}
                data-flow-node={id}
                className={`workflow-canvas-node is-trigger${selected === id ? " is-selected" : ""}`}
                style={{ left: at.x, top: at.y }}
                onPointerDown={(event) => dragNode(event, id, index)}
                onClick={(event) => { event.stopPropagation(); setSelected(id); }}
              >
                <span className="workflow-node-kicker">Event</span>
                <strong>{trigger.kind === "manual" ? "Run manually" : trigger.kind}</strong>
                <small>{trigger.repo || "Any repository"}</small>
                <button className="workflow-node-port is-output" title="Drag to connect" onPointerDown={(event) => beginLink(event, id)} />
              </article>
            );
          })}

          {definition.steps.map((step, index) => {
            const at = position(step.id, index + definition.triggers.length);
            const state = stepStates.get(step.id);
            const agent = step.kind === "agent" ? definition.agents?.find((item) => item.id === step.agent) : undefined;
            return (
              <article
                key={step.id}
                data-flow-node={step.id}
                className={`workflow-canvas-node is-${step.kind}${selected === step.id ? " is-selected" : ""}${state ? ` st-${state}` : ""}`}
                style={{ left: at.x, top: at.y }}
                onPointerDown={(event) => dragNode(event, step.id, index + definition.triggers.length)}
                onClick={(event) => { event.stopPropagation(); setSelected(step.id); }}
              >
                <button className="workflow-node-port is-input" title="Connection target" />
                <span className="workflow-node-kicker">{step.kind === "agent" ? agent?.name ?? "Agent" : step.kind}</span>
                <strong>{titleFor(step)}</strong>
                <small>{step.kind === "agent" ? `${agent?.type ?? "Inherit"}${agent?.config?.model ? ` · ${agent.config.model}` : ""}` : state ?? "Ready"}</small>
                <button className="workflow-node-port is-output" title="Drag to connect" onPointerDown={(event) => beginLink(event, step.id)} />
              </article>
            );
          })}
        </div>
        {linking && <svg className="workflow-live-wire" aria-hidden><path d={`M ${linking.startX} ${linking.startY} C ${linking.startX + 80} ${linking.startY}, ${linking.x - 80} ${linking.y}, ${linking.x} ${linking.y}`} /></svg>}
        <div className="workflow-canvas-controls">
          <button onClick={() => patchCanvas(nodes, { ...viewport, zoom: Math.min(2, viewport.zoom * 1.15) })}>＋</button>
          <button onClick={() => patchCanvas(nodes, { ...viewport, zoom: Math.max(.35, viewport.zoom / 1.15) })}>−</button>
          <button onClick={() => patchCanvas(nodes, { x: 0, y: 0, zoom: 1 })}>1:1</button>
        </div>
      </div>

      <aside className="workflow-inspector">
        <div className="workflow-section-label">Inspector</div>
        {!selected && <p className="workflow-inspector-empty">Select a node or reusable agent to configure it.</p>}
        {selectedAgent && (
          <>
            <label>Name<TextInput value={selectedAgent.name} onChange={(event) => updateAgent(selectedAgent.id, { name: event.target.value })} /></label>
            <label>Agent type<Select value={selectedAgent.type} onChange={(event) => updateAgent(selectedAgent.id, { type: event.target.value, config: undefined })}>
              <option value="inherit">Project default</option>
              {AGENT_CLIS.map((cli) => <option value={cli.id} key={cli.id}>{cli.name}</option>)}
            </Select></label>
            {configFields.map((field) => renderAgentField(selectedAgent, field))}
            <label>Base prompt<textarea rows={7} value={selectedAgent.prompt ?? ""} onChange={(event) => updateAgent(selectedAgent.id, { prompt: event.target.value })} placeholder="Stable role, standards, and context shared by every use." /></label>
          </>
        )}
        {selectedTrigger >= 0 && definition.triggers[selectedTrigger] && (
          <label>Event<Select value={definition.triggers[selectedTrigger].kind} onChange={(event) => updateTrigger(selectedTrigger, event.target.value as WorkflowTriggerKind)}>
            {WIRED_TRIGGERS.filter((kind) => WORKFLOW_TRIGGER_CATALOG.includes(kind)).map((kind) => <option value={kind} key={kind}>{kind}</option>)}
          </Select></label>
        )}
        {selectedStep && (
          <>
            <label>Node name<TextInput value={selectedStep.name} onChange={(event) => updateStep(selectedStep.id, { name: event.target.value })} /></label>
            {selectedStep.kind === "agent" && <>
              <label>Reusable agent<Select value={selectedStep.agent ?? ""} onChange={(event) => updateStep(selectedStep.id, { agent: event.target.value || undefined } as Partial<WorkflowAgentStep>)}>
                <option value="">Project default</option>
                {visibleAgents.map((agent) => <option value={agent.id} key={agent.id}>{agent.name}</option>)}
              </Select></label>
              <label>Task prompt<textarea rows={9} value={selectedStep.prompt} onChange={(event) => updateStep(selectedStep.id, { prompt: event.target.value } as Partial<WorkflowAgentStep>)} /></label>
            </>}
            {selectedStep.kind === "human" && <label>Question<TextInput value={selectedStep.card.title} onChange={(event) => updateStep(selectedStep.id, { card: { ...selectedStep.card, title: event.target.value } })} /></label>}
          </>
        )}
        {selected && <Button size="sm" variant="danger" onClick={deleteSelected}>Delete</Button>}
      </aside>
    </div>
  );
}
