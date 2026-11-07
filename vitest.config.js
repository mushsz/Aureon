import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Os testes rodam dentro do runtime real dos Workers (workerd/Miniflare) com um D1 local isolado.
export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            SETUP_TOKEN: 'codigo-de-instalacao-de-teste',
            ENCRYPTION_KEY: 'q8w1m3V0yQpQ0n7m0m3x8qkz4m0t1o6o2d2q8w1m3V0=',
            APP_URL: 'http://localhost',
            GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
            GOOGLE_CLIENT_SECRET: 'test-secret',
          },
        },
      }),
    ],
    test: { setupFiles: ['./test/apply-migrations.js'], testTimeout: 30_000 },
  };
});
