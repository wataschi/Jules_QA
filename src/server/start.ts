import dotenv from 'dotenv';
import { bootstrapMidsceneEnv } from '../config/midscene-env.js';
import { createApp } from './index.js';

dotenv.config();
bootstrapMidsceneEnv();

const PORT = Number(process.env.UI_PORT ?? 3840);
const app = createApp();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[ui] Jules QA Dashboard → http://localhost:${PORT}`);
});
