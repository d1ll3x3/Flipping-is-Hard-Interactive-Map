import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// GitHub Pages serves a project site under /<repo>/, so asset URLs need that prefix.
// Override for a different repo name or a custom domain:  BASE=/otro/ npm run build
export default defineConfig({
  base: process.env.BASE ?? '/Flipping-is-Hard-Interactive-Map/',
  build: {
    // Two pages, not one: the map, and the editors' media list. Without naming them both
    // here Vite only builds index.html and media.html never reaches the site.
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('index.html', import.meta.url)),
        media: fileURLToPath(new URL('media.html', import.meta.url)),
      },
    },
    // scene.glb lives in public/ and is copied as-is; the warning about chunk size would
    // only be about three.js itself.
    chunkSizeWarningLimit: 1200,
  },
});
