import fs from 'node:fs';
import path from 'node:path';
import type { Part } from '@google/genai';
import { generateJson } from './gemini.js';
import { COMPILER_PROMPT, fillTemplate } from './prompts.js';
import {
  PROCEDURE_GEMINI_SCHEMA,
  ProcedureSchema,
  type Procedure,
} from './schemas.js';
import { getEnvSettings, loadConfig } from './settings.js';

export interface CompileInput {
  text?: string;
  filePath?: string;
  fileBytes?: Buffer;
  mimeType?: string;
}

function buildInputPart(input: CompileInput): Part {
  if (input.fileBytes && input.mimeType) {
    return {
      inlineData: {
        data: input.fileBytes.toString('base64'),
        mimeType: input.mimeType,
      },
    };
  }
  if (input.filePath) {
    const abs = path.resolve(input.filePath);
    const ext = path.extname(abs).toLowerCase();
    if (ext === '.md' || ext === '.txt') {
      return { text: fs.readFileSync(abs, 'utf-8') };
    }
    const mime =
      input.mimeType ||
      (ext === '.pdf'
        ? 'application/pdf'
        : ext === '.png'
          ? 'image/png'
          : 'image/jpeg');
    return {
      inlineData: {
        data: fs.readFileSync(abs).toString('base64'),
        mimeType: mime,
      },
    };
  }
  if (input.text) {
    return { text: input.text };
  }
  throw new Error('CompileInput requires text, filePath, or fileBytes');
}

export function getProcedurePath(procedureId: string): string {
  const { dataDir } = getEnvSettings();
  const safe = procedureId.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(dataDir, 'procedures', `${safe}.json`);
}

export async function compileProcedure(
  input: CompileInput,
  source: 'cc4d' | 'medprep' | 'upload',
  procedureId: string,
  fixedStepIds?: string[],
  configPath?: string,
): Promise<{ procedure: Procedure; costUsd: number }> {
  const outPath = getProcedurePath(procedureId);
  if (fs.existsSync(outPath)) {
    const cached = ProcedureSchema.parse(JSON.parse(fs.readFileSync(outPath, 'utf-8')));
    return { procedure: cached, costUsd: 0 };
  }

  const config = loadConfig(configPath);
  const fixedIdsClause = fixedStepIds
    ? `Steps are given with IDs in square brackets: [${fixedStepIds.join(', ')}]. You MUST return exactly these ${fixedStepIds.length} steps with exactly these IDs.`
    : '';
  const idRule = fixedStepIds ? 'use the given ID' : 'S1, S2, ... in order';
  const promptText = fillTemplate(COMPILER_PROMPT, {
    fixed_ids_clause: fixedIdsClause,
    id_rule: idRule,
  });

  const mediaPart = buildInputPart(input);
  let totalCost = 0;
  let lastValidationErr: string | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const parts: Part[] = [
      { text: promptText },
      mediaPart,
      {
        text: `Set procedure_id="${procedureId}" and source="${source}".${
          lastValidationErr
            ? `\n\nPREVIOUS OUTPUT FAILED VALIDATION: ${lastValidationErr}\nFix this and return exact matching step_ids.`
            : ''
        }`,
      },
    ];

    const res = await generateJson<Procedure>({
      model: config.models.compiler,
      parts,
      schema: PROCEDURE_GEMINI_SCHEMA,
      thinkingLevel: config.models.compiler_thinking,
      skipCache: attempt > 0,
    });
    totalCost += res.costUsd;

    const candidate: Procedure = {
      ...res.data,
      procedure_id: procedureId,
      source,
    };
    const parsed = ProcedureSchema.parse(candidate);

    if (fixedStepIds) {
      const gotIds = parsed.steps.map((s) => s.step_id);
      const exactMatch =
        gotIds.length === fixedStepIds.length &&
        gotIds.every((id, idx) => id === fixedStepIds[idx]);
      if (!exactMatch) {
        lastValidationErr = `Expected exact step_ids ${JSON.stringify(fixedStepIds)} (${fixedStepIds.length} steps), got ${JSON.stringify(gotIds)} (${gotIds.length} steps).`;
        if (attempt === 0) continue;
        throw new Error(lastValidationErr);
      }
    }

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(parsed, null, 2), 'utf-8');
    return { procedure: parsed, costUsd: totalCost };
  }

  throw new Error(lastValidationErr || 'Procedure compilation failed');
}
