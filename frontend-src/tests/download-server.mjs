// Browser downloads can bypass Playwright route interception. The test Vite
// proxy always targets this fixture server, never the user's running backend.
import { createServer } from 'node:http';
createServer((req, res) => {
  if (req.url === '/health') { res.end('ok'); return; }
  if (req.url?.startsWith('/api/recordings/rec-0/export/summaries/summary-1.md?token=fixture-token')) {
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': 'attachment; filename="summary-v1.md"' });
    res.end('# 历史纪要\n\n这是第一版内容。');
    return;
  }
  res.writeHead(501); res.end('Unexpected fixture request');
}).listen(5189, '127.0.0.1');
