import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [svelte()],
  server: {
    host: true, // listen on 0.0.0.0 so the container port is reachable
    port: 5173,
    strictPort: true,
    allowedHosts: ['web'], // the browser tool reaches us as http://web:5173
    watch: {
      // Bind mounts on Docker Desktop (Mac/Windows) do not deliver file events.
      usePolling: process.env.VITE_USE_POLLING === 'true',
      ignored: ['**/tools/**', '**/docs/**', '**/.shots/**'],
    },
  },
});
