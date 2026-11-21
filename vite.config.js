import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { finmanAiDevServerPlugin } from './src/server/ai/vitePlugin.js';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  if (env.OPENAI_API_KEY) {
    process.env.OPENAI_API_KEY = env.OPENAI_API_KEY.trim();
  }
  if (env.OPENAI_MODEL) {
    process.env.OPENAI_MODEL = env.OPENAI_MODEL.trim();
  }

  return {
    plugins: [react(), finmanAiDevServerPlugin()],
    base: './',
    build: { outDir: 'dist', sourcemap: false },
    server: { 
      port: 5173,
      proxy: {
        '/api/yahoo': {
          target: 'https://query1.finance.yahoo.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/yahoo/, ''),
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*'
          }
        },
        '/api/yahoo2': {
          target: 'https://query2.finance.yahoo.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/yahoo2/, ''),
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*'
          }
        }
      }
    }
  };
});
