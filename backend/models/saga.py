# backend/models/saga.py
"""Pydantic contracts for the RepoTales saga payload.

This is the boundary between the LLM and the frontend: everything the renderer
needs is declared here, and anything that would break the renderer is either
repaired or reported in `SagaPayload.warnings`.

Design rule: **hard-fail only on things that are unrenderable** (wrong types,
unknown enum members, empty chapters). Semantic drift — a dangling `speaker_id`,
an off-spec chapter count — is auto-healed or logged as a warning, because a
repair round-trip against an 8B model is expensive and falling back to the mock
loses the whole point of the demo.
"""

from __future__ import annotations

import re
import unicodedata
from enum import Enum

from pydantic import BaseModel, Field, field_validator, model_validator

# --------------------------------------------------------------------------- #
# Constants                                                                   #
# --------------------------------------------------------------------------- #
NARRATOR_ID = "narrator"

MIN_CHAPTERS = 4
MAX_CHAPTERS = 8

MAX_BUBBLE_CHARS = 140
MAX_BUBBLES_PER_PANEL = 4
MAX_PANELS_PER_CHAPTER = 6

_ID_MAX = 64
# Only [a-z0-9_] survives. `-` and `.` are folded to `_` on purpose: the
# contract says snake_case, and the LLM freely mixes `latest-changes[bot]`
# (GitHub) with `latest_changes_bot` (what it writes). Treating those as
# different ids breaks both the speaker linking and the bot audit.
_UNSAFE_ID_CHARS = re.compile(r"[^a-z0-9_]+")
_REPEATED_UNDERSCORE = re.compile(r"_{2,}")


def slugify_id(value: str) -> str:
    """Normalise a character id to a stable, ASCII, snake_case key.

    Contributors show up as "Aria Nakamura", "aria-nakamura" or "Ária" depending
    on the LLM's mood, and GitHub handles carry hyphens and `[bot]` markers.
    Normalising *both* `Character.character_id` and `DialogueBubble.speaker_id`
    through this function is what makes the cast <-> dialogue link reliable.
    """
    ascii_value = (
        unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    )
    slug = _UNSAFE_ID_CHARS.sub("_", ascii_value.strip().lower())
    slug = _REPEATED_UNDERSCORE.sub("_", slug).strip("_")
    return slug[:_ID_MAX] or "unknown"


# --------------------------------------------------------------------------- #
# Enums                                                                       #
# --------------------------------------------------------------------------- #
class Emotion(str, Enum):
    NEUTRAL = "neutral"
    JOYFUL = "joyful"
    DETERMINED = "determined"
    ANGRY = "angry"
    SAD = "sad"
    ANXIOUS = "anxious"
    SHOCKED = "shocked"


class BubbleStyle(str, Enum):
    SPEECH = "speech"
    SHOUT = "shout"
    WHISPER = "whisper"
    THOUGHT = "thought"
    NARRATION = "narration"


class ShotType(str, Enum):
    WIDE = "wide"
    MEDIUM = "medium"
    CLOSE_UP = "close_up"
    EXTREME_CLOSE_UP = "extreme_close_up"


class PoseType(str, Enum):
    IDLE = "idle"
    TYPING_FURIOUS = "typing_furious"
    POINTING = "pointing"
    HEAD_IN_HANDS = "head_in_hands"
    VICTORY = "victory"
    SHOCKED = "shocked"


class ReadingDirection(str, Enum):
    LTR = "ltr"
    RTL = "rtl"


# --------------------------------------------------------------------------- #
# Panels                                                                      #
# --------------------------------------------------------------------------- #
class DialogueBubble(BaseModel):
    speaker_id: str = Field(
        ...,
        max_length=_ID_MAX,
        description=f"character_id d'un membre du casting, ou {NARRATOR_ID!r}.",
    )
    text: str = Field(..., min_length=1, max_length=MAX_BUBBLE_CHARS)
    emotion: Emotion = Emotion.NEUTRAL
    bubble_style: BubbleStyle = BubbleStyle.SPEECH

    @field_validator("speaker_id", mode="before")
    @classmethod
    def _normalise_speaker(cls, value: object) -> object:
        if not isinstance(value, str):
            return value
        return slugify_id(value)


class Panel(BaseModel):
    scene: str = Field(..., min_length=1, max_length=600)
    # NOTE: `shot`/`pose` are defaulted rather than required. A missing shot is
    # purely cosmetic, and making it required costs a full repair round-trip
    # (and often the mock fallback) for a value the renderer can guess.
    shot: ShotType = ShotType.MEDIUM
    pose: PoseType = PoseType.IDLE
    emotion: Emotion = Emotion.NEUTRAL
    bubbles: list[DialogueBubble] = Field(
        default_factory=list, max_length=MAX_BUBBLES_PER_PANEL
    )
    # Server-owned: filled by `image_service.attach_artwork()`. The LLM never
    # sees this field in the prompt schema, and any value it invents is
    # overwritten before the payload leaves the backend.
    image_url: str | None = Field(None, max_length=4096)


class Chapter(BaseModel):
    # No `ge=1` here on purpose: `_heal_and_audit` renumbers every chapter to
    # 1..N, so a 0-based or gapped list from the LLM is repaired rather than
    # rejected. A constraint would fire *before* the root validator had a
    # chance to fix it, turning a cosmetic drift into a full repair round-trip.
    index: int = Field(1)
    title: str = Field(..., min_length=1, max_length=200)
    summary: str = Field(..., min_length=1, max_length=800)
    panels: list[Panel] = Field(..., min_length=1, max_length=MAX_PANELS_PER_CHAPTER)


class BossFight(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    description: str = Field(..., min_length=1, max_length=1200)
    stakes: str = Field(..., min_length=1, max_length=800)
    phases: list[str] = Field(..., min_length=1, max_length=6)
    outcome: str = Field(..., min_length=1, max_length=800)
    panels: list[Panel] = Field(default_factory=list)
    # Server-owned (see Panel.image_url).
    sprite_url: str | None = Field(None, max_length=4096)


# --------------------------------------------------------------------------- #
# Cast                                                                        #
# --------------------------------------------------------------------------- #
class Character(BaseModel):
    character_id: str = Field(..., max_length=_ID_MAX)
    name: str = Field(..., min_length=1, max_length=120)
    role: str = Field(..., min_length=1, max_length=120)
    rpg_class: str = Field(..., min_length=1, max_length=120)
    level: int = Field(ge=1, le=99)

    # Server-owned Git metrics, filled by `AMDService._enrich_cast` after
    # validation. Defaulted so the LLM never has to produce them (it would
    # hallucinate) and so older payloads keep validating.
    commits: int = Field(0, ge=0)
    prs: int = Field(0, ge=0)
    streak: int = Field(0, ge=0)
    is_bot: bool = False

    # Server-owned deterministic FLUX portrait (see Panel.image_url).
    avatar_url: str | None = Field(None, max_length=4096)

    @field_validator("character_id", mode="before")
    @classmethod
    def _normalise_id(cls, value: object) -> object:
        if not isinstance(value, str):
            return value
        return slugify_id(value)


class Hero(Character):
    stats: dict[str, int] = Field(default_factory=dict)
    catchphrase: str | None = Field(None, max_length=300)


# --------------------------------------------------------------------------- #
# Root                                                                        #
# --------------------------------------------------------------------------- #
class SagaPayload(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    synopsis: str = Field(..., min_length=1, max_length=2000)
    reading_direction: ReadingDirection = ReadingDirection.RTL
    hero: Hero
    characters: list[Character] = Field(default_factory=list)
    chapters: list[Chapter] = Field(..., min_length=1, max_length=MAX_CHAPTERS)
    boss_fight: BossFight
    warnings: list[str] = Field(
        default_factory=list,
        description="Réparations et incohérences détectées à la validation.",
    )

    @model_validator(mode="after")
    def _heal_and_audit(self) -> "SagaPayload":
        warnings: list[str] = []

        # 1. Dedupe the cast, the hero always first (it is the protagonist, and
        #    the character-select screen renders in list order).
        by_id: dict[str, Character] = {}
        if self.hero.character_id not in {c.character_id for c in self.characters}:
            warnings.append(
                f"cast: hero {self.hero.character_id!r} was missing, injected"
            )
        by_id[self.hero.character_id] = Character(
            **self.hero.model_dump(
                include={
                    "character_id",
                    "name",
                    "role",
                    "rpg_class",
                    "level",
                    "commits",
                    "prs",
                    "streak",
                    "is_bot",
                    "avatar_url",
                }
            )
        )
        for character in self.characters:
            if character.character_id == self.hero.character_id:
                continue
            if character.character_id in by_id:
                warnings.append(
                    f"cast: duplicate character_id {character.character_id!r} dropped"
                )
                continue
            by_id[character.character_id] = character
        self.characters = list(by_id.values())

        # 2. Renumber chapters so a 0-based or gapped list still renders in order.
        for position, chapter in enumerate(self.chapters, start=1):
            if chapter.index != position:
                chapter.index = position

        # 3. Chapter count is narrative guidance, not a renderability constraint.
        if not MIN_CHAPTERS <= len(self.chapters) <= MAX_CHAPTERS:
            warnings.append(
                f"pacing: {len(self.chapters)} chapters "
                f"(prompt asks for {MIN_CHAPTERS}-{MAX_CHAPTERS})"
            )

        # 4. Dangling speakers: the frontend falls back to a neutral portrait,
        #    we just record them so a bad generation is visible in the logs.
        known = set(by_id) | {NARRATOR_ID}
        unknown: set[str] = set()
        for panel in self._iter_all_panels():
            for bubble in panel.bubbles:
                if bubble.speaker_id not in known:
                    unknown.add(bubble.speaker_id)
        for speaker in sorted(unknown):
            warnings.append(
                f"cast: unknown speaker_id {speaker!r} "
                "(frontend should use a neutral portrait)"
            )

        # 5. A boss fight with no panels renders as an empty screen.
        if not self.boss_fight.panels:
            warnings.append("boss_fight: no panels, the boss screen will be empty")

        self.warnings = warnings
        return self

    def _iter_all_panels(self):
        for chapter in self.chapters:
            yield from chapter.panels
        yield from self.boss_fight.panels


# `Chapter.panels` is annotated before `Panel` exists, so resolve forward refs
# explicitly once every model is defined.
SagaPayload.model_rebuild()
