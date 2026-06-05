export const DEV_CONTAINERS_ATTACH_COMMAND_CANDIDATES = [
	'remote-containers.attachToRunningContainer',
	'anysphere.remote-containers.attachToRunningContainer',
];

export const UI_ATTACH_BRIDGE_COMMAND = 'crib.attachViaUiHost';

export type AttachTarget =
	| { readonly kind: 'direct'; readonly command: string }
	| { readonly kind: 'uiBridge'; readonly command: typeof UI_ATTACH_BRIDGE_COMMAND; readonly registered: boolean }
	| { readonly kind: 'unavailable'; readonly reason: string };

export function resolveDirectAttachCommand(commands: readonly string[]): string | undefined {
	return DEV_CONTAINERS_ATTACH_COMMAND_CANDIDATES.find(candidate =>
		commands.includes(candidate),
	);
}

export function resolveAttachTarget(
	commands: readonly string[],
	options: { readonly allowUiBridgeFallback?: boolean } = {},
): AttachTarget {
	const direct = resolveDirectAttachCommand(commands);
	if (direct) {
		return { kind: 'direct', command: direct };
	}
	const registered = commands.includes(UI_ATTACH_BRIDGE_COMMAND);
	if (registered || options.allowUiBridgeFallback) {
		return { kind: 'uiBridge', command: UI_ATTACH_BRIDGE_COMMAND, registered };
	}
	return {
		kind: 'unavailable',
		reason: 'No Dev Containers attach command or Crib UI attach bridge is registered.',
	};
}

export function hasContainerName(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}
