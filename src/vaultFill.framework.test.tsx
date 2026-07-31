// Scratch repro: does the shipped fill script survive a React controlled form?
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useState } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";

const SCRIPT = readFileSync(resolve(process.cwd(), "src-tauri/src/vault_fill.js"), "utf8");

function Login({ onSubmit }: { onSubmit: (u: string, p: string) => void }) {
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(user, pass);
      }}
    >
      <input
        name="username"
        autoComplete="username"
        value={user}
        onChange={(e) => setUser(e.target.value)}
      />
      <input
        name="password"
        type="password"
        autoComplete="current-password"
        value={pass}
        onChange={(e) => setPass(e.target.value)}
      />
      <button type="submit">Sign in</button>
    </form>
  );
}

it("fills a React controlled login form so component state actually changes", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  let submitted: [string, string] | null = null;
  const root = createRoot(host);
  await act(async () => {
    root.render(<Login onSubmit={(u, p) => (submitted = [u, p])} />);
  });

  await act(async () => {
    // eslint-disable-next-line no-eval
    (0, eval)(SCRIPT);
    (
      window as unknown as { __canopyVaultFill: (u: string, p: string) => string }
    ).__canopyVaultFill("sam", "hunter2");
  });

  const u = document.querySelector('[name="username"]') as HTMLInputElement;
  const p = document.querySelector('[name="password"]') as HTMLInputElement;
  // The DOM says filled...
  expect(u.value, "username DOM value").toBe("sam");
  expect(p.value, "password DOM value").toBe("hunter2");

  // ...but the only thing that matters is what the form submits.
  await act(async () => {
    (document.querySelector("form") as HTMLFormElement).requestSubmit();
  });
  expect(submitted, "what React's state handed to onSubmit").toEqual(["sam", "hunter2"]);
});
