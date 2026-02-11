import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';

export interface LicenseStatus {
    is_pro: boolean;
    is_trial: boolean;
    trial_days_remaining: number;
    license_key: string | null;
    activated_at: string | null;
    trial_started_at: string | null;
}

// Free tier limits
export const FREE_LIMITS = {
    MAX_SEQUENCES: 10,
    MAX_EXPORT_LINES: 100,
    REACTIONS_VISIBLE: true,  // Can see but not use
    REACTIONS_ENABLED: false,
    LOGGING_ENABLED: false,
    SAVE_LOAD_ENABLED: false,
};

interface LicenseContextType {
    isPro: boolean;
    isTrial: boolean;
    trialDaysRemaining: number;
    licenseKey: string | null;
    loading: boolean;
    activate: (key: string) => Promise<{ success: boolean; error?: string }>;
    deactivate: () => Promise<void>;
    refresh: () => Promise<void>;
}

const LicenseContext = createContext<LicenseContextType | null>(null);

export function LicenseProvider({ children }: { children: ReactNode }) {
    const [status, setStatus] = useState<LicenseStatus>({
        is_pro: false,
        is_trial: false,
        trial_days_remaining: 0,
        license_key: null,
        activated_at: null,
        trial_started_at: null,
    });
    const [loading, setLoading] = useState(true);

    const refresh = async () => {
        try {
            const result = await invoke<LicenseStatus>('get_license_status');
            setStatus(result);
        } catch (e) {
            console.error('Failed to get license status:', e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        refresh();
    }, []);

    const activate = async (key: string): Promise<{ success: boolean; error?: string }> => {
        try {
            await invoke('activate_license', { key });
            await refresh();
            return { success: true };
        } catch (e: any) {
            return { success: false, error: e.toString() };
        }
    };

    const deactivate = async () => {
        try {
            await invoke('deactivate_license');
            await refresh();
        } catch (e) {
            console.error('Failed to deactivate license:', e);
        }
    };

    return (
        <LicenseContext.Provider
            value={{
                isPro: status.is_pro,
                isTrial: status.is_trial,
                trialDaysRemaining: status.trial_days_remaining,
                licenseKey: status.license_key,
                loading,
                activate,
                deactivate,
                refresh,
            }}
        >
            {children}
        </LicenseContext.Provider>
    );
}

export function useLicense() {
    const context = useContext(LicenseContext);
    if (!context) {
        throw new Error('useLicense must be used within a LicenseProvider');
    }
    return context;
}
