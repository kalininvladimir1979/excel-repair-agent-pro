import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import { createMcp } from '../src/mcp.js';
import { createSettings } from '../src/settings.js';

const anna = 'Добавь заявку от Анны Смирновой: ноутбук сильно тормозит';
const moveAnna = 'Измени статус заявки Анны Смирновой на «В работе»';
const list = 'Покажи все заявки со статусом «В работе»';
const missing = 'Измени статус заявки №999 на «Готово»';
const dmitry = 'Добавь новую заявку от Дмитрия';
const problem = 'После включения чёрный экран';
const fixtures = new Map([
  [anna, ['create_request', { client: 'Анна Смирнова', problem: 'ноутбук сильно тормозит' }]],
  [moveAnna, ['prepare_status_change', { id: null, client: 'Анна Смирнова', status: 'В работе' }]],
  [list, ['list_requests', { status: 'В работе' }]],
  [missing, ['prepare_status_change', { id: 999, client: null, status: 'Готово' }]],
  [dmitry, ['create_request', { client: 'Дмитрий', problem: null }]],
  [problem, ['create_request', { client: 'Дмитрий', problem }]],
  ['Анна готова', ['prepare_status_change', { id: 104, client: null, status: 'Готово' }]],
  ['Иван готов', ['prepare_status_change', { id: 101, client: null, status: 'Готово' }]],
  ['Формула', ['create_request', { client: '=1+1', problem: 'Проблема' }]],
  ['Нулевой список', ['list_requests', { status: 'Готово' }]],
  ['Первый параллельный', ['create_request', { client: 'Тест Первый', problem: 'Экран разбит' }]],
  ['Второй параллельный', ['create_request', { client: 'Тест Второй', problem: 'Не заряжается' }]],
  ['Неопределённая запись', ['create_request', { client: 'Тест Связь', problem: 'Синий экран' }]],
]);

let functionOutputs = 0;
async function fakeOpenAI(_url, options) {
  const request = JSON.parse(options.body);
  const last = request.input.at(-1);
  assert.equal(request.tools.length, 3);
  assert.equal(request.store, false);
  if (last.type === 'function_call_output') {
    functionOutputs++;
    return Response.json({
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.parse(last.output).message }] }],
    });
  }
  if (last.content === 'Проверка ошибки региона') {
    return Response.json({ error: { code: 'unsupported_country_region_territory' } }, { status: 403 });
  }
  const [name, args] = fixtures.get(last.content);
  if (last.content === problem) assert.match(request.input[0].content, /Дмитрий/);
  return Response.json({
    output: [{ type: 'function_call', name, arguments: JSON.stringify(args), call_id: 'test-call' }],
  });
}

test('Обязательные сценарии через HTTP и реальный Excel MCP', { timeout: 360_000 }, async t => {
  const live = process.env.REPAIR_TEST_OPENAI === '1';
  const originalSettings = createSettings(fileURLToPath(new URL('../data/', import.meta.url)));
  const realConfig = live ? await originalSettings.resolve() : null;
  if (live) assert.ok(realConfig.key, 'Настройте рабочий ключ OpenAI в /adminvk или в окружении.');
  const directory = await mkdtemp(join(tmpdir(), 'repair-mcp-test-'));
  const active = createMcp(directory);
  let disconnected = false;
  let lostWriteResponse = false;
  const mcp = {
    ...active,
    async call(ctx, name, args) {
      if (disconnected) {
        ctx.log.push({ name, arguments: args, error: 'MCP-процесс отключён' });
        throw new Error('Excel MCP недоступен.');
      }
      const result = await active.call(ctx, name, args);
      if (lostWriteResponse && name === 'write_range') {
        lostWriteResponse = false;
        delete ctx.log.at(-1).result;
        ctx.log.at(-1).error = 'Потерян ответ после записи';
        throw new Error('Потерян ответ после записи');
      }
      return result;
    },
  };

  await copyFile(new URL('../example/requests.xlsx', import.meta.url), join(directory, 'requests.xlsx'));
  const env = { OPENAI_API_KEY: realConfig?.key, OPENAI_MODEL: realConfig?.model };
  const followUps = [];
  const fetcher = live ? async (url, options) => {
    const response = await fetch(url, options);
    const input = JSON.parse(options.body).input;
    if (input.at(-1).type === 'function_call_output') {
      const result = await response.clone().json();
      followUps.push({ httpStatus: response.status, responseStatus: result.status });
    }
    return response;
  } : fakeOpenAI;
  const { app, close } = await createApp({ directory, mcp, env, fetcher });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await close();
    if (!process.env.REPAIR_KEEP_TEST_BOOK) await rm(directory, { recursive: true, force: true });
    else console.log(`Книга для проверки в LibreOffice: ${join(directory, 'requests.xlsx')}`);
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  function browser() {
    let cookie;
    return async (path, method = 'GET', body) => {
      const response = await fetch(base + path, {
        method,
        headers: { ...(cookie && { cookie }), ...(body && { 'Content-Type': 'application/json' }) },
        ...(body && { body: JSON.stringify(body) }),
      });
      cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
      return { ...await response.json(), httpStatus: response.status };
    };
  }
  const api = browser();
  const send = (message, submissionId = randomUUID(), client = api) => client('/api/chat', 'POST', { message, submissionId });
  const confirm = (card, action = 'confirm', client = api) => client(`/api/status-confirmations/${card.confirmation.id}`, 'POST', { action });
  const actions = result => result.operation.log.map(entry => entry.name);
  const excelArgs = { path: 'requests.xlsx', sheet: 'Заявки' };
  const external = (name, args) => active.call({ log: [] }, name, { ...excelArgs, ...args });

  await t.test('Таблица начинает с 101–103, каталог доступен, ключ из админки закрыт', async () => {
    assert.deepEqual((await api('/api/requests')).table.map(row => row.id), [101, 102, 103]);
    const diagnostics = await api('/api/diagnostics/mcp', 'POST', {});
    assert.ok(diagnostics.tools.includes('read_range'));
    if (!live) {
      const fixtureKey = 'example-only-local-test-key';
      assert.equal((await api('/api/settings/key', 'PUT', { key: fixtureKey })).keySource, 'admin');
      const settings = await api('/api/settings');
      assert.equal(settings.keySource, 'admin');
      assert.ok(!JSON.stringify(settings).includes(fixtureKey));
      assert.equal((await api('/api/settings/model', 'PUT', { model: 'test-model' })).model, 'test-model');
    }
  });

  await t.test('Добавление Анны и конкурентный повтор отправки', async () => {
    const id = randomUUID();
    const [a, b] = await Promise.all([send(anna, id), send(anna, id)]);
    assert.equal(a.kind, 'created', a.message);
    assert.deepEqual(a, b);
    assert.equal(a.record.id, 104);
    assert.equal(a.record.status, 'Новый');
    assert.deepEqual(actions(a), ['read_range', 'write_range', 'read_range']);
    assert.equal(a.operation.log[1].arguments.at, 'A5');
    const cells = (await external('read_range', { range: 'A5:D5' })).values[0];
    assert.deepEqual(cells, [104, 'Анна Смирнова', a.record.problem, 'Новый']);
    assert.equal(a.record.problem.toLocaleLowerCase('ru'), 'ноутбук сильно тормозит');
  });

  await t.test('Подтверждение привязано к сессии и пишет только D5 один раз', async () => {
    const card = await send(moveAnna);
    assert.equal(card.kind, 'confirmation', card.message);
    assert.equal(card.confirmation.record.status, 'Новый');
    assert.deepEqual(actions(card), ['read_range']);
    assert.equal((await confirm(card, 'confirm', browser())).httpStatus, 404);
    const [a, b] = await Promise.all([confirm(card), confirm(card)]);
    assert.equal(a.kind, 'updated', a.message);
    assert.deepEqual(a, b);
    assert.deepEqual(a.operation.log[1].arguments, { ...excelArgs, at: 'D5', rows: [['В работе']] });
    assert.equal((await external('read_range', { range: 'D5' })).values[0][0], 'В работе');
  });

  await t.test('Список, отсутствующая заявка, черновик Дмитрия', async () => {
    const found = await send(list);
    assert.equal(found.kind, 'list', found.message);
    assert.equal(found.count, 2);
    assert.deepEqual(found.matches.map(row => row.id), [102, 104]);
    const absent = await send(missing);
    assert.equal(absent.kind, 'not_found', absent.message);
    assert.deepEqual(actions(absent), ['read_range']);
    const draft = await send(dmitry);
    assert.equal(draft.kind, 'clarification', draft.message);
    assert.deepEqual(actions(draft), []);
    assert.equal((await api('/api/requests')).table.length, 4);
    const end = await send(problem);
    assert.equal(end.kind, 'created', end.message);
    assert.equal(end.record.client, 'Дмитрий');
    assert.equal(end.record.id, 105);
    assert.equal(end.record.problem.toLocaleLowerCase('ru'), problem.toLocaleLowerCase('ru'));
  });

  if (live) {
    await t.test('Responses API принял фактические результаты всех шести вызовов функций', () => {
      assert.equal(followUps.length, 6);
      assert.deepEqual(followUps, Array.from({ length: 6 }, () => ({
        httpStatus: 200, responseStatus: 'completed',
      })));
    });
  }

  if (!live) {
    await t.test('Ограничение OpenAI по региону видно в чате и не вызывает MCP', async () => {
      const reply = await send('Проверка ошибки региона');
      assert.equal(reply.kind, 'error');
      assert.match(reply.message, /недоступен из текущего региона сети/);
      assert.deepEqual(actions(reply), []);
    });

    await t.test('Отмена, устаревший предпросмотр, формула и пустой список', async () => {
      const cancel = await send('Анна готова');
      assert.equal((await confirm(cancel, 'cancel')).kind, 'cancelled');
      assert.equal((await confirm(cancel)).httpStatus, 409);
      const preview = await send('Иван готов');
      await external('write_range', { at: 'C2', rows: [['Уточнённое описание']] });
      const stale = await confirm(preview);
      assert.equal(stale.kind, 'stale');
      assert.deepEqual(actions(stale), ['read_range']);
      const formula = await send('Формула');
      assert.equal(formula.kind, 'error');
      assert.deepEqual(actions(formula), []);
      await external('write_range', { at: 'D4', rows: [['Новый']] });
      const zero = await send('Нулевой список');
      assert.equal(zero.count, 0);
      assert.deepEqual(zero.matches, []);
    });

    await t.test('Разные сессии получают разные ID, потеря ответа проверяется чтением', async () => {
      const secondBrowser = browser();
      await secondBrowser('/api/requests');
      const [a, b] = await Promise.all([
        send('Первый параллельный'), send('Второй параллельный', randomUUID(), secondBrowser),
      ]);
      assert.deepEqual([a.record.id, b.record.id].sort(), [106, 107]);
      lostWriteResponse = true;
      const interrupted = await send('Неопределённая запись');
      assert.equal(interrupted.kind, 'created');
      assert.ok(interrupted.operation.log[1].error);
      assert.equal(interrupted.record.id, 108);
    });

    await t.test('Поиск через next_range, ручное обновление, отключение MCP', async () => {
      const rows = Array.from({ length: 505 }, (_, index) => [
        2000 + index, `Клиент ${index}`, 'Учебная диагностика', index === 504 ? 'В работе' : 'Новый',
      ]);
      await external('write_range', { at: 'A10', rows });
      const result = await send(list);
      assert.ok(result.operation.log[0].result.next_range);
      assert.equal(result.count, 3);
      assert.deepEqual(result.matches.map(row => row.id), [102, 104, 2504]);
      await external('write_range', { at: 'A515', rows: [[2504, 'Повтор ID', 'Проблема', 'Новый']] });
      assert.match((await api('/api/requests')).message, /повторяется ID/);
      disconnected = true;
      await active.close();
      const failed = await api('/api/requests');
      assert.equal(failed.httpStatus, 503);
      assert.equal(failed.table, undefined);
      assert.ok(failed.operation.log[0].error);
      assert.ok(functionOutputs >= 10);
    });
  }
});
