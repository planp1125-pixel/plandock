// ============================================================================
// ARCHIVED: LemonSqueezy License Provider
// ============================================================================
// This module is NOT currently in use. It is kept for potential future migration
// back to LemonSqueezy if needed. The active license provider is Gumroad.
//
// To switch back to LemonSqueezy:
// 1. Update mod.rs to use this module instead of gumroad.rs
// 2. Uncomment the `mod lemonsqueezy;` line in mod.rs
// 3. Update the LicenseManager to call LemonSqueezy functions
// ============================================================================

#![allow(dead_code)]

use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use super::LicenseStatus;

// LemonSqueezy API endpoints
const LEMONSQUEEZY_ACTIVATE_URL: &str = "https://api.lemonsqueezy.com/v1/licenses/activate";
const LEMONSQUEEZY_DEACTIVATE_URL: &str = "https://api.lemonsqueezy.com/v1/licenses/deactivate";
const LEMONSQUEEZY_VALIDATE_URL: &str = "https://api.lemonsqueezy.com/v1/licenses/validate";

// LemonSqueezy API response structures
#[derive(Deserialize, Debug)]
struct LemonSqueezyActivateResponse {
    activated: bool,
    #[serde(default)]
    error: Option<String>,
    instance: Option<LemonSqueezyInstance>,
    license_key: Option<LemonSqueezyLicenseKey>,
}

#[derive(Deserialize, Debug)]
struct LemonSqueezyDeactivateResponse {
    deactivated: bool,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Deserialize, Debug)]
struct LemonSqueezyValidateResponse {
    valid: bool,
    license_key: Option<LemonSqueezyLicenseKey>,
}

#[derive(Deserialize, Debug)]
struct LemonSqueezyInstance {
    id: String,
}

#[derive(Deserialize, Debug)]
struct LemonSqueezyLicenseKey {
    status: String,
    #[serde(default)]
    activation_limit: i32,
    #[serde(default)]
    activation_usage: i32,
}

pub struct LemonSqueezyProvider {
    storage_path: PathBuf,
    instance_name: String,
}

impl LemonSqueezyProvider {
    pub fn new(app_data_dir: PathBuf) -> Self {
        let storage_path = app_data_dir.join("license.json");
        let instance_name = Self::get_machine_id();
        Self {
            storage_path,
            instance_name,
        }
    }

    fn get_machine_id() -> String {
        let hostname = hostname::get()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|_| "unknown".to_string());
        let username = whoami::username();
        format!("{}-{}", hostname, username)
    }

    fn validate_key_format(&self, key: &str) -> bool {
        key.trim().len() >= 8
    }

    pub fn validate_key_online(&self, key: &str) -> Result<bool, String> {
        let client = reqwest::blocking::Client::new();
        let response = client
            .post(LEMONSQUEEZY_VALIDATE_URL)
            .header("Accept", "application/json")
            .header("Content-Type", "application/x-www-form-urlencoded")
            .form(&[("license_key", key)])
            .send()
            .map_err(|e| format!("Network error: {}", e))?;

        let data: LemonSqueezyValidateResponse =
            response.json().map_err(|e| format!("Parse error: {}", e))?;

        if data.valid {
            if let Some(lk) = data.license_key {
                return Ok(lk.status == "active");
            }
        }
        Ok(false)
    }

    pub fn activate_key_online(&self, key: &str) -> Result<String, String> {
        let client = reqwest::blocking::Client::new();
        let response = client
            .post(LEMONSQUEEZY_ACTIVATE_URL)
            .header("Accept", "application/json")
            .header("Content-Type", "application/x-www-form-urlencoded")
            .form(&[("license_key", key), ("instance_name", &self.instance_name)])
            .send()
            .map_err(|e| format!("Network error: {}", e))?;

        let data: LemonSqueezyActivateResponse =
            response.json().map_err(|e| format!("Parse error: {}", e))?;

        if data.activated {
            if let Some(instance) = data.instance {
                return Ok(instance.id);
            }
            return Err("Activation successful but no instance ID returned".to_string());
        }

        if let Some(error) = data.error {
            if error.contains("limit") || error.contains("activation") {
                return Err(
                    "Activation limit reached. Please deactivate from another device first."
                        .to_string(),
                );
            }
            return Err(error);
        }

        Err("License activation failed".to_string())
    }

    pub fn deactivate_key_online(&self, key: &str, instance_id: &str) -> Result<(), String> {
        let client = reqwest::blocking::Client::new();
        let response = client
            .post(LEMONSQUEEZY_DEACTIVATE_URL)
            .header("Accept", "application/json")
            .header("Content-Type", "application/x-www-form-urlencoded")
            .form(&[("license_key", key), ("instance_id", instance_id)])
            .send()
            .map_err(|e| format!("Network error: {}", e))?;

        let data: LemonSqueezyDeactivateResponse =
            response.json().map_err(|e| format!("Parse error: {}", e))?;

        if data.deactivated {
            return Ok(());
        }

        if let Some(error) = data.error {
            return Err(error);
        }

        Err("License deactivation failed".to_string())
    }

    pub fn activate(&self, key: &str) -> Result<bool, String> {
        let key_trimmed = key.trim().to_string();
        if !self.validate_key_format(&key_trimmed) {
            return Err("Invalid license key format".to_string());
        }

        match self.activate_key_online(&key_trimmed) {
            Ok(instance_id) => {
                let status = LicenseStatus {
                    is_pro: true,
                    is_trial: false,
                    trial_days_remaining: 0,
                    license_key: Some(key_trimmed),
                    instance_id: Some(instance_id),
                    activated_at: Some(Utc::now().to_rfc3339()),
                    trial_started_at: None,
                };

                if let Some(parent) = self.storage_path.parent() {
                    let _ = fs::create_dir_all(parent);
                }

                fs::write(
                    &self.storage_path,
                    serde_json::to_string_pretty(&status).map_err(|e| e.to_string())?,
                )
                .map_err(|e| e.to_string())?;

                Ok(true)
            }
            Err(e) => Err(e),
        }
    }

    pub fn deactivate(&self) -> Result<(), String> {
        if let Ok(content) = fs::read_to_string(&self.storage_path) {
            if let Ok(status) = serde_json::from_str::<LicenseStatus>(&content) {
                if let (Some(key), Some(instance_id)) = (status.license_key, status.instance_id) {
                    if let Err(e) = self.deactivate_key_online(&key, &instance_id) {
                        eprintln!("Warning: Online deactivation failed: {}", e);
                    }
                }
            }
        }

        let new_status = LicenseStatus::default();
        fs::write(
            &self.storage_path,
            serde_json::to_string_pretty(&new_status).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;

        Ok(())
    }
}
