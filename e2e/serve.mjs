/* Firebase Hosting の代わり（12 2.2）：apps/web/out の静的ファイルを配り、/api/** を API へ転送する */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('../apps/web/out/', import.meta.url).pathname;
const API = new URL(process.env.API_ORIGIN ?? 'http://localhost:4100');
const PORT = Number(process.env.WEB_PORT ?? 3100);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname.startsWith('/api/')) {
    const p = request({ hostname: API.hostname, port: API.port, path: req.url, method: req.method, headers: { ...req.headers, host: API.host, 'x-forwarded-for': req.socket.remoteAddress ?? '' } }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    p.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(p);
    return;
  }
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(ROOT, path);
  if (!extname(path) && !path.endsWith('/')) { if (existsSync(join(file, 'index.html'))) { res.writeHead(301, { location: `${path}/${url.search}` }); res.end(); return; } }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) { file = join(ROOT, '404.html'); res.statusCode = 404; }
  res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
  createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`web http://localhost:${PORT}`));
