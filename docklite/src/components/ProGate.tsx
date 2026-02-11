import { ReactNode } from 'react';
import { useLicense } from '../contexts/LicenseContext';
import { Lock } from 'lucide-react';

interface ProGateProps {
    children: ReactNode;
    feature: string;
    showLock?: boolean;
    inline?: boolean;
}

/**
 * Wrapper component that shows upgrade prompt for Pro-only features.
 * When user is not Pro, shows a lock overlay or disabled state.
 */
export function ProGate({ children, feature, showLock = true, inline = false }: ProGateProps) {
    const { isPro } = useLicense();

    if (isPro) {
        // Pro users see the full feature
        return <>{children}</>;
    }

    if (inline) {
        // Inline mode: just show lock icon next to disabled content
        return (
            <div className="flex items-center gap-1 opacity-50 cursor-not-allowed" title={`${feature} - Pro feature`}>
                {showLock && <Lock className="w-3 h-3 text-yellow-500" />}
                <span className="pointer-events-none">{children}</span>
            </div>
        );
    }

    // Block mode: overlay with upgrade prompt
    return (
        <div className="relative group">
            <div className="opacity-40 pointer-events-none select-none blur-[1px]">
                {children}
            </div>
            <div className="absolute inset-0 flex items-center justify-center bg-background/60 backdrop-blur-sm rounded-lg opacity-0 group-hover:opacity-100 transition-opacity">
                <div className="text-center p-3">
                    <Lock className="w-5 h-5 mx-auto mb-1 text-yellow-500" />
                    <p className="text-xs font-medium text-foreground">{feature}</p>
                    <p className="text-[10px] text-muted-foreground">Pro Feature</p>
                </div>
            </div>
        </div>
    );
}

/**
 * Simple Pro badge to show next to features
 */
export function ProBadge() {
    return (
        <span className="inline-flex items-center gap-0.5 px-1 py-0.5 bg-gradient-to-r from-yellow-500/20 to-orange-500/20 text-yellow-600 dark:text-yellow-400 rounded text-[10px] font-semibold">
            <Lock className="w-2.5 h-2.5" />
            PRO
        </span>
    );
}
