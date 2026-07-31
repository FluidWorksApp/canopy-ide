// What the fill script does to the shapes login forms actually come in.
//
// The script under test is the one that ships: read from
// src-tauri/src/vault_fill.js and evaluated in this document, so there is one
// copy of the logic and no chance of the tested version drifting from the
// injected one.
//
// Each fixture is a real pattern, named for where it comes from. The ones that
// matter most are the negatives — a filler that types into everything is worse
// than one that types into nothing, because a wrong fill submits.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

// The shipped script, not a copy of it: this is the same file vault.rs embeds
// with include_str!, so the tested logic and the injected logic cannot drift.
const SCRIPT = readFileSync(
  resolve(process.cwd(), "src-tauri/src/vault_fill.js"),
  "utf8",
);

interface Result {
  filled: string[];
  refused?: string[];
  skipped?: string;
  why?: string;
  form?: boolean;
  frames?: number;
}

/** Load a page, run the fill, and report what it did. */
function fill(html: string, user = "sam", pass = "hunter2"): Result {
  document.body.innerHTML = html;
  // eslint-disable-next-line no-eval
  (0, eval)(SCRIPT);
  const raw = (
    window as unknown as {
      __canopyVaultFill: (u: string, p: string, dry?: boolean) => string;
    }
  ).__canopyVaultFill(user, pass);
  return JSON.parse(raw);
}

const valueOf = (selector: string) =>
  (document.querySelector(selector) as HTMLInputElement | null)?.value ?? null;

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("the shapes that should fill", () => {
  it("a plain login form", () => {
    const out = fill(`
      <form>
        <input name="username" type="text">
        <input name="password" type="password">
        <button>Sign in</button>
      </form>`);
    expect(out.filled).toEqual(["username", "password"]);
    expect(valueOf('[name="username"]')).toBe("sam");
    expect(valueOf('[name="password"]')).toBe("hunter2");
  });

  it("a page with a header search box before the form — the GitHub shape", () => {
    // The case a first-input-on-the-page filler gets wrong on half the web.
    const out = fill(`
      <header><input type="text" name="q" placeholder="Search or jump to…"></header>
      <form action="/session">
        <input type="text" name="login" id="login_field">
        <input type="password" name="password" id="password">
      </form>`);
    expect(out.filled).toEqual(["username", "password"]);
    expect(valueOf('[name="q"]')).toBe("");
    expect(valueOf("#login_field")).toBe("sam");
  });

  it("autocomplete attributes, which beat every heuristic", () => {
    // The username is named nothing useful and sits after the password; the
    // attribute is the site telling us, so it wins.
    const out = fill(`
      <form>
        <input type="password" autocomplete="current-password" id="p">
        <input type="text" autocomplete="username" id="u" name="field_28b">
      </form>`);
    expect(out.filled).toEqual(["username", "password"]);
    expect(valueOf("#u")).toBe("sam");
  });

  it("an email-typed identifier with no useful name", () => {
    const out = fill(`
      <div class="card">
        <input type="email" id="a">
        <input type="password" id="b">
      </div>`);
    expect(out.filled).toEqual(["username", "password"]);
    expect(valueOf("#a")).toBe("sam");
  });

  it("no <form> element at all — the single-page-app shape", () => {
    const out = fill(`
      <div>
        <input type="text" placeholder="Email" id="a">
        <input type="password" placeholder="Password" id="b">
        <div role="button">Continue</div>
      </div>`);
    expect(out.filled).toEqual(["username", "password"]);
    expect(out.form).toBe(false);
  });

  it("step one of a two-step flow: username, no password field", () => {
    const out = fill(`<form><input type="email" id="ident"><button>Next</button></form>`);
    expect(out.filled).toEqual(["username"]);
    expect(valueOf("#ident")).toBe("sam");
  });

  it("step two: a password field beside a hidden username, as Chromium advises", () => {
    const out = fill(`
      <form>
        <input type="hidden" name="username" value="sam">
        <input type="password" id="p" autocomplete="current-password">
      </form>`);
    expect(out.filled).toEqual(["password"]);
    expect(valueOf("#p")).toBe("hunter2");
  });

  it("a change-password form, where only the current password is ours to give", () => {
    const out = fill(`
      <form>
        <input type="password" autocomplete="current-password" id="old">
        <input type="password" autocomplete="new-password" id="new">
        <input type="password" autocomplete="new-password" id="confirm">
      </form>`);
    expect(out.filled).toEqual(["password"]);
    expect(valueOf("#old")).toBe("hunter2");
    expect(valueOf("#new")).toBe("");
    expect(valueOf("#confirm")).toBe("");
  });

  it("a form inside an open shadow root", () => {
    document.body.innerHTML = `<div id="host"></div>`;
    const shadow = (document.getElementById("host") as HTMLElement).attachShadow({
      mode: "open",
    });
    shadow.innerHTML = `
      <form>
        <input type="text" name="user">
        <input type="password" name="pass">
      </form>`;
    (0, eval)(SCRIPT);
    const out: Result = JSON.parse(
      (
        window as unknown as { __canopyVaultFill: (u: string, p: string) => string }
      ).__canopyVaultFill("sam", "hunter2"),
    );
    expect(out.filled).toEqual(["username", "password"]);
    expect((shadow.querySelector('[name="user"]') as HTMLInputElement).value).toBe("sam");
  });

  it("a form in a same-origin iframe", () => {
    document.body.innerHTML = `<iframe id="f"></iframe>`;
    const frame = document.getElementById("f") as HTMLIFrameElement;
    frame.contentDocument!.body.innerHTML = `
      <form><input type="text" name="u"><input type="password" name="p"></form>`;
    (0, eval)(SCRIPT);
    const out: Result = JSON.parse(
      (
        window as unknown as { __canopyVaultFill: (u: string, p: string) => string }
      ).__canopyVaultFill("sam", "hunter2"),
    );
    expect(out.filled).toEqual(["username", "password"]);
    expect(
      (frame.contentDocument!.querySelector('[name="u"]') as HTMLInputElement).value,
    ).toBe("sam");
  });
});

describe("the shapes that should not fill", () => {
  it("refuses a sign-up form rather than typing the old password into it", () => {
    const out = fill(`
      <form>
        <input type="email" name="email">
        <input type="password" name="password" autocomplete="new-password">
        <input type="password" name="confirm" autocomplete="new-password">
      </form>`);
    expect(out.filled).toEqual([]);
    expect(out.skipped).toBe("signup");
    expect(out.why).toMatch(/sign-up or change-password/);
    expect(valueOf('[name="password"]')).toBe("");
    expect(valueOf('[name="email"]')).toBe("");
  });

  it("refuses a bare password + confirm pair, marked or not", () => {
    const out = fill(`
      <form>
        <input type="password" name="p1">
        <input type="password" name="p2">
      </form>`);
    expect(out.filled).toEqual([]);
    expect(out.skipped).toBe("signup");
  });

  it("refuses a lone field the site calls new-password", () => {
    const out = fill(`<form><input type="password" autocomplete="new-password"></form>`);
    expect(out.skipped).toBe("signup");
  });

  it("leaves hidden decoys alone and fills the real field", () => {
    // Bot traps: display:none, aria-hidden, and a disabled twin.
    const out = fill(`
      <form>
        <input type="text" name="user_trap" style="display:none">
        <input type="text" name="email_trap" aria-hidden="true">
        <input type="text" name="username_disabled" disabled>
        <input type="text" name="username">
        <input type="password" name="password">
      </form>`);
    expect(out.filled).toEqual(["username", "password"]);
    expect(valueOf('[name="user_trap"]')).toBe("");
    expect(valueOf('[name="email_trap"]')).toBe("");
    expect(valueOf('[name="username_disabled"]')).toBe("");
    expect(valueOf('[name="username"]')).toBe("sam");
  });

  it("never types into a one-time-code or card field near a password", () => {
    const out = fill(`
      <form>
        <input type="text" name="otp" autocomplete="one-time-code">
        <input type="password" name="password" autocomplete="current-password">
      </form>`);
    expect(out.filled).toEqual(["password"]);
    expect(valueOf('[name="otp"]')).toBe("");
  });

  it("says so when there is nothing to fill", () => {
    const out = fill(`<main><p>Signed in as sam.</p></main>`);
    expect(out.filled).toEqual([]);
    expect(out.why).toMatch(/no login fields/);
  });
});

describe("how the value is set", () => {
  it("goes through the native setter and fires what a framework listens for", () => {
    document.body.innerHTML = `
      <form><input type="text" id="u"><input type="password" id="p"></form>`;
    const seen: string[] = [];
    for (const type of ["input", "change", "blur"]) {
      document.getElementById("u")!.addEventListener(type, () => seen.push(type));
    }
    (0, eval)(SCRIPT);
    (
      window as unknown as { __canopyVaultFill: (u: string, p: string) => string }
    ).__canopyVaultFill("sam", "hunter2");
    // The fourth event is real: focus moves on to the password field, and the
    // browser blurs the username for itself.
    expect(seen.slice(0, 3)).toEqual(["input", "change", "blur"]);
  });

  it("reports which fields it would fill without touching them, on a dry run", () => {
    document.body.innerHTML = `
      <form><input type="text" id="u"><input type="password" id="p"></form>`;
    (0, eval)(SCRIPT);
    const out: Result = JSON.parse(
      (
        window as unknown as {
          __canopyVaultFill: (u: string, p: string, d: boolean) => string;
        }
      ).__canopyVaultFill("sam", "hunter2", true),
    );
    expect(out.filled).toEqual(["username", "password"]);
    expect(valueOf("#u")).toBe("");
  });
});

describe("shapes taken from real sign-in pages", () => {
  it("WordPress: user_login / user_pass with wrapping labels", () => {
    const out = fill(`
      <form name="loginform" id="loginform">
        <p><label for="user_login">Username or Email Address</label>
        <input type="text" name="log" id="user_login"></p>
        <p><label for="user_pass">Password</label>
        <input type="password" name="pwd" id="user_pass"></p>
      </form>`);
    expect(out.filled).toEqual(["username", "password"]);
    expect(valueOf("#user_login")).toBe("sam");
  });

  it("Microsoft/Okta step one: the password field exists but is hidden", () => {
    // Both render the whole form up front and reveal step two with CSS. Typing
    // into the hidden password box fills a field the user cannot see, and the
    // page submits step one without it.
    const out = fill(`
      <form>
        <input type="email" name="loginfmt" id="i0116">
        <div style="display:none">
          <input type="password" name="passwd" id="i0118">
        </div>
        <button>Next</button>
      </form>`);
    expect(out.filled).toEqual(["username"]);
    expect(valueOf("#i0116")).toBe("sam");
    expect(valueOf("#i0118")).toBe("");
  });

  it("the login form is the second form on the page", () => {
    const out = fill(`
      <form id="newsletter"><input type="email" name="newsletter_email"></form>
      <form id="signin">
        <input type="text" name="username">
        <input type="password" name="password">
      </form>`);
    expect(out.filled).toEqual(["username", "password"]);
    expect(valueOf('[name="newsletter_email"]')).toBe("");
    expect(valueOf('#signin [name="username"]')).toBe("sam");
  });

  it("a search box inside the same form as the password", () => {
    const out = fill(`
      <form>
        <input type="search" name="site_search" placeholder="Search">
        <input type="text" name="email">
        <input type="password" name="password">
      </form>`);
    expect(out.filled).toEqual(["username", "password"]);
    expect(valueOf('[name="site_search"]')).toBe("");
    expect(valueOf('[name="email"]')).toBe("sam");
  });

  it("the username sits after the password in the markup", () => {
    // Rare, and real (bitwarden/clients#709): visually reordered with CSS. The
    // proximity rule finds nothing before the password, so the name decides.
    const out = fill(`
      <div class="flex-col-reverse">
        <input type="password" id="p">
        <input type="text" name="email" id="u">
      </div>`);
    expect(out.filled).toEqual(["username", "password"]);
    expect(valueOf("#u")).toBe("sam");
  });

  it("the username input is outside the form the password is in", () => {
    // Single-page apps that render the identifier above a <form> wrapper.
    const out = fill(`
      <input type="text" name="username" id="u">
      <form><input type="password" id="p"></form>`);
    expect(out.filled).toEqual(["username", "password"]);
    expect(valueOf("#u")).toBe("sam");
  });

  it("a phone-number identifier", () => {
    const out = fill(`
      <form>
        <input type="tel" name="mobile" id="u">
        <input type="password" id="p">
      </form>`);
    expect(out.filled).toEqual(["username", "password"]);
    expect(valueOf("#u")).toBe("sam");
  });

  it("a field named nothing, labelled by aria-labelledby", () => {
    const out = fill(`
      <form>
        <span id="lbl">Email address</span>
        <input type="text" aria-labelledby="lbl" id="u">
        <input type="password" id="p">
      </form>`);
    expect(out.filled).toEqual(["username", "password"]);
    expect(valueOf("#u")).toBe("sam");
  });

  it("a two-factor page: a code field and nothing else", () => {
    // Neither field is ours. Filling the code box with a username is the kind
    // of wrong fill that gets an account locked.
    const out = fill(`
      <form><input type="text" name="otp_code" autocomplete="one-time-code"></form>`);
    expect(out.filled).toEqual([]);
    expect(valueOf('[name="otp_code"]')).toBe("");
  });

  it("a checkout page with a card field beside a password", () => {
    const out = fill(`
      <form>
        <input type="text" name="cardnumber" autocomplete="cc-number">
        <input type="text" name="username">
        <input type="password" name="password">
      </form>`);
    expect(out.filled).toEqual(["username", "password"]);
    expect(valueOf('[name="cardnumber"]')).toBe("");
  });

  it("reports a cross-origin frame instead of claiming there is no form", () => {
    document.body.innerHTML = `<iframe id="f"></iframe>`;
    const frame = document.getElementById("f") as HTMLIFrameElement;
    // What a cross-origin frame looks like from the outside: touching the
    // document throws.
    Object.defineProperty(frame, "contentDocument", {
      get() {
        throw new DOMException("cross-origin", "SecurityError");
      },
    });
    (0, eval)(SCRIPT);
    const out: Result = JSON.parse(
      (
        window as unknown as { __canopyVaultFill: (u: string, p: string) => string }
      ).__canopyVaultFill("sam", "hunter2"),
    );
    expect(out.filled).toEqual([]);
    expect(out.frames).toBe(1);
    expect(out.why).toMatch(/cross-origin frame/);
  });
});

describe("the awkward ones", () => {
  it("still refuses a postal address field", () => {
    // The fix for "Email Address" must not have opened the door to this.
    const out = fill(`
      <form>
        <input type="text" name="address_line1" placeholder="Address line 1">
        <input type="password" name="password">
      </form>`);
    expect(out.filled).toEqual(["password"]);
    expect(valueOf('[name="address_line1"]')).toBe("");
  });

  it("fills a username the site marked autocomplete=off", () => {
    // Banks and airlines set autocomplete="off" to defeat browser autofill. It
    // is a request about autofill, not a statement that the field is not a
    // username — treating it as disqualifying leaves those sites unfillable.
    const out = fill(`
      <form>
        <input type="text" name="username" autocomplete="off" id="u">
        <input type="password" name="password" autocomplete="off" id="p">
      </form>`);
    expect(out.filled).toEqual(["username", "password"]);
    expect(valueOf("#u")).toBe("sam");
  });

  it("does not mistake a coupon box for a username", () => {
    const out = fill(`
      <form>
        <input type="text" name="coupon_code" placeholder="Promo code">
        <input type="password" name="password">
      </form>`);
    expect(out.filled).toEqual(["password"]);
    expect(valueOf('[name="coupon_code"]')).toBe("");
  });

  it("picks the visible login form when a hidden one is also on the page", () => {
    // A modal sign-in rendered but not shown, plus the inline one.
    const out = fill(`
      <div id="modal" style="display:none">
        <form><input type="text" name="modal_user"><input type="password" name="modal_pass"></form>
      </div>
      <form id="inline">
        <input type="text" name="user"><input type="password" name="pass">
      </form>`);
    expect(out.filled).toEqual(["username", "password"]);
    expect(valueOf('[name="modal_user"]')).toBe("");
    expect(valueOf('[name="user"]')).toBe("sam");
  });

  it("leaves a readonly identifier alone and still fills the password", () => {
    // Some sites show the signed-in-as address as a readonly field on step two.
    const out = fill(`
      <form>
        <input type="text" name="email" value="sam@example.com" readonly>
        <input type="password" name="password">
      </form>`);
    expect(out.filled).toEqual(["password"]);
    expect(valueOf('[name="email"]')).toBe("sam@example.com");
  });

  it("a password in a shadow root with the username in the light DOM", () => {
    document.body.innerHTML = `<input type="text" name="user" id="u"><div id="host"></div>`;
    const shadow = (document.getElementById("host") as HTMLElement).attachShadow({
      mode: "open",
    });
    shadow.innerHTML = `<input type="password" name="pass">`;
    (0, eval)(SCRIPT);
    const out: Result = JSON.parse(
      (
        window as unknown as { __canopyVaultFill: (u: string, p: string) => string }
      ).__canopyVaultFill("sam", "hunter2"),
    );
    expect(out.filled).toEqual(["username", "password"]);
    expect(valueOf("#u")).toBe("sam");
  });

  it("handles a page with no inputs at all without throwing", () => {
    const out = fill(`<div><a href="/login">Sign in</a></div>`);
    expect(out.filled).toEqual([]);
    expect(out.why).toBeTruthy();
  });

  it("treats autocomplete values case-insensitively", () => {
    const out = fill(`
      <form>
        <input type="text" AUTOCOMPLETE="Username" id="u">
        <input type="password" AUTOCOMPLETE="Current-Password" id="p">
      </form>`);
    expect(out.filled).toEqual(["username", "password"]);
  });
});

describe("more than one form on the page", () => {
  it("fills the sign-in panel on a page that also offers registration", () => {
    // The shape the live harness caught: counting password fields across the
    // document made this look like a sign-up form and refused the whole page.
    const out = fill(`
      <div class="login-col">
        <form id="signin">
          <input type="text" name="email" id="li_email">
          <input type="password" name="password" id="li_pass">
          <button>Sign in</button>
        </form>
      </div>
      <div class="register-col">
        <form id="register">
          <input type="email" name="reg_email" id="reg_email">
          <input type="password" name="reg_password" autocomplete="new-password" id="reg_p1">
          <input type="password" name="reg_confirm" autocomplete="new-password" id="reg_p2">
        </form>
      </div>`);
    expect(out.filled).toEqual(["username", "password"]);
    expect(valueOf("#li_email")).toBe("sam");
    expect(valueOf("#li_pass")).toBe("hunter2");
    // Nothing in the registration panel is touched.
    expect(valueOf("#reg_email")).toBe("");
    expect(valueOf("#reg_p1")).toBe("");
    expect(valueOf("#reg_p2")).toBe("");
  });

  it("prefers the sign-in form even when registration comes first", () => {
    const out = fill(`
      <form id="register">
        <input type="email" name="reg_email" id="reg_email">
        <input type="password" autocomplete="new-password" id="reg_p1">
        <input type="password" autocomplete="new-password" id="reg_p2">
      </form>
      <form id="signin">
        <input type="text" name="username" id="li_user">
        <input type="password" name="password" id="li_pass">
      </form>`);
    expect(out.filled).toEqual(["username", "password"]);
    expect(valueOf("#li_user")).toBe("sam");
    expect(valueOf("#reg_email")).toBe("");
  });

  it("refuses when every form on the page is a sign-up form", () => {
    const out = fill(`
      <form><input type="password" autocomplete="new-password"><input type="password" autocomplete="new-password"></form>
      <form><input type="password" name="p1"><input type="password" name="p2"></form>`);
    expect(out.filled).toEqual([]);
    expect(out.skipped).toBe("signup");
  });

  it("takes the change-password form's current-password field, not the new ones", () => {
    const out = fill(`
      <form id="profile"><input type="text" name="display_name" id="dn"></form>
      <form id="pw">
        <input type="password" autocomplete="current-password" id="cur">
        <input type="password" autocomplete="new-password" id="new1">
        <input type="password" autocomplete="new-password" id="new2">
      </form>`);
    expect(out.filled).toContain("password");
    expect(valueOf("#cur")).toBe("hunter2");
    expect(valueOf("#new1")).toBe("");
    expect(valueOf("#dn")).toBe("");
  });
});

// A fill that did not take must not be reported as one that did.
//
// This is the failure that sends a caller on to submit a blank form: the script
// finds both fields, writes to both, and the page — still starting up, or
// owning the field from a framework — puts them straight back to empty. Saying
// "filled" there blames the page for what the fill did not do.
describe("reporting what actually stuck", () => {
  /** A field whose owner rejects writes it did not make, the way a controlled
   *  component re-renders its own (still empty) state over the top. */
  const controlled = (selector: string) => {
    const el = document.querySelector(selector) as HTMLInputElement;
    el.addEventListener("input", () => {
      el.value = "";
    });
  };

  const runFill = (user = "sam", pass = "hunter2"): Result => {
    // eslint-disable-next-line no-eval
    (0, eval)(SCRIPT);
    return JSON.parse(
      (
        window as unknown as {
          __canopyVaultFill: (u: string, p: string, dry?: boolean) => string;
        }
      ).__canopyVaultFill(user, pass),
    );
  };

  it("reports a field the page took back as refused, not filled", () => {
    document.body.innerHTML = `
      <form>
        <input name="username" autocomplete="username">
        <input name="password" type="password" autocomplete="current-password">
      </form>`;
    controlled('[name="password"]');
    const out = runFill();

    expect(out.filled).toEqual(["username"]);
    expect(out.refused).toEqual(["password"]);
    expect(out.why).toMatch(/took the password field back to empty/);
  });

  it("says so when the page takes back everything", () => {
    document.body.innerHTML = `
      <form>
        <input name="username" autocomplete="username">
        <input name="password" type="password" autocomplete="current-password">
      </form>`;
    controlled('[name="username"]');
    controlled('[name="password"]');
    const out = runFill();

    expect(out.filled).toEqual([]);
    expect(out.refused).toEqual(["username", "password"]);
  });

  it("still reports a fill that stuck", () => {
    document.body.innerHTML = `
      <form>
        <input name="username" autocomplete="username">
        <input name="password" type="password" autocomplete="current-password">
      </form>`;
    const out = runFill();
    expect(out.filled).toEqual(["username", "password"]);
    expect(out.refused).toBeUndefined();
    expect(out.why).toBeUndefined();
  });
});
