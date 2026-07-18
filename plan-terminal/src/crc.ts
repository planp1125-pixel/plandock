/**
 * CRC Utility Functions for Plan Terminal
 * Supports: CRC-8, CRC-16 MODBUS, CRC-32
 */

/**
 * CRC-8 (polynomial 0x07, init 0x00)
 */
export function crc8(data: number[]): number {
    let crc = 0x00;
    for (const byte of data) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) {
            if (crc & 0x80) {
                crc = ((crc << 1) ^ 0x07) & 0xFF;
            } else {
                crc = (crc << 1) & 0xFF;
            }
        }
    }
    return crc;
}

/**
 * CRC-16 MODBUS (polynomial 0x8005, init 0xFFFF, reflected)
 * Returns [lowByte, highByte] for little-endian append
 */
export function crc16Modbus(data: number[]): [number, number] {
    let crc = 0xFFFF;
    for (const byte of data) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) {
            if (crc & 0x0001) {
                crc = (crc >> 1) ^ 0xA001;
            } else {
                crc = crc >> 1;
            }
        }
    }
    return [crc & 0xFF, (crc >> 8) & 0xFF];
}

/**
 * CRC-32 (polynomial 0xEDB88320, init 0xFFFFFFFF, reflected, final XOR 0xFFFFFFFF)
 * Returns 4 bytes [b0, b1, b2, b3] in little-endian order
 */
export function crc32(data: number[]): number[] {
    let crc = 0xFFFFFFFF;
    for (const byte of data) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) {
            if (crc & 1) {
                crc = (crc >>> 1) ^ 0xEDB88320;
            } else {
                crc = crc >>> 1;
            }
        }
    }
    crc = (crc ^ 0xFFFFFFFF) >>> 0; // Final XOR and ensure unsigned
    return [
        crc & 0xFF,
        (crc >> 8) & 0xFF,
        (crc >> 16) & 0xFF,
        (crc >> 24) & 0xFF
    ];
}

export type CrcType = 'none' | 'crc8' | 'crc16-modbus' | 'crc32';

/**
 * Calculate CRC bytes based on type
 */
export function calculateCrc(data: number[], type: CrcType): number[] {
    switch (type) {
        case 'crc8':
            return [crc8(data)];
        case 'crc16-modbus':
            return crc16Modbus(data);
        case 'crc32':
            return crc32(data);
        default:
            return [];
    }
}
