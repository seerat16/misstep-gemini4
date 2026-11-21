import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  findLatestRunDir,
  runEval,
  type FailureRecord,
} from '../eval/run_eval.js';
import type { EvalScoreReport } from '../eval/score.js';
import { agentInteraction, appendDebugLog } from '../misstep/gemini.js';
import { FAILURE_ANALYST_PROMPT } from '../misstep/prompts.js';
import {
  clearConfigCache,
  dumpConfigYaml,
  getEnvSettings,
  loadConfig,
  parseConfigYaml,
  type PipelineConfig,
} from '../misstep/settings.js';
import { still } from '../misstep/video.js';

const AGENT_TOOLS = [
  {
    type: 'function',
    name: 'get_failure_summary',
    description:
      'Returns failure counts grouped by (FP/FN, category), current dev metrics, and current config version.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    type: 'function',
    name: 'get_failures',
    description:
      'Returns up to 15 failure examples matching a category and kind (FP or FN), including probabilities and question texts.',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Error category name (or "all")' },
        kind: { type: 'string', enum: ['FP', 'FN'] },
        limit: { type: 'integer', description: 'Max failures to return (<= 15)' },
      },
      required: ['category', 'kind'],
    },
  },
  {
    type: 'function',
    name: 'get_config',
    description: 'Returns the current pipeline YAML configuration text.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    type: 'function',
    name: 'run_dev_eval',
    description:
      'Validates proposed config YAML (only allowed keys may change), saves configs/pipeline_vN.yaml, runs dev eval, and returns metrics + delta vs current best. Max 3 calls per session.',
    parameters: {
      type: 'object',
      properties: {
        config_yaml: { type: 'string', description: 'Complete updated YAML config' },
        reason: { type: 'string', description: 'Hypothesis / reason for this change' },
      },
      required: ['config_yaml', 'reason'],
    },
  },
];

function flattenKeys(obj: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    out.set(prefix, JSON.stringify(obj));
    return out;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    for (const [subK, subV] of flattenKeys(v, key).entries()) {
      out.set(subK, subV);
    }
  }
  return out;
}

const ALLOWED_KEY_PREFIXES = [
  'version',
  'thresholds.',
  'questions.',
  'media.',
  'models.localizer_processing',
  'models.localizer_fps',
  'adjudicator.max_calls_per_video',
];

export function validateAllowedConfigChanges(
  baseConfig: PipelineConfig,
  nextConfig: PipelineConfig,
): string[] {
  const baseFlat = flattenKeys(baseConfig);
  const nextFlat = flattenKeys(nextConfig);
  const violations: string[] = [];

  const allKeys = new Set([...baseFlat.keys(), ...nextFlat.keys()]);
  for (const k of allKeys) {
    if (baseFlat.get(k) !== nextFlat.get(k)) {
      const allowed = ALLOWED_KEY_PREFIXES.some((p) => k === p || k.startsWith(p));
      if (!allowed) {
        violations.push(`Key "${k}" is locked and cannot be modified by the failure analyst.`);
      }
    }
  }
  return violations;
}

function readDevFailures(): FailureRecord[] {
  const dir = findLatestRunDir('dev', 'misstep');
  if (!dir) return [];
  const p = path.join(dir, 'failures.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf-8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as FailureRecord);
}

function readDevScores(): EvalScoreReport | null {
  const dir = findLatestRunDir('dev', 'misstep');
  if (!dir) return null;
  const p = path.join(dir, 'scores.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as EvalScoreReport;
}

function extractCombinedModelText(interaction: Record<string, unknown>): string {
  if (typeof interaction.output_text === 'string' && interaction.output_text.trim()) {
    return interaction.output_text.trim();
  }
  const steps = (interaction.steps as Array<Record<string, unknown>> | undefined) ?? [];
  const outputs = (interaction.outputs as Array<Record<string, unknown>> | undefined) ?? [];
  let combined = '';
  for (const step of steps) {
    if (step.type === 'model_output' && Array.isArray(step.content)) {
      for (const c of step.content as Array<{ type?: string; text?: string }>) {
        if (c.type === 'text' && c.text) combined += c.text;
      }
    } else if (step.type === 'text' && typeof step.text === 'string') {
      combined += step.text;
    }
  }
  if (!combined) {
    for (const out of outputs) {
      if (out.type === 'text' && typeof out.text === 'string') combined += out.text;
    }
  }
  return combined.trim();
}

const CUSTOM_TOOL_NAMES = new Set(AGENT_TOOLS.map((t) => t.name));

function extractFunctionCalls(interaction: Record<string, unknown>): Array<Record<string, unknown>> {
  const steps = (interaction.steps as Array<Record<string, unknown>> | undefined) ?? [];
  const outputs = (interaction.outputs as Array<Record<string, unknown>> | undefined) ?? [];
  const answeredIds = new Set<string>();
  for (const s of [...steps, ...outputs]) {
    if (s.type === 'function_result' && s.call_id) {
      answeredIds.add(String(s.call_id));
    }
  }
  const calls: Array<Record<string, unknown>> = [];
  for (const s of [...steps, ...outputs]) {
    if (s.type === 'function_call') {
      calls.push(s);
    } else if (s.type === 'model_output' && Array.isArray(s.content)) {
      for (const c of s.content as Array<Record<string, unknown>>) {
        if (c.type === 'function_call') calls.push(c);
      }
    }
  }
  // Deduplicate by id, exclude already-answered calls and built-in sandbox tools
  const seen = new Set<string>();
  return calls.filter((c) => {
    const name = String(c.name ?? '');
    if (!CUSTOM_TOOL_NAMES.has(name)) return false;
    const id = String(c.id ?? `${name}_${JSON.stringify(c.arguments ?? {})}`);
    if (answeredIds.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export interface AgentRunSummary {
  transcript_path: string;
  changelog_entry: string;
  eval_calls_used: number;
  best_config_path: string;
  best_f1: number;
}

export async function runFailureAnalyst(): Promise<AgentRunSummary> {
  const env = getEnvSettings();
  let currentConfigPath = env.configPath;
  let currentConfig = loadConfig(currentConfigPath);
  const initialScores = readDevScores();
  if (!initialScores) {
    throw new Error('No completed dev run found for misstep. Run misstep dev eval first.');
  }
  let bestF1 = initialScores.f1.value;
  let bestConfigPath = currentConfigPath;
  let evalCallsUsed = 0;
  let nextVersionNum = 2;

  while (fs.existsSync(path.resolve(`./configs/pipeline_v${nextVersionNum}.yaml`))) {
    nextVersionNum += 1;
  }

  // Extract up to 8 midpoint JPEG stills from worst dev failures
  const failures = readDevFailures();
  const stillParts: Array<{ type: 'image'; data: string; mime_type: string }> = [];
  const stillDir = path.join(env.cacheDir, 'agent_stills');
  for (const f of failures.slice(0, 8)) {
    const vidPath = path.join(env.dataDir, 'videos', `${f.recording_id}.mp4`);
    if (!fs.existsSync(vidPath)) continue;
    const mid =
      f.start_s != null && f.end_s != null
        ? (f.start_s + f.end_s) / 2
        : f.start_s ?? 10;
    try {
      const outStill = await still(
        vidPath,
        mid,
        path.join(stillDir, `${f.recording_id}_${f.step_id}.jpg`),
        640,
      );
      stillParts.push({
        type: 'image',
        data: fs.readFileSync(outStill).toString('base64'),
        mime_type: 'image/jpeg',
      });
    } catch {
      // skip unavailable still
    }
  }

  const initialInput: Array<Record<string, unknown>> = [
    { type: 'text', text: FAILURE_ANALYST_PROMPT },
    ...stillParts,
  ];

  appendDebugLog(`[agent] starting Antigravity failure analyst (stills=${stillParts.length}, initialF1=${bestF1})`);
  const transcript: Array<Record<string, unknown>> = [];
  let interaction = await agentInteraction({
    agent: 'antigravity-preview-09-2026',
    agent_config: {
      type: 'antigravity',
      model: 'gemini-4-neon',
    },
    environment: 'remote',
    tools: AGENT_TOOLS,
    input: initialInput,
    store: true,
  });
  transcript.push(interaction);
  appendDebugLog(`[agent] turn 0 status=${String(interaction.status)} id=${String(interaction.id)}`);

  let maxTurns = 16;
  while (interaction.status === 'requires_action' && maxTurns-- > 0) {
    const fnCalls = extractFunctionCalls(interaction);
    appendDebugLog(`[agent] requires_action fnCalls=${fnCalls.map((c) => c.name).join(', ')}`);
    if (fnCalls.length === 0) break;
    const resultsToReturn: Array<Record<string, unknown>> = [];

    for (const call of fnCalls) {
      const name = String(call.name);
      const callId = String(call.id);
      const args = (call.arguments ?? {}) as Record<string, unknown>;
      let resultObj: unknown;

      if (name === 'get_failure_summary') {
        const curFailures = readDevFailures();
        const counts: Record<string, number> = {};
        for (const f of curFailures) {
          const cats =
            f.kind === 'FP'
              ? f.pred_categories.length > 0
                ? f.pred_categories
                : ['unknown']
              : f.gold_categories.length > 0
                ? f.gold_categories
                : ['none'];
          for (const c of cats) {
            const k = `${f.kind}:${c}`;
            counts[k] = (counts[k] ?? 0) + 1;
          }
        }
        resultObj = {
          counts_by_kind_category: counts,
          total_failures: curFailures.length,
          dev_metrics: readDevScores(),
          current_config_version: currentConfig.version,
        };
      } else if (name === 'get_failures') {
        const cat = String(args.category ?? 'all');
        const kind = String(args.kind ?? 'FN');
        const limit = Math.min(15, Math.max(1, Number(args.limit ?? 10)));
        const matched = readDevFailures()
          .filter(
            (f) =>
              f.kind === kind &&
              (cat === 'all' || f.gold_categories.includes(cat as never) || f.pred_categories.includes(cat as never)),
          )
          .slice(0, limit)
          .map((f) => ({
            recording_id: f.recording_id,
            step_id: f.step_id,
            step_text: f.step_text,
            gold_has_error: f.gold_has_error,
            gold_categories: f.gold_categories,
            pred_status: f.pred_status,
            pred_categories: f.pred_categories,
            p_error: f.p_error,
            probabilities: f.probabilities,
            question_texts: f.question_texts,
            clip_summary: `Window ${f.start_s ?? '?'}s to ${f.end_s ?? '?'}s in ${f.recording_id}`,
          }));
        resultObj = {
          category: cat,
          kind,
          count: matched.length,
          failures: matched,
        };
      } else if (name === 'get_config') {
        resultObj = { yaml: dumpConfigYaml(currentConfig) };
      } else if (name === 'run_dev_eval') {
        if (evalCallsUsed >= 3) {
          resultObj = { error: 'Max 3 run_dev_eval calls per session reached.' };
        } else {
          try {
            const proposed = parseConfigYaml(String(args.config_yaml ?? ''));
            const violations = validateAllowedConfigChanges(currentConfig, proposed);
            if (violations.length > 0) {
              resultObj = { error: 'Config validation failed', violations };
            } else {
              evalCallsUsed += 1;
              const ver = `v${nextVersionNum++}`;
              proposed.version = ver;
              const newCfgPath = path.resolve(`./configs/pipeline_${ver}.yaml`);
              fs.mkdirSync(path.dirname(newCfgPath), { recursive: true });
              fs.writeFileSync(newCfgPath, dumpConfigYaml(proposed), 'utf-8');
              clearConfigCache();

              const evalOut = await runEval({
                system: 'misstep',
                split: 'dev',
                configPath: newCfgPath,
              });
              const newScores = evalOut.scores;
              const newF1 = newScores?.f1.value ?? 0;
              const delta = Number((newF1 - bestF1).toFixed(4));
              if (newScores && newF1 > bestF1 && newScores.coverage.value >= 0.8) {
                bestF1 = newF1;
                bestConfigPath = newCfgPath;
                currentConfig = proposed;
                currentConfigPath = newCfgPath;
              }
              resultObj = {
                version: ver,
                reason: String(args.reason ?? ''),
                metrics: newScores,
                delta_vs_best: delta,
                per_category_recall: newScores?.per_category ?? [],
              };
            }
          } catch (err) {
            resultObj = { error: err instanceof Error ? err.message : String(err) };
          }
        }
      } else {
        resultObj = { error: `Unknown tool: ${name}` };
      }

      resultsToReturn.push({
        type: 'function_result',
        call_id: callId,
        name,
        result: JSON.stringify(resultObj),
      });
    }

    interaction = await agentInteraction({
      agent: 'antigravity-preview-09-2026',
      agent_config: {
        type: 'antigravity',
        model: 'gemini-4-neon',
      },
      previous_interaction_id: interaction.id,
      environment: interaction.environment_id || 'remote',
      tools: AGENT_TOOLS,
      input: resultsToReturn,
      store: true,
    });
    transcript.push(interaction);
    appendDebugLog(`[agent] next turn status=${String(interaction.status)} id=${String(interaction.id)} evalCallsUsed=${evalCallsUsed} bestF1=${bestF1}`);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const transcriptPath = path.join(env.runsDir, 'agent', ts, 'transcript.json');
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(transcriptPath, JSON.stringify(transcript, null, 2), 'utf-8');

  const changelogEntry = extractCombinedModelText(interaction).trim();
  if (changelogEntry) {
    const changelogPath = path.resolve('./docs/CHANGELOG_FIXES.md');
    fs.mkdirSync(path.dirname(changelogPath), { recursive: true });
    fs.appendFileSync(changelogPath, `\n${changelogEntry}\n`, 'utf-8');
  }

  return {
    transcript_path: transcriptPath,
    changelog_entry: changelogEntry,
    eval_calls_used: evalCallsUsed,
    best_config_path: bestConfigPath,
    best_f1: bestF1,
  };
}

export function freezeConfig(sourceConfigPath?: string): {
  final_config_path: string;
  frozen_path: string;
  sha256: string;
} {
  const src = path.resolve(sourceConfigPath || getEnvSettings().configPath);
  const finalPath = path.resolve('./configs/pipeline_final.yaml');
  const frozenPath = path.resolve('./configs/FROZEN');
  fs.copyFileSync(src, finalPath);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(finalPath)).digest('hex');
  fs.writeFileSync(frozenPath, sha + '\n', 'utf-8');
  return { final_config_path: finalPath, frozen_path: frozenPath, sha256: sha };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const freezeIdx = argv.indexOf('--freeze');
  if (freezeIdx >= 0) {
    const out = freezeConfig(argv[freezeIdx + 1]);
    console.log(JSON.stringify(out, null, 2));
  } else {
    runFailureAnalyst()
      .then((out) => {
        console.log(JSON.stringify(out, null, 2));
      })
      .catch((err) => {
        console.error(err);
        process.exit(1);
      });
  }
}
