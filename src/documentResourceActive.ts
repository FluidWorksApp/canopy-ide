/** The resource owner must follow the same surface id that the document host
 * uses for display. Build mode can present a preview while Engineer's selected
 * tab remains unchanged underneath. */
export const documentResourceActive = (
  tabId: string,
  surfaceTabId: string | null,
  projectVisible: boolean,
) => projectVisible && tabId === surfaceTabId;

/** Active panes must be rebuilt on every parent render so changing props that
 * are not stored on the tab object still reach the child. Only a pane that was
 * already inactive may retain element identity across unrelated parent ticks. */
export const shouldReuseInactiveDocumentPane = <T>(
  cached: { tab: T; active: boolean } | undefined,
  tab: T,
  active: boolean,
) => Boolean(cached && !active && !cached.active && cached.tab === tab);
