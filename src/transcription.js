const filenames = new Map([
  ['audio/webm', 'dictation.webm'],
  ['audio/ogg', 'dictation.ogg'],
  ['audio/mp4', 'dictation.m4a'],
  ['video/mp4', 'dictation.mp4'],
  ['video/webm', 'dictation.webm'],
]);

export const acceptsDictation = req => Boolean(req.is([...filenames.keys()]));

export function createTranscription(readSettings, fetcher) {
  return async function transcribe(req, res) {
    const filename = filenames.get(req.is([...filenames.keys()]));
    if (!filename || !Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ message: 'Запись пуста или имеет неподдерживаемый формат.' });
    }

    const { key } = await readSettings();
    if (!key) return res.status(503).json({ message: 'Добавьте ключ OpenAI в админке для распознавания речи.' });

    const body = new FormData();
    body.set('file', new Blob([req.body]), filename);
    body.set('model', 'gpt-4o-mini-transcribe');
    body.set('language', 'ru');
    body.set('prompt', 'Диктовка для мастерской по ремонту компьютеров. Сохраняйте слова говорящего и записывайте русские слова кириллицей.');
    const disconnect = new AbortController();
    const onClose = () => disconnect.abort();
    res.once('close', onClose);
    if (res.destroyed) disconnect.abort();

    try {
      const response = await fetcher('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body,
        signal: AbortSignal.any([disconnect.signal, AbortSignal.timeout(40_000)]),
      });
      const result = await response.json();
      if (!response.ok) {
        const message = response.status === 401 ? 'OpenAI отклонил ключ. Проверьте его в админке.' :
          result.error?.code === 'unsupported_country_region_territory' ? 'OpenAI API недоступен из текущего региона сети.' :
          response.status === 429 ? 'OpenAI ограничил распознавание. Проверьте лимит и баланс проекта.' :
          'OpenAI не смог расшифровать запись. Попробуйте ещё раз.';
        return res.status(502).json({ message });
      }

      const text = typeof result.text === 'string' ? result.text.trim() : '';
      if (!text) return res.status(422).json({ message: 'Речь не распознана. Попробуйте ещё раз.' });
      res.json({ text });
    } catch {
      if (!disconnect.signal.aborted) {
        res.status(502).json({ message: 'Не удалось получить расшифровку от OpenAI. Попробуйте ещё раз.' });
      }
    } finally {
      res.off('close', onClose);
    }
  };
}
