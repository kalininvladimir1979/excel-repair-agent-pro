const $ = id => document.getElementById(id);
const icons = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  moon: '<path d="M20.5 14.2A8.7 8.7 0 0 1 9.8 3.5a8.8 8.8 0 1 0 10.7 10.7Z"/>',
  file: '<path d="M5 3h9l5 5v13H5zM14 3v6h5M8 13h8m-8 4h8"/>',
  chat: '<path d="M4 4h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9l-5 4v-4H3V5a1 1 0 0 1 1-1Z"/><path d="M7 9h10m-10 4h6"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M3 9h18M3 14h18M9 9v11"/>',
  arrow: '<path d="M5 19 19 5M6 5h13v13"/>',
  right: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
  refresh: '<path d="M20 4v5h-5m5 6a8 8 0 1 1-1.1-7.6L20 9"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="m7 9 3 3-3 3m6 0h4"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  key: '<circle cx="8" cy="9" r="5"/><path d="m12 12 8 8m-2-2 2-2m-5-1 2-2"/>',
};

function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

function paintIcon(container, name) {
  container.setAttribute('aria-hidden', 'true');
  container.innerHTML = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" focusable="false">${icons[name]}</svg>`;
  return container;
}
const icon = (name, extra = '') => paintIcon(node('span', extra), name);
document.querySelectorAll('[data-icon]').forEach(element => paintIcon(element, element.dataset.icon));

function applyTheme(theme) {
  const light = theme === 'light';
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  $('theme-label').textContent = light ? 'Тёмная' : 'Светлая';
  $('theme').setAttribute('aria-label', light ? 'Включить тёмную тему' : 'Включить светлую тему');
  document.querySelector('meta[name="theme-color"]').content = light ? '#eee9e0' : '#22211f';
  paintIcon($('theme').firstElementChild, light ? 'moon' : 'sun');
}

try {
  applyTheme(localStorage.getItem('repair-theme'));
} catch {
  applyTheme('dark');
}
$('theme').addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(theme);
  try { localStorage.setItem('repair-theme', theme); } catch { /* theme works for this page */ }
});

const path = location.pathname.replace(/\/$/, '') || '/';
const page = { '/': 'workspace', '/adminvk': 'admin', '/dev': 'developer' }[path] || 'workspace';
$(page).hidden = false;
document.querySelector(`nav a[href="${path}"]`)?.setAttribute('aria-current', 'page');
if (page !== 'workspace') document.title = `${$(page).querySelector('h1').textContent} · Ремонтное бюро`;

async function api(path, method = 'GET', body) {
  let response;
  try {
    response = await fetch(path, {
      method,
      ...(body && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return await response.json();
  } catch {
    throw new Error('Связь с приложением прервалась. Убедитесь, что оно запущено, и повторите действие.');
  }
}

const resultLabel = (id, text, error = false) => {
  $(id).textContent = text;
  $(id).classList.toggle('error', error);
};

const russianPlural = new Intl.PluralRules('ru');
function countLabel(count) {
  const word = { one: 'заявка', few: 'заявки', many: 'заявок' }[russianPlural.select(count)] || 'заявок';
  return `${count} ${word}`;
}

function badge(status) {
  const element = node('span', 'badge', status);
  element.dataset.state = status;
  return element;
}

function renderTable(records) {
  const rows = document.createDocumentFragment();
  for (const record of records) {
    const row = node('tr');
    const status = node('td');
    status.append(badge(record.status));
    row.append(node('td', '', `№${record.id}`), node('td', '', record.client), node('td', '', record.problem), status);
    rows.append(row);
  }
  $('rows').replaceChildren(rows);
  $('table-count').textContent = countLabel(records.length);
  $('table-empty').hidden = records.length > 0;
  resultLabel('table-empty', 'Рабочая книга пока без заявок.');
}

function hideTable(message, error = false) {
  $('rows').replaceChildren();
  $('table-count').textContent = '';
  $('table-empty').hidden = false;
  resultLabel('table-empty', message, error);
}

const logged = new Set();
let logCount = 0;

function addLog(operation) {
  if (!operation?.log.length || logged.has(operation.id)) return;
  logged.add(operation.id);
  if (!logCount) $('logs').replaceChildren();
  const group = node('article', 'log-group');
  group.append(node('header', '', operation.label));
  for (const entry of operation.log) {
    const detail = node('details');
    detail.append(node('summary', '', `${entry.name} · ${entry.error ? 'ошибка' : 'выполнен'}`));
    detail.append(node('pre', '', JSON.stringify({
      аргументы: entry.arguments,
      ...(entry.error ? { ошибка: entry.error } : { результат: entry.result }),
    }, null, 2)));
    group.append(detail);
  }
  $('logs').append(group);
  logCount += operation.log.length;
  $('log-count').textContent = logCount;
}

let busy = false;
let keySource;
function setBusy(value, caption = '') {
  busy = value;
  $('send').disabled = value;
  $('refresh').disabled = value;
  $('chat-state').textContent = caption || (keySource === 'none' ? 'Нужен ключ OpenAI' : '');
}

async function refresh() {
  if (busy) return;
  setBusy(true);
  hideTable('Читаю рабочую книгу…');
  try {
    const result = await api('/api/requests');
    addLog(result.operation);
    if (result.table) renderTable(result.table);
    else hideTable(result.message || 'Не удалось прочитать книгу.', true);
  } catch (error) {
    hideTable(error.message, true);
  } finally {
    setBusy(false);
  }
}

function addEntry(text, user = false, error = false) {
  const entry = node('article', `entry ${user ? 'user-entry' : 'agent-entry'}`);
  const content = node('div', error ? 'reply-error' : '');
  content.append(node('strong', 'speaker', user ? 'Вы' : 'Помощник мастерской'), node('p', '', text));
  if (!user) entry.append(icon('chat', 'avatar'));
  entry.append(content);
  $('chat-feed').append(entry);
  scrollChat();
  return content;
}

function scrollChat() {
  $('chat-feed').scrollTop = $('chat-feed').scrollHeight;
}

function confirmationCard(container, confirmation) {
  const card = node('div', 'confirmation');
  card.append(node('strong', '', `№${confirmation.record.id} · ${confirmation.record.client}`),
    node('p', '', confirmation.record.problem));
  const flow = node('div', 'status-flow');
  flow.setAttribute('aria-label', `Было: ${confirmation.record.status}. Станет: ${confirmation.status}.`);
  flow.append(badge(confirmation.record.status), icon('right'), badge(confirmation.status));
  const actions = node('div', 'confirm-actions');
  const accept = node('button', 'primary', 'Подтвердить');
  const cancel = node('button', 'secondary', 'Отменить');
  accept.type = cancel.type = 'button';
  actions.append(accept, cancel);
  const feedback = node('p', 'form-result');
  feedback.setAttribute('role', 'status');
  card.append(flow, actions, feedback);
  container.append(card);

  let attempted;
  async function submit(action) {
    if (busy || (attempted && attempted !== action)) return;
    attempted = action;
    setBusy(true, 'Обрабатываю подтверждение…');
    accept.disabled = cancel.disabled = true;
    feedback.textContent = '';
    try {
      const result = await api(`/api/status-confirmations/${confirmation.id}`, 'POST', { action });
      actions.remove();
      feedback.textContent = result.message;
      feedback.tabIndex = -1;
      feedback.focus();
      addLog(result.operation);
      if (result.table) renderTable(result.table);
      if (result.kind === 'error') hideTable('Обновите таблицу, чтобы проверить состояние книги.', true);
    } catch (error) {
      feedback.textContent = error.message;
      const retry = action === 'confirm' ? accept : cancel;
      retry.textContent = action === 'confirm' ? 'Повторить подтверждение' : 'Повторить отмену';
      retry.disabled = false;
      retry.focus();
    } finally {
      setBusy(false);
      scrollChat();
    }
  }
  accept.addEventListener('click', () => submit('confirm'));
  cancel.addEventListener('click', () => submit('cancel'));
}

function renderReply(result) {
  addLog(result.operation);
  const reply = addEntry(result.message || 'Ответ приложения недоступен.', false, result.kind === 'error');
  if (result.confirmation) confirmationCard(reply, result.confirmation);
  if (result.matches?.length) {
    const list = node('ul', 'matches');
    for (const record of result.matches) {
      const item = node('li', '', `№${record.id} · ${record.client} · ${record.problem}`);
      list.append(item);
    }
    reply.append(list);
  }
  if (result.table) renderTable(result.table);
  if (result.kind === 'error' && result.operation?.log.some(entry => entry.name === 'write_range')) {
    hideTable('Обновите таблицу, чтобы проверить состояние книги.', true);
  }
  scrollChat();
}

let unsent;
$('chat-form').addEventListener('submit', async event => {
  event.preventDefault();
  const message = $('message').value.trim();
  if (!message || busy) return;
  if (unsent?.message !== message) {
    unsent = { message, submissionId: crypto.randomUUID() };
    addEntry(message, true);
  }
  setBusy(true, 'Обрабатываю команду…');
  $('message').value = '';
  try {
    const result = await api('/api/chat', 'POST', unsent);
    unsent = null;
    renderReply(result);
    const triedWriting = result.operation?.log.some(entry => entry.name === 'write_range');
    if (result.kind === 'error' && !triedWriting && !$('message').value) $('message').value = message;
  } catch (error) {
    if (!$('message').value) $('message').value = message;
    addEntry(error.message, false, true);
  } finally {
    setBusy(false);
  }
});
$('message').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $('chat-form').requestSubmit();
  }
});
document.querySelectorAll('[data-example]').forEach(button => {
  button.addEventListener('click', () => {
    $('message').value = button.dataset.example;
    $('message').focus();
  });
});
$('refresh').addEventListener('click', refresh);

function showKey(source) {
  keySource = source;
  $('key-state').textContent = { admin: 'Ключ сохранён', env: 'Ключ из окружения', none: 'Ключ не задан' }[source] || '';
  $('clear-key').disabled = source !== 'admin';
  $('key-link').hidden = source !== 'none';
}

function showModel(config) {
  $('model').value = config.model;
  $('model-source').textContent = {
    dev: 'Задана в консоли разработчика.',
    env: 'Задана через OPENAI_MODEL.',
    default: 'Используется значение по умолчанию.',
  }[config.modelSource] || '';
  $('clear-model').disabled = config.modelSource !== 'dev';
}

async function saveSetting(name, value, success) {
  const id = `${name}-result`;
  resultLabel(id, 'Сохраняю…');
  const buttons = [...$(`${name}-form`).querySelectorAll('button')];
  const disabled = buttons.map(button => button.disabled);
  buttons.forEach(button => { button.disabled = true; });
  let result;
  try {
    result = await api(`/api/settings/${name}`, 'PUT', { [name]: value });
    if (result.message) throw new Error(result.message);
  } catch (error) {
    resultLabel(id, error.message, true);
  } finally {
    buttons.forEach((button, index) => { button.disabled = disabled[index]; });
  }
  if (result && !result.message) {
    if (name === 'key') {
      $('api-key').value = '';
      showKey(result.keySource);
    } else {
      showModel(result);
    }
    resultLabel(id, success);
  }
}

$('key-form').addEventListener('submit', event => {
  event.preventDefault();
  if ($('api-key').value.trim()) saveSetting('key', $('api-key').value.trim(), 'Ключ сохранён. Рабочий чат использует его для новых команд.');
});
$('clear-key').addEventListener('click', () => saveSetting('key', '', 'Ключ удалён из настроек админки.'));
$('model-form').addEventListener('submit', event => {
  event.preventDefault();
  if ($('model').value.trim()) saveSetting('model', $('model').value.trim(), 'Модель сохранена.');
});
$('clear-model').addEventListener('click', () => saveSetting('model', '', 'Восстановлена модель из окружения или значение по умолчанию.'));

$('diagnose').addEventListener('click', async () => {
  $('diagnose').disabled = true;
  $('diagnostic-tools').replaceChildren();
  resultLabel('diagnostic-result', 'Проверяю каталог и рабочую книгу…');
  try {
    const result = await api('/api/diagnostics/mcp', 'POST', {});
    if (result.message) throw new Error(result.message);
    resultLabel('diagnostic-result', `Excel MCP подключён. В книге ${countLabel(result.count)}.`);
    const detail = node('details');
    detail.append(node('summary', '', `Инструменты сервера · ${result.tools.length}`),
      node('p', 'muted', result.tools.join(', ')));
    $('diagnostic-tools').append(detail);
  } catch (error) {
    resultLabel('diagnostic-result', error.message, true);
  } finally {
    $('diagnose').disabled = false;
  }
});

async function loadSettings() {
  try {
    const config = await api('/api/settings');
    if (config.message) throw new Error(config.message);
    showKey(config.keySource);
    showModel(config);
    $('mcp-version').textContent = config.version;
    if (page === 'workspace' && config.keySource === 'none') $('chat-state').textContent = 'Нужен ключ OpenAI';
  } catch (error) {
    if (page === 'admin') resultLabel('key-result', error.message, true);
    if (page === 'developer') resultLabel('model-result', error.message, true);
    if (page === 'workspace') $('key-link').hidden = false;
  }
}

if (page === 'workspace') await refresh();
await loadSettings();
