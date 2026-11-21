import crypto from 'node:crypto';
import type { Part } from '@google/genai';
import { generateJson, uploadFile } from '../misstep/gemini.js';
import { BASELINE_PROMPT, fillTemplate } from '../misstep/prompts.js';
import {
  BASELINE_GEMINI_SCHEMA,
  BaselineStepPredictionSchema,
  RunResultSchema,
  type BaselineStepPrediction,
  type GoldRecording,
  type Procedure,
  type RunResult,
  type StepVerdict,
} from '../misstep/schemas.js';

export function runB0Baseline(
  gold: GoldRecording,
  procedure: Procedure,
  devBaseRate: number,
  configVersion = 'v1',
): RunResult {
  const verdicts: StepVerdict[] = procedure.steps.map((s) => ({
    step_id: s.step_id,
    status: 'ok',
    categories: [],
    p_error: Number(devBaseRate.toFixed(4)),
    decided_by: 'rules',
    evidence: [{ t_s: null, text: 'B0 always-ok baseline' }],
  }));

  return RunResultSchema.parse({
    run_id: `run_b0_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`,
    system: 'B0',
    config_version: configVersion,
    recording_id: gold.recording_id,
    procedure_id: procedure.procedure_id,
    windows: [],
    checks: [],
    verdicts,
    cost_usd: 0,
    latency_s: 0.001,
    errors: [],
  });
}

export async function runSingleCallBaseline(
  system: 'B1' | 'B2',
  gold: GoldRecording,
  procedure: Procedure,
  videoPath: string,
  configVersion = 'v1',
): Promise<RunResult> {
  const t0 = Date.now();
  const model = system === 'B1' ? 'gemini-4-hydrogen' : 'gemini-4-neon';
  const videoUri = await uploadFile(videoPath, 'video/mp4');

  const stepsWithIds = procedure.steps.map((s) => `- [${s.step_id}] ${s.text}`).join('\n');
  const prompt = fillTemplate(BASELINE_PROMPT, { steps_with_ids: stepsWithIds });

  const parts: Part[] = [
    {
      fileData: {
        fileUri: videoUri,
        mimeType: 'video/mp4',
      },
    },
    { text: prompt },
  ];

  const res = await generateJson<BaselineStepPrediction[]>({
    model,
    parts,
    schema: BASELINE_GEMINI_SCHEMA,
    thinkingLevel: 'high',
    mediaResolution: 'low',
  });

  const predByStep = new Map<string, BaselineStepPrediction>();
  for (const raw of res.data ?? []) {
    const parsed = BaselineStepPredictionSchema.parse(raw);
    predByStep.set(parsed.step_id, parsed);
  }

  const verdicts: StepVerdict[] = procedure.steps.map((s) => {
    const p = predByStep.get(s.step_id);
    if (!p) {
      return {
        step_id: s.step_id,
        status: 'ok',
        categories: [],
        p_error: 0.1,
        decided_by: 'rules',
        evidence: [{ t_s: null, text: `${system} omitted step; defaulted to ok` }],
      };
    }
    const pErr = p.has_error ? p.confidence : 1 - p.confidence;
    return {
      step_id: s.step_id,
      status: p.has_error ? 'error' : 'ok',
      categories: p.has_error ? p.categories : [],
      p_error: Number(Math.max(0, Math.min(1, pErr)).toFixed(4)),
      decided_by: 'rules',
      evidence: [
        {
          t_s: p.evidence_s ?? null,
          text: `${system} single-call (${model}, confidence=${p.confidence.toFixed(2)})`,
        },
      ],
    };
  });

  return RunResultSchema.parse({
    run_id: `run_${system.toLowerCase()}_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`,
    system: system === 'B1' ? 'B1_hydrogen' : 'B2_neon',
    config_version: configVersion,
    recording_id: gold.recording_id,
    procedure_id: procedure.procedure_id,
    windows: [],
    checks: [],
    verdicts,
    cost_usd: Number(res.costUsd.toFixed(6)),
    latency_s: Number(((Date.now() - t0) / 1000).toFixed(3)),
    errors: [],
  });
}
