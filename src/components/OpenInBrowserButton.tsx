import { Button } from "./ui";
import { openLink } from "../links";

/** Opens the preview's page in the person's own browser. The address is the
 *  app's real one (http://localhost:6001/…), not the preview's isolated origin,
 *  so a backend that only allows its own origin (strict CORS) still accepts it. */
export function OpenInBrowserButton({ url }: { url: string }) {
  const openable = /^https?:\/\//i.test(url);
  return (
    <Button
      icon
      aria-label="Open in your browser"
      title={openable ? "Open this page in your own browser" : "Nothing to open yet"}
      disabled={!openable}
      onClick={() => openLink(url, true)}
    >
      ↗
    </Button>
  );
}
