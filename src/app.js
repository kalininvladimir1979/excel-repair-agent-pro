import express from 'express';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { createAgent } from './agent.js';
import { createMcp, mcpVersion, serialQueue } from './mcp.js';
import { createSettings, validKey, validModel } from './settings.js';
import { createWorkbook, filename, sheet } from './workbook.js';

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
  const book = createWorkbook(mcp);
  const settings = createSettings(directory, env);
  const agent = createAgent(book, withWorkbook, settings.resolve, fetcher);
  const sessions = new Map();

  app.use((req, res, next) => {
    const host = req.get('host') ?? '';
    if (!localHost.test(host)) return res.status(403).json({ message: 'Приложение доступно через локальный адрес.' });
    if (!['GET', 'HEAD'].includes(req.method) &&
        ((req.get('origin') && req.get('origin') !== `http://${host}`) ||
         req.get('sec-fetch-site') === 'cross-site' || !req.is('application/json'))) {
      return res.status(403).json({ message: 'Разрешены JSON-запросы с локальной страницы приложения.' });
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
      session = { history: [], draft: null, chat: new Map(), confirmations: new Map(), queue: serialQueue() };
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

  app.get('/api/requests', async (_req, res) => {
    const ctx = context('Обновление таблицы');
    const result = await operation(ctx, () => withWorkbook(async () => ({ table: await book.readAll(ctx) })));
    res.status(result.kind === 'error' ? 503 : 200).json(result);
  });

  app.post('/api/chat', async (req, res) => {
    const { message, submissionId } = req.body ?? {};
    if (typeof message !== 'string' || !message.trim() || message.length > 4000 ||
        typeof submissionId !== 'string' || !uuid.test(submissionId)) {
      return res.status(400).json({ message: 'Введите сообщение до 4000 символов и укажите UUID отправки.' });
    }
    const text = message.trim();
    const session = req.session;
    const previous = session.chat.get(submissionId);
    if (previous && previous.message !== text) {
      return res.status(409).json({ message: 'Этот идентификатор уже использован для другого сообщения.' });
    }
    if (!previous) {
      const ctx = context(text, submissionId);
      const pending = session.queue(() => operation(ctx, () => agent(session, ctx, text)));
      session.chat.set(submissionId, { message: text, pending });
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
      const ctx = context(`Заявка №${confirmation.operation.record.id} · ${action === 'confirm' ? 'подтверждение' : 'отмена'}`, id);
      confirmation.pending = operation(ctx, () => action === 'cancel' ?
        { kind: 'cancelled', message: 'Изменение статуса отменено.' } :
        withWorkbook(() => book.confirm(ctx, confirmation.operation)));
    }
    res.json(await confirmation.pending);
  });

  app.get('/api/settings', async (_req, res) => {
    const { keySource, model, modelSource } = await settings.resolve();
    res.json({ keySource, model, modelSource, version: mcpVersion, filename, sheet });
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
      const tools = await mcp.catalog();
      if (!['read_range', 'write_range', 'create_workbook'].every(name => tools.includes(name))) {
        throw new Error('В каталоге MCP отсутствуют обязательные инструменты.');
      }
      const table = await book.readAll(ctx);
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

  return { app, close: () => withWorkbook(() => mcp.close()) };
}
