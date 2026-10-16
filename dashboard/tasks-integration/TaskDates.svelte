<script lang="ts">
  import TaskDateField from './TaskDateField.svelte';
  import { parseTypedDateForSaving } from '../vendor/tasks/src/DateTime/DateTools';
  export let values: Record<string, string>;
  export let submit: (values: Record<string, string>) => Promise<void>;
  export let cancel: () => void;
  const names: Record<string, string> = { scheduled: '计划', due: '截止', reminder: '提醒', start: '开始', end: '跨日安排结束' };
  let fields = Object.fromEntries(Object.keys(names).map(key => [key, { date: values[key]?.slice(0, 10) ?? '', time: values[key]?.slice(11) ?? '', valid: true }]));
  let busy = false;
  let error = '';
  $: valid = Object.values(fields).every(field => field.valid);
  async function save() {
    if (busy || !valid) return;
    busy = true; error = '';
    try {
      const result: Record<string, string> = {};
      for (const [key, field] of Object.entries(fields)) {
        const date = field.date ? parseTypedDateForSaving(field.date, true)?.format('YYYY-MM-DD') : '';
        if (field.date && !date) throw new Error('日期无效');
        if (field.time && !date) throw new Error('请先选择对应日期');
        result[key] = date ? `${date}${field.time ? ' ' + field.time : ''}` : '';
      }
      await submit(result);
    } catch (failure) { error = failure instanceof Error ? failure.message : '日期保存失败'; }
    finally { busy = false; }
  }
</script>
<form class="okf-task-dates" on:submit|preventDefault={save}>
  {#each Object.entries(fields) as [key, field]}<TaskDateField id={key === 'due' ? 'due' : key === 'start' ? 'start' : 'scheduled'} fieldId={'edit-' + key} name={names[key]} bind:date={field.date} bind:time={field.time} bind:valid={field.valid} />{/each}
  {#if error}<div role="alert" class="okf-task-editor__error">{error}</div>{/if}
  <section class="tasks-modal-button-section"><button type="submit" class="mod-cta" disabled={busy || !valid}>{busy ? '正在保存…' : '保存日期'}</button><button type="button" disabled={busy} on:click={cancel}>取消</button></section>
</form>
