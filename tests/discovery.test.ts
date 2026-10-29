import {fileURLToPath} from "node:url";
import {expect,it} from "vitest";
import {inspectProvider} from "../src/chat/discovery.js";
import {claudeChat,codexChat} from "../src/chat/drivers.js";
const env=(protocol:string)=>({...process.env,RIVET_CHAT_COMMAND:JSON.stringify([process.execPath,fileURLToPath(new URL("./fake-chat-agent.mjs",import.meta.url)),protocol])});
it("discovers paginated Codex models and current quota without creating a task",async()=>{
 const result=await inspectProvider("codex",process.cwd(),env("codex"));
 expect(result.models.map(m=>m.id)).toEqual(["model-a","model-b"]);
 expect(result.capabilities.quota).toBe(true);expect(result.quota).toMatchObject({rateLimits:{primary:{usedPercent:25}}});
});
it("reports unavailable quota separately from model discovery",async()=>{
 const result=await inspectProvider("codex",process.cwd(),{...env("codex"),RIVET_TEST_NO_QUOTA:"1"});
 expect(result.models).toHaveLength(2);expect(result.quota).toBeNull();expect(result.capabilities.quota).toBe(false);expect(result.errors.quota).toContain("unavailable");
});
it("uses ACP's advertised models and does not invent account quotas",async()=>{
 const result=await inspectProvider("claude",process.cwd(),env("acp"));
 expect(result.models).toEqual([{id:"claude-fixture",name:"Claude Fixture"}]);expect(result.capabilities.resume).toBe(true);expect(result.capabilities.historicalFork).toBe(false);expect(result.quota).toBeNull();
});
it("requests native Codex compaction only from an idle driver",async()=>{
 const driver=codexChat({binary:"unused",cwd:process.cwd(),permission:"default",env:env("codex"),emit(){},decide:()=>undefined});
 try{await driver.start();await expect(driver.compact!()).resolves.toBeUndefined();}finally{driver.close();await driver.exited;}
});

it("refuses an unsupported ACP resume instead of silently losing provider memory",async()=>{
 const driver=claudeChat({binary:"unused",cwd:process.cwd(),permission:"default",resume:"existing",env:{...env("acp"),RIVET_TEST_NO_RESUME:"1"},emit(){},decide:()=>undefined});
 try{await expect(driver.start()).rejects.toThrow("refusing to start a new one silently");}finally{driver.close();await driver.exited;}
});

it("uses ACP compaction only after the provider advertises it",async()=>{
 const replies:string[]=[];
 const driver=claudeChat({binary:"unused",cwd:process.cwd(),permission:"default",env:{...env("acp"),RIVET_TEST_COMPACT:"1"},emit(e){if(e.type==="message"&&!e.streaming)replies.push(e.text);},decide:()=>undefined});
 try{await driver.start();await driver.prompt("warmup");await driver.compact!();expect(replies).toContain("echo: /compact");}finally{driver.close();await driver.exited;}
});
