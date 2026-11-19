import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serialQueue } from './mcp.js';

const defaultModel = 'gpt-6-luna';

export function createSettings(directory, env = process.env) {
  const path = join(directory, 'settings.json');
  const queue = serialQueue();

  async function read() {
    let raw;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw new Error('Не удалось прочитать настройки приложения.');
    }
    try {
      const saved = JSON.parse(raw);
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error();
      return saved;
    } catch {
      throw new Error('Локальный файл настроек повреждён.');
    }
  }

  async function resolve() {
    const saved = await read();
    const key = saved.key || env.OPENAI_API_KEY?.trim() || '';
    return {
      key,
      keySource: saved.key ? 'admin' : key ? 'env' : 'none',
      model: saved.model || env.OPENAI_MODEL?.trim() || defaultModel,
      modelSource: saved.model ? 'dev' : env.OPENAI_MODEL?.trim() ? 'env' : 'default',
    };
  }

  function save(patch) {
    return queue(async () => {
      const next = { ...await read(), ...patch };
      const temporary = join(directory, `.settings-${randomUUID()}.tmp`);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try {
        await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
    });
  }

  return { resolve, save };
}

export const validKey = value => typeof value === 'string' &&
  /^(?:|[!-~]{16,512})$/.test(value);
export const validModel = value => typeof value === 'string' &&
  /^(?:|[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127})$/.test(value);
