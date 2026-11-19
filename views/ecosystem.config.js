module.exports = {
  apps: [{
    name: 'bookvault',
    script: 'server.js',
    cwd: __dirname,
    instances: 1,            // SQLite: keep a single instance
    max_memory_restart: '700M',
    env: { NODE_ENV: 'production' },
  }],
};
