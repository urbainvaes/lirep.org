"""The forum: bug reports, suggestions and other topics. Anyone can read;
signed-in players post under their Lichess username (there is no anonymous
posting, even for players who are anonymous on the leaderboards), or under
their pen name if they have one (see USER_ALIASES)."""

from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field, field_validator

from . import store
from .config import FORUM_ADMINS

router = APIRouter()

Category = Literal["bug", "suggestion", "other"]
MAX_TITLE = 120
MAX_BODY = 5000
# At most this many posts per player in RATE_WINDOW_MINUTES.
RATE_LIMIT = 10
RATE_WINDOW_MINUTES = 60


def _strip(value: str) -> str:
    return value.strip()


class TopicIn(BaseModel):
    category: Category
    title: str = Field(min_length=1, max_length=MAX_TITLE)
    body: str = Field(min_length=1, max_length=MAX_BODY)

    _strip_fields = field_validator("title", "body", mode="after")(_strip)


class PostIn(BaseModel):
    body: str = Field(min_length=1, max_length=MAX_BODY)

    _strip_body = field_validator("body", mode="after")(_strip)


def _viewer(request: Request) -> str | None:
    me = request.session.get("username")
    return me if me and request.session.get("access_token") else None


def _is_admin(username: str | None) -> bool:
    return username is not None and username.lower() in FORUM_ADMINS


def _require_poster(request: Request) -> str:
    """A signed-in, registered player under the rate limit."""
    me = _viewer(request)
    if not me or store.get_user(me) is None:
        raise HTTPException(status_code=401, detail="not authenticated")
    if store.count_recent_forum_posts(me, RATE_WINDOW_MINUTES) >= RATE_LIMIT:
        raise HTTPException(status_code=429, detail="Too many posts in the last hour. Please try again later.")
    return me


def _profiles(usernames: list[str]) -> dict[str, bool]:
    """Which authors have a public profile to link to: everyone but the
    players who chose to be anonymous (whose profiles are hidden) and
    deleted accounts."""
    anonymous = store.anonymous_usernames()
    return {name: name != store.DELETED_AUTHOR and name.lower() not in anonymous for name in usernames}


def _shown(username: str, aliases: dict[str, str]) -> str:
    return aliases.get(username.lower(), username)


@router.get("/api/forum/topics")
def topics(category: Category | None = None) -> list[dict]:
    found = store.list_forum_topics(category)
    profiles = _profiles([t["author"] for t in found] + [t["lastAuthor"] for t in found])
    aliases = store.user_aliases()
    for t in found:
        t["authorProfile"] = profiles[t["author"]]
        t["lastAuthorProfile"] = profiles[t["lastAuthor"]]
        t["author"] = _shown(t["author"], aliases)
        t["lastAuthor"] = _shown(t["lastAuthor"], aliases)
    return found


@router.get("/api/forum/topics/{topic_id}")
def topic(topic_id: int, request: Request) -> dict:
    found = store.get_forum_topic(topic_id)
    if found is None:
        raise HTTPException(status_code=404, detail="not found")
    me = _viewer(request)
    admin = _is_admin(me)
    profiles = _profiles([post["author"] for post in found["posts"]])
    aliases = store.user_aliases()
    for post in found["posts"]:
        post["canDelete"] = admin or (me is not None and post["author"].lower() == me.lower())
        post["authorProfile"] = profiles[post["author"]]
        post["author"] = _shown(post["author"], aliases)
    found["author"] = _shown(found["author"], aliases)
    return found


@router.post("/api/forum/topics")
def create_topic(payload: TopicIn, request: Request) -> dict:
    me = _require_poster(request)
    if not payload.title or not payload.body:
        raise HTTPException(status_code=422, detail="A title and a message are needed.")
    return {"id": store.create_forum_topic(me, payload.category, payload.title, payload.body)}


@router.post("/api/forum/topics/{topic_id}/posts")
def reply(topic_id: int, payload: PostIn, request: Request) -> dict:
    me = _require_poster(request)
    if not payload.body:
        raise HTTPException(status_code=422, detail="The message is empty.")
    post_id = store.add_forum_post(topic_id, me, payload.body)
    if post_id is None:
        raise HTTPException(status_code=404, detail="not found")
    return {"id": post_id}


@router.delete("/api/forum/posts/{post_id}")
def delete_post(post_id: int, request: Request) -> dict:
    """Authors delete their own posts, admins any; deleting a topic's first
    post deletes the whole topic."""
    me = _viewer(request)
    if not me:
        raise HTTPException(status_code=401, detail="not authenticated")
    post = store.get_forum_post(post_id)
    if post is None:
        raise HTTPException(status_code=404, detail="not found")
    if not (_is_admin(me) or post["author"].lower() == me.lower()):
        raise HTTPException(status_code=403, detail="not yours")
    store.delete_forum_post(post_id)
    return {"deletedTopic": post["first"]}
