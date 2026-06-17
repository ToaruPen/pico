#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11,<3.13"
# dependencies = [
#   "fastapi>=0.115.0",
#   "uvicorn[standard]>=0.30.0",
#   "sentence-transformers>=5.1.0",
#   "transformers>=4.57.0",
#   "torch>=2.8.0",
#   "peft>=0.15.2",
# ]
# ///
"""Local OpenAI-compatible embedding sidecar for Jina embeddings v5 text models."""

from __future__ import annotations

import os
import threading
from ipaddress import ip_address
from typing import Literal, TypedDict

import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer


DEFAULT_MODEL = "jinaai/jina-embeddings-v5-text-small"
DEFAULT_TASK = "text-matching"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 18081
DEFAULT_BATCH_SIZE = 8
DEFAULT_EMBEDDING_DIMS = 1024
DEFAULT_MAX_INPUT_ITEMS = 64
DEFAULT_MAX_INPUT_CHARS = 8192


class ModelPolicy(TypedDict):
    revision: str
    trust_remote_code: bool


ALLOWED_MODELS: dict[str, ModelPolicy] = {
    DEFAULT_MODEL: {
        "revision": "dd76d535f5447ca3897a9c893fb1e612ead98192",
        "trust_remote_code": True,
    }
}

MODEL_NAME = os.environ.get("PICO_JINA_EMBEDDING_MODEL", DEFAULT_MODEL)
TASK = os.environ.get("PICO_JINA_EMBEDDING_TASK", DEFAULT_TASK)
HOST = os.environ.get("PICO_JINA_EMBEDDING_HOST", DEFAULT_HOST)
PORT = int(os.environ.get("PICO_JINA_EMBEDDING_PORT", str(DEFAULT_PORT)))
BATCH_SIZE = int(os.environ.get("PICO_JINA_EMBEDDING_BATCH_SIZE", str(DEFAULT_BATCH_SIZE)))
TRUNCATE_DIM = int(
    os.environ.get("PICO_JINA_EMBEDDING_DIMS", str(DEFAULT_EMBEDDING_DIMS))
)
NORMALIZE = os.environ.get("PICO_JINA_EMBEDDING_NORMALIZE", "1") != "0"
MAX_INPUT_ITEMS = int(
    os.environ.get("PICO_JINA_EMBEDDING_MAX_INPUT_ITEMS", str(DEFAULT_MAX_INPUT_ITEMS))
)
MAX_INPUT_CHARS = int(
    os.environ.get("PICO_JINA_EMBEDDING_MAX_INPUT_CHARS", str(DEFAULT_MAX_INPUT_CHARS))
)
MODEL_POLICY = ALLOWED_MODELS.get(MODEL_NAME)
HOST_ERROR_MESSAGE = (
    "PICO_JINA_EMBEDDING_HOST must be a loopback host such as 127.0.0.1, ::1, or localhost"
)


class EmbeddingRequest(BaseModel):
    model: str = Field(min_length=1)
    input: str | list[str]


class EmbeddingItem(BaseModel):
    object: Literal["embedding"] = "embedding"
    index: int
    embedding: list[float]


class EmbeddingUsage(BaseModel):
    prompt_tokens: int = 0
    total_tokens: int = 0


class EmbeddingResponse(BaseModel):
    object: Literal["list"] = "list"
    model: str
    data: list[EmbeddingItem]
    usage: EmbeddingUsage = Field(default_factory=EmbeddingUsage)


class HealthResponse(BaseModel):
    ok: bool
    model: str
    loaded: bool


app = FastAPI(title="pico Jina embedding sidecar")


class ModelCache:
    model: SentenceTransformer | None = None


_model_cache = ModelCache()
_model_lock = threading.Lock()
_encode_lock = threading.Lock()


@app.get("/health")
def health() -> HealthResponse:
    return HealthResponse(ok=True, model=MODEL_NAME, loaded=_model_cache.model is not None)


@app.post("/v1/embeddings")
def create_embeddings(request: EmbeddingRequest) -> EmbeddingResponse:
    if request.model != MODEL_NAME:
        raise HTTPException(
            status_code=400,
            detail=f"unsupported model: {request.model}; expected {MODEL_NAME}",
        )

    texts = normalize_input(request.input)
    model = get_model()

    try:
        with _encode_lock:
            vectors = model.encode(
                sentences=texts,
                task=TASK,
                batch_size=BATCH_SIZE,
                normalize_embeddings=NORMALIZE,
                truncate_dim=TRUNCATE_DIM,
            )
    except TypeError as error:
        raise HTTPException(
            status_code=500,
            detail=f"Jina embedding model does not support the configured encode arguments: {error}",
        ) from error
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"embedding failed: {error}") from error

    embeddings = vectors.tolist()

    return EmbeddingResponse(
        model=MODEL_NAME,
        data=[
            EmbeddingItem(index=index, embedding=[float(value) for value in vector])
            for index, vector in enumerate(embeddings)
        ],
    )


def normalize_input(value: str | list[str]) -> list[str]:
    texts = [value] if isinstance(value, str) else value

    if len(texts) == 0:
        raise HTTPException(status_code=400, detail="input must not be empty")

    if len(texts) > MAX_INPUT_ITEMS:
        raise HTTPException(
            status_code=413,
            detail=f"input must contain at most {MAX_INPUT_ITEMS} item(s)",
        )

    for text in texts:
        if not isinstance(text, str) or text.strip() == "":
            raise HTTPException(status_code=400, detail="input entries must be non-empty strings")
        if len(text) > MAX_INPUT_CHARS:
            raise HTTPException(
                status_code=413,
                detail=f"input entries must be at most {MAX_INPUT_CHARS} character(s)",
            )

    return texts


def get_model() -> SentenceTransformer:
    if MODEL_POLICY is None:
        raise HTTPException(
            status_code=400,
            detail=f"unsupported model: {MODEL_NAME}; allowed models: {', '.join(ALLOWED_MODELS)}",
        )

    if _model_cache.model is not None:
        return _model_cache.model

    with _model_lock:
        if _model_cache.model is None:
            device = "mps" if torch.backends.mps.is_available() else "cpu"
            # Jina v5 small declares custom AutoModel and SentenceTransformer
            # modules. Keep remote code execution constrained to this pinned,
            # reviewed model allowlist.
            _model_cache.model = SentenceTransformer(
                MODEL_NAME,
                revision=MODEL_POLICY["revision"],
                trust_remote_code=MODEL_POLICY["trust_remote_code"],
                device=device,
            )

        return _model_cache.model


def main() -> None:
    require_loopback_host(HOST)
    uvicorn.run(app, host=HOST, port=PORT)


def require_loopback_host(host: str) -> None:
    if host == "localhost":
        return

    try:
        if ip_address(host).is_loopback:
            return
    except ValueError:
        pass

    raise SystemExit(HOST_ERROR_MESSAGE)


if __name__ == "__main__":
    main()
