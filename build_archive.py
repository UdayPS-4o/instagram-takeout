"""Builds the offline "Instagram Direct" archive of an account out of everything known about it: scraped data and official exports.

    python build_archive.py -a demo      # one account
    python build_archive.py              # every account under accounts/

For each account, <out> = accounts/<name>/:
Reads  <source>/chats/<threadid>_<title>/chat.json (+ messages.jsonl for voice-note waveforms, scrape.log for the real thread title),
       <source>/stories/stories.json, <source>/people/people.json
       where <source> is <out> itself for scraped data and <out>/exports/<id>/ for every official export (see import_export.py).
       A chat, story or person found in several sources is merged (see utils/merge.py).
Writes <out>/index.html          open this in a browser, works straight from disk (file://)
       <out>/_archive/app.js, app.css
       <out>/_archive/data/threads.js        inbox list
       <out>/_archive/data/t_<threadid>.js   one file per chat, loaded when the chat is opened
       <out>/_archive/data/stories.js        the story archive + highlights
       <out>/_archive/data/people.js         followers / following / blocked

       accounts/index.html          the account picker (http://localhost:8765/ lands here)

Nothing here talks to Instagram.
"""
import utils.transport
import utils.session
import glob
import io
import json
import os
import posixpath
import re
import shutil
import sys
import time
from argparse import ArgumentParser
from datetime import datetime
from html import escape

from utils import accounts
from utils.merge import merge_chats

if sys.stdout is not None and isinstance(sys.stdout, io.TextIOWrapper):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

try:
    from PIL import Image
except ImportError:  # sizes are only used to reserve space while images load
    Image = None

VIEWER_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "archive_viewer")

parser = ArgumentParser()
parser.add_argument("-a", "--account", help="Account folder under accounts/ (default: build every account)")


def from_out(folder: str, out: str, path: str) -> str:
    """A path written relative to a source's folder, as the viewer needs it: relative to the account folder."""
    prefix = os.path.relpath(folder, out).replace("\\", "/")
    return posixpath.normpath(posixpath.join(prefix, path))


def thread_title(folder: str, fallback: str) -> str:
    log = os.path.join(folder, "scrape.log")
    if os.path.exists(log):
        with open(log, encoding="utf-8", errors="replace") as f:
            for line in f:
                match = re.search(r"Scraping '(.*)' \[\d+\]", line)
                if match:
                    return match.group(1)
    return fallback


def raw_extras(folder: str) -> dict[str, dict]:
    """Per message id: details chat.json doesn't keep (voice-note waveform + duration, media sizes)."""
    extras: dict[str, dict] = {}
    path = os.path.join(folder, "messages.jsonl")
    if not os.path.exists(path):
        return extras

    with open(path, encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            node = json.loads(line)
            key = node.get("message_id") or node.get("id")
            content = node.get("content") or {}
            extra = {}

            for audio in content.get("audio_attachments") or []:
                if audio.get("waveform_data"):
                    extra["wave"] = [round(v, 2) for v in audio["waveform_data"]]
                if audio.get("playable_duration_ms"):
                    extra["dur"] = audio["playable_duration_ms"]

            for animated in content.get("animated_media") or []:
                extra["gif"] = {"w": animated.get("preview_width"), "h": animated.get("preview_height"), "sticker": bool(animated.get("is_sticker"))}

            preview = (content.get("xma") or {}).get("preview_image") or {}
            if preview.get("width") and preview.get("height"):
                extra["pw"], extra["ph"] = preview["width"], preview["height"]

            if extra:
                extras[key] = extra
    return extras


def image_size(path: str) -> list[int]:
    if Image is None or not re.search(r"\.(jpe?g|png|webp|gif)$", path, re.I):
        return []
    try:
        with Image.open(path) as img:
            return list(img.size)
    except Exception:
        return []


def compact(value):
    """Drops empty keys so the per-chat data files stay small."""
    if isinstance(value, dict):
        return {k: compact(v) for k, v in value.items() if v not in (None, [], {}, False, "")}
    if isinstance(value, list):
        return [compact(v) for v in value]
    return value


def preview_of(message: dict, is_group: bool) -> str:
    me = message["sender"]["is_me"]
    who = "You" if me else message["sender"]["name"]
    shared = message.get("shared") or {}
    kinds = {a["kind"] for a in message.get("attachments") or []}

    if message.get("activity"):
        return message["activity"]
    if message.get("unavailable"):
        return f"{who} unsent a message" if me or is_group else "Unsent a message"

    if shared:
        eyebrow = shared.get("eyebrow") or ""
        if "story" in eyebrow.lower():
            body = eyebrow
        elif shared.get("decoration") == "REEL":
            body = f"sent a reel by {shared['account']}" if shared.get("account") else "sent a reel"
        else:
            body = "sent an attachment."
        if message.get("text") and "story" in eyebrow.lower():
            body = message["text"]
    elif message["type"] == "AUDIOS" or "audio" in kinds:
        body = "sent a voice message."
    elif message["type"] in ("VIDEOS", "RAVEN_VIDEO") or "video" in kinds:
        body = "sent a video."
    elif message["type"] in ("IMAGES", "RAVEN_IMAGE") or "image" in kinds:
        body = "sent a photo."
    elif message["type"] in ("GIFS", "INSTAGRAM_MESSAGING_ANIMATED_IMAGE"):
        body = "sent a GIF."
    elif message.get("text"):
        return f"You: {message['text']}" if me else (f"{who}: {message['text']}" if is_group else message["text"])
    else:
        body = "sent an attachment."

    if body[0].islower():
        return f"{who} {body}" if me or is_group else body[0].upper() + body[1:]
    return body


STICKER_LABELS = {"story_bloks_stickers", "story_bloks_tappables"}  # generic "sticker" boxes, nothing worth showing


def merged_stories(out: str, sources: list[accounts.Source]) -> dict | None:
    """The stories of every source as one archive, with paths relative to out. A story is the same story when it was posted at the same second."""
    merged = None
    seen: dict[int, dict] = {}
    highlight_ids = set()
    for source in sources:
        path = os.path.join(source.stories, "stories.json")
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as f:
            data = json.load(f)

        def localize(story: dict):
            for field in ("file", "thumb"):
                if story.get(field):
                    story[field] = from_out(source.stories, out, story[field])

        if merged is None:
            merged = {"generated": data.get("generated"), "account": data.get("account"), "archive": [], "highlights": []}
        elif (data.get("generated") or "") > (merged.get("generated") or ""):
            merged["generated"] = data["generated"]

        days = {d["date"]: d for d in merged["archive"]}
        for day in data.get("archive") or []:
            for story in day["stories"]:
                if not story.get("file"):
                    continue
                known = seen.get(story["taken_at"])
                if known:
                    if story.get("caption") and not known.get("caption"):
                        known["caption"] = story["caption"]
                    known.setdefault("stickers", []).extend(s for s in story.get("stickers") or [] if s not in known["stickers"])
                    continue
                localize(story)
                seen[story["taken_at"]] = story
                if day["date"] not in days:
                    days[day["date"]] = {"date": day["date"], "stories": []}
                    merged["archive"].append(days[day["date"]])
                days[day["date"]]["stories"].append(story)
        for highlight in data.get("highlights") or []:
            if highlight["id"] in highlight_ids:
                continue
            highlight_ids.add(highlight["id"])
            if highlight.get("cover"):
                highlight["cover"] = from_out(source.stories, out, highlight["cover"])
            for story in highlight["stories"]:
                localize(story)
            merged["highlights"].append(highlight)
    return merged


def build_stories(out: str, sources: list[accounts.Source]) -> dict | None:
    """Writes data/stories.js and returns a small summary for the inbox, or None when there are no stories."""
    data = merged_stories(out, sources)
    if data is None:
        return None

    tagged: dict[str, str] = {}  # username -> full name of everyone @mentioned in a story

    def story(s: dict) -> dict:
        tags = []
        for m in s.get("mentions") or []:
            if m.get("username"):
                tags.append(m["username"])
                if m.get("full_name") or m["username"] not in tagged:
                    tagged[m["username"]] = m.get("full_name") or ""
        stickers = []
        for st in s.get("stickers") or []:
            if st.get("hidden") or st.get("kind") in STICKER_LABELS or st.get("kind") == "story_feed_media":
                continue
            stickers.append([st.get("kind", "").replace("story_", "").rstrip("s"), st.get("label") or ""])
        return compact({
            "pk": s["pk"],
            "t": int(s["taken_at"]) * 1000,
            "video": s.get("type") == "video",
            "w": s.get("width"),
            "h": s.get("height"),
            "dur": round(s["duration"], 2) if s.get("duration") else None,
            "audio": s.get("has_audio"),
            "file": s.get("file"),
            "thumb": s.get("thumb"),
            "caption": s.get("caption"),
            "cf": bool(s.get("close_friends")),
            "stickers": stickers,
            "tags": tags,
            "shared": s.get("shared_media") or None,
            "views": s.get("viewer_count"),
        })

    days = sorted(data.get("archive") or [], key=lambda d: d["date"])
    archive = [{"date": d["date"], "stories": sorted((story(s) for s in d["stories"] if s.get("file")), key=lambda s: s["t"])} for d in days]
    archive = [d for d in archive if d["stories"]]
    highlights = [{
        "id": h["id"],
        "title": h.get("title") or "Highlight",
        "cover": h.get("cover"),
        "stories": [story(s) for s in h["stories"] if s.get("file")],
    } for h in data.get("highlights") or []]
    if not archive and not highlights:
        return None

    count = sum(len(d["stories"]) for d in archive)
    cf = sum(1 for d in archive for s in d["stories"] if s.get("cf")) + sum(1 for h in highlights for s in h["stories"] if s.get("cf"))
    payload = {"account": data.get("account"), "archive": archive, "highlights": highlights, "tagged": tagged}
    with open(os.path.join(out, "_archive", "data", "stories.js"), "w", encoding="utf-8") as f:
        f.write("IGA.receiveStories(")
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write(");\n")
    print(f"  stories: {count} in {len(archive)} days, {len(highlights)} highlights, {cf} shared with close friends, {len(tagged)} people tagged")
    return {
        "count": count,
        "cf": cf,
        "tagged": len(tagged),
        "generated": data.get("generated"),
        "days": len(archive),
        "highlights": len(highlights),
        "first": archive[0]["stories"][0]["t"] if archive else None,
        "last": archive[-1]["stories"][-1]["t"] if archive else None,
        "cover": next((h["cover"] for h in highlights if h["cover"]), None),
    }


PEOPLE_LISTS = ("followers", "following", "blocked", "close_friends")


def merged_people(out: str, sources: list[accounts.Source]) -> dict | None:
    """The newest source decides who is on the lists (older ones are out of date); older ones still add details like profile pictures."""
    loaded = []
    for source in sources:
        path = os.path.join(source.people, "people.json")
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        for kind in PEOPLE_LISTS:
            for p in data.get(kind) or []:
                if p.get("avatar"):
                    p["avatar"] = from_out(source.people, out, p["avatar"])
        loaded.append(data)
    if not loaded:
        return None

    loaded.sort(key=lambda d: d.get("generated") or "", reverse=True)
    newest = loaded[0]
    for older in loaded[1:]:
        details = {p["username"]: p for kind in PEOPLE_LISTS for p in older.get(kind) or []}
        for kind in PEOPLE_LISTS:
            for p in newest.get(kind) or []:
                known = details.get(p["username"]) or {}
                for field in ("full_name", "avatar", "is_private", "is_verified", "is_favorite"):
                    if known.get(field) and not p.get(field):
                        p[field] = known[field]
    return newest


def build_people(out: str, sources: list[accounts.Source]) -> dict | None:
    """Writes data/people.js and returns the small summary the profile header needs, or None when there is no people.json."""
    data = merged_people(out, sources)
    if data is None:
        return None

    def person(p: dict) -> dict:
        return compact({
            "pk": p["pk"],
            "username": p["username"],
            "full_name": p.get("full_name"),
            "note": p.get("note"),
            "avatar": p.get("avatar"),
            "is_private": p.get("is_private"),
            "is_verified": p.get("is_verified"),
            "is_favorite": p.get("is_favorite"),
            "auto_blocked": p.get("auto_blocked"),
        })

    lists = {kind: [person(p) for p in data.get(kind) or []] for kind in PEOPLE_LISTS}
    payload = {
        "generated": data.get("generated"),
        "account": data.get("account"),
        "expected": data.get("expected"),
        "changes": data.get("changes"),
        "close_friends_count": data.get("close_friends_count"),
        **lists,
    }
    with open(os.path.join(out, "_archive", "data", "people.js"), "w", encoding="utf-8") as f:
        f.write("IGA.receivePeople(")
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write(");\n")

    print(f"  people: {len(lists['followers'])} followers, {len(lists['following'])} following, {len(lists['blocked'])} blocked")
    return {
        "generated": data.get("generated"),
        "account": data.get("account"),
        "followers": len(lists["followers"]),
        "following": len(lists["following"]),
        "blocked": len(lists["blocked"]),
        "close_friends": data.get("close_friends_count"),
    }


def load_chat(folder: str, out: str) -> dict:
    """A chat.json with every file path made relative to the account folder, so chats from different sources can be merged."""
    with open(os.path.join(folder, "chat.json"), encoding="utf-8") as f:
        chat = json.load(f)
    for person in chat["participants"]:
        if person.get("avatar"):
            person["avatar"] = from_out(folder, out, person["avatar"])
    for message in chat["messages"]:
        for attachment in message["attachments"]:
            attachment["file"] = from_out(folder, out, attachment["file"])
    if chat["thread"].get("image"):
        chat["thread"]["image"] = from_out(folder, out, chat["thread"]["image"])
    return chat


def source_chats(out: str, sources: list[accounts.Source]) -> dict[str, list[tuple[accounts.Source, str]]]:
    """thread id -> the sources holding that chat (source, folder), in the order of sources."""
    found: dict[str, list[tuple[accounts.Source, str]]] = {}
    for source in sources:
        for chat_path in sorted(glob.glob(os.path.join(glob.escape(source.chats), "*", "chat.json"))):
            folder = os.path.dirname(chat_path)
            match = re.match(r"^(\d+)_", os.path.basename(folder))
            if match:
                found.setdefault(match.group(1), []).append((source, folder))
    return found


def merge_sources(out: str, entries: list[tuple[accounts.Source, str]]) -> tuple[dict, str, dict]:
    """One thread from all its sources: the merged chat, its title and the raw extras per message id. Exports know the current title of a chat."""
    chats = [load_chat(folder, out) for _, folder in entries]
    exported = next((c["thread"] for (source, _), c in zip(entries, chats) if source.kind == "export"), None)
    title = (exported or {}).get("title") or thread_title(entries[0][1], chats[0]["thread"]["title"])
    extras: dict[str, dict] = {}
    for _, folder in entries:
        extras.update(raw_extras(folder))

    merged = merge_chats(chats, names_from_second=entries[0][0].kind == "scraped")
    if exported:
        merged["thread"]["is_group"] = merged["thread"]["is_group"] or exported.get("is_group")
        for field in ("request", "left", "image"):
            merged["thread"][field] = exported.get(field)
    return merged, title, extras


def build(out: str, sources: list[accounts.Source], account_info: dict | None = None) -> dict:
    data_dir = os.path.join(out, "_archive", "data")
    os.makedirs(data_dir, exist_ok=True)
    for old in glob.glob(os.path.join(glob.escape(data_dir), "t_*.js")):
        os.remove(old)

    threads = []
    me = None
    for thread_id, entries in source_chats(out, sources).items():
        chat, title, extras = merge_sources(out, entries)
        if not chat["messages"]:
            continue

        is_group = chat["thread"]["is_group"]

        people = {}
        for person in chat["participants"]:
            entry = {
                "name": person["full_name"] or person["username"],
                "username": person["username"],
                "avatar": person.get("avatar") or None,
                "me": person["is_me"],
            }
            people[person["fbid"] or person["igid"]] = entry
            if person["is_me"] and (me is None or (entry["avatar"] and not me.get("avatar"))):
                me = {"name": entry["name"], "username": entry["username"], "avatar": entry["avatar"], "igid": person["igid"]}

        messages = []
        media_count = 0
        for m in chat["messages"]:
            item = {
                "id": m["id"],
                "t": m["timestamp_ms"],
                "s": m["sender"]["fbid"] or m["sender"]["igid"],
                "me": m["sender"]["is_me"],
                "type": m["type"],
                "text": m["text"],
                "activity": m["activity"],
                "ak": m["activity_kind"],
                "fwd": m["forwarded"],
                "edits": m["edits"],
                "reply": m["reply_to"],
                "react": [[r["emoji"], r["by"]] for r in m["reactions"]],
                "att": [[a["kind"], a["file"], *image_size(os.path.join(out, a["file"]))] for a in m["attachments"]],
                "share": m["shared"],
                "gone": m["unavailable"],
            }
            item.update(extras.get(m["id"], {}))
            media_count += len(m["attachments"])
            messages.append(compact(item))

        others = [p for p in people.values() if not p["me"]]
        last = next((m for m in reversed(chat["messages"]) if m["activity_kind"] != "reaction"), chat["messages"][-1])
        summary = {
            "id": thread_id,
            "title": title,
            "group": is_group,
            "members": others,
            "count": len(messages),
            "media": media_count,
            "first": chat["messages"][0]["timestamp_ms"],
            "last": last["timestamp_ms"],
            "preview": preview_of(last, is_group),
            "sources": sorted({source.kind for source, _ in entries}, reverse=True),
        }
        for field, key in (("request", "request"), ("left", "left"), ("image", "avatar")):
            if chat["thread"].get(field):
                summary[key] = chat["thread"][field]
        threads.append(summary)

        payload = {**summary, "people": people, "messages": messages}
        with open(os.path.join(data_dir, f"t_{thread_id}.js"), "w", encoding="utf-8") as f:
            f.write(f"IGA.receive({json.dumps(thread_id)},")
            json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
            f.write(");\n")
        print(f"  {title}: {len(messages)} messages, {media_count} files")

    threads.sort(key=lambda t: t["last"], reverse=True)
    info = account_info or {}
    if me is None and info.get("username"):
        me = {"name": info.get("full_name") or info["username"], "username": info["username"], "avatar": None, "igid": info.get("user_id")}
    stories = build_stories(out, sources)
    if stories is None and os.path.exists(os.path.join(data_dir, "stories.js")):
        os.remove(os.path.join(data_dir, "stories.js"))
    people = build_people(out, sources)
    if people is None and os.path.exists(os.path.join(data_dir, "people.js")):
        os.remove(os.path.join(data_dir, "people.js"))
    with open(os.path.join(data_dir, "threads.js"), "w", encoding="utf-8") as f:
        f.write("IGA.inbox(")
        json.dump({"me": me, "threads": threads, "stories": stories, "people": people, "built": datetime.now().isoformat(timespec="seconds")}, f, ensure_ascii=False, separators=(",", ":"))
        f.write(");\n")

    for name in ("app.js", "app.css", "export.js"):
        shutil.copyfile(os.path.join(VIEWER_DIR, name), os.path.join(out, "_archive", name))
    with open(os.path.join(VIEWER_DIR, "index.html"), encoding="utf-8") as f:
        page = f.read()
    stamp = str(int(time.time()))
    for asset in ("_archive/app.css", "_archive/app.js", "_archive/export.js", "_archive/data/threads.js"):
        page = page.replace(f'"{asset}"', f'"{asset}?v={stamp}"')
    page = page.replace('<script src="_archive/app.js', f'<script>window.IGA_V="{stamp}";</script>\n<script src="_archive/app.js', 1)
    with open(os.path.join(out, "index.html"), "w", encoding="utf-8") as f:
        f.write(page)

    print(f"{len(threads)} chats -> {os.path.abspath(os.path.join(out, 'index.html'))}")
    return {
        "me": me,
        "chats": len(threads),
        "messages": sum(t["count"] for t in threads),
        "stories": (stories or {}).get("count"),
        "followers": (people or {}).get("followers"),
        "last": threads[0]["last"] if threads else None,
        "sources": [source.label for source in sources],
    }


def build_account(account: accounts.Account) -> dict:
    print(f"== {account.name} ({os.path.abspath(account.dir)})")
    summary = build(account.dir, account.sources, account.info)
    with open(os.path.join(account.dir, "_archive", "data", "summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False)
    return summary


def build_picker():
    """accounts/index.html: one card per account. With a single account it goes straight to it (unless opened with ?pick)."""
    cards = []
    names = []
    for account in accounts.all_accounts():
        summary_path = os.path.join(account.dir, "_archive", "data", "summary.json")
        if not os.path.exists(os.path.join(account.dir, "index.html")) or not os.path.exists(summary_path):
            continue
        names.append(account.name)
        with open(summary_path, encoding="utf-8") as f:
            summary = json.load(f)
        info = account.info
        me = summary.get("me") or {}
        name = info.get("full_name") or me.get("name") or account.name
        username = info.get("username") or me.get("username") or ""
        avatar = f"{account.name}/{me['avatar']}" if me.get("avatar") else ""
        stats = [f"{summary.get('chats') or 0} chats", f"{summary.get('messages') or 0:,} messages"]
        if summary.get("stories"):
            stats.append(f"{summary['stories']:,} stories")
        if summary.get("followers") is not None:
            stats.append(f"{summary['followers']} followers")
        initials = "".join(w[0] for w in name.split()[:2]).upper() or "?"
        face = f'<span class="av" style="background-image:url(&quot;{escape(avatar)}&quot;)"></span>' if avatar else f'<span class="av">{escape(initials)}</span>'
        cards.append(f'<a class="card" href="{escape(account.name)}/index.html">{face}<span class="who"><b>{escape(name)}</b>'
                     f'<small>@{escape(username)} &middot; folder {escape(account.name)}</small><small>{escape(" · ".join(stats))}</small>'
                     f'<small>{escape(" + ".join(summary.get("sources") or []))}</small></span></a>')

    page = PICKER.replace("{{CARDS}}", "\n".join(cards) or "<p>No account has been built yet.</p>")
    page = page.replace("{{ONLY}}", json.dumps(names[0] if len(names) == 1 else ""))
    os.makedirs(accounts.ROOT, exist_ok=True)
    with open(os.path.join(accounts.ROOT, "index.html"), "w", encoding="utf-8") as f:
        f.write(page)
    print(f"{len(cards)} account(s) -> {os.path.join(accounts.ROOT, 'index.html')}")


PICKER = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Instagram Archive</title>
<script>
  // a single account opens directly (keeping a #chat link); "Switch account" in the viewer comes here with ?pick
  (function () { var only = {{ONLY}}; if (only && location.search.indexOf("pick") < 0) location.replace(only + "/index.html" + location.hash); })();
</script>
<style>
  :root { --bg: #fff; --fg: #000; --muted: #737373; --hover: #f2f2f2; --av: #efefef; }
  @media (prefers-color-scheme: dark) { :root { --bg: #000; --fg: #f5f5f5; --muted: #a8a8a8; --hover: #121212; --av: #262626; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  main { max-width: 480px; margin: 0 auto; padding: 48px 16px; }
  h1 { font-size: 22px; font-weight: 700; margin: 0 0 4px; }
  p { color: var(--muted); margin: 0 0 24px; }
  .card { display: flex; align-items: center; gap: 14px; padding: 12px; border-radius: 12px; color: inherit; text-decoration: none; }
  .card:hover { background: var(--hover); }
  .av { flex: none; width: 56px; height: 56px; border-radius: 50%; background: var(--av) center / cover no-repeat; display: grid; place-items: center; font-weight: 600; color: var(--muted); }
  .who { display: flex; flex-direction: column; min-width: 0; }
  .who b { font-size: 15px; }
  .who small { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  code { background: var(--hover); padding: 1px 5px; border-radius: 4px; }
  .hint { margin-top: 32px; font-size: 12px; }
</style>
</head>
<body>
<main>
  <h1>Instagram Archive</h1>
  <p>Choose an account.</p>
  {{CARDS}}
  <p class="hint">Add another account: <code>python import_export.py &lt;instagram-export.zip&gt;</code> for an official export, or <code>python import_scraped.py &lt;scraper accounts folder&gt;</code> for scraped data.</p>
</main>
</body>
</html>
"""


def main():
    args = parser.parse_args()
    targets = [accounts.named(args.account)] if args.account else accounts.all_accounts()
    if not targets:
        raise SystemExit("No accounts under accounts/ yet.")
    for account in targets:
        build_account(account)
    build_picker()


if __name__ == "__main__":
    main()
