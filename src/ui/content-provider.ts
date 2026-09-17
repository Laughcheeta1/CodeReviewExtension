import * as vscode from "vscode";
import type { ReviewService } from "../review-service";

export class BaselineContentProvider
  implements vscode.TextDocumentContentProvider {
  constructor(private readonly service: ReviewService) {}
  provideTextDocumentContent(uri: vscode.Uri): vscode.ProviderResult<string> {
    return this.service.baselineContent(uri);
  }
}
