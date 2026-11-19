import { mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcp } from '../src/mcp.js';
import { createWorkbook, filename, sample, sheet } from '../src/workbook.js';

const targets = { '--example': 'example', '--data': 'data' };
const target = process.argv[2] || '--data';
if (!Object.hasOwn(targets, target) || process.argv.length > 3) {
  console.error('Использование: npm run init:workbook -- [--data | --example]');
  process.exit(1);
}
const directory = fileURLToPath(new URL(`../${targets[target]}/`, import.meta.url));
const path = resolve(directory, filename);
const mcp = createMcp(directory);
const context = { log: [] };

try {
  await mkdir(directory, { recursive: true });
  if (await stat(path).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  })) {
    throw new Error('Книга уже существует. Для повторной инициализации переместите её вручную.');
  }
  await mcp.call(context, 'create_workbook', { path: filename, sheets: [sheet], overwrite: false });
  await mcp.call(context, 'write_range', { path: filename, sheet, at: 'A1', rows: sample });
  const records = await createWorkbook(mcp).readAll(context);
  const actual = records.map(({ id, client, problem, status }) => [id, client, problem, status]);
  if (JSON.stringify(actual) !== JSON.stringify(sample.slice(1))) throw new Error('Не совпали контрольные строки.');
  console.log(`Книга создана и проверена через MCP: ${path}`);
} catch (error) {
  console.error(`Инициализация не завершена (${path}). ${error.message}`);
  if (context.log.length) console.error('Проверьте, сохранилась ли книга частично.');
  process.exitCode = 1;
} finally {
  await mcp.close();
}
