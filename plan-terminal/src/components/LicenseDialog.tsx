import { useState } from 'react';
import { useLicense } from '../contexts/LicenseContext';
import { X, Key, Check, AlertCircle, Crown, ExternalLink } from 'lucide-react';
import { safeOpenUrl } from '../utils/tauri';

interface LicenseDialogProps {
    isOpen: boolean;
    onClose: () => void;
}

export function LicenseDialog({ isOpen, onClose }: LicenseDialogProps) {
    const { isPro, licenseKey, activate, deactivate, loading } = useLicense();
    const [inputKey, setInputKey] = useState('');
    const [error, setError] = useState('');
    const [activating, setActivating] = useState(false);

    if (!isOpen) return null;

    const handleActivate = async () => {
        setError('');
        setActivating(true);
        const result = await activate(inputKey);
        setActivating(false);

        if (result.success) {
            setInputKey('');
        } else {
            setError(result.error || 'Invalid license key');
        }
    };

    const handleDeactivate = async () => {
        await deactivate();
    };

    const maskedKey = licenseKey
        ? `${licenseKey.slice(0, 9)}****-****`
        : null;

    return (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
            <div
                className="bg-card border rounded-xl shadow-2xl w-full max-w-md p-6"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-2">
                        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${isPro ? 'bg-gradient-to-br from-yellow-400 to-orange-500' : 'bg-muted'}`}>
                            {isPro ? <Crown className="w-4 h-4 text-white" /> : <Key className="w-4 h-4" />}
                        </div>
                        <div>
                            <h2 className="font-semibold">License</h2>
                            <p className="text-xs text-muted-foreground">
                                {isPro ? 'Pro Edition' : 'Free Edition'}
                            </p>
                        </div>
                    </div>
                    <button onClick={onClose} className="p-1 hover:bg-accent rounded">
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {loading ? (
                    <div className="text-center py-8 text-muted-foreground">Loading...</div>
                ) : isPro ? (
                    /* Pro user view */
                    <div>
                        <div className="bg-gradient-to-r from-yellow-500/10 to-orange-500/10 border border-yellow-500/30 rounded-lg p-4 mb-4">
                            <div className="flex items-center gap-2 mb-2">
                                <Check className="w-4 h-4 text-green-500" />
                                <span className="font-medium text-green-600 dark:text-green-400">Pro License Active</span>
                            </div>
                            <p className="text-sm text-muted-foreground font-mono">{maskedKey}</p>
                        </div>

                        <div className="text-sm text-muted-foreground mb-4">
                            <h4 className="font-medium text-foreground mb-2">Pro Features Unlocked:</h4>
                            <ul className="space-y-1">
                                <li className="flex items-center gap-2"><Check className="w-3 h-3 text-green-500" /> Unlimited sequences</li>
                                <li className="flex items-center gap-2"><Check className="w-3 h-3 text-green-500" /> Automated reactions</li>
                                <li className="flex items-center gap-2"><Check className="w-3 h-3 text-green-500" /> Periodic sending</li>
                                <li className="flex items-center gap-2"><Check className="w-3 h-3 text-green-500" /> CRC calculation</li>
                                <li className="flex items-center gap-2"><Check className="w-3 h-3 text-green-500" /> Real-time file logging</li>
                                <li className="flex items-center gap-2"><Check className="w-3 h-3 text-green-500" /> Log export</li>
                                <li className="flex items-center gap-2"><Check className="w-3 h-3 text-green-500" /> Project save/load</li>
                            </ul>
                        </div>

                        <button
                            onClick={handleDeactivate}
                            className="w-full py-2 text-sm text-red-500 hover:bg-red-500/10 rounded-lg transition"
                        >
                            Deactivate License
                        </button>
                    </div>
                ) : (
                    /* Free user view */
                    <div>
                        <div className="mb-4">
                            <label className="block text-sm font-medium mb-2">Enter License Key</label>
                            <input
                                type="text"
                                value={inputKey}
                                onChange={(e) => setInputKey(e.target.value.toUpperCase())}
                                placeholder="XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX"
                                className="w-full px-3 py-2 bg-background border rounded-lg text-sm font-mono focus:ring-2 focus:ring-primary outline-none"
                            />
                            {error && (
                                <div className="flex items-center gap-1 mt-2 text-red-500 text-xs">
                                    <AlertCircle className="w-3 h-3" />
                                    {error}
                                </div>
                            )}
                        </div>

                        <button
                            onClick={handleActivate}
                            disabled={!inputKey || activating}
                            className="w-full py-2.5 bg-primary text-primary-foreground rounded-lg font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition mb-4"
                        >
                            {activating ? 'Activating...' : 'Activate License'}
                        </button>

                        <div className="border-t pt-4">
                            <div className="text-sm text-muted-foreground mb-3">
                                <h4 className="font-medium text-foreground mb-2">Early Bird Access - $49</h4>
                                <ul className="space-y-1 text-xs">
                                    <li>• Unlimited sequences & reactions</li>
                                    <li>• Real-time file logging</li>
                                    <li>• CRC auto-calculation</li>
                                    <li>• Project save/load</li>
                                    <li>• Lifetime license</li>
                                </ul>
                            </div>
                            <button
                                onClick={async () => {
                                    try {
                                        await safeOpenUrl('https://planplabs.gumroad.com/l/eblqxg');
                                    } catch (err) {
                                        console.error('Failed to open link:', err);
                                    }
                                }}
                                className="flex items-center justify-center gap-2 w-full py-2 text-sm text-primary hover:underline"
                            >
                                Purchase License <ExternalLink className="w-3 h-3" />
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
