import { useEffect, useMemo, useRef, useState } from "react";
import { useEscapeLayer } from "../useEscape";
import {
  completion,
  componentAt,
  lastFolder,
  orderComponents,
  rankComponents,
  type PickerComponent,
} from "../componentPicker";
import {
  automaticPreference,
  preferenceKey,
  targetKey,
  targetPreference,
  type DisplayTarget,
  type Preference,
} from "../placement/types";

/** Selects a component and, for agent launches, the concrete execution machine.
 * Shell launches omit machineTargets and retain their existing component-only
 * behavior. */
export function ComponentPicker({
  title,
  components,
  recents,
  activePath,
  machineTargets,
  initialMachine = automaticPreference(),
  onPick,
  onCancel,
}: {
  /** What is being opened: "New shell", "New Claude Code"… */
  title: string;
  components: PickerComponent[];
  /** Component ids, most recently used first. */
  recents: string[];
  /** The tab in front, if any, so "current tab" can be flagged. */
  activePath?: string | null;
  /** Present for an agent launch. Includes This Mac and connected machines. */
  machineTargets?: DisplayTarget[];
  initialMachine?: Preference;
  onPick: (component: PickerComponent, machine?: Preference) => void;
  onCancel: () => void;
}) {
  useEscapeLayer(true, { onEscape: () => cancel() });
  const [query, setQuery] = useState("");
  const [selectedRow, setSelectedRow] = useState(0);
  const [machine, setMachine] = useState<Preference>(initialMachine);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const before = useRef<Element | null>(document.activeElement);

  const ordered = useMemo(() => orderComponents(components, recents, activePath), [components, recents, activePath]);
  const rows = useMemo(() => rankComponents(query, ordered), [query, ordered]);
  const ghost = completion(query, rows[0]);
  const lastUsed = recents.length ? ordered[0]?.id : undefined;
  const current = componentAt(components, activePath)?.id;
  const machineChoices = machineTargets
    ? [
        { key: "automatic", label: "Automatic", preference: automaticPreference() },
        ...machineTargets.map((item) => ({
          key: targetKey(item.target),
          label: item.name,
          preference: targetPreference(item.target),
        })),
        ...(machine.mode === "target" && !machineTargets.some((item) => targetKey(item.target) === targetKey(machine.target))
          ? [{
              key: targetKey(machine.target),
              label: `Unavailable machine (${machine.target.kind === "remote" ? machine.target.workspaceId : machine.target.kind === "t3" ? machine.target.machineId : "This Mac"})`,
              preference: targetPreference(machine.target),
            }]
          : []),
      ]
    : [];

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setSelectedRow(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(".palette-row-active")?.scrollIntoView({ block: "nearest" });
  }, [selectedRow]);

  function cancel() {
    onCancel();
    const element = before.current;
    if (element instanceof HTMLElement && element.isConnected) requestAnimationFrame(() => element.focus());
  }

  const selectMachineByKey = (key: string) => {
    const choice = machineChoices.find((item) => item.key === key);
    if (choice) setMachine(choice.preference);
  };

  return (
    <div className="palette-backdrop" onMouseDown={cancel}>
      <div className="palette cpick" role="dialog" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <div className="cpick-title">
          {title} <span className="cpick-title-dim">in which component?</span>
        </div>
        {machineTargets && (
          <div className="cpick-machine">
            <span className="cpick-machine-label">Run on</span>
            <div className="cpick-machine-options" role="radiogroup" aria-label="Run on machine">
              {machineChoices.map((choice) => {
                const checked = preferenceKey(machine) === choice.key;
                return (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    tabIndex={checked ? 0 : -1}
                    className={checked ? "is-selected" : ""}
                    key={choice.key}
                    onClick={() => setMachine(choice.preference)}
                    onKeyDown={(event) => {
                      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
                      event.preventDefault();
                      const direction = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
                      const currentIndex = machineChoices.findIndex((item) => item.key === choice.key);
                      const next = (currentIndex + direction + machineChoices.length) % machineChoices.length;
                      selectMachineByKey(machineChoices[next].key);
                      const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button[role=radio]");
                      buttons?.[next]?.focus();
                    }}
                  >
                    {choice.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <div className="cpick-field">
          <div className="cpick-ghost" aria-hidden="true">
            <span className="cpick-ghost-typed">{query}</span>
            {ghost?.rest}
          </div>
          <input
            ref={inputRef}
            className="cpick-input"
            value={query}
            placeholder={ordered[0]?.label ?? "Component"}
            aria-label="Component"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSelectedRow((index) => Math.min(index + 1, rows.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelectedRow((index) => Math.max(index - 1, 0));
              } else if (event.key === "Tab" && !event.shiftKey && ghost) {
                event.preventDefault();
                setQuery(ghost.full);
              } else if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                if (rows[selectedRow]) onPick(rows[selectedRow], machineTargets ? machine : undefined);
              }
            }}
          />
        </div>
        <div className="palette-list" ref={listRef} role="listbox" aria-label="Components">
          {rows.length === 0 && <div className="palette-empty">No component matches “{query.trim()}”</div>}
          {rows.map((component, index) => (
            <div
              key={component.id}
              role="option"
              aria-selected={index === selectedRow}
              className={`palette-row cpick-row ${index === selectedRow ? "palette-row-active" : ""}`}
              onMouseEnter={() => setSelectedRow(index)}
              onClick={() => onPick(component, machineTargets ? machine : undefined)}
            >
              <span className="cpick-name">{component.label}</span>
              <span className="cpick-path">{lastFolder(component.path)}</span>
              {component.id === lastUsed && <span className="cpick-tag">last used</span>}
              {component.id === current && <span className="cpick-tag cpick-tag-current">this tab</span>}
            </div>
          ))}
        </div>
        <div className="cpick-hint">
          <span>↵ open</span>
          <span>Tab complete</span>
          <span>↑↓ choose</span>
          <span>Esc cancel</span>
        </div>
      </div>
    </div>
  );
}
