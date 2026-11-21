import fs from 'node:fs';
import path from 'node:path';
import { Type } from '@google/genai';
import { readGoldJsonl } from '../datasets/cc4d.js';
import { readSplits } from '../datasets/splits.js';
import { compileProcedure } from '../misstep/compiler.js';
import { generateJson } from '../misstep/gemini.js';
import { runPipeline } from '../misstep/pipeline.js';
import { ProcedureSchema, type GoldRecording, type Procedure, type RunResult } from '../misstep/schemas.js';
import { getEnvSettings, loadConfig } from '../misstep/settings.js';
import { applyStressTransform } from '../misstep/video.js';
import { scoreSystem } from './score.js';

export type StressCondition =
  | 'clean'
  | '240p'
  | '144p'
  | 'low_light'
  | 'occlusion'
  | 'speed_2x'
  | 'spanish';

export interface StressRow {
  condition: StressCondition;
  recordings: number;
  f1: number;
  recall: number;
  precision: number;
  mean_cost_usd: number;
  relative_to_clean: number;
  breaking_point: boolean;
}

export interface StressReport {
  generated_at: string;
  rows: StressRow[];
  breaking_points: StressCondition[];
}

export async function runStressLadder(
  conditions: StressCondition[] = ['clean', '240p', '144p', 'low_light', 'occlusion', 'speed_2x', 'spanish'],
  limit = 6,
): Promise<StressReport> {
  const env = getEnvSettings();
  const config = loadConfig();
  const splits = readSplits();
  const goldById = new Map(readGoldJsonl().map((g) => [g.recording_id, g]));

  const devIds = splits.dev
    .filter((id) => fs.existsSync(path.join(env.dataDir, 'videos', `${id}.mp4`)))
    .slice(0, limit);

  if (devIds.length === 0) {
    throw new Error('No dev videos found on disk for stress ladder.');
  }

  const golds = devIds
    .map((id) => goldById.get(id))
    .filter((x): x is GoldRecording => Boolean(x));

  const rows: StressRow[] = [];
  let cleanF1 = 0;

  for (const cond of conditions) {
    const results: RunResult[] = [];
    for (const g of golds) {
      const origVideo = path.join(env.dataDir, 'videos', `${g.recording_id}.mp4`);
      const procPath = path.join(env.dataDir, 'procedures', `${g.activity_id}.json`);
      if (!fs.existsSync(procPath)) continue;
      let procedure = ProcedureSchema.parse(JSON.parse(fs.readFileSync(procPath, 'utf-8')));

      let videoToRun = origVideo;
      if (cond === '240p' || cond === '144p' || cond === 'low_light' || cond === 'occlusion' || cond === 'speed_2x') {
        const stressedPath = path.join(env.cacheDir, 'stress', cond, `${g.recording_id}.mp4`);
        videoToRun = await applyStressTransform(origVideo, stressedPath, cond);
      } else if (cond === 'spanish') {
        const esProcId = `${g.activity_id}_es`;
        const esProcPath = path.join(env.dataDir, 'procedures', `${esProcId}.json`);
        if (fs.existsSync(esProcPath)) {
          procedure = ProcedureSchema.parse(JSON.parse(fs.readFileSync(esProcPath, 'utf-8')));
        } else {
          const translated = await generateJson<{ steps: Array<{ step_id: string; text: string }> }>({
            model: config.models.compiler,
            parts: [
              {
                text: `Translate each step text to Spanish, keeping the exact step_id:\n${procedure.steps
                  .map((s) => `[${s.step_id}] ${s.text}`)
                  .join('\n')}`,
              },
            ],
            schema: {
              type: Type.OBJECT,
              properties: {
                steps: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: { step_id: { type: Type.STRING }, text: { type: Type.STRING } },
                    required: ['step_id', 'text'],
                  },
                },
              },
              required: ['steps'],
            },
            thinkingLevel: 'low',
          });
          const esText = translated.data.steps
            .map((s, idx) => `${idx + 1}. [${s.step_id}] ${s.text}`)
            .join('\n');
          const compiled = await compileProcedure(
            { text: esText },
            'cc4d',
            esProcId,
            procedure.steps.map((s) => s.step_id),
          );
          procedure = compiled.procedure;
        }
      }

      const out = await runPipeline(procedure, videoToRun, {
        system: `stress_${cond}`,
        recordingId: `${g.recording_id}_${cond}`,
      });
      // Normalize recording_id back to gold recording_id for scoring
      results.push({ ...out.result, recording_id: g.recording_id });
    }

    const scored = scoreSystem(`stress_${cond}`, golds, results, undefined, 200);
    if (cond === 'clean') {
      cleanF1 = scored.f1.value;
    }
    const rel = cleanF1 > 0 ? scored.f1.value / cleanF1 : 1;
    rows.push({
      condition: cond,
      recordings: scored.recordings,
      f1: scored.f1.value,
      recall: scored.recall.value,
      precision: scored.precision.value,
      mean_cost_usd: scored.mean_cost_usd,
      relative_to_clean: Number(rel.toFixed(3)),
      breaking_point: cond !== 'clean' && cleanF1 > 0 && scored.f1.value < cleanF1 * 0.5,
    });
  }

  const report: StressReport = {
    generated_at: new Date().toISOString(),
    rows,
    breaking_points: rows.filter((r) => r.breaking_point).map((r) => r.condition),
  };

  const outPath = path.join(env.runsDir, 'stress', 'report.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8');
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const limitIdx = argv.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number(argv[limitIdx + 1]) : 6;
  runStressLadder(undefined, limit)
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
