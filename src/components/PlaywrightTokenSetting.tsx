// Settings → Browser → Playwright: the extension token that skips Chrome's
// per-connection approval dialog.
//
// The token is write-only from the webview. Saving hands it to the OS
// credential store and clears the field; afterwards this screen knows only
// whether one is saved, so it is never on screen again and never sits in React
// state, localStorage or the settings file.
import { useEffect, useState } from "react";
import * as ipc from "../ipc";
import { Button, TextInput } from "./ui";

const WHERE =
  "Click the Playwright extension's icon in Chrome's toolbar to see its token.";

export function PlaywrightTokenSetting() {
  const [saved, setSaved] = useState<boolean | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    ipc.chromeExtensionTokenStatus().then(
      (v) => live && setSaved(v),
      () => live && setSaved(false),
    );
    return () => {
      live = false;
    };
  }, []);

  const run = async (op: () => Promise<void>, next: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await op();
      setSaved(next);
      setDraft("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    const token = draft.trim();
    if (token) void run(() => ipc.chromeExtensionTokenSet(token), true);
  };

  const openPage = () => {
    setError(null);
    ipc.chromeExtensionOpenStatus().catch(() =>
      setError(`Couldn't open Chrome. ${WHERE}`),
    );
  };

  return (
    <>
      {saved ? (
        <div className="set-inline set-pw-token">
          <span>Skip Chrome's approval: token saved in Keychain.</span>
          <Button size="sm" disabled={busy} onClick={() => void run(ipc.chromeExtensionTokenClear, false)}>
            Clear
          </Button>
        </div>
      ) : (
        <form
          className="set-inline set-pw-token"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <label htmlFor="pw-ext-token">Skip Chrome's approval:</label>
          <TextInput
            id="pw-ext-token"
            type="password"
            size="sm"
            width="md"
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste token"
            value={draft}
            disabled={busy || saved === null}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button size="sm" type="submit" disabled={busy || !draft.trim()}>
            Save
          </Button>
        </form>
      )}
      {!saved && (
        <p className="set-item-desc">
          The token is on the Playwright extension's status page.{" "}
          <Button size="sm" variant="ghost" onClick={openPage}>
            Open extension page
          </Button>
        </p>
      )}
      {error && (
        <p className="set-item-desc" role="alert">
          {error}
        </p>
      )}
      <p className="set-item-desc">
        Reopen preview tabs after changing engines.{" "}
        {saved
          ? "Chrome connects without asking while the token is saved."
          : "Until a token is saved, Chrome asks you to approve each connection."}
      </p>
    </>
  );
}
