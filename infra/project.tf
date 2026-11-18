resource "google_project_service" "apis" {
  for_each = toset([
    "run.googleapis.com", "sqladmin.googleapis.com", "sql-component.googleapis.com", "compute.googleapis.com", "servicenetworking.googleapis.com",
    "secretmanager.googleapis.com", "cloudkms.googleapis.com", "cloudscheduler.googleapis.com", "artifactregistry.googleapis.com",
    "iam.googleapis.com", "iamcredentials.googleapis.com", "sts.googleapis.com", "monitoring.googleapis.com", "logging.googleapis.com",
    "firebase.googleapis.com", "workflows.googleapis.com", "workflowexecutions.googleapis.com", "firebasehosting.googleapis.com", "storage.googleapis.com",
  ])
  service            = each.value
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "soilflow" {
  repository_id = "soilflow"
  location      = var.region
  format        = "DOCKER"
  labels        = local.labels
  # 直近10版を残す（12 5章）
  cleanup_policies {
    id     = "keep-10"
    action = "KEEP"
    most_recent_versions { keep_count = 10 }
  }
  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition { older_than = "2592000s" }
  }
  depends_on = [google_project_service.apis]
}
