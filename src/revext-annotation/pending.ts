import * as vscode from "vscode";
import { revExtEdits } from "../revext";
import type { RevExtAnnotationContext } from "./context";

/** Add RevExt identity comments to every line when a file starts pending. */
export async function annotatePendingDocument(
  context: RevExtAnnotationContext,
  uri: vscode.Uri,
): Promise<number> {
  if (context.isRevExtDisabled(uri)) {
    return 1;
  }
  const document = await context.openDocumentForInternalUse(uri);
  if (document.isDirty) {
    throw new Error("Save the file before starting pending review.");
  }
  const lineTexts: string[] = [];
  const lineNumbers = new Set<number>();
  for (let index = 0; index < document.lineCount; index += 1) {
    lineTexts.push(document.lineAt(index).text);
    lineNumbers.add(index + 1);
  }
  const annotation = revExtEdits(
    lineTexts,
    lineNumbers,
    document.languageId,
    1,
  );
  if (annotation.edits.length === 0) {
    return annotation.nextId;
  }
  const edit = new vscode.WorkspaceEdit();
  for (const change of annotation.edits) {
    const line = document.lineAt(change.line - 1);
    edit.insert(uri, line.range.end, change.suffix);
  }
  if (!(await vscode.workspace.applyEdit(edit))) {
    throw new Error("Could not add initial RevExt identity comments.");
  }
  context.internalSaves.add(uri.toString());
  try {
    if (!(await document.save())) {
      throw new Error("Could not save initial RevExt identity comments.");
    }
  } finally {
    context.internalSaves.delete(uri.toString());
  }
  return annotation.nextId;
}
