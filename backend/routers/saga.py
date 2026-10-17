# backend/routers/saga.py
from __future__ import annotations

import logging
from typing import Literal

import httpx
from fastapi import APIRouter, BackgroundTasks, HTTPException, Query
from pydantic import BaseModel, Field, HttpUrl

from backend.models.saga import SagaPayload
from backend.services.amd_service import AMDLLMError, AMDService
from backend.services.github_service import (
    MAX_COMMITS_PER_REQUEST,
    GitHubService,
    GitHubServiceError,
)
from backend.services.image_service import pregenerate_saga_artwork

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/saga", tags=["saga"])


class GenerateRequest(BaseModel):
    repo_url: HttpUrl
    # BUGFIX: unbounded, `limit` let a caller request 10_000 commits, which
    # means 10_000 GitHub API calls (N+1 detail fetches) and a guaranteed
    # quota wipe. Each commit costs one extra request, so this is the single
    # most expensive knob in the API.
    limit: int = Field(
        15,
        ge=1,
        le=MAX_COMMITS_PER_REQUEST,
        description="Nombre de commits analyses. Cout GitHub = 1 + limit requetes.",
    )
    # Language of the *generated prose* (titles, captions, dialogues, boss).
    # The UI is translated client-side; this only steers the LLM. Keys and
    # enum values always stay English so Pydantic validation is unaffected.
    language: Literal["en", "fr"] = Field(
        "en",
        description="Langue du contenu genere (titres, legendes, dialogues).",
    )


@router.post(
    "/generate",
    response_model=SagaPayload,
    summary="Genere la saga manga d'un depot GitHub",
)
async def generate(req: GenerateRequest, background: BackgroundTasks) -> SagaPayload:
    repo_url = str(req.repo_url)
    logger.info(
        "Generating saga for %s (limit=%d, language=%s)",
        repo_url,
        req.limit,
        req.language,
    )

    try:
        async with GitHubService() as github:
            commits = await github.fetch_recent_commits(repo_url, limit=req.limit)

        async with AMDService() as llm:
            saga = await llm.generate_saga(
                commits,
                repo_url=repo_url,
                language=req.language,
            )
    except GitHubServiceError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except AMDLLMError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except httpx.HTTPError as exc:
        # Belt and braces: both services convert their transport errors, but a
        # raw httpx error must never surface as an unhandled 500.
        logger.exception("Unhandled transport error while generating saga")
        raise HTTPException(status_code=502, detail=f"Erreur reseau : {exc}") from exc

    if saga.warnings:
        logger.info("Saga generated with %d warning(s): %s", len(saga.warnings), saga.warnings)
    # Pre-generate artwork *after* the response is sent: the client renders the
    # saga immediately while the GPU warms squad + later chapters in the
    # background (bounded by AMD_IMAGE_CONCURRENCY).
    background.add_task(pregenerate_saga_artwork, saga)
    return saga


@router.get(
    "/mock",
    response_model=SagaPayload,
    summary="Saga de demonstration, sans appel GitHub ni LLM",
)
async def mock_saga(
    background: BackgroundTasks,
    lang: Literal["en", "fr"] | None = Query(
        None,
        description="Langue de la saga de demonstration (`fr` ou `en`).",
    ),
    language: Literal["en", "fr"] | None = Query(
        None,
        description="Alias de `lang` (compatibilite client).",
    ),
) -> SagaPayload:
    """Serve the bundled mock in the requested language.

    `?lang=fr` (or the `language=fr` alias) returns the fully translated French
    mock — chapter titles, captions, dialogues and boss name included. The
    frontend demo button passes the current UI language, so an FR visitor never
    gets English prose before the first real generation.

    The frontend should build against this: it returns instantly, costs no
    GitHub quota and no GPU time, and has exactly the shape of a real response.
    Artwork is still pre-generated in the background so the offline demo shows
    real FLUX illustrations once the client requests them.
    """
    selected = lang or language or "en"
    try:
        saga = AMDService.load_fallback_saga(language=selected)
    except AMDLLMError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    background.add_task(pregenerate_saga_artwork, saga)
    return saga
