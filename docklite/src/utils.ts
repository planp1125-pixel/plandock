export function parseInput(input: string): string {
    // Tag Parsing for ASCII mode
    // Support <CR>, <LF>, <CRLF>, <ESC>, <NUL>, <Decimal>
    return input
        .replace(/<CRLF>/gi, '\r\n')
        .replace(/<CR>/gi, '\r')
        .replace(/<LF>/gi, '\n')
        .replace(/<ESC>/gi, '\x1b')
        .replace(/<NUL>/gi, '\0')
        .replace(/<(\d+)>/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
}

export function parseData(data: string, mode: "Hex" | "Ascii" | "Decimal" | "Binary" | undefined): number[] {
    let bytes: number[] = [];
    if (!data) return bytes;

    if (mode === 'Hex') {
        const clean = data.replace(/[^0-9A-Fa-f]/g, '');
        for (let i = 0; i < clean.length; i += 2) {
            bytes.push(parseInt(clean.substr(i, 2), 16));
        }
    } else if (mode === 'Decimal') {
        const parts = data.trim().split(/\s+/).filter(p => p);
        for (const part of parts) {
            const val = parseInt(part, 10);
            if (!isNaN(val) && val >= 0 && val <= 255) {
                bytes.push(val);
            }
        }
    } else if (mode === 'Binary') {
        const parts = data.trim().split(/\s+/).filter(p => p);
        for (const part of parts) {
            const val = parseInt(part, 2);
            if (!isNaN(val) && val >= 0 && val <= 255) {
                bytes.push(val);
            }
        }
    } else {
        const parsed = parseInput(data);
        for (let i = 0; i < parsed.length; i++) {
            bytes.push(parsed.charCodeAt(i));
        }
    }
    return bytes;
}

export function bytesToHex(bytes: number[]): string {
    return bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

export function bytesToBin(bytes: number[]): string {
    return bytes.map(b => b.toString(2).padStart(8, '0')).join(' ');
}

export function filterAnsi(bytes: number[]): number[] {
    let out: number[] = [];
    let inAnsi = false;
    let inOsc = false;

    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];

        if (inAnsi) {
            // ANSI escape sequences (CSI) end with a letter
            if ((b >= 65 && b <= 90) || (b >= 97 && b <= 122)) {
                inAnsi = false;
            }
            continue;
        }
        if (inOsc) {
            // OSC ends with BEL (7) or ST (ESC \)
            if (b === 7) {
                inOsc = false;
            } else if (b === 27 && i + 1 < bytes.length && bytes[i + 1] === 92) {
                inOsc = false;
                i++; // skip the backslash
            }
            continue;
        }

        // Look ahead for escape sequence start
        if (b === 27 && i + 1 < bytes.length) {
            const next = bytes[i + 1];
            if (next === 91) { // '[' - CSI
                inAnsi = true;
                i++;
                continue;
            } else if (next === 93) { // ']' - OSC
                inOsc = true;
                i++;
                continue;
            } else if (next === 40 || next === 41) { // '(' or ')' - G0/G1 charset
                i += 2; // skip ESC ( B
                continue;
            } else if (next === 61 || next === 62) { // '=' or '>' - Application keypad
                i++;
                continue;
            }
        }

        out.push(b);
    }
    return out;
}
