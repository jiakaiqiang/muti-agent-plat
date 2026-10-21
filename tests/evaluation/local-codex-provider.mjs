import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Evaluation-only transport. No production settings or credentials are changed.
export async function startLocalCodexProvider(out) {
  const cwd = await mkdtemp(resolve(tmpdir(), 'intent-real-codex-'));
  const calls = [];
  const cli = process.env.INTENT_EVAL_CODEX_JS ?? resolve(process.env.USERPROFILE, '.local/codex-cli/node_modules/@openai/codex/bin/codex.js');
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/models') { res.end(JSON.stringify({data:[{id:'local-codex'}]})); return; }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    let body = ''; for await (const part of req) body += part;
    const request = JSON.parse(body);
    const index = calls.length + 1;
    const record = {index, startedAt:new Date().toISOString(), request, promptHash:createHash('sha256').update(body).digest('hex')};
    calls.push(record);
    console.log(JSON.stringify({providerCall:index,event:'codex_started'}));
    const prompt = 'Process the following application messages as an intent classifier. Return only the requested JSON. Do not use tools, inspect files, or execute commands.\n' + request.messages.map(m=>`<${m.role}>\n${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}\n</${m.role}>`).join('\n');
    const args = [cli,'exec','--json','--ephemeral','--skip-git-repo-check','--sandbox','read-only','-C',cwd,'-c','features.shell_tool=false','-c','features.apps=false','-c','mcp_servers.node_repl.enabled=false','-'];
    try {
      const result = await new Promise((resolvePromise,reject) => {
        const child=spawn(process.execPath,args,{cwd,windowsHide:true,stdio:['pipe','pipe','pipe']});
        let stdout='',stderr='';
        const timer=setTimeout(()=>{child.kill();reject(Error('CODEX_EVALUATION_TIMEOUT'));},150000);
        child.stdout.on('data',x=>{stdout+=x;void appendFile(resolve(out,`provider-${index}.jsonl`),x);}); child.stderr.on('data',x=>stderr+=x);
        child.on('error',e=>{clearTimeout(timer);reject(e);});
        child.on('close',code=>{clearTimeout(timer);resolvePromise({code,stdout,stderr});});
        child.stdin.end(prompt);
      });
      const events=result.stdout.split(/\r?\n/).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
      record.events=events; record.exitCode=result.code;
      const items=events.filter(e=>e.type==='item.completed').map(e=>e.item);
      if(items.some(i=>!['agent_message','reasoning','error'].includes(i.type)))throw Error('CODEX_TOOL_USE_CONTAMINATED_SAMPLE');
      const content=items.filter(i=>i.type==='agent_message').at(-1)?.text;
      if(result.code!==0||!content)throw Error('CODEX_FAILED: '+result.stderr.slice(-1000));
      record.output=content; record.usage=events.find(e=>e.type==='turn.completed')?.usage;
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({id:`codex-eval-${index}`,object:'chat.completion',created:Math.floor(Date.now()/1000),model:'local-codex',choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}]}));
    } catch(error) { record.error=String(error); res.writeHead(502,{'Content-Type':'application/json'}).end(JSON.stringify({error:{message:record.error}})); }
    finally { record.finishedAt=new Date().toISOString(); await writeFile(resolve(out,`provider-${index}.json`),JSON.stringify(record,null,2)); }
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {baseUrl:`http://127.0.0.1:${server.address().port}/v1`,calls,close:()=>new Promise(r=>server.close(r))};
}
