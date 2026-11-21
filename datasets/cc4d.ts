import fs from 'node:fs';
import path from 'node:path';
import {
  GoldRecordingSchema,
  type ErrorCategory,
  type GoldRecording,
  type GoldStep,
} from '../misstep/schemas.js';
import { getEnvSettings } from '../misstep/settings.js';

const CATEGORY_MAP: Record<string, ErrorCategory> = {
  'missing step': 'missing_step',
  missing_step: 'missing_step',
  order: 'order',
  'order error': 'order',
  measurement: 'measurement',
  'measurement error': 'measurement',
  technique: 'technique',
  'technique error': 'technique',
  preparation: 'preparation',
  'preparation error': 'preparation',
  timing: 'timing',
  'timing error': 'timing',
  temperature: 'temperature',
  'temperature error': 'temperature',
  other: 'other',
};

export function mapCategoryName(raw: string): ErrorCategory {
  const key = raw.trim().toLowerCase();
  return CATEGORY_MAP[key] ?? 'other';
}

function readJsonIfExists<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

function parseCsvSimple(text: string): Array<Record<string, string>> {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];
  const parseRow = (line: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  };
  const headers = parseRow(lines[0]);
  return lines.slice(1).map((line) => {
    const cols = parseRow(line);
    const rec: Record<string, string> = {};
    headers.forEach((h, i) => {
      rec[h] = cols[i] ?? '';
    });
    return rec;
  });
}

function getAnnotationsRoot(): string {
  return path.join(getEnvSettings().dataDir, 'cc4d_annotations');
}

function loadActivityNames(): Record<string, string> {
  const root = getAnnotationsRoot();
  const csvPath = path.join(root, 'annotation_csv', 'activity_idx_step_idx.csv');
  const csvPath2 = path.join(root, 'annotation_csv', 'activity_step_description.csv');
  const names: Record<string, string> = {};
  for (const p of [csvPath, csvPath2]) {
    if (!fs.existsSync(p)) continue;
    for (const r of parseCsvSimple(fs.readFileSync(p, 'utf-8'))) {
      if (r.activity_idx && r.activity_name) {
        names[String(r.activity_idx)] = r.activity_name;
      }
    }
    if (Object.keys(names).length > 0) break;
  }
  return names;
}

function loadVideoDurations(): Record<string, number> {
  const root = getAnnotationsRoot();
  const vidPath = path.join(root, 'metadata', 'video_information.csv');
  const durations: Record<string, number> = {};
  if (!fs.existsSync(vidPath)) return durations;
  for (const r of parseCsvSimple(fs.readFileSync(vidPath, 'utf-8'))) {
    const recId = r.recording_id;
    const sec = Number(r['duration(sec)'] || r.duration_sec || r.duration || 0);
    if (recId && Number.isFinite(sec) && sec > 0) {
      durations[recId] = sec;
    }
  }
  return durations;
}

export function loadRecipes(): Record<string, Array<[string, string]>> {
  const root = getAnnotationsRoot();
  const mapping =
    readJsonIfExists<Record<string, Array<string | number>>>(
      path.join(root, 'annotation_json', 'activity_idx_step_idx.json'),
    ) ??
    readJsonIfExists<Record<string, Array<string | number>>>(
      path.join(root, 'metadata', 'activity_id_step_id_mapping.json'),
    );
  const descriptions =
    readJsonIfExists<Record<string, string>>(
      path.join(root, 'annotation_json', 'step_idx_description.json'),
    ) ??
    readJsonIfExists<Record<string, string>>(
      path.join(root, 'metadata', 'step_idx_description.json'),
    ) ??
    {};

  if (!mapping) {
    return {};
  }

  const out: Record<string, Array<[string, string]>> = {};
  for (const [activityId, stepIds] of Object.entries(mapping)) {
    const seen = new Set<string>();
    const uniqueSteps: Array<[string, string]> = [];
    for (const sid of stepIds) {
      const key = String(sid);
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueSteps.push([key, descriptions[key] ?? `Step ${key}`]);
    }
    out[String(activityId)] = uniqueSteps;
  }
  return out;
}

export function loadTaskGraph(activityId: string): Record<string, string[]> {
  const root = getAnnotationsRoot();
  const recipes = loadRecipes();
  const steps = recipes[String(activityId)] ?? [];
  const graphDir = path.join(root, 'task_graphs');

  if (fs.existsSync(graphDir)) {
    const activityNames = loadActivityNames();
    const rawName = activityNames[String(activityId)] ?? '';
    const slug = rawName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const files = fs.readdirSync(graphDir).filter((f) => f.endsWith('.json'));
    const matchFile =
      files.find((f) => slug && f.replace(/\.json$/, '').toLowerCase() === slug) ??
      files.find((f) => f.includes(String(activityId)));

    if (matchFile) {
      try {
        const raw = JSON.parse(
          fs.readFileSync(path.join(graphDir, matchFile), 'utf-8'),
        ) as {
          steps?: Record<string, string>;
          edges?: Array<[string | number, string | number]>;
        };
        if (Array.isArray(raw.edges)) {
          const validIds = new Set(steps.map(([sid]) => sid));
          const preds: Record<string, string[]> = {};
          for (const [sid] of steps) preds[sid] = [];
          for (const [from, to] of raw.edges) {
            const toKey = String(to);
            const fromKey = String(from);
            if (!validIds.has(toKey) || !validIds.has(fromKey)) continue;
            if (!preds[toKey].includes(fromKey)) preds[toKey].push(fromKey);
          }
          return preds;
        }
      } catch {
        // fallback to linear chain below
      }
    }
  }

  // Fallback: chain in recipe order
  const chain: Record<string, string[]> = {};
  steps.forEach(([sid], idx) => {
    chain[sid] = idx > 0 ? [steps[idx - 1][0]] : [];
  });
  return chain;
}

export function procedureFromRecipe(activityId: string): string {
  const recipes = loadRecipes();
  const steps = recipes[String(activityId)];
  if (!steps || steps.length === 0) {
    throw new Error(`Activity ${activityId} not found in CaptainCook4D recipes`);
  }
  return steps
    .map(([stepId, desc], idx) => `${idx + 1}. [${stepId}] ${desc}`)
    .join('\n');
}

interface RawErrorStepAnn {
  step_id: string | number;
  start_time?: number;
  end_time?: number;
  description?: string;
  errors?: Array<{ tag?: string; description?: string }>;
}

interface RawErrorRecording {
  recording_id: string;
  activity_id?: string | number;
  is_error?: boolean;
  step_annotations?: RawErrorStepAnn[];
}

export function loadGold(writeJsonl = true): GoldRecording[] {
  const root = getAnnotationsRoot();
  const stepJsonPath = path.join(root, 'annotation_json', 'step_annotations.json');
  const errJsonPath = path.join(root, 'annotation_json', 'error_annotations.json');
  const completeJsonPath = path.join(root, 'annotation_json', 'complete_step_annotations.json');

  const stepAnn = readJsonIfExists<Record<string, unknown>>(stepJsonPath) ?? {};
  const errRaw = readJsonIfExists<RawErrorRecording[] | Record<string, RawErrorRecording>>(errJsonPath);
  const completeRaw = readJsonIfExists<Record<string, RawErrorRecording>>(completeJsonPath) ?? {};
  const durations = loadVideoDurations();
  const recipes = loadRecipes();

  // Normalize error_annotations.json (array in CC4D) + complete_step_annotations.json by recording_id
  const errByRec = new Map<string, RawErrorRecording>();
  if (Array.isArray(errRaw)) {
    for (const item of errRaw) {
      if (item?.recording_id) errByRec.set(item.recording_id, item);
    }
  } else if (errRaw && typeof errRaw === 'object') {
    for (const [k, v] of Object.entries(errRaw)) {
      errByRec.set(k, v);
    }
  }
  for (const [k, v] of Object.entries(completeRaw)) {
    if (!errByRec.has(k)) errByRec.set(k, v);
  }

  const allRecIds = Array.from(new Set([...errByRec.keys(), ...Object.keys(stepAnn)]));
  const recordings: GoldRecording[] = [];

  for (const recId of allRecIds) {
    const errEntry = errByRec.get(recId);
    const stepEntry = (stepAnn[recId] ?? {}) as {
      activity_id?: string | number;
      steps?: Array<{
        step_id: string | number;
        start_time?: number;
        end_time?: number;
        description?: string;
        has_errors?: boolean;
      }>;
    };

    const activityId = String(
      errEntry?.activity_id ?? stepEntry.activity_id ?? recId.split('_')[0],
    );
    const recipeSteps = recipes[activityId] ?? [];

    const stepMap = new Map<
      string,
      {
        has_error: boolean;
        categories: Set<ErrorCategory>;
        start_s: number | null;
        end_s: number | null;
        description: string;
      }
    >();

    let maxEnd = 0;

    // 1. Seed from step_annotations.json if present
    for (const s of stepEntry.steps ?? []) {
      const sid = String(s.step_id);
      const startS = s.start_time !== undefined && s.start_time >= 0 ? s.start_time : null;
      const endS = s.end_time !== undefined && s.end_time >= 0 ? s.end_time : null;
      if (endS !== null && endS > maxEnd) maxEnd = endS;

      const existing = stepMap.get(sid) ?? {
        has_error: false,
        categories: new Set<ErrorCategory>(),
        start_s: startS,
        end_s: endS,
        description: s.description ?? '',
      };
      if (s.has_errors) existing.has_error = true;
      if (existing.start_s === null && startS !== null) existing.start_s = startS;
      if (endS !== null) existing.end_s = endS;
      stepMap.set(sid, existing);
    }

    // 2. Overlay detailed error tags and missing steps from error_annotations.json / complete_step_annotations.json
    for (const es of errEntry?.step_annotations ?? []) {
      const sid = String(es.step_id);
      const startS = es.start_time !== undefined && es.start_time >= 0 ? es.start_time : null;
      const endS = es.end_time !== undefined && es.end_time >= 0 ? es.end_time : null;
      if (endS !== null && endS > maxEnd) maxEnd = endS;

      const existing = stepMap.get(sid) ?? {
        has_error: false,
        categories: new Set<ErrorCategory>(),
        start_s: startS,
        end_s: endS,
        description: es.description ?? '',
      };
      if (existing.start_s === null && startS !== null) existing.start_s = startS;
      if (endS !== null) existing.end_s = endS;
      if (!existing.description && es.description) existing.description = es.description;

      for (const e of es.errors ?? []) {
        existing.has_error = true;
        if (e.tag) existing.categories.add(mapCategoryName(e.tag));
      }
      stepMap.set(sid, existing);
    }

    const goldSteps: GoldStep[] = [];
    const orderedIds =
      recipeSteps.length > 0 ? recipeSteps.map(([sid]) => sid) : Array.from(stepMap.keys());
    for (const sid of orderedIds) {
      const entry = stepMap.get(sid);
      if (!entry) continue;
      goldSteps.push({
        step_id: sid,
        has_error: entry.has_error,
        categories: Array.from(entry.categories),
        start_s: entry.start_s,
        end_s: entry.end_s,
        description: entry.description,
      });
    }

    if (goldSteps.length === 0) continue;

    const isError =
      errEntry?.is_error !== undefined
        ? Boolean(errEntry.is_error)
        : goldSteps.some((gs) => gs.has_error);

    const durS = durations[recId] ?? maxEnd;

    recordings.push(
      GoldRecordingSchema.parse({
        recording_id: recId,
        activity_id: activityId,
        is_error: isError,
        duration_s: durS,
        steps: goldSteps,
      }),
    );
  }

  if (writeJsonl && recordings.length > 0) {
    const outPath = path.join(getEnvSettings().dataDir, 'gold.jsonl');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(
      outPath,
      recordings.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf-8',
    );
  }

  return recordings;
}

export function readGoldJsonl(filePath?: string): GoldRecording[] {
  const target = filePath || path.join(getEnvSettings().dataDir, 'gold.jsonl');
  if (!fs.existsSync(target)) return [];
  return fs
    .readFileSync(target, 'utf-8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => GoldRecordingSchema.parse(JSON.parse(l)));
}
