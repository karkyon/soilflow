# freee の鍵（アクセストークン・リフレッシュトークン）の暗号化（NFR-14）。90日ごとに新しい版
resource "google_kms_key_ring" "soilflow" {
  name       = "soilflow"
  location   = var.region
  depends_on = [google_project_service.apis]
}

resource "google_kms_crypto_key" "freee_token" {
  name            = "freee-token"
  key_ring        = google_kms_key_ring.soilflow.id
  rotation_period = "7776000s"
  purpose         = "ENCRYPT_DECRYPT"
  labels          = local.labels
  lifecycle { prevent_destroy = true }
}
