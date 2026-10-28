import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { control, launch, readState, route, resume } from '../cc-worker/lib/child-agent.mjs';
import { execFile } from 'node:child_process';
const unixTest = process.platform === 'win32' ? test.skip : test;

async function runtimeFixture(t, runtime, source, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'child-protocol-'));
  const executable = join(dir, runtime);
  await writeFile(executable, '#!/usr/bin/env node\n' + source, { mode: 0o700 });
  let state;
  t.after(async () => {
    try { if (state && readState(state.run_dir).alive) await control(state.run_dir, { action: 'stop' }); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });
  state = await launch({ version: 1, id: 'protocol', runtime, model: 'fixture', effort: 'low', permissions: 'read-only', prompt: 'first', cwd: dir, run_dir: join(dir, 'run'), executable, ...extra });
  return state;
}

unixTest('a child has durable identity, streams results, accepts followups and stops only its own runtime', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'child-agent-'));
  let owned;
  t.after(async () => {
    try {
      if (owned && readState(owned.run_dir).alive) await control(owned.run_dir, { action: 'stop' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  const executable = join(dir, 'claude');
  await writeFile(executable, `#!/usr/bin/env node
import {createInterface} from 'node:readline';
if(!process.argv.includes('--safe-mode')||process.argv[process.argv.indexOf('--setting-sources')+1]!=='user'||process.argv[process.argv.indexOf('--tools')+1]!=='Read,Grep,Glob')throw new Error('unsafe startup profile');
const lines=createInterface({input:process.stdin});
for await (const line of lines) {
  const input=JSON.parse(line);
  process.stdout.write(JSON.stringify({type:'assistant',session_id:'fixture-session',message:{content:[{type:'text',text:input.message.content}]}})+'\\n');
  process.stdout.write(JSON.stringify({type:'result',session_id:'fixture-session',is_error:false,result:input.message.content})+'\\n');
}
`, { mode: 0o700 });
  const child = await launch({ version: 1, id: 'case-one', runtime: 'claude', model: 'fixture', effort: 'low', permissions: 'read-only', prompt: 'first', cwd: dir, run_dir: join(dir, 'run'), executable });
  owned = child;
  assert.equal(child.id, 'case-one');
  const first = await control(child.run_dir, { action: 'wait', after: 0 });
  assert.equal(first.state.status, 'completed');
  assert.equal(first.state.result, 'first');
  assert.equal(first.state.session_id, 'fixture-session');
  const sent = await control(child.run_dir, { action: 'message', text: 'second', request_id: 'message-1' });
  assert.equal(sent.delivery, 'accepted');
  const second = await control(child.run_dir, { action: 'wait', after: first.state.generation });
  assert.equal(second.state.result, 'second');
  assert.equal(second.state.generation, 2);
  await control(child.run_dir, { action: 'message', text: 'second', request_id: 'message-1' });
  assert.equal((await readState(child.run_dir)).generation, 2);
  assert.match(await readFile(join(child.run_dir, 'events.jsonl'), 'utf8'), /second/);
  await control(child.run_dir, { action: 'stop' });
  assert.equal((await readState(child.run_dir)).status, 'closed');
});

test('Frizz failure does not fall through to an untracked standalone launch', async () => {
  await assert.rejects(route({ action: 'start' }, { FRIZZ_THREAD_SLUG: 'parent', NEST_AGENT_HOST: JSON.stringify(['/does/not/exist']) }), /ENOENT/);
});

test('an unadvertised or incompatible Frizz cannot silently select a new launch path', async () => {
  await assert.rejects(route({ action: 'start' }, { FRIZZ_THREAD_SLUG: 'parent' }), /not advertised/);
  await assert.rejects(route({ action: 'start' }, { FRIZZ_CHILD_AGENTS_PROTOCOL: '42' }), /Unsupported advertised/);
});

test('unknown host protocol is rejected before any process starts', async () => {
  await assert.rejects(launch({ version: 42 }), /version/);
});

unixTest('Codex JSON-RPC uses its native session for later turns and reports native failure', async (t) => {
  const state = await runtimeFixture(t, 'codex', `
import {createInterface} from 'node:readline';
const send=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');
for await (const line of createInterface({input:process.stdin})) {
 const call=JSON.parse(line);
 if(call.method==='initialize') send({id:call.id,result:{}});
 if(call.method==='config/read') send({id:call.id,result:{config:{mcp_servers:{'mutating-store':{command:'unused',env:{TOKEN:'PRIVATE_CONFIG_SENTINEL'}},'remote-store':{url:'https://example.invalid/PRIVATE_CONFIG_SENTINEL'}}},layers:[{name:{type:'sessionFlags'},config:{model_provider:'same-account'}}]}});
 if(call.method==='thread/start') {
  if(call.params.config.model_provider!=='same-account'||call.params.config.mcp_servers['mutating-store'].enabled!==false||call.params.config.mcp_servers['remote-store'].url!=='http://127.0.0.1:1/disabled'||call.params.config['features.apps']!==false||call.params.config['features.plugins']!==false||call.params.config['features.hooks']!==false||call.params.config.notify.length) throw new Error('external tools not restricted');
  send({id:call.id,result:{thread:{id:'native-codex'},sandbox:{type:'readOnly',networkAccess:false}}});
 }
 if(call.method==='turn/start') {
  if(call.params.threadId!=='native-codex') throw new Error('wrong target');
  const text=call.params.input[0].text;
  send({id:call.id,result:{turn:{id:'turn'}}});
  send({method:'item/started',params:{item:{type:'userMessage',id:'user'}}});
  send({method:'item/started',params:{item:{type:'agentMessage',id:'assistant'}}});
  send({method:'item/started',params:{item:{type:'commandExecution',id:'command',command:'echo fixture'}}});
  send({method:'item/completed',params:{item:{type:'commandExecution',id:'command',aggregatedOutput:'fixture',exitCode:0,status:'completed'}}});
  send({method:'item/agentMessage/delta',params:{delta:text}});
  send({method:'turn/completed',params:{turn:{status:text==='first'?'completed':'failed',error:{message:'native failure'}}}});
 }
}
`);
  const first = await control(state.run_dir, { action: 'wait', after: 0 });
  assert.equal(first.state.result, 'first');
  assert.equal(first.state.session_id, 'native-codex');
  const events = (await readFile(join(state.run_dir, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.filter((event) => event.kind === 'tool').map((event) => event.name), ['commandExecution']);
  assert.equal(events.find((event) => event.kind === 'tool-result').output, 'fixture');
  assert(!(await readFile(join(state.run_dir, 'runtime.jsonl'), 'utf8')).includes('PRIVATE_CONFIG_SENTINEL'));
  await control(state.run_dir, { action: 'message', text: 'fail', request_id: 'followup' });
  const failed = await control(state.run_dir, { action: 'wait', after: 1 });
  assert.equal(failed.state.status, 'failed');
  assert.equal(failed.state.error, 'native failure');
});

unixTest('concurrent duplicate messages create one queued Claude turn and wait for all accepted work', async (t) => {
  const state = await runtimeFixture(t, 'claude', `
import {createInterface} from 'node:readline';
let first=true;
const send=(value)=>process.stdout.write(JSON.stringify(value)+'\\n');
for await (const line of createInterface({input:process.stdin})) {
 const text=JSON.parse(line).message.content;
 if(first){first=false;continue;}
 send({type:'result',session_id:'native-claude',is_error:false,result:'first'});
 send({type:'result',session_id:'native-claude',is_error:false,result:text});
}
`);
  const receipts = await Promise.all([1, 2].map(() => control(state.run_dir, { action: 'message', text: 'second', request_id: 'same' })));
  assert.deepEqual(receipts[0], receipts[1]);
  const completed = await control(state.run_dir, { action: 'wait', after: 0 });
  assert.equal(completed.state.result, 'second');
  assert.equal(completed.state.generation, 2);
});

unixTest('malformed runtime output cannot be overwritten by a later success record', async (t) => {
  const state = await runtimeFixture(t, 'claude', `
import {createInterface} from 'node:readline';
for await (const line of createInterface({input:process.stdin})) {
 process.stdout.write('invalid json\\n'+JSON.stringify({type:'result',is_error:false,result:'false success'})+'\\n');
}
`);
  const result = await control(state.run_dir, { action: 'wait', after: 0 });
  assert.equal(result.state.status, 'failed');
  assert.match(result.state.error, /Invalid runtime event/);
});

test('the library imports from stdin without treating the stdin marker as a file', async () => {
  const url = new URL('../cc-worker/lib/child-agent.mjs', import.meta.url).href;
  const output = await new Promise((accept, reject) => {
    const child = execFile(process.execPath, ['--input-type=module', '-'], (error, stdout, stderr) => error ? reject(new Error(stderr)) : accept(stdout));
    child.stdin.end(`const m=await import(${JSON.stringify(url)});process.stdout.write(typeof m.launch);`);
  });
  assert.equal(output, 'function');
});

test('Claude workspace isolation is refused instead of substituting a broader approval mode', async () => {
  await assert.rejects(launch({ version: 1, id: 'refused', runtime: 'claude', model: 'fixture', effort: 'low', permissions: 'workspace-write', prompt: 'task', cwd: tmpdir(), run_dir: join(tmpdir(), 'must-not-start') }), /does not expose/);
});

unixTest('a descendant retains scoped host delegation without inheriting the root thread identity', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'child-host-'));
  const adapter = join(dir, 'host.mjs');
  await writeFile(adapter, `let body='';for await(const chunk of process.stdin)body+=chunk;process.stdout.write(JSON.stringify({received:JSON.parse(body),binding:process.env.TEST_HOST_BINDING}));`);
  const state = await runtimeFixture(t, 'claude', `
import {createInterface} from 'node:readline';
for await(const line of createInterface({input:process.stdin})) process.stdout.write(JSON.stringify({type:'result',is_error:false,result:JSON.stringify({host:process.env.NEST_AGENT_HOST,parent:process.env.FRIZZ_THREAD_SLUG??null,config:process.env.CLAUDE_CONFIG_DIR})})+'\\n');
`, { host_argv: [process.execPath, adapter], host_env: { TEST_HOST_BINDING: 'owned-parent' }, config_dir: dir });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const completed = await control(state.run_dir, { action: 'wait', after: 0 });
  const observed = JSON.parse(completed.state.result);
  assert.equal(observed.parent, null);
  assert.equal(observed.config, dir);
  const command = JSON.parse(observed.host);
  const forwarded = await new Promise((accept, reject) => {
    const child = execFile(command[0], command.slice(1), (error, stdout, stderr) => error ? reject(new Error(stderr)) : accept(JSON.parse(stdout)));
    child.stdin.end(JSON.stringify({ request: { version: 1, action: 'start', id: 'leaf', runtime: 'codex' } }));
  });
  assert.equal(forwarded.received.request.parent_agent_id, 'protocol');
  assert.equal(forwarded.received.request.id, 'leaf');
  assert.equal(forwarded.binding, 'owned-parent');
});

unixTest('resume uses the recorded native session, preserves event identities and deduplicates its intent', async (t) => {
  const state = await runtimeFixture(t, 'claude', `
import {createInterface} from 'node:readline';
const at=process.argv.indexOf('--resume');
if(at>=0&&process.argv[at+1]!=='owned-session')throw new Error('wrong native session');
for await(const line of createInterface({input:process.stdin})) process.stdout.write(JSON.stringify({type:'result',session_id:'owned-session',is_error:false,result:(at>=0?'resumed:':'')+JSON.parse(line).message.content})+'\\n');
`);
  const first = await control(state.run_dir, { action: 'wait', after: 0 });
  await assert.rejects(resume({ version: 1, action: 'resume', id: state.id, run_dir: state.run_dir, request_id: 'still-live', text: 'unsafe' }), /has not closed/);
  await control(state.run_dir, { action: 'stop' });
  const request = { version: 1, action: 'resume', id: state.id, run_dir: state.run_dir, request_id: 'resume-once', text: 'second' };
  const restarted = await resume(request);
  assert.equal(restarted.generation, first.state.generation + 1);
  const completed = await control(state.run_dir, { action: 'wait', after: 1 });
  assert.equal(completed.state.session_id, 'owned-session');
  assert.equal(completed.state.result, 'resumed:second');
  assert.equal((await resume(request)).generation, 2);
  await assert.rejects(resume({ ...request, text: 'different' }), /different input/);
  const events = (await readFile(join(state.run_dir, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(new Set(events.map((event) => event.seq)).size, events.length);
});
