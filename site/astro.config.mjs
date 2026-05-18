// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  site: 'https://mmmaxwwwell.github.io',
  base: '/kanix/',
  server: {
    port: 4321,
    // strictPort: bail out instead of silently picking another port. Combined
    // with the idempotent sync-env script, this keeps the dev server pinned
    // to one URL so a long-lived browser tab never has to chase a new port.
    strictPort: true,
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
