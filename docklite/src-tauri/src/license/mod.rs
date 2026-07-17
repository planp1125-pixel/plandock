// ============================================================================
// License Management Module
// ============================================================================
// This module handles license verification for Plan Terminal Pro.
//
// Currently using: GUMROAD (see gumroad.rs)
// Archived:        LemonSqueezy (see lemonsqueezy.rs)
//
// To switch providers, change which module LicenseManager delegates to.
// ============================================================================

mod gumroad;
// Archived - uncomment to compile LemonSqueezy provider:
// mod lemonsqueezy;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use gumroad::GumroadProvider;

const TRIAL_DAYS: i64 = 30;

/// Shared license status used across all providers
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct LicenseStatus {
    pub is_pro: bool,
    pub is_trial: bool,
    pub trial_days_remaining: i64,
    pub license_key: Option<String>,
    pub instance_id: Option<String>,
    pub activated_at: Option<String>,
    pub trial_started_at: Option<String>,
}

/// Main license manager that delegates to the active provider
#[derive(Clone)]
pub struct LicenseManager {
    storage_path: PathBuf,
    provider: GumroadProvider,
}

impl LicenseManager {
    pub fn new(app_data_dir: PathBuf) -> Self {
        let storage_path = app_data_dir.join("license.json");
        let provider = GumroadProvider::new(app_data_dir);

        Self {
            storage_path,
            provider,
        }
    }

    /// Load license from disk and check trial status
    pub fn get_status(&self) -> LicenseStatus {
        // Try to load existing status
        if let Ok(content) = fs::read_to_string(&self.storage_path) {
            if let Ok(mut status) = serde_json::from_str::<LicenseStatus>(&content) {
                // Check if we have a stored license key
                if let Some(ref key) = &status.license_key {
                    if key.trim().len() >= 8 {
                        status.is_pro = true;
                        status.is_trial = false;
                        status.trial_days_remaining = 0;
                        return status;
                    }
                }

                // Check trial status
                if let Some(ref trial_start) = status.trial_started_at {
                    if let Ok(start_date) = trial_start.parse::<DateTime<Utc>>() {
                        let elapsed = Utc::now().signed_duration_since(start_date);
                        let days_remaining = TRIAL_DAYS - elapsed.num_days();

                        if days_remaining > 0 {
                            return LicenseStatus {
                                is_pro: true,
                                is_trial: true,
                                trial_days_remaining: days_remaining,
                                license_key: None,
                                instance_id: None,
                                activated_at: None,
                                trial_started_at: Some(trial_start.clone()),
                            };
                        } else {
                            return LicenseStatus {
                                is_pro: false,
                                is_trial: false,
                                trial_days_remaining: 0,
                                license_key: None,
                                instance_id: None,
                                activated_at: None,
                                trial_started_at: Some(trial_start.clone()),
                            };
                        }
                    }
                }
            }
        }

        // First run - start trial
        let trial_start = Utc::now().to_rfc3339();
        let status = LicenseStatus {
            is_pro: true,
            is_trial: true,
            trial_days_remaining: TRIAL_DAYS,
            license_key: None,
            instance_id: None,
            activated_at: None,
            trial_started_at: Some(trial_start),
        };

        if let Some(parent) = self.storage_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(
            &self.storage_path,
            serde_json::to_string_pretty(&status).unwrap_or_default(),
        );

        status
    }

    /// Activate a license key (delegates to active provider)
    pub fn activate(&self, key: &str) -> Result<bool, String> {
        self.provider.activate(key)
    }

    /// Deactivate the current license (delegates to active provider)
    pub fn deactivate(&self) -> Result<(), String> {
        self.provider.deactivate()
    }
}
