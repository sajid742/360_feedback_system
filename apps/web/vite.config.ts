import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Dev server proxies API paths to the NestJS backend on port 3000 so the
// frontend can use relative /api/v1 without CORS in dev.
//
// Target defaults to the from-source API on localhost:3000 and is overridden with
// VITE_PROXY_TARGET only when the API is NOT on this machine's loopback — the Base44
// sandbox stack (docker-compose.base44.yml) runs the web dev server in its own
// container, where the backend is the `api` service (http://api:3000); localhost
// there would be the web container itself. Unset ⇒ exactly the previous behavior.
const apiTarget = process.env.VITE_PROXY_TARGET ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    // Listen on every interface (0.0.0.0), not just loopback. Vite's default is
    // `localhost`, which binds 127.0.0.1 only — the dev server then works on this
    // machine but is unreachable from phones/laptops on the same Wi-Fi, with no
    // error message anywhere (the connection is simply refused). `true` keeps
    // http://localhost:5173 working exactly as before and additionally serves
    // http://<your-LAN-IP>:5173. Deliberately not a hard-coded IP, so a changed
    // DHCP lease needs no code change.
    //
    // HMR needs no configuration for this: the client derives its websocket URL
    // from the page's own host, so it follows localhost or the LAN IP automatically.
    host: true,
    port: 5173,
    proxy: {
      // Proxy targets stay `localhost` on purpose — they are resolved by the Vite
      // process on this machine, not by the visiting browser. The browser only ever
      // requests a relative /api/v1 path from whichever host it loaded the page from.
      '/api/v1': apiTarget,
      // Use path-boundary regexes so SPA routes that merely START with these
      // letters (e.g. /reports, /radar) are NOT proxied to the API — only the
      // real short-link (/r/:code) and QR (/qr...) endpoints are. (DEF-06)
      '^/r/': apiTarget,
      '^/qr': apiTarget,
    },
  },
});
