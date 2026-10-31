import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { parseEnv } from 'node:util';
import { parse } from 'yaml';
import { codexModelArgs } from './app-server.mjs';

const root = process.env.SYMPHONY_PROJECT_ROOT;
const version = 'v0.0.3';
const asset = `symphony-${version}-macos_arm64`;
const sha256 = 'b85d78b25cd5cacff92424416f6a3af7cafee5d675f56b5cd26d22d601c2026d';
const binary = path.join(homedir(), '.local/share/symphony', version, asset);
const secretFile = path.join(root, '.symphony.env');
const workflowFile = path.join(root, 'WORKFLOW.md');
try {
  const saved = parseEnv(await readFile(secretFile, 'utf8'));
  for (const [key, value] of Object.entries(saved)) process.env[key] ??= value;
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
process.env.SYMPHONY_WORKSPACE_ROOT ||= path.join(homedir(), '.local/share/symphony/workspaces/harness-study');
process.env.SYMPHONY_WORKSPACE_ROOT = path.resolve(process.env.SYMPHONY_WORKSPACE_ROOT);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) throw new Error(`${command} 执行失败${result.error ? `: ${result.error.message}` : ''}`);
  return result.stdout?.trim();
}

async function verifyBinary() {
  const digest = createHash('sha256').update(await readFile(binary)).digest('hex');
  if (digest !== sha256) throw new Error('Symphony SHA-256 不匹配，请重新安装。');
  await access(binary, 1);
}

async function install() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('此安装器固定为 macOS Apple Silicon；其他平台请使用官方 release 对应包。');
  }
  await mkdir(path.dirname(binary), { recursive: true });
  try {
    await verifyBinary();
    console.log(`Symphony ${version} 已安装，SHA-256 正确。`);
    return;
  } catch { /* Download and validate before replacing. */ }
  const response = await fetch(`https://github.com/openai/symphony/releases/download/${version}/${asset}`, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(data).digest('hex') !== sha256) throw new Error('下载文件 SHA-256 不匹配。');
  const temporary = `${binary}.${process.pid}.tmp`;
  await writeFile(temporary, data, { mode: 0o755 });
  await rename(temporary, binary);
  console.log(`已安装 Symphony ${version}: ${binary}`);
}

async function saveKey() {
  if (process.platform !== 'darwin') throw new Error('隐藏输入窗口需要 macOS。可自行设置 LINEAR_API_KEY 环境变量。');
  const result = spawnSync('osascript', ['-e', 'text returned of (display dialog "输入 harness-study 的 Linear Personal API Key（仅保存在本机，不会显示到聊天）" default answer "" with hidden answer buttons {"取消", "保存"} default button "保存")'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('已取消保存凭据。');
  const key = result.stdout.trim();
  if (!/^lin_api_[A-Za-z0-9_-]+$/.test(key)) throw new Error('格式不正确，需要 Linear Personal API Key。');
  await writeFile(secretFile, `LINEAR_API_KEY=${key}\n`, { mode: 0o600 });
  await chmod(secretFile, 0o600);
  console.log('Linear Key 已保存到 .symphony.env（权限 600，Git 已忽略）。');
}

async function checkCodex() {
  const codex = process.env.SYMPHONY_CODEX_BIN || run('which', ['codex']);
  process.env.SYMPHONY_CODEX_BIN = codex;
  const child = spawn(codex, [...codexModelArgs(), 'app-server'], { cwd: root, stdio: ['pipe', 'pipe', 'ignore'] });
  return new Promise((resolve, reject) => {
    let settled = false;
    let authDescription;
    const lines = createInterface({ input: child.stdout });
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      child.kill('SIGTERM');
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Codex App Server 握手超时。')), 30_000);
    child.on('error', error => finish(error));
    child.on('exit', () => finish(new Error('Codex App Server 在握手完成前退出。')));
    child.stdin.on('error', error => finish(error));
    const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (![1, 2, 3].includes(message.id)) return;
      if (message.error) return finish(new Error('Codex App Server 返回协议错误。'));
      if (message.id === 1) {
        send({ method: 'initialized', params: {} });
        send({ id: 2, method: 'account/read', params: {} });
      } else if (message.id === 2) {
        const { account, requiresOpenaiAuth } = message.result || {};
        if (!account && requiresOpenaiAuth !== false) return finish(new Error('Codex 需要登录：运行 codex login，或配置有效的自定义服务。'));
        authDescription = requiresOpenaiAuth === false ? '自定义服务，无需 OpenAI 登录' : '已登录';
        // Custom providers can use model IDs absent from Codex's bundled catalog.
        if (requiresOpenaiAuth === false) return finish(null, authDescription);
        send({ id: 3, method: 'model/list', params: { includeHidden: true } });
      } else {
        const model = JSON.parse(codexModelArgs()[1].slice('model='.length));
        if (!message.result?.data?.some(item => item.model === model || item.id === model)) {
          return finish(new Error(`模型目录未包含 ${model}；请设置 SYMPHONY_CODEX_MODEL 为当前账号可用模型。`));
        }
        finish(null, `${authDescription}；模型目录包含 ${model}（不代表已验证推理权限）`);
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'harness_symphony_doctor', version: '1.0.0' }, capabilities: {} } });
  });
}

async function checkLinear(config) {
  const key = process.env.LINEAR_API_KEY;
  if (!key) throw new Error('缺少 LINEAR_API_KEY：运行 npm run symphony:key 或在启动终端设置环境变量。');
  const response = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: key },
    body: JSON.stringify({
      query: 'query($slug: String!) { projects(first: 1, filter: {slugId: {eq: $slug}}) { nodes { name slugId teams(first: 5) { nodes { states(first: 30) { nodes { name } } } } } } }',
      variables: { slug: config.tracker.provider.project_slug },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.errors?.length) {
    const detail = result?.errors?.map(error => String(error.message)).join('; ') || response.statusText;
    throw new Error(`Linear 请求失败：HTTP ${response.status} — ${detail.replaceAll(key, '[REDACTED]').slice(0, 300)}`);
  }
  if (!result?.data) throw new Error('Linear 返回了无效的 GraphQL 响应。');
  const project = result.data?.projects?.nodes?.[0];
  if (!project) throw new Error('Linear Key 无权读取配置的项目，或项目 slug 不正确。');
  const states = new Set(project.teams.nodes.flatMap(team => team.states.nodes.map(state => state.name)));
  for (const state of [...config.tracker.active_states, 'In Review', 'Blocked', 'Done']) {
    if (!states.has(state)) throw new Error(`Linear 缺少工作流状态：${state}`);
  }
  return project.name;
}

async function doctor() {
  let failed = false;
  const check = async (label, fn) => {
    try { await fn(); console.log(`OK ${label}`); }
    catch (error) { failed = true; console.error(`FAIL ${label}: ${error.message}`); }
  };
  const source = await readFile(workflowFile, 'utf8');
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) throw new Error('WORKFLOW.md 缺少 YAML front matter。');
  const config = parse(frontmatter[1]);
  console.log(`Node ${process.version}; 工作区 ${process.env.SYMPHONY_WORKSPACE_ROOT}`);
  await check('Symphony v0.0.3 / SHA-256', verifyBinary);
  await check('git / bd', () => { run('git', ['--version']); run('bd', ['--version']); });
  await check('工作流', () => {
    if (config.tracker.kind !== 'linear' || !config.tracker.provider.project_slug ||
        !config.tracker.required_labels?.includes('symphony') ||
        !Number.isInteger(config.agent?.max_concurrent_agents) || config.agent.max_concurrent_agents < 1 ||
        ['In Review', 'Blocked'].some(state => config.tracker.active_states.includes(state)) ||
        config.tracker.terminal_states.includes('Blocked') ||
        config.codex.thread_sandbox !== 'workspace-write' ||
        config.codex.turn_sandbox_policy?.type !== 'workspaceWrite') throw new Error('工作流不符合本项目初始调度约定。');
  });
  await check('Codex App Server（仅握手，不调用模型）', async () => { console.log(`  ${await checkCodex()}`); });
  await check('Linear 项目与状态（只读）', async () => { console.log(`  ${await checkLinear(config)}`); });
  return !failed;
}

try {
  const command = process.argv[2] || 'doctor';
  if (command === 'install') await install();
  else if (command === 'key') await saveKey();
  else if (command === 'doctor') process.exitCode = (await doctor()) ? 0 : 1;
  else if (command === 'start') {
    if (!(await doctor())) throw new Error('启动检查未通过，未启动任务调度。');
    const logs = path.join(root, '.symphony/log');
    await mkdir(logs, { recursive: true });
    await mkdir(process.env.SYMPHONY_WORKSPACE_ROOT, { recursive: true });
    console.log('Symphony 前台运行：http://127.0.0.1:4000；Ctrl+C 停止。');
    const child = spawn(binary, [workflowFile, '--logs-root', logs,
      '--i-understand-that-this-will-be-running-without-the-usual-guardrails'], { cwd: root, stdio: 'inherit' });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
    child.on('error', error => { console.error(error.message); process.exitCode = 1; });
    child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); });
  } else throw new Error('用法：install | key | doctor | start');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
