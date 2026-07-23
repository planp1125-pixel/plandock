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
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            
            // Apply extensions if provided
            if (options?.filters && options.filters.length > 0) {
                const exts = options.filters.flatMap((f: any) => f.extensions.map((ext: string) => `.${ext}`));
                input.accept = exts.join(',');
            }
            
            input.onchange = (e: any) => {
                const file = e.target.files?.[0];
                if (!file) {
                    resolve(null);
                    return;
                }
                
                // Create a fake path and store the file globally for safeReadTextFile
                const fakePath = `web-file://${file.name}`;
                if (!(window as any).__BROWSER_FILES__) {
                    (window as any).__BROWSER_FILES__ = {};
                }
                (window as any).__BROWSER_FILES__[fakePath] = file;
                resolve(fakePath);
            };
            
            // Handle cancel
            input.oncancel = () => resolve(null);
            
            input.click();
        });
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
        // In browser, we don't have a save dialog, so we return a dummy path.
        // safeWriteTextFile will handle the actual download.
        let defaultName = 'download.txt';
        if (options?.defaultPath) {
            defaultName = options.defaultPath.split(/[/\\]/).pop() || defaultName;
        } else if (options?.filters && options.filters.length > 0) {
            defaultName = `export.${options.filters[0].extensions[0]}`;
        }
        return `web-download://${defaultName}`;
    }
    try {
        const { save } = await import('@tauri-apps/plugin-dialog');
        return await save(options);
    } catch (e) {
        console.error("[SafeBridge] Error saving dialog:", e);
        return null;
    }
}

/**
 * Safely opens a URL.
 */
export async function safeOpenUrl(url: string): Promise<void> {
    if (!isTauri()) {
        window.open(url, "_blank");
        return;
    }
    try {
        const { openUrl } = await import('@tauri-apps/plugin-opener');
        await openUrl(url);
    } catch (e) {
        console.error("[SafeBridge] Error opening url:", e);
    }
}

export async function safeConfirm(message: string, options?: any): Promise<boolean> {
    if (!isTauri()) {
        return window.confirm(message);
    }
    const { confirm } = await import('@tauri-apps/plugin-dialog');
    return confirm(message, options);
}

export async function safeReadTextFile(path: string): Promise<string> {
    if (!isTauri()) {
        if (path.startsWith('web-file://')) {
            const file = (window as any).__BROWSER_FILES__?.[path];
            if (!file) throw new Error("File not found in browser storage");
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = (e) => resolve(e.target?.result as string);
                reader.onerror = (e) => reject(e);
                reader.readAsText(file);
            });
        }
        return "";
    }
    const { readTextFile } = await import('@tauri-apps/plugin-fs');
    return readTextFile(path);
}

export async function safeWriteTextFile(path: string, contents: string): Promise<void> {
    if (!isTauri()) {
        if (path.startsWith('web-download://')) {
            const filename = path.replace('web-download://', '');
            const blob = new Blob([contents], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }
        return;
    }
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    return writeTextFile(path, contents);
}

export async function safeMessage(msg: string, options?: any): Promise<void> {
    if (!isTauri()) {
        alert(msg);
        return;
    }
    const { message } = await import('@tauri-apps/plugin-dialog');
    await message(msg, options);
}
