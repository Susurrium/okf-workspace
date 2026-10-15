import type { Task } from './Task/Task';
import type { TaskSerializer } from './TaskSerializer';

/** 宿主边界默认保持上游行为，业务规则由嵌入方提供。 */
export interface TaskHost {
    acceptsSource?: (path: string) => boolean;
    serializer?: (serializer: TaskSerializer) => TaskSerializer;
    nextOccurrence?: (previous: Task, next: Task) => Task;
}

export const taskHost: TaskHost = {};

export function acceptsTaskSource(path: string): boolean {
    return taskHost.acceptsSource?.(path) ?? true;
}

export function hostedSerializer(serializer: TaskSerializer): TaskSerializer {
    return taskHost.serializer?.(serializer) ?? serializer;
}
