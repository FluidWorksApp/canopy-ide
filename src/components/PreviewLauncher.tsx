import { useId, useState } from "react";
import type { PreviewServer } from "../preview";
import { LiveDot } from "./icons";

/** Opening a preview must not depend on successful process/port discovery. */
export function PreviewLauncher({
  servers,
  onNavigate,
}: {
  servers: PreviewServer[];
  onNavigate: (url: string) => void;
}) {
  const inputId = useId();
  const [url, setUrl] = useState("");
  return (
    <div className="preview-empty">
      <h2>Preview a running server</h2>
      <p className="preview-empty-hint">
        Enter your server URL or choose a detected server below.
      </p>
      <form
        className="preview-start-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (url.trim()) onNavigate(url.trim());
        }}
      >
        <label htmlFor={inputId}>Server URL</label>
        <div className="preview-start-row">
          <input
            id={inputId}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="http://localhost:3000"
            spellCheck={false}
            autoComplete="off"
            required
          />
          <button type="submit" disabled={!url.trim()}>
            Open preview
          </button>
        </div>
      </form>
      {servers.length ? (
        <div className="preview-server-list">
          {servers.map((server) => (
            <button
              key={`${server.ptyId}:${server.port}`}
              className="preview-server"
              title={`${server.command ?? "shell"} — ${server.cwd}`}
              onClick={() => onNavigate(server.url)}
            >
              <LiveDot size={7} className="preview-server-dot" />
              <span className="preview-server-title">{server.title}</span>
              <span className="preview-server-url">
                localhost:{server.port}
              </span>
              {server.componentLabel && (
                <span className="preview-component-badge">
                  {server.componentLabel}
                </span>
              )}
            </button>
          ))}
        </div>
      ) : (
        <p className="preview-empty-hint" role="status">
          No web server port detected yet. If your service is running, enter its
          URL above.
        </p>
      )}
    </div>
  );
}
