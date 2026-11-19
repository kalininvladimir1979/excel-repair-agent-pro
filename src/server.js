import { createApp } from './app.js';

const port = Number(process.env.PORT || 3099);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT должен быть целым числом от 1 до 65535.');

const { app, close } = await createApp();
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Ремонтное бюро: http://127.0.0.1:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(async () => {
    await close();
    process.exit(0);
  }));
}
