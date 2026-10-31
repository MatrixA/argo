import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import test from "node:test";
import ts from "typescript";

test("drafts remain isolated across bridge identities and never write before configuration loads",async()=>{
 const source=ts.createSourceFile("hooks.ts",readFileSync(new URL("./hooks.ts",import.meta.url),"utf8"),ts.ScriptTarget.Latest,true);
 const declaration=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==="useDraft");assert.ok(declaration);
 const states:unknown[]=[],refs:Array<{current:any}>=[],effects:Array<()=>void>=[];let cursor=0,refCursor=0;
 const data=new Map<string,string>([["draft:bridge-a:binding","saved-a"],["draft:bridge-b:binding","saved-b"]]);
 const exports={} as {useDraft:(id:string,identity?:string)=>{text:string;ready:boolean;change:(value:string)=>void;clearIf:(value:string)=>void}};
 runInNewContext(ts.transpileModule(declaration.getText(source),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2023}}).outputText,{
  exports,useState(initial:any){const index=cursor++;if(!(index in states))states[index]=initial;return [states[index],(value:unknown)=>{states[index]=value;}];},
  useRef(initial:unknown){const index=refCursor++;return refs[index]??(refs[index]={current:initial});},useEffect(effect:()=>void){effects.push(effect);},
  draftKey:(id:string,identity:string)=>`draft:${identity??"unconfigured"}:${id}`,
  LocalStorage:{async getItem(key:string){return data.get(key);},async setItem(key:string,value:string){data.set(key,value);},async removeItem(key:string){data.delete(key);}},
  showToast(){},Toast:{Style:{}},
 });
 const render=(identity?:string)=>{cursor=0;refCursor=0;return exports.useDraft("binding",identity);};
 render().change("must not persist");effects.pop()!();assert.equal(data.has("draft:unconfigured:binding"),false);
 render("bridge-a");effects.pop()!();await new Promise<void>(resolve=>setImmediate(resolve));
 let draft=render("bridge-a");assert.equal(draft.text,"saved-a");assert.equal(draft.ready,true);draft.change("edited-a");await new Promise<void>(resolve=>setImmediate(resolve));
 render("bridge-b");effects.pop()!();await new Promise<void>(resolve=>setImmediate(resolve));
 draft=render("bridge-b");assert.equal(draft.text,"saved-b");draft.change("edited-b");await new Promise<void>(resolve=>setImmediate(resolve));
 assert.equal(data.get("draft:bridge-a:binding"),"edited-a");assert.equal(data.get("draft:bridge-b:binding"),"edited-b");
 draft.clearIf("old text");assert.equal(render("bridge-b").text,"edited-b");draft.clearIf("edited-b");await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(data.has("draft:bridge-b:binding"),false);
});
