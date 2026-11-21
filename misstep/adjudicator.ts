import fs from 'node:fs';
import type { Part } from '@google/genai';
import { generateJson } from './gemini.js';
import { ADJUDICATOR_PROMPT, fillTemplate } from './prompts.js';
import { applyCarbonDecision } from './rules.js';
import {
  ADJUDICATOR_GEMINI_SCHEMA,
  AdjudicatorVerdictSchema,
  type AdjudicatorVerdict,
  type Procedure,
  type StepCheck,
  type StepVerdict,
  type StepWindow,
} from './schemas.js';
import type { PipelineConfig } from './settings.js';
import { clip, getClipCachePath } from './video.js';

export async function adjudicate(
  procedure: Procedure,
  videoPath: string,
  windows: StepWindow[],
  checks: StepCheck[],
  verdicts: StepVerdict[],
  durationS: number,
  config: PipelineConfig,
  recordingId: string,
  pipelineErrors: string[],
): Promise<{ verdicts: StepVerdict[]; costUsd: number }> {
  if (!config.adjudicator.enabled || config.adjudicator.max_calls_per_video <= 0) {
    return { verdicts, costUsd: 0 };
  }

  const stepById = new Map(procedure.steps.map((s) => [s.step_id, s]));
  const windowById = new Map(windows.map((w) => [w.step_id, w]));
  const checkById = new Map(checks.map((c) => [c.step_id, c]));

  // Select error or uncertain steps, sorted by closeness to 0.5
  const candidates = verdicts
    .map((v, idx) => ({ v, idx, dist: Math.abs(v.p_error - 0.5) }))
    .filter(({ v }) => v.status === 'error' || v.status === 'uncertain')
    .sort((a, b) => a.dist - b.dist)
    .slice(0, config.adjudicator.max_calls_per_video);

  let totalCost = 0;
  const updated = [...verdicts];

  await Promise.all(
    candidates.map(async ({ v, idx }) => {
      const step = stepById.get(v.step_id);
      if (!step) return;
      const win = windowById.get(v.step_id);
      const chk = checkById.get(v.step_id);

      try {
        const startS = win?.found && win.start_s != null ? win.start_s : 0;
        const endS =
          win?.found && win.end_s != null
            ? Math.min(win.end_s, startS + config.media.clip_max_s)
            : Math.min(durationS, 60);

        const clipPath = await clip(
          videoPath,
          startS,
          endS,
          getClipCachePath(recordingId, `${step.step_id}_carbon`, startS, endS),
          config.media.clip_pad_s,
          durationS,
        );
        const clipBase64 = fs.readFileSync(clipPath).toString('base64');

        const prompt = fillTemplate(ADJUDICATOR_PROMPT, {
          step_id: step.step_id,
          step_text: step.text,
          quantity_or_none: step.quantity
            ? `${step.quantity.amount} ${step.quantity.unit} of ${step.quantity.item}`
            : 'None',
          checks:
            step.checks.length > 0
              ? step.checks.map((c) => `[${c.category}] ${c.text}`).join('; ')
              : 'None',
          preds: step.must_follow.length > 0 ? step.must_follow.join(', ') : 'None',
          probs_json: JSON.stringify(chk ?? {}),
          status: v.status,
          categories: v.categories.join(', ') || 'none',
        });

        const parts: Part[] = [
          {
            inlineData: {
              data: clipBase64,
              mimeType: 'video/mp4',
            },
          },
          { text: prompt },
        ];

        const res = await generateJson<AdjudicatorVerdict>({
          model: config.models.adjudicator,
          parts,
          schema: ADJUDICATOR_GEMINI_SCHEMA,
          thinkingLevel: config.models.adjudicator_thinking,
          mediaResolution: 'high',
        });
        totalCost += res.costUsd;

        const parsedCarbon = AdjudicatorVerdictSchema.parse(res.data);
        updated[idx] = applyCarbonDecision(
          v,
          parsedCarbon,
          config.adjudicator.can_veto_errors,
          config.adjudicator.can_create_errors_from_ok,
        );
      } catch (err) {
        pipelineErrors.push(
          `carbon error on ${v.step_id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),
  );

  return { verdicts: updated, costUsd: totalCost };
}
