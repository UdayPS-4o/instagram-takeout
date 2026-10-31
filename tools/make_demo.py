"""Writes a small, entirely made-up Instagram export and imports it as the account "demo".

    python tools/make_demo.py

Nothing in it is real: the people, chats, reels and pictures are invented. It is what the screenshots in the README show,
and a quick way to try the viewer before you have your own export. Needs Pillow for the pictures.
"""
import io
import json
import math
import os
import random
import sys
import wave
import zipfile
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import build_archive
import import_export

try:
    from PIL import Image, ImageDraw
except ImportError:
    raise SystemExit("The demo draws its pictures with Pillow: pip install pillow")

ME = "Alex Demo"
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def at(day: int, hour: int, minute: int) -> int:
    return int(datetime(2026, 9, day, hour, minute).timestamp() * 1000)


def picture(seed: int, size=(900, 1200), label="") -> bytes:
    rng = random.Random(seed)
    top = tuple(rng.randint(40, 230) for _ in range(3))
    bottom = tuple(rng.randint(40, 230) for _ in range(3))
    image = Image.new("RGB", size)
    draw = ImageDraw.Draw(image)
    for y in range(size[1]):
        t = y / size[1]
        draw.line([(0, y), (size[0], y)], fill=tuple(int(a + (b - a) * t) for a, b in zip(top, bottom)))
    for _ in range(5):
        x, y, r = rng.randint(0, size[0]), rng.randint(0, size[1]), rng.randint(60, 260)
        draw.ellipse([x - r, y - r, x + r, y + r], fill=tuple(rng.randint(120, 255) for _ in range(3)))
    if label:
        draw.text((40, size[1] - 70), label, fill=(255, 255, 255))
    out = io.BytesIO()
    image.save(out, "JPEG", quality=82)
    return out.getvalue()


def tone() -> bytes:
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(8000)
        w.writeframes(b"".join(int(6000 * math.sin(2 * math.pi * 330 * i / 8000)).to_bytes(2, "little", signed=True) for i in range(8000)))
    return out.getvalue()


def reel(owner: str, code: str, caption: str) -> dict:
    return {"link": f"https://www.instagram.com/reel/{code}/", "share_text": caption, "original_content_owner": owner}


def build(path: str):
    files: dict[str, bytes] = {}
    chats = []

    def chat(folder, title, participants, messages, **meta):
        chats.append((folder, title, participants, messages, meta))

    def msg(sender, ms, text=None, **fields):
        return dict({"sender_name": sender, "timestamp_ms": ms, "is_geoblocked_for_viewer": False}, **({"content": text} if text else {}), **fields)

    inbox = "your_instagram_activity/messages/inbox/"
    jamie = inbox + "jamierivera_1001/"
    files[jamie + "photos/trail.jpg"] = picture(1, label="trail")
    files[jamie + "audio/note.wav"] = tone()
    chat("inbox/jamierivera_1001", "Jamie Rivera", ["Jamie Rivera", ME], [
        msg("Jamie Rivera", at(24, 21, 40), "ok that is actually a great idea"),
        msg(ME, at(24, 21, 38), "we could do the lake trail on saturday", reactions=[{"reaction": "❤", "actor": "Jamie Rivera"}]),
        msg("Jamie Rivera", at(24, 21, 31), "you free this weekend?"),
        msg("Jamie Rivera", at(24, 21, 30), share=reel("trail.runs", "DEMO1", "Sunrise run, 5 km before work #running #trails"), reactions=[{"reaction": "😂", "actor": ME}]),
        msg(ME, at(24, 9, 12), audio_files=[{"uri": jamie + "audio/note.wav", "creation_timestamp": 1}]),
        msg("Jamie Rivera", at(24, 9, 5), "morning!! did you see the forecast"),
        msg(ME, at(23, 18, 2), "found this on the trail yesterday", photos=[{"uri": jamie + "photos/trail.jpg", "creation_timestamp": 1}]),
        msg("Jamie Rivera", at(23, 17, 58), "send me a pic"),
        msg(ME, at(23, 17, 55), "just got back, legs are gone"),
        msg("Jamie Rivera", at(22, 20, 15), share=reel("cat.videos", "DEMO2", "Cat vs cucumber, round 4 #cats #funny"), reactions=[{"reaction": "😂", "actor": ME}, {"reaction": "😂", "actor": "Jamie Rivera"}]),
        msg(ME, at(22, 20, 3), "haha no way"),
        msg("Jamie Rivera", at(22, 20, 1), "you will not believe what happened today"),
    ])

    sam = inbox + "samokafor_1002/"
    chat("inbox/samokafor_1002", "Sam Okafor", ["Sam Okafor", ME], [
        msg("Sam Okafor", at(25, 8, 20), "coffee after the standup?"),
        msg(ME, at(25, 8, 24), "yes please", reactions=[{"reaction": "👍", "actor": "Sam Okafor"}]),
        msg("Sam Okafor", at(21, 13, 5), share=reel("dev.memes", "DEMO3", "When the tests pass on the first try #programming #memes")),
        msg(ME, at(21, 13, 9), "this is us on friday", reactions=[{"reaction": "😂", "actor": "Sam Okafor"}]),
        msg("Sam Okafor", at(20, 10, 0), "reminder: the build is red again"),
        msg(ME, at(20, 10, 2), "on it"),
    ])

    chat("inbox/weekendplans_1003", "Weekend plans 🏕️", ["Jamie Rivera", "Sam Okafor", "Priya Shah", ME], [
        msg("Priya Shah", at(26, 12, 40), "I can bring the tent"),
        msg("Sam Okafor", at(26, 12, 33), "who has a stove?"),
        msg(ME, at(26, 12, 30), "Jamie and I are doing the lake trail Saturday, join if you like", reactions=[{"reaction": "🔥", "actor": "Priya Shah"}, {"reaction": "🔥", "actor": "Sam Okafor"}]),
        msg("Jamie Rivera", at(26, 12, 20), "Priya Shah joined the group.", ),
        msg("Jamie Rivera", at(26, 12, 10), "ok so camping or not?"),
    ], is_still_participant=True)

    chat("message_requests/taylorquinn_2001", "Taylor Quinn", ["Taylor Quinn", ME], [
        msg("Taylor Quinn", at(27, 7, 45), "Hi! Loved your trail photos, do you know a good route near the lake?"),
    ], is_pending=True)

    for folder, title, participants, messages, meta in chats:
        base = "your_instagram_activity/messages/" + folder + "/message_1.json"
        files[base] = json.dumps(dict({"participants": [{"name": n} for n in participants], "messages": messages, "title": title}, **meta), ensure_ascii=False).encode("utf-8")

    files["media/other/me.jpg"] = picture(7, (300, 300), "")
    files["personal_information/personal_information/personal_information.json"] = json.dumps({"profile_user": [{
        "string_map_data": {"Username": {"value": "alex_demo"}, "Name": {"value": ME}},
        "media_map_data": {"Profile Photo": {"uri": "media/other/me.jpg"}}}]}).encode("utf-8")

    stories = []
    for n, (day, caption) in enumerate([(24, "Lake trail at sunrise"), (25, "Coffee o'clock"), (26, "Packing for the weekend")]):
        files[f"media/stories/s{n}.jpg"] = picture(20 + n, label=caption)
        stories.append({"uri": f"media/stories/s{n}.jpg", "creation_timestamp": at(day, 7 + n, 30) // 1000, "title": caption})
    files["your_instagram_activity/media/stories.json"] = json.dumps({"ig_stories": stories}).encode("utf-8")

    def people(names):
        return [{"title": "", "string_list_data": [{"href": f"https://www.instagram.com/{n}", "value": n, "timestamp": 1_780_000_000}]} for n in names]

    followers = ["trail.runs", "cat.videos", "dev.memes", "jamie.rivera", "sam.okafor", "priya.shah", "taylor.quinn", "lake.club", "coffee.daily", "night.owl", "mapping.hikes", "pixel.pals"]
    files["connections/followers_and_following/followers_1.json"] = json.dumps(people(followers)).encode("utf-8")
    files["connections/followers_and_following/following.json"] = json.dumps({"relationships_following": people(followers[:8])}).encode("utf-8")
    files["connections/followers_and_following/close_friends.json"] = json.dumps({"relationships_close_friends": [
        {"title": "", "string_list_data": [{"href": "https://www.instagram.com/jamie.rivera", "value": "jamie.rivera", "timestamp": 1}]}]}).encode("utf-8")

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files.items():
            z.writestr(name, data)


if __name__ == "__main__":
    zip_path = os.path.join(HERE, "demo-export", "instagram-alex_demo-2026-09-30-Demo.zip")
    build(zip_path)
    print("wrote", zip_path)
    account, totals = import_export.import_export([zip_path], "demo")
    build_archive.build_account(account)
    build_archive.build_picker()
    print(f"imported as account 'demo': {totals['chats']} chats, {totals['messages']} messages")
    print("now run:  python -m http.server 8765   and open http://localhost:8765/")
