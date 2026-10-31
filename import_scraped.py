"""Brings scraped accounts (the accounts/ folder of the DM scraper) into this project so the viewer can show them.

    python import_scraped.py "C:\\path\\to\\InstagramDMScraper\\accounts"             # every account in that folder
    python import_scraped.py "C:\\path\\to\\InstagramDMScraper\\accounts" -a demo     # just one

JSON and text files are copied. Media files are hard-linked: they don't take disk space twice, and they stay here if the
original folder is deleted. Running it again only picks up what is new. Then the viewer of each account is rebuilt.
"""
import io
import os
import shutil
import sys
from argparse import ArgumentParser

import build_archive
from utils import accounts
from utils.files import link_or_copy

if sys.stdout is not None and isinstance(sys.stdout, io.TextIOWrapper):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

SKIP_DIRS = {"_archive", "exports"}  # the old viewer build is generated again here; exports are imported on their own
SKIP_FILES = {"index.html", "PAUSE"}
TEXT_EXT = (".json", ".jsonl", ".log", ".txt", ".html")

parser = ArgumentParser()
parser.add_argument("folder", help="The scraper's accounts folder")
parser.add_argument("-a", "--account", help="Only this account")
parser.add_argument("--no-build", action="store_true", help="Don't rebuild the viewer afterwards")


def bring_file(source: str, target: str) -> bool:
    if os.path.exists(target):
        a, b = os.stat(source), os.stat(target)
        if a.st_size == b.st_size and int(a.st_mtime) == int(b.st_mtime):
            return False
        os.remove(target)
    if target.lower().endswith(TEXT_EXT):
        shutil.copy2(source, target)
    else:
        link_or_copy(source, target)
    return True


def bring_account(source_dir: str, account: accounts.Account) -> int:
    count = 0
    for folder, dirs, files in os.walk(source_dir):
        here = os.path.relpath(folder, source_dir)
        if here == ".":
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        target_dir = account.dir if here == "." else os.path.join(account.dir, here)
        os.makedirs(target_dir, exist_ok=True)
        for name in files:
            if name.endswith(".part") or (here == "." and name in SKIP_FILES):
                continue
            if bring_file(os.path.join(folder, name), os.path.join(target_dir, name)):
                count += 1
    return count


def main():
    args = parser.parse_args()
    root = os.path.abspath(args.folder)
    if not os.path.isdir(root):
        raise SystemExit(f"Not a folder: {root}")
    names = [args.account] if args.account else [n for n in sorted(os.listdir(root)) if os.path.isdir(os.path.join(root, n)) and not n.startswith((".", "_"))]
    if not names:
        raise SystemExit(f"No account folders in {root}")

    for name in names:
        source_dir = os.path.join(root, name)
        if not os.path.isdir(source_dir):
            raise SystemExit(f"No account folder {source_dir}")
        account = accounts.named(name)
        count = bring_account(source_dir, account)
        print(f"{name}: {count:,} files brought over -> {os.path.abspath(account.dir)}", flush=True)
        if not args.no_build:
            build_archive.build_account(account)

    if not args.no_build:
        build_archive.build_picker()


if __name__ == "__main__":
    main()
