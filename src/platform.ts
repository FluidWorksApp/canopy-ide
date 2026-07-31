/** True on macOS. The one place that asks the platform, so a shortcut, a
 *  titlebar and a hint layer can't disagree about which machine they're on. */
export const IS_MAC =
  typeof navigator !== "undefined" &&
  navigator.platform.toUpperCase().includes("MAC");
