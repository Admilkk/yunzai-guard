import type { GuardSettings } from "../shared/types.js";
export interface RuntimeManifest {
    version: 1;
    generation: number;
    projectId: string;
    settings: GuardSettings;
    endpoint: string;
    token: string;
}
