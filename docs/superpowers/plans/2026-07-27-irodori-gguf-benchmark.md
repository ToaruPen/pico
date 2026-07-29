# Irodori GGUF Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compare the deployed Irodori-TTS 500M-v3 bf16 service with CrispASR GGUF F16 and Q8 on the same Windows RTX 4070 without changing Pico's production provider.

**Architecture:** Install the official CrispASR Windows CUDA release and official Irodori GGUF files in an isolated benchmark directory. Generate one 5–15 second Kasumi reference WAV from the deployed Speaker Inversion service, stop only the deployed scheduled task during candidate measurements, and restore it before evaluating the evidence.

**Tech Stack:** CrispASR v0.8.23, Irodori-TTS 500M-v3 GGUF, DAC-VAE GGUF, Windows PowerShell, NVIDIA `nvidia-smi`, Python standard library.

---

### Task 1: Record the benchmark boundary

**Files:**
- Create: `docs/superpowers/plans/2026-07-27-irodori-gguf-benchmark.md`
- Create at runtime: `.codex/artifacts/irodori-gguf-benchmark-20260727/report.md`

- [x] **Step 1: Confirm the deployed service**

Run:

```bash
ssh win-main 'powershell -NoProfile -Command "Get-ScheduledTask -TaskName '\''Pico-Irodori-TTS-8924'\'' | Select-Object TaskName,State"'
ssh win-main 'cmd /c "curl.exe -fsS http://127.0.0.1:8924/health"'
```

Expected: task state is `Running` and health reports a loaded 500M-v3 model.

- [x] **Step 2: Record acceptance gates**

Use the deployed service as the quality and latency baseline. A GGUF candidate is eligible only when all of these hold:

- the same Kasumi reference and synthesis texts are used;
- the generated WAV is readable, non-empty, and has plausible duration;
- speaker identity, pronunciation, and naturalness are not audibly worse;
- steady-state synthesis is stable for five sequential runs;
- either first-response wall time improves by at least 25% or GPU memory falls by at least 2 GiB.

### Task 2: Install the isolated candidate runtime

**Files:**
- Create on Windows: `C:\Users\takut\Dev\crispasr-irodori-benchmark\`

- [x] **Step 1: Download and extract CrispASR**

Run on Windows:

```powershell
$root = "C:\Users\takut\Dev\crispasr-irodori-benchmark"
New-Item -ItemType Directory -Force -Path $root | Out-Null
curl.exe -fL --retry 3 `
  -o "$root\crispasr-windows-x86_64-cuda.zip" `
  "https://github.com/CrispStrobe/CrispASR/releases/download/v0.8.23/crispasr-windows-x86_64-cuda.zip"
Expand-Archive -Force "$root\crispasr-windows-x86_64-cuda.zip" "$root\crispasr"
```

Expected: the extracted tree contains `crispasr.exe`, and `crispasr.exe --help` exits successfully.

- [x] **Step 2: Download official Irodori files**

Run on Windows:

```powershell
$modelRoot = "C:\Users\takut\Dev\crispasr-irodori-benchmark\models"
New-Item -ItemType Directory -Force -Path $modelRoot | Out-Null
$base = "https://huggingface.co/cstr/irodori-tts-GGUF/resolve/main"
curl.exe -fL --retry 3 -o "$modelRoot\dacvae-ja-32dim-f16.gguf" "$base/dacvae-ja-32dim-f16.gguf?download=true"
curl.exe -fL --retry 3 -o "$modelRoot\irodori-tts-500m-v3-f16.gguf" "$base/irodori-tts-500m-v3-f16.gguf?download=true"
curl.exe -fL --retry 3 -o "$modelRoot\irodori-tts-500m-v3-q8_0.gguf" "$base/irodori-tts-500m-v3-q8_0.gguf?download=true"
```

Expected sizes: codec `196142560`, F16 `1026408832`, and Q8 `623279968` bytes.

### Task 3: Create the common Kasumi reference and baseline

**Files:**
- Create on Windows: `C:\Users\takut\Dev\crispasr-irodori-benchmark\evidence\kasumi-reference.wav`
- Create on Windows: `C:\Users\takut\Dev\crispasr-irodori-benchmark\evidence\baseline-*.wav`

- [x] **Step 1: Generate a neutral Kasumi reference**

Request a neutral 5–15 second utterance from `http://127.0.0.1:8924/synthesize` with `speaker: "カスミ"`, 30 steps, and seed 42. Decode the returned URL-safe base64 `wav_bytes` to `kasumi-reference.wav`.

Expected: mono 48 kHz PCM WAV, readable by Python's `wave` module, between 5 and 15 seconds.

- [x] **Step 2: Capture the deployed baseline**

Run one warm-up and five sequential requests for the short, Ishigaki weather, Jugemu, and hard-kanji cases. Save timing JSON and one WAV per case.

Expected: five successful samples per case with wall time, server elapsed time, audio duration, and real-time factor.

### Task 4: Measure Q8 and F16

**Files:**
- Create on Windows: `C:\Users\takut\Dev\crispasr-irodori-benchmark\evidence\q8-*.wav`
- Create on Windows: `C:\Users\takut\Dev\crispasr-irodori-benchmark\evidence\f16-*.wav`
- Create locally: `.codex/artifacts/irodori-gguf-benchmark-20260727/results.json`

- [x] **Step 1: Stop only the deployed scheduled task**

Run:

```bash
ssh win-main 'powershell -NoProfile -Command "Stop-ScheduledTask -TaskName '\''Pico-Irodori-TTS-8924'\''"'
```

Expected: port 8924 closes and `nvidia-smi` returns to the non-Irodori baseline.

- [x] **Step 2: Warm the reference cache and measure each candidate**

For Q8 and F16, start a persistent CrispASR server with the explicit model and codec paths. Warm the same Kasumi reference once, then run five sequential requests per text using 30 Irodori steps and seed 42. Poll `nvidia-smi` during each series and record load time, request wall time, WAV duration, RTF, idle GPU memory, and peak GPU memory.

Expected: every request returns a readable WAV; no request or process crash occurs.

- [x] **Step 3: Capture cold-start cost**

Start each candidate from a stopped state, time readiness, perform one short synthesis, and stop it.

Expected: one load-to-ready time and one first-request wall time per candidate.

### Task 5: Restore and evaluate

**Files:**
- Create: `.codex/artifacts/irodori-gguf-benchmark-20260727/report.md`

- [x] **Step 1: Restore the deployed task**

Run:

```bash
ssh win-main 'powershell -NoProfile -Command "Start-ScheduledTask -TaskName '\''Pico-Irodori-TTS-8924'\''"'
ssh win-main 'cmd /c "curl.exe -fsS http://127.0.0.1:8924/health"'
```

Expected: health reports `status=ok` and `model_loaded=true`.

- [x] **Step 2: Validate outputs and write the recommendation**

Validate WAV headers and durations, compare timing medians/p95 and incremental GPU memory, and listen to matched outputs for Kasumi identity, pronunciation, naturalness, and artifacts. Record whether F16 or Q8 clears the acceptance gates and whether a Pico provider change is justified.

- [x] **Step 3: Verify repository hygiene**

Run:

```bash
git diff --check
git status --short
```

Expected: only the intended plan and benchmark evidence are new; no generated WAV or model file is added to Git.
