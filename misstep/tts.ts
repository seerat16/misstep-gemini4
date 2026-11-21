import fs from 'node:fs';
import path from 'node:path';
import { tts } from './gemini.js';
import type { Procedure } from './schemas.js';
import { getEnvSettings, loadConfig } from './settings.js';

export interface AlertAudioEntry {
  key: string;
  text: string;
  url: string | null;
}

function shortText(text: string, maxLen = 60): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen - 1)}…`;
}

export async function pregenerateProcedureAlerts(
  procedure: Procedure,
  configPath?: string,
): Promise<Record<string, AlertAudioEntry>> {
  const config = loadConfig(configPath);
  const { runsDir } = getEnvSettings();
  const safeProc = procedure.procedure_id.replace(/[^a-zA-Z0-9._-]/g, '_');
  const outDir = path.join(runsDir, 'tts', safeProc);
  fs.mkdirSync(outDir, { recursive: true });

  const alertsToBuild: Array<{ key: string; text: string }> = [];

  procedure.steps.forEach((step, idx) => {
    const stepNum = idx + 1;
    alertsToBuild.push({
      key: `skip_${step.step_id}`,
      text: `Wait. You skipped step ${stepNum}: ${shortText(step.text)}`,
    });
    for (const predId of step.must_follow) {
      const predIdx = procedure.steps.findIndex((s) => s.step_id === predId);
      const predNum = predIdx >= 0 ? predIdx + 1 : predId;
      alertsToBuild.push({
        key: `order_${predId}_before_${step.step_id}`,
        text: `Order: finish step ${predNum} before step ${stepNum}.`,
      });
    }
  });

  const result: Record<string, AlertAudioEntry> = {};

  await Promise.all(
    alertsToBuild.map(async ({ key, text }) => {
      const safeKey = key.replace(/[^a-zA-Z0-9._-]/g, '_');
      const wavPath = path.join(outDir, `${safeKey}.wav`);
      const url = `/api/tts/${encodeURIComponent(safeProc)}/${encodeURIComponent(`${safeKey}.wav`)}`;

      if (fs.existsSync(wavPath) && fs.statSync(wavPath).size > 44) {
        result[key] = { key, text, url };
        return;
      }

      try {
        const wav = await tts(text, config.models.tts_voice || 'Kore', config.models.tts);
        fs.writeFileSync(wavPath, wav);
        result[key] = { key, text, url };
      } catch (err) {
        console.warn(`[tts] failed for ${key}, browser speechSynthesis fallback will be used:`, err);
        result[key] = { key, text, url: null };
      }
    }),
  );

  return result;
}
