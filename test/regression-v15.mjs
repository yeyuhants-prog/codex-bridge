import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { getDataDir, getJobsPath, getSettingsPath, loadSettings, saveSettings } from "../server/settings-store.js";
import { writeJsonAtomic } from "../server/file-store.js";
import { reserveGoalDispatch, abandonGoalDispatch, createGoal, updateMilestone, addMilestone, getGoal, recordGoalExecution, updateGoalStatus } from "../server/goal-store.js";
import { acquireSessionLock, getSessionLockPath, inspectSessionLock, releaseSessionLock, updateSessionLockPid } from "../server/session-lock.js";
import { JobManager, claimCallback, beginCallbackSend, finishCallback, readPersistedJobs, reconcilePersistedJobs } from "../server/job-manager.js";
import { validateBooleans } from "../server/validation.js";
import { resolveResume, workingDirectory } from "../server/run-policy.js";
import { resolveCodexBinary, runCodex } from "../server/codex-runner.js";

const exec = promisify(execFile);
const repo = fileURLToPath(new URL("../", import.meta.url));
let temp;
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-v15-"));
  process.env.CODEX_BRIDGE_DATA_DIR = temp;
  process.env.CODEX_HOME = path.join(temp, "codex-home");
  fs.mkdirSync(process.env.CODEX_HOME);
  process.env.CODEX_BIN = path.join(temp, "worker cli 测试.mjs");
});
afterEach(() => fs.rmSync(temp, {recursive:true, force:true}));

function worker(source, args = []) {
  return exec(process.execPath, ["--input-type=module", "-e", source, ...args],
    {cwd: repo, env: process.env, windowsHide:true, timeout:30000});
}

test("concurrent goal and settings transactions preserve independent mutations", async () => {
  const goal = createGoal({ title:"parallel" });
  await Promise.all(["en","high","read-only","plan_first"].map((v,i) => worker(`
    import { addMilestone } from "./server/goal-store.js";
    import { saveSettings } from "./server/settings-store.js";
    const [id,key,value] = process.argv.slice(1);
    saveSettings({[key]:value});
    for(let i=0;i<6;i++) addMilestone(id,{title:key+i});
  `, [goal.id, ["language","reasoningEffort","sandbox","workflowMode"][i],v])));
  assert.equal(getGoal(goal.id).milestones.length,24);
  const settings=loadSettings();
  assert.deepEqual([settings.language,settings.reasoningEffort,settings.sandbox,settings.workflowMode],
    ["en","high","read-only","plan_first"]);
});

test("malformed stores preserve evidence, settings fail closed, job writes surface errors", () => {
  fs.writeFileSync(getSettingsPath(),"{invalid");
  assert.equal(loadSettings().sandbox,"read-only");
  saveSettings({language:"en"});
  assert.equal(loadSettings().sandbox,"read-only");
  assert.ok(fs.readdirSync(temp).some(f=>f.startsWith("settings.json.corrupt.")));
  fs.writeFileSync(getJobsPath(),"{}");
  assert.throws(readPersistedJobs,/corrupt/i);
  assert.equal(fs.readFileSync(getJobsPath(),"utf8"),"{}");
});

test("only one process obtains a session lease; stale tokens cannot change the successor", async () => {
  const sid=crypto.randomUUID();
  const source = `
    import { acquireSessionLock } from "./server/session-lock.js";
    const [sid,owner] = process.argv.slice(1);
    console.log(JSON.stringify(acquireSessionLock(sid,{ownerPid:Number(owner)})));
  `;
  const calls=await Promise.all(Array.from({length:5},()=>worker(source,[sid,String(process.pid)])));
  const winners=calls.map(r=>JSON.parse(r.stdout)).filter(r=>r.acquired);
  assert.equal(winners.length,1);
  assert.equal(getSessionLockPath(sid),getSessionLockPath(sid.toUpperCase()));
  const token=winners[0].ownerToken;
  assert.equal(releaseSessionLock(sid,token),true);
  const next=acquireSessionLock(sid);
  assert.equal(updateSessionLockPid(sid,token,process.pid),false);
  assert.equal(releaseSessionLock(sid,token),false);
  assert.ok(inspectSessionLock(sid).locked);
  assert.ok(releaseSessionLock(sid,next.ownerToken));
  const file=getSessionLockPath(sid);
  fs.writeFileSync(file,"");
  assert.equal(acquireSessionLock(sid).acquired,false);
  fs.utimesSync(file,new Date(0),new Date(0));
  assert.equal(acquireSessionLock(sid).acquired,true);
});

test("callback claims are exclusive; expired and uncertain deliveries have distinct recovery", async () => {
  const id="test";
  writeJsonAtomic(getJobsPath(),[{id,status:"completed",notifyOnComplete:true,callbackStatus:"pending"}]);
  const claims=await Promise.all(Array.from({length:4},()=>worker(`
    import {claimCallback} from "./server/job-manager.js";
    try { console.log(claimCallback("test").callbackClaim); } catch(err) { if(err.status!==409) throw err; }
  `)));
  const tokens=claims.map(c=>c.stdout.trim()).filter(Boolean);
  assert.equal(tokens.length,1);
  const expire=()=>{const rows=readPersistedJobs();rows[0].callbackLeaseUntil=new Date(0).toISOString();writeJsonAtomic(getJobsPath(),rows);};
  expire();
  const next=claimCallback(id);
  assert.notEqual(next.callbackClaim,tokens[0]);
  assert.throws(()=>finishCallback(id,tokens[0],{}),/lease/i);
  beginCallbackSend(id,next.callbackClaim);
  expire();
  assert.equal(claimCallback(id).callbackStatus,"failed");
  const retry=claimCallback(id,true);
  finishCallback(id,retry.callbackClaim,{callbackStatus:"sent",callbackSent:true});
  assert.throws(()=>claimCallback(id,true),/eligible/i);
});

test("retention protects every active or undelivered record and reconciles dead children", () => {
  const archived=Array.from({length:65},(_,i)=>({id:"old"+i,status:"completed",callbackSent:true}));
  const keep=["pending","failed","sending","unrouted"].map(s=>({id:s,status:"completed",callbackStatus:s,notifyOnComplete:true}));
  const active=["running","stopping","running_detached"].map(status=>({id:status,status}));
  const dead={id:"child-exited",startedAt:new Date(0).toISOString(),ownerPid:process.pid,pid:null,status:"running"};
  writeJsonAtomic(getJobsPath(),[...archived,...keep,...active,dead]);
  reconcilePersistedJobs(new Set(active.map(j=>j.id)));
  const rows=readPersistedJobs();
  for(const j of [...keep,...active]) assert.ok(rows.some(r=>r.id===j.id));
  // Reconciliation can archive the interrupted job; place it first to check its terminal state.
  writeJsonAtomic(getJobsPath(),[dead]);
  assert.equal(reconcilePersistedJobs()[0].status,"interrupted");
  assert.equal(rows.filter(r=>r.id.startsWith("old")).length,50);
});

test("goal reopens, pauses at its budget and can resume with a new budget", () => {
  const g=createGoal({title:"goal",milestones:["one"],maxIterations:1});
  const update=status=>updateMilestone(g.id,"m1",{status}).goal.status;
  assert.equal(update("done"),"completed");
  assert.equal(update("blocked"),"active");
  assert.equal(update("done"),"completed");
  assert.equal(addMilestone(g.id,{title:"two"}).goal.status,"active");
  assert.equal(recordGoalExecution(g.id).status,"paused");
  assert.throws(()=>recordGoalExecution(g.id),/paused/i);
  updateGoalStatus(g.id,"active");
  assert.equal(recordGoalExecution(g.id).iterationCount,2);
  const other = createGoal({title:"existing goal",maxIterations:12});
  saveSettings({maxAutoIterations:1});
  assert.equal(recordGoalExecution(other.id).status,"paused");
});

test("bare SID uses a known baseline or read-only; permission and cwd input are validated", () => {
  const sid=crypto.randomUUID();
  saveSettings({sandbox:"danger-full-access"});
  const opts={sessionId:sid.toUpperCase(),cwd:temp};
  const prior={sessionId:sid,cwd:temp,sandbox:"workspace-write",addDirs:[temp]};
  assert.equal(resolveResume(opts,[]).sandbox,"read-only");
  assert.equal(resolveResume(opts,[prior]).sandbox,"workspace-write");
  assert.equal(resolveResume(opts,[prior]).sessionId,sid);
  assert.throws(()=>resolveResume({...opts,sandbox:"workspace-write"},[]),/widen/i);
  assert.equal(resolveResume({...opts,allowSandboxEscalation:true,sandbox:"workspace-write"},[]).sandbox,"workspace-write");
  assert.throws(()=>resolveResume({...opts,sessionId:"last"},[]),/uuid/i);
  for(const key of ["transferCallback","keepOriginalCallback","notify_on_complete","skip_git_repo_check","ephemeral"])
    assert.throws(()=>validateBooleans({[key]:"false"}),/boolean/);
  assert.throws(()=>workingDirectory(),/cwd/);
  assert.equal(workingDirectory(undefined,{cwd:temp}),temp);
});

test("startup failure releases a reserved session; foreign jobs without matching identity cannot be stopped", async () => {
  const sid=crypto.randomUUID();
  const g=createGoal({title:"paused"});
  updateGoalStatus(g.id,"paused");
  const manager=new JobManager();
  assert.throws(()=>manager.startJob({prompt:"test",mode:"resume",cwd:temp,sessionId:sid,goalId:g.id}),/paused/);
  assert.equal(inspectSessionLock(sid).locked,false);
  assert.deepEqual(readPersistedJobs(),[]);
  const child=spawn(process.execPath,["-e","setTimeout(()=>{},30000)"],{windowsHide:true,stdio:"ignore"});
  try {
    writeJsonAtomic(getJobsPath(),[{id:"foreign",status:"running_detached",pid:child.pid,ownerPid:0,
      processIdentity:{pid:child.pid,started:"other",name:"node"}}]);
    assert.equal((await manager.stopJob("foreign")).cancelled,false);
    assert.doesNotThrow(()=>process.kill(child.pid,0));
  } finally { child.kill(); }
});

test("NDJSON protocol, review sandbox, limits and startup bookkeeping", async () => {
  const cli=process.env.CODEX_BIN;
  fs.writeFileSync(cli,`
    if(process.argv.includes("--help")){console.log("Usage: codex exec review");process.exit(0)}
    let input="";for await(const chunk of process.stdin) input+=chunk;
    const emit=type=>console.log(JSON.stringify({type}));
    emit("turn.started");
    if(input==="bad") console.log("null");
    if(input==="huge") process.stdout.write("x".repeat(3*1024*1024));
    if(input!=="missing") emit("turn.completed");
    if(input==="after") emit("error");
  `);
  const run=(prompt,extra={})=>runCodex({mode:"run",cwd:temp,sandbox:"read-only",prompt,...extra});
  assert.equal((await run("ok")).ok,true);
  for(const input of ["bad","huge","missing","after"]) assert.equal((await run(input)).ok,false,input);
  const review=await run("ok",{mode:"review"});
  assert.equal(review.sandbox,"read-only");
  assert.deepEqual(review.cliArgs.slice(0,6),["exec","-C",temp,"-s","read-only","review"]);
  process.env.CODEX_BIN = path.join(temp, "review-legacy.mjs");
  fs.writeFileSync(process.env.CODEX_BIN, 'if(process.argv.includes("--help"))process.exit(2); process.stdin.resume();process.stdin.on("end",()=>console.log(JSON.stringify({type:"turn.completed"})));');
  const legacy = await run("ok", {mode:"review"});
  assert.equal(legacy.ok, true);
  assert.equal(legacy.sandbox, "cli-default");
  assert.ok(!legacy.cliArgs.includes("-s"));
  process.env.CODEX_BIN = cli;
  const failed=await run("ok",{onSpawn(){throw new Error("simulated disk error")}});
  assert.equal(failed.ok,false);
  assert.match(failed.errors.join(" "),/bookkeeping/i);
  fs.writeFileSync(path.join(temp,"shim.cmd"),"");
  if(process.platform==="win32") {
    process.env.CODEX_BIN=path.join(temp,"shim.cmd");
    assert.equal(resolveCodexBinary(),null);
  }
});

test("owned cancellation waits for exit and preserves a cancelled terminal status", async () => {
  fs.writeFileSync(process.env.CODEX_BIN,'process.stdin.resume(); setTimeout(()=>{},30000);');
  const manager=new JobManager();
  const {job}=manager.startJob({prompt:"wait",cwd:getDataDir()});
  await new Promise(resolve=>setImmediate(resolve));
  const pid=job.pid;
  assert.ok(pid);
  assert.equal((await manager.stopJob(job.id)).cancelled,true);
  assert.equal(readPersistedJobs()[0].status,"cancelled");
  assert.throws(()=>process.kill(pid,0));
});

test("unstarted goal dispatch frees its budget, while concurrent reservations respect the last slot", async () => {
  const goal = createGoal({title:"one slot",maxIterations:1});
  const reservation = reserveGoalDispatch(goal.id);
  assert.throws(() => reserveGoalDispatch(goal.id), /limit/);
  abandonGoalDispatch(goal.id, reservation);
  const manager = new JobManager();
  // This temporary CLI entry does not exist. No real CLI should be discovered.
  const {job} = manager.startJob({prompt:"record initialization failure",cwd:temp,goalId:goal.id});
  await job.promise;
  assert.equal(readPersistedJobs()[0].status, "failed");
  const state = getGoal(goal.id);
  assert.equal(state.iterationCount, 0);
  assert.equal(state.pendingDispatches.length, 0);
  assert.equal(state.status, "active");
});

test("timeout closes the owned CLI and its long-running child", async () => {
  const marker = path.join(temp, "descendant.pid");
  fs.writeFileSync(process.env.CODEX_BIN, `
    import fs from "node:fs";
    import {spawn} from "node:child_process";
    import path from "node:path";
    const descendant=spawn(process.execPath,["-e","setTimeout(()=>{},30000)"],{stdio:"ignore",windowsHide:true});
    fs.writeFileSync(path.join(process.cwd(),"descendant.pid"),String(descendant.pid));
    process.stdin.resume();
    setTimeout(()=>{},30000);
  `);
  const result = await runCodex({mode:"run",cwd:temp,prompt:"wait",timeoutMs:1200});
  assert.equal(result.timedOut,true);
  assert.equal(result.ok,false);
  const pid = Number(fs.readFileSync(marker,"utf8"));
  // On Linux a killed grandchild may remain a zombie until reaped by init.
  if (process.platform === "linux" && fs.existsSync("/proc/" + pid + "/stat")) {
    assert.match(fs.readFileSync("/proc/" + pid + "/stat","utf8"),/\) Z /);
  } else assert.throws(() => process.kill(pid, 0));
});
