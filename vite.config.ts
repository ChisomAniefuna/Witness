import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      proxy: {
        // Route the app's websocket to the Live backend so the client can use ws(s)://<app-host>/live
        '/live': {
          target: 'http://127.0.0.1:8081',
          ws: true,
          changeOrigin: true,
        },
        // Optional convenience endpoints
        '/health': {
          target: 'http://127.0.0.1:8081',
          changeOrigin: true,
        },
        '/test-live': {
          target: 'http://127.0.0.1:8081',
          changeOrigin: true,
        },
      },
    },
  };
});
