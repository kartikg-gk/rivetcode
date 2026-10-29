import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {afterEach,expect,it} from "vitest";
import {openStore,type Store} from "../src/store.js";
import {journalStore,rebuildStore} from "../src/recovery.js";
import {makeDataDir,removeRepo,sessionRun} from "./helpers.js";
let data:string|undefined;let target:string|undefined;let store:Store|undefined;
afterEach(async()=>{store?.close();store=undefined;if(data)await removeRepo(data);if(target)await removeRepo(target);data=target=undefined;});
it("rebuilds exact stored state and search from the checkpoint and ordered changesets",async()=>{
 data=await makeDataDir();target=await makeDataDir();store=openStore(data);
 store.saveRun(sessionRun(data,{agent:"codex"}));
 store.setConfig("proj","check","npm test");
 store.recordChat("r1","agent",[{type:"turn",turnId:"native-turn",state:"running"},{type:"message",itemId:"answer",role:"assistant",text:"recovered searchable marker",turnId:"native-turn"},{type:"turn",turnId:"native-turn",state:"completed"}]);
 store.queueMessage("r1","agent","pending control");
 store.updateNode("r1","agent",{status:"running"});
 const original=store.recoveryStatus();expect(original.sequence).toBeGreaterThan(0);expect(store.verifyJournal().valid).toBe(true);
 const rebuilt=rebuildStore(data,join(target,"rivet.db"));expect(rebuilt.verified).toBe(true);expect(rebuilt.externalEffectsReplayed).toBe(false);
 const copy=openStore(target);
 try{expect(copy.loadRun("r1")).toEqual(store.loadRun("r1"));expect(copy.readChat("r1",{limit:100})).toEqual(store.readChat("r1",{limit:100}));expect(copy.searchRuns("searchable marker",{limit:10})).toHaveLength(1);expect(copy.undeliveredMessages("r1","agent")).toHaveLength(1);expect(copy.recoveryStatus().sequence).toBe(original.sequence);}finally{copy.close();}
 expect(()=>rebuildStore(data!,join(target!,"rivet.db"))).toThrow("already exists");
});
it("rolls back state if its journal cannot be written",async()=>{
 data=await makeDataDir();store=openStore(data);store.saveRun(sessionRun(data));
 const db=new DatabaseSync(join(data,"rivet.db"));db.exec("CREATE TRIGGER deny_journal BEFORE INSERT ON recovery_journal BEGIN SELECT RAISE(ABORT,'journal refused'); END");
 try{expect(()=>store!.updateNode("r1","agent",{status:"running"})).toThrow();expect(store.loadRun("r1").node.status).toBe("pending");}finally{db.close();}
});
it("detects a modified journal entry before publishing a rebuilt database",async()=>{
 data=await makeDataDir();target=await makeDataDir();store=openStore(data);store.saveRun(sessionRun(data));
 const db=new DatabaseSync(join(data,"rivet.db"));db.exec("UPDATE recovery_journal SET operation='tampered' WHERE sequence=1");db.close();
 expect(()=>store!.verifyJournal()).toThrow("integrity failure");expect(()=>rebuildStore(data!,join(target!,"rivet.db"))).toThrow("integrity failure");
});

it("replays the same historical sequence deterministically without comparing it to newer state",async()=>{
 data=await makeDataDir();target=await makeDataDir();store=openStore(data);store.saveRun(sessionRun(data));
 const through=store.recoveryStatus().sequence;store.updateNode("r1","agent",{status:"running"});store.organizeRun("r1",{name:"later name",group:"Later",archived:true});
 const one=rebuildStore(data,join(target,"one.db"),through);const two=rebuildStore(data,join(target,"two.db"),through);
 expect(one.hash).toBe(two.hash);expect(one.fullStateCompared).toBe(false);
 const db=new DatabaseSync(join(target,"one.db"));try{expect(db.prepare("SELECT status FROM nodes WHERE run_id='r1'").get()?.status).toBe("pending");}finally{db.close();}
 expect(()=>rebuildStore(data!,join(target!,"bad.db"),999999)).toThrow("outside");
 const current=rebuildStore(data,join(target,"current.db"));expect(current.fullStateCompared).toBe(true);
});

it("keeps full-text indexes consistent when a snapshot compacts rowid gaps",async()=>{
 data=await makeDataDir();target=await makeDataDir();store=openStore(data);store.saveRun(sessionRun(data));store.saveRun(sessionRun(data,{id:"r2"}));
 store.recordChat("r1","agent",[{type:"message",itemId:"expired",role:"assistant",text:"expired marker"}]);
 store.recordChat("r2","agent",[{type:"message",itemId:"remaining",role:"assistant",text:"remaining searchable marker"}]);
 store.updateNode("r1","agent",{status:"done",finishedAt:"2000-01-01T00:00:00.000Z"});store.pruneTimeline("proj","2001-01-01T00:00:00.000Z");
 const snapshot=store.snapshot(join(target,"snapshot.db"));const db=new DatabaseSync(snapshot.path);
 try{expect(db.prepare("SELECT m.text FROM chat_search JOIN chat_messages m ON m.rowid=chat_search.rowid WHERE chat_search MATCH 'searchable'").all()).toHaveLength(1);}finally{db.close();}
});

it("refuses an unclassified store operation rather than silently bypassing the journal",async()=>{
 data=await makeDataDir();store=openStore(data);const db=new DatabaseSync(join(data,"rivet.db"));
 try{expect(()=>journalStore(db,data!,{unclassifiedMutation(){db.exec("DELETE FROM events");}})).toThrow("unclassified store operation");}finally{db.close();}
});

it("builds a repair candidate and reports drift without overwriting the live database",async()=>{
 data=await makeDataDir();target=await makeDataDir();store=openStore(data);store.saveRun(sessionRun(data));
 const db=new DatabaseSync(join(data,"rivet.db"));db.exec("UPDATE nodes SET status='done' WHERE run_id='r1'");db.close();
 const recovered=rebuildStore(data,join(target,"repaired.db"));expect(recovered.verified).toBe(true);expect(recovered.stateMatchesSource).toBe(false);
 const copy=new DatabaseSync(join(target,"repaired.db"));try{expect(copy.prepare("SELECT status FROM nodes WHERE run_id='r1'").get()?.status).toBe("pending");}finally{copy.close();}
 expect(store.loadRun("r1").node.status).toBe("done");
});
