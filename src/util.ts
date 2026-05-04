/**
 * Shared tiny utilities used across the extension.
 */
import * as vscode from 'vscode';

/**
 * Human-readable error description. Used in output channels and logs.
 */
export function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Read a file as UTF-8 text through the VS Code workspace API.
 */
export async function readUtf8File(uri: vscode.Uri): Promise<string> {
	const bytes = await vscode.workspace.fs.readFile(uri);
	return Buffer.from(bytes).toString('utf8');
}
