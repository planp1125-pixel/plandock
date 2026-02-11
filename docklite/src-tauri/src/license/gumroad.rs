// ============================================================================
// ACTIVE: Gumroad License Provider
// ============================================================================
// This is the currently active license provider for Plan Terminal.
//
// Gumroad API: POST https://api.gumroad.com/v2/licenses/verify
// Docs: https://app.gumroad.com/api#licenses
// ============================================================================

use chrono::Utc;
use serde::Deserialize;
use std::fs;
use std::path::PathBuf;

use super::LicenseStatus;

// TODO: Replace with your actual Gumroad product permalink
const GUMROAD_PRODUCT_ID: &str = "plan-terminal";

const GUMROAD_VERIFY_URL: &str = "https://api.gumroad.com/v2/licenses/verify";

// Gumroad API response structures
#[derive(Deserialize, Debug)]
struct GumroadVerifyResponse {
    success: bool,
    #[serde(default)]
    uses: i32,
    #[serde(default)]
    message: Option<String>,
    purchase: Option<GumroadPurchase>,
}

#[derive(Deserialize, Debug)]
struct GumroadPurchase {
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    license_key: Option<String>,
    #[serde(default)]
    refunded: bool,
    #[serde(default)]
    chargebacked: bool,
    #[serde(default)]
    disputed: bool,
}

#[derive(Clone)]
pub struct GumroadProvider {
    storage_path: PathBuf,
}

impl GumroadProvider {
    pub fn new(app_data_dir: PathBuf) -> Self {
        let storage_path = app_data_dir.join("license.json");
        Self { storage_path }
    }

    /// Verify a license key with Gumroad API
    fn verify_key_online(&self, key: &str, increment: bool) -> Result<bool, String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| format!("Client error: {}", e))?;

        let mut params = vec![("product_id", GUMROAD_PRODUCT_ID), ("license_key", key)];

        let increment_str = increment.to_string();
        if increment {
            params.push(("increment_uses_count", &increment_str));
        }

        let response = client
            .post(GUMROAD_VERIFY_URL)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .form(&params)
            .send()
            .map_err(|e| format!("Network error: {}. Check your internet connection.", e))?;

        let data: GumroadVerifyResponse =
            response.json().map_err(|e| format!("Parse error: {}", e))?;

        if data.success {
            // Check if purchase was refunded or chargebacked
            if let Some(ref purchase) = data.purchase {
                if purchase.refunded {
                    return Err("This license has been refunded.".to_string());
                }
                if purchase.chargebacked {
                    return Err("This license has been chargebacked.".to_string());
                }
                if purchase.disputed {
                    return Err("This license is under dispute.".to_string());
                }
            }
            return Ok(true);
        }

        if let Some(msg) = data.message {
            return Err(msg);
        }

        Err("License verification failed".to_string())
    }

    /// Activate a license key (verifies with Gumroad + saves locally)
    pub fn activate(&self, key: &str) -> Result<bool, String> {
        let key_trimmed = key.trim().to_string();

        // Basic format check
        if key_trimmed.len() < 8 {
            return Err("Invalid license key format".to_string());
        }

        // Verify with Gumroad API (increment usage count)
        match self.verify_key_online(&key_trimmed, true) {
            Ok(true) => {
                let status = LicenseStatus {
                    is_pro: true,
                    is_trial: false,
                    trial_days_remaining: 0,
                    license_key: Some(key_trimmed),
                    instance_id: None, // Gumroad doesn't use instance IDs
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
            Ok(false) => Err("License key is not valid".to_string()),
            Err(e) => Err(e),
        }
    }

    /// Deactivate (just clears local data - Gumroad doesn't have deactivation API)
    pub fn deactivate(&self) -> Result<(), String> {
        let new_status = LicenseStatus::default();

        fs::write(
            &self.storage_path,
            serde_json::to_string_pretty(&new_status).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;

        Ok(())
    }
}
