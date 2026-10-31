"""python -m unittest discover -s tests"""
import json
import os
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import build_archive
import import_export
from utils import accounts
from utils.merge import merge_chats


def scraped_message(ms, text=None, is_me=False, shared=None, attachments=None, reactions=None):
    return {
        "id": f"mid.{ms}", "timestamp": "", "timestamp_ms": ms,
        "sender": {"name": "You" if is_me else "Jamie", "username": "me" if is_me else "jamie", "igid": "1" if is_me else "2", "fbid": "", "is_me": is_me},
        "type": "TEXT", "text": text, "activity": None, "activity_kind": None, "forwarded": False, "edits": [], "reply_to": None,
        "reactions": reactions or [], "attachments": attachments or [], "shared": shared, "unavailable": None,
    }


def scraped_chat(messages):
    return {
        "thread": {"title": "chat", "is_group": False},
        "participants": [
            {"fbid": "", "igid": "1", "username": "me", "full_name": "Me", "is_me": True, "avatar": "me.jpg"},
            {"fbid": "", "igid": "2", "username": "jamie", "full_name": "Jamie", "is_me": False, "avatar": "s.jpg"},
        ],
        "messages": messages,
    }


class TestFixText(unittest.TestCase):
    def test_repairs_mojibake(self):
        self.assertEqual(import_export.fix_text("😂 नमस्ते".encode("utf-8").decode("latin-1")), "😂 नमस्ते")

    def test_leaves_good_text_alone(self):
        self.assertEqual(import_export.fix_text("plain"), "plain")
        self.assertEqual(import_export.fix_text("😂 already fine"), "😂 already fine")
        self.assertEqual(import_export.fix_text("café"), "café")

    def test_nested(self):
        self.assertEqual(import_export.fix_text({"a": ["Ã©"], "n": 1}), {"a": ["é"], "n": 1})


class TestConvert(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = self.tmp.name
        self.export = import_export.Export(self.root)
        os.makedirs(os.path.join(self.root, "your_instagram_activity", "messages"))
        self.export.root = self.root

    def convert(self, messages, participants=("Jamie Rivera", "Me"), **meta):
        thread = {"id": "1", "box": "inbox", "slug": "", "meta": {"participants": [{"name": n} for n in participants], "title": "T", **meta}, "messages": messages}
        chat = import_export.convert_thread(self.export, thread, os.path.join(self.root, "chats", "1_x"), "Me", {"username": "me", "full_name": "Me"}, {})
        return chat

    def test_oldest_first_and_sides(self):
        chat = self.convert([
            {"sender_name": "Me", "timestamp_ms": 2000, "content": "second"},
            {"sender_name": "Jamie Rivera", "timestamp_ms": 1000, "content": "first"},
        ])
        self.assertEqual([m["text"] for m in chat["messages"]], ["first", "second"])
        self.assertTrue(chat["messages"][1]["sender"]["is_me"])
        self.assertFalse(chat["thread"]["is_group"])

    def test_share_placeholder_becomes_a_card(self):
        chat = self.convert([{"sender_name": "Jamie Rivera", "timestamp_ms": 1, "content": "Jamie sent an attachment.",
                              "share": {"link": "https://www.instagram.com/reel/abc/", "share_text": "cap", "original_content_owner": "bob"}}])
        m = chat["messages"][0]
        self.assertIsNone(m["text"])
        self.assertEqual(m["shared"]["decoration"], "REEL")
        self.assertEqual(m["shared"]["account"], "bob")
        self.assertEqual(m["shared"]["caption"], "cap")

    def test_lost_attachment_has_no_text(self):
        m = self.convert([{"sender_name": "Jamie Rivera", "timestamp_ms": 1, "content": "Jamie sent an attachment."}])["messages"][0]
        self.assertIsNone(m["text"])
        self.assertEqual(m["type"], "MESSAGE_INLINE_SHARE")

    def test_typed_sentence_is_not_a_placeholder(self):
        m = self.convert([{"sender_name": "Jamie Rivera", "timestamp_ms": 1, "content": "Bob sent an attachment."}])["messages"][0]
        self.assertEqual(m["text"], "Bob sent an attachment.")

    def test_pasted_link_stays_text(self):
        url = "https://youtube.com/shorts/x"
        m = self.convert([{"sender_name": "Me", "timestamp_ms": 1, "content": url, "share": {"link": url, "share_text": url}}])["messages"][0]
        self.assertEqual(m["text"], url)
        self.assertIsNone(m["shared"])

    def test_story_reply(self):
        m = self.convert([{"sender_name": "Jamie Rivera", "timestamp_ms": 1, "content": "nice", "share": {"link": "https://www.instagram.com/stories/me/123"}}])["messages"][0]
        self.assertEqual(m["shared"]["eyebrow"], "Replied to your story")
        self.assertEqual(m["text"], "nice")

    def test_reactions_and_events(self):
        chat = self.convert([
            {"sender_name": "Jamie Rivera", "timestamp_ms": 1, "content": "Reacted 😂 to your message "},
            {"sender_name": "Jamie Rivera", "timestamp_ms": 2, "content": "Liked a message"},
            {"sender_name": "Me", "timestamp_ms": 3, "content": "Audio call ended", "call_duration": 585},
            {"sender_name": "Me", "timestamp_ms": 4, "content": "hi", "reactions": [{"reaction": "❤", "actor": "Me"}, {"reaction": "😂", "actor": "Jamie Rivera"}]},
        ])
        kinds = [m["activity_kind"] for m in chat["messages"]]
        self.assertEqual(kinds, ["reaction", "reaction", "event", None])
        self.assertEqual(chat["messages"][2]["activity"], "Audio call ended · 9:45")
        self.assertEqual(chat["messages"][3]["reactions"], [{"emoji": "❤", "by": "You"}, {"emoji": "😂", "by": "Jamie Rivera"}])

    def test_group_event_only_in_groups(self):
        text = "Jamie Rivera left the group."
        self.assertEqual(self.convert([{"sender_name": "Jamie Rivera", "timestamp_ms": 1, "content": text}])["messages"][0]["text"], text)
        group = self.convert([{"sender_name": "Jamie Rivera", "timestamp_ms": 1, "content": text}], participants=("Jamie Rivera", "Me", "Bob"))
        self.assertEqual(group["messages"][0]["activity"], text)
        self.assertTrue(group["thread"]["is_group"])

    def test_media_extension_is_sniffed_and_missing_counted(self):
        folder = os.path.join(self.root, "your_instagram_activity", "messages", "inbox", "x_1", "photos")
        os.makedirs(folder)
        with open(os.path.join(folder, "123"), "wb") as f:
            f.write(b"\xff\xd8\xff\xe0 jpeg")
        uri = "your_instagram_activity/messages/inbox/x_1/photos/"
        chat = self.convert([{"sender_name": "Me", "timestamp_ms": 1, "photos": [{"uri": uri + "123"}, {"uri": uri + "gone.jpg"}, {"uri": "https://cdn/x.jpg?a=1"}]}])
        files = [a["file"] for a in chat["messages"][0]["attachments"]]
        self.assertEqual(len(files), 1)
        self.assertTrue(files[0].endswith("photos/123.jpg"))
        self.assertTrue(os.path.exists(os.path.join(folder, "123.jpg")))
        self.assertEqual((self.export.missing, self.export.remote), (1, 1))


class TestPeople(unittest.TestCase):
    def test_all_row_shapes(self):
        cases = [
            ([{"title": "", "string_list_data": [{"href": "https://www.instagram.com/a", "value": "a", "timestamp": 5}]}], "a"),
            ({"relationships_following": [{"title": "b", "string_list_data": [{"href": "https://www.instagram.com/_u/b", "timestamp": 5}]}]}, "b"),
            ({"timestamp": 5, "media": [], "label_values": [{"label": "Name", "value": "C C"}, {"label": "Username", "value": "c"}], "fbid": "1"}, "c"),
            ([{"string_list_data": [{"href": "https://www.instagram.com/d/"}]}], "d"),
        ]
        for data, username in cases:
            rows = import_export.connection_rows(data)
            self.assertEqual(len(rows), 1)
            self.assertEqual(import_export.parse_person(rows[0])["username"], username)


class TestMerge(unittest.TestCase):
    def export_side(self, messages):
        return {
            "thread": {"title": "Jamie Rivera", "is_group": False},
            "participants": [
                {"fbid": "", "igid": "n:Jamie Rivera", "username": "", "full_name": "Jamie Rivera", "is_me": False},
                {"fbid": "", "igid": "n:Me", "username": "me", "full_name": "Me", "is_me": True},
            ],
            "messages": messages,
        }

    def export_message(self, ms, is_me=False, **fields):
        name = "Me" if is_me else "Jamie Rivera"
        m = scraped_message(ms, is_me=is_me)
        m.update(id=f"e{ms}", sender={"name": "You" if is_me else name, "username": "", "igid": "n:" + name, "fbid": "", "is_me": is_me}, **fields)
        return m

    def test_union_keeps_each_message_once(self):
        scraped = scraped_chat([scraped_message(1, "a"), scraped_message(2, "only scraped")])
        export = self.export_side([self.export_message(1, text="a"), self.export_message(3, text="newer")])
        merged = merge_chats([scraped, export])
        self.assertEqual([m["timestamp_ms"] for m in merged["messages"]], [1, 2, 3])
        self.assertEqual(merged["messages"][0]["id"], "mid.1")

    def test_fills_what_the_base_is_missing(self):
        shared = {"kind": "x", "account": "bob", "caption": None, "link": "https://l"}
        scraped = scraped_chat([scraped_message(1, shared=dict(shared), attachments=[{"kind": "thumbnail", "file": "t.jpg"}])])
        export = self.export_side([self.export_message(1, shared={"kind": "share", "account": "bob", "caption": "cap", "link": "https://l"})])
        m = merge_chats([scraped, export])["messages"][0]
        self.assertEqual(m["shared"]["caption"], "cap")
        self.assertEqual(m["shared"]["kind"], "x")
        self.assertEqual(m["attachments"][0]["file"], "t.jpg")

    def test_export_only_message_belongs_to_the_scraped_person(self):
        scraped = scraped_chat([scraped_message(1, "a")])
        export = self.export_side([self.export_message(9, text="new"), self.export_message(10, is_me=True, text="mine")])
        merged = merge_chats([scraped, export])
        self.assertEqual(len(merged["participants"]), 2)
        self.assertEqual(merged["messages"][1]["sender"]["igid"], "2")
        self.assertEqual(merged["messages"][2]["sender"]["igid"], "1")
        self.assertTrue(merged["messages"][2]["sender"]["is_me"])

    def test_reactions_are_not_doubled_and_use_scraped_names(self):
        scraped = scraped_chat([scraped_message(1, "a", reactions=[{"emoji": "😂", "by": "Jamie"}])])
        export = self.export_side([self.export_message(1, reactions=[{"emoji": "😂", "by": "Jamie Rivera"}, {"emoji": "❤", "by": "You"}])])
        m = merge_chats([scraped, export])["messages"][0]
        self.assertEqual(m["reactions"], [{"emoji": "😂", "by": "Jamie"}, {"emoji": "❤", "by": "You"}])

    def test_current_names_replace_old_ones_everywhere(self):
        message = scraped_message(1, "a", reactions=[{"emoji": "😂", "by": "Jamie"}])
        message["reply_to"] = {"id": "x", "sender": "Jamie", "type": "TEXT", "text": "t"}
        export = self.export_side([self.export_message(2, text="new", reactions=[{"emoji": "😂", "by": "Jamie Rivera"}])])
        merged = merge_chats([scraped_chat([message]), export], names_from_second=True)
        them = next(p for p in merged["participants"] if not p["is_me"])
        self.assertEqual(them["full_name"], "Jamie Rivera")
        self.assertEqual(them["avatar"], "s.jpg")
        first, second = merged["messages"]
        self.assertEqual(first["sender"]["name"], "Jamie Rivera")
        self.assertEqual(first["reply_to"]["sender"], "Jamie Rivera")
        self.assertEqual(first["reactions"][0]["by"], "Jamie Rivera")
        self.assertEqual(second["sender"]["name"], "Jamie Rivera")

    def test_deleted_account_keeps_the_scraped_name(self):
        export = self.export_side([])
        export["participants"][0]["full_name"] = "Instagram User"
        merged = merge_chats([scraped_chat([scraped_message(1, "a")]), export], names_from_second=True)
        self.assertEqual(next(p for p in merged["participants"] if not p["is_me"])["full_name"], "Jamie")

    def test_new_group_member_is_added(self):
        scraped = scraped_chat([scraped_message(1, "a")])
        export = self.export_side([])
        export["participants"].append({"fbid": "", "igid": "n:Bob", "username": "", "full_name": "Bob", "is_me": False})
        merged = merge_chats([scraped, export])
        self.assertIn("Bob", [p["full_name"] for p in merged["participants"]])


class TestFullImport(unittest.TestCase):
    """A small export zip, end to end: importer + builder."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.original_root = accounts.ROOT
        accounts.ROOT = os.path.join(self.tmp.name, "accounts")
        self.addCleanup(lambda: setattr(accounts, "ROOT", self.original_root))

        self.zip_path = os.path.join(self.tmp.name, "instagram-_tester-2026-01-02-AbC.zip")
        inbox = "your_instagram_activity/messages/inbox/bob_111/"
        request = "your_instagram_activity/messages/message_requests/eve_222/"
        with zipfile.ZipFile(self.zip_path, "w") as z:
            z.writestr("personal_information/personal_information/personal_information.json", json.dumps({"profile_user": [{"string_map_data": {"Username": {"value": "_tester"}, "Name": {"value": "TeÃ©"}}, "media_map_data": {"Profile Photo": {"uri": "media/other/me.jpg"}}}]}))
            z.writestr("media/other/me.jpg", b"\xff\xd8\xff\xe0")
            z.writestr("media/other/s1.mp4", b"\x00\x00\x00\x18ftypmp42")
            z.writestr(inbox + "photos/p.jpg", b"\xff\xd8\xff\xe0")
            z.writestr(inbox + "message_1.json", json.dumps({"participants": [{"name": "Bob"}, {"name": "TeÃ©"}], "title": "Bob", "is_still_participant": True, "messages": [
                {"sender_name": "Bob", "timestamp_ms": 1767225600000, "content": "newest"},
                {"sender_name": "TeÃ©", "timestamp_ms": 1767225500000, "photos": [{"uri": inbox + "photos/p.jpg"}]},
            ]}))
            z.writestr(inbox + "message_2.json", json.dumps({"participants": [{"name": "Bob"}, {"name": "TeÃ©"}], "title": "Bob", "messages": [
                {"sender_name": "Bob", "timestamp_ms": 1767225400000, "content": "oldest"},
            ]}))
            z.writestr(request + "message_1.json", json.dumps({"participants": [{"name": "Eve"}, {"name": "TeÃ©"}], "title": "Eve", "is_pending": True, "messages": [{"sender_name": "Eve", "timestamp_ms": 1767225000000, "content": "hey"}]}))
            z.writestr("your_instagram_activity/media/stories.json", json.dumps({"ig_stories": [{"uri": "media/other/s1.mp4", "creation_timestamp": 1767225000, "title": "cap"}]}))
            z.writestr("connections/followers_and_following/followers_1.json", json.dumps([{"title": "", "string_list_data": [{"href": "https://www.instagram.com/bob", "value": "bob", "timestamp": 1}]}]))
            z.writestr("connections/followers_and_following/following.json", json.dumps({"relationships_following": [{"title": "bob", "string_list_data": [{"href": "https://www.instagram.com/_u/bob", "timestamp": 1}]}]}))
            z.writestr("connections/followers_and_following/close_friends.json", json.dumps({"timestamp": 1, "label_values": [{"label": "Name", "value": "Bob"}, {"label": "Username", "value": "bob"}]}))

    def data_file(self, account, name):
        with open(os.path.join(account.dir, "_archive", "data", name), encoding="utf-8") as f:
            text = f.read()
        return json.loads(text[text.index("(") + 1: text.rindex(")")].split(",", 1)[1]) if name.startswith("t_") else json.loads(text[text.index("(") + 1: text.rindex(")")])

    def test_import_and_build(self):
        account, totals = import_export.import_export([self.zip_path])
        self.assertEqual(account.name, "tester")
        self.assertEqual(account.info["username"], "_tester")
        self.assertEqual(account.info["full_name"], "Teé")
        self.assertEqual((totals["chats"], totals["requests"], totals["messages"], totals["stories"]), (2, 1, 4, 1))
        self.assertEqual((totals["followers"], totals["following"], totals["close_friends"]), (1, 1, 1))
        self.assertEqual(os.path.basename(account.sources[0].root), "2026-01-02-AbC")

        build_archive.build_account(account)
        inbox = self.data_file(account, "threads.js")
        self.assertEqual(inbox["me"]["username"], "_tester")
        self.assertEqual(inbox["me"]["avatar"], "exports/2026-01-02-AbC/raw/media/other/me.jpg")
        self.assertEqual([t["title"] for t in inbox["threads"]], ["Bob", "Eve"])
        self.assertTrue(inbox["threads"][1]["request"])
        self.assertEqual(inbox["threads"][0]["sources"], ["export"])

        chat = self.data_file(account, "t_111.js")
        self.assertEqual([m.get("text") for m in chat["messages"]], ["oldest", None, "newest"])
        photo = chat["messages"][1]["att"][0]
        self.assertEqual(photo[1], "exports/2026-01-02-AbC/raw/" + "your_instagram_activity/messages/inbox/bob_111/photos/p.jpg")
        self.assertTrue(os.path.exists(os.path.join(account.dir, photo[1])))

        stories = self.data_file(account, "stories.js")
        self.assertEqual(stories["archive"][0]["stories"][0]["file"], "exports/2026-01-02-AbC/raw/media/other/s1.mp4")
        self.assertEqual(stories["archive"][0]["stories"][0]["caption"], "cap")
        people = self.data_file(account, "people.js")
        self.assertEqual(people["close_friends"][0]["full_name"], "Bob")

    def test_reimport_is_idempotent(self):
        import_export.import_export([self.zip_path])
        account, totals = import_export.import_export([self.zip_path])
        self.assertEqual(totals["messages"], 4)
        self.assertEqual(len(account.sources), 1)

    def test_refuses_another_users_folder(self):
        accounts.named("tester").update(username="someone_else")
        with self.assertRaises(SystemExit):
            import_export.import_export([self.zip_path])
        with self.assertRaises(SystemExit):
            import_export.import_export([self.zip_path], "tester")

    def test_html_export_gets_a_clear_message(self):
        path = os.path.join(self.tmp.name, "instagram-_tester-2026-01-02-Html.zip")
        with zipfile.ZipFile(path, "w") as z:
            z.writestr("your_instagram_activity/messages/inbox/bob_111/message_1.html", "<html></html>")
        with self.assertRaises(SystemExit) as caught:
            import_export.import_export([path])
        self.assertIn("HTML", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
