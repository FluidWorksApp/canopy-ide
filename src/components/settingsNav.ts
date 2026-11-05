import { createContext } from "react";
import type { SettingsTab } from "./SettingsDialog";

/** Which tab is showing and which row a search just jumped to. Item reads it to
 *  give its row an anchor and a brief highlight. */
export const SettingsNavContext = createContext<{ tab: SettingsTab | null; highlight: string | null }>({
  tab: null,
  highlight: null,
});
