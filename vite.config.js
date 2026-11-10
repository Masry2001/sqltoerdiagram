import { defineConfig } from 'vite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Static hosts resolve "/examples/" to "/examples/index.html". Vite's dev and
// preview servers don't do that for nested public/ directories, so the
// pre-rendered landing pages (/examples/, /postgresql/, /prisma/, …) fall back
// to the SPA root locally even though they work in production. This middleware
// restores directory-index resolution so `npm run dev` matches the live site.
function publicDirIndex() {
  const publicDir = join(process.cwd(), 'public');
  const rewrite = (req, _res, next) => {
    const path = (req.url || '').split('?')[0].split('#')[0];
    if (!path.startsWith('/') || path.includes('.')) return next(); // asset / has extension
    const clean = path.replace(/\/+$/, '');
    if (clean === '') return next();                                 // root → Vite handles it
    if (existsSync(join(publicDir, clean, 'index.html'))) {
      req.url = clean + '/index.html';
    }
    next();
  };
  return {
    name: 'public-dir-index',
    configureServer(server) { server.middlewares.use(rewrite); },
    configurePreviewServer(server) { server.middlewares.use(rewrite); },
  };
}

// Lets the MCP server (mcp/server.mjs) drive the diagram. Dev server only: it
// is never added to a production build.
function mcpBridge() {
  return {
    name: 'mcp-bridge',
    apply: 'serve',
    transformIndexHtml: () => [
      { tag: 'script', attrs: { type: 'module', src: '/mcp/bridge.js' }, injectTo: 'body' },
    ],
  };
}

export default defineConfig({
  plugins: [publicDirIndex(), mcpBridge()],
});
