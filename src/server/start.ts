import dotenv from 'dotenv';
import { bootstrapMidsceneEnv } from '../config/midscene-env.js';
import { createApp } from './index.js';
import { startBackgroundJobs } from './background.js';

dotenv.config();
bootstrapMidsceneEnv();

const PORT = Number(process.env.UI_PORT ?? process.env.PORT ?? 3840);
/**
 * За замовчуванням лише loopback: на Mac Studio до сервера ходить тільки
 * `tailscale serve`, і саме тому можна довіряти заголовку `Tailscale-User-Login`.
 * У Docker адресу задає compose (`HOST=0.0.0.0`).
 */
const HOST = process.env.HOST?.trim() || '127.0.0.1';
const app = createApp();

app.listen(PORT, HOST, () => {
  console.log(`[ui] Jules QA Dashboard → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  startBackgroundJobs();
});
