import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const WORKDIR = process.cwd();

export interface BashResult {
  status: 'completed' | 'failed';
  result: string;
}

export async function executeBash(command: string): Promise<BashResult> {
  try {
    const { stdout, stderr } = await execAsync(command, { cwd: WORKDIR, timeout: 120000 });
    const out = (stdout + stderr).trim();
    return { status: 'completed', result: out ? out.slice(0, 50000) : '(no output)' };
  } catch (error: any) {
    return {
      status: 'failed',
      result: error.killed ? 'Error: Timeout (120s)' : `Error: ${error.message}`,
    };
  }
}

export async function runBash(command: string): Promise<string> {
  return (await executeBash(command)).result;
}
