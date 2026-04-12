/**
 * Global Tauri Bridge Utility
 * Safe wrapper for Tauri APIs to allow for full browser compatibility.
 */

// We check for __TAURI_INTERNALS__ to determine if we are running in a native Tauri host
export const isTauri = () => (window as any).__TAURI_INTERNALS__ !== undefined;

/**
 * Safely calls a Tauri command by name.
 * On Web, it simply logs the call and returns an error/null.
 */
export async function safeInvoke<T>(command: string, args?: any): Promise<T> {
    if (!isTauri()) {
        console.warn(`[SafeBridge] Web mode: Skipping invoke('${command}')`, args);
        // We return an empty object or null to prevent crashes
        return null as unknown as T;
    }

    try {
        const { invoke } = await import('@tauri-apps/api/core');
        return await invoke<T>(command, args);
    } catch (e) {
        console.error(`[SafeBridge] Error invoking '${command}':`, e);
        throw e;
    }
}

/**
 * Safely listens for a Tauri event.
 * On Web, it does nothing and returns a dummy unlisten function.
 */
export async function safeListen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void> {
    if (!isTauri()) {
        console.warn(`[SafeBridge] Web mode: Skipping listen('${event}')`);
        return () => {};
    }

    try {
        const { listen } = await import('@tauri-apps/api/event');
        const unlisten = await listen<T>(event, handler);
        return unlisten;
    } catch (e) {
        console.error(`[SafeBridge] Error listening for '${event}':`, e);
        return () => {};
    }
}

/**
 * Safely opens a file dialog.
 */
export async function safeOpen(options?: any): Promise<string | string[] | null> {
    if (!isTauri()) {
        console.warn("[SafeBridge] Web mode: Skipping dialog.open()");
        return null;
    }
    try {
        const { open } = await import('@tauri-apps/plugin-dialog');
        return await open(options);
    } catch (e) {
        console.error("[SafeBridge] Error opening dialog:", e);
        return null;
    }
}

/**
 * Safely opens a save dialog.
 */
export async function safeSave(options?: any): Promise<string | null> {
    if (!isTauri()) {
        console.warn("[SafeBridge] Web mode: Skipping dialog.save()");
        return null;
    }
    try {
        const { save } = await import('@tauri-apps/plugin-dialog');
        return await save(options);
    } catch (e) {
        console.error("[SafeBridge] Error saving dialog:", e);
        return null;
    }
}
