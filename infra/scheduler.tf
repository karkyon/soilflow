# 定期実行（04 3.4）。毎日の鍵の更新・掃除は、毎分のジョブの中で1日1回ずつ予約される（jobs.module の scheduleDaily）
resource "google_cloud_scheduler_job" "jobs_every_minute" {
  name             = "jobs-every-minute"
  region           = var.region
  schedule         = "* * * * *"
  time_zone        = "Asia/Tokyo"
  attempt_deadline = "60s"
  retry_config { retry_count = 0 }
  http_target {
    http_method = "POST"
    uri         = "${local.api_url}/api/v1/internal/jobs/run"
    oidc_token {
      service_account_email = local.sa.scheduler
      audience              = local.api_url
    }
  }
  depends_on = [google_project_service.apis]
}

# 営業時間（7:00〜18:00）は最小1台、それ以外は0台（NFR-01、12 6章）
resource "google_cloud_scheduler_job" "scale" {
  for_each  = { up = { cron = "50 6 * * *", n = var.min_instances_business_hours }, down = { cron = "5 18 * * *", n = 0 } }
  name      = "api-min-instances-${each.key}"
  region    = var.region
  schedule  = each.value.cron
  time_zone = "Asia/Tokyo"
  http_target {
    http_method = "PATCH"
    uri         = "https://run.googleapis.com/v2/${google_cloud_run_v2_service.api.id}?updateMask=scaling.minInstanceCount"
    headers     = { "Content-Type" = "application/json" }
    body        = base64encode(jsonencode({ scaling = { minInstanceCount = each.value.n } }))
    oauth_token {
      service_account_email = local.sa.scheduler
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }
}

# DB の月次エクスポート（毎月1日 3:00、12 5章）。保持ポリシーで上書きできないため、年月の入った名前で archive バケットへ（Workflows で名前を作る）
resource "google_workflows_workflow" "db_export" {
  name            = "db-export-monthly"
  region          = var.region
  service_account = local.sa.export
  labels          = local.labels
  source_contents = <<-YAML
    main:
      steps:
        - name:
            assign:
              - ym: $${text.substring(time.format(sys.now(), "Asia/Tokyo"), 0, 7)}
        - export:
            call: http.post
            args:
              url: https://sqladmin.googleapis.com/v1/projects/${var.project_id}/instances/${google_sql_database_instance.main.name}/export
              auth:
                type: OAuth2
              body:
                exportContext:
                  fileType: SQL
                  uri: $${"gs://${google_storage_bucket.archive.name}/monthly/soilflow-" + ym + ".sql.gz"}
                  databases: ["soilflow"]
            result: op
        - done:
            return: $${op.body.name}
  YAML
  depends_on      = [google_project_service.apis]
}

resource "google_project_iam_member" "export_workflows" {
  project = var.project_id
  role    = "roles/workflows.invoker"
  member  = "serviceAccount:${local.sa.export}"
}

resource "google_cloud_scheduler_job" "db_export_monthly" {
  name      = "db-export-monthly"
  region    = var.region
  schedule  = "0 3 1 * *"
  time_zone = "Asia/Tokyo"
  http_target {
    http_method = "POST"
    uri         = "https://workflowexecutions.googleapis.com/v1/${google_workflows_workflow.db_export.id}/executions"
    headers     = { "Content-Type" = "application/json" }
    body        = base64encode("{}")
    oauth_token {
      service_account_email = local.sa.export
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }
}
