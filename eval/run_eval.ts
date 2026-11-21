import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadRecipes, procedureFromRecipe, readGoldJsonl } from '../datasets/cc4d.js';
import { readSplits } from '../datasets/splits.js';
import { compileProcedure } from '../misstep/compiler.js';
import { runPipeline } from '../misstep/pipeline.js';
import {
  ProcedureSchema,
  type ErrorCategory,
  type GoldRecording,
  type Procedure,
  type RunResult,
} from '../misstep/schemas.js';
import { clearConfigCache, getEnvSettings, loadConfig } from '../misstep/settings.js';
import { runB0Baseline, runSingleCallBaseline } from './baselines.js';
import { scoreSystem, type EvalScoreReport } from './score.js';

export type EvalSystem =
  | 'B0'
  | 'B1'
  | 'B2'
  | 'misstep'
  | 'misstep-no-carbon'
  | 'misstep-no-localizer'
  | 'misstep-decisions-only-full';

export interface RunEvalArgs {
  system: EvalSystem;
  split: 'dev' | 'test';
  limit?: number;
  configPath?: string;
  final?: boolean;
  rerunReason?: string;
}

export interface FailureRecord {
  recording_id: string;
  activity_id: string;
  step_id: string;
  step_text: string;
  kind: 'FP' | 'FN';
  gold_has_error: boolean;
  gold_categories: ErrorCategory[];
  pred_status: string;
  pred_categories: ErrorCategory[];
  p_error: number;
  start_s: number | null;
  end_s: number | null;
  probabilities: unknown;
  question_texts: Record<string, string>;
}

function sha256File(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function verifyTestLock(
  system: EvalSystem,
  configPath: string,
  isFinal: boolean,
  rerunReason?: string,
): void {
  const isBaseline = system === 'B0' || system === 'B1' || system === 'B2';
  if (isBaseline) return; // Baselines B0/B1/B2 have nothing to tune (section 6.5)

  const frozenPath = path.resolve('./configs/FROZEN');
  if (!fs.existsSync(frozenPath)) {
    throw new Error('TEST LOCK: configs/FROZEN does not exist. Freeze the config after Phase 4 first.');
  }
  const frozenHash = fs.readFileSync(frozenPath, 'utf-8').trim();
  const actualHash = sha256File(configPath);
  if (frozenHash !== actualHash) {
    throw new Error(
      `TEST LOCK: SHA-256 of ${configPath} (${actualHash.slice(0, 12)}) does not match configs/FROZEN (${frozenHash.slice(0, 12)}).`,
    );
  }
  if (!isFinal) {
    throw new Error('TEST LOCK: --split test requires the --final flag.');
  }

  const testMisstepDir = path.join(getEnvSettings().runsDir, 'test', system);
  const hasCompletedTestRun =
    fs.existsSync(testMisstepDir) &&
    fs
      .readdirSync(testMisstepDir, { withFileTypes: true })
      .some((d) => d.isDirectory() && fs.existsSync(path.join(testMisstepDir, d.name, 'results.jsonl')));
  if (hasCompletedTestRun && !rerunReason) {
    throw new Error(
      `TEST LOCK: runs/test/${system}/ already contains a completed run. Pass --rerun-reason "<text>" to rerun.`,
    );
  }
  if (rerunReason) {
    const evalDocsPath = path.resolve('./docs/EVAL_RESULTS.md');
    fs.mkdirSync(path.dirname(evalDocsPath), { recursive: true });
    fs.appendFileSync(
      evalDocsPath,
      `\n> Test rerun (${system}, ${new Date().toISOString()}): ${rerunReason}\n`,
      'utf-8',
    );
  }
}

export function findLatestRunDir(split: 'dev' | 'test', system: string): string | null {
  const base = path.join(getEnvSettings().runsDir, split, system);
  if (!fs.existsSync(base)) return null;
  const dirs = fs
    .readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  if (dirs.length === 0) return null;
  // Prefer latest completed run (contains scores.json or results.jsonl)
  for (let i = dirs.length - 1; i >= 0; i--) {
    const candidate = path.join(base, dirs[i]);
    if (
      fs.existsSync(path.join(candidate, 'scores.json')) ||
      fs.existsSync(path.join(candidate, 'results.jsonl'))
    ) {
      return candidate;
    }
  }
  return path.join(base, dirs[dirs.length - 1]);
}

export function loadRunResults(runDir: string): RunResult[] {
  const p = path.join(runDir, 'results.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf-8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RunResult);
}

export async function runEval(args: RunEvalArgs): Promise<{
  runDir: string;
  results: RunResult[];
  scores: EvalScoreReport | null;
}> {
  clearConfigCache();
  const env = getEnvSettings();
  const configPath = path.resolve(args.configPath || env.configPath);
  const config = loadConfig(configPath);

  if (args.split === 'test') {
    verifyTestLock(args.system, configPath, Boolean(args.final), args.rerunReason);
  }

  const gold = readGoldJsonl();
  const goldById = new Map(gold.map((g) => [g.recording_id, g]));
  const splits = readSplits();
  const targetIds = (args.split === 'dev' ? splits.dev : splits.test).slice(0, args.limit);

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(env.runsDir, args.split, args.system, ts);
  fs.mkdirSync(runDir, { recursive: true });
  fs.copyFileSync(configPath, path.join(runDir, 'config.yaml'));

  const logLines: string[] = [];
  const evalDebugPath = path.join(env.runsDir, 'eval_debug.log');
  const log = (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    logLines.push(line);
    console.log(line);
    try {
      fs.appendFileSync(evalDebugPath, line + '\n', 'utf-8');
    } catch {
      // ignore
    }
  };
  log(`Starting eval system=${args.system} split=${args.split} limit=${args.limit ?? 'all'}`);

  // Dev base rate for B0
  const devGoldSteps = splits.dev
    .map((id) => goldById.get(id))
    .filter((x): x is GoldRecording => Boolean(x))
    .flatMap((r) => r.steps);
  const devBaseRate =
    devGoldSteps.length > 0
      ? devGoldSteps.filter((s) => s.has_error).length / devGoldSteps.length
      : 0.25;

  const recipes = loadRecipes();
  const procedureCache = new Map<string, Procedure>();
  const neededActivities = Array.from(
    new Set(
      targetIds
        .map((id) => goldById.get(id)?.activity_id)
        .filter((aid): aid is string => Boolean(aid)),
    ),
  );
  await Promise.all(
    neededActivities.map(async (aid) => {
      const procPath = path.join(env.dataDir, 'procedures', `${aid}.json`);
      if (fs.existsSync(procPath)) {
        procedureCache.set(aid, ProcedureSchema.parse(JSON.parse(fs.readFileSync(procPath, 'utf-8'))));
      } else if (recipes[aid]) {
        const fixedIds = recipes[aid].map(([sid]) => sid);
        const procText = procedureFromRecipe(aid);
        const compiled = await compileProcedure(
          { text: procText },
          'cc4d',
          aid,
          fixedIds,
          configPath,
        );
        procedureCache.set(aid, compiled.procedure);
        log(`Compiled procedure ${aid} (${compiled.procedure.steps.length} steps, $${compiled.costUsd.toFixed(4)})`);
      }
    }),
  );

  const results: RunResult[] = [];
  const failures: FailureRecord[] = [];
  const queue = [...targetIds];
  const workerCount =
    args.system === 'B0'
      ? 1
      : args.system === 'B1' || args.system === 'B2'
        ? Math.min(6, Math.max(1, env.concurrency))
        : Math.min(5, Math.max(1, env.concurrency));

  async function runOneRecording(recId: string): Promise<void> {
    const g = goldById.get(recId);
    if (!g) {
      log(`Skipping ${recId}: missing in gold.jsonl`);
      return;
    }

    const videoPath = path.join(env.dataDir, 'videos', `${recId}.mp4`);
    if (args.system !== 'B0' && !fs.existsSync(videoPath)) {
      log(`Skipping ${recId}: video not found at ${videoPath}`);
      return;
    }

    const procedure = procedureCache.get(g.activity_id);
    if (!procedure) {
      log(`Skipping ${recId}: activity ${g.activity_id} missing from recipes`);
      return;
    }

    let res: RunResult;
    let questionTexts: Record<string, Record<string, string>> = {};

    if (args.system === 'B0') {
      res = runB0Baseline(g, procedure, devBaseRate, config.version);
    } else if (args.system === 'B1' || args.system === 'B2') {
      res = await runSingleCallBaseline(args.system, g, procedure, videoPath, config.version);
    } else {
      const out = await runPipeline(procedure, videoPath, {
        system: args.system,
        configPath,
        recordingId: recId,
        noCarbon: args.system === 'misstep-no-carbon',
        noLocalizer: args.system === 'misstep-no-localizer',
        decisionsOnlyFull: args.system === 'misstep-decisions-only-full',
      });
      res = out.result;
      questionTexts = out.questionTexts;
    }

    results.push(res);

    if (args.split === 'dev') {
      const vByStep = new Map(res.verdicts.map((v) => [v.step_id, v]));
      const cByStep = new Map(res.checks.map((c) => [c.step_id, c]));
      const stepTextById = new Map(procedure.steps.map((s) => [s.step_id, s.text]));

      for (const gs of g.steps) {
        const v = vByStep.get(gs.step_id);
        const predErr = v?.status === 'error';
        if (predErr !== gs.has_error) {
          failures.push({
            recording_id: g.recording_id,
            activity_id: g.activity_id,
            step_id: gs.step_id,
            step_text: stepTextById.get(gs.step_id) ?? gs.description,
            kind: predErr ? 'FP' : 'FN',
            gold_has_error: gs.has_error,
            gold_categories: gs.categories,
            pred_status: v?.status ?? 'ok',
            pred_categories: v?.categories ?? [],
            p_error: v?.p_error ?? 0,
            start_s: gs.start_s ?? null,
            end_s: gs.end_s ?? null,
            probabilities: cByStep.get(gs.step_id) ?? null,
            question_texts: questionTexts[gs.step_id] ?? {},
          });
        }
      }
    }

    log(`Finished ${recId} (${args.system}): cost=$${res.cost_usd.toFixed(4)}, latency=${res.latency_s}s`);
  }

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (queue.length > 0) {
        const nextId = queue.shift();
        if (nextId) await runOneRecording(nextId);
      }
    }),
  );

  fs.writeFileSync(
    path.join(runDir, 'results.jsonl'),
    results.map((r) => JSON.stringify(r)).join('\n') + (results.length ? '\n' : ''),
    'utf-8',
  );

  if (args.split === 'dev') {
    fs.writeFileSync(
      path.join(runDir, 'failures.jsonl'),
      failures.map((f) => JSON.stringify(f)).join('\n') + (failures.length ? '\n' : ''),
      'utf-8',
    );
  }

  let scores: EvalScoreReport | null = null;
  const shouldWriteScores = args.split === 'dev' || Boolean(args.final);
  if (shouldWriteScores && results.length > 0) {
    const goldsForRun = targetIds
      .map((id) => goldById.get(id))
      .filter((x): x is GoldRecording => Boolean(x));
    const b1Dir = findLatestRunDir(args.split, 'B1');
    const b1Results = b1Dir ? loadRunResults(b1Dir) : undefined;
    scores = scoreSystem(args.system, goldsForRun, results, b1Results);
    fs.writeFileSync(path.join(runDir, 'scores.json'), JSON.stringify(scores, null, 2), 'utf-8');
  } else if (args.split === 'test' && !args.final) {
    // Baseline on test: write hidden scores file until Phase 6 final run
    const goldsForRun = targetIds
      .map((id) => goldById.get(id))
      .filter((x): x is GoldRecording => Boolean(x));
    const hiddenScores = scoreSystem(args.system, goldsForRun, results);
    fs.writeFileSync(
      path.join(runDir, '.hidden_scores.json'),
      JSON.stringify(hiddenScores, null, 2),
      'utf-8',
    );
    log('Baseline test run complete. Scores kept hidden until Phase 6 --final run.');
  }

  fs.writeFileSync(path.join(runDir, 'log.txt'), logLines.join('\n') + '\n', 'utf-8');
  return { runDir, results, scores };
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const getArg = (name: string): string | undefined => {
    const idx = argv.indexOf(name);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  const system = (getArg('--system') || 'misstep') as EvalSystem;
  const split = (getArg('--split') || 'dev') as 'dev' | 'test';
  const limitStr = getArg('--limit');
  const configPath = getArg('--config');
  const isFinal = argv.includes('--final');
  const rerunReason = getArg('--rerun-reason');

  runEval({
    system,
    split,
    limit: limitStr ? Number(limitStr) : undefined,
    configPath,
    final: isFinal,
    rerunReason,
  })
    .then(({ runDir, scores }) => {
      console.log(`Run written to ${runDir}`);
      if (scores) {
        console.log(
          JSON.stringify(
            {
              system: scores.system,
              recordings: scores.recordings,
              f1: scores.f1,
              covered_f1: scores.covered_f1,
              coverage: scores.coverage,
              auroc: scores.auroc,
              ece: scores.ece,
              mean_cost_usd: scores.mean_cost_usd,
              mean_latency_s: scores.mean_latency_s,
            },
            null,
            2,
          ),
        );
      }
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
