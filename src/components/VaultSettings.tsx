// Settings → Vault: the logins the embedded browser can sign in with.
//
// Three states, and the screen is really three screens: no vault yet (choose a
// passphrase), locked (type it), unlocked (the list). Keeping them separate is
// deliberate — a single screen that greys itself out invites typing a
// passphrase into a field that is about to be something else.
//
// The passwords are only ever on this screen when the user asks for one, one at
// a time, from a click. Nothing here holds a decrypted list: reveal fetches a
// single value and forgets it when the row collapses.
import { useCallback, useEffect, useState } from "react";
import * as ipc from "../ipc";

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

/** The add/edit form. `entry` is null when adding. */
function EntryForm({
  entry,
  onDone,
}: {
  entry: ipc.VaultItem | null;
  onDone: () => void;
}) {
  const [label, setLabel] = useState(entry?.label ?? "");
  const [domain, setDomain] = useState(entry?.domain ?? "");
  const [username, setUsername] = useState(entry?.username ?? "");
  const [password, setPassword] = useState("");
  const [readable, setReadable] = useState(entry?.readable ?? false);
  const [err, setErr] = useState("");

  const save = async () => {
    try {
      await ipc.vaultSave({
        id: entry?.id,
        label: label.trim() || domain.trim(),
        domain: domain.trim(),
        username: username.trim(),
        // Empty on an edit means "leave the stored password alone", which is
        // what makes fixing a typo in a label safe.
        password: password || (entry ? undefined : ""),
        readable,
      });
      onDone();
    } catch (e) {
      setErr(String(e));
    }
  };

  return (
    <div className="vault-form">
      <input
        autoFocus
        placeholder="Name — GitHub"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
      <input
        placeholder="Site — github.com"
        value={domain}
        onChange={(e) => setDomain(e.target.value)}
      />
      <input
        placeholder="Username or email"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
      />
      <input
        type="password"
        placeholder={entry ? "New password (leave blank to keep)" : "Password"}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <label className="vault-readable">
        <input
          type="checkbox"
          checked={readable}
          onChange={(e) => setReadable(e.target.checked)}
        />
        <span>
          Agents may read this one in plain text
          <span className="set-item-desc">
            Off is right for anything with a login form: Canopy fills it without
            the agent seeing it. Turn it on only for logins no form can take — a
            database URL, an SSH passphrase.
          </span>
        </span>
      </label>
      {err && <p className="vault-err">{err}</p>}
      <div className="tool-bulk">
        <button className="btn btn-accent" onClick={() => void save()} disabled={!domain.trim()}>
          {entry ? "Save" : "Add"}
        </button>
        <button className="btn" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** One row, with the password behind a click. */
function EntryRow({ item, onChanged }: { item: ipc.VaultItem; onChanged: () => void }) {
  const [shown, setShown] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

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
      <div className="vault-row-main">
        <span className="vault-label">{item.label}</span>
        <span className="vault-domain">{item.domain}</span>
        <span className="vault-user">{item.username}</span>
        {item.readable && (
          <span className="vault-flag" title="Agents may read this password in plain text">
            readable
          </span>
        )}
      </div>
      {shown !== null && <code className="vault-secret">{shown}</code>}
      <div className="vault-row-actions">
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
          {shown === null ? "Show" : "Hide"}
        </button>
        <button className="btn btn-small" onClick={() => setEditing(true)}>
          Edit
        </button>
        <button
          className="btn btn-small"
          onClick={() => void ipc.vaultDelete(item.id).then(onChanged)}
        >
          Delete
        </button>
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
  const [adding, setAdding] = useState(false);

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

  // ---- no vault yet ----
  if (!status.exists) {
    return (
      <Item
        name="Create a vault"
        desc="Logins for the built-in browser, encrypted on this machine with a passphrase only you know. There is no recovery: forget the passphrase and the vault is gone, which is the same trade every password manager makes."
      >
        <div className="vault-form">
          <input
            type="password"
            placeholder="Passphrase — at least 8 characters"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
          />
          <input
            type="password"
            placeholder="Again"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          {err && <p className="vault-err">{err}</p>}
          <button
            className="btn btn-accent"
            disabled={passphrase.length < 8 || passphrase !== confirm}
            onClick={() => void run(ipc.vaultCreate(passphrase))}
          >
            Create vault
          </button>
        </div>
      </Item>
    );
  }

  // ---- locked ----
  if (!status.unlocked) {
    return (
      <Item
        name="Unlock the vault"
        desc={`It locks itself after ${status.auto_lock_minutes} minutes of not being used, and whenever Canopy restarts.`}
      >
        <form
          className="vault-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(ipc.vaultUnlock(passphrase));
          }}
        >
          <input
            autoFocus
            type="password"
            placeholder="Passphrase"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
          />
          {err && <p className="vault-err">{err}</p>}
          <button className="btn btn-accent" type="submit" disabled={!passphrase}>
            Unlock
          </button>
        </form>
      </Item>
    );
  }

  // ---- unlocked ----
  return (
    <>
      <Item
        name="Logins"
        desc="Canopy fills these into the built-in browser. An agent driving that browser can sign in with them without ever being told the password — that is what the fill path is for."
      >
        <div className="vault-list">
          {items.length === 0 && !adding && (
            <p className="set-item-desc">Nothing saved yet.</p>
          )}
          {items.map((item) => (
            <EntryRow key={item.id} item={item} onChanged={refresh} />
          ))}
          {adding ? (
            <EntryForm
              entry={null}
              onDone={() => {
                setAdding(false);
                refresh();
              }}
            />
          ) : (
            <button className="btn btn-small" onClick={() => setAdding(true)}>
              Add a login
            </button>
          )}
        </div>
      </Item>

      <Item
        name="Sites agents may use"
        desc="An agent's first attempt on a site asks you. Revoking puts the question back."
      >
        <div className="vault-list">
          {approvals.length === 0 && (
            <p className="set-item-desc">No agent has been allowed a site yet.</p>
          )}
          {approvals.map((a) => (
            <div className="vault-row" key={a.domain}>
              <div className="vault-row-main">
                <span className="vault-label">{a.domain}</span>
                <span className="vault-user">
                  {[a.fill && "fill", a.read && "read in plain text"]
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

      <Item name="This vault" desc={`${status.entries} saved · locks after ${status.auto_lock_minutes} minutes idle`}>
        <div className="tool-bulk">
          <button className="btn btn-small" onClick={() => void run(ipc.vaultLock())}>
            Lock now
          </button>
        </div>
      </Item>
    </>
  );
}
