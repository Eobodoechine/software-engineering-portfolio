// healthcheck.js - Minimal HTTP server for Cloud Run health checks
const http = require('http');
const port = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  // Cloud Run health probe endpoint
  if (req.url === '/_ah/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Worker is alive and listening\n');
    return;
  }
  // Respond to any other requests
  res.writeHead(404);
  res.end('Not Found');
});

server.listen(port, () => {
  console.log(`Health check server listening on port ${port}`);
});
