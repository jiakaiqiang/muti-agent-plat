import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

type PickerRunner = (
  command: string,
  args: string[]
) => Promise<{ stdout: string; stderr?: string }>;

const execFileAsync = promisify(execFile);

const defaultRunner: PickerRunner = async (command, args) => {
  const result = await execFileAsync(command, args, {
    encoding: 'utf8',
    windowsHide: shouldHideChildWindow(command),
    timeout: 120_000
  });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
};

export async function selectWorkspaceDirectory(
  title = '选择 Agent Runtime 授权工作目录',
  platform = process.platform,
  run: PickerRunner = defaultRunner
): Promise<string | undefined> {
  const command = directoryPickerCommand(platform, title);
  try {
    const result = await run(command.command, command.args);
    const selected = result.stdout.trim();
    return selected || undefined;
  } catch (error) {
    if (isPickerCancellation(error)) return undefined;
    if (isPickerTimeout(error)) {
      throw new Error('LOCAL_DIRECTORY_PICKER_TIMEOUT: 本机目录选择窗口超时未完成，请确认 Local Runtime 运行在当前桌面会话，并重新选择。');
    }
    throw error;
  }
}

export function directoryPickerCommand(platform: NodeJS.Platform, title: string) {
  if (platform === 'win32') {
    const escapedTitle = title.replace(/'/g, "''");
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      `$dialog.Description = '${escapedTitle}'`,
      '$dialog.ShowNewFolderButton = $true',
      '$result = $dialog.ShowDialog()',
      "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Write-Output $dialog.SelectedPath }"
    ].join('; ');
    return { command: 'powershell.exe', args: ['-NoProfile', '-STA', '-Command', script] };
  }
  if (platform === 'darwin') {
    return {
      command: 'osascript',
      args: ['-e', `POSIX path of (choose folder with prompt ${JSON.stringify(title)})`]
    };
  }
  return { command: 'zenity', args: ['--file-selection', '--directory', `--title=${title}`] };
}

function isPickerCancellation(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === '1';
}

function isPickerTimeout(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ETIMEDOUT' || code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
}

function shouldHideChildWindow(command: string) {
  return !/powershell(?:\.exe)?$/i.test(command);
}
