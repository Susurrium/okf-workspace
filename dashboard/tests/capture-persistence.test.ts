import { describe, expect, it } from 'vitest';
import { assertCaptureDraftPersisted } from '../src/plugin/capture-persistence.js';

const key = 'captureDraft:{}';
const stored = (filters: Record<string, unknown>) => ({ dashboardUiState: { pages: { inbox: { filters } } } });

describe('Capture disk acknowledgement', () => {
  it('rejects stale settings even when the settings API reported success', () => {
    expect(() => assertCaptureDraftPersisted(stored({ [key]: '上次草稿' }), { [key]: '本次草稿', [`${key}:prepared`]: '本次固定目标' }, key)).toThrow('实际保存到磁盘');
  });
  it('checks request identity and confirms removal after saving', () => {
    expect(() => assertCaptureDraftPersisted(stored({ [key]: '正文', [`${key}:prepared`]: '旧目标' }), { [key]: '正文', [`${key}:prepared`]: '新目标' }, key)).toThrow();
    expect(() => assertCaptureDraftPersisted(stored({ [key]: '正文' }), {}, key)).toThrow();
    expect(() => assertCaptureDraftPersisted(stored({}), {}, key)).not.toThrow();
  });
  it('accepts independently changed contexts and refuses missing disk state', () => {
    expect(() => assertCaptureDraftPersisted(stored({ [key]: '正文', 'captureDraft:other': '另一窗口' }), { [key]: '正文' }, key)).not.toThrow();
    expect(() => assertCaptureDraftPersisted({}, { [key]: '正文' }, key)).toThrow('磁盘草稿状态缺失');
  });
});
