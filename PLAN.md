# Misstep: Build Plan

> **Misstep watches someone carry out a written procedure on camera and tells you which step went wrong, how sure it is, and when it isn't sure.**
>
> **Event:** Gemini 4 NYC Hackathon (Cerebral Valley x Google DeepMind), Sat Nov 21, 2026, 9:00 AM to 10:00 PM ET, New York.
> **Problem Statement One:** 5 Sigma. **Also entering:** Best Use of Managed Agents ($5,000).
> **This file is the single source of truth.** A human or an AI coding agent (Claude Code, Cursor, etc.) should be able to build the whole project by following it top to bottom.

---

## Table of contents

0. [How to use this file](#0-how-to-use-this-file)
1. [What we are building and why it wins](#1-what-we-are-building-and-why-it-wins)
2. [Verified facts about the models and APIs](#2-verified-facts-about-the-models-and-apis)
3. [Architecture](#3-architecture)
4. [Prerequisites](#4-prerequisites)
5. [Repository layout](#5-repository-layout)
6. [Shared contracts (schemas, config, file formats)](#6-shared-contracts)
7. [Phase 0: Setup, smoke tests, start the download](#phase-0-setup-smoke-tests-start-the-download)
8. [Phase 1: Dataset, gold labels, splits](#phase-1-dataset-gold-labels-splits)
9. [Phase 2: Eval harness and baselines](#phase-2-eval-harness-and-baselines)
10. [Phase 3: The Misstep pipeline](#phase-3-the-misstep-pipeline)
11. [Phase 4: Improve on the dev set with the Managed Agent](#phase-4-improve-on-the-dev-set-with-the-managed-agent)
12. [Phase 5: Live mode and the MedPrep demo](#phase-5-live-mode-and-the-medprep-demo)
13. [Phase 6: Field eval, stress ladder, the one-time test run](#phase-6-field-eval-stress-ladder-the-one-time-test-run)
14. [Phase 7: Results page, README, demo video, submission](#phase-7-results-page-readme-demo-video-submission)
15. [Timeline and team split](#15-timeline-and-team-split)
16. [Risks and fallbacks](#16-risks-and-fallbacks)
17. [Demo script and judge Q&A](#17-demo-script-and-judge-qa)
18. [Appendix A: Prompts](#appendix-a-prompts)
19. [Appendix B: Metric definitions](#appendix-b-metric-definitions)
20. [Appendix C: Templates for PROGRESS.md and FINDINGS.md](#appendix-c-templates)
21. [Appendix D: Sources](#appendix-d-sources)

---

## 0. How to use this file

### For the humans

- Tasks marked **[HUMAN]** need a person: buying props, getting API keys, recording video, labeling field runs, presenting.
- Tasks marked **[AGENT]** can be handed to an AI coding agent. Point the agent at this file and say: *"Read PLAN.md. Do Phase N. Follow section 0 rules. Stop at the acceptance checks and report."*
- Do the phases in order. Phases 1–2 (eval) and Phase 3 (pipeline) can run in parallel once Phase 0 is done (see section 15).
- Check every phase's **Done when** list before moving on.

### Rules for AI coding agents (read before writing any code)

1. **Work one phase at a time.** Don't start the next phase until every **Done when** item of the current one passes. Report which checks passed.
2. **Keep `PROGRESS.md` up to date** (template in Appendix C). After each task, tick it and note anything surprising.
3. **Never guess an API field.** If an SDK call fails or a field name is uncertain, read the docs linked in section 2, write what you learned to `docs/FINDINGS.md`, and fix it **only in `misstep/gemini.py`**. Every model call goes through that one wrapper.
4. **Never read or print test-set gold labels** outside `eval/score.py`. Never tune anything on the test split. Section 6.5 explains the test lock.
5. **No new frameworks.** Use the stack in section 4.3. No LangChain, no React build step, no database.
6. **Cache every model call on disk** (section 6.6). Re-running a script must not re-bill the same request.
7. **Respect the budget.** All calls go through the cost tracker. Stop and ask the human if the spend passes `MISSTEP_MAX_USD`.
8. **Commit after each passing acceptance check:** `git commit -m "phase N: <what>"`. Never commit `.env`, `data/`, `cache/` or `runs/`.
9. **Stick to the timebox.** If a task runs more than 50% over its timebox, switch to the listed **Fallback** and note it in `PROGRESS.md`.
10. **Stop at [HUMAN] steps** and ask. Don't fake human inputs (labels, recordings, props).
11. **Windows first.** The lead developer uses Windows 11 with PowerShell. Give commands that work there, using `python` not `python3` and `.venv\Scripts\Activate.ps1`. Bash equivalents are welcome too.
12. **Write all code during the event.** Confirm the event's pre-existing-code rule with the organizers. Commits before the start time should hold only this plan and empty scaffolding.

---

## 1. What we are building and why it wins

### 1.1 The product

The input is a **procedure** plus a **video**:
- The procedure can be a recipe card, a medicine-prep sheet, an assembly manual, a photo of a handwritten list, or a PDF.
- The video can be a recorded file or a live webcam.

The output is a **per-step verdict**: `ok`, `error` (with a category such as *missing step*, *wrong order*, *wrong amount* or *wrong technique*), `uncertain`, or `not_checkable`. Each verdict comes with a probability, a timestamp and a short piece of evidence. In live mode it also **speaks an alert** ("Wait, you skipped step 4: sanitize your hands") seconds after the mistake.

### 1.2 Why this is a real, hard task (5 Sigma framing)

- Vision-language models are weak at spotting procedural mistakes in first-person ("egocentric") video. See Storks et al., EMNLP 2025, in Appendix D.
- Wherever written procedures meet human hands, a skipped or wrong step is how things fail: medication preparation, clinical checklists, lab protocols, aircraft maintenance, food safety.

### 1.3 How we prove it

| Requirement from the brief | How Misstep meets it |
|---|---|
| Real task that today's agents struggle with | Procedural error detection in egocentric video |
| Test on inputs we didn't prepare for | **CaptainCook4D** (NeurIPS 2024 dataset): 384 real recordings with human-labeled step errors, Apache-2.0. Test recipes are **held out entirely**. |
| Compare to a simple baseline | B0 "always ok", B1 one Hydrogen call, B2 one Neon call. Same inputs, same category definitions. |
| Messy inputs and edge cases | Real kitchens, occlusion, 360p; a **field eval** run by strangers at the venue; a **stress ladder** |
| Where it still fails, and what we changed | Dev-set failure analysis by a **Managed Agent**, logged as v1 → v2 → v3 in `docs/CHANGELOG_FIXES.md`; honest per-category results |
| At least 2 Gemini 4 models, each with a clear job | Neon = procedure compiler; Hydrogen = step localizer; Carbon = adjudicator. Also Gemini Decision 1 and 3.8 TTS. |
| Media is central | Video, audio and documents in; spoken alerts out |
| Not a scripted demo | **The judge chooses the mistake** in the live demo |

### 1.4 Model jobs (one sentence each, for the pitch)

| Model | Job |
|---|---|
| **Gemini 4 Neon** (`gemini-4-neon`) | **Compiler.** Reads the procedure (text, PDF or photo) and writes a step graph with checkable visual conditions, amounts and ordering constraints. |
| **Gemini 4 Hydrogen** (`gemini-4-hydrogen`) | **Localizer.** Watches the full video (agentic video understanding) and finds when each step happens. Also baseline B1. |
| **Gemini Decision 1** (`gemini-decision-1`) | **Checker.** Answers every check question for every step as a calibrated probability, in a few hundred milliseconds, at $0.10 per million input tokens. |
| **Gemini 4 Carbon** (`gemini-4-carbon`) | **Adjudicator.** Only for uncertain or flagged steps: re-watches the clip at high resolution and confirms or overturns. It never adds new errors. |
| **Antigravity Managed Agent** (`antigravity-preview-09-2026`) | **Failure analyst.** Groups dev-set failures, proposes config changes, re-runs the dev eval through a tool, writes the changelog. |
| **Gemini 3.8 Flash TTS** (`gemini-3.8-flash-tts`) | **Voice.** Speaks live alerts. Alert audio is pre-generated per step when the procedure is compiled, so alerts play with no delay. |

---

## 2. Verified facts about the models and APIs

> Researched on Nov 21, 2026 from Google's docs and the changelog. **Phase 0 re-checks each of these with real calls**, and any difference goes in `docs/FINDINGS.md`.

### 2.1 The Gemini 4 family

| | Hydrogen | Neon | Carbon | Argon |
|---|---|---|---|---|
| Model ID | `gemini-4-hydrogen` | `gemini-4-neon` | `gemini-4-carbon` | `gemini-4-argon` |
| Released | Nov 12 | Nov 18 | Nov 10 | Oct 13 |
| Role | Fast, cheap default | Frontier all-rounder | Deepest reasoning and verification | Older; legal drafting |
| Price per 1M tokens (in / out) | $1.50 / $7.50 | $3 / $15 (cached input $0.15) | $2 / $10 until Nov 30 | $2 / $10 until Nov 30 |
| Free tier | **Yes** (the only one) | No | No | No |
| Thinking levels | low, medium, high (default), xhigh | low, medium, high (default), xhigh | low, medium (default), high | low, medium (default), high |

**Shared by all four:**
- **Input:** text, image, audio, video, PDF (and, since Nov 18, Word, PowerPoint and Excel).
- **Output:** text only. No image or audio generation.
- **No Live API support.**
- **Context:** one 1,048,576-token window shared by input, thinking and output. At most 65,536 output tokens per synchronous call.
- **`temperature`, `top_p` and `top_k` must be removed.** Out-of-range values return 400; in-range values are ignored. So outputs are not deterministic, which is one more reason for the disk cache.
- **`minimal` thinking level is rejected.**
- **No explicit context caching.** Implicit caching applies automatically.
- **Use declared tools and structured output (JSON schema).** Raw-text JSON tool calls can come back as `MALFORMED_FUNCTION_CALL`.
- **Set HTTP timeouts to at least 15 minutes** for Neon and Carbon.

### 2.2 Video understanding (in `generateContent`)

- **Token cost:** about 100 tokens per second of video at low media resolution and about 300 at high, plus 32 tokens per second of audio.
- **Length:** about 3 hours of video at low resolution, or 1 hour at high.
- **Frame rate:** default 1 fps, adjustable between 0 and 24 through the `processing` setting.
- **Clipping:** `start_offset` / `end_offset` (e.g. `"10.5s"`); only the clipped part is billed.
- **Layers:** choose any of `frames`, `audio`, `transcript`.
- **Agentic video understanding:** set `"processing": "agentic"` on the video part. Supported on all four Gemini 4 models.
  - Best for videos over 5–10 minutes. It can add latency on short clips.
  - Uses up to 88% fewer tokens on long videos.
  - Confirm it ran by checking for `processing_call` / `processing_result` steps in the response.
- **Limits:** up to 10 videos per request; Files API up to 20 GB on paid keys. Use the Files API for anything over 100 MB.

### 2.3 Decisions API (`gemini-decision-1`)

- **Endpoint:** `POST https://generativelanguage.googleapis.com/v1beta/decisions`. SDK: `client.decisions.create(...)`, which needs google-genai 3.2 or later.
- **Request:** `model`, `input` (a string or Content blocks: text, image, audio, video, PDF), `questions` (1 to 1,000).
- **Question types:**
  - `noul` (yes/no): returns `noul` in 0.01–0.99, plus `confidence`.
  - `choice`: 2–255 options; returns `choice`, `probabilities`, `confidence`.
  - `score`: 2–255 ordered levels; returns `score`, `legend`, `probabilities`, `confidence`.
- **Response:** `answers[key]` and `usage`. Output tokens are always 0.
- **Limits:**
  - 262,144-token context covering the input and all questions.
  - Inline data up to 100 MB (50 MB for PDF).
  - HTTPS URL inputs up to 15 MB.
  - Files API URIs work. **YouTube and `gs://` URIs do not.**
- **Resolution** on image and video blocks: `low`, `medium`, `high`, `ultra_high` (images only). Verify the field name in Phase 0.
- **Latency:** Google quotes 150–250 ms end to end for inputs up to 16K tokens, nearly flat from 1 to 100 questions. Long videos will be slower.
- **Price:** $0.10 per 1M input tokens, $0 output. The shared input is billed once per request.
- **Best practices from the docs:**
  - One decision per question.
  - Phrase questions positively.
  - **Compare numbers and dates in code, not in questions.**
  - Add a catch-all option to `choice` questions.
  - Set thresholds on your own labeled data.
- **Not supported:** context caching, Batch API, multi-turn history as input. Question instructions must be text.

### 2.4 Managed Agents (Antigravity)

- **Agent ID:** `antigravity-preview-09-2026`. Called through the **Interactions API**: `client.interactions.create(agent=..., input=..., environment="remote")`.
- **Choosing the model:** `agent_config={"type": "antigravity", "model": "gemini-4-neon"}`. The default is Hydrogen.
- **Built-in tools:** code execution (bash, Python, Node), Google Search, URL context, sandbox filesystem.
- **Custom function tools:**
  1. The interaction returns `status: "requires_action"`.
  2. We run the function locally.
  3. We send the result back with `previous_interaction_id` and the same environment ID.
- **Input:** text and inline base64 images only (no video or audio input).
- **Long tasks:** `background=True` (needs `store=True`), then poll. Cancel with `interactions.cancel`.
- **Budget:** `agent_config.max_total_tokens` is a best-effort cap.

### 2.5 Other models used

- **TTS:** `gemini-3.8-flash-tts` (also a `-lite` variant). 150+ prebuilt voices; voice design and voice remixing through `/v1beta/voices`.
- **Live API (optional, not required):** `gemini-3.8-live`, native audio. Only used if we add a spoken "what step am I on?" Q&A. **Out of scope by default.**

### 2.6 Dataset: CaptainCook4D

- **Size:** 384 recordings, 94.5 hours, egocentric GoPro video, 24 recipes.
- **Download:** `github.com/CaptainCook4D/downloader`, hosted on Box with **no login**.
  - `python download_gopro_data.py --data2d` fetches **360p** GoPro video. **Never pass `--resolution4K`.**
  - Links are in `metadata/download_links.json`, so we can fetch just our subset.
- **Annotations:** `github.com/CaptainCook4D/annotations`. Folders: `annotation_json/`, `annotation_csv/`, `data_splits/`, `metadata/`, `task_graphs/`.
  - Step annotations: `recording_id`, `step_id`, `start_time`, `end_time`, `description`, `has_errors`.
  - Error annotations: error tags and descriptions per step, plus a recording-level `is_error`. **Untimed steps (for example missing steps) have start and end set to -1.0.**
  - Error categories: **Preparation, Measurement, Order, Timing, Technique, Temperature, Missing Step, Other**.
  - `recording_id_step_idx` maps each recording to its activity (recipe) and the ordered step IDs performed. `activity_id_step_id_mapping` and `step_idx_description` give the recipe steps.
  - Splits are provided by environment, person, recipe and recording.
- **License:** Apache-2.0 per the project page. Cite the paper in the README.
- **Rejected alternative:** EgoPER needs an emailed access request, so it can't be used today.

---

## 3. Architecture

### 3.1 Offline pipeline (eval mode)

```
procedure (text/PDF/image) ──► [Neon] compiler ──► Procedure JSON (steps, checks, order DAG, quantities)
                                                        │
video.mp4 ──► Files API upload ─────────────────────────┤
                                                        ▼
                       [Hydrogen, agentic video] localizer ──► StepWindow per step (start_s, end_s | not found)
                                                        │
          ┌─────────────────────────────────────────────┤
          ▼                                             ▼
 [Decision 1] FULL-VIDEO call                 [Decision 1] PER-STEP CLIP calls (ffmpeg clip, ±2 s pad)
  "was step k performed at all?"               done_clip, measurement (choice), checks (noul, by category)
  for every step, in ONE request
          └──────────────────────┬──────────────────────┘
                                 ▼
                   rules.py (plain code): missing / order / measurement / check thresholds
                                 │
             ┌───────────────────┼─────────────────────┐
             ▼                   ▼                     ▼
            ok                 error ──┐           uncertain ──┐
                                       ▼                       ▼
                         [Carbon] adjudicator (high-res clip): may veto error→ok, resolves uncertain→ok/error
                                 │
                                 ▼
                       RunResult JSON (per-step verdicts, evidence, cost, latency)
```

### 3.2 Live pipeline (demo mode)

```
Browser webcam ──(every 500 ms: 640px JPEG)──► ring buffer (last 6 frames = 3 s)
      │ every 2 s: POST /api/live/tick {session_id, frames[6]}
      ▼
FastAPI LiveSession (state machine over the compiled Procedure)
      ├─► [Decision 1] one call: frames as image blocks + questions for the current step and the next two
      ├─► update step states (needs 2 consecutive ticks above threshold to change state)
      ├─► alert if a later step has started while an earlier required step isn't done
      │       └─► play pre-generated [3.8 TTS] alert audio for that step (generated at compile time)
      └─► on "Finish": high-res still ──► [Decision 1] per-compartment count checks ──► [Carbon] verify ──► final report
```

### 3.3 Improvement loop (dev split only)

```
eval/run_eval.py --split dev ──► runs/dev/<ts>/ (predictions + scores + failures.jsonl)
          │
          ▼
agent/failure_analyst.py ──► [Antigravity Managed Agent, model = Neon]
     tools (run locally): get_failure_summary(), get_failures(category, limit), get_config(),
                          run_dev_eval(config_yaml) ── returns metrics + delta vs current best
     output: configs/pipeline_vN.yaml + an entry in docs/CHANGELOG_FIXES.md
     [HUMAN] approves the final version ──► configs/FROZEN
```

---

## 4. Prerequisites

### 4.1 Accounts and keys **[HUMAN]**, done before Phase 0 ends

- [ ] A Google AI Studio account and **one paid-tier Gemini API key**. Neon, Carbon and Genie have no free tier, and Decisions rate limits are higher on paid keys. Ask the organizers whether credits are provided.
- [ ] Confirm in AI Studio that the key can call: `gemini-4-hydrogen`, `gemini-4-neon`, `gemini-4-carbon`, `gemini-decision-1`, `gemini-3.8-flash-tts`, and the Interactions API with `antigravity-preview-09-2026`.
- [ ] A GitHub repo (public at submission). Call it `misstep`.
- [ ] Ask the organizers for: **the exact submission deadline** (the event page says "Nov 22 UTC", which may mean 7:00 PM ET on Nov 21), the submission form and its fields, the demo video length, and the rule on pre-existing code.

### 4.2 Hardware and props **[HUMAN]**

- [ ] A laptop with at least 20 GB of free disk space.
- [ ] A webcam, or a phone used as a webcam (DroidCam or Camo). **Mount it overhead** (a phone tripod with an arm, or a phone taped to a shelf), looking straight down at the work area. Overhead views count objects far better.
- [ ] Bright, even light. A white sheet of paper or tablecloth as the background.
- [ ] **MedPrep demo kit** (any pharmacy, e.g. CVS or Duane Reade):
  - A 7-day AM/PM pill organizer with clear or bright lids.
  - Two colors of small candy as "pills": blue and red M&Ms or Skittles. Separate them into two cups.
  - A small hand-sanitizer bottle, a pen, and a printed "log sheet" (any paper with a box saying *Initials*).
  - The printed **MedPrep card** (`demo/medprep_card.md`, created in Phase 5).
- [ ] Earbuds or a small speaker so the room can hear the alerts.

### 4.3 Software

| Tool | Version | Install (Windows PowerShell) | Install (macOS) |
|---|---|---|---|
| Python | 3.11 or later | already installed (3.11.9) | `brew install python@3.11` |
| ffmpeg and ffprobe | any recent | `winget install Gyan.FFmpeg`, then **reopen the terminal** | `brew install ffmpeg` |
| git | any | `winget install Git.Git` | preinstalled |
| A Chromium browser | any | Edge or Chrome | Chrome |

**Python packages** (`requirements.txt`):

```
google-genai>=3.2        # Decisions API needs >=3.2 per docs; use latest
fastapi>=0.115
uvicorn[standard]>=0.30
pydantic>=2.7
python-dotenv>=1.0
pyyaml>=6.0
tenacity>=8.3
numpy>=1.26
pandas>=2.2
scikit-learn>=1.4        # roc_auc_score
matplotlib>=3.8
jinja2>=3.1
requests>=2.32
tqdm>=4.66
rich>=13.7
pytest>=8.2
```

**Frontend:** plain HTML, CSS and JavaScript served by FastAPI. No build step. For charts, load Chart.js 4.4.1 from cdnjs.

### 4.4 Environment variables (`.env`; commit only `.env.example`)

```
GEMINI_API_KEY=...
MISSTEP_MAX_USD=60            # hard budget stop for all model calls combined
MISSTEP_CONCURRENCY=6         # parallel model calls
MISSTEP_DATA_DIR=./data
MISSTEP_CACHE_DIR=./cache
MISSTEP_RUNS_DIR=./runs
MISSTEP_CONFIG=./configs/pipeline_v1.yaml
```

---

## 5. Repository layout

```
misstep/
├── PLAN.md                      # this file
├── PROGRESS.md                  # living checklist (Appendix C)
├── README.md                    # written in Phase 7
├── .env.example
├── .gitignore                   # .env, .venv/, data/, cache/, runs/, __pycache__/
├── requirements.txt
├── configs/
│   ├── pipeline_v1.yaml         # thresholds, question templates, models (section 6.3)
│   └── FROZEN                   # created in Phase 4: the hash of the final config
├── misstep/                     # the library
│   ├── __init__.py
│   ├── settings.py              # loads .env and the YAML config
│   ├── gemini.py                # THE ONLY place that talks to Google APIs: cache, retry, cost
│   ├── cost.py                  # price table and running spend; raises BudgetExceeded
│   ├── cache.py                 # disk cache keyed by a request hash
│   ├── schemas.py               # pydantic models (section 6.1)
│   ├── video.py                 # ffprobe, clip, still, frames (ffmpeg wrappers)
│   ├── compiler.py              # Neon: procedure → Procedure
│   ├── localizer.py             # Hydrogen: video + Procedure → StepWindows
│   ├── checker.py               # Decision 1: full-video + per-clip questions
│   ├── rules.py                 # plain-code verdict logic
│   ├── adjudicator.py           # Carbon: resolve uncertain, veto false alarms
│   ├── pipeline.py              # run_pipeline(procedure, video) -> RunResult
│   ├── live.py                  # LiveSession state machine
│   └── tts.py                   # 3.8 TTS, pre-generates alert audio
├── data/                        # gitignored
│   ├── cc4d_annotations/        # cloned annotations repo
│   ├── cc4d_downloader/         # cloned downloader repo
│   ├── videos/                  # <recording_id>.mp4 (360p)
│   ├── gold.jsonl               # built in Phase 1
│   ├── procedures/              # <activity_id>.json (compiled recipes)
│   └── splits.json              # {"dev": [...], "test": [...]}
├── datasets/
│   ├── cc4d.py                  # annotation loader → gold labels
│   └── splits.py                # recipe-held-out split selection
├── eval/
│   ├── baselines.py             # B0, B1 (Hydrogen), B2 (Neon)
│   ├── run_eval.py              # run a system over a split (the test lock lives here)
│   ├── score.py                 # metrics + bootstrap CIs (the only reader of test gold)
│   ├── report.py                # EVAL_RESULTS.md + runs/report/index.html
│   ├── field_eval.py            # scores live sessions against human labels
│   └── stress.py                # stress ladder
├── agent/
│   └── failure_analyst.py       # Managed Agent loop
├── server/
│   ├── app.py                   # FastAPI
│   └── static/
│       ├── index.html           # home: upload a procedure + video, or go live
│       ├── live.html / live.js  # webcam loop, step board, alerts
│       ├── review.html          # labeling tool for field runs
│       └── style.css
├── scripts/
│   ├── smoke_test.py            # Phase 0
│   ├── select_subset.py         # Phase 0/1: pick recordings before downloading
│   └── download_subset.py       # Phase 0: resumable download of the chosen IDs only
├── demo/
│   ├── medprep_card.md          # the live-demo procedure
│   └── samples/hands.mp4        # 15 s phone clip for smoke tests [HUMAN]
├── docs/
│   ├── FINDINGS.md              # API and dataset facts discovered in Phase 0/1
│   ├── CHANGELOG_FIXES.md       # v1 → v2 → v3 with dev metrics
│   └── EVAL_RESULTS.md          # final numbers (generated)
├── tests/
│   ├── test_rules.py
│   ├── test_score.py
│   └── test_schemas.py
├── cache/                       # gitignored
└── runs/                        # gitignored: all outputs
```

---

## 6. Shared contracts

> Build these first (Phase 0). Every phase depends on them, so keep them stable.

### 6.1 `misstep/schemas.py`

```python
from __future__ import annotations
from enum import Enum
from typing import Literal, Optional
from pydantic import BaseModel, Field

class ErrorCategory(str, Enum):
    missing_step = "missing_step"
    order = "order"
    measurement = "measurement"
    technique = "technique"
    preparation = "preparation"
    timing = "timing"
    temperature = "temperature"
    other = "other"

class Quantity(BaseModel):
    item: str                      # "salt"
    amount: str                    # "1" or "1/2" (kept as text)
    unit: str                      # "tsp"

class VisualCheck(BaseModel):
    check_id: str                  # "S4_c1"
    text: str                      # positive, visual, one fact: "The pan is on the stove before the egg is added"
    category: ErrorCategory        # which error this check detects when false

class Step(BaseModel):
    step_id: str                   # dataset step id as a string for CC4D; "S1".. for free-form procedures
    text: str                      # original instruction, unchanged
    visible_evidence: list[str]    # what a camera would show if the step was done
    quantity: Optional[Quantity] = None
    checks: list[VisualCheck] = []
    must_follow: list[str] = []    # step_ids that must be FINISHED before this one STARTS
    optional: bool = False
    checkable: bool = True         # False if a camera can't verify it (e.g. "wait 10 minutes" with nothing visible)

class Procedure(BaseModel):
    procedure_id: str
    title: str
    source: Literal["cc4d", "medprep", "upload"]
    steps: list[Step]

class StepWindow(BaseModel):
    step_id: str
    found: bool
    start_s: Optional[float] = None
    end_s: Optional[float] = None
    note: str = ""

class StepCheck(BaseModel):
    step_id: str
    p_done_full: float             # Decisions noul over the whole video
    p_done_clip: Optional[float] = None
    measurement_probs: Optional[dict[str, float]] = None   # {"less","correct","more","cannot_tell"}
    check_p_true: dict[str, float] = {}                    # check_id -> P(true)

class Evidence(BaseModel):
    t_s: Optional[float] = None
    text: str

class StepVerdict(BaseModel):
    step_id: str
    status: Literal["ok", "error", "uncertain", "not_checkable"]
    categories: list[ErrorCategory] = []
    p_error: float = Field(ge=0, le=1)       # the system's probability that this step has an error
    decided_by: Literal["rules", "carbon"] = "rules"
    evidence: list[Evidence] = []

class RunResult(BaseModel):
    run_id: str
    system: str                    # "misstep", "B0", "B1_hydrogen", "B2_neon", ablation names
    config_version: str
    recording_id: Optional[str] = None
    procedure_id: str
    windows: list[StepWindow] = []
    checks: list[StepCheck] = []
    verdicts: list[StepVerdict]
    cost_usd: float
    latency_s: float
    errors: list[str] = []         # non-fatal pipeline errors (e.g. "carbon timeout on S5")
```

### 6.2 Gold labels (`data/gold.jsonl`, one line per recording)

```json
{"recording_id": "1_7", "activity_id": "1", "is_error": true, "duration_s": 742.0,
 "steps": [
   {"step_id": "12", "has_error": true,  "categories": ["measurement"], "start_s": 101.2, "end_s": 130.5, "description": "..."},
   {"step_id": "15", "has_error": true,  "categories": ["missing_step"], "start_s": null, "end_s": null, "description": "..."},
   {"step_id": "16", "has_error": false, "categories": [], "start_s": 131.0, "end_s": 160.0, "description": "..."}
 ]}
```

**Category mapping** from CaptainCook4D names (Phase 1 checks the exact strings in `error_category_idx.csv`):

| Dataset name | Ours |
|---|---|
| Missing Step | missing_step |
| Order | order |
| Measurement | measurement |
| Technique | technique |
| Preparation | preparation |
| Timing | timing |
| Temperature | temperature |
| Other | other |

### 6.3 `configs/pipeline_v1.yaml`

```yaml
version: v1
models:
  compiler: gemini-4-neon
  compiler_thinking: medium
  localizer: gemini-4-hydrogen
  localizer_thinking: low
  localizer_processing: agentic        # fallback: static (with localizer_fps)
  localizer_fps: 0.5
  decider: gemini-decision-1
  adjudicator: gemini-4-carbon
  adjudicator_thinking: medium
  tts: gemini-3.8-flash-tts
  tts_voice: ""                        # empty = pick a calm prebuilt voice in Phase 5
media:
  full_video_resolution: low
  clip_resolution: medium
  measurement_resolution: high
  clip_pad_s: 2.0
  clip_max_s: 120                      # longer windows are split; use the max probability
thresholds:
  missing_p_done_max: 0.25             # p_done_full below this AND not localized => missing_step
  present_p_done_min: 0.60
  order_tolerance_s: 2.0
  measurement_error_min: 0.60          # P(less)+P(more) at or above this => measurement error
  check_false_min: 0.65                # 1 - P(true) at or above this => error in that check's category
  uncertain_band: [0.35, 0.65]         # p_error inside this band => uncertain => Carbon
adjudicator:
  enabled: true
  max_calls_per_video: 6
  can_veto_errors: true                # error -> ok allowed
  can_create_errors_from_ok: false     # NEVER
questions:
  done_full: >-
    Watch the entire recording. At any point, does the person perform this step: "{step_text}"?
    Visible evidence of this step would include: {evidence}.
  done_clip: >-
    In this clip, does the person perform this step: "{step_text}"?
  measurement: >-
    This step requires {amount} {unit} of {item}. In this clip, how much {item} does the person actually use?
  measurement_options:
    less: "Clearly less than {amount} {unit}"
    correct: "About {amount} {unit}"
    more: "Clearly more than {amount} {unit}"
    cannot_tell: "The amount cannot be determined from this clip"
  check: >-
    In this clip, is the following true: {check_text}
live:
  tick_s: 2.0
  frames_per_tick: 6
  frame_interval_ms: 500
  frame_width_px: 640
  p_done_live: 0.80
  p_started_live: 0.80
  consecutive_ticks: 2
```

**Rule:** code reads every threshold and template from this file. **Nothing is hard-coded.** The Managed Agent in Phase 4 may only change `thresholds`, `questions`, `media`, `models.localizer_processing`, `models.localizer_fps`, and `adjudicator.max_calls_per_video`.

### 6.4 Predictions and runs on disk

```
runs/<split>/<system>/<timestamp>/
  config.yaml                 # a copy of the config used
  results.jsonl               # one RunResult per recording
  scores.json                 # written by score.py (dev only, until the final test run)
  failures.jsonl              # dev only: per-step mistakes with probabilities and question text
  log.txt
```

### 6.5 The test lock (enforced in `eval/run_eval.py`)

- `--split test` refuses to run unless all of these hold:
  1. `configs/FROZEN` exists.
  2. Its SHA-256 matches the config being used.
  3. The `--final` flag is passed.
- If `runs/test/misstep/` already contains a run, it refuses unless `--rerun-reason "<text>"` is given. That text is written to `docs/EVAL_RESULTS.md`.
- Baselines B0, B1 and B2 may run on test at any time (they have nothing to tune), but their **scores stay hidden** until the final run. `score.py` writes them to a file nobody opens until Phase 6.

### 6.6 Cache, retry and cost (in `misstep/gemini.py`)

- **Cache key:** `sha256(model + canonical JSON of the request, with file bytes replaced by their sha256)`. The cache stores the raw response JSON under `cache/<model>/<key>.json`.
- **Retry:** tenacity with exponential backoff (2 s, then 4, 8, 16, 32), up to 6 attempts, on 429, 500, 503 and timeouts. Never retry a 400; log it.
- **Cost:** read `usage` from each response and multiply by the price table in `misstep/cost.py` (section 2.1 prices; Decisions $0.10/M input; TTS price from the docs). Add to `runs/spend.json`. Raise `BudgetExceeded` once spend passes `MISSTEP_MAX_USD`.
- **Concurrency:** use an `asyncio.Semaphore(MISSTEP_CONCURRENCY)` around every call.
- **Public functions** (everything else must use these):

```python
async def generate_json(model: str, parts: list, schema: type[BaseModel] | dict,
                        thinking_level: str | None = None, media_resolution: str | None = None,
                        video_processing: dict | None = None, system: str | None = None) -> dict
async def decide(input_blocks: list[dict], questions: dict[str, dict]) -> dict   # returns {"answers":..., "usage":...}
async def upload_file(path: str) -> str            # returns a Files API URI once the file is ACTIVE; cached by file hash
async def tts(text: str, voice: str | None = None) -> bytes   # WAV bytes
async def agent_interaction(**kwargs) -> dict      # Interactions API passthrough (Phase 4)
```

---

## Phase 0: Setup, smoke tests, start the download

**Timebox:** 45 min · **Owner:** everyone · **Depends on:** nothing

### Goal
Every API we rely on has answered a real call, the dataset download is running in the background, and the repo skeleton exists.

### Tasks
1. **[HUMAN]** Get the API key and post it in the team password manager or DM. **Never in git.**
2. **[HUMAN]** Record `demo/samples/hands.mp4` on a phone: about 15 seconds, overhead view, a hand putting 2 candies into a cup.
3. **[AGENT]** Create the repo layout (section 5), `.gitignore`, `.env.example`, `requirements.txt`, and empty modules.
4. **[AGENT]** Set up the environment:
   ```powershell
   python -m venv .venv
   .venv\Scripts\Activate.ps1
   python -m pip install -U pip
   pip install -r requirements.txt
   ffmpeg -version   # must print a version; if not, winget install Gyan.FFmpeg and reopen the terminal
   ```
5. **[AGENT]** Clone the dataset tools:
   ```powershell
   git clone https://github.com/CaptainCook4D/annotations data/cc4d_annotations
   git clone https://github.com/CaptainCook4D/downloader data/cc4d_downloader
   ```
6. **[AGENT]** Write `scripts/select_subset.py` (the Phase 1 split logic, in short):
   - Read the annotations and pick **test = all recordings of 6 held-out recipes**, capped at 40 recordings, balanced about 50/50 between error and clean.
   - Pick **dev = 16 recordings from other recipes**, also balanced.
   - Prefer recordings under 15 minutes. Note this bias in FINDINGS.
   - Write `data/splits.json`.
7. **[AGENT]** Write `scripts/download_subset.py`:
   - Read `data/cc4d_downloader/metadata/download_links.json`.
   - Download **only the 360p GoPro file** for each ID in `splits.json`, **dev first, then test**, to `data/videos/<recording_id>.mp4`.
   - Resumable (`.part` file plus a size check), with a progress bar, and logs the total GB.
   - If the JSON structure is unclear, inspect it and record the structure in FINDINGS. You may instead run the official `download_gopro_data.py --data2d` with an output directory and copy the needed files over.
8. **[AGENT]** Start the download **in the background now**. It can run while Phases 1–3 continue.
9. **[AGENT]** Write `misstep/settings.py`, `cache.py`, `cost.py`, `schemas.py` and `gemini.py` (section 6).
10. **[AGENT]** Write and run `scripts/smoke_test.py`. It prints a PASS/FAIL table and writes `docs/FINDINGS.md`:

    | # | Check | What to record in FINDINGS |
    |---|---|---|
    | 1 | List models; confirm the 4 Gemini 4 IDs, `gemini-decision-1` and `gemini-3.8-flash-tts` | exact IDs available |
    | 2 | Hydrogen, text in, JSON out (structured output schema), thinking `low` | config field names for thinking and schema |
    | 3 | Upload `hands.mp4` through the Files API; Hydrogen answers "how many candies go into the cup?" with **agentic** processing | how to set `processing` on a video part; whether `processing_call` steps appear |
    | 4 | **Decisions** on `hands.mp4` inline: one `noul`, one `choice` (with `cannot_tell`), one `score` | response attribute names (`answers[k].noul`, `.confidence`, `.probabilities`, ...), the **resolution field name** on a video block, latency in ms |
    | 5 | Decisions with **6 JPEG frames** as image blocks plus one question | latency in ms (this is the live-mode path) |
    | 6 | Neon reads a 1-page PDF (render `demo/medprep_card.md` to a quick PDF, or use any PDF) | PDF part format |
    | 7 | Carbon answers one short question about the video clip | latency |
    | 8 | TTS turns "Wait. You skipped step four." into WAV | config for audio output and voice selection; audio format and sample rate |
    | 9 | Antigravity: `interactions.create` with one custom function tool `get_number()`; handle `requires_action`, send the result back, get the final text | exact shape of `requires_action`, how to send the function result, how to pass `environment` |

### Done when
- [ ] `python scripts/smoke_test.py` shows **all 9 PASS**, or failures are written up with a workaround in FINDINGS.
- [ ] `data/splits.json` exists and the download is running (`data/videos/` is growing).
- [ ] `pytest tests/test_schemas.py` passes (round-trip each schema).
- [ ] First commit pushed.

### Fallbacks
- **Agentic video fails:** use static processing with `fps: 0.5` and low resolution. Set `localizer_processing: static`.
- **Decisions can't take video:** sample 1 frame per second with ffmpeg and send image blocks (up to about 60 per call). Same questions.
- **Antigravity custom tools are blocked:** run the Phase 4 loop with Neon and normal function calling in a local loop. Note in the README that the Managed Agents prize entry is then weaker.
- **TTS fails:** use the browser's `speechSynthesis`.
- **Box download is too slow:** see section 16.

---

## Phase 1: Dataset, gold labels, splits

**Timebox:** 75 min · **Owner:** Data/Eval (person A) · **Depends on:** Phase 0 tasks 5–6

### Goal
Turn CaptainCook4D annotations into clean, per-step gold labels and lock the splits.

### Tasks
1. **[AGENT]** Read `data/cc4d_annotations/ANNOTATIONS.md` and look at real rows. In FINDINGS, record:
   - the exact filenames and fields;
   - the category strings in `error_category_idx.csv`;
   - how a recording maps to its recipe;
   - how missing steps appear;
   - whether the recipe steps come from `activity_id_step_id_mapping` plus `step_idx_description`;
   - what is in `task_graphs/`.
2. **[AGENT]** `datasets/cc4d.py`:
   - `load_recipes() -> dict[activity_id, list[(step_id, description)]]`, in recipe order.
   - `load_task_graph(activity_id) -> dict[step_id, list[predecessor_step_id]]`. If the graph format is unusable, fall back to "the recipe order is a chain" and note it.
   - `load_gold() -> list[GoldRecording]`, written to `data/gold.jsonl` (section 6.2).
   - **Unit of evaluation:** every recipe step of the recording's activity, scored once per recording.
   - **If a recipe step is absent from the recording's annotation:** decide by inspection and record the rule in FINDINGS. Default: treat it as a gold `missing_step` only if an annotation says so. Otherwise drop that step from scoring.
   - Steps performed more than once collapse into one evaluation unit: `has_error = any(...)`, categories = union.
3. **[AGENT]** `datasets/splits.py`: the final split logic (the same as `select_subset.py`, which may simply import it).
   - Hold out whole recipes for test.
   - Use a fixed seed (`20261121`).
   - Print a table: recordings, steps, error steps per category, total hours, for each split.
   - If a category has fewer than 5 gold errors in test, list it as **"low-n, reported but not claimed"**.
4. **[AGENT]** `procedure_from_recipe(activity_id) -> str`: a plain-text procedure (numbered steps **with the dataset step IDs**) that becomes compiler input. It must **never** include error information.
5. **[AGENT]** `tests/test_score.py` scaffold with 3 hand-made gold/prediction pairs. The expected metric values are worked out by hand in comments.

### Done when
- [ ] `data/gold.jsonl` exists; the split table is printed and pasted into FINDINGS.
- [ ] Test recipes are **disjoint** from dev recipes, checked by an assert.
- [ ] Spot check **[HUMAN]**: open 2 dev recordings at a labeled error timestamp and confirm the label matches what you see.
- [ ] Commit.

### Fallback
If the split files are confusing, ignore them and make our own recipe-held-out split (task 3).

---

## Phase 2: Eval harness and baselines

**Timebox:** 90 min · **Owner:** Data/Eval (person A) · **Depends on:** Phase 1 and the first dev videos downloaded

### Goal
`run_eval.py` scores any system on any split with confidence intervals. Baselines run before Misstep exists.

### Tasks
1. **[AGENT]** `eval/score.py` (see Appendix B):
   - Step-level **precision, recall and F1** for "has error" (primary metric).
   - **Per-category recall.** A predicted error counts toward a category if that category is among the predicted ones.
   - **Recording-level** accuracy and F1 (recording has any error).
   - **AUROC** and **ECE** (10 bins) on `p_error`.
   - **Coverage:** the share of steps not marked `uncertain`. Score `uncertain` as "ok" for F1, and also report F1 on covered steps only.
   - **Cost and latency per recording:** mean and p90.
   - **95% bootstrap CI:** 1,000 resamples over *recordings*.
   - **Paired bootstrap** for (Misstep − B1) F1, giving a CI on the difference.
2. **[AGENT]** `eval/baselines.py`:
   - **B0:** every step ok, `p_error = base rate on dev`.
   - **B1:** **one** Hydrogen call (thinking `high`), the full video (Files API URI), the procedure text and the category definitions. Prompt A.4 asks for JSON per step: `has_error`, `categories`, `confidence`. Set `p_error = confidence if has_error else 1 - confidence`.
   - **B2:** the same with Neon (thinking `high`).
   - Baselines get **the same step list and category definitions** as Misstep. Fair baselines are part of the pitch.
3. **[AGENT]** `eval/run_eval.py --system {B0,B1,B2,misstep} --split {dev,test} [--limit N] [--config path] [--final]`:
   - Async, uses the semaphore, writes everything per section 6.4.
   - Enforces the test lock (section 6.5).
   - For dev runs, writes `failures.jsonl`: every false positive and false negative, with step text, gold, prediction, probabilities and the question texts used.
4. **[AGENT]** Run B0, B1 and B2 on dev. Start B1 and B2 on test **in the background**; scores stay hidden.
5. **[AGENT]** `tests/test_score.py`: the hand-computed cases pass.

### Done when
- [ ] `python eval/run_eval.py --system B1 --split dev` completes and prints a metrics table with CIs.
- [ ] `pytest tests/test_score.py` passes.
- [ ] B1 and B2 test runs are running or finished; scores are **not** printed.
- [ ] Commit.

### Fallback
If B1 on full videos is slow, run it with `--limit 8` on dev first, then the rest in the background.

---

## Phase 3: The Misstep pipeline

**Timebox:** 3 h · **Owner:** Pipeline (person B) · **Depends on:** Phase 0 (it can start before Phases 1–2 finish, using a dev recording or `hands.mp4`)

### Goal
`run_pipeline(procedure_text, video_path) -> RunResult` works end to end on one dev recording, then on the whole dev split.

### Tasks
1. **[AGENT] `misstep/video.py`**
   - `probe(path) -> {duration_s, width, height, fps}` via `ffprobe -v error -show_entries format=duration:stream=width,height,r_frame_rate -of json`.
   - `clip(path, start_s, end_s, out, pad_s)` via:
     ```
     ffmpeg -y -ss {max(0, start - pad)} -to {min(dur, end + pad)} -i in.mp4 -c:v libx264 -preset veryfast -crf 28 -c:a aac -b:a 64k out.mp4
     ```
     **Keep the audio.** Sizzling, beeps and pouring sounds help with timing and temperature checks.
   - `still(path, t_s, out, width=None)` and `frames(path, fps, out_dir)`.
   - Clips go to `cache/clips/<recording>/<step>_<start>_<end>.mp4`, reused if present.
2. **[AGENT] `misstep/compiler.py`:** `compile_procedure(text_or_file, source, procedure_id, fixed_step_ids=None) -> Procedure`
   - Neon with structured output, using the `Procedure` schema and prompt A.1. Input can be text, a PDF, or an image of a card.
   - If `fixed_step_ids` is given (CC4D), the output **must keep exactly those IDs and the same number of steps**. Assert this, and retry once with the validation error appended.
   - Each `VisualCheck` is **one positive visual fact**. Comparisons with numbers belong in `quantity`, not in `checks`.
   - Save to `data/procedures/<procedure_id>.json`. **Compile once per recipe, not once per recording.** Then **[HUMAN]** skims 2 compiled recipes (5 min).
3. **[AGENT] `misstep/localizer.py`:** `localize(video_uri, procedure) -> list[StepWindow]`
   - Hydrogen, prompt A.2, `processing: agentic` (or static fallback), low resolution, thinking `low`.
   - Validate: `0 <= start < end <= duration`; clamp; drop windows longer than 50% of the video (mark them `found` with a note); every procedure step appears exactly once.
4. **[AGENT] `misstep/checker.py`**
   - **Full-video call** (one per recording): the video at `full_video_resolution`, plus a `done_full` `noul` question per step. This gives `p_done_full`.
   - **Per-step clip calls:** for each step with `found == true`, cut a clip (split into ≤ `clip_max_s` chunks and take the max over chunks). Then **in one request per clip** ask:
     - `done_clip` (noul);
     - `measurement` (choice with 4 options) if `quantity` is set, at `measurement_resolution`;
     - one `check` (noul) for each `VisualCheck`.
   - Question keys must match `[A-Za-z0-9_-]+` and be at most 64 characters, e.g. `S12_done`, `S12_meas`, `S12_c1`.
   - Run clips concurrently.
5. **[AGENT] `misstep/rules.py`** (pure functions; unit-tested in `tests/test_rules.py`). For each checkable step, compute candidate errors:
   - **missing_step:** `not window.found and p_done_full < missing_p_done_max`. If `not found` but `p_done_full >= present_p_done_min`, the step is **uncertain**: the localizer missed it, but Decisions thinks it happened.
   - **order:** for each `pred` in `must_follow`, if both are found and `start(step) < end(pred) - order_tolerance_s`, flag order.
   - **measurement:** `P(less) + P(more) >= measurement_error_min` and `P(cannot_tell) < 0.5`.
   - **check category X:** `1 - P(true) >= check_false_min`.
   - **`p_error`:** the max over all candidate error probabilities (for order, use 0.9 when the times are clear).
   - **Status:**
     - `error` if any candidate is above threshold;
     - `uncertain` if `p_error` is inside `uncertain_band`;
     - otherwise `ok`;
     - `not_checkable` if `checkable == false` (scored as ok, and reported).
6. **[AGENT] `misstep/adjudicator.py`**
   - For steps that are `error` or `uncertain`, sorted by closeness to 0.5, up to `max_calls_per_video` per video:
     - Carbon, prompt A.3, with a **high-resolution clip** plus the step, its checks and the Decisions probabilities.
   - Carbon returns `{verdict: error|ok|cannot_tell, categories, rationale, evidence_s}`. Apply only these transitions:
     - `uncertain → error` or `ok`;
     - `error → ok` (veto);
     - `cannot_tell` → leave the step as it is.
   - Record `decided_by="carbon"`. **Never** call Carbon on `ok` steps.
7. **[AGENT] `misstep/pipeline.py`:** compiler (cached) → upload → localizer → checker → rules → adjudicator → `RunResult`. Measure wall time and cost; collect non-fatal errors.
8. **[AGENT]** Hook it into `run_eval.py` as `--system misstep`. Also add **ablations** controlled by flags:
   - `--no-carbon`;
   - `--no-localizer` (full-video Decisions only; no clips, no order checks);
   - `--decisions-only-full` (same as above, also without measurement checks).
9. **[AGENT]** Run Misstep on **3 dev recordings**, inspect them, then run it on the full dev split.

### Done when
- [ ] `python -c "from misstep.pipeline import run_pipeline_sync as r; print(r('data/procedures/<id>.json','data/videos/<rec>.mp4').model_dump_json(indent=2))"` prints a valid RunResult.
- [ ] `pytest tests/test_rules.py` passes: at least one case per category, the uncertain band, and the Carbon transition rules.
- [ ] A full dev run finishes, with the metrics table printed next to B1 and B2 on dev.
- [ ] Mean cost per recording is under $0.50 and mean latency under 4 minutes. If either is higher, write down why.
- [ ] Commit.

### Fallbacks
- **Localizer windows are poor** (on the 3 inspected recordings, more than 30% are wrong by over 10 s):
  - Switch to static processing at `fps: 1`.
  - Or use **Decisions for localization**: split the video into 10-second segments and ask a `choice` question ("which step is happening?", options = steps + `none`) for each segment, in batches.
- **Running out of time:** ship `--no-localizer` (full-video Decisions plus rules plus Carbon). It still compares honestly with the baselines.

---

## Phase 4: Improve on the dev set with the Managed Agent

**Timebox:** 75 min · **Owner:** Agent/story (person D), with person B · **Depends on:** Phase 3 dev run

### Goal
Turn dev-set failures into measured improvements, done by a Managed Agent with a logged trail. Then freeze.

### Tasks
1. **[AGENT] `agent/failure_analyst.py`**
   - **Local tools,** answered when the interaction returns `requires_action`:
     - `get_failure_summary() -> {counts by (FP/FN, category), dev metrics, current config version}`
     - `get_failures(category: str, kind: "FP"|"FN", limit: int<=15) -> list` (step text, gold, prediction, probabilities, question texts, a 1-line description of the clip)
     - `get_config() -> yaml text`
     - `run_dev_eval(config_yaml: str, reason: str) -> {metrics, delta_vs_best, per_category_recall}`
       - Validates that only the allowed keys changed (section 6.3) and writes `configs/pipeline_vN.yaml`.
       - Re-runs **dev only**. The cache makes reruns cheap: only changed Decisions questions are billed.
       - **At most 3 calls per session**, enforced by the tool.
   - **Multimodal context:** attach up to 8 JPEG stills (one per worst failure, at the step's midpoint) as inline images in the first input.
   - **Session setup:**
     - agent `antigravity-preview-09-2026`;
     - `agent_config={"type":"antigravity","model":"gemini-4-neon","max_total_tokens": 400000}`;
     - `environment="remote"`;
     - prompt A.5.
   - Stream or poll until done. Save the whole transcript to `runs/agent/<ts>/transcript.json`.
   - The agent's final answer must be a markdown changelog entry. **Append it to `docs/CHANGELOG_FIXES.md`.**
2. **[HUMAN]** Read the changelog. Accept the best config by dev F1, **as long as dev coverage stays at least 80%**. Note the reasoning.
3. **[AGENT]** Freeze: copy the accepted config to `configs/pipeline_final.yaml` and write its SHA-256 to `configs/FROZEN`.

### Done when
- [ ] `docs/CHANGELOG_FIXES.md` has v1 → v2 (→ v3) entries with dev metrics before and after, and the reason for each change.
- [ ] `configs/FROZEN` exists.
- [ ] Commit.

### Fallback
If the agent call fails, a human does one round by hand: read `failures.jsonl`, change 2–3 things, re-run dev, write the same changelog. Keep the Managed Agent code in the repo and say honestly in the README what ran.

### What usually goes wrong (hints to give the agent)
- **Measurement:** amounts are hard to see at 360p. Fix: high resolution, `cannot_tell` handled as uncertain.
- **Order:** windows overlap at step boundaries. Fix: tune `order_tolerance_s`.
- **Technique:** checks are too vague. Fix: reword them as concrete visible facts.
- **Missing step:** the localizer is overconfident. Fix: require both "not found" and a low `p_done_full`.

---

## Phase 5: Live mode and the MedPrep demo

**Timebox:** 3 h · **Owner:** Live/UI (person C) · **Depends on:** Phase 0 (it can run in parallel with Phases 1–4)

### Goal
A judge stands at the table, follows the MedPrep card, makes any mistake they like, and hears an alert within about 4 seconds. A final check verifies the organizer contents.

### 5.1 The MedPrep card (`demo/medprep_card.md`) **[HUMAN + AGENT]**

```
MEDPREP CARD: Patient: Demo, Week 47
1. Sanitize your hands with the hand sanitizer.
2. Place this card face-up to the LEFT of the organizer.
3. Open the MON, TUE, WED and THU morning (AM) lids.
4. Put 2 BLUE tablets in each of MON, TUE, WED, THU (AM).
5. Put 1 RED tablet in MON and WED (AM) only.
6. Close all four lids.
7. Write your initials on the log sheet.
```

- **Order constraints:** 1 before 3; 3 before 4 and 5; 4 and 5 before 6; 6 before 7. Steps 4 and 5 can happen in either order.
- **Possible mistakes:**
  - skip sanitizing;
  - 1 or 3 blue tablets in a compartment;
  - red tablet in TUE;
  - close the lids before putting in the red tablets;
  - forget the initials.
- **[HUMAN]** Print 3 copies and do a test run.

### 5.2 Server (`server/app.py`)

| Endpoint | Does |
|---|---|
| `POST /api/procedure` (text, file or image) | Neon compile → Procedure, then **pre-generates alert audio for every step** with TTS (`"Wait. You skipped step {n}: {short text}."`, plus `"Order: finish step {n} before step {m}."` for each order edge) → `{session_id, procedure, alerts: {key: url}}` |
| `POST /api/live/tick` `{session_id, frames: [b64 jpeg x6], t_client}` | Runs one live tick (5.3) → `{step_states, alerts_to_play, latency_ms}` |
| `POST /api/live/finish` `{session_id, still_b64}` | Final verification (5.4) → final report |
| `POST /api/analyze` (procedure + video upload) | Offline `run_pipeline` → RunResult, for the "upload a video" path in the demo |
| `GET /api/sessions/{id}` | The full log for review |
| `GET /static/*` | UI |

Run it with `uvicorn server.app:app --host 0.0.0.0 --port 8000`. Open `http://localhost:8000/static/live.html`; webcam access works on localhost.

### 5.3 The live tick (`misstep/live.py`)

- **State per step:** `pending → in_progress → done`, or `skipped` (alerted).
- **Each tick:**
  1. Take the **6 frames** (3 seconds) as image blocks, oldest first, plus a text block: "Frames are 0.5 s apart, oldest first."
  2. Ask Decisions about the *window*: the first not-done step `k` and the next two (`k+1`, `k+2`), plus every step whose prerequisites are all done. For each:
     - `S{i}_doing` (noul): "In these frames, is the person performing: {step}?"
     - `S{i}_done` (noul): "In these frames, is there visible evidence that this step is complete: {evidence}?"
     - one global `activity` choice: options are every step plus `none`: "Which step is the person working on right now?"
  3. **Advance:** a step becomes `done` after `consecutive_ticks` ticks with `S{i}_done >= p_done_live`, or when the `activity` choice moves past it and its done-evidence was seen once.
  4. **Alert:**
     - If step `j` is `doing` (above `p_started_live`, for consecutive ticks) and some required predecessor `i` of `j` isn't done, play the **skip/order alert** for `i` once.
     - Mark `i` as `skipped`, which can still flip to `done` later. Then show a "late" badge.
- **Latency budget:** frame capture plus upload under 300 ms; Decisions about 250–600 ms; total under 1 s per tick. Log `latency_ms`.
- Log every tick (frames on disk as JPEGs, questions, answers, alerts) to `runs/live/<session>/`.

### 5.4 Final verification (`/api/live/finish`)

1. Take a **full-resolution still** of the open organizer.
   - **[HUMAN]** The demo flow says: *"Before closing, hold the organizer open under the camera."* Or take the still just before step 6.
2. **Decisions** on the still at `ultra_high`, one `choice` per compartment, MON to THU AM:
   - `"How many BLUE tablets are in the {DAY} AM compartment?"` with options 0, 1, 2, 3, 4+, cannot_tell;
   - the same question for RED.
3. Compare against the card **in code**.
4. Any mismatch, or confidence below 0.7, goes to **Carbon** with the still. Carbon's answer is final for the report.
5. **Report:** a step table with statuses, a compartment table, and a timeline of alerts.

### 5.5 UI (`server/static/live.html` + `live.js`)

- **Left:** the webcam preview.
- **Right:** a **step board**, one card per step. Colors: grey = pending, blue = in progress, green = done, red = skipped or error, amber = uncertain.
- **Top:** a big status line ("Step 4 of 7"), a latency readout, and a cost counter.
- **Buttons:** Start, Finish, Reset; plus "Upload procedure" (paste text, a PDF, or a photo of a card).
- **JavaScript:**
  - `getUserMedia({video:{width:1280}})`, plus a canvas to grab a 640px JPEG every 500 ms into a ring buffer of 6.
  - `setInterval(tick, 2000)` POSTs the buffer.
  - Alerts play queued `<audio>` elements so they never overlap.
- **Clean and high-contrast,** readable from 2 meters away on a projector.
- **Must work without TTS:** fall back to `speechSynthesis`.

### 5.6 Pre-flight **[HUMAN]**
- [ ] Mount the camera overhead with even light and white paper underneath.
- [ ] Do 5 practice runs: 1 perfect, and 4 with one different mistake each. Note any false alarms and tune the `live` thresholds in config. **This is a dev activity, not test.**
- [ ] Record a **backup video** of 2 good live runs (screen plus room audio) in case the venue wifi fails.

### Done when
- [ ] A perfect run gives **zero alerts** and every step green.
- [ ] Skipping step 1 triggers the alert **within 2 ticks** of step 3 starting.
- [ ] Putting 3 blue tablets in TUE is caught at Finish.
- [ ] Median tick latency is under 1.5 s.
- [ ] Commit.

### Fallbacks
- **Live ticks are unreliable:** switch the demo to "record 60 s, then analyze": the same procedure through `/api/analyze`, with results in about 30–60 s. It's still the judge's own mistake.
- **Counting is wrong** (expected; this is a *where it breaks* item): crop each compartment from the still (a fixed grid aligned to a taped outline) and send the crops separately at `ultra_high`.

---

## Phase 6: Field eval, stress ladder, the one-time test run

**Timebox:** 2 h · **Owner:** A (eval) + D (field) · **Depends on:** Phase 4 freeze and Phase 5 working

### 6.1 Field eval: strangers and real mistakes **[HUMAN + AGENT]**

- **Protocol** (write it in the README):
  1. Recruit **15–20 other hackers** (and judges if they're willing).
  2. Before they start, each participant **writes on a slip of paper** which mistakes they *intend* to make (or "none"). Fold it and don't show it to us.
  3. They do the MedPrep procedure. We don't coach them.
  4. After the run, **one of us labels the run** with `server/static/review.html` (tick timeline plus frames): per step `ok` / `error` (category).
  5. Then open the slip. Intended mistakes the labeler missed get added. Unintended mistakes count too.
- **[AGENT]** `review.html` and `eval/field_eval.py`. Labels are saved to `data/field_gold.jsonl`, and the field runs are scored with the same `score.py`. Report step F1, per-category recall, alert latency (seconds from mistake to alert) and false alarms per run.
- These runs are **never** used to tune thresholds after collection starts. Freeze the live config before the first field run.

### 6.2 Stress ladder: where it breaks **[AGENT]**

`eval/stress.py` takes 6 dev recordings (or 5 recorded MedPrep runs) and applies one change at a time with ffmpeg:

| Change | How |
|---|---|
| Resolution 360p → 240p → 144p | `-vf scale=-2:240` |
| Low light | `-vf eq=brightness=-0.25:contrast=0.8` |
| Partial occlusion | `-vf drawbox=x=iw*0.3:y=ih*0.3:w=iw*0.3:h=ih*0.3:color=black:t=fill` |
| 2× speed | `-vf setpts=0.5*PTS -af atempo=2.0` |
| Instructions in Spanish | translate the procedure with Neon, re-compile |
| Handwritten card | photo of a handwritten MedPrep card as compiler input **[HUMAN writes it]** |
| Counts ≥ 5 | a variant card asking for 5 tablets |

Report F1 (or the count accuracy) at each level, and **the level where it drops below 50% of the clean score**. That is our *breaking point*.

### 6.3 The final test run (exactly once) **[AGENT, with HUMAN watching]**

```powershell
python eval/run_eval.py --system misstep --split test --config configs/pipeline_final.yaml --final
python eval/run_eval.py --system misstep-no-carbon --split test --config configs/pipeline_final.yaml --final
python eval/run_eval.py --system misstep-no-localizer --split test --config configs/pipeline_final.yaml --final
python eval/score.py --split test --systems B0 B1 B2 misstep misstep-no-carbon misstep-no-localizer --paired-vs B1
```

### Done when
- [ ] The test scores table exists with CIs, including the paired difference against B1.
- [ ] Field eval has at least 10 labeled runs (target 15–20).
- [ ] The stress ladder table exists.
- [ ] All of it is written to `docs/EVAL_RESULTS.md` by `eval/report.py`.
- [ ] Commit.

### Reporting rule (honesty)
Report the test numbers **whatever they are**. If Misstep loses to B2 on some category, say so and explain why. Judges reward honesty and the brief asks for it ("Where does your system still fail?").

---

## Phase 7: Results page, README, demo video, submission

**Timebox:** 75 min · **Owner:** everyone · **Hard stop:** 30 min before the confirmed deadline

### Tasks
1. **[AGENT] `eval/report.py`** writes `runs/report/index.html` (static, Chart.js 4.4.1 from cdnjs) and serves it at `/static/report.html`. Sections:
   1. **Headline:** Misstep step F1 vs B1 and B2, with 95% CIs; the paired difference.
   2. **Per-category recall** (grouped bars), with low-n categories marked.
   3. **Reliability diagram** (calibration) for Misstep vs B1's self-reported confidence. Decisions-based probabilities should be better calibrated, which is a pitch point.
   4. **Cost and latency** per recording for each system.
   5. **Ablations:** the full system, without Carbon, without the localizer.
   6. **Dev improvement:** v1 → v2 → v3 (from `CHANGELOG_FIXES.md`).
   7. **Field eval** table and alert-latency histogram.
   8. **Stress ladder** table with the breaking points.
   9. **Known failures:** 3 concrete examples, each with a still and one sentence.
2. **[AGENT] README.md:**
   - the one-line pitch, a GIF or screenshot, and the model-jobs table (1.4);
   - the architecture diagram (3.1);
   - how to run it (setup, smoke test, eval, live);
   - eval methodology and results (link to the report);
   - dataset citation and license;
   - the field-eval protocol;
   - "built during the event" disclosure;
   - team.
3. **[HUMAN]** Record the **demo video**. Default 2–3 minutes unless the organizers say otherwise. Follow section 17.
4. **[HUMAN]** Submit: repo link, video link, which problem statement (**5 Sigma**), and the **Best Use of Managed Agents** entry. Point the agent entry at `agent/failure_analyst.py` and `docs/CHANGELOG_FIXES.md`.
5. **[HUMAN]** Set up the demo table: camera mounted, kit laid out, cards printed, speaker on, report page open in a second tab, backup video ready.

### Done when
- [ ] The submission form is sent before the deadline, with a screenshot of the confirmation.
- [ ] The repo is public, the README is complete, and there are no secrets in git history (`git log -p | Select-String "AIza"` returns nothing).

---

## 15. Timeline and team split

Times are relative to when building starts (**H0**). Example clock: H0 = 10:30 AM, **code freeze H+9.5 = 8:00 PM**, submit by H+10.5. **If the deadline turns out to be 7:00 PM ET**, use the compressed column.

| Window | Normal | Compressed (deadline 7 PM) | A: Data/Eval | B: Pipeline | C: Live/UI | D: Agent/Story/Props |
|---|---|---|---|---|---|---|
| Setup | H0–H0.75 | H0–H0.5 | Phase 0 (split + download) | Phase 0 (gemini.py, smoke test) | env, UI skeleton | keys, props shopping, `hands.mp4` |
| Build 1 | H0.75–H3 | H0.5–H2 | Phase 1 → Phase 2 | Phase 3 (compiler, localizer) | Phase 5.2–5.3 | MedPrep card, camera rig, recruit field testers |
| Build 2 | H3–H5.5 | H2–H4 | baselines dev and test (bg) | Phase 3 (checker, rules, Carbon), first dev run | Phase 5.4–5.5 | Phase 4 agent code |
| Improve | H5.5–H7 | H4–H5 | scoring and report skeleton | Phase 4 with D | live tuning (5.6) | Phase 4 run; **freeze** |
| Prove | H7–H8.5 | H5–H6 | Phase 6.3 test run, 6.2 stress | stress ladder support | field eval runs | field eval labeling |
| Ship | H8.5–H10.5 | H6–H7 | Phase 7 report | README | backup video | demo video, submission, pitch practice |

### With 2 people
- A+B: Phases 0–4 and 6.3.
- C+D: Phase 5, field eval, video, submission.

### Solo, in this cut order
1. **Must:** Phases 0, 1, 2 (B0 and B1 only), 3 without Carbon, 6.3, and a minimal live demo ("record 60 s then analyze").
2. **Should:** Carbon, the Managed Agent loop, TTS, true live ticks.
3. **Could:** the full stress ladder, field eval with 15 or more people, a polished report.
4. **Won't:** 4K, multi-camera, fine-grained actions, the Shopify track.

---

## 16. Risks and fallbacks

| Risk | Signal | Fallback |
|---|---|---|
| Box download slow or blocked | under 1 GB in 20 min | Shrink to dev 10 / test 20. Use a phone hotspot. Download test videos while building. In the worst case, use whatever finished plus a bigger field eval. Say so in the README. |
| Annotations harder to map than expected | Phase 1 over 1.5 h | Score only the categories that map cleanly (missing_step, order, measurement, technique). List the rest as unscored. |
| Localizer inaccurate | windows off by more than 10 s | Static mode at fps 1, or Decisions segment classification (Phase 3 fallback) |
| Decisions slow on long video | full-video call over 30 s | Split the video into 3 parts, ask the same questions, take the max per step |
| Rate limits (429) | many retries | Lower `MISSTEP_CONCURRENCY` to 3. Run baselines in the background earlier. |
| Budget overrun | `spend.json` over 70% of the cap | Turn Carbon off on dev, cut `--limit`. Every rerun is a cache hit anyway. |
| Managed Agent fails | tool loop errors | Manual round, same changelog format; be honest in the README |
| Live mode flaky in the room | false alarms on a perfect run | Raise `consecutive_ticks` to 3; fall back to record-then-analyze |
| Wifi dies during judging | — | Backup video, plus the report page open locally |
| Test results are disappointing | Misstep ≤ B1 | Report it. Lead with calibration, coverage-adjusted F1, cost, live usefulness, and an honest analysis. A clear "here's where it breaks" still scores well on this brief. |

---

## 17. Demo script and judge Q&A

### 3-minute demo
1. **0:00 – Hook (20 s):** "Procedures fail one skipped step at a time: medication prep, lab protocols, maintenance. Today's AI can describe a video but can't tell you which step went wrong. We measured that." *(Only use a statistic, e.g. on medication errors, if a teammate has checked its source today.)*
2. **0:20 – Live (70 s):** Hand a judge the MedPrep card: *"Do it, and make any mistake you want. Don't tell us."* The alert speaks, the board turns red, and Finish shows the compartment check.
3. **1:30 – Proof (45 s):** The report page:
   - test F1 vs one-call Hydrogen and Neon, with CIs, **on recipes the system never saw**;
   - the calibration plot;
   - the field-eval numbers from today's strangers.
4. **2:15 – Honesty (30 s):** The stress-ladder breaking points and one failure we fixed (from the changelog: "the Managed Agent found X; changing Y raised measurement recall from a to b").
5. **2:45 – Architecture (15 s):** Neon compiles, Hydrogen localizes, Decision 1 checks every step with calibrated probabilities, Carbon adjudicates. Built today.

### Likely questions and our answers
- **Why not one model call?** Measured: see B1/B2 vs Misstep. Decisions also gives calibrated per-question probabilities, so we can abstain instead of guessing.
- **Did you overfit?** Test recipes were held out entirely, the config was frozen by hash before the single test run, and the field eval used strangers with sealed intended mistakes.
- **Where does it fail?** Small amounts at low resolution, counting above 4, heavy occlusion. Show the ladder.
- **Why Carbon only sometimes?** It's slow and expensive. It only reviews uncertain steps and false-alarm candidates, and can only remove errors, so it can't make recall worse by inventing new ones.
- **Privacy?** An overhead camera sees hands and objects, not faces. Live mode sends 640px frames. Field-run frames are deleted after the event unless the participant agrees otherwise.
- **What's the cost?** Show cost per recording from the report; Decisions is $0.10 per million input tokens.

---

## Appendix A: Prompts

> Use these as the system or user text. Fill `{placeholders}`. Keep them in `misstep/prompts.py` as constants.

### A.1 Compiler (Neon)

```
You convert a written procedure into a machine-checkable step graph for a camera-based checker.

Input: a procedure (text, PDF, or photo of a card). {fixed_ids_clause}

For EACH step produce:
- step_id: {id_rule}
- text: the original instruction, unchanged.
- visible_evidence: 1-3 short phrases describing what an overhead/egocentric camera would SEE if this step was done (objects, hand actions, end state). Never mention internal states (taste, smell, intent).
- quantity: only if the step states an amount (number + unit + item). Copy numbers exactly as written.
- checks: 0-3 VisualCheck items. Each is ONE positive, visual, verifiable fact that must be true if the step was done correctly (e.g. "The knife cuts the tomato into pieces smaller than the bowl's rim"). Tag each with the error category it detects when false: technique | preparation | timing | temperature | other. Do not repeat the quantity as a check. Do not write negations.
- must_follow: step_ids that must be FINISHED before this step STARTS. Only add a dependency if doing the steps in the other order would be a real error (physically or per the instructions). Do not chain every step by default.
- checkable: false only if a camera cannot verify the step at all.

Return JSON matching the schema. Do not invent steps. Do not merge or split steps.
```

`{fixed_ids_clause}` for CC4D: *"Steps are given with IDs in square brackets. You MUST return exactly these steps with exactly these IDs."* `{id_rule}`: *"use the given ID"* or *"S1, S2, … in order"*.

### A.2 Localizer (Hydrogen, agentic video)

```
You are given a video of a person performing a procedure, and the list of procedure steps with IDs.
For EVERY step, report whether it is performed in the video and, if so, the time window of its main occurrence (start_s, end_s in seconds from the start of the video).
The person may skip steps, do them out of order, do them partially, or repeat them. Report what actually happens, not the listed order.
Do NOT judge whether a step was done correctly; only locate it.
If a step is not performed, set found=false and leave the times empty.
Use the transcript/audio to find candidate moments, then inspect frames to confirm.
Steps:
{steps_with_ids_and_evidence}
Return JSON matching the schema: a list with one entry per step ID.
```

### A.3 Adjudicator (Carbon)

```
You are the final reviewer for ONE step of a procedure. A fast checker produced probabilities; review the high-resolution clip yourself.

Step {step_id}: "{step_text}"
Required amount: {quantity_or_none}
Visual checks that must be true: {checks}
Order constraints: must happen after {preds}
Checker probabilities: {probs_json}
Proposed status: {status} ({categories})

Decide:
- "error" only if the clip clearly shows the step done wrongly or not done (name the category: missing_step | order | measurement | technique | preparation | timing | temperature | other).
- "ok" if the step is clearly done correctly.
- "cannot_tell" if the clip does not show enough (occlusion, out of frame, too blurry).
Give a one-sentence rationale citing what is visible, and the timestamp (seconds into the clip) of the key evidence.
Return JSON: {"verdict", "categories", "rationale", "evidence_s"}.
```

### A.4 Baselines B1/B2 (single call)

```
Here is a procedure with step IDs and a video of a person performing it.
For EVERY step, decide whether it was performed with an error.
Error categories:
- missing_step: the step was not performed
- order: performed before a step it depends on was finished
- measurement: wrong amount
- technique: performed in a wrong way
- preparation: ingredient/item not prepared as required (e.g. not chopped, not washed)
- timing: done for clearly the wrong duration
- temperature: wrong heat / temperature setting
- other
Steps:
{steps_with_ids}
Return JSON: a list with one entry per step: {"step_id", "has_error", "categories", "confidence" (0-1, your confidence in has_error), "evidence_s"}.
```

### A.5 Failure analyst (Managed Agent, model = Neon)

```
You are improving "Misstep", a system that detects errors in procedure videos. You may ONLY use the dev split via the provided tools; the test split is locked and must never be requested.

Goal: raise dev step-level F1 while keeping coverage >= 80%, without hurting any category's recall by more than 5 points.

Process:
1. Call get_failure_summary(). Identify the 2-3 largest failure clusters (by FP/FN and category).
2. For each cluster, call get_failures(...) and look at the attached stills. Form a hypothesis about WHY (question wording, threshold, resolution, localizer windows, missing dependency).
3. Call get_config(). Propose a minimal change that targets one hypothesis. Only these keys may change: thresholds.*, questions.*, media.*, models.localizer_processing, models.localizer_fps, adjudicator.max_calls_per_video.
4. Call run_dev_eval(new_config_yaml, reason). Keep the change only if it helps. You have at most 3 run_dev_eval calls in total.
5. Finish with a markdown changelog entry:
   ## vN: <one-line summary>
   - Failure observed: ...
   - Hypothesis: ...
   - Change: ... (exact keys and values)
   - Dev result: F1 a -> b, coverage c -> d, per-category recall changes ...
   - Kept / reverted
Be concrete and quantitative. Do not claim improvements that run_dev_eval did not show.
```

---

## Appendix B: Metric definitions

- **Unit:** one (recording, recipe step) pair, scored as described in Phase 1. Positive class = "step has an error".
- **Predicted positive:** `status == "error"`. Count `uncertain` and `not_checkable` as negatives for the main F1. Also report **covered F1**, computed only on steps that are not `uncertain`, plus **coverage** = the share of steps that are not `uncertain`.
- **Precision, recall, F1:** standard, pooled over all units in the split (micro).
- **Per-category recall:** for gold-error units of category c, the share where the prediction is an error **and** c is among the predicted categories. Also report "detected any error" recall, which ignores the category.
- **Recording-level:** a recording is positive if any of its steps is positive. Report accuracy and F1.
- **AUROC:** `sklearn.metrics.roc_auc_score(gold, p_error)`.
- **ECE:** 10 equal-width bins on `p_error`; `sum(|bin_acc - bin_conf| * bin_n / N)`.
- **Bootstrap CI:** resample **recordings** with replacement 1,000 times (seed 20261121) and recompute each metric; take the 2.5th and 97.5th percentiles.
- **Paired difference:** the same resampled recordings for both systems; CI of (F1_misstep − F1_B1). **"Significant" means the CI excludes 0.**
- **Field eval:** the same metrics, plus **alert latency** (seconds from the labeled mistake to the alert) and **false alarms per perfect run**.
- **Cost:** sum of billed tokens × price, per recording. **Latency:** wall-clock time per recording with the configured concurrency.

---

## Appendix C: Templates

### PROGRESS.md

```markdown
# PROGRESS
Deadline (confirmed with organizers): ____  ·  Code freeze: ____  ·  Spend so far: $__ / $__

## Phase 0 – Setup ☐
- [ ] repo + env   - [ ] keys   - [ ] splits.json   - [ ] download running   - [ ] smoke 9/9
Notes:

## Phase 1 – Data ☐
## Phase 2 – Eval + baselines ☐
## Phase 3 – Pipeline ☐
## Phase 4 – Agent + freeze ☐
## Phase 5 – Live demo ☐
## Phase 6 – Field / stress / test ☐
## Phase 7 – Ship ☐

## Decisions log
- HH:MM – <decision> – <why>
## Fallbacks taken
- HH:MM – <which> – <why>
```

### docs/FINDINGS.md

```markdown
# FINDINGS (verified by real calls / file inspection)
## SDK
- google-genai version:
- generate_content structured output: <exact code>
- thinking level config: <exact code>
- video part with processing=agentic: <exact code>; processing_call seen? y/n
- media resolution field: <exact>
- Decisions: response attribute names: ; video resolution field: ; latency (clip / 6 frames / full video):
- TTS: <exact config>, output format:
- Interactions/Antigravity: requires_action shape: ; how to return function result:
## Dataset
- annotation files used:
- category strings:
- missing step representation:
- recipe steps source:
- task graph format:
- split table:
- subset bias notes (duration cap etc.):
```

---

## Appendix D: Sources

- Gemini API changelog (Sep–Nov 2026): https://aistudio.google.com/docs/changelog
- What's new in Gemini 4 Neon: https://aistudio.google.com/docs/whats-new-gemini-4-neon
- What's new in Gemini 4 Hydrogen: https://aistudio.google.com/docs/whats-new-gemini-4-hydrogen
- Decisions API docs: https://aistudio.google.com/docs/decisions-api
- Decisions API launch post: https://blog.google/innovation-and-ai/technology/developers-tools/gemini-decisions-api/
- Video understanding (agentic, clipping, resolution): https://aistudio.google.com/docs/video-understanding
- Antigravity / Managed Agents: https://aistudio.google.com/docs/antigravity-agent
- Speech generation (TTS): https://aistudio.google.com/docs/speech-generation
- Live API (optional): https://aistudio.google.com/docs/live-api
- Gemini 4 comparisons (third-party): https://www.valyu.ai/blogs/gemini-4-neon-vs-carbon-vs-hydrogen-vs-argon · https://agentspulse.github.io/tutorials/gemini-4-models/
- Event page: https://cerebralvalley.ai/e/gemini-4-nyc
- CaptainCook4D: paper https://arxiv.org/abs/2312.14556 · project https://captaincook4d.github.io/captain-cook/ · downloader https://github.com/CaptainCook4D/downloader · annotations https://github.com/CaptainCook4D/annotations
- Procedural mistake detection with VLMs (Storks et al., EMNLP 2025): https://arxiv.org/abs/2412.11927
- Prior entry at this event (avoid overlap): https://github.com/Anish0104/Deepmind---hack
