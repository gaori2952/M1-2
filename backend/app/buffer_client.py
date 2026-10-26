"""Fixed, read-only Buffer queries. Never accept GraphQL or URLs from the browser."""

import json
import math
import urllib.error
import urllib.request
from datetime import datetime
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo


class BufferError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def https_url(value):
    if not isinstance(value, str) or len(value) > 8000:
        return ""
    try:
        u = urlsplit(value)
        return (
            value
            if u.scheme == "https" and u.hostname and not u.username and not u.password
            else ""
        )
    except ValueError:
        return ""


def timestamp(value):
    if value is None:
        return None
    try:
        d = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if not d.tzinfo:
            raise ValueError
        return d.isoformat()
    except (ValueError, TypeError, AttributeError):
        raise BufferError("invalid_timestamp") from None


def normalize_post(raw):
    if not isinstance(raw.get("id"), str) or not 0 < len(raw["id"]) <= 200:
        raise BufferError("invalid_post")
    if raw.get("status") not in {
        "sent",
        "draft",
        "error",
        "scheduled",
        "sending",
        "needs_approval",
    }:
        raise BufferError("invalid_post")
    text = raw.get("text") or ""
    if not isinstance(text, str) or len(text) > 100000:
        raise BufferError("invalid_post")
    assets = raw.get("assets") or []
    if len(assets) > 100:
        raise BufferError("invalid_assets")
    assets = [
        {
            "type": a.get("type"),
            "mime_type": a.get("mimeType"),
            "source": https_url(a.get("source")),
            "thumbnail": https_url(a.get("thumbnail")),
        }
        for a in assets
    ]
    kind = (raw.get("metadata") or {}).get("type", "unknown")
    if kind == "post" and len(assets) > 1:
        kind = "carousel"
    metrics = {}
    known = {
        "follows",
        "reach",
        "views",
        "reactions",
        "comments",
        "saves",
        "shares",
        "averageTimeWatched",
        "totalTimeWatched",
        "engagementRate",
    }
    raw_metrics = raw.get("metrics") or []
    for m in raw_metrics:
        key, value = m.get("type"), m.get("value")
        if key not in known:
            continue
        unit = "percentage" if key == "engagementRate" else "count"
        if m.get("unit") != unit:
            raise BufferError("invalid_metric_unit")
        if value is not None and (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
            or not 0 <= value <= 10**15
        ):
            raise BufferError("invalid_metric")
        if (
            key in {"follows", "reach", "views", "reactions", "comments", "saves", "shares"}
            and value is not None
            and int(value) != value
        ):
            raise BufferError("invalid_metric")
        metrics[key] = value
    return {
        "id": raw["id"],
        "text": text,
        "status": raw["status"],
        "format": kind,
        "sent_at": timestamp(raw.get("sentAt")),
        "due_at": timestamp(raw.get("dueAt")),
        "metrics_updated_at": timestamp(raw.get("metricsUpdatedAt")),
        "external_link": https_url(raw.get("externalLink")),
        "assets": assets,
        "tags": [str(t.get("name", ""))[:100] for t in raw.get("tags") or []],
        "metrics": metrics,
        "raw_metrics": raw_metrics,
    }


CHANNELS = """query ChannelsRead($input:ChannelsInput!){ channels(input:$input) {
 id name displayName service timezone isDisconnected isLocked isQueuePaused postingSchedule {day paused times}
} }"""
POSTS = """query PostsRead($input:PostsInput!,$after:String){posts(first:100,after:$after,input:$input){
 edges{node{id channelId text status sentAt dueAt externalLink metricsUpdatedAt
 assets{type mimeType source thumbnail} metadata{... on InstagramPostMetadata{type}}
 tags{name} metrics{type name value unit}}} pageInfo{hasNextPage endCursor}}}"""


class BufferClient:
    def __init__(self, settings, *, transport=None):
        self.settings = settings
        self.transport = transport or self._request

    def _request(self, query, variables):
        req = urllib.request.Request(
            "https://api.buffer.com",
            data=json.dumps({"query": query, "variables": variables}).encode(),
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer " + self.settings.buffer_api_key,
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as response:
                payload = response.read(16 * 1024 * 1024 + 1)
            if len(payload) > 16 * 1024 * 1024:
                raise BufferError("response_too_large")
            result = json.loads(payload)
            if result.get("errors") or not isinstance(result.get("data"), dict):
                raise BufferError("graphql_error")
            return result["data"]
        except urllib.error.HTTPError as e:
            raise BufferError(
                {401: "key_invalid", 403: "permission_denied", 429: "rate_limited"}.get(
                    e.code, "upstream_unavailable"
                )
            ) from None
        except (OSError, ValueError):
            raise BufferError("upstream_unavailable") from None

    def fetch(self):
        if not self.settings.buffer_api_key or not self.settings.buffer_channel_id:
            raise BufferError("not_configured")
        try:
            orgs = self.transport("query AccountRead { account { organizations { id } } }", {})[
                "account"
            ]["organizations"]
            channels = []
            for org in orgs:
                channels.extend(
                    (c, org["id"])
                    for c in self.transport(CHANNELS, {"input": {"organizationId": org["id"]}})[
                        "channels"
                    ]
                )
            match = next(
                (
                    (c, o)
                    for c, o in channels
                    if c["id"] == self.settings.buffer_channel_id and c["service"] == "instagram"
                ),
                None,
            )
            if not match:
                raise BufferError("channel_not_owned")
            channel, org = match
            ZoneInfo(channel["timezone"])
            posts, seen_cursors, cursor, raw_count = {}, set(), None, 0
            for _ in range(21):
                page = self.transport(
                    POSTS,
                    {
                        "input": {"organizationId": org, "filter": {"channelIds": [channel["id"]]}},
                        "after": cursor,
                    },
                )["posts"]
                raw_count += len(page["edges"])
                if raw_count > 2000:
                    raise BufferError("post_limit")
                for edge in page["edges"]:
                    raw = edge["node"]
                    if raw["channelId"] != channel["id"]:
                        raise BufferError("channel_mismatch")
                    posts[raw["id"]] = normalize_post(raw)
                if page["pageInfo"]["hasNextPage"] is False:
                    return {"channel": channel, "posts": list(posts.values())}
                cursor = page["pageInfo"]["endCursor"]
                if not cursor or cursor in seen_cursors:
                    raise BufferError("invalid_cursor")
                seen_cursors.add(cursor)
            raise BufferError("post_limit")
        except (KeyError, TypeError, ValueError):
            raise BufferError("invalid_response") from None
