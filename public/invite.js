/* Sending someone a link that lets them add songs.
 *
 * The link is minted by the server each time rather than read off whatever
 * this browser happens to have saved. Only a hash of the original edit key is
 * stored, so an owner who signed in on a new device — or who simply claimed
 * their own playlist — had no link to hand out and no way to get one without
 * replacing the link they had already sent people. Each invite is its own
 * token and stands alongside the rest.
 *
 * The wording is the playlist's, not this file's. The default below asks for
 * a song and a note, which is the general case; a playlist made for an
 * occasion is asking for something more particular than that, and the only
 * person who knows what is the one sending the link out. So an owner can
 * write their own, and it is stored on the playlist rather than on whichever
 * device they happened to write it from.
 */
window.playlistInvite = (function () {
  const DEFAULT_MESSAGE =
    `I am putting together a playlist called “{title}”, and every song on it comes ` +
    `with a note about why it is there.\n\n` +
    `Add one here — the link lets you add songs, so keep it to yourself:\n{link}\n`;

  // split/join rather than replace, so a title containing $& or $1 goes in
  // literally instead of being read as a replacement pattern.
  const fill = (text, token, value) => text.split(token).join(value);

  function message(title, url, custom) {
    const raw = String(custom || "").trim() || DEFAULT_MESSAGE;
    const withTitle = fill(raw, "{title}", title || "");

    // The link is the one thing an invite cannot do without, so leaving the
    // token out is treated as "put it at the end" rather than as an error
    // that quietly sends someone a message they cannot act on.
    if (withTitle.includes("{link}")) return fill(withTitle, "{link}", url);
    return withTitle.replace(/\s+$/, "") + "\n\n" + url + "\n";
  }

  async function mint(slug, key) {
    const headers = {};
    if (key) headers["X-Edit-Key"] = key;

    const res = await fetch("/api/playlists/" + encodeURIComponent(slug) + "/invite", {
      method: "POST",
      headers,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "Could not make an invite link.");
    }
    const { editKey } = await res.json();
    return location.origin + "/e/" + slug + "#" + editKey;
  }

  // Drives a button end to end: mint, then the share sheet where there is one,
  // falling back to the clipboard.
  async function send({ slug, title, key, custom, button, status }) {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = "Making a link";
    if (status) status.textContent = "";

    let url;
    try {
      url = await mint(slug, key);
    } catch (err) {
      button.disabled = false;
      button.textContent = label;
      if (status) status.textContent = err.message;
      else button.textContent = "Could not make a link";
      return null;
    }

    button.disabled = false;
    button.textContent = label;
    const text = message(title, url, custom);

    if (navigator.share) {
      try {
        await navigator.share({ title: `Add a song to “${title}”`, text });
        if (status) status.textContent = "Invite sent.";
        return url;
      } catch {
        // Dismissed, or unavailable after all — fall through to the clipboard.
      }
    }

    try {
      await navigator.clipboard.writeText(text);
      if (status) {
        status.textContent = "Invite copied. Paste it to whoever you want adding songs.";
      } else {
        button.textContent = "Invite copied";
        setTimeout(() => { button.textContent = label; }, 2200);
      }
    } catch {
      if (status) status.textContent = url;
    }
    return url;
  }

  return { message, mint, send, DEFAULT_MESSAGE };
})();
