// Finding the login fields on somebody else's page, and putting a credential
// into them.
//
// This is the part of the vault that faces the open web, so it is written
// against what browsers' own password managers do rather than against what a
// login form ought to look like. Three rules carry most of the weight, in this
// order:
//
//   1. `autocomplete` wins. `username`, `current-password` and `new-password`
//      are the site telling us what its fields are, and no heuristic of ours
//      beats being told. (Chromium's "form styles that Chromium understands".)
//
//   2. Otherwise, proximity: the username is the last visible, editable,
//      text-like input BEFORE the first password field, within the same form.
//      Nearly every login form on the web is shaped that way, and this is the
//      rule that keeps a page's header search box out of it — a naive
//      "first input[type=text] on the page" picks the search box on GitHub,
//      Reddit and half the internet.
//
//   3. Only then, names: id / name / placeholder / label / aria-label scored
//      against the words login fields actually use, with the words that mean
//      something else (search, otp, coupon, card) scoring negative.
//
// Two shapes we deliberately refuse rather than guess at:
//
//   - Sign-up and change-password forms. Two or three password fields, or
//      fields marked `new-password`, mean the page is asking for a password to
//      set, not the one we hold. Typing the stored password into "new password"
//      is worse than doing nothing: it looks like it worked, and it either
//      fails validation against the confirm field or quietly changes nothing.
//      The exception is an explicit `current-password` among them, which is
//      exactly the field we do have.
//
//   - Anything invisible. Hidden inputs are how sites carry CSRF tokens and how
//      bot traps catch fillers that type into everything.
//
// Shadow DOM and same-origin iframes are searched too: `querySelectorAll` sees
// neither, and both are ordinary places for a login form to live. Cross-origin
// frames are unreachable by construction and are reported rather than ignored,
// so a fill that could not happen says why instead of looking like a page with
// no form on it.
(() => {
  const TEXTLIKE = new Set(["text", "email", "tel", "url", "search", ""]);

  /** Words that name a login identifier, and words that mean something else.
   *  Deliberately short: every entry here is a guess, and a wrong guess types a
   *  username into a coupon box. */
  const USER_WORDS = /user|email|e-mail|login|account|acct|identifier|nick|handle|phone|mobile/i;
  // "address" is deliberately absent: "Email Address" is the single most common
  // label a username field carries, and penalising it made this miss the login
  // box on WordPress and on anything else that spells the label out. Postal
  // addresses are caught by the words that actually distinguish them.
  const NOT_USER_WORDS = /search|query|filter|coupon|promo|voucher|card|cvv|expiry|otp|totp|2fa|mfa|captcha|zip|postal|street|address.?line|billing|shipping|first.?name|last.?name|company/i;

  /** Every element of interest, including inside open shadow roots and
   *  same-origin iframes. TreeWalker rather than querySelectorAll because the
   *  latter does not cross a shadow boundary (this is how Bitwarden does it). */
  function collect(root, out, frames) {
    // createTreeWalker belongs to Document, not to ShadowRoot — a shadow root
    // is a DocumentFragment, so the walker has to be made by its document and
    // pointed at it. Getting this wrong finds nothing and looks like a page
    // with no form on it.
    const doc = root.ownerDocument || root;
    if (!doc.createTreeWalker) return;
    const walker = doc.createTreeWalker(root, 1 /* SHOW_ELEMENT */);
    let node = walker.currentNode;
    while (node) {
      if (node.tagName === "INPUT") out.push(node);
      if (node.shadowRoot) collect(node.shadowRoot, out, frames);
      if (node.tagName === "IFRAME") {
        try {
          // Throws for cross-origin, which is the answer we want to report.
          const doc = node.contentDocument;
          if (doc) collect(doc, out, frames);
          else frames.blocked += 1;
        } catch {
          frames.blocked += 1;
        }
      }
      node = walker.nextNode();
    }
  }

  /** Is this field one a person could type into right now?
   *
   *  Geometry is only consulted when the document actually has layout — under a
   *  test renderer every box is 0×0, and a visibility rule that fails closed
   *  there would make the whole suite vacuous. Attributes and computed styles
   *  are checked always. */
  function usable(el, hasLayout) {
    if (el.disabled || el.readOnly) return false;
    if (el.type === "hidden") return false;
    if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return false;
    const win = el.ownerDocument.defaultView;
    let node = el;
    while (node && node.nodeType === 1) {
      const style = win && win.getComputedStyle ? win.getComputedStyle(node) : null;
      if (style) {
        if (style.display === "none" || style.visibility === "hidden") return false;
        if (style.opacity === "0") return false;
      }
      node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
    }
    if (hasLayout) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
      // Parked off-screen: a common bot trap, and never a field a user fills.
      if (rect.bottom < -500 || rect.right < -500) return false;
    }
    return true;
  }

  /** Everything the page says about a field, lowercased into one haystack. */
  function describe(el) {
    const bits = [
      el.name,
      el.id,
      el.placeholder,
      el.getAttribute("aria-label"),
      el.getAttribute("autocomplete"),
      el.className,
      el.type,
    ];
    const doc = el.ownerDocument;
    if (el.id && doc.querySelector) {
      // CSS.escape is absent in some embedded engines; a manual quote is fine
      // because we are matching an attribute value, not building a selector.
      const labels = doc.querySelectorAll("label[for]");
      for (const label of labels) {
        if (label.getAttribute("for") === el.id) bits.push(label.textContent);
      }
    }
    const wrapping = el.closest ? el.closest("label") : null;
    if (wrapping) bits.push(wrapping.textContent);
    const describedBy = el.getAttribute("aria-labelledby");
    if (describedBy) {
      for (const id of describedBy.split(/\s+/)) {
        const node = doc.getElementById && doc.getElementById(id);
        if (node) bits.push(node.textContent);
      }
    }
    return bits.filter(Boolean).join(" ").toLowerCase();
  }

  /** How much this input looks like a place to type an account name. */
  function userScore(el) {
    const auto = (el.getAttribute("autocomplete") || "").toLowerCase();
    if (auto.includes("username")) return 100;
    if (auto.includes("email")) return 60;
    // autocomplete="off" is a request about the browser's own autofill, not a
    // statement that the field is not a username — banks and airlines set it on
    // exactly the field we need. Neutral, not disqualifying. "new-password" is
    // different: that field is for a password being chosen.
    if (auto === "new-password") return -50;
    const text = describe(el);
    let score = 0;
    if (USER_WORDS.test(text)) score += 20;
    if (NOT_USER_WORDS.test(text)) score -= 40;
    if (el.type === "email") score += 25;
    if (el.type === "search") score -= 60;
    if (el.getAttribute("role") === "searchbox") score -= 60;
    return score;
  }

  /** The form an element belongs to, treated as its scope. Falls back to the
   *  document so a form-less login (a div with two inputs and a button, which
   *  single-page apps write constantly) still works. */
  const scopeOf = (el) => el.form || el.ownerDocument;

  /** Decide what to fill. Returns the two elements, or a reason not to. */
  function findFields() {
    const inputs = [];
    const frames = { blocked: 0 };
    collect(document, inputs, frames);
    const hasLayout =
      !!document.body && document.body.getClientRects && document.body.getClientRects().length > 0;
    const visible = inputs.filter((el) => usable(el, hasLayout));

    const passwords = visible.filter((el) => el.type === "password");
    const marked = (el, value) =>
      (el.getAttribute("autocomplete") || "").toLowerCase().includes(value);

    // Sign-up detection is per form, not per page. A sign-in panel beside a
    // "create an account" panel is one of the most common layouts there is
    // (Magento, WooCommerce, half of enterprise SSO), and counting password
    // fields across the whole document refuses that page outright — the live
    // harness caught exactly this.
    const groups = [];
    for (const field of passwords) {
      const scope = field.form || field.ownerDocument;
      const existing = groups.find((g) => g.scope === scope);
      if (existing) existing.fields.push(field);
      else groups.push({ scope, fields: [field] });
    }

    /** The field in this group that holds the password the user already has,
     *  or null when the group is asking for a password to set. */
    const signInField = (group) => {
      const current = group.fields.find((el) => marked(el, "current-password"));
      if (current) return current;
      if (group.fields.length > 1) return null; // password + confirm
      return marked(group.fields[0], "new-password") ? null : group.fields[0];
    };

    let password = null;
    for (const group of groups) {
      const candidate = signInField(group);
      if (candidate) {
        password = candidate;
        break;
      }
    }
    if (!password && passwords.length > 0) {
      return { skip: "signup", frames };
    }

    // The username. Two passes: the password's own form first, then the whole
    // document — single-page apps routinely render the identifier outside the
    // <form> the password sits in, and a form-scoped search finds nothing there.
    // The wider pass takes form-less inputs (a single-page app that renders the
    // identifier outside the <form> the password sits in) but never an input
    // belonging to a DIFFERENT form: that field is part of that form's job. On
    // a change-password page, the loose version typed the username into the
    // profile form's "display name" beside it.
    const textLike = visible
      .filter((el) => TEXTLIKE.has(el.type || ""))
      .filter((el) => !el.form || !password || !password.form || el.form === password.form);
    const inForm =
      password && password.form
        ? textLike.filter((el) => el.form === password.form)
        : textLike;

    const marked_username = (list) => list.find((el) => marked(el, "username")) || null;
    const byProximity = (list) => {
      if (!password) return null;
      const before = list.filter(
        (el) =>
          el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING &&
          userScore(el) > -20,
      );
      return before[before.length - 1] || null;
    };
    const byName = (list) => {
      const ranked = list
        .map((el) => ({ el, score: userScore(el) }))
        .filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score);
      return ranked.length ? ranked[0].el : null;
    };

    let username =
      marked_username(inForm) ||
      marked_username(textLike) ||
      byProximity(inForm) ||
      byProximity(textLike) ||
      // No password field (step one of a two-step flow), or nothing before it
      // in the markup (a visually reordered form): fall back to the name.
      byName(inForm) ||
      byName(textLike);

    return { username, password, frames };
  }

  /** Set a value the way a person would, so a framework notices.
   *
   *  React (and Vue, and Angular) track the value they last wrote; assigning
   *  `el.value` updates the DOM but not their copy, so the field looks filled
   *  and the form submits empty. Going through the prototype's own setter and
   *  then firing input/change is what the frameworks are listening for. */
  function setValue(el, value) {
    // localName rather than instanceof: an input inside a same-origin iframe is
    // an instance of *that* document's HTMLInputElement, not this one's, so the
    // instanceof answers false for every field we reach through a frame.
    const proto =
      el.localName === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    el.focus();
    setter.call(el, value);
    for (const type of ["input", "change"]) {
      el.dispatchEvent(new Event(type, { bubbles: true }));
    }
    // Some forms only validate on blur, and a field that never blurs stays in
    // its "untouched" state with the submit button disabled.
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    // Did it stick? A framework that owns this field can reject the write and
    // render its own state straight back, which leaves the field empty. Saying
    // "filled" then is worse than saying nothing: the caller submits a blank
    // form and the page, not Canopy, gets blamed for it.
    return el.value === value;
  }

  window.__canopyVaultFill = function (usernameValue, passwordValue, dryRun) {
    const found = findFields();
    if (found.skip === "signup") {
      return JSON.stringify({
        filled: [],
        skipped: "signup",
        why: "this looks like a sign-up or change-password form, not a sign-in — it asks for a password to set, and the one saved here is the current one",
        frames: found.frames.blocked,
      });
    }
    const filled = [];
    const refused = [];
    const put = (el, value, name) => {
      if (dryRun || setValue(el, value)) filled.push(name);
      else refused.push(name);
    };
    if (found.username && usernameValue) put(found.username, usernameValue, "username");
    if (found.password) put(found.password, passwordValue, "password");
    // Leave the caret where a person would carry on from.
    if (!dryRun && found.password && !found.username) found.password.focus();
    return JSON.stringify({
      filled,
      refused: refused.length ? refused : undefined,
      form: !!(found.password && found.password.form),
      frames: found.frames.blocked,
      why: refused.length
        ? `the page took the ${refused.join(" and ")} field back to empty straight after it was filled — it is usually still starting up, so let it finish loading and fill again`
        : filled.length
          ? undefined
          : found.frames.blocked
            ? "the login form is in a cross-origin frame, which Canopy cannot reach from the page"
            : "no login fields on this page — it may not have rendered the form yet",
    });
  };
})();
