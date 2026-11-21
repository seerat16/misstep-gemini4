export const COMPILER_PROMPT = `You convert a written procedure into a machine-checkable step graph for a camera-based checker.

Input: a procedure (text, PDF, or photo of a card). {fixed_ids_clause}

For EACH step produce:
- step_id: {id_rule}
- text: the original instruction, unchanged.
- visible_evidence: 1-3 short phrases describing what an overhead/egocentric camera would SEE if this step was done (objects, hand actions, end state). Never mention internal states (taste, smell, intent).
- quantity: only if the step states an amount (number + unit + item). Copy numbers exactly as written.
- checks: 0-3 VisualCheck items. Each is ONE positive, visual, verifiable fact that must be true if the step was done correctly (e.g. "The knife cuts the tomato into pieces smaller than the bowl's rim"). Tag each with the error category it detects when false: technique | preparation | timing | temperature | other. Do not repeat the quantity as a check. Do not write negations.
- must_follow: step_ids that must be FINISHED before this step STARTS. Only add a dependency if doing the steps in the other order would be a real error (physically or per the instructions). Do not chain every step by default.
- checkable: false only if a camera cannot verify the step at all.

Return JSON matching the schema. Do not invent steps. Do not merge or split steps.`;

export const LOCALIZER_PROMPT = `You are given a video of a person performing a procedure, and the list of procedure steps with IDs.
For EVERY step, report whether it is performed in the video and, if so, the time window of its main occurrence (start_s, end_s in seconds from the start of the video).
The person may skip steps, do them out of order, do them partially, or repeat them. Report what actually happens, not the listed order.
Do NOT judge whether a step was done correctly; only locate it.
When found=true, ALWAYS provide both start_s and end_s (use at least a 5-second window covering the action).
If a step is not performed, set found=false and set start_s=null and end_s=null.
Use the transcript/audio to find candidate moments, then inspect frames to confirm.
Steps:
{steps_with_ids_and_evidence}
Return JSON matching the schema: a list with one entry per step ID.`;

export const ADJUDICATOR_PROMPT = `You are the final reviewer for ONE step of a procedure. A fast checker produced probabilities; review the high-resolution clip yourself.

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
Return JSON: {"verdict", "categories", "rationale", "evidence_s"}.`;

export const BASELINE_PROMPT = `Here is a procedure with step IDs and a video of a person performing it.
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
Return JSON: a list with one entry per step: {"step_id", "has_error", "categories", "confidence" (0-1, your confidence in has_error), "evidence_s"}.`;

export const FAILURE_ANALYST_PROMPT = `You are improving "Misstep", a system that detects errors in procedure videos. You may ONLY use the dev split via the provided tools; the test split is locked and must never be requested.

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
Be concrete and quantitative. Do not claim improvements that run_dev_eval did not show.`;

export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match,
  );
}
