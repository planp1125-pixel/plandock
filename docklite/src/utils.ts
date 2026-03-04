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
