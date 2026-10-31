# Data format

The viewer reads one simple JSON format. The official-export importer writes it, and so can any scraper. Each account is a folder under `accounts/`:

```
accounts/<name>/
  account.json                          {"username": "...", "full_name": "...", "user_id": "..."}
  chats/<threadid>_<title>/chat.json    one folder per conversation, media under media/ next to it
  stories/stories.json
  people/people.json
  exports/<id>/{chats,stories,people}/  the same three, one set per imported official export
```

File names inside the JSON are paths relative to the folder that holds the JSON file.

## chat.json

```jsonc
{
  "thread": {
    "folder": "1001_Jamie Rivera",
    "title": "Jamie Rivera",
    "is_group": false,
    "request": false,            // a message request that was never accepted
    "left": false,               // you are no longer in this group
    "image": null,               // group photo
    "message_count": 12,
    "first_message": "2026-09-22T20:01:00",
    "last_message": "2026-09-24T21:40:00"
  },
  "participants": [
    {"fbid": "", "igid": "123", "username": "jamie.rivera", "full_name": "Jamie Rivera", "avatar": null, "is_me": false}
  ],
  "messages": [                  // oldest first
    {
      "id": "mid.$abc",          // any string, unique within the chat
      "timestamp": "2026-09-24T21:40:00",
      "timestamp_ms": 1790000000000,   // the key used to match a message across sources
      "sender": {"name": "Jamie Rivera", "username": "jamie.rivera", "igid": "123", "fbid": "", "is_me": false},
      "type": "TEXT",            // TEXT, IMAGES, VIDEOS, AUDIOS, GIFS, FILES, MESSAGE_INLINE_SHARE, MONTAGE_SHARE_XMA, ...
      "text": "ok that is a great idea",
      "activity": null,          // a system line such as "You started a video chat"
      "activity_kind": null,     // "event" or "reaction"
      "forwarded": false,
      "edits": [],
      "reply_to": null,          // {"id", "sender", "type", "text"}
      "reactions": [{"emoji": "❤", "by": "You"}],
      "attachments": [{"kind": "image", "file": "media/a.jpg"}],   // kind: image, video, audio, thumbnail, file
      "shared": null,            // a shared reel, post, story or profile, see below
      "unavailable": null        // "Unsent" and similar
    }
  ]
}
```

`shared` holds `{"kind", "decoration", "account", "caption", "note", "eyebrow", "link", "is_reply_to_story"}`. `decoration` is `"REEL"` for reels, and `kind` is `"profile"` for a shared profile or `"story"` for a story reply. A thumbnail of the share goes in `attachments` with kind `"thumbnail"`.

## stories.json

```jsonc
{
  "generated": "2026-10-31T12:00:00",
  "account": {"username": "alex_demo", "full_name": "Alex Demo"},
  "archive": [
    {"id": "2026-09-24", "date": "2026-09-24", "stories": [
      {"pk": "s0", "taken_at": 1790000000, "time": "2026-09-24T07:30:00", "type": "photo",   // or "video"
       "close_friends": false, "caption": "Lake trail", "file": "media/s0.jpg", "thumb": null,
       "mentions": [], "shared_media": [], "stickers": []}
    ]}
  ],
  "highlights": []
}
```

## people.json

```jsonc
{
  "generated": "2026-10-31T12:00:00",
  "account": {"username": "alex_demo", "full_name": "Alex Demo"},
  "followers":      [{"pk": "jamie.rivera", "username": "jamie.rivera", "full_name": "", "note": ""}],
  "following":      [],
  "blocked":        [],
  "close_friends":  [],
  "close_friends_count": 0
}
```

## Merging

When an account has several sources (scraped data and any number of imported exports), `build_archive.py` merges them: chats by thread id, messages by `timestamp_ms`, stories by `taken_at`. See `utils/merge.py` for the exact rules.
