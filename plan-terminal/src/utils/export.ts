import { safeInvoke, safeSave, safeWriteTextFile, safeMessage } from './tauri';
import { LogEntry } from '../components/Terminal';

const CONTROL_CHAR_NAMES: Record<number, string> = {
    0: "NUL", 1: "SOH", 2: "STX", 3: "ETX", 4: "EOT", 5: "ENQ", 6: "ACK", 7: "BEL",
    8: "BS", 9: "HT", 10: "LF", 11: "VT", 12: "FF", 13: "CR", 14: "SO", 15: "SI",
    16: "DLE", 17: "DC1", 18: "DC2", 19: "DC3", 20: "DC4", 21: "NAK", 22: "SYN", 23: "ETB",
    24: "CAN", 25: "EM", 26: "SUB", 27: "ESC", 28: "FS", 29: "GS", 30: "RS", 31: "US",
    127: "DEL"
};

export const filterAnsi = (bytes: number[]): number[] => {
    let out: number[] = [];
    let inAnsi = false;
    let inOsc = false;

    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];

        if (inAnsi) {
            if ((b >= 65 && b <= 90) || (b >= 97 && b <= 122)) inAnsi = false;
            continue;
        }
        if (inOsc) {
            if (b === 7) inOsc = false;
            else if (b === 27 && i + 1 < bytes.length && bytes[i + 1] === 92) {
                inOsc = false;
                i++;
            }
            continue;
        }

        if (b === 27 && i + 1 < bytes.length) {
            const next = bytes[i + 1];
            if (next === 91) { inAnsi = true; i++; continue; }
            else if (next === 93) { inOsc = true; i++; continue; }
            else if (next === 40 || next === 41) { i += 2; continue; }
            else if (next === 61 || next === 62) { i++; continue; }
        }

        out.push(b);
    }
    return out;
};

const formatTimestamp = (ts: number) => {
    const d = new Date(ts);
    const date = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const time = d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0') + ':' + d.getSeconds().toString().padStart(2, '0') + '.' + d.getMilliseconds().toString().padStart(3, '0');
    return `${date} ${time}`;
};

export const formatLogLine = (l: LogEntry, format: 'ascii' | 'hex' | 'bin' | 'dec' | 'combined', stripAnsi: boolean = true) => {
    const tsString = formatTimestamp(l.timestamp);
    const prefix = `[${tsString}] `;

    const bytesToProcess = stripAnsi ? filterAnsi(l.data) : l.data;

    const hex = bytesToProcess.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
    const ascii = bytesToProcess.map(b => {
        if (b < 32 || b === 127) return `<${CONTROL_CHAR_NAMES[b] || "??"}>`;
        return String.fromCharCode(b);
    }).join('');
    const bin = l.data.map(b => b.toString(2).padStart(8, '0')).join(' ');

    switch (format) {
        case 'ascii': return `${prefix}[${l.direction}] ${ascii}`;
        case 'hex': return `${prefix}[${l.direction}] ${hex}`;
        case 'bin': return `${prefix}[${l.direction}] ${bin}`;
        case 'dec': return `${prefix}[${l.direction}] ${l.data.join(' ')}`;
        default: return `${prefix}[${l.direction}] HEX: ${hex} | ASCII: ${ascii}`;
    }
};

export async function handleTerminalExport(
    logs: LogEntry[],
    isPro: boolean,
    freeLimit: number,
    opts: { exportAscii: boolean, exportHex: boolean, exportBin: boolean, exportDec: boolean }
) {
    try {
        const exportLogs = isPro ? logs : logs.slice(-freeLimit);
        const limitNotice = !isPro && logs.length > freeLimit
            ? `\n\n--- FREE VERSION: Only last ${freeLimit} entries exported. Upgrade to Pro for unlimited export. ---\n`
            : '';

        const anyFormatSelected = opts.exportAscii || opts.exportHex || opts.exportBin || opts.exportDec;

        if (anyFormatSelected) {
            const path = await safeSave({
                filters: [{ name: 'Log Files', extensions: ['log', 'txt'] }],
                defaultPath: `plan_terminal_log_${Date.now()}.log`
            });
            if (!path) return;

            const basePath = path.replace(/\.(log|txt)$/, '');
            const ext = path.match(/\.(log|txt)$/)?.[0] || '.log';
            const savedFiles: string[] = [];

            if (opts.exportAscii) {
                const text = exportLogs.map(l => formatLogLine(l, 'ascii')).join('\n') + limitNotice;
                await safeInvoke('write_file_direct', { path: `${basePath}_ascii${ext}`, content: text });
                savedFiles.push('ASCII');
            }
            if (opts.exportHex) {
                const text = exportLogs.map(l => formatLogLine(l, 'hex')).join('\n') + limitNotice;
                await safeInvoke('write_file_direct', { path: `${basePath}_hex${ext}`, content: text });
                savedFiles.push('HEX');
            }
            if (opts.exportBin) {
                const text = exportLogs.map(l => formatLogLine(l, 'bin')).join('\n') + limitNotice;
                await safeInvoke('write_file_direct', { path: `${basePath}_bin${ext}`, content: text });
                savedFiles.push('BIN');
            }
            if (opts.exportDec) {
                const text = exportLogs.map(l => formatLogLine(l, 'dec')).join('\n') + limitNotice;
                await safeInvoke('write_file_direct', { path: `${basePath}_dec${ext}`, content: text });
                savedFiles.push('DEC');
            }

            await safeMessage(`Saved ${savedFiles.join(', ')} logs as separate files`, { title: 'Export Complete', kind: 'info' });
        } else {
            const text = exportLogs.map(l => formatLogLine(l, 'combined')).join('\n') + limitNotice;
            const path = await safeSave({
                filters: [{ name: 'Text Files', extensions: ['txt'] }],
                defaultPath: `plan_terminal_log_${Date.now()}.txt`
            });
            if (path) {
                await safeWriteTextFile(path, text);
                await safeMessage('Log saved successfully', { title: 'Success', kind: 'info' });
            }
        }
    } catch (error) {
        console.error('Failed to export logs:', error);
        await safeMessage(`Failed to save file: ${error}`, { title: 'Error', kind: 'error' });
    }
}
