import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// SPA: /pay/:requestId is a client route, so dev + preview fall back to index.html.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 }
});
