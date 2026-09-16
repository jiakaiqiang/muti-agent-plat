import { build, Platform, Arch } from 'electron-builder';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const projectDir = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
// Reuse the exact Electron binary installed by this workspace, including its verified download.
const electronDist = dirname(require('electron'));
const release = process.argv.includes('--release');
const { updateUrl } = JSON.parse(await readFile(new URL('../dist/release.json', import.meta.url), 'utf8'));
const publisher = process.env.AGENT_CLUSTER_PUBLISHER_NAME?.trim();
if (release && (!updateUrl || !publisher || (!process.env.CSC_LINK && !process.env.WIN_CSC_LINK))) {
  throw new Error('正式发布包需要 AGENT_CLUSTER_UPDATE_URL、AGENT_CLUSTER_PUBLISHER_NAME 和 CSC_LINK/WIN_CSC_LINK 签名证书；请先重新 build。');
}
await build({
  projectDir,
  targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
  publish: 'never',
  config: {
    appId: 'com.agentcluster.desktop', productName: 'Agent Cluster',
    electronDist,
    extraMetadata: { desktopRelease: { updateUrl: release ? updateUrl : '', publisherName: release ? publisher : '' } },
    directories: { output: '../../output/desktop' },
    files: ['dist/**/*', 'package.json'],
    asar: true, asarUnpack: ['dist/runtime-worker.cjs'],
    npmRebuild: false, forceCodeSigning: release,
    artifactName: 'Agent-Cluster-Setup-${version}-${arch}.${ext}',
    win: { target: ['nsis'], ...(publisher ? { signtoolOptions: { publisherName: publisher } } : {}) },
    nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false },
    ...(updateUrl ? { publish: [{ provider: 'generic', url: updateUrl }] } : {})
  }
});
