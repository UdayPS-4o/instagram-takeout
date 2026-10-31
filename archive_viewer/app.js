/* Instagram Direct archive viewer. Reads the data files written by build_archive.py (scraped data + official exports); works from file://. */
(function () {
  "use strict";

  const IGA = (window.IGA = {});
  const $ = (id) => document.getElementById(id);
  const HOUR = 3600 * 1000;
  const CHUNK = 60;       // messages added per step while scrolling
  const MAX_ITEMS = 200;  // messages kept in the page; the far end is dropped beyond this
  const IMG_EXT = /\.(jpe?g|png|webp|gif|heic|avif)$/i;
  const VID_EXT = /\.(mp4|mov|webm|m4v)$/i;
  const AUD_EXT = /\.(m4a|mp3|aac|ogg|opus|wav)$/i;

  const stampQ = () => (window.IGA_V ? "?v=" + window.IGA_V : "");
  const state = { inbox: null, threads: {}, waiting: {}, view: null, viewer: null, audio: null, box: "inbox", exp: { from: "", to: "", times: "sparse", captions: "short", ids: false, links: false, model: "gemini-2.5-flash" } };

  /* ---------------- helpers ---------------- */
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fileUrl = (p) => p.split("/").map(encodeURIComponent).join("/");
  const cssUrl = (p) => "url(&quot;" + fileUrl(p).replace(/'/g, "%27") + "&quot;)";
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const ICON = {
    play: '<svg viewBox="0 0 24 24"><path class="fill" d="M7 4.5v15l12.5-7.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path class="fill" d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z"/></svg>',
    reel: '<svg viewBox="0 0 24 24"><rect x="2.5" y="2.5" width="19" height="19" rx="5" class="fill" style="fill:#fff"/><path d="m10 8.3 5.6 3.7-5.6 3.7z" class="fill" style="fill:#000"/></svg>',
    carousel: '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="14" height="14" rx="3" class="fill" style="fill:#fff"/><path d="M4 16V6a2 2 0 0 1 2-2h10" style="stroke:#fff"/></svg>',
    video: '<svg viewBox="0 0 24 24"><path class="fill" style="fill:#fff" d="M7 4.5v15l12.5-7.5z"/></svg>',
    reply: '<svg viewBox="0 0 24 24"><path d="M10 6 4 12l6 6"/><path d="M4.5 12H14a6 6 0 0 1 6 6v1"/></svg>',
    fwd: '<svg viewBox="0 0 24 24"><path d="m14 6 6 6-6 6"/><path d="M19.5 12H10a6 6 0 0 0-6 6v1"/></svg>',
    ext: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
    file: '<svg viewBox="0 0 24 24"><path d="M14 2.5H7a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-12z"/><path d="M14 2.5v5h5"/></svg>',
  };

  function linkify(escaped) {
    return escaped.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, (u) => '<a href="' + u + '" target="_blank" rel="noopener">' + u + "</a>");
  }

  /* ---------------- search ----------------
     Only what people typed is searched (not reel/post captions or account names).
     Matching ignores case, accents and fancy unicode fonts, treats "plsss" like "pls",
     accepts the words in any order, and tolerates small typos (1 for 5-8 letters, 2 for 9+). */
  const WORD_RE = /[\p{L}\p{N}\p{M}]+/gu;

  function fold(s) {
    return String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/(\p{L})\1+/gu, "$1");
  }

  function parseQuery(q) {
    const raw = q.trim();
    const words = [...new Set(fold(raw).match(WORD_RE) || [])];
    return { raw, lower: raw.toLowerCase(), words, phrase: words.join(" ") };
  }

  function within(a, b, k) {
    // optimal string alignment distance <= k (typos, missing/extra letters, swapped neighbours)
    const n = a.length, m = b.length;
    if (Math.abs(n - m) > k) return false;
    let prev2 = null, prev = Array.from({ length: m + 1 }, (_, j) => j);
    for (let i = 1; i <= n; i++) {
      const cur = [i];
      let best = i;
      for (let j = 1; j <= m; j++) {
        let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
        cur[j] = v;
        if (v < best) best = v;
      }
      if (best > k) return false;
      prev2 = prev;
      prev = cur;
    }
    return prev[m] <= k;
  }

  function fuzzyWord(t, words) {
    if (t.length < 5) return false;
    const k = t.length >= 9 ? 2 : 1;
    for (const w of words) {
      if (within(w, t, k)) return true;
      if (w.length > t.length + k && within(w.slice(0, t.length), t, k)) return true;
    }
    return false;
  }

  function searchable(m) {
    if (m._w === undefined) {
      const words = fold(m.sx).match(WORD_RE) || [];
      m._w = words;
      m._f = words.join(" ");
    }
    return m;
  }

  // 3 = exact phrase, 2 = every word found as typed, 1 = found with typo tolerance, 0 = no match
  function scoreWords(f, words, Q) {
    if (!Q.words.length) return 0;
    if (Q.words.length > 1 && f.includes(Q.phrase)) return 3;
    let exact = true;
    for (const t of Q.words) {
      if (f.includes(t)) continue;
      if (!fuzzyWord(t, words)) return 0;
      exact = false;
    }
    return exact ? (Q.words.length === 1 ? 3 : 2) : 1;
  }

  function scoreMessage(m, Q) {
    if (!m.sx) return 0;
    if (!Q.words.length) return m.sx.toLowerCase().includes(Q.lower) ? 3 : 0;  // emoji / symbol search
    searchable(m);
    return scoreWords(m._f, m._w, Q);
  }

  function scoreName(text, Q) {
    const words = fold(text).match(WORD_RE) || [];
    return scoreWords(words.join(" "), words, Q);
  }

  function wordHit(w, Q) {
    const f = fold(w);
    return Q.words.some((t) => f.includes(t) || fuzzyWord(t, [f]));
  }

  function markHtml(html, Q) {
    if (!Q) return html;
    if (!Q.words.length) {
      if (!Q.raw) return html;
      const re = new RegExp("(" + reEsc(esc(Q.raw)) + ")", "gi");
      return html.replace(/(<[^>]+>)|([^<]+)/g, (all, tag, text) => tag || text.replace(re, "<mark>$1</mark>"));
    }
    return html.replace(/(<[^>]+>)|([^<]+)/g, (all, tag, text) => tag || text.replace(/&#?\w+;|[\p{L}\p{N}\p{M}]+/gu, (w) => (w[0] === "&" && w.endsWith(";") ? w : wordHit(w, Q) ? "<mark>" + w + "</mark>" : w)));
  }

  function snippet(text, Q) {
    let at = -1;
    if (Q.words.length) {
      const re = new RegExp(WORD_RE.source, "gu");
      let mm;
      while ((mm = re.exec(text))) if (wordHit(mm[0], Q)) { at = mm.index; break; }
    } else at = text.toLowerCase().indexOf(Q.lower);
    at = Math.max(0, at);
    const from = Math.max(0, at - 40);
    const cut = (from > 0 ? "…" : "") + text.slice(from, at + 120) + (at + 120 < text.length ? "…" : "");
    return markHtml(esc(cut), Q);
  }

  const segmenter = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
  function emojiOnly(text) {
    if (!text || text.length > 40 || !/^[\p{Extended_Pictographic}\p{Emoji_Component}‍️⃣\s]+$/u.test(text) || !/\p{Extended_Pictographic}/u.test(text)) return false;
    const count = segmenter ? [...segmenter.segment(text.replace(/\s/g, ""))].length : text.length / 2;
    return count <= 6;
  }

  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short" });
  const fullFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  const dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
  const longDate = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  function stampLabel(ms) {
    const d = new Date(ms), now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return timeFmt.format(d);
    if (now - d < 6 * 24 * HOUR) return dayFmt.format(d) + " " + timeFmt.format(d);
    return fullFmt.format(d);
  }

  function ago(ms) {
    const s = (Date.now() - ms) / 1000;
    if (s < 60) return "now";
    if (s < 3600) return Math.floor(s / 60) + "m";
    if (s < 86400) return Math.floor(s / 3600) + "h";
    if (s < 7 * 86400) return Math.floor(s / 86400) + "d";
    if (s < 365 * 86400) return Math.floor(s / (7 * 86400)) + "w";
    return Math.floor(s / (365 * 86400)) + "y";
  }

  function dayKey(ms) {
    const d = new Date(ms);
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  }

  function firstAtOrAfter(list, t) {
    let lo = 0, hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].t < t) lo = mid + 1; else hi = mid; }
    return Math.min(lo, list.length - 1);
  }

  function initials(name) {
    const ch = [...String(name || "?").replace(/[^\p{L}\p{N}]/gu, "")][0];
    return esc((ch || "?").toUpperCase());
  }

  function avatar(person, size) {
    if (person && person.avatar) return '<span class="avatar ' + size + '" style="background-image:' + cssUrl(person.avatar) + '"></span>';
    return '<span class="avatar ' + size + '">' + initials(person && (person.name || person.username)) + "</span>";
  }

  function threadAvatar(thread, size) {
    if (thread.avatar) return avatar({ avatar: thread.avatar, name: thread.title }, size);
    const members = thread.members || [];
    if (thread.group && members.length > 1) {
      const small = size === "lg" ? "lg" : "md";
      return '<span class="avatar-stack ' + small + '">' + avatar(members[1], "") + avatar(members[0], "") + "</span>";
    }
    return avatar(members[0] || { name: thread.title }, size);
  }

  function kindOf(att) {
    const [kind, file] = att;
    if (AUD_EXT.test(file) || kind === "audio") return "audio";
    if (VID_EXT.test(file)) return "video";
    if (IMG_EXT.test(file)) return kind === "thumbnail" ? "thumb" : "image";
    return kind;
  }

  /* ---------------- data ---------------- */
  IGA.inbox = function (data) {
    state.inbox = data;
    boot();
  };

  IGA.receive = function (id, data) {
    prepare(data);
    state.threads[id] = data;
    (state.waiting[id] || []).forEach((fn) => fn(data));
    delete state.waiting[id];
  };

  function loadThread(id) {
    return new Promise((resolve, reject) => {
      if (state.threads[id]) return resolve(state.threads[id]);
      if (state.waiting[id]) return state.waiting[id].push(resolve);
      state.waiting[id] = [resolve];
      const s = document.createElement("script");
      s.src = "_archive/data/t_" + encodeURIComponent(id) + ".js" + stampQ();
      s.onerror = () => { delete state.waiting[id]; reject(new Error("missing data for " + id)); };
      document.body.appendChild(s);
    });
  }

  function prepare(data) {
    const v = data.messages.filter((m) => m.ak !== "reaction");
    data.visible = v;
    data.index = {};
    data.media = [];
    data.links = [];
    data.voice = [];
    data.meId = Object.keys(data.people).find((k) => data.people[k].me);
    data.dims = {};

    data.days = new Map();
    v.forEach((m, i) => {
      data.index[m.id] = i;
      const k = dayKey(m.t);
      const day = data.days.get(k);
      if (day) day.n++;
      else data.days.set(k, { n: 1, i });
      m.sep = i === 0 || m.t - v[i - 1].t > HOUR;
      const files = { image: [], thumb: [], video: [], audio: [] };
      (m.att || []).forEach((a) => {
        if (a[2]) data.dims[a[1]] = [a[2], a[3]];
        const k = kindOf(a);
        (files[k] || (files[k] = [])).push(a[1]);
      });
      const images = files.image.length ? files.image : files.thumb;
      const videos = files.video.map((f, n) => ({ file: f, poster: images[n] || images[0] || null }));
      m.vis = { images: videos.length ? [] : images, videos, audio: files.audio, files: files.file || [], thumb: images[0] || null };

      m.vis.videos.forEach((x) => data.media.push({ i, type: "video", file: x.file, poster: x.poster }));
      m.vis.images.forEach((f) => data.media.push({ i, type: "image", file: f }));
      m.vis.audio.forEach((f) => data.voice.push({ i, file: f }));
      if (m.share && m.share.link) data.links.push({ i, url: m.share.link, label: m.share.account || "" });
      if (m.text) (m.text.match(/https?:\/\/[^\s]+/g) || []).forEach((u) => data.links.push({ i, url: u, label: "" }));
      const cap = (m.share && m.share.caption) || "";
      m.sx = m.text && !(cap && (m.text === cap || (m.text.length > 15 && cap.includes(m.text)))) ? m.text : "";
    });

    const bubbly = (m) => !m.activity;
    const joins = (a, b) => bubbly(a) && bubbly(b) && a.s === b.s && !b.sep && !b.reply && !b.fwd && !(b.share && b.share.eyebrow);
    v.forEach((m, i) => {
      const prev = i > 0 && joins(v[i - 1], m);
      const next = i < v.length - 1 && joins(m, v[i + 1]);
      m.pos = prev ? (next ? "mid" : "last") : next ? "first" : "single";
    });
    data.mediaIndex = new Map();
    data.media.forEach((x, n) => { if (!data.mediaIndex.has(x.i + ":" + x.file)) data.mediaIndex.set(x.i + ":" + x.file, n); });
  }

  const person = (data, id) => data.people[id] || { name: "Instagram user", username: "" };

  /* ---------------- inbox ---------------- */
  function boot() {
    const me = state.inbox.me || {};
    $("me-name").querySelector("span").textContent = me.username || "Archive";
    $("rail-me").innerHTML = avatar(me, "xs");
    if (profileAvailable()) {
      const pf = $("rail-me");
      pf.setAttribute("href", "#profile=" + (state.inbox.stories ? "stories" : "followers"));
      pf.title = "Your profile: stories, followers, following";
      if (state.inbox.stories) pf.classList.add("has-story");
    }
    const requests = state.inbox.threads.filter((t) => t.request).length;
    if (requests) {
      $("tab-req").disabled = false;
      $("tab-req").title = "Message requests";
      $("tab-req").innerHTML = "Requests <small>" + requests.toLocaleString() + "</small>";
    }
    $("inbox-tabs").addEventListener("click", (e) => {
      const b = e.target.closest("[data-box]");
      if (b && !b.disabled) setBox(b.dataset.box);
    });
    $("me-name").addEventListener("click", () => { location.href = "../index.html?pick"; });
    renderThreads();
    $("inbox-q").addEventListener("input", debounce(() => renderThreads($("inbox-q").value.trim()), 150));
    $("open-latest").addEventListener("click", () => {
      const latest = state.inbox.threads.find((t) => !t.request) || state.inbox.threads[0];
      if (latest) go(latest.id);
    });
    window.addEventListener("hashchange", route);
    bindChat();
    $("pf-close").addEventListener("click", () => { location.hash = state.beforeProfile || ""; });
    $("pf-fold").addEventListener("click", () => setCompact(!$("profile").classList.contains("compact")));
    $("profile").addEventListener("scroll", (e) => {
      const el = e.target;
      if (el.id !== "st-scroll" && el.id !== "people") return;
      const want = el.scrollTop > 80 ? true : el.scrollTop < 8 ? false : null;
      if (want === null || want === state.pfAuto) return;
      state.pfAuto = want;
      setCompact(want);
    }, true);
    $("profile").addEventListener("click", (e) => {
      const b = e.target.closest("[data-tab]");
      if (b) location.hash = "#profile=" + b.dataset.tab;
    });
    $("pf-avatar").addEventListener("click", () => {
      if (!state.inbox.stories) return;
      loadStories().then((d) => {
        const list = d.list.slice();
        let k = list.length - 1;
        while (k > 0 && list[k - 1].day === list[k].day) k--;
        openStory(list, Math.max(0, k));
      });
    });
    route();
  }

  function threadRow(t) {
    const sel = state.view && state.view.data.id === t.id ? " selected" : "";
    return '<button class="thread' + sel + '" role="listitem" data-t="' + esc(t.id) + '">' + threadAvatar(t, "lg") +
      '<span class="thread-text"><span class="thread-name">' + esc(t.title) + '</span><span class="thread-sub"><span class="pv">' + esc(t.preview) + '</span><span class="ago">· ' + ago(t.last) + "</span></span></span></button>";
  }

  function setBox(box) {
    if (state.box === box) return;
    state.box = box;
    $("inbox-tabs").querySelectorAll("[data-box]").forEach((b) => b.classList.toggle("on", b.dataset.box === box));
    renderThreads($("inbox-q").value.trim());
  }

  let searchToken = 0;
  function renderThreads(q) {
    const list = $("thread-list");
    const threads = state.inbox.threads;
    if (!q) {
      const shown = threads.filter((t) => !!t.request === (state.box === "requests"));
      list.innerHTML = shown.map(threadRow).join("") || '<p class="muted">No chats in the archive yet. Import an Instagram export with import_export.py.</p>';
      bindThreadClicks(list);
      return;
    }
    const Q = parseQuery(q);
    const named = threads.filter((t) => scoreName(t.title + " " + t.members.map((m) => m.name + " " + m.username).join(" "), Q) || (t.title.toLowerCase().includes(Q.lower)));
    let html = named.length ? named.map(threadRow).join("") : "";
    html += '<div class="list-label">In messages <small class="muted-inline" id="hit-count"></small></div><div id="msg-hits"><p class="muted">Searching all chats…</p></div>';
    list.innerHTML = html;
    bindThreadClicks(list);

    const token = ++searchToken;
    if (Q.raw.length < 2) { $("msg-hits").innerHTML = '<p class="muted">Type at least 2 letters to search messages.</p>'; return; }
    Promise.all(threads.map((t) => loadThread(t.id).catch(() => null))).then((all) => {
      if (token !== searchToken) return;
      const exact = [], similar = [];
      all.forEach((data) => {
        if (!data) return;
        data.visible.forEach((m) => {
          const score = scoreMessage(m, Q);
          if (score) (score > 1 ? exact : similar).push({ data, m });
        });
      });
      exact.sort((a, b) => b.m.t - a.m.t);
      similar.sort((a, b) => b.m.t - a.m.t);
      const row = ({ data, m }) =>
        '<button class="hit" data-t="' + esc(data.id) + '" data-m="' + esc(m.id) + '"><b>' + esc(data.title) + '</b> <small class="muted-inline">· ' + dateFmt.format(new Date(m.t)) + "</small><p>" +
        (m.me ? "You: " : data.group ? esc(person(data, m.s).name) + ": " : "") + snippet(m.sx, Q) + "</p></button>";
      const total = exact.length + similar.length;
      $("hit-count").textContent = total ? "· " + total.toLocaleString() : "";
      let out = exact.slice(0, 150).map(row).join("");
      if (exact.length > 150) out += '<p class="muted">Showing the newest 150 of ' + exact.length + " exact matches.</p>";
      if (similar.length) out += '<div class="list-label sub">Similar spellings <small class="muted-inline">· ' + similar.length.toLocaleString() + "</small></div>" + similar.slice(0, 80).map(row).join("");
      $("msg-hits").innerHTML = out || '<p class="muted">No messages found.</p>';
      $("msg-hits").querySelectorAll(".hit").forEach((b) => b.addEventListener("click", () => go(b.dataset.t, b.dataset.m)));
    });
  }

  function bindThreadClicks(root) {
    root.querySelectorAll(".thread").forEach((b) => b.addEventListener("click", () => go(b.dataset.t)));
  }

  /* ---------------- routing ---------------- */
  function go(threadId, msgId) {
    const hash = "#t=" + encodeURIComponent(threadId) + (msgId ? "&m=" + encodeURIComponent(msgId) : "");
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  function route() {
    if (!/^#(stories|profile)/.test(location.hash)) state.prevHash = location.hash;
    const p = new URLSearchParams(location.hash.slice(1));
    if (p.has("stories")) return openProfile("stories");
    if (p.has("profile")) return openProfile(p.get("profile") || "stories");
    closeProfile();
    const t = p.get("t");
    if (!t) return closeThread();
    openThread(t, p.get("m"));
  }

  function closeThread() {
    state.view = null;
    $("convo").hidden = true;
    $("empty").hidden = false;
    $("details").hidden = true;
    $("app").classList.remove("in-chat");
    document.querySelectorAll(".thread.selected").forEach((e) => e.classList.remove("selected"));
    document.title = "Instagram Archive";
  }

  /* ---------------- conversation ---------------- */
  async function openThread(id, msgId) {
    let data;
    try { data = await loadThread(id); } catch (e) { $("msgs").innerHTML = '<p class="muted">' + esc(e.message) + "</p>"; return; }

    const fresh = !state.view || state.view.data !== data;
    if (fresh) {
      state.view = { data, start: 0, end: 0, q: null, stick: true, hits: [], hit: -1 };
      $("empty").hidden = true;
      $("convo").hidden = false;
      $("app").classList.add("in-chat");
      document.title = data.title + " • Instagram Archive";
      setBox(data.request ? "requests" : "inbox");
      document.querySelectorAll(".thread").forEach((e) => e.classList.toggle("selected", e.dataset.t === id));
      const others = data.members || [];
      $("convo-avatar").outerHTML = '<span id="convo-avatar">' + threadAvatar(data, "md") + "</span>";
      $("convo-title").textContent = data.title;
      $("convo-sub").textContent = data.group ? others.map((m) => m.username || m.name).join(", ") : (others[0] && others[0].username) || "";
      closeFind();
      toggleCal(false);
      renderTicks();
      if (!$("details").hidden) renderDetails();
    }

    if (msgId && data.index[msgId] != null) jumpTo(data.index[msgId], true);
    else if (fresh) showLatest();
  }

  function showLatest() {
    const v = state.view, n = v.data.visible.length;
    renderRange(Math.max(0, n - CHUNK), n);
    v.stick = true;
    const sc = $("scroller");
    sc.scrollTop = sc.scrollHeight;
    requestAnimationFrame(() => { sc.scrollTop = sc.scrollHeight; });
  }

  function showFirst() {
    const v = state.view, n = v.data.visible.length;
    v.stick = false;
    renderRange(0, Math.min(n, CHUNK));
    $("scroller").scrollTop = 0;
    updateToBottom();
  }

  function jumpTo(i, flash) {
    const v = state.view, n = v.data.visible.length;
    v.stick = false;
    if (i < v.start || i >= v.end) renderRange(Math.max(0, i - CHUNK), Math.min(n, i + CHUNK));
    const el = $("msgs").querySelector('.it[data-i="' + i + '"]');
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    if (flash) {
      const row = el.querySelector(".row") || el;
      row.classList.remove("flash");
      void row.offsetWidth;
      row.classList.add("flash");
    }
    updateToBottom();
  }

  function introHtml(data) {
    const one = !data.group && data.members[0];
    return '<div class="intro">' + threadAvatar(data, "xl").replace('avatar-stack md', 'avatar-stack lg') + "<b>" + esc(data.title) + "</b>" +
      "<small>" + (one ? (one.username ? esc(one.username) + " · " : "") + "Instagram" : esc(data.members.map((m) => m.name).join(", "))) + "</small>" +
      '<small>' + data.count.toLocaleString() + " messages since " + dateFmt.format(new Date(data.first)) + "</small>" +
      (one && one.username ? '<a class="btn-gray" href="https://www.instagram.com/' + encodeURIComponent(one.username) + '/" target="_blank" rel="noopener">View profile</a>' : "") + "</div>";
  }

  function itemsHtml(from, to) {
    const out = [];
    for (let i = from; i < to; i++) out.push(itemHtml(state.view.data, i));
    return out.join("");
  }

  function renderRange(start, end) {
    const v = state.view;
    v.start = start;
    v.end = end;
    $("msgs").innerHTML = itemsHtml(start, end);
    syncEdges();
  }

  // top: chat intro at the very start, otherwise a loader; bottom: a loader while newer messages are not in the page
  function syncEdges() {
    const v = state.view, msgs = $("msgs");
    const head = msgs.firstElementChild;
    if (head && !head.classList.contains("it")) head.remove();
    msgs.insertAdjacentHTML("afterbegin", v.start === 0 ? introHtml(v.data) : '<div class="loader">Loading older messages…</div>');
    const tail = msgs.lastElementChild;
    if (tail && tail.classList.contains("bottom")) tail.remove();
    if (v.end < v.data.visible.length) msgs.insertAdjacentHTML("beforeend", '<div class="loader bottom">Loading newer messages…</div>');
  }

  function keepAnchor(fn) {
    const sc = $("scroller");
    const top = sc.getBoundingClientRect().top;
    // only message items can anchor: the top loader / intro gets replaced while prepending
    const anchor = [...$("msgs").querySelectorAll(".it")].find((e) => e.getBoundingClientRect().bottom > top);
    const before = anchor ? anchor.getBoundingClientRect().top : 0;
    fn();
    if (anchor && anchor.isConnected) sc.scrollTop += anchor.getBoundingClientRect().top - before;
  }

  function loadOlder() {
    const v = state.view;
    if (!v || v.start === 0 || v.busy) return;
    v.busy = true;
    const from = Math.max(0, v.start - CHUNK);
    keepAnchor(() => {
      const msgs = $("msgs");
      const first = msgs.querySelector(".it");
      first.insertAdjacentHTML("beforebegin", itemsHtml(from, v.start));
      v.start = from;
      if (v.end - v.start > MAX_ITEMS) {
        const keep = v.start + MAX_ITEMS;
        msgs.querySelectorAll(".it").forEach((e) => { if (+e.dataset.i >= keep) e.remove(); });
        v.end = keep;
      }
      syncEdges();
    });
    v.busy = false;
    updateToBottom();
  }

  function loadNewer() {
    const v = state.view, n = v.data.visible.length;
    if (!v || v.end >= n || v.busy) return;
    v.busy = true;
    const to = Math.min(n, v.end + CHUNK);
    keepAnchor(() => {
      const msgs = $("msgs");
      const items = msgs.querySelectorAll(".it");
      items[items.length - 1].insertAdjacentHTML("afterend", itemsHtml(v.end, to));
      v.end = to;
      if (v.end - v.start > MAX_ITEMS) {
        const cut = v.end - MAX_ITEMS;
        msgs.querySelectorAll(".it").forEach((e) => { if (+e.dataset.i < cut) e.remove(); });
        v.start = cut;
      }
      syncEdges();
    });
    v.busy = false;
    updateToBottom();
  }

  /* ---------------- whole-chat scrubber ---------------- */
  let scrubQueued = false;
  function queueScrub() {
    if (scrubQueued) return;
    scrubQueued = true;
    requestAnimationFrame(() => { scrubQueued = false; paintScrub(); });
  }

  function chatFraction() {
    const v = state.view, sc = $("scroller"), n = v.data.visible.length;
    if (n < 2) return 1;
    if (v.end === n && sc.scrollHeight - sc.scrollTop - sc.clientHeight < 4) return 1;
    if (v.start === 0 && sc.scrollTop < 4) return 0;
    const box = sc.getBoundingClientRect();
    const mid = box.top + box.height / 2;
    const it = [...$("msgs").querySelectorAll(".it")].find((e) => e.getBoundingClientRect().bottom >= mid);
    if (!it) return v.end / n;
    const r = it.getBoundingClientRect();
    const within = r.height ? Math.min(1, Math.max(0, (mid - r.top) / r.height)) : 0;
    return Math.min(1, (+it.dataset.i + within) / (n - 1));
  }

  function placeThumb(frac) {
    const scrub = $("scrub"), thumb = $("scrub-thumb");
    const room = scrub.clientHeight - thumb.offsetHeight;
    thumb.style.top = Math.round(frac * room) + "px";
    return Math.round(frac * room) + thumb.offsetHeight / 2;
  }

  function paintScrub() {
    if (!state.view) return;
    const v = state.view, n = v.data.visible.length, scrub = $("scrub");
    scrub.hidden = n < 30;
    if (scrub.hidden) return;
    const half = $("scrub-thumb").offsetHeight / 2, room = scrub.clientHeight - 2 * half;
    const win = $("scrub-window");
    const top = half + (v.start / (n - 1)) * room, bottom = half + (Math.max(v.start, v.end - 1) / (n - 1)) * room;
    win.style.top = Math.round(top) + "px";
    win.style.height = Math.max(4, Math.round(bottom - top)) + "px";
    if (!state.scrubbing) placeThumb(chatFraction());
  }

  function renderTicks() {
    const v = state.view.data.visible, ticks = $("scrub-ticks");
    const first = new Date(v[0].t).getFullYear(), last = new Date(v[v.length - 1].t).getFullYear();
    let html = "";
    for (let y = first + 1; y <= last; y++) {
      const f = firstAtOrAfter(v, new Date(y, 0, 1).getTime()) / (v.length - 1);
      html += '<i style="top:calc((100% - 24px) * ' + f.toFixed(4) + ' + 12px)"><span>' + y + "</span></i>";
    }
    ticks.innerHTML = html;
  }

  function bindScrub() {
    const scrub = $("scrub"), label = $("scrub-label");
    const fracAt = (y) => {
      const r = scrub.getBoundingClientRect(), half = $("scrub-thumb").offsetHeight / 2;
      return Math.min(1, Math.max(0, (y - r.top - half) / Math.max(1, r.height - 2 * half)));
    };
    const indexAt = (f) => Math.round(f * (state.view.data.visible.length - 1));
    const showLabel = (f, y) => {
      const m = state.view.data.visible[indexAt(f)];
      label.textContent = dateFmt.format(new Date(m.t));
      label.style.top = (y == null ? placeThumb(f) : y - scrub.getBoundingClientRect().top) + "px";
      label.hidden = false;
    };
    // the chat follows the thumb live while dragging (one render per frame at most)
    let drag = null, frame = 0, shown = -1;
    const follow = () => {
      frame = 0;
      if (drag == null || !state.view) return;
      const v = state.view, n = v.data.visible.length;
      const i = Math.min(n - 1, indexAt(drag));
      if (i === shown) return;
      shown = i;
      v.stick = false;
      if (drag >= 0.999) {
        if (v.end < n) renderRange(Math.max(0, n - CHUNK), n);
        $("scroller").scrollTop = $("scroller").scrollHeight;
        return;
      }
      if (drag <= 0.001) {
        if (v.start > 0) renderRange(0, Math.min(n, CHUNK));
        $("scroller").scrollTop = 0;
        return;
      }
      if (i < v.start + 15 || i >= v.end - 15) renderRange(Math.max(0, i - 40), Math.min(n, i + 40));
      const el = $("msgs").querySelector('.it[data-i="' + i + '"]');
      if (el) el.scrollIntoView({ block: "center" });
      paintScrub();
    };
    const followSoon = () => { if (!frame) frame = requestAnimationFrame(follow); };

    scrub.addEventListener("wheel", (e) => {
      if (!state.view) return;
      e.preventDefault();
      const n = state.view.data.visible.length;
      const step = Math.sign(e.deltaY) * Math.max(1, Math.round(n / 100));
      jumpTo(Math.min(n - 1, Math.max(0, indexAt(chatFraction()) + step)), false);
    }, { passive: false });

    scrub.addEventListener("pointerdown", (e) => {
      if (!state.view) return;
      e.preventDefault();
      scrub.setPointerCapture(e.pointerId);
      state.scrubbing = true;
      scrub.classList.add("dragging");
      drag = fracAt(e.clientY);
      shown = -1;
      placeThumb(drag);
      showLabel(drag);
      followSoon();
    });
    scrub.addEventListener("pointermove", (e) => {
      if (!state.view) return;
      if (drag == null) return showLabel(fracAt(e.clientY), e.clientY);
      drag = fracAt(e.clientY);
      placeThumb(drag);
      showLabel(drag);
      followSoon();
    });
    const finish = () => {
      if (drag == null) return;
      const f = drag, n = state.view.data.visible.length;
      follow();
      drag = null;
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      state.scrubbing = false;
      scrub.classList.remove("dragging");
      label.hidden = true;
      if (f >= 0.999) showLatest();
      else if (f <= 0.001) showFirst();
      else jumpTo(Math.min(n - 1, indexAt(f)), false);
      queueScrub();
    };
    scrub.addEventListener("pointerup", finish);
    scrub.addEventListener("pointercancel", finish);
    scrub.addEventListener("pointerleave", () => { if (drag == null) label.hidden = true; });
  }

  function updateToBottom() {
    const v = state.view, sc = $("scroller");
    if (!v) return;
    const far = sc.scrollHeight - sc.scrollTop - sc.clientHeight > 1200 || v.end < v.data.visible.length;
    $("to-bottom").hidden = !far;
    queueScrub();
  }

  /* ---------------- message rendering ---------------- */
  function itemHtml(data, i) {
    const m = data.visible[i];
    let html = '<div class="it" data-i="' + i + '">';
    if (m.sep) html += '<div class="stamp">' + esc(stampLabel(m.t)) + "</div>";
    if (m.activity) return html + '<div class="activity" title="' + esc(fullFmt.format(new Date(m.t))) + '">' + esc(m.activity) + "</div></div>";

    const side = m.me ? "me" : "them";
    const who = person(data, m.s);
    const q = state.view && state.view.q;
    const parts = [];

    if (data.group && !m.me && (m.pos === "first" || m.pos === "single")) parts.push('<div class="sender-name">' + esc(who.name) + "</div>");
    if (m.fwd) parts.push('<div class="label">' + ICON.fwd + (m.me ? "You forwarded a message" : esc(who.name) + " forwarded a message") + "</div>");
    if (m.reply) parts.push(replyHtml(data, m, who));

    parts.push(contentHtml(data, m, i, who, q));

    if (m.react && m.react.length) {
      const emojis = [...new Set(m.react.map((r) => r[0]))].slice(0, 3).join("");
      parts.push('<button class="reacts" data-react="' + i + '" title="' + esc(m.react.map((r) => r[1] + " " + r[0]).join(", ")) + '">' + esc(emojis) + (m.react.length > 1 ? "<small>" + m.react.length + "</small>" : "") + "</button>");
    }
    if (m.edits && m.edits.length) parts.push('<div class="edited" title="' + esc(m.edits.map((e) => e.body).filter(Boolean).join(" → ")) + '">Edited</div>');

    const slot = !m.me ? '<div class="slot">' + (m.pos === "last" || m.pos === "single" ? avatar(who, "s") : "") + "</div>" : "";
    return html + '<div class="row ' + side + " g-" + m.pos + '">' + slot + '<div class="col">' + parts.join("") + '</div><span class="time-hover">' + esc(timeFmt.format(new Date(m.t))) + "</span></div></div>";
  }

  function replyHtml(data, m, who) {
    const r = m.reply;
    let label;
    if (m.me) label = "You replied to " + (r.sender === "You" ? "yourself" : esc(r.sender));
    else label = esc(who.name) + (r.sender === "You" ? " replied to you" : r.sender === who.name ? " replied to themself" : " replied to " + esc(r.sender));

    const target = r.id != null ? data.index[r.id] : undefined;
    const orig = target != null ? data.visible[target] : null;
    let body;
    if (r.text) body = '<div class="quote' + (r.sender === "You" ? " of-me" : "") + '">' + esc(r.text) + "</div>";
    else if (orig && orig.vis.thumb) body = '<div class="quote thumb"><img loading="lazy" src="' + fileUrl(orig.vis.thumb) + '" alt=""></div>';
    else body = '<div class="quote' + (r.sender === "You" ? " of-me" : "") + '">' + esc(typeLabel(r.type, orig)) + "</div>";

    return '<div class="label">' + label + '</div><div class="quote-wrap"' + (target != null ? ' data-jump="' + target + '"' : "") + ' title="' + (target != null ? "Go to original message" : "Original message isn't in the archive") + '"><span class="quote-bar"></span>' + body + "</div>";
  }

  function typeLabel(type, orig) {
    if (orig && orig.share) return orig.share.decoration === "REEL" ? "Reel" : "Attachment";
    return { AUDIOS: "Voice message", IMAGES: "Photo", RAVEN_IMAGE: "Photo", VIDEOS: "Video", RAVEN_VIDEO: "Video", MESSAGE_INLINE_SHARE: "Attachment", MONTAGE_SHARE_XMA: "Story", GIFS: "GIF", INSTAGRAM_MESSAGING_ANIMATED_IMAGE: "GIF", FILES: "File" }[type] || "Message";
  }

  function img(data, file) {
    const d = data.dims[file];
    let size = "";
    if (d) {
      const scale = Math.min(1, 340 / d[0], 400 / d[1]);
      size = ' width="' + Math.round(d[0] * scale) + '" height="' + Math.round(d[1] * scale) + '"';
    }
    return '<img loading="lazy" src="' + fileUrl(file) + '"' + size + ' alt="">';
  }

  function mediaAttr(data, i, file) {
    const n = data.mediaIndex.get(i + ":" + file);
    return n != null ? ' data-media="' + n + '"' : "";
  }

  function contentHtml(data, m, i, who, q) {
    const out = [];
    const s = m.share;

    if (m.gone) out.push('<div class="bubble gone shape">' + esc(/unsent|deleted|unavailable/i.test(m.gone) ? m.gone : "Message unavailable") + "</div>");

    if (s) {
      const eyebrow = s.eyebrow || "";
      const isStoryReply = /story/i.test(eyebrow) || m.type === "MONTAGE_SHARE_XMA";
      if (isStoryReply) {
        out.push('<div class="label">' + esc(eyebrow || (m.me ? "You replied to their story" : "Replied to your story")) + "</div>");
        const thumb = m.vis.thumb;
        const media = m.vis.videos[0] ? m.vis.videos[0].file : thumb;
        out.push('<div class="story"><span class="story-bar"></span>' + (thumb
          ? '<button class="story-thumb"' + mediaAttr(data, i, media) + (s.link ? ' data-link="' + esc(s.link) + '"' : "") + '><img loading="lazy" src="' + fileUrl(thumb) + '" alt=""></button>'
          : '<div class="story-thumb gone"' + (s.link ? ' data-link="' + esc(s.link) + '" title="Open on Instagram"' : "") + ">" + esc(s.note || "Story unavailable") + "</div>") + "</div>");
      } else if (/Placeholder/.test(s.kind || "") && !m.vis.thumb) {
        out.push('<div class="card placeholder shape"><b>' + esc(s.account || "Message unavailable") + "</b><p>" + esc(s.note || "This content may have been deleted by its owner or hidden by their privacy settings.") + "</p></div>");
      } else {
        out.push(cardHtml(data, m, i, s));
      }
      if (m.text && m.text !== s.caption) out.push(textHtml(m.text, q));
      return out.join("");
    }

    m.vis.audio.forEach((f, n) => out.push(voiceHtml(f, m, n)));
    m.vis.files.forEach((f) => out.push('<a class="bubble file shape" href="' + esc(fileUrl(f)) + '" target="_blank" rel="noopener" title="Open the file">' + ICON.file + "<span>" + esc(f.split("/").pop()) + "</span></a>"));

    if (m.vis.videos.length || m.vis.images.length) {
      const blocks = m.vis.videos.map((x) => '<button class="media shape"' + mediaAttr(data, i, x.file) + ">" +
        (x.poster ? img(data, x.poster) : '<video preload="metadata" muted src="' + fileUrl(x.file) + '#t=0.1"></video>') +
        '<span class="play"><span>' + ICON.play + "</span></span></button>");
      m.vis.images.forEach((f) => blocks.push('<button class="media shape"' + mediaAttr(data, i, f) + ">" + img(data, f) + "</button>"));
      out.push(blocks.length > 1 ? '<div class="media-row">' + blocks.join("") + "</div>" : blocks[0]);
    } else if ((m.type === "GIFS" || m.type === "INSTAGRAM_MESSAGING_ANIMATED_IMAGE") && !m.text) {
      out.push('<div class="gif-ph shape" title="GIFs and stickers aren\'t saved in the archive">GIF</div>');
    }

    if (m.text) out.push(textHtml(m.text, q));
    if (!out.length) out.push('<div class="bubble gone shape">' + esc(typeLabel(m.type)) + " not saved in the archive</div>");
    return out.join("");
  }

  function textHtml(text, q) {
    if (emojiOnly(text)) return '<div class="big-emoji">' + esc(text) + "</div>";
    return '<div class="bubble shape">' + markHtml(linkify(esc(text)), q) + "</div>";
  }

  function cardHtml(data, m, i, s) {
    const link = s.link || "";
    const isReel = s.decoration === "REEL" || /\/reels?\//.test(link);
    const isStory = /\/stories\//.test(link);
    const thumb = m.vis.thumb;
    const media = m.vis.videos[0] ? m.vis.videos[0].file : thumb;
    const acct = s.account || "";
    const head = '<div class="card-head">' + avatar({ name: acct }, "sm") + "<span>" + esc(acct) + "</span></div>";

    let cap = s.caption || "";
    let capHtml = "";
    if (cap) {
      if (acct && cap.startsWith(acct + " ")) capHtml = "<b>" + esc(acct) + "</b>" + esc(cap.slice(acct.length + 1));
      else capHtml = esc(cap);
    }

    let badge = "";
    if (isReel) badge = ICON.reel;
    else if (s.decoration === "COLLAGE") badge = ICON.carousel;
    else if (s.decoration === "VIDEO") badge = ICON.video;

    const attrs = (media ? mediaAttr(data, i, media) : "") + (link ? ' data-link="' + esc(link) + '"' : "");
    if (!thumb) {  // official exports hold the link and caption of a share, never its picture
      const what = isReel ? "Reel" : s.kind === "profile" ? "Profile" : isStory ? "Story" : /instagram\.com/i.test(link) ? "Post" : "Link";
      const where = /instagram\.com/i.test(link) ? "Open on Instagram" : "Open link";
      return '<button class="card compact shape"' + attrs + ' title="' + esc(link || acct) + '">' + (acct ? head : "") + (capHtml ? '<div class="card-cap">' + capHtml + "</div>" : "") +
        '<div class="card-open">' + ICON.ext + esc(link ? what + " · " + where : s.note || "No preview") + "</div></button>";
    }
    const cls = isReel || isStory ? "card reel shape" : "card shape";
    const pic = '<div class="card-img">' + img(data, thumb) + (badge ? '<span class="card-badge">' + badge + "</span>" : "") + "</div>";
    return '<button class="' + cls + '"' + attrs + ' title="' + esc(link || acct) + '">' + head + pic + (capHtml ? '<div class="card-cap">' + capHtml + "</div>" : "") + "</button>";
  }

  function voiceHtml(file, m, n) {
    const bars = 34;
    let wave = m.wave;
    if (!wave || !wave.length) {
      let h = 0;
      for (const c of m.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
      wave = Array.from({ length: bars }, (_, k) => { h = (h * 1103515245 + 12345) >>> 0; return 0.25 + ((h >>> 16) % 1000) / 1400 + 0.1 * Math.sin(k / 2); });
    }
    const pick = Array.from({ length: bars }, (_, k) => wave[Math.floor((k * wave.length) / bars)] || 0);
    const dur = m.dur ? fmtDur(m.dur / 1000) : "0:00";
    return '<div class="bubble voice shape" data-audio="' + esc(fileUrl(file)) + '" data-dur="' + esc(dur) + '"><button class="voice-play" title="Play">' + ICON.play + '</button><div class="wave">' +
      pick.map((x) => '<i style="height:' + Math.round(4 + Math.min(1, x) * 22) + 'px"></i>').join("") + '</div><span class="voice-time">' + dur + "</span></div>";
  }

  function fmtDur(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
  }

  /* ---------------- voice playback ---------------- */
  function toggleVoice(el, seekFrac) {
    const src = el.dataset.audio;
    let a = state.audio;
    if (!a || a.el !== el) {
      if (a) { a.audio.pause(); resetVoice(a.el); }
      const audio = new Audio(src);
      a = state.audio = { el, audio };
      audio.addEventListener("timeupdate", () => paintVoice(a));
      audio.addEventListener("ended", () => { resetVoice(el); state.audio = null; });
      audio.addEventListener("loadedmetadata", () => paintVoice(a));
    }
    if (seekFrac != null && isFinite(a.audio.duration)) a.audio.currentTime = seekFrac * a.audio.duration;
    if (a.audio.paused || seekFrac != null) { a.audio.play().catch(() => {}); el.querySelector(".voice-play").innerHTML = ICON.pause; }
    else { a.audio.pause(); el.querySelector(".voice-play").innerHTML = ICON.play; }
  }

  function paintVoice(a) {
    if (!a.el.isConnected) return;
    const d = a.audio.duration, t = a.audio.currentTime;
    const frac = d ? t / d : 0;
    const bars = a.el.querySelectorAll(".wave i");
    bars.forEach((b, k) => b.classList.toggle("on", k / bars.length < frac));
    a.el.querySelector(".voice-time").textContent = fmtDur(d ? d - t : 0);
  }

  function resetVoice(el) {
    if (!el.isConnected) return;
    el.querySelector(".voice-play").innerHTML = ICON.play;
    el.querySelectorAll(".wave i").forEach((b) => b.classList.remove("on"));
    el.querySelector(".voice-time").textContent = el.dataset.dur;
  }

  /* ---------------- chat events ---------------- */
  function bindChat() {
    const sc = $("scroller");
    sc.addEventListener("scroll", () => {
      if (!state.view) return;
      if (sc.scrollTop < 700) loadOlder();
      if (sc.scrollHeight - sc.scrollTop - sc.clientHeight < 700) loadNewer();
      updateToBottom();
      queueScrub();
    }, { passive: true });
    bindScrub();
    ["wheel", "touchmove", "keydown", "mousedown"].forEach((ev) => sc.addEventListener(ev, () => { if (state.view) state.view.stick = false; }, { passive: true }));
    $("msgs").addEventListener("load", () => { if (state.view && state.view.stick) sc.scrollTop = sc.scrollHeight; }, true);

    $("msgs").addEventListener("click", (e) => {
      const voice = e.target.closest(".voice");
      if (voice) {
        const wave = e.target.closest(".wave");
        if (wave) { const r = wave.getBoundingClientRect(); return toggleVoice(voice, (e.clientX - r.left) / r.width); }
        return toggleVoice(voice);
      }
      const jump = e.target.closest("[data-jump]");
      if (jump) return jumpTo(+jump.dataset.jump, true);
      const react = e.target.closest("[data-react]");
      if (react) return showReactions(+react.dataset.react);
      const media = e.target.closest("[data-media]");
      if (media && !e.target.closest("a")) return openViewer(+media.dataset.media, media.dataset.link);
      const link = e.target.closest("[data-link]");
      if (link) return window.open(link.dataset.link, "_blank", "noopener");
    });

    $("to-bottom").addEventListener("click", () => showLatest());
    $("back-btn").addEventListener("click", () => { location.hash = ""; });
    $("info-btn").addEventListener("click", toggleDetails);
    $("convo-who").addEventListener("click", toggleDetails);
    $("details-close").addEventListener("click", () => { $("details").hidden = true; });
    $("search-btn").addEventListener("click", () => ($("find").hidden ? openFind() : closeFind()));
    $("cal-btn").addEventListener("click", () => toggleCal());
    document.addEventListener("mousedown", (e) => {
      if (!$("cal").hidden && !e.target.closest("#cal") && !e.target.closest("#cal-btn")) toggleCal(false);
    });
    $("find-close").addEventListener("click", closeFind);
    $("find-q").addEventListener("input", debounce(runFind, 200));
    $("find-q").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); stepFind(e.shiftKey ? 1 : -1); } if (e.key === "Escape") closeFind(); });
    $("find-prev").addEventListener("click", () => stepFind(-1));
    $("find-next").addEventListener("click", () => stepFind(1));

    $("theme-btn").addEventListener("click", () => {
      const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
      document.documentElement.dataset.theme = dark ? "light" : "dark";
      try { localStorage.setItem("iga-theme", document.documentElement.dataset.theme); } catch (e) {}
    });

    $("viewer-close").addEventListener("click", closeViewer);
    $("viewer-prev").addEventListener("click", () => stepViewer(-1));
    $("viewer-next").addEventListener("click", () => stepViewer(1));
    $("viewer-goto").addEventListener("click", () => { const it = state.viewer && state.view.data.media[state.viewer.n]; closeViewer(); if (it) jumpTo(it.i, true); });
    $("viewer").addEventListener("click", (e) => { if (e.target.id === "viewer" || e.target.id === "viewer-stage") closeViewer(); });
    $("modal-close").addEventListener("click", () => { $("modal").hidden = true; });
    $("modal").addEventListener("click", (e) => { if (e.target.id === "modal") $("modal").hidden = true; });

    document.addEventListener("keydown", (e) => {
      if (svKey(e)) return;
      if (e.key === "Escape" && state.profileOpen && $("viewer").hidden && $("modal").hidden) { location.hash = state.beforeProfile || ""; return; }
      if (!$("viewer").hidden) {
        if (e.key === "Escape") closeViewer();
        if (e.key === "ArrowLeft") stepViewer(-1);
        if (e.key === "ArrowRight") stepViewer(1);
        return;
      }
      if (e.key === "Escape") { if (!$("cal").hidden) toggleCal(false); else if (!$("modal").hidden) $("modal").hidden = true; else if (!$("find").hidden) closeFind(); else if (!$("details").hidden) $("details").hidden = true; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f" && state.view) { e.preventDefault(); openFind(); }
    });
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  /* ---------------- find in conversation ---------------- */
  function openFind() {
    $("find").hidden = false;
    $("find-q").focus();
    $("find-q").select();
  }

  function closeFind() {
    $("find").hidden = true;
    $("find-results").hidden = true;
    $("find-q").value = "";
    $("find-count").textContent = "";
    if (state.view && state.view.q) {
      state.view.q = null;
      rerenderKeep();
    }
  }

  function rerenderKeep() {
    const v = state.view;
    keepAnchor(() => {
      const msgs = $("msgs");
      msgs.innerHTML = itemsHtml(v.start, v.end);
      syncEdges();
    });
  }

  function runFind() {
    const v = state.view;
    if (!v) return;
    const q = $("find-q").value.trim();
    if (!q) { v.q = null; v.hits = []; $("find-count").textContent = ""; $("find-results").hidden = true; rerenderKeep(); return; }
    const Q = (v.q = parseQuery(q));
    v.hits = [];
    let similar = 0;
    v.data.visible.forEach((m, i) => {
      const score = scoreMessage(m, Q);
      if (score) { v.hits.push(i); if (score === 1) similar++; }
    });
    v.hit = v.hits.length;
    $("find-count").textContent = v.hits.length ? v.hits.length + " found" + (similar ? " (" + similar + " similar)" : "") : "No results";
    const res = $("find-results");
    res.hidden = !v.hits.length;
    res.innerHTML = v.hits.slice(-150).reverse().map((i) => {
      const m = v.data.visible[i];
      return '<button class="hit" data-i="' + i + '"><b>' + (m.me ? "You" : esc(person(v.data, m.s).name)) + '</b> <small class="muted-inline">· ' + fullFmt.format(new Date(m.t)) + "</small><p>" + snippet(m.sx, Q) + "</p></button>";
    }).join("") + (v.hits.length > 150 ? '<p class="muted">Showing the newest 150 of ' + v.hits.length + " matches. Use ↑ ↓ to step through all.</p>" : "");
    res.querySelectorAll(".hit").forEach((b) => b.addEventListener("click", () => { const i = +b.dataset.i; v.hit = v.hits.indexOf(i); res.hidden = true; showHit(); }));
    rerenderKeep();
  }

  function stepFind(dir) {
    const v = state.view;
    if (!v || !v.hits.length) return;
    v.hit = Math.min(v.hits.length - 1, Math.max(0, (v.hit >= v.hits.length ? v.hits.length : v.hit) + dir));
    $("find-results").hidden = true;
    showHit();
  }

  function showHit() {
    const v = state.view;
    $("find-count").textContent = v.hit + 1 + " of " + v.hits.length;
    const i = v.hits[v.hit];
    jumpTo(i, true);
  }

  /* ---------------- calendar jump ---------------- */
  const monthFmt = new Intl.DateTimeFormat(undefined, { month: "long" });
  const wdFmt = new Intl.DateTimeFormat(undefined, { weekday: "narrow" });
  const CHEV_L = '<svg viewBox="0 0 24 24"><path d="M15 4.5 7.5 12l7.5 7.5"/></svg>';
  const CHEV_R = '<svg viewBox="0 0 24 24"><path d="m9 4.5 7.5 7.5L9 19.5"/></svg>';

  function visibleIndex() {
    const top = $("scroller").getBoundingClientRect().top;
    const it = [...$("msgs").querySelectorAll(".it")].find((e) => e.getBoundingClientRect().bottom > top + 8);
    return it ? +it.dataset.i : state.view.data.visible.length - 1;
  }

  function toggleCal(force) {
    const cal = $("cal");
    const open = force != null ? force : cal.hidden;
    if (!open || !state.view) {
      cal.hidden = true;
      $("cal-btn").classList.remove("on");
      return;
    }
    const d = new Date(state.view.data.visible[visibleIndex()].t);
    state.cal = { y: d.getFullYear(), m: d.getMonth(), cur: dayKey(d.getTime()) };
    cal.hidden = false;
    $("cal-btn").classList.add("on");
    renderCal();
  }

  function renderCal() {
    const data = state.view.data, v = data.visible, c = state.cal;
    const first = new Date(v[0].t), last = new Date(v[v.length - 1].t);
    const firstM = first.getFullYear() * 12 + first.getMonth(), lastM = last.getFullYear() * 12 + last.getMonth();
    const curM = Math.min(lastM, Math.max(firstM, c.y * 12 + c.m));
    c.y = Math.floor(curM / 12);
    c.m = curM % 12;

    const lo = dayKey(first.getTime()), hi = dayKey(last.getTime());
    const months = Array.from({ length: 12 }, (_, k) => {
      const inRange = c.y * 12 + k >= firstM && c.y * 12 + k <= lastM;
      return '<option value="' + k + '"' + (k === c.m ? " selected" : "") + (inRange ? "" : " disabled") + ">" + esc(monthFmt.format(new Date(2000, k, 1))) + "</option>";
    }).join("");
    let years = "";
    for (let y = first.getFullYear(); y <= last.getFullYear(); y++) years += '<option value="' + y + '"' + (y === c.y ? " selected" : "") + ">" + y + "</option>";

    const weekdays = Array.from({ length: 7 }, (_, k) => '<div class="cal-wd">' + esc(wdFmt.format(new Date(2023, 0, 1 + k))) + "</div>").join("");
    const offset = new Date(c.y, c.m, 1).getDay();
    const daysIn = new Date(c.y, c.m + 1, 0).getDate();
    let cells = "", monthCount = 0, activeDays = 0;
    for (let k = 0; k < offset; k++) cells += '<span class="cal-day blank"></span>';
    for (let day = 1; day <= daysIn; day++) {
      const key = c.y * 10000 + (c.m + 1) * 100 + day;
      const info = data.days.get(key);
      const out = key < lo || key > hi;
      let cls = "cal-day";
      if (out) cls += " out";
      if (info) {
        monthCount += info.n;
        activeDays++;
        cls += " has l" + (info.n > 60 ? 4 : info.n > 20 ? 3 : info.n > 5 ? 2 : 1);
      }
      if (key === c.cur) cls += " cur";
      const title = out ? "Outside the archive" : info ? info.n + (info.n === 1 ? " message" : " messages") : "No messages, jumps to the next day that has some";
      cells += '<button class="' + cls + '" data-k="' + key + '" title="' + esc(title) + '"' + (out ? " disabled" : "") + ">" + day + "</button>";
    }

    $("cal").innerHTML =
      '<div class="cal-range">Available: <b>' + esc(dateFmt.format(first)) + "</b> – <b>" + esc(dateFmt.format(last)) + "</b><br>" +
      data.days.size.toLocaleString() + " days with messages · " + v.length.toLocaleString() + " messages</div>" +
      '<div class="cal-nav"><button class="icon-btn" data-step="-1" title="Previous month"' + (curM <= firstM ? " disabled" : "") + ">" + CHEV_L + "</button>" +
      '<select id="cal-month" aria-label="Month">' + months + '</select><select id="cal-year" aria-label="Year">' + years + "</select>" +
      '<button class="icon-btn" data-step="1" title="Next month"' + (curM >= lastM ? " disabled" : "") + ">" + CHEV_R + "</button></div>" +
      '<div class="cal-grid">' + weekdays + cells + "</div>" +
      '<div class="cal-month-info">' + (monthCount ? monthCount.toLocaleString() + " messages on " + activeDays + (activeDays === 1 ? " day" : " days") + " this month" : "No messages this month") + "</div>" +
      '<div class="cal-legend">Less <i style="background:rgba(var(--heat),.18)"></i><i style="background:rgba(var(--heat),.38)"></i><i style="background:rgba(var(--heat),.62)"></i><i style="background:rgb(var(--heat))"></i> More</div>' +
      '<div class="cal-actions"><button class="btn-gray" id="cal-first">↑ First message</button><button class="btn-gray" id="cal-last">Latest ↓</button></div>';

    const cal = $("cal");
    cal.querySelectorAll("[data-step]").forEach((b) => b.addEventListener("click", () => {
      const m = c.y * 12 + c.m + +b.dataset.step;
      c.y = Math.floor(m / 12);
      c.m = m % 12;
      renderCal();
    }));
    $("cal-month").addEventListener("change", (e) => { c.m = +e.target.value; renderCal(); });
    $("cal-year").addEventListener("change", (e) => { c.y = +e.target.value; renderCal(); });
    cal.querySelectorAll(".cal-day[data-k]:not(.out)").forEach((b) => b.addEventListener("click", () => {
      const key = +b.dataset.k;
      const info = data.days.get(key);
      const i = info ? info.i : firstAtOrAfter(v, new Date(Math.floor(key / 10000), (Math.floor(key / 100) % 100) - 1, key % 100).getTime());
      toggleCal(false);
      jumpTo(i, true);
    }));
    $("cal-first").addEventListener("click", () => { toggleCal(false); showFirst(); });
    $("cal-last").addEventListener("click", () => { toggleCal(false); showLatest(); });
  }

  /* ---------------- details panel ---------------- */
  function toggleDetails() {
    const d = $("details");
    d.hidden = !d.hidden;
    if (!d.hidden) renderDetails();
  }

  function renderDetails(tab, limit) {
    const v = state.view;
    if (!v) return;
    const data = v.data;
    tab = tab || "media";
    limit = limit || 60;
    const members = data.members.map((p) =>
      '<div class="member">' + avatar(p, "lg") + "<div><b>" + esc(p.name) + "</b><small>" + esc(p.username) + "</small></div>" +
      (p.username ? '<a class="icon-btn" href="https://www.instagram.com/' + encodeURIComponent(p.username) + '/" target="_blank" rel="noopener" title="Open profile on Instagram">' + ICON.ext + "</a>" : "") + "</div>").join("");
    const first = new Date(data.first), last = new Date(data.last);
    const origin = (data.sources || []).map((s) => (s === "export" ? "official export" : "scraped data")).join(" + ");
    const notes = [];
    if (data.request) notes.push("Message request, not accepted.");
    if (data.left) notes.push("You are no longer in this group.");
    if (origin) notes.push("From " + origin + ".");

    let body = "";
    if (tab === "media" || tab === "shared") {
      const pool = data.media.filter((x) => !data.visible[x.i].share === (tab === "media"));
      const items = pool.slice().reverse().slice(0, limit);
      body = items.length ? '<div class="grid">' + items.map((x) => {
        const n = data.media.indexOf(x);
        const pic = x.type === "video" ? x.poster : x.file;
        const still = x.type === "video" && !pic ? '<video preload="metadata" muted src="' + fileUrl(x.file) + '#t=0.1"></video>' : "";
        return '<button data-media="' + n + '" style="' + (pic ? "background-image:" + cssUrl(pic) : "") + '">' + still + (x.type === "video" ? ICON.video : "") + "</button>";
      }).join("") + "</div>" + (pool.length > limit ? '<button class="more" data-more="' + tab + '">Show more</button>' : "") : '<p class="muted">' + (tab === "media" ? "No photos or videos." : "No shared reels or posts.") + "</p>";
    } else if (tab === "links") {
      const items = data.links.slice().reverse().slice(0, limit);
      body = items.length ? '<div class="links">' + items.map((l) => '<a href="' + esc(l.url) + '" target="_blank" rel="noopener" data-i="' + l.i + '"><small>' + esc(dateFmt.format(new Date(data.visible[l.i].t))) + (l.label ? " · " + esc(l.label) : "") + "</small>" + esc(l.url.length > 120 ? l.url.slice(0, 120) + "…" : l.url) + "</a>").join("") + "</div>" + (data.links.length > limit ? '<button class="more" data-more="links">Show more</button>' : "") : '<p class="muted">No links.</p>';
    } else {
      const items = data.voice.slice().reverse().slice(0, limit);
      body = items.length ? '<div class="links">' + items.map((x) => {
        const m = data.visible[x.i];
        return '<div style="padding:10px 24px;border-bottom:1px solid var(--line)"><small class="muted-inline">' + (m.me ? "You" : esc(person(data, m.s).name)) + " · " + esc(fullFmt.format(new Date(m.t))) + '</small><audio controls preload="none" style="width:100%;margin-top:6px" src="' + esc(fileUrl(x.file)) + '"></audio></div>';
      }).join("") + "</div>" + (data.voice.length > limit ? '<button class="more" data-more="voice">Show more</button>' : "") : '<p class="muted">No voice messages.</p>';
    }

    $("details-body").innerHTML =
      '<div class="dsec"><h4>' + (data.group ? "Members" : "Chat with") + "</h4>" + members + "</div>" +
      '<div class="dsec"><div class="stats"><div><small>Messages</small><b>' + data.count.toLocaleString() + "</b></div><div><small>Photos & videos</small><b>" + data.media.filter((x) => !data.visible[x.i].share).length.toLocaleString() + "</b></div>" +
      "<div><small>First message</small><b>" + esc(dateFmt.format(first)) + "</b></div><div><small>Last message</small><b>" + esc(dateFmt.format(last)) + "</b></div></div>" +
      (notes.length ? '<p class="dsec-note" style="margin-top:12px">' + esc(notes.join(" ")) + "</p>" : "") + "</div>" +
      '<div class="dsec"><h4>Jump to date</h4><p class="muted-inline" style="margin:0 0 12px">Available: ' + esc(dateFmt.format(first)) + " – " + esc(dateFmt.format(last)) + '</p><div class="jump"><button class="btn-gray" id="jump-cal">Open calendar</button><button class="btn-gray" id="jump-first">↑ First message</button></div></div>' +
      exportHtml(data) +
      '<div class="dtabs"><button data-tab="media" class="' + (tab === "media" ? "on" : "") + '">Media</button><button data-tab="shared" class="' + (tab === "shared" ? "on" : "") + '">Shared</button><button data-tab="links" class="' + (tab === "links" ? "on" : "") + '">Links</button><button data-tab="voice" class="' + (tab === "voice" ? "on" : "") + '">Voice</button></div>' + body;

    const root = $("details-body");
    root.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => renderDetails(b.dataset.tab)));
    root.querySelectorAll("[data-more]").forEach((b) => b.addEventListener("click", () => {
      const top = root.scrollTop;
      renderDetails(b.dataset.more, limit + 90);
      root.scrollTop = top;
    }));
    root.querySelectorAll(".grid [data-media]").forEach((b) => b.addEventListener("click", () => openViewer(+b.dataset.media)));
    const narrow = () => { if (matchMedia("(max-width: 1023px)").matches) $("details").hidden = true; };
    $("jump-cal").addEventListener("click", () => { narrow(); toggleCal(true); });
    $("jump-first").addEventListener("click", () => { narrow(); showFirst(); });
    wireExport(data);
  }

  /* ---------------- export for AI ---------------- */
  const picks = (list, cur) => list.map(([v, label]) => '<option value="' + v + '"' + (v === cur ? " selected" : "") + ">" + label + "</option>").join("");

  function exportHtml(data) {
    const x = state.exp;
    const first = IGAExport.dayOf(data.first), last = IGAExport.dayOf(data.last);
    const date = (id, v) => '<input type="date" id="' + id + '" min="' + first + '" max="' + last + '" value="' + esc(v) + '">';
    return '<div class="dsec" id="xp"><h4>Export for AI</h4>' +
      '<p class="dsec-note">The chat as compact text for an LLM: replies, reactions and shared reels included.</p>' +
      '<div class="xp-row"><label>From' + date("xp-from", x.from) + "</label><label>To" + date("xp-to", x.to) + "</label></div>" +
      '<div class="xp-row"><label>Times<select id="xp-times">' + picks([["sparse", "Every 10 min"], ["every", "Every message"], ["none", "Dates only"]], x.times) + "</select></label>" +
      '<label>Reel captions<select id="xp-caps">' + picks([["short", "Short"], ["full", "Full"], ["none", "None"]], x.captions) + "</select></label></div>" +
      '<label class="xp-check"><input type="checkbox" id="xp-ids"' + (x.ids ? " checked" : "") + "> Number every message</label>" +
      '<label class="xp-check"><input type="checkbox" id="xp-links"' + (x.links ? " checked" : "") + "> Include reel and post links</label>" +
      '<p class="xp-sum" id="xp-sum"></p>' +
      '<div class="jump"><button class="btn-gray" id="xp-dl">Download .txt</button><button class="btn-gray" id="xp-copy">Copy</button><button class="btn-gray" id="xp-all">All time</button></div>' +
      '<details class="xp-exact"><summary>Exact Gemini count</summary>' +
      '<p class="dsec-note">Sends this text to Google\'s countTokens API with your key. The key is used once and not saved.</p>' +
      '<div class="xp-row"><label>API key<input type="password" id="xp-key" autocomplete="off"></label><label>Model<input id="xp-model" value="' + esc(x.model) + '"></label></div>' +
      '<div class="jump"><button class="btn-gray" id="xp-count">Count</button><span class="muted-inline" id="xp-exact"></span></div></details>' +
      '<pre class="xp-peek" id="xp-peek"></pre></div>';
  }

  function exportText(data) {
    const x = state.exp;
    const edge = (s, end) => { if (!s) return null; const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d + (end ? 1 : 0)).getTime() - (end ? 1 : 0); };
    const key = JSON.stringify([data.id, x.from, x.to, x.times, x.captions, x.ids, x.links]);
    if (!state.expOut || state.expOut.key !== key) {
      const out = IGAExport.build(data, { from: edge(x.from, false), to: edge(x.to, true), times: x.times, captions: x.captions, ids: x.ids, links: x.links });
      state.expOut = Object.assign(out, { key, tokens: IGAExport.estimateTokens(out.text) });
    }
    return state.expOut;
  }

  function wireExport(data) {
    const x = state.exp;
    const refresh = () => {
      const out = exportText(data);
      const kb = out.text.length >= 1e6 ? (out.text.length / 1e6).toFixed(1) + " MB" : Math.max(1, Math.round(out.text.length / 1000)) + " KB";
      $("xp-sum").innerHTML = "<b>" + out.messages.toLocaleString() + "</b> messages · about <b>" + out.tokens.toLocaleString() + "</b> Gemini tokens (estimate) · " + kb +
        (out.tokens > 1e6 ? '<br><span class="muted-inline">Over a million tokens: narrow the dates for most models.</span>' : "");
      $("xp-peek").textContent = out.text.split("\n").slice(0, 14).join("\n").slice(0, 1400);
      $("xp-exact").textContent = "";
    };
    const bind = (id, field, prop) => $(id).addEventListener("input", (e) => { x[field] = e.target[prop || "value"]; refresh(); });
    bind("xp-from", "from");
    bind("xp-to", "to");
    bind("xp-times", "times");
    bind("xp-caps", "captions");
    bind("xp-ids", "ids", "checked");
    bind("xp-links", "links", "checked");
    $("xp-all").addEventListener("click", () => { x.from = x.to = ""; $("xp-from").value = $("xp-to").value = ""; refresh(); });

    $("xp-dl").addEventListener("click", () => {
      const out = exportText(data);
      const name = (data.title || "chat").replace(/[^\p{L}\p{M}\p{N}]+/gu, "_").replace(/^_|_$/g, "") + "_" + (out.first || "empty") + "_to_" + (out.last || "empty") + ".txt";
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([out.text], { type: "text/plain;charset=utf-8" }));
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    });
    $("xp-copy").addEventListener("click", async () => {
      const btn = $("xp-copy"), text = exportText(data).text;
      try { await navigator.clipboard.writeText(text); }
      catch (e) {
        const t = document.createElement("textarea");
        t.value = text;
        document.body.appendChild(t);
        t.select();
        document.execCommand("copy");
        t.remove();
      }
      btn.textContent = "Copied";
      setTimeout(() => { btn.textContent = "Copy"; }, 1500);
    });

    $("xp-model").addEventListener("input", (e) => { x.model = e.target.value.trim(); });
    $("xp-count").addEventListener("click", async () => {
      const key = $("xp-key").value.trim(), out = $("xp-exact");
      if (!key) { out.textContent = "Enter an API key."; return; }
      out.textContent = "Counting…";
      try { out.textContent = (await IGAExport.countWithGemini(exportText(data).text, key, x.model || "gemini-2.5-flash")).toLocaleString() + " tokens (exact)"; }
      catch (e) { out.textContent = "Failed: " + e.message; }
    });
    refresh();
  }

  /* ---------------- reactions modal ---------------- */
  function showReactions(i) {
    const data = state.view.data, m = data.visible[i];
    $("modal-title").textContent = "Reactions";
    $("modal-body").innerHTML = m.react.map(([emoji, by]) => {
      const p = by === "You" ? data.people[data.meId] : Object.values(data.people).find((x) => x.name === by);
      return '<div class="react-row">' + avatar(p || { name: by }, "md") + "<b>" + esc(by) + "</b><span>" + esc(emoji) + "</span></div>";
    }).join("");
    $("modal").hidden = false;
  }

  /* ---------------- media viewer ---------------- */
  function openViewer(n, link) {
    state.viewer = { n, link };
    $("viewer").hidden = false;
    showViewer();
  }

  function stepViewer(dir) {
    const list = state.view.data.media;
    const n = state.viewer.n + dir;
    if (n < 0 || n >= list.length) return;
    state.viewer = { n, link: null };
    showViewer();
  }

  function showViewer() {
    const data = state.view.data, list = data.media;
    const it = list[state.viewer.n];
    if (!it) return closeViewer();
    const m = data.visible[it.i];
    const who = m.me ? data.people[data.meId] || { name: "You" } : person(data, m.s);
    const stage = $("viewer-stage");
    stage.innerHTML = it.type === "video"
      ? '<video controls autoplay playsinline src="' + fileUrl(it.file) + '"' + (it.poster ? ' poster="' + fileUrl(it.poster) + '"' : "") + "></video>"
      : '<img src="' + fileUrl(it.file) + '" alt="">';
    $("viewer-who").innerHTML = avatar(who, "sm") + "<div><b>" + esc(m.me ? "You" : who.name) + "</b><small>" + esc(fullFmt.format(new Date(m.t))) + "</small></div>";
    const link = state.viewer.link || (m.share && m.share.link);
    const open = $("viewer-open");
    open.href = link || fileUrl(it.file);
    open.textContent = link ? "Open on Instagram" : "Open file";
    $("viewer-prev").disabled = state.viewer.n === 0;
    $("viewer-next").disabled = state.viewer.n === list.length - 1;
    $("viewer-count").textContent = state.viewer.n + 1 + " / " + list.length;
  }

  function closeViewer() {
    $("viewer").hidden = true;
    $("viewer-stage").innerHTML = "";
    state.viewer = null;
  }
  /* ---------------- story archive ---------------- */
  const SV = { data: null, waiting: null, list: null, n: 0, timer: null, started: 0, spent: 0, paused: false, muted: false, title: "" };
  const monthLong = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
  const monthShort = new Intl.DateTimeFormat(undefined, { month: "short" });
  const PHOTO_MS = 5000;
  const SV_ICON = {
    close: '<svg viewBox="0 0 24 24"><path d="m5 5 14 14M19 5 5 19"/></svg>',
    prev: '<svg viewBox="0 0 24 24"><path d="M15 4.5 7.5 12l7.5 7.5"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="m9 4.5 7.5 7.5L9 19.5"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path class="fill" d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path class="fill" d="M7 4.5v15l12.5-7.5z"/></svg>',
    sound: '<svg viewBox="0 0 24 24"><path d="M4 9.5v5h3.5L12 19V5L7.5 9.5z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>',
    mute: '<svg viewBox="0 0 24 24"><path d="M4 9.5v5h3.5L12 19V5L7.5 9.5z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/></svg>',
    archive: '<svg viewBox="0 0 24 24"><path d="M12 2.5a9.5 9.5 0 1 1-9.5 9.5" stroke-dasharray="2.6 2.4"/><path d="M12 2.5A9.5 9.5 0 0 0 2.5 12"/><path d="M12 7v5l3.2 2"/></svg>',
  };

  try { SV.size = localStorage.getItem("iga-tile") || "m"; } catch (err) { SV.size = "m"; }

  IGA.receiveStories = function (data) {
    const list = [];
    data.archive.forEach((day, d) => day.stories.forEach((s) => { s.day = d; s.date = day.date; list.push(s); }));
    data.list = list;
    data.list.forEach((s, k) => { s.k = k; });
    data.highlights.forEach((h) => h.stories.forEach((s, k) => { s.hl = h; s.k = k; }));
    SV.data = data;
    (SV.waiting || []).forEach((fn) => fn(data));
    SV.waiting = null;
  };

  function loadStories() {
    return new Promise((resolve, reject) => {
      if (SV.data) return resolve(SV.data);
      if (SV.waiting) return SV.waiting.push(resolve);
      SV.waiting = [resolve];
      const s = document.createElement("script");
      s.src = "_archive/data/stories.js" + stampQ();
      s.onerror = () => { SV.waiting = null; reject(new Error("The story archive data is missing. Run build_archive.py again.")); };
      document.body.appendChild(s);
    });
  }

  function storiesSummaryText(sum) {
    return sum.count.toLocaleString() + " stories · " + sum.days.toLocaleString() + " days · " + dateFmt.format(new Date(sum.first)) + " – " + dateFmt.format(new Date(sum.last));
  }

  /* ---------------- profile: stories + people (full screen) ---------------- */
  const PEOPLE = { data: null, waiting: null, q: "", filter: "all", sort: "default", shown: 150, tab: "followers" };
  const TABS = [["stories", "Stories"], ["followers", "Followers"], ["following", "Following"], ["blocked", "Blocked"], ["close", "Close friends"]];
  const PF_ICON = {
    lock: '<svg viewBox="0 0 24 24"><rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></svg>',
    verified: '<svg viewBox="0 0 24 24" class="pp-verified"><path class="fill" d="M12 1.8 14.5 4l3.3-.3.9 3.2 2.9 1.6-1.1 3.1 1.1 3.1-2.9 1.6-.9 3.2-3.3-.3L12 22.2 9.5 20l-3.3.3-.9-3.2-2.9-1.6 1.1-3.1-1.1-3.1 2.9-1.6.9-3.2L9.5 4z"/><path d="m8.2 12.2 2.6 2.6 5-5.2" style="stroke:#fff;stroke-width:2"/></svg>',
    star: '<svg viewBox="0 0 24 24"><path class="fill" d="m12 2.8 2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.2 6.4 20.2l1.1-6.3L2.9 9.5l6.3-.9z"/></svg>',
    chat: '<svg viewBox="0 0 24 24"><path d="M21.5 2.5 2.5 9.8l7.2 3.1 3.2 8.6z"/></svg>',
  };

  IGA.receivePeople = function (data) {
    data.index = {};
    ["followers", "following", "blocked"].forEach((kind) => { data.index[kind] = new Map(data[kind].map((p) => [p.pk, p])); });
    PEOPLE.data = data;
    (PEOPLE.waiting || []).forEach((fn) => fn(data));
    PEOPLE.waiting = null;
  };

  function loadPeople() {
    return new Promise((resolve, reject) => {
      if (PEOPLE.data) return resolve(PEOPLE.data);
      if (PEOPLE.waiting) return PEOPLE.waiting.push(resolve);
      PEOPLE.waiting = [resolve];
      const s = document.createElement("script");
      s.src = "_archive/data/people.js" + stampQ();
      s.onerror = () => { PEOPLE.waiting = null; reject(new Error("No people data in the archive yet. Import an Instagram export with import_export.py.")); };
      document.body.appendChild(s);
    });
  }

  function profileCounts() {
    const st = state.inbox.stories, pe = state.inbox.people;
    return {
      stories: st ? st.count : 0,
      followers: pe ? pe.followers : 0,
      following: pe ? pe.following : 0,
      blocked: pe ? pe.blocked : 0,
      close: pe && pe.close_friends != null ? pe.close_friends : 0,
    };
  }

  function profileAvailable() {
    return !!(state.inbox.stories || state.inbox.people);
  }

  function setCompact(on) {
    $("profile").classList.toggle("compact", on);
    $("pf-fold").title = on ? "Show the profile header" : "Hide the profile header (it also folds away when you scroll)";
  }

  function renderProfileHeader(tab) {
    const me = state.inbox.me || {};
    const pe = state.inbox.people, st = state.inbox.stories;
    const counts = profileCounts();
    const name = (pe && pe.account && pe.account.full_name) || me.name || "";
    const user = (pe && pe.account && pe.account.username) || me.username || "";
    $("pf-handle").textContent = user;
    $("pf-avatar").className = "pf-avatar" + (st && st.count ? " ring" : "");
    $("pf-avatar").innerHTML = avatar(me, "xl");
    $("pf-avatar").title = st && st.count ? "Play the latest story" : "";
    $("pf-user").textContent = user;
    $("pf-name").textContent = name;
    // the counts double as the tabs (there is no separate tab bar)
    $("pf-stats").innerHTML = [["stories", "stories"], ["followers", "followers"], ["following", "following"], ["blocked", "blocked"], ["close", "close friends"]]
      .filter(([k]) => (k === "stories" ? !!st : !!pe))
      .map(([k, label]) => '<button data-tab="' + k + '" class="' + (k === tab ? "on" : "") + '"' + (k === tab ? ' aria-current="page"' : "") + "><b>" + counts[k].toLocaleString() + "</b> " + label + "</button>").join("");
    const stamp = [];
    if (st && st.generated) stamp.push("stories saved " + dateFmt.format(new Date(st.generated)));
    if (pe && pe.generated) stamp.push("people saved " + dateFmt.format(new Date(pe.generated)));
    $("pf-sub").textContent = stamp.join(" · ");
    $("pf-mini").innerHTML = avatar(me, "xs") + [["stories", "stories"], ["followers", "followers"], ["following", "following"], ["blocked", "blocked"], ["close", "close friends"]]
      .filter(([k]) => (k === "stories" ? !!st : !!pe))
      .map(([k, label]) => '<button data-tab="' + k + '" class="' + (k === tab ? "on" : "") + '"><b>' + counts[k].toLocaleString() + "</b> " + label + "</button>").join("");
    $("pf-tabs").hidden = true;
  }

  async function openProfile(tab) {
    if (!profileAvailable()) { location.hash = ""; return; }
    const st = state.inbox.stories, pe = state.inbox.people;
    if (!TABS.some((t) => t[0] === tab)) tab = "stories";
    if (tab === "stories" && !st) tab = "followers";
    if (tab !== "stories" && !pe) tab = "stories";

    if (!state.profileOpen) state.beforeProfile = state.prevHash || "";
    state.profileOpen = true;
    state.view = null;
    $("convo").hidden = true;
    $("empty").hidden = false;
    $("details").hidden = true;
    $("profile").hidden = false;
    document.body.classList.add("pf-open");
    document.title = "Profile • Instagram Archive";
    renderProfileHeader(tab);
    $("stories").hidden = tab !== "stories";
    $("people").hidden = tab === "stories";

    if (tab === "stories") {
      if ($("stories").dataset.ready) return;
      $("stories").innerHTML = '<p class="muted" style="margin:auto">Loading stories…</p>';
      let data;
      try { data = await loadStories(); } catch (e) { $("stories").innerHTML = '<p class="muted" style="margin:auto">' + esc(e.message) + "</p>"; return; }
      renderStoriesPage(data);
      $("stories").dataset.ready = "1";
      return;
    }

    $("people").innerHTML = '<p class="muted" style="margin:auto">Loading…</p>';
    let data;
    try { data = await loadPeople(); } catch (e) { $("people").innerHTML = '<p class="muted" style="margin:auto">' + esc(e.message) + "</p>"; return; }
    if (PEOPLE.tab !== tab) { PEOPLE.q = ""; PEOPLE.filter = "all"; PEOPLE.sort = "default"; PEOPLE.shown = 150; }
    PEOPLE.tab = tab;
    if (tab === "close") renderClose(data);
    else renderPeople(data);
  }

  function closeProfile() {
    if (!state.profileOpen) return;
    state.profileOpen = false;
    $("profile").hidden = true;
    document.body.classList.remove("pf-open");
    if ($("sv") && !$("sv").hidden) closeStory();
  }

  function chatFor(username) {
    if (!state.chatByUser) {
      state.chatByUser = new Map();
      state.inbox.threads.forEach((t) => { if (!t.group && t.members[0] && t.members[0].username) state.chatByUser.set(t.members[0].username.toLowerCase(), t.id); });
    }
    return state.chatByUser.get((username || "").toLowerCase());
  }

  function personRow(p, tab, data) {
    const chat = chatFor(p.username);
    const tags = [];
    if (tab === "followers") tags.push(data.index.following.has(p.pk) ? ["mutual", "Mutual"] : ["", "Follows you"]);
    if (tab === "following") {
      tags.push(data.index.followers.has(p.pk) ? ["mutual", "Mutual"] : ["warn", "Doesn't follow you back"]);
      if (p.is_favorite) tags.push(["fav", "★ Favorite"]);
    }
    if (tab === "blocked") {
      tags.push(["bad", "Blocked"]);
      if (p.auto_blocked) tags.push(["", "Auto-blocked"]);
    }
    return '<div class="pp-row"><a href="https://www.instagram.com/' + encodeURIComponent(p.username) + '/" target="_blank" rel="noopener" class="pp-avatar" title="Open on Instagram">' + avatar({ name: p.username, avatar: p.avatar || null }, "lg") + "</a>" +
      '<div class="pp-text"><b>' + esc(p.username) + (p.is_verified ? PF_ICON.verified : "") + (p.is_private ? '<span class="pp-lock" title="Private account">' + PF_ICON.lock + "</span>" : "") + "</b>" +
      "<small>" + esc(p.full_name || (tab === "blocked" ? "" : p.note) || "") + "</small></div>" +
      '<div class="pp-tags">' + tags.map(([c, t]) => '<span class="pp-tag ' + c + '">' + esc(t) + "</span>").join("") + "</div>" +
      (chat ? '<a class="btn-gray pp-msg" href="#t=' + encodeURIComponent(chat) + '" title="Open your chat with ' + esc(p.username) + '">' + PF_ICON.chat + " Chat</a>" : "") + "</div>";
  }

  function peopleFilters(tab) {
    if (tab === "followers") return [["all", "All"], ["notback", "You don't follow back"], ["mutual", "Mutual"], ["private", "Private"], ["verified", "Verified"]];
    if (tab === "following") return [["all", "All"], ["notback", "Don't follow you back"], ["mutual", "Mutual"], ["fav", "Favorites"], ["private", "Private"], ["verified", "Verified"]];
    return [["all", "All"]];
  }

  function matchesFilter(p, tab, f, data) {
    if (f === "all") return true;
    if (f === "private") return p.is_private;
    if (f === "verified") return p.is_verified;
    if (f === "fav") return p.is_favorite;
    const other = tab === "followers" ? data.index.following : data.index.followers;
    if (f === "mutual") return other.has(p.pk);
    if (f === "notback") return !other.has(p.pk);
    return true;
  }

  function renderPeople(data) {
    const tab = PEOPLE.tab, list = data[tab];
    const filters = peopleFilters(tab);
    const title = { followers: "Followers", following: "Following", blocked: "Blocked accounts" }[tab];
    const ch = data.changes && data.changes[tab];
    let summary = list.length.toLocaleString() + " " + title.toLowerCase();
    if (tab === "followers") {
      const back = list.filter((p) => data.index.following.has(p.pk)).length;
      summary += " · " + back + " you follow back · " + (list.length - back) + " you don't";
    } else if (tab === "following") {
      const back = list.filter((p) => data.index.followers.has(p.pk)).length;
      summary += " · " + back + " follow you back · " + (list.length - back) + " don't";
    }
    const expected = data.expected && data.expected[tab];
    if (expected != null && expected !== list.length) summary += " (Instagram says " + expected + ")";

    const note = tab === "blocked" ? '<p class="pp-note">Instagram lists these with "Includes other profiles they may have or create" when the block also covers new accounts.</p>' : "";
    const changed = ch && (ch.new.length || ch.gone.length)
      ? '<p class="pp-note"><b>Since the previous save (' + esc(dateFmt.format(new Date(data.changes.since))) + "):</b> " + (ch.new.length ? "+" + ch.new.length + " new (" + esc(ch.new.slice(0, 12).join(", ")) + (ch.new.length > 12 ? "…" : "") + ")" : "") + (ch.new.length && ch.gone.length ? " · " : "") + (ch.gone.length ? "−" + ch.gone.length + " gone (" + esc(ch.gone.slice(0, 12).join(", ")) + (ch.gone.length > 12 ? "…" : "") + ")" : "") + "</p>"
      : "";

    $("people").innerHTML =
      '<div class="pp-wrap"><div class="pp-head"><div><h2>' + esc(title) + '</h2><p id="pp-summary">' + esc(summary) + "</p></div>" +
      '<label class="search-box pp-search"><svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5"/></svg><input id="pp-q" type="search" placeholder="Search ' + esc(title.toLowerCase()) + '" autocomplete="off" spellcheck="false"></label></div>' +
      changed + note +
      '<div class="pp-chips">' + filters.map(([k, label]) => '<button data-f="' + k + '" class="' + (k === PEOPLE.filter ? "on" : "") + '">' + esc(label) + "</button>").join("") +
      '<span class="pp-sort"><button data-s="default" class="' + (PEOPLE.sort === "default" ? "on" : "") + '">Instagram order</button><button data-s="az" class="' + (PEOPLE.sort === "az" ? "on" : "") + '">A–Z</button></span></div>' +
      '<div id="pp-list" class="pp-list"></div></div>';

    const input = $("pp-q");
    input.value = PEOPLE.q;
    input.addEventListener("input", debounce(() => { PEOPLE.q = input.value; PEOPLE.shown = 150; paintPeople(data); }, 120));
    $("people").querySelectorAll("[data-f]").forEach((b) => b.addEventListener("click", () => { PEOPLE.filter = b.dataset.f; PEOPLE.shown = 150; renderPeople(data); }));
    $("people").querySelectorAll("[data-s]").forEach((b) => b.addEventListener("click", () => { PEOPLE.sort = b.dataset.s; renderPeople(data); }));
    $("pp-list").addEventListener("click", (e) => { if (e.target.closest("[data-more]")) { PEOPLE.shown += 300; paintPeople(data); } });
    paintPeople(data);
  }

  function paintPeople(data) {
    const tab = PEOPLE.tab;
    const Q = parseQuery(PEOPLE.q);
    let rows = data[tab].filter((p) => matchesFilter(p, tab, PEOPLE.filter, data));
    if (Q.raw) rows = rows.filter((p) => scoreName(p.username + " " + p.full_name, Q) || (p.username + " " + p.full_name).toLowerCase().includes(Q.lower));
    if (PEOPLE.sort === "az") rows = rows.slice().sort((a, b) => a.username.localeCompare(b.username));
    const shown = rows.slice(0, PEOPLE.shown);
    $("pp-list").innerHTML = shown.length
      ? shown.map((p) => personRow(p, tab, data)).join("") + (rows.length > shown.length ? '<button class="pp-more" data-more="1">Show ' + Math.min(300, rows.length - shown.length) + " more · " + (rows.length - shown.length).toLocaleString() + " left</button>" : "")
      : '<p class="muted">Nobody matches.</p>';
    const head = $("pp-summary");
    if (head && (Q.raw || PEOPLE.filter !== "all")) head.dataset.shown = rows.length;
  }

  function renderClose(data) {
    const st = state.inbox.stories || {};
    const n = data.close_friends_count;
    const rows = data.close_friends || [];
    $("people").innerHTML = '<div class="pp-wrap"><div class="pp-head"><div><h2>Close friends</h2><p>' +
      (n == null ? "Instagram didn't report the size of the list." : "Instagram reports " + n + (n === 1 ? " person" : " people") + " on the list right now.") + "</p></div></div>" +
      (rows.length ? '<div class="pp-list">' + rows.map((p) => personRow(p, "close", data)).join("") + "</div>"
        : (n ? '<p class="pp-note">The list has people on it, but the web settings page does not say who. Open Close friends in the Instagram app to see them.</p>'
          : '<p class="pp-note">Nobody is on the close friends list at the moment.</p>')) +
      (st.cf ? '<div class="pp-cf"><span class="pp-cf-star">' + PF_ICON.star + "</span><div><b>" + st.cf.toLocaleString() + " saved stories were shared with close friends</b><p>They are marked with a green star in the story archive, so you can still see what went to close friends back then.</p><button class=\"btn-gray\" id=\"pp-cf-go\">Show them in the story archive</button></div></div>" : "") + "</div>";
    const go = $("pp-cf-go");
    if (go) go.addEventListener("click", () => { SV.cfOnly = true; $("stories").dataset.ready = ""; location.hash = "#profile=stories"; });
  }

  function tileHtml(s) {
    const d = new Date(s.t);
    const pic = s.thumb || (!s.video ? s.file : null);
    const music = (s.stickers || []).some((x) => x[0] === "music_sticker");
    const tags = s.tags || [];
    return '<button class="st-tile" data-k="' + s.k + '" title="' + esc(fullFmt.format(d) + (tags.length ? "\n@" + tags.join(", @") : "")) + '">' +
      (pic ? '<img loading="lazy" src="' + fileUrl(pic) + '" alt="">' : s.video ? '<video muted preload="none" data-src="' + fileUrl(s.file) + '#t=0.1"></video>' : "") +
      '<span class="st-date"><b>' + d.getDate() + "</b>" + esc(monthShort.format(d)) + "</span>" +
      (s.video ? '<span class="st-dur">' + (s.dur ? fmtDur(s.dur) : "▶") + "</span>" : "") +
      (music ? '<span class="st-music" title="Has music">♪</span>' : "") + (s.cf ? '<span class="st-cf" title="Shared with close friends">★</span>' : "") +
      (tags.length ? '<span class="st-tags">@' + (tags.length > 1 ? tags.length : "") + "</span>" : "") + "</button>";
  }

  function applyTileSize() {
    const size = { s: ["84px", 5], m: ["112px", 3], l: ["156px", 2] }[SV.size] || ["112px", 3];
    $("stories").style.setProperty("--tile", size[0]);
    $("stories").style.setProperty("--cols", size[1]);
  }

  /* story filters: free-text search (people tagged, places, hashtags, songs, captions, highlight names, dates) + toggles */
  const ST_KINDS = [["video", "Videos"], ["photo", "Photos"], ["tagged", "Has tags"], ["music", "Music"], ["place", "Location"], ["shared", "Shared posts"]];
  SV.q = "";
  SV.kinds = new Set();
  SV.showPeople = false;

  function storyHay(s) {
    if (s.hay) return s.hay;
    const tagged = SV.data.tagged || {};
    const d = new Date(s.t);
    const parts = [s.date, longDate.format(d), monthLong.format(d), s.caption || ""];
    (s.tags || []).forEach((u) => parts.push("@" + u, tagged[u] || ""));
    (s.stickers || []).forEach(([kind, label]) => parts.push(label || "", kind === "location" ? "location place" : ""));
    (s.hlTitles || []).forEach((t) => parts.push(t, "highlight"));
    if (s.cf) parts.push("close friends");
    s.hay = parts.join(" \u0001 ").toLowerCase();
    return s.hay;
  }

  function storyMatches(s) {
    const st = s.stickers || [];
    for (const k of SV.kinds) {
      if (k === "video" && !s.video) return false;
      if (k === "photo" && s.video) return false;
      if (k === "tagged" && !(s.tags && s.tags.length)) return false;
      if (k === "music" && !st.some((x) => x[0] === "music_sticker")) return false;
      if (k === "place" && !st.some((x) => x[0] === "location")) return false;
      if (k === "shared" && !(s.shared && s.shared.length)) return false;
    }
    if (SV.cfOnly && !s.cf) return false;
    const words = SV.q.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const hay = storyHay(s);
    const tagged = SV.data.tagged || {};
    return words.every((w) => {
      if (w[0] === "@" && w.length > 1) {
        const q = w.slice(1);
        return (s.tags || []).some((u) => u.toLowerCase().includes(q) || (tagged[u] || "").toLowerCase().includes(q));
      }
      return hay.includes(w);
    });
  }

  function storyFiltersOn() { return !!(SV.q.trim() || SV.kinds.size || SV.cfOnly); }

  function peopleCounts(data) {
    if (data.peopleCounts) return data.peopleCounts;
    const n = new Map();
    data.list.forEach((s) => (s.tags || []).forEach((u) => n.set(u, (n.get(u) || 0) + 1)));
    data.peopleCounts = [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return data.peopleCounts;
  }

  function renderStoriesPage(data) {
    const sum = state.inbox.stories;
    if (!data.hlIndexed) {  // so a search for a highlight's name finds its stories in the archive
      const byPk = new Map(data.list.map((s) => [s.pk, s]));
      data.highlights.forEach((h) => h.stories.forEach((x) => { const s = byPk.get(x.pk); if (s) (s.hlTitles = s.hlTitles || []).push(h.title); }));
      data.hlIndexed = true;
    }
    const people = peopleCounts(data);
    const tagged = data.tagged || {};

    const FILTER_ICON = '<svg viewBox="0 0 24 24"><path d="M4 6h16M7 12h10M10 18h4"/></svg>';
    $("stories").innerHTML =
      '<header class="st-head st-one"><div class="who-text"><b id="st-sum">' + esc(sum ? storiesSummaryText(sum) : "") + "</b></div>" +
      '<div class="st-qwrap"><label class="search-box st-search"><svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5"/></svg><input id="st-q" type="search" placeholder="Search @tag, place, song, highlight, date" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-controls="st-sug" aria-expanded="false" value="' + esc(SV.q) + '"></label>' +
      '<div class="st-sug" id="st-sug" role="listbox" hidden></div></div>' +
      '<div class="st-fwrap"><button class="st-chip st-fbtn" id="st-fbtn" aria-haspopup="true" aria-expanded="false" title="Filter the stories">' + FILTER_ICON + ' Filters <span class="st-fcount" id="st-fcount" hidden></span></button>' +
      '<div class="st-pop" id="st-pop" hidden>' +
      '<div class="st-pop-h">Show only</div><div class="st-pop-kinds">' +
      (sum && sum.cf ? '<button class="st-chip st-kind" data-kind="cf" title="Only the stories shared with close friends"><span class="cf-dot">★</span> Close friends <small>' + sum.cf + "</small></button>" : "") +
      ST_KINDS.map(([k, label]) => '<button class="st-chip st-kind" data-kind="' + k + '">' + esc(label) + "</button>").join("") + "</div>" +
      (people.length ? '<div class="st-pop-h">People you tagged <small>' + people.length + '</small></div>' +
        '<label class="search-box st-pfind"><svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5"/></svg><input id="st-pq" type="search" placeholder="Find a person" autocomplete="off" spellcheck="false"></label>' +
        '<div class="st-people" id="st-people">' + people.map(([u, n]) =>
          '<button data-user="' + esc(u) + '" data-name="' + esc((u + " " + (tagged[u] || "")).toLowerCase()) + '" title="' + esc(tagged[u] || "") + '">@' + esc(u) + " <small>" + n + "</small></button>").join("") + "</div>" : "") +
      '<div class="st-pop-foot"><button class="btn-gray" id="st-clear">Clear all</button><button class="btn-gray" id="st-pop-done">Done</button></div>' +
      "</div></div>" +
      '<div class="st-size" id="st-size" title="Tile size">' + [["s", "Small tiles: see more at once", 7], ["m", "Medium tiles", 5], ["l", "Large tiles", 3]].map(([k, t, n]) =>
        '<button data-size="' + k + '" title="' + t + '" class="' + (SV.size === k ? "on" : "") + '"><svg viewBox="0 0 24 24">' + Array.from({ length: n === 7 ? 9 : n === 5 ? 4 : 1 }, (_, i) => {
          const c = n === 7 ? 3 : n === 5 ? 2 : 1, w = 18 / c;
          return '<rect x="' + (3 + (i % c) * w + 0.8) + '" y="' + (3 + Math.floor(i / c) * w + 0.8) + '" width="' + (w - 1.6) + '" height="' + (w - 1.6) + '" rx="1" class="fill"/>';
        }).join("") + "</svg></button>").join("") + "</div>" +
      '<div class="st-actions"><button class="btn-gray" id="st-play-latest">Play latest</button><button class="btn-gray" id="st-play-first">Play from first</button></div></header>' +
      '<div class="st-body" id="st-body"></div>';

    applyTileSize();
    $("st-size").addEventListener("click", (e) => {
      const b = e.target.closest("[data-size]");
      if (!b) return;
      SV.size = b.dataset.size;
      try { localStorage.setItem("iga-tile", SV.size); } catch (err) {}
      $("st-size").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      applyTileSize();
    });
    let typing = null;
    $("st-q").addEventListener("input", (e) => {
      clearTimeout(typing);
      typing = setTimeout(() => storySearch(data, e.target.value, true), 150);
    });
    bindStorySuggest(data, people, tagged);

    // the Filters popover
    const pop = $("st-pop"), fbtn = $("st-fbtn");
    const showPop = (on) => { pop.hidden = !on; fbtn.classList.toggle("open", on); fbtn.setAttribute("aria-expanded", on ? "true" : "false"); };
    fbtn.addEventListener("click", (e) => { e.stopPropagation(); showPop(pop.hidden); });
    $("st-pop-done").addEventListener("click", () => showPop(false));
    pop.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); showPop(false); fbtn.focus(); } });
    if (!SV.popBound) {  // one document listener for every render: a click outside closes the popover
      SV.popBound = true;
      document.addEventListener("click", (e) => {
        const p = $("st-pop");
        if (p && !p.hidden && !e.target.closest(".st-fwrap")) { p.hidden = true; const f = $("st-fbtn"); if (f) { f.classList.remove("open"); f.setAttribute("aria-expanded", "false"); } }
      });
    }
    pop.addEventListener("click", (e) => {
      const k = e.target.closest("[data-kind]");
      if (k) {
        const kind = k.dataset.kind;
        if (kind === "cf") SV.cfOnly = !SV.cfOnly;
        else if (SV.kinds.has(kind)) SV.kinds.delete(kind);
        else {
          SV.kinds.add(kind);
          if (kind === "video") SV.kinds.delete("photo");
          if (kind === "photo") SV.kinds.delete("video");
        }
        return renderStoriesBody(data);
      }
      const u = e.target.closest("[data-user]");
      if (u) return storySearch(data, SV.q.trim() === "@" + u.dataset.user ? "" : "@" + u.dataset.user);
      if (e.target.closest("#st-clear")) {
        SV.kinds.clear(); SV.cfOnly = false;
        storySearch(data, "");
      }
    });
    const pq = $("st-pq");
    if (pq) pq.addEventListener("input", () => {
      const q = pq.value.toLowerCase().replace(/^@/, "").trim();
      $("st-people").querySelectorAll("[data-user]").forEach((b) => { b.hidden = !!q && !b.dataset.name.includes(q); });
    });
    $("st-play-latest").addEventListener("click", () => {
      const list = SV.view || data.list;
      let k = list.length - 1;
      while (k > 0 && list[k - 1].day === list[k].day) k--;
      openStory(list, Math.max(0, k));
    });
    $("st-play-first").addEventListener("click", () => openStory(SV.view || data.list, 0));
    renderStoriesBody(data);
  }

  const SUG_COLORS = ["#d62976", "#4f5bd5", "#fa7e1e", "#1f9d55", "#962fbf", "#0095f6", "#e0245e", "#00a3a3"];

  function markMatch(text, q) {
    if (!q) return esc(text);
    const i = text.toLowerCase().indexOf(q);
    if (i < 0) return esc(text);
    return esc(text.slice(0, i)) + "<mark>" + esc(text.slice(i, i + q.length)) + "</mark>" + esc(text.slice(i + q.length));
  }

  function bindStorySuggest(data, people, tagged) {
    const input = $("st-q"), box = $("st-sug");
    let rows = [], on = -1;

    const hide = () => { box.hidden = true; input.setAttribute("aria-expanded", "false"); on = -1; };
    const paint = () => box.querySelectorAll(".st-sug-row").forEach((r, k) => {
      r.classList.toggle("on", k === on);
      if (k === on) r.scrollIntoView({ block: "nearest" });
    });
    const pick = (row) => {
      hide();
      if (row.user) storySearch(data, "@" + row.user);
      else if (row.hl !== undefined) { const h = data.highlights[row.hl]; openStory(h.stories, 0, h.title); }
    };

    const build = () => {
      const raw = input.value.trim().toLowerCase();
      const q = raw.replace(/^@/, "");
      if (/^@[\w.]+$/.test(input.value.trim()) && Object.prototype.hasOwnProperty.call(tagged, q)) { hide(); return; }  // a person is already picked
      const users = people.filter(([u]) => !q || u.toLowerCase().includes(q) || (tagged[u] || "").toLowerCase().includes(q))
        .sort((a, b) => (q ? (a[0].toLowerCase().startsWith(q) ? 0 : 1) - (b[0].toLowerCase().startsWith(q) ? 0 : 1) : 0) || b[1] - a[1])
        .slice(0, q ? 8 : 6);
      const hls = raw[0] === "@" ? [] : data.highlights.map((h, i) => [h, i]).filter(([h]) => !q || (h.title || "").toLowerCase().includes(q)).slice(0, q ? 3 : 0);
      rows = [];
      let html = "";
      if (users.length) {
        html += '<div class="st-sug-h">' + (q ? "People" : "Most tagged") + "</div>";
        users.forEach(([u, n]) => {
          const name = tagged[u] || "";
          const color = SUG_COLORS[[...u].reduce((a, c) => a + c.charCodeAt(0), 0) % SUG_COLORS.length];
          html += '<div class="st-sug-row" role="option" data-i="' + rows.length + '"><span class="st-sug-av" style="background:' + color + '">' + esc(u.replace(/[^a-z0-9]/gi, "").charAt(0).toUpperCase() || "@") + "</span>" +
            '<span class="st-sug-t"><b>@' + markMatch(u, q) + "</b>" + (name ? "<small>" + markMatch(name, q) + "</small>" : "") + "</span>" +
            "<em>" + n + (n === 1 ? " story" : " stories") + "</em></div>";
          rows.push({ user: u });
        });
      }
      if (hls.length) {
        html += '<div class="st-sug-h">Highlights</div>';
        hls.forEach(([h, i]) => {
          html += '<div class="st-sug-row" role="option" data-i="' + rows.length + '"><span class="st-sug-av ring">' + (h.cover ? '<img src="' + fileUrl(h.cover) + '" alt="">' : "") + "</span>" +
            '<span class="st-sug-t"><b>' + markMatch(h.title || "Highlight", q) + "</b><small>Highlight</small></span><em>" + h.stories.length + " stories</em></div>";
          rows.push({ hl: i });
        });
      }
      if (q && !rows.length) html = '<div class="st-sug-empty">No person or highlight matches. The search still looks through places, songs and dates.</div>';
      if (!html) { hide(); return; }
      box.innerHTML = html;
      box.hidden = false;
      input.setAttribute("aria-expanded", "true");
      on = -1;
    };

    input.addEventListener("focus", build);
    input.addEventListener("input", build);
    input.addEventListener("blur", () => setTimeout(hide, 120));
    box.addEventListener("mousedown", (e) => {  // mousedown so the pick happens before the input loses focus
      const r = e.target.closest(".st-sug-row");
      if (!r) return;
      e.preventDefault();
      pick(rows[+r.dataset.i]);
    });
    input.addEventListener("keydown", (e) => {
      const open = !box.hidden && rows.length;
      if (e.key === "ArrowDown" && open) { e.preventDefault(); on = (on + 1) % rows.length; paint(); }
      else if (e.key === "ArrowUp" && open) { e.preventDefault(); on = on <= 0 ? rows.length - 1 : on - 1; paint(); }
      else if (e.key === "Enter") { if (open && on >= 0) { e.preventDefault(); pick(rows[on]); } else hide(); }
      else if (e.key === "Escape") {
        if (!box.hidden) { e.stopPropagation(); hide(); }
        else if (input.value) { e.stopPropagation(); storySearch(data, ""); }
      }
    });
  }

  function storySearch(data, q, typed) {
    SV.q = q;
    const input = $("st-q");
    if (!input) return;
    if (!typed) input.value = q;
    renderStoriesBody(data);
  }

  function renderStoriesBody(data) {
    const sum = state.inbox.stories;
    const filtered = storyFiltersOn();
    const list = filtered ? data.list.filter(storyMatches) : data.list;
    SV.view = list;
    list.forEach((s, k) => { s.k = k; });
    const months = new Map();
    for (let k = list.length - 1; k >= 0; k--) {
      const s = list[k];
      const ym = s.date.slice(0, 7);
      if (!months.has(ym)) months.set(ym, []);
      months.get(ym).push(s);
    }

    // reflect the filters on the button and in the popover
    const active = SV.kinds.size + (SV.cfOnly ? 1 : 0) + (/^@[\w.]+$/.test(SV.q.trim()) ? 1 : 0);
    $("st-fcount").hidden = !active;
    $("st-fcount").textContent = active;
    $("st-fbtn").classList.toggle("on", !!active);
    $("st-pop").querySelectorAll("[data-kind]").forEach((b) => b.classList.toggle("on", b.dataset.kind === "cf" ? !!SV.cfOnly : SV.kinds.has(b.dataset.kind)));
    $("st-pop").querySelectorAll("[data-user]").forEach((b) => b.classList.toggle("on", "@" + b.dataset.user === SV.q.trim()));
    const days = new Set(list.map((s) => s.date)).size;
    $("st-sum").textContent = !filtered ? (sum ? storiesSummaryText(sum) : "")
      : list.length.toLocaleString() + " of " + data.list.length.toLocaleString() + " stories · " + days.toLocaleString() + (days === 1 ? " day" : " days");

    // highlights: all of them normally; while filtering, only the ones holding a matching story
    const shown = new Set(list.map((s) => s.pk));
    const hls = data.highlights.map((h, i) => [h, i]).filter(([h]) => !filtered || h.stories.some((x) => shown.has(x.pk)));
    const hl = hls.length ? '<section class="st-section"><h3>Highlights</h3><div class="st-hl">' + hls.map(([h, i]) =>
      '<button class="st-hl-item" data-h="' + i + '"><span class="st-ring">' + (h.cover ? '<img loading="lazy" src="' + fileUrl(h.cover) + '" alt="">' : "") + "</span><small>" + esc(h.title) + "</small><em>" + h.stories.length + "</em></button>").join("") + "</div></section>" : "";

    // one person searched: say who it is
    let who = "";
    const m = /^@([\w.]+)$/.exec(SV.q.trim());
    const tagged = data.tagged || {};
    if (m && Object.prototype.hasOwnProperty.call(tagged, m[1])) {
      const u = m[1], first = list[0], last = list[list.length - 1];
      who = '<section class="st-who"><div><b>@' + esc(u) + "</b>" + (tagged[u] ? " <span>" + esc(tagged[u]) + "</span>" : "") +
        "<small>tagged in " + list.length + (list.length === 1 ? " story" : " stories") +
        (first ? " · " + esc(dateFmt.format(new Date(first.t))) + (last !== first ? " – " + esc(dateFmt.format(new Date(last.t))) : "") : "") + "</small></div>" +
        '<a class="btn-gray" href="https://www.instagram.com/' + esc(u) + '/" target="_blank" rel="noopener">Open profile</a></section>';
    }

    let body = "";
    months.forEach((stories, ym) => {
      const [y, mo] = ym.split("-").map(Number);
      const dd = new Set(stories.map((s) => s.date)).size;
      body += '<section class="st-month" data-month="' + ym + '"><h3 class="st-mhead">' + esc(monthLong.format(new Date(y, mo - 1, 1))) +
        " <small>" + stories.length + (stories.length === 1 ? " story" : " stories") + " · " + dd + (dd === 1 ? " day" : " days") + '</small></h3><div class="st-grid">' + stories.map(tileHtml).join("") + "</div></section>";
    });
    if (!list.length) body = '<p class="muted st-none">No stories match. Try a shorter search, or press Clear.</p>';

    const years = new Map();
    months.forEach((stories, ym) => {
      const y = ym.slice(0, 4);
      if (!years.has(y)) years.set(y, []);
      years.get(y).push([ym, stories.length]);
    });
    let nav = "";
    years.forEach((ms, y) => {
      const total = ms.reduce((a, mm) => a + mm[1], 0);
      nav += '<div class="st-ny"><button class="st-ny-y" data-ym="' + ms[0][0] + '">' + y + " <small>" + total + '</small></button><div class="st-ny-m">' +
        ms.map(([ym, n]) => '<button data-ym="' + ym + '" title="' + n + ' stories">' + esc(monthShort.format(new Date(+ym.slice(0, 4), +ym.slice(5) - 1, 1))) + "</button>").join("") + "</div></div>";
    });

    $("st-body").innerHTML = '<div class="st-scroll" id="st-scroll">' + who + hl + body + '</div><nav class="st-nav" id="st-nav" aria-label="Jump to month">' + nav + "</nav>";

    const scroll = $("st-scroll");
    // videos without a thumbnail (official exports) show their first frame, loaded only once the tile scrolls into view
    const stills = scroll.querySelectorAll("video[data-src]");
    if (stills.length && "IntersectionObserver" in window) {
      const loader = new IntersectionObserver((entries) => entries.forEach((en) => {
        if (!en.isIntersecting) return;
        en.target.preload = "metadata";
        en.target.src = en.target.dataset.src;
        loader.unobserve(en.target);
      }), { root: scroll, rootMargin: "300px" });
      stills.forEach((v) => loader.observe(v));
    } else stills.forEach((v) => { v.preload = "metadata"; v.src = v.dataset.src; });
    scroll.addEventListener("click", (e) => {
      const tile = e.target.closest(".st-tile");
      if (tile) return openStory(list, +tile.dataset.k);
      const h = e.target.closest(".st-hl-item");
      if (h) return openStory(data.highlights[+h.dataset.h].stories, 0, data.highlights[+h.dataset.h].title);
    });
    $("st-nav").addEventListener("click", (e) => {
      const b = e.target.closest("[data-ym]");
      if (!b) return;
      const sec = scroll.querySelector('[data-month="' + b.dataset.ym + '"]');
      if (sec) scroll.scrollTo({ top: sec.offsetTop - scroll.offsetTop - 4 });
    });

    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver((entries) => {
        const top = [...scroll.querySelectorAll(".st-month")].find((sec) => sec.getBoundingClientRect().bottom > scroll.getBoundingClientRect().top + 60);
        if (!top) return;
        const ym = top.dataset.month;
        $("st-nav").querySelectorAll("[data-ym]").forEach((b) => b.classList.toggle("on", b.dataset.ym === ym && !b.classList.contains("st-ny-y")));
        $("st-nav").querySelectorAll(".st-ny").forEach((y) => y.classList.toggle("on", !!y.querySelector('.on')));
        const on = $("st-nav").querySelector(".st-ny-m .on");
        if (on && entries.length) on.scrollIntoView({ block: "nearest" });
      }, { root: scroll, threshold: [0, 1] });
      scroll.querySelectorAll(".st-month").forEach((sec) => io.observe(sec));
    }
  }

  /* story viewer */
  function svBuild() {
    const sv = $("sv");
    if (sv.dataset.ready) return;
    sv.dataset.ready = "1";
    sv.innerHTML =
      '<div class="sv-bg" id="sv-bg"></div>' +
      '<button class="sv-close icon-btn" id="sv-close" title="Close (Esc)">' + SV_ICON.close + "</button>" +
      '<div class="sv-title" id="sv-title"></div>' +
      '<button class="sv-nav prev" id="sv-prev" title="Previous (←)">' + SV_ICON.prev + "</button>" +
      '<div class="sv-stage" id="sv-stage">' +
      '<div class="sv-bars" id="sv-bars"></div>' +
      '<div class="sv-top"><span id="sv-avatar"></span><div class="sv-who"><b id="sv-user"></b><small id="sv-when"></small></div>' +
      '<button class="sv-btn" id="sv-pause" title="Pause (Space)">' + SV_ICON.pause + '</button><button class="sv-btn" id="sv-mute" title="Mute (M)">' + SV_ICON.sound + "</button></div>" +
      '<div class="sv-media" id="sv-media"></div>' +
      '<div class="sv-tap prev" data-dir="-1"></div><div class="sv-tap next" data-dir="1"></div>' +
      '<div class="sv-chips" id="sv-chips"></div></div>' +
      '<button class="sv-nav next" id="sv-next" title="Next (→)">' + SV_ICON.next + "</button>" +
      '<div class="sv-strip" id="sv-strip"></div>';

    $("sv-close").addEventListener("click", closeStory);
    $("sv-prev").addEventListener("click", () => svGo(SV.n - 1));
    $("sv-next").addEventListener("click", () => svGo(SV.n + 1));
    $("sv-pause").addEventListener("click", () => svPause(!SV.paused));
    $("sv-mute").addEventListener("click", () => svMute(!SV.muted));
    $("sv-strip").addEventListener("click", (e) => { const b = e.target.closest("[data-k]"); if (b) svGo(+b.dataset.k); });
    $("sv-chips").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-user]");
      if (!b) return;
      const q = "@" + b.dataset.user;
      closeStory();
      SV.q = q;
      if (location.hash !== "#profile=stories" || !$("st-q")) { $("stories").dataset.ready = ""; location.hash = "#profile=stories"; }
      else storySearch(SV.data, q);
    });

    // a click moves on (right side) or back (left side) wherever it lands on the story, including the top bar and the
    // captions; only a long press pauses. Clicking the dark area beside the story does the same, it never closes the viewer.
    const stage = $("sv-stage");
    let hold = null, held = false, down = null;
    const side = (x) => {
      const r = stage.getBoundingClientRect();
      return (x - r.left) / r.width < 0.3 ? -1 : 1;
    };
    stage.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".sv-btn, .sv-chip.tag")) return;
      down = { x: e.clientX, y: e.clientY };
      held = false;
      clearTimeout(hold);
      hold = setTimeout(() => { held = true; svPause(true, true); }, 450);
    });
    const finish = (e) => {
      clearTimeout(hold);
      const start = down;
      down = null;
      if (!start) return;
      if (held) { held = false; svPause(false, true); return; }
      if (e.type !== "pointerup" || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 14) return;
      svGo(SV.n + side(e.clientX));
    };
    stage.addEventListener("pointerup", finish);
    stage.addEventListener("pointercancel", finish);
    stage.addEventListener("pointerleave", finish);
    sv.addEventListener("click", (e) => {
      if (e.target === sv || e.target.id === "sv-bg") svGo(SV.n + side(e.clientX));
    });
  }

  function openStory(list, n, title) {
    if (!list || !list.length) return;
    svBuild();
    SV.list = list;
    SV.title = title || "";
    $("sv").hidden = false;
    document.body.classList.add("sv-open");
    svGo(n);
  }

  function closeStory() {
    clearInterval(SV.timer);
    const media = $("sv-media");
    if (media) media.innerHTML = "";
    $("sv").hidden = true;
    document.body.classList.remove("sv-open");
    const s = SV.list && SV.list[SV.n];
    if (s && !s.hl) {
      const tile = $("stories").querySelector('.st-tile[data-k="' + s.k + '"]');
      if (tile) { tile.scrollIntoView({ block: "center" }); tile.classList.remove("flash"); void tile.offsetWidth; tile.classList.add("flash"); }
    }
  }

  function svGroup(n) {
    const s = SV.list[n];
    if (s.hl) return [0, SV.list.length];
    let a = n, b = n;
    while (a > 0 && SV.list[a - 1].day === s.day) a--;
    while (b < SV.list.length - 1 && SV.list[b + 1].day === s.day) b++;
    return [a, b + 1];
  }

  function chipHtml(st) {
    const [kind, label] = st;
    const map = { music_sticker: "♪", location: "📍", hashtag: "#", countdown: "⏳", feed_media: "↗", mention: "@", link: "🔗", reaction_sticker: "😀", question: "?", poll: "📊", slider: "🎚", insight: "👁" };
    const text = kind === "music_sticker" && (!label || label === "music") ? "Music" : kind === "feed_media" ? "Shared post" : label || kind.replace(/_/g, " ");
    return '<span class="sv-chip">' + esc(map[kind] || "•") + " " + esc(text) + "</span>";
  }

  function svGo(n) {
    if (!SV.list) return;
    if (n < 0) n = 0;
    if (n >= SV.list.length) return closeStory();
    SV.n = n;
    clearInterval(SV.timer);
    SV.spent = 0;
    SV.started = performance.now();
    SV.paused = false;
    $("sv-pause").innerHTML = SV_ICON.pause;

    const s = SV.list[n];
    const me = state.inbox.me || {};
    const [a, b] = svGroup(n);
    const pic = s.thumb || (!s.video ? s.file : null);

    $("sv-bg").style.backgroundImage = pic ? cssUrl(pic).replace(/&quot;/g, '"') : "none";
    $("sv-avatar").innerHTML = avatar(me, "sm");
    $("sv-user").textContent = me.username || (SV.data.account && SV.data.account.username) || "";
    $("sv-when").innerHTML = (s.cf ? '<span class="sv-cf">★ Close friends</span> · ' : "") + esc(fullFmt.format(new Date(s.t))) + (b - a > 1 ? " · " + (n - a + 1) + "/" + (b - a) : "");
    $("sv-stage").classList.toggle("cf", !!s.cf);
    $("sv-title").innerHTML = s.hl
      ? '<b>' + esc(s.hl.title) + "</b><small>Highlight · " + s.hl.stories.length + " stories</small>"
      : "<b>" + esc(longDate.format(new Date(s.t))) + "</b><small>Day " + (s.day + 1).toLocaleString() + " of " + SV.data.archive.length.toLocaleString() + " · story " + (n + 1).toLocaleString() + " of " + SV.list.length.toLocaleString() + "</small>";
    $("sv-bars").innerHTML = Array.from({ length: b - a }, (_, k) => '<span class="' + (a + k < n ? "done" : "") + '"><i></i></span>').join("");
    $("sv-chips").innerHTML = (s.caption ? '<span class="sv-chip cap">' + esc(s.caption) + "</span>" : "") +
      (s.tags || []).map((u) => '<button class="sv-chip tag" data-user="' + esc(u) + '" title="' + esc(((SV.data.tagged || {})[u] || "@" + u) + " - show every story with this tag") + '">@' + esc(u) + "</button>").join("") +
      (s.stickers || []).filter((x) => x[0] !== "mention").map(chipHtml).join("") +
      (s.shared || []).map((u) => '<a class="sv-chip tag" href="' + esc(u) + '" target="_blank" rel="noopener" title="Open the shared post on Instagram">↗ Shared post</a>').join("");
    $("sv-mute").hidden = !s.video;
    $("sv-prev").disabled = n === 0;

    const media = $("sv-media");
    if (s.video) {
      media.innerHTML = '<video playsinline autoplay preload="auto" src="' + fileUrl(s.file) + '"' + (s.thumb ? ' poster="' + fileUrl(s.thumb) + '"' : "") + "></video>";
      const video = media.querySelector("video");
      video.muted = SV.muted;
      video.addEventListener("ended", () => svGo(SV.n + 1));
      const tryPlay = video.play();
      if (tryPlay) tryPlay.catch(() => { video.muted = true; SV.muted = true; $("sv-mute").innerHTML = SV_ICON.mute; video.play().catch(() => {}); });
    } else {
      media.innerHTML = '<img src="' + fileUrl(s.file) + '" alt="">';
    }
    $("sv-mute").innerHTML = SV.muted ? SV_ICON.mute : SV_ICON.sound;

    // preload the next one
    const next = SV.list[n + 1];
    if (next) { const im = new Image(); im.src = fileUrl(next.thumb || next.file); }

    svStrip();
    SV.timer = setInterval(svTick, 50);
  }

  function svTick() {
    if (SV.paused) return;
    const s = SV.list[SV.n];
    const [a] = svGroup(SV.n);
    const bar = $("sv-bars").children[SV.n - a];
    let frac;
    if (s.video) {
      const v = $("sv-media").querySelector("video");
      frac = v && v.duration ? v.currentTime / v.duration : 0;
    } else {
      frac = (SV.spent + performance.now() - SV.started) / PHOTO_MS;
      if (frac >= 1) return svGo(SV.n + 1);
    }
    if (bar) bar.firstChild.style.width = Math.min(100, frac * 100) + "%";
  }

  function svPause(on, quiet) {
    if (!SV.list) return;
    if (on === SV.paused) return;
    SV.paused = on;
    const v = $("sv-media").querySelector("video");
    if (on) { SV.spent += performance.now() - SV.started; if (v) v.pause(); }
    else { SV.started = performance.now(); if (v) v.play().catch(() => {}); }
    $("sv-pause").innerHTML = on ? SV_ICON.play : SV_ICON.pause;
    $("sv-stage").classList.toggle("held", on && !!quiet);
  }

  function svMute(on) {
    SV.muted = on;
    const v = $("sv-media").querySelector("video");
    if (v) v.muted = on;
    $("sv-mute").innerHTML = on ? SV_ICON.mute : SV_ICON.sound;
  }

  function svStrip() {
    const n = SV.n, list = SV.list;
    const from = Math.max(0, n - 12), to = Math.min(list.length, n + 13);
    let html = "", lastDay = null;
    for (let k = from; k < to; k++) {
      const s = list[k];
      if (!s.hl && s.date !== lastDay) {
        html += '<span class="sv-strip-day">' + esc(dateFmt.format(new Date(s.t))) + "</span>";
        lastDay = s.date;
      }
      const pic = s.thumb || (!s.video ? s.file : null);
      html += '<button class="sv-strip-it' + (k === n ? " on" : "") + (pic ? "" : " novid") + '" data-k="' + k + '" title="' + esc(fullFmt.format(new Date(s.t))) + '">' + (pic ? '<img loading="lazy" src="' + fileUrl(pic) + '" alt="">' : "▶") + "</button>";
    }
    const strip = $("sv-strip");
    strip.innerHTML = html;
    const on = strip.querySelector(".on");
    if (on) strip.scrollLeft = on.offsetLeft - strip.clientWidth / 2 + on.clientWidth / 2;
  }

  function svKey(e) {
    if ($("sv").hidden) return false;
    const [a, b] = svGroup(SV.n);
    if (e.key === "Escape") closeStory();
    else if (e.key === "ArrowRight") svGo(SV.n + 1);
    else if (e.key === "ArrowLeft") svGo(SV.n - 1);
    else if (e.key === "ArrowDown" || e.key === "PageDown") svGo(b);
    else if (e.key === "ArrowUp" || e.key === "PageUp") svGo(a > 0 ? svGroup(a - 1)[0] : 0);
    else if (e.key === " ") { e.preventDefault(); svPause(!SV.paused); }
    else if (e.key.toLowerCase() === "m") svMute(!SV.muted);
    else return true;
    e.preventDefault();
    return true;
  }
})();
