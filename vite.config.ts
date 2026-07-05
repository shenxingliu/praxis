import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    server: {
        port: 5200,
        // Local dev calls Gemini through the V1.3 production proxy on
        // Vercel — the API key stays server-side, nothing to configure
        // in the browser. (If APP_ACCESS_TOKEN is enabled on Vercel,
        // set VITE_APP_ACCESS_TOKEN in ./.env.local to match.)
        proxy: {
            '/api': {
                target: 'https://lumina-studio-drab.vercel.app',
                changeOrigin: true,
            },
        },
    },
});
