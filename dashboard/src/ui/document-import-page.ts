import type { DocumentImportApi } from "../imports/service.js";
import type {
  DocumentImportOptions,
  DocumentImportResult,
  ImportIntent,
  ImportParser,
  ImportQuality,
  ConversionMethod,
} from "../imports/types.js";

export interface DocumentImportPageState {
  file?: File;
  options: DocumentImportOptions;
  running: boolean;
  result?: DocumentImportResult;
  error?: string;
}

export class DocumentImportPageModel {
  public state: DocumentImportPageState = {
    options: {
      intent: "source",
      quality: "quick",
      parser: "auto",
      method: "auto",
      generate: false,
    },
    running: false,
  };

  public constructor(private readonly api: DocumentImportApi) {}

  public selectFile(file: File): void {
    this.state = {
      file,
      options: this.state.options,
      running: false,
    };
  }

  public setIntent(intent: ImportIntent): void {
    this.state = {
      ...this.state,
      options: { ...this.state.options, intent },
    };
  }

  public setQuality(quality: ImportQuality): void {
    this.state = {
      ...this.state,
      options: { ...this.state.options, quality },
    };
  }

  public setParser(parser: ImportParser): void {
    this.state = {
      ...this.state,
      options: { ...this.state.options, parser, method: "auto" },
    };
  }

  public setMethod(method: ConversionMethod | "auto"): void {
    this.state = { ...this.state, options: { ...this.state.options, parser: "auto", method } };
  }

  public setGenerate(generate: boolean): void {
    this.state = {
      ...this.state,
      options: { ...this.state.options, generate },
    };
  }

  public setCourse(course?: string): void {
    const options = { ...this.state.options };
    if (course) options.course = course;
    else delete options.course;
    this.state = { ...this.state, options };
  }

  public async submit(): Promise<DocumentImportResult> {
    const file = this.state.file;
    if (!file) throw new Error("请先选择 PDF、Word、PowerPoint 或图片文件");
    const options = this.state.options;
    this.state = { file, options, running: true };
    try {
      const result = await this.api.importDocument(file, options);
      this.state = { file, options, running: false, result };
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state = { file, options, running: false, error: message };
      throw error;
    }
  }
}
