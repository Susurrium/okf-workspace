import moment from 'moment';
import { configureTasks } from '../tasks-generated/core.js';

Object.assign(globalThis, { moment });
Object.assign(globalThis, { window: globalThis });
await configureTasks({ globalFilter: '#task' });
