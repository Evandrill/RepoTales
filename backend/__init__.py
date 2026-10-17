"""RepoTales backend package.

`.env` files are loaded here rather than in `main.py` so the variables are
present no matter which module is imported first, or how the app is launched
(`uvicorn backend.main:app` from the repo root, a test, a script...).

Both the repository-root `.env` (used by `docker compose` and by the documented
manual run) and `backend/.env` (historical local config) are loaded. The root
file wins when both exist, and `override=False` keeps real environment
variables (Docker, CI, prod) winning over either file.
"""

from __future__ import annotations

from pathlib import Path

from dotenv import load_dotenv

_PACKAGE_DIR = Path(__file__).resolve().parent
_ENV_PATHS = (_PACKAGE_DIR.parent / ".env", _PACKAGE_DIR / ".env")
for _env_path in _ENV_PATHS:
    load_dotenv(_env_path, override=False)
