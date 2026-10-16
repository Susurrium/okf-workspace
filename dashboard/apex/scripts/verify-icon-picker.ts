import { strict as assert } from 'node:assert';
import { IconPickerModal } from '../src/icon-picker-modal';

let chosen = '';
const modal = new IconPickerModal({} as never, name => { chosen = name; });
const items = modal.getItems();
assert.equal(items[0], 'file-text');
assert.ok(items.includes('calendar-clock'));
assert.ok(items.includes('custom-brand'));
assert.equal(items.filter(name => name === 'square-check-big').length, 1);
assert.ok(!items.some(name => name.startsWith('lucide-')));
modal.onChooseItem('calendar-clock');
assert.equal(chosen, 'calendar-clock');
console.log('verify-icon-picker: native prefixes, curated order and custom icons passed');
