import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
    base: './',
    plugins: [
        tailwindcss(),
    ],
    server: {
        proxy: {
            // Route /api/* through the local Next.js server (localhost:3000)
            // so all outbound API traffic goes through the Next.js proxy routes
            // rather than hitting api.muapi.ai directly from the browser.
            '/api': {
                target: 'http://localhost:3000',
                changeOrigin: true,
                secure: false
            }
        }
    }
});
