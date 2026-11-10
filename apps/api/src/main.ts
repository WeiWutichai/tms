import { createApp } from './bootstrap';
import { createLogger } from './common/logger';

async function main() {
  const log = createLogger();
  const app = await createApp();
  const port = Number(process.env.API_PORT ?? 4410);
  await app.listen(port);
  log.info({ port }, 'TMS API listening');
}

void main();
