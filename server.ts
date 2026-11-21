import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { runFailureAnalyst, freezeConfig } from './agent/failure_analyst.js';
import { readFieldGold, saveFieldLabel, scoreFieldRuns, type FieldLabelRecord } from './eval/field_eval.js';
import { collectReportData, generateEvalMarkdownAndHtml } from './eval/report.js';
import { runEval, type EvalSystem } from './eval/run_eval.js';
import { runStressLadder } from './eval/stress.js';
import { compileProcedure } from './misstep/compiler.js';
import { readSpendLedger } from './misstep/cost.js';
import { isGeminiConfigured, uploadFile } from './misstep/gemini.js';
import { liveSessionManager } from './misstep/live.js';
import { runPipeline } from './misstep/pipeline.js';
import { getEnvSettings, loadConfig } from './misstep/settings.js';
import { runSmokeTests } from './scripts/smoke_test.js';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';

app.use(express.json({ limit: '40mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const uploadDir = path.join(getEnvSettings().cacheDir, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 250 * 1024 * 1024 },
});

const publicDir = path.resolve('./public');
app.use(express.static(publicDir));
app.use('/static', express.static(publicDir));

function isPathInside(baseDir: string, targetPath: string): boolean {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);
  return resolvedTarget.startsWith(resolvedBase + path.sep);
}

app.get('/static/report.html', (_req, res) => {
  const { runsDir } = getEnvSettings();
  const reportHtml = path.join(runsDir, 'report', 'index.html');
  if (!fs.existsSync(reportHtml)) {
    generateEvalMarkdownAndHtml('test');
  }
  res.sendFile(reportHtml);
});

app.get('/api/status', (_req, res) => {
  const env = getEnvSettings();
  const cfg = loadConfig();
  const medprepPath = path.resolve('./demo/medprep_card.md');
  const medprepText = fs.existsSync(medprepPath) ? fs.readFileSync(medprepPath, 'utf-8') : '';
  const frozenPath = path.resolve('./configs/FROZEN');
  const spend = readSpendLedger();

  res.json({
    gemini_configured: isGeminiConfigured(),
    config_version: cfg.version,
    frozen: fs.existsSync(frozenPath),
    frozen_sha256: fs.existsSync(frozenPath) ? fs.readFileSync(frozenPath, 'utf-8').trim() : null,
    spend_usd: spend.total_usd,
    max_usd: env.maxUsd,
    has_gold: fs.existsSync(path.join(env.dataDir, 'gold.jsonl')),
    has_splits: fs.existsSync(path.join(env.dataDir, 'splits.json')),
    medprep_card: medprepText,
  });
});

app.post(
  '/api/procedure',
  upload.single('file'),
  async (req, res) => {
    try {
      const preset = typeof req.body?.preset === 'string' ? req.body.preset : '';
      const rawText = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
      const uploaded = req.file;

      let compiled;
      if (preset === 'medprep') {
        const medprepPath = path.resolve('./demo/medprep_card.md');
        compiled = await compileProcedure({ filePath: medprepPath }, 'medprep', 'medprep_v1');
      } else if (uploaded) {
        const mime = uploaded.mimetype || 'application/octet-stream';
        const procId = `upload_${Date.now()}`;
        if (mime.startsWith('text/') || uploaded.originalname.endsWith('.md') || uploaded.originalname.endsWith('.txt')) {
          compiled = await compileProcedure(
            { text: fs.readFileSync(uploaded.path, 'utf-8') },
            'upload',
            procId,
          );
        } else {
          compiled = await compileProcedure(
            { fileBytes: fs.readFileSync(uploaded.path), mimeType: mime },
            'upload',
            procId,
          );
        }
      } else if (rawText) {
        const procId = `upload_${Date.now()}`;
        compiled = await compileProcedure({ text: rawText }, 'upload', procId);
      } else {
        return res.status(400).json({ error: 'Provide preset="medprep", text, or a file.' });
      }

      const session = await liveSessionManager.createSession(compiled.procedure);
      return res.json({
        session_id: session.session_id,
        procedure: session.procedure,
        alerts: session.alerts_map,
        step_states: session.step_states,
        compile_cost_usd: compiled.costUsd,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[/api/procedure] error:', err);
      return res.status(500).json({ error: msg });
    }
  },
);

app.post('/api/live/tick', async (req, res) => {
  try {
    const sessionId = String(req.body?.session_id ?? '');
    const frames = Array.isArray(req.body?.frames) ? (req.body.frames as string[]) : [];
    const tClient = typeof req.body?.t_client === 'number' ? req.body.t_client : null;

    if (!sessionId || frames.length === 0) {
      return res.status(400).json({ error: 'session_id and frames[] are required.' });
    }
    const out = await liveSessionManager.processTick(sessionId, frames.slice(-6), tClient);
    return res.json(out);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[/api/live/tick] error:', err);
    return res.status(500).json({ error: msg });
  }
});

app.post('/api/live/finish', async (req, res) => {
  try {
    const sessionId = String(req.body?.session_id ?? '');
    const stillB64 = String(req.body?.still_b64 ?? '');
    if (!sessionId || !stillB64) {
      return res.status(400).json({ error: 'session_id and still_b64 are required.' });
    }
    const report = await liveSessionManager.finishSession(sessionId, stillB64);
    return res.json(report);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[/api/live/finish] error:', err);
    return res.status(500).json({ error: msg });
  }
});

app.post(
  '/api/analyze',
  upload.fields([
    { name: 'video', maxCount: 1 },
    { name: 'procedure_file', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const files = req.files as Record<string, Express.Multer.File[]> | undefined;
      const videoFile = files?.video?.[0];
      if (!videoFile) {
        return res.status(400).json({ error: 'video file is required.' });
      }
      const procText = typeof req.body?.procedure_text === 'string' ? req.body.procedure_text.trim() : '';
      const procFile = files?.procedure_file?.[0];
      const useMedprep = req.body?.preset === 'medprep';
      const noCarbon = req.body?.no_carbon === 'true' || req.body?.no_carbon === true;
      const noLocalizer = req.body?.no_localizer === 'true' || req.body?.no_localizer === true;

      let procedureOrInput: string;
      let source: 'medprep' | 'upload' = 'upload';
      let procId: string | undefined;

      if (useMedprep) {
        procedureOrInput = path.resolve('./demo/medprep_card.md');
        source = 'medprep';
        procId = 'medprep_v1';
      } else if (procFile) {
        const ext = path.extname(procFile.originalname) || '.bin';
        const renamed = `${procFile.path}${ext}`;
        fs.renameSync(procFile.path, renamed);
        procedureOrInput = renamed;
      } else if (procText) {
        procedureOrInput = procText;
      } else {
        return res.status(400).json({ error: 'Provide procedure_text, procedure_file, or preset="medprep".' });
      }

      const vidExt = path.extname(videoFile.originalname) || '.mp4';
      const renamedVideo = `${videoFile.path}${vidExt}`;
      fs.renameSync(videoFile.path, renamedVideo);

      const out = await runPipeline(procedureOrInput, renamedVideo, {
        source,
        procedureId: procId,
        recordingId: path.basename(videoFile.originalname, vidExt),
        noCarbon,
        noLocalizer,
      });

      return res.json({
        result: out.result,
        procedure: out.procedure,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[/api/analyze] error:', err);
      return res.status(500).json({ error: msg });
    }
  },
);

app.get('/api/sessions', (_req, res) => {
  res.json({ sessions: liveSessionManager.listSessions(), field_labels: readFieldGold() });
});

app.get('/api/sessions/:id', (req, res) => {
  const sess = liveSessionManager.getSession(req.params.id);
  if (!sess) return res.status(404).json({ error: 'Session not found' });
  return res.json(sess);
});

app.get('/api/sessions/:id/frames/:tick/:file', (req, res) => {
  const { runsDir } = getEnvSettings();
  const safeId = req.params.id.replace(/[^a-zA-Z0-9._-]/g, '_');
  const safeTick = req.params.tick.replace(/[^a-zA-Z0-9._-]/g, '_');
  const safeFile = req.params.file.replace(/[^a-zA-Z0-9._-]/g, '_');
  const baseDir = path.join(runsDir, 'live', safeId);
  const target = path.join(baseDir, safeTick, safeFile);
  if (!isPathInside(baseDir, target) || !fs.existsSync(target)) {
    return res.status(404).json({ error: 'Frame not found' });
  }
  return res.sendFile(target);
});

app.get('/api/tts/:proc/:file', (req, res) => {
  const { runsDir } = getEnvSettings();
  const baseDir = path.join(runsDir, 'tts');
  const target = path.join(baseDir, req.params.proc, req.params.file);
  if (!isPathInside(baseDir, target) || !fs.existsSync(target)) {
    return res.status(404).json({ error: 'Audio not found' });
  }
  res.setHeader('Content-Type', 'audio/wav');
  return res.sendFile(target);
});

app.post('/api/field/label', (req, res) => {
  try {
    const body = req.body as FieldLabelRecord;
    if (!body?.session_id || !Array.isArray(body.steps)) {
      return res.status(400).json({ error: 'session_id and steps[] are required.' });
    }
    saveFieldLabel(body);
    return res.json({ saved: true, summary: scoreFieldRuns() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(400).json({ error: msg });
  }
});

app.get('/api/field/summary', (_req, res) => {
  res.json(scoreFieldRuns());
});

app.get('/api/report/data', (req, res) => {
  const split = req.query.split === 'dev' ? 'dev' : 'test';
  res.json(collectReportData(split));
});

app.post('/api/report/generate', (req, res) => {
  try {
    const split = req.body?.split === 'dev' ? 'dev' : 'test';
    const out = generateEvalMarkdownAndHtml(split);
    res.json({
      markdown_path: out.markdownPath,
      html_path: out.htmlPath,
      payload: out.payload,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

interface EvalJob {
  job_id: string;
  system: EvalSystem;
  split: 'dev' | 'test';
  limit?: number;
  status: 'running' | 'completed' | 'failed';
  started_at: string;
  finished_at?: string;
  runDir?: string;
  scores?: unknown;
  error?: string;
}

const evalJobs = new Map<string, EvalJob>();

app.post('/api/eval/run', async (req, res) => {
  try {
    const system = (req.body?.system || 'misstep') as EvalSystem;
    const split = req.body?.split === 'test' ? 'test' : 'dev';
    const limit = typeof req.body?.limit === 'number' ? req.body.limit : undefined;
    const isFinal = Boolean(req.body?.final);
    const out = await runEval({ system, split, limit, final: isFinal });
    res.json(out);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/eval/start', (req, res) => {
  const system = (req.body?.system || 'misstep') as EvalSystem;
  const split = req.body?.split === 'test' ? 'test' : 'dev';
  const limit = typeof req.body?.limit === 'number' ? req.body.limit : undefined;
  const isFinal = Boolean(req.body?.final);
  const jobId = `job_${system}_${split}_${Date.now()}`;
  const job: EvalJob = {
    job_id: jobId,
    system,
    split,
    limit,
    status: 'running',
    started_at: new Date().toISOString(),
  };
  evalJobs.set(jobId, job);

  runEval({ system, split, limit, final: isFinal })
    .then((out) => {
      job.status = 'completed';
      job.finished_at = new Date().toISOString();
      job.runDir = out.runDir;
      job.scores = out.scores;
    })
    .catch((err) => {
      job.status = 'failed';
      job.finished_at = new Date().toISOString();
      job.error = err instanceof Error ? err.message : String(err);
    });

  res.json(job);
});

app.get('/api/eval/jobs', (_req, res) => {
  res.json({ jobs: Array.from(evalJobs.values()) });
});

app.get('/api/eval/jobs/:id', (req, res) => {
  const job = evalJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  return res.json(job);
});

app.post('/api/debug/upload-check', async (req, res) => {
  const t0 = Date.now();
  try {
    const filePath = String(req.body?.filePath || '');
    const resolved = path.resolve(filePath);
    if (!isPathInside(process.cwd(), resolved) || !fs.existsSync(resolved)) {
      return res.status(400).json({ ok: false, error: 'Invalid filePath' });
    }
    const uri = await uploadFile(resolved, 'video/mp4');
    return res.json({ ok: true, uri, elapsed_s: Number(((Date.now() - t0) / 1000).toFixed(2)) });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      elapsed_s: Number(((Date.now() - t0) / 1000).toFixed(2)),
    });
  }
});

app.post('/api/agent/run', async (_req, res) => {
  try {
    const out = await runFailureAnalyst();
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/config/freeze', (req, res) => {
  try {
    const configPath = typeof req.body?.config_path === 'string' ? req.body.config_path : undefined;
    const out = freezeConfig(configPath);
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/stress/run', async (req, res) => {
  try {
    const limit = typeof req.body?.limit === 'number' ? req.body.limit : 6;
    const out = await runStressLadder(undefined, limit);
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/smoke', async (_req, res) => {
  try {
    const results = await runSmokeTests();
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Misstep server listening on http://${HOST}:${PORT}`);
});
server.requestTimeout = 0;
server.headersTimeout = 120_000;
server.keepAliveTimeout = 120_000;
