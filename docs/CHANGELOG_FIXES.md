# Dev Improvement Changelog (Antigravity Failure Analyst)

This file records every dev-split improvement cycle run by `agent/failure_analyst.ts` (`antigravity-preview-09-2026`) prior to `configs/FROZEN`.

- Baseline config: `configs/pipeline_v1.yaml` (`v1`)
- Allowed agent keys: `thresholds.*`, `questions.*`, `media.*`, `models.localizer_processing`, `models.localizer_fps`, `adjudicator.max_calls_per_video`.
- Transcript: `runs/agent/2026-11-21T20-31-04-485Z/transcript.json` · Best frozen config: `configs/pipeline_final.yaml` (from `v4`, SHA-256 `f89b25acefd6bdb910017fa8af7adb11269227cbbe277e4e2a1f34d384f095cb`)

### Dev Failure Analysis (v1 Baseline)

Starting from `v1` (dev step-level **F1 = 0.5636**, precision = 0.6078, recall = 0.5254, coverage = 0.9381, 48 total failures), the 3 largest failure clusters were:
1. **`FN:technique` (12 failures)** — included unlocalized steps (`10_48:111`, `10_48:107`) with `p_done_full` in `(0.25, 0.35)` silently classified as `ok`, and borderline `uncertain` check failures (`26_29:294`, `1 - check_p_true = 0.6460`) just below `check_false_min = 0.65`.
2. **`FN:order` (9 failures)** — also included `10_48:111` and `10_48:107` in the `(0.25, 0.35)` `p_done_full` gap, plus localized steps whose order errors were not flagged.
3. **`FP:measurement` (9 failures)** — tiny/occluded measurements (e.g. `5_35:68` 12 oz water viewed top-down under the faucet, `3_5:35` 1/16 tsp baking soda, `3_5:28` 1/8 tsp salt) and borderline cases where `correct` was the top option (`0.405–0.514`) but `p(less) + p(more)` exceeded `0.35` or `0.60`.

---

## v2: Close `missing_p_done_max` threshold dead zone
- **Failure observed:** Three unlocalized gold errors (`21_28:221` in `FN:missing_step` with `p_done_full=0.3341`, `10_48:111` in `FN:technique`/`FN:order` with `p_done_full=0.3446`, and `10_48:107` in `FN:technique`/`FN:order` with `p_done_full=0.3245`) had `p_done_clip=null` and `p_error` in `(0.655, 0.676)`, yet were predicted `ok`.
- **Hypothesis:** There was a threshold gap between `missing_p_done_max: 0.25` and `1 - uncertain_band[1] = 0.35`. Unlocalized steps with `0.25 < p_done_full < 0.35` had `p_error` too high for `uncertain_band: [0.35, 0.65]` but `p_done_full` too high to trigger `missing_step`, causing them to fall through to `ok`.
- **Change:** `thresholds.missing_p_done_max`: `0.25` -> `0.35`
- **Dev result:**
  - F1: `0.5636 -> 0.5965` (`+0.0329`; precision `0.6078 -> 0.6182`, recall `0.5254 -> 0.5763`, covered F1 `0.5905 -> 0.6239`)
  - Coverage: `0.9381 -> 0.9381` (`>= 80%`)
  - Per-category recall (`category_recall` / `detected_any_error_recall`):
    - `missing_step`: `0.5000 -> 0.6000` (`+10.0 pts`) / `0.6000 -> 0.7000` (`+10.0 pts`)
    - `order`: `0.0714 -> 0.0714` (`0.0 pts`) / `0.3571 -> 0.5000` (`+14.3 pts`)
    - `technique`: `0.2778 -> 0.2778` (`0.0 pts`) / `0.3333 -> 0.4444` (`+11.1 pts`)
    - `measurement` (`0.5455` / `0.7273`), `preparation` (`0.1429` / `0.8571`), `timing` (`0.6667` / `0.8333`), `temperature` (`0.0000` / `0.0000`): all unchanged (`0.0 pts`).
- **Kept**

---

## v3: Calibrate measurement prompt/options to reduce `FP:measurement`
- **Failure observed:** 9 `FP:measurement` failures, including top-down/occluded views (`5_35:68` 12 oz water) and tiny spoons (`3_5:35`, `3_5:28`) where `cannot_tell` received low mass (`0.06–0.22`) and `p(less) + p(more)` crossed `0.35` or `0.60`.
- **Hypothesis:** Tightening `questions.measurement` and `questions.measurement_options` to reserve `less`/`more` for unmistakable discrepancies and encourage `cannot_tell` when markings/spoon size are obscured would cut `FP:measurement` without losing true measurement errors.
- **Change (on top of `v2`):**
  - `questions.measurement`: added guidance that minor cooking approximation counts as about right, `less`/`more` is only for clear, unmistakable mistakes, and `cannot_tell` should be chosen when spoon size or markings are not clearly visible.
  - `questions.measurement_options`: updated `less` (`Substantially and unmistakably less than {amount} {unit}`), `correct` (`About {amount} {unit} (including minor normal cooking variation)`), `more` (`Substantially and unmistakably more than {amount} {unit}`), and `cannot_tell` (`The exact amount cannot be clearly seen or determined from this clip`).
- **Dev result (vs `v2`):**
  - F1: `0.5965 -> 0.5893` (`-0.0072`; precision `0.6182 -> 0.6226`, recall `0.5763 -> 0.5593`, covered F1 `0.6239 -> 0.6168`)
  - Coverage: `0.9381 -> 0.9524`
  - Per-category recall (`category_recall` / `detected_any_error_recall`):
    - `measurement`: `0.5455 -> 0.3636` (`-18.2 pts`) / `0.7273 -> 0.5455` (`-18.2 pts`) — violated the `<= 5 pt` recall drop constraint.
    - `technique`: `0.2778 -> 0.3333` (`+5.6 pts`) / `0.4444 -> 0.5000` (`+5.6 pts`)
    - `preparation`: `0.1429 -> 0.1429` (`0.0 pts`) / `0.8571 -> 1.0000` (`+14.3 pts`)
    - `missing_step`, `order`, `timing`, `temperature`: unchanged.
- **Reverted** (dropped F1 and hurt `measurement` recall by 18.2 points).

---

## v4: Lower `check_false_min` to recover borderline `uncertain` FNs
- **Failure observed:** Borderline gold errors left in `uncertain` just below `check_false_min: 0.65`, specifically `26_29:294` (`FN:technique`/`FN:preparation`, `1 - check_p_true = 0.6460`) and `5_35:61` (`FN:missing_step`, `1 - check_p_true = 0.6341`).
- **Hypothesis:** Lowering `thresholds.check_false_min` from `0.65` to `0.63` (on top of `v2`, reverting `v3`) recovers these borderline check failures directly into `error`, raising recall, F1, and coverage with zero risk of reducing any category's recall.
- **Change (on top of `v2`, reverting `v3`):**
  - `thresholds.missing_p_done_max`: `0.35` (kept from `v2`)
  - `thresholds.check_false_min`: `0.65` -> `0.63`
  - `questions.measurement` & `questions.measurement_options`: reverted to `v1`/`v2` values
- **Dev result (vs `v2` / vs `v1` baseline):**
  - F1: `0.5965 -> 0.6154` (`+0.0189` vs `v2`; **`+0.0518` vs `v1`** `0.5636 -> 0.6154`)
  - Precision: `0.6182 -> 0.6207` (`+0.0129` vs `v1`), Recall: `0.5763 -> 0.6102` (`+0.0848` vs `v1`), Covered F1: `0.6239 -> 0.6316`
  - Coverage: `0.9381 -> 0.9524` (`+0.0143` vs `v1`, well above `>= 80%`)
  - Per-category recall (`v1 -> v4`, `category_recall` / `detected_any_error_recall`):
    - `missing_step` (n=10): `0.5000 -> 0.6000` (`+10.0 pts`) / `0.6000 -> 0.8000` (`+20.0 pts`)
    - `order` (n=14): `0.0714 -> 0.0714` (`0.0 pts`) / `0.3571 -> 0.5000` (`+14.3 pts`)
    - `measurement` (n=11): `0.5455 -> 0.5455` (`0.0 pts`) / `0.7273 -> 0.7273` (`0.0 pts`)
    - `technique` (n=18): `0.2778 -> 0.3333` (`+5.6 pts`) / `0.3333 -> 0.5000` (`+16.7 pts`)
    - `preparation` (n=7): `0.1429 -> 0.1429` (`0.0 pts`) / `0.8571 -> 1.0000` (`+14.3 pts`)
    - `timing` (n=6): `0.6667 -> 0.6667` (`0.0 pts`) / `0.8333 -> 0.8333` (`0.0 pts`)
    - `temperature` (n=2, low_n): `0.0000 -> 0.0000` (`0.0 pts`) / `0.0000 -> 0.0000` (`0.0 pts`)
    - **No category's recall decreased.**
- **Kept** (final best config: `v4`).
