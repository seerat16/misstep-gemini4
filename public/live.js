const webcamVideo = document.getElementById('webcamVideo');
const captureCanvas = document.getElementById('captureCanvas');
const statusLine = document.getElementById('statusLine');
const latencyReadout = document.getElementById('latencyReadout');
const costReadout = document.getElementById('costReadout');
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
const resetBtn = document.getElementById('resetBtn');

let mediaStream = null;
let sessionId = null;
let currentProcedure = null;
let currentStepStates = [];
let frameBuffer = [];
let frameTimer = null;
let tickTimer = null;
let tickInFlight = false;
let audioQueue = [];
let audioPlaying = false;
let mediaRecorder = null;
let recordedChunks = [];

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
    audio.onended = () => {
      audioPlaying = false;
      drainAudioQueue();
    };
    audio.onerror = () => {
      speakFallback(next.text);
    };
    audio.play().catch(() => {
      speakFallback(next.text);
    });
  } else {
    speakFallback(next.text);
  }
}

function speakFallback(text) {
  if ('speechSynthesis' in window) {
    const utter = new SpeechSynthesisUtterance(text);
    utter.onend = () => {
      audioPlaying = false;
      drainAudioQueue();
    };
    utter.onerror = () => {
      audioPlaying = false;
      drainAudioQueue();
    };
    window.speechSynthesis.speak(utter);
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
    renderStepBoard(data.step_states || []);
    costReadout.textContent = `$${Number(data.compile_cost_usd || 0).toFixed(4)}`;
    sessionMeta.textContent = `Session ${sessionId} · ${currentProcedure.title} (${currentProcedure.steps.length} steps)`;
    startBtn.disabled = false;
    finishBtn.disabled = false;
    record60Btn.disabled = false;
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
    renderStepBoard(data.step_states || []);
    latencyReadout.textContent = `${data.latency_ms} ms`;
    costReadout.textContent = `$${Number(data.total_cost_usd || 0).toFixed(4)}`;
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
  try {
    await ensureCamera();
    stopLoops();
    frameBuffer = [];
    frameTimer = setInterval(() => {
      const f = grabFrameBase64(640);
      if (f) {
        frameBuffer.push(f);
        if (frameBuffer.length > 6) frameBuffer.shift();
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

// Fallback: Record clip then run /api/analyze
record60Btn.addEventListener('click', async () => {
  showError('');
  if (!currentProcedure) return;
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    record60Btn.textContent = 'Record & Analyze (Fallback)';
    return;
  }
  try {
    const stream = await ensureCamera();
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };
    mediaRecorder.onstop = async () => {
      const blob = new Blob(recordedChunks, { type: 'video/webm' });
      const fd = new FormData();
      fd.append('video', blob, 'live_fallback.webm');
      fd.append('procedure_text', currentProcedure.steps.map((s, i) => `${i + 1}. ${s.text}`).join('\n'));
      sessionMeta.textContent = 'Analyzing recorded clip via /api/analyze...';
      const res = await fetch('/api/analyze', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) {
        showError(data.error || 'Fallback analyze failed');
        return;
      }
      renderStepBoard(
        (data.result.verdicts || []).map((v, i) => ({
          step_id: v.step_id,
          step_num: i + 1,
          text: currentProcedure.steps[i]?.text || v.step_id,
          status: v.status === 'error' ? 'skipped' : v.status === 'ok' ? 'done' : 'pending',
          late: false,
          p_doing: 0,
          p_done: 1 - v.p_error,
        })),
      );
      sessionMeta.textContent = `Fallback analysis complete · cost $${Number(data.result.cost_usd).toFixed(4)}`;
    };
    mediaRecorder.start();
    record60Btn.textContent = 'Stop Recording & Analyze';
    sessionMeta.textContent = 'Recording fallback video... click Stop Recording & Analyze when done.';
  } catch (err) {
    showError(err.message);
  }
});

resetBtn.addEventListener('click', () => {
  stopLoops();
  frameBuffer = [];
  audioQueue = [];
  sessionId = null;
  currentProcedure = null;
  statusLine.textContent = 'Step 0 of 0 · Ready';
  latencyReadout.textContent = '0 ms';
  costReadout.textContent = '$0.000';
  liveAlertBanner.hidden = true;
  finalReportPanel.hidden = true;
  stepBoard.replaceChildren(createEl('p', 'muted', 'Compile a procedure or load MedPrep to populate steps.'));
  startBtn.disabled = true;
  finishBtn.disabled = true;
  record60Btn.disabled = true;
  sessionMeta.textContent = 'Reset complete.';
  showError('');
});
