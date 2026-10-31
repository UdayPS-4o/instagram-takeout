"""One folder per Instagram account:

    accounts/<name>/
        account.json   {"name", "username", "full_name", ...}
        index.html     the offline viewer for this account (+ _archive/)
        chats/         one folder per DM thread, scraped (import_scraped.py)
        stories/       story archive + highlights, scraped
        people/        followers / following / blocked, scraped
        exports/<id>/  one official Instagram export (import_export.py): raw/ + chats/, stories/, people/ in the same format as above

Scripts take -a/--account <name>. Without it the account is found from the username inside the export,
so -a is only needed to pick another folder name.
"""
import json
import os
import re

ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "accounts")


class Source:
    """One place an account's data comes from. Scraped data and every imported export share the chats/stories/people layout."""

    def __init__(self, kind: str, root: str, label: str):
        self.kind = kind  # "scraped" or "export"
        self.root = root
        self.label = label
        self.chats = os.path.join(root, "chats")
        self.stories = os.path.join(root, "stories")
        self.people = os.path.join(root, "people")


class Account:
    def __init__(self, name: str):
        self.name = name
        self.dir = os.path.join(ROOT, name)
        self.exports = os.path.join(self.dir, "exports")
        self.info_path = os.path.join(self.dir, "account.json")

    @property
    def info(self) -> dict:
        if not os.path.exists(self.info_path):
            return {"name": self.name}
        with open(self.info_path, encoding="utf-8") as f:
            return json.load(f)

    @property
    def sources(self) -> list[Source]:
        """Scraped data first (it holds the most detail per message), then the exports, newest first."""
        found = []
        scraped = Source("scraped", self.dir, "Scraped")
        if any(os.path.isdir(path) for path in (scraped.chats, scraped.stories, scraped.people)):
            found.append(scraped)
        if os.path.isdir(self.exports):
            for name in sorted(os.listdir(self.exports), reverse=True):
                root = os.path.join(self.exports, name)
                if os.path.exists(os.path.join(root, "export.json")):
                    found.append(Source("export", root, "Official export " + name[:10]))
        return found

    def update(self, **fields):
        """Records what we know about the account (username, full name). Empty values never overwrite."""
        info = self.info
        changed = False
        for key, value in fields.items():
            if value and info.get(key) != value:
                info[key] = value
                changed = True
        if changed or not os.path.exists(self.info_path):
            os.makedirs(self.dir, exist_ok=True)
            info["name"] = self.name
            with open(self.info_path, "w", encoding="utf-8") as f:
                json.dump(info, f, ensure_ascii=False, indent=1)


def all_accounts() -> list[Account]:
    if not os.path.isdir(ROOT):
        return []
    return [Account(name) for name in sorted(os.listdir(ROOT)) if os.path.isdir(os.path.join(ROOT, name)) and not name.startswith((".", "_"))]


def named(name: str) -> Account:
    if not re.fullmatch(r"[\w.\- ]+", name, flags=re.UNICODE):
        raise SystemExit(f"Account name '{name}' can only contain letters, digits, '.', '-', '_' and spaces")
    return Account(name)


def for_username(username: str | None, name: str | None = None) -> Account:
    """The account folder for an export. Refuses to mix accounts: an export of another user than the folder's is an error."""
    if name:
        account = named(name)
        known = account.info.get("username")
        if username and known and known.lower() != username.lower():
            raise SystemExit(f"accounts/{name} belongs to @{known}, but this export is of @{username}. Use another -a name for it.")
        return account

    if not username:
        raise SystemExit("The export doesn't say which account it is from. Pass -a <name> to choose the account folder.")
    for account in all_accounts():
        if (account.info.get("username") or "").lower() == username.lower():
            return account

    account = named(username.strip("._") or username)
    known = account.info.get("username")
    if known:  # a folder of that name holds another user
        raise SystemExit(f"accounts/{account.name} belongs to @{known}, but this export is of @{username}. Pass -a <name> to choose another folder.")
    return account
