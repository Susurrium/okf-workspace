import { describe, expect, it } from 'vitest';
import { TFile, type App } from 'obsidian';
import { stringify } from 'yaml';
import { readWorkbenchLayout } from '../apex/src/workbench-layout.js';
import { parse, serialize } from '../apex/src/parser.js';
import { SyncEngine } from '../apex/src/sync.js';
import { DEFAULT_SETTINGS } from '../apex/src/types.js';
import type { BoardLayoutState } from '../apex/src/board-layout.js';

const body='\n\n## 同名\n<!-- okf-section:first -->\n用户正文不得改写。\n\n## 同名\n<!-- okf-section:second -->\n- [ ] 保留清单\n';
const board=`---\ndashboard: true\nfuture: {kept: true}\ncolumns:\n  - {id: first, name: 同名, type: memo}\n  - {id: second, name: 同名, type: todo}\n---${body}`;
describe('layout source protection',()=>{
  it('retains trial extensions while deriving the native state without changing the source file',()=>{
    const data=parse(board);data.workbenchLayout={version:1,mode:'immersive',future:'retained',items:{'section:first':{x:0,y:0,w:4,h:12,future:7},'widget:music':{x:0,y:40,w:4,h:12,visible:false}}};
    const after=parse(serialize(data));expect(after.workbenchLayout).toEqual(data.workbenchLayout);expect(after.layout).toBe('immersive');expect(after.columns.map(column=>column.id)).toEqual(['first','second']);expect(after.sourceFrontmatter?.future).toEqual({kept:true});
  });
  it('rejects unsupported trial configuration without guessing a replacement',()=>{
    for(const raw of [{version:2,mode:'immersive'},{version:1,mode:'immersive',clock:'yes'},{version:1,mode:'immersive',items:{bad:{x:0,y:0,w:13,h:12}}}]) expect(()=>readWorkbenchLayout(raw)).toThrow();
  });
  it('patches only layout metadata, retains external body edits, rejects a real conflict and permits explicit retry',async()=>{
    let disk=board,denied=true,concurrent=false,currentBody=body,changeIdentity=false;
    const file=new (TFile as unknown as new(path:string)=>TFile)('board.md');
    const app={fileManager:{processFrontMatter:async(_file:TFile,update:(metadata:Record<string,unknown>)=>void)=>{
      if(denied)throw new Error('模拟磁盘拒绝写入');if(concurrent){currentBody=body.replace('用户正文','外部修改的正文');concurrent=false;}
      const metadata=parse(disk).sourceFrontmatter!;if(changeIdentity)metadata.dashboard=false;update(metadata);disk=`---\n${stringify(metadata)}---${currentBody}`;
    }},vault:{getFileByPath:()=>file,read:async()=>disk,on:()=>({}),offref:()=>undefined,adapter:{exists:async()=>true,write:async()=>undefined,list:async()=>({files:[],folders:[]})}}} as unknown as App;
    const engine=new SyncEngine(app,{...DEFAULT_SETTINGS,dashboardFile:'board'});
    const empty:BoardLayoutState={layout:'immersive',immersive:[]};
    try{
      await engine.init();await expect(engine.updateBoardLayout(empty,{})).rejects.toThrow('拒绝写入');expect(disk).toBe(board);
      denied=false;concurrent=true;await engine.updateBoardLayout(empty,{});expect(disk.endsWith(body.replace('用户正文','外部修改的正文'))).toBe(true);expect(parse(disk).sourceFrontmatter?.future).toEqual({kept:true});
      const first:BoardLayoutState={layout:'immersive',immersive:[{id:'section:first',w:4,h:40}]};await engine.updateBoardLayout(first,empty);
      await expect(engine.updateBoardLayout({...first,immersive:[{id:'section:first',w:6,h:40}]},empty)).rejects.toThrow('保存冲突');expect(parse(disk).immersive).toEqual(first.immersive);
      changeIdentity=true;await expect(engine.updateBoardLayout({...first,layout:'side'},first)).rejects.toThrow('身份');expect(parse(disk).layout).toBe('immersive');
    }finally{engine.destroy();}
  });
});
