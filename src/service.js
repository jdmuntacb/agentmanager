// Registers the daemon to start at login so agents come back after a reboot.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from './config.js';
import { run } from './git.js';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agentmgr.js');
const LABEL = process.env.AGENTMGR_SERVICE_LABEL || 'com.agentmgr.daemon';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const UNIT_NAME = `${LABEL.replace(/^com\./, '').replace(/\./g, '-')}.service`;
const UNIT = path.join(os.homedir(), '.config', 'systemd', 'user', UNIT_NAME);

/** First `node` on PATH (e.g. /opt/homebrew/bin/node), which survives node upgrades unlike the Cellar path. */
function nodePath() {
  for (const dir of (process.env.PATH || '').split(':')) {
    const candidate = path.join(dir, 'node');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return process.execPath;
}

/**
 * The daemon runs through your login + interactive shell so agents get the same
 * environment as your terminal (PATH, tokens exported in ~/.zshrc, ...). `exec`
 * replaces the shell so the service manager supervises node directly.
 */
function command() {
  const shell = process.env.SHELL || '/bin/zsh';
  const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  return [shell, '-l', '-i', '-c', `exec ${q(nodePath())} ${q(BIN)} serve`];
}

function passEnv() {
  const env = {};
  for (const key of ['AGENTMGR_HOME', 'AGENTMGR_PORT']) if (process.env[key]) env[key] = process.env[key];
  return env;
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function plist() {
  const env = passEnv();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${command().map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <!-- Restart after a crash, but not after "agentmgr shutdown" (clean exit). -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>WorkingDirectory</key><string>${xml(os.homedir())}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join('\n')}
  </dict>
  <key>StandardOutPath</key><string>${xml(paths.log)}</string>
  <key>StandardErrorPath</key><string>${xml(paths.log)}</string>
</dict>
</plist>
`;
}

function unit() {
  const env = Object.entries(passEnv()).map(([k, v]) => `Environment=${k}=${v}\n`).join('');
  const cmd = command().map((a) => `"${a.replace(/(["\\])/g, '\\$1')}"`).join(' ');
  return `[Unit]
Description=Agent Manager daemon (background Claude Code agents)

[Service]
ExecStart=${cmd}
Restart=on-failure
${env}StandardOutput=append:${paths.log}
StandardError=append:${paths.log}

[Install]
WantedBy=default.target
`;
}

const uid = () => process.getuid();

export async function install() {
  fs.mkdirSync(paths.home, { recursive: true });
  if (process.platform === 'darwin') {
    fs.mkdirSync(path.dirname(PLIST), { recursive: true });
    await run('launchctl', ['bootout', `gui/${uid()}/${LABEL}`]).catch(() => {});
    fs.writeFileSync(PLIST, plist());
    await run('launchctl', ['bootstrap', `gui/${uid()}`, PLIST]);
    return { file: PLIST, manager: 'launchd' };
  }
  if (process.platform === 'linux') {
    fs.mkdirSync(path.dirname(UNIT), { recursive: true });
    fs.writeFileSync(UNIT, unit());
    await run('systemctl', ['--user', 'daemon-reload']);
    await run('systemctl', ['--user', 'enable', '--now', UNIT_NAME]);
    return {
      file: UNIT,
      manager: 'systemd',
      note: 'To start it at boot without logging in, run: loginctl enable-linger $USER',
    };
  }
  throw new Error(`Login service is not supported on ${process.platform}`);
}

export async function uninstall() {
  if (process.platform === 'darwin') {
    await run('launchctl', ['bootout', `gui/${uid()}/${LABEL}`]).catch(() => {});
    fs.rmSync(PLIST, { force: true });
    return { file: PLIST };
  }
  if (process.platform === 'linux') {
    await run('systemctl', ['--user', 'disable', '--now', UNIT_NAME]).catch(() => {});
    fs.rmSync(UNIT, { force: true });
    await run('systemctl', ['--user', 'daemon-reload']).catch(() => {});
    return { file: UNIT };
  }
  throw new Error(`Login service is not supported on ${process.platform}`);
}

export async function status() {
  if (process.platform === 'darwin') {
    const installed = fs.existsSync(PLIST);
    const loaded = await run('launchctl', ['print', `gui/${uid()}/${LABEL}`]).then(() => true, () => false);
    return { installed, loaded, file: PLIST };
  }
  if (process.platform === 'linux') {
    const installed = fs.existsSync(UNIT);
    const loaded = await run('systemctl', ['--user', 'is-active', UNIT_NAME]).then(() => true, () => false);
    return { installed, loaded, file: UNIT };
  }
  return { installed: false, loaded: false, file: null };
}

/** Start the service-managed daemon now (after "agentmgr shutdown", launchd won't on its own). */
export async function kickstart() {
  if (process.platform === 'darwin') return run('launchctl', ['kickstart', `gui/${uid()}/${LABEL}`]);
  if (process.platform === 'linux') return run('systemctl', ['--user', 'start', UNIT_NAME]);
  throw new Error(`Login service is not supported on ${process.platform}`);
}
