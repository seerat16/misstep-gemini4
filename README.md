# Misstep — Procedural Error Detection & Live Camera Checker

**Misstep watches someone carry out a written procedure on camera and tells you which step went wrong, how sure it is, and when it isn't sure.**

Built at the **Gemini 4 NYC Hackathon** (Cerebral Valley × Google DeepMind, Nov 21, 2026) for **Problem Statement One: 5 Sigma** and **Best Use of Managed Agents**.

---

## Model Jobs

| Model | Job |
|---|---|
| **Gemini 4 Neon** (`gemini-4-neon`) | **Compiler.** Reads the procedure (text, PDF, or card photo) and writes a `Procedure` step graph with checkable visual conditions, quantities, and `must_follow` ordering constraints. Also baseline `B2`. |
| **Gemini 4 Hydrogen** (`gemini-4-hydrogen`) | **Localizer.** Watches the full video and finds when each step happens (`start_s`, `end_s`). Also baseline `B1`. |
| **Gemini Decision 1** (`gemini-decision-1`) | **Checker.** Answers every check question (`noul`, `choice`, `score`) for every step as a calibrated probability on `v1beta`, at $0.10 per 1M input tokens. |
| **Gemini 4 Carbon** (`gemini-4-carbon`) | **Adjudicator.** Reviews only `error` or `uncertain` steps on high-resolution clips/stills to confirm or veto false alarms (`can_create_errors_from_ok: false`). |
| **Antigravity Managed Agent** (`antigravity-preview-09-2026`) | **Failure Analyst.** Inspects dev-set failure clusters + midpoint stills, proposes config changes via 4 custom tools, re-runs dev eval, and writes `docs/CHANGELOG_FIXES.md`. |
| **Gemini 3.8 Flash TTS** (`gemini-3.8-flash-tts`) | **Voice.** Pre-generates WAV alert audio per step at compile time for zero-delay spoken alerts in live mode (with browser `speechSynthesis` fallback). |

---

## Architecture

### Offline Pipeline (`misstep/pipeline.ts`)
```
Procedure (text / PDF / image) ──▶ [Gemini 4 Neon] compiler ──▶ Procedure JSON (steps, checks, quantities, must_follow)
                                                                      │
Video (.mp4 / .webm) ──▶ Files API upload ────────────────────────────┤
                                                                      ▼
                              [Gemini 4 Hydrogen] localizer ──▶ StepWindow per step (start_s, end_s | not found)
                                                                      │
          ┌───────────────────────────────────────────────────────────┤
          ▼                                                           ▼
 [Decision 1] FULL-VIDEO call                              [Decision 1] PER-STEP CLIP calls (ffmpeg clip, ±2s pad)
  "was step k performed at all?"                            done_clip, measurement (choice), VisualChecks (noul)
          └─────────────────────────────┬─────────────────────────────┘
                                        ▼
                          rules.py/ts (deterministic thresholds & order DAG)
                                        │
              ┌─────────────────────────┼─────────────────────────┐
              ▼                         ▼                         ▼
             ok                       error ──┐               uncertain ──┐
                                              ▼                           ▼
                                [Gemini 4 Carbon] adjudicator (high-res clip): veto error→ok or resolve uncertain
                                              │
                                              ▼
                                    RunResult JSON (verdicts, evidence, cost, latency)
```

### Live Demo Pipeline (`misstep/live.ts` + `server.ts`)
```
Overhead Webcam (640px JPEG every 500ms) ──▶ 6-frame ring buffer (3s) ──▶ POST /api/live/tick (every 2s)
                                                                                │
   ┌────────────────────────────────────────────────────────────────────────────┘
   ▼
[Decision 1] window checks (doing / done / active step) ──▶ 2-tick hysteresis ──▶ Step Board UI
   │
   ├─► Prerequisite skipped / out-of-order ──▶ Play pre-generated [3.8 TTS] WAV alert
   └─► "Finish & Verify Organizer" ──▶ Full-res still ──▶ [Decision 1 ultra_high] + [Carbon] compartment counts
```

---

## Setup & Running

### 1. Environment & Install
Ensure **Node.js (v20+)** and **`ffmpeg` / `ffprobe`** are installed, and set `GEMINI_API_KEY` in `.env` (or the server environment; never commit `.env` or expose keys in client JS).

```bash
npm install
npm test        # runs tests/schemas.test.ts, tests/rules.test.ts, tests/score.test.ts
npm run build   # TypeScript typecheck (tsc --noEmit)
npm run dev     # starts Express server on http://0.0.0.0:3000
```

### 2. Web UI Routes (`http://localhost:3000`)
- `/` — Offline video upload & step-by-step `RunResult` inspector
- `/static/live.html` — Live overhead webcam monitor (MedPrep preset, 6-frame ring buffer, TTS alerts, `Record 60s & Analyze` / video upload fallback, and `Finish & Verify Organizer`)
- `/static/review.html` — Field evaluation labeling tool (`data/field_gold.jsonl` + alert latency inspector)
- `/static/report.html` — Interactive Chart.js evaluation, calibration, ablation, field eval, and stress ladder report

### 3. CLI Evaluation & Managed Agent Workflow
```bash
# 9-check API smoke test
npx tsx scripts/smoke_test.ts

# Select held-out CaptainCook4D dev/test splits and download 360p GoPro videos
npx tsx scripts/select_subset.ts
npx tsx scripts/download_subset.ts

# Evaluate baselines and Misstep on dev
npx tsx eval/run_eval.ts --system B0 --split dev
npx tsx eval/run_eval.ts --system B1 --split dev
npx tsx eval/run_eval.ts --system B2 --split dev
npx tsx eval/run_eval.ts --system misstep --split dev

# Run Antigravity Managed Agent dev failure analyst, then freeze config
npx tsx agent/failure_analyst.ts
npx tsx agent/failure_analyst.ts --freeze configs/pipeline_v1.yaml

# Run frozen one-time test evaluation, stress ladder, and generate report
npx tsx eval/run_eval.ts --system misstep --split test --final
npx tsx eval/stress.ts --limit 6
npx tsx eval/report.ts --split test
```

---

## Evaluation Methodology & Results

- **Held-out Benchmark:** 40 recordings (6.47 hours, 453 steps) across **6 completely held-out recipes** from CaptainCook4D, disjoint from the 16-recording dev split (seed `20261121`).
- **Baselines:** `B0` (text-prior Neon), `B1` (single-call Hydrogen, thinking `high`), and `B2` (single-call Neon, thinking `high`), all given the exact same step list and category definitions.
- **Metrics:** Micro step-level Precision / Recall / F1, Covered F1 & Coverage (abstaining on `uncertain`), per-category recall, AUROC, 10-bin ECE, and 1,000-sample paired bootstrap 95% CIs over recordings.
- **Test Lock:** `eval/run_eval.ts --split test` refuses to run unless `configs/FROZEN` exists, its SHA-256 matches the active config, and `--final` is passed.

### Final Test Results (Session 1 — Pending / Populate After Frozen Test Run)
> See [docs/EVAL_RESULTS.md](docs/EVAL_RESULTS.md) and `/static/report.html` once Session 1 completes the frozen `--split test --final` run.
>
> | System | Step F1 (95% CI) | Covered F1 | Coverage | AUROC | ECE | Mean Cost | Mean Latency |
> |---|---:|---:|---:|---:|---:|---:|---:|
> | `B0` | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
> | `B1` (Hydrogen) | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
> | `B2` (Neon) | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
> | `misstep` | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |

---

## Field Evaluation Protocol (MedPrep Live)

1. Hand a participant the printed [MedPrep card](demo/medprep_card.md) and a blind mistake slip from [demo/field_eval_slips.md](demo/field_eval_slips.md).
2. They write their intended mistake (or `NONE`) on the slip, fold it, and perform the 7-step pill-organizer procedure under the overhead webcam in `/static/live.html` with no coaching.
3. A labeler inspects the captured 6-frame tick strips and alert timestamps in `/static/review.html`, records per-step ground truth (`ok` / `error` + category), then opens the slip to add any missed intended mistakes.
4. Labels save to `data/field_gold.jsonl` via `POST /api/field/label` and live-score via `GET /api/field/summary` (step F1, per-category recall, median alert latency, and false alarms per perfect run).

---

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

- **CaptainCook4D:** Peddi et al., *"CaptainCook4D: A Dataset for Understanding Errors in Procedural Activities"* ([arXiv:2312.14556](https://arxiv.org/abs/2312.14556), NeurIPS 2024). Annotations and 360p GoPro video links from `CaptainCook4D/annotations` and `CaptainCook4D/downloader` are used under the **Apache-2.0** license.

---

## Disclosure & Team

- **Built during the event:** All code, configs, evaluation scripts, UI, and documentation in this repository were built during the Gemini 4 NYC Hackathon (Nov 21, 2026).
- **Team:** Manseerat Kaur & teammates (Gemini 4 NYC Hackathon).
