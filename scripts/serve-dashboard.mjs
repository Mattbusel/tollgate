// Serve the static dashboard on http://127.0.0.1:8403 (no build step).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dashboard');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const port = Number(process.env.PORT || 8403);
http
  .createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(dir, p === '/' ? 'index.html' : p);
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.statusCode = 404;
      return res.end('not found');
    }
    res.setHeader('content-type', types[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, '127.0.0.1', () => console.log(`Tollgate dashboard on http://127.0.0.1:${port}  (seller feed expected at http://localhost:8402)`));
