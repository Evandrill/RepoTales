# backend/Dockerfile
#
# Build context: ./backend (see docker-compose.yml).
# The code imports itself as the `backend` package, so the source is copied to
# /app/backend and /app is added to PYTHONPATH: `uvicorn main:app` still works
# from /app/backend while `import backend.*` resolves from /app.
FROM python:3.10-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/app

WORKDIR /app

# Dependencies first: this layer is cached until requirements.txt changes.
COPY requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r /app/backend/requirements.txt

COPY . /app/backend

# Cache d'images FLUX + utilisateur non-root.
RUN groupadd --system app \
    && useradd --system --gid app --home-dir /app app \
    && mkdir -p /app/backend/.cache/images \
    && chown -R app:app /app
USER app

WORKDIR /app/backend

EXPOSE 8080

# Stdlib only: no curl/wget needed in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=3).status == 200 else 1)"

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
