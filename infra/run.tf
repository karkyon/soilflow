# Cloud Run soilflow-api（12 2.2）。イメージの更新は GitHub Actions（gcloud run deploy）で行い、Terraform は変えない
locals {
  bootstrap = var.image_tag == "bootstrap"
  env_plain = {
    NODE_ENV                  = "production"
    ADAPTERS                  = "real"
    PUBLIC_BASE_URL           = "https://${var.domain}"
    COOKIE_SECURE             = "true"
    GCS_BUCKET                = google_storage_bucket.files.name
    KMS_KEY_NAME              = google_kms_crypto_key.freee_token.id
    SCHEDULER_AUDIENCE        = local.api_url
    SCHEDULER_SERVICE_ACCOUNT = local.sa.scheduler
    MAIL_REDIRECT_TO          = var.mail_redirect_to
    DB_POOL_MAX               = "8"
  }
  env_secret = {
    DATABASE_URL                = google_secret_manager_secret.database_url.secret_id
    SESSION_SECRET              = google_secret_manager_secret.session_secret.secret_id
    FREEE_CLIENT_ID             = "freee-client-id"
    FREEE_CLIENT_SECRET         = "freee-client-secret"
    SENDGRID_API_KEY            = "sendgrid-api-key"
    SENDGRID_WEBHOOK_PUBLIC_KEY = "sendgrid-webhook-public-key"
  }
}

# 手で入れるシークレットの仮の値（初回の apply でリビジョンが起動できるように。本当の値は gcloud で新しい版を足す）
resource "google_secret_manager_secret_version" "placeholder" {
  for_each    = google_secret_manager_secret.manual
  secret      = each.value.id
  secret_data = "UNSET"
  lifecycle { ignore_changes = [secret_data, enabled] }
}

resource "google_cloud_run_v2_service" "api" {
  name                = local.api_name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = var.env == "prod"
  labels              = local.labels

  # 営業時間は1台、夜間は0台（scheduler.tf で切り替える）
  scaling { min_instance_count = 0 }

  template {
    service_account                  = local.sa.api
    timeout                          = "60s"
    max_instance_request_concurrency = 40
    execution_environment            = "EXECUTION_ENVIRONMENT_GEN2"
    scaling {
      min_instance_count = 0
      max_instance_count = 3
    }
    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = google_compute_network.vpc.id
        subnetwork = google_compute_subnetwork.run.id
      }
    }
    containers {
      image = local.bootstrap ? "us-docker.pkg.dev/cloudrun/container/hello" : local.image
      ports { container_port = 8080 }
      resources {
        limits            = { cpu = "1", memory = "512Mi" }
        cpu_idle          = true
        startup_cpu_boost = true
      }
      dynamic "env" {
        for_each = local.bootstrap ? {} : local.env_plain
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = local.bootstrap ? {} : local.env_secret
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      startup_probe {
        http_get { path = local.bootstrap ? "/" : "/api/v1/healthz" }
        period_seconds    = 3
        failure_threshold = 20
      }
      liveness_probe {
        http_get { path = local.bootstrap ? "/" : "/api/v1/healthz" }
        period_seconds = 30
      }
    }
  }

  lifecycle {
    # イメージと、Scheduler が切り替える最小台数は Terraform の外で変わる
    ignore_changes = [template[0].containers[0].image, scaling[0].min_instance_count, client, client_version, template[0].labels]
  }
  depends_on = [google_secret_manager_secret_version.placeholder, google_secret_manager_secret_iam_member.api, google_project_service.apis]
}

# Firebase Hosting の /api/** のリライトから呼ぶため、だれでも呼べる（認証はアプリの Cookie・CSRF、13 章）
resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.api.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# DB の変更（マイグレーション）。デプロイの前に GitHub Actions が実行する
resource "google_cloud_run_v2_job" "migrate" {
  name                = "soilflow-migrate"
  location            = var.region
  deletion_protection = false
  labels              = local.labels
  template {
    task_count = 1
    template {
      service_account = local.sa.migrate
      max_retries     = 0
      timeout         = "600s"
      vpc_access {
        egress = "PRIVATE_RANGES_ONLY"
        network_interfaces {
          network    = google_compute_network.vpc.id
          subnetwork = google_compute_subnetwork.run.id
        }
      }
      containers {
        # 引数を差し替えて初期データにも使う（bootstrap.sh：--args=dist/prisma/seed.js）
        image   = local.bootstrap ? "us-docker.pkg.dev/cloudrun/container/job" : local.image
        command = local.bootstrap ? null : ["node"]
        args    = local.bootstrap ? null : ["dist/scripts/migrate.js"]
        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.database_url.secret_id
              version = "latest"
            }
          }
        }
        resources { limits = { cpu = "1", memory = "512Mi" } }
      }
    }
  }
  lifecycle { ignore_changes = [template[0].template[0].containers[0].image, client, client_version] }
  depends_on = [google_secret_manager_secret_iam_member.migrate_db]
}
