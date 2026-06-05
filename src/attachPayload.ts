/**
 * Dev Containers attach APIs differ: Cursor's fork expects `{ containerId: string }` for
 * `attachToRunningContainer`, while Microsoft builds often accept a Docker id or name string.
 */
export function devContainersAttachArgument(
	_command: string,
	containerName: string,
	dockerId?: string,
): unknown {
	// Remote-SSH attach commands are more stable with explicit object payloads.
	if (dockerId) {
		return { containerId: dockerId };
	}
	return containerName;
}
