// Static server for the landing page and release downloads. No dependencies.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.svg': 'image/svg+xml', '.sh': 'text/plain; charset=utf-8', '.gz': 'application/gzip',
  '.txt': 'text/plain; charset=utf-8', '': 'text/plain; charset=utf-8',
};
const version = fs.readFileSync(path.join(root, 'downloads/VERSION'), 'utf8').trim();

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') return res.end('ok');
  if (url.pathname === '/version') return res.end(version);
  if (url.pathname === '/install.sh') {
    const base = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
    res.writeHead(200, { 'content-type': types['.sh'], 'cache-control': 'no-cache' });
    return res.end(fs.readFileSync(path.join(root, 'install.sh'), 'utf8').replace('__BASE__', base));
  }
  let file = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
  if (!file.startsWith(root)) { res.writeHead(400); return res.end(); }
  if (file.endsWith(path.sep)) file = path.join(file, 'index.html');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    const ext = path.extname(file);
    const headers = { 'content-type': types[ext] || 'application/octet-stream', 'content-length': st.size };
    if (ext === '.gz') headers['content-disposition'] = `attachment; filename="${path.basename(file)}"`;
    if (ext === '.html') headers['cache-control'] = 'no-cache';
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}).listen(process.env.PORT || 8080, () => console.log(`listening on ${process.env.PORT || 8080}`));
