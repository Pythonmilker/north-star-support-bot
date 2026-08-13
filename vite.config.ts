import { defineConfig, loadEnv } from 'vite';
import preact from '@preact/preset-vite';
import { fileURLToPath } from 'node:url';

/**
 * Library build: ONE self-contained IIFE file that a static site drops in with a <script> tag.
 *
 * The critical detail is what's absent: there is no `external`. Preact is COMPILED IN. The host page
 * is a stranger's static site — it has no npm, no bundler, and no framework, so anything we mark
 * external simply wouldn't resolve.
 *
 * `__BUNDLED_DEMO_KEY__` is substituted below, from NORTHSTAR_DEMO_KEY. Vite does not put .env values
 * on `process.env`, so loadEnv is what actually reads the local key file. With no key configured the
 * value is an empty string and the widget runs on its keyword matcher, which answers every question.
 *
 * Anything baked into a browser bundle is public. Only ever put a disposable, spend-capped,
 * short-expiry key here, and rotate it when the job ends.
 */
export default defineConfig(({ mode }) => {
  // Empty prefix: read every var, not just VITE_*. Our key is deliberately not VITE_-prefixed, so it
  // can never leak into `import.meta.env` and get shipped by accident.
  const env = loadEnv(mode, process.cwd(), '');
  const demoKey = env['NORTHSTAR_DEMO_KEY'] ?? process.env['NORTHSTAR_DEMO_KEY'] ?? '';

  if (demoKey) {
    // Say so out loud. A key silently entering a bundle is how keys end up on the internet.
    // eslint-disable-next-line no-console
    console.log('\n  [build] NORTHSTAR_DEMO_KEY is set: baking a demo key into the bundle.');
    // eslint-disable-next-line no-console
    console.log('  [build] The bundle is now PUBLIC-READABLE. Ship only a disposable, capped key.\n');
  }

  return {
    plugins: [preact()],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    define: {
      'process.env.NODE_ENV': '"production"',
      __BUNDLED_DEMO_KEY__: JSON.stringify(demoKey),
    },
    build: {
      lib: {
        entry: fileURLToPath(new URL('./src/embed.tsx', import.meta.url)),
        name: 'NorthStarBot',
        formats: ['iife'],
        fileName: () => 'north-star-bot.js',
      },
      rollupOptions: {
        output: { inlineDynamicImports: true },
      },
      cssCodeSplit: false,
      // Inline everything — a separate asset emit would break the single-file promise, and couldn't
      // reach into the shadow root anyway.
      assetsInlineLimit: 100_000_000,
      target: 'es2019',
      minify: 'esbuild',
      emptyOutDir: true,
    },
  };
});
