import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { adjudicate } from './adjudicator.js';
import { checkSteps } from './checker.js';
import { compileProcedure } from './compiler.js';
import { uploadFile } from './gemini.js';
import { localize } from './localizer.js';
import { evaluateSteps } from './rules.js';
import {
  ProcedureSchema,
  RunResultSchema,
  type Procedure,
  type RunResult,
  type StepWindow,
} from './schemas.js';
import { loadConfig } from './settings.js';
import { probe } from './video.js';

export interface PipelineOptions {
  system?: string;
  configPath?: string;
  recordingId?: string;
  noCarbon?: boolean;
  noLocalizer?: boolean;
  decisionsOnlyFull?: boolean;
  source?: 'cc4d' | 'medprep' | 'upload';
  procedureId?: string;
}

export interface PipelineOutput {
  result: RunResult;
  procedure: Procedure;
  questionTexts: Record<string, Record<string, string>>;
}

export async function runPipeline(
  procedureOrPathOrText: Procedure | string,
  videoPath: string,
  options: PipelineOptions = {},
): Promise<PipelineOutput> {
  const startedMs = Date.now();
  const config = loadConfig(options.configPath);
  const errors: string[] = [];
  let totalCost = 0;

  // 1. Load or compile procedure
  let procedure: Procedure;
  if (typeof procedureOrPathOrText !== 'string') {
    procedure = ProcedureSchema.parse(procedureOrPathOrText);
  } else if (
    procedureOrPathOrText.endsWith('.json') &&
    fs.existsSync(path.resolve(procedureOrPathOrText))
  ) {
    procedure = ProcedureSchema.parse(
      JSON.parse(fs.readFileSync(path.resolve(procedureOrPathOrText), 'utf-8')),
    );
  } else {
    const procId =
      options.procedureId ||
      `proc_${crypto.createHash('sha256').update(procedureOrPathOrText).digest('hex').slice(0, 10)}`;
    const isFile = fs.existsSync(path.resolve(procedureOrPathOrText));
    const compiled = await compileProcedure(
      isFile ? { filePath: procedureOrPathOrText } : { text: procedureOrPathOrText },
      options.source ?? 'upload',
      procId,
      undefined,
      options.configPath,
    );
    procedure = compiled.procedure;
    totalCost += compiled.costUsd;
  }

  const recordingId =
    options.recordingId ||
    path.basename(videoPath, path.extname(videoPath)) ||
    `rec_${Date.now()}`;

  // 2. Probe video duration
  const videoInfo = await probe(videoPath);
  const durationS = videoInfo.duration_s;

  // 3. Upload video via Files API
  const videoUri = await uploadFile(videoPath, 'video/mp4');

  // 4. Localize step windows (unless --no-localizer or --decisions-only-full)
  let windows: StepWindow[] = [];
  if (!options.noLocalizer && !options.decisionsOnlyFull) {
    const loc = await localize(videoUri, procedure, durationS, config);
    windows = loc.windows;
    totalCost += loc.costUsd;
    errors.push(...loc.notes);
  } else {
    windows = procedure.steps.map((s) => ({
      step_id: s.step_id,
      found: false,
      start_s: null,
      end_s: null,
      note: 'skipped by --no-localizer',
    }));
  }

  // 5. Decisions checks (full video + per-step clips)
  const checkOut = await checkSteps(
    videoUri,
    videoPath,
    procedure,
    windows,
    recordingId,
    durationS,
    config,
    {
      noLocalizer: options.noLocalizer,
      decisionsOnlyFull: options.decisionsOnlyFull,
    },
  );
  totalCost += checkOut.costUsd;

  // 6. Deterministic rules
  let verdicts = evaluateSteps(procedure, windows, checkOut.checks, config);

  // 7. Carbon adjudication (unless --no-carbon)
  if (!options.noCarbon) {
    const adj = await adjudicate(
      procedure,
      videoPath,
      windows,
      checkOut.checks,
      verdicts,
      durationS,
      config,
      recordingId,
      errors,
    );
    verdicts = adj.verdicts;
    totalCost += adj.costUsd;
  }

  const latencyS = Number(((Date.now() - startedMs) / 1000).toFixed(3));
  const systemName =
    options.system ||
    (options.decisionsOnlyFull
      ? 'misstep-decisions-only-full'
      : options.noLocalizer
        ? 'misstep-no-localizer'
        : options.noCarbon
          ? 'misstep-no-carbon'
          : 'misstep');

  const result = RunResultSchema.parse({
    run_id: `run_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    system: systemName,
    config_version: config.version,
    recording_id: recordingId,
    procedure_id: procedure.procedure_id,
    windows,
    checks: checkOut.checks,
    verdicts,
    cost_usd: Number(totalCost.toFixed(6)),
    latency_s: latencyS,
    errors,
  });

  return {
    result,
    procedure,
    questionTexts: checkOut.questionTexts,
  };
}
