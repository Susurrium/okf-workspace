// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachImmersiveResizeHandle, attachImmersiveWidgetDelete, hasSameImmersiveTiles, layoutImmersiveGrid, refitImmersiveGrid, setupImmersiveDnD } from '../apex/src/immersive.js';
import type { ImmersiveItem } from '../apex/src/types.js';
vi.mock('obsidian', async importOriginal => ({ ...await importOriginal<Record<string, unknown>>(), setIcon: vi.fn(), moment: (await import('moment')).default }));

const cleanups: Array<() => void> = [];
beforeEach(() => {
  document.body.replaceChildren(); vi.stubGlobal('activeDocument', document);
  for (const [name, value] of Object.entries({
    addClass(this: HTMLElement, ...names: string[]) { this.classList.add(...names); },
    removeClass(this: HTMLElement, ...names: string[]) { this.classList.remove(...names); },
    hasClass(this: HTMLElement, name: string) { return this.classList.contains(name); },
    createDiv(this: HTMLElement, options: { cls?: string } = {}) { const el=document.createElement('div'); el.className=options.cls??''; this.appendChild(el); return el; },
    createEl(this: HTMLElement, tag: string, options: { cls?: string; attr?: Record<string,string> } = {}) { const el=document.createElement(tag); el.className=options.cls??''; for(const [key,value] of Object.entries(options.attr??{})) el.setAttribute(key,value); this.appendChild(el); return el; },
  })) Object.defineProperty(document.defaultView!.HTMLElement.prototype,name,{configurable:true,value});
});
afterEach(()=>{for(const cleanup of cleanups.splice(0)) cleanup();vi.unstubAllGlobals();});
const rect=(x:number,y:number,width:number,height:number)=>({x,y,width,height,left:x,top:y,right:x+width,bottom:y+height,toJSON:()=>({})});
function fixture(){
  const root=document.createElement('div');root.className='dashboard-scroll-region';const grid=document.createElement('div');root.appendChild(grid);document.body.appendChild(root);
  Object.defineProperty(grid,'getBoundingClientRect',{value:()=>rect(0,0,1200,900)});Object.defineProperty(root,'getBoundingClientRect',{value:()=>rect(0,0,1200,900)});
  const tile=document.createElement('div');tile.dataset.immId='section:first';tile.className='dashboard-section-row';const header=document.createElement('div');header.className='dashboard-section-header';tile.appendChild(header);const input=document.createElement('input');header.appendChild(input);grid.appendChild(tile);
  tile.style.gridColumn='1 / span 6';tile.style.gridRow='1 / span 20';Object.defineProperty(tile,'getBoundingClientRect',{value:()=>rect(0,0,595,190)});Object.defineProperty(tile,'scrollHeight',{configurable:true,value:110});
  const items:ImmersiveItem[]=[{id:'section:first',w:6,h:80}];return{root,grid,tile,header,input,items};
}
function pointer(el:EventTarget,kind:string,x:number,y:number){const event=new MouseEvent(kind,{bubbles:true,button:0,clientX:x,clientY:y});Object.defineProperty(event,'pointerId',{value:1});el.dispatchEvent(event);}

describe('upstream immersive interactions',()=>{

  it('requires new widgets to mount before allowing a geometry-only update',()=>{
    const{grid,items}=fixture();expect(hasSameImmersiveTiles(grid,[{...items[0]!,w:4}])).toBe(true);
    const next=[...items,{id:'widget:lunar',w:3,h:20}];expect(hasSameImmersiveTiles(grid,next)).toBe(false);
    const widget=document.createElement('div');widget.dataset.immId='widget:lunar';grid.appendChild(widget);
    expect(hasSameImmersiveTiles(grid,next)).toBe(true);expect(hasSameImmersiveTiles(grid,items)).toBe(false);
  });

  it('keeps saved geometry intact while a narrow pane is in reading layout',()=>{
    const{grid,tile,header,items}=fixture();grid.dataset.immCompact='true';const commit=vi.fn();
    setupImmersiveDnD(grid,()=>items,commit,cleanups);cleanups.push(attachImmersiveResizeHandle(tile,items[0]!.id,()=>items,commit));
    pointer(header,'pointerdown',100,100);pointer(document,'pointermove',300,250);pointer(document,'pointerup',300,250);
    pointer(tile.querySelector('.dashboard-imm-resize-h')!,'pointerdown',100,100);pointer(document,'pointermove',300,100);pointer(document,'pointerup',300,100);
    expect(commit).not.toHaveBeenCalled();expect(tile.style.gridColumn).toBe('1 / span 6');expect(document.querySelector('.dashboard-drag-shield')).toBeNull();
  });
  it('establishes the saved width before measuring initial content',()=>{
    const{grid,tile,items}=fixture();tile.style.removeProperty('grid-column');
    Object.defineProperty(tile,'scrollHeight',{get:()=>tile.style.gridColumn.includes('span 6')?110:370});
    refitImmersiveGrid(grid,items,true);expect(tile.style.height).toBe('110px');
  });
  it('preserves measured packing through an unchanged observer pass',()=>{
    const{grid,tile,items}=fixture();items[0]!.w=4;items[0]!.x=0;items[0]!.y=36;
    const other=tile.cloneNode(true) as HTMLElement;other.dataset.immId='section:other';Object.defineProperty(other,'scrollHeight',{value:110});grid.appendChild(other);items.push({id:'section:other',w:6,h:80});
    refitImmersiveGrid(grid,items,true);const before=[tile.style.cssText,other.style.cssText];
    refitImmersiveGrid(grid,items);expect([tile.style.cssText,other.style.cssText]).toEqual(before);
  });
  it('fits initial content and preserves a user-sized height',()=>{
    const{grid,tile,items}=fixture();refitImmersiveGrid(grid,items,true);expect(tile.style.height).toBe('110px');
    refitImmersiveGrid(grid,[{...items[0]!,h:25,fixed:true}],true);expect(tile.style.height).toBe('240px');Object.defineProperty(tile,'scrollHeight',{value:500});
    refitImmersiveGrid(grid,[{...items[0]!,h:25,fixed:true}],true);expect(tile.style.height).toBe('240px');
  });
  it('measures a full embedded business surface rather than its initially collapsed viewport',()=>{
    const{grid,tile,items}=fixture();tile.dataset.sectionType='workspace-today';const surface=document.createElement('div');surface.className='okf-workbench-surface';Object.defineProperty(surface,'scrollHeight',{value:1000});tile.appendChild(surface);
    refitImmersiveGrid(grid,items,true);expect(tile.style.height).toBe('790px');
  });
  it.each([['.dashboard-imm-resize-h',200,0],['.dashboard-imm-resize-v',0,50],['.dashboard-imm-resize-handle',200,50]] as const)('resizes using the actual %s edge',(selector,dx,dy)=>{
    const{tile,items}=fixture();const commit=vi.fn();cleanups.push(attachImmersiveResizeHandle(tile,items[0]!.id,()=>items,commit));
    pointer(tile.querySelector(selector)!,'pointerdown',100,100);pointer(document,'pointermove',100+dx,100+dy);pointer(document,'pointerup',100+dx,100+dy);
    expect(commit).toHaveBeenCalledOnce();const saved=commit.mock.calls[0]![0][0];expect(saved.w).toBe(dx?8:6);expect(saved.h).toBe(dy?25:20);expect(saved.fixed).toBe(true);expect(document.querySelector('.dashboard-drag-shield')).toBeNull();
  });
  it('restores cancellation and releases an active drag on pane destruction',()=>{
    const{tile,items}=fixture();const commit=vi.fn();const before=tile.style.cssText;const destroy=attachImmersiveResizeHandle(tile,items[0]!.id,()=>items,commit);cleanups.push(destroy);
    pointer(tile.querySelector('.dashboard-imm-resize-handle')!,'pointerdown',100,100);pointer(document,'pointermove',200,150);document.defaultView!.dispatchEvent(new Event('blur'));
    expect(tile.style.cssText).toBe(before);expect(commit).not.toHaveBeenCalled();pointer(tile.querySelector('.dashboard-imm-resize-v')!,'pointerdown',100,100);destroy();expect(document.querySelector('.dashboard-drag-shield')).toBeNull();expect(tile.classList.contains('dashboard-imm-tile--resizing')).toBe(false);
  });
  it('clamps a right-edge resize to the remaining columns at its saved origin',()=>{
    const{tile,items}=fixture();tile.style.gridColumn='7 / span 6';items[0]!.x=6;items[0]!.y=0;const commit=vi.fn();cleanups.push(attachImmersiveResizeHandle(tile,items[0]!.id,()=>items,commit));
    pointer(tile.querySelector('.dashboard-imm-resize-h')!,'pointerdown',100,100);pointer(document,'pointermove',400,100);pointer(document,'pointerup',400,100);expect(commit.mock.calls[0]![0][0]).toMatchObject({x:6,w:6});
  });
  it('drags headers with a landing preview and excludes input gestures',()=>{
    const{grid,header,input,items}=fixture();const commit=vi.fn();setupImmersiveDnD(grid,()=>items,commit,cleanups);
    pointer(input,'pointerdown',20,20);pointer(document,'pointermove',250,200);pointer(document,'pointerup',250,200);expect(commit).not.toHaveBeenCalled();
    pointer(header,'pointerdown',20,20);pointer(document,'pointermove',250,200);expect(grid.querySelector('.dashboard-imm-drop-ghost')).not.toBeNull();pointer(document,'pointerup',250,200);expect(commit).toHaveBeenCalledOnce();expect(commit.mock.calls[0]![0][0].x).toBeGreaterThan(0);expect(grid.querySelector('.dashboard-imm-drop-ghost')).toBeNull();
  });
  it('preserves a live node and its subscriptions during placement changes',()=>{
    const{grid,tile,items}=fixture();const handler=vi.fn();tile.addEventListener('click',handler);layoutImmersiveGrid(grid,items,[{...items[0]!,col:6,row:3}]);tile.click();expect(grid.firstElementChild).toBe(tile);expect(handler).toHaveBeenCalledOnce();expect(tile.style.gridColumn).toBe('7 / span 6');
  });
  it('targets the selected widget through its visible delete control',()=>{
    const{tile}=fixture();tile.dataset.immId='widget:lunar';tile.dataset.widgetKey='lunar';const remove=vi.fn();attachImmersiveWidgetDelete(tile,remove);tile.querySelector<HTMLButtonElement>('.dashboard-imm-widget-del')!.click();expect(remove).toHaveBeenCalledWith('widget:lunar');
  });
});
