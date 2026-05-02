import * as vscode from 'vscode';

/** Echoes extension-host log path (useful on Remote-SSH when diagnosing install location). */
export function initRuntimeDebugLog(
	context: vscode.ExtensionContext,
	append: (line: string) => void,
): void {
	try {
		const u = vscode.Uri.joinPath(context.logUri, 'crib-extension-host.log');
		append(`[debug] extension host log folder: ${u.fsPath}`);
	} catch {
		// ignore
	}
}
