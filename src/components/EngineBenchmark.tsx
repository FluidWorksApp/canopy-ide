// Settings > Terminal > Benchmark engines: run the same generated output
// through Ghostty and Classic (xterm) in this app and show the timings.
// Timings only; nothing from a real terminal is read.
import { useRef, useState } from "react";
import { formatBenchmark, runTerminalBenchmark } from "../../shared/terminalEngine/bench";
import { Button } from "./ui";

export function EngineBenchmark() {
  const [state, setState] = useState<{ busy: string | null; lines: string[]; error: string | null }>({
    busy: null,
    lines: [],
    error: null,
  });
  const running = useRef(false);
  const run = async () => {
    if (running.current) return;
    running.current = true;
    setState({ busy: "Starting…", lines: [], error: null });
    try {
      const results = await runTerminalBenchmark({}, (engine) =>
        setState((s) => ({ ...s, busy: `Running ${engine === "ghostty" ? "Ghostty" : "Classic"}…` })),
      );
      setState({ busy: null, lines: formatBenchmark(results), error: null });
    } catch {
      setState({ busy: null, lines: [], error: "The benchmark could not run here." });
    } finally {
      running.current = false;
    }
  };
  return (
    <div className="set-stack">
      <Button size="sm" onClick={run} disabled={state.busy !== null}>
        {state.busy ?? "Run benchmark"}
      </Button>
      {state.error && (
        <span className="set-warn" role="status">
          {state.error}
        </span>
      )}
      {state.lines.length > 0 && (
        <pre className="ts-mono" role="status" style={{ whiteSpace: "pre-wrap", margin: 0 }}>
          {state.lines.join("\n")}
        </pre>
      )}
    </div>
  );
}
