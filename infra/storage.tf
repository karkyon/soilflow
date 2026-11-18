# PDF・サイン・スキャン（02 6.2・6.3：消せない・書き換えられない）
resource "google_storage_bucket" "files" {
  name                        = "${var.project_id}-files"
  location                    = var.region
  storage_class               = "STANDARD"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  labels                      = local.labels
  versioning { enabled = true }
  retention_policy {
    retention_period = 7 * 365 * 24 * 3600
    is_locked        = var.retention_locked
  }
  lifecycle_rule {
    condition { age = 365 }
    action {
      type          = "SetStorageClass"
      storage_class = "NEARLINE"
    }
  }
  # 署名付き URL でブラウザから開くため（12 2.2）
  cors {
    origin          = ["https://${var.domain}"]
    method          = ["GET"]
    response_header = ["Content-Type", "Content-Disposition"]
    max_age_seconds = 300
  }
}

# DB の月次エクスポート（7年保持）
resource "google_storage_bucket" "archive" {
  name                        = "${var.project_id}-archive"
  location                    = var.region
  storage_class               = "ARCHIVE"
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  labels                      = local.labels
  retention_policy {
    retention_period = 7 * 365 * 24 * 3600
    is_locked        = var.retention_locked
  }
}
