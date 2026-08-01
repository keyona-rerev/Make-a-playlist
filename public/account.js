/* Shared sign-in chip.
 *
 * The account layer is optional by design: everything on this site works
 * signed out, and every link already handed out keeps working. Signing in
 * only adds a durable home for the playlists you own, so this renders as a
 * quiet chip rather than a gate.
 *
 * Pages opt in with a container: <div data-account></div>. Both stylesheets
 * carry the .account-* rules so it looks native on either.
 */
(function () {
  const STORE = "map.playlists";

  function savedLocally() {
    try {
      return JSON.parse(localStorage.getItem(STORE) || "[]");
    } catch {
      return [];
    }
  }

  // A fragment never reaches the server, so an edit key cannot ride along in
  // the OAuth round trip. It is already in localStorage from the first visit,
  // so the key is put back on return instead of being carried through.
  function returnPath() {
    return location.pathname + location.search;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function renderSignedOut(slot, state) {
    if (!state.signInAvailable) return;
    const link = el("a", "account-link", "Sign in");
    link.href = "/auth/google?next=" + encodeURIComponent(returnPath());
    link.title = "Keeps your playlists with you across devices";
    slot.replaceChildren(link);
  }

  function renderSignedIn(slot, state) {
    const wrap = el("div", "account-chip");

    if (state.user.avatar) {
      const img = el("img", "account-avatar");
      img.src = state.user.avatar;
      img.alt = "";
      img.referrerPolicy = "no-referrer";
      wrap.appendChild(img);
    }

    const name = el("span", "account-name", state.user.name || state.user.email);
    name.title = state.user.email;

    const out = el("button", "account-signout", "Sign out");
    out.type = "button";
    out.addEventListener("click", async () => {
      out.disabled = true;
      out.textContent = "Signing out";
      try {
        await fetch("/auth/signout", { method: "POST" });
      } catch {
        /* Reloading below re-reads the real state either way. */
      }
      location.reload();
    });

    wrap.append(name, out);
    slot.replaceChildren(wrap);
  }

  window.accountReady = (async function () {
    let state = { signInAvailable: false, user: null };
    try {
      const res = await fetch("/api/me");
      if (res.ok) state = await res.json();
    } catch {
      /* Signed out is the safe assumption, and every page works that way. */
    }

    const slot = document.querySelector("[data-account]");
    if (slot) {
      if (state.user) renderSignedIn(slot, state);
      else renderSignedOut(slot, state);
    }

    // "Your playlists" is hidden until there is something to put in it —
    // either an account, or a playlist remembered on this device.
    const mine = document.getElementById("navMine");
    if (mine && (state.user || savedLocally().length)) mine.hidden = false;

    return state;
  })();
})();
