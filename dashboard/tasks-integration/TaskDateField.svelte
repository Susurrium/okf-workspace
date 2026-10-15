<script lang="ts">
  import { parseTypedDateForDisplayUsingFutureDate } from '../vendor/tasks/src/DateTime/DateTools';
  import { validateTaskDate } from './core-entry';
  export let id: 'start' | 'scheduled' | 'due' | 'done' | 'created' | 'cancelled' = 'scheduled';
  export let name: string;
  export let fieldId = '';
  export let date = '';
  export let time = '';
  export let valid = true;
  export let forwardOnly = true;
  export let withTime = true;
  let resolved = '';
  let relative = Boolean(date && !/^\d{4}-\d{2}-\d{2}$/u.test(date));
  $: resolved = date ? parseTypedDateForDisplayUsingFutureDate(id, date, forwardOnly) : '';
  $: valid = !date || (!resolved.includes('invalid') && (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || validateTaskDate(date)));
  $: picked = valid && /^\d{4}-\d{2}-\d{2}$/u.test(resolved) ? resolved : '';
  function clear() { date = ''; time = ''; }
  function quick(days: number) { date = window.moment().add(days, 'days').format('YYYY-MM-DD'); }
</script>

<div class="okf-task-date-field">
  <label for={fieldId || id}>{name}</label>
  <div class="okf-task-date-field__inputs">
    {#if relative}<input id={fieldId || id} type="text" bind:value={date} class:tasks-modal-error={!valid} placeholder="YYYY-MM-DD 或 tomorrow" aria-label={name + '日期'} on:input={() => { if (!date) time = ''; }} />
    {:else}<input id={fieldId || id} type="date" value={picked} aria-label={name + '日期'} on:input={(event) => { date = event.currentTarget.value; if (!date) time = ''; }} />{/if}
    {#if withTime}<input type="time" bind:value={time} aria-label={name + '时间'} />{/if}
  </div>
  <div class="okf-task-date-field__shortcuts">
    <button type="button" on:click={() => quick(0)}>今天</button>
    <button type="button" on:click={() => quick(1)}>明天</button>
    <button type="button" on:click={clear}>清除</button>
    <button type="button" on:click={() => { if (relative && picked) date = picked; relative = !relative; }}>{relative ? '选择日期' : '输入相对日期'}</button>
    {#if !valid}<span role="alert">日期无效</span>{:else if date && picked && date !== picked}<span>{picked}</span>{/if}
  </div>
</div>
