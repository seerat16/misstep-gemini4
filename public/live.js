const webcamVideo = document.getElementById('webcamVideo');
const captureCanvas = document.getElementById('captureCanvas');
const statusLine = document.getElementById('statusLine');
const latencyReadout = document.getElementById('latencyReadout');
const costReadout = document.getElementById('costReadout');
const tickReadout = document.getElementById('tickReadout');
const liveError = document.getElementById('liveError');
const liveAlertBanner = document.getElementById('liveAlertBanner');
const stepBoard = document.getElementById('stepBoard');
const sessionMeta = document.getElementById('sessionMeta');
const finalReportPanel = document.getElementById('finalReportPanel');
const compartmentSummary = document.getElementById('compartmentSummary');
const compartmentTableWrap = document.getElementById('compartmentTableWrap');
const alertTimeline = document.getElementById('alertTimeline');

const loadMedprepLiveBtn = document.getElementById('loadMedprepLiveBtn');
const compileLiveBtn = document.getElementById('compileLiveBtn');
const liveProcText = document.getElementById('liveProcText');
const liveProcFile = document.getElementById('liveProcFile');
const startBtn = document.getElementById('startBtn');
const finishBtn = document.getElementById('finishBtn');
const record60Btn = document.getElementById('record60Btn');
const fallbackVideoFile = document.getElementById('fallbackVideoFile');
const uploadFallbackBtn = document.getElementById('uploadFallbackBtn');
const resetBtn = document.getElementById('resetBtn');

let mediaStream = null;
let sessionId = null;
let currentProcedure = null;
let currentStepStates = [];
let frameBuffer = [];
let frameTimer = null;
let tickTimer = null;
let tickInFlight = false;
let tickCount = 0;
let audioQueue = [];
let audioPlaying = false;
let audioUnlocked = false;
let mediaRecorder = null;
let recordedChunks = [];
let recordCountdownTimer = null;
let recordSecondsLeft = 60;

function showError(msg) {
  liveError.textContent = msg;
  liveError.hidden = !msg;
}

function createEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

async function ensureCamera() {
  if (mediaStream) return mediaStream;
  mediaStream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 } },
    audio: false,
  });
  webcamVideo.srcObject = mediaStream;
  await webcamVideo.play();
  return mediaStream;
}

function grabFrameBase64(widthPx = 640) {
  if (!webcamVideo.videoWidth || !webcamVideo.videoHeight) return null;
  const scale = widthPx / webcamVideo.videoWidth;
  captureCanvas.width = widthPx;
  captureCanvas.height = Math.round(webcamVideo.videoHeight * scale);
  const ctx = captureCanvas.getContext('2d');
  ctx.drawImage(webcamVideo, 0, 0, captureCanvas.width, captureCanvas.height);
  return captureCanvas.toDataURL('image/jpeg', 0.82);
}

function grabFullResStillBase64() {
  const w = webcamVideo.videoWidth || 1280;
  const h = webcamVideo.videoHeight || 720;
  captureCanvas.width = w;
  captureCanvas.height = h;
  const ctx = captureCanvas.getContext('2d');
  ctx.drawImage(webcamVideo, 0, 0, w, h);
  return captureCanvas.toDataURL('image/jpeg', 0.92);
}

function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      const ctx = new AudioCtx();
      if (ctx.state === 'suspended') ctx.resume();
    }
  } catch {
    // ignore
  }
}

function enqueueAlertAudio(alert) {
  liveAlertBanner.textContent = `ALERT: ${alert.text} (${alert.reason})`;
  liveAlertBanner.hidden = false;
  audioQueue.push(alert);
  drainAudioQueue();
}

function drainAudioQueue() {
  if (audioPlaying || audioQueue.length === 0) return;
  const next = audioQueue.shift();
  audioPlaying = true;

  if (next.url) {
    const audio = new Audio(next.url);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      audioPlaying = false;
      drainAudioQueue();
    };
    const guard = setTimeout(finish, 10000);
    audio.onended = () => {
      clearTimeout(guard);
      finish();
    };
    audio.onerror = () => {
      clearTimeout(guard);
      if (!settled) {
        settled = true;
        speakFallback(next.text);
      }
    };
    audio.play().catch(() => {
      clearTimeout(guard);
      if (!settled) {
        settled = true;
        speakFallback(next.text);
      }
    });
  } else {
    speakFallback(next.text);
  }
}

function speakFallback(text) {
  if ('speechSynthesis' in window) {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      audioPlaying = false;
      drainAudioQueue();
    };
    const guard = setTimeout(finish, 8000);
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = 1.02;
      utter.onend = () => {
        clearTimeout(guard);
        finish();
      };
      utter.onerror = () => {
        clearTimeout(guard);
        finish();
      };
      window.speechSynthesis.speak(utter);
    } catch {
      clearTimeout(guard);
      finish();
    }
  } else {
    audioPlaying = false;
    drainAudioQueue();
  }
}

function renderStepBoard(states) {
  currentStepStates = states;
  const doneCount = states.filter((s) => s.status === 'done').length;
  const nextIdx = states.findIndex((s) => s.status !== 'done');
  const activeStepNum = nextIdx >= 0 ? nextIdx + 1 : states.length;
  statusLine.textContent =
    states.length > 0
      ? `Step ${activeStepNum} of ${states.length} · ${doneCount} completed`
      : 'Ready';

  stepBoard.replaceChildren();
  for (const st of states) {
    const card = createEl('div', `step-card status-${st.status}`);
    const head = createEl('div', 'step-card-head');
    head.appendChild(createEl('span', 'step-title', `${st.step_num}. ${st.text}`));
    const badge = st.late ? `${st.status.toUpperCase()} (LATE)` : st.status.toUpperCase().replace('_', ' ');
    head.appendChild(createEl('span', 'state-label', badge));
    card.appendChild(head);

    const meta = createEl('div', 'step-meta mono');
    meta.appendChild(createEl('span', '', `P(doing)=${Number(st.p_doing || 0).toFixed(2)}`));
    meta.appendChild(createEl('span', '', `P(done)=${Number(st.p_done || 0).toFixed(2)}`));
    if (st.done_t_s !== null && st.done_t_s !== undefined) {
      meta.appendChild(createEl('span', '', `Done @ ${st.done_t_s}s`));
    }
    card.appendChild(meta);
    stepBoard.appendChild(card);
  }
}

async function initSessionWithFormData(fd) {
  showError('');
  finalReportPanel.hidden = true;
  liveAlertBanner.hidden = true;
  loadMedprepLiveBtn.disabled = true;
  compileLiveBtn.disabled = true;
  sessionMeta.textContent = 'Compiling procedure and pre-generating alert audio...';

  try {
    const res = await fetch('/api/procedure', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to compile procedure');

    sessionId = data.session_id;
    currentProcedure = data.procedure;
    tickCount = 0;
    tickReadout.textContent = '0 · 0/6';
    renderStepBoard(data.step_states || []);
    costReadout.textContent = `$${Number(data.compile_cost_usd || 0).toFixed(4)}`;
    sessionMeta.textContent = `Session ${sessionId} · ${currentProcedure.title} (${currentProcedure.steps.length} steps)`;
    startBtn.disabled = false;
    finishBtn.disabled = false;
    record60Btn.disabled = false;
    uploadFallbackBtn.disabled = false;
  } catch (err) {
    showError(err.message);
    sessionMeta.textContent = 'Procedure load failed.';
  } finally {
    loadMedprepLiveBtn.disabled = false;
    compileLiveBtn.disabled = false;
  }
}

loadMedprepLiveBtn.addEventListener('click', () => {
  const fd = new FormData();
  fd.append('preset', 'medprep');
  initSessionWithFormData(fd);
});

compileLiveBtn.addEventListener('click', () => {
  const fd = new FormData();
  if (liveProcFile.files && liveProcFile.files[0]) {
    fd.append('file', liveProcFile.files[0]);
  } else if (liveProcText.value.trim()) {
    fd.append('text', liveProcText.value.trim());
  } else {
    showError('Enter procedure text or choose a file first.');
    return;
  }
  initSessionWithFormData(fd);
});

function stopLoops() {
  if (frameTimer) {
    clearInterval(frameTimer);
    frameTimer = null;
  }
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  if (recordCountdownTimer) {
    clearInterval(recordCountdownTimer);
    recordCountdownTimer = null;
  }
}

async function sendTick() {
  if (!sessionId || tickInFlight || frameBuffer.length === 0) return;
  tickInFlight = true;
  const framesToSend = frameBuffer.slice(-6);
  try {
    const res = await fetch('/api/live/tick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        frames: framesToSend,
        t_client: Date.now(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Tick failed');
    tickCount += 1;
    renderStepBoard(data.step_states || []);
    latencyReadout.textContent = `${data.latency_ms} ms`;
    costReadout.textContent = `$${Number(data.total_cost_usd || 0).toFixed(4)}`;
    tickReadout.textContent = `${tickCount} · ${frameBuffer.length}/6`;
    for (const alert of data.alerts_to_play || []) {
      enqueueAlertAudio(alert);
    }
  } catch (err) {
    showError(err.message);
  } finally {
    tickInFlight = false;
  }
}

startBtn.addEventListener('click', async () => {
  showError('');
  if (!sessionId) return;
  unlockAudio();
  try {
    await ensureCamera();
    stopLoops();
    frameBuffer = [];
    tickCount = 0;
    frameTimer = setInterval(() => {
      const f = grabFrameBase64(640);
      if (f) {
        frameBuffer.push(f);
        if (frameBuffer.length > 6) frameBuffer.shift();
        tickReadout.textContent = `${tickCount} · ${frameBuffer.length}/6`;
      }
    }, 500);
    tickTimer = setInterval(sendTick, 2000);
    startBtn.disabled = true;
    sessionMeta.textContent = `LIVE ACTIVE · Session ${sessionId}`;
  } catch (err) {
    showError(`Camera access failed: ${err.message}`);
  }
});

finishBtn.addEventListener('click', async () => {
  showError('');
  if (!sessionId) return;
  stopLoops();
  finishBtn.disabled = true;
  try {
    await ensureCamera();
    const stillB64 = grabFullResStillBase64();
    sessionMeta.textContent = 'Running final ultra-high-res compartment verification...';
    const res = await fetch('/api/live/finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, still_b64: stillB64 }),
    });
    const report = await res.json();
    if (!res.ok) throw new Error(report.error || 'Finish verification failed');

    finalReportPanel.hidden = false;
    compartmentSummary.textContent = report.all_compartments_match
      ? `ALL COMPARTMENTS VERIFIED MATCHING · Median tick latency: ${report.median_tick_latency_ms} ms · Total cost: $${Number(report.total_cost_usd).toFixed(4)}`
      : `MISMATCH DETECTED IN ORGANIZER · Median tick latency: ${report.median_tick_latency_ms} ms · Total cost: $${Number(report.total_cost_usd).toFixed(4)}`;

    const tbl = createEl('table');
    const thead = createEl('thead');
    const hr = createEl('tr');
    for (const h of ['Day', 'Color', 'Expected', 'Decisions', 'Final', 'Decided By', 'Status']) {
      hr.appendChild(createEl('th', '', h));
    }
    thead.appendChild(hr);
    tbl.appendChild(thead);

    const tbody = createEl('tbody');
    for (const c of report.compartments || []) {
      const tr = createEl('tr');
      tr.appendChild(createEl('td', 'mono', c.day));
      tr.appendChild(createEl('td', 'mono', c.color));
      tr.appendChild(createEl('td', 'mono', c.expected));
      tr.appendChild(
        createEl('td', 'mono', `${c.decisions_choice} (${Number(c.decisions_confidence).toFixed(2)})`),
      );
      tr.appendChild(createEl('td', 'mono', c.final_choice));
      tr.appendChild(createEl('td', 'mono', c.decided_by));
      tr.appendChild(createEl('td', 'mono', c.match ? 'MATCH' : 'MISMATCH'));
      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody);
    compartmentTableWrap.replaceChildren(tbl);

    alertTimeline.replaceChildren();
    if (!report.alerts || report.alerts.length === 0) {
      alertTimeline.appendChild(createEl('p', 'muted', 'Zero alerts triggered during this run.'));
    } else {
      for (const a of report.alerts) {
        alertTimeline.appendChild(
          createEl('div', 'step-card status-skipped', `[t=${a.t_s}s, tick ${a.tick}] ${a.text} — ${a.reason}`),
        );
      }
    }
    sessionMeta.textContent = `Finished · Session ${sessionId}`;
  } catch (err) {
    showError(err.message);
  } finally {
    finishBtn.disabled = false;
  }
});

async function runAnalyzeFallback(videoBlobOrFile, filename) {
  const fd = new FormData();
  fd.append('video', videoBlobOrFile, filename);
  if (currentProcedure && currentProcedure.source === 'medprep') {
    fd.append('preset', 'medprep');
  } else {
    fd.append(
      'procedure_text',
      currentProcedure.steps.map((s, i) => `${i + 1}. ${s.text}`).join('\n'),
    );
  }
  sessionMeta.textContent = 'Analyzing recorded/uploaded video via /api/analyze...';
  const res = await fetch('/api/analyze', { method: 'POST', body: fd });
  const data = await res.json();
  if (!res.ok) {
    showError(data.error || 'Fallback analyze failed');
    return;
  }

  const verdicts = data.result.verdicts || [];
  renderStepBoard(
    verdicts.map((v, i) => ({
      step_id: v.step_id,
      step_num: i + 1,
      text: currentProcedure.steps[i]?.text || v.step_id,
      status: v.status === 'error' ? 'skipped' : v.status === 'ok' ? 'done' : 'pending',
      late: false,
      p_doing: 0,
      p_done: 1 - v.p_error,
    })),
  );
  costReadout.textContent = `$${Number(data.result.cost_usd || 0).toFixed(4)}`;
  latencyReadout.textContent = `${Math.round((data.result.latency_s || 0) * 1000)} ms`;
  const firstErr = verdicts.find((v) => v.status === 'error');
  if (firstErr) {
    enqueueAlertAudio({
      text: `Detected ${firstErr.categories?.join(', ') || 'error'} on step ${firstErr.step_id}.`,
      reason: firstErr.evidence?.[0]?.text || 'offline fallback',
      url: null,
    });
  }
  sessionMeta.textContent = `Fallback analysis complete · ${verdicts.filter((v) => v.status === 'error').length} error(s) · cost $${Number(data.result.cost_usd).toFixed(4)}`;
}

// Fallback: Record up to 60s clip then run /api/analyze
record60Btn.addEventListener('click', async () => {
  showError('');
  if (!currentProcedure) return;
  unlockAudio();
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    if (recordCountdownTimer) {
      clearInterval(recordCountdownTimer);
      recordCountdownTimer = null;
    }
    mediaRecorder.stop();
    record60Btn.textContent = 'Record 60s & Analyze';
    return;
  }
  try {
    stopLoops();
    const stream = await ensureCamera();
    recordedChunks = [];
    const preferredMime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
      ? 'video/webm;codecs=vp8'
      : MediaRecorder.isTypeSupported('video/webm')
        ? 'video/webm'
        : '';
    mediaRecorder = preferredMime ? new MediaRecorder(stream, { mimeType: preferredMime }) : new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };
    mediaRecorder.onstop = async () => {
      if (recordCountdownTimer) {
        clearInterval(recordCountdownTimer);
        recordCountdownTimer = null;
      }
      record60Btn.textContent = 'Record 60s & Analyze';
      const blob = new Blob(recordedChunks, { type: preferredMime || 'video/webm' });
      await runAnalyzeFallback(blob, 'live_fallback.webm');
    };
    recordSecondsLeft = 60;
    mediaRecorder.start();
    record60Btn.textContent = `Stop & Analyze (${recordSecondsLeft}s)`;
    sessionMeta.textContent = 'Recording 60s fallback clip... click Stop & Analyze anytime.';
    recordCountdownTimer = setInterval(() => {
      recordSecondsLeft -= 1;
      if (recordSecondsLeft <= 0) {
        clearInterval(recordCountdownTimer);
        recordCountdownTimer = null;
        if (mediaRecorder && mediaRecorder.state === 'recording') {
          mediaRecorder.stop();
        }
      } else {
        record60Btn.textContent = `Stop & Analyze (${recordSecondsLeft}s)`;
      }
    }, 1000);
  } catch (err) {
    showError(err.message);
  }
});

uploadFallbackBtn.addEventListener('click', async () => {
  showError('');
  if (!currentProcedure) return;
  const file = fallbackVideoFile.files && fallbackVideoFile.files[0];
  if (!file) {
    showError('Choose a video file to analyze first.');
    return;
  }
  unlockAudio();
  uploadFallbackBtn.disabled = true;
  try {
    await runAnalyzeFallback(file, file.name || 'upload.mp4');
  } catch (err) {
    showError(err.message);
  } finally {
    uploadFallbackBtn.disabled = false;
  }
});

resetBtn.addEventListener('click', () => {
  stopLoops();
  frameBuffer = [];
  audioQueue = [];
  tickCount = 0;
  sessionId = null;
  currentProcedure = null;
  statusLine.textContent = 'Step 0 of 0 · Ready';
  latencyReadout.textContent = '0 ms';
  costReadout.textContent = '$0.000';
  tickReadout.textContent = '0 · 0/6';
  liveAlertBanner.hidden = true;
  finalReportPanel.hidden = true;
  stepBoard.replaceChildren(createEl('p', 'muted', 'Compile a procedure or load MedPrep to populate steps.'));
  startBtn.disabled = true;
  finishBtn.disabled = true;
  record60Btn.disabled = true;
  uploadFallbackBtn.disabled = true;
  record60Btn.textContent = 'Record 60s & Analyze';
  sessionMeta.textContent = 'Reset complete.';
  showError('');
});
