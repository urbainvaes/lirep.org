#!/usr/bin/env python3
"""Rewrite a local branch's commit dates and Claude co-author trailers.

The day comes from each commit's committer date in its recorded timezone.
Commits on each day receive consecutive minutes from midnight in oldest-first
topological order. Both author and committer timestamps use that date and time,
retaining each identity's original timezone offset.

By default this is a dry run. Use --apply to rewrite the selected local branch.
Only commits reachable from that branch are changed; no remote is contacted.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
import re
import subprocess
import sys


IDENTITY_RE = re.compile(rb"^(author|committer) (.*) (-?[0-9]+) ([+-][0-9]{4})$")
NAME_EMAIL_RE = re.compile(rb"^(.*) <([^<>]*)>$")
CLAUDE_COAUTHOR_RE = re.compile(rb"(?i)^Co-Authored-By:.*Claude.*$")


class RewriteError(Exception):
    """An input history cannot be safely rewritten."""


@dataclass
class Identity:
    header_index: int
    kind: bytes
    name_email: bytes
    timestamp: int
    offset_text: bytes
    offset_minutes: int


@dataclass
class Commit:
    oid: str
    header_lines: list[bytes]
    message: bytes
    parents: list[str]
    identities: dict[bytes, Identity]
    day: date
    minute_of_day: int = 0
    removed_trailers: int = 0


def git(*args: str, input_bytes: bytes | None = None) -> bytes:
    result = subprocess.run(
        ["git", *args],
        input=input_bytes,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode:
        detail = result.stderr.decode(errors="replace").strip()
        raise RewriteError(f"git {' '.join(args)} failed: {detail}")
    return result.stdout


def resolve_local_branch(ref: str) -> tuple[str, str]:
    if ref == "HEAD":
        try:
            full_ref = git("symbolic-ref", "--quiet", "HEAD").decode().strip()
        except RewriteError as error:
            raise RewriteError("HEAD is detached; pass a local branch with --ref") from error
    else:
        full_ref = git("rev-parse", "--symbolic-full-name", "--verify", ref).decode().strip()

    if not full_ref.startswith("refs/heads/"):
        raise RewriteError(f"{ref!r} does not resolve to a local branch")
    tip = git("rev-parse", "--verify", f"{full_ref}^{{commit}}").decode().strip()
    return full_ref, tip


def parse_offset(offset: bytes) -> int:
    if len(offset) != 5 or offset[:1] not in (b"+", b"-"):
        raise RewriteError(f"Invalid timezone offset in commit: {offset!r}")
    hours, minutes = int(offset[1:3]), int(offset[3:5])
    if hours > 23 or minutes > 59:
        raise RewriteError(f"Invalid timezone offset in commit: {offset!r}")
    sign = 1 if offset[:1] == b"+" else -1
    return sign * (hours * 60 + minutes)


def parse_identity(line: bytes, index: int) -> Identity:
    match = IDENTITY_RE.fullmatch(line)
    if not match:
        raise RewriteError(f"Cannot parse commit identity: {line!r}")
    offset_minutes = parse_offset(match.group(4))
    return Identity(
        header_index=index,
        kind=match.group(1),
        name_email=match.group(2),
        timestamp=int(match.group(3)),
        offset_text=match.group(4),
        offset_minutes=offset_minutes,
    )


def parse_commit(oid: str) -> Commit:
    raw = git("cat-file", "commit", oid)
    header, separator, message = raw.partition(b"\n\n")
    if not separator:
        raise RewriteError(f"Commit {oid} has no message separator")

    header_lines = header.split(b"\n")
    if any(
        line.startswith((b"gpgsig ", b"gpgsig-sha256 ", b"mergetag "))
        for line in header_lines
    ):
        raise RewriteError(
            f"Commit {oid} has a signature/mergetag; rewriting would invalidate it"
        )

    parents = [line[7:].decode() for line in header_lines if line.startswith(b"parent ")]
    identities: dict[bytes, Identity] = {}
    for index, line in enumerate(header_lines):
        if line.startswith((b"author ", b"committer ")):
            identity = parse_identity(line, index)
            if identity.kind in identities:
                raise RewriteError(
                    f"Commit {oid} has duplicate {identity.kind.decode()} headers"
                )
            identities[identity.kind] = identity
    if set(identities) != {b"author", b"committer"}:
        raise RewriteError(f"Commit {oid} is missing an author or committer header")

    committer = identities[b"committer"]
    commit_zone = timezone(timedelta(minutes=committer.offset_minutes))
    try:
        commit_day = datetime.fromtimestamp(committer.timestamp, commit_zone).date()
    except (OverflowError, OSError, ValueError) as error:
        raise RewriteError(f"Commit {oid} has an unsupported timestamp") from error

    return Commit(
        oid=oid,
        header_lines=header_lines,
        message=message,
        parents=parents,
        identities=identities,
        day=commit_day,
    )


def remove_claude_trailers(message: bytes) -> tuple[bytes, int]:
    lines = message.splitlines(keepends=True)
    kept: list[bytes] = []
    removed = 0
    for line in lines:
        if CLAUDE_COAUTHOR_RE.fullmatch(line.rstrip(b"\r\n")):
            removed += 1
        else:
            kept.append(line)

    if removed:
        cleaned = b"".join(kept).rstrip(b"\r\n") + b"\n"
        return cleaned, removed
    return message, 0


def set_email(name_email: bytes, email: str) -> bytes:
    match = NAME_EMAIL_RE.fullmatch(name_email)
    if not match:
        raise RewriteError(f"Cannot set email on identity: {name_email!r}")
    return match.group(1) + b" <" + email.encode() + b">"


def timestamp_for(day: date, minute_of_day: int, offset_minutes: int) -> int:
    zone = timezone(timedelta(minutes=offset_minutes))
    local_time = datetime.combine(
        day,
        time(hour=minute_of_day // 60, minute=minute_of_day % 60),
        tzinfo=zone,
    )
    return int(local_time.timestamp())


def rewritten_object(commit: Commit, parent_map: dict[str, str], email: str | None) -> bytes:
    lines = commit.header_lines.copy()
    for index, line in enumerate(lines):
        if line.startswith(b"parent "):
            old_parent = line[7:].decode()
            if old_parent not in parent_map:
                raise RewriteError(
                    f"Parent {old_parent} of {commit.oid} was not processed first"
                )
            lines[index] = b"parent " + parent_map[old_parent].encode()

    for identity in commit.identities.values():
        name_email = identity.name_email
        if email is not None:
            name_email = set_email(name_email, email)
        stamp = timestamp_for(commit.day, commit.minute_of_day, identity.offset_minutes)
        lines[identity.header_index] = (
            identity.kind
            + b" "
            + name_email
            + b" "
            + str(stamp).encode()
            + b" "
            + identity.offset_text
        )

    message, removed = remove_claude_trailers(commit.message)
    if removed != commit.removed_trailers:
        raise RewriteError(f"Claude trailer count changed while processing {commit.oid}")
    return b"\n".join(lines) + b"\n\n" + message


def format_minute(minute_of_day: int) -> str:
    return f"{minute_of_day // 60:02d}:{minute_of_day % 60:02d}"


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Remove Claude co-author trailers and set commit times to consecutive "
            "minutes from midnight for each committer-local day."
        ),
        epilog=(
            "Dry-run is the default. --apply rewrites only the selected local branch; "
            "it does not push. Rewritten commits receive new hashes."
        ),
    )
    parser.add_argument(
        "--ref",
        default="HEAD",
        help="local branch to rewrite (default: current branch)",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="write replacement commits and move the selected local branch",
    )
    parser.add_argument(
        "--email",
        help="also set every author and committer email on this branch to EMAIL",
    )
    args = parser.parse_args()

    if args.email and (
        any(char.isspace() for char in args.email)
        or "<" in args.email
        or ">" in args.email
    ):
        raise RewriteError("--email must be a single email address")
    if args.apply and git("rev-parse", "--is-shallow-repository").strip() == b"true":
        raise RewriteError("Cannot rewrite all history in a shallow repository")

    branch, old_tip = resolve_local_branch(args.ref)
    if args.apply and git("status", "--porcelain=v1"):
        raise RewriteError(
            "Working tree is not clean; commit or stash changes before --apply"
        )

    commit_ids = git("rev-list", "--reverse", "--topo-order", old_tip).decode().splitlines()
    if not commit_ids:
        raise RewriteError(f"No commits found for {branch}")

    commits: list[Commit] = []
    seen: set[str] = set()
    per_day: dict[date, int] = defaultdict(int)
    total_trailers = 0
    for oid in commit_ids:
        commit = parse_commit(oid)
        if any(parent not in seen for parent in commit.parents):
            raise RewriteError(f"Commit walk was not topological at {oid}")
        commit.minute_of_day = per_day[commit.day]
        if commit.minute_of_day >= 24 * 60:
            raise RewriteError(
                f"More than 1,440 commits on {commit.day}; cannot fit in that day"
            )
        per_day[commit.day] += 1
        _cleaned_message, commit.removed_trailers = remove_claude_trailers(commit.message)
        total_trailers += commit.removed_trailers
        commits.append(commit)
        seen.add(oid)

    print(f"Branch: {branch} ({old_tip})")
    print(f"Commits reachable: {len(commits)}")
    for day in sorted(per_day):
        count = per_day[day]
        last = format_minute(count - 1)
        print(f"  {day}: {count} commit(s), {format_minute(0)}–{last}")
    print(f"Claude co-author trailers to remove: {total_trailers}")
    if args.email:
        print(f"Author and committer emails to set: {args.email}")

    if not args.apply:
        print("Dry run only; pass --apply to rewrite this local branch.")
        return 0

    parent_map: dict[str, str] = {}
    for commit in commits:
        raw = rewritten_object(commit, parent_map, args.email)
        new_oid = git("hash-object", "-t", "commit", "-w", "--stdin", input_bytes=raw)
        parent_map[commit.oid] = new_oid.decode().strip()

    new_tip = parent_map[old_tip]
    git(
        "update-ref",
        "-m",
        "rewrite commit dates and Claude co-author trailers",
        branch,
        new_tip,
        old_tip,
    )
    print(f"Updated {branch}: {old_tip} -> {new_tip}")
    print("No remote was contacted or pushed.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RewriteError as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
