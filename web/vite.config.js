import { defineConfig } from 'vite';

// GitHub Pages serves a project site under /<repo>/, so asset URLs need that prefix.
// Override for a different repo name or a custom domain:  BASE=/otro/ npm run build
export default defineConfig({
  base: process.env.BASE ?? '/Flipping-is-Hard-Interactive-Map/',
  build: {
    // scene.glb lives in public/ and is copied as-is; the warning about chunk size would
    // only be about three.js itself.
    chunkSizeWarningLimit: 1200,
  },
});
