import fs from 'node:fs';
import {
  decide,
  uploadFile,
  type DecisionAnswerChoice,
  type DecisionAnswerNoul,
  type DecisionInputBlock,
  type DecisionQuestion,
} from './gemini.js';
import { fillTemplate } from './prompts.js';
import {
  StepCheckSchema,
  type Procedure,
  type Step,
  type StepCheck,
  type StepWindow,
} from './schemas.js';
import type { PipelineConfig } from './settings.js';
import { clip, getClipCachePath } from './video.js';

export function sanitizeQuestionKey(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '_');
  return cleaned.slice(0, 64) || 'q';
}

export interface CheckOptions {
  noLocalizer?: boolean;
  decisionsOnlyFull?: boolean;
}

export interface CheckOutput {
  checks: StepCheck[];
  costUsd: number;
  questionTexts: Record<string, Record<string, string>>;
  errors: string[];
}

function splitWindow(startS: number, endS: number, maxS: number): Array<[number, number]> {
  if (endS - startS <= maxS) {
    return [[startS, endS]];
  }
  const chunks: Array<[number, number]> = [];
  let cur = startS;
  while (cur < endS) {
    const next = Math.min(endS, cur + maxS);
    if (next - cur >= 1.0 || chunks.length === 0) {
      chunks.push([cur, next]);
    }
    cur = next;
  }
  return chunks;
}

export async function checkSteps(
  videoUri: string,
  videoPath: string,
  procedure: Procedure,
  windows: StepWindow[],
  recordingId: string,
  durationS: number,
  config: PipelineConfig,
  options: CheckOptions = {},
): Promise<CheckOutput> {
  let totalCost = 0;
  const errors: string[] = [];
  const questionTexts: Record<string, Record<string, string>> = {};
  const windowByStep = new Map(windows.map((w) => [w.step_id, w]));

  // 1. FULL-VIDEO CALL: done_full for every checkable step in ONE request
  const fullQuestions: Record<string, DecisionQuestion> = {};
  const fullKeyToStep = new Map<string, string>();
  const measKeyToStep = new Map<string, string>();

  for (const step of procedure.steps) {
    if (!step.checkable) continue;
    const key = sanitizeQuestionKey(`S${step.step_id}_done_full`);
    const qText = fillTemplate(config.questions.done_full, {
      step_text: step.text,
      evidence: step.visible_evidence.join('; ') || step.text,
    });
    fullQuestions[key] = {
      type: 'noul',
      instructions: qText,
    };
    fullKeyToStep.set(key, step.step_id);
    questionTexts[step.step_id] = { ...(questionTexts[step.step_id] ?? {}), done_full: qText };

    // If --no-localizer (and not --decisions-only-full), also run measurement & checks on full video
    if (options.noLocalizer && !options.decisionsOnlyFull) {
      if (step.quantity) {
        const mKey = sanitizeQuestionKey(`S${step.step_id}_meas`);
        const mText = fillTemplate(config.questions.measurement, {
          amount: step.quantity.amount,
          unit: step.quantity.unit,
          item: step.quantity.item,
        });
        fullQuestions[mKey] = {
          type: 'choice',
          instructions: mText,
          criteria: {
            less: fillTemplate(config.questions.measurement_options.less, {
              amount: step.quantity.amount,
              unit: step.quantity.unit,
            }),
            correct: fillTemplate(config.questions.measurement_options.correct, {
              amount: step.quantity.amount,
              unit: step.quantity.unit,
            }),
            more: fillTemplate(config.questions.measurement_options.more, {
              amount: step.quantity.amount,
              unit: step.quantity.unit,
            }),
            cannot_tell: config.questions.measurement_options.cannot_tell,
          },
        };
        measKeyToStep.set(mKey, step.step_id);
        questionTexts[step.step_id].measurement = mText;
      }
      for (const chk of step.checks) {
        const cKey = sanitizeQuestionKey(`S${step.step_id}_${chk.check_id}`);
        const cText = fillTemplate(config.questions.check, { check_text: chk.text });
        fullQuestions[cKey] = { type: 'noul', instructions: cText };
        questionTexts[step.step_id][chk.check_id] = cText;
      }
    }
  }

  const pDoneFullByStep = new Map<string, number>();
  const fullCheckResults = new Map<string, Record<string, number>>();
  const fullMeasResults = new Map<string, Record<string, number>>();

  if (Object.keys(fullQuestions).length > 0) {
    const fullBlocks: DecisionInputBlock[] = [
      {
        type: 'video',
        uri: videoUri,
        mime_type: 'video/mp4',
        resolution: config.media.full_video_resolution,
      },
    ];
    try {
      const fullRes = await decide(fullBlocks, fullQuestions);
      totalCost += fullRes.costUsd;

      for (const [k, ans] of Object.entries(fullRes.answers)) {
        const stepId = fullKeyToStep.get(k);
        if (stepId && ans.type === 'noul') {
          pDoneFullByStep.set(stepId, (ans as DecisionAnswerNoul).noul);
        }
        const mStepId = measKeyToStep.get(k);
        if (mStepId && ans.type === 'choice') {
          fullMeasResults.set(mStepId, (ans as DecisionAnswerChoice).probabilities);
        }
      }
      if (options.noLocalizer && !options.decisionsOnlyFull) {
        for (const step of procedure.steps) {
          const map: Record<string, number> = {};
          for (const chk of step.checks) {
            const cKey = sanitizeQuestionKey(`S${step.step_id}_${chk.check_id}`);
            const ans = fullRes.answers[cKey];
            if (ans && ans.type === 'noul') {
              map[chk.check_id] = ans.noul;
            }
          }
          fullCheckResults.set(step.step_id, map);
        }
      }
    } catch (err) {
      errors.push(`decisions full-video error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 2. PER-STEP CLIP CALLS (concurrently) when localizer is active
  const clipResultsByStep = new Map<
    string,
    {
      p_done_clip: number | null;
      measurement_probs: Record<string, number> | null;
      check_p_true: Record<string, number>;
    }
  >();

  if (!options.noLocalizer && !options.decisionsOnlyFull) {
    const stepsToCheck = procedure.steps.filter((s) => {
      if (!s.checkable) return false;
      const w = windowByStep.get(s.step_id);
      return Boolean(w?.found && w.start_s != null && w.end_s != null);
    });

    await Promise.all(
      stepsToCheck.map(async (step: Step) => {
        const w = windowByStep.get(step.step_id)!;
        const chunks = splitWindow(w.start_s!, w.end_s!, config.media.clip_max_s);
        let bestDoneClip: number | null = null;
        let bestMeas: Record<string, number> | null = null;
        const bestCheckPTrue: Record<string, number> = {};

        for (const [cStart, cEnd] of chunks) {
          const clipOut = getClipCachePath(recordingId, step.step_id, cStart, cEnd);
          const clippedPath = await clip(
            videoPath,
            cStart,
            cEnd,
            clipOut,
            config.media.clip_pad_s,
            durationS,
          );
          const clipSize = fs.statSync(clippedPath).size;
          const clipVideoBlock: DecisionInputBlock =
            clipSize > 10 * 1024 * 1024
              ? {
                  type: 'video',
                  uri: await uploadFile(clippedPath, 'video/mp4'),
                  mime_type: 'video/mp4',
                  resolution: config.media.clip_resolution,
                }
              : {
                  type: 'video',
                  data: fs.readFileSync(clippedPath).toString('base64'),
                  mime_type: 'video/mp4',
                  resolution: config.media.clip_resolution,
                };

          const clipQuestions: Record<string, DecisionQuestion> = {};
          const doneKey = sanitizeQuestionKey(`S${step.step_id}_done`);
          const doneText = fillTemplate(config.questions.done_clip, {
            step_text: step.text,
          });
          clipQuestions[doneKey] = { type: 'noul', instructions: doneText };
          questionTexts[step.step_id].done_clip = doneText;

          for (const chk of step.checks) {
            const cKey = sanitizeQuestionKey(`S${step.step_id}_${chk.check_id}`);
            const cText = fillTemplate(config.questions.check, { check_text: chk.text });
            clipQuestions[cKey] = { type: 'noul', instructions: cText };
            questionTexts[step.step_id][chk.check_id] = cText;
          }

          try {
            const clipRes = await decide([clipVideoBlock], clipQuestions);
            totalCost += clipRes.costUsd;

            const doneAns = clipRes.answers[doneKey];
            if (doneAns && doneAns.type === 'noul') {
              bestDoneClip =
                bestDoneClip === null ? doneAns.noul : Math.max(bestDoneClip, doneAns.noul);
            }

            for (const chk of step.checks) {
              const cKey = sanitizeQuestionKey(`S${step.step_id}_${chk.check_id}`);
              const ans = clipRes.answers[cKey];
              if (ans && ans.type === 'noul') {
                const prev = bestCheckPTrue[chk.check_id];
                bestCheckPTrue[chk.check_id] = prev === undefined ? ans.noul : Math.max(prev, ans.noul);
              }
            }
          } catch (err) {
            errors.push(
              `decisions clip error on ${step.step_id}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }

          // Measurement question at measurement_resolution if quantity is set
          if (step.quantity) {
            const mKey = sanitizeQuestionKey(`S${step.step_id}_meas`);
            const mText = fillTemplate(config.questions.measurement, {
              amount: step.quantity.amount,
              unit: step.quantity.unit,
              item: step.quantity.item,
            });
            questionTexts[step.step_id].measurement = mText;

            const measVideoBlock: DecisionInputBlock = {
              ...clipVideoBlock,
              resolution: config.media.measurement_resolution,
            };

            try {
              const measRes = await decide(
                [measVideoBlock],
                {
                  [mKey]: {
                    type: 'choice',
                    instructions: mText,
                    criteria: {
                      less: fillTemplate(config.questions.measurement_options.less, {
                        amount: step.quantity.amount,
                        unit: step.quantity.unit,
                      }),
                      correct: fillTemplate(config.questions.measurement_options.correct, {
                        amount: step.quantity.amount,
                        unit: step.quantity.unit,
                      }),
                      more: fillTemplate(config.questions.measurement_options.more, {
                        amount: step.quantity.amount,
                        unit: step.quantity.unit,
                      }),
                      cannot_tell: config.questions.measurement_options.cannot_tell,
                    },
                  },
                },
              );
              totalCost += measRes.costUsd;
              const mAns = measRes.answers[mKey];
              if (mAns && mAns.type === 'choice') {
                if (!bestMeas) {
                  bestMeas = mAns.probabilities;
                } else {
                  const prevErr = (bestMeas.less ?? 0) + (bestMeas.more ?? 0);
                  const nextErr = (mAns.probabilities.less ?? 0) + (mAns.probabilities.more ?? 0);
                  if (nextErr > prevErr) bestMeas = mAns.probabilities;
                }
              }
            } catch (err) {
              errors.push(
                `decisions measurement error on ${step.step_id}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }

        clipResultsByStep.set(step.step_id, {
          p_done_clip: bestDoneClip,
          measurement_probs: bestMeas,
          check_p_true: bestCheckPTrue,
        });
      }),
    );
  }

  const checks: StepCheck[] = procedure.steps.map((step) => {
    const clipData = clipResultsByStep.get(step.step_id);
    return StepCheckSchema.parse({
      step_id: step.step_id,
      p_done_full: pDoneFullByStep.get(step.step_id) ?? 0.5,
      p_done_clip: clipData?.p_done_clip ?? null,
      measurement_probs: clipData?.measurement_probs ?? fullMeasResults.get(step.step_id) ?? null,
      check_p_true: clipData?.check_p_true ?? fullCheckResults.get(step.step_id) ?? {},
    });
  });

  return { checks, costUsd: totalCost, questionTexts, errors };
}
