# 監視とアラート（04 7章、12 2.2）。送り先は保守担当のメール
resource "google_monitoring_notification_channel" "email" {
  for_each     = toset(var.alert_emails)
  display_name = "SoilFlow 保守 ${each.value}"
  type         = "email"
  labels       = { email_address = each.value }
}

locals { channels = [for c in google_monitoring_notification_channel.email : c.id] }

# 稼働確認：画面のドメイン経由で /api/v1/healthz を5分ごと
resource "google_monitoring_uptime_check_config" "healthz" {
  display_name     = "soilflow-${local.env} healthz"
  timeout          = "10s"
  period           = "300s"
  selected_regions = ["ASIA_PACIFIC", "USA_OREGON", "EUROPE"]
  http_check {
    path           = "/api/v1/healthz"
    port           = 443
    use_ssl        = true
    validate_ssl   = true
    request_method = "GET"
    accepted_response_status_codes { status_class = "STATUS_CLASS_2XX" }
  }
  monitored_resource {
    type   = "uptime_url"
    labels = { project_id = var.project_id, host = var.domain }
  }
  content_matchers { content = "\"ok\"" }
}

resource "google_monitoring_alert_policy" "uptime" {
  display_name          = "SoilFlow ${local.env}：画面・API に届かない"
  combiner              = "OR"
  notification_channels = local.channels
  conditions {
    display_name = "healthz が失敗"
    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND metric.label.check_id=\"${google_monitoring_uptime_check_config.healthz.uptime_check_id}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "600s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.host"]
      }
    }
  }
}

resource "google_monitoring_alert_policy" "errors_5xx" {
  display_name          = "SoilFlow ${local.env}：API の 5xx が多い"
  combiner              = "OR"
  notification_channels = local.channels
  conditions {
    display_name = "5xx が5分で5件以上"
    condition_threshold {
      filter          = "metric.type=\"run.googleapis.com/request_count\" AND resource.type=\"cloud_run_revision\" AND resource.label.service_name=\"${local.api_name}\" AND metric.label.response_code_class=\"5xx\""
      comparison      = "COMPARISON_GT"
      threshold_value = 4
      duration        = "0s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "latency" {
  display_name          = "SoilFlow ${local.env}：API が遅い（95%値 1秒超）"
  combiner              = "OR"
  notification_channels = local.channels
  conditions {
    display_name = "応答時間の95%値が1秒を超えて10分"
    condition_threshold {
      filter          = "metric.type=\"run.googleapis.com/request_latencies\" AND resource.type=\"cloud_run_revision\" AND resource.label.service_name=\"${local.api_name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1000
      duration        = "600s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_PERCENTILE_95"
        cross_series_reducer = "REDUCE_MAX"
      }
    }
  }
}

# ジョブの失敗（あきらめた）を API のログから数える（jobs.module が alert=JOB_FAILED を出す）
resource "google_logging_metric" "job_failed" {
  name   = "soilflow/job_failed"
  filter = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${local.api_name}\" AND jsonPayload.alert=\"JOB_FAILED\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    labels {
      key        = "kind"
      value_type = "STRING"
    }
  }
  label_extractors = { kind = "EXTRACT(jsonPayload.kind)" }
}

resource "google_monitoring_alert_policy" "job_failed" {
  display_name          = "SoilFlow ${local.env}：ジョブが失敗（PDF・メール・freee）"
  combiner              = "OR"
  notification_channels = local.channels
  conditions {
    display_name = "あきらめたジョブがある"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.job_failed.name}\" AND resource.type=\"cloud_run_revision\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }
}

resource "google_monitoring_alert_policy" "sql" {
  display_name          = "SoilFlow ${local.env}：Cloud SQL の使用率が高い"
  combiner              = "OR"
  notification_channels = local.channels
  conditions {
    display_name = "CPU 80% 超が15分"
    condition_threshold {
      filter          = "metric.type=\"cloudsql.googleapis.com/database/cpu/utilization\" AND resource.type=\"cloudsql_database\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0.8
      duration        = "900s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }
  conditions {
    display_name = "ディスク 85% 超"
    condition_threshold {
      filter          = "metric.type=\"cloudsql.googleapis.com/database/disk/utilization\" AND resource.type=\"cloudsql_database\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0.85
      duration        = "600s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }
}
