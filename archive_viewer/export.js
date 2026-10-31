/* Plain-text export of a chat for pasting into an LLM, and a token estimate for it.
   Loaded by the viewer before app.js; also works from Node (tests/export.test.js). */
(function (root) {
  "use strict";

  const IMG_EXT = /\.(jpe?g|png|webp|gif|heic|avif)$/i;
  const VID_EXT = /\.(mp4|mov|webm|m4v)$/i;
  const AUD_EXT = /\.(m4a|mp3|aac|ogg|opus|wav)$/i;
  const NOISE = /wasn't notified about this message/i;
  const TYPE_TAG = { AUDIOS: "voice", IMAGES: "photo", RAVEN_IMAGE: "photo", VIDEOS: "video", RAVEN_VIDEO: "video", GIFS: "gif", INSTAGRAM_MESSAGING_ANIMATED_IMAGE: "gif", FILES: "file" };
  const GAP = 10 * 60 * 1000;   // "sparse" times: show a time again after this long
  const QUOTE = 60;             // characters kept of a quoted message that is outside the range
  const CAPTION = 140;          // characters kept of a reel caption in "short" mode

  const pad = (n) => (n < 10 ? "0" : "") + n;
  const dayOf = (ms) => { const d = new Date(ms); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };
  const clockOf = (ms) => { const d = new Date(ms); return pad(d.getHours()) + ":" + pad(d.getMinutes()); };
  const cut = (s, n) => { const a = Array.from(s); return a.length > n ? a.slice(0, n - 1).join("").trimEnd() + "…" : s; };
  const plural = (n, word) => (n > 1 ? n + " " + word + "s" : word);

  /* Short, unambiguous names for the lines: "Me", a first name when it is plain letters, else A, B, C... */
  function aliasesFor(data) {
    const byName = { You: "Me" };
    const used = new Set(["Me"]);
    let letter = 0;
    const next = () => { let s = ""; for (let n = letter++; ; n = Math.floor(n / 26) - 1) { s = String.fromCharCode(65 + (n % 26)) + s; if (n < 26) break; } return used.has(s) ? next() : s; };
    const legend = [];
    for (const p of Object.values(data.people)) {
      let alias;
      if (p.me) alias = "Me";
      else {
        const first = (p.name || "").trim().split(/\s+/)[0];
        alias = /^Instagram$/i.test(first) && /user/i.test(p.name) ? "Deleted" : /^[A-Za-z][A-Za-z'.-]{1,13}$/.test(first) ? first : next();
        for (let n = 2; used.has(alias); n++) alias = alias.replace(/\d+$/, "") + n;
        used.add(alias);
      }
      byName[p.name] = alias;
      if (p.me || !p.name.startsWith(alias)) legend.push(alias + "=" + (p.me ? "you, " : "") + p.name);
    }
    return { byName, legend };
  }

  function tidy(text) {
    return String(text)
      .replace(/\r/g, "")
      .replace(/(https?:\/\/(?:www\.)?instagram\.com\/[^\s?#]+)[?#]\S*/g, "$1")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .replace(/\n/g, "\n  ");
  }

  function captionOf(s, mode) {
    if (mode === "none" || !s.caption) return "";
    let c = s.caption;
    if (s.account && c.startsWith(s.account + " ")) c = c.slice(s.account.length + 1);
    c = c.replace(/https?:\/\/\S+/g, "");
    if (mode === "short") c = c.replace(/#[\p{L}\p{N}_]+/gu, "");
    c = c.replace(/\s+/g, " ").replace(/\]/g, ")").trim();
    return mode === "short" ? cut(c, CAPTION) : c;
  }

  function shareTag(m, o) {
    const s = m.share, link = s.link || "";
    const story = /story/i.test(s.eyebrow || "") || m.type === "MONTAGE_SHARE_XMA" || /\/stories\//.test(link);
    const gone = /Placeholder/.test(s.kind || "") || s.account === "Message unavailable";
    let label;
    if (s.kind === "profile") label = "profile";
    else if (story) label = s.eyebrow || "story";
    else if (s.decoration === "REEL" || /\/reels?\//.test(link)) label = "reel";
    else label = /instagram\.com/i.test(link) ? "post" : "link";
    if (gone) label += " unavailable";
    const cap = captionOf(s, o.captions);
    const href = o.links && link ? " " + tidy(link) : "";
    return "[" + label + (s.account && !gone ? " @" + s.account : "") + (cap ? ": " + cap : "") + href + "]";
  }

  function attachmentTags(m) {
    const n = { photo: 0, video: 0, voice: 0 }, files = [];
    for (const [kind, file] of m.att || []) {
      if (AUD_EXT.test(file) || kind === "audio") n.voice++;
      else if (VID_EXT.test(file)) n.video++;
      else if (IMG_EXT.test(file)) { if (kind !== "thumbnail") n.photo++; }
      else files.push(file.split("/").pop());
    }
    const tags = [];
    for (const k of ["photo", "video", "voice"]) if (n[k]) tags.push("[" + plural(n[k], k) + "]");
    files.forEach((f) => tags.push("[file " + f + "]"));
    return tags;
  }

  /* Everything after "Name:" for one message. */
  function bodyOf(m, o, seen) {
    const parts = [];
    if (m.fwd) parts.push("[fwd]");
    let text = m.text ? tidy(m.text) : "";
    let content = false;

    if (m.share) {
      const tag = shareTag(m, o);
      parts.push(tag);
      seen.share = content = true;
      const cap = m.share.caption ? tidy(m.share.caption) : "";
      if (text && (text === cap || /^https?:\/\/\S+$/.test(text) || (text.length > 15 && cap.includes(text)))) text = "";
    } else {
      const tags = attachmentTags(m);
      if (tags.length) { parts.push(tags.join(" ")); seen.att = content = true; }
    }
    if (text) { parts.push(text); content = true; }
    if (!content) {
      if (m.gone && /unsent/i.test(m.gone)) parts.push("[unsent]");
      else { parts.push("[" + (TYPE_TAG[m.type] || "attachment") + "]"); seen.att = true; }
    }
    return parts.join(" ");
  }

  function reactionsOf(m, alias) {
    if (!m.react || !m.react.length) return "";
    const by = new Map();
    for (const [emoji, who] of m.react) {
      const name = alias.byName[who] || who;
      if (!by.has(emoji)) by.set(emoji, []);
      if (!by.get(emoji).includes(name)) by.get(emoji).push(name);
    }
    return " {" + [...by].map(([emoji, names]) => emoji + " " + names.join(",")).join("; ") + "}";
  }

  /* data: a loaded thread. opts: { from, to (ms, optional), times: sparse|every|none, captions: short|full|none, ids, links } */
  function build(data, opts) {
    const o = Object.assign({ from: null, to: null, times: "sparse", captions: "short", ids: false, links: false }, opts);
    const alias = aliasesFor(data);
    const list = data.messages.filter((m) => m.ak !== "reaction" && !(m.activity && NOISE.test(m.activity)) && (o.from == null || m.t >= o.from) && (o.to == null || m.t <= o.to));

    const position = new Map(list.map((m, i) => [m.id, i]));
    const number = new Map();
    if (o.ids) list.forEach((m, i) => number.set(m.id, i + 1));
    else {
      const targets = new Set();
      for (const m of list) if (m.reply && m.reply.id != null && position.has(m.reply.id)) targets.add(m.reply.id);
      for (const m of list) if (targets.has(m.id)) number.set(m.id, number.size + 1);
    }

    const seen = {};
    const lines = [];
    let lastDay = "", lastShown = -Infinity;
    for (const m of list) {
      const day = dayOf(m.t);
      if (day !== lastDay) { lines.push("# " + day); lastDay = day; lastShown = -Infinity; }
      let line = "";
      if (o.times === "every" || (o.times === "sparse" && m.t - lastShown >= GAP)) { line = clockOf(m.t) + " "; lastShown = m.t; }
      if (number.has(m.id)) line += "#" + number.get(m.id) + " ";

      if (m.activity) { seen.event = true; lines.push(line + "* " + tidy(m.activity)); continue; }

      const who = m.me ? "Me" : alias.byName[(data.people[m.s] || {}).name] || "?";
      let link = "";
      if (m.reply) {
        const r = m.reply;
        seen.reply = true;
        if (r.id != null && number.has(r.id)) link = " ↩" + number.get(r.id);
        else {
          const quoted = r.text ? cut(tidy(r.text).replace(/\n\s*/g, " "), QUOTE) : "[" + (TYPE_TAG[r.type] || "message") + "]";
          link = " ↩(" + (alias.byName[r.sender] || r.sender || "?") + ': "' + quoted + '")';
        }
      }
      const react = reactionsOf(m, alias);
      if (react) seen.react = true;
      lines.push(line + who + link + ": " + bodyOf(m, o, seen) + react);
    }

    const first = list.length ? dayOf(list[0].t) : "", last = list.length ? dayOf(list[list.length - 1].t) : "";
    const key = ['"Name: text" lines'];
    if (o.times === "sparse") key.push("a time (local, 24h) appears when 10+ minutes passed since the last one shown");
    if (o.times === "every") key.push("times are local, 24h");
    if (seen.share) key.push("[reel/post @account: caption] = a shared reel or post (its video is not included)");
    if (seen.att) key.push("[photo] [video] [voice] = attachments whose content is not included");
    if (seen.react) key.push("{❤ Name} = reactions to that message");
    if (seen.reply) key.push("#n marks a message that a later line quotes with ↩n; ↩(Name: \"text\") quotes one outside this range");
    if (seen.event) key.push("* = system event");
    const header = [
      "Instagram chat: " + data.title + (data.group ? " (group)" : " (DM)") + ", " + (first ? first + " to " + last : "no messages in this range") + ", " + list.length.toLocaleString("en-US") + " messages",
      "Names: " + alias.legend.join("; "),
      "Key: " + key.join("; "),
    ];
    return { text: header.join("\n") + "\n" + lines.join("\n") + "\n", messages: list.length, first, last };
  }

  /* Rough Gemini token count. Gemini's tokenizer is not public, so this is an estimate: digits count one each,
     Latin text about 3.7 characters per token, other scripts about 1.8, emoji about 1.5. Typically within ~15%. */
  function estimateTokens(text) {
    let latin = 0, digits = 0, other = 0, emoji = 0, marks = 0;
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp >= 48 && cp <= 57) digits++;
      else if (cp < 0x250) latin++;
      else if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x1f3fb && cp <= 0x1f3ff)) marks++;
      else if ((cp >= 0x1f000 && cp <= 0x1faff) || (cp >= 0x2190 && cp <= 0x2bff) || (cp >= 0x2000 && cp <= 0x206f)) emoji++;
      else other++;
    }
    return Math.round(digits + latin / 3.7 + other / 1.8 + emoji * 1.5 + marks * 0.3);
  }

  /* Exact count from Google's countTokens endpoint. Sends the text to Google, so the viewer only calls it on request. */
  async function countWithGemini(text, key, model) {
    const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":countTokens", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ contents: [{ parts: [{ text }] }] }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((body.error && body.error.message) || "HTTP " + res.status);
    return body.totalTokens;
  }

  const api = { build, estimateTokens, countWithGemini, dayOf };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.IGAExport = api;
})(typeof window !== "undefined" ? window : globalThis);
