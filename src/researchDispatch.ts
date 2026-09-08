/** The durable boundary between accepting a research request and launching the
 * agent that will work it. The record is created first. Anything that fails
 * afterwards leaves that record visible and blocked instead of losing the
 * user's question with a fire-and-forget process launch. */
export async function dispatchResearch<T>(deps: {
  create: () => Promise<T>;
  link?: (entry: T) => Promise<void>;
  directory: (entry: T) => Promise<string>;
  launch: (entry: T, directory: string) => Promise<boolean>;
  block: (entry: T, error?: unknown) => Promise<void>;
  open: (entry: T) => void;
}): Promise<{ entry: T; launched: boolean; error?: unknown }> {
  // If this fails there is no receipt and the caller must keep the composer
  // open. Every failure after it is recoverable from the durable entry.
  const entry = await deps.create();
  try {
    await deps.link?.(entry);
    const directory = await deps.directory(entry);
    const launched = await deps.launch(entry, directory);
    if (!launched) await deps.block(entry);
    deps.open(entry);
    return { entry, launched };
  } catch (error) {
    // Marking blocked is best-effort: even if that write fails, opening the
    // already-created entry is still better than making the request vanish.
    await deps.block(entry, error).catch(() => {});
    deps.open(entry);
    return { entry, launched: false, error };
  }
}
