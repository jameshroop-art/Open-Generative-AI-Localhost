import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
    base: './',
    plugins: [
        tailwindcss(),
    ],
    server: {
        // localhost-only: never listen on 0.0.0.0 / the network interface.
        host: '127.0.0.1',
        port: 5173,
        strictPort: true,
        proxy: {
            // Route /api/* through the local Next.js server (localhost:3000)
            // so all outbound API traffic goes through the Next.js proxy routes
            // rather than hitting api.muapi.ai directly from the browser.
            '/api': {
                target: 'http://127.0.0.1:3000',
                changeOrigin: true,
                secure: false
            }
        }
    },
    preview: {
        // localhost-only: serve the built dist/ on 127.0.0.1 only.
        host: '127.0.0.1',
        port: 5173,
        strictPort: true,
    },
});
