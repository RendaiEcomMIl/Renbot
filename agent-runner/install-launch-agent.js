import { mkdir,writeFile,chmod } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const home=os.homedir();
const runner=fileURLToPath(new URL('./runner.js',import.meta.url));
const config=path.join(home,'.config','renbot','runner.json');
const logs=path.join(home,'Library','Logs','Renbot');
await mkdir(logs,{recursive:true,mode:0o700});
await mkdir(path.join(home,'Library','LaunchAgents'),{recursive:true});
const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const plist=`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.rendai.renbot-agent</string>
<key>ProgramArguments</key><array><string>/usr/bin/caffeinate</string><string>-i</string><string>${escape(process.execPath)}</string><string>${escape(runner)}</string><string>${escape(config)}</string></array>
<key>WorkingDirectory</key><string>${escape(path.dirname(runner))}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${escape(path.join(home,'.local','bin'))}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer>
<key>StandardOutPath</key><string>${escape(path.join(logs,'runner.log'))}</string>
<key>StandardErrorPath</key><string>${escape(path.join(logs,'runner-error.log'))}</string>
</dict></plist>\n`;
const target=path.join(home,'Library','LaunchAgents','com.rendai.renbot-agent.plist');
await writeFile(target,plist,{mode:0o600});
console.log('Prepared com.rendai.renbot-agent. This script does not activate the service.');
