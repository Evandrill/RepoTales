# backend/services/image_service.py
"""Deterministic FLUX.1-schnell artwork for RepoTales.

Two responsibilities, deliberately kept together because the second depends on
the first for reproducibility:

1. **Seeds and URLs** (`attach_artwork`): every character portrait and manga
   panel gets a seed derived from `sha256(repo_url | official_id)`. The same
   repository therefore always produces the same visual story, and the frontend
   only ever needs to render the proxy URL the backend puts in the payload.

2. **Upstream proxy** (`generate_image`): the browser cannot call the FLUX box
   directly (CORS + mixed content), so `/api/image-proxy` relays
   prompt/seed/width/height/steps and streams the PNG back. A two-level cache
   (memory + disk) makes repeated page loads and demo runs instant, which also
   protects the single AMD GPU from being asked for the same 15 images again.

The module never makes a network call while building a saga: `attach_artwork`
only composes URLs. A dead image server therefore degrades to the frontend's
retro placeholder instead of breaking `/saga/generate`.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import logging
import os
import re
from collections import OrderedDict
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, urlencode, urlparse

import httpx

from backend.models.saga import BossFight, Character, Panel, SagaPayload

logger = logging.getLogger(__name__)

DEFAULT_IMAGE_SERVER_URL = "http://129.212.191.240:8001/generate-image"
DEFAULT_PROXY_PREFIX = "/api/image-proxy"
DEFAULT_REPO_URL = "https://github.com/repotales/demo-saga"

# FLUX.1-schnell is distilled for 1-4 steps. 384px keeps a full saga (12-17
# images) inside a demo's GPU budget, and 2 steps is visually indistinguishable
# from 4 at that resolution while halving the GPU time. All sizes are multiples
# of 16.
DEFAULT_STEPS = 2
MAX_STEPS = 3
DEFAULT_TIMEOUT = 120.0

AVATAR_WIDTH = AVATAR_HEIGHT = 384
BOSS_WIDTH = BOSS_HEIGHT = 384
PANEL_WIDE = (384, 192)  # 2:1 establishing shot, matches MangaReader's 16/8
PANEL_SQUARE = (384, 384)

_MAX_PROMPT_CHARS = 1000
_MEMORY_CACHE_MAX = 128

_SEMAPHORE: asyncio.Semaphore | None = None
_MEMORY_CACHE: OrderedDict[tuple[Any, ...], bytes] = OrderedDict()
# Deduplicates identical generations that are already in flight: the browser's
# first chapter and the background pre-generation often ask for the same URL
# within the same second, which would otherwise burn two GPU slots.
_INFLIGHT: dict[tuple[Any, ...], asyncio.Task[bytes]] = {}

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_JPEG_SIGNATURE = b"\xff\xd8\xff"
_WEBP_SIGNATURE = b"RIFF"
_GIF_SIGNATURE = (b"GIF87a", b"GIF89a")


class ImageServiceError(RuntimeError):
    """Raised when the FLUX server cannot be reached or returns non-image data."""


class TransientImageError(ImageServiceError):
    """A failure a single retry can plausibly fix (5xx, timeout, dropped link).

    Permanent failures (400/401/404/422, invalid prompt) inherit from
    `ImageServiceError` only, so the retry in `_generate_and_cache` never
    doubles the load for something that will fail identically a second time.
    """


# --------------------------------------------------------------------------- #
# Env helpers (kept local: amd_service imports this module, not the reverse)  #
# --------------------------------------------------------------------------- #
def _env_flag(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    try:
        return int(float(os.getenv(name, "") or default))
    except (TypeError, ValueError):
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, "") or default)
    except (TypeError, ValueError):
        return default


def images_enabled() -> bool:
    """Images are on by default: the whole point of the demo is to show art."""
    return _env_flag("AMD_IMAGE_ENABLED", True)


def _step_count() -> int:
    """Configured FLUX steps, clamped to the schnell sweet spot (1-3)."""
    return max(1, min(MAX_STEPS, _env_int("AMD_IMAGE_STEPS", DEFAULT_STEPS)))


# --------------------------------------------------------------------------- #
# Deterministic seeds                                                         #
# --------------------------------------------------------------------------- #
def deterministic_seed(*parts: object) -> int:
    """Stable uint32 seed from any tuple of identity parts.

    `sha256` (not Python's `hash`) because the latter is salted per process and
    would change the artwork after every backend restart — the exact opposite
    of what a demo needs.
    """
    payload = "\x1f".join(str(part) for part in parts)
    digest = hashlib.sha256(payload.encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big")


def normalize_repo_url(repo_url: str | None) -> str:
    """Canonical repo key: no trailing slash, no `.git`, lowercase host/path."""
    value = (repo_url or DEFAULT_REPO_URL).strip().lower()
    if value.endswith(".git"):
        value = value[:-4]
    return value.rstrip("/") or DEFAULT_REPO_URL


# --------------------------------------------------------------------------- #
# Prompt builders                                                             #
# --------------------------------------------------------------------------- #
_SHOT_LABELS = {
    "wide": "wide establishing shot",
    "medium": "medium shot",
    "close_up": "dramatic close-up",
    "extreme_close_up": "extreme close-up on the eyes",
}
_POSE_LABELS = {
    "idle": "standing still",
    "typing_furious": "typing furiously on a mechanical keyboard, sparks flying",
    "pointing": "pointing forward dramatically",
    "head_in_hands": "head in hands in despair",
    "victory": "raising a fist in victory",
    "shocked": "recoiling in shock",
}
_EMOTION_LABELS = {
    "neutral": "neutral expression",
    "joyful": "joyful expression",
    "determined": "fierce determined expression",
    "angry": "angry expression",
    "sad": "sorrowful expression",
    "anxious": "anxious expression",
    "shocked": "shocked expression",
}

_STYLE = (
    "retro 16-bit anime style, bold black ink outlines, halftone shading, "
    "neon magenta violet cyan accents, dark navy background, centered composition, "
    "no speech bubbles, no lettering, no text, no watermark"
)


def _clean(value: str | None, limit: int) -> str:
    """One-line, quote-free prose for a prompt parameter."""
    if not value:
        return ""
    flattened = " ".join(str(value).split())
    flattened = flattened.replace('"', "'").strip(" ,;:")
    return flattened[:limit]


def _enum_value(value: object) -> str:
    raw = getattr(value, "value", value)
    return str(raw)


def _mentions(text: str, needle: str | None, *, min_len: int = 1) -> bool:
    """Whole-word, case-insensitive mention check.

    `\\b` is not used directly: names may contain accents and dots (e.g.
    "Aria N."), where `(?<!\\w) ... (?!\\w)` behaves correctly on Python's
    Unicode regex engine.
    """
    candidate = (needle or "").strip().lower()
    if len(candidate) < min_len:
        return False
    pattern = rf"(?<!\w){re.escape(candidate)}(?!\w)"
    return re.search(pattern, text) is not None


# --------------------------------------------------------------------------- #
# Canonical appearance                                                        #
# --------------------------------------------------------------------------- #
# FLUX has no memory between calls: without an explicit description the hero
# changes hair, eyes and outfit on every panel. These traits are derived from
# the character id, so the same hero is described identically in the portrait,
# the chapter panels and the boss fight — and the same repo always renders the
# same cast.
_HAIR = ("dark", "silver", "crimson", "azure", "blond", "raven")
_EYES = (
    "glowing pink",
    "glowing cyan",
    "glowing emerald",
    "glowing violet",
    "glowing amber",
)
_BOT_FRAME = ("brass", "chrome", "obsidian", "copper")


def canonical_appearance(character: Character, *, limit: int = 150) -> str:
    """Stable, prompt-ready description of a character.

    Mechanical cast members (bots) never get human features: they are described
    as automata so the "bots are never the hero" rule survives into the art.
    """
    name = _clean(character.name, 60) or character.character_id
    klass = _clean(character.rpg_class, 40).lower()
    role = _clean(character.role, 40).lower()
    seed = deterministic_seed("appearance", character.character_id)

    if getattr(character, "is_bot", False):
        frame = _BOT_FRAME[seed % len(_BOT_FRAME)]
        return _clean(
            f"{name}, {frame} mechanical automaton with glowing amber eyes",
            limit,
        )

    descriptor = " ".join(part for part in (klass, role) if part)
    hair = _HAIR[(seed >> 8) % len(_HAIR)]
    eyes = _EYES[(seed >> 16) % len(_EYES)]
    return _clean(
        f"{name}, {hair}-haired {descriptor} with {eyes} eyes".replace("  ", " "),
        limit,
    )


def build_avatar_prompt(character: Character) -> str:
    subject = canonical_appearance(character)
    return (
        f"portrait of {subject}, upper body, facing the viewer, "
        "fierce determined expression, chunky pixel art, limited neon palette, "
        f"{_STYLE}"
    )[:_MAX_PROMPT_CHARS]


def build_boss_prompt(boss: BossFight) -> str:
    name = _clean(boss.name, 100) or "the final bug"
    description = _clean(boss.description, 240)
    subject = f"{name}, {description}" if description else name
    return (
        f"manga villain boss illustration, {subject}, menacing aura, "
        "towering silhouette, glowing red eyes, "
        f"{_STYLE}"
    )[:_MAX_PROMPT_CHARS]


def build_panel_prompt(
    panel: Panel,
    speaker_appearances: list[str] | None = None,
) -> str:
    parts = [
        "shonen manga panel illustration",
        _SHOT_LABELS.get(_enum_value(panel.shot), "medium shot"),
        _POSE_LABELS.get(_enum_value(panel.pose), "standing still"),
        _EMOTION_LABELS.get(_enum_value(panel.emotion), "neutral expression"),
    ]
    # Full canonical descriptions (not just names) keep the same hair/eyes/
    # outfit across panels — FLUX does not remember previous generations.
    speakers = [_clean(item, 150) for item in (speaker_appearances or []) if _clean(item, 1)][:3]
    if speakers:
        parts.append("characters: " + ", ".join(speakers))
    scene = _clean(panel.scene, 260)
    if scene:
        parts.append(f"scene: {scene}")
    # Reserve room for _STYLE *before* truncating: its negative constraints
    # ("no lettering, no text, no watermark") must survive long panels, or FLUX
    # starts drawing speech bubbles and text inside the artwork.
    budget = max(0, _MAX_PROMPT_CHARS - len(_STYLE) - 2)
    body = ", ".join(parts)
    if len(body) > budget:
        body = body[:budget].rstrip(" ,")
    return f"{body}, {_STYLE}"


# --------------------------------------------------------------------------- #
# Proxy URLs (what the payload exposes to the browser)                        #
# --------------------------------------------------------------------------- #
def _proxy_prefix() -> str:
    prefix = (os.getenv("AMD_IMAGE_PROXY_PREFIX") or DEFAULT_PROXY_PREFIX).strip()
    return prefix or DEFAULT_PROXY_PREFIX


def proxy_url(
    prompt: str,
    *,
    seed: int,
    width: int,
    height: int,
    steps: int | None = None,
) -> str:
    """Absolute path (browser-facing) of the image-proxy request."""
    params = {
        "prompt": prompt,
        "seed": seed,
        "width": width,
        "height": height,
        "steps": steps if steps is not None else _step_count(),
        "src": server_fingerprint(),
    }
    return f"{_proxy_prefix()}?{urlencode(params, quote_via=quote)}"


def avatar_url(repo_key: str, character: Character) -> str:
    return proxy_url(
        build_avatar_prompt(character),
        seed=deterministic_seed(repo_key, "avatar", character.character_id),
        width=AVATAR_WIDTH,
        height=AVATAR_HEIGHT,
    )


def boss_sprite_url(repo_key: str, boss: BossFight) -> str:
    return proxy_url(
        build_boss_prompt(boss),
        seed=deterministic_seed(repo_key, "boss", "sprite"),
        width=BOSS_WIDTH,
        height=BOSS_HEIGHT,
    )


def panel_image_url(
    repo_key: str,
    panel: Panel,
    *,
    scope: str,
    position: int,
    speaker_appearances: list[str],
    hero_id: str = "",
) -> str:
    # `position` (not the scene text) is part of the seed: the same repository
    # must keep its visual identity even if the LLM rephrases a scene on the
    # next generation. `hero_id` pins every panel to the same protagonist
    # identity, so FLUX keeps the hero's traits across the whole manga.
    # Compositions are wide for the establishing panel and square for the rest,
    # matching MangaReader's grid.
    width, height = PANEL_WIDE if position == 1 else PANEL_SQUARE
    return proxy_url(
        build_panel_prompt(panel, speaker_appearances),
        seed=deterministic_seed(repo_key, scope, "panel", position, hero_id),
        width=width,
        height=height,
    )


# --------------------------------------------------------------------------- #
# Payload enrichment (no network)                                             #
# --------------------------------------------------------------------------- #
def attach_artwork(saga: SagaPayload, repo_url: str = DEFAULT_REPO_URL) -> SagaPayload:
    """Point every portrait/panel at its deterministic image-proxy URL.

    Mutates and returns `saga`. Safe to call twice; URLs are recomputed rather
    than appended. When `AMD_IMAGE_ENABLED=false`, URL fields are cleared so a
    deployment can ship without a GPU.
    """
    if not images_enabled():
        saga.hero.avatar_url = None
        for character in saga.characters:
            character.avatar_url = None
        for chapter in saga.chapters:
            for panel in chapter.panels:
                panel.image_url = None
        for panel in saga.boss_fight.panels:
            panel.image_url = None
        saga.boss_fight.sprite_url = None
        return saga

    repo_key = normalize_repo_url(repo_url)
    # The narrator is a caption device, never a visible person: leaving it in
    # the speaker map made FLUX draw a phantom extra character in narration
    # panels ("characters: The Narrator").
    cast = {
        character.character_id: character
        for character in saga.characters
        if character.character_id != "narrator"
    }
    cast.setdefault(saga.hero.character_id, saga.hero)
    hero = cast[saga.hero.character_id]

    def appearances(panel: Panel) -> list[str]:
        """Canonical descriptions of everyone visible in the panel.

        Speakers come from the validated bubbles. The hero is also added when
        the scene names them without a bubble — an establishing shot of the
        protagonist must keep the same face, not invent a new one.
        """
        visible: list[Character] = []
        for bubble in panel.bubbles:
            character = cast.get(bubble.speaker_id)
            if character is not None and character not in visible:
                visible.append(character)

        if hero not in visible:
            scene = (panel.scene or "").lower()
            first_name = (hero.name or "").split(" ")[0].lower()
            # Word boundaries + a minimum length: a raw `in` test made "Li"
            # match "little", "client", "conflict" and drew a phantom hero.
            if _mentions(scene, hero.name) or _mentions(scene, first_name, min_len=4):
                # Hero first: prompts keep only the first three appearances, so
                # appending them last would silently drop the protagonist.
                visible.insert(0, hero)
        elif visible and visible[0] is not hero:
            # Prompts cap the cast at three: the protagonist must never be the
            # one dropped when a panel has a crowd.
            visible.remove(hero)
            visible.insert(0, hero)

        return [canonical_appearance(character) for character in visible[:3]]

    # 1. Portraits. The hero also appears in `characters` (backend healing
    #    guarantees it); keep both copies pointing at the same image.
    saga.hero.avatar_url = avatar_url(repo_key, saga.hero)
    for character in saga.characters:
        if character.character_id == "narrator":
            # The narrator is a caption device rendered as text, never a card.
            character.avatar_url = None
        elif character.character_id == saga.hero.character_id:
            character.avatar_url = saga.hero.avatar_url
        else:
            character.avatar_url = avatar_url(repo_key, character)

    # 2. Chapter panels. Speaker descriptions come from the validated bubbles
    #    so the prompt describes the people actually in the frame.
    for chapter in saga.chapters:
        for position, panel in enumerate(chapter.panels, start=1):
            panel.image_url = panel_image_url(
                repo_key,
                panel,
                scope=f"chapter:{chapter.index}",
                position=position,
                speaker_appearances=appearances(panel),
                hero_id=hero.character_id,
            )

    # 3. Boss sprite + boss panels.
    saga.boss_fight.sprite_url = boss_sprite_url(repo_key, saga.boss_fight)
    for position, panel in enumerate(saga.boss_fight.panels, start=1):
        panel.image_url = panel_image_url(
            repo_key,
            panel,
            scope="boss",
            position=position,
            speaker_appearances=appearances(panel),
            hero_id=hero.character_id,
        )

    return saga


# --------------------------------------------------------------------------- #
# Proxy: cache + upstream call                                                #
# --------------------------------------------------------------------------- #
def _semaphore() -> asyncio.Semaphore:
    global _SEMAPHORE
    if _SEMAPHORE is None:
        # Exclusive by design: the FLUX server on :8001 runs one model instance
        # and collides with itself ("Already borrowed") when two requests hit
        # the CUDA context at once. Queueing is cheap next to a 500.
        _SEMAPHORE = asyncio.Semaphore(1)
    return _SEMAPHORE


def _server_url() -> str:
    """Resolve the FLUX endpoint from either public or legacy env names.

    `AMD_IMAGE_SERVER_URL` is the historical, full-path variable.
    `FLUX_BASE_URL` (docker-compose / .env.example) is a *base* such as
    `http://host:8001`; a base without a path gets the wrapper's
    `/generate-image` appended, while a full URL is kept untouched.
    """
    raw = (
        os.getenv("AMD_IMAGE_SERVER_URL")
        or os.getenv("FLUX_BASE_URL")
        or DEFAULT_IMAGE_SERVER_URL
    ).strip()
    if not raw:
        return DEFAULT_IMAGE_SERVER_URL
    raw = raw.rstrip("/")
    if not urlparse(raw).path:
        raw = f"{raw}/generate-image"
    return raw


def server_fingerprint() -> str:
    """Short identity of the upstream host.

    Part of every browser-facing URL (``src=...``): switching
    ``AMD_IMAGE_SERVER_URL`` (stub → real GPU, or a second deployment) changes
    the URL, so the browser cache and the ETag can never serve the previous
    server's artwork. The internal cache already keys on the full URL.
    """
    return hashlib.sha256(_server_url().encode("utf-8")).hexdigest()[:8]


def _cache_key(
    prompt: str, seed: int, width: int, height: int, steps: int
) -> tuple[Any, ...]:
    # The upstream host is part of the key: a local stub, or a second FLUX
    # deployment, must never serve its images as if they came from this GPU
    # (that exact cache-poisoning bit us during development).
    return (_server_url(), prompt, seed, width, height, steps)


def _cache_digest(key: tuple[Any, ...]) -> str:
    return hashlib.sha256(repr(key).encode("utf-8")).hexdigest()


def _cache_dir() -> Path:
    raw = os.getenv("AMD_IMAGE_CACHE_DIR") or ""
    if raw.strip():
        return Path(raw.strip()).expanduser()
    return Path(__file__).resolve().parents[1] / ".cache" / "images"


def _disk_path(key: tuple[Any, ...]) -> Path:
    return _cache_dir() / f"{_cache_digest(key)}.png"


def _looks_like_image(data: bytes) -> bool:
    return (
        data.startswith(_PNG_SIGNATURE)
        or data.startswith(_JPEG_SIGNATURE)
        # A RIFF container is not necessarily an image (WAV/AVI share it).
        or (data.startswith(_WEBP_SIGNATURE) and data[8:12] == b"WEBP")
        or data.startswith(_GIF_SIGNATURE)
    )


def image_media_type(data: bytes) -> str:
    """Content-Type matching the bytes we are about to serve."""
    if data.startswith(_JPEG_SIGNATURE):
        return "image/jpeg"
    if data.startswith(_WEBP_SIGNATURE) and data[8:12] == b"WEBP":
        return "image/webp"
    if data.startswith(_GIF_SIGNATURE):
        return "image/gif"
    return "image/png"


def _decode_base64_image(value: str) -> bytes | None:
    payload = value.strip()
    if payload.startswith("data:"):
        _, _, payload = payload.partition(",")
    try:
        data = base64.b64decode(payload, validate=False)
    except (ValueError, TypeError):
        return None
    return data if _looks_like_image(data) else None


async def _read_disk_cache(key: tuple[Any, ...]) -> bytes | None:
    if _env_flag("AMD_IMAGE_CACHE_DISABLED", False):
        return None
    path = _disk_path(key)
    try:
        data = await asyncio.to_thread(path.read_bytes)
    except OSError:
        return None
    if data and _looks_like_image(data):
        return data
    return None


async def _write_disk_cache(key: tuple[Any, ...], data: bytes) -> None:
    if _env_flag("AMD_IMAGE_CACHE_DISABLED", False):
        return
    path = _disk_path(key)
    try:
        await asyncio.to_thread(path.parent.mkdir, parents=True, exist_ok=True)
        await asyncio.to_thread(path.write_bytes, data)
    except OSError as exc:  # cache is best-effort, never fatal
        logger.debug("Image cache write failed (%s): %s", path, exc)


def _memory_get(key: tuple[Any, ...]) -> bytes | None:
    # `AMD_IMAGE_CACHE_DISABLED` must bypass both levels, not just the disk one.
    if _env_flag("AMD_IMAGE_CACHE_DISABLED", False):
        return None
    data = _MEMORY_CACHE.get(key)
    if data is None:
        return None
    _MEMORY_CACHE.move_to_end(key)
    return data


def _memory_put(key: tuple[Any, ...], data: bytes) -> None:
    _MEMORY_CACHE[key] = data
    _MEMORY_CACHE.move_to_end(key)
    while len(_MEMORY_CACHE) > _MEMORY_CACHE_MAX:
        _MEMORY_CACHE.popitem(last=False)


def clear_image_cache() -> None:
    """Drop the in-memory cache (tests / demo resets). Disk cache is kept."""
    _MEMORY_CACHE.clear()


async def _decode_response(resp: httpx.Response) -> bytes:
    content = resp.content
    if not content:
        raise ImageServiceError("Le serveur FLUX a renvoye un corps vide.")

    if _looks_like_image(content):
        return content

    content_type = (resp.headers.get("content-type") or "").lower()
    if content_type.startswith("image/"):
        return content

    text = content.decode("utf-8", "ignore").strip()
    decoded = _decode_base64_image(text)
    if decoded is not None:
        return decoded

    try:
        payload: Any = resp.json()
    except ValueError:
        payload = None

    if isinstance(payload, dict):
        for key in ("image", "b64_json", "image_base64", "base64", "png"):
            value = payload.get(key)
            if isinstance(value, str):
                decoded = _decode_base64_image(value)
                if decoded is not None:
                    return decoded
        for key in ("images", "data", "output"):
            value = payload.get(key)
            if isinstance(value, list) and value:
                first = value[0]
                candidates: list[str] = []
                if isinstance(first, str):
                    candidates.append(first)
                elif isinstance(first, dict):
                    candidates.extend(
                        first[k]
                        for k in ("b64_json", "image", "base64", "url", "image_url")
                        if isinstance(first.get(k), str)
                    )
                for candidate in candidates:
                    if candidate.startswith(("http://", "https://")):
                        try:
                            async with httpx.AsyncClient(timeout=60.0) as client:
                                remote = await client.get(candidate)
                            if remote.is_success and _looks_like_image(remote.content):
                                return remote.content
                        except httpx.HTTPError:
                            continue
                    decoded = _decode_base64_image(candidate)
                    if decoded is not None:
                        return decoded

    raise ImageServiceError(
        "Le serveur FLUX n'a pas renvoye une image exploitable "
        f"(content-type={content_type or 'inconnu'}, {len(content)} octets)."
    )


async def _fetch_upstream(
    prompt: str, *, seed: int, width: int, height: int, steps: int
) -> bytes:
    url = _server_url()
    if not url:
        raise ImageServiceError("AMD_IMAGE_SERVER_URL n'est pas configure.")

    steps = max(1, min(MAX_STEPS, steps))
    base_payload = {
        "prompt": prompt,
        "seed": seed,
        "width": width,
        "height": height,
    }
    # FLUX wrappers disagree on the step field name (`steps` vs
    # `num_inference_steps`). Try the configured one first, then the other, so
    # a renamed field cannot silently fall back to 50 steps and time out.
    configured = (os.getenv("AMD_IMAGE_STEPS_PARAM") or "steps").strip() or "steps"
    step_fields = [configured]
    for candidate in ("steps", "num_inference_steps"):
        if candidate not in step_fields:
            step_fields.append(candidate)

    method = (os.getenv("AMD_IMAGE_HTTP_METHOD") or "POST").strip().upper()
    timeout = httpx.Timeout(_env_float("AMD_IMAGE_TIMEOUT", DEFAULT_TIMEOUT), connect=10.0)
    headers = {"Accept": "image/png, image/jpeg, application/json"}

    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            resp: httpx.Response | None = None
            for index, field in enumerate(step_fields):
                payload = {**base_payload, field: steps}
                if method == "GET":
                    resp = await client.get(url, params=payload, headers=headers)
                else:
                    resp = await client.post(url, json=payload, headers=headers)
                    # A few FLUX wrappers expose only the GET form. 404/405
                    # means "wrong verb", not "wrong request".
                    if resp.status_code in {404, 405, 501}:
                        resp = await client.get(url, params=payload, headers=headers)
                if resp.status_code == 422 and index < len(step_fields) - 1:
                    logger.info(
                        "FLUX a rejete le champ %r (HTTP 422), nouvel essai avec %r",
                        field,
                        step_fields[index + 1],
                    )
                    continue
                break

            if resp is None:  # defensive: step_fields is never empty
                raise ImageServiceError("Requete FLUX non emise.")
            if resp.status_code >= 400:
                detail = resp.text.strip()[:400]
                try:
                    body = resp.json()
                    if isinstance(body, dict):
                        detail = str(body.get("detail") or body.get("error") or detail)
                except ValueError:
                    pass
                error_cls = (
                    TransientImageError
                    if resp.status_code in {408, 425, 429} or resp.status_code >= 500
                    else ImageServiceError
                )
                raise error_cls(
                    f"FLUX a renvoye HTTP {resp.status_code}: {detail}"
                )
            return await _decode_response(resp)
    except httpx.TimeoutException as exc:
        raise TransientImageError(
            f"FLUX n'a pas repondu dans le delai imparti "
            f"({_env_float('AMD_IMAGE_TIMEOUT', DEFAULT_TIMEOUT):.0f}s)."
        ) from exc
    except httpx.HTTPError as exc:
        reason = f"{type(exc).__name__}: {exc}".rstrip(": ").strip()
        raise TransientImageError(
            f"Serveur d'images injoignable ({reason or 'connexion refusee'})."
        ) from exc


async def _generate_and_cache(
    key: tuple[Any, ...],
    prompt: str,
    *,
    seed: int,
    width: int,
    height: int,
    steps: int,
) -> bytes:
    """Disk cache lookup → bounded upstream call → both caches."""
    cached = await _read_disk_cache(key)
    if cached is not None:
        _memory_put(key, cached)
        return cached

    # Bound GPU concurrency: the single MI300X must not be oversubscribed by a
    # dozen roster + panel requests arriving at once.
    async with _semaphore():
        # Another request may have filled the caches while we waited.
        cached = _memory_get(key) or await _read_disk_cache(key)
        if cached is not None:
            _memory_put(key, cached)
            return cached

        logger.info(
            "FLUX generation seed=%d %dx%d steps=%d prompt=%r",
            seed,
            width,
            height,
            steps,
            prompt[:120],
        )
        # The upstream FLUX wrapper occasionally returns a transient 5xx or a
        # dropped connection. One short retry turns that into a slightly slower
        # image instead of a permanent placeholder.
        try:
            data = await _fetch_upstream(
                prompt, seed=seed, width=width, height=height, steps=steps
            )
        except TransientImageError:
            data = None

    if data is None:
        # Backoff outside the semaphore: the GPU slot is released while we
        # wait, so the rest of the queue keeps moving.
        await asyncio.sleep(0.5)
        cached = _memory_get(key) or await _read_disk_cache(key)
        if cached is not None:
            _memory_put(key, cached)
            return cached
        async with _semaphore():
            data = await _fetch_upstream(
                prompt, seed=seed, width=width, height=height, steps=steps
            )

    _memory_put(key, data)
    await _write_disk_cache(key, data)
    return data


async def generate_image(
    prompt: str,
    *,
    seed: int = 0,
    width: int = PANEL_SQUARE[0],
    height: int = PANEL_SQUARE[1],
    steps: int = DEFAULT_STEPS,
) -> bytes:
    """Return image bytes for `prompt`, cached by the full generation key.

    Concurrent callers asking for the same key share one GPU job instead of
    queueing twice (the background pre-generation and the browser routinely
    race on the first chapter).
    """
    prompt = (prompt or "").strip()
    if not prompt:
        raise ImageServiceError("Prompt vide.")
    if len(prompt) > _MAX_PROMPT_CHARS:
        prompt = prompt[:_MAX_PROMPT_CHARS]
    steps = max(1, min(MAX_STEPS, steps))

    key = _cache_key(prompt, seed, width, height, steps)
    cached = _memory_get(key)
    if cached is not None:
        return cached

    task = _INFLIGHT.get(key)
    if task is None:
        task = asyncio.create_task(
            _generate_and_cache(
                key, prompt, seed=seed, width=width, height=height, steps=steps
            )
        )
        _INFLIGHT[key] = task

        def _forget(finished: asyncio.Task[bytes], cache_key: tuple[Any, ...] = key) -> None:
            if _INFLIGHT.get(cache_key) is finished:
                _INFLIGHT.pop(cache_key, None)
            # Mark the outcome as observed: if every waiter was cancelled, an
            # unconsumed exception would print "Task exception was never
            # retrieved" at shutdown. Waiters still receive it through shield.
            if not finished.cancelled():
                finished.exception()

        task.add_done_callback(_forget)

    # `shield`: a browser disconnecting must not cancel the shared GPU job
    # that other waiters (or the cache) still depend on.
    return await asyncio.shield(task)


# --------------------------------------------------------------------------- #
# Background pre-generation                                                   #
# --------------------------------------------------------------------------- #
def _parse_proxy_url(url: str | None) -> tuple[str, dict[str, int]] | None:
    """Inverse of `proxy_url`: recover the generation parameters from a URL."""
    if not url:
        return None
    try:
        query = parse_qs(urlparse(url).query)
        prompt = query["prompt"][0]
        params = {
            "seed": int(query.get("seed", ["0"])[0]),
            "width": int(query.get("width", [PANEL_SQUARE[0]])[0]),
            "height": int(query.get("height", [PANEL_SQUARE[1]])[0]),
            "steps": int(query.get("steps", [str(_step_count())])[0]),
        }
    except (KeyError, IndexError, ValueError):
        return None
    return prompt, params


def _artwork_urls_by_priority(saga: SagaPayload) -> list[tuple[str, str]]:
    """Squad + first page first (visible on arrival), then the rest.

    Deduplicated by URL: the hero is also present in `characters`, and two
    panels can share a deterministic URL if the LLM reuses a scene.
    """
    first_page = saga.chapters[0].panels if saga.chapters else []
    tiers = (
        (
            "squad",
            [saga.hero.avatar_url, *(c.avatar_url for c in saga.characters)],
        ),
        ("first-page", [panel.image_url for panel in first_page]),
        (
            "rest",
            [
                *(panel.image_url for chapter in saga.chapters[1:] for panel in chapter.panels),
                saga.boss_fight.sprite_url,
                *(panel.image_url for panel in saga.boss_fight.panels),
            ],
        ),
    )
    seen: set[str] = set()
    ordered: list[tuple[str, str]] = []
    for tier, urls in tiers:
        for url in urls:
            if not url or url in seen:
                continue
            seen.add(url)
            ordered.append((tier, url))
    return ordered


async def pregenerate_saga_artwork(saga: SagaPayload) -> int:
    """Warm memory + disk caches in the background after `/saga/generate`.

    Called through FastAPI `BackgroundTasks`, i.e. *after* the JSON response
    has been sent: the user sees the saga immediately, and by the time they
    flip to chapter 2 or open the boss modal the images are already cached.
    Returns the number of images successfully generated.
    """
    if not images_enabled() or not _env_flag("AMD_IMAGE_PREGENERATE", True):
        return 0

    priority: list[tuple[str, dict[str, int]]] = []
    rest: list[tuple[str, dict[str, int]]] = []
    for tier, url in _artwork_urls_by_priority(saga):
        parsed = _parse_proxy_url(url)
        if parsed is None:
            continue
        (priority if tier in {"squad", "first-page"} else rest).append(parsed)
    if not priority and not rest:
        return 0

    async def _warm(item: tuple[str, dict[str, int]]) -> bool:
        prompt, params = item
        try:
            await generate_image(prompt, **params)
            return True
        except ImageServiceError as exc:
            logger.warning("Pre-generation FLUX echouee: %s", exc)
            return False

    # `gather` enqueues squad + first page, but the proxy semaphore serialises
    # them: one FLUX request at a time on the single GPU instance.
    logger.info(
        "Pre-generation de %d illustration(s) en arriere-plan", len(priority) + len(rest)
    )
    done = list(await asyncio.gather(*(_warm(item) for item in priority)))
    if priority and not any(done):
        # Server down: don't hammer it 20 more times. The UI will show its
        # placeholder, and the next /saga call gets another chance.
        logger.warning("Pre-generation interrompue: le serveur FLUX est indisponible.")
        return 0
    if rest:
        done += list(await asyncio.gather(*(_warm(item) for item in rest)))
    cached = sum(1 for ok in done if ok)
    logger.info("Pre-generation terminee: %d/%d image(s) en cache", cached, len(done))
    return cached
