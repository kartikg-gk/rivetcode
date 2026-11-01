import { createHash, randomUUID } from "node:crypto";
import { constants, copyFileSync, existsSync, linkSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

type Entry = { sequence: number; schema_version: number; operation: string; recorded_at: string; previous_hash: string; hash: string; changes: Uint8Array };
const head = (db: DatabaseSync) => (db.prepare("SELECT coalesce(max(sequence),0) AS sequence FROM recovery_journal").get() as { sequence: number }).sequence;
const schema = (db: DatabaseSync) => (db.prepare("SELECT max(version) AS version FROM schema_migrations").get() as { version: number }).version;
function checksum(row: Omit<Entry,"sequence"|"hash">): string {
  return createHash("sha256").update(JSON.stringify([row.schema_version,row.operation,row.recorded_at,row.previous_hash])).update(row.changes).digest("hex");
}
function checkpointPath(data: string, version: number) {return join(data,"recovery",`baseline-${version}.db`);}
function snapshot(db: DatabaseSync, path: string) {
  const target=resolve(path);
  if(existsSync(target))throw new Error("snapshot target already exists");
  mkdirSync(dirname(target),{recursive:true});
  const temporary=target+".partial-"+randomUUID();
  db.prepare("VACUUM INTO ?").run(temporary);
  const copy=new DatabaseSync(temporary);
  try {
    // VACUUM can renumber implicit rowids: rebuild external-content indexes against the copy.
    for(const name of ["chat_search","timeline_search"]){
      if(copy.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name))copy.exec(`INSERT INTO ${name}(${name}) VALUES ('rebuild')`);
    }
  }finally{copy.close();}
  linkSync(temporary,target);unlinkSync(temporary);
  return {path:target,sequence:head(db),schemaVersion:schema(db)};
}
export function recoveryStatus(db: DatabaseSync,data: string) {
  return {sequence:head(db),schemaVersion:schema(db),baseline:checkpointPath(data,schema(db)),mode:"snapshot-change-journal",externalEffectsReplayed:false};
}
export function verifyJournal(db: DatabaseSync) {
  let previous="";let sequence=0;
  for(const row of db.prepare("SELECT * FROM recovery_journal ORDER BY sequence").iterate() as Iterable<Entry>) {
    if(row.sequence!==sequence+1 || row.previous_hash!==previous || checksum(row)!==row.hash)throw new Error(`recovery journal integrity failure at ${row.sequence}`);
    previous=row.hash;sequence=row.sequence;
  }
  return {valid:true,sequence,hash:previous};
}
export function snapshotStore(db: DatabaseSync,path: string) {return snapshot(db,path);}

const WRITES=new Set(["saveRun","setActivity","recordSignal","markLaunched","createReport","queueMessage","markDelivered","exitStaleSessions","updateNode","setPr","startReview","endReview","saveAutomation","deleteAutomation","recordAutomationRun","saveCue","deleteCue","addTimeline","pruneTimeline","detachFork","changeBranch","subscribeWait","completeWait","transferContext","recordChat","recordProviderLines","setTerminateOnPrMerge","setConfig","organizeRun"]);
const READS=new Set(["journalEntries","recoveryStatus","verifyJournal","snapshot","organization","loadRun","listRuns","conversations","undeliveredMessages","listAutomations","automationRuns","activeBranch","branches","waitSubscriptions","getFork","inherited","workspaceForks","contextTransfer","pendingContextSize","listContextTransfers","lastTransferPosition","waitTurn","searchRuns","readEvents","chatUsage", "lastTurnError","providerLines","readChat","listProjects","readTimeline","listCues","reviewsOf","getPr","getTerminateOnPrMerge","getConfig","close"]);
export function journalStore<T extends object>(db: DatabaseSync,data: string,store: T): T {
  for(const [name,value] of Object.entries(store))if(typeof value==="function"&&!READS.has(name)&&!WRITES.has(name))throw new Error(`unclassified store operation: ${name}`);
  const version=schema(db);
  const baseline=checkpointPath(data,version);
  verifyJournal(db);
  if(!existsSync(baseline))snapshot(db,baseline);
  return new Proxy(store,{
    get(target,key,receiver) {
      const fn=Reflect.get(target,key,receiver) as unknown;
      if(typeof key!=="string" || !WRITES.has(key) || typeof fn!=="function")return fn;
      return (...args:unknown[])=>{
        db.exec("BEGIN IMMEDIATE");
        let session: ReturnType<DatabaseSync["createSession"]> | undefined;
        try {
          session=db.createSession();
          const result=Reflect.apply(fn,target,args) as unknown;
          const changes=session.changeset();session.close();
          if(changes.length) {
            const previous=db.prepare("SELECT hash FROM recovery_journal ORDER BY sequence DESC LIMIT 1").get() as {hash:string}|undefined;
            const row={schema_version:version,operation:key,recorded_at:new Date().toISOString(),previous_hash:previous?.hash??"",changes};
            db.prepare("INSERT INTO recovery_journal(schema_version,operation,recorded_at,previous_hash,hash,changes) VALUES (?,?,?,?,?,?)").run(version,key,row.recorded_at,row.previous_hash,checksum(row),changes);
          }
          db.exec("COMMIT");return result;
        } catch(error) {
          try {session?.close();}catch{}
          db.exec("ROLLBACK");throw error;
        }
      };
    },
  });
}

function fingerprint(db:DatabaseSync):string {
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%search%' AND name <> 'recovery_journal' ORDER BY name").all() as {name:string}[];
  const hash=createHash("sha256");
  for(const {name} of tables) {
    const rows=db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all().map(row=>JSON.stringify(row,(_k,v:unknown)=>typeof v==='bigint'?v.toString():v instanceof Uint8Array?Buffer.from(v).toString('base64'):v)).sort();
    hash.update(name).update(JSON.stringify(rows));
  }
  return hash.digest("hex");
}

// Rebuild a separate database. Never replay processes, shell commands, Git or network effects.
export function rebuildStore(data:string,targetPath:string,throughSequence?:number) {
  const target=resolve(targetPath);
  if(existsSync(target))throw new Error("rebuild target already exists");
  const source=new DatabaseSync(join(data,"rivet.db"),{readOnly:true});
  let destination:DatabaseSync|undefined;
  const temporary=target+".partial-"+randomUUID();
  try {
    source.exec("BEGIN");verifyJournal(source);
    const version=schema(source);
    const baseline=checkpointPath(data,version);
    if(!existsSync(baseline))throw new Error("recovery baseline is missing");
    mkdirSync(dirname(target),{recursive:true});
    copyFileSync(baseline,temporary,constants.COPYFILE_EXCL);
    destination=new DatabaseSync(temporary);
    destination.exec("PRAGMA foreign_keys=ON");
    if(schema(destination)!==version)throw new Error("snapshot schema does not match the journal");
    const from=head(destination);const current=head(source);const through=throughSequence??current;
    if(!Number.isSafeInteger(through)||through<from||through>current)throw new Error("requested sequence is outside the current checkpoint/journal range");
    for(const row of source.prepare("SELECT * FROM recovery_journal WHERE sequence>? AND sequence<=? ORDER BY sequence").iterate(from,through) as Iterable<Entry>) {
      if(row.schema_version!==version)throw new Error("a new schema checkpoint is required");
      destination.exec("BEGIN; PRAGMA defer_foreign_keys=ON");
      try {
        if(!destination.applyChangeset(row.changes,{filter:name=>!name.includes("_search")}))throw new Error(`replay conflict at ${row.sequence}`);
        destination.prepare("INSERT INTO recovery_journal VALUES (?,?,?,?,?,?,?)").run(row.sequence,row.schema_version,row.operation,row.recorded_at,row.previous_hash,row.hash,row.changes);
        destination.exec("COMMIT");
      }catch(error){destination.exec("ROLLBACK");throw error;}
    }
    verifyJournal(destination);
    const expected=fingerprint(source);const actual=fingerprint(destination);
    const stateMatchesSource=through===current?expected===actual:null;
    const integrity=destination.prepare("PRAGMA integrity_check").get() as {integrity_check:string};
    if(integrity.integrity_check!=="ok" || destination.prepare("PRAGMA foreign_key_check").all().length)throw new Error("rebuilt database failed integrity checks");
    destination.close();destination=undefined;
    copyFileSync(temporary,target,constants.COPYFILE_EXCL);unlinkSync(temporary);
    source.exec("ROLLBACK");
    return {path:target,from,through,hash:actual,verified:true,fullStateCompared:through===current,stateMatchesSource,externalEffectsReplayed:false};
  } finally {destination?.close();source.close();}
}
