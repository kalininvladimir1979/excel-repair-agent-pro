import { randomUUID } from 'node:crypto';

export const headers = ['ID', 'Клиент', 'Проблема', 'Статус'];
export const statuses = ['Новый', 'В работе', 'Готово'];
export const sheet = 'Заявки';
export const filename = 'requests.xlsx';
export const sample = [
  headers,
  [101, 'Иван Петров', 'Ноутбук не включается', 'Новый'],
  [102, 'Мария Соколова', 'Принтер не печатает', 'В работе'],
  [103, 'Олег Иванов', 'Мерцает монитор', 'Готово'],
];
const maxRow = 1_048_576;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const formula = /^[\s\u200B\uFEFF]*[=+@-]/u;
const dateLiteral = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}.*)?$/;
const label = (value, max) => typeof value === 'string' && value.trim() &&
  value.length <= max && !formula.test(value) && !dateLiteral.test(value.trim()) &&
  !/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(value);
const normalizeName = name => name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru').replaceAll('ё', 'е');

function structuredRow(values, row) {
  const [id, client, problem, status] = values;
  if (values.length !== 4 || !Number.isSafeInteger(id) || id < 1 ||
      !label(client, 160) || !label(problem, 2000) || !statuses.includes(status)) {
    throw new Error(`Строка ${row} книги повреждена. Проверьте ID, клиента, проблему и статус.`);
  }
  return { row, id, client, problem, status };
}

function pageRange(value) {
  const match = /^([A-Z]{1,3})([1-9]\d*)(?::([A-Z]{1,3})([1-9]\d*))?$/.exec(value || '');
  if (!match) throw new Error('Excel MCP вернул неверный диапазон чтения.');
  const first = Number(match[2]);
  const last = Number(match[4] || match[2]);
  if (match[1] !== 'A' || (match[3] || match[1]) !== 'D' || last < first || last > maxRow) {
    throw new Error('В книге ожидаются четыре столбца с A по D.');
  }
  return { first, last };
}

export function createWorkbook(mcp, workbookFilename = filename) {
  const base = { path: workbookFilename, sheet };
  const read = (ctx, range) => mcp.call(ctx, 'read_range', {
    ...base, mode: 'formulas', ...(range && { range }),
  });
  const write = (ctx, at, rows) => mcp.call(ctx, 'write_range', { ...base, at, rows });

  async function readAll(ctx) {
    const records = [];
    const ids = new Set();
    let next;
    let expectedRow = 1;
    do {
      const page = await read(ctx, next);
      const { first, last } = pageRange(page.range);
      if (first !== expectedRow || !Array.isArray(page.values) || page.values.length > last - first + 1) {
        throw new Error('Excel MCP вернул неполную или несогласованную страницу.');
      }

      if (first === 1 && !same(page.values[0], headers)) {
        throw new Error('Строка A1:D1 должна содержать заголовки ID, Клиент, Проблема и Статус.');
      }
      for (const [offset, values] of page.values.entries()) {
        const row = first + offset;
        if (row === 1) continue;
        if (!Array.isArray(values)) throw new Error(`Некорректная строка ${row}.`);
        if (values.every(value => value === null)) continue;
        const record = structuredRow(values, row);
        if (ids.has(record.id)) throw new Error(`В книге повторяется ID №${record.id}.`);
        ids.add(record.id);
        records.push(record);
      }

      next = page.next_range;
      expectedRow = last + 1;
      if (next && pageRange(next).first !== expectedRow) {
        throw new Error('Excel MCP вернул несогласованный диапазон следующей страницы.');
      }
    } while (next);
    return records;
  }

  async function writeAndVerify(ctx, at, values, expected) {
    try {
      await write(ctx, at, [values]);
    } catch {
      // A disconnected transport can leave a completed write behind.
      // Verification is mandatory even if write_range reported an error.
    }
    let actual;
    try {
      const result = await read(ctx, `A${expected.row}:D${expected.row}`);
      actual = structuredRow(result.values[0] || [], expected.row);
    } catch {
      throw new Error('Запись не удалось проверить. Обновите таблицу и проверьте книгу перед новой командой.');
    }
    if (!same(actual, expected)) {
      throw new Error('Контрольное чтение не подтвердило запись. Обновите таблицу перед новой командой.');
    }
    return actual;
  }

  async function add(ctx, client, problem) {
    if (!label(client, 160) || !label(problem, 2000)) {
      throw new Error('Имя и проблема должны быть обычным текстом. Формулы и значения в формате даты не допускаются.');
    }
    const records = await readAll(ctx);
    const id = records.reduce((max, row) => Math.max(max, row.id), 0) + 1;
    const row = (records.at(-1)?.row ?? 1) + 1;
    if (!Number.isSafeInteger(id) || row > maxRow) throw new Error('Достигнут предел ID или строк книги.');
    const expected = { row, id, client: client.trim(), problem: problem.trim(), status: statuses[0] };
    const record = await writeAndVerify(ctx, `A${row}`, [id, expected.client, expected.problem, expected.status], expected);
    return { kind: 'created', record, table: [...records, record], message: `Заявка №${id} добавлена. Статус «Новый».` };
  }

  async function prepare(ctx, { id, client, status }) {
    if (!statuses.includes(status)) throw new Error('Допустимые статусы: Новый, В работе, Готово.');
    const records = await readAll(ctx);
    const name = client && normalizeName(client);
    const matches = id ? records.filter(record => record.id === id) : records.filter(record => {
      const stored = normalizeName(record.client);
      return name === stored || (name && stored.split(' ').includes(name));
    });
    if (!matches.length) return { kind: 'not_found', message: id ? `Заявка №${id} не найдена.` : `Заявки на имя «${client}» не найдены.` };
    if (matches.length > 1) return { kind: 'ambiguous', matches, message: 'Найдено несколько заявок. Укажите ID нужной записи.' };
    const [record] = matches;
    if (record.status === status) return { kind: 'unchanged', message: `У заявки №${record.id} уже статус «${status}».` };
    return {
      kind: 'confirmation',
      message: 'Проверьте предлагаемое изменение статуса.',
      confirmation: { id: randomUUID(), record, status },
    };
  }

  async function confirm(ctx, { record, status }) {
    const records = await readAll(ctx);
    const current = records.find(item => item.id === record.id);
    if (!current || !same({ ...current, row: record.row }, record)) {
      return { kind: 'stale', message: `Заявка №${record.id} изменилась после предпросмотра. Запросите смену статуса заново.` };
    }
    const updated = await writeAndVerify(ctx, `D${current.row}`, [status], { ...current, status });
    return {
      kind: 'updated', record: updated, table: records.map(item => item.id === updated.id ? updated : item),
      message: `Статус заявки №${updated.id} изменён на «${status}».`,
    };
  }

  async function list(ctx, status) {
    if (!statuses.includes(status)) throw new Error('Допустимые статусы: Новый, В работе, Готово.');
    const matches = (await readAll(ctx)).filter(record => record.status === status);
    return {
      kind: 'list', matches, count: matches.length, status,
      message: `Найдено заявок со статусом «${status}»: ${matches.length}.`,
    };
  }

  async function find(ctx, id) {
    const record = (await readAll(ctx)).find(item => item.id === id);
    if (!record) return { kind: 'not_found', message: `Заявка №${id} не найдена.` };
    return { kind: 'found', record, message: `Заявка №${id} · ${record.client}. Статус «${record.status}».` };
  }

  return { readAll, add, prepare, confirm, list, find };
}
