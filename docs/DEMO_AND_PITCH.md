# Misstep — 1-Minute Demo Script, Judge Q&A & Submission Blurb

## 1-Minute Demo Video / Live Table Script

**Pre-setup:** Tab 1 open on `http://localhost:3000/static/live.html` with overhead camera aimed at the MedPrep kit (`demo/medprep_card.md`), speaker unmuted. Tab 2 open on `http://localhost:3000/static/report.html`.

- **0:00 – 0:10 | Hook (Tab 1: `live.html`, click Load MedPrep Demo → Start Live Monitor)**
  - **Say:** *"Procedures fail one skipped step at a time—medication prep, lab protocols, maintenance. Today's AI can describe a video, but it can't tell you which step went wrong with calibrated confidence. That's Misstep."*
- **0:10 – 0:35 | Live Mistake + Spoken Alert + Final Verification (Tab 1)**
  - **Action:** Skip Step 1 (hand sanitizer) and open the MON–THU lids (Step 3), then put 3 BLUE tablets in TUE (AM). Point to the Step Board turning red (`SKIPPED`), the tick latency/cost readouts, and the spoken TTS alert (*"Wait. You skipped step 1..."*). Hold the open organizer under the camera and click **Finish & Verify Organizer**.
  - **Say:** *"Every 2 seconds, Gemini Decision 1 checks the 6-frame ring buffer against a step graph compiled by Gemini 4 Neon. When a prerequisite is skipped, Gemini 3.8 Flash TTS speaks an alert immediately. At Finish, Gemini 4 Carbon verifies any mismatched compartment counts at ultra-high resolution."*
- **0:35 – 0:50 | Proof on Held-Out Recipes & Field Eval (Tab 2: `report.html`)**
  - **Action:** Scroll through headline F1 vs. single-call Hydrogen (B1) and Neon (B2), the reliability (calibration) plot, field eval metrics, and the stress ladder breaking points.
  - **Say:** *"We evaluated Misstep on 40 held-out CaptainCook4D recipes, plus a blind field eval with strangers at the venue and a stress ladder. Decomposing the task into Neon, Hydrogen, Decision 1, and Carbon beats single-call baselines with calibrated probabilities."*
- **0:50 – 1:00 | Managed Agent Loop & Close (Tab 2: `v1 → v2 → v3` chart / `CHANGELOG_FIXES.md`)**
  - **Say:** *"An Antigravity Managed Agent analyzed our dev-set failures with multimodal stills and tuned our thresholds before we froze the config for test. Built end-to-end today—we'd love your questions."*

---

## Judge Q&A Cheat Sheet

- **Why not one model call?**
  - Measured: we compare directly against single-call Hydrogen (`B1`) and single-call Neon (`B2`) on the exact same step list and category definitions. `gemini-decision-1` also outputs calibrated per-question probabilities (`noul`, `choice`, `score`), so Misstep can mark a step `uncertain` instead of guessing.
- **Did you overfit?**
  - No. Test recipes in CaptainCook4D are completely disjoint from dev recipes (`data/splits.json`, seed `20261121`). The final config is locked by SHA-256 hash (`configs/FROZEN`) enforced in `eval/run_eval.ts` before the single `--final` test run, and the field eval uses strangers with sealed blind mistake slips.
- **Where does it fail?**
  - Small amounts at 360p resolution, counting 5+ tablets, and heavy hand occlusion—documented honestly in our stress ladder (`eval/stress.ts`) and known failures section.
- **Why Carbon only on some steps?**
  - Carbon is slower and more expensive, so it only reviews `error` and `uncertain` candidates at high resolution (capped per video). Crucially, `can_create_errors_from_ok: false`—it can veto false alarms or resolve uncertainty, never invent new errors.
- **Privacy?**
  - The overhead camera sees only hands, the procedure card, and the work surface—never faces. Live mode sends 640px JPEG frames, and field-run frames can be deleted immediately after the event.
- **What's the cost?**
  - `gemini-decision-1` is $0.10 per 1M input tokens ($0 output) with shared video/frame input billed once per multi-question request. Full per-recording mean cost and latency are reported in `docs/EVAL_RESULTS.md`.

---

## Best Use of Managed Agents Submission Blurb

> **Misstep — Antigravity Dev-Set Failure Analyst (`antigravity-preview-09-2026`)**
>
> Instead of hand-tweaking prompts and thresholds in the dark, Misstep uses an **Antigravity Managed Agent** (`agent/failure_analyst.ts`) powered by `gemini-4-neon` via the `v1beta` Interactions API (`environment: "remote"`). We attach up to 8 midpoint JPEG stills from the worst dev-set failures and give the agent 4 local custom function tools (`get_failure_summary`, `get_failures`, `get_config`, and `run_dev_eval`, handled on `status: "requires_action"`).
>
> The agent groups false positives and false negatives by error category, inspects the visual evidence, forms a targeted hypothesis, and calls `run_dev_eval` (strictly capped at 3 dev-only runs and constrained to an allowlist of `thresholds.*`, `questions.*`, `media.*`, `models.localizer_*`, and `adjudicator.max_calls_per_video`). Every iteration (`v1 → v2 → v3`) and its dev F1 / coverage delta is logged to `docs/CHANGELOG_FIXES.md` before a human freezes `configs/FROZEN` for the one-time test run.
