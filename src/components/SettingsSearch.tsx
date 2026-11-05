import { forwardRef, useEffect, useMemo, useState } from "react";
import type { SettingsTab } from "./SettingsDialog";
import { searchSettings, type SettingHit } from "./settingsIndex";

/** The settings search box and its results. Results replace the tab list while
 *  there is something typed; arrows move, Enter opens, the × clears (Esc is the
 *  dialog's, which clears before it closes). */
export const SettingsSearch = forwardRef<
  HTMLInputElement,
  {
    query: string;
    onQuery: (query: string) => void;
    onPick: (hit: SettingHit) => void;
    /** Tabs that exist right now: a hidden tab's settings are not offered. */
    tabLabels: Partial<Record<SettingsTab, string>>;
  }
>(function SettingsSearch({ query, onQuery, onPick, tabLabels }, ref) {
  const hits = useMemo(
    () => searchSettings(query, { tabLabels }).filter((h) => h.entry.tab in tabLabels),
    [query, tabLabels],
  );
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [query]);
  const typed = query.trim();
  // Keep a tab's results together, in the order its best match first appears.
  const groups: { tab: SettingsTab; hits: { hit: SettingHit; index: number }[] }[] = [];
  hits.forEach((hit, index) => {
    let group = groups.find((g) => g.tab === hit.entry.tab);
    if (!group) groups.push((group = { tab: hit.entry.tab, hits: [] }));
    group.hits.push({ hit, index });
  });
  return (
    <div className="settings-search">
      <div className="settings-search-field">
        <input
          ref={ref}
          type="text"
          className="settings-search-input"
          placeholder="Search settings"
          aria-label="Search settings"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (!hits.length) return;
            if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, hits.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); onPick(hits[active]); }
          }}
        />
        {query && (
          <button type="button" className="settings-search-clear" aria-label="Clear search" onClick={() => onQuery("")}>
            ×
          </button>
        )}
      </div>
      {typed && (
        <div className="settings-search-results" role="listbox" aria-label="Search results">
          {groups.length === 0 ? (
            <div className="settings-search-empty">No settings match “{typed}”.</div>
          ) : (
            groups.map((group) => (
              <div key={group.tab} role="group" aria-label={tabLabels[group.tab]}>
                <div className="settings-nav-group">{tabLabels[group.tab]}</div>
                {group.hits.map(({ hit, index }) => (
                  <button
                    key={`${hit.entry.tab}:${hit.entry.name}`}
                    type="button"
                    role="option"
                    aria-selected={index === active}
                    className={`settings-search-hit${index === active ? " settings-search-hit-active" : ""}`}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => onPick(hit)}
                  >
                    <span className="settings-search-hit-name">{hit.entry.name}</span>
                    {hit.entry.desc && <span className="settings-search-hit-desc">{hit.entry.desc}</span>}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
});
