resource "google_sql_database_instance" "main" {
  name             = "soilflow-${local.env}"
  database_version = "POSTGRES_16"
  region           = var.region
  # 本番は消せないように
  deletion_protection = var.env == "prod"

  settings {
    tier              = var.db_tier
    edition           = "ENTERPRISE"
    availability_type = "ZONAL"
    disk_type         = "PD_SSD"
    disk_size         = 10
    disk_autoresize   = true
    user_labels       = local.labels

    ip_configuration {
      ipv4_enabled                                  = false
      private_network                               = google_compute_network.vpc.id
      enable_private_path_for_google_cloud_services = true
      ssl_mode                                      = "ENCRYPTED_ONLY"
    }
    # 毎日 3:00（JST）＝ 18:00 UTC、7世代、ポイントインタイムリカバリ 7日（NFR-08）
    backup_configuration {
      enabled                        = true
      start_time                     = "18:00"
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7
      backup_retention_settings {
        retained_backups = 7
        retention_unit   = "COUNT"
      }
    }
    # 日曜 4:00 JST ＝ 土曜 19:00 UTC
    maintenance_window {
      day          = 6
      hour         = 19
      update_track = "stable"
    }
    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }
    database_flags {
      name  = "log_min_duration_statement"
      value = "1000"
    }
    insights_config {
      query_insights_enabled = true
    }
  }
  depends_on = [google_service_networking_connection.sql]
}

resource "google_sql_database" "soilflow" {
  name     = "soilflow"
  instance = google_sql_database_instance.main.name
}

resource "random_password" "db" {
  length  = 32
  special = false
}

# アプリの DB ユーザー（テーブルの所有者。migrate ジョブも同じユーザーで流す）
resource "google_sql_user" "app" {
  name     = "soilflow"
  instance = google_sql_database_instance.main.name
  password = random_password.db.result
}
