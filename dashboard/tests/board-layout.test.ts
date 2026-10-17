import { describe, expect, it } from 'vitest';
import { convertTrialLayout, patchBoardLayout, readBoardLayout, readImmersiveItems, serializeImmersiveItems, writeBoardLayout } from '../apex/src/board-layout.js';
import { overlapsAny, planImmersive, pxToRows } from '../apex/src/immersive-grid.js';
import { parse, serialize } from '../apex/src/parser.js';
import { DEFAULT_SETTINGS, type ImmersiveItem } from '../apex/src/types.js';
import { buildWidgetEntries } from '../apex/src/renderer.js';

const one: ImmersiveItem={id:'section:first',w:6,h:80};
describe('native board layout persistence',()=>{
  it('keeps differently sized anchored tiles separate after a swap or resize and on reopen',()=>{
    const input=[{id:'small',x:0,y:128,w:4,h:19},{id:'large',x:0,y:96,w:6,h:38},{id:'flow',w:6,h:10}];
    const before=structuredClone(input);const first=planImmersive(input);
    const rectangles=first.map(tile=>({x:tile.col,y:tile.row,w:tile.w,h:tile.h}));
    for(let i=0;i<rectangles.length;i++)expect(overlapsAny(rectangles[i]!,rectangles.filter((_,index)=>index!==i))).toBe(false);
    expect(planImmersive(readImmersiveItems(serializeImmersiveItems(input))!)).toEqual(first);expect(input).toEqual(before);
    expect(planImmersive(input,6).every(tile=>tile.col+tile.w<=6)).toBe(true);
  });
  it('reads the trial layout without writing and preserves physical dimensions, hidden membership and unknown data',()=>{
    const old={version:1 as const,mode:'immersive' as const, future:'preserved',items:{'widget:lunar':{x:3,y:12,w:4,h:12,visible:false,future:7}}};
    const before=structuredClone(old);const native=convertTrialLayout(old);expect(old).toEqual(before);
    expect(native.immersive?.[0]).toMatchObject({id:'widget:lunar',x:3,y:29,w:4,h:pxToRows(276),fixed:true,hidden:true,future:7});
    const metadata={workbench_layout:old,unknown:{body:'kept'}};writeBoardLayout(metadata,native);
    expect(readBoardLayout(metadata,[])).toEqual(native);expect(metadata.workbench_layout).toEqual(before);expect(metadata.unknown).toEqual({body:'kept'});
  });
  it('binds same-named sections by stable identity and rejects ambiguous name-based input',()=>{
    const columns=[{id:'first',name:'同名',color:'',cards:[]},{id:'second',name:'同名',color:'',cards:[]}];
    expect(readBoardLayout({immersive:[{id:'section:first',w:6,cap:80}]},columns).immersive?.[0]?.id).toBe('section:first');
    expect(()=>readBoardLayout({immersive:[{id:'section:同名',w:6,cap:80}]},columns)).toThrow('无法唯一定位');
  });
  it('round-trips native caps, exact sizes, positions and unknown per-tile fields',()=>{
    const original=[{...one,x:0,y:17,fixed:true,future:{kept:true}}];expect(readImmersiveItems(serializeImmersiveItems(original))).toEqual(original);
    const board=parse('---\ndashboard: true\ncolumns: []\n---\n保留正文\n');board.layout='immersive';board.immersive=original;
    expect(parse(serialize(board)).immersive).toEqual(original);
  });
  it('merges independent tile edits and refuses competing edits or competing orders',()=>{
    const second={...one,id:'section:second'};const base={layout:'immersive' as const,immersive:[one,second]};
    const remote={...base,immersive:[one,{...second,h:60}]};const local={...base,immersive:[{...one,w:5},second]};
    expect(patchBoardLayout(remote,base,local).immersive).toEqual([{...one,w:5},{...second,h:60}]);
    expect(()=>patchBoardLayout({...base,immersive:[{...one,w:4},second]},base,local)).toThrow('保存冲突');
    expect(()=>patchBoardLayout({...base,immersive:[second,one]},base,{...base,immersive:[second,one,{...one,id:'new'}]})).toThrow('顺序');
  });
  it('retains explicit empty native state when following the default after a trial override',()=>{
    const metadata={workbench_layout:{version:1,mode:'immersive'}};writeBoardLayout(metadata,{immersive:[]});expect(readBoardLayout(metadata,[])).toEqual({layout:undefined,immersive:[]});
  });
  it('rejects malformed persisted configuration before a writer can replace it',()=>{
    for(const raw of [[{id:'x',w:13,cap:80}],[{id:'x',w:6,cap:'wrong'}],[{id:'x',w:6,cap:80,x:0}],[{id:'x',w:6,cap:80},{id:'x',w:6,cap:80}]]) expect(()=>readImmersiveItems(raw)).toThrow();
  });
  it('uses per-board widget membership independently from classic-layout toggles',()=>{
    const settings={...DEFAULT_SETTINGS,widgetLunarEnabled:false,widgetExpenseEnabled:false,widgetQuickActionsEnabled:false};
    const entries=buildWidgetEntries(settings,{} as never,{},new Set(['lunar','expense']));expect(entries.map(entry=>entry.key)).toEqual(['lunar','expense']);
    expect(buildWidgetEntries(settings,{} as never,{}).map(entry=>entry.key)).not.toContain('lunar');
  });
});
