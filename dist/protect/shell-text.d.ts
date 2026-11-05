export declare function shellEscape(text: string, at: number, powershell: boolean): {
    value: string;
    end: number;
} | undefined;
/** Remove the display-only interactive Bash prompt, which otherwise loads rc files.
 * The checked text and the text actually executed must use this same normalization. */
export declare function normalizeShellText(text: string): string;
export declare function isShellProgram(file: string): boolean;
export declare function powershellInlineOption(value: string): "encoded" | "plain" | undefined;
/** PowerShell -EncodedCommand is UTF-16LE, not UTF-8. Never evaluate decoded text. */
export declare function decodeShellCommand(value: string): string | undefined;
/** Extract $(...) without evaluating it; quote and nesting boundaries are preserved. */
export declare function shellSubstitution(text: string, start: number): {
    text: string;
    end: number;
} | undefined;
