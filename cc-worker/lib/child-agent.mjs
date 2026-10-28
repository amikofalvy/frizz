import { fork, spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, connect } from 'node:net';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve, isAbsolute, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, copyFileSync, readFileSync, writeFileSync, renameSync, appendFileSync, openSync, closeSync, chmodSync, realpathSync, existsSync, unlinkSync, readdirSync } from 'node:fs';

export const VERSION = 1;
const ownFile = fileURLToPath(import.meta.url);
const terminal = (state) => !['starting', 'running'].includes(state.status);
const toolItems = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'imageGeneration', 'collabAgentToolCall', 'computerUse']);
const excerpt = (value) => value === undefined ? undefined : (typeof value === 'string' ? value : JSON.stringify(value)).slice(-32_768);

function withConfigStore(request, env) {
  if (request.action !== 'start' && request.action !== undefined) return request;
  const selected = request.runtime === 'claude' ? env.CLAUDE_CONFIG_DIR : env.CODEX_HOME;
  const executable = request.executable ?? (env.PATH ?? '').split(delimiter).map((directory) => join(directory, request.runtime ?? '')).find((path) => existsSync(path));
  return { ...request, ...(executable ? { executable: resolve(executable) } : {}), config_dir: request.config_dir !== undefined ? request.config_dir : selected ? resolve(selected) : null };
}

export function readState(dir) {
  return JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
}

function validate(request) {
  if (request.version !== VERSION) throw new Error('Unsupported child-agent protocol version');
  if (!['claude', 'codex'].includes(request.runtime)) throw new Error('runtime must be claude or codex');
  for (const key of ['id', 'model', 'effort', 'prompt', 'cwd', 'run_dir', 'permissions']) {
    if (typeof request[key] !== 'string' || !request[key]) throw new Error(`${key} is required`);
  }
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(request.id)) throw new Error('Invalid child id');
  if (!isAbsolute(request.cwd) || !isAbsolute(request.run_dir)) throw new Error('cwd and run_dir must be absolute');
  if (!['read-only', 'workspace-write', 'full'].includes(request.permissions)) throw new Error('Invalid permissions');
  if (request.runtime === 'claude' && request.permissions === 'workspace-write') throw new Error('Claude does not expose the Codex workspace-write sandbox; choose an explicitly authorized supported mode');
  if (request.config_dir !== null && (typeof request.config_dir !== 'string' || !isAbsolute(request.config_dir))) throw new Error('config_dir must be an absolute path or null for the default store');
  if (request.executable !== undefined && (typeof request.executable !== 'string' || !isAbsolute(request.executable))) throw new Error('executable must be an absolute path');
}

export async function launch(request, options = {}) {
  request = withConfigStore(request, process.env);
  validate(request);
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Child-agent protocol v1 requires macOS or Linux');
  mkdirSync(request.run_dir, { mode: 0o700 });
  writeFileSync(join(request.run_dir, 'request.json'), JSON.stringify(request), { mode: 0o600, flag: 'wx' });
  const script = join(request.run_dir, 'agent.mjs');
  copyFileSync(ownFile, script);
  writeFileSync(join(request.run_dir, 'helper.json'), JSON.stringify({ source: ownFile, sha256: createHash('sha256').update(readFileSync(script)).digest('hex'), node: process.version }), { mode: 0o600 });
  return startSupervisor(request.run_dir, undefined, options.host ? ownFile : undefined);
}

function startSupervisor(dir, resumePath, trustedScript) {
  const errors = openSync(join(dir, 'supervisor.stderr'), 'a', 0o600);
  const child = fork(trustedScript ?? join(dir, 'agent.mjs'), ['serve', dir, ...(resumePath ? [resumePath] : [])], { detached: true, stdio: ['ignore', 'ignore', errors, 'ipc'] });
  closeSync(errors);
  return new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Child supervisor exited before acknowledgement (${code})`)));
    child.once('message', (message) => {
      if (child.connected) child.disconnect();
      child.unref();
      if (message.error) reject(new Error(message.error));
      else accept(message.state);
    });
  });
}

export async function resume(request, options = {}) {
  if (request.version !== VERSION || typeof request.request_id !== 'string' || !request.request_id || typeof request.text !== 'string' || !request.text.trim()) throw new Error('resume requires protocol version, request_id and text');
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Child-agent protocol v1 requires macOS or Linux');
  const state = readState(request.run_dir);
  if (request.id && request.id !== state.id) throw new Error('Child identity does not match the resume handle');
  const records = join(request.run_dir, 'resumes');
  const history = existsSync(records) ? readdirSync(records).map((name) => JSON.parse(readFileSync(join(records, name), 'utf8'))) : [];
  const prior = history.find((entry) => entry.request_id === request.request_id);
  if (prior) {
    if (prior.text !== request.text) throw new Error('Resume request_id was already used with different input');
    if (state.generation >= prior.generation) return Promise.resolve(state);
    throw new Error('Resume outcome is unresolved; inspect the existing run rather than starting another writer');
  }
  if (history.some((entry) => entry.generation > state.generation)) throw new Error('Another resume already owns the next generation; inspect its outcome');
  if (state.alive || !terminal(state)) throw new Error('The recorded runtime has not closed; use message or inspect its existing control channel');
  if (!state.session_id || !state.capabilities.resume) throw new Error('The recorded child cannot safely resume its native session');
  if (existsSync(join(request.run_dir, 'closing')) && readFileSync(join(request.run_dir, 'closing'), 'utf8') !== 'closed') throw new Error('The recorded branch has not finished stopping');
  mkdirSync(records, { recursive: true, mode: 0o700 });
  const record = join(records, `${state.generation + 1}.json`);
  writeFileSync(record, JSON.stringify({ request_id: request.request_id, text: request.text, generation: state.generation + 1, session_id: state.session_id }), { flag: 'wx', mode: 0o600 });
  return startSupervisor(request.run_dir, record, options.host ? ownFile : undefined);
}

export function control(dir, request) {
  const state = readState(dir);
  if (request.id && request.id !== state.id) throw new Error('Child identity does not match the control handle');
  if (!state.alive && ['wait', 'stop'].includes(request.action)) {
    const records = join(dir, 'resumes');
    if (existsSync(records) && readdirSync(records).some((name) => JSON.parse(readFileSync(join(records, name), 'utf8')).generation > state.generation)) throw new Error('A resume is pending; inspect it before declaring this runtime closed');
    return Promise.resolve({ state });
  }
  return new Promise((accept, reject) => {
    const socket = connect(state.socket);
    socket.once('error', (error) => {
      if (request.action === 'wait') {
        try {
          const latest = readState(dir);
          if (!latest.alive && terminal(latest)) return accept({ state: latest });
        } catch (cause) { return reject(cause); }
      }
      reject(error);
    });
    const lines = createInterface({ input: socket });
    lines.once('error', reject);
    let answered = false;
    lines.once('line', (line) => {
      answered = true;
      socket.end();
      try {
        const response = JSON.parse(line);
        if (response.error) reject(new Error(response.error));
        else accept(response);
      } catch (error) { reject(error); }
    });
    socket.once('close', () => { if (!answered) reject(new Error('Child control channel closed without a receipt')); });
    socket.once('connect', () => socket.write(`${JSON.stringify({ version: VERSION, ...request })}\n`));
  });
}

export function hostCall(command, request, env = process.env) {
  return new Promise((accept, reject) => {
    const child = execFile(command[0], command.slice(1), { env, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`${error.message}${stderr ? `: ${stderr.trim()}` : ''}`));
      try { accept(JSON.parse(stdout)); } catch (cause) { reject(new Error('Host adapter returned an invalid receipt', { cause })); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export async function route(request, env = process.env, options = {}) {
  const explicitExecutable = request.executable;
  request = withConfigStore(request, env);
  if (!env.NEST_AGENT_HOST && env.FRIZZ_CHILD_AGENTS_PROTOCOL && env.FRIZZ_CHILD_AGENTS_PROTOCOL !== '1') throw new Error('Unsupported advertised Frizz child-agent protocol');
  if (!env.NEST_AGENT_HOST && (env.FRIZZ_THREAD_SLUG || env.FRIZZ_THREAD) && !env.FRIZZ_CHILD_AGENTS_PROTOCOL) throw new Error('Frizz has not advertised child-agent protocol 1; keep the recorded standalone nesting workflow or explicitly select a verified host adapter');
  if (env.NEST_AGENT_HOST || env.FRIZZ_CHILD_AGENTS_PROTOCOL === '1') {
    if (explicitExecutable === undefined) delete request.executable;
    const command = env.NEST_AGENT_HOST ? JSON.parse(env.NEST_AGENT_HOST) : ['frizzctl', 'child', '--input', '-'];
    if (!Array.isArray(command) || !command.length || command.some((part) => typeof part !== 'string')) throw new Error('NEST_AGENT_HOST must be a JSON argv array');
    if (!isAbsolute(command[0])) command[0] = (env.PATH ?? '').split(delimiter).map((directory) => join(directory, command[0])).find((path) => existsSync(path)) ?? command[0];
    return hostCall(command, { request: { version: VERSION, ...request, helper: ownFile, ...(request.action === 'start' ? { host_argv: command } : {}) } }, env);
  }
  if (request.action === 'start') return launch(request, options);
  if (request.action === 'resume') return resume(request, options);
  if (request.action === 'status') return readState(request.run_dir);
  return control(request.run_dir, request);
}

function childEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('FRIZZ_') && !key.startsWith('CLAUDE_CODE_MESSAGING') && !['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'NEST_AGENT_HOST', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_ENV_FILE', 'CLAUDE_SUBTREE_RESOLUTION', 'CLAUDE_LANDSCAPE_FILE'].includes(key) && !(key.startsWith('CLAUDE_') && key.endsWith('_DIR') && key !== 'CLAUDE_CONFIG_DIR')));
}

async function serve(dir, resumePath) {
  const request = JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8'));
  validate(request);
  const previous = resumePath ? readState(dir) : undefined;
  const resuming = resumePath ? JSON.parse(readFileSync(resumePath, 'utf8')) : undefined;
  const socketPath = join(tmpdir(), `nested-${createHash('sha256').update(dir).digest('hex').slice(0, 24)}.sock`);
  const state = { version: VERSION, id: request.id, runtime: request.runtime, model: request.model, effort: request.effort, label: request.label || request.id, parent_id: request.parent_id, run_dir: dir, socket: socketPath, started_at: previous?.started_at ?? new Date().toISOString(), status: 'starting', generation: resuming?.generation ?? 1, completed_generation: previous?.completed_generation ?? 0, alive: true, capabilities: { message: true, stop: true, wait: true, resume: true }, result: '' };
  state.config_dir = request.config_dir;
  state.permissions = request.permissions;
  state.executable = request.executable;
  if (resuming) state.session_id = resuming.session_id;
  if (request.parent_agent_id) state.parent_agent_id = request.parent_agent_id;
  const waiters = new Set();
  const receipts = new Map();
  let sequence = previous?.last_event_seq ?? 0;
  let processHandle;
  let stopping = false;
  let protocolFailed = false;
  const pending = new Map();
  let rpcId = 0;
  const claudeGenerations = [state.generation];

  function publish() {
    state.updated_at = new Date().toISOString();
    const temporary = join(dir, 'state.json.tmp');
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    renameSync(temporary, join(dir, 'state.json'));
    for (const waiter of waiters) {
      if (terminal(state) && (state.completed_generation > waiter.after || !state.alive)) {
        waiter.reply({ state });
        waiters.delete(waiter);
      }
    }
  }

  function event(kind, fields) {
    appendFileSync(join(dir, 'events.jsonl'), `${JSON.stringify({ version: VERSION, seq: ++sequence, at: new Date().toISOString(), kind, ...fields })}\n`, { mode: 0o600 });
    state.last_event_seq = sequence;
  }

  function finish(status, result, error) {
    if (protocolFailed && status !== 'closed') return;
    const wasSettled = terminal(state);
    const priorFinishedAt = state.finished_at;
    if (status !== 'closed' || !wasSettled) state.outcome = status === 'closed' ? 'killed' : status;
    state.status = status;
    state.result = result.slice(-65_536);
    state.result_truncated = result.length > 65_536;
    state.error = error;
    state.completed_generation = state.generation;
    state.finished_at = status === 'closed' && wasSettled ? priorFinishedAt : new Date().toISOString();
    event('settled', { status, generation: state.generation });
    publish();
  }

  function rpc(method, params) {
    const id = ++rpcId;
    return new Promise((accept, reject) => {
      pending.set(id, { accept, reject, method });
      processHandle.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  function userMessage(text) {
    event('message', { role: 'user', text });
    processHandle.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`);
  }

  async function codexTurn(text) {
    const input = [{ type: 'text', text, text_elements: [] }];
    event('message', { role: 'user', text });
    if (state.status === 'running' && state.turn_id) {
      await rpc('turn/steer', { threadId: state.session_id, expectedTurnId: state.turn_id, input });
      return;
    }
    state.status = 'running';
    state.result = '';
    state.error = undefined;
    publish();
    const response = await rpc('turn/start', { threadId: state.session_id, input, model: request.model, effort: request.effort });
    state.turn_id = response.turn.id;
    publish();
  }

  const server = createServer((socket) => {
    socket.on('error', () => socket.destroy());
    const lines = createInterface({ input: socket });
    const reply = (value) => { if (!socket.destroyed) socket.end(`${JSON.stringify(value)}\n`); };
    lines.once('line', async (line) => {
      try {
        const input = JSON.parse(line);
        if (input.version !== VERSION) throw new Error('Unsupported child-agent protocol version');
        if (input.action === 'status') return reply({ state });
        if (input.action === 'wait') {
          const after = input.after ?? 0;
          if (!Number.isSafeInteger(after) || after < 0) throw new Error('after must be a nonnegative generation');
          if (terminal(state) && (state.completed_generation > after || !state.alive)) return reply({ state });
          const waiter = { after, reply };
          waiters.add(waiter);
          socket.once('close', () => waiters.delete(waiter));
          return;
        }
        if (input.action === 'message') {
          if (typeof input.request_id !== 'string' || !input.request_id) throw new Error('message requires request_id');
          if (receipts.has(input.request_id)) return reply(await receipts.get(input.request_id));
          if (typeof input.text !== 'string' || !input.text.trim()) throw new Error('message requires text');
          if (stopping || !state.alive || state.status === 'starting') throw new Error('Child is not ready to accept messages');
          const receipt = { delivery: 'accepted', request_id: input.request_id };
          const delivery = Promise.resolve().then(async () => {
            if (request.runtime === 'claude') {
              claudeGenerations.push(++state.generation);
              state.status = 'running';
              publish();
              userMessage(input.text);
            } else {
              if (state.status !== 'running') ++state.generation;
              await codexTurn(input.text);
            }
            return receipt;
          });
          receipts.set(input.request_id, delivery);
          try { reply(await delivery); } catch (error) { receipts.delete(input.request_id); throw error; }
          return;
        }
        if (input.action === 'stop') {
          const closed = state.alive ? new Promise((accept) => processHandle.once('close', accept)) : Promise.resolve();
          if (!stopping) {
            stopping = true;
            let sent = false;
            let force;
            const terminate = () => {
              if (sent) return;
              sent = true;
              if (processHandle.exitCode === null && processHandle.signalCode === null) {
                processHandle.kill('SIGTERM');
                force = setTimeout(() => { if (processHandle.exitCode === null && processHandle.signalCode === null) processHandle.kill('SIGKILL'); }, 5000);
              }
            };
            const interruptDeadline = setTimeout(terminate, 5000);
            processHandle.once('close', () => { clearTimeout(interruptDeadline); clearTimeout(force); });
            if (request.runtime === 'codex' && state.status === 'running' && state.turn_id) {
              try { await rpc('turn/interrupt', { threadId: state.session_id, turnId: state.turn_id }); }
              catch (error) { event('control', { name: 'interrupt-unavailable', error: error.message }); }
            }
            clearTimeout(interruptDeadline);
            terminate();
          }
          await closed;
          publish();
          reply({ state });
          server.close();
          return;
        }
        throw new Error('Unknown child operation');
      } catch (error) { reply({ error: error.message }); }
    });
  });
  server.on('error', (error) => { process.send?.({ error: error.message }); process.exitCode = 1; });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(socketPath, accept); });
  chmodSync(socketPath, 0o600);
  publish();
  if (resuming && existsSync(join(dir, 'closing')) && readFileSync(join(dir, 'closing'), 'utf8') === 'closed') unlinkSync(join(dir, 'closing'));
  const heartbeat = setInterval(publish, 5000);
  heartbeat.unref();
  process.send?.({ state });
  const args = request.runtime === 'claude'
    ? ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', request.model, '--effort', request.effort, ...(resuming ? ['--resume', resuming.session_id] : []), ...(request.permissions === 'full' ? ['--dangerously-skip-permissions'] : ['--safe-mode', '--setting-sources', 'user', '--settings', '{"disableAllHooks":true}', '--permission-prompts', 'none', '--permission-mode', 'plan', '--tools', 'Read,Grep,Glob', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'])]
    : ['app-server', ...(request.permissions === 'full' ? [] : ['--disable', 'hooks', '--disable', 'plugins', '--disable', 'apps'])];
  const environment = childEnvironment();
  const storeKey = request.runtime === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
  if (request.config_dir === null) delete environment[storeKey];
  else environment[storeKey] = request.config_dir;
  if (request.host_argv) environment.NEST_AGENT_HOST = JSON.stringify([process.execPath, join(dir, 'agent.mjs'), 'forward', dir]);
  processHandle = spawn(request.executable || request.runtime, args, { cwd: request.cwd, env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
  processHandle.stderr.on('data', (data) => appendFileSync(join(dir, 'runtime.stderr'), data, { mode: 0o600 }));
  processHandle.stdin.on('error', (error) => { if (!stopping) finish('failed', state.result, error.message); });
  processHandle.on('error', (error) => finish('failed', '', error.message));
  processHandle.on('close', (code, signal) => {
    clearInterval(heartbeat);
    state.alive = false;
    for (const call of pending.values()) call.reject(new Error(`Runtime exited (${code ?? signal})`));
    pending.clear();
    if (stopping) finish('closed', state.result);
    else if (!terminal(state)) finish('failed', state.result, `Runtime exited without settling (${code ?? signal})`);
    else publish();
    server.close();
  });
  createInterface({ input: processHandle.stdout }).on('line', (line) => {
    if (protocolFailed) return;
    try {
      const data = JSON.parse(line);
      const privateConfig = data.id !== undefined && !data.method && pending.get(data.id)?.method === 'config/read';
      if (!privateConfig) appendFileSync(join(dir, 'runtime.jsonl'), `${line}\n`, { mode: 0o600 });
      if (request.runtime === 'claude') {
        if (resuming && data.session_id && data.session_id !== resuming.session_id) {
          state.capabilities.resume = false;
          throw new Error('Native resume returned a different session identity');
        }
        if (data.session_id) state.session_id = data.session_id;
        if (data.type === 'assistant') for (const content of data.message.content) {
          if (content.type === 'text') { state.result += content.text; event('message', { role: 'assistant', text: content.text }); }
          if (content.type === 'tool_use') event('tool', { id: content.id, name: content.name, input: excerpt(content.input) });
        }
        if (data.type === 'user' && Array.isArray(data.message?.content)) for (const content of data.message.content) {
          if (content.type === 'tool_result') event('tool-result', { id: content.tool_use_id, output: excerpt(content.content), status: content.is_error ? 'failed' : 'completed' });
        }
        if (data.type === 'result') {
          state.completed_generation = claudeGenerations.shift() ?? state.generation;
          if (claudeGenerations.length) publish();
          else finish(data.is_error || data.permission_denials?.length ? 'failed' : 'completed', data.result || state.result, data.is_error ? JSON.stringify(data.errors) : undefined);
        }
      } else if (data.id !== undefined && !data.method) {
        const call = pending.get(data.id);
        if (call) { pending.delete(data.id); data.error ? call.reject(new Error(data.error.message)) : call.accept(data.result); }
      } else if (data.id !== undefined) {
        processHandle.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: data.id, error: { code: -32601, message: 'Interactive approvals are not supported by this child adapter' } })}\n`);
      } else if (data.method === 'item/agentMessage/delta') {
        state.result += data.params.delta;
        event('message', { role: 'assistant', text: data.params.delta });
      } else if (data.method === 'turn/completed') {
        const turn = data.params.turn;
        finish(turn.status === 'completed' && !state.error ? 'completed' : 'failed', state.result, turn.error?.message ?? state.error);
      } else if (data.method === 'error' && data.params.willRetry === false) {
        finish('failed', state.result, data.params.error.message);
      } else if (data.method === 'item/started' && toolItems.has(data.params.item.type)) {
        event('tool', { id: data.params.item.id, name: data.params.item.type, input: excerpt(data.params.item) });
      } else if (data.method === 'item/completed' && toolItems.has(data.params.item.type)) {
        const item = data.params.item;
        event('tool-result', { id: item.id, name: item.type, output: excerpt(item.aggregatedOutput ?? item), status: item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0) ? 'failed' : 'completed' });
      }
      publish();
    } catch (error) {
      finish('failed', state.result, 'Invalid runtime event; inspect the runtime diagnostics');
      protocolFailed = true;
      processHandle.kill('SIGTERM');
    }
  });
  if (request.runtime === 'claude') {
    state.status = 'running'; publish(); userMessage(resuming?.text ?? request.prompt);
  } else {
    try {
      await rpc('initialize', { clientInfo: { name: 'child-agents', version: '1' }, capabilities: { experimentalApi: true } });
      processHandle.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
      let config;
      if (request.permissions !== 'full') {
        try {
          const inspected = await rpc('config/read', { includeLayers: true, cwd: request.cwd });
          if (!inspected.config || typeof inspected.config !== 'object' || Array.isArray(inspected.config)) throw new Error('Configuration unavailable');
          if (!Array.isArray(inspected.layers)) throw new Error('Configuration provenance unavailable');
          const session = inspected.layers.find((layer) => layer.name?.type === 'sessionFlags')?.config ?? {};
          if (typeof session !== 'object' || Array.isArray(session) || session === null) throw new Error('Session configuration unavailable');
          const servers = inspected.config.mcp_servers ?? {};
          if (typeof servers !== 'object' || Array.isArray(servers) || servers === null) throw new Error('External tool configuration unavailable');
          const disabledServers = Object.entries(servers).map(([name, server]) => {
            if (!server || typeof server !== 'object' || Array.isArray(server)) throw new Error('Invalid external tool configuration');
            const transport = typeof server.url === 'string' ? { url: 'http://127.0.0.1:1/disabled' } : { command: process.execPath, args: ['--eval', 'process.exit(1)'] };
            return [name, { enabled: false, ...transport }];
          });
          config = { ...session, notify: [], mcp_servers: Object.fromEntries(disabledServers), 'features.apps': false, 'features.plugins': false, 'features.hooks': false };
        } catch { throw new Error('Cannot establish the requested external-tool restrictions'); }
      }
      const response = await rpc(resuming ? 'thread/resume' : 'thread/start', { ...(resuming ? { threadId: resuming.session_id } : {}), ...(config ? { config } : {}), model: request.model, cwd: request.cwd, approvalPolicy: 'never', sandbox: request.permissions === 'full' ? 'danger-full-access' : request.permissions });
      if (resuming && response.thread.id !== resuming.session_id) { state.capabilities.resume = false; throw new Error('Native resume returned a different session identity'); }
      const expectedSandbox = { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', full: 'dangerFullAccess' }[request.permissions];
      if (response.sandbox?.type !== expectedSandbox || (request.permissions !== 'full' && response.sandbox.networkAccess !== false)) throw new Error('Native runtime did not establish the requested sandbox');
      state.session_id = response.thread.id;
      await codexTurn(resuming?.text ?? request.prompt);
    } catch (error) {
      if (!stopping) finish('failed', '', error.message);
      if (processHandle.exitCode === null && processHandle.signalCode === null) processHandle.kill('SIGTERM');
    }
  }
}

if (process.argv[1] && existsSync(process.argv[1]) && pathToFileURL(realpathSync(resolve(process.argv[1]))).href === import.meta.url) {
  try {
    if (process.argv[2] === 'serve') await serve(process.argv[3], process.argv[4]);
    else if (process.argv.includes('--help')) process.stdout.write('Child-agent protocol v1\nUsage: node agent.mjs [--local] < request.json\nActions: start, status, message, wait, stop, resume\nStart requires version, id, runtime, model, effort, permissions, prompt, cwd, run_dir\nmessage and resume require run_dir, request_id, text; wait accepts after (completed generation)\nNEST_AGENT_HOST selects a host argv; advertised Frizz protocol 1 selects Frizz automatically\n');
    else {
      let body = '';
      for await (const chunk of process.stdin) body += chunk;
      const request = JSON.parse(body);
      let response;
      if (process.argv[2] === 'forward') {
        const parent = JSON.parse(readFileSync(join(process.argv[3], 'request.json'), 'utf8'));
        if (!parent.host_argv || !parent.host_env) throw new Error('This child has no parent host adapter');
        const forwarded = { ...request.request, helper: ownFile, ...(request.request.action === 'start' ? { parent_agent_id: parent.id, host_argv: parent.host_argv } : {}) };
        response = await hostCall(parent.host_argv, { request: forwarded }, { ...childEnvironment(), ...parent.host_env });
      } else response = await route(request, process.argv.includes('--local') || process.argv.includes('--host') ? {} : process.env, { host: process.argv.includes('--host') });
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
