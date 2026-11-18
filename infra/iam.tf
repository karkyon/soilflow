# サービスアカウント（最小の権限、12 2.3）。鍵ファイルは作らない
resource "google_service_account" "sa" {
  for_each     = { api = "SoilFlow API（Cloud Run）", migrate = "SoilFlow DB の変更（Cloud Run ジョブ）", scheduler = "SoilFlow 定期実行（Cloud Scheduler）", deploy = "SoilFlow デプロイ（GitHub Actions）", export = "SoilFlow DB の月次エクスポート" }
  account_id   = "sa-${each.key}"
  display_name = each.value
}

locals { sa = { for k, v in google_service_account.sa : k => v.email } }

# --- sa-api
resource "google_project_iam_member" "api" {
  for_each = toset(["roles/cloudsql.client", "roles/cloudsql.instanceUser", "roles/logging.logWriter", "roles/monitoring.metricWriter", "roles/cloudtrace.agent"])
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${local.sa.api}"
}
resource "google_storage_bucket_iam_member" "api_files" {
  for_each = toset(["roles/storage.objectCreator", "roles/storage.objectViewer"])
  bucket   = google_storage_bucket.files.name
  role     = each.value
  member   = "serviceAccount:${local.sa.api}"
}
resource "google_kms_crypto_key_iam_member" "api_freee_token" {
  crypto_key_id = google_kms_crypto_key.freee_token.id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:${local.sa.api}"
}
resource "google_secret_manager_secret_iam_member" "api" {
  for_each  = merge({ for k, v in google_secret_manager_secret.manual : k => v.id }, { "database-url" = google_secret_manager_secret.database_url.id, "session-secret" = google_secret_manager_secret.session_secret.id })
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${local.sa.api}"
}
# 署名付き URL（signBlob）を自分の名前で作る
resource "google_service_account_iam_member" "api_sign_self" {
  service_account_id = google_service_account.sa["api"].name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${local.sa.api}"
}

# --- sa-migrate
resource "google_project_iam_member" "migrate" {
  for_each = toset(["roles/cloudsql.client", "roles/cloudsql.instanceUser", "roles/logging.logWriter"])
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${local.sa.migrate}"
}
resource "google_secret_manager_secret_iam_member" "migrate_db" {
  secret_id = google_secret_manager_secret.database_url.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${local.sa.migrate}"
}

# --- sa-scheduler：API の呼び出し（OIDC）と、営業時間の最小台数の切り替え
resource "google_cloud_run_v2_service_iam_member" "scheduler_invoke" {
  name     = google_cloud_run_v2_service.api.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${local.sa.scheduler}"
}
resource "google_cloud_run_v2_service_iam_member" "scheduler_scale" {
  name     = google_cloud_run_v2_service.api.name
  location = var.region
  role     = "roles/run.developer"
  member   = "serviceAccount:${local.sa.scheduler}"
}
resource "google_service_account_iam_member" "scheduler_actas_api" {
  service_account_id = google_service_account.sa["api"].name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${local.sa.scheduler}"
}

# --- sa-export：Cloud SQL のエクスポート → archive バケット
resource "google_project_iam_member" "export" {
  project = var.project_id
  role    = "roles/cloudsql.viewer"
  member  = "serviceAccount:${local.sa.export}"
}
resource "google_project_iam_custom_role" "sql_exporter" {
  role_id     = "soilflowSqlExporter"
  title       = "SoilFlow Cloud SQL export"
  permissions = ["cloudsql.instances.export", "cloudsql.instances.get"]
}
resource "google_project_iam_member" "export_custom" {
  project = var.project_id
  role    = google_project_iam_custom_role.sql_exporter.id
  member  = "serviceAccount:${local.sa.export}"
}
# エクスポートを書き込むのは Cloud SQL のサービスアカウント
resource "google_storage_bucket_iam_member" "sql_to_archive" {
  bucket = google_storage_bucket.archive.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_sql_database_instance.main.service_account_email_address}"
}

# --- sa-deploy（GitHub Actions）
resource "google_project_iam_member" "deploy" {
  for_each = toset(["roles/run.admin", "roles/artifactregistry.writer", "roles/firebasehosting.admin", "roles/iam.serviceAccountUser"])
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${local.sa.deploy}"
}
