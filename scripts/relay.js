/**
 * scripts/relay.js
 * -----------------
 * Indigenous standalone HTTP server for the Quizzitch Webhook Relay.
 * Runs locally without any external dependencies (pure Node.js http/crypto/fetch).
 * 
 * Usage:
 *   $env:JOTFORM_API_KEY="your-api-key"
 *   npm run relay
 *   # or: node scripts/relay.js
 */

const http = require('http');
const handler = require('../api/submit.js');

const PORT = parseInt(process.env.PORT || '8080', 10);

const server = http.createServer((req, res) => {
  // Polyfill Express-style helper methods on Node's native res/req for handler compatibility
  res.status = function(code) {
    this.statusCode = code;
    return this;
  };
  res.json = function(data) {
    this.setHeader('Content-Type', 'application/json');
    this.end(JSON.stringify(data));
    return this;
  };

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/health') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      status: 'ok',
      service: 'quizzitch-indigenous-relay',
      jotformConfigured: Boolean(process.env.JOTFORM_API_KEY),
      port: PORT,
    }));
  }

  if (url.pathname === '/api/submit' || url.pathname === '/api/quizzitch-submit') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        req.body = body ? JSON.parse(body) : {};
      } catch (_) {
        req.body = body;
      }
      handler(req, res);
    });
    return;
  }

  res.statusCode = 404;
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`[quizzitch-relay] Indigenous Webhook Relay running at http://localhost:${PORT}/api/submit`);
  console.log(`[quizzitch-relay] Health check at http://localhost:${PORT}/api/health`);
  if (!process.env.JOTFORM_API_KEY) {
    console.warn(`[quizzitch-relay] WARNING: JOTFORM_API_KEY environment variable is not set!`);
  }
});
