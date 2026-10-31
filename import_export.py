"""Imports an official Instagram export ("Download your information", format JSON) into an account folder, ready for the viewer.

    python import_export.py instagram-yourname-2026-10-31-AbC123.zip
    python import_export.py part-1.zip part-2.zip      # an export Instagram split over several files
    python import_export.py path/to/unzipped/folder
    python import_export.py export.zip -a main         # choose the account folder yourself

The account is found from the username inside the export, so an export of an account that was already scraped (or imported before)
is added to that account: build_archive.py merges the sources per chat, matching messages on their exact timestamp.

Writes accounts/<account>/exports/<id>/
    raw/                                the export itself; all its media stay here
    chats/<threadid>_<slug>/chat.json   every DM thread, in the same format as a scraped chat.json
    stories/stories.json                your stories, same format as scraped
    people/people.json                  followers, following, blocked, close friends, same format as scraped
    export.json                         what was imported, and how much
then rebuilds the viewer of that account. Nothing here talks to Instagram.
"""
import glob
import io
import json
import os
import re
import shutil
import sys
import zipfile
from argparse import ArgumentParser
from collections import Counter
from datetime import datetime

import build_archive
from utils import accounts
from utils.files import link_or_copy

if sys.stdout is not None and isinstance(sys.stdout, io.TextIOWrapper):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

parser = ArgumentParser()
parser.add_argument("paths", nargs="+", help="The export: one or more .zip files, or an unzipped folder")
parser.add_argument("-a", "--account", help="Account folder under accounts/ (default: found from the username in the export)")
parser.add_argument("--no-build", action="store_true", help="Don't rebuild the viewer afterwards")

# the folder layout has changed over the years; the first one that exists wins
MESSAGE_ROOTS = ("your_instagram_activity/messages", "messages")
CONNECTION_DIRS = ("connections/followers_and_following", "followers_and_following")
PROFILE_FILES = ("personal_information/personal_information/personal_information.json", "personal_information/personal_information.json", "account_information/personal_information.json")
STORY_FILES = ("your_instagram_activity/media/stories.json", "your_instagram_activity/content/stories.json", "media/stories.json", "content/stories.json")
INSIGHT_FILES = ("logged_information/past_instagram_insights/stories.json", "past_instagram_insights/stories.json")
TOP_FOLDERS = ("your_instagram_activity", "messages", "connections", "followers_and_following", "personal_information")
REQUEST_BOXES = ("message_requests", "filtered_threads")

MEDIA_KEYS = (("photos", "image", "IMAGES"), ("videos", "video", "VIDEOS"), ("audio_files", "audio", "AUDIOS"), ("gifs", "image", "GIFS"), ("files", "file", "FILES"))

PLACEHOLDER = re.compile(r"^(.{1,80}) sent an attachment\.?$", re.S)
REACTION = re.compile(r"^(?:Reacted .+ to your message|.+ reacted .+ to your message|Liked a message)\s*$", re.S)
EVENT = re.compile(r"""^(?:
    .+\ (?:started|missed)\ (?:a\ video\ chat|a\ video\ call|an\ audio\ call)
  | (?:Audio\ call|Video\ chat|Video\ call)\ (?:started|ended)
  | .+\ (?:pinned|unpinned)\ a\ message\.?
  | .+\ (?:set|cleared)\ .*nickname.*
  | .+\ changed\ the\ theme.*
  | .+\ added\ to\ a\ collection:\ .+
  | .+\ sent\ a\ private\ reply\ to\ a\ comment\ on\ your\ Instagram\ post\.
  | Sent\ a\ doodle\..*
)\s*$""", re.X | re.S)
GROUP_EVENT = re.compile(r"""^(?:
    .+\ (?:left\ the\ (?:group|chat)|joined\ the\ group)\.?
  | .+\ added\ .*to\ the\ group\.?
  | .+\ added\ participants\.?
  | .+\ removed\ .*from\ the\ group\.?
  | .*\ (?:added|removed)\ .*as\ a\ group\ admin\.?
  | .+\ named\ the\ group\ .+
  | .+\ changed\ the\ group\ photo\.?
  | .+\ created\ the\ group(?:\ chat)?\.?
)\s*$""", re.X | re.S)
USERNAME = re.compile(r"^[a-z0-9._]{3,30}$")
EVENT_ACTOR = re.compile(r"^(\S+) (?:started|missed|named|changed|set|cleared|added|removed|pinned|unpinned|left|joined|created)\b")
INSTAGRAM_LINK = re.compile(r"^https?://(?:[\w-]+\.)?(?:instagram\.com|ig\.me)/", re.I)
STORY_LINK = re.compile(r"/stories/([^/?#]+)/", re.I)


def fix_text(value):
    """Instagram writes its JSON with UTF-8 bytes escaped as if they were Latin-1 (\\u00f0\\u009f\\u0098\\u0082 for a laughing emoji). Undamaged strings stay as they are."""
    if isinstance(value, str):
        try:
            return value.encode("latin-1").decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            return value
    if isinstance(value, list):
        return [fix_text(v) for v in value]
    if isinstance(value, dict):
        return {k: fix_text(v) for k, v in value.items()}
    return value


def read_json(path: str):
    with open(path, encoding="utf-8") as f:
        return fix_text(json.load(f))


def write_json(path: str, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)


def sniff_extension(path: str) -> str:
    """Some media come without a file extension. The viewer and the browser's "Open file" need one."""
    with open(path, "rb") as f:
        head = f.read(16)
    if head.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if head.startswith(b"\x89PNG"):
        return ".png"
    if head.startswith(b"GIF8"):
        return ".gif"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return ".webp"
    if head[4:8] == b"ftyp":
        return ".heic" if head[8:12] in (b"heic", b"heix", b"mif1") else ".mp4"
    if head.startswith(b"OggS"):
        return ".ogg"
    if head.startswith(b"ID3"):
        return ".mp3"
    return ""


class Export:
    """The unpacked export. URIs in its JSON are relative to its top folder."""

    def __init__(self, raw: str):
        self.root = self.find_root(raw)
        self.missing = 0
        self.remote = 0

    @staticmethod
    def find_root(raw: str) -> str:
        level = [raw]
        for _ in range(3):
            below = []
            for folder in level:
                names = os.listdir(folder)
                if any(name in names for name in TOP_FOLDERS):
                    return folder
                below += [os.path.join(folder, n) for n in names if os.path.isdir(os.path.join(folder, n))]
            level = below
        return raw

    def path(self, relative: str) -> str:
        return os.path.join(self.root, *relative.split("/"))

    def first(self, candidates) -> str | None:
        return next((self.path(c) for c in candidates if os.path.exists(self.path(c))), None)

    def read(self, candidates, default=None):
        path = self.first(candidates)
        return read_json(path) if path else default

    def connection_files(self, *patterns) -> list[str]:
        found = []
        for folder in CONNECTION_DIRS:
            for pattern in patterns:
                found += glob.glob(os.path.join(glob.escape(self.path(folder)), pattern))
        return sorted(set(found))

    def media(self, uri: str | None) -> str | None:
        """The file behind a URI in the export, or None when the export doesn't hold it."""
        if not uri:
            return None
        if uri.startswith(("http://", "https://")):  # an old CDN link, long expired
            self.remote += 1
            return None
        path = self.path(uri.split("?")[0])
        if not os.path.isfile(path):
            self.missing += 1
            return None
        if not os.path.splitext(path)[1]:
            extension = sniff_extension(path)
            if extension:
                os.replace(path, path + extension)
                return path + extension
        return path


def relative_to(path: str, folder: str) -> str:
    return os.path.relpath(path, folder).replace("\\", "/")


def stamp(seconds: float | None) -> str | None:
    return datetime.fromtimestamp(seconds).isoformat(timespec="seconds") if seconds else None


def read_profile(export: Export) -> dict:
    data = export.read(PROFILE_FILES) or {}
    rows = data.get("profile_user") if isinstance(data, dict) else None
    row = rows[0] if rows else {}
    strings = row.get("string_map_data") or {}
    photo = (row.get("media_map_data") or {}).get("Profile Photo") or {}
    value = lambda key: (strings.get(key) or {}).get("value") or None
    return {"username": value("Username"), "full_name": value("Name"), "bio": value("Bio"), "photo": photo.get("uri")}


def connection_rows(data) -> list[dict]:
    """A connections file is a bare list, a {"relationships_x": [...]} wrapper, or a single object when it holds one person."""
    if isinstance(data, list):
        return [row for row in data if isinstance(row, dict)]
    if isinstance(data, dict):
        if "label_values" in data or "string_list_data" in data:
            return [data]
        for value in data.values():
            if isinstance(value, list):
                return [row for row in value if isinstance(row, dict)]
    return []


def parse_person(row: dict) -> dict | None:
    labels = {item.get("label"): item.get("value") for item in row.get("label_values") or []}
    item = (row.get("string_list_data") or [{}])[0]
    from_url = (item.get("href") or "").rstrip("/").rsplit("/", 1)[-1]
    username = labels.get("Username") or item.get("value") or row.get("title") or from_url
    if not username:
        return None
    return {"username": username, "full_name": labels.get("Name") or "", "time": row.get("timestamp") or item.get("timestamp")}


def read_connection(export: Export, *patterns) -> list[dict]:
    people = {}
    for path in export.connection_files(*patterns):
        for row in connection_rows(read_json(path)):
            person = parse_person(row)
            if person:
                people.setdefault(person["username"], person)
    return list(people.values())


def learn_usernames(export: Export, threads: list[dict]) -> dict[str, str]:
    """Messages only give display names. Other parts of the export link a display name to a username, which the viewer needs for its profile links."""
    usernames: dict[str, str] = {}
    known: set[str] = set()
    for path in export.connection_files("*.json"):
        for row in connection_rows(read_json(path)):
            person = parse_person(row)
            if person:
                known.add(person["username"])
                if person["full_name"]:
                    usernames.setdefault(person["full_name"], person["username"])
    # system messages name people by username: "alex_demo started a video chat" from the sender with another display name
    for thread in threads:
        for message in thread["messages"]:
            found = EVENT_ACTOR.match(message.get("content") or "")
            sender = message.get("sender_name")
            if found and sender and sender != found.group(1) and "call_duration" not in message:
                token = found.group(1)
                if USERNAME.match(token) and (token in known or re.search(r"[._0-9]", token)):
                    usernames.setdefault(sender, token)
    for name in {p.get("name") for thread in threads for p in thread["meta"].get("participants") or []} - {None}:
        if name not in usernames and USERNAME.match(name) and (name in known or re.search(r"[._0-9]", name)):
            usernames[name] = name
    return usernames


def read_threads(export: Export) -> list[dict]:
    root = export.first(MESSAGE_ROOTS)
    if root is None:
        return []
    threads = []
    for box in sorted(os.listdir(root)):
        box_dir = os.path.join(root, box)
        if not os.path.isdir(box_dir):
            continue
        for name in sorted(os.listdir(box_dir)):
            folder = os.path.join(box_dir, name)
            parts = glob.glob(os.path.join(glob.escape(folder), "message_*.json"))
            found = re.search(r"(\d+)$", name)
            if not parts or not found:
                continue
            parts.sort(key=lambda p: int(re.search(r"(\d+)\.json$", p).group(1)))
            meta, messages = None, []
            for part in parts:
                data = read_json(part)
                meta = meta or data
                messages += data.get("messages") or []
            threads.append({"id": found.group(1), "box": box, "slug": name[: found.start()].strip("_"), "meta": meta, "messages": messages})
    return threads


def who_is_me(threads: list[dict], profile_name: str | None) -> str | None:
    counts = Counter(p.get("name") for thread in threads for p in thread["meta"].get("participants") or [])
    if profile_name and counts.get(profile_name):
        return profile_name
    return counts.most_common(1)[0][0] if counts else profile_name


def is_placeholder(text: str, sender: str, has_share: bool) -> bool:
    """ "Alex sent an attachment." stands in for a share or a lost attachment, but people can type that too."""
    found = PLACEHOLDER.match(text)
    if not found:
        return False
    who = found.group(1)
    return has_share or who == "You" or who == sender or sender.startswith(who.split()[0])


def convert_share(share: dict, text: str | None, me_username: str | None, is_me: bool) -> tuple[dict | None, str | None]:
    """The scraped "shared" block for an official share + the text that should still show as a message."""
    link = share.get("link") or ""
    caption = share.get("share_text") or None
    if text and link and not INSTAGRAM_LINK.match(link) and link in text:
        return None, text  # someone pasted a link: that's just a message
    if text and text.strip() == link:
        text = None

    if share.get("profile_share_username"):
        username = share["profile_share_username"]
        return {"kind": "profile", "decoration": None, "account": username, "caption": share.get("profile_share_name"), "note": None, "eyebrow": None,
                "link": link or f"https://www.instagram.com/{username}/", "is_reply_to_story": False}, text

    story = STORY_LINK.search(link)
    if story:
        owner = story.group(1)
        mine = bool(me_username) and owner.lower() == me_username.lower()
        whose = "your" if mine else f"{owner}'s"
        verb = "replied to" if text else "shared"
        eyebrow = f"You {verb} {whose} story" if is_me else f"{verb.capitalize()} {whose} story"
        return {"kind": "story", "decoration": None, "account": owner, "caption": None, "note": "Story not in the export", "eyebrow": eyebrow, "link": link, "is_reply_to_story": bool(text)}, text

    decoration = "REEL" if re.search(r"/reels?/", link) else None
    return {"kind": "share", "decoration": decoration, "account": share.get("original_content_owner"), "caption": caption, "note": None, "eyebrow": None, "link": link or None, "is_reply_to_story": False}, text


def fmt_duration(seconds: int) -> str:
    return f"{seconds // 60}:{seconds % 60:02d}"


def convert_thread(export: Export, thread: dict, folder: str, me: str | None, profile: dict, usernames: dict[str, str]) -> dict:
    meta = thread["meta"]
    names = [p.get("name") for p in meta.get("participants") or [] if p.get("name")]
    for message in thread["messages"]:
        sender = message.get("sender_name")
        if sender and sender not in names:
            names.append(sender)

    others = [n for n in names if n != me]
    is_group = len(others) > 1 or "joinable_mode" in meta or "image" in meta

    my_avatar = export.media(profile.get("photo"))
    participants, senders = [], {}
    for name in names:
        is_me = name == me
        username = profile.get("username") if is_me else usernames.get(name)
        person = {"fbid": "", "igid": "n:" + name, "username": username or "", "full_name": name, "avatar": relative_to(my_avatar, folder) if is_me and my_avatar else None, "is_me": is_me}
        participants.append(person)
        senders[name] = {"name": "You" if is_me else name, "username": username or "", "igid": person["igid"], "fbid": "", "is_me": is_me}

    messages, seen_ids = [], Counter()
    for m in sorted(thread["messages"], key=lambda x: x.get("timestamp_ms") or 0):
        when = m.get("timestamp_ms") or 0
        sender_name = m.get("sender_name") or "Instagram User"
        sender = senders.get(sender_name) or {"name": sender_name, "username": "", "igid": "n:" + sender_name, "fbid": "", "is_me": False}
        text = (m.get("content") or "").strip()
        share = m.get("share") or None

        attachments = []
        kind = None
        for key, attachment_kind, message_type in MEDIA_KEYS:
            for item in m.get(key) or []:
                kind = kind or message_type
                path = export.media(item.get("uri"))
                if path:
                    attachments.append({"kind": attachment_kind, "file": relative_to(path, folder)})

        placeholder = bool(text) and is_placeholder(text, sender_name, bool(share))
        if placeholder:
            text = ""

        shared = None
        if share:
            shared, text = convert_share(share, text or None, profile.get("username"), sender["is_me"])
            text = text or ""

        activity, activity_kind = None, None
        if text and not share and not kind:
            if REACTION.match(text):
                activity, activity_kind = text, "reaction"
            elif "call_duration" in m or EVENT.match(text) or (is_group and GROUP_EVENT.match(text)):
                activity, activity_kind = text, "event"
                if m.get("call_duration"):
                    activity += " · " + fmt_duration(int(m["call_duration"]))
            if activity:
                text = ""

        if shared:
            message_type = "MESSAGE_INLINE_SHARE"
        elif kind:
            message_type = kind
        elif placeholder:
            message_type = "MESSAGE_INLINE_SHARE"
        elif activity:
            message_type = "ACTION_LOG"
        else:
            message_type = "TEXT" if text else "UNKNOWN"

        seen_ids[when] += 1
        messages.append({
            "id": f"e{when}" + (f"_{seen_ids[when]}" if seen_ids[when] > 1 else ""),
            "timestamp": datetime.fromtimestamp(when / 1000).isoformat(timespec="seconds"),
            "timestamp_ms": when,
            "sender": sender,
            "type": message_type,
            "text": text or None,
            "activity": activity,
            "activity_kind": activity_kind,
            "forwarded": False,
            "edits": [],
            "reply_to": None,
            "reactions": [{"emoji": r.get("reaction"), "by": "You" if r.get("actor") == me else r.get("actor")} for r in m.get("reactions") or []],
            "attachments": attachments,
            "shared": shared,
            "unavailable": "Unsent" if m.get("is_unsent_image_by_messenger_kid_parent") else None,
        })

    image = export.media((meta.get("image") or {}).get("uri"))
    title = meta.get("title") or ", ".join(others) or "Chat"
    return {
        "thread": {
            "folder": os.path.basename(folder),
            "title": title,
            "is_group": is_group,
            "request": thread["box"] in REQUEST_BOXES,
            "left": meta.get("is_still_participant") is False,
            "image": relative_to(image, folder) if image else None,
            "message_count": len(messages),
            "first_message": messages[0]["timestamp"] if messages else None,
            "last_message": messages[-1]["timestamp"] if messages else None,
            "exported_at": datetime.now().isoformat(timespec="seconds"),
        },
        "participants": participants,
        "messages": messages,
    }


def write_chats(export: Export, target: str, threads: list[dict], me: str | None, profile: dict, usernames: dict[str, str]) -> dict:
    chats_dir = os.path.join(target, "chats")
    totals = Counter()
    for thread in threads:
        slug = re.sub(r"[^\w.-]+", "", thread["slug"], flags=re.ASCII)[:40] or "chat"
        folder = os.path.join(chats_dir, f"{thread['id']}_{slug}")
        chat = convert_thread(export, thread, folder, me, profile, usernames)
        write_json(os.path.join(folder, "chat.json"), chat)
        totals["chats"] += 1
        totals["requests"] += 1 if chat["thread"]["request"] else 0
        totals["messages"] += len(chat["messages"])
        totals["attachments"] += sum(len(m["attachments"]) for m in chat["messages"])
    return dict(totals)


def read_insights(export: Export) -> dict[int, str]:
    """What Instagram reports per story, keyed by the time it was posted."""
    data = export.read(INSIGHT_FILES) or {}
    found = {}
    for row in data.get("organic_insights_stories") or [] if isinstance(data, dict) else []:
        strings = row.get("string_map_data") or {}
        when = (strings.get("Creation Timestamp") or {}).get("timestamp")
        parts = []
        for key, label in (("Accounts reached", "reached"), ("Impressions", "views"), ("Replies", "replies"), ("Shares", "shares")):
            value = (strings.get(key) or {}).get("value")
            if value and value != "0":
                parts.append(f"{value} {label}")
        if when and parts:
            found[int(when)] = " · ".join(parts)
    return found


def write_stories(export: Export, target: str, profile: dict, generated: str | None) -> int:
    data = export.read(STORY_FILES)
    rows = data.get("ig_stories") or data.get("stories") or [] if isinstance(data, dict) else data or []
    folder = os.path.join(target, "stories")
    insights = read_insights(export)
    days: dict[str, list[dict]] = {}
    for row in rows:
        when = row.get("creation_timestamp")
        path = export.media(row.get("uri"))
        if not when or not path:
            continue
        stickers = [{"kind": "story_insight", "label": insights[int(when)]}] if int(when) in insights else []
        story = {
            "pk": os.path.splitext(os.path.basename(path))[0],
            "taken_at": int(when),
            "time": stamp(when),
            "type": "video" if re.search(r"\.(mp4|mov|webm|m4v)$", path, re.I) else "photo",
            "close_friends": False,
            "caption": row.get("title") or None,
            "file": relative_to(path, folder),
            "thumb": None,
            "mentions": [],
            "shared_media": [],
            "stickers": stickers,
        }
        days.setdefault(story["time"][:10], []).append(story)

    archive = [{"id": date, "date": date, "stories": sorted(days[date], key=lambda s: s["taken_at"])} for date in sorted(days)]
    if archive:
        write_json(os.path.join(folder, "stories.json"), {
            "generated": generated,
            "account": {"username": profile.get("username"), "full_name": profile.get("full_name")},
            "archive": archive,
            "highlights": [],
        })
    return sum(len(d["stories"]) for d in archive)


def write_people(export: Export, target: str, profile: dict, generated: str | None) -> dict:
    def listing(*patterns) -> list[dict]:
        rows = []
        for person in read_connection(export, *patterns):
            since = datetime.fromtimestamp(person["time"]).strftime("since %b %d, %Y") if person.get("time") else None
            rows.append({"pk": person["username"], "username": person["username"], "full_name": person["full_name"], "note": since})
        return rows

    lists = {
        "followers": listing("followers.json", "followers_*.json"),
        "following": listing("following.json", "following_*.json"),
        "blocked": listing("blocked_profiles.json", "blocked_accounts.json"),
        "close_friends": listing("close_friends.json"),
    }
    if any(lists.values()):
        write_json(os.path.join(target, "people", "people.json"), {
            "generated": generated,
            "account": {"username": profile.get("username"), "full_name": profile.get("full_name")},
            "expected": {},
            "close_friends_count": len(lists["close_friends"]),
            "changes": None,
            **lists,
        })
    return {kind: len(rows) for kind, rows in lists.items()}


def export_id(path: str) -> str:
    """instagram-yourname-2026-10-31-AbC123.zip -> 2026-10-31-AbC123. Exports sort by date this way."""
    stem = os.path.splitext(os.path.basename(path.rstrip("/\\")))[0]
    found = re.match(r"^instagram-.+?-(\d{4}-\d{2}-\d{2}-.+)$", stem)
    name = found.group(1) if found else datetime.fromtimestamp(os.path.getmtime(path)).strftime("%Y-%m-%d-") + stem
    return re.sub(r"[^\w.-]+", "_", name)


def unpack(paths: list[str], raw: str):
    """Unpacks the export next to where it ends up, so a failed import leaves an earlier import of it untouched."""
    temp = raw + ".tmp"
    if os.path.exists(temp):
        shutil.rmtree(temp)
    os.makedirs(temp)
    for path in paths:
        if os.path.isdir(path):
            print(f"Copying {path} ...", flush=True)
            shutil.copytree(path, temp, dirs_exist_ok=True, copy_function=link_or_copy)
        elif zipfile.is_zipfile(path):
            print(f"Unpacking {path} ...", flush=True)
            with zipfile.ZipFile(path) as z:
                z.extractall(temp)
        else:
            shutil.rmtree(temp)
            raise SystemExit(f"Not a zip file or a folder: {path}")
    if os.path.exists(raw):
        shutil.rmtree(raw)
    os.replace(temp, raw)


def peek_username(paths: list[str]) -> str | None:
    """The account an export belongs to, read before anything is unpacked: the username inside it, or else the file name."""
    for path in paths:
        if os.path.isdir(path):
            data = Export(path).read(PROFILE_FILES)
        elif zipfile.is_zipfile(path):
            data = None
            with zipfile.ZipFile(path) as z:
                name = next((n for n in z.namelist() if any(n.endswith(p) for p in PROFILE_FILES)), None)
                if name:
                    data = fix_text(json.loads(z.read(name).decode("utf-8")))
        else:
            continue
        rows = data.get("profile_user") if isinstance(data, dict) else None
        value = ((rows[0].get("string_map_data") or {}).get("Username") or {}).get("value") if rows else None
        if value:
            return value
    found = re.match(r"^instagram-(.+?)-\d{4}-\d{2}-\d{2}-", os.path.basename(paths[0]))
    return found.group(1) if found else None


def import_export(paths: list[str], account_name: str | None = None) -> tuple[accounts.Account, dict]:
    for path in paths:
        if not os.path.exists(path):
            raise SystemExit(f"Not found: {path}")
    account = accounts.for_username(peek_username(paths), account_name)
    target = os.path.join(account.exports, export_id(paths[0]))
    raw = os.path.join(target, "raw")

    unpack(paths, raw)
    export = Export(raw)
    threads = read_threads(export)
    profile = read_profile(export)

    html = glob.glob(os.path.join(glob.escape(export.root), "**", "message_*.html"), recursive=True)
    problem = None
    if not threads and html:
        problem = ("This export is in HTML format, which can't be read. Request it again with the format set to JSON: "
                   "Instagram > Accounts Center > Your information and permissions > Download your information.")
    elif not threads and not any(os.path.exists(export.path(f)) for f in TOP_FOLDERS):
        problem = f"This doesn't look like an Instagram export: nothing of it was found in {paths[0]}"
    if problem:
        shutil.rmtree(target)
        raise SystemExit(problem)

    # the export has no creation date of its own: the newest message or follow in it is the closest thing
    newest = max((m.get("timestamp_ms") or 0 for t in threads for m in t["messages"]), default=0)
    generated = stamp(newest / 1000) if newest else datetime.now().isoformat(timespec="seconds")

    for folder in ("chats", "stories", "people"):  # a re-import replaces what the previous one wrote
        if os.path.exists(os.path.join(target, folder)):
            shutil.rmtree(os.path.join(target, folder))

    me = who_is_me(threads, profile.get("full_name"))
    usernames = learn_usernames(export, threads)
    totals = write_chats(export, target, threads, me, profile, usernames)
    totals["stories"] = write_stories(export, target, profile, generated)
    totals.update(write_people(export, target, profile, generated))
    totals["media_missing"] = export.missing
    totals["media_remote"] = export.remote

    write_json(os.path.join(target, "export.json"), {
        "imported_at": datetime.now().isoformat(timespec="seconds"),
        "from": [os.path.abspath(p) for p in paths],
        "newest_content": generated,
        "username": profile.get("username"),
        "full_name": profile.get("full_name"),
        "totals": totals,
    })
    account.update(username=profile.get("username"), full_name=profile.get("full_name"))
    return account, totals


def main():
    args = parser.parse_args()
    account, totals = import_export(args.paths, args.account)
    print(f"{account.name}: {totals.get('chats', 0)} chats ({totals.get('requests', 0)} requests), {totals.get('messages', 0):,} messages, {totals.get('attachments', 0):,} media files, "
          f"{totals.get('stories', 0)} stories, {totals.get('followers', 0)} followers, {totals.get('following', 0)} following, "
          f"{totals.get('blocked', 0)} blocked, {totals.get('close_friends', 0)} close friends")
    if totals.get("media_missing") or totals.get("media_remote"):
        print(f"Not in the export: {totals['media_missing']} media files listed but absent, {totals['media_remote']} only linked to Instagram's servers.")
    if not args.no_build:
        build_archive.build_account(account)
        build_archive.build_picker()


if __name__ == "__main__":
    main()
