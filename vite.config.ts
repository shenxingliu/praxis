import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    server: {
        port: 5200,
        // Local dev calls Praxis API through the production Vercel app.
        // The API key stays server-side; if APP_ACCESS_TOKEN is enabled,
        // set VITE_APP_ACCESS_TOKEN in ./.env.local to match.
        proxy: {
            '/api': {
                target: 'https://praxis-dun-one.vercel.app',
                changeOrigin: true,
            },
        },
    },
});
