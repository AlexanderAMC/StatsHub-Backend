const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { getJwtSecret } = require('../src/config/jwt');

const ORIGINAL = process.env.JWT_SECRET;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = ORIGINAL;
});

test('getJwtSecret lanza error si JWT_SECRET no está definido', () => {
  delete process.env.JWT_SECRET;
  assert.throws(() => getJwtSecret(), /JWT_SECRET/);
});

test('getJwtSecret lanza error si JWT_SECRET es demasiado corto', () => {
  process.env.JWT_SECRET = 'corto';
  assert.throws(() => getJwtSecret(), /al menos 32/);
});

test('getJwtSecret devuelve el secreto cuando es válido', () => {
  process.env.JWT_SECRET = 'a'.repeat(48);
  assert.equal(getJwtSecret(), 'a'.repeat(48));
});

test('el servidor no arranca sin JWT_SECRET (sale con código 1)', () => {
  const result = spawnSync(process.execPath, ['src/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    // Cadena vacía: dotenv no sobrescribe variables ya definidas, así que el .env local no interfiere.
    env: { ...process.env, JWT_SECRET: '', PORT: '0' },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stderr, /JWT_SECRET/);
});
