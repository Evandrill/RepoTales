# backend/services/amd_service.py
"""Async client for the self-hosted vLLM endpoint running on the AMD GPU.

The endpoint is OpenAI-compatible, so we drive it with the `openai` SDK and let
`tenacity` handle transient failures. On any unrecoverable failure the service
falls back to `backend/mocks/mock_saga.json` so the demo can never 500.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse

import httpx
from openai import (
    APIConnectionError,
    APIError,
    APIStatusError,
    AsyncOpenAI,
    BadRequestError,
)
from pydantic import ValidationError
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from backend.models.saga import Character, Hero, SagaPayload, slugify_id
from backend.services.github_service import CommitInfo
from backend.services.image_service import DEFAULT_REPO_URL, attach_artwork

logger = logging.getLogger(__name__)

_MOCKS_DIR = Path(__file__).resolve().parent.parent / "mocks"
MOCK_SAGA_PATH = _MOCKS_DIR / "mock_saga.json"
# Fully translated sibling of mock_saga.json. Same ids/keys/enums/numbers, only
# the prose differs, so it validates against the same SagaPayload.
MOCK_SAGA_PATHS: dict[str, Path] = {
    "en": MOCK_SAGA_PATH,
    "fr": _MOCKS_DIR / "mock_saga_fr.json",
}

_TRANSIENT_STATUS = {408, 409, 429, 500, 502, 503, 504}

# vLLM's context-overflow 400 carries the exact numbers, e.g.:
#   "This model's maximum context length is 8192 tokens. However, you requested
#    6144 output tokens and your prompt contains at least 2049 input tokens"
_CONTEXT_WINDOW_RE = re.compile(r"maximum context length is (\d+)\s*tokens", re.I)
_INPUT_TOKENS_RE = re.compile(r"contains at least (\d+)\s*input tokens", re.I)
_PR_REF_RE = re.compile(r"\(#\d+\)")

# Deliberately pessimistic. Measured on the Qwen 2.5 tokenizer, the system
# prompt runs ~3.5 chars/token (5.6k chars -> 1.6k tokens); 3.0 leaves a margin.
_CHARS_PER_TOKEN = 3.0

# Per-commit message budget in the prompt. Long PR titles are the only
# unbounded input, and 50 of them can eat the whole 8k window.
_COMMIT_MSG_CHARS = 140

# How much of a rejected completion is echoed back in the repair turn.
_REPAIR_ECHO_CHARS = 1200


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


class AMDLLMError(RuntimeError):
    """Raised when the AMD vLLM endpoint fails or returns unusable output."""


# --------------------------------------------------------------------------- #
# MASTER SYSTEM PROMPT (unchanged - see previous message for full version)    #
# --------------------------------------------------------------------------- #
MASTER_SYSTEM_PROMPT = """\
You are "RepoTales Engine", a manga story architect and narrative compiler that transforms raw Git commit histories into a structured, coherent manga saga with RPG-flavored hero statistics.

# ABSOLUTE OUTPUT CONTRACT
- You ALWAYS reply with a SINGLE valid JSON object.
- Never wrap the JSON in markdown fences, never prepend or append prose, comments, or explanations.
- The JSON MUST validate against the `SagaPayload` schema. Missing required fields, unknown enum values, or type mismatches are CRITICAL FAILURES.
- Use double quotes for every key and string. No trailing commas. No NaN, no Infinity, no comments.
- If you are unsure about a value, pick the most narratively coherent option that fits the allowed enums. NEVER invent new enum members.

# OUTPUT SCHEMA — EXACT KEY NAMES (copy them verbatim)
Enum values are LOWERCASE strings. Never add `saga_title`, `chapter_number`,
`scenes`, `boss_name`, `boss_class` or any key not listed below.
{
  "title": "string",
  "synopsis": "string",
  "reading_direction": "rtl" | "ltr",
  "hero": {
    "character_id": "snake_case", "name": "string", "role": "string",
    "rpg_class": "string", "level": 1,
    "stats": {"strength": 1, "dexterity": 1, "constitution": 1,
              "intelligence": 1, "wisdom": 1, "charisma": 1},
    "catchphrase": "string"
  },
  "characters": [
    {"character_id": "snake_case", "name": "string", "role": "string",
     "rpg_class": "string", "level": 1}
  ],
  "chapters": [
    {
      "index": 1, "title": "string", "summary": "string",
      "panels": [
        {
          "scene": "string",
          "shot": "wide" | "medium" | "close_up" | "extreme_close_up",
          "pose": "idle" | "typing_furious" | "pointing" | "head_in_hands" | "victory" | "shocked",
          "emotion": "neutral" | "joyful" | "determined" | "angry" | "sad" | "anxious" | "shocked",
          "bubbles": [
            {"speaker_id": "snake_case or narrator", "text": "<=140 chars",
             "emotion": "neutral" | "joyful" | "determined" | "angry" | "sad" | "anxious" | "shocked",
             "bubble_style": "speech" | "shout" | "whisper" | "thought" | "narration"}
          ]
        }
      ]
    }
  ],
  "boss_fight": {
    "name": "string", "description": "string", "stakes": "string",
    "phases": ["string"], "outcome": "string",
    "panels": [ /* same panel shape as above; add 1-3 panels */ ]
  }
}
Every field above is REQUIRED unless it is a list you may leave empty
(`characters`, `panels`, `bubbles`). `hero` and every `characters` entry MUST
carry `role` — it is the character's narrative function, e.g. "Backend Paladin".
The hero MUST be present TWICE: in `hero` AND as the first entry of
`characters`. Write EXACTLY 4 chapters (5 only if there are 8+ commits), each
with at least 2 panels.

# INPUT
You receive a list of Git commits from a real repository: sha, author, message, additions, deletions, timestamp, files_changed.

# NARRATIVE RULES
1. Cluster related commits into scenes. Merge trivial commits (typos, merges, reverts, lint fixes) into adjacent scenes.
2. Produce between 4 and 8 chapters. Each chapter MUST have a clear dramatic arc: hook -> rising conflict -> resolution or cliffhanger.
3. The `hero` MUST be the contributor named in `dominant_human_contributor`. Never choose anyone else. Assign an RPG class, a level between 1 and 99, and coherent stats.
4. Secondary characters are the other contributors. Their `character_id` (snake_case) MUST be reused identically across the saga.
5. The `boss_fight` is the single most dramatic event: a major bug, breaking change, or marathon refactor.
6. Tone: shonen manga. Dramatic and slightly over-the-top, but technically accurate.

# CAST RULES: HUMANS AND AUTOMATA (CRITICAL)
Human contributors are the main RPG Heroes. Recognized bots (e.g., dependabot, github-actions) MUST be written into the story as mechanical sidekicks, ancient automatons, or summoned support golems.
- The `hero` is ALWAYS a human. A bot can NEVER be the hero, no matter how many commits it has.
- Every login listed under `active_automatons` MUST appear in `characters`, with an RPG class that marks it as a machine: "Maintenance Golem", "Deployment Spirit", "Mechanical Familiar", "Dependency Wraith". Never give an automaton a human role.
- Automatons are tireless, literal and slightly eerie. They speak in terse, procedural lines, e.g. "Dependency update available. Shall I proceed?"
- Automatons may be comedic or awe-inspiring, and they are excellent comic relief in battle scenes, but they never take the saga's dramatic decisions.
- Automatons still deserve panel time: show them working ceaselessly in the background of human scenes.

# VISUAL CONSISTENCY RULES (CRITICAL)
SHOT <-> EMOTION
- WIDE -> NEUTRAL, DETERMINED
- MEDIUM -> mild emotion
- CLOSE_UP -> ANGRY, SAD, JOYFUL, DETERMINED
- EXTREME_CLOSE_UP -> peak emotion (<= 15% of panels)

POSE <-> SHOT
- IDLE -> WIDE or MEDIUM
- TYPING_FURIOUS -> MEDIUM or CLOSE_UP
- POINTING -> MEDIUM or WIDE
- HEAD_IN_HANDS -> CLOSE_UP or EXTREME_CLOSE_UP
- VICTORY -> MEDIUM or WIDE
- SHOCKED -> CLOSE_UP or EXTREME_CLOSE_UP

BUBBLE STYLE
- SPEECH -> normal dialogue
- SHOUT -> only with CLOSE_UP / EXTREME_CLOSE_UP and SHOCKED / ANGRY
- WHISPER -> only with CLOSE_UP
- THOUGHT -> internal monologue
- NARRATION -> may use "narrator" as speaker_id

# DIALOGUE RULES
- Every `speaker_id` MUST match an existing character id.
- Bubble text <= 140 characters. Punchy, shonen-style.
- No emojis, no markdown, no HTML inside dialogue text.

# FAILURE MODE
If you cannot comply, return the smallest valid SagaPayload you can build. NEVER return an error message.
"""

# --------------------------------------------------------------------------- #
# Output language                                                             #
# --------------------------------------------------------------------------- #
SagaLanguage = Literal["en", "fr"]

# Only human-readable prose is translated. Keys, enum values, ids and the
# `[AUTOMATON]`-style markers stay English: Pydantic validates the enums, and
# the frontend looks them up by exact value.
_LANGUAGE_INSTRUCTION = {
    "en": (
        "LANGUAGE: Generate all chapter titles, captions, and dialogues in English "
        "according to the requested language. The same applies to the saga title, "
        "synopsis, character names/roles, panel scenes, bubbles, SFX text, boss "
        "name/phases/description/outcome and chapter summaries. JSON keys and enum "
        "values MUST stay in English exactly as specified above.\n"
        "CRITICAL: When language='en', write ALL titles, captions, dialogues, hero "
        "descriptions, and boss details IN ENGLISH. Output valid JSON only."
    ),
    "fr": (
        "LANGUAGE: Generate all chapter titles, captions, and dialogues in French "
        "according to the requested language. The same applies to the saga title, "
        "synopsis, character names/roles, panel scenes, bubbles, SFX text, boss "
        "name/phases/description/outcome and chapter summaries. JSON keys and enum "
        "values MUST stay in English exactly as specified above.\n"
        "CRITICAL: When language='fr', write ALL titles, captions, dialogues, hero "
        "descriptions, and boss details IN FRENCH. Output valid JSON only."
    ),
}


def normalize_language(language: str | None) -> SagaLanguage:
    """`fr` / `en` only; anything else falls back to English."""
    return "fr" if str(language or "").strip().lower().startswith("fr") else "en"


def _system_prompt(language: str) -> str:
    lang = normalize_language(language)
    return f"{MASTER_SYSTEM_PROMPT}\n\n# OUTPUT LANGUAGE\n{_LANGUAGE_INSTRUCTION[lang]}"


# --------------------------------------------------------------------------- #
# Robust JSON extraction                                                      #
# --------------------------------------------------------------------------- #
_JSON_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL | re.IGNORECASE)


def extract_json_object(text: str) -> dict[str, Any]:
    """Extract the first decodable JSON object from an LLM response."""
    if not text or not text.strip():
        raise ValueError("Empty LLM response")

    candidates: list[str] = [m.group(1).strip() for m in _JSON_FENCE_RE.finditer(text)]
    candidates.append(text.strip())

    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        candidates.append(text[start : end + 1])

    last_err: Exception | None = None
    for candidate in candidates:
        try:
            # strict=False tolerates raw control characters (literal newlines)
            # inside strings, which small models emit constantly in long prose.
            data = json.loads(candidate, strict=False)
        except json.JSONDecodeError as exc:
            last_err = exc
            continue
        if isinstance(data, dict):
            return data
    raise ValueError(f"Could not extract a JSON object from LLM output: {last_err}")


def summarize_validation_error(exc: ValidationError, limit: int = 8) -> str:
    """Compact, actionable version of a Pydantic error for the repair turn.

    `str(ValidationError)` echoes the *entire* rejected payload back, which on an
    8k-context model ate the whole output budget and turned every repair into a
    400. Only the location and message matter to the model.
    """
    errors = exc.errors(include_url=False, include_input=False)
    lines = []
    for err in errors[:limit]:
        location = ".".join(str(part) for part in err.get("loc", ())) or "<root>"
        lines.append(f"- {location}: {err.get('msg', err.get('type', 'invalid'))}")
    if len(errors) > limit:
        lines.append(f"- ... and {len(errors) - limit} more errors")
    return "\n".join(lines) or "- unknown validation error"


# --------------------------------------------------------------------------- #
# AMD vLLM client                                                             #
# --------------------------------------------------------------------------- #
class AMDService:
    """
    Async client for a self-hosted vLLM server (OpenAI-compatible) running on
    our AMD GPU droplet.

    On connection failure, timeout, or an unrecoverable API error, falls back to
    `backend/mocks/mock_saga.json` (validated through Pydantic) so the API never
    500s during a demo.
    """

    DEFAULT_MODEL = "meta-llama/Meta-Llama-3.1-8B-Instruct"
    DEFAULT_BASE_URL = "http://localhost:8000/v1"
    DEFAULT_API_KEY = "EMPTY"

    def __init__(
        self,
        base_url: str | None = None,
        api_key: str | None = None,
        model: str | None = None,
        *,
        connect_timeout: float = 5.0,
        read_timeout: float | None = None,
        max_tokens: int | None = None,
        allow_fallback: bool | None = None,
        json_mode: bool | None = None,
    ) -> None:
        self._base_url = (
            base_url
            or os.getenv("AMD_LLM_BASE_URL")
            # Public docker-compose name (see /.env.example).
            or os.getenv("VLLM_BASE_URL")
            or self.DEFAULT_BASE_URL
        ).rstrip("/")
        self._api_key = api_key or os.getenv("AMD_LLM_API_KEY") or self.DEFAULT_API_KEY

        # BUGFIX: `.env` defines AMD_MODEL_NAME, but the code only read
        # AMD_LLM_MODEL — so the configured model was silently ignored and the
        # hardcoded default was always used.
        self._model = (
            model
            or os.getenv("AMD_MODEL_NAME")
            # Public docker-compose name (see /.env.example).
            or os.getenv("VLLM_MODEL")
            or os.getenv("AMD_LLM_MODEL")
            or self.DEFAULT_MODEL
        )

        # 4096 was tight for a 4-8 chapter saga with panels; truncated JSON was
        # guaranteed to hit the repair loop. But this is a *ceiling*: the real
        # value is clamped against the model's context window on every call,
        # because prompt + max_tokens must fit inside it.
        self._max_tokens = (
            max_tokens
            if max_tokens is not None
            else _env_int("AMD_LLM_MAX_TOKENS", 6144)
        )
        self._context_window = _env_int("AMD_LLM_CONTEXT_WINDOW", 8192)
        self._context_margin = 64
        self._allow_fallback = (
            allow_fallback
            if allow_fallback is not None
            else _env_flag("AMD_LLM_ALLOW_FALLBACK", True)
        )
        self._json_mode = (
            json_mode if json_mode is not None else _env_flag("AMD_LLM_JSON_MODE", True)
        )

        resolved_read_timeout = (
            read_timeout
            if read_timeout is not None
            else _env_float("AMD_LLM_READ_TIMEOUT", 180.0)
        )

        self._client = AsyncOpenAI(
            base_url=self._base_url,
            api_key=self._api_key,
            timeout=httpx.Timeout(resolved_read_timeout, connect=connect_timeout),
            max_retries=0,  # we control retries ourselves
        )

    # ------------------------------------------------------------------ ctx
    async def aclose(self) -> None:
        await self._client.close()

    async def __aenter__(self) -> "AMDService":
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self.aclose()

    # ------------------------------------------------------------------ http
    def _estimate_prompt_tokens(self, messages: list[dict[str, str]]) -> int:
        chars = sum(len(m.get("content") or "") for m in messages)
        return int(chars / _CHARS_PER_TOKEN)

    def _effective_max_tokens(
        self, messages: list[dict[str, str]], override: int | None
    ) -> int:
        """Clamp the output budget so prompt + output fits the context window."""
        ceiling = override if override is not None else self._max_tokens
        estimated_input = self._estimate_prompt_tokens(messages)
        available = self._context_window - estimated_input - self._context_margin
        if available < 512:
            raise AMDLLMError(
                f"Prompt trop long pour le modele : ~{estimated_input} tokens d'entree "
                f"pour une fenetre de {self._context_window}. "
                "Reduis le nombre de commits analyses (parametre `limit`)."
            )
        return max(512, min(ceiling, available))

    @staticmethod
    def _fit_to_context(message: str) -> int | None:
        """Extract the exact usable output budget from vLLM's overflow error."""
        window_match = _CONTEXT_WINDOW_RE.search(message)
        input_match = _INPUT_TOKENS_RE.search(message)
        if not window_match or not input_match:
            return None
        return int(window_match.group(1)) - int(input_match.group(1)) - 64

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=0.5, min=0.5, max=4),
        retry=retry_if_exception_type(APIStatusError),
        reraise=True,
    )
    async def _chat(
        self,
        messages: list[dict[str, str]],
        *,
        temperature: float,
        max_tokens: int | None = None,
    ) -> str:
        budget = self._effective_max_tokens(messages, max_tokens)
        kwargs: dict[str, Any] = {
            "model": self._model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": budget,
        }
        if self._json_mode:
            kwargs["response_format"] = {"type": "json_object"}

        try:
            resp = await self._client.chat.completions.create(**kwargs)
        except BadRequestError as exc:
            detail = str(exc)

            # 1. Context overflow. vLLM reports the exact input size, so we can
            #    retry with a budget that fits instead of giving up. This is the
            #    failure that a large `max_tokens` guarantees on an 8k model.
            fitted = self._fit_to_context(detail)
            if fitted is not None:
                if fitted >= budget:
                    raise AMDLLMError(
                        "vLLM rejected the prompt for context length, but the "
                        "reported budget still fits — aborting instead of "
                        f"retrying the same request. {detail[:300]}"
                    ) from exc
                if fitted < 512:
                    raise AMDLLMError(
                        "Prompt leaves no room for output "
                        f"(context {self._context_window}, input reported larger). "
                        "Reduis le nombre de commits analyses."
                    ) from exc
                logger.warning(
                    "vLLM context overflow — retrying with max_tokens=%d (was %d).",
                    fitted,
                    budget,
                )
                return await self._chat(
                    messages, temperature=temperature, max_tokens=fitted
                )

            # 2. Some vLLM builds / model templates reject response_format
            #    outright. Disable it once and retry. Must be checked *after*
            #    the context case: conflating the two burned the retry.
            if self._json_mode:
                logger.warning(
                    "vLLM rejected response_format=json_object (%s) — "
                    "retrying without guided JSON.",
                    detail[:200],
                )
                self._json_mode = False
                return await self._chat(
                    messages, temperature=temperature, max_tokens=budget
                )
            raise AMDLLMError(f"vLLM rejected the request: {detail}") from exc
        except APIStatusError as exc:
            if exc.status_code in _TRANSIENT_STATUS:
                raise  # retried by tenacity, then surfaces to the fallback
            raise AMDLLMError(f"vLLM API error {exc.status_code}: {exc.message}") from exc

        content = resp.choices[0].message.content if resp.choices else None
        if not content or not content.strip():
            raise AMDLLMError("vLLM returned an empty completion.")
        return content

    # -------------------------------------------------------------- pipeline
    async def generate_saga(
        self,
        commits: list[CommitInfo],
        *,
        repo_url: str,
        language: SagaLanguage = "en",
        temperature: float = 0.4,
        max_repair_attempts: int = 2,
    ) -> SagaPayload:
        """
        Generate a SagaPayload from commits. Falls back to the local mock on any
        connection error, timeout, or unrecoverable LLM failure.
        """
        try:
            return await self._generate_saga_strict(
                commits,
                repo_url=repo_url,
                language=language,
                temperature=temperature,
                max_repair_attempts=max_repair_attempts,
            )
        except AMDLLMError as exc:
            logger.error("AMD vLLM pipeline failed: %s — falling back to mock.", exc)
        except (
            # BUGFIX: the original only caught connection-level errors.
            # `APIStatusError` (persistent 429/503) inherits from `APIError`, not
            # from `APIConnectionError`, so after tenacity exhausted its retries
            # it escaped this handler entirely and produced a raw HTTP 500
            # instead of the mock fallback.
            APIError,  # umbrella: APIStatusError, APIConnectionError, APITimeoutError
            asyncio.TimeoutError,
            httpx.TimeoutException,
        ) as exc:
            logger.warning(
                "AMD vLLM unreachable or erroring (%s: %s) — falling back to mock.",
                type(exc).__name__,
                exc,
            )

        if not self._allow_fallback:
            raise AMDLLMError("AMD vLLM unreachable and fallback is disabled.")

        return self.load_fallback_saga(repo_url, language)

    async def _generate_saga_strict(
        self,
        commits: list[CommitInfo],
        *,
        repo_url: str,
        language: SagaLanguage = "en",
        temperature: float,
        max_repair_attempts: int,
    ) -> SagaPayload:
        if not commits:
            raise AMDLLMError("Cannot generate a saga from an empty commit list.")

        messages: list[dict[str, str]] = [
            {"role": "system", "content": _system_prompt(language)},
            {
                "role": "user",
                "content": self._build_user_prompt(commits, repo_url, language=language),
            },
        ]

        last_err: Exception | None = None
        for attempt in range(max_repair_attempts + 1):
            content = await self._chat(messages, temperature=temperature)
            try:
                data = extract_json_object(content)
                saga = SagaPayload.model_validate(data)
                self._audit_bot_hero(saga, commits)
                self._enrich_cast(saga, commits)
                attach_artwork(saga, repo_url)
                return saga
            except (ValueError, ValidationError) as exc:
                last_err = exc
                logger.debug("Repair attempt %d failed: %s", attempt + 1, exc)
                if attempt >= max_repair_attempts:
                    break
                # Keep the echo short: this assistant turn is added *on top of*
                # the full system prompt + commit list, and an 8k model cannot
                # afford a 6000-char transcript plus a fresh completion. The
                # previous value overflowed the window and killed every repair.
                messages.append(
                    {"role": "assistant", "content": content[:_REPAIR_ECHO_CHARS]}
                )
                messages.append(
                    {
                        "role": "user",
                        "content": (
                            "Your previous response was rejected. "
                            "VALIDATION ERRORS:\n"
                            f"{summarize_validation_error(exc) if isinstance(exc, ValidationError) else exc}\n"
                            "Return ONLY a single valid JSON object matching the "
                            "SagaPayload schema and its EXACT key names. "
                            "No markdown, no commentary."
                        ),
                    }
                )

        raise AMDLLMError(f"vLLM failed to produce a valid SagaPayload: {last_err}")

    # -------------------------------------------------------------- bot audit
    @staticmethod
    def _enrich_cast(saga: SagaPayload, commits: list[CommitInfo]) -> None:
        """Attach real Git metrics to the cast, keyed by contributor handle.

        The roster screen renders commit/PR/streak counters, and the LLM has no
        business inventing them. Matching is by slug (the same normalisation
        used for `character_id`) so "Tiangolo", "tiangolo" and "tiangolo[bot]"
        all resolve to the same contributor bucket.
        """
        stats = AMDService._aggregate_contributors(commits)
        by_key = {slugify_id(handle): bucket for handle, bucket in stats.items()}

        activity: dict[str, dict[str, Any]] = {}
        for commit in commits:
            handle = commit.author_login or commit.author_name
            key = slugify_id(handle)
            bucket = activity.setdefault(key, {"prs": 0, "days": set()})
            message = commit.message or ""
            # GitHub squash-merge titles end with "(#1234)".
            if _PR_REF_RE.search(message) or "merge pull request" in message.lower():
                bucket["prs"] += 1
            bucket["days"].add(commit.authored_at.date())

        def resolve(character: Character) -> str | None:
            candidates = (
                slugify_id(character.character_id),
                slugify_id(character.name),
            )
            for candidate in candidates:
                if candidate in by_key:
                    return candidate
            # "Latest Changes Bot" -> latest_changes_bot matches the handle
            # "latest-changes[bot]" exactly after slugging, but names such as
            # "Tiangolo the Paladin" need a guarded prefix match.
            for candidate in candidates:
                if len(candidate) < 6:
                    continue
                for key in by_key:
                    if key.startswith(candidate) or candidate.startswith(key):
                        return key
            return None

        def apply(character: Character) -> None:
            key = resolve(character)
            if key is None:
                return
            bucket = by_key[key]  # `stats` is keyed by raw handle, `by_key` by slug
            act = activity.get(key, {"prs": 0, "days": set()})
            character.commits = bucket["count"]
            character.prs = act["prs"]
            character.streak = len(act["days"])
            character.is_bot = bucket["is_bot"]

        for character in saga.characters:
            apply(character)
        apply(saga.hero)

    @staticmethod
    def _audit_bot_hero(saga: SagaPayload, commits: list[CommitInfo]) -> None:
        """Defense in depth for the PM rule "a bot must never be the hero".

        The system prompt forbids it, but an 8B model can still ignore an
        instruction. Rejecting the whole saga over it would be worse than the
        problem, so we promote the strongest human and record a warning.
        """
        bot_ids: set[str] = set()
        for commit in commits:
            if commit.is_bot:
                for handle in (commit.author_login, commit.author_name):
                    if handle:
                        bot_ids.add(slugify_id(handle))
        if not bot_ids:
            return

        def looks_like_bot(candidate: str) -> bool:
            # Compare with separators stripped: the model freely writes
            # "latest_changes_bot", "latest-changes-bot" or "LatestChangesBot"
            # for the same GitHub handle.
            cand = candidate.replace("_", "")
            for bot_id in bot_ids:
                bot = bot_id.replace("_", "")
                if cand == bot:
                    return True
                # Models also truncate the handle ("latest_changes" for
                # "latest-changes[bot]"). Only trust a prefix match when the
                # overlap is long enough to be meaningful — otherwise a short
                # id like "ci" would swallow every character.
                if len(cand) >= 6 and (bot.startswith(cand) or cand.startswith(bot)):
                    return True
            return False

        if not looks_like_bot(saga.hero.character_id):
            return

        human_ids = [
            c.character_id
            for c in saga.characters
            if c.character_id != "narrator" and not looks_like_bot(c.character_id)
        ]
        if not human_ids:
            saga.warnings.append(
                f"lore: hero {saga.hero.character_id!r} is a bot account and no human "
                "contributor was found in the analysed window"
            )
            return

        previous_hero = saga.hero
        promoted = next(c for c in saga.characters if c.character_id == human_ids[0])
        # `include=` rather than `exclude=`: `promoted` may be a `Hero` (the cast
        # can hold one), and passing its own `stats`/`catchphrase` alongside the
        # explicit kwargs is a TypeError.
        saga.hero = Hero(
            **promoted.model_dump(
                include={"character_id", "name", "role", "rpg_class", "level"}
            ),
            stats=previous_hero.stats,
            catchphrase=previous_hero.catchphrase,
        )
        saga.characters.sort(key=lambda c: c.character_id != human_ids[0])
        saga.warnings.append(
            f"lore: hero {previous_hero.character_id!r} is a bot account — "
            f"promoted {human_ids[0]!r} to hero instead"
        )

    # -------------------------------------------------------------- fallback
    @staticmethod
    def load_fallback_saga(
        repo_url: str = DEFAULT_REPO_URL,
        language: SagaLanguage | str = "en",
    ) -> SagaPayload:
        """Load and validate the local mock for the requested language.

        `mock_saga_fr.json` is a full French translation of the default mock:
        same ids, keys, enums and numbers, so it validates against the exact
        same `SagaPayload`. If the French sibling is missing we degrade to the
        English one rather than failing the demo.

        Artwork URLs are attached here too, so the offline demo still renders
        real FLUX illustrations (deterministic for the demo repository).
        """
        lang = normalize_language(language)
        path = MOCK_SAGA_PATHS.get(lang)
        if path is None or not path.is_file():
            if lang != "en":
                logger.warning("Mock for language=%r missing — using English mock.", lang)
            path = MOCK_SAGA_PATH
        if not path.is_file():
            raise AMDLLMError(f"Fallback mock not found at {path}")
        raw = json.loads(path.read_text(encoding="utf-8"))
        try:
            saga = SagaPayload.model_validate(raw)
        except ValidationError as exc:
            raise AMDLLMError(
                f"Fallback mock is invalid against SagaPayload: {exc}"
            ) from exc
        return attach_artwork(saga, repo_url)

    # ------------------------------------------------------------- prompting
    @staticmethod
    def _first_line(message: str) -> str:
        """First non-empty line of a commit message.

        BUGFIX: `message.splitlines()[0]` raised IndexError on an empty commit
        message, which is legal in Git and common in generated/merge commits.
        """
        for line in (message or "").splitlines():
            if line.strip():
                return line.strip()[:180]
        return "(no commit message)"

    @staticmethod
    def _aggregate_contributors(commits: list[CommitInfo]) -> dict[str, dict[str, Any]]:
        """Group commits by author handle.

        A handle flagged as a bot on *any* commit counts as a bot, so a single
        unflagged commit cannot promote automation back into the human cast.
        """
        stats: dict[str, dict[str, Any]] = {}
        for commit in commits:
            handle = commit.author_login or commit.author_name
            bucket = stats.setdefault(
                handle,
                {"count": 0, "additions": 0, "deletions": 0, "is_bot": False},
            )
            bucket["count"] += 1
            bucket["additions"] += commit.additions
            bucket["deletions"] += commit.deletions
            bucket["is_bot"] = bucket["is_bot"] or commit.is_bot
        return stats

    @classmethod
    def _build_user_prompt(
        cls,
        commits: list[CommitInfo],
        repo_url: str,
        language: SagaLanguage = "en",
    ) -> str:
        # BUGFIX: GitHub returns commits newest-first, and the old prompt passed
        # them through in that order while asking for a *saga*. A story has to
        # start at the genesis commit, so we sort chronologically.
        ordered = sorted(commits, key=lambda c: c.authored_at)

        stats = cls._aggregate_contributors(ordered)
        humans = sorted(
            ((h, s) for h, s in stats.items() if not s["is_bot"]),
            key=lambda kv: (-kv[1]["count"], -kv[1]["additions"], kv[0]),
        )
        automatons = sorted(
            ((h, s) for h, s in stats.items() if s["is_bot"]),
            key=lambda kv: (-kv[1]["count"], kv[0]),
        )

        lines = [
            f"Repository: {repo_url}",
            f"Commit count: {len(ordered)}",
            f"Window: {ordered[0].authored_at.date()} -> {ordered[-1].authored_at.date()}",
            "",
            "# CONTRIBUTORS",
        ]

        if humans:
            handle, top = humans[0]
            lines.append(
                f"dominant_human_contributor: {handle} "
                f"({top['count']} commits, +{top['additions']}/-{top['deletions']}) "
                "<-- the hero MUST be this contributor"
            )
        else:
            owner = urlparse(repo_url).path.strip("/").split("/")[0] or "the maintainer"
            lines.append(
                "dominant_human_contributor: NONE — every commit in this window was "
                "authored by automation."
            )
            lines.append(
                f"You must still write a human hero: use the repository owner "
                f"({owner!r}) as the protagonist, and cast the automatons below as "
                "their summoned support golems."
            )

        if len(humans) > 1:
            lines.append("other human contributors:")
            for handle, s in humans[1:]:
                lines.append(
                    f"  - {handle} ({s['count']} commits, "
                    f"+{s['additions']}/-{s['deletions']})"
                )

        if automatons:
            lines.append("active_automatons:")
            for handle, s in automatons:
                lines.append(
                    f"  - {handle} ({s['count']} commits) "
                    "-> mechanical sidekick / ancient automaton. NEVER the hero."
                )
        else:
            lines.append("active_automatons: none detected")

        lines += ["", "Commits, oldest first (chronological — this is the order of your saga):"]
        for commit in ordered:
            # Compact on purpose: the prompt must fit an 8k window alongside a
            # full saga completion, and the LLM never references SHAs or times.
            lines.append(
                f"- {commit.author_login or commit.author_name}"
                f"{' [AUTOMATON]' if commit.is_bot else ''} | "
                f"+{commit.additions}/-{commit.deletions} | "
                f"{commit.files_changed} files | "
                f"{commit.authored_at.date().isoformat()} | "
                f"{cls._first_line(commit.message)[:_COMMIT_MSG_CHARS]}"
            )
        lines.append("")
        lines.append(
            f"Output language: {'French' if language == 'fr' else 'English'} — "
            "chapter titles, captions and dialogues must be written in that language."
        )
        lines.append(
            "Generate the SagaPayload JSON now. Follow the schema, the cast rules "
            "and the visual consistency rules exactly."
        )
        return "\n".join(lines)
