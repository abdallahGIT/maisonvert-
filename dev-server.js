// Local dev server that mimics Vercel: serves /public and runs /api/*.js functions.
// Usage: DATABASE_URL=... ADMIN_PASSWORD=... node dev-server.js
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.gif': 'image/gif', '.png': 'image/png', '.svg': 'image/svg+xml' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    const file = path.join(__dirname, 'api', url.pathname.slice(5).replace(/[^a-z0-9_-]/gi, '') + '.js');
    if (!fs.existsSync(file)) { res.statusCode = 404; return res.end('not found'); }
    try { return await require(file)(req, res); } catch (e) { console.error(e); res.statusCode = 500; return res.end('error'); }
  }
  let p = url.pathname === '/' ? '/index.html' : url.pathname === '/admin' ? '/admin.html' : url.pathname;
  const file = path.join(__dirname, 'public', path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(file, (err, data) => {
    if (err) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('content-type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.end(data);
  });
}).listen(PORT, () => console.log('http://localhost:' + PORT));
