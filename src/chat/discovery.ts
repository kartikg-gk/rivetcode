import {signalTree} from "../proc.js";
import {spawn} from "node:child_process";
import {claudeAdapterPath} from "./drivers.js";
import {connect} from "./rpc.js";
import {redact} from "../timeline.js";

type Model={id:string;name:string};
export async function inspectProvider(agent:"claude"|"codex",cwd:string,env:NodeJS.ProcessEnv=process.env) {
 const override=env.RIVET_CHAT_COMMAND?JSON.parse(env.RIVET_CHAT_COMMAND) as string[]:undefined;
 const command=override??(agent==="codex"?["codex","app-server"]:[process.execPath,claudeAdapterPath()]);
 const childEnv:NodeJS.ProcessEnv={...env,...(agent==="claude"?{CLAUDE_CODE_EXECUTABLE:"claude"}:{})};
 delete childEnv.CLAUDECODE;delete childEnv.CLAUDE_CODE_CHILD_SESSION;delete childEnv.CLAUDE_CODE_SESSION_ID;
 const child=spawn(command[0]!,command.slice(1),{cwd,env:childEnv,stdio:["pipe","pipe","pipe"],shell:/\.(cmd|bat)$/i.test(command[0]!),windowsHide:true,detached:process.platform!=="win32"});
 child.stderr?.resume();
 const rpc=connect(child,{notify(){},request(method,_params,id){rpc.fail(id,-32601,`discovery does not implement ${method}`);}},{jsonrpc:agent==="claude"});
 const errors:Record<string,string>={};
 const attempt=async(label:string,method:string,params:unknown)=>{try{return await rpc.call(method,params);}catch(e){errors[label]=redact((e as Error).message).slice(0,500);return null;}};
 let timer:NodeJS.Timeout|undefined;
 try {
  return await Promise.race([(async()=>{
   const models:Model[]=[];let quota:unknown=null;
   let capabilities:Record<string,unknown>;
   if(agent==="codex"){
    await rpc.call("initialize",{clientInfo:{name:"rivet",version:"0.1.0"}});rpc.notify("initialized");
    let cursor:string|undefined;
    for(let page=0;page<10;page++){
     const result=await attempt("models","model/list",{limit:100,...(cursor?{cursor}:{})});
     if(!result)break;
     for(const item of Array.isArray(result.data)?result.data as Record<string,unknown>[]:[]){const id=typeof item.id==="string"?item.id:typeof item.model==="string"?item.model:"";if(id)models.push({id,name:typeof item.displayName==="string"?item.displayName:id});}
     cursor=typeof result.nextCursor==="string"?result.nextCursor:undefined;if(!cursor)break;
     if(page===9)errors.models="catalog truncated after 1000 entries";
    }
    const rates=await attempt("quota","account/rateLimits/read",{});
    if(rates)quota=JSON.parse(redact(JSON.stringify({rateLimits:rates.rateLimits??null,rateLimitsByLimitId:rates.rateLimitsByLimitId??null})));
    capabilities={transport:"app-server",models:!errors.models,quota:!!rates,history:"adapter-supported; provider checked when requested",nativeFork:"adapter-supported; provider checked when requested",compaction:"adapter-supported; provider checked when requested"};
   }else{
    const init=await rpc.call("initialize",{protocolVersion:1,clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false}});
    const caps=(init.agentCapabilities??{}) as {loadSession?:boolean;sessionCapabilities?:Record<string,unknown>};
    const opened=await attempt("models","session/new",{cwd,mcpServers:[]});
    const catalog=(opened?.models as {availableModels?:{modelId:string;name?:string}[]}|undefined)?.availableModels;
    for(const model of catalog??[])if(typeof model.modelId==="string")models.push({id:model.modelId,name:model.name??model.modelId});
    for(const option of Array.isArray(opened?.configOptions)?opened.configOptions as {id?:string;category?:string;options?:{value:string;name?:string}[]}[]:[]){if(option.id!=="model"&&option.category!=="model")continue;for(const model of option.options??[])if(typeof model.value==="string"&&!models.some(m=>m.id===model.value))models.push({id:model.value,name:model.name??model.value});}
    errors.quota="ACP does not advertise an account quota endpoint";
    capabilities={transport:"acp",models:models.length>0,quota:false,history:!!caps.loadSession,resume:caps.sessionCapabilities?.resume!==undefined,nativeFork:caps.sessionCapabilities?.fork!==undefined,historicalFork:false};
   }
   return {agent,models,quota,capabilities,errors,observedAt:new Date().toISOString()};
  })(),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error("provider discovery timed out")),25000);})]);
 }finally{if(timer)clearTimeout(timer);if(child.pid&&child.exitCode===null&&child.signalCode===null)signalTree(child.pid,"SIGTERM");else if(!child.pid)child.kill();await rpc.closed;}
}
