import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createScoutEngine, releaseIdleStorage } from "../dist/engine.js";
import { openStorage } from "../dist/storage.js";
import { openConfigStore } from "../dist/config.js";
import { decideQuestions } from "../dist/decisions.js";
import { observeTurnSchema } from "../dist/domain.js";
import { hasPromptExcerpt } from "../dist/privacy.js";

const runtime=path.resolve(import.meta.dirname,"..");
const repository=path.resolve(runtime,"../..");
const fixture=path.join(runtime,"scripts/fixtures/decision-model-natural-2026-10-21");
const archive=path.join(repository,"docs/testing/decision-model-natural-2026-10-21");
const json=async file=>JSON.parse(await readFile(file,"utf8"));
const lines=async file=>(await readFile(file,"utf8")).trim().split("\n").map(JSON.parse);
const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==="object"&&!Array.isArray(item)
  ?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const manifest=await json(path.join(fixture,"manifest.json"));
for(const [file,expected] of Object.entries(manifest.files)) assert.equal(sha(await readFile(path.join(fixture,file))),expected,file);
const cases=(await json(path.join(fixture,"cases.json"))).cases;
const requests=(await json(path.join(fixture,"requests.json"))).requests;
const hosts=(await json(path.join(archive,"host-extractions.json"))).observations;
const profiles=new Map([...(await json(path.join(fixture,"profiles.json"))).profiles,
  ...(await json(path.join(fixture,"reference-profiles.json"))).profiles].map(item=>[item.id,item]));
const receipts=await lines(path.join(archive,"http-responses.jsonl"));
const hostById=new Map(hosts.map(item=>[item.id,item]));
const scoring=new Map((await json(path.join(archive,"scoring-policy.json"))).rows.map(item=>[item.case_id,item]));
const contracts=await json(path.join(fixture,"contracts.json"));
const structured=(await json(path.join(fixture,"structured.json"))).cases;
const matching=(await json(path.join(runtime,"scripts/fixtures/decision-model-deep/matching.json"))).cases;
const outputParent=path.join(repository,".scratch/workflow-corpus-replay-2026-10-27");
await mkdir(outputParent,{recursive:true});
const output=await mkdtemp(path.join(outputParent,"run-"));
globalThis.fetch=async()=>{throw new Error("NETWORK_FORBIDDEN_IN_REPLAY");};
let decoded=0, replayed=0, orderChanges=0, diagnostics=0;
for(const row of receipts) {
  const result=await decideQuestions({content:row.input.state,questions:Object.entries(row.input.questions)
    .map(([id,question])=>({id,criteria:question.instructions}))},{enabled:true,model:"kettei-fat",apiKey:"recorded-fixture",
    timeoutMs:5000,fetch:async()=>new Response(JSON.stringify(row.raw_response),{status:row.status})});
  assert.equal(result.actualModel,"kettei-fat",`recorded model ${row.sequence}`);
  assert.ok(result.answers.every(answer=>answer.status==="judged"),`recorded answers ${row.sequence}`);
  if(row.phase==="structured") {
    const expected=structured.find(item=>item.id===row.case_id);
    assert.ok(expected,row.case_id);
    assert.equal(result.answers.length,1,row.case_id);
    assert.equal(result.answers[0].yesProbability>=0.5,expected.expected,row.case_id);
    diagnostics++;
  }
  decoded++;
}
for(const request of requests) {
  const host=hostById.get(request.id);
  const packet={phase:"extract",schema_version:6,session_id:"s",turn_id:"t",disposition:host.disposition,items:host.items};
  assert.ok(observeTurnSchema.safeParse(packet).success,request.id);
  assert.equal(hasPromptExcerpt(packet,request.prompt),false,request.id);
}

const observations=[];
async function executeCase(row,selection=false) {
  const directory=await mkdtemp(path.join(tmpdir(),"skillping-corpus-replay-"));
  const now=Date.now();
  const database=path.join(directory,"scout.sqlite");
  const config=await openConfigStore(directory,()=>now);
  await config.updateConfig(current=>({...current,intro_seen:true,recommendation_enabled:false,
    decision_model:{...current.decision_model,enabled:true,allow_external:true,api_key:"recorded-fixture",
      existence:selection?null:{threshold:0.5},matching:{threshold:0.5},precheck_timeout_ms:5000,match_timeout_ms:5000}}));
  const storage=await openStorage({filename:database,now:()=>now});storage.close();
  const db=new DatabaseSync(database);
  const host=selection?undefined:hostById.get(row.request_id);
  const source=selection?matching.find(item=>item.profile_id===row.work_ref.profile_id&&item.kind===row.work_ref.kind):undefined;
  const scope=selection?(row.expected.observation_scope??source.work.scope_hint):(host.items[0]?.capabilities[0]?.scope??"global");
  const cwd=selection?(row.expected.observation_workspace??"E:/synthetic/workspace-a"):directory;
  const records=selection?row.candidate_records:row.catalog.map((profile_ref,index)=>({id:index+1,profile_ref,state:"confirmed",scope,
    suppression:"none",workspace:scope==="project"?cwd:null}));
  const mapping=new Map();
  for(const record of records) {
    assert.equal(record.evidence_count??0,0);
    const prototype={...profiles.get(record.profile_ref).prototype,scope:record.scope};
    db.prepare(`INSERT INTO workflows(id,scope_kind,scope_value,state,prototype_json,prototype_version,representatives_json,
      last_seen_at,suppression,cooldown_until,created_at,updated_at) VALUES(?,?,?,?,?,3,'[]',?,?,?,?,?)`)
      .run(record.id,record.scope,record.scope==="project"?record.workspace:null,record.state,JSON.stringify(prototype),now,
        record.suppression,record.cooldown_until??null,now,now);
    mapping.set(record.id,record.profile_ref);
  }
  const probabilities=new Map(), batches=[], misses=[];
  const engine=await createScoutEngine({pluginRoot:runtime,dataDir:directory,now:()=>now,spawnProcess:spawn,
    fetch:async(_url,init)=>{
      const input=JSON.parse(init.body);
      let response;
      if(selection) response={model:"kettei-fat",answers:Object.fromEntries(Object.keys(input.questions).map(id=>[
        id,{type:"noul",noul:records.find(record=>record.id===Number(id.slice(9))).injected_probability}]))};
      else {
        const recorded=receipts.find(item=>item.phase==="fixed"&&item.case_id===row.id&&canonical(item.input)===canonical(input));
        if(!recorded) {misses.push(Object.keys(input.questions));throw new Error("ARCHIVE_REQUEST_MISSING");}
        replayed++;
        if(JSON.stringify(recorded.input)!==init.body) orderChanges++;
        response=recorded.raw_response;
      }
      if(!Object.hasOwn(input.questions,"reusable_work")) {
        const ids=Object.keys(input.questions).map(id=>Number(id.slice(9)));
        batches.push(ids);assert.ok(ids.length<=5);
        for(const id of ids) probabilities.set(id,response.answers[`workflow_${id}`].noul);
      }
      return new Response(JSON.stringify(response));
    }});
  const count=()=>Number(db.prepare("SELECT COUNT(*) AS n FROM episode_workflows").get().n);
  let packet, finalInput, provisionalChecks=0, reviewDriver="not_required";
  try {
    const staged=await engine.stagePrompt({session_id:"replay",turn_id:row.id,prompt:selection?`Carry out isolated contract ${row.id}.`:row.prompt,cwd,model:"frozen-host"});
    const items=selection?[{...source.work,scope_hint:scope,capabilities:[{...profiles.get(row.work_ref.profile_id).prototype,scope,confidence:"high"}]}]:host.items;
    finalInput={phase:"extract",schema_version:6,session_id:"replay",turn_id:row.id,disposition:selection?"analyze":host.disposition,items};
    packet=await engine.observeTurn(finalInput);
    for(let step=0;packet.status==="review_required"&&step<8;step++) {
      assert.equal(count(),0,`provisional contribution ${row.id}`);provisionalChecks++;
      const request=packet.requests[0];
      const ranking=[...probabilities].sort((a,b)=>b[1]-a[1]||a[0]-b[0]);
      const unique=ranking[0]&&ranking[0][1]>=0.5&&(!ranking[1]||ranking[0][1]>ranking[1][1]);
      const select=packet.matching_source==="decision_model"&&request.scan?.phase==="final"&&unique?ranking[0][0]:undefined;
      reviewDriver=select===undefined?"uncertain_without_fresh_host_judgment":"unique_numeric_top_fixture_not_semantic_review";
      if(select!==undefined) for(const candidate of request.catalog.items) {
        let cursor;
        do {
          const page=await engine.getReviewEvidence({review_set_id:packet.review_set_id,request_id:request.request_id,
            workflow_id:candidate.workflow_id,...(cursor?{cursor}:{})});
          assert.equal(page.status,"ok",`evidence ${row.id}`);cursor=page.next_cursor;
        } while(cursor);
      }
      finalInput={...packet.review_call,review_set_id:packet.review_set_id,decisions:[{request_id:request.request_id,kind:"capability",
        review_reason:request.review_reason,verdict:select===undefined?"uncertain":"same",...(select===undefined?{}:{selected_workflow_id:select})}]};
      packet=await engine.observeTurn(finalInput);
    }
    assert.ok(["accepted","ignored"].includes(packet.status),`${row.id}: ${packet.status}`);
    assert.ok(count()<=1,`single attribution ${row.id}`);
    const before=count();await engine.observeTurn(finalInput);assert.equal(count(),before,`duplicate ${row.id}`);
    const selected=db.prepare("SELECT workflow_id FROM episode_workflows").all().map(item=>Number(item.workflow_id));
    const result={id:row.id,suite:selection?"selection":row.source_suite,status:packet.status,staged:!!staged.hookSpecificOutput,
      selected_ids:selected,matches:selected.flatMap(id=>mapping.has(id)?[mapping.get(id)]:[]),contributions:count(),
      batches,archive_misses:misses,provisional_checks:provisionalChecks,review_driver:reviewDriver};
    if(selection) {
      const eligible=[...row.expected.candidate_ids,...(row.expected.excluded_by_limit??[])].sort((a,b)=>a-b);
      assert.deepEqual(batches.flat().sort((a,b)=>a-b),eligible,`complete catalog ${row.id}`);
      assert.equal(selected.length,eligible.length>1?0:1,`ties remain uncertain ${row.id}`);
      assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM dispatches").get().n),0);
      result.contract_changed=eligible.length>1;
      result.legacy_expected=row.expected.matched_record_ids;
    } else if(Array.isArray(scoring.get(row.id)?.expected_matches)) {
      result.expected_matches=scoring.get(row.id).expected_matches;
      result.cohort=scoring.get(row.id).matching_cohort;
    }
    observations.push(result);
    await appendFile(path.join(output,"cases.jsonl"),JSON.stringify(result)+"\n");
  } finally {
    await releaseIdleStorage(engine);db.close();
    assert.equal(path.dirname(directory),path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("skillping-corpus-replay-"));
    await rm(directory,{recursive:true,force:true});
  }
}

for(const [index,row] of cases.entries()) {
  await executeCase(row);
  if((index+1)%50===0) console.log(`Natural replay ${index+1}/${cases.length}`);
}
for(const row of contracts.selection) await executeCase(row,true);
const scored=observations.filter(row=>row.expected_matches!==undefined);
const mismatches=scored.filter(row=>canonical([...row.matches].sort())!==canonical([...row.expected_matches].sort()));
const positive=scored.filter(row=>row.expected_matches.length>0);
const truePositive=positive.filter(row=>row.expected_matches.some(id=>row.matches.includes(id))).length;
const falsePositive=scored.filter(row=>row.matches.some(id=>!row.expected_matches.includes(id))).length;
const summary={status:"pass",mode:"archived_response_and_frozen_host_replay",fresh_provider_calls:0,fresh_semantic_review:false,
  archived_responses_decoded:decoded,frozen_host_packets:requests.length,natural_cases:cases.length,
  structured_diagnostic_receipts:diagnostics,
  selection_contracts:contracts.selection.length,selection_contract_changes:observations.filter(row=>row.contract_changed).length,
  runtime_recipe_references:contracts.runtime.length,matching_http_replays:replayed,request_object_order_changes:orderChanges,
  archive_request_misses:observations.filter(row=>row.archive_misses.length).map(row=>row.id),
  deterministic_fixture_metrics:{scored:scored.length,positive:positive.length,true_positive:truePositive,false_positive:falsePositive,
    false_negative:positive.length-truePositive,mismatch_ids:mismatches.map(row=>row.id)},
  uncertain_reviews:observations.filter(row=>row.review_driver==="uncertain_without_fresh_host_judgment").map(row=>row.id),
  input_hashes:{manifest:sha(await readFile(path.join(fixture,"manifest.json"))),host:sha(await readFile(path.join(archive,"host-extractions.json"))),
    receipts:sha(await readFile(path.join(archive,"http-responses.jsonl")))},
  limitations:["Final same is injected from a unique archived numerical maximum, not a fresh semantic judgment.",
    "Recorded question objects may differ in property order; this is not evidence of live model order invariance.",
    "No fresh 252-request accumulating-library run or online latency/token/cost measurement."]};
await writeFile(path.join(output,"summary.json"),JSON.stringify(summary,null,2)+"\n");
console.log(JSON.stringify({output,...summary},null,2));
