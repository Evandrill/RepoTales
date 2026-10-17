# backend/services/github_service.py
from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from datetime import datetime, timezone
from typing import Any

import httpx
from pydantic import BaseModel
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

GITHUB_API = "https://api.github.com"

logger = logging.getLogger(__name__)

# Per-repo cache of enriched commits. GitHub quotas (60 req/h unauthenticated)
# and the N+1 stats fan-out make repeat generations of the same repo slow;
# `/saga/generate` is routinely called several times while judging.
_COMMIT_CACHE: dict[tuple[str, str, int, bool], tuple[float, list["CommitInfo"]]] = {}
_COMMIT_CACHE_MAX = 64

# Accepts: https://github.com/owner/repo(.git)(/) and the usual deep links
# people paste by accident (/tree/main, /blob/..., /commits, /issues...).
_GITHUB_URL_RE = re.compile(
    r"^\s*https?://(?:www\.)?github\.com/"
    r"(?P<owner>[A-Za-z0-9_.-]+)/"
    r"(?P<repo>[A-Za-z0-9_.-]+?)"
    r"(?:\.git)?"
    r"(?:/(?:tree|blob|commits|commit|pulls|issues|releases|actions|wiki)(?:/.*)?)?"
    r"/?\s*$",
    re.IGNORECASE,
)

_TRANSIENT_STATUS = {408, 409, 429, 500, 502, 503, 504}

# GitHub caps `per_page` at 100. The cap also bounds the N+1 detail fan-out.
MAX_COMMITS_PER_REQUEST = 50
_GITHUB_PER_PAGE_LIMIT = 100

_EPOCH_UTC = datetime(1970, 1, 1, tzinfo=timezone.utc)

# --------------------------------------------------------------------------- #
# Bot detection                                                               #
# --------------------------------------------------------------------------- #
# GitHub's own convention is an `[bot]` suffix on the login, and the REST API
# exposes `author.type == "Bot"` — those two are authoritative.
_BOT_SUFFIX_RE = re.compile(r"\[bot\]$", re.IGNORECASE)

# Fallback for accounts that are bots but are NOT flagged by GitHub. A bare
# substring search would be wrong: "abbott", "talbot" and "botanist" are real
# human handles. So a bot word only counts when it is its own token, delimited
# by start/end or a separator.
_BOT_TOKEN_RE = re.compile(
    r"(?:^|[-_.])(?:bots?|ci|cd|automation)(?:$|[-_.])", re.IGNORECASE
)

# High-volume automation whose login carries no bot marker at all.
_KNOWN_BOT_LOGINS = frozenset(
    {
        "dependabot",
        "renovate",
        "renovate-bot",
        "github-actions",
        "codecov",
        "codecov-io",
        "gitter-badger",
        "greenkeeper",
        "snyk-bot",
        "pre-commit-ci",
        "allcontributors",
        "mergify",
        "imgbot",
        "restyled-io",
        "copybara",
        "latest-changes",
        "pr-submit",
        "autofix-ci",
        "pyup-bot",
        "whitesource-bolt",
        "sonarcloud",
        "netlify",
        "vercel",
        "cla-assistant",
        "googlebot",
        "web-flow",
    }
)


def is_bot(login: str | None, author_type: str | None = None) -> bool:
    """Return True when a commit author is automation rather than a person.

    Order matters: the authoritative signals are checked first, so a bot that
    GitHub explicitly flags is caught even if its handle looks human.
    """
    if author_type and author_type.lower() == "bot":
        return True
    if not login:
        return False

    handle = login.lower()
    if handle.endswith("[bot]"):
        return True
    if handle in _KNOWN_BOT_LOGINS:
        return True
    # Strip the `[bot]` marker before the token test so "foo-bot[bot]" and
    # "foo-bot" are treated identically.
    stem = _BOT_SUFFIX_RE.sub("", handle)
    return bool(_BOT_TOKEN_RE.search(stem))



class GitHubServiceError(RuntimeError):
    """Raised on unrecoverable GitHub API / URL errors."""


class CommitInfo(BaseModel):
    sha: str
    short_sha: str
    message: str
    author_name: str
    author_email: str | None = None
    author_login: str | None = None
    author_type: str | None = None  # GitHub's "User" | "Bot" | "Organization"
    is_bot: bool = False
    authored_at: datetime
    html_url: str
    additions: int = 0
    deletions: int = 0
    total_changes: int = 0
    files_changed: int = 0


def parse_github_url(url: str) -> tuple[str, str]:
    """Return (owner, repo) from a GitHub URL, or raise GitHubServiceError."""
    match = _GITHUB_URL_RE.match(url or "")
    if not match:
        raise GitHubServiceError(
            f"URL de depot GitHub invalide : {url!r}. "
            "Format attendu : https://github.com/<owner>/<repo>"
        )
    return match.group("owner"), match.group("repo")


class GitHubService:
    """
    Async GitHub REST client tuned for RepoTales.

    - Fetches the N latest commits of a public or private repo.
    - Enriches each commit with additions/deletions/files_changed (N+1 calls,
      executed concurrently with a bounded semaphore).
    - Auto-retries transient 429/5xx with exponential backoff, then converts the
      final failure into a GitHubServiceError so callers only handle one type.
    """

    def __init__(
        self,
        token: str | None = None,
        *,
        timeout: float = 15.0,
        max_concurrency: int = 8,
    ) -> None:
        # Strip once: a whitespace-only value (easy copy/paste mistake) is
        # falsy for `/health` but would otherwise be sent as a malformed
        # `Authorization: Bearer` header and fail every request with 401.
        self._token = (token or os.getenv("GITHUB_TOKEN") or "").strip() or None
        self._timeout = timeout
        try:
            self._max_concurrency = max(
                1, int(os.getenv("GITHUB_MAX_CONCURRENCY", str(max_concurrency)))
            )
        except ValueError:
            self._max_concurrency = max_concurrency
        try:
            self._cache_ttl = max(0.0, float(os.getenv("GITHUB_CACHE_TTL", "300")))
        except ValueError:
            self._cache_ttl = 300.0
        try:
            self._stats_timeout = max(1.0, float(os.getenv("GITHUB_STATS_TIMEOUT", "12")))
        except ValueError:
            self._stats_timeout = 12.0
        self._sem = asyncio.Semaphore(self._max_concurrency)
        self._client: httpx.AsyncClient | None = None

    # ------------------------------------------------------------------ ctx
    def _headers(self) -> dict[str, str]:
        headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "RepoTales-Hackathon",
        }
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        return headers

    async def __aenter__(self) -> "GitHubService":
        self._client = httpx.AsyncClient(
            base_url=GITHUB_API,
            headers=self._headers(),
            timeout=self._timeout,
            # BUGFIX: httpx defaults to follow_redirects=False. GitHub answers
            # 301 Moved Permanently for any renamed/transferred repo (e.g.
            # tiangolo/fastapi -> fastapi/fastapi), so without this every
            # renamed repo failed with a confusing "unexpected payload".
            follow_redirects=True,
        )
        return self

    async def __aexit__(self, *_: Any) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    # ------------------------------------------------------------------ http
    async def _get(self, path: str, **params: Any) -> httpx.Response:
        """Fetch a path, with retries, exposing exactly one error type.

        BUGFIX: the retry decorator sat on a method that raised
        `httpx.HTTPStatusError` on its final attempt, and `reraise=True` let it
        escape `fetch_recent_commits`. Neither the router nor this class caught
        it, so a single flaky 503 from GitHub produced an unhandled HTTP 500
        instead of a clean 400/502.
        """
        try:
            return await self._get_with_retry(path, **params)
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            raise GitHubServiceError(
                f"GitHub a repondu {status} sur {path} apres plusieurs tentatives. "
                + _rate_limit_hint(status)
            ) from exc
        except httpx.TransportError as exc:
            raise GitHubServiceError(
                f"GitHub injoignable sur {path} : {type(exc).__name__}: {exc}"
            ) from exc

    @retry(
        stop=stop_after_attempt(4),
        wait=wait_exponential(multiplier=0.5, min=0.5, max=8),
        retry=retry_if_exception_type((httpx.TransportError, httpx.HTTPStatusError)),
        reraise=True,
    )
    async def _get_with_retry(self, path: str, **params: Any) -> httpx.Response:
        if self._client is None:
            raise GitHubServiceError(
                "GitHubService used outside of an `async with` block."
            )
        async with self._sem:
            resp = await self._client.get(path, params=params or None)

        # Retry only transient statuses; let 4xx (404, 401, 403) bubble up fast.
        if resp.status_code in _TRANSIENT_STATUS:
            raise httpx.HTTPStatusError(
                f"Transient GitHub error {resp.status_code}",
                request=resp.request,
                response=resp,
            )
        if resp.status_code >= 400:
            raise GitHubServiceError(
                f"GitHub API error {resp.status_code} on {path}: {resp.text[:300]}"
                + _rate_limit_hint(resp.status_code)
            )
        return resp

    # ------------------------------------------------------------------ api
    async def fetch_recent_commits(
        self, repo_url: str, *, limit: int = 15
    ) -> list[CommitInfo]:
        """Return the `limit` most recent commits, enriched with diff stats.

        Results are cached briefly per `(owner, repo, limit, authenticated)`.
        The stats fan-out is bounded by `GITHUB_STATS_TIMEOUT`, so a slow
        GitHub cannot stall the whole saga: commits fall back to message-only
        data when the deadline expires.
        """
        if limit <= 0:
            return []
        limit = min(limit, MAX_COMMITS_PER_REQUEST, _GITHUB_PER_PAGE_LIMIT)
        owner, repo = parse_github_url(repo_url)

        cache_key = (owner.lower(), repo.lower(), limit, bool(self._token))
        now = time.monotonic()
        cached = _COMMIT_CACHE.get(cache_key)
        if cached is not None and cached[0] > now:
            return [commit.model_copy(deep=True) for commit in cached[1]]

        resp = await self._get(f"/repos/{owner}/{repo}/commits", per_page=limit)
        payload = resp.json()
        if not isinstance(payload, list):
            # Defense in depth: 3xx bodies are dicts, and so is the "Moved
            # Permanently" payload GitHub returns for a renamed repository.
            message = payload.get("message") if isinstance(payload, dict) else None
            raise GitHubServiceError(
                f"Reponse GitHub inattendue pour {owner}/{repo} "
                f"(HTTP {resp.status_code}"
                + (f", message={message!r}" if message else "")
                + "). Verifie que le depot existe et est bien un depot Git."
            )

        raw_commits = payload[:limit]
        if not raw_commits:
            raise GitHubServiceError(
                f"Le depot {owner}/{repo} ne contient aucun commit lisible."
            )

        # Unauthenticated GitHub allows 60 requests/hour and this saga already
        # costs 1 + N. When only a few calls remain, skip the per-commit stats
        # rather than burning the quota and failing the whole request. This also
        # applies to an authenticated token that is close to its own quota.
        remaining = _int_header(resp, "x-ratelimit-remaining")
        fetch_stats = remaining is None or remaining > len(raw_commits) + 5

        complete = fetch_stats
        if fetch_stats:
            commits, complete = await self._enrich_commits(owner, repo, raw_commits)
        else:
            commits = [self._base_commit(owner, repo, item) for item in raw_commits]

        # Only cache a fully enriched list. A stats timeout, a low-quota skip or
        # a per-commit failure produces zeroed diff stats; caching that for the
        # full TTL would poison every retry of the same repo long after GitHub
        # recovered (and the saga prompt consumes those stats).
        if self._cache_ttl > 0 and complete:
            _cache_put(cache_key, commits, self._cache_ttl)
        return [commit.model_copy(deep=True) for commit in commits]

    async def _enrich_commits(
        self, owner: str, repo: str, raw_commits: list[dict[str, Any]]
    ) -> tuple[list[CommitInfo], bool]:
        """Fetch per-commit stats concurrently, within a global deadline.

        Returns the commits and whether every stats call succeeded. On timeout
        the stats already obtained are kept and only the missing commits fall
        back to zeroed diff stats.
        """
        tasks = [
            asyncio.create_task(self._build_commit(owner, repo, item))
            for item in raw_commits
        ]
        try:
            done, pending = await asyncio.wait(tasks, timeout=self._stats_timeout)
        except BaseException:
            # `asyncio.wait` never cancels the tasks it watches. Without this
            # reaping, cancelling this coroutine (shutdown, programmatic
            # cancellation) would leave the stats tasks running against a
            # shared httpx client that `__aexit__` is about to close.
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            raise
        if pending:
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            logger.warning(
                "GitHub stats timeout (%.1fs): %d/%d commits without diff stats",
                self._stats_timeout,
                len(pending),
                len(raw_commits),
            )

        commits: list[CommitInfo] = []
        complete = not pending
        for item, task in zip(raw_commits, tasks):
            if task in done and not task.cancelled() and task.exception() is None:
                commit, stats_ok = task.result()
                commits.append(commit)
                complete = complete and stats_ok
            else:
                complete = False
                commits.append(self._base_commit(owner, repo, item))
        return commits, complete

    async def _build_commit(
        self, owner: str, repo: str, item: dict[str, Any]
    ) -> tuple[CommitInfo, bool]:
        sha = item.get("sha", "")

        additions = deletions = files_changed = 0
        stats_ok = True
        try:
            detail_resp = await self._get(f"/repos/{owner}/{repo}/commits/{sha}")
            detail = detail_resp.json()
            stats = detail.get("stats") or {}
            additions = int(stats.get("additions") or 0)
            deletions = int(stats.get("deletions") or 0)
            files_changed = len(detail.get("files") or [])
        except GitHubServiceError:
            # Never break the whole saga because one commit's stats failed.
            stats_ok = False

        commit = self._base_commit(
            owner,
            repo,
            item,
            additions=additions,
            deletions=deletions,
            files_changed=files_changed,
        )
        return commit, stats_ok

    @staticmethod
    def _base_commit(
        owner: str,
        repo: str,
        item: dict[str, Any],
        *,
        additions: int = 0,
        deletions: int = 0,
        files_changed: int = 0,
    ) -> CommitInfo:
        """Build a commit from the list payload, without any network call."""
        sha = item.get("sha", "")
        commit_meta = item.get("commit") or {}
        author_meta = commit_meta.get("author") or {}
        gh_author = item.get("author") or {}

        authored_at_raw = author_meta.get("date") or (item.get("committer") or {}).get(
            "date"
        )
        author_login = gh_author.get("login")
        author_type = gh_author.get("type")

        return CommitInfo(
            sha=sha,
            short_sha=sha[:7],
            message=(commit_meta.get("message") or "").strip(),
            author_name=author_meta.get("name") or author_login or "Unknown",
            author_email=author_meta.get("email"),
            author_login=author_login,
            author_type=author_type,
            is_bot=is_bot(author_login, author_type),
            authored_at=_safe_iso_parse(authored_at_raw),
            html_url=item.get("html_url")
            or f"https://github.com/{owner}/{repo}/commit/{sha}",
            additions=additions,
            deletions=deletions,
            total_changes=additions + deletions,
            files_changed=files_changed,
        )


def _rate_limit_hint(status: int) -> str:
    if status in (403, 429):
        return (
            " (quota GitHub epuise : 60 req/h sans token, une saga en consomme ~1+N. "
            "Renseigne GITHUB_TOKEN dans le fichier .env a la racine du projet — "
            "cree un token sur https://github.com/settings/tokens)"
        )
    if status == 404:
        return " (depot prive, inexistant, ou renomme)"
    return ""


def _int_header(resp: httpx.Response, name: str) -> int | None:
    """Read an integer response header without trusting its shape."""
    raw = resp.headers.get(name)
    try:
        return int(raw) if raw is not None else None
    except (TypeError, ValueError):
        return None


def _cache_put(
    key: tuple[str, str, int, bool],
    commits: list[CommitInfo],
    ttl: float,
) -> None:
    # Expiry starts at insertion, not at request start: the fetch itself can
    # consume up to GITHUB_STATS_TIMEOUT seconds.
    _COMMIT_CACHE[key] = (time.monotonic() + ttl, commits)
    # Bound the cache: a judge may try many repositories in one session.
    while len(_COMMIT_CACHE) > _COMMIT_CACHE_MAX:
        _COMMIT_CACHE.pop(next(iter(_COMMIT_CACHE)))


def _safe_iso_parse(value: str | None) -> datetime:
    """Parse GitHub's ISO-8601 timestamps, always timezone-aware.

    BUGFIX: the previous fallback returned a *naive* datetime, which mixed
    naive and aware values in the same list and would break `sorted()` as soon
    as one commit had a malformed date.
    """
    if not value:
        return _EPOCH_UTC
    try:
        # GitHub returns "2024-05-01T12:34:56Z".
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return _EPOCH_UTC
