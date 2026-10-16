export interface TaskEditorChoice { path: string; title: string; }
export interface TaskEditorContext {
  isNew?: boolean;
  target?: string;
  targetHint?: string;
  courses?: readonly TaskEditorChoice[];
  projects?: readonly TaskEditorChoice[];
  targets?: readonly TaskEditorChoice[];
  inheritedCourse?: string;
  inheritedProject?: string;
  openSource?: () => void;
  beforeApply?: (target?: string) => Promise<void>;
}
