# GitHub の Environment（stg・prod）の変数に入れる値
output "gcp_workload_identity_provider" { value = google_iam_workload_identity_pool_provider.github.name }
output "gcp_deploy_service_account" { value = local.sa.deploy }
output "api_url" { value = local.api_url }
output "artifact_registry" { value = "${var.region}-docker.pkg.dev/${var.project_id}/soilflow" }
output "sql_instance" { value = google_sql_database_instance.main.connection_name }
output "files_bucket" { value = google_storage_bucket.files.name }
output "archive_bucket" { value = google_storage_bucket.archive.name }
