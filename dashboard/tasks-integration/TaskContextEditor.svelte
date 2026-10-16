<script lang="ts">
  import type { Task } from '../vendor/tasks/src/Task/Task';
  import type { Status } from '../vendor/tasks/src/Statuses/Status';
  import EditTask from '../vendor/tasks/src/ui/EditTask.svelte';
  import type { TaskEditorContext } from './editor-context';
  import { validateTaskDate } from './core-entry';
  export let task: Task;
  export let allTasks: Task[];
  export let statusOptions: Status[];
  export let extensions: Record<string, string>;
  export let context: TaskEditorContext;
  export let onSubmit: (tasks: Task[]) => Promise<void>;
  export let onCancel: () => void;
  export let validate: () => Promise<void>;
  let busy = false;
  async function submit(tasks: Task[]) {
    busy = true;
    try { await onSubmit(tasks); }
    finally { busy = false; }
  }
  async function beforeApply() {
    for (const key of ['reminder', 'end']) if (extensions[key] && !validateTaskDate(extensions[key]!)) throw new Error('日期或时间格式无效');
    await validate();
  }
</script>

<section class="okf-task-editor__context">
  <fieldset disabled={busy}>
  {#each ['course', 'project'] as key}
    <label>{key === 'course' ? '课程' : '项目'}
      <select bind:value={extensions[key]}>
        <option value="">{(key === 'course' ? context.inheritedCourse : context.inheritedProject) || '不指定'}</option>
        {#each (key === 'course' ? context.courses : context.projects) ?? [] as item}
          <option value={'/' + item.path.replace(/^\//u, '')}>{item.title}</option>
        {/each}
        {#if extensions[key] && !((key === 'course' ? context.courses : context.projects) ?? []).some(item => '/' + item.path.replace(/^\//u, '') === extensions[key])}
          <option value={extensions[key]}>{extensions[key]}（保留原关联）</option>
        {/if}
      </select>
    </label>
  {/each}
  {#if context.isNew}
    <label>保存位置<input type="text" aria-label="保存位置" list="okf-task-targets" bind:value={context.target} /></label>
    <datalist id="okf-task-targets">{#each context.targets ?? [] as item}<option value={item.path}>{item.title}</option>{/each}</datalist>
    <small>{context.targetHint ?? '留空保存到今日日记。'}</small>
  {:else}
    <span>来源：{task.path}</span>
    {#if context.openSource}<button type="button" on:click={context.openSource}>定位原任务</button>{/if}
  {/if}
  <details>
    <summary>提醒、时间与跨日安排</summary>
    <label>提醒<input type="text" aria-label="提醒" bind:value={extensions.reminder} placeholder="YYYY-MM-DD HH:MM" /></label>
    <label>跨日结束<input type="text" aria-label="跨日结束" bind:value={extensions.end} placeholder="YYYY-MM-DD HH:MM" /></label>
    {#each [['start', '开始时间'], ['scheduled', '计划时间'], ['due', '截止时间'], ['completion', '完成时间']] as [key, label]}
      <label>{label}<input type="time" aria-label={label} bind:value={extensions[key]} /></label>
    {/each}
  </details>
  </fieldset>
</section>
<EditTask {task} {allTasks} {statusOptions} onSubmit={submit} {beforeApply} {onCancel} />
