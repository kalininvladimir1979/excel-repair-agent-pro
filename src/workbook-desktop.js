import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { filename } from './workbook.js';

const exec = promisify(execFile);

async function showOnLinux(file, reveal) {
  if (reveal) {
    try {
      await exec('gdbus', [
        'call', '--session', '--timeout', '4',
        '--dest', 'org.freedesktop.FileManager1',
        '--object-path', '/org/freedesktop/FileManager1',
        '--method', 'org.freedesktop.FileManager1.ShowItems',
        JSON.stringify([pathToFileURL(file).href]), '',
      ], { timeout: 5000 });
      return;
    } catch {
      // File managers without FileManager1 can still open the containing folder.
    }
  }
  await exec('gio', ['open', reveal ? dirname(file) : file], { timeout: 5000 });
}

async function showOnDesktop(file, reveal) {
  if (process.platform === 'linux') return showOnLinux(file, reveal);
  if (process.platform === 'darwin') return exec('open', reveal ? ['-R', file] : [file], { timeout: 5000 });
  if (process.platform === 'win32') {
    const args = reveal ? ['/select,', file] : [file];
    try {
      await exec('explorer.exe', args, { timeout: 5000 });
    } catch (error) {
      // Explorer may return 1 when forwarding to the running desktop process.
      if (error.code !== 1) throw error;
    }
    return;
  }
  throw new Error('На этой системе открытие из браузера не поддерживается.');
}

export function workbookDesktopAction(directory, reveal) {
  const file = resolve(directory, filename);
  return async (_req, res) => {
    const info = await stat(file).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info?.isFile()) {
      return res.status(404).json({ message: 'Рабочая книга requests.xlsx отсутствует. Сначала создайте её.' });
    }

    try {
      await showOnDesktop(file, reveal);
      return res.json({ opened: true });
    } catch {
      const message = reveal ?
        'Не удалось открыть папку. Проверьте, что приложение запущено в сеансе рабочего стола.' :
        'Не удалось открыть книгу. Проверьте, что установлен Excel или LibreOffice.';
      return res.status(503).json({ message });
    }
  };
}
