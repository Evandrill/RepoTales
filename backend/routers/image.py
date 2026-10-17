# backend/routers/image.py
"""FLUX.1-schnell proxy for the RepoTales frontend.

The browser must never call the GPU box directly:
- the FLUX host sends no CORS headers, so `fetch()` would be blocked;
- an `https://` frontend would refuse the `http://` image (mixed content);
- the image server should not be publicly hammerable with arbitrary prompts.

`GET /api/image-proxy?prompt=...&seed=...` is what `<img src>` uses (HTML can
only issue GETs). The same path also accepts POST JSON for scripts and tests.
Both aliases (`/image-proxy` and `/api/image-proxy`) are registered because the
Vite dev proxy strips the `/api` prefix while the backend itself is mounted at
the root.
"""

from __future__ import annotations

import hashlib
import logging

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field

from backend.services.image_service import (
    DEFAULT_STEPS,
    MAX_STEPS,
    ImageQueueSaturated,
    ImageServiceError,
    generate_image,
    image_media_type,
    image_server_status,
    images_enabled,
    server_fingerprint,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["image"])

# FLUX.1-schnell is distilled for 1-4 steps; 2 is the sweet spot at 384px.
_MAX_SIZE = 1536
_CACHE_CONTROL = "public, max-age=86400, immutable"


class ImageRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=1000)
    seed: int = Field(0, ge=0, le=2**32 - 1)
    width: int = Field(384, ge=64, le=_MAX_SIZE)
    height: int = Field(384, ge=64, le=_MAX_SIZE)
    steps: int = Field(DEFAULT_STEPS, ge=1, le=MAX_STEPS)


def _etag(prompt: str, seed: int, width: int, height: int, steps: int) -> str:
    # The upstream fingerprint is part of the validator too: an old URL kept in
    # a browser must not be answered 304 after AMD_IMAGE_SERVER_URL changed.
    digest = hashlib.sha256(
        f"{server_fingerprint()}|{prompt}|{seed}|{width}|{height}|{steps}".encode("utf-8")
    ).hexdigest()[:32]
    return f'"{digest}"'


async def _serve(
    prompt: str,
    seed: int,
    width: int,
    height: int,
    steps: int,
    request: Request,
) -> Response:
    tag = _etag(prompt, seed, width, height, steps)
    if request.headers.get("if-none-match") == tag:
        return Response(status_code=304, headers={"ETag": tag, "Cache-Control": _CACHE_CONTROL})

    # A deployment without a GPU must not keep triggering upstream jobs.
    if not images_enabled():
        raise HTTPException(status_code=503, detail="Generation d'images desactivee.")

    try:
        data = await generate_image(
            prompt, seed=seed, width=width, height=height, steps=steps
        )
    except ImageQueueSaturated as exc:
        # Temporary overload, not an upstream failure: 503 + Retry-After.
        logger.warning("Image proxy queue saturated: %s", exc)
        raise HTTPException(
            status_code=503,
            detail=str(exc),
            headers={"Retry-After": "5"},
        ) from exc
    except ImageServiceError as exc:
        logger.warning("Image proxy failed: %s", exc)
        status = image_server_status()
        if status["circuit_open"]:
            # 503 + Retry-After tells the browser the GPU box is down rather
            # than making it wait through the full generation timeout.
            raise HTTPException(
                status_code=503,
                detail=str(exc),
                headers={"Retry-After": str(max(1, int(status["retry_in_seconds"])))},
            ) from exc
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    media_type = image_media_type(data)
    return Response(
        content=data,
        media_type=media_type,
        headers={
            "Cache-Control": _CACHE_CONTROL,
            "ETag": tag,
            "X-Image-Seed": str(seed),
            "X-Image-Size": f"{width}x{height}",
        },
    )


@router.get(
    "/image-proxy",
    summary="Genere (ou sert depuis le cache) une illustration FLUX",
)
@router.get("/api/image-proxy", include_in_schema=False)
async def image_proxy_get(
    request: Request,
    prompt: str = Query(..., min_length=1, max_length=1000),
    seed: int = Query(0, ge=0, le=2**32 - 1),
    width: int = Query(384, ge=64, le=_MAX_SIZE),
    height: int = Query(384, ge=64, le=_MAX_SIZE),
    steps: int = Query(DEFAULT_STEPS, ge=1, le=MAX_STEPS),
) -> Response:
    return await _serve(prompt, seed, width, height, steps, request)


@router.post(
    "/image-proxy",
    summary="Variante JSON du proxy d'images (scripts, tests)",
)
@router.post("/api/image-proxy", include_in_schema=False)
async def image_proxy_post(request: Request, payload: ImageRequest) -> Response:
    return await _serve(
        payload.prompt,
        payload.seed,
        payload.width,
        payload.height,
        payload.steps,
        request,
    )
