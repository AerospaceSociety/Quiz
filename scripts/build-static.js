import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function deepMergeInto(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) target[key] = {};
      deepMergeInto(target[key], value);
    } else {
      target[key] = value;
    }
  }
}

export function buildStatic(outputDirectory = path.join(root, 'dist')) {
  const output = path.resolve(outputDirectory);
  if (output === root || output === path.parse(output).root) throw new Error('Refusing to replace a project or filesystem root.');
  if (existsSync(output) && lstatSync(output).isSymbolicLink()) throw new Error('Refusing to build through a dist symlink.');
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });

  for (const file of ['index.html', 'admin.html', '_headers']) {
    copyFileSync(path.join(root, file), path.join(output, file));
  }

  for (const directory of ['scripts', 'styles']) {
    const source = path.join(root, directory);
    const target = path.join(output, directory);
    mkdirSync(target, { recursive: true });
    const extension = directory === 'scripts' ? '.js' : '.css';
    for (const file of readdirSync(source).filter((name) => path.extname(name) === extension
      && !(directory === 'scripts' && name === 'build-static.js'))) {
      copyFileSync(path.join(source, file), path.join(target, file));
    }
  }

  const configDirectory = path.join(output, 'config');
  mkdirSync(configDirectory, { recursive: true });

  const rawSettings = JSON.parse(readFileSync(path.join(root, 'config', 'settings.json'), 'utf8'));

  // Merge local overrides (config/settings.local.json) if present
  const localSettingsPath = path.join(root, 'config', 'settings.local.json');
  if (existsSync(localSettingsPath)) {
    try {
      const localSettings = JSON.parse(readFileSync(localSettingsPath, 'utf8'));
      deepMergeInto(rawSettings, localSettings);
    } catch (e) {
      console.warn('[build-static] failed to parse settings.local.json:', e.message);
    }
  }

  // Parse .dev.vars or .env files if present for build-time environment variables
  const envVars = { ...process.env };
  for (const envFile of ['.dev.vars', '.env', '.env.local']) {
    const p = path.join(root, envFile);
    if (existsSync(p)) {
      try {
        const lines = readFileSync(p, 'utf8').split(/\r?\n/);
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const idx = trimmed.indexOf('=');
          if (idx > 0) {
            const key = trimmed.slice(0, idx).trim();
            const val = trimmed.slice(idx + 1).trim();
            if (!(key in envVars)) envVars[key] = val;
          }
        }
      } catch (_) {}
    }
  }

  // Inject Firebase environment variables into dist settings if provided
  if (rawSettings.firebase) {
    if (envVars.FIREBASE_API_KEY) rawSettings.firebase.apiKey = envVars.FIREBASE_API_KEY;
    if (envVars.FIREBASE_AUTH_DOMAIN) rawSettings.firebase.authDomain = envVars.FIREBASE_AUTH_DOMAIN;
    if (envVars.FIREBASE_PROJECT_ID) rawSettings.firebase.projectId = envVars.FIREBASE_PROJECT_ID;
    if (envVars.FIREBASE_STORAGE_BUCKET) rawSettings.firebase.storageBucket = envVars.FIREBASE_STORAGE_BUCKET;
    if (envVars.FIREBASE_MESSAGING_SENDER_ID) rawSettings.firebase.messagingSenderId = envVars.FIREBASE_MESSAGING_SENDER_ID;
    if (envVars.FIREBASE_APP_ID) rawSettings.firebase.appId = envVars.FIREBASE_APP_ID;
    if (envVars.FIREBASE_MEASUREMENT_ID) rawSettings.firebase.measurementId = envVars.FIREBASE_MEASUREMENT_ID;
  }

  writeFileSync(path.join(configDirectory, 'settings.json'), JSON.stringify(rawSettings, null, 2) + '\n', 'utf8');

  if (existsSync(path.join(output, 'config', 'questions.json'))) throw new Error('Private question bank entered the static build.');
  if (existsSync(path.join(output, 'config', 'settings.local.json'))) throw new Error('Local settings file entered the static build.');
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`Built public static assets in ${buildStatic()}\n`);
}
