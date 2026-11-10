import { useEffect, useState } from "react";
import { loadConnectorIcon } from "../acp/connectorIcons";
import { IconTerminal } from "../../shared/icons";

/** An ACP connector's brand mark from its registry SVG; the terminal glyph
 *  while it loads, and when there is none. */
export function ConnectorIcon({ url, size = 14, className }: { url?: string; size?: number; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    setSrc(null);
    if (!url) return;
    let stale = false;
    void loadConnectorIcon(url).then((data) => {
      if (!stale) setSrc(data);
    });
    return () => {
      stale = true;
    };
  }, [url]);
  if (!src) return <IconTerminal size={size} className={className} />;
  return <img src={src} width={size} height={size} alt="" className={className} draggable={false} />;
}
