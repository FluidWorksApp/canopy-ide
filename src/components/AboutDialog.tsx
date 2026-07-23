// About: name, version, and the links that used to live only on the site.
// Custom (not the native macOS panel) so Terms / Privacy / Support us can be
// real, clickable links.
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { useEscape } from "../useEscape";

interface AboutDialogProps {
  onClose: () => void;
}

export function AboutDialog({ onClose }: AboutDialogProps) {
  useEscape(onClose, true);
  const [version, setVersion] = useState("");
  useEffect(() => {
    void getVersion().then(setVersion);
  }, []);

  const link = (url: string, label: string) => (
    <a
      href="#"
      onClick={(e) => {
        e.preventDefault();
        void openUrl(url);
      }}
    >
      {label}
    </a>
  );

  return (
    <div className="confirm-backdrop" onMouseDown={onClose}>
      <div
        className="confirm about-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="about-body">
          <div className="about-name">Canopy</div>
          {version && <div className="about-version">Version {version}</div>}
          <p className="about-links">
            {link("https://canopyide.dev/terms", "Terms")} ·{" "}
            {link("https://canopyide.dev/privacy", "Privacy")} ·{" "}
            {link("https://canopyide.dev/support", "Support us")}
          </p>
        </div>
        <div className="confirm-actions">
          <button className="btn btn-accent" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
