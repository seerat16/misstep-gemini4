# Misstep — Procedural Error Detection & Live Camera Checker

Misstep watches a person carry out a written procedure (pasted text, PDF, or card photo) via recorded video or live overhead webcam, and outputs per-step verdicts (`ok`, `error` with category, `uncertain`, or `not_checkable`) with calibrated probabilities, timestamps, visual evidence, and real-time spoken alerts.

## Architecture & Model Roles

```
Procedure (text / PDF / image)
   └─▶ Gemini 4 Neon (compiler) ──▶ Step Graph JSON (checks, quantities, must_follow)
                                         │
Video / Live Frames                      ▼
   ├─▶ Gemini 4 Hydrogen ──────────▶ Step Windows (start_s, end_s, found)
   ├─▶ Gemini Decision 1 (v1beta) ─▶ Calibrated Probabilities (noul, choice, score)
   └─▶ Deterministic Rules ────────▶ Candidate Verdicts (ok / error / uncertain)
                                         │
                                    [error | uncertain]
                                         ▼
                              Gemini 4 Carbon (adjudicator) ──▶ Veto or Confirm
```

| Job | Model | Key Pattern |
|---|---|---|
| Procedure Compiler | `gemini-4-neon` | Extracts structured `Procedure` graph (`checks`, `quantity`, `must_follow`) |
| Step Localizer | `gemini-4-hydrogen` | Locates candidate step windows (`start_s`, `end_s`) in recorded video |
| Calibrated Verifier | `gemini-decision-1` (`v1beta`) | `ai.decisions.create` returns calibrated `noul`, `choice`, `score` probabilities |
| High-Res Adjudicator | `gemini-4-carbon` | Inspects only `error` / `uncertain` steps; can veto false alarms or resolve uncertainty |
| Spoken Alerts | `gemini-3.8-flash-tts` | Pre-generates WAV alerts at compile time (`speechSynthesis` fallback) |
| Dev Failure Analyst | `antigravity-preview-09-2026` | Managed Agent loop (`ai.interactions.create`) with 4 custom dev-only tools |

## Setup & Running

### 1. Environment
Copy `.env.example` to `.env` if running locally outside AI Studio, and ensure `GEMINI_API_KEY` is configured in the server environment (never placed in client JS or git).

```bash
npm install
npm test
npm run dev
```

The server listens on `http://0.0.0.0:3000`:
- `/` — Offline video upload & step-by-step analysis
- `/static/live.html` — Live overhead webcam monitor (6-frame ring buffer every 2s + spoken TTS alerts + final `ultra_high` compartment count check)
- `/static/review.html` — Field evaluation labeling & alert latency inspector
- `/static/report.html` — Interactive Chart.js evaluation, calibration, ablation, and stress ladder report

### 2. CLI Evaluation & Dataset Workflow

```bash
# Run 9-check API smoke test
npx tsx scripts/smoke_test.ts

# Select held-out CaptainCook4D dev/test splits and download 360p GoPro videos
npx tsx scripts/select_subset.ts
npx tsx scripts/download_subset.ts

# Evaluate baselines and Misstep on dev
npx tsx eval/run_eval.ts --system B1 --split dev
npx tsx eval/run_eval.ts --system misstep --split dev

# Run Antigravity dev failure analyst, then freeze config for test
npx tsx agent/failure_analyst.ts
npx tsx agent/failure_analyst.ts --freeze configs/pipeline_v1.yaml

# Run frozen test evaluation, stress ladder, and generate report
npx tsx eval/run_eval.ts --system misstep --split test --final
npx tsx eval/stress.ts --limit 6
npx tsx eval/report.ts --split test
```

## Field Evaluation Protocol (MedPrep Demo)

1. Print or display `demo/medprep_card.md` (7-step MedPrep Week 47 pill-organizer procedure).
2. Run 10 live webcam sessions in `/static/live.html` (~5 clean runs, ~5 scripted single-mistake runs such as skipping a step or miscounting tablets).
3. Inspect captured tick frames and alert timestamps in `/static/review.html` and save per-step ground truth to `data/field_gold.jsonl`.
4. View aggregated field step F1, median alert latency, and false alarms per perfect run in `/static/review.html` and `/static/report.html`.

## Evaluation Results (Held-Out CaptainCook4D Test Split)

Evaluated on **40 held-out recordings across 6 disjoint unseen recipes** (`453` steps, `169` error steps, `6.47` hours) under a strictly frozen config (`configs/pipeline_final.yaml`, SHA-256 `f89b25acefd6bdb910017fa8af7adb11269227cbbe277e4e2a1f34d384f095cb`, zero test-label leakage).

| System | Step F1 (95% CI) | Covered F1 | Coverage | AUROC | ECE (Calibration) |
|---|---:|---:|---:|---:|---:|
| `B0` (text-prior Neon) | 0.0% `[0.0, 0.0]` | 0.0% | 100.0% | 0.500 | 0.092 |
| `B1` (`gemini-4-hydrogen`) | 70.4% `[62.6, 76.7]` | 70.4% | 100.0% | 0.851 | 0.136 |
| `B2` (`gemini-4-neon`) | 73.0% `[64.2, 79.5]` | 73.0% | 100.0% | 0.869 | 0.081 |
| **`misstep` (frozen `v4`)** | **67.9% `[59.0, 74.2]`** | **69.5%** | **97.6%** | **0.791** | **0.068 (best)** |
| `misstep-no-carbon` (ablation) | 60.5% `[50.0, 68.7]` | 71.9% | 70.0% | 0.782 | 0.093 |

- **Best Calibration (`ECE = 0.068`)**: 2.0× better calibrated than single-call `B1` (`0.136`) and better than `B2` (`0.081`), generalizing **+6.4 F1 pts** from dev (`61.5%`) to unseen test recipes (`67.9%`).
- **Carbon Adjudicator Ablation**: Removing Gemini 4 Carbon drops Step F1 by **`-7.45 pts`**, Recall by **`-10.1 pts`**, and Coverage by **`-27.6 pts`** (`97.6% → 70.0%`), while worsening ECE (`0.068 → 0.093`).
- **Antigravity Managed Agent (`v1 → v4`, dev)**: Autonomously ran 3 eval cycles (`v2` kept `+3.3 pts` closing the `(0.25, 0.35)` `missing_p_done_max` dead zone; `v3` reverted after `-18.2 pt` measurement recall regression; `v4` kept tuning `check_false_min`), lifting dev F1 **`56.4% → 61.5%` (`+5.2 pts`)** with zero category recall regressions. See [`docs/CHANGELOG_FIXES.md`](docs/CHANGELOG_FIXES.md).
- **5-Condition Stress Ladder (0 breaking points `<50%`)**: `clean` `65.5%` (`100%`) → `240p` `62.7%` (`96%`) → `low_light` `55.2%` (`84%`) → `144p` `54.9%` (`84%`) → `spanish` `44.0%` (`67%`). See [`docs/EVAL_RESULTS.md`](docs/EVAL_RESULTS.md) and `/static/report.html`.

## Dataset Citation & License

- **CaptainCook4D**: Peddi et al., *"CaptainCook4D: A Dataset for Understanding Errors in Procedural Activities"* ([arXiv:2312.14556](https://arxiv.org/abs/2312.14556)). Code and annotations from `CaptainCook4D/annotations` and `CaptainCook4D/downloader` are used under the **Apache-2.0** license.