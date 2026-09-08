/** Exactly one interactive mascot is visible; attention remains independently visible. */
export function personaBinding(companionEnabled: boolean, buildMode: boolean): {
  companionVisible: boolean;
  attentionFallbackVisible: boolean;
} {
  const companionVisible = companionEnabled && !buildMode;
  return {
    companionVisible,
    // Build keeps attention behind its quiet bell. Toast panels belong to the
    // richer Engineer shell and would cover the product being built.
    attentionFallbackVisible: !companionVisible && !buildMode,
  };
}
