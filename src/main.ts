import { NestFactory } from '@nestjs/core';
import { existsSync } from 'node:fs';
import { AppModule } from './app.module.js';

// Load .env from the project root (works from both src/ and dist/)
const envFile = new URL('../.env', import.meta.url);
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(
    `Server listening on ${process.env.BASE_URL ?? `http://localhost:${port}`} (port ${port})`,
  );
}
await bootstrap();
