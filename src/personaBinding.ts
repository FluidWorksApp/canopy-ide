/** Exactly one interactive mascot is visible; attention remains independently visible. */
export function personaBinding(companionEnabled: boolean, buildMode: boolean): {
  companionVisible: boolean;
  attentionFallbackVisible: boolean;
} {
  const companionVisible = companionEnabled && !buildMode;
  return {
    companionVisible,
    attentionFallbackVisible: !companionVisible,
  };
}
