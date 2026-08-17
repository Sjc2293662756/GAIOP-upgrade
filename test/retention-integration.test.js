'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

function parseEnvironment(source) {
  const values = new Map();
  for (const line of source.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    assert.notEqual(separator, -1, `invalid environment line: ${line}`);
    const key = line.slice(0, separator);
    assert.equal(values.has(key), false, `duplicate environment key: ${key}`);
    values.set(key, line.slice(separator + 1));
  }
  return values;
}

test('Upgrade retention switches remain off and backup roots stay separate', () => {
  const environment = parseEnvironment(read('deploy/env/gaiop-upgrade.env.example'));
  assert.equal(environment.get('GAIOP_UPGRADE_RETENTION_AUTO_DELETE'), 'false');
  assert.equal(environment.get('GAIOP_UPGRADE_SQLITE_BACKUP_CREATE_ENABLED'), 'false');
  assert.equal(environment.get('GAIOP_UPGRADE_SQLITE_BACKUP_CLEANUP_ENABLED'), 'false');

  const rollbackRoot = path.posix.normalize(environment.get('NAPM_UPGRADE_BACKUP_ROOT'));
  const sqliteRoot = path.posix.normalize(environment.get('GAIOP_UPGRADE_SQLITE_BACKUP_DIR'));
  assert.notEqual(rollbackRoot, sqliteRoot);
  assert.equal(sqliteRoot.startsWith(`${rollbackRoot}/`), false);
  assert.equal(rollbackRoot.startsWith(`${sqliteRoot}/`), false);
});

test('Upgrade retention runtime manifest contains every fixed entry point and unit', () => {
  const manifest = JSON.parse(read('deploy/retention-runtime-manifest.json'));
  const allEntries = [manifest.environmentExample, ...manifest.runtimeScripts, ...manifest.systemdUnits];
  assert.equal(new Set(allEntries).size, allEntries.length);
  for (const relativePath of allEntries) {
    assert.equal(fs.existsSync(path.join(root, relativePath)), true, relativePath);
  }

  const services = manifest.systemdUnits.filter((name) => name.endsWith('.service'));
  const execTargets = new Set();
  for (const servicePath of services) {
    const source = read(servicePath);
    const match = source.match(/^ExecStart=\/usr\/local\/bin\/node \/opt\/gaiop\/upgrade\/(.+)$/m);
    assert.ok(match, servicePath);
    assert.equal(manifest.runtimeScripts.includes(match[1]), true, match[1]);
    assert.equal(execTargets.has(match[1]), false, `duplicate ExecStart: ${match[1]}`);
    execTargets.add(match[1]);
  }

  const sqliteService = read('deploy/systemd/gaiop-upgrade-sqlite-backup.service');
  assert.doesNotMatch(sqliteService, /\/var\/backups\/gaiop\/upgrade/);
  assert.match(sqliteService, /^ReadWritePaths=\/var\/lib\/gaiop\/upgrade\/sqlite-backups$/m);
});

test('component rollback protection and SQLite backup cleanup do not call each other', () => {
  const retentionRunner = read('src/services/RetentionRunner.js');
  const sqliteBackup = read('src/services/SqliteBackupService.js');
  assert.doesNotMatch(retentionRunner, /SqliteBackupService|sqlite-backups/);
  assert.doesNotMatch(sqliteBackup, /BackupCleaner|RetentionRunner|\/var\/backups\/gaiop\/upgrade/);
});
