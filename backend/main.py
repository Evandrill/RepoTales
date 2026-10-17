# backend/main.py
"""RepoTales FastAPI entrypoint.

Run from the repository root:
    uvicorn backend.main:app --reload --port 8080

Interactive schema: http://localhost:8080/docs
"""

from __future__ import annotations

import logging
import os

import backend  # noqa: F401  — loads backend/.env as an import side effect
from backend.routers import image, saga
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
)

app = FastAPI(
    title="RepoTales API",
    version="0.1.0",
    description=(
        "Transforme un depot GitHub public en saga manga/RPG 2D. "
        "GitHub REST pour l'historique, vLLM sur GPU AMD pour la narration."
    ),
)

# The Vite dev server is a different origin, so CORS is mandatory in dev.
# `allow_credentials` stays False: we use no cookies, and True would make the
# wildcard origin illegal per the CORS spec.
_cors_origins = [o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(saga.router)
app.include_router(image.router)


@app.get("/", tags=["meta"])
async def root() -> dict[str, str]:
    return {"service": "RepoTales API", "docs": "/docs", "health": "/health"}


@app.get("/health", tags=["meta"])
async def health() -> dict[str, object]:
    """Report which backends are configured, so a broken demo is diagnosable."""
    return {
        "status": "ok",
        # Accept both the historical AMD_* names and the public compose names.
        "llm_base_url": (
            os.getenv("AMD_LLM_BASE_URL")
            or os.getenv("VLLM_BASE_URL")
            or "http://localhost:8000/v1"
        ),
        "llm_model": (
            os.getenv("AMD_MODEL_NAME")
            or os.getenv("VLLM_MODEL")
            or "meta-llama/Meta-Llama-3.1-8B-Instruct"
        ),
        "github_token_configured": bool(os.getenv("GITHUB_TOKEN")),
        "llm_fallback_enabled": os.getenv("AMD_LLM_ALLOW_FALLBACK", "true").lower()
        in {"1", "true", "yes", "on"},
        "image_server_url": (
            os.getenv("AMD_IMAGE_SERVER_URL")
            or os.getenv("FLUX_BASE_URL")
            or "http://129.212.191.240:8001/generate-image"
        ),
        "images_enabled": os.getenv("AMD_IMAGE_ENABLED", "true").lower()
        in {"1", "true", "yes", "on"},
        "evolus_workspace_configured": bool(os.getenv("EVOLUS_WORKSPACE_ID")),
    }
