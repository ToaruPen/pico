# Long-Memory Model Provider Design

Date: 2026-06-17
Status: Draft

## Purpose

This document updates the long-memory model direction after the decision to use
subscription-backed cloud LLM access for asynchronous memory work while keeping
embedding replaceable and local by default.

The goal is to make session-cutoff memory processing accurate enough for daily
facility operation without slowing live conversation turns or competing with the
Windows VLM host.

## Decisions

- SQLite remains the durable source of truth for long-memory entries,
  lifecycle events, provenance, decay state, and correction metadata.
- Mem0 remains a secondary memory engine and retrieval integration, not the
  owner of durable truth.
- The long-memory worker is asynchronous. It runs after a session cutoff and is
  not allowed to block STT, TTS, camera tools, VLM requests, or live response
  generation.
- The main long-memory LLM provider is Pi Agent's `openai-codex` provider using
  the `openai-codex-responses` API. It must resolve credentials through Pi's
  model registry or auth storage, not through an `OPENAI_API_KEY` environment
  variable.
- The implementation exposes the Pi Agent `openai-codex` LLM provider through a
  Mem0 Langchain-compatible adapter. The existing explicit `ollama` LLM provider
  remains available as a separate configured choice, not as a fallback.
- The embedding provider is independent from the LLM provider. The first
  production embedder should be local unless a later explicit decision selects a
  cloud embedding provider.
- Provider selection is explicit. There is no automatic fallback chain between
  cloud and local models.

## Provider Boundaries

### Long-Memory LLM

The worker should treat the LLM as a small interface that can:

- extract candidate memories from a session cutoff,
- normalize and merge candidate facts,
- summarize why a memory should be created, updated, decayed, or ignored, and
- return structured output that can be audited before persistence.

The target LLM-provider implementation should use Pi Agent model resolution:

- provider: `openai-codex`
- API: `openai-codex-responses`
- credential source: Pi auth storage / model registry

The worker may run inside the Pi extension context and use `ctx.modelRegistry`.
If it runs as a separate local worker, it should construct Pi `AuthStorage` and
`ModelRegistry` explicitly and resolve the configured provider/model through the
same Pi authentication path.

### Embedder

Embedding is not a normal chat-completion model. It maps text to vectors and is
used by Qdrant/Mem0 retrieval. The embedder must be configured separately from
the LLM because:

- embedding models expose different APIs and return numeric vectors, not text;
- vector dimensions differ by model;
- changing models invalidates similarity scores for existing vectors; and
- local embedding can stay fast and private even when memory extraction uses a
  cloud LLM.

The selected embedder should be multilingual if it can stay close to the best
Japanese-specialized models. This matters because facility notes may mix
Japanese with words such as `LINE`, `YouTube`, `Switch`, event names, sports,
game names, and English queries.

## Candidate Direction

The initial implementation should keep candidate selection configurable rather
than baking a single model into code.

Candidate classes:

- `ollama`: for local Ollama embedders such as `bge-m3` or
  `qwen3-embedding`.
- `sidecar`: for a local HTTP embedding service backed by Transformers,
  SentenceTransformers, ONNX Runtime, Core ML, or MLX.
- `openai_embeddings`: future explicit cloud embedding provider, not part of
  the first local-default implementation unless selected later.

Current operational constraints:

- The Windows RTX 4070 VLM host is already dedicated to `qwen3.5:9b`.
- The `qwen3-embedding:8b` model should not be assumed to coexist with the
  Windows VLM model in VRAM.
- The Mac mini M4 16 GB host can run small or medium local embedding workers
  asynchronously, but live voice and person-detection paths should remain the
  scheduling priority.
- The memory worker should use concurrency `1` by default and batch embeddings
  after session cutoff.

### Shortlist

The first implementation should support evaluation rather than hard-code one
embedding model. The current shortlist is:

| Candidate | Role | Notes |
| --- | --- | --- |
| `jinaai/jina-embeddings-v5-text-small` | Primary quality candidate | CC-BY-NC-4.0, 677M parameters, 1024 dimensions, 32K context, multilingual, Matryoshka-aware, and suitable for a local Mac-side sidecar. This is the default candidate while the deployment remains non-commercial/private. |
| `jinaai/jina-embeddings-v5-text-nano` | Lightweight Jina candidate | CC-BY-NC-4.0, 239M parameters, 768 dimensions, 32K context, multilingual, and useful if the small model creates too much resident pressure. |
| `BAAI/bge-m3` | Operational Ollama candidate | MIT, 1024 dimensions, 8192-token context, 100+ languages, and available through Ollama. Keep it as the simplest permissive-license fallback candidate, not the primary quality choice. |
| `Qwen/Qwen3-Embedding-0.6B` | Ollama A/B candidate | Apache-2.0, 1024 dimensions, long context, and available through Ollama. Use it as a comparison point, not as the assumed best Japanese model. |
| `intfloat/multilingual-e5-large` | Legacy quality/license candidate | MIT, 1024 dimensions, strong multilingual retrieval, and a useful permissive-license comparison point. Its 512-token limit means session text must be chunked before embedding. |
| `cl-nagoya/ruri-v3-310m` | Japanese control candidate | Apache-2.0, 768 dimensions, strong Japanese reference model. Keep it as a Japanese-quality control, but not the default multilingual index. |

`Qwen3-Embedding-4B` and `Qwen3-Embedding-8B` are not default runtime
candidates for pico. They are useful research references, but their memory
pressure and larger vector dimensions make them poor first choices for a
resident worker that shares machines with voice, camera, and VLM workloads.

## Configuration Shape

The implementation should split LLM and embedding config:

```yaml
memory:
  mem0:
    enabled: true
    historyDbPath: /var/lib/pico/mem0-history.sqlite
    vectorStore:
      provider: qdrant
      localBaseUrl: http://127.0.0.1:6333
      collectionName: pico_long_memory_v1
    llm:
      provider: pi_model
      piProvider: openai-codex
      api: openai-codex-responses
      model: gpt-5.4
      timeoutMs: 60000
    embedder:
      provider: sidecar
      localBaseUrl: http://127.0.0.1:18081
      model: jinaai/jina-embeddings-v5-text-small
      embeddingDims: 1024
```

The current implementation targets Pi Agent's `openai-codex` /
`openai-codex-responses` provider for the Mem0 LLM and
`jinaai/jina-embeddings-v5-text-small` through a local sidecar for embeddings.
Keep both provider boundaries broad enough to evaluate later alternatives
without changing the memory worker contract. The config must make model names,
dimensions, and runtime boundaries explicit.

The `pi_model` LLM provider creates a short-lived Pi Agent SDK session with no
tools and a minimal resource loader, resolves credentials through Pi
`AuthStorage` / `ModelRegistry`, and exposes the result to Mem0 as a
Langchain-compatible `invoke()` model. It does not read `OPENAI_API_KEY`
directly and does not fall back to local Ollama if Pi authentication or model
resolution fails.

The `sidecar` provider uses an OpenAI-compatible local HTTP embedding contract:
`POST /v1/embeddings` with JSON `{ "model": string, "input": string[] }` and a
response shaped as `{ "data": [{ "embedding": number[] }] }`. Pico maps this
local sidecar into Mem0's Langchain-compatible embedder interface so Mem0 does
not need to know about Jina directly.

The tracked local sidecar entrypoint is
`scripts/sidecars/jina-embedding-sidecar.py`. It is an `uv run` script backed by
FastAPI, Uvicorn, SentenceTransformers, Transformers, Torch, and PEFT. It loads
`jinaai/jina-embeddings-v5-text-small` by default and serves the contract above
on `http://127.0.0.1:18081`. The process rejects non-loopback bind hosts and
serializes encode calls with a process-local lock so the Mac-side model worker
does not process concurrent embedding batches by default.

### Resource And Quality Notes

| Candidate | Expected local runtime pressure | Public quality signal | Japanese use |
| --- | --- | --- | --- |
| `jinaai/jina-embeddings-v5-text-small` | 677M parameters; plan for a medium local sidecar process on the Mac mini and keep worker concurrency at `1`. 1024-dimensional vectors use about 391 MiB per 100K raw float32 embeddings before index overhead. | Jina reports MTEB English v2 `71.7` and MMTEB `67.7`, the strongest public signal among the sub-1B multilingual candidates reviewed. | Multilingual by design and acceptable as the primary candidate, but still requires a pico-specific Japanese diary/facility-memory benchmark against `ruri-v3-310m`. |
| `jinaai/jina-embeddings-v5-text-nano` | 239M parameters; lighter local sidecar candidate. 768-dimensional vectors use about 293 MiB per 100K raw float32 embeddings before index overhead. | Jina reports MTEB English v2 `71.0` and MMTEB `65.5`. | Useful if small is too heavy; compare against the same Japanese fixture before selecting it. |
| `BAAI/bge-m3` | Observed Ollama package size is about 1.2 GB in the pico Windows host inventory; expected medium resident process. 1024-dimensional vectors. | Strong operational candidate with broad multilingual support, but weaker public aggregate signal than Jina v5 small in the reviewed sources. | Keep as permissive-license/operation fallback and Japanese comparison candidate. |
| `Qwen/Qwen3-Embedding-0.6B` | Similar small-to-medium local runtime class; 1024-dimensional vectors. | Qwen reports MMTEB `64.33`. | Use for A/B comparison, not as the primary Japanese-quality choice. |
| `cl-nagoya/ruri-v3-310m` | 315M parameters; 768-dimensional vectors. | Japanese-specialized reference with JMTEB average `77.24`. | Use as the Japanese control model because it is optimized for Japanese retrieval. |

## Vector Index Rules

- A Qdrant collection is bound to one embedding model family and dimension.
- Changing `embedder.model`, `embedder.provider`, or `embeddingDims` requires a
  new collection name or an explicit re-embedding migration.
- Do not mix vectors from different embedding spaces in the same collection.
- Store the embedding model metadata alongside memory lifecycle metadata or in a
  dedicated vector-index metadata record.

## Runtime Scheduling

The worker should:

- enqueue memory work after a session cutoff,
- process one session at a time by default,
- batch embedding calls,
- avoid running expensive embedding while live voice is actively processing,
- emit audit and OTel lifecycle events for queued, started, completed, skipped,
  failed, and timed-out jobs, and
- keep live interaction latency independent from memory processing.

## Non-Goals

- Do not add LINE or daily-report delivery in this slice.
- Avoid adding human review gates for memory output unless a later product
  decision reintroduces review.
- Exclude durable memory designs around child tracking, scoring, or profiling.
- Keep automatic fallback between local and cloud providers out of this slice.
- The Windows Ollama model port must not be exposed publicly.

## References

- Pi providers and subscription auth:
  `node_modules/@earendil-works/pi-coding-agent/docs/providers.md`
- Pi extension model registry:
  `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- Mem0 OSS runtime:
  `node_modules/mem0ai/dist/oss/index.d.ts`
- Qwen3 embedding Ollama package:
  https://ollama.com/library/qwen3-embedding
- BGE-M3:
  https://huggingface.co/BAAI/bge-m3
- Multilingual E5 large:
  https://huggingface.co/intfloat/multilingual-e5-large
- Jina embeddings v5 text small:
  https://huggingface.co/jinaai/jina-embeddings-v5-text-small
- Jina embeddings v5 text nano:
  https://huggingface.co/jinaai/jina-embeddings-v5-text-nano
- Jina model license notes:
  https://jina.ai/models/llms.txt
- Ruri v3 Japanese embedding reference:
  https://huggingface.co/cl-nagoya/ruri-v3-310m
