const app = require('../server');

module.exports = (req, res) => {
  // If Vercel stripped the /api prefix when routing to api/index.js, restore it
  if (!req.url.startsWith('/api')) {
    req.url = '/api' + (req.url.startsWith('/') ? req.url : '/' + req.url);
  }
  return app(req, res);
};
