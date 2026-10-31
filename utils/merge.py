"""Merges what several sources know about the same thing: chats from a scrape and from official exports share thread ids and exact message timestamps.

The first chat is the base. A message found in both keeps the base's fields and only takes what the base is missing
(scraped reels have a thumbnail but no caption, exports have the caption but no thumbnail). Everything found in just one source is kept.
"""
import unicodedata

DELETED_ACCOUNT = "instagram user"  # exports call every deactivated account this; the name in a scrape is better


def person_key(person: dict) -> str:
    return person.get("fbid") or person.get("igid") or ""


def same_name(value: str | None) -> str:
    return unicodedata.normalize("NFKC", value or "").casefold().strip()


def match_people(base: list[dict], other: list[dict], renames: dict[str, str] | None = None) -> dict[str, dict]:
    """other's person key -> the participant in base. People base doesn't know are added to it.
    With renames (a dict to fill, old name -> new), other holds the current display names and they replace the ones in base."""
    me = next((p for p in base if p.get("is_me")), None)
    by_name: dict[str, dict] = {}

    def remember(person: dict):
        for value in (person.get("full_name"), person.get("username")):
            if value:
                by_name.setdefault(same_name(value), person)

    for person in base:
        remember(person)

    # with one other person on both sides it has to be the same person, whatever name they use now
    base_others = [p for p in base if not p.get("is_me")]
    other_others = [p for p in other if not p.get("is_me")]
    only = base_others[0] if len(base_others) == 1 and len(other_others) == 1 else None

    mapping = {}
    for person in other:
        if person.get("is_me"):
            found = me
        else:
            found = only or by_name.get(same_name(person.get("full_name"))) or by_name.get(same_name(person.get("username")))
        if found is None:
            base.append(person)
            remember(person)
            if person.get("is_me"):
                me = person
            found = person
        else:
            name = person.get("full_name")
            if renames is not None and name and found.get("full_name") and same_name(name) != same_name(found["full_name"]) and same_name(name) != DELETED_ACCOUNT:
                renames[found["full_name"]] = name
                found["full_name"] = name
            for field in ("username", "full_name", "avatar"):
                if person.get(field) and not found.get(field):
                    found[field] = person[field]
        mapping[person_key(person)] = found
    return mapping


def apply_renames(chat: dict, renames: dict[str, str]):
    """Names are also stored as plain text on messages: the viewer compares them with the participants."""
    for message in chat["messages"]:
        sender = message["sender"]
        sender["name"] = renames.get(sender.get("name"), sender.get("name"))
        reply = message.get("reply_to")
        if reply:
            reply["sender"] = renames.get(reply.get("sender"), reply.get("sender"))
        for reaction in message.get("reactions") or []:
            reaction["by"] = renames.get(reaction.get("by"), reaction.get("by"))


def sender_of(person: dict) -> dict:
    return {
        "name": "You" if person.get("is_me") else (person.get("full_name") or person.get("username") or "Instagram user"),
        "username": person.get("username") or "",
        "igid": person.get("igid") or "",
        "fbid": person.get("fbid") or "",
        "is_me": bool(person.get("is_me")),
    }


def fill_message(base: dict, other: dict):
    if not base.get("text") and not base.get("activity"):
        if other.get("text"):
            base["text"] = other["text"]
        elif other.get("activity"):
            base["activity"], base["activity_kind"] = other["activity"], other.get("activity_kind")
    if not base.get("attachments") and other.get("attachments"):
        base["attachments"] = other["attachments"]
    if other.get("shared"):
        if base.get("shared"):
            for field, value in other["shared"].items():
                if value and not base["shared"].get(field):
                    base["shared"][field] = value
        else:
            base["shared"] = other["shared"]
    seen = {(r.get("emoji"), r.get("by")) for r in base.get("reactions") or []}
    for reaction in other.get("reactions") or []:
        if (reaction.get("emoji"), reaction.get("by")) not in seen:
            base.setdefault("reactions", []).append(reaction)


def merge_chat(base: dict, other: dict, current_names: bool = False) -> dict:
    renames: dict[str, str] | None = {} if current_names else None
    mapping = match_people(base["participants"], other["participants"], renames)
    if renames:
        apply_renames(base, renames)
    names = {}
    for person in other["participants"]:
        found = mapping[person_key(person)]
        for value in (person.get("full_name"), person.get("username")):
            if value:
                names[value] = sender_of(found)["name"]

    by_time: dict[int, list[dict]] = {}
    for message in base["messages"]:
        by_time.setdefault(message["timestamp_ms"], []).append(message)

    for message in other["messages"]:
        for reaction in message.get("reactions") or []:
            reaction["by"] = names.get(reaction.get("by"), reaction.get("by"))
        waiting = by_time.get(message["timestamp_ms"])
        if waiting:
            fill_message(waiting.pop(0), message)
            continue
        sender = mapping.get(person_key(message["sender"]))
        if sender:
            message["sender"] = sender_of(sender)
        base["messages"].append(message)

    base["messages"].sort(key=lambda m: m["timestamp_ms"])
    return base


def merge_chats(chats: list[dict], names_from_second: bool = False) -> dict:
    """The first chat is the base. names_from_second: the second one (the newest export after a scrape) knows what people are called now."""
    merged = chats[0]
    for number, other in enumerate(chats[1:]):
        merged = merge_chat(merged, other, current_names=names_from_second and number == 0)
    return merged
