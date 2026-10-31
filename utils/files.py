import os
import shutil


def link_or_copy(source: str, target: str) -> str:
    """Hard-links a media file so it doesn't take disk space twice and survives the original being deleted. Falls back to a copy across drives."""
    try:
        os.link(source, target)
    except OSError:
        shutil.copy2(source, target)
    return target
