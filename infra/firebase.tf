# Firebase Hosting（画面の静的ファイル・/api/** を Cloud Run へ、12 2.2）。サイトとドメインまで Terraform で作り、配るファイルは deploy.yml
resource "google_firebase_project" "this" {
  provider   = google-beta
  project    = var.project_id
  depends_on = [google_project_service.apis]
}

resource "google_firebase_hosting_site" "default" {
  provider   = google-beta
  project    = var.project_id
  site_id    = var.project_id
  depends_on = [google_firebase_project.this]
}

# 独自ドメイン（*.web.app のときは作らない）。作ったあと、出てくる DNS のレコードをドメインの管理画面に入れる（Q-33）
resource "google_firebase_hosting_custom_domain" "domain" {
  provider              = google-beta
  count                 = endswith(var.domain, ".web.app") ? 0 : 1
  project               = var.project_id
  site_id               = google_firebase_hosting_site.default.site_id
  custom_domain         = var.domain
  wait_dns_verification = false
}

output "hosting_default_url" { value = "https://${google_firebase_hosting_site.default.site_id}.web.app" }
output "dns_records" {
  description = "独自ドメインの DNS に入れるレコード"
  value       = length(google_firebase_hosting_custom_domain.domain) > 0 ? google_firebase_hosting_custom_domain.domain[0].required_dns_updates : null
}
