// Settings → Vault: the logins the built-in browser can sign in with.
//
// Three states, and each is its own screen: no vault yet (choose a passphrase),
// locked (type it), unlocked (the list). A single screen that greys itself out
// invites typing a passphrase into a field that is about to be something else.
//
// The screen knows what page is open in the preview, and that is the whole
// design: you almost always add a login while looking at its sign-in page, so
// the primary action is "Add github.com" rather than four empty boxes. Manual
// entry is still there, one click further away, for the credentials that have
// no page at all.
//
// A password is never on screen unless the user asks for that one, on its own.
// Copying goes straight to the clipboard without displaying anything, because
// copying is the usual reason to reveal one, and revealing puts it in front of
// the room, the screen recording, and whoever walks past.
import { useCallback, useEffect, useState } from "react";
import * as ipc from "../ipc";
import { browserViewSnapshots } from "../browserSignals";
import {
  generatePassword,
  monogram,
  suggestedDomain,
  suggestedLabel,
  tint,
} from "../vaultUi";

function Item({
  name,
  desc,
  children,
}: {
  name: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="set-item">
      <div className="set-item-name">{name}</div>
      {desc && <div className="set-item-desc">{desc}</div>}
      <div className="set-item-control">{children}</div>
    </div>
  );
}

/** A labelled field. The label stays visible while the field is filled — a
 *  placeholder doing double duty as the label disappears exactly when someone
 *  is checking what they typed. */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="vault-field">
      <span className="vault-field-label">
        {label}
        {hint && <span className="vault-field-hint">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

function EntryForm({
  entry,
  startDomain,
  onDone,
}: {
  entry: ipc.VaultItem | null;
  /** The site this form opened for, when it opened from the page in the preview. */
  startDomain?: string;
  onDone: () => void;
}) {
  const [domain, setDomain] = useState(entry?.domain ?? startDomain ?? "");
  const [label, setLabel] = useState(
    entry?.label ?? (startDomain ? suggestedLabel(startDomain) : ""),
  );
  const [username, setUsername] = useState(entry?.username ?? "");
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
  const [readable, setReadable] = useState(entry?.readable ?? false);
  const [err, setErr] = useState("");

  const save = async () => {
    try {
      await ipc.vaultSave({
        id: entry?.id,
        label: label.trim() || suggestedLabel(domain.trim()),
        domain: domain.trim(),
        username: username.trim(),
        // Blank on an edit means "keep the stored password", which is what
        // makes fixing a typo in a name safe.
        password: password || (entry ? undefined : ""),
        readable,
      });
      onDone();
    } catch (e) {
      setErr(String(e));
    }
  };

  return (
    <div className="vault-card">
      <div className="vault-card-head">
        <span
          className="vault-tile vault-tile-lg"
          style={{ "--tile-hue": tint(domain) } as React.CSSProperties}
        >
          {monogram(label, domain)}
        </span>
        <h4>{entry ? `Edit ${entry.label}` : "New login"}</h4>
      </div>

      <div className="vault-grid">
        <Field label="Site">
          <input
            autoFocus={!startDomain}
            placeholder="github.com"
            value={domain}
            onChange={(e) => {
              const next = e.target.value;
              // The name follows the site until the user writes their own.
              if (!label || label === suggestedLabel(domain)) {
                setLabel(suggestedLabel(next.trim()));
              }
              setDomain(next);
            }}
          />
        </Field>
        <Field label="Name" hint="what you call it">
          <input
            placeholder={suggestedLabel(domain) || "GitHub"}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </Field>
        <Field label="Username">
          <input
            autoFocus={!!startDomain}
            placeholder="you@example.com"
            autoComplete="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        <Field label="Password" hint={entry ? "blank keeps the current one" : undefined}>
          <div className="vault-pw">
            <input
              type={reveal ? "text" : "password"}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              type="button"
              className="vault-pw-btn"
              aria-pressed={reveal}
              onClick={() => setReveal((r) => !r)}
            >
              {reveal ? "Hide" : "Show"}
            </button>
            <button
              type="button"
              className="vault-pw-btn"
              onClick={() => {
                setPassword(generatePassword());
                setReveal(true);
              }}
            >
              Generate
            </button>
          </div>
        </Field>
      </div>

      <label className={`vault-consent${readable ? " vault-consent-on" : ""}`}>
        <input
          type="checkbox"
          checked={readable}
          onChange={(e) => setReadable(e.target.checked)}
        />
        <span>
          <span className="vault-consent-name">Let agents read this password</span>
          <span className="vault-consent-why">
            {readable
              ? "An agent can be told this one in plain text, and anything it later reads from a page could try to talk it into repeating it. Right for a database URL or an SSH passphrase — nothing with a login form."
              : "Off: Canopy types this into the page itself and the agent never sees it. Turn it on only for logins no browser form can take."}
          </span>
        </span>
      </label>

      {err && <p className="vault-err">{err}</p>}
      <div className="vault-card-actions">
        <button
          className="btn btn-accent"
          onClick={() => void save()}
          disabled={!domain.trim()}
        >
          {entry ? "Save changes" : "Save login"}
        </button>
        <button className="btn" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function EntryRow({ item, onChanged }: { item: ipc.VaultItem; onChanged: () => void }) {
  const [shown, setShown] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  if (editing) {
    return (
      <EntryForm
        entry={item}
        onDone={() => {
          setEditing(false);
          onChanged();
        }}
      />
    );
  }

  return (
    <div className="vault-row">
      <span
        className="vault-tile"
        style={{ "--tile-hue": tint(item.domain) } as React.CSSProperties}
        aria-hidden
      >
        {monogram(item.label, item.domain)}
      </span>
      <div className="vault-row-text">
        <span className="vault-row-title">
          {item.label}
          {item.readable && (
            <span className="vault-flag" title="Agents may read this password in plain text">
              readable
            </span>
          )}
        </span>
        <span className="vault-row-sub">
          {item.domain}
          {item.username && <> · {item.username}</>}
        </span>
        {shown !== null && <code className="vault-secret">{shown}</code>}
      </div>
      <div className="vault-row-actions">
        {confirming ? (
          <>
            <span className="vault-confirm">Delete {item.label}?</span>
            <button
              className="btn btn-small btn-danger"
              onClick={() => void ipc.vaultDelete(item.id).then(onChanged)}
            >
              Delete
            </button>
            <button className="btn btn-small" onClick={() => setConfirming(false)}>
              Keep
            </button>
          </>
        ) : (
          <>
            {/* Copying is the reason people reveal a password, so it is offered
                without revealing anything. */}
            <button
              className="btn btn-small"
              onClick={() => {
                void ipc.vaultReveal(item.id).then((pw) => {
                  void navigator.clipboard.writeText(pw);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              className="btn btn-small"
              onClick={() => {
                if (shown !== null) return setShown(null);
                void ipc
                  .vaultReveal(item.id)
                  .then(setShown)
                  .catch(() => setShown("(could not read it)"));
              }}
            >
              {shown === null ? "Reveal" : "Hide"}
            </button>
            <button className="btn btn-small" onClick={() => setEditing(true)}>
              Edit
            </button>
            <button className="btn btn-small" onClick={() => setConfirming(true)}>
              Delete
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function VaultSettings() {
  const [status, setStatus] = useState<ipc.VaultStatus | null>(null);
  const [items, setItems] = useState<ipc.VaultItem[]>([]);
  const [approvals, setApprovals] = useState<ipc.VaultApproval[]>([]);
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  /** null = not adding; "" = adding by hand; a host = adding for the open page. */
  const [adding, setAdding] = useState<string | null>(null);
  /** The site in the preview, if one is open. */
  const [pageSite, setPageSite] = useState("");

  const refresh = useCallback(() => {
    void ipc
      .vaultStatus()
      .then((st) => {
        setStatus(st);
        if (!st.unlocked) {
          setItems([]);
          setApprovals([]);
          return;
        }
        void ipc.vaultList().then(setItems).catch(() => setItems([]));
        void ipc.vaultApprovals().then(setApprovals).catch(() => setApprovals([]));
      })
      .catch(() => setStatus(null));
  }, []);
  useEffect(refresh, [refresh]);

  // What the preview has loaded, asked once when the screen opens: the offer to
  // add it is only worth making while that page is still what the user was
  // looking at a moment ago.
  useEffect(() => {
    const tabId = browserViewSnapshots().find((v) => v.wanted)?.tabId;
    if (!tabId) return;
    void ipc
      .browserHere(tabId)
      .then((here) => setPageSite(suggestedDomain(here?.url ?? "")))
      .catch(() => setPageSite(""));
  }, []);

  const run = (p: Promise<unknown>) =>
    p
      .then(() => {
        setErr("");
        setPassphrase("");
        setConfirm("");
        refresh();
      })
      .catch((e) => setErr(String(e)));

  if (!status) return null;

  if (!status.exists) {
    return (
      <Item
        name="Create a vault"
        desc="Logins for the built-in browser, encrypted on this machine with a passphrase only you know. There is no recovery — forget it and the vault is gone, the same trade every password manager makes."
      >
        <form
          className="vault-card"
          onSubmit={(e) => {
            e.preventDefault();
            void run(ipc.vaultCreate(passphrase));
          }}
        >
          <div className="vault-grid">
            <Field label="Passphrase" hint="8 characters or more">
              <input
                type="password"
                autoComplete="new-password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
              />
            </Field>
            <Field label="Again">
              <input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </Field>
          </div>
          {err && <p className="vault-err">{err}</p>}
          <div className="vault-card-actions">
            <button
              className="btn btn-accent"
              type="submit"
              disabled={passphrase.length < 8 || passphrase !== confirm}
            >
              Create vault
            </button>
          </div>
        </form>
      </Item>
    );
  }

  if (!status.unlocked) {
    return (
      <Item
        name="Unlock the vault"
        desc={`It locks itself after ${status.auto_lock_minutes} minutes unused, and whenever Canopy restarts.`}
      >
        <form
          className="vault-card"
          onSubmit={(e) => {
            e.preventDefault();
            void run(ipc.vaultUnlock(passphrase));
          }}
        >
          <Field label="Passphrase">
            <input
              autoFocus
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </Field>
          {err && <p className="vault-err">{err}</p>}
          <div className="vault-card-actions">
            <button className="btn btn-accent" type="submit" disabled={!passphrase}>
              Unlock
            </button>
          </div>
        </form>
      </Item>
    );
  }

  const saved = new Set(items.map((i) => i.domain));
  const offerPage = pageSite && !saved.has(pageSite) && adding === null;

  return (
    <>
      <Item
        name="Logins"
        desc="Canopy types these into the built-in browser. An agent driving that browser signs in with them without ever being told the password."
      >
        <div className="vault-list">
          {items.map((item) => (
            <EntryRow key={item.id} item={item} onChanged={refresh} />
          ))}

          {items.length === 0 && adding === null && (
            <p className="vault-empty">
              Nothing saved yet. Add the site you have open, or enter one by hand.
            </p>
          )}

          {adding !== null ? (
            <EntryForm
              entry={null}
              startDomain={adding || undefined}
              onDone={() => {
                setAdding(null);
                refresh();
              }}
            />
          ) : (
            <div className="vault-add">
              {offerPage && (
                <button className="btn btn-accent" onClick={() => setAdding(pageSite)}>
                  Add {pageSite}
                </button>
              )}
              <button
                className={offerPage ? "btn" : "btn btn-accent"}
                onClick={() => setAdding("")}
              >
                Add a login
              </button>
            </div>
          )}
        </div>
      </Item>

      <Item
        name="Sites agents may use"
        desc="An agent's first attempt on a site asks you. Revoking puts the question back."
      >
        <div className="vault-list">
          {approvals.length === 0 && (
            <p className="vault-empty">No agent has been allowed a site yet.</p>
          )}
          {approvals.map((a) => (
            <div className="vault-row" key={a.domain}>
              <span
                className="vault-tile"
                style={{ "--tile-hue": tint(a.domain) } as React.CSSProperties}
                aria-hidden
              >
                {monogram("", a.domain)}
              </span>
              <div className="vault-row-text">
                <span className="vault-row-title">{a.domain}</span>
                <span className="vault-row-sub">
                  {[a.fill && "sign in", a.read && "read in plain text"]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
              <div className="vault-row-actions">
                <button
                  className="btn btn-small"
                  onClick={() => void ipc.vaultRevoke(a.domain).then(refresh)}
                >
                  Revoke
                </button>
              </div>
            </div>
          ))}
        </div>
      </Item>

      <Item
        name="This vault"
        desc={`${status.entries} saved · locks after ${status.auto_lock_minutes} minutes unused`}
      >
        <div className="tool-bulk">
          <button className="btn btn-small" onClick={() => void run(ipc.vaultLock())}>
            Lock now
          </button>
        </div>
      </Item>
    </>
  );
}
