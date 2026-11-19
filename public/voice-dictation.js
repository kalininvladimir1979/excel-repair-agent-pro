const maxRecording = 60_000;
const mimeTypes = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];
const quiet = 'Речь не слышна. Попробуйте ещё раз.';

function appendDictation(draft, transcript, limit) {
  const text = transcript.trim();
  const separator = draft && !/\s$/.test(draft) ? ' ' : '';
  const room = Math.max(0, limit - draft.length - separator.length);
  const fragment = text.slice(0, room).replace(/[\uD800-\uDBFF]$/u, '').trimEnd();
  return {
    value: fragment ? draft + separator + fragment : draft,
    truncated: fragment.length < text.length,
  };
}

async function requestTranscript(audio, signal) {
  let response;
  try {
    response = await fetch('/api/dictation', { method: 'POST', body: audio, signal });
  } catch {
    throw new Error('Связь с приложением прервалась. Попробуйте ещё раз.');
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || 'Не удалось распознать запись.');
  return typeof result.text === 'string' ? result.text.trim() : '';
}

export function bindVoiceDictation({ input, button, cancelButton, timer, meter, status, onPhase }) {
  const controls = button.closest('.voice-controls');
  const segments = [...meter.children];
  let phase = 'idle';
  let recording;
  let announcement;

  function display(next, message = '', error = false) {
    phase = next;
    controls.dataset.phase = phase;
    timer.hidden = meter.hidden = phase !== 'recording';
    cancelButton.hidden = phase === 'idle';
    button.disabled = phase === 'starting' || phase === 'transcribing';
    button.setAttribute('aria-label', phase === 'recording' ? 'Остановить запись' : 'Начать диктовку');
    button.setAttribute('aria-pressed', String(phase === 'recording'));
    clearTimeout(announcement);
    status.classList.toggle('error', error);
    status.textContent = message;
    if (phase === 'idle' && !error && message) {
      announcement = setTimeout(() => { status.textContent = ''; }, 5000);
    }
    onPhase(phase);
  }

  function release(job) {
    clearTimeout(job.deadline);
    cancelAnimationFrame(job.frame);
    job.stream?.getTracks().forEach(track => track.stop());
    job.stream = null;
    void job.context?.close().catch(() => {});
    job.context = null;
    segments.forEach(segment => segment.classList.remove('lit'));
  }

  function finish(message = '', error = false) {
    const job = recording;
    recording = undefined;
    if (job) {
      job.abort.abort();
      if (job.recorder) {
        job.recorder.onstop = job.recorder.onerror = job.recorder.ondataavailable = null;
        if (job.recorder.state !== 'inactive') job.recorder.stop();
      }
      release(job);
    }
    const restoreFocus = document.activeElement === cancelButton || document.activeElement === document.body;
    display('idle', message, error);
    if (restoreFocus) button.focus();
  }

  function meterSource(job) {
    if (!job.context) return null;
    try {
      const analyser = job.context.createAnalyser();
      const source = job.context.createMediaStreamSource(job.stream);
      const sink = job.context.createGain();
      sink.gain.value = 0;
      source.connect(analyser);
      analyser.connect(sink);
      sink.connect(job.context.destination);
      analyser.fftSize = 512;
      return analyser;
    } catch {
      return null;
    }
  }

  function monitor(job) {
    const analyser = meterSource(job);
    const samples = analyser && new Float32Array(analyser.fftSize);
    const started = performance.now();
    job.hasMeter = Boolean(analyser);
    function measure(now) {
      if (recording !== job || phase !== 'recording') return;
      const seconds = Math.floor((now - started) / 1000);
      const time = [Math.floor(seconds / 60), seconds % 60].map(value => String(value).padStart(2, '0')).join(':');
      if (timer.textContent !== time) timer.textContent = time;
      let rms = 0;
      if (analyser) {
        analyser.getFloatTimeDomainData(samples);
        rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
        job.heard ||= rms > 0.004;
      }
      const active = Math.min(segments.length, Math.max(1, Math.round(rms * 140)));
      segments.forEach((segment, index) => segment.classList.toggle('lit', index < active));
      job.frame = requestAnimationFrame(measure);
    }
    measure(started);
  }

  function stop(afterTranscript) {
    if (phase !== 'recording' || recording.recorder.state === 'inactive') return false;
    recording.afterTranscript = afterTranscript;
    display('transcribing', 'Распознаю речь…');
    recording.recorder.stop();
    return true;
  }

  async function receive(job) {
    release(job);
    if (recording !== job) return;
    if (phase !== 'transcribing') return finish('Запись прервалась. Проверьте микрофон.', true);
    const audio = new Blob(job.chunks, { type: job.recorder.mimeType || job.chunks[0]?.type });
    job.chunks.length = 0;
    if (!audio.size || (job.hasMeter && !job.heard)) return finish(quiet, true);

    try {
      const text = await requestTranscript(audio, job.abort.signal);
      if (recording !== job) return;
      if (!text) return finish('Речь не распознана. Попробуйте ещё раз.', true);
      const draft = appendDictation(input.value, text, input.maxLength);
      if (input.value === draft.value) return finish('В поле нет места для текста диктовки.', true);
      input.value = draft.value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const restoreFocus = [document.body, button, cancelButton].includes(document.activeElement);
      const send = !draft.truncated && job.afterTranscript;
      finish(send ? '' : draft.truncated ? 'Текст добавлен до предела поля.' : 'Текст добавлен в черновик.');
      if (restoreFocus) input.focus();
      if (send) send();
    } catch (error) {
      if (recording === job) finish(error.message || 'Не удалось распознать речь.', true);
    }
  }

  async function start() {
    if (phase !== 'idle') return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      display('idle', 'Диктовка недоступна. Откройте приложение на локальном адресе в браузере с поддержкой микрофона.', true);
      return;
    }
    const job = { abort: new AbortController(), chunks: [] };
    recording = job;
    display('starting', 'Ожидаю доступ к микрофону…');
    try {
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (Audio) {
        try {
          job.context = new Audio();
          void job.context.resume().catch(() => {});
        } catch {
          job.context = null;
        }
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (recording !== job) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      job.stream = stream;
      const mimeType = mimeTypes.find(type => MediaRecorder.isTypeSupported(type));
      job.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      job.recorder.ondataavailable = event => { if (event.data.size) job.chunks.push(event.data); };
      job.recorder.onstop = () => void receive(job);
      job.recorder.onerror = () => finish('Запись прервалась. Проверьте микрофон.', true);
      job.recorder.start();
      job.deadline = setTimeout(stop, maxRecording);
      display('recording', 'Идёт запись');
      monitor(job);
    } catch (error) {
      if (recording !== job) return;
      const message = ['NotAllowedError', 'SecurityError'].includes(error.name) ?
        'Разрешите доступ к микрофону в настройках браузера.' :
        'Не удалось включить микрофон. Проверьте, что он подключён и доступен.';
      finish(message, true);
    }
  }

  button.addEventListener('click', () => phase === 'recording' ? stop() : void start());
  cancelButton.addEventListener('click', () => finish('Диктовка отменена.'));
  input.form.addEventListener('keydown', event => {
    if (event.key === 'Escape' && phase !== 'idle') {
      event.preventDefault();
      finish('Диктовка отменена.');
    }
  });
  window.addEventListener('pagehide', () => { if (recording) finish(); });

  return { stop, cancel: () => { if (recording) finish('Диктовка отменена.'); } };
}
