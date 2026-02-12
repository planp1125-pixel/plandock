export interface ChartConfig {
    id: string;
    name: string;
    textBefore: string;
    textAfter?: string;
    useRegex?: boolean;
    dataType: "Number" | "Word";
    color: string;
    enabled: boolean;
}

export interface ChartDataPoint {
    timestamp: number;
    [key: string]: number | string; // Dynamic keys based on config.name
}

/**
 * Extracts a value from a log line based on the configuration.
 * Returns the extracted number or null if no match found.
 */
export function extractValue(line: string, config: ChartConfig): number | null {
    if (!config.enabled) return null;

    try {
        let regex: RegExp;

        if (config.useRegex) {
            // User provided a raw regex pattern
            // We assume they included a capture group, or we might need to enforce it
            regex = new RegExp(config.textBefore);
        } else {
            // Escape special regex characters in user input
            const escapeRegExp = (string: string) => {
                return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            };

            const before = escapeRegExp(config.textBefore);
            // If textAfter is provided, use it as a lookahead or boundary
            const after = config.textAfter ? escapeRegExp(config.textAfter) : "";

            let patternString = "";

            if (config.dataType === "Number") {
                // Match a number (integer or float)
                // Pattern: textBefore\s*(-?\d+(\.\d+)?)
                patternString = `${before}\\s*(-?\\d+(?:\\.\\d+)?)`;
                if (after) {
                    patternString += `\\s*${after}`;
                }
            } else {
                // Match a word/string (alphanumeric + underscore)
                // Pattern: textBefore\s*(\w+)
                patternString = `${before}\\s*(\\w+)`;
                if (after) {
                    patternString += `\\s*${after}`;
                }
            }
            regex = new RegExp(patternString);
        }

        const match = line.match(regex);

        if (match && match[1]) {
            const value = parseFloat(match[1]);
            return isNaN(value) ? null : value;
        }
    } catch (e) {
        console.error("Regex error in extractValue:", e);
    }

    return null;
}
