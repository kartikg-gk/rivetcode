import {join} from "node:path";
import {afterEach,expect,it} from "vitest";
import {startDaemon,type Daemon} from "../src/daemon/server.js";
import {openStore} from "../src/store.js";
import {toolCaller} from "../src/mcp/server.js";
import {makeDataDir,makeRepo,removeRepo,sessionRun} from "./helpers.js";
let data:string|undefined;let repo:string|undefined;let daemon:Daemon|undefined;
afterEach(async()=>{await daemon?.stop();daemon=undefined;if(data)await removeRepo(data);if(repo)await removeRepo(repo);data=repo=undefined;});
it("organizes threads through structured tools without stopping or deleting them",async()=>{
 data=await makeDataDir();const s=openStore(data);s.saveRun(sessionRun(data));s.close();
 const runFile=join(data,"running.json");daemon=await startDaemon({data,runFile,port:0});
 const call=toolCaller({RIVET_RUN_FILE:runFile,RIVET_SESSION_ID:"r1-agent",RIVET_PROJECT_ID:"proj"},data);
 await call("rivet_threads",{action:"rename",run:"r1",name:"Renamed thread"});
 await call("rivet_threads",{action:"group",run:"r1",group:"Investigations"});
 await call("rivet_threads",{action:"archive",run:"r1"});
 expect(await call("rivet_threads",{action:"list"})).toMatchObject({threads:[]});
 expect(await call("rivet_threads",{action:"list",archived:"only",group:"Investigations"})).toMatchObject({threads:[{run:{name:"Renamed thread",node:{status:"pending"}},organization:{group:"Investigations",archivedAt:expect.any(String)}}]});
 await call("rivet_threads",{action:"unarchive",run:"r1"});await call("rivet_threads",{action:"ungroup",run:"r1"});
 expect(await call("rivet_threads",{action:"list"})).toMatchObject({threads:[{organization:{group:"",archivedAt:null}}]});
 const reopened=openStore(data);try{expect(reopened.verifyJournal().valid).toBe(true);expect(reopened.organization("r1").group).toBe("");}finally{reopened.close();}
});
it("creates, pauses, resumes and deletes schedules through the agent bridge",async()=>{
 data=await makeDataDir();repo=await makeRepo();const s=openStore(data);const run=sessionRun(data);run.repo=repo;s.saveRun(run);s.close();
 const runFile=join(data,"running.json");daemon=await startDaemon({data,runFile,port:0});
 const call=toolCaller({RIVET_RUN_FILE:runFile,RIVET_SESSION_ID:"r1-agent"},repo);
 const created=await call("rivet_schedule",{action:"create",name:"weekly-check",prompt:"inspect current state",cron:"0 12 * * 1",zone:"UTC"}) as {id:string};
 expect(created.id).toBeTruthy();await call("rivet_schedule",{action:"pause",id:created.id});
 expect(await call("rivet_schedule",{action:"list"})).toMatchObject({automations:[{enabled:false}]});
 await call("rivet_schedule",{action:"resume",id:created.id});await call("rivet_schedule",{action:"delete",id:created.id});
 expect(await call("rivet_schedule",{action:"list"})).toMatchObject({automations:[]});
});
