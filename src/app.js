import express from 'express';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { access, mkdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path';
import { createAgent } from './agent.js';
import { createMcp, mcpVersion, serialQueue } from './mcp.js';
import { createSettings, validKey, validModel } from './settings.js';
import { acceptsDictation, createTranscription } from './transcription.js';
import { createWorkbook, filename, sheet } from './workbook.js';
import { workbookDesktopAction } from './workbook-desktop.js';

const root = new URL('../', import.meta.url);
const staticPath = fileURLToPath(new URL('public/', root));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const localHost = /^(?:127\.0\.0\.1|localhost)(?::[0-9]+)?$/i;
const cookie = 'repair_session';
const fontPackages = { inter: 'inter', oswald: 'oswald' };

export async function createApp({
  directory = fileURLToPath(new URL('data/', root)),
  mcp = createMcp(directory), env = process.env, fetcher = fetch,
} = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const app = express();
  app.disable('x-powered-by');
  const withWorkbook = serialQueue();
  const settings = createSettings(directory, env);
  const defaultBookPath = resolve(directory, filename);
  const configuredBookPath = (await settings.resolve()).workbookPath;
  function connectBook(path, transport = createMcp(dirname(path))) {
    return { path, transport, book: createWorkbook(transport, basename(path)), version: randomUUID() };
  }
  let active = configuredBookPath && configuredBookPath !== defaultBookPath ?
    connectBook(configuredBookPath) : connectBook(defaultBookPath, mcp);
  const workbookInfo = () => ({ path: active.path, filename: basename(active.path), version: active.version });
  const changedBook = 'Рабочая книга изменилась. Проверьте реестр и повторите команду.';
  const agent = createAgent(settings.resolve, fetcher);
  const sessions = new Map();

  const dictationPath = /^\/api\/dictation\/?$/i;
  app.use((req, res, next) => {
    const host = req.get('host') ?? '';
    if (!localHost.test(host)) return res.status(403).json({ message: 'Приложение доступно через локальный адрес.' });
    const isDictation = req.method === 'POST' && dictationPath.test(req.path);
    if (!['GET', 'HEAD'].includes(req.method) &&
        ((req.get('origin') && req.get('origin') !== `http://${host}`) ||
         req.get('sec-fetch-site') === 'cross-site' || !(isDictation ? acceptsDictation(req) : req.is('application/json')))) {
      return res.status(403).json({ message: 'Запрос должен прийти с локальной страницы приложения в поддерживаемом формате.' });
    }
    res.set({
      'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!/^\/(?:requests\/?$|chat\/?$|status-confirmations\/)/i.test(req.path)) return next();
    const token = req.get('cookie')?.match(new RegExp(`(?:^|;\\s*)${cookie}=([a-f0-9-]+)(?:;|$)`))?.[1];
    let session = token && sessions.get(token);
    if (!session) {
      const id = randomUUID();
      session = { history: [], draft: null, chat: new Map(), confirmations: new Map() };
      sessions.set(id, session);
      res.cookie(cookie, id, { httpOnly: true, sameSite: 'strict', path: '/' });
    }
    req.session = session;
    next();
  });

  const context = (label, id = randomUUID()) => ({ label, id, log: [] });
  async function operation(ctx, work) {
    try {
      return { ...await work(), operation: ctx };
    } catch (error) {
      return { kind: 'error', message: error.message, operation: ctx };
    }
  }

  app.post('/api/workbook/open', (req, res) => workbookDesktopAction(active.path, false)(req, res));
  app.post('/api/workbook/reveal', (req, res) => workbookDesktopAction(active.path, true)(req, res));

  app.get('/api/requests', async (_req, res) => {
    const ctx = context('Обновление таблицы');
    const result = await withWorkbook(async () => ({
      ...await operation(ctx, async () => ({ table: await active.book.readAll(ctx) })),
      workbook: workbookInfo(),
    }));
    res.status(result.kind === 'error' ? 503 : 200).json(result);
  });

  app.post('/api/chat', async (req, res) => {
    const { message, submissionId, workbookVersion } = req.body ?? {};
    if (typeof message !== 'string' || !message.trim() || message.length > 4000 ||
        typeof submissionId !== 'string' || !uuid.test(submissionId)) {
      return res.status(400).json({ message: 'Введите сообщение до 4000 символов и укажите UUID отправки.' });
    }
    const text = message.trim();
    const session = req.session;
    const version = workbookVersion ?? active.version;
    const previous = session.chat.get(submissionId);
    if (version !== active.version || (previous && previous.version !== version)) {
      return res.status(409).json({ kind: 'error', message: changedBook, workbookChanged: true });
    }
    if (previous && previous.message !== text) {
      return res.status(409).json({ message: 'Этот идентификатор уже использован для другого сообщения.' });
    }
    if (!previous) {
      const ctx = context(text, submissionId);
      const pending = withWorkbook(() => operation(ctx, () => {
        if (version !== active.version) return { kind: 'error', message: changedBook, workbookChanged: true };
        return agent(active.book, session, ctx, text);
      }));
      session.chat.set(submissionId, { message: text, pending, version });
    }
    res.json(await session.chat.get(submissionId).pending);
  });

  app.post('/api/status-confirmations/:id', async (req, res) => {
    const { action } = req.body ?? {};
    const { id } = req.params;
    if (action !== 'confirm' && action !== 'cancel') {
      return res.status(400).json({ message: 'Укажите действие confirm или cancel.' });
    }
    const confirmation = req.session.confirmations.get(id);
    if (!confirmation) return res.status(404).json({ kind: 'expired', message: 'Подтверждение недоступно. Запросите изменение заново.' });
    if (confirmation.pending && confirmation.action !== action) {
      return res.status(409).json({ kind: 'expired', message: 'Подтверждение уже обработано.' });
    }
    if (!confirmation.pending) {
      confirmation.action = action;
      const version = active.version;
      const ctx = context(`Заявка №${confirmation.operation.record.id} · ${action === 'confirm' ? 'подтверждение' : 'отмена'}`, id);
      ctx.action = action === 'confirm' ? 'confirm_status_change' : 'cancel_status_change';
      confirmation.pending = withWorkbook(() => operation(ctx, () => {
        if (version !== active.version) return { kind: 'expired', message: changedBook };
        return action === 'cancel' ? { kind: 'cancelled', message: 'Изменение статуса отменено.' } :
          active.book.confirm(ctx, confirmation.operation);
      }));
    }
    res.json(await confirmation.pending);
  });

  app.post(dictationPath, express.raw({ type: acceptsDictation, limit: '2mb' }), createTranscription(settings.resolve, fetcher));

  app.get('/api/settings', async (_req, res) => {
    const { keySource, model, modelSource } = await settings.resolve();
    const workbook = workbookInfo();
    res.json({ keySource, model, modelSource, version: mcpVersion, filename: workbook.filename, workbook, sheet });
  });

  app.put('/api/settings/workbook', async (req, res) => {
    const supplied = req.body?.path;
    const path = typeof supplied === 'string' ? supplied.trim() : '';
    if (path.includes('\0') || !isAbsolute(path) || extname(path).toLowerCase() !== '.xlsx') {
      return res.status(400).json({ message: 'Укажите полный путь к файлу .xlsx.' });
    }

    const result = await withWorkbook(async () => {
      let verifiedPath;
      try {
        verifiedPath = await realpath(path);
        if (extname(verifiedPath).toLowerCase() !== '.xlsx' || !(await stat(verifiedPath)).isFile()) {
          return { status: 400, message: 'По указанному пути должен находиться файл .xlsx.' };
        }
        await access(verifiedPath, constants.R_OK | constants.W_OK);
        await access(dirname(verifiedPath), constants.W_OK);
      } catch (error) {
        return error.code === 'ENOENT' ? { status: 404, message: 'Файл по указанному пути не найден.' } :
          { status: 400, message: 'Нет доступа к чтению и записи книги или её папки.' };
      }

      const previous = active;
      const candidate = verifiedPath === previous.path ? previous : connectBook(verifiedPath);
      try {
        await candidate.book.readAll(context('Проверка рабочей книги'));
      } catch (error) {
        if (candidate !== previous) await candidate.transport.close();
        return { status: 422, message: `Книга не подключена. ${error.message}` };
      }
      if (candidate !== previous) {
        try {
          await settings.save({ workbookPath: verifiedPath });
        } catch (error) {
          await candidate.transport.close();
          throw error;
        }
        active = candidate;
        for (const session of sessions.values()) {
          session.history = [];
          session.draft = null;
          session.confirmations.clear();
        }
        await previous.transport.close();
      }
      return { status: 200, workbook: workbookInfo() };
    });
    const { status, ...body } = result;
    res.status(status).json(body);
  });

  app.put('/api/settings/key', async (req, res) => {
    const key = req.body?.key;
    if (!validKey(key)) return res.status(400).json({ message: 'Укажите ключ ASCII без пробелов.' });
    await settings.save({ key });
    const { keySource } = await settings.resolve();
    res.json({ keySource });
  });

  app.put('/api/settings/model', async (req, res) => {
    const model = req.body?.model;
    if (!validModel(model)) return res.status(400).json({ message: 'Укажите идентификатор модели из каталога OpenAI.' });
    await settings.save({ model });
    const updated = await settings.resolve();
    res.json({ model: updated.model, modelSource: updated.modelSource });
  });

  app.post('/api/diagnostics/mcp', async (_req, res) => {
    const ctx = context('Диагностика Excel MCP');
    const result = await operation(ctx, () => withWorkbook(async () => {
      const tools = await active.transport.catalog();
      if (!['read_range', 'write_range', 'create_workbook'].every(name => tools.includes(name))) {
        throw new Error('В каталоге MCP отсутствуют обязательные инструменты.');
      }
      const table = await active.book.readAll(ctx);
      return { tools, count: table.length };
    }));
    res.status(result.kind === 'error' ? 503 : 200).json(result);
  });

  for (const [name, pkg] of Object.entries(fontPackages)) {
    app.use(`/fonts/${name}`, express.static(fileURLToPath(new URL(`node_modules/@fontsource-variable/${pkg}/files/`, root))));
  }
  app.use(express.static(staticPath, { index: false }));
  app.get(['/', '/adminvk', '/dev'], (_req, res) => res.sendFile(`${staticPath}index.html`));
  app.use('/api', (_req, res) => res.status(404).json({ message: 'Эта операция недоступна.' }));
  app.use((error, _req, res, _next) => {
    const status = error.status === 413 ? 413 : error.status === 400 ? 400 : 500;
    const message = status === 413 ? 'Запрос слишком большой.' : status === 400 ?
      'Некорректный JSON в запросе.' : 'Локальная ошибка приложения. Проверьте настройки и права на каталог data.';
    res.status(status).json({ kind: 'error', message });
  });

  return { app, close: () => withWorkbook(() => active.transport.close()) };
}
